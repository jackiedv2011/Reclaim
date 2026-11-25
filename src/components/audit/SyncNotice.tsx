import { useState } from 'react'
import { projectSync, type SyncIssueDetail } from '@/ledger/projectSync'
import { forgetUpload } from '@/ledger/uploadRegistry'

interface SyncNoticeProps {
  issues: SyncIssueDetail[]
  pending: number
  onDownload: (projectId: string) => void
}

/**
 * What has not reached the account, in the server's own words, with a way out
 * of each: nothing is refused silently, and nothing is stuck without a choice.
 */
export function SyncNotice({ issues, pending, onDownload }: SyncNoticeProps) {
  if (!issues.length && !pending) return null
  if (!issues.length) {
    return (
      <div className="wk-alert" role="status" data-testid="sync-notice" style={{ marginBottom: 20 }}>
        <p>Saving this project to your account…</p>
      </div>
    )
  }
  return (
    <div className="wk-alert" role="status" data-testid="sync-notice" style={{ marginBottom: 20 }}>
      {issues.map((issue) => (
        <IssueRow key={`${issue.kind}-${issue.projectId}-${issue.message}`} issue={issue} onDownload={onDownload} />
      ))}
    </div>
  )
}

function IssueRow({ issue, onDownload }: { issue: SyncIssueDetail; onDownload: (projectId: string) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const run = (action: () => Promise<void> | void) => async () => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch {
      setError('That didn’t work. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }
  const id = issue.projectId
  const button = (label: string, action: () => Promise<void> | void) => (
    <button type="button" className="wk-linklike" disabled={busy} onClick={run(action)}>
      {label}
    </button>
  )
  const decides = issue.kind === 'refused' || issue.kind === 'gone'
  const remove = !confirming ? (
    <button type="button" className="wk-linklike" disabled={busy} onClick={() => setConfirming(true)}>
      Remove it from this browser
    </button>
  ) : (
    <>
      <span>This can’t be undone.</span>
      {button('Remove it', () => {
        // Refused before it was ever saved: the account never audited this ledger, so it can be uploaded again.
        if (issue.kind === 'refused') forgetUpload(id)
        projectSync.discard(id)
      })}
      <button type="button" className="wk-linklike" onClick={() => setConfirming(false)}>
        Keep it
      </button>
    </>
  )
  return (
    <div>
      <p>
        {issue.name ? <strong>{issue.name}: </strong> : null}
        {issue.message}
        {issue.kind === 'refused' ? ' Your changes are only in this browser.' : null}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="wk-alert-actions">
        {issue.kind === 'waiting' || issue.kind === 'signed_out' ? button('Retry save', () => projectSync.retry()) : null}
        {issue.kind === 'refused' ? button('Try again', () => projectSync.retry(id)) : null}
        {issue.kind === 'refused' && issue.savedVersion ? button('Use the saved version from my account', () => projectSync.useSaved(id)) : null}
        {issue.kind === 'gone' || issue.addable ? button('Keep it as a new audit', () => projectSync.keepAsNew(id)) : null}
        {issue.kind === 'gone' || (issue.kind === 'refused' && !issue.savedVersion) ? remove : null}
        {issue.kind === 'undone' ? button('Dismiss', () => projectSync.dismiss(issue)) : null}
        {decides || issue.kind === 'waiting' || issue.kind === 'signed_out' ? button('Download local copy', () => onDownload(id)) : null}
      </div>
    </div>
  )
}
