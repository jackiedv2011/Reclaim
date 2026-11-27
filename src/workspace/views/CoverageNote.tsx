import type { CheckCoverage } from '../selectors'

/** Which checks the loaded columns could not support, shown wherever a screen says what was checked. */
export function CoverageNote({ coverage }: { coverage: CheckCoverage }) {
  if (coverage.complete || coverage.limits.length === 0) return null
  return (
    <details className="wk-evq-details" data-testid="check-coverage">
      <summary>{coverage.summary} on this file. See what could not</summary>
      <ul className="wk-notes">
        {coverage.limits.map((limit) => <li key={limit}>{limit}</li>)}
      </ul>
    </details>
  )
}
