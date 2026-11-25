/**
 * HTTP for J4 inbound supplier replies and reply classification.
 * Registered once in app.ts; this group answers only the paths it owns and
 * returns null for everything else.
 *
 * | Method & path | Who | Result |
 * |---|---|---|
 * | `POST /api/inbound/routes` `{ projectId, findingId }` | signed in, `case.propose` | `201 { address, routeId, generation }`; `503 inbound_unavailable` without a domain |
 * | `GET /api/inbound/routes?projectId&findingId` | `inbound.read` | `{ routes: [{ routeId, generation, createdAt, revokedAt }] }` (never the token) |
 * | `POST /api/inbound/routes/revoke` `{ projectId, findingId, routeId? }` | `case.propose` | `{ revoked }` |
 * | `POST /api/inbound/webhook/:provider` | HMAC signature, no session | `200 { ok, status, id? }` (webhook.ts) |
 * | `GET /api/inbound/messages?projectId&findingId` | `inbound.read` | `{ messages }`, sanitized text only |
 * | `GET /api/inbound/messages/:id` | `inbound.read` | `{ message }` |
 * | `POST /api/inbound/messages/:id/classify` `{ consentId? }` | `inbound.read` + `ai.invoke` | `{ source: 'ai', classification, invocationId, proposal }` or `{ source: 'deterministic', code, reason, classification, proposal }` |
 */
import { z } from 'zod'
import { HttpError, json, type Request } from '../http.ts'
import { requirePermission, systemContext } from '../tenant.ts'
import { storedCase } from '../recoveryFacts.ts'
import type { RouteGroup, WorkstreamDeps } from '../workstream.ts'
import type { ProposalView } from '../approvals.ts'
import { InboundStore, routeHandle, type MessageView } from './store.ts'
import { handleWebhook } from './webhook.ts'
import { createClassifyReplyTask, CLASSIFY_TASK } from './aiTask.ts'
import { vendorUpdateFor, CATEGORY_LABEL, type ReplyClassification } from './classify.ts'

const id = z.string().regex(/^[\w-]{1,100}$/)
const findingId = z.string().min(1).max(150)

async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON.')
  const parsed = schema.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'The request is malformed.', 'validation')
  return parsed.data
}

/** What the browser sees: sanitized text and metadata, never raw HTML or headers. */
const publicMessage = (m: MessageView) => ({
  id: m.id, projectId: m.projectId, findingId: m.findingId, generation: m.generation, provider: m.provider, status: m.status, reasons: m.reasons,
  receivedAt: m.receivedAt, authentication: m.authentication, from: m.from, fromName: m.fromName, subject: m.subject, text: m.text, reply: m.reply,
  attachments: m.attachments, classification: m.classification, proposalId: m.proposalId, proposalCode: m.proposalCode,
})

export function createInboundRoutes(deps: WorkstreamDeps): RouteGroup {
  const store = new InboundStore(deps.db, deps.sealer, deps.now)
  deps.ai.register(createClassifyReplyTask(store))

  return async (req) => {
    const path = req.url.pathname
    const method = req.method
    if (!path.startsWith('/api/inbound/')) return null

    const hook = path.match(/^\/api\/inbound\/webhook\/([a-z0-9_-]{1,40})$/)
    if (hook) {
      if (method !== 'POST') throw new HttpError(405, 'Use POST.')
      return handleWebhook(deps, store, req, hook[1])
    }

    const user = deps.requireUser(req)
    const tenant = deps.tenantFor(user)
    const caseQuery = () => {
      const parsed = z.object({ projectId: id, findingId }).safeParse({ projectId: req.url.searchParams.get('projectId'), findingId: req.url.searchParams.get('findingId') })
      if (!parsed.success) throw new HttpError(400, 'Name the project and case.', 'validation')
      return parsed.data
    }

    if (path === '/api/inbound/routes' && method === 'POST') {
      requirePermission(tenant, 'case.propose')
      const input = await body(req, z.object({ projectId: id, findingId }).strict())
      if (!deps.settings.inboundDomain) throw new HttpError(503, 'Reply addresses are not set up on this server.', 'inbound_unavailable')
      const c = storedCase(deps.projects.get(tenant.tenantId, input.projectId), input.findingId)
      if (!c) throw new HttpError(404, 'That case is not in this account.')
      if (c.mode === 'sample') throw new HttpError(403, 'Sample audits cannot contact suppliers.', 'sample_outreach_disabled')
      if (c.state.recoveryStage !== 'confirmed' && c.state.recoveryStage !== 'requested') throw new HttpError(409, 'Reply addresses are for cases being requested from the supplier.', 'inbound_case_not_open')
      const generation = c.state.activeRequestGeneration ?? 1
      const { token, hash } = store.issueRoute(tenant.tenantId, input.projectId, input.findingId, generation)
      return json(201, { address: `reply+${token}@${deps.settings.inboundDomain}`, routeId: routeHandle(hash), generation })
    }
    if (path === '/api/inbound/routes' && method === 'GET') {
      requirePermission(tenant, 'inbound.read')
      const q = caseQuery()
      return json(200, { routes: store.listRoutes(tenant.tenantId, q.projectId, q.findingId) })
    }
    if (path === '/api/inbound/routes/revoke' && method === 'POST') {
      requirePermission(tenant, 'case.propose')
      const input = await body(req, z.object({ projectId: id, findingId, routeId: z.string().regex(/^[a-f0-9]{16}$/).optional() }).strict())
      return json(200, { revoked: store.revokeRoutes(tenant.tenantId, input.projectId, input.findingId, input.routeId) })
    }

    if (path === '/api/inbound/messages' && method === 'GET') {
      requirePermission(tenant, 'inbound.read')
      const q = caseQuery()
      return json(200, { messages: store.list(tenant.tenantId, q).map(publicMessage) })
    }
    const m = path.match(/^\/api\/inbound\/messages\/([0-9a-f-]{36})(\/classify)?$/)
    if (m) {
      requirePermission(tenant, 'inbound.read')
      const message = store.get(tenant.tenantId, m[1])
      if (!message) throw new HttpError(404, 'That reply is not in this account.')
      if (!m[2] && method === 'GET') return json(200, { message: publicMessage(message) })
      if (m[2] && method === 'POST') {
        const input = await body(req, z.object({ consentId: z.uuid().nullable().optional() }).strict())
        if (message.status !== 'accepted') throw new HttpError(409, 'This reply is quarantined. Read it and record the supplier’s answer yourself.', 'inbound_quarantined')
        const outcome = await deps.ai.run<ReplyClassification>(tenant, CLASSIFY_TASK, { projectId: message.projectId, findingId: message.findingId, input: { messageId: message.id }, consentId: input.consentId ?? null, trigger: 'user' })
        if (outcome.source === 'deterministic') {
          const proposal = message.proposalId ? deps.approvals.get(tenant, message.proposalId) : null
          return json(200, { source: 'deterministic', code: outcome.code, reason: outcome.reason, classification: outcome.result, proposal })
        }
        const update = vendorUpdateFor(outcome.result, { messageId: message.id, receivedAt: message.receivedAt, origin: 'ai' })
        let proposal: ProposalView | null = null
        let proposalCode: string | null = update ? null : `no_proposal_${outcome.result.category}`
        if (update) {
          try {
            // Prepared by Reclaim, not by the person who asked, so that person can still be the one who approves it.
            proposal = deps.approvals.propose(systemContext(tenant.tenantId, 'ai'), {
              projectId: message.projectId, findingId: message.findingId, origin: 'ai',
              payload: { kind: 'case_command', command: 'vendor_update', input: update },
              reason: `An AI reading of a supplier reply (inbound message ${message.id}) suggests ${CATEGORY_LABEL[outcome.result.category]}. Read the reply first.`,
              sourceRefs: [`inbound:${message.id}`, `ai:${outcome.invocationId}`], dedupeKey: `inbound:${message.id}:ai:${outcome.invocationId}`,
            })
          } catch (err) {
            if (!(err instanceof HttpError)) throw err
            proposalCode = err.code ?? `http_${err.status}`
          }
        }
        return json(200, { source: 'ai', invocationId: outcome.invocationId, classification: outcome.result, proposal, proposalCode })
      }
    }
    return null
  }
}
