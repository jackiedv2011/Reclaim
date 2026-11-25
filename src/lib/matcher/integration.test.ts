// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detectFindings } from '../detection.ts'
import { MATCHER_FLAG } from './config.ts'
import { detectWithOptionalMatcher, runMatcherExperiment } from './matcher.ts'
import { generateLedger, generateSplit, serializeFixture, splitWordPools, toAPRecords, type FixtureFile } from './fixtures/generate.ts'

const fixtureUrl = (split: string) => new URL(`./fixtures/${split}.json`, import.meta.url)
/** Findings carry a wall-clock createdAt; compare everything else. */
const stable = (findings: readonly object[]) => findings.map((f) => ({ ...f, createdAt: 0 }))
const load = (split: 'dev' | 'heldout'): FixtureFile => JSON.parse(readFileSync(fixtureUrl(split), 'utf8')) as FixtureFile

describe('frozen fixtures', () => {
  const dev = load('dev')
  const heldout = load('heldout')

  it('match what the seeded generator produces', () => {
    expect(readFileSync(fixtureUrl('dev'), 'utf8')).toBe(serializeFixture(generateSplit('dev')))
    expect(readFileSync(fixtureUrl('heldout'), 'utf8')).toBe(serializeFixture(generateSplit('heldout')))
  })

  it('keep dev and held-out groups, suppliers and records disjoint', () => {
    const groups = (f: FixtureFile) => new Set(f.cases.map((c) => c.group))
    const vendors = (f: FixtureFile) => new Set(f.records.map((r) => r.vendor.toLowerCase()))
    const firstWords = (f: FixtureFile) => new Set(f.records.map((r) => r.vendor.toLowerCase().split(/\s+/)[0]))
    const overlap = <T>(a: Set<T>, b: Set<T>) => [...a].filter((x) => b.has(x))
    expect(overlap(groups(dev), groups(heldout))).toEqual([])
    expect(overlap(vendors(dev), vendors(heldout))).toEqual([])
    expect(overlap(firstWords(dev), firstWords(heldout))).toEqual([])
    expect(overlap(new Set(dev.records.map((r) => r.id)), new Set(heldout.records.map((r) => r.id)))).toEqual([])
    const pools = splitWordPools()
    expect(overlap(new Set(pools.dev), new Set(pools.heldout))).toEqual([])
  })

  it('cover every required scenario family in both splits', () => {
    for (const f of [dev, heldout]) {
      const scenarios = new Set(f.cases.map((c) => c.scenario))
      for (const s of [
        'vendor_suffix_rename',
        'vendor_typo',
        'ref_suffix_late_repay',
        'ref_transposed_late',
        'recurring_equal_amount',
        'overlapping_export',
        'partial_payments',
        'void_and_reissue',
        'adjustment_payment',
        'refunded_duplicate',
        'missing_invoice_date_late',
        'alias_no_reference',
      ]) {
        expect(scenarios, `${f.split} missing ${s}`).toContain(s)
      }
      expect(f.duplicatePairs.length).toBeGreaterThan(0)
    }
  })
})

describe('matcher never touches findings', () => {
  const records = toAPRecords(load('dev'))

  it('leaves findings deep-equal and adds nothing with an amount', () => {
    const detection = detectFindings(records)
    const before = structuredClone(detection.findings)
    const run = runMatcherExperiment(records, detection.findings)
    expect(detection.findings).toEqual(before)
    expect(run.candidates.length).toBeGreaterThan(0)
    for (const c of run.candidates) {
      expect(c).not.toHaveProperty('amountMinor')
      expect(c).not.toHaveProperty('potentialAmountMinor')
      expect(c).not.toHaveProperty('dollarImpact')
      expect(c).not.toHaveProperty('eligibility')
      expect(c.status).toBe('candidate')
      for (const f of c.features) expect(f.detail).not.toContain('$')
    }
  })

  it('detectWithOptionalMatcher is detection unchanged, with candidates only when enabled', () => {
    const plain = detectFindings(records)
    const off = detectWithOptionalMatcher(records, { env: {} })
    expect(off.matchCandidates).toEqual([])
    expect(stable(off.detection.findings)).toEqual(stable(plain.findings))
    const on = detectWithOptionalMatcher(records, { env: { [MATCHER_FLAG]: 'true' } })
    expect(stable(on.detection.findings)).toEqual(stable(plain.findings))
    expect(on.matchCandidates.length).toBeGreaterThan(0)
    expect(detectWithOptionalMatcher(records, { env: { [MATCHER_FLAG]: 'true' }, enabled: false }).matchCandidates).toEqual([])
  })

  it('is deterministic, including for shuffled input order', () => {
    const findings = detectFindings(records).findings
    const first = runMatcherExperiment(records, findings)
    const again = runMatcherExperiment(records, findings)
    expect(again).toEqual(first)
    const reversed = runMatcherExperiment([...records].reverse(), findings)
    expect(reversed.candidates).toEqual(first.candidates)
  })
})

describe('performance smoke', () => {
  it('handles about 10k rows in a few seconds with bounded pairs', () => {
    const records = toAPRecords(generateLedger({ split: 'perf', seed: 9_001, targetRows: 10_000 }))
    expect(records.length).toBeGreaterThanOrEqual(9_000)
    const t = performance.now()
    const run = runMatcherExperiment(records, [])
    const ms = performance.now() - t
    expect(ms).toBeLessThan(5_000)
    expect(run.stats.blocking.truncated).toBe(false)
    expect(run.stats.blocking.pairsGenerated).toBeLessThan(records.length * 5 * 40)
  }, 30_000)
})
