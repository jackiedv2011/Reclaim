/**
 * Durable background jobs (workstream J3): one shared, SQLite-backed queue.
 *
 * Every background task in Reclaim (recovery scans, reminders, follow-up
 * preparation, digests, and later Sid's sync/scan and Aditya's analytics)
 * registers a kind here and is run through `runDue`. The queue is a single
 * writer: every state change happens inside `BEGIN IMMEDIATE`, so two
 * workers on the same database file can never claim the same job.
 *
 * Guarantees:
 * - Enqueue is idempotent per (tenant, kind, idempotency key): a planner can
 *   run twice and never duplicates work.
 * - At most one running job per tenant (also enforced by a partial unique
 *   index), so a tenant's jobs never race each other.
 * - A job is claimed with a lease. A worker that dies leaves a lease that
 *   expires; the next `runDue` puts the job back (or dead-letters it).
 * - Failures retry with bounded exponential backoff, then dead-letter.
 * - Handlers get an AbortSignal that fires on timeout or cancellation.
 * - Payloads are ids and references only, checked on the way in; errors are
 *   stored as short codes, never messages (a message could carry data).
 *
 * Jobs act through `systemContext(tenantId, kind)`: they may read and
 * propose, never approve. Whatever a job prepares waits for a person.
 *
 * Nothing here starts on its own: `startScheduler` is a helper for a
 * deployment to call; app.ts and index.ts do not.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { z } from 'zod'
import { HttpError } from '../http.ts'
import { systemContext, type TenantContext } from '../tenant.ts'

export const JOB_STATUSES = ['queued', 'leased', 'done', 'failed', 'cancelled', 'dead'] as const
export type JobStatus = typeof JOB_STATUSES[number]

/** Extra lease time past a job's own timeout before another worker may take it over. */
export const LEASE_GRACE_MS = 30_000
/** A handler may push its own run back this many times before the job is closed. */
export const MAX_DEFERS = 20
const MAX_PAYLOAD_BYTES = 4096

/**
 * A failure a handler reports on purpose. `code` is what gets stored: short,
 * lower-case, never data. `retryable: false` fails the job at once.
 */
export class JobError extends Error {
  readonly code: string
  readonly retryable: boolean
  constructor(code: string, options: { retryable?: boolean } = {}) {
    super(code)
    this.code = code
    this.retryable = options.retryable ?? true
  }
}

const CODE = /^[a-z][a-z0-9_.]{0,59}$/
/** Only fixed, data-free codes reach the database. */
export function safeCode(value: unknown, fallback = 'handler_error'): string {
  return typeof value === 'string' && CODE.test(value) ? value : fallback
}

function errorCode(err: unknown): { code: string; retryable: boolean } {
  if (err instanceof JobError) return { code: safeCode(err.code), retryable: err.retryable }
  if (err instanceof HttpError) {
    // 4xx from a service the handler called is about the request, not the moment: retrying won't help.
    return { code: safeCode(err.code, `http_${err.status}`), retryable: err.status >= 500 || err.status === 409 || err.status === 429 }
  }
  return { code: 'handler_error', retryable: true }
}

const REF = /^[\w:.-]{0,500}$/
/**
 * Payloads and checkpoints hold ids and references only: no names, emails,
 * amounts as text, sentences or tokens with odd characters. This is a guard,
 * not a proof: a payload schema should only have id-shaped fields.
 */
export function assertRefsOnly(value: unknown, what = 'payload'): void {
  const walk = (v: unknown, depth: number): void => {
    if (depth > 4) throw new JobError(`${what}_too_deep`, { retryable: false })
    if (v === null || typeof v === 'boolean') return
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new JobError(`${what}_not_refs`, { retryable: false })
      return
    }
    if (typeof v === 'string') {
      if (!REF.test(v)) throw new JobError(`${what}_not_refs`, { retryable: false })
      return
    }
    if (Array.isArray(v)) {
      if (v.length > 200) throw new JobError(`${what}_too_large`, { retryable: false })
      for (const item of v) walk(item, depth + 1)
      return
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>)
      if (entries.length > 30) throw new JobError(`${what}_too_large`, { retryable: false })
      for (const [k, item] of entries) {
        if (!/^\w{1,60}$/.test(k)) throw new JobError(`${what}_not_refs`, { retryable: false })
        walk(item, depth + 1)
      }
      return
    }
    throw new JobError(`${what}_not_refs`, { retryable: false })
  }
  walk(value, 0)
  if (Buffer.byteLength(JSON.stringify(value ?? null)) > MAX_PAYLOAD_BYTES) throw new JobError(`${what}_too_large`, { retryable: false })
}

export interface JobCheckpoint {
  get<T>(): T | null
  /** Saved at once, so a job that is interrupted resumes from here on its next attempt. */
  set(value: unknown): void
}

export interface JobContext<P> {
  jobId: string
  kind: string
  /** `systemContext(tenantId, kind)`: read and propose only. */
  tenant: TenantContext
  payload: P
  /** Aborted on timeout or cancellation. Pass it on to anything slow. */
  signal: AbortSignal
  /** 1 on the first try. */
  attempt: number
  /** The scheduler's clock for this run (tests drive it). */
  now: number
  checkpoint: JobCheckpoint
}

/**
 * What a handler returns. `code` is a short outcome code kept on the job
 * (`skipped_case_changed`, `proposed`); `deferUntil` puts the job back in
 * the queue until then without using up an attempt (at most MAX_DEFERS times).
 */
export type JobOutcome = void | { code?: string; deferUntil?: number }

export interface JobDefinition<P> {
  /** Checked on enqueue and again before every run. Id-shaped fields only. */
  payloadSchema: z.ZodType<P>
  /**
   * Must re-check at run time everything it relies on: permissions, the case
   * still existing at the version it was planned for, approvals, freshness.
   * The world may have changed since the job was queued.
   */
  handler(ctx: JobContext<P>): Promise<JobOutcome>
  /** Default 5. */
  maxAttempts?: number
  /** Default 30 s. */
  timeoutMs?: number
  /** Exponential: baseMs · 2^(attempt−1), at most maxMs. Default 1 min … 1 h. */
  backoff?: { baseMs: number; maxMs: number }
}

type Registered = { payloadSchema: z.ZodType<unknown>; handler: (ctx: JobContext<unknown>) => Promise<JobOutcome>; maxAttempts: number; timeoutMs: number; backoff: { baseMs: number; maxMs: number } }

type JobRow = {
  id: string; user_id: string; kind: string; payload: string; idempotency_key: string; run_at: number; status: JobStatus
  attempts: number; max_attempts: number; lease_owner: string | null; lease_until: number | null; checkpoint: string | null
  last_error_code: string | null; result_code: string | null; cancel_requested: number; defers: number; timeout_ms: number
  created_at: number; updated_at: number
}

export interface JobView {
  id: string; kind: string; status: JobStatus; attempts: number; maxAttempts: number; runAt: number
  lastErrorCode: string | null; resultCode: string | null; cancelRequested: boolean; createdAt: number; updatedAt: number
}

const view = (r: JobRow): JobView => ({
  id: r.id, kind: r.kind, status: r.status, attempts: r.attempts, maxAttempts: r.max_attempts, runAt: r.run_at,
  lastErrorCode: r.last_error_code, resultCode: r.result_code, cancelRequested: r.cancel_requested === 1, createdAt: r.created_at, updatedAt: r.updated_at,
})

export interface RunResult { id: string; kind: string; tenantId: string; status: JobStatus | 'lease_lost' | 'gone'; code: string | null }

export function migrateJobs(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      run_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'leased', 'done', 'failed', 'cancelled', 'dead')),
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL,
      lease_owner TEXT,
      lease_until INTEGER,
      checkpoint TEXT,
      last_error_code TEXT,
      result_code TEXT,
      cancel_requested INTEGER NOT NULL DEFAULT 0,
      defers INTEGER NOT NULL DEFAULT 0,
      timeout_ms INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (user_id, kind, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
    CREATE INDEX IF NOT EXISTS jobs_tenant ON jobs(user_id, created_at);
    -- At most one running job per tenant, whatever the workers do.
    CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_leased_per_tenant ON jobs(user_id) WHERE status = 'leased';
    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      event TEXT NOT NULL,
      code TEXT,
      attempt INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS job_events_job ON job_events(user_id, job_id, id);
    CREATE TRIGGER IF NOT EXISTS job_events_append_only BEFORE UPDATE ON job_events
      BEGIN SELECT RAISE(ABORT, 'job_events is append-only'); END;
  `)
}

export class JobRunner {
  private readonly db: DatabaseSync
  private readonly kinds = new Map<string, Registered>()
  /** Jobs running in this process, so `cancel` can abort them. */
  private readonly running = new Map<string, AbortController>()

  constructor(db: DatabaseSync) {
    this.db = db
    migrateJobs(db)
  }

  /**
   * Adds a kind of job. Kind names are `area.action` (`recovery.scan`,
   * `ledger.sync`, `analytics.rollup`). A runner only claims kinds it knows,
   * so two processes with different handlers can share one queue.
   */
  register<P>(kind: string, def: JobDefinition<P>): void {
    if (!/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*$/.test(kind) || kind.length > 60) throw new Error(`Bad job kind: ${kind}`)
    if (this.kinds.has(kind)) throw new Error(`Job kind already registered: ${kind}`)
    const maxAttempts = def.maxAttempts ?? 5
    const timeoutMs = def.timeoutMs ?? 30_000
    const backoff = def.backoff ?? { baseMs: 60_000, maxMs: 3_600_000 }
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 25) throw new Error('maxAttempts must be 1–25.')
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 15 * 60_000) throw new Error('timeoutMs must be 1 ms – 15 min.')
    if (!(backoff.baseMs >= 1 && backoff.maxMs >= backoff.baseMs)) throw new Error('Bad backoff.')
    this.kinds.set(kind, { payloadSchema: def.payloadSchema as z.ZodType<unknown>, handler: def.handler as Registered['handler'], maxAttempts, timeoutMs, backoff })
  }

  registered(): string[] {
    return [...this.kinds.keys()]
  }

  private tx<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private event(tenantId: string, jobId: string, at: number, event: string, code: string | null = null, attempt = 0): void {
    this.db.prepare('INSERT INTO job_events (user_id, job_id, at, event, code, attempt) VALUES (?, ?, ?, ?, ?, ?)').run(tenantId, jobId, at, event, code, attempt)
  }

  private row(tenantId: string, id: string): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE user_id = ? AND id = ?').get(tenantId, id) as JobRow | undefined
  }

  /**
   * Queues a job for a tenant. The same (tenant, kind, idempotency key)
   * returns the job already there, whatever state it is in: re-planning never
   * duplicates work. Put whatever makes the work distinct (a case
   * fingerprint, a local date) in the key.
   */
  enqueue(tenantId: string, kind: string, payload: unknown, options: { idempotencyKey?: string; runAt: number; now?: number }): { job: JobView; created: boolean } {
    const def = this.kinds.get(kind)
    if (!def) throw new JobError('unknown_kind', { retryable: false })
    const parsed = def.payloadSchema.safeParse(payload)
    if (!parsed.success) throw new JobError('invalid_payload', { retryable: false })
    assertRefsOnly(parsed.data)
    const key = options.idempotencyKey ?? randomUUID()
    if (!REF.test(key) || key.length === 0 || key.length > 300) throw new JobError('bad_idempotency_key', { retryable: false })
    if (!Number.isFinite(options.runAt)) throw new JobError('bad_run_at', { retryable: false })
    const now = options.now ?? options.runAt
    return this.tx(() => {
      if (!this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(tenantId)) throw new JobError('unknown_tenant', { retryable: false })
      const id = randomUUID()
      const res = this.db.prepare(`INSERT INTO jobs (id, user_id, kind, payload, idempotency_key, run_at, status, max_attempts, timeout_ms, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?) ON CONFLICT (user_id, kind, idempotency_key) DO NOTHING`)
        .run(id, tenantId, kind, JSON.stringify(parsed.data), key, options.runAt, def.maxAttempts, def.timeoutMs, now, now)
      if (Number(res.changes) === 1) {
        this.event(tenantId, id, now, 'enqueued')
        return { job: view(this.row(tenantId, id)!), created: true }
      }
      const existing = this.db.prepare('SELECT * FROM jobs WHERE user_id = ? AND kind = ? AND idempotency_key = ?').get(tenantId, kind, key) as JobRow
      return { job: view(existing), created: false }
    })
  }

  get(tenantId: string, id: string): JobView | null {
    const r = this.row(tenantId, id)
    return r ? view(r) : null
  }

  list(tenantId: string, options: { status?: JobStatus; limit?: number } = {}): JobView[] {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500)
    const rows = this.db.prepare('SELECT * FROM jobs WHERE user_id = ? AND (? IS NULL OR status = ?) ORDER BY created_at DESC, id LIMIT ?')
      .all(tenantId, options.status ?? null, options.status ?? null, limit) as JobRow[]
    return rows.map(view)
  }

  events(tenantId: string, id: string): Array<{ at: number; event: string; code: string | null; attempt: number }> {
    return this.db.prepare('SELECT at, event, code, attempt FROM job_events WHERE user_id = ? AND job_id = ? ORDER BY id').all(tenantId, id) as Array<{ at: number; event: string; code: string | null; attempt: number }>
  }

  /**
   * Cancels a tenant's job. A queued job is cancelled at once; a running one
   * is asked to stop (its signal is aborted if it runs in this process) and
   * ends `cancelled` whatever it returns. Finished jobs are left alone.
   * Null when the job is not this tenant's.
   */
  cancel(tenantId: string, id: string, now: number): JobView | null {
    const out = this.tx(() => {
      const r = this.row(tenantId, id)
      if (!r) return null
      if (r.status === 'queued') {
        this.db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'queued'").run(now, id)
        this.event(tenantId, id, now, 'cancelled', null, r.attempts)
      } else if (r.status === 'leased' && r.cancel_requested === 0) {
        this.db.prepare('UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(now, id)
        this.event(tenantId, id, now, 'cancel_requested', null, r.attempts)
      }
      return view(this.row(tenantId, id)!)
    })
    if (out?.status === 'leased') this.running.get(id)?.abort(new JobError('cancelled', { retryable: false }))
    return out
  }

  getCheckpoint<T>(tenantId: string, id: string): T | null {
    const r = this.row(tenantId, id)
    return r?.checkpoint ? (JSON.parse(r.checkpoint) as T) : null
  }

  /** Only the worker holding the lease may move a running job's checkpoint. */
  setCheckpoint(tenantId: string, id: string, value: unknown, leaseOwner: string | null = null, now = Date.now()): boolean {
    assertRefsOnly(value, 'checkpoint')
    const res = this.db.prepare("UPDATE jobs SET checkpoint = ?, updated_at = ? WHERE user_id = ? AND id = ? AND (? IS NULL OR (status = 'leased' AND lease_owner = ?))")
      .run(JSON.stringify(value), now, tenantId, id, leaseOwner, leaseOwner)
    return Number(res.changes) === 1
  }

  /**
   * Jobs whose worker vanished: the lease ran out. Back in the queue with
   * backoff, or dead-lettered when out of attempts.
   */
  recoverExpiredLeases(now: number): number {
    return this.tx(() => {
      const expired = this.db.prepare("SELECT * FROM jobs WHERE status = 'leased' AND lease_until <= ?").all(now) as JobRow[]
      for (const r of expired) {
        const def = this.kinds.get(r.kind)
        if (r.cancel_requested) {
          this.db.prepare("UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?").run(now, r.id)
          this.event(r.user_id, r.id, now, 'cancelled', 'lease_expired', r.attempts)
        } else if (r.attempts >= r.max_attempts) {
          this.db.prepare("UPDATE jobs SET status = 'dead', lease_owner = NULL, lease_until = NULL, last_error_code = 'lease_expired', updated_at = ? WHERE id = ?").run(now, r.id)
          this.event(r.user_id, r.id, now, 'dead_lettered', 'lease_expired', r.attempts)
        } else {
          const runAt = now + backoffMs(def?.backoff ?? { baseMs: 60_000, maxMs: 3_600_000 }, r.attempts)
          this.db.prepare("UPDATE jobs SET status = 'queued', lease_owner = NULL, lease_until = NULL, last_error_code = 'lease_expired', run_at = ?, updated_at = ? WHERE id = ?").run(runAt, now, r.id)
          this.event(r.user_id, r.id, now, 'lease_expired', 'lease_expired', r.attempts)
        }
      }
      return expired.length
    })
  }

  /** Claims the next due job this runner knows, skipping tenants that already have one running. */
  claim(now: number, owner: string): JobRow | null {
    const kinds = this.registered()
    if (!kinds.length) return null
    return this.tx(() => {
      const r = this.db.prepare(`SELECT * FROM jobs j WHERE j.status = 'queued' AND j.run_at <= ? AND j.kind IN (${kinds.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM jobs l WHERE l.user_id = j.user_id AND l.status = 'leased')
        ORDER BY j.run_at, j.created_at, j.id LIMIT 1`).get(now, ...kinds) as JobRow | undefined
      if (!r) return null
      const res = this.db.prepare("UPDATE jobs SET status = 'leased', lease_owner = ?, lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(owner, now + r.timeout_ms + LEASE_GRACE_MS, now, r.id)
      if (Number(res.changes) !== 1) return null
      this.event(r.user_id, r.id, now, 'claimed', null, r.attempts + 1)
      return this.row(r.user_id, r.id)!
    })
  }

  /**
   * Runs every due job (up to `limit`) one after another, after taking back
   * expired leases. Several workers may call this on the same database at
   * once; leases keep them apart. `now` is the scheduler's clock.
   */
  async runDue(now: number, owner: string, options: { limit?: number } = {}): Promise<RunResult[]> {
    if (!/^[\w:.-]{1,100}$/.test(owner)) throw new Error('Bad lease owner.')
    const limit = options.limit ?? 100
    this.recoverExpiredLeases(now)
    const results: RunResult[] = []
    while (results.length < limit) {
      const job = this.claim(now, owner)
      if (!job) break
      results.push(await this.execute(job, now, owner))
    }
    return results
  }

  private async execute(job: JobRow, now: number, owner: string): Promise<RunResult> {
    const def = this.kinds.get(job.kind)!
    const controller = new AbortController()
    this.running.set(job.id, controller)
    let timer: NodeJS.Timeout | undefined
    let outcome: JobOutcome
    let failure: { code: string; retryable: boolean } | null = null
    try {
      const parsed = def.payloadSchema.safeParse(JSON.parse(job.payload))
      if (!parsed.success) throw new JobError('invalid_payload', { retryable: false })
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason instanceof JobError ? controller.signal.reason : new JobError('aborted')), { once: true })
      })
      aborted.catch(() => {})
      timer = setTimeout(() => controller.abort(new JobError('timeout')), job.timeout_ms)
      const ctx: JobContext<unknown> = {
        jobId: job.id, kind: job.kind, tenant: systemContext(job.user_id, job.kind), payload: parsed.data, signal: controller.signal,
        attempt: job.attempts, now,
        checkpoint: {
          get: <T>() => this.getCheckpoint<T>(job.user_id, job.id),
          set: (value) => {
            if (!this.setCheckpoint(job.user_id, job.id, value, owner, now)) throw new JobError('lease_lost', { retryable: false })
          },
        },
      }
      if (job.cancel_requested) throw new JobError('cancelled', { retryable: false })
      outcome = await Promise.race([def.handler(ctx), aborted])
    } catch (err) {
      failure = errorCode(err)
    } finally {
      clearTimeout(timer)
      this.running.delete(job.id)
    }

    return this.tx(() => {
      const r = this.row(job.user_id, job.id)
      // The account was deleted while the job ran: nothing left to record.
      if (!r) return { id: job.id, kind: job.kind, tenantId: job.user_id, status: 'gone' as const, code: null }
      if (r.status !== 'leased' || r.lease_owner !== owner) {
        this.event(r.user_id, r.id, now, 'lease_lost', null, job.attempts)
        return { id: r.id, kind: r.kind, tenantId: r.user_id, status: 'lease_lost' as const, code: null }
      }
      const finish = (status: JobStatus, fields: { runAt?: number; error?: string | null; result?: string | null; defers?: number; attempts?: number }, event: string, code: string | null) => {
        this.db.prepare(`UPDATE jobs SET status = ?, lease_owner = NULL, lease_until = NULL, run_at = ?, last_error_code = ?, result_code = ?, defers = ?, attempts = ?, updated_at = ? WHERE id = ?`)
          .run(status, fields.runAt ?? r.run_at, fields.error === undefined ? r.last_error_code : fields.error, fields.result === undefined ? r.result_code : fields.result, fields.defers ?? r.defers, fields.attempts ?? r.attempts, now, r.id)
        this.event(r.user_id, r.id, now, event, code, r.attempts)
        return { id: r.id, kind: r.kind, tenantId: r.user_id, status, code }
      }
      if (r.cancel_requested) return finish('cancelled', {}, 'cancelled', failure?.code ?? null)
      if (failure) {
        if (failure.retryable && r.attempts < r.max_attempts) {
          return finish('queued', { runAt: now + backoffMs(def.backoff, r.attempts), error: failure.code }, 'retry_scheduled', failure.code)
        }
        return failure.retryable
          ? finish('dead', { error: failure.code }, 'dead_lettered', failure.code)
          : finish('failed', { error: failure.code }, 'failed', failure.code)
      }
      const result = outcome && typeof outcome === 'object' ? outcome : {}
      const code = result.code === undefined ? null : safeCode(result.code, 'done')
      if (result.deferUntil !== undefined) {
        if (r.defers >= MAX_DEFERS) return finish('done', { result: 'defer_limit' }, 'succeeded', 'defer_limit')
        // A deferral is not a failed attempt, and never earlier than a minute from now.
        const runAt = Number.isFinite(result.deferUntil) ? Math.max(result.deferUntil, now + 60_000) : now + 60_000
        return finish('queued', { runAt, result: code, defers: r.defers + 1, attempts: r.attempts - 1 }, 'deferred', code)
      }
      return finish('done', { result: code, error: null }, 'succeeded', code)
    })
  }
}

export function backoffMs(backoff: { baseMs: number; maxMs: number }, attempt: number): number {
  return Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.max(0, attempt - 1))
}

/**
 * A ticking loop for a deployment that wants one: calls `tick` every
 * `intervalMs`, never two at once, and never keeps the process alive on its
 * own. Not started anywhere in the app; a deployment decides (see
 * docs/workstream-recovery-ai/J3-jobs.md).
 */
export function startScheduler(tick: (now: number) => Promise<unknown>, options: { intervalMs?: number; clock?: () => number; onError?: (code: string) => void } = {}): { stop(): void } {
  const clock = options.clock ?? Date.now
  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    busy = true
    tick(clock())
      .catch((err) => options.onError?.(errorCode(err).code))
      .finally(() => { busy = false })
  }, options.intervalMs ?? 60_000)
  timer.unref()
  return { stop: () => clearInterval(timer) }
}
