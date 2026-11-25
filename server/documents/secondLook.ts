/**
 * Second look: the ordinary reasons a flagged payment might not be a leak,
 * checked deterministically against the saved records and linked documents.
 *
 * Each candidate says whether anything in the records points to it, cites the
 * rows or document lines that do, names the evidence that would settle it and
 * the evidence check a reviewer would record, and suggests internal next steps
 * only (nothing here contacts a supplier). The detector's own result and
 * explanation stay on top, unchanged: a second look can't suppress a verified
 * finding, dismiss a case or promote one. Only a person, through the case
 * commands, can.
 */
import { EVIDENCE_CHECKS, evaluateEligibility, type EvidenceCheck } from '../../src/recovery/eligibility.ts'
import { storedCase } from '../recoveryFacts.ts'
import type { FactView } from './facts.ts'
import { ruleLabel } from './summary.ts'

export const SECOND_LOOK_VERSION = 'second-look-2026-11-25.1'

export const EXPLANATION_KINDS = ['legitimate_recurrence', 'instalments_or_split', 'duplicate_import', 'adjustment', 'refund', 'credit', 'uncertain'] as const
export type ExplanationKind = typeof EXPLANATION_KINDS[number]

export interface ExplanationCandidate {
  kind: ExplanationKind
  title: string
  /** `indicated`: something in the records points this way. `not_indicated`: looked, found nothing. Neither settles it. */
  status: 'indicated' | 'not_indicated'
  explanation: string
  citations: string[]
  evidenceGap: string
  reviewerCheck: { key: EvidenceCheck; label: string; confirmed: boolean } | null
  nextActions: string[]
}

export interface SecondLook {
  version: string
  source: 'deterministic'
  projectId: string
  findingId: string
  revision: number
  caseFingerprint: string
  /** What the detector said, exactly as saved. Always shown first. */
  detector: { type: string; rule: string; title: string; explanation: string; severity: string; classification: string | null; flaggedAmountMinor: number; evidenceState: string; citations: string[] }
  candidates: ExplanationCandidate[]
  notice: string
}

export const SECOND_LOOK_NOTICE = 'A second look lists other explanations to rule in or out. It never dismisses, suppresses or promotes a case; the detector result above stands until a person records a decision.'

type Rec = Record<string, unknown> & { id: string }
type SavedSeries = { recordIds?: unknown; cadenceDays?: unknown; paymentCount?: unknown }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const cents = (v: unknown) => { const n = num(v); return n === null ? null : Math.round(n * 100) }
const norm = (v: unknown) => str(v).toLowerCase().replace(/\s+/g, ' ')
const kindOf = (r: Rec) => norm(r.transactionType).replace(/[ -]/g, '_')
const cap = (ids: string[], n = 10) => [...new Set(ids)].slice(0, n)
const CHECK_LABEL = Object.fromEntries(EVIDENCE_CHECKS) as Record<EvidenceCheck, string>

export function buildSecondLook(input: { project: Record<string, unknown> | null; projectId: string; findingId: string; revision: number; facts: FactView[] }): SecondLook | null {
  const c = storedCase(input.project, input.findingId)
  if (!c) return null
  const env = (input.project?.environment ?? {}) as { records?: Rec[]; result?: { recurringSeries?: SavedSeries[] } }
  const { finding } = c
  const related = finding.relatedRecords as unknown as Rec[]
  const relatedIds = new Set(related.map((r) => r.id))
  const vendors = new Set(related.map((r) => norm(r.vendor)).filter(Boolean))
  const suppliers = new Set(related.map((r) => str(r.stableSupplierId)).filter(Boolean))
  const sameSupplier = (r: Rec) => vendors.has(norm(r.vendor)) || (str(r.stableSupplierId) !== '' && suppliers.has(str(r.stableSupplierId)))
  const vendorRows = (env.records ?? []).filter((r) => r && typeof r.id === 'string' && sameSupplier(r))
  const checks = finding.evidence?.checks ?? {}
  const check = (key: EvidenceCheck) => ({ key, label: CHECK_LABEL[key], confirmed: Boolean(checks[key]?.confirmed) })
  const rec = (ids: Iterable<string>) => [...ids].map((id) => `record:${id}`)
  const relatedRefs = rec(relatedIds)
  const candidates: ExplanationCandidate[] = []
  const add = (c: Omit<ExplanationCandidate, 'citations'> & { citations: string[] }) => candidates.push({ ...c, citations: cap(c.citations.length ? c.citations : relatedRefs, 12) })

  // Legitimate recurrence: a saved recurring series that includes these rows, or distinct invoice numbers.
  const series = (env.result?.recurringSeries ?? []).filter((s) => Array.isArray(s.recordIds) && (s.recordIds as unknown[]).some((id) => typeof id === 'string' && relatedIds.has(id)))
  const invoiceNos = new Set(related.map((r) => norm(r.invoiceNumber)).filter(Boolean))
  const distinctInvoices = invoiceNos.size > 1 && invoiceNos.size === related.filter((r) => norm(r.invoiceNumber)).length
  add({
    kind: 'legitimate_recurrence', title: 'A regular charge, not a repeat',
    status: series.length || distinctInvoices ? 'indicated' : 'not_indicated',
    explanation: series.length
      ? `These payments belong to a recurring series the detector saved (every ${num(series[0].cadenceDays) ?? '?'} days, ${num(series[0].paymentCount) ?? '?'} payments).`
      : distinctInvoices ? 'The payment rows carry different invoice numbers, which is what separate bills for separate periods look like.' : 'No saved recurring series includes these rows, and they do not carry distinct invoice numbers.',
    citations: series.length ? rec((series[0].recordIds as string[]).filter((id) => typeof id === 'string')) : relatedRefs,
    evidenceGap: 'The supplier contract, subscription or schedule showing whether each payment covers a different period.',
    reviewerCheck: check('recurring'),
    nextActions: ['Compare the payment dates with the contract or subscription schedule.', 'Upload the invoices for each period if you have them.'],
  })

  // Instalments or a split: rows paying less than the invoice, or adding up to one invoice amount.
  const partial = related.filter((r) => { const inv = cents(r.invoiceAmount); const paid = cents(r.amountPaid); return inv !== null && paid !== null && paid > 0 && paid < inv })
  const invoiceAmounts = new Set(related.map((r) => cents(r.invoiceAmount)).filter((n): n is number => n !== null))
  const paidTotal = related.reduce((t, r) => t + (cents(r.amountPaid) ?? 0), 0)
  const sumsToInvoice = related.length > 1 && invoiceAmounts.size === 1 && [...invoiceAmounts][0] === paidTotal
  const termsSay = related.filter((r) => /instal|install|deposit|retain|progress|milestone|split/i.test(str(r.terms)))
  const splitIds = new Set([...partial, ...termsSay].map((r) => r.id).concat(sumsToInvoice ? [...relatedIds] : []))
  add({
    kind: 'instalments_or_split', title: 'Instalments, a split payment or retainage',
    status: splitIds.size ? 'indicated' : 'not_indicated',
    explanation: sumsToInvoice ? 'Together the payments add up to the invoice amount, which is what an invoice paid in parts looks like.'
      : partial.length ? 'At least one payment is smaller than its invoice amount.'
      : termsSay.length ? 'The payment terms mention instalments, a deposit or retainage.' : 'Each payment equals its invoice amount and nothing in the terms suggests instalments.',
    citations: rec(splitIds),
    evidenceGap: 'The invoice or contract showing the payment schedule and the remaining balance after each payment.',
    reviewerCheck: check('installment'),
    nextActions: ['Check the invoice for a payment schedule, deposit or retainage clause.'],
  })

  // Duplicate import: the same row brought in twice, rather than two payments.
  const importFlagged = related.filter((r) => ['exact_duplicate', 'possible_overlap'].includes(str(r.importStatus)))
  const byKey = (key: (r: Rec) => string) => { const seen = new Map<string, string[]>(); for (const r of related) { const k = key(r); if (k) seen.set(k, [...(seen.get(k) ?? []), r.id]) } return [...seen.values()].filter((ids) => ids.length > 1).flat() }
  const sameTxn = byKey((r) => str(r.externalTransactionId))
  const sameFingerprint = byKey((r) => str(r.rowFingerprint))
  const batches = new Set(related.map((r) => str(r.importBatchId)).filter(Boolean))
  const identical = batches.size > 1 ? byKey((r) => `${str(r.paymentDate).slice(0, 10)}|${cents(r.amountPaid)}|${norm(r.invoiceNumber)}`) : []
  const importIds = new Set([...importFlagged.map((r) => r.id), ...sameTxn, ...sameFingerprint, ...identical])
  add({
    kind: 'duplicate_import', title: 'The same payment imported twice',
    status: importIds.size ? 'indicated' : 'not_indicated',
    explanation: sameTxn.length ? 'Two rows carry the same source transaction id.'
      : sameFingerprint.length ? 'Two rows have identical source fingerprints.'
      : importFlagged.length ? 'The importer marked at least one of these rows as a possible repeat of an earlier import.'
      : identical.length ? 'Rows from different imports have the same date, amount and invoice number.' : 'The rows came from distinct source transactions as far as the saved imports show.',
    citations: rec(importIds),
    evidenceGap: 'Your bank or card statement showing whether there were two separate debits.',
    reviewerCheck: check('duplicateImport'),
    nextActions: ['Look for two separate debits on the bank statement for these dates.'],
  })

  // Adjustment, void or reversal booked for this supplier.
  const adjustments = vendorRows.filter((r) => !relatedIds.has(r.id) && /void|revers|adjust|journal|correction/.test(kindOf(r)))
  const relatedVoided = related.filter((r) => /void|revers/.test(kindOf(r)))
  const adjIds = [...adjustments, ...relatedVoided].map((r) => r.id)
  add({
    kind: 'adjustment', title: 'A void, reversal or accounting adjustment',
    status: adjIds.length ? 'indicated' : 'not_indicated',
    explanation: adjIds.length ? `The ledger has ${adjIds.length} void, reversal or adjustment ${adjIds.length === 1 ? 'entry' : 'entries'} for this supplier.` : 'No void, reversal or adjustment entries for this supplier are in the saved ledger.',
    citations: rec(adjIds),
    evidenceGap: 'The accounting system’s audit trail for these payments (voids, reversals, journal entries).',
    reviewerCheck: check('reversal'),
    nextActions: ['Ask whoever keeps the books whether either payment was voided or reversed.'],
  })

  // Refund already received.
  const refunds = vendorRows.filter((r) => (num(r.amountPaid) ?? 0) < 0 && /refund/.test(kindOf(r)))
  const qbRefunds = related.filter((r) => Array.isArray((r.quickbooks as { refundsApplied?: unknown[] } | undefined)?.refundsApplied) && ((r.quickbooks as { refundsApplied: unknown[] }).refundsApplied.length > 0))
  const priorRefunds = (finding.evidence?.priorReturns ?? []).filter((p) => p.method === 'refund')
  const refundIds = [...refunds, ...qbRefunds].map((r) => r.id)
  add({
    kind: 'refund', title: 'The supplier already refunded it',
    status: refundIds.length || priorRefunds.length ? 'indicated' : 'not_indicated',
    explanation: refundIds.length ? `The ledger has ${refundIds.length} refund ${refundIds.length === 1 ? 'entry' : 'entries'} from this supplier.` : priorRefunds.length ? 'The evidence records a confirmed prior refund.' : 'No refund from this supplier is in the saved ledger.',
    citations: rec(refundIds),
    evidenceGap: 'Bank deposits from the supplier after the second payment.',
    reviewerCheck: check('refund'),
    nextActions: ['Search the bank statement for a deposit from the supplier after the later payment.'],
  })

  // Credit issued or applied: ledger credits, QuickBooks credits, or credit lines in linked documents.
  const creditRows = vendorRows.filter((r) => !relatedIds.has(r.id) && /credit/.test(kindOf(r)))
  const qbCredits = related.filter((r) => Array.isArray((r.quickbooks as { creditsApplied?: unknown[] } | undefined)?.creditsApplied) && ((r.quickbooks as { creditsApplied: unknown[] }).creditsApplied.length > 0))
  const creditFacts = input.facts.filter((f) => f.status !== 'rejected' && ['credit_note_ref', 'credit_amount', 'credit_applied_to'].includes(f.kind))
  const creditCites = [...rec([...creditRows, ...qbCredits].map((r) => r.id)), ...creditFacts.map((f) => `document:${f.documentId}#L${f.provenance.line}`)]
  add({
    kind: 'credit', title: 'A credit note was issued or applied',
    status: creditCites.length ? 'indicated' : 'not_indicated',
    explanation: creditFacts.length ? 'A linked document mentions a credit note (a proposed reading, not verified).'
      : creditCites.length ? 'The ledger shows a credit for this supplier.' : 'No credit for this supplier is in the saved ledger or linked documents.',
    citations: creditCites,
    evidenceGap: 'A supplier statement showing whether a credit was issued and which invoice it was applied to.',
    reviewerCheck: check('credit'),
    nextActions: ['Upload the supplier statement covering both payments.', 'Check whether a later invoice was reduced by a credit.'],
  })

  const anyIndicated = candidates.some((x) => x.status === 'indicated')
  add({
    kind: 'uncertain', title: 'Not explained yet',
    status: anyIndicated ? 'not_indicated' : 'indicated',
    explanation: anyIndicated ? 'Some explanations above are indicated; each still needs the evidence named against it.' : 'Nothing in the saved records or linked documents explains the flag. It remains a check for a person to review, not a confirmed leak.',
    citations: relatedRefs,
    evidenceGap: 'The evidence items the recovery gate lists as missing.',
    reviewerCheck: null,
    nextActions: ['Work through the missing evidence listed in the case summary.'],
  })

  const gate = evaluateEligibility(finding, finding.evidence, c.findings)
  return {
    version: SECOND_LOOK_VERSION, source: 'deterministic', projectId: input.projectId, findingId: finding.id, revision: input.revision, caseFingerprint: c.fingerprint,
    detector: { type: finding.type, rule: ruleLabel(finding.type), title: finding.title, explanation: finding.explanation, severity: finding.severity, classification: finding.classification ?? null, flaggedAmountMinor: Math.round(finding.dollarImpact * 100), evidenceState: gate.evidenceState, citations: [`rule:${finding.type}`, ...relatedRefs] },
    candidates, notice: SECOND_LOOK_NOTICE,
  }
}
