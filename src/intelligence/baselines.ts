/**
 * Deterministic vendor baselines (CPO workstream P2), version `baseline-v0.1`.
 *
 * A baseline describes what payments to one vendor, in one currency, have
 * looked like *in the covered records*: how many, over how many calendar
 * months, the median payment, its spread (median absolute deviation) and the
 * median gap between payments. It is presentation and insight input only.
 * It does not change, and must not be used to change, the detection rules or
 * their thresholds (src/lib/detection.ts is owned by the financial-foundation
 * workstream).
 *
 * Every threshold is an exported constant so the UI and the metric doc can
 * show it, and changing any of them means bumping BASELINE_VERSION.
 *
 * Server-safe: relative `.ts` imports of src/intelligence modules only.
 */
import {
  COVERAGE_REASONS,
  UNKNOWN_CURRENCY,
  type CoverageItem,
  type CurrencyCode,
  type FinancialSourcePort,
  type ReadModelEnvelope,
  type SourceRecord,
  type SourceRef,
  type TenantContext,
} from './contracts.ts'
import { coverage, envelope, requirePermission, requireTenant } from './envelope.ts'

export const BASELINE_VERSION = 'baseline-v0.1'

/** A baseline needs at least this many dated payments to be "established". */
export const BASELINE_MIN_PAYMENTS = 5
/** ...spread over at least this many distinct calendar months. */
export const BASELINE_MIN_COVERED_MONTHS = 3
/**
 * Seasonal comparison needs two full yearly cycles of the vendor's own
 * payments. The 25 Nov audit asks for at least 12 months before any seasonal
 * modelling; one cycle cannot separate a season from a one-off change, so we
 * require 24. No seasonal model is implemented in v0.1 either way.
 */
export const SEASONAL_MIN_MONTHS = 24
/** Range = median ± max(k · MAD, minimum tolerance). */
export const BASELINE_MAD_K = 3
/**
 * Minimum half-width of the range, in basis points of the median. Handles
 * MAD = 0 (every payment identical, e.g. rent): without a floor, a one-cent
 * difference would read as "above range".
 */
export const BASELINE_MIN_TOLERANCE_BPS = 500

/** Baseline-specific reason codes (in addition to COVERAGE_REASONS). */
export const BASELINE_REASONS = {
  TOO_FEW_PAYMENTS: 'too_few_payments',
  TOO_FEW_COVERED_MONTHS: 'too_few_covered_months',
  SEASONAL_MODEL_NOT_IMPLEMENTED: 'seasonal_model_not_implemented',
  NON_POSITIVE_MEDIAN: 'non_positive_median',
} as const

export type BaselineStatus = 'established' | 'insufficient_history'

export interface VendorBaseline {
  version: typeof BASELINE_VERSION
  vendorKey: string
  currency: CurrencyCode
  status: BaselineStatus
  /** Sorted, unique. Always contains `insufficient_history` when status is insufficient. */
  reasons: string[]
  /** Dated payments (kind 'payment', amount > 0) in the sample. */
  paymentCount: number
  /** Payments without a payment date: left out of every statistic below. */
  undatedPaymentCount: number
  /** Distinct calendar months (YYYY-MM) with at least one payment in the sample. */
  coveredMonths: number
  firstPaymentDate: string | null
  lastPaymentDate: string | null
  /**
   * Median payment in minor units. Even sample size: the LOWER of the two
   * middle values (no averaging, so the result is always an integer that
   * actually occurred). Descriptive even when status is insufficient.
   */
  medianPaymentMinor: number | null
  /** Median absolute deviation from the median, same lower-middle rule. */
  madMinor: number | null
  /** Median days between consecutive dated payments (lower-middle rule); null with fewer than two. */
  medianGapDays: number | null
  /** Half-width of the comparison range; null unless established. */
  toleranceMinor: number | null
  lowerBoundMinor: number | null
  upperBoundMinor: number | null
  seasonal: { status: 'not_supported'; reasons: string[]; requiredCoveredMonths: number; coveredMonths: number }
  sourceRecordIds: string[]
}

export type BaselineComparisonLabel = 'within_range' | 'above_range' | 'below_range' | 'insufficient_history'

export interface BaselineComparison {
  label: BaselineComparisonLabel
  /** amount / median in basis points (10000 = equal to the median), rounded half away from zero; null when not comparable. */
  ratioBps: number | null
  lowerBoundMinor: number | null
  upperBoundMinor: number | null
  reasons: string[]
  baselineVersion: typeof BASELINE_VERSION
}

// ---------------------------------------------------------------- helpers

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Lower-middle median of integers; null for an empty list. */
export function lowerMedian(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)]
}

function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000)
}

export function daysBetweenDates(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from)
}

/** Integer basis points of a/b, rounded half away from zero. Exact for safe integers. */
export function ratioBps(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null
  const n = BigInt(numerator) * 10000n
  const d = BigInt(denominator)
  const sign = (n < 0n) !== (d < 0n) ? -1n : 1n
  const an = n < 0n ? -n : n
  const ad = d < 0n ? -d : d
  const q = (2n * an + ad) / (2n * ad)
  return Number(sign * q)
}

function isBaselinePayment(r: SourceRecord): boolean {
  return r.kind === 'payment' && r.amountMinor > 0
}

// ---------------------------------------------------------------- computation

/**
 * Baseline for one (vendorKey, currency). `records` may contain anything; only
 * payments to that vendor in that currency are used. Pure and deterministic.
 */
export function computeBaseline(vendorKey: string, currency: CurrencyCode, records: readonly SourceRecord[]): VendorBaseline {
  const sample = records
    .filter((r) => isBaselinePayment(r) && r.vendor.vendorKey === vendorKey && r.currency === currency)
    .sort((a, b) => cmp(a.paymentDate ?? '', b.paymentDate ?? '') || cmp(a.recordId, b.recordId))
  const dated = sample.filter((r) => r.paymentDate !== null)
  const undatedPaymentCount = sample.length - dated.length
  const amounts = dated.map((r) => r.amountMinor)
  const median = lowerMedian(amounts)
  const mad = median === null ? null : lowerMedian(amounts.map((a) => Math.abs(a - median)))
  const gaps = dated.slice(1).map((r, i) => daysBetweenDates(dated[i].paymentDate!, r.paymentDate!))
  const medianGapDays = lowerMedian(gaps)
  const months = new Set(dated.map((r) => r.paymentDate!.slice(0, 7)))

  const reasons: string[] = []
  if (dated.length < BASELINE_MIN_PAYMENTS) reasons.push(BASELINE_REASONS.TOO_FEW_PAYMENTS)
  if (months.size < BASELINE_MIN_COVERED_MONTHS) reasons.push(BASELINE_REASONS.TOO_FEW_COVERED_MONTHS)
  if (median !== null && median <= 0) reasons.push(BASELINE_REASONS.NON_POSITIVE_MEDIAN)
  if (currency === UNKNOWN_CURRENCY) reasons.push(COVERAGE_REASONS.MISSING_CURRENCY)
  const insufficient = reasons.length > 0
  if (insufficient) reasons.push(COVERAGE_REASONS.INSUFFICIENT_HISTORY)
  if (undatedPaymentCount > 0) reasons.push(COVERAGE_REASONS.MISSING_DATES)

  let toleranceMinor: number | null = null
  let lowerBoundMinor: number | null = null
  let upperBoundMinor: number | null = null
  if (!insufficient && median !== null && mad !== null) {
    const floor = Number((BigInt(median) * BigInt(BASELINE_MIN_TOLERANCE_BPS) + 9999n) / 10000n) // ceil
    toleranceMinor = Math.max(BASELINE_MAD_K * mad, floor)
    lowerBoundMinor = median - toleranceMinor
    upperBoundMinor = median + toleranceMinor
  }

  return {
    version: BASELINE_VERSION,
    vendorKey,
    currency,
    status: insufficient ? 'insufficient_history' : 'established',
    reasons: [...new Set(reasons)].sort(),
    paymentCount: dated.length,
    undatedPaymentCount,
    coveredMonths: months.size,
    firstPaymentDate: dated[0]?.paymentDate ?? null,
    lastPaymentDate: dated.at(-1)?.paymentDate ?? null,
    medianPaymentMinor: median,
    madMinor: mad,
    medianGapDays,
    toleranceMinor,
    lowerBoundMinor,
    upperBoundMinor,
    seasonal: {
      status: 'not_supported',
      reasons: months.size < SEASONAL_MIN_MONTHS ? [COVERAGE_REASONS.INSUFFICIENT_HISTORY] : [BASELINE_REASONS.SEASONAL_MODEL_NOT_IMPLEMENTED],
      requiredCoveredMonths: SEASONAL_MIN_MONTHS,
      coveredMonths: months.size,
    },
    sourceRecordIds: sample.map((r) => r.recordId),
  }
}

/** One baseline per (vendorKey, currency) that has at least one payment. Sorted by vendorKey, then currency. */
export function computeVendorBaselines(records: readonly SourceRecord[]): VendorBaseline[] {
  const keys = new Map<string, { vendorKey: string; currency: string }>()
  for (const r of records) {
    if (!isBaselinePayment(r)) continue
    keys.set(`${r.vendor.vendorKey}\u0000${r.currency}`, { vendorKey: r.vendor.vendorKey, currency: r.currency })
  }
  return [...keys.values()]
    .sort((a, b) => cmp(a.vendorKey, b.vendorKey) || cmp(a.currency, b.currency))
    .map((k) => computeBaseline(k.vendorKey, k.currency, records))
}

/**
 * Where an amount sits relative to an established baseline. Not a finding and
 * not a judgement: "above range in the covered records" says nothing about why.
 */
export function compareToBaseline(baseline: VendorBaseline, amountMinor: number): BaselineComparison {
  if (!Number.isSafeInteger(amountMinor)) throw new RangeError('amountMinor must be a safe integer in minor units.')
  if (baseline.status !== 'established' || baseline.lowerBoundMinor === null || baseline.upperBoundMinor === null || baseline.medianPaymentMinor === null) {
    return { label: 'insufficient_history', ratioBps: null, lowerBoundMinor: null, upperBoundMinor: null, reasons: baseline.reasons, baselineVersion: BASELINE_VERSION }
  }
  const label: BaselineComparisonLabel = amountMinor > baseline.upperBoundMinor ? 'above_range' : amountMinor < baseline.lowerBoundMinor ? 'below_range' : 'within_range'
  return {
    label,
    ratioBps: ratioBps(amountMinor, baseline.medianPaymentMinor),
    lowerBoundMinor: baseline.lowerBoundMinor,
    upperBoundMinor: baseline.upperBoundMinor,
    reasons: [],
    baselineVersion: BASELINE_VERSION,
  }
}

// ---------------------------------------------------------------- read model

export interface VendorBaselinesResult {
  baselines: VendorBaseline[]
  thresholds: {
    minPayments: number
    minCoveredMonths: number
    seasonalMinMonths: number
    madK: number
    minToleranceBps: number
  }
}

export const BASELINE_THRESHOLDS: VendorBaselinesResult['thresholds'] = {
  minPayments: BASELINE_MIN_PAYMENTS,
  minCoveredMonths: BASELINE_MIN_COVERED_MONTHS,
  seasonalMinMonths: SEASONAL_MIN_MONTHS,
  madK: BASELINE_MAD_K,
  minToleranceBps: BASELINE_MIN_TOLERANCE_BPS,
}

/** Coverage items shared by every read model that shows baselines. */
export function baselineCoverage(baselines: readonly VendorBaseline[], origin: string): CoverageItem[] {
  const snapshot: string[] = origin === 'legacy_audit_snapshot' ? [COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS] : []
  const reasons = [...snapshot]
  if (baselines.length === 0) reasons.push(COVERAGE_REASONS.NO_DATA)
  if (baselines.some((b) => b.status !== 'established')) reasons.push(COVERAGE_REASONS.INSUFFICIENT_HISTORY)
  if (baselines.some((b) => b.currency === UNKNOWN_CURRENCY)) reasons.push(COVERAGE_REASONS.MISSING_CURRENCY)
  if (baselines.some((b) => b.undatedPaymentCount > 0)) reasons.push(COVERAGE_REASONS.MISSING_DATES)
  return [
    coverage('vendor_baselines', reasons, baselines.length === 0),
    // Seasonal comparison is never run in v0.1 (see SEASONAL_MIN_MONTHS).
    coverage('seasonal_comparison', [COVERAGE_REASONS.INSUFFICIENT_HISTORY, ...snapshot], true),
  ]
}

/** Tenant-scoped envelope over every vendor baseline. */
export function vendorBaselines(ctx: TenantContext, financial: FinancialSourcePort, now: number): ReadModelEnvelope<VendorBaselinesResult> {
  requirePermission(ctx, 'financial:read')
  const records = financial.listSourceRecords(ctx)
  for (const r of records) requireTenant(ctx, r.tenantId)
  const baselines = computeVendorBaselines(records)
  const imports = financial.listImportCoverage(ctx)
  const newestImport = imports.reduce<number | null>((m, i) => (i.importedAt > 0 && (m === null || i.importedAt > m) ? i.importedAt : m), null)
  const dates = baselines.flatMap((b) => [b.firstPaymentDate, b.lastPaymentDate]).filter((d): d is string => d !== null).sort()
  const sources: SourceRef[] = [{ id: `rule:${BASELINE_VERSION}`, label: 'Vendor baseline method' }]
  return envelope({
    model: 'vendor_baselines',
    metricDefinitionVersion: BASELINE_VERSION,
    ctx,
    origin: financial.origin,
    scope: { from: dates[0] ?? null, to: dates.at(-1) ?? null, dateBasis: 'payment_date', currencies: [...new Set(baselines.map((b) => b.currency))].sort() },
    computedAt: now,
    sourceUpdatedAt: newestImport,
    coverage: baselineCoverage(baselines, financial.origin),
    sources,
    result: { baselines, thresholds: BASELINE_THRESHOLDS },
  })
}
