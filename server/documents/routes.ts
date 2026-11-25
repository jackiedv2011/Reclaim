/**
 * HTTP for J5 document intake, extraction and evidence intelligence.
 * Registered once in app.ts; this group answers only the paths it owns and
 * returns null for everything else.
 *
 * Paths:
 *   POST   /api/documents                                   intake (documents.write)
 *   GET    /api/documents?projectId=&findingId=             list (case.read)
 *   DELETE /api/documents/:id                               delete with its facts (documents.write)
 *   POST   /api/documents/:id/extract                       deterministic reading (documents.write)
 *   POST   /api/documents/:id/extract/ai        { consentId }   AI reading of ambiguous lines (documents.write + ai.invoke)
 *   POST   /api/documents/:id/facts/:factId/handoff         hand one fact to the FactVerifier (documents.write)
 *   GET    /api/recovery/cases/:projectId/:findingId/evidence             summary + second look + documents + facts (case.read)
 *   POST   /api/recovery/cases/:projectId/:findingId/summary/ai     { consentId? }
 *   POST   /api/recovery/cases/:projectId/:findingId/second-look/ai { consentId? }
 *
 * Never: fetching a link in a document, executing anything, forwarding a
 * document, or writing an extracted value into a case, its evidence or the ledger.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HttpError, json, type Request, type Response } from '../http.ts'
import { requirePermission, type TenantContext } from '../tenant.ts'
import { storedCase } from '../recoveryFacts.ts'
import type { RouteGroup, WorkstreamDeps } from '../workstream.ts'
import { cleanFilename, decodeBase64, sniffDocument, MAX_DOCUMENT_BYTES } from './sniff.ts'
import { DocumentStore, MAX_DOCUMENTS_PER_PROJECT, type DocumentView } from './store.ts'
import { DOCUMENT_KINDS, fixtureFactVerifier, type FactVerifier, type ProposedFact } from './facts.ts'
import { extractDocument, type ExtractionResult } from './extract.ts'
import { buildEvidenceSummary } from './summary.ts'
import { buildSecondLook } from './secondLook.ts'
import { createDocumentTasks, EXTRACT_TASK, SECOND_LOOK_TASK, SUMMARY_TASK } from './aiTasks.ts'

const projectIdSchema = z.string().regex(/^[\w-]{1,100}$/)
const findingIdSchema = z.string().min(1).max(150).regex(/^[^/\s]+$/)
const IntakeSchema = z.object({
  projectId: projectIdSchema,
  findingId: findingIdSchema.nullable().optional(),
  kind: z.enum(DOCUMENT_KINDS),
  filename: z.string().min(1).max(500),
  // Base64 of 2 MB is about 2.8 MB; anything longer is refused before decoding.
  contentBase64: z.string().min(1).max(Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 1024),
}).strict()
const ConsentBody = z.object({ consentId: z.uuid().nullable().optional() }).strict()

const requireJson = (req: Request) => {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON.')
}
async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  requireJson(req)
  const parsed = schema.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'The request is malformed.', 'validation')
  return parsed.data
}
const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    throw new HttpError(400, 'The request is malformed.', 'validation')
  }
}

export interface DocumentRouteOptions {
  /** Sid's verifier when it exists. Defaults to the FIXTURE shape check. */
  verifier?: FactVerifier
}

export function createDocumentRoutes(deps: WorkstreamDeps, options: DocumentRouteOptions = {}): RouteGroup {
  const store = new DocumentStore({ db: deps.db, sealer: deps.sealer, now: deps.now })
  const verifier = options.verifier ?? fixtureFactVerifier
  const tasks = createDocumentTasks({ store, policies: deps.ai.policies, revision: (tenantId, projectId) => deps.projects.revision(tenantId, projectId) })
  deps.ai.register(tasks.summaryTask).register(tasks.secondLookTask).register(tasks.extractTask)

  /** The tenant's saved project and, when named, the case in it. 404 for anything not on this account. */
  function caseScope(tenant: TenantContext, projectId: string, findingId: string | null) {
    const project = deps.projects.get(tenant.tenantId, projectId)
    const revision = deps.projects.revision(tenant.tenantId, projectId)
    if (!project || revision === null) throw new HttpError(404, 'That project is not in this account.', 'not_found')
    const c = findingId ? storedCase(project, findingId) : null
    if (findingId && !c) throw new HttpError(404, 'That case is not in this account.', 'not_found')
    return { project, revision, case: c }
  }

  function documentFor(tenant: TenantContext, id: string): DocumentView {
    const doc = store.get(tenant.tenantId, id)
    if (!doc) throw new HttpError(404, 'That document is not in this account.', 'not_found')
    return doc
  }

  /** The case fingerprint a fact was read against, so a later hand-off can tell the case changed. */
  function fingerprintFor(tenant: TenantContext, doc: DocumentView): string | null {
    if (!doc.findingId) return null
    return storedCase(deps.projects.get(tenant.tenantId, doc.projectId), doc.findingId)?.fingerprint ?? null
  }

  function persistDeterministic(tenant: TenantContext, doc: DocumentView, result: ExtractionResult) {
    const facts = store.addFacts(tenant.tenantId, doc, result.facts, { caseFingerprint: fingerprintFor(tenant, doc) })
    store.markExtracted(tenant.tenantId, doc.id)
    return facts
  }

  function readable(tenant: TenantContext, doc: DocumentView): { text: string; format: 'text' | 'csv' } {
    if (doc.format === 'pdf') throw new HttpError(422, 'This PDF is stored but cannot be read: Reclaim has no PDF or OCR reader. Enter the figures yourself or upload a text or CSV export.', 'unsupported_format')
    return { text: store.text(tenant.tenantId, doc.id)!, format: doc.format }
  }

  async function route(req: Request): Promise<Response | null> {
    const path = req.url.pathname
    const method = req.method
    const isDocs = path === '/api/documents' || path.startsWith('/api/documents/')
    const caseMatch = path.match(/^\/api\/recovery\/cases\/([^/]+)\/([^/]+)\/(evidence|summary\/ai|second-look\/ai)$/)
    if (!isDocs && !caseMatch) return null
    const user = deps.requireUser(req)
    const tenant = deps.tenantFor(user)
    store.sweepExpired()

    // ---------- intake ----------
    if (path === '/api/documents' && method === 'POST') {
      requirePermission(tenant, 'documents.write')
      const input = await body(req, IntakeSchema)
      const findingId = input.findingId ?? null
      caseScope(tenant, input.projectId, findingId)
      const decoded = decodeBase64(input.contentBase64)
      if (!decoded.ok) throw decoded.code === 'too_large' ? new HttpError(413, 'Documents are limited to 2 MB.', 'too_large') : new HttpError(400, 'The file content is not valid base64.', 'malformed')
      const sniffed = sniffDocument(decoded.bytes)
      if (!sniffed.ok) throw new HttpError(sniffed.code === 'too_large' ? 413 : sniffed.code === 'empty' ? 400 : 415, sniffed.reason, `document_${sniffed.code}`)
      const sha = createHash('sha256').update(decoded.bytes).digest('hex')
      const existing = store.findByHash(tenant.tenantId, sha)
      if (existing) return json(200, { document: existing, duplicate: true })
      if (store.countForProject(tenant.tenantId, input.projectId) >= MAX_DOCUMENTS_PER_PROJECT) throw new HttpError(409, `An audit can hold at most ${MAX_DOCUMENTS_PER_PROJECT} documents.`, 'too_many_documents')
      const doc = store.create(tenant.tenantId, {
        projectId: input.projectId, findingId, kind: input.kind, format: sniffed.format, sha256: sha, size: decoded.bytes.length,
        filename: cleanFilename(input.filename), content: sniffed.format === 'pdf' ? { base64: decoded.bytes.toString('base64') } : { text: sniffed.text },
        createdBy: tenant.actorLabel,
      })
      return json(201, { document: doc, duplicate: false })
    }

    if (path === '/api/documents' && method === 'GET') {
      requirePermission(tenant, 'case.read')
      const projectId = projectIdSchema.safeParse(req.url.searchParams.get('projectId'))
      const rawFinding = req.url.searchParams.get('findingId')
      const findingId = rawFinding === null ? null : findingIdSchema.safeParse(rawFinding)
      if (!projectId.success || (findingId && !findingId.success)) throw new HttpError(400, 'Name the project (and optionally the case).', 'validation')
      const { project } = caseScope(tenant, projectId.data, null)
      const docs = store.list(tenant.tenantId, projectId.data, findingId?.data ?? null)
      return json(200, { documents: docs.map((d) => ({ ...d, caseMissing: d.findingId !== null && !storedCase(project, d.findingId), facts: store.factsForDocument(tenant.tenantId, d.id).length })) })
    }

    const docMatch = path.match(/^\/api\/documents\/(doc_[\w-]{1,100})(?:\/(extract|extract\/ai|facts\/(fact_[a-f0-9]{32})\/handoff))?$/)
    if (docMatch) {
      const [, docId, action, factId] = docMatch
      if (!action && method === 'GET') {
        requirePermission(tenant, 'case.read')
        const doc = documentFor(tenant, docId)
        return json(200, { document: doc, facts: store.factsForDocument(tenant.tenantId, doc.id) })
      }
      if (!action && method === 'DELETE') {
        requirePermission(tenant, 'documents.write')
        documentFor(tenant, docId)
        store.delete(tenant.tenantId, docId)
        return json(200, { ok: true })
      }
      if (action === 'extract' && method === 'POST') {
        requirePermission(tenant, 'documents.write')
        const doc = documentFor(tenant, docId)
        const { text, format } = readable(tenant, doc)
        const result = extractDocument({ documentId: doc.id, kind: doc.kind, text, format })
        const facts = persistDeterministic(tenant, doc, result)
        return json(200, { extraction: { ...result, facts: undefined }, facts, authoritative: false })
      }
      if (action === 'extract/ai' && method === 'POST') {
        requirePermission(tenant, 'documents.write')
        const input = await body(req, ConsentBody)
        const doc = documentFor(tenant, docId)
        readable(tenant, doc)
        // Packet consent only: a standing field-set consent may not cover a document's text.
        if (deps.ai.policies.get(tenant.tenantId).mode !== 'off') {
          const consent = input.consentId ? deps.ai.policies.consent(tenant.tenantId, input.consentId) : undefined
          if (!consent || consent.scope !== 'packet' || consent.task !== EXTRACT_TASK) throw new HttpError(409, 'Preview exactly which lines would be sent and give a one-time consent for this document first.', 'ai_packet_consent_required')
        }
        const outcome = await deps.ai.run<{ documentId: string; facts: ProposedFact[] } | ExtractionResult>(tenant, EXTRACT_TASK, { projectId: doc.projectId, findingId: doc.findingId, input: { documentId: doc.id }, consentId: input.consentId ?? null, trigger: 'user' })
        // The deterministic reading always stands; AI readings are added beside it, never over it.
        const deterministic = tasks.deterministicExtraction({ tenant, projectId: doc.projectId, findingId: doc.findingId, project: deps.projects.get(tenant.tenantId, doc.projectId) }, doc.id)
        if (deterministic) persistDeterministic(tenant, doc, deterministic)
        if (outcome.source === 'ai') store.addFacts(tenant.tenantId, doc, (outcome.result as { facts: ProposedFact[] }).facts, { caseFingerprint: fingerprintFor(tenant, doc), invocationId: outcome.invocationId })
        const facts = store.factsForDocument(tenant.tenantId, doc.id)
        return json(200, outcome.source === 'ai'
          ? { source: 'ai', invocationId: outcome.invocationId, facts, authoritative: false }
          : { source: 'deterministic', code: outcome.code, reason: outcome.reason, invocationId: outcome.invocationId ?? null, facts, authoritative: false })
      }
      if (factId && method === 'POST') {
        requirePermission(tenant, 'documents.write')
        const doc = documentFor(tenant, docId)
        const fact = store.fact(tenant.tenantId, doc.id, factId)
        if (!fact) throw new HttpError(404, 'That fact is not on this document.', 'not_found')
        if (fact.status !== 'proposed') throw new HttpError(409, 'This fact was already handed off.', 'fact_not_proposed')
        const recorded = store.factCaseFingerprint(tenant.tenantId, fact.id)
        if (recorded !== null && recorded !== fingerprintFor(tenant, doc)) throw new HttpError(409, 'The case changed after this document was read. Read it again before handing facts off.', 'fact_stale')
        const [verdict] = (await verifier.verifyProposedFacts(tenant, doc.projectId, [fact])).filter((v) => v.factId === fact.id)
        if (!verdict) throw new HttpError(502, 'The verifier did not answer for this fact.', 'verifier_no_answer')
        const updated = store.recordVerification(tenant.tenantId, doc.id, fact.id, { verifier: verifier.name, fixture: verifier.fixture, outcome: verdict.outcome, reason: verdict.reason })
        return json(200, { fact: updated, verification: { ...verdict, verifier: verifier.name, fixture: verifier.fixture } })
      }
    }

    // ---------- case evidence (read-only) and its AI tasks ----------
    if (caseMatch) {
      const projectId = projectIdSchema.safeParse(decode(caseMatch[1]))
      const findingId = findingIdSchema.safeParse(decode(caseMatch[2]))
      if (!projectId.success || !findingId.success) throw new HttpError(400, 'The request is malformed.', 'validation')
      const what = caseMatch[3]
      if (what === 'evidence' && method === 'GET') {
        requirePermission(tenant, 'case.read')
        const { project, revision } = caseScope(tenant, projectId.data, findingId.data)
        const documents = store.list(tenant.tenantId, projectId.data, findingId.data)
        const facts = store.factsForCase(tenant.tenantId, projectId.data, findingId.data)
        return json(200, {
          summary: buildEvidenceSummary({ project, projectId: projectId.data, findingId: findingId.data, revision, documents, facts }),
          secondLook: buildSecondLook({ project, projectId: projectId.data, findingId: findingId.data, revision, facts }),
          documents, facts, factVerifier: { name: verifier.name, fixture: verifier.fixture },
        })
      }
      if ((what === 'summary/ai' || what === 'second-look/ai') && method === 'POST') {
        const input = await body(req, ConsentBody)
        caseScope(tenant, projectId.data, findingId.data)
        const task = what === 'summary/ai' ? SUMMARY_TASK : SECOND_LOOK_TASK
        const outcome = await deps.ai.run(tenant, task, { projectId: projectId.data, findingId: findingId.data, input: {}, consentId: input.consentId ?? null, trigger: 'user' })
        if (outcome.source === 'deterministic') return json(200, outcome)
        // The deterministic answer (and the detector's own result) stays beside the AI text, never replaced by it.
        const { project, revision } = caseScope(tenant, projectId.data, findingId.data)
        const facts = store.factsForCase(tenant.tenantId, projectId.data, findingId.data)
        const deterministic = task === SUMMARY_TASK
          ? buildEvidenceSummary({ project, projectId: projectId.data, findingId: findingId.data, revision, documents: store.list(tenant.tenantId, projectId.data, findingId.data), facts })
          : buildSecondLook({ project, projectId: projectId.data, findingId: findingId.data, revision, facts })
        return json(200, { ...outcome, deterministic, notice: 'AI text for a person to read. It cites only records in the packet and changes nothing.' })
      }
    }
    if (isDocs || caseMatch) throw new HttpError(404, 'Not found.')
    return null
  }

  return route
}
