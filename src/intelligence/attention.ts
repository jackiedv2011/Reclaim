/**
 * Account-wide attention queue and approval-action proposals (CPO spec P4, contract v0.1).
 *
 * A PRESENTATION READ MODEL, NOT AN APPROVAL BACKEND. Jagan owns approval
 * objects, approval policy, execution and scheduling. There is no approval
 * service yet, so every item here is derived from saved case state read
 * through `CaseReadPort` (today: the legacy audit snapshot adapter). The
 * envelope says so with `upstream_contract_pending`.
 *
 * What this module does:
 *  - turns case snapshots into typed attention items (what needs the
 *    customer, what is waiting, what is approved but not sent), sorted
 *    deterministically, deduplicated across audits, with honest amounts;
 *  - turns a person's chosen interaction into a typed *proposal* for an
 *    existing server-validated case command. It never executes anything,
 *    never writes, never sends, and never treats an approval as a send or a
 *    return.
 *
 * Server-safe: relative `.ts` imports of runtime-portable modules only.
 */
import { VENDOR_STATUS, type VendorStatusInfo } from '../recovery/vendorStatus.ts'
import type { VendorUpdateStatus } from '../ledger/caseState.ts'
import {
  COVERAGE_REASONS,
  type CaseReadPort,
  type CaseSnapshot,
  type CaseStageView,
  type CoverageItem,
  type MoneyAmount,
  type SourceRef,
  type TenantContext,
  type Warning,
} from './contracts.ts'
import { IntelligenceAccessError, coverage, envelope, requirePermission, requireTenant, stableHash } from './envelope.ts'

export const ATTENTION_MODEL = 'attention_queue'
/** Bump when the meaning of a kind, category, amount or the sort order changes (docs/product-intelligence/attention-contract.md). */
export const ATTENTION_METRIC_VERSION = 'attention-1'

/** Reason codes added by this module (string literals, not part of COVERAGE_REASONS yet). */
export const ATTENTION_REASONS = {
  /** Gmail send rows (sending / sent / uncertain) live in server tables, not in the case snapshot. */
  SEND_STATE_NOT_IN_SNAPSHOT: 'send_state_not_in_snapshot',
  /** CaseSnapshot does not carry requiresRevalidation; the server may refuse an approval this layer offers. */
  REVALIDATION_NOT_IN_SNAPSHOT: 'revalidation_not_in_snapshot',
  /** At least one case has no project revision, so no command can be proposed for it. */
  REVISION_UNKNOWN: 'revision_unknown',
  /** A case's next action label is not one this layer maps; it is shown generically. */
  UNMAPPED_CASE_STATE: 'unmapped_case_state',
} as const

/** Mirrors src/recovery/status.ts OVERDUE_GRACE_DAYS (which uses `@/` imports and cannot load on the server). A test asserts they agree. */
export const OVERDUE_GRACE_DAYS = 3
const DAY = 86_400_000

// ---------------------------------------------------------------- case commands (server/caseCommands.ts)

/** The route every mutation goes through. Mirrors server/app.ts. */
export const CASE_COMMAND_ROUTE = '/api/projects/:id/case-commands' as const

/** Mirrors the `type` enum of commandSchema in server/caseCommands.ts. A test asserts they agree. */
export const CASE_COMMAND_TYPES = [
  'decision', 'evidence', 'approve', 'approve_and_request', 'request', 'email_sent', 'followup_sent', 'followup_days',
  'contact_hold', 'followup', 'vendor_update', 'settlement', 'historical_settlement', 'begin_new_request_review',
  'close', 'reconcile', 'reopen', 'reopen_balance',
] as const
export type CaseCommandType = (typeof CASE_COMMAND_TYPES)[number]

// ---------------------------------------------------------------- permissions

/**
 * Case mutations have no permission in the shared contract yet (only
 * `cases:read`). These are proposed names for Sid's role model. Until it
 * exists, a `single_user_session` owner holds them implicitly, because
 * server/caseCommands.ts authorizes any signed-in owner of the project. Any
 * other context (tests, future multi-user tenants) must hold them explicitly.
 */
export const PROPOSED_CASE_PERMISSIONS = ['cases:approve', 'cases:write'] as const
export type ProposedCasePermission = (typeof PROPOSED_CASE_PERMISSIONS)[number]

export function hasCasePermission(ctx: TenantContext, permission: 'cases:read' | ProposedCasePermission): boolean {
  if ((ctx.permissions as readonly string[]).includes(permission)) return true
  return ctx.source === 'single_user_session' && permission !== 'cases:read' && (ctx.permissions as readonly string[]).includes('cases:read')
}

// ---------------------------------------------------------------- item types

export type AttentionKind =
  | 'outbound_approval'
  | 'ready_to_send'
  | 'missing_evidence'
  | 'vendor_response_review'
  | 'disputed_or_partial'
  | 'follow_up_due'
  | 'follow_up_overdue'
  | 'verify_promised_return'
  | 'record_in_books'
  | 'historical_request_review'
  | 'contact_on_hold'
  | 'unreviewed_finding'
  /** Added: an internal (non-vendor) review the customer must file or close. */
  | 'internal_review'
  /** Added: a case the customer must act on whose next action this layer does not recognise. */
  | 'unmapped_case_state'

export const ATTENTION_KINDS: readonly AttentionKind[] = [
  'outbound_approval', 'ready_to_send', 'missing_evidence', 'vendor_response_review', 'disputed_or_partial',
  'follow_up_due', 'follow_up_overdue', 'verify_promised_return', 'record_in_books', 'historical_request_review',
  'contact_on_hold', 'unreviewed_finding', 'internal_review', 'unmapped_case_state',
]

export type AttentionCategory = 'requires_approval' | 'requires_action' | 'informational'
export const ATTENTION_CATEGORIES: readonly AttentionCategory[] = ['requires_approval', 'requires_action', 'informational']

/** Which lifecycle figure an amount is. Never combined; `none` when the snapshot does not support one. */
export type AttentionAmountKind = 'supported_potential' | 'approved_request' | 'outstanding' | 'promised' | 'none'
export interface AttentionAmount {
  kind: AttentionAmountKind
  money: MoneyAmount | null
}

export type AttentionInteraction = 'view_case' | 'inspect_evidence' | 'review_exact_package' | 'approve' | 'reject' | 'request_more_evidence' | 'open_source_case'
export const ATTENTION_INTERACTIONS: readonly AttentionInteraction[] = ['view_case', 'inspect_evidence', 'review_exact_package', 'approve', 'reject', 'request_more_evidence', 'open_source_case']

export interface InteractionDescriptor {
  interaction: AttentionInteraction
  /**
   * `existing_case_command`: a mutation through server/caseCommands.ts.
   * `read_only`: navigation or display; no command, nothing changes.
   * `not_available`: not offered for this item in its current state.
   */
  executesVia: 'existing_case_command' | 'read_only' | 'not_available'
  caseCommand: CaseCommandType | null
  /** Input fields this layer fixes (e.g. `{ decision: 'needs_info' }`). */
  fixedInput: Record<string, unknown> | null
  /** Input fields only the person can supply (exact package, reason). */
  inputRequired: string[]
  requiredPermission: string | null
  permissionStatus: 'existing' | 'proposedPermission' | null
  /** False when not available or when the actor lacks the permission. */
  enabled: boolean
  disabledReason: 'not_available' | 'permission_missing' | null
  note: string
}

export interface AttentionItem {
  /** `${kind}:${caseId}:${revision ?? 'r?'}:g${hash of stage/approval/request/next-action/due}`. Deterministic; changes when the case or its audit revision changes. */
  id: string
  tenantId: string
  kind: AttentionKind
  category: AttentionCategory
  /** Machine sub-reason, e.g. the vendor status behind a review, or `return_amount_missing`. */
  reasonCode: string | null
  caseId: string
  auditId: string
  findingId: string
  findingType: string
  vendor: { displayName: string; vendorKey: string }
  /** Single-user today: every customer item belongs to the signed-in actor. `vendor` when the ball is with the supplier. */
  owner: { party: 'customer' | 'vendor'; actorId: string | null; assignment: 'single_user_default' | 'none' }
  /** The case's next-action label from src/recovery/model.ts, verbatim. */
  actionLabel: string
  dueAt: number | null
  /** More than OVERDUE_GRACE_DAYS calendar days past dueAt, same rule as src/recovery/status.ts. */
  overdue: boolean
  /** CaseSnapshot.statusLabel, verbatim. */
  statusLabel: string
  stage: CaseStageView
  /** Project (audit) revision the item was computed from. Case commands need it as expectedRevision. */
  revision: number | null
  amount: AttentionAmount
  permissionsRequired: string[]
  /** Subset of permissionsRequired that does not exist in the shared contract yet. */
  proposedPermissions: string[]
  allowedInteractions: InteractionDescriptor[]
  /** Case commands that would move this item on (for navigation hints; nothing here runs them). */
  resolvedBy: CaseCommandType[]
  /** Machine cautions the UI must surface (e.g. `send_state_not_in_snapshot`). */
  cautions: string[]
  /** Other saved cases for the same check on the same payments, collapsed into this one. */
  alsoInCaseIds: string[]
  sideEffects: 'none_in_this_layer'
}

export interface AttentionQueueOptions {
  /** Page size; default 50, clamped to 1..200. */
  limit?: number
  /** Opaque cursor from a previous page's nextCursor. */
  cursor?: string | null
  /** Only these categories in `items` (counts still cover every category). */
  include?: readonly AttentionCategory[]
}

export interface AttentionQueueResult {
  items: AttentionItem[]
  nextCursor: string | null
  /** Items after the include filter, across all pages. */
  total: number
  /** Over every item before the include filter, so tabs can show badges. */
  counts: { byCategory: Record<AttentionCategory, number>; byKind: Record<AttentionKind, number> }
  casesConsidered: number
  duplicatesCollapsed: number
  /** Why the list is empty, never an "all clear": `no_cases` or `none_in_covered_cases`. */
  emptyState: 'no_cases' | 'none_in_covered_cases' | null
}

// ---------------------------------------------------------------- derivation

/** Every label recoveryNextAction (and the adapter's 'Review finding') can produce, and what it becomes. A test asserts coverage against src/recovery/model.ts. */
export const NEXT_ACTION_KIND: Readonly<Record<string, AttentionKind | null>> = {
  'Review finding': 'unreviewed_finding',
  // Adapter labels for decisions without a recovery stage (contract 0.1.1).
  'Provide information': 'missing_evidence',
  'Start recovery review': 'missing_evidence',
  'No action needed': null,
  'Review historical request': 'historical_request_review',
  'File internal note': 'internal_review',
  'Record investigation outcome': 'internal_review',
  'Contact on hold': 'contact_on_hold',
  'Approve recovery': 'outbound_approval',
  'Send the request': 'ready_to_send',
  'Pursue remaining balance': 'disputed_or_partial',
  'Verify credit application': 'verify_promised_return',
  'Verify refund settlement': 'verify_promised_return',
  'Review vendor response': 'vendor_response_review',
  'Verify promised return': 'verify_promised_return',
  'Confirm return timing': 'verify_promised_return',
  'Follow up with vendor': 'follow_up_due',
  'Record missing return': 'record_in_books',
  'Record it in your books': 'record_in_books',
  'Wait for vendor': null,
  'Case complete': null,
  'Case closed': null,
  'Review closed': null,
}

const REASON_FOR_LABEL: Readonly<Record<string, string>> = {
  'Pursue remaining balance': 'partially_returned',
  'Verify credit application': 'credit_issued',
  'Verify refund settlement': 'already_refunded',
  'Verify promised return': 'promised_or_accepted',
  'Confirm return timing': 'accepted_timing_unknown',
  'Record missing return': 'return_amount_missing',
  'Record it in your books': 'reconciliation_missing',
}

const VENDOR_STATUS_BY_CASE_LABEL = new Map<string, VendorUpdateStatus>(
  (Object.entries(VENDOR_STATUS) as Array<[VendorUpdateStatus, VendorStatusInfo]>).filter(([, info]) => info.caseStatus).map(([status, info]) => [info.caseStatus!, status]),
)

function startOfDay(at: number): number {
  return new Date(at).setHours(0, 0, 0, 0)
}

/** Same calendar-day arithmetic as src/recovery/status.ts (process-local zone). */
export function daysPast(dueAt: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(dueAt)) / DAY)
}

function isOverdue(dueAt: number | null, now: number): boolean {
  return dueAt !== null && Number.isFinite(dueAt) && daysPast(dueAt, now) > OVERDUE_GRACE_DAYS
}

function money(currency: string, amountMinor: number | null): MoneyAmount | null {
  return amountMinor !== null && Number.isSafeInteger(amountMinor) && amountMinor > 0 ? { currency, amountMinor } : null
}

/** The one figure an item shows, and which figure it is. Flagged exposure is never shown: it is not money owed. */
function amountFor(kind: AttentionKind, snap: CaseSnapshot): AttentionAmount {
  const pick = (k: AttentionAmountKind, minor: number | null): AttentionAmount | null => {
    const m = money(snap.currency, minor)
    return m ? { kind: k, money: m } : null
  }
  const none: AttentionAmount = { kind: 'none', money: null }
  switch (kind) {
    case 'outbound_approval':
    case 'unreviewed_finding':
    case 'missing_evidence':
    case 'contact_on_hold':
      return pick('supported_potential', snap.supportedPotentialMinor) ?? none
    case 'ready_to_send':
      return (snap.approvedAt !== null ? pick('approved_request', snap.approvedRequestMinor) : null) ?? none
    case 'verify_promised_return':
      return pick('promised', snap.promisedMinor) ?? pick('outstanding', snap.outstandingMinor) ?? none
    case 'vendor_response_review':
    case 'disputed_or_partial':
    case 'follow_up_due':
    case 'follow_up_overdue':
    case 'historical_request_review':
      return pick('outstanding', snap.outstandingMinor) ?? none
    default:
      return none
  }
}

function classify(snap: CaseSnapshot, now: number): { kind: AttentionKind; reasonCode: string | null; category: AttentionCategory } | null {
  // A needs-info decision is waiting on the customer's evidence whatever the
  // adapter's next action says (it reports 'Case closed' for it today).
  if (snap.stage === 'needs_info') return { kind: 'missing_evidence', reasonCode: 'needs_information', category: 'requires_action' }
  if (snap.stage === 'dismissed') return null
  const label = snap.nextAction.label
  const mapped = Object.prototype.hasOwnProperty.call(NEXT_ACTION_KIND, label) ? NEXT_ACTION_KIND[label] : undefined
  const requires = snap.nextAction.requiresCustomer
  if (mapped === undefined || (mapped === null && requires)) {
    return requires ? { kind: 'unmapped_case_state', reasonCode: label, category: 'requires_action' } : null
  }
  if (mapped === null) return null
  let kind: AttentionKind = mapped
  let reasonCode: string | null = REASON_FOR_LABEL[label] ?? null
  if (label === 'Review vendor response') {
    const status = VENDOR_STATUS_BY_CASE_LABEL.get(snap.statusLabel) ?? null
    reasonCode = status
    if (status === 'disputed' || status === 'partial_acceptance') kind = 'disputed_or_partial'
  }
  if (kind === 'follow_up_due' && isOverdue(snap.nextAction.dueAt, now)) kind = 'follow_up_overdue'
  const category: AttentionCategory = kind === 'outbound_approval' ? 'requires_approval' : requires ? 'requires_action' : 'informational'
  return { kind, reasonCode, category }
}

const CHANGE_REQUEST_STAGES: ReadonlySet<CaseStageView> = new Set(['unreviewed', 'needs_info', 'confirmed'])

function descriptor(ctx: TenantContext, interaction: AttentionInteraction, spec: Partial<InteractionDescriptor> & { executesVia: InteractionDescriptor['executesVia']; note: string }): InteractionDescriptor {
  const requiredPermission = spec.requiredPermission ?? (spec.executesVia === 'not_available' ? null : 'cases:read')
  const permissionStatus: InteractionDescriptor['permissionStatus'] = requiredPermission === null ? null : (PROPOSED_CASE_PERMISSIONS as readonly string[]).includes(requiredPermission) ? 'proposedPermission' : 'existing'
  const permitted = requiredPermission === null || hasCasePermission(ctx, requiredPermission as 'cases:read' | ProposedCasePermission)
  const available = spec.executesVia !== 'not_available'
  return {
    interaction,
    executesVia: spec.executesVia,
    caseCommand: spec.caseCommand ?? null,
    fixedInput: spec.fixedInput ?? null,
    inputRequired: spec.inputRequired ?? [],
    requiredPermission,
    permissionStatus,
    enabled: available && permitted,
    disabledReason: !available ? 'not_available' : permitted ? null : 'permission_missing',
    note: spec.note,
  }
}

const APPROVE_INPUT = ['package.subject', 'package.body', 'package.evidenceAttachment', 'package.recipientEmail', 'package.recipientConfirmed', 'package.requestedAmount', 'package.method', 'knownBeforeReclaim', 'knownBeforeNote']

function interactionsFor(ctx: TenantContext, kind: AttentionKind, stage: CaseStageView): InteractionDescriptor[] {
  const na = (note: string) => ({ executesVia: 'not_available' as const, note })
  const hasPackage = kind === 'outbound_approval' || kind === 'ready_to_send'
  const preRequest = CHANGE_REQUEST_STAGES.has(stage)
  const approve = kind === 'outbound_approval'
    ? descriptor(ctx, 'approve', { executesVia: 'existing_case_command', caseCommand: 'approve', inputRequired: APPROVE_INPUT, requiredPermission: 'cases:approve', note: 'Approves the exact reviewed package (content, recipient, attachment, amount, method). Approval does not send anything; sending is a separate, exact-version-checked step.' })
    : descriptor(ctx, 'approve', na(kind === 'ready_to_send' ? 'Already approved. Approval is not a send; nothing has gone out per the saved case.' : kind === 'contact_on_hold' ? 'Release the contact hold before approval.' : 'There is no outbound package awaiting approval on this case.'))
  let reject: InteractionDescriptor
  if (kind === 'outbound_approval' || kind === 'ready_to_send') {
    reject = descriptor(ctx, 'reject', { executesVia: 'existing_case_command', caseCommand: 'contact_hold', inputRequired: ['reason'], requiredPermission: 'cases:write', note: 'Nearest existing command: holds vendor contact with a reason and withdraws any approval (setContactHold). A dedicated reject command is requested from the recovery owner.' })
  } else if (kind === 'unreviewed_finding' || kind === 'missing_evidence') {
    reject = descriptor(ctx, 'reject', { executesVia: 'existing_case_command', caseCommand: 'decision', fixedInput: { decision: 'expected' }, inputRequired: ['reason'], requiredPermission: 'cases:write', note: 'Dismisses the finding as expected.' })
  } else {
    reject = descriptor(ctx, 'reject', na(preRequest ? 'Not offered in this state.' : 'A request is already out; record the vendor response or close the case from the case page instead.'))
  }
  const requestMore = preRequest && kind !== 'missing_evidence' && kind !== 'internal_review' && kind !== 'unmapped_case_state'
    ? descriptor(ctx, 'request_more_evidence', { executesVia: 'existing_case_command', caseCommand: 'decision', fixedInput: { decision: 'needs_info' }, inputRequired: ['reason'], requiredPermission: 'cases:write', note: 'Marks the case as needing information; any approval is cleared by the new decision.' })
    : descriptor(ctx, 'request_more_evidence', na(kind === 'missing_evidence' ? 'Already waiting for information.' : 'Only offered before a request is sent.'))
  return [
    descriptor(ctx, 'view_case', { executesVia: 'read_only', note: 'Open the case page.' }),
    descriptor(ctx, 'inspect_evidence', { executesVia: 'read_only', note: 'Open the case evidence and source rows.' }),
    hasPackage
      ? descriptor(ctx, 'review_exact_package', { executesVia: 'read_only', note: 'Show the exact subject, body, recipient, attachment, amount and method that approval covers.' })
      : descriptor(ctx, 'review_exact_package', na('No outbound package on this case.')),
    approve,
    reject,
    requestMore,
    descriptor(ctx, 'open_source_case', { executesVia: 'read_only', note: 'Open the saved audit this case belongs to.' }),
  ]
}

const RESOLVED_BY: Readonly<Record<AttentionKind, CaseCommandType[]>> = {
  outbound_approval: ['approve', 'approve_and_request', 'contact_hold', 'decision', 'evidence'],
  ready_to_send: ['request', 'email_sent', 'contact_hold', 'decision'],
  missing_evidence: ['evidence', 'decision'],
  vendor_response_review: ['vendor_update', 'settlement', 'close', 'followup'],
  disputed_or_partial: ['vendor_update', 'settlement', 'close', 'followup'],
  follow_up_due: ['followup_sent', 'vendor_update', 'followup', 'followup_days'],
  follow_up_overdue: ['followup_sent', 'vendor_update', 'followup', 'followup_days'],
  verify_promised_return: ['settlement', 'vendor_update', 'followup'],
  record_in_books: ['reconcile', 'reopen'],
  historical_request_review: ['begin_new_request_review', 'historical_settlement'],
  contact_on_hold: ['contact_hold', 'decision'],
  unreviewed_finding: ['decision', 'evidence'],
  internal_review: ['request', 'close', 'decision'],
  unmapped_case_state: [],
}

function itemId(kind: AttentionKind, snap: CaseSnapshot): string {
  const discriminator = stableHash([snap.stage, snap.approvedAt ?? '', snap.requestedAt ?? '', snap.nextAction.label, snap.nextAction.dueAt ?? '', snap.reconciledAt ?? ''].join('|'))
  return `${kind}:${snap.caseId}:${snap.revision ?? 'r?'}:g${discriminator}`
}

/**
 * The attention item for one case, or null when it needs nobody's attention.
 * Exposed so a caller holding a freshly read snapshot can re-derive an item
 * (proposeApprovalAction uses it to detect already-resolved items).
 */
export function attentionItemFor(ctx: TenantContext, snap: CaseSnapshot, now: number, alsoInCaseIds: string[] = []): AttentionItem | null {
  const c = classify(snap, now)
  if (!c) return null
  const allowedInteractions = interactionsFor(ctx, c.kind, snap.stage)
  const permissionsRequired = [...new Set(allowedInteractions.filter((i) => i.executesVia !== 'not_available').map((i) => i.requiredPermission!))].sort()
  const cautions: string[] = []
  if (c.kind === 'ready_to_send') cautions.push(ATTENTION_REASONS.SEND_STATE_NOT_IN_SNAPSHOT)
  if (c.kind === 'outbound_approval') cautions.push(ATTENTION_REASONS.REVALIDATION_NOT_IN_SNAPSHOT)
  if (c.kind === 'record_in_books' || c.kind === 'verify_promised_return' || c.reasonCode === 'partially_returned') cautions.push(COVERAGE_REASONS.NO_INDEPENDENT_RETURN_MATCHING)
  if (snap.revision === null) cautions.push(ATTENTION_REASONS.REVISION_UNKNOWN)
  if (alsoInCaseIds.length) cautions.push(COVERAGE_REASONS.CROSS_AUDIT_OVERLAP)
  const customer = c.category !== 'informational'
  return {
    id: itemId(c.kind, snap),
    tenantId: ctx.tenantId,
    kind: c.kind,
    category: c.category,
    reasonCode: c.reasonCode,
    caseId: snap.caseId,
    auditId: snap.auditId,
    findingId: snap.findingId,
    findingType: snap.findingType,
    vendor: { displayName: snap.vendor.displayName, vendorKey: snap.vendor.vendorKey },
    owner: customer ? { party: 'customer', actorId: ctx.actorId, assignment: 'single_user_default' } : { party: 'vendor', actorId: null, assignment: 'none' },
    actionLabel: snap.nextAction.label,
    dueAt: snap.nextAction.dueAt,
    overdue: isOverdue(snap.nextAction.dueAt, now),
    statusLabel: snap.statusLabel,
    stage: snap.stage,
    revision: snap.revision,
    amount: amountFor(c.kind, snap),
    permissionsRequired,
    proposedPermissions: permissionsRequired.filter((p) => (PROPOSED_CASE_PERMISSIONS as readonly string[]).includes(p)),
    allowedInteractions,
    resolvedBy: [...RESOLVED_BY[c.kind]],
    cautions: cautions.sort(),
    alsoInCaseIds: [...alsoInCaseIds].sort(),
    sideEffects: 'none_in_this_layer',
  }
}

// ---------------------------------------------------------------- dedupe and order

const STAGE_RANK: Readonly<Record<CaseStageView, number>> = { unreviewed: 0, needs_info: 1, dismissed: 2, confirmed: 3, requested: 4, recovered: 5, not_recovered: 5 }

/** Most advanced stage first, then most recently updated (null last), then caseId. */
function preferCase(a: CaseSnapshot, b: CaseSnapshot): number {
  return STAGE_RANK[b.stage] - STAGE_RANK[a.stage] || (b.updatedAt ?? -Infinity) - (a.updatedAt ?? -Infinity) || a.caseId.localeCompare(b.caseId)
}

const CATEGORY_RANK: Readonly<Record<AttentionCategory, number>> = { requires_approval: 0, requires_action: 1, informational: 2 }

/**
 * Category (approval, action, informational), then overdue first, then dueAt
 * ascending with no date last, then items with an amount before those
 * without, grouped by currency code, larger amount first within a currency,
 * then caseId, then id. Amounts are compared only within one currency and
 * never added.
 */
export function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  const due = (x: AttentionItem) => (x.dueAt === null ? Number.POSITIVE_INFINITY : x.dueAt)
  const am = a.amount.money
  const bm = b.amount.money
  return CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]
    || Number(b.overdue) - Number(a.overdue)
    || (due(a) === due(b) ? 0 : due(a) < due(b) ? -1 : 1)
    || Number(Boolean(bm)) - Number(Boolean(am))
    || (am && bm ? am.currency.localeCompare(bm.currency) || bm.amountMinor - am.amountMinor : 0)
    || a.caseId.localeCompare(b.caseId)
    || a.id.localeCompare(b.id)
}

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>
}

function parseCursor(cursor: string | null | undefined): number | null {
  if (cursor === null || cursor === undefined || cursor === '') return 0
  const m = /^o:(\d{1,9})$/.exec(cursor)
  return m ? Number(m[1]) : null
}

/**
 * The account-wide attention queue. Reads cases through the port (tenant-
 * checked there) and returns one item per case that needs a person or is
 * worth showing, deduplicated by crossAuditKey.
 */
export function attentionQueue(ctx: TenantContext, cases: CaseReadPort, now: number, options: AttentionQueueOptions = {}) {
  requirePermission(ctx, 'cases:read')
  const snapshots = cases.listCases(ctx, now)
  const warnings: Warning[] = []

  // ---- one case per check on the same payments
  const groups = new Map<string, CaseSnapshot[]>()
  for (const snap of snapshots) {
    const list = groups.get(snap.crossAuditKey) ?? []
    list.push(snap)
    groups.set(snap.crossAuditKey, list)
  }
  let duplicatesCollapsed = 0
  const items: AttentionItem[] = []
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key)!.sort(preferCase)
    const [kept, ...others] = group
    duplicatesCollapsed += others.length
    const diverged = others.filter((o) => o.stage !== 'unreviewed' && o.stage !== kept.stage)
    if (diverged.length) warnings.push({ code: 'cross_audit_divergent_state', detail: `${kept.caseId} and ${diverged.map((o) => o.caseId).join(', ')} are the same check on the same payments but were reviewed differently; the most advanced is shown.` })
    const item = attentionItemFor(ctx, kept, now, others.map((o) => o.caseId))
    if (item) items.push(item)
  }
  items.sort(compareAttentionItems)

  const unmapped = items.filter((i) => i.kind === 'unmapped_case_state')
  if (unmapped.length) warnings.push({ code: ATTENTION_REASONS.UNMAPPED_CASE_STATE, detail: `${unmapped.length} case(s) need the customer but their next action is not one this view recognises.` })

  const counts = { byCategory: emptyCounts(ATTENTION_CATEGORIES), byKind: emptyCounts(ATTENTION_KINDS) }
  for (const item of items) {
    counts.byCategory[item.category] += 1
    counts.byKind[item.kind] += 1
  }

  const include = options.include && options.include.length ? new Set(options.include) : null
  const filtered = include ? items.filter((i) => include.has(i.category)) : items
  const limit = Math.min(200, Math.max(1, Math.floor(options.limit ?? 50)))
  let offset = parseCursor(options.cursor)
  if (offset === null || offset > filtered.length) {
    warnings.push({ code: 'invalid_cursor', detail: 'The page cursor was not recognised; showing the first page.' })
    offset = 0
  }
  const page = filtered.slice(offset, offset + limit)
  const nextCursor = offset + limit < filtered.length ? `o:${offset + limit}` : null

  // ---- coverage: honest about what saved case state cannot tell us
  const legacy = cases.origin === 'legacy_audit_snapshot'
  const base = legacy ? [COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS] : []
  const noData = snapshots.length === 0
  const caseReasons = [...base, ...(noData ? [COVERAGE_REASONS.NO_DATA] : []), ...(duplicatesCollapsed ? [COVERAGE_REASONS.CROSS_AUDIT_OVERLAP] : []), ...(snapshots.some((s) => s.revision === null) ? [ATTENTION_REASONS.REVISION_UNKNOWN] : []), ...(unmapped.length ? [ATTENTION_REASONS.UNMAPPED_CASE_STATE] : [])]
  const coverageItems: CoverageItem[] = [
    coverage('case_state', caseReasons),
    coverage('pending_approvals', [...base, COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING, ATTENTION_REASONS.REVALIDATION_NOT_IN_SNAPSHOT]),
    coverage('send_state', [ATTENTION_REASONS.SEND_STATE_NOT_IN_SNAPSHOT, COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING]),
    coverage('returns', [COVERAGE_REASONS.NO_INDEPENDENT_RETURN_MATCHING]),
  ]

  const sources: SourceRef[] = page.map((i) => ({ id: `case:${i.caseId}`, label: `${i.vendor.displayName} · ${i.statusLabel}` }))
  const sourceUpdatedAt = snapshots.reduce<number | null>((max, s) => (s.updatedAt !== null && (max === null || s.updatedAt > max) ? s.updatedAt : max), null)
  const currencies = [...new Set(items.map((i) => i.amount.money?.currency).filter((c): c is string => Boolean(c)))].sort()

  const result: AttentionQueueResult = {
    items: page,
    nextCursor,
    total: filtered.length,
    counts,
    casesConsidered: snapshots.length,
    duplicatesCollapsed,
    emptyState: filtered.length ? null : noData ? 'no_cases' : 'none_in_covered_cases',
  }
  return envelope<AttentionQueueResult>({
    model: ATTENTION_MODEL,
    metricDefinitionVersion: ATTENTION_METRIC_VERSION,
    ctx,
    origin: cases.origin,
    scope: { from: null, to: null, dateBasis: 'case_activity', currencies },
    computedAt: now,
    sourceUpdatedAt,
    coverage: coverageItems,
    sources,
    exclusions: [{ code: 'cross_audit_overlap', count: duplicatesCollapsed, amounts: [], detail: 'Same check on the same payments saved in more than one audit; shown once.' }],
    warnings,
    result,
  })
}

// ---------------------------------------------------------------- proposals (never executed here)

export interface ApprovalActionProposal {
  kind: 'case_command_proposal'
  route: typeof CASE_COMMAND_ROUTE
  /** The route with the project (audit) id filled in. */
  path: string
  method: 'POST'
  projectId: string
  action: CaseCommandType
  interaction: AttentionInteraction
  findingId: string
  expectedRevision: number
  /** Deterministic UUID-shaped id from tenant, actor, item, action, revision and input: a retry replays, a changed input is a new command. */
  commandId: string
  /** Fixed fields merged with what the person supplied; null until supplied. */
  input: Record<string, unknown> | null
  /** Fields still missing before this can be submitted. */
  inputRequired: string[]
  readyToSubmit: boolean
  requiresHumanConfirmation: true
  exactVersionCheck: true
  sideEffects: 'none_in_this_layer'
  attentionItemId: string
  /** Server outcomes the UI must handle for this command (see attention-contract.md). */
  serverRefusals: string[]
}

export type ProposalErrorCode = 'stale_revision' | 'already_resolved' | 'forbidden' | 'not_available' | 'revision_unknown'
export type ProposalResult = { ok: true; proposal: ApprovalActionProposal } | { ok: false; error: { code: ProposalErrorCode; detail: string } }

export interface ProposalOptions {
  /** The revision the person is looking at (from the latest project read). */
  expectedRevision: number | null
  /** What the person supplied (reviewed package, reason). Fixed fields are added here. */
  input?: Record<string, unknown>
  /** A freshly read snapshot of the same case, to detect already-resolved or changed items. Recommended. */
  current?: CaseSnapshot | null
  /** Required with `current`. */
  now?: number
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'undefined'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/** RFC 9562 version-8 (custom) UUID from a seed. Not cryptographic: an idempotency key the server's z.uuid() accepts. */
export function deterministicCommandId(seed: string): string {
  const hex = [0, 1, 2, 3].map((i) => stableHash(`${i}|${seed}`)).join('')
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  const v = `${hex.slice(0, 12)}8${hex.slice(13, 16)}${variant}${hex.slice(17, 32)}`
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`
}

function hasPath(input: Record<string, unknown>, path: string): boolean {
  let at: unknown = input
  for (const part of path.split('.')) {
    if (at === null || typeof at !== 'object' || !Object.prototype.hasOwnProperty.call(at, part)) return false
    at = (at as Record<string, unknown>)[part]
  }
  return at !== undefined
}

const REFUSALS: Partial<Record<CaseCommandType, string[]>> = {
  approve: ['revision_conflict', 'command_reused', 'invalid_transition', 'revalidation_required', 'gmail_receipt_pending', 'validation', 'no_change'],
  contact_hold: ['revision_conflict', 'command_reused', 'invalid_transition', 'validation', 'no_change'],
  decision: ['revision_conflict', 'command_reused', 'invalid_transition', 'gmail_receipt_pending', 'validation', 'no_change'],
}

/**
 * Turn a person's chosen interaction on an attention item into a typed case-
 * command proposal. Does not execute, persist or send. The UI shows it, the
 * person confirms, and only then does the UI POST it to the server, which
 * re-checks actor, tenant, revision, idempotency and the exact version.
 *
 * Throws IntelligenceAccessError for another tenant's item; every other
 * refusal is a typed result so the UI can show the right state.
 */
export function proposeApprovalAction(ctx: TenantContext, item: AttentionItem, interaction: AttentionInteraction, options: ProposalOptions): ProposalResult {
  requireTenant(ctx, item.tenantId)
  const fail = (code: ProposalErrorCode, detail: string): ProposalResult => ({ ok: false, error: { code, detail } })
  if (!hasCasePermission(ctx, 'cases:read')) return fail('forbidden', 'Missing permission cases:read.')

  const descriptorFor = item.allowedInteractions.find((d) => d.interaction === interaction)
  if (!descriptorFor || descriptorFor.executesVia !== 'existing_case_command' || !descriptorFor.caseCommand) {
    return fail('not_available', descriptorFor?.executesVia === 'read_only' ? 'This interaction only reads; there is nothing to propose.' : descriptorFor?.note ?? 'Not offered for this item.')
  }
  const permission = descriptorFor.requiredPermission as ProposedCasePermission | 'cases:read'
  if (!hasCasePermission(ctx, permission)) return fail('forbidden', `Missing permission ${permission}${descriptorFor.permissionStatus === 'proposedPermission' ? ' (proposed; not yet in the role model)' : ''}.`)

  if (options.current !== undefined) {
    const current = options.current
    if (current === null) return fail('already_resolved', 'The case is no longer in this account’s saved audits.')
    if (current.caseId !== item.caseId) throw new IntelligenceAccessError('tenant_mismatch', 'The supplied snapshot is a different case.')
    if (options.now === undefined) return fail('stale_revision', 'A current snapshot needs `now` to re-derive the item.')
    const fresh = attentionItemFor(ctx, current, options.now)
    if (!fresh || fresh.kind !== item.kind || current.stage !== item.stage) return fail('already_resolved', `The case has moved on (now: ${current.statusLabel}). Reload before acting.`)
    if (current.revision !== item.revision) return fail('stale_revision', 'The audit changed since this item was shown. Reload and review the newer version.')
  }
  if (item.revision === null) return fail('revision_unknown', 'This case has no saved revision, so no command can be checked against it. Reload the audit.')
  if (options.expectedRevision === null || options.expectedRevision !== item.revision) return fail('stale_revision', 'The revision you are looking at differs from the one this item was computed from. Reload and review the newer version.')

  const supplied = options.input ?? null
  const input = supplied ? { ...supplied, ...(descriptorFor.fixedInput ?? {}) } : descriptorFor.fixedInput ? { ...descriptorFor.fixedInput } : null
  const inputRequired = descriptorFor.inputRequired.filter((path) => !input || !hasPath(input, path))
  const action = descriptorFor.caseCommand
  const commandId = deterministicCommandId(canonical({ t: ctx.tenantId, a: ctx.actorId, item: item.id, action, rev: item.revision, input }))
  return {
    ok: true,
    proposal: {
      kind: 'case_command_proposal',
      route: CASE_COMMAND_ROUTE,
      path: CASE_COMMAND_ROUTE.replace(':id', encodeURIComponent(item.auditId)),
      method: 'POST',
      projectId: item.auditId,
      action,
      interaction,
      findingId: item.findingId,
      expectedRevision: item.revision,
      commandId,
      input,
      inputRequired,
      readyToSubmit: inputRequired.length === 0 && input !== null,
      requiresHumanConfirmation: true,
      exactVersionCheck: true,
      sideEffects: 'none_in_this_layer',
      attentionItemId: item.id,
      serverRefusals: REFUSALS[action] ?? ['revision_conflict', 'command_reused', 'invalid_transition', 'validation', 'no_change'],
    },
  }
}
