// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { APRecord } from '../../types.ts'
import { DEFAULT_LIMITS, MATCHER_FLAG, SCORE_THRESHOLD, WEIGHTS, isMatcherEnabled } from './config.ts'
import { prepareRecord, type PreparedRecord } from './prepare.ts'
import { blockingKeys, generateCandidatePairs } from './blocking.ts'
import { buildLedgerContext, exclusionFor } from './exclusions.ts'
import { scorePair, withinEditDistance } from './features.ts'
import { damerauLevenshteinDistance } from '../stringDistance.ts'
import { runMatcherExperiment, pairKey } from './matcher.ts'

let seq = 0
function rec(overrides: Partial<APRecord> = {}): APRecord {
  seq++
  return {
    id: `t-${String(seq).padStart(5, '0')}`,
    importBatchId: 'b1',
    vendor: 'Harbor Freight Supply LLC',
    invoiceNumber: 'INV-48213',
    invoiceDate: new Date(2025, 2, 1),
    paymentDate: new Date(2025, 2, 10),
    invoiceAmount: 1250,
    amountPaid: 1250,
    terms: null,
    bankAccountLast4: '1234',
    category: null,
    rowIndex: seq,
    currency: 'USD',
    externalTransactionId: `ext-${seq}`,
    ...overrides,
  }
}

const prep = (overrides: Partial<APRecord> = {}): PreparedRecord => prepareRecord(rec(overrides))
const names = (a: PreparedRecord, b: PreparedRecord) => scorePair(a, b).features.map((f) => f.name)

describe('feature flag', () => {
  it('is off by default', () => {
    expect(isMatcherEnabled({})).toBe(false)
    expect(isMatcherEnabled({ [MATCHER_FLAG]: '' })).toBe(false)
    expect(isMatcherEnabled({ [MATCHER_FLAG]: '0' })).toBe(false)
    expect(isMatcherEnabled({ [MATCHER_FLAG]: 'false' })).toBe(false)
  })
  it('turns on only for explicit truthy values', () => {
    for (const value of ['1', 'true', 'TRUE', ' yes ', 'on']) expect(isMatcherEnabled({ [MATCHER_FLAG]: value })).toBe(true)
  })
  it('lets an explicit override win over the environment', () => {
    expect(isMatcherEnabled({ [MATCHER_FLAG]: '1' }, false)).toBe(false)
    expect(isMatcherEnabled({}, true)).toBe(true)
  })
})

describe('features', () => {
  it('reference: exact after normalization', () => {
    expect(names(prep({ invoiceNumber: 'INV-48213' }), prep({ invoiceNumber: 'inv 48213' }))).toContain('reference_exact')
  })
  it('reference: same digit core with suffix', () => {
    expect(names(prep({ invoiceNumber: 'INV-48213' }), prep({ invoiceNumber: '48213-A' }))).toContain('reference_digit_core')
  })
  it('reference: adjacent transposition', () => {
    expect(names(prep({ invoiceNumber: '48213' }), prep({ invoiceNumber: '48231' }))).toContain('reference_transposition')
  })
  it('reference: one digit off counts against a match', () => {
    const f = scorePair(prep({ invoiceNumber: '48213' }), prep({ invoiceNumber: '48214' })).features.find((x) => x.name === 'reference_one_digit_off')
    expect(f?.weight).toBe(WEIGHTS.referenceOneDigitOff)
    expect(f!.weight).toBeLessThan(0)
  })
  it('reference: unrelated is negative, missing is an evidence gap', () => {
    expect(names(prep({ invoiceNumber: '48213' }), prep({ invoiceNumber: '90551' }))).toContain('reference_unrelated')
    const s = scorePair(prep({ invoiceNumber: null }), prep({ invoiceNumber: '48213' }))
    expect(s.features.some((f) => f.name.startsWith('reference_'))).toBe(false)
    expect(s.evidenceGaps).toContain('reference_missing')
  })
  it('vendor: same identity, legal-form rename, typo, unrelated', () => {
    expect(names(prep(), prep())).toContain('vendor_same_identity')
    expect(names(prep({ vendor: 'Harbor Freight Supply LLC' }), prep({ vendor: 'Harbor Freight Supply, Inc.' }))).toContain('vendor_same_name')
    expect(names(prep({ vendor: 'Harbor Freight Supply' }), prep({ vendor: 'Harbour Freight Supply' }))).toContain('vendor_spelling_variant')
    expect(names(prep({ vendor: 'Harbor Freight Supply' }), prep({ vendor: 'Quartz Legal Partners' }))).toContain('vendor_unrelated')
  })
  it('vendor: different store numbers are different suppliers', () => {
    expect(names(prep({ vendor: 'Metro Fuel 112' }), prep({ vendor: 'Metro Fuel 118' }))).toContain('vendor_unrelated')
  })
  it('amount: exact, close (fee), different', () => {
    expect(names(prep(), prep())).toContain('amount_exact')
    expect(names(prep({ amountPaid: 1250 }), prep({ amountPaid: 1265 }))).toContain('amount_close')
    expect(names(prep({ amountPaid: 1250 }), prep({ amountPaid: 1500 }))).toContain('amount_different')
  })
  it('timing bands', () => {
    const a = prep({ paymentDate: new Date(2025, 2, 10) })
    expect(names(a, prep({ paymentDate: new Date(2025, 2, 15) }))).toContain('timing_close')
    expect(names(a, prep({ paymentDate: new Date(2025, 3, 10) }))).toContain('timing_window')
    expect(names(a, prep({ paymentDate: new Date(2025, 5, 10) }))).toContain('timing_outside_window')
    expect(names(a, prep({ paymentDate: new Date(2026, 2, 10) }))).toContain('timing_far')
  })
  it('invoice date, invoice amount and bank account', () => {
    expect(names(prep(), prep())).toEqual(expect.arrayContaining(['invoice_date_same', 'invoice_amount_same', 'bank_account_same']))
    expect(names(prep({ invoiceDate: new Date(2025, 0, 1) }), prep({ invoiceDate: new Date(2025, 2, 1) }))).toContain('invoice_date_differs')
    expect(names(prep({ bankAccountLast4: '1234' }), prep({ bankAccountLast4: '9876' }))).toContain('bank_account_differs')
    expect(scorePair(prep({ invoiceDate: null }), prep()).evidenceGaps).toContain('invoice_date_unknown')
  })
  it('penalises several approximate signals together', () => {
    const s = scorePair(prep({ invoiceNumber: '48213', amountPaid: 1250 }), prep({ invoiceNumber: '48231', amountPaid: 1262 }))
    expect(s.features.find((f) => f.name === 'multiple_approximate_signals')?.weight).toBe(WEIGHTS.multipleApproximate)
  })
  it('score is the sum of feature weights and features carry no money', () => {
    const s = scorePair(prep({ invoiceNumber: 'INV-48213' }), prep({ invoiceNumber: '48213-A', vendor: 'Harbour Freight Supply' }))
    expect(s.score).toBeCloseTo(s.features.reduce((sum, f) => sum + f.weight, 0), 4)
    for (const f of s.features) expect(f.detail).not.toMatch(/\$|\d+\.\d\d/)
    expect(s.evidenceGaps).toEqual(expect.arrayContaining(['distinct_settlement_not_verified', 'bill_linkage_unknown']))
  })
})

describe('withinEditDistance', () => {
  it('agrees with the shared Damerau-Levenshtein distance', () => {
    let state = 7
    const rand = () => (state = (state * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648
    const word = () => Array.from({ length: Math.floor(rand() * 9) }, () => 'abcd'[Math.floor(rand() * 4)]).join('')
    for (let n = 0; n < 3_000; n++) {
      const a = word()
      const b = rand() < 0.5 ? word() : a.replace(/(.)(.)/, '$2$1')
      const limit = Math.floor(rand() * 4)
      expect(withinEditDistance(a, b, limit), `${a} / ${b} / ${limit}`).toBe(damerauLevenshteinDistance(a, b) <= limit)
    }
  })
})

describe('blocking', () => {
  it('emits at most five keys per record', () => {
    expect(blockingKeys(prep()).length).toBeLessThanOrEqual(5)
  })
  it('compares all pairs in a small block', () => {
    const rows = [prep(), prep(), prep()]
    const { pairs, stats } = generateCandidatePairs(rows, DEFAULT_LIMITS)
    expect(pairs).toHaveLength(3)
    expect(stats.oversizedBlocks).toBe(0)
  })
  it('uses a date window in an oversized block and stays within the documented bound', () => {
    const rows: PreparedRecord[] = []
    for (let i = 0; i < 300; i++) rows.push(prep({ invoiceNumber: null, paymentDate: new Date(2025, 0, 1 + i) }))
    const limits = { ...DEFAULT_LIMITS, maxBlockSize: 20, neighbourWindow: 4 }
    const { pairs, stats } = generateCandidatePairs(rows, limits)
    expect(stats.oversizedBlocks).toBeGreaterThan(0)
    expect(stats.largestBlock).toBe(300)
    const keysPerRecord = 5
    expect(pairs.length).toBeLessThanOrEqual(rows.length * keysPerRecord * Math.max(limits.maxBlockSize - 1, limits.neighbourWindow))
    expect(pairs.length).toBeLessThan((300 * 299) / 2)
    expect(new Set(pairs.map(([i, j]) => `${i}-${j}`)).size).toBe(pairs.length)
  })
  it('flags truncation at the pair cap', () => {
    const rows = Array.from({ length: 30 }, () => prep())
    const { pairs, stats } = generateCandidatePairs(rows, { ...DEFAULT_LIMITS, maxPairsCompared: 10 })
    expect(pairs.length).toBe(10)
    expect(stats.truncated).toBe(true)
  })
})

describe('exclusions', () => {
  const ctxOf = (rows: PreparedRecord[]) => buildLedgerContext(rows)

  it('repeated import copy of the same source transaction', () => {
    const a = prep({ externalTransactionId: 'X-1', importBatchId: 'b1' })
    const b = prep({ externalTransactionId: 'X-1', importBatchId: 'b2' })
    expect(exclusionFor(a, b, ctxOf([a, b]))).toBe('same_source_transaction')
    const c = prep({ externalTransactionId: null, identityKey: 'k1' })
    const d = prep({ externalTransactionId: null, identityKey: 'k1' })
    expect(exclusionFor(c, d, ctxOf([c, d]))).toBe('same_source_transaction')
  })
  it('currency mismatch', () => {
    const a = prep({ currency: 'USD' })
    const b = prep({ currency: 'cad' })
    expect(exclusionFor(a, b, ctxOf([a, b]))).toBe('currency_mismatch')
  })
  it('different company', () => {
    const a = prep({ company: 'North' })
    const b = prep({ company: 'South' })
    expect(exclusionFor(a, b, ctxOf([a, b]))).toBe('different_company')
  })
  it('recurring series, including an off-cadence row inside the series', () => {
    const rows = [0, 30, 61, 75, 91, 122].map((d) =>
      prep({ vendor: 'Office Lease Co', invoiceNumber: null, invoiceDate: null, invoiceAmount: null, amountPaid: 4000, paymentDate: new Date(2025, 0, 1 + d) })
    )
    const ctx = ctxOf(rows)
    expect(exclusionFor(rows[0], rows[1], ctx)).toBe('recurring_series')
    expect(exclusionFor(rows[2], rows[3], ctx)).toBe('recurring_series')
  })
  it('void or reversal', () => {
    const a = prep({ invoiceNumber: 'INV-700' })
    const b = prep({ invoiceNumber: 'INV-700' })
    const v = prep({ invoiceNumber: 'INV-700', transactionType: 'Void', amountPaid: -1250 })
    expect(exclusionFor(a, b, ctxOf([a, b, v]))).toBe('voided_or_reversed')
  })
  it('refund or credit that offsets the smaller payment', () => {
    const a = prep({ invoiceNumber: 'INV-701' })
    const b = prep({ invoiceNumber: 'INV-701' })
    const r = prep({ invoiceNumber: 'INV-701', transactionType: 'Vendor Refund', amountPaid: -1250 })
    expect(exclusionFor(a, b, ctxOf([a, b, r]))).toBe('refund_or_credit_offsets')
  })
  it('partial payments within the invoice', () => {
    const a = prep({ invoiceNumber: 'INV-702', invoiceAmount: 1000, amountPaid: 400 })
    const b = prep({ invoiceNumber: 'INV-702', invoiceAmount: 1000, amountPaid: 600 })
    expect(exclusionFor(a, b, ctxOf([a, b]))).toBe('partial_payments_within_invoice')
  })
  it('leaves a plain duplicate alone', () => {
    const a = prep()
    const b = prep()
    expect(exclusionFor(a, b, ctxOf([a, b]))).toBeNull()
  })
})

describe('runMatcherExperiment', () => {
  it('returns only pairs not already covered by duplicate findings', () => {
    const a = rec({ invoiceNumber: 'INV-55120', paymentDate: new Date(2025, 2, 10) })
    const b = rec({ invoiceNumber: '55120-R', paymentDate: new Date(2025, 4, 20) })
    const open = runMatcherExperiment([a, b], [])
    expect(open.candidates.map((c) => pairKey(c.sourceRecordIds[0], c.sourceRecordIds[1]))).toEqual([pairKey(a.id, b.id)])
    const covered = runMatcherExperiment([a, b], [{ type: 'near_duplicate', relatedRecords: [a, b] } as never])
    expect(covered.candidates).toEqual([])
    expect(covered.stats.alreadyCoveredByFindings).toBe(1)
  })
  it('emits candidates with no amount or eligibility, at or above threshold', () => {
    const a = rec({ invoiceNumber: 'INV-55121', paymentDate: new Date(2025, 2, 10) })
    const b = rec({ invoiceNumber: '55121A', paymentDate: new Date(2025, 4, 20) })
    const [c] = runMatcherExperiment([a, b], []).candidates
    expect(Object.keys(c).sort()).toEqual(['algorithmVersion', 'candidateId', 'evidenceGaps', 'features', 'score', 'sourceRecordIds', 'status'])
    expect(c.status).toBe('candidate')
    expect(c.score).toBeGreaterThanOrEqual(SCORE_THRESHOLD)
    expect(c.sourceRecordIds).toEqual([a.id, b.id])
  })
  it('ignores refunds, voids and zero rows', () => {
    const a = rec({ amountPaid: -1250, transactionType: 'Refund' })
    const b = rec({ amountPaid: -1250, transactionType: 'Refund' })
    const z = rec({ amountPaid: 0 })
    expect(runMatcherExperiment([a, b, z], []).stats.paymentsConsidered).toBe(0)
  })
  it('caps candidates per record', () => {
    const rows = Array.from({ length: 6 }, (_, i) => rec({ invoiceNumber: 'INV-77001', paymentDate: new Date(2025, 2, 1 + i * 20) }))
    const run = runMatcherExperiment(rows, [], { limits: { maxCandidatesPerRecord: 1 } })
    const counts = new Map<string, number>()
    for (const c of run.candidates) for (const id of c.sourceRecordIds) counts.set(id, (counts.get(id) ?? 0) + 1)
    expect(Math.max(0, ...counts.values())).toBeLessThanOrEqual(1)
  })
})
