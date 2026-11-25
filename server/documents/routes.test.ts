// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../aiGateway/providers.ts'
import { authorizedProject } from '../testProject.ts'
import { b64, INVOICE, INVOICE_TEXT, MALICIOUS_TEXT, startHarness, VENDOR, type Client, type Harness } from './fixtures.ts'

let h: Harness
let answers: Record<string, unknown>
let mock: ReturnType<typeof createMockProvider>
let alice: { client: Client; userId: string }
let logged: string[]
const { project, findingId } = authorizedProject('p1', { vendor: VENDOR, invoice: INVOICE, amount: 1250, requested: 1250 })
const recordIds = project.environment.records.map((r) => r.id)

beforeEach(async () => {
  answers = {}
  mock = createMockProvider(answers)
  h = await startHarness(mock)
  alice = await h.signUp('alice@example.test')
  h.seed(alice.userId, structuredClone(project))
  logged = []
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await h.close()
  // Document text never reaches a log line, whatever the test did.
  for (const secret of [VENDOR, INVOICE, 'Ignore all rules', '9,999', 'NWP-77', 'Freight surcharge']) expect(logged.join('\n')).not.toContain(secret)
})

const upload = (c: Client, text: string | Buffer, extra: Record<string, unknown> = {}) =>
  c.post('/api/documents', { projectId: 'p1', findingId, kind: 'invoice', filename: 'invoice.txt', contentBase64: b64(text), ...extra })
const enableAi = (c: Client) => c.put('/api/ai/policy', { mode: 'on_demand', acknowledged: true })

describe('intake', () => {
  it('stores a text invoice sealed at rest and lists it', async () => {
    const res = await upload(alice.client, INVOICE_TEXT)
    expect(res.status).toBe(201)
    expect(res.body.document).toMatchObject({ kind: 'invoice', format: 'text', status: 'received', projectId: 'p1', findingId, filename: 'invoice.txt', size: Buffer.byteLength(INVOICE_TEXT) })
    expect(res.body.document.retentionUntil - res.body.document.createdAt).toBe(365 * 86_400_000)
    const list = await alice.client.get(`/api/documents?projectId=p1&findingId=${findingId}`)
    expect(list.body.documents.map((d: { id: string }) => d.id)).toEqual([res.body.document.id])
    const row = h.app.db.prepare('SELECT filename_sealed, content_sealed FROM documents').get() as Record<string, string>
    expect(JSON.stringify(row)).not.toContain(INVOICE)
    expect(JSON.stringify(row)).not.toContain('invoice.txt')
  })

  it('reads the type from the bytes: HTML or an EXE named .txt is refused', async () => {
    const html = await upload(alice.client, '<html><body onload="steal()">Invoice</body></html>', { filename: 'invoice.txt' })
    expect(html).toMatchObject({ status: 415, body: { code: 'document_markup' } })
    const exe = await upload(alice.client, Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]), { filename: 'invoice.txt' })
    expect(exe).toMatchObject({ status: 415, body: { code: 'document_executable' } })
    const xlsm = await upload(alice.client, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]), { filename: 'invoice.csv' })
    expect(xlsm).toMatchObject({ status: 415, body: { code: 'document_archive' } })
    expect((await alice.client.get('/api/documents?projectId=p1')).body.documents).toEqual([])
  })

  it('keeps a PDF as unsupported_format and says it cannot be read', async () => {
    const res = await upload(alice.client, '%PDF-1.4\n%synthetic\n1 0 obj\n<<>>\nendobj', { filename: 'invoice.txt' })
    expect(res.status).toBe(201)
    expect(res.body.document).toMatchObject({ format: 'pdf', status: 'unsupported_format' })
    expect(res.body.document.note).toMatch(/no PDF or OCR reader/)
    const extract = await alice.client.post(`/api/documents/${res.body.document.id}/extract`)
    expect(extract).toMatchObject({ status: 422, body: { code: 'unsupported_format' } })
  })

  it('refuses oversize, malformed and empty uploads', async () => {
    expect((await upload(alice.client, 'A'.repeat(2 * 1024 * 1024 + 1))).status).toBe(413)
    expect((await alice.client.post('/api/documents', { projectId: 'p1', kind: 'invoice', filename: 'x.txt', contentBase64: 'not base64!!' })).body.code).toBe('malformed')
    expect((await alice.client.post('/api/documents', { projectId: 'p1', kind: 'receipt', filename: 'x.txt', contentBase64: b64('x') })).body.code).toBe('validation')
    expect((await upload(alice.client, '   ')).status).toBe(400)
    expect((await alice.client.post('/api/documents', { projectId: 'p1', kind: 'invoice', filename: 'x.txt', contentBase64: b64('Total due: 1.00'), extra: 1 })).status).toBe(400)
  })

  it('dedupes by content per account', async () => {
    const first = await upload(alice.client, INVOICE_TEXT)
    const again = await upload(alice.client, INVOICE_TEXT, { filename: 'renamed.txt' })
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, document: { id: first.body.document.id } } })
  })

  it('refuses unknown projects and cases, other accounts, and signed-out callers', async () => {
    expect((await alice.client.post('/api/documents', { projectId: 'nope', kind: 'invoice', filename: 'x.txt', contentBase64: b64(INVOICE_TEXT) })).status).toBe(404)
    expect((await upload(alice.client, INVOICE_TEXT, { findingId: 'exact_duplicate-other' })).status).toBe(404)
    const doc = (await upload(alice.client, INVOICE_TEXT)).body.document
    const bob = await h.signUp('bob@example.test')
    // Bob can't reach Alice's project, document, facts or case, even knowing the ids.
    expect((await upload(bob.client, 'Invoice no: INV-9')).status).toBe(404)
    expect((await bob.client.get('/api/documents?projectId=p1')).status).toBe(404)
    expect((await bob.client.get(`/api/documents/${doc.id}`)).status).toBe(404)
    expect((await bob.client.post(`/api/documents/${doc.id}/extract`)).status).toBe(404)
    expect((await bob.client.del(`/api/documents/${doc.id}`)).status).toBe(404)
    expect((await bob.client.get(`/api/recovery/cases/p1/${findingId}/evidence`)).status).toBe(404)
    expect((await bob.client.post(`/api/recovery/cases/p1/${findingId}/summary/ai`, {})).status).toBe(404)
    // Same content in Bob's own account is his own document, not Alice's.
    h.seed(bob.userId, structuredClone(project))
    const bobs = await upload(bob.client, INVOICE_TEXT)
    expect(bobs.status).toBe(201)
    expect(bobs.body.document.id).not.toBe(doc.id)
    expect((await h.client().get('/api/documents?projectId=p1')).status).toBe(401)
    expect((await alice.client.get(`/api/documents/${doc.id}`)).status).toBe(200)
  })

  it('deletes a document with its facts, and expires documents after retention', async () => {
    const doc = (await upload(alice.client, INVOICE_TEXT)).body.document
    await alice.client.post(`/api/documents/${doc.id}/extract`)
    expect((h.app.db.prepare('SELECT COUNT(*) AS n FROM proposed_facts').get() as { n: number }).n).toBeGreaterThan(0)
    expect((await alice.client.del(`/api/documents/${doc.id}`)).body).toEqual({ ok: true })
    expect((await alice.client.get(`/api/documents/${doc.id}`)).status).toBe(404)
    expect((h.app.db.prepare('SELECT COUNT(*) AS n FROM proposed_facts').get() as { n: number }).n).toBe(0)
    expect((h.app.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(0)
    expect((await upload(alice.client, INVOICE_TEXT)).status).toBe(201)
    h.clock.now += 366 * 86_400_000
    expect((await alice.client.get('/api/documents?projectId=p1')).body.documents).toEqual([])
    expect((h.app.db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n).toBe(0)
  })
})

describe('extraction and hand-off', () => {
  it('proposes facts with provenance, never touching the case', async () => {
    const before = await alice.client.get(`/api/recovery/cases/p1/${findingId}/evidence`)
    const revision = before.body.summary.revision
    const doc = (await upload(alice.client, INVOICE_TEXT)).body.document
    const res = await alice.client.post(`/api/documents/${doc.id}/extract`)
    expect(res.status).toBe(200)
    expect(res.body.authoritative).toBe(false)
    const due = res.body.facts.find((f: { kind: string }) => f.kind === 'amount_due')
    expect(due).toMatchObject({ value: '1250.00', amountMinor: 125000, status: 'proposed', origin: 'deterministic', authoritative: false, provenance: { line: 8 } })
    // Re-reading is idempotent.
    expect((await alice.client.post(`/api/documents/${doc.id}/extract`)).body.facts).toHaveLength(res.body.facts.length)
    const after = await alice.client.get(`/api/recovery/cases/p1/${findingId}/evidence`)
    expect(after.body.summary.revision).toBe(revision)
    expect(after.body.summary.caseFingerprint).toBe(before.body.summary.caseFingerprint)
    const stored = (await alice.client.get('/api/projects/p1')).body
    expect(JSON.stringify(stored.project?.environment?.result ?? stored)).not.toContain('doc_')
  })

  it('hands one fact to the FIXTURE verifier, which only says needs_review', async () => {
    const doc = (await upload(alice.client, INVOICE_TEXT)).body.document
    const facts = (await alice.client.post(`/api/documents/${doc.id}/extract`)).body.facts
    const due = facts.find((f: { kind: string }) => f.kind === 'amount_due')
    const res = await alice.client.post(`/api/documents/${doc.id}/facts/${due.id}/handoff`)
    expect(res.status).toBe(200)
    expect(res.body.verification).toMatchObject({ outcome: 'needs_review', fixture: true, verifier: 'fixture-shape-check' })
    expect(res.body.fact).toMatchObject({ status: 'handed_off', authoritative: false, verification: { outcome: 'needs_review', fixture: true } })
    expect((await alice.client.post(`/api/documents/${doc.id}/facts/${due.id}/handoff`)).body.code).toBe('fact_not_proposed')
    expect((await alice.client.post(`/api/documents/${doc.id}/facts/fact_${'0'.repeat(32)}/handoff`)).status).toBe(404)
  })

  it('refuses to hand off a fact read before the case changed', async () => {
    const doc = (await upload(alice.client, INVOICE_TEXT)).body.document
    const facts = (await alice.client.post(`/api/documents/${doc.id}/extract`)).body.facts
    const changed = structuredClone(project)
    ;(changed.environment.caseStates[findingId] as Record<string, unknown>).vendorUpdates = [{ at: 5, status: 'acknowledged', note: 'Synthetic reply' }]
    h.seed(alice.userId, changed)
    expect((await alice.client.post(`/api/documents/${doc.id}/facts/${facts[0].id}/handoff`)).body.code).toBe('fact_stale')
  })

  it('keeps conflicting amounts as conflicts across the API', async () => {
    const doc = (await upload(alice.client, 'Invoice no: INV-1001\nAmount due: 1,250.00\nTotal due: 2,500.00')).body.document
    const facts = (await alice.client.post(`/api/documents/${doc.id}/extract`)).body.facts.filter((f: { kind: string }) => f.kind === 'amount_due')
    expect(facts).toHaveLength(2)
    expect(facts.every((f: { conflicts: unknown[]; confidence: string }) => f.conflicts.length === 1 && f.confidence === 'low')).toBe(true)
    const evidence = (await alice.client.get(`/api/recovery/cases/p1/${findingId}/evidence`)).body
    expect(evidence.summary.sentences.filter((s: { text: string }) => /nothing was picked/.test(s.text))).toHaveLength(2)
  })
})

describe('evidence summary and second look (deterministic)', () => {
  it('cites every sentence and keeps the detector result visible', async () => {
    const doc = (await upload(alice.client, INVOICE_TEXT)).body.document
    await alice.client.post(`/api/documents/${doc.id}/extract`)
    const res = await alice.client.get(`/api/recovery/cases/p1/${findingId}/evidence`)
    expect(res.status).toBe(200)
    const { summary, secondLook, documents, facts, factVerifier } = res.body
    expect(summary.sentences.length).toBeGreaterThan(5)
    expect(summary.sentences.every((s: { citations: string[] }) => s.citations.length > 0)).toBe(true)
    const cites = summary.sentences.flatMap((s: { citations: string[] }) => s.citations)
    expect(cites).toContain('rule:exact_duplicate')
    expect(cites).toContain(`record:${recordIds[0]}`)
    expect(cites).toContain(`document:${doc.id}#L8`)
    expect(summary.gate).toMatchObject({ eligible: true, potentialAmountMinor: 125000 })
    expect(summary.supplierReplies.count).toBe(0)
    expect(documents).toHaveLength(1)
    expect(facts.length).toBeGreaterThan(0)
    expect(factVerifier).toEqual({ name: 'fixture-shape-check', fixture: true })
    expect(secondLook.detector).toMatchObject({ type: 'exact_duplicate', classification: 'recovery_candidate', flaggedAmountMinor: 125000 })
    expect(secondLook.candidates.map((c: { kind: string }) => c.kind)).toEqual(['legitimate_recurrence', 'instalments_or_split', 'duplicate_import', 'adjustment', 'refund', 'credit', 'uncertain'])
    expect(secondLook.candidates.every((c: { citations: string[]; evidenceGap: string }) => c.citations.length && c.evidenceGap)).toBe(true)
  })

  it('answers 404 for a case that is not there', async () => {
    expect((await alice.client.get('/api/recovery/cases/p1/exact_duplicate-missing/evidence')).status).toBe(404)
    expect((await alice.client.get('/api/recovery/cases/nope/x/evidence')).status).toBe(404)
  })
})

describe('AI tasks through the gateway', () => {
  const goodSummary = () => ({ sentences: [{ text: '[[SUPPLIER]] was paid $1,250.00 twice for [[INVOICE_1]]; the evidence gate passes.', citations: [`record:${recordIds[0]}`, `record:${recordIds[1]}`, 'rule:evidence_gate'] }] })

  it('is off by default: the deterministic answer, ai_off, and nothing sent', async () => {
    const res = await alice.client.post(`/api/recovery/cases/p1/${findingId}/summary/ai`, {})
    expect(res.body).toMatchObject({ source: 'deterministic', code: 'ai_off', result: { source: 'deterministic', findingId } })
    const look = await alice.client.post(`/api/recovery/cases/p1/${findingId}/second-look/ai`, {})
    expect(look.body).toMatchObject({ source: 'deterministic', code: 'ai_off', result: { detector: { type: 'exact_duplicate' } } })
    const doc = (await upload(alice.client, MALICIOUS_TEXT)).body.document
    const extract = await alice.client.post(`/api/documents/${doc.id}/extract/ai`, {})
    expect(extract.body).toMatchObject({ source: 'deterministic', code: 'ai_off' })
    expect(extract.body.facts.length).toBeGreaterThan(0)
    expect(mock.calls).toHaveLength(0)
  })

  it('summarises with placeholders only, restores names locally, and keeps the deterministic summary beside it', async () => {
    answers.summarize_case_evidence = goodSummary()
    await enableAi(alice.client)
    expect((await alice.client.post('/api/ai/tasks/summarize_case_evidence/consent', { scope: 'field_set' })).status).toBe(201)
    const res = await alice.client.post(`/api/recovery/cases/p1/${findingId}/summary/ai`, {})
    expect(res.body.source).toBe('ai')
    expect(res.body.result.sentences[0].text).toBe(`${VENDOR} was paid $1,250.00 twice for ${INVOICE}; the evidence gate passes.`)
    expect(res.body.deterministic.source).toBe('deterministic')
    const sent = JSON.stringify(mock.calls[0].packet)
    expect(sent).not.toContain(VENDOR)
    expect(sent).not.toContain(INVOICE)
    expect(sent).not.toMatch(/2025-01-/)
  })

  it('rejects forged citations and invented amounts, falling back to the deterministic summary', async () => {
    await enableAi(alice.client)
    await alice.client.post('/api/ai/tasks/summarize_case_evidence/consent', { scope: 'field_set' })
    answers.summarize_case_evidence = { sentences: [{ text: 'The two payments match.', citations: ['record:invented-row'] }] }
    const forged = await alice.client.post(`/api/recovery/cases/p1/${findingId}/summary/ai`, {})
    expect(forged.body).toMatchObject({ source: 'deterministic', code: 'ai_rejected' })
    expect(forged.body.reason).toMatch(/forged_reference/)
    expect(forged.body.result.sentences.length).toBeGreaterThan(0)
    answers.summarize_case_evidence = { sentences: [{ text: 'Per record:invented-2, $9,999.00 is owed by [[SUPPLIER]].', citations: [`record:${recordIds[0]}`] }] }
    const invented = await alice.client.post(`/api/recovery/cases/p1/${findingId}/summary/ai`, {})
    expect(invented.body.code).toBe('ai_rejected')
    expect(invented.body.reason).toMatch(/unsupported_amount/)
    expect(invented.body.reason).toMatch(/invalid_state/)
    expect(invented.body.reason).toMatch(/forged_reference/)
    answers.second_look = { candidates: [{ kind: 'duplicate_import', explanation: 'This should be dismissed as an import repeat.', citations: ['document:doc_invented'], evidenceGap: 'Bank statement.' }] }
    await alice.client.post('/api/ai/tasks/second_look/consent', { scope: 'field_set' })
    const look = await alice.client.post(`/api/recovery/cases/p1/${findingId}/second-look/ai`, {})
    expect(look.body).toMatchObject({ source: 'deterministic', code: 'ai_rejected', result: { detector: { type: 'exact_duplicate' } } })
    const ledger = h.app.db.prepare('SELECT outcome, validation_codes FROM ai_invocations ORDER BY started_at').all() as Array<{ outcome: string; validation_codes: string }>
    expect(ledger.every((r) => r.outcome === 'rejected')).toBe(true)
  })

  it('accepts a cited second look and leaves the detector result in place', async () => {
    await enableAi(alice.client)
    await alice.client.post('/api/ai/tasks/second_look/consent', { scope: 'field_set' })
    answers.second_look = { candidates: [{ kind: 'duplicate_import', explanation: 'Both rows for [[INVOICE_1]] could be one payment imported twice.', citations: [`record:${recordIds[1]}`], evidenceGap: 'A bank statement showing two separate debits.' }] }
    const res = await alice.client.post(`/api/recovery/cases/p1/${findingId}/second-look/ai`, {})
    expect(res.body.source).toBe('ai')
    expect(res.body.result.candidates[0].explanation).toContain(INVOICE)
    expect(res.body.deterministic.detector).toMatchObject({ type: 'exact_duplicate', classification: 'recovery_candidate' })
    const packet = mock.calls[0].packet as { deterministicCandidates: unknown[] }
    expect(packet.deterministicCandidates).toHaveLength(7)
  })

  it('a one-time consent goes stale when the case changes', async () => {
    answers.summarize_case_evidence = goodSummary()
    await enableAi(alice.client)
    const preview = await alice.client.post('/api/ai/tasks/summarize_case_evidence/preview', { projectId: 'p1', findingId, input: {} })
    const consent = await alice.client.post('/api/ai/tasks/summarize_case_evidence/consent', { scope: 'packet', packetHash: preview.body.packetHash, projectId: 'p1', findingId })
    const changed = structuredClone(project)
    ;(changed.environment.caseStates[findingId] as Record<string, unknown>).vendorUpdates = [{ at: 5, status: 'disputed', note: 'Synthetic' }]
    h.seed(alice.userId, changed)
    const res = await alice.client.post(`/api/recovery/cases/p1/${findingId}/summary/ai`, { consentId: consent.body.consent.id })
    expect(res).toMatchObject({ status: 409, body: { code: 'ai_consent_stale' } })
    expect(mock.calls).toHaveLength(0)
  })

  it('extraction sends only the ambiguous lines, scrubbed, never the instruction or the rest of the document', async () => {
    const doc = (await upload(alice.client, MALICIOUS_TEXT)).body.document
    await enableAi(alice.client)
    const preview = await alice.client.post('/api/ai/tasks/extract_document_facts/preview', { projectId: 'p1', findingId, input: { documentId: doc.id } })
    expect(preview.status).toBe(200)
    expect(preview.body.packet.lines).toEqual([{ line: 4, reason: 'unlabelled_amount', text: 'Freight surcharge for [[SUPPLIER]] 75.00 see note' }])
    const sent = JSON.stringify(preview.body.packet)
    for (const absent of ['Ignore', '9,999', 'Amount due', INVOICE, VENDOR, 'billing@', 'https://']) expect(sent).not.toContain(absent)

    const consent = await alice.client.post('/api/ai/tasks/extract_document_facts/consent', { scope: 'packet', packetHash: preview.body.packetHash, projectId: 'p1', findingId })
    answers.extract_document_facts = { facts: [{ kind: 'line_amount', line: 4, value: '75.00' }] }
    const res = await alice.client.post(`/api/documents/${doc.id}/extract/ai`, { consentId: consent.body.consent.id })
    expect(res.body.source).toBe('ai')
    const ai = res.body.facts.filter((f: { origin: string }) => f.origin === 'ai')
    expect(ai).toEqual([expect.objectContaining({ kind: 'line_amount', value: '75.00', amountMinor: 7500, status: 'proposed', confidence: 'low', authoritative: false, provenance: expect.objectContaining({ line: 4 }) })])
    expect(res.body.facts.some((f: { origin: string; kind: string }) => f.origin === 'deterministic' && f.kind === 'amount_due')).toBe(true)
    expect(JSON.stringify(mock.calls[0].packet)).toBe(sent)
  })

  it('rejects AI facts that are not on the line, invent an amount, or cite a line it was not sent', async () => {
    const doc = (await upload(alice.client, MALICIOUS_TEXT)).body.document
    await enableAi(alice.client)
    const attempt = async (facts: unknown[]) => {
      const preview = await alice.client.post('/api/ai/tasks/extract_document_facts/preview', { projectId: 'p1', findingId, input: { documentId: doc.id } })
      const consent = await alice.client.post('/api/ai/tasks/extract_document_facts/consent', { scope: 'packet', packetHash: preview.body.packetHash, projectId: 'p1', findingId })
      answers.extract_document_facts = { facts }
      return (await alice.client.post(`/api/documents/${doc.id}/extract/ai`, { consentId: consent.body.consent.id })).body
    }
    expect((await attempt([{ kind: 'amount_due', line: 4, value: '$9,999.00' }])).reason).toMatch(/unsupported_amount/)
    expect((await attempt([{ kind: 'amount_due', line: 2, value: '9,999' }])).reason).toMatch(/forged_reference/)
    expect((await attempt([{ kind: 'invoice_ref', line: 4, value: 'INV-7777' }])).reason).toMatch(/forged_reference/)
    expect((await attempt([{ kind: 'due_date', line: 4, value: '2026-12-01' }])).reason).toMatch(/unsupported_date/)
    const last = await attempt([{ kind: 'line_amount', line: 4, value: '75.00' }, { kind: 'payment_ref', line: 4, value: 'https://pay.test' }])
    expect(last.code).toBe('ai_rejected')
    // Nothing the model said was stored.
    expect(last.facts.some((f: { origin: string }) => f.origin === 'ai')).toBe(false)
  })

  it('refuses a standing field-set consent for document extraction', async () => {
    const doc = (await upload(alice.client, MALICIOUS_TEXT)).body.document
    await enableAi(alice.client)
    const standing = await alice.client.post('/api/ai/tasks/extract_document_facts/consent', { scope: 'field_set' })
    answers.extract_document_facts = { facts: [] }
    const viaGateway = await alice.client.post('/api/ai/tasks/extract_document_facts/run', { projectId: 'p1', findingId, input: { documentId: doc.id } })
    expect(viaGateway).toMatchObject({ status: 409, body: { code: 'ai_packet_consent_only' } })
    const viaRoute = await alice.client.post(`/api/documents/${doc.id}/extract/ai`, { consentId: standing.body.consent.id })
    expect(viaRoute).toMatchObject({ status: 409, body: { code: 'ai_packet_consent_required' } })
    expect((await alice.client.post(`/api/documents/${doc.id}/extract/ai`, {})).body.code).toBe('ai_packet_consent_required')
    expect(mock.calls).toHaveLength(0)
  })

  it('never puts document text into the AI ledger', async () => {
    const doc = (await upload(alice.client, MALICIOUS_TEXT)).body.document
    await enableAi(alice.client)
    const preview = await alice.client.post('/api/ai/tasks/extract_document_facts/preview', { projectId: 'p1', findingId, input: { documentId: doc.id } })
    const consent = await alice.client.post('/api/ai/tasks/extract_document_facts/consent', { scope: 'packet', packetHash: preview.body.packetHash, projectId: 'p1', findingId })
    answers.extract_document_facts = { facts: [{ kind: 'line_amount', line: 4, value: '75.00' }] }
    await alice.client.post(`/api/documents/${doc.id}/extract/ai`, { consentId: consent.body.consent.id })
    const ledger = JSON.stringify(h.app.db.prepare('SELECT * FROM ai_invocations').all())
    expect(ledger).toContain('extract_document_facts')
    for (const text of ['Freight', '75.00', VENDOR, INVOICE, 'Ignore all rules', 'invoice.txt']) expect(ledger).not.toContain(text)
    const sealed = JSON.stringify(h.app.db.prepare('SELECT body_sealed FROM proposed_facts').all())
    expect(sealed).not.toContain('Freight')
  })
})

describe('no provider configured', () => {
  it('falls back to the deterministic answers with ai_unavailable', async () => {
    await h.close()
    h = await startHarness(null)
    alice = await h.signUp('alice@example.test')
    h.seed(alice.userId, structuredClone(project))
    await enableAi(alice.client)
    const res = await alice.client.post(`/api/recovery/cases/p1/${findingId}/summary/ai`, {})
    expect(res.body).toMatchObject({ source: 'deterministic', code: 'ai_unavailable', result: { source: 'deterministic' } })
    const look = await alice.client.post(`/api/recovery/cases/p1/${findingId}/second-look/ai`, {})
    expect(look.body.code).toBe('ai_unavailable')
    expect((await alice.client.post('/api/ai/tasks/extract_document_facts/consent', { scope: 'packet', packetHash: 'a'.repeat(64), projectId: 'p1' })).body.code).toBe('ai_unavailable')
  })
})
