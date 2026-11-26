/**
 * Versioned, per-tenant column mappings.
 *
 * A mapping is stored against the header signature of the file it describes
 * (order-insensitive set of normalized header keys). Each confirmation writes
 * a new version; earlier versions stay for audit and are never rewritten.
 *
 * Every query is scoped by tenant_id. The tenant id is a plain parameter here;
 * callers must take it from the server session (TenantContext), never from a
 * request body. Nothing in this module stores or logs row values: only header
 * names, canonical field names and the date/decimal convention are kept.
 */
import type { DatabaseSync } from 'node:sqlite'
import type { MappingStatus } from '../src/contracts/financial.ts'
import {
  diffMappings,
  formatSignature,
  headerKey,
  matchKnownFormat,
  MappingConflictError,
  proposeColumnMapping,
  validateMapping,
  type ColumnMapping,
  type MappingDiff,
  type MappingIssue,
  type MappingProposal,
} from '../src/ingestion/columnMapping.ts'

/** Share of header keys two files must have in common before a prior mapping is offered for a changed layout. */
export const SIMILAR_SIGNATURE_MIN_JACCARD = 0.5

export function ensureColumnMappingSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS column_mappings (
      tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      signature TEXT NOT NULL,
      version INTEGER NOT NULL,
      mapping_json TEXT NOT NULL,
      status TEXT NOT NULL,
      confirmed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (tenant_id, signature, version)
    );
    CREATE INDEX IF NOT EXISTS idx_column_mappings_tenant ON column_mappings(tenant_id, created_at);
  `)
}

export interface StoredColumnMapping {
  signature: string
  version: number
  mappingId: string
  mapping: ColumnMapping
  status: 'confirmed'
  confirmedBy: string | null
  confirmedAt: number | null
  createdAt: number
}

interface MappingRow {
  signature: string
  version: number
  mapping_json: string
  status: string
  confirmed_by: string | null
  confirmed_at: number | null
  created_at: number
}

export const mappingIdFor = (signature: string, version: number) => `${signature}:v${version}`

function fromRow(row: MappingRow): StoredColumnMapping {
  return {
    signature: row.signature,
    version: Number(row.version),
    mappingId: mappingIdFor(row.signature, Number(row.version)),
    mapping: JSON.parse(row.mapping_json) as ColumnMapping,
    status: 'confirmed',
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at === null ? null : Number(row.confirmed_at),
    createdAt: Number(row.created_at),
  }
}

/** The latest confirmed version for this tenant and header signature, or null. */
export function currentMapping(db: DatabaseSync, tenantId: string, signature: string): StoredColumnMapping | null {
  const row = db
    .prepare(`SELECT signature, version, mapping_json, status, confirmed_by, confirmed_at, created_at FROM column_mappings
              WHERE tenant_id = ? AND signature = ? AND status = 'confirmed' ORDER BY version DESC LIMIT 1`)
    .get(tenantId, signature) as MappingRow | undefined
  return row ? fromRow(row) : null
}

/** Every stored version for this tenant and signature, oldest first (audit view). */
export function mappingHistory(db: DatabaseSync, tenantId: string, signature: string): StoredColumnMapping[] {
  const rows = db
    .prepare(`SELECT signature, version, mapping_json, status, confirmed_by, confirmed_at, created_at FROM column_mappings
              WHERE tenant_id = ? AND signature = ? ORDER BY version ASC`)
    .all(tenantId, signature) as unknown as MappingRow[]
  return rows.map(fromRow)
}

/** Latest confirmed mapping per signature for this tenant only. */
function latestPerSignature(db: DatabaseSync, tenantId: string): StoredColumnMapping[] {
  const rows = db
    .prepare(`SELECT m.signature, m.version, m.mapping_json, m.status, m.confirmed_by, m.confirmed_at, m.created_at
              FROM column_mappings m
              WHERE m.tenant_id = ? AND m.status = 'confirmed'
                AND m.version = (SELECT MAX(v.version) FROM column_mappings v WHERE v.tenant_id = m.tenant_id AND v.signature = m.signature AND v.status = 'confirmed')
              ORDER BY m.created_at DESC, m.signature ASC`)
    .all(tenantId) as unknown as MappingRow[]
  return rows.map(fromRow)
}

/**
 * Store a person's confirmation as a new version. Refuses (MappingConflictError)
 * a mapping with unresolved conflicts, missing required fields, an unsupported
 * date/decimal convention, or one that does not describe `signature`.
 */
export function confirmMapping(
  db: DatabaseSync,
  tenantId: string,
  actorUserId: string,
  signature: string,
  mapping: ColumnMapping,
  now: number = Date.now(),
): StoredColumnMapping {
  if (!tenantId) throw new Error('tenantId is required')
  if (!actorUserId) throw new Error('actorUserId is required')
  const issues: MappingIssue[] = validateMapping(mapping)
  if (mapping.signature !== signature) {
    issues.push({ code: 'signature_mismatch', severity: 'conflict', message: 'The mapping does not belong to this header signature.', fields: [], headers: [] })
  }
  if (issues.length > 0) throw new MappingConflictError(issues)

  // Store only structural facts: header keys/labels, canonical names, locale.
  const stored: ColumnMapping = {
    signature,
    formatId: mapping.formatId,
    columns: mapping.columns.map((c) => ({ key: c.key, header: c.header, canonical: c.canonical })),
    locale: { dateOrder: mapping.locale.dateOrder, decimal: mapping.locale.decimal },
  }
  let version = 0
  db.exec('BEGIN IMMEDIATE')
  try {
    const row = db.prepare('SELECT MAX(version) AS v FROM column_mappings WHERE tenant_id = ? AND signature = ?').get(tenantId, signature) as { v: number | null } | undefined
    version = Number(row?.v ?? 0) + 1
    db.prepare(`INSERT INTO column_mappings (tenant_id, signature, version, mapping_json, status, confirmed_by, confirmed_at, created_at)
                VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?)`).run(tenantId, signature, version, JSON.stringify(stored), actorUserId, now, now)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  return { signature, version, mappingId: mappingIdFor(signature, version), mapping: stored, status: 'confirmed', confirmedBy: actorUserId, confirmedAt: now, createdAt: now }
}

export interface StoredProposal extends MappingProposal {
  /** Set when the tenant has already confirmed this exact header set. */
  stored: StoredColumnMapping | null
}

/**
 * What to show a person for this header row: the tenant's confirmed mapping
 * when one exists for the exact signature, otherwise a fresh proposal.
 */
export function proposeMapping(db: DatabaseSync, tenantId: string, headers: readonly string[], sampleRows: readonly (readonly string[])[] = []): StoredProposal {
  const proposal = proposeColumnMapping(headers, sampleRows)
  const stored = currentMapping(db, tenantId, proposal.signature)
  if (!stored) return { ...proposal, stored: null }
  return { ...proposal, status: 'confirmed', formatId: stored.mapping.formatId, mapping: stored.mapping, issues: [], pendingFields: [], stored }
}

export interface MappingResolution {
  status: MappingStatus
  /** The mapping to apply. Only safe to apply when status is known_format or confirmed. */
  mapping: ColumnMapping
  /** Confirmed version applied, or null for a known format / unconfirmed proposal. */
  version: number | null
  mappingId: string | null
  /** Canonical fields a person must confirm before the import may run unrestricted. */
  pendingFields: string[]
  signature: string
  /** Prior confirmed mapping this resolution was carried over from, when the header set changed. */
  basedOn: { mappingId: string; diff: MappingDiff } | null
  issues: MappingIssue[]
  proposal: MappingProposal
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let inter = 0
  for (const k of a) if (b.has(k)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * Decide how an upload's columns are read:
 * 1. The tenant confirmed this exact header set before → `confirmed` (unless the
 *    new rows contradict the stored date/decimal convention).
 * 2. A built-in known format → `known_format`.
 * 3. The tenant confirmed a similar header set → that mapping is carried over;
 *    `confirmed` if the differences are immaterial, else `pending_confirmation`
 *    with the materially changed fields.
 * 4. Otherwise the fresh proposal's status (`known_format` for all-alias headers
 *    with no issues, else `pending_confirmation` or `conflict`).
 */
export function resolveMappingForUpload(
  db: DatabaseSync,
  tenantId: string,
  headers: readonly string[],
  sampleRows: readonly (readonly string[])[] = [],
): MappingResolution {
  const proposal = proposeColumnMapping(headers, sampleRows)
  const signature = proposal.signature
  const base = { signature, proposal }

  if (proposal.issues.some((i) => i.code === 'no_headers' || i.code === 'too_many_columns' || i.code === 'duplicate_header')) {
    return { ...base, status: 'conflict', mapping: proposal.mapping, version: null, mappingId: null, pendingFields: proposal.pendingFields, basedOn: null, issues: proposal.issues }
  }

  const stored = currentMapping(db, tenantId, signature)
  if (stored) {
    // Re-check the convention on the new rows: a stored month-first mapping must
    // not silently read a file whose dates are now day-first.
    const localeIssues = proposal.issues.filter((i) => ['date_day_first', 'date_order_inconsistent', 'decimal_comma', 'decimal_inconsistent'].includes(i.code))
    if (localeIssues.length > 0) {
      return { ...base, status: 'conflict', mapping: stored.mapping, version: stored.version, mappingId: stored.mappingId, pendingFields: Array.from(new Set(localeIssues.flatMap((i) => i.fields))).sort(), basedOn: null, issues: localeIssues }
    }
    return { ...base, status: 'confirmed', mapping: stored.mapping, version: stored.version, mappingId: stored.mappingId, pendingFields: [], basedOn: null, issues: [] }
  }

  if (matchKnownFormat(headers) || proposal.status === 'known_format' || proposal.status === 'conflict') {
    return { ...base, status: proposal.status, mapping: proposal.mapping, version: null, mappingId: null, pendingFields: proposal.pendingFields, basedOn: null, issues: proposal.issues }
  }

  // A changed layout from a source this tenant already mapped: carry the prior
  // assignments over by header key and ask only about what materially changed.
  const keys = new Set(headers.map(headerKey).filter((k) => k !== ''))
  let best: { stored: StoredColumnMapping; score: number } | null = null
  for (const candidate of latestPerSignature(db, tenantId)) {
    const score = jaccard(keys, new Set(candidate.mapping.columns.map((c) => c.key)))
    if (score >= SIMILAR_SIGNATURE_MIN_JACCARD && (!best || score > best.score)) best = { stored: candidate, score }
  }
  if (best) {
    const prior = new Map(best.stored.mapping.columns.map((c) => [c.key, c.canonical]))
    const proposed = new Map(proposal.mapping.columns.map((c) => [c.key, c.canonical]))
    const columns = headers.map((h) => {
      const key = headerKey(h)
      const canonical = prior.has(key) ? prior.get(key) ?? null : proposed.get(key) ?? null
      return { key, header: h, canonical }
    })
    const carried: ColumnMapping = { signature: formatSignature(headers), formatId: best.stored.mapping.formatId, columns, locale: proposal.issues.some((i) => i.code === 'date_order_ambiguous') ? best.stored.mapping.locale : proposal.mapping.locale }
    const diff = diffMappings(best.stored.mapping, carried)
    const conflicts = validateMapping(carried)
    const localeIssues = proposal.issues.filter((i) => i.severity === 'conflict')
    const basedOn = { mappingId: best.stored.mappingId, diff }
    if (conflicts.length > 0 || localeIssues.length > 0) {
      const issues = [...conflicts, ...localeIssues]
      const pending = Array.from(new Set([...issues.flatMap((i) => i.fields), ...diff.changes.filter((c) => c.material).map((c) => c.field)])).sort()
      return { ...base, status: conflicts.some((c) => c.code !== 'missing_required') || localeIssues.length > 0 ? 'conflict' : 'pending_confirmation', mapping: carried, version: null, mappingId: null, pendingFields: pending, basedOn, issues }
    }
    if (!diff.material) {
      return { ...base, status: 'confirmed', mapping: carried, version: best.stored.version, mappingId: best.stored.mappingId, pendingFields: [], basedOn, issues: [] }
    }
    const pendingFields = diff.changes.filter((c) => c.material).map((c) => c.field).sort()
    return {
      ...base,
      status: 'pending_confirmation',
      mapping: carried,
      version: null,
      mappingId: null,
      pendingFields,
      basedOn,
      issues: [{ code: 'heuristic_unconfirmed', severity: 'confirm', message: 'The file layout changed since the last confirmed mapping; changed fields need confirmation.', fields: pendingFields, headers: [] }],
    }
  }

  return { ...base, status: proposal.status, mapping: proposal.mapping, version: null, mappingId: null, pendingFields: proposal.pendingFields, basedOn: null, issues: proposal.issues }
}
