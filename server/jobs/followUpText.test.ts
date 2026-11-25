// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { CaseState } from '../../src/ledger/caseState.ts'
import type { Finding } from '../../src/types.ts'
import { storedCase } from '../recoveryFacts.ts'
import { followUpText, type Sender } from './followUpText.ts'
import { AMOUNT, DAY, requestedProject } from './testFixtures.ts'

// Loaded by path at run time: src/lib/followUps.ts uses the browser's `@/`
// alias, which Vitest resolves but tsconfig.server.json does not.
const browserModule = '../../src/lib/followUps.ts'
type Generate = (finding: Finding, state: CaseState, sender: Sender, lastOutreachAt: number) => { subject: string; body: string }

const T0 = Date.UTC(2026, 10, 25, 15)
const senders: Sender[] = [
  { senderName: 'Pat Lee', businessName: 'Customer Co', senderEmail: '' },
  { senderName: '', businessName: '', senderEmail: '' },
]
const states: Array<[string, Record<string, unknown>]> = [
  ['first follow-up', {}],
  ['second follow-up', { recoveryFollowUps: [{ channel: 'gmail', messageId: 'f1', from: 'x', to: 'y', cc: [], sentAt: T0 - 3 * DAY }] }],
  ['partial return', { recoverySettlements: [{ amount: 1000, reference: 'B-1', settledAt: T0 - DAY, source: 'bank', method: 'refund' }] }],
  ['credit, no draft, Re: subject', { requestedResolution: 'credit', recoveryDraft: null, recoverySubject: 'Re: earlier thread' }],
  ['offset, no subject', { requestedResolution: 'offset', recoverySubject: null }],
]

describe('followUpText', () => {
  it.each(states)('matches the browser letter exactly (%s)', async (_label, state) => {
    const { generateFollowUp } = await import(/* @vite-ignore */ browserModule) as { generateFollowUp: Generate }
    const { project, findingId } = requestedProject('p1', { sentAt: T0 - 10 * DAY, state })
    const c = storedCase(project, findingId)!
    for (const sender of senders) {
      expect(followUpText(c.finding, c.state, sender, T0 - 10 * DAY)).toEqual(generateFollowUp(c.finding, c.state, sender, T0 - 10 * DAY))
    }
  })

  it('states only facts already on the case', () => {
    const { project, findingId } = requestedProject('p1', { sentAt: T0 - 10 * DAY })
    const c = storedCase(project, findingId)!
    const { subject, body } = followUpText(c.finding, c.state, senders[0], T0 - 10 * DAY)
    expect(subject).toBe('Re: Duplicate payment of invoice INV-77')
    expect(body).toContain('$4,321.87')
    expect(body).toContain(`Please refund ${AMOUNT}.`)
  })
})
