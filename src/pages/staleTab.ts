const RELOADED_KEY = 'reclaim.stale-reload.v1'
const ONCE_PER_MS = 60_000

/**
 * A tab opened before a deploy asks for code files that no longer exist. Vite
 * reports that as `vite:preloadError`; one reload gets the new version. If the
 * file is still missing right after, the error boundary shows instead: the
 * page must never reload itself in a loop.
 */
export function reloadOnStaleDeploy(reload: () => void = () => window.location.reload(), now: () => number = Date.now): () => void {
  const onError = (event: Event) => {
    try {
      const last = Number(window.sessionStorage.getItem(RELOADED_KEY) ?? 0)
      if (now() - last < ONCE_PER_MS) return
      window.sessionStorage.setItem(RELOADED_KEY, String(now()))
    } catch {
      // Nowhere to remember it, so a reload could repeat for ever.
      return
    }
    event.preventDefault()
    reload()
  }
  window.addEventListener('vite:preloadError', onError)
  return () => window.removeEventListener('vite:preloadError', onError)
}
