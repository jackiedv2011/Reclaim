// @vitest-environment node
/**
 * What the browser lets someone do, the server must accept: every case here was
 * once refused with a 400 or 409 after the screen had already said it was saved.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './db.ts'
import { ProjectStore } from './projectStore.ts'
import { CaseCommands } from './caseCommands.ts'
import { authorizedProject } from './testProject.ts'
import type { CaseState } from '../src/ledger/caseState.ts'
import type { Finding } from '../src/types.ts'

let db: DatabaseSync | null = null
afterEach(() => { db?.close(); db = null })

type Project = ReturnType<typeof authorizedProject>['project']
function setup(edit: (project: Project, findingId: string) => void = () => {}) {
  db = openDatabase(':memory:')
  db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)').run('alice', 'alice@example.test', 1)
  const projects = new ProjectStore(db, null)
  const commands = new CaseCommands(db, projects)
  const { project, findingId } = authorizedProject('a1', { vendor: 'Acme', invoice: 'INV-1', amount: 1000, requested: 1000 })
  edit(project, findingId)
  projects.upsert('alice', project)
  const send = (type: string, input: unknown, id = findingId) =>
    commands.execute('alice', 'alice@example.test', 'a1', { commandId: randomUUID(), expectedRevision: projects.revision('alice', 'a1')!, findingId: id, type, input })
  const env = () => projects.get('alice', 'a1')!.environment as { caseStates: Record<string, CaseState>; result: { findings: Finding[] } }
  return { send, env, projects, findingId, state: (id = findingId) => env().caseStates[id], finding: (id = findingId) => env().result.findings.find((f) => f.id === id)! }
}
const requested = (project: Project, findingId: string, extra: Record<string, unknown> = {}) =>
  Object.assign(project.environment.caseStates[findingId], { recoveryStage: 'requested', recoveryRequestedAt: 100, ...extra })
const refund = (amount: number, reference: string, extra: Record<string, unknown> = {}) => ({ amount, method: 'refund', source: 'bank', reference, settledAt: 1000, ...extra })
const pkg = (extra: Record<string, unknown> = {}) => ({ subject: 'Duplicate payment', body: 'Please review.', recipientEmail: 'ap@vendor.test', recipientConfirmed: true, requestedAmount: 1000, method: 'refund', ...extra })

describe('partial evidence', () => {
  const partial = (project: Project) => ({
    entity: { entityId: '', reference: '' }, supplier: { supplierId: '', reference: '' },
    payments: project.environment.records.map((r) => ({ recordId: r.id, paymentId: '', reference: '', obligationId: '', amountMinor: 100000, currency: '', settled: false })),
    obligation: { obligationId: 'INV-1', reference: '', amountMinor: 0, currency: '' },
    checks: { refund: { confirmed: true, reference: 'Searched deposits' } }, contradictions: [''], notes: '',
  })

  it('is saved, and does not make the case eligible', () => {
    let input: unknown
    const { send, state, finding } = setup((project) => {
      project.environment.caseStates = {}
      delete (project.environment.result.findings[0] as { evidence?: unknown }).evidence
      input = partial(project)
    })
    expect(send('evidence', input).revision).toBe(2)
    expect(finding()).toMatchObject({ classification: 'review_needed', potentialAmountMinor: null, evidence: { obligation: { obligationId: 'INV-1' } } })
    expect(finding().evidence!.checks.refund).toMatchObject({ confirmed: true, reference: 'Searched deposits', confirmedBy: 'alice@example.test' })
    expect(state().requiresRevalidation).toBe(true)
    // Nothing that isn't complete can be approved.
    send('decision', { decision: 'confirmed', reason: null })
    expect(() => send('approve', { package: pkg(), knownBeforeReclaim: false, knownBeforeNote: null })).toThrow()
  })

  it('still refuses evidence for rows that are not in the check', () => {
    let input: ReturnType<typeof partial>
    const { send } = setup((project) => { input = partial(project) })
    expect(() => send('evidence', { ...input!, payments: input!.payments.map((p, i) => (i ? p : { ...p, recordId: 'someone-elses' })) })).toThrow(/exactly the source rows/i)
  })
})

describe('internal reviews', () => {
  const internal = (type: string) => (project: Project, findingId: string) => {
    Object.assign(project.environment.result.findings[0], { type, class: 'review', classification: 'review_needed' })
    project.environment.caseStates = { [findingId]: { decision: 'confirmed', reason: null, decidedAt: 1, recoveryStage: 'confirmed' } } as unknown as Project['environment']['caseStates']
  }
  it.each(['overpayment', 'bank_account_change'])('"Mark as filed" on a %s review is accepted with no recipient, and can be closed', (type) => {
    const { send, state } = setup(internal(type))
    // Exactly what the screen sends: no supplier, no amount.
    send('request', { subject: 'Review evidence for Acme', body: 'INTERNAL REVIEW NOTE', recipientEmail: '', recipientConfirmed: false, requestedAmount: 0, method: 'refund', evidenceAttachment: null })
    expect(state()).toMatchObject({ recoveryStage: 'requested', requestedAmount: null })
    expect(state().history!.at(-1)).toMatchObject({ action: 'review:filed', amount: null })
    send('close', { reason: 'Checked with the vendor by phone' })
    expect(state()).toMatchObject({ recoveryStage: 'not_recovered', recoveryOutcomeNote: 'Checked with the vendor by phone' })
    expect(state().history!.at(-1)).toMatchObject({ action: 'review:closed' })
  })
  it('has its own commands, which never apply to a vendor request', () => {
    const { send, state } = setup(internal('overpayment'))
    send('file_internal_review', { subject: 'Review', body: 'Note' })
    expect(state().recoveryStage).toBe('requested')
    send('close_internal_review', { reason: 'Splits explained' })
    expect(state().recoveryStage).toBe('not_recovered')
  })
  it('refuses a request that went to a vendor when the saved evidence no longer supports it, rather than filing it', () => {
    const { send, state } = setup((project) => { Object.assign(project.environment.result.findings[0], { class: 'review', classification: 'review_needed', evidence: undefined }) })
    expect(() => send('request', pkg())).toThrow(/evidence review/i)
    expect(state().recoveryStage).toBe('confirmed')
  })
  it('does not let a vendor request skip its recipient by filing internally', () => {
    const { send } = setup()
    expect(() => send('file_internal_review', { subject: 'Review', body: 'Note' })).toThrow(/internal/i)
    expect(() => send('request', pkg({ recipientEmail: '' }))).toThrow(/malformed/i)
  })
})

describe('repeating something already saved', () => {
  it('"Save date" twice succeeds both times and records one change', () => {
    const { send, state, projects } = setup((p, id) => requested(p, id))
    const at = Date.now() + 86_400_000
    expect(send('followup', { at }).revision).toBe(2)
    expect(send('followup', { at })).toMatchObject({ revision: 2, project: expect.objectContaining({ id: 'a1' }) })
    expect(projects.revision('alice', 'a1')).toBe(2)
    expect(state().history).toHaveLength(1)
  })
})

describe('one vendor refund covering two duplicates', () => {
  it('can be split across the two cases, and still refused twice inside one', () => {
    const other = authorizedProject('second', { vendor: 'Acme', invoice: 'INV-2', amount: 500, requested: 500 })
    const { send, state } = setup((project, id) => {
      requested(project, id)
      requested(other.project, other.findingId)
      const env = project.environment as unknown as { records: unknown[]; result: { findings: unknown[] }; caseStates: Record<string, unknown> }
      env.records.push(...other.project.environment.records)
      env.result.findings.push(...other.project.environment.result.findings)
      Object.assign(env.caseStates, other.project.environment.caseStates)
    })
    send('settlement', refund(1000, 'ACH-77'))
    send('settlement', refund(300, 'ach-77'), other.findingId)
    expect(state().recoveredAmount).toBe(1000)
    expect(state(other.findingId).recoveredAmount).toBe(300)
    expect(() => send('settlement', refund(200, 'ACH-77'), other.findingId)).toThrow(/already recorded/i)
  })
})

describe('vendor replies', () => {
  it('refuses a $0 figure with the same plain reason the screen gives', () => {
    const { send } = setup((p, id) => requested(p, id))
    expect(() => send('vendor_update', { status: 'promised', note: 'Refund coming', at: 200, amount: 0 })).toThrow(/above \$0/i)
    expect(send('vendor_update', { status: 'promised', note: 'Refund coming', at: 200 }).revision).toBe(2)
  })
})

describe('recipient email', () => {
  it.each([["o'brien@vendor.test", true], ['ap+refunds@vendor.co.uk', true], ['a&b@vendor.test', true], ['ap@vendor', false], ['ap@vendor.c', false], ['two@x.test, three@x.test', false], ['<ap@vendor.test>', false]])('%s → %s', (recipientEmail, ok) => {
    const { send } = setup()
    const approve = () => send('approve', { package: pkg({ recipientEmail }), knownBeforeReclaim: false, knownBeforeNote: null })
    if (ok) expect(approve().revision).toBe(2)
    else expect(approve).toThrow(/malformed/i)
  })
})

describe('dismissal reasons', () => {
  const undecided = (project: Project) => { project.environment.caseStates = {} }
  it('keeps the tag and the note', () => {
    const { send, state } = setup(undecided)
    send('decision', { decision: 'expected', reason: 'Two halves of one job', dismissalTag: 'intentional' })
    expect(state()).toMatchObject({ decision: 'expected', dismissalTag: 'intentional', reason: 'Two halves of one job' })
  })
  it('takes back a dismissal carried over from a finding this one replaced', () => {
    const { send, state } = setup((project, id) => {
      const env = project.environment as unknown as { records: Array<Record<string, unknown>>; result: { findings: Array<Record<string, any>> }; caseStates: Record<string, unknown> }
      const old = env.result.findings[0]
      env.records.push({ ...env.records[0], id: 'a1-r2', paymentDate: '2025-02-01' })
      env.result.findings = [{ ...old, id: 'new', relatedRecords: [...old.relatedRecords, { id: 'a1-r2' }] }, { ...old, suppressionReason: 'Source records changed after this finding.' }]
      env.caseStates = { [id]: { decision: 'expected', reason: 'Instalments', decidedAt: 5, recoveryStage: null, dismissalTag: 'intentional', requiresRevalidation: true } }
    })
    send('reopen', {}, 'new')
    expect(state('new')).toMatchObject({ decision: null })
    expect(state('new').history!.at(-1)).toMatchObject({ action: 'decision:reopened' })
    expect(JSON.stringify(state('new'))).not.toContain('carriedFrom')
  })
  it('accepts a decision with no tag, and refuses one it does not know', () => {
    const { send, state } = setup(undecided)
    send('decision', { decision: 'expected', reason: null })
    expect(state().dismissalTag ?? null).toBeNull()
    expect(() => send('decision', { decision: 'expected', reason: null, dismissalTag: 'because' })).toThrow(/malformed/i)
  })
})

describe('money as it arrived', () => {
  it('records more than was asked for only when confirmed, and counts no more than the records support', () => {
    const { send, state } = setup((p, id) => requested(p, id))
    expect(() => send('settlement', refund(1050, 'ACH-1'))).toThrow(/remaining requested balance/i)
    send('settlement', refund(1050, 'ACH-1', { excessConfirmed: true }))
    expect(state()).toMatchObject({ recoveryStage: 'recovered', recoveredAmount: 1000 })
    expect(state().recoverySettlements).toEqual([expect.objectContaining({ amount: 1000, receivedAmount: 1050 })])
  })

  it('counts a refund above a partial request up to what the records support', () => {
    const { send, state } = setup((p, id) => requested(p, id, { requestedAmount: 400 }))
    send('settlement', refund(1000, 'ACH-1', { excessConfirmed: true }))
    expect(state()).toMatchObject({ recoveryStage: 'recovered', recoveredAmount: 1000 })
    expect(() => send('reopen_balance', {})).toThrow(/remaining balance/i)
  })

  it('keeps the rest of a supported amount pursuable after a smaller request is paid in full', () => {
    const { send, state } = setup((p, id) => requested(p, id, { requestedAmount: 400 }))
    send('settlement', refund(400, 'ACH-1'))
    expect(state()).toMatchObject({ recoveryStage: 'recovered', recoveredAmount: 400 })
    send('reopen_balance', {})
    expect(state()).toMatchObject({ recoveryStage: 'confirmed', activeRequestGeneration: 2, approvedAt: null, requestedAmount: null, recoveredAmount: 400 })
    expect(state().requiresRevalidation).toBeFalsy()
    expect(() => send('approve', { package: pkg({ requestedAmount: 601 }), knownBeforeReclaim: false, knownBeforeNote: null })).toThrow(/earlier returns/i)
    send('approve', { package: pkg({ requestedAmount: 600 }), knownBeforeReclaim: false, knownBeforeNote: null })
    send('request', pkg({ requestedAmount: 600 }))
    send('settlement', refund(600, 'ACH-2'))
    expect(state()).toMatchObject({ recoveryStage: 'recovered', recoveredAmount: 1000 })
  })

  it('corrects or removes one recorded return without touching the others', () => {
    const { send, state } = setup((p, id) => requested(p, id))
    send('settlement', refund(300, 'ACH-1'))
    send('settlement', refund(40, 'ACH-2'))
    send('settlement', refund(400, 'ACH-2', { replaces: 'refund|ach-2|' }))
    expect(state()).toMatchObject({ recoveryStage: 'requested', recoveredAmount: 700 })
    expect(state().history!.map((e) => e.action)).toContain('recovery:settlement_corrected')
    send('settlement', { ...refund(400, 'ACH-2'), replaces: 'refund|ach-2|', remove: true })
    expect(state()).toMatchObject({ recoveryStage: 'requested', recoveredAmount: 300 })
    expect(() => send('settlement', refund(1, 'X', { replaces: 'refund|nothing|' }))).toThrow(/no longer on this case/i)
  })

  it('accepts a computer clock a few minutes fast', () => {
    const { send, state } = setup((p, id) => requested(p, id))
    send('settlement', refund(10, 'ACH-1', { settledAt: Date.now() + 120_000 }))
    expect(state().recoverySettlements![0].settledAt).toBeLessThanOrEqual(Date.now())
  })

  it('refuses a return dated in the future', () => {
    const { send } = setup((p, id) => requested(p, id))
    expect(() => send('settlement', refund(10, 'ACH-1', { settledAt: Date.now() + 2 * 86_400_000 }))).toThrow(/future/i)
  })
})

describe('a third payment on an invoice already being recovered', () => {
  function superseded(state: Record<string, unknown>) {
    return setup((project, id) => {
      const env = project.environment as unknown as { records: Array<Record<string, unknown>>; result: { findings: Array<Record<string, any>> }; caseStates: Record<string, unknown> }
      const old = env.result.findings[0]
      env.records.push({ ...env.records[0], id: 'a1-r2', paymentDate: '2025-02-01' })
      const evidence = JSON.parse(JSON.stringify(old.evidence))
      evidence.payments.push({ ...evidence.payments[0], recordId: 'a1-r2', paymentId: 'a1-r2' })
      env.result.findings = [
        { ...old, id: 'new', dollarImpact: 2000, flaggedAmount: 2000, relatedRecords: [...old.relatedRecords, { id: 'a1-r2' }], evidence },
        { ...old, classification: 'review_needed', class: 'review', requiresRevalidation: true, potentialAmountMinor: null, suppressionReason: 'Source records changed after this finding.' },
      ]
      env.caseStates = { [id]: { decision: 'confirmed', reason: null, decidedAt: 1, approvedAt: 100, requestedAmount: 1000, requiresRevalidation: true, ...state }, new: { decision: 'confirmed', reason: null, decidedAt: 1, recoveryStage: 'confirmed' } }
    })
  }
  it.each([
    ['money already back', { recoveryStage: 'recovered', recoverySettlements: [refund(1000, 'ACH-1')] }],
    ['a request still open', { recoveryStage: 'requested' }],
  ])('cannot be asked for twice: %s', (_label, state) => {
    const { send } = superseded(state)
    const approve = (amount: number) => send('approve', { package: pkg({ requestedAmount: amount }), knownBeforeReclaim: false, knownBeforeNote: null }, 'new')
    expect(() => approve(2000)).toThrow()
    expect(() => approve(1000.01)).toThrow()
    expect(approve(1000).revision).toBe(2)
  })
  it('never stores the linked figures on the finding', () => {
    const { send, finding, env } = superseded({ recoveryStage: 'requested' })
    send('evidence', JSON.parse(JSON.stringify(finding('new').evidence)), 'new')
    expect(JSON.stringify(env())).not.toContain('linkedClaims')
    expect(finding('new').potentialAmountMinor).toBe(100000)
  })
})
