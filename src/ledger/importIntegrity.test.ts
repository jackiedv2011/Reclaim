import { afterEach, describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/csv'
import { storedDay } from '@/lib/format'
import { rowFingerprint } from '../../server/uploads'
import { confirmCase } from './caseState'
import { deserializeEnvironment, mergeImport, removeImport, serializeEnvironment, setCaseState, type LedgerEnvironment } from './store'

const header = 'vendor,invoice_number,payment_date,amount_paid,currency,transaction_id,company,source_account'
const a = 'ABC Supply LLC ,INV-0042,2025-01-01,100,USD,P1,Books,AP'
const b = 'ABC Supply LLC ,0042,2025-01-02,100,USD,P2,Books,AP'
const input = (rows: string[], name = 'one.csv') => ({ sourceLabel: name, mode: 'upload' as const, parsed: parseCsv([header, ...rows].join('\n')) })

describe('import identity and source preservation', () => {
  it('same content, renamed uploads and retries do not mutate the ledger', () => {
    const env = mergeImport(null, input([a,b]))
    expect(mergeImport(env, input([a,b]))).toEqual(env)
    expect(mergeImport(env, input([a,b], 'renamed.csv'))).toEqual(env)
    const restored = deserializeEnvironment(serializeEnvironment(env))
    expect(mergeImport(restored, input([a,b]))).toEqual(restored)
  })
  it('overlapping batches retain only new transaction identities', () => {
    const env = mergeImport(null, input([a]))
    const next = mergeImport(env, input([a,b], 'two.csv'))
    expect(next.records).toHaveLength(2)
    expect(next.imports[1].rowResults?.map(r => r.status)).toEqual(['exact_duplicate','newly_imported'])
  })
  it('distinct external payments with identical financial fields remain separate', () => {
    const env = mergeImport(null, input([a, a.replace('P1','P2')]))
    expect(env.records).toHaveLength(2)
    expect(new Set(env.records.map(r => r.rowFingerprint)).size).toBe(2)
  })
  it('identity never crosses independent tenant/project environments', () => {
    const first = mergeImport(null, input([a,b]))
    const second = mergeImport(null, input([a,b]))
    expect(second.records).toHaveLength(first.records.length)
    expect(second.imports[0].rowResults?.every(r => r.status === 'newly_imported')).toBe(true)
  })
  it('ambiguous overlap is retained for inspection instead of silently discarded', () => {
    const noId = a.replace('P1','')
    const env = mergeImport(null, input([noId]))
    const next = mergeImport(env, input([noId,b]))
    expect(next.records).toHaveLength(2)
    expect(next.imports[1].rowResults?.[0]).toMatchObject({ status:'possible_overlap', raw: expect.objectContaining({ vendor:'ABC Supply LLC ' }) })
  })
  it('conflicting external identity is quarantined with raw facts', () => {
    const env = mergeImport(null, input([a]))
    const next = mergeImport(env, input([a.replace(',100,',',200,')]))
    expect(next.records).toHaveLength(1)
    expect(next.imports[1].rowResults?.[0].status).toBe('possible_overlap')
  })
  it('preserves raw values, normalization steps and source locations', () => {
    const env = mergeImport(null, input([a,b]))
    expect(env.records[0].vendor).toBe('ABC Supply LLC')
    expect(env.records[0].source).toMatchObject({ rawAvailable:true, filename:'one.csv', rowNumber:2, batchId:env.imports[0].id, raw:{vendor:'ABC Supply LLC ',invoice_number:'INV-0042'}, normalized:{vendor:'abc supply',invoiceReference:'0042'} })
    expect(env.records[0].source?.transformations.invoiceReference).toContain('remove_invoice_prefix')
  })
})

const file = (...rows: string[]) => ({ sourceLabel: 'f.csv', mode: 'upload' as const, parsed: parseCsv(rows.join('\n')) })
const plain = 'vendor,invoice_number,payment_date,amount_paid'
const found = (env: LedgerEnvironment) => env.result.findings.map((f) => `${f.type} ${f.dollarImpact}`)

describe('payments are never dropped for looking alike', () => {
  const paid = 'Acme,INV-1001,2025-01-10,5000'

  it('the same invoice paid twice on one day is two payments, and a finding', () => {
    const env = mergeImport(null, file(plain, paid, paid))
    expect(env.records).toHaveLength(2)
    expect(found(env)).toEqual(['exact_duplicate 5000'])
    expect(new Set(env.records.map((r) => r.id)).size).toBe(2)
  })

  it('payments with no reference on one day are all kept', () => {
    expect(mergeImport(null, file(plain, 'Verizon,,2025-03-04,45', 'Verizon,,2025-03-04,45', 'Verizon,,2025-03-04,45')).records).toHaveLength(3)
  })

  it('one payment ID over several bills keeps every bill, and a bill paid again is found', () => {
    const env = mergeImport(null, file(`${plain},payment_id`, 'Acme,INV-1,2025-01-10,500,P1', 'Acme,INV-2,2025-01-10,700,P1', 'Acme,INV-2,2025-01-20,700,P2'))
    expect(env.records).toHaveLength(3)
    expect(found(env)).toEqual(['exact_duplicate 700'])
  })

  it('a line repeating its own transaction ID, cell for cell, is one payment listed twice', () => {
    const env = mergeImport(null, file(`${plain},payment_id`, `${paid},P1`, `${paid},P1`))
    expect(env.records).toHaveLength(1)
    expect(env.imports[0].rowResults?.[1]).toMatchObject({ status: 'exact_duplicate', rowNumber: 3 })
  })

  it('a later file brings in only the copies the ledger does not have yet', () => {
    const first = mergeImport(null, file(plain, paid))
    expect(mergeImport(first, file(plain, paid, 'Beta,B-1,2025-02-01,9')).records).toHaveLength(2)
    const twice = mergeImport(first, file(plain, paid, paid))
    expect(twice.records).toHaveLength(2)
    expect(found(twice)).toEqual(['exact_duplicate 5000'])
    expect(mergeImport(twice, file(plain, paid, paid, 'Beta,B-1,2025-02-01,9')).records).toHaveLength(3)
  })
})

describe('the same payment is recognised however the next file is written', () => {
  const first = mergeImport(null, file(plain, 'Acme,INV-1001,2025-01-10,250', 'Beta LLC,B-7,2025-01-12,100'))

  it('respelled, or with more columns than last time', () => {
    expect(mergeImport(first, file(plain, 'ACME ,inv-1001,2025-01-10,250.00', 'beta  llc,B-7,2025-01-12,100')).records).toHaveLength(2)
    expect(mergeImport(first, file(`${plain},currency,transaction_id`, 'Acme,INV-1001,2025-01-10,250,USD,T-1', 'Beta LLC,B-7,2025-01-12,100,USD,T-2')).records).toHaveLength(2)
  })

  it('but not when the two say different things', () => {
    const usd = mergeImport(null, file(`${plain},currency`, 'Acme,INV-1001,2025-01-10,250,USD'))
    expect(mergeImport(usd, file(`${plain},currency`, 'Acme,INV-1001,2025-01-10,250,EUR')).records).toHaveLength(2)
    const t1 = mergeImport(null, file(`${plain},transaction_id`, 'Acme,INV-1001,2025-01-10,250,T-1'))
    expect(mergeImport(t1, file(`${plain},transaction_id`, 'Acme,INV-1001,2025-01-10,250,T-2')).records).toHaveLength(2)
  })

  it('read with the dates the other way round', () => {
    const rows = [plain, 'Acme,INV-1001,02/04/2026,100', 'Beta,INV-9000,05/04/2026,70']
    const monthFirst = mergeImport(null, file(...rows))
    const later = mergeImport(monthFirst, { ...file(), parsed: parseCsv([...rows, 'Corp,INV-7000,25/04/2026,40'].join('\n'), { dateOrder: 'day-first' }) })
    expect(later.records).toHaveLength(3)
    expect(found(later)).toEqual([])
  })
})

describe('days do not move with the time zone', () => {
  const zone = process.env.TZ
  afterEach(() => {
    if (zone === undefined) delete process.env.TZ
    else process.env.TZ = zone
  })
  const rows = [plain, 'Acme,INV-1001,2025-01-01,250', 'Beta,B-7,2025-07-12,100']
  const days = (env: LedgerEnvironment) => env.records.map((r) => [r.paymentDate.getFullYear(), r.paymentDate.getMonth() + 1, r.paymentDate.getDate()].join('-'))

  it.each([['America/New_York', 'America/Los_Angeles'], ['Europe/London', 'Europe/Paris'], ['Asia/Kolkata', 'America/New_York'], ['Pacific/Auckland', 'UTC']])('saved in %s, opened in %s', (from, to) => {
    process.env.TZ = from
    const saved = serializeEnvironment(mergeImport(null, file(...rows)))
    expect(saved).toContain('"paymentDate":"2025-01-01"')
    process.env.TZ = to
    const opened = deserializeEnvironment(saved)
    expect(days(opened)).toEqual(['2025-1-1', '2025-7-12'])
    const again = mergeImport(opened, file(...rows, 'Corp,C-1,2025-08-01,9'))
    expect(again.records).toHaveLength(3)
    expect(found(again)).toEqual([])
  })

  it.each([['America/New_York', 'America/Los_Angeles'], ['Europe/Paris', 'America/New_York'], ['Asia/Tokyo', 'UTC'], ['Pacific/Honolulu', 'Asia/Tokyo']])('audits saved as instants by earlier versions in %s open right in %s', (from, to) => {
    process.env.TZ = from
    const env = mergeImport(null, file(...rows))
    const old = JSON.parse(JSON.stringify(env))
    old.records.forEach((r: { identityKey: string; paymentDate: string }) => (r.identityKey = `["raw","${r.paymentDate}"]`))
    process.env.TZ = to
    const opened = deserializeEnvironment(JSON.stringify(old))
    expect(days(opened)).toEqual(['2025-1-1', '2025-7-12'])
    expect(mergeImport(opened, file(...rows, 'Corp,C-1,2025-08-01,9')).records).toHaveLength(3)
  })

  it('the repeat-upload fingerprint is the same for a day and for the instant it used to be stored as', () => {
    process.env.TZ = 'UTC'
    const row = { vendor: 'Acme', invoiceNumber: 'INV-1', amountPaid: 5 }
    const day = rowFingerprint({ ...row, paymentDate: '2025-01-10' })
    for (const instant of ['2025-01-10T05:00:00.000Z', '2025-01-09T23:00:00.000Z', '2025-01-10T00:00:00.000Z']) expect(rowFingerprint({ ...row, paymentDate: instant }), instant).toBe(day)
    process.env.TZ = 'America/Los_Angeles'
    expect(rowFingerprint({ ...row, paymentDate: '2025-01-10' })).toBe(day)
    expect(storedDay('not a date')).toBeNull()
  })
})

describe('adding and removing files around decisions', () => {
  const decided = () => {
    const env = mergeImport(null, file(plain, 'Acme,INV-1,2025-01-10,500', 'Acme,INV-1,2025-01-20,500'))
    const id = env.result.findings[0].id
    return { env: setCaseState(env, id, confirmCase('Seen on the statement')), id }
  }

  it('unrelated rows leave a decided finding exactly as it was', () => {
    const { env, id } = decided()
    const before = JSON.parse(serializeEnvironment(env))
    const after = JSON.parse(serializeEnvironment(mergeImport(env, file(plain, 'Beta,B-1,2025-02-01,9', 'Beta,B-2,2025-02-05,19'))))
    const pick = (e: { result: { findings: { id: string }[] } }) => e.result.findings.find((f) => f.id === id)
    expect(pick(after)).toEqual(pick(before))
    expect(after.caseStates).toEqual(before.caseStates)
  })

  it('a removed file takes its payments out and can be uploaded again', () => {
    const first = mergeImport(null, file(plain, 'Acme,INV-1,2025-01-10,500'))
    const second = mergeImport(first, file(plain, 'Acme,INV-1,2025-01-20,500'))
    expect(found(second)).toEqual(['exact_duplicate 500'])
    const removed = removeImport(second, second.imports[1].id)
    expect(removed.records).toHaveLength(1)
    expect(removed.imports).toHaveLength(1)
    expect(found(removed)).toEqual([])
    expect(removed.retiredRecords).toHaveLength(1)
    expect(found(mergeImport(removed, file(plain, 'Acme,INV-1,2025-01-20,500')))).toEqual(['exact_duplicate 500'])
  })

  it('removing a file keeps a decision made on its payments, marked to be checked again', () => {
    const { env, id } = decided()
    const removed = removeImport(env, env.imports[0].id)
    expect(removed.records).toHaveLength(0)
    expect(removed.caseStates[id]).toMatchObject({ requiresRevalidation: true })
    const reloaded = deserializeEnvironment(serializeEnvironment(removed))
    expect(reloaded.result.findings.find((f) => f.id === id)?.relatedRecords).toHaveLength(2)
  })
})
