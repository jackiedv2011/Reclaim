export { MATCHER_VERSION, MATCHER_FLAG, isMatcherEnabled, DEFAULT_LIMITS, SCORE_THRESHOLD, WEIGHTS } from './config.ts'
export type { MatcherLimits } from './config.ts'
export { blockingKeys, generateCandidatePairs } from './blocking.ts'
export type { BlockingStats } from './blocking.ts'
export { EXCLUSION_REASONS, buildLedgerContext, exclusionFor } from './exclusions.ts'
export type { ExclusionReason, LedgerContext } from './exclusions.ts'
export { scorePair } from './features.ts'
export type { PairScore } from './features.ts'
export { prepareRecord } from './prepare.ts'
export type { PreparedRecord } from './prepare.ts'
export {
  runMatcherExperiment,
  detectWithOptionalMatcher,
  pairsCoveredByFindings,
  pairKey,
  buildMatcherIndex,
  assessPair,
} from './matcher.ts'
export type { MatcherOptions, MatcherStats, MatcherExperimentResult, DetectWithMatcherOptions, MatcherIndex } from './matcher.ts'
