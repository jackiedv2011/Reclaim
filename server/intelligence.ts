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
import { IntelligenceAccessError, withExtraCoverage } from '../src/intelligence/envelope.ts'
import { createLegacyAuditSource, type LegacyAuditSource, type StoredAudit } from '../src/intelligence/adapters/legacyAudit.ts'
import { attentionQueue, ATTENTION_CATEGORIES, type AttentionCategory } from '../src/intelligence/attention.ts'
import { importCoverageSummary, IntelligenceQueryError, spendByCategory, spendByVendor, spendSummary, spendTrend, type SpendQuery } from '../src/intelligence/spend.ts'
import { recoveryByVendor, recoveryOverview } from '../src/intelligence/recoveryVisibility.ts'
import { vendorProfile, vendorProfiles } from '../src/intelligence/vendorProfiles.ts'
import { vendorBaselines } from '../src/intelligence/baselines.ts'
import { InMemoryFeedbackStore } from '../src/intelligence/memory.ts'
import { askAccount, AssistantRequestError } from '../src/intelligence/assistant.ts'
import { generateInsightsSync, InMemoryInsightStateStore, insightLookup, type InsightDeps } from '../src/intelligence/insights.ts'
import type { ReadModelEnvelope } from '../src/intelligence/contracts.ts'

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
  /** JSON body for POST routes (content type checked by the router). */
  body: () => Promise<unknown>
}

type Handler = (input: RouteInput) => unknown

const CURSOR = /^[\w.:-]{1,200}$/

/** Bounded, validated query parameters. Anything malformed is a 400, never a silent default. */
export function queryParam(query: URLSearchParams, name: string, pattern: RegExp, maxLength = 200): string | null {
  const value = query.get(name)
  if (value === null || value === '') return null
  if (value.length > maxLength || !pattern.test(value)) throw new HttpError(400, `Invalid ${name}.`, 'validation')
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

const DATE = /^\d{4}-\d{2}-\d{2}$/
const spendQuery = (query: URLSearchParams): SpendQuery => ({ from: queryParam(query, 'from', DATE), to: queryParam(query, 'to', DATE) })
const page = (query: URLSearchParams) => ({ limit: limitParam(query), cursor: cursorParam(query) })
/** Saved audits the adapter could not read are a coverage limit on every answer. */
const unreadable = (source: LegacyAuditSource) => ({ extraCoverageReasons: source.unreadableAuditIds.length ? ['unreadable_saved_audit'] : [] })

/** Vendor cursors carry an encoded name; allow the percent and separator characters, longer. */
const VENDOR_CURSOR = /^[\w.:%|~*'()!-]{1,800}$/
const VENDOR_KEY = /^[\w.:-]{1,200}$/

/**
 * Business memory has no persistent store yet (interface request S-7), so the
 * server reads profiles against an empty store and says so on the envelope.
 */
function withoutPersistedMemory<T>(env: ReadModelEnvelope<T>): ReadModelEnvelope<T> {
  return { ...env, warnings: [...env.warnings, { code: 'business_memory_not_persisted', detail: 'Corrections and context notes are not stored on the server yet, so none influence this result.' }] }
}

/**
 * Insight dismissals have no persistent store yet (S-7), so every request
 * starts from an empty one; a dismissal route is not exposed until it does.
 */
function insightDeps(source: LegacyAuditSource, returns: ReturnMatchPort): InsightDeps {
  return { financial: source.financial, cases: source.cases, returns, memory: new InMemoryFeedbackStore(), insightState: new InMemoryInsightStateStore() }
}

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
  { method: 'GET', pattern: /^spend\/summary$/, handler: ({ ctx, source, query, now }) => spendSummary(ctx, source.financial, spendQuery(query), now, unreadable(source)) },
  { method: 'GET', pattern: /^spend\/vendors$/, handler: ({ ctx, source, query, now }) => spendByVendor(ctx, source.financial, spendQuery(query), now, page(query), unreadable(source)) },
  { method: 'GET', pattern: /^spend\/categories$/, handler: ({ ctx, source, query, now }) => spendByCategory(ctx, source.financial, spendQuery(query), now, page(query), unreadable(source)) },
  { method: 'GET', pattern: /^spend\/trend$/, handler: ({ ctx, source, query, now }) => spendTrend(ctx, source.financial, spendQuery(query), now, { granularity: 'month' }, unreadable(source)) },
  { method: 'GET', pattern: /^coverage$/, handler: ({ ctx, source, now }) => importCoverageSummary(ctx, source.financial, now, unreadable(source)) },
  { method: 'GET', pattern: /^recovery$/, handler: ({ ctx, source, returns, now }) => recoveryOverview(ctx, source.cases, returns, now, unreadable(source)) },
  {
    method: 'GET',
    pattern: /^vendors$/,
    handler: ({ ctx, source, query, now }) => withoutPersistedMemory(vendorProfiles(ctx, source.financial, source.cases, new InMemoryFeedbackStore(), now, { limit: limitParam(query), cursor: queryParam(query, 'cursor', VENDOR_CURSOR, 800) })),
  },
  {
    method: 'GET',
    pattern: /^vendors\/([^/]+)$/,
    handler: ({ ctx, source, now, param }) => {
      if (!param || !VENDOR_KEY.test(param)) throw new HttpError(400, 'Invalid vendor.', 'validation')
      return withoutPersistedMemory(vendorProfile(ctx, source.financial, source.cases, new InMemoryFeedbackStore(), param, now))
    },
  },
  {
    method: 'GET',
    pattern: /^insights$/,
    handler: ({ ctx, source, returns, query, now }) =>
      withoutPersistedMemory(generateInsightsSync(ctx, insightDeps(source, returns), now, { limit: limitParam(query), cursor: cursorParam(query), unreadableAuditIds: source.unreadableAuditIds })),
  },
  { method: 'GET', pattern: /^baselines$/, handler: ({ ctx, source, now }) => vendorBaselines(ctx, source.financial, now) },
  {
    method: 'POST',
    pattern: /^assistant\/ask$/,
    handler: async ({ ctx, source, returns, now, body }) => {
      const input = (await body()) as { question?: unknown; subject?: unknown } | null
      if (!input || typeof input !== 'object') throw new HttpError(400, 'Send a question.', 'validation')
      const deps = insightDeps(source, returns)
      return askAccount(ctx, { ...deps, insightLookup: insightLookup(deps, now, { unreadableAuditIds: source.unreadableAuditIds }) }, input.question, now, { subject: input.subject, ...unreadable(source), sourceUpdatedAt: source.newestUpdateAt })
    },
  },
  { method: 'GET', pattern: /^recovery\/vendors$/, handler: ({ ctx, source, returns, query, now }) => recoveryByVendor(ctx, source.cases, returns, now, page(query), unreadable(source)) },
]

export function tenantContextFor(user: { id: string }): TenantContext {
  return { tenantId: user.id, actorId: user.id, permissions: SINGLE_USER_PERMISSIONS, source: 'single_user_session' }
}

export function createIntelligenceRoutes(deps: IntelligenceDeps) {
  const now = deps.now ?? Date.now
  const returns = deps.returns ?? NO_RETURN_MATCHING

  /** Only this tenant's audits; the adapter refuses any other tenant's context as a second check. */
  function sourceFor(ctx: TenantContext): LegacyAuditSource {
    // listAll leaves out audits that cannot be opened and names them; they become a coverage limit.
    const { projects: stored, unreadable: failed } = deps.projects.listAll(ctx.tenantId)
    const audits = stored as unknown as StoredAudit[]
    const revisions = Object.fromEntries(audits.map((a) => [a.id, deps.projects.revision(ctx.tenantId, a.id)]))
    return createLegacyAuditSource(ctx.tenantId, audits, { revisions, unreadableAuditIds: failed.map((u) => u.id) })
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
    const rawParam = rest.match(match.pattern)?.[1] ?? null
    let param: string | null = null
    try {
      param = rawParam === null ? null : decodeURIComponent(rawParam)
    } catch {
      throw new HttpError(400, 'Invalid path.', 'validation')
    }
    if (req.method === 'POST' && !(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'Send JSON.')
    const readBody = async () => {
      const text = await req.text()
      if (text.length > 4000) throw new HttpError(413, 'Request too large.', 'validation')
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new HttpError(400, 'Malformed JSON.', 'validation')
      }
    }
    try {
      const source = sourceFor(ctx)
      const body = await match.handler({ ctx, source, returns, query: req.url.searchParams, now: now(), param, body: readBody })
      // Every read model learns about unreadable saved audits, including the ones that cannot see them.
      const reasons = unreadable(source).extraCoverageReasons
      const isEnvelope = (b: unknown): b is ReadModelEnvelope<unknown> => typeof b === 'object' && b !== null && Array.isArray((b as { coverage?: unknown }).coverage) && 'contractVersion' in b
      return json(200, isEnvelope(body) ? withExtraCoverage(body, reasons) : body)
    } catch (error) {
      if (error instanceof IntelligenceAccessError) throw new HttpError(error.code === 'forbidden' ? 403 : 404, error.code === 'forbidden' ? 'Not permitted.' : 'Not found.', error.code)
      if (error instanceof AssistantRequestError) throw new HttpError(error.code === 'not_found' ? 404 : 400, error.message, error.code)
      if (error instanceof IntelligenceQueryError || error instanceof RangeError) throw new HttpError(400, error.message, 'validation')
      throw error
    }
  }

  return { route }
}
