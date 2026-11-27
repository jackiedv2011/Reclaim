// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type App } from './app.ts'
import { loadConfig } from './config.ts'
import { openDatabase } from './db.ts'
import { DevMailer } from './mailer.ts'

let dir: string
let app: App
let port: number
const video = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251))
const script = `export const x = ${JSON.stringify('reclaim '.repeat(400))}\n`

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'reclaim-static-'))
  mkdirSync(join(dir, 'assets'))
  mkdirSync(join(dir, 'media'))
  mkdirSync(join(dir, 'pricing'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>')
  writeFileSync(join(dir, 'pricing', 'index.html'), '<!doctype html><title>pricing</title>')
  writeFileSync(join(dir, 'assets', 'AuditApp-BCPe5xrE.js'), script)
  writeFileSync(join(dir, 'assets', 'dept-freight.png'), video)
  writeFileSync(join(dir, 'main.js'), script)
  writeFileSync(join(dir, 'media', 'd.mp4'), video)
  const db = openDatabase(':memory:')
  app = createApp({ config: loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0' }), db, mailer: new DevMailer(db), google: null, drafts: null, staticDir: dir })
  port = await app.listen(0)
})
afterEach(async () => {
  await app.close()
  app.db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Raw requests: `fetch` would decompress, and hides what a HEAD really sent. */
function call(method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
    const req = request({ port, host: '127.0.0.1', method, path, headers, agent: false }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('a missing file', () => {
  it('is a 404 when the address is a file, never the app page', async () => {
    for (const path of ['/assets/AuditApp-OLDHASH1.js', '/assets/gone', '/old.css', '/media/x.mp4', '/fonts/x.woff2', '/a/b.js.map']) {
      const res = await call('GET', path)
      expect([path, res.status]).toEqual([path, 404])
      expect(String(res.headers['content-type'] ?? '')).not.toContain('html')
      // A deploy that is still rolling out must not leave the 404 in a cache.
      expect(res.headers['cache-control']).toBe('no-store')
    }
  })

  it('is the app page for an app address, even one with a dot in it', async () => {
    for (const path of ['/audit', '/verify-email', '/somewhere/else', '/v1.2']) {
      const res = await call('GET', path)
      expect([path, res.status]).toEqual([path, 200])
      expect(res.body.toString()).toContain('<title>app</title>')
    }
    expect((await call('GET', '/pricing')).body.toString()).toContain('pricing')
  })
})

describe('caching', () => {
  it('keeps hashed assets for a year, and checks everything else again', async () => {
    expect((await call('GET', '/assets/AuditApp-BCPe5xrE.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect((await call('GET', '/')).headers['cache-control']).toBe('no-cache')
    expect((await call('GET', '/audit')).headers['cache-control']).toBe('no-cache')
    expect((await call('GET', '/main.js')).headers['cache-control']).toBe('no-cache')
    expect((await call('GET', '/assets/dept-freight.png')).headers['cache-control']).not.toContain('immutable')
    expect((await call('GET', '/media/d.mp4')).headers['cache-control']).toBe('public, max-age=3600')
  })

  it('answers 304 when the browser already has this version', async () => {
    const first = await call('GET', '/main.js')
    const again = await call('GET', '/main.js', { 'If-None-Match': String(first.headers.etag) })
    expect([again.status, again.body.length]).toEqual([304, 0])
    writeFileSync(join(dir, 'main.js'), `${script}// changed`)
    expect((await call('GET', '/main.js', { 'If-None-Match': String(first.headers.etag) })).status).toBe(200)
  })
})

describe('HEAD', () => {
  it.each(['/', '/audit', '/assets/AuditApp-BCPe5xrE.js', '/media/d.mp4', '/assets/missing.js'])('%s sends the headers GET would, and no body', async (path) => {
    const get = await call('GET', path)
    const head = await call('HEAD', path)
    expect(head.status).toBe(get.status)
    expect(head.body.length).toBe(0)
    const strip = ({ date: _date, ...rest }: Record<string, unknown>) => rest
    expect(strip(head.headers)).toEqual(strip(get.headers))
  })
})

describe('byte ranges', () => {
  it('serve the part a video player asks for', async () => {
    expect((await call('GET', '/media/d.mp4')).headers['accept-ranges']).toBe('bytes')
    const cases: Array<[string, number, number]> = [['bytes=0-99', 0, 99], ['bytes=100-', 100, 4999], ['bytes=-10', 4990, 4999], ['bytes=4990-9999', 4990, 4999]]
    for (const [range, from, to] of cases) {
      const res = await call('GET', '/media/d.mp4', { Range: range })
      expect([range, res.status, res.headers['content-range']]).toEqual([range, 206, `bytes ${from}-${to}/5000`])
      expect(res.headers['content-length']).toBe(String(to - from + 1))
      expect(res.body.equals(video.subarray(from, to + 1))).toBe(true)
    }
  })

  it('refuse a part past the end, and ignore what they cannot read', async () => {
    const past = await call('GET', '/media/d.mp4', { Range: 'bytes=5000-' })
    expect([past.status, past.headers['content-range']]).toEqual([416, 'bytes */5000'])
    for (const range of ['bytes=a-b', 'items=0-5', 'bytes=0-1,5-6', 'bytes=9-3', 'bytes=-']) expect([range, (await call('GET', '/media/d.mp4', { Range: range })).status]).toEqual([range, 200])
  })

  it('send the whole file when it changed since the player started', async () => {
    const etag = String((await call('GET', '/media/d.mp4')).headers.etag)
    expect((await call('GET', '/media/d.mp4', { Range: 'bytes=0-9', 'If-Range': etag })).status).toBe(206)
    expect((await call('GET', '/media/d.mp4', { Range: 'bytes=0-9', 'If-Range': '"other"' })).status).toBe(200)
  })
})

describe('compression', () => {
  it('gzips text for browsers that take it, and leaves media alone', async () => {
    const zipped = await call('GET', '/main.js', { 'Accept-Encoding': 'gzip, br' })
    expect(zipped.headers['content-encoding']).toBe('gzip')
    expect(zipped.headers.vary).toContain('Accept-Encoding')
    expect(zipped.body.length).toBeLessThan(script.length)
    expect(gunzipSync(zipped.body).toString()).toBe(script)
    expect((await call('GET', '/main.js')).headers['content-encoding']).toBeUndefined()
    expect((await call('GET', '/main.js', { 'Accept-Encoding': 'gzip;q=0' })).headers['content-encoding']).toBeUndefined()
    expect((await call('GET', '/media/d.mp4', { 'Accept-Encoding': 'gzip' })).headers['content-encoding']).toBeUndefined()
  })
})
