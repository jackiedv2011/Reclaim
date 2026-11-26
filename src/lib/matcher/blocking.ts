import type { PreparedRecord } from './prepare.ts'
import type { MatcherLimits } from './config.ts'

/**
 * Candidate generation by blocking (indexing), never unrestricted all-pairs.
 *
 * Each payment emits at most five blocking keys:
 *   va|vendorKey|cents        same supplier identity, same amount to the cent
 *   pa|namePrefix|cents       same amount, supplier name shares a 3-letter word prefix
 *                             (one key for each of the first two name words), so a
 *                             renamed or misspelt supplier still meets its twin
 *   rd|digitCore              same reference digits ("INV-1001", "1001", "INV1001-A")
 *   rs|sortedDigits           same reference digits in any order (transposed digits)
 *
 * Only records that share a key are compared. A block with more than
 * `maxBlockSize` rows is not compared all-pairs: its rows are sorted by
 * payment date and each is compared with its next `neighbourWindow` rows
 * (sorted neighbourhood). So the number of pairs is bounded by
 *   n × keys(≤5) × max(maxBlockSize − 1, neighbourWindow)
 * i.e. O(n) for fixed limits, plus O(n log n) for sorting oversized blocks.
 * `maxPairsCompared` is a final hard stop; hitting it is reported, never silent.
 *
 * Known blind spots (documented, not hidden): a renamed supplier whose first
 * two name words both change in their first three letters, paid a different
 * amount, with no shared reference digits, is never compared.
 */

export interface BlockingStats {
  blocks: number
  oversizedBlocks: number
  largestBlock: number
  pairsGenerated: number
  truncated: boolean
}

export function blockingKeys(p: PreparedRecord): string[] {
  const keys = new Set<string>()
  keys.add(`va|${p.vendorKey}|${p.cents}`)
  for (const token of p.vendorTokens.slice(0, 2)) {
    if (token.length >= 3) keys.add(`pa|${token.slice(0, 3)}|${p.cents}`)
  }
  if (p.referenceDigits) {
    keys.add(`rd|${p.referenceDigits}`)
    if (p.referenceDigits.length >= 4) keys.add(`rs|${[...p.referenceDigits].sort().join('')}`)
  }
  return [...keys]
}

/**
 * Pairs of indexes into `prepared` (i < j) that share a blocking key, bounded by `limits`.
 * Output order is deterministic for a given input order.
 */
export function generateCandidatePairs(
  prepared: PreparedRecord[],
  limits: MatcherLimits
): { pairs: Array<[number, number]>; stats: BlockingStats } {
  const blocks = new Map<string, number[]>()
  prepared.forEach((p, index) => {
    for (const key of blockingKeys(p)) {
      const block = blocks.get(key)
      if (block) block.push(index)
      else blocks.set(key, [index])
    }
  })

  const n = prepared.length
  const seen = new Set<number>()
  const pairs: Array<[number, number]> = []
  const stats: BlockingStats = { blocks: blocks.size, oversizedBlocks: 0, largestBlock: 0, pairsGenerated: 0, truncated: false }

  const add = (a: number, b: number): boolean => {
    const i = Math.min(a, b)
    const j = Math.max(a, b)
    const key = i * n + j
    if (seen.has(key)) return true
    if (pairs.length >= limits.maxPairsCompared) {
      stats.truncated = true
      return false
    }
    seen.add(key)
    pairs.push([i, j])
    return true
  }

  // Sorted key order so the pair list (and any truncation) never depends on Map insertion quirks.
  const keys = [...blocks.keys()].sort()
  outer: for (const key of keys) {
    const members = blocks.get(key)!
    if (members.length < 2) continue
    stats.largestBlock = Math.max(stats.largestBlock, members.length)
    if (members.length <= limits.maxBlockSize) {
      for (let a = 0; a < members.length; a++) {
        for (let b = a + 1; b < members.length; b++) if (!add(members[a], members[b])) break outer
      }
      continue
    }
    stats.oversizedBlocks++
    const byDate = [...members].sort((x, y) => prepared[x].paymentDay - prepared[y].paymentDay || (prepared[x].id < prepared[y].id ? -1 : 1))
    for (let a = 0; a < byDate.length; a++) {
      const end = Math.min(byDate.length, a + 1 + limits.neighbourWindow)
      for (let b = a + 1; b < end; b++) if (!add(byDate[a], byDate[b])) break outer
    }
  }

  stats.pairsGenerated = pairs.length
  return { pairs, stats }
}
