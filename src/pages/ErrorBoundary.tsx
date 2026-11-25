import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  /** Tests replace this; the page reloads. */
  reload?: () => void
}

/** The last line of defence: a message and a way on, where React would leave a blank page. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    if (!this.state.failed) return this.props.children
    const reload = this.props.reload ?? (() => window.location.reload())
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-[#f7f4ee] px-6 text-[#171716]">
        <div role="alert" style={{ maxWidth: 420, textAlign: 'center' }}>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ marginTop: 8, fontSize: 15, color: '#5f625d' }}>Reclaim may have been updated since you opened this page. Reload to get the current version. Work already saved to your account is still there.</p>
          <button type="button" onClick={reload} style={{ marginTop: 16, padding: '10px 20px', borderRadius: 8, background: '#171716', color: '#fff', fontSize: 15 }}>
            Reload
          </button>
        </div>
      </main>
    )
  }
}
