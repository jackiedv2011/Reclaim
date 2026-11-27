import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/csv'
import { mergeImport, recordEvidence, setCaseState, type LedgerEnvironment } from '@/ledger/store'
import { confirmCase, markExpected, EMPTY_CASE_STATE, type CaseState, type DismissalTag } from '@/ledger/caseState'
import { approveRecovery, startRecoveryRequest, verifyRecovery } from './model'
import { attestDuplicate } from './testEvidence'
import { claimContext } from './claimLinks'
import { eligiblePotential } from './financials'
import { evaluateEligibility } from './eligibility'
import { ladder, opportunities, vendors } from '@/workspace/selectors'
import { findCaseView, findingsQueue } from '@/ledger/views'

const HEADER = 'vendor,invoice_number,invoice_date,payment_date,invoice_amount,amount_paid,currency'
const row = (day: string, amount = 1000, invoice = 'INV-1', vendor = 'Acme', invoiceAmount: number | '' = 1000) => `${vendor},${invoice},2025-01-01,${day},${invoiceAmount},${amount},USD`
const add = (env: LedgerEnvironment | null, name: string, rows: string[]) => mergeImport(env, { sourceLabel: name, mode: 'upload', parsed: parseCsv([HEADER, ...rows].join('\n')) })
const duplicate = (env: LedgerEnvironment, rows: number) => env.result.findings.find((f) => f.type === 'exact_duplicate' && f.relatedRecords.length === rows)!
const attest = (env: LedgerEnvironment, rows: number) => { const f = duplicate(env, rows); return recordEvidence(env, f.id, attestDuplicate(f).evidence!) }
const request = (amount: number) => startRecoveryRequest(approveRecovery(confirmCase(null), { at: 100, knownBeforeReclaim: false }), amount, 200)
const paid = (state: CaseState, amount: number) => verifyRecovery(state, { amount, method: 'refund', source: 'bank', reference: 'ACH-1', settledAt: 300 })
const linkedPotential = (env: LedgerEnvironment, rows: number) => eligiblePotential(claimContext(env.result.findings, env.caseStates).finding(duplicate(env, rows)), env.result.findings)

/** Two payments of one invoice with an attested case in `state`, then a third payment of it. */
function thirdPayment(state: CaseState): LedgerEnvironment {
  const first = attest(add(null, 'a.csv', [row('2025-01-10'), row('2025-01-20')]), 2)
  return attest(add(setCaseState(first, duplicate(first, 2).id, state), 'b.csv', [row('2025-02-01')]), 3)
}

describe('a finding that replaces one already being recovered', () => {
  it('carries only the money that is still unclaimed, after $1,000 came back', () => {
    const env = thirdPayment(paid(request(1000), 1000))
    expect(linkedPotential(env, 3)).toBe(1000)
    const l = ladder(env)
    expect(l).toMatchObject({ potential: 1000, recovered: 1000 })
    expect(vendors(env).find((v) => v.vendor === 'Acme')).toMatchObject({ potential: 1000, recovered: 1000 })
    // The screens read the same finding: the case page, the list and the totals.
    const view = findCaseView(env, duplicate(env, 3).id)!
    expect(evaluateEligibility(view.finding, view.finding.evidence, env.result.findings)).toMatchObject({ eligible: true, potentialAmountMinor: 100000, amountBreakdown: { linkedReturnedMinor: 100000 } })
  })

  it('does not ask for the open request again', () => {
    const env = thirdPayment(request(1000))
    expect(linkedPotential(env, 3)).toBe(1000)
    const l = ladder(env)
    expect(l.potential + l.inRecovery).toBe(2000)
  })

  it('takes off a partial return and the rest of the request, once', () => {
    expect(linkedPotential(thirdPayment(paid(request(1000), 300)), 3)).toBe(1000)
  })

  it('does not take the same return off twice when the reviewer lists it as a prior return', () => {
    let env = thirdPayment(paid(request(1000), 1000))
    const finding = duplicate(env, 3)
    const evidence = { ...finding.evidence!, priorReturns: [{ method: 'refund' as const, amountMinor: 100000, reference: 'ach-1', confirmedBy: 'Ana', confirmedAt: 400 }] }
    env = recordEvidence(env, finding.id, evidence)
    expect(linkedPotential(env, 3)).toBe(1000)
  })

  it('claims the whole amount when the earlier case never asked for anything, or was closed with nothing back', () => {
    expect(linkedPotential(thirdPayment(confirmCase(null)), 3)).toBe(2000)
    expect(linkedPotential(thirdPayment({ ...request(1000), recoveryStage: 'not_recovered' }), 3)).toBe(2000)
  })

  it('is not eligible when the earlier case already covers everything', () => {
    const env = thirdPayment({ ...request(1000), requestedAmount: 2000 })
    const finding = claimContext(env.result.findings, env.caseStates).finding(duplicate(env, 3))
    expect(evaluateEligibility(finding, finding.evidence, env.result.findings)).toMatchObject({ eligible: false, potentialAmountMinor: null, contradictoryEvidence: [expect.stringContaining('already covers')] })
  })

  it('leaves findings with nothing earlier exactly as they were', () => {
    const env = attest(add(null, 'a.csv', [row('2025-01-10'), row('2025-01-20')]), 2)
    const context = claimContext(env.result.findings, env.caseStates)
    for (const finding of env.result.findings) expect(context.finding(finding)).toBe(finding)
  })
})

describe('a dismissal when later rows are more of the same', () => {
  function dismissed(rows: string[], later: string[], tag: DismissalTag | null = 'intentional') {
    const first = add(null, 'a.csv', rows)
    const finding = first.result.findings.find((f) => f.type === 'exact_duplicate')!
    return add(setCaseState(first, finding.id, markExpected('Paid in instalments', tag)), 'b.csv', later)
  }
  const latest = (env: LedgerEnvironment) => env.result.findings.find((f) => f.type === 'exact_duplicate' && !f.suppressionReason)!
  const stateOf = (env: LedgerEnvironment) => claimContext(env.result.findings, env.caseStates).state(latest(env))
  const instalment = (day: string, amount = 500) => row(day, amount, 'JOB-77', 'Acme', '')

  it('still stands for another instalment, on every screen', () => {
    const env = dismissed([instalment('2025-01-10'), instalment('2025-02-10')], [instalment('2025-03-10')])
    expect(stateOf(env)).toMatchObject({ decision: 'expected', reason: 'Paid in instalments', dismissalTag: 'intentional' })
    const o = opportunities(env).find((x) => x.finding.id === latest(env).id)!
    expect(o.state.decision).toBe('expected')
    expect(ladder(env)).toMatchObject({ flagged: 0, flaggedCount: 0, openCount: 0 })
    expect(findCaseView(env, latest(env).id)!.state.decision).toBe('expected')
    expect(findingsQueue(env).flatMap((g) => g.cases)).toEqual([])
  })

  it('stands through a second import of the same kind', () => {
    const env = add(dismissed([instalment('2025-01-10'), instalment('2025-02-10')], [instalment('2025-03-10')]), 'c.csv', [instalment('2025-04-10')])
    expect(latest(env).relatedRecords).toHaveLength(4)
    expect(stateOf(env).decision).toBe('expected')
  })

  it('comes back for a payment of a different size, and after the reviewer takes it back', () => {
    expect(stateOf(dismissed([instalment('2025-01-10', 400), instalment('2025-02-10', 500)], [instalment('2025-03-10', 450)])).decision).toBe('expected')
    expect(stateOf(dismissed([instalment('2025-01-10', 400), instalment('2025-02-10', 500)], [instalment('2025-03-10', 5000)])).decision).toBeNull()
    const env = dismissed([instalment('2025-01-10'), instalment('2025-02-10')], [instalment('2025-03-10')])
    const reopened = setCaseState(env, latest(env).id, EMPTY_CASE_STATE)
    expect(stateOf(reopened).decision).toBeNull()
  })

  it('does not carry "these records don’t match" or "the check got it wrong" to new rows', () => {
    for (const tag of ['not_a_match', 'detection_error'] as const) expect(stateOf(dismissed([instalment('2025-01-10'), instalment('2025-02-10')], [instalment('2025-03-10')], tag)).decision).toBeNull()
  })
})
