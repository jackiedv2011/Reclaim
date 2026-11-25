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
import { verifiedReturned } from '../../src/recovery/financials.ts'
import type { CaseState, RecoveryMethod } from '../../src/ledger/caseState.ts'
import type { Finding } from '../../src/types.ts'

export interface Sender { businessName: string; senderName: string; senderEmail: string }

const longDate = (ts: number) => new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(ts))

const ASK: Record<RecoveryMethod, string> = {
  refund: 'when we can expect the refund',
  credit: 'when the credit will be applied to our account',
  offset: 'whether we can apply the credit against our next payment to you',
}

export function followUpText(finding: Finding, state: CaseState, sender: Sender, lastOutreachAt: number): { subject: string; body: string } {
  const originalSubject = state.recoverySubject?.trim() || finding.title
  const subject = /^re:/i.test(originalSubject) ? originalSubject : `Re: ${originalSubject}`
  const requested = state.requestedAmount ?? finding.dollarImpact
  const open = Math.max(0, Math.round(requested * 100) - Math.round(verifiedReturned(state) * 100)) / 100
  const method = state.requestedResolution ?? 'refund'
  const followUps = state.recoveryFollowUps?.length ?? 0
  const amountLine = open < requested
    ? `Thank you for what has come back so far. ${formatCurrency(open)} of the ${formatCurrency(requested)} we asked for is still open.`
    : `We asked for ${formatCurrency(requested)} back on our account with ${finding.vendor}.`
  const signOff = [sender.senderName || 'Accounts Payable Team', sender.businessName].filter(Boolean)
  const lines = [
    'Hello,',
    '',
    `I'm following up on my email of ${longDate(lastOutreachAt)} about ${finding.title.charAt(0).toLowerCase()}${finding.title.slice(1)}. ${amountLine}`,
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
