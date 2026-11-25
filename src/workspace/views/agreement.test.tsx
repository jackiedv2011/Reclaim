/**
 * One ledger holding a case in every state, and the same quantity read off every
 * screen that shows it and off the CSV export. If two of them ever mean
 * different money by the same words, this fails.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { parseCsv } from '@/lib/csv'
import { formatCurrency } from '@/lib/format'
import { mergeImport, recordEvidence, setCaseState, type LedgerEnvironment } from '@/ledger/store'
import { confirmCase, markExpected, markNeedsInfo, type CaseState } from '@/ledger/caseState'
import { approveRecovery, closeWithoutRecovery, fileInternalReview, reconcileRecovery, startRecoveryRequest, verifyRecovery } from '@/recovery/model'
import { attestDuplicate } from '@/recovery/testEvidence'
import type { Finding } from '@/types'
import { findingsExportRows } from '../findingsExport'
import { ladder, opportunities } from '../selectors'
import { Audits } from './Audits'
import { Dashboard } from './Dashboard'
import { Findings } from './Findings'
import { Recoveries } from './Recoveries'
import { Reports } from './Reports'

const HEADER = 'vendor,invoice_number,invoice_date,payment_date,invoice_amount,amount_paid,terms,bank_account_last4,currency'
const pair = (vendor: string, amount: number) => [`${vendor},${vendor}-100,2025-01-01,2025-01-10,${amount},${amount},,1111,USD`, `${vendor},${vendor}-100,2025-01-01,2025-01-20,${amount},${amount},,1111,USD`]
const load = (env: LedgerEnvironment | null, name: string, rows: string[]) => mergeImport(env, { sourceLabel: name, mode: 'upload', parsed: parseCsv([HEADER, ...rows].join('\n')) })

const approved = (amount: number): CaseState => ({ ...approveRecovery(confirmCase(null), { at: 100, knownBeforeReclaim: false }), requestedAmount: amount })
const requested = (amount: number) => startRecoveryRequest(approved(amount), amount, 200)
const paid = (state: CaseState, amount: number, reference: string) => verifyRecovery(state, { amount, method: 'refund', source: 'bank', reference, settledAt: 300 })

function everyState(): LedgerEnvironment {
  let env = load(null, 'ledger.csv', [
    ...pair('Undecided', 1000), ...pair('Prepared', 900), ...pair('Approved', 800), ...pair('Sent', 700), ...pair('Reconciled', 600),
    ...pair('AskedLess', 500), ...pair('Closed', 400), ...pair('Dismissed', 300), ...pair('NeedsInfo', 200), ...pair('Replaced', 150),
    // Signals that are never a vendor claim.
    'Similar,S-100,2025-01-01,2025-01-10,90,90,,1111,USD', 'Similar,S-207,2025-01-05,2025-01-20,90,90,,1111,USD',
    'Over,O-100,2025-01-01,2025-01-15,900,980,,1111,USD',
    'Filed,F-100,2025-01-01,2025-01-15,900,970,,1111,USD',
    'Bank,B-100,2025-01-01,2025-01-10,60,60,,2222,USD', 'Bank,B-101,2025-02-01,2025-02-10,61,61,,3333,USD',
    'Discount,D-100,2025-03-01,2025-03-25,1000,1000,2/10 net 30,1111,USD',
    'Euro,E-100,2025-01-01,2025-01-15,900,1200,,1111,EUR',
  ])
  const duplicate = (vendor: string, rows = 2) => env.result.findings.find((f) => f.vendor === vendor && f.type === 'exact_duplicate' && f.relatedRecords.length === rows)!
  const attest = (f: Finding) => { env = recordEvidence(env, f.id, attestDuplicate(f).evidence!) }
  const set = (f: Finding, state: CaseState) => { env = setCaseState(env, f.id, state) }
  const byType = (vendor: string, type: Finding['type']) => env.result.findings.find((f) => f.vendor === vendor && f.type === type)!

  for (const vendor of ['Undecided', 'Prepared', 'Approved', 'Sent', 'Reconciled', 'AskedLess', 'Closed', 'Dismissed', 'NeedsInfo', 'Replaced']) attest(duplicate(vendor))
  set(duplicate('Prepared'), confirmCase(null))
  set(duplicate('Approved'), approved(750))
  set(duplicate('Sent'), paid(requested(700), 250, 'ACH-1'))
  set(duplicate('Reconciled'), reconcileRecovery(paid(requested(600), 600, 'ACH-2'), { note: 'JE-1', rootCause: 'Payment retry' }))
  set(duplicate('AskedLess'), paid(requested(200), 200, 'ACH-3'))
  set(duplicate('Closed'), closeWithoutRecovery(requested(400), 'Vendor refused', 400))
  set(duplicate('Dismissed'), markExpected('Two orders', 'intentional'))
  set(duplicate('NeedsInfo'), markNeedsInfo('Which PO?'))
  set(duplicate('Replaced'), requested(150))
  set(byType('Filed', 'overpayment'), fileInternalReview(confirmCase(null), { subject: 'Check', body: 'Note' }, 100))
  // A third payment replaces a finding whose request is still open.
  env = load(env, 'more.csv', ['Replaced,Replaced-100,2025-01-01,2025-02-01,150,150,,1111,USD'])
  attest(duplicate('Replaced', 3))
  return env
}

const noop = () => {}
const fact = (root: HTMLElement, label: string) => [...root.querySelectorAll('dt')].find((node) => node.textContent === label)?.nextElementSibling?.textContent ?? ''
const total = (root: HTMLElement, key: string) => Number(root.querySelector<HTMLElement>(`[data-total="${key}"]`)!.dataset.amount)
const dollars = (text: string | null | undefined) => Number((text ?? '').replace(/[^\d.-]/g, '')) || 0
const sum = (values: number[]) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100

describe('the same quantity on every screen and in the export', () => {
  afterEach(() => { cleanup(); window.history.replaceState({}, '', '/audit') })
  const env = everyState()
  const visible = new Set(env.result.findings.map((f) => f.id))
  const show = (node: React.ReactElement) => render(node).container
  const dashboard = () => show(<Dashboard env={env} visible={visible} auditLabel="this audit" onOpenCase={noop} onSeeAllFindings={noop} onSeeFindingsKind={noop} onSearchFindings={noop} onNavigate={noop} />)
  const findings = () => show(<Findings env={env} visible={visible} onOpenCase={noop} />)
  const recoveries = () => show(<Recoveries env={env} onOpenCase={noop} onOpenFindings={noop} />)
  const reports = () => show(<Reports env={env} />)
  const summary = { id: 'p1', name: 'This audit', sourceLabel: 'ledger.csv', mode: 'upload' as const, createdAt: 1, updatedAt: 2, recordCount: env.records.length, openCaseCount: 0, flaggedValue: 999, potentialRecoveryValue: ladder(env).potential, recoveryActiveCount: 0, recoveryActiveValue: 0 }
  const audits = (active: boolean) => show(<Audits env={env} projects={[summary]} activeProjectId={active ? 'p1' : 'other'} sampleSession={false} onOpenProject={noop} onStartAudit={noop} onAddRecords={noop} onRunSample={noop} onRemoveImport={() => {}} />)

  const [header, ...rows] = findingsExportRows(opportunities(env), env.result.findings)
  const exported = (column: string, currency = 'USD') => sum(rows.filter((r) => r[header.indexOf('Currency')] === currency).map((r) => Number(r[header.indexOf(column)]) || 0))
  const vendorColumn = (root: HTMLElement, index: number) => { const tables = root.querySelectorAll('.wk-table'); return sum([...tables[tables.length - 1].querySelectorAll('tbody tr')].map((row) => dollars(row.querySelectorAll('td')[index].textContent))) }

  it('holds a case in every state', () => {
    const l = ladder(env)
    // Undecided 1000, Prepared 900, Approved 800 (of which 750 approved), Sent 700-250, AskedLess 500-200, NeedsInfo 200, Replaced 300-150.
    expect(l.potential).toBe(1000 + 900 + 800 + 450 + 300 + 200 + 150)
    expect(l.inRecovery).toBe(750 + 450 + 150)
    expect(l.recovered).toBe(250 + 600 + 200)
    expect(l).toMatchObject({ requestsSent: 2, requestsApproved: 1, flaggedByCurrency: { USD: 90 + 80, EUR: 300 }, atRisk: 61 })
  })

  it('potential recovery', () => {
    const expected = ladder(env).potential
    expect(Number(dashboard().querySelector<HTMLElement>('.wk-ov')!.dataset.potential)).toBe(expected)
    const report = reports()
    expect(fact(report, 'Potential recovery (USD)')).toBe(formatCurrency(expected))
    expect(vendorColumn(report, 4)).toBe(expected)
    for (const active of [true, false]) expect(audits(active).querySelector('.wk-table tbody .wk-table-money')).toHaveTextContent(formatCurrency(expected))
    expect(exported('Potential recovery')).toBe(expected)
  })

  it('flagged for review', () => {
    const expected = ladder(env).flagged
    const home = dashboard()
    expect(total(home, 'review')).toBe(expected)
    expect(home.querySelector('[data-total="review"]')).toHaveTextContent('€300.00')
    const foot = findings().querySelector('.wk-grid-foot')
    expect(foot).toHaveTextContent(`${formatCurrency(expected)} flagged for review, plus €300.00`)
    const report = reports()
    expect(fact(report, 'Open flagged value (USD)')).toBe(formatCurrency(expected))
    expect(fact(report, 'Flagged exposure · EUR')).toBe('€300.00')
    expect(exported('Flagged for review')).toBe(expected)
    expect(exported('Flagged for review', 'EUR')).toBe(300)
  })

  it('approved and sent requests', () => {
    const expected = ladder(env).inRecovery
    const note = '2 requests out with vendors · 1 approved, not sent yet'
    const home = dashboard()
    expect(total(home, 'inRecovery')).toBe(expected)
    expect(home.querySelector('[data-total="inRecovery"]')).toHaveTextContent(note)
    expect(home.querySelector('.wk-flow-step[data-stage="requested"] strong')).toHaveTextContent('2')
    const page = recoveries()
    expect(total(page, 'inRecovery')).toBe(expected)
    expect(page.querySelector('[data-total="inRecovery"]')).toHaveTextContent(note)
    const lane = (stage: string, label: string) => sum([...page.querySelectorAll<HTMLElement>(`.wk-lane[data-stage="${stage}"] .wk-ticket-money`)].filter((n) => n.dataset.label === label).map((n) => dollars(n.textContent)))
    expect(lane('requested', 'outstanding') + lane('confirmed', 'approved, not sent')).toBe(expected)
    // Prepared, not approved: what is left to ask for.
    expect(lane('confirmed', 'to request')).toBe(900)
    expect(exported('Approved outstanding')).toBe(expected)
    // Asked for $200 of a supported $500 and got it: the rest is still offered.
    expect(page.querySelector('.wk-lane[data-stage="recovered"]')).toHaveTextContent('$300.00 can still be requested')
  })

  it('money back', () => {
    const expected = ladder(env).recovered
    expect(total(dashboard(), 'recovered')).toBe(expected)
    const page = recoveries()
    expect(total(page, 'recovered')).toBe(expected)
    const report = reports()
    expect(fact(report, 'Recovered')).toBe(formatCurrency(expected))
    expect(vendorColumn(report, 3)).toBe(expected)
    expect(exported('Returned')).toBe(expected)
  })

  it('open findings and payments to verify', () => {
    const l = ladder(env)
    expect(Number(dashboard().querySelector<HTMLElement>('.wk-ov')!.dataset.openFindings)).toBe(l.openCount)
    const report = reports()
    expect(fact(report, 'Findings')).toBe(String(l.openCount))
    const byCheck = [...report.querySelectorAll('.wk-table')[0].querySelectorAll('tbody tr')]
    expect(sum(byCheck.map((row) => Number(row.querySelectorAll('td')[1].textContent)))).toBe(l.openCount)
    expect(audits(true).querySelectorAll('.wk-table tbody td')[2]).toHaveTextContent(String(l.openCount))
    expect(fact(report, 'Payments to verify (USD)')).toBe(formatCurrency(l.atRisk))
    expect(exported('Payments to verify')).toBe(l.atRisk)
  })

  it('never puts one currency’s sign on another', () => {
    const home = dashboard()
    const euro = [...home.querySelectorAll('.wk-bars-row')].find((row) => row.textContent?.includes('EUR'))!
    expect(euro).toHaveTextContent('€300.00')
    cleanup()
    const list = findings()
    const row = [...list.querySelectorAll('.wk-finding-row')].find((node) => node.textContent?.includes('Euro'))!
    expect(row).toHaveTextContent('€300.00')
    expect(row.textContent).not.toContain('$')
    expect(row.getAttribute('aria-label')).toContain('€300.00')
    expect(rows.find((r) => r[0] === 'Euro')![header.indexOf('Currency')]).toBe('EUR')
  })
})
