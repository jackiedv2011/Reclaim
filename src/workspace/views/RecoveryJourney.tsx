import { useEffect, useState } from 'react'
import { CalendarClock, CircleCheck } from 'lucide-react'
import { formatCurrency } from '@/lib/format'
import { type CaseState, type RecoveryMethod, type RecoveryVerification, type VendorUpdate, type VendorUpdateStatus } from '@/ledger/caseState'
import { latestVendorPosition, VENDOR_STATUS, VENDOR_STATUS_ORDER } from '@/recovery/vendorStatus'
import { activeReturned, settlementKey, settlementsOf, verifiedReturned } from '@/recovery/financials'
import { evaluateEligibility } from '@/recovery/eligibility'
import type { SettlementInput } from '@/recovery/model'
import { isWholeCents, LIMITS } from '@/recovery/validation'
import type { Finding } from '@/types'

const SETTLEMENT_METHOD_LABEL: Record<RecoveryMethod, string> = { refund: 'Cash refund', credit: 'Applied vendor credit', offset: 'Payment offset' }
const ROOT_CAUSES = [
  'Invoice entered twice', 'Vendor duplicate record', 'Invoice renumbered', 'Payment issued across systems', 'Payment retry',
  'Vendor resent invoice', 'Credit memo never entered', 'Return not communicated to AP', 'Pricing mismatch',
  'Contract cancellation missed', 'Accounting migration', 'Entity mismatch', 'Manual entry error', 'Other',
]
const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const dateValue = (time: number | null | undefined) => {
  if (!time) return ''
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
const dateFromInput = (value: string) => (value ? new Date(`${value}T12:00:00`).getTime() : null)
const parseMoney = (value: string) => Number(value.replace(/[$,\s]/g, ''))

/**
 * When the money arrived, from the day picked: now for today, otherwise that
 * day, but never before a reply already logged on it (a refund promised and
 * received the same day came after the promise).
 */
function arrivedAt(day: string, replies: VendorUpdate[], now: number): number | null {
  if (!day) return null
  if (day === dateValue(now)) return now
  const noon = dateFromInput(day)!
  return Math.max(noon, ...replies.filter((reply) => dateValue(reply.at) === day).map((reply) => reply.at))
}

type Tab = 'reply' | 'money' | 'close'

/**
 * Stage "requested": everything that happens while the request is out. The
 * conversation stays in view; the three things you can do next (log a reply,
 * record money back, close) sit behind a switch so only one form shows at once.
 */
export function RecoveryProgressPanel({ finding, state, onVendorUpdate, onFollowUp, onVerify, onClose }: {
  finding: Finding
  state: CaseState
  onVendorUpdate: (id: string, update: VendorUpdate) => void
  onFollowUp: (id: string, at: number | null) => void
  onVerify: (id: string, proof: RecoveryVerification) => void
  onClose: (id: string, reason: string) => void
}) {
  const requested = state.requestedAmount ?? 0
  const returned = activeReturned(state)
  const remaining = Math.max(0, Math.round(requested * 100 - returned * 100) / 100)
  const position = latestVendorPosition(state)
  // Open on the most likely next step: money back once some has arrived or is on its way.
  const [tab, setTab] = useState<Tab>(returned > 0 || (position && VENDOR_STATUS[position.status].pending) ? 'money' : 'reply')

  const [status, setStatus] = useState<VendorUpdateStatus>('acknowledged')
  const [promisedMethod, setPromisedMethod] = useState<RecoveryMethod>(state.requestedResolution === 'refund' ? 'refund' : 'credit')
  const [responseNote, setResponseNote] = useState('')
  const [responseAmount, setResponseAmount] = useState('')
  const [expectedDate, setExpectedDate] = useState('')
  const [followUpDate, setFollowUpDate] = useState(dateValue(state.nextFollowUpAt))
  const [amount, setAmount] = useState(remaining.toFixed(2))
  const [method, setMethod] = useState<RecoveryMethod>(state.requestedResolution ?? 'refund')
  const [source, setSource] = useState<RecoveryVerification['source']>('manual')
  const [arrivedOn, setArrivedOn] = useState(() => dateValue(Date.now()))
  const [excessConfirmed, setExcessConfirmed] = useState(false)
  /** The recorded return being corrected, by its key. */
  const [correcting, setCorrecting] = useState<string | null>(null)
  const [reference, setReference] = useState('')
  const [appliedToBill, setAppliedToBill] = useState('')
  const [closeReason, setCloseReason] = useState('')
  const [vendorError, setVendorError] = useState('')
  const [proofError, setProofError] = useState('')
  const [closeError, setCloseError] = useState('')

  useEffect(() => { setAmount(remaining.toFixed(2)); setExcessConfirmed(false) }, [remaining])
  useEffect(() => { setFollowUpDate(dateValue(state.nextFollowUpAt)) }, [state.nextFollowUpAt])

  const statusInfo = VENDOR_STATUS[status]
  const gate = evaluateEligibility(finding)
  const corrected = correcting === null ? null : settlementsOf(state).find((entry) => settlementKey(entry) === correcting) ?? null
  // What this entry may be: the open balance, plus the return it replaces.
  const open = Math.round(remaining * 100 + (corrected?.amount ?? 0) * 100) / 100
  const enteredExcess = Math.round(parseMoney(amount) * 100) - Math.round(open * 100)
  const supportedExcess = gate.potentialAmountMinor === null ? 0 : Math.max(0, gate.potentialAmountMinor - Math.round(verifiedReturned(state) * 100) + Math.round((corrected?.amount ?? 0) * 100) - Math.round(open * 100))
  const uncounted = Math.max(0, enteredExcess - supportedExcess)

  const startCorrection = (entry: RecoveryVerification) => {
    setTab('money')
    setCorrecting(settlementKey(entry))
    setAmount((entry.receivedAmount ?? entry.amount).toFixed(2))
    setMethod(entry.method)
    setSource(entry.source)
    setReference(entry.reference)
    setAppliedToBill(entry.appliedToBill ?? '')
    setArrivedOn(dateValue(entry.settledAt))
    setExcessConfirmed(false)
    setProofError('')
  }
  const clearEntry = () => {
    setCorrecting(null)
    setAmount(remaining.toFixed(2))
    setReference('')
    setAppliedToBill('')
    setArrivedOn(dateValue(Date.now()))
    setExcessConfirmed(false)
  }

  const logUpdate = () => {
    if (!responseNote.trim()) { setVendorError('Describe what the vendor said or what you sent.'); return }
    const parsedAmount = statusInfo.amount !== 'none' && responseAmount.trim() ? parseMoney(responseAmount) : undefined
    if (statusInfo.amount === 'required' && parsedAmount === undefined) { setVendorError('Enter the amount the vendor accepted.'); return }
    if (parsedAmount === 0) { setVendorError('Enter an amount above $0, or leave it blank if the vendor gave no figure.'); return }
    if (parsedAmount !== undefined && (!Number.isFinite(parsedAmount) || parsedAmount < 0 || parsedAmount > requested)) { setVendorError('Vendor amount must be within the requested amount.'); return }
    if (parsedAmount !== undefined && !isWholeCents(parsedAmount)) { setVendorError('Enter dollars and cents only.'); return }
    if (status === 'partial_acceptance' && parsedAmount !== undefined && (parsedAmount <= 0 || Math.round(parsedAmount * 100) >= Math.round(remaining * 100))) {
      setVendorError(`A partial acceptance is more than $0 and less than ${formatCurrency(remaining)}. For the whole amount, choose "Accepted the claim".`)
      return
    }
    setVendorError('')
    try {
      onVendorUpdate(finding.id, { status, note: responseNote.trim(), at: Date.now(), amount: parsedAmount, method: status === 'promised' ? promisedMethod : status === 'credit_issued' ? 'credit' : undefined, expectedAt: dateFromInput(expectedDate) ?? undefined })
    } catch (error) {
      setVendorError(error instanceof Error ? error.message : 'That reply could not be recorded.')
      return
    }
    setResponseNote('')
    setResponseAmount('')
    setExpectedDate('')
  }

  const recordSettlement = () => {
    if (state.requestedAmount == null) { setProofError('The original requested amount is missing. Confirm it from the request before recording a return.'); return }
    const parsed = parseMoney(amount)
    if (!Number.isFinite(parsed) || parsed <= 0) { setProofError('Enter the amount that arrived, $0.01 or more.'); return }
    if (enteredExcess > 0 && !excessConfirmed) { setProofError(`That is ${formatCurrency(enteredExcess / 100)} more than the ${formatCurrency(open)} still open on this request. Check the amount, or confirm below that more arrived.`); return }
    if (!isWholeCents(parsed)) { setProofError('Enter dollars and cents only.'); return }
    if (!reference.trim()) { setProofError('Enter a settlement reference.'); return }
    if ((method === 'credit' || method === 'offset') && !appliedToBill.trim()) { setProofError('Enter the bill where the credit was actually applied.'); return }
    const settledAt = arrivedAt(arrivedOn, state.vendorUpdates ?? [], Date.now())
    if (settledAt === null || arrivedOn > dateValue(Date.now())) { setProofError('Choose the day the money arrived. It cannot be in the future.'); return }
    if (finding.evidence?.priorReturns?.some((entry) => entry.reference.trim().toLowerCase() === reference.trim().toLowerCase())) {
      setProofError('This return is already part of the evidence review, so it is already taken off the request.')
      return
    }
    const key = settlementKey({ method, reference, appliedToBill: method === 'refund' ? undefined : appliedToBill })
    if (settlementsOf(state).some((entry) => settlementKey(entry) === key && key !== correcting)) {
      setProofError('This settlement reference was already recorded. Check the earlier return before adding another.')
      return
    }
    setProofError('')
    try {
      const entry: SettlementInput = {
        amount: parsed, method, source, reference: reference.trim(), appliedToBill: method === 'refund' ? undefined : appliedToBill.trim() || undefined, settledAt,
        ...(gate.potentialAmountMinor === null ? {} : { supportedAmount: gate.potentialAmountMinor / 100 }),
        ...(enteredExcess > 0 ? { excessConfirmed: true } : {}),
        ...(correcting !== null ? { replaces: correcting } : {}),
      }
      onVerify(finding.id, entry)
    } catch (error) {
      setProofError(error instanceof Error ? error.message : 'That return could not be recorded.')
      return
    }
    clearEntry()
  }

  const removeReturn = () => {
    if (!corrected) return
    try {
      const entry: SettlementInput = { ...corrected, replaces: correcting!, remove: true }
      onVerify(finding.id, entry)
    } catch (error) {
      setProofError(error instanceof Error ? error.message : 'That return could not be removed.')
      return
    }
    setProofError('')
    clearEntry()
  }

  return (
    <section className="wk-panelcard" data-testid="recovery-progress" aria-labelledby="progress-title">
      <div className="wk-panelcard-head">
        <div>
          <h2 id="progress-title">With the vendor</h2>
          <p>
            Asked for {formatCurrency(requested)}{state.recoveryRequestedAt ? ` on ${short.format(state.recoveryRequestedAt)}` : ''}
            {returned > 0 ? ` · ${formatCurrency(returned)} back so far` : ''} · {formatCurrency(remaining)} outstanding
          </p>
        </div>
      </div>

      <div className="wk-panelcard-body wk-stack">
        {state.vendorUpdates?.length || state.recoverySettlements?.length ? (
          <ol className="wk-log" aria-label="Vendor conversation">
            {[
              ...(state.vendorUpdates ?? []).map((update) => ({ at: update.at, kind: 'reply' as const, update })),
              ...(state.recoverySettlements ?? []).filter((settlement) => (settlement.requestGeneration ?? 1) === (state.activeRequestGeneration ?? 1)).map((settlement) => ({ at: settlement.settledAt, kind: 'money' as const, settlement })),
            ]
              .sort((a, b) => a.at - b.at)
              .map((entry, index) => entry.kind === 'reply' ? (
                <li key={`r-${entry.at}-${index}`} data-kind={VENDOR_STATUS[entry.update.status].agreed ? 'agreed' : VENDOR_STATUS[entry.update.status].progress ? 'reply' : 'ours'}>
                  <div><strong>{VENDOR_STATUS[entry.update.status].label}</strong><time>{short.format(entry.update.at)}</time></div>
                  <p>{entry.update.note}</p>
                  {entry.update.amount !== undefined ? <small>{formatCurrency(entry.update.amount)}{entry.update.amountInferred ? ' · the full remaining claim' : ''}{entry.update.expectedAt ? ` · expected ${short.format(entry.update.expectedAt)}` : ''}</small> : entry.update.expectedAt ? <small>Expected {short.format(entry.update.expectedAt)}</small> : null}
                </li>
              ) : (
                <li key={`m-${entry.at}-${index}`} data-kind="money">
                  <div><strong>{formatCurrency(entry.settlement.amount)} came back</strong><time>{short.format(entry.settlement.settledAt)}</time></div>
                  <p>{SETTLEMENT_METHOD_LABEL[entry.settlement.method]} · {entry.settlement.reference}{entry.settlement.appliedToBill ? ` · applied to ${entry.settlement.appliedToBill}` : ''}</p>
                  <ExcessNote entry={entry.settlement} />
                  <button type="button" className="wk-linklike" onClick={() => startCorrection(entry.settlement)} aria-label={`Correct the ${formatCurrency(entry.settlement.amount)} return, ${entry.settlement.reference}`}>Correct this entry</button>
                </li>
              ))}
          </ol>
        ) : (
          <p className="wk-field-hint">Nothing recorded yet. When the vendor replies, log it here. Reclaim never reads your inbox, so replies only show up once you add them.</p>
        )}

        {!state.requiresRevalidation ? <div className="wk-followup">
          <CalendarClock aria-hidden="true" />
          <div className="wk-field">
            <label htmlFor="follow-up-date">Next follow-up</label>
            <input id="follow-up-date" type="date" className="wk-input" value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
          </div>
          <button type="button" className="wk-btn" data-variant="outline" data-size="sm" onClick={() => onFollowUp(finding.id, dateFromInput(followUpDate))}>Save date</button>
        </div> : null}
      </div>

      <div className="wk-panelcard-body wk-stack wk-subsection">
        <div className="wk-seg" role="tablist" aria-label="Record what happened">
          <button type="button" role="tab" aria-selected={tab === 'reply'} aria-pressed={tab === 'reply'} onClick={() => setTab('reply')}>Log a reply</button>
          <button type="button" role="tab" aria-selected={tab === 'money'} aria-pressed={tab === 'money'} onClick={() => setTab('money')}>Record money back</button>
          <button type="button" role="tab" aria-selected={tab === 'close'} aria-pressed={tab === 'close'} onClick={() => setTab('close')}>Close</button>
        </div>

        {tab === 'reply' ? (
          <div className="wk-stack" role="tabpanel" aria-label="Log a reply">
            <div className="wk-fields">
              <div className="wk-field">
                <label htmlFor="vendor-status">What happened?</label>
                <select id="vendor-status" className="wk-input" value={status} onChange={(e) => setStatus(e.target.value as VendorUpdateStatus)}>
                  {VENDOR_STATUS_ORDER.filter((value) => !state.requiresRevalidation || value !== 'followed_up').map((value) => <option key={value} value={value}>{VENDOR_STATUS[value].label}</option>)}
                </select>
              </div>
              {status === 'promised' ? <label className="wk-field">Promised resolution
                <select className="wk-input" value={promisedMethod} onChange={(event) => setPromisedMethod(event.target.value as RecoveryMethod)}>
                  <option value="refund">Refund</option>
                  <option value="credit">Credit</option>
                </select>
              </label> : null}
              {statusInfo.amount !== 'none' ? (
                <div className="wk-field">
                  <label htmlFor="vendor-amount">{statusInfo.amount === 'required' ? 'Amount accepted' : 'Amount mentioned (optional)'}</label>
                  <input id="vendor-amount" className="wk-input" inputMode="decimal" value={responseAmount} onChange={(e) => setResponseAmount(e.target.value)} />
                  <span className="wk-field-hint">
                    {status === 'accepted' ? 'Leave blank if the vendor accepted the full remaining claim.' : statusInfo.amount === 'required' ? `Less than the ${formatCurrency(remaining)} still outstanding.` : 'Shown in the pipeline as agreed, never as money back.'}
                  </span>
                </div>
              ) : null}
              {statusInfo.agreed ? (
                <div className="wk-field">
                  <label htmlFor="vendor-expected">Promised date (optional)</label>
                  <input id="vendor-expected" type="date" className="wk-input" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
                </div>
              ) : null}
              <div className="wk-field" data-wide="true">
                <label htmlFor="vendor-note">Conversation note</label>
                <textarea id="vendor-note" className="wk-input" rows={3} value={responseNote} onChange={(e) => setResponseNote(e.target.value)} placeholder="What did the vendor say, or what did you send?" />
              </div>
            </div>
            {vendorError ? <p className="wk-field-error" role="alert">{vendorError}</p> : null}
            <div className="wk-actions">
              <button type="button" className="wk-btn" data-variant="dark" data-size="sm" onClick={logUpdate}>Add update</button>
              {status === 'followed_up' ? <span className="wk-field-hint">The next reminder is set five business days out.</span> : null}
            </div>
          </div>
        ) : tab === 'money' ? (
          <div className="wk-stack" role="tabpanel" aria-label="Record money back">
            {corrected ? <div className="wk-callout" role="status"><div className="wk-callout-body"><p><strong>Correcting the {formatCurrency(corrected.amount)} return, {corrected.reference}.</strong> Other recorded returns stay as they are, and the change is kept in the case history.</p></div></div> : null}
            <p className="wk-field-hint">Record a refund once it lands in your bank, or a credit once it is applied to a real bill. A promise or an issued credit is not money back.</p>
            <div className="wk-fields">
              <div className="wk-field">
                <label htmlFor="settled-amount">Amount settled</label>
                <input id="settled-amount" className="wk-input" inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); setExcessConfirmed(false) }} />
                <span className="wk-field-hint">The whole amount that arrived for this case.</span>
              </div>
              <div className="wk-field">
                <label htmlFor="settled-date">Date it arrived</label>
                <input id="settled-date" type="date" className="wk-input" max={dateValue(Date.now())} value={arrivedOn} onChange={(e) => setArrivedOn(e.target.value)} />
              </div>
              <div className="wk-field">
                <label htmlFor="settled-method">Came back as</label>
                <select id="settled-method" className="wk-input" value={method} onChange={(e) => setMethod(e.target.value as RecoveryMethod)}>
                  <option value="refund">Cash refund</option>
                  <option value="credit">Applied vendor credit</option>
                  <option value="offset">Offset against payment</option>
                </select>
              </div>
              <div className="wk-field">
                <label htmlFor="settled-source">Checked against</label>
                <select id="settled-source" className="wk-input" value={source} onChange={(e) => setSource(e.target.value as RecoveryVerification['source'])}>
                  <option value="manual">My own records</option>
                  <option value="bank">Bank transaction</option>
                  <option value="accounting">Accounting entry</option>
                  <option value="document">Settlement document</option>
                </select>
              </div>
              <div className="wk-field">
                <label htmlFor="settled-reference">Settlement reference</label>
                <input id="settled-reference" className="wk-input" maxLength={LIMITS.reference} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="ACH ID, credit memo or entry ID" />
                <span className="wk-field-hint">If one payment covered several cases, use the same reference on each and enter only this case’s part here.</span>
              </div>
              {method !== 'refund' ? (
                <div className="wk-field">
                  <label htmlFor="applied-bill">Bill where applied</label>
                  <input id="applied-bill" className="wk-input" maxLength={LIMITS.reference} value={appliedToBill} onChange={(e) => setAppliedToBill(e.target.value)} placeholder="Bill or invoice ID" />
                </div>
              ) : null}
            </div>
            {enteredExcess > 0 ? (
              <label className="wk-radio">
                <input type="checkbox" checked={excessConfirmed} onChange={(e) => { setExcessConfirmed(e.target.checked); setProofError('') }} />
                <span>
                  {formatCurrency(enteredExcess / 100)} more than the request arrived. {uncounted > 0 ? `${formatCurrency(uncounted / 100)} is above what the records support: it is noted on the case and not counted as recovered.` : 'The records support it, so it counts toward this case.'}
                </span>
              </label>
            ) : null}
            {proofError ? <p className="wk-field-error" role="alert">{proofError}</p> : null}
            <div className="wk-actions">
              <button type="button" className="wk-btn" data-variant="primary" data-size="sm" onClick={recordSettlement}>{corrected ? 'Save correction' : 'Record settled value'}</button>
              {corrected ? <>
                <button type="button" className="wk-btn" data-variant="outline" data-size="sm" onClick={removeReturn}>Remove this return</button>
                <button type="button" className="wk-btn" data-variant="ghost" data-size="sm" onClick={() => { setProofError(''); clearEntry() }}>Cancel</button>
              </> : <span className="wk-field-hint">{formatCurrency(remaining)} remains on this request.</span>}
            </div>
          </div>
        ) : (
          <div className="wk-stack" role="tabpanel" aria-label="Close">
            <p className="wk-field-hint">
              {returned > 0
                ? `Close the remaining ${formatCurrency(remaining)} if it is not coming back. The ${formatCurrency(returned)} already recorded stays.`
                : 'Close the case if the money is not coming back. You can reopen it later.'}
            </p>
            <div className="wk-inline-form">
              <div className="wk-field">
                <label htmlFor="close-reason">Reason</label>
                <input id="close-reason" className="wk-input" value={closeReason} onChange={(e) => setCloseReason(e.target.value)} placeholder="For example, vendor disputed the claim" />
              </div>
              <button type="button" className="wk-btn" data-variant="outline" data-size="sm" onClick={() => { if (!closeReason.trim()) { setCloseError('Explain why the case is being closed.'); return } setCloseError(''); onClose(finding.id, closeReason.trim()) }}>Close case</button>
            </div>
            {closeError ? <p className="wk-field-error" role="alert">{closeError}</p> : null}
          </div>
        )}
      </div>
    </section>
  )
}

/** A return that was larger than the claim: what arrived, and what of it counts. */
function ExcessNote({ entry }: { entry: RecoveryVerification }) {
  if (entry.receivedAmount === undefined || entry.receivedAmount <= entry.amount) return null
  return <p className="wk-field-hint">{formatCurrency(entry.receivedAmount)} arrived. {formatCurrency(Math.round((entry.receivedAmount - entry.amount) * 100) / 100)} is more than this claim and is not counted as recovered. Check with the vendor what it was for.</p>
}

/** After money came back: the closeout in the customer's own books. */
export function RecoveryAccountingPanel({ finding, state, onReconcile }: { finding: Finding; state: CaseState; onReconcile: (id: string, note: string, rootCause: string) => void }) {
  const [note, setNote] = useState(state.reconciliationNote ?? '')
  const [rootCause, setRootCause] = useState(state.rootCause ?? '')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const settlements = state.recoverySettlements ?? (state.recoveryVerification ? [state.recoveryVerification] : [])
  const hasRefund = settlements.some((entry) => entry.method === 'refund')
  const hasAppliedCredit = settlements.some((entry) => entry.method === 'credit' || entry.method === 'offset')
  const returned = verifiedReturned(state)
  const requested = state.requestedAmount ?? 0

  if (state.recoveryStage !== 'recovered') return null
  if (returned <= 0) {
    return (
      <section className="wk-panelcard" aria-labelledby="books-title">
        <div className="wk-panelcard-head"><div><h2 id="books-title">In your books</h2><p>This older case is marked recovered with no recorded return amount. Use "Correct returned value" to reopen it and record the settlement first.</p></div></div>
      </section>
    )
  }

  return (
    <section className="wk-panelcard" aria-labelledby="books-title" data-testid="recovery-accounting">
      <div className="wk-panelcard-head">
        <div>
          <h2 id="books-title">In your books</h2>
          <p>{formatCurrency(returned)} came back across {settlements.length || 1} {settlements.length === 1 ? 'settlement' : 'settlements'}{requested > activeReturned(state) && state.recoveryOutcomeNote ? `; the current request has ${formatCurrency(requested - activeReturned(state))} not returned: ${state.recoveryOutcomeNote}` : ''}.</p>
        </div>
      </div>
      <div className="wk-panelcard-body wk-stack">
        {settlements.map((entry) => <ExcessNote key={settlementKey(entry)} entry={entry} />)}
        {state.reconciledAt && !editing ? (
          <div className="wk-callout" data-tone="done">
            <CircleCheck aria-hidden="true" />
            <p><strong>Reconciled {short.format(state.reconciledAt)}.</strong> {state.reconciliationNote}{state.rootCause ? ` · Cause: ${state.rootCause}` : ''}</p>
            <button type="button" className="wk-btn" data-variant="ghost" data-size="sm" onClick={() => setEditing(true)}>Edit reconciliation</button>
          </div>
        ) : (
          <>
            <ul className="wk-checklist">
              <li>Find the original bill or payment and check the vendor's current balance.</li>
              {hasRefund ? <li>Match each cash refund to the deposit that settled it, then record it with your vendor-refund flow.</li> : null}
              {hasAppliedCredit ? <li>Confirm each credit or offset reduced the bill it names. A credit that is issued but unused does not count.</li> : null}
              <li>Make sure the returned amount appears once in your books, and note any amount closed without a return.</li>
            </ul>
            <div className="wk-fields">
              <div className="wk-field" data-wide="true">
                <label htmlFor="reconciliation-note">Where it’s recorded in your books</label>
                <textarea id="reconciliation-note" className="wk-input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: credit CM-88812 applied to bill INV-0460 in QuickBooks" />
              </div>
              <div className="wk-field">
                <label htmlFor="root-cause">What caused it? (optional)</label>
                <select id="root-cause" className="wk-input" value={rootCause} onChange={(e) => setRootCause(e.target.value)}>
                  <option value="">Choose a cause</option>
                  {ROOT_CAUSES.map((cause) => <option key={cause}>{cause}</option>)}
                </select>
              </div>
            </div>
            {error ? <p className="wk-field-error" role="alert">{error}</p> : null}
            <div className="wk-actions">
              <button type="button" className="wk-btn" data-variant="primary" data-size="sm" onClick={() => { if (!note.trim()) { setError('Say where the money is recorded in your books.'); return } setError(''); onReconcile(finding.id, note.trim(), rootCause); setEditing(false) }}>
                {state.reconciledAt ? 'Save reconciliation' : 'Mark reconciled'}
              </button>
              <span className="wk-field-hint">Write down what you did in your accounting system. Reclaim never changes your books.</span>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
