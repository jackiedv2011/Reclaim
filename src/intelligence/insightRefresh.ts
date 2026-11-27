/**
 * Insight refresh as a job handler (CPO workstream P3), for the recovery
 * workstream's shared job runner (interface request J-4).
 *
 * This is NOT a scheduler and NOT a background service. It defines the
 * handler interface the CPO layer proposes to Jagan's runner, one handler
 * (`refreshInsightsHandler`), a per-tenant snapshot cache with freshness
 * rules, and a manual refresh entry point. `FixtureJobRunner` at the bottom
 * is a FIXTURE: it runs handlers one after another for tests, with no timers.
 *
 * Guarantees of the handler:
 *  - idempotent: the same idempotency key with the same input replays the
 *    stored outcome without doing the work again; the same key with a
 *    different input fails with `idempotency_conflict`;
 *  - tenant-scoped: the context is built from the job's tenant, never from
 *    the input; a loader that hands back another tenant's data is refused;
 *  - read-only: it reads ports and writes only the insight snapshot cache;
 *  - bounded: at most MAX_INSIGHT_LIMIT insights per snapshot;
 *  - safe logging: error messages are fixed strings with no amounts, vendor
 *    names or record details; audit events carry counts only;
 *  - retry: errors thrown by ports are retried up to `maxAttempts`, then
 *    fail; access and validation errors fail at once.
 *  - no AI: a background job never sends anything to an external model
 *    (no automatic external processing without founder/customer approval).
 *
 * Server-safe: relative `.ts` imports only.
 */
import type { Permission, ReadModelEnvelope, TenantContext } from './contracts.ts'
import { IntelligenceAccessError, requirePermission, requireTenant } from './envelope.ts'
import { IntelligenceQueryError, compareText } from './spend.ts'
import {
  INSIGHT_RULE_IDS,
  MAX_INSIGHT_LIMIT,
  fingerprintOf,
  generateInsightsSync,
  type InsightDeps,
  type InsightRule,
  type InsightsResult,
  type InsightStatus,
} from './insights.ts'

export const INSIGHT_REFRESH_OPERATION = 'insights.refresh'
/** Actor recorded for runner-initiated jobs. */
export const SYSTEM_ACTOR_ID = 'system:insight_refresh'
export const DEFAULT_MAX_ATTEMPTS = 3
export const DEFAULT_MAX_INSIGHTS = MAX_INSIGHT_LIMIT
/** A cached snapshot older than this is stale even when its inputs look unchanged (ages, due dates and expiry move with time). */
export const DEFAULT_SNAPSHOT_MAX_AGE_MS = 24 * 3_600_000
export const MAX_LEDGER_ENTRIES = 10_000
const TENANT_ID = /^[A-Za-z0-9_.:-]{1,128}$/
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,200}$/

/** What a runner-initiated job may read. Nothing that writes. */
export const INSIGHT_JOB_PERMISSIONS: readonly Permission[] = ['financial:read', 'cases:read', 'insights:refresh']

// ---------------------------------------------------------------- proposed runner interface (J-4)

export interface JobContext<I> {
  tenantId: string
  /** null for runner-initiated (system) jobs. */
  actorId: string | null
  operation: string
  idempotencyKey: string
  /** 1-based. */
  attempt: number
  /** What the previous attempt returned as `checkpoint`; null on the first attempt. */
  checkpoint: unknown | null
  now: number
  input: I
}

export type JobStatus = 'succeeded' | 'retry' | 'failed'

export type JobErrorCode =
  | 'invalid_job'
  | 'invalid_input'
  | 'tenant_mismatch'
  | 'tenant_not_found'
  | 'forbidden'
  | 'idempotency_conflict'
  | 'transient_failure'
  | 'retries_exhausted'

export interface JobError {
  code: JobErrorCode
  /** Fixed text per code. Never contains amounts, vendor names or record details. */
  message: string
}

export interface JobAuditEvent {
  operation: string
  tenantId: string
  idempotencyKey: string
  at: number
  outcome: JobStatus
  attempt: number
  /** True when the outcome was replayed from the idempotency ledger. */
  replayed: boolean
  errorCode: JobErrorCode | null
  /** Counts only. */
  counts: Record<string, number>
}

export interface JobOutcome<O> {
  status: JobStatus
  output?: O
  checkpoint?: unknown
  error?: JobError
  auditEvent: JobAuditEvent
}

export interface JobHandler<I, O> {
  readonly operation: string
  run(job: JobContext<I>): Promise<JobOutcome<O>>
}

const ERROR_MESSAGES: Readonly<Record<JobErrorCode, string>> = {
  invalid_job: 'The job envelope is malformed.',
  invalid_input: 'The job input is not valid for this operation.',
  tenant_mismatch: 'The job addressed data outside its tenant and was refused.',
  tenant_not_found: 'No data source exists for the job tenant.',
  forbidden: 'The job actor is not authorized for this operation.',
  idempotency_conflict: 'This idempotency key was already used with a different input.',
  transient_failure: 'A data source failed; the job can be retried.',
  retries_exhausted: 'A data source kept failing; the job stopped after its last attempt.',
}

function jobError(code: JobErrorCode): JobError {
  return { code, message: ERROR_MESSAGES[code] }
}

// ---------------------------------------------------------------- snapshot cache

/** A tenant's data sources, as the server loads them. `ai` is deliberately absent: background refresh never calls a model. */
export interface TenantInsightSources extends Omit<InsightDeps, 'ai'> {
  /** Saved audits the loader could not read (LegacyAuditSource.unreadableAuditIds). */
  unreadableAuditIds?: string[]
}

export interface InsightSnapshot {
  tenantId: string
  generatedAt: number
  inputsFingerprint: string
  maxInsights: number
  envelope: ReadModelEnvelope<InsightsResult>
  /** The job that produced it; null for a manual refresh. */
  idempotencyKey: string | null
}

export interface InsightSnapshotStore {
  put(ctx: TenantContext, snapshot: InsightSnapshot): void
  get(ctx: TenantContext): InsightSnapshot | null
}

/** Reference implementation: one latest snapshot per tenant, process-local, not durable. */
export class InMemoryInsightSnapshotStore implements InsightSnapshotStore {
  private readonly byTenant = new Map<string, InsightSnapshot>()
  put(ctx: TenantContext, snapshot: InsightSnapshot): void {
    requireTenant(ctx, snapshot.tenantId)
    requireTenant(ctx, snapshot.envelope.tenantId)
    this.byTenant.set(ctx.tenantId, structuredClone(snapshot))
  }
  get(ctx: TenantContext): InsightSnapshot | null {
    const s = this.byTenant.get(ctx.tenantId)
    return s ? structuredClone(s) : null
  }
}

/**
 * Fingerprint of everything insights are computed from: source records,
 * imports, recurring series, cases, return matches, business memory (with
 * status at `now`) and dismissals. A reimport, a correction, a revoked memory
 * entry or a new dismissal changes it. Time alone (aging, due dates) does not:
 * that is what the snapshot age threshold is for.
 */
export function insightInputsFingerprint(ctx: TenantContext, sources: TenantInsightSources, now: number): string {
  requirePermission(ctx, 'financial:read')
  requirePermission(ctx, 'cases:read')
  const sortRows = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort(compareText)
  const records = sources.financial.listSourceRecords(ctx)
  for (const r of records) requireTenant(ctx, r.tenantId)
  return fingerprintOf({
    origin: sources.financial.origin,
    records: sortRows(records.map((r) => [r.recordId, r.kind, r.amountMinor, r.currency, r.paymentDate, r.vendor.vendorKey, r.vendor.displayName, r.category])),
    imports: sortRows(sources.financial.listImportCoverage(ctx).map((i) => [i.auditId, i.importId, i.importedAt, i.acceptedRows, i.rejectedRows, i.dateRange.from, i.dateRange.to])),
    overlap: sources.financial.overlapCount(ctx),
    series: sortRows(sources.financial.listRecurringSeries(ctx).map((s) => [s.seriesId, s.amount.currency, s.amount.amountMinor, s.cadenceDays, s.paymentCount, s.lastPaymentDate])),
    cases: sortRows(sources.cases.listCases(ctx, now).map((c) => [
      c.caseId, c.stage, c.updatedAt, c.revision, c.outstandingMinor, c.customerRecordedReturnMinor, c.promisedOutstandingMinor, c.approvedAt, c.requestedAt,
      c.nextAction.label, c.nextAction.dueAt, c.latestVendorStatus, c.rootCause, c.reconciledAt, c.dismissal?.tag ?? null, c.activeRequestGeneration, c.supportedPotentialMinor,
    ])),
    returns: sources.returns.available ? sortRows(sources.returns.listMatches(ctx).map((m) => [m.caseId, m.status, m.amount.currency, m.amount.amountMinor, m.date])) : 'unavailable',
    memory: sortRows(sources.memory.list(ctx, { includeInactive: true }, now).map((e) => [e.id, e.status, e.revokedAt, e.expiresAt, e.reviewAt !== null && now >= e.reviewAt])),
    dismissals: sortRows(sources.insightState.list(ctx).map((d) => [d.dedupKey, d.evidenceFingerprint, d.dismissedAt, now < d.expiresAt])),
    unreadable: [...(sources.unreadableAuditIds ?? [])].sort(compareText),
  })
}

export type SnapshotStaleReason = 'never_generated' | 'inputs_changed' | 'older_than_threshold'

export interface ReadInsightsResult {
  /** The cached envelope, possibly stale; null when no refresh has run for this tenant. */
  envelope: ReadModelEnvelope<InsightsResult> | null
  generatedAt: number | null
  /** The cache no longer reflects the inputs (or is too old): refresh before relying on it. */
  stale: boolean
  staleReasons: SnapshotStaleReason[]
  /** The covered records themselves are old (envelope freshness): the insights are historical, not current monitoring. */
  historical: boolean
  inputsFingerprint: string
  snapshotFingerprint: string | null
}

/**
 * The last refreshed insights for the caller's tenant, with an honest
 * staleness verdict. Never generates; never returns another tenant's cache.
 */
export function readInsights(ctx: TenantContext, sources: TenantInsightSources, snapshots: InsightSnapshotStore, now: number, options: { maxAgeMs?: number } = {}): ReadInsightsResult {
  requirePermission(ctx, 'financial:read')
  requirePermission(ctx, 'cases:read')
  const inputsFingerprint = insightInputsFingerprint(ctx, sources, now)
  const snap = snapshots.get(ctx)
  if (!snap) return { envelope: null, generatedAt: null, stale: true, staleReasons: ['never_generated'], historical: false, inputsFingerprint, snapshotFingerprint: null }
  requireTenant(ctx, snap.tenantId)
  requireTenant(ctx, snap.envelope.tenantId)
  const reasons: SnapshotStaleReason[] = []
  if (snap.inputsFingerprint !== inputsFingerprint) reasons.push('inputs_changed')
  if (now - snap.generatedAt > (options.maxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS)) reasons.push('older_than_threshold')
  return {
    envelope: snap.envelope,
    generatedAt: snap.generatedAt,
    stale: reasons.length > 0,
    staleReasons: reasons,
    historical: snap.envelope.freshness.stale,
    inputsFingerprint,
    snapshotFingerprint: snap.inputsFingerprint,
  }
}

interface RefreshCore {
  snapshot: InsightSnapshot
  reused: boolean
}

function refreshCore(ctx: TenantContext, sources: TenantInsightSources, snapshots: InsightSnapshotStore, now: number, maxInsights: number, idempotencyKey: string | null, maxAgeMs: number): RefreshCore {
  requirePermission(ctx, 'insights:refresh')
  const inputsFingerprint = insightInputsFingerprint(ctx, sources, now)
  const existing = snapshots.get(ctx)
  if (existing && existing.inputsFingerprint === inputsFingerprint && existing.maxInsights === maxInsights && now - existing.generatedAt <= maxAgeMs && now >= existing.generatedAt) {
    requireTenant(ctx, existing.tenantId)
    return { snapshot: existing, reused: true }
  }
  const deps: InsightDeps = { financial: sources.financial, cases: sources.cases, returns: sources.returns, memory: sources.memory, insightState: sources.insightState }
  const env = generateInsightsSync(ctx, deps, now, { limit: maxInsights, includeDismissed: false, includeExpired: true, unreadableAuditIds: sources.unreadableAuditIds })
  const snapshot: InsightSnapshot = { tenantId: ctx.tenantId, generatedAt: now, inputsFingerprint, maxInsights, envelope: env, idempotencyKey }
  snapshots.put(ctx, snapshot)
  return { snapshot, reused: false }
}

/**
 * Manual refresh from a request with a signed-in context (needs
 * `insights:refresh`). Same work as the job handler; reuses the cache when the
 * inputs are unchanged and it is younger than `maxAgeMs`.
 */
export function refreshInsightsNow(ctx: TenantContext, sources: TenantInsightSources, snapshots: InsightSnapshotStore, now: number, options: { maxInsights?: number; maxAgeMs?: number } = {}): RefreshCore {
  const maxInsights = options.maxInsights ?? DEFAULT_MAX_INSIGHTS
  if (!Number.isInteger(maxInsights) || maxInsights < 1 || maxInsights > MAX_INSIGHT_LIMIT) throw new IntelligenceQueryError('maxInsights', `maxInsights must be an integer from 1 to ${MAX_INSIGHT_LIMIT}.`)
  return refreshCore(ctx, sources, snapshots, now, maxInsights, null, options.maxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS)
}

// ---------------------------------------------------------------- the handler

export type RefreshTrigger = 'manual' | 'scheduled' | 'import_completed' | 'feedback_changed' | 'case_changed'
export const REFRESH_TRIGGERS: readonly RefreshTrigger[] = ['manual', 'scheduled', 'import_completed', 'feedback_changed', 'case_changed']

export interface RefreshInsightsInput {
  trigger: RefreshTrigger
  /** Optional echo of the job tenant; refused when it differs. Never used to select data. */
  tenantId?: string
  maxInsights?: number
}

export interface RefreshInsightsOutput {
  generatedAt: number
  inputsFingerprint: string
  total: number
  countsByRule: Record<InsightRule, number>
  countsByStatus: Record<InsightStatus, number>
  /** True when an up-to-date snapshot was reused instead of regenerated. */
  reusedSnapshot: boolean
}

interface LedgerEntry {
  inputFingerprint: string
  outcome: JobOutcome<RefreshInsightsOutput>
}

/** Idempotency ledger. The runner's own store replaces this in production. */
export interface JobLedger {
  get(tenantId: string, idempotencyKey: string): LedgerEntry | null
  put(tenantId: string, idempotencyKey: string, entry: LedgerEntry): void
}

export class InMemoryJobLedger implements JobLedger {
  private readonly entries = new Map<string, LedgerEntry>()
  get(tenantId: string, idempotencyKey: string): LedgerEntry | null {
    const e = this.entries.get(`${tenantId}\u0000${idempotencyKey}`)
    return e ? structuredClone(e) : null
  }
  put(tenantId: string, idempotencyKey: string, entry: LedgerEntry): void {
    const key = `${tenantId}\u0000${idempotencyKey}`
    this.entries.delete(key)
    this.entries.set(key, structuredClone(entry))
    while (this.entries.size > MAX_LEDGER_ENTRIES) this.entries.delete(this.entries.keys().next().value!)
  }
}

export interface RefreshHandlerDeps {
  /** Server-side loader of one tenant's sources. Returning another tenant's ports is detected and refused. */
  loadTenant(tenantId: string): TenantInsightSources | null
  snapshots: InsightSnapshotStore
  /** Required to run a job with an actor (manual refresh): true when the actor may refresh insights for the tenant. */
  authorizeActor?: (tenantId: string, actorId: string) => boolean
  ledger?: JobLedger
  maxAttempts?: number
  maxAgeMs?: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
}

function validateInput(raw: unknown): { ok: true; value: { trigger: RefreshTrigger; tenantId: string | null; maxInsights: number } } | { ok: false } {
  if (!isPlainObject(raw)) return { ok: false }
  if (Object.keys(raw).some((k) => !['trigger', 'tenantId', 'maxInsights'].includes(k))) return { ok: false }
  if (typeof raw.trigger !== 'string' || !REFRESH_TRIGGERS.includes(raw.trigger as RefreshTrigger)) return { ok: false }
  if (raw.tenantId !== undefined && (typeof raw.tenantId !== 'string' || !TENANT_ID.test(raw.tenantId))) return { ok: false }
  const maxInsights = raw.maxInsights === undefined ? DEFAULT_MAX_INSIGHTS : raw.maxInsights
  if (typeof maxInsights !== 'number' || !Number.isInteger(maxInsights) || maxInsights < 1 || maxInsights > MAX_INSIGHT_LIMIT) return { ok: false }
  return { ok: true, value: { trigger: raw.trigger as RefreshTrigger, tenantId: (raw.tenantId as string | undefined) ?? null, maxInsights } }
}

/**
 * The context a job runs under: source 'job_runner' (contract 0.1.2), a
 * read-only permission set, and the system actor when the runner started it.
 * A job never inherits the implicit owner rights of a signed-in session.
 */
export function jobTenantContext(tenantId: string, actorId: string | null): TenantContext {
  return { tenantId, actorId: actorId ?? SYSTEM_ACTOR_ID, permissions: INSIGHT_JOB_PERMISSIONS, source: 'job_runner' }
}

export function refreshInsightsHandler(deps: RefreshHandlerDeps): JobHandler<RefreshInsightsInput, RefreshInsightsOutput> {
  const ledger = deps.ledger ?? new InMemoryJobLedger()
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const maxAgeMs = deps.maxAgeMs ?? DEFAULT_SNAPSHOT_MAX_AGE_MS
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError('maxAttempts must be an integer from 1 to 10.')

  return {
    operation: INSIGHT_REFRESH_OPERATION,
    async run(job: JobContext<RefreshInsightsInput>): Promise<JobOutcome<RefreshInsightsOutput>> {
      const tenantForEvent = typeof job?.tenantId === 'string' && TENANT_ID.test(job.tenantId) ? job.tenantId : 'invalid'
      const keyForEvent = typeof job?.idempotencyKey === 'string' && IDEMPOTENCY_KEY.test(job.idempotencyKey) ? job.idempotencyKey : 'invalid'
      const at = typeof job?.now === 'number' && Number.isFinite(job.now) ? job.now : 0
      const attempt = Number.isInteger(job?.attempt) ? job.attempt : 0
      const event = (outcome: JobStatus, errorCode: JobErrorCode | null, counts: Record<string, number> = {}, replayed = false): JobAuditEvent => ({
        operation: INSIGHT_REFRESH_OPERATION, tenantId: tenantForEvent, idempotencyKey: keyForEvent, at, outcome, attempt, replayed, errorCode, counts,
      })
      const fail = (code: JobErrorCode): JobOutcome<RefreshInsightsOutput> => ({ status: 'failed', error: jobError(code), auditEvent: event('failed', code) })

      // ---- envelope
      if (!job || job.operation !== INSIGHT_REFRESH_OPERATION || tenantForEvent === 'invalid' || keyForEvent === 'invalid' || attempt < 1 || at <= 0 || (job.actorId !== null && (typeof job.actorId !== 'string' || !job.actorId))) {
        return fail('invalid_job')
      }
      const input = validateInput(job.input)
      if (!input.ok) return fail('invalid_input')
      if (input.value.tenantId !== null && input.value.tenantId !== job.tenantId) return fail('tenant_mismatch')

      // ---- idempotency
      const inputFingerprint = fingerprintOf({ operation: INSIGHT_REFRESH_OPERATION, actorId: job.actorId, input: input.value })
      const prior = ledger.get(job.tenantId, job.idempotencyKey)
      if (prior) {
        if (prior.inputFingerprint !== inputFingerprint) return fail('idempotency_conflict')
        return { ...prior.outcome, auditEvent: { ...prior.outcome.auditEvent, at, attempt, replayed: true } }
      }
      const settle = (outcome: JobOutcome<RefreshInsightsOutput>) => {
        if (outcome.status !== 'retry') ledger.put(job.tenantId, job.idempotencyKey, { inputFingerprint, outcome })
        return outcome
      }

      // ---- authorization
      if (job.actorId !== null && !(deps.authorizeActor?.(job.tenantId, job.actorId) ?? false)) return settle(fail('forbidden'))

      try {
        const sources = deps.loadTenant(job.tenantId)
        if (!sources) return settle(fail('tenant_not_found'))
        const ctx = jobTenantContext(job.tenantId, job.actorId)
        const { snapshot, reused } = refreshCore(ctx, sources, deps.snapshots, job.now, input.value.maxInsights, job.idempotencyKey, maxAgeMs)
        const result = snapshot.envelope.result!
        const countsByRule = Object.fromEntries(INSIGHT_RULE_IDS.map((r) => [r, result.countsByRule[r]])) as Record<InsightRule, number>
        const output: RefreshInsightsOutput = {
          generatedAt: snapshot.generatedAt,
          inputsFingerprint: snapshot.inputsFingerprint,
          total: result.total,
          countsByRule,
          countsByStatus: { ...result.countsByStatus },
          reusedSnapshot: reused,
        }
        const counts = { insights: result.total, active: result.countsByStatus.active, expired: result.countsByStatus.expired, dismissed: result.countsByStatus.dismissed, high: result.countsBySeverity.high, medium: result.countsBySeverity.medium, low: result.countsBySeverity.low, reused: reused ? 1 : 0 }
        return settle({ status: 'succeeded', output, checkpoint: { inputsFingerprint: snapshot.inputsFingerprint, generatedAt: snapshot.generatedAt }, auditEvent: event('succeeded', null, counts) })
      } catch (err) {
        if (err instanceof IntelligenceAccessError) return settle(fail(err.code === 'tenant_mismatch' ? 'tenant_mismatch' : 'forbidden'))
        if (err instanceof IntelligenceQueryError) return settle(fail('invalid_input'))
        // Anything else is treated as a transient port failure. The message is never logged or returned.
        if (attempt < maxAttempts) return { status: 'retry', error: jobError('transient_failure'), checkpoint: { attemptsMade: attempt }, auditEvent: event('retry', 'transient_failure') }
        return settle(fail('retries_exhausted'))
      }
    },
  }
}

// ---------------------------------------------------------------- FIXTURE runner (tests only)

export interface FixtureJob<I> {
  tenantId: string
  actorId: string | null
  operation: string
  idempotencyKey: string
  input: I
  now: number
}

/**
 * FIXTURE, NOT A SCHEDULER. Runs a registered handler for one job, attempt
 * after attempt in the same call (no timers, no queue, no background work),
 * until it succeeds, fails or reaches `maxAttempts`. Records every audit
 * event. Jagan's durable runner replaces it.
 */
export class FixtureJobRunner {
  private readonly handlers = new Map<string, JobHandler<unknown, unknown>>()
  readonly auditLog: JobAuditEvent[] = []
  private readonly maxAttempts: number

  constructor(options: { maxAttempts?: number } = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  }

  register<I, O>(handler: JobHandler<I, O>): void {
    this.handlers.set(handler.operation, handler as unknown as JobHandler<unknown, unknown>)
  }

  async run<I, O>(job: FixtureJob<I>): Promise<{ outcome: JobOutcome<O>; attempts: number }> {
    const handler = this.handlers.get(job.operation)
    if (!handler) throw new Error('No handler registered for this operation.')
    let checkpoint: unknown | null = null
    for (let attempt = 1; ; attempt++) {
      const outcome = (await handler.run({ ...job, attempt, checkpoint })) as JobOutcome<O>
      this.auditLog.push(outcome.auditEvent)
      if (outcome.status !== 'retry' || attempt >= this.maxAttempts) return { outcome, attempts: attempt }
      checkpoint = outcome.checkpoint ?? null
    }
  }
}
