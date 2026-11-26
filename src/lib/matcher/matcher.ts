import type { APRecord, Finding } from '../../types.ts'
import type { MatchCandidate } from '../../contracts/financial.ts'
import { detectFindings, type DetectionResultWithRecurring } from '../detection.ts'
import { DEFAULT_LIMITS, MATCHER_VERSION, SCORE_THRESHOLD, isMatcherEnabled, type MatcherLimits } from './config.ts'
import { prepareRecord, type PreparedRecord } from './prepare.ts'
import { generateCandidatePairs, type BlockingStats } from './blocking.ts'
import { buildLedgerContext, exclusionFor, EXCLUSION_REASONS, type ExclusionReason, type LedgerContext } from './exclusions.ts'
import { scorePair, type PairScore } from './features.ts'

/**
 * Intelligent record matching, experiment C2.
 *
 * Proposes ADDITIONAL review candidates: pairs of payments that may settle the
 * same obligation and that detection's exact/near duplicate rules did not
 * already surface. It is strictly additive and read-only:
 * - it never removes, edits, re-ranks or suppresses a finding;
 * - a candidate carries no amount, no dollar impact and no eligibility;
 * - candidates are hints for a reviewer, never claims. Anything that reaches
 *   recovery still has to pass the deterministic evidence gate
 *   (src/recovery/eligibility.ts), which this module does not call or bypass.
 */

export interface MatcherOptions {
  limits?: Partial<MatcherLimits>
  threshold?: number
}

export interface MatcherStats {
  records: number
  paymentsConsidered: number
  blocking: BlockingStats
  excluded: Record<ExclusionReason, number>
  pairsScored: number
  aboveThreshold: number
  alreadyCoveredByFindings: number
  droppedByPerRecordCap: number
  droppedByCandidateCap: number
  returned: number
}

export interface MatcherExperimentResult {
  algorithmVersion: string
  threshold: number
  candidates: MatchCandidate[]
  stats: MatcherStats
}

/** Finding types whose related records are already in front of a reviewer as a possible duplicate pair. */
const DUPLICATE_FINDING_TYPES = new Set<Finding['type']>(['exact_duplicate', 'near_duplicate'])

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

/** Every record-id pair inside an exact or near duplicate finding. */
export function pairsCoveredByFindings(findings: readonly Finding[]): Set<string> {
  const covered = new Set<string>()
  for (const f of findings) {
    if (!DUPLICATE_FINDING_TYPES.has(f.type)) continue
    const ids = f.relatedRecords.map((r) => r.id)
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (ids[i] !== ids[j]) covered.add(pairKey(ids[i], ids[j]))
  }
  return covered
}

const byId = (a: PreparedRecord, b: PreparedRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Earlier payment first, then id, so a candidate reads in the order the money went out. */
function orderPair(a: PreparedRecord, b: PreparedRecord): [PreparedRecord, PreparedRecord] {
  if (a.paymentDay !== b.paymentDay) return a.paymentDay < b.paymentDay ? [a, b] : [b, a]
  return byId(a, b) <= 0 ? [a, b] : [b, a]
}

/** Ledger-wide state the matcher needs; build once and reuse for many pair assessments. */
export interface MatcherIndex {
  prepared: PreparedRecord[]
  byRecordId: Map<string, PreparedRecord>
  context: LedgerContext
}

export function buildMatcherIndex(records: readonly APRecord[]): MatcherIndex {
  const prepared = records.map(prepareRecord).sort(byId)
  return { prepared, byRecordId: new Map(prepared.map((p) => [p.id, p])), context: buildLedgerContext(prepared) }
}

/**
 * Score one pair by record id, applying the same exclusions as a full run.
 * Used by the benchmark to rank pairs; returns null for unknown ids or non-payments.
 */
export function assessPair(index: MatcherIndex, idA: string, idB: string): { excluded: ExclusionReason } | PairScore | null {
  const a = index.byRecordId.get(idA)
  const b = index.byRecordId.get(idB)
  if (!a || !b || a.kind !== 'payment' || b.kind !== 'payment') return null
  const excluded = exclusionFor(a, b, index.context)
  return excluded ? { excluded } : scorePair(a, b)
}

export function runMatcherExperiment(
  records: readonly APRecord[],
  findings: readonly Finding[],
  opts: MatcherOptions = {}
): MatcherExperimentResult {
  const limits: MatcherLimits = { ...DEFAULT_LIMITS, ...opts.limits }
  const threshold = opts.threshold ?? SCORE_THRESHOLD
  const index = buildMatcherIndex(records)
  const payments = index.prepared.filter((p) => p.kind === 'payment')
  const { pairs, stats: blocking } = generateCandidatePairs(payments, limits)
  const covered = pairsCoveredByFindings(findings)

  const excluded = Object.fromEntries(EXCLUSION_REASONS.map((r) => [r, 0])) as Record<ExclusionReason, number>
  let pairsScored = 0
  let alreadyCovered = 0
  const kept: Array<{ a: PreparedRecord; b: PreparedRecord; key: string; result: PairScore }> = []

  for (const [i, j] of pairs) {
    const a = payments[i]
    const b = payments[j]
    const reason = exclusionFor(a, b, index.context)
    if (reason) {
      excluded[reason]++
      continue
    }
    pairsScored++
    const result = scorePair(a, b)
    if (result.score < threshold) continue
    const key = pairKey(a.id, b.id)
    if (covered.has(key)) {
      alreadyCovered++
      continue
    }
    const [first, second] = orderPair(a, b)
    kept.push({ a: first, b: second, key, result })
  }

  kept.sort((x, y) => y.result.score - x.result.score || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))

  const perRecord = new Map<string, number>()
  const candidates: MatchCandidate[] = []
  let droppedByPerRecordCap = 0
  let droppedByCandidateCap = 0
  for (const { a, b, result } of kept) {
    if ((perRecord.get(a.id) ?? 0) >= limits.maxCandidatesPerRecord || (perRecord.get(b.id) ?? 0) >= limits.maxCandidatesPerRecord) {
      droppedByPerRecordCap++
      continue
    }
    if (candidates.length >= limits.maxCandidates) {
      droppedByCandidateCap++
      continue
    }
    perRecord.set(a.id, (perRecord.get(a.id) ?? 0) + 1)
    perRecord.set(b.id, (perRecord.get(b.id) ?? 0) + 1)
    candidates.push({
      candidateId: `${MATCHER_VERSION}:${a.id}:${b.id}`,
      sourceRecordIds: [a.id, b.id],
      score: result.score,
      features: result.features,
      algorithmVersion: MATCHER_VERSION,
      evidenceGaps: result.evidenceGaps,
      status: 'candidate',
    })
  }

  return {
    algorithmVersion: MATCHER_VERSION,
    threshold,
    candidates,
    stats: {
      records: records.length,
      paymentsConsidered: payments.length,
      blocking,
      excluded,
      pairsScored,
      aboveThreshold: kept.length + alreadyCovered,
      alreadyCoveredByFindings: alreadyCovered,
      droppedByPerRecordCap,
      droppedByCandidateCap,
      returned: candidates.length,
    },
  }
}

export interface DetectWithMatcherOptions extends MatcherOptions {
  /** Explicit on/off; when omitted the RECLAIM_EXPERIMENT_RECORD_MATCHER flag decides (default off). */
  enabled?: boolean
  env?: Record<string, string | undefined>
}

/**
 * Detection exactly as today, plus the experiment's additional candidates when
 * the flag is on. `detection` is the unchanged output of detectFindings.
 */
export function detectWithOptionalMatcher(
  records: APRecord[],
  opts: DetectWithMatcherOptions = {}
): { detection: DetectionResultWithRecurring; matchCandidates: MatchCandidate[] } {
  const detection = detectFindings(records)
  if (!isMatcherEnabled(opts.env, opts.enabled)) return { detection, matchCandidates: [] }
  const { candidates } = runMatcherExperiment(records, detection.findings, opts)
  return { detection, matchCandidates: candidates }
}
