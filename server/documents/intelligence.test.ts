// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { authorizedProject } from '../testProject.ts'
import { buildEvidenceSummary } from './summary.ts'
import { buildSecondLook } from './secondLook.ts'
import type { FactView } from './facts.ts'

type Project = ReturnType<typeof authorizedProject>['project'] & { environment: Record<string, unknown> }
const base = () => structuredClone(authorizedProject('p1', { vendor: 'Synthetic Supplier', invoice: 'INV-1', amount: 100, requested: 100 })) as { project: Project; findingId: string }
const look = (project: Project, findingId: string, facts: FactView[] = []) => buildSecondLook({ project, projectId: 'p1', findingId, revision: 1, facts })!
const candidate = (l: ReturnType<typeof look>, kind: string) => l.candidates.find((c) => c.kind === kind)!

const fact = (over: Partial<FactView>): FactView => ({
  id: 'fact_x', documentId: 'doc_1', kind: 'credit_note_ref', value: 'CN-1', provenance: { line: 3, charStart: 0, charEnd: 4, excerpt: 'Credit note: CN-1' },
  confidence: 'high', conflicts: [], origin: 'deterministic', status: 'proposed', projectId: 'p1', findingId: null, createdAt: 1, verification: null, authoritative: false, ...over,
})

describe('second look', () => {
  it('with nothing pointing elsewhere, says the flag is unexplained but never dismisses or confirms it', () => {
    const { project, findingId } = base()
    const l = look(project, findingId)
    expect(l.candidates.filter((c) => c.status === 'indicated').map((c) => c.kind)).toEqual(['uncertain'])
    expect(l.detector).toMatchObject({ type: 'exact_duplicate', classification: 'recovery_candidate' })
    expect(l.notice).toMatch(/never dismisses, suppresses or promotes/)
    expect(candidate(l, 'refund').reviewerCheck).toMatchObject({ key: 'refund', confirmed: true })
  })

  it('points to a saved recurring series', () => {
    const { project, findingId } = base()
    const ids = (project.environment.records as Array<{ id: string }>).map((r) => r.id)
    ;(project.environment.result as Record<string, unknown>).recurringSeries = [{ recordIds: [...ids, 'p1-r9'], cadenceDays: 7, paymentCount: 3 }]
    const c = candidate(look(project, findingId), 'legitimate_recurrence')
    expect(c.status).toBe('indicated')
    expect(c.citations).toEqual(['record:p1-r0', 'record:p1-r1', 'record:p1-r9'])
  })

  it('points to a duplicate import when two rows share a source transaction id', () => {
    const { project, findingId } = base()
    for (const r of project.environment.records as Array<Record<string, unknown>>) r.externalTransactionId = 'TXN-1'
    const c = candidate(look(project, findingId), 'duplicate_import')
    expect(c).toMatchObject({ status: 'indicated', citations: ['record:p1-r0', 'record:p1-r1'] })
    expect(c.evidenceGap).toMatch(/bank/i)
  })

  it('points to instalments when the payments add up to the invoice', () => {
    const { project, findingId } = base()
    for (const r of project.environment.records as Array<Record<string, unknown>>) { r.amountPaid = 50; r.invoiceAmount = 100 }
    expect(candidate(look(project, findingId), 'instalments_or_split').status).toBe('indicated')
  })

  it('points to refunds, adjustments and credits elsewhere in the supplier’s ledger and documents', () => {
    const { project, findingId } = base()
    const records = project.environment.records as Array<Record<string, unknown>>
    records.push({ id: 'p1-r7', vendor: 'synthetic  supplier', amountPaid: -100, transactionType: 'Vendor Refund' }, { id: 'p1-r8', vendor: 'Synthetic Supplier', amountPaid: 100, transactionType: 'Void' })
    const l = look(project, findingId, [fact({ documentId: 'doc_9', provenance: { line: 3, charStart: 0, charEnd: 4, excerpt: 'Credit note: CN-1' } })])
    expect(candidate(l, 'refund')).toMatchObject({ status: 'indicated', citations: ['record:p1-r7'] })
    expect(candidate(l, 'adjustment')).toMatchObject({ status: 'indicated', citations: ['record:p1-r8'] })
    expect(candidate(l, 'credit')).toMatchObject({ status: 'indicated', citations: ['document:doc_9#L3'] })
    expect(candidate(l, 'uncertain').status).toBe('not_indicated')
    expect(l.detector.type).toBe('exact_duplicate')
  })

  it('a rejected fact is not evidence of anything', () => {
    const { project, findingId } = base()
    expect(candidate(look(project, findingId, [fact({ status: 'rejected' })]), 'credit').status).toBe('not_indicated')
  })

  it('returns null for a missing case or a malformed saved project', () => {
    const { project } = base()
    expect(buildSecondLook({ project, projectId: 'p1', findingId: 'nope', revision: 1, facts: [] })).toBeNull()
    expect(buildSecondLook({ project: { environment: 'garbage' } as never, projectId: 'p1', findingId: 'x', revision: 1, facts: [] })).toBeNull()
    expect(buildSecondLook({ project: null, projectId: 'p1', findingId: 'x', revision: 1, facts: [] })).toBeNull()
  })
})

describe('evidence summary', () => {
  it('states the gate’s amount only when the gate passes, and cites the obligation', () => {
    const { project, findingId } = base()
    const s = buildEvidenceSummary({ project, projectId: 'p1', findingId, revision: 3, documents: [], facts: [] })!
    expect(s.amountBreakdown).toMatchObject({ paymentsMinor: 20000, obligationMinor: 10000, potentialAmountMinor: 10000 })
    expect(s.sentences.some((x) => x.citations.includes(`obligation:${findingId}`))).toBe(true)
    expect(s.sentences.every((x) => x.citations.length > 0)).toBe(true)
    expect(s.sentences.some((x) => x.citations.includes(`case:${findingId}@3`))).toBe(true)
  })

  it('lists missing evidence and establishes no amount when the evidence is incomplete', () => {
    const { project, findingId } = base()
    const finding = (project.environment.result as { findings: Array<Record<string, unknown>> }).findings[0]
    delete finding.evidence
    const s = buildEvidenceSummary({ project, projectId: 'p1', findingId, revision: 1, documents: [], facts: [] })!
    expect(s.gate.eligible).toBe(false)
    expect(s.amountBreakdown).toBeNull()
    expect(s.missingEvidence.length).toBeGreaterThan(3)
    expect(s.sentences.find((x) => /No request amount is established/.test(x.text))).toBeTruthy()
    expect(s.sentences.filter((x) => x.text.startsWith('Missing:')).length).toBeGreaterThan(3)
  })

  it('reports contradictions from the stored evidence, and compares document invoice numbers with the rows', () => {
    const { project, findingId } = base()
    const finding = (project.environment.result as { findings: Array<{ evidence: { contradictions: string[] } }> }).findings[0]
    finding.evidence.contradictions = ['Supplier statement shows the second payment was returned.']
    const facts = [fact({ kind: 'invoice_ref', value: 'INV-1' }), fact({ id: 'fact_y', kind: 'invoice_ref', value: 'INV-2', provenance: { line: 4, charStart: 0, charEnd: 5, excerpt: 'Invoice: INV-2' } })]
    const s = buildEvidenceSummary({ project, projectId: 'p1', findingId, revision: 1, documents: [], facts })!
    expect(s.gate.eligible).toBe(false)
    expect(s.contradictions).toContain('Supplier statement shows the second payment was returned.')
    expect(s.sentences.filter((x) => /matches the case's payment rows/.test(x.text))).toHaveLength(1)
    expect(s.sentences.filter((x) => /does not appear on the case's payment rows/.test(x.text))).toHaveLength(1)
  })
})
