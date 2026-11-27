import { describe, expect, it } from 'vitest'
import sampleLedger from '../../public/sample-ledger.csv?raw'
import { parseCsv } from '../lib/csv.ts'
import {
  applyMapping,
  diffMappings,
  formatSignature,
  headerKey,
  KNOWN_FORMATS,
  MAX_HEADERS,
  MappingConflictError,
  matchKnownFormat,
  proposeColumnMapping,
  readHeaderAndSample,
  scoreHeader,
  validateMapping,
  type ColumnMapping,
} from './columnMapping.ts'

/** Comparable view of parse output; drops nothing that drives detection. */
function comparable(csv: string) {
  const r = parseCsv(csv)
  return {
    skipped: r.skippedCount,
    detected: [...r.detectedColumns].sort(),
    records: r.records.map((x) => ({
      vendor: x.vendor, invoiceNumber: x.invoiceNumber, invoiceDate: x.invoiceDate?.toISOString() ?? null, paymentDate: x.paymentDate.toISOString(),
      invoiceAmount: x.invoiceAmount, amountPaid: x.amountPaid, terms: x.terms, bank: x.bankAccountLast4, category: x.category, currency: x.currency,
      identityKey: x.identityKey, canonicalVendorId: x.canonicalVendorId,
    })),
  }
}

const confirmedFrom = (headers: string[], assign: Record<string, string | null>): ColumnMapping => ({
  signature: formatSignature(headers),
  formatId: null,
  columns: headers.map((h) => ({ key: headerKey(h), header: h, canonical: assign[h] ?? null })),
  locale: { dateOrder: 'month_first', decimal: 'dot' },
})

describe('signatures', () => {
  it('ignores column order, case and punctuation but not the set of columns', () => {
    expect(formatSignature(['Vendor', 'Amount Paid'])).toBe(formatSignature(['amount_paid', ' VENDOR ']))
    expect(formatSignature(['Vendor', 'Amount Paid'])).not.toBe(formatSignature(['Vendor', 'Amount Paid', 'Terms']))
    expect(formatSignature(['a', 'a'])).not.toBe(formatSignature(['a']))
  })
})

describe('proposeColumnMapping: precedence', () => {
  it('recognises the Reclaim template as a known format with nothing pending', () => {
    const { headers, sampleRows } = readHeaderAndSample(sampleLedger)
    const p = proposeColumnMapping(headers, sampleRows)
    expect(p.status).toBe('known_format')
    expect(p.formatId).toBe('reclaim_template')
    expect(p.pendingFields).toEqual([])
    expect(p.mapping.locale).toEqual({ dateOrder: 'month_first', decimal: 'dot' })
  })

  it('matches every built-in known format by its own header set, in any order', () => {
    for (const f of KNOWN_FORMATS) {
      expect(matchKnownFormat([...f.headers].reverse())?.id).toBe(f.id)
      expect(proposeColumnMapping([...f.headers]).formatId).toBe(f.id)
    }
  })

  it('uses exact aliases before heuristics and auto-applies all-alias headers', () => {
    const p = proposeColumnMapping(['Payee', 'Date Paid', 'Payment Amount', 'Bill No'], [['Acme', '2025-01-02', '10.00', 'B-1']])
    expect(p.status).toBe('known_format')
    expect(p.formatId).toBe('alias_headers')
    expect(p.proposals.map((x) => x.source)).toEqual(['exact_alias', 'exact_alias', 'exact_alias', 'exact_alias'])
    expect(p.mapping.columns.map((c) => c.canonical)).toEqual(['vendor', 'payment_date', 'amount_paid', 'invoice_number'])
  })

  it('proposes heuristics with a confidence and reason but never auto-applies them', () => {
    const p = proposeColumnMapping(['Merchant', 'Doc No', 'Paid On', 'Paid Amt'], [['Acme', 'D-1', '2025-01-02', '10.00']])
    expect(p.status).toBe('pending_confirmation')
    const merchant = p.proposals[0]
    expect(merchant).toMatchObject({ canonical: 'vendor', source: 'heuristic', needsConfirmation: true })
    expect(merchant.confidence).toBeGreaterThanOrEqual(0.6)
    expect(merchant.reason).not.toBe('')
    expect(p.issues.some((i) => i.code === 'heuristic_unconfirmed')).toBe(true)
    expect(p.pendingFields).toEqual(expect.arrayContaining(['vendor', 'invoice_number', 'payment_date', 'amount_paid']))
  })

  it('leaves an ambiguous header unmapped with the alternatives listed', () => {
    const p = proposeColumnMapping(['Vendor', 'Payment Date', 'Amount'], [])
    const amount = p.proposals[2]
    expect(amount.canonical).toBeNull()
    expect(amount.alternatives.map((a) => a.canonical)).toEqual(expect.arrayContaining(['amount_paid', 'invoice_amount']))
    expect(p.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['ambiguous_header', 'missing_required']))
    expect(p.status).toBe('pending_confirmation')
  })

  it('does not score unrelated headers', () => {
    expect(scoreHeader('Memo')).toEqual([])
    expect(scoreHeader('Net Amount').every((s) => s.confidence < 0.6)).toBe(true)
  })
})

describe('proposeColumnMapping: malformed input', () => {
  it('rejects an empty file and a header made only of blanks', () => {
    expect(readHeaderAndSample('')).toEqual({ headers: [], sampleRows: [] })
    expect(proposeColumnMapping([]).status).toBe('conflict')
    expect(proposeColumnMapping(['', ' ', '']).issues[0].code).toBe('no_headers')
  })

  it('handles a header-only file', () => {
    const { headers, sampleRows } = readHeaderAndSample('vendor,payment_date,amount_paid\n')
    expect(sampleRows).toEqual([])
    expect(proposeColumnMapping(headers, sampleRows).status).toBe('known_format')
    expect(parseCsv('vendor,payment_date,amount_paid\n').records).toEqual([])
  })

  it('treats binary garbage as unmapped columns, never as data', () => {
    const garbage = String.fromCharCode(...Array.from({ length: 300 }, (_, i) => (i * 37 + 11) % 256))
    const { headers, sampleRows } = readHeaderAndSample(garbage)
    const p = proposeColumnMapping(headers, sampleRows)
    expect(['conflict', 'pending_confirmation']).toContain(p.status)
    expect(p.missingRequired.length).toBeGreaterThan(0)
    expect(p.mapping.columns.every((c) => c.canonical === null)).toBe(true)
  })

  it('refuses a huge header count without scoring every column', () => {
    const headers = Array.from({ length: MAX_HEADERS + 1 }, (_, i) => `col ${i}`)
    const p = proposeColumnMapping(headers)
    expect(p.status).toBe('conflict')
    expect(p.issues.map((i) => i.code)).toContain('too_many_columns')
    expect(validateMapping(confirmedFrom(headers, {})).map((i) => i.code)).toContain('too_many_columns')
  })
})

describe('proposeColumnMapping: collisions and duplicates', () => {
  it('flags two alias columns feeding the same field as a conflict', () => {
    const p = proposeColumnMapping(['Vendor', 'Supplier', 'Payment Date', 'Amount Paid'])
    expect(p.status).toBe('conflict')
    expect(p.issues.find((i) => i.code === 'canonical_collision')).toMatchObject({ fields: ['vendor'], headers: ['Vendor', 'Supplier'] })
  })

  it('flags a duplicated mapped header name as a conflict', () => {
    const p = proposeColumnMapping(['Vendor', 'Payment Date', 'Amount Paid', 'amount paid'])
    expect(p.status).toBe('conflict')
    expect(p.issues.map((i) => i.code)).toContain('duplicate_header')
  })

  it('ignores repeated blank headers from trailing delimiters', () => {
    const p = proposeColumnMapping(['Vendor', 'Payment Date', 'Amount Paid', '', ''])
    expect(p.status).toBe('known_format')
  })

  it('does not let a heuristic column steal a field a firm column already provides', () => {
    const p = proposeColumnMapping(['Vendor', 'Merchant', 'Payment Date', 'Amount Paid'])
    expect(p.mapping.columns.find((c) => c.key === 'vendor')?.canonical).toBe('vendor')
    expect(p.mapping.columns.find((c) => c.key === 'merchant')?.canonical).not.toBe('vendor')
  })

  it('validateMapping refuses collisions, unknown fields and signature drift', () => {
    const headers = ['Payee', 'Supplier', 'Paid', 'Amt']
    const collision = confirmedFrom(headers, { Payee: 'vendor', Supplier: 'vendor', Paid: 'payment_date', Amt: 'amount_paid' })
    expect(validateMapping(collision).map((i) => i.code)).toContain('canonical_collision')
    const unknown = confirmedFrom(headers, { Payee: 'vendor', Paid: 'payment_date', Amt: 'amount_paid', Supplier: 'bogus' })
    expect(validateMapping(unknown).map((i) => i.code)).toContain('unknown_canonical')
    const drift = { ...confirmedFrom(headers, { Payee: 'vendor', Paid: 'payment_date', Amt: 'amount_paid' }), signature: formatSignature(['x']) }
    expect(validateMapping(drift).map((i) => i.code)).toContain('signature_mismatch')
  })
})

describe('locale detection', () => {
  const headers = ['Merchant', 'Paid On', 'Paid Amt']
  it('asks for confirmation when every sampled date reads both ways', () => {
    const p = proposeColumnMapping(headers, [['A', '03/04/2025', '10.00'], ['B', '05/06/2025', '11.00']])
    const issue = p.issues.find((i) => i.code === 'date_order_ambiguous')
    expect(issue?.severity).toBe('confirm')
    expect(p.mapping.locale.dateOrder).toBe('unknown')
  })

  it('reads month-first when one sample proves it', () => {
    const p = proposeColumnMapping(headers, [['A', '03/04/2025', '10.00'], ['B', '05/26/2025', '11.00']])
    expect(p.mapping.locale.dateOrder).toBe('month_first')
    expect(p.issues.some((i) => i.code.startsWith('date_'))).toBe(false)
  })

  it('refuses day-first dates, mixed date orders and comma decimals as conflicts', () => {
    expect(proposeColumnMapping(headers, [['A', '26/04/2025', '10.00']]).issues.map((i) => i.code)).toContain('date_day_first')
    expect(proposeColumnMapping(headers, [['A', '26/04/2025', '10.00'], ['B', '04/26/2025', '1.00']]).issues.map((i) => i.code)).toContain('date_order_inconsistent')
    const comma = proposeColumnMapping(['Vendor', 'Payment Date', 'Amount Paid'], [['A', '2025-01-02', '1.234,56']])
    expect(comma.status).toBe('conflict')
    expect(comma.issues.map((i) => i.code)).toContain('decimal_comma')
  })

  it('defaults alias headers to US dates when samples are ambiguous', () => {
    const p = proposeColumnMapping(['Vendor', 'Payment Date', 'Amount Paid'], [['A', '03/04/2025', '10.00']])
    expect(p.status).toBe('known_format')
    expect(p.mapping.locale.dateOrder).toBe('month_first')
  })
})

describe('applyMapping', () => {
  it('returns legacy standard files byte-for-byte, giving identical parseCsv records', () => {
    const { headers, sampleRows } = readHeaderAndSample(sampleLedger)
    const p = proposeColumnMapping(headers, sampleRows)
    const applied = applyMapping(sampleLedger, p.mapping)
    expect(applied).toBe(sampleLedger)
    expect(parseCsv(applied)).toEqual(parseCsv(sampleLedger))
  })

  it('renamed headers give the same records as the canonical file (BOM, CRLF, quoting kept)', () => {
    const body = sampleLedger.split(/\r?\n/).slice(1).join('\r\n')
    const renamedHeaders = ['Merchant', 'Doc No', 'Invoice Date', 'Paid On', 'Invoice Amount', 'Paid Amt', 'Terms', 'Bank Acct Last 4', 'Category', 'Currency']
    const renamed = `${String.fromCharCode(0xfeff)}${renamedHeaders.map((h) => `"${h}"`).join(',')}\r\n${body}`
    const mapping = confirmedFrom(renamedHeaders, {
      Merchant: 'vendor', 'Doc No': 'invoice_number', 'Invoice Date': 'invoice_date', 'Paid On': 'payment_date', 'Invoice Amount': 'invoice_amount',
      'Paid Amt': 'amount_paid', Terms: 'terms', 'Bank Acct Last 4': 'bank_account_last4', Category: 'category', Currency: 'currency',
    })
    const applied = applyMapping(renamed, mapping)
    expect(applied.slice(applied.indexOf('\n') + 1)).toBe(renamed.slice(renamed.indexOf('\n') + 1))
    expect(comparable(applied)).toEqual(comparable(sampleLedger))
  })

  it('keeps a recognisable column the person left unmapped out of the import', () => {
    const csv = 'Vendor,Supplier,Payment Date,Amount Paid\nAcme Parent,Acme Sub,2025-01-02,10.00\n'
    const mapping = confirmedFrom(['Vendor', 'Supplier', 'Payment Date', 'Amount Paid'], { Supplier: 'vendor', 'Payment Date': 'payment_date', 'Amount Paid': 'amount_paid' })
    const records = parseCsv(applyMapping(csv, mapping)).records
    expect(records.map((r) => r.vendor)).toEqual(['Acme Sub'])
  })

  it('throws on a conflicting mapping or a file whose header row does not match', () => {
    const headers = ['Payee', 'Supplier', 'Paid', 'Amt']
    const csv = `${headers.join(',')}\na,b,2025-01-02,1.00\n`
    expect(() => applyMapping(csv, confirmedFrom(headers, { Payee: 'vendor', Supplier: 'vendor' }))).toThrow(MappingConflictError)
    expect(() => applyMapping('x,y\n1,2\n', confirmedFrom(headers, { Payee: 'vendor' }))).toThrow(MappingConflictError)
    expect(() => applyMapping(csv, { ...confirmedFrom(headers, { Payee: 'vendor' }), locale: { dateOrder: 'day_first', decimal: 'dot' } })).toThrow(MappingConflictError)
  })

  it('a partial import keeps good rows and rejects only the bad ones', () => {
    const headers = ['Merchant', 'Paid On', 'Paid Amt']
    const csv = `${headers.join(',')}\nAcme,2025-01-02,10.00\n,2025-01-03,5.00\nBeta,not a date,5.00\nGamma,2025-01-04,abc\n`
    const parsed = parseCsv(applyMapping(csv, confirmedFrom(headers, { Merchant: 'vendor', 'Paid On': 'payment_date', 'Paid Amt': 'amount_paid' })))
    expect(parsed.records).toHaveLength(1)
    expect(parsed.skippedCount).toBe(3)
  })
})

describe('diffMappings', () => {
  const headers = ['Payee', 'Paid', 'Amt', 'Ref', 'GL']
  const base = confirmedFrom(headers, { Payee: 'vendor', Paid: 'payment_date', Amt: 'amount_paid', Ref: 'invoice_number', GL: 'category' })
  it('is empty for the same mapping', () => {
    expect(diffMappings(base, base)).toEqual({ material: false, changes: [] })
  })
  it('treats a category-only change as immaterial', () => {
    const next = confirmedFrom(headers, { Payee: 'vendor', Paid: 'payment_date', Amt: 'amount_paid', Ref: 'invoice_number' })
    expect(diffMappings(base, next)).toMatchObject({ material: false, changes: [{ field: 'category', material: false }] })
  })
  it('treats a rule-driving field moving or disappearing as material', () => {
    const next = confirmedFrom(headers, { Payee: 'vendor', Paid: 'payment_date', Amt: 'amount_paid', GL: 'category' })
    expect(diffMappings(base, next)).toMatchObject({ material: true, changes: [{ field: 'invoice_number', from: 'ref', to: null, material: true }] })
  })
  it('treats a locale change as material', () => {
    expect(diffMappings(base, { ...base, locale: { dateOrder: 'day_first', decimal: 'dot' } }).material).toBe(true)
  })
})
