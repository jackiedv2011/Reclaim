/**
 * Each tenant's choice about external AI, and the consents that let one task
 * run. Off is the default for every account, existing ones included.
 *
 * - `off`: no packet leaves Reclaim. Deterministic features keep working.
 * - `on_demand`: a person starts each task. It runs only under a consent that
 *   names the task, its purpose and either the exact packet (one use) or the
 *   task's field set (standing, revocable).
 *
 * Automatic processing (a job calling a provider with nobody clicking) is a
 * proposed future setting. It is modelled here only as a constant that is
 * false; enabling it needs founder agreement, a provider privacy review and
 * the customer's opt-in, and a code change, not a database row.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../http.ts'
import type { TenantContext } from '../tenant.ts'

export const AUTOMATIC_EXTERNAL_AI_ENABLED = false as const
export type AiMode = 'off' | 'on_demand'
export const CONSENT_TTL_MS = 60 * 60 * 1000

export interface AiPolicy { mode: AiMode; version: number; updatedAt: number | null; updatedBy: string | null; automatic: 'disabled' }

export interface ConsentScope {
  task: string
  purpose: string
  fieldSetHash: string
  provider: string
  model: string
  /** 'packet': this exact packet, once. 'field_set': this task's fields for this tenant until revoked. */
  scope: 'packet' | 'field_set'
  packetHash?: string
  projectId?: string | null
  findingId?: string | null
}

export interface ConsentRow {
  id: string; task: string; scope: 'packet' | 'field_set'; purpose: string; field_set_hash: string; packet_hash: string | null
  project_id: string | null; finding_id: string | null; provider: string; model: string; policy_version: number
  created_by: string; created_at: number; expires_at: number | null; used_at: number | null; revoked_at: number | null
}

export function migrateAiPolicy(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_policies (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('off', 'on_demand')),
      version INTEGER NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_consents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task TEXT NOT NULL,
      scope TEXT NOT NULL CHECK (scope IN ('packet', 'field_set')),
      purpose TEXT NOT NULL,
      field_set_hash TEXT NOT NULL,
      packet_hash TEXT,
      project_id TEXT,
      finding_id TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      used_at INTEGER,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS ai_consents_user ON ai_consents(user_id, task, revoked_at);
  `)
}

export class AiPolicyStore {
  private readonly db: DatabaseSync
  private readonly now: () => number
  constructor(db: DatabaseSync, now: () => number = Date.now) {
    this.db = db
    this.now = now
    migrateAiPolicy(db)
  }

  get(tenantId: string): AiPolicy {
    const row = this.db.prepare('SELECT mode, version, updated_at, updated_by FROM ai_policies WHERE user_id = ?').get(tenantId) as { mode: AiMode; version: number; updated_at: number; updated_by: string } | undefined
    return row ? { mode: row.mode, version: row.version, updatedAt: row.updated_at, updatedBy: row.updated_by, automatic: 'disabled' } : { mode: 'off', version: 0, updatedAt: null, updatedBy: null, automatic: 'disabled' }
  }

  /** Any change of mode starts a new policy version and revokes every consent given under the old one. */
  set(ctx: TenantContext, mode: AiMode): AiPolicy {
    const current = this.get(ctx.tenantId)
    if (current.mode === mode) return current
    const at = this.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO ai_policies (user_id, mode, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET mode = excluded.mode, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(ctx.tenantId, mode, current.version + 1, ctx.actorLabel, at)
      this.db.prepare('UPDATE ai_consents SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(at, ctx.tenantId)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return this.get(ctx.tenantId)
  }

  grant(ctx: TenantContext, scope: ConsentScope): ConsentRow {
    const policy = this.get(ctx.tenantId)
    if (policy.mode !== 'on_demand') throw new HttpError(409, 'Turn on external AI for this account before giving consent to a task.', 'ai_off')
    if (scope.scope === 'packet' && (!scope.packetHash || !scope.projectId)) throw new HttpError(400, 'A one-time consent must name the case and the exact packet.', 'validation')
    const at = this.now()
    const id = randomUUID()
    this.db.prepare(`INSERT INTO ai_consents (id, user_id, task, scope, purpose, field_set_hash, packet_hash, project_id, finding_id, provider, model, policy_version, created_by, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, ctx.tenantId, scope.task, scope.scope, scope.purpose, scope.fieldSetHash, scope.packetHash ?? null, scope.projectId ?? null, scope.findingId ?? null,
        scope.provider, scope.model, policy.version, ctx.actorLabel, at, scope.scope === 'packet' ? at + CONSENT_TTL_MS : null)
    return this.consent(ctx.tenantId, id)!
  }

  revoke(ctx: TenantContext, id: string): boolean {
    const res = this.db.prepare('UPDATE ai_consents SET revoked_at = ? WHERE user_id = ? AND id = ? AND revoked_at IS NULL').run(this.now(), ctx.tenantId, id)
    return Number(res.changes) === 1
  }

  consent(tenantId: string, id: string): ConsentRow | undefined {
    return this.db.prepare('SELECT * FROM ai_consents WHERE user_id = ? AND id = ?').get(tenantId, id) as ConsentRow | undefined
  }

  list(tenantId: string): ConsentRow[] {
    return this.db.prepare('SELECT * FROM ai_consents WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND used_at IS NULL ORDER BY created_at DESC').all(tenantId, this.now()) as unknown as ConsentRow[]
  }

  /**
   * The consent that covers this exact invocation, or the reason there is none.
   * A named consent must match; otherwise a standing field-set consent is used.
   */
  resolve(tenantId: string, want: Required<Pick<ConsentScope, 'task' | 'purpose' | 'fieldSetHash' | 'provider' | 'model' | 'packetHash'>> & { projectId: string; findingId: string | null; scopes?: ReadonlyArray<'packet' | 'field_set'> }, consentId?: string | null): { ok: true; consent: ConsentRow } | { ok: false; code: string; reason: string } {
    const policy = this.get(tenantId)
    if (policy.mode !== 'on_demand') return { ok: false, code: 'ai_off', reason: 'External AI is off for this account.' }
    const now = this.now()
    const usable = (c: ConsentRow | undefined): string | null => {
      if (!c) return 'No consent covers this task.'
      if (want.scopes && !want.scopes.includes(c.scope)) return 'This task needs a one-time consent for the exact data it will send.'
      if (c.revoked_at) return 'That consent was revoked.'
      if (c.expires_at !== null && c.expires_at <= now) return 'That consent has expired.'
      if (c.used_at) return 'That one-time consent was already used.'
      if (c.policy_version !== policy.version) return 'The AI policy changed after this consent was given.'
      if (c.task !== want.task || c.purpose !== want.purpose) return 'That consent was given for a different task.'
      if (c.field_set_hash !== want.fieldSetHash) return 'The fields this task sends have changed since consent was given.'
      if (c.provider !== want.provider || c.model !== want.model) return 'The AI provider or model changed since consent was given.'
      if (c.project_id && c.project_id !== want.projectId) return 'That consent was given for a different audit.'
      if (c.finding_id && c.finding_id !== want.findingId) return 'That consent was given for a different case.'
      if (c.scope === 'packet' && c.packet_hash !== want.packetHash) return 'The case data changed since you reviewed it. Preview it again.'
      return null
    }
    if (consentId) {
      const c = this.consent(tenantId, consentId)
      const problem = usable(c)
      return problem ? { ok: false, code: 'ai_consent_stale', reason: problem } : { ok: true, consent: c! }
    }
    const standing = (this.db.prepare("SELECT * FROM ai_consents WHERE user_id = ? AND task = ? AND scope = 'field_set' AND revoked_at IS NULL ORDER BY created_at DESC").all(tenantId, want.task) as unknown as ConsentRow[])
      .find((c) => usable(c) === null)
    return standing ? { ok: true, consent: standing } : { ok: false, code: 'ai_consent_required', reason: 'Review what this task sends and give consent first.' }
  }

  markUsed(tenantId: string, consent: ConsentRow): void {
    if (consent.scope !== 'packet') return
    const res = this.db.prepare('UPDATE ai_consents SET used_at = ? WHERE user_id = ? AND id = ? AND used_at IS NULL').run(this.now(), tenantId, consent.id)
    if (Number(res.changes) !== 1) throw new HttpError(409, 'That one-time consent was already used.', 'ai_consent_stale')
  }
}
