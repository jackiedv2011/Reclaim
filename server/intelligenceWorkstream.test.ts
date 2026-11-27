// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './db.ts'
import { ProjectStore } from './projectStore.ts'
import { ApprovalService, type ProposalInput } from './approvals.ts'
import { createSealer } from './sealedJson.ts'
import { systemContext, tenantForUser } from './tenant.ts'
import { AiExecutionService } from './aiGateway/service.ts'
import { createMockProvider, type AiProvider } from './aiGateway/providers.ts'
import { registerAiTasks } from './aiGateway/tasks/index.ts'
import { createJobSystem } from './jobs/system.ts'
import { JobRunner } from './jobs/runner.ts'
import { authorizedProject } from './testProject.ts'
import { DAY, awaitingApprovalProject, requestedProject } from './jobs/testFixtures.ts'
import { tenantContextFor } from './intelligence.ts'
import { COVERAGE_REASONS, type TenantContext } from '../src/intelligence/contracts.ts'
import { IntelligenceAccessError } from '../src/intelligence/envelope.ts'
import { attentionQueue } from '../src/intelligence/attention.ts'
import { askAccount } from '../src/intelligence/assistant.ts'
import { DISABLED_AI_GATEWAY, type AiTaskRequest } from '../src/intelligence/aiGateway.ts'
import { InMemoryInsightSnapshotStore, jobTenantContext, readInsights, refreshInsightsHandler, SYSTEM_ACTOR_ID, type JobAuditEvent, type TenantInsightSources } from '../src/intelligence/insightRefresh.ts'
import {
  ACCOUNT_SCOPE_PROJECT_ID,
  INSIGHT_REFRESH_JOB_KIND,
  aiGatewayFromExecutionService,
  attentionWithApprovals,
  enqueueInsightRefresh,
  insightRefreshIdempotencyKey,
  insightRefreshJobDefinition,
  interpretQuestionTask,
  legacyInsightSourcesLoader,
  registerInsightRefreshJob,
  summarizeInsightTask,
} from './intelligenceWorkstream.ts'

// SYNTHETIC FIXTURES ONLY: fictional suppliers, people and amounts.
let db: DatabaseSync
let projects: ProjectStore
let clock: number
const alice = { id: 'u-alice', email: 'alice@example.test' }
const bob = { id: 'u-bob', email: 'bob@example.test' }
const ctxA: TenantContext = tenantContextFor(alice)
const ctxB: TenantContext = tenantContextFor(bob)

beforeEach(() => {
  db = openDatabase(':memory:')
  for (const u of [alice, bob]) db.prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, 1)').run(u.id, u.email)
  projects = new ProjectStore(db, null)
  clock = Date.UTC(2026, 10, 20, 12)
})
afterEach(() => db.close())

const serverTenants = (ctx: TenantContext) => (ctx.tenantId === alice.id ? tenantForUser(alice) : ctx.tenantId === bob.id ? tenantForUser(bob) : null)

// ================================================================ AI

const INSIGHT_ID = 'ins_vendor_spend_above_baseline_0123456789ab'
const insightRequest: AiTaskRequest = {
  task: 'summarize_insight',
  packet: {
    rule: 'vendor_spend_above_baseline',
    ruleDescription: 'A payment above the usual range for this supplier.',
    severity: 'medium',
    figureLabels: ['Payment on a covered date', 'Median payment'],
    figureAmounts: ['4980.00', '1300.00'],
    figureCurrencies: ['USD', 'USD'],
    measures: ['Payments in the baseline: 8 count'],
    limits: 'Covers only the imported records.',
  },
  allowedCitations: [`insight:${INSIGHT_ID}`],
}
const goodSummary = { text: 'A payment of 4980.00 sits above the usual median of 1300.00 in the covered records.', citations: [`insight:${INSIGHT_ID}`] }
const questionRequest: AiTaskRequest = { task: 'interpret_question', packet: { question: 'how are my supplier things looking, mail me at pat@example.test', intents: ['coverage', 'spend_change'] }, allowedCitations: [] }

function aiService(provider: AiProvider | null, options: { registerIntelligence?: boolean } = {}) {
  const ai = registerAiTasks(new AiExecutionService({ db, providers: [provider], getProject: (t, p) => projects.get(t, p), now: () => clock }))
  if (options.registerIntelligence) ai.register(summarizeInsightTask).register(interpretQuestionTask)
  return ai
}
function consentAll(ai: AiExecutionService, user = alice) {
  const t = tenantForUser(user)
  ai.policies.set(t, 'on_demand')
  ai.consent(t, 'summarize_insight', { scope: 'field_set' })
  ai.consent(t, 'interpret_question', { scope: 'field_set' })
}

describe('aiGatewayFromExecutionService', () => {
  it('is off when the intelligence tasks are not in the registry, whatever the consent, and never calls a provider', async () => {
    const provider = createMockProvider({ summarize_insight: goodSummary, interpret_question: { intent: 'coverage' } })
    const ai = aiService(provider)
    ai.policies.set(tenantForUser(alice), 'on_demand')
    const gateway = aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants })
    expect(gateway.enabled).toBe(false)
    expect(await gateway.run(ctxA, insightRequest)).toEqual({ status: 'unavailable', reason: 'task_not_registered' })
    expect(await gateway.run(ctxA, questionRequest)).toEqual({ status: 'unavailable', reason: 'task_not_registered' })
    expect(provider.calls).toHaveLength(0)
    expect(ai.ledger.list(alice.id)).toHaveLength(0)
  })

  it('registered but policy off (the default): policy_off, no provider call, no ledger row', async () => {
    const provider = createMockProvider({ summarize_insight: goodSummary })
    const ai = aiService(provider, { registerIntelligence: true })
    const gateway = aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants })
    expect(gateway.enabled).toBe(true)
    expect(gateway.policy(ctxA)).toBe('off')
    expect(await gateway.run(ctxA, insightRequest)).toEqual({ status: 'policy_off', reason: 'ai_off' })
    expect(provider.calls).toHaveLength(0)
    expect(ai.ledger.list(alice.id)).toHaveLength(0)
  })

  it('no provider configured: disabled for every caller', async () => {
    const ai = aiService(null, { registerIntelligence: true })
    ai.policies.set(tenantForUser(alice), 'on_demand')
    const gateway = aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants })
    expect(gateway.enabled).toBe(false)
    expect(await gateway.run(ctxA, insightRequest)).toEqual({ status: 'unavailable', reason: 'no_provider' })
  })

  it('policy on but no consent: unavailable with the service code, nothing sent', async () => {
    const provider = createMockProvider({ summarize_insight: goodSummary })
    const ai = aiService(provider, { registerIntelligence: true })
    ai.policies.set(tenantForUser(alice), 'on_demand')
    const gateway = aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants })
    expect(gateway.policy(ctxA)).toBe('drafting_only')
    expect(await gateway.run(ctxA, insightRequest)).toEqual({ status: 'unavailable', reason: 'ai_consent_required' })
    expect(provider.calls).toHaveLength(0)
  })

  it('consented and registered: runs through the service, the packet allowlist and the ledger, validated text comes back', async () => {
    const provider = createMockProvider({ summarize_insight: goodSummary })
    const ai = aiService(provider, { registerIntelligence: true })
    consentAll(ai)
    const gateway = aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants })
    const out = await gateway.run(ctxA, insightRequest)
    expect(out).toMatchObject({ status: 'ok', text: goodSummary.text, citations: goodSummary.citations, model: 'mock-1' })
    const [row] = ai.ledger.list(alice.id)
    expect(row).toMatchObject({ task: 'summarize_insight', outcome: 'ok', project_id: ACCOUNT_SCOPE_PROJECT_ID, finding_id: null })
    expect(out.status === 'ok' && out.invocationId).toBe(row.id)
    expect(provider.calls[0].packet).toMatchObject({ rule: 'vendor_spend_above_baseline', citeOnly: [`insight:${INSIGHT_ID}`] })
  })

  it('a field outside the packet allowlist is refused by the task schema before any provider call', async () => {
    const provider = createMockProvider({ summarize_insight: goodSummary })
    const ai = aiService(provider, { registerIntelligence: true })
    consentAll(ai)
    const gateway = aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants })
    const leaky: AiTaskRequest = { ...insightRequest, packet: { ...insightRequest.packet, vendorName: 'Sierra Coffee Supply' } }
    expect(await gateway.run(ctxA, leaky)).toEqual({ status: 'unavailable', reason: 'validation' })
    expect(provider.calls).toHaveLength(0)
  })

  it('model text with a number, link or citation not in the packet is rejected (rejectUnsupportedAiText) and recorded as rejected', async () => {
    for (const [answer, reason] of [
      [{ text: 'Spend rose to 9999.00 this month.', citations: [] }, 'ai_rejected'],
      [{ text: 'See https://evil.example for details.', citations: [] }, 'ai_rejected'],
      [{ text: 'A payment sits above the median.', citations: ['record:7'] }, 'ai_rejected'],
    ] as const) {
      const provider = createMockProvider({ summarize_insight: answer })
      const ai = aiService(provider, { registerIntelligence: true })
      consentAll(ai)
      const out = await aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants }).run(ctxA, insightRequest)
      expect(out).toEqual({ status: 'rejected', reason })
      expect(ai.ledger.list(alice.id)[0].outcome).toBe('rejected')
      db.prepare('DELETE FROM ai_invocations').run()
      db.prepare('DELETE FROM ai_consents').run()
      db.prepare('DELETE FROM ai_policies').run()
    }
  })

  it('the adapter re-checks returned text even when a task let it through', async () => {
    const provider = createMockProvider({ summarize_insight: { text: 'Spend rose to 9999.00.', citations: [] } })
    const ai = aiService(provider)
    ai.register({ ...summarizeInsightTask, validate: () => [] }).register(interpretQuestionTask)
    consentAll(ai)
    const out = await aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants }).run(ctxA, insightRequest)
    expect(out).toEqual({ status: 'rejected', reason: 'number_not_in_packet' })
  })

  it('interpret_question: the question is scrubbed, only listed intents are accepted', async () => {
    const provider = createMockProvider({ interpret_question: { intent: 'coverage' } })
    const ai = aiService(provider, { registerIntelligence: true })
    consentAll(ai)
    const gateway = aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants })
    expect(await gateway.run(ctxA, questionRequest)).toMatchObject({ status: 'ok', text: 'coverage', citations: [] })
    expect(JSON.stringify(provider.calls[0].packet)).not.toContain('pat@example.test')

    const rogue = aiService(createMockProvider({ interpret_question: { intent: 'delete_everything' } }), { registerIntelligence: true })
    db.prepare('DELETE FROM ai_consents').run()
    rogue.consent(tenantForUser(alice), 'interpret_question', { scope: 'field_set' })
    expect(await aiGatewayFromExecutionService(rogue, { serverTenantFor: serverTenants }).run(ctxA, questionRequest)).toEqual({ status: 'rejected', reason: 'ai_rejected' })
  })

  it('refuses a cross-tenant or background context before the service is reached', async () => {
    const provider = createMockProvider({ summarize_insight: goodSummary })
    const ai = aiService(provider, { registerIntelligence: true })
    consentAll(ai, bob)
    const wrongTenant = aiGatewayFromExecutionService(ai, { serverTenantFor: () => tenantForUser(bob) })
    expect(wrongTenant.policy(ctxA)).toBe('off')
    expect(await wrongTenant.run(ctxA, insightRequest)).toEqual({ status: 'unavailable', reason: 'tenant_mismatch' })
    const asJob = aiGatewayFromExecutionService(ai, { serverTenantFor: (c) => systemContext(c.tenantId, 'insights.refresh') })
    expect(await asJob.run(ctxB, insightRequest)).toEqual({ status: 'unavailable', reason: 'tenant_mismatch' })
    const gateway = aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants })
    expect(await gateway.run(jobTenantContext(bob.id, null), insightRequest)).toEqual({ status: 'disabled', reason: 'background_jobs_never_call_ai' })
    expect(gateway.policy(jobTenantContext(bob.id, null))).toBe('off')
    expect(provider.calls).toHaveLength(0)
  })

  it('drives the account assistant: off → deterministic only; consented → the interpretation is mapped and its invocation cited', async () => {
    const source = legacyInsightSourcesLoader(projects)(alice.id)!
    const deps = { financial: source.financial, cases: source.cases, returns: source.returns, memory: source.memory }
    const question = 'zorp blarg quux?'
    const provider = createMockProvider({ interpret_question: { intent: 'coverage' } })
    const ai = aiService(provider, { registerIntelligence: true })
    const gateway = aiGatewayFromExecutionService(ai, { serverTenantFor: serverTenants })
    const off = await askAccount(ctxA, { ...deps, ai: gateway }, question, clock)
    expect(off.interpretation.method).not.toBe('ai_intent_mapping')
    expect(provider.calls).toHaveLength(0)
    const disabled = await askAccount(ctxA, { ...deps, ai: DISABLED_AI_GATEWAY }, question, clock)
    expect(disabled.interpretation).toEqual(off.interpretation)

    consentAll(ai)
    const on = await askAccount(ctxA, { ...deps, ai: gateway }, question, clock)
    expect(on.interpretation).toEqual({ method: 'ai_intent_mapping', aiInvocationId: ai.ledger.list(alice.id)[0].id })
    expect(provider.calls).toHaveLength(1)
  })
})

// ================================================================ attention <- approvals

const userTenant = tenantForUser(alice)
function approvals() {
  return new ApprovalService({ db, sealer: createSealer(null), getProject: (t, p) => projects.get(t, p), revision: (t, p) => projects.revision(t, p), now: () => clock })
}
const casesFor = (tenantId: string) => legacyInsightSourcesLoader(projects)(tenantId)!.cases

/** p-ready: approved, not sent. p-await: confirmed, awaiting approval. p-wait: request sent, waiting on the supplier. */
function seed(user = alice) {
  const ready = authorizedProject('p-ready', { vendor: 'Fixture Beans Ltd', invoice: 'INV-1', amount: 1200, requested: 1200 })
  const awaiting = awaitingApprovalProject('p-await')
  const waiting = requestedProject('p-wait', { sentAt: clock - 2 * DAY, followUpAt: clock + 5 * DAY })
  for (const p of [ready, awaiting, waiting]) projects.upsert(user.id, p.project)
  return { ready, awaiting, waiting }
}
const approvePackage = (findingId: string): ProposalInput => ({
  projectId: 'p-await', findingId, origin: 'user', reason: 'Package reviewed', sourceRefs: ['r1'],
  payload: { kind: 'approve_request', package: { subject: 'Duplicate payment', body: 'Please refund.', evidenceAttachment: null, recipientEmail: 'billing@supplier.example', recipientConfirmed: true, requestedAmount: 100, method: 'refund' }, knownBeforeReclaim: false, knownBeforeNote: null },
})
const vendorUpdate = (projectId: string, findingId: string): ProposalInput => ({
  projectId, findingId, origin: 'inbound', reason: 'Supplier reply read', sourceRefs: ['msg-1'],
  payload: { kind: 'case_command', command: 'vendor_update', input: { status: 'acknowledged', note: 'Supplier acknowledged', at: clock - 1000 } },
})
const followUpDate = (projectId: string, findingId: string): ProposalInput => ({
  projectId, findingId, origin: 'user', reason: 'Chase next week', sourceRefs: [],
  payload: { kind: 'case_command', command: 'followup', input: { at: clock + 7 * DAY } },
})

describe('attentionWithApprovals', () => {
  it('without approval objects it is the derived queue, minus upstream_contract_pending', () => {
    seed()
    const base = attentionQueue(ctxA, casesFor(alice.id), clock)
    const merged = attentionWithApprovals(ctxA, casesFor(alice.id), approvals(), userTenant, clock)
    expect(merged.result!.items.map((i) => [i.id, i.category, i.approvalSource, i.approvals.length])).toEqual(base.result!.items.map((i) => [i.id, i.category, 'case_state', 0]))
    expect(base.coverage.find((c) => c.check === 'pending_approvals')!.reasons).toContain(COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING)
    const pending = merged.coverage.find((c) => c.check === 'pending_approvals')!
    expect(pending.reasons).not.toContain(COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING)
    expect(pending.reasons).toContain('revalidation_not_in_snapshot')
    expect(merged.result!.approvalQueue).toMatchObject({ source: 'approval_service', pending: 0, attached: 0 })
  })

  it('prefers an authoritative pending approval, keeps derived items for other cases, and creates items for approvals on quiet cases', () => {
    const { ready, awaiting, waiting } = seed()
    const service = approvals()
    const pkg = service.propose(userTenant, approvePackage(awaiting.findingId))
    const reply = service.propose(userTenant, vendorUpdate('p-wait', waiting.findingId))
    const before = JSON.stringify(db.prepare('SELECT * FROM action_proposals ORDER BY id').all())
    const env = attentionWithApprovals(ctxA, casesFor(alice.id), service, userTenant, clock)
    const byCase = new Map(env.result!.items.map((i) => [i.auditId, i]))

    const a = byCase.get('p-await')!
    expect(a).toMatchObject({ kind: 'outbound_approval', category: 'requires_approval', approvalSource: 'approval_service' })
    expect(a.primaryApproval).toMatchObject({ approvalId: pkg.id, status: 'pending', kind: 'approve_request', exactVersion: { payloadHash: pkg.payloadHash, caseFingerprint: pkg.caseFingerprint, caseRevision: pkg.caseRevision } })
    expect(a.primaryApproval!.approve).toEqual({ method: 'POST', path: `/api/approvals/${pkg.id}/approve`, body: { payloadHash: pkg.payloadHash } })
    expect(a.allowedInteractions.find((d) => d.interaction === 'approve')).toMatchObject({ enabled: false, executesVia: 'not_available' })

    const w = byCase.get('p-wait')!
    expect(w).toMatchObject({ kind: 'vendor_response_review', category: 'requires_approval', approvalSource: 'approval_service', actionLabel: 'Wait for vendor' })
    expect(w.primaryApproval).toMatchObject({ approvalId: reply.id, origin: 'inbound', actionType: 'case_command:vendor_update' })

    const r = byCase.get('p-ready')!
    expect(r).toMatchObject({ approvalSource: 'case_state', approvals: [], primaryApproval: null })
    expect(r.caseId).toBe(`p-ready/${ready.findingId}`)

    expect(env.result!.approvalQueue).toMatchObject({ pending: 2, stale: 0, attached: 2, itemsFromApprovals: 1 })
    expect(env.result!.items[0].category).toBe('requires_approval')
    expect(env.sources.map((s) => s.id)).toEqual(expect.arrayContaining([`approval:${pkg.id}`, `approval:${reply.id}`]))
    // Read-only: no proposal row changed.
    expect(JSON.stringify(db.prepare('SELECT * FROM action_proposals ORDER BY id').all())).toBe(before)
  })

  it('a stale approval is attached but not preferred; resolved and expired approvals change nothing', () => {
    const { ready, awaiting, waiting } = seed()
    const service = approvals()
    const stale = service.propose(userTenant, followUpDate('p-ready', ready.findingId))
    // The case changes after the follow-up date was proposed.
    const changed = structuredClone(ready.project)
    ;(changed.environment.caseStates[ready.findingId] as Record<string, unknown>).requestedAmount = 1100
    projects.upsert(alice.id, changed)
    const rejected = service.propose(userTenant, approvePackage(awaiting.findingId))
    service.reject(userTenant, rejected.id, null)
    service.propose(userTenant, { ...vendorUpdate('p-wait', waiting.findingId), ttlMs: DAY })
    clock += 2 * DAY

    const env = attentionWithApprovals(ctxA, casesFor(alice.id), service, userTenant, clock)
    const byCase = new Map(env.result!.items.map((i) => [i.auditId, i]))
    const r = byCase.get('p-ready')!
    expect(r.approvalSource).toBe('case_state')
    expect(r.approvals).toEqual([expect.objectContaining({ approvalId: stale.id, status: 'stale', approve: null })])
    expect(r.cautions).toContain('approval_stale')
    expect(r.allowedInteractions.find((d) => d.interaction === 'approve')!.executesVia).not.toBe('existing_case_command')
    const a = byCase.get('p-await')!
    expect(a).toMatchObject({ approvalSource: 'case_state', approvals: [], category: 'requires_approval' })
    expect(a.allowedInteractions.find((d) => d.interaction === 'approve')).toMatchObject({ executesVia: 'existing_case_command' })
    expect(byCase.has('p-wait')).toBe(false)
    expect(env.result!.approvalQueue).toMatchObject({ pending: 1, stale: 1, itemsFromApprovals: 0 })
    expect(env.warnings.map((w) => w.code)).toContain('approval_stale')
    // The expired proposal was not swept: still pending in the table.
    expect(db.prepare("SELECT COUNT(*) AS n FROM action_proposals WHERE status = 'pending'").get()).toEqual({ n: 2 })
  })

  it('refuses another tenant’s approval queue, and never shows another tenant’s approvals', () => {
    const { awaiting } = seed(alice)
    seed(bob)
    const service = approvals()
    service.propose(tenantForUser(bob), approvePackage(awaiting.findingId))
    expect(() => attentionWithApprovals(ctxA, casesFor(alice.id), service, tenantForUser(bob), clock)).toThrow(IntelligenceAccessError)
    const env = attentionWithApprovals(ctxA, casesFor(alice.id), service, userTenant, clock)
    expect(env.result!.approvalQueue.pending).toBe(0)
    expect(env.result!.items.every((i) => i.approvals.length === 0 && i.tenantId === alice.id)).toBe(true)
  })

  it('pages and filters like the base queue', () => {
    const { awaiting } = seed()
    approvals().propose(userTenant, approvePackage(awaiting.findingId))
    const all = attentionWithApprovals(ctxA, casesFor(alice.id), approvals(), userTenant, clock)
    const first = attentionWithApprovals(ctxA, casesFor(alice.id), approvals(), userTenant, clock, { limit: 1 })
    expect(first.result!.items.map((i) => i.id)).toEqual([all.result!.items[0].id])
    const second = attentionWithApprovals(ctxA, casesFor(alice.id), approvals(), userTenant, clock, { limit: 1, cursor: first.result!.nextCursor })
    expect(second.result!.items.map((i) => i.id)).toEqual([all.result!.items[1].id])
    const onlyApprovals = attentionWithApprovals(ctxA, casesFor(alice.id), approvals(), userTenant, clock, { include: ['requires_approval'] })
    expect(onlyApprovals.result!.items.every((i) => i.category === 'requires_approval')).toBe(true)
    expect(onlyApprovals.result!.counts).toEqual(all.result!.counts)
  })
})

// ================================================================ jobs

describe('insight refresh on the durable runner', () => {
  function system() {
    return createJobSystem({ db, projects, approvals: approvals() })
  }

  it('registers on the job system, runs once through runDue, and a duplicate idempotency key does no duplicate work', async () => {
    seed()
    const jobs = system()
    const snapshots = new InMemoryInsightSnapshotStore()
    const audits: JobAuditEvent[] = []
    let loads = 0
    const load = legacyInsightSourcesLoader(projects)
    registerInsightRefreshJob(jobs, { loadTenant: (t) => (loads++, load(t)), snapshots, onAudit: (e) => audits.push(e) })
    expect(jobs.runner.registered()).toContain(INSIGHT_REFRESH_JOB_KIND)

    const first = enqueueInsightRefresh(jobs, alice.id, 'scheduled', clock)
    const dup = enqueueInsightRefresh(jobs, alice.id, 'scheduled', clock + 1000)
    expect(first.created).toBe(true)
    expect(dup).toEqual({ job: first.job, created: false })
    expect(first.job.kind).toBe('insights.refresh')

    const results = await jobs.runDue(clock, 'test-worker')
    expect(results).toEqual([{ id: first.job.id, kind: 'insights.refresh', tenantId: alice.id, status: 'done', code: 'refreshed' }])
    expect(await jobs.runDue(clock + 60_000, 'test-worker')).toEqual([])
    expect(enqueueInsightRefresh(jobs, alice.id, 'scheduled', clock + 2000).created).toBe(false)
    expect(await jobs.runDue(clock + 120_000, 'test-worker')).toEqual([])
    expect(loads).toBe(1)

    const snap = snapshots.get(jobTenantContext(alice.id, null))!
    expect(snap).toMatchObject({ tenantId: alice.id, idempotencyKey: first.job.id, generatedAt: clock })
    expect(snapshots.get(jobTenantContext(bob.id, null))).toBeNull()
    expect(audits).toEqual([expect.objectContaining({ operation: 'insights.refresh', tenantId: alice.id, outcome: 'succeeded', attempt: 1, replayed: false })])
    expect(jobs.runner.events(alice.id, first.job.id).map((e) => e.event)).toEqual(['enqueued', 'claimed', 'succeeded'])
    // Read-only: the projects are as they were, and the job never proposed anything.
    expect(db.prepare('SELECT COUNT(*) AS n FROM action_proposals').get()).toEqual({ n: 0 })

    // The snapshot is what the read path serves.
    const read = readInsights({ ...jobTenantContext(alice.id, null), actorId: SYSTEM_ACTOR_ID }, load(alice.id)!, snapshots, clock)
    expect(read.stale).toBe(false)
    expect(insightRefreshIdempotencyKey('scheduled', clock)).toBe('scheduled.2026-11-20')
  })

  it('runs as the system job context, never with approval or AI rights', async () => {
    seed()
    const runner = new JobRunner(db)
    const contexts: TenantContext[] = []
    const load = legacyInsightSourcesLoader(projects)
    const spying = (t: string): TenantInsightSources => {
      const s = load(t)!
      return { ...s, cases: { origin: s.cases.origin, listCases: (ctx, now) => (contexts.push(ctx), s.cases.listCases(ctx, now)) } }
    }
    registerInsightRefreshJob(runner, { loadTenant: spying, snapshots: new InMemoryInsightSnapshotStore() })
    enqueueInsightRefresh(runner, alice.id, 'import_completed', clock)
    const [result] = await runner.runDue(clock, 'w1')
    expect(result.status).toBe('done')
    expect(contexts.length).toBeGreaterThan(0)
    for (const c of contexts) expect(c).toEqual({ tenantId: alice.id, actorId: SYSTEM_ACTOR_ID, permissions: ['financial:read', 'cases:read', 'insights:refresh'], source: 'job_runner' })

    // A context that is not the runner's system context is refused by the adapter itself.
    const def = insightRefreshJobDefinition(refreshInsightsHandler({ loadTenant: load, snapshots: new InMemoryInsightSnapshotStore() }))
    const fake = { jobId: 'j1', kind: INSIGHT_REFRESH_JOB_KIND, tenant: tenantForUser(alice), payload: { trigger: 'manual' as const }, signal: new AbortController().signal, attempt: 1, now: clock, checkpoint: { get: () => null, set: () => {} } }
    await expect(def.handler(fake)).rejects.toMatchObject({ code: 'forbidden', retryable: false })
  })

  it('a loader that returns another tenant’s data fails the job at once (no retry)', async () => {
    seed(alice)
    seed(bob)
    const runner = new JobRunner(db)
    const load = legacyInsightSourcesLoader(projects)
    registerInsightRefreshJob(runner, { loadTenant: () => load(bob.id), snapshots: new InMemoryInsightSnapshotStore() })
    const { job } = enqueueInsightRefresh(runner, alice.id, 'manual', clock)
    const [result] = await runner.runDue(clock, 'w1')
    expect(result).toMatchObject({ status: 'failed', code: 'tenant_mismatch' })
    expect(runner.get(alice.id, job.id)).toMatchObject({ status: 'failed', lastErrorCode: 'tenant_mismatch', attempts: 1 })
  })

  it('a transient source failure is retried by the runner with backoff, then succeeds', async () => {
    seed()
    const runner = new JobRunner(db)
    const load = legacyInsightSourcesLoader(projects)
    let calls = 0
    registerInsightRefreshJob(runner, {
      loadTenant: (t) => {
        calls++
        if (calls === 1) throw new Error('database busy')
        return load(t)
      },
      snapshots: new InMemoryInsightSnapshotStore(),
    })
    const { job } = enqueueInsightRefresh(runner, alice.id, 'scheduled', clock)
    expect((await runner.runDue(clock, 'w1'))[0]).toMatchObject({ status: 'queued', code: 'transient_failure' })
    expect(await runner.runDue(clock + 1000, 'w1')).toEqual([])
    const later = await runner.runDue(clock + 61_000, 'w1')
    expect(later[0]).toMatchObject({ id: job.id, status: 'done', code: 'refreshed' })
    expect(runner.get(alice.id, job.id)!.attempts).toBe(2)
  })

  it('refuses payloads that carry anything but a trigger and a bound', () => {
    const runner = new JobRunner(db)
    registerInsightRefreshJob(runner, { loadTenant: () => null, snapshots: new InMemoryInsightSnapshotStore() })
    expect(() => runner.enqueue(alice.id, INSIGHT_REFRESH_JOB_KIND, { trigger: 'scheduled', tenantId: bob.id }, { runAt: clock })).toThrow(/invalid_payload/)
    expect(() => runner.enqueue(alice.id, INSIGHT_REFRESH_JOB_KIND, { trigger: 'whenever' }, { runAt: clock })).toThrow(/invalid_payload/)
  })
})
