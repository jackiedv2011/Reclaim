/**
 * LEGACY AUDIT SNAPSHOT ADAPTER. This is not Sid's canonical ledger and not Jagan's case service.
 *
 * It reads the saved audits a tenant already has (each one a sealed JSON
 * snapshot authored by the browser: audit finding S1) and presents them
 * through the consumer contracts in ../contracts.ts so the read models can be
 * built and tested now. Everything it returns is labelled
 * `origin: 'legacy_audit_snapshot'` and carries the coverage limits that come
 * with it: customer-supplied rows, no settlement status, no continuous
 * history, no independent return matching.
 *
 * Replace it with the real ports when the financial-foundation and recovery
 * workstreams publish them; the read models depend only on the ports.
 *
 * Server-safe: relative `.ts` imports of runtime-portable modules only.
 */
import type { CaseState } from '../../ledger/caseState.ts'
import type { APRecord, Finding } from '../../types.ts'
import { eligiblePotential, verifiedReturned, authorizedOutstanding } from '../../recovery/financials.ts'
import { recoveryNextAction, requiresCustomerAction, recoveryStatusLabel } from '../../recovery/model.ts'
import { latestVendorPosition, VENDOR_STATUS } from '../../recovery/vendorStatus.ts'
import { normalizeVendor, parseDate } from '../../lib/format.ts'
import type {
  CaseReadPort,
  CaseSnapshot,
  CaseStageView,
  FinancialSourcePort,
  ImportCoverage,
  RecurringSeriesView,
  SourceRecord,
  SourceRecordKind,
  SourceSystem,
  TenantContext,
} from '../contracts.ts'
import { calendarDate, normalizeCurrency, requireTenant, stableHash, toMinor } from '../envelope.ts'

export const LEGACY_NORMALIZATION_VERSION = 'legacy-audit-1'

/**
 * Finding types that are not money a supplier owes. Mirrors src/lib/claims.ts
 * (which the server cannot import); a test asserts the two agree.
 */
export const NOT_A_CLAIM_TYPES: ReadonlySet<string> = new Set(['missed_discount', 'bank_account_change', 'shared_invoice_number'])

/** What ProjectStore.list() returns per audit, or the browser's in-memory copy. */
export interface StoredAudit {
  id: string
  name?: string | null
  updatedAt?: number | null
  environment: unknown
}

export interface LegacyAuditSource {
  tenantId: string
  financial: FinancialSourcePort
  cases: CaseReadPort
  /** Saved audits that could not be read; reported as a coverage limit, never silently dropped. */
  unreadableAuditIds: string[]
  newestUpdateAt: number | null
}

type RawRecord = Partial<Omit<APRecord, 'paymentDate' | 'invoiceDate'>> & { id: string; paymentDate?: unknown; invoiceDate?: unknown }
type RawFinding = Partial<Omit<Finding, 'relatedRecords'>> & { id: string; relatedRecords?: Array<{ id: string }> }
interface RawEnvironment {
  records?: RawRecord[]
  imports?: Array<{ id: string; sourceLabel?: string; mode?: string; importedAt?: number; recordCount?: number; skippedCount?: number; detectedColumns?: string[]; quickbooks?: unknown; quickbooksSync?: unknown }>
  result?: { findings?: RawFinding[]; recurringSeries?: Array<{ vendor: string; amount: number; currency: string | null; cadenceDays: number; paymentCount: number; firstPaymentDate: string; lastPaymentDate: string; recordIds: string[] }> }
  caseStates?: Record<string, CaseState>
  updatedAt?: number
}

function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

/**
 * The calendar date the source recorded. The raw cell is re-parsed in this
 * process's zone and read back with the same zone's getters, so a server in a
 * different time zone from the browser that imported the file still lands on
 * the same day. Only when the raw cell is gone does it fall back to the stored
 * instant, and says so.
 */
function sourceDate(record: RawRecord, rawKey: 'payment_date' | 'invoice_date', field: 'paymentDate' | 'invoiceDate'): { date: string | null; fromInstant: boolean } {
  const raw = record.source?.raw?.[rawKey]
  if (typeof raw === 'string') {
    const parsed = parseDate(raw)
    if (parsed) return { date: calendarDate(parsed), fromInstant: false }
  }
  const instant = asDate(record[field])
  return instant ? { date: calendarDate(instant), fromInstant: true } : { date: null, fromInstant: false }
}

function recordKind(record: RawRecord, amountMinor: number): SourceRecordKind {
  const type = record.transactionType?.trim().toLowerCase().replace(/[ -]/g, '_') ?? ''
  if (type === 'refund' || type === 'vendor_refund') return 'refund'
  if (type === 'credit' || type === 'vendor_credit' || type === 'credit_memo') return 'credit'
  if (amountMinor > 0 && (type === '' || ['payment', 'bill_payment', 'billpayment', 'check', 'ach', 'wire', 'card', 'purchase', 'expense'].includes(type))) return 'payment'
  return 'unknown'
}

function systemOf(env: RawEnvironment, batchId: string | undefined, record: RawRecord): SourceSystem {
  if (record.quickbooks) return 'quickbooks'
  const batch = env.imports?.find((b) => b.id === batchId)
  if (batch?.quickbooks || batch?.quickbooksSync) return 'quickbooks'
  if (batch?.mode === 'sample') return 'sample'
  return 'csv'
}

function stageOf(state: CaseState | undefined): CaseStageView {
  if (!state || state.decision === null || state.decision === undefined) return 'unreviewed'
  if (state.recoveryStage) return state.recoveryStage
  if (state.decision === 'needs_info') return 'needs_info'
  if (state.decision === 'expected') return 'dismissed'
  return 'confirmed'
}

function reviveFinding(raw: RawFinding, records: Map<string, APRecord>): Finding {
  return { ...raw, relatedRecords: (raw.relatedRecords ?? []).map((ref) => records.get(ref.id)).filter((r): r is APRecord => Boolean(r)) } as Finding
}

function reviveRecord(raw: RawRecord): APRecord {
  return { ...raw, paymentDate: asDate(raw.paymentDate) ?? new Date(0), invoiceDate: asDate(raw.invoiceDate) } as APRecord
}

interface Parsed {
  audit: StoredAudit
  env: RawEnvironment
  records: APRecord[]
  findings: Finding[]
}

function parseAudit(audit: StoredAudit): Parsed | null {
  const env = audit.environment as RawEnvironment | null
  if (!env || typeof env !== 'object' || !Array.isArray(env.records) || !Array.isArray(env.result?.findings)) return null
  const records = env.records.filter((r) => r && typeof r.id === 'string').map(reviveRecord)
  const byId = new Map(records.map((r) => [r.id, r]))
  const findings = env.result!.findings!.filter((f) => f && typeof f.id === 'string').map((f) => reviveFinding(f, byId))
  return { audit, env, records, findings }
}

/**
 * Build the adapter for one tenant from that tenant's saved audits. The caller
 * (server route or browser) is responsible for loading only this tenant's
 * audits; every port method also refuses a context for any other tenant.
 */
export function createLegacyAuditSource(tenantId: string, audits: StoredAudit[], options: { revisions?: Record<string, number | null> } = {}): LegacyAuditSource {
  const parsed: Parsed[] = []
  const unreadableAuditIds: string[] = []
  for (const audit of [...audits].sort((a, b) => a.id.localeCompare(b.id))) {
    const p = parseAudit(audit)
    if (p) parsed.push(p)
    else unreadableAuditIds.push(audit.id)
  }
  const newestUpdateAt = parsed.reduce<number | null>((max, p) => {
    const at = p.audit.updatedAt ?? p.env.updatedAt ?? null
    return at !== null && (max === null || at > max) ? at : max
  }, null)

  // ---- source records, built once
  const sourceRecords: SourceRecord[] = []
  const recordIdentity = new Map<string, string>() // `${auditId}/${recordId}` -> identityKey
  let overlapCount = 0
  {
    const seenByIdentity = new Map<string, string>() // identityKey -> auditId that first held it
    for (const p of parsed) {
      const ordinal = new Map<string, number>()
      for (const record of p.records) {
        const amountMinor = toMinor(record.amountPaid)
        const raw = record as unknown as RawRecord
        const pay = sourceDate(raw, 'payment_date', 'paymentDate')
        const inv = sourceDate(raw, 'invoice_date', 'invoiceDate')
        const vendorKey = record.canonicalVendorId ?? `vendor_${stableHash(normalizeVendor(record.vendor ?? ''))}`
        const currency = normalizeCurrency(record.currency ?? record.quickbooks?.currency ?? null)
        // Within one audit, identical rows are distinct payments (that is what the
        // duplicate check looks for), so each repeat gets its own ordinal. Across
        // audits the same ordinal is the same row seen again: counted once.
        const base = record.externalTransactionId
          ? `ext|${record.sourceAccount ?? ''}|${record.externalTransactionId.trim().toLowerCase()}`
          : `fp|${normalizeVendor(record.vendor ?? '')}|${(record.invoiceNumber ?? '').trim().toLowerCase()}|${pay.date ?? ''}|${amountMinor}`
        const n = (ordinal.get(base) ?? 0) + 1
        ordinal.set(base, n)
        const identityKey = `${base}#${n}`
        recordIdentity.set(`${p.audit.id}/${record.id}`, identityKey)
        const first = seenByIdentity.get(identityKey)
        if (first !== undefined && first !== p.audit.id) {
          overlapCount += 1
          continue
        }
        seenByIdentity.set(identityKey, p.audit.id)
        const unknownFields: string[] = []
        if (currency === 'UNKNOWN') unknownFields.push('currency')
        if (!pay.date) unknownFields.push('paymentDate')
        if (pay.fromInstant) unknownFields.push('paymentDate.calendar_from_instant')
        if (!record.category?.trim()) unknownFields.push('category')
        unknownFields.push('settlement')
        sourceRecords.push({
          recordId: `${p.audit.id}/${record.id}`,
          tenantId,
          auditId: p.audit.id,
          source: {
            system: systemOf(p.env, record.importBatchId, raw),
            importId: record.importBatchId ?? '',
            accountId: record.sourceAccount ?? null,
            nativeId: record.externalTransactionId ?? null,
            filename: record.source?.filename ?? null,
            rowNumber: record.source?.rowNumber ?? null,
          },
          kind: recordKind(raw, amountMinor),
          vendor: {
            displayName: record.vendor ?? '',
            vendorKey,
            stableSupplierId: record.stableSupplierId ?? record.quickbooks?.vendorId ?? null,
            aliasSuggestion: record.suggestedVendorAlias ?? null,
          },
          invoiceReference: record.invoiceNumber ?? null,
          amountMinor,
          currency,
          paymentDate: pay.date,
          invoiceDate: inv.date,
          category: record.category?.trim() || null,
          settlement: 'unknown',
          identityKey,
          normalizationVersion: LEGACY_NORMALIZATION_VERSION,
          unknownFields,
        })
      }
    }
  }

  const importCoverage: ImportCoverage[] = []
  for (const p of parsed) {
    for (const batch of p.env.imports ?? []) {
      const dates = sourceRecords.filter((r) => r.auditId === p.audit.id && r.source.importId === batch.id && r.paymentDate).map((r) => r.paymentDate!).sort()
      importCoverage.push({
        importId: batch.id,
        auditId: p.audit.id,
        system: batch.quickbooks || batch.quickbooksSync ? 'quickbooks' : batch.mode === 'sample' ? 'sample' : 'csv',
        importedAt: batch.importedAt ?? 0,
        acceptedRows: batch.recordCount ?? 0,
        rejectedRows: batch.skippedCount ?? 0,
        dateRange: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
        detectedColumns: batch.detectedColumns ?? [],
      })
    }
  }

  const recurring: RecurringSeriesView[] = []
  for (const p of parsed) {
    for (const series of p.env.result?.recurringSeries ?? []) {
      const first = p.records.find((r) => r.id === series.recordIds[0])
      const vendorKey = first?.canonicalVendorId ?? `vendor_${stableHash(normalizeVendor(series.vendor))}`
      recurring.push({
        seriesId: `${p.audit.id}/series_${stableHash(series.recordIds.join(','))}`,
        auditId: p.audit.id,
        vendorKey,
        vendorName: series.vendor,
        amount: { currency: normalizeCurrency(series.currency), amountMinor: toMinor(series.amount) },
        cadenceDays: series.cadenceDays,
        paymentCount: series.paymentCount,
        firstPaymentDate: series.firstPaymentDate,
        lastPaymentDate: series.lastPaymentDate,
        sourceRecordIds: series.recordIds.map((id) => `${p.audit.id}/${id}`),
      })
    }
  }

  const financial: FinancialSourcePort = {
    origin: 'legacy_audit_snapshot',
    listSourceRecords(ctx: TenantContext) {
      requireTenant(ctx, tenantId)
      return sourceRecords
    },
    listImportCoverage(ctx: TenantContext) {
      requireTenant(ctx, tenantId)
      return importCoverage
    },
    overlapCount(ctx: TenantContext) {
      requireTenant(ctx, tenantId)
      return overlapCount
    },
    listRecurringSeries(ctx: TenantContext) {
      requireTenant(ctx, tenantId)
      return recurring
    },
  }

  const cases: CaseReadPort = {
    origin: 'legacy_audit_snapshot',
    listCases(ctx: TenantContext, now: number) {
      requireTenant(ctx, tenantId)
      const out: CaseSnapshot[] = []
      for (const p of parsed) {
        for (const finding of p.findings) {
          const state = p.env.caseStates?.[finding.id]
          const stage = stageOf(state)
          const potential = eligiblePotential(finding, p.findings)
          const recorded = state ? verifiedReturned(state) : 0
          const isDuplicateRequest = ['exact_duplicate', 'near_duplicate'].includes(finding.type ?? '') && state?.recoveryStage === 'requested' && state.requestedAmount != null
          // Same test as selectors.recoveries(): a vendor case, otherwise an internal review.
          const internal = potential === null && recorded === 0 && !isDuplicateRequest
          const position = state ? latestVendorPosition(state) : undefined
          const promisedMinor = position && VENDOR_STATUS[position.status].agreed && typeof position.amount === 'number' ? toMinor(position.amount) : null
          const currencies = new Set(finding.relatedRecords.map((r) => normalizeCurrency(r.currency ?? r.quickbooks?.currency ?? null)))
          const currency = finding.currency ? normalizeCurrency(finding.currency) : currencies.size === 1 ? [...currencies][0] : 'UNKNOWN'
          const lastHistoryAt = state?.history?.at(-1)?.at ?? null
          const next = state && stage !== 'unreviewed'
            ? { ...recoveryNextAction(state, now, internal), requiresCustomer: requiresCustomerAction(state, now, internal) }
            : { label: 'Review finding', detail: '', dueAt: null, requiresCustomer: true }
          out.push({
            caseId: `${p.audit.id}/${finding.id}`,
            auditId: p.audit.id,
            findingId: finding.id,
            findingType: finding.type,
            ruleVersion: finding.ruleVersion ?? null,
            vendor: { displayName: finding.vendor, vendorKey: finding.relatedRecords[0]?.canonicalVendorId ?? `vendor_${stableHash(normalizeVendor(finding.vendor ?? ''))}` },
            currency,
            stage,
            isClaim: !NOT_A_CLAIM_TYPES.has(finding.type) && !internal,
            flaggedMinor: toMinor(finding.flaggedAmount ?? finding.dollarImpact),
            supportedPotentialMinor: potential === null ? null : toMinor(potential),
            approvedRequestMinor: state?.approvedAt && state.requestedAmount ? toMinor(state.requestedAmount) : null,
            approvedAt: state?.approvedAt ?? null,
            requestedAt: state?.recoveryRequestedAt ?? null,
            promisedMinor,
            customerRecordedReturnMinor: toMinor(recorded),
            matchedReturnMinor: null,
            outstandingMinor: state ? toMinor(authorizedOutstanding(state)) : 0,
            dismissal: state?.decision === 'expected' ? { tag: state.dismissalTag ?? null, reason: state.reason ?? null } : null,
            rootCause: state?.rootCause ?? null,
            reconciledAt: state?.reconciledAt ?? null,
            nextAction: { label: next.label, dueAt: next.dueAt ?? null, requiresCustomer: next.requiresCustomer },
            statusLabel: stage === 'unreviewed' ? 'Not reviewed' : stage === 'needs_info' ? 'Needs information' : stage === 'dismissed' ? 'Expected' : stage === 'confirmed' && !state?.recoveryStage ? 'Confirmed' : recoveryStatusLabel(state!, internal),
            revision: options.revisions?.[p.audit.id] ?? null,
            sourceRecordIds: finding.relatedRecords.map((r) => `${p.audit.id}/${r.id}`),
            crossAuditKey: `${finding.type}|${finding.relatedRecords.map((r) => recordIdentity.get(`${p.audit.id}/${r.id}`) ?? `${p.audit.id}/${r.id}`).sort().join(',')}`,
            updatedAt: lastHistoryAt ?? state?.decidedAt ?? null,
          })
        }
      }
      return out
    },
  }

  return { tenantId, financial, cases, unreadableAuditIds, newestUpdateAt }
}
