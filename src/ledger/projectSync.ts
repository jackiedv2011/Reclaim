/**
 * Keeps an account's projects on the server. The browser copy is the working
 * cache (synchronous, what the UI reads); the server copy is what survives a
 * new device or a cleared browser, and what makes the account boundary real.
 *
 * The queue holds what has to happen — "save project X", "run this case
 * command", "delete project X" — never a copy of a project: a save reads the
 * project as it stands when it is sent. Each queued step is stored under its
 * own key, so two tabs share one queue without overwriting each other's, and
 * a project whose step is refused holds up only itself.
 */
import { getStorageScope, storageKey } from '@/lib/storageScope'

type Raw = Record<string, unknown>

/** A finding as it stood before the queued command that changed it, so a save sent first can leave that change out. */
export interface PendingCommand {
  findingId: string
  before?: Raw
}

type Op = { key: string; id: string } & (
  | { kind: 'put' }
  | { kind: 'delete' }
  | ({ kind: 'command'; type: string; input: unknown; commandId: string } & PendingCommand)
)
type CommandOp = Op & { kind: 'command' }

/** The case content of a project as the server holds it, exactly as it sent or accepted it. */
export interface CaseBase {
  caseStates: Raw
  findings: Map<string, Raw>
  /** Import batches: a save may replace the server's copy only if it has every one of these. */
  batches: string[]
}

/** What the queue needs from the browser's copies (projects.ts). */
export interface LocalProjects {
  /**
   * The project as it should be sent: the current copy, with case content the
   * server hasn't accepted put back to what it holds (`base`, or for a project
   * it has never seen, to before the pending commands). Null when this tab has
   * no copy. `lost` is set when a local decision was left out that no queued
   * command will deliver.
   */
  wire(id: string, context: { base: CaseBase | null; pending: PendingCommand[] }): { json: string; base: CaseBase; lost: boolean } | null
  /** The project in full, for an account import. */
  full(id: string): string | null
  /** Projects with changes the server has not confirmed. */
  unsavedIds(): string[]
  name(id: string): string | null
  markSaved(id: string): void
  applyCase(id: string, change: CaseChange): void
  replace(raw: Raw): void
  /** Whether this app can open a project the server sent. */
  canOpen(raw: Raw): boolean
  remove(id: string): void
}

/** One case as the server now holds it. */
export interface CaseChange {
  findingId: string
  state: unknown
  finding: unknown
  updatedAt?: unknown
}

export interface SyncIssueDetail {
  projectId: string
  status: number | null
  message: string
  /**
   * waiting: will be retried by itself. signed_out: the next log-in resumes it.
   * refused: the server said no, and the person decides. gone: deleted on
   * another device while this browser still had changes. undone: a change the
   * server refused was taken back (nothing is waiting).
   */
  kind: 'waiting' | 'signed_out' | 'refused' | 'gone' | 'undone'
  name?: string | null
  /** For a refusal: whether the account has a saved version to go back to. */
  savedVersion?: boolean
}
export type SyncIssue = SyncIssueDetail | null

export interface ImportResult {
  imported: string[]
  skipped: string[]
  blocked: string[]
  failed: Array<{ id: string; message: string }>
}

/** The server answered, and the answer was no. Anything else thrown means it could not be reached. */
export class ServerAnswer extends Error {
  readonly status: number
  readonly code?: string
  constructor(status: number, message: string, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const OP_KEY = 'reclaim.project.sync.v2.'
const REVISION_KEY = 'reclaim.project.revision.v1.'
/** The single-key queue used before, which held whole projects. Read once, then removed. */
const OLD_QUEUE_KEY = 'reclaim.project.sync.v1'
const RETRY_MS = 15_000
const COMPRESS_ABOVE = 64 * 1024

const isTransient = (status: number) => status === 408 || status === 429 || status >= 500

async function readJson(res: Response): Promise<Raw> {
  try {
    return ((await res.json()) ?? {}) as Raw
  } catch {
    return {}
  }
}

async function answerError(res: Response): Promise<ServerAnswer> {
  const body = await readJson(res)
  return new ServerAnswer(res.status, typeof body.message === 'string' && body.message ? body.message : `The server refused this save (${res.status}).`, typeof body.code === 'string' ? body.code : undefined)
}

/** A saved audit is mostly repeated keys: compressed, 50,000 rows is about 13 MB instead of 110. */
async function encodeBody(json: string): Promise<{ body: BodyInit; headers: Record<string, string> }> {
  if (json.length < COMPRESS_ABOVE || typeof CompressionStream === 'undefined') return { body: json, headers: {} }
  const stream = new Response(json).body!.pipeThrough(new CompressionStream('gzip'))
  return { body: await new Response(stream).arrayBuffer(), headers: { 'Content-Encoding': 'gzip' } }
}

export function caseBase(raw: Raw): CaseBase {
  const env = (raw.environment ?? {}) as { caseStates?: Raw; imports?: Array<{ id?: unknown }>; result?: { findings?: Raw[] } }
  return {
    caseStates: env.caseStates ?? {},
    findings: new Map((env.result?.findings ?? []).map((finding) => [String(finding.id), finding])),
    batches: (env.imports ?? []).map((batch) => String(batch?.id)),
  }
}

const holdsAll = (ours: CaseBase, theirs: CaseBase) => {
  const have = new Set(ours.batches)
  return theirs.batches.every((batch) => have.has(batch))
}

let counter = 0
/** Sorts in the order steps were taken, across tabs of one browser. */
const nextKey = () => `${Date.now().toString(36).padStart(9, '0')}-${(counter++).toString(36).padStart(5, '0')}-${Math.random().toString(36).slice(2, 8)}`

export class ProjectSync {
  private ops: Op[] = []
  /** Keys of ops that are also in browser storage, shared with other tabs. */
  private stored = new Set<string>()
  /** Keys of ops this tab queued itself. */
  private mine = new Set<string>()
  /** Ops (from other tabs) for a project this tab has no copy of: that tab sends them. */
  private notOurs = new Set<string>()
  /** Ops that could not be stored when the account was left, kept for its next log-in in this tab. */
  private parked = new Map<string, Op[]>()
  private scope: string | null = null
  private sending: Op | null = null
  private inflight: Promise<void> | null = null
  private again = false
  private paused = false
  /** Moves on whenever the queue is cleared, so a request from before can't speak for the account after it. */
  private epoch = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private revisions = new Map<string, number>()
  private bases = new Map<string, CaseBase>()
  /** Moved on in another tab: check what the server holds before saving over it. */
  private unsure = new Set<string>()
  /** Rebased onto a newer server copy: fetched in full once its queue is empty. */
  private stale = new Set<string>()
  private stopped = new Map<string, SyncIssueDetail>()
  private undone: SyncIssueDetail[] = []
  private session: SyncIssueDetail | null = null
  private waiting: SyncIssueDetail | null = null
  private local: LocalProjects | null = null
  private fetchImpl: typeof fetch = (...args) => fetch(...args)
  private listeners = new Set<(pending: number) => void>()

  /** Tests inject a fetch bound to a live server. */
  useFetch(impl: typeof fetch): void {
    this.fetchImpl = impl
  }

  useLocal(local: LocalProjects): void {
    this.local = local
  }

  onPending(listener: (pending: number) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    this.listeners.forEach((listener) => listener(this.pending))
  }

  // ---------- what the page shows ----------

  /** Everything the person should know about, most pressing first. */
  get issues(): SyncIssueDetail[] {
    return [...(this.session ? [this.session] : []), ...this.stopped.values(), ...this.undone, ...(this.waiting ? [this.waiting] : [])]
  }

  get syncIssue(): SyncIssue {
    return this.issues[0] ?? null
  }

  /** Steps on their way to the server. A refused one is not: it waits for the person, and says so. */
  get pending(): number {
    return this.ops.filter((op) => !this.stopped.has(op.id)).length
  }

  /** Everything that has not reached the server, refused or not. */
  get unsent(): number {
    return this.ops.length
  }

  hasUnsent(id: string): boolean {
    return this.ops.some((op) => op.id === id)
  }

  deleting(id: string): boolean {
    return this.ops.some((op) => op.id === id && op.kind === 'delete')
  }

  /** The server revision this browser last confirmed. Undefined: it has never seen the server hold this project. */
  revisionOf(id: string): number | undefined {
    return this.revisions.get(id)
  }

  // ---------- the stored queue ----------

  private shared(): Storage | null {
    const scope = getStorageScope()
    return scope && scope !== 'guest' && typeof window !== 'undefined' ? window.localStorage : null
  }

  private add(op: Op): void {
    this.scope ??= getStorageScope()
    this.ops.push(op)
    this.mine.add(op.key)
    try {
      const store = this.shared()
      if (store) {
        store.setItem(storageKey(OP_KEY) + op.key, JSON.stringify(op))
        this.stored.add(op.key)
      }
    } catch {
      // Storage is full. The step still goes out from this tab: a failed copy must never block the save itself.
    }
  }

  private drop(test: (op: Op) => boolean): void {
    const gone = this.ops.filter(test)
    if (!gone.length) return
    this.ops = this.ops.filter((op) => !gone.includes(op))
    for (const { key } of gone) {
      this.mine.delete(key)
      if (this.stored.delete(key)) this.shared()?.removeItem(storageKey(OP_KEY) + key)
    }
  }

  private setRevision(id: string, revision: number | null): void {
    if (revision === null) this.revisions.delete(id)
    else this.revisions.set(id, revision)
    try {
      const store = this.shared()
      if (revision === null) store?.removeItem(storageKey(REVISION_KEY) + id)
      else store?.setItem(storageKey(REVISION_KEY) + id, String(revision))
    } catch {
      // Only a hint: without it the next save asks the server for the revision.
    }
  }

  private keysUnder(prefix: string): string[] {
    const store = this.shared()
    if (!store) return []
    const found: string[] = []
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (key?.startsWith(prefix)) found.push(key)
    }
    return found
  }

  /** Match this tab's view of the queue to the stored one: steps other tabs added, and steps they finished. */
  private syncFromStorage(): void {
    const store = this.shared()
    if (!store) return
    const prefix = storageKey(OP_KEY)
    const present = new Set(this.keysUnder(prefix).map((key) => key.slice(prefix.length)))
    const finished = this.ops.filter((op) => this.stored.has(op.key) && !present.has(op.key))
    for (const op of finished) this.stored.delete(op.key)
    if (finished.length) this.ops = this.ops.filter((op) => !finished.includes(op))
    let added = false
    for (const key of present) {
      if (this.stored.has(key) || this.notOurs.has(key)) continue
      try {
        const op = JSON.parse(store.getItem(prefix + key) ?? 'null') as Op | null
        if (!op || typeof op.id !== 'string' || !['put', 'command', 'delete'].includes(op.kind)) continue
        this.ops.push({ ...op, key })
        this.stored.add(key)
        added = true
      } catch {
        // Not readable: leave it, and let the pending marker re-send its project.
      }
    }
    if (added) this.ops.sort((a, b) => (a.key < b.key ? -1 : 1))
    if (added || finished.length) this.changed()
  }

  /** Another tab changed the queue or a revision. */
  storageChanged(event: Pick<StorageEvent, 'key' | 'newValue'>): void {
    if (!event.key || !this.shared()) return
    if (event.key.startsWith(storageKey(OP_KEY))) this.syncFromStorage()
    else if (event.key.startsWith(storageKey(REVISION_KEY))) {
      const id = event.key.slice(storageKey(REVISION_KEY).length)
      if (event.newValue === null) this.revisions.delete(id)
      else this.revisions.set(id, Number(event.newValue))
      this.bases.delete(id)
      this.unsure.add(id)
    }
  }

  /** Recover the account's unsent steps before pulling newer server data. */
  restore(): void {
    const scope = getStorageScope()
    if (scope !== this.scope) {
      this.park()
      this.clear()
      this.scope = scope
    }
    this.session = null
    this.waiting = null
    this.notOurs.clear()
    this.migrateOldQueue()
    const prefix = storageKey(REVISION_KEY)
    for (const key of this.keysUnder(prefix)) {
      const revision = Number(this.shared()!.getItem(key))
      if (Number.isSafeInteger(revision)) this.revisions.set(key.slice(prefix.length), revision)
    }
    this.syncFromStorage()
    if (scope) {
      for (const op of this.parked.get(scope) ?? []) if (!this.ops.some((known) => known.key === op.key)) this.ops.push(op)
      this.parked.delete(scope)
    }
    this.ops.sort((a, b) => (a.key < b.key ? -1 : 1))
    // Marked unsaved but nothing queued (the queue entry couldn't be stored, or an older version dropped it): save it now.
    for (const id of this.local?.unsavedIds() ?? []) if (!this.hasUnsent(id)) this.add({ key: nextKey(), id, kind: 'put' })
    this.changed()
  }

  /** Steps that only this tab's memory holds, kept for the account's next log-in in this tab. */
  private park(): void {
    const left = this.ops.filter((op) => !this.stored.has(op.key))
    if (left.length && this.scope) this.parked.set(this.scope, left)
  }

  private migrateOldQueue(): void {
    const store = this.shared()
    const raw = store?.getItem(storageKey(OLD_QUEUE_KEY))
    if (!store || !raw) return
    // Free its space first: it may be what is stopping anything else from being stored.
    store.removeItem(storageKey(OLD_QUEUE_KEY))
    try {
      type OldOp = { kind: 'put'; project: Raw } | { kind: 'delete'; id: string } | { kind: 'command'; id: string; findingId: string; type: string; input: unknown; commandId: string }
      const saved = JSON.parse(raw) as { queue?: OldOp[]; revisions?: Array<[string, number]> }
      for (const [id, revision] of saved.revisions ?? []) this.setRevision(id, revision)
      for (const op of saved.queue ?? []) {
        if (op.kind === 'put') {
          const id = String(op.project.id)
          if (!this.local?.full(id)) this.local?.replace(op.project)
          this.add({ key: nextKey(), id, kind: 'put' })
        } else this.add({ ...op, key: nextKey() })
      }
    } catch {
      // Unreadable. The projects themselves are still here, and their pending markers re-send them.
    }
  }

  // ---------- adding to the queue ----------

  /** Save this project. What is sent is the copy as it stands when it goes out. */
  push(id: string): void {
    // A save not yet under way covers this one too. One already being sent, or with a command behind it, does not.
    const last = this.ops.findLast((op) => op.id === id)
    if (!(last?.kind === 'put' && last !== this.sending)) this.add({ key: nextKey(), id, kind: 'put' })
    this.changed()
    void this.flush()
  }

  command(id: string, findingId: string, type: string, input: unknown, before?: Raw): void {
    this.add({ key: nextKey(), id, kind: 'command', findingId, type, input, commandId: crypto.randomUUID(), ...(before ? { before } : {}) })
    this.changed()
    void this.flush()
  }

  /** Delete a project. Nothing else queued for it matters any more. */
  remove(id: string): void {
    this.drop((op) => op.id === id)
    this.clearIssues(id)
    this.add({ key: nextKey(), id, kind: 'delete' })
    this.changed()
    void this.flush()
  }

  private clearIssues(id: string): void {
    this.stopped.delete(id)
    this.undone = this.undone.filter((issue) => issue.projectId !== id)
    if (this.waiting?.projectId === id) this.waiting = null
  }

  // ---------- reading the account ----------

  /** The account's audits and their revisions. Throws when the list can't be had: that is not an empty account. */
  async remoteRevisions(): Promise<Record<string, number>> {
    const res = await this.fetchImpl('/api/projects?index=1', { credentials: 'same-origin' })
    if (!res.ok) throw await answerError(res)
    const data = (await res.json()) as { revisions?: Record<string, number> } | null
    if (typeof data?.revisions !== 'object' || data.revisions === null) throw new Error('The list of audits could not be read.')
    return data.revisions
  }

  /** One audit from the account, or null when it isn't there. */
  async fetchRemote(id: string): Promise<{ project: Raw; revision: number } | null> {
    const res = await this.fetchImpl(`/api/projects/${encodeURIComponent(id)}`, { credentials: 'same-origin' })
    if (res.status === 404) return null
    if (!res.ok) throw await answerError(res)
    const remote = (await res.json()) as { project?: Raw; revision?: number } | null
    if (!remote?.project || typeof remote.revision !== 'number') throw new ServerAnswer(502, 'The saved audit could not be read.')
    return { project: remote.project, revision: remote.revision }
  }

  /** The browser now holds (or has seen) this server copy. */
  noteRemote(id: string, remote: { project: Raw; revision: number }): void {
    this.setRevision(id, remote.revision)
    this.bases.set(id, caseBase(remote.project))
    this.unsure.delete(id)
  }

  /** The server no longer has it, and neither does this browser. */
  forget(id: string): void {
    this.drop((op) => op.id === id)
    this.setRevision(id, null)
    this.bases.delete(id)
    this.stale.delete(id)
    this.clearIssues(id)
    this.changed()
  }

  /** Audits whose account copy is not the one this browser last confirmed. One that can't be read is left out, not fatal. */
  async pull(): Promise<Raw[]> {
    const changed: Raw[] = []
    for (const [id, revision] of Object.entries(await this.remoteRevisions())) {
      if (this.revisionOf(id) === revision || this.hasUnsent(id)) continue
      try {
        const remote = await this.fetchRemote(id)
        if (!remote || this.local?.canOpen(remote.project) === false) continue
        this.noteRemote(id, remote)
        changed.push(remote.project)
      } catch (err) {
        if (!(err instanceof ServerAnswer) || err.status === 401) throw err
      }
    }
    return changed
  }

  /**
   * Add audits to the account, keeping their ids. One request each: one that
   * is refused doesn't cost the others. Those are reported as blocked, so the
   * caller keeps their local copies, and said out loud; if nothing got through
   * at all this throws with the reason.
   */
  async import(projects: Raw[]): Promise<ImportResult> {
    const result = await this.importEach(projects.map((project) => ({ id: String(project.id), json: JSON.stringify(project) })))
    const { failed } = result
    if (failed.length && failed.length === projects.length) throw new Error(`Nothing was added: ${failed[0].message}`)
    if (failed.length) {
      this.undone.push({ projectId: '', kind: 'undone', status: null, message: `${failed.length} of ${projects.length} audits couldn’t be added to your account: ${failed[0].message} They are still in this browser.` })
      this.changed()
    }
    return { ...result, blocked: [...result.blocked, ...failed.map(({ id }) => id)] }
  }

  private async importEach(projects: Array<{ id: string; json: string }>): Promise<ImportResult> {
    const result: ImportResult = { imported: [], skipped: [], blocked: [], failed: [] }
    for (const project of projects) {
      try {
        const { body, headers } = await encodeBody(`{"projects":[${project.json}]}`)
        const res = await this.fetchImpl('/api/projects/import', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...headers }, body })
        if (!res.ok) throw await answerError(res)
        const answer = (await res.json()) as Partial<ImportResult>
        result.imported.push(...(answer.imported ?? []))
        result.skipped.push(...(answer.skipped ?? []))
        result.blocked.push(...(answer.blocked ?? []))
      } catch (err) {
        result.failed.push({ id: project.id, message: err instanceof ServerAnswer ? err.message : 'The server could not be reached.' })
      }
    }
    return result
  }

  // ---------- what the person can do about a refusal ----------

  /** Try again: one project's refused step, or everything that is waiting. */
  retry(id?: string): void {
    if (id) this.clearIssues(id)
    this.session = null
    this.waiting = null
    this.changed()
    void this.flush()
  }

  /** Give up this browser's unsaved changes to a project and show the account's version. */
  async useSaved(id: string): Promise<void> {
    const remote = await this.fetchRemote(id)
    if (!remote) {
      this.markGone(id)
      this.changed()
      return
    }
    this.drop((op) => op.id === id)
    this.clearIssues(id)
    this.noteRemote(id, remote)
    this.local?.replace(remote.project)
    this.changed()
  }

  /** Remove a project the account doesn't have from this browser. */
  discard(id: string): void {
    this.local?.remove(id)
    this.forget(id)
  }

  /** It was deleted elsewhere, but this browser's copy is wanted: add it to the account again. */
  async keepAsNew(id: string): Promise<void> {
    const json = this.local?.full(id)
    if (!json) return this.discard(id)
    const result = await this.importEach([{ id, json }])
    if (result.failed.length) throw new Error(result.failed[0].message)
    if (result.blocked.length) {
      this.stopped.set(id, { projectId: id, kind: 'refused', status: 409, name: this.local?.name(id), savedVersion: false, message: 'Your plan doesn’t allow this audit to be added again. It is still in this browser.' })
      this.changed()
      return
    }
    await this.useSaved(id)
  }

  dismiss(issue: SyncIssueDetail): void {
    this.undone = this.undone.filter((known) => known !== issue)
    this.changed()
  }

  // ---------- sending ----------

  /** Nothing is sent until resume() (an account deletion is being asked for). */
  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    void this.flush()
  }

  /** Awaiting it means: everything queued so far reached the server, was refused, or is waiting for a connection. */
  flush(): Promise<void> {
    if (this.paused) return this.inflight ?? Promise.resolve()
    if (this.inflight) this.again = true
    else this.inflight = this.run()
    return this.inflight
  }

  private async run(): Promise<void> {
    try {
      do {
        this.again = false
        await this.exclusively(() => this.drain())
      } while (this.again && !this.paused && !this.session && !this.waiting)
    } finally {
      this.inflight = null
      this.changed()
    }
  }

  /** One tab sends at a time where the browser can arrange it. Where it can't, command ids and revisions keep a double send harmless. */
  private async exclusively(work: () => Promise<void>): Promise<void> {
    // Yield once, so that steps queued in the same turn are seen together (and `inflight` is set before any work).
    await Promise.resolve()
    const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
    if (!locks || !this.shared()) return work()
    await locks.request(`reclaim-sync:${getStorageScope()}`, work)
  }

  private next(skip: Set<string>): Op | null {
    const seen = new Set<string>()
    for (const op of this.ops) {
      // Only the first step of each project is sendable; the rest wait their turn behind it.
      if (seen.has(op.id)) continue
      seen.add(op.id)
      if (!this.stopped.has(op.id) && !skip.has(op.id)) return op
    }
    return null
  }

  private async drain(): Promise<void> {
    const { epoch } = this
    this.syncFromStorage()
    this.waiting = null
    const later = new Set<string>()
    for (;;) {
      if (this.paused || this.epoch !== epoch) return
      const op = this.next(later)
      if (!op) return
      if (this.stored.has(op.key) && this.shared()?.getItem(storageKey(OP_KEY) + op.key) === null) {
        // Another tab finished it.
        this.stored.delete(op.key)
        this.ops = this.ops.filter((known) => known !== op)
        continue
      }
      this.sending = op
      try {
        if (op.kind === 'put') await this.sendPut(op)
        else if (op.kind === 'command') await this.sendCommand(op)
        else await this.sendDelete(op)
      } catch (err) {
        if (this.epoch !== epoch) return
        if (err instanceof ServerAnswer && err.status === 401) {
          // Session gone — keep the queue; the next log-in flushes it.
          this.session = { projectId: op.id, status: 401, kind: 'signed_out', message: 'Your session ended before this save reached your account. The local copy is still here; sign in again to retry.' }
          return
        }
        const answered = err instanceof ServerAnswer
        this.waiting = {
          projectId: op.id,
          status: null,
          kind: 'waiting',
          message: answered ? 'The server couldn’t take this save just now. It will be tried again; your changes remain in this browser.' : 'The save is waiting for a connection. Your changes remain in this browser.',
        }
        console.warn('Reclaim: sync will retry —', err instanceof Error ? err.message : err)
        this.scheduleRetry()
        // No connection: nothing else will get through either. A server error may be about this project alone.
        if (!answered) return
        later.add(op.id)
      } finally {
        this.sending = null
        this.changed()
      }
    }
  }

  private scheduleRetry(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.retry()
    }, RETRY_MS)
  }

  /** Throws for anything worth retrying (and a lost session); returns every other answer. */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const res = await this.fetchImpl(path, { credentials: 'same-origin', ...init })
    if (res.status === 401 || isTransient(res.status)) throw await answerError(res)
    return res
  }

  private pendingCommands(id: string): PendingCommand[] {
    return this.ops.flatMap((op) => (op.kind === 'command' && op.id === id ? [{ findingId: op.findingId, before: op.before }] : []))
  }

  private async done(op: Op): Promise<void> {
    this.drop((known) => known === op)
    if (this.hasUnsent(op.id)) return
    if (this.stale.has(op.id)) {
      const { epoch } = this
      const remote = await this.fetchRemote(op.id)
      if (this.epoch !== epoch || this.hasUnsent(op.id)) return
      this.stale.delete(op.id)
      if (remote) {
        this.noteRemote(op.id, remote)
        this.local?.replace(remote.project)
        return
      }
    }
    this.local?.markSaved(op.id)
  }

  private refuse(op: Op, answer: ServerAnswer): void {
    // Deleted here, or the account left, while the answer was on its way: nothing left to decide.
    if (!this.ops.includes(op)) return
    this.stopped.set(op.id, { projectId: op.id, kind: 'refused', status: answer.status, message: answer.message, name: this.local?.name(op.id), savedVersion: this.revisions.has(op.id) })
  }

  private markGone(id: string): void {
    if (!this.hasUnsent(id)) return
    this.setRevision(id, null)
    this.bases.delete(id)
    this.stopped.set(id, { projectId: id, kind: 'gone', status: 404, name: this.local?.name(id), message: 'This audit was deleted on another device, and this browser has changes to it that were never saved.' })
  }

  private async sendPut(op: Op): Promise<void> {
    const { id } = op
    for (let attempt = 0; ; attempt++) {
      const revision = this.revisions.get(id)
      if (revision !== undefined && !this.bases.has(id) && (this.pendingCommands(id).length || this.unsure.has(id))) {
        const remote = await this.fetchRemote(id)
        if (!this.ops.includes(op)) return
        if (!remote) return this.markGone(id)
        this.bases.set(id, caseBase(remote.project))
        this.unsure.delete(id)
      }
      const base = revision === undefined ? null : (this.bases.get(id) ?? null)
      const wire = this.local?.wire(id, { base, pending: this.pendingCommands(id) }) ?? null
      if (!wire) {
        if (this.mine.has(op.key)) return this.drop((known) => known === op)
        // Only the tab that made it has this project (it didn't fit in storage): leave its steps to that tab.
        for (const known of this.ops) if (known.id === id) this.notOurs.add(known.key)
        this.ops = this.ops.filter((known) => known.id !== id)
        return
      }
      if (base && !holdsAll(wire.base, base)) {
        return this.refuse(op, new ServerAnswer(409, 'This audit was added to somewhere else, so the version here would lose payments your account has.', 'revision_conflict'))
      }
      const { body, headers } = await encodeBody(wire.json)
      // Deleted, or the account left, while it was being prepared: it must not go out under whoever is signed in now.
      if (!this.ops.includes(op)) return
      const res = await this.request(`/api/projects/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal', ...headers, ...(revision !== undefined ? { 'If-Match': String(revision) } : {}) },
        body,
      })
      if (!this.ops.includes(op)) return
      if (res.ok) {
        const answer = await readJson(res)
        if (!this.ops.includes(op)) return
        if (typeof answer.revision === 'number') this.setRevision(id, answer.revision)
        this.bases.set(id, wire.base)
        if (wire.lost) {
          this.stale.add(id)
          this.undone.push({ projectId: id, kind: 'undone', status: null, name: this.local?.name(id), message: 'A decision made in this browser never reached your account, so the saved version is shown. Check the findings you decided last.' })
        }
        return this.done(op)
      }
      const answer = await answerError(res)
      if (answer.status === 404) return this.markGone(id)
      const conflict = answer.code === 'revision_conflict'
      if (answer.status === 409 && attempt === 0 && (conflict || (answer.code === 'case_command_required' && revision !== undefined && !base))) {
        const remote = await this.fetchRemote(id)
        if (!this.ops.includes(op)) return
        if (!remote) return this.markGone(id)
        // Safe only if nothing the account has would be lost: decisions are put back from its copy, imports must all be here.
        if (holdsAll(wire.base, caseBase(remote.project))) {
          this.noteRemote(id, remote)
          if (conflict) this.stale.add(id)
          continue
        }
        this.setRevision(id, remote.revision)
      }
      return this.refuse(op, answer)
    }
  }

  private async sendCommand(op: CommandOp): Promise<void> {
    const { id } = op
    if (!this.revisions.has(id)) {
      const remote = await this.fetchRemote(id)
      if (!this.ops.includes(op)) return
      if (!remote) return this.markGone(id)
      this.noteRemote(id, remote)
    }
    for (let attempt = 0; ; attempt++) {
      const res = await this.request(`/api/projects/${encodeURIComponent(id)}/case-commands`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ commandId: op.commandId, expectedRevision: this.revisions.get(id)!, findingId: op.findingId, type: op.type, input: op.input }),
      })
      if (!this.ops.includes(op)) return
      if (res.ok) {
        const answer = await readJson(res)
        if (!this.ops.includes(op)) return
        if (typeof answer.revision === 'number') this.setRevision(id, answer.revision)
        const change = answer.case as CaseChange | undefined
        if (change) this.applyCase(op, { ...change, updatedAt: answer.updatedAt })
        else this.stale.add(id)
        return this.done(op)
      }
      const answer = await answerError(res)
      const remote = await this.fetchRemote(id)
      if (!this.ops.includes(op)) return
      if (!remote) return this.markGone(id)
      this.noteRemote(id, remote)
      if (answer.code === 'revision_conflict' && attempt === 0) {
        // Something else moved the project on (another device, another tab). The command itself may still apply.
        this.stale.add(id)
        continue
      }
      // Already in effect: an answer that never arrived, or the same step taken in another tab.
      if (answer.code !== 'command_reused' && answer.code !== 'no_change') {
        this.undone.push({ projectId: id, kind: 'undone', status: answer.status, name: this.local?.name(id), message: `${answer.message} The change was undone and the saved version is shown.` })
      }
      const env = (remote.project.environment ?? {}) as { caseStates?: Raw; result?: { findings?: Raw[] } }
      this.drop((known) => known === op)
      if (this.hasUnsent(id)) {
        this.applyCase(op, { findingId: op.findingId, state: env.caseStates?.[op.findingId] ?? null, finding: env.result?.findings?.find((f) => f.id === op.findingId) ?? null })
        this.stale.add(id)
      } else {
        this.stale.delete(id)
        this.local?.replace(remote.project)
      }
      return
    }
  }

  /** What the server now holds for one case, in the browser's copy too — unless a later step on that case is still to go. */
  private applyCase(op: CommandOp, change: CaseChange): void {
    const base = this.bases.get(op.id)
    if (base) {
      const { [change.findingId]: _previous, ...others } = base.caseStates
      base.caseStates = change.state ? { ...base.caseStates, [change.findingId]: change.state } : others
      if (change.finding) base.findings.set(change.findingId, change.finding as Raw)
    }
    const later = this.ops.some((known) => known !== op && known.kind === 'command' && known.id === op.id && known.findingId === change.findingId)
    if (!later) this.local?.applyCase(op.id, change)
  }

  private async sendDelete(op: Op): Promise<void> {
    const res = await this.request(`/api/projects/${encodeURIComponent(op.id)}`, { method: 'DELETE' })
    // Already gone is what was asked for.
    if (!res.ok && res.status !== 404) return this.refuse(op, await answerError(res))
    if (!this.ops.includes(op)) return
    this.drop((known) => known === op)
    this.setRevision(op.id, null)
    this.bases.delete(op.id)
    this.stale.delete(op.id)
  }

  private clear(): void {
    this.epoch += 1
    this.ops = []
    this.stored.clear()
    this.mine.clear()
    this.notOurs.clear()
    this.revisions.clear()
    this.bases.clear()
    this.unsure.clear()
    this.stale.clear()
    this.stopped.clear()
    this.undone = []
    this.session = null
    this.waiting = null
  }

  /** Forget this tab's queue. With `preserveStored` the account's unsent steps are kept for its next log-in. */
  reset(preserveStored = false): void {
    if (preserveStored) this.park()
    else {
      const store = this.shared()
      for (const key of [...this.keysUnder(storageKey(OP_KEY)), ...this.keysUnder(storageKey(REVISION_KEY))]) store?.removeItem(key)
      store?.removeItem(storageKey(OLD_QUEUE_KEY))
      this.parked.clear()
    }
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.clear()
    this.scope = null
    this.paused = false
    this.changed()
  }
}

export const projectSync = new ProjectSync()

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => projectSync.retry())
  window.addEventListener('storage', (event) => projectSync.storageChanged(event))
}
