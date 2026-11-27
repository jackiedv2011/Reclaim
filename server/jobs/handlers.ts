/**
 * Recovery jobs (J3): the scan planner, reminders, follow-up preparation,
 * evidence-gap tasks and the digest.
 *
 * None of these sends, settles, edits books or moves a case. The most a job
 * does is put an exact follow-up in the approval queue (approvals.ts) and
 * leave an internal notification; a person approves or ignores it. Every
 * handler re-reads the stored case at run time and stops if it changed since
 * the job was planned (the case fingerprint is in the payload).
 */
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { evaluateEligibility } from '../../src/recovery/eligibility.ts'
import { activeReturned } from '../../src/recovery/financials.ts'
import { followUpStatus } from '../../src/recovery/model.ts'
import { latestVendorPosition, VENDOR_STATUS } from '../../src/recovery/vendorStatus.ts'
import type { ApprovalService } from '../approvals.ts'
import { authorizedFollowUpFacts, requestGeneration } from '../caseFacts.ts'
import { MAX_FOLLOW_UPS, MIN_FOLLOW_UP_GAP_MS } from '../gmail.ts'
import type { ProjectStore } from '../projectStore.ts'
import { caseIds, storedCase, type StoredCase } from '../recoveryFacts.ts'
import { sha256 } from '../sealedJson.ts'
import { requirePermission, type TenantContext } from '../tenant.ts'
import { followUpText } from './followUpText.ts'
import { localParts, type DigestTransport, type NotificationInput, type NotificationStore } from './notifications.ts'
import { JobError, type JobContext, type JobRunner } from './runner.ts'

export const JOB_KINDS = {
  scan: 'recovery.scan',
  reminder: 'recovery.reminder',
  prepareFollowUp: 'recovery.prepare_follow_up',
  collectEvidence: 'recovery.collect_evidence',
  digest: 'notify.digest',
} as const

export interface HandlerDeps {
  db: DatabaseSync
  projects: Pick<ProjectStore, 'list' | 'get'>
  approvals: ApprovalService
  notifications: NotificationStore
  /** Null: digests are planned but not delivered (no transport configured). */
  digestTransport(): DigestTransport | null
}

const ref = z.string().regex(/^[\w:.-]{1,500}$/)
const fingerprint = z.string().regex(/^[a-f0-9]{64}$/)
const CasePayload = z.object({ projectId: ref, findingId: ref, fingerprint }).strict()
const FollowUpPayload = CasePayload.extend({ generation: z.number().int().positive(), sequence: z.number().int().positive() }).strict()
const ScanPayload = z.object({ projectId: ref.optional() }).strict()
const DigestPayload = z.object({ localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict()

const short = (parts: string[]) => sha256(parts.join('|')).slice(0, 24)
const isRecovery = (c: StoredCase) => c.finding.classification === 'recovery_candidate'

/**
 * The reminders a case warrants right now, each with a key that changes only
 * when the reason does. Pure: the planner and the handler both use it.
 * Internal reviews (findings that aren't recovery candidates) never remind.
 */
export function caseReminders(c: StoredCase, projectId: string, findingId: string, generation: number, now: number): NotificationInput[] {
  if (!isRecovery(c) || c.mode === 'sample') return []
  const s = c.state
  const at = (kind: NotificationInput['kind'], key: string, dueAt: number | null): NotificationInput => ({ kind, dedupeKey: `${kind}:${projectId}:${findingId}:${key}`, projectId, findingId, dueAt })
  const out: NotificationInput[] = []
  if (s.recoveryStage === 'confirmed' && !s.approvedAt && !s.contactHold && !s.requiresRevalidation) out.push(at('awaiting_approval', `g${generation}`, null))
  if (s.recoveryStage === 'requested' && !s.requiresRevalidation) {
    const reply = latestVendorPosition(s)
    if (reply && VENDOR_STATUS[reply.status].needsAction) out.push(at('vendor_reply', `g${generation}:${reply.at}`, reply.at))
    const fu = followUpStatus(s, now)
    if (fu?.due && fu.sequence <= MAX_FOLLOW_UPS && !(reply && VENDOR_STATUS[reply.status].needsAction)) out.push(at('follow_up_due', `g${generation}:s${fu.sequence}:${fu.dueAt}`, fu.dueAt))
  }
  if (s.recoveryStage === 'recovered' && (activeReturned(s) <= 0 || !s.reconciledAt)) out.push(at('unreconciled_return', `g${generation}`, null))
  return out
}

/** What Gmail's own ledger says about follow-ups on this request (empty when Gmail was never set up). */
function gmailHistory(db: DatabaseSync, tenantId: string, projectId: string, findingId: string, generation: number) {
  const has = (t: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t))
  const key = [tenantId, projectId, findingId, generation] as const
  const followUps = has('gmail_follow_ups')
    ? db.prepare('SELECT status, sent_at FROM gmail_follow_ups WHERE user_id = ? AND project_id = ? AND finding_id = ? AND generation = ?').all(...key) as Array<{ status: string; sent_at: number | null }>
    : []
  const request = has('gmail_sends')
    ? db.prepare("SELECT sent_at FROM gmail_sends WHERE user_id = ? AND project_id = ? AND finding_id = ? AND generation = ? AND status = 'sent'").get(...key) as { sent_at: number | null } | undefined
    : undefined
  const sent = followUps.filter((r) => r.status === 'sent')
  return {
    sentFollowUps: sent.length,
    /** A send is underway or its outcome is unknown: a person must check Gmail first. */
    inFlight: followUps.some((r) => r.status === 'sending' || r.status === 'uncertain'),
    lastSentAt: Math.max(0, request?.sent_at ?? 0, ...sent.map((r) => r.sent_at ?? 0)),
  }
}

type Loaded = { ok: true; project: Record<string, unknown>; c: StoredCase; generation: number } | { ok: false; code: string }

/** The case as stored now, if it is still the version the job was planned for. */
function loadCase(deps: HandlerDeps, tenant: TenantContext, p: { projectId: string; findingId: string; fingerprint: string }): Loaded {
  requirePermission(tenant, 'case.read')
  const project = deps.projects.get(tenant.tenantId, p.projectId)
  const c = storedCase(project, p.findingId)
  if (!project || !c) return { ok: false, code: 'skipped_case_gone' }
  if (c.fingerprint !== p.fingerprint) return { ok: false, code: 'skipped_case_changed' }
  return { ok: true, project, c, generation: requestGeneration(project, p.findingId) }
}

export function registerRecoveryJobs(runner: JobRunner, deps: HandlerDeps): void {
  const { approvals, notifications } = deps

  // ---------- recovery.scan: plan per-case jobs for one tenant ----------
  runner.register(JOB_KINDS.scan, {
    payloadSchema: ScanPayload,
    timeoutMs: 120_000,
    maxAttempts: 3,
    async handler(ctx: JobContext<z.infer<typeof ScanPayload>>) {
      const { tenant, now } = ctx
      requirePermission(tenant, 'case.read')
      const tenantId = tenant.tenantId
      // Sorted, so a checkpoint ("done up to project X") means the same thing on the next attempt.
      const projects = deps.projects.list(tenantId)
        .filter((p) => typeof p.id === 'string' && (!ctx.payload.projectId || p.id === ctx.payload.projectId))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      const after = ctx.checkpoint.get<{ after: string }>()?.after ?? null
      const pending = approvals.list(tenant, { status: 'pending' })
      let planned = 0
      for (const project of projects) {
        const projectId = String(project.id)
        if (after !== null && projectId <= after) continue
        if (ctx.signal.aborted) throw new JobError('aborted')
        // Sample audits are demonstrations: no reminders, no outreach.
        if (project.mode === 'sample' || !/^[\w:.-]{1,500}$/.test(projectId)) {
          ctx.checkpoint.set({ after: projectId })
          continue
        }
        for (const findingId of caseIds(project)) {
          const c = storedCase(project, findingId)
          if (!c || !isRecovery(c) || !/^[\w:.-]{1,500}$/.test(findingId)) continue
          const generation = requestGeneration(project, findingId)
          const base = { projectId, findingId, fingerprint: c.fingerprint }
          const enqueue = (kind: string, payload: unknown, key: string) => {
            if (runner.enqueue(tenantId, kind, payload, { idempotencyKey: key, runAt: now, now }).created) planned++
          }

          const reasons = caseReminders(c, projectId, findingId, generation, now).map((r) => r.dedupeKey)
          const proposals = pending.filter((p) => p.projectId === projectId && p.findingId === findingId).map((p) => p.id)
          if (reasons.length || proposals.length) enqueue(JOB_KINDS.reminder, base, `reminder:${projectId}:${findingId}:${short([c.fingerprint, ...reasons, ...proposals])}`)

          const fu = followUpStatus(c.state, now)
          if (fu?.due && fu.sequence <= MAX_FOLLOW_UPS) {
            enqueue(JOB_KINDS.prepareFollowUp, { ...base, generation, sequence: fu.sequence }, `follow_up:${projectId}:${findingId}:g${generation}:s${fu.sequence}:${c.fingerprint}`)
          }

          if ((c.state.recoveryStage === 'confirmed' || (c.state.recoveryStage == null && c.state.decision === 'confirmed')) && !evaluateEligibility(c.finding, c.finding.evidence, c.findings).eligible) {
            enqueue(JOB_KINDS.collectEvidence, base, `evidence:${projectId}:${findingId}:${c.fingerprint}`)
          }
        }
        ctx.checkpoint.set({ after: projectId })
      }
      return { code: planned ? 'planned' : 'nothing_to_plan' }
    },
  })

  // ---------- recovery.reminder: internal notifications for one case ----------
  runner.register(JOB_KINDS.reminder, {
    payloadSchema: CasePayload,
    async handler(ctx: JobContext<z.infer<typeof CasePayload>>) {
      const loaded = loadCase(deps, ctx.tenant, ctx.payload)
      if (!loaded.ok) return { code: loaded.code }
      const { projectId, findingId } = ctx.payload
      if (loaded.c.mode === 'sample') return { code: 'skipped_sample' }
      let added = 0
      for (const n of caseReminders(loaded.c, projectId, findingId, loaded.generation, ctx.now)) if (notifications.add(ctx.tenant.tenantId, n, ctx.now)) added++
      for (const p of approvals.list(ctx.tenant, { status: 'pending', projectId, findingId })) {
        if (p.stale) continue
        if (notifications.add(ctx.tenant.tenantId, { kind: 'proposal_pending', dedupeKey: `proposal_pending:${p.id}`, projectId, findingId, refId: p.id, dueAt: null }, ctx.now)) added++
      }
      return { code: added ? 'notified' : 'nothing_new' }
    },
  })

  // ---------- recovery.prepare_follow_up: queue an exact follow-up for approval ----------
  runner.register(JOB_KINDS.prepareFollowUp, {
    payloadSchema: FollowUpPayload,
    async handler(ctx: JobContext<z.infer<typeof FollowUpPayload>>) {
      const { tenant, now, payload } = ctx
      requirePermission(tenant, 'case.propose')
      const loaded = loadCase(deps, tenant, payload)
      if (!loaded.ok) return { code: loaded.code }
      const { project, c, generation } = loaded
      const { projectId, findingId } = payload
      const s = c.state
      if (project.mode === 'sample' || c.mode === 'sample') return { code: 'skipped_sample' }
      if (generation !== payload.generation) return { code: 'skipped_generation_changed' }
      if (!isRecovery(c)) return { code: 'skipped_not_recovery' }
      if (s.recoveryStage !== 'requested') return { code: 'skipped_case_closed' }
      if (s.requiresRevalidation) return { code: 'skipped_revalidation' }
      if (s.contactHold) return { code: 'skipped_contact_hold' }
      const reply = latestVendorPosition(s)
      if (reply && VENDOR_STATUS[reply.status].needsAction) return { code: 'skipped_vendor_needs_action' }
      const fu = followUpStatus(s, now)
      if (!fu) return { code: 'skipped_not_open' }
      if (fu.repliedAt !== null) return { code: 'skipped_vendor_replied' }
      if (fu.sequence !== payload.sequence) return { code: 'skipped_sequence_changed' }
      if (fu.sequence > MAX_FOLLOW_UPS) return { code: 'skipped_follow_up_limit' }
      if (!fu.due) return { code: 'not_due', deferUntil: fu.dueAt }
      const facts = authorizedFollowUpFacts(project, findingId)
      if (!facts.ok) return { code: 'skipped_not_authorized' }
      if (!facts.to) return { code: 'skipped_no_recipient' }

      const gmail = gmailHistory(deps.db, tenant.tenantId, projectId, findingId, generation)
      if (gmail.inFlight) return { code: 'skipped_send_in_flight' }
      if (gmail.sentFollowUps !== fu.sequence - 1) return { code: 'skipped_sequence_mismatch' }
      const lastEmail = Math.max(fu.lastOutreachAt, gmail.lastSentAt)
      if (now - lastEmail < MIN_FOLLOW_UP_GAP_MS) return { code: 'deferred_min_gap', deferUntil: lastEmail + MIN_FOLLOW_UP_GAP_MS }

      // One follow-up per sequence in the queue, whoever prepared it.
      const queued = approvals.list(tenant, { status: 'pending', projectId, findingId })
        .find((p) => p.kind === 'send_follow_up' && !p.stale && p.payload.kind === 'send_follow_up' && p.payload.sequence === fu.sequence && p.payload.generation === generation)
      if (queued) return { code: 'already_proposed' }

      const user = deps.db.prepare('SELECT first_name, last_name, company FROM users WHERE id = ?').get(tenant.tenantId) as { first_name: string; last_name: string; company: string } | undefined
      if (!user) throw new JobError('tenant_gone', { retryable: false })
      const letter = followUpText(c.finding, s, { senderName: `${user.first_name} ${user.last_name}`.trim(), businessName: user.company, senderEmail: '' }, fu.lastOutreachAt)

      const proposal = approvals.propose(tenant, {
        projectId, findingId, origin: 'job',
        payload: { kind: 'send_follow_up', to: facts.to, cc: facts.cc, subject: letter.subject, body: letter.body, generation, sequence: fu.sequence },
        reason: `Follow-up ${fu.sequence} of ${MAX_FOLLOW_UPS} is due: no reply since the last email. Review the text and recipients before approving.`,
        sourceRefs: [`job:${ctx.jobId}`],
        dedupeKey: `job:follow_up:${projectId}:${findingId}:g${generation}:s${fu.sequence}:${c.fingerprint}`,
      })
      if (proposal.status !== 'pending') return { code: 'already_decided' }
      notifications.add(tenant.tenantId, { kind: 'follow_up_prepared', dedupeKey: `follow_up_prepared:${proposal.id}`, projectId, findingId, refId: proposal.id, dueAt: fu.dueAt }, now)
      return { code: 'proposed' }
    },
  })

  // ---------- recovery.collect_evidence: an internal task, nothing else ----------
  runner.register(JOB_KINDS.collectEvidence, {
    payloadSchema: CasePayload,
    async handler(ctx: JobContext<z.infer<typeof CasePayload>>) {
      const loaded = loadCase(deps, ctx.tenant, ctx.payload)
      if (!loaded.ok) return { code: loaded.code }
      const { c } = loaded
      if (c.mode === 'sample' || !isRecovery(c)) return { code: 'skipped_not_recovery' }
      const gate = evaluateEligibility(c.finding, c.finding.evidence, c.findings)
      if (gate.eligible) return { code: 'skipped_no_gap' }
      const { projectId, findingId, fingerprint: fp } = ctx.payload
      notifications.add(ctx.tenant.tenantId, {
        kind: 'evidence_gap', dedupeKey: `evidence_gap:${projectId}:${findingId}:${fp}`, projectId, findingId, dueAt: null,
        detail: { missing: gate.missingEvidence.length, contradictions: gate.contradictoryEvidence.length },
      }, ctx.now)
      return { code: 'notified' }
    },
  })

  // ---------- notify.digest: one opt-in summary per local day ----------
  runner.register(JOB_KINDS.digest, {
    payloadSchema: DigestPayload,
    maxAttempts: 4,
    backoff: { baseMs: 5 * 60_000, maxMs: 60 * 60_000 },
    async handler(ctx: JobContext<z.infer<typeof DigestPayload>>) {
      const { tenant, now, payload } = ctx
      requirePermission(tenant, 'case.read')
      const prefs = notifications.preferences(tenant.tenantId)
      if (!prefs.digestEnabled) return { code: 'skipped_disabled' }
      const local = localParts(now, prefs.timeZone)
      if (local.date !== payload.localDate) return { code: 'skipped_day_passed' }
      if (local.hour < prefs.localHour) return { code: 'not_yet', deferUntil: now + 15 * 60_000 }
      if (prefs.lastDigestOn === payload.localDate) return { code: 'skipped_already_sent' }
      const digest = notifications.digest(tenant.tenantId, now, local.date, prefs.timeZone)
      if (digest.total === 0) {
        notifications.markDigestSent(tenant.tenantId, local.date, now)
        return { code: 'nothing_to_send' }
      }
      const transport = deps.digestTransport()
      if (!transport) return { code: 'skipped_no_transport' }
      try {
        await transport.send({ tenantId: tenant.tenantId, digest, idempotencyKey: `digest:${tenant.tenantId}:${local.date}` }, ctx.signal)
      } catch {
        throw new JobError('digest_transport_failed')
      }
      notifications.markDigestSent(tenant.tenantId, local.date, now)
      return { code: 'sent' }
    },
  })
}

/** Tenants who saved at least one audit. */
function tenantsWithProjects(db: DatabaseSync): string[] {
  return (db.prepare('SELECT DISTINCT user_id FROM projects').all() as Array<{ user_id: string }>).map((r) => r.user_id)
}

/** One scan per tenant per UTC day (idempotent: call it as often as you like). */
export function planDailyScans(runner: JobRunner, db: DatabaseSync, now: number): number {
  const day = new Date(now).toISOString().slice(0, 10)
  let n = 0
  for (const tenantId of tenantsWithProjects(db)) if (runner.enqueue(tenantId, JOB_KINDS.scan, {}, { idempotencyKey: `scan:daily:${day}`, runAt: now, now }).created) n++
  return n
}

/** A digest for each subscriber whose local hour has come today and who hasn't had one. */
export function planDigests(runner: JobRunner, notifications: NotificationStore, now: number): number {
  let n = 0
  for (const sub of notifications.digestSubscribers()) {
    const local = localParts(now, sub.timeZone)
    if (local.hour < sub.localHour || sub.lastDigestOn === local.date) continue
    if (runner.enqueue(sub.tenantId, JOB_KINDS.digest, { localDate: local.date }, { idempotencyKey: `digest:${local.date}`, runAt: now, now }).created) n++
  }
  return n
}
