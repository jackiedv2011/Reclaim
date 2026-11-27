// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App } from '../app.ts'
import { loadConfig } from '../config.ts'
import { openDatabase } from '../db.ts'
import { DevMailer } from '../mailer.ts'
import { ProjectStore } from '../projectStore.ts'
import { JOB_KINDS } from './handlers.ts'
import { jobSystemFor, type JobSystem } from './system.ts'
import { DAY, requestedProject } from './testFixtures.ts'

const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0', SESSION_DAYS: '1', REMEMBER_ME_DAYS: '30' })
const T0 = Date.UTC(2026, 10, 25, 15)

let app: App
let base: string
let jobs: JobSystem
let clock: number

class Client {
  cookies = new Map<string, string>()
  async call(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers)
    if (init.json !== undefined) headers.set('Content-Type', 'application/json')
    if (this.cookies.size) headers.set('Cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
    const res = await fetch(base + path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, redirect: 'manual' })
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';')
      const [name, value] = pair.split('=')
      if (attrs.some((a) => a.trim() === 'Max-Age=0')) this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    const text = await res.text()
    // oxlint-disable-next-line typescript/no-explicit-any
    let body: any = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = text
    }
    return { status: res.status, body }
  }
  get = (p: string) => this.call(p)
  post = (p: string, json: unknown = {}) => this.call(p, { method: 'POST', json })
  put = (p: string, json: unknown) => this.call(p, { method: 'PUT', json })
}

const person = (first: string, email: string) => ({ firstName: first, lastName: 'Test', email, company: `${first} Co`, password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery', acceptedTerms: true, termsVersion: '2026-01' })

async function signUp(client: Client, input: ReturnType<typeof person>): Promise<string> {
  expect((await client.post('/api/auth/signup', input)).status).toBe(201)
  const mail = (await new Client().get(`/api/dev/mailbox?to=${encodeURIComponent(input.email)}`)).body.messages[0]
  const verified = await client.post('/api/auth/verify-email', { token: new URL(mail.link).searchParams.get('token') })
  expect(verified.status).toBe(200)
  return (app.db.prepare('SELECT id FROM users WHERE email = ?').get(input.email.toLowerCase()) as { id: string }).id
}

beforeEach(async () => {
  clock = T0
  const db = openDatabase(':memory:')
  app = createApp({ config, db, mailer: new DevMailer(db), now: () => clock })
  jobs = jobSystemFor(db)!
  base = `http://127.0.0.1:${await app.listen(0)}`
})
afterEach(async () => {
  await app.close()
  app.db.close()
})

describe('/api/jobs', () => {
  it('queues a scan for the signed-in tenant without running it, once per minute', async () => {
    const alice = new Client()
    const aliceId = await signUp(alice, person('Alice', 'alice@example.test'))
    const first = await alice.post('/api/jobs/scan')
    expect(first.status).toBe(202)
    expect(first.body.job).toMatchObject({ kind: JOB_KINDS.scan, status: 'queued', attempts: 0 })
    const again = await alice.post('/api/jobs/scan')
    expect(again.status).toBe(200)
    expect(again.body.job.id).toBe(first.body.job.id)
    expect((await alice.get('/api/jobs')).body.jobs.map((j: { id: string }) => j.id)).toEqual([first.body.job.id])
    expect(jobs.runner.get(aliceId, first.body.job.id)!.status).toBe('queued')

    await jobs.runDue(clock, 'w')
    expect((await alice.get(`/api/jobs/${first.body.job.id}`)).body.job.status).toBe('done')
    expect((await alice.get(`/api/jobs/${first.body.job.id}/events`)).body.events.map((e: { event: string }) => e.event)).toEqual(['enqueued', 'claimed', 'succeeded'])
    expect((await alice.get('/api/jobs?status=nope')).status).toBe(400)
    // A finished job can't be cancelled.
    expect((await alice.post(`/api/jobs/${first.body.job.id}/cancel`)).body.code).toBe('job_finished')
  })

  it('cancels only the tenant’s own queued jobs', async () => {
    const alice = new Client()
    const bob = new Client()
    await signUp(alice, person('Alice', 'alice@example.test'))
    await signUp(bob, person('Bob', 'bob@example.test'))
    const { job } = (await alice.post('/api/jobs/scan')).body
    expect((await bob.get(`/api/jobs/${job.id}`)).status).toBe(404)
    expect((await bob.post(`/api/jobs/${job.id}/cancel`)).status).toBe(404)
    expect((await bob.get('/api/jobs')).body.jobs).toEqual([])
    const cancelled = await alice.post(`/api/jobs/${job.id}/cancel`)
    expect(cancelled.status).toBe(200)
    expect(cancelled.body.job.status).toBe('cancelled')
    // Cancelling twice is harmless.
    expect((await alice.post(`/api/jobs/${job.id}/cancel`)).body.job.status).toBe('cancelled')
    expect(await jobs.runDue(clock, 'w')).toEqual([])
  })

  it('requires a session', async () => {
    for (const [method, path] of [['GET', '/api/jobs'], ['POST', '/api/jobs/scan'], ['GET', '/api/notifications'], ['GET', '/api/notifications/preferences']]) {
      expect((await new Client().call(path, { method, ...(method === 'POST' ? { json: {} } : {}) })).status).toBe(401)
    }
  })
})

describe('/api/notifications', () => {
  it('lists, marks read and keeps preferences, per tenant', async () => {
    const alice = new Client()
    const bob = new Client()
    const aliceId = await signUp(alice, person('Alice', 'alice@example.test'))
    await signUp(bob, person('Bob', 'bob@example.test'))
    jobs.notifications.add(aliceId, { kind: 'vendor_reply', dedupeKey: 'r1', projectId: 'p1', findingId: 'f1', dueAt: clock }, clock)

    const list = await alice.get('/api/notifications')
    expect(list.body.unread).toBe(1)
    const [n] = list.body.notifications
    expect(n).toMatchObject({ kind: 'vendor_reply', projectId: 'p1', findingId: 'f1', readAt: null, link: '/audit?project=p1&case=f1' })
    expect((await bob.get('/api/notifications')).body).toEqual({ notifications: [], unread: 0 })
    expect((await bob.post(`/api/notifications/${n.id}/read`)).status).toBe(404)
    expect((await alice.post(`/api/notifications/${n.id}/read`)).body.notification.readAt).toBe(clock)
    expect((await alice.get('/api/notifications?unread=1')).body).toEqual({ notifications: [], unread: 0 })

    expect((await alice.get('/api/notifications/preferences')).body.preferences).toEqual({ digestEnabled: false, timeZone: 'UTC', localHour: 8, lastDigestOn: null })
    expect((await alice.put('/api/notifications/preferences', { digestEnabled: true, timeZone: 'Mars/Olympus', localHour: 8 })).status).toBe(400)
    expect((await alice.put('/api/notifications/preferences', { digestEnabled: true, timeZone: 'Europe/Berlin', localHour: 24 })).status).toBe(400)
    const saved = await alice.put('/api/notifications/preferences', { digestEnabled: true, timeZone: 'Europe/Berlin', localHour: 7 })
    expect(saved.body.preferences).toEqual({ digestEnabled: true, timeZone: 'Europe/Berlin', localHour: 7, lastDigestOn: null })
    expect((await bob.get('/api/notifications/preferences')).body.preferences.digestEnabled).toBe(false)
  })
})

describe('account deletion', () => {
  it('removes the tenant’s jobs, job events, notifications and preferences, and nobody else’s', async () => {
    const alice = new Client()
    const bob = new Client()
    const aliceId = await signUp(alice, person('Alice', 'alice@example.test'))
    const bobId = await signUp(bob, person('Bob', 'bob@example.test'))
    const store = new ProjectStore(app.db, config.dataKeys)
    for (const id of [aliceId, bobId]) {
      store.upsert(id, requestedProject('p1', { sentAt: T0 - 10 * DAY }).project)
      jobs.notifications.setPreferences(id, { digestEnabled: true, timeZone: 'UTC', localHour: 8 }, clock)
    }
    await jobs.tick(clock, 'w')
    const rows = (table: string, id: string) => (app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(id) as { n: number }).n
    const tables = ['jobs', 'job_events', 'notifications', 'notification_preferences', 'action_proposals']
    for (const t of tables) expect(rows(t, aliceId)).toBeGreaterThan(0)

    expect((await alice.post('/api/account/delete', { confirmEmail: 'alice@example.test' })).status).toBe(200)
    for (const t of tables) expect(rows(t, aliceId)).toBe(0)
    for (const t of tables) expect(rows(t, bobId)).toBeGreaterThan(0)
  })
})
