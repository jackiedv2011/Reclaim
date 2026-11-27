/**
 * Example read-model responses for design work (docs/product-intelligence/fixtures).
 * SYNTHETIC: fictional tenants from fixtures/synthetic.ts, frozen clock.
 *
 *   UPDATE_DESIGN_FIXTURES=1 npx vitest run src/intelligence/designFixtures.test.ts
 *
 * Without the variable the test fails when a response no longer matches its
 * file, so the design fixtures cannot silently drift from the contracts.
 */
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EMPTY_CASE_STATE } from '@/ledger/caseState'
import { approveRecovery, recordVendorUpdate, startRecoveryRequest, verifyRecovery } from '@/recovery/model'
import { createLegacyAuditSource } from './adapters/legacyAudit.ts'
import { NO_RETURN_MATCHING } from './contracts.ts'
import { auditFromCsv, findingsOf, fixtureContext, TENANT_A_Q1, TENANT_A_Q2_OVERLAP, withCaseState } from './fixtures/synthetic.ts'
import { attentionQueue } from './attention.ts'
import { importCoverageSummary, spendByCategory, spendByVendor, spendSummary, spendTrend } from './spend.ts'
import { recoveryOverview } from './recoveryVisibility.ts'
import { vendorProfiles } from './vendorProfiles.ts'
import { InMemoryFeedbackStore } from './memory.ts'
import { uiStateOf } from './viewModels.ts'
import { generateInsightsSync, InMemoryInsightStateStore, insightLookup } from './insights.ts'
import { askAccount } from './assistant.ts'

const NOW = Date.UTC(2026, 6, 1, 12)
const DIR = join(process.cwd(), 'docs/product-intelligence/fixtures')
const ctx = fixtureContext('tenant_fixture_a')

// At module scope: the cases below are built while the file is collected, before any hook runs.
vi.useFakeTimers()
vi.setSystemTime(NOW)
afterAll(() => {
  vi.useRealTimers()
})

function tenant() {
  const q1 = auditFromCsv('audit_fixture_q1', TENANT_A_Q1, { updatedAt: Date.UTC(2026, 2, 31) })
  const q2 = auditFromCsv('audit_fixture_q2', TENANT_A_Q2_OVERLAP, { updatedAt: Date.UTC(2026, 5, 30) })
  const dup = findingsOf(q1).find((f) => f.type === 'exact_duplicate')!
  let state = approveRecovery({ ...EMPTY_CASE_STATE, decision: 'confirmed', decidedAt: Date.UTC(2026, 3, 2), recoveryStage: 'confirmed' }, { at: Date.UTC(2026, 3, 3), knownBeforeReclaim: false })
  state = startRecoveryRequest(state, 1410.25, Date.UTC(2026, 3, 6))
  state = recordVendorUpdate(state, { at: Date.UTC(2026, 3, 20), status: 'promised', note: 'Fixture: supplier promised a refund', amount: 1410.25, expectedAt: Date.UTC(2026, 4, 15) }, NOW)
  state = verifyRecovery(state, { amount: 500, method: 'refund', source: 'bank', reference: 'FIXTURE-REF-001', settledAt: Date.UTC(2026, 4, 2) })
  return createLegacyAuditSource(ctx.tenantId, [withCaseState(q1, dup.id, state), q2])
}

function responses() {
  const source = tenant()
  const memory = new InMemoryFeedbackStore()
  const summary = spendSummary(ctx, source.financial, null, NOW)
  return {
    'spend-summary': { response: summary, uiState: uiStateOf(summary, (r) => r.gross.length === 0) },
    'spend-summary-uncovered-period': { response: spendSummary(ctx, source.financial, { from: '2025-01-01', to: '2025-12-31' }, NOW) },
    'spend-by-vendor': { response: spendByVendor(ctx, source.financial, null, NOW, { limit: 5 }) },
    'spend-by-category': { response: spendByCategory(ctx, source.financial, null, NOW) },
    'spend-trend': { response: spendTrend(ctx, source.financial, { from: '2026-01-01', to: '2026-08-31' }, NOW) },
    'import-coverage': { response: importCoverageSummary(ctx, source.financial, NOW) },
    'recovery-overview': { response: recoveryOverview(ctx, source.cases, NO_RETURN_MATCHING, NOW) },
    'attention-queue': { response: attentionQueue(ctx, source.cases, NOW) },
    'vendor-profiles': { response: vendorProfiles(ctx, source.financial, source.cases, memory, NOW, { limit: 3 }) },
    'empty-account': { response: spendSummary(ctx, createLegacyAuditSource(ctx.tenantId, []).financial, null, NOW) },
    'insights': { response: generateInsightsSync(ctx, { financial: source.financial, cases: source.cases, returns: NO_RETURN_MATCHING, memory, insightState: new InMemoryInsightStateStore() }, NOW) },
  }
}

async function assistantResponses() {
  const source = tenant()
  const deps = { financial: source.financial, cases: source.cases, returns: NO_RETURN_MATCHING, memory: new InMemoryFeedbackStore(), insightState: new InMemoryInsightStateStore() }
  const ask = (question: string) => askAccount(ctx, { ...deps, insightLookup: insightLookup(deps, NOW) }, question, NOW)
  return {
    'assistant-recovery-status': { question: 'What is my recovery status?', response: await ask('What is my recovery status?') },
    'assistant-action-request': { question: 'Email the vendor and get the duplicate refunded', response: await ask('Email the vendor and get the duplicate refunded') },
  }
}

const update = process.env.UPDATE_DESIGN_FIXTURES === '1'
function check(name: string, body: object) {
  const text = `${JSON.stringify({ _note: 'SYNTHETIC FIXTURE: fictional data for design work. Not customer data.', ...body }, null, 2)}\n`
  const file = join(DIR, `${name}.json`)
  if (update) {
    mkdirSync(DIR, { recursive: true })
    writeFileSync(file, text)
  }
  expect(existsSync(file), `${file} missing: run with UPDATE_DESIGN_FIXTURES=1`).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe(text)
}

describe('design fixtures', () => {
  for (const [name, body] of Object.entries(responses())) it(`${name}.json matches the current read model`, () => check(name, body))
  it('assistant answers match their fixture files', async () => {
    for (const [name, body] of Object.entries(await assistantResponses())) check(name, body)
  })
})
