// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { DevMailer } from './mailer.ts'
import { ProjectStore } from './projectStore.ts'
import { authorizedProject } from './testProject.ts'
import { tenantAAudits, tenantBAudits } from '../src/intelligence/fixtures/synthetic.ts'

const baseEnv = { NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0', SESSION_DAYS: '1', REMEMBER_ME_DAYS: '30' }
const NOW = Date.UTC(2026, 6, 1)

let app: App
let base: string

class Client {
  cookies = new Map<string, string>()
  async call(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers)
    if (init.json !== undefined) headers.set('Content-Type', 'application/json')
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await fetch(base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, redirect: 'manual' })
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

const person = (first: string, email: string) => ({ firstName: first, lastName: 'Fixture', email, company: `${first} Co`, password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery', acceptedTerms: true, termsVersion: '2026-01' })

async function signedIn(input: ReturnType<typeof person>): Promise<{ client: Client; userId: string }> {
  const client = new Client()
  expect((await client.post('/api/auth/signup', input)).status).toBe(201)
  const mail = (await new Client().get(`/api/dev/mailbox?to=${encodeURIComponent(input.email)}`)).body.messages[0]
  const verified = await client.post('/api/auth/verify-email', { token: new URL(mail.link).searchParams.get('token') })
  expect(verified.status).toBe(200)
  return { client, userId: verified.body.user.id }
}

async function start(enabled: boolean) {
  const config = loadConfig({ ...baseEnv, ...(enabled ? { RECLAIM_INTELLIGENCE_API: '1' } : {}) })
  const db = openDatabase(':memory:')
  app = createApp({ config, db, mailer: new DevMailer(db), google: null, drafts: null, now: () => NOW })
  base = `http://127.0.0.1:${await app.listen(0)}`
  return new ProjectStore(db, config.dataKeys)
}

afterEach(async () => {
  await app.close()
  app.db.close()
})

describe('intelligence API flag', () => {
  it('is not routed when RECLAIM_INTELLIGENCE_API is unset', async () => {
    await start(false)
    const { client } = await signedIn(person('Ada', 'ada@example.test'))
    expect((await client.get('/api/intelligence/attention')).status).toBe(404)
  })
})

describe('intelligence API', () => {
  let store: ProjectStore
  beforeEach(async () => {
    store = await start(true)
  })

  it('requires a session', async () => {
    const res = await new Client().get('/api/intelligence/attention')
    expect(res.status).toBe(401)
  })

  it('derives the tenant from the session and never shows another account’s cases', async () => {
    const alice = await signedIn(person('Alice', 'alice@example.test'))
    const bob = await signedIn(person('Bob', 'bob@example.test'))
    const { project } = authorizedProject('p_alice', { vendor: 'Fixture Coffee Co', invoice: 'INV-1', amount: 250, requested: 250 })
    store.upsert(alice.userId, project)
    for (const audit of tenantBAudits()) store.upsert(bob.userId, { ...audit, name: audit.name, sourceLabel: 'b.csv', mode: 'upload', createdAt: 1, updatedAt: 2 })

    const a = await alice.client.get('/api/intelligence/attention')
    expect(a.status).toBe(200)
    expect(a.body.tenantId).toBe(alice.userId)
    expect(a.body.origin).toBe('legacy_audit_snapshot')
    expect(a.body.result.items.map((i: { caseId: string }) => i.caseId)).toEqual(['p_alice/exact_duplicate-p_alice'])
    expect(a.body.result.items[0].kind).toBe('ready_to_send')

    const b = await bob.client.get('/api/intelligence/attention')
    expect(b.status).toBe(200)
    expect(b.body.tenantId).toBe(bob.userId)
    expect(JSON.stringify(b.body)).not.toContain('p_alice')

    // A tenant hint in the query string is ignored: the session decides.
    const forged = await bob.client.get(`/api/intelligence/attention?tenantId=${alice.userId}`)
    expect(JSON.stringify(forged.body)).not.toContain('p_alice')
  })

  it('validates query parameters instead of defaulting silently', async () => {
    const { client } = await signedIn(person('Cy', 'cy@example.test'))
    expect((await client.get('/api/intelligence/attention?limit=0')).status).toBe(400)
    expect((await client.get('/api/intelligence/attention?limit=abc')).status).toBe(400)
    expect((await client.get('/api/intelligence/attention?include=everything')).status).toBe(400)
    expect((await client.get('/api/intelligence/no-such-model')).status).toBe(404)
    expect((await client.post('/api/intelligence/attention')).status).toBe(404)
  })

  it('answers an empty account with an empty, explained result', async () => {
    const { client } = await signedIn(person('Di', 'di@example.test'))
    const res = await client.get('/api/intelligence/attention')
    expect(res.status).toBe(200)
    expect(res.body.result.items).toEqual([])
  })

  it('reads fixture audits saved like real ones', async () => {
    const alice = await signedIn(person('Eve', 'eve@example.test'))
    for (const audit of tenantAAudits()) store.upsert(alice.userId, { ...audit, sourceLabel: `${audit.id}.csv`, mode: 'upload', createdAt: 1, updatedAt: 2 })
    const res = await alice.client.get('/api/intelligence/attention')
    expect(res.status).toBe(200)
    expect(res.body.result.casesConsidered).toBeGreaterThan(0)
  })
})
