/**
 * The deterministic follow-up letter, for the server.
 *
 * This is `generateFollowUp` from src/lib/followUps.ts, line for line. That
 * module imports through the browser's `@/` alias, which neither Node's type
 * stripping nor tsconfig.server.json resolves, so the server cannot import it
 * yet. followUpText.test.ts checks both produce identical text on the same
 * cases, so the two cannot drift. Once src/lib/followUps.ts uses relative
 * `.ts` imports (requested in docs/workstream-recovery-ai/J3-jobs.md), delete
 * this file and import it directly.
 */
import { formatCurrency } from '../../src/lib/format.ts'
import { activeReturned } from '../../src/recovery/financials.ts'
import { referenceStrength } from '../../src/lib/sourceIdentity.ts'
import type { CaseState, RecoveryMethod } from '../../src/ledger/caseState.ts'
import type { Finding } from '../../src/types.ts'

export interface Sender { businessName: string; senderName: string; senderEmail: string }

const longDate = (ts: number) => new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ts))

/** Mirrors src/lib/letters.ts: things people type, or systems write, where there is no invoice number. */
const NO_NUMBER = /^(?:not[\s-]*numbered|un-?numbered|no[\s-]*(?:invoice|bill|number|reference|ref)\b.*|not\s+(?:available|provided|known|given)|n\/a|-+)$/i
const isNumber = (value: string | null | undefined): value is string => Boolean(value?.trim()) && referenceStrength(value!) !== 'none' && !NO_NUMBER.test(value!.trim())

/** Mirrors `billName` in src/lib/letters.ts: the bill as a vendor would look it up, or null. */
function billName(finding: Finding): string | null {
  const confirmed = finding.evidence?.obligation.obligationId.trim()
  if (isNumber(confirmed) && confirmed !== finding.id && !/^qbo:/i.test(confirmed)) return `invoice ${confirmed}`
  const numbers = [...new Set(finding.relatedRecords.map((r) => r.invoiceNumber?.trim()).filter(isNumber))]
  if (numbers.length === 0) return null
  return numbers.length === 1 ? `invoice ${numbers[0]}` : `invoices ${numbers.join(' and ')}`
}

/** Mirrors `aboutPayment` in src/lib/followUps.ts. */
function aboutPayment(finding: Finding): string {
  const bill = billName(finding)
  if (bill) return `a duplicate payment on ${bill}`
  const amounts = new Set(finding.relatedRecords.map((r) => Math.round(r.amountPaid * 100)))
  return amounts.size === 1 ? `a payment of ${formatCurrency([...amounts][0] / 100)} that went to you more than once` : 'payments that went to you more than once for the same bill'
}

const ASK: Record<RecoveryMethod, string> = {
  refund: 'when we can expect the refund',
  credit: 'when the credit will be applied to our account',
  offset: 'whether we can apply the credit against our next payment to you',
}

export function followUpText(finding: Finding, state: CaseState, sender: Sender, lastOutreachAt: number): { subject: string; body: string } {
  const bill = billName(finding)
  const originalSubject = state.recoverySubject?.trim() || `Duplicate payment${bill ? ` on ${bill}` : ` to ${finding.vendor}`}`
  const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`
  const requested = state.requestedAmount ?? finding.dollarImpact
  const open = Math.max(0, Math.round(requested * 100) - Math.round(activeReturned(state) * 100)) / 100
  const method = state.requestedResolution ?? 'refund'
  const followUps = state.recoveryFollowUps?.length ?? 0
  const amountLine = open < requested
    ? `Thank you for what has come back so far. ${formatCurrency(open)} of the ${formatCurrency(requested)} we asked for is still open.`
    : `We asked for ${formatCurrency(requested)} back on our account with ${finding.vendor}.`
  const signOff = [sender.senderName || 'Accounts Payable Team', sender.businessName].filter(Boolean)
  const lines = [
    'Hello,',
    '',
    `I'm following up on my email of ${longDate(lastOutreachAt)} about ${aboutPayment(finding)}. ${amountLine}`,
    '',
    followUps === 0
      ? `Could you let me know ${ASK[method]}, or whether you need anything else from us to process it?`
      : `I haven't been able to find a reply yet. Could you let me know ${ASK[method]}, or point me to the right person if this should go to someone else?`,
    '',
    'Thank you,',
    ...signOff,
  ]
  const original = state.recoveryDraft?.trim()
  if (original) {
    lines.push('', `On ${longDate(state.recoverySentEmail?.sentAt ?? state.recoveryRequestedAt ?? lastOutreachAt)}, I wrote:`, ...original.split('\n').map((l) => `> ${l}`))
  }
  return { subject, body: lines.join('\n') }
}
