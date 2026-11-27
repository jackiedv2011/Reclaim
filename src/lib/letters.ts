import type { Finding } from '@/types'
import { formatCurrency, formatDate, normalizeAccountLast4 } from '@/lib/format'
import type { SenderProfile } from '@/lib/senderProfile'
import type { RecoveryMethod } from '@/ledger/caseState'
import { evaluateEligibility } from '@/recovery/eligibility'
import { referenceStrength } from '@/lib/sourceIdentity'
import { exposureCurrencyOf, findingMoney, moneyText } from '@/workspace/money'

const TODAY = () =>
  new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date())

/** Things people type, or systems write, where there is no invoice number. */
const NO_NUMBER = /^(?:not[\s-]*numbered|un-?numbered|no[\s-]*(?:invoice|bill|number|reference|ref)\b.*|not\s+(?:available|provided|known|given)|n\/a|-+)$/i

const isNumber = (value: string | null | undefined): value is string => Boolean(value?.trim()) && referenceStrength(value!) !== 'none' && !NO_NUMBER.test(value!.trim())

/**
 * The bill in the words a vendor would look it up by: "invoice INV-1001", or
 * null when there is no number. Never a rule title or an internal id.
 */
export function billName(finding: Finding): string | null {
  const confirmed = finding.evidence?.obligation.obligationId.trim()
  if (isNumber(confirmed) && confirmed !== finding.id && !/^qbo:/i.test(confirmed)) return `invoice ${confirmed}`
  const numbers = [...new Set(finding.relatedRecords.map((r) => r.invoiceNumber?.trim()).filter(isNumber))]
  if (numbers.length === 0) return null
  return numbers.length === 1 ? `invoice ${numbers[0]}` : `invoices ${numbers.join(' and ')}`
}

function invoiceList(f: Finding): string {
  return billName(f) ?? 'the invoice referenced above'
}

/**
 * The one sentence that changes depending on how the business wants this
 * settled. Every vendor letter used to say "a refund or account credit"
 * regardless of what was actually selected in the form — the resolution
 * picker looked functional but never touched the letter.
 */
function resolutionNoun(method: RecoveryMethod): string {
  switch (method) {
    case 'refund':
      return 'refund'
    case 'credit':
      return 'credit'
    case 'offset':
      return 'payment offset'
  }
}

function resolutionAsk(method: RecoveryMethod, amount: number): string {
  const value = formatCurrency(amount)
  switch (method) {
    case 'refund':
      return `a refund of ${value}`
    case 'credit':
      return `an account credit of ${value}`
    case 'offset':
      return `a credit of ${value} applied against our next payment to you`
  }
}

/**
 * A real email, not a printed letter reformatted as one. The date, inside
 * address, and "Re:" line are conventions for paper correspondence — an
 * email client already stamps the date and carries the subject, so keeping
 * them just duplicated the Subject field and added clutter above the actual
 * request.
 */
function vendorLetter(subject: string, bodyLines: string[], sender?: SenderProfile): { subject: string; body: string } {
  const businessLine = sender?.businessName ? sender.businessName : null
  const signOff = sender?.senderName
    ? [sender.senderName, businessLine].filter((line): line is string => Boolean(line))
    : ['Accounts Payable Team', businessLine].filter((line): line is string => Boolean(line))

  const body = [
    'To whom it may concern,',
    '',
    ...bodyLines,
    '',
    'Please confirm receipt of this request and let us know your expected timeline for resolution. We appreciate your prompt attention to this matter.',
    '',
    'Best regards,',
    ...signOff,
    ...(sender?.senderEmail ? [sender.senderEmail] : []),
  ].join('\n')

  return { subject, body }
}

function internalNote(f: Finding, subject: string, bodyLines: string[], sender?: SenderProfile): { subject: string; body: string } {
  const body = [
    `INTERNAL REVIEW NOTE — ${TODAY()}`,
    '',
    `Vendor: ${f.vendor}`,
    `Finding: ${f.title}`,
    `Amount flagged: ${findingMoney(f, f.dollarImpact)}`,
    ...(sender?.senderName ? [`Reviewed by: ${sender.senderName}`] : []),
    '',
    ...bodyLines,
    '',
    'This is an internal note only — do not send to the vendor.',
  ].join('\n')

  return { subject, body }
}

/** Saved findings can carry a date as text. A plain calendar day is that day here, not midnight in London. */
function paidOn(value: Date | string): Date {
  const day = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value)
}

/**
 * `requestedAmount` is what the letter asks for. It can be less than the
 * finding supports (a partial request), but the facts the letter states — how
 * much was paid twice, how much over the invoice — always come from the
 * finding itself, so lowering the ask never rewrites what the records show.
 */
/** "$3,240.00 on Mar 4, 2026 and $3,240.00 on Mar 18, 2026" — the payments, in the order they were made. */
function paymentList(finding: Finding): string {
  const parts = [...finding.relatedRecords]
    .map((r) => ({ amount: r.amountPaid, at: paidOn(r.paymentDate) }))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((r) => `${formatCurrency(r.amount)} on ${formatDate(r.at)}`)
  return parts.length <= 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

export function generateLetter(
  finding: Finding,
  sender?: SenderProfile,
  method: RecoveryMethod = 'refund',
  requestedAmount: number = finding.dollarImpact,
  /** Returned on an earlier request for the same case, so the letter says why it asks for the rest. */
  alreadyReturned = 0
): { subject: string; body: string } {
  const ask = Math.min(requestedAmount, finding.dollarImpact)
  const letter = (subject: string, bodyLines: string[]) => vendorLetter(subject, bodyLines, sender)
  const note = (subject: string, bodyLines: string[]) => internalNote(finding, subject, bodyLines, sender)

  const explanation = moneyText(finding.explanation, exposureCurrencyOf(finding))
  const gate = evaluateEligibility(finding)
  if (['exact_duplicate','near_duplicate','overpayment','unclaimed_discount'].includes(finding.type)) {
    if (!gate.eligible || finding.classification !== 'recovery_candidate') return note(`Review evidence for ${finding.vendor}`, [explanation, '', 'This signal does not establish money owed. Complete the recorded evidence checks before requesting a refund or credit.'])
    // A partial request lowers the ask; nothing raises it above the evidenced excess.
    const amount = Math.min(ask, gate.potentialAmountMinor! / 100)
    const invoices = billName(finding)
    const { overpaymentMinor, refundedMinor, appliedCreditMinor, linkedReturnedMinor, linkedOutstandingMinor } = gate.amountBreakdown
    const paymentRefs = finding.evidence?.payments.map((payment) => payment.paymentId).join(', ')
    return letter(`Request for ${resolutionNoun(method)} — duplicate payment${invoices ? ` on ${invoices}` : ''}`, [
      `Our records show we paid ${finding.vendor} more than once for ${invoices ?? 'the same bill'}: ${paymentList(finding)}. The extra payment comes to ${formatCurrency(overpaymentMinor / 100)}.`,
      ...(paymentRefs ? [`Payment references: ${paymentRefs}.`] : []),
      ...(refundedMinor ? [`We have already received ${formatCurrency(refundedMinor / 100)} in refunds.`] : []),
      ...(appliedCreditMinor ? [`We have already applied ${formatCurrency(appliedCreditMinor / 100)} in credits.`] : []),
      ...(alreadyReturned > 0 ? [`We have already received ${formatCurrency(alreadyReturned)} of it.`] : []),
      ...(linkedReturnedMinor ? [`An earlier request covering some of these payments has brought back ${formatCurrency(linkedReturnedMinor / 100)}.`] : []),
      ...(linkedOutstandingMinor ? [`An earlier request for ${formatCurrency(linkedOutstandingMinor / 100)} of it is still open; this request is for the rest.`] : []),
      `We request ${resolutionAsk(method, amount)} for the duplicate payment.`,
    ])
  }

  switch (finding.type) {
    case 'exact_duplicate': {
      if (finding.class !== 'recoverable') {
        return note(`Review repeated payments before contacting ${finding.vendor}`, [
          explanation,
          '',
          'Action required: confirm the invoice schedule and payment approvals before requesting a refund or credit from the vendor.',
        ])
      }
      const invoices = invoiceList(finding)
      return letter(`Request for ${resolutionNoun(method)} — duplicate payment on ${invoices}`, [
        `Our records show ${finding.vendor} was paid more than once for ${invoices}, for a combined duplicate amount of ${formatCurrency(
          finding.dollarImpact
        )}.`,
        explanation,
        `We request ${resolutionAsk(method, ask)} for the duplicate payment.`,
      ])
    }

    case 'near_duplicate': {
      return note(`Review suspected duplicate payment to ${finding.vendor}`, [
        explanation,
        '',
        'Action required: compare the invoice descriptions, purchase orders, and payment approvals before contacting the vendor.',
      ])
    }

    case 'overpayment': {
      const invoices = invoiceList(finding)
      return letter(`Request for ${resolutionNoun(method)} — overpayment on ${invoices}`, [
        explanation,
        `We request ${resolutionAsk(method, ask)} for the overpaid difference on ${invoices}.`,
      ])
    }

    case 'unclaimed_discount': {
      const invoices = invoiceList(finding)
      return letter(`Request for early-payment discount ${resolutionNoun(method)} — ${invoices}`, [
        explanation,
        `We request ${resolutionAsk(method, ask)}, reflecting the early-payment discount we were entitled to under the agreed terms on ${invoices}.`,
      ])
    }

    case 'bank_account_change': {
      const changeRecord = finding.relatedRecords[finding.relatedRecords.length - 1]
      return note(`Verify new bank details before further payments — ${finding.vendor}`, [
        explanation,
        '',
        `Action required: call ${finding.vendor} using a phone number on file from before ${formatDate(
          changeRecord.paymentDate
        )} (not a number from the invoice or email that requested the change) and verbally confirm the new account ending ${
          normalizeAccountLast4(changeRecord.bankAccountLast4) ?? 'unknown'
        } before releasing any further payments. This is a common business-email-compromise pattern — do not rely on email confirmation alone.`,
      ])
    }

    case 'amount_outlier': {
      const record = finding.relatedRecords[0]
      return note(`Confirm pricing on unusually large payment — ${finding.vendor}`, [
        explanation,
        '',
        `Action required: pull the contract or purchase order for ${
          isNumber(record.invoiceNumber) ? `invoice ${record.invoiceNumber}` : 'this payment'
        } and confirm the price and quantity match what was agreed before this pattern repeats.`,
      ])
    }

    case 'missed_discount': {
      const record = finding.relatedRecords[0]
      return note(`Pay earlier to capture future discounts — ${finding.vendor}`, [
        explanation,
        '',
        `Action required: flag invoices from ${finding.vendor} for earlier processing so future payments land inside the discount window. This is a forward-looking process fix, not a recoverable amount — ${
          isNumber(record.invoiceNumber) ? `invoice ${record.invoiceNumber}` : 'this bill'
        } has already been paid.`,
      ])
    }

    case 'shared_invoice_number': {
      return note(`Confirm vendor identity before further review — invoice ${finding.relatedRecords[0].invoiceNumber ?? 'unknown'}`, [
        explanation,
        '',
        'Action required: check the vendor master file for a duplicate or renumbered vendor record, and confirm which payment (if either) was made against the correct vendor before treating this as routine.',
      ])
    }
  }
}
