/**
 * Presentation-neutral view-model helpers (P6). No components, no styling, no
 * layout. These turn any ReadModelEnvelope into the facts a screen must show
 * whatever its final design: which UI state applies, why, where the data came
 * from, and money per currency. Aditya owns visual design, information
 * hierarchy and final wording; every string here is DRAFT COPY for review and
 * is keyed so it can be replaced without touching logic.
 */
import { COVERAGE_REASONS, type CoverageItem, type DataOrigin, type MoneyAmount, type ReadModelEnvelope } from './contracts.ts'

export const VIEW_MODEL_VERSION = 'view-models-v0.1'

/**
 * Every screen that shows a read model must be able to render each of these.
 * `not_covered` is distinct from `empty`: empty means the covered records have
 * nothing to show; not_covered means Reclaim could not look.
 */
export type UiState = 'ready' | 'empty' | 'partial' | 'stale' | 'not_covered'

export interface UiStateView {
  state: UiState
  /** All coverage reasons, deduplicated and sorted. */
  reasons: string[]
  /** Banner needed regardless of state, e.g. customer-supplied data. Null when nothing must be said. */
  notices: Array<{ code: string; text: string }>
}

/** Draft plain-language copy per reason code. Unknown codes fall back to a neutral sentence; never hidden. */
export const DRAFT_COVERAGE_COPY: Record<string, string> = {
  [COVERAGE_REASONS.NO_DATA]: 'There are no records to analyse yet.',
  [COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE]: 'Based on files and imports you provided; Reclaim has not independently verified them.',
  [COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS]: 'Built from saved audits, not a continuous connection to your books.',
  [COVERAGE_REASONS.MISSING_DATES]: 'Some records have no payment date and are left out of dated views.',
  [COVERAGE_REASONS.MISSING_CURRENCY]: 'Some records have no currency and are shown separately.',
  [COVERAGE_REASONS.MIXED_CURRENCY]: 'Records are in more than one currency; each is shown separately and never added together.',
  [COVERAGE_REASONS.MISSING_CATEGORY]: 'Some records have no category and are grouped as Uncategorized.',
  [COVERAGE_REASONS.CROSS_AUDIT_OVERLAP]: 'Some records appeared in more than one audit and are counted once.',
  [COVERAGE_REASONS.INSUFFICIENT_HISTORY]: 'Not enough history to compare against.',
  [COVERAGE_REASONS.NO_INDEPENDENT_RETURN_MATCHING]: 'Returns are not yet matched to bank or accounting records.',
  [COVERAGE_REASONS.SETTLEMENT_UNVERIFIED]: 'Whether payments cleared is not known from these records.',
  [COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING]: 'Part of this view uses an interim data source.',
  [COVERAGE_REASONS.STALE_SOURCE]: 'The newest data is older than expected.',
  [COVERAGE_REASONS.REJECTED_ROWS]: 'Some rows in your imports could not be read.',
  [COVERAGE_REASONS.UNREADABLE_SAVED_AUDIT]: 'A saved audit could not be read and is not included.',
  [COVERAGE_REASONS.PERIOD_NOT_COVERED]: 'No import covers this period.',
  [COVERAGE_REASONS.PERIOD_PARTIALLY_COVERED]: 'Imports cover only part of this period.',
  [COVERAGE_REASONS.GATE_CURRENCY_UNSUPPORTED]: 'Recovery requests are supported in USD only.',
  [COVERAGE_REASONS.SEND_STATE_NOT_IN_SNAPSHOT]: 'Email send status is shown on the case itself.',
}

export const FALLBACK_COVERAGE_COPY = 'Some checks were limited.'

/** Reasons that are always true of the interim source; shown as a standing notice, not as "partial". */
const STANDING_REASONS = new Set<string>([COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS, COVERAGE_REASONS.SETTLEMENT_UNVERIFIED, COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING, COVERAGE_REASONS.NO_INDEPENDENT_RETURN_MATCHING])

export function copyFor(reason: string): string {
  return DRAFT_COVERAGE_COPY[reason] ?? FALLBACK_COVERAGE_COPY
}

/**
 * The UI state for an envelope. `isEmpty` tells it whether the result has
 * nothing to show (the shape differs per model). Precedence: not_covered >
 * stale > partial > empty > ready. A limited check is never presented as ready.
 */
export function uiStateOf<T>(env: ReadModelEnvelope<T>, isEmpty: (result: T) => boolean): UiStateView {
  const reasons = [...new Set(env.coverage.flatMap((c: CoverageItem) => c.reasons))].sort()
  const notices = reasons.filter((r) => STANDING_REASONS.has(r)).map((code) => ({ code, text: copyFor(code) }))
  const limiting = reasons.filter((r) => !STANDING_REASONS.has(r))
  const allNotRun = env.coverage.length > 0 && env.coverage.every((c) => c.status === 'not_run')
  let state: UiState
  if (env.result === null || allNotRun) state = 'not_covered'
  else if (env.freshness.stale) state = 'stale'
  else if (limiting.length > 0 || env.coverage.some((c) => c.status !== 'supported' && c.reasons.some((r) => !STANDING_REASONS.has(r)))) state = 'partial'
  else if (isEmpty(env.result)) state = 'empty'
  else state = 'ready'
  return { state, reasons, notices }
}

export const DRAFT_ORIGIN_LABEL: Record<DataOrigin, string> = {
  canonical_ledger: 'From your connected ledger',
  legacy_audit_snapshot: 'From your saved audits',
  fixture: 'Sample data',
}

export interface MoneyView {
  currency: string
  amountMinor: number
  /** Draft en-US rendering; UNKNOWN currency is shown without a symbol. Design may replace. */
  text: string
}

/** One entry per currency, in the order given. Never totals across currencies. */
export function moneyViews(amounts: readonly MoneyAmount[]): MoneyView[] {
  return amounts.map(({ currency, amountMinor }) => ({ currency, amountMinor, text: formatMinor(amountMinor, currency) }))
}

export function formatMinor(amountMinor: number, currency: string): string {
  const sign = amountMinor < 0 ? '-' : ''
  const abs = Math.abs(amountMinor)
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cents = String(abs % 100).padStart(2, '0')
  return /^[A-Z]{3}$/.test(currency) && currency !== 'UNKNOWN' ? `${sign}${currency} ${whole}.${cents}` : `${sign}${whole}.${cents} (currency unknown)`
}

/**
 * The money labels a recovery screen needs, kept distinct. A design may rename
 * them, but must keep six separate labels: the audit found one amount carrying
 * four different names across today's screens.
 */
export const DRAFT_RECOVERY_LABELS = {
  flaggedForReview: 'Flagged for review',
  supportedPotential: 'Supported by evidence',
  approvedOutstanding: 'Requested, still outstanding',
  promised: 'Supplier said it will return',
  customerRecordedReturns: 'Returned (recorded by you)',
  matchedReturns: 'Returned (matched to your records)',
} as const
