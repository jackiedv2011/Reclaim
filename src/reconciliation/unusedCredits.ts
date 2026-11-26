/**
 * Unused supplier credit reconciliation: per tenant + supplier + currency,
 * how much credit was issued, how much was applied to bills, how much was
 * reversed, and (only when coverage allows) how much remains unused.
 *
 * Pure and deterministic. It never applies a credit, never proposes a journal
 * entry and never turns remaining credit into a "recovered" figure. A remaining
 * balance is only computed when the inputs are known to be complete for the
 * period that contains every credit; otherwise it is null with reasons.
 *
 * Only verified applications (source-system links such as BillPayment lines)
 * enter the math. Links proposed by a matcher through `candidateLinks` are
 * returned for review and never change any total.
 */
import type { ReturnSourceRecord } from './returnMatching.ts'

export const UNUSED_CREDIT_VERSION = 'unused-credit/1.0.0' as const

export interface SupplierCredit {
  id: string
  tenantId: string
  vendorKey: string
  /** ISO 4217, or null when the source omitted it (never assumed). */
  currency: string | null
  amountMinor: number | null
  /** ISO date the credit was issued. */
  date: string | null
}

/** A verified application of a credit to a bill, read from the accounting system. */
export interface CreditApplication {
  id: string
  creditId: string
  tenantId: string
  vendorKey: string
  billRef: string
  amountMinor: number | null
  date: string | null
}

/** A void or reversal of a credit. amountMinor null = the whole credit. */
export interface CreditReversal {
  id: string
  creditId: string
  tenantId: string
  amountMinor: number | null
  date: string | null
}

export interface CreditCoverage {
  /** Every credit issued in the period is in `credits`. */
  creditsComplete: boolean
  /** Every application of those credits up to period.to is in `applications`. */
  applicationsComplete: boolean
  /** Every void/reversal up to period.to is in `reversals`. */
  reversalsComplete: boolean
  /** The period the data covers; must contain every credit date. Null = unknown. */
  period: { from: string; to: string } | null
}

/** A link a matcher thinks may exist. Never used in the math. */
export interface ProposedCreditLink {
  creditId: string
  billRef: string
  amountMinor: number | null
  rationale: string
}

export interface CreditGroupContext {
  tenantId: string
  vendorKey: string
  currency: string | null
  credits: readonly SupplierCredit[]
  applications: readonly CreditApplication[]
}

export interface ReconcileSupplierCreditsInput {
  credits: readonly SupplierCredit[]
  applications: readonly CreditApplication[]
  reversals: readonly CreditReversal[]
  coverage: CreditCoverage
  /** Optional hook for a record matcher to propose links. Proposals are reported, never counted. */
  candidateLinks?: (group: CreditGroupContext) => readonly ProposedCreditLink[]
}

export type UnusedCreditReason =
  | 'credits_incomplete'
  | 'applications_incomplete'
  | 'reversals_incomplete'
  | 'period_unknown'
  | 'credit_outside_period'
  | 'credit_date_unknown'
  | 'credit_amount_unknown'
  | 'currency_unknown'
  | 'application_amount_unknown'
  | 'application_for_unknown_credit'
  | 'reversal_amount_invalid'
  | 'reversal_for_unknown_credit'
  | 'applied_exceeds_issued'
  | 'credit_applied_and_reversed_exceeds_issued'
  | 'conflicting_duplicate_credit'

export interface SupplierCreditBalance {
  tenantId: string
  vendorKey: string
  currency: string | null
  /** Sum of credits with a known amount. See reasons when any amount is unknown. */
  issuedMinor: number
  /** Sum of verified applications with a known amount. */
  appliedMinor: number
  reversedMinor: number
  /** issued − applied − reversed; null unless status is 'computed'. Never negative. */
  remainingMinor: number | null
  status: 'computed' | 'unknown'
  reasons: UnusedCreditReason[]
  creditIds: string[]
  /** Matcher proposals for review. Not included in appliedMinor or remainingMinor. */
  proposedLinks: ProposedCreditLink[]
  algorithmVersion: typeof UNUSED_CREDIT_VERSION
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const isMinor = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0
const isoDay = (v: string | null | undefined) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

/** Ids are only unique within a tenant, so items are keyed (and conflicts reported) by tenant + id. */
const tenantKey = (tenantId: string, id: string) => `${tenantId}\u0000${id}`

function dedupeById<T extends { id: string; tenantId: string }>(items: readonly T[], same: (a: T, b: T) => boolean): { kept: T[]; conflicting: Set<string> } {
  const kept = new Map<string, T>()
  const conflicting = new Set<string>()
  for (const item of [...items].sort((a, b) => cmp(a.tenantId, b.tenantId) || cmp(a.id, b.id))) {
    const k = tenantKey(item.tenantId, item.id)
    const prior = kept.get(k)
    if (!prior) kept.set(k, item)
    else if (!same(prior, item)) conflicting.add(k)
  }
  return { kept: [...kept.values()], conflicting }
}

/**
 * Reconcile issued, applied and reversed supplier credit per tenant, supplier
 * and currency. Output sorted by tenant, supplier, currency.
 */
export function reconcileSupplierCredits(input: ReconcileSupplierCreditsInput): SupplierCreditBalance[] {
  const { coverage } = input
  const credits = dedupeById(input.credits, (a, b) =>
    a.tenantId === b.tenantId && a.vendorKey === b.vendorKey && a.currency === b.currency && a.amountMinor === b.amountMinor && a.date === b.date)
  const applications = dedupeById(input.applications, (a, b) => a.creditId === b.creditId && a.amountMinor === b.amountMinor && a.billRef === b.billRef)
  const reversals = dedupeById(input.reversals, (a, b) => a.creditId === b.creditId && a.amountMinor === b.amountMinor)

  const creditKey = tenantKey
  const creditById = new Map(credits.kept.map((c) => [creditKey(c.tenantId, c.id), c]))
  const groupKey = (tenantId: string, vendorKey: string, currency: string | null) => `${tenantId}\u0000${vendorKey}\u0000${currency ?? ''}`

  interface Group {
    tenantId: string
    vendorKey: string
    currency: string | null
    credits: SupplierCredit[]
    applications: CreditApplication[]
    reversals: CreditReversal[]
    reasons: Set<UnusedCreditReason>
  }
  const groups = new Map<string, Group>()
  const groupFor = (tenantId: string, vendorKey: string, currency: string | null) => {
    const k = groupKey(tenantId, vendorKey, currency)
    let g = groups.get(k)
    if (!g) {
      g = { tenantId, vendorKey, currency, credits: [], applications: [], reversals: [], reasons: new Set() }
      groups.set(k, g)
    }
    return g
  }

  for (const c of credits.kept) {
    const g = groupFor(c.tenantId, c.vendorKey, c.currency)
    g.credits.push(c)
    if (credits.conflicting.has(creditKey(c.tenantId, c.id))) g.reasons.add('conflicting_duplicate_credit')
  }
  for (const a of applications.kept) {
    const credit = creditById.get(creditKey(a.tenantId, a.creditId))
    if (!credit || credit.vendorKey !== a.vendorKey) {
      // Some credit of this supplier is missing: every currency group of that supplier is in doubt.
      const affected = [...groups.values()].filter((g) => g.tenantId === a.tenantId && g.vendorKey === a.vendorKey)
      if (!affected.length) affected.push(groupFor(a.tenantId, a.vendorKey, null))
      for (const g of affected) g.reasons.add('application_for_unknown_credit')
      continue
    }
    groupFor(credit.tenantId, credit.vendorKey, credit.currency).applications.push(a)
  }
  for (const r of reversals.kept) {
    const credit = creditById.get(creditKey(r.tenantId, r.creditId))
    if (!credit) {
      for (const g of groups.values()) if (g.tenantId === r.tenantId) g.reasons.add('reversal_for_unknown_credit')
      continue
    }
    groupFor(credit.tenantId, credit.vendorKey, credit.currency).reversals.push(r)
  }

  const from = isoDay(coverage.period?.from)
  const to = isoDay(coverage.period?.to)
  const out: SupplierCreditBalance[] = []
  for (const g of groups.values()) {
    const reasons = g.reasons
    if (!coverage.creditsComplete) reasons.add('credits_incomplete')
    if (!coverage.applicationsComplete) reasons.add('applications_incomplete')
    if (!coverage.reversalsComplete) reasons.add('reversals_incomplete')
    if (!from || !to || from > to) reasons.add('period_unknown')
    if (g.currency === null) reasons.add('currency_unknown')

    let issued = 0
    let applied = 0
    let reversed = 0
    for (const c of g.credits) {
      const day = isoDay(c.date)
      if (!day) reasons.add('credit_date_unknown')
      else if (from && to && (day < from || day > to)) reasons.add('credit_outside_period')
      if (!isMinor(c.amountMinor)) {
        reasons.add('credit_amount_unknown')
        continue
      }
      issued += c.amountMinor
      const appliedToCredit = g.applications.filter((a) => a.creditId === c.id)
      let creditApplied = 0
      for (const a of appliedToCredit) {
        if (!isMinor(a.amountMinor)) reasons.add('application_amount_unknown')
        else creditApplied += a.amountMinor
      }
      let creditReversed = 0
      for (const r of g.reversals.filter((x) => x.creditId === c.id)) {
        if (r.amountMinor === null) creditReversed = Math.max(creditReversed, c.amountMinor - creditApplied)
        else if (!isMinor(r.amountMinor)) reasons.add('reversal_amount_invalid')
        else creditReversed += r.amountMinor
      }
      if (creditApplied > c.amountMinor) reasons.add('applied_exceeds_issued')
      else if (creditApplied + creditReversed > c.amountMinor) reasons.add('credit_applied_and_reversed_exceeds_issued')
      applied += creditApplied
      reversed += creditReversed
    }

    const remaining = issued - applied - reversed
    const status: SupplierCreditBalance['status'] = reasons.size === 0 && Number.isSafeInteger(remaining) && remaining >= 0 ? 'computed' : 'unknown'
    if (remaining < 0 && !reasons.has('applied_exceeds_issued') && !reasons.has('credit_applied_and_reversed_exceeds_issued')) reasons.add('applied_exceeds_issued')

    const ctx: CreditGroupContext = { tenantId: g.tenantId, vendorKey: g.vendorKey, currency: g.currency, credits: g.credits, applications: g.applications }
    const proposedLinks = input.candidateLinks
      ? [...input.candidateLinks(ctx)].filter((l) => g.credits.some((c) => c.id === l.creditId))
        .sort((a, b) => cmp(a.creditId, b.creditId) || cmp(a.billRef, b.billRef))
      : []

    out.push({
      tenantId: g.tenantId,
      vendorKey: g.vendorKey,
      currency: g.currency,
      issuedMinor: issued,
      appliedMinor: applied,
      reversedMinor: reversed,
      remainingMinor: status === 'computed' ? remaining : null,
      status,
      reasons: [...reasons].sort(cmp),
      creditIds: g.credits.map((c) => c.id).sort(cmp),
      proposedLinks,
      algorithmVersion: UNUSED_CREDIT_VERSION,
    })
  }
  return out.sort((a, b) => cmp(a.tenantId, b.tenantId) || cmp(a.vendorKey, b.vendorKey) || cmp(a.currency ?? '', b.currency ?? ''))
}

/**
 * Derive credit inputs from return source records (vendor_credit kind), so the
 * same import feeds both the return matcher and this reconciliation. Voided or
 * reversed credits become full reversals.
 */
export function creditsFromReturnRecords(records: readonly ReturnSourceRecord[]): {
  credits: SupplierCredit[]
  applications: CreditApplication[]
  reversals: CreditReversal[]
} {
  const credits: SupplierCredit[] = []
  const applications: CreditApplication[] = []
  const reversals: CreditReversal[] = []
  for (const r of [...records].sort((a, b) => cmp(a.id, b.id))) {
    if (r.kind !== 'vendor_credit') continue
    credits.push({ id: r.id, tenantId: r.tenantId, vendorKey: r.vendorKey, currency: r.currency, amountMinor: r.amountMinor, date: r.invoiceDate ?? r.paymentDate })
    ;(r.appliedToBills ?? []).forEach((a, n) => applications.push({
      id: `${r.id}#app${n + 1}`, creditId: r.id, tenantId: r.tenantId, vendorKey: r.vendorKey, billRef: a.billRef, amountMinor: a.amountMinor, date: a.date,
    }))
    if (r.status === 'voided' || r.status === 'reversed' || r.reversedBy) {
      reversals.push({ id: r.reversedBy ?? `${r.id}#void`, creditId: r.id, tenantId: r.tenantId, amountMinor: null, date: null })
    }
  }
  return { credits, applications, reversals }
}
