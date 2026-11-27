/**
 * Documents and the facts proposed from them, per tenant.
 *
 * The filename and contents of a document, and every fact's value and
 * excerpt (which are document text), are sealed under DATA_KEY with the
 * tenant and row bound in. Plain columns hold only ids, kinds, statuses,
 * sizes, a content hash and times. Nothing here is logged.
 *
 * Retention: each document has a `retention_until` (365 days by default);
 * expired documents are deleted, with their facts, the next time the store is
 * used. Deleting a document removes the row and its facts outright. SQLite may
 * keep the freed pages until they are reused; with DATA_KEY set those pages
 * only ever held ciphertext.
 */
import type { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import type { Sealer } from '../sealedJson.ts'
import { markConflicts, type DocumentKind, type FactStatus, type FactView, type ProposedFact, type VerificationOutcome } from './facts.ts'

export const DEFAULT_RETENTION_MS = 365 * 86_400_000
export const MAX_DOCUMENTS_PER_PROJECT = 200

export type DocumentStatus = 'received' | 'extracted' | 'unsupported_format'
export type DocumentFormat = 'text' | 'csv' | 'pdf'

export interface DocumentView {
  id: string
  projectId: string
  findingId: string | null
  kind: DocumentKind
  format: DocumentFormat
  status: DocumentStatus
  sha256: string
  size: number
  filename: string
  createdAt: number
  createdBy: string
  retentionUntil: number
  extractedAt: number | null
  /** Plain-language status for the person: what Reclaim can and can't do with this file. */
  note: string | null
}

type DocRow = {
  id: string; project_id: string; finding_id: string | null; kind: DocumentKind; format: DocumentFormat; status: DocumentStatus
  sha256: string; size: number; filename_sealed: string; content_sealed: string; created_by: string; created_at: number; retention_until: number; extracted_at: number | null
}
type FactRow = {
  id: string; document_id: string; project_id: string; finding_id: string | null; kind: string; origin: 'deterministic' | 'ai'; status: FactStatus
  confidence: string; body_sealed: string; case_fingerprint: string | null; invocation_id: string | null; created_at: number
  verifier: string | null; verifier_fixture: number | null; verifier_outcome: VerificationOutcome | null; verifier_reason: string | null; verified_at: number | null
}
type SealedFact = Pick<ProposedFact, 'value' | 'amountMinor' | 'row' | 'provenance' | 'conflicts'> & { baseConfidence: ProposedFact['confidence'] }

export function migrateDocuments(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      finding_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('invoice', 'remittance', 'supplier_statement', 'other')),
      format TEXT NOT NULL CHECK (format IN ('text', 'csv', 'pdf')),
      status TEXT NOT NULL CHECK (status IN ('received', 'extracted', 'unsupported_format')),
      sha256 TEXT NOT NULL,
      size INTEGER NOT NULL,
      filename_sealed TEXT NOT NULL,
      content_sealed TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      retention_until INTEGER NOT NULL,
      extracted_at INTEGER,
      FOREIGN KEY (user_id, project_id) REFERENCES projects(user_id, id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS documents_sha ON documents(user_id, sha256);
    CREATE INDEX IF NOT EXISTS documents_case ON documents(user_id, project_id, finding_id);
    CREATE INDEX IF NOT EXISTS documents_retention ON documents(retention_until);
    CREATE TABLE IF NOT EXISTS proposed_facts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      finding_id TEXT,
      kind TEXT NOT NULL,
      origin TEXT NOT NULL CHECK (origin IN ('deterministic', 'ai')),
      status TEXT NOT NULL CHECK (status IN ('proposed', 'handed_off', 'rejected')),
      confidence TEXT NOT NULL,
      body_sealed TEXT NOT NULL,
      case_fingerprint TEXT,
      invocation_id TEXT,
      created_at INTEGER NOT NULL,
      verifier TEXT,
      verifier_fixture INTEGER,
      verifier_outcome TEXT,
      verifier_reason TEXT,
      verified_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS proposed_facts_doc ON proposed_facts(user_id, document_id);
    CREATE INDEX IF NOT EXISTS proposed_facts_case ON proposed_facts(user_id, project_id, finding_id);
  `)
}

const NOTES: Record<DocumentStatus, string | null> = {
  received: null,
  extracted: null,
  unsupported_format: 'Stored, not read: Reclaim has no PDF or OCR reader. Enter the figures yourself, or upload a text or CSV export of the document.',
}

export class DocumentStore {
  private readonly db: DatabaseSync
  private readonly sealer: Sealer
  private readonly now: () => number

  constructor(deps: { db: DatabaseSync; sealer: Sealer; now: () => number }) {
    this.db = deps.db
    this.sealer = deps.sealer
    this.now = deps.now
    migrateDocuments(this.db)
  }

  private ctx = (tenantId: string, id: string, part: string) => `document:${part}:${tenantId}:${id}`

  /** Deletes every document past its retention date, with its facts. */
  sweepExpired(): number {
    const res = this.db.prepare('DELETE FROM documents WHERE retention_until <= ?').run(this.now())
    return Number(res.changes)
  }

  findByHash(tenantId: string, sha: string): DocumentView | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE user_id = ? AND sha256 = ?').get(tenantId, sha) as DocRow | undefined
    return row ? this.view(tenantId, row) : null
  }

  countForProject(tenantId: string, projectId: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND project_id = ?').get(tenantId, projectId) as { n: number }).n
  }

  create(tenantId: string, input: { projectId: string; findingId: string | null; kind: DocumentKind; format: DocumentFormat; sha256: string; size: number; filename: string; content: { text: string } | { base64: string }; createdBy: string; retentionMs?: number }): DocumentView {
    const id = `doc_${randomUUID()}`
    const at = this.now()
    const status: DocumentStatus = input.format === 'pdf' ? 'unsupported_format' : 'received'
    this.db.prepare(`INSERT INTO documents (id, user_id, project_id, finding_id, kind, format, status, sha256, size, filename_sealed, content_sealed, created_by, created_at, retention_until)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, tenantId, input.projectId, input.findingId, input.kind, input.format, status, input.sha256, input.size,
        this.sealer.seal(this.ctx(tenantId, id, 'name'), input.filename), this.sealer.seal(this.ctx(tenantId, id, 'content'), input.content),
        input.createdBy, at, at + (input.retentionMs ?? DEFAULT_RETENTION_MS))
    return this.get(tenantId, id)!
  }

  get(tenantId: string, id: string): DocumentView | null {
    const row = this.db.prepare('SELECT * FROM documents WHERE user_id = ? AND id = ?').get(tenantId, id) as DocRow | undefined
    return row ? this.view(tenantId, row) : null
  }

  list(tenantId: string, projectId: string, findingId?: string | null): DocumentView[] {
    const rows = (findingId
      ? this.db.prepare('SELECT * FROM documents WHERE user_id = ? AND project_id = ? AND finding_id = ? ORDER BY created_at, id').all(tenantId, projectId, findingId)
      : this.db.prepare('SELECT * FROM documents WHERE user_id = ? AND project_id = ? ORDER BY created_at, id').all(tenantId, projectId)) as unknown as DocRow[]
    return rows.map((r) => this.view(tenantId, r))
  }

  /** The stored text, for parsing on this server only. Null for a PDF. */
  text(tenantId: string, id: string): string | null {
    const row = this.db.prepare('SELECT content_sealed, format FROM documents WHERE user_id = ? AND id = ?').get(tenantId, id) as Pick<DocRow, 'content_sealed' | 'format'> | undefined
    if (!row || row.format === 'pdf') return null
    return this.sealer.open<{ text: string }>(this.ctx(tenantId, id, 'content'), row.content_sealed).text
  }

  markExtracted(tenantId: string, id: string): void {
    this.db.prepare("UPDATE documents SET status = 'extracted', extracted_at = ? WHERE user_id = ? AND id = ? AND status != 'unsupported_format'").run(this.now(), tenantId, id)
  }

  delete(tenantId: string, id: string): boolean {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('DELETE FROM proposed_facts WHERE user_id = ? AND document_id = ?').run(tenantId, id)
      const res = this.db.prepare('DELETE FROM documents WHERE user_id = ? AND id = ?').run(tenantId, id)
      this.db.exec('COMMIT')
      return Number(res.changes) === 1
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private view(tenantId: string, row: DocRow): DocumentView {
    return {
      id: row.id, projectId: row.project_id, findingId: row.finding_id, kind: row.kind, format: row.format, status: row.status,
      sha256: row.sha256, size: row.size, filename: this.sealer.open<string>(this.ctx(tenantId, row.id, 'name'), row.filename_sealed),
      createdAt: row.created_at, createdBy: row.created_by, retentionUntil: row.retention_until, extractedAt: row.extracted_at, note: NOTES[row.status],
    }
  }

  // ---------- proposed facts ----------

  private factCtx = (tenantId: string, id: string) => `proposed_fact:${tenantId}:${id}`

  /**
   * Adds facts for one document (already-known ids are left as they are, so
   * re-reading a document is idempotent), then re-marks conflicts across
   * every fact of the document, whatever read it.
   */
  addFacts(tenantId: string, doc: DocumentView, facts: ProposedFact[], meta: { caseFingerprint: string | null; invocationId?: string | null }): FactView[] {
    const at = this.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const insert = this.db.prepare(`INSERT OR IGNORE INTO proposed_facts (id, user_id, document_id, project_id, finding_id, kind, origin, status, confidence, body_sealed, case_fingerprint, invocation_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`)
      for (const f of facts) {
        // A reading that already conflicts lost its original confidence; it never rises above medium again.
        const base = f.origin === 'ai' ? 'low' : f.conflicts.length ? 'medium' : f.confidence
        insert.run(f.id, tenantId, doc.id, doc.projectId, doc.findingId, f.kind, f.origin, f.confidence, this.sealFact(tenantId, f, base), meta.caseFingerprint, meta.invocationId ?? null, at)
      }
      this.remark(tenantId, doc.id)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
    return this.factsForDocument(tenantId, doc.id)
  }

  /** Conflicts are recomputed over the document's live facts (rejected ones don't count). */
  private remark(tenantId: string, documentId: string): void {
    const rows = this.db.prepare("SELECT id, body_sealed FROM proposed_facts WHERE user_id = ? AND document_id = ? AND status != 'rejected'").all(tenantId, documentId) as Array<{ id: string; body_sealed: string }>
    const bases = new Map(rows.map((r) => [r.id, this.sealer.open<SealedFact>(this.factCtx(tenantId, r.id), r.body_sealed).baseConfidence ?? 'low']))
    const live = this.factsForDocument(tenantId, documentId).filter((f) => bases.has(f.id))
    const update = this.db.prepare('UPDATE proposed_facts SET body_sealed = ?, confidence = ? WHERE user_id = ? AND id = ?')
    for (const f of markConflicts(live.map((v) => ({ ...v, conflicts: [], confidence: bases.get(v.id)! })))) {
      update.run(this.sealFact(tenantId, f, bases.get(f.id)!), f.confidence, tenantId, f.id)
    }
  }

  private sealFact(tenantId: string, f: ProposedFact, baseConfidence: ProposedFact['confidence']): string {
    const body: SealedFact = { value: f.value, amountMinor: f.amountMinor, row: f.row, provenance: f.provenance, conflicts: f.conflicts, baseConfidence }
    return this.sealer.seal(this.factCtx(tenantId, f.id), body)
  }

  factsForDocument(tenantId: string, documentId: string): FactView[] {
    const rows = this.db.prepare('SELECT * FROM proposed_facts WHERE user_id = ? AND document_id = ? ORDER BY created_at, id').all(tenantId, documentId) as unknown as FactRow[]
    return rows.map((r) => this.factView(tenantId, r)).sort((a, b) => a.provenance.line - b.provenance.line || a.provenance.charStart - b.provenance.charStart || a.kind.localeCompare(b.kind))
  }

  factsForCase(tenantId: string, projectId: string, findingId: string): FactView[] {
    const docs = this.list(tenantId, projectId, findingId)
    return docs.flatMap((d) => this.factsForDocument(tenantId, d.id))
  }

  fact(tenantId: string, documentId: string, factId: string): FactView | null {
    const row = this.db.prepare('SELECT * FROM proposed_facts WHERE user_id = ? AND document_id = ? AND id = ?').get(tenantId, documentId, factId) as FactRow | undefined
    return row ? this.factView(tenantId, row) : null
  }

  factCaseFingerprint(tenantId: string, factId: string): string | null {
    const row = this.db.prepare('SELECT case_fingerprint FROM proposed_facts WHERE user_id = ? AND id = ?').get(tenantId, factId) as { case_fingerprint: string | null } | undefined
    return row?.case_fingerprint ?? null
  }

  /** The verifier's answer. `rejected` retires the fact; anything else records that it was handed off. Never touches the case. */
  recordVerification(tenantId: string, documentId: string, factId: string, v: { verifier: string; fixture: boolean; outcome: VerificationOutcome; reason: string }): FactView {
    this.db.prepare('UPDATE proposed_facts SET status = ?, verifier = ?, verifier_fixture = ?, verifier_outcome = ?, verifier_reason = ?, verified_at = ? WHERE user_id = ? AND document_id = ? AND id = ?')
      .run(v.outcome === 'rejected' ? 'rejected' : 'handed_off', v.verifier, v.fixture ? 1 : 0, v.outcome, v.reason.slice(0, 500), this.now(), tenantId, documentId, factId)
    this.remark(tenantId, documentId)
    return this.fact(tenantId, documentId, factId)!
  }

  private factView(tenantId: string, r: FactRow): FactView {
    const body = this.sealer.open<SealedFact>(this.factCtx(tenantId, r.id), r.body_sealed)
    return {
      id: r.id, documentId: r.document_id, kind: r.kind as FactView['kind'], value: body.value,
      ...(body.amountMinor !== undefined && body.amountMinor !== null ? { amountMinor: body.amountMinor } : {}),
      ...(body.row !== undefined && body.row !== null ? { row: body.row } : {}),
      provenance: body.provenance, confidence: r.confidence as FactView['confidence'], conflicts: body.conflicts ?? [], origin: r.origin,
      status: r.status, projectId: r.project_id, findingId: r.finding_id, createdAt: r.created_at,
      verification: r.verifier ? { verifier: r.verifier, fixture: r.verifier_fixture === 1, outcome: r.verifier_outcome!, reason: r.verifier_reason ?? '', at: r.verified_at! } : null,
      authoritative: false,
    }
  }
}
