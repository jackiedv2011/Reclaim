import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { gzipSync } from 'node:zlib'
import { HttpError, empty, type Request, type Response } from './http.ts'

/**
 * The built site (production): the landing pages, the React app and its
 * hashed assets. GET and HEAD, byte ranges, caching and gzip.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.pdf': 'application/pdf',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
}

/** Vite's output: `/assets/name-XXXXXXXX.ext`, where the eight characters change with the content. */
const HASHED = /^\/assets\/.+-(?=[\w-]*[A-Z0-9])[\w-]{8}\.\w+$/
const COMPRESSIBLE = /^(text\/|image\/svg|application\/(json|xml|manifest))/
const MEDIA = /^(image|video|audio|font)\//
const MIN_GZIP_BYTES = 1024

/** Text files compressed once per version. The built site is a few dozen of them. */
const gzipped = new Map<string, { etag: string; body: Buffer }>()

export function serveStatic(root: string, req: Request): Response {
  let decoded: string
  try {
    decoded = decodeURIComponent(req.url.pathname)
  } catch {
    throw new HttpError(400, 'Bad request.')
  }
  const base = resolve(root)
  const safe = normalize(decoded).replace(/^(\.\.[/\\])+/, '')
  const candidates = [join(base, safe), join(base, safe, 'index.html')]
  // The app page answers for app addresses only. A browser holding the previous
  // deploy's page asks for files that are gone; HTML under a .js address would
  // break it silently, a 404 lets it reload.
  if (!isFileAddress(safe)) candidates.push(join(base, 'index.html'))
  for (const file of candidates) {
    if (file !== base && !file.startsWith(base + sep)) continue
    const stat = statSync(file, { throwIfNoEntry: false })
    if (stat?.isFile()) return serveFile(file, stat.size, stat.mtimeMs, decoded, req)
  }
  return empty(404, { 'Cache-Control': 'no-store', 'Content-Length': '0' })
}

function isFileAddress(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return path.replaceAll('\\', '/').startsWith('/assets/') || (ext in MIME && ext !== '.html')
}

function serveFile(file: string, size: number, mtimeMs: number, urlPath: string, req: Request): Response {
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const etag = `"${size.toString(36)}-${Math.floor(mtimeMs).toString(36)}"`
  const compressible = COMPRESSIBLE.test(type) && size >= MIN_GZIP_BYTES
  const headers: Record<string, string> = {
    'Content-Type': type,
    'Cache-Control': HASHED.test(urlPath) ? 'public, max-age=31536000, immutable' : MEDIA.test(type) ? 'public, max-age=3600' : 'no-cache',
    ETag: etag,
    'Last-Modified': new Date(mtimeMs).toUTCString(),
    'Accept-Ranges': 'bytes',
    ...(compressible ? { Vary: 'Accept-Encoding' } : {}),
  }
  const range = rangeFor(req, etag, size)
  const gzip = compressible && !range && acceptsGzip(req)
  if (gzip) headers.ETag = etag.replace(/"$/, '-gz"')

  const known = req.headers['if-none-match']
  if (known && known.split(',').some((tag) => tag.trim().replace(/^W\//, '') === headers.ETag || tag.trim() === '*')) return { status: 304, headers, body: null }

  if (range === 'unsatisfiable') return empty(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' })
  if (range) {
    const length = range.to - range.from + 1
    return { status: 206, headers: { ...headers, 'Content-Range': `bytes ${range.from}-${range.to}/${size}`, 'Content-Length': String(length) }, body: req.method === 'HEAD' ? null : readPart(file, range.from, length) }
  }
  if (gzip) {
    const body = compressed(file, etag)
    return { status: 200, headers: { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': String(body.length) }, body: req.method === 'HEAD' ? null : body }
  }
  return { status: 200, headers: { ...headers, 'Content-Length': String(size) }, body: req.method === 'HEAD' ? null : readFileSync(file) }
}

function compressed(file: string, etag: string): Buffer {
  const cached = gzipped.get(file)
  if (cached?.etag === etag) return cached.body
  const body = gzipSync(readFileSync(file))
  gzipped.set(file, { etag, body })
  return body
}

function acceptsGzip(req: Request): boolean {
  const header = req.headers['accept-encoding']
  return (Array.isArray(header) ? header.join(',') : (header ?? '')).split(',').some((part) => {
    const [name, ...params] = part.trim().split(';')
    return name.trim().toLowerCase() === 'gzip' && !params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p))
  })
}

/** One byte range, as video players send it. Anything else is served whole, which HTTP allows. */
function rangeFor(req: Request, etag: string, size: number): { from: number; to: number } | 'unsatisfiable' | null {
  const header = req.headers.range
  if (!header) return null
  const condition = req.headers['if-range']
  if (condition && condition !== etag) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const last = Number(match[2])
    return last === 0 || size === 0 ? 'unsatisfiable' : { from: Math.max(0, size - last), to: size - 1 }
  }
  const from = Number(match[1])
  const to = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (match[2] && Number(match[2]) < from) return null
  return from >= size ? 'unsatisfiable' : { from, to }
}

function readPart(file: string, from: number, length: number): Buffer {
  const body = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    let read = 0
    while (read < length) {
      const n = readSync(fd, body, read, length - read, from + read)
      if (n === 0) break
      read += n
    }
    return body
  } finally {
    closeSync(fd)
  }
}
