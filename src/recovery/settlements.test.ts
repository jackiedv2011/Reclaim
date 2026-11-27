import { describe, expect, it } from 'vitest'
import { confirmCase, withHistory, type CaseState } from '@/ledger/caseState'
import { approveRecovery, fileInternalReview, recordVendorUpdate, reopenRemainingBalance, startRecoveryRequest, verifyRecovery, type SettlementInput } from './model'
import { activeReturned, settlementKey, unrequestedRemainder, verifiedReturned } from './financials'
import { recoveryLedger } from './ledger'

const DAY = 86_400_000
const t0 = Date.UTC(2026, 8, 21, 12)
const requested = (amount = 1000) => startRecoveryRequest(approveRecovery(confirmCase(null), { at: t0, knownBeforeReclaim: false }), amount, t0)
const proof = (amount: number, reference: string, extra: Partial<SettlementInput> = {}): SettlementInput => ({ amount, method: 'refund', source: 'bank', reference, settledAt: t0 + DAY, ...extra })
const record = (state: CaseState, input: SettlementInput) => withHistory(state, verifyRecovery(state, input), 'Ana')

describe('more money than was asked for', () => {
  it('needs confirming, is kept as it arrived, and never counts past the claim', () => {
    expect(() => verifyRecovery(requested(), proof(1050, 'ACH-1'))).toThrow(/remaining requested balance/)
    const settled = record(requested(), proof(1050, 'ACH-1', { excessConfirmed: true, supportedAmount: 1000 }))
    expect(settled).toMatchObject({ recoveryStage: 'recovered', recoveredAmount: 1000 })
    expect(verifiedReturned(settled)).toBe(1000)
    expect(settled.recoverySettlements![0]).toMatchObject({ amount: 1000, receivedAmount: 1050 })
    expect(settled.history!.at(-1)).toMatchObject({ amount: 1000, note: 'ACH-1', summary: expect.stringContaining('noted, not counted') })
  })

  it('counts toward the rest of the claim when the request was for less than the records support', () => {
    const settled = record(requested(400), proof(900, 'ACH-1', { excessConfirmed: true, supportedAmount: 1000 }))
    expect(settled).toMatchObject({ recoveryStage: 'recovered', recoveredAmount: 900 })
    expect(settled.recoverySettlements![0].receivedAmount).toBeUndefined()
    expect(unrequestedRemainder(settled, 1000)).toBe(100)
  })

  it('never saves what was only there to check the entry', () => {
    const settled = verifyRecovery(requested(), proof(1000, 'ACH-1', { excessConfirmed: true, supportedAmount: 1000 }))
    expect(Object.keys(settled.recoverySettlements![0]).sort()).not.toEqual(expect.arrayContaining(['supportedAmount']))
    expect(settled.recoverySettlements![0]).not.toHaveProperty('excessConfirmed')
  })
})

describe('a request for part of what the records support', () => {
  it('leaves the rest pursuable after it is paid in full', () => {
    const paid = record(requested(400), proof(400, 'ACH-1'))
    expect(unrequestedRemainder(paid, 1000)).toBe(600)
    const rest = withHistory(paid, reopenRemainingBalance(paid, t0 + 2 * DAY, 1000), 'Ana')
    expect(rest).toMatchObject({ recoveryStage: 'confirmed', decision: 'confirmed', activeRequestGeneration: 2, requestedAmount: null, approvedAt: null, recoveredAmount: 400 })
    expect(rest.archivedRequests).toEqual([expect.objectContaining({ requestedAmount: 400, recoveryStage: 'recovered' })])
    expect(activeReturned(rest)).toBe(0)
    expect(verifiedReturned(rest)).toBe(400)
    expect(rest.history!.at(-1)!.action).toBe('request:archived')
    const second = verifyRecovery(startRecoveryRequest(approveRecovery(rest, { at: t0, knownBeforeReclaim: false }), 600, t0, 1000), proof(600, 'ACH-2'))
    expect(second).toMatchObject({ recoveryStage: 'recovered', recoveredAmount: 1000 })
    expect(unrequestedRemainder(second, 1000)).toBeNull()
  })

  it('does not reopen a balance the customer closed, or one that is fully paid', () => {
    expect(unrequestedRemainder(record(requested(1000), proof(1000, 'ACH-1')), 1000)).toBeNull()
    expect(unrequestedRemainder(requested(400), 1000)).toBeNull()
    expect(unrequestedRemainder(record(requested(400), proof(400, 'ACH-1')), null)).toBeNull()
  })
})

describe('correcting one recorded return', () => {
  const partial = () => record(record(requested(), proof(300, 'ACH-1')), proof(40, 'ACH-2'))

  it('changes that return only, and the money timeline shows the correction', () => {
    const state = partial()
    const key = settlementKey(state.recoverySettlements![1])
    const fixed = record(state, proof(400, 'ACH-2', { replaces: key, settledAt: t0 + 2 * DAY }))
    expect(fixed).toMatchObject({ recoveryStage: 'requested', recoveredAmount: 700 })
    expect(fixed.recoverySettlements!.map((e) => [e.reference, e.amount])).toEqual([['ACH-1', 300], ['ACH-2', 400]])
    expect(fixed.history!.slice(-2).map((e) => [e.action, e.amount]).sort()).toEqual([['recovery:settlement_corrected', -40], ['recovery:settlement_recorded', 400]])
    const money = recoveryLedger(fixed).filter((e) => e.kind === 'returned' || e.kind === 'reversed')
    expect(money.reduce((sum, e) => sum + e.amount!, 0)).toBe(700)
  })

  it('can take a return off without clearing the rest', () => {
    const state = partial()
    const removed = record(state, proof(40, 'ACH-2', { replaces: settlementKey(state.recoverySettlements![1]), remove: true }))
    expect(removed).toMatchObject({ recoveryStage: 'requested', recoveredAmount: 300 })
    expect(removed.recoverySettlements).toHaveLength(1)
    expect(removed.history!.at(-1)).toMatchObject({ action: 'recovery:settlement_corrected', summary: 'Recorded return removed', amount: -40 })
    const empty = record(removed, proof(300, 'ACH-1', { replaces: settlementKey(removed.recoverySettlements![0]), remove: true }))
    expect(empty).toMatchObject({ recoveryStage: 'requested', recoveredAmount: null })
    expect(verifiedReturned(empty)).toBe(0)
  })

  it('may keep its own reference but not take another return’s', () => {
    const state = partial()
    const key = settlementKey(state.recoverySettlements![1])
    expect(record(state, proof(41, 'ach-2', { replaces: key })).recoveredAmount).toBe(341)
    expect(() => verifyRecovery(state, proof(41, 'ACH-1', { replaces: key }))).toThrow(/already recorded/)
    expect(() => verifyRecovery(state, proof(41, 'ACH-9', { replaces: 'refund|gone|' }))).toThrow(/no longer on this case/)
  })

  it('closes the case when the corrected amount pays it in full', () => {
    const state = partial()
    const done = record(state, proof(700, 'ACH-2', { replaces: settlementKey(state.recoverySettlements![1]) }))
    expect(done).toMatchObject({ recoveryStage: 'recovered', recoveredAmount: 1000 })
  })
})

describe('the date money arrived', () => {
  it('can be in the past and not in the future', () => {
    expect(verifyRecovery(requested(), proof(1000, 'ACH-1', { settledAt: t0 - 3 * DAY }), t0).recoveryResolvedAt).toBe(t0 - 3 * DAY)
    expect(() => verifyRecovery(requested(), proof(1000, 'ACH-1', { settledAt: t0 + DAY }), t0)).toThrow(/future/)
    expect(() => verifyRecovery(requested(), proof(1000, 'ACH-1', { settledAt: Number.NaN }), t0)).toThrow(/date/)
  })
})

describe('internal reviews and vendor figures', () => {
  it('files an internal review with no amount, whatever an earlier draft held', () => {
    expect(fileInternalReview({ ...confirmCase(null), requestedAmount: 720 }, { subject: 'Check', body: 'Note' }, t0)).toMatchObject({ recoveryStage: 'requested', requestedAmount: null, recoveryRequestedAt: t0 })
    expect(() => fileInternalReview(requested(), { subject: 'Check', body: 'Note' }, t0)).toThrow()
  })
  it('refuses a $0 vendor figure rather than reading it as a full acceptance', () => {
    expect(() => recordVendorUpdate(requested(), { status: 'accepted', note: 'Agreed', amount: 0, at: t0 }, t0)).toThrow(/above \$0/)
  })
})
