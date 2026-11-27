// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createApp } from '../app.ts'
import { loadConfig } from '../config.ts'
import { openDatabase } from '../db.ts'
import { DevMailer } from '../mailer.ts'
import { ProjectStore } from '../projectStore.ts'
import { storedCase } from '../recoveryFacts.ts'
import { tenantForUser } from '../tenant.ts'
import { ApprovalService, type ProposalView } from '../approvals.ts'
import { createSealer } from '../sealedJson.ts'
import { followUpText } from './followUpText.ts'
import { JOB_KINDS } from './handlers.ts'
import { RecordingDigestTransport } from './notifications.ts'
import { createJobSystem, jobSystemFor, type JobSystem } from './system.ts'
import { AMOUNT, DAY, VENDOR, VENDOR_EMAIL, addUser, awaitingApprovalProject, fingerprintOf, requestedProject } from './testFixtures.ts'

const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0', SESSION_DAYS: '1', REMEMBER_ME_DAYS: '30' })
const T0 = Date.UTC(2026, 10, 25, 15, 0, 0)
const A = 'user-a'
const B = 'user-b'

let db: DatabaseSync
let jobs: JobSystem
let store: ProjectStore
let clock: number

beforeEach(() => {
  clock = T0
  db = openDatabase(':memory:')
  // The app wires the job system to this database exactly as production does.
  createApp({ config, db, mailer: new DevMailer(db), now: () => clock })
  jobs = jobSystemFor(db)!
  store = new ProjectStore(db, config.dataKeys)
  addUser(db, A, 'Pat', 'Lee', 'Customer Co')
  addUser(db, B, 'Sam', 'Roe', 'Other Co')
})
afterEach(() => db.close())

type Built = { project: Record<string, unknown>; findingId: string }
const seed = (tenant: string, built: Built) => {
  store.upsert(tenant, built.project)
  return built
}
const run = (at = clock) => jobs.runDue(at, 'test-worker')
const tenantCtx = (tenant: string) => tenantForUser({ id: tenant, email: `${tenant}@customer.example` })
/** A second service over the same tables reads and decides the same proposals the jobs made. */
const jobsApprovals = () => new ApprovalService({ db, sealer: createSealer(config.dataKeys), getProject: (t, p) => store.get(t, p), revision: (t, p) => store.revision(t, p), now: () => clock })
const pendingProposals = (tenant: string): ProposalView[] => jobsApprovals().list(tenantCtx(tenant), { status: 'pending' })
const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n
const notificationKinds = (tenant: string) => jobs.notifications.list(tenant).map((n) => n.kind).sort()

/** Enqueues a follow-up preparation for the case as stored now, runs it, returns the result. */
async function prepare(tenant: string, built: Built, opts: { sequence?: number; generation?: number; at?: number } = {}) {
  seed(tenant, built)
  const projectId = String(built.project.id)
  const fingerprint = fingerprintOf(store.get(tenant, projectId), built.findingId)
  jobs.enqueue(tenant, JOB_KINDS.prepareFollowUp, { projectId, findingId: built.findingId, fingerprint, generation: opts.generation ?? 1, sequence: opts.sequence ?? 1 }, { runAt: opts.at ?? clock })
  const [result] = await run(opts.at ?? clock)
  return result
}

describe('recovery.prepare_follow_up', () => {
  it('queues the exact deterministic follow-up for approval and sends nothing', async () => {
    const built = requestedProject('p1', { sentAt: T0 - 10 * DAY })
    const result = await prepare(A, built)
    expect(result).toMatchObject({ status: 'done', code: 'proposed' })

    const [p] = pendingProposals(A)
    const stored = store.get(A, 'p1')
    const c = storedCase(stored, built.findingId)!
    const expected = followUpText(c.finding, c.state, { senderName: 'Pat Lee', businessName: 'Customer Co', senderEmail: '' }, T0 - 10 * DAY)
    expect(p).toMatchObject({ origin: 'job', kind: 'send_follow_up', status: 'pending', stale: false, createdBy: 'Reclaim (recovery.prepare_follow_up)' })
    expect(p.payload).toEqual({ kind: 'send_follow_up', to: VENDOR_EMAIL, cc: ['controller@customer.example'], subject: expected.subject, body: expected.body, generation: 1, sequence: 1 })
    expect(p.payload.kind === 'send_follow_up' && p.payload.body).toMatch(/Pat Lee\nCustomer Co/)

    // Nothing went out and nothing on the case says it did.
    expect(count('SELECT COUNT(*) AS n FROM gmail_follow_ups')).toBe(0)
    expect(count('SELECT COUNT(*) AS n FROM gmail_sends')).toBe(0)
    expect(c.state.recoveryFollowUps).toBeUndefined()
    expect(store.revision(A, 'p1')).toBe(1)
    expect(notificationKinds(A)).toEqual(['follow_up_prepared'])
  })

  it('never proposes twice for the same case version, however often it reruns', async () => {
    const built = seed(A, requestedProject('p1', { sentAt: T0 - 10 * DAY }))
    jobs.enqueue(A, JOB_KINDS.scan, {}, { idempotencyKey: 'scan-1', runAt: clock })
    await run()
    jobs.enqueue(A, JOB_KINDS.scan, {}, { idempotencyKey: 'scan-2', runAt: clock })
    await run()
    // Even a job planned separately for the same case finds the proposal already queued.
    const fingerprint = fingerprintOf(store.get(A, 'p1'), built.findingId)
    jobs.enqueue(A, JOB_KINDS.prepareFollowUp, { projectId: 'p1', findingId: built.findingId, fingerprint, generation: 1, sequence: 1 }, { idempotencyKey: 'manual', runAt: clock })
    const [again] = await run()
    expect(again.code).toBe('already_proposed')
    expect(pendingProposals(A)).toHaveLength(1)
    expect(count("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'recovery.prepare_follow_up'")).toBe(2)
  })

  it('a rejected follow-up is not prepared again until the case changes', async () => {
    const built = requestedProject('p1', { sentAt: T0 - 10 * DAY })
    await prepare(A, built)
    const [p] = pendingProposals(A)
    jobsApprovals().reject(tenantCtx(A), p.id, null)
    jobs.enqueue(A, JOB_KINDS.scan, {}, { idempotencyKey: 'scan-again', runAt: clock })
    await run()
    expect(pendingProposals(A)).toHaveLength(0)
    expect(count('SELECT COUNT(*) AS n FROM action_proposals')).toBe(1)
  })

  it('waits until the follow-up is due', async () => {
    const result = await prepare(A, requestedProject('p1', { sentAt: T0 - 2 * DAY }))
    expect(result).toMatchObject({ status: 'queued', code: 'not_due' })
    expect(pendingProposals(A)).toHaveLength(0)
    const [later] = await run(T0 + 5 * DAY)
    expect(later.code).toBe('proposed')
  })

  it('keeps 24 hours between emails', async () => {
    // The customer recorded a follow-up an hour ago but the scheduled date has passed.
    const built = requestedProject('p1', { sentAt: T0 - 10 * DAY, followUpAt: T0 - DAY, state: { vendorUpdates: [{ at: T0 - 3_600_000, status: 'followed_up', note: 'Called' }] } })
    const result = await prepare(A, built)
    expect(result).toMatchObject({ status: 'queued', code: 'deferred_min_gap' })
    expect(jobs.runner.list(A)[0].runAt).toBe(T0 - 3_600_000 + DAY)
    expect(await run(T0 + DAY - 3_600_001)).toEqual([])
    const [later] = await run(T0 + DAY - 3_600_000)
    expect(later.code).toBe('proposed')
  })

  it('counts Gmail’s own record of the last email toward the 24 hours', async () => {
    const built = seed(A, requestedProject('p1', { sentAt: T0 - 10 * DAY }))
    db.prepare("INSERT INTO gmail_sends (user_id, project_id, finding_id, generation, status, from_email, to_email, amount_minor, created_at, sent_at) VALUES (?, 'p1', ?, 1, 'sent', 'a', 'b', 1, 1, ?)").run(A, built.findingId, T0 - 2 * 3_600_000)
    expect((await prepare(A, built)).code).toBe('deferred_min_gap')
  })

  it('stops at five follow-ups', async () => {
    const sent = Array.from({ length: 5 }, (_, i) => ({ channel: 'gmail', messageId: `f${i}`, from: 'x', to: VENDOR_EMAIL, cc: [], sentAt: T0 - (20 - i) * DAY }))
    const built = requestedProject('p1', { sentAt: T0 - 30 * DAY, followUpAt: T0 - DAY, state: { recoveryFollowUps: sent } })
    expect((await prepare(A, built, { sequence: 6 })).code).toBe('skipped_follow_up_limit')
    // And the planner doesn't even queue it.
    jobs.enqueue(A, JOB_KINDS.scan, {}, { idempotencyKey: 's', runAt: clock })
    await run()
    expect(count("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'recovery.prepare_follow_up'")).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM action_proposals')).toBe(0)
  })

  it.each([
    ['contact hold', { contactHold: 'Legal is reviewing this supplier' }, 'skipped_contact_hold'],
    ['revalidation', { requiresRevalidation: true }, 'skipped_revalidation'],
    ['a dispute', { vendorUpdates: [{ at: T0 - DAY, status: 'disputed', note: 'Says it was paid once' }] }, 'skipped_vendor_needs_action'],
    ['a request for documents', { vendorUpdates: [{ at: T0 - DAY, status: 'needs_documents', note: 'Send remittance' }] }, 'skipped_vendor_needs_action'],
    ['a reply since the last email', { vendorUpdates: [{ at: T0 - DAY, status: 'acknowledged', note: 'Looking into it' }] }, 'skipped_vendor_replied'],
    ['a closed case', { recoveryStage: 'not_recovered' }, 'skipped_case_closed'],
    ['a recovered case', { recoveryStage: 'recovered' }, 'skipped_case_closed'],
    ['a full settlement', { recoverySettlements: [{ amount: AMOUNT, reference: 'BANK-1', settledAt: T0 - DAY, source: 'bank', method: 'refund' }] }, 'skipped_not_authorized'],
  ])('prepares nothing with %s', async (_label, state, code) => {
    const result = await prepare(A, requestedProject('p1', { sentAt: T0 - 10 * DAY, state }))
    expect(result).toMatchObject({ status: 'done', code })
    expect(count('SELECT COUNT(*) AS n FROM action_proposals')).toBe(0)
  })

  it('prepares nothing for a sample audit', async () => {
    expect((await prepare(A, requestedProject('p1', { sentAt: T0 - 10 * DAY, mode: 'sample' }))).code).toBe('skipped_sample')
    expect(count('SELECT COUNT(*) AS n FROM action_proposals')).toBe(0)
  })

  it('prepares nothing while a Gmail send is in flight or the counts disagree', async () => {
    const built = seed(A, requestedProject('p1', { sentAt: T0 - 10 * DAY }))
    db.prepare("INSERT INTO gmail_follow_ups (user_id, project_id, finding_id, generation, seq, status, from_email, to_email, created_at) VALUES (?, 'p1', ?, 1, 1, 'uncertain', 'a', 'b', 1)").run(A, built.findingId)
    expect((await prepare(A, built)).code).toBe('skipped_send_in_flight')
    db.prepare("UPDATE gmail_follow_ups SET status = 'sent', sent_at = ?").run(T0 - 5 * DAY)
    expect((await prepare(A, built, { at: clock + 1 })).code).toBe('skipped_sequence_mismatch')
  })

  it('stops when the request generation changed', async () => {
    expect((await prepare(A, requestedProject('p1', { sentAt: T0 - 10 * DAY }), { generation: 2 })).code).toBe('skipped_generation_changed')
  })

  it('a proposal goes stale when the case changes, and the old job stops', async () => {
    const built = requestedProject('p1', { sentAt: T0 - 10 * DAY })
    await prepare(A, built)
    const [p] = pendingProposals(A)
    const oldFingerprint = fingerprintOf(store.get(A, 'p1'), built.findingId)

    // The case moves on: the follow-up date was pushed back a day (still due).
    const env = built.project.environment as { caseStates: Record<string, Record<string, unknown>> }
    env.caseStates[built.findingId].nextFollowUpAt = T0 - DAY / 2
    store.upsert(A, built.project)
    expect(jobsApprovals().get(tenantCtx(A), p.id).stale).toBe(true)
    expect(() => jobsApprovals().claimForExecution(tenantCtx(A), p.id, p.payloadHash)).toThrow(/case changed/)

    // A job planned against the old version stops without proposing.
    jobs.enqueue(A, JOB_KINDS.prepareFollowUp, { projectId: 'p1', findingId: built.findingId, fingerprint: oldFingerprint, generation: 1, sequence: 1 }, { idempotencyKey: 'old', runAt: clock })
    expect((await run())[0].code).toBe('skipped_case_changed')

    // The next scan prepares it again from the current case: one new, current proposal.
    jobs.enqueue(A, JOB_KINDS.scan, {}, { idempotencyKey: 'rescan', runAt: clock })
    await run()
    const fresh = pendingProposals(A)
    expect(fresh).toHaveLength(1)
    expect(fresh[0].id).not.toBe(p.id)
    expect(fresh[0].stale).toBe(false)
  })
})

describe('recovery.scan, reminders and evidence tasks', () => {
  it('leaves one internal notification per reason, without duplicates on rerun', async () => {
    seed(A, requestedProject('due', { sentAt: T0 - 10 * DAY }))
    seed(A, requestedProject('disputed', { sentAt: T0 - 10 * DAY, state: { vendorUpdates: [{ at: T0 - DAY, status: 'disputed', note: 'No' }] } }))
    seed(A, requestedProject('returned', { sentAt: T0 - 30 * DAY, state: { recoveryStage: 'recovered', recoverySettlements: [{ amount: AMOUNT, reference: 'BANK-9', settledAt: T0 - DAY, source: 'bank', method: 'refund' }] } }))
    seed(A, awaitingApprovalProject('approve'))
    seed(A, requestedProject('sample', { sentAt: T0 - 10 * DAY, mode: 'sample' }))
    for (const key of ['scan-1', 'scan-2']) {
      jobs.enqueue(A, JOB_KINDS.scan, {}, { idempotencyKey: key, runAt: clock })
      await run()
    }
    expect(notificationKinds(A)).toEqual(['awaiting_approval', 'follow_up_due', 'follow_up_prepared', 'proposal_pending', 'unreconciled_return', 'vendor_reply'])
    const byKind = Object.fromEntries(jobs.notifications.list(A).map((n) => [n.kind, n]))
    expect(byKind.vendor_reply.projectId).toBe('disputed')
    expect(byKind.follow_up_due).toMatchObject({ projectId: 'due', dueAt: T0 - 3 * DAY, link: '/audit?project=due&case=exact_duplicate-due' })
    expect(jobs.notifications.list(A).some((n) => n.projectId === 'sample')).toBe(false)
  })

  it('turns an evidence gap into an internal task, with counts only', async () => {
    const built = awaitingApprovalProject('gap')
    const finding = (built.project.environment as { result: { findings: Array<{ evidence: { checks: Record<string, unknown> } }> } }).result.findings[0]
    finding.evidence.checks = {}
    seed(A, built)
    jobs.enqueue(A, JOB_KINDS.scan, {}, { runAt: clock })
    await run()
    const gap = jobs.notifications.list(A).find((n) => n.kind === 'evidence_gap')!
    expect(gap.detail.missing).toBeGreaterThan(0)
    expect(gap.detail).toEqual({ missing: gap.detail.missing, contradictions: 0 })
    expect(count('SELECT COUNT(*) AS n FROM action_proposals')).toBe(0)
  })

  it('resumes a scan from its checkpoint', async () => {
    seed(A, requestedProject('p1', { sentAt: T0 - 10 * DAY }))
    seed(A, requestedProject('p2', { sentAt: T0 - 10 * DAY }))
    const { job } = jobs.enqueue(A, JOB_KINDS.scan, {}, { runAt: clock })
    jobs.runner.setCheckpoint(A, job.id, { after: 'p1' })
    await run()
    const planned = db.prepare("SELECT payload FROM jobs WHERE kind != 'recovery.scan'").all().map((r) => JSON.parse((r as { payload: string }).payload).projectId)
    expect(new Set(planned)).toEqual(new Set(['p2']))
  })
})

describe('tenant isolation', () => {
  it('a tenant’s jobs only ever read that tenant’s data', async () => {
    const isolated = openDatabase(':memory:')
    addUser(isolated, A)
    addUser(isolated, B)
    const projects = new ProjectStore(isolated, null)
    projects.upsert(A, requestedProject('pa', { sentAt: T0 - 10 * DAY }).project)
    const bBuilt = requestedProject('pb', { sentAt: T0 - 10 * DAY })
    projects.upsert(B, bBuilt.project)
    const reads: string[] = []
    const spy = { list: (t: string) => { reads.push(t); return projects.list(t) }, get: (t: string, p: string) => { reads.push(t); return projects.get(t, p) } }
    const approvals = new ApprovalService({ db: isolated, sealer: createSealer(null), getProject: (t, p) => { reads.push(t); return projects.get(t, p) }, revision: (t, p) => projects.revision(t, p), now: () => clock })
    const system = createJobSystem({ db: isolated, projects: spy, approvals })

    system.enqueue(A, JOB_KINDS.scan, {}, { runAt: clock })
    // A job of A's that names B's project and fingerprint finds nothing.
    system.enqueue(A, JOB_KINDS.prepareFollowUp, { projectId: 'pb', findingId: bBuilt.findingId, fingerprint: fingerprintOf(projects.get(B, 'pb'), bBuilt.findingId), generation: 1, sequence: 1 }, { idempotencyKey: 'probe', runAt: clock })
    const results = await system.runDue(clock, 'w')
    expect(results.find((r) => r.kind === JOB_KINDS.prepareFollowUp && r.code !== 'proposed')?.code).toBe('skipped_case_gone')
    expect(new Set(reads)).toEqual(new Set([A]))
    expect((isolated.prepare('SELECT DISTINCT user_id FROM action_proposals').all() as Array<{ user_id: string }>).map((r) => r.user_id)).toEqual([A])
    expect((isolated.prepare('SELECT DISTINCT user_id FROM notifications').all() as Array<{ user_id: string }>).map((r) => r.user_id)).toEqual([A])
    expect((isolated.prepare("SELECT DISTINCT project_id FROM action_proposals").all() as Array<{ project_id: string }>).map((r) => r.project_id)).toEqual(['pa'])
    isolated.close()
  })
})

describe('what jobs store', () => {
  it('no supplier names, addresses, amounts, letter text or sender names in jobs, events or notifications', async () => {
    seed(A, requestedProject('p1', { sentAt: T0 - 10 * DAY }))
    seed(A, requestedProject('p2', { sentAt: T0 - 10 * DAY, state: { vendorUpdates: [{ at: T0 - DAY, status: 'disputed', note: `${VENDOR} disputes ${AMOUNT}` }] } }))
    seed(A, awaitingApprovalProject('p3'))
    jobs.setDigestTransport(new RecordingDigestTransport())
    jobs.notifications.setPreferences(A, { digestEnabled: true, timeZone: 'UTC', localHour: 8 }, clock)
    await jobs.tick(clock, 'w')
    await jobs.tick(clock + 1, 'w')
    expect(count('SELECT COUNT(*) AS n FROM action_proposals')).toBeGreaterThan(0)
    const dump = JSON.stringify(['jobs', 'job_events', 'notifications', 'notification_preferences'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()))
    for (const secret of [VENDOR, 'Zephyr', VENDOR_EMAIL, '@', String(AMOUNT), '4,321', 'INV-77', 'Pat Lee', 'Customer Co', 'disputes', 'refund']) expect(dump).not.toContain(secret)
    // The proposal holds the letter, sealed with the rest of the approval queue, not in the job tables.
    expect(dump).not.toMatch(/Hello|following up/i)
  })
})

describe('notify.digest', () => {
  it('sends once per local day at the chosen hour in each person’s time zone, counting only what is due', async () => {
    const transport = new RecordingDigestTransport()
    jobs.setDigestTransport(transport)
    addUser(db, 'ny')
    addUser(db, 'tokyo')
    addUser(db, 'quiet')
    jobs.notifications.setPreferences('ny', { digestEnabled: true, timeZone: 'America/New_York', localHour: 8 }, clock)
    jobs.notifications.setPreferences('tokyo', { digestEnabled: true, timeZone: 'Asia/Tokyo', localHour: 8 }, clock)
    for (const t of ['ny', 'tokyo', 'quiet']) {
      jobs.notifications.add(t, { kind: 'follow_up_due', dedupeKey: `due-now-${t}`, projectId: 'p1', findingId: 'f1', dueAt: Date.UTC(2026, 10, 24) }, clock)
      jobs.notifications.add(t, { kind: 'follow_up_due', dedupeKey: `due-later-${t}`, projectId: 'p2', findingId: 'f2', dueAt: Date.UTC(2026, 11, 30) }, clock)
    }
    const sentTo = () => transport.sent.map((s) => `${s.tenantId}:${s.digest.localDate}`)

    // 12:30 UTC on 25 Nov: 07:30 in New York (too early), 21:30 in Tokyo.
    await jobs.tick(Date.UTC(2026, 10, 25, 12, 30), 'w')
    expect(sentTo()).toEqual(['tokyo:2026-11-25'])
    // 13:00 UTC: 08:00 in New York. Tokyo already had today's.
    await jobs.tick(Date.UTC(2026, 10, 25, 13, 0), 'w')
    await jobs.tick(Date.UTC(2026, 10, 25, 18, 0), 'w')
    expect(sentTo()).toEqual(['tokyo:2026-11-25', 'ny:2026-11-25'])
    // 23:00 UTC is 08:00 on the 26th in Tokyo.
    await jobs.tick(Date.UTC(2026, 10, 25, 23, 0), 'w')
    expect(sentTo()).toEqual(['tokyo:2026-11-25', 'ny:2026-11-25', 'tokyo:2026-11-26'])

    // Counts and links only; the notification due next month isn't in it; nobody who didn't opt in gets one.
    expect(transport.sent[0].digest).toEqual({ localDate: '2026-11-25', timeZone: 'Asia/Tokyo', total: 1, items: [{ kind: 'follow_up_due', count: 1, links: ['/audit?project=p1&case=f1'] }] })
    expect(transport.sent.some((s) => s.tenantId === 'quiet')).toBe(false)
  })

  it('is off by default and retries a failed delivery without sending twice', async () => {
    const transport = new RecordingDigestTransport()
    jobs.setDigestTransport(transport)
    expect(jobs.notifications.preferences(A)).toMatchObject({ digestEnabled: false })
    jobs.notifications.add(A, { kind: 'awaiting_approval', dedupeKey: 'n1', projectId: 'p1', findingId: 'f1', dueAt: null }, clock)
    await jobs.tick(clock, 'w')
    expect(transport.sent).toHaveLength(0)

    jobs.notifications.setPreferences(A, { digestEnabled: true, timeZone: 'UTC', localHour: 8 }, clock)
    transport.failures = 1
    const [first] = (await jobs.tick(clock, 'w')).filter((r) => r.kind === JOB_KINDS.digest)
    expect(first).toMatchObject({ status: 'queued', code: 'digest_transport_failed' })
    await jobs.tick(clock + 5 * 60_000, 'w')
    await jobs.tick(clock + 60 * 60_000, 'w')
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0].idempotencyKey).toBe(`digest:${A}:2026-11-25`)
  })

  it('without a transport, nothing is delivered and nothing pretends it was', async () => {
    jobs.notifications.setPreferences(A, { digestEnabled: true, timeZone: 'UTC', localHour: 8 }, clock)
    jobs.notifications.add(A, { kind: 'awaiting_approval', dedupeKey: 'n1', projectId: 'p1', findingId: 'f1', dueAt: null }, clock)
    const [r] = (await jobs.tick(clock, 'w')).filter((x) => x.kind === JOB_KINDS.digest)
    expect(r.code).toBe('skipped_no_transport')
    expect(jobs.notifications.preferences(A).lastDigestOn).toBeNull()
  })
})
