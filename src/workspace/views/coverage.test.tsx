/** A screen only says every check ran when every check could. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { parseCsv } from '@/lib/csv'
import { mergeImport, recordEvidence, setCaseState, type LedgerEnvironment } from '@/ledger/store'
import { confirmCase, markExpected } from '@/ledger/caseState'
import { approveRecovery, startRecoveryRequest, verifyRecovery } from '@/recovery/model'
import { attestDuplicate } from '@/recovery/testEvidence'
import { assessRecordReadiness } from '@/audit/dataReadiness'
import { findCaseView } from '@/ledger/views'
import { checkCoverage } from '../selectors'
import { CaseDetail } from './CaseDetail'
import { Dashboard } from './Dashboard'
import { Findings } from './Findings'

afterEach(() => { cleanup(); window.history.replaceState({}, '', '/audit') })
const load = (env: LedgerEnvironment | null, name: string, csv: string[]) => mergeImport(env, { sourceLabel: name, mode: 'upload', parsed: parseCsv(csv.join('\n')) })
const noop = () => {}
const dashboard = (env: LedgerEnvironment) => render(<Dashboard env={env} visible={new Set(env.result.findings.map((f) => f.id))} auditLabel="this audit" onOpenCase={noop} onSeeAllFindings={noop} onSeeFindingsKind={noop} onSearchFindings={noop} onNavigate={noop} />).container
const THIN = ['vendor,payment_date,amount_paid', 'Acme,2025-01-10,100', 'Beta,2025-02-10,250']
const FULL = ['vendor,invoice_number,invoice_date,payment_date,invoice_amount,amount_paid,terms,bank_account_last4', 'Acme,A-100,2025-01-01,2025-01-05,100,98,2/10 net 30,1111', 'Beta,B-100,2025-01-01,2025-01-08,250,245,2/10 net 30,2222']

describe('what the checks could look at', () => {
  it('counts only the checks this file could support', () => {
    const env = load(null, 'thin.csv', THIN)
    const readiness = assessRecordReadiness(env.records, 0, env.imports[0].detectedColumns)
    const said = `${readiness.availableCheckCount} of ${readiness.totalCheckCount} checks could run`
    expect(checkCoverage(env)).toMatchObject({ complete: false, summary: said })
    for (const root of [dashboard(env), render(<Findings env={env} visible={new Set()} onOpenCase={noop} />).container]) {
      expect(root).toHaveTextContent(said)
      expect(root.textContent).not.toMatch(/every check ran/i)
      const list = root.querySelector('[data-testid="check-coverage"]')!
      for (const check of readiness.weakerChecks) expect(list).toHaveTextContent(check.label)
    }
  })
  it('says every check ran when it did', () => {
    const env = load(null, 'full.csv', FULL)
    expect(env.result.findings).toEqual([])
    expect(checkCoverage(env)).toMatchObject({ complete: true, summary: 'Every check ran' })
    expect(dashboard(env)).toHaveTextContent('Every check ran against this audit and found nothing wrong.')
    cleanup()
    expect(render(<Findings env={env} visible={new Set()} onOpenCase={noop} />).container).toHaveTextContent('Every check ran against this ledger')
  })
})

describe('the case page', () => {
  const HEADER = 'vendor,invoice_number,payment_date,invoice_amount,amount_paid,currency'
  function page(env: LedgerEnvironment, id: string, onReopenBalance = vi.fn()) {
    const view = findCaseView(env, id)!
    const { container } = render(<CaseDetail finding={view.finding} findings={env.result.findings} state={view.state} records={env.records} imports={env.imports} discoveredAt={null} sender={{ businessName: '', senderName: '', senderEmail: '' }}
      onSaveEvidence={noop} onDecide={noop} onMarkRequested={noop} onRecordOutcome={noop} onReopen={noop} onReopenBalance={onReopenBalance} onApproveRecovery={noop} onContactHold={noop} onVendorUpdate={noop} onFollowUp={noop} onVerifyRecovery={noop} onCloseRecovery={noop} onReconcileRecovery={noop} />)
    return container
  }

  it('shows every figure, and the explanation, in the record’s currency', () => {
    const env = load(null, 'eur.csv', [HEADER, 'Euro Co,E-100,2025-01-10,900,1200,EUR'])
    const root = page(env, env.result.findings.find((f) => f.type === 'overpayment')!.id)
    expect(root).toHaveTextContent('€300.00')
    expect(root).toHaveTextContent('€1,200.00')
    expect(root.textContent).not.toContain('$')
  })

  it('points at the evidence panel by the name it has', () => {
    const env = load(null, 'a.csv', [HEADER, 'Acme,A-100,2025-01-10,900,900,USD', 'Acme,A-100,2025-01-20,900,900,USD'])
    const root = page(env, env.result.findings[0].id)
    expect(root).toHaveTextContent('Fill in “Review the evidence”')
    expect(screen.getByRole('heading', { name: 'Review the evidence' })).toBeInTheDocument()
  })

  it('offers the rest of a supported amount after a smaller request was paid', () => {
    let env = load(null, 'a.csv', [HEADER, 'Acme,A-100,2025-01-10,1000,1000,USD', 'Acme,A-100,2025-01-20,1000,1000,USD'])
    const id = env.result.findings[0].id
    env = recordEvidence(env, id, attestDuplicate(env.result.findings[0]).evidence!)
    const request = startRecoveryRequest(approveRecovery(confirmCase(null), { at: 100, knownBeforeReclaim: false }), 400, 200)
    env = setCaseState(env, id, verifyRecovery(request, { amount: 400, method: 'refund', source: 'bank', reference: 'ACH-1', settledAt: 300 }))
    const onReopenBalance = vi.fn()
    page(env, id, onReopenBalance)
    screen.getByRole('button', { name: 'Request the remaining $600.00' }).click()
    expect(onReopenBalance).toHaveBeenCalledWith(id)
  })

  it('says why a carried-over dismissal applies', () => {
    let env = load(null, 'a.csv', [HEADER, 'Acme,JOB-7,2025-01-10,,500,USD', 'Acme,JOB-7,2025-01-20,,500,USD'])
    env = setCaseState(env, env.result.findings[0].id, markExpected('Paid in instalments', 'intentional'))
    env = load(env, 'b.csv', [HEADER, 'Acme,JOB-7,2025-01-30,,500,USD'])
    const root = page(env, env.result.findings.find((f) => !f.suppressionReason)!.id)
    expect(root).toHaveTextContent('Carried over from your earlier decision')
    expect(root).toHaveTextContent('Paid in instalments')
    expect(screen.getByRole('button', { name: 'Change decision' })).toBeInTheDocument()
  })
})
