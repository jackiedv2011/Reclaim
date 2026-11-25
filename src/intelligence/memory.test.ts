import { describe, expect, it } from 'vitest'
import { EMPTY_CASE_STATE, type CaseState, type DismissalTag } from '@/ledger/caseState'
import type { CaseReadPort, TenantContext } from './contracts.ts'
import { createLegacyAuditSource } from './adapters/legacyAudit.ts'
import { auditFromCsv, findingsOf, fixtureContext, tenantAAudits, tenantBAudits, TENANT_A_Q1, withCaseState } from './fixtures/synthetic.ts'
import { IntelligenceAccessError } from './envelope.ts'
import {
  DEFAULT_REVIEW_AFTER_MS,
  InMemoryFeedbackStore,
  MAX_RATIONALE_LENGTH,
  MEMORY_VERSION,
  MemoryError,
  aliasStates,
  deleteTenantMemory,
  exportTenantMemory,
  influenceFor,
  resolveMemory,
  suppressionProposals,
  validateFeedbackInput,
  type FeedbackStore,
  type MemoryPorts,
  type ValidatedFeedback,
} from './memory.ts'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 6, 1)
const ctxA = fixtureContext('tenant_a')
const ctxB = fixtureContext('tenant_b')

// ---------------------------------------------------------------- SYNTHETIC fixtures

function dismissed(tag: DismissalTag, reason: string): CaseState {
  return { ...EMPTY_CASE_STATE, decision: 'expected', reason, decidedAt: 5, dismissalTag: tag }
}

/** Tenant A, optionally with case states set on the Q1 audit's findings by finding type. */
function portsA(q1States: Partial<Record<string, CaseState>> = {}): MemoryPorts {
  let [q1, q2] = tenantAAudits()
  for (const f of findingsOf(q1)) {
    const state = q1States[f.type]
    if (state) q1 = withCaseState(q1, f.id, state)
  }
  const s = createLegacyAuditSource('tenant_a', [q1, q2])
  return { financial: s.financial, cases: s.cases }
}

function portsB(): MemoryPorts {
  const s = createLegacyAuditSource('tenant_b', tenantBAudits())
  return { financial: s.financial, cases: s.cases }
}

/**
 * TEST WRAPPER: presents one case as if its evidence gate had passed
 * (supportedPotentialMinor set), standing in for an attested-evidence case.
 */
function withSupportedCase(ports: MemoryPorts, caseId: string, amountMinor: number): MemoryPorts {
  const cases: CaseReadPort = {
    origin: ports.cases.origin,
    listCases: (ctx, now) => ports.cases.listCases(ctx, now).map((c) => (c.caseId === caseId ? { ...c, supportedPotentialMinor: amountMinor } : c)),
  }
  return { financial: ports.financial, cases }
}

function vendorKeyOf(ports: MemoryPorts, ctx: TenantContext, name: string): string {
  return ports.financial.listSourceRecords(ctx).find((r) => r.vendor.displayName === name)!.vendor.vendorKey
}

function rentSeriesId(ports: MemoryPorts): string {
  return ports.financial.listRecurringSeries(ctxA).find((s) => s.auditId === 'audit_a_q1')!.seriesId
}

const DUP_CASE = 'audit_a_q1/exact_duplicate-rec_5-rec_6'
const OUTLIER_CASE = 'audit_a_q2/amount_outlier-rec_7'

function create(store: FeedbackStore, ctx: TenantContext, ports: MemoryPorts, input: unknown, at = NOW) {
  const v = validateFeedbackInput(ctx, input, at, ports)
  if (!v.ok) throw new Error(JSON.stringify(v.issues))
  return store.create(ctx, v.value, at)
}

function issueCodes(ctx: TenantContext, ports: MemoryPorts, input: unknown): string[] {
  const v = validateFeedbackInput(ctx, input, NOW, ports)
  return v.ok ? [] : v.issues.map((i) => i.code)
}

// ---------------------------------------------------------------- validation

describe('validateFeedbackInput', () => {
  const ports = portsA()

  it('takes tenant and author from the session and fills a review date for suppression-capable kinds', () => {
    const store = new InMemoryFeedbackStore()
    const entry = create(store, ctxA, ports, {
      kind: 'intentional_payment',
      scope: { type: 'source_records', sourceRecordIds: ['audit_a_q1/rec_6', 'audit_a_q1/rec_5'] },
      rationale: '  Second payment was the agreed deposit.  ',
      details: { findingType: 'exact_duplicate' },
    })
    expect(entry).toMatchObject({
      tenantId: 'tenant_a',
      authorActorId: 'tenant_a',
      kind: 'intentional_payment',
      scope: { type: 'source_records', sourceRecordIds: ['audit_a_q1/rec_5', 'audit_a_q1/rec_6'] },
      rationale: 'Second payment was the agreed deposit.',
      status: 'active',
      reviewAt: NOW + DEFAULT_REVIEW_AFTER_MS,
      expiresAt: null,
      origin: 'customer_feedback',
      version: MEMORY_VERSION,
    })
    expect(entry.history).toEqual([{ at: NOW, action: 'created', actorId: 'tenant_a', note: null }])
    expect(entry.sourceRefs.map((r) => r.id)).toEqual(['record:audit_a_q1/rec_5', 'record:audit_a_q1/rec_6'])
  })

  it('rejects a forged tenant or actor anywhere in the body', () => {
    const base = { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: vendorKeyOf(ports, ctxA, 'Fixture Coffee Co') }, rationale: 'Seasonal roaster.' }
    expect(issueCodes(ctxA, ports, { ...base, tenantId: 'tenant_b' })).toEqual(['forged_identity_field'])
    expect(issueCodes(ctxA, ports, { ...base, actorId: 'someone_else' })).toEqual(['forged_identity_field'])
    expect(issueCodes(ctxA, ports, { ...base, authorActorId: 'someone_else' })).toEqual(['forged_identity_field'])
    expect(issueCodes(ctxA, ports, { ...base, scope: { ...base.scope, tenantId: 'tenant_b' } })).toContain('forged_identity_field')
    expect(issueCodes(ctxA, ports, { ...base, id: 'mem_1', createdAt: 1 })).toEqual(['server_assigned_field', 'server_assigned_field'])
    expect(issueCodes(ctxA, ports, { ...base, colour: 'red' })).toEqual(['unknown_field'])
  })

  it('rejects scope references that do not exist in this tenant, including another tenant’s IDs', () => {
    const coffeeA = vendorKeyOf(ports, ctxA, 'Fixture Coffee Co')
    expect(issueCodes(ctxA, ports, { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: 'vendor_nope' }, rationale: 'x' })).toEqual(['unknown_reference'])
    expect(issueCodes(ctxA, ports, { kind: 'vendor_context_note', scope: { type: 'case', caseId: 'audit_a_q1/nope' }, rationale: 'x' })).toEqual(['unknown_reference'])
    expect(issueCodes(ctxA, ports, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: ['audit_b_1/rec_0'] }, rationale: 'x' })).toEqual(['unknown_reference'])
    // A record dropped as a cross-audit repeat is not a reference this tenant can scope to.
    expect(issueCodes(ctxA, ports, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: ['audit_a_q2/rec_1'] }, rationale: 'x' })).toEqual(['unknown_reference'])
    // A real series ID with the wrong vendor.
    expect(issueCodes(ctxA, ports, { kind: 'recurring_confirmation', scope: { type: 'recurring_series', vendorKey: coffeeA, recurringSeriesId: rentSeriesId(ports) }, rationale: 'x', details: { assertion: 'recurring_expected' } })).toEqual(['unknown_reference'])
  })

  it('bounds sizes and free text', () => {
    const scope = { type: 'vendor', vendorKey: vendorKeyOf(ports, ctxA, 'Fixture Coffee Co') }
    expect(issueCodes(ctxA, ports, { kind: 'vendor_context_note', scope, rationale: 'x'.repeat(MAX_RATIONALE_LENGTH + 1) })).toEqual(['too_long'])
    expect(issueCodes(ctxA, ports, { kind: 'vendor_context_note', scope, rationale: '   ' })).toEqual(['required'])
    expect(issueCodes(ctxA, ports, { kind: 'vendor_context_note', scope, rationale: 'bad\u0000text' })).toEqual(['invalid_value'])
    const many = Array.from({ length: 201 }, (_, i) => `audit_a_q1/rec_${i}`)
    expect(issueCodes(ctxA, ports, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: many }, rationale: 'x' })).toEqual(['too_many'])
    expect(issueCodes(ctxA, ports, { kind: 'vendor_context_note', scope, rationale: 'ok', expiresAt: NOW - 1 })).toEqual(['out_of_range'])
    expect(issueCodes(ctxA, ports, { kind: 'vendor_context_note', scope, rationale: 'ok', expiresAt: NOW + 4 * 365 * DAY })).toEqual(['out_of_range'])
    expect(issueCodes(ctxA, ports, 'not an object')).toEqual(['invalid_type'])
  })

  it('accepts money only as structured integer minor units, never from text', () => {
    const coffeeA = vendorKeyOf(ports, ctxA, 'Fixture Coffee Co')
    const scope = { type: 'vendor', vendorKey: coffeeA }
    const band = (minMinor: unknown, maxMinor: unknown) => ({ kind: 'intentional_payment', scope, rationale: 'x', details: { findingType: 'amount_outlier', amountBand: { currency: 'USD', minMinor, maxMinor } } })
    expect(issueCodes(ctxA, ports, band('3569.75', 360000))).toContain('invalid_type')
    expect(issueCodes(ctxA, ports, band(356975.5, 360000))).toContain('invalid_type')
    expect(issueCodes(ctxA, ports, band(-1, 360000))).toContain('out_of_range')
    expect(issueCodes(ctxA, ports, band(100000, 200000))).toEqual(['out_of_range']) // 100% wide: not narrow
    expect(issueCodes(ctxA, ports, band(356975, 360000))).toEqual([])
    // A dollar figure in the rationale is just text.
    const store = new InMemoryFeedbackStore()
    const e = create(store, ctxA, ports, { kind: 'vendor_context_note', scope, rationale: 'They owe us $5,000 per the contract.' })
    expect(e.details).toEqual({ kind: 'vendor_context_note' })
  })

  it('refuses blanket vendor exceptions and kind/scope mismatches', () => {
    const scope = { type: 'vendor', vendorKey: vendorKeyOf(ports, ctxA, 'Fixture Coffee Co') }
    expect(issueCodes(ctxA, ports, { kind: 'intentional_payment', scope, rationale: 'All payments to them are fine.' })).toEqual(['scope_not_allowed_for_kind'])
    expect(issueCodes(ctxA, ports, { kind: 'recurring_confirmation', scope, rationale: 'x', details: { assertion: 'recurring_expected' } })).toEqual(['scope_not_allowed_for_kind'])
    expect(issueCodes(ctxA, ports, { kind: 'dismissal_reason', scope, rationale: 'x' })).toEqual(['invalid_value'])
    // Recovery outcomes only on cases that reached a request.
    expect(issueCodes(ctxA, ports, { kind: 'recovery_outcome_confirmation', scope: { type: 'case', caseId: DUP_CASE }, rationale: 'x', details: { outcome: 'returned_as_recorded' } })).toEqual(['invalid_value'])
  })

  it('needs feedback:write', () => {
    const readOnly = fixtureContext('tenant_a', ['financial:read', 'cases:read'])
    expect(() => validateFeedbackInput(readOnly, { kind: 'vendor_context_note' }, NOW, ports)).toThrow(IntelligenceAccessError)
  })
})

// ---------------------------------------------------------------- store

describe('InMemoryFeedbackStore', () => {
  const ports = portsA()
  const note = () => ({ kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: vendorKeyOf(ports, ctxA, 'Fixture Coffee Co') }, rationale: 'Roaster; prices move with harvests.' })

  it('refuses writes after the permission is withdrawn, and reads without financial:read', () => {
    const store = new InMemoryFeedbackStore()
    const v = validateFeedbackInput(ctxA, note(), NOW, ports)
    expect(v.ok).toBe(true)
    const demoted = fixtureContext('tenant_a', ['financial:read', 'cases:read'])
    expect(() => store.create(demoted, (v as { value: ValidatedFeedback }).value, NOW)).toThrow(IntelligenceAccessError)
    const entry = store.create(ctxA, (v as { value: ValidatedFeedback }).value, NOW)
    expect(() => store.revoke(demoted, entry.id, 'no', NOW)).toThrow(IntelligenceAccessError)
    expect(() => store.list(fixtureContext('tenant_a', ['feedback:write']), {}, NOW)).toThrow(IntelligenceAccessError)
  })

  it('refuses unvalidated input and feedback validated for another tenant or author', () => {
    const store = new InMemoryFeedbackStore()
    const v = validateFeedbackInput(ctxA, note(), NOW, ports)
    if (!v.ok) throw new Error('fixture')
    expect(() => store.create(ctxA, { ...v.value }, NOW)).toThrow(MemoryError)
    expect(() => store.create(ctxB, v.value, NOW)).toThrow(IntelligenceAccessError)
    const otherActor: TenantContext = { ...ctxA, actorId: 'tenant_a_member_2' }
    expect(() => store.create(otherActor, v.value, NOW)).toThrow(IntelligenceAccessError)
  })

  it('keeps tenants partitioned in one store', () => {
    const store = new InMemoryFeedbackStore()
    const a = create(store, ctxA, ports, note())
    expect(store.list(ctxB, {}, NOW)).toEqual([])
    expect(store.get(ctxB, a.id, NOW)).toBeNull()
    expect(() => store.revoke(ctxB, a.id, 'not mine', NOW)).toThrow(MemoryError)
    expect(store.get(ctxA, a.id, NOW)!.status).toBe('active')
  })

  it('revocation keeps the history and cannot be repeated', () => {
    const store = new InMemoryFeedbackStore()
    const e = create(store, ctxA, ports, note())
    const r = store.revoke(ctxA, e.id, '  Wrong vendor.  ', NOW + DAY)
    expect(r).toMatchObject({ status: 'revoked', revokedAt: NOW + DAY, revokedBy: 'tenant_a', revokeReason: 'Wrong vendor.' })
    expect(r.history.map((h) => h.action)).toEqual(['created', 'revoked'])
    expect(() => store.revoke(ctxA, e.id, 'again', NOW + 2 * DAY)).toThrow(MemoryError)
    expect(() => store.revoke(ctxA, 'mem_missing', 'x', NOW)).toThrow(MemoryError)
    expect(() => store.revoke(ctxA, e.id, '', NOW)).toThrow(MemoryError)
    expect(store.list(ctxA, { includeInactive: false }, NOW + DAY)).toEqual([])
    expect(store.list(ctxA, {}, NOW + DAY)).toHaveLength(1)
  })

  it('evaluates expiry at read time without rewriting the stored entry', () => {
    const store = new InMemoryFeedbackStore()
    const e = create(store, ctxA, ports, { ...note(), expiresAt: NOW + 10 * DAY })
    expect(store.get(ctxA, e.id, NOW + 9 * DAY)!.status).toBe('active')
    const later = store.get(ctxA, e.id, NOW + 10 * DAY)!
    expect(later.status).toBe('expired')
    expect(later.history.map((h) => h.action)).toEqual(['created', 'expired'])
    expect(later.history[1]).toMatchObject({ at: NOW + 10 * DAY, actorId: null })
    expect(store.get(ctxA, e.id, NOW)!.status).toBe('active')
    expect(() => store.revoke(ctxA, e.id, 'late', NOW + 11 * DAY)).toThrow(MemoryError)
  })

  it('exports and deletes one tenant only', () => {
    const store = new InMemoryFeedbackStore()
    const a1 = create(store, ctxA, ports, note())
    create(store, ctxA, ports, note())
    store.revoke(ctxA, a1.id, 'superseded', NOW + 1)
    const bPorts = portsB()
    create(store, ctxB, bPorts, { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: vendorKeyOf(bPorts, ctxB, 'Fixture Coffee Co') }, rationale: 'B context.' })
    const exported = exportTenantMemory(ctxA, store, NOW + 2)
    expect(exported).toMatchObject({ version: MEMORY_VERSION, tenantId: 'tenant_a', entryCount: 2 })
    expect(exported.entries.every((e) => e.tenantId === 'tenant_a')).toBe(true)
    expect(exported.entries.find((e) => e.id === a1.id)!.history.map((h) => h.action)).toEqual(['created', 'revoked'])
    expect(() => deleteTenantMemory(fixtureContext('tenant_a', ['financial:read']), store)).toThrow(IntelligenceAccessError)
    expect(deleteTenantMemory(ctxA, store)).toEqual({ deleted: 2 })
    expect(store.list(ctxA, {}, NOW)).toEqual([])
    expect(store.list(ctxB, {}, NOW)).toHaveLength(1)
  })

  it('is deterministic: the same operations give the same IDs and output', () => {
    const run = () => {
      const store = new InMemoryFeedbackStore()
      create(store, ctxA, ports, note())
      create(store, ctxA, ports, { ...note(), rationale: 'Second note.' }, NOW + 5)
      return store.list(ctxA, {}, NOW + 10)
    }
    expect(run()).toEqual(run())
  })
})

// ---------------------------------------------------------------- resolution and aliases

describe('resolveMemory', () => {
  it('derives read-only dismissal entries from reviewed case dismissals', () => {
    const ports = portsA({ exact_duplicate: dismissed('intentional', 'Deposit plus balance, agreed with the supplier.') })
    const store = new InMemoryFeedbackStore()
    const views = resolveMemory(ctxA, store, ports, NOW)
    expect(views).toHaveLength(1)
    expect(views[0]).toMatchObject({ effectiveStatus: 'active', readOnly: true, entry: { id: `dismissal:${DUP_CASE}`, kind: 'dismissal_reason', origin: 'case_dismissal', authorActorId: null, rationale: 'Deposit plus balance, agreed with the supplier.', details: { kind: 'dismissal_reason', tag: 'intentional', findingType: 'exact_duplicate' } } })
    expect(() => store.revoke(ctxA, views[0].entry.id, 'x', NOW)).toThrow(MemoryError)
  })

  it('marks an entry scope_missing when its records were reimported under new IDs', () => {
    const original = createLegacyAuditSource('tenant_a', [auditFromCsv('a1', TENANT_A_Q1)])
    const before: MemoryPorts = { financial: original.financial, cases: original.cases }
    const store = new InMemoryFeedbackStore()
    const e = create(store, ctxA, before, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: ['a1/rec_5', 'a1/rec_6'] }, rationale: 'Split payment.', details: { findingType: 'exact_duplicate' } })
    expect(resolveMemory(ctxA, store, before, NOW)[0].effectiveStatus).toBe('active')
    expect(suppressionProposals(ctxA, store, before, NOW).result!.proposals).toHaveLength(1)

    // The same CSV saved again as a new audit: same payments, new record IDs.
    const reimported = createLegacyAuditSource('tenant_a', [auditFromCsv('a1_reimport', TENANT_A_Q1)])
    const after: MemoryPorts = { financial: reimported.financial, cases: reimported.cases }
    const view = resolveMemory(ctxA, store, after, NOW).find((v) => v.entry.id === e.id)!
    expect(view).toMatchObject({ effectiveStatus: 'scope_missing', inEffect: false, missingRefs: ['record:a1/rec_5', 'record:a1/rec_6'] })
    expect(view.entry.status).toBe('active') // still stored, still visible, influences nothing
    const proposals = suppressionProposals(ctxA, store, after, NOW).result!
    expect(proposals.proposals).toEqual([])
    expect(proposals.blocked).toEqual([{ entryId: e.id, kind: 'intentional_payment', reason: 'not_in_effect', caseIds: [] }])
  })

  it('needs both read permissions', () => {
    expect(() => resolveMemory(fixtureContext('tenant_a', ['financial:read']), new InMemoryFeedbackStore(), portsA(), NOW)).toThrow(IntelligenceAccessError)
  })
})

describe('aliasStates', () => {
  const ports = portsA()
  const coffee = () => vendorKeyOf(ports, ctxA, 'Fixture Coffee Co')
  const alias = (aliasName: string, decision: string) => ({ kind: 'vendor_alias_proposal', scope: { type: 'vendor', vendorKey: coffee() }, rationale: 'Same remittance address.', details: { aliasName, decision } })

  it('reports contradictory statements until one is revoked', () => {
    const store = new InMemoryFeedbackStore()
    const yes = create(store, ctxA, ports, alias('Fixture Coffee Company', 'confirmed'))
    const no = create(store, ctxA, ports, alias('  fixture coffee   company ', 'rejected'), NOW + 1)
    let states = aliasStates(resolveMemory(ctxA, store, ports, NOW + 2))
    expect(states).toEqual([{ vendorKey: coffee(), aliasName: 'fixture coffee   company', normalizedAlias: 'fixture coffee company', decision: null, contradictory: true, entryIds: [yes.id, no.id] }])
    store.revoke(ctxA, no.id, 'Colleague was wrong.', NOW + 3)
    states = aliasStates(resolveMemory(ctxA, store, ports, NOW + 4))
    expect(states[0]).toMatchObject({ decision: 'confirmed', contradictory: false, entryIds: [yes.id] })
  })

  it('treats proposed + confirmed as confirmed (pending canonical identity review)', () => {
    const store = new InMemoryFeedbackStore()
    create(store, ctxA, ports, alias('Coffee Co Roasters', 'proposed'))
    const c = create(store, ctxA, ports, alias('Coffee Co Roasters', 'confirmed'), NOW + 1)
    expect(c.details).toMatchObject({ pendingCanonicalIdentityConfirmation: true })
    expect(aliasStates(resolveMemory(ctxA, store, ports, NOW + 2))[0]).toMatchObject({ decision: 'confirmed', contradictory: false })
  })
})

// ---------------------------------------------------------------- suppression proposals

describe('suppressionProposals', () => {
  it('proposes narrowly scoped suppression for a confirmed recurring series and nothing is applied', () => {
    const ports = portsA()
    const store = new InMemoryFeedbackStore()
    const rentKey = vendorKeyOf(ports, ctxA, 'Fixture Property Mgmt')
    const e = create(store, ctxA, ports, { kind: 'recurring_confirmation', scope: { type: 'recurring_series', vendorKey: rentKey, recurringSeriesId: rentSeriesId(ports) }, rationale: 'Monthly lease.', details: { assertion: 'recurring_expected' } })
    const env = suppressionProposals(ctxA, store, ports, NOW)
    expect(env.result!.proposals).toHaveLength(1)
    expect(env.result!.proposals[0]).toMatchObject({
      status: 'proposed_for_detection_owner',
      proposalKind: 'suppress_matching_finding',
      basis: { entryId: e.id, kind: 'recurring_confirmation', origin: 'customer_feedback' },
      scope: { type: 'recurring_series', vendorKey: rentKey, recurringSeriesId: rentSeriesId(ports), sourceRecordIds: ['audit_a_q1/rec_0', 'audit_a_q1/rec_1', 'audit_a_q1/rec_2'] },
      targetsCaseIds: [],
      tenantId: 'tenant_a',
    })
    const cov = env.coverage[0]
    expect(cov.status).toBe('limited')
    expect(cov.reasons).toEqual(expect.arrayContaining(['upstream_contract_pending', 'customer_supplied_source', 'snapshot_not_continuous']))
  })

  it('turns "not recurring" (false recurrence) into rule feedback, not suppression', () => {
    const ports = portsA()
    const store = new InMemoryFeedbackStore()
    const rentKey = vendorKeyOf(ports, ctxA, 'Fixture Property Mgmt')
    create(store, ctxA, ports, { kind: 'recurring_confirmation', scope: { type: 'recurring_series', vendorKey: rentKey, recurringSeriesId: rentSeriesId(ports) }, rationale: 'Lease ended; these were separate fees.', details: { assertion: 'not_recurring' } })
    expect(suppressionProposals(ctxA, store, ports, NOW).result!.proposals[0].proposalKind).toBe('rule_feedback')
  })

  it('maps dismissal tags: intentional suppresses the specific records, detection_error is rule feedback, other is nothing', () => {
    const store = new InMemoryFeedbackStore()
    const intentional = suppressionProposals(ctxA, store, portsA({ exact_duplicate: dismissed('intentional', 'Deposit.') }), NOW).result!
    expect(intentional.proposals).toHaveLength(1)
    expect(intentional.proposals[0]).toMatchObject({ proposalKind: 'suppress_matching_finding', basis: { origin: 'case_dismissal' }, scope: { type: 'source_records', sourceRecordIds: ['audit_a_q1/rec_5', 'audit_a_q1/rec_6'], findingType: 'exact_duplicate' }, targetsCaseIds: [DUP_CASE] })
    const misfire = suppressionProposals(ctxA, store, portsA({ exact_duplicate: dismissed('detection_error', 'Not the same invoice.') }), NOW).result!
    expect(misfire.proposals[0].proposalKind).toBe('rule_feedback')
    expect(suppressionProposals(ctxA, store, portsA({ exact_duplicate: dismissed('other', 'Unsure.') }), NOW).result!.proposals).toEqual([])
  })

  it('accepts a vendor + finding type + narrow amount band, never a whole vendor', () => {
    const ports = portsA()
    const store = new InMemoryFeedbackStore()
    const coffee = vendorKeyOf(ports, ctxA, 'Fixture Coffee Co')
    create(store, ctxA, ports, { kind: 'intentional_payment', scope: { type: 'vendor', vendorKey: coffee }, rationale: 'Annual bulk order in May.', details: { findingType: 'amount_outlier', amountBand: { currency: 'usd', minMinor: 356000, maxMinor: 360000 } } })
    const result = suppressionProposals(ctxA, store, ports, NOW).result!
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].scope).toEqual({ type: 'vendor_finding_amount_band', vendorKey: coffee, findingType: 'amount_outlier', currency: 'USD', minMinor: 356000, maxMinor: 360000 })
    expect(result.proposals[0].targetsCaseIds).toEqual([OUTLIER_CASE]) // flagged 356975
    expect(result.proposals.every((p) => (p.scope.type as string) !== 'vendor')).toBe(true)
  })

  it('never lets feedback suppress a finding whose evidence gate passed', () => {
    const base = portsA({ exact_duplicate: dismissed('intentional', 'Deposit.') })
    const ports = withSupportedCase(base, DUP_CASE, 141025)
    const store = new InMemoryFeedbackStore()
    const onCase = create(store, ctxA, ports, { kind: 'intentional_payment', scope: { type: 'case', caseId: DUP_CASE }, rationale: 'Ignore this.' })
    const onRecords = create(store, ctxA, ports, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: ['audit_a_q1/rec_6'] }, rationale: 'Ignore this payment.' })
    const result = suppressionProposals(ctxA, store, ports, NOW).result!
    expect(result.proposals).toEqual([])
    expect(result.blocked).toEqual([
      { entryId: `dismissal:${DUP_CASE}`, kind: 'dismissal_reason', reason: 'targets_supported_finding', caseIds: [DUP_CASE] },
      { entryId: onCase.id, kind: 'intentional_payment', reason: 'targets_supported_finding', caseIds: [DUP_CASE] },
      { entryId: onRecords.id, kind: 'intentional_payment', reason: 'targets_supported_finding', caseIds: [DUP_CASE] },
    ])
    // Rule feedback about a supported case is passed on for review, but names it as protected.
    const misfire = suppressionProposals(ctxA, store, withSupportedCase(portsA({ exact_duplicate: dismissed('detection_error', 'x') }), DUP_CASE, 141025), NOW).result!
    const fb = misfire.proposals.find((p) => p.basis.kind === 'dismissal_reason')!
    expect(fb).toMatchObject({ proposalKind: 'rule_feedback', supportedCaseIds: [DUP_CASE], targetsCaseIds: [] })
  })

  it('stops proposing from stale (review-due), expired and revoked entries', () => {
    const ports = portsA()
    const store = new InMemoryFeedbackStore()
    const rentKey = vendorKeyOf(ports, ctxA, 'Fixture Property Mgmt')
    const series = { type: 'recurring_series', vendorKey: rentKey, recurringSeriesId: rentSeriesId(ports) }
    const stale = create(store, ctxA, ports, { kind: 'recurring_confirmation', scope: series, rationale: 'Lease.', details: { assertion: 'recurring_expected' }, reviewAt: NOW + 30 * DAY })
    const expiring = create(store, ctxA, ports, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: ['audit_a_q1/rec_7'] }, rationale: 'One-off.', expiresAt: NOW + 10 * DAY })
    const revoked = create(store, ctxA, ports, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: ['audit_a_q1/rec_8'] }, rationale: 'One-off.' })
    expect(suppressionProposals(ctxA, store, ports, NOW).result!.proposals).toHaveLength(3)
    store.revoke(ctxA, revoked.id, 'Changed my mind.', NOW + DAY)
    const later = suppressionProposals(ctxA, store, ports, NOW + 31 * DAY).result!
    expect(later.proposals).toEqual([])
    expect(later.blocked.map((b) => [b.entryId, b.reason]).sort()).toEqual([
      [expiring.id, 'not_in_effect'],
      [revoked.id, 'not_in_effect'],
      [stale.id, 'review_due'],
    ].sort())
    const staleView = resolveMemory(ctxA, store, ports, NOW + 31 * DAY).find((v) => v.entry.id === stale.id)!
    expect(staleView).toMatchObject({ inEffect: true, reviewDue: true })
  })

  it('refuses another tenant and missing permissions', () => {
    const ports = portsA()
    expect(() => suppressionProposals(ctxB, new InMemoryFeedbackStore(), ports, NOW)).toThrow(IntelligenceAccessError)
    expect(() => suppressionProposals(fixtureContext('tenant_a', ['financial:read']), new InMemoryFeedbackStore(), ports, NOW)).toThrow(IntelligenceAccessError)
  })

  it('returns an empty, limited result for an empty account', () => {
    const s = createLegacyAuditSource('tenant_a', [])
    const env = suppressionProposals(ctxA, new InMemoryFeedbackStore(), { financial: s.financial, cases: s.cases }, NOW)
    expect(env.result).toEqual({ proposals: [], blocked: [] })
    expect(env.coverage[0].status).toBe('limited')
  })
})

// ---------------------------------------------------------------- explainability

describe('influenceFor', () => {
  it('shows which entries touch a case, including inactive ones', () => {
    const ports = portsA()
    const store = new InMemoryFeedbackStore()
    const coffee = vendorKeyOf(ports, ctxA, 'Fixture Coffee Co')
    const noteE = create(store, ctxA, ports, { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: coffee }, rationale: 'Roaster.' })
    const intent = create(store, ctxA, ports, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: ['audit_a_q1/rec_6'] }, rationale: 'Deposit.' })
    const unrelated = create(store, ctxA, ports, { kind: 'intentional_payment', scope: { type: 'source_records', sourceRecordIds: ['audit_a_q1/rec_7'] }, rationale: 'Other vendor.' })
    store.revoke(ctxA, intent.id, 'Wrong.', NOW + 1)
    const env = influenceFor(ctxA, store, ports, { caseId: DUP_CASE }, NOW + 2)
    expect(env.result!.targetFound).toBe(true)
    const byId = new Map(env.result!.entries.map((e) => [e.entryId, e]))
    expect(byId.get(noteE.id)!.influence).toEqual(['context_shown'])
    expect(byId.get(intent.id)).toMatchObject({ inEffect: false, effectiveStatus: 'revoked', influence: ['none_not_in_effect'] })
    expect(byId.has(unrelated.id)).toBe(false)
    expect(env.sources.map((s) => s.id)).toEqual(expect.arrayContaining([`memory:${noteE.id}`]))
  })

  it('intentional, then revoked: influence goes from suppression proposal to none', () => {
    const ports = portsA()
    const store = new InMemoryFeedbackStore()
    const e = create(store, ctxA, ports, { kind: 'intentional_payment', scope: { type: 'case', caseId: DUP_CASE }, rationale: 'Deposit.' })
    expect(influenceFor(ctxA, store, ports, { caseId: DUP_CASE }, NOW).result!.entries[0].influence).toEqual(['context_shown', 'suppression_proposal'])
    store.revoke(ctxA, e.id, 'Not a deposit after all.', NOW + 1)
    expect(influenceFor(ctxA, store, ports, { caseId: DUP_CASE }, NOW + 2).result!.entries[0].influence).toEqual(['none_not_in_effect'])
  })

  it('never shows another tenant’s entries for the same vendor name', () => {
    const store = new InMemoryFeedbackStore()
    const a = portsA()
    const b = portsB()
    const coffeeA = vendorKeyOf(a, ctxA, 'Fixture Coffee Co')
    const coffeeB = vendorKeyOf(b, ctxB, 'Fixture Coffee Co')
    expect(coffeeA).toBe(coffeeB) // same deterministic key, different businesses
    create(store, ctxA, a, { kind: 'vendor_context_note', scope: { type: 'vendor', vendorKey: coffeeA }, rationale: 'A only.' })
    const envB = influenceFor(ctxB, store, b, { vendorKey: coffeeB }, NOW)
    expect(envB.tenantId).toBe('tenant_b')
    expect(envB.result!.entries).toEqual([])
    expect(() => influenceFor(ctxB, store, a, { vendorKey: coffeeA }, NOW)).toThrow(IntelligenceAccessError)
  })

  it('reports an unknown target as not found rather than "no influence"', () => {
    const env = influenceFor(ctxA, new InMemoryFeedbackStore(), portsA(), { vendorKey: 'vendor_missing' }, NOW)
    expect(env.result!.targetFound).toBe(false)
    expect(env.coverage[0].reasons).toContain('no_data')
  })
})
