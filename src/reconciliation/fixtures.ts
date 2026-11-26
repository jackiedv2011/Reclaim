/**
 * SYNTHETIC FIXTURES for return matching and unused-credit reconciliation.
 *
 * Every tenant, supplier, reference and amount here is invented. None of it
 * comes from a customer ledger, a QuickBooks company or any real export. Other
 * workstreams may import these for contract tests.
 */
import { SOURCE_NORMALIZATION_VERSION } from '../contracts/financial.ts'
import type { OpenRecoveryRequest, ReturnSourceRecord } from './returnMatching.ts'
import type { CreditApplication, CreditCoverage, CreditReversal, SupplierCredit } from './unusedCredits.ts'

export const SYNTHETIC_FIXTURE_NOTICE = 'Synthetic test data. Not derived from any customer or real ledger.' as const

export const SYNTH_TENANT_A = 'synthetic-tenant-a'
export const SYNTH_TENANT_B = 'synthetic-tenant-b'
export const SYNTH_VENDOR = 'synthetic-vendor:acme-widgets'
export const SYNTH_OTHER_VENDOR = 'synthetic-vendor:globex-parts'
export const SYNTH_ACCOUNT = 'synthetic-realm-001'

/** An open recovery request with synthetic defaults: USD 1,250.00 requested on 2026-09-01 for invoice SYN-INV-7781. */
export function syntheticRequest(overrides: Partial<OpenRecoveryRequest> = {}): OpenRecoveryRequest {
  return {
    projectId: 'synthetic-project-1',
    findingId: 'synthetic-finding-1',
    requestGeneration: 1,
    tenantId: SYNTH_TENANT_A,
    vendorKey: SYNTH_VENDOR,
    sourceAccount: SYNTH_ACCOUNT,
    currency: 'USD',
    requestedAmountMinor: 125_000,
    requestedAt: '2026-09-01',
    references: ['syninv7781'],
    alreadyRecordedMinor: 0,
    status: 'requested',
    ...overrides,
  }
}

/** A synthetic deposit (refund from the supplier) of USD 1,250.00 on 2026-09-15 with memo SYN-INV-7781. */
export function syntheticReturnRecord(overrides: Partial<ReturnSourceRecord> = {}): ReturnSourceRecord {
  const id = overrides.id ?? 'synthetic-rec-1'
  return {
    id,
    tenantId: SYNTH_TENANT_A,
    sourceSystem: 'quickbooks',
    sourceAccount: SYNTH_ACCOUNT,
    importId: 'synthetic-import-1',
    sourceNativeId: `Deposit:${id}`,
    kind: 'deposit',
    provenance: 'connector_authenticated',
    vendorName: 'Acme Widgets (synthetic)',
    vendorKey: SYNTH_VENDOR,
    referenceRaw: null,
    referenceNormalized: null,
    referenceStrength: 'none',
    currency: 'USD',
    amountMinor: 125_000,
    invoiceAmountMinor: null,
    invoiceDate: null,
    paymentDate: '2026-09-15',
    status: 'settled',
    normalizationVersion: SOURCE_NORMALIZATION_VERSION,
    unknownFields: [],
    identityKey: `synthetic-identity:${id}`,
    sourceRow: null,
    appliedToBills: [],
    reversedBy: null,
    memoReference: 'SYN-INV-7781',
    ...overrides,
  }
}

/** A synthetic vendor credit of USD 1,250.00 issued 2026-09-10, not applied to any bill. */
export function syntheticVendorCredit(overrides: Partial<ReturnSourceRecord> = {}): ReturnSourceRecord {
  const id = overrides.id ?? 'synthetic-credit-1'
  return syntheticReturnRecord({
    id,
    kind: 'vendor_credit',
    sourceNativeId: `VendorCredit:${id}`,
    identityKey: `synthetic-identity:${id}`,
    invoiceDate: '2026-09-10',
    paymentDate: null,
    referenceRaw: `SYN-CM-${id}`,
    referenceNormalized: `syncm${id.replace(/[^a-z0-9]/gi, '').toLowerCase()}`,
    referenceStrength: 'strong',
    ...overrides,
  })
}

export function syntheticCredit(overrides: Partial<SupplierCredit> = {}): SupplierCredit {
  return { id: 'synthetic-credit-1', tenantId: SYNTH_TENANT_A, vendorKey: SYNTH_VENDOR, currency: 'USD', amountMinor: 50_000, date: '2026-07-10', ...overrides }
}

export function syntheticApplication(overrides: Partial<CreditApplication> = {}): CreditApplication {
  return {
    id: 'synthetic-app-1', creditId: 'synthetic-credit-1', tenantId: SYNTH_TENANT_A, vendorKey: SYNTH_VENDOR,
    billRef: 'SYN-BILL-9001', amountMinor: 20_000, date: '2026-08-01', ...overrides,
  }
}

export function syntheticReversal(overrides: Partial<CreditReversal> = {}): CreditReversal {
  return { id: 'synthetic-rev-1', creditId: 'synthetic-credit-1', tenantId: SYNTH_TENANT_A, amountMinor: null, date: '2026-08-15', ...overrides }
}

export const SYNTHETIC_FULL_COVERAGE: CreditCoverage = {
  creditsComplete: true,
  applicationsComplete: true,
  reversalsComplete: true,
  period: { from: '2026-01-01', to: '2026-10-31' },
}

/** A ready scenario: one request, one post-request deposit agreeing by memo reference. */
export const SYNTHETIC_SIMPLE_REFUND_SCENARIO = {
  notice: SYNTHETIC_FIXTURE_NOTICE,
  requests: [syntheticRequest()],
  records: [syntheticReturnRecord()],
  dataAsOf: '2026-10-01',
} as const
