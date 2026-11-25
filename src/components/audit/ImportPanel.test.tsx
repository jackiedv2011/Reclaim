import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildXlsx, plainRows } from '@/test/buildXlsx'
import { ImportPanel, type ImportInput } from '@/components/audit/ImportPanel'

function mount() {
  const onImport = vi.fn()
  render(<ImportPanel allowSample={false} error={null} onImport={onImport} intro="Upload" confirmLabel="Run the audit" />)
  const input = screen.getByLabelText(/upload a csv ledger/i)
  return { onImport, upload: (file: File) => fireEvent.change(input, { target: { files: [file] } }) }
}

describe('upload guard rails', () => {
  it('a file that only looks like a workbook says so, and what to do', async () => {
    const { upload, onImport } = mount()
    upload(new File(['PK\u0003\u0004binary'], 'ledger.xlsx'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/isn’t a readable Excel workbook.*save it as CSV/)
    expect(onImport).not.toHaveBeenCalled()
  })

  it('an old .xls or locked workbook is told apart', async () => {
    const { upload } = mount()
    upload(new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 1, 2])], 'ledger.xls'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/old \.xls file or a password-protected workbook/)
  })

  it('a binary file renamed to .csv is recognized as not a CSV', async () => {
    const { upload } = mount()
    upload(new File(['\u0000\u0001binary'], 'ledger.csv'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/isn’t a csv/i)
  })

  it('an empty CSV explains what is missing', async () => {
    const { upload } = mount()
    upload(new File([''], 'empty.csv'))
    expect(await screen.findByRole('alert')).toHaveTextContent(/a vendor \(or payee\) name, a payment date and the amount paid/)
  })

  it('a file over the size limit is refused before it is read', async () => {
    const { upload } = mount()
    const big = new File(['x'], 'huge.csv')
    Object.defineProperty(big, 'size', { value: 60 * 1024 * 1024 })
    const text = vi.spyOn(big, 'arrayBuffer')
    upload(big)
    expect(await screen.findByRole('alert')).toHaveTextContent(/60\.0 MB/)
    expect(text).not.toHaveBeenCalled()
  })

  it('a CSV with some bad rows shows how many will be skipped before anything is saved', async () => {
    const { upload, onImport } = mount()
    upload(new File(['vendor,payment_date,amount_paid\nAcme,2025-01-01,100\nBad,notadate,5\nEuro,2025-01-02,"1.234,56"\n'], 'mixed.csv'))
    expect((await screen.findByText('Valid records')).closest('div')).toHaveTextContent('1')
    expect(screen.getByText(/2 rows need attention and will be skipped/)).toBeInTheDocument()
    expect(onImport).not.toHaveBeenCalled()
  })
})

describe('matching columns', () => {
  const csv = (...lines: string[]) => new File([lines.join('\n')], 'export.csv', { type: 'text/csv' })
  const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement
  const continueButton = () => screen.getByRole('button', { name: 'Continue' })
  const imported = (onImport: ReturnType<typeof vi.fn>) => (onImport.mock.calls[0][0] as ImportInput).parsed
  const chosen = (name: string) => select(name).selectedOptions[0].textContent

  it('a file with known headings goes straight to the confirm screen', async () => {
    const { upload } = mount()
    upload(csv('Vendor,Payment Date,Amount Paid', 'Acme,2026-03-04,100'))
    expect(await screen.findByText('Valid records')).toBeInTheDocument()
    expect(screen.queryByText('How Reclaim read this file')).not.toBeInTheDocument()
  })

  it('a raw export shows its own headings and rows, suggests matches, and imports once confirmed', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    upload(csv('Harbour Cafe', 'Payments', '', 'Date,Contact,Reference,Amount', '04 Mar 2026,Acme Ltd,INV-1,"1,200.00"', '05 Mar 2026,Beta Ltd,INV-2,80'))

    const preview = await screen.findByRole('region', { name: 'First rows of the file' })
    expect(within(preview).getByRole('columnheader', { name: /Contact/ })).toHaveTextContent('Vendor')
    expect(within(preview).getByRole('rowheader', { name: '5' })).toBeInTheDocument()
    expect(within(preview).getByText('Acme Ltd')).toBeInTheDocument()
    expect(screen.getByText(/Skipping 2 lines above the headings: “Harbour Cafe”, “Payments”/)).toBeInTheDocument()
    expect(chosen('Vendor')).toBe('Contact (Acme Ltd)')
    expect(chosen('Payment date')).toBe('Date (04 Mar 2026)')
    expect(chosen('Amount paid')).toBe('Amount (1,200.00)')
    expect(select('Vendor')).toHaveAccessibleDescription('Suggested. Check it is right.')
    expect(onImport).not.toHaveBeenCalled()

    await user.click(continueButton())
    expect(screen.getByText(/vendor from “Contact”/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Run the audit' }))
    const parsed = imported(onImport)
    expect(parsed.records.map((r) => [r.vendor, r.invoiceNumber, r.amountPaid, r.source?.rowNumber])).toEqual([['Acme Ltd', 'INV-1', 1200, 5], ['Beta Ltd', 'INV-2', 80, 6]])
    expect(parsed.records[0].source?.raw).toEqual({ Date: '04 Mar 2026', Contact: 'Acme Ltd', Reference: 'INV-1', Amount: '1,200.00' })
  })

  it('never picks between two possible date or amount columns', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    upload(csv('Name,Date,Due Date,Debit,Credit', 'Acme,2026-03-04,2026-04-04,10.00,', 'Beta,2026-03-05,2026-04-05,20.00,1.00'))
    expect(await screen.findByText('Still to choose: payment date, amount paid.')).toBeInTheDocument()
    expect(select('Payment date')).toHaveValue('')
    expect(select('Payment date')).toHaveAccessibleDescription('Could be “Date” or “Due Date”. Choose one.')
    expect(select('Amount paid')).toHaveAccessibleDescription('Could be “Debit” or “Credit”. Choose one.')
    expect(continueButton()).toBeDisabled()

    await user.selectOptions(select('Payment date'), '1')
    await user.selectOptions(select('Amount paid'), '3')
    await user.click(continueButton())
    await user.click(screen.getByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records.map((r) => r.amountPaid)).toEqual([10, 20])
  })

  it('one column feeds one field: choosing it again moves it', async () => {
    const user = userEvent.setup()
    const { upload } = mount()
    upload(csv('Contact,Date,Amount', 'Acme,2026-03-04,10.00'))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Payment date' }), '0')
    expect(select('Vendor')).toHaveValue('')
    expect(continueButton()).toBeDisabled()
  })

  it('asks which way round the dates are, showing what each answer means', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    upload(csv('Vendor,Payment Date,Amount Paid', 'Acme,04/03/2026,100'))
    expect(await screen.findByText('Which way round are the dates?')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Month first.*04\/03\/2026 is April 3, 2026/ })).not.toBeChecked()
    expect(continueButton()).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /Day first.*04\/03\/2026 is 4 March 2026/ }))
    await user.click(continueButton())
    expect(screen.getByText('Dates read day first.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records[0].paymentDate).toEqual(new Date(2026, 2, 4))
  })

  it('reads a day-first file without asking when one of its dates proves it, and says so', async () => {
    const { upload } = mount()
    upload(csv('Vendor,Payment Date,Amount Paid', 'Acme,04/03/2026,100', 'Acme,25/03/2026,100'))
    expect(await screen.findByText('Dates read day first.')).toBeInTheDocument()
    expect(screen.getByText('Mar 4, 2026 – Mar 25, 2026')).toBeInTheDocument()
  })

  it('offers to flip the sign when every payment is negative, and says what that does', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    upload(csv('Vendor,Payment Date,Amount Paid', 'Acme,2026-03-04,"-1,200.00"', 'Beta,2026-03-05,-80'))
    expect(await screen.findByText(/All 2 amounts paid in this file are negative\. Reclaim reads a negative amount as a refund or credit/)).toBeInTheDocument()
    expect(continueButton()).toBeDisabled()
    await user.click(screen.getByRole('radio', { name: /Yes, flip the sign.*-1,200\.00 is read as 1,200\.00, a payment/ }))
    await user.click(continueButton())
    expect(screen.getByText('Negative amounts read as payments (every sign flipped).')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records.map((r) => r.amountPaid)).toEqual([1200, 80])
    expect(imported(onImport).records[0].source?.raw?.amount_paid).toBe('-1,200.00')
  })

  it('keeps the amounts negative when the person says they are credits', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    upload(csv('Vendor,Payment Date,Amount Paid', 'Acme,2026-03-04,-5'))
    await user.click(await screen.findByRole('radio', { name: /No, they are refunds or credits/ }))
    await user.click(continueButton())
    await user.click(screen.getByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records[0].amountPaid).toBe(-5)
  })

  it('goes back from the confirm screen to change a match, keeping the choices made', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    upload(csv('Contact,Payer,Date,Amount', 'Acme,Us,04/03/2026,10.00'))
    await user.click(await screen.findByRole('radio', { name: /Day first/ }))
    await user.click(continueButton())
    await user.click(screen.getByRole('button', { name: 'Check the column matches' }))
    expect(screen.getByRole('radio', { name: /Day first/ })).toBeChecked()
    await user.selectOptions(select('Vendor'), '1')
    await user.click(continueButton())
    await user.click(screen.getByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records[0]).toMatchObject({ vendor: 'Us', paymentDate: new Date(2026, 2, 4) })
  })

  it('forgets an answer about dates when a different date column is chosen', async () => {
    const user = userEvent.setup()
    const { upload } = mount()
    upload(csv('Name,Date,Due Date,Amount', 'Acme,04/03/2026,05/04/2026,10.00'))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Payment date' }), '1')
    await user.click(screen.getByRole('radio', { name: /Day first/ }))
    expect(continueButton()).toBeEnabled()
    await user.selectOptions(select('Payment date'), '2')
    expect(screen.getByRole('radio', { name: /Day first/ })).not.toBeChecked()
    expect(continueButton()).toBeDisabled()
  })

  it('stays on the step, and says why, when the choices read no rows', async () => {
    const user = userEvent.setup()
    const { upload } = mount()
    upload(csv('Contact,Date,Amount,Note', 'Acme,2026-03-04,10.00,x'))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Payment date' }), '3')
    await user.click(continueButton())
    expect(screen.getByRole('alert')).toHaveTextContent(/Row 2: “x” isn’t a date/)
  })

  it('lets the person point at the heading row', async () => {
    const user = userEvent.setup()
    const { upload } = mount()
    upload(csv('Vendor,Type,Account', 'Uno,Dos,Tres', 'Acme,2026-03-04,10.00'))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Headings are on row' }), '2')
    expect(screen.getByRole('columnheader', { name: /Dos/ })).toBeInTheDocument()
  })

  it('known headings over empty columns lead to the matches, not a dead end', async () => {
    const { upload } = mount()
    upload(csv('Vendor,Payment Date,Amount Paid,Date', 'Acme,,10,2026-03-04'))
    expect(await screen.findByText(/no row had a vendor, a payment date and an amount paid under them\. Row 2: no payment date\./)).toBeInTheDocument()
    expect(select('Payment date')).toBeInTheDocument()
  })

  it('a different file can be chosen instead', async () => {
    const user = userEvent.setup()
    const { upload } = mount()
    upload(csv('Contact,Date,Amount', 'Acme,2026-03-04,10.00'))
    await user.click(await screen.findByRole('button', { name: 'Choose a different file' }))
    expect(screen.getByLabelText(/upload a csv ledger/i)).toBeInTheDocument()
  })

  it('reads an Excel workbook with known headings straight through, dates and all', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    const rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>Vendor</t></is></c><c r="B1" t="inlineStr"><is><t>Payment Date</t></is></c><c r="C1" t="inlineStr"><is><t>Amount Paid</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Acme</t></is></c><c r="B2" s="1"><v>46085</v></c><c r="C2"><v>1200.5</v></c></row>'
    upload(new File([buildXlsx([{ name: 'Payments', rows }]) as BlobPart], 'payments.xlsx'))
    await user.click(await screen.findByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records[0]).toMatchObject({ vendor: 'Acme', amountPaid: 1200.5, paymentDate: new Date(2026, 2, 4) })
    expect(imported(onImport).records[0].source).toMatchObject({ rowNumber: 2, raw: { payment_date: '2026-03-04', amount_paid: '1200.5' } })
  })

  it('a workbook with several sheets asks which to read', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    const sheet = (vendor: string) => plainRows([['Vendor', 'Payment Date', 'Amount Paid'], [vendor, '2026-03-04', 10], [vendor, '2026-03-05', 20]])
    upload(new File([buildXlsx([{ name: 'January', rows: sheet('Acme') }, { name: 'Notes', rows: plainRows([['hello']]) }, { name: 'February', rows: sheet('Beta') }]) as BlobPart], 'payments.xlsx'))
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Read the sheet' }), 'February')
    await user.click(continueButton())
    expect(screen.getByText('Read from the sheet “February”; left out: “January”, “Notes”.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records.map((r) => r.vendor)).toEqual(['Beta', 'Beta'])
  })

  it('a report grouped by vendor says so, and can be told otherwise', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    upload(csv(',Date,Memo,Amount', 'Acme,,,', ',2026-01-05,,100.00', ',2026-01-20,,50.00', 'Total for Acme,,,150.00'))
    const box = await screen.findByRole('checkbox', { name: /Each vendor’s name is written once/ })
    expect(box).toBeChecked()
    await user.click(continueButton())
    expect(screen.getByText('Vendor names taken from the line above each group of payments.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records.map((r) => r.vendor)).toEqual(['Acme', 'Acme'])
  })

  it('a file with no headings keeps its first payment', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    upload(csv('Acme,2026-01-05,100.00', 'Beta,2026-01-06,200.00'))
    expect(await screen.findByRole('combobox', { name: 'Headings are on row' })).toHaveValue('0')
    await user.selectOptions(select('Vendor'), '0')
    await user.click(continueButton())
    await user.click(screen.getByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records.map((r) => r.vendor)).toEqual(['Acme', 'Beta'])
  })

  it('an older Windows export keeps its accents apart', async () => {
    const user = userEvent.setup()
    const { upload, onImport } = mount()
    upload(new File([new Uint8Array([...'vendor,payment_date,amount_paid\nM'].map((c) => c.charCodeAt(0)).concat([0xfc], [...'ller,2026-01-05,1\n'].map((c) => c.charCodeAt(0))))], 'old.csv'))
    await user.click(await screen.findByRole('button', { name: 'Run the audit' }))
    expect(imported(onImport).records[0].vendor).toBe('Müller')
  })

  it('a second file chosen while the first is being read replaces it', async () => {
    const { upload } = mount()
    const slow = csv('Contact,Date,Amount', 'Slow,2026-03-04,10.00')
    let release = () => {}
    const bytes = slow.arrayBuffer()
    slow.arrayBuffer = () => new Promise((resolve) => { release = () => void bytes.then(resolve) })
    upload(slow)
    upload(csv('Contact,Date,Amount', 'Fast,2026-03-04,10.00'))
    expect((await screen.findAllByText('Fast')).length).toBeGreaterThan(0)
    release()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(screen.queryByText('Slow')).not.toBeInTheDocument()
  })
})
