/**
 * One row per AI invocation: who, which task, which model, under which policy
 * and consent, a hash of exactly what was sent, and how it ended. No prompt,
 * packet or output text is stored or logged, so the ledger can be kept and
 * exported without becoming a second copy of the customer's data.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'

export type InvocationOutcome = 'running' | 'ok' | 'rejected' | 'refused' | 'failed' | 'timeout' | 'budget'

export interface InvocationRow {
  id: string; task: string; task_version: string; provider: string; model: string; actor: string
  policy_version: number; consent_id: string | null; project_id: string | null; finding_id: string | null
  packet_hash: string; started_at: number; finished_at: number | null; outcome: InvocationOutcome
  validation_codes: string; attempts: number; input_tokens: number | null; output_tokens: number | null
}

export function migrateAiLedger(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ai_invocations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    task TEXT NOT NULL,
    task_version TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    actor TEXT NOT NULL,
    policy_version INTEGER NOT NULL,
    consent_id TEXT,
    project_id TEXT,
    finding_id TEXT,
    packet_hash TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT NOT NULL,
    validation_codes TEXT NOT NULL DEFAULT '[]',
    attempts INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER,
    output_tokens INTEGER
  );
  CREATE INDEX IF NOT EXISTS ai_invocations_user ON ai_invocations(user_id, started_at);`)
}

export class InvocationLedger {
  private readonly db: DatabaseSync
  constructor(db: DatabaseSync) {
    this.db = db
    migrateAiLedger(db)
  }

  start(tenantId: string, row: Omit<InvocationRow, 'id' | 'finished_at' | 'outcome' | 'validation_codes' | 'attempts' | 'input_tokens' | 'output_tokens'>): string {
    const id = randomUUID()
    this.db.prepare(`INSERT INTO ai_invocations (id, user_id, task, task_version, provider, model, actor, policy_version, consent_id, project_id, finding_id, packet_hash, started_at, outcome)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`)
      .run(id, tenantId, row.task, row.task_version, row.provider, row.model, row.actor, row.policy_version, row.consent_id, row.project_id, row.finding_id, row.packet_hash, row.started_at)
    return id
  }

  finish(tenantId: string, id: string, result: { outcome: Exclude<InvocationOutcome, 'running'>; at: number; codes?: string[]; attempts: number; inputTokens?: number | null; outputTokens?: number | null }): void {
    this.db.prepare('UPDATE ai_invocations SET outcome = ?, finished_at = ?, validation_codes = ?, attempts = ?, input_tokens = ?, output_tokens = ? WHERE user_id = ? AND id = ?')
      .run(result.outcome, result.at, JSON.stringify(result.codes ?? []), result.attempts, result.inputTokens ?? null, result.outputTokens ?? null, tenantId, id)
  }

  /** A budget refusal is recorded too, so a tenant can see why a task didn't run. */
  countSince(tenantId: string, since: number): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM ai_invocations WHERE user_id = ? AND started_at >= ? AND outcome != 'budget'").get(tenantId, since) as { n: number }).n
  }

  tokensSince(tenantId: string, since: number): number {
    return (this.db.prepare('SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS n FROM ai_invocations WHERE user_id = ? AND started_at >= ?').get(tenantId, since) as { n: number }).n
  }

  running(tenantId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM ai_invocations WHERE user_id = ? AND outcome = 'running'").get(tenantId) as { n: number }).n
  }

  /** Startup: an invocation the process died in the middle of is recorded as failed, so it never counts as running. */
  recoverInterrupted(at: number): number {
    return Number(this.db.prepare("UPDATE ai_invocations SET outcome = 'failed', finished_at = ?, validation_codes = '[\"interrupted\"]' WHERE outcome = 'running'").run(at).changes)
  }

  list(tenantId: string, limit = 100): Array<Omit<InvocationRow, 'validation_codes'> & { validationCodes: string[] }> {
    const rows = this.db.prepare('SELECT id, task, task_version, provider, model, actor, policy_version, consent_id, project_id, finding_id, packet_hash, started_at, finished_at, outcome, validation_codes, attempts, input_tokens, output_tokens FROM ai_invocations WHERE user_id = ? ORDER BY started_at DESC LIMIT ?').all(tenantId, limit) as unknown as InvocationRow[]
    return rows.map(({ validation_codes, ...row }) => ({ ...row, validationCodes: JSON.parse(validation_codes) as string[] }))
  }
}
