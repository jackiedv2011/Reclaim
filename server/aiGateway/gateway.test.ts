// @vitest-environment node
import { describe, expect, it, beforeEach } from 'vitest'
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from '../db.ts'
import { ProjectStore } from '../projectStore.ts'
import { authorizedProject } from '../testProject.ts'
import { tenantForUser, systemContext } from '../tenant.ts'
import { AiExecutionService } from './service.ts'
import { AiTransientError, createMockProvider, type AiProvider } from './providers.ts'
import { registerAiTasks } from './tasks/index.ts'
import { checkText, moneyMentions, scrubFreeText } from './validators.ts'
import { Pseudonymizer } from './pseudonymize.ts'
import type { AiTask } from './types.ts'

const draftInput = { amountRequested: 6800, method: 'refund', userContext: '', sender: { businessName: 'Bean Co', senderName: 'Alice Ng' } }
const goodDraft = { subject: 'Duplicate payment for [[INVOICE_1]]', body: 'Hello [[SUPPLIER]],\n\nOur records show invoice [[INVOICE_1]] was paid twice. Please refund $6,800.00.\n\n[[SENDER_NAME]]\n[[SENDER_BUSINESS]]' }

let db: DatabaseSync
let projects: ProjectStore
let clock: number
const alice = { id: 'u-alice', email: 'alice@example.test' }
const bob = { id: 'u-bob', email: 'bob@example.test' }

function setup(provider: AiProvider | null, limits = {}) {
  const ai = registerAiTasks(new AiExecutionService({ db, providers: [provider], getProject: (t, p) => projects.get(t, p), now: () => clock, limits }))
  return ai
}
async function enable(ai: AiExecutionService, user = alice) {
  const t = tenantForUser(user)
  ai.policies.set(t, 'on_demand')
  return ai.consent(t, 'draft_recovery_request', { scope: 'field_set' })
}

beforeEach(() => {
  db = openDatabase(':memory:')
  for (const u of [alice, bob]) db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, 1)').run(u.id, u.email)
  projects = new ProjectStore(db, null)
  const saved = authorizedProject('p1', { vendor: 'Sierra Coffee Supply', invoice: 'INV-77', amount: 6800, requested: 6800 })
  projects.upsert(alice.id, saved.project)
  clock = 1_800_000_000_000
})
const findingId = 'exact_duplicate-p1'
const run = (ai: AiExecutionService, input: unknown = draftInput, user = alice, extra: Record<string, unknown> = {}) =>
  ai.run<{ subject: string; body: string }>(tenantForUser(user), 'draft_recovery_request', { projectId: 'p1', findingId, input, ...extra })

describe('validators', () => {
  it('finds money however it is written', () => {
    const found = moneyMentions('$1,200.50, USD 300, 45 dollars, US$ 9, 2k dollars, €40, 12 EUR, £3').map((m) => [m.currency, m.minor])
    expect(found).toEqual(expect.arrayContaining([['USD', 120050], ['USD', 30000], ['USD', 4500], ['USD', 900], ['USD', 200000], ['EUR', 4000], ['EUR', 1200], ['GBP', 300]]))
  })
  it('refuses what a supplier email may not contain', () => {
    const codes = (t: string) => checkText(t, { allowedAmountsMinor: [680000], allowedTokens: ['SUPPLIER'], outbound: true })
    expect(codes('Please refund $6,800.00, [[SUPPLIER]].')).toEqual([])
    expect(codes('Please refund 6800 USD plus 10%')).toContain('unsupported_amount')
    expect(codes('Please refund €6,800')).toContain('unsupported_currency')
    expect(codes('Pay at https://pay.example or www.example.com')).toContain('link')
    expect(codes('Reach me at ap@example.com or 555-123-4567')).toContain('contact_detail')
    expect(codes('Send it to IBAN GB29 NWBK 6016 1331 9268 19')).toContain('bank_detail')
    expect(codes('Otherwise we will take legal action')).toContain('legal_threat')
    expect(codes('This looks fraudulent')).toContain('accusation')
    expect(codes('We will pay the fee')).toContain('unsupported_commitment')
    expect(codes('Paid on 2025-01-05')).toContain('unsupported_date')
    expect(codes('Dear [[VENDOR_CEO]]')).toContain('unknown_token')
  })
  it('scrubs free text before it can enter a packet', () => {
    const { text, removed } = scrubFreeText('Keep it warm. Call 555-123-4567, mail ap@x.com, acct 123456789 [[SUPPLIER]]​', 200)
    expect(text).not.toMatch(/555|ap@x|123456789|SUPPLIER|​/)
    expect(removed).toBeGreaterThanOrEqual(4)
  })
  it('pseudonymises consistently and restores locally', () => {
    const p = new Pseudonymizer()
    expect(p.ref('INVOICE', 'A-1')).toBe('[[INVOICE_1]]')
    expect(p.ref('INVOICE', 'A-1')).toBe('[[INVOICE_1]]')
    expect(p.ref('INVOICE', 'B-2')).toBe('[[INVOICE_2]]')
    expect(p.restore('[[INVOICE_2]] and [[NOPE]]')).toBe('B-2 and [[NOPE]]')
  })
})

describe('AI execution service', () => {
  it('sends nothing while AI is off (the default) and makes no ledger row', async () => {
    const provider = createMockProvider({ draft_recovery_request: goodDraft })
    const ai = setup(provider)
    const out = await run(ai)
    expect(out).toMatchObject({ source: 'deterministic', code: 'ai_off' })
    expect(provider.calls).toHaveLength(0)
    expect(ai.ledger.list(alice.id)).toHaveLength(0)
  })

  it('runs under a field-set consent, pseudonymises, validates and restores', async () => {
    const provider = createMockProvider({ draft_recovery_request: goodDraft })
    const ai = setup(provider)
    await enable(ai)
    const out = await run(ai)
    expect(out.source).toBe('ai')
    if (out.source !== 'ai') return
    expect(out.result.body).toContain('Hello Sierra Coffee Supply')
    expect(out.result.body).toContain('invoice INV-77 was paid twice')
    expect(out.result.body).toMatch(/Alice Ng\nBean Co$/)
    const sent = JSON.stringify(provider.calls[0].packet)
    expect(sent).not.toMatch(/Sierra|INV-77|Alice|Bean Co|2025-|example\.test/)
    const [row] = ai.ledger.list(alice.id)
    expect(row).toMatchObject({ task: 'draft_recovery_request', outcome: 'ok', provider: 'mock', policy_version: 1, attempts: 1 })
    expect(row.packet_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(row)).not.toMatch(/Sierra|INV-77|refund/)
  })

  it('a one-time packet consent covers exactly the previewed packet, once', async () => {
    const provider = createMockProvider({ draft_recovery_request: goodDraft })
    const ai = setup(provider)
    const t = tenantForUser(alice)
    ai.policies.set(t, 'on_demand')
    const preview = ai.preview(t, 'draft_recovery_request', 'p1', findingId, draftInput)
    expect(preview.packet).toMatchObject({ supplier: '[[SUPPLIER]]' })
    const consent = ai.consent(t, 'draft_recovery_request', { scope: 'packet', packetHash: preview.packetHash, projectId: 'p1', findingId })
    // A different packet (another amount) is not what was reviewed.
    await expect(run(ai, { ...draftInput, amountRequested: 5000 }, alice, { consentId: consent.id })).rejects.toMatchObject({ code: 'ai_consent_stale' })
    expect((await run(ai, draftInput, alice, { consentId: consent.id })).source).toBe('ai')
    await expect(run(ai, draftInput, alice, { consentId: consent.id })).rejects.toMatchObject({ code: 'ai_consent_stale' })
    // Expiry.
    const later = ai.consent(t, 'draft_recovery_request', { scope: 'packet', packetHash: preview.packetHash, projectId: 'p1', findingId })
    clock += 61 * 60_000
    await expect(run(ai, draftInput, alice, { consentId: later.id })).rejects.toMatchObject({ code: 'ai_consent_stale' })
  })

  it('revocation, a policy change or a different model all end a standing consent', async () => {
    const ai = setup(createMockProvider({ draft_recovery_request: goodDraft }))
    const consent = await enable(ai)
    ai.policies.revoke(tenantForUser(alice), consent.id)
    await expect(run(ai)).rejects.toMatchObject({ code: 'ai_consent_required' })
    await enable(ai)
    const other = setup(createMockProvider({ draft_recovery_request: goodDraft }, { model: 'mock-2' }))
    await expect(run(other)).rejects.toMatchObject({ code: 'ai_consent_required' })
  })

  it('another tenant cannot use a case or a consent that is not theirs', async () => {
    const ai = setup(createMockProvider({ draft_recovery_request: goodDraft }))
    const aliceConsent = await enable(ai)
    ai.policies.set(tenantForUser(bob), 'on_demand')
    ai.consent(tenantForUser(bob), 'draft_recovery_request', { scope: 'field_set' })
    await expect(run(ai, draftInput, bob)).rejects.toMatchObject({ code: 'recovery_not_authorized' })
    await expect(run(ai, draftInput, bob, { consentId: aliceConsent.id })).rejects.toMatchObject({ code: expect.stringMatching(/recovery_not_authorized|ai_consent_stale/) })
  })

  it('rejects output that breaks the rules and falls back', async () => {
    for (const bad of [
      { subject: 'Refund', body: 'Please refund $9,999.00 to [[SUPPLIER]].' },
      { subject: 'Refund', body: 'Please wire it to account number 12345678901.' },
      { subject: 'Refund', body: 'Pay via https://evil.example now or we sue.' },
      { subject: 'Refund', body: 'Dear [[CFO_NAME]], refund please.' },
      { subject: 'Line\nbreak', body: 'x' },
    ]) {
      const ai = setup(createMockProvider({ draft_recovery_request: bad }))
      await enable(ai)
      const out = await run(ai)
      expect(out).toMatchObject({ source: 'deterministic', code: 'ai_rejected' })
      expect(ai.ledger.list(alice.id)[0].outcome).toBe('rejected')
    }
    const ai = setup(createMockProvider({ draft_recovery_request: { wrong: 'shape' } }))
    await enable(ai)
    expect(await run(ai)).toMatchObject({ code: 'ai_rejected' })
  })

  it('retries a busy provider once, then falls back; a timeout falls back', async () => {
    let calls = 0
    const flaky: AiProvider = { name: 'mock', model: 'mock-1', tasks: null, async complete() { calls++; if (calls < 2) throw new AiTransientError('busy'); return { output: goodDraft } } }
    const ai = setup(flaky)
    await enable(ai)
    expect((await run(ai)).source).toBe('ai')
    expect(ai.ledger.list(alice.id)[0].attempts).toBe(2)

    const down: AiProvider = { name: 'mock', model: 'mock-1', tasks: null, async complete() { throw new AiTransientError('busy') } }
    const ai2 = setup(down)
    expect(await run(ai2)).toMatchObject({ code: 'ai_busy' })

    const slow: AiProvider = { name: 'mock', model: 'mock-1', tasks: null, complete: (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('aborted')))) }
    const ai3 = setup(slow, { timeoutMs: 20 })
    expect(await run(ai3)).toMatchObject({ code: 'ai_timeout' })
  })

  it('enforces the daily budget and records the refusal', async () => {
    const ai = setup(createMockProvider({ draft_recovery_request: goodDraft }), { perDay: 2 })
    await enable(ai)
    expect((await run(ai)).source).toBe('ai')
    expect((await run(ai)).source).toBe('ai')
    expect(await run(ai)).toMatchObject({ code: 'ai_budget' })
    expect(ai.ledger.list(alice.id)[0].outcome).toBe('budget')
    clock += 86_400_001
    expect((await run(ai)).source).toBe('ai')
  })

  it('never runs automatically, and a job context cannot invoke AI', async () => {
    const provider = createMockProvider({ draft_recovery_request: goodDraft })
    const ai = setup(provider)
    await enable(ai)
    expect(await ai.run(tenantForUser(alice), 'draft_recovery_request', { projectId: 'p1', findingId, input: draftInput, trigger: 'automatic' })).toMatchObject({ code: 'ai_automatic_disabled' })
    await expect(ai.run(systemContext(alice.id, 'test'), 'draft_recovery_request', { projectId: 'p1', findingId, input: draftInput })).rejects.toMatchObject({ code: 'forbidden' })
    expect(provider.calls).toHaveLength(0)
  })

  it('a task restricted to packet consent refuses a standing consent', async () => {
    const task: AiTask<{ x: string }, { x: string }, { y: string }, string> = {
      id: 'packet_only', version: '1', purpose: 'test', fields: ['x'], permission: 'ai.invoke', consentScopes: ['packet'],
      inputSchema: z.object({ x: z.string() }), outputSchema: z.object({ y: z.string() }), system: 's', maxPacketChars: 100, maxOutputTokens: 10,
      build: (_s, input) => ({ ok: true, built: { packet: input, names: new Pseudonymizer(), sourceIds: [], amountsMinor: [] } }),
      validate: () => [], finalize: (o) => o.y, fallback: () => null,
    }
    const ai = setup(createMockProvider({ packet_only: { y: 'ok' } })).register(task)
    const t = tenantForUser(alice)
    ai.policies.set(t, 'on_demand')
    expect(() => ai.consent(t, 'packet_only', { scope: 'field_set' })).toThrow(/one-time consent/)
    const preview = ai.preview(t, 'packet_only', 'p1', null, { x: 'a' })
    const c = ai.consent(t, 'packet_only', { scope: 'packet', packetHash: preview.packetHash, projectId: 'p1', findingId: null })
    expect(await ai.run(t, 'packet_only', { projectId: 'p1', findingId: null, input: { x: 'a' }, consentId: c.id })).toMatchObject({ source: 'ai', result: 'ok' })
  })

  it('an invocation interrupted by a restart is recorded as failed, not left running', async () => {
    const ai = setup(createMockProvider({ draft_recovery_request: goodDraft }))
    ai.ledger.start(alice.id, { task: 't', task_version: '1', provider: 'mock', model: 'm', actor: 'a', policy_version: 1, consent_id: null, project_id: null, finding_id: null, packet_hash: 'x', started_at: clock })
    setup(null)
    expect(ai.ledger.list(alice.id)[0]).toMatchObject({ outcome: 'failed', validationCodes: ['interrupted'] })
  })
})
