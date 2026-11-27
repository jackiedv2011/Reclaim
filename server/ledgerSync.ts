/**
 * C5: read-only QuickBooks sync and ledger scan handlers for the shared job
 * contract, plus the sync state that tells the last successful sync apart from
 * a requested or failed one.
 *
 * Jagan's workstream owns the runner, scheduling and retries; this file only
 * provides idempotent handlers (one call = one attempt) and a typed outcome the
 * runner acts on. No queue lives here. Handlers never write to QuickBooks: the
 * adapter only issues SELECT queries and change-data-capture reads, and the
 * handler only stores what those reads returned.
 *
 * Outcomes, audit events and stored state carry counts, ids and bounded error
 * codes only: never tokens, provider messages, vendor names or amounts.
 */
import type { DatabaseSync } from 'node:sqlite'
import { QuickBooksRateLimitError, QuickBooksReconnectError, QuickBooksUnauthorizedError, syncLedger, type QuickBooksClient } from './quickbooks.ts'
import { LedgerError, deriveFindings, importQuickBooksPull, type LedgerKeys } from './ledger.ts'
import { TenantAccessError, requirePermission, tenantContextFor } from './tenancy.ts'
import { FINANCIAL_CONTRACT_VERSION, type TenantContext, type JobAuditEvent, type JobCheckpoint, type JobErrorCode, type JobHandler, type JobOutcome, type JobRequest } from '../src/contracts/financial.ts'

export const LEDGER_JOB_CONTRACT_VERSION = FINANCIAL_CONTRACT_VERSION

export function ensureLedgerSyncSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_sync_state (
    tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    source_system TEXT NOT NULL CHECK (source_system IN ('quickbooks')),
    account_ref TEXT NOT NULL,
    last_requested_at INTEGER,
    last_success_at INTEGER,
    last_success_import_id TEXT,
    last_success_mode TEXT,
    cursor_since INTEGER,
    last_failed_at INTEGER,
    last_error_code TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, source_system, account_ref)
  );
  CREATE TABLE IF NOT EXISTS ledger_job_receipts (
    tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    checkpoint TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    PRIMARY KEY (tenant_id, operation, idempotency_key)
  );`)
}

// ------------------------------------------------------------------ sync state

export interface SyncState {
  tenantId: string
  sourceSystem: 'quickbooks'
  /** QuickBooks realm id. */
  accountRef: string
  lastRequestedAt: number | null
  /** The last sync that stored its pull. A later request or failure never moves this. */
  lastSuccessAt: number | null
  lastSuccessImportId: string | null
  lastSuccessMode: 'full' | 'changes' | 'no_changes' | null
  /** Where the next change pull starts (the request time of the last successful pull). */
  cursorSince: number | null
  lastFailedAt: number | null
  lastErrorCode: SyncErrorCode | null
  consecutiveFailures: number
}

interface SyncRow {
  tenant_id: string
  account_ref: string
  last_requested_at: number | null
  last_success_at: number | null
  last_success_import_id: string | null
  last_success_mode: SyncState['lastSuccessMode']
  cursor_since: number | null
  last_failed_at: number | null
  last_error_code: SyncErrorCode | null
  consecutive_failures: number
}

const toState = (r: SyncRow): SyncState => ({
  tenantId: r.tenant_id,
  sourceSystem: 'quickbooks',
  accountRef: r.account_ref,
  lastRequestedAt: r.last_requested_at,
  lastSuccessAt: r.last_success_at,
  lastSuccessImportId: r.last_success_import_id,
  lastSuccessMode: r.last_success_mode,
  cursorSince: r.cursor_since,
  lastFailedAt: r.last_failed_at,
  lastErrorCode: r.last_error_code,
  consecutiveFailures: r.consecutive_failures,
})

/**
 * Sync state for one QuickBooks company, readable by anyone who can read the
 * tenant's ledger. The tenant comes from the server-derived context, never
 * from the caller.
 */
export function getSyncState(db: DatabaseSync, ctx: TenantContext, realmId: string): SyncState | null {
  requirePermission(ctx, 'ledger:read')
  return readSyncState(db, ctx.tenantId, realmId)
}

function readSyncState(db: DatabaseSync, tenantId: string, realmId: string): SyncState | null {
  const row = db.prepare("SELECT * FROM ledger_sync_state WHERE tenant_id = ? AND source_system = 'quickbooks' AND account_ref = ?").get(tenantId, realmId) as SyncRow | undefined
  return row ? toState(row) : null
}

function markRequested(db: DatabaseSync, tenantId: string, realmId: string, now: number) {
  db.prepare(`INSERT INTO ledger_sync_state (tenant_id, source_system, account_ref, last_requested_at) VALUES (?, 'quickbooks', ?, ?)
    ON CONFLICT (tenant_id, source_system, account_ref) DO UPDATE SET last_requested_at = excluded.last_requested_at`).run(tenantId, realmId, now)
}

function markSucceeded(db: DatabaseSync, tenantId: string, realmId: string, now: number, importId: string | null, mode: NonNullable<SyncState['lastSuccessMode']>) {
  db.prepare(`UPDATE ledger_sync_state SET last_success_at = ?, last_success_import_id = COALESCE(?, last_success_import_id), last_success_mode = ?,
    cursor_since = ?, consecutive_failures = 0, last_error_code = NULL WHERE tenant_id = ? AND source_system = 'quickbooks' AND account_ref = ?`)
    .run(now, importId, mode, now, tenantId, realmId)
}

function markFailed(db: DatabaseSync, tenantId: string, realmId: string, now: number, code: SyncErrorCode) {
  db.prepare(`UPDATE ledger_sync_state SET last_failed_at = ?, last_error_code = ?, consecutive_failures = consecutive_failures + 1
    WHERE tenant_id = ? AND source_system = 'quickbooks' AND account_ref = ?`).run(now, code, tenantId, realmId)
}

// ------------------------------------------------------------------ job contract

// The types are the shared contract's (src/contracts/financial.ts); these
// aliases only narrow the operation to the two this workstream provides.
export type LedgerJobOperation = 'quickbooks.sync' | 'ledger.scan'
export type SyncErrorCode = JobErrorCode
export type LedgerJobRequest = JobRequest<LedgerJobOperation>
export type LedgerJobOutcome = JobOutcome
export type LedgerJobHandler = JobHandler<LedgerJobOperation>
export type { JobAuditEvent, JobCheckpoint }

/** Attempts before a retryable error becomes a failure. The runner may stop sooner. */
export const MAX_ATTEMPTS = 5
const BASE_BACKOFF_MS = 60_000
const MAX_BACKOFF_MS = 60 * 60_000
/** Deterministic exponential backoff; the runner adds jitter if it wants it. */
export const backoffMs = (attempt: number) => Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt - 1))

const KEY = /^[\w:.-]{1,200}$/

function audit(req: LedgerJobRequest, outcome: JobAuditEvent['outcome'], at: number, counts: Record<string, number> = {}, errorCode: SyncErrorCode | null = null): JobAuditEvent {
  return { contractVersion: LEDGER_JOB_CONTRACT_VERSION, tenantId: req.tenantId, actorUserId: req.actorUserId, operation: req.operation, idempotencyKey: req.idempotencyKey, attempt: req.attempt, outcome, at, counts, errorCode }
}

function completedReceipt(db: DatabaseSync, req: LedgerJobRequest): JobCheckpoint | null {
  const row = db.prepare('SELECT checkpoint FROM ledger_job_receipts WHERE tenant_id = ? AND operation = ? AND idempotency_key = ?').get(req.tenantId, req.operation, req.idempotencyKey) as { checkpoint: string } | undefined
  return row ? (JSON.parse(row.checkpoint) as JobCheckpoint) : null
}

function saveReceipt(db: DatabaseSync, req: LedgerJobRequest, checkpoint: JobCheckpoint, now: number) {
  db.prepare('INSERT OR IGNORE INTO ledger_job_receipts (tenant_id, operation, idempotency_key, checkpoint, completed_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.tenantId, req.operation, req.idempotencyKey, JSON.stringify(checkpoint), now)
}

function validRequest(req: LedgerJobRequest, operation: LedgerJobOperation): boolean {
  return req.operation === operation && typeof req.tenantId === 'string' && typeof req.actorUserId === 'string' && typeof req.idempotencyKey === 'string' && KEY.test(req.idempotencyKey) && Number.isInteger(req.attempt) && req.attempt >= 1
}

function failOrRetry(req: LedgerJobRequest, code: SyncErrorCode, retryable: boolean, now: number): LedgerJobOutcome {
  if (retryable && req.attempt < MAX_ATTEMPTS) return { status: 'retry', retryAfterMs: backoffMs(req.attempt), errorCode: code, audit: audit(req, 'retry', now, {}, code) }
  const final: SyncErrorCode = retryable ? 'retries_exhausted' : code
  return { status: 'failed', errorCode: final, audit: audit(req, 'failed', now, {}, final) }
}

// ------------------------------------------------------------------ quickbooks.sync

export interface QuickBooksSyncDeps {
  db: DatabaseSync
  keys: LedgerKeys
  client: QuickBooksClient
  /**
   * A current access token for the tenant's connection to this company. Supplied
   * by the integration layer, which owns token storage and refresh; throws
   * QuickBooksReconnectError when the connection has to be made again.
   */
  accessToken(tenantId: string, realmId: string): Promise<string>
}

/**
 * One sync attempt: change pull since the last successful sync when that is
 * recent enough, otherwise the whole ledger; stored through the ledger's
 * idempotent import. payload: { realmId }.
 */
export function quickBooksSyncHandler(deps: QuickBooksSyncDeps): LedgerJobHandler {
  return {
    operation: 'quickbooks.sync',
    async run(req, now = Date.now()) {
      const realmId = req.payload?.realmId
      if (!validRequest(req, 'quickbooks.sync') || typeof realmId !== 'string' || !/^\d{1,32}$/.test(realmId)) return failOrRetry(req, 'invalid_request', false, now)
      let ctx
      try {
        ctx = tenantContextFor(deps.db, req.actorUserId, req.tenantId)
        requirePermission(ctx, 'ledger:import')
      } catch (err) {
        if (err instanceof TenantAccessError) return failOrRetry(req, 'permission_denied', false, now)
        throw err
      }
      const done = completedReceipt(deps.db, req)
      if (done) return { status: 'succeeded', checkpoint: done, audit: audit(req, 'already_completed', now) }

      markRequested(deps.db, ctx.tenantId, realmId, now)
      const since = readSyncState(deps.db, ctx.tenantId, realmId)?.cursorSince ?? null
      let code: SyncErrorCode
      let retryable: boolean
      try {
        const token = await deps.accessToken(ctx.tenantId, realmId)
        const pull = await syncLedger(deps.client, realmId, token, since, now)
        const stored = importQuickBooksPull(deps.db, deps.keys, ctx, { realmId, csv: pull.csv, facts: pull.facts }, now)
        const mode = stored ? (pull.facts.sync?.mode ?? 'full') : 'no_changes'
        markSucceeded(deps.db, ctx.tenantId, realmId, now, stored?.importId ?? null, mode)
        const checkpoint: JobCheckpoint = { realmId, cursorSince: now, importId: stored?.importId ?? null, mode }
        saveReceipt(deps.db, req, checkpoint, now)
        const counts = {
          rowsAccepted: stored?.coverage.rows.accepted ?? 0,
          rowsRejected: stored?.coverage.rows.rejected ?? 0,
          newRecords: stored?.coverage.dedup.newRecords ?? 0,
          alreadyImported: stored?.coverage.dedup.alreadyImported ?? 0,
          removedInSource: pull.facts.sync?.removed.length ?? 0,
          duplicatePull: stored?.duplicateFile ? 1 : 0,
        }
        return { status: 'succeeded', checkpoint, audit: audit(req, 'succeeded', now, counts) }
      } catch (err) {
        if (err instanceof QuickBooksReconnectError) [code, retryable] = ['reconnect_required', false]
        else if (err instanceof QuickBooksUnauthorizedError) [code, retryable] = ['token_rejected', true]
        else if (err instanceof QuickBooksRateLimitError) [code, retryable] = ['rate_limited', true]
        else if (err instanceof LedgerError || err instanceof TenantAccessError) [code, retryable] = ['storage_rejected', false]
        else [code, retryable] = ['provider_error', true]
      }
      markFailed(deps.db, ctx.tenantId, realmId, now, code)
      return failOrRetry(req, code, retryable, now)
    },
  }
}

// ------------------------------------------------------------------ ledger.scan

export interface LedgerScanDeps {
  db: DatabaseSync
  keys: LedgerKeys
}

/**
 * Re-derives findings from the tenant's stored ledger. Read-only: nothing is
 * written except the completion receipt. The outcome carries counts per rule,
 * never amounts, so a runner log cannot total potential and recovered money.
 */
export function ledgerScanHandler(deps: LedgerScanDeps): LedgerJobHandler {
  return {
    operation: 'ledger.scan',
    async run(req, now = Date.now()) {
      if (!validRequest(req, 'ledger.scan')) return failOrRetry(req, 'invalid_request', false, now)
      let ctx
      try {
        ctx = tenantContextFor(deps.db, req.actorUserId, req.tenantId)
        requirePermission(ctx, 'findings:read')
      } catch (err) {
        if (err instanceof TenantAccessError) return failOrRetry(req, 'permission_denied', false, now)
        throw err
      }
      const done = completedReceipt(deps.db, req)
      if (done) return { status: 'succeeded', checkpoint: done, audit: audit(req, 'already_completed', now) }
      const { maxSeq, records } = deps.db.prepare('SELECT COALESCE(MAX(seq), 0) AS maxSeq, COUNT(*) AS records FROM source_records WHERE tenant_id = ?').get(ctx.tenantId) as { maxSeq: number; records: number }
      const { findings } = deriveFindings(deps.db, deps.keys, ctx)
      const counts: Record<string, number> = { sourceRecords: records, findings: findings.length }
      for (const f of findings) counts[`rule:${f.type}`] = (counts[`rule:${f.type}`] ?? 0) + 1
      const checkpoint: JobCheckpoint = { throughSeq: maxSeq, findings: findings.length }
      saveReceipt(deps.db, req, checkpoint, now)
      return { status: 'succeeded', checkpoint, audit: audit(req, 'succeeded', now, counts) }
    },
  }
}
