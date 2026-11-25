/**
 * Authoritative, tenant-scoped server ledger (C3, contract `SourceRecord`,
 * `ImportCoverage`, scoped financial reads).
 *
 * - The server parses the customer's CSV itself with the same engine the
 *   browser uses (`parseCsv`), assigns record identities, deduplicates against
 *   everything the tenant already imported, and derives findings with the
 *   unchanged `detectFindings`. A client never supplies rows, findings or
 *   amounts here; it supplies a file.
 * - A CSV upload is customer-supplied evidence (`customer_uploaded`), not an
 *   authenticated transaction. Server processing does not prove it genuine.
 * - At rest, everything that names a supplier, a reference, an account or a
 *   raw source row is sealed with AES-256-GCM under DATA_KEY, with the tenant
 *   and row bound in as associated data. Amounts, dates, currency, kind and
 *   status stay in plain columns so aggregates run in SQL; supplier and
 *   identity equality use keyed hashes (HMAC under a key derived from
 *   DATA_KEY). This is a deliberate tradeoff recorded in the handoff.
 * - Every row belongs to an organisation and cascades with it, so deleting an
 *   account deletes its personal organisation's ledger.
 *
 * Import dedup mirrors `inspectImport` in src/ledger/store.ts (a parity test
 * holds the two together): the same identity seen again is never a second
 * payment; it is reported as already imported (exact) or a possible overlap.
 */
import { createHash, createHmac, hkdfSync } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { newId, openSecret, sealSecret } from './crypto.ts'
import { requirePermission } from './tenancy.ts'
import { parseCsv } from '../src/lib/csv.ts'
import { detectFindings } from '../src/lib/detection.ts'
import { toCents } from '../src/lib/format.ts'
import { checksum, normalizeReference, recordIdentity, referenceStrength, sourceSignature } from '../src/lib/sourceIdentity.ts'
import { normalizeVendorName } from '../src/lib/vendorResolution.ts'
import { computeImportCoverage } from '../src/ingestion/coverage.ts'
import { MappingConflictError, applyMapping, readHeaderAndSample, type ColumnMapping, type MappingIssue } from '../src/ingestion/columnMapping.ts'
import { confirmMapping, resolveMappingForUpload, type MappingResolution, type StoredColumnMapping } from './columnMappings.ts'
import { FINANCIAL_CONTRACT_VERSION, SOURCE_NORMALIZATION_VERSION } from '../src/contracts/financial.ts'
import type { ImportCoverage, SourceRecord, SourceRecordKind, SourceRecordStatus, TenantContext } from '../src/contracts/financial.ts'
import type { APRecord, Finding, ImportRowResult, ImportRowStatus } from '../src/types.ts'

export type LedgerKeys = { current: Buffer; previous: Buffer | null } | null

export const LEDGER_ALGORITHM_VERSION = 'server-ledger/1.0.0'
/** Largest CSV the import accepts, in characters (the HTTP body cap is 25 MB). */
export const MAX_CSV_CHARS = 20 * 1024 * 1024
export const MAX_PAGE = 200

export class LedgerError extends Error {
  readonly status: 400 | 404 | 409 | 413
  readonly code: string
  /** Column-mapping problems behind a 409; header names and field names only, never row values. */
  readonly issues: MappingIssue[]
  constructor(status: 400 | 404 | 409 | 413, message: string, code: string, issues: MappingIssue[] = []) {
    super(message)
    this.status = status
    this.code = code
    this.issues = issues
  }
}

export function ensureLedgerSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_imports (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    source_system TEXT NOT NULL CHECK (source_system IN ('csv_upload', 'quickbooks')),
    report_type TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    normalization_version INTEGER NOT NULL,
    rows_total INTEGER NOT NULL,
    rows_accepted INTEGER NOT NULL,
    rows_rejected INTEGER NOT NULL,
    new_records INTEGER NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (tenant_id, file_hash)
  );
  CREATE INDEX IF NOT EXISTS ledger_imports_tenant ON ledger_imports(tenant_id, created_at);
  CREATE TABLE IF NOT EXISTS source_records (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    import_id TEXT NOT NULL REFERENCES ledger_imports(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    identity_hash TEXT NOT NULL,
    vendor_hash TEXT NOT NULL,
    source_system TEXT NOT NULL,
    provenance TEXT NOT NULL CHECK (provenance IN ('customer_uploaded', 'connector_authenticated', 'independently_verified')),
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    currency TEXT,
    amount_minor INTEGER,
    payment_date TEXT,
    invoice_date TEXT,
    normalization_version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (tenant_id, identity_hash),
    UNIQUE (tenant_id, seq)
  );
  CREATE INDEX IF NOT EXISTS source_records_vendor ON source_records(tenant_id, vendor_hash);
  CREATE INDEX IF NOT EXISTS source_records_date ON source_records(tenant_id, payment_date);`)
}

// ------------------------------------------------------------------ at-rest protection

const isSealed = (value: string) => value.startsWith('v1.')
const recordContext = (tenantId: string, id: string) => `ledger-record:${tenantId}:${id}`
const importContext = (tenantId: string, id: string) => `ledger-import:${tenantId}:${id}`

/** Index key for equality lookups; derived so DATA_KEY itself is never used as an HMAC key. */
function indexKey(keys: LedgerKeys): Buffer {
  if (!keys) return createHash('sha256').update('reclaim:ledger-index:dev-unkeyed').digest()
  return Buffer.from(hkdfSync('sha256', keys.current, Buffer.alloc(0), 'reclaim:ledger-index:v1', 32))
}

/** Keyed hash scoped to the tenant, so equal values in two tenants never share a hash. */
const blind = (keys: LedgerKeys, tenantId: string, purpose: string, value: string) =>
  createHmac('sha256', indexKey(keys)).update(`${purpose}\u0000${tenantId}\u0000${value}`).digest('base64url')

function seal(keys: LedgerKeys, json: string, context: string): string {
  return keys ? sealSecret(json, keys.current, context) : json
}

function open<T>(keys: LedgerKeys, payload: string, context: string): T {
  if (!isSealed(payload)) return JSON.parse(payload) as T
  if (!keys) throw new Error('Ledger data is sealed but no DATA_KEY is configured.')
  try {
    return JSON.parse(openSecret(payload, keys.current, context)) as T
  } catch (err) {
    if (keys.previous) return JSON.parse(openSecret(payload, keys.previous, context)) as T
    throw err
  }
}

// ------------------------------------------------------------------ record shapes

/** What is sealed per record: the contract fields that identify anyone, and the engine row detection needs. */
interface RecordPayload {
  vendorName: string
  vendorKey: string
  referenceRaw: string | null
  referenceNormalized: string | null
  sourceAccount: string | null
  sourceNativeId: string | null
  identityKey: string
  unknownFields: string[]
  sourceRow: number | null
  engine: StoredEngineRecord
}

type StoredEngineRecord = Omit<APRecord, 'invoiceDate' | 'paymentDate'> & { invoiceDate: string | null; paymentDate: string }

interface ImportDetail {
  sourceLabel: string
  fileChecksum: string
  coverage: ImportCoverage
  rowResults: Array<Omit<ImportRowResult, 'raw'>>
}

const OPTIONAL_FIELDS: Array<[keyof APRecord, string]> = [
  ['invoiceNumber', 'invoice_number'],
  ['invoiceDate', 'invoice_date'],
  ['invoiceAmount', 'invoice_amount'],
  ['terms', 'terms'],
  ['bankAccountLast4', 'bank_account_last4'],
  ['currency', 'currency'],
  ['externalTransactionId', 'external_transaction_id'],
  ['sourceAccount', 'source_account'],
  ['stableSupplierId', 'vendor_id'],
]

const pad = (n: number) => String(n).padStart(2, '0')
/** Calendar date as the file stated it (the parser builds local dates). */
const isoDate = (d: Date | null) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : null)

function kindAndStatus(record: APRecord): { kind: SourceRecordKind; status: SourceRecordStatus } {
  const type = (record.transactionType ?? '').toLowerCase()
  const kind: SourceRecordKind = record.amountPaid < 0 || /refund/.test(type) ? 'refund' : 'payment'
  // A payments export says a payment was recorded; it does not prove settlement, so status stays unknown
  // unless the source states a void or reversal.
  const status: SourceRecordStatus = /void/.test(type) ? 'voided' : /revers/.test(type) ? 'reversed' : 'unknown'
  return { kind, status }
}

const vendorKeyOf = (record: APRecord) => (record.stableSupplierId ? `id:${record.stableSupplierId}` : `name:${normalizeVendorName(record.vendor)}`)

const storeEngine = (r: APRecord): StoredEngineRecord => ({ ...r, invoiceDate: r.invoiceDate ? r.invoiceDate.toISOString() : null, paymentDate: r.paymentDate.toISOString() })
const reviveEngine = (r: StoredEngineRecord): APRecord => ({ ...r, invoiceDate: r.invoiceDate ? new Date(r.invoiceDate) : null, paymentDate: new Date(r.paymentDate) })

interface RecordRow {
  id: string
  tenant_id: string
  import_id: string
  seq: number
  source_system: SourceRecord['sourceSystem']
  provenance: SourceRecord['provenance']
  kind: SourceRecordKind
  status: SourceRecordStatus
  currency: string | null
  amount_minor: number | null
  payment_date: string | null
  invoice_date: string | null
  normalization_version: number
  payload: string
}

function toSourceRecord(keys: LedgerKeys, row: RecordRow): SourceRecord {
  const p = open<RecordPayload>(keys, row.payload, recordContext(row.tenant_id, row.id))
  return {
    id: row.id,
    tenantId: row.tenant_id,
    sourceSystem: row.source_system,
    sourceAccount: p.sourceAccount,
    importId: row.import_id,
    sourceNativeId: p.sourceNativeId,
    kind: row.kind,
    provenance: row.provenance,
    vendorName: p.vendorName,
    vendorKey: p.vendorKey,
    referenceRaw: p.referenceRaw,
    referenceNormalized: p.referenceNormalized,
    referenceStrength: referenceStrength(p.referenceRaw),
    currency: row.currency,
    amountMinor: row.amount_minor,
    invoiceAmountMinor: p.engine.invoiceAmount === null ? null : toCents(p.engine.invoiceAmount),
    invoiceDate: row.invoice_date,
    paymentDate: row.payment_date,
    status: row.status,
    normalizationVersion: row.normalization_version,
    unknownFields: p.unknownFields,
    identityKey: p.identityKey,
    sourceRow: p.sourceRow,
  }
}

// ------------------------------------------------------------------ import

export interface ImportCsvInput {
  csv: string
  sourceLabel?: string | null
}

export interface ImportCsvResult {
  importId: string
  /** The exact same file was imported before; nothing changed and the earlier import is returned. */
  duplicateFile: boolean
  coverage: ImportCoverage
  /** Per-row outcome without the raw cells. */
  rowResults: Array<Omit<ImportRowResult, 'raw'>>
}

const withoutRaw = (r: ImportRowResult): Omit<ImportRowResult, 'raw'> => {
  const { raw: _raw, ...rest } = r
  return rest
}

/**
 * Parses and stores one CSV for the tenant. Idempotent: the same file again
 * returns the original import; overlapping rows from another file are not
 * stored twice. Runs in one write transaction, so concurrent imports of
 * overlapping files cannot both insert the same identity.
 */
export function importCsv(db: DatabaseSync, keys: LedgerKeys, ctx: TenantContext, input: ImportCsvInput, now = Date.now()): ImportCsvResult {
  requirePermission(ctx, 'ledger:import')
  if (typeof input.csv !== 'string' || input.csv.trim() === '') throw new LedgerError(400, 'Send the CSV file as text.', 'csv_required')
  if (input.csv.length > MAX_CSV_CHARS) throw new LedgerError(413, 'That file is too large to import.', 'csv_too_large')
  const sourceLabel = typeof input.sourceLabel === 'string' ? Array.from(input.sourceLabel).filter((c) => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127).join('').trim().slice(0, 200) : ''

  // Columns are read through the tenant's confirmed mapping or a built-in
  // format. An unfamiliar layout, or one whose dates/decimals the parser would
  // misread, is refused before anything is stored: the caller proposes and
  // confirms a mapping (POST /api/ledger/mappings) and sends the file again.
  const { headers, sampleRows } = readHeaderAndSample(input.csv)
  const resolution = resolveMappingForUpload(db, ctx.tenantId, headers, sampleRows)
  if (resolution.status === 'conflict') throw new LedgerError(409, 'These columns cannot be read safely. Check the mapping or export the file again.', 'mapping_conflict', resolution.issues)
  if (resolution.status === 'pending_confirmation') throw new LedgerError(409, 'Confirm how these columns map before importing.', 'mapping_unconfirmed', resolution.issues)

  const parsed = parseCsv(applyMapping(input.csv, resolution.mapping))
  const fileChecksum = parsed.fileChecksum ?? checksum(parsed.records.map(sourceSignature).join('\n'))
  const fileHash = blind(keys, ctx.tenantId, 'file', fileChecksum)

  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db.prepare('SELECT id, detail FROM ledger_imports WHERE tenant_id = ? AND file_hash = ?').get(ctx.tenantId, fileHash) as { id: string; detail: string } | undefined
    if (existing) {
      db.exec('COMMIT')
      const detail = open<ImportDetail>(keys, existing.detail, importContext(ctx.tenantId, existing.id))
      return { importId: existing.id, duplicateFile: true, coverage: detail.coverage, rowResults: detail.rowResults }
    }

    const importId = newId('imp')
    const findPrevious = db.prepare('SELECT id, payload FROM source_records WHERE tenant_id = ? AND identity_hash = ?')
    const seen = new Map<string, { id: string; record: APRecord }>()
    const rowResults: ImportRowResult[] = [...(parsed.rowResults ?? [])]
    const accepted: Array<{ record: APRecord; key: string; status: ImportRowStatus }> = []
    let alreadyImported = 0
    let repeatedWithinImport = 0

    for (const record of parsed.records) {
      const key = record.identityKey ?? recordIdentity(record)
      const identityHash = blind(keys, ctx.tenantId, 'identity', key)
      let previous = seen.get(identityHash)
      if (previous) repeatedWithinImport++
      else {
        const stored = findPrevious.get(ctx.tenantId, identityHash) as { id: string; payload: string } | undefined
        if (stored) {
          previous = { id: stored.id, record: reviveEngine(open<RecordPayload>(keys, stored.payload, recordContext(ctx.tenantId, stored.id)).engine) }
          alreadyImported++
        }
      }
      const missing = !record.externalTransactionId && !record.invoiceNumber
      const status: ImportRowStatus = previous
        ? record.externalTransactionId && sourceSignature(previous.record) === sourceSignature(record) ? 'exact_duplicate' : 'possible_overlap'
        : missing ? 'missing_identification_fields' : 'newly_imported'
      rowResults.push({
        rowNumber: record.source?.rowNumber ?? record.rowIndex + 2,
        status,
        reason: previous
          ? status === 'exact_duplicate' ? 'This external transaction was already imported.' : 'Possible overlap or conflicting source identity. Row retained in this receipt; obtain distinct transaction IDs before importing it as another payment.'
          : missing ? 'No external transaction ID or invoice reference; payment identity needs confirmation.' : 'New source record.',
        raw: null,
        fingerprint: record.rowFingerprint ?? checksum(key),
        ...(previous ? { existingRecordId: previous.id } : {}),
      })
      if (!previous) {
        const id = newId('src')
        const identified: APRecord = { ...record, id, importBatchId: importId, identityKey: key, rowFingerprint: record.rowFingerprint ?? checksum(key), importStatus: status }
        seen.set(identityHash, { id, record: identified })
        accepted.push({ record: identified, key, status })
      }
    }

    const coverage = computeImportCoverage({
      importId,
      sourceSystem: 'csv_upload',
      parse: { records: parsed.records, detectedColumns: parsed.detectedColumns, skippedCount: parsed.skippedCount, rowResults: parsed.rowResults },
      reportType: resolution.proposal.reportType,
      mapping: { status: resolution.status, mappingId: resolution.mappingId, version: resolution.version, pendingFields: [] },
      dedup: { newRecords: accepted.length, alreadyImported, repeatedWithinImport },
      freshAsOf: null,
    })
    const sortedResults = rowResults.sort((a, b) => a.rowNumber - b.rowNumber).map(withoutRaw)
    const detail: ImportDetail = { sourceLabel, fileChecksum, coverage, rowResults: sortedResults }
    db.prepare(`INSERT INTO ledger_imports (id, tenant_id, actor_user_id, source_system, report_type, file_hash, contract_version, normalization_version,
      rows_total, rows_accepted, rows_rejected, new_records, detail, created_at) VALUES (?, ?, ?, 'csv_upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(importId, ctx.tenantId, ctx.actorUserId, coverage.reportType, fileHash, FINANCIAL_CONTRACT_VERSION, SOURCE_NORMALIZATION_VERSION,
        coverage.rows.total, coverage.rows.accepted, coverage.rows.rejected, accepted.length, seal(keys, JSON.stringify(detail), importContext(ctx.tenantId, importId)), now)

    let seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM source_records WHERE tenant_id = ?').get(ctx.tenantId) as { n: number }).n
    const insert = db.prepare(`INSERT INTO source_records (id, tenant_id, import_id, seq, identity_hash, vendor_hash, source_system, provenance, kind, status,
      currency, amount_minor, payment_date, invoice_date, normalization_version, payload, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'csv_upload', 'customer_uploaded', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const { record, key } of accepted) {
      const { kind, status } = kindAndStatus(record)
      const vendorKey = vendorKeyOf(record)
      const reference = normalizeReference(record.invoiceNumber)
      const payload: RecordPayload = {
        vendorName: record.vendor,
        vendorKey,
        referenceRaw: record.invoiceNumber,
        referenceNormalized: reference.value,
        sourceAccount: record.sourceAccount ?? null,
        sourceNativeId: record.externalTransactionId ?? null,
        identityKey: key,
        unknownFields: OPTIONAL_FIELDS.filter(([field]) => record[field] === null || record[field] === undefined).map(([, name]) => name),
        sourceRow: record.source?.rowNumber ?? record.rowIndex + 2,
        engine: storeEngine(record),
      }
      insert.run(record.id, ctx.tenantId, importId, ++seq, blind(keys, ctx.tenantId, 'identity', key), blind(keys, ctx.tenantId, 'vendor', vendorKey), kind, status,
        record.currency ? record.currency.toUpperCase() : null, toCents(record.amountPaid), isoDate(record.paymentDate), isoDate(record.invoiceDate),
        SOURCE_NORMALIZATION_VERSION, seal(keys, JSON.stringify(payload), recordContext(ctx.tenantId, record.id)), now)
    }
    db.exec('COMMIT')
    return { importId, duplicateFile: false, coverage, rowResults: sortedResults }
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw err
  }
}

// ------------------------------------------------------------------ scoped reads

export interface ImportSummary {
  importId: string
  sourceSystem: SourceRecord['sourceSystem']
  sourceLabel: string
  createdAt: number
  newRecords: number
  coverage: ImportCoverage
}

export function listImports(db: DatabaseSync, keys: LedgerKeys, ctx: TenantContext): ImportSummary[] {
  requirePermission(ctx, 'ledger:read')
  const rows = db.prepare('SELECT id, source_system, new_records, detail, created_at FROM ledger_imports WHERE tenant_id = ? ORDER BY created_at, id').all(ctx.tenantId) as Array<{ id: string; source_system: SourceRecord['sourceSystem']; new_records: number; detail: string; created_at: number }>
  return rows.map((r) => {
    const detail = open<ImportDetail>(keys, r.detail, importContext(ctx.tenantId, r.id))
    return { importId: r.id, sourceSystem: r.source_system, sourceLabel: detail.sourceLabel, createdAt: r.created_at, newRecords: r.new_records, coverage: detail.coverage }
  })
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY = /^[A-Z]{3}$/

export interface RecordQuery {
  /** Opaque cursor from the previous page. */
  cursor?: string | null
  limit?: number | null
  /** Inclusive ISO date bounds on the payment date. */
  from?: string | null
  to?: string | null
  currency?: string | null
}

export interface RecordPage {
  records: SourceRecord[]
  nextCursor: string | null
}

function dateBound(value: string | null | undefined, name: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (!ISO_DATE.test(value)) throw new LedgerError(400, `${name} must be a date like 2026-01-31.`, 'invalid_query')
  return value
}

/** Tenant-filtered source records in import order, paginated. Never returns another tenant's row. */
export function listSourceRecords(db: DatabaseSync, keys: LedgerKeys, ctx: TenantContext, query: RecordQuery = {}): RecordPage {
  requirePermission(ctx, 'ledger:read')
  const limit = Math.min(Math.max(Math.trunc(Number(query.limit ?? 50)) || 50, 1), MAX_PAGE)
  const after = query.cursor ? Number.parseInt(query.cursor, 36) : 0
  if (!Number.isSafeInteger(after) || after < 0) throw new LedgerError(400, 'That page cursor is not valid.', 'invalid_query')
  const from = dateBound(query.from, 'from')
  const to = dateBound(query.to, 'to')
  const currency = query.currency ? query.currency.toUpperCase() : null
  if (currency !== null && !CURRENCY.test(currency)) throw new LedgerError(400, 'currency must be a three-letter code.', 'invalid_query')
  const rows = db.prepare(`SELECT * FROM source_records WHERE tenant_id = ? AND seq > ?
      AND (? IS NULL OR payment_date >= ?) AND (? IS NULL OR payment_date <= ?) AND (? IS NULL OR currency = ?)
      ORDER BY seq LIMIT ?`).all(ctx.tenantId, after, from, from, to, to, currency, currency, limit + 1) as unknown as RecordRow[]
  const page = rows.slice(0, limit)
  return { records: page.map((r) => toSourceRecord(keys, r)), nextCursor: rows.length > limit ? page[page.length - 1].seq.toString(36) : null }
}

/**
 * Evidence lookup by record ID for the case and AI workstreams. IDs outside
 * the tenant are reported as missing, exactly like IDs that do not exist.
 */
export function getSourceRecords(db: DatabaseSync, keys: LedgerKeys, ctx: TenantContext, ids: readonly string[]): { records: SourceRecord[]; missing: string[] } {
  requirePermission(ctx, 'ledger:read')
  const unique = [...new Set(ids)].slice(0, MAX_PAGE)
  const lookup = db.prepare('SELECT * FROM source_records WHERE tenant_id = ? AND id = ?')
  const records: SourceRecord[] = []
  const missing: string[] = []
  for (const id of unique) {
    const row = typeof id === 'string' ? (lookup.get(ctx.tenantId, id) as unknown as RecordRow | undefined) : undefined
    if (row) records.push(toSourceRecord(keys, row))
    else missing.push(String(id))
  }
  return { records, missing }
}

function engineRecords(db: DatabaseSync, keys: LedgerKeys, tenantId: string): APRecord[] {
  const rows = db.prepare('SELECT id, payload FROM source_records WHERE tenant_id = ? ORDER BY seq').all(tenantId) as Array<{ id: string; payload: string }>
  return rows.map((r) => reviveEngine(open<RecordPayload>(keys, r.payload, recordContext(tenantId, r.id)).engine))
}

/** A finding as the server derives it: references source records by ID instead of embedding rows. */
export type LedgerFinding = Omit<Finding, 'relatedRecords' | 'sourceValues'> & { tenantId: string; sourceRecordIds: string[] }

export interface LedgerFindings {
  algorithmVersion: typeof LEDGER_ALGORITHM_VERSION
  contractVersion: typeof FINANCIAL_CONTRACT_VERSION
  recordCount: number
  findings: LedgerFinding[]
}

/**
 * Findings derived on the server by the unchanged eight-rule engine over the
 * tenant's whole ledger. Candidates for review, never recovered money.
 */
export function deriveFindings(db: DatabaseSync, keys: LedgerKeys, ctx: TenantContext): LedgerFindings {
  requirePermission(ctx, 'findings:read')
  const records = engineRecords(db, keys, ctx.tenantId)
  const result = detectFindings(records)
  // The engine stamps findings with the wall clock; on the server a finding's
  // time is when its last supporting record arrived, so re-deriving is stable.
  const arrived = new Map((db.prepare('SELECT id, created_at FROM source_records WHERE tenant_id = ?').all(ctx.tenantId) as unknown as { id: string; created_at: number }[]).map((r) => [r.id, r.created_at]))
  const findings = result.findings.map((f): LedgerFinding => {
    const { relatedRecords, sourceValues: _sourceValues, ...rest } = f
    const sourceRecordIds = f.sourceRecordIds ?? relatedRecords.map((r) => r.id)
    const createdAt = Math.max(0, ...sourceRecordIds.map((id) => arrived.get(id) ?? 0))
    return { ...rest, createdAt, tenantId: ctx.tenantId, sourceRecordIds }
  })
  return { algorithmVersion: LEDGER_ALGORITHM_VERSION, contractVersion: FINANCIAL_CONTRACT_VERSION, recordCount: records.length, findings }
}

/**
 * Supplier payments per vendor, calendar month and currency.
 *
 * Definition: supplier payment rows reported by the source (customer-uploaded
 * exports are the customer's own report, not bank-verified), excluding voided
 * and reversed rows. Refunds are summed separately and never netted into
 * payments. Bills are not payments and are never included, so nothing is
 * counted twice. Each currency is its own row; amounts are never converted or
 * added across currencies, and rows with no stated currency are grouped under
 * `currency: null`, not assumed USD.
 */
export interface VendorPeriodAggregate {
  vendorKey: string
  vendorName: string
  period: string
  currency: string | null
  paymentCount: number
  paymentsMinor: number
  refundCount: number
  refundsMinor: number
}

export const AGGREGATE_DEFINITION = 'reported_supplier_payments_v1'

export function vendorPeriodAggregates(db: DatabaseSync, keys: LedgerKeys, ctx: TenantContext, query: { from?: string | null; to?: string | null } = {}): { definition: typeof AGGREGATE_DEFINITION; rows: VendorPeriodAggregate[] } {
  requirePermission(ctx, 'ledger:read')
  const from = dateBound(query.from, 'from')
  const to = dateBound(query.to, 'to')
  const rows = db.prepare(`SELECT vendor_hash, substr(payment_date, 1, 7) AS period, currency, MIN(id) AS sample_id,
      SUM(kind = 'payment') AS payment_count, SUM(CASE WHEN kind = 'payment' THEN amount_minor ELSE 0 END) AS payments_minor,
      SUM(kind = 'refund') AS refund_count, SUM(CASE WHEN kind = 'refund' THEN -amount_minor ELSE 0 END) AS refunds_minor
    FROM source_records
    WHERE tenant_id = ? AND kind IN ('payment', 'refund') AND status NOT IN ('voided', 'reversed') AND payment_date IS NOT NULL
      AND (? IS NULL OR payment_date >= ?) AND (? IS NULL OR payment_date <= ?)
    GROUP BY vendor_hash, period, currency
    ORDER BY period, vendor_hash, currency`).all(ctx.tenantId, from, from, to, to) as Array<{ vendor_hash: string; period: string; currency: string | null; sample_id: string; payment_count: number; payments_minor: number; refund_count: number; refunds_minor: number }>
  const sample = db.prepare('SELECT * FROM source_records WHERE tenant_id = ? AND id = ?')
  const names = new Map<string, { vendorKey: string; vendorName: string }>()
  return {
    definition: AGGREGATE_DEFINITION,
    rows: rows.map((r) => {
      let name = names.get(r.vendor_hash)
      if (!name) {
        const rec = toSourceRecord(keys, sample.get(ctx.tenantId, r.sample_id) as unknown as RecordRow)
        name = { vendorKey: rec.vendorKey, vendorName: rec.vendorName }
        names.set(r.vendor_hash, name)
      }
      return { ...name, period: r.period, currency: r.currency, paymentCount: r.payment_count, paymentsMinor: r.payments_minor, refundCount: r.refund_count, refundsMinor: r.refunds_minor }
    }),
  }
}

// ------------------------------------------------------------------ key rotation

/**
 * Seals plain rows once a DATA_KEY exists and re-seals rows under
 * DATA_KEY_PREVIOUS with the current key, recomputing the keyed hashes from
 * the sealed plaintext. Same trigger as ProjectStore's startup migration.
 */
export function resealLedger(db: DatabaseSync, keys: LedgerKeys): number {
  if (!keys) return 0
  const where = keys.previous ? '' : " WHERE payload NOT LIKE 'v1.%'"
  const records = db.prepare(`SELECT id, tenant_id, payload FROM source_records${where}`).all() as Array<{ id: string; tenant_id: string; payload: string }>
  const imports = db.prepare(`SELECT id, tenant_id, detail FROM ledger_imports${where.replace('payload', 'detail')}`).all() as Array<{ id: string; tenant_id: string; detail: string }>
  if (records.length === 0 && imports.length === 0) return 0
  const oldKeys: LedgerKeys = keys.previous ? { current: keys.previous, previous: null } : null
  const reader = (payload: string, context: string) => {
    if (!isSealed(payload)) return JSON.parse(payload) as unknown
    try {
      return open<unknown>(keys, payload, context)
    } catch {
      return open<unknown>(oldKeys, payload, context)
    }
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    const updateRecord = db.prepare('UPDATE source_records SET payload = ?, identity_hash = ?, vendor_hash = ? WHERE id = ?')
    for (const r of records) {
      const p = reader(r.payload, recordContext(r.tenant_id, r.id)) as RecordPayload
      updateRecord.run(seal(keys, JSON.stringify(p), recordContext(r.tenant_id, r.id)), blind(keys, r.tenant_id, 'identity', p.identityKey), blind(keys, r.tenant_id, 'vendor', p.vendorKey), r.id)
    }
    const updateImport = db.prepare('UPDATE ledger_imports SET detail = ?, file_hash = ? WHERE id = ?')
    for (const i of imports) {
      const d = reader(i.detail, importContext(i.tenant_id, i.id)) as ImportDetail
      updateImport.run(seal(keys, JSON.stringify(d), importContext(i.tenant_id, i.id)), blind(keys, i.tenant_id, 'file', d.fileChecksum), i.id)
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return records.length + imports.length
}

// ---------------------------------------------------------------------------
// Column mappings for the server import (C1 store, tenant from the session).

function checkCsvText(csv: unknown): string {
  if (typeof csv !== 'string' || csv.trim() === '') throw new LedgerError(400, 'Send the CSV file as text.', 'csv_required')
  if (csv.length > MAX_CSV_CHARS) throw new LedgerError(413, 'That file is too large to import.', 'csv_too_large')
  return csv
}

/** How the server would read this file's columns. Reads headers and a small sample; stores nothing. */
export function proposeImportMapping(db: DatabaseSync, ctx: TenantContext, csv: unknown): MappingResolution {
  requirePermission(ctx, 'ledger:import')
  const { headers, sampleRows } = readHeaderAndSample(checkCsvText(csv))
  return resolveMappingForUpload(db, ctx.tenantId, headers, sampleRows)
}

const isText = (v: unknown, max: number) => typeof v === 'string' && v.length <= max

/** Strict shape check for a mapping sent by a client, before any validation logic sees it. */
export function parseMappingBody(body: unknown): { signature: string; mapping: ColumnMapping } {
  const bad = () => new LedgerError(400, 'Send the mapping to confirm.', 'invalid_mapping')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad()
  const { signature, mapping } = body as { signature?: unknown; mapping?: unknown }
  if (!isText(signature, 20_000) || !mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw bad()
  const m = mapping as Record<string, unknown>
  const locale = m.locale as Record<string, unknown> | undefined
  if (!Array.isArray(m.columns) || m.columns.length === 0 || m.columns.length > 500) throw bad()
  if (!locale || typeof locale !== 'object' || !['month_first', 'day_first', 'unknown'].includes(locale.dateOrder as string) || !['dot', 'comma', 'unknown'].includes(locale.decimal as string)) throw bad()
  if (!(m.formatId === null || isText(m.formatId, 100)) || !isText(m.signature, 20_000)) throw bad()
  const columns = m.columns.map((c: unknown) => {
    const col = c as Record<string, unknown> | null
    if (!col || typeof col !== 'object' || !isText(col.key, 500) || !isText(col.header, 500) || !(col.canonical === null || isText(col.canonical, 100))) throw bad()
    return { key: col.key as string, header: col.header as string, canonical: col.canonical as string | null }
  })
  return {
    signature: signature as string,
    mapping: { signature: m.signature as string, formatId: m.formatId as string | null, columns, locale: { dateOrder: locale.dateOrder as ColumnMapping['locale']['dateOrder'], decimal: locale.decimal as ColumnMapping['locale']['decimal'] } },
  }
}

/** Record a person's confirmation of a column mapping as a new version for this tenant. */
export function confirmImportMapping(db: DatabaseSync, ctx: TenantContext, body: unknown, now = Date.now()): StoredColumnMapping {
  requirePermission(ctx, 'ledger:import')
  const { signature, mapping } = parseMappingBody(body)
  try {
    return confirmMapping(db, ctx.tenantId, ctx.actorUserId, signature, mapping, now)
  } catch (err) {
    if (err instanceof MappingConflictError) throw new LedgerError(409, 'This mapping cannot be confirmed as it stands.', 'mapping_conflict', err.issues)
    throw err
  }
}
