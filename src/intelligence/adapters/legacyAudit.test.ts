import { describe, expect, it } from 'vitest'
import { isClaim } from '@/lib/claims'
import type { FindingType } from '@/types'
import { approveRecovery, startRecoveryRequest, verifyRecovery } from '@/recovery/model'
import { EMPTY_CASE_STATE } from '@/ledger/caseState'
import { createLegacyAuditSource, NOT_A_CLAIM_TYPES } from './legacyAudit.ts'
import { auditFromCsv, findingsOf, fixtureContext, tenantAAudits, tenantBAudits, TENANT_A_Q1, withCaseState } from '../fixtures/synthetic.ts'
import { IntelligenceAccessError } from '../envelope.ts'

const ctxA = fixtureContext('tenant_a')
const NOW = Date.UTC(2026, 6, 1)

describe('legacy audit adapter', () => {
  it('mirrors src/lib/claims.ts for every finding type', () => {
    const types: FindingType[] = ['exact_duplicate', 'near_duplicate', 'overpayment', 'unclaimed_discount', 'missed_discount', 'bank_account_change', 'amount_outlier', 'shared_invoice_number']
    for (const type of types) expect(NOT_A_CLAIM_TYPES.has(type)).toBe(!isClaim({ type }))
  })

  it('maps rows to source records with calendar dates, integer cents and explicit unknowns', () => {
    const source = createLegacyAuditSource('tenant_a', [auditFromCsv('a1', TENANT_A_Q1)])
    const records = source.financial.listSourceRecords(ctxA)
    expect(records).toHaveLength(TENANT_A_Q1.length)
    const coffee = records.find((r) => r.invoiceReference === 'INV-1002')!
    expect(coffee).toMatchObject({ amountMinor: 135050, currency: 'USD', paymentDate: '2026-02-05', kind: 'payment', settlement: 'unknown', category: 'COGS' })
    expect(coffee.recordId.startsWith('a1/')).toBe(true)
    expect(records.find((r) => r.invoiceReference === 'OS-78R')).toMatchObject({ kind: 'refund', amountMinor: -5000 })
    expect(records.find((r) => r.invoiceReference === 'OS-77')!.unknownFields).toContain('category')
    expect(records.find((r) => r.invoiceReference === 'EP-9')!.currency).toBe('EUR')
    expect(records.every((r) => Number.isSafeInteger(r.amountMinor))).toBe(true)
  })

  it('keeps a within-audit duplicate payment as two records but counts a cross-audit repeat once', () => {
    const source = createLegacyAuditSource('tenant_a', tenantAAudits())
    const records = source.financial.listSourceRecords(ctxA)
    expect(records.filter((r) => r.invoiceReference === 'INV-1003')).toHaveLength(2)
    expect(records.filter((r) => r.invoiceReference === 'RENT-03')).toHaveLength(1)
    expect(source.financial.overlapCount(ctxA)).toBe(3)
  })

  it('refuses a context for another tenant', () => {
    const source = createLegacyAuditSource('tenant_a', tenantAAudits())
    const ctxB = fixtureContext('tenant_b')
    expect(() => source.financial.listSourceRecords(ctxB)).toThrow(IntelligenceAccessError)
    expect(() => source.cases.listCases(ctxB, NOW)).toThrow(IntelligenceAccessError)
    const b = createLegacyAuditSource('tenant_b', tenantBAudits())
    expect(b.financial.listSourceRecords(ctxB).every((r) => r.tenantId === 'tenant_b')).toBe(true)
  })

  it('reports unreadable audits instead of dropping them', () => {
    const source = createLegacyAuditSource('tenant_a', [{ id: 'broken', environment: { nope: true } }, ...tenantAAudits()])
    expect(source.unreadableAuditIds).toEqual(['broken'])
  })

  it('keeps supported, approved, promised, customer-recorded and matched amounts apart', () => {
    let audit = auditFromCsv('a1', TENANT_A_Q1)
    const duplicate = findingsOf(audit).find((f) => f.type === 'exact_duplicate')!
    let state = approveRecovery({ ...EMPTY_CASE_STATE, decision: 'confirmed', decidedAt: 1, recoveryStage: 'confirmed' }, { at: 2, knownBeforeReclaim: false })
    state = startRecoveryRequest(state, 1410.25, 3)
    state = verifyRecovery(state, { amount: 400, method: 'refund', source: 'bank', reference: 'FIXTURE-REF-1', settledAt: 4 })
    audit = withCaseState(audit, duplicate.id, state)
    const snap = createLegacyAuditSource('tenant_a', [audit]).cases.listCases(ctxA, NOW).find((c) => c.findingId === duplicate.id)!
    expect(snap.customerRecordedReturnMinor).toBe(40000)
    expect(snap.matchedReturnMinor).toBeNull()
    expect(snap.supportedPotentialMinor).toBeNull() // no attested evidence: the gate has not passed
    expect(snap.flaggedMinor).toBe(141025)
    expect(snap.stage).toBe('requested')
  })

  it('gives the same check on the same rows in two audits one cross-audit key', () => {
    const source = createLegacyAuditSource('tenant_a', tenantAAudits())
    const dups = source.cases.listCases(ctxA, NOW).filter((c) => c.findingType === 'exact_duplicate')
    expect(dups.length).toBe(2)
    expect(new Set(dups.map((c) => c.crossAuditKey)).size).toBe(1)
  })
})
