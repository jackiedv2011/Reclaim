// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { extractDocument, findMoney, readDate } from './extract.ts'
import { fixtureFactVerifier } from './facts.ts'
import { INVOICE_TEXT, MALICIOUS_TEXT } from './fixtures.ts'
import { tenantForUser } from '../tenant.ts'

const read = (text: string, kind: 'invoice' | 'remittance' | 'supplier_statement' | 'other' = 'invoice', format: 'text' | 'csv' = 'text') => extractDocument({ documentId: 'doc_test', kind, text, format })
const values = (r: ReturnType<typeof read>) => Object.fromEntries(r.facts.filter((f) => f.row === undefined).map((f) => [f.kind, f.value]))

describe('deterministic extraction', () => {
  it('reads a complete text invoice with exact provenance', () => {
    const r = read(INVOICE_TEXT)
    expect(values(r)).toEqual({ invoice_ref: 'INV-1001', supplier_ref: 'NWP-77', invoice_date: '2025-01-01', due_date: '2025-01-31', currency: 'USD', amount_due: '1250.00' })
    expect(r.unknownFields).toEqual([])
    const due = r.facts.find((f) => f.kind === 'amount_due')!
    expect(due).toMatchObject({ amountMinor: 125000, confidence: 'high', conflicts: [], origin: 'deterministic', provenance: { line: 8, excerpt: 'Amount due: USD 1,250.00' } })
    expect(INVOICE_TEXT.split('\n')[7].slice(due.provenance.charStart, due.provenance.charEnd)).toBe('USD 1,250.00')
  })

  it('lists missing fields as unknown instead of guessing', () => {
    const r = read('Invoice no: INV-2\nThank you for your business')
    expect(values(r)).toEqual({ invoice_ref: 'INV-2' })
    expect(r.unknownFields).toEqual(['supplier_ref', 'currency', 'invoice_date', 'due_date', 'amount_due'])
  })

  it('a label with no value is ambiguous, not a fact', () => {
    const r = read('Invoice no: INV-3\nAmount due: see attached schedule\nDue date: TBC')
    expect(r.facts.map((f) => f.kind)).toEqual(['invoice_ref'])
    expect(r.ambiguousLines).toEqual([{ line: 2, reason: 'label_without_value' }, { line: 3, reason: 'label_without_value' }])
  })

  it('keeps contradictory amounts as conflicts and never picks one', () => {
    const r = read('Invoice no: INV-4\nAmount due: 1,250.00\nnotes\nTotal due: 1,520.00')
    const due = r.facts.filter((f) => f.kind === 'amount_due')
    expect(due.map((f) => f.value)).toEqual(['1250.00', '1520.00'])
    expect(due.every((f) => f.confidence === 'low' && f.conflicts.length === 1)).toBe(true)
    expect(due[0].conflicts[0]).toMatchObject({ value: '1520.00', line: 4 })
    expect(r.warnings.join(' ')).toMatch(/different values/)
  })

  it('the same value printed twice is one reading, and two values on one label line are ambiguous', () => {
    expect(read('Amount due: 10.00\nAmount due: 10.00').facts.filter((f) => f.kind === 'amount_due')).toHaveLength(1)
    expect(read('Total due: 1,200.00 1,250.00').ambiguousLines).toEqual([{ line: 1, reason: 'several_values' }])
  })

  it('conflicting currencies and invoice numbers are conflicts too', () => {
    const r = read('Invoice no: INV-5\nInvoice no: INV-6\nAmount due: EUR 10.00\nCurrency: USD')
    expect(r.facts.filter((f) => f.kind === 'invoice_ref').every((f) => f.conflicts.length === 1)).toBe(true)
    expect(r.facts.filter((f) => f.kind === 'currency').map((f) => f.value).sort()).toEqual(['EUR', 'USD'])
    expect(r.facts.filter((f) => f.kind === 'currency').every((f) => f.conflicts.length === 1)).toBe(true)
  })

  it('a bare $ does not establish the currency', () => {
    const r = read('Invoice no: INV-7\nAmount due: $40.00')
    expect(values(r).currency).toBeUndefined()
    expect(r.unknownFields).toContain('currency')
  })

  it('day-first or month-first dates are ambiguous unless only one reading exists', () => {
    expect(readDate('03/04/2026')).toEqual({ ambiguous: true, length: 10 })
    expect(readDate('13/04/2026')).toEqual({ value: '2026-04-13', length: 10 })
    expect(readDate('2026-02-30')).toBeNull()
    expect(read('Invoice date: 03/04/2026').ambiguousLines).toEqual([{ line: 1, reason: 'ambiguous_date' }])
  })

  it('withholds instruction-like and bank lines and never reads facts from them', () => {
    const r = read(MALICIOUS_TEXT)
    expect(r.withheldLines).toEqual([{ line: 2, reason: 'instruction_like' }])
    expect(r.facts.some((f) => f.amountMinor === 999900)).toBe(false)
    expect(values(r)).toMatchObject({ invoice_ref: 'INV-1001', amount_due: '1250.00' })
    expect(r.ambiguousLines).toEqual([{ line: 4, reason: 'unlabelled_amount' }])
    const bank = read('Amount due: 10.00\nIBAN: GB33 BUKB 2020 1555 5555 55\nRouting number 021000021, Amount due: 9.00')
    expect(bank.withheldLines.map((w) => w.reason)).toEqual(['bank_detail', 'bank_detail'])
    expect(bank.facts.map((f) => f.value)).toEqual(['10.00'])
  })

  it('reads remittance rows from CSV as rows, and infers nothing from them', () => {
    const csv = 'Remittance advice\nInvoice,Payment date,Amount paid\nINV-1001,2025-01-12,"1,250.00"\nINV-1002,13/01/2025,300.00\nINV-1003,02/03/2025,75.5x'
    const r = read(csv, 'remittance', 'csv')
    const rows = r.facts.filter((f) => f.row !== undefined)
    expect(rows.filter((f) => f.kind === 'line_invoice_ref').map((f) => f.value)).toEqual(['INV-1001', 'INV-1002', 'INV-1003'])
    expect(rows.filter((f) => f.kind === 'line_amount').map((f) => f.value)).toEqual(['1250.00', '300.00'])
    expect(rows.filter((f) => f.kind === 'line_date').map((f) => f.value)).toEqual(['2025-01-12', '2025-01-13'])
    expect(r.ambiguousLines).toEqual([{ line: 5, reason: 'label_without_value' }])
    // A payment row is not a debt, a dispute or a delivery problem.
    expect(r.facts.some((f) => ['amount_due', 'statement_balance', 'credit_amount'].includes(f.kind))).toBe(false)
    expect(r.unknownFields).toEqual(['supplier_ref', 'payment_date', 'payment_ref', 'amount_paid', 'currency'])
  })

  it('reads a supplier statement balance and credit note as the supplier wrote them', () => {
    const r = read('Supplier ID: NWP-77\nCredit note no: CN-88\nCredit amount: (75.00)\nApplied to invoice: INV-1001\nClosing balance: USD 0.00', 'supplier_statement')
    expect(values(r)).toEqual({ supplier_ref: 'NWP-77', credit_note_ref: 'CN-88', credit_amount: '-75.00', credit_applied_to: 'INV-1001', statement_balance: '0.00', currency: 'USD' })
  })

  it('money needs two decimals or a currency marker', () => {
    expect(findMoney('Order 12345 on 2025.01.05').length).toBe(0)
    expect(findMoney('USD 40').map((m) => m.minor)).toEqual([4000])
    expect(findMoney('(1,250.00)').map((m) => m.minor)).toEqual([-125000])
  })
})

describe('FIXTURE fact verifier', () => {
  it('checks shape only and never accepts', async () => {
    const r = read(INVOICE_TEXT)
    const tenant = tenantForUser({ id: 'u1', email: 'u1@example.test' })
    const verdicts = await fixtureFactVerifier.verifyProposedFacts(tenant, 'p1', [...r.facts, { ...r.facts[0], id: 'bad', kind: 'amount_due', value: 'lots' }])
    expect(fixtureFactVerifier.fixture).toBe(true)
    expect(verdicts.slice(0, -1).every((v) => v.outcome === 'needs_review')).toBe(true)
    expect(verdicts.at(-1)).toMatchObject({ factId: 'bad', outcome: 'rejected' })
    expect(verdicts.some((v) => v.outcome === 'accepted')).toBe(false)
  })
})
