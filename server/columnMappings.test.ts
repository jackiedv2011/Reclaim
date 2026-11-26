// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { formatSignature, headerKey, MappingConflictError, type ColumnMapping } from '../src/ingestion/columnMapping.ts'
import { confirmMapping, currentMapping, ensureColumnMappingSchema, mappingHistory, proposeMapping, resolveMappingForUpload } from './columnMappings.ts'

const T1 = 'tenant_a'
const T2 = 'tenant_b'
const HEADERS = ['Merchant', 'Doc No', 'Paid On', 'Paid Amt', 'GL']
const SAMPLE = [['Acme', 'D-100', '2025-01-02', '10.00', 'Ops']]

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  // Mappings belong to an organisation and cascade with it; a minimal parent schema is enough here.
  d.exec(`CREATE TABLE users (id TEXT PRIMARY KEY);
    CREATE TABLE organizations (id TEXT PRIMARY KEY);
    INSERT INTO users VALUES ('user_1'), ('user_2'), ('user_a'), ('user_b');
    INSERT INTO organizations VALUES ('${T1}'), ('${T2}');`)
  ensureColumnMappingSchema(d)
  ensureColumnMappingSchema(d) // idempotent
  return d
}

function mappingFor(headers: readonly string[], assign: Record<string, string | null>): ColumnMapping {
  return {
    signature: formatSignature(headers),
    formatId: null,
    columns: headers.map((h) => ({ key: headerKey(h), header: h, canonical: assign[h] ?? null })),
    locale: { dateOrder: 'month_first', decimal: 'dot' },
  }
}
const ASSIGN = { Merchant: 'vendor', 'Doc No': 'invoice_number', 'Paid On': 'payment_date', 'Paid Amt': 'amount_paid', GL: 'category' }

describe('column mapping store', () => {
  it('deletes an organisation’s mappings with the organisation', () => {
    const d = db()
    confirmMapping(d, T1, 'user_1', formatSignature(HEADERS), mappingFor(HEADERS, ASSIGN))
    d.prepare('DELETE FROM organizations WHERE id = ?').run(T1)
    expect(currentMapping(d, T1, formatSignature(HEADERS))).toBeNull()
  })

  it('a first upload of an unfamiliar format needs confirmation', () => {
    const d = db()
    const r = resolveMappingForUpload(d, T1, HEADERS, SAMPLE)
    expect(r.status).toBe('pending_confirmation')
    expect(r.version).toBeNull()
    expect(r.pendingFields).toEqual(expect.arrayContaining(['vendor', 'payment_date', 'amount_paid']))
  })

  it('confirming creates versions; re-upload of the same format needs no reconfirmation', () => {
    const d = db()
    const sig = formatSignature(HEADERS)
    const v1 = confirmMapping(d, T1, 'user_1', sig, mappingFor(HEADERS, ASSIGN), 1000)
    expect(v1).toMatchObject({ version: 1, mappingId: `${sig}:v1`, confirmedBy: 'user_1', confirmedAt: 1000 })
    const v2 = confirmMapping(d, T1, 'user_2', sig, mappingFor(HEADERS, { ...ASSIGN, GL: null }), 2000)
    expect(v2.version).toBe(2)
    expect(currentMapping(d, T1, sig)?.version).toBe(2)
    expect(mappingHistory(d, T1, sig).map((m) => m.version)).toEqual([1, 2])

    // Same columns in a different order is the same format.
    const reordered = [...HEADERS].reverse()
    const r = resolveMappingForUpload(d, T1, reordered, [['Ops', '10.00', '2025-01-02', 'D-100', 'Acme']])
    expect(r).toMatchObject({ status: 'confirmed', version: 2, mappingId: `${sig}:v2`, pendingFields: [] })
    expect(proposeMapping(d, T1, HEADERS).status).toBe('confirmed')
  })

  it('a material change against the last confirmed version requires reconfirmation', () => {
    const d = db()
    confirmMapping(d, T1, 'user_1', formatSignature(HEADERS), mappingFor(HEADERS, ASSIGN))
    // The reference column disappears and an unknown "Ref" appears.
    const changed = ['Merchant', 'Ref Code', 'Paid On', 'Paid Amt', 'GL']
    const r = resolveMappingForUpload(d, T1, changed, SAMPLE)
    expect(r.status).toBe('pending_confirmation')
    expect(r.pendingFields).toContain('invoice_number')
    expect(r.basedOn?.diff.material).toBe(true)
    expect(r.mapping.columns.find((c) => c.key === 'merchant')?.canonical).toBe('vendor')
  })

  it('an immaterial change (a new memo column) carries the confirmed mapping over', () => {
    const d = db()
    const v = confirmMapping(d, T1, 'user_1', formatSignature(HEADERS), mappingFor(HEADERS, ASSIGN))
    const r = resolveMappingForUpload(d, T1, [...HEADERS, 'Memo'], [[...SAMPLE[0], 'note']])
    expect(r.status).toBe('confirmed')
    expect(r.basedOn).toMatchObject({ mappingId: v.mappingId, diff: { material: false } })
    expect(r.mapping.signature).toBe(formatSignature([...HEADERS, 'Memo']))
    expect(r.mapping.columns.find((c) => c.key === 'memo')?.canonical).toBeNull()
  })

  it('refuses to store a conflicting or incomplete mapping', () => {
    const d = db()
    const sig = formatSignature(HEADERS)
    expect(() => confirmMapping(d, T1, 'user_1', sig, mappingFor(HEADERS, { ...ASSIGN, GL: 'vendor' }))).toThrow(MappingConflictError)
    expect(() => confirmMapping(d, T1, 'user_1', sig, mappingFor(HEADERS, { Merchant: 'vendor' }))).toThrow(MappingConflictError)
    expect(() => confirmMapping(d, T1, 'user_1', sig, { ...mappingFor(HEADERS, ASSIGN), locale: { dateOrder: 'day_first', decimal: 'dot' } })).toThrow(MappingConflictError)
    expect(() => confirmMapping(d, T1, 'user_1', formatSignature(['x']), mappingFor(HEADERS, ASSIGN))).toThrow(MappingConflictError)
    expect(() => confirmMapping(d, '', 'user_1', sig, mappingFor(HEADERS, ASSIGN))).toThrow()
    expect(mappingHistory(d, T1, sig)).toEqual([])
  })

  it('re-checks the stored convention against new rows', () => {
    const d = db()
    confirmMapping(d, T1, 'user_1', formatSignature(HEADERS), mappingFor(HEADERS, ASSIGN))
    const r = resolveMappingForUpload(d, T1, HEADERS, [['Acme', 'D-1', '26/01/2025', '10.00', 'Ops']])
    expect(r.status).toBe('conflict')
    expect(r.issues.map((i) => i.code)).toContain('date_day_first')
  })

  it('keeps tenants isolated', () => {
    const d = db()
    const sig = formatSignature(HEADERS)
    confirmMapping(d, T1, 'user_a', sig, mappingFor(HEADERS, ASSIGN))
    expect(currentMapping(d, T2, sig)).toBeNull()
    expect(mappingHistory(d, T2, sig)).toEqual([])
    expect(resolveMappingForUpload(d, T2, HEADERS, SAMPLE).status).toBe('pending_confirmation')
    // T2's similar-format search must not see T1's mappings either.
    expect(resolveMappingForUpload(d, T2, [...HEADERS, 'Memo'], SAMPLE).basedOn).toBeNull()
    // Versions are numbered per tenant.
    expect(confirmMapping(d, T2, 'user_b', sig, mappingFor(HEADERS, ASSIGN)).version).toBe(1)
    expect(currentMapping(d, T1, sig)?.confirmedBy).toBe('user_a')
  })

  it('built-in formats resolve without a stored mapping; conflicts never auto-apply', () => {
    const d = db()
    expect(resolveMappingForUpload(d, T1, ['vendor', 'invoice_number', 'invoice_date', 'payment_date', 'invoice_amount', 'amount_paid', 'terms', 'bank_account_last4', 'category', 'currency']).status).toBe('known_format')
    const collision = resolveMappingForUpload(d, T1, ['Vendor', 'Supplier', 'Payment Date', 'Amount Paid'])
    expect(collision.status).toBe('conflict')
    expect(resolveMappingForUpload(d, T1, []).status).toBe('conflict')
    expect(resolveMappingForUpload(d, T1, ['Vendor', 'vendor', 'Payment Date', 'Amount Paid']).status).toBe('conflict')
  })

  it('stores only structure, never sample values', () => {
    const d = db()
    confirmMapping(d, T1, 'user_1', formatSignature(HEADERS), mappingFor(HEADERS, ASSIGN))
    const raw = d.prepare('SELECT mapping_json FROM column_mappings WHERE tenant_id = ?').all(T1) as Array<{ mapping_json: string }>
    expect(raw.map((r) => r.mapping_json).join('')).not.toMatch(/Acme|D-100/)
  })
})
