import type { DatabaseSync } from 'node:sqlite'
import { openSecret, passesKeyCheck, sealKeyCheck, sealSecret } from './crypto.ts'
import { HttpError } from './http.ts'

type Project = Record<string, unknown>
type Keys = { current: Buffer; previous: Buffer | null } | null

/** A stored audit that could not be opened. It stays in the database exactly as it is. */
export interface UnreadableProject {
  id: string
  createdAt: number
  updatedAt: number
}

/**
 * Saved audits at rest. Each payload (every record, finding, decision and
 * recovery note in an audit) is sealed with AES-256-GCM under DATA_KEY, with
 * the owning user and audit bound in as associated data: a sealed payload
 * copied onto another account's row, or another audit's, fails to open.
 *
 * Rows written before encryption hold plain JSON (it starts with `{`; a
 * sealed value starts with `v1.`). Both read correctly, and `migrate()` seals
 * the plain ones at startup. The audit's name and file name are kept only
 * inside the sealed payload; the plain columns stay empty.
 *
 * Without a key (development only: production refuses to start) payloads are
 * stored as plain JSON, exactly as before.
 */
export class ProjectStore {
  private readonly db: DatabaseSync
  private readonly keys: Keys

  constructor(db: DatabaseSync, keys: Keys) {
    this.db = db
    this.keys = keys
    // Deleted and overwritten content is zeroed in the file rather than left
    // in free pages: replaced plaintext, deleted audits, deleted accounts.
    db.exec('PRAGMA secure_delete = ON')
    db.exec('CREATE TABLE IF NOT EXISTS data_key_check (id INTEGER PRIMARY KEY CHECK (id = 1), sealed TEXT NOT NULL)')
  }

  get encrypted(): boolean {
    return this.keys !== null
  }

  /** Every audit that opens. One that doesn't is left out here and named by `unreadable`. */
  list(userId: string): Project[] {
    return this.listAll(userId).projects
  }

  unreadable(userId: string): UnreadableProject[] {
    return this.listAll(userId).unreadable
  }

  listAll(userId: string): { projects: Project[]; unreadable: UnreadableProject[] } {
    const rows = this.db.prepare('SELECT id, payload, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as Array<{ id: string; payload: string; created_at: number; updated_at: number }>
    const projects: Project[] = []
    const unreadable: UnreadableProject[] = []
    for (const row of rows) {
      try {
        projects.push(this.decode(userId, row.id, row.payload))
      } catch {
        unreadable.push({ id: row.id, createdAt: row.created_at, updatedAt: row.updated_at })
      }
    }
    if (unreadable.length) console.error(`${unreadable.length} of ${rows.length} stored audits on one account could not be opened; they were left as they are`)
    return { projects, unreadable }
  }

  /** Throws when the audit is stored but can't be opened, so nothing is ever saved over it. */
  get(userId: string, projectId: string): Project | null {
    const row = this.db.prepare('SELECT payload FROM projects WHERE user_id = ? AND id = ?').get(userId, projectId) as { payload: string } | undefined
    if (!row) return null
    try {
      return this.decode(userId, projectId, row.payload)
    } catch {
      const reason = !this.keys && isSealed(row.payload) ? ' DATA_KEY is not set on this server.' : ''
      throw new HttpError(409, `This audit can’t be opened on the server right now, so nothing was changed.${reason}`, 'audit_unreadable')
    }
  }

  exists(userId: string, projectId: string): boolean {
    return this.db.prepare('SELECT 1 FROM projects WHERE user_id = ? AND id = ?').get(userId, projectId) !== undefined
  }

  revision(userId: string, projectId: string): number | null {
    const row = this.db.prepare('SELECT revision FROM projects WHERE user_id = ? AND id = ?').get(userId, projectId) as { revision: number } | undefined
    return row?.revision ?? null
  }

  upsert(userId: string, project: Project): number {
    const id = project.id as string
    // The very first sealed audit also fixes which key this database is under.
    if (this.keys && !this.keyCheck() && !this.sealedRows().length) this.writeKeyCheck()
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO projects (user_id, id, name, source_label, mode, created_at, updated_at, payload, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(user_id, id) DO UPDATE SET name = excluded.name, source_label = excluded.source_label, mode = excluded.mode, updated_at = excluded.updated_at, payload = excluded.payload, revision = projects.revision + 1`
      )
      .run(
        userId,
        id,
        this.keys ? '' : (project.name as string),
        this.keys ? '' : typeof project.sourceLabel === 'string' ? project.sourceLabel : '',
        project.mode === 'sample' ? 'sample' : 'upload',
        // Server time: created_at is when this server first stored the audit, whatever the client claims.
        now,
        now,
        this.encode(userId, id, JSON.stringify(project))
      )
    return this.revision(userId, id)!
  }

  delete(userId: string, projectId: string): void {
    this.db.prepare('DELETE FROM projects WHERE user_id = ? AND id = ?').run(userId, projectId)
  }

  private keyCheck(): string | null {
    return (this.db.prepare('SELECT sealed FROM data_key_check WHERE id = 1').get() as { sealed: string } | undefined)?.sealed ?? null
  }

  private writeKeyCheck(): void {
    this.db.prepare('INSERT INTO data_key_check (id, sealed) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET sealed = excluded.sealed').run(sealKeyCheck(this.keys!.current))
  }

  private sealedRows(): Array<{ user_id: string; id: string; payload: string }> {
    return this.db.prepare("SELECT user_id, id, payload FROM projects WHERE payload LIKE 'v1.%'").all() as Array<{ user_id: string; id: string; payload: string }>
  }

  /**
   * Refuses to go on under a key this database was not sealed with. Without
   * this a mistyped DATA_KEY starts cleanly, fails on every old audit, and
   * seals new ones under a key nobody kept.
   */
  private verifyKey(): void {
    const keys = this.keys!
    const opensSomeAudit = (candidates: Buffer[]) => this.sealedRows().some((row) => candidates.some((key) => this.opens(row.payload, key, row.user_id, row.id)))
    const check = this.keyCheck()
    const known = check !== null && (passesKeyCheck(check, keys.current) || (keys.previous !== null && passesKeyCheck(check, keys.previous)))
    if (known) return
    if (check === null) {
      // From before the check existed: the audits themselves say which key is right.
      if (!this.sealedRows().length || opensSomeAudit(keys.previous ? [keys.current, keys.previous] : [keys.current])) return
    } else if (opensSomeAudit([keys.current])) {
      console.warn('The stored DATA_KEY check was damaged; DATA_KEY still opens stored audits, so the check was written again.')
      return
    }
    throw new Error(
      'DATA_KEY is not the key the stored audits were encrypted with, so the server did not start and nothing was changed. ' +
        'Set DATA_KEY back to the original key. If you are rotating it, set DATA_KEY_PREVIOUS to the original key as well (docs/deploy.md §6).'
    )
  }

  /**
   * Seals every plain-JSON row, and re-seals rows still under DATA_KEY_PREVIOUS
   * during a rotation. When anything changed, the file is rebuilt (VACUUM) and
   * the WAL checkpointed and truncated, so no plaintext copy stays in the
   * database file, its free pages or its WAL. Returns how many rows changed.
   * A row that opens under neither key is skipped and left as it is. Throws when
   * the key is not this database's key at all.
   */
  migrate(): number {
    if (!this.keys) {
      const sealed = (this.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE payload LIKE 'v1.%'").get() as { n: number }).n
      if (sealed) console.warn(`${sealed} stored audits are encrypted but DATA_KEY is not set: they can't be read until it is.`)
      return 0
    }
    this.verifyKey()
    const { previous } = this.keys
    const rows = this.db.prepare(previous ? 'SELECT user_id, id, payload FROM projects' : "SELECT user_id, id, payload FROM projects WHERE payload NOT LIKE 'v1.%'").all() as Array<{
      user_id: string
      id: string
      payload: string
    }>
    const update = this.db.prepare("UPDATE projects SET payload = ?, name = '', source_label = '' WHERE user_id = ? AND id = ?")
    let changed = 0
    let skipped = 0
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of rows) {
        if (isSealed(row.payload) && this.opens(row.payload, this.keys.current, row.user_id, row.id)) continue
        if (isSealed(row.payload) && !this.opens(row.payload, previous!, row.user_id, row.id)) {
          skipped += 1
          continue
        }
        const plain = isSealed(row.payload) ? openSecret(row.payload, previous!, context(row.user_id, row.id)) : row.payload
        update.run(sealSecret(plain, this.keys.current, context(row.user_id, row.id)), row.user_id, row.id)
        changed += 1
      }
      const check = this.keyCheck()
      if (check === null || !passesKeyCheck(check, this.keys.current)) this.writeKeyCheck()
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw new Error(`Could not encrypt stored audits; nothing was changed. ${err instanceof Error ? err.message : ''}`.trim())
    }
    if (skipped) console.error(`${skipped} stored audits open under neither DATA_KEY nor DATA_KEY_PREVIOUS; they were left as they are. Keep every earlier key until this is resolved.`)
    if (changed) scrub(this.db)
    return changed
  }

  private encode(userId: string, projectId: string, json: string): string {
    return this.keys ? sealSecret(json, this.keys.current, context(userId, projectId)) : json
  }

  private decode(userId: string, projectId: string, payload: string): Project {
    if (!isSealed(payload)) return JSON.parse(payload) as Project
    if (!this.keys) throw new Error('This audit is encrypted and DATA_KEY is not set.')
    const ctx = context(userId, projectId)
    try {
      return JSON.parse(openSecret(payload, this.keys.current, ctx)) as Project
    } catch (err) {
      // Mid-rotation, before migrate() has re-sealed this row.
      if (this.keys.previous) return JSON.parse(openSecret(payload, this.keys.previous, ctx)) as Project
      throw err
    }
  }

  private opens(payload: string, key: Buffer, userId: string, projectId: string): boolean {
    try {
      openSecret(payload, key, context(userId, projectId))
      return true
    } catch {
      return false
    }
  }
}

/**
 * Rewrites the database file without free pages and folds the WAL back in,
 * truncating it. Call after removing data that must not linger on disk.
 */
export function scrub(db: DatabaseSync): void {
  db.exec('VACUUM')
  checkpointWal(db)
}

/** Folds the WAL into the database file and truncates it, dropping older copies of every page. */
export function checkpointWal(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
}

const isSealed = (payload: string) => payload.startsWith('v1.')
const context = (userId: string, projectId: string) => `project:${userId}:${projectId}`
