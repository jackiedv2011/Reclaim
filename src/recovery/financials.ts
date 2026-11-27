import type { Finding } from '../types.ts'
import type { CaseState, RecoveryVerification } from '../ledger/caseState.ts'
import { evaluateEligibility, type ClaimFinding } from './eligibility.ts'

/** The current money displays support USD only; other currencies remain visible on evidence. */
export function eligiblePotential(finding: ClaimFinding, findings: Finding[]): number | null {
  if (finding.classification !== 'recovery_candidate') return null
  const result = evaluateEligibility(finding, finding.evidence, findings)
  return result.eligible && result.currency === 'USD' && result.potentialAmountMinor !== null ? result.potentialAmountMinor / 100 : null
}
export function validSettlements(state: CaseState): RecoveryVerification[] {
  return settlementsOf(state).filter((entry) =>
    Number.isFinite(entry.amount) && entry.amount > 0 && Number.isFinite(entry.settledAt) && entry.settledAt > 0 &&
    Boolean(entry.reference?.trim()) && ['bank', 'accounting', 'document', 'manual'].includes(entry.source) &&
    (entry.method === 'refund' || ((entry.method === 'credit' || entry.method === 'offset') && Boolean(entry.appliedToBill?.trim()))))
}
/** One recorded return, as the case tells them apart: method, reference and the bill it was applied to. */
export function settlementKey(entry: Pick<RecoveryVerification, 'method' | 'reference' | 'appliedToBill'>): string {
  return [entry.method, entry.reference.trim().toLowerCase(), (entry.appliedToBill ?? '').trim().toLowerCase()].join('|')
}
/** Every return on the case, from the current list or the single proof older cases kept. */
export function settlementsOf(state: CaseState): RecoveryVerification[] {
  return state.recoverySettlements ?? (state.recoveryVerification ? [state.recoveryVerification] : [])
}
/** Structurally valid customer-entered returns, not independent bank matching. Old unverified amount fields stay historical. */
export function verifiedReturned(state: CaseState): number {
  return Math.round(validSettlements(state).reduce((sum, entry) => sum + entry.amount, 0) * 100) / 100
}
/** Customer-entered returns attributed to the active supplier request only. */
export function activeReturned(state: CaseState): number {
  const generation = state.activeRequestGeneration ?? 1
  return Math.round(validSettlements(state).filter((entry) => (entry.requestGeneration ?? 1) === generation).reduce((sum, entry) => sum + entry.amount, 0) * 100) / 100
}
export function authorizedOutstanding(state: CaseState): number {
  return state.approvedAt && Number.isFinite(state.requestedAmount) && (state.requestedAmount ?? 0) > 0
    ? Math.max(0, Math.round(((state.requestedAmount ?? 0) - activeReturned(state)) * 100) / 100) : 0
}
/**
 * What the records still support after the current request was paid in full:
 * asking for $400 of a supported $1,000 and receiving it leaves $600. Null
 * unless the request closed by being paid. A balance the customer closed short
 * is not counted: that was their decision (see reopenRemainingBalance).
 */
export function unrequestedRemainder(state: CaseState, supportedAmount: number | null): number | null {
  if (state.recoveryStage !== 'recovered' || state.requiresRevalidation || supportedAmount === null) return null
  const requestedMinor = Math.round((state.requestedAmount ?? 0) * 100)
  if (requestedMinor <= 0 || Math.round(activeReturned(state) * 100) < requestedMinor) return null
  const left = Math.round(supportedAmount * 100) - Math.round(verifiedReturned(state) * 100)
  return left > 0 ? left / 100 : null
}
