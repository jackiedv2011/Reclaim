/**
 * Rules-first proactive insights (CPO workstream P3), version `insights-v0.1`.
 *
 * Every insight is a pure, deterministic function of read-model envelopes
 * this workstream already ships (spend, baselines, vendor profiles, recovery
 * visibility, attention, business memory). Nothing here recomputes a money
 * figure: an amount on an insight is copied from a read model and cites it.
 *
 * Wording rules (docs/product-intelligence/insight-catalog.md): an insight
 * describes "the covered records". It never asserts a cause, a debt, a
 * verification or a clean result. When the checks are limited and nothing
 * else applies, the engine emits coverage insights, never an "all clear".
 *
 * Optional AI: with an enabled gateway and a tenant policy other than 'off',
 * an advisory summary may be attached to an insight, validated against the
 * minimal packet it was built from. The deterministic title, explanation and
 * figures are always present and always authoritative. The default gateway
 * is disabled and nothing changes.
 *
 * Read-only: no writes to financial records, cases or memory. The dismiss
 * store holds only per-tenant insight dismissals (in memory; persistence is
 * interface request S-7). Server-safe: relative `.ts` imports only.
 */
import {
  COVERAGE_REASONS,
  INTELLIGENCE_CONTRACT_VERSION,
  UNKNOWN_CURRENCY,
  type CaseReadPort,
  type CaseSnapshot,
  type CoverageItem,
  type DataOrigin,
  type FinancialSourcePort,
  type Freshness,
  type MoneyAmount,
  type ReadModelEnvelope,
  type RecurringSeriesView,
  type ReturnMatchPort,
  type SourceRecord,
  type SourceRef,
  type TenantContext,
  type Warning,
} from './contracts.ts'
import { coverage, envelope, requirePermission, requireTenant, stableHash } from './envelope.ts'
import { BASELINE_VERSION, compareToBaseline, daysBetweenDates, vendorBaselines, type VendorBaseline } from './baselines.ts'
import { IntelligenceQueryError, SPEND_METRIC_VERSION, compareText, importCoverageSummary, spendByVendor, spendSummary, type VendorSpendRow } from './spend.ts'
import { RECOVERY_METRIC_VERSION, caseContributions, foldCases, recoveryOverview } from './recoveryVisibility.ts'
import { RECENT_WINDOW_DAYS, VENDOR_PROFILE_VERSION, vendorProfiles, type VendorProfile } from './vendorProfiles.ts'
import { MEMORY_VERSION, influenceFor, type FeedbackStore, type InfluenceTarget } from './memory.ts'
import { ATTENTION_METRIC_VERSION, OVERDUE_GRACE_DAYS, attentionQueue, type AttentionCategory, type AttentionItem, type AttentionKind } from './attention.ts'
import { rejectUnsupportedAiText, type AiGatewayPort, type AiTaskRequest } from './aiGateway.ts'

export const INSIGHTS_VERSION = 'insights-v0.1'
export const INSIGHTS_MODEL = 'insights'

const DAY_MS = 86_400_000

// ---------------------------------------------------------------- catalog and thresholds

export type InsightRule =
  | 'vendor_spend_above_baseline'
  | 'recurring_payment_visible'
  | 'vendor_concentration'
  | 'vendor_change'
  | 'import_coverage_gap'
  | 'unresolved_recovery'
  | 'approvals_due'
  | 'follow_ups_due'
  | 'prevention_guidance'

export interface InsightRuleDefinition {
  version: number
  /** Lower runs first among insights of equal severity. */
  priority: number
  /** Static, data-free description (also the only rule text an AI packet may carry). */
  description: string
}

/** The rule catalog. Changing a rule's meaning bumps its version (and the catalog doc). */
export const INSIGHT_RULES: Readonly<Record<InsightRule, InsightRuleDefinition>> = {
  approvals_due: { version: 1, priority: 1, description: 'Supplier requests waiting for the customer to review and approve, from the attention queue.' },
  follow_ups_due: { version: 1, priority: 2, description: 'Supplier follow-ups that reached their date, from the attention queue.' },
  unresolved_recovery: { version: 1, priority: 3, description: 'Open supplier requests that are aging, disputed or partly returned, from case snapshots.' },
  import_coverage_gap: { version: 1, priority: 4, description: 'Periods, rows or saved audits that the covered records do not include, or covered records that are out of date.' },
  vendor_spend_above_baseline: { version: 1, priority: 5, description: "Recent payments above a vendor's established range in the covered records." },
  vendor_change: { version: 1, priority: 6, description: 'A vendor whose covered payments in the latest 90 days differ from the 90 days before.' },
  prevention_guidance: { version: 1, priority: 7, description: 'Static prevention suggestions keyed to recorded root causes and repeated dismissals.' },
  vendor_concentration: { version: 1, priority: 8, description: 'One vendor holding a large share of covered payments in a currency.' },
  recurring_payment_visible: { version: 1, priority: 9, description: 'A recurring payment pattern the detector does not flag, shown for visibility.' },
}

export const INSIGHT_RULE_IDS = Object.keys(INSIGHT_RULES).sort() as InsightRule[]

/** vendor_spend_above_baseline: payments dated within this many days up to the newest covered date are compared. */
export const ABOVE_BASELINE_LOOKBACK_DAYS = 60
/** ...medium when the highest above-range payment is at least this ratio of the median (20000 bps = 2x). */
export const ABOVE_BASELINE_MEDIUM_RATIO_BPS = 20000
/** vendor_concentration: one vendor's share of a currency's covered gross that triggers the insight. */
export const CONCENTRATION_SHARE_BPS = 4000
/** ...only when that currency has at least this many vendors (one vendor is trivially 100%). */
export const CONCENTRATION_MIN_VENDORS = 3
/** vendor_change: absolute change between the two 90-day windows that triggers the insight. */
export const VENDOR_CHANGE_THRESHOLD_BPS = 5000
/** ...medium when the latest window is at least this much higher (10000 bps = doubled). */
export const VENDOR_CHANGE_MEDIUM_BPS = 10000
/** ...and the prior window must hold at least this many payments. */
export const VENDOR_CHANGE_MIN_PRIOR_PAYMENTS = 2
/** import_coverage_gap: a gap between covered spans this long or longer is medium. */
export const COVERAGE_GAP_MEDIUM_DAYS = 31
/** ...rejected rows at or above this share of an import's rows are medium. */
export const REJECTED_ROWS_MEDIUM_BPS = 500
/** unresolved_recovery: a request older than this (days) with money still open triggers the insight. */
export const UNRESOLVED_AGE_DAYS = 30
/** ...high when older than this. */
export const UNRESOLVED_HIGH_AGE_DAYS = 60
/** approvals_due: high when at least this many approvals are waiting. */
export const APPROVALS_HIGH_COUNT = 5
/** prevention_guidance: reconciled cases with a recorded root cause needed per finding type. */
export const PREVENTION_MIN_ROOT_CAUSES = 1
/** ...dismissals with the same finding type and tag needed. */
export const PREVENTION_MIN_REPEATED_DISMISSALS = 3

/** Days after the evidence's own date before a data-anchored insight is `expired` (historical, not current monitoring). */
export const INSIGHT_TTL_DAYS: Readonly<Record<InsightRule, number | null>> = {
  vendor_spend_above_baseline: 120,
  recurring_payment_visible: 120,
  vendor_concentration: 120,
  vendor_change: 120,
  prevention_guidance: 365,
  // Condition-based: active while the condition holds at `now`.
  import_coverage_gap: null,
  unresolved_recovery: null,
  approvals_due: null,
  follow_ups_due: null,
}

export const DEFAULT_INSIGHT_LIMIT = 25
export const MAX_INSIGHT_LIMIT = 200
export const MAX_INSIGHT_SOURCE_REFS = 50
/** Bounded reads of paged inputs. */
const MAX_INPUT_PAGES = 20
export const DISMISSAL_DEFAULT_TTL_DAYS = 90
export const DISMISSAL_MAX_TTL_DAYS = 365
export const MAX_DISMISS_REASON_LENGTH = 500
/** At most this many AI summaries are requested per call (only for returned, active items). */
export const AI_MAX_SUMMARIES_PER_CALL = 10

/** Reason codes this module adds (string literals; not yet in COVERAGE_REASONS). */
export const INSIGHT_REASONS = {
  /** A paged input read stopped at its bound; later pages were not considered. */
  INPUT_TRUNCATED: 'insight_input_truncated',
} as const

// ---------------------------------------------------------------- types

export type InsightSeverity = 'high' | 'medium' | 'low'
export type InsightStatus = 'active' | 'dismissed' | 'expired'

export type InsightSubject =
  | { type: 'vendor'; vendorKey: string; displayName: string }
  | { type: 'case'; caseId: string; vendorKey: string }
  | { type: 'import'; importId: string; auditId: string }
  | { type: 'account'; account: true }

export interface InsightFigure {
  label: string
  money: MoneyAmount
  /** The read model (or port) the amount was copied from. Insights never compute money. */
  source: { model: string; field: string; metricDefinitionVersion: string }
}

export interface InsightMeasure {
  label: string
  value: number
  unit: 'count' | 'days' | 'bps'
  source: { model: string; field: string; metricDefinitionVersion: string }
}

export type InsightNextAction =
  | { kind: 'review_vendor'; target: { vendorKey: string }; label: string; sideEffects: 'none' }
  | { kind: 'open_case'; target: { caseId: string }; label: string; sideEffects: 'none' }
  | { kind: 'open_attention'; target: { category: AttentionCategory | null; kinds: AttentionKind[] }; label: string; sideEffects: 'none' }
  | { kind: 'request_records'; target: { from: string | null; to: string | null }; label: string; sideEffects: 'none' }
  | { kind: 'review_import_coverage'; target: { importId: string | null; auditIds: string[] }; label: string; sideEffects: 'none' }
  | { kind: 'review_finding'; target: { caseId: string }; label: string; sideEffects: 'none' }
  | { kind: 'review_prevention'; target: { findingType: string }; label: string; sideEffects: 'none' }

export interface InsightProvenance {
  insightsVersion: typeof INSIGHTS_VERSION
  contractVersion: typeof INTELLIGENCE_CONTRACT_VERSION
  origin: DataOrigin
  readModels: Array<{ model: string; metricDefinitionVersion: string }>
}

export interface AdvisorySummary {
  text: string
  citations: string[]
  model: string
  invocationId: string
  task: 'summarize_insight'
  /** Advisory only: validated against the packet; the deterministic fields stay authoritative. */
  provenance: 'ai_gateway_advisory'
}

export interface Insight {
  /** `ins_<rule>_<hash(tenant|dedupKey)>`: stable across refreshes while rule, subject and period are the same. */
  id: string
  /** `<rule>|<subject>|<period>`: what a dismissal is keyed by. */
  dedupKey: string
  tenantId: string
  rule: InsightRule
  ruleVersion: string
  insightsVersion: typeof INSIGHTS_VERSION
  severity: InsightSeverity
  severityReason: string
  title: string
  explanation: string
  /** One sentence: what this insight does NOT show. */
  limits: string
  subject: InsightSubject
  period: { from: string | null; to: string | null; dataAsOf: string | null; computedAt: number }
  figures: InsightFigure[]
  measures: InsightMeasure[]
  sourceRefs: SourceRef[]
  sourceRefCount: number
  sourceRefsTruncated: boolean
  coverage: CoverageItem[]
  freshness: Freshness
  provenance: InsightProvenance
  nextAction: InsightNextAction
  /** In-effect business-memory entry IDs touching the subject (memory.influenceFor). */
  influencedBy: string[]
  /** Hash of the evidence the insight rests on. A different fingerprint invalidates a dismissal. */
  evidenceFingerprint: string
  status: InsightStatus
  /** When a data-anchored insight becomes historical; null for condition-based insights. */
  expiresAt: number | null
  dismissal: { dismissedAt: number; dismissedBy: string; reason: string; expiresAt: number } | null
  /** A dismissal that no longer applies, and why. */
  previousDismissal: { dismissedAt: number; invalidatedBecause: 'evidence_changed' | 'dismissal_expired' } | null
  advisorySummary: AdvisorySummary | null
  ai: { status: 'not_requested' | 'attached' | 'rejected' | 'unavailable'; reason: string | null }
}

export interface InsightsResult {
  items: Insight[]
  nextCursor: string | null
  /** Items after status filtering, across all pages. */
  total: number
  countsByRule: Record<InsightRule, number>
  countsBySeverity: Record<InsightSeverity, number>
  countsByStatus: Record<InsightStatus, number>
  /** Insights hidden because a person dismissed them and the evidence has not changed. */
  suppressedByDismissal: number
  aiSummaries: 'disabled' | 'policy_off' | 'requested'
  aiOutcomes: { attached: number; rejected: number; unavailable: number }
  /** Never an "all clear": why the list is empty, if it is. */
  emptyState: 'no_data' | 'none_met_thresholds_in_covered_records' | null
}

export interface InsightDeps {
  financial: FinancialSourcePort
  cases: CaseReadPort
  returns: ReturnMatchPort
  memory: FeedbackStore
  insightState: InsightStateStore
  ai?: AiGatewayPort
}

export interface GenerateInsightsOptions {
  limit?: number
  /** Opaque: the `nextCursor` of the previous page. */
  cursor?: string | null
  /** Default false: dismissed insights are counted in `suppressedByDismissal` but not listed. */
  includeDismissed?: boolean
  /** Default true: expired (historical) insights are listed after active ones, labelled. */
  includeExpired?: boolean
  /** Saved audits the caller could not read (LegacyAuditSource.unreadableAuditIds). Always surfaced. */
  unreadableAuditIds?: string[]
  staleAfterMs?: number
}

// ---------------------------------------------------------------- dismiss state

export interface InsightDismissal {
  tenantId: string
  dedupKey: string
  insightId: string
  evidenceFingerprint: string
  reason: string
  dismissedAt: number
  dismissedBy: string
  expiresAt: number
}

export class InsightStateError extends Error {
  readonly code: 'not_found' | 'invalid_input'
  constructor(code: InsightStateError['code'], message: string) {
    super(message)
    this.code = code
  }
}

/**
 * Per-tenant dismissals, keyed by dedupKey. A dismissal hides an insight only
 * while the insight's evidence fingerprint is unchanged and the dismissal has
 * not expired. Writes need `feedback:write`; reads need `financial:read`.
 */
export interface InsightStateStore {
  dismiss(ctx: TenantContext, insight: Pick<Insight, 'id' | 'dedupKey' | 'evidenceFingerprint'>, reason: string, now: number, options?: { ttlDays?: number }): InsightDismissal
  undismiss(ctx: TenantContext, dedupKey: string): boolean
  get(ctx: TenantContext, dedupKey: string): InsightDismissal | null
  list(ctx: TenantContext): InsightDismissal[]
}

function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return true
  }
  return false
}

/** Reference implementation: tenant-partitioned, process-local, not durable. */
export class InMemoryInsightStateStore implements InsightStateStore {
  private readonly partitions = new Map<string, Map<string, InsightDismissal>>()

  private partition(tenantId: string): Map<string, InsightDismissal> {
    let p = this.partitions.get(tenantId)
    if (!p) {
      p = new Map()
      this.partitions.set(tenantId, p)
    }
    return p
  }

  dismiss(ctx: TenantContext, insight: Pick<Insight, 'id' | 'dedupKey' | 'evidenceFingerprint'>, reason: string, now: number, options: { ttlDays?: number } = {}): InsightDismissal {
    requirePermission(ctx, 'feedback:write')
    const text = typeof reason === 'string' ? reason.trim() : ''
    if (!text || text.length > MAX_DISMISS_REASON_LENGTH || hasControlChars(text)) throw new InsightStateError('invalid_input', `A reason of 1 to ${MAX_DISMISS_REASON_LENGTH} characters is required.`)
    const ttlDays = options.ttlDays ?? DISMISSAL_DEFAULT_TTL_DAYS
    if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > DISMISSAL_MAX_TTL_DAYS) throw new InsightStateError('invalid_input', `ttlDays must be an integer from 1 to ${DISMISSAL_MAX_TTL_DAYS}.`)
    const record: InsightDismissal = {
      tenantId: ctx.tenantId,
      dedupKey: insight.dedupKey,
      insightId: insight.id,
      evidenceFingerprint: insight.evidenceFingerprint,
      reason: text,
      dismissedAt: now,
      dismissedBy: ctx.actorId,
      expiresAt: now + ttlDays * DAY_MS,
    }
    this.partition(ctx.tenantId).set(insight.dedupKey, record)
    return { ...record }
  }

  undismiss(ctx: TenantContext, dedupKey: string): boolean {
    requirePermission(ctx, 'feedback:write')
    return this.partition(ctx.tenantId).delete(dedupKey)
  }

  get(ctx: TenantContext, dedupKey: string): InsightDismissal | null {
    requirePermission(ctx, 'financial:read')
    const r = this.partition(ctx.tenantId).get(dedupKey)
    return r ? { ...r } : null
  }

  list(ctx: TenantContext): InsightDismissal[] {
    requirePermission(ctx, 'financial:read')
    return [...this.partition(ctx.tenantId).values()].map((r) => ({ ...r })).sort((a, b) => compareText(a.dedupKey, b.dedupKey))
  }
}

// ---------------------------------------------------------------- text helpers

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** `USD 4,980.00`. Minor units are hundredths for every currency (the adapter's toMinor). Locale-independent. */
export function formatMoney(m: MoneyAmount): string {
  const negative = m.amountMinor < 0
  const abs = Math.abs(m.amountMinor)
  const text = `${groupThousands(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, '0')}`
  const signed = negative ? `-${text}` : text
  return m.currency === UNKNOWN_CURRENCY ? `${signed} (currency not recorded)` : `${m.currency} ${signed}`
}

/** Plain decimal, no grouping (for AI packets, so number checks can match). */
function plainMajor(minor: number): string {
  const abs = Math.abs(minor)
  return `${minor < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

function percentOfBps(bps: number): string {
  return (Math.round(bps / 10) / 10).toFixed(1)
}

function timesOfBps(bps: number): string {
  return (Math.round(bps / 1000) / 10).toFixed(1)
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

function calendarDateUtc(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

function dateToMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

function addDays(date: string, days: number): string {
  return calendarDateUtc(dateToMs(date) + days * DAY_MS)
}

/** Same calendar-day arithmetic as selectors.recoveryAging (process-local zone). */
function ageInDays(start: number, now: number): number {
  const localDay = (time: number) => {
    const d = new Date(time)
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  }
  return Math.max(0, Math.floor((localDay(now) - localDay(start)) / DAY_MS))
}

const FINDING_TYPE_LABEL: Readonly<Record<string, string>> = {
  exact_duplicate: 'duplicate payment',
  near_duplicate: 'possible duplicate payment',
  overpayment: 'overpayment',
  unclaimed_discount: 'unclaimed discount',
  missed_discount: 'missed early-payment discount',
  bank_account_change: 'supplier bank detail change',
  amount_outlier: 'unusual payment amount',
  shared_invoice_number: 'shared invoice number',
}

function findingLabel(type: string): string {
  return FINDING_TYPE_LABEL[type] ?? 'payment check'
}

/**
 * Static prevention suggestions keyed by finding type. Phrased as something to
 * consider; none claims a setting exists or is off.
 */
export const PREVENTION_GUIDANCE: Readonly<Record<string, string>> = {
  exact_duplicate: 'Consider checking duplicate-bill warnings in your accounting system, if it offers them, before each payment run.',
  near_duplicate: 'Consider checking duplicate-bill warnings in your accounting system, if it offers them, and comparing invoice references that differ only slightly.',
  overpayment: 'Consider comparing each payment with the approved bill amount before payments are released.',
  unclaimed_discount: 'Consider reviewing early-payment terms when payment runs are scheduled.',
  missed_discount: 'Consider reviewing early-payment terms when payment runs are scheduled.',
  bank_account_change: 'Consider confirming any change to supplier bank details through a contact you already know before paying.',
  amount_outlier: "Consider a second review for payments well above a supplier's usual amount.",
  shared_invoice_number: 'Consider checking that invoice numbers are unique per supplier when bills are entered.',
}
const DEFAULT_PREVENTION_GUIDANCE = 'Consider reviewing how payments like these are checked before release.'

/** Words no deterministic insight text may contain (tested). */
export const FORBIDDEN_INSIGHT_WORDS: readonly string[] = ['fraud', 'overcharg', 'owed', 'verified', 'all clear', 'no issues', 'price increase']

function containsForbiddenWording(text: string): string | null {
  const lower = text.toLowerCase()
  return FORBIDDEN_INSIGHT_WORDS.find((w) => lower.includes(w)) ?? null
}

// ---------------------------------------------------------------- canonical hashing

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
}

/** 64-bit (two FNV-1a passes) hex digest of a value's canonical JSON. Not cryptographic. */
export function fingerprintOf(value: unknown): string {
  const text = canonical(value)
  return `${stableHash(text)}${stableHash(`#2|${text}`)}`
}

// ---------------------------------------------------------------- generation context

interface Candidate {
  rule: InsightRule
  subjectKey: string
  periodKey: string
  severity: InsightSeverity
  severityReason: string
  title: string
  explanation: string
  limits: string
  subject: InsightSubject
  period: { from: string | null; to: string | null }
  figures: InsightFigure[]
  measures: InsightMeasure[]
  sourceRefs: SourceRef[]
  coverage: CoverageItem[]
  freshness: Freshness
  readModels: Array<{ model: string; metricDefinitionVersion: string }>
  nextAction: InsightNextAction
  influencedBy: string[]
  /** What a dismissal depends on (see catalog: "what invalidates a dismissal"). */
  evidence: unknown
  /** ms; null = condition-based. */
  expiryAnchor: number | null
}

interface Inputs {
  ctx: TenantContext
  deps: InsightDeps
  now: number
  origin: DataOrigin
  records: SourceRecord[]
  coverageEnv: ReturnType<typeof importCoverageSummary>
  summaryEnv: ReturnType<typeof spendSummary>
  baselineEnv: ReturnType<typeof vendorBaselines>
  vendorRows: VendorSpendRow[]
  vendorEnv: ReturnType<typeof spendByVendor> | null
  profiles: VendorProfile[]
  profileEnv: ReturnType<typeof vendorProfiles> | null
  series: RecurringSeriesView[]
  snapshots: CaseSnapshot[]
  keptCases: CaseSnapshot[]
  recoveryEnv: ReturnType<typeof recoveryOverview>
  attentionItems: AttentionItem[]
  attentionEnv: ReturnType<typeof attentionQueue>
  dataAsOf: string | null
  truncated: string[]
  influence: (target: InfluenceTarget) => string[]
  unreadableAuditIds: string[]
  staleAfterMs: number | undefined
}

function legacyReasons(origin: DataOrigin): string[] {
  return origin === 'legacy_audit_snapshot' ? [COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS] : []
}

function pick(env: ReadModelEnvelope<unknown> | null, checks: string[]): CoverageItem[] {
  return env ? env.coverage.filter((c) => checks.includes(c.check)).map((c) => ({ ...c, reasons: [...c.reasons] })) : []
}

function readModelRef(env: ReadModelEnvelope<unknown>): { model: string; metricDefinitionVersion: string } {
  return { model: env.model, metricDefinitionVersion: env.metricDefinitionVersion }
}

function vendorName(inputs: Inputs, vendorKey: string, fallback: string | null = null): string {
  const row = inputs.vendorRows.find((r) => r.vendorKey === vendorKey)
  if (row) return row.displayName
  const profile = inputs.profiles.find((p) => p.vendorKey === vendorKey)
  if (profile) return profile.primaryName || 'Unnamed vendor'
  return fallback?.trim() || 'Unnamed vendor'
}

function memorySentence(ids: string[]): string {
  return ids.length ? ` Business memory you recorded touches this (${plural(ids.length, 'entry', 'entries')}); it is shown as context and changes no figure.` : ''
}

function readInputs(ctx: TenantContext, deps: InsightDeps, now: number, options: GenerateInsightsOptions): Inputs {
  requirePermission(ctx, 'financial:read')
  requirePermission(ctx, 'cases:read')
  const { financial, cases, returns, memory } = deps
  const staleAfterMs = options.staleAfterMs
  const truncated: string[] = []
  const records = financial.listSourceRecords(ctx)
  for (const r of records) requireTenant(ctx, r.tenantId)
  const extra = options.unreadableAuditIds?.length ? [COVERAGE_REASONS.UNREADABLE_SAVED_AUDIT] : []
  const coverageEnv = importCoverageSummary(ctx, financial, now, { extraCoverageReasons: extra, staleAfterMs })
  const summaryEnv = spendSummary(ctx, financial, null, now, { extraCoverageReasons: extra, staleAfterMs })
  const baselineEnv = vendorBaselines(ctx, financial, now)

  const vendorRows: VendorSpendRow[] = []
  let vendorEnv: ReturnType<typeof spendByVendor> | null = null
  {
    let cursor: string | null = null
    for (let page = 0; page < MAX_INPUT_PAGES; page++) {
      const env = spendByVendor(ctx, financial, null, now, { limit: 100, cursor }, { extraCoverageReasons: extra, staleAfterMs })
      vendorEnv ??= env
      if (!env.result) break
      vendorRows.push(...env.result.rows)
      cursor = env.result.nextCursor
      if (cursor === null) break
      if (page === MAX_INPUT_PAGES - 1) truncated.push('spend.by_vendor')
    }
  }

  const profiles: VendorProfile[] = []
  let profileEnv: ReturnType<typeof vendorProfiles> | null = null
  {
    let cursor: string | null = null
    for (let page = 0; page < MAX_INPUT_PAGES; page++) {
      const env = vendorProfiles(ctx, financial, cases, memory, now, { limit: 200, cursor })
      profileEnv ??= env
      if (!env.result) break
      profiles.push(...env.result.items)
      cursor = env.result.nextCursor
      if (cursor === null) break
      if (page === MAX_INPUT_PAGES - 1) truncated.push('vendor_profiles')
    }
  }

  const series = financial.listRecurringSeries(ctx)
  const snapshots = cases.listCases(ctx, now)
  const keptCases = foldCases(snapshots).kept
  const recoveryEnv = recoveryOverview(ctx, cases, returns, now, { extraCoverageReasons: extra, staleAfterMs })

  const attentionItems: AttentionItem[] = []
  const attentionEnv = attentionQueue(ctx, cases, now, { limit: 200 })
  attentionItems.push(...(attentionEnv.result?.items ?? []))
  {
    let cursor = attentionEnv.result?.nextCursor ?? null
    for (let page = 1; cursor !== null && page < MAX_INPUT_PAGES; page++) {
      const env = attentionQueue(ctx, cases, now, { limit: 200, cursor })
      attentionItems.push(...(env.result?.items ?? []))
      cursor = env.result?.nextCursor ?? null
      if (cursor !== null && page === MAX_INPUT_PAGES - 1) truncated.push('attention_queue')
    }
  }

  const dataAsOf = coverageEnv.result?.coveredDateRange.to ?? null
  const influenceCache = new Map<string, string[]>()
  const influence = (target: InfluenceTarget): string[] => {
    const key = 'vendorKey' in target ? `v|${target.vendorKey}` : `c|${target.caseId}`
    let ids = influenceCache.get(key)
    if (!ids) {
      const env = influenceFor(ctx, memory, { financial, cases }, target, now)
      ids = (env.result?.entries ?? []).filter((e) => e.inEffect).map((e) => e.entryId).sort(compareText)
      influenceCache.set(key, ids)
    }
    return ids
  }

  return {
    ctx, deps, now, origin: financial.origin, records, coverageEnv, summaryEnv, baselineEnv, vendorRows, vendorEnv, profiles, profileEnv,
    series, snapshots, keptCases, recoveryEnv, attentionItems, attentionEnv, dataAsOf, truncated, influence,
    unreadableAuditIds: [...(options.unreadableAuditIds ?? [])].sort(compareText), staleAfterMs,
  }
}

function recordRef(r: SourceRecord): SourceRef {
  return { id: `record:${r.recordId}`, label: `Source record ${r.paymentDate ?? 'undated'}` }
}

// ---------------------------------------------------------------- rule 1: vendor_spend_above_baseline

function ruleAboveBaseline(inputs: Inputs): Candidate[] {
  const out: Candidate[] = []
  const baselines = inputs.baselineEnv.result?.baselines ?? []
  if (inputs.dataAsOf === null) return out
  const windowFrom = addDays(inputs.dataAsOf, -(ABOVE_BASELINE_LOOKBACK_DAYS - 1))
  const byId = new Map(inputs.records.map((r) => [r.recordId, r]))
  for (const b of baselines) {
    // Insufficient history never produces this insight (compareToBaseline says so too).
    if (b.status !== 'established' || b.currency === UNKNOWN_CURRENCY) continue
    const recent = b.sourceRecordIds
      .map((id) => byId.get(id)!)
      .filter((r) => r && r.paymentDate !== null && r.paymentDate >= windowFrom && r.paymentDate <= inputs.dataAsOf!)
    const above = recent
      .map((r) => ({ r, cmp: compareToBaseline(b, r.amountMinor) }))
      .filter((x) => x.cmp.label === 'above_range')
      .sort((a, z) => z.r.amountMinor - a.r.amountMinor || compareText(a.r.paymentDate!, z.r.paymentDate!) || compareText(a.r.recordId, z.r.recordId))
    if (!above.length) continue
    out.push(aboveBaselineCandidate(inputs, b, above, windowFrom))
  }
  return out
}

function intentionalCovers(inputs: Inputs, entryIds: string[], above: Array<{ r: SourceRecord }>): string[] {
  const covering: string[] = []
  for (const id of entryIds) {
    const entry = inputs.deps.memory.get(inputs.ctx, id, inputs.now)
    if (!entry || entry.details.kind !== 'intentional_payment') continue
    const s = entry.scope
    const band = entry.details.amountBand
    const covers = above.every(({ r }) =>
      (s.type === 'source_records' && s.sourceRecordIds.includes(r.recordId)) ||
      (s.type === 'vendor' && band !== null && band.currency === r.currency && r.amountMinor >= band.minMinor && r.amountMinor <= band.maxMinor))
    if (covers) covering.push(id)
  }
  return covering
}

function aboveBaselineCandidate(inputs: Inputs, b: VendorBaseline, above: Array<{ r: SourceRecord; cmp: ReturnType<typeof compareToBaseline> }>, windowFrom: string): Candidate {
  const top = above[0]
  const name = vendorName(inputs, b.vendorKey, top.r.vendor.displayName)
  const influencedBy = inputs.influence({ vendorKey: b.vendorKey })
  const intentional = intentionalCovers(inputs, influencedBy, above)
  const ratio = top.cmp.ratioBps ?? 0
  let severity: InsightSeverity = ratio >= ABOVE_BASELINE_MEDIUM_RATIO_BPS ? 'medium' : 'low'
  let severityReason = ratio >= ABOVE_BASELINE_MEDIUM_RATIO_BPS
    ? `medium: the highest payment is ${timesOfBps(ratio)} times the median, at or above the ${timesOfBps(ABOVE_BASELINE_MEDIUM_RATIO_BPS)} times threshold`
    : `low: above the usual range but under ${timesOfBps(ABOVE_BASELINE_MEDIUM_RATIO_BPS)} times the median`
  if (intentional.length) {
    severity = 'low'
    severityReason = `low: a reviewer recorded these payments as intentional (memory ${intentional.join(', ')}); still shown, not hidden`
  }
  const latestDate = above.map((x) => x.r.paymentDate!).sort(compareText).at(-1)!
  const money = (minor: number) => ({ currency: b.currency, amountMinor: minor })
  const baselineSource = (field: string) => ({ model: 'vendor_baselines', field, metricDefinitionVersion: BASELINE_VERSION })
  return {
    rule: 'vendor_spend_above_baseline',
    subjectKey: `vendor:${b.vendorKey}`,
    periodKey: `${b.currency}:${latestDate.slice(0, 7)}`,
    severity,
    severityReason,
    title: `Payments to ${name} in the covered records were above its usual range`,
    explanation:
      `In the covered records, ${plural(above.length, 'payment')} to ${name} in the latest ${ABOVE_BASELINE_LOOKBACK_DAYS} days of covered data ${above.length === 1 ? 'was' : 'were'} above its usual range. ` +
      `The highest was ${formatMoney(money(top.r.amountMinor))} on ${top.r.paymentDate}, about ${timesOfBps(ratio)} times the median payment of ${formatMoney(money(b.medianPaymentMinor!))} ` +
      `(usual range up to ${formatMoney(money(b.upperBoundMinor!))}, from ${plural(b.paymentCount, 'payment')} over ${plural(b.coveredMonths, 'month')}). ` +
      `This compares amounts only.${memorySentence(influencedBy)}`,
    limits: "It compares amounts with this vendor's own history in the covered records; it does not show why the amount differed, what was bought, or whether the payment was right.",
    subject: { type: 'vendor', vendorKey: b.vendorKey, displayName: name },
    period: { from: windowFrom, to: inputs.dataAsOf },
    figures: [
      ...above.map(({ r }) => ({ label: `Payment on ${r.paymentDate}`, money: money(r.amountMinor), source: { model: 'source_records', field: 'amountMinor', metricDefinitionVersion: r.normalizationVersion } })),
      { label: 'Median payment', money: money(b.medianPaymentMinor!), source: baselineSource('medianPaymentMinor') },
      { label: 'Top of usual range', money: money(b.upperBoundMinor!), source: baselineSource('upperBoundMinor') },
    ],
    measures: [
      { label: 'Highest payment as a ratio of the median', value: ratio, unit: 'bps', source: { model: 'vendor_baselines', field: 'compareToBaseline.ratioBps', metricDefinitionVersion: BASELINE_VERSION } },
      { label: 'Payments in the baseline', value: b.paymentCount, unit: 'count', source: baselineSource('paymentCount') },
      { label: 'Covered months in the baseline', value: b.coveredMonths, unit: 'count', source: baselineSource('coveredMonths') },
    ],
    sourceRefs: [{ id: `rule:${BASELINE_VERSION}`, label: 'Vendor baseline method' }, ...above.map(({ r }) => recordRef(r))],
    coverage: pick(inputs.baselineEnv, ['vendor_baselines', 'seasonal_comparison']),
    freshness: inputs.baselineEnv.freshness,
    readModels: [readModelRef(inputs.baselineEnv)],
    nextAction: { kind: 'review_vendor', target: { vendorKey: b.vendorKey }, label: `Review payments to ${name}`, sideEffects: 'none' },
    influencedBy,
    evidence: { vendorKey: b.vendorKey, currency: b.currency, above: above.map(({ r }) => [r.recordId, r.amountMinor]) },
    expiryAnchor: dateToMs(latestDate),
  }
}

// ---------------------------------------------------------------- rule 2: recurring_payment_visible

function ruleRecurring(inputs: Inputs): Candidate[] {
  const flaggedRecordIds = new Set(inputs.snapshots.filter((c) => c.stage !== 'dismissed' && !c.suppressed).flatMap((c) => c.sourceRecordIds))
  const groups = new Map<string, RecurringSeriesView[]>()
  for (const s of inputs.series) {
    const key = `${s.vendorKey}|${s.amount.currency}|${s.amount.amountMinor}`
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const out: Candidate[] = []
  for (const key of [...groups.keys()].sort(compareText)) {
    const list = groups.get(key)!
    // Saved audits can each hold the same series: keep the latest-ending one.
    const kept = [...list].sort((a, b) => compareText(b.lastPaymentDate, a.lastPaymentDate) || b.paymentCount - a.paymentCount || compareText(a.seriesId, b.seriesId))[0]
    // "Not flagged": no open case is built on the series' payments.
    if (list.some((s) => s.sourceRecordIds.some((id) => flaggedRecordIds.has(id)))) continue
    const name = vendorName(inputs, kept.vendorKey, kept.vendorName)
    const influencedBy = inputs.influence({ vendorKey: kept.vendorKey })
    const seriesSource = (field: string) => ({ model: 'recurring_series', field, metricDefinitionVersion: INTELLIGENCE_CONTRACT_VERSION })
    out.push({
      rule: 'recurring_payment_visible',
      subjectKey: `vendor:${kept.vendorKey}`,
      periodKey: `${kept.amount.currency}:${kept.amount.amountMinor}`,
      severity: 'low',
      severityReason: 'low: visibility only; recurring payments are not flagged by the detector',
      title: `Recurring payment to ${name}, about every ${plural(kept.cadenceDays, 'day')}`,
      explanation:
        `In the covered records, ${name} was paid ${formatMoney(kept.amount)} about every ${plural(kept.cadenceDays, 'day')} ` +
        `(${plural(kept.paymentCount, 'payment')}, ${kept.firstPaymentDate} to ${kept.lastPaymentDate}). The detector treats this as recurring and does not flag it. ` +
        `Review it if you no longer expect it.${memorySentence(influencedBy)}`,
      limits: 'It shows a repeating pattern in the covered records; it does not show whether the service is still used or whether the amount matches an agreement.',
      subject: { type: 'vendor', vendorKey: kept.vendorKey, displayName: name },
      period: { from: kept.firstPaymentDate, to: kept.lastPaymentDate },
      figures: [{ label: 'Recurring amount', money: { ...kept.amount }, source: seriesSource('amount') }],
      measures: [
        { label: 'Cadence', value: kept.cadenceDays, unit: 'days', source: seriesSource('cadenceDays') },
        { label: 'Payments in the series', value: kept.paymentCount, unit: 'count', source: seriesSource('paymentCount') },
      ],
      sourceRefs: [...list.map((s) => ({ id: `series:${s.seriesId}`, label: 'Recurring series' })), ...kept.sourceRecordIds.map((id) => ({ id: `record:${id}`, label: 'Source record' }))],
      coverage: [coverage('recurring_series', legacyReasons(inputs.origin))],
      freshness: inputs.coverageEnv.freshness,
      readModels: [{ model: 'recurring_series', metricDefinitionVersion: INTELLIGENCE_CONTRACT_VERSION }],
      nextAction: { kind: 'review_vendor', target: { vendorKey: kept.vendorKey }, label: `Review recurring payments to ${name}`, sideEffects: 'none' },
      influencedBy,
      // A dismissal holds while the pattern (amount, cadence) is unchanged; a new month of the same payment does not reopen it.
      evidence: { vendorKey: kept.vendorKey, amount: kept.amount, cadenceDays: kept.cadenceDays },
      expiryAnchor: dateToMs(kept.lastPaymentDate),
    })
  }
  return out
}

// ---------------------------------------------------------------- rule 3a: vendor_concentration

function ruleConcentration(inputs: Inputs): Candidate[] {
  const env = inputs.vendorEnv
  if (!env?.result) return []
  const vendorsPerCurrency = new Map<string, number>()
  for (const r of inputs.vendorRows) vendorsPerCurrency.set(r.currency, (vendorsPerCurrency.get(r.currency) ?? 0) + (r.paymentCount > 0 ? 1 : 0))
  const totals = new Map(env.result.currencyTotals.map((t) => [t.currency, t.amountMinor]))
  const out: Candidate[] = []
  for (const row of inputs.vendorRows) {
    if (row.currency === UNKNOWN_CURRENCY || row.shareOfCurrencyBps < CONCENTRATION_SHARE_BPS) continue
    const vendorCount = vendorsPerCurrency.get(row.currency) ?? 0
    if (vendorCount < CONCENTRATION_MIN_VENDORS) continue
    const total = totals.get(row.currency) ?? 0
    const influencedBy = inputs.influence({ vendorKey: row.vendorKey })
    const src = (field: string) => ({ model: env.model, field, metricDefinitionVersion: SPEND_METRIC_VERSION })
    const from = inputs.coverageEnv.result?.coveredDateRange.from ?? null
    out.push({
      rule: 'vendor_concentration',
      subjectKey: `vendor:${row.vendorKey}`,
      periodKey: `${row.currency}`,
      severity: 'low',
      severityReason: 'low: concentration is context, not a problem by itself',
      title: `${row.displayName} received ${percentOfBps(row.shareOfCurrencyBps)}% of covered ${row.currency} payments`,
      explanation:
        `In the covered records, payments to ${row.displayName} were ${formatMoney({ currency: row.currency, amountMinor: row.grossPaymentsMinor })} ` +
        `of ${formatMoney({ currency: row.currency, amountMinor: total })} paid in ${row.currency} (${percentOfBps(row.shareOfCurrencyBps)}%), across ${plural(vendorCount, 'vendor')}. ` +
        `This shows where covered payments went.${memorySentence(influencedBy)}`,
      limits: 'It covers only imported AP payments in this currency; it is not total company spending and says nothing about whether the share is appropriate.',
      subject: { type: 'vendor', vendorKey: row.vendorKey, displayName: row.displayName },
      period: { from, to: inputs.dataAsOf },
      figures: [
        { label: 'Gross payments to this vendor', money: { currency: row.currency, amountMinor: row.grossPaymentsMinor }, source: src('rows[].grossPaymentsMinor') },
        { label: `All covered ${row.currency} payments`, money: { currency: row.currency, amountMinor: total }, source: src('currencyTotals') },
      ],
      measures: [
        { label: 'Share of covered payments in this currency', value: row.shareOfCurrencyBps, unit: 'bps', source: src('rows[].shareOfCurrencyBps') },
        { label: 'Vendors paid in this currency', value: vendorCount, unit: 'count', source: src('rows') },
      ],
      sourceRefs: row.sourceRecordIds.map((id) => ({ id: `record:${id}`, label: 'Source record' })),
      coverage: pick(env, ['covered_spend']),
      freshness: env.freshness,
      readModels: [readModelRef(env)],
      nextAction: { kind: 'review_vendor', target: { vendorKey: row.vendorKey }, label: `Review payments to ${row.displayName}`, sideEffects: 'none' },
      influencedBy,
      // Re-shown when the share moves into another 10-point band.
      evidence: { vendorKey: row.vendorKey, currency: row.currency, shareBand: Math.floor(row.shareOfCurrencyBps / 1000) },
      expiryAnchor: inputs.dataAsOf ? dateToMs(inputs.dataAsOf) : null,
    })
  }
  return out
}

// ---------------------------------------------------------------- rule 3b: vendor_change

function ruleVendorChange(inputs: Inputs): Candidate[] {
  const env = inputs.profileEnv
  if (!env) return []
  const out: Candidate[] = []
  for (const p of inputs.profiles) {
    for (const ch of p.recentChange) {
      // Only when both windows were covered (status computed) and the prior window had enough payments.
      if (ch.status !== 'computed' || ch.changeBps === null || ch.recentWindow === null || ch.priorWindow === null) continue
      if ((ch.priorPaymentCount ?? 0) < VENDOR_CHANGE_MIN_PRIOR_PAYMENTS || Math.abs(ch.changeBps) < VENDOR_CHANGE_THRESHOLD_BPS) continue
      const higher = ch.changeBps > 0
      const name = p.primaryName || 'Unnamed vendor'
      const influencedBy = inputs.influence({ vendorKey: p.vendorKey })
      const money = (minor: number) => ({ currency: ch.currency, amountMinor: minor })
      const src = (field: string) => ({ model: env.model, field: `recentChange[].${field}`, metricDefinitionVersion: VENDOR_PROFILE_VERSION })
      const medium = ch.changeBps >= VENDOR_CHANGE_MEDIUM_BPS
      out.push({
        rule: 'vendor_change',
        subjectKey: `vendor:${p.vendorKey}`,
        periodKey: `${ch.currency}:${ch.recentWindow.to}`,
        severity: medium ? 'medium' : 'low',
        severityReason: medium
          ? `medium: the latest ${RECENT_WINDOW_DAYS} days are at least ${percentOfBps(VENDOR_CHANGE_MEDIUM_BPS)}% higher than the ${RECENT_WINDOW_DAYS} days before`
          : `low: a change of at least ${percentOfBps(VENDOR_CHANGE_THRESHOLD_BPS)}% but ${higher ? `under ${percentOfBps(VENDOR_CHANGE_MEDIUM_BPS)}% higher` : 'lower'}`,
        title: `Payments to ${name} in the covered records were ${higher ? 'higher' : 'lower'} in the latest ${RECENT_WINDOW_DAYS} days`,
        explanation:
          `In the covered records, payments to ${name} were ${formatMoney(money(ch.recentGrossMinor!))} (${plural(ch.recentPaymentCount ?? 0, 'payment')}) from ${ch.recentWindow.from} to ${ch.recentWindow.to}, ` +
          `against ${formatMoney(money(ch.priorGrossMinor!))} (${plural(ch.priorPaymentCount ?? 0, 'payment')}) from ${ch.priorWindow.from} to ${ch.priorWindow.to}: ` +
          `${percentOfBps(Math.abs(ch.changeBps))}% ${higher ? 'higher' : 'lower'}. This compares totals only.${memorySentence(influencedBy)}`,
        limits: 'It compares two covered windows of the same length; it does not show why the totals differ, such as volume, timing or terms.',
        subject: { type: 'vendor', vendorKey: p.vendorKey, displayName: name },
        period: { from: ch.priorWindow.from, to: ch.recentWindow.to },
        figures: [
          { label: 'Latest window', money: money(ch.recentGrossMinor!), source: src('recentGrossMinor') },
          { label: 'Prior window', money: money(ch.priorGrossMinor!), source: src('priorGrossMinor') },
        ],
        measures: [
          { label: 'Change between windows', value: ch.changeBps, unit: 'bps', source: src('changeBps') },
          { label: 'Payments in latest window', value: ch.recentPaymentCount ?? 0, unit: 'count', source: src('recentPaymentCount') },
          { label: 'Payments in prior window', value: ch.priorPaymentCount ?? 0, unit: 'count', source: src('priorPaymentCount') },
        ],
        sourceRefs: [{ id: `rule:${VENDOR_PROFILE_VERSION}`, label: 'Vendor profile definition' }, { id: `vendor:${p.vendorKey}`, label: 'Vendor' }],
        coverage: pick(env, ['recent_change']),
        freshness: env.freshness,
        readModels: [readModelRef(env)],
        nextAction: { kind: 'review_vendor', target: { vendorKey: p.vendorKey }, label: `Review payments to ${name}`, sideEffects: 'none' },
        influencedBy,
        evidence: { vendorKey: p.vendorKey, currency: ch.currency, recent: ch.recentGrossMinor, prior: ch.priorGrossMinor, windows: [ch.priorWindow, ch.recentWindow] },
        expiryAnchor: dateToMs(ch.recentWindow.to),
      })
    }
  }
  return out
}

// ---------------------------------------------------------------- rule 4: import_coverage_gap

function ruleCoverageGap(inputs: Inputs): Candidate[] {
  const env = inputs.coverageEnv
  const summary = env.result
  const out: Candidate[] = []
  const covSource = (field: string) => ({ model: env.model, field, metricDefinitionVersion: SPEND_METRIC_VERSION })
  const importRefs = (summary?.imports ?? []).map((i) => ({ id: `import:${i.auditId}/${i.importId}`, label: 'Import' }))
  const base = (kind: string, subject: InsightSubject = { type: 'account', account: true }) => ({
    rule: 'import_coverage_gap' as const,
    subjectKey: subject.type === 'import' ? `import:${subject.auditId}/${subject.importId}` : 'account',
    periodKey: kind,
    subject,
    coverage: pick(env, ['import_coverage']),
    freshness: env.freshness,
    readModels: [readModelRef(env)],
    influencedBy: [] as string[],
    expiryAnchor: null,
    figures: [] as InsightFigure[],
  })

  if (!summary && inputs.records.length === 0) {
    out.push({
      ...base('no_data'),
      severity: 'medium',
      severityReason: 'medium: with no covered records, no check could run',
      title: 'No covered records yet',
      explanation: 'There are no imported payment records for this account, so no payment checks could run. Nothing has been reviewed yet.',
      limits: 'It says only that nothing was imported; it does not describe your payments.',
      period: { from: null, to: null },
      measures: [],
      sourceRefs: [],
      nextAction: { kind: 'request_records', target: { from: null, to: null }, label: 'Import payment records', sideEffects: 'none' },
      evidence: { kind: 'no_data' },
    })
  }

  if (inputs.unreadableAuditIds.length) {
    out.push({
      ...base('unreadable_audits'),
      severity: 'medium',
      severityReason: 'medium: whole saved audits were left out of every check',
      title: 'Some saved audits could not be read',
      explanation: `${plural(inputs.unreadableAuditIds.length, 'saved audit')} could not be read and ${inputs.unreadableAuditIds.length === 1 ? 'was' : 'were'} left out of every check and figure.`,
      limits: 'It does not say what those audits contain; their payments are simply not in the covered records.',
      period: { from: null, to: null },
      measures: [{ label: 'Unreadable saved audits', value: inputs.unreadableAuditIds.length, unit: 'count', source: { model: 'legacy_audit_adapter', field: 'unreadableAuditIds', metricDefinitionVersion: INSIGHTS_VERSION } }],
      sourceRefs: inputs.unreadableAuditIds.map((id) => ({ id: `audit:${id}`, label: 'Unreadable saved audit' })),
      nextAction: { kind: 'review_import_coverage', target: { importId: null, auditIds: inputs.unreadableAuditIds }, label: 'Review the saved audits that could not be read', sideEffects: 'none' },
      evidence: { kind: 'unreadable', ids: inputs.unreadableAuditIds },
    })
  }

  if (!summary) return out

  if (summary.gaps.length) {
    const longest = Math.max(...summary.gaps.map((g) => daysBetweenDates(g.from, g.to) + 1))
    const shown = summary.gaps.slice(0, 3).map((g) => `${g.from} to ${g.to}`).join(', ')
    const medium = longest >= COVERAGE_GAP_MEDIUM_DAYS
    out.push({
      ...base('period_gaps'),
      severity: medium ? 'medium' : 'low',
      severityReason: medium ? `medium: at least one uncovered period is ${COVERAGE_GAP_MEDIUM_DAYS} days or longer` : `low: every uncovered period is shorter than ${COVERAGE_GAP_MEDIUM_DAYS} days`,
      title: 'Some periods are not covered by your imports',
      explanation:
        `Your imports cover ${summary.coveredDateRange.from} to ${summary.coveredDateRange.to} with ${plural(summary.gaps.length, 'gap')} (${shown}${summary.gaps.length > 3 ? ', and more' : ''}). ` +
        'Payments in those periods are not in the covered records and were not checked.',
      limits: 'A gap may be a quiet period with no payments; the covered records cannot tell the difference.',
      period: { from: summary.coveredDateRange.from, to: summary.coveredDateRange.to },
      measures: [
        { label: 'Uncovered periods', value: summary.gaps.length, unit: 'count', source: covSource('gaps') },
        { label: 'Longest uncovered period', value: longest, unit: 'days', source: covSource('gaps') },
      ],
      sourceRefs: importRefs,
      nextAction: { kind: 'request_records', target: { from: summary.gaps[0].from, to: summary.gaps[0].to }, label: 'Import records for the uncovered periods', sideEffects: 'none' },
      evidence: { kind: 'gaps', gaps: summary.gaps },
    })
  }

  for (const i of summary.imports) {
    if (i.rejectedRows <= 0) continue
    const totalRows = i.acceptedRows + i.rejectedRows
    const shareBps = totalRows > 0 ? Math.round((i.rejectedRows * 10000) / totalRows) : 10000
    const medium = shareBps >= REJECTED_ROWS_MEDIUM_BPS
    out.push({
      ...base('rejected_rows', { type: 'import', importId: i.importId, auditId: i.auditId }),
      severity: medium ? 'medium' : 'low',
      severityReason: medium ? `medium: at least ${percentOfBps(REJECTED_ROWS_MEDIUM_BPS)}% of the import's rows were rejected` : `low: under ${percentOfBps(REJECTED_ROWS_MEDIUM_BPS)}% of the import's rows were rejected`,
      title: 'Rows in an import could not be read',
      explanation: `${plural(i.rejectedRows, 'row')} of ${totalRows} in this ${i.system} import could not be read, so ${i.rejectedRows === 1 ? 'it was' : 'they were'} left out of every check and figure.`,
      limits: 'It does not show what the rejected rows contained.',
      period: { from: i.dateRange.from, to: i.dateRange.to },
      measures: [
        { label: 'Rejected rows', value: i.rejectedRows, unit: 'count', source: covSource('imports[].rejectedRows') },
        { label: 'Accepted rows', value: i.acceptedRows, unit: 'count', source: covSource('imports[].acceptedRows') },
      ],
      sourceRefs: [{ id: `import:${i.auditId}/${i.importId}`, label: 'Import' }],
      nextAction: { kind: 'review_import_coverage', target: { importId: i.importId, auditIds: [i.auditId] }, label: 'Review the rows this import could not read', sideEffects: 'none' },
      evidence: { kind: 'rejected', importId: i.importId, auditId: i.auditId, rejected: i.rejectedRows, accepted: i.acceptedRows },
    })
  }

  if (summary.undatedImportCount > 0) {
    out.push({
      ...base('undated_imports'),
      severity: 'low',
      severityReason: 'low: the rows are included, but their period is unknown',
      title: 'Some imports have no payment dates',
      explanation: `${plural(summary.undatedImportCount, 'import')} had no payment dates, so the period ${summary.undatedImportCount === 1 ? 'it covers' : 'they cover'} is unknown and ${summary.undatedImportCount === 1 ? 'it is' : 'they are'} left out of period comparisons.`,
      limits: 'It does not say which period those rows belong to.',
      period: { from: null, to: null },
      measures: [{ label: 'Imports without dates', value: summary.undatedImportCount, unit: 'count', source: covSource('undatedImportCount') }],
      sourceRefs: importRefs,
      nextAction: { kind: 'review_import_coverage', target: { importId: null, auditIds: [] }, label: 'Review imports without payment dates', sideEffects: 'none' },
      evidence: { kind: 'undated', count: summary.undatedImportCount },
    })
  }

  const unknownLine = inputs.summaryEnv.result?.byCurrency.find((l) => l.currency === UNKNOWN_CURRENCY)
  if (unknownLine && unknownLine.paymentCount + unknownLine.refundAndCreditCount > 0) {
    const n = unknownLine.paymentCount + unknownLine.refundAndCreditCount
    out.push({
      ...base('missing_currency'),
      severity: 'low',
      severityReason: 'low: these rows are reported separately and never compared',
      title: 'Some payments have no recorded currency',
      explanation: `${plural(n, 'row')} in the covered records ${n === 1 ? 'has' : 'have'} no recognisable currency. ${n === 1 ? 'It is' : 'They are'} reported in a separate bucket and left out of baselines and comparisons.`,
      limits: 'No currency is assumed or converted, so these rows cannot be compared with anything.',
      coverage: pick(inputs.summaryEnv, ['covered_spend']),
      period: { from: null, to: null },
      measures: [{ label: 'Rows without a currency', value: n, unit: 'count', source: { model: inputs.summaryEnv.model, field: 'byCurrency[UNKNOWN]', metricDefinitionVersion: SPEND_METRIC_VERSION } }],
      sourceRefs: importRefs,
      readModels: [readModelRef(inputs.summaryEnv)],
      nextAction: { kind: 'review_import_coverage', target: { importId: null, auditIds: [] }, label: 'Review rows without a currency', sideEffects: 'none' },
      evidence: { kind: 'missing_currency', n },
    })
  }

  if (env.freshness.stale && summary.newestImportAt !== null) {
    const newest = calendarDateUtc(summary.newestImportAt)
    out.push({
      ...base('stale_data'),
      severity: 'medium',
      severityReason: 'medium: payments made since the newest import were not checked',
      title: 'Covered records are out of date',
      explanation:
        `The newest import is from ${newest}, more than ${plural(Math.round((inputs.staleAfterMs ?? 35 * DAY_MS) / DAY_MS), 'day')} before ${calendarDateUtc(inputs.now)}. ` +
        `Payments made since then are not in the covered records${summary.coveredDateRange.to ? `, which end on ${summary.coveredDateRange.to}` : ''}. Insights shown are historical, not current monitoring.`,
      limits: 'It does not say whether newer payments exist, only that none were imported.',
      period: { from: summary.coveredDateRange.to, to: null },
      measures: [{ label: 'Days since the newest import', value: Math.floor((inputs.now - summary.newestImportAt) / DAY_MS), unit: 'days', source: covSource('newestImportAt') }],
      sourceRefs: importRefs,
      nextAction: { kind: 'request_records', target: { from: summary.coveredDateRange.to, to: null }, label: 'Import newer payment records', sideEffects: 'none' },
      evidence: { kind: 'stale', newestImportAt: summary.newestImportAt },
    })
  }
  return out
}

// ---------------------------------------------------------------- rule 5: unresolved_recovery

function ruleUnresolved(inputs: Inputs): Candidate[] {
  const out: Candidate[] = []
  const matching = inputs.deps.returns.available
  for (const c of inputs.keptCases) {
    if (!c.isClaim || c.stage !== 'requested' || c.outstandingMinor <= 0) continue
    const age = c.requestedAt !== null && Number.isFinite(c.requestedAt) && c.requestedAt > 0 ? ageInDays(c.requestedAt, inputs.now) : null
    const disputed = c.latestVendorStatus === 'disputed' || c.latestVendorStatus === 'partial_acceptance'
    const partial = c.customerRecordedReturnMinor > 0
    const aging = age !== null && age > UNRESOLVED_AGE_DAYS
    if (!aging && !disputed && !partial && age !== null) continue
    const k = caseContributions(c)
    const name = vendorName(inputs, c.vendor.vendorKey, c.vendor.displayName)
    const money = (minor: number) => ({ currency: c.currency, amountMinor: minor })
    const rsrc = (field: string) => ({ model: 'recovery.overview', field, metricDefinitionVersion: RECOVERY_METRIC_VERSION })
    const figures: InsightFigure[] = [{ label: 'Still open on the request', money: money(c.outstandingMinor), source: rsrc('approvedOutstanding') }]
    if (k.promised !== null) figures.push({ label: 'Supplier said it would return (a statement, not money received)', money: money(k.promised), source: rsrc('promised') })
    if (k.recorded !== null) figures.push({ label: 'Returns you recorded (not matched to a bank or accounting record)', money: money(k.recorded), source: rsrc('customerRecordedReturns') })
    let severity: InsightSeverity
    let severityReason: string
    if (age !== null && age > UNRESOLVED_HIGH_AGE_DAYS) {
      severity = 'high'
      severityReason = `high: the request has been open more than ${UNRESOLVED_HIGH_AGE_DAYS} days with money still open on it`
    } else if (aging || disputed || partial) {
      severity = 'medium'
      severityReason = aging ? `medium: the request has been open more than ${UNRESOLVED_AGE_DAYS} days` : disputed ? 'medium: the supplier disputed or partly accepted the request' : 'medium: part of the request came back and the rest is still open'
    } else {
      severity = 'low'
      severityReason = 'low: the request date is not recorded, so its age is unknown'
    }
    const ageBucket = age === null ? 'unknown' : age > UNRESOLVED_HIGH_AGE_DAYS ? `>${UNRESOLVED_HIGH_AGE_DAYS}` : age > UNRESOLVED_AGE_DAYS ? `>${UNRESOLVED_AGE_DAYS}` : 'recent'
    const title = aging
      ? `Request to ${name} still open after ${plural(age!, 'day')}`
      : disputed ? `Supplier ${name} disputed or partly accepted a request` : partial ? `Part of the request to ${name} is still open` : `Request to ${name} has no recorded date`
    const sentences = [
      `In the saved case state, the ${findingLabel(c.findingType)} request to ${name} ${age === null ? 'has no recorded request date' : `was sent ${plural(age, 'day')} ago`} and ${formatMoney(money(c.outstandingMinor))} is still open on it.`,
    ]
    if (disputed) sentences.push(`The supplier's latest recorded position is "${c.statusLabel}".`)
    if (k.recorded !== null) sentences.push(`You recorded ${formatMoney(money(k.recorded))} coming back; it has not been matched to a bank or accounting record.`)
    if (k.promised !== null) sentences.push(`The supplier said it would return ${formatMoney(money(k.promised))}; that is a statement, not money received.`)
    const influencedBy = inputs.influence({ caseId: c.caseId })
    out.push({
      rule: 'unresolved_recovery',
      subjectKey: `case:${c.caseId}`,
      periodKey: `g${c.activeRequestGeneration}`,
      severity,
      severityReason,
      title,
      explanation: `${sentences.join(' ')}${memorySentence(influencedBy)}`,
      limits: `It is based on saved case state; it does not show replies or payments not recorded in Reclaim${matching ? '' : ', and recorded returns are not matched to bank or accounting records'}.`,
      subject: { type: 'case', caseId: c.caseId, vendorKey: c.vendor.vendorKey },
      period: { from: c.requestedAt !== null ? calendarDateUtc(c.requestedAt) : null, to: calendarDateUtc(inputs.now) },
      figures,
      measures: age === null ? [] : [{ label: 'Days since the request was sent', value: age, unit: 'days', source: { model: 'case_snapshot', field: 'requestedAt', metricDefinitionVersion: RECOVERY_METRIC_VERSION } }],
      sourceRefs: [{ id: `case:${c.caseId}`, label: 'Recovery case' }, ...c.sourceRecordIds.map((id) => ({ id: `record:${id}`, label: 'Source record' }))],
      coverage: pick(inputs.recoveryEnv, ['recovery_cases', 'promised', 'matched_returns']),
      freshness: inputs.recoveryEnv.freshness,
      readModels: [readModelRef(inputs.recoveryEnv)],
      nextAction: { kind: 'open_case', target: { caseId: c.caseId }, label: `Open the ${name} case`, sideEffects: 'none' },
      influencedBy,
      evidence: { caseId: c.caseId, generation: c.activeRequestGeneration, ageBucket, disputed, partial, outstanding: c.outstandingMinor, status: c.latestVendorStatus, recorded: c.customerRecordedReturnMinor },
      expiryAnchor: null,
    })
  }
  return out
}

// ---------------------------------------------------------------- rule 6: approvals_due / follow_ups_due

function ruleAttention(inputs: Inputs): Candidate[] {
  const env = inputs.attentionEnv
  const out: Candidate[] = []
  const approvals = inputs.attentionItems.filter((i) => i.category === 'requires_approval').sort((a, b) => compareText(a.id, b.id))
  const followUps = inputs.attentionItems.filter((i) => i.kind === 'follow_up_due' || i.kind === 'follow_up_overdue').sort((a, b) => compareText(a.id, b.id))
  const asrc = (field: string) => ({ model: env.model, field, metricDefinitionVersion: ATTENTION_METRIC_VERSION })
  const common = {
    subject: { type: 'account', account: true } as InsightSubject,
    subjectKey: 'account',
    periodKey: 'current',
    period: { from: null, to: calendarDateUtc(inputs.now) },
    figures: [] as InsightFigure[],
    coverage: pick(env, ['case_state', 'pending_approvals', 'send_state']),
    freshness: env.freshness,
    readModels: [readModelRef(env)],
    influencedBy: [] as string[],
    expiryAnchor: null,
  }
  if (approvals.length) {
    const n = approvals.length
    const high = n >= APPROVALS_HIGH_COUNT
    out.push({
      ...common,
      rule: 'approvals_due',
      severity: high ? 'high' : 'medium',
      severityReason: high ? `high: ${n} approvals are waiting (threshold ${APPROVALS_HIGH_COUNT})` : `medium: ${plural(n, 'approval')} waiting, under the ${APPROVALS_HIGH_COUNT} threshold`,
      title: `${plural(n, 'supplier request')} ${n === 1 ? 'is' : 'are'} waiting for your approval`,
      explanation: `In the saved case state, ${plural(n, 'recovery request')} ${n === 1 ? 'is' : 'are'} ready for you to review and approve. Approving does not send anything; each request is sent as a separate step.`,
      limits: 'It is derived from saved case state, not an approval service; a request may need revalidation before it can be approved.',
      measures: [{ label: 'Approvals waiting', value: n, unit: 'count', source: asrc('counts.byCategory.requires_approval') }],
      sourceRefs: approvals.map((i) => ({ id: `case:${i.caseId}`, label: 'Case awaiting approval' })),
      nextAction: { kind: 'open_attention', target: { category: 'requires_approval', kinds: ['outbound_approval'] }, label: 'Open approvals', sideEffects: 'none' },
      evidence: { items: approvals.map((i) => i.id) },
    })
  }
  if (followUps.length) {
    const overdue = followUps.filter((i) => i.kind === 'follow_up_overdue').length
    const due = followUps.length - overdue
    out.push({
      ...common,
      rule: 'follow_ups_due',
      severity: overdue > 0 ? 'high' : 'medium',
      severityReason: overdue > 0 ? `high: ${plural(overdue, 'follow-up')} more than ${OVERDUE_GRACE_DAYS} days past ${overdue === 1 ? 'its' : 'their'} date` : 'medium: follow-ups reached their date and none is overdue',
      title: `${plural(followUps.length, 'supplier follow-up')} ${followUps.length === 1 ? 'is' : 'are'} due`,
      explanation: `In the saved case state, ${plural(due, 'follow-up')} reached ${due === 1 ? 'its' : 'their'} date and ${plural(overdue, 'follow-up')} ${overdue === 1 ? 'is' : 'are'} more than ${plural(OVERDUE_GRACE_DAYS, 'day')} past ${overdue === 1 ? 'its' : 'their'} date.`,
      limits: 'It counts follow-up dates in saved case state; it does not show messages sent or received outside Reclaim.',
      measures: [
        { label: 'Follow-ups due', value: due, unit: 'count', source: asrc('counts.byKind.follow_up_due') },
        { label: 'Follow-ups overdue', value: overdue, unit: 'count', source: asrc('counts.byKind.follow_up_overdue') },
      ],
      sourceRefs: followUps.map((i) => ({ id: `case:${i.caseId}`, label: 'Case with a follow-up due' })),
      nextAction: { kind: 'open_attention', target: { category: null, kinds: ['follow_up_due', 'follow_up_overdue'] }, label: 'Open follow-ups', sideEffects: 'none' },
      evidence: { items: followUps.map((i) => [i.id, i.kind]) },
    })
  }
  return out
}

// ---------------------------------------------------------------- rule 7: prevention_guidance

function rulePrevention(inputs: Inputs): Candidate[] {
  const out: Candidate[] = []
  const csrc = (field: string) => ({ model: 'case_snapshot', field, metricDefinitionVersion: RECOVERY_METRIC_VERSION })
  const common = (findingType: string) => ({
    rule: 'prevention_guidance' as const,
    subject: { type: 'account', account: true } as InsightSubject,
    subjectKey: 'account',
    figures: [] as InsightFigure[],
    coverage: pick(inputs.recoveryEnv, ['recovery_cases']),
    freshness: inputs.recoveryEnv.freshness,
    readModels: [readModelRef(inputs.recoveryEnv)],
    severity: 'low' as InsightSeverity,
    severityReason: 'low: guidance only; it does not describe a payment that needs action',
    nextAction: { kind: 'review_prevention' as const, target: { findingType }, label: `Review prevention for ${findingLabel(findingType)}s`, sideEffects: 'none' as const },
  })
  const influenceOf = (cases: CaseSnapshot[]) => [...new Set(cases.flatMap((c) => inputs.influence({ caseId: c.caseId })))].sort(compareText)

  // Recorded root causes on reconciled cases, by finding type.
  const rooted = new Map<string, CaseSnapshot[]>()
  for (const c of inputs.keptCases) {
    if (!c.rootCause?.trim() || c.reconciledAt === null) continue
    rooted.set(c.findingType, [...(rooted.get(c.findingType) ?? []), c])
  }
  for (const type of [...rooted.keys()].sort(compareText)) {
    const list = rooted.get(type)!.sort((a, b) => compareText(a.caseId, b.caseId))
    if (list.length < PREVENTION_MIN_ROOT_CAUSES) continue
    const causes = new Map<string, number>()
    for (const c of list) {
      const cause = c.rootCause!.trim().slice(0, 80)
      causes.set(cause, (causes.get(cause) ?? 0) + 1)
    }
    const ranked = [...causes].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    const causeText = ranked.slice(0, 3).map(([cause, n]) => `"${cause}" ${n}`).join(', ')
    const influencedBy = influenceOf(list)
    const latest = Math.max(...list.map((c) => c.reconciledAt!))
    out.push({
      ...common(type),
      periodKey: `root_cause:${type}`,
      title: `A prevention step to consider for ${findingLabel(type)}s`,
      explanation: `You recorded a cause for ${plural(list.length, `reconciled ${findingLabel(type)} case`)} in the covered records (${causeText}). ${PREVENTION_GUIDANCE[type] ?? DEFAULT_PREVENTION_GUIDANCE}${memorySentence(influencedBy)}`,
      limits: "It is general guidance keyed to the type of check; it does not know your accounting system's settings or whether a control is already in place.",
      period: { from: null, to: calendarDateUtc(latest) },
      measures: [{ label: 'Reconciled cases with a recorded cause', value: list.length, unit: 'count', source: csrc('rootCause') }],
      sourceRefs: list.map((c) => ({ id: `case:${c.caseId}`, label: 'Reconciled case' })),
      influencedBy,
      evidence: { kind: 'root_cause', cases: list.map((c) => [c.caseId, c.rootCause]) },
      expiryAnchor: latest,
    })
  }

  // Repeated dismissals with the same tag, by finding type.
  const dismissed = new Map<string, CaseSnapshot[]>()
  for (const c of inputs.keptCases) {
    if (c.stage !== 'dismissed' || c.dismissal === null) continue
    const tag = c.dismissal.tag ?? 'other'
    const key = `${c.findingType}|${tag}`
    dismissed.set(key, [...(dismissed.get(key) ?? []), c])
  }
  for (const key of [...dismissed.keys()].sort(compareText)) {
    const list = dismissed.get(key)!.sort((a, b) => compareText(a.caseId, b.caseId))
    if (list.length < PREVENTION_MIN_REPEATED_DISMISSALS) continue
    const [type, tag] = key.split('|')
    const label = findingLabel(type)
    const sentence = tag === 'intentional' || tag === 'known_vendor_exception'
      ? `You marked ${plural(list.length, `${label} check`)} in the covered records as intentional or a known exception. If this pattern is expected, recording that context for the vendor helps the next review; nothing is suppressed automatically.`
      : tag === 'not_a_match' || tag === 'detection_error'
        ? `You marked ${plural(list.length, `${label} check`)} in the covered records as not a real match. That is passed on as feedback about the check; nothing is suppressed automatically.`
        : `You dismissed ${plural(list.length, `${label} check`)} in the covered records for the same reason. Recording the context for the vendor helps the next review; nothing is suppressed automatically.`
    const influencedBy = influenceOf(list)
    const latest = Math.max(0, ...list.map((c) => c.updatedAt ?? 0))
    out.push({
      ...common(type),
      periodKey: `dismissals:${type}:${tag}`,
      title: `Repeated dismissals of ${label} checks`,
      explanation: `${sentence}${memorySentence(influencedBy)}`,
      limits: 'It counts your own dismissals; it does not judge whether they were right or change any check.',
      period: { from: null, to: latest > 0 ? calendarDateUtc(latest) : null },
      measures: [{ label: 'Dismissals with this reason', value: list.length, unit: 'count', source: csrc('dismissal.tag') }],
      sourceRefs: list.map((c) => ({ id: `case:${c.caseId}`, label: 'Dismissed case' })),
      influencedBy,
      evidence: { kind: 'dismissals', tag, cases: list.map((c) => c.caseId) },
      expiryAnchor: latest > 0 ? latest : null,
    })
  }
  return out
}

// ---------------------------------------------------------------- assembly

function ruleCoverage(inputs: Inputs): CoverageItem[] {
  const snapshot = legacyReasons(inputs.origin)
  const reasonsOf = (env: ReadModelEnvelope<unknown> | null, checks: string[]) => (env ? env.coverage.filter((c) => checks.includes(c.check)).flatMap((c) => c.reasons) : [COVERAGE_REASONS.NO_DATA])
  const notRun = (env: ReadModelEnvelope<unknown> | null) => !env || env.result === null
  const truncated = (model: string) => (inputs.truncated.includes(model) ? [INSIGHT_REASONS.INPUT_TRUNCATED] : [])
  const noBaselines = (inputs.baselineEnv.result?.baselines.length ?? 0) === 0
  return [
    coverage('insight:approvals_due', [...reasonsOf(inputs.attentionEnv, ['pending_approvals']), ...truncated('attention_queue')]),
    coverage('insight:follow_ups_due', [...reasonsOf(inputs.attentionEnv, ['case_state', 'send_state']), ...truncated('attention_queue')]),
    coverage('insight:import_coverage_gap', reasonsOf(inputs.coverageEnv, ['import_coverage']), notRun(inputs.coverageEnv) && inputs.records.length === 0),
    coverage('insight:prevention_guidance', reasonsOf(inputs.recoveryEnv, ['recovery_cases'])),
    coverage('insight:recurring_payment_visible', [...snapshot, ...(inputs.records.length === 0 ? [COVERAGE_REASONS.NO_DATA] : [])], inputs.records.length === 0),
    coverage('insight:unresolved_recovery', reasonsOf(inputs.recoveryEnv, ['recovery_cases', 'matched_returns'])),
    coverage('insight:vendor_change', [...reasonsOf(inputs.profileEnv, ['recent_change']), ...truncated('vendor_profiles')], inputs.profiles.length === 0),
    coverage('insight:vendor_concentration', [...reasonsOf(inputs.vendorEnv, ['covered_spend']), ...truncated('spend.by_vendor')], notRun(inputs.vendorEnv)),
    coverage('insight:vendor_spend_above_baseline', reasonsOf(inputs.baselineEnv, ['vendor_baselines']), noBaselines),
  ]
}

function checksLimitedCandidate(inputs: Inputs, ruleCov: CoverageItem[]): Candidate | null {
  const limited = ruleCov.filter((c) => c.status !== 'supported')
  if (!limited.length) return null
  const names = limited.map((c) => c.check.replace(/^insight:/, '').replace(/_/g, ' '))
  return {
    rule: 'import_coverage_gap',
    subjectKey: 'account',
    periodKey: 'checks_limited',
    severity: 'low',
    severityReason: 'low: shown so that an empty list is never read as a clean result',
    title: 'Checks ran with limits',
    explanation:
      `No insight met its threshold in the covered records, but that is not a confirmation that payments are in order. ${plural(limited.length, 'check')} ran with limits or could not run: ${names.join(', ')}.` +
      (inputs.origin === 'legacy_audit_snapshot' ? ' The covered records are customer-supplied snapshots, not a continuous ledger.' : ''),
    limits: 'It lists which checks were limited; it does not describe any payment.',
    subject: { type: 'account', account: true },
    period: { from: inputs.coverageEnv.result?.coveredDateRange.from ?? null, to: inputs.dataAsOf },
    figures: [],
    measures: [{ label: 'Limited checks', value: limited.length, unit: 'count', source: { model: INSIGHTS_MODEL, field: 'coverage', metricDefinitionVersion: INSIGHTS_VERSION } }],
    sourceRefs: [],
    coverage: limited,
    freshness: inputs.coverageEnv.freshness,
    readModels: [readModelRef(inputs.coverageEnv)],
    nextAction: { kind: 'review_import_coverage', target: { importId: null, auditIds: [] }, label: 'Review what the covered records include', sideEffects: 'none' },
    influencedBy: [],
    evidence: { kind: 'checks_limited', limited: limited.map((c) => [c.check, c.status, c.reasons]) },
    expiryAnchor: null,
  }
}

function finalize(inputs: Inputs, c: Candidate, state: InsightStateStore): Insight {
  const dedupKey = `${c.rule}|${c.subjectKey}|${c.periodKey}`
  const id = `ins_${c.rule}_${fingerprintOf({ t: inputs.ctx.tenantId, k: dedupKey }).slice(0, 12)}`
  const def = INSIGHT_RULES[c.rule]
  const ruleVersion = `${c.rule}@${def.version}`
  const refs = [...new Map(c.sourceRefs.map((r) => [r.id, r])).values()]
  const evidenceFingerprint = fingerprintOf({ ruleVersion, evidence: c.evidence, influencedBy: c.influencedBy })
  const ttl = INSIGHT_TTL_DAYS[c.rule]
  const expiresAt = ttl !== null && c.expiryAnchor !== null ? c.expiryAnchor + ttl * DAY_MS : null
  let status: InsightStatus = expiresAt !== null && inputs.now >= expiresAt ? 'expired' : 'active'
  let dismissal: Insight['dismissal'] = null
  let previousDismissal: Insight['previousDismissal'] = null
  const d = state.get(inputs.ctx, dedupKey)
  if (d) {
    requireTenant(inputs.ctx, d.tenantId)
    if (d.evidenceFingerprint !== evidenceFingerprint) previousDismissal = { dismissedAt: d.dismissedAt, invalidatedBecause: 'evidence_changed' }
    else if (inputs.now >= d.expiresAt) previousDismissal = { dismissedAt: d.dismissedAt, invalidatedBecause: 'dismissal_expired' }
    else {
      status = 'dismissed'
      dismissal = { dismissedAt: d.dismissedAt, dismissedBy: d.dismissedBy, reason: d.reason, expiresAt: d.expiresAt }
    }
  }
  return {
    id,
    dedupKey,
    tenantId: inputs.ctx.tenantId,
    rule: c.rule,
    ruleVersion,
    insightsVersion: INSIGHTS_VERSION,
    severity: c.severity,
    severityReason: c.severityReason,
    title: c.title,
    explanation: c.explanation,
    limits: c.limits,
    subject: c.subject,
    period: { ...c.period, dataAsOf: inputs.dataAsOf, computedAt: inputs.now },
    figures: c.figures,
    measures: c.measures,
    sourceRefs: refs.slice(0, MAX_INSIGHT_SOURCE_REFS),
    sourceRefCount: refs.length,
    sourceRefsTruncated: refs.length > MAX_INSIGHT_SOURCE_REFS,
    coverage: c.coverage,
    freshness: c.freshness,
    provenance: {
      insightsVersion: INSIGHTS_VERSION,
      contractVersion: INTELLIGENCE_CONTRACT_VERSION,
      origin: inputs.origin,
      readModels: [...c.readModels, ...(c.influencedBy.length ? [{ model: 'memory_influence', metricDefinitionVersion: MEMORY_VERSION }] : [])],
    },
    nextAction: c.nextAction,
    influencedBy: c.influencedBy,
    evidenceFingerprint,
    status,
    expiresAt,
    dismissal,
    previousDismissal,
    advisorySummary: null,
    ai: { status: 'not_requested', reason: null },
  }
}

const SEVERITY_RANK: Readonly<Record<InsightSeverity, number>> = { high: 0, medium: 1, low: 2 }
const STATUS_RANK: Readonly<Record<InsightStatus, number>> = { active: 0, expired: 1, dismissed: 2 }

/**
 * Status (active, expired, dismissed), severity, rule priority, then the first
 * figure: insights with a figure first, grouped by currency code, larger
 * amount first within a currency (never compared across currencies), then id.
 */
export function compareInsights(a: Insight, b: Insight): number {
  const fa = a.figures[0]?.money
  const fb = b.figures[0]?.money
  return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || INSIGHT_RULES[a.rule].priority - INSIGHT_RULES[b.rule].priority
    || Number(Boolean(fb)) - Number(Boolean(fa))
    || (fa && fb ? compareText(fa.currency, fb.currency) || fb.amountMinor - fa.amountMinor : 0)
    || compareText(a.id, b.id)
}

interface Generated {
  inputs: Inputs
  all: Insight[]
  ruleCov: CoverageItem[]
}

function generateAll(ctx: TenantContext, deps: InsightDeps, now: number, options: GenerateInsightsOptions): Generated {
  const inputs = readInputs(ctx, deps, now, options)
  const candidates = [
    ...ruleAboveBaseline(inputs),
    ...ruleRecurring(inputs),
    ...ruleConcentration(inputs),
    ...ruleVendorChange(inputs),
    ...ruleCoverageGap(inputs),
    ...ruleUnresolved(inputs),
    ...ruleAttention(inputs),
    ...rulePrevention(inputs),
  ]
  // Template wording is guarded by tests (FORBIDDEN_INSIGHT_WORDS). Customer-supplied text
  // (vendor names, recorded causes) is quoted as recorded, so no runtime filter is applied here.
  const all = candidates.map((c) => finalize(inputs, c, deps.insightState))
  const ruleCov = ruleCoverage(inputs)
  // Anti-"clean bill of health": when nothing but coverage insights is active, say which checks were limited.
  if (!all.some((i) => i.status === 'active' && i.rule !== 'import_coverage_gap')) {
    const fallback = checksLimitedCandidate(inputs, ruleCov)
    if (fallback) all.push(finalize(inputs, fallback, deps.insightState))
  }
  const seen = new Set<string>()
  const unique = all.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
  return { inputs, all: unique.sort(compareInsights), ruleCov }
}

function parseCursor(cursor: string | null | undefined, total: number): number {
  if (cursor === null || cursor === undefined) return 0
  const m = typeof cursor === 'string' ? /^o:(0|[1-9]\d{0,8})$/.exec(cursor) : null
  if (!m || Number(m[1]) > total) throw new IntelligenceQueryError('cursor', 'cursor is not valid for this query.')
  return Number(m[1])
}

function emptyCounts<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>
}

function buildEnvelope(gen: Generated, options: GenerateInsightsOptions): ReadModelEnvelope<InsightsResult> {
  const { inputs, all } = gen
  const limit = options.limit ?? DEFAULT_INSIGHT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_INSIGHT_LIMIT) throw new IntelligenceQueryError('limit', `limit must be an integer from 1 to ${MAX_INSIGHT_LIMIT}.`)
  const includeDismissed = options.includeDismissed ?? false
  const includeExpired = options.includeExpired ?? true
  const listed = all.filter((i) => (i.status === 'dismissed' ? includeDismissed : i.status === 'expired' ? includeExpired : true))
  const offset = parseCursor(options.cursor, listed.length)
  const page = listed.slice(offset, offset + limit)
  const countsByRule = emptyCounts(INSIGHT_RULE_IDS)
  const countsBySeverity = emptyCounts<InsightSeverity>(['high', 'medium', 'low'])
  const countsByStatus = emptyCounts<InsightStatus>(['active', 'dismissed', 'expired'])
  for (const i of listed) {
    countsByRule[i.rule] += 1
    countsBySeverity[i.severity] += 1
  }
  for (const i of all) countsByStatus[i.status] += 1
  const suppressed = all.filter((i) => i.status === 'dismissed').length
  const warnings: Warning[] = []
  if (inputs.truncated.length) warnings.push({ code: INSIGHT_REASONS.INPUT_TRUNCATED, detail: `Input reads stopped at their bound: ${inputs.truncated.join(', ')}.` })
  const invalidated = all.filter((i) => i.previousDismissal !== null).length
  if (invalidated) warnings.push({ code: 'dismissals_invalidated', detail: `${invalidated} dismissed insight(s) are shown again because their evidence changed or the dismissal expired.` })
  const currencies = [...new Set(listed.flatMap((i) => i.figures.map((f) => f.money.currency)))].sort(compareText)
  const noData = inputs.records.length === 0 && inputs.snapshots.length === 0
  return envelope<InsightsResult>({
    model: INSIGHTS_MODEL,
    metricDefinitionVersion: INSIGHTS_VERSION,
    ctx: inputs.ctx,
    origin: inputs.origin,
    scope: { from: inputs.coverageEnv.result?.coveredDateRange.from ?? null, to: inputs.dataAsOf, dateBasis: 'payment_date', currencies },
    computedAt: inputs.now,
    sourceUpdatedAt: inputs.coverageEnv.freshness.sourceUpdatedAt,
    staleAfterMs: inputs.staleAfterMs,
    coverage: gen.ruleCov,
    sources: INSIGHT_RULE_IDS.map((r) => ({ id: `rule:${INSIGHTS_VERSION}/${r}@${INSIGHT_RULES[r].version}`, label: INSIGHT_RULES[r].description })),
    exclusions: [{ code: 'dismissed_by_user', count: suppressed, amounts: [], detail: 'Insights a person dismissed whose evidence has not changed.' }],
    warnings,
    result: {
      items: page,
      nextCursor: offset + limit < listed.length ? `o:${offset + limit}` : null,
      total: listed.length,
      countsByRule,
      countsBySeverity,
      countsByStatus,
      suppressedByDismissal: suppressed,
      aiSummaries: 'disabled',
      aiOutcomes: { attached: 0, rejected: 0, unavailable: 0 },
      emptyState: listed.length ? null : noData ? 'no_data' : 'none_met_thresholds_in_covered_records',
    },
  })
}

/**
 * Deterministic insights, no AI. Same inputs, same dismiss state and same
 * `now` give identical output. Needs `financial:read` and `cases:read`.
 */
export function generateInsightsSync(ctx: TenantContext, deps: InsightDeps, now: number, options: GenerateInsightsOptions = {}): ReadModelEnvelope<InsightsResult> {
  return buildEnvelope(generateAll(ctx, deps, now, options), options)
}

// ---------------------------------------------------------------- optional AI

/** The minimal packet for one insight: rule text, severity, figures as plain decimals and measures. No names, IDs or record details. */
export function aiPacketFor(insight: Insight): AiTaskRequest {
  return {
    task: 'summarize_insight',
    packet: {
      rule: insight.rule,
      ruleDescription: INSIGHT_RULES[insight.rule].description,
      severity: insight.severity,
      figureLabels: insight.figures.map((f) => f.label.replace(/\d{4}-\d{2}-\d{2}/g, 'a covered date')),
      figureAmounts: insight.figures.map((f) => plainMajor(f.money.amountMinor)),
      figureCurrencies: insight.figures.map((f) => f.money.currency),
      measures: insight.measures.map((m) => `${m.label}: ${m.value} ${m.unit}`),
      limits: insight.limits,
    },
    allowedCitations: [`insight:${insight.id}`],
  }
}

async function attachAdvisory(ctx: TenantContext, ai: AiGatewayPort, insight: Insight): Promise<Insight> {
  const request = aiPacketFor(insight)
  let result
  try {
    result = await ai.run(ctx, request)
  } catch {
    return { ...insight, ai: { status: 'unavailable', reason: 'gateway_error' } }
  }
  if (result.status !== 'ok') return { ...insight, ai: { status: result.status === 'rejected' ? 'rejected' : 'unavailable', reason: result.status } }
  const rejection = rejectUnsupportedAiText(result.text, request, result.citations) ?? (containsForbiddenWording(result.text) ? 'unsupported_claim_wording' : null)
  if (rejection) return { ...insight, ai: { status: 'rejected', reason: rejection } }
  return {
    ...insight,
    advisorySummary: { text: result.text, citations: [...result.citations], model: result.model, invocationId: result.invocationId, task: 'summarize_insight', provenance: 'ai_gateway_advisory' },
    ai: { status: 'attached', reason: null },
  }
}

/**
 * Insights, with optional advisory AI summaries when `deps.ai` is enabled and
 * the tenant policy is not 'off'. The deterministic fields are identical with
 * or without AI; AI text is attached beside them only after validation.
 */
export async function generateInsights(ctx: TenantContext, deps: InsightDeps, now: number, options: GenerateInsightsOptions = {}): Promise<ReadModelEnvelope<InsightsResult>> {
  const env = generateInsightsSync(ctx, deps, now, options)
  const ai = deps.ai
  if (!env.result || !ai || !ai.enabled) return env
  if (ai.policy(ctx) === 'off') return { ...env, result: { ...env.result, aiSummaries: 'policy_off' } }
  const outcomes = { attached: 0, rejected: 0, unavailable: 0 }
  const items: Insight[] = []
  let requested = 0
  for (const item of env.result.items) {
    if (item.status !== 'active' || requested >= AI_MAX_SUMMARIES_PER_CALL) {
      items.push(item)
      continue
    }
    requested += 1
    const next = await attachAdvisory(ctx, ai, item)
    if (next.ai.status === 'attached') outcomes.attached += 1
    else if (next.ai.status === 'rejected') outcomes.rejected += 1
    else outcomes.unavailable += 1
    items.push(next)
  }
  return { ...env, result: { ...env.result, items, aiSummaries: 'requested', aiOutcomes: outcomes } }
}

// ---------------------------------------------------------------- lookups and dismissal

/**
 * One insight by ID, whatever its status (for "why does this insight exist").
 * Deterministic, no AI. Null when it does not exist for this tenant at `now`.
 */
export function findInsight(ctx: TenantContext, deps: InsightDeps, insightId: string, now: number, options: Pick<GenerateInsightsOptions, 'unreadableAuditIds' | 'staleAfterMs'> = {}): Insight | null {
  if (typeof insightId !== 'string' || !/^ins_[a-z_]+_[0-9a-f]{12}$/.test(insightId)) return null
  return generateAll(ctx, deps, now, options).all.find((i) => i.id === insightId) ?? null
}

/** Dismiss an insight by ID. The dismissal holds until its evidence fingerprint changes or it expires. */
export function dismissInsight(ctx: TenantContext, deps: InsightDeps, insightId: string, reason: string, now: number, options: { ttlDays?: number; unreadableAuditIds?: string[] } = {}): InsightDismissal {
  requirePermission(ctx, 'feedback:write')
  const insight = findInsight(ctx, deps, insightId, now, { unreadableAuditIds: options.unreadableAuditIds })
  if (!insight) throw new InsightStateError('not_found', 'No such insight in this account.')
  return deps.insightState.dismiss(ctx, insight, reason, now, { ttlDays: options.ttlDays })
}

// ---------------------------------------------------------------- assistant adapter

/**
 * The view the account assistant (src/intelligence/assistant.ts, `InsightLike`)
 * consumes. Built structurally so neither module imports the other's types.
 * `limits` here are the coverage reason codes the insight relied on; the
 * one-sentence `limitsText` is the insight's own `limits`.
 */
export interface InsightCitationView {
  id: string
  tenantId: string
  rule: string
  title: string
  explanation: string
  sourceRefs: SourceRef[]
  coverage: CoverageItem[]
  limits: string[]
  limitsText: string
  /** `metric` = `<source model>.<source field>`, so a consumer can name each figure with its own fixed wording. */
  figures: Array<MoneyAmount & { metric: string }>
}

export function toCitationView(insight: Insight): InsightCitationView {
  return {
    id: insight.id,
    tenantId: insight.tenantId,
    rule: insight.rule,
    title: insight.title,
    explanation: insight.explanation,
    sourceRefs: insight.sourceRefs.map((r) => ({ ...r })),
    coverage: insight.coverage.map((c) => ({ ...c, reasons: [...c.reasons] })),
    limits: [...new Set(insight.coverage.filter((c) => c.status !== 'supported').flatMap((c) => c.reasons))].sort(compareText),
    limitsText: insight.limits,
    figures: insight.figures.map((f) => ({ ...f.money, metric: `${f.source.model}.${f.source.field}` })),
  }
}

/** An `insightLookup` for the assistant: deterministic, tenant-checked, any status. */
export function insightLookup(deps: InsightDeps, now: number, options: Pick<GenerateInsightsOptions, 'unreadableAuditIds' | 'staleAfterMs'> = {}): (ctx: TenantContext, insightId: string) => InsightCitationView | null {
  return (ctx, insightId) => {
    const insight = findInsight(ctx, deps, insightId, now, options)
    return insight && insight.tenantId === ctx.tenantId ? toCitationView(insight) : null
  }
}
