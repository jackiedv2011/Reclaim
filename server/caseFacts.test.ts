// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { authorizedDraftFacts, authorizedFollowUpFacts, authorizedSendFacts, calendarDay } from './caseFacts.ts'
import { authorizedProject } from './testProject.ts'

describe('authorized request generations', () => {
  it('uses old returns for the new approval ceiling and active returns for follow-up', () => {
    const { project, findingId } = authorizedProject('new-generation', { vendor: 'Acme', invoice: 'INV-1', amount: 100, requested: 70 })
    const state = project.environment.caseStates[findingId] as typeof project.environment.caseStates[typeof findingId] & Record<string, unknown>
    Object.assign(state, {
      activeRequestGeneration: 2,
      recoverySubject: 'Fresh request', recoveryDraft: 'Please review.', recoveryRecipientEmail: 'vendor@example.test',
      recoverySettlements: [{ amount: 30, method: 'refund', source: 'manual', reference: 'OLD-30', settledAt: 10 }],
    })
    expect(authorizedSendFacts(project, findingId, 70).ok).toBe(true)
    state.recoveryStage = 'requested'
    expect(authorizedFollowUpFacts(project, findingId).ok).toBe(true)
    state.recoveryStage = 'confirmed'
    ;(state.recoverySettlements as Array<Record<string, unknown>>).push({ amount: 10, method: 'refund', source: 'manual', reference: 'OLD-LATE', settledAt: 20, requestGeneration: 1 })
    expect(authorizedSendFacts(project, findingId, 70)).toMatchObject({ ok: false, reason: expect.stringMatching(/earlier returns/i) })
  })
})

describe('dates in an AI draft', () => {
  it('uses a stored calendar day as it is', () => {
    expect(calendarDay('2025-01-05')).toBe('2025-01-05')
    expect(calendarDay(null)).toBeNull()
    expect(calendarDay('')).toBeNull()
    expect(calendarDay('not a date')).toBeNull()
  })

  it.each([
    ['Berlin, winter', '2025-01-04T23:00:00.000Z'],
    ['Berlin, summer clock', '2025-01-04T22:00:00.000Z'],
    ['Auckland', '2025-01-04T12:00:00.000Z'],
    ['London', '2025-01-05T00:00:00.000Z'],
    ['New York', '2025-01-05T05:00:00.000Z'],
    ['Los Angeles', '2025-01-05T08:00:00.000Z'],
  ])('reads an older saved instant as the day it was in %s', (_where, instant) => {
    expect(calendarDay(instant)).toBe('2025-01-05')
  })

  it('gives the draft the day the customer saw', () => {
    const { project, findingId } = authorizedProject('berlin', { vendor: 'Acme', invoice: 'INV-1', amount: 100, requested: 100 })
    Object.assign(project.environment.records[0], { paymentDate: '2025-01-04T23:00:00.000Z', invoiceDate: '2024-12-31T23:00:00.000Z' })
    const facts = authorizedDraftFacts(project, findingId, 100)
    expect(facts.ok && facts.facts.rows).toMatchObject([{ paymentDate: '2025-01-05', invoiceDate: '2025-01-01' }, { paymentDate: '2025-01-12' }])
  })
})

describe('an earlier case on the same payments', () => {
  it('lowers what may be sent by what it already has out', () => {
    const { project, findingId } = authorizedProject('linked', { vendor: 'Acme', invoice: 'INV-1', amount: 100, requested: 100 })
    const env = project.environment as unknown as { result: { findings: Array<Record<string, unknown>> }; caseStates: Record<string, unknown> }
    expect(authorizedSendFacts(project, findingId, 100).ok).toBe(true)
    env.result.findings.push({ ...env.result.findings[0], id: 'earlier', classification: 'review_needed', suppressionReason: 'Source records changed after this finding.' })
    env.caseStates.earlier = { decision: 'confirmed', recoveryStage: 'requested', requestedAmount: 100, requiresRevalidation: true }
    expect(authorizedSendFacts(project, findingId, 100).ok).toBe(false)
  })
})
