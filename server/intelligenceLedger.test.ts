// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './db.ts'
import { importCsv, type LedgerKeys } from './ledger.ts'
import { setMemberRole, tenantContextFor, TenantAccessError } from './tenancy.ts'
import {
  LEDGER_AUDIT_ID,
  LEDGER_COVERAGE_REASONS,
  ORGANISATION_MEMBER_SOURCE,
  canonicalVendorKey,
  createLedgerReturnMatchPort,
  createServerLedgerSource,
  intelligencePermissionsFor,
  resolveIntelligenceSources,
  runLedgerReturnMatching,
  tenantContextFromMembership,
  type IntelligenceSourceDeps,
} from './intelligenceLedger.ts'
import { parseCsv } from '../src/lib/csv.ts'
import { ROLE_PERMISSIONS } from './tenancy.ts'
import { hasPermission, type TenantContext } from '../src/intelligence/contracts.ts'
import { IntelligenceAccessError } from '../src/intelligence/envelope.ts'
import { spendSummary, spendByVendor, importCoverageSummary } from '../src/intelligence/spend.ts'
import { recoveryOverview } from '../src/intelligence/recoveryVisibility.ts'
import { vendorProfiles } from '../src/intelligence/vendorProfiles.ts'
import { InMemoryFeedbackStore } from '../src/intelligence/memory.ts'
import { createLegacyAuditSource, type StoredAudit } from '../src/intelligence/adapters/legacyAudit.ts'

// SYNTHETIC FIXTURES ONLY. Every supplier, reference and amount is invented.
const HEAD = 'vendor,invoice_number,invoice_date,payment_date,amount_paid,currency,external_transaction_id,transaction_type'
const FILE_A = [
  HEAD,
  'Acme Supplies,INV-100101,2026-01-01,2026-01-10,1250.10,USD,SYN-A1,Bill Payment',
  'Acme Supplies,INV-100102,2026-02-01,2026-02-10,1250.10,USD,SYN-A2,Bill Payment',
  'Acme Supplies,INV-100103,2026-03-01,2026-03-10,1250.10,USD,SYN-A3,Bill Payment',
  'Beta Logistics,INV-200101,2026-01-15,2026-01-20,500.33,USD,SYN-B1,Bill Payment',
  'Gamma Parts,CR-300101,,2026-02-03,-200.00,USD,SYN-G1,Refund',
  'Delta GmbH,INV-400101,2026-02-01,2026-02-05,300.01,EUR,SYN-D1,Bill Payment',
  'Delta GmbH,INV-400102,2026-02-01,2026-02-06,100.00,,SYN-D2,Bill Payment',
  'Epsilon Co,INV-500101,2026-02-01,2026-02-07,700.00,USD,SYN-E1,Void',
  // The supplier's refund against the approved request in the saved audit below.
  'Zeta Freight,ZF-INV-700123,,2026-03-10,-400.00,USD,SYN-Z9,Refund',
].join('\n')
// Repeats two rows of FILE_A and adds one payment.
const FILE_B = [
  HEAD,
  'Acme Supplies,INV-100102,2026-02-01,2026-02-10,1250.10,USD,SYN-A2,Bill Payment',
  'Beta Logistics,INV-200101,2026-01-15,2026-01-20,500.33,USD,SYN-B1,Bill Payment',
  'Theta Tools,INV-600101,2026-03-14,2026-03-14,90.07,USD,SYN-T1,Bill Payment',
].join('\n')

const NOW = Date.UTC(2026, 3, 1)
const REQUESTED_AT = Date.UTC(2026, 2, 1)
const keys: LedgerKeys = null

const addUser = (db: DatabaseSync, id: string) => db.prepare('INSERT INTO users (id, email, company, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}@example.test`, `${id} Co`, 1)

function setup() {
  const db = openDatabase(':memory:')
  for (const id of ['alice', 'bob', 'carol']) addUser(db, id)
  const alice = tenantContextFor(db, 'alice')
  return { db, alice, bob: tenantContextFor(db, 'bob') }
}

/** Ours, for the ledger's tenant: what tenantContextFromMembership returns for a sole owner. */
const ours = (tenantId: string, permissions = intelligencePermissionsFor(ROLE_PERMISSIONS.owner)): TenantContext => ({ tenantId, actorId: 'alice', permissions, source: 'test_fixture' })

/**
 * A saved audit (ProjectStore JSON shape) built through the real parser, holding
 * one exact duplicate to Zeta Freight with an approved, sent request for 400.00.
 */
function savedAuditWithRequest(id: string, state: Record<string, unknown> = {}): StoredAudit {
  const parsed = parseCsv([
    'vendor,invoice_number,invoice_date,payment_date,invoice_amount,amount_paid,currency',
    'Zeta Freight,ZF-INV-700123,2026-01-02,2026-01-05,400.00,400.00,USD',
    'Zeta Freight,ZF-INV-700123,2026-01-02,2026-01-12,400.00,400.00,USD',
  ].join('\n'))
  const records = parsed.records.map((r, i) => ({ ...r, id: `${id}-r${i}`, importBatchId: `${id}-batch` }))
  const finding = {
    id: `exact_duplicate-${id}`, type: 'exact_duplicate', title: 'Synthetic duplicate', explanation: 'Synthetic.', severity: 'high', vendor: 'Zeta Freight', currency: 'USD',
    dollarImpact: 400, flaggedAmount: 400, classification: 'recovery_candidate', class: 'recoverable', relatedRecords: records.map((r) => ({ id: r.id })),
  }
  const caseState = { decision: 'confirmed', decidedAt: REQUESTED_AT - 2, approvedAt: REQUESTED_AT - 1, requestedAmount: 400, requestedResolution: 'refund', recoveryStage: 'requested', recoveryRequestedAt: REQUESTED_AT, ...state }
  const environment = JSON.parse(JSON.stringify({ records, imports: [{ id: `${id}-batch`, sourceLabel: `${id}.csv`, mode: 'upload', importedAt: 1, recordCount: 2, skippedCount: 0 }], result: { findings: [finding] }, caseStates: { [finding.id]: caseState }, updatedAt: 5 }))
  return { id, name: id, updatedAt: 5, environment }
}

const projectsOf = (byUser: Record<string, StoredAudit[]>): IntelligenceSourceDeps['projects'] => ({
  listAll: (userId: string) => ({ projects: (byUser[userId] ?? []) as unknown as Record<string, unknown>[], unreadable: [] }),
  revision: () => 1,
})

describe('server ledger financial source', () => {
  it('maps ledger records faithfully: kinds, signed minor units, explicit unknown currency, calendar dates, unknown fields', () => {
    const { db, alice } = setup()
    const imported = importCsv(db, keys, alice, { csv: FILE_A, sourceLabel: 'synthetic-a.csv' })
    const source = createServerLedgerSource({ db, keys }, alice)
    const ctx = ours(alice.tenantId)
    expect(source.financial.origin).toBe('canonical_ledger')
    const records = source.financial.listSourceRecords(ctx)
    expect(records).toHaveLength(9)
    const by = (ref: string) => records.find((r) => r.invoiceReference === ref)!
    expect(by('INV-100101')).toMatchObject({ tenantId: alice.tenantId, auditId: LEDGER_AUDIT_ID, kind: 'payment', amountMinor: 125010, currency: 'USD', paymentDate: '2026-01-10', invoiceDate: '2026-01-01', category: null, settlement: 'unknown', source: { system: 'csv', importId: imported.importId, nativeId: 'SYN-A1' } })
    expect(by('CR-300101')).toMatchObject({ kind: 'refund', amountMinor: -20000, invoiceDate: null })
    expect(by('INV-500101').kind).toBe('unknown') // a void moved no money
    expect(by('INV-400102')).toMatchObject({ currency: 'UNKNOWN' })
    expect(by('INV-400102').unknownFields).toEqual(expect.arrayContaining(['currency', 'category', 'settlement']))
    expect(by('INV-400101').currency).toBe('EUR')
    expect(records.every((r) => Number.isSafeInteger(r.amountMinor) && r.unknownFields.includes('settlement'))).toBe(true)
    expect(records.every((r) => r.unknownFields.some((f) => f.startsWith('source.')))).toBe(true)
  })

  it('uses the same vendor key the browser engine gives saved audits, so cases and records join', () => {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const records = createServerLedgerSource({ db, keys }, alice).financial.listSourceRecords(ours(alice.tenantId))
    const browser = parseCsv(FILE_A).records
    for (const r of records) {
      const twin = browser.find((b) => b.externalTransactionId === r.source.nativeId)!
      expect(r.vendor.vendorKey).toBe(twin.canonicalVendorId)
    }
    expect(canonicalVendorKey({ vendorKey: 'id:SUP-9', vendorName: 'Anything' })).toBe(parseCsv('vendor,vendor_id,payment_date,amount_paid\nAnything,SUP-9,2026-01-01,1.00').records[0].canonicalVendorId)
  })

  it('gives cent-exact spend totals that match a hand calculation, per currency, never combined', () => {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const source = createServerLedgerSource({ db, keys }, alice)
    const ctx = ours(alice.tenantId)
    const env = spendSummary(ctx, source.financial, null, NOW, { extraCoverageReasons: source.coverageReasons() })
    expect(env.origin).toBe('canonical_ledger')
    // USD payments: 3 x 1,250.10 + 500.33 = 4,250.63. The 700.00 void is not a payment.
    expect(env.result!.gross).toEqual([{ currency: 'EUR', amountMinor: 30001 }, { currency: 'UNKNOWN', amountMinor: 10000 }, { currency: 'USD', amountMinor: 3 * 125010 + 50033 }])
    // Refunds reported beside gross, never netted: 200.00 + 400.00.
    expect(env.result!.recordedRefundsAndCredits).toEqual([{ currency: 'USD', amountMinor: 60000 }])
    expect(env.result!.net).toBeNull()
    expect(env.exclusions.find((e) => e.code === 'unclassified_transaction')).toMatchObject({ count: 1, amounts: [{ currency: 'USD', amountMinor: 70000 }] })
    expect(env.coverage[0].reasons).toEqual(expect.arrayContaining(['customer_supplied_source', 'settlement_unverified', 'missing_currency', 'mixed_currency']))
    const january = spendSummary(ctx, source.financial, { from: '2026-01-01', to: '2026-01-31' }, NOW)
    expect(january.result!.gross).toEqual([{ currency: 'USD', amountMinor: 125010 + 50033 }])
  })

  it('counts a row a later import repeated once and reports the ledger dedup as overlap', () => {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    importCsv(db, keys, alice, { csv: FILE_B })
    const source = createServerLedgerSource({ db, keys }, alice)
    const ctx = ours(alice.tenantId)
    expect(source.financial.overlapCount(ctx)).toBe(2)
    expect(source.financial.listImportCoverage(ctx)).toHaveLength(2)
    expect(source.financial.listImportCoverage(ctx)[1]).toMatchObject({ auditId: LEDGER_AUDIT_ID, system: 'csv', acceptedRows: 3, rejectedRows: 0, dateRange: { from: '2026-01-20', to: '2026-03-14' } })
    const env = spendSummary(ctx, source.financial, null, NOW)
    expect(env.result!.byCurrency.find((l) => l.currency === 'USD')!.grossPaymentsMinor).toBe(3 * 125010 + 50033 + 9007)
    expect(env.exclusions.find((e) => e.code === 'cross_audit_overlap')!.count).toBe(2)
    expect(importCoverageSummary(ctx, source.financial, NOW).result).not.toBeNull()
  })

  it('reports rows a single import repeated (stored once by the ledger) as a coverage limit', () => {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: [HEAD, 'Iota Ltd,INV-900101,2026-01-01,2026-01-02,10.00,USD,,Bill Payment', 'Iota Ltd,INV-900101,2026-01-01,2026-01-02,10.00,USD,,Bill Payment'].join('\n') })
    const source = createServerLedgerSource({ db, keys }, alice)
    expect(source.dedup().repeatedWithinImport).toBe(1)
    expect(source.coverageReasons()).toContain(LEDGER_COVERAGE_REASONS.WITHIN_IMPORT_REPEATS_NOT_STORED)
  })

  it('derives recurring series from ledger records on the server, keyed to ledger record IDs', () => {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const source = createServerLedgerSource({ db, keys }, alice)
    const ctx = ours(alice.tenantId)
    const series = source.financial.listRecurringSeries(ctx)
    expect(series).toHaveLength(1)
    const acmeIds = source.financial.listSourceRecords(ctx).filter((r) => r.vendor.displayName === 'Acme Supplies').map((r) => r.recordId).sort()
    expect(series[0]).toMatchObject({ auditId: LEDGER_AUDIT_ID, vendorName: 'Acme Supplies', amount: { currency: 'USD', amountMinor: 125010 }, paymentCount: 3, firstPaymentDate: '2026-01-10', lastPaymentDate: '2026-03-10' })
    expect([...series[0].sourceRecordIds].sort()).toEqual(acmeIds)
    expect(series[0].vendorKey).toBe(source.financial.listSourceRecords(ctx).find((r) => r.recordId === acmeIds[0])!.vendor.vendorKey)
    // An injected engine-side series wins over the reconstruction.
    const injected = createServerLedgerSource({ db, keys, recurringSeries: () => [] }, alice)
    expect(injected.financial.listRecurringSeries(ctx)).toEqual([])
  })

  it('refuses another tenant on every port method, and the ledger itself never returns another tenant\'s rows', () => {
    const { db, alice, bob } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    importCsv(db, keys, bob, { csv: FILE_B })
    const aliceSource = createServerLedgerSource({ db, keys }, alice)
    const bobCtx = ours(bob.tenantId)
    expect(() => aliceSource.financial.listSourceRecords(bobCtx)).toThrow(IntelligenceAccessError)
    expect(() => aliceSource.financial.listImportCoverage(bobCtx)).toThrow(IntelligenceAccessError)
    expect(() => aliceSource.financial.overlapCount(bobCtx)).toThrow(IntelligenceAccessError)
    expect(() => aliceSource.financial.listRecurringSeries(bobCtx)).toThrow(IntelligenceAccessError)
    expect(() => spendSummary(bobCtx, aliceSource.financial, null, NOW)).toThrow(IntelligenceAccessError)
    const bobSource = createServerLedgerSource({ db, keys }, bob)
    expect(bobSource.financial.listSourceRecords(bobCtx).map((r) => r.tenantId)).toEqual([bob.tenantId, bob.tenantId, bob.tenantId])
    // Bob cannot select Alice's organisation at all.
    expect(() => tenantContextFromMembership(db, 'bob', alice.tenantId)).toThrow(TenantAccessError)
  })
})

describe('tenant context from organisation membership', () => {
  it('a sole owner of a personal organisation is a single-user session on the organisation id, reading their own saved audits', () => {
    const { db, alice } = setup()
    const t = tenantContextFromMembership(db, 'alice')
    expect(t.ctx).toEqual({ tenantId: alice.tenantId, actorId: 'alice', permissions: ['financial:read', 'cases:read', 'feedback:write', 'insights:refresh', 'assistant:ask'], source: 'single_user_session' })
    expect(t.ctx.tenantId).not.toBe('alice')
    expect(t.legacyAuditOwnerId).toBe('alice')
  })

  it('a viewer gets read-only permissions, no implicit owner rights and no access to the owner\'s saved audits', () => {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    setMemberRole(db, alice, 'carol', 'viewer')
    const t = tenantContextFromMembership(db, 'carol', alice.tenantId)
    expect(t.ctx.permissions).toEqual(['financial:read', 'cases:read'])
    expect(t.ctx.source).toBe(ORGANISATION_MEMBER_SOURCE)
    expect(hasPermission(t.ctx, 'feedback:write')).toBe(false)
    expect(hasPermission(t.ctx, 'assistant:ask')).toBe(false)
    expect(hasPermission(t.ctx, 'insights:refresh')).toBe(false)
    expect(t.legacyAuditOwnerId).toBeNull()
    // Read models still work for a viewer, on the organisation's ledger.
    const source = createServerLedgerSource({ db, keys }, t.ledgerCtx)
    expect(spendSummary(t.ctx, source.financial, null, NOW).result!.paymentCount).toBe(6)
    // Once someone else is a member, the owner is no longer a single-user session either.
    const owner = tenantContextFromMembership(db, 'alice')
    expect(owner.ctx.source).toBe(ORGANISATION_MEMBER_SOURCE)
    expect(owner.legacyAuditOwnerId).toBe('alice')
  })

  it('maps member and admin conservatively', () => {
    expect(intelligencePermissionsFor(ROLE_PERMISSIONS.member)).toEqual(['financial:read', 'cases:read', 'feedback:write', 'assistant:ask'])
    expect(intelligencePermissionsFor(ROLE_PERMISSIONS.admin)).toEqual(['financial:read', 'cases:read', 'feedback:write', 'insights:refresh', 'assistant:ask'])
    expect(intelligencePermissionsFor([])).toEqual([])
  })
})

describe('ledger return matching', () => {
  function world(state: Record<string, unknown> = {}) {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const ctx = ours(alice.tenantId)
    const ledger = createServerLedgerSource({ db, keys }, alice)
    const legacy = createLegacyAuditSource(alice.tenantId, [savedAuditWithRequest('aud1', state), savedAuditWithRequest('aud2', state)])
    return { db, alice, ctx, ledger, legacy }
  }

  it('proposes the ledger refund against the approved request, with the CaseSnapshot case id, once across two saved copies', () => {
    const { ctx, ledger, legacy } = world()
    const run = runLedgerReturnMatching(ctx, { ledger, cases: legacy.cases, caseRecords: legacy.financial, now: NOW })
    const refundId = ledger.financial.listSourceRecords(ctx).find((r) => r.invoiceReference === 'ZF-INV-700123')!.recordId
    expect(run.skipped).toEqual([])
    expect(run.matches).toEqual([{
      caseId: 'aud1/exact_duplicate-aud1', status: 'proposed', sourceRecordIds: [refundId], method: 'refund',
      amount: { currency: 'USD', amountMinor: 40000 }, date: '2026-03-10', rationale: expect.stringContaining('gate_required'), algorithmVersion: 'return-match/1.0.0',
    }])
  })

  it('shows proposed matches as available but not yet matched in recoveryOverview, and as matchedReturns once the gate accepts them', () => {
    const { ctx, ledger, legacy } = world()
    const port = createLedgerReturnMatchPort({ ledger, cases: legacy.cases, caseRecords: legacy.financial, now: NOW })
    expect(port.available).toBe(true)
    const proposed = recoveryOverview(ctx, legacy.cases, port, NOW)
    expect(proposed.result!.returnMatching).toEqual({ available: true, verified: 0, proposed: 1, ambiguous: 0, reversed: 0 })
    const usd = proposed.result!.byCurrency.find((r) => r.currency === 'USD')!
    expect(usd.matchedReturnsMinor).toBe(0)
    expect(usd.customerRecordedReturnsMinor).toBe(0)
    expect(proposed.coverage.find((c) => c.check === 'matched_returns')!.status).toBe('supported')

    const refundId = ledger.financial.listSourceRecords(ctx).find((r) => r.invoiceReference === 'ZF-INV-700123')!.recordId
    const gated = createLedgerReturnMatchPort({ ledger, cases: legacy.cases, caseRecords: legacy.financial, now: NOW, acceptedLinks: [{ caseId: 'aud1/exact_duplicate-aud1', sourceRecordIds: [refundId] }] })
    const verified = recoveryOverview(ctx, legacy.cases, gated, NOW)
    expect(verified.result!.returnMatching).toMatchObject({ available: true, verified: 1, proposed: 0 })
    const row = verified.result!.byCurrency.find((r) => r.currency === 'USD')!
    expect(row.matchedReturnsMinor).toBe(40000)
    expect(row.matchedReturnsCount).toBe(1)
    // Never added to, or taken from, customer-recorded returns.
    expect(row.customerRecordedReturnsMinor).toBe(0)
  })

  it('keeps a customer-recorded return separate from the source-evidenced one', () => {
    const { ctx, ledger, legacy } = world({ recoverySettlements: [{ amount: 150, method: 'refund', source: 'bank', reference: 'SYN-BANK-1', settledAt: REQUESTED_AT + 5 }] })
    const port = createLedgerReturnMatchPort({ ledger, cases: legacy.cases, caseRecords: legacy.financial, now: NOW })
    const env = recoveryOverview(ctx, legacy.cases, port, NOW)
    const usd = env.result!.byCurrency.find((r) => r.currency === 'USD')!
    expect(usd.customerRecordedReturnsMinor).toBe(15000)
    expect(usd.matchedReturnsMinor).toBe(0)
    expect(port.listMatches(ctx)[0].rationale).toContain('customer_recorded_separately')
  })

  it('reports an unapproved request as skipped instead of matching it', () => {
    const { ctx, ledger, legacy } = world({ approvedAt: null })
    const run = runLedgerReturnMatching(ctx, { ledger, cases: legacy.cases, caseRecords: legacy.financial, now: NOW })
    expect(run.matches).toEqual([])
    expect(run.skipped).toEqual([{ caseId: 'aud1/exact_duplicate-aud1', reason: 'not_approved' }])
  })

  it('is unavailable before the tenant has any ledger import, and refuses another tenant', () => {
    const { db, alice, bob } = setup()
    const ledger = createServerLedgerSource({ db, keys }, alice)
    const legacy = createLegacyAuditSource(alice.tenantId, [])
    const port = createLedgerReturnMatchPort({ ledger, cases: legacy.cases, now: NOW })
    expect(port.available).toBe(false)
    expect(() => port.listMatches(ours(bob.tenantId))).toThrow(IntelligenceAccessError)
  })
})

describe('resolveIntelligenceSources', () => {
  it('ledger flag off: today\'s behaviour, tenant = user id, saved audits only, no return matching', () => {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const r = resolveIntelligenceSources({ db, keys, serverLedger: false, projects: projectsOf({ alice: [savedAuditWithRequest('aud1')] }) }, { id: 'alice' }, null, NOW)
    expect(r.mode).toBe('legacy')
    expect(r.ctx).toEqual({ tenantId: 'alice', actorId: 'alice', permissions: ['financial:read', 'cases:read', 'feedback:write', 'insights:refresh', 'assistant:ask'], source: 'single_user_session' })
    expect(r.source.financial.origin).toBe('legacy_audit_snapshot')
    expect(r.source.financial.listSourceRecords(r.ctx)).toHaveLength(2)
    expect(r.returns.available).toBe(false)
    expect(r.ledger).toBeNull()
  })

  it('ledger flag on with no ledger import: falls back to the owner\'s saved audits under the organisation id', () => {
    const { db, alice } = setup()
    const r = resolveIntelligenceSources({ db, keys, serverLedger: true, projects: projectsOf({ alice: [savedAuditWithRequest('aud1')] }) }, { id: 'alice' }, null, NOW)
    expect(r.mode).toBe('legacy')
    expect(r.ctx.tenantId).toBe(alice.tenantId)
    expect(r.source.financial.origin).toBe('legacy_audit_snapshot')
    expect(r.source.financial.listSourceRecords(r.ctx).every((x) => x.tenantId === alice.tenantId)).toBe(true)
    expect(r.returns.available).toBe(false)
    expect(spendSummary(r.ctx, r.source.financial, null, NOW).result!.gross).toEqual([{ currency: 'USD', amountMinor: 80000 }])
  })

  it('ledger flag on with an import: ledger financials, saved-audit cases, ledger return matching, and the limits on every envelope', () => {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const r = resolveIntelligenceSources({ db, keys, serverLedger: true, projects: projectsOf({ alice: [savedAuditWithRequest('aud1')] }) }, { id: 'alice' }, null, NOW)
    expect(r.mode).toBe('ledger')
    expect(r.source.financial.origin).toBe('canonical_ledger')
    expect(r.source.cases.origin).toBe('legacy_audit_snapshot')
    expect(r.returns.available).toBe(true)
    expect(r.extraCoverageReasons).toEqual(['customer_supplied_source', LEDGER_COVERAGE_REASONS.SAVED_AUDITS_NOT_IN_LEDGER])
    const spend = spendSummary(r.ctx, r.source.financial, null, NOW, { extraCoverageReasons: r.extraCoverageReasons })
    // The saved audit's two 400.00 payments are not added to the ledger's figures.
    expect(spend.result!.gross.find((g) => g.currency === 'USD')!.amountMinor).toBe(3 * 125010 + 50033)
    expect(spend.coverage[0].reasons).toContain(LEDGER_COVERAGE_REASONS.SAVED_AUDITS_NOT_IN_LEDGER)
    expect(recoveryOverview(r.ctx, r.source.cases, r.returns, NOW).result!.returnMatching.proposed).toBe(1)
    // Vendor profiles join ledger records and saved-audit cases on one vendor key.
    const profiles = vendorProfiles(r.ctx, r.source.financial, r.source.cases, new InMemoryFeedbackStore(), NOW, { limit: 50 })
    const zeta = profiles.result!.items.filter((p) => p.primaryName === 'Zeta Freight')
    expect(zeta).toHaveLength(1)
    expect(zeta[0].cases.caseCount).toBe(1)
    expect(zeta[0].evidenceQuality.recordCount).toBe(1) // the ledger refund
    expect(spendByVendor(r.ctx, r.source.financial, null, NOW).result!.rows.length).toBeGreaterThan(0)
  })

  it('a viewer in someone else\'s organisation reads the ledger but none of the owner\'s saved audits', () => {
    const { db, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    setMemberRole(db, alice, 'carol', 'viewer')
    const r = resolveIntelligenceSources({ db, keys, serverLedger: true, projects: projectsOf({ alice: [savedAuditWithRequest('aud1')] }) }, { id: 'carol' }, alice.tenantId, NOW)
    expect(r.mode).toBe('ledger')
    expect(r.source.cases.listCases(r.ctx, NOW)).toEqual([])
    expect(r.extraCoverageReasons).toContain(LEDGER_COVERAGE_REASONS.SAVED_AUDITS_NOT_SHARED)
    expect(spendSummary(r.ctx, r.source.financial, null, NOW).result!.paymentCount).toBe(6)
  })
})
