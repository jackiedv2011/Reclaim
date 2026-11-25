import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getSampleLedger } from '@/data/sampleLedger'
import { confirmCase } from '@/ledger/caseState'
import { createProject, deleteProject, findingBefore, loadProject, saveProject, type LedgerProject } from '@/ledger/projects'
import { projectSync } from '@/ledger/projectSync'
import { mergeImport, recordEvidence, setCaseState } from '@/ledger/store'
import { setStorageScope } from '@/lib/storageScope'
import { attestDuplicate } from '@/recovery/testEvidence'

type Call = { method: string; url: string; body: Record<string, unknown> | null; headers: Headers }
let calls: Call[] = []
const environment = () => mergeImport(null, { sourceLabel: 'march.csv', mode: 'upload', parsed: getSampleLedger() })
const make = (name: string): LedgerProject => createProject({ name, sourceLabel: `${name}.csv`, mode: 'upload', environment: environment() })
const answer = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status })

async function readBody(init?: RequestInit): Promise<Record<string, unknown> | null> {
  if (!init?.body) return null
  const gz = new Headers(init.headers).get('Content-Encoding') === 'gzip'
  const stream = new Response(init.body as BodyInit).body!
  return (await new Response(gz ? stream.pipeThrough(new DecompressionStream('gzip')) : stream).json()) as Record<string, unknown>
}

/** Answers each request with `respond`; records what was sent. */
function serve(respond: (call: Call) => Response | Promise<Response>) {
  calls = []
  projectSync.useFetch((async (url: string, init?: RequestInit) => {
    const call = { method: init?.method ?? 'GET', url, body: await readBody(init), headers: new Headers(init?.headers) }
    calls.push(call)
    return respond(call)
  }) as typeof fetch)
}
const ok = (call: Call) => answer(200, call.method === 'PUT' ? { ok: true, revision: 1 } : {})
const sent = () => calls.map((call) => `${call.method} ${call.url.replace('/api/projects/', '').replace('/case-commands', ' command')}`)

beforeEach(() => {
  window.localStorage.clear()
  setStorageScope('sync-test')
  projectSync.reset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  projectSync.reset()
  window.localStorage.clear()
  setStorageScope(null)
})

describe('what is refused', () => {
  it('stays visible in the server’s own words, keeps the local work, and does not hold up other audits', async () => {
    let blocked = ''
    serve((call) => (call.url.includes(blocked) ? answer(402, { message: 'The Free plan includes 3 audits a month.' }) : ok(call)))
    blocked = make('blocked').id
    make('later')
    await projectSync.flush()
    await projectSync.flush()
    expect(calls).toHaveLength(2)
    expect(projectSync.pending).toBe(0)
    expect(projectSync.unsent).toBe(1)
    expect(projectSync.issues).toHaveLength(1)
    expect(projectSync.syncIssue).toMatchObject({ projectId: blocked, status: 402, kind: 'refused', name: 'blocked', savedVersion: false, message: 'The Free plan includes 3 audits a month.' })
    expect(loadProject(blocked)).not.toBeNull()
  })

  it('can be tried again', async () => {
    let status = 402
    serve((call) => (status === 200 ? ok(call) : answer(status, { message: 'No.' })))
    const project = make('a')
    await projectSync.flush()
    status = 200
    projectSync.retry(project.id)
    await projectSync.flush()
    expect(projectSync.issues).toEqual([])
    expect(projectSync.unsent).toBe(0)
  })

  it('can be given up for the version in the account', async () => {
    serve(ok)
    const project = make('a')
    await projectSync.flush()
    const saved = calls[0].body!
    serve((call) => (call.method === 'GET' ? answer(200, { project: saved, revision: 4 }) : answer(409, { code: 'repeat_upload', message: 'This file repeats a ledger.' })))
    saveProject({ ...loadProject(project.id)!, name: 'renamed here' })
    await projectSync.flush()
    expect(projectSync.syncIssue).toMatchObject({ kind: 'refused', savedVersion: true })
    await projectSync.useSaved(project.id)
    expect(loadProject(project.id)!.name).toBe('a')
    expect(projectSync.issues).toEqual([])
    expect(projectSync.unsent).toBe(0)
    expect(projectSync.revisionOf(project.id)).toBe(4)
  })

  it('a deleted audit takes its queued steps and its refusal with it, and deleting one already gone succeeds', async () => {
    serve((call) => (call.method === 'DELETE' ? answer(404) : answer(400, { message: 'No.' })))
    const project = make('a')
    projectSync.command(project.id, 'f1', 'decision', {})
    await projectSync.flush()
    expect(projectSync.unsent).toBe(2)
    deleteProject(project.id)
    await projectSync.flush()
    expect(sent().at(-1)).toBe(`DELETE ${project.id}`)
    expect(projectSync.unsent).toBe(0)
    expect(projectSync.issues).toEqual([])
  })
})

describe('sessions and connections', () => {
  it('a session that expired keeps the queue for the next log-in instead of dropping work', async () => {
    serve(() => answer(401))
    make('p1')
    await projectSync.flush()
    expect(projectSync.pending).toBe(1)
    expect(projectSync.syncIssue).toMatchObject({ status: 401, kind: 'signed_out' })
  })

  it('no connection keeps everything and says it will be retried', async () => {
    serve(() => Promise.reject(new TypeError('fetch failed')))
    make('a')
    make('b')
    await projectSync.flush()
    expect(calls).toHaveLength(1)
    expect(projectSync.pending).toBe(2)
    expect(projectSync.syncIssue).toMatchObject({ kind: 'waiting', status: null })
    serve(ok)
    projectSync.retry()
    await projectSync.flush()
    expect(projectSync.unsent).toBe(0)
    expect(projectSync.issues).toEqual([])
  })

  it('a server error on one audit does not hold up another', async () => {
    let bad = ''
    serve((call) => (call.url.includes(bad) ? answer(500) : ok(call)))
    bad = make('bad').id
    make('good')
    await projectSync.flush()
    expect(projectSync.unsent).toBe(1)
    expect(projectSync.syncIssue).toMatchObject({ kind: 'waiting', projectId: bad })
  })
})

describe('full browser storage', () => {
  it('never stops a save from being sent', async () => {
    serve(ok)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError')
    })
    const project = make('big')
    await projectSync.flush()
    expect(sent()).toEqual([`PUT ${project.id}`])
    expect(projectSync.unsent).toBe(0)
    expect(projectSync.issues).toEqual([])
  })

  it('the stored queue holds no copy of the audit', () => {
    serve(() => Promise.reject(new TypeError('offline')))
    const project = make('a')
    const queued = Object.keys(window.localStorage).filter((key) => key.includes('sync.v2'))
    expect(queued).toHaveLength(1)
    expect(window.localStorage.getItem(queued[0])!.length).toBeLessThan(200)
    expect(window.localStorage.getItem(queued[0])).toContain(project.id)
  })

  it('an audit marked unsaved is queued again on the next visit even if its queue entry was lost', async () => {
    serve(() => Promise.reject(new TypeError('offline')))
    const project = make('a')
    await projectSync.flush()
    for (const key of Object.keys(window.localStorage)) if (key.includes('sync.v2')) window.localStorage.removeItem(key)
    projectSync.reset(true)
    serve(ok)
    projectSync.restore()
    await projectSync.flush()
    projectSync.retry()
    await projectSync.flush()
    expect(sent()).toContain(`PUT ${project.id}`)
    expect(projectSync.unsent).toBe(0)
  })

  it('a queue entry that could not be stored still survives logging out and in again in this tab', async () => {
    serve(() => Promise.reject(new TypeError('offline')))
    const project = make('a')
    const real = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key.includes('sync.v2')) throw new DOMException('quota', 'QuotaExceededError')
      return real.call(this, key, value)
    })
    projectSync.command(project.id, 'f1', 'decision', { decision: 'confirmed', reason: null })
    await projectSync.flush()
    projectSync.reset(true)
    setStorageScope(null)
    setStorageScope('sync-test')
    projectSync.restore()
    expect(projectSync.unsent).toBe(2)
  })

  it('reads the queue an earlier version left, whole projects and all', async () => {
    serve(() => Promise.reject(new TypeError('offline')))
    const project = make('old')
    const stored = JSON.parse(window.localStorage.getItem(`reclaim.u.sync-test.reclaim.project.v1.${project.id}`)!)
    projectSync.reset()
    window.localStorage.clear()
    window.localStorage.setItem('reclaim.u.sync-test.reclaim.project.sync.v1', JSON.stringify({ queue: [{ kind: 'put', project: stored }, { kind: 'command', id: 'p2', findingId: 'f', type: 'decision', input: {}, commandId: 'c1' }], revisions: [['p2', 7]] }))
    projectSync.restore()
    expect(projectSync.unsent).toBe(2)
    expect(projectSync.revisionOf('p2')).toBe(7)
    expect(loadProject(project.id)?.name).toBe('old')
    expect(window.localStorage.getItem('reclaim.u.sync-test.reclaim.project.sync.v1')).toBeNull()
  })
})

describe('case commands', () => {
  async function saved(): Promise<{ project: LedgerProject; raw: Record<string, unknown>; findingId: string }> {
    serve(ok)
    const project = make('a')
    await projectSync.flush()
    return { project, raw: calls[0].body!, findingId: project.environment.result.findings[0].id }
  }
  function decide(project: LedgerProject, findingId: string) {
    const before = findingBefore(project.environment, findingId)
    const next = saveProject({ ...project, environment: setCaseState(project.environment, findingId, confirmCase(null)) }, { sync: false })
    projectSync.command(project.id, findingId, 'decision', { decision: 'confirmed', reason: null }, before)
    return next
  }

  it('one the server refuses is undone, with the reason, and the saved version is shown', async () => {
    const { project, raw, findingId } = await saved()
    serve((call) => (call.method === 'GET' ? answer(200, { project: raw, revision: 1 }) : answer(409, { code: 'invalid_transition', message: 'Review the case first.' })))
    decide(loadProject(project.id)!, findingId)
    await projectSync.flush()
    expect(projectSync.unsent).toBe(0)
    expect(projectSync.syncIssue).toMatchObject({ kind: 'undone', name: 'a' })
    expect(projectSync.syncIssue!.message).toContain('Review the case first.')
    expect(loadProject(project.id)!.environment.caseStates[findingId]).toBeUndefined()
    projectSync.dismiss(projectSync.issues[0])
    expect(projectSync.issues).toEqual([])
  })

  it('a refused command with another one queued behind it undoes only itself', async () => {
    const { project, raw, findingId } = await saved()
    const second = project.environment.result.findings[1].id
    serve((call) => {
      if (call.method === 'GET') return answer(200, { project: raw, revision: 1 })
      if (call.body!.findingId === findingId) return answer(409, { code: 'invalid_transition', message: 'No.' })
      return answer(200, { revision: 2, case: { findingId: second, state: { decision: 'confirmed', reason: null, decidedAt: 5, recoveryStage: 'confirmed' }, finding: null }, updatedAt: 9 })
    })
    decide(decide(loadProject(project.id)!, findingId), second)
    await projectSync.flush()
    expect(projectSync.unsent).toBe(0)
    expect(projectSync.issues).toMatchObject([{ kind: 'undone' }])
  })

  it('is retried once on the newer revision when another device moved the audit on', async () => {
    const { project, raw, findingId } = await saved()
    const revisions: unknown[] = []
    serve((call) => {
      if (call.method === 'GET') return answer(200, { project: raw, revision: 8 })
      revisions.push(call.body!.expectedRevision)
      return call.body!.expectedRevision === 8 ? answer(200, { revision: 9, case: { findingId, state: { decision: 'confirmed' }, finding: null } }) : answer(409, { code: 'revision_conflict', message: 'Changed elsewhere.' })
    })
    decide(loadProject(project.id)!, findingId)
    await projectSync.flush()
    expect(revisions).toEqual([1, 8])
    expect(projectSync.issues).toEqual([])
    expect(projectSync.unsent).toBe(0)
  })

  it('that still conflicts after being retried is undone and said, not looped', async () => {
    const { project, raw, findingId } = await saved()
    serve((call) => (call.method === 'GET' ? answer(200, { project: raw, revision: 8 }) : answer(409, { code: 'revision_conflict', message: 'Changed elsewhere.' })))
    decide(loadProject(project.id)!, findingId)
    await projectSync.flush()
    expect(sent().filter((line) => line.startsWith('POST'))).toHaveLength(2)
    expect(projectSync.syncIssue).toMatchObject({ kind: 'undone', status: 409 })
  })

  it('whose answer was lost, and which the server already ran, is not reported as a failure', async () => {
    const { project, raw, findingId } = await saved()
    const applied = structuredClone(raw) as { environment: { caseStates: Record<string, unknown> } }
    applied.environment.caseStates[findingId] = { decision: 'confirmed', reason: null, decidedAt: 1, recoveryStage: 'confirmed' }
    serve((call) => (call.method === 'GET' ? answer(200, { project: applied, revision: 2 }) : answer(409, { code: 'command_reused', message: 'Reused.' })))
    decide(loadProject(project.id)!, findingId)
    await projectSync.flush()
    expect(projectSync.issues).toEqual([])
    expect(loadProject(project.id)!.environment.caseStates[findingId].decision).toBe('confirmed')
  })

  it('for an audit deleted on another device waits for a choice instead of being discarded', async () => {
    const { project, findingId } = await saved()
    serve(() => answer(404, { message: 'That project is not in this account.' }))
    decide(loadProject(project.id)!, findingId)
    await projectSync.flush()
    expect(projectSync.unsent).toBe(1)
    expect(projectSync.syncIssue).toMatchObject({ projectId: project.id, kind: 'gone' })
    projectSync.discard(project.id)
    expect(loadProject(project.id)).toBeNull()
    expect(projectSync.unsent).toBe(0)
    expect(projectSync.issues).toEqual([])
  })

  it('restores an unsent command with its original revision after a reload, then rebases it', async () => {
    const { project, raw, findingId } = await saved()
    serve(() => answer(401))
    decide(loadProject(project.id)!, findingId)
    await projectSync.flush()
    projectSync.reset(true)
    projectSync.restore()
    expect(projectSync.pending).toBe(1)
    const revisions: unknown[] = []
    serve((call) => {
      if (call.method === 'GET') return answer(200, { project: raw, revision: 8 })
      revisions.push(call.body!.expectedRevision)
      return answer(409, { code: 'revision_conflict', message: 'Changed elsewhere.' })
    })
    await projectSync.flush()
    expect(revisions).toEqual([1, 8])
    expect(projectSync.syncIssue).toMatchObject({ status: 409 })
  })
})

describe('a whole-project save', () => {
  it('never carries a decision that is still queued as a command, for a new audit or a saved one', async () => {
    serve(() => Promise.reject(new TypeError('offline')))
    let project = make('a')
    const target = project.environment.result.findings.find((f) => f.type === 'exact_duplicate')!
    const before = findingBefore(project.environment, target.id)
    const env = recordEvidence(project.environment, target.id, attestDuplicate(target).evidence!)
    project = saveProject({ ...project, environment: env }, { sync: false })
    projectSync.command(project.id, target.id, 'evidence', {}, before)
    saveProject({ ...project, environment: setCaseState(env, target.id, confirmCase(null)) }, { sync: false })
    projectSync.command(project.id, target.id, 'decision', { decision: 'confirmed', reason: null }, findingBefore(env, target.id))
    await projectSync.flush()
    serve((call) => (call.method === 'PUT' ? ok(call) : answer(401)))
    projectSync.retry()
    await projectSync.flush()
    const body = calls.find((call) => call.method === 'PUT')!.body as { environment: { caseStates: object; result: { findings: Array<Record<string, unknown>> } } }
    expect(body.environment.caseStates).toEqual({})
    const finding = body.environment.result.findings.find((f) => f.id === target.id)!
    expect(finding.evidence ?? null).toBeNull()
    expect(finding.classification).not.toBe('recovery_candidate')
    // …and the decision is still what this browser shows.
    expect(loadProject(project.id)!.environment.caseStates[target.id].decision).toBe('confirmed')
  })

  it('is compressed when it is large', async () => {
    serve(ok)
    make('a')
    await projectSync.flush()
    expect(calls[0].headers.get('Content-Encoding')).toBe('gzip')
    expect((calls[0].body as { name: string }).name).toBe('a')
  })

  it('is refused rather than replacing payments another device added', async () => {
    serve(ok)
    const project = make('a')
    await projectSync.flush()
    const theirs = structuredClone(calls[0].body!) as { environment: { imports: Array<{ id: string }> } }
    theirs.environment.imports.push({ id: 'batch_elsewhere' })
    serve((call) => (call.method === 'GET' ? answer(200, { project: theirs, revision: 2 }) : answer(409, { code: 'revision_conflict', message: 'This project changed on another device.' })))
    saveProject({ ...loadProject(project.id)!, name: 'renamed' })
    await projectSync.flush()
    expect(sent().filter((line) => line.startsWith('PUT'))).toHaveLength(1)
    expect(projectSync.syncIssue).toMatchObject({ kind: 'refused', savedVersion: true, message: 'This project changed on another device.' })
  })
})

describe('two tabs', () => {
  const storageEvent = (key: string, newValue: string | null) => window.dispatchEvent(new StorageEvent('storage', { key, newValue }))

  it('share one queue: each adds its own entries, and a step another tab finished is not sent again', async () => {
    serve(() => Promise.reject(new TypeError('offline')))
    const project = make('mine')
    await projectSync.flush()
    // Another tab queued a command.
    const theirs = { key: 'zzzzzzzzz-00000-other', id: project.id, kind: 'command', findingId: 'f', type: 'decision', input: {}, commandId: crypto.randomUUID() }
    const key = `reclaim.u.sync-test.reclaim.project.sync.v2.${theirs.key}`
    window.localStorage.setItem(key, JSON.stringify(theirs))
    storageEvent(key, JSON.stringify(theirs))
    expect(projectSync.unsent).toBe(2)
    expect(Object.keys(window.localStorage).filter((k) => k.includes('sync.v2'))).toHaveLength(2)
    // …and finished it.
    window.localStorage.removeItem(key)
    storageEvent(key, null)
    expect(projectSync.unsent).toBe(1)
    serve(ok)
    projectSync.retry()
    await projectSync.flush()
    expect(sent()).toEqual([`PUT ${project.id}`])
  })

  it('a project only the other tab holds is left for that tab to send', async () => {
    serve(ok)
    const theirs = { key: 'zzzzzzzzz-00000-other', id: 'project_elsewhere', kind: 'put' }
    window.localStorage.setItem(`reclaim.u.sync-test.reclaim.project.sync.v2.${theirs.key}`, JSON.stringify(theirs))
    projectSync.restore()
    await projectSync.flush()
    expect(calls).toEqual([])
    expect(projectSync.pending).toBe(0)
    expect(window.localStorage.getItem(`reclaim.u.sync-test.reclaim.project.sync.v2.${theirs.key}`)).not.toBeNull()
  })
})

describe('adding audits to the account', () => {
  it('sends one audit per request, and one that is refused does not cost the others', async () => {
    serve((call) => {
      const [project] = (call.body as { projects: Array<{ id: string }> }).projects
      return project.id === 'bad' ? answer(400, { message: 'Malformed project.' }) : answer(200, { imported: [project.id], skipped: [], blocked: [] })
    })
    const result = await projectSync.import([{ id: 'a' }, { id: 'bad' }, { id: 'b' }])
    expect(calls).toHaveLength(3)
    expect(result.imported).toEqual(['a', 'b'])
    // Reported with the blocked ones, so its local copy is kept.
    expect(result.blocked).toEqual(['bad'])
    expect(projectSync.syncIssue!.message).toContain('Malformed project.')
  })

  it('says why when nothing could be added', async () => {
    serve(() => answer(413, { message: 'Too large.' }))
    await expect(projectSync.import([{ id: 'a' }])).rejects.toThrow('Too large.')
  })
})
