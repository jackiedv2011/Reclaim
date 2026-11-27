/**
 * Internal notifications and the opt-in daily digest (J3).
 *
 * A notification says only that something needs a look, and where: a kind,
 * the project and case ids, when it is due, and counts. Never a supplier
 * name, an amount, an email address or any email text: those stay in the
 * sealed audit, and the app shows them after sign-in.
 *
 * The digest is off by default. When on, it is sent once per local day at
 * the hour the person chose, in their own time zone, through a
 * `DigestTransport`. Only a recording transport exists here: no real email.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { assertRefsOnly } from './runner.ts'

export const NOTIFICATION_KINDS = [
  /** A follow-up is due on a sent request with no reply. */
  'follow_up_due',
  /** A job prepared a follow-up; it waits in the approval queue. */
  'follow_up_prepared',
  /** A confirmed case waits for the customer's approval before anything goes out. */
  'awaiting_approval',
  /** A proposal waits in the approval queue. */
  'proposal_pending',
  /** The supplier's reply needs a person (dispute, documents, wrong contact…). */
  'vendor_reply',
  /** Money came back (or should have) and isn't reconciled in the books. */
  'unreconciled_return',
  /** A recovery case is missing evidence the gate needs. */
  'evidence_gap',
] as const
export type NotificationKind = typeof NOTIFICATION_KINDS[number]

export interface NotificationInput {
  dedupeKey: string
  kind: NotificationKind
  projectId: string | null
  findingId: string | null
  /** A proposal id, when it is about one. */
  refId?: string | null
  /** Counts only (how many checks are missing…). */
  detail?: Record<string, number>
  dueAt: number | null
}

export interface NotificationView {
  id: string; kind: NotificationKind; projectId: string | null; findingId: string | null; refId: string | null
  detail: Record<string, number>; dueAt: number | null; createdAt: number; readAt: number | null
  /** Where in the app to look (relative). */
  link: string
}

export interface NotificationPreferences {
  /** Off until the person turns it on. */
  digestEnabled: boolean
  /** IANA name, e.g. America/New_York. */
  timeZone: string
  /** 0–23, local time. */
  localHour: number
  lastDigestOn: string | null
}
export const DEFAULT_PREFERENCES: NotificationPreferences = { digestEnabled: false, timeZone: 'UTC', localHour: 8, lastDigestOn: null }

export interface Digest {
  /** The local date it covers, YYYY-MM-DD in the person's zone. */
  localDate: string
  timeZone: string
  total: number
  items: Array<{ kind: NotificationKind; count: number; links: string[] }>
}

/**
 * Delivers a digest. Gets the tenant id, never an address: the transport
 * looks the recipient up itself, so no address passes through a job. Sends
 * are at-least-once; `idempotencyKey` lets a real transport drop a repeat.
 */
export interface DigestTransport {
  send(input: { tenantId: string; digest: Digest; idempotencyKey: string }, signal: AbortSignal): Promise<{ receiptId: string }>
}

/** For tests and local development: keeps what it was asked to send. Sends nothing. */
export class RecordingDigestTransport implements DigestTransport {
  readonly sent: Array<{ tenantId: string; digest: Digest; idempotencyKey: string }> = []
  failures = 0
  async send(input: { tenantId: string; digest: Digest; idempotencyKey: string }): Promise<{ receiptId: string }> {
    if (this.failures > 0) {
      this.failures--
      throw new Error('recording transport: simulated failure')
    }
    this.sent.push(structuredClone(input))
    return { receiptId: `recorded-${this.sent.length}` }
  }
}

export function migrateNotifications(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      dedupe_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      project_id TEXT,
      finding_id TEXT,
      ref_id TEXT,
      detail TEXT NOT NULL DEFAULT '{}',
      due_at INTEGER,
      created_at INTEGER NOT NULL,
      read_at INTEGER,
      UNIQUE (user_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS notifications_inbox ON notifications(user_id, read_at, created_at);
    CREATE TABLE IF NOT EXISTS notification_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      digest_enabled INTEGER NOT NULL DEFAULT 0,
      time_zone TEXT NOT NULL DEFAULT 'UTC',
      local_hour INTEGER NOT NULL DEFAULT 8 CHECK (local_hour BETWEEN 0 AND 23),
      last_digest_on TEXT,
      updated_at INTEGER NOT NULL
    );
  `)
}

export function isTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length > 64 || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The local calendar date and hour at `at` in `timeZone`. */
export function localParts(at: number, timeZone: string): { date: string; hour: number } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).map((p) => [p.type, p.value]))
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
}

/** The case page (useAuditRoute: ?project=&case=). */
const caseLink = (projectId: string | null, findingId: string | null) =>
  projectId ? `/audit?project=${encodeURIComponent(projectId)}${findingId ? `&case=${encodeURIComponent(findingId)}` : ''}` : '/audit'

type Row = { id: string; user_id: string; dedupe_key: string; kind: NotificationKind; project_id: string | null; finding_id: string | null; ref_id: string | null; detail: string; due_at: number | null; created_at: number; read_at: number | null }
type PrefRow = { user_id: string; digest_enabled: number; time_zone: string; local_hour: number; last_digest_on: string | null }

const view = (r: Row): NotificationView => ({
  id: r.id, kind: r.kind, projectId: r.project_id, findingId: r.finding_id, refId: r.ref_id, detail: JSON.parse(r.detail) as Record<string, number>,
  dueAt: r.due_at, createdAt: r.created_at, readAt: r.read_at, link: caseLink(r.project_id, r.finding_id),
})

export class NotificationStore {
  private readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    migrateNotifications(db)
  }

  /** Adds a notification once per dedupe key. True when it is new. */
  add(tenantId: string, n: NotificationInput, now: number): boolean {
    if (!NOTIFICATION_KINDS.includes(n.kind)) throw new Error('Unknown notification kind.')
    const detail = n.detail ?? {}
    if (!Object.values(detail).every((v) => Number.isSafeInteger(v) && v >= 0)) throw new Error('Notification detail holds counts only.')
    assertRefsOnly({ key: n.dedupeKey, projectId: n.projectId, findingId: n.findingId, refId: n.refId ?? null, detail }, 'notification')
    const res = this.db.prepare(`INSERT INTO notifications (id, user_id, dedupe_key, kind, project_id, finding_id, ref_id, detail, due_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, dedupe_key) DO NOTHING`)
      .run(randomUUID(), tenantId, n.dedupeKey, n.kind, n.projectId, n.findingId, n.refId ?? null, JSON.stringify(detail), n.dueAt, now)
    return Number(res.changes) === 1
  }

  list(tenantId: string, options: { unreadOnly?: boolean; limit?: number } = {}): NotificationView[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200)
    const rows = this.db.prepare(`SELECT * FROM notifications WHERE user_id = ? AND (? = 0 OR read_at IS NULL) ORDER BY created_at DESC, id LIMIT ?`)
      .all(tenantId, options.unreadOnly ? 1 : 0, limit) as Row[]
    return rows.map(view)
  }

  unreadCount(tenantId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL').get(tenantId) as { n: number }).n
  }

  markRead(tenantId: string, id: string, now: number): NotificationView | null {
    this.db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE user_id = ? AND id = ?').run(now, tenantId, id)
    const row = this.db.prepare('SELECT * FROM notifications WHERE user_id = ? AND id = ?').get(tenantId, id) as Row | undefined
    return row ? view(row) : null
  }

  preferences(tenantId: string): NotificationPreferences {
    const r = this.db.prepare('SELECT * FROM notification_preferences WHERE user_id = ?').get(tenantId) as PrefRow | undefined
    return r ? { digestEnabled: r.digest_enabled === 1, timeZone: r.time_zone, localHour: r.local_hour, lastDigestOn: r.last_digest_on } : { ...DEFAULT_PREFERENCES }
  }

  setPreferences(tenantId: string, input: { digestEnabled: boolean; timeZone: string; localHour: number }, now: number): NotificationPreferences {
    if (!isTimeZone(input.timeZone)) throw new Error('Unknown time zone.')
    if (!Number.isInteger(input.localHour) || input.localHour < 0 || input.localHour > 23) throw new Error('Hour must be 0–23.')
    this.db.prepare(`INSERT INTO notification_preferences (user_id, digest_enabled, time_zone, local_hour, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET digest_enabled = excluded.digest_enabled, time_zone = excluded.time_zone, local_hour = excluded.local_hour, updated_at = excluded.updated_at`)
      .run(tenantId, input.digestEnabled ? 1 : 0, input.timeZone, input.localHour, now)
    return this.preferences(tenantId)
  }

  markDigestSent(tenantId: string, localDate: string, now: number): void {
    this.db.prepare('UPDATE notification_preferences SET last_digest_on = ?, updated_at = ? WHERE user_id = ?').run(localDate, now, tenantId)
  }

  /** Tenants who opted in, for the digest planner. */
  digestSubscribers(): Array<{ tenantId: string } & NotificationPreferences> {
    return (this.db.prepare('SELECT * FROM notification_preferences WHERE digest_enabled = 1').all() as PrefRow[])
      .map((r) => ({ tenantId: r.user_id, digestEnabled: true, timeZone: r.time_zone, localHour: r.local_hour, lastDigestOn: r.last_digest_on }))
  }

  /** Counts and links of unread notifications already due at `now`. Nothing else. */
  digest(tenantId: string, now: number, localDate: string, timeZone: string): Digest {
    const rows = this.db.prepare('SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL AND (due_at IS NULL OR due_at <= ?) ORDER BY created_at').all(tenantId, now) as Row[]
    const items = NOTIFICATION_KINDS.map((kind) => {
      const mine = rows.filter((r) => r.kind === kind)
      return { kind, count: mine.length, links: [...new Set(mine.map((r) => caseLink(r.project_id, r.finding_id)))].slice(0, 10) }
    }).filter((i) => i.count > 0)
    return { localDate, timeZone, total: rows.length, items }
  }
}
