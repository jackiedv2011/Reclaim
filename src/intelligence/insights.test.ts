import { describe, expect, it } from 'vitest'
import { EMPTY_CASE_STATE } from '@/ledger/caseState'
import { approveRecovery, startRecoveryRequest } from '@/recovery/model'
import {
  NO_RETURN_MATCHING,
  type CaseReadPort,
  type CaseSnapshot,
  type DataOrigin,
  type FinancialSourcePort,
  type ImportCoverage,
  type RecurringSeriesView,
  type SourceRecord,
  type TenantContext,
} from './contracts.ts'
import { IntelligenceAccessError, requireTenant } from './envelope.ts'
import { createLegacyAuditSource, type StoredAudit } from './adapters/legacyAudit.ts'
import { auditFromCsv, findingsOf, fixtureContext, tenantAAudits, TENANT_A_Q1, TENANT_A_Q2_OVERLAP, withCaseState } from './fixtures/synthetic.ts'
import { InMemoryFeedbackStore, validateFeedbackInput, type FeedbackStore, type MemoryPorts } from './memory.ts'
import { compareToBaseline, vendorBaselines } from './baselines.ts'
import { vendorProfile } from './vendorProfiles.ts'
import { attentionQueue } from './attention.ts'
import { IntelligenceQueryError } from './spend.ts'
import { DISABLED_AI_GATEWAY, type AiGatewayPort, type AiTaskRequest, type TenantAiPolicy } from './aiGateway.ts'
import {
  ABOVE_BASELINE_LOOKBACK_DAYS,
  FORBIDDEN_INSIGHT_WORDS,
  INSIGHT_RULE_IDS,
  InMemoryInsightStateStore,
  InsightStateError,
  aiPacketFor,
  compareInsights,
  dismissInsight,
  findInsight,
  formatMoney,
  insightLookup,
  generateInsights,
  generateInsightsSync,
  type Insight,
  type InsightDeps,
} from './insights.ts'

// SYNTHETIC FIXTURES ONLY: fictional vendors and amounts, local tests.
const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 1, 12)
const ctxA = fixtureContext('tenant_a')
const ctxF = fixtureContext('tenant_f')

/** Every insight any test produced; the wording test at the end scans them all. */
const produced: Insight[] = []
function collect(items: Insight[]): Insight[] {
  produced.push(...items)
  return items
}

function deps(financial: FinancialSourcePort, cases: CaseReadPort, extra: Partial<InsightDeps> = {}): InsightDeps {
  return { financial, cases, returns: NO_RETURN_MATCHING, memory: new InMemoryFeedbackStore(), insightState: new InMemoryInsightStateStore(), ...extra }
}

function legacyDeps(tenantId: string, audits: StoredAudit[], extra: Partial<InsightDeps> = {}) {
  const source = createLegacyAuditSource(tenantId, audits)
  return { source, deps: deps(source.financial, source.cases, extra) }
}

function run(ctx: TenantContext, d: InsightDeps, now = NOW, options = {}) {
  const env = generateInsightsSync(ctx, d, now, { limit: 200, ...options })
  collect(env.result!.items)
  return env
}

function byRule(env: ReturnType<typeof run>, rule: string) {
  return env.result!.items.filter((i) => i.rule === rule)
}

// ---- hand-built ports (tenant F)

function rec(id: string, vendorKey: string, amount: number, date: string | null, o: Partial<SourceRecord> = {}): SourceRecord {
  return {
    recordId: `audit_f/${id}`,
    tenantId: 'tenant_f',
    auditId: 'audit_f',
    source: { system: 'fixture', importId: 'imp_1', accountId: null, nativeId: null, filename: null, rowNumber: null },
    kind: 'payment',
    vendor: { displayName: `Fixture ${vendorKey}`, vendorKey, stableSupplierId: null, aliasSuggestion: null },
    invoiceReference: id,
    amountMinor: amount,
    currency: 'USD',
    paymentDate: date,
    invoiceDate: date,
    category: 'Fixture',
    settlement: 'unknown',
    identityKey: `fp|${id}`,
    normalizationVersion: 'fixture-1',
    unknownFields: ['settlement'],
    ...o,
  }
}

function imp(importId: string, from: string | null, to: string | null, o: Partial<ImportCoverage> = {}): ImportCoverage {
  return { importId, auditId: 'audit_f', system: 'fixture', importedAt: NOW - DAY, acceptedRows: 10, rejectedRows: 0, dateRange: { from, to }, detectedColumns: [], ...o }
}

function fakeFinancial(records: SourceRecord[], imports: ImportCoverage[], series: RecurringSeriesView[] = [], tenantId = 'tenant_f', origin: DataOrigin = 'fixture'): FinancialSourcePort {
  return {
    origin,
    listSourceRecords: (ctx) => (requireTenant(ctx, tenantId), records),
    listImportCoverage: (ctx) => (requireTenant(ctx, tenantId), imports),
    overlapCount: (ctx) => (requireTenant(ctx, tenantId), 0),
    listRecurringSeries: (ctx) => (requireTenant(ctx, tenantId), series),
  }
}

function fakeCases(snaps: CaseSnapshot[], tenantId = 'tenant_f'): CaseReadPort {
  return { origin: 'fixture', listCases: (ctx) => (requireTenant(ctx, tenantId), snaps) }
}

function snap(caseId: string, o: Partial<CaseSnapshot> = {}): CaseSnapshot {
  return {
    caseId: `audit_f/${caseId}`,
    auditId: 'audit_f',
    findingId: caseId,
    findingType: 'exact_duplicate',
    ruleVersion: 1,
    vendor: { displayName: 'Fixture Coffee Co', vendorKey: 'vendor_coffee' },
    currency: 'USD',
    stage: 'requested',
    recoveryStage: 'requested',
    classification: 'recovery_candidate',
    suppressed: false,
    isClaim: true,
    flaggedMinor: 141025,
    supportedPotentialMinor: 141025,
    approvedRequestMinor: 141025,
    approvedAt: NOW - 50 * DAY,
    requestedAt: NOW - 45 * DAY,
    promisedMinor: null,
    promisedOutstandingMinor: null,
    latestVendorStatus: null,
    contactHold: false,
    requiresRevalidation: false,
    activeRequestGeneration: 1,
    customerRecordedReturnMinor: 0,
    matchedReturnMinor: null,
    outstandingMinor: 141025,
    dismissal: null,
    rootCause: null,
    reconciledAt: null,
    nextAction: { label: 'Wait for vendor', dueAt: null, requiresCustomer: false },
    statusLabel: 'Requested',
    revision: 3,
    sourceRecordIds: [],
    crossAuditKey: `key|${caseId}`,
    updatedAt: NOW - 45 * DAY,
    ...o,
  }
}

const COVERED_IMPORT = imp('imp_1', '2026-01-01', '2026-06-30')

function remember(store: FeedbackStore, ctx: TenantContext, ports: MemoryPorts, input: unknown, at = NOW) {
  const v = validateFeedbackInput(ctx, input, at, ports)
  if (!v.ok) throw new Error(JSON.stringify(v.issues))
  return store.create(ctx, v.value, at)
}

function strip(items: Insight[]) {
  return items.map(({ advisorySummary: _a, ai: _b, ...rest }) => rest)
}

// ---------------------------------------------------------------- tenant A (legacy adapter, hand-calculated)

describe('insights over tenant A saved audits (hand-calculated)', () => {
  const { deps: dA, source } = legacyDeps('tenant_a', tenantAAudits())
  const env = run(ctxA, dA)
  const coffeeKey = source.financial.listSourceRecords(ctxA).find((r) => r.vendor.displayName === 'Fixture Coffee Co')!.vendor.vendorKey

  it('flags the coffee payment above its established range, citing the baseline read model', () => {
    const [ins] = byRule(env, 'vendor_spend_above_baseline')
    // Baseline over 7 dated USD payments: 1200.00, 1350.50, 1410.25, 1410.25, 1300.00, 4980.00, 1295.75.
    // Lower median 1350.50; MAD 59.75; tolerance max(3 x 59.75, ceil 5% of median 67.53) = 179.25; upper 1529.75.
    expect(ins.figures.map((f) => [f.label, f.money.amountMinor, f.source.model])).toEqual([
      ['Payment on 2026-05-12', 498000, 'source_records'],
      ['Median payment', 135050, 'vendor_baselines'],
      ['Top of usual range', 152975, 'vendor_baselines'],
    ])
    expect(ins.measures.find((m) => m.unit === 'bps')!.value).toBe(36875) // 4980.00 / 1350.50 = 3.6875
    expect(ins.severity).toBe('medium')
    expect(ins.severityReason).toContain('3.7 times the median')
    expect(ins.title).toBe('Payments to Fixture Coffee Co in the covered records were above its usual range')
    expect(ins.explanation).toContain('USD 4,980.00 on 2026-05-12')
    expect(ins.subject).toEqual({ type: 'vendor', vendorKey: coffeeKey, displayName: 'Fixture Coffee Co' })
    expect(ins.nextAction).toEqual({ kind: 'review_vendor', target: { vendorKey: coffeeKey }, label: 'Review payments to Fixture Coffee Co', sideEffects: 'none' })
    expect(ins.provenance.readModels).toEqual([{ model: 'vendor_baselines', metricDefinitionVersion: 'baseline-v0.1' }])
    expect(ins.period).toMatchObject({ from: '2026-04-11', to: '2026-06-09', dataAsOf: '2026-06-09', computedAt: NOW })
    expect(ins.coverage.find((c) => c.check === 'vendor_baselines')!.reasons).toEqual(expect.arrayContaining(['customer_supplied_source', 'snapshot_not_continuous']))
    expect(ins.limits.split('. ').length).toBe(1)
    // Consumes, does not reimplement: same answer as the baseline read model directly.
    const b = vendorBaselines(ctxA, source.financial, NOW).result!.baselines.find((x) => x.vendorKey === coffeeKey && x.currency === 'USD')!
    expect(compareToBaseline(b, 498000)).toMatchObject({ label: 'above_range', ratioBps: 36875, upperBoundMinor: 152975 })
    const sourceRecord = source.financial.listSourceRecords(ctxA).find((r) => r.amountMinor === 498000)!
    expect(ins.sourceRefs.map((r) => r.id)).toContain(`record:${sourceRecord.recordId}`)
    expect(ins.expiresAt).toBe(Date.UTC(2026, 4, 12) + 120 * DAY)
  })

  it('never compares rent (identical payments, inside the 5% floor) or the single EUR vendor', () => {
    expect(byRule(env, 'vendor_spend_above_baseline')).toHaveLength(1)
    expect(env.result!.items.some((i) => i.figures.some((f) => f.money.currency === 'EUR'))).toBe(false)
  })

  it('reports rent concentration in USD with cent-exact read-model figures', () => {
    const [ins] = byRule(env, 'vendor_concentration')
    // Rent 6 x 4000.00 = 24,000.00; coffee 12,946.75; office 600.00; USD gross 37,546.75. 2,400,000 / 3,754,675 = 63.92%.
    expect(ins.figures.map((f) => f.money.amountMinor)).toEqual([2400000, 3754675])
    expect(ins.measures[0]).toMatchObject({ value: 6392, unit: 'bps' })
    expect(ins.severity).toBe('low')
    expect(ins.title).toBe('Fixture Property Mgmt received 63.9% of covered USD payments')
    expect(ins.provenance.readModels[0]).toEqual({ model: 'spend.by_vendor', metricDefinitionVersion: 'spend-v0.1' })
  })

  it('shows the recurring rent series once (folded across the two audits) with its cadence', () => {
    const rec = byRule(env, 'recurring_payment_visible')
    expect(rec).toHaveLength(1)
    expect(rec[0]).toMatchObject({ severity: 'low', period: expect.objectContaining({ from: '2026-03-01', to: '2026-06-01' }) })
    expect(rec[0].figures[0].money).toEqual({ currency: 'USD', amountMinor: 400000 })
    expect(rec[0].measures.find((m) => m.label === 'Cadence')!.unit).toBe('days')
    expect(rec[0].sourceRefs.filter((r) => r.id.startsWith('series:'))).toHaveLength(2)
  })

  it('does not compare windows that are not both covered (no vendor_change on six months of data)', () => {
    expect(byRule(env, 'vendor_change')).toHaveLength(0)
    expect(env.coverage.find((c) => c.check === 'insight:vendor_change')!.reasons).toContain('window_not_covered')
  })

  it('is deterministic: identical output for identical inputs, stable IDs', () => {
    const again = generateInsightsSync(ctxA, dA, NOW, { limit: 200 })
    expect(JSON.stringify(again)).toBe(JSON.stringify(env))
    for (const i of env.result!.items) expect(i.id).toMatch(new RegExp(`^ins_${i.rule}_[0-9a-f]{12}$`))
    const other = legacyDeps('tenant_a', tenantAAudits()).deps
    expect(generateInsightsSync(ctxA, other, NOW, { limit: 200 }).result!.items.map((i) => i.id)).toEqual(env.result!.items.map((i) => i.id))
  })

  it('orders by status, severity, rule priority, then figure within currency, then id', () => {
    const items = env.result!.items
    expect([...items].sort(compareInsights).map((i) => i.id)).toEqual(items.map((i) => i.id))
    expect(items[0].rule).toBe('vendor_spend_above_baseline')
  })

  it('pages with a bounded limit and an opaque cursor, and refuses malformed paging', () => {
    const p1 = generateInsightsSync(ctxA, dA, NOW, { limit: 1 })
    expect(p1.result!.items).toHaveLength(1)
    expect(p1.result!.nextCursor).toBe('o:1')
    const p2 = generateInsightsSync(ctxA, dA, NOW, { limit: 1, cursor: p1.result!.nextCursor })
    expect(p2.result!.items[0].id).toBe(env.result!.items[1].id)
    expect(() => generateInsightsSync(ctxA, dA, NOW, { cursor: 'abc' })).toThrow(IntelligenceQueryError)
    expect(() => generateInsightsSync(ctxA, dA, NOW, { limit: 0 })).toThrow(IntelligenceQueryError)
    expect(() => generateInsightsSync(ctxA, dA, NOW, { limit: 201 })).toThrow(IntelligenceQueryError)
  })

  it('finds one insight by ID (for "why does this insight exist"), and nothing for unknown IDs', () => {
    const first = env.result!.items[0]
    expect(findInsight(ctxA, dA, first.id, NOW)).toEqual(first)
    expect(findInsight(ctxA, dA, 'ins_vendor_change_000000000000', NOW)).toBeNull()
    expect(findInsight(ctxA, dA, '../../etc', NOW)).toBeNull()
  })

  it('offers the assistant a tenant-checked lookup with reason-code limits and figures keyed by their source metric', () => {
    const lookup = insightLookup(dA, NOW)
    const first = env.result!.items[0]
    const view = lookup(ctxA, first.id)!
    expect(view).toMatchObject({ id: first.id, tenantId: 'tenant_a', rule: first.rule, limitsText: first.limits })
    expect(view.figures).toEqual(first.figures.map((f) => ({ ...f.money, metric: `${f.source.model}.${f.source.field}` })))
    expect(view.limits).toEqual(expect.arrayContaining(['customer_supplied_source', 'snapshot_not_continuous']))
    expect(() => lookup(fixtureContext('tenant_b'), first.id)).toThrow(IntelligenceAccessError)
    expect(lookup(ctxA, 'ins_nothing_000000000000')).toBeNull()
  })

  it('refuses another tenant and a context without the read permissions', () => {
    expect(() => generateInsightsSync(fixtureContext('tenant_b'), dA, NOW)).toThrow(IntelligenceAccessError)
    expect(() => generateInsightsSync(fixtureContext('tenant_a', ['financial:read']), dA, NOW)).toThrow(IntelligenceAccessError)
    expect(() => generateInsightsSync(fixtureContext('tenant_a', ['cases:read']), dA, NOW)).toThrow(IntelligenceAccessError)
  })
})

// ---------------------------------------------------------------- vendor change and misleading comparisons

describe('vendor change and baseline comparisons need enough covered history', () => {
  const months = ['01', '02', '03', '04', '05', '06', '07']
  const CLEANING = months.map((m, i) => {
    const amount = i < 4 ? '1000.00' : '2500.00'
    return `Fixture Cleaning Co,CL-${m},2026-${m}-01,2026-${m}-01,${amount},${amount},net 30,5151,Services,USD,`
  })

  it('reports a 150% higher latest window when both 90-day windows are covered, using the profile figures', () => {
    const ctx = fixtureContext('tenant_c')
    const { deps: d, source } = legacyDeps('tenant_c', [auditFromCsv('audit_c', CLEANING)])
    const env = run(ctx, d)
    const [ins] = byRule(env, 'vendor_change')
    // Anchor 2026-07-01. Recent window 04-03..07-01: May, Jun, Jul at 2500.00 = 7500.00.
    // Prior window 01-03..04-02: Feb, Mar, Apr at 1000.00 = 3000.00. (7500 - 3000) / 3000 = +150%.
    expect(ins.figures.map((f) => f.money.amountMinor)).toEqual([750000, 300000])
    expect(ins.measures[0]).toMatchObject({ value: 15000, unit: 'bps' })
    expect(ins.severity).toBe('medium')
    expect(ins.title).toBe('Payments to Fixture Cleaning Co in the covered records were higher in the latest 90 days')
    const key = source.financial.listSourceRecords(ctx)[0].vendor.vendorKey
    const change = vendorProfile(ctx, source.financial, source.cases, d.memory, key, NOW).result!.recentChange[0]
    expect([change.recentGrossMinor, change.priorGrossMinor, change.changeBps]).toEqual([750000, 300000, 15000])
    expect(ins.period).toMatchObject({ from: '2026-01-03', to: '2026-07-01' })
  })

  it('never produces a baseline insight from insufficient history, and says the check was limited instead', () => {
    const ctx = fixtureContext('tenant_s')
    const rows = [
      'Fixture Sparse Co,SP-1,2026-01-05,2026-01-10,100.00,100.00,net 5,6161,Misc,USD,',
      'Fixture Sparse Co,SP-2,2026-02-05,2026-02-10,100.00,100.00,net 5,6161,Misc,USD,',
      'Fixture Sparse Co,SP-3,2026-03-05,2026-03-10,9000.00,9000.00,net 5,6161,Misc,USD,',
    ]
    const env = run(ctx, legacyDeps('tenant_s', [auditFromCsv('audit_s', rows)]).deps)
    expect(byRule(env, 'vendor_spend_above_baseline')).toHaveLength(0)
    expect(env.coverage.find((c) => c.check === 'insight:vendor_spend_above_baseline')!.reasons).toContain('insufficient_history')
    const limited = env.result!.items.find((i) => i.dedupKey === 'import_coverage_gap|account|checks_limited')!
    expect(limited.explanation).toContain('not a confirmation that payments are in order')
    expect(limited.explanation).toContain('vendor spend above baseline')
    expect(env.result!.emptyState).toBeNull()
  })

  it('never establishes a baseline or concentration for an unknown currency, and surfaces the missing currency', () => {
    const records = [1, 2, 3, 4, 5, 6].map((m) => rec(`u${m}`, 'v_unknown', m === 6 ? 900000 : 10000, `2026-0${m}-10`, { currency: 'UNKNOWN', unknownFields: ['currency', 'settlement'] }))
    const env = run(ctxF, deps(fakeFinancial(records, [COVERED_IMPORT]), fakeCases([])))
    expect(byRule(env, 'vendor_spend_above_baseline')).toHaveLength(0)
    expect(byRule(env, 'vendor_concentration')).toHaveLength(0)
    const missing = env.result!.items.find((i) => i.dedupKey === 'import_coverage_gap|account|missing_currency')!
    expect(missing.explanation).toBe('6 rows in the covered records have no recognisable currency. They are reported in a separate bucket and left out of baselines and comparisons.')
  })
})

// ---------------------------------------------------------------- coverage insights (anti "clean bill of health")

describe('import coverage gaps are always surfaced', () => {
  it('with no data at all, says nothing was reviewed and never claims a clean result', () => {
    const env = run(ctxF, deps(fakeFinancial([], []), fakeCases([])))
    const items = env.result!.items
    expect(items.map((i) => i.dedupKey)).toEqual(['import_coverage_gap|account|no_data', 'import_coverage_gap|account|checks_limited'])
    expect(items[0]).toMatchObject({ title: 'No covered records yet', severity: 'medium', nextAction: { kind: 'request_records' } })
    expect(env.coverage.find((c) => c.check === 'insight:vendor_spend_above_baseline')!.status).toBe('not_run')
  })

  it('reports uncovered periods, with medium severity for a gap of 31 days or more', () => {
    const records = [rec('a', 'v1', 1000, '2026-01-15'), rec('b', 'v1', 1000, '2026-04-15')]
    const short = run(ctxF, deps(fakeFinancial(records, [imp('i1', '2026-01-01', '2026-01-31'), imp('i2', '2026-02-15', '2026-03-31')]), fakeCases([])))
    const s = short.result!.items.find((i) => i.dedupKey === 'import_coverage_gap|account|period_gaps')!
    expect(s.severity).toBe('low')
    expect(s.explanation).toContain('2026-02-01 to 2026-02-14')
    expect(s.nextAction).toEqual({ kind: 'request_records', target: { from: '2026-02-01', to: '2026-02-14' }, label: 'Import records for the uncovered periods', sideEffects: 'none' })
    const long = run(ctxF, deps(fakeFinancial(records, [imp('i1', '2026-01-01', '2026-01-31'), imp('i2', '2026-04-01', '2026-04-30')]), fakeCases([])))
    const l = long.result!.items.find((i) => i.dedupKey === 'import_coverage_gap|account|period_gaps')!
    expect(l.severity).toBe('medium')
    expect(l.measures.find((m) => m.unit === 'days')!.value).toBe(59) // Feb 1 .. Mar 31
  })

  it('reports rejected rows per import, medium at 5% or more', () => {
    const env = run(ctxF, deps(fakeFinancial([rec('a', 'v1', 1000, '2026-01-15')], [imp('i1', '2026-01-01', '2026-01-31', { acceptedRows: 90, rejectedRows: 10 }), imp('i2', '2026-01-01', '2026-01-31', { acceptedRows: 999, rejectedRows: 1 })]), fakeCases([])))
    const rejected = env.result!.items.filter((i) => i.dedupKey.endsWith('|rejected_rows'))
    expect(rejected.map((i) => [i.subject, i.severity])).toEqual([
      [{ type: 'import', importId: 'i1', auditId: 'audit_f' }, 'medium'],
      [{ type: 'import', importId: 'i2', auditId: 'audit_f' }, 'low'],
    ])
    expect(rejected[0].explanation).toBe('10 rows of 100 in this fixture import could not be read, so they were left out of every check and figure.')
  })

  it('reports stale covered records and labels every insight as historical', () => {
    const records = [rec('a', 'v1', 1000, '2026-01-15')]
    const env = run(ctxF, deps(fakeFinancial(records, [imp('i1', '2026-01-01', '2026-01-31', { importedAt: NOW - 60 * DAY })]), fakeCases([])))
    const stale = env.result!.items.find((i) => i.dedupKey === 'import_coverage_gap|account|stale_data')!
    expect(stale.severity).toBe('medium')
    expect(stale.explanation).toContain('Insights shown are historical, not current monitoring.')
    expect(env.freshness.stale).toBe(true)
  })

  it('reports saved audits that could not be read', () => {
    const audits = [{ id: 'broken', environment: { nope: true } }, ...tenantAAudits()]
    const source = createLegacyAuditSource('tenant_a', audits)
    const env = run(ctxA, deps(source.financial, source.cases), NOW, { unreadableAuditIds: source.unreadableAuditIds })
    const ins = env.result!.items.find((i) => i.dedupKey === 'import_coverage_gap|account|unreadable_audits')!
    expect(ins).toMatchObject({ severity: 'medium', nextAction: { kind: 'review_import_coverage', target: { importId: null, auditIds: ['broken'] } } })
    expect(env.coverage.find((c) => c.check === 'insight:import_coverage_gap')!.reasons).toContain('unreadable_saved_audit')
  })
})

// ---------------------------------------------------------------- recovery, attention, prevention

describe('unresolved recovery, approvals, follow-ups and prevention', () => {
  const fin = fakeFinancial([], [COVERED_IMPORT])

  it('ages open requests (31+ medium, 61+ high), keeps lifecycle figures apart and skips recent or closed requests', () => {
    const cases = [
      snap('aging45'),
      snap('aging75', { requestedAt: NOW - 75 * DAY, crossAuditKey: 'k75' }),
      snap('recent10', { requestedAt: NOW - 10 * DAY }),
      snap('disputed5', { requestedAt: NOW - 5 * DAY, latestVendorStatus: 'disputed', statusLabel: 'Disputed by vendor' }),
      snap('partial', { requestedAt: NOW - 12 * DAY, customerRecordedReturnMinor: 40000, outstandingMinor: 101025, latestVendorStatus: 'promised', promisedMinor: 141025, promisedOutstandingMinor: 101025 }),
      snap('nodate', { requestedAt: null }),
      snap('internal', { isClaim: false }),
      snap('closed', { stage: 'recovered', recoveryStage: 'recovered', outstandingMinor: 0 }),
    ]
    const env = run(ctxF, deps(fin, fakeCases(cases)))
    const got = Object.fromEntries(byRule(env, 'unresolved_recovery').map((i) => [(i.subject as { caseId: string }).caseId.split('/')[1], i]))
    expect(Object.keys(got).sort()).toEqual(['aging45', 'aging75', 'disputed5', 'nodate', 'partial'])
    expect(got.aging75.severity).toBe('high')
    expect(got.aging45).toMatchObject({ severity: 'medium', title: 'Request to Fixture Coffee Co still open after 45 days' })
    expect(got.aging45.explanation).toContain('USD 1,410.25 is still open on it')
    expect(got.disputed5.severity).toBe('medium')
    expect(got.disputed5.explanation).toContain('"Disputed by vendor"')
    expect(got.nodate.severity).toBe('low')
    // Outstanding, promised and customer-recorded stay separate figures; nothing is summed.
    expect(got.partial.figures.map((f) => [f.source.field, f.money.amountMinor])).toEqual([['approvedOutstanding', 101025], ['promised', 101025], ['customerRecordedReturns', 40000]])
    expect(got.partial.explanation).toContain('not been matched to a bank or accounting record')
    expect(got.aging45.nextAction).toEqual({ kind: 'open_case', target: { caseId: 'audit_f/aging45' }, label: 'Open the Fixture Coffee Co case', sideEffects: 'none' })
    expect(got.aging45.coverage.find((c) => c.check === 'matched_returns')!.status).toBe('not_run')
  })

  it('ages a request made through the real case model in a saved audit', () => {
    let audit = auditFromCsv('audit_a_q1', TENANT_A_Q1)
    const dup = findingsOf(audit).find((f) => f.type === 'exact_duplicate')!
    const t0 = NOW - 40 * DAY
    let state = approveRecovery({ ...EMPTY_CASE_STATE, decision: 'confirmed', decidedAt: t0, recoveryStage: 'confirmed' }, { at: t0, knownBeforeReclaim: false })
    state = startRecoveryRequest(state, 1410.25, t0)
    audit = withCaseState(audit, dup.id, state)
    const env = run(ctxA, legacyDeps('tenant_a', [audit]).deps)
    const [ins] = byRule(env, 'unresolved_recovery')
    expect(ins.measures[0]).toMatchObject({ value: 40, unit: 'days' })
    expect(ins.figures[0].money).toEqual({ currency: 'USD', amountMinor: 141025 })
    expect(ins.coverage.find((c) => c.check === 'recovery_cases')!.reasons).toEqual(expect.arrayContaining(['customer_supplied_source', 'snapshot_not_continuous']))
  })

  it('summarizes approvals and follow-ups from the attention queue, high when a follow-up is overdue', () => {
    const approvals = ['a1', 'a2'].map((id) => snap(id, { stage: 'confirmed', recoveryStage: 'confirmed', approvedAt: null, requestedAt: null, outstandingMinor: 0, nextAction: { label: 'Approve recovery', dueAt: null, requiresCustomer: true } }))
    const due = snap('due', { requestedAt: NOW - 5 * DAY, nextAction: { label: 'Follow up with vendor', dueAt: NOW - 1 * DAY, requiresCustomer: true } })
    const overdue = snap('overdue', { requestedAt: NOW - 6 * DAY, nextAction: { label: 'Follow up with vendor', dueAt: NOW - 10 * DAY, requiresCustomer: true } })
    const cases = fakeCases([...approvals, due, overdue])
    const env = run(ctxF, deps(fin, cases))
    const queue = attentionQueue(ctxF, cases, NOW).result!.counts
    const [ap] = byRule(env, 'approvals_due')
    expect(ap.measures[0].value).toBe(queue.byCategory.requires_approval)
    expect(ap).toMatchObject({ severity: 'medium', title: '2 supplier requests are waiting for your approval', nextAction: { kind: 'open_attention', target: { category: 'requires_approval' } } })
    expect(ap.explanation).toContain('Approving does not send anything')
    const [fu] = byRule(env, 'follow_ups_due')
    expect(fu.measures.map((m) => m.value)).toEqual([queue.byKind.follow_up_due, queue.byKind.follow_up_overdue])
    expect(fu.measures.map((m) => m.value)).toEqual([1, 1])
    expect(fu.severity).toBe('high')
    expect(fu.figures).toEqual([])
  })

  it('offers static prevention guidance from recorded root causes and repeated dismissals, as a suggestion', () => {
    const rooted = ['r1', 'r2'].map((id) => snap(id, { stage: 'recovered', recoveryStage: 'recovered', outstandingMinor: 0, customerRecordedReturnMinor: 141025, rootCause: 'Invoice entered twice', reconciledAt: NOW - 5 * DAY }))
    const dismissed = ['d1', 'd2', 'd3'].map((id) => snap(id, { findingType: 'near_duplicate', stage: 'dismissed', recoveryStage: null, outstandingMinor: 0, dismissal: { tag: 'not_a_match', reason: 'Different deliveries' } }))
    const twice = ['e1', 'e2'].map((id) => snap(id, { findingType: 'overpayment', stage: 'dismissed', recoveryStage: null, outstandingMinor: 0, dismissal: { tag: 'intentional', reason: 'Deposit' } }))
    const env = run(ctxF, deps(fin, fakeCases([...rooted, ...dismissed, ...twice])))
    const items = byRule(env, 'prevention_guidance')
    expect(items.map((i) => i.dedupKey)).toEqual(['prevention_guidance|account|dismissals:near_duplicate:not_a_match', 'prevention_guidance|account|root_cause:exact_duplicate'].sort())
    const root = items.find((i) => i.dedupKey.endsWith('root_cause:exact_duplicate'))!
    expect(root.explanation).toContain('"Invoice entered twice" 2')
    expect(root.explanation).toContain('Consider checking duplicate-bill warnings in your accounting system, if it offers them')
    expect(root).toMatchObject({ severity: 'low', nextAction: { kind: 'review_prevention', target: { findingType: 'exact_duplicate' } } })
    const rep = items.find((i) => i.dedupKey.includes('dismissals'))!
    expect(rep.explanation).toContain('nothing is suppressed automatically')
    // The dismissals are read-only memory entries; the insight shows which ones influenced it.
    expect(rep.influencedBy).toEqual(['dismissal:audit_f/d1', 'dismissal:audit_f/d2', 'dismissal:audit_f/d3'])
  })
})

// ---------------------------------------------------------------- memory, dismissal, expiry

describe('business memory influence, dismissal and expiry', () => {
  it('lists the memory entries that touch an insight, and a revoked entry re-shows a dismissed insight', () => {
    const memory = new InMemoryFeedbackStore()
    const { deps: d, source } = legacyDeps('tenant_a', tenantAAudits(), { memory })
    const ports = { financial: source.financial, cases: source.cases }
    const coffeeKey = source.financial.listSourceRecords(ctxA).find((r) => r.vendor.displayName === 'Fixture Coffee Co')!.vendor.vendorKey
    const note = remember(memory, ctxA, ports, { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: coffeeKey }, rationale: 'Seasonal bulk order in May.' })
    const ins = byRule(run(ctxA, d), 'vendor_spend_above_baseline')[0]
    expect(ins.influencedBy).toEqual([note.id])
    expect(ins.provenance.readModels.map((r) => r.model)).toContain('memory_influence')

    dismissInsight(ctxA, d, ins.id, 'Known seasonal order', NOW)
    const hidden = run(ctxA, d, NOW + DAY)
    expect(hidden.result!.items.find((i) => i.id === ins.id)).toBeUndefined()
    expect(hidden.result!.suppressedByDismissal).toBe(1)
    const withDismissed = run(ctxA, d, NOW + DAY, { includeDismissed: true })
    expect(withDismissed.result!.items.find((i) => i.id === ins.id)).toMatchObject({ status: 'dismissed', dismissal: { reason: 'Known seasonal order', dismissedBy: 'tenant_a' } })

    memory.revoke(ctxA, note.id, 'Not seasonal after all', NOW + 2 * DAY)
    const back = run(ctxA, d, NOW + 3 * DAY).result!.items.find((i) => i.id === ins.id)!
    expect(back.status).toBe('active')
    expect(back.influencedBy).toEqual([])
    expect(back.previousDismissal).toEqual({ dismissedAt: NOW, invalidatedBecause: 'evidence_changed' })
  })

  it('downgrades (never hides) an above-range payment a reviewer recorded as intentional', () => {
    const memory = new InMemoryFeedbackStore()
    const { deps: d, source } = legacyDeps('tenant_a', tenantAAudits(), { memory })
    const big = source.financial.listSourceRecords(ctxA).find((r) => r.amountMinor === 498000)!
    const entry = remember(memory, ctxA, { financial: source.financial, cases: source.cases }, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: [big.recordId] }, rationale: 'Annual prepayment.' })
    const ins = byRule(run(ctxA, d), 'vendor_spend_above_baseline')[0]
    expect(ins.severity).toBe('low')
    expect(ins.severityReason).toContain(entry.id)
    expect(ins.influencedBy).toEqual([entry.id])
  })

  it('re-shows a dismissed insight when a reimport changes its evidence, and keeps the same ID', () => {
    const insightState = new InMemoryInsightStateStore()
    const before = legacyDeps('tenant_a', tenantAAudits(), { insightState }).deps
    const ins = byRule(run(ctxA, before), 'vendor_spend_above_baseline')[0]
    dismissInsight(ctxA, before, ins.id, 'Reviewed', NOW)
    // The same rows saved again as a different audit: new record IDs, same vendor, currency and month.
    const reimported = legacyDeps('tenant_a', [auditFromCsv('audit_a_q1', TENANT_A_Q1), auditFromCsv('audit_a_q2_resaved', TENANT_A_Q2_OVERLAP)], { insightState }).deps
    const after = run(ctxA, reimported).result!.items.find((i) => i.id === ins.id)!
    expect(after.status).toBe('active')
    expect(after.previousDismissal?.invalidatedBecause).toBe('evidence_changed')
  })

  it('a dismissal expires by time; an insight anchored on old evidence becomes expired (historical)', () => {
    const { deps: d } = legacyDeps('tenant_a', tenantAAudits())
    const ins = byRule(run(ctxA, d), 'vendor_spend_above_baseline')[0]
    const dismissal = dismissInsight(ctxA, d, ins.id, 'Reviewed', NOW, { ttlDays: 10 })
    expect(dismissal.expiresAt).toBe(NOW + 10 * DAY)
    expect(run(ctxA, d, NOW + 11 * DAY).result!.items.find((i) => i.id === ins.id)!.previousDismissal?.invalidatedBecause).toBe('dismissal_expired')
    const later = run(ctxA, d, ins.expiresAt!)
    const expired = later.result!.items.find((i) => i.id === ins.id)!
    expect(expired.status).toBe('expired')
    expect(later.result!.items.findIndex((i) => i.id === ins.id)).toBeGreaterThan(later.result!.items.findIndex((i) => i.status === 'active'))
    expect(generateInsightsSync(ctxA, d, ins.expiresAt!, { includeExpired: false }).result!.items.some((i) => i.id === ins.id)).toBe(false)
  })

  it('dismissal is tenant-partitioned, permissioned and validated', () => {
    const insightState = new InMemoryInsightStateStore()
    const { deps: d } = legacyDeps('tenant_a', tenantAAudits(), { insightState })
    const ins = run(ctxA, d).result!.items[0]
    expect(() => dismissInsight(fixtureContext('tenant_a', ['financial:read', 'cases:read']), d, ins.id, 'x', NOW)).toThrow(IntelligenceAccessError)
    expect(() => dismissInsight(ctxA, d, ins.id, '   ', NOW)).toThrow(InsightStateError)
    expect(() => dismissInsight(ctxA, d, ins.id, 'ok', NOW, { ttlDays: 1000 })).toThrow(InsightStateError)
    expect(() => dismissInsight(ctxA, d, 'ins_vendor_change_000000000000', 'ok', NOW)).toThrow(InsightStateError)
    dismissInsight(ctxA, d, ins.id, 'ok', NOW)
    expect(insightState.list(ctxA)).toHaveLength(1)
    expect(insightState.list(fixtureContext('tenant_b'))).toHaveLength(0)
    expect(insightState.undismiss(ctxA, ins.dedupKey)).toBe(true)
    expect(insightState.list(ctxA)).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- optional AI

function fakeAi(textFor: (req: AiTaskRequest) => string, policy: TenantAiPolicy = 'full', fail = false): AiGatewayPort & { calls: AiTaskRequest[] } {
  const calls: AiTaskRequest[] = []
  return {
    enabled: true,
    calls,
    policy: () => policy,
    run: async (_ctx, req) => {
      calls.push(req)
      if (fail) throw new Error('provider timeout')
      return { status: 'ok', text: textFor(req), citations: [...req.allowedCitations], model: 'fixture-model', invocationId: `inv_${calls.length}` }
    },
  }
}

describe('optional AI summaries are advisory, validated and never change the deterministic insight', () => {
  const audits = tenantAAudits()
  const base = () => legacyDeps('tenant_a', audits).deps

  it('with the disabled gateway (default) nothing changes', async () => {
    const plain = generateInsightsSync(ctxA, base(), NOW)
    const disabled = await generateInsights(ctxA, { ...base(), ai: DISABLED_AI_GATEWAY }, NOW)
    expect(JSON.stringify(disabled)).toBe(JSON.stringify(plain))
    expect(disabled.result!.aiSummaries).toBe('disabled')
  })

  it('does not call a gateway whose tenant policy is off', async () => {
    const ai = fakeAi(() => 'text', 'off')
    const env = await generateInsights(ctxA, { ...base(), ai }, NOW)
    expect(ai.calls).toHaveLength(0)
    expect(env.result!.aiSummaries).toBe('policy_off')
  })

  it('attaches valid text, rejects invented numbers and unsupported claims, and keeps core insights identical', async () => {
    const ai = fakeAi((req) =>
      req.packet.rule === 'vendor_spend_above_baseline' ? 'The highest covered payment, 4980.00, sat well above the usual range for this vendor.'
        : req.packet.rule === 'vendor_concentration' ? 'This vendor received 99% of payments, about 12000.00 more than others.'
          : 'This looks like fraud by the supplier.')
    const plain = generateInsightsSync(ctxA, base(), NOW)
    const env = await generateInsights(ctxA, { ...base(), ai }, NOW)
    expect(strip(env.result!.items)).toEqual(strip(plain.result!.items))
    const [baseline, concentration, recurring] = ['vendor_spend_above_baseline', 'vendor_concentration', 'recurring_payment_visible'].map((r) => env.result!.items.find((i) => i.rule === r)!)
    expect(baseline.ai).toEqual({ status: 'attached', reason: null })
    expect(baseline.advisorySummary).toMatchObject({ provenance: 'ai_gateway_advisory', task: 'summarize_insight', citations: [`insight:${baseline.id}`] })
    expect(concentration).toMatchObject({ ai: { status: 'rejected', reason: 'number_not_in_packet' }, advisorySummary: null })
    expect(recurring).toMatchObject({ ai: { status: 'rejected', reason: 'unsupported_claim_wording' }, advisorySummary: null })
    expect(env.result!.aiOutcomes).toEqual({ attached: 1, rejected: 2, unavailable: 0 })
    // Minimal packet: no vendor names, record IDs or dates.
    const packets = JSON.stringify(ai.calls)
    expect(packets).not.toContain('Fixture')
    expect(packets).not.toContain('audit_a')
    expect(packets).not.toMatch(/2026-\d\d-\d\d/)
  })

  it('treats a failing gateway as unavailable and keeps the deterministic insight', async () => {
    const env = await generateInsights(ctxA, { ...base(), ai: fakeAi(() => '', 'full', true) }, NOW)
    expect(env.result!.items.every((i) => i.ai.status === 'unavailable' && i.advisorySummary === null)).toBe(true)
    expect(env.result!.items[0].title).toBe('Payments to Fixture Coffee Co in the covered records were above its usual range')
  })

  it('builds the packet from the insight’s own figures only', () => {
    const ins = generateInsightsSync(ctxA, base(), NOW).result!.items[0]
    const packet = aiPacketFor(ins)
    expect(packet.packet.figureAmounts).toEqual(['4980.00', '1350.50', '1529.75'])
    expect(packet.allowedCitations).toEqual([`insight:${ins.id}`])
  })
})

// ---------------------------------------------------------------- wording

describe('wording', () => {
  it('formats money without locale data and never combines currencies', () => {
    expect(formatMoney({ currency: 'USD', amountMinor: 123456789 })).toBe('USD 1,234,567.89')
    expect(formatMoney({ currency: 'EUR', amountMinor: -5005 })).toBe('EUR -50.05')
    expect(formatMoney({ currency: 'UNKNOWN', amountMinor: 100 })).toBe('1.00 (currency not recorded)')
  })

  it('no insight from any scenario asserts an unsupported cause, a debt, a verification or a clean result', () => {
    expect(produced.length).toBeGreaterThan(30)
    const rules = new Set(produced.map((i) => i.rule))
    for (const r of INSIGHT_RULE_IDS) expect(rules.has(r)).toBe(true)
    for (const i of produced) {
      const text = [i.title, i.explanation, i.limits, i.severityReason, i.nextAction.label, ...i.figures.map((f) => f.label), ...i.measures.map((m) => m.label)].join(' ').toLowerCase()
      for (const word of FORBIDDEN_INSIGHT_WORDS) expect(text, `${i.rule}: ${word}`).not.toContain(word)
      expect(i.limits.length).toBeGreaterThan(20)
      expect(i.nextAction.sideEffects).toBe('none')
    }
    // The lookback constant is the one the copy names.
    expect(produced.find((i) => i.rule === 'vendor_spend_above_baseline')!.explanation).toContain(`latest ${ABOVE_BASELINE_LOOKBACK_DAYS} days`)
  })
})
