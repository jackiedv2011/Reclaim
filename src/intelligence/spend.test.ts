import { describe, expect, it } from 'vitest'
import type { LedgerEnvironment } from '@/ledger/store'
import { createLegacyAuditSource, type StoredAudit } from './adapters/legacyAudit.ts'
import { auditFromCsv, fixtureContext, tenantAAudits, TENANT_A_Q1 } from './fixtures/synthetic.ts'
import { COVERAGE_REASONS, type FinancialSourcePort, type ImportCoverage, type SourceRecord } from './contracts.ts'
import { IntelligenceAccessError } from './envelope.ts'
import {
  IntelligenceQueryError,
  importCoverageSummary,
  NET_UNAVAILABLE_REASON,
  shareBps,
  SPEND_COVERAGE_REASONS,
  SPEND_METRIC_VERSION,
  spendByCategory,
  spendByVendor,
  spendSummary,
  spendTrend,
} from './spend.ts'

const ctxA = fixtureContext('tenant_a')
const NOW = Date.UTC(2026, 6, 1)
const Q1_UPDATED = Date.UTC(2026, 2, 31)

function q1Source() {
  return createLegacyAuditSource('tenant_a', [auditFromCsv('audit_a_q1', TENANT_A_Q1, { updatedAt: Q1_UPDATED })])
}
function combinedSource() {
  return createLegacyAuditSource('tenant_a', tenantAAudits())
}

/** Copy of an audit with every import stamped at `at` (mergeImport stamps wall-clock time). */
function withImportedAt(audit: StoredAudit, at: number): StoredAudit {
  const env = structuredClone(audit.environment) as LedgerEnvironment
  for (const batch of env.imports) batch.importedAt = at
  return { ...audit, environment: env }
}

/** Copy of an audit where one record's stored instant (and optionally its raw cell) is replaced. */
function withPaymentDate(audit: StoredAudit, invoiceNumber: string, instantIso: string, rawCell: string | null): StoredAudit {
  const env = structuredClone(audit.environment) as unknown as { records: Array<Record<string, any>> }
  const record = env.records.find((r) => r.invoiceNumber === invoiceNumber)!
  record.paymentDate = instantIso
  if (rawCell === null) delete record.source.raw.payment_date
  else record.source.raw.payment_date = rawCell
  return { ...audit, environment: env }
}

/** A hand-built port for shapes the CSV pipeline cannot produce (undated rows, categories in mixed case). */
function stubPort(records: SourceRecord[], imports: ImportCoverage[], overlap = 0, origin: FinancialSourcePort['origin'] = 'fixture'): FinancialSourcePort {
  return {
    origin,
    listSourceRecords: (ctx) => { if (ctx.tenantId !== 'tenant_a') throw new IntelligenceAccessError('tenant_mismatch', 'other tenant'); return records },
    listImportCoverage: () => imports,
    overlapCount: () => overlap,
    listRecurringSeries: () => [],
  }
}
function rec(id: string, patch: Partial<SourceRecord> & { vendorName?: string }): SourceRecord {
  const vendorName = patch.vendorName ?? 'Fixture Vendor'
  return {
    recordId: `stub/${id}`,
    tenantId: 'tenant_a',
    auditId: 'stub',
    source: { system: 'fixture', importId: 'imp1', accountId: null, nativeId: null, filename: null, rowNumber: null },
    kind: 'payment',
    vendor: { displayName: vendorName, vendorKey: `vk_${vendorName.toLowerCase()}`, stableSupplierId: null, aliasSuggestion: null },
    invoiceReference: id,
    amountMinor: 10000,
    currency: 'USD',
    paymentDate: '2026-01-15',
    invoiceDate: null,
    category: 'Ops',
    settlement: 'unknown',
    identityKey: id,
    normalizationVersion: 'stub',
    unknownFields: ['settlement'],
    ...patch,
  }
}
const STUB_IMPORT: ImportCoverage = { importId: 'imp1', auditId: 'stub', system: 'fixture', importedAt: Date.UTC(2026, 5, 20), acceptedRows: 4, rejectedRows: 0, dateRange: { from: '2026-01-01', to: '2026-01-31' }, detectedColumns: [] }

describe('spendSummary', () => {
  it('totals TENANT_A_Q1 cent-exactly: gross payments, refunds apart, EUR apart, no net', () => {
    const env = spendSummary(ctxA, q1Source().financial, null, NOW)
    // USD payments: rent 3 × 4000.00 + coffee 1200.00 + 1350.50 + 1410.25 + 1410.25 + office 310.40 + 289.60 = 17,971.00
    expect(env.result!.byCurrency).toEqual([
      { currency: 'EUR', grossPaymentsMinor: 90000, paymentCount: 1, recordedRefundsAndCreditsMinor: 0, refundAndCreditCount: 0, vendorCount: 1 },
      { currency: 'USD', grossPaymentsMinor: 1797100, paymentCount: 9, recordedRefundsAndCreditsMinor: 5000, refundAndCreditCount: 1, vendorCount: 3 },
    ])
    expect(env.result!.gross).toEqual([{ currency: 'EUR', amountMinor: 90000 }, { currency: 'USD', amountMinor: 1797100 }])
    expect(env.result!.recordedRefundsAndCredits).toEqual([{ currency: 'USD', amountMinor: 5000 }])
    expect(env.result!.net).toBeNull()
    expect(env.result!.netUnavailableReason).toBe(NET_UNAVAILABLE_REASON)
    expect(env.result!.vendorCount).toBe(4)
    expect(env.result!.paymentCount).toBe(10)
    expect(env.result!.settlement).toBe('unknown')
    expect(env.metricDefinitionVersion).toBe(SPEND_METRIC_VERSION)
    expect(env.origin).toBe('legacy_audit_snapshot')
    expect(env.scope).toEqual({ from: null, to: null, dateBasis: 'payment_date', currencies: ['EUR', 'USD'] })
    const covered = env.coverage.find((c) => c.check === 'covered_spend')!
    expect(covered.status).toBe('limited')
    expect(covered.reasons).toEqual(expect.arrayContaining([COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS, COVERAGE_REASONS.SETTLEMENT_UNVERIFIED, COVERAGE_REASONS.MIXED_CURRENCY]))
    expect(env.coverage.find((c) => c.check === 'net_spend')).toEqual({ check: 'net_spend', status: 'not_run', reasons: [COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING] })
    expect(env.exclusions).toEqual([])
  })

  it('counts a payment held by two saved audits once (RENT-03, INV-1003 pair) and says so', () => {
    const source = combinedSource()
    const env = spendSummary(ctxA, source.financial, null, NOW)
    // Q1 USD 17,971.00 + new Q2 rows: rent 3 × 4000.00 + 1300.00 + 4980.00 + 1295.75 = 19,575.75 → 37,546.75
    expect(env.result!.gross).toEqual([{ currency: 'EUR', amountMinor: 90000 }, { currency: 'USD', amountMinor: 3754675 }])
    expect(env.result!.byCurrency.find((l) => l.currency === 'USD')!.paymentCount).toBe(15)
    expect(env.exclusions).toEqual([expect.objectContaining({ code: 'cross_audit_overlap', count: 3, amounts: [] })])
    expect(env.warnings.map((w) => w.code)).toContain('cross_audit_overlap_counted_once')
    const vendors = spendByVendor(ctxA, source.financial, null, NOW).result!
    const rent = vendors.rows.find((r) => r.displayName === 'Fixture Property Mgmt')!
    expect(rent).toMatchObject({ grossPaymentsMinor: 2400000, paymentCount: 6, firstPaymentDate: '2026-01-01', lastPaymentDate: '2026-06-01' })
    expect(rent.sourceRecordIds.filter((id) => id.startsWith('audit_a_q2/'))).toHaveLength(3) // RENT-04..06 only
  })

  it('filters by payment date and flags a period only partly covered by imports', () => {
    const env = spendSummary(ctxA, combinedSource().financial, { from: '2026-03-01', to: '2026-03-31' }, NOW)
    // RENT-03 4000.00 (03-01) + INV-1003 repeat 1410.25 (03-02); refund OS-78R 50.00 (03-05); EUR EP-9 900.00 (03-10)
    expect(env.result!.gross).toEqual([{ currency: 'EUR', amountMinor: 90000 }, { currency: 'USD', amountMinor: 541025 }])
    expect(env.result!.recordedRefundsAndCredits).toEqual([{ currency: 'USD', amountMinor: 5000 }])
    expect(env.scope.from).toBe('2026-03-01')
    // The second import's own rows start 03-01 (some were repeats of the first audit), so March is covered.
    expect(env.coverage[0].reasons).not.toContain(SPEND_COVERAGE_REASONS.PERIOD_PARTIALLY_COVERED)
    // Imports end 06-09: June 10-30 is not covered.
    const june = spendSummary(ctxA, combinedSource().financial, { from: '2026-06-01', to: '2026-06-30' }, NOW)
    expect(june.result!.gross).toEqual([{ currency: 'USD', amountMinor: 400000 + 129575 }])
    expect(june.coverage[0].reasons).toContain(SPEND_COVERAGE_REASONS.PERIOD_PARTIALLY_COVERED)
    const jan = spendSummary(ctxA, combinedSource().financial, { from: '2026-01-01', to: '2026-01-31' }, NOW)
    expect(jan.result!.gross).toEqual([{ currency: 'USD', amountMinor: 400000 + 120000 + 31040 }])
    expect(jan.coverage[0].reasons).not.toContain(SPEND_COVERAGE_REASONS.PERIOD_PARTIALLY_COVERED)
  })

  it('returns no totals for a period no import covers instead of zero', () => {
    const env = spendSummary(ctxA, combinedSource().financial, { from: '2025-01-01', to: '2025-12-31' }, NOW)
    expect(env.result).toBeNull()
    expect(env.coverage[0]).toMatchObject({ check: 'covered_spend', status: 'not_run' })
    expect(env.coverage[0].reasons).toContain(SPEND_COVERAGE_REASONS.PERIOD_NOT_COVERED)
  })

  it('rejects malformed queries with a typed error', () => {
    const port = q1Source().financial
    for (const query of [{ from: '2026-02-30' }, { to: '2026/01/01' }, { from: '2026-03-01', to: '2026-02-01' }, { from: 'yesterday' }]) {
      expect(() => spendSummary(ctxA, port, query, NOW)).toThrow(IntelligenceQueryError)
    }
    try {
      spendSummary(ctxA, port, { from: '2026-13-01' }, NOW)
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_query', field: 'from' })
    }
  })

  it('excludes undated rows from a dated view with a reason, and keeps them in an all-time view', () => {
    const port = stubPort([rec('a', {}), rec('b', { paymentDate: null, amountMinor: 2550 }), rec('c', { paymentDate: '2026-01-20', amountMinor: 1 })], [STUB_IMPORT])
    const dated = spendSummary(ctxA, port, { from: '2026-01-01', to: '2026-01-31' }, NOW)
    expect(dated.result!.gross).toEqual([{ currency: 'USD', amountMinor: 10001 }])
    expect(dated.exclusions).toEqual([expect.objectContaining({ code: 'missing_payment_date', count: 1, amounts: [{ currency: 'USD', amountMinor: 2550 }] })])
    expect(dated.coverage[0].reasons).toContain(COVERAGE_REASONS.MISSING_DATES)
    const allTime = spendSummary(ctxA, port, null, NOW)
    expect(allTime.result!.gross).toEqual([{ currency: 'USD', amountMinor: 12551 }])
    const trend = spendTrend(ctxA, port, null, NOW)
    expect(trend.exclusions.map((e) => e.code)).toEqual(['missing_payment_date'])
    expect(trend.coverage[0].reasons).toContain(COVERAGE_REASONS.MISSING_DATES)
  })

  it('excludes reversals, voids and zero rows with codes, and never nets refunds', () => {
    const port = stubPort([
      rec('pay', { amountMinor: 50000 }),
      rec('reversal', { kind: 'unknown', amountMinor: -50000 }),
      rec('void', { kind: 'unknown', amountMinor: 12345 }),
      rec('zero', { kind: 'unknown', amountMinor: 0 }),
      rec('credit', { kind: 'credit', amountMinor: -2500 }),
    ], [STUB_IMPORT])
    const env = spendSummary(ctxA, port, null, NOW)
    expect(env.result!.gross).toEqual([{ currency: 'USD', amountMinor: 50000 }])
    expect(env.result!.recordedRefundsAndCredits).toEqual([{ currency: 'USD', amountMinor: 2500 }])
    expect(env.result!.net).toBeNull()
    expect(env.exclusions).toEqual([
      { code: 'unclassified_transaction', count: 2, amounts: [{ currency: 'USD', amountMinor: -50000 + 12345 }], detail: expect.any(String) },
      { code: 'zero_amount', count: 1, amounts: [{ currency: 'USD', amountMinor: 0 }], detail: expect.any(String) },
    ])
    expect(env.origin).toBe('fixture')
    expect(env.coverage[0].reasons).toEqual([COVERAGE_REASONS.SETTLEMENT_UNVERIFIED])
  })

  it('handles a partial import end to end: rejected rows, a zero row and an untyped negative row', () => {
    const audit = auditFromCsv('partial', [
      'Fixture X,X-1,2026-01-05,,100.00,100.00,net 30,1,Ops,USD,', // no payment date: rejected by the parser
      'Fixture X,X-2,2026-01-05,2026-01-07,abc,abc,net 30,1,Ops,USD,', // unreadable amount: rejected
      'Fixture X,X-3,2026-01-05,2026-01-08,0,0,net 30,1,Ops,USD,',
      'Fixture X,X-4,2026-01-05,2026-01-09,-20,-20,net 30,1,Ops,USD,', // a reversal without a type
      'Fixture X,X-5,2026-01-05,2026-01-10,123.45,123.45,net 30,1,Ops,USD,',
    ])
    const port = createLegacyAuditSource('tenant_a', [audit]).financial
    const env = spendSummary(ctxA, port, null, NOW)
    expect(env.result!.gross).toEqual([{ currency: 'USD', amountMinor: 12345 }])
    expect(env.exclusions.map((e) => [e.code, e.count, e.amounts])).toEqual([
      ['unclassified_transaction', 1, [{ currency: 'USD', amountMinor: -2000 }]],
      ['zero_amount', 1, [{ currency: 'USD', amountMinor: 0 }]],
    ])
    expect(env.coverage[0].reasons).toContain(COVERAGE_REASONS.REJECTED_ROWS)
    const imports = importCoverageSummary(ctxA, port, NOW).result!
    expect([imports.acceptedRows, imports.rejectedRows]).toEqual([3, 2])
  })

  it('keeps an unknown currency as its own bucket with a coverage reason', () => {
    const port = stubPort([rec('a', {}), rec('b', { currency: 'UNKNOWN', amountMinor: 777 })], [STUB_IMPORT])
    const env = spendSummary(ctxA, port, null, NOW)
    expect(env.result!.gross).toEqual([{ currency: 'UNKNOWN', amountMinor: 777 }, { currency: 'USD', amountMinor: 10000 }])
    expect(env.coverage[0].reasons).toEqual(expect.arrayContaining([COVERAGE_REASONS.MISSING_CURRENCY, COVERAGE_REASONS.MIXED_CURRENCY]))
  })

  it('uses the calendar date in the raw cell, not the stored instant, at a month boundary', () => {
    let audit = auditFromCsv('tz', [
      'Fixture TZ Vendor,TZ-1,2026-01-31,2026-01-31,100.00,100.00,net 30,5555,Ops,USD,',
      'Fixture TZ Vendor,TZ-2,2026-02-01,2026-02-01,200.00,200.00,net 30,5555,Ops,USD,',
    ])
    // Stored instants land on the other side of the month boundary; the raw cells must win.
    audit = withPaymentDate(audit, 'TZ-1', '2026-02-01T12:00:00.000Z', '2026-01-31')
    audit = withPaymentDate(audit, 'TZ-2', '2026-01-31T12:00:00.000Z', '2026-02-01')
    const port = createLegacyAuditSource('tenant_a', [audit]).financial
    expect(spendSummary(ctxA, port, { from: '2026-01-01', to: '2026-01-31' }, NOW).result!.gross).toEqual([{ currency: 'USD', amountMinor: 10000 }])
    expect(spendSummary(ctxA, port, { from: '2026-02-01', to: '2026-02-28' }, NOW).result!.gross).toEqual([{ currency: 'USD', amountMinor: 20000 }])
    const trend = spendTrend(ctxA, port, null, NOW).result!
    expect(trend.series[0].points.map((p) => [p.month, p.grossPaymentsMinor])).toEqual([['2026-01', 10000], ['2026-02', 20000]])
    expect(spendSummary(ctxA, port, null, NOW).warnings.map((w) => w.code)).not.toContain('calendar_date_from_instant')
  })

  it('warns when a calendar date had to be read from a stored instant', () => {
    let audit = auditFromCsv('tz2', ['Fixture TZ Vendor,TZ-3,2026-01-15,2026-01-15,100.00,100.00,net 30,5555,Ops,USD,'])
    audit = withPaymentDate(audit, 'TZ-3', '2026-01-15T12:00:00.000Z', null)
    const env = spendSummary(ctxA, createLegacyAuditSource('tenant_a', [audit]).financial, null, NOW)
    expect(env.warnings.map((w) => w.code)).toContain('calendar_date_from_instant')
  })

  it('handles an empty tenant without inventing a zero', () => {
    const port = createLegacyAuditSource('tenant_a', []).financial
    for (const env of [spendSummary(ctxA, port, null, NOW), spendByVendor(ctxA, port, null, NOW), spendByCategory(ctxA, port, null, NOW), spendTrend(ctxA, port, null, NOW), importCoverageSummary(ctxA, port, NOW)]) {
      expect(env.result).toBeNull()
      expect(env.coverage[0].status).toBe('not_run')
      expect(env.coverage[0].reasons).toContain(COVERAGE_REASONS.NO_DATA)
      expect(env.freshness.stale).toBe(false)
    }
  })

  it('refuses another tenant and a missing permission', () => {
    const port = q1Source().financial
    const ctxB = fixtureContext('tenant_b')
    const noFinancial = fixtureContext('tenant_a', ['cases:read'])
    const calls = [
      (ctx: typeof ctxA) => spendSummary(ctx, port, null, NOW),
      (ctx: typeof ctxA) => spendByVendor(ctx, port, null, NOW),
      (ctx: typeof ctxA) => spendByCategory(ctx, port, null, NOW),
      (ctx: typeof ctxA) => spendTrend(ctx, port, null, NOW),
      (ctx: typeof ctxA) => importCoverageSummary(ctx, port, NOW),
    ]
    for (const call of calls) {
      expect(() => call(ctxB)).toThrow(IntelligenceAccessError)
      try { call(ctxB) } catch (e) { expect((e as IntelligenceAccessError).code).toBe('tenant_mismatch') }
      try { call(noFinancial) } catch (e) { expect((e as IntelligenceAccessError).code).toBe('forbidden') }
      expect(() => call(noFinancial)).toThrow(IntelligenceAccessError)
    }
  })

  it('marks data stale when the newest import is more than 35 days old', () => {
    const audit = withImportedAt(auditFromCsv('audit_a_q1', TENANT_A_Q1), Q1_UPDATED)
    const port = createLegacyAuditSource('tenant_a', [audit]).financial
    const stale = spendSummary(ctxA, port, null, NOW)
    expect(stale.freshness).toMatchObject({ computedAt: NOW, sourceUpdatedAt: Q1_UPDATED, stale: true })
    expect(stale.freshness.staleReason).toMatch(/35 days/)
    const fresh = spendSummary(ctxA, port, null, Q1_UPDATED + 10 * 86_400_000)
    expect(fresh.freshness.stale).toBe(false)
    expect(spendSummary(ctxA, port, null, NOW, { sourceUpdatedAt: NOW - 86_400_000 }).freshness.stale).toBe(false)
  })

  it('passes caller-known coverage limits through (e.g. unreadable audits)', () => {
    const source = createLegacyAuditSource('tenant_a', [{ id: 'broken', environment: null }, ...tenantAAudits()])
    expect(source.unreadableAuditIds).toEqual(['broken'])
    const env = spendSummary(ctxA, source.financial, null, NOW, { extraCoverageReasons: ['unreadable_audits'] })
    expect(env.coverage[0].reasons).toContain('unreadable_audits')
  })

  it('is deterministic for the same inputs and now', () => {
    const source = combinedSource()
    expect(spendSummary(ctxA, source.financial, null, NOW)).toEqual(spendSummary(ctxA, source.financial, null, NOW))
    expect(spendByVendor(ctxA, source.financial, null, NOW)).toEqual(spendByVendor(ctxA, source.financial, null, NOW))
    expect(spendTrend(ctxA, source.financial, null, NOW)).toEqual(spendTrend(ctxA, source.financial, null, NOW))
  })
})

describe('spendByVendor', () => {
  it('orders rows by currency, gross descending, vendor key, with exact shares within each currency', () => {
    const env = spendByVendor(ctxA, combinedSource().financial, null, NOW)
    const rows = env.result!.rows
    expect(rows.map((r) => [r.currency, r.displayName, r.grossPaymentsMinor, r.paymentCount, r.shareOfCurrencyBps])).toEqual([
      ['EUR', 'Fixture Euro Parts GmbH', 90000, 1, 10000],
      // 2,400,000 / 3,754,675 = 63.92%; 1,294,675 / 3,754,675 = 34.48%; 60,000 / 3,754,675 = 1.60%
      ['USD', 'Fixture Property Mgmt', 2400000, 6, 6392],
      ['USD', 'Fixture Coffee Co', 1294675, 7, 3448],
      ['USD', 'Fixture Office Supply', 60000, 2, 160],
    ])
    expect(rows.find((r) => r.displayName === 'Fixture Office Supply')).toMatchObject({ recordedRefundsAndCreditsMinor: 5000, refundAndCreditCount: 1, sourceRecordCount: 3 })
    expect(env.result!.currencyTotals).toEqual([{ currency: 'EUR', amountMinor: 90000 }, { currency: 'USD', amountMinor: 3754675 }])
    expect(env.result!.totalRows).toBe(4)
    expect(env.result!.nextCursor).toBeNull()
  })

  it('pages with a bounded limit and a validated opaque cursor', () => {
    const port = combinedSource().financial
    const first = spendByVendor(ctxA, port, null, NOW, { limit: 3 }).result!
    expect(first.rows).toHaveLength(3)
    expect(first.nextCursor).toBe('3')
    const second = spendByVendor(ctxA, port, null, NOW, { limit: 3, cursor: first.nextCursor }).result!
    expect(second.rows.map((r) => r.displayName)).toEqual(['Fixture Office Supply'])
    expect(second.nextCursor).toBeNull()
    for (const page of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: 'abc' }, { cursor: '-1' }, { cursor: '99' }, { cursor: '01' }]) {
      expect(() => spendByVendor(ctxA, port, null, NOW, page)).toThrow(IntelligenceQueryError)
    }
  })

  it('names a vendor key by its most frequent recorded name, ties alphabetical', () => {
    const port = stubPort([
      rec('1', { vendorName: 'acme ltd', vendor: { displayName: 'acme ltd', vendorKey: 'vk_acme', stableSupplierId: null, aliasSuggestion: null } }),
      rec('2', { vendor: { displayName: 'ACME Ltd', vendorKey: 'vk_acme', stableSupplierId: null, aliasSuggestion: null } }),
      rec('3', { vendor: { displayName: 'ACME Ltd', vendorKey: 'vk_acme', stableSupplierId: null, aliasSuggestion: null } }),
      rec('4', { vendor: { displayName: 'Zed', vendorKey: 'vk_zed', stableSupplierId: null, aliasSuggestion: null } }),
      rec('5', { vendor: { displayName: 'Beta', vendorKey: 'vk_zed', stableSupplierId: null, aliasSuggestion: null } }),
    ], [STUB_IMPORT])
    const rows = spendByVendor(ctxA, port, null, NOW).result!.rows
    expect(rows.map((r) => [r.vendorKey, r.displayName])).toEqual([['vk_acme', 'ACME Ltd'], ['vk_zed', 'Beta']])
  })
})

describe('spendByCategory', () => {
  it('buckets missing categories as Uncategorized and flags coverage', () => {
    const env = spendByCategory(ctxA, q1Source().financial, null, NOW)
    expect(env.result!.rows.map((r) => [r.currency, r.displayName, r.uncategorized, r.grossPaymentsMinor, r.recordedRefundsAndCreditsMinor, r.shareOfCurrencyBps])).toEqual([
      ['EUR', 'Parts', false, 90000, 0, 10000],
      ['USD', 'Rent', false, 1200000, 0, 6677],
      ['USD', 'COGS', false, 537100, 0, 2989],
      ['USD', 'Uncategorized', true, 60000, 5000, 334],
    ])
    expect(env.coverage.find((c) => c.check === 'category')).toEqual({ check: 'category', status: 'limited', reasons: [COVERAGE_REASONS.MISSING_CATEGORY] })
  })

  it('groups categories case-insensitively, keeps the recorded spelling, and infers nothing', () => {
    const port = stubPort([rec('1', { category: 'Cogs' }), rec('2', { category: ' COGS ' }), rec('3', { category: 'COGS' }), rec('4', { category: 'Ops' })], [STUB_IMPORT])
    const env = spendByCategory(ctxA, port, null, NOW)
    expect(env.result!.rows.map((r) => [r.categoryKey, r.displayName, r.paymentCount])).toEqual([['cogs', 'COGS', 3], ['ops', 'Ops', 1]])
    expect(env.coverage.find((c) => c.check === 'category')!.status).toBe('supported')
  })
})

describe('spendTrend', () => {
  it('builds per-currency monthly series for the combined tenant A audits', () => {
    const env = spendTrend(ctxA, combinedSource().financial, null, NOW)
    const result = env.result!
    expect(result.months.map((m) => [m.month, m.covered])).toEqual([['2026-01', true], ['2026-02', true], ['2026-03', true], ['2026-04', true], ['2026-05', true], ['2026-06', true]])
    const usd = result.series.find((s) => s.currency === 'USD')!
    // Jan 4000+1200+310.40; Feb 4000+1350.50+1410.25+289.60; Mar 4000+1410.25; Apr 4000+1300; May 4000+4980; Jun 4000+1295.75
    expect(usd.points.map((p) => p.grossPaymentsMinor)).toEqual([551040, 705035, 541025, 530000, 898000, 529575])
    expect(usd.points.reduce((sum, p) => sum + p.grossPaymentsMinor!, 0)).toBe(3754675)
    expect(usd.points[2].recordedRefundsAndCreditsMinor).toBe(5000)
    const eur = result.series.find((s) => s.currency === 'EUR')!
    expect(eur.points.map((p) => p.grossPaymentsMinor)).toEqual([0, 0, 90000, 0, 0, 0])
  })

  it('marks months no import covers as not covered (null), not as zero spend', () => {
    const jan = auditFromCsv('jan', ['Fixture Gap Co,G-1,2026-01-05,2026-01-10,100.00,100.00,net 30,6666,Ops,USD,'])
    const apr = auditFromCsv('apr', ['Fixture Gap Co,G-2,2026-04-05,2026-04-10,250.00,250.00,net 30,6666,Ops,USD,'])
    const port = createLegacyAuditSource('tenant_a', [jan, apr]).financial
    const env = spendTrend(ctxA, port, null, NOW)
    expect(env.result!.series[0].points.map((p) => [p.month, p.covered, p.grossPaymentsMinor, p.paymentCount])).toEqual([
      ['2026-01', true, 10000, 1],
      ['2026-02', false, null, null],
      ['2026-03', false, null, null],
      ['2026-04', true, 25000, 1],
    ])
    expect(env.coverage[0].reasons).toContain(SPEND_COVERAGE_REASONS.PERIOD_PARTIALLY_COVERED)
    // An explicit range extends the axis; the extra months are not covered.
    const ranged = spendTrend(ctxA, port, { from: '2026-01-01', to: '2026-05-31' }, NOW).result!
    expect(ranged.months.map((m) => m.covered)).toEqual([true, false, false, true, false])
  })

  it('refuses unsupported granularity and over-long ranges', () => {
    const port = q1Source().financial
    expect(() => spendTrend(ctxA, port, null, NOW, { granularity: 'week' as 'month' })).toThrow(IntelligenceQueryError)
    expect(() => spendTrend(ctxA, port, { from: '2000-01-01', to: '2026-12-31' }, NOW)).toThrow(IntelligenceQueryError)
  })
})

describe('importCoverageSummary', () => {
  it('summarises imports, date spans, gaps, overlap and freshness', () => {
    const audits = tenantAAudits().map((a, i) => withImportedAt(a, i === 0 ? Date.UTC(2026, 2, 31) : Date.UTC(2026, 5, 30)))
    const env = importCoverageSummary(ctxA, createLegacyAuditSource('tenant_a', audits).financial, NOW)
    const result = env.result!
    expect(result.importCount).toBe(2)
    expect(result.acceptedRows).toBe(TENANT_A_Q1.length + 9)
    expect(result.rejectedRows).toBe(0)
    expect(result.systems).toEqual(['csv'])
    expect(result.coveredDateRange).toEqual({ from: '2026-01-01', to: '2026-06-09' })
    // Q1 covers 01-01..03-10 and Q2 03-01..06-09 (its repeated March rows count toward its period).
    expect(result.coveredSpans).toEqual([{ from: '2026-01-01', to: '2026-06-09' }])
    expect(result.gaps).toEqual([])
    expect(result.crossAuditOverlapRows).toBe(3)
    expect(result.newestImportAt).toBe(Date.UTC(2026, 5, 30))
    expect(env.freshness.stale).toBe(false)
    expect(env.coverage[0].reasons).toContain(COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE)
    expect(env.coverage[0].reasons).not.toContain(SPEND_COVERAGE_REASONS.PERIOD_PARTIALLY_COVERED)
  })

  it('reports rejected rows as a coverage limit', () => {
    const port = stubPort([rec('a', {})], [{ ...STUB_IMPORT, rejectedRows: 2 }])
    expect(importCoverageSummary(ctxA, port, NOW).coverage[0].reasons).toContain(COVERAGE_REASONS.REJECTED_ROWS)
    expect(spendSummary(ctxA, port, null, NOW).coverage[0].reasons).toContain(COVERAGE_REASONS.REJECTED_ROWS)
  })
})

describe('shareBps', () => {
  it('rounds half up with exact integer arithmetic', () => {
    expect(shareBps(1, 3)).toBe(3333)
    expect(shareBps(2, 3)).toBe(6667)
    expect(shareBps(1, 20000)).toBe(1) // exactly 0.5 bp rounds up
    expect(shareBps(0, 10)).toBe(0)
    expect(shareBps(5, 0)).toBe(0)
    expect(shareBps(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)).toBe(10000)
  })
})
