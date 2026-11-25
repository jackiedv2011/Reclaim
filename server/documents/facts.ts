/**
 * Proposed facts: what a document appears to say, never what is true.
 *
 * A fact read from a document (by the deterministic parser or, with consent,
 * by a model) is an untrusted proposal with a pointer to the exact line it
 * came from. It is never written into a case, its evidence or the ledger, and
 * reading it is never a reviewer attestation. The only thing Reclaim does
 * with one is show it to a person and hand it to the financial verification
 * layer (Sid) through `FactVerifier`, which decides.
 */
import type { TenantContext } from '../tenant.ts'

export const DOCUMENT_KINDS = ['invoice', 'remittance', 'supplier_statement', 'other'] as const
export type DocumentKind = typeof DOCUMENT_KINDS[number]

/** One value per document. Two different readings of one of these are a conflict, never a choice. */
export const SINGLE_FACT_KINDS = [
  'supplier_ref', 'invoice_ref', 'currency', 'invoice_date', 'due_date', 'amount_due', 'amount_paid',
  'payment_date', 'payment_ref', 'credit_note_ref', 'credit_amount', 'credit_applied_to', 'statement_balance',
] as const
/** Repeatable rows of a remittance advice or statement, grouped by `row`. */
export const LINE_FACT_KINDS = ['line_invoice_ref', 'line_amount', 'line_date'] as const
export const FACT_KINDS = [...SINGLE_FACT_KINDS, ...LINE_FACT_KINDS] as const
export type FactKind = typeof FACT_KINDS[number]
export const MONEY_KINDS: ReadonlySet<FactKind> = new Set(['amount_due', 'amount_paid', 'credit_amount', 'statement_balance', 'line_amount'])
export const DATE_KINDS: ReadonlySet<FactKind> = new Set(['invoice_date', 'due_date', 'payment_date', 'line_date'])

export const FACT_LABELS: Record<FactKind, string> = {
  supplier_ref: 'supplier reference', invoice_ref: 'invoice number', currency: 'currency', invoice_date: 'invoice date', due_date: 'due date',
  amount_due: 'amount due (as written)', amount_paid: 'amount paid (as written)', payment_date: 'payment date', payment_ref: 'payment reference',
  credit_note_ref: 'credit note number', credit_amount: 'credit amount (as written)', credit_applied_to: 'credit applied to',
  statement_balance: 'statement balance (supplier’s figure)', line_invoice_ref: 'row invoice number', line_amount: 'row amount (as written)', line_date: 'row date',
}

/** Fields each kind of document is expected to carry; anything not found is listed as unknown, never guessed. */
export const EXPECTED_FIELDS: Record<DocumentKind, readonly FactKind[]> = {
  invoice: ['supplier_ref', 'invoice_ref', 'currency', 'invoice_date', 'due_date', 'amount_due'],
  remittance: ['supplier_ref', 'payment_date', 'payment_ref', 'amount_paid', 'currency'],
  supplier_statement: ['supplier_ref', 'statement_balance', 'currency'],
  other: [],
}

export interface FactProvenance {
  /** 1-based line in the stored document text. */
  line: number
  /** Character offsets of the value within that line. */
  charStart: number
  charEnd: number
  /** The line as written, trimmed and capped at 120 characters. */
  excerpt: string
}

export interface FactConflict { value: string; line: number; factId: string }

export interface ProposedFact {
  id: string
  documentId: string
  kind: FactKind
  /** Normalised: amounts as a decimal string ("1250.00"), dates as YYYY-MM-DD, references as written. */
  value: string
  /** Amounts only: the value in minor units, as written (sign kept). */
  amountMinor?: number
  /** Line facts only: the row they belong to. */
  row?: number
  provenance: FactProvenance
  confidence: 'high' | 'medium' | 'low'
  conflicts: FactConflict[]
  origin: 'deterministic' | 'ai'
}

export type FactStatus = 'proposed' | 'handed_off' | 'rejected'

export interface FactView extends ProposedFact {
  status: FactStatus
  projectId: string
  findingId: string | null
  createdAt: number
  verification: { verifier: string; fixture: boolean; outcome: VerificationOutcome; reason: string; at: number } | null
  /** Always false: nothing here is verified by Reclaim's own reading. */
  authoritative: false
}

/**
 * Conflicts within one set of facts: for single-value kinds, every reading
 * that disagrees with another is listed on each of them, and each drops to
 * low confidence. Nothing is picked.
 */
export function markConflicts<T extends ProposedFact>(facts: T[]): T[] {
  const byKind = new Map<string, T[]>()
  for (const f of facts) if ((SINGLE_FACT_KINDS as readonly string[]).includes(f.kind)) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f])
  return facts.map((f) => {
    const peers = byKind.get(f.kind)
    if (!peers) return { ...f, conflicts: [] }
    const others = peers.filter((p) => p.id !== f.id && p.value !== f.value)
    return others.length ? { ...f, confidence: 'low' as const, conflicts: others.map((o) => ({ value: o.value, line: o.provenance.line, factId: o.id })) } : { ...f, conflicts: [] }
  })
}

// ---------- hand-off to financial verification (Sid) ----------

export type VerificationOutcome = 'accepted' | 'rejected' | 'needs_review'
export interface FactVerification { factId: string; outcome: VerificationOutcome; reason: string }

/**
 * The entry point Reclaim asks Sid's verification layer for. Given proposed
 * facts read from one tenant's document, it answers per fact: accepted
 * (matches verified ledger or source-system data), rejected (contradicted or
 * malformed) or needs_review (a person must decide). It must not write to the
 * case; accepting a fact is its decision about the fact, not an attestation.
 */
export interface FactVerifier {
  readonly name: string
  /** True for the stand-in below; the API reports it so nothing mistakes it for verification. */
  readonly fixture: boolean
  verifyProposedFacts(tenant: TenantContext, projectId: string, facts: readonly ProposedFact[]): Promise<FactVerification[]>
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/
const DECIMAL = /^-?\d+\.\d{2}$/

/**
 * FIXTURE — stands in for Sid's verifier until it exists. It checks shape
 * only (known kind, well-formed value, provenance present) and never accepts:
 * a well-formed fact is `needs_review`, a malformed one `rejected`.
 */
export const fixtureFactVerifier: FactVerifier = {
  name: 'fixture-shape-check',
  fixture: true,
  async verifyProposedFacts(_tenant, _projectId, facts) {
    return facts.map((f) => {
      const problem = !(FACT_KINDS as readonly string[]).includes(f.kind) ? 'Unknown fact kind.'
        : !f.value || f.value.length > 120 ? 'Missing or oversized value.'
        : MONEY_KINDS.has(f.kind) && (!DECIMAL.test(f.value) || !Number.isSafeInteger(f.amountMinor)) ? 'Amount is not a two-decimal number.'
        : DATE_KINDS.has(f.kind) && !ISO_DAY.test(f.value) ? 'Date is not YYYY-MM-DD.'
        : !(f.provenance?.line >= 1) ? 'No source line.'
        : null
      return problem
        ? { factId: f.id, outcome: 'rejected' as const, reason: `Fixture shape check: ${problem}` }
        : { factId: f.id, outcome: 'needs_review' as const, reason: 'Fixture verifier: shape checked only. No ledger or source-system verification exists yet; a person must review this fact.' }
    })
  },
}
