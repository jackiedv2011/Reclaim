import { describe, expect, it } from 'vitest'
import { NO_RETURN_MATCHING, type FinancialSourcePort, type TenantContext } from './contracts.ts'
import { IntelligenceAccessError } from './envelope.ts'
import { createLegacyAuditSource } from './adapters/legacyAudit.ts'
import { auditFromCsv, fixtureContext, tenantAAudits, tenantBAudits } from './fixtures/synthetic.ts'
import { InMemoryFeedbackStore, validateFeedbackInput } from './memory.ts'
import { FORBIDDEN_INSIGHT_WORDS, InMemoryInsightStateStore, dismissInsight } from './insights.ts'
import type { AiGatewayPort } from './aiGateway.ts'
import {
  DEFAULT_SNAPSHOT_MAX_AGE_MS,
  FixtureJobRunner,
  INSIGHT_REFRESH_OPERATION,
  InMemoryInsightSnapshotStore,
  SYSTEM_ACTOR_ID,
  insightInputsFingerprint,
  jobTenantContext,
  readInsights,
  refreshInsightsHandler,
  refreshInsightsNow,
  type FixtureJob,
  type RefreshHandlerDeps,
  type RefreshInsightsInput,
  type RefreshInsightsOutput,
  type TenantInsightSources,
} from './insightRefresh.ts'

// SYNTHETIC FIXTURES ONLY: fictional vendors and amounts, local tests.
const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 1, 12)
const ctxA = fixtureContext('tenant_a')

function sourcesFor(tenantId: string, audits = tenantId === 'tenant_a' ? tenantAAudits() : tenantBAudits()): TenantInsightSources {
  const s = createLegacyAuditSource(tenantId, audits)
  return { financial: s.financial, cases: s.cases, returns: NO_RETURN_MATCHING, memory: new InMemoryFeedbackStore(), insightState: new InMemoryInsightStateStore(), unreadableAuditIds: s.unreadableAuditIds }
}

/** Counts reads so a test can tell whether work was repeated. */
function counting(sources: TenantInsightSources): { sources: TenantInsightSources; reads: () => number } {
  let n = 0
  const financial: FinancialSourcePort = {
    origin: sources.financial.origin,
    listSourceRecords: (ctx) => (n++, sources.financial.listSourceRecords(ctx)),
    listImportCoverage: (ctx) => sources.financial.listImportCoverage(ctx),
    overlapCount: (ctx) => sources.financial.overlapCount(ctx),
    listRecurringSeries: (ctx) => sources.financial.listRecurringSeries(ctx),
  }
  return { sources: { ...sources, financial }, reads: () => n }
}

function setup(loader: (tenantId: string) => TenantInsightSources | null, extra: Partial<RefreshHandlerDeps> = {}) {
  const snapshots = new InMemoryInsightSnapshotStore()
  const handler = refreshInsightsHandler({ loadTenant: loader, snapshots, ...extra })
  const runner = new FixtureJobRunner()
  runner.register(handler)
  return { snapshots, handler, runner }
}

function job(o: Partial<FixtureJob<RefreshInsightsInput>> = {}): FixtureJob<RefreshInsightsInput> {
  return { tenantId: 'tenant_a', actorId: null, operation: INSIGHT_REFRESH_OPERATION, idempotencyKey: 'refresh-1', input: { trigger: 'scheduled' }, now: NOW, ...o }
}

function runJob(runner: FixtureJobRunner, j: FixtureJob<RefreshInsightsInput>) {
  return runner.run<RefreshInsightsInput, RefreshInsightsOutput>(j)
}

describe('refreshInsightsHandler: idempotency and duplicate jobs', () => {
  it('runs once, stores a snapshot, and replays a duplicate job without repeating the work', async () => {
    const { sources, reads } = counting(sourcesFor('tenant_a'))
    const { runner, snapshots } = setup((t) => (t === 'tenant_a' ? sources : null))
    const first = await runJob(runner, job())
    expect(first.outcome.status).toBe('succeeded')
    expect(first.outcome.output!.reusedSnapshot).toBe(false)
    expect(first.outcome.output!.countsByRule.vendor_spend_above_baseline).toBe(1)
    const readsAfterFirst = reads()
    const dup = await runJob(runner, job())
    expect(reads()).toBe(readsAfterFirst)
    expect(dup.outcome.output).toEqual(first.outcome.output)
    expect(dup.outcome.auditEvent).toMatchObject({ replayed: true, outcome: 'succeeded' })
    expect(snapshots.get(ctxA)!.idempotencyKey).toBe('refresh-1')
  })

  it('refuses an idempotency key reused with a different input', async () => {
    const sources = sourcesFor('tenant_a')
    const { runner } = setup(() => sources)
    await runJob(runner, job())
    const conflict = await runJob(runner, job({ input: { trigger: 'manual', maxInsights: 5 } }))
    expect(conflict.outcome).toMatchObject({ status: 'failed', error: { code: 'idempotency_conflict' } })
  })

  it('a new key with unchanged inputs reuses the fresh snapshot instead of regenerating', async () => {
    const sources = sourcesFor('tenant_a')
    const { runner, snapshots } = setup(() => sources)
    await runJob(runner, job())
    const second = await runJob(runner, job({ idempotencyKey: 'refresh-2', now: NOW + 3_600_000 }))
    expect(second.outcome.output!.reusedSnapshot).toBe(true)
    expect(snapshots.get(ctxA)!.generatedAt).toBe(NOW)
  })
})

describe('refreshInsightsHandler: tenancy, authorization and validation', () => {
  it('refuses a loader that hands back another tenant’s data, and writes nothing', async () => {
    const tenantA = sourcesFor('tenant_a')
    const { runner, snapshots } = setup(() => tenantA)
    const res = await runJob(runner, job({ tenantId: 'tenant_b' }))
    expect(res.outcome).toMatchObject({ status: 'failed', error: { code: 'tenant_mismatch' } })
    expect(res.attempts).toBe(1)
    expect(snapshots.get(fixtureContext('tenant_b'))).toBeNull()
    expect(snapshots.get(ctxA)).toBeNull()
  })

  it('refuses an input that names a different tenant than the job', async () => {
    const { runner } = setup(() => sourcesFor('tenant_a'))
    const res = await runJob(runner, job({ input: { trigger: 'manual', tenantId: 'tenant_b' } }))
    expect(res.outcome.error?.code).toBe('tenant_mismatch')
  })

  it('fails for an unknown tenant, a malformed envelope or input', async () => {
    const { runner } = setup(() => null)
    expect((await runJob(runner, job())).outcome.error?.code).toBe('tenant_not_found')
    const { handler } = setup(() => sourcesFor('tenant_a'))
    const base = { ...job(), attempt: 1, checkpoint: null }
    expect((await handler.run({ ...base, operation: 'spend.refresh' })).error?.code).toBe('invalid_job')
    expect((await handler.run({ ...base, tenantId: 'tenant a; drop' })).error?.code).toBe('invalid_job')
    expect((await handler.run({ ...base, idempotencyKey: '' })).error?.code).toBe('invalid_job')
    expect((await handler.run({ ...base, attempt: 0 })).error?.code).toBe('invalid_job')
    expect((await handler.run({ ...base, input: { trigger: 'whenever' } as unknown as RefreshInsightsInput })).error?.code).toBe('invalid_input')
    expect((await handler.run({ ...base, input: { trigger: 'manual', maxInsights: 1000 } })).error?.code).toBe('invalid_input')
    expect((await handler.run({ ...base, input: { trigger: 'manual', tenant: 'tenant_b' } as unknown as RefreshInsightsInput })).error?.code).toBe('invalid_input')
  })

  it('needs an authorization check for an actor-initiated job; system jobs run as the system actor', async () => {
    const sources = sourcesFor('tenant_a')
    const denied = setup(() => sources)
    expect((await runJob(denied.runner, job({ actorId: 'user_x' }))).outcome.error?.code).toBe('forbidden')
    const allowed = setup(() => sources, { authorizeActor: (t, a) => t === 'tenant_a' && a === 'tenant_a' })
    expect((await runJob(allowed.runner, job({ actorId: 'tenant_a' }))).outcome.status).toBe('succeeded')
    expect((await runJob(allowed.runner, job({ actorId: 'intruder', idempotencyKey: 'k2' }))).outcome.error?.code).toBe('forbidden')
    expect(jobTenantContext('tenant_a', null)).toEqual({ tenantId: 'tenant_a', actorId: SYSTEM_ACTOR_ID, permissions: ['financial:read', 'cases:read', 'insights:refresh'], source: 'single_user_session' })
  })
})

describe('refreshInsightsHandler: retries and safe logging', () => {
  function flaky(failures: number) {
    const sources = sourcesFor('tenant_a')
    let calls = 0
    const financial: FinancialSourcePort = {
      ...sources.financial,
      origin: sources.financial.origin,
      listSourceRecords: (ctx) => {
        calls += 1
        if (calls <= failures) throw new Error('db timeout reading Fixture Coffee Co USD 4980.00')
        return sources.financial.listSourceRecords(ctx)
      },
    }
    return { ...sources, financial }
  }

  it('retries a transient port failure and then succeeds', async () => {
    const source = flaky(2)
    const { runner } = setup(() => source)
    const res = await runJob(runner, job())
    expect(res.attempts).toBe(3)
    expect(res.outcome.status).toBe('succeeded')
    expect(runner.auditLog.map((e) => [e.outcome, e.attempt, e.errorCode])).toEqual([['retry', 1, 'transient_failure'], ['retry', 2, 'transient_failure'], ['succeeded', 3, null]])
  })

  it('fails after the last attempt with a bounded message that carries no data', async () => {
    const source = flaky(99)
    const { runner } = setup(() => source)
    const res = await runJob(runner, job())
    expect(res.attempts).toBe(3)
    expect(res.outcome).toMatchObject({ status: 'failed', error: { code: 'retries_exhausted' } })
    const logged = JSON.stringify([res.outcome.error, runner.auditLog])
    expect(logged).not.toContain('Fixture')
    expect(logged).not.toContain('4980')
    expect(logged).not.toContain('USD')
    expect(res.outcome.error!.message.length).toBeLessThan(120)
  })

  it('audit events carry counts only, never amounts or vendor names', async () => {
    const { runner } = setup(() => sourcesFor('tenant_a'))
    const res = await runJob(runner, job())
    expect(res.outcome.auditEvent).toMatchObject({ operation: INSIGHT_REFRESH_OPERATION, tenantId: 'tenant_a', idempotencyKey: 'refresh-1', at: NOW, outcome: 'succeeded' })
    expect(Object.values(res.outcome.auditEvent.counts).every((v) => Number.isInteger(v))).toBe(true)
    expect(JSON.stringify(runner.auditLog)).not.toMatch(/Fixture|USD|EUR/)
  })
})

describe('snapshot freshness: stale, corrected and historical inputs', () => {
  it('reads fresh after a refresh, and stale after memory is revoked, an insight is dismissed or time passes', async () => {
    const sources = sourcesFor('tenant_a')
    const { runner, snapshots } = setup(() => sources)
    expect(readInsights(ctxA, sources, snapshots, NOW)).toMatchObject({ envelope: null, stale: true, staleReasons: ['never_generated'] })
    await runJob(runner, job())
    expect(readInsights(ctxA, sources, snapshots, NOW)).toMatchObject({ stale: false, staleReasons: [] })

    // Feedback added, then revoked: each changes the inputs.
    const coffeeKey = sources.financial.listSourceRecords(ctxA).find((r) => r.vendor.displayName === 'Fixture Coffee Co')!.vendor.vendorKey
    const v = validateFeedbackInput(ctxA, { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: coffeeKey }, rationale: 'Bulk order.' }, NOW, { financial: sources.financial, cases: sources.cases })
    if (!v.ok) throw new Error('fixture feedback invalid')
    const entry = sources.memory.create(ctxA, v.value, NOW)
    expect(readInsights(ctxA, sources, snapshots, NOW).staleReasons).toEqual(['inputs_changed'])
    const refreshed = await runJob(runner, job({ idempotencyKey: 'after-feedback', input: { trigger: 'feedback_changed' } }))
    expect(refreshed.outcome.output!.reusedSnapshot).toBe(false)
    const withNote = snapshots.get(ctxA)!.envelope.result!.items.find((i) => i.rule === 'vendor_spend_above_baseline')!
    expect(withNote.influencedBy).toEqual([entry.id])
    sources.memory.revoke(ctxA, entry.id, 'Wrong vendor', NOW + 1000)
    expect(readInsights(ctxA, sources, snapshots, NOW + 2000).staleReasons).toEqual(['inputs_changed'])
    await runJob(runner, job({ idempotencyKey: 'after-revoke', input: { trigger: 'feedback_changed' }, now: NOW + 2000 }))
    expect(snapshots.get(ctxA)!.envelope.result!.items.find((i) => i.rule === 'vendor_spend_above_baseline')!.influencedBy).toEqual([])

    // A dismissal changes the inputs too; the refreshed snapshot hides the dismissed insight.
    dismissInsight(ctxA, sources, withNote.id, 'Reviewed', NOW + 3000)
    expect(readInsights(ctxA, sources, snapshots, NOW + 3000).staleReasons).toEqual(['inputs_changed'])
    await runJob(runner, job({ idempotencyKey: 'after-dismiss', input: { trigger: 'manual' }, now: NOW + 3000 }))
    const snap = snapshots.get(ctxA)!.envelope.result!
    expect(snap.items.some((i) => i.id === withNote.id)).toBe(false)
    expect(snap.suppressedByDismissal).toBe(1)

    // Time alone: older than the threshold.
    expect(readInsights(ctxA, sources, snapshots, NOW + 3000 + DEFAULT_SNAPSHOT_MAX_AGE_MS + 1).staleReasons).toEqual(['older_than_threshold'])
  })

  it('a new import changes the fingerprint and the refresh regenerates', async () => {
    let current = sourcesFor('tenant_a')
    const { runner, snapshots } = setup(() => current)
    await runJob(runner, job())
    const before = snapshots.get(ctxA)!.inputsFingerprint
    current = { ...current, ...(() => { const s = createLegacyAuditSource('tenant_a', [...tenantAAudits(), auditFromCsv('audit_a_q3', ['Fixture Coffee Co,INV-1007,2026-06-20,2026-06-28,5200.00,5200.00,net 30,2222,COGS,USD,'])]); return { financial: s.financial, cases: s.cases } })() }
    expect(readInsights(ctxA, current, snapshots, NOW).staleReasons).toEqual(['inputs_changed'])
    const res = await runJob(runner, job({ idempotencyKey: 'after-import', input: { trigger: 'import_completed' } }))
    expect(res.outcome.output!.reusedSnapshot).toBe(false)
    expect(snapshots.get(ctxA)!.inputsFingerprint).not.toBe(before)
    expect(readInsights(ctxA, current, snapshots, NOW).stale).toBe(false)
  })

  it('distinguishes historical insights (old covered records) from a stale cache', async () => {
    const sources = sourcesFor('tenant_a')
    const { runner, snapshots } = setup(() => sources)
    const later = Date.now() + 90 * DAY // newest import time of the fixtures is the real clock
    await runJob(runner, job({ now: later }))
    const read = readInsights(ctxA, sources, snapshots, later)
    expect(read.stale).toBe(false)
    expect(read.historical).toBe(true)
    expect(read.envelope!.result!.items.some((i) => i.dedupKey === 'import_coverage_gap|account|stale_data')).toBe(true)
  })

  it('never reads another tenant’s cache, and refuses to store a mismatched snapshot', async () => {
    const sources = sourcesFor('tenant_a')
    const { runner, snapshots } = setup(() => sources)
    await runJob(runner, job())
    const ctxB = fixtureContext('tenant_b')
    expect(readInsights(ctxB, sourcesFor('tenant_b'), snapshots, NOW).staleReasons).toEqual(['never_generated'])
    expect(() => readInsights(ctxB, sources, snapshots, NOW)).toThrow(IntelligenceAccessError)
    expect(() => snapshots.put(ctxB, snapshots.get(ctxA)!)).toThrow(IntelligenceAccessError)
  })
})

describe('no data, sparse data, bounds, no AI, manual refresh', () => {
  it('no data: succeeds with coverage insights only, never a clean result', async () => {
    const empty = sourcesFor('tenant_e', [])
    const { runner, snapshots } = setup(() => empty)
    const res = await runJob(runner, job({ tenantId: 'tenant_e' }))
    expect(res.outcome.status).toBe('succeeded')
    const items = snapshots.get(fixtureContext('tenant_e'))!.envelope.result!.items
    expect(items.map((i) => i.rule)).toEqual(['import_coverage_gap', 'import_coverage_gap'])
    for (const i of items) for (const w of FORBIDDEN_INSIGHT_WORDS) expect(`${i.title} ${i.explanation}`.toLowerCase()).not.toContain(w)
  })

  it('sparse data: one payment gives no comparison, only limits', async () => {
    const sparse = sourcesFor('tenant_s', [auditFromCsv('audit_s', ['Fixture Solo Co,S-1,2026-03-01,2026-03-05,250.00,250.00,net 5,1212,Misc,USD,'])])
    const { runner, snapshots } = setup(() => sparse)
    await runJob(runner, job({ tenantId: 'tenant_s' }))
    const result = snapshots.get(fixtureContext('tenant_s'))!.envelope.result!
    expect(result.countsByRule.vendor_spend_above_baseline + result.countsByRule.vendor_change + result.countsByRule.vendor_concentration).toBe(0)
    expect(result.items.some((i) => i.dedupKey === 'import_coverage_gap|account|checks_limited')).toBe(true)
  })

  it('is bounded by maxInsights', async () => {
    const { runner, snapshots } = setup(() => sourcesFor('tenant_a'))
    await runJob(runner, job({ input: { trigger: 'manual', maxInsights: 1 } }))
    const result = snapshots.get(ctxA)!.envelope.result!
    expect(result.items).toHaveLength(1)
    expect(result.total).toBeGreaterThan(1)
  })

  it('never calls an AI gateway, even if a loader passes one along', async () => {
    let calls = 0
    const ai: AiGatewayPort = { enabled: true, policy: () => 'full', run: async () => (calls++, { status: 'disabled', reason: 'x' }) }
    const withAi = { ...sourcesFor('tenant_a'), ai } as TenantInsightSources
    const { runner, snapshots } = setup(() => withAi)
    await runJob(runner, job())
    expect(calls).toBe(0)
    expect(snapshots.get(ctxA)!.envelope.result!.aiSummaries).toBe('disabled')
  })

  it('manual refresh needs insights:refresh and matches the job result', async () => {
    const sources = sourcesFor('tenant_a')
    const snapshots = new InMemoryInsightSnapshotStore()
    const noRefresh: TenantContext = fixtureContext('tenant_a', ['financial:read', 'cases:read'])
    expect(() => refreshInsightsNow(noRefresh, sources, snapshots, NOW)).toThrow(IntelligenceAccessError)
    const manual = refreshInsightsNow(ctxA, sources, snapshots, NOW)
    expect(manual.reused).toBe(false)
    expect(refreshInsightsNow(ctxA, sources, snapshots, NOW + 1000).reused).toBe(true)
    const viaJob = setup(() => sources)
    await runJob(viaJob.runner, job())
    expect(viaJob.snapshots.get(ctxA)!.envelope.result!.items.map((i) => i.id)).toEqual(manual.snapshot.envelope.result!.items.map((i) => i.id))
    expect(insightInputsFingerprint(ctxA, sources, NOW)).toBe(manual.snapshot.inputsFingerprint)
  })

  it('the fixture runner is not a scheduler: it refuses unknown operations and runs nothing by itself', async () => {
    const runner = new FixtureJobRunner()
    await expect(runner.run(job())).rejects.toThrow('No handler registered')
    expect(runner.auditLog).toEqual([])
  })
})
