/**
 * Where an audit goes when it doesn't fit in localStorage (about 5 MB, which
 * roughly 2,400 rows fill). One IndexedDB store of key → serialized audit.
 * localStorage stays the first choice because the app reads it synchronously;
 * this is loaded back into memory before the workspace opens.
 */
export interface OverflowStore {
  put(key: string, text: string): Promise<void>
  remove(key: string): Promise<void>
  /** Every entry whose key starts with `prefix`. */
  entries(prefix: string): Promise<Array<[string, string]>>
}

const DB_NAME = 'reclaim'
const STORE = 'audits'

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Browser database failed.'))
  })
}

export class IndexedDbStore implements OverflowStore {
  private db: Promise<IDBDatabase> | null = null

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise<IDBDatabase>((resolve, reject) => {
        if (typeof indexedDB === 'undefined') throw new Error('This browser has no database.')
        const request = indexedDB.open(DB_NAME, 1)
        request.onupgradeneeded = () => request.result.createObjectStore(STORE)
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error ?? new Error('Browser database failed to open.'))
        request.onblocked = () => reject(new Error('Browser database is blocked.'))
      })
      // A refusal (private window, no space) may not be permanent: try again next time.
      this.db.catch(() => (this.db = null))
    }
    return this.db
  }

  private async write(run: (store: IDBObjectStore) => void): Promise<void> {
    const db = await this.open()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      // Durable only once the transaction commits, not when the request succeeds.
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Browser database failed.'))
      tx.onabort = () => reject(tx.error ?? new Error('Browser database is full.'))
      run(tx.objectStore(STORE))
    })
  }

  put(key: string, text: string): Promise<void> {
    return this.write((store) => store.put(text, key))
  }

  remove(key: string): Promise<void> {
    return this.write((store) => store.delete(key))
  }

  async entries(prefix: string): Promise<Array<[string, string]>> {
    const db = await this.open()
    const store = db.transaction(STORE, 'readonly').objectStore(STORE)
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`)
    const [keys, values] = await Promise.all([promised(store.getAllKeys(range)), promised(store.getAll(range))])
    return keys.map((key, i) => [String(key), values[i] as string])
  }
}

let current: OverflowStore = new IndexedDbStore()

/** Tests pass an in-memory store: jsdom has no IndexedDB. */
export function setOverflowStore(store: OverflowStore | null): void {
  current = store ?? new IndexedDbStore()
}

export const overflow: OverflowStore = {
  put: (key, text) => current.put(key, text),
  remove: (key) => current.remove(key),
  entries: (prefix) => current.entries(prefix),
}
