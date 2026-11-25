import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/csv'
import { detectFindings } from '@/lib/detection'
import { generateFollowUp } from '@/lib/followUps'
import { billName, generateLetter } from '@/lib/letters'
import { attestDuplicate } from '@/recovery/testEvidence'
import type { CaseState } from '@/ledger/caseState'
import type { Finding } from '@/types'

const sender = { businessName: 'Bean Co', senderName: 'Dana', senderEmail: '' }
const HEADER = 'vendor,invoice_number,payment_date,invoice_amount,amount_paid,currency'
const found = (rows: string[]): Finding => detectFindings(parseCsv([HEADER, ...rows].join('\n')).records.map((r, i) => ({ ...r, id: `rec_${i}`, importBatchId: 'x' }))).findings.find((f) => f.type.endsWith('duplicate'))!
const numbered = () => found(['Acme,INV-7,2025-01-10,700,700,USD', 'Acme,INV-7,2025-01-20,700,700,USD'])
const unnumbered = () => found(['Acme,,2025-01-10,700,700,USD', 'Acme,,2025-01-12,700,700,USD'])
const state = (extra: Partial<CaseState> = {}): CaseState => ({ decision: 'confirmed', reason: null, decidedAt: 1, recoveryStage: 'requested', requestedAmount: 700, recoveryRequestedAt: 1000, ...extra })
const followUp = (finding: Finding, s: CaseState) => generateFollowUp(finding, s, sender, 1000)

describe('follow-up email', () => {
  it('names the bill, never the rule that flagged it', () => {
    const near = found(['Acme,A-100,2025-01-10,,700,USD', 'Acme,B-207,2025-01-20,,700,USD'])
    expect(near.title).toMatch(/same vendor and amount/i)
    for (const finding of [numbered(), near, unnumbered()]) {
      const { subject, body } = followUp(finding, state())
      expect(`${subject}\n${body}`).not.toMatch(/same vendor and amount|reference variant|repeated payments for/i)
    }
    expect(followUp(numbered(), state()).body).toContain('about a duplicate payment on invoice INV-7.')
    expect(followUp(numbered(), state()).subject).toBe('Re: Duplicate payment on invoice INV-7')
    expect(followUp(unnumbered(), state()).body).toContain('about a payment of $700.00 that went to you more than once.')
    expect(followUp(unnumbered(), state({ recoverySubject: 'Our request' })).subject).toBe('Re: Our request')
  })

  it('states the balance of this request, not money an earlier request brought back', () => {
    const s = state({ activeRequestGeneration: 2, recoverySettlements: [{ amount: 300, method: 'refund', source: 'bank', reference: 'OLD', settledAt: 5 }] })
    expect(followUp(numbered(), s).body).toContain('We asked for $700.00 back')
    expect(followUp(numbered(), s).body).not.toContain('still open')
    const partly = state({ activeRequestGeneration: 2, recoverySettlements: [...s.recoverySettlements!, { amount: 100, method: 'refund', source: 'bank', reference: 'NEW', settledAt: 6, requestGeneration: 2 }] })
    expect(followUp(numbered(), partly).body).toContain('$600.00 of the $700.00 we asked for is still open')
  })
})

describe('a bill with no number', () => {
  const withBill = (finding: Finding, obligationId: string): Finding => {
    const attested = attestDuplicate(finding)
    return { ...attested, evidence: { ...attested.evidence!, obligation: { ...attested.evidence!.obligation, obligationId }, payments: attested.evidence!.payments.map((p) => ({ ...p, obligationId })) } }
  }

  it.each(['Not numbered', 'not-numbered', 'No invoice', 'no number', 'N/A', 'none', 'Unknown'])('"%s" is never written as an invoice number', (placeholder) => {
    const { subject, body } = generateLetter(withBill(unnumbered(), placeholder), sender)
    expect(subject).toBe('Request for refund — duplicate payment')
    expect(body).toContain('we paid Acme more than once for the same bill: $700.00 on Jan 10, 2025 and $700.00 on Jan 12, 2025')
    expect(`${subject}\n${body}`.toLowerCase()).not.toContain(`invoice ${placeholder.toLowerCase()}`)
  })

  it('uses the number the vendor knows, not QuickBooks’ or Reclaim’s own id', () => {
    expect(billName(withBill(numbered(), 'qbo:Bill:101'))).toBe('invoice INV-7')
    expect(billName(withBill(numbered(), 'BILL-9'))).toBe('invoice BILL-9')
    const f = unnumbered()
    expect(billName(withBill(f, f.id))).toBeNull()
  })
})

describe('letters about part of a claim', () => {
  it('says what already came back when it asks for the rest', () => {
    const { body } = generateLetter(attestDuplicate(numbered()), sender, 'refund', 300, 400)
    expect(body).toContain('We have already received $400.00 of it.')
    expect(body).toContain('a refund of $300.00')
  })
  it('reads a stored calendar day as that day', () => {
    const finding = attestDuplicate(numbered())
    finding.relatedRecords = finding.relatedRecords.map((r, i) => ({ ...r, paymentDate: `2025-01-${i ? '20' : '10'}` as unknown as Date }))
    expect(generateLetter(finding, sender).body).toContain('$700.00 on Jan 10, 2025 and $700.00 on Jan 20, 2025')
  })
  it('keeps an internal note in the record’s currency', () => {
    const euro = found(['Acme,INV-7,2025-01-10,700,700,EUR', 'Acme,INV-7,2025-01-20,700,700,EUR'])
    const { body } = generateLetter(euro, sender)
    expect(body).toContain('Amount flagged: €700.00')
    expect(body).not.toContain('$')
  })
})
