/**
 * Account-scoped assistant (CPO workstream P5), version `account-assistant-v0.1`.
 *
 * A READ-ONLY, DETERMINISTIC question router over the product-intelligence
 * read models. It answers a fixed registry of account-level questions
 * (recovery status, what changed in spending, vendor context, why an insight
 * exists, missing evidence, pending approvals, import coverage, metric
 * definitions) and turns action requests into typed, never-executed
 * proposals. It complements, and does not replace, the case-scoped assistant
 * in server/assistant.ts, which stays as it is.
 *
 * Grounding rules:
 *  - The answer text is built only from fixed templates, numbers computed by
 *    code from read-model envelopes, and vendor / case display names, which
 *    are sanitized first (control characters, markup, links and addresses
 *    stripped, length capped, quoted). The question itself is never echoed,
 *    and no imported free text (finding explanations, insight titles or
 *    explanations, notes, warning details) is interpolated.
 *  - Every figure is a MoneyAmount taken from (or computed exactly from) a
 *    read model, per currency. Currencies are never added together.
 *  - Every citation is validated against the sources of the envelopes used and
 *    the record / case IDs the ports returned for this tenant.
 *  - Coverage, freshness and limits of every envelope used are returned.
 *  - Nothing is executed, written, sent or persisted. Questions and answers
 *    are not stored.
 *
 * Optional AI: only through AiGatewayPort (Jagan's gateway), only when the
 * gateway is enabled and the tenant policy is not 'off', and only to map an
 * unmatched question onto one registry intent id. The model never writes the
 * answer, never supplies a number and never sees ledger rows: its packet is
 * the question text and the list of intent ids. Default: disabled.
 *
 * Server-safe: relative `.ts` imports of src/intelligence modules only.
 */
import {
  INTELLIGENCE_CONTRACT_VERSION,
  UNKNOWN_CURRENCY,
  hasPermission,
  type CaseReadPort,
  type CaseSnapshot,
  type CoverageItem,
  type DataOrigin,
  type FinancialSourcePort,
  type MoneyAmount,
  type Permission,
  type ReadModelEnvelope,
  type ReturnMatchPort,
  type SourceRef,
  type TenantContext,
} from './contracts.ts'
import { IntelligenceAccessError, isCalendarDate, requirePermission } from './envelope.ts'
import { NET_UNAVAILABLE_REASON, SPEND_METRIC_VERSION, importCoverageSummary, spendByVendor, spendSummary, type SpendOptions, type SpendSummary } from './spend.ts'
import {
  RECOVERY_DEFINITIONS,
  RECOVERY_METRIC_VERSION,
  caseContributions,
  recoveryByVendor,
  recoveryOverview,
  type RecoveryCounts,
  type RecoveryCurrencyFigures,
  type RecoveryOptions,
} from './recoveryVisibility.ts'
import { BASELINE_VERSION } from './baselines.ts'
import { VENDOR_PROFILE_VERSION, vendorProfile, type VendorProfile } from './vendorProfiles.ts'
import type { FeedbackStore } from './memory.ts'
import {
  ATTENTION_METRIC_VERSION,
  CASE_COMMAND_ROUTE,
  attentionItemFor,
  attentionQueue,
  proposeApprovalAction,
  type ApprovalActionProposal,
  type AttentionInteraction,
  type AttentionItem,
  type AttentionKind,
  type CaseCommandType,
  type ProposalErrorCode,
} from './attention.ts'
import type { AiGatewayPort, AiTaskRequest } from './aiGateway.ts'

export const ACCOUNT_ASSISTANT_VERSION = 'account-assistant-v0.1' as const
export const MAX_QUESTION_LENGTH = 500
export const MAX_SUBJECT_ID_LENGTH = 256
/** Longest custom period the spend comparison accepts. */
export const MAX_PERIOD_DAYS = 366
export const MAX_DISPLAY_NAME_LENGTH = 80
export const MAX_CITATIONS = 30
/** Items listed by name in one answer; counts always cover everything. */
export const MAX_LISTED_ITEMS = 10
export const MAX_PROPOSAL_ITEMS = 10

// ---------------------------------------------------------------- intents

export type AccountIntentId =
  | 'recovery_status'
  | 'spend_change'
  | 'vendor_context'
  | 'insight_explanation'
  | 'missing_evidence'
  | 'approvals_pending'
  | 'coverage'
  | 'definitions'
  | 'investigation_or_action_request'

export interface IntentDefinition {
  id: AccountIntentId
  summary: string
  examples: string[]
  readModels: string[]
  /** Permissions beyond `assistant:ask`. */
  permissions: Permission[]
  output: string
  limits: string
  /** Whether optional AI interpretation may map a question onto this intent. */
  aiSelectable: boolean
}

/** The fixed registry. Order is the documented order, not the routing order. */
export const INTENT_REGISTRY: readonly IntentDefinition[] = [
  {
    id: 'recovery_status',
    summary: 'Where recoveries stand across the account, per currency and lifecycle stage.',
    examples: ['How are my recoveries going?', 'How much has come back?', 'What is the status of this case?'],
    readModels: ['recovery.overview', 'recovery.by_vendor', 'CaseReadPort'],
    permissions: ['cases:read'],
    output: 'Flagged, supported, approved-outstanding, promised and customer-recorded figures per currency, never summed; matched returns shown as not available.',
    limits: 'Saved audit snapshots; customer-recorded returns are not matched to bank or accounting records.',
    aiSelectable: true,
  },
  {
    id: 'spend_change',
    summary: 'What changed in recorded payments between two covered periods.',
    examples: ['What changed in spending?', 'Did we pay more last month?'],
    readModels: ['spend.summary', 'spend.by_vendor', 'spend.import_coverage', 'vendor_profiles (vendor subject)'],
    permissions: ['financial:read'],
    output: 'Gross recorded payments per currency for both periods, the difference when both are fully covered, and the largest vendor differences.',
    limits: 'Refuses to compare a period no import covers; no difference is stated for partly covered periods; never says why spending changed.',
    aiSelectable: true,
  },
  {
    id: 'vendor_context',
    summary: 'What the covered records say about one vendor.',
    examples: ['Tell me about Fixture Coffee Co', 'What do we know about this supplier?'],
    readModels: ['vendor_profiles'],
    permissions: ['financial:read', 'cases:read'],
    output: 'Covered period, gross payments and refunds per currency, recurring series, recent 90-day comparison, cases by stage, alias proposals and business-memory counts.',
    limits: 'Vendor key is not a reviewed identity; names are never merged.',
    aiSelectable: true,
  },
  {
    id: 'insight_explanation',
    summary: 'Why an insight was raised: its rule, figures, coverage and cited sources.',
    examples: ['Why am I seeing this insight?', 'Why was this raised?'],
    readModels: ['insight lookup (insights engine, optional dependency)'],
    permissions: ['financial:read', 'cases:read'],
    output: 'Rule identifier, figures as calculated by the insight rule, coverage reasons and validated source references.',
    limits: 'Unavailable until the insights engine is wired in; insight titles and explanations are never repeated verbatim.',
    aiSelectable: true,
  },
  {
    id: 'missing_evidence',
    summary: 'Which cases are waiting for information or have not been reviewed.',
    examples: ['Which cases need evidence?', 'What information is missing?'],
    readModels: ['attention_queue'],
    permissions: ['cases:read'],
    output: 'Cases marked as needing information and the count of unreviewed checks, with case links.',
    limits: 'Specific evidence gaps per case are listed by the case assistant on the case page.',
    aiSelectable: true,
  },
  {
    id: 'approvals_pending',
    summary: 'What is waiting for the customer: approvals and other actions.',
    examples: ['What needs my approval?', 'What is waiting on me?'],
    readModels: ['attention_queue'],
    permissions: ['cases:read'],
    output: 'Counts by category and the approval items with their labelled amount.',
    limits: 'Derived from saved case state; approval objects and send status are not visible yet.',
    aiSelectable: true,
  },
  {
    id: 'coverage',
    summary: 'Which records the answers are based on: imports, dates, gaps and freshness.',
    examples: ['What data do you have?', 'Which months are covered?', 'When was the last import?'],
    readModels: ['spend.import_coverage'],
    permissions: ['financial:read'],
    output: 'Imports, accepted and rejected rows, covered range, gaps, overlap and newest import.',
    limits: 'Coverage is the payment-date range of each import, not proof that every payment was imported.',
    aiSelectable: true,
  },
  {
    id: 'definitions',
    summary: 'What a metric means.',
    examples: ['What does promised mean?', 'What counts as spend?'],
    readModels: ['RECOVERY_DEFINITIONS', 'spend-v0.1 definitions'],
    permissions: [],
    output: 'The shipped one-sentence definitions.',
    limits: 'Definitions only; no figures.',
    aiSelectable: true,
  },
  {
    id: 'investigation_or_action_request',
    summary: 'A request to do something (send a reminder, recover, dismiss, approve, email a vendor).',
    examples: ['Send a reminder', 'Recover from Fixture Coffee Co', 'Approve all', 'Email the vendor'],
    readModels: ['attention_queue', 'proposeApprovalAction'],
    permissions: ['cases:read'],
    output: 'A typed ActionProposal per case, requiring human approval, never executed.',
    limits: 'Never executes, never bulk-approves; payments, deletions and record edits are refused.',
    aiSelectable: false,
  },
]

export const INTENT_IDS: readonly AccountIntentId[] = INTENT_REGISTRY.map((i) => i.id)
const AI_SELECTABLE_INTENTS: readonly AccountIntentId[] = INTENT_REGISTRY.filter((i) => i.aiSelectable).map((i) => i.id)

// ---------------------------------------------------------------- dependency types

/**
 * The minimum the assistant needs from an insight. Defined locally so the
 * insights engine can satisfy it structurally without this module importing it.
 */
export interface InsightLike {
  id: string
  /** When present, must equal the asking tenant or the insight is treated as not found. */
  tenantId?: string
  rule: string
  title: string
  explanation: string
  sourceRefs: SourceRef[]
  coverage: CoverageItem[]
  /** Reason codes (preferred) describing the insight's limits. */
  limits: string[]
  figures?: MoneyAmount[]
}

export interface AccountAssistantDeps {
  financial: FinancialSourcePort
  cases: CaseReadPort
  returns: ReturnMatchPort
  memory: FeedbackStore
  insightLookup?: (ctx: TenantContext, insightId: string) => InsightLike | null
  /** Jagan's AI gateway. Omitted or disabled → purely deterministic. */
  ai?: AiGatewayPort
}

export type AssistantSubject =
  | { vendorKey: string }
  | { insightId: string }
  | { caseId: string }
  | { from: string; to: string }

export interface AskOptions {
  /** Structured subject from the screen the question was asked on. Validated; never trusted. */
  subject?: unknown
  /** Coverage reasons the caller knows and the ports cannot see (e.g. unreadable saved audits). */
  extraCoverageReasons?: string[]
  /** Freshness basis passed to the read models (e.g. LegacyAuditSource.newestUpdateAt). */
  sourceUpdatedAt?: number | null
  staleAfterMs?: number
}

// ---------------------------------------------------------------- errors

export type AssistantRequestErrorCode = 'invalid_question' | 'invalid_subject' | 'not_found'

/** Malformed question or subject (routes: 400), or a subject not in this account (routes: 404, same response for another tenant's ID). */
export class AssistantRequestError extends Error {
  readonly code: AssistantRequestErrorCode
  readonly field: 'question' | 'subject'
  constructor(code: AssistantRequestErrorCode, field: 'question' | 'subject', message: string) {
    super(message)
    this.code = code
    this.field = field
  }
}

class DependencyUnavailable extends Error {
  readonly dependency: string
  constructor(dependency: string) {
    super(`${dependency} unavailable`)
    this.dependency = dependency
  }
}

// ---------------------------------------------------------------- answer types

export interface AnswerFigure extends MoneyAmount {
  /** Which read-model figure this is, e.g. `recovery.customer_recorded_returns`. */
  metric: string
}

export interface AnswerCoverageItem extends CoverageItem {
  model: string
}

export interface UncertaintyNote {
  code: string
  text: string
}

export interface RouteHint {
  /** Logical screen id: `overview`, `findings`, `recoveries`, `reports`, `audits`, `case:<caseId>`, `vendor:<vendorKey>`, `insight:<id>`. */
  screen: string
  /** False for screens that do not exist yet (design decision for Aditya). */
  existing: boolean
  label: string
}

export type AssistantActionKind =
  | 'approve'
  | 'reject'
  | 'dismiss'
  | 'send_reminder'
  | 'contact_vendor'
  | 'start_recovery'
  | 'record_return'
  | 'close_case'
  | 'investigate'
  | 'unsupported_mutation'

export interface ActionProposalItem {
  caseId: string
  vendorDisplayName: string
  attentionItemId: string | null
  attentionKind: AttentionKind | null
  /** `existing_case_command`: a typed proposal for the existing case-command route. `case_screen`: the person acts on the case page. */
  targetService: 'existing_case_command' | 'case_screen'
  route: typeof CASE_COMMAND_ROUTE
  /** From proposeApprovalAction; never submitted by this layer. */
  commandProposal: ApprovalActionProposal | null
  refusal: { code: ProposalErrorCode; detail: string } | null
  suggestedCaseCommands: CaseCommandType[]
  routeHint: RouteHint
  requiresHumanApproval: true
  executed: false
}

export interface ActionProposal {
  kind: 'assistant_action_proposal'
  requestedAction: AssistantActionKind
  bulkRequested: boolean
  bulkExecutionSupported: false
  items: ActionProposalItem[]
  /** Matching cases before the MAX_PROPOSAL_ITEMS cap. */
  totalCandidates: number
  requiresHumanApproval: true
  perItemApprovalRequired: true
  executed: false
  sideEffects: 'none'
}

export type AnswerStatus = 'answered' | 'needs_clarification' | 'insufficient_data' | 'not_permitted' | 'unavailable'

export interface AccountAnswer {
  version: typeof ACCOUNT_ASSISTANT_VERSION
  contractVersion: typeof INTELLIGENCE_CONTRACT_VERSION
  tenantId: string
  intent: AccountIntentId | 'unsupported'
  status: AnswerStatus
  answer: string
  figures: AnswerFigure[]
  citations: SourceRef[]
  coverage: AnswerCoverageItem[]
  asOf: { computedAt: number; sourceUpdatedAt: number | null; stale: boolean }
  models: Array<{ model: string; metricDefinitionVersion: string; origin: DataOrigin }>
  uncertainty: UncertaintyNote[]
  proposal: ActionProposal | null
  routeHint: RouteHint | null
  interpretation: { method: 'deterministic' | 'subject' | 'ai_intent_mapping' | 'none'; aiInvocationId: string | null }
  error: { code: 'dependency_unavailable'; dependency: string } | null
  /** True only when the AI gateway chose the intent. The answer text and figures are always deterministic. */
  aiUsed: boolean
  answerSource: 'deterministic_templates'
  /** Questions and answers are not stored by this module. */
  retention: 'not_persisted'
}

// ---------------------------------------------------------------- sanitizing and formatting

// eslint-disable-next-line no-control-regex
const CONTROL_OR_INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g
/** Non-global copy for `.test` (a /g regex keeps lastIndex between calls). */
const HAS_CONTROL_OR_INVISIBLE = new RegExp(CONTROL_OR_INVISIBLE.source)
const URL_LIKE = /(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S*/gi
const SCHEME_LIKE = /\b(?:javascript|data|vbscript|mailto|file):\S*/gi
const EMAIL_LIKE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g
const MARKUP = /[`*_[\]<>#|~\\{}\u0022\u201c\u201d]/g

/**
 * A display name from imported data made safe to place in an answer: no
 * control or invisible characters, no markdown or HTML markup, no links or
 * addresses, one line, at most `max` characters. It is only ever shown as
 * data (quoted), never interpreted.
 */
export function sanitizeDisplayName(raw: unknown, fallback = 'Unnamed vendor', max = MAX_DISPLAY_NAME_LENGTH): string {
  if (typeof raw !== 'string') return fallback
  let s = raw.normalize('NFKC').replace(CONTROL_OR_INVISIBLE, ' ').replace(URL_LIKE, ' ').replace(SCHEME_LIKE, ' ').replace(EMAIL_LIKE, ' ').replace(MARKUP, ' ')
  s = s.replace(/\(\s*\)/g, ' ')
  // A link removed from inside parentheses leaves one behind; drop parentheses unless they pair up.
  if ((s.match(/\(/g) ?? []).length !== (s.match(/\)/g) ?? []).length) s = s.replace(/[()]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return fallback
  const chars = [...s]
  if (chars.length > max) s = `${chars.slice(0, max - 1).join('').trimEnd()}…`
  return s
}

function quoted(name: unknown, fallback?: string): string {
  return `“${sanitizeDisplayName(name, fallback)}”`
}

function safeCurrency(code: string): string {
  return /^[A-Z]{3}$/.test(code) ? code : UNKNOWN_CURRENCY
}

/**
 * Deterministic money text: currency code, thousands separators, two decimals
 * (the minor-unit scale every adapter uses today), no locale data. An unknown
 * currency is labelled as such. One amount, one currency; never a sum.
 */
export function formatMoney(m: MoneyAmount): string {
  const neg = m.amountMinor < 0
  const abs = Math.abs(m.amountMinor)
  const units = Math.floor(abs / 100)
  const cents = abs % 100
  const body = `${neg ? '-' : ''}${String(units).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(cents).padStart(2, '0')}`
  const currency = safeCurrency(m.currency)
  return currency === UNKNOWN_CURRENCY ? `${body} (currency not recorded)` : `${currency} ${body}`
}

/** Per-currency list, each currency on its own, sorted by code. */
export function formatMoneyList(list: readonly MoneyAmount[]): string {
  if (!list.length) return 'none'
  return [...list].sort((a, b) => cmp(a.currency, b.currency)).map(formatMoney).join('; ')
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const FINDING_LABELS: Record<string, string> = {
  exact_duplicate: 'possible duplicate payment',
  near_duplicate: 'possible near-duplicate payment',
  overpayment: 'possible overpayment',
  unclaimed_discount: 'possible unclaimed discount',
  missed_discount: 'missed discount (future savings)',
  bank_account_change: 'supplier bank detail change (security review)',
  amount_outlier: 'unusual amount',
  shared_invoice_number: 'shared invoice number',
}

const STAGE_LABELS: Record<string, string> = {
  unreviewed: 'not reviewed',
  needs_info: 'needing information',
  dismissed: 'dismissed as expected',
  confirmed: 'confirmed',
  requested: 'requested from the supplier',
  recovered: 'closed with a recorded return',
  not_recovered: 'closed without a recorded return',
}

// ---------------------------------------------------------------- coverage reason text

/** Plain-language text for every reason code the read models emit. Unknown codes get a generic line. */
export const REASON_TEXT: Readonly<Record<string, string>> = {
  no_data: 'There is no data for this yet in the covered records.',
  customer_supplied_source: 'The figures come from files imported into this account (customer-supplied), not an authenticated ledger.',
  snapshot_not_continuous: 'Saved audits are snapshots, not continuous monitoring.',
  missing_dates: 'Some rows have no payment date.',
  missing_currency: 'Some rows have no recorded currency; they are shown separately as an unrecorded currency.',
  mixed_currency: 'More than one currency is present; each is shown separately and never added together.',
  missing_category: 'Some rows have no category.',
  cross_audit_overlap: 'Some rows or cases appear in more than one saved audit and were counted once.',
  insufficient_history: 'There is not enough covered history for a comparison.',
  no_independent_return_matching: 'Returns have not been matched to bank or accounting records; matched returns are not available yet.',
  settlement_unverified: 'Whether each payment settled is not known from the imported rows.',
  upstream_contract_pending: 'Part of this depends on a service that is not connected yet.',
  stale_source: 'The newest source data is old.',
  rejected_rows: 'Some rows were rejected at import.',
  unreadable_saved_audit: 'At least one saved audit could not be read.',
  period_not_covered: 'No import covers the requested period.',
  period_partially_covered: 'Part of the period is outside every import’s date range.',
  gate_currency_unsupported: 'The evidence review supports USD only, so other currencies cannot show a supported amount yet.',
  promise_return_order_unknown: 'For at least one case the order of a supplier promise and a recorded return is unknown.',
  send_state_not_in_snapshot: 'Whether an approved request was actually sent is not visible here.',
  revalidation_not_in_snapshot: 'A case may need revalidation before approval; the case page checks this.',
  revision_unknown: 'At least one case has no saved revision.',
  unmapped_case_state: 'At least one case is in a state this view does not recognise.',
  too_few_payments: 'Too few payments for a baseline.',
  too_few_covered_months: 'Too few covered months for a baseline.',
  seasonal_model_not_implemented: 'Seasonal patterns are not modelled.',
  non_positive_median: 'The typical amount could not be established.',
  window_not_covered: 'The comparison window is not fully covered by imports.',
  vendor_not_found: 'The vendor is not in the covered records.',
}

function reasonText(code: string): { code: string; text: string } {
  const safe = /^[a-z0-9_]{1,64}$/.test(code) ? code : 'unrecognised_reason'
  return { code: safe, text: REASON_TEXT[safe] ?? 'Another coverage limit applies.' }
}

const WARNING_TEXT: Readonly<Record<string, string>> = {
  cross_audit_overlap_counted_once: 'Rows that appear in more than one saved audit were counted once.',
  cross_audit_cases_folded: 'Cases that appear in more than one saved audit were counted once.',
  cross_audit_case_states_differ: 'Some copies of the same case were reviewed differently in different audits; the most advanced is used.',
  cross_audit_divergent_state: 'Some copies of the same case were reviewed differently in different audits; the most advanced is used.',
  calendar_date_from_instant: 'Some payment dates were read from a stored timestamp and may be a day off.',
  sources_truncated: 'Not every source reference is listed.',
  trend_truncated: 'The period was shortened to the latest months.',
}

// ---------------------------------------------------------------- citations

export const CITATION_PREFIXES = ['record', 'case', 'import', 'rule', 'definition', 'memory', 'insight'] as const

/** Product-definition references every answer may cite. */
export const STATIC_CITATIONS: readonly SourceRef[] = [
  { id: `definition:${RECOVERY_METRIC_VERSION}`, label: 'Recovery metric definitions' },
  { id: `definition:${SPEND_METRIC_VERSION}`, label: 'Spending metric definitions' },
  { id: `definition:${ATTENTION_METRIC_VERSION}`, label: 'Attention and approval definitions' },
  { id: `definition:${ACCOUNT_ASSISTANT_VERSION}`, label: 'Assistant question registry' },
  { id: `rule:${VENDOR_PROFILE_VERSION}`, label: 'Vendor profile definition' },
  { id: `rule:${BASELINE_VERSION}`, label: 'Vendor baseline method' },
]

const CITATION_SHAPE = new RegExp(`^(?:${CITATION_PREFIXES.join('|')}):[^\\s]{1,300}$`)

/**
 * Keeps only citations whose ID has a known shape and is in `allowed` (the
 * sources of the envelopes used plus record / case IDs this tenant's ports
 * returned). Deduplicates, preserves order, sanitizes labels.
 */
export function validateCitations(citations: readonly SourceRef[], allowed: ReadonlySet<string>): { valid: SourceRef[]; rejected: string[] } {
  const valid: SourceRef[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const c of citations) {
    const id = typeof c?.id === 'string' ? c.id : ''
    if (!CITATION_SHAPE.test(id) || !allowed.has(id)) {
      rejected.push(id)
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    valid.push({ id, label: sanitizeDisplayName(c.label, 'Source', 120) })
  }
  return { valid, rejected }
}

/**
 * Every citation ID this tenant's ports can back: source records, imports,
 * cases, stored business-memory entries and the static definitions. Used to
 * validate references that do not come from an envelope (insight sourceRefs),
 * and by tests to check every answer independently.
 */
export function citationUniverse(ctx: TenantContext, deps: AccountAssistantDeps, now: number): Set<string> {
  requirePermission(ctx, 'financial:read')
  requirePermission(ctx, 'cases:read')
  const ids = new Set<string>(STATIC_CITATIONS.map((c) => c.id))
  for (const r of deps.financial.listSourceRecords(ctx)) ids.add(`record:${r.recordId}`)
  for (const i of deps.financial.listImportCoverage(ctx)) ids.add(`import:${i.auditId}/${i.importId}`)
  for (const c of deps.cases.listCases(ctx, now)) ids.add(`case:${c.caseId}`)
  for (const m of deps.memory.list(ctx, {}, now)) ids.add(`memory:${m.id}`)
  return ids
}

// ---------------------------------------------------------------- question and subject validation

export function validateQuestion(question: unknown): string {
  if (typeof question !== 'string') throw new AssistantRequestError('invalid_question', 'question', 'The question must be text.')
  const trimmed = question.trim()
  if (!trimmed) throw new AssistantRequestError('invalid_question', 'question', 'The question is empty.')
  if ([...trimmed].length > MAX_QUESTION_LENGTH) throw new AssistantRequestError('invalid_question', 'question', `The question is longer than ${MAX_QUESTION_LENGTH} characters.`)
  return trimmed
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SUBJECT_ID_LENGTH && !HAS_CONTROL_OR_INVISIBLE.test(value) && value.trim() === value
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / 86_400_000
}

function dateOfDay(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10)
}

/** Shape-checks a subject. Exactly one of the four shapes, no extra keys (a forged `tenantId` is refused). */
export function validateSubject(raw: unknown): AssistantSubject | null {
  if (raw === undefined || raw === null) return null
  const bad = (message: string) => new AssistantRequestError('invalid_subject', 'subject', message)
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('The subject must be an object.')
  const keys = Object.keys(raw).sort()
  const value = raw as Record<string, unknown>
  const only = (expected: string[]) => keys.length === expected.length && expected.every((k, i) => keys[i] === k)
  if (only(['vendorKey'])) {
    if (!validId(value.vendorKey)) throw bad('vendorKey is not valid.')
    return { vendorKey: value.vendorKey }
  }
  if (only(['insightId'])) {
    if (!validId(value.insightId)) throw bad('insightId is not valid.')
    return { insightId: value.insightId }
  }
  if (only(['caseId'])) {
    if (!validId(value.caseId)) throw bad('caseId is not valid.')
    return { caseId: value.caseId }
  }
  if (only(['from', 'to'])) {
    if (!isCalendarDate(value.from) || !isCalendarDate(value.to)) throw bad('from and to must be calendar dates YYYY-MM-DD.')
    if (value.from > value.to) throw bad('from must not be after to.')
    if (dayNumber(value.to) - dayNumber(value.from) + 1 > MAX_PERIOD_DAYS) throw bad(`A period may span at most ${MAX_PERIOD_DAYS} days.`)
    return { from: value.from, to: value.to }
  }
  throw bad('The subject must be exactly one of {vendorKey}, {insightId}, {caseId} or {from, to}.')
}

// ---------------------------------------------------------------- deterministic routing

export interface RouteResult {
  intent: AccountIntentId | null
  action: AssistantActionKind | null
  bulk: boolean
  /** The question contains text that looks like instructions or foreign identifiers. */
  instructionLike: boolean
  /** The question states an amount; it is never used or confirmed. */
  statesAmount: boolean
  /** The question asks to confirm or agree with something. */
  asksToConfirm: boolean
}

const ACTION_PREFIX = /^(?:(?:please|pls|kindly|now|then|ok|okay|just|go ahead and|can you|could you|would you|will you|i want you to|i want to|i need you to|i'd like you to|i'd like to|i would like to|let's|lets|help me)\s*,?\s+)*/
const ACTION_PATTERNS: Array<[RegExp, AssistantActionKind]> = [
  [/^(?:send|schedule)\b.*\b(?:reminders?|follow[- ]?ups?|nudges?)\b/, 'send_reminder'],
  [/^(?:remind|chase|nudge|follow[- ]?up)\b/, 'send_reminder'],
  [/^(?:e-?mail|contact|message|write to|call|reach out|send)\b/, 'contact_vendor'],
  [/^(?:recover|claim|get (?:my |the |our )?money back|request (?:a |the )?(?:refund|credit|repayment))\b/, 'start_recovery'],
  [/^(?:dismiss|ignore (?:this|that|the|these|those|all) (?:findings?|checks?|cases?)|mark (?:it |this |that )?(?:as )?expected)\b/, 'dismiss'],
  [/^approve\b/, 'approve'],
  [/^(?:reject|decline|deny)\b/, 'reject'],
  [/^(?:record|log|mark (?:it |this |that )?(?:as )?(?:paid|returned|refunded|recovered))\b/, 'record_return'],
  [/^close\b/, 'close_case'],
  [/^(?:investigate|look into|dig into|open an investigation)\b/, 'investigate'],
  [/^(?:delete|remove|pay|transfer|wire|write off|edit|change|update|modify|merge|refund)\b/, 'unsupported_mutation'],
]

const INTENT_PATTERNS: Array<[AccountIntentId, RegExp]> = [
  ['definitions', /\b(?:what (?:does|do|is meant by) .{1,60}\bmean|definition|define|meaning of|what counts as|what is (?:a |an |the )?(?:flagged|supported|approved|promised|matched|customer[- ]recorded|recorded return|outstanding|potential|net spend|covered spend)\b)/],
  ['spend_change', /\b(?:spend|spending|spent|expenses?|what changed|what has changed|paid more|paying more|paid less|paying less|payments? (?:changed|went|rose|fell|grew)|change in (?:payments|spend))\b/],
  ['insight_explanation', /\b(?:insights?|why (?:is|was|did|am i seeing) (?:this|that|it)|why (?:was|is) (?:this|that) (?:raised|shown|flagged))\b/],
  ['missing_evidence', /\b(?:evidence|missing (?:info|information|documents?|proof|details)|needs? (?:more )?(?:info|information)|proof)\b/],
  ['approvals_pending', /\b(?:approv\w*|waiting (?:on|for) me|needs? (?:my )?(?:attention|action|sign[- ]?off)|to-?dos?|pending|what should i do)\b/],
  ['coverage', /\b(?:coverage|covered|data (?:do you have|gaps?|quality)|imports?|imported|uploads?|uploaded|missing (?:data|months?|periods?)|how (?:complete|fresh|recent|up to date)|stale|last import|which months)\b/],
  ['vendor_context', /\b(?:vendors?|suppliers?|tell me about|who is)\b/],
  ['recovery_status', /\b(?:recover\w*|returns?|returned|refunds?|credits?|owed|owe|claims?|cases?|status|promised|how much|money back|potential|outstanding)\b/],
]

const INSTRUCTION_LIKE = /\b(?:ignore|disregard|forget|override)\b.{0,40}\b(?:instructions?|rules?|prompts?|above|previous|prior|guardrails?)\b|\b(?:system prompt|you are now|act as|pretend|jailbreak|developer mode)\b|\btenant[\s_:-]?[a-z0-9]|\b(?:record|case|import|audit|memory|insight):[\w/.-]+/
const AMOUNT_LIKE = /[$€£]\s?\d|\b\d[\d,]*(?:\.\d+)?\s?(?:k\b|usd|eur|gbp|dollars?|euros?|pounds?)|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d{3,}(?:\.\d+)?\b/
const CONFIRM_LIKE = /\b(?:confirm|verify|is it true|am i right|correct that|guarantee|agree that|tell me i)\b/

/** Pure, deterministic routing of the question text. Vendor-name matching and subject inference happen later, against the ports. */
export function routeQuestion(question: string): RouteResult {
  const lower = question.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  const withoutDates = lower.replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, ' ')
  const base = {
    instructionLike: INSTRUCTION_LIKE.test(lower),
    statesAmount: AMOUNT_LIKE.test(withoutDates),
    asksToConfirm: CONFIRM_LIKE.test(lower),
  }
  const imperative = lower.replace(ACTION_PREFIX, '')
  for (const [pattern, action] of ACTION_PATTERNS) {
    if (pattern.test(imperative)) return { intent: 'investigation_or_action_request', action, bulk: /\b(?:all|every|everything|each|bulk|them all)\b/.test(lower), ...base }
  }
  for (const [intent, pattern] of INTENT_PATTERNS) {
    if (pattern.test(lower)) return { intent, action: null, bulk: false, ...base }
  }
  return { intent: null, action: null, bulk: false, ...base }
}

// ---------------------------------------------------------------- answer builder

interface Section {
  status: AnswerStatus
  sentences: string[]
  proposal?: ActionProposal | null
  routeHint?: RouteHint | null
}

class AnswerBuilder {
  readonly envelopes: Array<ReadModelEnvelope<unknown>> = []
  readonly figures: AnswerFigure[] = []
  readonly citations: SourceRef[] = []
  readonly allowed = new Set<string>(STATIC_CITATIONS.map((c) => c.id))
  readonly notes = new Map<string, string>()
  readonly extraCoverage: AnswerCoverageItem[] = []
  subjectUsed = false

  use<T>(env: ReadModelEnvelope<T>): ReadModelEnvelope<T> {
    this.envelopes.push(env as ReadModelEnvelope<unknown>)
    for (const s of env.sources) this.allowed.add(s.id)
    return env
  }
  allowCases(snapshots: readonly CaseSnapshot[]): void {
    for (const c of snapshots) this.allowed.add(`case:${c.caseId}`)
  }
  allowRecordIds(ids: readonly string[]): void {
    for (const id of ids) this.allowed.add(`record:${id}`)
  }
  cite(id: string, label: string): void {
    this.citations.push({ id, label })
  }
  citeSources(env: ReadModelEnvelope<unknown>, prefix?: string): void {
    for (const s of env.sources) if (!prefix || s.id.startsWith(prefix)) this.citations.push(s)
  }
  figure(metric: string, money: MoneyAmount): void {
    this.figures.push({ metric, currency: safeCurrency(money.currency), amountMinor: money.amountMinor })
  }
  note(code: string, text: string): void {
    if (!this.notes.has(code)) this.notes.set(code, text)
  }
}

interface Run {
  ctx: TenantContext
  deps: AccountAssistantDeps
  now: number
  options: AskOptions
  subject: AssistantSubject | null
  question: string
  route: RouteResult
  b: AnswerBuilder
}

/** Calls a port or read model; anything but an access or request error becomes a typed unavailable dependency. */
function call<T>(dependency: string, fn: () => T): T {
  try {
    return fn()
  } catch (error) {
    if (error instanceof IntelligenceAccessError || error instanceof AssistantRequestError) throw error
    throw new DependencyUnavailable(dependency)
  }
}

function spendOptions(run: Run): SpendOptions {
  return { extraCoverageReasons: run.options.extraCoverageReasons, sourceUpdatedAt: run.options.sourceUpdatedAt, staleAfterMs: run.options.staleAfterMs }
}

function recoveryOptions(run: Run): RecoveryOptions {
  return { extraCoverageReasons: run.options.extraCoverageReasons, sourceUpdatedAt: run.options.sourceUpdatedAt, staleAfterMs: run.options.staleAfterMs }
}

const SCREENS = {
  overview: { screen: 'overview', existing: true, label: 'Overview' },
  findings: { screen: 'findings', existing: true, label: 'Findings' },
  recoveries: { screen: 'recoveries', existing: true, label: 'Recoveries' },
  audits: { screen: 'audits', existing: true, label: 'Audits' },
  reports: { screen: 'reports', existing: true, label: 'Reports' },
} as const satisfies Record<string, RouteHint>

function caseScreen(caseId: string): RouteHint {
  return { screen: `case:${caseId}`, existing: true, label: 'Case page' }
}

function vendorScreen(vendorKey: string): RouteHint {
  return { screen: `vendor:${vendorKey}`, existing: false, label: 'Vendor profile (proposed screen)' }
}

function insightScreen(insightId: string): RouteHint {
  return { screen: `insight:${insightId}`, existing: false, label: 'Insight (proposed screen)' }
}

// ---------------------------------------------------------------- vendor directory

interface VendorDirectory {
  names: Map<string, string[]>
}

function vendorDirectory(run: Run): VendorDirectory {
  const names = new Map<string, string[]>()
  const add = (key: string, name: string) => {
    const list = names.get(key) ?? []
    list.push(name)
    names.set(key, list)
  }
  if (hasPermission(run.ctx, 'financial:read')) {
    for (const r of call('financial', () => run.deps.financial.listSourceRecords(run.ctx))) add(r.vendor.vendorKey, r.vendor.displayName)
    for (const s of call('financial', () => run.deps.financial.listRecurringSeries(run.ctx))) add(s.vendorKey, s.vendorName)
  }
  if (hasPermission(run.ctx, 'cases:read')) {
    for (const c of call('cases', () => run.deps.cases.listCases(run.ctx, run.now))) add(c.vendor.vendorKey, c.vendor.displayName)
  }
  return { names }
}

function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

/**
 * Finds a vendor of THIS tenant named in the question (whole words). The
 * longest name wins; two vendors tied on the longest name are ambiguous.
 */
function vendorInQuestion(question: string, dir: VendorDirectory): { vendorKey: string } | 'ambiguous' | null {
  const q = ` ${normalizeForMatch(question)} `
  let best: { len: number; keys: Set<string> } = { len: 0, keys: new Set() }
  for (const key of [...dir.names.keys()].sort(cmp)) {
    for (const name of dir.names.get(key)!) {
      const n = normalizeForMatch(name)
      if (n.length < 3 || !q.includes(` ${n} `)) continue
      if (n.length > best.len) best = { len: n.length, keys: new Set([key]) }
      else if (n.length === best.len) best.keys.add(key)
    }
  }
  if (best.keys.size === 0) return null
  if (best.keys.size > 1) return 'ambiguous'
  return { vendorKey: [...best.keys][0] }
}

// ---------------------------------------------------------------- subject existence

interface ResolvedSubject {
  caseSnapshot: CaseSnapshot | null
  insight: InsightLike | null
}

function resolveSubject(run: Run): ResolvedSubject {
  const s = run.subject
  const notFound = () => new AssistantRequestError('not_found', 'subject', 'That item is not in this account.')
  if (!s) return { caseSnapshot: null, insight: null }
  if ('vendorKey' in s) {
    const dir = vendorDirectory(run)
    if (!dir.names.has(s.vendorKey)) throw notFound()
    return { caseSnapshot: null, insight: null }
  }
  if ('caseId' in s) {
    requirePermission(run.ctx, 'cases:read')
    const snapshots = call('cases', () => run.deps.cases.listCases(run.ctx, run.now))
    const snap = snapshots.find((c) => c.caseId === s.caseId)
    if (!snap) throw notFound()
    return { caseSnapshot: snap, insight: null }
  }
  if ('insightId' in s) {
    const lookup = run.deps.insightLookup
    if (!lookup) return { caseSnapshot: null, insight: null }
    const insight = call('insights', () => lookup(run.ctx, s.insightId))
    if (!insight || insight.id !== s.insightId || (insight.tenantId !== undefined && insight.tenantId !== run.ctx.tenantId)) throw notFound()
    return { caseSnapshot: null, insight }
  }
  return { caseSnapshot: null, insight: null }
}

// ---------------------------------------------------------------- recovery status

function recoveryLines(rows: readonly RecoveryCurrencyFigures[], b: AnswerBuilder, prefix: string): string[] {
  const out: string[] = []
  for (const r of rows) {
    const m = (amountMinor: number): MoneyAmount => ({ currency: r.currency, amountMinor })
    const parts: string[] = []
    if (r.flaggedForReviewCount > 0) {
      parts.push(`${plural(r.flaggedForReviewCount, 'open check')} flagged for review involving ${formatMoney(m(r.flaggedForReviewMinor))} (the flagged payment value, not an amount owed)`)
      b.figure(`${prefix}.flagged_for_review`, m(r.flaggedForReviewMinor))
    }
    if (r.supportedPotentialCount > 0) {
      parts.push(`supported potential of ${formatMoney(m(r.supportedPotentialMinor))} on ${plural(r.supportedPotentialCount, 'case')} (the most a request could ask for, not a forecast)`)
      b.figure(`${prefix}.supported_potential`, m(r.supportedPotentialMinor))
    }
    if (r.approvedOutstandingCount > 0) {
      parts.push(`${formatMoney(m(r.approvedOutstandingMinor))} approved and still outstanding on ${plural(r.approvedOutstandingCount, 'request')}`)
      b.figure(`${prefix}.approved_outstanding`, m(r.approvedOutstandingMinor))
    }
    if (r.promisedCount > 0) {
      parts.push(`${formatMoney(m(r.promisedMinor))} promised by suppliers on ${plural(r.promisedCount, 'request')} (a statement, not money received)`)
      b.figure(`${prefix}.promised`, m(r.promisedMinor))
    }
    if (r.customerRecordedReturnsCount > 0) {
      parts.push(`${formatMoney(m(r.customerRecordedReturnsMinor))} recorded by you as returned on ${plural(r.customerRecordedReturnsCount, 'case')} (recorded by the customer, not matched to a bank or accounting record)`)
      b.figure(`${prefix}.customer_recorded_returns`, m(r.customerRecordedReturnsMinor))
    }
    if (r.matchedReturnsMinor !== null && r.matchedReturnsCount !== null && r.matchedReturnsCount > 0) {
      parts.push(`${formatMoney(m(r.matchedReturnsMinor))} in independently matched returns`)
      b.figure(`${prefix}.matched_returns`, m(r.matchedReturnsMinor))
    }
    const label = r.currency === UNKNOWN_CURRENCY ? 'In an unrecorded currency' : `In ${safeCurrency(r.currency)}`
    out.push(parts.length ? `${label}: ${parts.join('; ')}.` : `${label}: no open amounts.`)
  }
  return out
}

function countsSentence(counts: RecoveryCounts): string {
  const extras: string[] = []
  if (counts.needingCustomerAction) extras.push(`${counts.needingCustomerAction} need your action`)
  if (counts.partialReturns) extras.push(`${counts.partialReturns} partly returned`)
  if (counts.closedWithoutRecovery) extras.push(`${counts.closedWithoutRecovery} closed without a recorded return`)
  if (counts.dismissed) extras.push(`${counts.dismissed} dismissed as expected`)
  return `There ${counts.cases === 1 ? 'is' : 'are'} ${plural(counts.cases, 'case')} in the covered records, each counted once across saved audits${extras.length ? ` (${extras.join(', ')})` : ''}.`
}

function claimSentences(run: Run): string[] {
  const out: string[] = []
  if (run.route.statesAmount && run.route.asksToConfirm) out.push('I can’t confirm an amount stated in a question.')
  return out
}

function recoveryStatus(run: Run, resolved: ResolvedSubject): Section {
  const { b, ctx, deps, now } = run
  const sentences = claimSentences(run)
  if (resolved.caseSnapshot) {
    b.subjectUsed = true
    const c = resolved.caseSnapshot
    b.allowCases([c])
    const k = caseContributions(c)
    const m = (amountMinor: number): MoneyAmount => ({ currency: c.currency, amountMinor })
    sentences.push(`This case is a ${FINDING_LABELS[c.findingType] ?? 'check'} for ${quoted(c.vendor.displayName)}, ${STAGE_LABELS[c.stage] ?? 'in review'}; status: ${sanitizeDisplayName(c.statusLabel, 'unknown')}. Next step: ${sanitizeDisplayName(c.nextAction.label, 'see the case page')}.`)
    const parts: string[] = []
    if (k.flagged !== null) { parts.push(`flagged payment value ${formatMoney(m(k.flagged))} (not an amount owed)`); b.figure('case.flagged_for_review', m(k.flagged)) }
    if (k.supported !== null) { parts.push(`supported potential ${formatMoney(m(k.supported))}`); b.figure('case.supported_potential', m(k.supported)) }
    if (k.approvedOutstanding !== null) { parts.push(`approved and outstanding ${formatMoney(m(k.approvedOutstanding))}`); b.figure('case.approved_outstanding', m(k.approvedOutstanding)) }
    if (k.promised !== null) { parts.push(`promised by the supplier ${formatMoney(m(k.promised))} (a statement, not money received)`); b.figure('case.promised', m(k.promised)) }
    if (k.recorded !== null) { parts.push(`recorded by you as returned ${formatMoney(m(k.recorded))} (recorded by the customer, not matched to a bank or accounting record)`); b.figure('case.customer_recorded_returns', m(k.recorded)) }
    sentences.push(parts.length ? `In the covered records: ${parts.join('; ')}.` : 'No amount is established for this case in the covered records.')
    sentences.push('Independently matched returns are not available yet.')
    b.cite(`case:${c.caseId}`, 'Case')
    // The envelope supplies coverage and freshness for the case figures.
    b.use(call('cases', () => recoveryOverview(ctx, deps.cases, deps.returns, now, recoveryOptions(run))))
    return { status: 'answered', sentences, routeHint: caseScreen(c.caseId) }
  }
  if (run.subject && 'vendorKey' in run.subject) {
    b.subjectUsed = true
    const key = run.subject.vendorKey
    let cursor: string | null = null
    for (let page = 0; page < 50; page++) {
      const env = b.use(call('cases', () => recoveryByVendor(ctx, deps.cases, deps.returns, now, { limit: 100, cursor }, recoveryOptions(run))))
      const row = env.result?.rows.find((r) => r.vendorKey === key)
      if (row) {
        b.allowCases(call('cases', () => deps.cases.listCases(ctx, now)))
        sentences.push(`For ${quoted(row.displayName)}: ${countsSentence(row.counts)}`)
        sentences.push(...recoveryLines(row.byCurrency, b, 'recovery.vendor'))
        sentences.push('Independently matched returns are not available yet.')
        for (const id of row.caseIds) b.cite(`case:${id}`, 'Case')
        return { status: 'answered', sentences, routeHint: vendorScreen(key) }
      }
      cursor = env.result?.nextCursor ?? null
      if (!cursor) break
    }
    sentences.push('There are no recovery cases for this vendor in the covered records.')
    return { status: 'insufficient_data', sentences, routeHint: vendorScreen(key) }
  }
  const env = b.use(call('cases', () => recoveryOverview(ctx, deps.cases, deps.returns, now, recoveryOptions(run))))
  const result = env.result
  if (!result || result.counts.cases === 0) {
    sentences.push('There are no recovery cases in the covered records yet. This does not mean nothing could be recovered: only imported records are checked.')
    return { status: 'insufficient_data', sentences, routeHint: SCREENS.audits }
  }
  sentences.push(countsSentence(result.counts))
  sentences.push(...recoveryLines(result.byCurrency, b, 'recovery'))
  sentences.push(result.returnMatching.available ? 'Returns are matched independently where a match exists.' : 'Independently matched returns are not available yet, so none are counted.')
  b.citeSources(env, 'case:')
  return { status: 'answered', sentences, routeHint: SCREENS.recoveries }
}

// ---------------------------------------------------------------- spend change

interface Period { from: string; to: string; label: string }

function monthOf(date: string): string {
  return date.slice(0, 7)
}
function monthRange(month: string): Period {
  const [y, m] = month.split('-').map(Number)
  const from = `${month}-01`
  const to = dateOfDay(Date.UTC(y, m, 1) / 86_400_000 - 1)
  return { from, to, label: month }
}
function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
function isWholeMonth(p: { from: string; to: string }): boolean {
  return p.from.endsWith('-01') && monthOf(p.from) === monthOf(p.to) && monthRange(monthOf(p.from)).to === p.to
}
function periodLabel(p: { from: string; to: string }): string {
  return `${p.from} to ${p.to}`
}

type PeriodState = 'full' | 'partial' | 'not_covered'

function periodState(env: ReadModelEnvelope<SpendSummary>): PeriodState {
  if (env.result === null) return 'not_covered'
  return env.coverage.some((c) => c.reasons.includes('period_partially_covered')) ? 'partial' : 'full'
}

function spendChange(run: Run): Section {
  const { b, ctx, deps, now } = run
  const sentences = claimSentences(run)
  if (run.subject && 'vendorKey' in run.subject) return vendorRecentChange(run, run.subject.vendorKey, sentences)

  let recent: Period
  let prior: Period
  if (run.subject && 'from' in run.subject) {
    b.subjectUsed = true
    const p = run.subject
    if (isWholeMonth(p)) {
      recent = { ...p, label: monthOf(p.from) }
      prior = monthRange(previousMonth(monthOf(p.from)))
    } else {
      const length = dayNumber(p.to) - dayNumber(p.from) + 1
      recent = { ...p, label: periodLabel(p) }
      const priorTo = dateOfDay(dayNumber(p.from) - 1)
      const priorFrom = dateOfDay(dayNumber(p.from) - length)
      prior = { from: priorFrom, to: priorTo, label: periodLabel({ from: priorFrom, to: priorTo }) }
    }
  } else {
    const cov = b.use(call('financial', () => importCoverageSummary(ctx, deps.financial, now, spendOptions(run))))
    const spans = cov.result?.coveredSpans ?? []
    const covered = (p: Period) => spans.some((s) => s.from <= p.from && s.to >= p.to)
    let anchor: Period | null = null
    const end = cov.result?.coveredDateRange.to ?? null
    const start = cov.result?.coveredDateRange.from ?? null
    if (end && start) {
      for (let month = monthOf(end); month >= monthOf(start); month = previousMonth(month)) {
        const range = monthRange(month)
        if (covered(range)) {
          anchor = range
          break
        }
      }
    }
    if (!anchor) {
      sentences.push(cov.result === null
        ? 'There are no imports in this account yet, so there is no spending to compare.'
        : 'No complete calendar month is covered by the imports in this account, so I can’t compare two periods.')
      return { status: 'insufficient_data', sentences, routeHint: SCREENS.audits }
    }
    recent = anchor
    prior = monthRange(previousMonth(monthOf(anchor.from)))
  }

  const priorEnv = b.use(call('financial', () => spendSummary(ctx, deps.financial, { from: prior.from, to: prior.to }, now, spendOptions(run))))
  const recentEnv = b.use(call('financial', () => spendSummary(ctx, deps.financial, { from: recent.from, to: recent.to }, now, spendOptions(run))))
  const states = { prior: periodState(priorEnv), recent: periodState(recentEnv) }
  b.citeSources(recentEnv, 'import:')
  b.citeSources(priorEnv, 'import:')
  const notCovered = [states.prior === 'not_covered' ? prior : null, states.recent === 'not_covered' ? recent : null].filter((p): p is Period => p !== null)
  if (notCovered.length) {
    sentences.push(`I can’t compare ${prior.label} with ${recent.label}: ${notCovered.map((p) => p.label).join(' and ')} ${notCovered.length === 1 ? 'is' : 'are'} not covered by any import in this account.`)
    return { status: 'insufficient_data', sentences, routeHint: SCREENS.audits }
  }

  sentences.push(`Recorded payments in the covered records, ${prior.label} compared with ${recent.label}:`)
  const p = priorEnv.result!
  const r = recentEnv.result!
  const currencies = [...new Set([...p.byCurrency, ...r.byCurrency].map((l) => l.currency))].sort(cmp)
  const bothFull = states.prior === 'full' && states.recent === 'full'
  for (const currency of currencies) {
    const pl = p.byCurrency.find((l) => l.currency === currency)
    const rl = r.byCurrency.find((l) => l.currency === currency)
    const pm = { currency, amountMinor: pl?.grossPaymentsMinor ?? 0 }
    const rm = { currency, amountMinor: rl?.grossPaymentsMinor ?? 0 }
    b.figure('spend.gross_payments.prior_period', pm)
    b.figure('spend.gross_payments.recent_period', rm)
    let line = `${formatMoney(pm)} across ${plural(pl?.paymentCount ?? 0, 'payment')}, then ${formatMoney(rm)} across ${plural(rl?.paymentCount ?? 0, 'payment')}`
    if (bothFull) {
      const diff = { currency, amountMinor: rm.amountMinor - pm.amountMinor }
      b.figure('spend.gross_payments.difference', diff)
      line += diff.amountMinor === 0 ? ', no difference' : `, ${formatMoney({ currency, amountMinor: Math.abs(diff.amountMinor) })} ${diff.amountMinor > 0 ? 'higher' : 'lower'} in the later period`
    }
    sentences.push(`${line}.`)
  }
  const refundsPrior = p.recordedRefundsAndCredits
  const refundsRecent = r.recordedRefundsAndCredits
  if (refundsPrior.length || refundsRecent.length) {
    for (const m of refundsPrior) b.figure('spend.recorded_refunds_and_credits.prior_period', m)
    for (const m of refundsRecent) b.figure('spend.recorded_refunds_and_credits.recent_period', m)
    sentences.push(`Recorded refunds and credits are shown separately and not subtracted: ${formatMoneyList(refundsPrior)} then ${formatMoneyList(refundsRecent)}.`)
  }
  if (!bothFull) {
    sentences.push('Part of at least one period is outside every import’s date range, so no difference is stated.')
  } else {
    sentences.push(...vendorDifferences(run, prior, recent))
  }
  sentences.push('This shows what changed in the recorded payments, not why.')
  return { status: 'answered', sentences, routeHint: SCREENS.reports }
}

function vendorDifferences(run: Run, prior: Period, recent: Period): string[] {
  const { b, ctx, deps, now } = run
  const priorRows = b.use(call('financial', () => spendByVendor(ctx, deps.financial, { from: prior.from, to: prior.to }, now, { limit: 100 }, spendOptions(run))))
  const recentRows = b.use(call('financial', () => spendByVendor(ctx, deps.financial, { from: recent.from, to: recent.to }, now, { limit: 100 }, spendOptions(run))))
  if (!priorRows.result || !recentRows.result) return []
  if (priorRows.result.nextCursor !== null || recentRows.result.nextCursor !== null) {
    b.note('vendor_breakdown_truncated', 'There are too many vendors to compare individually here; open Reports for the full breakdown.')
    return []
  }
  const diffs = new Map<string, { vendorKey: string; currency: string; name: string; diff: number; ids: string[] }>()
  const add = (rows: typeof priorRows.result.rows, sign: 1 | -1) => {
    for (const row of rows) {
      const key = `${row.vendorKey}|${row.currency}`
      const entry = diffs.get(key) ?? { vendorKey: row.vendorKey, currency: row.currency, name: row.displayName, diff: 0, ids: [] }
      entry.diff += sign * row.grossPaymentsMinor
      if (sign === 1) entry.name = row.displayName
      entry.ids.push(...row.sourceRecordIds)
      diffs.set(key, entry)
    }
  }
  add(priorRows.result.rows, -1)
  add(recentRows.result.rows, 1)
  const top = [...diffs.values()].filter((d) => d.diff !== 0).sort((a, b2) => cmp(a.currency, b2.currency) || Math.abs(b2.diff) - Math.abs(a.diff) || cmp(a.vendorKey, b2.vendorKey))
  const byCurrency = new Map<string, typeof top>()
  for (const d of top) {
    const list = byCurrency.get(d.currency) ?? []
    if (list.length < 3) list.push(d)
    byCurrency.set(d.currency, list)
  }
  const parts: string[] = []
  for (const list of byCurrency.values()) {
    for (const d of list) {
      const money = { currency: d.currency, amountMinor: Math.abs(d.diff) }
      b.figure('spend.vendor_gross_payments.difference', { currency: d.currency, amountMinor: d.diff })
      parts.push(`${quoted(d.name)} ${formatMoney(money)} ${d.diff > 0 ? 'higher' : 'lower'}`)
      const ids = [...new Set(d.ids)].sort(cmp).slice(0, 5)
      b.allowRecordIds(ids)
      for (const id of ids) b.cite(`record:${id}`, 'Payment row')
    }
  }
  return parts.length ? [`Largest vendor differences: ${parts.join('; ')}.`] : []
}

function vendorRecentChange(run: Run, vendorKey: string, sentences: string[]): Section {
  const { b, ctx, deps, now } = run
  b.subjectUsed = true
  const env = b.use(call('vendor_profiles', () => vendorProfile(ctx, deps.financial, deps.cases, deps.memory, vendorKey, now)))
  const profile = env.result
  if (!profile) {
    sentences.push('This vendor is not in the covered records.')
    return { status: 'insufficient_data', sentences, routeHint: vendorScreen(vendorKey) }
  }
  sentences.push(`For ${quoted(profile.primaryName)}:`)
  sentences.push(...recentChangeSentences(profile, b))
  sentences.push('This shows what changed in the recorded payments, not why.')
  b.citeSources(env)
  return { status: 'answered', sentences, routeHint: vendorScreen(vendorKey) }
}

function recentChangeSentences(profile: VendorProfile, b: AnswerBuilder): string[] {
  const out: string[] = []
  for (const rc of profile.recentChange) {
    if (rc.status === 'computed' && rc.recentGrossMinor !== null && rc.priorGrossMinor !== null && rc.recentWindow && rc.priorWindow) {
      const prior = { currency: rc.currency, amountMinor: rc.priorGrossMinor }
      const recent = { currency: rc.currency, amountMinor: rc.recentGrossMinor }
      b.figure('vendor.recent_change.prior_window', prior)
      b.figure('vendor.recent_change.recent_window', recent)
      const diff = recent.amountMinor - prior.amountMinor
      out.push(`${periodLabel(rc.priorWindow)}: ${formatMoney(prior)} across ${plural(rc.priorPaymentCount ?? 0, 'payment')}; ${periodLabel(rc.recentWindow)}: ${formatMoney(recent)} across ${plural(rc.recentPaymentCount ?? 0, 'payment')}${diff === 0 ? ', no difference' : `, ${formatMoney({ currency: rc.currency, amountMinor: Math.abs(diff) })} ${diff > 0 ? 'higher' : 'lower'} in the later window`}.`)
    } else {
      out.push(`${rc.currency === UNKNOWN_CURRENCY ? 'In an unrecorded currency' : `In ${safeCurrency(rc.currency)}`}: there is not enough covered history to compare the last 90 days with the 90 days before.`)
    }
  }
  if (!out.length) out.push('There are no payments for this vendor to compare in the covered records.')
  return out
}

// ---------------------------------------------------------------- vendor context

function vendorContext(run: Run): Section {
  const { b, ctx, deps, now } = run
  const sentences = claimSentences(run)
  let vendorKey: string | null = null
  if (run.subject && 'vendorKey' in run.subject) {
    vendorKey = run.subject.vendorKey
    b.subjectUsed = true
  } else {
    const found = vendorInQuestion(run.question, vendorDirectory(run))
    if (found === 'ambiguous') {
      sentences.push('More than one vendor in this account matches that name. Open the vendor you mean and ask from there.')
      return { status: 'needs_clarification', sentences, routeHint: SCREENS.overview }
    }
    if (!found) {
      sentences.push('Which vendor? Name a vendor from this account or open it and ask from there.')
      return { status: 'needs_clarification', sentences, routeHint: SCREENS.overview }
    }
    vendorKey = found.vendorKey
  }
  const env = b.use(call('vendor_profiles', () => vendorProfile(ctx, deps.financial, deps.cases, deps.memory, vendorKey!, now)))
  const profile = env.result
  if (!profile) {
    sentences.push('This vendor is not in the covered records.')
    return { status: 'insufficient_data', sentences, routeHint: vendorScreen(vendorKey) }
  }
  b.allowCases(call('cases', () => deps.cases.listCases(ctx, now)))
  const period = profile.coveredPeriod.from && profile.coveredPeriod.to ? ` (payments dated ${periodLabel({ from: profile.coveredPeriod.from, to: profile.coveredPeriod.to })})` : ''
  sentences.push(`${quoted(profile.primaryName)} in the covered records${period}:`)
  const spendParts: string[] = []
  for (const s of profile.spend) {
    if (s.paymentCount > 0) {
      b.figure('vendor.gross_payments', { currency: s.currency, amountMinor: s.grossPaymentsMinor })
      spendParts.push(`${formatMoney({ currency: s.currency, amountMinor: s.grossPaymentsMinor })} across ${plural(s.paymentCount, 'payment')}`)
    }
  }
  sentences.push(spendParts.length ? `Recorded payments: ${spendParts.join('; ')}.` : 'No recorded payments.')
  const refunds = profile.spend.filter((s) => s.refundsAndCredits.count > 0)
  if (refunds.length) {
    for (const s of refunds) b.figure('vendor.refunds_and_credits_as_recorded', { currency: s.currency, amountMinor: s.refundsAndCredits.amountMinor })
    sentences.push(`Recorded refunds and credits, kept apart from payments: ${refunds.map((s) => `${formatMoney({ currency: s.currency, amountMinor: Math.abs(s.refundsAndCredits.amountMinor) })} (${plural(s.refundsAndCredits.count, 'row')})`).join('; ')}.`)
  }
  if (profile.recurringSeries.length) sentences.push(`${plural(profile.recurringSeries.length, 'recurring payment series', 'recurring payment series')} detected (recurring, not flagged).`)
  sentences.push(...recentChangeSentences(profile, b))
  const stages = Object.entries(profile.cases.byStage).filter(([, n]) => n > 0).sort((a, c) => cmp(a[0], c[0])).map(([stage, n]) => `${n} ${STAGE_LABELS[stage] ?? stage}`)
  sentences.push(profile.cases.caseCount ? `${plural(profile.cases.caseCount, 'case')}, each counted once across saved audits: ${stages.join(', ')}.` : 'No cases for this vendor in the covered records.')
  if (profile.cases.supportedPotentialInPlay.length) {
    for (const m of profile.cases.supportedPotentialInPlay) b.figure('vendor.supported_potential_in_play', m)
    sentences.push(`Supported potential on open cases: ${formatMoneyList(profile.cases.supportedPotentialInPlay)}.`)
  }
  if (profile.cases.customerRecordedReturn.length) {
    for (const m of profile.cases.customerRecordedReturn) b.figure('vendor.customer_recorded_returns', m)
    sentences.push(`Recorded by you as returned: ${formatMoneyList(profile.cases.customerRecordedReturn)} (recorded by the customer, not matched to a bank or accounting record).`)
  }
  sentences.push('Independently matched returns are not available yet.')
  const a = profile.aliases
  if (a.proposed.length || a.confirmedByCustomer.length || a.contradictions.length) {
    sentences.push(`Other names: ${a.proposed.length} proposed and not confirmed, ${a.confirmedByCustomer.length} confirmed by you and pending identity review${a.contradictions.length ? `, ${a.contradictions.length} with conflicting statements` : ''}. Names are never merged here.`)
  }
  if (profile.memory.inEffect.length) sentences.push(`${plural(profile.memory.inEffect.length, 'business-memory entry', 'business-memory entries')} from your team ${profile.memory.inEffect.length === 1 ? 'applies' : 'apply'} to this vendor.`)
  b.citeSources(env)
  for (const id of profile.cases.caseIds) b.cite(`case:${id}`, 'Case')
  return { status: 'answered', sentences, routeHint: vendorScreen(profile.vendorKey) }
}

// ---------------------------------------------------------------- insight explanation

function insightExplanation(run: Run, resolved: ResolvedSubject): Section {
  const { b, ctx, deps, now } = run
  const sentences = claimSentences(run)
  if (!deps.insightLookup) {
    sentences.push('Insight explanations are not available yet: the insights service is not connected to the assistant in this build.')
    return { status: 'unavailable', sentences }
  }
  if (!run.subject || !('insightId' in run.subject) || !resolved.insight) {
    sentences.push('Which insight? Open the insight and ask from there.')
    return { status: 'needs_clarification', sentences }
  }
  b.subjectUsed = true
  const insight = resolved.insight
  const universe = call('financial', () => citationUniverse(ctx, deps, now))
  const rule = /^[A-Za-z0-9_.:@-]{1,64}$/.test(insight.rule) ? insight.rule : null
  sentences.push(rule ? `This insight was raised by the rule ${rule}.` : 'This insight was raised by a rule this assistant does not recognise.')
  const figures = (insight.figures ?? []).filter((m) => m && typeof m.currency === 'string' && Number.isSafeInteger(m.amountMinor))
  if (figures.length) {
    for (const m of figures) b.figure('insight.figure', m)
    sentences.push(`Figures calculated by the rule: ${formatMoneyList(figures.map((m) => ({ currency: safeCurrency(m.currency), amountMinor: m.amountMinor })))}.`)
  }
  const limited = insight.coverage.filter((c) => c && c.status !== 'supported')
  for (const c of insight.coverage) {
    if (!c || typeof c.check !== 'string') continue
    b.extraCoverage.push({ model: 'insight', check: sanitizeDisplayName(c.check, 'insight', 64), status: c.status, reasons: (c.reasons ?? []).map((r) => reasonText(r).code) })
    for (const r of c.reasons ?? []) {
      const t = reasonText(r)
      b.note(t.code, t.text)
    }
  }
  sentences.push(limited.length ? `Its coverage is limited (${limited.length} of ${insight.coverage.length} checks); the reasons are listed below.` : 'Its checks report supported coverage for the covered records only.')
  const limitCodes = (insight.limits ?? []).filter((l) => typeof l === 'string')
  const known = limitCodes.filter((l) => REASON_TEXT[l] !== undefined)
  for (const l of known) b.note(l, REASON_TEXT[l])
  if (limitCodes.length > known.length) sentences.push(`${plural(limitCodes.length - known.length, 'further limit is', 'further limits are')} described on the insight itself.`)
  b.allowed.add(`insight:${insight.id}`)
  b.cite(`insight:${insight.id}`, 'Insight')
  const { valid, rejected } = validateCitations(insight.sourceRefs ?? [], universe)
  for (const ref of valid) {
    b.allowed.add(ref.id)
    b.cite(ref.id, ref.label)
  }
  sentences.push(`It cites ${plural(valid.length, 'source reference')} in this account.`)
  if (rejected.length) b.note('insight_references_dropped', `${plural(rejected.length, 'reference')} on the insight could not be matched to this account’s records and ${rejected.length === 1 ? 'is' : 'are'} not cited.`)
  sentences.push('The insight’s own wording is shown on the insight; this answer repeats only its rule, figures, coverage and sources.')
  return { status: 'answered', sentences, routeHint: insightScreen(insight.id) }
}

// ---------------------------------------------------------------- attention-based intents

function queueItems(run: Run): { items: AttentionItem[]; env: ReadModelEnvelope<unknown>; truncated: boolean } {
  const { b, ctx, deps, now } = run
  const env = b.use(call('cases', () => attentionQueue(ctx, deps.cases, now, { limit: 200 })))
  b.allowCases(call('cases', () => deps.cases.listCases(ctx, now)))
  const result = env.result
  return { items: result?.items ?? [], env, truncated: Boolean(result?.nextCursor) }
}

function itemName(item: AttentionItem): string {
  return `${quoted(item.vendor.displayName)} (${sanitizeDisplayName(item.statusLabel, 'see case')})`
}

function scopeItems(run: Run, items: AttentionItem[], resolved: ResolvedSubject): { items: AttentionItem[]; scope: string } {
  if (resolved.caseSnapshot) {
    run.b.subjectUsed = true
    const item = attentionItemFor(run.ctx, resolved.caseSnapshot, run.now)
    return { items: item ? [item] : [], scope: 'this case' }
  }
  if (run.subject && 'vendorKey' in run.subject) {
    run.b.subjectUsed = true
    const key = run.subject.vendorKey
    return { items: items.filter((i) => i.vendor.vendorKey === key), scope: 'this vendor' }
  }
  return { items, scope: 'the covered cases' }
}

function missingEvidence(run: Run, resolved: ResolvedSubject): Section {
  const { b } = run
  const sentences = claimSentences(run)
  const q = queueItems(run)
  const { items, scope } = scopeItems(run, q.items, resolved)
  const waiting = items.filter((i) => i.kind === 'missing_evidence')
  const unreviewed = items.filter((i) => i.kind === 'unreviewed_finding')
  if (waiting.length) {
    sentences.push(`${plural(waiting.length, 'case is', 'cases are')} waiting for information from you in ${scope}: ${waiting.slice(0, MAX_LISTED_ITEMS).map(itemName).join('; ')}${waiting.length > MAX_LISTED_ITEMS ? `; and ${waiting.length - MAX_LISTED_ITEMS} more` : ''}.`)
  } else {
    sentences.push(`No case in ${scope} is marked as waiting for information.`)
  }
  if (unreviewed.length) sentences.push(`${plural(unreviewed.length, 'check has', 'checks have')} not been reviewed yet, so ${unreviewed.length === 1 ? 'its' : 'their'} evidence has not been reviewed either.`)
  sentences.push('The specific evidence each case still needs is listed on its case page, where the case assistant can explain it.')
  if (q.truncated) b.note('attention_truncated', 'Only the first 200 items were read.')
  for (const i of [...waiting, ...unreviewed].slice(0, MAX_CITATIONS)) b.cite(`case:${i.caseId}`, 'Case')
  const single = resolved.caseSnapshot ? caseScreen(resolved.caseSnapshot.caseId) : waiting.length === 1 ? caseScreen(waiting[0].caseId) : SCREENS.findings
  return { status: 'answered', sentences, routeHint: single }
}

function amountPhrase(item: AttentionItem): string {
  const m = item.amount.money
  if (!m) return ''
  const label = item.amount.kind === 'supported_potential' ? 'supported potential' : item.amount.kind === 'approved_request' ? 'approved request' : item.amount.kind === 'promised' ? 'promised by the supplier, not money received' : 'outstanding'
  return `, ${formatMoney(m)} ${label}`
}

function approvalsPending(run: Run, resolved: ResolvedSubject): Section {
  const { b } = run
  const sentences = claimSentences(run)
  const q = queueItems(run)
  const { items, scope } = scopeItems(run, q.items, resolved)
  const approvals = items.filter((i) => i.category === 'requires_approval')
  const ready = items.filter((i) => i.kind === 'ready_to_send')
  const actions = items.filter((i) => i.category === 'requires_action')
  if (approvals.length) {
    sentences.push(`${plural(approvals.length, 'item is', 'items are')} waiting for your approval in ${scope}: ${approvals.slice(0, MAX_LISTED_ITEMS).map((i) => `${itemName(i)}${amountPhrase(i)}`).join('; ')}${approvals.length > MAX_LISTED_ITEMS ? `; and ${approvals.length - MAX_LISTED_ITEMS} more` : ''}.`)
    for (const i of approvals.slice(0, MAX_LISTED_ITEMS)) if (i.amount.money) b.figure(`attention.${i.amount.kind}`, i.amount.money)
  } else {
    sentences.push(`No item in ${scope} is waiting for approval.`)
  }
  if (ready.length) sentences.push(`${plural(ready.length, 'approved request has', 'approved requests have')} not been recorded as sent; whether ${ready.length === 1 ? 'it was' : 'they were'} actually sent is not visible here.`)
  const otherActions = actions.length - ready.length
  if (otherActions > 0) sentences.push(`${plural(otherActions, 'other item needs', 'other items need')} your action.`)
  sentences.push('Each approval is reviewed and confirmed on its own case; nothing is approved or sent from here.')
  if (q.truncated) b.note('attention_truncated', 'Only the first 200 items were read.')
  for (const i of [...approvals, ...actions].slice(0, MAX_CITATIONS)) b.cite(`case:${i.caseId}`, 'Case')
  return { status: 'answered', sentences, routeHint: resolved.caseSnapshot ? caseScreen(resolved.caseSnapshot.caseId) : SCREENS.overview }
}

// ---------------------------------------------------------------- coverage

function coverageAnswer(run: Run): Section {
  const { b, ctx, deps, now } = run
  const sentences = claimSentences(run)
  const env = b.use(call('financial', () => importCoverageSummary(ctx, deps.financial, now, spendOptions(run))))
  const r = env.result
  if (!r) {
    sentences.push('There are no imports in this account yet, so nothing has been checked. Import a payment file to start.')
    return { status: 'insufficient_data', sentences, routeHint: SCREENS.audits }
  }
  const range = r.coveredDateRange.from && r.coveredDateRange.to ? `, with payment dates from ${r.coveredDateRange.from} to ${r.coveredDateRange.to}` : ''
  sentences.push(`The covered records come from ${plural(r.importCount, 'import')} (${plural(r.acceptedRows, 'row')} accepted, ${r.rejectedRows} rejected)${range}.`)
  if (r.gaps.length) sentences.push(`Not covered between imports: ${r.gaps.slice(0, 5).map((g) => periodLabel(g)).join('; ')}${r.gaps.length > 5 ? `; and ${r.gaps.length - 5} more gaps` : ''}.`)
  if (r.undatedImportCount) sentences.push(`${plural(r.undatedImportCount, 'import has', 'imports have')} no dated rows, so ${r.undatedImportCount === 1 ? 'its' : 'their'} period is unknown.`)
  if (r.crossAuditOverlapRows) sentences.push(`${plural(r.crossAuditOverlapRows, 'row')} appeared in more than one saved audit and ${r.crossAuditOverlapRows === 1 ? 'was' : 'were'} counted once.`)
  if (r.newestImportAt !== null) sentences.push(`The newest import was saved on ${utcDate(r.newestImportAt)} (UTC).`)
  sentences.push('Only these records are checked; payments outside them are not covered by any answer.')
  b.citeSources(env, 'import:')
  return { status: 'answered', sentences, routeHint: SCREENS.audits }
}

// ---------------------------------------------------------------- definitions

const SPEND_DEFINITION = 'Spend means recorded AP payments in the covered records, dated by the payment date the source recorded; it is not total company expenses, cash flow or profitability, and settlement is not verified.'
const COVERAGE_DEFINITION = 'Coverage means the payment-date range of the imports in this account; a period outside it is reported as not covered, never as zero.'

const DEFINITION_KEYS: Array<[RegExp, keyof typeof RECOVERY_DEFINITIONS | 'spend' | 'net' | 'coverage']> = [
  [/\bflagged\b/, 'flaggedForReview'],
  [/\b(?:supported|potential)\b/, 'supportedPotential'],
  [/\b(?:approved|outstanding)\b/, 'approvedOutstanding'],
  [/\bpromis/, 'promised'],
  [/\b(?:customer[- ]recorded|recorded returns?|recorded by)\b/, 'customerRecordedReturns'],
  [/\bmatched\b/, 'matchedReturns'],
  [/\bpartial/, 'partialReturns'],
  [/\bclosed\b/, 'closedWithoutRecovery'],
  [/\b(?:my action|customer action|needing)\b/, 'needingCustomerAction'],
  [/\bnet\b/, 'net'],
  [/\b(?:spend|spending|payments?)\b/, 'spend'],
  [/\b(?:coverage|covered)\b/, 'coverage'],
]

function definitions(run: Run): Section {
  const lower = run.question.toLowerCase()
  const keys = [...new Set(DEFINITION_KEYS.filter(([re]) => re.test(lower)).map(([, k]) => k))]
  const text = (k: (typeof DEFINITION_KEYS)[number][1]): string => (k === 'spend' ? SPEND_DEFINITION : k === 'net' ? NET_UNAVAILABLE_REASON : k === 'coverage' ? COVERAGE_DEFINITION : RECOVERY_DEFINITIONS[k])
  const NAMES: Record<string, string> = {
    flaggedForReview: 'Flagged for review', supportedPotential: 'Supported potential', approvedOutstanding: 'Approved and outstanding', promised: 'Promised',
    customerRecordedReturns: 'Recorded by you as returned', matchedReturns: 'Matched returns', partialReturns: 'Partly returned', closedWithoutRecovery: 'Closed without recovery',
    needingCustomerAction: 'Needing your action', spend: 'Spend', net: 'Net spend', coverage: 'Coverage',
  }
  const chosen = keys.length ? keys : (['flaggedForReview', 'supportedPotential', 'approvedOutstanding', 'promised', 'customerRecordedReturns', 'matchedReturns', 'spend'] as const)
  const sentences = chosen.map((k) => `${NAMES[k]}: ${text(k)}`)
  sentences.push('These figures are kept apart and never added together.')
  run.b.cite(`definition:${RECOVERY_METRIC_VERSION}`, 'Recovery metric definitions')
  if (chosen.some((k) => k === 'spend' || k === 'net' || k === 'coverage')) run.b.cite(`definition:${SPEND_METRIC_VERSION}`, 'Spending metric definitions')
  return { status: 'answered', sentences }
}

// ---------------------------------------------------------------- action requests (proposals only)

const ACTION_RELEVANT: Record<AssistantActionKind, readonly AttentionKind[] | 'any'> = {
  approve: ['outbound_approval'],
  reject: ['outbound_approval', 'ready_to_send', 'unreviewed_finding', 'missing_evidence'],
  dismiss: ['unreviewed_finding', 'missing_evidence'],
  send_reminder: ['follow_up_due', 'follow_up_overdue', 'vendor_response_review', 'disputed_or_partial', 'verify_promised_return'],
  contact_vendor: ['outbound_approval', 'ready_to_send', 'follow_up_due', 'follow_up_overdue', 'vendor_response_review', 'disputed_or_partial'],
  start_recovery: ['unreviewed_finding', 'missing_evidence', 'outbound_approval', 'ready_to_send'],
  record_return: ['verify_promised_return', 'disputed_or_partial', 'record_in_books', 'follow_up_due', 'follow_up_overdue', 'vendor_response_review'],
  close_case: ['vendor_response_review', 'disputed_or_partial', 'follow_up_due', 'follow_up_overdue', 'verify_promised_return', 'internal_review'],
  investigate: 'any',
  unsupported_mutation: [],
}

/** Interactions that map onto an attention proposal (proposeApprovalAction). Everything else is done on the case page. */
const ACTION_INTERACTION: Partial<Record<AssistantActionKind, AttentionInteraction>> = { approve: 'approve', reject: 'reject', dismiss: 'reject' }

const ACTION_COMMANDS: Record<AssistantActionKind, CaseCommandType[]> = {
  approve: ['approve'],
  reject: ['contact_hold', 'decision'],
  dismiss: ['decision'],
  send_reminder: ['followup_sent', 'followup', 'followup_days'],
  contact_vendor: ['approve', 'request', 'email_sent', 'followup_sent'],
  start_recovery: ['decision', 'evidence', 'approve', 'approve_and_request'],
  record_return: ['settlement', 'vendor_update'],
  close_case: ['close'],
  investigate: [],
  unsupported_mutation: [],
}

const ACTION_PHRASE: Record<AssistantActionKind, string> = {
  approve: 'review the exact package and approve it on the case page',
  reject: 'give a reason on the case page',
  dismiss: 'give a reason and dismiss it on the case page',
  send_reminder: 'send the follow-up yourself from the case page, then record it there',
  contact_vendor: 'review and approve the exact email on the case page before anything is sent',
  start_recovery: 'review the evidence and approve a request on the case page',
  record_return: 'record a refund or credit on the case page only once it has arrived',
  close_case: 'close it from the case page with a reason',
  investigate: 'open the case and its evidence',
  unsupported_mutation: 'not available',
}

function proposalItem(run: Run, action: AssistantActionKind, caseId: string, vendorName: string, item: AttentionItem | null): ActionProposalItem {
  const interaction = ACTION_INTERACTION[action]
  let commandProposal: ApprovalActionProposal | null = null
  let refusal: ActionProposalItem['refusal'] = null
  if (!item) refusal = { code: 'not_available', detail: 'This case does not need anything from you right now.' }
  else if (interaction) {
    const result = proposeApprovalAction(run.ctx, item, interaction, { expectedRevision: item.revision })
    if (result.ok) commandProposal = result.proposal
    else refusal = result.error
  }
  const suggested = item ? ACTION_COMMANDS[action].filter((c) => item.resolvedBy.includes(c)) : []
  return {
    caseId,
    vendorDisplayName: sanitizeDisplayName(vendorName),
    attentionItemId: item?.id ?? null,
    attentionKind: item?.kind ?? null,
    targetService: commandProposal ? 'existing_case_command' : 'case_screen',
    route: CASE_COMMAND_ROUTE,
    commandProposal,
    refusal,
    suggestedCaseCommands: suggested,
    routeHint: caseScreen(caseId),
    requiresHumanApproval: true,
    executed: false,
  }
}

function itemPhrase(action: AssistantActionKind, p: ActionProposalItem, status: string): string {
  let suffix = ''
  if (p.refusal?.code === 'forbidden') suffix = ' (your role cannot do this step)'
  else if (p.refusal || (action !== 'investigate' && p.suggestedCaseCommands.length === 0)) suffix = ' (not available for this case in its current state)'
  return `${quoted(p.vendorDisplayName)} (${status}): ${ACTION_PHRASE[action]}${suffix}`
}

function actionRequest(run: Run, resolved: ResolvedSubject): Section {
  const { b } = run
  const action = run.route.action ?? 'investigate'
  const sentences: string[] = ['Nothing has been sent, approved or changed: the assistant only prepares proposals for you to review.']
  if (action === 'unsupported_mutation') {
    sentences.push('The assistant cannot pay, transfer, delete, edit or write off anything, and it does not propose those actions. Case changes happen on the case page.')
    return { status: 'answered', sentences, routeHint: SCREENS.recoveries }
  }
  const relevant = ACTION_RELEVANT[action]
  const matches = (i: AttentionItem) => relevant === 'any' || relevant.includes(i.kind)

  if (resolved.caseSnapshot) {
    b.subjectUsed = true
    const snap = resolved.caseSnapshot
    b.allowCases([snap])
    b.use(call('cases', () => attentionQueue(run.ctx, run.deps.cases, run.now, { limit: 1 })))
    const item = attentionItemFor(run.ctx, snap, run.now)
    const p = proposalItem(run, action, snap.caseId, snap.vendor.displayName, item && matches(item) ? item : null)
    if (item && !matches(item)) p.refusal = { code: 'not_available', detail: 'That step does not apply to this case in its current state.' }
    sentences.push(`Proposal: ${itemPhrase(action, p, sanitizeDisplayName(snap.statusLabel, 'see case'))}.`)
    sentences.push('A person must review and confirm it on the case page.')
    b.cite(`case:${snap.caseId}`, 'Case')
    return { status: 'answered', sentences, proposal: proposalOf(action, run.route.bulk, [p], 1), routeHint: caseScreen(snap.caseId) }
  }

  const q = queueItems(run)
  let vendorKey: string | null = run.subject && 'vendorKey' in run.subject ? run.subject.vendorKey : null
  if (vendorKey) b.subjectUsed = true
  else {
    const found = vendorInQuestion(run.question, vendorDirectory(run))
    if (found === 'ambiguous') {
      sentences.push('More than one vendor in this account matches that name. Open the case you mean and ask from there.')
      return { status: 'needs_clarification', sentences, routeHint: SCREENS.recoveries }
    }
    vendorKey = found?.vendorKey ?? null
  }
  const candidates = q.items.filter((i) => matches(i) && (vendorKey === null || i.vendor.vendorKey === vendorKey))
  if (vendorKey === null && !run.route.bulk) {
    sentences.push(candidates.length
      ? `Which case? ${plural(candidates.length, 'case')} could fit: ${candidates.slice(0, 5).map(itemName).join('; ')}${candidates.length > 5 ? '; and more' : ''}. Open the case and ask from there.`
      : 'Which case? Open the case and ask from there, or name the vendor.')
    for (const i of candidates.slice(0, 5)) b.cite(`case:${i.caseId}`, 'Case')
    return { status: 'needs_clarification', sentences, routeHint: SCREENS.recoveries }
  }
  if (!candidates.length) {
    sentences.push(`No case in the covered cases${vendorKey ? ' for that vendor' : ''} fits that request right now.`)
    return { status: 'needs_clarification', sentences, routeHint: vendorKey ? vendorScreen(vendorKey) : SCREENS.recoveries }
  }
  if (run.route.bulk) sentences.push('Doing this in bulk is not supported: each item below needs its own review and approval.')
  const items = candidates.slice(0, MAX_PROPOSAL_ITEMS).map((i) => proposalItem(run, action, i.caseId, i.vendor.displayName, i))
  sentences.push(`${plural(candidates.length, 'case')} could fit${candidates.length > MAX_PROPOSAL_ITEMS ? `; the first ${MAX_PROPOSAL_ITEMS} are listed` : ''}: ${items.map((p, n) => itemPhrase(action, p, sanitizeDisplayName(candidates[n].statusLabel, 'see case'))).join('; ')}.`)
  sentences.push('Each proposal needs a person to review and confirm it on its case page.')
  for (const p of items) b.cite(`case:${p.caseId}`, 'Case')
  return { status: 'answered', sentences, proposal: proposalOf(action, run.route.bulk, items, candidates.length), routeHint: items.length === 1 ? items[0].routeHint : SCREENS.recoveries }
}

function proposalOf(action: AssistantActionKind, bulk: boolean, items: ActionProposalItem[], total: number): ActionProposal {
  return {
    kind: 'assistant_action_proposal',
    requestedAction: action,
    bulkRequested: bulk,
    bulkExecutionSupported: false,
    items,
    totalCandidates: total,
    requiresHumanApproval: true,
    perItemApprovalRequired: true,
    executed: false,
    sideEffects: 'none',
  }
}

// ---------------------------------------------------------------- unsupported

const CAPABILITIES = 'I can answer: where recoveries stand, what changed in recorded spending, what the records say about a vendor, why an insight was raised, which cases need evidence, what is waiting for your approval, which records are covered, and what a figure means. I can also prepare a proposal for an action, which you then review on the case page.'

function unsupported(): Section {
  return { status: 'needs_clarification', sentences: ['I didn’t recognise that question.', CAPABILITIES] }
}

// ---------------------------------------------------------------- optional AI interpretation

interface AiInterpretation {
  intent: AccountIntentId | null
  invocationId: string | null
  note: { code: string; text: string } | null
}

/**
 * Asks the gateway to map an unmatched question onto one registry intent id.
 * Packet: the question text and the selectable intent ids only. The returned
 * text must be exactly one of those ids; anything else is discarded.
 */
async function interpretWithAi(ctx: TenantContext, ai: AiGatewayPort | undefined, question: string): Promise<AiInterpretation> {
  const none: AiInterpretation = { intent: null, invocationId: null, note: null }
  if (!ai || !ai.enabled) return none
  let policy: string
  try {
    policy = ai.policy(ctx)
  } catch {
    return { ...none, note: { code: 'ai_interpretation_unavailable', text: 'Free-text interpretation is unavailable; only the fixed question types were used.' } }
  }
  if (policy === 'off') return none
  const request: AiTaskRequest = { task: 'interpret_question', packet: { question, intents: [...AI_SELECTABLE_INTENTS] }, allowedCitations: [] }
  let result: Awaited<ReturnType<AiGatewayPort['run']>>
  try {
    result = await ai.run(ctx, request)
  } catch {
    return { ...none, note: { code: 'ai_interpretation_unavailable', text: 'Free-text interpretation is unavailable; only the fixed question types were used.' } }
  }
  if (result.status !== 'ok') return { ...none, note: { code: 'ai_interpretation_unavailable', text: 'Free-text interpretation is unavailable; only the fixed question types were used.' } }
  const chosen = typeof result.text === 'string' ? result.text.trim() : ''
  if (!(AI_SELECTABLE_INTENTS as readonly string[]).includes(chosen)) {
    return { ...none, note: { code: 'ai_interpretation_rejected', text: 'The free-text interpretation did not name a supported question type and was ignored.' } }
  }
  const invocationId = typeof result.invocationId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(result.invocationId) ? result.invocationId : null
  return { intent: chosen as AccountIntentId, invocationId, note: { code: 'ai_interpreted_question', text: 'Your question was matched to a question type by the optional interpretation service; the answer and figures are computed by code.' } }
}

// ---------------------------------------------------------------- assembly

const INTENT_PERMISSIONS: Record<AccountIntentId, Permission[]> = Object.fromEntries(INTENT_REGISTRY.map((i) => [i.id, i.permissions])) as Record<AccountIntentId, Permission[]>

const PERMISSION_TEXT: Record<string, string> = {
  'financial:read': 'payment records',
  'cases:read': 'recovery cases',
}

function inferFromSubject(subject: AssistantSubject | null): AccountIntentId | null {
  if (!subject) return null
  if ('vendorKey' in subject) return 'vendor_context'
  if ('insightId' in subject) return 'insight_explanation'
  if ('caseId' in subject) return 'recovery_status'
  return 'spend_change'
}

function assemble(run: Run, intent: AccountIntentId | 'unsupported', section: Section, interpretation: AccountAnswer['interpretation'], aiUsed: boolean, error: AccountAnswer['error'] = null): AccountAnswer {
  const { b } = run
  const coverageItems: AnswerCoverageItem[] = []
  const seenCoverage = new Set<string>()
  for (const env of b.envelopes) {
    for (const c of env.coverage) {
      const key = `${env.model}|${c.check}|${c.status}|${c.reasons.join(',')}`
      if (seenCoverage.has(key)) continue
      seenCoverage.add(key)
      coverageItems.push({ model: env.model, check: c.check, status: c.status, reasons: [...c.reasons] })
      for (const r of c.reasons) {
        const t = reasonText(r)
        b.note(t.code, t.text)
      }
    }
    for (const w of env.warnings) if (WARNING_TEXT[w.code]) b.note(w.code, WARNING_TEXT[w.code])
  }
  coverageItems.push(...b.extraCoverage)
  const stale = b.envelopes.some((e) => e.freshness.stale)
  if (stale) b.note('stale_source', 'The newest source data behind this answer is old; newer activity may not be reflected.')
  if (run.route.instructionLike) b.note('instruction_like_text_ignored', 'Parts of your question looked like instructions or identifiers. The assistant follows only its fixed question types and answers from this account’s records only.')
  if (run.route.statesAmount) b.note('user_figure_not_confirmed', 'Amounts stated in a question are never used or confirmed. Only figures computed from the covered records are shown, and none of them is an amount a supplier owes.')
  if (run.subject && !b.subjectUsed) b.note('subject_not_applied', 'The selected item was not used for this kind of question.')
  const sourceTimes = b.envelopes.map((e) => e.freshness.sourceUpdatedAt).filter((t): t is number => t !== null)
  const { valid } = validateCitations(b.citations, b.allowed)
  const models: AccountAnswer['models'] = []
  const seenModels = new Set<string>()
  for (const e of b.envelopes) {
    const key = `${e.model}|${e.metricDefinitionVersion}`
    if (seenModels.has(key)) continue
    seenModels.add(key)
    models.push({ model: e.model, metricDefinitionVersion: e.metricDefinitionVersion, origin: e.origin })
  }
  if (valid.length > MAX_CITATIONS) b.note('citations_truncated', `${valid.length - MAX_CITATIONS} further sources are not listed.`)
  return {
    version: ACCOUNT_ASSISTANT_VERSION,
    contractVersion: INTELLIGENCE_CONTRACT_VERSION,
    tenantId: run.ctx.tenantId,
    intent,
    status: section.status,
    answer: section.sentences.join(' '),
    figures: b.figures,
    citations: valid.slice(0, MAX_CITATIONS),
    coverage: coverageItems,
    asOf: { computedAt: run.now, sourceUpdatedAt: sourceTimes.length ? Math.max(...sourceTimes) : null, stale },
    models,
    uncertainty: [...b.notes].map(([code, text]) => ({ code, text })),
    proposal: section.proposal ?? null,
    routeHint: section.routeHint ?? null,
    interpretation,
    error,
    aiUsed,
    answerSource: 'deterministic_templates',
    retention: 'not_persisted',
  }
}

function answerIntent(run: Run, intent: AccountIntentId, resolved: ResolvedSubject): Section {
  switch (intent) {
    case 'recovery_status': return recoveryStatus(run, resolved)
    case 'spend_change': return spendChange(run)
    case 'vendor_context': return vendorContext(run)
    case 'insight_explanation': return insightExplanation(run, resolved)
    case 'missing_evidence': return missingEvidence(run, resolved)
    case 'approvals_pending': return approvalsPending(run, resolved)
    case 'coverage': return coverageAnswer(run)
    case 'definitions': return definitions(run)
    case 'investigation_or_action_request': return actionRequest(run, resolved)
  }
}

/**
 * Answer one account-level question. Read-only and deterministic for a given
 * input and `now` (with the AI gateway disabled, which is the default).
 *
 * Throws IntelligenceAccessError without `assistant:ask` or for another
 * tenant's ports, and AssistantRequestError for a malformed question or
 * subject, or a subject not in this account (`not_found`). An unavailable
 * dependency yields an answer with status `unavailable`, never a throw.
 * Nothing is persisted.
 */
export async function askAccount(ctx: TenantContext, deps: AccountAssistantDeps, question: unknown, now: number, options: AskOptions = {}): Promise<AccountAnswer> {
  requirePermission(ctx, 'assistant:ask')
  const text = validateQuestion(question)
  const subject = validateSubject(options.subject)
  const run: Run = { ctx, deps, now, options, subject, question: text, route: routeQuestion(text), b: new AnswerBuilder() }
  const deterministic = { method: 'deterministic' as const, aiInvocationId: null }
  try {
    const resolved = resolveSubject(run)
    let intent: AccountIntentId | null = run.route.intent
    let interpretation: AccountAnswer['interpretation'] = deterministic
    let aiUsed = false
    if (!intent && hasPermission(ctx, 'cases:read')) {
      // A vendor of this tenant named in the question, with no other cue.
      const found = vendorInQuestion(text, vendorDirectory(run))
      if (found && found !== 'ambiguous') intent = 'vendor_context'
    }
    if (!intent) {
      intent = inferFromSubject(subject)
      if (intent) interpretation = { method: 'subject', aiInvocationId: null }
    }
    if (!intent) {
      const ai = await interpretWithAi(ctx, deps.ai, text)
      if (ai.note) run.b.note(ai.note.code, ai.note.text)
      if (ai.intent) {
        intent = ai.intent
        interpretation = { method: 'ai_intent_mapping', aiInvocationId: ai.invocationId }
        aiUsed = true
      }
    }
    if (!intent) return assemble(run, 'unsupported', unsupported(), { method: 'none', aiInvocationId: null }, false)
    const missing = INTENT_PERMISSIONS[intent].filter((p) => !hasPermission(ctx, p))
    if (missing.length) {
      return assemble(run, intent, { status: 'not_permitted', sentences: [`Your account role does not include access to ${missing.map((p) => PERMISSION_TEXT[p] ?? p).join(' and ')}, so I can’t answer this.`] }, interpretation, aiUsed)
    }
    return assemble(run, intent, answerIntent(run, intent, resolved), interpretation, aiUsed)
  } catch (error) {
    if (!(error instanceof DependencyUnavailable)) throw error
    const fresh: Run = { ...run, b: new AnswerBuilder() }
    return assemble(
      fresh,
      run.route.intent ?? 'unsupported',
      { status: 'unavailable', sentences: ['I can’t answer right now: a service this answer depends on is unavailable. Nothing was changed. Try again later or open the relevant screen.'] },
      deterministic,
      false,
      { code: 'dependency_unavailable', dependency: error.dependency },
    )
  }
}

