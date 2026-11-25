import {
  INTELLIGENCE_CONTRACT_VERSION,
  UNKNOWN_CURRENCY,
  hasPermission,
  type CoverageItem,
  type DataOrigin,
  type Exclusion,
  type MoneyAmount,
  type Permission,
  type ReadModelEnvelope,
  type ReportingScope,
  type SourceRef,
  type TenantContext,
  type Warning,
} from './contracts.ts'

/** Thrown when a caller lacks a permission or addresses another tenant. Routes map it to 403/404. */
export class IntelligenceAccessError extends Error {
  readonly code: 'forbidden' | 'tenant_mismatch'
  constructor(code: 'forbidden' | 'tenant_mismatch', message: string) {
    super(message)
    this.code = code
  }
}

export function requirePermission(ctx: TenantContext, permission: Permission): void {
  if (!hasPermission(ctx, permission)) throw new IntelligenceAccessError('forbidden', `Missing permission ${permission}.`)
}

export function requireTenant(ctx: TenantContext, tenantId: string): void {
  if (ctx.tenantId !== tenantId) throw new IntelligenceAccessError('tenant_mismatch', 'This data belongs to another account.')
}

/** Default: a read model is stale when its newest source is older than this. */
export const DEFAULT_STALE_AFTER_MS = 35 * 86_400_000

export interface EnvelopeInput<T> {
  model: string
  metricDefinitionVersion: string
  ctx: TenantContext
  origin: DataOrigin
  scope: ReportingScope
  computedAt: number
  sourceUpdatedAt: number | null
  staleAfterMs?: number
  coverage: CoverageItem[]
  sources?: SourceRef[]
  exclusions?: Exclusion[]
  warnings?: Warning[]
  result: T | null
}

/** Maximum citations an envelope carries; callers page through source IDs elsewhere. */
export const MAX_ENVELOPE_SOURCES = 200

export function envelope<T>(input: EnvelopeInput<T>): ReadModelEnvelope<T> {
  const staleAfter = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const stale = input.sourceUpdatedAt === null ? false : input.computedAt - input.sourceUpdatedAt > staleAfter
  const warnings = [...(input.warnings ?? [])]
  const sources = input.sources ?? []
  if (sources.length > MAX_ENVELOPE_SOURCES) warnings.push({ code: 'sources_truncated', detail: `${sources.length - MAX_ENVELOPE_SOURCES} further source references omitted.` })
  return {
    model: input.model,
    contractVersion: INTELLIGENCE_CONTRACT_VERSION,
    metricDefinitionVersion: input.metricDefinitionVersion,
    tenantId: input.ctx.tenantId,
    origin: input.origin,
    scope: input.scope,
    freshness: {
      computedAt: input.computedAt,
      sourceUpdatedAt: input.sourceUpdatedAt,
      stale,
      staleReason: stale ? `Newest source data is more than ${Math.round(staleAfter / 86_400_000)} days old.` : null,
    },
    coverage: input.coverage,
    sources: sources.slice(0, MAX_ENVELOPE_SOURCES),
    exclusions: (input.exclusions ?? []).filter((e) => e.count > 0),
    warnings,
    result: input.result,
  }
}

/**
 * Adds coverage reasons a read model could not see itself (e.g. saved audits
 * that could not be read) to its primary coverage item, so an answer built
 * without them never reads as complete. A not_run item stays not_run.
 */
export function withExtraCoverage<T>(env: ReadModelEnvelope<T>, reasons: readonly string[] | undefined): ReadModelEnvelope<T> {
  if (!reasons || reasons.length === 0) return env
  const [first, ...rest] = env.coverage.length ? env.coverage : [{ check: 'data_sources', status: 'supported' as const, reasons: [] }]
  const merged = [...new Set([...first.reasons, ...reasons])].sort()
  return { ...env, coverage: [{ ...first, status: first.status === 'not_run' ? 'not_run' : 'limited', reasons: merged }, ...rest] }
}

// ---------------------------------------------------------------- money helpers

export function normalizeCurrency(raw: string | null | undefined): string {
  const code = raw?.trim().toUpperCase()
  return code && /^[A-Z]{3}$/.test(code) ? code : UNKNOWN_CURRENCY
}

/** Dollars-as-float (legacy fields) to integer minor units. */
export function toMinor(amount: number | null | undefined): number {
  return Number.isFinite(amount) ? Math.round((amount as number) * 100) : 0
}

/** Accumulates per-currency totals without ever combining currencies. */
export class CurrencyTotals {
  private readonly totals = new Map<string, number>()
  add(currency: string, amountMinor: number): void {
    if (!Number.isSafeInteger(amountMinor)) throw new RangeError('Amounts must be safe integer minor units.')
    const next = (this.totals.get(currency) ?? 0) + amountMinor
    if (!Number.isSafeInteger(next)) throw new RangeError('Total exceeds exact integer arithmetic.')
    this.totals.set(currency, next)
  }
  get(currency: string): number {
    return this.totals.get(currency) ?? 0
  }
  currencies(): string[] {
    return [...this.totals.keys()].sort()
  }
  /** Sorted by currency code for deterministic output. */
  list(): MoneyAmount[] {
    return this.currencies().map((currency) => ({ currency, amountMinor: this.totals.get(currency)! }))
  }
}

export function coverage(check: string, reasons: string[], notRun = false): CoverageItem {
  const unique = [...new Set(reasons)].sort()
  return { check, status: notRun ? 'not_run' : unique.length ? 'limited' : 'supported', reasons: unique }
}

/** Calendar date YYYY-MM-DD from local getters of a Date built in the same zone. */
export function calendarDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function inRange(date: string | null, from: string | null, to: string | null): boolean {
  if (date === null) return from === null && to === null
  return (from === null || date >= from) && (to === null || date <= to)
}

export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
}

/** Stable, order-independent short hash for IDs and dedup keys (FNV-1a 32-bit, hex). */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
