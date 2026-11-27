/**
 * SYNTHETIC CONTRACT FIXTURES. Fictional vendors, fictional amounts. Not customer data.
 *
 * Audits are built through the real pipeline (parseCsv -> mergeImport ->
 * serializeEnvironment -> JSON) so they look exactly like what ProjectStore
 * returns on the server. Test-only: uses the `@/` alias.
 */
import { parseCsv } from '@/lib/csv'
import { mergeImport, serializeEnvironment, type LedgerEnvironment } from '@/ledger/store'
import type { CaseState } from '@/ledger/caseState'
import { SINGLE_USER_PERMISSIONS, type Permission, type TenantContext } from '../contracts.ts'
import type { StoredAudit } from '../adapters/legacyAudit.ts'

export const FIXTURE_LABEL = 'SYNTHETIC FIXTURE: fictional data for local tests only'

export function fixtureContext(tenantId = 'tenant_fixture_a', permissions: readonly Permission[] = SINGLE_USER_PERMISSIONS): TenantContext {
  return { tenantId, actorId: tenantId, permissions, source: 'test_fixture' }
}

const HEADER = 'vendor,invoice_number,invoice_date,payment_date,invoice_amount,amount_paid,terms,bank_account_last4,category,currency,transaction_type'

/** Build a saved audit (server JSON shape) from CSV body rows. */
export function auditFromCsv(id: string, rows: string[], options: { label?: string; mode?: 'sample' | 'upload'; updatedAt?: number; header?: string } = {}): StoredAudit {
  const parsed = parseCsv([options.header ?? HEADER, ...rows].join('\n'))
  const env = mergeImport(null, { sourceLabel: options.label ?? `${id}.csv`, mode: options.mode ?? 'upload', parsed })
  const json = JSON.parse(serializeEnvironment(env)) as LedgerEnvironment
  if (options.updatedAt !== undefined) json.updatedAt = options.updatedAt
  return { id, name: options.label ?? id, updatedAt: options.updatedAt ?? json.updatedAt, environment: json }
}

/** Return a copy of the audit with one case's state replaced (as a case command would leave it). */
export function withCaseState(audit: StoredAudit, findingId: string, state: CaseState): StoredAudit {
  const env = structuredClone(audit.environment) as LedgerEnvironment
  env.caseStates = { ...env.caseStates, [findingId]: state }
  return { ...audit, environment: env }
}

export function findingsOf(audit: StoredAudit): LedgerEnvironment['result']['findings'] {
  return (audit.environment as LedgerEnvironment).result.findings
}

/**
 * Tenant A, first quarter 2026. Contains: monthly rent (recurring), a coffee
 * supplier with an exact duplicate payment (INV-1003 paid twice), an office
 * supplier with no category, one refund row, and one EUR payment.
 */
export const TENANT_A_Q1 = [
  'Fixture Property Mgmt,RENT-01,2026-01-01,2026-01-01,4000.00,4000.00,due on receipt,1111,Rent,USD,',
  'Fixture Property Mgmt,RENT-02,2026-02-01,2026-02-01,4000.00,4000.00,due on receipt,1111,Rent,USD,',
  'Fixture Property Mgmt,RENT-03,2026-03-01,2026-03-01,4000.00,4000.00,due on receipt,1111,Rent,USD,',
  'Fixture Coffee Co,INV-1001,2026-01-03,2026-01-20,1200.00,1200.00,net 30,2222,COGS,USD,',
  'Fixture Coffee Co,INV-1002,2026-01-17,2026-02-05,1350.50,1350.50,net 30,2222,COGS,USD,',
  'Fixture Coffee Co,INV-1003,2026-02-01,2026-02-20,1410.25,1410.25,net 30,2222,COGS,USD,',
  'Fixture Coffee Co,INV-1003,2026-02-01,2026-03-02,1410.25,1410.25,net 30,2222,COGS,USD,',
  'Fixture Office Supply,OS-77,2026-01-10,2026-01-25,310.40,310.40,net 15,3333,,USD,',
  'Fixture Office Supply,OS-78,2026-02-10,2026-02-24,289.60,289.60,net 15,3333,,USD,',
  'Fixture Office Supply,OS-78R,2026-02-10,2026-03-05,,-50.00,,3333,,USD,refund',
  'Fixture Euro Parts GmbH,EP-9,2026-02-11,2026-03-10,900.00,900.00,net 30,4444,Parts,EUR,',
]

/**
 * Tenant A, a second upload overlapping March: RENT-03 and the INV-1003
 * duplicate pair appear again, plus April-June activity.
 */
export const TENANT_A_Q2_OVERLAP = [
  'Fixture Property Mgmt,RENT-03,2026-03-01,2026-03-01,4000.00,4000.00,due on receipt,1111,Rent,USD,',
  'Fixture Coffee Co,INV-1003,2026-02-01,2026-02-20,1410.25,1410.25,net 30,2222,COGS,USD,',
  'Fixture Coffee Co,INV-1003,2026-02-01,2026-03-02,1410.25,1410.25,net 30,2222,COGS,USD,',
  'Fixture Property Mgmt,RENT-04,2026-04-01,2026-04-01,4000.00,4000.00,due on receipt,1111,Rent,USD,',
  'Fixture Property Mgmt,RENT-05,2026-05-01,2026-05-01,4000.00,4000.00,due on receipt,1111,Rent,USD,',
  'Fixture Property Mgmt,RENT-06,2026-06-01,2026-06-01,4000.00,4000.00,due on receipt,1111,Rent,USD,',
  'Fixture Coffee Co,INV-1004,2026-03-20,2026-04-10,1300.00,1300.00,net 30,2222,COGS,USD,',
  'Fixture Coffee Co,INV-1005,2026-04-20,2026-05-12,4980.00,4980.00,net 30,2222,COGS,USD,',
  'Fixture Coffee Co,INV-1006,2026-05-20,2026-06-09,1295.75,1295.75,net 30,2222,COGS,USD,',
]

/** Tenant B: same vendor names as tenant A, different business. Must never leak across. */
export const TENANT_B_ROWS = [
  'Fixture Coffee Co,B-1,2026-01-05,2026-01-30,999.99,999.99,net 30,9999,COGS,USD,',
  'Fixture Coffee Co,B-2,2026-02-05,2026-02-28,888.88,888.88,net 30,9999,COGS,USD,',
]

export function tenantAAudits(): StoredAudit[] {
  return [
    auditFromCsv('audit_a_q1', TENANT_A_Q1, { updatedAt: Date.UTC(2026, 2, 31) }),
    auditFromCsv('audit_a_q2', TENANT_A_Q2_OVERLAP, { updatedAt: Date.UTC(2026, 5, 30) }),
  ]
}

export function tenantBAudits(): StoredAudit[] {
  return [auditFromCsv('audit_b_1', TENANT_B_ROWS, { updatedAt: Date.UTC(2026, 2, 1) })]
}
