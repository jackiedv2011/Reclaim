import { describe, expect, it } from 'vitest'
import { COVERAGE_REASONS, INTELLIGENCE_CONTRACT_VERSION, type ReadModelEnvelope } from './contracts.ts'
import { copyFor, DRAFT_COVERAGE_COPY, DRAFT_RECOVERY_LABELS, FALLBACK_COVERAGE_COPY, formatMinor, moneyViews, uiStateOf } from './viewModels.ts'
import { spendSummary } from './spend.ts'
import { createLegacyAuditSource } from './adapters/legacyAudit.ts'
import { fixtureContext, tenantAAudits } from './fixtures/synthetic.ts'
import { RECOVERY_DEFINITIONS } from './recoveryVisibility.ts'

const NOW = Date.UTC(2026, 6, 1)
const ctx = fixtureContext('tenant_a')

function env<T>(partial: Partial<ReadModelEnvelope<T>>): ReadModelEnvelope<T> {
  return {
    model: 'm', contractVersion: INTELLIGENCE_CONTRACT_VERSION, metricDefinitionVersion: 'v', tenantId: 't', origin: 'fixture',
    scope: { from: null, to: null, dateBasis: 'none', currencies: [] },
    freshness: { computedAt: NOW, sourceUpdatedAt: NOW, stale: false, staleReason: null },
    coverage: [], sources: [], exclusions: [], warnings: [], result: null, ...partial,
  }
}

describe('uiStateOf', () => {
  it('orders not_covered > stale > partial > empty > ready', () => {
    const items = (r: { items: number[] }) => r.items.length === 0
    expect(uiStateOf(env<{ items: number[] }>({ result: null }), items).state).toBe('not_covered')
    expect(uiStateOf(env({ result: { items: [1] }, coverage: [{ check: 'c', status: 'not_run', reasons: ['no_data'] }] }), items).state).toBe('not_covered')
    expect(uiStateOf(env({ result: { items: [1] }, freshness: { computedAt: NOW, sourceUpdatedAt: 0, stale: true, staleReason: 'old' }, coverage: [{ check: 'c', status: 'limited', reasons: ['missing_dates'] }] }), items).state).toBe('stale')
    expect(uiStateOf(env({ result: { items: [] }, coverage: [{ check: 'c', status: 'limited', reasons: ['missing_dates'] }] }), items).state).toBe('partial')
    expect(uiStateOf(env({ result: { items: [] } }), items).state).toBe('empty')
    expect(uiStateOf(env({ result: { items: [1] } }), items).state).toBe('ready')
  })

  it('shows standing notices for customer-supplied snapshots without calling the view partial', () => {
    const view = uiStateOf(env({ result: { items: [1] }, coverage: [{ check: 'c', status: 'limited', reasons: [COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS] }] }), () => false)
    expect(view.state).toBe('ready')
    expect(view.notices.map((n) => n.code)).toEqual([COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS])
  })

  it('never presents a real limited read model as ready-without-notice', () => {
    const summary = spendSummary(ctx, createLegacyAuditSource('tenant_a', tenantAAudits()).financial, null, NOW)
    const view = uiStateOf(summary, (r) => r.gross.length === 0)
    expect(view.state).toBe('partial') // mixed currency, missing categories, cross-audit overlap
    expect(view.notices.length).toBeGreaterThan(0)
  })
})

describe('money and copy', () => {
  it('formats integer minor units exactly, per currency, and marks unknown currency', () => {
    expect(formatMinor(375467500, 'USD')).toBe('USD 3,754,675.00')
    expect(formatMinor(-5000, 'USD')).toBe('-USD 50.00')
    expect(formatMinor(7, 'EUR')).toBe('EUR 0.07')
    expect(formatMinor(12345, 'UNKNOWN')).toBe('123.45 (currency unknown)')
    expect(moneyViews([{ currency: 'EUR', amountMinor: 90000 }, { currency: 'USD', amountMinor: 1 }]).map((m) => m.text)).toEqual(['EUR 900.00', 'USD 0.01'])
  })

  it('has draft copy for every registered coverage reason that a customer could see, and a fallback', () => {
    for (const code of ['no_data', 'customer_supplied_source', 'period_not_covered', 'mixed_currency', 'no_independent_return_matching']) expect(DRAFT_COVERAGE_COPY[code]).toBeTruthy()
    expect(copyFor('something_new')).toBe(FALLBACK_COVERAGE_COPY)
  })

  it('keeps one distinct label per recovery figure, never calling a customer-recorded return verified', () => {
    for (const key of Object.keys(DRAFT_RECOVERY_LABELS)) expect(RECOVERY_DEFINITIONS).toHaveProperty(key)
    expect(new Set(Object.values(DRAFT_RECOVERY_LABELS)).size).toBe(6)
    expect(DRAFT_RECOVERY_LABELS.customerRecordedReturns.toLowerCase()).not.toMatch(/verified|matched/)
  })
})
