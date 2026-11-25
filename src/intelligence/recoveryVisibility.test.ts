import { describe, expect, it } from 'vitest'
import { deserializeEnvironment } from '@/ledger/store'
import { EMPTY_CASE_STATE, type CaseState } from '@/ledger/caseState'
import { approveRecovery, closeWithoutRecovery, recordVendorUpdate, startRecoveryRequest, verifyRecovery } from '@/recovery/model'
import { attestDuplicate } from '@/recovery/testEvidence'
import { ladder, recoveryAging, vendorCommitments } from '@/workspace/selectors'
import { createLegacyAuditSource, type StoredAudit } from './adapters/legacyAudit.ts'
import { auditFromCsv, findingsOf, fixtureContext, tenantAAudits, TENANT_A_Q1, withCaseState } from './fixtures/synthetic.ts'
import { COVERAGE_REASONS, NO_RETURN_MATCHING, type ReturnMatch, type ReturnMatchPort } from './contracts.ts'
import { IntelligenceAccessError } from './envelope.ts'
import { IntelligenceQueryError } from './spend.ts'
import {
  RECOVERY_COVERAGE_REASONS,
  RECOVERY_DEFINITIONS,
  RECOVERY_METRIC_VERSION,
  RECOVERY_WARNING_CODES,
  recoveryByVendor,
  recoveryOverview,
  type RecoveryCurrencyFigures,
} from './recoveryVisibility.ts'

const ctxA = fixtureContext('tenant_a')
const NOW = Date.UTC(2026, 6, 1)
const DAY = 86_400_000
const T = (n: number) => Date.UTC(2026, 3, 1) + n * DAY
const DUP_Q1 = 'exact_duplicate-rec_5-rec_6'

/** Replace one finding with an attested copy so the evidence gate passes (synthetic attestations). */
function attest(audit: StoredAudit, findingId: string): StoredAudit {
  const env = deserializeEnvironment(JSON.stringify(audit.environment))
  const attested = attestDuplicate(env.result.findings.find((f) => f.id === findingId)!)
  const raw = structuredClone(audit.environment) as { result: { findings: Array<{ id: string }> } }
  raw.result.findings = raw.result.findings.map((f) => (f.id === findingId ? { ...attested, relatedRecords: attested.relatedRecords.map((r) => ({ id: r.id })) } : f))
  return { ...audit, environment: raw }
}

const confirmed: CaseState = { ...EMPTY_CASE_STATE, decision: 'confirmed', decidedAt: T(0), recoveryStage: 'confirmed' }
function requested(amount = 1410.25): CaseState {
  return startRecoveryRequest(approveRecovery(confirmed, { at: T(1), knownBeforeReclaim: false }), amount, T(2))
}
const refund = (amount: number, ref: string, at: number) => ({ amount, method: 'refund' as const, source: 'bank' as const, reference: ref, settledAt: at })

function q1(): StoredAudit {
  return auditFromCsv('audit_a_q1', TENANT_A_Q1, { updatedAt: Date.UTC(2026, 2, 31) })
}
function sourceOf(...audits: StoredAudit[]) {
  return createLegacyAuditSource('tenant_a', audits)
}
function usd(rows: RecoveryCurrencyFigures[]): RecoveryCurrencyFigures {
  return rows.find((r) => r.currency === 'USD')!
}
const cents = (dollars: number) => Math.round(dollars * 100)
function ledgerOf(audit: StoredAudit) {
  return deserializeEnvironment(JSON.stringify(audit.environment))
}

describe('recoveryOverview: figures kept apart and cross-checked with selectors', () => {
  it('reports an unreviewed duplicate as flagged for review only, matching ladder()', () => {
    const audit = q1()
    const env = recoveryOverview(ctxA, sourceOf(audit).cases, NO_RETURN_MATCHING, NOW)
    const row = usd(env.result!.byCurrency)
    expect(row).toEqual({
      currency: 'USD',
      flaggedForReviewMinor: 141025, flaggedForReviewCount: 1,
      supportedPotentialMinor: 0, supportedPotentialCount: 0,
      approvedOutstandingMinor: 0, approvedOutstandingCount: 0,
      promisedMinor: 0, promisedCount: 0,
      customerRecordedReturnsMinor: 0, customerRecordedReturnsCount: 0,
      matchedReturnsMinor: null, matchedReturnsCount: null,
    })
    const l = ladder(ledgerOf(audit))
    expect(row.flaggedForReviewMinor).toBe(cents(l.flaggedByCurrency.USD))
    expect(row.flaggedForReviewCount).toBe(l.flaggedCount)
    expect(env.result!.counts.byStage.unreviewed).toBe(1)
    expect(env.result!.counts.needingCustomerAction).toBe(1)
    expect(env.metricDefinitionVersion).toBe(RECOVERY_METRIC_VERSION)
    expect(env.coverage.find((c) => c.check === 'matched_returns')).toEqual({ check: 'matched_returns', status: 'not_run', reasons: [COVERAGE_REASONS.NO_INDEPENDENT_RETURN_MATCHING] })
    expect(env.coverage.find((c) => c.check === 'recovery_cases')!.reasons).toEqual(expect.arrayContaining([COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS]))
  })

  it('keeps supported, approved, promised and customer-recorded amounts apart on a partial return, matching ladder(), vendorCommitments() and recoveryAging()', () => {
    let state = requested()
    state = recordVendorUpdate(state, { at: T(3), status: 'promised', note: 'Supplier will refund', amount: 1410.25 }, NOW)
    state = verifyRecovery(state, refund(400, 'FIXTURE-REF-1', T(4)))
    const audit = withCaseState(attest(q1(), DUP_Q1), DUP_Q1, state)
    const env = recoveryOverview(ctxA, sourceOf(audit).cases, NO_RETURN_MATCHING, NOW)
    const row = usd(env.result!.byCurrency)
    // 1,410.25 supported − 400.00 recorded = 1,010.25 in every open-balance figure.
    expect(row).toMatchObject({
      flaggedForReviewMinor: 0,
      supportedPotentialMinor: 101025, supportedPotentialCount: 1,
      approvedOutstandingMinor: 101025, approvedOutstandingCount: 1,
      promisedMinor: 101025, promisedCount: 1,
      customerRecordedReturnsMinor: 40000, customerRecordedReturnsCount: 1,
      matchedReturnsMinor: null,
    })
    expect(env.result!.counts).toMatchObject({ partialReturns: 1, closedWithoutRecovery: 0, needingCustomerAction: 1 })
    expect(env.result!.counts.byStage.requested).toBe(1)

    const ledgerEnv = ledgerOf(audit)
    const l = ladder(ledgerEnv)
    expect(row.supportedPotentialMinor).toBe(cents(l.potential))
    expect(row.approvedOutstandingMinor).toBe(cents(l.inRecovery))
    expect(row.customerRecordedReturnsMinor).toBe(cents(l.recoveredByCurrency.USD))
    expect(row.flaggedForReviewMinor).toBe(cents(l.flagged))
    expect(row.promisedMinor).toBe(cents(vendorCommitments(ledgerEnv).confirmed))
    expect(row.approvedOutstandingMinor).toBe(cents(recoveryAging(ledgerEnv, NOW).reduce((sum, b) => sum + b.outstanding, 0)))
    // The snapshot now carries what the promise still covers, so no order caveat is needed.
    expect(env.coverage.find((c) => c.check === 'promised')!.reasons).toEqual([])
  })

  it('moves a fully returned case out of open figures, matching ladder()', () => {
    const state = verifyRecovery(requested(), refund(1410.25, 'FIXTURE-REF-2', T(5)))
    const audit = withCaseState(attest(q1(), DUP_Q1), DUP_Q1, state)
    const env = recoveryOverview(ctxA, sourceOf(audit).cases, NO_RETURN_MATCHING, NOW)
    const row = usd(env.result!.byCurrency)
    expect(row).toMatchObject({ supportedPotentialMinor: 0, supportedPotentialCount: 0, approvedOutstandingMinor: 0, promisedMinor: 0, customerRecordedReturnsMinor: 141025 })
    const l = ladder(ledgerOf(audit))
    expect(row.customerRecordedReturnsMinor).toBe(cents(l.recovered))
    expect(cents(l.potential)).toBe(0)
    expect(env.result!.counts.byStage.recovered).toBe(1)
    expect(env.result!.counts.partialReturns).toBe(0)
  })

  it('counts a request closed without recovery and contributes no money', () => {
    const audit = withCaseState(attest(q1(), DUP_Q1), DUP_Q1, closeWithoutRecovery(requested(), 'Supplier disputed; documents insufficient', T(6)))
    const env = recoveryOverview(ctxA, sourceOf(audit).cases, NO_RETURN_MATCHING, NOW)
    const row = usd(env.result!.byCurrency)
    expect(env.result!.counts.closedWithoutRecovery).toBe(1)
    expect(env.result!.counts.byStage.not_recovered).toBe(1)
    expect([row.flaggedForReviewMinor, row.supportedPotentialMinor, row.approvedOutstandingMinor, row.promisedMinor, row.customerRecordedReturnsMinor]).toEqual([0, 0, 0, 0, 0])
    const l = ladder(ledgerOf(audit))
    expect([l.potential, l.inRecovery, l.recovered, l.flagged]).toEqual([0, 0, 0, 0])
  })

  it('leaves a dismissed case out of flagged for review, matching ladder()', () => {
    const audit = withCaseState(q1(), DUP_Q1, { ...EMPTY_CASE_STATE, decision: 'expected', decidedAt: T(1), dismissalTag: 'intentional', reason: 'Deposit' })
    const env = recoveryOverview(ctxA, sourceOf(audit).cases, NO_RETURN_MATCHING, NOW)
    expect(usd(env.result!.byCurrency).flaggedForReviewMinor).toBe(0)
    expect(env.result!.counts.dismissed).toBe(1)
    expect(ladder(ledgerOf(audit)).flagged).toBe(0)
  })

  it('INTENTIONAL DIFFERENCE: an approved request whose evidence gate never passed counts as approved outstanding (as recoveryAging does), while ladder().inRecovery leaves it out', () => {
    const state = verifyRecovery(requested(), refund(400, 'FIXTURE-REF-3', T(4)))
    const audit = withCaseState(q1(), DUP_Q1, state)
    const env = recoveryOverview(ctxA, sourceOf(audit).cases, NO_RETURN_MATCHING, NOW)
    const row = usd(env.result!.byCurrency)
    expect(row.approvedOutstandingMinor).toBe(101025)
    expect(row.supportedPotentialMinor).toBe(0)
    const ledgerEnv = ledgerOf(audit)
    expect(ladder(ledgerEnv).inRecovery).toBe(0)
    expect(cents(recoveryAging(ledgerEnv, NOW).reduce((sum, b) => sum + b.outstanding, 0))).toBe(101025)
    expect(row.customerRecordedReturnsMinor).toBe(cents(ladder(ledgerEnv).recovered))
  })

  it('promised nets returns recorded after the promise, exactly as vendorCommitments() does', () => {
    let state = requested()
    state = recordVendorUpdate(state, { at: T(3), status: 'promised', note: 'Partial refund promised', amount: 500 }, NOW)
    state = verifyRecovery(state, refund(400, 'FIXTURE-REF-4', T(4)))
    const audit = withCaseState(attest(q1(), DUP_Q1), DUP_Q1, state)
    const row = usd(recoveryOverview(ctxA, sourceOf(audit).cases, NO_RETURN_MATCHING, NOW).result!.byCurrency)
    expect(row.promisedMinor).toBe(10000) // 500.00 promised − 400.00 returned since
    expect(cents(vendorCommitments(ledgerOf(audit)).confirmed)).toBe(10000)
  })
})

describe('recoveryOverview: deduplication, currencies, matching and access', () => {
  it('folds the same case held by two audits into one, keeping the most advanced stage', () => {
    const [a1, a2] = tenantAAudits()
    const advanced = withCaseState(a1, DUP_Q1, verifyRecovery(requested(), refund(400, 'FIXTURE-REF-5', T(4))))
    const env = recoveryOverview(ctxA, sourceOf(advanced, a2).cases, NO_RETURN_MATCHING, NOW)
    expect(env.result!.dedup).toEqual({ snapshotsRead: 3, casesCounted: 2, duplicatesFolded: 1, keysWithDifferingStates: 1 })
    expect(env.warnings.map((w) => w.code)).toEqual([RECOVERY_WARNING_CODES.CASES_FOLDED, RECOVERY_WARNING_CODES.FOLDED_STATES_DIFFER])
    expect(env.exclusions).toEqual([expect.objectContaining({ code: 'cross_audit_overlap', count: 1 })])
    expect(env.sources.map((s) => s.id)).toContain(`case:audit_a_q1/${DUP_Q1}`)
    const row = usd(env.result!.byCurrency)
    expect(row.customerRecordedReturnsMinor).toBe(40000) // counted once, not twice
    // The Q2 amount outlier (3,569.75) stays flagged; the folded duplicate is no longer flagged.
    expect(row.flaggedForReviewMinor).toBe(356975)
    expect(env.result!.counts.byStage).toMatchObject({ requested: 1, unreviewed: 1 })
  })

  it('keeps an open request over a closure seen in another copy, and breaks ties by lowest case id', () => {
    const [a1, a2] = tenantAAudits()
    const dupQ2 = findingsOf(a2).find((f) => f.type === 'exact_duplicate')!.id
    const closed = withCaseState(a1, DUP_Q1, closeWithoutRecovery(requested(), 'Closed in the first audit', T(6)))
    const open = withCaseState(a2, dupQ2, requested())
    const env = recoveryOverview(ctxA, sourceOf(closed, open).cases, NO_RETURN_MATCHING, NOW)
    expect(env.sources.map((s) => s.id)).toContain(`case:audit_a_q2/${dupQ2}`)
    expect(env.result!.counts.byStage.requested).toBe(1)
    expect(env.result!.counts.closedWithoutRecovery).toBe(0)

    const tie = recoveryOverview(ctxA, sourceOf(a1, a2).cases, NO_RETURN_MATCHING, NOW)
    expect(tie.sources.map((s) => s.id)).toContain(`case:audit_a_q1/${DUP_Q1}`)
    expect(tie.sources.map((s) => s.id)).not.toContain(`case:audit_a_q2/${dupQ2}`)
    expect(tie.warnings.map((w) => w.code)).toEqual([RECOVERY_WARNING_CODES.CASES_FOLDED])
  })

  it('reports EUR cases in their own row and never in USD, matching ladder() by currency', () => {
    const eur = auditFromCsv('audit_eur', [
      'Fixture Euro Parts GmbH,EP-10,2026-02-11,2026-03-10,900.00,900.00,net 30,4444,Parts,EUR,',
      'Fixture Euro Parts GmbH,EP-10,2026-02-11,2026-03-24,900.00,900.00,net 30,4444,Parts,EUR,',
    ])
    const env = recoveryOverview(ctxA, sourceOf(q1(), eur).cases, NO_RETURN_MATCHING, NOW)
    expect(env.result!.byCurrency.map((r) => [r.currency, r.flaggedForReviewMinor])).toEqual([['EUR', 90000], ['USD', 141025]])
    expect(env.scope.currencies).toEqual(['EUR', 'USD'])
    expect(env.coverage.find((c) => c.check === 'supported_potential')!.reasons).toEqual([RECOVERY_COVERAGE_REASONS.GATE_CURRENCY_UNSUPPORTED])
    expect(env.coverage.find((c) => c.check === 'recovery_cases')!.reasons).toContain(COVERAGE_REASONS.MIXED_CURRENCY)
    const l = ladder(ledgerOf(eur))
    expect(cents(l.flaggedByCurrency.EUR)).toBe(90000)
    expect(l.flagged).toBe(0)
  })

  it('reports matched returns only from an available matcher, once per case, separate from customer-recorded returns', () => {
    const [a1, a2] = tenantAAudits()
    const dupQ2 = findingsOf(a2).find((f) => f.type === 'exact_duplicate')!.id
    const audit = withCaseState(a1, DUP_Q1, verifyRecovery(requested(), refund(400, 'FIXTURE-REF-6', T(4))))
    const match = (caseId: string, status: ReturnMatch['status'], amountMinor: number): ReturnMatch => ({ caseId, status, sourceRecordIds: ['bank/1'], method: 'refund', amount: { currency: 'USD', amountMinor }, date: '2026-04-05', rationale: 'fixture', algorithmVersion: 'fixture-1' })
    const returns: ReturnMatchPort = {
      available: true,
      listMatches: () => [
        match(`audit_a_q1/${DUP_Q1}`, 'verified', 40000),
        match(`audit_a_q2/${dupQ2}`, 'verified', 40000), // same return reported against the other copy
        match(`audit_a_q1/${DUP_Q1}`, 'proposed', 1000),
        match('audit_zzz/unknown', 'verified', 99999),
      ],
    }
    const env = recoveryOverview(ctxA, sourceOf(audit, a2).cases, returns, NOW)
    const row = usd(env.result!.byCurrency)
    expect(row.matchedReturnsMinor).toBe(40000)
    expect(row.matchedReturnsCount).toBe(1)
    expect(row.customerRecordedReturnsMinor).toBe(40000)
    expect(env.result!.returnMatching).toEqual({ available: true, verified: 1, proposed: 1, ambiguous: 0, reversed: 0 })
    expect(env.coverage.find((c) => c.check === 'matched_returns')!.status).toBe('supported')
    expect(env.warnings.map((w) => w.code)).toContain(RECOVERY_WARNING_CODES.MATCH_UNKNOWN_CASE)
  })

  it('reports an empty account as no data, not as nothing to recover', () => {
    const env = recoveryOverview(ctxA, sourceOf().cases, NO_RETURN_MATCHING, NOW)
    expect(env.result!.byCurrency).toEqual([])
    expect(env.result!.counts.cases).toBe(0)
    expect(env.coverage.find((c) => c.check === 'recovery_cases')).toMatchObject({ status: 'limited', reasons: expect.arrayContaining([COVERAGE_REASONS.NO_DATA]) })
    expect(env.exclusions).toEqual([])
  })

  it('refuses another tenant and a missing permission', () => {
    const cases = sourceOf(q1()).cases
    const ctxB = fixtureContext('tenant_b')
    const noCases = fixtureContext('tenant_a', ['financial:read'])
    for (const call of [(ctx: typeof ctxA) => recoveryOverview(ctx, cases, NO_RETURN_MATCHING, NOW), (ctx: typeof ctxA) => recoveryByVendor(ctx, cases, NO_RETURN_MATCHING, NOW)]) {
      expect(() => call(ctxB)).toThrow(IntelligenceAccessError)
      expect(() => call(noCases)).toThrow(IntelligenceAccessError)
      try { call(noCases) } catch (e) { expect((e as IntelligenceAccessError).code).toBe('forbidden') }
      try { call(ctxB) } catch (e) { expect((e as IntelligenceAccessError).code).toBe('tenant_mismatch') }
    }
  })

  it('marks freshness from case activity or a caller-supplied basis, deterministically', () => {
    const audit = withCaseState(q1(), DUP_Q1, requested())
    const cases = sourceOf(audit).cases
    const env = recoveryOverview(ctxA, cases, NO_RETURN_MATCHING, NOW)
    expect(env).toEqual(recoveryOverview(ctxA, cases, NO_RETURN_MATCHING, NOW))
    expect(recoveryOverview(ctxA, cases, NO_RETURN_MATCHING, NOW, { sourceUpdatedAt: Date.UTC(2026, 2, 31) }).freshness.stale).toBe(true)
    expect(recoveryOverview(ctxA, cases, NO_RETURN_MATCHING, NOW, { sourceUpdatedAt: NOW - DAY, extraCoverageReasons: ['unreadable_audits'] }).coverage[0].reasons).toContain('unreadable_audits')
  })

  it('ships plain-language definitions without forbidden wording', () => {
    const env = recoveryOverview(ctxA, sourceOf(q1()).cases, NO_RETURN_MATCHING, NOW)
    expect(env.result!.definitions).toBe(RECOVERY_DEFINITIONS)
    for (const text of Object.values(RECOVERY_DEFINITIONS)) {
      expect(text).not.toMatch(/fraud|you are owed|verified|all clear|price increase/i)
      expect(text.trim().endsWith('.')).toBe(true)
    }
  })
})

describe('recoveryByVendor', () => {
  it('groups deduplicated cases by vendor key with per-currency figures and bounded pages', () => {
    const [a1, a2] = tenantAAudits()
    const eur = auditFromCsv('audit_eur', [
      'Fixture Euro Parts GmbH,EP-10,2026-02-11,2026-03-10,900.00,900.00,net 30,4444,Parts,EUR,',
      'Fixture Euro Parts GmbH,EP-10,2026-02-11,2026-03-24,900.00,900.00,net 30,4444,Parts,EUR,',
    ])
    const cases = sourceOf(a1, a2, eur).cases
    const env = recoveryByVendor(ctxA, cases, NO_RETURN_MATCHING, NOW)
    const rows = env.result!.rows
    expect(rows.map((r) => [r.displayName, r.counts.cases, r.byCurrency.map((c) => [c.currency, c.flaggedForReviewMinor])])).toEqual([
      ['Fixture Coffee Co', 2, [['USD', 141025 + 356975]]],
      ['Fixture Euro Parts GmbH', 1, [['EUR', 90000]]],
    ])
    expect(rows[0].caseIds).toEqual([`audit_a_q1/${DUP_Q1}`, 'audit_a_q2/amount_outlier-rec_7'])
    expect(env.result!.totalRows).toBe(2)
    const first = recoveryByVendor(ctxA, cases, NO_RETURN_MATCHING, NOW, { limit: 1 }).result!
    expect(first.nextCursor).toBe('1')
    expect(recoveryByVendor(ctxA, cases, NO_RETURN_MATCHING, NOW, { limit: 1, cursor: '1' }).result!.rows[0].displayName).toBe('Fixture Euro Parts GmbH')
    expect(() => recoveryByVendor(ctxA, cases, NO_RETURN_MATCHING, NOW, { limit: 500 })).toThrow(IntelligenceQueryError)
    expect(() => recoveryByVendor(ctxA, cases, NO_RETURN_MATCHING, NOW, { cursor: 'x' })).toThrow(IntelligenceQueryError)
  })
})
