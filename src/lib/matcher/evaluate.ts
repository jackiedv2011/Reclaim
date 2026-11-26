import type { Finding } from '../../types.ts'
import type { MatchCandidate } from '../../contracts/financial.ts'
import type { FixtureFile, Scenario } from './fixtures/generate.ts'
import { pairKey, pairsCoveredByFindings } from './matcher.ts'

/**
 * Pair-level evaluation against labelled synthetic fixtures.
 *
 * Review unit: one distinct record pair put in front of a reviewer. A
 * baseline finding with three related records counts as three pairs.
 * TP: a surfaced pair that is a labelled duplicate payment pair.
 * FP: a surfaced pair that is not. FN: a labelled pair not surfaced.
 */

export interface PairMetrics {
  reviewed: number
  tp: number
  fp: number
  fn: number
  /** tp / reviewed; null when nothing was reviewed. */
  precision: number | null
  /** tp / labelled pairs; null when there are no labelled pairs. */
  recall: number | null
}

export interface LabelledPair {
  key: string
  caseId: string
  scenario: Scenario
}

export interface FailureCase {
  kind: 'false_positive' | 'false_negative'
  recordIds: [string, string]
  /** Scenario(s) of the case(s) the records belong to. */
  scenarios: string[]
  source: 'baseline' | 'matcher' | 'neither'
}

export function truthPairs(file: FixtureFile): Map<string, LabelledPair> {
  return new Map(file.duplicatePairs.map((p) => [pairKey(p.a, p.b), { key: pairKey(p.a, p.b), caseId: p.caseId, scenario: p.scenario }]))
}

/** Pairs the unchanged detection engine surfaces as possible duplicates (exact_duplicate and near_duplicate findings). */
export function baselinePairs(findings: readonly Finding[]): string[] {
  return [...pairsCoveredByFindings(findings)].sort()
}

export function candidatePairs(candidates: readonly MatchCandidate[]): string[] {
  return candidates.map((c) => pairKey(c.sourceRecordIds[0], c.sourceRecordIds[1]))
}

export function metrics(surfaced: readonly string[], truth: ReadonlyMap<string, LabelledPair>): PairMetrics {
  const unique = new Set(surfaced)
  let tp = 0
  for (const key of unique) if (truth.has(key)) tp++
  const reviewed = unique.size
  return {
    reviewed,
    tp,
    fp: reviewed - tp,
    fn: truth.size - tp,
    precision: reviewed === 0 ? null : tp / reviewed,
    recall: truth.size === 0 ? null : tp / truth.size,
  }
}

export function recordScenarios(file: FixtureFile): Map<string, string> {
  const map = new Map<string, string>()
  for (const c of file.cases) for (const id of c.recordIds) map.set(id, c.scenario)
  return map
}

export function failureCases(
  file: FixtureFile,
  baseline: readonly string[],
  matcher: readonly string[]
): FailureCase[] {
  const truth = truthPairs(file)
  const scenarios = recordScenarios(file)
  const baseSet = new Set(baseline)
  const matchSet = new Set(matcher)
  const split = (key: string) => key.split('\u0000') as [string, string]
  const describe = (ids: [string, string]) => [...new Set(ids.map((id) => scenarios.get(id) ?? 'unknown'))].sort()
  const out: FailureCase[] = []
  for (const key of [...new Set([...baseline, ...matcher])].sort()) {
    if (truth.has(key)) continue
    const ids = split(key)
    out.push({ kind: 'false_positive', recordIds: ids, scenarios: describe(ids), source: baseSet.has(key) ? 'baseline' : 'matcher' })
  }
  for (const key of [...truth.keys()].sort()) {
    if (baseSet.has(key) || matchSet.has(key)) continue
    const ids = split(key)
    out.push({ kind: 'false_negative', recordIds: ids, scenarios: describe(ids), source: 'neither' })
  }
  return out
}
