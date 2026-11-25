import type { Finding } from '@/types'
import { deserializeEnvironment, serializeEnvironment, type LedgerEnvironment } from '@/ledger/store'
import { normalizeCaseState, type CaseState } from '@/ledger/caseState'
import { overflow } from '@/ledger/overflowStore'
import {
  ACTIVE_PROJECT_KEY,
  COMBINED_PROJECTS_KEY,
  LEGACY_LEDGER_KEY,
  PROJECT_INDEX_BASE,
  PROJECT_INDEX_KEY,
  forgetMemoryIndex,
  readProjectIndex,
  writeProjectIndex,
  type LedgerProjectSummary,
} from '@/ledger/projectIndex'
import { clearStorageScope, getStorageScope, storageKey } from '@/lib/storageScope'
import { projectSync, ServerAnswer, type CaseBase, type CaseChange, type PendingCommand } from '@/ledger/projectSync'
import { ladder } from '@/workspace/selectors'

export type { LedgerProjectSummary } from '@/ledger/projectIndex'

export interface LedgerProject {
  id: string
  name: string
  sourceLabel: string
  mode: 'sample' | 'upload'
  createdAt: number
  updatedAt: number
  environment: LedgerEnvironment
}

const PROJECT_KEY_PREFIX = 'reclaim.project.v1.'
const PENDING_BASE = 'reclaim.project.pending.v1.'
const pendingKey = (id: string) => storageKey(`${PENDING_BASE}${id}`)
/** Pending marks this tab could not store. */
const pendingInMemory = new Set<string>()

function markPending(id: string): void {
  try {
    window.localStorage.setItem(pendingKey(id), '1')
  } catch {
    pendingInMemory.add(pendingKey(id))
  }
}

function clearPending(id: string): void {
  pendingInMemory.delete(pendingKey(id))
  try { window.localStorage.removeItem(pendingKey(id)) } catch { /* local cache can be unavailable */ }
}

function pendingIds(): string[] {
  if (typeof window === 'undefined') return []
  const prefix = storageKey(PENDING_BASE)
  const keys = new Set([...pendingInMemory].filter((key) => key.startsWith(prefix)))
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i)
    if (key?.startsWith(prefix)) keys.add(key)
  }
  return [...keys].map((key) => key.slice(prefix.length))
}

/** Changes here that the account has not confirmed. */
function hasUnsavedChanges(id: string): boolean {
  return projectSync.hasUnsent(id) || pendingInMemory.has(pendingKey(id)) || window.localStorage.getItem(pendingKey(id)) === '1'
}

/** Serialize a project for storage or the wire. */
export function toStorable(project: LedgerProject): Record<string, unknown> {
  return { ...project, environment: JSON.parse(serializeEnvironment(project.environment)) }
}

/** The same thing as text, without the round trip through an object (a large audit is 100 MB of it). */
function projectJson(project: LedgerProject, env: LedgerEnvironment = project.environment): string {
  const { environment: _environment, ...rest } = project
  return `${JSON.stringify(rest).slice(0, -1)},"environment":${serializeEnvironment(env)}}`
}

/** Revive a stored/wire project into a live one (Dates, record identity). */
export function fromStorable(raw: Record<string, unknown>): LedgerProject {
  const project = raw as Omit<LedgerProject, 'environment'> & { environment: unknown }
  return { ...project, environment: deserializeEnvironment(JSON.stringify(project.environment)) }
}

function projectId() {
  return `project_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

/** The same figures the Dashboard shows for this audit — one definition of "potential recovery" everywhere. */
function summaryFor(project: LedgerProject): LedgerProjectSummary {
  const openFindings = project.environment.result.findings.filter((finding) => {
    const state = project.environment.caseStates[finding.id]
    return state?.decision === null || state?.decision === undefined || state.decision === 'needs_info' || state.recoveryStage === 'confirmed' || state.recoveryStage === 'requested'
  })
  const totals = ladder(project.environment)

  return {
    summaryVersion: 2,
    id: project.id,
    name: project.name,
    sourceLabel: project.sourceLabel,
    mode: project.mode,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    recordCount: project.environment.records.length,
    openCaseCount: openFindings.length,
    flaggedValue: totals.flagged,
    potentialRecoveryValue: totals.potential,
    recoveryActiveCount: totals.counts.inRecovery,
    recoveryActiveValue: totals.inRecovery,
  }
}

function projectKey(id: string) {
  return storageKey(`${PROJECT_KEY_PREFIX}${id}`)
}

/**
 * Audits too large for localStorage (roughly 5 MB, which a ledger of ~2,400
 * rows reaches) are kept here while the tab is open, and in the browser's
 * database so they are still there afterwards. Where there is no database the
 * page says the audit lasts only as long as the tab.
 */
const memoryOnly = new Map<string, LedgerProject>()
/** Those of them the browser's database holds too. */
const overflowed = new Set<string>()
/** Database writes, in the order they were made. */
let overflowWrites: Promise<void> = Promise.resolve()
/** Told to other tabs when an audit only the database holds has changed (its contents raise no storage event). */
const OVERFLOW_STAMP = 'reclaim.project.overflow.v1.'

function notifyChanged(id: string | null): void {
  window.dispatchEvent(new CustomEvent('reclaim:projects-changed', { detail: { id } }))
}

function notifySynced(id: string): void {
  window.dispatchEvent(new CustomEvent('reclaim:project-synced', { detail: { id } }))
}

function writeOverflow(key: string, id: string, text: string): void {
  overflowed.delete(key)
  const stamp = storageKey(`${OVERFLOW_STAMP}${id}`)
  overflowWrites = overflowWrites
    .then(() => overflow.put(key, text))
    .then(
      () => {
        // Written into localStorage (or deleted) in the meantime: that is what counts.
        if (!memoryOnly.has(key)) return overflow.remove(key).catch(() => {})
        overflowed.add(key)
        try { window.localStorage.setItem(stamp, String(Date.now())) } catch { /* other tabs find out when they reload */ }
        notifyChanged(null)
      },
      () => { /* no database here, or it is full: the audit lives in this tab, and the page says so */ }
    )
}

function dropOverflow(key: string, always = false): void {
  const wasThere = always || overflowed.delete(key) || memoryOnly.has(key)
  overflowed.delete(key)
  memoryOnly.delete(key)
  if (wasThere) overflowWrites = overflowWrites.then(() => overflow.remove(key)).catch(() => {})
}

/** Resolves when database writes made so far have settled (tests). */
export function overflowSettled(): Promise<void> {
  return overflowWrites
}

/**
 * Bring audits that did not fit in localStorage back from the browser's
 * database. Runs before a workspace opens: everything after it is synchronous.
 */
export async function loadOverflow(scopePrefix = storageKey('')): Promise<void> {
  if (typeof window === 'undefined' || !scopePrefix) return
  let entries: Array<[string, string]>
  try {
    await overflowWrites
    entries = await overflow.entries(`${scopePrefix}${PROJECT_KEY_PREFIX}`)
  } catch {
    return
  }
  const indexKey = `${scopePrefix}${PROJECT_INDEX_BASE}`
  for (const [key, text] of entries) {
    // A localStorage copy is always the newer one: writing it is what ends the database copy.
    if (window.localStorage.getItem(key) !== null) continue
    try {
      const project = fromStorable(JSON.parse(text))
      const summary = summaryFor(project)
      memoryOnly.set(key, project)
      overflowed.add(key)
      const index = readProjectIndex(indexKey)
      if (!index.some((item) => item.id === project.id)) writeProjectIndex([...index, summary], indexKey)
    } catch {
      // One damaged copy must not stop the others from opening.
    }
  }
}

/** Remove everything this browser holds for one account (or guest): storage, database and this tab's memory. */
export function forgetScope(scope: string): void {
  if (typeof window === 'undefined') return
  const prefix = `reclaim.u.${scope}.`
  for (const key of [...memoryOnly.keys()]) if (key.startsWith(prefix)) memoryOnly.delete(key)
  for (const key of [...overflowed]) if (key.startsWith(prefix)) overflowed.delete(key)
  for (const key of [...pendingInMemory]) if (key.startsWith(prefix)) pendingInMemory.delete(key)
  overflowWrites = overflowWrites
    .then(() => overflow.entries(`${prefix}${PROJECT_KEY_PREFIX}`))
    .then(async (entries) => {
      for (const [key] of entries) if (!memoryOnly.has(key)) await overflow.remove(key)
    })
    .catch(() => {})
  forgetMemoryIndex(prefix)
  clearStorageScope(scope)
}

/** Whether leaving the account now would lose work the server does not have. */
export function hasUnsavedWork(): boolean {
  return projectSync.unsent > 0 || pendingIds().length > 0
}

/** Whether any audit could not be written to this browser at all, so it lasts only as long as the tab. */
export function hasMemoryOnlyProjects(): boolean {
  const prefix = storageKey(PROJECT_KEY_PREFIX)
  return [...memoryOnly.keys()].some((key) => key.startsWith(prefix) && !overflowed.has(key))
}

function readProjectPayload(id: string): LedgerProject | null {
  if (typeof window === 'undefined') return null
  const inMemory = memoryOnly.get(projectKey(id))
  if (inMemory) return inMemory
  try {
    const raw = window.localStorage.getItem(projectKey(id))
    if (!raw) return null
    return fromStorable(JSON.parse(raw))
  } catch {
    return null
  }
}

function writeProjectPayload(project: LedgerProject) {
  if (typeof window === 'undefined') return
  const key = projectKey(project.id)
  const text = projectJson(project)
  try {
    window.localStorage.setItem(key, text)
    dropOverflow(key)
  } catch {
    // Quota exceeded: drop any stale stored copy so a reload never shows an older version as current.
    window.localStorage.removeItem(key)
    memoryOnly.set(key, project)
    writeOverflow(key, project.id, text)
  }
}

function putInIndex(project: LedgerProject): void {
  const summaries = readProjectIndex()
  const index = summaries.findIndex((item) => item.id === project.id)
  const summary = summaryFor(project)
  writeProjectIndex(index < 0 ? [...summaries, summary] : summaries.toSpliced(index, 1, summary))
}

/** Remove one audit from this browser (not from the account). */
function removeLocalCopy(id: string): void {
  window.localStorage.removeItem(projectKey(id))
  dropOverflow(projectKey(id), true)
  clearPending(id)
  window.localStorage.removeItem(storageKey(`${OVERFLOW_STAMP}${id}`))
  const remaining = readProjectIndex().filter((project) => project.id !== id)
  writeProjectIndex(remaining)
  if (activeIdHere() === id) setActiveProject(remaining[0]?.id ?? null)
}

/** Findings seen here stay seen: which are new is this browser's business, not the server's. */
function keepSeen(server: LedgerProject, local: LedgerProject | null): LedgerProject {
  if (!local || local.environment.imports.length !== server.environment.imports.length) return server
  const stillNew = new Set(local.environment.newFindingIds)
  const newFindingIds = (server.environment.newFindingIds ?? []).filter((id) => stillNew.has(id))
  return { ...server, environment: { ...server.environment, newFindingIds } }
}

function storeServerProject(project: LedgerProject): void {
  clearPending(project.id)
  writeProjectPayload(project)
  putInIndex(project)
  notifySynced(project.id)
}

/** A copy from the server is the authoritative one for this project. Throws, changing nothing, if it can't be opened. */
function acceptServerProject(raw: Record<string, unknown>): void {
  if (typeof window === 'undefined') return
  const project = keepSeen(fromStorable(raw), readProjectPayload(String(raw.id)))
  summaryFor(project)
  storeServerProject(project)
}

/**
 * Put copies from the server in place of this browser's, without echoing them
 * back. Audits not among them are left alone.
 */
export function replaceLocalProjects(projects: LedgerProject[]): void {
  if (typeof window === 'undefined') return
  projects.forEach(storeServerProject)
  const active = activeIdHere()
  if (!active || !readProjectIndex().some((p) => p.id === active)) setActiveProject(readProjectIndex()[0]?.id ?? null)
}

/** One case as the server now holds it; the rest of the audit is already the same. */
function applyServerCase(id: string, change: CaseChange): void {
  const project = readProjectPayload(id)
  if (!project) return
  const env = project.environment
  const { [change.findingId]: _previous, ...others } = env.caseStates
  const records = new Map([...(env.retiredRecords ?? []), ...env.records].map((record) => [record.id, record]))
  const raw = change.finding as Finding | null
  const next: LedgerProject = {
    ...project,
    updatedAt: typeof change.updatedAt === 'number' ? change.updatedAt : project.updatedAt,
    environment: {
      ...env,
      caseStates: change.state ? { ...env.caseStates, [change.findingId]: normalizeCaseState(change.state as CaseState) } : others,
      result: {
        ...env.result,
        findings: env.result.findings.map((finding) => {
          if (finding.id !== change.findingId || !raw) return finding
          const known = new Map(finding.relatedRecords.map((record) => [record.id, record]))
          return { ...raw, relatedRecords: raw.relatedRecords.flatMap((ref) => records.get(ref.id) ?? known.get(ref.id) ?? []) }
        }),
      },
    },
  }
  writeProjectPayload(next)
  putInIndex(next)
  notifySynced(id)
}

const refsOnly = (finding: Finding): Record<string, unknown> => ({ ...finding, relatedRecords: finding.relatedRecords.map((record) => ({ id: record.id })) })
const rowIds = (finding: Record<string, unknown>) => (Array.isArray(finding.relatedRecords) ? finding.relatedRecords.map((record: { id: string }) => record.id).join('|') : '')

/** A finding in the compact form a queued command keeps, so a save sent first can go out without that command's effect. */
export function findingBefore(env: LedgerEnvironment, findingId: string): Record<string, unknown> | undefined {
  const finding = env.result.findings.find((row) => row.id === findingId)
  return finding ? (JSON.parse(JSON.stringify(refsOnly(finding))) as Record<string, unknown>) : undefined
}

/**
 * A whole-project save carries payments, imports and findings, never
 * decisions: those go as case commands, in order, and the server refuses a
 * save that changes them. So every case goes out as the server last had it.
 */
function wireProject(id: string, { base, pending }: { base: CaseBase | null; pending: PendingCommand[] }) {
  const project = readProjectPayload(id)
  if (!project) return null
  const env = project.environment
  const touched = new Map<string, PendingCommand>()
  for (const command of pending) if (!touched.has(command.findingId)) touched.set(command.findingId, command)
  const states = Object.entries(env.caseStates)
  const caseStates: Record<string, unknown> = base ? { ...base.caseStates } : Object.fromEntries(states.filter(([findingId]) => !touched.has(findingId)))
  // Payments that changed under a decision put it up for checking again. That is the one thing a save may say about a case: it only takes away.
  if (base) {
    for (const [findingId, state] of states) {
      const there = base.caseStates[findingId] as CaseState | undefined
      if (there && state.requiresRevalidation && !there.requiresRevalidation && !touched.has(findingId)) {
        caseStates[findingId] = { ...there, requiresRevalidation: true, ...(there.approvedAt != null && state.approvedAt == null ? { approvedAt: null } : {}) }
      }
    }
  }
  const decidedThere = (findingId: string) => Boolean((base?.caseStates[findingId] as CaseState | undefined)?.decision)
  const lost = base !== null && states.some(([findingId, state]) => state.decision && !decidedThere(findingId) && !touched.has(findingId))
  const findings = env.result.findings.map((finding): Record<string, unknown> => {
    const local = refsOnly(finding)
    const server = base?.findings.get(finding.id)
    if (server) {
      const hasCase = server.evidence != null || base!.caseStates[finding.id] !== undefined || touched.has(finding.id) || finding.evidence != null || finding.customerDecision != null
      // Different rows make it a different finding: that is for the server to judge, not to paper over.
      if (!hasCase || rowIds(server) !== rowIds(local)) return local
      const checkAgain = finding.requiresRevalidation && finding.suppressionReason && !server.requiresRevalidation && !touched.has(finding.id)
      return checkAgain ? { ...server, requiresRevalidation: true, potentialAmountMinor: null, classification: 'review_needed', class: 'review', suppressionReason: finding.suppressionReason } : server
    }
    const before = touched.get(finding.id)?.before
    return before && rowIds(before) === rowIds(local) ? before : local
  })
  const sent = { ...env, caseStates, result: { ...env.result, findings } } as unknown as LedgerEnvironment
  return {
    json: projectJson(project, sent),
    base: { caseStates, findings: new Map(findings.map((finding) => [String(finding.id), finding])), batches: [...env.imports.map((batch) => batch.id), ...(env.removedImports ?? [])] },
    lost,
  }
}

projectSync.useLocal({
  wire: wireProject,
  full: (id) => {
    const project = readProjectPayload(id)
    return project && projectJson(project)
  },
  unsavedIds: () => pendingIds().filter((id) => readProjectPayload(id) !== null),
  name: (id) => readProjectIndex().find((summary) => summary.id === id)?.name ?? null,
  markSaved: clearPending,
  applyCase: applyServerCase,
  replace: acceptServerProject,
  canOpen: (raw) => {
    try {
      summaryFor(fromStorable(raw))
      return true
    } catch {
      return false
    }
  },
  remove: (id) => {
    removeLocalCopy(id)
    notifyChanged(id)
  },
})

/**
 * Bring this browser's copy of the account up to date. Only audits whose
 * revision moved are fetched, one at a time, so one that can't be read (or
 * opened) leaves the others alone. Work the server hasn't confirmed is kept.
 * Throws when the account can't be read at all: that is not an empty account.
 */
export async function loadAccountProjects(): Promise<{ failed: string[] }> {
  // Read before asking: a save that lands meanwhile is not in the answer, and must not look deleted.
  const savedBefore = new Set(readProjectIndex().map(({ id }) => id).filter((id) => projectSync.revisionOf(id) !== undefined && !hasUnsavedChanges(id)))
  const neverSaved = readProjectIndex().map(({ id }) => id).filter((id) => projectSync.revisionOf(id) === undefined && !projectSync.hasUnsent(id))
  const remote = await projectSync.remoteRevisions()
  const failed: string[] = []
  for (const [id, revision] of Object.entries(remote)) {
    if (projectSync.deleting(id)) continue
    const local = readProjectPayload(id)
    if (local && (hasUnsavedChanges(id) || projectSync.revisionOf(id) === revision)) {
      if (!readProjectIndex().some((summary) => summary.id === id)) putInIndex(local)
      continue
    }
    let found: Awaited<ReturnType<typeof projectSync.fetchRemote>>
    try {
      found = await projectSync.fetchRemote(id)
    } catch (err) {
      // No connection, or no session: nothing further will load. Any other answer is about this one audit.
      if (!(err instanceof ServerAnswer) || err.status === 401) throw err
      failed.push(id)
      continue
    }
    if (!found) continue
    try {
      acceptServerProject(found.project)
      projectSync.noteRemote(id, found)
    } catch (err) {
      console.warn(`Reclaim: could not open audit ${id} —`, err instanceof Error ? err.message : err)
      failed.push(id)
    }
  }
  for (const id of savedBefore) {
    if (remote[id] !== undefined || hasUnsavedChanges(id)) continue
    // Deleted on another device.
    removeLocalCopy(id)
    projectSync.forget(id)
  }
  for (const id of neverSaved) {
    if (remote[id] !== undefined || hasUnsavedChanges(id) || !readProjectPayload(id)) continue
    // A copy the server was never seen to hold is work still to be saved.
    markPending(id)
    projectSync.push(id)
  }
  const projects = readProjectIndex()
  const active = activeIdHere()
  if (!active || !projects.some((project) => project.id === active)) setActiveProject(projects[0]?.id ?? null)
  return { failed }
}

/** Where audits made without an account are kept: before accounts existed (bare keys), and by a guest in this browser. */
const UNOWNED_PREFIXES = ['', 'reclaim.u.guest.']

/** Audits in this browser that belong to no account. */
export function listLegacyProjects(): LedgerProject[] {
  if (typeof window === 'undefined') return []
  return UNOWNED_PREFIXES.flatMap((prefix) =>
    readProjectIndex(`${prefix}${PROJECT_INDEX_BASE}`).flatMap((summary) => {
      const key = `${prefix}${PROJECT_KEY_PREFIX}${summary.id}`
      const inMemory = memoryOnly.get(key)
      if (inMemory) return [inMemory]
      try {
        const raw = window.localStorage.getItem(key)
        return raw ? [fromStorable(JSON.parse(raw))] : []
      } catch {
        return []
      }
    })
  )
}

/** Remove audits that belong to no account (after they were imported into one, or on request). */
export function removeLegacyProjects(onlyIds?: string[]): void {
  if (typeof window === 'undefined') return
  const drop = onlyIds ? new Set(onlyIds) : null
  for (const prefix of UNOWNED_PREFIXES) {
    const indexKey = `${prefix}${PROJECT_INDEX_BASE}`
    const left = readProjectIndex(indexKey).filter(({ id }) => {
      if (drop && !drop.has(id)) return true
      window.localStorage.removeItem(`${prefix}${PROJECT_KEY_PREFIX}${id}`)
      dropOverflow(`${prefix}${PROJECT_KEY_PREFIX}${id}`)
      return false
    })
    writeProjectIndex(left, indexKey)
    if (!left.length) window.localStorage.removeItem(indexKey)
  }
  if (drop) return
  window.localStorage.removeItem('reclaim.projects.active.v1')
  window.localStorage.removeItem(LEGACY_LEDGER_KEY)
  window.localStorage.removeItem(COMBINED_PROJECTS_KEY)
}

/** Only real accounts sync; guests and unscoped (legacy/test) storage stay local. */
function syncing(): boolean {
  const scope = getStorageScope()
  return scope !== null && scope !== 'guest'
}

/** Moves the short-lived combined project store to indexed, per-project storage. */
function migrateCombinedProjects(): void {
  if (typeof window === 'undefined' || getStorageScope() !== null || readProjectIndex().length > 0) return
  try {
    const raw = window.localStorage.getItem(COMBINED_PROJECTS_KEY)
    if (!raw) return
    const projects = (JSON.parse(raw) as Array<Omit<LedgerProject, 'environment'> & { environment: unknown }>).map((project) => ({
      ...project,
      environment: deserializeEnvironment(JSON.stringify(project.environment)),
    }))
    projects.forEach(writeProjectPayload)
    writeProjectIndex(projects.map(summaryFor))
    window.localStorage.removeItem(COMBINED_PROJECTS_KEY)
  } catch {
    // Leave the previous store untouched when migration cannot complete.
  }
}

/**
 * Converts the single-ledger v1 store into one named local review. It is
 * intentionally idempotent so a failed write never destroys the original.
 */
export function migrateLegacyLedger(loadLegacy: () => LedgerEnvironment | null): void {
  if (typeof window === 'undefined' || getStorageScope() !== null) return
  migrateCombinedProjects()
  if (readProjectIndex().length > 0) return
  const legacy = loadLegacy()
  if (!legacy) return

  const latestImport = legacy.imports.at(-1)
  const project: LedgerProject = {
    id: projectId(),
    name: latestImport?.sourceLabel.replace(/\.[^.]+$/, '') || 'Recovered ledger review',
    sourceLabel: latestImport?.sourceLabel || 'Existing local ledger',
    mode: latestImport?.mode || 'upload',
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
    environment: legacy,
  }
  writeProjectPayload(project)
  writeProjectIndex([summaryFor(project)])
  window.localStorage.setItem(ACTIVE_PROJECT_KEY(), project.id)
  window.localStorage.removeItem(LEGACY_LEDGER_KEY)
}

export function listProjects(): LedgerProjectSummary[] {
  migrateCombinedProjects()
  return readProjectIndex().map((summary) => { const project = readProjectPayload(summary.id); return project ? summaryFor(project) : summary })
}

export function loadProject(id: string): LedgerProject | null {
  migrateCombinedProjects()
  return readProjectPayload(id)
}

/** The newest copy of a project: another tab may have saved one since this tab read it. */
export function latestProject(current: LedgerProject): LedgerProject {
  const summary = readProjectIndex().find((item) => item.id === current.id)
  if (!summary || summary.updatedAt === current.updatedAt) return current
  return readProjectPayload(current.id) ?? current
}

export function getActiveProjectId(): string | null {
  if (typeof window === 'undefined') return null
  const activeId = activeIdHere()
  if (activeId && loadProject(activeId)) return activeId
  return listProjects()[0]?.id ?? null
}

let memoryActiveProject: string | null | undefined

function activeIdHere(): string | null {
  return memoryActiveProject !== undefined ? memoryActiveProject : window.localStorage.getItem(ACTIVE_PROJECT_KEY())
}

export function setActiveProject(id: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (id) window.localStorage.setItem(ACTIVE_PROJECT_KEY(), id)
    else window.localStorage.removeItem(ACTIVE_PROJECT_KEY())
    memoryActiveProject = undefined
  } catch {
    memoryActiveProject = id
  }
}

export function createProject(input: Omit<LedgerProject, 'id' | 'createdAt' | 'updatedAt'>): LedgerProject {
  const now = Date.now()
  const project: LedgerProject = { ...input, id: projectId(), createdAt: now, updatedAt: now }
  writeProjectPayload(project)
  writeProjectIndex([...readProjectIndex(), summaryFor(project)])
  setActiveProject(project.id)
  if (syncing()) {
    markPending(project.id)
    projectSync.push(project.id)
  }
  return project
}

/**
 * `sync: false`: the change goes to the account another way (a case command).
 * `localOnly`: the change is this browser's alone (such as which findings have
 * been seen), so there is nothing to send and nothing to wait for.
 */
export function saveProject(project: LedgerProject, options: { sync?: boolean; localOnly?: boolean } = {}): LedgerProject {
  const next = options.localOnly ? project : { ...project, updatedAt: Date.now() }
  writeProjectPayload(next)
  putInIndex(next)
  setActiveProject(next.id)
  if (syncing() && !options.localOnly) {
    markPending(next.id)
    if (options.sync !== false) projectSync.push(next.id)
  }
  return next
}

export function deleteProject(id: string) {
  if (typeof window !== 'undefined') removeLocalCopy(id)
  if (syncing()) projectSync.remove(id)
}

/** Another tab saved, added or deleted an audit. */
function storageChanged(event: StorageEvent): void {
  if (!event.key) return
  const payload = storageKey(PROJECT_KEY_PREFIX)
  const stamp = storageKey(OVERFLOW_STAMP)
  if (event.key.startsWith(payload)) {
    const id = event.key.slice(payload.length)
    // A stored copy replaces one this tab was holding in memory. A removed one may only have moved to the database.
    if (event.newValue !== null || !readProjectIndex().some((summary) => summary.id === id)) {
      memoryOnly.delete(event.key)
      overflowed.delete(event.key)
    }
    notifyChanged(id)
  } else if (event.key.startsWith(stamp) && event.newValue !== null) {
    const id = event.key.slice(stamp.length)
    void loadOverflow().then(() => notifyChanged(id))
  } else if (event.key === PROJECT_INDEX_KEY()) {
    notifyChanged(null)
  }
}

if (typeof window !== 'undefined') window.addEventListener('storage', storageChanged)
