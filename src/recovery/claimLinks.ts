import type { CaseState } from '../ledger/caseState.ts'
import { normalizeVendor } from '../lib/format.ts'
import type { APRecord, Finding } from '../types.ts'
import type { ClaimFinding, LinkedClaims } from './eligibility.ts'
import { activeReturned, validSettlements } from './financials.ts'

/**
 * Adding records can replace a finding: a third payment of an invoice turns
 * {1, 2} into a new finding {1, 2, 3}. The earlier case keeps its own history,
 * and these rules keep the two from being read as separate money:
 *
 *  - what the earlier case got back, or still has out with the vendor, comes
 *    off what the new finding can ask for;
 *  - an earlier dismissal still stands when the new finding only adds more of
 *    the same rows.
 *
 * Everything is worked out from the saved case states each time, so nothing
 * here is stored and nothing can go stale.
 */
type States = Record<string, CaseState | undefined> | undefined

/** A dismissal carried over from the finding it replaced. */
export type CarriedState = CaseState & { carriedFromFindingId?: string }

const EMPTY: CaseState = { decision: null, reason: null, decidedAt: null, recoveryStage: null }

/** Finished by later records: the detector no longer produces it, and only its history is kept. */
function replaced(finding: Finding): boolean {
  return Boolean(finding.suppressionReason)
}

/** The new finding has to contain the earlier claim, so one shared bill payment is not enough. */
function sameClaim(finding: Finding, earlier: Finding): boolean {
  const rows = new Set(finding.relatedRecords.map((r) => r.id))
  return earlier.relatedRecords.filter((r) => rows.has(r.id)).length >= 2
}

const text = (value: string | null | undefined) => (value ?? '').trim().toLowerCase()
const cents = (value: number) => Math.round(value * 100)

/** Whether `added` is more of what the earlier rows already were: the same bill, vendor and size of payment. */
function moreOfTheSame(added: APRecord, earlier: APRecord[]): boolean {
  const alike = earlier.filter((r) =>
    normalizeVendor(r.vendor) === normalizeVendor(added.vendor) &&
    text(r.invoiceNumber) === text(added.invoiceNumber) &&
    text(r.company) === text(added.company) &&
    text(r.currency) === text(added.currency))
  if (alike.length === 0) return false
  const amounts = alike.map((r) => cents(r.amountPaid))
  // Instalments of different sizes vary, so a payment within their range is one more of them.
  return amounts.includes(cents(added.amountPaid)) || (new Set(amounts).size > 1 && cents(added.amountPaid) <= Math.max(...amounts))
}

export interface ClaimContext {
  /** The finding with any earlier case's money attached; the same object when there is none. */
  finding: (finding: Finding) => ClaimFinding
  /** The case state, including a dismissal carried over from a finding this one replaced. */
  state: (finding: Finding) => CarriedState
}

/** Build once per pass over the findings: the replaced ones are looked up a single time. */
export function claimContext(findings: Finding[], caseStates: States): ClaimContext {
  const earlierCases = findings.flatMap((finding) => {
    const state = caseStates?.[finding.id]
    return state && replaced(finding) ? [{ finding, state }] : []
  })
  const earlierFor = (finding: Finding) => (earlierCases.length === 0 || replaced(finding) ? [] : earlierCases.filter((c) => c.finding.id !== finding.id && sameClaim(finding, c.finding)))

  return {
    finding(finding) {
      const linked: LinkedClaims = { findingIds: [], returns: [], outstandingMinor: 0 }
      for (const earlier of earlierFor(finding)) {
        const returns = validSettlements(earlier.state).map((entry) => ({ reference: entry.reference, amountMinor: cents(entry.amount) }))
        const outstandingMinor = earlier.state.recoveryStage === 'requested' ? Math.max(0, cents(earlier.state.requestedAmount ?? 0) - cents(activeReturned(earlier.state))) : 0
        if (returns.length === 0 && outstandingMinor === 0) continue
        linked.findingIds.push(earlier.finding.id)
        linked.returns.push(...returns)
        linked.outstandingMinor += outstandingMinor
      }
      return linked.findingIds.length ? { ...finding, linkedClaims: linked } : finding
    },
    state(finding) {
      const own = caseStates?.[finding.id]
      if (own) return own
      for (const earlier of earlierFor(finding)) {
        const { state } = earlier
        // "These records don't match" and "the check got it wrong" were about the earlier rows only;
        // a new row could be the real duplicate of either.
        if (state.decision !== 'expected' || state.dismissalTag === 'not_a_match' || state.dismissalTag === 'detection_error') continue
        if (earlier.finding.type !== finding.type || (earlier.finding.ruleId ?? null) !== (finding.ruleId ?? null)) continue
        const before = new Set(earlier.finding.relatedRecords.map((r) => r.id))
        const now = new Set(finding.relatedRecords.map((r) => r.id))
        if (![...before].every((id) => now.has(id))) continue
        if (!finding.relatedRecords.every((r) => before.has(r.id) || moreOfTheSame(r, earlier.finding.relatedRecords))) continue
        return { decision: 'expected', reason: state.reason, decidedAt: state.decidedAt, recoveryStage: null, dismissalTag: state.dismissalTag ?? null, carriedFromFindingId: earlier.finding.id }
      }
      return EMPTY
    },
  }
}
