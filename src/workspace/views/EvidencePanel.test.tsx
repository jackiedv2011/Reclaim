import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { parseCsv } from '@/lib/csv'
import { mergeImport } from '@/ledger/store'
import { toLedgerImport } from '../../../server/quickbooks.ts'
import { autofillKey } from '@/recovery/quickbooksEvidence'
import { EVIDENCE_CHECKS, evaluateEligibility, type RecoveryEvidence } from '@/recovery/eligibility'
import { EvidencePanel } from './EvidencePanel'
import { dollarsToCents } from './amounts'

const payment = (Id: string, TxnDate: string) => ({ Id, TxnDate, TotalAmt: 1250, PayType: 'Check', VendorRef: { value: '56', name: 'Acme Supply' }, Line: [{ Amount: 1250, LinkedTxn: [{ TxnId: '101', TxnType: 'Bill' }] }] })
const { csv, facts } = toLedgerImport({
  company: { CompanyName: 'Sandbox Co' },
  entities: { Bill: [{ Id: '101', DocNumber: 'INV-7781', TxnDate: '2026-08-01', TotalAmt: 1250 }], BillPayment: [payment('201', '2026-08-20'), payment('202', '2026-08-23')], VendorCredit: [], Deposit: [], Purchase: [] },
}, Date.UTC(2026, 9, 16, 15))
const env = mergeImport(null, { sourceLabel: 'quickbooks-sandbox-co.csv', mode: 'upload', parsed: parseCsv(csv), quickbooks: facts })
const finding = env.result.findings.find((f) => f.type === 'exact_duplicate')!

describe('Evidence review for a QuickBooks finding', () => {
  it('opens pre-filled, marks what came from QuickBooks, and leaves settlement to the reviewer', () => {
    render(<EvidencePanel finding={finding} findings={env.result.findings} imports={env.imports} onSave={() => {}} />)
    expect(screen.getByTestId('quickbooks-autofill-note')).toHaveTextContent('settlement still needs your confirmation')
    expect(screen.getByDisplayValue('qbo:Bill:101')).toBeInTheDocument()
    expect(screen.getByDisplayValue('qbo:BillPayment:202')).toBeInTheDocument()
    // Company, supplier, obligation, payments, and refund/credit searches.
    expect(screen.getAllByTestId('from-quickbooks')).toHaveLength(4 + 4 + 3 * 2 + 2)
    for (const box of screen.getAllByRole('checkbox', { name: /Settled or cleared/ })) expect(box).not.toBeChecked()
  })

  it('drops the mark from a field the reviewer edits, and saves who confirmed the rest', () => {
    const onSave = vi.fn<(evidence: RecoveryEvidence) => void>()
    render(<EvidencePanel finding={finding} findings={env.result.findings} imports={env.imports} onSave={onSave} />)
    const field = screen.getByDisplayValue('qbo:BillPayment:202').closest('label')!
    expect(within(field).getByTestId('from-quickbooks')).toBeInTheDocument()
    fireEvent.change(within(field).getByRole('textbox'), { target: { value: 'Check 1043' } })
    expect(within(field).queryByTestId('from-quickbooks')).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: 'Person confirming these facts' }), { target: { value: 'Jagan' } })
    fireEvent.click(screen.getByRole('button', { name: /Save evidence/ }))
    const saved = onSave.mock.calls[0][0]
    const edited = finding.relatedRecords[1].id
    expect(saved.autofilled?.[autofillKey.paymentId(edited)]).toBeUndefined()
    expect(saved.autofilled?.[autofillKey.obligationId]?.source).toBe('quickbooks')
    expect(saved.obligation.confirmedBy).toBe('Jagan')
    expect(saved.payments.every((p) => !p.settled)).toBe(true)
  })
})

describe('Evidence review in plain words', () => {
  it('asks every check the gate needs exactly once, plus settlement for each payment', () => {
    render(<EvidencePanel finding={finding} findings={env.result.findings} imports={env.imports} onSave={() => {}} />)
    expect(screen.getAllByRole('checkbox')).toHaveLength(EVIDENCE_CHECKS.length + finding.relatedRecords.length)
  })

  it('keeps internal terms out of the questions; rule and record IDs live under Details', () => {
    const { container } = render(<EvidencePanel finding={finding} findings={env.result.findings} imports={env.imports} onSave={() => {}} />)
    const form = container.querySelector('form')!
    for (const term of ['evidence gate', 'minor units', 'obligation', 'eligibility', finding.relatedRecords[0].id]) expect(form.textContent!.toLowerCase()).not.toContain(term.toLowerCase())
    expect(screen.getByText('Details', { selector: 'summary' }).parentElement!.textContent).toContain(finding.ruleId ?? finding.type)
  })

  it('takes the bill amount in dollars and saves it in cents', () => {
    const onSave = vi.fn<(evidence: RecoveryEvidence) => void>()
    render(<EvidencePanel finding={finding} findings={env.result.findings} imports={env.imports} onSave={onSave} />)
    fireEvent.change(screen.getByRole('textbox', { name: /Bill amount, in dollars/ }), { target: { value: '$1,250.5' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Person confirming these facts' }), { target: { value: 'Jagan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save evidence' }))
    expect(onSave.mock.calls[0][0].obligation.amountMinor).toBe(125050)
  })

  it('shows the possible request only once every answer is in', () => {
    const onSave = vi.fn<(evidence: RecoveryEvidence) => void>()
    render(<EvidencePanel finding={finding} findings={env.result.findings} imports={env.imports} onSave={onSave} />)
    for (const box of screen.getAllByRole('checkbox')) if (!(box as HTMLInputElement).checked) fireEvent.click(box)
    for (const input of screen.getAllByRole('textbox', { name: /Where you checked|How you know/ })) if (!(input as HTMLInputElement).value) fireEvent.change(input, { target: { value: 'Searched, none found' } })
    for (const input of screen.getAllByRole('textbox', { name: /Bank reference showing it cleared/ })) if (!(input as HTMLInputElement).value) fireEvent.change(input, { target: { value: 'Statement line' } })
    // Answers count once a named person saves them.
    expect(screen.queryByText(/Possible request supported/)).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Person confirming these facts' }), { target: { value: 'Jagan' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save evidence' }))
    expect(evaluateEligibility(finding, onSave.mock.calls[0][0], env.result.findings).eligible).toBe(true)
    expect(screen.getAllByText(/Possible request supported/).length).toBeGreaterThan(0)
  })
})

describe('Evidence review from a CSV', () => {
  const HEADER = 'vendor,invoice_number,payment_date,invoice_amount,amount_paid,currency,transaction_id,company,supplier_id'
  const csvFinding = (rows: string[], header = HEADER) => {
    const csvEnv = mergeImport(null, { sourceLabel: 'payments.csv', mode: 'upload', parsed: parseCsv([header, ...rows].join('\n')) })
    return { finding: csvEnv.result.findings.find((f) => f.type === 'exact_duplicate')!, findings: csvEnv.result.findings }
  }
  const full = () => csvFinding(['Acme,INV-9,2025-01-10,500,500,USD,TXN-1,Bean Co,SUP-42', 'Acme,INV-9,2025-01-20,500,500,USD,TXN-2,Bean Co,SUP-42'])
  const bare = () => csvFinding(['Acme,INV-9,2025-01-10,500,500', 'Acme,INV-9,2025-01-20,500,500'], 'vendor,invoice_number,payment_date,invoice_amount,amount_paid')
  const value = (name: RegExp | string) => (screen.getByRole('textbox', { name }) as HTMLInputElement).value

  it('starts from everything the file says', () => {
    render(<EvidencePanel {...full()} onSave={() => {}} />)
    expect(value(/^Company or legal entity/)).toBe('Bean Co')
    expect(value(/^Supplier account or vendor ID/)).toBe('SUP-42')
    expect(value(/^Bill or invoice number/)).toBe('INV-9')
    expect(value(/^Bill amount/)).toBe('500.00')
    expect(value(/^Currency/)).toBe('USD')
    expect(screen.getAllByRole('textbox', { name: /^Payment or check number/ }).map((n) => (n as HTMLInputElement).value)).toEqual(['TXN-1', 'TXN-2'])
    // Nothing the file can't vouch for is filled in.
    expect(screen.getAllByRole('textbox', { name: /^Bank reference/ }).every((n) => (n as HTMLInputElement).value === '')).toBe(true)
  })

  it('asks for the currency once and applies it to every payment, unless one differs', () => {
    const onSave = vi.fn<(evidence: RecoveryEvidence) => void>()
    render(<EvidencePanel {...bare()} onSave={onSave} />)
    expect(screen.getAllByRole('textbox', { name: /Currency/ })).toHaveLength(1)
    fireEvent.change(screen.getByRole('textbox', { name: /^Currency/ }), { target: { value: 'usd' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Person confirming these facts' }), { target: { value: 'Ana' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save evidence' }))
    expect(onSave.mock.calls[0][0].payments.map((p) => p.currency)).toEqual(['USD', 'USD'])
    fireEvent.click(screen.getByRole('button', { name: 'A payment was in a different currency' }))
    fireEvent.change(screen.getAllByRole('textbox', { name: /^Currency of this payment/ })[1], { target: { value: 'EUR' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save evidence' }))
    expect(onSave.mock.calls[1][0]).toMatchObject({ obligation: { currency: 'USD' }, payments: [{ currency: 'USD' }, { currency: 'EUR' }] })
    expect(evaluateEligibility(bare().finding, onSave.mock.calls[1][0]).eligible).toBe(false)
  })

  it('lists what is missing in the open, in plain words, and shrinks as it is answered', () => {
    render(<EvidencePanel {...bare()} onSave={() => {}} />)
    const list = () => screen.getByTestId('missing-answers')
    expect(list().closest('details')).toBeNull()
    expect(list()).toHaveTextContent('Company or legal entity')
    expect(list()).toHaveTextContent('$500.00 paid Jan 10, 2025: payment or check number')
    expect(list()).toHaveTextContent('I checked for refunds: tick it and say where you checked')
    expect(list().textContent).not.toMatch(/rec_\d|obligation|attest|identity/i)
    const before = list().querySelectorAll('li').length
    fireEvent.change(screen.getByRole('textbox', { name: /^Company or legal entity/ }), { target: { value: 'Bean Co' } })
    expect(list().querySelectorAll('li').length).toBe(before - 1)
  })

  it('does not call blank payment numbers identical', () => {
    const { finding: f, findings } = bare()
    render(<EvidencePanel finding={f} findings={findings} onSave={() => {}} />)
    fireEvent.change(screen.getByRole('textbox', { name: /^Company or legal entity/ }), { target: { value: 'Bean Co' } })
    expect(screen.queryByText(/not distinct|same payment or check number|don’t line up/)).toBeNull()
    for (const input of screen.getAllByRole('textbox', { name: /^Payment or check number/ })) fireEvent.change(input, { target: { value: '1043' } })
    expect(screen.getByText('Two payments have the same payment or check number. Each needs its own.')).toBeInTheDocument()
  })

  it('can be saved part way, and refuses a contact address the server would refuse', () => {
    const onSave = vi.fn<(evidence: RecoveryEvidence) => void>()
    render(<EvidencePanel {...bare()} onSave={onSave} />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Person confirming these facts' }), { target: { value: 'Ana' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save evidence' }))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status')).toHaveTextContent('Saved. Answer the rest when you have it.')
    fireEvent.click(screen.getByText('Supplier billing contact (optional)'))
    fireEvent.click(screen.getByRole('button', { name: 'Add contact suggestion' }))
    fireEvent.change(screen.getByRole('textbox', { name: /^Billing email/ }), { target: { value: 'ap@vendor.c' } })
    fireEvent.change(screen.getByRole('textbox', { name: /^Contact source reference/ }), { target: { value: 'Supplier file' } })
    expect(screen.getByRole('button', { name: 'Save evidence' })).toBeDisabled()
  })
})

describe('dollarsToCents', () => {
  it('reads what people type without floating-point drift', () => {
    expect(dollarsToCents('6800')).toBe(680000)
    expect(dollarsToCents('$6,800.5')).toBe(680050)
    expect(dollarsToCents('0.29')).toBe(29)
    expect(dollarsToCents('1.005')).toBe(0)
    expect(dollarsToCents('-5')).toBe(0)
    expect(dollarsToCents('abc')).toBe(0)
  })
})
