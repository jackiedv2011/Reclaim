/**
 * Private business memory (CPO workstream P2), contract version `memory-v0.1`.
 *
 * Business memory is structured, tenant-scoped application data that a
 * customer's own reviewers create: why something is intentional, that a
 * series really is recurring, that two supplier names are (or are not) the
 * same business, context about a vendor, and how a recovery actually ended.
 * It is NOT model training data, NOT prompt history, and it is never shared
 * across tenants.
 *
 * What memory can do:
 *  - be shown next to an insight, with entry IDs, so a person can see which
 *    context influenced it (`influenceFor`);
 *  - be turned into narrowly scoped *proposals* for the detection owner
 *    (`suppressionProposals`). Nothing here applies a proposal. Detection
 *    (src/lib/detection.ts, the financial-foundation workstream) decides.
 *
 * What memory can never do: change a source record or a case, attest
 * evidence, create or change a money amount, merge vendor identities, or
 * dismiss a finding whose evidence gate has passed.
 *
 * `InMemoryFeedbackStore` is a reference implementation behind the
 * `FeedbackStore` interface. Durable persistence is a proposed SQLite table
 * (docs/product-intelligence/business-memory.md); the migration is the CTO's.
 *
 * Server-safe: relative `.ts` imports of src/intelligence modules only.
 */
import {
  COVERAGE_REASONS,
  type CaseReadPort,
  type CaseSnapshot,
  type CurrencyCode,
  type FinancialSourcePort,
  type ReadModelEnvelope,
  type RecurringSeriesView,
  type SourceRecord,
  type SourceRef,
  type TenantContext,
} from './contracts.ts'
import { IntelligenceAccessError, coverage, envelope, normalizeCurrency, requirePermission, requireTenant, stableHash } from './envelope.ts'

export const MEMORY_VERSION = 'memory-v0.1'

const DAY_MS = 86_400_000

/** Bounds. Changing any of these is a contract change (bump MEMORY_VERSION). */
export const MAX_RATIONALE_LENGTH = 1000
export const MAX_REVOKE_REASON_LENGTH = 500
export const MAX_ALIAS_NAME_LENGTH = 200
export const MAX_KEY_LENGTH = 256
export const MAX_SCOPE_SOURCE_RECORDS = 200
/** An entry may not be set to expire more than three years out. */
export const MAX_EXPIRY_MS = 3 * 365 * DAY_MS
/** Entries that can lead to a suppression proposal get a review date one year out unless the author picks an earlier one. */
export const DEFAULT_REVIEW_AFTER_MS = 365 * DAY_MS
/** A vendor + finding type + amount band proposal may span at most 10% of its lower bound (or 100 minor units, whichever is wider). */
export const AMOUNT_BAND_MAX_WIDTH_BPS = 1000
export const AMOUNT_BAND_MIN_WIDTH_MINOR = 100
export const MAX_ENTRIES_PER_TENANT = 10_000

// ---------------------------------------------------------------- types

export type MemoryEntryKind =
  | 'dismissal_reason'
  | 'intentional_payment'
  | 'recurring_confirmation'
  | 'vendor_alias_proposal'
  | 'vendor_context_note'
  | 'recovery_outcome_confirmation'

/** Kinds a person can create through feedback. `dismissal_reason` is read-only, derived from the case's own dismissal. */
export type FeedbackKind = Exclude<MemoryEntryKind, 'dismissal_reason'>
export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['intentional_payment', 'recurring_confirmation', 'vendor_alias_proposal', 'vendor_context_note', 'recovery_outcome_confirmation']

export type MemoryScope =
  | { type: 'vendor'; vendorKey: string }
  | { type: 'recurring_series'; vendorKey: string; recurringSeriesId: string }
  | { type: 'case'; caseId: string }
  | { type: 'source_records'; sourceRecordIds: string[] }

/** Finding types the detector emits (src/types.ts FindingType). */
export const KNOWN_FINDING_TYPES: readonly string[] = ['exact_duplicate', 'near_duplicate', 'overpayment', 'unclaimed_discount', 'missed_discount', 'bank_account_change', 'amount_outlier', 'shared_invoice_number']

export interface AmountBand {
  currency: CurrencyCode
  minMinor: number
  maxMinor: number
}

export type AliasDecision = 'proposed' | 'confirmed' | 'rejected'
export type RecoveryOutcome = 'returned_as_recorded' | 'partially_returned' | 'not_returned' | 'disputed_recorded_return'

export type MemoryDetails =
  | { kind: 'intentional_payment'; findingType: string | null; amountBand: AmountBand | null }
  | { kind: 'recurring_confirmation'; assertion: 'recurring_expected' | 'not_recurring' }
  | {
      kind: 'vendor_alias_proposal'
      aliasName: string
      decision: AliasDecision
      /** Always true: a customer's confirmation is input to the canonical identity service, never a merge. */
      pendingCanonicalIdentityConfirmation: true
    }
  | { kind: 'vendor_context_note' }
  | { kind: 'recovery_outcome_confirmation'; outcome: RecoveryOutcome }
  | { kind: 'dismissal_reason'; tag: string | null; findingType: string }

export type StoredStatus = 'active' | 'revoked' | 'expired'

export interface MemoryHistoryEvent {
  at: number
  action: 'created' | 'revoked' | 'expired'
  /** null for system events (expiry evaluated at read time). */
  actorId: string | null
  note: string | null
}

export interface MemoryEntry {
  id: string
  tenantId: string
  kind: MemoryEntryKind
  scope: MemoryScope
  sourceRefs: SourceRef[]
  /** From the server session; null for entries derived from case records. */
  authorActorId: string | null
  createdAt: number
  rationale: string
  expiresAt: number | null
  reviewAt: number | null
  /** As evaluated at read time against `now`. */
  status: StoredStatus
  revokedAt: number | null
  revokedBy: string | null
  revokeReason: string | null
  /** Append-only. */
  history: MemoryHistoryEvent[]
  details: MemoryDetails
  origin: 'customer_feedback' | 'case_dismissal'
  version: typeof MEMORY_VERSION
}

export class MemoryError extends Error {
  readonly code: 'not_found' | 'already_inactive' | 'not_validated' | 'capacity' | 'invalid_input' | 'read_only'
  constructor(code: MemoryError['code'], message: string) {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------- ports

export interface MemoryPorts {
  financial: FinancialSourcePort
  cases: CaseReadPort
}

interface PortIndex {
  records: Map<string, SourceRecord>
  vendorKeys: Set<string>
  series: Map<string, RecurringSeriesView>
  cases: Map<string, CaseSnapshot>
}

function indexPorts(ctx: TenantContext, ports: MemoryPorts, now: number): PortIndex {
  const records = new Map<string, SourceRecord>()
  const vendorKeys = new Set<string>()
  for (const r of ports.financial.listSourceRecords(ctx)) {
    requireTenant(ctx, r.tenantId)
    records.set(r.recordId, r)
    vendorKeys.add(r.vendor.vendorKey)
  }
  const series = new Map<string, RecurringSeriesView>()
  for (const s of ports.financial.listRecurringSeries(ctx)) {
    series.set(s.seriesId, s)
    vendorKeys.add(s.vendorKey)
  }
  const cases = new Map<string, CaseSnapshot>()
  for (const c of ports.cases.listCases(ctx, now)) {
    cases.set(c.caseId, c)
    vendorKeys.add(c.vendor.vendorKey)
  }
  return { records, vendorKeys, series, cases }
}

// ---------------------------------------------------------------- validation

export interface ValidationIssue {
  path: string
  code:
    | 'forged_identity_field'
    | 'server_assigned_field'
    | 'unknown_field'
    | 'required'
    | 'invalid_type'
    | 'too_long'
    | 'too_many'
    | 'out_of_range'
    | 'unknown_reference'
    | 'scope_not_allowed_for_kind'
    | 'invalid_value'
  message: string
}

/** Produced only by validateFeedbackInput; the store refuses anything else. */
export interface ValidatedFeedback {
  readonly tenantId: string
  readonly authorActorId: string
  readonly kind: FeedbackKind
  readonly scope: MemoryScope
  readonly rationale: string
  readonly expiresAt: number | null
  readonly reviewAt: number | null
  readonly details: MemoryDetails
  readonly sourceRefs: readonly SourceRef[]
  readonly validatedAt: number
}

export type FeedbackValidation = { ok: true; value: ValidatedFeedback } | { ok: false; issues: ValidationIssue[] }

const validated = new WeakSet<object>()

export function isValidatedFeedback(value: unknown): value is ValidatedFeedback {
  return typeof value === 'object' && value !== null && validated.has(value)
}

/** Identity is server-derived. A body that carries any of these is refused, not silently overwritten. */
const IDENTITY_FIELDS = ['tenantId', 'tenant', 'actorId', 'actor', 'authorActorId', 'author', 'userId', 'revokedBy']
const SERVER_FIELDS = ['id', 'createdAt', 'status', 'history', 'version', 'revokedAt', 'revokeReason', 'origin', 'sourceRefs', 'validatedAt']
const INPUT_FIELDS = ['kind', 'scope', 'rationale', 'expiresAt', 'reviewAt', 'details']

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

/** Control characters other than tab/newline/carriage return are refused in free text. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true
  }
  return false
}

function boundedText(value: unknown, path: string, max: number, issues: ValidationIssue[]): string | null {
  if (typeof value !== 'string') {
    issues.push({ path, code: value === undefined ? 'required' : 'invalid_type', message: `${path} must be text.` })
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    issues.push({ path, code: 'required', message: `${path} is required.` })
    return null
  }
  if (trimmed.length > max) {
    issues.push({ path, code: 'too_long', message: `${path} is limited to ${max} characters.` })
    return null
  }
  if (hasControlChars(trimmed)) {
    issues.push({ path, code: 'invalid_value', message: `${path} contains control characters.` })
    return null
  }
  return trimmed
}

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  for (const key of Object.keys(obj).sort()) {
    if (IDENTITY_FIELDS.includes(key)) issues.push({ path: `${path}${key}`, code: 'forged_identity_field', message: 'Tenant and author come from the signed-in session, not the request.' })
    else if (!allowed.includes(key)) issues.push({ path: `${path}${key}`, code: 'unknown_field', message: `Unexpected field ${path}${key}.` })
  }
}

/** Money is accepted only as integer minor units in a structured field; never parsed from text. */
function minorAmount(value: unknown, path: string, issues: ValidationIssue[]): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    issues.push({ path, code: 'invalid_type', message: `${path} must be an integer amount in minor units.` })
    return null
  }
  if (value < 0) {
    issues.push({ path, code: 'out_of_range', message: `${path} must not be negative.` })
    return null
  }
  return value
}

function timestamp(value: unknown, path: string, now: number, issues: ValidationIssue[]): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    issues.push({ path, code: 'invalid_type', message: `${path} must be a timestamp in milliseconds.` })
    return null
  }
  if (value <= now || value > now + MAX_EXPIRY_MS) {
    issues.push({ path, code: 'out_of_range', message: `${path} must be in the future and within ${MAX_EXPIRY_MS / DAY_MS} days.` })
    return null
  }
  return value
}

const ALLOWED_SCOPES: Record<FeedbackKind, MemoryScope['type'][]> = {
  intentional_payment: ['source_records', 'case', 'recurring_series', 'vendor'],
  recurring_confirmation: ['recurring_series'],
  vendor_alias_proposal: ['vendor'],
  vendor_context_note: ['vendor', 'case'],
  recovery_outcome_confirmation: ['case'],
}

function validateScope(raw: unknown, index: PortIndex, issues: ValidationIssue[]): MemoryScope | null {
  if (!isPlainObject(raw)) {
    issues.push({ path: 'scope', code: raw === undefined ? 'required' : 'invalid_type', message: 'scope is required.' })
    return null
  }
  const key = (value: unknown, path: string): string | null => {
    if (typeof value !== 'string' || !value || value.length > MAX_KEY_LENGTH) {
      issues.push({ path, code: 'invalid_type', message: `${path} must be a reference of at most ${MAX_KEY_LENGTH} characters.` })
      return null
    }
    return value
  }
  switch (raw.type) {
    case 'vendor': {
      onlyKeys(raw, ['type', 'vendorKey'], 'scope.', issues)
      const vendorKey = key(raw.vendorKey, 'scope.vendorKey')
      if (vendorKey === null) return null
      if (!index.vendorKeys.has(vendorKey)) {
        issues.push({ path: 'scope.vendorKey', code: 'unknown_reference', message: 'No vendor with this key in this account.' })
        return null
      }
      return { type: 'vendor', vendorKey }
    }
    case 'recurring_series': {
      onlyKeys(raw, ['type', 'vendorKey', 'recurringSeriesId'], 'scope.', issues)
      const vendorKey = key(raw.vendorKey, 'scope.vendorKey')
      const recurringSeriesId = key(raw.recurringSeriesId, 'scope.recurringSeriesId')
      if (vendorKey === null || recurringSeriesId === null) return null
      const series = index.series.get(recurringSeriesId)
      if (!series || series.vendorKey !== vendorKey) {
        issues.push({ path: 'scope.recurringSeriesId', code: 'unknown_reference', message: 'No recurring series with this ID for this vendor in this account.' })
        return null
      }
      return { type: 'recurring_series', vendorKey, recurringSeriesId }
    }
    case 'case': {
      onlyKeys(raw, ['type', 'caseId'], 'scope.', issues)
      const caseId = key(raw.caseId, 'scope.caseId')
      if (caseId === null) return null
      if (!index.cases.has(caseId)) {
        issues.push({ path: 'scope.caseId', code: 'unknown_reference', message: 'No case with this ID in this account.' })
        return null
      }
      return { type: 'case', caseId }
    }
    case 'source_records': {
      onlyKeys(raw, ['type', 'sourceRecordIds'], 'scope.', issues)
      const ids = raw.sourceRecordIds
      if (!Array.isArray(ids) || ids.length === 0) {
        issues.push({ path: 'scope.sourceRecordIds', code: 'required', message: 'At least one source record is required.' })
        return null
      }
      if (ids.length > MAX_SCOPE_SOURCE_RECORDS) {
        issues.push({ path: 'scope.sourceRecordIds', code: 'too_many', message: `At most ${MAX_SCOPE_SOURCE_RECORDS} source records.` })
        return null
      }
      const unique = new Set<string>()
      for (const [i, id] of ids.entries()) {
        const v = key(id, `scope.sourceRecordIds[${i}]`)
        if (v === null) return null
        if (!index.records.has(v)) {
          issues.push({ path: `scope.sourceRecordIds[${i}]`, code: 'unknown_reference', message: 'No source record with this ID in this account.' })
          return null
        }
        unique.add(v)
      }
      return { type: 'source_records', sourceRecordIds: [...unique].sort() }
    }
    default:
      issues.push({ path: 'scope.type', code: 'invalid_value', message: 'scope.type must be vendor, recurring_series, case or source_records.' })
      return null
  }
}

function validateDetails(kind: FeedbackKind, raw: unknown, scope: MemoryScope, index: PortIndex, issues: ValidationIssue[]): MemoryDetails | null {
  const obj = raw === undefined ? {} : raw
  if (!isPlainObject(obj)) {
    issues.push({ path: 'details', code: 'invalid_type', message: 'details must be an object.' })
    return null
  }
  switch (kind) {
    case 'intentional_payment': {
      onlyKeys(obj, ['findingType', 'amountBand'], 'details.', issues)
      let findingType: string | null = null
      if (obj.findingType !== undefined && obj.findingType !== null) {
        if (typeof obj.findingType !== 'string' || !KNOWN_FINDING_TYPES.includes(obj.findingType)) {
          issues.push({ path: 'details.findingType', code: 'invalid_value', message: 'Unknown finding type.' })
          return null
        }
        findingType = obj.findingType
      }
      let amountBand: AmountBand | null = null
      if (obj.amountBand !== undefined && obj.amountBand !== null) {
        if (!isPlainObject(obj.amountBand)) {
          issues.push({ path: 'details.amountBand', code: 'invalid_type', message: 'amountBand must be an object.' })
          return null
        }
        onlyKeys(obj.amountBand, ['currency', 'minMinor', 'maxMinor'], 'details.amountBand.', issues)
        const currency = typeof obj.amountBand.currency === 'string' ? normalizeCurrency(obj.amountBand.currency) : 'UNKNOWN'
        if (currency === 'UNKNOWN') {
          issues.push({ path: 'details.amountBand.currency', code: 'invalid_value', message: 'An amount band needs a known ISO currency.' })
          return null
        }
        const minMinor = minorAmount(obj.amountBand.minMinor, 'details.amountBand.minMinor', issues)
        const maxMinor = minorAmount(obj.amountBand.maxMinor, 'details.amountBand.maxMinor', issues)
        if (minMinor === null || maxMinor === null) return null
        const maxWidth = Math.max(AMOUNT_BAND_MIN_WIDTH_MINOR, Math.floor((minMinor * AMOUNT_BAND_MAX_WIDTH_BPS) / 10000))
        if (maxMinor < minMinor || maxMinor - minMinor > maxWidth) {
          issues.push({ path: 'details.amountBand', code: 'out_of_range', message: `The band must be narrow: at most ${AMOUNT_BAND_MAX_WIDTH_BPS / 100}% of its lower bound.` })
          return null
        }
        amountBand = { currency, minMinor, maxMinor }
      }
      if (scope.type === 'vendor' && (amountBand === null || findingType === null)) {
        issues.push({ path: 'details', code: 'scope_not_allowed_for_kind', message: 'A vendor-wide intentional payment needs a finding type and a narrow amount band; blanket vendor exceptions are not accepted.' })
        return null
      }
      return { kind, findingType, amountBand }
    }
    case 'recurring_confirmation': {
      onlyKeys(obj, ['assertion'], 'details.', issues)
      if (obj.assertion !== 'recurring_expected' && obj.assertion !== 'not_recurring') {
        issues.push({ path: 'details.assertion', code: 'invalid_value', message: 'assertion must be recurring_expected or not_recurring.' })
        return null
      }
      return { kind, assertion: obj.assertion }
    }
    case 'vendor_alias_proposal': {
      onlyKeys(obj, ['aliasName', 'decision'], 'details.', issues)
      const aliasName = boundedText(obj.aliasName, 'details.aliasName', MAX_ALIAS_NAME_LENGTH, issues)
      if (aliasName === null) return null
      if (obj.decision !== 'proposed' && obj.decision !== 'confirmed' && obj.decision !== 'rejected') {
        issues.push({ path: 'details.decision', code: 'invalid_value', message: 'decision must be proposed, confirmed or rejected.' })
        return null
      }
      return { kind, aliasName, decision: obj.decision, pendingCanonicalIdentityConfirmation: true }
    }
    case 'vendor_context_note':
      onlyKeys(obj, [], 'details.', issues)
      return { kind }
    case 'recovery_outcome_confirmation': {
      onlyKeys(obj, ['outcome'], 'details.', issues)
      const outcomes: RecoveryOutcome[] = ['returned_as_recorded', 'partially_returned', 'not_returned', 'disputed_recorded_return']
      if (typeof obj.outcome !== 'string' || !outcomes.includes(obj.outcome as RecoveryOutcome)) {
        issues.push({ path: 'details.outcome', code: 'invalid_value', message: `outcome must be one of ${outcomes.join(', ')}.` })
        return null
      }
      const c = scope.type === 'case' ? index.cases.get(scope.caseId) : undefined
      if (!c || !['requested', 'recovered', 'not_recovered'].includes(c.stage)) {
        issues.push({ path: 'scope.caseId', code: 'invalid_value', message: 'A recovery outcome can only be recorded on a case that reached a recovery request.' })
        return null
      }
      return { kind, outcome: obj.outcome as RecoveryOutcome }
    }
  }
}

function refsForScope(scope: MemoryScope): SourceRef[] {
  switch (scope.type) {
    case 'vendor':
      return [{ id: `vendor:${scope.vendorKey}`, label: 'Vendor' }]
    case 'recurring_series':
      return [{ id: `series:${scope.recurringSeriesId}`, label: 'Recurring series' }]
    case 'case':
      return [{ id: `case:${scope.caseId}`, label: 'Case' }]
    case 'source_records':
      return scope.sourceRecordIds.map((id) => ({ id: `record:${id}`, label: 'Source record' }))
  }
}

/**
 * Validate a feedback request body. Tenant and author come from `ctx` only:
 * a body that names a tenant or an actor is refused. Every scope reference
 * must exist in this tenant's ports. Free text is bounded and stored as text;
 * money only ever comes from structured integer minor-unit fields.
 */
export function validateFeedbackInput(ctx: TenantContext, input: unknown, now: number, ports: MemoryPorts): FeedbackValidation {
  requirePermission(ctx, 'feedback:write')
  const issues: ValidationIssue[] = []
  if (!isPlainObject(input)) return { ok: false, issues: [{ path: '', code: 'invalid_type', message: 'Feedback must be an object.' }] }
  for (const key of Object.keys(input).sort()) {
    if (IDENTITY_FIELDS.includes(key)) issues.push({ path: key, code: 'forged_identity_field', message: 'Tenant and author come from the signed-in session, not the request.' })
    else if (SERVER_FIELDS.includes(key)) issues.push({ path: key, code: 'server_assigned_field', message: `${key} is assigned by the server.` })
    else if (!INPUT_FIELDS.includes(key)) issues.push({ path: key, code: 'unknown_field', message: `Unexpected field ${key}.` })
  }
  if (issues.length) return { ok: false, issues }

  const kind = input.kind
  if (typeof kind !== 'string' || !FEEDBACK_KINDS.includes(kind as FeedbackKind)) {
    const code = kind === 'dismissal_reason' ? 'invalid_value' : kind === undefined ? 'required' : 'invalid_value'
    return { ok: false, issues: [{ path: 'kind', code, message: kind === 'dismissal_reason' ? 'Dismissal reasons are recorded on the case itself, not as feedback.' : `kind must be one of ${FEEDBACK_KINDS.join(', ')}.` }] }
  }
  const feedbackKind = kind as FeedbackKind
  const rationale = boundedText(input.rationale, 'rationale', MAX_RATIONALE_LENGTH, issues)
  const expiresAt = timestamp(input.expiresAt, 'expiresAt', now, issues)
  let reviewAt = timestamp(input.reviewAt, 'reviewAt', now, issues)
  if (expiresAt !== null && reviewAt !== null && reviewAt > expiresAt) issues.push({ path: 'reviewAt', code: 'out_of_range', message: 'reviewAt must not be after expiresAt.' })

  const index = indexPorts(ctx, ports, now)
  const scope = validateScope(input.scope, index, issues)
  if (scope && !ALLOWED_SCOPES[feedbackKind].includes(scope.type)) {
    issues.push({ path: 'scope.type', code: 'scope_not_allowed_for_kind', message: `${feedbackKind} accepts scope ${ALLOWED_SCOPES[feedbackKind].join(' or ')}.` })
  }
  const details = scope && !issues.length ? validateDetails(feedbackKind, input.details, scope, index, issues) : null
  if (issues.length || !scope || !details || rationale === null) return { ok: false, issues: issues.length ? issues : [{ path: '', code: 'invalid_value', message: 'Invalid feedback.' }] }

  // Anything that can become a suppression proposal must come back for review.
  if (reviewAt === null && (feedbackKind === 'intentional_payment' || feedbackKind === 'recurring_confirmation')) {
    reviewAt = now + DEFAULT_REVIEW_AFTER_MS
    if (expiresAt !== null && reviewAt > expiresAt) reviewAt = expiresAt
  }

  const value: ValidatedFeedback = Object.freeze({
    tenantId: ctx.tenantId,
    authorActorId: ctx.actorId,
    kind: feedbackKind,
    scope: Object.freeze(scope),
    rationale,
    expiresAt,
    reviewAt,
    details: Object.freeze(details),
    sourceRefs: Object.freeze(refsForScope(scope)),
    validatedAt: now,
  })
  validated.add(value)
  return { ok: true, value }
}

// ---------------------------------------------------------------- store

export interface MemoryFilter {
  kinds?: readonly MemoryEntryKind[]
  /** Default true: revoked and expired entries are returned too (the UI shows them for undo/audit). */
  includeInactive?: boolean
}

export interface TenantMemoryExport {
  version: typeof MEMORY_VERSION
  tenantId: string
  exportedAt: number
  entryCount: number
  /** Every stored entry, active or not, with its full history. */
  entries: MemoryEntry[]
  note: string
}

/**
 * Persistence boundary. Every method takes the server-derived context and
 * enforces tenant + permission itself, so a caller cannot reach another
 * tenant's partition. Writes need `feedback:write`; reads need `financial:read`.
 */
export interface FeedbackStore {
  create(ctx: TenantContext, feedback: ValidatedFeedback, now: number): MemoryEntry
  revoke(ctx: TenantContext, entryId: string, reason: string, now: number): MemoryEntry
  list(ctx: TenantContext, filter: MemoryFilter, now: number): MemoryEntry[]
  get(ctx: TenantContext, entryId: string, now: number): MemoryEntry | null
  exportTenant(ctx: TenantContext, now: number): TenantMemoryExport
  deleteTenant(ctx: TenantContext): { deleted: number }
}

function statusAt(entry: MemoryEntry, now: number): StoredStatus {
  if (entry.revokedAt !== null) return 'revoked'
  if (entry.expiresAt !== null && now >= entry.expiresAt) return 'expired'
  return 'active'
}

/** A read-time view: status evaluated against `now`, expiry appended to the history copy. */
function viewAt(entry: MemoryEntry, now: number): MemoryEntry {
  const copy = structuredClone(entry)
  copy.status = statusAt(entry, now)
  if (copy.status === 'expired' && !copy.history.some((h) => h.action === 'expired')) {
    copy.history.push({ at: entry.expiresAt!, action: 'expired', actorId: null, note: 'Expired at the date set by its author.' })
  }
  return copy
}

const sortEntries = (a: MemoryEntry, b: MemoryEntry) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Reference implementation: tenant-partitioned, process-local, not durable. */
export class InMemoryFeedbackStore implements FeedbackStore {
  private readonly partitions = new Map<string, Map<string, MemoryEntry>>()
  private readonly sequences = new Map<string, number>()

  private partition(tenantId: string): Map<string, MemoryEntry> {
    let p = this.partitions.get(tenantId)
    if (!p) {
      p = new Map()
      this.partitions.set(tenantId, p)
    }
    return p
  }

  create(ctx: TenantContext, feedback: ValidatedFeedback, now: number): MemoryEntry {
    requirePermission(ctx, 'feedback:write')
    if (!isValidatedFeedback(feedback)) throw new MemoryError('not_validated', 'Feedback must pass validateFeedbackInput first.')
    requireTenant(ctx, feedback.tenantId)
    if (feedback.authorActorId !== ctx.actorId) throw new IntelligenceAccessError('forbidden', 'Feedback was validated for a different author.')
    const partition = this.partition(ctx.tenantId)
    if (partition.size >= MAX_ENTRIES_PER_TENANT) throw new MemoryError('capacity', 'This account has reached the business-memory limit.')
    const seq = (this.sequences.get(ctx.tenantId) ?? 0) + 1
    this.sequences.set(ctx.tenantId, seq)
    const id = `mem_${String(seq).padStart(6, '0')}_${stableHash(`${ctx.tenantId}|${seq}|${now}|${feedback.kind}`)}`
    const entry: MemoryEntry = {
      id,
      tenantId: ctx.tenantId,
      kind: feedback.kind,
      scope: structuredClone(feedback.scope) as MemoryScope,
      sourceRefs: feedback.sourceRefs.map((r) => ({ ...r })),
      authorActorId: ctx.actorId,
      createdAt: now,
      rationale: feedback.rationale,
      expiresAt: feedback.expiresAt,
      reviewAt: feedback.reviewAt,
      status: 'active',
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      history: [{ at: now, action: 'created', actorId: ctx.actorId, note: null }],
      details: structuredClone(feedback.details) as MemoryDetails,
      origin: 'customer_feedback',
      version: MEMORY_VERSION,
    }
    partition.set(id, entry)
    return viewAt(entry, now)
  }

  revoke(ctx: TenantContext, entryId: string, reason: string, now: number): MemoryEntry {
    requirePermission(ctx, 'feedback:write')
    if (entryId.startsWith('dismissal:')) throw new MemoryError('read_only', 'A dismissal reason is changed on its case, not in business memory.')
    const entry = this.partition(ctx.tenantId).get(entryId)
    if (!entry) throw new MemoryError('not_found', 'No such memory entry in this account.')
    if (statusAt(entry, now) !== 'active') throw new MemoryError('already_inactive', 'This entry is already revoked or expired.')
    const issues: ValidationIssue[] = []
    const note = boundedText(reason, 'reason', MAX_REVOKE_REASON_LENGTH, issues)
    if (note === null) throw new MemoryError('invalid_input', issues.map((i) => i.message).join(' '))
    entry.revokedAt = now
    entry.revokedBy = ctx.actorId
    entry.revokeReason = note
    entry.status = 'revoked'
    entry.history.push({ at: now, action: 'revoked', actorId: ctx.actorId, note })
    return viewAt(entry, now)
  }

  list(ctx: TenantContext, filter: MemoryFilter, now: number): MemoryEntry[] {
    requirePermission(ctx, 'financial:read')
    const includeInactive = filter.includeInactive ?? true
    return [...this.partition(ctx.tenantId).values()]
      .filter((e) => !filter.kinds || filter.kinds.includes(e.kind))
      .map((e) => viewAt(e, now))
      .filter((e) => includeInactive || e.status === 'active')
      .sort(sortEntries)
  }

  get(ctx: TenantContext, entryId: string, now: number): MemoryEntry | null {
    requirePermission(ctx, 'financial:read')
    const entry = this.partition(ctx.tenantId).get(entryId)
    return entry ? viewAt(entry, now) : null
  }

  exportTenant(ctx: TenantContext, now: number): TenantMemoryExport {
    requirePermission(ctx, 'financial:read')
    const entries = this.list(ctx, { includeInactive: true }, now)
    return {
      version: MEMORY_VERSION,
      tenantId: ctx.tenantId,
      exportedAt: now,
      entryCount: entries.length,
      entries,
      note: 'Business memory for this account only: structured feedback entries with their full history. Dismissal reasons live on the cases and are exported with them.',
    }
  }

  deleteTenant(ctx: TenantContext): { deleted: number } {
    requirePermission(ctx, 'feedback:write')
    const partition = this.partitions.get(ctx.tenantId)
    const deleted = partition?.size ?? 0
    this.partitions.delete(ctx.tenantId)
    this.sequences.delete(ctx.tenantId)
    return { deleted }
  }
}

/**
 * Account export hook. Wiring it into server/account.ts (the account export
 * flow) is a CTO-coordinated change and is not done here.
 */
export function exportTenantMemory(ctx: TenantContext, store: FeedbackStore, now: number): TenantMemoryExport {
  return store.exportTenant(ctx, now)
}

/**
 * Account deletion hook: removes every memory entry of the caller's tenant and
 * nothing else. Wiring into server/account.ts is a CTO-coordinated change.
 */
export function deleteTenantMemory(ctx: TenantContext, store: FeedbackStore): { deleted: number } {
  return store.deleteTenant(ctx)
}

// ---------------------------------------------------------------- resolution (read time)

/**
 * `scope_missing`: the entry's scope no longer resolves (records reimported
 * under new IDs, a case removed). It stays stored and visible but influences
 * nothing until a person re-scopes it.
 */
export type EffectiveStatus = StoredStatus | 'scope_missing'

export interface MemoryEntryView {
  entry: MemoryEntry
  effectiveStatus: EffectiveStatus
  inEffect: boolean
  /** Active entry past its review date: still shown, no longer feeds suppression proposals. */
  reviewDue: boolean
  /** Scope references that no longer exist. */
  missingRefs: string[]
  /** Vendors the scope touches (resolved against current data). */
  vendorKeys: string[]
  /** Derived from a case record; change it on the case, not here. */
  readOnly: boolean
}

/** Read-only memory entries derived from reviewed case dismissals ("reviewed dismissal"). */
export function dismissalEntries(ctx: TenantContext, cases: readonly CaseSnapshot[]): MemoryEntry[] {
  const out: MemoryEntry[] = []
  for (const c of cases) {
    if (c.stage !== 'dismissed' || c.dismissal === null) continue
    const createdAt = c.updatedAt ?? 0
    const rationale = c.dismissal.reason?.trim().slice(0, MAX_RATIONALE_LENGTH) || (c.dismissal.tag ? `Dismissed as expected (${c.dismissal.tag}).` : 'Dismissed as expected.')
    out.push({
      id: `dismissal:${c.caseId}`,
      tenantId: ctx.tenantId,
      kind: 'dismissal_reason',
      scope: { type: 'case', caseId: c.caseId },
      sourceRefs: [{ id: `case:${c.caseId}`, label: 'Dismissed case' }],
      authorActorId: null,
      createdAt,
      rationale,
      expiresAt: null,
      reviewAt: null,
      status: 'active',
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      history: [{ at: createdAt, action: 'created', actorId: null, note: 'Derived from the case dismissal.' }],
      details: { kind: 'dismissal_reason', tag: c.dismissal.tag, findingType: c.findingType },
      origin: 'case_dismissal',
      version: MEMORY_VERSION,
    })
  }
  return out
}

function resolveView(entry: MemoryEntry, index: PortIndex, now: number): MemoryEntryView {
  const missingRefs: string[] = []
  const vendorKeys = new Set<string>()
  const scope = entry.scope
  switch (scope.type) {
    case 'vendor':
      if (index.vendorKeys.has(scope.vendorKey)) vendorKeys.add(scope.vendorKey)
      else missingRefs.push(`vendor:${scope.vendorKey}`)
      break
    case 'recurring_series': {
      const s = index.series.get(scope.recurringSeriesId)
      if (s && s.vendorKey === scope.vendorKey) vendorKeys.add(s.vendorKey)
      else missingRefs.push(`series:${scope.recurringSeriesId}`)
      break
    }
    case 'case': {
      const c = index.cases.get(scope.caseId)
      if (c) vendorKeys.add(c.vendor.vendorKey)
      else missingRefs.push(`case:${scope.caseId}`)
      break
    }
    case 'source_records':
      for (const id of scope.sourceRecordIds) {
        const r = index.records.get(id)
        if (r) vendorKeys.add(r.vendor.vendorKey)
        else missingRefs.push(`record:${id}`)
      }
      break
  }
  const status = entry.status
  // Any missing reference makes the whole entry scope_missing: a partial scope
  // would silently widen or narrow what the author said.
  const effectiveStatus: EffectiveStatus = status !== 'active' ? status : missingRefs.length ? 'scope_missing' : 'active'
  return {
    entry,
    effectiveStatus,
    inEffect: effectiveStatus === 'active',
    reviewDue: effectiveStatus === 'active' && entry.reviewAt !== null && now >= entry.reviewAt,
    missingRefs: missingRefs.sort(),
    vendorKeys: [...vendorKeys].sort(),
    readOnly: entry.origin === 'case_dismissal',
  }
}

interface ResolvedMemory {
  views: MemoryEntryView[]
  index: PortIndex
}

function resolveAll(ctx: TenantContext, store: FeedbackStore, ports: MemoryPorts, now: number): ResolvedMemory {
  const index = indexPorts(ctx, ports, now)
  const stored = store.list(ctx, { includeInactive: true }, now)
  for (const e of stored) requireTenant(ctx, e.tenantId)
  const derived = dismissalEntries(ctx, [...index.cases.values()])
  const views = [...stored, ...derived].sort(sortEntries).map((e) => resolveView(e, index, now))
  return { views, index }
}

/**
 * Every memory entry for the tenant (stored + derived dismissals), resolved
 * against current data at `now`. Needs `financial:read` and `cases:read`.
 */
export function resolveMemory(ctx: TenantContext, store: FeedbackStore, ports: MemoryPorts, now: number): MemoryEntryView[] {
  requirePermission(ctx, 'financial:read')
  requirePermission(ctx, 'cases:read')
  return resolveAll(ctx, store, ports, now).views
}

// ---------------------------------------------------------------- aliases

export interface AliasState {
  vendorKey: string
  /** As the latest in-effect entry spelled it. */
  aliasName: string
  normalizedAlias: string
  /** null when in-effect entries disagree (see `contradictory`). */
  decision: AliasDecision | null
  contradictory: boolean
  entryIds: string[]
}

export function normalizeAliasName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Current alias statements per (vendor, alias). When in-effect entries
 * disagree (one says "same supplier", another "not the same"), the alias is
 * reported as contradictory and counted as neither confirmed nor rejected
 * until a person revokes one of them.
 */
export function aliasStates(views: readonly MemoryEntryView[]): AliasState[] {
  const groups = new Map<string, MemoryEntryView[]>()
  for (const v of views) {
    if (!v.inEffect || v.entry.details.kind !== 'vendor_alias_proposal' || v.entry.scope.type !== 'vendor') continue
    const key = `${v.entry.scope.vendorKey}\u0000${normalizeAliasName(v.entry.details.aliasName)}`
    groups.set(key, [...(groups.get(key) ?? []), v])
  }
  const out: AliasState[] = []
  for (const [key, group] of groups) {
    const [vendorKey, normalizedAlias] = key.split('\u0000')
    const decisions = new Set(group.map((v) => (v.entry.details as { decision: AliasDecision }).decision))
    // "proposed" alongside "confirmed" is not a contradiction; "rejected" alongside either is.
    const contradictory = decisions.has('rejected') && decisions.size > 1
    const latest = group.at(-1)!.entry.details as { aliasName: string }
    out.push({
      vendorKey,
      aliasName: latest.aliasName,
      normalizedAlias,
      decision: contradictory ? null : decisions.has('confirmed') ? 'confirmed' : decisions.has('rejected') ? 'rejected' : 'proposed',
      contradictory,
      entryIds: group.map((v) => v.entry.id),
    })
  }
  return out.sort((a, b) => (a.vendorKey < b.vendorKey ? -1 : a.vendorKey > b.vendorKey ? 1 : a.normalizedAlias < b.normalizedAlias ? -1 : a.normalizedAlias > b.normalizedAlias ? 1 : 0))
}

// ---------------------------------------------------------------- suppression proposals

export type ProposalScope =
  | { type: 'recurring_series'; vendorKey: string; recurringSeriesId: string; sourceRecordIds: string[] }
  | { type: 'source_records'; sourceRecordIds: string[]; findingType: string | null }
  | { type: 'vendor_finding_amount_band'; vendorKey: string; findingType: string; currency: CurrencyCode; minMinor: number; maxMinor: number }

export interface SuppressionProposal {
  proposalId: string
  tenantId: string
  /** Nothing is applied. The detection owner decides, under deterministic controls. */
  status: 'proposed_for_detection_owner'
  /** suppress: do not raise this specific pattern again. rule_feedback: a reviewer believes the rule misfired; for review only. */
  proposalKind: 'suppress_matching_finding' | 'rule_feedback'
  basis: { entryId: string; kind: MemoryEntryKind; origin: MemoryEntry['origin'] }
  scope: ProposalScope
  /** Current cases the scope would touch. None of them has supported evidence (else the proposal is blocked). */
  targetsCaseIds: string[]
  /** rule_feedback only: supported cases the feedback mentions. They are never suppressed. */
  supportedCaseIds: string[]
  rationale: string
  reviewAt: number | null
  expiresAt: number | null
  memoryVersion: typeof MEMORY_VERSION
}

export type BlockedReason =
  | 'targets_supported_finding'
  | 'blanket_vendor_scope_not_allowed'
  | 'review_due'
  | 'not_in_effect'

export interface BlockedProposal {
  entryId: string
  kind: MemoryEntryKind
  reason: BlockedReason
  caseIds: string[]
}

export interface SuppressionProposalsResult {
  proposals: SuppressionProposal[]
  blocked: BlockedProposal[]
}

function intersects(a: readonly string[], b: ReadonlySet<string>): boolean {
  return a.some((x) => b.has(x))
}

function targetedCases(scope: ProposalScope, index: PortIndex): CaseSnapshot[] {
  const all = [...index.cases.values()]
  switch (scope.type) {
    case 'recurring_series': {
      const ids = new Set(scope.sourceRecordIds)
      return all.filter((c) => intersects(c.sourceRecordIds, ids))
    }
    case 'source_records': {
      const ids = new Set(scope.sourceRecordIds)
      return all.filter((c) => intersects(c.sourceRecordIds, ids) && (scope.findingType === null || c.findingType === scope.findingType))
    }
    case 'vendor_finding_amount_band':
      return all.filter((c) => c.vendor.vendorKey === scope.vendorKey && c.findingType === scope.findingType && c.currency === scope.currency && c.flaggedMinor >= scope.minMinor && c.flaggedMinor <= scope.maxMinor)
  }
}

type Candidate = { proposalKind: SuppressionProposal['proposalKind']; scope: ProposalScope } | { blocked: BlockedReason } | null

function candidateFor(view: MemoryEntryView, index: PortIndex): Candidate {
  const { entry } = view
  const d = entry.details
  const s = entry.scope
  if (d.kind === 'intentional_payment') {
    if (s.type === 'source_records') return { proposalKind: 'suppress_matching_finding', scope: { type: 'source_records', sourceRecordIds: [...s.sourceRecordIds], findingType: d.findingType } }
    if (s.type === 'case') {
      const c = index.cases.get(s.caseId)!
      return { proposalKind: 'suppress_matching_finding', scope: { type: 'source_records', sourceRecordIds: [...c.sourceRecordIds].sort(), findingType: d.findingType ?? c.findingType } }
    }
    if (s.type === 'recurring_series') {
      const series = index.series.get(s.recurringSeriesId)!
      return { proposalKind: 'suppress_matching_finding', scope: { type: 'recurring_series', vendorKey: s.vendorKey, recurringSeriesId: s.recurringSeriesId, sourceRecordIds: [...series.sourceRecordIds].sort() } }
    }
    if (s.type === 'vendor' && d.amountBand && d.findingType) {
      return { proposalKind: 'suppress_matching_finding', scope: { type: 'vendor_finding_amount_band', vendorKey: s.vendorKey, findingType: d.findingType, currency: d.amountBand.currency, minMinor: d.amountBand.minMinor, maxMinor: d.amountBand.maxMinor } }
    }
    return { blocked: 'blanket_vendor_scope_not_allowed' }
  }
  if (d.kind === 'recurring_confirmation' && s.type === 'recurring_series') {
    const series = index.series.get(s.recurringSeriesId)!
    return {
      proposalKind: d.assertion === 'recurring_expected' ? 'suppress_matching_finding' : 'rule_feedback',
      scope: { type: 'recurring_series', vendorKey: s.vendorKey, recurringSeriesId: s.recurringSeriesId, sourceRecordIds: [...series.sourceRecordIds].sort() },
    }
  }
  if (d.kind === 'dismissal_reason' && s.type === 'case') {
    const c = index.cases.get(s.caseId)!
    const scope: ProposalScope = { type: 'source_records', sourceRecordIds: [...c.sourceRecordIds].sort(), findingType: c.findingType }
    if (d.tag === 'intentional' || d.tag === 'known_vendor_exception') return { proposalKind: 'suppress_matching_finding', scope }
    if (d.tag === 'not_a_match' || d.tag === 'detection_error') return { proposalKind: 'rule_feedback', scope }
    return null
  }
  return null
}

function proposalsFrom(ctx: TenantContext, resolved: ResolvedMemory): SuppressionProposalsResult {
  const proposals: SuppressionProposal[] = []
  const blocked: BlockedProposal[] = []
  for (const view of resolved.views) {
    const { entry } = view
    const relevant = entry.kind === 'intentional_payment' || entry.kind === 'recurring_confirmation' || entry.kind === 'dismissal_reason'
    if (!relevant) continue
    if (!view.inEffect) {
      blocked.push({ entryId: entry.id, kind: entry.kind, reason: 'not_in_effect', caseIds: [] })
      continue
    }
    const candidate = candidateFor(view, resolved.index)
    if (candidate === null) continue
    if ('blocked' in candidate) {
      blocked.push({ entryId: entry.id, kind: entry.kind, reason: candidate.blocked, caseIds: [] })
      continue
    }
    const targets = targetedCases(candidate.scope, resolved.index).sort((a, b) => (a.caseId < b.caseId ? -1 : 1))
    const supported = targets.filter((c) => c.supportedPotentialMinor !== null).map((c) => c.caseId)
    if (candidate.proposalKind === 'suppress_matching_finding') {
      if (supported.length) {
        blocked.push({ entryId: entry.id, kind: entry.kind, reason: 'targets_supported_finding', caseIds: supported })
        continue
      }
      if (view.reviewDue) {
        blocked.push({ entryId: entry.id, kind: entry.kind, reason: 'review_due', caseIds: [] })
        continue
      }
    }
    proposals.push({
      proposalId: `sup_${stableHash(`${ctx.tenantId}|${entry.id}|${JSON.stringify(candidate.scope)}`)}`,
      tenantId: ctx.tenantId,
      status: 'proposed_for_detection_owner',
      proposalKind: candidate.proposalKind,
      basis: { entryId: entry.id, kind: entry.kind, origin: entry.origin },
      scope: candidate.scope,
      targetsCaseIds: targets.filter((c) => c.supportedPotentialMinor === null).map((c) => c.caseId),
      supportedCaseIds: candidate.proposalKind === 'rule_feedback' ? supported : [],
      rationale: entry.rationale,
      reviewAt: entry.reviewAt,
      expiresAt: entry.expiresAt,
      memoryVersion: MEMORY_VERSION,
    })
  }
  const byId = (a: { entryId?: string; proposalId?: string }, b: { entryId?: string; proposalId?: string }) => {
    const x = a.proposalId ?? a.entryId ?? ''
    const y = b.proposalId ?? b.entryId ?? ''
    return x < y ? -1 : x > y ? 1 : 0
  }
  return { proposals: proposals.sort(byId), blocked: blocked.sort(byId) }
}

function memoryEnvelope<T>(ctx: TenantContext, ports: MemoryPorts, model: string, now: number, reasons: string[], sources: SourceRef[], result: T): ReadModelEnvelope<T> {
  const origin = ports.financial.origin
  const snapshot: string[] = origin === 'legacy_audit_snapshot' ? [COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS] : []
  const imports = ports.financial.listImportCoverage(ctx)
  const newest = imports.reduce<number | null>((m, i) => (i.importedAt > 0 && (m === null || i.importedAt > m) ? i.importedAt : m), null)
  return envelope({
    model,
    metricDefinitionVersion: MEMORY_VERSION,
    ctx,
    origin,
    scope: { from: null, to: null, dateBasis: 'none', currencies: [] },
    computedAt: now,
    sourceUpdatedAt: newest,
    coverage: [coverage(model, [...snapshot, ...reasons])],
    sources,
    result,
  })
}

/**
 * Turn in-effect memory into narrowly scoped proposals for the detection
 * owner. Never blanket vendor suppression, never a finding whose evidence
 * gate passed (supportedPotentialMinor !== null), never from revoked,
 * expired, scope-missing or review-due entries. Nothing is applied.
 */
export function suppressionProposals(ctx: TenantContext, store: FeedbackStore, ports: MemoryPorts, now: number): ReadModelEnvelope<SuppressionProposalsResult> {
  requirePermission(ctx, 'financial:read')
  requirePermission(ctx, 'cases:read')
  const resolved = resolveAll(ctx, store, ports, now)
  const result = proposalsFrom(ctx, resolved)
  const sources = result.proposals.map((p) => ({ id: `memory:${p.basis.entryId}`, label: `Memory entry (${p.basis.kind})` }))
  return memoryEnvelope(ctx, ports, 'suppression_proposals', now, [COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING], sources, result)
}

// ---------------------------------------------------------------- explainability

export type InfluenceTarget = { vendorKey: string } | { caseId: string }

export type InfluenceKind = 'context_shown' | 'alias_display' | 'suppression_proposal' | 'rule_feedback' | 'proposal_blocked' | 'none_not_in_effect'

export interface InfluenceItem {
  entryId: string
  kind: MemoryEntryKind
  origin: MemoryEntry['origin']
  effectiveStatus: EffectiveStatus
  inEffect: boolean
  reviewDue: boolean
  readOnly: boolean
  relation: MemoryScope['type']
  influence: InfluenceKind[]
  rationale: string
  createdAt: number
  authorActorId: string | null
}

export interface InfluenceResult {
  target: InfluenceTarget
  /** False when the vendor or case does not exist in this tenant's current data. */
  targetFound: boolean
  entries: InfluenceItem[]
}

function viewTouches(view: MemoryEntryView, target: InfluenceTarget, index: PortIndex): boolean {
  const s = view.entry.scope
  if ('vendorKey' in target) {
    if ((s.type === 'vendor' || s.type === 'recurring_series') && s.vendorKey === target.vendorKey) return true
    return view.vendorKeys.includes(target.vendorKey)
  }
  const c = index.cases.get(target.caseId)
  if (s.type === 'case') return s.caseId === target.caseId
  if (!c) return false
  if (s.type === 'vendor') return s.vendorKey === c.vendor.vendorKey
  const ids = new Set(c.sourceRecordIds)
  if (s.type === 'source_records') return intersects(s.sourceRecordIds, ids)
  const series = index.series.get(s.recurringSeriesId)
  return series ? intersects(series.sourceRecordIds, ids) : false
}

/** Shared by vendorProfiles: influence of each resolved entry. */
export function influenceItems(views: readonly MemoryEntryView[], proposals: SuppressionProposalsResult): InfluenceItem[] {
  const proposed = new Map(proposals.proposals.map((p) => [p.basis.entryId, p.proposalKind]))
  const blocked = new Set(proposals.blocked.filter((b) => b.reason !== 'not_in_effect').map((b) => b.entryId))
  return views.map((view) => {
    const influence: InfluenceKind[] = []
    if (!view.inEffect) influence.push('none_not_in_effect')
    else {
      influence.push('context_shown')
      if (view.entry.kind === 'vendor_alias_proposal') influence.push('alias_display')
      const p = proposed.get(view.entry.id)
      if (p === 'suppress_matching_finding') influence.push('suppression_proposal')
      if (p === 'rule_feedback') influence.push('rule_feedback')
      if (blocked.has(view.entry.id)) influence.push('proposal_blocked')
    }
    return {
      entryId: view.entry.id,
      kind: view.entry.kind,
      origin: view.entry.origin,
      effectiveStatus: view.effectiveStatus,
      inEffect: view.inEffect,
      reviewDue: view.reviewDue,
      readOnly: view.readOnly,
      relation: view.entry.scope.type,
      influence,
      rationale: view.entry.rationale,
      createdAt: view.entry.createdAt,
      authorActorId: view.entry.authorActorId,
    }
  })
}

/** Internal for vendorProfiles: resolve once, reuse. */
export function resolveMemoryWithProposals(ctx: TenantContext, store: FeedbackStore, ports: MemoryPorts, now: number): { views: MemoryEntryView[]; proposals: SuppressionProposalsResult } {
  const resolved = resolveAll(ctx, store, ports, now)
  return { views: resolved.views, proposals: proposalsFrom(ctx, resolved) }
}

/**
 * Which memory entries would influence an insight about this vendor or case,
 * including inactive ones (so the UI can show "revoked on ..."). For
 * explainability and undo; it changes nothing.
 */
export function influenceFor(ctx: TenantContext, store: FeedbackStore, ports: MemoryPorts, target: InfluenceTarget, now: number): ReadModelEnvelope<InfluenceResult> {
  requirePermission(ctx, 'financial:read')
  requirePermission(ctx, 'cases:read')
  const resolved = resolveAll(ctx, store, ports, now)
  const proposals = proposalsFrom(ctx, resolved)
  const touching = resolved.views.filter((v) => viewTouches(v, target, resolved.index))
  const targetFound = 'vendorKey' in target ? resolved.index.vendorKeys.has(target.vendorKey) : resolved.index.cases.has(target.caseId)
  const entries = influenceItems(touching, proposals)
  const reasons = targetFound ? [] : [COVERAGE_REASONS.NO_DATA]
  const sources = entries.map((e) => ({ id: `memory:${e.entryId}`, label: `Memory entry (${e.kind})` }))
  return memoryEnvelope(ctx, ports, 'memory_influence', now, reasons, sources, { target, targetFound, entries })
}
