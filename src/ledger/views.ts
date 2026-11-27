import { ladder } from '@/workspace/selectors'
import { eligiblePotential, verifiedReturned } from '@/recovery/financials'
import type { Finding, FindingClass } from '@/types'
import { computeAuditStats, summarizeFindingClasses } from '@/audit/deriveStats'
import { assessRecordReadiness, type WeakerCheck } from '@/audit/dataReadiness'
import { FINDING_TYPE_ORDER } from '@/lib/labels'
import type { LedgerEnvironment } from '@/ledger/store'
import { claimContext, type CarriedState, type ClaimContext } from '@/recovery/claimLinks'
import type { ClaimFinding } from '@/recovery/eligibility'
import {
  QUEUE_GROUP_LABEL,
  RECOVERY_STAGE_LABEL,
  isInFindingsQueue,
  isInRecoveryQueue,
  queueGroupFor,
  type CaseState,
  type QueueGroup,
  type RecoveryStage,
} from '@/ledger/caseState'

export interface CaseView {
  /** Carries what an earlier case on the same payments already has out or back. */
  finding: ClaimFinding
  /** Includes a dismissal carried over from a finding this one replaced. */
  state: CarriedState
  isNew: boolean
}

const contextOf = (env: LedgerEnvironment) => claimContext(env.result.findings, env.caseStates)

function toCaseView(env: LedgerEnvironment, context: ClaimContext, finding: Finding): CaseView {
  return { finding: context.finding(finding), state: context.state(finding), isNew: env.newFindingIds.includes(finding.id) }
}

export function findCaseView(env: LedgerEnvironment, findingId: string): CaseView | null {
  const finding = env.result.findings.find((f) => f.id === findingId)
  return finding ? toCaseView(env, contextOf(env), finding) : null
}

const CLASS_PRIORITY: FindingClass[] = ['recoverable', 'review', 'opportunity']

function pickNextRecommended(active: Finding[]): Finding | null {
  for (const cls of CLASS_PRIORITY) {
    const inClass = active.filter((f) => f.class === cls)
    if (inClass.length === 0) continue
    return inClass.reduce((best, candidate) => (candidate.dollarImpact > best.dollarImpact ? candidate : best))
  }
  return null
}

export interface OverviewSummary {
  recordCount: number
  vendorCount: number
  dateRangeLabel: string | null
  skippedCount: number
  importCount: number
  lastImportLabel: string | null
  totalFindingCount: number
  /** Dollar total for every case still awaiting a decision (any class). */
  worthInvestigatingTotal: number
  readyToVerifyCount: number
  needsContextCount: number
  worthNotingCount: number
  /** Open workload and exposure, grouped by the decision readiness shown on Overview. */
  statusMix: Array<{ group: QueueGroup; count: number; dollarImpact: number }>
  /** Highest-value signal types still waiting on a human decision. */
  exposureByType: Array<{ type: Finding['type']; count: number; dollarImpact: number }>
  /** Confirmed cases still moving through recovery (not yet resolved). */
  recoveryActiveCount: number
  recoveryActiveValue: number
  recoveredCount: number
  recoveredValue: number
  /** Reclaim's original estimate for the cases that closed as recovered. */
  recoveredEstimate: number
  newSinceLastVisitCount: number
  nextRecommendedCase: CaseView | null
  nextRecoveryCase: CaseView | null
}

/** Overview lens — the environment compressed into what it means right now. */
export interface ScanReceiptSummary {
  sourceLabel: string
  mode: 'sample' | 'upload'
  importedAt: number
  recordCount: number
  vendorCount: number
  dateRangeLabel: string | null
  skippedCount: number
  availableCheckCount: number
  totalCheckCount: 8
  limitations: WeakerCheck[]
  /** Findings created by this import, used to explain scan-specific access. */
  findingIds: string[]
  totalFindingCount: number
  recoverableCount: number
  recoverableTotal: number
  reviewCount: number
  reviewTotal: number
  opportunityCount: number
  opportunityTotal: number
}

export function lastScanReceipt(env: LedgerEnvironment): ScanReceiptSummary | null {
  const batch = env.imports.at(-1)
  if (!batch) return null

  const records = env.records.filter((record) => record.importBatchId === batch.id)
  const readiness = assessRecordReadiness(records, batch.skippedCount, batch.detectedColumns)
  const fallbackFindingIds = env.result.findings
    .filter((finding) => finding.relatedRecords.some((record) => record.importBatchId === batch.id))
    .map((finding) => finding.id)
  const findingIds = new Set(batch.findingIds ?? fallbackFindingIds)
  const findings = env.result.findings.filter((finding) => findingIds.has(finding.id))
  const classes = summarizeFindingClasses(findings)

  return {
    sourceLabel: batch.sourceLabel,
    mode: batch.mode,
    importedAt: batch.importedAt,
    recordCount: readiness.recordCount,
    vendorCount: readiness.vendorCount,
    dateRangeLabel: readiness.dateRangeLabel,
    skippedCount: readiness.skippedCount,
    availableCheckCount: readiness.availableCheckCount,
    totalCheckCount: readiness.totalCheckCount,
    limitations: readiness.weakerChecks,
    findingIds: [...findingIds],
    ...classes,
  }
}

export function overviewSummary(env: LedgerEnvironment): OverviewSummary {
  const skippedCount = env.imports.reduce((sum, batch) => sum + batch.skippedCount, 0)
  const stats = computeAuditStats(env.records, skippedCount, env.result)
  const context = contextOf(env)
  const findings = env.result.findings
  const stateOf = (f: Finding): CaseState => context.state(f)

  const active = findings.filter((f) => isInFindingsQueue(stateOf(f)))
  const groupCounts: Record<QueueGroup, number> = { claim: 0, check: 0, prevent: 0 }
  const groupValue: Record<QueueGroup, number> = { claim: 0, check: 0, prevent: 0 }
  const exposureByType = new Map<Finding['type'], { count: number; dollarImpact: number }>()
  for (const f of active) {
    const group = queueGroupFor(f, stateOf(f))
    groupCounts[group] += 1
    groupValue[group] += f.dollarImpact
    const current = exposureByType.get(f.type) ?? { count: 0, dollarImpact: 0 }
    exposureByType.set(f.type, { count: current.count + 1, dollarImpact: current.dollarImpact + f.dollarImpact })
  }

  const worthInvestigatingTotal = active.reduce((sum, f) => sum + f.dollarImpact, 0)
  const recoveryActive = findings.filter((f) => {
    const state = stateOf(f)
    return eligiblePotential(context.finding(f), findings) !== null && Boolean(state.approvedAt) && (state.recoveryStage === 'confirmed' || state.recoveryStage === 'requested')
  })
  const totals = ladder(env)
  const recoveryActiveCount = totals.counts.inRecovery
  const recoveryActiveValue = totals.inRecovery
  const recovered = findings.filter((finding) => verifiedReturned(stateOf(finding)) > 0)
  const recoveredCount = totals.counts.recovered
  const recoveredValue = totals.recovered
  // What Reclaim originally estimated for the cases that have since closed as
  // recovered. Shown beside the actual figure so the business can judge how
  // close the estimates run — the performance fee is charged on actual only.
  const recoveredEstimate = recovered.reduce((sum, finding) => sum + finding.dollarImpact, 0)

  const nextRecommended = pickNextRecommended(active)
  const nextRecovery = recoveryActive
    .toSorted((a, b) => {
      const aStage = stateOf(a).recoveryStage === 'confirmed' ? 0 : 1
      const bStage = stateOf(b).recoveryStage === 'confirmed' ? 0 : 1
      return aStage - bStage || b.dollarImpact - a.dollarImpact
    })[0]

  return {
    recordCount: stats.recordCount,
    vendorCount: stats.vendorCount,
    dateRangeLabel: stats.dateRangeLabel,
    skippedCount,
    importCount: env.imports.length,
    lastImportLabel: env.imports.at(-1)?.sourceLabel ?? null,
    totalFindingCount: findings.length,
    worthInvestigatingTotal,
    readyToVerifyCount: groupCounts.claim,
    needsContextCount: groupCounts.check,
    worthNotingCount: groupCounts.prevent,
    statusMix: [
      { group: 'claim', count: groupCounts.claim, dollarImpact: groupValue.claim },
      { group: 'check', count: groupCounts.check, dollarImpact: groupValue.check },
      { group: 'prevent', count: groupCounts.prevent, dollarImpact: groupValue.prevent },
    ],
    // Every check Reclaim runs, in a fixed order — including the ones that
    // found nothing, so the business can see the full audit that ran, not
    // just the rules that happened to trigger.
    exposureByType: FINDING_TYPE_ORDER.map((type) => {
      const value = exposureByType.get(type)
      return { type, count: value?.count ?? 0, dollarImpact: value?.dollarImpact ?? 0 }
    }),
    recoveryActiveCount,
    recoveryActiveValue,
    recoveredCount,
    recoveredValue,
    recoveredEstimate,
    newSinceLastVisitCount: env.newFindingIds.length,
    nextRecommendedCase: nextRecommended ? toCaseView(env, context, nextRecommended) : null,
    nextRecoveryCase: nextRecovery ? toCaseView(env, context, nextRecovery) : null,
  }
}

export interface FindingsQueueGroup {
  group: QueueGroup
  label: string
  cases: CaseView[]
}

const QUEUE_GROUP_ORDER: QueueGroup[] = ['claim', 'check', 'prevent']

/** Findings lens — every undecided (or needs-info) case, grouped by decision readiness. */
export function findingsQueue(env: LedgerEnvironment): FindingsQueueGroup[] {
  const context = contextOf(env)
  const active = env.result.findings.filter((f) => isInFindingsQueue(context.state(f)))
  return QUEUE_GROUP_ORDER.map((group) => {
    const cases = active
      .filter((f) => queueGroupFor(f, context.state(f)) === group)
      .sort((a, b) => b.dollarImpact - a.dollarImpact)
      .map((f) => toCaseView(env, context, f))
    return { group, label: QUEUE_GROUP_LABEL[group], cases }
  })
}

export interface RecoveryQueueGroup {
  stage: RecoveryStage
  label: string
  cases: CaseView[]
}

const RECOVERY_STAGE_ORDER: RecoveryStage[] = ['confirmed', 'requested', 'recovered', 'not_recovered']

/** Vendor recovery cases grouped by their explicit money outcome. */
export function recoveryQueue(env: LedgerEnvironment): RecoveryQueueGroup[] {
  const context = contextOf(env)
  const inRecovery = env.result.findings.filter((f) => {
    const state = context.state(f)
    return isInRecoveryQueue(state) && (eligiblePotential(context.finding(f), env.result.findings) !== null || verifiedReturned(state) > 0 || Boolean(state.approvedAt))
  })
  return RECOVERY_STAGE_ORDER.map((stage) => {
    const cases = inRecovery
      .filter((f) => context.state(f).recoveryStage === stage)
      .sort((a, b) => b.dollarImpact - a.dollarImpact)
      .map((f) => toCaseView(env, context, f))
    return { stage, label: RECOVERY_STAGE_LABEL[stage], cases }
  })
}
