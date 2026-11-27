// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './db.ts'
import { deleteAccount } from './account.ts'
import { setMemberRole, tenantContextFor, TenantAccessError } from './tenancy.ts'
import { createApp, type App } from './app.ts'
import { loadConfig } from './config.ts'
import { DevMailer } from './mailer.ts'
import { LedgerError, confirmImportMapping, deriveFindings, proposeImportMapping, getSourceRecords, importCsv, importQuickBooksPull, listImports, listSourceRecords, resealLedger, vendorPeriodAggregates, type LedgerKeys } from './ledger.ts'
import { parseCsv } from '../src/lib/csv.ts'
import { formatSignature, headerKey } from '../src/ingestion/columnMapping.ts'
import type { ParseResult } from '../src/types.ts'

// The browser ledger store touches `window` and is outside the server
// TypeScript program, so it is loaded at run time with a minimal local type.
interface BrowserStore {
  inspectImport(env: unknown, input: { sourceLabel: string; mode: 'upload'; parsed: ParseResult }): { duplicateFile: boolean; rowResults: { rowNumber: number; status: string }[] }
  mergeImport(env: unknown, input: { sourceLabel: string; mode: 'upload'; parsed: ParseResult }): { result: { findings: { type: string; dollarImpact: number }[] } }
}
const BROWSER_STORE: string = '../src/ledger/store.ts'

// Synthetic fixtures only. Supplier names, references and IDs are invented.
const HEAD = 'vendor,invoice_number,invoice_date,payment_date,amount_paid,currency,external_transaction_id,transaction_type'
const FILE_A = [
  HEAD,
  'Acme Supplies,INV-1001,2026-01-05,2026-01-10,1250.00,USD,TXN-A1,Bill Payment',
  'Acme Supplies,INV-1001,2026-01-05,2026-01-12,1250.00,USD,TXN-A2,Bill Payment',
  'Beta Logistics,INV-2001,2026-01-15,2026-01-20,500.00,USD,TXN-B1,Bill Payment',
  'Gamma Parts,CR-3001,,2026-02-03,-200.00,USD,TXN-G1,Refund',
  'Delta GmbH,INV-4001,2026-02-01,2026-02-05,300.00,EUR,TXN-D1,Bill Payment',
  'Delta GmbH,INV-4002,2026-02-01,2026-02-06,100.00,,TXN-D2,Bill Payment',
  'Epsilon Co,INV-5001,2026-02-01,2026-02-07,700.00,USD,TXN-E1,Void',
].join('\n')
// A later export that overlaps file A (two rows repeat) and adds one new payment.
const FILE_B = [
  HEAD,
  'Acme Supplies,INV-1001,2026-01-05,2026-01-12,1250.00,USD,TXN-A2,Bill Payment',
  'Beta Logistics,INV-2001,2026-01-15,2026-01-20,500.00,USD,TXN-B1,Bill Payment',
  'Zeta Freight,INV-6001,2026-02-10,2026-02-14,90.00,USD,TXN-Z1,Bill Payment',
].join('\n')

const addUser = (db: DatabaseSync, id: string) => db.prepare('INSERT INTO users (id, email, company, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}@example.test`, `${id} Co`, 1)
const key = () => randomBytes(32)
const keyed = (current = key(), previous: Buffer | null = null): LedgerKeys => ({ current, previous })

function setup(keys: LedgerKeys = null) {
  const db = openDatabase(':memory:')
  addUser(db, 'alice')
  addUser(db, 'bob')
  return { db, keys, alice: tenantContextFor(db, 'alice'), bob: tenantContextFor(db, 'bob') }
}

const errorCode = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    if (err instanceof TenantAccessError || err instanceof LedgerError) return `${err.status} ${err.code}`
    throw err
  }
  return 'ok'
}

const dumpTables = (db: DatabaseSync) => JSON.stringify([db.prepare('SELECT * FROM source_records').all(), db.prepare('SELECT * FROM ledger_imports').all()])

describe('server ledger import', () => {
  it('stores every accepted row once with its source identity, provenance and minor units', () => {
    const { db, keys, alice } = setup()
    const result = importCsv(db, keys, alice, { csv: FILE_A, sourceLabel: 'jan-feb.csv' })
    expect(result.duplicateFile).toBe(false)
    expect(result.coverage.rows).toEqual({ total: 7, accepted: 7, rejected: 0 })
    expect(result.coverage.dedup).toEqual({ newRecords: 7, alreadyImported: 0, repeatedWithinImport: 0 })
    const { records, nextCursor } = listSourceRecords(db, keys, alice)
    expect(nextCursor).toBeNull()
    expect(records).toHaveLength(7)
    const acme = records[0]
    expect(acme).toMatchObject({ tenantId: alice.tenantId, sourceSystem: 'csv_upload', provenance: 'customer_uploaded', importId: result.importId, sourceNativeId: 'TXN-A1', kind: 'payment', status: 'unknown', vendorName: 'Acme Supplies', referenceRaw: 'INV-1001', currency: 'USD', amountMinor: 125000, invoiceAmountMinor: null, invoiceDate: '2026-01-05', paymentDate: '2026-01-10', normalizationVersion: 1 })
    expect(acme.unknownFields).toContain('invoice_amount')
    // A CSV upload never claims settlement; voids and refunds are classified, missing currency stays unknown.
    expect(records.find((r) => r.sourceNativeId === 'TXN-G1')).toMatchObject({ kind: 'refund', amountMinor: -20000 })
    expect(records.find((r) => r.sourceNativeId === 'TXN-E1')).toMatchObject({ status: 'voided' })
    expect(records.find((r) => r.sourceNativeId === 'TXN-D2')).toMatchObject({ currency: null })
    expect(records.find((r) => r.sourceNativeId === 'TXN-D2')?.unknownFields).toContain('currency')
    // Raw cells never come back in an import receipt.
    expect(result.rowResults.every((r) => !('raw' in r))).toBe(true)
  })

  it('returns the earlier import, unchanged, when the same file is sent again (retry-safe)', () => {
    const { db, keys, alice } = setup()
    const first = importCsv(db, keys, alice, { csv: FILE_A })
    const before = deriveFindings(db, keys, alice)
    const again = importCsv(db, keys, alice, { csv: FILE_A })
    expect(again).toMatchObject({ importId: first.importId, duplicateFile: true })
    expect(listImports(db, keys, alice)).toHaveLength(1)
    expect(listSourceRecords(db, keys, alice).records).toHaveLength(7)
    expect(deriveFindings(db, keys, alice)).toEqual(before)
  })

  it('never turns an overlapping export into a second payment or a new finding', () => {
    const { db, keys, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const before = deriveFindings(db, keys, alice)
    const overlap = importCsv(db, keys, alice, { csv: FILE_B })
    expect(overlap.coverage.dedup).toEqual({ newRecords: 1, alreadyImported: 2, repeatedWithinImport: 0 })
    expect(overlap.rowResults.map((r) => r.status)).toEqual(['exact_duplicate', 'exact_duplicate', 'newly_imported'])
    expect(overlap.rowResults[0].existingRecordId).toBe(listSourceRecords(db, keys, alice).records[1].id)
    expect(listSourceRecords(db, keys, alice).records).toHaveLength(8)
    const after = deriveFindings(db, keys, alice)
    expect(after.findings.map((f) => f.id)).toEqual(before.findings.map((f) => f.id))
  })

  it('treats the same payment from a CSV and a QuickBooks pull as one record, in either order, with no duplicate finding', () => {
    const csvFile = 'vendor,invoice_number,invoice_date,payment_date,invoice_amount,amount_paid,currency\nAcme Supply,INV-90211,01/02/2026,01/20/2026,4500.00,4500.00,USD\nAcme Supply,INV-90212,01/02/2026,01/20/2026,4500.00,4500.00,USD\n'
    const qboFile = 'vendor,invoice_number,invoice_date,invoice_amount,payment_date,amount_paid,currency,transaction_id,source_account,transaction_type\n'
      + 'Acme Supply,INV-90211,2026-01-02,4500.00,2026-01-20,4500.00,USD,qbo:BillPayment:77,Checking,BillPayment\n'
      + 'Acme Supply,INV-90212,2026-01-02,4500.00,2026-02-20,4500.00,USD,qbo:BillPayment:78,Checking,BillPayment\n'
    for (const order of ['csv-first', 'qbo-first'] as const) {
      const { db, keys, alice } = setup(keyed())
      const csv = () => importCsv(db, keys, alice, { csv: csvFile })
      const qbo = () => importQuickBooksPull(db, keys, alice, { realmId: '123', csv: qboFile, facts: { schemaVersion: 1, companyName: 'Synthetic Co', pulledAt: 1, payments: {}, vendors: {}, searched: { vendorCredits: 0, deposits: 0, purchases: 0, billPayments: 2 } } })
      if (order === 'csv-first') csv()
      else qbo()
      const second = order === 'csv-first' ? qbo() : csv()
      // INV-90211 on 20 Jan is the same payment in both sources. INV-90212 paid on 20 Jan (CSV) and again on 20 Feb (QuickBooks) is two payments.
      expect(second?.coverage.dedup).toEqual({ newRecords: 1, alreadyImported: 1, repeatedWithinImport: 0 })
      const overlap = second?.rowResults.find((r) => r.status === 'possible_overlap')
      expect(overlap?.existingRecordId).toBeDefined()
      expect(listSourceRecords(db, keys, alice).records).toHaveLength(3)
      const { findings } = deriveFindings(db, keys, alice)
      // The shared payment makes no claim; the genuine second payment of INV-90212 still does.
      expect(findings.filter((f) => f.type === 'exact_duplicate').map((f) => [f.title, f.sourceRecordIds.length])).toEqual([['Duplicate payment of invoice INV-90212', 2]])
    }
  })

  it('collapses a row repeated inside one file and reports a changed row under an existing identity as an overlap', () => {
    const { db, keys, alice } = setup()
    const repeated = [HEAD, 'Acme Supplies,INV-1001,2026-01-05,2026-01-10,1250.00,USD,TXN-A1,Bill Payment', 'Acme Supplies,INV-1001,2026-01-05,2026-01-10,1250.00,USD,TXN-A1,Bill Payment'].join('\n')
    const first = importCsv(db, keys, alice, { csv: repeated })
    expect(first.coverage.dedup).toEqual({ newRecords: 1, alreadyImported: 0, repeatedWithinImport: 1 })
    // Same external ID, different amount: a conflicting source update, held for review, not stored as another payment.
    const conflicting = [HEAD, 'Acme Supplies,INV-1001,2026-01-05,2026-01-10,1300.00,USD,TXN-A1,Bill Payment'].join('\n')
    const second = importCsv(db, keys, alice, { csv: conflicting })
    expect(second.rowResults.map((r) => r.status)).toEqual(['possible_overlap'])
    expect(listSourceRecords(db, keys, alice).records.map((r) => r.amountMinor)).toEqual([125000])
  })

  it('agrees with the browser ledger row for row and finding for finding (inspectImport / mergeImport parity)', async () => {
    const { inspectImport, mergeImport } = (await import(BROWSER_STORE)) as BrowserStore
    const { db, keys, alice } = setup()
    let env: ReturnType<BrowserStore['mergeImport']> | null = null
    for (const csv of [FILE_A, FILE_B, FILE_A]) {
      const parsed = parseCsv(csv)
      const browser = inspectImport(env, { sourceLabel: 'f.csv', mode: 'upload', parsed })
      const server = importCsv(db, keys, alice, { csv })
      expect(server.duplicateFile).toBe(browser.duplicateFile)
      if (!browser.duplicateFile) expect(server.rowResults.map((r) => [r.rowNumber, r.status])).toEqual(browser.rowResults.map((r) => [r.rowNumber, r.status]))
      env = mergeImport(env, { sourceLabel: 'f.csv', mode: 'upload', parsed })
    }
    const serverFindings = deriveFindings(db, keys, alice).findings
    const shape = (f: { type: string; dollarImpact: number }) => `${f.type}:${f.dollarImpact}`
    expect(serverFindings.map(shape).sort()).toEqual(env!.result.findings.map(shape).sort())
    expect(serverFindings.length).toBeGreaterThan(0)
  })

  it('rejects malformed input without storing anything', () => {
    const { db, keys, alice } = setup()
    expect(errorCode(() => importCsv(db, keys, alice, { csv: '' }))).toBe('400 csv_required')
    expect(errorCode(() => importCsv(db, keys, alice, { csv: 42 as unknown as string }))).toBe('400 csv_required')
    expect(errorCode(() => importCsv(db, keys, alice, { csv: 'x'.repeat(20 * 1024 * 1024 + 1) }))).toBe('413 csv_too_large')
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger_imports').get()).toEqual({ n: 0 })
  })

  it('treats spreadsheet formulas and markup in cells as inert text', () => {
    const { db, keys, alice } = setup()
    const hostile = [HEAD, '"=HYPERLINK(""http://x.test"")",<script>alert(1)</script>,2026-01-01,2026-01-02,10.00,USD,TXN-H1,Bill Payment'].join('\n')
    importCsv(db, keys, alice, { csv: hostile, sourceLabel: 'evil\u0000\u001b[31m.csv' })
    const [rec] = listSourceRecords(db, keys, alice).records
    expect(rec.vendorName).toBe('=HYPERLINK("http://x.test")')
    expect(rec.referenceRaw).toBe('<script>alert(1)</script>')
    expect(listImports(db, keys, alice)[0].sourceLabel).toBe('evil[31m.csv')
  })
})

// An accounting export with headers the parser does not know.
const ODD_HEAD = ['Merchant', 'Doc No', 'Paid On', 'Paid Amt', 'Curr', 'Txn Ref']
const ODD_FILE = [ODD_HEAD.join(','), 'Acme Supplies,INV-1001,2026-01-10,1250.00,USD,TXN-A1', 'Acme Supplies,INV-1001,2026-01-12,1250.00,USD,TXN-A2'].join('\n')
const ODD_ASSIGN: Record<string, string> = { Merchant: 'vendor', 'Doc No': 'invoice_number', 'Paid On': 'payment_date', 'Paid Amt': 'amount_paid', Curr: 'currency', 'Txn Ref': 'transaction_id' }
const oddMapping = () => ({
  signature: formatSignature(ODD_HEAD),
  mapping: { signature: formatSignature(ODD_HEAD), formatId: null, columns: ODD_HEAD.map((h) => ({ key: headerKey(h), header: h, canonical: ODD_ASSIGN[h] })), locale: { dateOrder: 'month_first', decimal: 'dot' } },
})

describe('column mappings on the server import', () => {
  it('refuses an unfamiliar layout until a person confirms the mapping, then reads it through that version', () => {
    const { db, keys, alice } = setup()
    expect(errorCode(() => importCsv(db, keys, alice, { csv: ODD_FILE }))).toBe('409 mapping_unconfirmed')
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger_imports').get()).toEqual({ n: 0 })
    const proposal = proposeImportMapping(db, alice, ODD_FILE)
    expect(proposal.status).toBe('pending_confirmation')
    expect(JSON.stringify(proposal)).not.toContain('TXN-A1')
    const stored = confirmImportMapping(db, alice, oddMapping(), 5)
    expect(stored).toMatchObject({ version: 1, confirmedBy: 'alice' })
    const result = importCsv(db, keys, alice, { csv: ODD_FILE })
    expect(result.coverage.mapping).toMatchObject({ status: 'confirmed', version: 1, mappingId: stored.mappingId })
    expect(listSourceRecords(db, keys, alice).records.map((r) => [r.vendorName, r.sourceNativeId, r.amountMinor])).toEqual([['Acme Supplies', 'TXN-A1', 125000], ['Acme Supplies', 'TXN-A2', 125000]])
    expect(deriveFindings(db, keys, alice).findings.length).toBeGreaterThan(0)
    // Another tenant's confirmation does not carry over.
    const { bob } = { bob: tenantContextFor(db, 'bob') }
    expect(errorCode(() => importCsv(db, keys, bob, { csv: ODD_FILE }))).toBe('409 mapping_unconfirmed')
  })

  it('reports a built-in format as known_format and refuses day-first dates the parser would misread', () => {
    const { db, keys, alice } = setup()
    expect(importCsv(db, keys, alice, { csv: FILE_A }).coverage.mapping).toEqual({ status: 'known_format', mappingId: null, version: null, pendingFields: [] })
    const dayFirst = [HEAD, 'Acme Supplies,INV-9,25/01/2026,28/01/2026,10.00,USD,TXN-X1,Bill Payment'].join('\n')
    expect(errorCode(() => importCsv(db, keys, alice, { csv: dayFirst }))).toBe('409 mapping_conflict')
  })

  it('validates a confirmation strictly and keeps viewers out', () => {
    const { db, alice } = setup()
    addUser(db, 'vic')
    setMemberRole(db, alice, 'vic', 'viewer')
    const viewer = tenantContextFor(db, 'vic', alice.tenantId)
    expect(errorCode(() => confirmImportMapping(db, viewer, oddMapping()))).toBe('403 permission_denied')
    expect(errorCode(() => confirmImportMapping(db, alice, { signature: 'x', mapping: { columns: 'nope' } }))).toBe('400 invalid_mapping')
    expect(errorCode(() => confirmImportMapping(db, alice, null))).toBe('400 invalid_mapping')
    const collide = oddMapping()
    collide.mapping.columns[1].canonical = 'vendor'
    expect(errorCode(() => confirmImportMapping(db, alice, collide))).toBe('409 mapping_conflict')
  })
})

describe('tenant isolation', () => {
  it('scopes every read to the caller’s organisation, and hides other tenants’ IDs as missing', () => {
    const { db, keys, alice, bob } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    importCsv(db, keys, bob, { csv: FILE_B })
    const aliceIds = listSourceRecords(db, keys, alice).records.map((r) => r.id)
    expect(listSourceRecords(db, keys, bob).records).toHaveLength(3)
    expect(getSourceRecords(db, keys, bob, aliceIds)).toEqual({ records: [], missing: aliceIds })
    expect(deriveFindings(db, keys, bob).findings.every((f) => f.tenantId === bob.tenantId)).toBe(true)
    expect(errorCode(() => tenantContextFor(db, 'bob', alice.tenantId))).toBe('404 tenant_not_found')
    // The same file in two tenants is two independent imports.
    expect(importCsv(db, keys, bob, { csv: FILE_A }).duplicateFile).toBe(false)
  })

  it('lets a viewer read but not import, and a member import', () => {
    const { db, keys, alice } = setup()
    addUser(db, 'vic')
    addUser(db, 'mia')
    setMemberRole(db, alice, 'vic', 'viewer')
    setMemberRole(db, alice, 'mia', 'member')
    const viewer = tenantContextFor(db, 'vic', alice.tenantId)
    const member = tenantContextFor(db, 'mia', alice.tenantId)
    expect(errorCode(() => importCsv(db, keys, viewer, { csv: FILE_A }))).toBe('403 permission_denied')
    expect(errorCode(() => importCsv(db, keys, member, { csv: FILE_A }))).toBe('ok')
    expect(listSourceRecords(db, keys, viewer).records).toHaveLength(7)
  })

  it('cannot open a sealed row that was moved to another tenant', () => {
    const { db, alice, bob } = setup()
    const keys = keyed()
    importCsv(db, keys, alice, { csv: FILE_A })
    const id = listSourceRecords(db, keys, alice).records[0].id
    db.prepare('UPDATE source_records SET tenant_id = ?, seq = 1000 WHERE id = ?').run(bob.tenantId, id)
    expect(() => getSourceRecords(db, keys, bob, [id])).toThrow()
  })

  it('deletes a personal organisation’s ledger with the account, and keeps rows a deleted member imported elsewhere', () => {
    const { db, keys, alice, bob } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    setMemberRole(db, bob, 'alice', 'member')
    importCsv(db, keys, tenantContextFor(db, 'alice', bob.tenantId), { csv: FILE_B })
    deleteAccount(db, { id: 'alice', email: 'alice@example.test' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_records WHERE tenant_id = ?').get(alice.tenantId)).toEqual({ n: 0 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM ledger_imports WHERE tenant_id = ?').get(alice.tenantId)).toEqual({ n: 0 })
    expect(listSourceRecords(db, keys, bob).records).toHaveLength(3)
    expect(db.prepare('SELECT actor_user_id FROM ledger_imports WHERE tenant_id = ?').all(bob.tenantId)).toEqual([{ actor_user_id: null }])
  })
})

describe('at-rest protection', () => {
  it('keeps supplier names, references and source IDs out of the database in plain text', () => {
    const { db, alice } = setup()
    const keys = keyed()
    importCsv(db, keys, alice, { csv: FILE_A, sourceLabel: 'acme-export.csv' })
    const dump = dumpTables(db)
    for (const secret of ['Acme Supplies', 'INV-1001', 'TXN-A1', 'acme-export', 'Beta Logistics']) expect(dump).not.toContain(secret)
    expect(listSourceRecords(db, keys, alice).records[0].vendorName).toBe('Acme Supplies')
  })

  it('seals a plain dev ledger once a key exists, and survives key rotation with dedup intact', () => {
    const { db, alice } = setup()
    importCsv(db, null, alice, { csv: FILE_A })
    expect(dumpTables(db)).toContain('Acme Supplies')
    const k1 = key()
    expect(resealLedger(db, keyed(k1))).toBe(8)
    expect(dumpTables(db)).not.toContain('Acme Supplies')
    expect(resealLedger(db, keyed(k1))).toBe(0)

    const k2 = key()
    const rotating = keyed(k2, k1)
    // Before the startup re-seal, reads fall back to the previous key.
    expect(listSourceRecords(db, rotating, alice).records).toHaveLength(7)
    expect(resealLedger(db, rotating)).toBe(8)
    // While DATA_KEY_PREVIOUS stays configured, later boots find nothing left to re-seal.
    expect(resealLedger(db, rotating)).toBe(0)
    const rotated = keyed(k2)
    expect(listSourceRecords(db, rotated, alice).records).toHaveLength(7)
    expect(importCsv(db, rotated, alice, { csv: FILE_A }).duplicateFile).toBe(true)
    expect(importCsv(db, rotated, alice, { csv: FILE_B }).coverage.dedup).toEqual({ newRecords: 1, alreadyImported: 2, repeatedWithinImport: 0 })
    expect(() => listSourceRecords(db, keyed(k1), alice)).toThrow()
  })

  it('still recognises a repeated QuickBooks pull after key rotation (the realm scope survives the re-seal)', () => {
    const { db, alice } = setup()
    const k1 = key()
    const pull = { realmId: '123', csv: 'vendor,invoice_number,invoice_date,invoice_amount,payment_date,amount_paid,currency,transaction_id\nAcme Supply,INV-90211,2026-01-02,4500.00,2026-01-20,4500.00,USD,qbo:BillPayment:77\n',
      facts: { schemaVersion: 1, companyName: 'Synthetic Co', pulledAt: 1, payments: {}, vendors: {}, searched: { vendorCredits: 0, deposits: 0, purchases: 0, billPayments: 1 } } } as const
    expect(importQuickBooksPull(db, keyed(k1), alice, pull)?.duplicateFile).toBe(false)
    const k2 = key()
    expect(resealLedger(db, keyed(k2, k1))).toBe(2)
    const after = importQuickBooksPull(db, keyed(k2), alice, pull)
    expect(after?.duplicateFile).toBe(true)
    expect(listImports(db, keyed(k2), alice)).toHaveLength(1)
  })
})

describe('scoped reads for analytics and evidence', () => {
  it('pages in import order with a stable cursor and filters by date and currency', () => {
    const { db, keys, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const first = listSourceRecords(db, keys, alice, { limit: 3 })
    const second = listSourceRecords(db, keys, alice, { limit: 3, cursor: first.nextCursor })
    const third = listSourceRecords(db, keys, alice, { limit: 3, cursor: second.nextCursor })
    expect([...first.records, ...second.records, ...third.records].map((r) => r.sourceNativeId)).toEqual(['TXN-A1', 'TXN-A2', 'TXN-B1', 'TXN-G1', 'TXN-D1', 'TXN-D2', 'TXN-E1'])
    expect(third.nextCursor).toBeNull()
    expect(listSourceRecords(db, keys, alice, { from: '2026-02-01', currency: 'eur' }).records.map((r) => r.sourceNativeId)).toEqual(['TXN-D1'])
    expect(errorCode(() => listSourceRecords(db, keys, alice, { from: '02/01/2026' }))).toBe('400 invalid_query')
    expect(errorCode(() => listSourceRecords(db, keys, alice, { currency: "USD' OR 1=1" }))).toBe('400 invalid_query')
    expect(errorCode(() => listSourceRecords(db, keys, alice, { cursor: '-5' }))).toBe('400 invalid_query')
  })

  it('aggregates payments per vendor, month and currency without mixing currencies, netting refunds or counting voids', () => {
    const { db, keys, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const { definition, rows } = vendorPeriodAggregates(db, keys, alice)
    expect(definition).toBe('reported_supplier_payments_v1')
    const view = rows.map((r) => [r.vendorName, r.period, r.currency, r.paymentCount, r.paymentsMinor, r.refundCount, r.refundsMinor])
    expect(view).toEqual(expect.arrayContaining([
      ['Acme Supplies', '2026-01', 'USD', 2, 250000, 0, 0],
      ['Beta Logistics', '2026-01', 'USD', 1, 50000, 0, 0],
      ['Gamma Parts', '2026-02', 'USD', 0, 0, 1, 20000],
      ['Delta GmbH', '2026-02', 'EUR', 1, 30000, 0, 0],
      ['Delta GmbH', '2026-02', null, 1, 10000, 0, 0],
    ]))
    expect(rows.some((r) => r.vendorName === 'Epsilon Co')).toBe(false)
    expect(rows).toHaveLength(5)
  })

  it('derives findings that cite source record IDs instead of embedding rows', () => {
    const { db, keys, alice } = setup()
    importCsv(db, keys, alice, { csv: FILE_A })
    const result = deriveFindings(db, keys, alice)
    expect(result).toMatchObject({ algorithmVersion: 'server-ledger/1.0.0', contractVersion: '0.1.0', recordCount: 7 })
    const ids = new Set(listSourceRecords(db, keys, alice).records.map((r) => r.id))
    for (const f of result.findings) {
      expect(f).not.toHaveProperty('relatedRecords')
      expect(f).not.toHaveProperty('sourceValues')
      expect(f.sourceRecordIds.every((id) => ids.has(id))).toBe(true)
    }
    expect(result.findings.some((f) => f.sourceRecordIds.length === 2)).toBe(true)
  })
})

describe('HTTP routes', () => {
  let app: App | null = null
  afterEach(async () => {
    if (app) {
      await app.close()
      app.db.close()
      app = null
    }
  })

  async function start(flag: boolean) {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', APP_ORIGIN: 'http://localhost:0', SESSION_DAYS: '1', REMEMBER_ME_DAYS: '30', RECLAIM_SERVER_LEDGER: flag ? 'true' : 'false' })
    const db = openDatabase(':memory:')
    app = createApp({ config, db, mailer: new DevMailer(db), google: null, drafts: null, quickbooks: null })
    const base = `http://127.0.0.1:${await app.listen(0)}`
    let cookie = ''
    const call = async (path: string, init: { method?: string; json?: unknown } = {}) => {
      const headers: Record<string, string> = {}
      if (init.json !== undefined) headers['Content-Type'] = 'application/json'
      if (cookie) headers.Cookie = cookie
      const res = await fetch(base + path, { method: init.method ?? 'GET', headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined, redirect: 'manual' })
      for (const line of res.headers.getSetCookie()) if (!/Max-Age=0/.test(line)) cookie = line.split(';')[0]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are asserted field by field
      const body: any = await res.json().catch(() => null)
      return { status: res.status, body }
    }
    const signIn = async (email: string) => {
      const signup = await call('/api/auth/signup', { method: 'POST', json: { firstName: 'Test', lastName: 'User', email, company: 'Test Co', password: 'correct-horse-battery', confirmPassword: 'correct-horse-battery', acceptedTerms: true, termsVersion: '2026-01' } })
      expect(signup.status).toBe(201)
      const mail = await call(`/api/dev/mailbox?to=${encodeURIComponent(email)}`)
      const token = new URL(mail.body.messages[0].link).searchParams.get('token')
      expect((await call('/api/auth/verify-email', { method: 'POST', json: { token } })).status).toBe(200)
    }
    return { call, signIn, signOut: () => (cookie = '') }
  }

  it('is invisible while the flag is off', async () => {
    const { call, signIn } = await start(false)
    await signIn('flag-off@example.test')
    expect((await call('/api/ledger/records')).status).toBe(404)
    expect((await call('/api/ledger/imports', { method: 'POST', json: { csv: FILE_A } })).status).toBe(404)
  })

  it('imports a file, ignores client-sent records and findings, and serves scoped reads', async () => {
    const { call, signIn, signOut } = await start(true)
    expect((await call('/api/ledger/records')).status).toBe(401)
    await signIn('ledger@example.test')
    const created = await call('/api/ledger/imports', { method: 'POST', json: { csv: FILE_A, sourceLabel: 'a.csv', records: [{ vendor: 'Forged', amountPaid: 999999 }], findings: [{ amountAtRisk: 1e9 }] } })
    expect(created.status).toBe(201)
    expect(created.body.coverage.rows.accepted).toBe(7)
    expect((await call('/api/ledger/imports', { method: 'POST', json: { csv: FILE_A } })).body).toMatchObject({ duplicateFile: true, importId: created.body.importId })
    expect((await call('/api/ledger/imports', { method: 'POST', json: { csv: ['not', 'text'] } })).status).toBe(400)

    const records = await call('/api/ledger/records?limit=2')
    expect(records.body.records).toHaveLength(2)
    expect(records.body.records.some((r: { vendorName: string }) => r.vendorName === 'Forged')).toBe(false)
    const byId = await call(`/api/ledger/records?ids=${records.body.records[0].id},nope`)
    expect(byId.body).toMatchObject({ missing: ['nope'] })
    const findings = await call('/api/ledger/findings')
    expect(findings.body.findings.length > 0 && findings.body.findings.every((f: { dollarImpact: number }) => f.dollarImpact < 1e9)).toBe(true)
    expect((await call('/api/ledger/aggregates')).body.definition).toBe('reported_supplier_payments_v1')
    expect((await call('/api/ledger/records?tenant=org_someone_else')).status).toBe(404)
    expect((await call('/api/ledger/records?from=yesterday')).status).toBe(400)

    const odd = await call('/api/ledger/imports', { method: 'POST', json: { csv: ODD_FILE } })
    expect(odd).toMatchObject({ status: 409, body: { code: 'mapping_unconfirmed' } })
    expect((await call('/api/ledger/mappings/proposals', { method: 'POST', json: { csv: ODD_FILE } })).body.status).toBe('pending_confirmation')
    expect((await call('/api/ledger/mappings', { method: 'POST', json: { nonsense: true } })).status).toBe(400)
    expect((await call('/api/ledger/mappings', { method: 'POST', json: oddMapping() })).status).toBe(201)
    expect((await call('/api/ledger/imports', { method: 'POST', json: { csv: ODD_FILE } })).status).toBe(201)

    signOut()
    await signIn('other@example.test')
    expect((await call('/api/ledger/records')).body.records).toEqual([])
    expect((await call(`/api/ledger/records?ids=${records.body.records[0].id}`)).body.records).toEqual([])
  })
})
