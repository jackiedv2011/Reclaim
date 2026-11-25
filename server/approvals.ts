/**
 * Action proposals and the account-wide approval queue (workstream J2).
 *
 * Anything consequential that Reclaim prepares on its own (a follow-up a job
 * drafted, a status read from a supplier reply, a return Sid's matcher found)
 * becomes a proposal: an exact payload, its hash, the case version it was
 * prepared against, why, and from where. A person approves that exact payload
 * or rejects it. Approval re-checks the case: if anything about it changed,
 * the proposal is stale and must be prepared again.
 *
 * Proposals never edit a case directly. Executing one runs an existing,
 * server-validated case command or the guarded Gmail route, with the same
 * checks a click in the app gets (see recoveryRoutes.ts).
 *
 * Payloads are sealed at rest under DATA_KEY. There is no UI here: the queue
 * API is for Aditya's approval inbox.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HttpError } from './http.ts'
import { requirePermission, type Permission, type TenantContext } from './tenant.ts'
import { hashJson, type Sealer } from './sealedJson.ts'
import { storedCase } from './recoveryFacts.ts'

export const PROPOSAL_ORIGINS = ['user', 'job', 'inbound', 'ai', 'document', 'return_match'] as const
export type ProposalOrigin = typeof PROPOSAL_ORIGINS[number]
export type ProposalStatus = 'pending' | 'executing' | 'executed' | 'failed' | 'rejected' | 'expired' | 'stale' | 'superseded'

const text = z.string().trim().max(5000)
const money = z.number().finite().positive()
const commandInput = {
  vendor_update: z.object({ status: z.string().min(1).max(50), note: text.min(1), at: z.number().finite(), amount: money.optional(), method: z.enum(['refund', 'credit', 'offset']).optional(), expectedAt: z.number().finite().optional() }).strict(),
  followup: z.object({ at: z.number().finite().positive().nullable() }).strict(),
  followup_days: z.object({ days: z.number().int().min(1).max(90) }).strict(),
  contact_hold: z.object({ reason: text.nullable() }).strict(),
  settlement: z.object({ amount: money, method: z.enum(['refund', 'credit', 'offset']), source: z.enum(['bank', 'accounting', 'document', 'manual']), reference: text.min(1).max(300), settledAt: z.number().finite().positive(), appliedToBill: text.optional() }).strict(),
  close: z.object({ reason: text.min(1) }).strict(),
  reconcile: z.object({ note: text.min(1), rootCause: text }).strict(),
} as const
export type ProposableCommand = keyof typeof commandInput

const sendFields = { to: z.email().max(320), cc: z.array(z.email().max(320)).max(5).default([]), subject: z.string().min(1).max(300).refine((s) => !/[\r\n]/.test(s)), body: z.string().min(1).max(20_000), generation: z.number().int().positive() }
export const ProposalPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('case_command'), command: z.enum(Object.keys(commandInput) as [ProposableCommand, ...ProposableCommand[]]), input: z.unknown() }).strict(),
  z.object({ kind: z.literal('approve_request'), package: z.object({ subject: z.string().min(1).max(300), body: z.string().min(1), evidenceAttachment: z.string().min(1).nullable().optional(), recipientEmail: z.email().max(320), recipientConfirmed: z.literal(true), requestedAmount: money, method: z.enum(['refund', 'credit', 'offset']) }).strict(), knownBeforeReclaim: z.boolean(), knownBeforeNote: text.nullable() }).strict(),
  z.object({ kind: z.literal('send_request'), ...sendFields, amountRequested: money, evidenceAttachment: z.string().nullable().default(null) }).strict(),
  z.object({ kind: z.literal('send_follow_up'), ...sendFields, sequence: z.number().int().min(1).max(5) }).strict(),
])
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>

/**
 * What each origin may propose. Text from a supplier or a model can suggest
 * a status or a follow-up date; it can never close a case, record money or
 * send anything by itself. Only Sid's return matcher (or a person) proposes a
 * settlement, and a person still approves it.
 */
const ALLOWED: Record<ProposalOrigin, ReadonlySet<string>> = {
  user: new Set(['case_command:*', 'approve_request', 'send_request', 'send_follow_up']),
  job: new Set(['send_follow_up', 'case_command:followup']),
  inbound: new Set(['case_command:vendor_update', 'case_command:followup', 'case_command:contact_hold']),
  ai: new Set(['case_command:vendor_update', 'case_command:followup', 'send_follow_up']),
  document: new Set(['case_command:vendor_update']),
  return_match: new Set(['case_command:settlement']),
}
const kindKey = (p: ProposalPayload) => (p.kind === 'case_command' ? `case_command:${p.command}` : p.kind)
export function originMayPropose(origin: ProposalOrigin, payload: ProposalPayload): boolean {
  const allowed = ALLOWED[origin]
  return allowed.has(kindKey(payload)) || (payload.kind === 'case_command' && allowed.has('case_command:*'))
}

const PERMISSION: Record<ProposalPayload['kind'], Permission> = { case_command: 'case.approve', approve_request: 'case.approve', send_request: 'case.approve', send_follow_up: 'case.approve' }

export interface ProposalInput {
  projectId: string
  findingId: string
  payload: ProposalPayload
  origin: ProposalOrigin
  reason: string
  /** Record ids, inbound message ids, document ids or match ids this rests on. */
  sourceRefs: string[]
  /** Re-proposing the same thing (a job run twice) returns the first proposal. */
  dedupeKey?: string
  /** Default seven days. */
  ttlMs?: number
}

export interface ProposalView {
  id: string; projectId: string; findingId: string; kind: ProposalPayload['kind']; actionType: string; origin: ProposalOrigin
  status: ProposalStatus; reason: string; sourceRefs: string[]; requiredPermission: Permission
  payload: ProposalPayload; payloadHash: string; caseFingerprint: string; caseRevision: number | null
  createdBy: string; createdAt: number; expiresAt: number; decidedBy: string | null; decidedAt: number | null
  decisionNote: string | null; resultCode: string | null; supersedes: string | null; commandId: string
  /** True when the case has changed since this was prepared. Computed on read. */
  stale: boolean
}

type Row = {
  id: string; project_id: string; finding_id: string; kind: ProposalPayload['kind']; action_type: string; origin: ProposalOrigin; status: ProposalStatus
  reason: string; source_refs: string; required_permission: Permission; payload_sealed: string; payload_hash: string; case_fingerprint: string
  case_revision: number | null; created_by: string; created_at: number; expires_at: number; decided_by: string | null; decided_at: number | null
  decision_note: string | null; result_code: string | null; supersedes: string | null; command_id: string; dedupe_key: string | null
}

export function migrateApprovals(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_proposals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      finding_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      action_type TEXT NOT NULL,
      origin TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      required_permission TEXT NOT NULL,
      payload_sealed TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      case_fingerprint TEXT NOT NULL,
      case_revision INTEGER,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_by TEXT,
      decided_at INTEGER,
      decision_note TEXT,
      result_code TEXT,
      supersedes TEXT,
      command_id TEXT NOT NULL,
      dedupe_key TEXT,
      FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS action_proposals_dedupe ON action_proposals(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS action_proposals_queue ON action_proposals(user_id, status, created_at);
    CREATE TABLE IF NOT EXISTS action_proposal_events (
      id INTEGER PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      code TEXT
    );
    CREATE INDEX IF NOT EXISTS action_proposal_events_p ON action_proposal_events(user_id, proposal_id, id);
  `)
}

export class ApprovalService {
  private readonly db: DatabaseSync
  private readonly sealer: Sealer
  private readonly getProject: (tenantId: string, projectId: string) => Record<string, unknown> | null
  private readonly revision: (tenantId: string, projectId: string) => number | null
  private readonly now: () => number
  /** Separation of duties: the approver must differ from whoever prepared it. Off while every tenant is one person (tenant.ts). */
  private readonly distinctApprover: (tenant: TenantContext) => boolean

  constructor(deps: { db: DatabaseSync; sealer: Sealer; getProject: (tenantId: string, projectId: string) => Record<string, unknown> | null; revision: (tenantId: string, projectId: string) => number | null; now?: () => number; distinctApprover?: (tenant: TenantContext) => boolean }) {
    this.db = deps.db
    this.sealer = deps.sealer
    this.getProject = deps.getProject
    this.revision = deps.revision
    this.now = deps.now ?? Date.now
    this.distinctApprover = deps.distinctApprover ?? ((t) => t.source !== 'single_user_fixture')
    migrateApprovals(this.db)
  }

  private context = (tenantId: string, id: string) => `proposal:${tenantId}:${id}`

  private event(tenantId: string, id: string, actor: string, event: string, code: string | null = null) {
    this.db.prepare('INSERT INTO action_proposal_events (user_id, proposal_id, at, actor, event, code) VALUES (?, ?, ?, ?, ?, ?)').run(tenantId, id, this.now(), actor, event, code)
  }

  private fingerprint(tenantId: string, projectId: string, findingId: string): string | null {
    return storedCase(this.getProject(tenantId, projectId), findingId)?.fingerprint ?? null
  }

  private row(tenantId: string, id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM action_proposals WHERE user_id = ? AND id = ?').get(tenantId, id) as Row | undefined
  }

  private view(tenantId: string, row: Row): ProposalView {
    const current = row.status === 'pending' ? this.fingerprint(tenantId, row.project_id, row.finding_id) : row.case_fingerprint
    return {
      id: row.id, projectId: row.project_id, findingId: row.finding_id, kind: row.kind, actionType: row.action_type, origin: row.origin, status: row.status,
      reason: row.reason, sourceRefs: JSON.parse(row.source_refs) as string[], requiredPermission: row.required_permission,
      payload: this.sealer.open<ProposalPayload>(this.context(tenantId, row.id), row.payload_sealed), payloadHash: row.payload_hash,
      caseFingerprint: row.case_fingerprint, caseRevision: row.case_revision, createdBy: row.created_by, createdAt: row.created_at, expiresAt: row.expires_at,
      decidedBy: row.decided_by, decidedAt: row.decided_at, decisionNote: row.decision_note, resultCode: row.result_code, supersedes: row.supersedes, commandId: row.command_id,
      stale: current !== row.case_fingerprint,
    }
  }

  /** Validates, binds to the current case version, and queues. */
  propose(tenant: TenantContext, input: ProposalInput, supersedes: string | null = null): ProposalView {
    requirePermission(tenant, 'case.propose')
    const parsed = ProposalPayloadSchema.safeParse(input.payload)
    if (!parsed.success) throw new HttpError(400, 'The proposed action is malformed.', 'validation')
    const payload = parsed.data
    if (payload.kind === 'case_command') {
      const check = commandInput[payload.command].safeParse(payload.input)
      if (!check.success) throw new HttpError(400, 'The proposed case change is malformed.', 'validation')
      payload.input = check.data
    }
    if (!originMayPropose(input.origin, payload)) throw new HttpError(403, `A ${input.origin} proposal cannot ${kindKey(payload).replace('case_command:', '')}.`, 'proposal_not_allowed')
    const project = this.getProject(tenant.tenantId, input.projectId)
    const c = storedCase(project, input.findingId)
    if (!c) throw new HttpError(404, 'That case is not in this account.')
    if ((payload.kind === 'send_request' || payload.kind === 'send_follow_up') && c.mode === 'sample') throw new HttpError(403, 'Sample audits cannot send external email.', 'sample_outreach_disabled')
    if (input.dedupeKey) {
      const existing = this.db.prepare('SELECT * FROM action_proposals WHERE user_id = ? AND dedupe_key = ?').get(tenant.tenantId, input.dedupeKey) as Row | undefined
      if (existing) return this.view(tenant.tenantId, existing)
    }
    const id = randomUUID()
    const at = this.now()
    const payloadHash = hashJson(payload)
    this.db.prepare(`INSERT INTO action_proposals (id, user_id, project_id, finding_id, kind, action_type, origin, status, reason, source_refs, required_permission, payload_sealed, payload_hash, case_fingerprint, case_revision, created_by, created_at, expires_at, supersedes, command_id, dedupe_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenant.tenantId, input.projectId, input.findingId, payload.kind, kindKey(payload), input.origin, input.reason.slice(0, 500), JSON.stringify(input.sourceRefs.slice(0, 50)),
        PERMISSION[payload.kind], this.sealer.seal(this.context(tenant.tenantId, id), payload), payloadHash, c.fingerprint, this.revision(tenant.tenantId, input.projectId),
        tenant.actorLabel, at, at + (input.ttlMs ?? 7 * 86_400_000), supersedes, randomUUID(), input.dedupeKey ?? null)
    this.event(tenant.tenantId, id, tenant.actorLabel, 'proposed', input.origin)
    return this.view(tenant.tenantId, this.row(tenant.tenantId, id)!)
  }

  get(tenant: TenantContext, id: string): ProposalView {
    requirePermission(tenant, 'case.read')
    const row = this.row(tenant.tenantId, id)
    if (!row) throw new HttpError(404, 'That proposal is not in this account.')
    return this.view(tenant.tenantId, row)
  }

  /** The account-wide queue. Expired proposals are marked on the way past. */
  list(tenant: TenantContext, filter: { status?: ProposalStatus; projectId?: string; findingId?: string } = {}): ProposalView[] {
    requirePermission(tenant, 'case.read')
    this.db.prepare("UPDATE action_proposals SET status = 'expired' WHERE user_id = ? AND status = 'pending' AND expires_at <= ?").run(tenant.tenantId, this.now())
    const rows = this.db.prepare(`SELECT * FROM action_proposals WHERE user_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR project_id = ?) AND (? IS NULL OR finding_id = ?) ORDER BY created_at DESC LIMIT 200`)
      .all(tenant.tenantId, filter.status ?? null, filter.status ?? null, filter.projectId ?? null, filter.projectId ?? null, filter.findingId ?? null, filter.findingId ?? null) as Row[]
    return rows.map((r) => this.view(tenant.tenantId, r))
  }

  events(tenant: TenantContext, id: string) {
    requirePermission(tenant, 'case.read')
    return this.db.prepare('SELECT at, actor, event, code FROM action_proposal_events WHERE user_id = ? AND proposal_id = ? ORDER BY id').all(tenant.tenantId, id)
  }

  reject(tenant: TenantContext, id: string, note: string | null): ProposalView {
    requirePermission(tenant, 'case.approve')
    const res = this.db.prepare("UPDATE action_proposals SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE user_id = ? AND id = ? AND status = 'pending'")
      .run(tenant.actorLabel, this.now(), note?.slice(0, 1000) ?? null, tenant.tenantId, id)
    if (Number(res.changes) !== 1) throw new HttpError(409, 'Only a pending proposal can be rejected.', 'proposal_not_pending')
    this.event(tenant.tenantId, id, tenant.actorLabel, 'rejected')
    return this.get(tenant, id)
  }

  /** A person changed the payload: the old proposal is superseded and the new one needs its own approval. */
  edit(tenant: TenantContext, id: string, payload: ProposalPayload): ProposalView {
    requirePermission(tenant, 'case.propose')
    const old = this.get(tenant, id)
    if (old.status !== 'pending') throw new HttpError(409, 'Only a pending proposal can be edited.', 'proposal_not_pending')
    if (payload.kind !== old.payload.kind) throw new HttpError(400, 'An edit cannot change the kind of action.', 'validation')
    const next = this.propose(tenant, { projectId: old.projectId, findingId: old.findingId, payload, origin: 'user', reason: `Edited: ${old.reason}`.slice(0, 500), sourceRefs: old.sourceRefs }, old.id)
    this.db.prepare("UPDATE action_proposals SET status = 'superseded', decided_by = ?, decided_at = ? WHERE user_id = ? AND id = ? AND status = 'pending'").run(tenant.actorLabel, this.now(), tenant.tenantId, id)
    this.event(tenant.tenantId, id, tenant.actorLabel, 'superseded', next.id)
    return next
  }

  /**
   * The approver's word on exactly `payloadHash`. Checks expiry, separation of
   * duties and that the case is unchanged, then claims the proposal for
   * execution so a double click can't run it twice.
   */
  claimForExecution(tenant: TenantContext, id: string, payloadHash: string): ProposalView {
    const p = this.get(tenant, id)
    requirePermission(tenant, p.requiredPermission)
    if (p.status !== 'pending') throw new HttpError(409, p.status === 'executing' ? 'This action is running right now.' : `This proposal is ${p.status}.`, 'proposal_not_pending')
    if (p.payloadHash !== payloadHash) throw new HttpError(409, 'The action changed since you reviewed it. Review it again.', 'not_approved_version')
    if (p.expiresAt <= this.now()) {
      this.db.prepare("UPDATE action_proposals SET status = 'expired' WHERE user_id = ? AND id = ? AND status = 'pending'").run(tenant.tenantId, id)
      throw new HttpError(409, 'This proposal has expired. Prepare it again.', 'proposal_expired')
    }
    if (this.distinctApprover(tenant) && p.createdBy === tenant.actorLabel) throw new HttpError(403, 'Someone other than the person who prepared this must approve it.', 'separation_of_duties')
    if (p.stale) {
      this.db.prepare("UPDATE action_proposals SET status = 'stale', decided_at = ? WHERE user_id = ? AND id = ? AND status = 'pending'").run(this.now(), tenant.tenantId, id)
      this.event(tenant.tenantId, id, tenant.actorLabel, 'stale')
      throw new HttpError(409, 'The case changed after this was prepared. Prepare it again from the current case.', 'proposal_stale')
    }
    const res = this.db.prepare("UPDATE action_proposals SET status = 'executing', decided_by = ?, decided_at = ? WHERE user_id = ? AND id = ? AND status = 'pending' AND payload_hash = ?")
      .run(tenant.actorLabel, this.now(), tenant.tenantId, id, payloadHash)
    if (Number(res.changes) !== 1) throw new HttpError(409, 'This action is running right now.', 'proposal_not_pending')
    this.event(tenant.tenantId, id, tenant.actorLabel, 'approved')
    return { ...p, status: 'executing' }
  }

  finish(tenant: TenantContext, id: string, ok: boolean, code: string | null): ProposalView {
    this.db.prepare("UPDATE action_proposals SET status = ?, result_code = ? WHERE user_id = ? AND id = ? AND status = 'executing'").run(ok ? 'executed' : 'failed', code, tenant.tenantId, id)
    this.event(tenant.tenantId, id, tenant.actorLabel, ok ? 'executed' : 'failed', code)
    return this.get(tenant, id)
  }

  /** Startup: a proposal the process died while executing needs a person to check what happened. */
  recoverInterrupted(): number {
    return Number(this.db.prepare("UPDATE action_proposals SET status = 'failed', result_code = 'interrupted' WHERE status = 'executing'").run().changes)
  }
}
