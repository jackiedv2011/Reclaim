/**
 * Intelligent record matching (experiment C2): configuration.
 *
 * Everything here is deterministic and transparent: a fixed set of blocking
 * keys, hand-set feature weights and a score threshold. Nothing is learned at
 * run time and nothing leaves the process.
 *
 * Weights and the threshold were tuned on the synthetic DEV split only
 * (src/lib/matcher/fixtures/dev.json). The HELD-OUT split is evaluated with
 * these frozen values; changing a weight after looking at held-out results
 * invalidates that evaluation (see docs/workstream/matcher-benchmark.md).
 */

export const MATCHER_VERSION = 'record-matcher-0.1.0' as const
export const MATCHER_FLAG = 'RECLAIM_EXPERIMENT_RECORD_MATCHER' as const

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

type Env = Record<string, string | undefined>

function processEnv(): Env {
  const proc = (globalThis as { process?: { env?: Env } }).process
  return proc?.env ?? {}
}

/**
 * Off unless explicitly turned on. An explicit boolean override wins; otherwise
 * the flag must be set to a truthy word ("1", "true", "yes", "on").
 */
export function isMatcherEnabled(env?: Env, override?: boolean): boolean {
  if (typeof override === 'boolean') return override
  const value = (env ?? processEnv())[MATCHER_FLAG]
  return value !== undefined && TRUTHY.has(value.trim().toLowerCase())
}

/** Bounds that keep candidate generation sub-quadratic. */
export interface MatcherLimits {
  /** A block larger than this is not compared all-pairs; each row is compared only with its nearest neighbours by payment date. */
  maxBlockSize: number
  /** Neighbours compared on each side inside an oversized block (sorted-neighbourhood window). */
  neighbourWindow: number
  /** Hard cap on distinct pairs compared in one run. */
  maxPairsCompared: number
  /** Hard cap on candidates returned. */
  maxCandidates: number
  /** A record appears in at most this many returned candidates (highest score first). */
  maxCandidatesPerRecord: number
}

export const DEFAULT_LIMITS: MatcherLimits = {
  maxBlockSize: 40,
  neighbourWindow: 8,
  maxPairsCompared: 2_000_000,
  maxCandidates: 5_000,
  maxCandidatesPerRecord: 2,
}

/** Feature weights (contribution to the score). Tuned on DEV only. */
export const WEIGHTS = {
  referenceExact: 0.4,
  referenceDigitCore: 0.32,
  referenceTransposition: 0.28,
  referenceOneDigitOff: -0.15,
  referenceUnrelated: -0.35,

  vendorSameKey: 0.25,
  vendorSameName: 0.22,
  vendorTypo: 0.18,
  vendorTokenOverlap: 0.12,
  vendorUnrelated: -0.4,

  amountExact: 0.25,
  amountClose: 0.1,
  amountFar: -0.4,

  timingClose: 0.1,
  timingWindow: 0.05,
  timingFar: -0.15,

  invoiceDateSame: 0.1,
  invoiceDateDiffers: -0.2,
  invoiceAmountSame: 0.05,

  bankSame: 0.05,
  bankDiffers: -0.05,

  /** Two or more signals that only approximately agree (swapped digits, spelling variant, close amount). */
  multipleApproximate: -0.15,
} as const

/** Minimum score for a pair to be returned as a review candidate. Tuned on DEV only. */
export const SCORE_THRESHOLD = 0.6

/** Amounts within this share (or this many cents) are "close" (bank fees, FX rounding). */
export const AMOUNT_CLOSE_RATIO = 0.02
export const AMOUNT_CLOSE_CENTS = 2_500
/** Days-apart bands for the timing feature. */
export const TIMING_CLOSE_DAYS = 14
export const TIMING_WINDOW_DAYS = 45
export const TIMING_FAR_DAYS = 180
