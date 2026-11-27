import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { confirmCase } from '@/ledger/caseState'
import { approveRecovery, reconcileRecovery, recordVendorUpdate, startRecoveryRequest, verifyRecovery } from '@/recovery/model'
import type { Finding } from '@/types'
import { settlementKey } from '@/recovery/financials'
import type { SettlementInput } from '@/recovery/model'
import { RecoveryAccountingPanel, RecoveryProgressPanel } from './RecoveryJourney'
import { InternalReviewPanel } from './RecoveryPanels'

const finding: Finding = {
  id: 'f1', type: 'exact_duplicate', class: 'recoverable', severity: 'high', vendor: 'Acme',
  dollarImpact: 1000, title: 'Duplicate payment', explanation: 'Same invoice paid twice', relatedRecords: [],
}

it('closes an internal investigation with a note and no unsupported recovery claim', () => {
  const onClose = vi.fn()
  render(<InternalReviewPanel onClose={onClose} />)
  expect(screen.queryByRole('button', { name: 'Money came back' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Close internal review' }))
  expect(screen.getByRole('alert')).toHaveTextContent(/note/i)
  fireEvent.change(screen.getByLabelText('Investigation outcome'), { target: { value: 'Bank details confirmed internally' } })
  fireEvent.click(screen.getByRole('button', { name: 'Close internal review' }))
  expect(onClose).toHaveBeenCalledWith('Bank details confirmed internally')
})

it('holds a legacy recovered case without an amount outside accounting closeout', () => {
  const legacy = { ...confirmCase(null), recoveryStage: 'recovered' as const, requestedAmount: 1000, recoveredAmount: null }
  render(<RecoveryAccountingPanel finding={finding} state={legacy} onReconcile={vi.fn()} />)
  expect(screen.getByText(/no recorded return amount/i)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Mark reconciled' })).not.toBeInTheDocument()
})

it('hides follow-up actions on a historical request while keeping replies and returns available', () => {
  const state = { ...startRecoveryRequest(approveRecovery(confirmCase(null), { knownBeforeReclaim: false }), 1000), requiresRevalidation: true }
  render(<RecoveryProgressPanel finding={finding} state={state} onVendorUpdate={vi.fn()} onFollowUp={vi.fn()} onVerify={vi.fn()} onClose={vi.fn()} />)
  expect(screen.queryByLabelText('Next follow-up')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Save date' })).not.toBeInTheDocument()
  expect(screen.queryByRole('option', { name: /followed up/i })).not.toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Log a reply' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Record money back' })).toBeInTheDocument()
})

it('keeps an issued credit pending and requires application proof before recording recovery', () => {
  let state = startRecoveryRequest(approveRecovery(confirmCase(null), { knownBeforeReclaim: false }), 1000)
  state = recordVendorUpdate(state, { status: 'credit_issued', note: 'CM-14 issued', at: Date.now() })
  const onVerify = vi.fn()
  render(<RecoveryProgressPanel finding={finding} state={state} onVendorUpdate={vi.fn()} onFollowUp={vi.fn()} onVerify={onVerify} onClose={vi.fn()} />)
  // An issued credit opens the panel on recording money back, and says it is not money back yet.
  expect(screen.getByRole('tab', { name: 'Record money back' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByText(/issued credit is not money back/i)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Came back as'), { target: { value: 'credit' } })
  fireEvent.change(screen.getByLabelText('Settlement reference'), { target: { value: 'CM-14' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record settled value' }))
  expect(screen.getByRole('alert')).toHaveTextContent(/bill/i)
  expect(onVerify).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Bill where applied'), { target: { value: 'BILL-7' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record settled value' }))
  expect(onVerify).toHaveBeenCalledWith(finding.id, expect.objectContaining({ method: 'credit', appliedToBill: 'BILL-7', amount: 1000 }))
})

it('explains duplicate settlement references before saving', () => {
  const requested = startRecoveryRequest(approveRecovery(confirmCase(null), { knownBeforeReclaim: false }), 1000)
  const partial = verifyRecovery(requested, { amount: 300, method: 'refund', source: 'bank', reference: 'ACH-1', settledAt: Date.now() })
  const onVerify = vi.fn()
  render(<RecoveryProgressPanel finding={finding} state={partial} onVendorUpdate={vi.fn()} onFollowUp={vi.fn()} onVerify={onVerify} onClose={vi.fn()} />)
  fireEvent.change(screen.getByLabelText('Settlement reference'), { target: { value: 'ach-1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Record settled value' }))
  expect(screen.getByRole('alert')).toHaveTextContent(/already recorded/i)
  expect(onVerify).not.toHaveBeenCalled()
})

it('tells the customer when a partial return is still awaiting final closeout', () => {
  const requested = startRecoveryRequest(approveRecovery(confirmCase(null), { knownBeforeReclaim: false }), 1000)
  const partial = verifyRecovery(requested, { amount: 600, method: 'refund', source: 'bank', reference: 'ACH-1', settledAt: Date.now() })
  // Accounting closeout waits for the case to finish; the open request says what is back and what is not.
  const { container } = render(<RecoveryAccountingPanel finding={finding} state={partial} onReconcile={vi.fn()} />)
  expect(container).toBeEmptyDOMElement()
  render(<RecoveryProgressPanel finding={finding} state={partial} onVendorUpdate={vi.fn()} onFollowUp={vi.fn()} onVerify={vi.fn()} onClose={vi.fn()} />)
  expect(screen.getByText(/\$600\.00 back so far/)).toHaveTextContent('$400.00 outstanding')
})

it('shows method-specific accounting checks after cash and applied-credit returns', () => {
  const requested = startRecoveryRequest(approveRecovery(confirmCase(null), { knownBeforeReclaim: false }), 1000)
  const partial = verifyRecovery(requested, { amount: 600, method: 'refund', source: 'bank', reference: 'ACH-1', settledAt: Date.now() })
  const settled = verifyRecovery(partial, { amount: 400, method: 'credit', source: 'accounting', reference: 'CM-2', appliedToBill: 'BILL-2', settledAt: Date.now() })
  render(<RecoveryAccountingPanel finding={finding} state={settled} onReconcile={vi.fn()} />)
  expect(screen.getByText(/match each cash refund/i)).toBeInTheDocument()
  expect(screen.getByText(/confirm each credit or offset reduced/i)).toBeInTheDocument()
})

it('lets a reconciled case correct its accounting note without reopening settlement proof', () => {
  const requested = startRecoveryRequest(approveRecovery(confirmCase(null), { knownBeforeReclaim: false }), 1000)
  const settled = verifyRecovery(requested, { amount: 1000, method: 'refund', source: 'bank', reference: 'ACH-1', settledAt: Date.now() })
  const reconciled = reconcileRecovery(settled, { note: 'Original entry', rootCause: 'Payment retry' })
  const onReconcile = vi.fn()
  render(<RecoveryAccountingPanel finding={finding} state={reconciled} onReconcile={onReconcile} />)
  fireEvent.click(screen.getByRole('button', { name: 'Edit reconciliation' }))
  fireEvent.change(screen.getByLabelText('Where it’s recorded in your books'), { target: { value: 'Corrected entry' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save reconciliation' }))
  expect(onReconcile).toHaveBeenCalledWith(finding.id, 'Corrected entry', 'Payment retry')
})

const open = () => startRecoveryRequest(approveRecovery(confirmCase(null), { knownBeforeReclaim: false }), 1000)
const day = (time: number) => { const d = new Date(time); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function moneyTab(state = open()) {
  const onVerify = vi.fn<(id: string, proof: SettlementInput) => void>()
  const onVendorUpdate = vi.fn()
  render(<RecoveryProgressPanel finding={finding} state={state} onVendorUpdate={onVendorUpdate} onFollowUp={vi.fn()} onVerify={onVerify} onClose={vi.fn()} />)
  fireEvent.click(screen.getByRole('tab', { name: 'Record money back' }))
  return { onVerify, onVendorUpdate, record: () => fireEvent.click(screen.getByRole('button', { name: 'Record settled value' })) }
}

it('records the day the money arrived, and refuses a day that has not happened', () => {
  const { onVerify, record } = moneyTab()
  const date = screen.getByLabelText('Date it arrived')
  expect(date).toHaveValue(day(Date.now()))
  fireEvent.change(screen.getByLabelText('Settlement reference'), { target: { value: 'ACH-1' } })
  fireEvent.change(date, { target: { value: day(Date.now() + 3 * 86_400_000) } })
  record()
  expect(screen.getByRole('alert')).toHaveTextContent(/future/)
  fireEvent.change(date, { target: { value: '2026-01-15' } })
  record()
  expect(day(onVerify.mock.calls[0][1].settledAt)).toBe('2026-01-15')
})

it('asks before recording more than was requested, and says what will not count', () => {
  const { onVerify, record } = moneyTab()
  fireEvent.change(screen.getByLabelText('Amount settled'), { target: { value: '1,050' } })
  fireEvent.change(screen.getByLabelText('Settlement reference'), { target: { value: 'ACH-1' } })
  record()
  expect(screen.getByRole('alert')).toHaveTextContent('$50.00 more than the $1,000.00 still open')
  expect(onVerify).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('checkbox', { name: /\$50\.00 more than the request arrived.*not counted/ }))
  record()
  expect(onVerify).toHaveBeenCalledWith(finding.id, expect.objectContaining({ amount: 1050, excessConfirmed: true }))
  const settled = verifyRecovery(open(), onVerify.mock.calls[0][1])
  expect(settled.recoveredAmount).toBe(1000)
})

it('corrects or removes one recorded return from the open case', () => {
  const state = verifyRecovery(verifyRecovery(open(), { amount: 300, method: 'refund', source: 'bank', reference: 'ACH-1', settledAt: Date.now() }), { amount: 40, method: 'refund', source: 'bank', reference: 'ACH-2', settledAt: Date.now() })
  const { onVerify } = moneyTab(state)
  fireEvent.click(screen.getByRole('button', { name: /Correct the \$40\.00 return, ACH-2/ }))
  expect(screen.getByLabelText('Amount settled')).toHaveValue('40.00')
  expect(screen.getByLabelText('Settlement reference')).toHaveValue('ACH-2')
  fireEvent.change(screen.getByLabelText('Amount settled'), { target: { value: '400' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save correction' }))
  const key = settlementKey({ method: 'refund', reference: 'ACH-2' })
  expect(onVerify).toHaveBeenLastCalledWith(finding.id, expect.objectContaining({ amount: 400, replaces: key }))
  expect(verifyRecovery(state, onVerify.mock.calls[0][1]).recoveredAmount).toBe(700)
  fireEvent.click(screen.getByRole('button', { name: /Correct the \$40\.00 return, ACH-2/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove this return' }))
  expect(verifyRecovery(state, onVerify.mock.calls[1][1]).recoveredAmount).toBe(300)
})

it('refuses a $0 vendor figure before it reaches the server', () => {
  const { onVendorUpdate } = moneyTab()
  fireEvent.click(screen.getByRole('tab', { name: 'Log a reply' }))
  fireEvent.change(screen.getByLabelText('What happened?'), { target: { value: 'promised' } })
  fireEvent.change(screen.getByLabelText('Amount mentioned (optional)'), { target: { value: '0' } })
  fireEvent.change(screen.getByLabelText('Conversation note'), { target: { value: 'Refund coming' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add update' }))
  expect(screen.getByRole('alert')).toHaveTextContent('above $0')
  expect(onVendorUpdate).not.toHaveBeenCalled()
})
