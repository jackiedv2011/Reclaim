import { damerauLevenshteinDistance } from './stringDistance.ts'
import { normalizeAccountLast4, normalizeVendor } from './format.ts'

export type ConfidenceTier = 'auto_merge' | 'needs_review' | 'no_match'

export interface VendorMatch {
  vendorA: string
  vendorB: string
  tier: ConfidenceTier
  score: number
  reasons: string[]
}

export interface VendorGroup {
  canonicalName: string
  members: string[]
  tier: ConfidenceTier
}

export interface VendorResolutionResult {
  groups: VendorGroup[]
  /** Worked out on first read: importing only needs the groups, and on a long vendor list this can be large. */
  readonly needsReview: VendorMatch[]
  /** Maps an original vendor string to its resolved canonical name (identity if ungrouped). */
  resolveVendorName: (original: string) => string
}

export interface VendorRecordInput {
  vendor: string
  bankAccountLast4?: string | null
}

const VENDOR_LEGAL_SUFFIXES = new Set(['llc', 'inc', 'corp'])

/** Lowercase, strip all punctuation, and remove trailing legal-entity suffixes (LLC/Inc/Corp). */
export function normalizeVendorName(vendor: string): string {
  const cleaned = vendor
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const words = cleaned.split(' ').filter(Boolean)
  while (words.length > 1 && VENDOR_LEGAL_SUFFIXES.has(words[words.length - 1])) {
    words.pop()
  }
  return words.join(' ')
}

function tokenize(normalized: string): string[] {
  return normalized.split(' ').filter(Boolean)
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const token of setA) if (setB.has(token)) intersection++
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/**
 * Edit-distance tolerance grows with word length. Short tokens (<=2 chars) require
 * an exact match — otherwise unrelated short codes/numbers (e.g. "Vendor 1" vs
 * "Vendor 2") would be treated as spelling variants of one another.
 */
function wordEditThreshold(word: string): number {
  if (word.length <= 2) return 0
  return word.length <= 4 ? 1 : 2
}

/**
 * Longer than any real word in a vendor name. Past this a token is only ever
 * compared exactly: edit distance is quadratic in length, and a memo pasted
 * into the vendor column must not freeze the import.
 */
const MAX_FUZZY_TOKEN_LENGTH = 64

function tokensNearlyEqual(tokenA: string, tokenB: string): boolean {
  if (tokenA === tokenB) return true
  // Numbers identify: store 1042 and store 1043 are different vendors, not a typo.
  if (/\d/.test(tokenA) || /\d/.test(tokenB)) return false
  if (tokenA.length > MAX_FUZZY_TOKEN_LENGTH || tokenB.length > MAX_FUZZY_TOKEN_LENGTH) return false
  const maxDistance = Math.min(wordEditThreshold(tokenA), wordEditThreshold(tokenB))
  if (Math.abs(tokenA.length - tokenB.length) > maxDistance) return false
  return damerauLevenshteinDistance(tokenA, tokenB) <= maxDistance
}

type NearlyEqual = (tokenA: string, tokenB: string) => boolean

/** Greedy bipartite match of tokens allowing near-equal words (Damerau-Levenshtein within threshold). */
function fuzzyWordOverlap(a: string[], b: string[], nearlyEqual: NearlyEqual = tokensNearlyEqual): number {
  if (a.length === 0 && b.length === 0) return 1
  const remaining = [...b]
  let matched = 0
  for (const tokenA of a) {
    const idx = remaining.findIndex((tokenB) => nearlyEqual(tokenA, tokenB))
    if (idx !== -1) {
      matched++
      remaining.splice(idx, 1)
    }
  }
  return matched / Math.max(a.length, b.length)
}

const digitsOf = (tokens: string[]) => tokens.filter((t) => /\d/.test(t)).sort().join(' ')

/**
 * Two vendor names that read as one vendor keyed twice: the same once spaces
 * are ignored, or the same words bar a spelling slip. Any number in the names
 * must agree, so two locations of a chain are never near-identical.
 */
export function nearIdenticalVendorNames(a: string, b: string): boolean {
  const [nameA, nameB] = [normalizeVendor(a), normalizeVendor(b)]
  if (nameA === nameB) return true
  const [tokensA, tokensB] = [tokenize(nameA), tokenize(nameB)]
  if (digitsOf(tokensA) !== digitsOf(tokensB)) return false
  if (tokensA.join('') === tokensB.join('')) return true
  return Math.max(jaccardSimilarity(new Set(tokensA), new Set(tokensB)), fuzzyWordOverlap(tokensA, tokensB)) >= AUTO_MERGE_NAME_SCORE
}

type BankSignal = 'match' | 'mismatch' | 'unknown'

function bankAccountSignal(accountsA: Set<string>, accountsB: Set<string>): BankSignal {
  if (accountsA.size === 0 || accountsB.size === 0) return 'unknown'
  for (const account of accountsA) {
    if (accountsB.has(account)) return 'match'
  }
  return 'mismatch'
}

const AUTO_MERGE_NAME_SCORE = 0.75
const NEEDS_REVIEW_NAME_SCORE = 0.4
const BANK_ASSISTED_NAME_SCORE = 0.45

function classifyPair(
  normA: string,
  normB: string,
  tokensA: string[],
  tokensB: string[],
  bankSignal: BankSignal,
  setA: Set<string>,
  setB: Set<string>,
  nearlyEqual: NearlyEqual
): { tier: ConfidenceTier; score: number; reasons: string[] } {
  if (normA === normB) {
    return { tier: 'auto_merge', score: 1, reasons: ['exact match after normalization'] }
  }

  const jaccard = jaccardSimilarity(setA, setB)
  const fuzzy = fuzzyWordOverlap(tokensA, tokensB, nearlyEqual)
  const nameScore = Math.max(jaccard, fuzzy)

  const reasons: string[] = []
  if (jaccard > 0) reasons.push(`token Jaccard similarity ${jaccard.toFixed(2)}`)
  if (fuzzy > jaccard) reasons.push(`fuzzy word similarity ${fuzzy.toFixed(2)} (Damerau-Levenshtein)`)
  if (bankSignal === 'match') reasons.push('shared bank account on record')
  if (bankSignal === 'mismatch') reasons.push('conflicting bank accounts on record')

  // Conflicting bank data is an independent negative signal: block a confident
  // auto-merge unless the names alone are strong enough to stand on their own.
  if (bankSignal === 'mismatch' && nameScore < AUTO_MERGE_NAME_SCORE) {
    return {
      tier: nameScore >= NEEDS_REVIEW_NAME_SCORE ? 'needs_review' : 'no_match',
      score: nameScore,
      reasons,
    }
  }

  if (nameScore >= AUTO_MERGE_NAME_SCORE) {
    return { tier: 'auto_merge', score: nameScore, reasons }
  }
  if (bankSignal === 'match' && nameScore >= BANK_ASSISTED_NAME_SCORE) {
    return { tier: 'auto_merge', score: nameScore, reasons }
  }
  if (nameScore >= NEEDS_REVIEW_NAME_SCORE || bankSignal === 'match') {
    return { tier: 'needs_review', score: nameScore, reasons }
  }
  return { tier: 'no_match', score: nameScore, reasons }
}

class UnionFind {
  private parent: number[]
  private rank: number[]

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, i) => i)
    this.rank = new Array(size).fill(0)
  }

  find(x: number): number {
    if (this.parent[x] !== x) this.parent[x] = this.find(this.parent[x])
    return this.parent[x]
  }

  union(a: number, b: number): void {
    const rootA = this.find(a)
    const rootB = this.find(b)
    if (rootA === rootB) return
    if (this.rank[rootA] < this.rank[rootB]) {
      this.parent[rootA] = rootB
    } else if (this.rank[rootA] > this.rank[rootB]) {
      this.parent[rootB] = rootA
    } else {
      this.parent[rootB] = rootA
      this.rank[rootA]++
    }
  }
}

/** Every way of dropping up to `depth` characters from a word. Two words within that many edits always share one. */
function deletions(word: string, depth: number): Set<string> {
  const all = new Set([word])
  let frontier = [word]
  for (let step = 0; step < depth; step++) {
    const next: string[] = []
    for (const current of frontier) {
      for (let i = 0; i < current.length; i++) {
        const shorter = current.slice(0, i) + current.slice(i + 1)
        if (!all.has(shorter)) {
          all.add(shorter)
          next.push(shorter)
        }
      }
    }
    frontier = next
  }
  return all
}

/** For each word used in any vendor name, the words that count as the same word (itself included). */
function nearWords(words: Iterable<string>): Map<string, Set<string>> {
  const near = new Map<string, Set<string>>()
  const byDeletion = new Map<string, string[]>()
  for (const word of words) {
    near.set(word, new Set([word]))
    if (/\d/.test(word) || word.length > MAX_FUZZY_TOKEN_LENGTH) continue
    const depth = wordEditThreshold(word)
    if (depth === 0) continue
    for (const key of deletions(word, depth)) {
      const sharing = byDeletion.get(key)
      if (!sharing) {
        byDeletion.set(key, [word])
        continue
      }
      for (const other of sharing) {
        if (near.get(word)!.has(other) || !tokensNearlyEqual(word, other)) continue
        near.get(word)!.add(other)
        near.get(other)!.add(word)
      }
      sharing.push(word)
    }
  }
  return near
}

/**
 * Pairs of names that could reach `minScore`, without comparing every pair. A
 * pair that scores s shares at least s of each name's words, so it must share
 * one of any (words - shared + 1) of them: looking up only that many of the
 * name's rarest words finds every such pair. Exact, not a heuristic.
 */
function candidatePairs(indices: number[], tokensByName: string[][], near: Map<string, Set<string>>, minScore: number, visit: (i: number, j: number) => void): void {
  const namesWith = new Map<string, number[]>()
  for (const i of indices) {
    for (const token of new Set(tokensByName[i])) {
      const list = namesWith.get(token)
      if (list) list.push(i)
      else namesWith.set(token, [i])
    }
  }
  const spread = new Map<string, number>()
  for (const token of namesWith.keys()) {
    let count = 0
    for (const other of near.get(token)!) count += namesWith.get(other)?.length ?? 0
    spread.set(token, count)
  }
  const probesNeeded = (words: number) => words - Math.ceil(minScore * words - 1e-9) + 1
  // Each pair is looked for from its earlier name; that name alone is enough to find it.
  for (const i of indices) {
    const distinct = [...new Set(tokensByName[i])].sort((a, b) => spread.get(a)! - spread.get(b)!)
    const probes = distinct.slice(0, Math.max(probesNeeded(distinct.length), probesNeeded(tokensByName[i].length)))
    const seen = new Set<number>()
    for (const token of probes) {
      for (const other of near.get(token)!) {
        for (const j of namesWith.get(other) ?? []) {
          if (j <= i || seen.has(j)) continue
          seen.add(j)
          visit(i, j)
        }
      }
    }
  }
}

/** Groups vendor names that likely refer to the same real vendor. */
export function resolveVendors(records: VendorRecordInput[]): VendorResolutionResult {
  const uniqueNames: string[] = []
  const indexByName = new Map<string, number>()
  const bankAccountsByName: Set<string>[] = []
  const frequencyByName: number[] = []
  const firstSeenOrder: number[] = []

  records.forEach((record, order) => {
    let index = indexByName.get(record.vendor)
    if (index === undefined) {
      index = uniqueNames.length
      indexByName.set(record.vendor, index)
      uniqueNames.push(record.vendor)
      bankAccountsByName.push(new Set())
      frequencyByName.push(0)
      firstSeenOrder.push(order)
    }
    frequencyByName[index]++
    const account = normalizeAccountLast4(record.bankAccountLast4 ?? null)
    if (account) bankAccountsByName[index].add(account)
  })

  const normalizedNames = uniqueNames.map(normalizeVendorName)
  const tokensByName = normalizedNames.map(tokenize)

  const tokenSets = tokensByName.map((tokens) => new Set(tokens))
  const near = nearWords(new Set(tokensByName.flat()))
  const nearlyEqual: NearlyEqual = (a, b) => a === b || near.get(a)!.has(b)
  const classify = (i: number, j: number) =>
    classifyPair(normalizedNames[i], normalizedNames[j], tokensByName[i], tokensByName[j], bankAccountSignal(bankAccountsByName[i], bankAccountsByName[j]), tokenSets[i], tokenSets[j], nearlyEqual)

  const uf = new UnionFind(uniqueNames.length)
  const mergeIfSame = (i: number, j: number) => {
    if (uf.find(i) !== uf.find(j) && classify(i, j).tier === 'auto_merge') uf.union(i, j)
  }
  const everyName = uniqueNames.map((_, i) => i)
  const namesByKey = new Map<string, number>()
  for (const i of everyName) {
    const twin = namesByKey.get(normalizedNames[i])
    if (twin === undefined) namesByKey.set(normalizedNames[i], i)
    else uf.union(twin, i)
  }
  candidatePairs(everyName, tokensByName, near, AUTO_MERGE_NAME_SCORE, mergeIfSame)
  // A shared bank account lowers the bar, so those names are compared again among themselves.
  const namesByAccount = new Map<string, number[]>()
  bankAccountsByName.forEach((accounts, i) => {
    for (const account of accounts) {
      const list = namesByAccount.get(account)
      if (list) list.push(i)
      else namesByAccount.set(account, [i])
    }
  })
  for (const sharing of namesByAccount.values()) {
    if (sharing.length > 1) candidatePairs(sharing, tokensByName, near, BANK_ASSISTED_NAME_SCORE, mergeIfSame)
  }

  const membersByRoot = new Map<number, number[]>()
  for (let i = 0; i < uniqueNames.length; i++) {
    const root = uf.find(i)
    const members = membersByRoot.get(root)
    if (members) members.push(i)
    else membersByRoot.set(root, [i])
  }

  const canonicalByName = new Map<string, string>()
  const groups: VendorGroup[] = []

  for (const memberIndices of membersByRoot.values()) {
    const members = memberIndices.map((i) => uniqueNames[i])
    const canonicalName = [...memberIndices].sort((a, b) => {
      const frequencyDiff = frequencyByName[b] - frequencyByName[a]
      if (frequencyDiff !== 0) return frequencyDiff
      return firstSeenOrder[a] - firstSeenOrder[b]
    })
      .map((i) => uniqueNames[i])[0]

    for (const member of members) canonicalByName.set(member, canonicalName)
    if (members.length > 1) {
      groups.push({ canonicalName, members, tier: 'auto_merge' })
    }
  }

  /** Pairs worth a person's look, less those whose members already ended up in the same group. */
  const pairsToReview = (): VendorMatch[] => {
    const pairs = new Map<string, [number, number]>()
    const add = (i: number, j: number) => {
      if (uf.find(i) !== uf.find(j)) pairs.set(`${i}|${j}`, [i, j])
    }
    candidatePairs(everyName, tokensByName, near, NEEDS_REVIEW_NAME_SCORE, add)
    for (const sharing of namesByAccount.values()) {
      for (let a = 0; a < sharing.length; a++) for (let b = a + 1; b < sharing.length; b++) add(sharing[a], sharing[b])
    }
    return [...pairs.values()]
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .flatMap(([i, j]) => {
        const { tier, score, reasons } = classify(i, j)
        return tier === 'needs_review' ? [{ vendorA: uniqueNames[i], vendorB: uniqueNames[j], tier, score, reasons }] : []
      })
  }
  let review: VendorMatch[] | null = null

  return {
    groups,
    get needsReview() {
      return (review ??= pairsToReview())
    },
    resolveVendorName: (original: string) => canonicalByName.get(original) ?? original,
  }
}
