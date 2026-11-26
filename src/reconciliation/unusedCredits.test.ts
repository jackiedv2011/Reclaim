// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { creditsFromReturnRecords, reconcileSupplierCredits, UNUSED_CREDIT_VERSION } from './unusedCredits.ts'
import {
  SYNTH_OTHER_VENDOR, SYNTH_TENANT_B, SYNTH_VENDOR, SYNTHETIC_FULL_COVERAGE,
  syntheticApplication, syntheticCredit, syntheticReversal, syntheticVendorCredit,
} from './fixtures.ts'

describe('reconcileSupplierCredits', () => {
  it('computes remaining credit when coverage is complete', () => {
    const [row] = reconcileSupplierCredits({ credits: [syntheticCredit()], applications: [syntheticApplication()], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE })
    expect(row).toEqual({
      tenantId: 'synthetic-tenant-a', vendorKey: SYNTH_VENDOR, currency: 'USD', issuedMinor: 50_000, appliedMinor: 20_000, reversedMinor: 0,
      remainingMinor: 30_000, status: 'computed', reasons: [], creditIds: ['synthetic-credit-1'], proposedLinks: [], algorithmVersion: UNUSED_CREDIT_VERSION,
    })
  })

  it('returns unknown (null remaining) when coverage is incomplete', () => {
    const [row] = reconcileSupplierCredits({
      credits: [syntheticCredit()], applications: [syntheticApplication()], reversals: [],
      coverage: { ...SYNTHETIC_FULL_COVERAGE, applicationsComplete: false },
    })
    expect(row).toMatchObject({ status: 'unknown', remainingMinor: null, reasons: ['applications_incomplete'] })
  })

  it('returns unknown when the period does not contain every credit', () => {
    const [row] = reconcileSupplierCredits({
      credits: [syntheticCredit({ date: '2025-12-15' })], applications: [], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE,
    })
    expect(row).toMatchObject({ status: 'unknown', remainingMinor: null, reasons: ['credit_outside_period'] })
    const [noPeriod] = reconcileSupplierCredits({ credits: [syntheticCredit()], applications: [], reversals: [], coverage: { ...SYNTHETIC_FULL_COVERAGE, period: null } })
    expect(noPeriod.reasons).toContain('period_unknown')
  })

  it('never goes negative: applied above issued is unknown with a conflict reason', () => {
    const [row] = reconcileSupplierCredits({
      credits: [syntheticCredit()], applications: [syntheticApplication({ amountMinor: 70_000 })], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE,
    })
    expect(row).toMatchObject({ status: 'unknown', remainingMinor: null })
    expect(row.reasons).toContain('applied_exceeds_issued')
  })

  it('subtracts a full reversal of the unapplied part', () => {
    const [row] = reconcileSupplierCredits({
      credits: [syntheticCredit()], applications: [syntheticApplication()], reversals: [syntheticReversal()], coverage: SYNTHETIC_FULL_COVERAGE,
    })
    expect(row).toMatchObject({ status: 'computed', reversedMinor: 30_000, remainingMinor: 0 })
  })

  it('keeps currencies, suppliers and tenants apart and sorts deterministically', () => {
    const credits = [
      syntheticCredit({ id: 'c3', tenantId: SYNTH_TENANT_B }),
      syntheticCredit({ id: 'c2', currency: 'EUR', amountMinor: 1_000 }),
      syntheticCredit({ id: 'c1', vendorKey: SYNTH_OTHER_VENDOR }),
      syntheticCredit({ id: 'c0' }),
    ]
    const rows = reconcileSupplierCredits({ credits, applications: [], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE })
    expect(rows.map((r) => [r.tenantId, r.vendorKey, r.currency, r.issuedMinor])).toEqual([
      ['synthetic-tenant-a', SYNTH_VENDOR, 'EUR', 1_000],
      ['synthetic-tenant-a', SYNTH_VENDOR, 'USD', 50_000],
      ['synthetic-tenant-a', SYNTH_OTHER_VENDOR, 'USD', 50_000],
      ['synthetic-tenant-b', SYNTH_VENDOR, 'USD', 50_000],
    ].sort((a, b) => (`${a[0]}|${a[1]}|${a[2]}` < `${b[0]}|${b[1]}|${b[2]}` ? -1 : 1)))
    const again = reconcileSupplierCredits({ credits: [...credits].reverse(), applications: [], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE })
    expect(again).toEqual(rows)
  })

  it('makes the supplier unknown when an application points at a credit it does not have', () => {
    const [row] = reconcileSupplierCredits({
      credits: [syntheticCredit()], applications: [syntheticApplication({ creditId: 'missing-credit' })], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE,
    })
    expect(row).toMatchObject({ status: 'unknown', remainingMinor: null, appliedMinor: 0, reasons: ['application_for_unknown_credit'] })
  })

  it('does not link an application across tenants', () => {
    const [row] = reconcileSupplierCredits({
      credits: [syntheticCredit()], applications: [syntheticApplication({ tenantId: SYNTH_TENANT_B })], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE,
    })
    expect(row.appliedMinor).toBe(0)
  })

  it('keeps two tenants apart when their credits, applications and reversals share ids', () => {
    const rows = reconcileSupplierCredits({
      credits: [syntheticCredit({ id: '12', amountMinor: 100 }), syntheticCredit({ id: '12', tenantId: SYNTH_TENANT_B, amountMinor: 200 })],
      applications: [
        syntheticApplication({ id: 'a1', creditId: '12', amountMinor: 40 }),
        syntheticApplication({ id: 'a1', creditId: '12', tenantId: SYNTH_TENANT_B, amountMinor: 50 }),
      ],
      reversals: [], coverage: SYNTHETIC_FULL_COVERAGE,
    })
    expect(rows.map((r) => [r.tenantId, r.issuedMinor, r.appliedMinor, r.remainingMinor, r.status, r.reasons])).toEqual([
      ['synthetic-tenant-a', 100, 40, 60, 'computed', []],
      ['synthetic-tenant-b', 200, 50, 150, 'computed', []],
    ])
  })

  it('reports unknown amounts and currency instead of treating them as zero', () => {
    const rows = reconcileSupplierCredits({
      credits: [syntheticCredit({ amountMinor: null }), syntheticCredit({ id: 'c-nocur', currency: null })], applications: [], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE,
    })
    expect(rows.every((r) => r.status === 'unknown' && r.remainingMinor === null)).toBe(true)
    expect(rows.flatMap((r) => r.reasons).sort()).toEqual(['credit_amount_unknown', 'currency_unknown'])
  })

  it('counts a duplicated application once', () => {
    const app = syntheticApplication()
    const [row] = reconcileSupplierCredits({ credits: [syntheticCredit()], applications: [app, app], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE })
    expect(row.appliedMinor).toBe(20_000)
  })

  it('reports candidate links but never uses them in the math', () => {
    const [row] = reconcileSupplierCredits({
      credits: [syntheticCredit()], applications: [], reversals: [], coverage: SYNTHETIC_FULL_COVERAGE,
      candidateLinks: (g) => g.credits.map((c) => ({ creditId: c.id, billRef: 'SYN-BILL-4242', amountMinor: 50_000, rationale: 'synthetic proposal' })),
    })
    expect(row).toMatchObject({ appliedMinor: 0, remainingMinor: 50_000, status: 'computed' })
    expect(row.proposedLinks).toEqual([{ creditId: 'synthetic-credit-1', billRef: 'SYN-BILL-4242', amountMinor: 50_000, rationale: 'synthetic proposal' }])
  })

  it('derives inputs from return source records', () => {
    const records = [
      syntheticVendorCredit({ id: 'vc1', amountMinor: 10_000, appliedToBills: [{ billRef: 'SYN-BILL-1', amountMinor: 4_000, date: '2026-09-12' }] }),
      syntheticVendorCredit({ id: 'vc2', amountMinor: 5_000, status: 'voided' }),
    ]
    const derived = creditsFromReturnRecords(records)
    expect(derived.credits.map((c) => c.id)).toEqual(['vc1', 'vc2'])
    expect(derived.applications).toEqual([expect.objectContaining({ creditId: 'vc1', amountMinor: 4_000 })])
    expect(derived.reversals).toEqual([expect.objectContaining({ creditId: 'vc2', amountMinor: null })])
    const [row] = reconcileSupplierCredits({ ...derived, coverage: SYNTHETIC_FULL_COVERAGE })
    expect(row).toMatchObject({ issuedMinor: 15_000, appliedMinor: 4_000, reversedMinor: 5_000, remainingMinor: 6_000, status: 'computed' })
  })
})
