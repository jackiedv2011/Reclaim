/**
 * HTTP for the AI gateway (J1) and the approval queue (J2). Data APIs only:
 * Aditya owns every screen that uses them. See
 * docs/workstream-recovery-ai/contracts.md for the request and response shapes.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HttpError, json, type Request, type Response } from './http.ts'
import { requirePermission, type TenantContext } from './tenant.ts'
import type { RouteGroup, WorkstreamDeps } from './workstream.ts'
import type { ProposalPayload, ProposalView } from './approvals.ts'
import type { UserRow } from './db.ts'
import { DRAFT_TASK } from './aiGateway/tasks/draftRequest.ts'

const id = z.string().regex(/^[\w-]{1,100}$/)
const findingId = z.string().min(1).max(150)
const requireJson = (req: Request) => {
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON.')
}
async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  requireJson(req)
  const parsed = schema.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'The request is malformed.', 'validation')
  return parsed.data
}
const responseJson = (res: Response): Record<string, unknown> => {
  try {
    return typeof res.body === 'string' ? JSON.parse(res.body) as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

export interface RecoveryRoutes {
  route: RouteGroup
  /** The browser's original `/api/ai/draft` endpoint, now through the gateway. */
  draft(req: Request, user: UserRow, input: { projectId: string; findingId: string; amountRequested: number; method: 'refund' | 'credit' | 'offset'; userContext: string; sender: { businessName: string; senderName: string } }): Promise<Response>
  /** Runs an approved proposal; exported for jobs and tests. */
  execute(req: Request, user: UserRow, tenant: TenantContext, proposal: ProposalView): Promise<{ ok: boolean; code: string | null; detail?: unknown }>
}

export function createRecoveryRoutes(deps: WorkstreamDeps): RecoveryRoutes {
  const { ai, approvals } = deps

  async function runCommand(user: UserRow, tenant: TenantContext, p: ProposalView, type: string, input: unknown, commandId = p.commandId) {
    const expectedRevision = deps.projects.revision(tenant.tenantId, p.projectId)
    if (expectedRevision === null) throw new HttpError(404, 'That project is not in this account.')
    const result = deps.caseCommands.execute(user.id, tenant.actorLabel, p.projectId, { commandId, expectedRevision, findingId: p.findingId, type, input })
    deps.afterCaseCommand(user.id, result.project)
    return result
  }

  /** The Gmail route answered; record its receipt on the case the same way the app does. */
  async function sendThenRecord(req: Request, user: UserRow, tenant: TenantContext, p: ProposalView, path: string, payload: Record<string, unknown>, receiptCommand: 'email_sent' | 'followup_sent') {
    const res = await deps.dispatch(req, 'POST', path, payload)
    const data = responseJson(res)
    if (res.status !== 200) return { ok: false, code: typeof data.code === 'string' ? data.code : `http_${res.status}`, detail: data.message }
    const messageId = (data.send as { messageId?: string } | undefined)?.messageId
    if (!messageId) return { ok: false, code: 'gmail_send_uncertain', detail: 'Gmail did not return a message id.' }
    // Derived from the proposal id so a retry records the same receipt once.
    await runCommand(user, tenant, p, receiptCommand, { messageId }, randomUUIDFrom(p.commandId, receiptCommand))
    return { ok: true, code: null, detail: { messageId } }
  }

  async function execute(req: Request, user: UserRow, tenant: TenantContext, p: ProposalView) {
    const payload: ProposalPayload = p.payload
    try {
      switch (payload.kind) {
        case 'case_command':
          await runCommand(user, tenant, p, payload.command, payload.input)
          return { ok: true, code: null }
        case 'approve_request':
          await runCommand(user, tenant, p, 'approve', { package: payload.package, knownBeforeReclaim: payload.knownBeforeReclaim, knownBeforeNote: payload.knownBeforeNote })
          return { ok: true, code: null }
        case 'send_request':
          return await sendThenRecord(req, user, tenant, p, '/api/integrations/gmail/send', { projectId: p.projectId, findingId: p.findingId, to: payload.to, cc: payload.cc, subject: payload.subject, body: payload.body, amountRequested: payload.amountRequested, generation: payload.generation, ...(payload.evidenceAttachment ? { evidenceAttachment: payload.evidenceAttachment } : {}) }, 'email_sent')
        case 'send_follow_up':
          return await sendThenRecord(req, user, tenant, p, '/api/integrations/gmail/follow-up', { projectId: p.projectId, findingId: p.findingId, to: payload.to, cc: payload.cc, subject: payload.subject, body: payload.body, sequence: payload.sequence, generation: payload.generation }, 'followup_sent')
      }
    } catch (err) {
      if (err instanceof HttpError) return { ok: false, code: err.code ?? `http_${err.status}`, detail: err.message }
      throw err
    }
  }

  const ProposeSchema = z.object({ projectId: id, findingId, payload: z.unknown(), reason: z.string().trim().min(1).max(500), sourceRefs: z.array(z.string().max(200)).max(50).default([]) }).strict()

  async function route(req: Request): Promise<Response | null> {
    const path = req.url.pathname
    const method = req.method
    if (!path.startsWith('/api/ai/') && path !== '/api/approvals' && !path.startsWith('/api/approvals/')) return null
    const user = deps.requireUser(req)
    const tenant = deps.tenantFor(user)

    // ---------- AI policy, consent, preview, run, ledger ----------
    if (path === '/api/ai/policy' && method === 'GET') {
      requirePermission(tenant, 'case.read')
      return json(200, { policy: ai.policies.get(tenant.tenantId), consents: ai.policies.list(tenant.tenantId), tasks: ai.registry() })
    }
    if (path === '/api/ai/policy' && method === 'PUT') {
      requirePermission(tenant, 'ai.manage')
      const input = await body(req, z.object({ mode: z.enum(['off', 'on_demand']), acknowledged: z.literal(true) }).strict())
      return json(200, { policy: ai.policies.set(tenant, input.mode) })
    }
    if (path === '/api/ai/tasks' && method === 'GET') {
      requirePermission(tenant, 'case.read')
      return json(200, { tasks: ai.registry() })
    }
    if (path === '/api/ai/invocations' && method === 'GET') {
      requirePermission(tenant, 'ai.manage')
      return json(200, { invocations: ai.ledger.list(tenant.tenantId) })
    }
    const revokeMatch = path.match(/^\/api\/ai\/consents\/([\w-]{1,100})\/revoke$/)
    if (revokeMatch && method === 'POST') {
      requirePermission(tenant, 'ai.manage')
      if (!ai.policies.revoke(tenant, revokeMatch[1])) throw new HttpError(404, 'No active consent with that id.')
      return json(200, { ok: true })
    }
    const taskMatch = path.match(/^\/api\/ai\/tasks\/([a-z_]{1,60})\/(preview|consent|run)$/)
    if (taskMatch && method === 'POST') {
      const [, task, action] = taskMatch
      if (action === 'preview') {
        const input = await body(req, z.object({ projectId: id, findingId: findingId.nullable(), input: z.unknown() }).strict())
        return json(200, ai.preview(tenant, task, input.projectId, input.findingId, input.input))
      }
      if (action === 'consent') {
        const input = await body(req, z.object({ scope: z.enum(['packet', 'field_set']), packetHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), projectId: id.nullable().optional(), findingId: findingId.nullable().optional() }).strict())
        return json(201, { consent: ai.consent(tenant, task, input) })
      }
      const input = await body(req, z.object({ projectId: id, findingId: findingId.nullable(), input: z.unknown(), consentId: z.uuid().nullable().optional() }).strict())
      return json(200, await ai.run(tenant, task, { ...input, trigger: 'user' }))
    }

    // ---------- approvals queue ----------
    if (path === '/api/approvals' && method === 'GET') {
      const status = req.url.searchParams.get('status')
      const statuses = ['pending', 'executing', 'executed', 'failed', 'rejected', 'expired', 'stale', 'superseded']
      if (status !== null && !statuses.includes(status)) throw new HttpError(400, 'Unknown status.', 'validation')
      approvals.sweepExpired(tenant.tenantId)
      return json(200, { proposals: approvals.list(tenant, { status: (status ?? undefined) as never, projectId: req.url.searchParams.get('projectId') ?? undefined, findingId: req.url.searchParams.get('findingId') ?? undefined }) })
    }
    if (path === '/api/approvals' && method === 'POST') {
      const input = await body(req, ProposeSchema)
      // From the browser it is always a person's proposal, whatever the client claims.
      return json(201, { proposal: approvals.propose(tenant, { ...input, payload: input.payload as ProposalPayload, origin: 'user' }) })
    }
    const pMatch = path.match(/^\/api\/approvals\/([\w-]{1,100})(?:\/(approve|reject|edit|events))?$/)
    if (pMatch) {
      const [, pid, action] = pMatch
      if (!action && method === 'GET') return json(200, { proposal: approvals.get(tenant, pid) })
      if (action === 'events' && method === 'GET') return json(200, { events: approvals.events(tenant, pid) })
      if (action === 'reject' && method === 'POST') {
        const input = await body(req, z.object({ note: z.string().max(1000).nullable().default(null) }).strict())
        return json(200, { proposal: approvals.reject(tenant, pid, input.note) })
      }
      if (action === 'edit' && method === 'POST') {
        const input = await body(req, z.object({ payload: z.unknown() }).strict())
        return json(201, { proposal: approvals.edit(tenant, pid, input.payload as ProposalPayload) })
      }
      if (action === 'approve' && method === 'POST') {
        const input = await body(req, z.object({ payloadHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict())
        const claimed = approvals.claimForExecution(tenant, pid, input.payloadHash)
        const result = await execute(req, user, tenant, claimed)
        const proposal = approvals.finish(tenant, pid, result.ok, result.code)
        return json(result.ok ? 200 : 409, { proposal, result })
      }
    }
    throw new HttpError(404, 'Not found.')
  }

  async function draft(_req: Request, user: UserRow, input: Parameters<RecoveryRoutes['draft']>[2]): Promise<Response> {
    const tenant = deps.tenantFor(user)
    const outcome = await ai.run<{ subject: string; body: string }>(tenant, DRAFT_TASK, {
      projectId: input.projectId, findingId: input.findingId, trigger: 'user',
      input: { amountRequested: input.amountRequested, method: input.method, userContext: input.userContext, sender: input.sender },
    })
    if (outcome.source === 'ai') return json(200, { ...outcome.result, invocationId: outcome.invocationId })
    if (outcome.code === 'ai_off') throw new HttpError(403, 'External AI is off for this account. The generated letter is still there.', 'ai_off')
    if (outcome.code === 'ai_unavailable') throw new HttpError(503, 'AI drafting is not configured on this server.', 'ai_unavailable')
    if (outcome.code === 'ai_rejected' && /unsupported_(amount|currency)/.test(outcome.reason)) throw new HttpError(502, 'The AI draft mentioned an amount that is not in the records, so it was discarded. Use the generated letter or try again.', 'ai_unsupported_amount')
    if (outcome.code === 'ai_busy' || outcome.code === 'ai_timeout' || outcome.code === 'ai_budget') throw new HttpError(outcome.code === 'ai_budget' ? 429 : 502, `${outcome.reason} The generated letter is still there.`, outcome.code)
    throw new HttpError(502, `${outcome.reason} The generated letter is still there.`, outcome.code)
  }

  return { route, draft, execute }
}

/** A stable UUID derived from another, so a retried step reuses its command id. */
function randomUUIDFrom(base: string, salt: string): string {
  const hex = createHash('sha256').update(`${base}:${salt}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
