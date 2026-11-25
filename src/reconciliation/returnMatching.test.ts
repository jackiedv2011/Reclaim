// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { matchReturns, RETURN_MATCH_VERSION, requestKeyOf } from './returnMatching.ts'
import type { RequestReturnMatch, ReturnMatchResult } from './returnMatching.ts'
import { FINANCIAL_CONTRACT_VERSION } from '../contracts/financial.ts'
import {
  SYNTH_OTHER_VENDOR, SYNTH_TENANT_B, SYNTHETIC_SIMPLE_REFUND_SCENARIO,
  syntheticRequest, syntheticReturnRecord, syntheticVendorCredit,
} from './fixtures.ts'

const AS_OF = { dataAsOf: '2026-10-01' }
const only = (result: ReturnMatchResult): RequestReturnMatch => {
  expect(result.matches).toHaveLength(1)
  return result.matches[0]
}
const has = (m: RequestReturnMatch, code: string) => m.rationale.some((line) => line.startsWith(`${code}:`))

describe('matchReturns: basics', () => {
  it('matches a post-request refund that agrees on reference', () => {
    const s = SYNTHETIC_SIMPLE_REFUND_SCENARIO
    const result = matchReturns(s.requests, s.records, { dataAsOf: s.dataAsOf })
    const m = only(result)
    expect(result.contractVersion).toBe(FINANCIAL_CONTRACT_VERSION)
    expect(result.algorithmVersion).toBe(RETURN_MATCH_VERSION)
    expect(m).toMatchObject({
      requestRef: { projectId: 'synthetic-project-1', findingId: 'synthetic-finding-1', requestGeneration: 1 },
      status: 'proposed_source_match', method: 'refund', linkedSourceRecordIds: ['synthetic-rec-1'],
      amountMinor: 125_000, currency: 'USD', date: '2026-09-15', applied: null, competingRequests: [], coverage: 'current',
      algorithmVersion: RETURN_MATCH_VERSION,
    })
    expect(has(m, 'reference_agreement')).toBe(true)
    expect(has(m, 'gate_required')).toBe(true)
    expect(result.allocations).toEqual([expect.objectContaining({ sourceRecordId: 'synthetic-rec-1', allocatedMinor: 125_000, returnedEvidenceMinor: 125_000, basis: 'reference' })])
    expect(result.unallocatedRecords).toEqual([])
  })

  it('returns unmatched with no_candidates when nothing fits and coverage is current', () => {
    const m = only(matchReturns([syntheticRequest()], [], AS_OF))
    expect(m).toMatchObject({ status: 'unmatched', amountMinor: null, linkedSourceRecordIds: [], applied: null })
    expect(has(m, 'no_candidates')).toBe(true)
  })
})

describe('matchReturns: candidate filtering', () => {
  it('ignores a record from another supplier', () => {
    const result = matchReturns([syntheticRequest()], [syntheticReturnRecord({ vendorKey: SYNTH_OTHER_VENDOR })], AS_OF)
    expect(only(result).status).toBe('unmatched')
    expect(result.unallocatedRecords).toEqual([expect.objectContaining({ sourceRecordId: 'synthetic-rec-1', reasons: ['no_matching_request'], unallocatedMinor: 125_000 })])
  })

  it('never matches across tenants and never mentions the other tenant record in the rationale', () => {
    const m = only(matchReturns([syntheticRequest()], [syntheticReturnRecord({ id: 'other-tenant-rec', tenantId: SYNTH_TENANT_B })], AS_OF))
    expect(m.status).toBe('unmatched')
    expect(m.linkedSourceRecordIds).toEqual([])
    expect(m.rationale.join('\n')).not.toContain('other-tenant-rec')
  })

  it('excludes a different currency without converting it', () => {
    const m = only(matchReturns([syntheticRequest()], [syntheticReturnRecord({ currency: 'CAD' })], AS_OF))
    expect(m.status).toBe('unmatched')
    expect(has(m, 'currency_mismatch')).toBe(true)
  })

  it('excludes a record with unknown currency (USD is not assumed)', () => {
    const m = only(matchReturns([syntheticRequest()], [syntheticReturnRecord({ currency: null })], AS_OF))
    expect(m.status).toBe('unmatched')
    expect(has(m, 'currency_unknown')).toBe(true)
  })

  it('excludes a record from a different source account when both are known', () => {
    const m = only(matchReturns([syntheticRequest()], [syntheticReturnRecord({ sourceAccount: 'synthetic-realm-999' })], AS_OF))
    expect(m.status).toBe('unmatched')
    expect(has(m, 'source_account_mismatch')).toBe(true)
    const unknownAccount = only(matchReturns([syntheticRequest()], [syntheticReturnRecord({ sourceAccount: null })], AS_OF))
    expect(unknownAccount.status).toBe('proposed_source_match')
  })

  it('treats a pre-request record as a possible prior return, not a match', () => {
    const result = matchReturns([syntheticRequest()], [syntheticReturnRecord({ paymentDate: '2026-08-01' })], AS_OF)
    const m = only(result)
    expect(m.status).toBe('unmatched')
    expect(m.amountMinor).toBeNull()
    expect(has(m, 'possible_prior_return')).toBe(true)
    expect(result.unallocatedRecords[0]).toMatchObject({ reasons: ['pre_request'], relatedRequests: [requestKeyOf(syntheticRequest())] })
  })

  it('accepts a record within the small date tolerance and rejects one just outside it', () => {
    expect(only(matchReturns([syntheticRequest()], [syntheticReturnRecord({ paymentDate: '2026-08-30' })], AS_OF)).status).toBe('proposed_source_match')
    expect(only(matchReturns([syntheticRequest()], [syntheticReturnRecord({ paymentDate: '2026-08-29' })], AS_OF)).status).toBe('unmatched')
    expect(only(matchReturns([syntheticRequest()], [syntheticReturnRecord({ paymentDate: '2026-08-30' })], { ...AS_OF, dateToleranceDays: 0 })).status).toBe('unmatched')
  })

  it('does not link post-request activity that agrees on neither reference nor amount', () => {
    const result = matchReturns([syntheticRequest()], [syntheticReturnRecord({ memoReference: null, amountMinor: 3_700 })], AS_OF)
    const m = only(result)
    expect(m.status).toBe('unmatched')
    expect(has(m, 'unlinked_supplier_activity')).toBe(true)
    expect(result.unallocatedRecords[0].reasons).toEqual(['no_reference_or_amount_agreement'])
  })

  it('links an exact-amount record without reference, and says so', () => {
    const result = matchReturns([syntheticRequest()], [syntheticReturnRecord({ memoReference: null })], AS_OF)
    const m = only(result)
    expect(m.status).toBe('proposed_source_match')
    expect(has(m, 'matched_without_reference')).toBe(true)
    expect(result.allocations[0].basis).toBe('exact_amount')
  })

  it('ignores short references as agreement', () => {
    const m = only(matchReturns([syntheticRequest({ references: ['77'] })], [syntheticReturnRecord({ memoReference: '77', amountMinor: 10_000 })], AS_OF))
    expect(m.status).toBe('unmatched')
  })
})

describe('matchReturns: amounts', () => {
  it('reports a partial return as a proposed match of the matched sum', () => {
    const m = only(matchReturns([syntheticRequest()], [syntheticReturnRecord({ amountMinor: 50_000 })], AS_OF))
    expect(m).toMatchObject({ status: 'proposed_source_match', amountMinor: 50_000 })
    expect(has(m, 'partial_return')).toBe(true)
  })

  it('sums several records up to the outstanding amount', () => {
    const records = [
      syntheticReturnRecord({ id: 'r-a', amountMinor: 50_000, paymentDate: '2026-09-10' }),
      syntheticReturnRecord({ id: 'r-b', amountMinor: 75_000, paymentDate: '2026-09-20' }),
    ]
    const m = only(matchReturns([syntheticRequest()], records, AS_OF))
    expect(m).toMatchObject({ status: 'proposed_source_match', amountMinor: 125_000, linkedSourceRecordIds: ['r-a', 'r-b'], date: '2026-09-20' })
    expect(has(m, 'full_amount_evidenced')).toBe(true)
  })

  it('allocates only the outstanding part of an overpaid return and reports the excess as unallocated', () => {
    const result = matchReturns([syntheticRequest()], [syntheticReturnRecord({ amountMinor: 200_000 })], AS_OF)
    const m = only(result)
    expect(m).toMatchObject({ status: 'proposed_source_match', amountMinor: 125_000 })
    expect(has(m, 'excess_not_attributed')).toBe(true)
    expect(result.allocations[0].allocatedMinor).toBe(125_000)
    expect(result.unallocatedRecords).toEqual([expect.objectContaining({ sourceRecordId: 'synthetic-rec-1', unallocatedMinor: 75_000, reasons: ['excess_over_request'] })])
  })
})

describe('matchReturns: duplicates and reversals', () => {
  it('counts the same native transaction imported twice once', () => {
    const a = syntheticReturnRecord({ id: 'imp1-dep', sourceNativeId: 'Deposit:500', identityKey: 'qbo:Deposit:500', importId: 'imp-1' })
    const b = syntheticReturnRecord({ id: 'imp2-dep', sourceNativeId: 'Deposit:500', identityKey: 'qbo:Deposit:500', importId: 'imp-2' })
    const result = matchReturns([syntheticRequest()], [a, b, a], AS_OF)
    const m = only(result)
    expect(m).toMatchObject({ status: 'proposed_source_match', amountMinor: 125_000, linkedSourceRecordIds: ['imp1-dep'] })
    expect(has(m, 'duplicate_counted_once')).toBe(true)
    expect(result.allocations).toHaveLength(1)
    expect(result.unallocatedRecords).toEqual([expect.objectContaining({ sourceRecordId: 'imp2-dep', unallocatedMinor: 0, reasons: ['duplicate_of:imp1-dep'] })])
  })

  it('counts two records with the same reference, amount and date once (possible duplicate)', () => {
    const records = [syntheticReturnRecord({ id: 'csv-dep', sourceSystem: 'csv_upload', sourceNativeId: null }), syntheticReturnRecord({ id: 'qbo-dep' })]
    const result = matchReturns([syntheticRequest({ requestedAmountMinor: 250_000 })], records, AS_OF)
    const m = only(result)
    expect(m.amountMinor).toBe(125_000)
    expect(result.unallocatedRecords).toEqual([expect.objectContaining({ sourceRecordId: 'qbo-dep', reasons: ['possible_duplicate_of:csv-dep'] })])
  })

  it('ignores a request reference listed twice', () => {
    const m = only(matchReturns([syntheticRequest({ references: ['SYN-INV-7781', 'syninv7781'] })], [syntheticReturnRecord()], AS_OF))
    expect(m.status).toBe('proposed_source_match')
  })

  it('treats the same identity with different amounts as a conflict', () => {
    const a = syntheticReturnRecord({ id: 'd1', identityKey: 'qbo:Deposit:9' })
    const b = syntheticReturnRecord({ id: 'd2', identityKey: 'qbo:Deposit:9', amountMinor: 90_000 })
    const m = only(matchReturns([syntheticRequest()], [a, b], AS_OF))
    expect(m.status).toBe('conflict')
    expect(m.amountMinor).toBeNull()
    expect(has(m, 'record_integrity_conflict')).toBe(true)
  })

  it('excludes voided and reversed records', () => {
    for (const rec of [syntheticReturnRecord({ status: 'voided' }), syntheticReturnRecord({ reversedBy: 'Deposit:rev-1' })]) {
      const m = only(matchReturns([syntheticRequest()], [rec], AS_OF))
      expect(m.status).toBe('unmatched')
      expect(has(m, 'reversed_excluded')).toBe(true)
    }
  })

  it('flags a conflict when a previously linked record is now reversed', () => {
    const req = syntheticRequest()
    const m = only(matchReturns([req], [syntheticReturnRecord({ status: 'reversed' })], {
      ...AS_OF, previousLinks: [{ requestRef: { projectId: req.projectId, findingId: req.findingId, requestGeneration: 1 }, sourceRecordIds: ['synthetic-rec-1'] }],
    }))
    expect(m).toMatchObject({ status: 'conflict', linkedSourceRecordIds: ['synthetic-rec-1'], amountMinor: null })
    expect(has(m, 'previously_linked_record_reversed')).toBe(true)
  })
})

describe('matchReturns: stale coverage', () => {
  it('never presents absence as a negative conclusion when data predates the request', () => {
    const m = only(matchReturns([syntheticRequest()], [], { dataAsOf: '2026-08-15' }))
    expect(m.status).toBe('unmatched')
    expect(m.coverage).toBe('stale')
    expect(has(m, 'coverage_stale')).toBe(true)
    expect(has(m, 'absence_unknown')).toBe(true)
    expect(has(m, 'no_candidates')).toBe(false)
  })

  it('treats missing freshness as unknown coverage', () => {
    const m = only(matchReturns([syntheticRequest()], []))
    expect(m.coverage).toBe('unknown')
    expect(has(m, 'absence_unknown')).toBe(true)
  })
})

describe('matchReturns: competition between requests', () => {
  const reqA = syntheticRequest({ findingId: 'f-a', references: ['SYN-INV-1001'] })
  const reqB = syntheticRequest({ findingId: 'f-b', references: ['SYN-INV-2002'] })

  it('marks both requests ambiguous when a record fits both and nothing breaks the tie', () => {
    const result = matchReturns([reqA, reqB], [syntheticReturnRecord({ memoReference: null })], AS_OF)
    expect(result.matches.map((m) => m.status)).toEqual(['ambiguous', 'ambiguous'])
    expect(result.matches[0].competingRequests).toEqual([requestKeyOf(reqB)])
    expect(result.matches[1].competingRequests).toEqual([requestKeyOf(reqA)])
    expect(result.matches.every((m) => m.amountMinor === null && m.linkedSourceRecordIds[0] === 'synthetic-rec-1')).toBe(true)
    expect(result.allocations).toEqual([])
    expect(result.unallocatedRecords[0]).toMatchObject({ unallocatedMinor: 125_000, reasons: ['contested'] })
  })

  it('breaks the tie by reference', () => {
    const result = matchReturns([reqA, reqB], [syntheticReturnRecord({ memoReference: 'SYN-INV-2002' })], AS_OF)
    const [a, b] = result.matches
    expect(b).toMatchObject({ status: 'proposed_source_match', amountMinor: 125_000, competingRequests: [] })
    expect(a.status).toBe('unmatched')
    expect(has(a, 'claimed_by_reference_elsewhere')).toBe(true)
  })

  it('never allocates one record to two requests beyond its amount', () => {
    const both = [syntheticRequest({ findingId: 'f-a', references: ['SYN-INV-1001'] }), syntheticRequest({ findingId: 'f-b', references: ['SYN-INV-1001'] })]
    const result = matchReturns(both, [syntheticReturnRecord({ memoReference: 'SYN-INV-1001' })], AS_OF)
    expect(result.matches.map((m) => m.status)).toEqual(['ambiguous', 'ambiguous'])
    expect(result.allocations).toEqual([])
  })

  it('splits a record that covers every reference-agreeing request in full', () => {
    const small = [
      syntheticRequest({ findingId: 'f-a', references: ['SYN-INV-1001'], requestedAmountMinor: 40_000 }),
      syntheticRequest({ findingId: 'f-b', references: ['SYN-INV-1001'], requestedAmountMinor: 60_000 }),
    ]
    const result = matchReturns(small, [syntheticReturnRecord({ memoReference: 'SYN-INV-1001', amountMinor: 125_000 })], AS_OF)
    expect(result.matches.map((m) => [m.status, m.amountMinor])).toEqual([['proposed_source_match', 40_000], ['proposed_source_match', 60_000]])
    const allocated = result.allocations.reduce((s, a) => s + a.allocatedMinor, 0)
    expect(allocated).toBeLessThanOrEqual(125_000)
    expect(result.unallocatedRecords[0].unallocatedMinor).toBe(25_000)
  })

  it('marks a single request ambiguous when two records each equal its amount without reference', () => {
    const records = [syntheticReturnRecord({ id: 'x1', memoReference: null }), syntheticReturnRecord({ id: 'x2', memoReference: null, paymentDate: '2026-09-20' })]
    const m = only(matchReturns([syntheticRequest()], records, AS_OF))
    expect(m.status).toBe('ambiguous')
    expect(m.competingRequests).toEqual([])
    expect(has(m, 'multiple_exact_amount_records')).toBe(true)
  })
})

describe('matchReturns: credits', () => {
  it('reports issued but unapplied credit as not returned', () => {
    const result = matchReturns([syntheticRequest()], [syntheticVendorCredit()], AS_OF)
    const m = only(result)
    expect(m).toMatchObject({ status: 'unmatched', method: 'credit', applied: false, amountMinor: 125_000, creditIssuedNotAppliedMinor: 125_000, linkedSourceRecordIds: ['synthetic-credit-1'] })
    expect(has(m, 'credit_only_not_returned')).toBe(true)
    expect(has(m, 'credit_issued_not_applied')).toBe(true)
    expect(result.allocations[0]).toMatchObject({ applied: false, returnedEvidenceMinor: 0 })
  })

  it('proposes a match for credit applied to a bill', () => {
    const credit = syntheticVendorCredit({ appliedToBills: [{ billRef: 'SYN-BILL-9001', amountMinor: 125_000, date: '2026-09-20' }] })
    const m = only(matchReturns([syntheticRequest()], [credit], AS_OF))
    expect(m).toMatchObject({ status: 'proposed_source_match', method: 'credit', applied: true, amountMinor: 125_000, creditIssuedNotAppliedMinor: 0 })
  })

  it('counts only the applied part of a partly applied credit', () => {
    const credit = syntheticVendorCredit({ appliedToBills: [{ billRef: 'SYN-BILL-9001', amountMinor: 40_000, date: '2026-09-20' }] })
    const m = only(matchReturns([syntheticRequest()], [credit], AS_OF))
    expect(m).toMatchObject({ status: 'proposed_source_match', amountMinor: 40_000, applied: true, creditIssuedNotAppliedMinor: 85_000 })
    expect(has(m, 'credit_issued_not_applied')).toBe(true)
  })

  it('treats credit applied beyond its amount as a conflict', () => {
    const credit = syntheticVendorCredit({ appliedToBills: [{ billRef: 'SYN-BILL-9001', amountMinor: 200_000, date: '2026-09-20' }] })
    expect(only(matchReturns([syntheticRequest()], [credit], AS_OF)).status).toBe('conflict')
  })
})

describe('matchReturns: customer-recorded and supplier statements', () => {
  it('labels customer-recorded returns with no source evidence and keeps the amount separate', () => {
    const m = only(matchReturns([syntheticRequest({ alreadyRecordedMinor: 125_000 })], [], AS_OF))
    expect(m).toMatchObject({ status: 'customer_recorded', amountMinor: null, customerRecordedMinor: 125_000 })
    expect(has(m, 'customer_recorded_only')).toBe(true)
  })

  it('never adds customer-recorded value to source-evidenced value', () => {
    const m = only(matchReturns([syntheticRequest({ alreadyRecordedMinor: 50_000 })], [syntheticReturnRecord({ amountMinor: 50_000 })], AS_OF))
    expect(m).toMatchObject({ status: 'proposed_source_match', amountMinor: 50_000, customerRecordedMinor: 50_000 })
    expect(has(m, 'customer_recorded_separately')).toBe(true)
  })

  it('does not count a supplier promise or credit-issued statement', () => {
    const m = only(matchReturns([syntheticRequest({ status: 'credit_issued' })], [], AS_OF))
    expect(m.status).toBe('unmatched')
    expect(m.amountMinor).toBeNull()
    expect(has(m, 'supplier_statement_not_evidence')).toBe(true)
  })
})

describe('matchReturns: input hygiene and determinism', () => {
  it('reports an invalid request as a conflict without matching it', () => {
    const m = only(matchReturns([syntheticRequest({ requestedAmountMinor: 12.5 })], [syntheticReturnRecord()], AS_OF))
    expect(m.status).toBe('conflict')
    expect(has(m, 'invalid_request')).toBe(true)
  })

  it('returns one match per distinct request', () => {
    const result = matchReturns([syntheticRequest(), syntheticRequest()], [syntheticReturnRecord()], AS_OF)
    expect(only(result).status).toBe('proposed_source_match')
  })

  it('gives identical output for any input order', () => {
    const requests = [
      syntheticRequest({ findingId: 'f-c', references: ['SYN-INV-3003'] }),
      syntheticRequest({ findingId: 'f-a', references: ['SYN-INV-1001'] }),
      syntheticRequest({ projectId: 'synthetic-project-0', findingId: 'f-b', references: ['SYN-INV-2002'], requestedAmountMinor: 30_000 }),
    ]
    const records = [
      syntheticReturnRecord({ id: 'z', memoReference: 'SYN-INV-3003', amountMinor: 10_000 }),
      syntheticReturnRecord({ id: 'm', memoReference: null }),
      syntheticReturnRecord({ id: 'a', memoReference: 'SYN-INV-2002', amountMinor: 30_000, paymentDate: '2026-08-01' }),
      syntheticVendorCredit({ id: 'c', memoReference: 'SYN-INV-3003', appliedToBills: [{ billRef: 'SYN-BILL-1', amountMinor: 5_000, date: null }] }),
    ]
    const forward = matchReturns(requests, records, AS_OF)
    const backward = matchReturns([...requests].reverse(), [...records].reverse(), AS_OF)
    expect(backward).toEqual(forward)
    expect(forward.matches.map((m) => m.requestKey)).toEqual([...forward.matches.map((m) => m.requestKey)].sort())
    expect(JSON.stringify(matchReturns(requests, records, AS_OF))).toBe(JSON.stringify(forward))
  })

  it('has no field that represents a recovered total or adds candidate, promised and returned', () => {
    const result = matchReturns(
      [syntheticRequest({ alreadyRecordedMinor: 10_000, status: 'promised' })],
      [syntheticReturnRecord({ amountMinor: 20_000 }), syntheticVendorCredit({ amountMinor: 30_000 })],
      AS_OF,
    )
    const keys = new Set<string>()
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk)
      else if (v && typeof v === 'object') for (const [k, inner] of Object.entries(v)) { keys.add(k); walk(inner) }
    }
    walk(result)
    for (const k of keys) expect(k.toLowerCase()).not.toMatch(/recovered|total|promised|candidate/)
    const m = only(result)
    // 20,000 refund evidenced; 30,000 credit issued not applied; 10,000 customer-recorded: never combined.
    expect(m.amountMinor).toBe(20_000)
    expect(m.creditIssuedNotAppliedMinor).toBe(30_000)
    expect(m.customerRecordedMinor).toBe(10_000)
    expect([60_000, 50_000, 30_000 + 20_000, 145_000]).not.toContain(m.amountMinor)
  })
})
