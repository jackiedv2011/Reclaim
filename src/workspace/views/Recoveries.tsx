import { ArrowRight, CalendarClock } from 'lucide-react'
import { plural } from '@/lib/format'
import type { RecoveryStage } from '@/ledger/caseState'
import type { LedgerEnvironment } from '@/ledger/store'
import { recoveryNextAction, recoveryStatusLabel, requiresCustomerAction } from '@/recovery/model'
import { caseAmount, figuresOf, ladder, recoveries, requestsNote, vendorCommitments } from '../selectors'
import { exposureCurrencyOf, findingMoney, otherCurrencies, totalsByCurrency } from '../money'
import { useHeadlineMoney } from '../preferences'
import { CountUp } from './CountUp'
import { MiniPie } from './MiniPie'

const LANES: Array<{ stage: RecoveryStage; title: string; hint: string }> = [
  { stage: 'confirmed', title: 'Prepared', hint: 'Confirmed findings waiting for approval or to be sent.' },
  { stage: 'requested', title: 'With the vendor', hint: 'Requests you have sent. Log replies and money back.' },
  { stage: 'recovered', title: 'Money back', hint: 'Money that actually came back, until it is reconciled.' },
  { stage: 'not_recovered', title: 'Closed', hint: 'Closed without money back.' },
]
const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

function dueText(dueAt: number | null | undefined, now: number): string | null {
  if (!dueAt) return null
  const days = Math.round((new Date(dueAt).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000)
  if (days < 0) return `${-days}d overdue`
  if (days === 0) return 'Due today'
  return `Due ${short.format(dueAt)}`
}

/** Vendor recovery cases: what needs you, then every case by where it has got to. */
export function Recoveries({ env, onOpenCase, onOpenFindings }: { env: LedgerEnvironment; onOpenCase: (id: string) => void; onOpenFindings: () => void }) {
  const rows = recoveries(env)
  const l = ladder(env)
  const commitments = vendorCommitments(env)
  const money = useHeadlineMoney()
  const now = Date.now()
  const returnedElsewhere = otherCurrencies(l.recoveredByCurrency)
  // Every pie is a share of the same whole: what is still out plus what came back.
  const pursued = l.inRecovery + l.recovered
  const pie = (value: number, color: string, label: string) => (
    <span className="wk-total-pie">
      <MiniPie value={value} total={pursued} color={color} label={label} />
      <small>{pursued > 0 ? Math.round((value / pursued) * 100) : 0}%</small>
    </span>
  )

  if (rows.length === 0) {
    return (
      <div className="wk-empty">
        <span className="wk-label">No recoveries yet</span>
        <p style={{ maxWidth: 560 }}>
          A money-back finding moves here once you confirm it is real. Reclaim prepares the request; nothing goes to a vendor until you approve and send it.
          Risk and prevention findings are reviewed inside your business and stay in Findings.
        </p>
        <button type="button" className="wk-btn" data-variant="primary" onClick={onOpenFindings}>
          Review findings <ArrowRight aria-hidden="true" />
        </button>
      </div>
    )
  }

  const needsAction = rows
    .filter(({ state, finding }) => requiresCustomerAction(state, now, finding.class !== 'recoverable' && !(['exact_duplicate', 'near_duplicate'].includes(finding.type) && state.recoveryStage === 'requested' && state.requestedAmount != null)))
    .sort((a, b) => (recoveryNextAction(a.state, now).dueAt ?? Infinity) - (recoveryNextAction(b.state, now).dueAt ?? Infinity) || b.finding.dollarImpact - a.finding.dollarImpact)

  return (
    <>
      <section className="wk-totals" data-pies aria-label="Recovery totals">
        <div className="wk-total" data-total="inRecovery" data-amount={l.inRecovery} data-empty={l.inRecovery === 0 || undefined}>
          <span className="wk-label">In recovery</span>
          <strong className="wk-total-value"><CountUp value={l.inRecovery} format={money} /></strong>
          <span className="wk-total-note">{requestsNote(l)}</span>
          {pie(l.inRecovery, 'var(--st-waiting-dot)', 'In recovery')}
        </div>
        <div className="wk-total" data-total="agreed" data-amount={commitments.confirmed} data-empty={commitments.confirmed === 0 || undefined}>
          <span className="wk-label">Vendor agreed</span>
          <strong className="wk-total-value"><CountUp value={commitments.confirmed} format={money} /></strong>
          <span className="wk-total-note">{commitments.confirmedCases} {plural(commitments.confirmedCases, 'agreement')} you recorded</span>
          {pie(commitments.confirmed, 'var(--st-agreed-ink)', 'Vendor agreed')}
        </div>
        <div className="wk-total" data-total="pending" data-amount={commitments.pendingReturn} data-empty={commitments.pendingReturn === 0 || undefined}>
          <span className="wk-label">Return pending</span>
          <strong className="wk-total-value"><CountUp value={commitments.pendingReturn} format={money} /></strong>
          <span className="wk-total-note">{commitments.pendingCases === 1 ? '1 promise or credit' : `${commitments.pendingCases} promises or credits`} awaiting proof</span>
          {pie(commitments.pendingReturn, 'var(--st-agreed-dot)', 'Return pending')}
        </div>
        <div className="wk-total" data-total="recovered" data-amount={l.recovered} data-empty={l.recovered === 0 || undefined} data-accent={l.recovered > 0 || undefined}>
          <span className="wk-label">Recovered</span>
          <strong className="wk-total-value" style={l.recovered > 0 ? { color: 'var(--accent-ink)' } : undefined}><CountUp value={l.recovered} format={money} /></strong>
          <span className="wk-total-note">Only money you recorded as settled{returnedElsewhere ? ` · plus ${returnedElsewhere}` : ''}</span>
          {pie(l.recovered, 'var(--st-back-dot)', 'Recovered')}
        </div>
      </section>

      <section className="wk-panelcard" aria-labelledby="rec-needs">
        <div className="wk-panelcard-head">
          <div>
            <h2 id="rec-needs">Needs your action</h2>
            <p>{needsAction.length === 0 ? 'Nothing is due. Replies and follow-ups will surface here.' : `${needsAction.length} ${plural(needsAction.length, 'case')}, soonest due first`}</p>
          </div>
        </div>
        {needsAction.length ? (
          <div className="wk-queue">
            {needsAction.map((row) => {
              const action = recoveryNextAction(row.state, now)
              const value = caseAmount(row, env.result.findings)
              const due = dueText(action.dueAt, now)
              return (
                <button type="button" key={row.finding.id} className="wk-queue-row" onClick={() => onOpenCase(row.finding.id)} aria-label={`Open ${row.finding.vendor} recovery case`}>
                  <span className="wk-queue-main">
                    <strong>{action.label} · {row.finding.vendor}</strong>
                    <span>
                      {due ? <span className="wk-chip" data-tone={due.includes('overdue') ? 'accent' : undefined}><CalendarClock aria-hidden="true" style={{ width: 12, height: 12 }} />{due}</span> : null}
                      <em>{recoveryStatusLabel(row.state)} · {row.typeLabel}</em>
                    </span>
                  </span>
                  <span className="wk-queue-amount">{findingMoney(row.finding, value.amount)}</span>
                  <span className="wk-queue-go">Open<ArrowRight aria-hidden="true" /></span>
                </button>
              )
            })}
          </div>
        ) : null}
      </section>

      <div className="wk-board" aria-label="Every recovery case">
        {LANES.map(({ stage, title, hint }) => {
          const inStage = rows.filter((o) => o.state.recoveryStage === stage)
          // One figure per currency: a lane never adds dollars to euros.
          const totals = totalsByCurrency(inStage.map((o) => ({ amount: caseAmount(o, env.result.findings).amount, currency: exposureCurrencyOf(o.finding) })))
          const total = totals.find((t) => t.currency === 'USD')?.amount ?? 0
          return (
            <section className="wk-lane" key={stage} data-stage={stage} data-has-money={totals.some((t) => t.amount > 0) || undefined} data-empty={inStage.length === 0 || undefined} aria-labelledby={`lane-${stage}`}>
              <div className="wk-lane-head">
                <h2 id={`lane-${stage}`} style={{ font: '600 13px var(--f-text)' }}>{title}</h2>
                <span>{inStage.length}</span>
              </div>
              <div className="wk-lane-total" data-amount={total}>{totals.length ? totals.map((t) => money(t.amount, t.currency)).join(' · ') : money(0)}</div>
              {inStage.length ? inStage.map((o) => {
                const value = caseAmount(o, env.result.findings)
                const action = recoveryNextAction(o.state, now)
                const rest = stage === 'recovered' ? figuresOf(o, env.result.findings).potential : null
                const due = stage === 'requested' ? dueText(action.dueAt, now) : null
                return (
                  <button type="button" className="wk-ticket" key={o.finding.id} onClick={() => onOpenCase(o.finding.id)} aria-label={`Open ${o.finding.vendor} recovery case`}>
                    <strong>{o.finding.vendor}</strong>
                    <span className="wk-ticket-status">{recoveryStatusLabel(o.state)}{rest ? ` · ${findingMoney(o.finding, rest)} can still be requested` : ''}</span>
                    <span>
                      <em style={{ fontStyle: 'normal' }}>{due ?? value.label}</em>
                      <b className="wk-ticket-money" data-label={value.label}>{findingMoney(o.finding, value.amount)}</b>
                    </span>
                  </button>
                )
              }) : <p className="wk-lane-empty">{hint}</p>}
            </section>
          )
        })}
      </div>
    </>
  )
}
