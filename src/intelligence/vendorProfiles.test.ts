import { describe, expect, it } from 'vitest'
import { approveRecovery, startRecoveryRequest, verifyRecovery } from '@/recovery/model'
import { EMPTY_CASE_STATE } from '@/ledger/caseState'
import type { CaseReadPort, FinancialSourcePort, TenantContext } from './contracts.ts'
import { createLegacyAuditSource } from './adapters/legacyAudit.ts'
import { auditFromCsv, findingsOf, fixtureContext, tenantAAudits, tenantBAudits, withCaseState } from './fixtures/synthetic.ts'
import { IntelligenceAccessError } from './envelope.ts'
import { compareToBaseline } from './baselines.ts'
import { InMemoryFeedbackStore, validateFeedbackInput, type FeedbackStore, type MemoryPorts } from './memory.ts'
import { ALIAS_CONFIRMED_LABEL, ALIAS_PROPOSED_LABEL, RECURRING_LABEL, coveredIntervals, vendorProfile, vendorProfiles } from './vendorProfiles.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 1)
const ctxA = fixtureContext('tenant_a')
const ctxB = fixtureContext('tenant_b')
const ctxC = fixtureContext('tenant_c')

/**
 * SYNTHETIC: tenant C, a full year (2025) of monthly hosting payments with a
 * step change in July and October, a one-off row whose vendor name is a typo
 * of the hosting supplier, and a freight row with no invoice, category or
 * currency.
 */
const TENANT_C_2025 = [
  ...[1, 2, 3, 4, 5, 6].map((m) => `Fixture Cloud Hosting,CH-${m},2025-0${m}-01,2025-0${m}-05,500.00,500.00,net 5,7777,Software,USD,`),
  ...[7, 8, 9].map((m) => `Fixture Cloud Hosting,CH-${m},2025-0${m}-01,2025-0${m}-05,600.00,600.00,net 5,7777,Software,USD,`),
  ...[10, 11, 12].map((m) => `Fixture Cloud Hosting,CH-${m},2025-${m}-01,2025-${m}-05,700.00,700.00,net 5,7777,Software,USD,`),
  'Fixture Clod Hosting,CH-X1,2025-03-10,2025-03-15,120.00,120.00,net 5,7777,Software,USD,',
  'Fixture Freight,,2025-06-01,2025-06-03,250.00,250.00,,5555,,,',
]

interface Ports {
  financial: FinancialSourcePort
  cases: CaseReadPort
}

function portsA(): Ports {
  const s = createLegacyAuditSource('tenant_a', tenantAAudits())
  return { financial: s.financial, cases: s.cases }
}

function portsC(): Ports {
  const s = createLegacyAuditSource('tenant_c', [auditFromCsv('audit_c_2025', TENANT_C_2025, { updatedAt: Date.UTC(2025, 11, 31) })])
  return { financial: s.financial, cases: s.cases }
}

function keyOf(p: Ports, ctx: TenantContext, name: string): string {
  return p.financial.listSourceRecords(ctx).find((r) => r.vendor.displayName === name)!.vendor.vendorKey
}

function remember(store: FeedbackStore, ctx: TenantContext, ports: MemoryPorts, input: unknown, at = NOW) {
  const v = validateFeedbackInput(ctx, input, at, ports)
  if (!v.ok) throw new Error(JSON.stringify(v.issues))
  return store.create(ctx, v.value, at)
}

const DUP_Q1 = 'audit_a_q1/exact_duplicate-rec_5-rec_6'

describe('vendorProfile on tenant A (hand-calculated)', () => {
  it('builds the coffee supplier profile with gross spend, cadence, cases and evidence quality', () => {
    const p = portsA()
    const coffee = keyOf(p, ctxA, 'Fixture Coffee Co')
    const env = vendorProfile(ctxA, p.financial, p.cases, new InMemoryFeedbackStore(), coffee, NOW)
    const profile = env.result!
    expect(profile.primaryName).toBe('Fixture Coffee Co')
    expect(profile.aliases.displayNamesSeen).toEqual([{ name: 'Fixture Coffee Co', recordCount: 7, caseCount: 3 }])
    // 120000 + 135050 + 141025 + 141025 + 130000 + 498000 + 129575 = 1294675 (the March repeat in audit_a_q2 counted once)
    expect(profile.spend).toEqual([{ currency: 'USD', grossPaymentsMinor: 1294675, paymentCount: 7, refundsAndCredits: { count: 0, amountMinor: 0 }, unknownKindCount: 0 }])
    expect(profile.coveredPeriod).toEqual({ from: '2026-01-20', to: '2026-06-09' })
    expect(profile.baselines[0]).toMatchObject({ status: 'established', medianPaymentMinor: 135050, medianGapDays: 16 })
    // Three case rows; the duplicate check appears in both audits and is counted once.
    expect(profile.cases).toMatchObject({
      caseCount: 2,
      crossAuditDuplicates: 1,
      caseIds: [DUP_Q1, 'audit_a_q2/amount_outlier-rec_7'],
      supportedPotentialInPlay: [],
      customerRecordedReturn: [],
      matchedReturn: 'not_available',
    })
    expect(profile.cases.byStage.unreviewed).toBe(2)
    expect(profile.evidenceQuality).toMatchObject({ recordCount: 7, withInvoiceReference: 7, withCategory: 7, shareBps: { invoiceReference: 10000, category: 10000, knownCurrency: 10000, paymentDate: 10000 } })
    // Q1 covers Jan 1 – Mar 10, Q2 (after dropping repeats) Apr 1 – Jun 9: the 180 days before Jun 9 are not covered.
    expect(profile.recentChange).toEqual([expect.objectContaining({ currency: 'USD', status: 'insufficient_history', changeBps: null, recentGrossMinor: null })])
    expect(profile.recentChange[0].reasons).toEqual(['insufficient_history', 'snapshot_not_continuous', 'window_not_covered'])
    expect(env.exclusions).toEqual([{ code: 'cross_audit_duplicate_case', count: 1, amounts: [], detail: expect.any(String) }])
  })

  it('keeps refunds apart from gross payments and reports missing categories as data quality', () => {
    const p = portsA()
    const office = vendorProfile(ctxA, p.financial, p.cases, new InMemoryFeedbackStore(), keyOf(p, ctxA, 'Fixture Office Supply'), NOW)
    // OS-77 31040 + OS-78 28960 = 60000 gross; the -5000 refund row is reported beside it, not netted.
    expect(office.result!.spend).toEqual([{ currency: 'USD', grossPaymentsMinor: 60000, paymentCount: 2, refundsAndCredits: { count: 1, amountMinor: -5000 }, unknownKindCount: 0 }])
    expect(office.result!.evidenceQuality).toMatchObject({ recordCount: 3, withCategory: 0, shareBps: { category: 0 } })
    expect(office.result!.baselines[0].status).toBe('insufficient_history')
    expect(office.coverage.find((c) => c.check === 'vendor_profiles')!.reasons).toEqual(expect.arrayContaining(['customer_supplied_source', 'snapshot_not_continuous', 'missing_category', 'cross_audit_overlap']))
  })

  it('shows the rent series as recurring, not flagged, with any confirmation from memory', () => {
    const p = portsA()
    const store = new InMemoryFeedbackStore()
    const rent = keyOf(p, ctxA, 'Fixture Property Mgmt')
    const seriesId = p.financial.listRecurringSeries(ctxA).find((s) => s.auditId === 'audit_a_q1')!.seriesId
    const conf = remember(store, ctxA, p, { kind: 'recurring_confirmation', scope: { type: 'recurring_series', vendorKey: rent, recurringSeriesId: seriesId }, rationale: 'Monthly lease.', details: { assertion: 'recurring_expected' } })
    const profile = vendorProfile(ctxA, p.financial, p.cases, store, rent, NOW).result!
    expect(profile.recurringSeries).toHaveLength(2) // as recorded in each audit
    expect(profile.recurringSeries.every((s) => s.label === RECURRING_LABEL)).toBe(true)
    expect(profile.recurringSeries.find((s) => s.seriesId === seriesId)!.confirmations).toEqual([{ entryId: conf.id, assertion: 'recurring_expected' }])
    expect(profile.memory.inEffect.map((m) => m.entryId)).toEqual([conf.id])
    expect(profile.memory.inEffect[0].influence).toEqual(['context_shown', 'suppression_proposal'])
  })

  it('keeps supported potential, customer-recorded returns and matched returns apart', () => {
    let [q1, q2] = tenantAAudits()
    const dup = findingsOf(q1).find((f) => f.type === 'exact_duplicate')!
    let state = approveRecovery({ ...EMPTY_CASE_STATE, decision: 'confirmed', decidedAt: 1, recoveryStage: 'confirmed' }, { at: 2, knownBeforeReclaim: false })
    state = startRecoveryRequest(state, 1410.25, 3)
    state = verifyRecovery(state, { amount: 400, method: 'refund', source: 'bank', reference: 'FIXTURE-REF-1', settledAt: 4 })
    q1 = withCaseState(q1, dup.id, state)
    const s = createLegacyAuditSource('tenant_a', [q1, q2])
    // TEST WRAPPER: the Q1 duplicate presented as evidence-gate supported.
    const cases: CaseReadPort = { origin: s.cases.origin, listCases: (ctx, now) => s.cases.listCases(ctx, now).map((c) => (c.caseId === DUP_Q1 ? { ...c, supportedPotentialMinor: 141025 } : c)) }
    const profile = vendorProfile(ctxA, s.financial, cases, new InMemoryFeedbackStore(), keyOf(s, ctxA, 'Fixture Coffee Co'), NOW).result!
    // The Q1 copy has history (updatedAt) so it represents the cross-audit pair.
    expect(profile.cases.caseIds).toContain(DUP_Q1)
    expect(profile.cases.byStage.requested).toBe(1)
    expect(profile.cases.supportedPotentialInPlay).toEqual([{ currency: 'USD', amountMinor: 141025 }])
    expect(profile.cases.customerRecordedReturn).toEqual([{ currency: 'USD', amountMinor: 40000 }])
    expect(profile.cases.matchedReturn).toBe('not_available')
  })

  it('returns not-found rather than an empty profile for an unknown vendor', () => {
    const p = portsA()
    const env = vendorProfile(ctxA, p.financial, p.cases, new InMemoryFeedbackStore(), 'vendor_missing', NOW)
    expect(env.result).toBeNull()
    expect(env.coverage.find((c) => c.check === 'vendor_profiles')).toMatchObject({ status: 'not_run' })
    expect(env.coverage.find((c) => c.check === 'vendor_profiles')!.reasons).toContain('vendor_not_found')
  })

  it('marks a vendor with one payment as missing history everywhere', () => {
    const p = portsA()
    const euro = vendorProfile(ctxA, p.financial, p.cases, new InMemoryFeedbackStore(), keyOf(p, ctxA, 'Fixture Euro Parts GmbH'), NOW).result!
    expect(euro.spend).toEqual([{ currency: 'EUR', grossPaymentsMinor: 90000, paymentCount: 1, refundsAndCredits: { count: 0, amountMinor: 0 }, unknownKindCount: 0 }])
    expect(euro.baselines[0]).toMatchObject({ status: 'insufficient_history', medianGapDays: null })
    expect(euro.recentChange[0].status).toBe('insufficient_history')
    expect(compareToBaseline(euro.baselines[0], 90000).label).toBe('insufficient_history')
  })
})

describe('vendor aliases', () => {
  it('shows an import similarity suggestion as proposed — not confirmed, and never merges the vendors', () => {
    const p = portsC()
    const typo = keyOf(p, ctxC, 'Fixture Clod Hosting')
    const cloud = keyOf(p, ctxC, 'Fixture Cloud Hosting')
    expect(typo).not.toBe(cloud)
    const profile = vendorProfile(ctxC, p.financial, p.cases, new InMemoryFeedbackStore(), typo, NOW).result!
    expect(profile.aliases.displayNamesSeen).toEqual([{ name: 'Fixture Clod Hosting', recordCount: 1, caseCount: 0 }])
    expect(profile.aliases.proposed).toEqual([{ aliasName: 'Fixture Cloud Hosting', origins: ['import_similarity'], entryIds: [], recordCount: 1, label: ALIAS_PROPOSED_LABEL }])
    expect(profile.aliases.confirmedByCustomer).toEqual([])
    expect(profile.spend[0].grossPaymentsMinor).toBe(12000) // its own record only
  })

  it('surfaces customer confirmation and rejection separately, and contradictions for a person to resolve', () => {
    const p = portsC()
    const store = new InMemoryFeedbackStore()
    const typo = keyOf(p, ctxC, 'Fixture Clod Hosting')
    const alias = (aliasName: string, decision: string) => ({ kind: 'vendor_alias_proposal', scope: { type: 'vendor', vendorKey: typo }, rationale: 'Same supplier, mistyped.', details: { aliasName, decision } })
    const confirmed = remember(store, ctxC, p, alias('Fixture Cloud Hosting', 'confirmed'))
    const rejected = remember(store, ctxC, p, alias('Fixture Clod Hosting Ltd', 'rejected'))
    let profile = vendorProfile(ctxC, p.financial, p.cases, store, typo, NOW + 1).result!
    expect(profile.aliases.confirmedByCustomer).toEqual([{ aliasName: 'Fixture Cloud Hosting', entryIds: [confirmed.id], pendingCanonicalIdentityConfirmation: true, label: ALIAS_CONFIRMED_LABEL }])
    expect(profile.aliases.proposed).toEqual([])
    expect(profile.aliases.rejectedByCustomer).toEqual([{ aliasName: 'Fixture Clod Hosting Ltd', entryIds: [rejected.id] }])
    // The other vendorKey is untouched by the confirmation: still its own profile.
    expect(vendorProfile(ctxC, p.financial, p.cases, store, keyOf(p, ctxC, 'Fixture Cloud Hosting'), NOW + 1).result!.spend[0].paymentCount).toBe(12)

    const contra = remember(store, ctxC, p, alias('fixture cloud hosting', 'rejected'), NOW + 2)
    profile = vendorProfile(ctxC, p.financial, p.cases, store, typo, NOW + 3).result!
    expect(profile.aliases.confirmedByCustomer).toEqual([])
    expect(profile.aliases.contradictions).toEqual([{ aliasName: 'fixture cloud hosting', entryIds: [confirmed.id, contra.id] }])
    store.revoke(ctxC, contra.id, 'Entered by mistake.', NOW + 4)
    profile = vendorProfile(ctxC, p.financial, p.cases, store, typo, NOW + 5).result!
    expect(profile.aliases.confirmedByCustomer.map((a) => a.entryIds)).toEqual([[confirmed.id]])
    expect(profile.memory.notInEffect.map((m) => [m.entryId, m.effectiveStatus])).toEqual([[contra.id, 'revoked']])
  })
})

describe('recent change and baselines on tenant C (hand-calculated)', () => {
  it('compares the last 90 covered days with the 90 before, per currency', () => {
    const p = portsC()
    const profile = vendorProfile(ctxC, p.financial, p.cases, new InMemoryFeedbackStore(), keyOf(p, ctxC, 'Fixture Cloud Hosting'), NOW).result!
    // Covered 2025-01-05 .. 2025-12-05. Recent 2025-09-07..12-05: Oct, Nov, Dec × 70000 = 210000.
    // Prior 2025-06-09..09-06: Jul, Aug, Sep × 60000 = 180000. (210000-180000)/180000 = 1666.67 bps → 1667.
    expect(profile.recentChange).toEqual([
      {
        currency: 'USD',
        status: 'computed',
        reasons: ['snapshot_not_continuous'],
        recentWindow: { from: '2025-09-07', to: '2025-12-05' },
        priorWindow: { from: '2025-06-09', to: '2025-09-06' },
        recentGrossMinor: 210000,
        priorGrossMinor: 180000,
        recentPaymentCount: 3,
        priorPaymentCount: 3,
        changeBps: 1667,
      },
    ])
    // 6×50000 + 3×60000 + 3×70000 = 690000
    expect(profile.spend[0]).toMatchObject({ grossPaymentsMinor: 690000, paymentCount: 12 })
    // Sorted amounts: six 50000s first → lower-middle (6th) = 50000; MAD 0 → tolerance ceil(5% of 50000) = 2500.
    // Gaps: 31 28 31 30 31 30 31 31 30 31 30 → sorted, 6th = 31.
    expect(profile.baselines[0]).toMatchObject({ status: 'established', paymentCount: 12, coveredMonths: 12, medianPaymentMinor: 50000, madMinor: 0, toleranceMinor: 2500, medianGapDays: 31 })
    expect(compareToBaseline(profile.baselines[0], 70000)).toMatchObject({ label: 'above_range', ratioBps: 14000 })
  })

  it('keeps an UNKNOWN-currency vendor in its own bucket with explicit gaps', () => {
    const p = portsC()
    const env = vendorProfile(ctxC, p.financial, p.cases, new InMemoryFeedbackStore(), keyOf(p, ctxC, 'Fixture Freight'), NOW)
    const freight = env.result!
    expect(freight.spend).toEqual([{ currency: 'UNKNOWN', grossPaymentsMinor: 25000, paymentCount: 1, refundsAndCredits: { count: 0, amountMinor: 0 }, unknownKindCount: 0 }])
    expect(freight.recentChange[0].reasons).toContain('missing_currency')
    expect(freight.baselines[0].reasons).toContain('missing_currency')
    expect(freight.evidenceQuality).toMatchObject({ recordCount: 1, withInvoiceReference: 0, withCategory: 0, withKnownCurrency: 0, shareBps: { invoiceReference: 0, knownCurrency: 0 } })
    expect(env.coverage.find((c) => c.check === 'vendor_profiles')!.reasons).toEqual(expect.arrayContaining(['missing_currency', 'missing_category']))
  })

  it('merges import ranges only when contiguous', () => {
    const imp = (from: string, to: string) => ({ importId: from, auditId: 'a', system: 'fixture' as const, importedAt: 1, acceptedRows: 1, rejectedRows: 0, dateRange: { from, to }, detectedColumns: [] })
    expect(coveredIntervals([imp('2026-04-01', '2026-06-09'), imp('2026-01-01', '2026-03-31')])).toEqual([{ from: '2026-01-01', to: '2026-06-09' }])
    expect(coveredIntervals([imp('2026-01-01', '2026-03-10'), imp('2026-04-01', '2026-06-09')])).toHaveLength(2)
  })
})

describe('vendorProfiles list', () => {
  it('pages with a stable cursor in name order', () => {
    const p = portsA()
    const store = new InMemoryFeedbackStore()
    const first = vendorProfiles(ctxA, p.financial, p.cases, store, NOW, { limit: 2 })
    expect(first.result!.items.map((v) => v.primaryName)).toEqual(['Fixture Coffee Co', 'Fixture Euro Parts GmbH'])
    const second = vendorProfiles(ctxA, p.financial, p.cases, store, NOW, { limit: 2, cursor: first.result!.nextCursor })
    expect(second.result!.items.map((v) => v.primaryName)).toEqual(['Fixture Office Supply', 'Fixture Property Mgmt'])
    expect(second.result!.nextCursor).toBeNull()
    expect(() => vendorProfiles(ctxA, p.financial, p.cases, store, NOW, { limit: 0 })).toThrow(RangeError)
    expect(() => vendorProfiles(ctxA, p.financial, p.cases, store, NOW, { limit: 201 })).toThrow(RangeError)
    expect(() => vendorProfiles(ctxA, p.financial, p.cases, store, NOW, { cursor: 'garbage' })).toThrow(RangeError)
  })

  it('is deterministic', () => {
    const p = portsA()
    const store = new InMemoryFeedbackStore()
    remember(store, ctxA, p, { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: keyOf(p, ctxA, 'Fixture Coffee Co') }, rationale: 'Roaster.' })
    expect(vendorProfiles(ctxA, p.financial, p.cases, store, NOW)).toEqual(vendorProfiles(ctxA, p.financial, p.cases, store, NOW))
  })

  it('carries snapshot, identity, baseline and return-matching coverage limits', () => {
    const p = portsA()
    const env = vendorProfiles(ctxA, p.financial, p.cases, new InMemoryFeedbackStore(), NOW)
    const byCheck = new Map(env.coverage.map((c) => [c.check, c]))
    expect(byCheck.get('vendor_profiles')!.reasons).toEqual(expect.arrayContaining(['customer_supplied_source', 'snapshot_not_continuous']))
    expect(byCheck.get('canonical_vendor_identity')).toEqual({ check: 'canonical_vendor_identity', status: 'limited', reasons: ['upstream_contract_pending'] })
    expect(byCheck.get('seasonal_comparison')!.status).toBe('not_run')
    expect(byCheck.get('matched_returns')).toEqual({ check: 'matched_returns', status: 'not_run', reasons: ['no_independent_return_matching'] })
    expect(env.scope).toMatchObject({ dateBasis: 'payment_date', currencies: ['EUR', 'USD'], from: '2026-01-01', to: '2026-06-09' })
    expect(env.sources.map((s) => s.id)).toEqual(expect.arrayContaining(['rule:vendor-profile-v0.1', 'rule:baseline-v0.1']))
  })

  it('reports an empty account as not run', () => {
    const s = createLegacyAuditSource('tenant_a', [])
    const env = vendorProfiles(ctxA, s.financial, s.cases, new InMemoryFeedbackStore(), NOW)
    expect(env.result!.items).toEqual([])
    expect(env.coverage.find((c) => c.check === 'vendor_profiles')).toMatchObject({ status: 'not_run', reasons: ['customer_supplied_source', 'no_data', 'snapshot_not_continuous'] })
  })
})

describe('tenant isolation and permissions', () => {
  it('never mixes the same vendorKey across tenants, even with one shared memory store', () => {
    const a = portsA()
    const b = createLegacyAuditSource('tenant_b', tenantBAudits())
    const store = new InMemoryFeedbackStore()
    const coffeeA = keyOf(a, ctxA, 'Fixture Coffee Co')
    const coffeeB = keyOf(b, ctxB, 'Fixture Coffee Co')
    expect(coffeeA).toBe(coffeeB)
    const noteA = remember(store, ctxA, a, { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: coffeeA }, rationale: 'Tenant A context.' })
    const profileB = vendorProfile(ctxB, b.financial, b.cases, store, coffeeB, NOW)
    expect(profileB.tenantId).toBe('tenant_b')
    // 99999 + 88888 = 188887: tenant B's two payments only.
    expect(profileB.result!.spend).toEqual([{ currency: 'USD', grossPaymentsMinor: 188887, paymentCount: 2, refundsAndCredits: { count: 0, amountMinor: 0 }, unknownKindCount: 0 }])
    expect(profileB.result!.memory.inEffect).toEqual([])
    expect(profileB.result!.cases.caseCount).toBe(0)
    const profileA = vendorProfile(ctxA, a.financial, a.cases, store, coffeeA, NOW)
    expect(profileA.result!.memory.inEffect.map((m) => m.entryId)).toEqual([noteA.id])
    expect(profileA.result!.spend[0].grossPaymentsMinor).toBe(1294675)
  })

  it('refuses another tenant’s ports and a port that leaks another tenant’s rows', () => {
    const a = portsA()
    expect(() => vendorProfiles(ctxB, a.financial, a.cases, new InMemoryFeedbackStore(), NOW)).toThrow(IntelligenceAccessError)
    const b = createLegacyAuditSource('tenant_b', tenantBAudits())
    const leaky: FinancialSourcePort = { ...a.financial, listSourceRecords: (ctx) => [...a.financial.listSourceRecords(ctx), ...b.financial.listSourceRecords(ctxB)] }
    expect(() => vendorProfiles(ctxA, leaky, a.cases, new InMemoryFeedbackStore(), NOW)).toThrow(IntelligenceAccessError)
  })

  it('needs financial:read and cases:read', () => {
    const a = portsA()
    expect(() => vendorProfiles(fixtureContext('tenant_a', ['financial:read']), a.financial, a.cases, new InMemoryFeedbackStore(), NOW)).toThrow(IntelligenceAccessError)
    expect(() => vendorProfile(fixtureContext('tenant_a', ['cases:read']), a.financial, a.cases, new InMemoryFeedbackStore(), 'x', NOW)).toThrow(IntelligenceAccessError)
  })

  it('shows expired memory as not in effect', () => {
    const a = portsA()
    const store = new InMemoryFeedbackStore()
    const coffee = keyOf(a, ctxA, 'Fixture Coffee Co')
    const e = remember(store, ctxA, a, { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: coffee }, rationale: 'Promo pricing until autumn.', expiresAt: NOW + 30 * DAY })
    const later = vendorProfile(ctxA, a.financial, a.cases, store, coffee, NOW + 31 * DAY).result!
    expect(later.memory.inEffect).toEqual([])
    expect(later.memory.notInEffect).toEqual([expect.objectContaining({ entryId: e.id, effectiveStatus: 'expired', influence: ['none_not_in_effect'] })])
  })
})
