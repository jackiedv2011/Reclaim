// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './db.ts'
import { deleteAccount } from './account.ts'
import { revokeMember, setMemberRole, tenantContextFor } from './tenancy.ts'
import { deriveFindings, listImports, listSourceRecords, type LedgerKeys } from './ledger.ts'
import { QuickBooksRateLimitError, QuickBooksReconnectError, QuickBooksUnauthorizedError, type QuickBooksClient } from './quickbooks.ts'
import { MAX_ATTEMPTS, backoffMs, getSyncState, ledgerScanHandler, quickBooksSyncHandler, type LedgerJobHandler, type LedgerJobOutcome, type LedgerJobRequest } from './ledgerSync.ts'

// Synthetic QuickBooks companies only: names, ids and amounts are invented.
const REALM_A = '9341458505092846'
const REALM_B = '4620816365180001'
const DAY = 86_400_000
const T0 = Date.UTC(2026, 9, 1, 12)

type Entities = Record<string, Array<Record<string, unknown>>>
const ledger = (): Entities => ({
  Vendor: [{ Id: '56', DisplayName: 'Acme Supply' }],
  Bill: [{ Id: '101', DocNumber: 'INV-7781', TxnDate: '2026-08-01', TotalAmt: 1250, VendorRef: { value: '56', name: 'Acme Supply' } }],
  BillPayment: [
    { Id: '201', TxnDate: '2026-08-20', TotalAmt: 1250, PayType: 'Check', VendorRef: { name: 'Acme Supply' }, Line: [{ Amount: 1250, LinkedTxn: [{ TxnId: '101', TxnType: 'Bill' }] }] },
    { Id: '202', TxnDate: '2026-08-23', TotalAmt: 1250, PayType: 'Check', VendorRef: { name: 'Acme Supply' }, Line: [{ Amount: 1250, LinkedTxn: [{ TxnId: '101', TxnType: 'Bill' }] }] },
  ],
  VendorCredit: [],
  Deposit: [],
  Purchase: [{ Id: '401', TxnDate: '2026-09-05', TotalAmt: 80, DocNumber: '1', PaymentType: 'CreditCard', EntityRef: { type: 'Vendor', name: 'Acme Supply' } }],
})

/**
 * A stand-in for Intuit's read API. It records every call, and its write-side
 * methods (token exchange, refresh, revoke) fail the test if a handler uses them.
 */
function fakeQuickBooks() {
  const calls: string[] = []
  const state = {
    companies: { [REALM_A]: ledger(), [REALM_B]: ledger() } as Record<string, Entities>,
    cdc: { CDCResponse: [{ QueryResponse: [] }] } as Record<string, unknown>,
    /** Errors thrown by the next calls, in order. */
    failures: [] as Error[],
  }
  const next = () => {
    const err = state.failures.shift()
    if (err) throw err
  }
  const forbidden = (name: string) => () => {
    calls.push(name)
    throw new Error(`${name} must not be called by a sync handler`)
  }
  const client: QuickBooksClient = {
    environment: 'sandbox',
    authorizationUrl: forbidden('authorizationUrl'),
    exchangeCode: forbidden('exchange'),
    refresh: forbidden('refresh'),
    revoke: forbidden('revoke'),
    companyInfo: async (realmId) => {
      calls.push(`companyinfo:${realmId}`)
      next()
      return { CompanyName: 'Sandbox Co' }
    },
    query: async (realmId, _token, statement) => {
      calls.push(`query:${realmId}:${statement}`)
      next()
      const entity = statement.match(/from (\w+)/)![1]
      const ids = statement.match(/where Id in \(([^)]*)\)/)?.[1].replace(/'/g, '').split(',')
      return { QueryResponse: { [entity]: (state.companies[realmId][entity] ?? []).filter((row) => !ids || ids.includes(String(row.Id))) } }
    },
    changes: async (realmId, _token, entities, since) => {
      calls.push(`cdc:${realmId}:${entities.join(',')}:${since.toISOString()}`)
      next()
      return state.cdc
    },
  }
  return { client, calls, state }
}

const addUser = (db: DatabaseSync, id: string) => db.prepare('INSERT INTO users (id, email, company, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}@example.test`, `${id} Co`, 1)

function setup(keys: LedgerKeys = { current: randomBytes(32), previous: null }) {
  const db = openDatabase(':memory:')
  addUser(db, 'alice')
  addUser(db, 'vic')
  const alice = tenantContextFor(db, 'alice')
  const qbo = fakeQuickBooks()
  const tokenCalls: string[] = []
  const tokenState = { failures: [] as Error[] }
  const sync = quickBooksSyncHandler({
    db,
    keys,
    client: qbo.client,
    accessToken: async (tenantId, realmId) => {
      tokenCalls.push(`${tenantId}:${realmId}`)
      const err = tokenState.failures.shift()
      if (err) throw err
      return `access-${realmId}-SECRET`
    },
  })
  const scan = ledgerScanHandler({ db, keys })
  return { db, keys, alice, qbo, sync, scan, tokenCalls, tokenState }
}

const request = (tenantId: string, over: Partial<LedgerJobRequest> = {}): LedgerJobRequest => ({
  tenantId,
  actorUserId: 'alice',
  operation: 'quickbooks.sync',
  idempotencyKey: 'sync-1',
  attempt: 1,
  payload: { realmId: REALM_A },
  ...over,
})

/**
 * Fake runner fixture: the smallest loop that honours the handler contract.
 * It is not a job system; Jagan's shared runner owns scheduling, persistence,
 * leases and jitter. It retries the same request with the next attempt number
 * after the handler's delay, on a simulated clock.
 */
async function runToCompletion(handler: LedgerJobHandler, req: LedgerJobRequest, start: number) {
  let clock = start
  const outcomes: LedgerJobOutcome[] = []
  for (let attempt = req.attempt; ; attempt++) {
    const outcome = await handler.run({ ...req, attempt }, clock)
    outcomes.push(outcome)
    if (outcome.status !== 'retry') return { outcome, outcomes, clock }
    clock += outcome.retryAfterMs
  }
}

const everything = (db: DatabaseSync) => JSON.stringify(
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => db.prepare(`SELECT * FROM "${t.name}"`).all()),
)

describe('quickbooks.sync handler', () => {
  it('stores a full pull as connector-authenticated, realm-scoped records and records the successful sync', async () => {
    const { db, keys, alice, qbo, sync } = setup()
    const outcome = await sync.run(request(alice.tenantId), T0)
    expect(outcome.status).toBe('succeeded')
    if (outcome.status !== 'succeeded') return
    expect(outcome.checkpoint).toMatchObject({ realmId: REALM_A, cursorSince: T0, mode: 'full' })
    expect(outcome.audit).toMatchObject({ outcome: 'succeeded', operation: 'quickbooks.sync', attempt: 1, errorCode: null, counts: { rowsAccepted: 3, newRecords: 3, alreadyImported: 0, removedInSource: 0, duplicatePull: 0 } })

    const records = listSourceRecords(db, keys, alice).records
    expect(records).toHaveLength(3)
    for (const r of records) {
      expect(r.sourceSystem).toBe('quickbooks')
      expect(r.provenance).toBe('connector_authenticated')
      // QuickBooks has no cleared/settled flag: status is never inferred.
      expect(r.status).toBe('unknown')
    }
    expect(records.map((r) => r.amountMinor).sort()).toEqual([125000, 125000, 8000])
    const [summary] = listImports(db, keys, alice)
    expect(summary).toMatchObject({ sourceSystem: 'quickbooks', sourceLabel: 'QuickBooks full pull', connector: { system: 'quickbooks', realmId: REALM_A, mode: 'full', since: null, pulledAt: T0, removedInSource: [] } })
    expect(summary.coverage.reportType).toBe('quickbooks_ledger')
    expect(summary.coverage.freshAsOf).toBe(new Date(T0).toISOString())

    expect(getSyncState(db, alice.tenantId, REALM_A)).toMatchObject({ lastRequestedAt: T0, lastSuccessAt: T0, lastSuccessMode: 'full', cursorSince: T0, lastFailedAt: null, lastErrorCode: null, consecutiveFailures: 0 })
    // Read calls only, and every query is a SELECT.
    expect(qbo.calls.every((c) => c.startsWith('companyinfo:') || c.startsWith(`query:${REALM_A}:select `))).toBe(true)
  })

  it('does not run a completed job again under the same idempotency key', async () => {
    const { db, alice, qbo, sync, tokenCalls } = setup()
    const first = await sync.run(request(alice.tenantId), T0)
    const callsAfterFirst = qbo.calls.length
    const again = await sync.run(request(alice.tenantId, { attempt: 2 }), T0 + 1000)
    expect(again.status).toBe('succeeded')
    expect(again.audit.outcome).toBe('already_completed')
    if (first.status === 'succeeded' && again.status === 'succeeded') expect(again.checkpoint).toEqual(first.checkpoint)
    expect(qbo.calls).toHaveLength(callsAfterFirst)
    expect(tokenCalls).toHaveLength(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger_imports').get()).toEqual({ n: 1 })
  })

  it('stores nothing new when an unchanged ledger is pulled again under a new key', async () => {
    const { db, alice, sync } = setup()
    await sync.run(request(alice.tenantId), T0)
    // 31 days later the change window has passed, so this is another full pull of the same data.
    const later = await sync.run(request(alice.tenantId, { idempotencyKey: 'sync-2' }), T0 + 31 * DAY)
    expect(later.status).toBe('succeeded')
    expect(later.audit.counts).toMatchObject({ duplicatePull: 1, newRecords: 3 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_records').get()).toEqual({ n: 3 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger_imports').get()).toEqual({ n: 1 })
    expect(getSyncState(db, alice.tenantId, REALM_A)).toMatchObject({ lastSuccessAt: T0 + 31 * DAY, cursorSince: T0 + 31 * DAY })
  })

  it('pulls only changes since the last successful sync, flags edits for review and reports deletions without applying them', async () => {
    const { db, keys, alice, qbo, sync } = setup()
    await sync.run(request(alice.tenantId), T0)
    qbo.state.cdc = { CDCResponse: [{ QueryResponse: [
      { BillPayment: [
        // Same payment, amount edited in QuickBooks after it was imported.
        { Id: '202', TxnDate: '2026-08-23', TotalAmt: 1200, PayType: 'Check', VendorRef: { value: '56', name: 'Acme Supply' }, MetaData: { CreateTime: '2026-08-23T10:00:00Z' }, Line: [{ Amount: 1200, LinkedTxn: [{ TxnId: '101', TxnType: 'Bill' }] }] },
        { Id: '201', status: 'Deleted', MetaData: { LastUpdatedTime: '2026-10-01T18:00:00Z' } },
      ] },
      { Purchase: [{ Id: '402', TxnDate: '2026-10-02', TotalAmt: 45, PaymentType: 'Cash', EntityRef: { type: 'Vendor', value: '56', name: 'Acme Supply' }, MetaData: { CreateTime: '2026-10-02T09:00:00Z' } }] },
    ] }] }
    const t1 = T0 + DAY
    const outcome = await sync.run(request(alice.tenantId, { idempotencyKey: 'sync-2' }), t1)
    expect(outcome.status).toBe('succeeded')
    expect(qbo.calls).toContain(`cdc:${REALM_A}:Vendor,Bill,BillPayment,VendorCredit,Deposit,Purchase:${new Date(T0).toISOString()}`)
    expect(outcome.audit.counts).toMatchObject({ rowsAccepted: 2, newRecords: 1, alreadyImported: 1, removedInSource: 1 })

    const imports = listImports(db, keys, alice)
    expect(imports).toHaveLength(2)
    expect(imports[1]).toMatchObject({ sourceLabel: 'QuickBooks changes', connector: { mode: 'changes', since: T0, pulledAt: t1, removedInSource: [{ txnType: 'BillPayment', id: '201' }] } })
    // The deleted payment and the original amount of the edited one are still on record.
    const records = listSourceRecords(db, keys, alice).records
    expect(records).toHaveLength(4)
    expect(records.filter((r) => r.amountMinor === 125000)).toHaveLength(2)
    expect(getSyncState(db, alice.tenantId, REALM_A)).toMatchObject({ lastSuccessAt: t1, lastSuccessMode: 'changes', cursorSince: t1 })
  })

  it('keeps two QuickBooks companies apart even when their transaction ids are identical', async () => {
    const { db, keys, alice, sync } = setup()
    const a = await sync.run(request(alice.tenantId, { idempotencyKey: 'a' }), T0)
    const b = await sync.run(request(alice.tenantId, { idempotencyKey: 'b', payload: { realmId: REALM_B } }), T0)
    expect(a.audit.counts.newRecords).toBe(3)
    expect(b.audit.counts).toMatchObject({ newRecords: 3, alreadyImported: 0, duplicatePull: 0 })
    expect(listSourceRecords(db, keys, alice).records).toHaveLength(6)
    expect(getSyncState(db, alice.tenantId, REALM_A)?.lastSuccessAt).toBe(T0)
    expect(getSyncState(db, alice.tenantId, REALM_B)?.lastSuccessAt).toBe(T0)
  })

  it('asks the runner to back off on rate limits and gives up after the last attempt, keeping the last good sync', async () => {
    const { db, alice, qbo, sync } = setup()
    await sync.run(request(alice.tenantId), T0)
    qbo.state.failures = Array.from({ length: MAX_ATTEMPTS }, () => new QuickBooksRateLimitError('429 for SECRET-realm'))
    const { outcome, outcomes } = await runToCompletion(sync, request(alice.tenantId, { idempotencyKey: 'sync-2' }), T0 + DAY)
    expect(outcomes.map((o) => o.status)).toEqual(['retry', 'retry', 'retry', 'retry', 'failed'])
    expect(outcomes.slice(0, 4).map((o) => (o.status === 'retry' ? o.retryAfterMs : 0))).toEqual([60_000, 120_000, 240_000, 480_000])
    expect(outcome).toMatchObject({ status: 'failed', errorCode: 'retries_exhausted' })
    const state = getSyncState(db, alice.tenantId, REALM_A)!
    expect(state).toMatchObject({ lastSuccessAt: T0, cursorSince: T0, lastErrorCode: 'rate_limited', consecutiveFailures: MAX_ATTEMPTS })
    expect(state.lastRequestedAt).toBeGreaterThan(state.lastSuccessAt!)
    expect(state.lastFailedAt).toBe(state.lastRequestedAt)
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger_job_receipts').get()).toEqual({ n: 1 })
  })

  it('recovers through the fake runner after transient failures and clears the failure count', async () => {
    const { db, alice, qbo, sync } = setup()
    qbo.state.failures = [new QuickBooksRateLimitError('429'), new Error('socket hang up')]
    const { outcome, outcomes, clock } = await runToCompletion(sync, request(alice.tenantId), T0)
    expect(outcomes.map((o) => [o.status, o.status === 'retry' ? o.errorCode : null])).toEqual([['retry', 'rate_limited'], ['retry', 'provider_error'], ['succeeded', null]])
    expect(outcome.status).toBe('succeeded')
    expect(getSyncState(db, alice.tenantId, REALM_A)).toMatchObject({ lastSuccessAt: clock, consecutiveFailures: 0, lastErrorCode: null, lastFailedAt: T0 + 60_000 })
  })

  it('fails without retrying when the connection must be made again, and retries a rejected access token', async () => {
    const { db, alice, qbo, sync, tokenState } = setup()
    tokenState.failures = [new QuickBooksReconnectError('refresh refused: refresh-SECRET')]
    const gone = await sync.run(request(alice.tenantId), T0)
    expect(gone).toMatchObject({ status: 'failed', errorCode: 'reconnect_required' })
    expect(qbo.calls).toEqual([])
    expect(getSyncState(db, alice.tenantId, REALM_A)).toMatchObject({ lastSuccessAt: null, lastRequestedAt: T0, lastFailedAt: T0, lastErrorCode: 'reconnect_required' })

    qbo.state.failures = [new QuickBooksUnauthorizedError('401')]
    const rejected = await sync.run(request(alice.tenantId, { idempotencyKey: 'sync-2' }), T0 + 1)
    expect(rejected).toMatchObject({ status: 'retry', errorCode: 'token_rejected', retryAfterMs: backoffMs(1) })
  })

  it('never writes tokens or provider messages to the database, outcomes or audit events', async () => {
    for (const keys of [{ current: randomBytes(32), previous: null }, null] as LedgerKeys[]) {
      const { db, alice, qbo, sync, scan, tokenState } = setup(keys)
      const outcomes: LedgerJobOutcome[] = []
      outcomes.push(await sync.run(request(alice.tenantId), T0))
      qbo.state.failures = [new Error('upstream said access-SECRET was bad')]
      outcomes.push(await sync.run(request(alice.tenantId, { idempotencyKey: 'sync-2' }), T0 + 1))
      tokenState.failures = [new QuickBooksReconnectError('refresh-SECRET refused')]
      outcomes.push(await sync.run(request(alice.tenantId, { idempotencyKey: 'sync-3' }), T0 + 2))
      outcomes.push(await scan.run(request(alice.tenantId, { operation: 'ledger.scan', idempotencyKey: 'scan-1', payload: {} }), T0 + 3))
      expect(everything(db)).not.toMatch(/SECRET/)
      expect(JSON.stringify(outcomes)).not.toMatch(/SECRET|Acme|INV-7781|1250/)
    }
  })

  it('re-checks the actor on every attempt: viewers, revoked members and outsiders cannot sync', async () => {
    const { db, alice, qbo, sync, tokenCalls } = setup()
    setMemberRole(db, alice, 'vic', 'viewer')
    expect(await sync.run(request(alice.tenantId, { actorUserId: 'vic' }), T0)).toMatchObject({ status: 'failed', errorCode: 'permission_denied' })
    setMemberRole(db, alice, 'vic', 'member')
    expect((await sync.run(request(alice.tenantId, { actorUserId: 'vic' }), T0)).status).toBe('succeeded')
    revokeMember(db, alice, 'vic')
    expect(await sync.run(request(alice.tenantId, { actorUserId: 'vic', idempotencyKey: 'sync-2' }), T0)).toMatchObject({ status: 'failed', errorCode: 'permission_denied' })
    addUser(db, 'mallory')
    expect(await sync.run(request(alice.tenantId, { actorUserId: 'mallory', idempotencyKey: 'sync-3' }), T0)).toMatchObject({ status: 'failed', errorCode: 'permission_denied' })
    expect(tokenCalls).toHaveLength(1)
    expect(qbo.calls.filter((c) => c.startsWith('companyinfo:'))).toHaveLength(1)
  })

  it('rejects malformed requests before touching the provider', async () => {
    const { alice, qbo, sync } = setup()
    const bad: Array<Partial<LedgerJobRequest>> = [
      { payload: {} },
      { payload: { realmId: '../../etc' } },
      { payload: { realmId: 42 } },
      { idempotencyKey: '' },
      { idempotencyKey: 'has spaces' },
      { attempt: 0 },
      { operation: 'ledger.scan' },
    ]
    for (const over of bad) expect(await sync.run(request(alice.tenantId, over), T0)).toMatchObject({ status: 'failed', errorCode: 'invalid_request' })
    expect(qbo.calls).toEqual([])
  })

  it('removes sync state and receipts with the organisation', async () => {
    const { db, alice, sync } = setup()
    await sync.run(request(alice.tenantId), T0)
    deleteAccount(db, { id: 'alice', email: 'alice@example.test' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger_sync_state').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger_job_receipts').get()).toEqual({ n: 0 })
  })
})

describe('ledger.scan handler', () => {
  it('reports per-rule counts that match the server engine and writes nothing but its receipt', async () => {
    const { db, keys, alice, sync, scan } = setup()
    await sync.run(request(alice.tenantId), T0)
    const ledgerBefore = JSON.stringify([db.prepare('SELECT * FROM source_records').all(), db.prepare('SELECT * FROM ledger_imports').all(), db.prepare('SELECT * FROM ledger_sync_state').all()])
    const outcome = await scan.run(request(alice.tenantId, { operation: 'ledger.scan', idempotencyKey: 'scan-1', payload: {} }), T0 + 1)
    expect(outcome.status).toBe('succeeded')
    const { findings } = deriveFindings(db, keys, alice)
    const byRule: Record<string, number> = {}
    for (const f of findings) byRule[`rule:${f.type}`] = (byRule[`rule:${f.type}`] ?? 0) + 1
    expect(outcome.audit.counts).toEqual({ sourceRecords: 3, findings: findings.length, ...byRule })
    // Two checks of the same amount against bill INV-7781 three days apart.
    expect(findings.length).toBeGreaterThan(0)
    if (outcome.status === 'succeeded') expect(outcome.checkpoint).toEqual({ throughSeq: 3, findings: findings.length })
    expect(JSON.stringify([db.prepare('SELECT * FROM source_records').all(), db.prepare('SELECT * FROM ledger_imports').all(), db.prepare('SELECT * FROM ledger_sync_state').all()])).toBe(ledgerBefore)
    expect(db.prepare("SELECT COUNT(*) AS n FROM ledger_job_receipts WHERE operation = 'ledger.scan'").get()).toEqual({ n: 1 })
  })

  it('lets a viewer scan but not an outsider', async () => {
    const { db, alice, scan } = setup()
    setMemberRole(db, alice, 'vic', 'viewer')
    const req = request(alice.tenantId, { operation: 'ledger.scan', idempotencyKey: 'scan-1', payload: {}, actorUserId: 'vic' })
    expect((await scan.run(req, T0)).status).toBe('succeeded')
    addUser(db, 'mallory')
    expect(await scan.run({ ...req, actorUserId: 'mallory', idempotencyKey: 'scan-2' }, T0)).toMatchObject({ status: 'failed', errorCode: 'permission_denied' })
  })
})
