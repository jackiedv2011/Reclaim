// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { DevMailer } from './mailer.ts'
import { ProjectStore } from './projectStore.ts'
import { authorizedProject } from './testProject.ts'
import { ApprovalService } from './approvals.ts'
import { createSealer } from './sealedJson.ts'
import { PERMISSIONS, tenantForUser, type TenantContext } from './tenant.ts'

const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0', REQUIRE_EMAIL_VERIFICATION: 'false' })
let app: App
let base: string
let clock: number

class Client {
  cookies = new Map<string, string>()
  async call(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers)
    if (init.json !== undefined) headers.set('Content-Type', 'application/json')
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await fetch(base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined })
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const [name, value] = pair.split('=')
      this.cookies.set(name, value)
    }
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  get = (p: string) => this.call(p)
  post = (p: string, json: unknown = {}) => this.call(p, { method: 'POST', json })
}

async function signUp(email: string) {
  const c = new Client()
  const res = await c.post('/api/auth/signup', { firstName: 'Test', lastName: 'User', email, company: 'Co', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery', acceptedTerms: true, termsVersion: '2026-01' })
  expect(res.status).toBe(201)
  return { c, user: res.body.user as { id: string; email: string } }
}

/** A sent request ($6,800 asked) on the account, ready for vendor replies and follow-ups. */
function seedRequested(userId: string, id = 'p1', mode = 'upload') {
  const saved = authorizedProject(id, { vendor: 'Acme Supply', invoice: 'INV-9', amount: 6800, requested: 6800 })
  const state = saved.project.environment.caseStates[saved.findingId] as Record<string, unknown>
  Object.assign(state, { recoveryStage: 'requested', recoveryRequestedAt: clock - 10 * 86_400_000, recoveryRecipientEmail: 'ap@acme.test', recoverySubject: 'Duplicate payment', recoveryDraft: 'Please refund.' })
  new ProjectStore(app.db, null).upsert(userId, { ...saved.project, mode })
  return saved.findingId
}
const vendorUpdate = (findingId: string, projectId = 'p1') => ({ projectId, findingId, reason: 'Supplier acknowledged by phone', sourceRefs: ['call-note'], payload: { kind: 'case_command', command: 'vendor_update', input: { status: 'acknowledged', note: 'Acknowledged on the phone', at: clock - 1000 } } })
const caseState = async (c: Client, findingId: string, projectId = 'p1') => {
  const projects = (await c.get('/api/projects')).body.projects as Array<{ id: string; environment: { caseStates: Record<string, Record<string, unknown>> } }>
  return projects.find((p) => p.id === projectId)!.environment.caseStates[findingId]
}
const service = () => new ApprovalService({ db: app.db, sealer: createSealer(null), getProject: (t, p) => new ProjectStore(app.db, null).get(t, p), revision: (t, p) => new ProjectStore(app.db, null).revision(t, p), now: () => clock })

beforeEach(async () => {
  clock = Date.now()
  const db = openDatabase(':memory:')
  app = createApp({ config, db, mailer: new DevMailer(db), google: null, drafts: null, aiProvider: null, gmail: null, now: () => clock })
  base = `http://127.0.0.1:${await app.listen(0)}`
})
afterEach(async () => {
  await app.close()
  app.db.close()
})

describe('approval queue', () => {
  it('executes exactly the approved payload once, through the case commands', async () => {
    const { c, user } = await signUp('alice@example.test')
    const findingId = seedRequested(user.id)
    const created = await c.post('/api/approvals', { ...vendorUpdate(findingId), origin: 'job' })
    expect(created.status).toBe(400) // the client cannot claim an origin
    const ok = await c.post('/api/approvals', vendorUpdate(findingId))
    expect(ok.status).toBe(201)
    const p = ok.body.proposal
    expect(p).toMatchObject({ status: 'pending', origin: 'user', actionType: 'case_command:vendor_update', stale: false, requiredPermission: 'case.approve' })
    expect((await c.get('/api/approvals?status=pending')).body.proposals).toHaveLength(1)

    expect((await c.post(`/api/approvals/${p.id}/approve`, { payloadHash: 'a'.repeat(64) })).body.code).toBe('not_approved_version')
    const done = await c.post(`/api/approvals/${p.id}/approve`, { payloadHash: p.payloadHash })
    expect(done.status).toBe(200)
    expect(done.body.proposal.status).toBe('executed')
    expect((await caseState(c, findingId)).vendorUpdates).toEqual([expect.objectContaining({ status: 'acknowledged' })])
    expect((await c.post(`/api/approvals/${p.id}/approve`, { payloadHash: p.payloadHash })).body.code).toBe('proposal_not_pending')
    const events = (await c.get(`/api/approvals/${p.id}/events`)).body.events.map((e: { event: string }) => e.event)
    expect(events).toEqual(['proposed', 'approved', 'executed'])
    expect(app.db.prepare("SELECT COUNT(*) AS n FROM case_events WHERE action = 'vendor_update'").get()).toEqual({ n: 1 })
  })

  it('a proposal goes stale when the case changes, and expires', async () => {
    const { c, user } = await signUp('alice@example.test')
    const findingId = seedRequested(user.id)
    const p = (await c.post('/api/approvals', vendorUpdate(findingId))).body.proposal
    const q = (await c.post('/api/approvals', { ...vendorUpdate(findingId), reason: 'second' })).body.proposal
    // The case moves on (another proposal executes): the first one no longer matches it.
    expect((await c.post(`/api/approvals/${q.id}/approve`, { payloadHash: q.payloadHash })).status).toBe(200)
    expect((await c.get(`/api/approvals/${p.id}`)).body.proposal.stale).toBe(true)
    expect((await c.post(`/api/approvals/${p.id}/approve`, { payloadHash: p.payloadHash })).body.code).toBe('proposal_stale')

    const r = (await c.post('/api/approvals', { ...vendorUpdate(findingId), reason: 'third' })).body.proposal
    clock += 8 * 86_400_000
    expect((await c.get('/api/approvals?status=pending')).body.proposals).toHaveLength(0)
    expect((await c.post(`/api/approvals/${r.id}/approve`, { payloadHash: r.payloadHash })).body.code).toBe('proposal_not_pending')
  })

  it('edit supersedes and needs its own approval; reject ends it', async () => {
    const { c, user } = await signUp('alice@example.test')
    const findingId = seedRequested(user.id)
    const p = (await c.post('/api/approvals', vendorUpdate(findingId))).body.proposal
    const edited = await c.post(`/api/approvals/${p.id}/edit`, { payload: { ...p.payload, input: { ...p.payload.input, note: 'Edited note' } } })
    expect(edited.status).toBe(201)
    expect(edited.body.proposal).toMatchObject({ status: 'pending', supersedes: p.id })
    expect(edited.body.proposal.payloadHash).not.toBe(p.payloadHash)
    expect((await c.get(`/api/approvals/${p.id}`)).body.proposal.status).toBe('superseded')
    expect((await c.post(`/api/approvals/${edited.body.proposal.id}/reject`, { note: 'no' })).body.proposal.status).toBe('rejected')
    expect((await caseState(c, findingId)).vendorUpdates ?? []).toHaveLength(0)
  })

  it('is tenant-scoped', async () => {
    const { c, user } = await signUp('alice@example.test')
    const bob = await signUp('bob@example.test')
    const findingId = seedRequested(user.id)
    const p = (await c.post('/api/approvals', vendorUpdate(findingId))).body.proposal
    expect((await bob.c.get(`/api/approvals/${p.id}`)).status).toBe(404)
    expect((await bob.c.post(`/api/approvals/${p.id}/approve`, { payloadHash: p.payloadHash })).status).toBe(404)
    expect((await bob.c.get('/api/approvals')).body.proposals).toEqual([])
    expect((await bob.c.post('/api/approvals', vendorUpdate(findingId))).status).toBe(404)
    expect((await new Client().get('/api/approvals')).status).toBe(401)
  })

  it('supplier text and models can suggest a status, never money, closure or a send to someone new', async () => {
    const { user } = await signUp('alice@example.test')
    const findingId = seedRequested(user.id)
    const t = tenantForUser(user)
    const s = service()
    const base = { projectId: 'p1', findingId, reason: 'r', sourceRefs: ['inbound:1'] }
    const settlement = { kind: 'case_command', command: 'settlement', input: { amount: 6800, method: 'refund', source: 'bank', reference: 'DEP-1', settledAt: clock - 1 } } as const
    const close = { kind: 'case_command', command: 'close', input: { reason: 'Vendor said paid' } } as const
    expect(() => s.propose(t, { ...base, origin: 'inbound', payload: settlement })).toThrow(/cannot settlement/)
    expect(() => s.propose(t, { ...base, origin: 'ai', payload: close })).toThrow(/cannot close/)
    expect(() => s.propose(t, { ...base, origin: 'job', payload: settlement })).toThrow()
    expect(() => s.propose(t, { ...base, origin: 'inbound', payload: { kind: 'send_request', to: 'x@evil.test', cc: [], subject: 's', body: 'b', generation: 1, amountRequested: 1, evidenceAttachment: null } })).toThrow()
    expect(s.propose(t, { ...base, origin: 'return_match', payload: settlement }).status).toBe('pending')
    expect(s.propose(t, { ...base, origin: 'inbound', payload: { kind: 'case_command', command: 'vendor_update', input: { status: 'disputed', note: 'They dispute it', at: clock - 1 } } }).status).toBe('pending')
    // Malformed command input never reaches the queue.
    expect(() => s.propose(t, { ...base, origin: 'user', payload: { kind: 'case_command', command: 'settlement', input: { amount: -5 } } })).toThrow(/malformed/)
    // Re-proposing with the same key (a job run twice) returns the first one.
    const a = s.propose(t, { ...base, origin: 'inbound', dedupeKey: 'k1', payload: { kind: 'case_command', command: 'followup', input: { at: clock + 86_400_000 } } })
    const b = s.propose(t, { ...base, origin: 'inbound', dedupeKey: 'k1', payload: { kind: 'case_command', command: 'followup', input: { at: clock + 86_400_000 } } })
    expect(b.id).toBe(a.id)
  })

  it('a settlement from the return matcher still needs a person, then records through the case model', async () => {
    const { c, user } = await signUp('alice@example.test')
    const findingId = seedRequested(user.id)
    const p = service().propose(tenantForUser(user), { projectId: 'p1', findingId, origin: 'return_match', reason: 'Deposit DEP-1 matched (FIXTURE)', sourceRefs: ['match:fixture-1'], payload: { kind: 'case_command', command: 'settlement', input: { amount: 2000, method: 'refund', source: 'accounting', reference: 'DEP-1', settledAt: clock - 1 } } })
    expect((await caseState(c, findingId)).recoverySettlements ?? []).toHaveLength(0)
    expect((await c.post(`/api/approvals/${p.id}/approve`, { payloadHash: p.payloadHash })).status).toBe(200)
    const state = await caseState(c, findingId)
    expect(state.recoveryStage).toBe('requested') // partial: $2,000 of $6,800
    expect(state.recoverySettlements).toEqual([expect.objectContaining({ amount: 2000, reference: 'DEP-1' })])
  })

  it('separation of duties: once tenants have roles, the preparer cannot approve', async () => {
    const { user } = await signUp('alice@example.test')
    const findingId = seedRequested(user.id)
    const withRoles = (label: string): TenantContext => ({ tenantId: user.id, actorId: label, actorLabel: label, permissions: new Set(PERMISSIONS), source: 'single_user_fixture' as never })
    const s = new ApprovalService({ db: app.db, sealer: createSealer(null), getProject: (t, p) => new ProjectStore(app.db, null).get(t, p), revision: () => 1, now: () => clock, distinctApprover: () => true })
    const p = s.propose(withRoles('preparer@x'), { projectId: 'p1', findingId, origin: 'user', reason: 'r', sourceRefs: [], payload: { kind: 'case_command', command: 'followup', input: { at: clock + 1 } } })
    expect(() => s.claimForExecution(withRoles('preparer@x'), p.id, p.payloadHash)).toThrow(/Someone other/)
    expect(s.claimForExecution(withRoles('approver@x'), p.id, p.payloadHash).status).toBe('executing')
  })

  it('an approved send that cannot go out fails without touching the case; sample audits never send', async () => {
    const { c, user } = await signUp('alice@example.test')
    const findingId = seedRequested(user.id)
    const followUp = { kind: 'send_follow_up', to: 'ap@acme.test', cc: [], subject: 'Re: Duplicate payment', body: 'Following up.', generation: 1, sequence: 1 }
    const p = (await c.post('/api/approvals', { projectId: 'p1', findingId, reason: 'due', sourceRefs: [], payload: followUp })).body.proposal
    const res = await c.post(`/api/approvals/${p.id}/approve`, { payloadHash: p.payloadHash })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ proposal: { status: 'failed' }, result: { ok: false } })
    expect((await caseState(c, findingId)).recoveryFollowUps ?? []).toHaveLength(0)
    seedRequested(user.id, 'sample1', 'sample')
    expect((await c.post('/api/approvals', { projectId: 'sample1', findingId: 'exact_duplicate-sample1', reason: 'due', sourceRefs: [], payload: followUp })).body.code).toBe('sample_outreach_disabled')
  })
})
