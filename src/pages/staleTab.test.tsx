import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ErrorBoundary } from '@/pages/ErrorBoundary'
import { reloadOnStaleDeploy } from '@/pages/staleTab'

function Broken(): never {
  throw new Error('secret detail: Failed to fetch dynamically imported module')
}

beforeEach(() => window.sessionStorage.clear())
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the error boundary', () => {
  it('replaces a blank page with a message and a reload', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    render(
      <ErrorBoundary reload={reload}>
        <Broken />
      </ErrorBoundary>
    )
    expect(screen.getByRole('alert')).toHaveTextContent(/Something went wrong/)
    expect(screen.getByRole('alert')).not.toHaveTextContent(/secret detail/)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('stays out of the way otherwise', () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>
    )
    expect(screen.getByText('fine')).toBeInTheDocument()
  })
})

describe('a tab left open across a deploy', () => {
  const fail = () => window.dispatchEvent(new Event('vite:preloadError', { cancelable: true }))

  it('reloads once for the new version, and never in a loop', () => {
    const reload = vi.fn()
    let now = 1_000_000
    const stop = reloadOnStaleDeploy(reload, () => now)
    fail()
    expect(reload).toHaveBeenCalledTimes(1)
    fail()
    now += 5_000
    fail()
    expect(reload).toHaveBeenCalledTimes(1)
    // A later deploy, hours on, gets its own reload.
    now += 60 * 60 * 1000
    fail()
    expect(reload).toHaveBeenCalledTimes(2)
    stop()
    fail()
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('does not reload when the browser won’t remember that it did', () => {
    const reload = vi.fn()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const stop = reloadOnStaleDeploy(reload)
    fail()
    expect(reload).not.toHaveBeenCalled()
    stop()
  })
})
