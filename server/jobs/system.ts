/**
 * The job system for one database: the shared runner, the recovery handlers
 * and the notification store, wired together.
 *
 * Sid (sync/scan) and Aditya (analytics) add their own kinds with
 * `jobSystemFor(db).register('ledger.sync', { payloadSchema, handler, ... })`
 * from their own modules, and enqueue with `enqueue(tenantId, kind, payload,
 * { idempotencyKey, runAt })`. Handlers receive a read-and-propose-only
 * tenant context; see runner.ts for the contract.
 *
 * Nothing runs until something calls `runDue` or `tick`: there is no
 * scheduler in the app. A deployment that wants one calls
 * `startScheduler((now) => system.tick(now, workerId))` (J3-jobs.md).
 */
import type { DatabaseSync } from 'node:sqlite'
import type { ApprovalService } from '../approvals.ts'
import type { ProjectStore } from '../projectStore.ts'
import { planDailyScans, planDigests, registerRecoveryJobs } from './handlers.ts'
import { NotificationStore, type DigestTransport } from './notifications.ts'
import { JobRunner, type JobDefinition, type RunResult } from './runner.ts'

export interface JobSystemDeps {
  db: DatabaseSync
  projects: Pick<ProjectStore, 'list' | 'get'>
  approvals: ApprovalService
}

export interface JobSystem {
  runner: JobRunner
  notifications: NotificationStore
  /** For other workstreams' handlers. */
  register<P>(kind: string, def: JobDefinition<P>): void
  enqueue: JobRunner['enqueue']
  runDue(now: number, owner: string, options?: { limit?: number }): Promise<RunResult[]>
  /** Plans the daily scans and due digests, then runs what is due. */
  tick(now: number, owner: string): Promise<RunResult[]>
  /** Where digests go. Unset: none are delivered. Only a recording transport exists today. */
  setDigestTransport(transport: DigestTransport | null): void
}

const systems = new WeakMap<DatabaseSync, JobSystem>()

export function createJobSystem(deps: JobSystemDeps, options: { digestTransport?: DigestTransport | null } = {}): JobSystem {
  const runner = new JobRunner(deps.db)
  const notifications = new NotificationStore(deps.db)
  let transport = options.digestTransport ?? null
  registerRecoveryJobs(runner, { db: deps.db, projects: deps.projects, approvals: deps.approvals, notifications, digestTransport: () => transport })
  const system: JobSystem = {
    runner,
    notifications,
    register: (kind, def) => runner.register(kind, def),
    enqueue: (tenantId, kind, payload, opts) => runner.enqueue(tenantId, kind, payload, opts),
    runDue: (now, owner, opts) => runner.runDue(now, owner, opts),
    async tick(now, owner) {
      planDailyScans(runner, deps.db, now)
      planDigests(runner, notifications, now)
      return runner.runDue(now, owner)
    },
    setDigestTransport(t) {
      transport = t
    },
  }
  systems.set(deps.db, system)
  return system
}

/** The job system the app built for this database (tests, workers, other workstreams). */
export function jobSystemFor(db: DatabaseSync): JobSystem | null {
  return systems.get(db) ?? null
}
