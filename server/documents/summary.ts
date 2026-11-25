/**
 * A deterministic, cited summary of one case's evidence, built from the
 * server's own copy (never from what a browser sends). Same rules as "Ask
 * Reclaim" (server/assistant.ts): fixed sentence templates, every sentence
 * carries the ids of the records, rules, documents or lines it rests on, and
 * the evidence gate (src/recovery/eligibility.ts) is the only source of
 * whether a request amount is established.
 *
 * Citation ids: `case:<findingId>@<revision>`, `rule:<type>`, `rule:evidence_gate`,
 * `record:<id>`, `obligation:<id>`, `document:<id>`, `document:<id>#L<line>`.
 */
import { evaluateEligibility } from '../../src/recovery/eligibility.ts'
import { storedCase, type StoredCase } from '../recoveryFacts.ts'
import { FACT_LABELS, type FactView } from './facts.ts'
import type { DocumentView } from './store.ts'

export const SUMMARY_VERSION = 'evidence-summary-2026-11-25.1'

export interface CitedSentence { text: string; citations: string[] }

export interface EvidenceSummary {
  version: string
  source: 'deterministic'
  projectId: string
  findingId: string
  revision: number
  caseFingerprint: string
  sentences: CitedSentence[]
  gate: { eligible: boolean; evidenceState: string; potentialAmountMinor: number | null; currency: string | null }
  missingEvidence: string[]
  contradictions: string[]
  amountBreakdown: { paymentsMinor: number; obligationMinor: number; overpaymentMinor: number; refundedMinor: number; appliedCreditMinor: number; ledgerAdjustmentMinor: number; potentialAmountMinor: number } | null
  supplierReplies: { count: number; statuses: string[] }
  documents: Array<{ id: string; kind: string; status: string; facts: number }>
  facts: Array<{ id: string; documentId: string; kind: string; value: string; line: number; status: string; origin: string; conflicts: number }>
  limitation: string
}

const RULE_LABELS: Record<string, string> = {
  exact_duplicate: 'exact duplicate', near_duplicate: 'near duplicate', overpayment: 'overpayment', unclaimed_discount: 'unclaimed discount',
  missed_discount: 'missed discount', bank_account_change: 'bank account change', amount_outlier: 'unusual amount', shared_invoice_number: 'shared invoice number',
}
export const ruleLabel = (type: string) => RULE_LABELS[type] ?? 'review'
export const usd = (minor: number) => `USD ${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const DOC_KIND: Record<string, string> = { invoice: 'invoice', remittance: 'remittance advice', supplier_statement: 'supplier statement', other: 'document' }

export const LIMITATION = 'Facts read from documents are proposals: none of them changes the case, its evidence or the ledger, and reading a document is never a reviewer attestation. A person decides; the evidence gate decides whether an amount is established.'

/** Record ids mentioned in an eligibility message ("Payment p1-r0: …"), so the sentence can cite them. */
function recordRefs(message: string, recordIds: ReadonlySet<string>): string[] {
  const m = message.match(/^Payment (\S+?):/)
  return m && recordIds.has(m[1]) ? [`record:${m[1]}`] : []
}

export function buildEvidenceSummary(input: { project: Record<string, unknown> | null; projectId: string; findingId: string; revision: number; documents: DocumentView[]; facts: FactView[] }): EvidenceSummary | null {
  const c = storedCase(input.project, input.findingId)
  if (!c) return null
  return summarize(c, input)
}

function summarize(c: StoredCase, input: { projectId: string; findingId: string; revision: number; documents: DocumentView[]; facts: FactView[] }): EvidenceSummary {
  const { finding, state } = c
  const caseRef = `case:${finding.id}@${input.revision}`
  const recordIds = new Set(finding.relatedRecords.map((r) => r.id))
  const records = finding.relatedRecords.map((r) => `record:${r.id}`)
  const gate = evaluateEligibility(finding, finding.evidence, c.findings)
  const s: CitedSentence[] = []
  const say = (text: string, ...citations: string[]) => s.push({ text, citations: [...new Set(citations)] })

  say(`This case was raised by the ${ruleLabel(finding.type)} check over ${plural(records.length, 'payment row')}. A check flags records for review; it does not establish that money is owed.`, `rule:${finding.type}`, ...records)
  const flaggedMinor = Math.round(finding.dollarImpact * 100)
  if (Number.isSafeInteger(flaggedMinor) && flaggedMinor > 0) say(`The detector flagged ${usd(flaggedMinor)} as the payment value involved.`, `rule:${finding.type}`, ...records)

  if (gate.eligible && gate.potentialAmountMinor !== null) {
    say('The saved evidence passes the recovery evidence gate.', 'rule:evidence_gate', caseRef)
  } else {
    say(`The saved evidence does not pass the recovery evidence gate yet (state: ${gate.evidenceState.replaceAll('_', ' ')}).`, 'rule:evidence_gate', caseRef)
  }
  const missing = gate.missingEvidence
  for (const m of missing.slice(0, 12)) say(`Missing: ${m}`, 'rule:evidence_gate', caseRef, ...recordRefs(m, recordIds))
  if (missing.length > 12) say(`${missing.length - 12} more evidence items are missing.`, 'rule:evidence_gate', caseRef)
  for (const m of gate.contradictoryEvidence.slice(0, 12)) say(`Contradiction: ${m}`, 'rule:evidence_gate', caseRef, ...recordRefs(m, recordIds))

  let amountBreakdown: EvidenceSummary['amountBreakdown'] = null
  const evidence = finding.evidence
  if (gate.eligible && gate.potentialAmountMinor !== null && evidence) {
    const paymentsMinor = evidence.payments.reduce((t, p) => t + p.amountMinor, 0)
    const b = gate.amountBreakdown
    amountBreakdown = { paymentsMinor, obligationMinor: evidence.obligation.amountMinor, ...b, potentialAmountMinor: gate.potentialAmountMinor }
    say(`The reviewed settled payments total ${usd(paymentsMinor)} against an attested obligation of ${usd(evidence.obligation.amountMinor)}, a difference of ${usd(b.overpaymentMinor)}.`, ...evidence.payments.map((p) => `record:${p.recordId}`), `obligation:${evidence.obligation.obligationId}`)
    if (b.refundedMinor || b.appliedCreditMinor) say(`Confirmed prior returns reduce it by ${usd(b.refundedMinor + b.appliedCreditMinor)}.`, 'rule:evidence_gate', caseRef)
    if (b.ledgerAdjustmentMinor) say(`The detector's own figure caps it by a further ${usd(b.ledgerAdjustmentMinor)}.`, `rule:${finding.type}`, ...records)
    say(`The possible request is ${usd(gate.potentialAmountMinor)}, subject to the customer's approval. It is not proof the supplier owes it.`, 'rule:evidence_gate', caseRef)
  } else {
    say('No request amount is established: only the evidence gate can establish one, and it has not passed.', 'rule:evidence_gate', caseRef)
  }

  const updates = state.vendorUpdates ?? []
  say(updates.length ? `${plural(updates.length, 'supplier update')} ${updates.length === 1 ? 'is' : 'are'} recorded on the case (${[...new Set(updates.map((u) => u.status.replaceAll('_', ' ')))].join(', ')}).` : 'No supplier replies are recorded on the case.', caseRef)

  const docs = input.documents
  if (!docs.length) say('No documents are linked to this case.', caseRef)
  for (const d of docs) {
    const n = input.facts.filter((f) => f.documentId === d.id).length
    const what = d.status === 'unsupported_format' ? 'is stored but was not read (no PDF or OCR reader exists)' : d.status === 'received' ? 'has not been read yet' : `has ${plural(n, 'proposed fact')}, none verified`
    say(`A ${DOC_KIND[d.kind]} is linked to this case and ${what}.`, `document:${d.id}`)
  }

  const invoiceNumbers = new Set(finding.relatedRecords.map((r) => String(r.invoiceNumber ?? '').trim().toLowerCase()).filter(Boolean))
  const facts = input.facts.filter((f) => f.status !== 'rejected')
  for (const f of facts.slice(0, 30)) {
    const at = `document:${f.documentId}#L${f.provenance.line}`
    const conflict = f.conflicts.length ? ` It conflicts with ${plural(f.conflicts.length, 'other reading')} in the same document (line ${f.conflicts.map((x) => x.line).join(', ')}); nothing was picked.` : ''
    const origin = f.origin === 'ai' ? ' Read by the AI extraction task.' : ''
    say(`Line ${f.provenance.line} gives the ${FACT_LABELS[f.kind]} as ${f.value} (proposed, ${f.status === 'handed_off' ? 'handed to verification' : 'not verified'}).${conflict}${origin}`, at)
    if ((f.kind === 'invoice_ref' || f.kind === 'line_invoice_ref' || f.kind === 'credit_applied_to') && invoiceNumbers.size) {
      const match = invoiceNumbers.has(f.value.trim().toLowerCase())
      say(match ? `That invoice number matches the case's payment rows.` : `That invoice number does not appear on the case's payment rows.`, at, ...records)
    }
  }
  if (facts.length > 30) say(`${facts.length - 30} more proposed facts are not listed here.`, ...docs.map((d) => `document:${d.id}`))
  say(LIMITATION, caseRef)

  return {
    version: SUMMARY_VERSION, source: 'deterministic', projectId: input.projectId, findingId: finding.id, revision: input.revision, caseFingerprint: c.fingerprint,
    sentences: s,
    gate: { eligible: gate.eligible, evidenceState: gate.evidenceState, potentialAmountMinor: gate.potentialAmountMinor, currency: gate.currency },
    missingEvidence: missing, contradictions: gate.contradictoryEvidence, amountBreakdown,
    supplierReplies: { count: updates.length, statuses: updates.map((u) => u.status) },
    documents: docs.map((d) => ({ id: d.id, kind: d.kind, status: d.status, facts: input.facts.filter((f) => f.documentId === d.id).length })),
    facts: input.facts.map((f) => ({ id: f.id, documentId: f.documentId, kind: f.kind, value: f.value, line: f.provenance.line, status: f.status, origin: f.origin, conflicts: f.conflicts.length })),
    limitation: LIMITATION,
  }
}
