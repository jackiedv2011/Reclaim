import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/csv'
import { detectFindings } from '@/lib/detection'
import { FINDING_TYPE_ORDER } from '@/lib/labels'
import { assessDataReadiness, runnableChecks, runnableCheckCount, TOTAL_CHECK_COUNT } from '@/audit/dataReadiness'
import { buildRuleChecklist, keyUncertainty } from '@/audit/ruleChecklist'
import { buildEvidenceGaps } from '@/audit/evidenceGaps'

const parse = (rows: string[]) => parseCsv(rows.join('\n'))

describe('how many checks a file can run', () => {
  it('counts all eight', () => {
    expect(TOTAL_CHECK_COUNT).toBe(8)
    expect(TOTAL_CHECK_COUNT).toBe(FINDING_TYPE_ORDER.length)
    const full = parse(['vendor,invoice_number,invoice_date,invoice_amount,payment_date,amount_paid,terms,bank_account_last4', 'Acme,INV-1001,2025-01-01,100,2025-01-05,100,2/10 net 30,1234'])
    const readiness = assessDataReadiness(full)
    expect(readiness).toMatchObject({ availableCheckCount: 8, totalCheckCount: 8, weakerChecks: [] })
    expect(runnableChecks(full.records)).toEqual(FINDING_TYPE_ORDER)
  })
  it('near-duplicate detection runs without invoice references, and says it is weaker', () => {
    const bare = parse(['vendor,payment_date,amount_paid', 'Acme,2025-01-10,100', 'Acme,2025-01-12,100'])
    expect(runnableChecks(bare.records)).toEqual(['near_duplicate', 'amount_outlier'])
    expect(runnableCheckCount(bare.records)).toBe(2)
    const readiness = assessDataReadiness(bare)
    expect(readiness.availableCheckCount).toBe(2)
    const [references] = readiness.weakerChecks
    expect(references.label).toContain('no invoice-reference column')
    expect(references.label).toMatch(/near-duplicate.*vendor, amount and date/i)
    expect(references.label).not.toMatch(/near-duplicate detection (is|are) unavailable/i)
    // and the claim is true
    expect(detectFindings(bare.records).findings.map((f) => f.type)).toEqual(['near_duplicate'])
  })
  it('references that are all placeholders are not usable references', () => {
    const words = parse(['vendor,invoice_number,payment_date,amount_paid', 'Acme,Autopay,2025-01-10,100', 'Beta,N/A,2025-02-12,100', 'Beta,000,2025-03-12,100'])
    const readiness = assessDataReadiness(words)
    expect(readiness.missingInvoiceRefCount).toBe(3)
    expect(runnableChecks(words.records)).toEqual(['near_duplicate', 'amount_outlier'])
    expect(readiness.weakerChecks[0].label).toContain('no usable invoice references')
  })
  it('an invoice amount of zero is not an invoice amount, and an empty file can run nothing', () => {
    const zero = parse(['vendor,invoice_number,payment_date,amount_paid,invoice_amount', 'Acme,INV-1001,2025-01-10,100,0'])
    expect(runnableChecks(zero.records)).not.toContain('overpayment')
    expect(runnableCheckCount([])).toBe(0)
  })
})

describe('rule checklist tells the truth about references', () => {
  const near = (rows: string[], header = 'vendor,invoice_number,payment_date,amount_paid') =>
    detectFindings(parse([header, ...rows]).records).findings.find((f) => f.type === 'near_duplicate')!
  const labels = (rows: string[]) => buildRuleChecklist(near(rows)).map((c) => `${c.matched ? '+' : '-'}${c.label}`)
  it('no reference on either payment', () => {
    expect(labels(['Acme,,2025-01-10,100', 'Acme,Autopay,2025-01-12,100'])).toEqual(['+Same vendor', '-No invoice reference on either payment', '+Same amount', '-Different payment date'])
  })
  it('a reference on only one payment', () => {
    expect(labels(['Acme,INV-1001,2025-01-10,100', 'Acme,,2025-01-12,100'])).toContain('-Invoice reference on only one payment')
  })
  it('two different references', () => {
    expect(labels(['Acme,INV-1001,2025-01-10,100', 'Acme,INV-2044,2025-01-12,100'])).toContain('-Different invoice reference')
  })
  it('one reference written two ways, same day', () => {
    const out = labels(['Acme,INV-1001,2025-01-10,100', 'Acme,1001,2025-01-10,100'])
    expect(out).toContain('+Same invoice reference, written differently')
    expect(out).toContain('+Same payment date')
  })
  it('two vendor names', () => {
    const finding = near(['Brightline Electric,BE-20931,2025-03-04,1450', 'Brightlne Electric,BE-20931,2025-03-20,1450'])
    expect(keyUncertainty(finding)).toBe('Near-identical vendor names, not the same one')
    expect(buildEvidenceGaps(finding).map((g) => g.label)).toContain('Vendor master record')
  })
  it('a placeholder reference still needs an invoice copy', () => {
    expect(buildEvidenceGaps(near(['Acme,Debit,2025-01-10,100', 'Acme,Debit,2025-01-12,100'])).map((g) => g.label)).toContain('Invoice copy')
  })
})
