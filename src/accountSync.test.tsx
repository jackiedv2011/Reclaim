/**
 * Front end + real server: what happens to an account's audits when a save is
 * large, refused, raced by another tab or device, or the account can't be read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { AuditApp } from '@/AuditApp'
import { AuthProvider, useAuth } from '@/lib/auth/AuthContext'
import { getSampleLedger, sampleLedgerCsv } from '@/data/sampleLedger'
import { parseCsv } from '@/lib/csv'
import { mergeImport, setCaseState } from '@/ledger/store'
import { confirmCase } from '@/ledger/caseState'
import { createProject, deleteProject, hasMemoryOnlyProjects, listLegacyProjects, listProjects, loadAccountProjects, loadProject, overflowSettled, saveProject } from '@/ledger/projects'
import { setOverflowStore, type OverflowStore } from '@/ledger/overflowStore'
import { projectSync } from '@/ledger/projectSync'
import { checkRepeatUpload } from '@/ledger/uploadRegistry'
import { setStorageScope } from '@/lib/storageScope'
import { setFetch as setAuthFetch } from '@/lib/auth/apiAuthService'
import { startLiveServer, type LiveServer } from '@/test/liveServer'

let live: LiveServer
const alice = { firstName: 'Alice', lastName: 'Ng', email: 'alice@example.com', company: 'Ng Co', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery', acceptedTerms: true, termsVersion: 't' }

let auth: ReturnType<typeof useAuth> | null = null
function Gate() {
  auth = useAuth()
  return (
    <>
      <span data-testid="auth-status">{auth.status}:{auth.user?.email ?? 'nobody'}</span>
      {auth.status === 'ready' && auth.user ? <AuditApp key={auth.user.id} /> : null}
    </>
  )
}
function mountWorkspace(path = '/audit') {
  window.history.pushState({}, '', path)
  return render(
    <AuthProvider>
      <Gate />
    </AuthProvider>
  )
}
async function logIn() {
  await act(async () => {
    expect((await auth!.logIn({ email: alice.email, password: alice.password, rememberMe: true })).ok).toBe(true)
  })
  await screen.findByText(`ready:${alice.email}`)
}
async function signedIn(path?: string) {
  mountWorkspace(path)
  await screen.findByText('ready:nobody')
  await logIn()
}

/** Every request the tab makes, with a chance to answer (or fail) it instead of the server. */
function intercept(handle: (url: string, init: RequestInit | undefined) => Response | undefined | Promise<Response | undefined>) {
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => (await handle(String(input), init)) ?? live.fetch(input, init)) as typeof fetch
  projectSync.useFetch(wrapped)
  setAuthFetch(wrapped)
}

const header = 'vendor,invoice_number,invoice_date,payment_date,invoice_amount,amount_paid,terms,bank_account_last4,category'
function bigCsv(rows: number): string {
  const lines = [header]
  for (let i = 0; i < rows; i++) {
    const day = new Date(Date.UTC(2023, 0, 1 + (i % 900))).toISOString().slice(0, 10)
    const amount = (100 + ((i * 7919) % 900_000) / 100).toFixed(2)
    lines.push(`Vendor ${i % 400} Supply Co,INV-${100_000 + i - (i % 50 === 49 ? 1 : 0)},${day},${day},${amount},${amount},net 30,${1000 + (i % 400)},Supplies`)
  }
  return lines.join('\n')
}
const environmentOf = (csv: string, label = 'big.csv') => mergeImport(null, { sourceLabel: label, mode: 'upload', parsed: parseCsv(csv) })
const sample = (label = 'ledger.csv') => mergeImport(null, { sourceLabel: label, mode: 'upload', parsed: getSampleLedger() })
const create = (name: string, environment = sample(`${name}.csv`)) => createProject({ name, sourceLabel: `${name}.csv`, mode: 'upload', environment })
const onServer = async () => (await live.api('/api/projects')).body.projects as Array<Record<string, any>>

function memoryStore(): OverflowStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    put: async (key, text) => void map.set(key, text),
    remove: async (key) => void map.delete(key),
    entries: async (prefix) => [...map].filter(([key]) => key.startsWith(prefix)),
  }
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  live = await startLiveServer()
  await live.api('/api/auth/signup', { method: 'POST', json: alice })
  const [mail] = await live.inbox(alice.email)
  await live.api('/api/auth/verify-email', { method: 'POST', json: { token: live.tokenFrom(mail.link) } })
  await live.api('/api/account/onboarding-seen', { method: 'POST' })
  await live.api('/api/auth/logout', { method: 'POST' })
  live.newBrowser()
})
afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  setOverflowStore(null)
  projectSync.reset()
  setStorageScope(null)
  window.localStorage.clear()
  window.sessionStorage.clear()
  await live.close()
})

describe('an audit larger than browser storage', () => {
  it('reaches the account, and comes back from it after the tab is gone', async () => {
    await signedIn()
    const project = create('big', environmentOf(bigCsv(6000)))
    expect(Object.keys(window.localStorage).some((key) => key.endsWith(project.id) && key.includes('project.v1'))).toBe(false)
    await projectSync.flush()
    expect(projectSync.unsent).toBe(0)
    expect(projectSync.issues).toEqual([])
    const [saved] = await onServer()
    expect(saved.environment.records).toHaveLength(6000)
    await act(() => auth!.logOut())
    await logIn()
    expect(loadProject(project.id)?.environment.records).toHaveLength(6000)
  }, 30_000)

  it('is not cleared by logging out before it reached the account', async () => {
    await signedIn()
    intercept((url) => {
      if (url.startsWith('/api/projects')) throw new TypeError('fetch failed')
      return undefined
    })
    const project = create('big', environmentOf(bigCsv(3000)))
    await projectSync.flush()
    await act(() => auth!.logOut())
    intercept(() => undefined)
    await logIn()
    await projectSync.flush()
    expect(projectSync.unsent).toBe(0)
    expect((await onServer()).map((p) => p.id)).toEqual([project.id])
  }, 30_000)

  it('is kept in the browser’s database, so a reload does not lose it', async () => {
    const store = memoryStore()
    setOverflowStore(store)
    setStorageScope('guest')
    const project = create('big', environmentOf(bigCsv(3000)))
    expect(hasMemoryOnlyProjects()).toBe(true)
    await overflowSettled()
    expect(hasMemoryOnlyProjects()).toBe(false)
    expect(store.map.size).toBe(1)
    deleteProject(project.id)
    await overflowSettled()
    expect(store.map.size).toBe(0)
  })

  it('a file with more payments than an audit can hold is refused before anything is imported', async () => {
    await signedIn()
    fireEvent.click(await screen.findByRole('button', { name: /upload a ledger/i }))
    const input = await screen.findByLabelText(/upload a csv ledger/i)
    fireEvent.change(input, { target: { files: [new File([bigCsv(50_001)], 'huge.csv', { type: 'text/csv' })] } })
    await screen.findByText('huge.csv', {}, { timeout: 20_000 })
    fireEvent.click(screen.getByRole('button', { name: /run the audit/i }))
    expect((await screen.findAllByText(/This file has 50,001 payments\. One audit can hold up to 50,000\./)).length).toBeGreaterThan(0)
    expect(listProjects()).toEqual([])
    expect(projectSync.unsent).toBe(0)
  }, 40_000)
})

describe('decisions', () => {
  async function decideFirst() {
    fireEvent.click(document.querySelectorAll('.wk-queue-row:not([data-locked])')[0])
    fireEvent.click(await screen.findByRole('button', { name: /^I reviewed this check/ }))
    const dialog = await screen.findByTestId('decision-dialog')
    fireEvent.click(within(dialog).getByLabelText(/^(Prepare authorization|Open internal review)/))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }))
    await waitFor(() => expect(screen.getAllByText('Confirmed').length).toBeGreaterThan(0))
  }

  it('opening Findings right after one neither sends a save nor costs the decision', async () => {
    await signedIn()
    fireEvent.click(await screen.findByRole('button', { name: /upload a ledger/i }))
    fireEvent.change(await screen.findByLabelText(/upload a csv ledger/i), { target: { files: [new File([sampleLedgerCsv], 'ledger.csv', { type: 'text/csv' })] } })
    await screen.findByText('ledger.csv')
    fireEvent.click(screen.getByRole('button', { name: /run the audit/i }))
    await screen.findByRole('heading', { name: 'Up next' })
    await waitFor(() => expect(projectSync.pending).toBe(0))
    const puts: string[] = []
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    intercept(async (url, init) => {
      if (init?.method === 'PUT') puts.push(url)
      if (url.endsWith('/case-commands')) await held
      return undefined
    })
    await decideFirst()
    const nav = screen.getByRole('navigation', { name: /workspace/i })
    fireEvent.click(within(nav).getByRole('button', { name: /^Findings/ }))
    await screen.findByRole('heading', { name: 'Findings', level: 1 })
    release()
    await waitFor(() => expect(projectSync.unsent).toBe(0))
    expect(puts).toEqual([])
    expect(projectSync.issues).toEqual([])
    const [saved] = await onServer()
    expect(Object.values(saved.environment.caseStates as Record<string, { decision: string }>).map((s) => s.decision)).toEqual(['confirmed'])
  }, 20_000)

  it('made on the same audit in another tab is kept when this tab decides something else', async () => {
    await signedIn()
    const project = create('shared')
    await projectSync.flush()
    act(() => void window.dispatchEvent(new CustomEvent('reclaim:projects-changed', { detail: { id: null } })))
    await screen.findByRole('heading', { name: 'Up next' })
    const [first] = project.environment.result.findings
    const target = listProjects()[0].id
    // The other tab writes storage; no event has reached this tab yet.
    const key = `reclaim.u.${auth!.user!.id}.reclaim.project.v1.${target}`
    const indexKey = `reclaim.u.${auth!.user!.id}.reclaim.projects.index.v1`
    const theirs = JSON.parse(window.localStorage.getItem(key)!)
    theirs.environment.caseStates[first.id] = { ...confirmCase('from the other tab') }
    theirs.updatedAt += 5
    window.localStorage.setItem(key, JSON.stringify(theirs))
    const index = JSON.parse(window.localStorage.getItem(indexKey)!)
    index[0].updatedAt += 5
    window.localStorage.setItem(indexKey, JSON.stringify(index))
    const row = [...document.querySelectorAll<HTMLElement>('.wk-queue-row:not([data-locked])')].at(-1)!
    fireEvent.click(row)
    fireEvent.click(await screen.findByRole('button', { name: /^I reviewed this check/ }))
    const dialog = await screen.findByTestId('decision-dialog')
    fireEvent.click(within(dialog).getByLabelText(/^(Prepare authorization|Open internal review)/))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save decision' }))
    await waitFor(() => expect(Object.keys(loadProject(project.id)!.environment.caseStates).length).toBe(2))
    await projectSync.flush()
    expect(loadProject(project.id)!.environment.caseStates[first.id]?.reason).toBe('from the other tab')
  }, 20_000)

  it('a change another tab saved is shown here without a reload', async () => {
    await signedIn()
    const project = create('shared')
    await projectSync.flush()
    act(() => void window.dispatchEvent(new CustomEvent('reclaim:projects-changed', { detail: { id: null } })))
    await screen.findByRole('heading', { name: 'Up next' })
    const key = `reclaim.u.${auth!.user!.id}.reclaim.project.v1.${project.id}`
    const theirs = JSON.parse(window.localStorage.getItem(key)!)
    theirs.name = 'renamed in the other tab'
    theirs.updatedAt += 5
    window.localStorage.setItem(key, JSON.stringify(theirs))
    act(() => void window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(theirs) })))
    expect((await screen.findAllByText(/renamed in the other tab/)).length).toBeGreaterThan(0)
  })
})

describe('a refused save', () => {
  it('shows the server’s reason with a way to try again or go back to the saved version', async () => {
    await signedIn()
    const project = create('march')
    await projectSync.flush()
    act(() => void window.dispatchEvent(new CustomEvent('reclaim:projects-changed', { detail: { id: null } })))
    await screen.findByRole('heading', { name: 'Up next' })
    intercept((_url, init) => (init?.method === 'PUT' ? new Response(JSON.stringify({ message: 'This file repeats a ledger you already uploaded.', code: 'repeat_upload' }), { status: 409 }) : undefined))
    await act(async () => {
      saveProject({ ...loadProject(project.id)!, name: 'march with extra rows' })
      await projectSync.flush()
    })
    const notice = await screen.findByTestId('sync-notice')
    expect(notice).toHaveTextContent('This file repeats a ledger you already uploaded.')
    expect(within(notice).getByRole('button', { name: 'Try again' })).toBeInTheDocument()
    await act(async () => {
      fireEvent.click(within(notice).getByRole('button', { name: 'Use the saved version from my account' }))
    })
    await waitFor(() => expect(screen.queryByTestId('sync-notice')).not.toBeInTheDocument())
    expect(loadProject(project.id)!.name).toBe('march')
  })

  it('of an audit that was never saved offers to remove it, and its ledger can then be uploaded again', async () => {
    await signedIn()
    intercept((_url, init) => (init?.method === 'PUT' ? new Response(JSON.stringify({ message: 'This audit is too large to save to your account.', code: 'too_large' }), { status: 413 }) : undefined))
    fireEvent.click(await screen.findByRole('button', { name: /upload a ledger/i }))
    fireEvent.change(await screen.findByLabelText(/upload a csv ledger/i), { target: { files: [new File([sampleLedgerCsv], 'ledger.csv', { type: 'text/csv' })] } })
    await screen.findByText('ledger.csv')
    fireEvent.click(screen.getByRole('button', { name: /run the audit/i }))
    const notice = await screen.findByTestId('sync-notice')
    await waitFor(() => expect(notice).toHaveTextContent('too large to save'))
    expect(checkRepeatUpload(getSampleLedger().records, null).repeat).toBe(true)
    fireEvent.click(within(notice).getByRole('button', { name: 'Remove it from this browser' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove it' }))
    await waitFor(() => expect(listProjects()).toEqual([]))
    expect(checkRepeatUpload(getSampleLedger().records, null).repeat).toBe(false)
  })
})

describe('when the account can’t be read', () => {
  it('says so with a way to try again, and never shows an empty account', async () => {
    await live.api('/api/auth/login', { method: 'POST', json: { email: alice.email, password: alice.password } })
    await live.api('/api/projects/p1', { method: 'PUT', json: JSON.parse(JSON.stringify({ id: 'p1', name: 'Kept safe', sourceLabel: 's.csv', mode: 'upload', createdAt: 1, updatedAt: 2, environment: sample() })) })
    let down = true
    intercept((url) => (down && url.startsWith('/api/projects') ? new Response('{}', { status: 500 }) : undefined))
    mountWorkspace()
    const problem = await screen.findByTestId('audits-problem')
    expect(problem).toHaveTextContent('couldn’t be loaded')
    expect(screen.queryByText('No audit yet', { selector: '.wk-label' })).not.toBeInTheDocument()
    expect(screen.queryByText(/0 audits/i)).not.toBeInTheDocument()
    down = false
    await act(async () => {
      fireEvent.click(within(problem).getByRole('button', { name: 'Try again' }))
    })
    expect(await screen.findByRole('heading', { name: 'Up next' })).toBeInTheDocument()
    expect(screen.queryByTestId('audits-problem')).not.toBeInTheDocument()
  })

  it('one audit this app cannot open leaves the others usable', async () => {
    await live.api('/api/auth/login', { method: 'POST', json: { email: alice.email, password: alice.password } })
    const good = JSON.parse(JSON.stringify({ id: 'good', name: 'Good', sourceLabel: 's.csv', mode: 'upload', createdAt: 1, updatedAt: 2, environment: sample() }))
    await live.api('/api/projects/good', { method: 'PUT', json: good })
    // Passes the server's shape check, but its findings can't be revived.
    const bad = { ...good, id: 'bad', name: 'Bad', environment: { ...good.environment, records: [], result: { findings: [null] } } }
    live.app.db.prepare("INSERT INTO projects (user_id, id, name, source_label, mode, created_at, updated_at, payload, revision) SELECT user_id, 'bad', '', '', 'upload', 1, 1, ?, 1 FROM projects WHERE id = 'good'").run(JSON.stringify(bad))
    mountWorkspace()
    expect(await screen.findByRole('heading', { name: 'Up next' })).toBeInTheDocument()
    expect(screen.getByTestId('audits-problem')).toHaveTextContent('One of your audits couldn’t be opened')
    expect(listProjects().map((p) => p.id)).toEqual(['good'])
  })
})

describe('another device', () => {
  it('an audit deleted there disappears here, unless this browser has work that was never saved', async () => {
    await signedIn()
    const clean = create('clean')
    const dirty = create('dirty', environmentOf(`${header}\nOnly Vendor,N-1,2026-01-01,2026-01-05,100,100,,,`, 'dirty.csv'))
    await projectSync.flush()
    expect(await onServer()).toHaveLength(2)
    await live.api(`/api/projects/${clean.id}`, { method: 'DELETE' })
    await live.api(`/api/projects/${dirty.id}`, { method: 'DELETE' })
    intercept((_url, init) => {
      if (init?.method === 'PUT') throw new TypeError('fetch failed')
      return undefined
    })
    saveProject({ ...loadProject(dirty.id)!, name: 'dirty, renamed here' })
    await projectSync.flush()
    intercept(() => undefined)
    await loadAccountProjects()
    expect(listProjects().map((p) => p.id)).toEqual([dirty.id])
    projectSync.retry()
    await projectSync.flush()
    expect(await onServer()).toHaveLength(0)
    expect(projectSync.syncIssue).toMatchObject({ kind: 'gone', projectId: dirty.id })
    await projectSync.keepAsNew(dirty.id)
    expect((await onServer()).map((p) => p.name)).toEqual(['dirty, renamed here'])
    expect(projectSync.issues).toEqual([])
    expect(projectSync.unsent).toBe(0)
  })

  it('adding payments here after a decision was made there keeps both', async () => {
    await signedIn()
    const project = create('shared')
    await projectSync.flush()
    const finding = project.environment.result.findings[0]
    const decided = await live.api(`/api/projects/${project.id}/case-commands`, {
      method: 'POST',
      json: { commandId: crypto.randomUUID(), expectedRevision: projectSync.revisionOf(project.id), findingId: finding.id, type: 'decision', input: { decision: 'needs_info', reason: 'asked' } },
    })
    expect(decided.status).toBe(200)
    const extra = parseCsv(`${header}\nBrand New Vendor,BN-1,2026-03-01,2026-03-05,50,50,,,`)
    saveProject({ ...project, environment: mergeImport(project.environment, { sourceLabel: 'extra.csv', mode: 'upload', parsed: extra }) })
    await projectSync.flush()
    expect(projectSync.issues).toEqual([])
    const [saved] = await onServer()
    expect(saved.environment.imports).toHaveLength(2)
    expect(saved.environment.caseStates[finding.id].decision).toBe('needs_info')
    // …and this browser now shows the decision too.
    expect(loadProject(project.id)!.environment.caseStates[finding.id].decision).toBe('needs_info')
  })

  it('payments added while a decision is still on its way are saved without it, then the decision follows', async () => {
    await signedIn()
    const project = create('shared')
    await projectSync.flush()
    intercept((url) => {
      if (url.startsWith('/api/projects')) throw new TypeError('fetch failed')
      return undefined
    })
    const finding = project.environment.result.findings[0]
    const decided = saveProject({ ...project, environment: setCaseState(project.environment, finding.id, confirmCase(null)) }, { sync: false })
    projectSync.command(project.id, finding.id, 'decision', { decision: 'confirmed', reason: null })
    const extra = parseCsv(`${header}\nBrand New Vendor,BN-1,2026-03-01,2026-03-05,50,50,,,`)
    saveProject({ ...decided, environment: mergeImport(decided.environment, { sourceLabel: 'extra.csv', mode: 'upload', parsed: extra }) })
    await projectSync.flush()
    intercept(() => undefined)
    projectSync.retry()
    await projectSync.flush()
    expect(projectSync.issues).toEqual([])
    expect(projectSync.unsent).toBe(0)
    const [saved] = await onServer()
    expect(saved.environment.imports).toHaveLength(2)
    expect(saved.environment.caseStates[finding.id].decision).toBe('confirmed')
  })

  it('an unchanged audit is not downloaded again', async () => {
    await signedIn()
    create('a')
    await projectSync.flush()
    const urls: string[] = []
    intercept((url) => void urls.push(url))
    await loadAccountProjects()
    expect(urls).toEqual(['/api/projects?index=1'])
  })
})

describe('a guest who makes an account', () => {
  async function asGuest() {
    mountWorkspace()
    await screen.findByText('ready:nobody')
    act(() => auth!.continueAsGuest())
    await waitFor(() => expect(auth!.user?.isGuest).toBe(true))
  }

  it('is offered the audits they made, and adding them puts them in the account', async () => {
    await asGuest()
    const project = create('guest audit')
    await act(async () => {
      await auth!.logIn({ email: alice.email, password: alice.password, rememberMe: true })
    })
    const dialog = await screen.findByTestId('legacy-import')
    expect(dialog).toHaveTextContent('guest audit')
    fireEvent.click(screen.getByRole('button', { name: 'Add to my account' }))
    await waitFor(() => expect(screen.queryByTestId('legacy-import')).not.toBeInTheDocument())
    expect((await onServer()).map((p) => p.id)).toEqual([project.id])
    expect(listLegacyProjects()).toEqual([])
    expect(loadProject(project.id)?.name).toBe('guest audit')
  })

  it('keeps one too large for browser storage, even in the new tab the confirmation email opens', async () => {
    const store = memoryStore()
    setOverflowStore(store)
    setStorageScope('guest')
    const project = create('big guest audit', environmentOf(bigCsv(3000)))
    await overflowSettled()
    const [[key, text]] = store.map
    // A new tab: nothing in memory, only what the browser stored.
    deleteProject(project.id)
    await overflowSettled()
    store.map.set(key, text)
    setStorageScope(null)
    await signedIn()
    const dialog = await screen.findByTestId('legacy-import')
    expect(dialog).toHaveTextContent('big guest audit')
    fireEvent.click(screen.getByRole('button', { name: 'Add to my account' }))
    await waitFor(() => expect(screen.queryByTestId('legacy-import')).not.toBeInTheDocument(), { timeout: 10_000 })
    expect((await onServer())[0].environment.records).toHaveLength(3000)
    await overflowSettled()
    expect([...store.map.keys()].filter((k) => k.includes('.guest.'))).toEqual([])
  }, 30_000)

  it('coming back signed in (as from Google) is signed in, not still a guest', async () => {
    await asGuest()
    cleanup()
    await live.api('/api/auth/login', { method: 'POST', json: { email: alice.email, password: alice.password } })
    mountWorkspace()
    await screen.findByText(`ready:${alice.email}`)
  })
})

describe('deleting the account', () => {
  it('when refused, leaves the unsent work and its queue exactly as they were', async () => {
    await signedIn()
    intercept((_url, init) => {
      if (init?.method === 'PUT') throw new TypeError('fetch failed')
      return undefined
    })
    const project = create('unsent')
    await projectSync.flush()
    let result: { ok: boolean } | undefined
    await act(async () => {
      result = await auth!.deleteAccount('wrong@example.com')
    })
    expect(result!.ok).toBe(false)
    expect(projectSync.unsent).toBe(1)
    intercept(() => undefined)
    projectSync.retry()
    await projectSync.flush()
    expect((await onServer()).map((p) => p.id)).toEqual([project.id])
  })
})
