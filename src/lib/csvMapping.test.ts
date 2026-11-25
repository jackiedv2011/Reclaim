/**
 * Reading a raw export: finding the headings, matching the columns, the date
 * order and the sign. The contract: nothing that could put a wrong date or
 * amount in the ledger is decided without a person, and every record still
 * says what the original file said.
 */
import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/csv'
import { canMatchColumns, columnName, dateOrderEvidence, invoiceAmountsAllNegative, negativePayments, readCsvTable, readingNotes, readsWithoutAsking, suggestColumns, uniqueKeys } from '@/lib/csvMapping'
import { recordIdentity, sourceCell } from '@/lib/sourceIdentity'
import { detectFindings } from '@/lib/detection'
import { mergeImport, deserializeEnvironment, serializeEnvironment } from '@/ledger/store'

const csv = (...lines: string[]) => lines.join('\n')
const suggest = (...lines: string[]) => suggestColumns(readCsvTable(csv(...lines)))
/** Header shapes modelled on common exports; approximations, not customer files. */
const XERO = csv('Date,Contact,Reference,Amount', '04 Mar 2026,Acme Ltd,INV-1,1200.00', '05 Mar 2026,Beta Ltd,INV-2,80.50')
const QBO = csv(
  'Harbour Cafe LLC,,,,,',
  'Transaction List by Vendor,,,,,',
  '"January 1 - March 31, 2026",,,,,',
  '',
  ',Date,Transaction Type,Num,Name,Amount',
  ',02/25/2026,Bill Payment,1042,Acme Ltd,"-1,200.00"',
  ',03/04/2026,Bill Payment,1043,Beta Ltd,-80.50',
)

describe('finding the heading row', () => {
  it('skips title lines and blank lines above the headings', () => {
    const table = readCsvTable(QBO)
    expect(table.headerIndex).toBe(4)
    expect(table.rows[4]).toEqual(['', 'Date', 'Transaction Type', 'Num', 'Name', 'Amount'])
  })

  it('uses the first row when it already reads as headings', () => {
    expect(readCsvTable(XERO).headerIndex).toBe(0)
    expect(readCsvTable('vendor,payment_date,amount_paid\nVendor,Payment Date,Amount Paid').headerIndex).toBe(0)
  })

  it('never takes a row holding a date or a number for headings', () => {
    expect(readCsvTable(csv('Report,Vendor,2026-01-01', 'Vendor,Date,Amount', 'Acme,2026-01-02,10')).headerIndex).toBe(1)
  })

  it('falls back to the first table-wide line when no heading is known', () => {
    expect(readCsvTable(csv('Informe', 'Proveedor,Fecha,Importe', 'Acme,2026-01-02,10')).headerIndex).toBe(1)
  })

  it('imports a file with title lines and known headings, with the row numbers a spreadsheet shows', () => {
    const parsed = parseCsv(csv('Acme Ltd', 'Payments 2026', '', 'Vendor,Payment Date,Amount Paid', 'Acme,2026-01-02,10', '', 'Beta,nope,20'))
    expect(parsed.records[0].source?.rowNumber).toBe(5)
    expect(parsed.records[0].rowIndex).toBe(3)
    expect(parsed.rowResults).toEqual([expect.objectContaining({ rowNumber: 7, status: 'rejected', reason: '“nope” isn’t a date' })])
    expect(parsed.reading).toEqual({ headerRow: 4, titleLines: 2 })
  })

  it('reads a semicolon file with a title line', () => {
    const table = readCsvTable(csv('Payments, all suppliers', 'Vendor;Payment Date;Amount Paid', 'Acme;2026-01-02;10', 'Beta;2026-01-03;20'))
    expect(parseCsv(table).records.map((r) => r.vendor)).toEqual(['Acme', 'Beta'])
  })
})

describe('suggesting columns', () => {
  it('suggests the only column each required field could be', () => {
    const { columns, suggested, recognized, ambiguous } = suggestColumns(readCsvTable(XERO))
    expect(columns).toEqual({ payment_date: 0, vendor: 1, invoice_number: 2, amount_paid: 3 })
    expect(suggested.sort()).toEqual(['amount_paid', 'invoice_number', 'payment_date', 'vendor'])
    expect(recognized).toEqual([])
    expect(ambiguous).toEqual({})
  })

  it('covers the general headings accounting exports use', () => {
    expect(suggest('Process Date,Name,Debit', '2026-03-04,Acme,10.00').columns).toEqual({ payment_date: 0, vendor: 1, amount_paid: 2 })
    expect(suggest('*ContactName,Date,Total', 'Acme,2026-03-04,10.00').columns).toEqual({ vendor: 0, payment_date: 1, amount_paid: 2 })
  })

  it('leaves the payment date empty when two columns hold dates', () => {
    const { columns, ambiguous } = suggest('Contact,Date,Due Date,Amount', 'Acme,2026-03-04,2026-04-04,10.00')
    expect(columns.payment_date).toBeUndefined()
    expect(ambiguous.payment_date).toEqual([1, 2])
    expect(columns.amount_paid).toBe(3)
  })

  it('leaves the amount paid empty when two columns hold amounts', () => {
    const { columns, ambiguous } = suggest('Contact,Date,Debit,Credit', 'Acme,2026-03-04,10.00,', 'Acme,2026-03-05,,4.00')
    expect(columns.amount_paid).toBeUndefined()
    expect(ambiguous.amount_paid).toEqual([2, 3])
  })

  it('ignores an empty amount column and numbers that only identify something', () => {
    expect(suggest('Contact,Date,Check No,Debit,Credit', 'Acme,2026-03-04,1042,10.00,').columns.amount_paid).toBe(3)
  })

  it('does not choose between two known headings for one amount when their cells differ', () => {
    const lines = ['Vendor,Payment Date,Amount Paid,Payment Amount', 'Acme,2026-03-04,10,10', 'Beta,2026-03-04,20,25']
    expect(suggest(...lines).ambiguous).toEqual({ amount_paid: [2, 3] })
    expect(readsWithoutAsking(readCsvTable(csv(...lines)))).toEqual({ ask: true })
    expect(readsWithoutAsking(readCsvTable(csv(lines[0], lines[1])))).toEqual({ ask: false, dateOrder: 'month-first' })
  })

  it('does not take a check number for an invoice number', () => {
    expect(suggest('Name,Date,Num,Amount', 'Acme,2026-03-04,1042,10.00').columns.invoice_number).toBeUndefined()
  })

  it('names a column with no heading by its spreadsheet letter', () => {
    expect(columnName(['', 'Date'], 0)).toBe('Column A')
    expect(columnName([], 27)).toBe('Column AB')
  })

  it('numbers repeated headings the way they were numbered before', () => {
    expect(uniqueKeys(['a', 'a', 'a_1', 'a'])).toEqual(['a', 'a_2', 'a_1', 'a_3'])
  })
})

describe('which files need no extra step', () => {
  it('known headings with clear dates and positive amounts import as they are', () => {
    for (const line of ['Acme,2026-03-04,10', 'Acme,03/25/2026,10', 'Acme,25/03/2026,10', 'Acme,4 Mar 2026,10', 'Acme,05/05/2026,10', 'Acme,2026-03-04,-5\nAcme,2026-03-04,10']) {
      expect(readsWithoutAsking(readCsvTable(`Vendor,Payment Date,Amount Paid\n${line}`)).ask, line).toBe(false)
    }
  })

  it('an unknown required heading, an unclear date or all-negative amounts are asked about', () => {
    expect(readsWithoutAsking(readCsvTable(XERO)).ask).toBe(true)
    expect(readsWithoutAsking(readCsvTable('Vendor,Payment Date,Amount Paid\nAcme,04/03/2026,10')).ask).toBe(true)
    expect(readsWithoutAsking(readCsvTable('Vendor,Payment Date,Amount Paid\nAcme,2026-03-04,-10')).ask).toBe(true)
  })

  it('there is nothing to match in a file too narrow or too short to hold payments', () => {
    expect(canMatchColumns(readCsvTable(''))).toBe(false)
    expect(canMatchColumns(readCsvTable('a,b\n1,2'))).toBe(false)
    expect(canMatchColumns(readCsvTable('a,b,c\n,,\n'))).toBe(false)
    expect(canMatchColumns(readCsvTable(XERO))).toBe(true)
  })
})

describe('date order', () => {
  const order = (...dates: string[]) => dateOrderEvidence(readCsvTable(csv('vendor,payment_date,amount_paid', ...dates.map((date) => `Acme,${date},10`))), { vendor: 0, payment_date: 1, amount_paid: 2 })

  it('one date that only works one way settles the whole file', () => {
    expect(order('04/03/2026', '25/02/2026')).toMatchObject({ order: 'day-first', question: null })
    expect(order('04/03/2026', '02/25/2026')).toMatchObject({ order: 'month-first', question: null })
  })

  it('an invoice date settles the payment date too', () => {
    const table = readCsvTable('vendor,payment_date,amount_paid,invoice_date\nAcme,04/03/2026,10,25/02/2026')
    expect(dateOrderEvidence(table, { vendor: 0, payment_date: 1, amount_paid: 2, invoice_date: 3 }).order).toBe('day-first')
  })

  it('asks when every date works both ways, and gives one that changes meaning', () => {
    expect(order('05/05/2026', '04/03/2026')).toMatchObject({ order: null, question: 'ambiguous', example: '04/03/2026' })
  })

  it('asks when the dates contradict each other', () => {
    expect(order('25/02/2026', '02/25/2026')).toMatchObject({ order: null, question: 'mixed', monthFirst: 1, dayFirst: 1 })
  })

  it('does not take a two-digit year as proof: 25/02/03 may be a year first', () => {
    expect(order('25/02/03')).toMatchObject({ order: null, question: 'ambiguous' })
  })

  it('has nothing to ask about ISO, month-name or same-both-ways dates', () => {
    expect(order('2026-03-04', '4 Mar 2026', '05/05/2026')).toMatchObject({ order: 'month-first', question: null })
  })

  it('reads the whole file in the chosen order and skips what does not fit, saying so', () => {
    const table = readCsvTable('vendor,payment_date,invoice_date,amount_paid\nAcme,04/03/2026,01/02/2026,10\nBeta,02/25/2026,,20')
    const parsed = parseCsv(table, { dateOrder: 'day-first' })
    expect(parsed.records).toHaveLength(1)
    expect(parsed.records[0].paymentDate).toEqual(new Date(2026, 2, 4))
    expect(parsed.records[0].invoiceDate).toEqual(new Date(2026, 1, 1))
    expect(parsed.records[0].source?.transformations).toMatchObject({ paymentDate: ['parse_date', 'read_day_first'], invoiceDate: ['parse_date', 'read_day_first'] })
    expect(parsed.records[0].source?.raw?.payment_date).toBe('04/03/2026')
    expect(parsed.rowResults?.[0].reason).toBe('“02/25/2026” isn’t a date')
    expect(parsed.reading?.dateOrder).toBe('day-first')
  })
})

describe('negative payments', () => {
  const columns = { vendor: 0, payment_date: 1, amount_paid: 2, invoice_amount: 3 }
  const table = readCsvTable(csv('vendor,payment_date,amount_paid,invoice_amount', 'Acme,2026-03-04,"(1,200.00)",-1000', 'Beta,2026-03-05,-80.5,-80.5', 'Zero,2026-03-05,0,0', 'Total,,-1280.5,'))

  it('are noticed only when every payment is negative', () => {
    expect(negativePayments(table, columns, 'month-first')).toEqual({ count: 2, example: '(1,200.00)' })
    expect(negativePayments(readCsvTable('vendor,payment_date,amount_paid\nAcme,2026-03-04,-5\nAcme,2026-03-05,5'), columns, 'month-first')).toBeNull()
    expect(negativePayments(readCsvTable('vendor,payment_date,amount_paid\nAcme,2026-03-04,0'), columns, 'month-first')).toBeNull()
  })

  it('flip with their invoice amounts, and the record still says what the file said', () => {
    const [acme, beta, zero] = parseCsv(table, { flipSign: true }).records
    expect([acme.amountPaid, acme.invoiceAmount]).toEqual([1200, 1000])
    expect(acme.source?.raw).toMatchObject({ amount_paid: '(1,200.00)', invoice_amount: '-1000' })
    expect(acme.source?.parsed).toMatchObject({ amountPaid: 1200, invoiceAmount: 1000 })
    expect(acme.source?.transformations).toMatchObject({ amountPaid: ['parse_amount', 'flip_sign'], invoiceAmount: ['flip_sign'] })
    expect(beta.source?.transformations.amountPaid).toEqual(['flip_sign'])
    expect(Object.is(zero.amountPaid, 0)).toBe(true)
  })

  it('leave invoice amounts alone when the file writes those as positive', () => {
    const positive = readCsvTable('vendor,payment_date,amount_paid,invoice_amount\nAcme,2026-03-04,-12,10')
    expect(invoiceAmountsAllNegative(positive, columns)).toBe(false)
    expect(parseCsv(positive, { flipSign: true }).records[0]).toMatchObject({ amountPaid: 12, invoiceAmount: 10 })
  })

  it('turn a file that finds nothing into one whose duplicates are found', () => {
    const text = csv('vendor,invoice_number,payment_date,amount_paid', 'Acme,INV-100,2026-03-04,-500', 'Acme,INV-100,2026-03-09,-500')
    expect(detectFindings(parseCsv(text).records).findings).toHaveLength(0)
    expect(detectFindings(parseCsv(text, { flipSign: true }).records).findings.map((f) => f.type)).toContain('exact_duplicate')
  })
})

describe('source provenance of a file matched by hand', () => {
  const text = csv('Acme Ltd', '', 'Contact,Date,Ref,Amount,Amount', ' Beta Ltd ,04 Mar 2026,INV-7,"1,200.00",memo', 'Beta Ltd,05 Mar 2026,INV-8,5,', 'Gone,someday,INV-9,5,')
  const choices = { columns: { vendor: 0, payment_date: 1, invoice_number: 2, amount_paid: 3 }, dateOrder: 'month-first' as const }

  it('keeps every cell untouched under the file’s own headings, and the row it was on', () => {
    const parsed = parseCsv(text, choices)
    const { source } = parsed.records[0]
    expect(source).toMatchObject({
      rowNumber: 4,
      raw: { Contact: ' Beta Ltd ', Date: '04 Mar 2026', Ref: 'INV-7', Amount: '1,200.00', Amount_1: 'memo' },
      columns: { vendor: 'Contact', payment_date: 'Date', invoice_number: 'Ref', amount_paid: 'Amount' },
      parsed: { vendor: 'Beta Ltd', invoiceReference: 'INV-7', amountPaid: 1200 },
      transformations: { amountPaid: ['parse_amount'], paymentDate: ['parse_date', 'read_month_name'] },
    })
    expect(Object.keys(source!.raw!)).toHaveLength(5)
    expect(sourceCell(source, 'vendor')).toBe(' Beta Ltd ')
    expect(sourceCell(source, 'terms')).toBeUndefined()
    expect(parsed.rowResults?.[0]).toMatchObject({ rowNumber: 6, raw: { Contact: 'Gone', Date: 'someday' }, reason: '“someday” isn’t a date' })
    expect(parsed.detectedColumns).toEqual(['vendor', 'payment_date', 'invoice_number', 'amount_paid'])
    expect(parsed.unrecognizedHeaders).toEqual(['Amount_1'])
  })

  it('a column the person passed over is not read as its field, even under a known heading', () => {
    const parsed = parseCsv('Vendor,Contact,Payment Date,Amount Paid\nGroup A,Acme,2026-03-04,10', { columns: { vendor: 1, payment_date: 2, amount_paid: 3 } })
    expect(parsed.records[0].vendor).toBe('Acme')
    expect(sourceCell(parsed.records[0].source, 'vendor')).toBe('Acme')
    expect(parsed.records[0].source?.raw?.Vendor).toBe('Group A')
  })

  it('gives a payment the same identity as the same file with its headings renamed', () => {
    const renamed = parseCsv(csv('vendor,payment_date,invoice_number,amount_paid', ' Beta Ltd ,04 Mar 2026,INV-7,"1,200.00"'))
    expect(recordIdentity(parseCsv(text, choices).records[0])).toBe(recordIdentity(renamed.records[0]))
  })

  it('survives a save, and the audit remembers how the file was read', () => {
    const env = mergeImport(null, { sourceLabel: 'raw.csv', mode: 'upload', parsed: parseCsv(text, choices) })
    const restored = deserializeEnvironment(serializeEnvironment(env))
    expect(restored.records[0].source).toEqual(env.records[0].source)
    expect(restored.imports[0].reading).toEqual({ headerRow: 3, titleLines: 1, columns: { vendor: 'Contact', payment_date: 'Date', invoice_number: 'Ref', amount_paid: 'Amount' } })
    expect(readingNotes(restored.imports[0].reading)).toEqual([
      'Headings found on row 3; 1 line above them skipped.',
      'Columns matched by hand: vendor from “Contact”, payment date from “Date”, invoice number from “Ref”, amount paid from “Amount”.',
    ])
  })

  it('a file with known headings keeps the provenance it always had', () => {
    const parsed = parseCsv('Supplier Name,Payment Date,Amount Paid,Memo\nAcme,2026-03-04,10,hello,extra')
    expect(parsed.reading).toBeUndefined()
    expect(parsed.records[0].source).not.toHaveProperty('columns')
    expect(parsed.records[0].source?.raw).toEqual({ vendor: 'Acme', payment_date: '2026-03-04', amount_paid: '10', Memo: 'hello', __parsed_extra: ['extra'] })
    expect(parsed.records[0].source?.rowNumber).toBe(2)
  })
})
