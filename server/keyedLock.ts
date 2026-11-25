/**
 * Runs one task at a time per key, in the order they arrived. In-memory: the
 * server is one process on one SQLite file (docs/deploy.md §2), so this is
 * enough to keep two requests for the same account from interleaving between
 * calls to Stripe or the mail provider.
 */
export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const before = this.tails.get(key) ?? Promise.resolve()
    const result = before.then(task)
    const tail = result.catch(() => {})
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}
