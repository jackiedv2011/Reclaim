/**
 * Product-intelligence read API (CPO workstream). Read-only, off by default.
 *
 * Every route derives the tenant from the session cookie (never from the
 * request), loads only that tenant's saved audits, and answers through the
 * pure read models in src/intelligence. Nothing here writes a record, a case
 * or a memory entry, sends anything, or calls an external model.
 *
 * Wiring: server/app.ts calls `route(req)` when `enabled` is true
 * (RECLAIM_INTELLIGENCE_API=1). That wiring is a shared-entrypoint change for
 * the CTO to review (docs/product-intelligence/interface-requests.md S-9).
 */
import { HttpError, json, type Request, type Response } from './http.ts'
import type { ProjectStore } from './projectStore.ts'
import { SINGLE_USER_PERMISSIONS, NO_RETURN_MATCHING, type ReturnMatchPort, type TenantContext } from '../src/intelligence/contracts.ts'
import { IntelligenceAccessError } from '../src/intelligence/envelope.ts'
import { createLegacyAuditSource, type LegacyAuditSource, type StoredAudit } from '../src/intelligence/adapters/legacyAudit.ts'
import { attentionQueue, ATTENTION_CATEGORIES, type AttentionCategory } from '../src/intelligence/attention.ts'

export const INTELLIGENCE_PREFIX = '/api/intelligence/'

export interface IntelligenceDeps {
  projects: ProjectStore
  userFor: (req: Request) => { id: string } | null
  /** Per-user read budget; returns false when exhausted. */
  allowRead: (userId: string) => boolean
  now?: () => number
  returns?: ReturnMatchPort
}

export interface RouteInput {
  ctx: TenantContext
  source: LegacyAuditSource
  returns: ReturnMatchPort
  query: URLSearchParams
  now: number
  /** Captured route parameter, e.g. a vendor key. */
  param: string | null
}

type Handler = (input: RouteInput) => unknown

const CURSOR = /^[\w.:-]{1,200}$/

/** Bounded, validated query parameters. Anything malformed is a 400, never a silent default. */
export function queryParam(query: URLSearchParams, name: string, pattern: RegExp): string | null {
  const value = query.get(name)
  if (value === null || value === '') return null
  if (value.length > 200 || !pattern.test(value)) throw new HttpError(400, `Invalid ${name}.`, 'validation')
  return value
}

export function limitParam(query: URLSearchParams, max = 100): number | undefined {
  const raw = queryParam(query, 'limit', /^\d{1,4}$/)
  if (raw === null) return undefined
  const n = Number(raw)
  if (n < 1 || n > max) throw new HttpError(400, `limit must be between 1 and ${max}.`, 'validation')
  return n
}

export const cursorParam = (query: URLSearchParams) => queryParam(query, 'cursor', CURSOR)

const ROUTES: Array<{ method: 'GET' | 'POST'; pattern: RegExp; handler: Handler }> = [
  {
    method: 'GET',
    pattern: /^attention$/,
    handler: ({ ctx, source, query, now }) => {
      const include = query.get('include')
      const categories = include ? include.split(',') : undefined
      if (categories && !categories.every((c) => (ATTENTION_CATEGORIES as readonly string[]).includes(c))) throw new HttpError(400, 'Invalid include.', 'validation')
      return attentionQueue(ctx, source.cases, now, { limit: limitParam(query, 200), cursor: cursorParam(query), include: categories as AttentionCategory[] | undefined })
    },
  },
]

export function tenantContextFor(user: { id: string }): TenantContext {
  return { tenantId: user.id, actorId: user.id, permissions: SINGLE_USER_PERMISSIONS, source: 'single_user_session' }
}

export function createIntelligenceRoutes(deps: IntelligenceDeps) {
  const now = deps.now ?? Date.now
  const returns = deps.returns ?? NO_RETURN_MATCHING

  /** Only this tenant's audits; the adapter refuses any other tenant's context as a second check. */
  function sourceFor(ctx: TenantContext): LegacyAuditSource {
    const audits = deps.projects.list(ctx.tenantId) as unknown as StoredAudit[]
    const revisions = Object.fromEntries(audits.map((a) => [a.id, deps.projects.revision(ctx.tenantId, a.id)]))
    return createLegacyAuditSource(ctx.tenantId, audits, { revisions })
  }

  async function route(req: Request): Promise<Response | null> {
    const path = req.url.pathname
    if (!path.startsWith(INTELLIGENCE_PREFIX)) return null
    const rest = path.slice(INTELLIGENCE_PREFIX.length)
    const match = ROUTES.find((r) => r.method === req.method && r.pattern.test(rest))
    if (!match) throw new HttpError(404, 'Not found.')
    const user = deps.userFor(req)
    if (!user) throw new HttpError(401, 'You need to log in.', 'unauthenticated')
    if (!deps.allowRead(user.id)) throw new HttpError(429, 'Too many requests. Try again shortly.', 'rate_limited')
    const ctx = tenantContextFor(user)
    const param = rest.match(match.pattern)?.[1] ?? null
    try {
      const body = await match.handler({ ctx, source: sourceFor(ctx), returns, query: req.url.searchParams, now: now(), param: param === null ? null : decodeURIComponent(param) })
      return json(200, body)
    } catch (error) {
      if (error instanceof IntelligenceAccessError) throw new HttpError(error.code === 'forbidden' ? 403 : 404, error.code === 'forbidden' ? 'Not permitted.' : 'Not found.', error.code)
      if (error instanceof RangeError || (error instanceof Error && error.name === 'IntelligenceValidationError')) throw new HttpError(400, error.message, 'validation')
      throw error
    }
  }

  return { route }
}
