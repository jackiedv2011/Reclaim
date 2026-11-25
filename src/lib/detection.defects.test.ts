/**
 * Defects reproduced against real-looking ledgers, one block per defect. Each
 * block pins both sides: what must be reported, and what must stay quiet.
 */
import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/csv'
import { mergeImport } from '@/ledger/store'
import { detectFindings, recurringSeriesOf } from '@/lib/detection'
import { referenceKey, referenceStrength } from '@/lib/sourceIdentity'
import type { APRecord, Finding } from '@/types'

const BASE = 'vendor,invoice_number,payment_date,amount_paid'
const imported = (rows: string[], header = BASE) => mergeImport(null, { mode: 'upload', sourceLabel: 'x.csv', parsed: parseCsv([header, ...rows].join('\n')) }).result
/** Straight from the parser, so same-file same-day rows are all assessed. */
const parsedOnly = (rows: string[], header = BASE) =>
  detectFindings(parseCsv([header, ...rows].join('\n')).records.map((r, i) => ({ ...r, id: `rec_${i}` })))
const run = (rows: string[], header = BASE) => imported(rows, header).findings
const total = (findings: Finding[]) => Math.round(findings.reduce((s, f) => s + f.dollarImpact, 0) * 100) / 100
const duplicates = (findings: Finding[]) => findings.filter((f) => f.type === 'exact_duplicate' || f.type === 'near_duplicate')
const months = (n: number, row: (date: string, i: number) => string, day = '01') =>
  Array.from({ length: n }, (_, i) => row(`2025-${String(i + 1).padStart(2, '0')}-${day}`, i))

let seq = 0
const rec = (o: Partial<APRecord> & { vendor: string; amountPaid: number }): APRecord => ({
  id: `d${seq}`, importBatchId: 'b', invoiceNumber: null, invoiceDate: null, paymentDate: new Date(2025, 0, 1), invoiceAmount: null,
  terms: null, bankAccountLast4: null, category: null, rowIndex: seq++, ...o,
})
const on = (m: number, day: number) => new Date(2025, m - 1, day)

describe('1 — spacing and case in an invoice number', () => {
  it.each([['INV-100', 'INV-100 '], ['INV-100', ' inv-100'], ['INV 100', 'INV  100'], ['PO A77', 'po  a77']])('"%s" and "%s" are one invoice', (a, b) => {
    const findings = run([`Acme,${a},2025-03-04,900`, `Acme,${b},2025-03-20,900`])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ type: 'exact_duplicate', dollarImpact: 900 })
  })
  it('a refund keyed with different spacing still nets', () => {
    expect(run(['Acme,INV-100,2025-03-04,900,', 'Acme,INV-100 ,2025-03-20,900,', 'Acme,inv-100,2025-03-25,-300,Refund'], `${BASE},transaction_type`)[0].dollarImpact).toBe(600)
  })
})

describe('2 — references that do not identify an invoice', () => {
  it.each(['Rent', 'AUTOPAY', 'Auto Pay', 'Statement', 'Monthly', 'subscription', 'Retainer', 'ACH Payment', 'Online', 'Monthly Rent', 'March'])('twelve months of "%s" is a recurring charge', (reference) => {
    const result = imported(months(12, (date) => `Elm Properties,${reference},${date},3200`))
    expect(result.findings).toEqual([])
    expect(recurringSeriesOf(result)).toHaveLength(1)
  })
  it('an account number repeated every month is not one invoice', () => {
    expect(run(months(12, (date) => `City Power,8495-11-2220,${date},189.5`))).toEqual([])
    expect(run(months(12, (date, i) => `City Power,8495-11-2220,${date},${(189.5 + i * 3.17).toFixed(2)}`))).toEqual([])
    const withInvoiceAmount = months(12, (date) => `City Power,8495-11-2220,${date},189.5,189.5`)
    expect(run(withInvoiceAmount, `${BASE},invoice_amount`)).toEqual([])
  })
  it('one month of the series paid at another price does not turn the whole series into one invoice', () => {
    const rows = months(12, (date, i) => `Elm,LEASE-44,${date},${i === 5 ? 3300 : 3200},3200`)
    const findings = run(rows, `${BASE},invoice_amount`)
    expect(findings.map((f) => [f.type, f.dollarImpact])).toEqual([['overpayment', 100]])
  })
  it('a PO number on progress payments is not one invoice', () => {
    expect(run(['Keller Build,PO-7781,2025-01-10,12000', 'Keller Build,PO-7781,2025-02-20,18500', 'Keller Build,PO-7781,2025-04-02,9400'])).toEqual([])
    expect(run(['Keller Build,PO-7781,2025-01-10,10000', 'Keller Build,PO-7781,2025-02-28,10000', 'Keller Build,PO-7781,2025-04-30,10000'])).toEqual([])
  })
  it.each(['Rent', '8495-11-2220', 'LEASE 4'])('a double charge in one month of a "%s" series is still found, once', (reference) => {
    for (const extra of ['2025-06-03', '2025-06-17']) {
      const findings = run([...months(12, (date) => `Elm Properties,${reference},${date},3200`), `Elm Properties,${reference},${extra},3200`])
      expect(findings, extra).toHaveLength(1)
      expect(findings[0]).toMatchObject({ type: 'near_duplicate', dollarImpact: 3200 })
    }
    const sameDay = parsedOnly([...months(12, (date) => `Elm Properties,${reference},${date},3200`), `Elm Properties,${reference},2025-06-01,3200`]).findings
    expect(sameDay.map((f) => f.dollarImpact)).toEqual([3200])
  })
  it('a double charge in a series whose amount changes every month is still found', () => {
    const rows = months(12, (date, i) => `City Power,8495-11-2220,${date},${(189.5 + i * 3.17).toFixed(2)}`)
    const findings = run([...rows, 'City Power,8495-11-2220,2025-06-04,205.35'])
    expect(findings.map((f) => [f.type, f.dollarImpact])).toEqual([['near_duplicate', 205.35]])
  })
  it('a true triple payment of one invoice in a short burst is still found in full', () => {
    expect(total(run(['Acme,INV-9001,2025-03-01,700', 'Acme,INV-9001,2025-03-08,700', 'Acme,INV-9001,2025-03-21,700']))).toBe(1400)
  })
  it('four weekly charges under one account number are a label, not a burst', () => {
    expect(run([3, 10, 17, 24].map((day) => `Linen Co,ACCT-77120,2025-03-${String(day).padStart(2, '0')},85`))).toEqual([])
  })
  it('one invoice, one invoice date, paid three times over two months is still found', () => {
    const header = `${BASE},invoice_date,invoice_amount`
    expect(total(run(['Acme,INV-9001,2025-03-01,700,2025-02-20,700', 'Acme,INV-9001,2025-04-08,700,2025-02-20,700', 'Acme,INV-9001,2025-05-21,700,2025-02-20,700'], header))).toBe(1400)
  })
  it('equal instalments that overshoot an agreed invoice still claim the overshoot', () => {
    const header = `${BASE},invoice_amount`
    expect(total(run(['Acme,J-101,2025-01-01,1000,3000', 'Acme,J-101,2025-02-01,1000,3000', 'Acme,J-101,2025-03-01,1000,3000', 'Acme,J-101,2025-04-01,1000,3000'], header))).toBe(1000)
  })
  it('reads words as placeholders only when the whole reference is words', () => {
    for (const word of ['rent', 'Auto-Pay', 'ONLINE PMT', 'ach transfer', 'Payroll', 'Deposit', 'January', 'Sept']) expect(referenceStrength(word), word).toBe('none')
    for (const real of ['RENT-2025-03', 'Rent 0425', 'March 2025', 'ACH-88213', 'DEP4471', 'Smith remodel']) expect(referenceStrength(real), real).toBe('strong')
  })
})

describe('3 — reversals', () => {
  const header = `${BASE},transaction_type`
  const inv = (rows: string[], h = header) => parsedOnly(rows, h).findings
  it.each(['', 'Void', 'Reversal', 'Credit Memo', 'Vendor Credit', 'Refund', 'Journal', 'Payment'])('nothing is claimed when a "%s" row gives the second payment back', (type) => {
    expect(inv(['Acme,INV-1001,2025-03-04,900,', 'Acme,INV-1001,2025-03-20,900,', `Acme,INV-1001,2025-03-25,-900,${type}`])).toEqual([])
  })
  it.each(['', 'Void'])('an honest void-and-reissue ("%s") is not a duplicate', (type) => {
    expect(inv(['Acme,INV-1001,2025-03-04,900,', `Acme,INV-1001,2025-03-06,-900,${type}`, 'Acme,INV-1001,2025-03-20,900,'])).toEqual([])
    // the reissue under its own reference
    expect(inv(['Acme,CHK-4410,2025-03-04,900,', `Acme,CHK-4410,2025-03-06,-900,${type}`, 'Acme,CHK-4477,2025-03-10,900,'])).toEqual([])
  })
  it('a wrong amount voided and paid again correctly is not a repeated invoice', () => {
    expect(inv(['Acme,INV-1001,2025-03-04,990,', 'Acme,INV-1001,2025-03-06,-990,Void', 'Acme,INV-1001,2025-03-07,900,'])).toEqual([])
  })
  it('an overpayment given back is not claimed, whatever the row is called', () => {
    const h = `${BASE},invoice_amount,transaction_type`
    for (const type of ['', 'Credit Memo', 'Refund']) {
      expect(inv(['Acme,INV-1001,2025-03-04,990,900,', `Acme,INV-1001,2025-03-20,-90,,${type}`], h), type).toEqual([])
      expect(inv(['Acme,,2025-03-04,990,900,', `Acme,,2025-03-20,-90,,${type}`], h), `no reference ${type}`).toEqual([])
    }
  })
  it('a third payment stays claimed when only one of two extras was given back', () => {
    const findings = inv(['Acme,INV-1001,2025-03-04,900,', 'Acme,INV-1001,2025-03-10,900,', 'Acme,INV-1001,2025-03-20,900,', 'Acme,INV-1001,2025-03-25,-900,'])
    expect(total(findings)).toBe(900)
  })
  it('one negative covering both extras, or split in two, cancels both', () => {
    const paid = ['Acme,INV-1001,2025-03-04,900,', 'Acme,INV-1001,2025-03-10,900,', 'Acme,INV-1001,2025-03-20,900,']
    expect(inv([...paid, 'Acme,INV-1001,2025-03-25,-1800,'])).toEqual([])
    expect(inv([...paid, 'Acme,INV-1001,2025-03-25,-900,', 'Acme,INV-1001,2025-03-26,-900,'])).toEqual([])
  })
  it('an untyped negative that matches nothing is named, never netted', () => {
    const [finding] = inv(['Acme,INV-1001,2025-03-04,900,', 'Acme,INV-1001,2025-03-20,900,', 'Acme,INV-1001,2025-03-25,-200,'])
    expect(finding.dollarImpact).toBe(900)
    expect(finding.explanation).toContain('$200.00')
  })
  it('a typed partial credit nets, once', () => {
    expect(total(inv(['Acme,INV-1001,2025-03-04,900,', 'Acme,INV-1001,2025-03-20,900,', 'Acme,INV-1001,2025-03-25,-200,Credit Memo']))).toBe(700)
  })
  it('Rule 2 pairs net too: by reference, and without any reference inside a short window', () => {
    expect(inv(['Acme,INV-1001,2025-03-04,900,', 'Acme,1001,2025-03-20,900,', 'Acme,INV-1001,2025-03-25,-900,Refund'])).toEqual([])
    expect(total(inv(['Acme,INV-1001,2025-03-04,900,', 'Acme,1001,2025-03-20,900,', 'Acme,INV-1001,2025-03-25,-300,Refund']))).toBe(600)
    expect(inv(['Cafe Supply,,2025-03-04,61.2,', 'Cafe Supply,,2025-03-05,61.2,', 'Cafe Supply,,2025-03-07,-61.2,'])).toEqual([])
    // months later it is some other event
    expect(inv(['Cafe Supply,,2025-03-04,61.2,', 'Cafe Supply,,2025-03-05,61.2,', 'Cafe Supply,,2025-09-07,-61.2,'])).toHaveLength(1)
  })
  it('a negative on another invoice does not cancel this one', () => {
    expect(total(inv(['Acme,INV-1001,2025-03-04,900,', 'Acme,INV-1001,2025-03-20,900,', 'Acme,INV-2002,2025-03-25,-900,Refund']))).toBe(900)
  })
  it.each(['Void', 'Voided', 'Vendor Credit', 'Bill', 'Credit Memo', 'Journal', 'Journal Entry', 'Refund'])('a positive "%s" row is not a payment', (type) => {
    expect(inv(['Acme,INV-1001,2025-03-04,900,Bill Payment', `Acme,INV-1001,2025-03-20,900,${type}`])).toEqual([])
  })
  it.each(['Bill Payment', 'Bill Pmt -Check', 'Check', 'Expense', 'Credit Card Expense', 'ACH', ''])('a positive "%s" row is a payment', (type) => {
    expect(total(inv([`Acme,INV-1001,2025-03-04,900,${type}`, `Acme,INV-1001,2025-03-20,900,${type}`]))).toBe(900)
  })
})

describe('4 — one vendor entered under two names', () => {
  it('legal-name spellings of one vendor are one vendor', () => {
    const findings = run(['"Acme, Inc.",INV-88231,2025-03-04,900', 'Acme Incorporated,INV-88231,2025-03-20,900'])
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ type: 'exact_duplicate', dollarImpact: 900 })
  })
  it('near-identical names, same reference and amount: a duplicate at one payment, for review', () => {
    for (const other of ['Brightlne Electric', 'Bright Line Electric']) {
      const findings = run(['Brightline Electric,BE-20931,2025-03-04,1450', `${other},BE 20931,2025-03-20,1450`])
      expect(findings, other).toHaveLength(1)
      expect(findings[0]).toMatchObject({ type: 'near_duplicate', ruleId: 'cross_vendor_duplicate_v1', class: 'review', dollarImpact: 1450 })
      expect(findings[0].relatedRecords).toHaveLength(2)
    }
  })
  it('one name under two supplier IDs is the same duplicate', () => {
    const findings = run(['Acme,V100,INV-88231,2025-03-04,900', 'Acme,V207,INV-88231,2025-03-20,900'], 'vendor,supplier_id,invoice_number,payment_date,amount_paid')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ ruleId: 'cross_vendor_duplicate_v1', dollarImpact: 900 })
  })
  it('different numbered locations and merely similar names stay a shared-number question at most', () => {
    for (const [a, b] of [['Shell Oil Station 1042', 'Shell Oil Station 1043'], ['Acme Steel', 'Acme Stone'], ['Northwest Bakery', 'Northwest Pastry']]) {
      const findings = run([`${a},BE-20931,2025-03-04,1450`, `${b},BE-20931,2025-03-20,1450`])
      expect(findings.map((f) => f.type), `${a} / ${b}`).toEqual(['shared_invoice_number'])
    }
  })
  it('different amounts under near-identical names are not called a duplicate', () => {
    expect(duplicates(run(['Brightline Electric,BE-20931,2025-03-04,1450', 'Brightlne Electric,BE-20931,2025-03-20,1200']))).toEqual([])
  })
  it('never claims a payment that another duplicate rule already has', () => {
    const findings = run(['Brightlne Electric,BE-20931,2025-03-04,1450', 'Brightline Electric,BE-20888,2025-03-10,1450', 'Brightline Electric,BE-20931,2025-03-20,1450'])
    expect(findings.map((f) => f.ruleId)).toEqual(['cross_vendor_duplicate_v1'])
    expect(total(findings)).toBe(1450)
  })
  it('a payment reversed under one of the names is not claimed', () => {
    expect(run(['Brightline Electric,BE-20931,2025-03-04,1450', 'Brightlne Electric,BE-20931,2025-03-20,1450', 'Brightlne Electric,BE-20931,2025-03-21,-1450'])).toEqual([])
  })
})

describe('5 — a blank supplier ID', () => {
  const header = 'vendor,supplier_id,invoice_number,payment_date,amount_paid'
  it('is the same vendor as the one ID that name carries', () => {
    const findings = run(['Acme,V100,INV-88231,2025-03-04,900', 'Acme,,INV-88231,2025-03-20,900'], header)
    expect(findings.map((f) => [f.type, f.dollarImpact])).toEqual([['exact_duplicate', 900]])
  })
  it('does not join two IDs that share a name', () => {
    const findings = run(['Acme,V100,INV-1,2025-03-04,900', 'Acme,V200,INV-7,2025-03-06,900', 'Acme,,INV-9,2025-06-20,400'], header)
    expect(findings).toEqual([])
  })
})

describe('6 — references equal after normalization', () => {
  it.each([['INV-100', 'INV 100'], ['INV-001', '001'], ['INV12345', 'INV-12345'], ['INV001', 'Inv. 001'], ['Inv. 1001', '1001'], ['Invoice No. 1001', '1001'], ['0004417', '4417'], ['PO-00417', 'PO417']])('%s and %s at the same amount are found 60 days apart', (a, b) => {
    const findings = run([`Acme,${a},2025-03-04,900`, `Acme,${b},2025-05-03,900`])
    expect(findings).toHaveLength(1)
    expect(findings[0].dollarImpact).toBe(900)
  })
  it('different numbers 60 days apart are not', () => {
    for (const [a, b] of [['INV-100', 'INV-1000'], ['INV-1001', 'INV-1010'], ['A-12345', 'B-12345']]) expect(run([`Acme,${a},2025-03-04,900`, `Acme,${b},2025-05-03,900`]), `${a}/${b}`).toEqual([])
  })
  it('normalizes the spellings to one value without changing how strong a reference is', () => {
    const values = ['INV001', 'INV-001', 'inv. 001', 'Invoice #001', '001', '1'].map((raw) => referenceKey(raw))
    expect(new Set(values)).toEqual(new Set(['1']))
    expect(referenceStrength('001')).toBe('strong')
    expect(referenceStrength('INV001')).toBe('strong')
    expect(referenceStrength('0000')).toBe('none')
    expect(referenceKey('2025-03')).toBe('202503')
  })
})

describe('7 — a row grouped with another amount still reaches Rule 2', () => {
  it('finds the later copy of the second amount', () => {
    const findings = run(['Acme,10231,2025-03-04,500', 'Acme,10231,2025-03-12,700', 'Acme,10290,2025-03-22,700'])
    const near = findings.filter((f) => f.type === 'near_duplicate')
    expect(near).toHaveLength(1)
    expect(near[0].relatedRecords.map((r) => r.invoiceNumber)).toEqual(['10231', '10290'])
    expect(near[0].dollarImpact).toBe(700)
  })
  it('never claims one payment twice', () => {
    const findings = run(['Acme,10231,2025-03-04,500', 'Acme,10231,2025-03-12,500', 'Acme,10290,2025-03-22,700'])
    expect(total(findings)).toBe(500)
  })
})

describe('8 — an invoice amount of zero or less is unknown', () => {
  it.each(['0', '0.00', '-900'])('%s', (amount) => {
    expect(run([`Acme,INV-1001,2025-03-04,900,${amount}`], `${BASE},invoice_amount`)).toEqual([])
    expect(total(run([`Acme,INV-1001,2025-03-04,900,${amount}`, `Acme,INV-1001,2025-03-14,900,${amount}`], `${BASE},invoice_amount`))).toBe(900)
  })
  it('never produces a discount on it either', () => {
    expect(run(['Acme,INV-1001,2025-03-04,900,0,2/10 net 30,2025-03-01'], `${BASE},invoice_amount,terms,invoice_date`)).toEqual([])
  })
})

describe('9 — currencies and companies are never mixed', () => {
  const header = `${BASE},currency,company,transaction_type`
  it('the same invoice number in two currencies or two companies is not a duplicate', () => {
    expect(run(['Acme,INV-1001,2025-03-04,900,USD,,', 'Acme,INV-1001,2025-03-20,900,EUR,,'], header)).toEqual([])
    expect(run(['Acme,INV-1001,2025-03-04,900,USD,North LLC,', 'Acme,INV-1001,2025-03-20,900,USD,South LLC,'], header)).toEqual([])
    expect(run(['Acme,INV-1001,2025-03-04,900,USD,,', 'Acme,INV-1001,2025-03-20,700,EUR,,'], header)).toEqual([])
  })
  it('duplicates inside each currency are claimed separately', () => {
    const findings = run(['Acme,INV-1001,2025-03-04,900,USD,,', 'Acme,INV-1001,2025-03-20,900,USD,,', 'Acme,INV-1001,2025-03-05,700,EUR,,', 'Acme,INV-1001,2025-03-21,700,EUR,,'], header)
    expect(findings.map((f) => [f.currency, f.dollarImpact])).toEqual([['USD', 900], ['EUR', 700]])
  })
  it('a refund in another currency or company does not net', () => {
    expect(total(run(['Acme,INV-1001,2025-03-04,900,USD,,', 'Acme,INV-1001,2025-03-20,900,USD,,', 'Acme,INV-1001,2025-03-25,-900,EUR,,Refund'], header))).toBe(900)
    expect(total(run(['Acme,INV-1001,2025-03-04,900,USD,A,', 'Acme,INV-1001,2025-03-20,900,USD,A,', 'Acme,INV-1001,2025-03-25,-900,USD,B,Refund'], header))).toBe(900)
  })
  it('a blank currency still compares with the one currency its vendor uses', () => {
    expect(total(run(['Acme,INV-1001,2025-03-04,900,USD,,', 'Acme,INV-1001,2025-03-20,900,,,'], header))).toBe(900)
  })
  it('shared numbers and outliers are measured inside one currency', () => {
    expect(run(['Acme Steel,NW-2025-9001,2025-03-04,450,USD,,', 'Contoso,NW-2025-9001,2025-03-20,275,EUR,,'], header)).toEqual([])
    const rows = [100, 101, 102, 103, 104].map((amount, i) => `Yen Co,Y-20${i},2025-0${i + 1}-03,${amount},USD,,`)
    expect(run([...rows, 'Yen Co,Y-299,2025-07-03,15000,JPY,,'], header)).toEqual([])
  })
  it('the engine totals never add two currencies together', () => {
    const result = imported(['Acme,INV-1001,2025-03-04,900,USD,,', 'Acme,INV-1001,2025-03-20,900,USD,,', 'Acme,INV-1001,2025-03-05,700,EUR,,', 'Acme,INV-1001,2025-03-21,700,EUR,,'], header)
    expect(result.reviewTotal).toBe(900)
  })
  it('never prints a dollar sign for another currency', () => {
    const h = `${BASE},currency,invoice_amount,terms,invoice_date,bank_account_last4`
    const rows = [
      'Dup,INV-1001,2025-03-04,900,EUR,,,,', 'Dup,INV-1001,2025-03-20,900,EUR,,,,',
      'Near,INV-2001,2025-03-04,910,EUR,,,,', 'Near,INV-2777,2025-03-20,910,EUR,,,,',
      'Over,INV-3001,2025-03-04,990,EUR,900,,,',
      'Disc,INV-4001,2025-03-04,900,EUR,900,2/10 net 30,2025-03-01,', 'Late,INV-4002,2025-03-29,900,EUR,900,2/10 net 30,2025-03-01,',
      'Bank,INV-5001,2025-03-04,900,EUR,,,,1111', 'Bank,INV-5002,2025-04-29,901,EUR,,,,2222',
      ...[100, 101, 102, 103, 5000].map((a, i) => `Out,INV-600${i},2025-0${i + 1}-03,${a},EUR,,,,`),
      'Share A,NW-2025-9001,2025-03-04,450,EUR,,,,', 'Other B,NW-2025-9001,2025-03-20,275,EUR,,,,',
    ]
    const findings = run(rows, h)
    expect(new Set(findings.map((f) => f.type)).size).toBe(8)
    for (const f of findings) {
      expect(f.explanation, f.type).not.toContain('$')
      expect(f.explanation, f.type).toContain('€')
    }
    expect(run(['Dup,INV-1001,2025-03-04,900,ZZZZ', 'Dup,INV-1001,2025-03-20,900,ZZZZ'], `${BASE},currency`)[0].explanation).toContain('ZZZZ 900.00')
  })
})

describe('10 — split bill lines', () => {
  it('same-day lines with different amounts are one payment of the bill', () => {
    expect(run(['Acme,INV-9001,2025-03-04,500', 'Acme,INV-9001,2025-03-04,120', 'Acme,INV-9001,2025-03-04,41.20'])).toEqual([])
  })
  it('a line paid again later is still found', () => {
    expect(total(run(['Acme,INV-9001,2025-03-04,500', 'Acme,INV-9001,2025-03-04,120', 'Acme,INV-9001,2025-03-18,500']))).toBe(500)
    expect(total(run(['Acme,INV-9001,2025-03-04,500', 'Acme,INV-9001,2025-03-04,120', 'Acme,INV-9001,2025-03-18,300']))).toBe(300)
  })
  it('lines that together exceed an agreed invoice amount are still an overshoot', () => {
    expect(total(run(['Acme,INV-9001,2025-03-04,500,600', 'Acme,INV-9001,2025-03-04,120,600'], `${BASE},invoice_amount`))).toBe(20)
  })
})

describe('11 — one busy vendor', () => {
  it('assesses 20,000 payments to one vendor quickly', () => {
    const records = Array.from({ length: 20000 }, (_, i) => rec({ vendor: 'Busy', invoiceNumber: `B-${10000 + i}`, amountPaid: 10 + (i % 400), paymentDate: new Date(2023, 0, 1 + Math.floor(i / 20)) }))
    const started = performance.now()
    detectFindings(records)
    expect(performance.now() - started).toBeLessThan(3000)
  })
  it('and 20,000 identical unreferenced ones', () => {
    const records = Array.from({ length: 20000 }, (_, i) => rec({ vendor: 'Busy', amountPaid: 40, paymentDate: new Date(2023, 0, 1 + Math.floor(i / 20)) }))
    const started = performance.now()
    expect(detectFindings(records).findings).toEqual([])
    expect(performance.now() - started).toBeLessThan(3000)
  })
})

describe('13 — end-of-month terms', () => {
  const header = `${BASE},invoice_amount,terms,invoice_date`
  it('reports only what holds under both readings of EOM', () => {
    const at = (date: string) => run([`Acme,INV-1001,${date},900,900,"2/10, n/30 EOM",2025-03-12`], header).map((f) => f.type)
    expect(at('2025-03-20')).toEqual(['unclaimed_discount'])
    expect(at('2025-04-05')).toEqual([])
    expect(at('2025-04-15')).toEqual(['missed_discount'])
  })
})

describe('saved ledgers', () => {
  it('a ledger saved with the old normalized vendor identity groups with newly imported rows', () => {
    const saved = rec({ vendor: 'Acme, Inc.', canonicalVendorId: 'vendor_old_hash', invoiceNumber: 'INV-88231', amountPaid: 900, paymentDate: on(3, 4) })
    const fresh = rec({ vendor: 'Acme, Inc.', canonicalVendorId: 'vendor_new_hash', invoiceNumber: 'INV-88231', amountPaid: 900, paymentDate: on(3, 20) })
    expect(detectFindings([saved, fresh]).findings.map((f) => f.type)).toEqual(['exact_duplicate'])
  })
  it('re-importing the same rows under a new file adds nothing', () => {
    const rows = ['"Acme, Inc.",INV-88231,2025-03-04,900', 'The Home Depot,HD-1,2025-03-05,20']
    const first = mergeImport(null, { mode: 'upload', sourceLabel: 'a.csv', parsed: parseCsv([BASE, ...rows].join('\n')) })
    const again = mergeImport(first, { mode: 'upload', sourceLabel: 'b.csv', parsed: parseCsv([BASE, ...rows, 'New Co,N-1,2025-04-01,10'].join('\n')) })
    expect(again.records).toHaveLength(3)
  })
})
