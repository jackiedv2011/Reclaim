// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { openDatabase } from '../db.ts'
import { JobError, JobRunner, LEASE_GRACE_MS, MAX_DEFERS, startScheduler, type JobContext } from './runner.ts'

let db: DatabaseSync
let runner: JobRunner
const T0 = 1_800_000_000_000
const A = 'tenant-a'
const B = 'tenant-b'
const Payload = z.object({ ref: z.string() }).strict()

beforeEach(() => {
  db = openDatabase(':memory:')
  for (const id of [A, B]) db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, 1)').run(id, `${id}@example.test`)
  runner = new JobRunner(db)
})
afterEach(() => db.close())

const count = (sql: string, ...args: Array<string | number>) => (db.prepare(sql).get(...args) as { n: number }).n
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

describe('enqueue', () => {
  it('is idempotent per tenant, kind and key', () => {
    runner.register('test.noop', { payloadSchema: Payload, handler: async () => {} })
    const first = runner.enqueue(A, 'test.noop', { ref: 'p1' }, { idempotencyKey: 'k1', runAt: T0 })
    const again = runner.enqueue(A, 'test.noop', { ref: 'p1' }, { idempotencyKey: 'k1', runAt: T0 + 5 })
    expect(first.created).toBe(true)
    expect(again).toEqual({ job: first.job, created: false })
    expect(runner.enqueue(B, 'test.noop', { ref: 'p1' }, { idempotencyKey: 'k1', runAt: T0 }).created).toBe(true)
    expect(runner.enqueue(A, 'test.noop', { ref: 'p1' }, { idempotencyKey: 'k2', runAt: T0 }).created).toBe(true)
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(3)
    expect(count("SELECT COUNT(*) AS n FROM job_events WHERE event = 'enqueued'")).toBe(3)
  })

  it('stays idempotent after the job finished', async () => {
    let runs = 0
    runner.register('test.once', { payloadSchema: Payload, handler: async () => { runs++ } })
    runner.enqueue(A, 'test.once', { ref: 'x' }, { idempotencyKey: 'only', runAt: T0 })
    await runner.runDue(T0, 'w1')
    expect(runner.enqueue(A, 'test.once', { ref: 'x' }, { idempotencyKey: 'only', runAt: T0 }).created).toBe(false)
    await runner.runDue(T0 + 1, 'w1')
    expect(runs).toBe(1)
  })

  it('refuses payloads that are not ids and references', () => {
    runner.register('test.loose', { payloadSchema: z.object({ ref: z.unknown() }), handler: async () => {} })
    const bad = (ref: unknown) => () => runner.enqueue(A, 'test.loose', { ref }, { runAt: T0 })
    expect(bad('ap@acme.example')).toThrow(JobError)
    expect(bad('Acme Supplies Ltd')).toThrow(/payload_not_refs/)
    expect(bad('$1,250.00')).toThrow(/payload_not_refs/)
    expect(bad('x'.repeat(600))).toThrow(/payload_not_refs/)
    expect(bad({ nested: { deeper: { again: { too: { deep: 1 } } } } })).toThrow(/payload_too_deep/)
    expect(() => runner.enqueue(A, 'test.nope', {}, { runAt: T0 })).toThrow(/unknown_kind/)
    expect(() => runner.enqueue('nobody', 'test.loose', { ref: 'ok' }, { runAt: T0 })).toThrow(/unknown_tenant/)
    expect(() => runner.enqueue(A, 'test.loose', { ref: 'ok' }, { runAt: T0, idempotencyKey: 'has space' })).toThrow(/bad_idempotency_key/)
    expect(count('SELECT COUNT(*) AS n FROM jobs')).toBe(0)
  })

  it('rejects bad registrations', () => {
    expect(() => runner.register('NoDot', { payloadSchema: Payload, handler: async () => {} })).toThrow()
    runner.register('test.dup', { payloadSchema: Payload, handler: async () => {} })
    expect(() => runner.register('test.dup', { payloadSchema: Payload, handler: async () => {} })).toThrow(/already/)
    expect(() => runner.register('test.zero', { payloadSchema: Payload, handler: async () => {}, maxAttempts: 0 })).toThrow()
  })
})

describe('claiming and leases', () => {
  it('two workers racing never run a job twice, and a tenant never has two jobs running', async () => {
    const running = new Map<string, number>()
    let maxPerTenant = 0
    const ran: string[] = []
    runner.register('test.slow', {
      payloadSchema: Payload,
      handler: async (ctx: JobContext<{ ref: string }>) => {
        const n = (running.get(ctx.tenant.tenantId) ?? 0) + 1
        running.set(ctx.tenant.tenantId, n)
        maxPerTenant = Math.max(maxPerTenant, n)
        await new Promise((r) => setTimeout(r, 5))
        ran.push(ctx.payload.ref)
        running.set(ctx.tenant.tenantId, n - 1)
      },
    })
    for (const ref of ['a1', 'a2', 'a3']) runner.enqueue(A, 'test.slow', { ref }, { runAt: T0 })
    for (const ref of ['b1', 'b2']) runner.enqueue(B, 'test.slow', { ref }, { runAt: T0 })
    const [w1, w2, w3] = await Promise.all([runner.runDue(T0, 'w1'), runner.runDue(T0, 'w2'), runner.runDue(T0, 'w3')])
    expect(ran.sort()).toEqual(['a1', 'a2', 'a3', 'b1', 'b2'])
    expect(maxPerTenant).toBe(1)
    expect([...w1, ...w2, ...w3].map((r) => r.status)).toEqual(Array(5).fill('done'))
    expect(count("SELECT COUNT(*) AS n FROM job_events WHERE event = 'claimed'")).toBe(5)
  })

  it('a second claim for the same tenant waits, and the database forbids two leases anyway', () => {
    runner.register('test.noop', { payloadSchema: Payload, handler: async () => {} })
    runner.enqueue(A, 'test.noop', { ref: '1' }, { runAt: T0 })
    const second = runner.enqueue(A, 'test.noop', { ref: '2' }, { runAt: T0 })
    expect(runner.claim(T0, 'w1')).not.toBeNull()
    expect(runner.claim(T0, 'w2')).toBeNull()
    expect(() => db.prepare("UPDATE jobs SET status = 'leased' WHERE id = ?").run(second.job.id)).toThrow(/UNIQUE/)
  })

  it('does not claim jobs before they are due or kinds it does not know', async () => {
    runner.register('test.noop', { payloadSchema: Payload, handler: async () => {} })
    runner.enqueue(A, 'test.noop', { ref: '1' }, { runAt: T0 + 1000 })
    db.prepare("INSERT INTO jobs (id, user_id, kind, payload, idempotency_key, run_at, status, max_attempts, timeout_ms, created_at, updated_at) VALUES ('other', ?, 'ledger.sync', '{}', 'k', ?, 'queued', 3, 1000, ?, ?)").run(B, T0, T0, T0)
    expect(await runner.runDue(T0, 'w1')).toEqual([])
    expect((await runner.runDue(T0 + 1000, 'w1')).length).toBe(1)
    expect(runner.get(B, 'other')!.status).toBe('queued')
  })

  it('takes back a job whose worker died once the lease runs out, then dead-letters it', async () => {
    let runs = 0
    runner.register('test.crashy', { payloadSchema: Payload, handler: async () => { runs++ }, timeoutMs: 1000, maxAttempts: 2, backoff: { baseMs: 10, maxMs: 10 } })
    const { job } = runner.enqueue(A, 'test.crashy', { ref: '1' }, { runAt: T0 })
    // Worker 1 claims and "crashes" (never finishes).
    expect(runner.claim(T0, 'w1')!.id).toBe(job.id)
    expect(await runner.runDue(T0 + 500, 'w2')).toEqual([])
    const expiry = T0 + 1000 + LEASE_GRACE_MS
    expect(await runner.runDue(expiry, 'w2')).toEqual([])
    expect(runner.get(A, job.id)).toMatchObject({ status: 'queued', attempts: 1, lastErrorCode: 'lease_expired', runAt: expiry + 10 })
    // Crash again on the second (last) attempt: dead-lettered, not retried forever.
    expect(runner.claim(expiry + 10, 'w2')!.attempts).toBe(2)
    await runner.runDue(expiry + 10 + 1000 + LEASE_GRACE_MS, 'w3')
    expect(runner.get(A, job.id)).toMatchObject({ status: 'dead', lastErrorCode: 'lease_expired' })
    expect(runs).toBe(0)
    expect(runner.events(A, job.id).map((e) => e.event)).toEqual(['enqueued', 'claimed', 'lease_expired', 'claimed', 'dead_lettered'])
  })

  it('a worker that lost its lease does not overwrite the new owner', async () => {
    const gate = deferred()
    runner.register('test.held', { payloadSchema: Payload, handler: async () => { await gate.promise }, timeoutMs: 1000 })
    const { job } = runner.enqueue(A, 'test.held', { ref: '1' }, { runAt: T0 })
    const slow = runner.runDue(T0, 'w1')
    await new Promise((r) => setTimeout(r, 1))
    // w2 decides the lease has expired and reclaims it.
    runner.recoverExpiredLeases(T0 + 1000 + LEASE_GRACE_MS)
    db.prepare("UPDATE jobs SET status = 'leased', lease_owner = 'w2' WHERE id = ?").run(job.id)
    gate.resolve()
    expect((await slow)[0].status).toBe('lease_lost')
    expect(runner.get(A, job.id)!.status).toBe('leased')
  })
})

describe('failures', () => {
  it('retries with bounded exponential backoff, then dead-letters, storing only a code', async () => {
    runner.register('test.flaky', {
      payloadSchema: Payload, maxAttempts: 4, backoff: { baseMs: 1000, maxMs: 3000 },
      handler: async () => { throw new Error('Acme Supplies owes $1,250.00 to ap@acme.example') },
    })
    const { job } = runner.enqueue(A, 'test.flaky', { ref: '1' }, { runAt: T0 })
    await runner.runDue(T0, 'w')
    expect(runner.get(A, job.id)).toMatchObject({ status: 'queued', attempts: 1, runAt: T0 + 1000, lastErrorCode: 'handler_error' })
    expect(await runner.runDue(T0 + 999, 'w')).toEqual([])
    await runner.runDue(T0 + 1000, 'w')
    expect(runner.get(A, job.id)!.runAt).toBe(T0 + 1000 + 2000)
    await runner.runDue(T0 + 3000, 'w')
    expect(runner.get(A, job.id)!.runAt).toBe(T0 + 3000 + 3000) // capped at maxMs
    await runner.runDue(T0 + 6000, 'w')
    expect(runner.get(A, job.id)).toMatchObject({ status: 'dead', attempts: 4 })
    expect(await runner.runDue(T0 + 999_999, 'w')).toEqual([])
    const stored = JSON.stringify([db.prepare('SELECT * FROM jobs').all(), db.prepare('SELECT * FROM job_events').all()])
    expect(stored).not.toMatch(/Acme|1,250|@acme/)
  })

  it('a non-retryable error fails at once', async () => {
    runner.register('test.bad', { payloadSchema: Payload, handler: async () => { throw new JobError('case_gone', { retryable: false }) } })
    const { job } = runner.enqueue(A, 'test.bad', { ref: '1' }, { runAt: T0 })
    expect((await runner.runDue(T0, 'w'))[0]).toMatchObject({ status: 'failed', code: 'case_gone' })
    expect(runner.get(A, job.id)!.attempts).toBe(1)
  })

  it('times out a handler, aborting its signal', async () => {
    let sawAbort = false
    runner.register('test.hang', {
      payloadSchema: Payload, timeoutMs: 20, maxAttempts: 1,
      handler: async (ctx) => {
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => { sawAbort = true; resolve() }))
        await new Promise((r) => setTimeout(r, 50))
      },
    })
    const { job } = runner.enqueue(A, 'test.hang', { ref: '1' }, { runAt: T0 })
    const [result] = await runner.runDue(T0, 'w')
    expect(result).toMatchObject({ status: 'dead', code: 'timeout' })
    expect(sawAbort).toBe(true)
    expect(runner.get(A, job.id)!.lastErrorCode).toBe('timeout')
  })

  it('re-validates the payload at run time', async () => {
    runner.register('test.strict', { payloadSchema: Payload, handler: async () => {} })
    const { job } = runner.enqueue(A, 'test.strict', { ref: '1' }, { runAt: T0 })
    db.prepare("UPDATE jobs SET payload = '{\"other\":1}' WHERE id = ?").run(job.id)
    expect((await runner.runDue(T0, 'w'))[0]).toMatchObject({ status: 'failed', code: 'invalid_payload' })
  })
})

describe('cancel, checkpoint, defer', () => {
  it('cancels a queued job before it runs, and only for its own tenant', async () => {
    let runs = 0
    runner.register('test.noop', { payloadSchema: Payload, handler: async () => { runs++ } })
    const { job } = runner.enqueue(A, 'test.noop', { ref: '1' }, { runAt: T0 })
    expect(runner.cancel(B, job.id, T0)).toBeNull()
    expect(runner.cancel(A, job.id, T0)!.status).toBe('cancelled')
    await runner.runDue(T0, 'w')
    expect(runs).toBe(0)
  })

  it('cancels a running job through its signal', async () => {
    let sawAbort = false
    const started = deferred()
    runner.register('test.long', {
      payloadSchema: Payload, timeoutMs: 5000,
      handler: async (ctx) => {
        started.resolve()
        await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => { sawAbort = true; resolve() }))
      },
    })
    const { job } = runner.enqueue(A, 'test.long', { ref: '1' }, { runAt: T0 })
    const run = runner.runDue(T0, 'w')
    await started.promise
    expect(runner.cancel(A, job.id, T0)).toMatchObject({ status: 'leased', cancelRequested: true })
    expect((await run)[0].status).toBe('cancelled')
    expect(sawAbort).toBe(true)
    expect(runner.events(A, job.id).map((e) => e.event)).toEqual(['enqueued', 'claimed', 'cancel_requested', 'cancelled'])
  })

  it('a checkpoint survives a failed attempt', async () => {
    const seen: unknown[] = []
    runner.register('test.steps', {
      payloadSchema: Payload, backoff: { baseMs: 1, maxMs: 1 },
      handler: async (ctx) => {
        seen.push(ctx.checkpoint.get())
        ctx.checkpoint.set({ done: ['p1'] })
        if (ctx.attempt === 1) throw new JobError('crashed_midway')
      },
    })
    const { job } = runner.enqueue(A, 'test.steps', { ref: '1' }, { runAt: T0 })
    await runner.runDue(T0, 'w')
    await runner.runDue(T0 + 1, 'w')
    expect(seen).toEqual([null, { done: ['p1'] }])
    expect(runner.get(A, job.id)!.status).toBe('done')
    expect(() => runner.setCheckpoint(A, job.id, { note: 'Acme owes money' })).toThrow(/checkpoint_not_refs/)
  })

  it('a deferral does not use up an attempt, and is bounded', async () => {
    runner.register('test.later', { payloadSchema: Payload, maxAttempts: 1, handler: async (ctx) => ({ code: 'not_yet', deferUntil: ctx.now + 3_600_000 }) })
    const { job } = runner.enqueue(A, 'test.later', { ref: '1' }, { runAt: T0 })
    await runner.runDue(T0, 'w')
    expect(runner.get(A, job.id)).toMatchObject({ status: 'queued', attempts: 0, runAt: T0 + 3_600_000, resultCode: 'not_yet' })
    let t = T0
    for (let i = 0; i < MAX_DEFERS; i++) await runner.runDue((t += 3_600_000), 'w')
    expect(runner.get(A, job.id)).toMatchObject({ status: 'done', resultCode: 'defer_limit' })
  })

  it('job events are append-only', () => {
    runner.register('test.noop', { payloadSchema: Payload, handler: async () => {} })
    runner.enqueue(A, 'test.noop', { ref: '1' }, { runAt: T0 })
    expect(() => db.prepare("UPDATE job_events SET event = 'x'").run()).toThrow(/append-only/)
  })
})

describe('startScheduler', () => {
  it('ticks without overlapping and stops', async () => {
    let ticks = 0
    let concurrent = 0
    let maxConcurrent = 0
    const s = startScheduler(async () => {
      ticks++
      maxConcurrent = Math.max(maxConcurrent, ++concurrent)
      await new Promise((r) => setTimeout(r, 15))
      concurrent--
    }, { intervalMs: 2 })
    await new Promise((r) => setTimeout(r, 60))
    s.stop()
    const after = ticks
    await new Promise((r) => setTimeout(r, 20))
    expect(after).toBeGreaterThan(0)
    expect(ticks).toBe(after)
    expect(maxConcurrent).toBe(1)
  })
})
