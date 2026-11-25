/**
 * Tables for inbound supplier replies (J4): per-case reply routes, seen
 * webhook signatures, and the messages themselves.
 *
 * A route is `reply+<token>@<inboundDomain>`. The token is 32 random bytes in
 * lowercase base32 (52 characters, so the local part stays under 64 and
 * survives providers that lowercase it). Only its SHA-256 is stored: a
 * database leak doesn't hand out working reply addresses.
 *
 * Message content (sender, subject, sanitized text, the stripped reply, the
 * rules' classification with its quoted evidence, attachment names) is sealed
 * under DATA_KEY bound to the tenant and message id. Raw HTML, raw headers and
 * attachment bytes are never stored.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomBytes, randomUUID } from 'node:crypto'
import { sha256, type Sealer } from '../sealedJson.ts'
import type { ReplyClassification } from './classify.ts'

const B32 = 'abcdefghijklmnopqrstuvwxyz234567'
function base32(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export const TOKEN_PATTERN = '[a-z2-7]{52}'
export const newRouteToken = () => base32(randomBytes(32))
export const tokenHash = (token: string) => sha256(`inbound-route:${token.toLowerCase()}`)
/** A short, non-secret handle for a route (for listing and revoking). */
export const routeHandle = (hash: string) => hash.slice(0, 16)

export interface RouteRow { token_hash: string; user_id: string; project_id: string; finding_id: string; generation: number; created_at: number; revoked_at: number | null }

export interface AttachmentMeta { name: string; declaredType: string; size: number; sha256: string | null; quarantined: true }
export interface Authentication { spf: string; dkim: string; dmarc: string }

export interface MessageContent {
  from: string | null
  fromName: string
  subject: string
  /** Sanitized full text, quoted history included. */
  text: string
  /** What the supplier wrote this time (offsets in `classification` point here). */
  reply: string
  attachments: AttachmentMeta[]
  classification: ReplyClassification | null
}

export type MessageStatus = 'accepted' | 'quarantined'

export interface MessageView extends MessageContent {
  id: string
  projectId: string
  findingId: string
  generation: number | null
  provider: string
  status: MessageStatus
  reasons: string[]
  authentication: Authentication
  receivedAt: number
  proposalId: string | null
  proposalCode: string | null
}

type MessageRow = {
  id: string; user_id: string | null; project_id: string | null; finding_id: string | null; generation: number | null
  provider: string; provider_message_id: string; status: MessageStatus; reasons: string; content_sealed: string | null
  authentication: string; received_at: number; route_hash: string | null; proposal_id: string | null; proposal_code: string | null
}

export function migrateInbound(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_routes (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS inbound_routes_case ON inbound_routes(user_id, project_id, finding_id);
    CREATE TABLE IF NOT EXISTS inbound_webhook_seen (
      signature_hash TEXT PRIMARY KEY,
      seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbound_messages (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT,
      finding_id TEXT,
      generation INTEGER,
      provider TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'quarantined')),
      reasons TEXT NOT NULL,
      content_sealed TEXT,
      authentication TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      route_hash TEXT,
      proposal_id TEXT,
      proposal_code TEXT,
      UNIQUE (provider, provider_message_id)
    );
    CREATE INDEX IF NOT EXISTS inbound_messages_case ON inbound_messages(user_id, project_id, finding_id, received_at);
  `)
}

/** Signatures are remembered a little longer than the timestamp tolerance, then forgotten. */
const SEEN_TTL_MS = 15 * 60_000

export class InboundStore {
  private readonly db: DatabaseSync
  private readonly sealer: Sealer
  private readonly now: () => number

  constructor(db: DatabaseSync, sealer: Sealer, now: () => number) {
    this.db = db
    this.sealer = sealer
    this.now = now
    migrateInbound(db)
  }

  private context = (tenantId: string, id: string) => `inbound:${tenantId}:${id}`

  // ---------- routes ----------

  issueRoute(tenantId: string, projectId: string, findingId: string, generation: number): { token: string; hash: string } {
    const token = newRouteToken()
    const hash = tokenHash(token)
    this.db.prepare('INSERT INTO inbound_routes (token_hash, user_id, project_id, finding_id, generation, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(hash, tenantId, projectId, findingId, generation, this.now())
    return { token, hash }
  }

  routeByToken(token: string): RouteRow | undefined {
    return this.db.prepare('SELECT * FROM inbound_routes WHERE token_hash = ?').get(tokenHash(token)) as RouteRow | undefined
  }

  listRoutes(tenantId: string, projectId: string, findingId: string) {
    const rows = this.db.prepare('SELECT * FROM inbound_routes WHERE user_id = ? AND project_id = ? AND finding_id = ? ORDER BY created_at DESC').all(tenantId, projectId, findingId) as unknown as RouteRow[]
    return rows.map((r) => ({ routeId: routeHandle(r.token_hash), generation: r.generation, createdAt: r.created_at, revokedAt: r.revoked_at }))
  }

  /** Revokes one route (by handle) or every live route of the case. Only ever the tenant's own. */
  revokeRoutes(tenantId: string, projectId: string, findingId: string, routeId?: string): number {
    const res = this.db.prepare(`UPDATE inbound_routes SET revoked_at = ? WHERE user_id = ? AND project_id = ? AND finding_id = ? AND revoked_at IS NULL AND (? IS NULL OR substr(token_hash, 1, 16) = ?)`)
      .run(this.now(), tenantId, projectId, findingId, routeId ?? null, routeId ?? null)
    return Number(res.changes)
  }

  // ---------- webhook replay protection ----------

  /** True when this exact signature was already accepted (a replay). Records it otherwise. */
  seenBefore(signature: string): boolean {
    const at = this.now()
    this.db.prepare('DELETE FROM inbound_webhook_seen WHERE seen_at < ?').run(at - SEEN_TTL_MS)
    const res = this.db.prepare('INSERT OR IGNORE INTO inbound_webhook_seen (signature_hash, seen_at) VALUES (?, ?)').run(sha256(`sig:${signature}`), at)
    return Number(res.changes) === 0
  }

  // ---------- messages ----------

  hasMessage(provider: string, providerMessageId: string): boolean {
    return this.db.prepare('SELECT 1 FROM inbound_messages WHERE provider = ? AND provider_message_id = ?').get(provider, providerMessageId) !== undefined
  }

  /** A message no route resolves: kept as a count and a reason only, with no content and no tenant. */
  insertUnrouted(provider: string, providerMessageId: string, reasons: string[], auth: Authentication): string {
    const id = randomUUID()
    this.db.prepare(`INSERT INTO inbound_messages (id, provider, provider_message_id, status, reasons, authentication, received_at) VALUES (?, ?, ?, 'quarantined', ?, ?, ?)`)
      .run(id, provider, providerMessageId, JSON.stringify(reasons), JSON.stringify(auth), this.now())
    return id
  }

  insert(input: { tenantId: string; projectId: string; findingId: string; generation: number | null; provider: string; providerMessageId: string; status: MessageStatus; reasons: string[]; auth: Authentication; routeHash: string; content: (id: string) => MessageContent; receivedAt: number }): string {
    const id = randomUUID()
    this.db.prepare(`INSERT INTO inbound_messages (id, user_id, project_id, finding_id, generation, provider, provider_message_id, status, reasons, content_sealed, authentication, received_at, route_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.tenantId, input.projectId, input.findingId, input.generation, input.provider, input.providerMessageId, input.status, JSON.stringify(input.reasons),
        this.sealer.seal(this.context(input.tenantId, id), input.content(id)), JSON.stringify(input.auth), input.receivedAt, input.routeHash)
    return id
  }

  setProposal(tenantId: string, id: string, proposalId: string | null, code: string | null): void {
    this.db.prepare('UPDATE inbound_messages SET proposal_id = ?, proposal_code = ? WHERE user_id = ? AND id = ?').run(proposalId, code, tenantId, id)
  }

  private view(tenantId: string, row: MessageRow): MessageView {
    const content = row.content_sealed ? this.sealer.open<MessageContent>(this.context(tenantId, row.id), row.content_sealed) : { from: null, fromName: '', subject: '', text: '', reply: '', attachments: [], classification: null }
    return {
      id: row.id, projectId: row.project_id ?? '', findingId: row.finding_id ?? '', generation: row.generation, provider: row.provider, status: row.status,
      reasons: JSON.parse(row.reasons) as string[], authentication: JSON.parse(row.authentication) as Authentication, receivedAt: row.received_at,
      proposalId: row.proposal_id, proposalCode: row.proposal_code, ...content,
    }
  }

  get(tenantId: string, id: string): MessageView | null {
    const row = this.db.prepare('SELECT * FROM inbound_messages WHERE user_id = ? AND id = ?').get(tenantId, id) as MessageRow | undefined
    return row ? this.view(tenantId, row) : null
  }

  list(tenantId: string, filter: { projectId?: string; findingId?: string } = {}): MessageView[] {
    const rows = this.db.prepare(`SELECT * FROM inbound_messages WHERE user_id = ? AND (? IS NULL OR project_id = ?) AND (? IS NULL OR finding_id = ?) ORDER BY received_at DESC LIMIT 200`)
      .all(tenantId, filter.projectId ?? null, filter.projectId ?? null, filter.findingId ?? null, filter.findingId ?? null) as unknown as MessageRow[]
    return rows.map((r) => this.view(tenantId, r))
  }
}
