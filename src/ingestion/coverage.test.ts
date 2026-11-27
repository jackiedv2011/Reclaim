import { describe, expect, it } from 'vitest'
import sampleLedger from '../../public/sample-ledger.csv?raw'
import type { CheckCoverage, DetectionRule, ImportCoverage, ReportType } from '../contracts/financial.ts'
import { DETECTION_RULES } from '../contracts/financial.ts'
import { parseCsv } from '../lib/csv.ts'
import { computeImportCoverage, rejectReasonFor, RULE_REQUIREMENTS, summarizeCoverage } from './coverage.ts'

const KNOWN = { status: 'known_format' as const, mappingId: null, version: null, pendingFields: [] }
const DEDUP = { newRecords: 0, alreadyImported: 0, repeatedWithinImport: 0 }

function coverageFor(csv: string, opts: { reportType?: ReportType; mapping?: ImportCoverage['mapping'] } = {}): ImportCoverage {
  return computeImportCoverage({ importId: 'imp_test', sourceSystem: 'csv_upload', reportType: opts.reportType, parse: parseCsv(csv), mapping: opts.mapping ?? KNOWN, dedup: DEDUP, freshAsOf: null })
}
const check = (c: ImportCoverage, rule: DetectionRule): CheckCoverage => c.checks.find((x) => x.rule === rule) as CheckCoverage
const codes = (c: ImportCoverage, rule: DetectionRule) => check(c, rule).reasons.map((r) => r.code)

/** Synthetic ledger: `vendors` vendors × `per` monthly payments, all fields filled. */
function ledger({ vendors = 3, per = 6, currency = (_v: number, _i: number): string => 'USD', omit = [] as string[] } = {}) {
  const cols = ['vendor', 'invoice_number', 'invoice_date', 'payment_date', 'invoice_amount', 'amount_paid', 'terms', 'bank_account_last4', 'category', 'currency'].filter((c) => !omit.includes(c))
  const rows: string[] = [cols.join(',')]
  for (let v = 0; v < vendors; v += 1) {
    for (let i = 0; i < per; i += 1) {
      const m = String(i + 1).padStart(2, '0')
      const cells: Record<string, string> = {
        vendor: `Vendor ${v}`, invoice_number: `INV-${v}${i}0${v}`, invoice_date: `2025-${m}-01`, payment_date: `2025-${m}-20`,
        invoice_amount: `${1000 + v * 10 + i}.00`, amount_paid: `${1000 + v * 10 + i}.00`, terms: '2/10 net 30', bank_account_last4: `${4000 + v}`, category: 'COGS', currency: currency(v, i),
      }
      rows.push(cols.map((c) => cells[c]).join(','))
    }
  }
  return `${rows.join('\n')}\n`
}

describe('computeImportCoverage', () => {
  it('supports every check on a complete multi-month USD ledger', () => {
    const c = coverageFor(ledger())
    expect(c.checks.map((x) => x.rule)).toEqual([...DETECTION_RULES])
    expect(c.checks.filter((x) => x.status !== 'supported')).toEqual([])
    expect(c.rows).toEqual({ total: 18, accepted: 18, rejected: 0 })
    expect(c.dateRange).toEqual({ from: '2025-01-20', to: '2025-06-20' })
    expect(c.currencies).toEqual(['USD'])
    expect(c.contractVersion).toBe('0.1.0')
    expect(summarizeCoverage(c).canSayNoFindings).toBe(true)
  })

  it('never treats a missing column as zero or as a pass', () => {
    const c = coverageFor(ledger({ omit: ['terms', 'bank_account_last4', 'invoice_amount'] }))
    for (const rule of ['overpayment', 'unclaimed_discount', 'missed_discount', 'bank_account_change'] as const) {
      expect(check(c, rule).status).toBe('not_run')
      expect(codes(c, rule)).toContain('missing_required_field')
    }
    expect(check(c, 'overpayment').missingFields).toEqual(['invoice_amount'])
    expect(codes(c, 'unclaimed_discount')).toContain('no_terms')
    expect(codes(c, 'bank_account_change')).toContain('no_bank_details')
    expect(check(c, 'near_duplicate').status).toBe('supported')
    const s = summarizeCoverage(c)
    expect(s.canSayNoFindings).toBe(false)
    expect(s.checksNotRun).toBe(4)
  })

  it('treats a present-but-empty column the same as a missing one', () => {
    const csv = ledger().replace(/,2\/10 net 30,/g, ',,')
    const c = coverageFor(csv)
    expect(check(c, 'missed_discount').status).toBe('not_run')
    expect(check(c, 'missed_discount').missingFields).toEqual(['terms'])
  })

  it('limits a check whose required field is filled on fewer than half the rows', () => {
    let n = 0
    const csv = ledger().replace(/,INV-\d+,/g, (m) => (n++ % 3 === 0 ? m : ',,'))
    const c = coverageFor(csv)
    expect(check(c, 'exact_duplicate').status).toBe('limited')
    expect(check(c, 'exact_duplicate').reasons[0]).toMatchObject({ code: 'field_sparse', fields: ['invoice_number'] })
    expect(check(c, 'near_duplicate').status).toBe('supported')
  })

  it('a bill-only export cannot establish duplicate settled payments', () => {
    const csv = 'Date,Num,Vendor,Due Date,Amount,Open Balance\n2025-01-02,B-100,Acme,2025-02-01,10.00,10.00\n'
    const parsed = parseCsv(csv)
    expect(parsed.records).toHaveLength(0)
    const c = computeImportCoverage({ importId: 'b', sourceSystem: 'csv_upload', reportType: 'bills', parse: parsed, mapping: KNOWN, dedup: DEDUP })
    for (const rule of ['exact_duplicate', 'near_duplicate'] as const) {
      expect(check(c, rule).status).toBe('not_run')
      expect(codes(c, rule)).toEqual(expect.arrayContaining(['report_type_cannot_establish', 'no_settlement_status']))
    }
    expect(summarizeCoverage(c).canSayNoFindings).toBe(false)
  })

  it('a bill export with payment columns still marks duplicate checks not_run', () => {
    const c = coverageFor(ledger(), { reportType: 'bills' })
    expect(check(c, 'exact_duplicate').status).toBe('not_run')
    expect(codes(c, 'near_duplicate')).toEqual(expect.arrayContaining(['report_type_cannot_establish', 'no_settlement_status']))
    expect(check(c, 'amount_outlier').status).toBe('limited')
  })

  it('an unknown report type limits the duplicate checks with no_settlement_status', () => {
    const c = coverageFor(ledger(), { reportType: 'unknown' })
    expect(check(c, 'exact_duplicate').status).toBe('limited')
    expect(codes(c, 'exact_duplicate')).toContain('no_settlement_status')
  })

  it('limits amount checks for an unsupported currency', () => {
    const c = coverageFor(ledger({ currency: () => 'EUR' }))
    expect(c.currencies).toEqual(['EUR'])
    expect(check(c, 'overpayment').status).toBe('limited')
    expect(codes(c, 'overpayment')).toContain('unsupported_currency')
    expect(check(c, 'bank_account_change').status).toBe('supported')
  })

  it('limits amount checks for mixed currencies, including rows with no currency', () => {
    const mixed = coverageFor(ledger({ currency: (v) => (v === 0 ? 'CAD' : 'USD') }))
    expect(mixed.currencies).toEqual(['CAD', 'USD'])
    expect(codes(mixed, 'near_duplicate')).toEqual(expect.arrayContaining(['mixed_currencies', 'unsupported_currency']))
    const partial = coverageFor(ledger({ currency: (v) => (v === 0 ? '' : 'USD') }))
    expect(codes(partial, 'near_duplicate')).toEqual(['mixed_currencies'])
  })

  it('an unconfirmed mapping limits every check; a conflicting one stops every check', () => {
    const pending = coverageFor(ledger(), { mapping: { status: 'pending_confirmation', mappingId: null, version: null, pendingFields: ['vendor'] } })
    expect(pending.checks.every((x) => x.status === 'limited' && x.reasons.some((r) => r.code === 'mapping_unconfirmed'))).toBe(true)
    expect(summarizeCoverage(pending).canSayNoFindings).toBe(false)
    const conflict = coverageFor(ledger(), { mapping: { status: 'conflict', mappingId: null, version: null, pendingFields: [] } })
    expect(conflict.checks.every((x) => x.status === 'not_run')).toBe(true)
  })

  it('reports too few records for the outlier rule and pairwise rules', () => {
    const c = coverageFor(ledger({ vendors: 3, per: 2 }))
    expect(check(c, 'amount_outlier').status).toBe('not_run')
    expect(codes(c, 'amount_outlier')).toContain('too_few_records')
    const one = coverageFor(ledger({ vendors: 1, per: 1 }))
    expect(check(one, 'near_duplicate').status).toBe('not_run')
    expect(codes(one, 'near_duplicate')).toContain('too_few_records')
    expect(check(one, 'shared_invoice_number').status).toBe('not_run')
  })

  it('limits the outlier rule for a single month of history', () => {
    const rows = ['vendor,payment_date,amount_paid', ...Array.from({ length: 6 }, (_, i) => `Acme,2025-03-${String(i + 1).padStart(2, '0')},${100 + i}.00`)]
    const c = coverageFor(rows.join('\n'))
    expect(check(c, 'amount_outlier').status).toBe('limited')
    expect(codes(c, 'amount_outlier')).toContain('single_period')
  })

  it('maps rejected rows to reason codes without carrying their values', () => {
    const csv = [
      'vendor,payment_date,amount_paid,invoice_number',
      'Acme,2025-01-02,10.00,SECRET-REF-1',
      ',2025-01-03,5.00,SECRET-REF-2',
      'Beta,,5.00,SECRET-REF-3',
      'Gamma,31/01/2025,5.00,SECRET-REF-4',
      'Delta,2025-01-04,,SECRET-REF-5',
      'Echo,2025-01-04,"1.234,56",SECRET-REF-6',
      'Foxtrot,2025-01-04,ten,SECRET-REF-7',
      ',,,',
    ].join('\n')
    const c = coverageFor(csv)
    expect(c.rows).toEqual({ total: 8, accepted: 1, rejected: 7 })
    expect(c.rejected).toEqual([
      { row: 3, reason: 'missing_vendor' },
      { row: 4, reason: 'missing_payment_date' },
      { row: 5, reason: 'invalid_payment_date' },
      { row: 6, reason: 'missing_amount' },
      { row: 7, reason: 'invalid_amount' },
      { row: 8, reason: 'invalid_amount' },
      { row: 9, reason: 'blank_row' },
    ])
    expect(JSON.stringify(c)).not.toMatch(/SECRET|Acme|Gamma/)
    expect(summarizeCoverage(c).statement).toContain('7 row(s) were rejected')
  })

  it('classifies rows defensively', () => {
    expect(rejectReasonFor(null)).toBe('other')
    expect(rejectReasonFor({ vendor: 'n/a', payment_date: '2025-01-01', amount_paid: '1' })).toBe('missing_vendor')
    expect(rejectReasonFor({ vendor: 'A', payment_date: '2025-01-01', amount_paid: '1' })).toBe('other')
  })

  it('computes source accounts, currencies and passes mapping/dedup through', () => {
    const csv = 'vendor,payment_date,amount_paid,source_account,currency\nA,2025-01-02,1.00,Ops Checking,usd\nB,2025-02-02,2.00,AP Card,USD\nC,2025-02-03,3.00,,USD\n'
    const c = computeImportCoverage({
      importId: 'i', sourceSystem: 'quickbooks', parse: parseCsv(csv), mapping: { status: 'confirmed', mappingId: 'sig:v2', version: 2, pendingFields: [] },
      dedup: { newRecords: 2, alreadyImported: 1, repeatedWithinImport: 0 }, freshAsOf: '2025-03-01T00:00:00.000Z',
    })
    expect(c.sourceAccounts).toEqual(['AP Card', 'Ops Checking'])
    expect(c.currencies).toEqual(['USD'])
    expect(c.mapping).toEqual({ status: 'confirmed', mappingId: 'sig:v2', version: 2, pendingFields: [] })
    expect(c.dedup.alreadyImported).toBe(1)
    expect(c.freshAsOf).toBe('2025-03-01T00:00:00.000Z')
    expect(c.sourceSystem).toBe('quickbooks')
  })

  it('an empty or header-only import runs nothing and says so', () => {
    for (const csv of ['', 'vendor,payment_date,amount_paid\n']) {
      const c = coverageFor(csv)
      expect(c.rows.accepted).toBe(0)
      expect(c.dateRange).toBeNull()
      expect(c.checks.every((x) => x.status === 'not_run')).toBe(true)
      const s = summarizeCoverage(c)
      expect(s.canSayNoFindings).toBe(false)
      expect(s.statement).toBe('No rows were accepted, so no checks could run.')
    }
  })

  it('the shipped sample ledger runs every check except where the data is thin', () => {
    const c = coverageFor(sampleLedger)
    expect(c.reportType).toBe('bills_with_payments')
    expect(c.rows.rejected).toBe(0)
    expect(check(c, 'exact_duplicate').status).toBe('supported')
  })

  it('requirement table names only fields the parser produces', () => {
    const known = new Set(['vendor', 'invoice_number', 'invoice_date', 'payment_date', 'invoice_amount', 'amount_paid', 'terms', 'bank_account_last4', 'category', 'currency', 'transaction_id', 'company', 'source_account', 'transaction_type', 'supplier_id'])
    for (const req of Object.values(RULE_REQUIREMENTS)) for (const f of [...req.required, ...req.optional]) expect(known.has(f)).toBe(true)
  })
})

describe('summarizeCoverage wording', () => {
  it('never claims the data is clean or issue-free', () => {
    const cases = [coverageFor(ledger()), coverageFor(ledger({ omit: ['terms'] })), coverageFor(''), coverageFor(ledger(), { reportType: 'bills' })]
    for (const c of cases) {
      const { statement } = summarizeCoverage(c)
      expect(statement).not.toMatch(/clean|no issues|issue-free|all clear/i)
    }
  })

  it('says how many checks ran fully, ran with limits and could not run', () => {
    const s = summarizeCoverage(coverageFor(ledger({ omit: ['terms'] }), { mapping: { status: 'pending_confirmation', mappingId: null, version: null, pendingFields: [] } }))
    expect(s.checksRun).toBe(0)
    expect(s.checksNotRun).toBe(2)
    expect(s.checksLimited).toBe(6)
    expect(s.notRunRules).toEqual(['unclaimed_discount', 'missed_discount'])
    expect(s.statement).toContain('a check that did not run is not a pass')
  })
})
