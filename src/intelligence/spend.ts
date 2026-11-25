/**
 * Covered spending read models (CPO workstream P1, metric definition `spend-v0.1`).
 *
 * "Spend" here means *recorded AP payments in the covered records*: payment
 * rows the tenant imported, dated by the payment date the source recorded.
 * It is not total company expenses, not cash flow and not profitability.
 * Settlement status is unknown for every source row today, refunds and
 * credits are reported beside gross payments (never netted), and `net` stays
 * null until the financial-foundation owner defines it. These semantics are a
 * CPO proposal pending CTO agreement; see docs/product-intelligence/metrics.md.
 *
 * Pure functions over FinancialSourcePort. Deterministic: same inputs and same
 * `now` give the same output. Money stays in integer minor units per currency
 * and is never added across currencies or converted.
 *
 * Server-safe: relative `.ts` imports only.
 */
import {
  COVERAGE_REASONS,
  UNKNOWN_CURRENCY,
  type CurrencyCode,
  type Exclusion,
  type FinancialSourcePort,
  type ImportCoverage,
  type MoneyAmount,
  type ReadModelEnvelope,
  type SourceRecord,
  type SourceRef,
  type SourceSystem,
  type TenantContext,
  type Warning,
} from './contracts.ts'
import { CurrencyTotals, coverage, envelope, inRange, isCalendarDate, requirePermission } from './envelope.ts'

export const SPEND_METRIC_VERSION = 'spend-v0.1'

/** Reason codes this module adds to COVERAGE_REASONS (string literals; never repurposed). */
export const SPEND_COVERAGE_REASONS = {
  /** No import's date range overlaps the requested period at all. */
  PERIOD_NOT_COVERED: 'period_not_covered',
  /** Part of the requested (or displayed) period lies outside every import's date range. */
  PERIOD_PARTIALLY_COVERED: 'period_partially_covered',
} as const

export const SPEND_EXCLUSION_CODES = {
  MISSING_PAYMENT_DATE: 'missing_payment_date',
  ZERO_AMOUNT: 'zero_amount',
  UNCLASSIFIED_TRANSACTION: 'unclassified_transaction',
  CROSS_AUDIT_OVERLAP: 'cross_audit_overlap',
} as const

export const SPEND_WARNING_CODES = {
  CROSS_AUDIT_OVERLAP: 'cross_audit_overlap_counted_once',
  CALENDAR_DATE_FROM_INSTANT: 'calendar_date_from_instant',
  TREND_TRUNCATED: 'trend_truncated',
} as const

export const NET_UNAVAILABLE_REASON =
  'Net spend is not defined yet. How refunds, credits, voids, reversals and transfers offset payments is a financial-foundation decision; until it is made, refunds and credits are shown separately and never subtracted.'

export const MAX_PAGE_LIMIT = 100
export const DEFAULT_PAGE_LIMIT = 25
/** Source record IDs carried on one breakdown row; the full count is always reported. */
export const MAX_ROW_SOURCE_IDS = 50
/** Longest trend an explicit query may ask for. */
export const MAX_TREND_MONTHS = 120

// ---------------------------------------------------------------- query validation

/** Thrown for a malformed query (bad date, inverted range, bad limit or cursor). Routes map it to 400. */
export class IntelligenceQueryError extends Error {
  readonly code = 'invalid_query' as const
  readonly field: string
  constructor(field: string, message: string) {
    super(message)
    this.field = field
  }
}

export interface SpendQuery {
  /** Inclusive calendar date YYYY-MM-DD, compared with the source's payment date. */
  from?: string | null
  to?: string | null
}

export interface SpendOptions {
  /**
   * Coverage reasons the caller knows about and this module cannot see, e.g.
   * saved audits that could not be read (LegacyAuditSource.unreadableAuditIds).
   */
  extraCoverageReasons?: string[]
  /** Overrides the default freshness basis (newest import time). */
  sourceUpdatedAt?: number | null
  staleAfterMs?: number
}

export interface PageRequest {
  limit?: number
  /** Opaque: pass back the `nextCursor` of the previous page. */
  cursor?: string | null
}

interface Range { from: string | null; to: string | null }

function validateQuery(query: SpendQuery | null | undefined): Range {
  const from = query?.from ?? null
  const to = query?.to ?? null
  if (from !== null && !isCalendarDate(from)) throw new IntelligenceQueryError('from', '`from` must be a calendar date YYYY-MM-DD.')
  if (to !== null && !isCalendarDate(to)) throw new IntelligenceQueryError('to', '`to` must be a calendar date YYYY-MM-DD.')
  if (from !== null && to !== null && from > to) throw new IntelligenceQueryError('from', '`from` must not be after `to`.')
  return { from, to }
}

/** Bounded offset pagination. The cursor is an offset string; anything else is refused. */
export function pageBounds(page: PageRequest | undefined, total: number): { offset: number; limit: number } {
  const limit = page?.limit ?? DEFAULT_PAGE_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw new IntelligenceQueryError('limit', `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`)
  const cursor = page?.cursor ?? null
  if (cursor === null) return { offset: 0, limit }
  if (typeof cursor !== 'string' || !/^(0|[1-9]\d{0,8})$/.test(cursor)) throw new IntelligenceQueryError('cursor', 'cursor is not valid for this query.')
  const offset = Number(cursor)
  if (offset > total) throw new IntelligenceQueryError('cursor', 'cursor is past the end of the results.')
  return { offset, limit }
}

export function nextCursorOf(offset: number, limit: number, total: number): string | null {
  return offset + limit < total ? String(offset + limit) : null
}

// ---------------------------------------------------------------- shared helpers

/** Ordinal comparison: independent of the host's locale data. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Most frequent value; ties go to the alphabetically first. */
export function mostFrequent(values: string[]): string {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0]?.[0] ?? ''
}

/** Share of `part` in `total` as whole basis points, rounded half up, with exact integer arithmetic. */
export function shareBps(part: number, total: number): number {
  if (total <= 0 || part <= 0) return 0
  const p = BigInt(part)
  const t = BigInt(total)
  return Number((p * 20000n + t) / (2n * t))
}

const DAY_MS = 86_400_000
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Date.UTC(y, m - 1, d) / DAY_MS
}
function dateOfDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}
function monthOf(date: string): string {
  return date.slice(0, 7)
}
function nextMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return dateOfDay(Date.UTC(y, m, 1) / DAY_MS - 1)
}

/** Union of import date ranges as sorted, merged day spans (adjacent days join). */
export function coveredSpans(imports: ImportCoverage[]): Range[] {
  const spans = imports
    .filter((i) => i.dateRange.from !== null && i.dateRange.to !== null)
    .map((i) => [dayNumber(i.dateRange.from!), dayNumber(i.dateRange.to!)] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: Array<[number, number]> = []
  for (const [start, end] of spans) {
    const last = merged.at(-1)
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged.map(([s, e]) => ({ from: dateOfDay(s), to: dateOfDay(e) }))
}

/** 'none' | 'partial' | 'full' coverage of [from, to] by the spans. An open end is clipped to the spans' extent. */
function periodCoverage(range: Range, spans: Range[]): 'none' | 'partial' | 'full' {
  if (!spans.length) return 'none'
  const start = dayNumber(range.from ?? spans[0].from!)
  const end = dayNumber(range.to ?? spans.at(-1)!.to!)
  if (end < start) return 'none'
  let coveredDays = 0
  for (const s of spans) {
    const a = Math.max(start, dayNumber(s.from!))
    const b = Math.min(end, dayNumber(s.to!))
    if (b >= a) coveredDays += b - a + 1
  }
  if (coveredDays === 0) return 'none'
  return coveredDays === end - start + 1 ? 'full' : 'partial'
}

function sourceBaseReasons(origin: string): string[] {
  return origin === 'legacy_audit_snapshot' ? [COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS] : []
}

function newestImport(imports: ImportCoverage[]): number | null {
  return imports.reduce<number | null>((max, i) => (i.importedAt > 0 && (max === null || i.importedAt > max) ? i.importedAt : max), null)
}

function importRef(i: ImportCoverage): SourceRef {
  return { id: `import:${i.auditId}/${i.importId}`, label: `${i.system} import, ${i.acceptedRows} rows` }
}

function recordRef(r: SourceRecord): SourceRef {
  return { id: `record:${r.recordId}`, label: `${r.vendor.displayName || 'Unnamed vendor'} ${r.paymentDate ?? 'undated'} ${r.currency} ${r.amountMinor}` }
}

// ---------------------------------------------------------------- record selection

interface Selection {
  range: Range
  records: SourceRecord[]
  imports: ImportCoverage[]
  payments: SourceRecord[]
  /** Refunds and credits with a non-zero amount; amounts reported as absolute values. */
  returns: SourceRecord[]
  exclusions: Exclusion[]
  missingDateCount: number
  fromInstantCount: number
  overlapCount: number
  periodCoverage: 'none' | 'partial' | 'full'
  spans: Range[]
}

class ExclusionTally {
  private readonly byCode = new Map<string, { count: number; totals: CurrencyTotals; detail: string }>()
  add(code: string, detail: string, record: SourceRecord): void {
    const entry = this.byCode.get(code) ?? { count: 0, totals: new CurrencyTotals(), detail }
    entry.count += 1
    entry.totals.add(record.currency, record.amountMinor)
    this.byCode.set(code, entry)
  }
  list(): Exclusion[] {
    return [...this.byCode.entries()].sort((a, b) => compareText(a[0], b[0])).map(([code, e]) => ({ code, count: e.count, amounts: e.totals.list(), detail: e.detail }))
  }
}

/**
 * Pick the records in scope. Precedence per record: a missing payment date
 * (when the view is dated) → out of the date range (silently out of scope) →
 * kind. `periodView` is true for views that place records in time (trend), so
 * undated records are always excluded there.
 */
function select(ctx: TenantContext, port: FinancialSourcePort, query: SpendQuery | null | undefined, periodView: boolean): Selection {
  requirePermission(ctx, 'financial:read')
  const range = validateQuery(query)
  const records = [...port.listSourceRecords(ctx)].sort((a, b) => compareText(a.recordId, b.recordId))
  const imports = [...port.listImportCoverage(ctx)].sort((a, b) => a.importedAt - b.importedAt || compareText(a.auditId, b.auditId) || compareText(a.importId, b.importId))
  const overlapCount = port.overlapCount(ctx)
  const dated = periodView || range.from !== null || range.to !== null
  const tally = new ExclusionTally()
  const payments: SourceRecord[] = []
  const returns: SourceRecord[] = []
  let missingDateCount = 0
  let fromInstantCount = 0
  for (const r of records) {
    if (r.paymentDate === null) {
      if (dated) {
        missingDateCount += 1
        tally.add(SPEND_EXCLUSION_CODES.MISSING_PAYMENT_DATE, 'Rows without a payment date cannot be placed in a period.', r)
        continue
      }
    } else if (!inRange(r.paymentDate, range.from, range.to)) continue
    if (r.amountMinor === 0) {
      tally.add(SPEND_EXCLUSION_CODES.ZERO_AMOUNT, 'Rows with a zero amount.', r)
      continue
    }
    if (r.kind === 'payment' && r.amountMinor > 0) payments.push(r)
    else if (r.kind === 'refund' || r.kind === 'credit') returns.push(r)
    else {
      tally.add(SPEND_EXCLUSION_CODES.UNCLASSIFIED_TRANSACTION, 'Rows whose type is not a payment, refund or credit (for example a negative amount with no type, a void, reversal or transfer). Amounts are signed as recorded.', r)
      continue
    }
    if (r.unknownFields.includes('paymentDate.calendar_from_instant')) fromInstantCount += 1
  }
  const exclusions = tally.list()
  if (overlapCount > 0) {
    exclusions.push({ code: SPEND_EXCLUSION_CODES.CROSS_AUDIT_OVERLAP, count: overlapCount, amounts: [], detail: 'Rows that appeared again in a later saved audit; each was counted once.' })
  }
  const spans = coveredSpans(imports)
  return { range, records, imports, payments, returns, exclusions, missingDateCount, fromInstantCount, overlapCount, periodCoverage: periodCoverage(range, spans), spans }
}

function commonWarnings(sel: Selection): Warning[] {
  const warnings: Warning[] = []
  if (sel.overlapCount > 0) warnings.push({ code: SPEND_WARNING_CODES.CROSS_AUDIT_OVERLAP, detail: `${sel.overlapCount} rows appeared in more than one saved audit and were counted once (matched by vendor, invoice reference, payment date, amount and position in the file).` })
  if (sel.fromInstantCount > 0) warnings.push({ code: SPEND_WARNING_CODES.CALENDAR_DATE_FROM_INSTANT, detail: `${sel.fromInstantCount} rows had no original date cell; their calendar date was read from a stored timestamp and may be a day off.` })
  return warnings
}

function spendReasons(sel: Selection, options: SpendOptions | undefined, origin: string, currencies: string[]): string[] {
  const reasons = [...sourceBaseReasons(origin), COVERAGE_REASONS.SETTLEMENT_UNVERIFIED, ...(options?.extraCoverageReasons ?? [])]
  if (sel.missingDateCount > 0) reasons.push(COVERAGE_REASONS.MISSING_DATES)
  if (currencies.includes(UNKNOWN_CURRENCY)) reasons.push(COVERAGE_REASONS.MISSING_CURRENCY)
  if (currencies.length > 1) reasons.push(COVERAGE_REASONS.MIXED_CURRENCY)
  if (sel.imports.some((i) => i.rejectedRows > 0)) reasons.push(COVERAGE_REASONS.REJECTED_ROWS)
  if ((sel.range.from !== null || sel.range.to !== null) && sel.periodCoverage === 'partial') reasons.push(SPEND_COVERAGE_REASONS.PERIOD_PARTIALLY_COVERED)
  if (sel.payments.length + sel.returns.length === 0) reasons.push(COVERAGE_REASONS.NO_DATA)
  return reasons
}

/** True when the read model has nothing it can honestly total: an empty tenant, or a period no import covers. */
function nothingToReport(sel: Selection): string | null {
  if (sel.records.length === 0 && sel.imports.length === 0) return COVERAGE_REASONS.NO_DATA
  if ((sel.range.from !== null || sel.range.to !== null) && sel.periodCoverage === 'none' && sel.payments.length + sel.returns.length === 0) return SPEND_COVERAGE_REASONS.PERIOD_NOT_COVERED
  return null
}

function currenciesOf(sel: Selection): CurrencyCode[] {
  return [...new Set([...sel.payments, ...sel.returns].map((r) => r.currency))].sort(compareText)
}

function scopeOf(sel: Selection, currencies: CurrencyCode[]) {
  return { from: sel.range.from, to: sel.range.to, dateBasis: 'payment_date' as const, currencies }
}

function freshnessBasis(sel: Selection, options: SpendOptions | undefined): number | null {
  return options?.sourceUpdatedAt !== undefined ? options.sourceUpdatedAt : newestImport(sel.imports)
}

// ---------------------------------------------------------------- spendSummary

export interface SpendCurrencyLine {
  currency: CurrencyCode
  /** Sum of positive payment rows (kind 'payment') dated in the period. */
  grossPaymentsMinor: number
  paymentCount: number
  /** Absolute value of refund and credit rows dated in the period. Never subtracted from gross. */
  recordedRefundsAndCreditsMinor: number
  refundAndCreditCount: number
  /** Distinct vendor keys with at least one included payment in this currency. */
  vendorCount: number
}

export interface SpendSummary {
  basis: 'recorded_ap_payments_in_covered_records'
  byCurrency: SpendCurrencyLine[]
  gross: MoneyAmount[]
  recordedRefundsAndCredits: MoneyAmount[]
  net: null
  netUnavailableReason: string
  paymentCount: number
  refundAndCreditCount: number
  /** Distinct vendor keys with at least one included payment, any currency. */
  vendorCount: number
  settlement: 'unknown'
}

export function spendSummary(ctx: TenantContext, port: FinancialSourcePort, query: SpendQuery | null, now: number, options?: SpendOptions): ReadModelEnvelope<SpendSummary> {
  const sel = select(ctx, port, query, false)
  const currencies = currenciesOf(sel)
  const base = {
    model: 'spend.summary',
    metricDefinitionVersion: SPEND_METRIC_VERSION,
    ctx,
    origin: port.origin,
    scope: scopeOf(sel, currencies),
    computedAt: now,
    sourceUpdatedAt: freshnessBasis(sel, options),
    staleAfterMs: options?.staleAfterMs,
    exclusions: sel.exclusions,
    warnings: commonWarnings(sel),
  }
  const empty = nothingToReport(sel)
  if (empty) {
    return envelope<SpendSummary>({ ...base, coverage: [coverage('covered_spend', [empty, ...sourceBaseReasons(port.origin), ...(options?.extraCoverageReasons ?? [])], true), coverage('net_spend', [COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING], true)], sources: sel.imports.map(importRef), result: null })
  }

  const gross = new CurrencyTotals()
  const refunds = new CurrencyTotals()
  const lines = new Map<string, SpendCurrencyLine>()
  const vendorsByCurrency = new Map<string, Set<string>>()
  const lineFor = (currency: string): SpendCurrencyLine => {
    let line = lines.get(currency)
    if (!line) {
      line = { currency, grossPaymentsMinor: 0, paymentCount: 0, recordedRefundsAndCreditsMinor: 0, refundAndCreditCount: 0, vendorCount: 0 }
      lines.set(currency, line)
    }
    return line
  }
  for (const r of sel.payments) {
    gross.add(r.currency, r.amountMinor)
    lineFor(r.currency).paymentCount += 1
    const set = vendorsByCurrency.get(r.currency) ?? new Set<string>()
    set.add(r.vendor.vendorKey)
    vendorsByCurrency.set(r.currency, set)
  }
  for (const r of sel.returns) {
    refunds.add(r.currency, Math.abs(r.amountMinor))
    lineFor(r.currency).refundAndCreditCount += 1
  }
  for (const line of lines.values()) {
    line.grossPaymentsMinor = gross.get(line.currency)
    line.recordedRefundsAndCreditsMinor = refunds.get(line.currency)
    line.vendorCount = vendorsByCurrency.get(line.currency)?.size ?? 0
  }
  const result: SpendSummary = {
    basis: 'recorded_ap_payments_in_covered_records',
    byCurrency: [...lines.values()].sort((a, b) => compareText(a.currency, b.currency)),
    gross: gross.list(),
    recordedRefundsAndCredits: refunds.list(),
    net: null,
    netUnavailableReason: NET_UNAVAILABLE_REASON,
    paymentCount: sel.payments.length,
    refundAndCreditCount: sel.returns.length,
    vendorCount: new Set(sel.payments.map((r) => r.vendor.vendorKey)).size,
    settlement: 'unknown',
  }
  return envelope({
    ...base,
    coverage: [coverage('covered_spend', spendReasons(sel, options, port.origin, currencies)), coverage('net_spend', [COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING], true)],
    sources: [...sel.imports.map(importRef), ...[...sel.payments, ...sel.returns].sort((a, b) => compareText(a.recordId, b.recordId)).map(recordRef)],
    result,
  })
}

// ---------------------------------------------------------------- breakdown rows (vendor, category)

interface BreakdownAccumulator {
  key: string | null
  currency: string
  names: string[]
  grossMinor: number
  paymentCount: number
  refundsMinor: number
  refundCount: number
  firstPaymentDate: string | null
  lastPaymentDate: string | null
  recordIds: string[]
}

function accumulate(sel: Selection, keyOf: (r: SourceRecord) => string | null, nameOf: (r: SourceRecord) => string | null): BreakdownAccumulator[] {
  const rows = new Map<string, BreakdownAccumulator>()
  const rowFor = (r: SourceRecord): BreakdownAccumulator => {
    const key = keyOf(r)
    const id = `${key === null ? '\u0000' : key}|${r.currency}`
    let row = rows.get(id)
    if (!row) {
      row = { key, currency: r.currency, names: [], grossMinor: 0, paymentCount: 0, refundsMinor: 0, refundCount: 0, firstPaymentDate: null, lastPaymentDate: null, recordIds: [] }
      rows.set(id, row)
    }
    const name = nameOf(r)
    if (name !== null) row.names.push(name)
    row.recordIds.push(r.recordId)
    return row
  }
  for (const r of sel.payments) {
    const row = rowFor(r)
    const next = row.grossMinor + r.amountMinor
    if (!Number.isSafeInteger(next)) throw new RangeError('Total exceeds exact integer arithmetic.')
    row.grossMinor = next
    row.paymentCount += 1
    if (r.paymentDate !== null) {
      if (row.firstPaymentDate === null || r.paymentDate < row.firstPaymentDate) row.firstPaymentDate = r.paymentDate
      if (row.lastPaymentDate === null || r.paymentDate > row.lastPaymentDate) row.lastPaymentDate = r.paymentDate
    }
  }
  for (const r of sel.returns) {
    const row = rowFor(r)
    row.refundsMinor += Math.abs(r.amountMinor)
    row.refundCount += 1
  }
  return [...rows.values()]
}

function currencyTotalsOf(rows: BreakdownAccumulator[]): CurrencyTotals {
  const totals = new CurrencyTotals()
  for (const row of rows) totals.add(row.currency, row.grossMinor)
  return totals
}

function sortRows(rows: BreakdownAccumulator[]): BreakdownAccumulator[] {
  // Currency, then gross descending, then key (a null key, e.g. uncategorized, sorts last within equal gross).
  return rows.sort((a, b) =>
    compareText(a.currency, b.currency) ||
    b.grossMinor - a.grossMinor ||
    (a.key === null ? (b.key === null ? 0 : 1) : b.key === null ? -1 : compareText(a.key, b.key)))
}

function cappedIds(ids: string[]): { sourceRecordIds: string[]; sourceRecordCount: number; sourceRecordIdsTruncated: boolean } {
  const sorted = [...ids].sort(compareText)
  return { sourceRecordIds: sorted.slice(0, MAX_ROW_SOURCE_IDS), sourceRecordCount: sorted.length, sourceRecordIdsTruncated: sorted.length > MAX_ROW_SOURCE_IDS }
}

export interface BreakdownPage<Row> {
  rows: Row[]
  totalRows: number
  nextCursor: string | null
  /** Gross payments per currency across every row (not only this page). */
  currencyTotals: MoneyAmount[]
}

// ---------------------------------------------------------------- spendByVendor

export interface VendorSpendRow {
  vendorKey: string
  /** Most frequent recorded name for this key in scope; ties go to the alphabetically first. */
  displayName: string
  currency: CurrencyCode
  grossPaymentsMinor: number
  paymentCount: number
  recordedRefundsAndCreditsMinor: number
  refundAndCreditCount: number
  firstPaymentDate: string | null
  lastPaymentDate: string | null
  /** This row's gross as a share of the same currency's gross, in basis points (rounded half up). */
  shareOfCurrencyBps: number
  sourceRecordIds: string[]
  sourceRecordCount: number
  sourceRecordIdsTruncated: boolean
}

export function spendByVendor(ctx: TenantContext, port: FinancialSourcePort, query: SpendQuery | null, now: number, page?: PageRequest, options?: SpendOptions): ReadModelEnvelope<BreakdownPage<VendorSpendRow>> {
  const sel = select(ctx, port, query, false)
  const currencies = currenciesOf(sel)
  const base = {
    model: 'spend.by_vendor',
    metricDefinitionVersion: SPEND_METRIC_VERSION,
    ctx,
    origin: port.origin,
    scope: scopeOf(sel, currencies),
    computedAt: now,
    sourceUpdatedAt: freshnessBasis(sel, options),
    staleAfterMs: options?.staleAfterMs,
    exclusions: sel.exclusions,
    warnings: commonWarnings(sel),
  }
  const empty = nothingToReport(sel)
  if (empty) {
    pageBounds(page, 0)
    return envelope<BreakdownPage<VendorSpendRow>>({ ...base, coverage: [coverage('covered_spend', [empty, ...sourceBaseReasons(port.origin), ...(options?.extraCoverageReasons ?? [])], true)], sources: sel.imports.map(importRef), result: null })
  }
  // Display names are chosen per vendor key across all in-scope rows, so a key reads the same in every currency.
  const namesByKey = new Map<string, string[]>()
  for (const r of [...sel.payments, ...sel.returns]) {
    const list = namesByKey.get(r.vendor.vendorKey) ?? []
    list.push(r.vendor.displayName.trim())
    namesByKey.set(r.vendor.vendorKey, list)
  }
  const rows = sortRows(accumulate(sel, (r) => r.vendor.vendorKey, () => null))
  const totals = currencyTotalsOf(rows)
  const { offset, limit } = pageBounds(page, rows.length)
  const pageRows: VendorSpendRow[] = rows.slice(offset, offset + limit).map((row) => ({
    vendorKey: row.key!,
    displayName: mostFrequent(namesByKey.get(row.key!) ?? []) || 'Unnamed vendor',
    currency: row.currency,
    grossPaymentsMinor: row.grossMinor,
    paymentCount: row.paymentCount,
    recordedRefundsAndCreditsMinor: row.refundsMinor,
    refundAndCreditCount: row.refundCount,
    firstPaymentDate: row.firstPaymentDate,
    lastPaymentDate: row.lastPaymentDate,
    shareOfCurrencyBps: shareBps(row.grossMinor, totals.get(row.currency)),
    ...cappedIds(row.recordIds),
  }))
  const byId = new Map(sel.records.map((r) => [r.recordId, r]))
  return envelope({
    ...base,
    coverage: [coverage('covered_spend', spendReasons(sel, options, port.origin, currencies))],
    sources: pageRows.flatMap((row) => row.sourceRecordIds).sort(compareText).map((id) => recordRef(byId.get(id)!)),
    result: { rows: pageRows, totalRows: rows.length, nextCursor: nextCursorOf(offset, limit, rows.length), currencyTotals: totals.list() },
  })
}

// ---------------------------------------------------------------- spendByCategory

export const UNCATEGORIZED_LABEL = 'Uncategorized'

export interface CategorySpendRow {
  /** Lower-cased trimmed category as recorded; null for rows without one. */
  categoryKey: string | null
  /** Most frequent recorded spelling (trimmed, case preserved); 'Uncategorized' for the missing bucket. */
  displayName: string
  /** True for the bucket of rows that had no category. Nothing is inferred. */
  uncategorized: boolean
  currency: CurrencyCode
  grossPaymentsMinor: number
  paymentCount: number
  recordedRefundsAndCreditsMinor: number
  refundAndCreditCount: number
  shareOfCurrencyBps: number
  sourceRecordIds: string[]
  sourceRecordCount: number
  sourceRecordIdsTruncated: boolean
}

export function spendByCategory(ctx: TenantContext, port: FinancialSourcePort, query: SpendQuery | null, now: number, page?: PageRequest, options?: SpendOptions): ReadModelEnvelope<BreakdownPage<CategorySpendRow>> {
  const sel = select(ctx, port, query, false)
  const currencies = currenciesOf(sel)
  const base = {
    model: 'spend.by_category',
    metricDefinitionVersion: SPEND_METRIC_VERSION,
    ctx,
    origin: port.origin,
    scope: scopeOf(sel, currencies),
    computedAt: now,
    sourceUpdatedAt: freshnessBasis(sel, options),
    staleAfterMs: options?.staleAfterMs,
    exclusions: sel.exclusions,
    warnings: commonWarnings(sel),
  }
  const empty = nothingToReport(sel)
  if (empty) {
    pageBounds(page, 0)
    return envelope<BreakdownPage<CategorySpendRow>>({ ...base, coverage: [coverage('covered_spend', [empty, ...sourceBaseReasons(port.origin), ...(options?.extraCoverageReasons ?? [])], true), coverage('category', [empty], true)], sources: sel.imports.map(importRef), result: null })
  }
  const clean = (r: SourceRecord) => r.category?.trim() || null
  const rows = sortRows(accumulate(sel, (r) => clean(r)?.toLowerCase() ?? null, clean))
  const totals = currencyTotalsOf(rows)
  const { offset, limit } = pageBounds(page, rows.length)
  const pageRows: CategorySpendRow[] = rows.slice(offset, offset + limit).map((row) => ({
    categoryKey: row.key,
    displayName: row.key === null ? UNCATEGORIZED_LABEL : mostFrequent(row.names),
    uncategorized: row.key === null,
    currency: row.currency,
    grossPaymentsMinor: row.grossMinor,
    paymentCount: row.paymentCount,
    recordedRefundsAndCreditsMinor: row.refundsMinor,
    refundAndCreditCount: row.refundCount,
    shareOfCurrencyBps: shareBps(row.grossMinor, totals.get(row.currency)),
    ...cappedIds(row.recordIds),
  }))
  const missingCategory = [...sel.payments, ...sel.returns].some((r) => clean(r) === null)
  const byId = new Map(sel.records.map((r) => [r.recordId, r]))
  return envelope({
    ...base,
    coverage: [
      coverage('covered_spend', spendReasons(sel, options, port.origin, currencies)),
      coverage('category', missingCategory ? [COVERAGE_REASONS.MISSING_CATEGORY] : []),
    ],
    sources: pageRows.flatMap((row) => row.sourceRecordIds).sort(compareText).map((id) => recordRef(byId.get(id)!)),
    result: { rows: pageRows, totalRows: rows.length, nextCursor: nextCursorOf(offset, limit, rows.length), currencyTotals: totals.list() },
  })
}

// ---------------------------------------------------------------- spendTrend

export interface SpendTrendMonth {
  month: string
  /** True when at least one import's date range overlaps this month. */
  covered: boolean
}

export interface SpendTrendPoint extends SpendTrendMonth {
  /** Null when the month is not covered by any import (unknown, not zero). */
  grossPaymentsMinor: number | null
  paymentCount: number | null
  recordedRefundsAndCreditsMinor: number | null
  refundAndCreditCount: number | null
}

export interface SpendTrendSeries {
  currency: CurrencyCode
  points: SpendTrendPoint[]
}

export interface SpendTrend {
  granularity: 'month'
  months: SpendTrendMonth[]
  series: SpendTrendSeries[]
}

export function spendTrend(ctx: TenantContext, port: FinancialSourcePort, query: SpendQuery | null, now: number, trend: { granularity: 'month' } = { granularity: 'month' }, options?: SpendOptions): ReadModelEnvelope<SpendTrend> {
  if (trend?.granularity !== 'month') throw new IntelligenceQueryError('granularity', "Only 'month' granularity is supported.")
  const sel = select(ctx, port, query, true)
  const range = sel.range
  if (range.from !== null && range.to !== null) {
    const span = monthsBetween(monthOf(range.from), monthOf(range.to))
    if (span > MAX_TREND_MONTHS) throw new IntelligenceQueryError('to', `A trend can cover at most ${MAX_TREND_MONTHS} months.`)
  }
  const currencies = currenciesOf(sel)
  const warnings = commonWarnings(sel)
  const base = {
    model: 'spend.trend',
    metricDefinitionVersion: SPEND_METRIC_VERSION,
    ctx,
    origin: port.origin,
    scope: scopeOf(sel, currencies),
    computedAt: now,
    sourceUpdatedAt: freshnessBasis(sel, options),
    staleAfterMs: options?.staleAfterMs,
    exclusions: sel.exclusions,
  }
  const empty = nothingToReport(sel)
  if (empty) {
    return envelope<SpendTrend>({ ...base, warnings, coverage: [coverage('covered_spend', [empty, ...sourceBaseReasons(port.origin), ...(options?.extraCoverageReasons ?? [])], true)], sources: sel.imports.map(importRef), result: null })
  }

  // Month axis: the requested period, or the extent of covered spans and dated rows.
  const included = [...sel.payments, ...sel.returns]
  const candidates = [...sel.spans.flatMap((s) => [s.from!, s.to!]), ...included.map((r) => r.paymentDate!)].sort(compareText)
  const firstDate = range.from ?? candidates[0] ?? range.to
  const lastDate = range.to ?? candidates.at(-1) ?? range.from
  let first = firstDate ? monthOf(firstDate) : '9999-12'
  const last = lastDate ? monthOf(lastDate) : '0000-01'
  if (first <= last && monthsBetween(first, last) > MAX_TREND_MONTHS) {
    // Only reachable with an open-ended query; keep the most recent months.
    let m = last
    for (let i = 1; i < MAX_TREND_MONTHS; i++) m = previousMonth(m)
    first = m
    warnings.push({ code: SPEND_WARNING_CODES.TREND_TRUNCATED, detail: `Only the most recent ${MAX_TREND_MONTHS} months are shown.` })
  }
  const months: SpendTrendMonth[] = []
  for (let m = first; m <= last; m = nextMonth(m)) {
    const start = `${m}-01`
    const end = monthEnd(m)
    months.push({ month: m, covered: sel.spans.some((s) => s.from! <= end && s.to! >= start) })
  }

  const series: SpendTrendSeries[] = currencies.map((currency) => {
    const points = months.map((mo): SpendTrendPoint => {
      const pays = sel.payments.filter((r) => r.currency === currency && monthOf(r.paymentDate!) === mo.month)
      const rets = sel.returns.filter((r) => r.currency === currency && monthOf(r.paymentDate!) === mo.month)
      const known = mo.covered || pays.length + rets.length > 0
      const g = new CurrencyTotals()
      for (const r of pays) g.add(currency, r.amountMinor)
      const f = new CurrencyTotals()
      for (const r of rets) f.add(currency, Math.abs(r.amountMinor))
      return {
        ...mo,
        grossPaymentsMinor: known ? g.get(currency) : null,
        paymentCount: known ? pays.length : null,
        recordedRefundsAndCreditsMinor: known ? f.get(currency) : null,
        refundAndCreditCount: known ? rets.length : null,
      }
    })
    return { currency, points }
  })

  const reasons = spendReasons(sel, options, port.origin, currencies)
  if (months.some((m) => !m.covered) || sel.periodCoverage === 'partial') reasons.push(SPEND_COVERAGE_REASONS.PERIOD_PARTIALLY_COVERED)
  return envelope({
    ...base,
    warnings,
    coverage: [coverage('covered_spend', reasons)],
    sources: sel.imports.map(importRef),
    result: { granularity: 'month', months, series },
  })
}

function monthsBetween(a: string, b: string): number {
  const [ya, ma] = a.split('-').map(Number)
  const [yb, mb] = b.split('-').map(Number)
  return (yb - ya) * 12 + (mb - ma) + 1
}
function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

// ---------------------------------------------------------------- importCoverageSummary

export interface ImportCoverageRow {
  importId: string
  auditId: string
  system: SourceSystem
  importedAt: number
  acceptedRows: number
  rejectedRows: number
  dateRange: { from: string | null; to: string | null }
}

export interface ImportCoverageSummary {
  imports: ImportCoverageRow[]
  importCount: number
  acceptedRows: number
  rejectedRows: number
  systems: SourceSystem[]
  /** Earliest and latest payment date any import covers. */
  coveredDateRange: { from: string | null; to: string | null }
  /** Merged spans of import date ranges. */
  coveredSpans: Array<{ from: string; to: string }>
  /** Days between the earliest and latest covered date that no import covers. */
  gaps: Array<{ from: string; to: string }>
  /** Imports with no dated rows (their period is unknown). */
  undatedImportCount: number
  /** Rows seen again in a later saved audit and counted once. */
  crossAuditOverlapRows: number
  newestImportAt: number | null
}

export function importCoverageSummary(ctx: TenantContext, port: FinancialSourcePort, now: number, options?: SpendOptions): ReadModelEnvelope<ImportCoverageSummary> {
  requirePermission(ctx, 'financial:read')
  const imports = [...port.listImportCoverage(ctx)].sort((a, b) => a.importedAt - b.importedAt || compareText(a.auditId, b.auditId) || compareText(a.importId, b.importId))
  const overlap = port.overlapCount(ctx)
  const spans = coveredSpans(imports).map((s) => ({ from: s.from!, to: s.to! }))
  const gaps: Array<{ from: string; to: string }> = []
  for (let i = 1; i < spans.length; i++) gaps.push({ from: dateOfDay(dayNumber(spans[i - 1].to) + 1), to: dateOfDay(dayNumber(spans[i].from) - 1) })
  const undated = imports.filter((i) => i.dateRange.from === null || i.dateRange.to === null).length
  const rejected = imports.reduce((sum, i) => sum + i.rejectedRows, 0)
  const newest = options?.sourceUpdatedAt !== undefined ? options.sourceUpdatedAt : newestImport(imports)
  const reasons = [...sourceBaseReasons(port.origin), ...(options?.extraCoverageReasons ?? [])]
  if (rejected > 0) reasons.push(COVERAGE_REASONS.REJECTED_ROWS)
  if (undated > 0) reasons.push(COVERAGE_REASONS.MISSING_DATES)
  if (gaps.length > 0) reasons.push(SPEND_COVERAGE_REASONS.PERIOD_PARTIALLY_COVERED)
  const warnings: Warning[] = overlap > 0 ? [{ code: SPEND_WARNING_CODES.CROSS_AUDIT_OVERLAP, detail: `${overlap} rows appeared in more than one saved audit and were counted once.` }] : []
  const systems = [...new Set(imports.map((i) => i.system))].sort(compareText) as SourceSystem[]
  return envelope<ImportCoverageSummary>({
    model: 'spend.import_coverage',
    metricDefinitionVersion: SPEND_METRIC_VERSION,
    ctx,
    origin: port.origin,
    scope: { from: spans[0]?.from ?? null, to: spans.at(-1)?.to ?? null, dateBasis: 'payment_date', currencies: [] },
    computedAt: now,
    sourceUpdatedAt: newest,
    staleAfterMs: options?.staleAfterMs,
    coverage: [imports.length === 0 ? coverage('import_coverage', [COVERAGE_REASONS.NO_DATA, ...reasons], true) : coverage('import_coverage', reasons)],
    sources: imports.map(importRef),
    exclusions: overlap > 0 ? [{ code: SPEND_EXCLUSION_CODES.CROSS_AUDIT_OVERLAP, count: overlap, amounts: [], detail: 'Rows that appeared again in a later saved audit; each was counted once.' }] : [],
    warnings,
    result: imports.length === 0 ? null : {
      imports: imports.map((i) => ({ importId: i.importId, auditId: i.auditId, system: i.system, importedAt: i.importedAt, acceptedRows: i.acceptedRows, rejectedRows: i.rejectedRows, dateRange: { ...i.dateRange } })),
      importCount: imports.length,
      acceptedRows: imports.reduce((sum, i) => sum + i.acceptedRows, 0),
      rejectedRows: rejected,
      systems,
      coveredDateRange: { from: spans[0]?.from ?? null, to: spans.at(-1)?.to ?? null },
      coveredSpans: spans,
      gaps,
      undatedImportCount: undated,
      crossAuditOverlapRows: overlap,
      newestImportAt: newestImport(imports),
    },
  })
}
