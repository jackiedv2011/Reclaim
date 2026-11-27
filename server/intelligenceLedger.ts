/**
 * SERVER LEDGER ADAPTER for the product-intelligence read models (CPO workstream).
 *
 * Presents Sid's tenant-scoped server ledger (server/ledger.ts, behind
 * RECLAIM_SERVER_LEDGER) through the consumer ports in
 * src/intelligence/contracts.ts, so the same read models that run on saved
 * audit snapshots (src/intelligence/adapters/legacyAudit.ts) can run on the
 * canonical ledger instead:
 *
 * - `createServerLedgerSource`: FinancialSourcePort, origin 'canonical_ledger'.
 * - `createLedgerReturnMatchPort`: ReturnMatchPort over
 *   src/reconciliation/returnMatching.ts, fed by the open supplier requests a
 *   CaseReadPort reports and the ledger's return-type records.
 * - `tenantContextFromMembership`: our TenantContext from Sid's organisation
 *   membership (server/tenancy.ts).
 * - `resolveIntelligenceSources`: the per-request choice between ledger and
 *   legacy snapshots, for server/intelligence.ts to call.
 *
 * Honesty rules kept here (same as the legacy adapter):
 * - Money stays integer minor units with an explicit currency; a record with no
 *   currency is 'UNKNOWN', never assumed USD; nothing is converted or summed
 *   across currencies here.
 * - Dates are the calendar dates the ledger stored (YYYY-MM-DD), never instants.
 * - Fields the ledger does not expose (category, settlement) are null/'unknown'
 *   and named in `unknownFields`.
 * - Every port method re-checks the tenant (requireTenant). The ledger reads
 *   themselves run under Sid's server-derived TenantContext, so his
 *   `ledger:read` permission and tenant filter apply as a second check.
 * - A proposed source match is a proposal. Only a case-gate acceptance passed
 *   in by the caller makes a match 'verified'; this module never does.
 *
 * Read-only: nothing here writes a record, a case or a match. Server-safe:
 * relative `.ts` imports only.
 */
import type { DatabaseSync } from 'node:sqlite'
import { listImports, listSourceRecords, type ImportSummary, type LedgerKeys } from './ledger.ts'
import { tenantContextFor } from './tenancy.ts'
import type { ProjectStore } from './projectStore.ts'
import type {
  SourceRecord as LedgerRecord,
  TenantContext as LedgerTenantContext,
  TenantPermission,
} from '../src/contracts/financial.ts'
import { matchReturns, requestKeyOf, type OpenRecoveryRequest, type PreviousReturnLink, type ReturnMatchResult, type ReturnSourceRecord } from '../src/reconciliation/returnMatching.ts'
import { detectFindings } from '../src/lib/detection.ts'
import { normalizeVendor } from '../src/lib/format.ts'
import { checksum } from '../src/lib/sourceIdentity.ts'
import { VENDOR_STATUS } from '../src/recovery/vendorStatus.ts'
import type { VendorUpdateStatus } from '../src/ledger/caseState.ts'
import type { APRecord } from '../src/types.ts'
import {
  COVERAGE_REASONS,
  NO_RETURN_MATCHING,
  SINGLE_USER_PERMISSIONS,
  type CaseReadPort,
  type CaseSnapshot,
  type FinancialSourcePort,
  type ImportCoverage,
  type Permission,
  type RecurringSeriesView,
  type ReturnMatch,
  type ReturnMatchPort,
  type SourceRecord,
  type SourceRecordKind,
  type TenantContext,
} from '../src/intelligence/contracts.ts'
import { normalizeCurrency, requireTenant, stableHash, toMinor } from '../src/intelligence/envelope.ts'
import { createLegacyAuditSource, type LegacyAuditSource, type StoredAudit } from '../src/intelligence/adapters/legacyAudit.ts'

export const LEDGER_ADAPTER_NORMALIZATION_VERSION = 'server-ledger-adapter-1'
/** `auditId` on every ledger-backed record, import and series. The ledger has no audits; refs read `import:server_ledger/<importId>`. */
export const LEDGER_AUDIT_ID = 'server_ledger'
/** Above this many records the reconstructed recurring-series pass is skipped (and reported), so one request stays bounded. */
export const MAX_RECURRING_DETECTION_RECORDS = 25_000
/** Page size used to read the whole tenant ledger (the ledger caps a page at 200). */
const READ_PAGE = 200

/**
 * Coverage reason codes this module adds (string literals, add-never-repurpose).
 * Proposed for registration in COVERAGE_REASONS (src/intelligence/contracts.ts).
 */
export const LEDGER_COVERAGE_REASONS = {
  /** Identical rows inside one import share a ledger identity and are stored once (server/ledger.ts `repeatedWithinImport`). */
  WITHIN_IMPORT_REPEATS_NOT_STORED: 'within_import_repeats_not_stored',
  /** The ledger was too large for the per-request recurring-series pass; no series are reported. */
  RECURRING_DETECTION_SKIPPED: 'recurring_detection_skipped',
  /** Financial figures come from the server ledger; data that exists only in saved audits is not included. */
  SAVED_AUDITS_NOT_IN_LEDGER: 'saved_audits_not_in_ledger',
  /** Saved audits belong to a user, not an organisation; this member cannot see them through the organisation. */
  SAVED_AUDITS_NOT_SHARED: 'saved_audits_not_shared_with_organisation',
} as const

// ---------------------------------------------------------------- vendor key

/**
 * The browser engine's canonical vendor key (src/lib/csv.ts `canonicalVendorId`),
 * rebuilt from the ledger's own key. The ledger keys suppliers as
 * `id:<supplier id>` or `name:<normalized name>`; saved audits, CaseSnapshot
 * and business memory key them as `supplier_<sha>` / `vendor_<sha>`. Using the
 * browser form keeps vendor profiles, cases and memory on one key whichever
 * financial source is active. Deterministic; never merges two suppliers.
 */
export function canonicalVendorKey(record: Pick<LedgerRecord, 'vendorKey' | 'vendorName'>): string {
  if (record.vendorKey.startsWith('id:')) return `supplier_${checksum(record.vendorKey.slice(3).trim().toLowerCase())}`
  return `vendor_${checksum(normalizeVendor(record.vendorName))}`
}

// ---------------------------------------------------------------- record mapping

function kindOf(r: LedgerRecord): SourceRecordKind {
  // A void or reversal moved no money; spend reports it as unclassified, as the legacy adapter does.
  if (r.status === 'voided' || r.status === 'reversed') return 'unknown'
  switch (r.kind) {
    case 'payment':
    case 'purchase':
      return r.amountMinor !== null && r.amountMinor > 0 ? 'payment' : 'unknown'
    case 'refund':
      return 'refund'
    case 'vendor_credit':
      return 'credit'
    // A bill is not a payment, and a deposit is not known to be a supplier return until matched.
    default:
      return 'unknown'
  }
}

/** Sid's SourceRecord as our consumer SourceRecord. Exported for tests. */
export function toIntelligenceRecord(r: LedgerRecord): SourceRecord {
  const currency = normalizeCurrency(r.currency)
  const unknownFields: string[] = []
  if (currency === 'UNKNOWN') unknownFields.push('currency')
  if (r.amountMinor === null) unknownFields.push('amountMinor')
  if (r.paymentDate === null) unknownFields.push('paymentDate')
  // The ledger keeps the category inside the sealed engine row but does not expose it on SourceRecord.
  unknownFields.push('category')
  unknownFields.push('settlement')
  // Our contract has no settled state yet; say the source claimed one rather than drop it or overstate it.
  if (r.status === 'settled') unknownFields.push('settlement.source_reported_settled')
  if (r.kind === 'deposit' || r.kind === 'bill') unknownFields.push(`kind.${r.kind}`)
  for (const field of r.unknownFields) unknownFields.push(`source.${field}`)
  return {
    recordId: r.id,
    tenantId: r.tenantId,
    auditId: LEDGER_AUDIT_ID,
    source: {
      system: r.sourceSystem === 'quickbooks' ? 'quickbooks' : 'csv',
      importId: r.importId,
      accountId: r.sourceAccount,
      nativeId: r.sourceNativeId,
      // The ledger stores the file's label on the import, not the filename on each record.
      filename: null,
      rowNumber: r.sourceRow,
    },
    kind: kindOf(r),
    vendor: {
      displayName: r.vendorName,
      vendorKey: canonicalVendorKey(r),
      stableSupplierId: r.vendorKey.startsWith('id:') ? r.vendorKey.slice(3) : null,
      aliasSuggestion: null,
    },
    invoiceReference: r.referenceRaw,
    amountMinor: r.amountMinor ?? 0,
    currency,
    paymentDate: r.paymentDate,
    invoiceDate: r.invoiceDate,
    category: null,
    settlement: 'unknown',
    // The ledger already counts an identity once per tenant; its identity key is the cross-import key.
    identityKey: r.identityKey,
    normalizationVersion: `${LEDGER_ADAPTER_NORMALIZATION_VERSION}+source-${r.normalizationVersion}`,
    unknownFields,
  }
}

/** Fields named by checks whose inputs were present. The ledger's coverage carries per-check fields, not a column list. */
function detectedColumnsOf(summary: ImportSummary): string[] {
  const present = new Set<string>()
  for (const check of summary.coverage.checks) for (const f of check.requiredFields) if (!check.missingFields.includes(f)) present.add(f)
  return [...present].sort()
}

/** Sid's import summary as our ImportCoverage. Exported for tests. */
export function toIntelligenceImport(summary: ImportSummary): ImportCoverage {
  return {
    importId: summary.importId,
    auditId: LEDGER_AUDIT_ID,
    system: summary.sourceSystem === 'quickbooks' ? 'quickbooks' : 'csv',
    importedAt: summary.createdAt,
    acceptedRows: summary.coverage.rows.accepted,
    rejectedRows: summary.coverage.rows.rejected,
    dateRange: { from: summary.coverage.dateRange?.from ?? null, to: summary.coverage.dateRange?.to ?? null },
    detectedColumns: detectedColumnsOf(summary),
  }
}

// ---------------------------------------------------------------- recurring series

function localDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * The engine row detection needs, rebuilt from the contract fields. Lossy: the
 * ledger does not expose terms, bank digits, company or category, and the
 * transaction type is inferred from kind/status. Recurring series depend only
 * on vendor, amount, date, reference and currency, plus refunds/voids netting,
 * so they come out as the engine would find them except where a company column
 * or an exotic transaction type would have changed grouping.
 */
function engineRow(r: LedgerRecord, index: number): APRecord | null {
  if (r.paymentDate === null || r.amountMinor === null) return null
  const transactionType = r.status === 'voided' ? 'void' : r.status === 'reversed' ? 'reversal' : r.kind === 'refund' ? 'refund' : r.kind === 'vendor_credit' ? 'vendor_credit' : r.kind === 'bill' ? 'bill' : r.kind === 'deposit' ? 'deposit' : null
  return {
    id: r.id,
    importBatchId: r.importId,
    vendor: r.vendorName,
    invoiceNumber: r.referenceRaw,
    invoiceDate: r.invoiceDate ? localDay(r.invoiceDate) : null,
    paymentDate: localDay(r.paymentDate),
    invoiceAmount: r.invoiceAmountMinor === null ? null : r.invoiceAmountMinor / 100,
    amountPaid: r.amountMinor / 100,
    terms: null,
    bankAccountLast4: null,
    category: null,
    rowIndex: index,
    currency: r.currency,
    stableSupplierId: r.vendorKey.startsWith('id:') ? r.vendorKey.slice(3) : null,
    externalTransactionId: r.sourceNativeId,
    sourceAccount: r.sourceAccount,
    transactionType,
    canonicalVendorId: canonicalVendorKey(r),
  }
}

function recurringFromLedger(records: readonly LedgerRecord[]): RecurringSeriesView[] {
  const rows = records.map(engineRow).filter((r): r is APRecord => r !== null)
  if (rows.length === 0) return []
  const byId = new Map(records.map((r) => [r.id, r]))
  return detectFindings(rows).recurringSeries.map((s) => {
    const first = byId.get(s.recordIds[0])
    return {
      seriesId: `${LEDGER_AUDIT_ID}/series_${stableHash(s.recordIds.join(','))}`,
      auditId: LEDGER_AUDIT_ID,
      vendorKey: first ? canonicalVendorKey(first) : `vendor_${checksum(normalizeVendor(s.vendor))}`,
      vendorName: s.vendor,
      amount: { currency: normalizeCurrency(s.currency), amountMinor: toMinor(s.amount) },
      cadenceDays: s.cadenceDays,
      paymentCount: s.paymentCount,
      firstPaymentDate: s.firstPaymentDate,
      lastPaymentDate: s.lastPaymentDate,
      sourceRecordIds: [...s.recordIds],
    }
  }).sort((a, b) => (a.seriesId < b.seriesId ? -1 : a.seriesId > b.seriesId ? 1 : 0))
}

// ---------------------------------------------------------------- financial source

export interface ServerLedgerDeps {
  db: DatabaseSync
  keys: LedgerKeys
  /**
   * The engine's own recurring series for the tenant, when the ledger exposes
   * them (proposed: `deriveFindings(...).recurringSeries`). When absent, the
   * series are re-derived from the contract fields (see `engineRow`).
   */
  recurringSeries?: (tenant: LedgerTenantContext) => RecurringSeriesView[]
}

export interface ServerLedgerSource {
  tenantId: string
  financial: FinancialSourcePort
  /** True once the tenant has at least one ledger import. */
  hasImports(): boolean
  /** Coverage reasons every read model on this source should carry (pass as extraCoverageReasons). */
  coverageReasons(): string[]
  /** Newest import time, for freshness. */
  newestUpdateAt(): number | null
  /** The ledger's own dedup counts, summed over imports. */
  dedup(): { newRecords: number; alreadyImported: number; repeatedWithinImport: number }
  /** Records whose source reported them settled; not representable in our contract yet (settlement stays 'unknown'). */
  settledReportedCount(): number
  /** Sid's records, unmapped (return matching reads them). */
  ledgerRecords(): readonly LedgerRecord[]
  /** Newest `freshAsOf` date any import reports (QuickBooks pulls); null for CSV-only ledgers. */
  dataAsOf(): string | null
}

/**
 * The tenant's server ledger through FinancialSourcePort. Reads are lazy and
 * cached for the life of this object, so build one per request.
 *
 * `tenant` is Sid's TenantContext from `tenantContextFor` (server-derived; never
 * from a request body). Every port method also refuses any of our contexts
 * whose tenantId differs.
 */
export function createServerLedgerSource(deps: ServerLedgerDeps, tenant: LedgerTenantContext): ServerLedgerSource {
  const tenantId = tenant.tenantId
  let imports: ImportSummary[] | null = null
  let raw: LedgerRecord[] | null = null
  let mapped: SourceRecord[] | null = null
  let coverageRows: ImportCoverage[] | null = null
  let series: RecurringSeriesView[] | null = null

  const loadImports = () => (imports ??= listImports(deps.db, deps.keys, tenant))
  const loadRecords = (): LedgerRecord[] => {
    if (raw) return raw
    const out: LedgerRecord[] = []
    let cursor: string | null = null
    do {
      const page = listSourceRecords(deps.db, deps.keys, tenant, { cursor, limit: READ_PAGE })
      out.push(...page.records)
      cursor = page.nextCursor
    } while (cursor !== null)
    // Defence in depth: the ledger filters by tenant; a row from anywhere else is a bug, not data.
    if (out.some((r) => r.tenantId !== tenantId)) throw new Error('Server ledger returned a record for another tenant.')
    return (raw = out)
  }
  const dedup = () => loadImports().reduce((acc, i) => ({
    newRecords: acc.newRecords + i.coverage.dedup.newRecords,
    alreadyImported: acc.alreadyImported + i.coverage.dedup.alreadyImported,
    repeatedWithinImport: acc.repeatedWithinImport + i.coverage.dedup.repeatedWithinImport,
  }), { newRecords: 0, alreadyImported: 0, repeatedWithinImport: 0 })
  const tooLarge = () => !deps.recurringSeries && loadRecords().length > MAX_RECURRING_DETECTION_RECORDS

  const financial: FinancialSourcePort = {
    origin: 'canonical_ledger',
    listSourceRecords(ctx) {
      requireTenant(ctx, tenantId)
      return (mapped ??= loadRecords().map(toIntelligenceRecord))
    },
    listImportCoverage(ctx) {
      requireTenant(ctx, tenantId)
      return (coverageRows ??= loadImports().map(toIntelligenceImport))
    },
    overlapCount(ctx) {
      requireTenant(ctx, tenantId)
      // Rows a later import repeated: stored once by the ledger, the same meaning as a cross-audit repeat.
      return dedup().alreadyImported
    },
    listRecurringSeries(ctx) {
      requireTenant(ctx, tenantId)
      if (series) return series
      if (deps.recurringSeries) return (series = deps.recurringSeries(tenant))
      return (series = tooLarge() ? [] : recurringFromLedger(loadRecords()))
    },
  }

  return {
    tenantId,
    financial,
    hasImports: () => loadImports().length > 0,
    coverageReasons() {
      const reasons = new Set<string>()
      if (loadRecords().some((r) => r.provenance === 'customer_uploaded')) reasons.add(COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE)
      if (dedup().repeatedWithinImport > 0) reasons.add(LEDGER_COVERAGE_REASONS.WITHIN_IMPORT_REPEATS_NOT_STORED)
      if (tooLarge()) reasons.add(LEDGER_COVERAGE_REASONS.RECURRING_DETECTION_SKIPPED)
      return [...reasons].sort()
    },
    newestUpdateAt: () => loadImports().reduce<number | null>((max, i) => (max === null || i.createdAt > max ? i.createdAt : max), null),
    dedup,
    settledReportedCount: () => loadRecords().filter((r) => r.status === 'settled').length,
    ledgerRecords: () => loadRecords(),
    dataAsOf: () => loadImports().map((i) => i.coverage.freshAsOf?.slice(0, 10) ?? null).filter((d): d is string => d !== null).sort().at(-1) ?? null,
  }
}

// ---------------------------------------------------------------- return matching

/** A case-gate acceptance (Jagan's): the gate accepted exactly these source records as returned value for this case. */
export interface AcceptedReturnLink {
  caseId: string
  sourceRecordIds: readonly string[]
}

export interface LedgerReturnMatchInput {
  ledger: ServerLedgerSource
  /** Where the open supplier requests come from (legacy snapshots today, Jagan's case service later). */
  cases: CaseReadPort
  /** The port the cases cite records from; supplies each request's invoice references and source account. */
  caseRecords?: FinancialSourcePort
  now: number
  /** Gate acceptances; without one, a match is never 'verified'. None exist yet. */
  acceptedLinks?: readonly AcceptedReturnLink[]
  /** Links proposed by an earlier run (none are persisted yet); lets the matcher report a later reversal. */
  previousLinks?: readonly PreviousReturnLink[]
}

export interface SkippedRequest {
  caseId: string
  reason: 'not_approved' | 'no_request_date' | 'currency_not_iso' | 'no_amount'
}

export interface LedgerReturnMatchRun {
  matches: ReturnMatch[]
  /** Open supplier requests the matcher could not evaluate, and why. */
  skipped: SkippedRequest[]
  /** The matcher's full output (unmatched and customer-recorded requests, allocations, unallocated records). */
  result: ReturnMatchResult
}

const RETURN_KINDS: ReadonlySet<string> = new Set(['refund', 'vendor_credit', 'deposit'])
const ISO_CURRENCY = /^[A-Z]{3}$/
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function toReturnRecord(r: LedgerRecord): ReturnSourceRecord {
  // The matcher works in positive minor units; the ledger signs refunds negative as the source recorded them.
  return { ...r, kind: r.kind as ReturnSourceRecord['kind'], amountMinor: r.amountMinor === null ? null : Math.abs(r.amountMinor), vendorKey: canonicalVendorKey(r), memoReference: null, appliedToBills: [], reversedBy: null }
}

function returnDay(r: LedgerRecord): string | null {
  return r.kind === 'vendor_credit' ? r.invoiceDate ?? r.paymentDate : r.paymentDate ?? r.invoiceDate
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/**
 * Runs the deterministic return matcher for one tenant: open, approved supplier
 * requests (one per cross-audit case) against the ledger's refund, credit and
 * deposit records. Maps each request outcome to our ReturnMatch:
 *
 * - proposed_source_match → 'proposed' (one entry per method), or 'verified'
 *   when `acceptedLinks` holds the gate's acceptance of exactly those records;
 * - ambiguous → 'ambiguous' (amount 0: nothing is attributed);
 * - conflict → 'reversed' when a previously linked record was voided or
 *   reversed, else 'ambiguous' with the conflict in the rationale;
 * - unmatched / customer_recorded → no entry (customer-recorded returns are
 *   already on CaseSnapshot; credit issued but not applied is not a return).
 *
 * caseId is `<auditId>/<findingId>`, the CaseSnapshot form, because a request's
 * projectId is the saved audit's id.
 */
export function runLedgerReturnMatching(ctx: TenantContext, input: LedgerReturnMatchInput): LedgerReturnMatchRun {
  requireTenant(ctx, input.ledger.tenantId)
  const tenantId = input.ledger.tenantId
  const snapshots = input.cases.listCases(ctx, input.now)
  const caseRecords = new Map((input.caseRecords?.listSourceRecords(ctx) ?? []).map((r) => [r.recordId, r]))

  // One request per cross-audit case, so two saved copies never compete for one refund.
  const groups = new Map<string, CaseSnapshot[]>()
  for (const c of snapshots) groups.set(c.crossAuditKey, [...(groups.get(c.crossAuditKey) ?? []), c])
  const requests: OpenRecoveryRequest[] = []
  const caseOf = new Map<string, string>()
  const skipped: SkippedRequest[] = []
  for (const list of [...groups.values()]) {
    const open = list.filter((c) => c.isClaim && c.stage === 'requested').sort((a, b) => cmp(a.caseId, b.caseId))
    if (open.length === 0) continue
    const c = open[0]
    const why: SkippedRequest['reason'] | null = c.approvedAt === null ? 'not_approved'
      : c.approvedRequestMinor === null || c.approvedRequestMinor <= 0 ? 'no_amount'
      : c.requestedAt === null ? 'no_request_date'
      : !ISO_CURRENCY.test(c.currency) ? 'currency_not_iso' : null
    if (why) {
      skipped.push({ caseId: c.caseId, reason: why })
      continue
    }
    // References and account from every copy's records: a later copy's rows may be the ones the port kept.
    const cited = list.flatMap((copy) => copy.sourceRecordIds).map((id) => caseRecords.get(id)).filter((r): r is SourceRecord => r !== undefined)
    const accounts = [...new Set(cited.map((r) => r.source.accountId).filter((a): a is string => a !== null))]
    const status = c.latestVendorStatus && c.latestVendorStatus in VENDOR_STATUS ? (c.latestVendorStatus as VendorUpdateStatus) : 'requested'
    const request: OpenRecoveryRequest = {
      projectId: c.auditId,
      findingId: c.findingId,
      requestGeneration: c.activeRequestGeneration,
      tenantId,
      vendorKey: c.vendor.vendorKey,
      sourceAccount: accounts.length === 1 ? accounts[0] : null,
      currency: c.currency,
      requestedAmountMinor: c.approvedRequestMinor!,
      requestedAt: utcDay(c.requestedAt!),
      references: [...new Set(cited.map((r) => r.invoiceReference).filter((x): x is string => Boolean(x)))].sort(cmp),
      alreadyRecordedMinor: c.customerRecordedReturnMinor,
      status,
    }
    requests.push(request)
    caseOf.set(requestKeyOf(request), `${c.auditId}/${c.findingId}`)
  }

  const ledgerRecords = input.ledger.ledgerRecords().filter((r) => r.tenantId === tenantId && RETURN_KINDS.has(r.kind))
  const byId = new Map(ledgerRecords.map((r) => [r.id, r]))
  const result = matchReturns(requests, ledgerRecords.map(toReturnRecord), { dataAsOf: input.ledger.dataAsOf(), previousLinks: input.previousLinks })

  const accepted = new Set((input.acceptedLinks ?? []).map((l) => `${l.caseId}|${[...l.sourceRecordIds].sort(cmp).join(',')}`))
  const latest = (ids: readonly string[], fallback: string) => ids.map((id) => byId.get(id)).map((r) => (r ? returnDay(r) : null)).filter((d): d is string => d !== null).sort(cmp).at(-1) ?? fallback
  const matches: ReturnMatch[] = []
  for (const m of result.matches) {
    const caseId = caseOf.get(m.requestKey)
    if (!caseId) continue
    const request = requests.find((r) => requestKeyOf(r) === m.requestKey)!
    const rationale = m.rationale.join('; ')
    const currency = m.currency ?? request.currency
    if (m.status === 'proposed_source_match') {
      const evidencing = result.allocations.filter((a) => a.requestKey === m.requestKey && a.returnedEvidenceMinor > 0)
      for (const method of ['refund', 'credit'] as const) {
        const part = evidencing.filter((a) => a.method === method)
        if (part.length === 0) continue
        const ids = part.map((a) => a.sourceRecordId).sort(cmp)
        matches.push({
          caseId,
          status: accepted.has(`${caseId}|${ids.join(',')}`) ? 'verified' : 'proposed',
          sourceRecordIds: ids,
          method,
          amount: { currency, amountMinor: part.reduce((s, a) => s + a.returnedEvidenceMinor, 0) },
          date: latest(ids, request.requestedAt),
          rationale,
          algorithmVersion: m.algorithmVersion,
        })
      }
    } else if ((m.status === 'ambiguous' || m.status === 'conflict') && m.linkedSourceRecordIds.length > 0) {
      const reversed = m.status === 'conflict' && m.rationale.some((x) => x.startsWith('previously_linked_record_reversed'))
      const ids = [...m.linkedSourceRecordIds].sort(cmp)
      matches.push({
        caseId,
        status: reversed ? 'reversed' : 'ambiguous',
        sourceRecordIds: ids,
        method: ids.every((id) => byId.get(id)?.kind === 'vendor_credit') ? 'credit' : 'refund',
        // Nothing is attributed to a contested or conflicting request.
        amount: { currency, amountMinor: 0 },
        date: latest(ids, request.requestedAt),
        rationale: m.status === 'conflict' && !reversed ? `conflict: ${rationale}` : rationale,
        algorithmVersion: m.algorithmVersion,
      })
    }
  }
  matches.sort((a, b) => cmp(a.caseId, b.caseId) || cmp(a.status, b.status) || cmp(a.sourceRecordIds.join(','), b.sourceRecordIds.join(',')))
  return { matches, skipped: skipped.sort((a, b) => cmp(a.caseId, b.caseId)), result }
}

/**
 * ReturnMatchPort over the server ledger. `available` is true once the tenant
 * has a ledger import: before that there are no return records to match, and
 * "zero matched" would read as a negative finding.
 */
export function createLedgerReturnMatchPort(input: LedgerReturnMatchInput): ReturnMatchPort & { run(ctx: TenantContext): LedgerReturnMatchRun } {
  let cached: LedgerReturnMatchRun | null = null
  const run = (ctx: TenantContext) => {
    requireTenant(ctx, input.ledger.tenantId)
    return (cached ??= runLedgerReturnMatching(ctx, input))
  }
  return {
    get available() {
      return input.ledger.hasImports()
    },
    listMatches(ctx) {
      return run(ctx).matches
    },
    run,
  }
}

// ---------------------------------------------------------------- tenancy

/**
 * Proposed TenantContext.source value for an organisation member who is not the
 * sole owner (contract change requested: add it to the union in
 * src/intelligence/contracts.ts). It grants no implicit rights: attention.ts
 * grants implicit case rights only to 'single_user_session'.
 */
export const ORGANISATION_MEMBER_SOURCE = 'organisation_member' as const

/**
 * Our permissions from Sid's, conservatively:
 * - financial:read ⇐ ledger:read; cases:read ⇐ findings:read (viewer gets only these two);
 * - feedback:write and assistant:ask ⇐ cases:write (member and up);
 * - insights:refresh ⇐ integrations:manage (admin and owner): it schedules tenant work.
 */
export function intelligencePermissionsFor(ledgerPermissions: readonly TenantPermission[]): Permission[] {
  const has = (p: TenantPermission) => ledgerPermissions.includes(p)
  const out: Permission[] = []
  if (has('ledger:read')) out.push('financial:read')
  if (has('findings:read')) out.push('cases:read')
  if (has('cases:write') && has('ledger:read') && has('findings:read')) out.push('feedback:write', 'assistant:ask')
  if (has('integrations:manage') && has('ledger:read') && has('findings:read')) out.push('insights:refresh')
  return SINGLE_USER_PERMISSIONS.filter((p) => out.includes(p))
}

export interface MembershipFacts {
  /** Active (not revoked) members of the organisation. */
  activeMemberCount: number
  /** The account whose personal organisation this is; null for a shared organisation. */
  personalUserId: string | null
}

export interface IntelligenceTenancy {
  ctx: TenantContext
  /** Sid's context, for the ledger reads. */
  ledgerCtx: LedgerTenantContext
  /**
   * Whose saved audits (ProjectStore rows, keyed by user id) belong to this
   * tenant: the personal organisation's own account, and only when that account
   * is the actor. Null otherwise (shared organisations have no saved audits).
   */
  legacyAuditOwnerId: string | null
}

/** Pure mapping from Sid's context plus membership facts. */
export function intelligenceTenancyFrom(ledgerCtx: LedgerTenantContext, facts: MembershipFacts): IntelligenceTenancy {
  const singleUser = ledgerCtx.role === 'owner' && facts.activeMemberCount === 1 && facts.personalUserId === ledgerCtx.actorUserId
  const ctx: TenantContext = {
    tenantId: ledgerCtx.tenantId,
    actorId: ledgerCtx.actorUserId,
    permissions: intelligencePermissionsFor(ledgerCtx.permissions),
    // Runtime value is truthful; the cast stands in for the pending contract change (see ORGANISATION_MEMBER_SOURCE).
    source: singleUser ? 'single_user_session' : (ORGANISATION_MEMBER_SOURCE as unknown as TenantContext['source']),
  }
  return { ctx, ledgerCtx, legacyAuditOwnerId: facts.personalUserId !== null && facts.personalUserId === ledgerCtx.actorUserId ? facts.personalUserId : null }
}

/**
 * Our TenantContext for a signed-in user, from Sid's organisation model. The
 * tenant is the organisation (his `tenantContextFor`: the personal organisation,
 * or `requestedTenantId` only when the user holds an active membership; else a
 * TenantAccessError 404). Throws TenantAccessError; routes map it like ledgerRoutes do.
 */
export function tenantContextFromMembership(db: DatabaseSync, userId: string, requestedTenantId?: string | null): IntelligenceTenancy {
  const ledgerCtx = tenantContextFor(db, userId, requestedTenantId)
  const members = (db.prepare('SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND revoked_at IS NULL').get(ledgerCtx.tenantId) as { n: number }).n
  const personal = (db.prepare('SELECT personal_user_id FROM organizations WHERE id = ?').get(ledgerCtx.tenantId) as { personal_user_id: string | null } | undefined)?.personal_user_id ?? null
  return intelligenceTenancyFrom(ledgerCtx, { activeMemberCount: members, personalUserId: personal })
}

// ---------------------------------------------------------------- per-request choice

export interface IntelligenceSourceDeps {
  db: DatabaseSync
  keys: LedgerKeys
  projects: Pick<ProjectStore, 'listAll' | 'revision'>
  /** config.serverLedger === true */
  serverLedger: boolean
  recurringSeries?: ServerLedgerDeps['recurringSeries']
}

export interface ResolvedIntelligenceSources {
  mode: 'legacy' | 'ledger'
  ctx: TenantContext
  /** Same shape server/intelligence.ts already threads through its routes. */
  source: LegacyAuditSource
  returns: ReturnMatchPort
  /** Add to every envelope (alongside unreadable_saved_audit). */
  extraCoverageReasons: string[]
  ledger: ServerLedgerSource | null
}

function legacyFor(projects: IntelligenceSourceDeps['projects'], tenantId: string, ownerUserId: string | null): LegacyAuditSource {
  if (ownerUserId === null) return createLegacyAuditSource(tenantId, [])
  const { projects: stored, unreadable } = projects.listAll(ownerUserId)
  const audits = stored as unknown as StoredAudit[]
  const revisions = Object.fromEntries(audits.map((a) => [a.id, projects.revision(ownerUserId, a.id)]))
  return createLegacyAuditSource(tenantId, audits, { revisions, unreadableAuditIds: unreadable.map((u) => u.id) })
}

/**
 * Which sources answer this request.
 *
 * - Ledger flag off: exactly today's behaviour. Tenant = the user id, saved
 *   audits for everything, no return matching.
 * - Ledger flag on: tenant = the organisation (Sid's membership check). Cases
 *   come from the personal organisation owner's saved audits (none for anyone
 *   else). Financial figures come from the ledger once it has an import, else
 *   from those saved audits; the two are never added together. Return matching
 *   runs on the ledger once it has an import.
 */
export function resolveIntelligenceSources(deps: IntelligenceSourceDeps, user: { id: string }, requestedTenantId: string | null, now: number): ResolvedIntelligenceSources {
  if (!deps.serverLedger) {
    const ctx: TenantContext = { tenantId: user.id, actorId: user.id, permissions: SINGLE_USER_PERMISSIONS, source: 'single_user_session' }
    return { mode: 'legacy', ctx, source: legacyFor(deps.projects, user.id, user.id), returns: NO_RETURN_MATCHING, extraCoverageReasons: [], ledger: null }
  }
  const tenancy = tenantContextFromMembership(deps.db, user.id, requestedTenantId)
  const { ctx } = tenancy
  const legacy = legacyFor(deps.projects, ctx.tenantId, tenancy.legacyAuditOwnerId)
  const reasons: string[] = []
  if (tenancy.legacyAuditOwnerId === null) reasons.push(LEDGER_COVERAGE_REASONS.SAVED_AUDITS_NOT_SHARED)
  const ledger = createServerLedgerSource({ db: deps.db, keys: deps.keys, recurringSeries: deps.recurringSeries }, tenancy.ledgerCtx)
  if (!ledger.hasImports()) return { mode: 'legacy', ctx, source: legacy, returns: NO_RETURN_MATCHING, extraCoverageReasons: reasons, ledger }
  reasons.push(...ledger.coverageReasons())
  if (legacy.financial.listSourceRecords(ctx).length > 0) reasons.push(LEDGER_COVERAGE_REASONS.SAVED_AUDITS_NOT_IN_LEDGER)
  const source: LegacyAuditSource = {
    tenantId: ctx.tenantId,
    financial: ledger.financial,
    cases: legacy.cases,
    unreadableAuditIds: legacy.unreadableAuditIds,
    newestUpdateAt: Math.max(ledger.newestUpdateAt() ?? 0, legacy.newestUpdateAt ?? 0) || null,
  }
  const returns = createLedgerReturnMatchPort({ ledger, cases: legacy.cases, caseRecords: legacy.financial, now })
  return { mode: 'ledger', ctx, source, returns, extraCoverageReasons: [...new Set(reasons)].sort(), ledger }
}
