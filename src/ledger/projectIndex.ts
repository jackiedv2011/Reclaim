export interface LedgerProjectSummary {
  id: string
  name: string
  sourceLabel: string
  mode: 'sample' | 'upload'
  createdAt: number
  updatedAt: number
  recordCount: number
  openCaseCount: number
  summaryVersion?: 2
  flaggedValue: number
  potentialRecoveryValue?: number
  recoveryActiveCount: number
  recoveryActiveValue: number
}

import { storageKey } from '@/lib/storageScope'

export const PROJECT_INDEX_BASE = 'reclaim.projects.index.v1'
export const ACTIVE_PROJECT_BASE = 'reclaim.projects.active.v1'
export const COMBINED_PROJECTS_KEY = 'reclaim.projects.v1'
export const LEGACY_LEDGER_KEY = 'reclaim.ledger.v1'
/** Scoped to the signed-in account (or the bare name when no scope is set). */
export const PROJECT_INDEX_KEY = () => storageKey(PROJECT_INDEX_BASE)
export const ACTIVE_PROJECT_KEY = () => storageKey(ACTIVE_PROJECT_BASE)

/**
 * The last index written in this tab, by key. When browser storage is full the
 * write fails, and the list must still show the audit that was just created.
 */
const memoryIndex = new Map<string, LedgerProjectSummary[]>()

export function readProjectIndex(key = PROJECT_INDEX_KEY()): LedgerProjectSummary[] {
  if (typeof window === 'undefined') return []
  const inMemory = memoryIndex.get(key)
  if (inMemory) return inMemory.toSorted((a, b) => b.updatedAt - a.updatedAt)
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return []
    return (JSON.parse(raw) as LedgerProjectSummary[]).map((item) => item.summaryVersion === 2 ? item : ({ ...item, flaggedValue: item.flaggedValue ?? (item as unknown as { recoveryValue?: number }).recoveryValue ?? 0, potentialRecoveryValue: 0, recoveryActiveCount: 0, recoveryActiveValue: 0 })).toSorted((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  }
}

export function writeProjectIndex(projects: LedgerProjectSummary[], key = PROJECT_INDEX_KEY()): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(key, JSON.stringify(projects))
    memoryIndex.delete(key)
  } catch {
    memoryIndex.set(key, projects)
  }
}

/** Drop indexes held only in this tab, for keys under `prefix`. */
export function forgetMemoryIndex(prefix: string): void {
  for (const key of memoryIndex.keys()) if (key.startsWith(prefix)) memoryIndex.delete(key)
}

export function hasSavedLocalWork(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if (readProjectIndex().length > 0) return true
    const transitional = JSON.parse(window.localStorage.getItem(COMBINED_PROJECTS_KEY) ?? '[]') as unknown[]
    return transitional.length > 0 || window.localStorage.getItem(LEGACY_LEDGER_KEY) !== null
  } catch {
    return window.localStorage.getItem(LEGACY_LEDGER_KEY) !== null
  }
}
