import { describe, expect, it } from 'vitest'
import type { SourceRecord } from './contracts.ts'
import { createLegacyAuditSource } from './adapters/legacyAudit.ts'
import { fixtureContext, tenantAAudits, tenantBAudits } from './fixtures/synthetic.ts'
import { IntelligenceAccessError } from './envelope.ts'
import {
  BASELINE_MAD_K,
  BASELINE_MIN_COVERED_MONTHS,
  BASELINE_MIN_PAYMENTS,
  BASELINE_MIN_TOLERANCE_BPS,
  BASELINE_VERSION,
  SEASONAL_MIN_MONTHS,
  compareToBaseline,
  computeBaseline,
  computeVendorBaselines,
  lowerMedian,
  ratioBps,
  vendorBaselines,
} from './baselines.ts'

const NOW = Date.UTC(2026, 6, 1)
const ctxA = fixtureContext('tenant_a')

/** SYNTHETIC: a bare source record for pure baseline tests. */
function rec(id: string, amountMinor: number, paymentDate: string | null, overrides: Partial<SourceRecord> & { vendorKey?: string } = {}): SourceRecord {
  const { vendorKey = 'vendor_x', ...rest } = overrides
  return {
    recordId: `audit_s/${id}`,
    tenantId: 'tenant_s',
    auditId: 'audit_s',
    source: { system: 'fixture', importId: 'imp', accountId: null, nativeId: null, filename: null, rowNumber: null },
    kind: 'payment',
    vendor: { displayName: 'Fixture Vendor X', vendorKey, stableSupplierId: null, aliasSuggestion: null },
    invoiceReference: id,
    amountMinor,
    currency: 'USD',
    paymentDate,
    invoiceDate: null,
    category: null,
    settlement: 'unknown',
    identityKey: id,
    normalizationVersion: 'fixture',
    unknownFields: [],
    ...rest,
  }
}

function coffeeKey(): string {
  return createLegacyAuditSource('tenant_a', tenantAAudits()).financial.listSourceRecords(ctxA).find((r) => r.vendor.displayName === 'Fixture Coffee Co')!.vendor.vendorKey
}

describe('baseline thresholds', () => {
  it('are transparent named constants', () => {
    expect(BASELINE_VERSION).toBe('baseline-v0.1')
    expect([BASELINE_MIN_PAYMENTS, BASELINE_MIN_COVERED_MONTHS, SEASONAL_MIN_MONTHS, BASELINE_MAD_K, BASELINE_MIN_TOLERANCE_BPS]).toEqual([5, 3, 24, 3, 500])
  })

  it('uses the lower-middle value for an even-sized median', () => {
    expect(lowerMedian([400, 100, 300, 200])).toBe(200)
    expect(lowerMedian([5])).toBe(5)
    expect(lowerMedian([])).toBeNull()
  })

  it('rounds basis points half away from zero, exactly', () => {
    expect(ratioBps(1, 3)).toBe(3333)
    expect(ratioBps(2, 3)).toBe(6667)
    expect(ratioBps(1, 20000)).toBe(1) // 0.5 bps rounds up
    expect(ratioBps(-1, 20000)).toBe(-1)
    expect(ratioBps(5, 0)).toBeNull()
  })
})

describe('computeBaseline on the tenant A fixture (hand-calculated)', () => {
  const records = createLegacyAuditSource('tenant_a', tenantAAudits()).financial.listSourceRecords(ctxA)

  it('establishes the coffee supplier baseline, counting the cross-audit repeat once', () => {
    // Payments (cents): 120000, 135050, 141025, 141025, 130000, 498000, 129575 → sorted
    // 120000 129575 130000 [135050] 141025 141025 498000 → median 135050.
    // |x - median|: 15050 5475 5050 0 5975 5975 362950 → sorted 0 5050 5475 [5975] ... → MAD 5975.
    // Gaps (days): 16, 15, 10, 39, 32, 28 → sorted 10 15 [16] 28 32 39 → lower-middle 16.
    const b = computeBaseline(coffeeKey(), 'USD', records)
    expect(b).toMatchObject({
      status: 'established',
      paymentCount: 7,
      coveredMonths: 6,
      medianPaymentMinor: 135050,
      madMinor: 5975,
      medianGapDays: 16,
      firstPaymentDate: '2026-01-20',
      lastPaymentDate: '2026-06-09',
      // max(3 × 5975 = 17925, ceil(135050 × 5%) = 6753) = 17925
      toleranceMinor: 17925,
      lowerBoundMinor: 117125,
      upperBoundMinor: 152975,
      reasons: [],
    })
    expect(b.sourceRecordIds).toHaveLength(7)
  })

  it('compares an amount to the range in basis points', () => {
    const b = computeBaseline(coffeeKey(), 'USD', records)
    expect(compareToBaseline(b, 498000)).toMatchObject({ label: 'above_range', ratioBps: 36875 }) // 498000 / 135050 = 3.68752…
    expect(compareToBaseline(b, 135050)).toMatchObject({ label: 'within_range', ratioBps: 10000 })
    expect(compareToBaseline(b, 117125).label).toBe('within_range')
    expect(compareToBaseline(b, 117124).label).toBe('below_range')
    expect(compareToBaseline(b, 152976).label).toBe('above_range')
    expect(() => compareToBaseline(b, 1.5)).toThrow(RangeError)
  })

  it('handles MAD = 0 (identical rent payments) with the minimum tolerance', () => {
    const rentKey = records.find((r) => r.vendor.displayName === 'Fixture Property Mgmt')!.vendor.vendorKey
    const b = computeBaseline(rentKey, 'USD', records)
    // Six payments of 400000; MAD 0; tolerance = ceil(400000 × 500 / 10000) = 20000.
    // Gaps 31, 28, 31, 30, 31 → sorted 28 30 [31] 31 31 → 31.
    expect(b).toMatchObject({ status: 'established', paymentCount: 6, medianPaymentMinor: 400000, madMinor: 0, toleranceMinor: 20000, medianGapDays: 31 })
    expect(compareToBaseline(b, 400001).label).toBe('within_range')
    expect(compareToBaseline(b, 420001)).toMatchObject({ label: 'above_range', ratioBps: 10500 })
  })

  it('marks sparse history as insufficient and refuses to compare', () => {
    const officeKey = records.find((r) => r.vendor.displayName === 'Fixture Office Supply')!.vendor.vendorKey
    const b = computeBaseline(officeKey, 'USD', records)
    // Two payments (the refund row is not a payment), two months.
    expect(b).toMatchObject({ status: 'insufficient_history', paymentCount: 2, coveredMonths: 2, medianPaymentMinor: 28960, lowerBoundMinor: null, upperBoundMinor: null })
    expect(b.reasons).toEqual(['insufficient_history', 'too_few_covered_months', 'too_few_payments'])
    expect(compareToBaseline(b, 1_000_000)).toMatchObject({ label: 'insufficient_history', ratioBps: null })
  })

  it('keeps currencies apart: the EUR vendor has its own insufficient baseline', () => {
    const all = computeVendorBaselines(records)
    const eur = all.filter((b) => b.currency === 'EUR')
    expect(eur).toHaveLength(1)
    expect(eur[0]).toMatchObject({ paymentCount: 1, medianPaymentMinor: 90000, status: 'insufficient_history' })
    expect(all.map((b) => `${b.vendorKey}|${b.currency}`)).toEqual([...all.map((b) => `${b.vendorKey}|${b.currency}`)].sort())
  })

  it('always declines seasonal comparison under 24 covered months', () => {
    const b = computeBaseline(coffeeKey(), 'USD', records)
    expect(b.seasonal).toEqual({ status: 'not_supported', reasons: ['insufficient_history'], requiredCoveredMonths: 24, coveredMonths: 6 })
  })
})

describe('computeBaseline edge cases (synthetic records)', () => {
  it('requires both enough payments and enough months', () => {
    const fiveInTwoMonths = [1, 2, 3, 4, 5].map((i) => rec(`r${i}`, 1000, i <= 3 ? `2026-01-0${i}` : `2026-02-0${i}`))
    expect(computeBaseline('vendor_x', 'USD', fiveInTwoMonths).reasons).toEqual(['insufficient_history', 'too_few_covered_months'])
    const fourInFourMonths = [1, 2, 3, 4].map((i) => rec(`r${i}`, 1000, `2026-0${i}-01`))
    expect(computeBaseline('vendor_x', 'USD', fourInFourMonths).reasons).toEqual(['insufficient_history', 'too_few_payments'])
  })

  it('leaves undated payments out of every statistic and says so', () => {
    const rows = [...[1, 2, 3, 4, 5].map((i) => rec(`r${i}`, 1000 * i, `2026-0${i}-15`)), rec('undated', 999_999, null)]
    const b = computeBaseline('vendor_x', 'USD', rows)
    expect(b).toMatchObject({ status: 'established', paymentCount: 5, undatedPaymentCount: 1, medianPaymentMinor: 3000 })
    expect(b.reasons).toEqual(['missing_dates'])
    expect(b.sourceRecordIds).toContain('audit_s/undated')
  })

  it('never establishes a baseline in an UNKNOWN currency bucket', () => {
    const rows = [1, 2, 3, 4, 5].map((i) => rec(`r${i}`, 1000, `2026-0${i}-01`, { currency: 'UNKNOWN' }))
    const b = computeBaseline('vendor_x', 'UNKNOWN', rows)
    expect(b.status).toBe('insufficient_history')
    expect(b.reasons).toContain('missing_currency')
  })

  it('ignores refunds, credits and other vendors', () => {
    const rows = [
      ...[1, 2, 3, 4, 5].map((i) => rec(`r${i}`, 1000, `2026-0${i}-01`)),
      rec('refund', -500, '2026-03-02', { kind: 'refund' }),
      rec('other', 7777, '2026-03-03', { vendorKey: 'vendor_y' }),
    ]
    expect(computeBaseline('vendor_x', 'USD', rows)).toMatchObject({ paymentCount: 5, medianPaymentMinor: 1000 })
  })

  it('with 24+ months still does not claim seasonality: no seasonal model exists', () => {
    const rows = Array.from({ length: 24 }, (_, i) => rec(`m${i}`, 5000, `${2024 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}-10`))
    const b = computeBaseline('vendor_x', 'USD', rows)
    expect(b.coveredMonths).toBe(24)
    expect(b.seasonal).toEqual({ status: 'not_supported', reasons: ['seasonal_model_not_implemented'], requiredCoveredMonths: 24, coveredMonths: 24 })
  })

  it('is deterministic regardless of input order', () => {
    const rows = [1, 2, 3, 4, 5, 6].map((i) => rec(`r${i}`, 1000 + i * 37, `2026-0${i}-0${i}`))
    expect(computeVendorBaselines([...rows].reverse())).toEqual(computeVendorBaselines(rows))
  })
})

describe('vendorBaselines read model', () => {
  it('returns a tenant-scoped envelope with snapshot coverage reasons', () => {
    const source = createLegacyAuditSource('tenant_a', tenantAAudits())
    const env = vendorBaselines(ctxA, source.financial, NOW)
    expect(env.tenantId).toBe('tenant_a')
    expect(env.metricDefinitionVersion).toBe(BASELINE_VERSION)
    expect(env.result!.baselines).toHaveLength(4) // rent, coffee, office (USD) and euro parts (EUR)
    const cov = env.coverage.find((c) => c.check === 'vendor_baselines')!
    expect(cov.status).toBe('limited')
    expect(cov.reasons).toEqual(expect.arrayContaining(['customer_supplied_source', 'snapshot_not_continuous', 'insufficient_history']))
    expect(env.coverage.find((c) => c.check === 'seasonal_comparison')!.status).toBe('not_run')
    expect(vendorBaselines(ctxA, source.financial, NOW)).toEqual(env)
  })

  it('refuses another tenant and a missing permission', () => {
    const source = createLegacyAuditSource('tenant_a', tenantAAudits())
    expect(() => vendorBaselines(fixtureContext('tenant_b'), source.financial, NOW)).toThrow(IntelligenceAccessError)
    expect(() => vendorBaselines(fixtureContext('tenant_a', ['cases:read']), source.financial, NOW)).toThrow(IntelligenceAccessError)
  })

  it('keeps the same vendor name in tenant B separate', () => {
    const b = createLegacyAuditSource('tenant_b', tenantBAudits())
    const env = vendorBaselines(fixtureContext('tenant_b'), b.financial, NOW)
    expect(env.result!.baselines).toHaveLength(1)
    // B's two Fixture Coffee Co payments only: 99999 and 88888 → lower-middle 88888.
    expect(env.result!.baselines[0]).toMatchObject({ paymentCount: 2, medianPaymentMinor: 88888, status: 'insufficient_history' })
  })

  it('reports empty data as not run, never as a clean result', () => {
    const empty = createLegacyAuditSource('tenant_a', [])
    const env = vendorBaselines(ctxA, empty.financial, NOW)
    expect(env.result!.baselines).toEqual([])
    expect(env.coverage.find((c) => c.check === 'vendor_baselines')).toMatchObject({ status: 'not_run' })
    expect(env.coverage.find((c) => c.check === 'vendor_baselines')!.reasons).toContain('no_data')
  })
})
