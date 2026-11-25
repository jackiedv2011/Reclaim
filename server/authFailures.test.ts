// @vitest-environment node
// Sign-up, reset and login when something else is going wrong: a mail outage, a double click, a lockout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, type App } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import type { Mailer, OutgoingMail } from './mailer.ts'

const config = (extra: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0', ...extra })

/** A provider that can be down, or slow. Nothing leaves the process. */
class FlakyMailer implements Mailer {
  readonly kind = 'dev' as const
  down = false
  delay = 0
  sent: OutgoingMail[] = []
  async send(mail: OutgoingMail) {
    if (this.delay) await new Promise((resolve) => setTimeout(resolve, this.delay))
    if (this.down) throw new Error('smtp down')
    this.sent.push(mail)
  }
}

let app: App
let base: string
let mailer: FlakyMailer
async function start(extra: Record<string, string> = {}) {
  mailer = new FlakyMailer()
  app = createApp({ config: config(extra), db: openDatabase(':memory:'), mailer, google: null, drafts: null, quickbooks: null, gmail: null, stripe: null })
  base = `http://127.0.0.1:${await app.listen(0)}`
}
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}))
afterEach(async () => {
  await app.close()
  app.db.close()
  vi.restoreAllMocks()
})

const post = async (path: string, json: unknown) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(json) })
  return { status: res.status, body: (await res.json()) as any }
}
const person = (email: string, password = 'correct-horse-battery') => ({ firstName: 'Pat', lastName: 'Lee', email, company: 'Lee Co', password, confirmPassword: password, acceptedTerms: true, termsVersion: 't' })
const users = () => (app.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
const linkIn = (subject: RegExp) => new URL(mailer.sent.filter((m) => subject.test(m.subject)).at(-1)!.link!).searchParams.get('token')

describe('a mail outage', () => {
  it('at sign-up leaves no half-made account, says so, and the retry works', async () => {
    await start()
    mailer.down = true
    const failed = await post('/api/auth/signup', person('pat@example.com'))
    expect([failed.status, failed.body.code]).toEqual([503, 'mail_unavailable'])
    expect(failed.body.message).toMatch(/No account was created/)
    expect(users()).toBe(0)
    mailer.down = false
    expect((await post('/api/auth/signup', person('pat@example.com'))).status).toBe(201)
    expect((await post('/api/auth/verify-email', { token: linkIn(/Confirm/) })).status).toBe(200)
    expect((await post('/api/auth/login', { email: 'pat@example.com', password: 'correct-horse-battery' })).status).toBe(200)
  })

  it('at sign-up answers the same for an address that already has an account, and leaves that account alone', async () => {
    await start()
    await post('/api/auth/signup', person('known@example.com'))
    await post('/api/auth/verify-email', { token: linkIn(/Confirm/) })
    mailer.down = true
    const known = await post('/api/auth/signup', person('known@example.com', 'some-other-password'))
    const unknown = await post('/api/auth/signup', person('unknown@example.com'))
    expect(known).toEqual(unknown)
    expect(users()).toBe(1)
    expect((await post('/api/auth/login', { email: 'known@example.com', password: 'correct-horse-battery' })).status).toBe(200)
  })

  it('at forgot-password and resend answers the same for known and unknown addresses', async () => {
    await start()
    await post('/api/auth/signup', person('known@example.com'))
    mailer.down = true
    for (const path of ['/api/auth/forgot-password', '/api/auth/resend-verification']) {
      const known = await post(path, { email: 'known@example.com' })
      expect(known).toEqual({ status: 200, body: { ok: true } })
      expect(await post(path, { email: 'unknown@example.com' })).toEqual(known)
    }
  })

  it('a slow provider does not make a known address answer later than an unknown one', async () => {
    await start()
    await post('/api/auth/signup', person('known@example.com'))
    mailer.delay = 400
    const started = Date.now()
    await post('/api/auth/forgot-password', { email: 'known@example.com' })
    expect(Date.now() - started).toBeLessThan(250)
    await vi.waitFor(() => expect(mailer.sent.some((m) => /Reset/.test(m.subject))).toBe(true), 2000)
  })
})

describe('signing up twice at once', () => {
  it('a double click makes one account and no error', async () => {
    await start()
    mailer.delay = 30
    const results = await Promise.all([1, 2, 3].map(() => post('/api/auth/signup', person('pat@example.com'))))
    expect(results.map((r) => r.status)).toEqual([201, 201, 201])
    expect(users()).toBe(1)
    // Whichever email is opened, its link works: the same person asked each time.
    expect(mailer.sent.every((m) => /Confirm your email/.test(m.subject))).toBe(true)
    expect((await post('/api/auth/verify-email', { token: linkIn(/Confirm/) })).status).toBe(200)
  })

  it('someone else’s password on an unconfirmed address changes nothing and sends no new link', async () => {
    await start()
    await post('/api/auth/signup', person('pat@example.com'))
    expect((await post('/api/auth/signup', person('pat@example.com', 'another-password'))).status).toBe(201)
    expect(mailer.sent.map((m) => m.subject)).toEqual(['Confirm your email for Reclaim', 'You already have a Reclaim account'])
    await post('/api/auth/verify-email', { token: linkIn(/Confirm/) })
    expect((await post('/api/auth/login', { email: 'pat@example.com', password: 'another-password' })).status).toBe(401)
  })

  it('without email verification the second gets a plain 409', async () => {
    await start({ REQUIRE_EMAIL_VERIFICATION: 'false' })
    const results = await Promise.all([1, 2].map(() => post('/api/auth/signup', person('pat@example.com'))))
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(results.find((r) => r.status === 409)!.body).toMatchObject({ code: 'account_exists', message: expect.stringMatching(/Log in/) })
    expect(users()).toBe(1)
  })
})

describe('messages', () => {
  it('a locked address is told how long the lock really is', async () => {
    await start({ TRUST_PROXY: '1' })
    let last: any
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${i}` }, body: JSON.stringify({ email: 'victim@example.com', password: 'wrong-password' }) })
      last = { status: res.status, body: await res.json() }
    }
    expect(last.status).toBe(429)
    expect(last.body.message).toMatch(/15 minutes/)
    // The per-visitor limit really is a minute.
    await app.close()
    app.db.close()
    await start()
    for (let i = 0; i < 21; i++) last = await post('/api/auth/login', { email: `a${i}@example.com`, password: 'wrong-password' })
    expect(last.body.message).toMatch(/Wait a minute/)
  }, 20_000)

  it('a JSON body that is not an object is a 400 everywhere', async () => {
    await start()
    for (const path of ['/api/auth/login', '/api/auth/signup', '/api/auth/verify-email', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/contact']) {
      for (const body of ['null', '[]', '"text"', '7']) {
        const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
        expect([path, body, res.status]).toEqual([path, body, 400])
      }
    }
  })
})
