// @vitest-environment node
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { ProjectStore } from './projectStore.ts'

const MARKER = 'Zyxwv Plaintext Supplies LLC'
const project = (id: string, vendor = MARKER) => ({
  id,
  name: `${vendor} audit`,
  sourceLabel: `${vendor}.csv`,
  mode: 'upload',
  updatedAt: 5,
  environment: { records: [{ id: 'r1', vendor, invoiceNumber: 'INV-1', amountPaid: 1250, paymentDate: '2026-08-01' }], result: { findings: [] } },
})

let dir: string
let path: string
let db: DatabaseSync
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reclaim-store-'))
  path = join(dir, 'reclaim.sqlite')
  db = openDatabase(path)
  for (const id of ['u1', 'u2']) db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, 1)').run(id, `${id}@example.com`)
})
afterEach(() => {
  try {
    db.close()
  } catch {
    // already closed by the test
  }
  rmSync(dir, { recursive: true, force: true })
})

/** Every byte SQLite has on disk for this database: the file, its WAL and shared memory. */
const onDisk = () => ['', '-wal', '-shm'].map((suffix) => path + suffix).filter(existsSync).map((file) => readFileSync(file).toString('latin1')).join('')
const rawPayload = (userId: string, id: string) => (db.prepare('SELECT payload, name, source_label FROM projects WHERE user_id = ? AND id = ?').get(userId, id) as { payload: string; name: string; source_label: string })
const insertPlain = (userId: string, p: ReturnType<typeof project>) =>
  db.prepare("INSERT INTO projects (user_id, id, name, source_label, mode, created_at, updated_at, payload) VALUES (?, ?, ?, ?, 'upload', 1, 1, ?)").run(userId, p.id, p.name, p.sourceLabel, JSON.stringify(p))

describe('ProjectStore with DATA_KEY', () => {
  const key = randomBytes(32)

  it('stores audits sealed, names included, and reads them back', () => {
    const store = new ProjectStore(db, { current: key, previous: null })
    store.upsert('u1', project('p1'))
    const raw = rawPayload('u1', 'p1')
    expect(raw.payload.startsWith('v1.')).toBe(true)
    expect(raw.payload).not.toContain(MARKER)
    expect(raw.name).toBe('')
    expect(raw.source_label).toBe('')
    expect(store.get('u1', 'p1')).toEqual(project('p1'))
    expect(store.list('u1')).toEqual([project('p1')])
  })

  it('binds each payload to its account and audit: a copied row does not open', () => {
    const store = new ProjectStore(db, { current: key, previous: null })
    store.upsert('u1', project('p1'))
    const sealed = rawPayload('u1', 'p1').payload
    db.prepare("INSERT INTO projects (user_id, id, name, source_label, mode, created_at, updated_at, payload) VALUES ('u2', 'p1', '', '', 'upload', 1, 1, ?)").run(sealed)
    db.prepare("INSERT INTO projects (user_id, id, name, source_label, mode, created_at, updated_at, payload) VALUES ('u1', 'p2', '', '', 'upload', 1, 1, ?)").run(sealed)
    expect(() => store.get('u2', 'p1')).toThrow()
    expect(() => store.get('u1', 'p2')).toThrow()
  })

  it('reads old plain rows before migrating, then seals them and leaves no plaintext on disk', () => {
    insertPlain('u1', project('p1'))
    insertPlain('u2', project('p2'))
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run()
    expect(onDisk()).toContain(MARKER)

    const store = new ProjectStore(db, { current: key, previous: null })
    expect(store.get('u1', 'p1')).toEqual(project('p1'))
    expect(store.migrate()).toBe(2)
    expect(rawPayload('u1', 'p1').payload.startsWith('v1.')).toBe(true)
    expect(store.get('u2', 'p2')).toEqual(project('p2'))
    expect(onDisk()).not.toContain(MARKER)
    expect(store.migrate()).toBe(0)

    db.close()
    expect(onDisk()).not.toContain(MARKER)
  })

  it('rotates: rows under DATA_KEY_PREVIOUS read during the rotation and are re-sealed under the new key', () => {
    const next = randomBytes(32)
    new ProjectStore(db, { current: key, previous: null }).upsert('u1', project('p1'))
    insertPlain('u1', project('p2'))

    const rotating = new ProjectStore(db, { current: next, previous: key })
    expect(rotating.get('u1', 'p1')).toEqual(project('p1'))
    expect(rotating.migrate()).toBe(2)
    expect(new ProjectStore(db, { current: next, previous: null }).list('u1')).toHaveLength(2)
    expect(() => new ProjectStore(db, { current: key, previous: null }).get('u1', 'p1')).toThrow()
  })

  it('refuses the wrong key rather than returning garbage', () => {
    new ProjectStore(db, { current: key, previous: null }).upsert('u1', project('p1'))
    const wrong = new ProjectStore(db, { current: randomBytes(32), previous: null })
    expect(() => wrong.get('u1', 'p1')).toThrow()
    expect(() => wrong.migrate()).toThrow(/DATA_KEY is not the key/)
    expect(wrong.list('u1')).toEqual([])
    expect(wrong.unreadable('u1')).toMatchObject([{ id: 'p1' }])
  })
})

describe('ProjectStore without a key (development)', () => {
  it('stores plain JSON as before', () => {
    const store = new ProjectStore(db, null)
    store.upsert('u1', project('p1'))
    expect(JSON.parse(rawPayload('u1', 'p1').payload)).toEqual(project('p1'))
    expect(store.migrate()).toBe(0)
  })

  it('says why a sealed audit cannot be read', () => {
    new ProjectStore(db, { current: randomBytes(32), previous: null }).upsert('u1', project('p1'))
    expect(() => new ProjectStore(db, null).get('u1', 'p1')).toThrow(/DATA_KEY is not set/)
  })
})

describe('deleting', () => {
  it('zeroes a deleted audit instead of leaving it in free pages', () => {
    const store = new ProjectStore(db, null)
    store.upsert('u1', project('p1'))
    store.upsert('u1', project('keep', 'Other Vendor'))
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run()
    expect(onDisk()).toContain(MARKER)
    store.delete('u1', 'p1')
    db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run()
    expect(onDisk()).not.toContain(MARKER)
  })
})

describe('the key check', () => {
  const key = randomBytes(32)
  const rows = () => (db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
  const corrupt = (userId: string, id: string) => {
    const [v, iv, tag, body] = rawPayload(userId, id).payload.split('.')
    db.prepare('UPDATE projects SET payload = ? WHERE user_id = ? AND id = ?').run([v, iv, tag, `AAAA${body.slice(4)}`].join('.'), userId, id)
  }

  it('is written on the first start and refuses a different key, even before any audit exists', () => {
    new ProjectStore(db, { current: key, previous: null }).migrate()
    const wrong = new ProjectStore(db, { current: randomBytes(32), previous: null })
    expect(() => wrong.migrate()).toThrow(/DATA_KEY is not the key/)
    expect(new ProjectStore(db, { current: key, previous: null }).migrate()).toBe(0)
  })

  it('refuses a wrong key on a database from before the check existed', () => {
    new ProjectStore(db, { current: key, previous: null }).upsert('u1', project('p1'))
    db.exec('DELETE FROM data_key_check')
    expect(() => new ProjectStore(db, { current: randomBytes(32), previous: null }).migrate()).toThrow(/DATA_KEY is not the key/)
    expect(new ProjectStore(db, { current: key, previous: null }).migrate()).toBe(0)
    expect(new ProjectStore(db, { current: key, previous: null }).get('u1', 'p1')).toEqual(project('p1'))
  })

  it('rotates with DATA_KEY_PREVIOUS, then accepts only the new key', () => {
    const next = randomBytes(32)
    const store = new ProjectStore(db, { current: key, previous: null })
    store.migrate()
    store.upsert('u1', project('p1'))
    expect(() => new ProjectStore(db, { current: next, previous: randomBytes(32) }).migrate()).toThrow(/DATA_KEY/)
    expect(new ProjectStore(db, { current: next, previous: key }).migrate()).toBe(1)
    expect(new ProjectStore(db, { current: next, previous: null }).migrate()).toBe(0)
    expect(() => new ProjectStore(db, { current: key, previous: null }).migrate()).toThrow(/DATA_KEY is not the key/)
  })

  it('never names or prints a key', () => {
    new ProjectStore(db, { current: key, previous: null }).migrate()
    const wrong = randomBytes(32)
    try {
      new ProjectStore(db, { current: wrong, previous: null }).migrate()
      expect.unreachable()
    } catch (err) {
      expect(String(err)).not.toContain(wrong.toString('base64'))
      expect(String(err)).toContain('DATA_KEY_PREVIOUS')
    }
  })

  it('a damaged check value is repaired when the key still opens a stored audit', () => {
    const store = new ProjectStore(db, { current: key, previous: null })
    store.migrate()
    store.upsert('u1', project('p1'))
    db.exec("UPDATE data_key_check SET sealed = 'v1.x.y.z'")
    expect(new ProjectStore(db, { current: key, previous: null }).migrate()).toBe(0)
    expect(() => new ProjectStore(db, { current: randomBytes(32), previous: null }).migrate()).toThrow(/DATA_KEY/)
  })

  it('one unreadable audit is set apart, not deleted, and the rest still list and start', () => {
    const store = new ProjectStore(db, { current: key, previous: null })
    store.migrate()
    for (const id of ['p1', 'p2', 'p3']) store.upsert('u1', project(id))
    corrupt('u1', 'p2')
    db.prepare("UPDATE projects SET payload = '{not json' WHERE id = 'p3'").run()
    const before = rawPayload('u1', 'p2').payload

    const restarted = new ProjectStore(db, { current: key, previous: null })
    restarted.migrate()
    expect(restarted.list('u1').map((p) => p.id)).toEqual(['p1'])
    expect(restarted.unreadable('u1').map((u) => u.id).sort()).toEqual(['p2', 'p3'])
    expect(() => restarted.get('u1', 'p2')).toThrow(/can’t be opened/)
    expect(rows()).toBe(3)
    expect(rawPayload('u1', 'p2').payload).toBe(before)
    // Not even a rotation drops it.
    const next = randomBytes(32)
    new ProjectStore(db, { current: next, previous: key }).migrate()
    expect(new ProjectStore(db, { current: next, previous: null }).list('u1').map((p) => p.id)).toEqual(['p1'])
    expect(rawPayload('u1', 'p2').payload).toBe(before)
  })
})

describe('a server with one unreadable audit', () => {
  it('starts, lists and exports the rest, and refuses to write over it', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0', REQUIRE_EMAIL_VERIFICATION: 'false', DATA_KEY: randomBytes(32).toString('base64') })
    const open = () => createApp({ config, db, google: null, drafts: null, quickbooks: null, stripe: null, gmail: null })
    let app = open()
    let base = `http://127.0.0.1:${await app.listen(0)}`
    let cookie = ''
    const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined })
      const set = res.headers.getSetCookie()[0]
      if (set) cookie = set.split(';')[0]
      return { status: res.status, body: (await res.json()) as any }
    }
    await call('POST', '/api/auth/signup', { firstName: 'A', lastName: 'B', email: 'a@example.com', company: 'C', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery', acceptedTerms: true, termsVersion: 't' })
    for (const id of ['good', 'bad']) expect((await call('PUT', `/api/projects/${id}`, project(id, `Vendor ${id}`))).status).toBe(200)
    await app.close()
    db.prepare("UPDATE projects SET payload = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE id = 'bad'").run()

    app = open()
    base = `http://127.0.0.1:${await app.listen(0)}`
    const list = await call('GET', '/api/projects')
    expect(list.status).toBe(200)
    expect(list.body.projects.map((p: { id: string }) => p.id)).toEqual(['good'])
    expect(list.body.unreadable).toMatchObject([{ id: 'bad' }])
    const exported = await call('GET', '/api/account/export')
    expect(exported.status).toBe(200)
    expect(exported.body.audits).toHaveLength(1)
    expect(exported.body.unreadableAudits).toMatchObject([{ id: 'bad' }])
    const write = await call('PUT', '/api/projects/bad', project('bad', 'Vendor bad'), { 'If-Match': '1' })
    expect([write.status, write.body.code]).toEqual([409, 'audit_unreadable'])
    expect((db.prepare("SELECT payload FROM projects WHERE id = 'bad'").get() as { payload: string }).payload).toMatch(/^v1\.AAAA/)
    await app.close()
  })
})
