import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { EMPTY_CASE_STATE, markExpected, markNeedsInfo, updateRecoveryPackage, type CaseState } from '@/ledger/caseState'
import type { LedgerEnvironment } from '@/ledger/store'
import type { Finding } from '@/types'
import {
  approveRecovery, beginNewRequestReview, closeWithoutRecovery, reconcileRecovery, recordVendorUpdate, requiresCustomerAction,
  setContactHold, setNextFollowUp, startRecoveryRequest, verifyRecovery,
} from '@/recovery/model'
import { verifiedReturned } from '@/recovery/financials'
import { OVERDUE_GRACE_DAYS as STATUS_GRACE_DAYS } from '@/recovery/status'
import { attestDuplicate } from '@/recovery/testEvidence'
import { SINGLE_USER_PERMISSIONS, type CaseSnapshot, type Permission, type TenantContext } from './contracts.ts'
import { IntelligenceAccessError } from './envelope.ts'
import { createLegacyAuditSource, type StoredAudit } from './adapters/legacyAudit.ts'
import { auditFromCsv, findingsOf, fixtureContext, tenantAAudits, withCaseState } from './fixtures/synthetic.ts'
import {
  ATTENTION_REASONS, CASE_COMMAND_TYPES, NEXT_ACTION_KIND, OVERDUE_GRACE_DAYS, attentionItemFor, attentionQueue,
  deterministicCommandId, proposeApprovalAction, type AttentionItem,
} from './attention.ts'

// SYNTHETIC FIXTURE: fictional vendors and amounts, local tests only.
const DAY = 86_400_000
const NOW = new Date(2026, 6, 15, 12).getTime() // local noon, a Wednesday
const T0 = NOW - 40 * DAY
const fixtureCtx = fixtureContext('tenant_a')
/** The signed-in owner today: case mutations are implied, as server/caseCommands.ts allows them. */
const ownerCtx: TenantContext = { tenantId: 'tenant_a', actorId: 'tenant_a', permissions: SINGLE_USER_PERMISSIONS, source: 'single_user_session' }

/** One audit holding an exact duplicate payment for each vendor given. */
function dupAudit(id: string, vendors: Array<{ vendor: string; inv: string; amount: string }>): StoredAudit {
  const rows = vendors.flatMap(({ vendor, inv, amount }, i) => [
    `${vendor},${inv},2026-02-0${i + 1},2026-02-1${i},${amount},${amount},net 30,1${i}11,COGS,USD,`,
    `${vendor},${inv},2026-02-0${i + 1},2026-03-1${i},${amount},${amount},net 30,1${i}11,COGS,USD,`,
  ])
  return auditFromCsv(id, rows, { updatedAt: T0 })
}

function findingFor(audit: StoredAudit, vendor: string): string {
  const f = findingsOf(audit).find((x) => x.vendor === vendor && x.type === 'exact_duplicate')
  if (!f) throw new Error(`no duplicate for ${vendor}`)
  return f.id
}

/** Attest the evidence gate for one finding (synthetic attestation via src/recovery/testEvidence.ts). */
function attest(audit: StoredAudit, findingId: string): StoredAudit {
  const env = structuredClone(audit.environment) as LedgerEnvironment
  const records = new Map(env.records.map((r) => [r.id, r]))
  env.result.findings = env.result.findings.map((f) => {
    if (f.id !== findingId) return f
    const revived = { ...f, relatedRecords: f.relatedRecords.map((r) => records.get(r.id)!) } as Finding
    const attested = attestDuplicate(revived)
    return { ...attested, relatedRecords: f.relatedRecords.map((r) => ({ id: r.id })) } as unknown as Finding
  })
  return { ...audit, environment: env }
}

const CONFIRMED: CaseState = { ...EMPTY_CASE_STATE, decision: 'confirmed', decidedAt: T0, recoveryStage: 'confirmed' }
const PACKAGE = { subject: 'Duplicate payment INV-1', body: 'Synthetic request body', recipientEmail: 'ap@vendor.example', requestedResolution: 'refund' as const, requestedAmount: 1410.25 }
const APPROVED = approveRecovery(updateRecoveryPackage(CONFIRMED, PACKAGE), { at: T0 + DAY, knownBeforeReclaim: false })
const REQUESTED = startRecoveryRequest(APPROVED, 1410.25, T0 + 2 * DAY)
const reply = (status: Parameters<typeof recordVendorUpdate>[1]['status'], extra: Partial<Parameters<typeof recordVendorUpdate>[1]> = {}) =>
  recordVendorUpdate(REQUESTED, { at: NOW - 2 * DAY, status, note: 'Synthetic vendor reply', ...extra }, NOW)
const PROOF = { method: 'refund' as const, source: 'bank' as const, reference: 'FIXTURE-REF-1', settledAt: NOW - DAY }
const FULLY_RETURNED = verifyRecovery(REQUESTED, { ...PROOF, amount: 1410.25 })
const HISTORICAL: CaseState = { ...REQUESTED, requiresRevalidation: true }

/** Named states reached through the real model transitions. */
const STATES: Record<string, CaseState> = {
  awaiting_approval: CONFIRMED,
  approved: APPROVED,
  held: setContactHold(CONFIRMED, 'Supplier relationship review'),
  requested_waiting: setNextFollowUp(REQUESTED, NOW + 5 * DAY),
  requested_lapsed: REQUESTED,
  disputed: reply('disputed'),
  partial_acceptance: reply('partial_acceptance', { amount: 500 }),
  needs_documents: reply('needs_documents'),
  promised_future: reply('promised', { amount: 1410.25, expectedAt: NOW + 10 * DAY }),
  promised_past: reply('promised', { amount: 1000, expectedAt: NOW - 1 * DAY }),
  accepted_no_date: reply('accepted'),
  credit_issued: reply('credit_issued'),
  follow_up_due: setNextFollowUp(REQUESTED, NOW - 1 * DAY),
  follow_up_overdue: setNextFollowUp(REQUESTED, NOW - 10 * DAY),
  partially_returned: verifyRecovery(REQUESTED, { ...PROOF, amount: 400 }),
  fully_returned: FULLY_RETURNED,
  reconciled: reconcileRecovery(FULLY_RETURNED, { note: 'Booked to AP clearing', rootCause: 'Duplicate import', at: NOW }),
  historical: HISTORICAL,
  new_request_review: beginNewRequestReview(HISTORICAL, NOW - DAY),
  closed: closeWithoutRecovery(REQUESTED, 'Vendor will not pay', NOW - DAY),
  needs_info: markNeedsInfo('Need the bank statement'),
  dismissed: markExpected('Deposit', 'intentional'),
}

function queueFor(audits: StoredAudit[], revisions: Record<string, number | null> = {}, ctx: TenantContext = fixtureCtx, now = NOW, options = {}) {
  const source = createLegacyAuditSource('tenant_a', audits, { revisions })
  return { env: attentionQueue(ctx, source.cases, now, options), source }
}

function singleCase(state: CaseState | null, opts: { attested?: boolean; revision?: number | null } = {}) {
  let audit = dupAudit('audit_one', [{ vendor: 'Fixture Coffee Co', inv: 'INV-1', amount: '1410.25' }])
  const id = findingFor(audit, 'Fixture Coffee Co')
  if (opts.attested !== false) audit = attest(audit, id)
  if (state) audit = withCaseState(audit, id, state)
  const { env, source } = queueFor([audit], { audit_one: opts.revision === undefined ? 7 : opts.revision })
  return { env, source, audit, id, items: env.result!.items }
}

describe('attention queue: kinds and categories from real case transitions', () => {
  const expected: Record<string, { kind: AttentionItem['kind'] | null; category?: AttentionItem['category']; amount?: [string, number | null] }> = {
    awaiting_approval: { kind: 'outbound_approval', category: 'requires_approval', amount: ['supported_potential', 141025] },
    approved: { kind: 'ready_to_send', category: 'requires_action', amount: ['approved_request', 141025] },
    held: { kind: 'contact_on_hold', category: 'requires_action', amount: ['supported_potential', 141025] },
    requested_waiting: { kind: null },
    requested_lapsed: { kind: 'follow_up_overdue', category: 'requires_action', amount: ['outstanding', 141025] },
    disputed: { kind: 'disputed_or_partial', category: 'requires_action', amount: ['outstanding', 141025] },
    partial_acceptance: { kind: 'disputed_or_partial', category: 'requires_action', amount: ['outstanding', 141025] },
    needs_documents: { kind: 'vendor_response_review', category: 'requires_action', amount: ['outstanding', 141025] },
    promised_future: { kind: 'verify_promised_return', category: 'informational', amount: ['promised', 141025] },
    promised_past: { kind: 'verify_promised_return', category: 'requires_action', amount: ['promised', 100000] },
    accepted_no_date: { kind: 'verify_promised_return', category: 'requires_action', amount: ['promised', 141025] },
    credit_issued: { kind: 'verify_promised_return', category: 'requires_action', amount: ['outstanding', 141025] },
    follow_up_due: { kind: 'follow_up_due', category: 'requires_action', amount: ['outstanding', 141025] },
    follow_up_overdue: { kind: 'follow_up_overdue', category: 'requires_action', amount: ['outstanding', 141025] },
    partially_returned: { kind: 'disputed_or_partial', category: 'requires_action', amount: ['outstanding', 101025] },
    fully_returned: { kind: 'record_in_books', category: 'requires_action', amount: ['none', null] },
    reconciled: { kind: null },
    historical: { kind: 'historical_request_review', category: 'requires_action', amount: ['outstanding', 141025] },
    new_request_review: { kind: 'unreviewed_finding', category: 'requires_action', amount: ['supported_potential', 141025] },
    closed: { kind: null },
    needs_info: { kind: 'missing_evidence', category: 'requires_action', amount: ['supported_potential', 141025] },
    dismissed: { kind: null },
  }

  for (const [name, want] of Object.entries(expected)) {
    it(`${name} → ${want.kind ?? 'no item'}`, () => {
      const { items } = singleCase(STATES[name])
      if (want.kind === null) return expect(items).toEqual([])
      expect(items).toHaveLength(1)
      const item = items[0]
      expect(item.kind).toBe(want.kind)
      expect(item.category).toBe(want.category)
      expect([item.amount.kind, item.amount.money?.amountMinor ?? null]).toEqual(want.amount)
      if (item.amount.money) expect(item.amount.money.currency).toBe('USD')
      expect(item.sideEffects).toBe('none_in_this_layer')
      expect(item.tenantId).toBe('tenant_a')
      expect(item.revision).toBe(7)
    })
  }

  it('an approved case is ready to send, never sent or returned', () => {
    const item = singleCase(APPROVED).items[0]
    expect(item.kind).toBe('ready_to_send')
    expect(item.statusLabel).toBe('Ready to send')
    expect(item.stage).toBe('confirmed')
    expect(item.cautions).toContain(ATTENTION_REASONS.SEND_STATE_NOT_IN_SNAPSHOT)
    expect(JSON.stringify(item)).not.toMatch(/Money back|Waiting on vendor|"sent"|recovered/i)
    expect(item.allowedInteractions.find((d) => d.interaction === 'approve')!.executesVia).toBe('not_available')
  })

  it('an unattested confirmed case is an internal review with no amount', () => {
    const item = singleCase(CONFIRMED, { attested: false }).items[0]
    expect(item).toMatchObject({ kind: 'internal_review', category: 'requires_action', amount: { kind: 'none', money: null } })
  })

  it('never shows the flagged exposure as an amount', () => {
    const item = singleCase(null, { attested: false }).items[0]
    expect(item).toMatchObject({ kind: 'unreviewed_finding', amount: { kind: 'none', money: null } })
  })

  it('follow-up due vs overdue uses the same grace rule as status.ts', () => {
    expect(OVERDUE_GRACE_DAYS).toBe(STATUS_GRACE_DAYS)
    const edge = singleCase(setNextFollowUp(REQUESTED, NOW - OVERDUE_GRACE_DAYS * DAY)).items[0]
    expect(edge).toMatchObject({ kind: 'follow_up_due', overdue: false })
    const past = singleCase(setNextFollowUp(REQUESTED, NOW - (OVERDUE_GRACE_DAYS + 1) * DAY)).items[0]
    expect(past).toMatchObject({ kind: 'follow_up_overdue', overdue: true })
  })

  it('reads vendor positions from the case status label', () => {
    expect(singleCase(STATES.disputed).items[0].reasonCode).toBe('disputed')
    expect(singleCase(STATES.needs_documents).items[0].reasonCode).toBe('needs_documents')
    expect(singleCase(STATES.partially_returned).items[0].reasonCode).toBe('partially_returned')
  })
})

describe('attention queue: every case that needs the customer appears as requires_*', () => {
  // Same internal-review test as the adapter (and selectors.recoveries()).
  const internalFor = (state: CaseState, attested: boolean) =>
    !attested && verifiedReturned(state) === 0 && !(state.recoveryStage === 'requested' && state.requestedAmount != null)
  const nows = [NOW, NOW + 3 * DAY, NOW + 30 * DAY]

  for (const attested of [true, false]) {
    for (const [name, state] of Object.entries(STATES)) {
      it(`${attested ? 'attested' : 'unattested'} ${name}`, () => {
        for (const now of nows) {
          let audit = dupAudit('audit_p', [{ vendor: 'Fixture Coffee Co', inv: 'INV-1', amount: '1410.25' }])
          const id = findingFor(audit, 'Fixture Coffee Co')
          if (attested) audit = attest(audit, id)
          audit = withCaseState(audit, id, state)
          const items = queueFor([audit], { audit_p: 1 }, fixtureCtx, now).env.result!.items
          const needs = state.recoveryStage !== null && requiresCustomerAction(state, now, internalFor(state, attested))
          if (needs || state.decision === 'needs_info') {
            expect(items.length, `${name} @${now}`).toBe(1)
            expect(items[0].category).not.toBe('informational')
            expect(items[0].owner.party).toBe('customer')
          }
          for (const item of items) expect(item.kind).not.toBe('unmapped_case_state')
        }
      })
    }
  }
})

describe('attention queue: envelope, coverage, order, dedupe, paging', () => {
  it('returns an honest empty result with no cases', () => {
    const { env } = queueFor([])
    expect(env.result).toMatchObject({ items: [], total: 0, emptyState: 'no_cases', casesConsidered: 0 })
    expect(env.coverage.find((c) => c.check === 'case_state')).toMatchObject({ status: 'limited' })
    expect(env.coverage.find((c) => c.check === 'case_state')!.reasons).toContain('no_data')
    expect(JSON.stringify(env)).not.toMatch(/all clear|no issues|fraud|you are owed|price increase|\bverified\b/i)
  })

  it('labels approvals as derived from case state, not an approval service, and send state as unseen', () => {
    const { env } = singleCase(CONFIRMED)
    const by = Object.fromEntries(env.coverage.map((c) => [c.check, c]))
    expect(by.pending_approvals.status).toBe('limited')
    expect(by.pending_approvals.reasons).toEqual(expect.arrayContaining(['upstream_contract_pending', 'customer_supplied_source', 'snapshot_not_continuous', 'revalidation_not_in_snapshot']))
    expect(by.send_state.reasons).toContain('send_state_not_in_snapshot')
    expect(by.returns.reasons).toContain('no_independent_return_matching')
    expect(env.origin).toBe('legacy_audit_snapshot')
    expect(env.model).toBe('attention_queue')
    expect(env.sources[0].id).toMatch(/^case:audit_one\//)
  })

  it('counts the same check on the same payments in two audits once, preferring the most advanced', () => {
    const [q1, q2] = tenantAAudits()
    const q2dup = findingsOf(q2).find((f) => f.type === 'exact_duplicate')!.id
    const audits = [q1, withCaseState(q2, q2dup, markNeedsInfo('Need statement'))]
    const { env } = queueFor(audits, { audit_a_q1: 3, audit_a_q2: 4 })
    const r = env.result!
    expect(r.casesConsidered).toBe(3)
    expect(r.duplicatesCollapsed).toBe(1)
    const dupItems = r.items.filter((i) => i.findingType === 'exact_duplicate')
    expect(dupItems).toHaveLength(1)
    expect(dupItems[0]).toMatchObject({ kind: 'missing_evidence', auditId: 'audit_a_q2', revision: 4 })
    expect(dupItems[0].alsoInCaseIds).toEqual([`audit_a_q1/${findingsOf(q1)[0].id}`])
    expect(dupItems[0].cautions).toContain('cross_audit_overlap')
    expect(env.exclusions).toEqual([expect.objectContaining({ code: 'cross_audit_overlap', count: 1 })])
    expect(r.counts.byKind.missing_evidence).toBe(1)
    expect(r.counts.byKind.unreviewed_finding).toBe(1) // the amount outlier
    expect(env.coverage.find((c) => c.check === 'case_state')!.reasons).toContain('cross_audit_overlap')
  })

  it('warns when duplicate cases were reviewed differently', () => {
    const [q1, q2] = tenantAAudits()
    const a = withCaseState(q1, findingsOf(q1)[0].id, markExpected('Deposit', 'intentional'))
    const b = withCaseState(q2, findingsOf(q2).find((f) => f.type === 'exact_duplicate')!.id, CONFIRMED)
    const { env } = queueFor([a, b])
    expect(env.warnings.map((w) => w.code)).toContain('cross_audit_divergent_state')
    expect(env.result!.items.filter((i) => i.findingType === 'exact_duplicate')).toHaveLength(1)
  })

  function mixedAudit() {
    const vendors = [
      { vendor: 'Fixture Alpha', inv: 'A-1', amount: '100.00' },
      { vendor: 'Fixture Bravo', inv: 'B-1', amount: '900.00' },
      { vendor: 'Fixture Charlie', inv: 'C-1', amount: '300.00' },
      { vendor: 'Fixture Delta', inv: 'D-1', amount: '250.00' },
      { vendor: 'Fixture Echo', inv: 'E-1', amount: '700.00' },
      { vendor: 'Fixture Foxtrot', inv: 'F-1', amount: '50.00' },
    ]
    let audit = dupAudit('audit_mix', vendors)
    const id = (v: string) => findingFor(audit, v)
    const ids = Object.fromEntries(vendors.map((v) => [v.vendor, id(v.vendor)]))
    for (const v of vendors) audit = attest(audit, ids[v.vendor])
    const pkg = (amount: number) => approveRecovery(updateRecoveryPackage(CONFIRMED, { ...PACKAGE, requestedAmount: amount }), { at: T0 + DAY, knownBeforeReclaim: false })
    const sent = (amount: number) => startRecoveryRequest(pkg(amount), amount, T0 + 2 * DAY)
    audit = withCaseState(audit, ids['Fixture Alpha'], CONFIRMED) // approval, $100
    audit = withCaseState(audit, ids['Fixture Bravo'], CONFIRMED) // approval, $900
    audit = withCaseState(audit, ids['Fixture Charlie'], setNextFollowUp(sent(300), NOW - 10 * DAY)) // overdue
    audit = withCaseState(audit, ids['Fixture Delta'], setNextFollowUp(sent(250), NOW - 1 * DAY)) // due, not overdue
    audit = withCaseState(audit, ids['Fixture Echo'], pkg(700)) // ready to send, no date
    audit = withCaseState(audit, ids['Fixture Foxtrot'], recordVendorUpdate(sent(50), { at: NOW - DAY, status: 'promised', amount: 50, expectedAt: NOW + 5 * DAY, note: 'Synthetic' }, NOW)) // informational
    return audit
  }

  it('orders approvals, then overdue, then due date, then amount, then case id; informational last', () => {
    const { env } = queueFor([mixedAudit()], { audit_mix: 2 })
    const order = env.result!.items.map((i) => `${i.vendor.displayName}:${i.kind}`)
    expect(order).toEqual([
      'Fixture Bravo:outbound_approval',
      'Fixture Alpha:outbound_approval',
      'Fixture Charlie:follow_up_overdue',
      'Fixture Delta:follow_up_due',
      'Fixture Echo:ready_to_send',
      'Fixture Foxtrot:verify_promised_return',
    ])
    expect(env.result!.counts.byCategory).toEqual({ requires_approval: 2, requires_action: 3, informational: 1 })
    expect(env.result!.items.at(-1)!.owner).toEqual({ party: 'vendor', actorId: null, assignment: 'none' })
  })

  it('is deterministic: same inputs and now give identical output', () => {
    const a = queueFor([mixedAudit()], { audit_mix: 2 }).env
    const b = queueFor([mixedAudit()], { audit_mix: 2 }).env
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('pages with a cursor and filters by category without changing counts', () => {
    const first = queueFor([mixedAudit()], { audit_mix: 2 }, fixtureCtx, NOW, { limit: 4 }).env.result!
    expect(first.items).toHaveLength(4)
    expect(first.nextCursor).toBe('o:4')
    const second = queueFor([mixedAudit()], { audit_mix: 2 }, fixtureCtx, NOW, { limit: 4, cursor: first.nextCursor }).env.result!
    expect(second.items).toHaveLength(2)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map((i) => i.id)).size).toBe(6)
    const approvals = queueFor([mixedAudit()], { audit_mix: 2 }, fixtureCtx, NOW, { include: ['requires_approval'] }).env.result!
    expect(approvals.items.map((i) => i.kind)).toEqual(['outbound_approval', 'outbound_approval'])
    expect(approvals.total).toBe(2)
    expect(approvals.counts.byCategory.requires_action).toBe(3)
    const bad = queueFor([mixedAudit()], { audit_mix: 2 }, fixtureCtx, NOW, { cursor: 'nope' }).env
    expect(bad.warnings.map((w) => w.code)).toContain('invalid_cursor')
    expect(bad.result!.items).toHaveLength(6)
  })

  it('refuses another tenant and a context without cases:read', () => {
    const source = createLegacyAuditSource('tenant_a', tenantAAudits())
    expect(() => attentionQueue(fixtureContext('tenant_b'), source.cases, NOW)).toThrow(IntelligenceAccessError)
    const noRead = fixtureContext('tenant_a', ['financial:read'] as Permission[])
    expect(() => attentionQueue(noRead, source.cases, NOW)).toThrow(IntelligenceAccessError)
  })

  it('marks unknown revisions instead of guessing', () => {
    const { env, items } = singleCase(CONFIRMED, { revision: null })
    expect(items[0].id).toMatch(/^outbound_approval:audit_one\/.+:r\?:g[0-9a-f]{8}$/)
    expect(items[0].cautions).toContain('revision_unknown')
    expect(env.coverage.find((c) => c.check === 'case_state')!.reasons).toContain('revision_unknown')
  })
})

describe('interaction descriptors and permissions', () => {
  it('describes every interaction, with existing case-command names where one exists', () => {
    const item = singleCase(CONFIRMED).items[0]
    const by = Object.fromEntries(item.allowedInteractions.map((d) => [d.interaction, d]))
    expect(Object.keys(by).sort()).toEqual(['approve', 'inspect_evidence', 'open_source_case', 'reject', 'request_more_evidence', 'review_exact_package', 'view_case'])
    expect(by.approve).toMatchObject({ executesVia: 'existing_case_command', caseCommand: 'approve', requiredPermission: 'cases:approve', permissionStatus: 'proposedPermission' })
    expect(by.reject).toMatchObject({ executesVia: 'existing_case_command', caseCommand: 'contact_hold' })
    expect(by.request_more_evidence).toMatchObject({ caseCommand: 'decision', fixedInput: { decision: 'needs_info' } })
    expect(by.view_case).toMatchObject({ executesVia: 'read_only', caseCommand: null, enabled: true, requiredPermission: 'cases:read', permissionStatus: 'existing' })
    for (const d of item.allowedInteractions) if (d.caseCommand) expect(CASE_COMMAND_TYPES).toContain(d.caseCommand)
    expect(item.permissionsRequired).toEqual(['cases:approve', 'cases:read', 'cases:write'])
    expect(item.proposedPermissions).toEqual(['cases:approve', 'cases:write'])
  })

  it('disables mutations for a context without the proposed permissions, enables them for the signed-in owner', () => {
    const fixtureItem = singleCase(CONFIRMED).items[0]
    expect(fixtureItem.allowedInteractions.find((d) => d.interaction === 'approve')).toMatchObject({ enabled: false, disabledReason: 'permission_missing' })
    const source = singleCase(CONFIRMED).source
    const ownerItem = attentionQueue(ownerCtx, source.cases, NOW).result!.items[0]
    expect(ownerItem.allowedInteractions.find((d) => d.interaction === 'approve')).toMatchObject({ enabled: true, disabledReason: null })
  })

  it('offers no state-changing interaction once a request is out', () => {
    const item = singleCase(STATES.disputed).items[0]
    for (const name of ['approve', 'reject', 'request_more_evidence', 'review_exact_package'] as const) {
      expect(item.allowedInteractions.find((d) => d.interaction === name)!.executesVia).toBe('not_available')
    }
    expect(item.resolvedBy).toEqual(expect.arrayContaining(['vendor_update', 'settlement', 'close']))
  })
})

describe('proposeApprovalAction: typed proposals only', () => {
  const ownerQueue = (state: CaseState, revision: number | null = 7) => {
    const { source } = singleCase(state, { revision })
    return { item: attentionQueue(ownerCtx, source.cases, NOW).result!.items[0], source }
  }
  const input = { package: { subject: PACKAGE.subject, body: PACKAGE.body, evidenceAttachment: null, recipientEmail: PACKAGE.recipientEmail, recipientConfirmed: true, requestedAmount: 1410.25, method: 'refund' }, knownBeforeReclaim: false, knownBeforeNote: null }

  it('builds an exact, idempotent case-command proposal without executing anything', () => {
    const { item, source } = ownerQueue(CONFIRMED)
    const before = JSON.stringify(source.cases.listCases(ownerCtx, NOW))
    const result = proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 7, input })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const p = result.proposal
    expect(p).toMatchObject({
      kind: 'case_command_proposal', route: '/api/projects/:id/case-commands', path: '/api/projects/audit_one/case-commands', method: 'POST',
      action: 'approve', findingId: item.findingId, expectedRevision: 7, requiresHumanConfirmation: true, exactVersionCheck: true,
      readyToSubmit: true, inputRequired: [], sideEffects: 'none_in_this_layer',
    })
    expect(z.uuid().safeParse(p.commandId).success).toBe(true)
    expect(p.serverRefusals).toEqual(expect.arrayContaining(['revision_conflict', 'command_reused', 'revalidation_required', 'gmail_receipt_pending']))
    const again = proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 7, input })
    expect(again.ok && again.proposal.commandId).toBe(p.commandId)
    const edited = proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 7, input: { ...input, package: { ...input.package, requestedAmount: 1000 } } })
    expect(edited.ok && edited.proposal.commandId).not.toBe(p.commandId)
    expect(JSON.stringify(source.cases.listCases(ownerCtx, NOW))).toBe(before)
  })

  it('lists what the person must still supply', () => {
    const { item } = ownerQueue(CONFIRMED)
    const r = proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 7 })
    expect(r.ok && r.proposal.readyToSubmit).toBe(false)
    expect(r.ok && r.proposal.inputRequired).toEqual(expect.arrayContaining(['package.recipientEmail', 'package.recipientConfirmed', 'knownBeforeReclaim']))
    const more = proposeApprovalAction(ownerCtx, item, 'request_more_evidence', { expectedRevision: 7, input: { reason: 'Need the statement', decision: 'confirmed' } })
    expect(more.ok && more.proposal).toMatchObject({ action: 'decision', input: { decision: 'needs_info', reason: 'Need the statement' }, readyToSubmit: true })
    const reject = proposeApprovalAction(ownerCtx, item, 'reject', { expectedRevision: 7, input: { reason: 'Not now' } })
    expect(reject.ok && reject.proposal.action).toBe('contact_hold')
  })

  it('refuses a stale revision', () => {
    const { item, source } = ownerQueue(CONFIRMED, 7)
    expect(proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 8, input })).toEqual({ ok: false, error: expect.objectContaining({ code: 'stale_revision' }) })
    const moved = { ...source.cases.listCases(ownerCtx, NOW)[0], revision: 9 } satisfies CaseSnapshot
    expect(proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 7, input, current: moved, now: NOW })).toEqual({ ok: false, error: expect.objectContaining({ code: 'stale_revision' }) })
  })

  it('refuses an item that is already resolved', () => {
    const { item } = ownerQueue(CONFIRMED, 7)
    const after = singleCase(APPROVED, { revision: 8 }).source.cases.listCases(ownerCtx, NOW)[0]
    expect(proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 7, input, current: after, now: NOW })).toEqual({ ok: false, error: expect.objectContaining({ code: 'already_resolved' }) })
    expect(proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 7, input, current: null, now: NOW })).toEqual({ ok: false, error: expect.objectContaining({ code: 'already_resolved' }) })
    const same = singleCase(CONFIRMED, { revision: 7 }).source.cases.listCases(ownerCtx, NOW)[0]
    expect(proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 7, input, current: same, now: NOW }).ok).toBe(true)
  })

  it('refuses without the approval permission', () => {
    const fixtureItem = singleCase(CONFIRMED).items[0]
    const r = proposeApprovalAction(fixtureCtx, fixtureItem, 'approve', { expectedRevision: 7, input })
    expect(r).toEqual({ ok: false, error: expect.objectContaining({ code: 'forbidden' }) })
    const granted = fixtureContext('tenant_a', [...SINGLE_USER_PERMISSIONS, 'cases:approve'] as unknown as Permission[])
    expect(proposeApprovalAction(granted, fixtureItem, 'approve', { expectedRevision: 7, input }).ok).toBe(true)
  })

  it('refuses interactions that are not available or only read', () => {
    const ready = ownerQueue(APPROVED).item
    expect(proposeApprovalAction(ownerCtx, ready, 'approve', { expectedRevision: 7, input })).toEqual({ ok: false, error: expect.objectContaining({ code: 'not_available' }) })
    expect(proposeApprovalAction(ownerCtx, ready, 'view_case', { expectedRevision: 7 })).toEqual({ ok: false, error: expect.objectContaining({ code: 'not_available' }) })
    const disputed = ownerQueue(STATES.disputed).item
    expect(proposeApprovalAction(ownerCtx, disputed, 'reject', { expectedRevision: 7 })).toEqual({ ok: false, error: expect.objectContaining({ code: 'not_available' }) })
  })

  it('refuses an unknown revision rather than guessing one', () => {
    const { item } = ownerQueue(CONFIRMED, null)
    expect(proposeApprovalAction(ownerCtx, item, 'approve', { expectedRevision: 0, input })).toEqual({ ok: false, error: expect.objectContaining({ code: 'revision_unknown' }) })
  })

  it('refuses another tenant’s item', () => {
    const { item } = ownerQueue(CONFIRMED)
    const other: TenantContext = { ...ownerCtx, tenantId: 'tenant_b', actorId: 'tenant_b' }
    expect(() => proposeApprovalAction(other, item, 'approve', { expectedRevision: 7, input })).toThrow(IntelligenceAccessError)
    const forged = attentionItemFor(ownerCtx, { ...singleCase(CONFIRMED).source.cases.listCases(ownerCtx, NOW)[0] }, NOW)!
    expect(() => proposeApprovalAction(other, forged, 'approve', { expectedRevision: 7, input })).toThrow(IntelligenceAccessError)
  })

  it('makes RFC-shaped deterministic command ids', () => {
    const id = deterministicCommandId('seed')
    expect(id).toBe(deterministicCommandId('seed'))
    expect(id).not.toBe(deterministicCommandId('seed2'))
    expect(z.uuid().safeParse(id).success).toBe(true)
  })
})

describe('drift guards against the code this layer mirrors', () => {
  it('knows every case-command type the server accepts', () => {
    const source = readFileSync(resolve(process.cwd(), 'server/caseCommands.ts'), 'utf8')
    const enumText = /type: z\.enum\(\[([^\]]+)\]\)/.exec(source)![1]
    const serverTypes = [...enumText.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect([...CASE_COMMAND_TYPES]).toEqual(serverTypes)
  })

  it('maps every next-action label recoveryNextAction can return', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/recovery/model.ts'), 'utf8')
    const body = source.slice(source.indexOf('export function recoveryNextAction'), source.indexOf('export function requiresCustomerAction'))
    const labels = [...body.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
    expect(labels.length).toBeGreaterThan(10)
    for (const label of labels) expect(Object.prototype.hasOwnProperty.call(NEXT_ACTION_KIND, label), label).toBe(true)
  })
})

describe('adapter next-action labels', () => {
  it('maps every label the legacy adapter can emit, so none falls into unmapped_case_state', () => {
    const adapter = readFileSync(resolve(process.cwd(), 'src/intelligence/adapters/legacyAudit.ts'), 'utf8')
    const labels = [...adapter.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
    expect(labels.length).toBeGreaterThanOrEqual(4)
    for (const label of labels) expect(Object.keys(NEXT_ACTION_KIND), label).toContain(label)
  })

  it('treats a confirmed decision with no recovery stage as missing evidence, not an unknown state', () => {
    const audit = auditFromCsv('a_conf', ['Fixture Coffee Co,X-1,2026-01-01,2026-01-10,100.00,100.00,net 30,1,COGS,USD,', 'Fixture Coffee Co,X-1,2026-01-01,2026-01-20,100.00,100.00,net 30,1,COGS,USD,'])
    const dup = findingsOf(audit).find((f) => f.type === 'exact_duplicate')!
    const source = createLegacyAuditSource('tenant_fixture_a', [withCaseState(audit, dup.id, { ...EMPTY_CASE_STATE, decision: 'confirmed', decidedAt: 1 })])
    const items = attentionQueue(fixtureContext(), source.cases, Date.UTC(2026, 6, 1)).result!.items
    expect(items.map((i) => i.kind)).toEqual(['missing_evidence'])
  })
})
