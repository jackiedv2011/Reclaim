/**
 * Benchmark for the intelligent record matching experiment (C2).
 *
 *   node scripts/matcher-benchmark.ts                     # dev + held-out + perf (1k, 10k, 50k), JSON to stdout
 *   node scripts/matcher-benchmark.ts --split dev         # DEV only (use this while tuning weights)
 *   node scripts/matcher-benchmark.ts --no-perf --out <file.json>
 *   node scripts/matcher-benchmark.ts --freeze-fixtures   # regenerate the frozen dev.json / heldout.json
 *
 * Synthetic data only. No network, no database, no .env.
 * Baseline = unchanged detectFindings (pairs from exact_duplicate and
 * near_duplicate findings). Matcher arm = baseline + additional candidates.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { detectFindings } from '../src/lib/detection.ts'
import { runMatcherExperiment, buildMatcherIndex, assessPair, pairKey } from '../src/lib/matcher/matcher.ts'
import { MATCHER_VERSION, SCORE_THRESHOLD } from '../src/lib/matcher/config.ts'
import { baselinePairs, candidatePairs, failureCases, metrics, truthPairs, type PairMetrics } from '../src/lib/matcher/evaluate.ts'
import {
  generateLedger,
  generateSplit,
  serializeFixture,
  toAPRecords,
  POSITIVE_SCENARIOS,
  NEGATIVE_SCENARIOS,
  type FixtureFile,
} from '../src/lib/matcher/fixtures/generate.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = resolve(here, '../src/lib/matcher/fixtures')
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function round(value: number | null, digits = 4): number | null {
  return value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits
}

function roundMetrics(m: PairMetrics): PairMetrics {
  return { ...m, precision: round(m.precision), recall: round(m.recall) }
}

// ---------------------------------------------------------------- freeze

if (flag('--freeze-fixtures')) {
  for (const split of ['dev', 'heldout'] as const) {
    const file = generateSplit(split)
    writeFileSync(resolve(fixtureDir, `${split}.json`), serializeFixture(file))
    process.stderr.write(`wrote ${split}.json: ${file.records.length} records, ${file.cases.length} cases, ${file.duplicatePairs.length} labelled pairs\n`)
  }
  process.exit(0)
}

// ---------------------------------------------------------------- perf child

if (option('--perf-only')) {
  const rows = Number(option('--perf-only'))
  const file = generateLedger({ split: 'perf', seed: 9_001, targetRows: rows })
  const records = toAPRecords(file)
  const heapBefore = process.memoryUsage().heapUsed
  let t = performance.now()
  const detection = detectFindings(records)
  const detectMs = performance.now() - t
  t = performance.now()
  const run = runMatcherExperiment(records, detection.findings)
  const matcherMs = performance.now() - t
  const usage = process.memoryUsage()
  process.stdout.write(
    JSON.stringify({
      requestedRows: rows,
      records: records.length,
      detectFindingsMs: Math.round(detectMs),
      matcherMs: Math.round(matcherMs),
      pairsCompared: run.stats.blocking.pairsGenerated,
      blocks: run.stats.blocking.blocks,
      oversizedBlocks: run.stats.blocking.oversizedBlocks,
      largestBlock: run.stats.blocking.largestBlock,
      truncated: run.stats.blocking.truncated,
      candidates: run.candidates.length,
      heapUsedAfterMB: Math.round(usage.heapUsed / 1e6),
      heapGrowthDuringRunMB: Math.round((usage.heapUsed - heapBefore) / 1e6),
      peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
    })
  )
  process.exit(0)
}

// ---------------------------------------------------------------- accuracy

function loadFixture(split: 'dev' | 'heldout'): FixtureFile {
  return JSON.parse(readFileSync(resolve(fixtureDir, `${split}.json`), 'utf8')) as FixtureFile
}

function evaluateSplit(split: 'dev' | 'heldout') {
  const file = loadFixture(split)
  const records = toAPRecords(file)
  const truth = truthPairs(file)

  let t = performance.now()
  const detection = detectFindings(records)
  const detectMs = performance.now() - t
  const findingsBefore = JSON.stringify(detection.findings)

  t = performance.now()
  const run = runMatcherExperiment(records, detection.findings)
  const matcherMs = performance.now() - t
  const findingsUnchanged = JSON.stringify(detection.findings) === findingsBefore

  const base = baselinePairs(detection.findings)
  const extra = candidatePairs(run.candidates)
  const baseSet = new Set(base)
  const B = base.length

  const budgets = [
    { label: 'B (baseline workload)', size: B },
    { label: 'B + 10%', size: Math.ceil(B * 1.1) },
    { label: 'B + 25%', size: Math.ceil(B * 1.25) },
    { label: 'unlimited (all candidates)', size: B + extra.length },
  ].map(({ label, size }) => {
    const surfaced = [...base, ...extra.slice(0, Math.max(0, size - B))]
    return { label, budget: size, matcherSlotsUsed: Math.min(extra.length, Math.max(0, size - B)), ...roundMetrics(metrics(surfaced, truth)) }
  })

  // Counterfactual only: the product never re-ranks or drops findings. If a reviewer had
  // exactly B slots and filled them from (baseline pairs ∪ candidates) by matcher score,
  // what would they catch? Pairs the matcher excludes rank last.
  const index = buildMatcherIndex(records)
  const scoreOf = (key: string) => {
    const [a, b] = key.split('\u0000')
    const result = assessPair(index, a, b)
    return result === null || 'excluded' in result ? -Infinity : result.score
  }
  const union = [...new Set([...base, ...extra])].map((key) => ({ key, score: scoreOf(key), fromBaseline: baseSet.has(key) }))
  union.sort((x, y) => y.score - x.score || (x.fromBaseline === y.fromBaseline ? (x.key < y.key ? -1 : 1) : x.fromBaseline ? -1 : 1))
  const swapAtB = roundMetrics(metrics(union.slice(0, B).map((u) => u.key), truth))

  // Rule 8 (shared_invoice_number) is not part of the duplicate baseline, but it can already
  // put a renamed supplier's repeated invoice number in front of a reviewer.
  const rule8 = new Set<string>()
  for (const f of detection.findings) {
    if (f.type !== 'shared_invoice_number') continue
    const ids = f.relatedRecords.map((r) => r.id)
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) rule8.add(pairKey(ids[i], ids[j]))
  }
  const matcherTp = extra.filter((k) => truth.has(k))

  const byScenario: Record<string, { labelledPairs: number; baselineTp: number; matcherAdditionalTp: number; baselineFp: number; matcherFp: number }> = {}
  for (const s of [...POSITIVE_SCENARIOS, ...NEGATIVE_SCENARIOS]) byScenario[s] = { labelledPairs: 0, baselineTp: 0, matcherAdditionalTp: 0, baselineFp: 0, matcherFp: 0 }
  for (const p of truth.values()) {
    byScenario[p.scenario].labelledPairs++
    if (baseSet.has(p.key)) byScenario[p.scenario].baselineTp++
    else if (extra.includes(p.key)) byScenario[p.scenario].matcherAdditionalTp++
  }
  const failures = failureCases(file, base, extra)
  for (const f of failures) {
    if (f.kind !== 'false_positive') continue
    for (const s of f.scenarios) {
      if (!byScenario[s]) continue
      if (f.source === 'baseline') byScenario[s].baselineFp++
      else byScenario[s].matcherFp++
    }
  }

  return {
    split,
    records: records.length,
    cases: file.cases.length,
    labelledDuplicatePairs: truth.size,
    findingsUnchangedByMatcher: findingsUnchanged,
    candidatesCarryNoAmounts: run.candidates.every((c) => !('amountMinor' in c) && !('potentialAmountMinor' in c) && !('dollarImpact' in c)),
    baseline: roundMetrics(metrics(base, truth)),
    matcherOnly: roundMetrics(metrics(extra, truth)),
    baselinePlusMatcher: roundMetrics(metrics([...base, ...extra], truth)),
    budgets,
    counterfactualSwapAtBaselineBudget: swapAtB,
    matcherTpAlsoInRule8Findings: matcherTp.filter((k) => rule8.has(k)).length,
    matcherStats: run.stats,
    runtimeMs: { detectFindings: Math.round(detectMs), matcher: Math.round(matcherMs) },
    byScenario,
    failureCases: failures,
  }
}

function perfRun(rows: number) {
  const script = fileURLToPath(import.meta.url)
  const child = spawnSync(process.execPath, [script, '--perf-only', String(rows)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (child.status !== 0) throw new Error(`perf run for ${rows} rows failed: ${child.stderr}`)
  return JSON.parse(child.stdout) as Record<string, unknown>
}

const splitArg = option('--split') ?? 'all'
const splits = splitArg === 'all' ? (['dev', 'heldout'] as const) : ([splitArg] as Array<'dev' | 'heldout'>)
const sizes = (option('--sizes') ?? '1000,10000,50000').split(',').map(Number)

const report = {
  algorithmVersion: MATCHER_VERSION,
  threshold: SCORE_THRESHOLD,
  node: process.version,
  generatedAt: new Date().toISOString(),
  syntheticDataOnly: true,
  splits: splits.map(evaluateSplit),
  performance: flag('--no-perf') ? [] : sizes.map(perfRun),
}

const json = JSON.stringify(report, null, 2)
const out = option('--out')
if (out) {
  writeFileSync(out, json)
  process.stderr.write(`wrote ${out}\n`)
} else {
  process.stdout.write(`${json}\n`)
}
