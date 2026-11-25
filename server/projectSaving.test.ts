// @vitest-environment node
/** Saving and loading audits over HTTP: size limits, compression, deleted and unreadable audits. */
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { DevMailer } from './mailer.ts'

const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0' })
let app: App
let base: string
let cookie = ''

async function call(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers)
  if (init.json !== undefined) headers.set('Content-Type', 'application/json')
  if (cookie) headers.set('Cookie', cookie)
  const res = await fetch(base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
  const set = res.headers.getSetCookie().find((c) => c.startsWith('reclaim_session='))
  if (set) cookie = set.split(';')[0]
  const text = await res.text()
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null }
}
const gz = (id: string, project: unknown, headers: Record<string, string> = {}) =>
  call(`/api/projects/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ...headers }, body: new Uint8Array(gzipSync(JSON.stringify(project))) })

const record = (i: number) => ({ id: `rec_${i}`, vendor: `Vendor ${i}`, invoiceNumber: `INV-${i}`, paymentDate: '2026-01-05T00:00:00.000Z', amountPaid: 100 + i })
const project = (id: string, rows = 3, extra: Record<string, unknown> = {}) => ({
  id, name: id, sourceLabel: `${id}.csv`, mode: 'upload', createdAt: 1, updatedAt: 2,
  environment: { records: Array.from({ length: rows }, (_, i) => record(i)), imports: [{ id: `batch_${id}` }], result: { findings: [] }, caseStates: {}, ...extra },
})

beforeEach(async () => {
  const db = openDatabase(':memory:')
  app = createApp({ config, db, mailer: new DevMailer(db), google: null, drafts: null })
  base = `http://127.0.0.1:${await app.listen(0)}`
  cookie = ''
  await call('/api/auth/signup', { method: 'POST', json: { firstName: 'A', lastName: 'N', email: 'a@example.com', company: 'Co', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery', acceptedTerms: true } })
  const mail = await call('/api/dev/mailbox?to=a@example.com')
  const token = new URL(mail.body.messages[0].link).searchParams.get('token')
  await call('/api/auth/verify-email', { method: 'POST', json: { token } })
})
afterEach(async () => {
  await app.close()
  app.db.close()
})

describe('large audits', () => {
  it('an oversized body is answered with 413 and a plain message, not a dropped connection', async () => {
    const res = await call('/api/projects/p1', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: `{"pad":"${'x'.repeat(26 * 1024 * 1024)}"}` })
    expect(res.status).toBe(413)
    expect(res.body.code).toBe('too_large')
    expect(res.body.message).toMatch(/too large to save/i)
    // The same connection pool still works.
    expect((await call('/api/projects')).status).toBe(200)
  })

  it('a compressed save larger than 25 MB uncompressed is accepted and comes back whole', async () => {
    const big = project('big', 4, { pad: 'payment '.repeat(4_000_000) })
    expect(JSON.stringify(big).length).toBeGreaterThan(30 * 1024 * 1024)
    const res = await gz('big', big, { Prefer: 'return=minimal' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, revision: 1 })
    const back = await call('/api/projects/big')
    expect(back.body.revision).toBe(1)
    expect(back.body.project).toEqual(big)
    // Kept compressed at rest.
    const stored = app.db.prepare('SELECT length(payload) AS n FROM projects').get() as { n: number }
    expect(stored.n).toBeLessThan(5 * 1024 * 1024)
  }, 30_000)

  it('a body that decompresses past the limit is refused without being read into memory', async () => {
    const bomb = gzipSync(Buffer.alloc(200 * 1024 * 1024, 32))
    const res = await call('/api/projects/bomb', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: new Uint8Array(bomb) })
    expect(res.status).toBe(413)
    expect(res.body.code).toBe('too_large')
  }, 30_000)

  it('a broken compressed body is 400, and endpoints that take no compressed body say so', async () => {
    const broken = await call('/api/projects/p1', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: 'not gzip' })
    expect(broken.status).toBe(400)
    const login = await call('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }, body: new Uint8Array(gzipSync('{}')) })
    expect(login.status).toBe(415)
  })

  it('large responses are compressed for a client that accepts it', async () => {
    await gz('big', project('big', 2000))
    const res = await call('/api/projects/big', { headers: { 'Accept-Encoding': 'gzip' } })
    expect(res.headers.get('content-encoding')).toBe('gzip')
    expect(res.body.project.environment.records).toHaveLength(2000)
  })
})

describe('listing', () => {
  it('lists revisions without sending every audit', async () => {
    await call('/api/projects/p1', { method: 'PUT', json: project('p1') })
    await call('/api/projects/p1', { method: 'PUT', headers: { 'If-Match': '1' }, json: { ...project('p1'), name: 'renamed' } })
    const res = await call('/api/projects?index=1')
    expect(res.body).toEqual({ revisions: { p1: 2 } })
  })

  it('one unreadable audit does not hide the others', async () => {
    await call('/api/projects/good', { method: 'PUT', json: project('good') })
    await call('/api/projects/bad', { method: 'PUT', json: project('bad', 3, { records: [] }) })
    app.db.prepare("UPDATE projects SET payload = '{broken' WHERE id = 'bad'").run()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('/api/projects')
    expect(res.status).toBe(200)
    expect(res.body.projects.map((p: { id: string }) => p.id)).toEqual(['good'])
    expect(res.body.unreadable).toEqual(['bad'])
    const one = await call('/api/projects/bad')
    expect(one.status).toBe(500)
    expect(one.body.code).toBe('project_unreadable')
    error.mockRestore()
  })

  it('a single audit is private to its account', async () => {
    await call('/api/projects/p1', { method: 'PUT', json: project('p1') })
    cookie = ''
    expect((await call('/api/projects/p1')).status).toBe(401)
    expect((await call('/api/projects?index=1')).status).toBe(401)
  })
})

describe('an audit deleted on another device', () => {
  it('is not brought back by a stale save that still carries its revision', async () => {
    await call('/api/projects/p1', { method: 'PUT', json: project('p1') })
    await call('/api/projects/p1', { method: 'DELETE' })
    const stale = await call('/api/projects/p1', { method: 'PUT', headers: { 'If-Match': '1' }, json: project('p1') })
    expect(stale.status).toBe(404)
    expect(stale.body.code).toBe('project_deleted')
    expect((await call('/api/projects')).body.projects).toEqual([])
    // Deleting it again is not an error.
    expect((await call('/api/projects/p1', { method: 'DELETE' })).status).toBe(200)
  })
})

describe('case commands', () => {
  it('can answer with just the case that changed', async () => {
    const findings = [{ id: 'f1', type: 'exact_duplicate', class: 'review', dollarImpact: 10, relatedRecords: [{ id: 'rec_0' }, { id: 'rec_1' }] }]
    await call('/api/projects/p1', { method: 'PUT', json: project('p1', 3, { result: { findings } }) })
    const res = await call('/api/projects/p1/case-commands', {
      method: 'POST', headers: { Prefer: 'return=minimal' },
      json: { commandId: crypto.randomUUID(), expectedRevision: 1, findingId: 'f1', type: 'decision', input: { decision: 'confirmed', reason: null } },
    })
    expect(res.status).toBe(200)
    expect(res.body.project).toBeUndefined()
    expect(res.body).toMatchObject({ revision: 2, case: { findingId: 'f1', state: { decision: 'confirmed' }, finding: { id: 'f1', customerDecision: 'confirmed' } } })
  })
})

describe('saving is all or nothing', () => {
  it('a save that fails part way leaves no audit counted against the plan', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    app.db.exec("CREATE TRIGGER refuse BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'disk'); END")
    expect((await call('/api/projects/p1', { method: 'PUT', json: project('p1') })).status).toBe(500)
    app.db.exec('DROP TRIGGER refuse')
    expect((app.db.prepare('SELECT COUNT(*) AS n FROM audit_starts').get() as { n: number }).n).toBe(0)
    expect((await call('/api/projects/p2', { method: 'PUT', json: project('p2') })).status).toBe(200)
    error.mockRestore()
  })
})
