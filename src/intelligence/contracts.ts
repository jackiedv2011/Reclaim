/**
 * Product-intelligence contracts (CPO workstream, v0.1).
 *
 * These are the *consumer-side* shapes the analytics, vendor memory, insight,
 * attention and assistant layers read. They mirror the logical contracts in the
 * shared engineering contract §3. They are proposals: Sid owns the canonical
 * source record, coverage, return matching and tenancy; Jagan owns cases,
 * approvals, jobs and AI execution. Until those services exist, the only
 * implementation is `adapters/legacyAudit.ts` (saved audit snapshots) and the
 * synthetic fixtures. Neither is a completed integration.
 *
 * Rules that every module in src/intelligence follows:
 *  - Money is integer minor units plus an explicit currency. Currencies are
 *    never combined or converted; an unknown currency stays 'UNKNOWN'.
 *  - Candidate, supported claim, supplier promise, customer-recorded return and
 *    independently matched return are separate fields. Nothing sums them.
 *  - Missing data is reported as limited / not_run coverage, never as a clean
 *    result.
 *  - Tenant and actor come from the server session (TenantContext), never from
 *    a request body.
 *  - Nothing here writes financial records, changes case state, sends
 *    anything or calls an external model.
 */

export const INTELLIGENCE_CONTRACT_VERSION = '0.1.1' as const

// ---------------------------------------------------------------- tenancy

export type Permission =
  | 'financial:read'
  | 'cases:read'
  | 'feedback:write'
  | 'insights:refresh'
  | 'assistant:ask'

/**
 * Server-derived. Reclaim has no organisations yet (audit S2), so today
 * tenant = the signed-in user and the actor is the same user. `source` records
 * that, so consumers can tell when Sid's organisation model replaces it.
 */
export interface TenantContext {
  tenantId: string
  actorId: string
  permissions: readonly Permission[]
  source: 'single_user_session' | 'test_fixture'
}

export const SINGLE_USER_PERMISSIONS: readonly Permission[] = ['financial:read', 'cases:read', 'feedback:write', 'insights:refresh', 'assistant:ask']

export function hasPermission(ctx: TenantContext, permission: Permission): boolean {
  return ctx.permissions.includes(permission)
}

// ---------------------------------------------------------------- money

/** ISO 4217 code, upper case, or 'UNKNOWN' when the source did not say. */
export type CurrencyCode = string
export const UNKNOWN_CURRENCY = 'UNKNOWN'

/** One currency's amount. Lists of these are never added across currencies. */
export interface MoneyAmount {
  currency: CurrencyCode
  amountMinor: number
}

// ---------------------------------------------------------------- provenance

/** Where a read model's inputs came from. `fixture` and `legacy_audit_snapshot` are not authoritative ledgers. */
export type DataOrigin = 'canonical_ledger' | 'legacy_audit_snapshot' | 'fixture'

export interface SourceRef {
  /** e.g. `record:<auditId>/<recordId>`, `case:<auditId>/<findingId>`, `import:<auditId>/<batchId>`, `rule:<type>@<version>` */
  id: string
  label: string
}

export type CoverageStatus = 'supported' | 'limited' | 'not_run'

export interface CoverageItem {
  check: string
  status: CoverageStatus
  /** Machine-readable reason codes (see COVERAGE_REASONS). Empty when supported. */
  reasons: string[]
}

/** Reason codes shared by all read models. Add, never repurpose. */
export const COVERAGE_REASONS = {
  NO_DATA: 'no_data',
  CUSTOMER_SUPPLIED_SOURCE: 'customer_supplied_source',
  SNAPSHOT_NOT_CONTINUOUS: 'snapshot_not_continuous',
  MISSING_DATES: 'missing_dates',
  MISSING_CURRENCY: 'missing_currency',
  MIXED_CURRENCY: 'mixed_currency',
  MISSING_CATEGORY: 'missing_category',
  CROSS_AUDIT_OVERLAP: 'cross_audit_overlap',
  INSUFFICIENT_HISTORY: 'insufficient_history',
  NO_INDEPENDENT_RETURN_MATCHING: 'no_independent_return_matching',
  SETTLEMENT_UNVERIFIED: 'settlement_unverified',
  UPSTREAM_CONTRACT_PENDING: 'upstream_contract_pending',
  STALE_SOURCE: 'stale_source',
  REJECTED_ROWS: 'rejected_rows',
  // Registered from the read-model modules (v0.1.1). Add, never repurpose.
  UNREADABLE_SAVED_AUDIT: 'unreadable_saved_audit',
  PERIOD_NOT_COVERED: 'period_not_covered',
  PERIOD_PARTIALLY_COVERED: 'period_partially_covered',
  GATE_CURRENCY_UNSUPPORTED: 'gate_currency_unsupported',
  PROMISE_RETURN_ORDER_UNKNOWN: 'promise_return_order_unknown',
  SEND_STATE_NOT_IN_SNAPSHOT: 'send_state_not_in_snapshot',
  REVALIDATION_NOT_IN_SNAPSHOT: 'revalidation_not_in_snapshot',
  REVISION_UNKNOWN: 'revision_unknown',
  UNMAPPED_CASE_STATE: 'unmapped_case_state',
  TOO_FEW_PAYMENTS: 'too_few_payments',
  TOO_FEW_COVERED_MONTHS: 'too_few_covered_months',
  SEASONAL_MODEL_NOT_IMPLEMENTED: 'seasonal_model_not_implemented',
  NON_POSITIVE_MEDIAN: 'non_positive_median',
  WINDOW_NOT_COVERED: 'window_not_covered',
  VENDOR_NOT_FOUND: 'vendor_not_found',
} as const

export interface Exclusion {
  /** Machine code, e.g. `non_payment_transaction`, `zero_amount`, `retired_record`, `cross_audit_overlap`. */
  code: string
  count: number
  /** Per-currency amounts excluded, when amounts are meaningful. */
  amounts: MoneyAmount[]
  detail: string
}

export interface Warning {
  code: string
  detail: string
}

export interface Freshness {
  computedAt: number
  /** Newest import / update time seen in the inputs; null when there were none. */
  sourceUpdatedAt: number | null
  stale: boolean
  staleReason: string | null
}

export interface ReportingScope {
  /** Inclusive calendar dates, YYYY-MM-DD. Null = everything covered. */
  from: string | null
  to: string | null
  dateBasis: 'payment_date' | 'case_activity' | 'none'
  /** Currencies present in the result, each reported separately. */
  currencies: CurrencyCode[]
}

/**
 * The common read-model envelope (CPO spec P1). Every service returns one,
 * including when the answer is "not enough data": `result` may be null, and
 * `coverage` then says why.
 */
export interface ReadModelEnvelope<T> {
  model: string
  contractVersion: typeof INTELLIGENCE_CONTRACT_VERSION
  /** Bumped whenever the metric's meaning changes; see docs/product-intelligence/metrics.md. */
  metricDefinitionVersion: string
  tenantId: string
  origin: DataOrigin
  scope: ReportingScope
  freshness: Freshness
  coverage: CoverageItem[]
  sources: SourceRef[]
  exclusions: Exclusion[]
  warnings: Warning[]
  result: T | null
}

// ---------------------------------------------------------------- source records (Sid)

export type SourceSystem = 'csv' | 'quickbooks' | 'sample' | 'fixture'
export type SourceRecordKind = 'payment' | 'refund' | 'credit' | 'unknown'

/**
 * Consumer view of Sid's normalized source record. The legacy adapter fills it
 * from a saved audit; fields the audit cannot establish are null and listed in
 * `unknownFields`.
 */
export interface SourceRecord {
  /** Stable within the tenant: `<auditId>/<recordId>` for legacy audits. */
  recordId: string
  tenantId: string
  auditId: string
  source: {
    system: SourceSystem
    importId: string
    accountId: string | null
    nativeId: string | null
    filename: string | null
    rowNumber: number | null
  }
  kind: SourceRecordKind
  vendor: {
    displayName: string
    /** Deterministic key from the source (supplier ID or normalized name). Not a reviewed identity. */
    vendorKey: string
    stableSupplierId: string | null
    /** Fuzzy suggestion only; never merged automatically. */
    aliasSuggestion: string | null
  }
  invoiceReference: string | null
  /** Signed: refunds and credits are negative as the source recorded them. */
  amountMinor: number
  currency: CurrencyCode
  /** Calendar date as recorded in the source, YYYY-MM-DD. */
  paymentDate: string | null
  invoiceDate: string | null
  category: string | null
  /** CSV rows and QuickBooks payments carry no cleared status (quickbooksFacts.ts). */
  settlement: 'unknown'
  /** Cross-audit identity used to count a payment once when two audits hold the same row. */
  identityKey: string
  normalizationVersion: string
  unknownFields: string[]
}

export interface ImportCoverage {
  importId: string
  auditId: string
  system: SourceSystem
  importedAt: number
  acceptedRows: number
  rejectedRows: number
  dateRange: { from: string | null; to: string | null }
  detectedColumns: string[]
}

// ---------------------------------------------------------------- cases (Jagan)

export type CaseStageView = 'unreviewed' | 'needs_info' | 'dismissed' | 'confirmed' | 'requested' | 'recovered' | 'not_recovered'

/**
 * Consumer view of a recovery case. Amounts are kept apart on purpose: a
 * supported potential is not a promise, a promise is not a recorded return,
 * and a customer-recorded return is not an independently matched one.
 */
export interface CaseSnapshot {
  caseId: string
  auditId: string
  findingId: string
  findingType: string
  ruleVersion: number | null
  vendor: { displayName: string; vendorKey: string }
  currency: CurrencyCode
  stage: CaseStageView
  /** The raw recovery stage; null before a recovery or internal review starts (stage then reflects the decision). */
  recoveryStage: 'confirmed' | 'requested' | 'recovered' | 'not_recovered' | null
  /** The evidence gate's classification (`recovery_candidate`, `review_needed`, ...); null on older audits. */
  classification: string | null
  /** The detector suppressed this signal (e.g. recurring or explained); it is not flagged for review. */
  suppressed: boolean
  /** True when the case is a vendor recovery; false for internal reviews and non-claim checks. */
  isClaim: boolean
  /** Rule exposure (flagged value). Never money owed. */
  flaggedMinor: number
  /** Evidence-gate supported amount; null when the gate has not passed. */
  supportedPotentialMinor: number | null
  /** Amount in the customer's approved request; null before approval. */
  approvedRequestMinor: number | null
  approvedAt: number | null
  requestedAt: number | null
  /** Latest supplier statement of intent with an amount; not money. */
  promisedMinor: number | null
  /**
   * The part of the latest supplier commitment not yet covered by returns
   * recorded after it (same rule as selectors.vendorCommitments). Not money.
   */
  promisedOutstandingMinor: number | null
  /** Latest real supplier position code (VendorUpdateStatus), ignoring our own follow-ups. */
  latestVendorStatus: string | null
  contactHold: boolean
  requiresRevalidation: boolean
  activeRequestGeneration: number
  /** Structurally valid customer-entered settlements (financials.validSettlements). Not bank-matched. */
  customerRecordedReturnMinor: number
  /** Always null until Sid's return-match contract exists. */
  matchedReturnMinor: number | null
  outstandingMinor: number
  dismissal: { tag: string | null; reason: string | null } | null
  rootCause: string | null
  reconciledAt: number | null
  nextAction: { label: string; dueAt: number | null; requiresCustomer: boolean }
  statusLabel: string
  revision: number | null
  sourceRecordIds: string[]
  /**
   * The same check on the same source payments, wherever it was saved. Two
   * audits holding one CSV produce two cases with one key; account-wide views
   * count it once.
   */
  crossAuditKey: string
  updatedAt: number | null
}

// ---------------------------------------------------------------- return match (Sid)

export type ReturnMatchStatus = 'proposed' | 'verified' | 'ambiguous' | 'reversed'
export interface ReturnMatch {
  caseId: string
  status: ReturnMatchStatus
  sourceRecordIds: string[]
  method: 'refund' | 'credit' | 'offset'
  amount: MoneyAmount
  date: string
  rationale: string
  algorithmVersion: string
}

// ---------------------------------------------------------------- ports

export interface Page<T> {
  items: T[]
  nextCursor: string | null
}

/** Sid's scoped financial reads. */
export interface FinancialSourcePort {
  readonly origin: DataOrigin
  listSourceRecords(ctx: TenantContext): SourceRecord[]
  listImportCoverage(ctx: TenantContext): ImportCoverage[]
  /** Records the same payment appeared in more than one audit; counted once. */
  overlapCount(ctx: TenantContext): number
  /** Detector recurring series, keyed to source record IDs. */
  listRecurringSeries(ctx: TenantContext): RecurringSeriesView[]
}

/** Jagan's case read service. */
export interface CaseReadPort {
  readonly origin: DataOrigin
  listCases(ctx: TenantContext, now: number): CaseSnapshot[]
}

/** Sid's return matching. `available: false` until it exists; consumers must say so. */
export interface ReturnMatchPort {
  readonly available: boolean
  listMatches(ctx: TenantContext): ReturnMatch[]
}

export const NO_RETURN_MATCHING: ReturnMatchPort = { available: false, listMatches: () => [] }

export interface RecurringSeriesView {
  seriesId: string
  auditId: string
  vendorKey: string
  vendorName: string
  amount: MoneyAmount
  cadenceDays: number
  paymentCount: number
  firstPaymentDate: string
  lastPaymentDate: string
  sourceRecordIds: string[]
}
