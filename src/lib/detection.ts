import type { APRecord, Finding, FindingClass, DetectionResult } from '../types.ts'
import { normalizeVendor, normalizeAccountLast4, daysBetween, parseTerms, formatCurrency, formatDate, plural, toCents, type ParsedTerms } from './format.ts'
import { normalizeReference, referenceKey, referenceStrength } from './sourceIdentity.ts'
import { nearIdenticalVendorNames } from './vendorResolution.ts'
import { reviewMetadata } from './findingMetadata.ts'

/** The review window for same-vendor, same-amount signals. It selects rows to review; it is not a recovery threshold. */
export const DEFAULT_REVIEW_WINDOW_DAYS = 45
/**
 * When neither payment carries a reference (card and cash purchases), vendor and
 * amount are all that link them, and a round amount at a shop the business uses
 * every few weeks repeats by chance. A double charge lands within days, so such
 * pairs are only matched inside this shorter window.
 */
export const NO_REFERENCE_WINDOW_DAYS = 14

/** A negative row with no reference is taken to undo a payment of exactly its amount made at most this long before it. */
export const REVERSAL_WINDOW_DAYS = 30
/**
 * A reference one vendor repeats on three or more dates names an account, a
 * lease or a purchase order rather than an invoice — unless the payments all
 * fall inside one short burst, which is what one invoice paid over and over
 * looks like. Four dates are no longer a burst once they spread over weeks.
 */
const REUSED_REFERENCE_MIN_DATES = 3
const REUSED_REFERENCE_BURST_DAYS = 45
const REUSED_REFERENCE_MANY_DATES = 4
const REUSED_REFERENCE_MANY_DATES_MIN_DAYS = 21

const EPSILON = 0.01
/**
 * Rule 2 treats three or more identically priced payments to one vendor on a
 * steady cadence (weekly standing orders, rent, subscriptions, retainers) as a
 * recurring charge rather than a run of duplicates. The cadence is the median
 * gap; it must be at least a few days (without invoice numbers, daily payments
 * are indistinguishable from a burst of duplicates), and a payment that lands
 * well inside the cadence is off-series and still assessed as a possible
 * duplicate. When every payment carries its own invoice number, each one was
 * billed separately, so a twice-weekly or daily standing order is a series too.
 */
const RECURRING_MIN_CADENCE_DAYS = 5
const INVOICED_RECURRING_MIN_CADENCE_DAYS = 1
const RECURRING_MAX_TOLERANCE_DAYS = 10
const RECURRING_ON_CADENCE_SHARE = 3 / 4
/**
 * A price paid to a vendor this many times or more with no reference and no
 * steady cadence (fuel fill-ups, postage, a usual coffee order) is routine:
 * two such payments within the window are expected, not a sign of a double
 * charge. A recurring series that explains most of the price's payments is
 * different: there, an extra off-schedule payment is still assessed.
 */
const ROUTINE_PRICE_MIN_PAYMENTS = 4
const ROUTINE_RECURRING_SHARE = 0.75
/**
 * Rule 8: references this short after normalization ("1007", "INV-9001")
 * come from simple sequential numbering, so two vendors share them by chance.
 * Such a shared number is only flagged when the vendors were also paid the
 * same amount on it.
 */
const DISTINCTIVE_REFERENCE_MIN_LENGTH = 6
/** A one-cent difference is rounding, not an overpayment. */
const OVERPAYMENT_MIN_CENTS = 2
/**
 * Rule 7 uses the median and the median absolute deviation, which one large
 * payment cannot drag towards itself the way it drags a mean and a standard
 * deviation. 3.5 is the usual cut-off for the resulting modified z-score; the
 * payment must also be at least three times the vendor's typical amount, so a
 * flat price with a small wobble, or one bigger order from a vendor whose order
 * sizes vary, is never an "outlier". Five payments is the least history the
 * median can stand on.
 */
const OUTLIER_MODIFIED_Z = 3.5
const OUTLIER_MIN_MULTIPLE = 3
const OUTLIER_MIN_PAYMENTS = 5

const centsToDollars = (cents: number) => cents / 100
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

const DAY_MS = 24 * 60 * 60 * 1000
const calendarDay = (d: Date) => Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS)

/** Transaction types that are not money paid to a vendor, whatever their sign: bills, credits, voids, journals. */
const NOT_A_PAYMENT = new Set([
  'void', 'voided', 'voided_payment', 'voided_check', 'void_payment', 'void_check', 'reversal', 'reversed', 'payment_reversal',
  'credit', 'credit_memo', 'credit_note', 'vendor_credit', 'supplier_credit', 'bill_credit', 'credit_card_credit',
  'refund', 'vendor_refund', 'supplier_refund', 'bill', 'vendor_bill', 'supplier_bill',
  'journal', 'journal_entry', 'general_journal', 'general_journal_entry', 'manual_journal', 'purchase_order', 'estimate', 'quote', 'opening_balance',
])
/** Types that say money (or the claim to it) came back. A negative row of any other type proves nothing by its sign alone. */
const REFUND_TYPES = new Set(['credit', 'credit_memo', 'credit_note', 'vendor_credit', 'supplier_credit', 'bill_credit', 'credit_card_credit', 'refund', 'vendor_refund', 'supplier_refund', 'chargeback'])
const REVERSAL_TYPES = new Set(['void', 'voided', 'voided_payment', 'voided_check', 'void_payment', 'void_check', 'reversal', 'reversed', 'payment_reversal', 'returned_payment', 'ach_return'])

const transactionKind = (r: APRecord) => r.transactionType?.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') ?? ''

/**
 * Credits, refunds, zero-dollar lines and rows whose type says they are not a
 * payment are never themselves a leak. They stay in the ledger (and net against
 * payments, see Returns) but no rule assesses them.
 */
function isPayment(r: APRecord): boolean {
  return r.amountPaid > 0 && !NOT_A_PAYMENT.has(transactionKind(r))
}

/** Zero or less is how exports say "not given"; it is not what the invoice was for. */
function knownInvoiceAmount(r: APRecord): number | null {
  return r.invoiceAmount !== null && r.invoiceAmount > 0 ? r.invoiceAmount : null
}

/** What the rules need to know about a row, worked out once per run. */
interface RowFacts {
  vendor: string
  cents: number
  day: number
  /** The reference as written, bar case and spacing: two rows with one key name the same invoice. */
  key: string
  /** The reference normalized, as rows are compared across spellings. Null when the cell is blank. */
  ref: string | null
  /** 'none' also for a reference this vendor reuses so widely that it cannot be an invoice number. */
  strength: 'none' | 'short' | 'strong'
  /** '' when the file does not say. */
  currency: string
  company: string
}
type Facts = (r: APRecord) => RowFacts

/** Known, different companies or currencies: the rows cannot be one economic event, and their amounts are never compared or added. */
function incompatible(a: RowFacts, b: RowFacts): boolean {
  return Boolean((a.company && b.company && a.company !== b.company) || (a.currency && b.currency && a.currency !== b.currency))
}

/** Splits rows by company and currency. Blanks go with the only value known; when there are several, blanks stand alone. */
function splitCompatible(rows: APRecord[], facts: Facts): APRecord[][] {
  const companies = new Set(rows.map((r) => facts(r).company).filter(Boolean))
  const currencies = new Set(rows.map((r) => facts(r).currency).filter(Boolean))
  if (companies.size <= 1 && currencies.size <= 1) return [rows]
  return [...groupBy(rows, (r) => `${companies.size > 1 ? facts(r).company : ''}|${currencies.size > 1 ? facts(r).currency : ''}`).values()]
}

/** Money in the rows' own currency; a file without one is read as dollars. */
function money(value: number, rows: APRecord[]): string {
  return formatCurrency(value, rows.find((r) => r.currency?.trim())?.currency)
}

/**
 * Which vendor each row belongs to: the source system's own ID when the row
 * has one, else the normalized name. A name that carries exactly one ID is that
 * vendor even on rows where the ID was left blank; a name that carries several
 * says nothing about which of them a blank row means.
 */
function vendorIdentities(records: APRecord[]): (r: APRecord) => string {
  const names = new Map<string, string>()
  const nameOf = (r: APRecord) => {
    let name = names.get(r.vendor)
    if (name === undefined) names.set(r.vendor, (name = `name:${normalizeVendor(r.vendor)}`))
    return name
  }
  const idOf = (r: APRecord): { system: string; id: string } | null => {
    const company = r.company?.trim().toLowerCase() ?? ''
    const stable = r.stableSupplierId?.trim().toLowerCase()
    if (stable) return { system: `supplier|${company}`, id: `supplier|${company}|${stable}` }
    return r.quickbooks?.vendorId ? { system: `qbo|${company}`, id: `qbo|${company}|${r.quickbooks.vendorId}` } : null
  }
  const idsByName = new Map<string, Map<string, Set<string>>>()
  for (const r of records) {
    const id = idOf(r)
    if (!id) continue
    let systems = idsByName.get(nameOf(r))
    if (!systems) idsByName.set(nameOf(r), (systems = new Map()))
    const ids = systems.get(id.system)
    if (ids) ids.add(id.id)
    else systems.set(id.system, new Set([id.id]))
  }
  const parent = new Map<string, string>()
  const find = (node: string): string => {
    let at = node
    while (parent.has(at)) at = parent.get(at)!
    return at
  }
  for (const [name, systems] of idsByName) {
    if ([...systems.values()].some((ids) => ids.size > 1)) continue
    for (const ids of systems.values()) {
      for (const id of ids) {
        const [a, b] = [find(name), find(id)]
        if (a !== b) parent.set(a, b)
      }
    }
  }
  return (r) => find(idOf(r)?.id ?? nameOf(r))
}

/**
 * Whether a reference this vendor used on these payments names one invoice.
 * Several payments of one invoice are instalments of an amount the rows agree
 * on, share one invoice date, or come in one short burst. Anything else used on
 * three or more dates (an account number, a lease, "Autopay 0425", a purchase
 * order on progress payments) is a label, and rows sharing it are unrelated
 * until the amount and date say otherwise.
 */
function namesOneInvoice(payments: APRecord[], facts: Facts): boolean {
  const days = new Set(payments.map((r) => facts(r).day))
  if (days.size < REUSED_REFERENCE_MIN_DATES) return true
  const invoiceDates = new Set(payments.map((r) => (r.invoiceDate ? calendarDay(r.invoiceDate) : null)))
  if (invoiceDates.size === 1 && !invoiceDates.has(null)) return true
  invoiceDates.delete(null)
  if (invoiceDates.size >= REUSED_REFERENCE_MIN_DATES) return false
  const agreed = agreedInvoiceAmount(payments)
  if (agreed !== null && payments.every((r) => facts(r).cents < toCents(agreed))) return true
  const amounts = new Set(payments.map((r) => facts(r).cents))
  if (agreed === null && amounts.size === payments.length) return false
  const span = Math.max(...days) - Math.min(...days)
  if (span > REUSED_REFERENCE_BURST_DAYS) return false
  return !(days.size >= REUSED_REFERENCE_MANY_DATES && span >= REUSED_REFERENCE_MANY_DATES_MIN_DAYS)
}

function buildFacts(records: APRecord[]): Facts {
  const identity = vendorIdentities(records)
  const facts = new Map<APRecord, RowFacts>()
  for (const r of records) {
    facts.set(r, {
      vendor: identity(r),
      cents: toCents(r.amountPaid),
      day: calendarDay(r.paymentDate),
      key: r.invoiceNumber === null ? '' : normalizeInvoiceNumber(r.invoiceNumber),
      ref: referenceKey(r.invoiceNumber),
      strength: referenceStrength(r.invoiceNumber),
      currency: r.currency?.trim().toUpperCase() ?? '',
      company: r.company?.trim().toLowerCase() ?? '',
    })
  }
  const of: Facts = (r) => facts.get(r)!
  const referenced = records.filter((r) => of(r).strength !== 'none')
  for (const shared of groupBy(referenced, (r) => `${of(r).vendor}|${of(r).ref}`).values()) {
    if (shared.length < REUSED_REFERENCE_MIN_DATES) continue
    for (const rows of splitCompatible(shared, of)) {
      if (!namesOneInvoice(rows.filter(isPayment), of)) rows.forEach((r) => (of(r).strength = 'none'))
    }
  }
  return of
}

interface ReturnEntry {
  row: APRecord
  typed: boolean
  cents: number
}

/**
 * Negative rows, and what each one gives back. A negative can be a reversal, a
 * correction, a discount or a credit, and its sign alone is not evidence of a
 * supplier refund, so it counts in only two ways:
 *
 * - A negative of exactly a payment's amount, on the same invoice (or, when
 *   neither row has a reference, shortly after the payment), undoes that
 *   payment. Whatever it was called, the pair moved no money, so no rule claims
 *   anything from it. This is also what an honest void-and-reissue looks like.
 * - What is left nets against the invoice when its type says so (refund,
 *   credit, void), or when it gives back exactly the amount in question.
 *
 * Every entry is consumed as it is drawn, so it is never counted twice. A
 * reversed payment makes no finding at all rather than one at $0: the evidence
 * gate treats the flagged amount as a ceiling, and zero would lift it.
 */
class Returns {
  /** Payments a negative row undid, by record id, and whether that row was a refund (money paid, then returned) or a void. */
  readonly undone = new Map<string, 'refund' | 'reversal'>()
  private readonly byInvoice = new Map<string, ReturnEntry[]>()
  private readonly unreferenced = new Map<string, ReturnEntry[]>()
  private readonly facts: Facts

  constructor(records: APRecord[], facts: Facts) {
    this.facts = facts
    const negatives = records.filter((r) => facts(r).cents < 0).sort((a, b) => facts(a).day - facts(b).day)
    if (negatives.length === 0) return
    const place = (r: APRecord) => (facts(r).strength === 'none' ? `${facts(r).vendor}|` : `${facts(r).vendor}|${facts(r).ref}`)
    const payments = groupBy(records.filter(isPayment), (r) => `${place(r)}|${facts(r).cents}`)
    for (const row of negatives) {
      const f = facts(row)
      const kind = transactionKind(row)
      const referenced = f.strength !== 'none'
      let best: APRecord | null = null
      let bestRank = -Infinity
      for (const payment of payments.get(`${place(row)}|${-f.cents}`) ?? []) {
        const p = facts(payment)
        const gap = f.day - p.day
        if (this.undone.has(payment.id) || incompatible(f, p)) continue
        if (!referenced && (gap < 0 || gap > REVERSAL_WINDOW_DAYS)) continue
        // The latest payment before the reversal, and the same spelling of the reference, first.
        const rank = (p.key === f.key ? 2e6 : 0) + (gap >= 0 ? 1e6 - gap : gap)
        if (rank > bestRank) [best, bestRank] = [payment, rank]
      }
      if (best) {
        this.undone.set(best.id, REFUND_TYPES.has(kind) ? 'refund' : 'reversal')
        continue
      }
      const entry: ReturnEntry = { row, typed: REFUND_TYPES.has(kind) || REVERSAL_TYPES.has(kind), cents: -f.cents }
      const [pool, key] = referenced ? [this.byInvoice, place(row)] : [this.unreferenced, f.vendor]
      const list = pool.get(key)
      if (list) list.push(entry)
      else pool.set(key, [entry])
    }
  }

  stands(r: APRecord): boolean {
    return !this.undone.has(r.id)
  }

  private open(payment: APRecord): ReturnEntry[] {
    const p = this.facts(payment)
    if (p.strength === 'none') return []
    return (this.byInvoice.get(`${p.vendor}|${p.ref}`) ?? []).filter((e) => e.cents > 0 && !incompatible(p, this.facts(e.row)))
  }

  /** Take up to `wantedCents` off what was given back against this payment's invoice, and return how much was taken. */
  draw(payment: APRecord, wantedCents: number): number {
    if (wantedCents <= 0) return 0
    const p = this.facts(payment)
    if (p.strength === 'none') {
      const match = (this.unreferenced.get(p.vendor) ?? []).find((e) => {
        const gap = this.facts(e.row).day - p.day
        return e.cents === wantedCents && gap >= 0 && gap <= REVERSAL_WINDOW_DAYS && !incompatible(p, this.facts(e.row))
      })
      if (!match) return 0
      match.cents = 0
      return wantedCents
    }
    const open = this.open(payment)
    let taken = 0
    for (const entry of open.filter((e) => e.typed)) {
      const share = Math.min(entry.cents, wantedCents - taken)
      entry.cents -= share
      taken += share
    }
    const rest = wantedCents - taken
    const untyped = open.filter((e) => !e.typed)
    if (rest > 0) {
      const exact = untyped.find((e) => e.cents === rest)
      const giving = exact ? [exact] : untyped.reduce((sum, e) => sum + e.cents, 0) === rest ? untyped : []
      for (const entry of giving) {
        taken += entry.cents
        entry.cents = 0
      }
    }
    return taken
  }

  /** A sentence about negative rows on this invoice that were not counted, or nothing. */
  note(payment: APRecord): string {
    const open = this.open(payment)
    if (open.length === 0) return ''
    const total = open.reduce((sum, e) => sum + e.cents, 0)
    return ` ${money(centsToDollars(total), [payment])} in negative rows is also recorded against this invoice and was not counted as money returned; check what ${open.length === 1 ? 'it was' : 'they were'}.`
  }
}

/** The invoice amount the rows agree on, or null when the file didn't say (or the rows disagree). */
function agreedInvoiceAmount(rows: APRecord[]): number | null {
  const amounts = new Set(rows.map((r) => (knownInvoiceAmount(r) === null ? null : toCents(r.invoiceAmount!))))
  if (amounts.size !== 1) return null
  const [only] = amounts
  return only === null ? null : only / 100
}

function normalizeInvoiceNumber(invoiceNumber: string): string {
  return invoiceNumber.toLowerCase().trim().replace(/\s+/g, ' ')
}

interface FindingWithImpactRows {
  finding: Finding
  /** Stable record ids this finding claims — used to resolve overlap between candidate findings. */
  impactRecordIds: string[]
}

function makeFinding(params: {
  id: string
  type: Finding['type']
  class: FindingClass
  severity: Finding['severity']
  vendor: string
  dollarImpact: number
  title: string
  explanation: string
  relatedRecords: APRecord[]
  ruleId?: string
}): Finding {
  // Money is reported, requested and recorded in whole cents; float residue never leaves the engine.
  return { ...params, dollarImpact: centsToDollars(toCents(params.dollarImpact)) }
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

/** Payments a stronger duplicate rule has already put a figure on, so no other one claims them again. */
interface Claimed {
  exact: Set<string>
  review: Set<string>
}

const byDate = (a: APRecord, b: APRecord) => a.paymentDate.getTime() - b.paymentDate.getTime()

// Rule 1 — Exact duplicate payment (recoverable, high)
function detectExactDuplicates(records: APRecord[], facts: Facts, returns: Returns): { findings: FindingWithImpactRows[]; claimed: Claimed } {
  const findings: FindingWithImpactRows[] = []
  const claimed: Claimed = { exact: new Set(), review: new Set() }

  const referenced = records.filter((r) => isPayment(r) && facts(r).strength !== 'none')
  const groups = [...groupBy(referenced, (r) => `${facts(r).vendor}|${facts(r).key}`).values()].flatMap((rows) => (rows.length < 2 ? [] : splitCompatible(rows, facts)))

  for (const group of groups) {
    const sorted = [...group].sort(byDate)
    const standing = sorted.filter((r) => returns.stands(r))
    if (standing.length < 2) continue
    // A one- or two-character reference ("1", a check number) is shared by
    // unrelated payments all the time. It ties rows to one invoice only when the
    // amount repeats too; rows with other amounts stay free for Rule 2.
    const shortReference = facts(sorted[0]).strength === 'short'
    const amountClusters = Array.from(groupBy(sorted, (r) => facts(r).cents.toString()).values()).map((rows) => ({
      cents: facts(rows[0]).cents,
      standing: rows.filter((r) => returns.stands(r)),
      // A voided payment never left the account. One that was refunded did, and stays in the evidence.
      shown: rows.filter((r) => returns.undone.get(r.id) !== 'reversal'),
    }))

    const invoiceNumber = sorted[0].invoiceNumber
    const vendor = sorted[0].vendor
    const totalPaidCents = standing.reduce((sum, r) => sum + facts(r).cents, 0)
    const invoiceAmount = agreedInvoiceAmount(standing)

    // Instalments: several payments that together come to no more than the
    // invoice are how the invoice was paid, not a duplicate of it.
    if (invoiceAmount !== null && totalPaidCents <= toCents(invoiceAmount)) continue
    // The most that can have leaked from this invoice is what went out beyond
    // it (when we know it). Every finding on the invoice draws from that one
    // budget, and from one pool of refunds already booked against it — two
    // duplicated amounts must never claim the same overshoot twice.
    let budgetCents = invoiceAmount === null ? Infinity : totalPaidCents - toCents(invoiceAmount)

    const duplicateClusters = amountClusters
      .filter((cluster) => cluster.standing.length > 1)
      .sort((a, b) => b.cents * (b.standing.length - 1) - a.cents * (a.standing.length - 1))
    const singlePaymentRows = amountClusters.filter((cluster) => cluster.standing.length === 1).flatMap((cluster) => cluster.standing)

    for (const { cents, standing: cluster, shown } of duplicateClusters) {
      const duplicateRows = cluster.slice(1)
      duplicateRows.forEach((r) => claimed.exact.add(r.id))
      const extraCents = duplicateRows.length * cents
      const grossCents = Math.min(extraCents, budgetCents)
      budgetCents -= grossCents
      const netCents = grossCents - returns.draw(cluster[0], grossCents)
      if (netCents <= 0) continue
      const dollarImpact = centsToDollars(netCents)
      const refundedCents = grossCents - netCents + (shown.length - cluster.length) * cents
      const refundNote = refundedCents > 0 ? ` ${money(centsToDollars(refundedCents), shown)} has already been credited back, leaving` : ''
      findings.push({
        finding: makeFinding({
          id: `exact_duplicate-${shown.map((r) => r.id).join('-')}`,
          ruleId: 'exact_repeated_payment_v1',
          type: 'exact_duplicate',
          class: 'recoverable',
          severity: 'high',
          vendor,
          dollarImpact,
          title: `Duplicate payment of invoice ${invoiceNumber}`,
          explanation: `Invoice ${invoiceNumber} from ${vendor} was paid ${shown.length} times at ${money(
            cluster[0].amountPaid, shown
          )}.${refundNote} ${money(dollarImpact, shown)} across ${duplicateRows.length} extra ${plural(duplicateRows.length, 'payment')} is flagged for review.${returns.note(cluster[0])} The ledger rows alone do not prove separate settled payments or money owed.`,
          relatedRecords: shown,
        }),
        impactRecordIds: duplicateRows.map((r) => r.id),
      })
    }

    if (singlePaymentRows.length > 0 && !shortReference) {
      const firstDay = facts(standing[0]).day
      // Several different amounts on the day the invoice was first paid are the lines of one
      // payment split across accounts. Only an agreed invoice amount can show they came to too much.
      const splitLines = invoiceAmount === null && standing.filter((r) => facts(r).day === firstDay).length > 1
      const reviewRows = (duplicateClusters.length > 0 ? singlePaymentRows : standing.slice(1)).filter((r) => !splitLines || facts(r).day !== firstDay)
      const reviewCents = reviewRows.reduce((sum, r) => sum + facts(r).cents, 0)
      const grossCents = Math.min(reviewCents, budgetCents)
      budgetCents -= grossCents
      const netCents = grossCents - returns.draw(standing[0], grossCents)
      if (netCents <= 0) continue
      reviewRows.forEach((r) => claimed.review.add(r.id))
      const dollarImpact = centsToDollars(netCents)
      const overInvoice = invoiceAmount === null ? '' : ` ${money(centsToDollars(totalPaidCents), standing)} was paid in total against a ${money(invoiceAmount, standing)} invoice.`
      findings.push({
        finding: makeFinding({
          id: `repeated_invoice_review-${standing.map((r) => r.id).join('-')}`,
          ruleId: 'repeated_invoice_review_v1',
          type: 'exact_duplicate',
          class: 'review',
          severity: 'medium',
          vendor,
          dollarImpact,
          title: `Repeated payments for invoice ${invoiceNumber}`,
          explanation: `Invoice ${invoiceNumber} from ${vendor} appears in payments with different amounts.${overInvoice} Review ${money(
            dollarImpact, standing
          )} of additional payment activity before treating it as a potential duplicate.${returns.note(standing[0])}`,
          relatedRecords: standing,
        }),
        impactRecordIds: reviewRows.map((r) => r.id),
      })
    }
  }

  return { findings, claimed }
}

/**
 * The recurring series for this vendor, each as its on-cadence rows: three or more
 * payments of the same amount on a steady cadence, no two sharing an invoice
 * number (the second of two that do is off-series). Rows without a reference
 * count (card and check purchases rarely carry one). One vendor can have several
 * such series (two subscriptions).
 *
 * The cadence is the median gap. Walking the series in date order, a payment
 * that arrives well before the next one is due is off-series — that is what a
 * duplicate slipped into a standing order looks like — and is left out, so it
 * is still assessed against its neighbours. A longer gap (a skipped week) keeps
 * the series going. If too little of the series keeps to the cadence, none of
 * it is treated as recurring.
 */
function recurringRuns(sortedByDate: APRecord[], facts: Facts): APRecord[][] {
  const runs: APRecord[][] = []
  const byAmount = groupBy(sortedByDate, (r) => facts(r).cents.toString())
  for (const sameAmount of byAmount.values()) {
    const references = new Set<string>()
    const series = sameAmount.filter((r) => {
      const { strength, ref } = facts(r)
      if (strength === 'none') return true
      if (references.has(ref!)) return false
      references.add(ref!)
      return true
    })
    if (series.length < 3) continue
    const gaps: number[] = []
    for (let i = 1; i < series.length; i++) gaps.push(daysBetween(series[i - 1].paymentDate, series[i].paymentDate))
    const cadence = median(gaps)
    const everyRowInvoiced = series.every((r) => facts(r).strength === 'strong')
    if (cadence < (everyRowInvoiced ? INVOICED_RECURRING_MIN_CADENCE_DAYS : RECURRING_MIN_CADENCE_DAYS)) continue
    const tolerance = Math.min(RECURRING_MAX_TOLERANCE_DAYS, Math.max(2, Math.floor(cadence * 0.35)))

    const onCadence = [series[0]]
    for (const r of series.slice(1)) {
      const gap = daysBetween(onCadence[onCadence.length - 1].paymentDate, r.paymentDate)
      if (gap >= cadence - tolerance) onCadence.push(r)
    }
    if (onCadence.length < 3 || onCadence.length < Math.ceil(series.length * 0.6)) continue
    // Most steps must actually land on the cadence. Frequent irregular payments of one
    // price (fuel fill-ups) clear the "not early" test above by chance, but their gaps
    // scatter; a real schedule's gaps cluster, with only the odd skipped week.
    const steps = onCadence.slice(1).map((r, i) => daysBetween(onCadence[i].paymentDate, r.paymentDate))
    if (steps.filter((gap) => Math.abs(gap - cadence) <= tolerance).length < Math.ceil(steps.length * RECURRING_ON_CADENCE_SHARE)) continue
    runs.push(onCadence)
  }
  return runs
}

/**
 * A run of payments recognised as a recurring charge and therefore not flagged
 * as near-duplicates of each other. Plain JSON (no Date objects) so it survives
 * saving and reloading an audit.
 */
export interface RecurringSeries {
  vendor: string
  amount: number
  /** The rows' currency when they agree, else null. */
  currency: string | null
  /** Median days between payments. */
  cadenceDays: number
  paymentCount: number
  /** Local calendar dates, YYYY-MM-DD. */
  firstPaymentDate: string
  lastPaymentDate: string
  recordIds: string[]
}

export type DetectionResultWithRecurring = DetectionResult & { recurringSeries: RecurringSeries[] }

/** Recurring series on a detection result; [] for audits saved before the field existed. */
export function recurringSeriesOf(result: DetectionResult): RecurringSeries[] {
  const series = (result as Partial<DetectionResultWithRecurring>).recurringSeries
  return Array.isArray(series) ? series : []
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function toRecurringSeries(rows: APRecord[]): RecurringSeries {
  const currencies = new Set(rows.map((r) => r.currency ?? null))
  // Measured over the series itself, so an off-series extra payment doesn't skew it.
  const gaps = rows.slice(1).map((r, i) => daysBetween(rows[i].paymentDate, r.paymentDate))
  return {
    vendor: rows[0].vendor,
    amount: centsToDollars(toCents(rows[0].amountPaid)),
    currency: currencies.size === 1 ? [...currencies][0] : null,
    cadenceDays: median(gaps),
    paymentCount: rows.length,
    firstPaymentDate: localDate(rows[0].paymentDate),
    lastPaymentDate: localDate(rows[rows.length - 1].paymentDate),
    recordIds: rows.map((r) => r.id),
  }
}

/** Payments, by record id, of a price this vendor is routinely paid with no reference and no steady cadence. */
function routinePayments(sortedByDate: APRecord[], recurring: Set<string>, facts: Facts): Set<string> {
  const routine = new Set<string>()
  const unreferenced = groupBy(sortedByDate.filter((r) => facts(r).strength === 'none'), (r) => facts(r).cents.toString())
  for (const rows of unreferenced.values()) {
    if (rows.length < ROUTINE_PRICE_MIN_PAYMENTS) continue
    const onSchedule = rows.filter((r) => recurring.has(r.id)).length
    if (onSchedule >= rows.length * ROUTINE_RECURRING_SHARE) continue
    rows.forEach((r) => routine.add(r.id))
  }
  return routine
}

// Rule 2 — invoice_reference_variant_v1 and same_vendor_amount_near_duplicate_v1 (review signals only)
function detectNearDuplicates(
  records: APRecord[],
  facts: Facts,
  returns: Returns,
  claimed: Claimed,
  windowDays = DEFAULT_REVIEW_WINDOW_DAYS
): { findings: FindingWithImpactRows[]; recurringSeries: RecurringSeries[] } {
  const findings: FindingWithImpactRows[] = []
  const recurringSeries: RecurringSeries[] = []
  // A row Rule 1 called an extra copy explains nothing about its neighbours. Any other payment can
  // be the earlier half of a pair; one that already has a figure on it is never the later half.
  const eligible = records.filter((r) => isPayment(r) && returns.stands(r) && !claimed.exact.has(r.id))

  for (const group of groupBy(eligible, (r) => facts(r).vendor).values()) {
    const sorted = [...group].sort(byDate)
    const recurring = new Set<string>()
    const routine = new Set<string>()
    const scheduledPrices = new Set<number>()
    for (const rows of splitCompatible(sorted.filter((r) => !claimed.review.has(r.id)), facts)) {
      const runs = recurringRuns(rows, facts)
      recurringSeries.push(...runs.map(toRecurringSeries))
      const inRuns = new Set(runs.flatMap((run) => run.map((r) => r.id)))
      inRuns.forEach((id) => recurring.add(id))
      runs.forEach((run) => scheduledPrices.add(facts(run[0]).cents))
      routinePayments(rows, inRuns, facts).forEach((id) => routine.add(id))
    }

    const pairWindow = (a: RowFacts, b: RowFacts) => {
      if (a.strength !== 'none' || b.strength !== 'none') return windowDays
      // An extra payment beside a schedule, carrying the schedule's own label ("Rent", the account number).
      if (a.ref !== null && a.ref === b.ref && scheduledPrices.has(b.cents)) return windowDays
      return Math.min(windowDays, NO_REFERENCE_WINDOW_DAYS)
    }

    const earlierByAmount = new Map<number, APRecord[]>()
    // Two payments of a routine price are never a pair, so a routine payment looks only at the others.
    const earlierNotRoutine = new Map<number, APRecord[]>()
    const earlierByReference = new Map<string, APRecord[]>()
    for (const later of sorted) {
      const l = facts(later)
      const sameAmount = (routine.has(later.id) ? earlierNotRoutine : earlierByAmount).get(l.cents) ?? []
      const sameReference = l.strength === 'strong' ? (earlierByReference.get(`${l.cents}|${l.ref}`) ?? []) : []

      // A payment that keeps to a recurring cadence is the series, never the suspect. An
      // off-series payment always has an earlier row to be matched against, so it is
      // flagged once rather than again by every later payment in the series.
      if (!recurring.has(later.id) && !claimed.review.has(later.id)) {
        // A reference variant is the stronger signal, however far apart the payments are;
        // otherwise the nearest same-amount payment in the window.
        const nearestOf = (candidates: APRecord[], accepts: (e: RowFacts, gap: number) => boolean, maxGap: number): APRecord | null => {
          let found: APRecord | null = null
          let foundGap = Infinity
          for (let j = candidates.length - 1; j >= 0; j--) {
            const e = facts(candidates[j])
            const gap = l.day - e.day
            if (gap > maxGap || gap > foundGap) break
            if (incompatible(e, l) || !accepts(e, gap)) continue
            found = candidates[j]
            foundGap = gap
          }
          return found
        }
        const variant = nearestOf(sameReference, (e) => e.key !== l.key, Infinity)
        const match =
          variant ??
          nearestOf(
            sameAmount,
            (e, gap) => {
              if (e.strength !== 'none' && e.key === l.key) return false
              if (l.strength === 'strong' && e.strength === 'strong' && e.ref === l.ref) return false
              return gap <= pairWindow(e, l)
            },
            windowDays
          )
        const refunded = match ? returns.draw(later, l.cents) : 0
        const netCents = match ? l.cents - refunded - returns.draw(match, l.cents - refunded) : 0
        if (match && netCents > 0) {
          const gap = l.day - facts(match).day
          const pair = [match, later]
          const refs = (r: APRecord) => r.invoiceNumber ?? 'no invoice reference'
          const refundNote = netCents < l.cents ? ` ${money(centsToDollars(l.cents - netCents), pair)} has already been credited back, leaving ${money(centsToDollars(netCents), pair)}.` : ''
          findings.push({
            finding: makeFinding({
              id: `${variant ? 'near_duplicate' : 'same_amount'}-${match.id}-${later.id}`,
              ruleId: variant ? 'invoice_reference_variant_v1' : 'same_vendor_amount_near_duplicate_v1',
              type: 'near_duplicate',
              class: 'review',
              severity: variant ? 'medium' : 'low',
              vendor: later.vendor,
              dollarImpact: centsToDollars(netCents),
              title: variant ? `Invoice reference variant: ${later.vendor}` : `Same vendor and amount: ${later.vendor}`,
              explanation: variant
                ? `${later.vendor} was paid ${money(later.amountPaid, pair)} for invoice ${match.invoiceNumber} and again for invoice ${later.invoiceNumber}, ${gap} ${plural(gap, 'day')} apart.${refundNote} The references are the same once spacing, punctuation, an invoice prefix and leading zeros are set aside. A similar reference is not proof of a duplicate payment.`
                : `${later.vendor} was paid ${money(later.amountPaid, pair)} twice within ${pairWindow(facts(match), l)} days (${refs(match)} and ${refs(later)}, ${formatDate(later.paymentDate)}), ${gap} ${plural(gap, 'day')} apart.${refundNote} The date window only selects these rows for review; it does not establish that anything is owed.`,
              relatedRecords: pair,
            }),
            impactRecordIds: [later.id],
          })
        }
      }

      const remember = <K>(index: Map<K, APRecord[]>, key: K) => {
        const list = index.get(key)
        if (list) list.push(later)
        else index.set(key, [later])
      }
      remember(earlierByAmount, l.cents)
      if (!routine.has(later.id)) remember(earlierNotRoutine, l.cents)
      if (l.strength === 'strong') remember(earlierByReference, `${l.cents}|${l.ref}`)
    }
  }

  return { findings, recurringSeries }
}

/**
 * Rule 2, across vendor records — cross_vendor_duplicate_v1. The classic way a
 * duplicate gets past an accounting system's own check: one supplier set up
 * twice, under a misspelt name or two supplier IDs, and one invoice paid from
 * each. The same amount on the same reference under near-identical names is
 * reported at what was paid beyond one payment. `sameVendor` tells Rule 8 which
 * vendors on a reference this has already accounted for.
 */
function detectCrossVendorDuplicates(records: APRecord[], facts: Facts, returns: Returns, claimed: Claimed): { findings: FindingWithImpactRows[]; sameVendor: (r: APRecord) => string } {
  const findings: FindingWithImpactRows[] = []
  const aliases = new Map<string, string>()
  const strong = records.filter((r) => isPayment(r) && returns.stands(r) && facts(r).strength === 'strong')

  for (const sharing of groupBy(strong, (r) => `${facts(r).ref}|${facts(r).cents}`).values()) {
    if (sharing.length < 2) continue
    for (const rows of splitCompatible(sharing, facts)) {
      // One payment per vendor record: repeats inside one record are Rule 1's.
      const firstPerVendor = [...groupBy([...rows].sort(byDate), (r) => facts(r).vendor).values()].map((own) => own[0])
      if (firstPerVendor.length < 2) continue
      const clusters: APRecord[][] = []
      for (const r of firstPerVendor) {
        const home = clusters.find((cluster) => cluster.some((other) => nearIdenticalVendorNames(other.vendor, r.vendor)))
        if (home) home.push(r)
        else clusters.push([r])
      }
      for (const cluster of clusters) {
        if (cluster.length < 2) continue
        const { ref, vendor } = facts(cluster[0])
        cluster.slice(1).forEach((r) => aliases.set(`${ref}|${facts(r).vendor}`, vendor))
        // A payment Rule 1 already has a figure on is the one kept here, and is not counted again.
        const alreadyClaimed = (r: APRecord) => claimed.exact.has(r.id) || claimed.review.has(r.id)
        const kept = cluster.find(alreadyClaimed) ?? cluster[0]
        const extra = cluster.filter((r) => r !== kept && !alreadyClaimed(r))
        let netCents = extra.reduce((sum, r) => sum + facts(r).cents, 0)
        for (const r of cluster) netCents -= returns.draw(r, netCents)
        if (netCents <= 0) continue
        extra.forEach((r) => claimed.review.add(r.id))
        const last = cluster[cluster.length - 1]
        const names = [...new Set(cluster.map((r) => r.vendor))]
        const under = names.length > 1 ? `under ${cluster.length} vendor names (${names.join(', ')})` : `under ${cluster.length} vendor records named ${names[0]}`
        findings.push({
          finding: makeFinding({
            id: `cross_vendor_duplicate-${cluster.map((r) => r.id).join('-')}`,
            ruleId: 'cross_vendor_duplicate_v1',
            type: 'near_duplicate',
            class: 'review',
            severity: 'medium',
            vendor: last.vendor,
            dollarImpact: centsToDollars(netCents),
            title: `Invoice ${last.invoiceNumber} paid under two vendor records`,
            explanation: `Invoice ${last.invoiceNumber} was paid at ${money(last.amountPaid, cluster)} ${under}. If they are one supplier entered twice, ${money(
              centsToDollars(netCents), cluster
            )} went out beyond one payment. Near-identical names are not proof of one supplier; check the vendor records first.`,
            relatedRecords: cluster,
          }),
          impactRecordIds: extra.map((r) => r.id),
        })
      }
    }
  }

  return { findings, sameVendor: (r) => aliases.get(`${facts(r).ref}|${facts(r).vendor}`) ?? facts(r).vendor }
}

// Rule 3 — Overpayment vs invoice (recoverable, high)
function detectOverpayments(payments: APRecord[], returns: Returns): FindingWithImpactRows[] {
  const findings: FindingWithImpactRows[] = []

  for (const r of payments) {
    const invoiceAmount = knownInvoiceAmount(r)
    if (invoiceAmount === null) continue
    const overCents = toCents(r.amountPaid) - toCents(invoiceAmount)
    if (overCents >= OVERPAYMENT_MIN_CENTS) {
      // A refund already booked against this invoice has given some (or all) of it back.
      const refundedCents = returns.draw(r, overCents)
      if (overCents - refundedCents < OVERPAYMENT_MIN_CENTS) continue
      const dollarImpact = centsToDollars(overCents - refundedCents)
      findings.push({
        finding: makeFinding({
          id: `overpayment-${r.id}`,
          type: 'overpayment',
          class: 'recoverable',
          severity: 'high',
          vendor: r.vendor,
          dollarImpact,
          title: `Overpayment on invoice ${r.invoiceNumber ?? 'unknown'}`,
          explanation: `Invoice ${r.invoiceNumber ?? 'unknown'} from ${r.vendor} was for ${money(
            invoiceAmount, [r]
          )}, but ${money(r.amountPaid, [r])} was paid — an overpayment of ${money(centsToDollars(overCents), [r])}.${
            refundedCents > 0 ? ` ${money(centsToDollars(refundedCents), [r])} has already been credited back, leaving ${money(dollarImpact, [r])}.` : ''
          }${returns.note(r)}`,
          relatedRecords: [r],
        }),
        impactRecordIds: [r.id],
      })
    }
  }

  return findings
}

/** The discount in whole cents, rounded half-up on the cent value itself (24.685 → 24.69, not float-truncated to 24.68). */
function discountValue(invoiceAmount: number, discountPct: number): number {
  return centsToDollars(Math.round((toCents(invoiceAmount) * discountPct) / 100))
}

/** The last day the discount can still have been open. "EOM" may start the window at the end of the invoice's month, so it is only surely over after that. */
function discountDeadline(invoiceDate: Date, terms: ParsedTerms): Date {
  return terms.endOfMonth
    ? new Date(invoiceDate.getFullYear(), invoiceDate.getMonth() + 1, terms.discountDays)
    : new Date(invoiceDate.getFullYear(), invoiceDate.getMonth(), invoiceDate.getDate() + terms.discountDays)
}

// Rule 4 — Unclaimed early-payment discount (recoverable, medium)
function detectUnclaimedDiscounts(payments: APRecord[]): FindingWithImpactRows[] {
  const findings: FindingWithImpactRows[] = []

  for (const r of payments) {
    const terms = parseTerms(r.terms)
    const invoiceAmount = knownInvoiceAmount(r)
    if (!terms || r.invoiceDate === null || invoiceAmount === null) continue

    const daysToPay = daysBetween(r.invoiceDate, r.paymentDate)
    // Paid before the invoice was even dated: the dates are wrong, and a claim built on them would be too.
    const paidInWindow = daysToPay >= 0 && daysToPay <= terms.discountDays
    const paidFull = r.amountPaid >= invoiceAmount - EPSILON

    if (paidInWindow && paidFull) {
      const dollarImpact = discountValue(invoiceAmount, terms.discountPct)
      findings.push({
        finding: makeFinding({
          id: `unclaimed_discount-${r.id}`,
          type: 'unclaimed_discount',
          class: 'recoverable',
          severity: 'medium',
          vendor: r.vendor,
          dollarImpact,
          title: `Unclaimed early-payment discount on invoice ${r.invoiceNumber ?? 'unknown'}`,
          explanation: `Terms of ${r.terms} entitled ${r.vendor} invoice ${
            r.invoiceNumber ?? 'unknown'
          } to a ${terms.discountPct}% discount for paying within ${terms.discountDays} days. Payment was made ${daysToPay} ${plural(daysToPay, 'day')} after the invoice date but at full price, leaving ${money(
            dollarImpact, [r]
          )} of eligible discount unclaimed.`,
          relatedRecords: [r],
        }),
        impactRecordIds: [r.id],
      })
    }
  }

  return findings
}

// Rule 5 — Missed early-payment discount (opportunity, low)
function detectMissedDiscounts(payments: APRecord[]): Finding[] {
  const findings: Finding[] = []

  for (const r of payments) {
    const terms = parseTerms(r.terms)
    const invoiceAmount = knownInvoiceAmount(r)
    if (!terms || r.invoiceDate === null || invoiceAmount === null) continue

    const daysToPay = daysBetween(r.invoiceDate, r.paymentDate)
    // Paying the discounted amount late means the vendor honoured the discount
    // anyway — nothing was lost, so there is nothing to change next time.
    const paidFull = r.amountPaid >= invoiceAmount - EPSILON
    if (daysBetween(discountDeadline(r.invoiceDate, terms), r.paymentDate) > 0 && paidFull) {
      const dollarImpact = discountValue(invoiceAmount, terms.discountPct)
      findings.push(
        makeFinding({
          id: `missed_discount-${r.id}`,
          type: 'missed_discount',
          class: 'opportunity',
          severity: 'low',
          vendor: r.vendor,
          dollarImpact,
          title: `Missed early-payment discount on invoice ${r.invoiceNumber ?? 'unknown'}`,
          explanation: `Terms of ${r.terms} offered a ${terms.discountPct}% discount for paying within ${
            terms.discountDays
          } days${terms.endOfMonth ? ' (counted from the end of the invoice month)' : ''}, but invoice ${r.invoiceNumber ?? 'unknown'} from ${r.vendor} was paid ${daysToPay} ${plural(daysToPay, 'day')} after the invoice date. Paying earlier next time would save ${money(
            dollarImpact, [r]
          )}.`,
          relatedRecords: [r],
        })
      )
    }
  }

  return findings
}

// Rule 6 — Vendor bank-account change (review, high)
function detectBankAccountChanges(records: APRecord[], facts: Facts): Finding[] {
  const findings: Finding[] = []
  const groups = groupBy(
    records.filter((r) => isPayment(r) && normalizeAccountLast4(r.bankAccountLast4) !== null),
    (r) => facts(r).vendor
  )

  for (const group of groups.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => a.paymentDate.getTime() - b.paymentDate.getTime())

    // Only an account this vendor has never been paid at before is a change
    // worth verifying; switching back to a known account is not new risk.
    let previous = sorted[0]
    const seen = new Set([normalizeAccountLast4(previous.bankAccountLast4)])
    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i]
      const account = normalizeAccountLast4(current.bankAccountLast4)
      if (!seen.has(account)) {
        seen.add(account)
        findings.push(
          makeFinding({
            id: `bank_account_change-${current.id}`,
            type: 'bank_account_change',
            class: 'review',
            severity: 'high',
            vendor: current.vendor,
            dollarImpact: current.amountPaid,
            title: `Bank account changed for ${current.vendor}`,
            explanation: `${current.vendor}'s deposit account changed from account ending ${normalizeAccountLast4(
              previous.bankAccountLast4
            )} to account ending ${account}, an account not paid before, on ${formatDate(
              current.paymentDate
            )}, when ${money(
              current.amountPaid, [current]
            )} was paid. Bank-account changes are a common payment-fraud vector — verify the new account with the vendor by phone before further payments.`,
            relatedRecords: [previous, current],
          })
        )
      }
      previous = current
    }
  }

  return findings
}

// Rule 7 — Payment amount outlier (review, medium)
function detectAmountOutliers(payments: APRecord[], facts: Facts): Finding[] {
  const findings: Finding[] = []
  const groups = [...groupBy(payments, (r) => facts(r).vendor).values()].flatMap((rows) => splitCompatible(rows, facts))

  for (const group of groups) {
    if (group.length < OUTLIER_MIN_PAYMENTS) continue

    const amounts = group.map((r) => r.amountPaid)
    const typical = median(amounts)
    const mad = median(amounts.map((a) => Math.abs(a - typical)))
    // 1.4826 scales the MAD to a standard deviation for normally distributed amounts.
    const spread = 1.4826 * mad
    if (typical <= 0) continue

    for (const r of group) {
      const farAboveSpread = spread === 0 ? r.amountPaid > typical : (r.amountPaid - typical) / spread > OUTLIER_MODIFIED_Z
      if (farAboveSpread && r.amountPaid >= typical * OUTLIER_MIN_MULTIPLE) {
        const dollarImpact = r.amountPaid - typical
        findings.push(
          makeFinding({
            id: `amount_outlier-${r.id}`,
            type: 'amount_outlier',
            class: 'review',
            severity: 'medium',
            vendor: r.vendor,
            dollarImpact,
            title: `Unusually large payment to ${r.vendor}`,
            explanation: `${r.vendor} was paid ${money(
              r.amountPaid, [r]
            )} on ${formatDate(r.paymentDate)}, well above this vendor's typical payment of ${money(
              typical, [r]
            )} (the median of ${group.length} payments). This may be a pricing or keying error — pull the contract or PO to confirm.`,
            relatedRecords: [r],
          })
        )
      }
    }
  }

  return findings
}

// Rule 8 — Invoice number reused across different vendors (review, high)
function detectSharedInvoiceNumbers(payments: APRecord[], facts: Facts, vendorOf: (r: APRecord) => string): Finding[] {
  const findings: Finding[] = []
  // Two vendors both using "1" or "12" is coincidence, not a vendor-identity question.
  const withInvoice = payments.filter((r) => facts(r).strength === 'strong')
  const groups = [...groupBy(withInvoice, (r) => facts(r).key).values()].flatMap((rows) => (rows.length < 2 ? [] : splitCompatible(rows, facts)))

  for (const group of groups) {
    const vendorsInGroup = groupBy(group, vendorOf)
    if (vendorsInGroup.size < 2) continue
    const distinctive = (normalizeReference(group[0].invoiceNumber).value ?? '').length >= DISTINCTIVE_REFERENCE_MIN_LENGTH
    if (!distinctive) {
      const vendorsByAmount = groupBy(group, (r) => facts(r).cents.toString())
      const sharedAmount = [...vendorsByAmount.values()].some((rows) => new Set(rows.map(vendorOf)).size > 1)
      if (!sharedAmount) continue
    }

    const sorted = [...group].sort((a, b) => a.paymentDate.getTime() - b.paymentDate.getTime())
    const names = new Set(sorted.map((r) => r.vendor))
    const vendorNames = [...names].join(', ')
    const dollarImpact = centsToDollars(sorted.reduce((sum, r) => sum + facts(r).cents, 0))

    findings.push(
      makeFinding({
        id: `shared_invoice_number-${sorted.map((r) => r.id).join('-')}`,
        type: 'shared_invoice_number',
        class: 'review',
        severity: 'high',
        vendor: vendorNames,
        dollarImpact,
        title: `Invoice ${sorted[0].invoiceNumber} used by more than one vendor`,
        explanation: `Invoice number ${sorted[0].invoiceNumber} appears on payments to ${vendorsInGroup.size} ${names.size < vendorsInGroup.size ? 'separate vendor records' : 'different vendors'} (${vendorNames}), totaling ${money(
          dollarImpact, sorted
        )}. That's either a coincidental numbering overlap or a data-entry/vendor-identity issue worth confirming before treating either payment as routine.`,
        relatedRecords: sorted,
      })
    )
  }

  return findings
}

/** Keep the higher-dollar finding when a record is claimed by more than one recoverable finding. */
function dedupeRecoverable(candidates: FindingWithImpactRows[]): Finding[] {
  const sorted = [...candidates].sort((a, b) => b.finding.dollarImpact - a.finding.dollarImpact)
  const claimed = new Set<string>()
  const kept: Finding[] = []

  for (const candidate of sorted) {
    const overlaps = candidate.impactRecordIds.some((id) => claimed.has(id))
    if (overlaps) continue
    candidate.impactRecordIds.forEach((id) => claimed.add(id))
    kept.push(candidate.finding)
  }

  return kept
}

const SEVERITY_RANK: Record<Finding['severity'], number> = { high: 0, medium: 1, low: 2 }

export function detectFindings(records: APRecord[]): DetectionResultWithRecurring {
  const facts = buildFacts(records)
  const returns = new Returns(records, facts)
  /** Money that went out and, as far as the ledger shows, stayed out. */
  const payments = records.filter((r) => isPayment(r) && returns.stands(r))

  // In this order, because each draws on what is left of the same returns.
  const { findings: exactDuplicates, claimed } = detectExactDuplicates(records, facts, returns)
  const overpayments = detectOverpayments(payments, returns)
  const { findings: crossVendorDuplicates, sameVendor } = detectCrossVendorDuplicates(records, facts, returns, claimed)
  const { findings: nearDuplicates, recurringSeries } = detectNearDuplicates(records, facts, returns, claimed)
  const unclaimedDiscounts = detectUnclaimedDiscounts(payments)

  const recoveryCandidates = [...exactDuplicates, ...overpayments, ...unclaimedDiscounts].filter(
    (candidate) => candidate.finding.class === 'recoverable'
  )
  const reviewCandidates = [...exactDuplicates, ...nearDuplicates, ...crossVendorDuplicates].filter((candidate) => candidate.finding.class === 'review')
  const recoverableFindings = dedupeRecoverable(recoveryCandidates)

  const missedDiscounts = detectMissedDiscounts(payments)
  // A voided payment to a new account is still a new account: someone entered it.
  const bankAccountChanges = detectBankAccountChanges(records, facts)
  const amountOutliers = detectAmountOutliers(payments, facts)
  const sharedInvoiceNumbers = detectSharedInvoiceNumbers(payments, facts, sameVendor)

  const findings = [
    ...recoverableFindings,
    ...reviewCandidates.map((candidate) => candidate.finding),
    ...missedDiscounts,
    ...bankAccountChanges,
    ...amountOutliers,
    ...sharedInvoiceNumbers,
  ]
    // Every rule's output is a review signal, a security alert or a future saving.
    // Only the evidence gate promotes one to a recovery candidate.
    .map((f) => reviewMetadata(f))
    .sort(
    (a, b) => {
      const severityDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
      if (severityDiff !== 0) return severityDiff
      return b.dollarImpact - a.dollarImpact
    }
  )

  // One figure can only be one currency: dollars, unless the whole ledger is in another one.
  const currencyOf = (f: Finding) => f.relatedRecords.find((r) => r.currency?.trim())?.currency!.trim().toUpperCase() ?? 'USD'
  const currencies = new Set(findings.map(currencyOf))
  const totalled = currencies.size > 1 ? 'USD' : [...currencies][0]
  const sumBy = (cls: FindingClass) =>
    centsToDollars(findings.filter((f) => f.class === cls && currencyOf(f) === totalled).reduce((sum, f) => sum + toCents(f.dollarImpact), 0))

  return {
    recurringSeries,
    findings,
    recoverableTotal: sumBy('recoverable'),
    reviewTotal: sumBy('review'),
    opportunityTotal: sumBy('opportunity'),
  }
}
