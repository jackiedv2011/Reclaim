/**
 * Account-wide recovery visibility (CPO workstream P1, metric definition `recovery-v0.1`).
 *
 * Reads case snapshots (CaseReadPort) and, when it exists, independent return
 * matching (ReturnMatchPort). Each lifecycle figure is reported on its own,
 * per currency, and nothing adds them together: a flagged amount is not a
 * supported potential, a supported potential is not an approved request, a
 * supplier promise is not money, a customer-recorded return is not an
 * independently matched one.
 *
 * Cases are deduplicated across saved audits by `crossAuditKey` (the same
 * check on the same source payments), keeping the most advanced snapshot.
 * See docs/product-intelligence/metrics.md for every definition and for the
 * places these figures intentionally differ from src/workspace/selectors.ts.
 *
 * Read-only: never changes case state or financial records. Server-safe.
 */
import {
  COVERAGE_REASONS,
  UNKNOWN_CURRENCY,
  type CaseReadPort,
  type CaseSnapshot,
  type CaseStageView,
  type CurrencyCode,
  type Exclusion,
  type ReadModelEnvelope,
  type ReturnMatch,
  type ReturnMatchPort,
  type SourceRef,
  type TenantContext,
  type Warning,
} from './contracts.ts'
import { coverage, envelope, requirePermission } from './envelope.ts'
import { compareText, mostFrequent, nextCursorOf, pageBounds, type PageRequest } from './spend.ts'

export const RECOVERY_METRIC_VERSION = 'recovery-v0.1'

/** Reason codes this module adds to COVERAGE_REASONS. */
export const RECOVERY_COVERAGE_REASONS = {
  /** The evidence gate supports USD only; open cases in other currencies can never show a supported potential yet. */
  GATE_CURRENCY_UNSUPPORTED: 'gate_currency_unsupported',
  /**
   * A request has both a supplier promise and a customer-recorded return, and a
   * snapshot does not say which came first, so `promised` (capped at the
   * outstanding balance) may still include money that has since been recorded.
   */
  PROMISE_RETURN_ORDER_UNKNOWN: 'promise_return_order_unknown',
} as const

export const RECOVERY_WARNING_CODES = {
  CASES_FOLDED: 'cross_audit_cases_folded',
  FOLDED_STATES_DIFFER: 'cross_audit_case_states_differ',
  MATCH_UNKNOWN_CASE: 'return_match_unknown_case',
} as const

/**
 * Rank used to keep one snapshot per crossAuditKey. Higher wins.
 * - recovered: a return was recorded and the request closed.
 * - requested: an open supplier request; outranks a closure seen in another copy so
 *   recorded partial returns and outstanding balances are never hidden.
 * - not_recovered: the request was closed without a recorded return.
 * - confirmed: the customer decided to pursue it.
 * - dismissed: a human decided it is expected; outranks only undecided copies.
 * - needs_info, unreviewed: no decision yet.
 * Ties go to the lowest caseId (ordinal comparison).
 */
export const STAGE_RANK: Record<CaseStageView, number> = {
  recovered: 7,
  requested: 6,
  not_recovered: 5,
  confirmed: 4,
  dismissed: 3,
  needs_info: 2,
  unreviewed: 1,
}

/** Finding types the selectors classify as preventive security or future savings, never "flagged for review". */
const NOT_FLAGGED_FOR_REVIEW_TYPES: ReadonlySet<string> = new Set(['bank_account_change', 'unclaimed_discount', 'missed_discount'])

const CLOSED_STAGES: ReadonlySet<CaseStageView> = new Set(['dismissed', 'recovered', 'not_recovered'])

export type RecoveryFigure = 'flaggedForReview' | 'supportedPotential' | 'approvedOutstanding' | 'promised' | 'customerRecordedReturns' | 'matchedReturns'

/** Plain-language one-sentence definitions. These strings are intended for the UI. */
export const RECOVERY_DEFINITIONS: Record<RecoveryFigure | 'partialReturns' | 'closedWithoutRecovery' | 'needingCustomerAction', string> = {
  flaggedForReview: 'Open checks in the covered records that have not passed the evidence review; the amount is what the check flagged, not money a supplier owes.',
  supportedPotential: 'For open cases whose evidence review passed, the supported amount minus any returns you recorded; the most a request could ask for, not a forecast.',
  approvedOutstanding: 'For supplier requests you approved that are still open, the approved amount not yet covered by a return you recorded.',
  promised: 'The latest amount a supplier said it would return on an open request, capped at what is still outstanding; a statement, not money received.',
  customerRecordedReturns: 'Refunds and applied credits you recorded with a reference; they have not been matched to a bank or accounting record.',
  matchedReturns: 'Returns independently matched to a bank or accounting record; not available yet, so shown as unavailable rather than zero.',
  partialReturns: 'Open supplier requests where you recorded part of the money coming back.',
  closedWithoutRecovery: 'Requests closed with no return recorded.',
  needingCustomerAction: 'Cases where the next step is yours, including checks you have not reviewed yet.',
}

export interface RecoveryCurrencyFigures {
  currency: CurrencyCode
  flaggedForReviewMinor: number
  flaggedForReviewCount: number
  supportedPotentialMinor: number
  supportedPotentialCount: number
  approvedOutstandingMinor: number
  approvedOutstandingCount: number
  promisedMinor: number
  promisedCount: number
  customerRecordedReturnsMinor: number
  customerRecordedReturnsCount: number
  /** Null while independent return matching is unavailable. Never filled from customer-recorded returns. */
  matchedReturnsMinor: number | null
  matchedReturnsCount: number | null
}

export interface RecoveryCounts {
  cases: number
  claims: number
  nonClaims: number
  byStage: Record<CaseStageView, number>
  partialReturns: number
  closedWithoutRecovery: number
  dismissed: number
  needingCustomerAction: number
}

export interface RecoveryDedup {
  snapshotsRead: number
  casesCounted: number
  duplicatesFolded: number
  /** Keys whose folded snapshots were at different stages. */
  keysWithDifferingStates: number
}

export interface ReturnMatchingStatus {
  available: boolean
  verified: number
  proposed: number
  ambiguous: number
  reversed: number
}

export interface RecoveryOverview {
  byCurrency: RecoveryCurrencyFigures[]
  counts: RecoveryCounts
  dedup: RecoveryDedup
  returnMatching: ReturnMatchingStatus
  definitions: typeof RECOVERY_DEFINITIONS
}

export interface RecoveryOptions {
  /** Coverage reasons the caller knows about, e.g. unreadable saved audits. */
  extraCoverageReasons?: string[]
  /** Freshness basis; defaults to the newest case activity time. */
  sourceUpdatedAt?: number | null
  staleAfterMs?: number
}

// ---------------------------------------------------------------- dedup

interface Folded {
  kept: CaseSnapshot[]
  folded: number
  differing: number
  /** caseId (kept or folded) → kept caseId */
  canonicalOf: Map<string, string>
}

function better(a: CaseSnapshot, b: CaseSnapshot): boolean {
  const ra = STAGE_RANK[a.stage] ?? 0
  const rb = STAGE_RANK[b.stage] ?? 0
  return ra !== rb ? ra > rb : a.caseId < b.caseId
}

export function foldCases(cases: CaseSnapshot[]): Folded {
  const groups = new Map<string, CaseSnapshot[]>()
  for (const c of cases) {
    const list = groups.get(c.crossAuditKey) ?? []
    list.push(c)
    groups.set(c.crossAuditKey, list)
  }
  const kept: CaseSnapshot[] = []
  const canonicalOf = new Map<string, string>()
  let folded = 0
  let differing = 0
  for (const list of groups.values()) {
    let best = list[0]
    for (const c of list) if (better(c, best)) best = c
    kept.push(best)
    folded += list.length - 1
    if (new Set(list.map((c) => c.stage)).size > 1) differing += 1
    for (const c of list) canonicalOf.set(c.caseId, best.caseId)
  }
  kept.sort((a, b) => compareText(a.caseId, b.caseId))
  return { kept, folded, differing, canonicalOf }
}

// ---------------------------------------------------------------- figures

function emptyFigures(currency: string, matchingAvailable: boolean): RecoveryCurrencyFigures {
  return {
    currency,
    flaggedForReviewMinor: 0,
    flaggedForReviewCount: 0,
    supportedPotentialMinor: 0,
    supportedPotentialCount: 0,
    approvedOutstandingMinor: 0,
    approvedOutstandingCount: 0,
    promisedMinor: 0,
    promisedCount: 0,
    customerRecordedReturnsMinor: 0,
    customerRecordedReturnsCount: 0,
    matchedReturnsMinor: matchingAvailable ? 0 : null,
    matchedReturnsCount: matchingAvailable ? 0 : null,
  }
}

function addSafe(a: number, b: number): number {
  const next = a + b
  if (!Number.isSafeInteger(next)) throw new RangeError('Total exceeds exact integer arithmetic.')
  return next
}

export function isOpen(c: CaseSnapshot): boolean {
  return !CLOSED_STAGES.has(c.stage)
}

/** Mirrors selectors.isFlaggedForReview as far as a snapshot allows (see metrics.md for the gap). */
export function isFlaggedForReviewSnapshot(c: CaseSnapshot): boolean {
  return (c.stage === 'unreviewed' || c.stage === 'needs_info') && c.supportedPotentialMinor === null && !NOT_FLAGGED_FOR_REVIEW_TYPES.has(c.findingType)
}

/** Each figure's contribution of one case, in the case's currency. Exported for tests and vendor views. */
export function caseContributions(c: CaseSnapshot) {
  const open = isOpen(c)
  const flagged = open && isFlaggedForReviewSnapshot(c) ? c.flaggedMinor : null
  const supported = open && c.supportedPotentialMinor !== null ? Math.max(0, c.supportedPotentialMinor - c.customerRecordedReturnMinor) : null
  const approvedOutstanding = c.isClaim && c.approvedAt !== null && (c.stage === 'confirmed' || c.stage === 'requested') ? c.outstandingMinor : null
  const promised = c.isClaim && c.stage === 'requested' && c.promisedMinor !== null ? Math.min(c.promisedMinor, c.outstandingMinor) : null
  const recorded = c.customerRecordedReturnMinor > 0 ? c.customerRecordedReturnMinor : null
  return { flagged, supported, approvedOutstanding, promised: promised !== null && promised > 0 ? promised : null, recorded }
}

interface MatchIndex {
  /** kept caseId → verified matches (deduplicated) */
  verifiedByCase: Map<string, ReturnMatch[]>
  status: ReturnMatchingStatus
  unknownCaseMatches: number
}

function indexMatches(ctx: TenantContext, returns: ReturnMatchPort, folded: Folded): MatchIndex {
  const status: ReturnMatchingStatus = { available: returns.available, verified: 0, proposed: 0, ambiguous: 0, reversed: 0 }
  const verifiedByCase = new Map<string, ReturnMatch[]>()
  let unknownCaseMatches = 0
  if (!returns.available) return { verifiedByCase, status, unknownCaseMatches }
  const seen = new Set<string>()
  const matches = [...returns.listMatches(ctx)].sort((a, b) => compareText(a.caseId, b.caseId) || compareText(a.date, b.date) || compareText([...a.sourceRecordIds].sort().join(','), [...b.sourceRecordIds].sort().join(',')))
  for (const m of matches) {
    const kept = folded.canonicalOf.get(m.caseId)
    if (kept === undefined) {
      unknownCaseMatches += 1
      continue
    }
    // The same return can be reported against two copies of one case; count it once.
    const identity = `${kept}|${m.status}|${m.amount.currency}|${m.amount.amountMinor}|${[...m.sourceRecordIds].sort().join(',')}`
    if (seen.has(identity)) continue
    seen.add(identity)
    status[m.status] += 1
    if (m.status !== 'verified') continue
    const list = verifiedByCase.get(kept) ?? []
    list.push(m)
    verifiedByCase.set(kept, list)
  }
  return { verifiedByCase, status, unknownCaseMatches }
}

interface Aggregate {
  byCurrency: RecoveryCurrencyFigures[]
  counts: RecoveryCounts
}

function aggregate(cases: CaseSnapshot[], matches: MatchIndex): Aggregate {
  const available = matches.status.available
  const rows = new Map<string, RecoveryCurrencyFigures>()
  const rowFor = (currency: string) => {
    let row = rows.get(currency)
    if (!row) {
      row = emptyFigures(currency, available)
      rows.set(currency, row)
    }
    return row
  }
  const byStage: Record<CaseStageView, number> = { unreviewed: 0, needs_info: 0, dismissed: 0, confirmed: 0, requested: 0, recovered: 0, not_recovered: 0 }
  const counts: RecoveryCounts = { cases: cases.length, claims: 0, nonClaims: 0, byStage, partialReturns: 0, closedWithoutRecovery: 0, dismissed: 0, needingCustomerAction: 0 }
  for (const c of cases) {
    const row = rowFor(c.currency)
    const k = caseContributions(c)
    if (k.flagged !== null) { row.flaggedForReviewMinor = addSafe(row.flaggedForReviewMinor, k.flagged); row.flaggedForReviewCount += 1 }
    if (k.supported !== null) { row.supportedPotentialMinor = addSafe(row.supportedPotentialMinor, k.supported); row.supportedPotentialCount += 1 }
    if (k.approvedOutstanding !== null) { row.approvedOutstandingMinor = addSafe(row.approvedOutstandingMinor, k.approvedOutstanding); row.approvedOutstandingCount += 1 }
    if (k.promised !== null) { row.promisedMinor = addSafe(row.promisedMinor, k.promised); row.promisedCount += 1 }
    if (k.recorded !== null) { row.customerRecordedReturnsMinor = addSafe(row.customerRecordedReturnsMinor, k.recorded); row.customerRecordedReturnsCount += 1 }
    for (const m of matches.verifiedByCase.get(c.caseId) ?? []) {
      const mrow = rowFor(m.amount.currency)
      mrow.matchedReturnsMinor = addSafe(mrow.matchedReturnsMinor ?? 0, m.amount.amountMinor)
      mrow.matchedReturnsCount = (mrow.matchedReturnsCount ?? 0) + 1
    }
    byStage[c.stage] += 1
    if (c.isClaim) counts.claims += 1
    else counts.nonClaims += 1
    if (c.stage === 'requested' && c.customerRecordedReturnMinor > 0) counts.partialReturns += 1
    if (c.stage === 'not_recovered') counts.closedWithoutRecovery += 1
    if (c.stage === 'dismissed') counts.dismissed += 1
    if (c.nextAction.requiresCustomer) counts.needingCustomerAction += 1
  }
  return { byCurrency: [...rows.values()].sort((a, b) => compareText(a.currency, b.currency)), counts }
}

function coverageFor(origin: string, cases: CaseSnapshot[], returns: ReturnMatchPort, options: RecoveryOptions | undefined) {
  const base = origin === 'legacy_audit_snapshot' ? [COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS] : []
  const currencies = new Set(cases.map((c) => c.currency))
  const caseReasons = [...base, ...(options?.extraCoverageReasons ?? [])]
  if (cases.length === 0) caseReasons.push(COVERAGE_REASONS.NO_DATA)
  if (currencies.has(UNKNOWN_CURRENCY)) caseReasons.push(COVERAGE_REASONS.MISSING_CURRENCY)
  if (currencies.size > 1) caseReasons.push(COVERAGE_REASONS.MIXED_CURRENCY)
  const gateReasons = cases.some((c) => isOpen(c) && c.currency !== 'USD') ? [RECOVERY_COVERAGE_REASONS.GATE_CURRENCY_UNSUPPORTED] : []
  return [
    coverage('recovery_cases', caseReasons),
    // A snapshot does not carry the detector's suppression reason, so suppressed signals cannot be left out yet.
    coverage('flagged_for_review', [COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING]),
    coverage('supported_potential', gateReasons),
    coverage('promised', cases.some((c) => caseContributions(c).promised !== null && c.customerRecordedReturnMinor > 0) ? [RECOVERY_COVERAGE_REASONS.PROMISE_RETURN_ORDER_UNKNOWN] : []),
    returns.available ? coverage('matched_returns', []) : coverage('matched_returns', [COVERAGE_REASONS.NO_INDEPENDENT_RETURN_MATCHING], true),
  ]
}

function warningsFor(folded: Folded, matches: MatchIndex): Warning[] {
  const warnings: Warning[] = []
  if (folded.folded > 0) warnings.push({ code: RECOVERY_WARNING_CODES.CASES_FOLDED, detail: `${folded.folded} cases appeared in more than one saved audit and were counted once.` })
  if (folded.differing > 0) warnings.push({ code: RECOVERY_WARNING_CODES.FOLDED_STATES_DIFFER, detail: `${folded.differing} of those cases were at different stages in different audits; the most advanced stage is shown.` })
  if (matches.unknownCaseMatches > 0) warnings.push({ code: RECOVERY_WARNING_CODES.MATCH_UNKNOWN_CASE, detail: `${matches.unknownCaseMatches} return matches refer to cases that are not visible here and were not counted.` })
  return warnings
}

function exclusionsFor(folded: Folded): Exclusion[] {
  return [{ code: 'cross_audit_overlap', count: folded.folded, amounts: [], detail: 'Copies of the same case held by another saved audit; counted once.' }]
}

function newestActivity(cases: CaseSnapshot[]): number | null {
  return cases.reduce<number | null>((max, c) => (c.updatedAt !== null && (max === null || c.updatedAt > max) ? c.updatedAt : max), null)
}

function caseRef(c: CaseSnapshot): SourceRef {
  return { id: `case:${c.caseId}`, label: `${c.vendor.displayName} · ${c.findingType} · ${c.stage}` }
}

function read(ctx: TenantContext, cases: CaseReadPort, returns: ReturnMatchPort, now: number) {
  requirePermission(ctx, 'cases:read')
  const snapshots = cases.listCases(ctx, now)
  const folded = foldCases(snapshots)
  const matches = indexMatches(ctx, returns, folded)
  return { snapshots, folded, matches }
}

// ---------------------------------------------------------------- recoveryOverview

export function recoveryOverview(ctx: TenantContext, cases: CaseReadPort, returns: ReturnMatchPort, now: number, options?: RecoveryOptions): ReadModelEnvelope<RecoveryOverview> {
  const { snapshots, folded, matches } = read(ctx, cases, returns, now)
  const agg = aggregate(folded.kept, matches)
  return envelope<RecoveryOverview>({
    model: 'recovery.overview',
    metricDefinitionVersion: RECOVERY_METRIC_VERSION,
    ctx,
    origin: cases.origin,
    scope: { from: null, to: null, dateBasis: 'none', currencies: agg.byCurrency.map((r) => r.currency) },
    computedAt: now,
    sourceUpdatedAt: options?.sourceUpdatedAt !== undefined ? options.sourceUpdatedAt : newestActivity(snapshots),
    staleAfterMs: options?.staleAfterMs,
    coverage: coverageFor(cases.origin, folded.kept, returns, options),
    sources: folded.kept.map(caseRef),
    exclusions: exclusionsFor(folded),
    warnings: warningsFor(folded, matches),
    result: {
      byCurrency: agg.byCurrency,
      counts: agg.counts,
      dedup: { snapshotsRead: snapshots.length, casesCounted: folded.kept.length, duplicatesFolded: folded.folded, keysWithDifferingStates: folded.differing },
      returnMatching: matches.status,
      definitions: RECOVERY_DEFINITIONS,
    },
  })
}

// ---------------------------------------------------------------- recoveryByVendor

export interface VendorRecoveryRow {
  vendorKey: string
  /** Most frequent case vendor name for this key; ties go to the alphabetically first. */
  displayName: string
  byCurrency: RecoveryCurrencyFigures[]
  counts: RecoveryCounts
  caseIds: string[]
}

export interface VendorRecoveryPage {
  rows: VendorRecoveryRow[]
  totalRows: number
  nextCursor: string | null
  definitions: typeof RECOVERY_DEFINITIONS
}

/** Rows ordered by cases needing customer action (desc), then case count (desc), then vendorKey. */
export function recoveryByVendor(ctx: TenantContext, cases: CaseReadPort, returns: ReturnMatchPort, now: number, page?: PageRequest, options?: RecoveryOptions): ReadModelEnvelope<VendorRecoveryPage> {
  const { snapshots, folded, matches } = read(ctx, cases, returns, now)
  const groups = new Map<string, CaseSnapshot[]>()
  for (const c of folded.kept) {
    const list = groups.get(c.vendor.vendorKey) ?? []
    list.push(c)
    groups.set(c.vendor.vendorKey, list)
  }
  const rows: VendorRecoveryRow[] = [...groups.entries()].map(([vendorKey, list]) => {
    const agg = aggregate(list, matches)
    return {
      vendorKey,
      displayName: mostFrequent(list.map((c) => c.vendor.displayName.trim())) || 'Unnamed vendor',
      byCurrency: agg.byCurrency,
      counts: agg.counts,
      caseIds: list.map((c) => c.caseId).sort(compareText),
    }
  })
  rows.sort((a, b) => b.counts.needingCustomerAction - a.counts.needingCustomerAction || b.counts.cases - a.counts.cases || compareText(a.vendorKey, b.vendorKey))
  const { offset, limit } = pageBounds(page, rows.length)
  const pageRows = rows.slice(offset, offset + limit)
  const keptById = new Map(folded.kept.map((c) => [c.caseId, c]))
  return envelope<VendorRecoveryPage>({
    model: 'recovery.by_vendor',
    metricDefinitionVersion: RECOVERY_METRIC_VERSION,
    ctx,
    origin: cases.origin,
    scope: { from: null, to: null, dateBasis: 'none', currencies: [...new Set(folded.kept.map((c) => c.currency))].sort(compareText) },
    computedAt: now,
    sourceUpdatedAt: options?.sourceUpdatedAt !== undefined ? options.sourceUpdatedAt : newestActivity(snapshots),
    staleAfterMs: options?.staleAfterMs,
    coverage: coverageFor(cases.origin, folded.kept, returns, options),
    sources: pageRows.flatMap((r) => r.caseIds).map((id) => caseRef(keptById.get(id)!)),
    exclusions: exclusionsFor(folded),
    warnings: warningsFor(folded, matches),
    result: { rows: pageRows, totalRows: rows.length, nextCursor: nextCursorOf(offset, limit, rows.length), definitions: RECOVERY_DEFINITIONS },
  })
}
