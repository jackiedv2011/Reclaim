import { afterEach, describe, expect, it, vi } from 'vitest'
import { IndexedDbStore } from '@/ledger/overflowStore'

/** The sliver of IndexedDB the store uses, with its event timing: jsdom has none. */
function fakeIndexedDb(options: { full?: boolean } = {}) {
  const data = new Map<string, unknown>()
  let created = false
  const later = (run: () => void) => setTimeout(run, 0)
  const request = <T>(result: T) => {
    const req: { result: T; error: null; onsuccess?: () => void } = { result, error: null }
    later(() => req.onsuccess?.())
    return req
  }
  const db = {
    createObjectStore: () => void (created = true),
    transaction: () => {
      const tx: { error: DOMException | null; oncomplete?: () => void; onabort?: () => void; objectStore: () => unknown } = {
        error: null,
        objectStore: () => ({
          put: (value: unknown, key: string) => {
            if (options.full) tx.error = new DOMException('full', 'QuotaExceededError')
            else data.set(key, value)
          },
          delete: (key: string) => void data.delete(key),
          getAllKeys: (range: { lower: string; upper: string }) => request([...data.keys()].filter((k) => k >= range.lower && k <= range.upper).sort()),
          getAll: (range: { lower: string; upper: string }) => request([...data.keys()].filter((k) => k >= range.lower && k <= range.upper).sort().map((k) => data.get(k))),
        }),
      }
      later(() => (tx.error ? tx.onabort?.() : tx.oncomplete?.()))
      return tx
    },
  }
  return {
    data,
    open: () => {
      const req: { result: unknown; error: null; onupgradeneeded?: () => void; onsuccess?: () => void } = { result: db, error: null }
      later(() => {
        if (!created) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
}

describe('the browser database for audits that do not fit in localStorage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('keeps, lists by account and removes audits', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb())
    vi.stubGlobal('IDBKeyRange', { bound: (lower: string, upper: string) => ({ lower, upper }) })
    const store = new IndexedDbStore()
    await store.put('reclaim.u.a.1', 'one')
    await store.put('reclaim.u.a.2', 'two')
    await store.put('reclaim.u.b.1', 'other account')
    expect(await store.entries('reclaim.u.a.')).toEqual([['reclaim.u.a.1', 'one'], ['reclaim.u.a.2', 'two']])
    await store.remove('reclaim.u.a.1')
    expect(await store.entries('reclaim.u.a.')).toEqual([['reclaim.u.a.2', 'two']])
  })

  it('says when it could not keep one: only a committed write counts', async () => {
    vi.stubGlobal('indexedDB', fakeIndexedDb({ full: true }))
    await expect(new IndexedDbStore().put('k', 'v')).rejects.toThrow('full')
  })

  it('a browser without one is an ordinary failure, not a crash', async () => {
    vi.stubGlobal('indexedDB', undefined)
    await expect(new IndexedDbStore().entries('k')).rejects.toThrow('no database')
  })
})
