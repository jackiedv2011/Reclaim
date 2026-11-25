// @vitest-environment node
/**
 * Synthetic end-to-end walk (P7), front to back through the real server:
 * saved audits -> coverage and covered spend -> evidence via case commands ->
 * an approval item in the attention queue -> the CPO layer's typed proposal
 * submitted to the EXISTING case-command route -> manual send -> fictional
 * supplier reply -> customer-recorded return -> recovery visibility, plus
 * duplicate upload, stale revision and cross-tenant attempts.
 *
 * SYNTHETIC: fictional vendors and amounts; no provider, network or AI.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { DevMailer } from './mailer.ts'
import { EVIDENCE_CHECKS } from '../src/recovery/eligibility.ts'
import { proposeApprovalAction, type AttentionItem } from '../src/intelligence/attention.ts'
import { SINGLE_USER_PERMISSIONS, type TenantContext } from '../src/intelligence/contracts.ts'

// Runtime-only import: the fixtures use the browser pipeline's `@/` aliases.
const FIXTURES: string = '../src/intelligence/fixtures/synthetic.ts'
type Audit = { id: string; name?: string | null; environment: { records: Array<{ id: string; amountPaid: number; invoiceNumber: string | null }>; result: { findings: Array<{ id: string; type: string; relatedRecords: Array<{ id: string }> }> } } }
const fixtures = async () => (await import(FIXTURES)) as { tenantAAudits: () => Audit[]; auditFromCsv: (id: string, rows: string[]) => Audit; TENANT_A_Q1: string[] }

const NOW = Date.UTC(2026, 6, 1, 12)
let app: App
let base: string

class Client {
  cookies = new Map<string, string>()
  async call(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers)
    if (init.json !== undefined) headers.set('Content-Type', 'application/json')
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await fetch(base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(';')
      const [name, value] = pair.split('=')
      this.cookies.set(name, value)
    }
    const text = await res.text()
    return { status: res.status, body: text ? JSON.parse(text) : null }
  }
  get = (p: string) => this.call(p)
  post = (p: string, json: unknown) => this.call(p, { method: 'POST', json })
  put = (p: string, json: unknown) => this.call(p, { method: 'PUT', json })
}

async function signedIn(first: string): Promise<{ client: Client; userId: string }> {
  const email = `${first.toLowerCase()}@example.test`
  const client = new Client()
  await client.post('/api/auth/signup', { firstName: first, lastName: 'Fixture', email, company: `${first} Co`, password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery', acceptedTerms: true, termsVersion: '2026-01' })
  const mail = (await new Client().get(`/api/dev/mailbox?to=${encodeURIComponent(email)}`)).body.messages[0]
  const verified = await client.post('/api/auth/verify-email', { token: new URL(mail.link).searchParams.get('token') })
  return { client, userId: verified.body.user.id }
}

const project = (audit: Audit) => ({ ...audit, sourceLabel: `${audit.id}.csv`, mode: 'upload', createdAt: NOW, updatedAt: NOW })
const usd = (rows: Array<{ currency: string }>) => rows.find((r) => r.currency === 'USD') as unknown as Record<string, number>

describe('synthetic end-to-end: audit to recovery visibility through the real server', () => {
  let alice: { client: Client; userId: string }
  let bob: { client: Client; userId: string }
  let q1: Audit
  let findingId: string
  let revision: number
  const command = async (type: string, input: unknown, commandId = crypto.randomUUID()) => {
    const res = await alice.client.post(`/api/projects/${q1.id}/case-commands`, { commandId, expectedRevision: revision, findingId, type, input })
    if (res.status === 200) revision = res.body.revision
    return res
  }
  const attention = async () => (await alice.client.get('/api/intelligence/attention')).body
  const recovery = async () => (await alice.client.get('/api/intelligence/recovery')).body

  beforeAll(async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0', SESSION_DAYS: '1', REMEMBER_ME_DAYS: '30', RECLAIM_INTELLIGENCE_API: '1' })
    const db = openDatabase(':memory:')
    app = createApp({ config, db, mailer: new DevMailer(db), google: null, drafts: null, now: () => NOW })
    base = `http://127.0.0.1:${await app.listen(0)}`
    alice = await signedIn('Alice')
    bob = await signedIn('Bob')
    ;[q1] = (await fixtures()).tenantAAudits()
  })
  afterAll(async () => {
    await app.close()
    app.db.close()
  })

  it('1. saves an audit through the normal project route and reports coverage and covered spend', async () => {
    const saved = await alice.client.put(`/api/projects/${q1.id}`, project(q1))
    expect(saved.status).toBe(200)
    revision = saved.body.revision
    const coverage = (await alice.client.get('/api/intelligence/coverage')).body
    expect(coverage.result.importCount).toBe(1)
    expect(coverage.origin).toBe('legacy_audit_snapshot')
    const spend = (await alice.client.get('/api/intelligence/spend/summary')).body
    expect(spend.result.gross).toEqual([{ currency: 'EUR', amountMinor: 90000 }, { currency: 'USD', amountMinor: 1797100 }])
  })

  it('2. a detected duplicate starts as an unreviewed item, flagged but with no money owed', async () => {
    const dup = q1.environment.result.findings.find((f) => f.type === 'exact_duplicate')!
    findingId = dup.id
    const items: AttentionItem[] = (await attention()).result.items
    expect(items.find((i) => i.findingId === findingId)?.kind).toBe('unreviewed_finding')
    const row = usd((await recovery()).result.byCurrency)
    expect(row.supportedPotentialMinor).toBe(0)
    expect(row.flaggedForReviewMinor).toBeGreaterThan(0)
  })

  it('3. attested evidence through case commands produces an approval item with the supported amount', async () => {
    const dup = q1.environment.result.findings.find((f) => f.id === findingId)!
    const rows = dup.relatedRecords.map((r) => q1.environment.records.find((x) => x.id === r.id)!)
    const ref = { reference: 'FIXTURE accounting trace' }
    const evidence = {
      entity: { ...ref, entityId: 'Fixture Co' }, supplier: { ...ref, supplierId: 'FIXTURE-SUPPLIER-1' },
      payments: rows.map((r, i) => ({ ...ref, recordId: r.id, paymentId: `FIXTURE-PAY-${i}`, obligationId: 'INV-1003', amountMinor: Math.round(r.amountPaid * 100), currency: 'USD', settled: true })),
      obligation: { ...ref, obligationId: 'INV-1003', amountMinor: 141025, currency: 'USD' },
      checks: Object.fromEntries(EVIDENCE_CHECKS.map(([key]) => [key, { ...ref, confirmed: true }])),
      contradictions: [], notes: 'Synthetic fixture',
    }
    expect((await command('evidence', evidence)).status).toBe(200)
    expect((await command('decision', { decision: 'confirmed', reason: 'Fixture review' })).status).toBe(200)
    const item: AttentionItem = (await attention()).result.items.find((i: AttentionItem) => i.findingId === findingId)
    expect(item.kind).toBe('outbound_approval')
    expect(item.category).toBe('requires_approval')
    expect(item.amount).toMatchObject({ kind: 'supported_potential', money: { currency: 'USD', amountMinor: 141025 } })
    expect(usd((await recovery()).result.byCurrency).supportedPotentialMinor).toBe(141025)
  })

  const pkg = { subject: 'Duplicate payment INV-1003', body: 'Fixture request body.', evidenceAttachment: null, recipientEmail: 'ap@fixture-supplier.example.test', recipientConfirmed: true, requestedAmount: 1410.25, method: 'refund' }

  it('4. the attention layer proposes; the existing case-command route decides (stale proposal refused, fresh one accepted)', async () => {
    const ctx: TenantContext = { tenantId: alice.userId, actorId: alice.userId, permissions: SINGLE_USER_PERMISSIONS, source: 'single_user_session' }
    const item: AttentionItem = (await attention()).result.items.find((i: AttentionItem) => i.findingId === findingId)
    const proposed = proposeApprovalAction(ctx, item, 'approve', { expectedRevision: item.revision, input: { package: pkg, knownBeforeReclaim: false, knownBeforeNote: null } })
    expect(proposed.ok).toBe(true)
    if (!proposed.ok) return
    const p = proposed.proposal
    expect(p).toMatchObject({ path: `/api/projects/${q1.id}/case-commands`, action: 'approve', requiresHumanConfirmation: true, sideEffects: 'none_in_this_layer', readyToSubmit: true })
    // Nothing happened yet: the case is still awaiting approval.
    expect((await attention()).result.items.find((i: AttentionItem) => i.findingId === findingId).kind).toBe('outbound_approval')
    // A proposal built on an old revision is refused by the server.
    const stale = await alice.client.post(p.path, { commandId: crypto.randomUUID(), expectedRevision: p.expectedRevision - 1, findingId, type: p.action, input: p.input })
    expect(stale.status).toBe(409)
    // The person confirms: the proposal is submitted as-is.
    const accepted = await alice.client.post(p.path, { commandId: p.commandId, expectedRevision: p.expectedRevision, findingId, type: p.action, input: p.input })
    expect(accepted.status).toBe(200)
    revision = accepted.body.revision
    // Retrying the same proposal replays instead of approving twice.
    const replay = await alice.client.post(p.path, { commandId: p.commandId, expectedRevision: p.expectedRevision, findingId, type: p.action, input: p.input })
    expect(replay.body.replayed).toBe(true)
    // Approved is not sent.
    expect((await attention()).result.items.find((i: AttentionItem) => i.findingId === findingId).kind).toBe('ready_to_send')
  })

  it('5. after a manual send, a supplier promise and a partial customer-recorded return, every figure stays separate', async () => {
    expect((await command('request', pkg)).status).toBe(200)
    let row = usd((await recovery()).result.byCurrency)
    expect(row.approvedOutstandingMinor).toBe(141025)
    expect((await command('vendor_update', { status: 'promised', note: 'Fixture supplier promised a refund', at: NOW - 86_400_000, amount: 1410.25 })).status).toBe(200)
    row = usd((await recovery()).result.byCurrency)
    expect(row.promisedMinor).toBe(141025)
    expect((await command('settlement', { amount: 500, method: 'refund', source: 'bank', reference: 'FIXTURE-REF-001', settledAt: NOW - 3_600_000 })).status).toBe(200)
    const overview = (await recovery()).result
    row = usd(overview.byCurrency)
    expect(row.customerRecordedReturnsMinor).toBe(50000)
    expect(row.approvedOutstandingMinor).toBe(91025)
    expect(row.promisedMinor).toBe(91025) // the promise, less what came back since
    expect(row.matchedReturnsMinor).toBeNull() // never presented as matched
    expect(overview.counts.partialReturns).toBe(1)
    const item: AttentionItem = (await attention()).result.items.find((i: AttentionItem) => i.findingId === findingId)
    expect(item.kind).toBe('disputed_or_partial')
    expect(item.amount).toMatchObject({ kind: 'outstanding', money: { amountMinor: 91025 } })
  })

  it('6. uploading an overlapping second audit counts shared payments and the shared case once', async () => {
    const [, q2] = (await fixtures()).tenantAAudits()
    expect((await alice.client.put(`/api/projects/${q2.id}`, project(q2))).status).toBe(200)
    const coverage = (await alice.client.get('/api/intelligence/coverage')).body.result
    expect(coverage.crossAuditOverlapRows).toBe(3)
    const overview = (await recovery()).result
    expect(overview.dedup.duplicatesFolded).toBe(1)
    expect(usd(overview.byCurrency).customerRecordedReturnsMinor).toBe(50000) // not doubled
  })

  it('7. another tenant sees none of it and cannot act on it', async () => {
    const theirs = await bob.client.get('/api/intelligence/recovery')
    expect(theirs.status).toBe(200)
    expect(theirs.body.result.counts.byStage.requested ?? 0).toBe(0)
    expect(JSON.stringify(await bob.client.get('/api/intelligence/attention'))).not.toContain(findingId)
    const attempt = await bob.client.post(`/api/projects/${q1.id}/case-commands`, { commandId: crypto.randomUUID(), expectedRevision: revision, findingId, type: 'close', input: { reason: 'Not mine' } })
    expect(attempt.status).toBe(404)
  })
})
