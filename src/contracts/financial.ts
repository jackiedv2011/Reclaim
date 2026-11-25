/**
 * Shared financial-foundation contracts, v0.1 (proposed).
 *
 * These are the logical interfaces from the shared engineering contract §3,
 * owned by the financial-foundation workstream and consumed by the recovery
 * (Jagan) and product-intelligence (Aditya) workstreams. They are a PROPOSAL
 * until each consuming owner signs off; changing a field's meaning is a
 * breaking change and needs a version bump and a note to the other owners.
 *
 * Rules every implementation of these types follows:
 * - Money is integer minor units with an explicit ISO currency. Null means
 *   unknown, never zero. Mixed currencies are never summed.
 * - Tenant and actor come from the server session, never from a caller.
 * - A candidate, a supported claim, a supplier promise, a customer-recorded
 *   return and an independently matched return are different things and are
 *   never added together or presented as one another.
 * - Unknown evidence is reported as unknown. Missing columns are not zero and
 *   not a clean bill of health.
 *
 * Pure types plus constants only, so both the browser bundle and the Node
 * server (native TS stripping) can import this file with a relative path.
 */

export const FINANCIAL_CONTRACT_VERSION = '0.1.0' as const

// ---------------------------------------------------------------- tenant

export type TenantRole = 'owner' | 'admin' | 'member' | 'viewer'
export type TenantPermission =
  | 'ledger:read'
  | 'ledger:import'
  | 'findings:read'
  | 'cases:write'
  | 'integrations:manage'
  | 'members:manage'
  | 'data:export'
  | 'data:delete'

/** Derived on the server from the session and membership table. Never deserialized from a request. */
export interface TenantContext {
  tenantId: string
  actorUserId: string
  role: TenantRole
  permissions: readonly TenantPermission[]
}

// ---------------------------------------------------------------- source records

export type SourceSystem = 'csv_upload' | 'quickbooks'
/**
 * How far a record can be trusted.
 * - customer_uploaded: a file the customer gave us. Screening evidence, not authenticated.
 * - connector_authenticated: read from the accounting system over an authenticated connection.
 * - independently_verified: confirmed by a second, independent source (bank, supplier statement).
 */
export type ProvenanceClass = 'customer_uploaded' | 'connector_authenticated' | 'independently_verified'
export type SourceRecordKind = 'payment' | 'bill' | 'vendor_credit' | 'deposit' | 'refund' | 'purchase'
export type SourceRecordStatus = 'settled' | 'open' | 'voided' | 'reversed' | 'unknown'
export type ReferenceStrength = 'none' | 'short' | 'strong'

export const SOURCE_NORMALIZATION_VERSION = 1 as const

export interface SourceRecord {
  /** Stable internal ID, unique per tenant for the life of the record. */
  id: string
  tenantId: string
  sourceSystem: SourceSystem
  /** Bank/AP account or QuickBooks realm the record came from; null when the source did not say. */
  sourceAccount: string | null
  /** Import that first introduced this record. */
  importId: string
  /** Transaction ID from the source system, when it has one. */
  sourceNativeId: string | null
  kind: SourceRecordKind
  provenance: ProvenanceClass
  vendorName: string
  /** Canonical supplier key (stable source supplier ID first, else normalized name). */
  vendorKey: string
  referenceRaw: string | null
  referenceNormalized: string | null
  referenceStrength: ReferenceStrength
  /** ISO 4217 code, or null when the source omitted it (USD is NOT assumed). */
  currency: string | null
  amountMinor: number | null
  invoiceAmountMinor: number | null
  /** ISO dates (YYYY-MM-DD). */
  invoiceDate: string | null
  paymentDate: string | null
  status: SourceRecordStatus
  normalizationVersion: number
  /** Canonical fields the source did not provide. Unknown is not the same as empty. */
  unknownFields: string[]
  /** Identity used to recognise the same transaction across imports. */
  identityKey: string
  /** Position in the original file (display/provenance only). */
  sourceRow: number | null
}

// ---------------------------------------------------------------- import coverage

/** Every detection rule the engine runs. Keep in step with src/lib/detection.ts. */
export const DETECTION_RULES = [
  'exact_duplicate',
  'near_duplicate',
  'overpayment',
  'unclaimed_discount',
  'missed_discount',
  'bank_account_change',
  'amount_outlier',
  'shared_invoice_number',
] as const
export type DetectionRule = (typeof DETECTION_RULES)[number]

export type CheckStatus = 'supported' | 'limited' | 'not_run'
export type CoverageReasonCode =
  | 'missing_required_field'
  | 'field_sparse'
  | 'no_settlement_status'
  | 'unsupported_currency'
  | 'mixed_currencies'
  | 'too_few_records'
  | 'single_period'
  | 'no_terms'
  | 'no_bank_details'
  | 'report_type_cannot_establish'
  | 'mapping_unconfirmed'

export interface CoverageReason {
  code: CoverageReasonCode
  /** Plain-language explanation; never contains row values. */
  message: string
  fields?: string[]
}

export interface CheckCoverage {
  rule: DetectionRule
  status: CheckStatus
  requiredFields: string[]
  missingFields: string[]
  reasons: CoverageReason[]
}

export type ReportType = 'payments' | 'bills' | 'bills_with_payments' | 'quickbooks_ledger' | 'unknown'
export type MappingStatus = 'known_format' | 'confirmed' | 'pending_confirmation' | 'conflict'

export type RejectReasonCode =
  | 'missing_vendor'
  | 'missing_payment_date'
  | 'invalid_payment_date'
  | 'missing_amount'
  | 'invalid_amount'
  | 'excess_precision'
  | 'unsupported_currency'
  | 'blank_row'
  | 'other'

export interface ImportCoverage {
  contractVersion: typeof FINANCIAL_CONTRACT_VERSION
  importId: string
  sourceSystem: SourceSystem
  reportType: ReportType
  rows: { total: number; accepted: number; rejected: number }
  rejected: Array<{ row: number; reason: RejectReasonCode }>
  mapping: { status: MappingStatus; mappingId: string | null; version: number | null; pendingFields: string[] }
  dedup: { newRecords: number; alreadyImported: number; repeatedWithinImport: number }
  checks: CheckCoverage[]
  /** ISO date range of accepted payment dates, null when nothing was accepted. */
  dateRange: { from: string; to: string } | null
  currencies: string[]
  sourceAccounts: string[]
  /** When the source data was produced (export time or sync time), if known. */
  freshAsOf: string | null
}

// ---------------------------------------------------------------- matcher

export interface MatchFeature {
  name: string
  /** Contribution to the score, already weighted. */
  weight: number
  /** Human-readable evidence, no raw values beyond what the reviewer can already see. */
  detail: string
}

/** A ranked hint that two records may describe the same obligation. Never a claim. */
export interface MatchCandidate {
  candidateId: string
  sourceRecordIds: [string, string, ...string[]]
  score: number
  features: MatchFeature[]
  algorithmVersion: string
  /** Facts the deterministic gate still needs (distinct settlement, bill linkage, ...). */
  evidenceGaps: string[]
  status: 'candidate'
}

// ---------------------------------------------------------------- returns

export type ReturnMatchStatus =
  /** Exactly one source record fits on every deterministic check. Still needs Jagan's case gate. */
  | 'proposed_source_match'
  /** The customer recorded it; no independent source record was found. */
  | 'customer_recorded'
  | 'unmatched'
  | 'ambiguous'
  | 'conflict'

export interface ReturnMatch {
  requestRef: { projectId: string; findingId: string; requestGeneration: number }
  status: ReturnMatchStatus
  method: 'refund' | 'credit' | 'offset' | null
  linkedSourceRecordIds: string[]
  /** Amount the linked source records evidence toward this request, minor units. */
  amountMinor: number | null
  currency: string | null
  date: string | null
  /** Credit issued but not applied to a bill is not returned value. */
  applied: boolean | null
  rationale: string[]
  /** Other requests that could also claim the same source records. */
  competingRequests: string[]
  algorithmVersion: string
}

// ---------------------------------------------------------------- jobs

export interface JobContext {
  tenantId: string
  operation: string
  idempotencyKey: string
  attempt: number
  checkpoint: string | null
  now: number
}

export interface JobAuditEvent {
  operation: string
  tenantId: string
  outcome: 'succeeded' | 'retry' | 'failed' | 'skipped_duplicate'
  /** Counts only; no row values, tokens or identifiers beyond the tenant. */
  counts: Record<string, number>
}

export interface JobOutcome {
  status: 'succeeded' | 'retry' | 'failed'
  checkpoint: string | null
  retryAfterMs?: number
  /** Bounded, value-free error description. */
  error?: { code: string; message: string }
  audit: JobAuditEvent
}

/** Handler side of the shared job contract. The runner (Jagan) owns scheduling and retries. */
export interface JobHandler<Payload> {
  operation: string
  handle(ctx: JobContext, payload: Payload): Promise<JobOutcome>
}
