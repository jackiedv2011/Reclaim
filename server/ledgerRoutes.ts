/**
 * HTTP surface for the server ledger (server/ledger.ts). Off unless
 * RECLAIM_SERVER_LEDGER=true: with the flag off every path answers 404, so
 * the existing browser-ledger product is unchanged.
 *
 * The tenant is always derived on the server from the session and membership
 * table; `?tenant=` only selects among organisations the caller belongs to.
 * A request body never carries records, findings or amounts the server trusts:
 * POST /api/ledger/imports reads `csv` (and an optional label) and ignores
 * every other field.
 */
import type { DatabaseSync } from 'node:sqlite'
import { HttpError, json, type Request, type Response } from './http.ts'
import { TenantAccessError, tenantContextFor } from './tenancy.ts'
import { LedgerError, confirmImportMapping, deriveFindings, proposeImportMapping, getSourceRecords, importCsv, listImports, listSourceRecords, vendorPeriodAggregates, type LedgerKeys } from './ledger.ts'

export interface LedgerRouteDeps {
  db: DatabaseSync
  keys: LedgerKeys
  enabled: boolean
  requireUser(req: Request): { id: string }
  requireJson(req: Request): void
  /** Throws 429 when the caller has imported too often. */
  limitImport(userId: string): void
}

const PREFIX = '/api/ledger/'

export function createLedgerRoutes(deps: LedgerRouteDeps) {
  const { db, keys } = deps

  const translate = (err: unknown): never => {
    if (err instanceof TenantAccessError) throw new HttpError(err.status, err.message, err.code)
    if (err instanceof LedgerError) {
      // Mapping issues travel as field -> issue code (header/field names only, never row values).
      const fields: Record<string, string> = {}
      for (const issue of err.issues) for (const field of issue.fields.length > 0 ? issue.fields : [issue.code]) fields[field] ??= issue.code
      throw new HttpError(err.status, err.message, err.code, err.issues.length > 0 ? fields : undefined)
    }
    throw err
  }

  const context = (req: Request) => {
    const user = deps.requireUser(req)
    return { user, ctx: tenantContextFor(db, user.id, req.url.searchParams.get('tenant')) }
  }

  async function handle(req: Request): Promise<Response | null> {
    const path = req.url.pathname
    const method = req.method
    const q = req.url.searchParams

    if (path === '/api/ledger/imports' && method === 'POST') {
      deps.requireJson(req)
      const { user, ctx } = context(req)
      deps.limitImport(user.id)
      const body = await req.json<Record<string, unknown>>().catch(() => null)
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send the CSV file as text.', 'csv_required')
      if (typeof body.csv !== 'string') throw new HttpError(400, 'Send the CSV file as text.', 'csv_required')
      const result = importCsv(db, keys, ctx, { csv: body.csv, sourceLabel: typeof body.sourceLabel === 'string' ? body.sourceLabel : null })
      return json(result.duplicateFile ? 200 : 201, result)
    }
    if (path === '/api/ledger/mappings/proposals' && method === 'POST') {
      deps.requireJson(req)
      const { ctx } = context(req)
      const body = await req.json<Record<string, unknown>>().catch(() => null)
      return json(200, { tenantId: ctx.tenantId, ...proposeImportMapping(db, ctx, body?.csv) })
    }
    if (path === '/api/ledger/mappings' && method === 'POST') {
      deps.requireJson(req)
      const { ctx } = context(req)
      const body = await req.json<unknown>().catch(() => null)
      return json(201, { tenantId: ctx.tenantId, mapping: confirmImportMapping(db, ctx, body) })
    }
    if (path === '/api/ledger/imports' && method === 'GET') {
      const { ctx } = context(req)
      return json(200, { tenantId: ctx.tenantId, imports: listImports(db, keys, ctx) })
    }
    if (path === '/api/ledger/records' && method === 'GET') {
      const { ctx } = context(req)
      const ids = q.get('ids')
      if (ids !== null) return json(200, { tenantId: ctx.tenantId, ...getSourceRecords(db, keys, ctx, ids.split(',').map((s) => s.trim()).filter(Boolean)) })
      const limit = q.get('limit')
      return json(200, { tenantId: ctx.tenantId, ...listSourceRecords(db, keys, ctx, { cursor: q.get('cursor'), limit: limit === null ? null : Number(limit), from: q.get('from'), to: q.get('to'), currency: q.get('currency') }) })
    }
    if (path === '/api/ledger/findings' && method === 'GET') {
      const { ctx } = context(req)
      return json(200, { tenantId: ctx.tenantId, ...deriveFindings(db, keys, ctx) })
    }
    if (path === '/api/ledger/aggregates' && method === 'GET') {
      const { ctx } = context(req)
      return json(200, { tenantId: ctx.tenantId, ...vendorPeriodAggregates(db, keys, ctx, { from: q.get('from'), to: q.get('to') }) })
    }
    return null
  }

  return {
    async route(req: Request): Promise<Response | null> {
      if (!req.url.pathname.startsWith(PREFIX)) return null
      if (!deps.enabled) return null
      try {
        return await handle(req)
      } catch (err) {
        return translate(err)
      }
    },
  }
}
