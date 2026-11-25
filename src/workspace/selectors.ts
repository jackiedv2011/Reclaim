/**
 * The V2 lens over the existing detection engine.
 *
 * Nothing here re-detects anything — `lib/detection.ts` already produces the
 * findings and `ledger/caseState.ts` already tracks what a reviewer did with
 * each one. This module only reframes both in the vocabulary the product spec
 * uses: a value ladder whose rungs are never added together (§3), an evidence
 * strength label rather than a fake confidence percentage (§12), and a
 * priority that ranks money by how gettable it is rather than by size (§13).
 */
import { activeReturned, authorizedOutstanding, eligiblePotential, unrequestedRemainder, validSettlements, verifiedReturned } from '@/recovery/financials'
import { claimContext, type CarriedState } from '@/recovery/claimLinks'
import type { ClaimFinding } from '@/recovery/eligibility'
import { assessRecordReadiness } from '@/audit/dataReadiness'
import type { LedgerEnvironment } from '@/ledger/store'
import type { CaseState } from '@/ledger/caseState'
import { evidenceStrength, keyUncertainty } from '@/audit/ruleChecklist'
import { normalizeVendor } from '@/lib/format'
import { isAtRisk, sumMoney } from '@/lib/claims'
import { FINDING_TYPE_LABELS } from '@/lib/labels'
import { currencyOf, exposureCurrencyOf, formatMoney } from './money'
import type { Finding, FindingType } from '@/types'
import { latestVendorPosition, VENDOR_STATUS } from '@/recovery/vendorStatus'

export { exposureCurrencyOf } from './money'

/**
 * §12 — three levels, not a percentage. "94% confident" means nothing to a
 * controller. This is not a new scale: `evidenceStrength` already scores each
 * finding against its own rule checklist (how many of the conditions that would
 * prove this case actually hold). We only rename its third level, because
 * "Limited" describes the evidence while "Needs review" describes what to do.
 */
export type EvidenceLevel = 'strong' | 'moderate' | 'review'

export const EVIDENCE_LABEL: Record<EvidenceLevel, string> = {
  strong: 'Strong',
  moderate: 'Moderate',
  review: 'Needs review',
}

/**
 * Where a case sits on the ladder. These are reported side by side and never
 * summed — §3's whole point is that found money and returned money are
 * different numbers, and blurring them is how software starts lying.
 */
export type LadderStage = 'potential' | 'verified' | 'inRecovery' | 'recovered' | 'protected'

export interface Ladder {
  flagged: number
  flaggedCount: number
  currency: 'USD'
  recoveredByCurrency: Record<string, number>
  flaggedByCurrency: Record<string, number>
  atRiskByCurrency: Record<string, number>
  /**
   * Money still in play that could come back: every claim (see lib/claims)
   * that has not been dismissed and has not reached an outcome. Missed
   * discounts are Protected and bank-account / shared-invoice alerts are At
   * risk — neither is money a vendor owes, so neither is counted here. Money
   * that already came back leaves this figure — potential and recovered are
   * never the same dollars.
   */
  potential: number
  /** Every finding still open (not dismissed, no outcome), claim or not. */
  openCount: number
  /** Open bank-account-change and shared-invoice alerts: payments to verify, reported apart from recovery. */
  atRisk: number
  /**
   * The rules engine's verdict that the records support a recovery — not a
   * human's. Nothing here has been agreed to by a vendor, so this is the
   * ceiling on what could be claimed, never a forecast of what will come back.
   * A case leaves this rung once it is dismissed or once a request goes out.
   */
  verified: number
  /** Outstanding amount on approved requests, sent or not. */
  inRecovery: number
  /** Of those, how many have gone to the vendor, and how many are approved but not sent yet. */
  requestsSent: number
  requestsApproved: number
  /** Money that actually came back — the only figure worth trusting. */
  recovered: number
  /** Stopped before payment. Zero until Reclaim has a prepayment intervention check. */
  protected: number
  counts: Record<LadderStage, number>
  /** Verified and still waiting on a person — §28's "what should I do". */
  awaitingDecision: number
}

/**
 * The one definition of "flagged for review", used by every screen that shows
 * it: an open review signal that the evidence gate has not made a recovery
 * candidate, that is not a security alert or a future saving (those have their
 * own totals), that has no suppression reason, and that has not started
 * recovery. Its amount is never money owed.
 */
export function isFlaggedForReview(finding: Finding, state: CaseState): boolean {
  return finding.classification === 'review_needed' && !finding.suppressionReason && isStillInPlay(state) && state.recoveryStage === null
}

/**
 * `RecoveryStage.confirmed` is the customer's decision to pursue a case.
 * Vendor agreement is separate and comes from recorded vendor updates in
 * `vendorCommitments`; neither it nor a promise is settled value.
 */

export interface Opportunity {
  /** Carries what an earlier case on the same payments already has out or back (see claimLinks). */
  finding: ClaimFinding
  state: CarriedState
  evidence: EvidenceLevel
  /** Ranking score — see `priorityOf`. Not shown to the user, only sorted by. */
  priority: number
  typeLabel: string
}

export interface VendorRollup {
  vendor: string
  caseCount: number
  potential: number
  recovered: number
  /** Null when the vendor produced no findings at all. */
  strongest: EvidenceLevel | null
  recordCount: number
}

export interface RootCause {
  type: FindingType
  label: string
  currency: string
  count: number
  value: number
}

export function evidenceOf(finding: Finding): EvidenceLevel {
  switch (evidenceStrength(finding)) {
    case 'Strong':
      return 'strong'
    case 'Moderate':
      return 'moderate'
    default:
      return 'review'
  }
}

/** The first rule that didn't match — what a reviewer still has to settle. */
export function openQuestion(finding: Finding): string | null {
  return keyUncertainty(finding)
}

const EVIDENCE_WEIGHT: Record<EvidenceLevel, number> = { strong: 1, moderate: 0.6, review: 0.3 }
const CLASS_WEIGHT = { recoverable: 1, review: 0.5, opportunity: 0.4 } as const

/**
 * §13 — "Recovery Priority = value × recoverability × evidence ÷ effort".
 * Effort is proxied by how many records a reviewer has to read to agree.
 * The effect is that an $18k slam dunk outranks a $40k maybe, which is the
 * behaviour the spec explicitly asks for.
 */
export function priorityOf(finding: Finding, evidence: EvidenceLevel): number {
  const effort = 1 + Math.max(0, finding.relatedRecords.length - 2) * 0.15
  return (finding.dollarImpact * CLASS_WEIGHT[finding.class] * EVIDENCE_WEIGHT[evidence]) / effort
}

/** Every finding with its case, as the screens should read them. */
function cases(env: LedgerEnvironment): Array<{ finding: ClaimFinding; state: CarriedState }> {
  const context = claimContext(env.result.findings, env.caseStates)
  return env.result.findings.map((finding) => ({ finding: context.finding(finding), state: context.state(finding) }))
}

function toOpportunity({ finding, state }: { finding: ClaimFinding; state: CarriedState }): Opportunity {
  const evidence = evidenceOf(finding)
  return {
    finding,
    state,
    evidence,
    priority: priorityOf(finding, evidence),
    typeLabel: FINDING_TYPE_LABELS[finding.type] ?? finding.type,
  }
}

/** Everything the engine surfaced, highest priority first. */
export function opportunities(env: LedgerEnvironment): Opportunity[] {
  return cases(env)
    .map(toOpportunity)
    .sort((a, b) => b.priority - a.priority)
}

/**
 * Vendor recovery cases; internal investigations stay in Findings. An approval
 * saved before the evidence gate does not make a signal a vendor case: until its
 * evidence passes it stays an internal review, with its history intact.
 */
export function recoveries(env: LedgerEnvironment): Opportunity[] {
  return opportunities(env).filter(
    (o) => (eligiblePotential(o.finding, env.result.findings) !== null || verifiedReturned(o.state) > 0 || (['exact_duplicate', 'near_duplicate'].includes(o.finding.type) && o.state.recoveryStage === 'requested' && o.state.requestedAmount != null)) && o.state.recoveryStage !== null && o.state.recoveryStage !== undefined
  )
}

/** Nonrecoverable findings with an internal investigation still in progress. */
export function internalReviews(env: LedgerEnvironment): Opportunity[] {
  return opportunities(env).filter((o) => eligiblePotential(o.finding, env.result.findings) === null && verifiedReturned(o.state) === 0 && (o.state.recoveryStage === 'confirmed' || o.state.recoveryStage === 'requested') && !(['exact_duplicate', 'near_duplicate'].includes(o.finding.type) && o.state.recoveryStage === 'requested' && o.state.requestedAmount != null))
}

export type RecoveryAgeLabel = '0–14 days' | '15–30 days' | '31+ days' | 'Date unknown'
export interface RecoveryAgeBucket { label: RecoveryAgeLabel; count: number; outstanding: number }

/** Age open vendor requests by the date the customer recorded outreach. */
export function recoveryAging(env: LedgerEnvironment, asOf = Date.now()): RecoveryAgeBucket[] {
  const buckets: RecoveryAgeBucket[] = [
    { label: '0–14 days', count: 0, outstanding: 0 },
    { label: '15–30 days', count: 0, outstanding: 0 },
    { label: '31+ days', count: 0, outstanding: 0 },
    { label: 'Date unknown', count: 0, outstanding: 0 },
  ]
  const localDay = (time: number) => { const date = new Date(time); return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) }
  for (const { finding, state } of cases(env)) {
    if (eligiblePotential(finding, env.result.findings) === null && !(currencyOf(finding) === 'USD' && state.recoveryStage === 'requested' && state.requestedAmount != null)) continue
    if (state.recoveryStage !== 'requested') continue
    const outstandingCents = Math.round(authorizedOutstanding(state) * 100)
    const start = state.recoveryRequestedAt
    const age = start != null && Number.isFinite(start) && start > 0 ? Math.max(0, Math.floor((localDay(asOf) - localDay(start)) / 86_400_000)) : null
    const bucket = buckets[age === null ? 3 : age <= 14 ? 0 : age <= 30 ? 1 : 2]
    bucket.count += 1
    bucket.outstanding += outstandingCents / 100
  }
  return buckets.map((bucket) => ({ ...bucket, outstanding: Math.round(bucket.outstanding * 100) / 100 }))
}

export interface RecentReturn { id: string; findingId: string; vendor: string; amount: number; settledAt: number; currency: string; partial: boolean; reference: string | null }

/** One row per current recorded return, ordered by its own settlement date. */
export function recentReturns(env: LedgerEnvironment): RecentReturn[] {
  const rows: RecentReturn[] = []
  for (const { finding, state } of cases(env)) {
    const settlements = validSettlements(state)
    if (settlements.length) {
      settlements.forEach((entry, index) => {
        if (!Number.isFinite(entry.amount) || entry.amount <= 0 || !Number.isFinite(entry.settledAt) || entry.settledAt <= 0) return
        rows.push({ id: `${finding.id}:${index}`, findingId: finding.id, vendor: finding.vendor, amount: entry.amount, currency: exposureCurrencyOf(finding), settledAt: entry.settledAt, partial: state.recoveryStage === 'requested', reference: entry.reference })
      })
      continue
    }

  }
  return rows.sort((a, b) => b.settledAt - a.settledAt || b.amount - a.amount)
}

/**
 * What one recovery case is worth right now, the same on every screen: the open
 * balance while a request is out, what came back once it is done, and before
 * that what is left to ask for after earlier returns.
 */
export function caseAmount({ finding, state }: Pick<Opportunity, 'finding' | 'state'>, findings: Finding[]): { amount: number; label: string } {
  if (state.recoveryStage === 'recovered') return { amount: verifiedReturned(state), label: verifiedReturned(state) > 0 ? 'returned' : 'amount missing' }
  if (state.recoveryStage === 'requested' && state.requestedAmount != null) return { amount: Math.max(0, Math.round((state.requestedAmount - activeReturned(state)) * 100) / 100), label: 'outstanding' }
  if (state.recoveryStage === 'not_recovered' && state.requestedAmount != null) return { amount: state.requestedAmount, label: 'unreturned' }
  const supported = eligiblePotential(finding, findings)
  if (state.recoveryStage === 'requested' || state.recoveryStage === 'not_recovered') return { amount: supported === null ? finding.dollarImpact : 0, label: supported === null ? 'under review' : 'amount missing' }
  if (state.approvedAt && state.recoveryStage === 'confirmed' && supported !== null) return { amount: authorizedOutstanding(state), label: 'approved, not sent' }
  return { amount: supported === null ? finding.dollarImpact : Math.max(0, Math.round((supported - verifiedReturned(state)) * 100) / 100), label: 'to request' }
}

/** "2 requests out with vendors · 1 approved, not sent": an approval is not a request until it goes out. */
export function requestsNote(l: Ladder): string {
  const parts = [
    l.requestsSent ? `${l.requestsSent} ${l.requestsSent === 1 ? 'request' : 'requests'} out with vendors` : null,
    l.requestsApproved ? `${l.requestsApproved} approved, not sent yet` : null,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'No requests out yet'
}

/** What the loaded columns let the checks do. "Every check ran" is only said when all of them could. */
export interface CheckCoverage { complete: boolean; summary: string; limits: string[] }

export function checkCoverage(env: LedgerEnvironment): CheckCoverage {
  // Older imports did not keep their column list; the records still show what could run.
  const columns = env.imports.some((batch) => batch.detectedColumns) ? env.imports.flatMap((batch) => batch.detectedColumns ?? []) : undefined
  const { availableCheckCount, totalCheckCount, weakerChecks } = assessRecordReadiness(env.records, 0, columns)
  const complete = availableCheckCount >= totalCheckCount
  return {
    complete,
    summary: complete ? 'Every check ran' : `${availableCheckCount} of ${totalCheckCount} checks could run`,
    limits: weakerChecks.map((check) => check.label),
  }
}

/** Verified, undecided, and waiting on a human — §28's "what should I do". */
export function awaitingDecision(env: LedgerEnvironment): Opportunity[] {
  return opportunities(env).filter((o) => o.state.decision === null && eligiblePotential(o.finding, env.result.findings) !== null)
}

/**
 * Every figure one finding contributes, in one place: the totals, the lists and
 * the export all read these, so the same quantity is the same number everywhere.
 * A null means the finding contributes nothing to that figure.
 */
export interface FindingFigures {
  open: boolean
  flagged: number | null
  atRisk: number | null
  /** USD only, like the recovery workflow. */
  potential: number | null
  /** Potential that has no approved request yet. */
  verified: number | null
  inRecovery: number | null
  returned: number
}

export function figuresOf({ finding, state }: Pick<Opportunity, 'finding' | 'state'>, findings: Finding[]): FindingFigures {
  const open = isStillInPlay(state)
  const returned = verifiedReturned(state)
  // Only an eligible recovery candidate carries potential recovery.
  const supported = eligiblePotential(finding, findings)
  // A request for part of the claim that was paid in full leaves the rest supported and requestable.
  const potential = supported === null ? null : open ? Math.max(0, Math.round((supported - returned) * 100) / 100) : unrequestedRemainder(state, supported)
  let inRecovery: number | null = null
  if (supported !== null) {
    if (open && state.approvedAt && (state.recoveryStage === 'confirmed' || state.recoveryStage === 'requested')) inRecovery = authorizedOutstanding(state)
  } else if (Boolean(finding.requiresRevalidation || state.requiresRevalidation) && currencyOf(finding) === 'USD' && state.recoveryStage === 'requested' && state.requestedAmount != null && state.approvedAt) {
    // An import can supersede the detector's finding while an authorized request
    // remains open. Keep its proven outstanding balance visible for closeout.
    // Only a superseded finding qualifies: a signal that never passed the gate has
    // no vendor request to keep open, whatever its currency.
    inRecovery = authorizedOutstanding(state)
  }
  return {
    open,
    flagged: isFlaggedForReview(finding, state) ? finding.flaggedAmount ?? finding.dollarImpact : null,
    atRisk: open && isAtRisk(finding) ? finding.dollarImpact : null,
    potential,
    verified: potential !== null && inRecovery === null ? potential : null,
    inRecovery,
    returned,
  }
}

export function ladder(env: LedgerEnvironment): Ladder {
  const empty = { potential: 0, verified: 0, inRecovery: 0, recovered: 0, protected: 0 }
  const counts: Record<LadderStage, number> = { ...empty }
  // Totals are kept in whole cents and converted once at the end.
  const cents = { ...empty }
  const add = (stage: LadderStage, amount: number | null) => {
    if (amount === null) return
    cents[stage] += Math.round(amount * 100)
    counts[stage] += 1
  }
  let awaitingCents = 0
  let flaggedCount = 0
  let openCount = 0
  let requestsSent = 0
  let requestsApproved = 0
  const recoveredByCurrency: Record<string, number> = {}
  const flaggedByCurrency: Record<string, number> = {}
  const atRiskByCurrency: Record<string, number> = {}
  const addTo = (totals: Record<string, number>, currency: string, amount: number) => { totals[currency] = sumMoney([totals[currency] ?? 0, amount]) }

  for (const { finding, state } of cases(env)) {
    const figures = figuresOf({ finding, state }, env.result.findings)
    // Historical verified returns survive revalidation of the original signal.
    if (figures.returned > 0) {
      // Returns were always entered in the app's dollar fields, so a legacy
      // finding without a currency keeps its verified money as USD. Only a known
      // other currency is held out of the USD total.
      const key = currencyOf(finding)
      addTo(recoveredByCurrency, key, figures.returned)
      if (key === 'USD') add('recovered', figures.returned)
    }
    if (figures.open) openCount += 1
    if (figures.flagged !== null) {
      addTo(flaggedByCurrency, exposureCurrencyOf(finding), figures.flagged)
      flaggedCount += 1
    }
    if (figures.atRisk !== null) addTo(atRiskByCurrency, exposureCurrencyOf(finding), figures.atRisk)
    add('potential', figures.potential)
    add('verified', figures.verified)
    add('inRecovery', figures.inRecovery)
    if (figures.inRecovery !== null) {
      if (state.recoveryStage === 'requested') requestsSent += 1
      else requestsApproved += 1
    }
    if (figures.potential !== null && state.decision === null) awaitingCents += Math.round(figures.potential * 100)
  }

  const dollars = (value: number) => value / 100
  return {
    potential: dollars(cents.potential),
    verified: dollars(cents.verified),
    inRecovery: dollars(cents.inRecovery),
    requestsSent,
    requestsApproved,
    recovered: dollars(cents.recovered),
    protected: dollars(cents.protected),
    openCount,
    atRisk: atRiskByCurrency.USD ?? 0,
    counts,
    awaitingDecision: dollars(awaitingCents),
    flagged: flaggedByCurrency.USD ?? 0,
    flaggedCount,
    currency: 'USD',
    recoveredByCurrency,
    flaggedByCurrency,
    atRiskByCurrency,
  }
}

export interface VendorCommitments {
  confirmed: number
  pendingReturn: number
  confirmedCases: number
  pendingCases: number
}

/** Customer-recorded vendor statements; neither bucket is settled money. */
export function vendorCommitments(env: LedgerEnvironment): VendorCommitments {
  const totals: VendorCommitments = { confirmed: 0, pendingReturn: 0, confirmedCases: 0, pendingCases: 0 }
  for (const { finding, state } of cases(env)) {
    if (eligiblePotential(finding, env.result.findings) === null && !(currencyOf(finding) === 'USD' && ['exact_duplicate', 'near_duplicate'].includes(finding.type) && state.recoveryStage === 'requested' && state.requestedAmount != null)) continue
    if (state.recoveryStage !== 'requested') continue
    const update = latestVendorPosition(state)
    if (!update || !VENDOR_STATUS[update.status].agreed) continue
    const remaining = authorizedOutstanding(state)
    const returnedSinceUpdate = validSettlements(state).filter((entry) => (entry.requestGeneration ?? 1) === (state.activeRequestGeneration ?? 1) && entry.settledAt >= update.at).reduce((sum, entry) => sum + entry.amount, 0)
    // Only "accepted the claim" states that the whole request was accepted.
    // A partial acceptance, promise, or issued credit without a stated amount
    // cannot safely be valued at the full remaining balance.
    const amount = update.amount === undefined
      ? (update.status === 'accepted' ? remaining : 0)
      : Math.min(remaining, Math.max(0, update.amount - returnedSinceUpdate))
    if (amount <= 0) continue
    totals.confirmed += amount
    totals.confirmedCases += 1
    if (VENDOR_STATUS[update.status].pending) {
      totals.pendingReturn += amount
      totals.pendingCases += 1
    }
  }
  return { ...totals, confirmed: Math.round(totals.confirmed * 100) / 100, pendingReturn: Math.round(totals.pendingReturn * 100) / 100 }
}

/**
 * Every vendor in the ledger, not only the flagged ones. A vendor that came
 * through clean is a result too, and leaving it out would make this page
 * disagree with the vendor count on every other screen.
 *
 * Keyed on the normalized name so a finding and its records land on the same
 * row even when the source file spells the vendor slightly differently.
 */
export function vendors(env: LedgerEnvironment): VendorRollup[] {
  const order: EvidenceLevel[] = ['review', 'moderate', 'strong']
  const byVendor = new Map<string, VendorRollup>()

  const rowFor = (name: string): VendorRollup => {
    const key = normalizeVendor(name)
    const existing = byVendor.get(key)
    if (existing) return existing
    const created: VendorRollup = {
      vendor: name,
      caseCount: 0,
      potential: 0,
      recovered: 0,
      strongest: null,
      recordCount: 0,
    }
    byVendor.set(key, created)
    return created
  }

  // Records first, so recordCount is "payments in this ledger" rather than a
  // sum of related-record lists that double-counts anything in two findings.
  for (const record of env.records) rowFor(record.vendor).recordCount += 1

  for (const { finding, state } of cases(env)) {
    const evidence = evidenceOf(finding)
    const row = rowFor(finding.vendor)
    row.caseCount += 1
    row.potential = sumMoney([row.potential, figuresOf({ finding, state }, env.result.findings).potential ?? 0])
    if (currencyOf(finding) === 'USD') row.recovered = sumMoney([row.recovered, verifiedReturned(state)])
    if (row.strongest === null || order.indexOf(evidence) > order.indexOf(row.strongest)) row.strongest = evidence
  }

  return [...byVendor.values()].sort(
    (a, b) => b.potential - a.potential || a.vendor.localeCompare(b.vendor)
  )
}

/** Not dismissed and not yet resolved — the same test the ladder's `potential` rung uses. */
function isStillInPlay(state: CaseState): boolean {
  return state.decision !== 'expected' && state.recoveryStage !== 'recovered' && state.recoveryStage !== 'not_recovered'
}

/**
 * §25 — every open finding, grouped by the check that raised it. Dismissed
 * findings were never a leak and closed ones are no longer open, so neither is
 * counted: the totals here are the same findings every other screen calls open.
 */
export function rootCauses(env: LedgerEnvironment): RootCause[] {
  const byType = new Map<string, RootCause>()
  for (const { finding, state } of cases(env)) {
    if (!isStillInPlay(state)) continue
    const currency = exposureCurrencyOf(finding)
    const key = `${finding.type}|${currency}`
    const row = byType.get(key) ?? {
      type: finding.type,
      label: FINDING_TYPE_LABELS[finding.type] ?? finding.type,
      currency,
      count: 0,
      value: 0,
    }
    row.count += 1
    row.value = sumMoney([row.value, finding.dollarImpact])
    byType.set(key, row)
  }
  return [...byType.values()].sort((a, b) => b.value - a.value)
}

export interface RecordedRootCause { label: string; count: number; recovered: number }

/** Causes confirmed by customers during accounting closeout, separate from rule categories. */
export function recordedRootCauses(env: LedgerEnvironment): RecordedRootCause[] {
  const causes = new Map<string, RecordedRootCause>()
  for (const { finding, state } of cases(env)) {
    if (currencyOf(finding) !== 'USD' || state.recoveryStage !== 'recovered' || verifiedReturned(state) <= 0 || !state.reconciledAt || !state.rootCause) continue
    const cause = causes.get(state.rootCause) ?? { label: state.rootCause, count: 0, recovered: 0 }
    cause.count += 1
    cause.recovered += verifiedReturned(state)
    causes.set(state.rootCause, cause)
  }
  return [...causes.values()].sort((a, b) => b.recovered - a.recovered)
}

/** The chronological record for a single case (§21). */
export interface TimelineStep {
  when: string
  what: string
  detail?: string
  done: boolean
}

export function timelineFor(finding: Finding, state: CaseState, discoveredAt: number | null = null): TimelineStep[] {
  const at = (ts: number | null | undefined) =>
    ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'

  const returned = formatMoney(activeReturned(state), exposureCurrencyOf(finding))
  if (finding.class !== 'recoverable') return [
    { when: at(discoveredAt), what: 'Finding detected', done: true },
    { when: at(state.decidedAt), what: 'Evidence reviewed', done: state.decision !== null },
    { when: at(state.recoveryRequestedAt), what: 'Internal review filed', done: state.recoveryStage === 'requested' || state.recoveryStage === 'recovered' || state.recoveryStage === 'not_recovered' },
    { when: at(state.recoveryResolvedAt), what: state.recoveryStage === 'recovered' || state.recoveryStage === 'not_recovered' ? 'Internal review closed' : 'Investigation outcome pending', detail: state.recoveryOutcomeNote ?? undefined, done: state.recoveryStage === 'recovered' || state.recoveryStage === 'not_recovered' },
  ]

  const steps: TimelineStep[] = [
    {
      when: at(discoveredAt),
      what: 'Opportunity detected',
      detail: `${FINDING_TYPE_LABELS[finding.type] ?? finding.type} · ${finding.relatedRecords.length} ${finding.relatedRecords.length === 1 ? 'record' : 'records'} matched`,
      done: true,
    },
    {
      when: at(state.decidedAt),
      what: 'Evidence reviewed',
      detail: state.decision ? undefined : 'Waiting on you',
      done: state.decision !== null,
    },
    {
      when: at(state.recoveryRequestedAt),
      what: 'Recovery request sent',
      done: state.recoveryStage === 'requested' || state.recoveryStage === 'recovered',
    },
    {
      when: at(state.recoveryResolvedAt),
      // Reclaim has no bank feed, so it cannot verify anything itself — the
      // outcome is what the reviewer recorded, and the label says so.
      what:
        state.recoveryStage === 'not_recovered'
          ? 'Closed without recovery'
          : state.recoveryStage === 'recovered' && activeReturned(state) <= 0
            ? 'Return amount missing — correct this case before reconciliation'
            : state.recoveryStage === 'recovered'
              ? `Money received — ${returned} recorded by you`
            : activeReturned(state) > 0
              ? `Partial return — ${returned} recorded by you`
              : 'Outcome pending',
      detail: state.recoveryOutcomeNote ?? undefined,
      done: state.recoveryStage === 'recovered' || state.recoveryStage === 'not_recovered' || activeReturned(state) > 0,
    },
  ]
  return steps
}
