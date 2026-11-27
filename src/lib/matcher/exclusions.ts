import type { PreparedRecord } from './prepare.ts'

/**
 * Deterministic exclusions. A pair that hits any of these is never returned as
 * a candidate, whatever its score. They mirror the reasons detection and the
 * evidence gate already use, so the matcher cannot surface something the
 * deterministic engine has a stated reason to leave alone.
 */
export type ExclusionReason =
  /** Same external transaction ID or import identity: one transaction imported twice, not two payments. */
  | 'same_source_transaction'
  | 'different_company'
  | 'currency_mismatch'
  /** Both rows sit on a steady recurring cadence (rent, subscriptions): separate obligations. */
  | 'recurring_series'
  /** A void or reversal row exists for one of the payments. */
  | 'voided_or_reversed'
  /** Refunds/credits already booked against the invoice cover the smaller payment. */
  | 'refund_or_credit_offsets'
  /** Instalments: the payments together come to no more than the invoice. */
  | 'partial_payments_within_invoice'

export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  'same_source_transaction',
  'different_company',
  'currency_mismatch',
  'recurring_series',
  'voided_or_reversed',
  'refund_or_credit_offsets',
  'partial_payments_within_invoice',
]

export interface LedgerContext {
  /** Record id → recurring series id, for payments that keep to a steady cadence. */
  recurringSeries: Map<string, string>
  /** Recurring series id → [first payment day, last payment day]. */
  recurringSpan: Map<string, [number, number]>
  /** `vendorKey|reference` of invoices with a void or reversal row. */
  voidedInvoices: Set<string>
  /** `vendorKey|cents` → payment days of void/reversal rows without a reference. */
  voidedUnreferenced: Map<string, number[]>
  /** `vendorKey|reference` → refund/credit cents booked against it. */
  refundCents: Map<string, number>
  /** `vendorKey|reference` of invoices whose payments sum to no more than the agreed invoice amount. */
  partialInvoices: Set<string>
}

const VOID_MATCH_DAYS = 31
const RECURRING_MIN_CADENCE_DAYS = 5
const INVOICED_RECURRING_MIN_CADENCE_DAYS = 1
const RECURRING_MAX_TOLERANCE_DAYS = 10
const RECURRING_ON_CADENCE_SHARE = 3 / 4

const invoiceKey = (p: PreparedRecord) => (p.referenceNormalized ? `${p.vendorKey}|${p.referenceNormalized}` : null)

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function groupBy<T>(items: T[], keyFn: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = keyFn(item)
    const list = map.get(key)
    if (list) list.push(item)
    else map.set(key, [item])
  }
  return map
}

/**
 * Recurring series, mirroring detection's rule (three or more same-amount
 * payments to one supplier on a steady cadence, no shared invoice numbers,
 * most steps on cadence). Detection's own helper is private, so the idea is
 * restated here rather than imported; it only ever removes pairs.
 */
function recurringRuns(sortedByDate: PreparedRecord[]): PreparedRecord[][] {
  const runs: PreparedRecord[][] = []
  for (const series of groupBy(sortedByDate, (p) => String(p.cents)).values()) {
    if (series.length < 3) continue
    const referenced = series.filter((p) => p.referenceNormalized !== null)
    if (new Set(referenced.map((p) => p.referenceNormalized)).size !== referenced.length) continue
    const gaps = series.slice(1).map((p, i) => p.paymentDay - series[i].paymentDay)
    const cadence = median(gaps)
    const everyRowInvoiced = series.every((p) => p.referenceStrength === 'strong')
    if (cadence < (everyRowInvoiced ? INVOICED_RECURRING_MIN_CADENCE_DAYS : RECURRING_MIN_CADENCE_DAYS)) continue
    const tolerance = Math.min(RECURRING_MAX_TOLERANCE_DAYS, Math.max(2, Math.floor(cadence * 0.35)))
    const onCadence = [series[0]]
    for (const p of series.slice(1)) {
      if (p.paymentDay - onCadence[onCadence.length - 1].paymentDay >= cadence - tolerance) onCadence.push(p)
    }
    if (onCadence.length < 3 || onCadence.length < Math.ceil(series.length * 0.6)) continue
    const steps = onCadence.slice(1).map((p, i) => p.paymentDay - onCadence[i].paymentDay)
    if (steps.filter((gap) => Math.abs(gap - cadence) <= tolerance).length < Math.ceil(steps.length * RECURRING_ON_CADENCE_SHARE)) continue
    runs.push(onCadence)
  }
  return runs
}

export function buildLedgerContext(prepared: PreparedRecord[]): LedgerContext {
  const ctx: LedgerContext = {
    recurringSeries: new Map(),
    recurringSpan: new Map(),
    voidedInvoices: new Set(),
    voidedUnreferenced: new Map(),
    refundCents: new Map(),
    partialInvoices: new Set(),
  }

  for (const p of prepared) {
    const key = invoiceKey(p)
    if (p.kind === 'void_or_reversal') {
      if (key) ctx.voidedInvoices.add(key)
      else {
        const amountKey = `${p.vendorKey}|${Math.abs(p.cents)}`
        const days = ctx.voidedUnreferenced.get(amountKey) ?? []
        days.push(p.paymentDay)
        ctx.voidedUnreferenced.set(amountKey, days)
      }
    } else if (p.kind === 'refund_or_credit' && key) {
      ctx.refundCents.set(key, (ctx.refundCents.get(key) ?? 0) + Math.abs(p.cents))
    }
  }

  const payments = prepared.filter((p) => p.kind === 'payment')
  for (const [vendorKey, group] of groupBy(payments, (p) => p.vendorKey)) {
    const sorted = [...group].sort((a, b) => a.paymentDay - b.paymentDay || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    recurringRuns(sorted).forEach((run, index) => {
      const seriesId = `${vendorKey}#${run[0].cents}#${index}`
      for (const p of run) ctx.recurringSeries.set(p.id, seriesId)
      ctx.recurringSpan.set(seriesId, [run[0].paymentDay, run[run.length - 1].paymentDay])
    })
  }

  for (const [key, rows] of groupBy(payments.filter((p) => p.referenceNormalized !== null), (p) => invoiceKey(p)!)) {
    if (rows.length < 2) continue
    const invoiceAmounts = new Set(rows.map((p) => p.invoiceCents))
    if (invoiceAmounts.size !== 1) continue
    const [invoiceCents] = invoiceAmounts
    if (invoiceCents === null) continue
    const total = rows.reduce((sum, p) => sum + p.cents, 0)
    if (total <= invoiceCents) ctx.partialInvoices.add(key)
  }

  return ctx
}

function isVoided(p: PreparedRecord, ctx: LedgerContext): boolean {
  const key = invoiceKey(p)
  if (key && ctx.voidedInvoices.has(key)) return true
  const days = ctx.voidedUnreferenced.get(`${p.vendorKey}|${p.cents}`)
  return days !== undefined && days.some((day) => Math.abs(day - p.paymentDay) <= VOID_MATCH_DAYS)
}

/** The first deterministic reason this pair can never be a duplicate payment, or null. */
/**
 * `member` belongs to a recurring series and `other` is an unreferenced
 * same-supplier, same-amount payment inside that series' date span: an
 * off-cadence instalment of the same series rather than a second payment of
 * one bill. (Detection's near-duplicate rule still sees these pairs; the
 * matcher only declines to add them.)
 */
function offCadenceRecurring(member: PreparedRecord, other: PreparedRecord, ctx: LedgerContext): boolean {
  const series = ctx.recurringSeries.get(member.id)
  if (!series || ctx.recurringSeries.has(other.id)) return false
  if (other.referenceStrength === 'strong' || member.vendorKey !== other.vendorKey || member.cents !== other.cents) return false
  const span = ctx.recurringSpan.get(series)
  return span !== undefined && other.paymentDay >= span[0] && other.paymentDay <= span[1]
}

export function exclusionFor(a: PreparedRecord, b: PreparedRecord, ctx: LedgerContext): ExclusionReason | null {
  if ((a.externalTransactionId && a.externalTransactionId === b.externalTransactionId) || (a.identityKey && a.identityKey === b.identityKey)) {
    return 'same_source_transaction'
  }
  if (a.company && b.company && a.company !== b.company) return 'different_company'
  if (a.currency && b.currency && a.currency !== b.currency) return 'currency_mismatch'
  if (ctx.recurringSeries.has(a.id) && ctx.recurringSeries.has(b.id)) return 'recurring_series'
  if (offCadenceRecurring(a, b, ctx) || offCadenceRecurring(b, a, ctx)) return 'recurring_series'
  if (isVoided(a, ctx) || isVoided(b, ctx)) return 'voided_or_reversed'

  const smaller = Math.min(a.cents, b.cents)
  for (const key of new Set([invoiceKey(a), invoiceKey(b)])) {
    if (key && (ctx.refundCents.get(key) ?? 0) >= smaller) return 'refund_or_credit_offsets'
  }

  const keyA = invoiceKey(a)
  if (keyA && keyA === invoiceKey(b) && ctx.partialInvoices.has(keyA)) return 'partial_payments_within_invoice'
  if (a.invoiceCents !== null && a.invoiceCents === b.invoiceCents && a.cents + b.cents <= a.invoiceCents) {
    return 'partial_payments_within_invoice'
  }
  return null
}
