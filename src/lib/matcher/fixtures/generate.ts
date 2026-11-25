import type { APRecord } from '../../../types.ts'

/**
 * Synthetic AP ledgers for the intelligent record matching experiment.
 *
 * Everything here is invented: supplier names are combinations of stock words,
 * amounts and dates come from a seeded PRNG. No customer data, no network.
 *
 * Every record belongs to exactly one labelled case. A case is either a true
 * duplicate payment (one labelled pair: the original and the extra payment)
 * or a negative (no pair inside it, or across it, is a duplicate payment).
 * Cases are grouped by supplier ("group"); the DEV and HELD-OUT splits draw
 * suppliers from disjoint word pools, so no supplier, bill or import appears
 * in both.
 *
 * The frozen JSON files (dev.json, heldout.json) are produced by
 * `node scripts/matcher-benchmark.ts --freeze-fixtures` and checked by a test
 * to equal what this generator produces for the fixed seeds.
 */

export const FIXTURE_GENERATOR_VERSION = 'matcher-fixtures-1' as const

export type Split = 'dev' | 'heldout' | 'perf'
export type CaseLabel = 'duplicate_payment' | 'not_duplicate'

export const POSITIVE_SCENARIOS = [
  'exact_duplicate',
  'ref_format_variant',
  'card_double_charge',
  'ref_suffix_late_repay',
  'vendor_suffix_rename',
  'vendor_typo',
  'ref_transposed_late',
  'amount_fee_variant',
  'missing_invoice_date_late',
  'alias_no_reference',
] as const

export const NEGATIVE_SCENARIOS = [
  'background_distinct_bills',
  'recurring_equal_amount',
  'overlapping_export',
  'partial_payments',
  'void_and_reissue',
  'refunded_duplicate',
  'adjustment_payment',
  'similar_vendor_names',
  'same_amount_separate_bills',
  'currency_mismatch',
  'transposed_refs_different_amounts',
] as const

export type Scenario = (typeof POSITIVE_SCENARIOS)[number] | (typeof NEGATIVE_SCENARIOS)[number]

/** JSON-safe record. Dates are local calendar dates, YYYY-MM-DD. */
export interface FixtureRecord {
  id: string
  importBatchId: string
  vendor: string
  invoiceNumber: string | null
  invoiceDate: string | null
  paymentDate: string
  invoiceAmount: number | null
  amountPaid: number
  bankAccountLast4: string | null
  transactionType: string | null
  currency: string | null
  externalTransactionId: string | null
  identityKey: string | null
  rowIndex: number
}

export interface FixtureCase {
  caseId: string
  /** Supplier / bill / import group. Never shared between splits. */
  group: string
  scenario: Scenario
  label: CaseLabel
  recordIds: string[]
}

export interface FixturePair {
  caseId: string
  scenario: Scenario
  a: string
  b: string
}

export interface FixtureFile {
  generator: typeof FIXTURE_GENERATOR_VERSION
  split: Split
  seed: number
  records: FixtureRecord[]
  cases: FixtureCase[]
  duplicatePairs: FixturePair[]
}

// ---------------------------------------------------------------- PRNG

/** mulberry32: small, fast, deterministic. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Rng {
  next: () => number
  int: (min: number, max: number) => number
  pick: <T>(items: readonly T[]) => T
  chance: (p: number) => boolean
  shuffle: <T>(items: T[]) => T[]
}

function rngFrom(seed: number): Rng {
  const next = createRng(seed)
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1))
  return {
    next,
    int,
    pick: (items) => items[Math.floor(next() * items.length)],
    chance: (p) => next() < p,
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1))
        ;[items[i], items[j]] = [items[j], items[i]]
      }
      return items
    },
  }
}

// ---------------------------------------------------------------- vocabulary

const FIRST_WORDS = [
  'Acme', 'Brightline', 'Cascade', 'Northwind', 'Summit', 'Harbor', 'Pioneer', 'Redwood', 'Silverline', 'Bluewater',
  'Granite', 'Evergreen', 'Lakeside', 'Ironbridge', 'Maplewood', 'Copperfield', 'Westgate', 'Sunrise', 'Oakmont', 'Riverbend',
  'Highland', 'Keystone', 'Meridian', 'Pinecrest', 'Stonegate', 'Clearwater', 'Fairview', 'Goldleaf', 'Horizon', 'Juniper',
  'Kingsley', 'Larkspur', 'Magnolia', 'Newport', 'Orchard', 'Parkside', 'Quarry', 'Rosewood', 'Sterling', 'Thornbury',
  'Unity', 'Valleyview', 'Willow', 'Yorkshire', 'Zenith', 'Ambergate', 'Beacon', 'Cobalt', 'Driftwood', 'Emberly',
  'Foxglove', 'Glenwood', 'Hawthorne', 'Indigo', 'Jasper', 'Kestrel', 'Lighthouse', 'Mariner', 'Northgate', 'Oldfield',
  'Prairie', 'Quillon', 'Ravenwood', 'Saltmarsh', 'Tidewater', 'Upland', 'Vantage', 'Wexford', 'Yarrow', 'Zephyr',
  'Alderbrook', 'Birchwood', 'Cedarline', 'Dunmore', 'Eastbrook', 'Fernhill', 'Greystone', 'Hollyfield', 'Ivywood', 'Larchmont',
] as const

const SECOND_WORDS = [
  'Logistics', 'Supply', 'Dental Lab', 'Office Products', 'Plumbing', 'Electric', 'Roasters', 'Packaging', 'Staffing', 'Printing',
  'Cleaning', 'Hardware', 'Freight', 'Textiles', 'Analytics', 'Catering', 'Security', 'Landscaping', 'Software', 'Mechanical',
] as const

const REGIONS = ['North', 'South', 'East', 'West', 'Central', 'Pacific', 'Atlantic', 'Midwest', 'Mountain', 'Coastal', 'Valley', 'Metro'] as const

const LEGAL_FORMS = ['Inc', 'LLC', 'Co.', 'Corp', 'Ltd', ''] as const
const RENAMED_FORMS = ['Company', 'Incorporated', 'Corporation', 'Limited'] as const

const MASTER_SEED = 20_261_125
export const SPLIT_SEEDS = { dev: 1_101, heldout: 2_202 } as const

/** First words partitioned once by the master seed: the first half for DEV, the second half for HELD-OUT. */
export function splitWordPools(): { dev: string[]; heldout: string[] } {
  const words = rngFrom(MASTER_SEED).shuffle([...FIRST_WORDS])
  const half = Math.floor(words.length / 2)
  return { dev: words.slice(0, half), heldout: words.slice(half) }
}

// ---------------------------------------------------------------- dates and amounts

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d + days))
  return date.toISOString().slice(0, 10)
}

const START = '2025-01-01'

function randomAmountCents(rng: Rng, min = 80, max = 15_000): number {
  const dollars = Math.exp(Math.log(min) + rng.next() * (Math.log(max) - Math.log(min)))
  if (rng.chance(0.2)) return Math.max(50, Math.round(dollars / 50) * 50) * 100
  return Math.round(dollars * 100)
}

const toDollars = (cents: number) => Math.round(cents) / 100

// ---------------------------------------------------------------- builder

type RefStyle = 'dash' | 'plain' | 'glued' | 'bill'

interface Vendor {
  group: string
  name: string
  base: string
  first: string
  second: string
  legal: string
  refStyle: RefStyle
  nextRef: number
  currency: string | null
  bankLast4: string | null
  invoiceDateKnown: number
  invoiceAmountKnown: number
}

function formatRef(style: RefStyle, n: number): string {
  switch (style) {
    case 'dash': return `INV-${n}`
    case 'plain': return String(n)
    case 'glued': return `INV${n}`
    case 'bill': return `B-${n}`
  }
}

/** A different spelling that normalizes to the same reference (detection's own variant rule catches these). */
function normalizedVariant(rng: Rng, n: number, original: string): string {
  const options = [String(n), `INV-${n}`, `INV ${n}`, `Inv #${n}`, `inv-${n}`].filter((o) => o !== original)
  return rng.pick(options)
}

/** A spelling with the same digits but a different normalized form ("INV1001-A"). */
function suffixVariant(rng: Rng, n: number): string {
  return rng.pick([`INV${n}-A`, `${n}-A`, `${n}A`, `INV${n}R`, `${n}-R`])
}

function transposeDigits(rng: Rng, n: number): number | null {
  const digits = String(n).split('')
  const positions: number[] = []
  for (let i = 1; i < digits.length - 1; i++) if (digits[i] !== digits[i + 1]) positions.push(i)
  if (positions.length === 0) return null
  const i = rng.pick(positions)
  ;[digits[i], digits[i + 1]] = [digits[i + 1], digits[i]]
  return Number(digits.join(''))
}

/** One keying error inside a word of at least five letters, past its first three letters (so the name stays recognisable). */
function typo(rng: Rng, name: string): string {
  const words = name.split(' ')
  const candidates = words.map((w, i) => [w, i] as const).filter(([w]) => /^[A-Za-z]{5,}$/.test(w))
  const [word, index] = rng.pick(candidates)
  const pos = rng.int(3, word.length - 2)
  const chars = word.split('')
  if (rng.chance(0.5) && chars[pos] !== chars[pos + 1]) [chars[pos], chars[pos + 1]] = [chars[pos + 1], chars[pos]]
  else chars.splice(pos, 1)
  words[index] = chars.join('')
  return words.join(' ')
}

class LedgerBuilder {
  readonly rng: Rng
  readonly split: Split
  readonly records: FixtureRecord[] = []
  readonly cases: FixtureCase[] = []
  readonly pairs: FixturePair[] = []
  private recordCounter = 0
  private txnCounter = 0
  private caseCounter = 0

  constructor(split: Split, seed: number) {
    this.split = split
    this.rng = rngFrom(seed)
  }

  record(vendor: Vendor, fields: Partial<FixtureRecord> & { paymentDate: string; amountPaid: number }): FixtureRecord {
    const id = `${this.split}-r${String(++this.recordCounter).padStart(6, '0')}`
    const txn = `${this.split}-txn-${String(++this.txnCounter).padStart(6, '0')}`
    const rec: FixtureRecord = {
      id,
      importBatchId: `${this.split}-import-1`,
      vendor: vendor.name,
      invoiceNumber: null,
      invoiceDate: null,
      invoiceAmount: null,
      bankAccountLast4: vendor.bankLast4,
      transactionType: 'Bill Payment',
      currency: vendor.currency,
      externalTransactionId: txn,
      identityKey: `external:${txn}`,
      rowIndex: 0,
      ...fields,
    }
    // A spread of another record's fields (an overlapping export copy) must never carry its id over.
    rec.id = id
    this.records.push(rec)
    return rec
  }

  /** A normal bill payment: next reference in the supplier's sequence. */
  bill(vendor: Vendor, paymentDate: string, amountCents: number, overrides: Partial<FixtureRecord> = {}): FixtureRecord {
    const n = vendor.nextRef
    vendor.nextRef += this.rng.int(1, 7)
    const invoiceDate = this.rng.chance(vendor.invoiceDateKnown) ? addDays(paymentDate, -this.rng.int(7, 40)) : null
    return this.record(vendor, {
      paymentDate,
      amountPaid: toDollars(amountCents),
      invoiceNumber: formatRef(vendor.refStyle, n),
      invoiceDate,
      invoiceAmount: this.rng.chance(vendor.invoiceAmountKnown) ? toDollars(amountCents) : null,
      ...overrides,
    })
  }

  addCase(vendor: Vendor, scenario: Scenario, label: CaseLabel, records: FixtureRecord[], pair?: [FixtureRecord, FixtureRecord]): void {
    const caseId = `${this.split}-case-${String(++this.caseCounter).padStart(4, '0')}`
    this.cases.push({ caseId, group: vendor.group, scenario, label, recordIds: records.map((r) => r.id) })
    if (pair) this.pairs.push({ caseId, scenario, a: pair[0].id, b: pair[1].id })
  }

  finish(seed: number): FixtureFile {
    const records = [...this.records].sort((a, b) => (a.paymentDate < b.paymentDate ? -1 : a.paymentDate > b.paymentDate ? 1 : a.id < b.id ? -1 : 1))
    records.forEach((r, i) => (r.rowIndex = i + 1))
    return { generator: FIXTURE_GENERATOR_VERSION, split: this.split, seed, records, cases: this.cases, duplicatePairs: this.pairs }
  }
}

function makeVendor(rng: Rng, first: string, second: string, region: string | null): Vendor {
  const base = region ? `${first} ${region} ${second}` : `${first} ${second}`
  const legal = rng.pick(LEGAL_FORMS)
  return {
    group: `supplier:${base.toLowerCase().replace(/\s+/g, '-')}`,
    name: legal ? `${base} ${legal}` : base,
    base,
    first,
    second,
    legal,
    refStyle: rng.pick(['dash', 'plain', 'glued', 'bill'] as const),
    nextRef: rng.int(1_000, 60_000),
    currency: rng.chance(0.85) ? 'USD' : null,
    bankLast4: rng.chance(0.5) ? String(rng.int(0, 9999)).padStart(4, '0') : null,
    invoiceDateKnown: rng.chance(0.75) ? 0.9 : 0.2,
    invoiceAmountKnown: rng.chance(0.6) ? 0.9 : 0.1,
  }
}

// ---------------------------------------------------------------- scenarios

type ScenarioFn = (b: LedgerBuilder, v: Vendor, day: string) => void

function duplicateOf(b: LedgerBuilder, v: Vendor, original: FixtureRecord, days: number, overrides: Partial<FixtureRecord> = {}): FixtureRecord {
  return b.record(v, {
    paymentDate: addDays(original.paymentDate, days),
    amountPaid: original.amountPaid,
    invoiceNumber: original.invoiceNumber,
    invoiceDate: original.invoiceDate,
    invoiceAmount: original.invoiceAmount,
    ...overrides,
  })
}

const refNumber = (ref: string | null) => Number((ref ?? '').replace(/\D/g, ''))

const SCENARIOS: Record<Scenario, ScenarioFn> = {
  background_distinct_bills: () => {},

  exact_duplicate: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    const dup = duplicateOf(b, v, orig, b.rng.int(3, 30))
    b.addCase(v, 'exact_duplicate', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  ref_format_variant: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    const dup = duplicateOf(b, v, orig, b.rng.int(5, 40), { invoiceNumber: normalizedVariant(b.rng, refNumber(orig.invoiceNumber), orig.invoiceNumber!) })
    b.addCase(v, 'ref_format_variant', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  card_double_charge: (b, v, day) => {
    const orig = b.record(v, { paymentDate: day, amountPaid: toDollars(randomAmountCents(b.rng, 20, 900)), transactionType: 'Expense' })
    const dup = duplicateOf(b, v, orig, b.rng.int(0, 3))
    b.addCase(v, 'card_double_charge', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  ref_suffix_late_repay: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    const dup = duplicateOf(b, v, orig, b.rng.int(50, 120), { invoiceNumber: suffixVariant(b.rng, refNumber(orig.invoiceNumber)) })
    b.addCase(v, 'ref_suffix_late_repay', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  vendor_suffix_rename: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    const renamed = b.rng.chance(0.3) ? `${v.base.toUpperCase()}, ${b.rng.pick(['LLC', 'INC'])}` : `${v.base} ${b.rng.pick(RENAMED_FORMS)}`
    const dup = duplicateOf(b, v, orig, b.rng.int(2, 40), { vendor: renamed })
    b.addCase(v, 'vendor_suffix_rename', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  vendor_typo: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    const misspelt = typo(b.rng, v.base) + (v.legal ? ` ${v.legal}` : '')
    const ref = b.rng.chance(0.5) ? orig.invoiceNumber : normalizedVariant(b.rng, refNumber(orig.invoiceNumber), orig.invoiceNumber!)
    const dup = duplicateOf(b, v, orig, b.rng.int(1, 60), { vendor: misspelt, invoiceNumber: ref })
    b.addCase(v, 'vendor_typo', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  ref_transposed_late: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    const swapped = transposeDigits(b.rng, refNumber(orig.invoiceNumber))
    if (swapped === null) return
    const dup = duplicateOf(b, v, orig, b.rng.int(46, 100), { invoiceNumber: formatRef(v.refStyle, swapped) })
    b.addCase(v, 'ref_transposed_late', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  amount_fee_variant: (b, v, day) => {
    const cents = randomAmountCents(b.rng, 1_500, 20_000)
    const orig = b.bill(v, day, cents, { invoiceAmount: toDollars(cents) })
    const fee = b.rng.int(10, 25) * 100
    const dup = duplicateOf(b, v, orig, b.rng.int(3, 45), {
      amountPaid: toDollars(cents - fee),
      invoiceNumber: normalizedVariant(b.rng, refNumber(orig.invoiceNumber), orig.invoiceNumber!),
      transactionType: 'Wire',
    })
    b.addCase(v, 'amount_fee_variant', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  missing_invoice_date_late: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng), { invoiceDate: null, invoiceAmount: null })
    const dup = duplicateOf(b, v, orig, b.rng.int(50, 110), {
      invoiceNumber: normalizedVariant(b.rng, refNumber(orig.invoiceNumber), orig.invoiceNumber!),
    })
    b.addCase(v, 'missing_invoice_date_late', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  alias_no_reference: (b, v, day) => {
    const orig = b.record(v, { paymentDate: day, amountPaid: toDollars(randomAmountCents(b.rng, 40, 2_000)), transactionType: 'Expense' })
    const dup = duplicateOf(b, v, orig, b.rng.int(1, 6), { vendor: `${v.base} ${b.rng.pick(RENAMED_FORMS)}` })
    b.addCase(v, 'alias_no_reference', 'duplicate_payment', [orig, dup], [orig, dup])
  },

  recurring_equal_amount: (b, v, day) => {
    const cents = randomAmountCents(b.rng, 200, 6_000)
    const count = b.rng.int(4, 8)
    const cadence = b.rng.pick([7, 14, 30, 30, 30, 91])
    const withRefs = b.rng.chance(0.6)
    const rows: FixtureRecord[] = []
    for (let i = 0; i < count; i++) {
      const paymentDate = addDays(day, i * cadence + b.rng.int(-1, 1))
      rows.push(withRefs ? b.bill(v, paymentDate, cents) : b.record(v, { paymentDate, amountPaid: toDollars(cents), transactionType: 'Expense' }))
    }
    b.addCase(v, 'recurring_equal_amount', 'not_duplicate', rows)
  },

  overlapping_export: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    // The same transaction, exported twice: identical source ID and identity, a new ledger row.
    const copy = b.record(v, { ...orig, importBatchId: `${b.split}-import-2` })
    b.addCase(v, 'overlapping_export', 'not_duplicate', [orig, copy])
  },

  partial_payments: (b, v, day) => {
    const total = randomAmountCents(b.rng, 1_000, 20_000)
    const first = Math.round(total * b.rng.pick([0.5, 0.4, 0.6, 0.25]))
    const orig = b.bill(v, day, first, { invoiceAmount: toDollars(total) })
    const second = duplicateOf(b, v, orig, b.rng.int(14, 60), { amountPaid: toDollars(total - first) })
    b.addCase(v, 'partial_payments', 'not_duplicate', [orig, second])
  },

  void_and_reissue: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    const voidRow = duplicateOf(b, v, orig, b.rng.int(1, 4), { amountPaid: -orig.amountPaid, transactionType: 'Void' })
    const reissue = duplicateOf(b, v, orig, b.rng.int(5, 12))
    b.addCase(v, 'void_and_reissue', 'not_duplicate', [orig, voidRow, reissue])
  },

  refunded_duplicate: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    const dup = duplicateOf(b, v, orig, b.rng.int(2, 20))
    const refund = duplicateOf(b, v, orig, b.rng.int(25, 60), { amountPaid: -orig.amountPaid, transactionType: 'Refund' })
    // A duplicate that the supplier already refunded in full: nothing left to review.
    b.addCase(v, 'refunded_duplicate', 'not_duplicate', [orig, dup, refund])
  },

  adjustment_payment: (b, v, day) => {
    const cents = randomAmountCents(b.rng, 500, 15_000)
    const orig = b.bill(v, day, cents)
    const adj = duplicateOf(b, v, orig, b.rng.int(10, 40), {
      amountPaid: toDollars(Math.round(cents * b.rng.pick([0.03, 0.05, 0.1]))),
      invoiceNumber: `${orig.invoiceNumber}-ADJ`,
      invoiceAmount: null,
    })
    b.addCase(v, 'adjustment_payment', 'not_duplicate', [orig, adj])
  },

  similar_vendor_names: (b, v, day) => {
    const sibling: Vendor = { ...v, name: `${v.base} ${b.rng.pick(['Services', 'Group', 'Holdings', 'Partners'])}`, nextRef: v.nextRef + 5_000, refStyle: 'plain' }
    const cents = b.rng.pick([25_000, 50_000, 75_000, 100_000, 150_000])
    const withRefs = b.rng.chance(0.5)
    const a = withRefs ? b.bill(v, day, cents) : b.record(v, { paymentDate: day, amountPaid: toDollars(cents), transactionType: 'Expense' })
    const later = addDays(day, b.rng.int(1, 10))
    const c = withRefs ? b.bill(sibling, later, cents) : b.record(sibling, { paymentDate: later, amountPaid: toDollars(cents), transactionType: 'Expense' })
    b.addCase(v, 'similar_vendor_names', 'not_duplicate', [a, c])
  },

  same_amount_separate_bills: (b, v, day) => {
    const cents = b.rng.pick([20_000, 45_000, 80_000, 120_000, randomAmountCents(b.rng)])
    const a = b.bill(v, day, cents)
    const c = b.bill(v, addDays(day, b.rng.int(20, 150)), cents)
    b.addCase(v, 'same_amount_separate_bills', 'not_duplicate', [a, c])
  },

  currency_mismatch: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng), { currency: 'USD' })
    const other = duplicateOf(b, v, orig, b.rng.int(0, 20), { currency: 'CAD' })
    b.addCase(v, 'currency_mismatch', 'not_duplicate', [orig, other])
  },

  transposed_refs_different_amounts: (b, v, day) => {
    const orig = b.bill(v, day, randomAmountCents(b.rng))
    const swapped = transposeDigits(b.rng, refNumber(orig.invoiceNumber))
    if (swapped === null) return
    const other = b.record(v, {
      paymentDate: addDays(day, b.rng.int(5, 90)),
      amountPaid: toDollars(randomAmountCents(b.rng)),
      invoiceNumber: formatRef(v.refStyle, swapped),
    })
    b.addCase(v, 'transposed_refs_different_amounts', 'not_duplicate', [orig, other])
  },
}

/** Relative frequency of each scenario per supplier. */
const SCENARIO_WEIGHTS: Array<[Scenario, number]> = [
  ['exact_duplicate', 3],
  ['ref_format_variant', 2],
  ['card_double_charge', 2],
  ['ref_suffix_late_repay', 2],
  ['vendor_suffix_rename', 2],
  ['vendor_typo', 2],
  ['ref_transposed_late', 2],
  ['amount_fee_variant', 2],
  ['missing_invoice_date_late', 2],
  ['alias_no_reference', 2],
  ['recurring_equal_amount', 4],
  ['overlapping_export', 3],
  ['partial_payments', 3],
  ['void_and_reissue', 2],
  ['refunded_duplicate', 2],
  ['adjustment_payment', 2],
  ['similar_vendor_names', 3],
  ['same_amount_separate_bills', 4],
  ['currency_mismatch', 2],
  ['transposed_refs_different_amounts', 2],
]

function pickScenario(rng: Rng): Scenario {
  const total = SCENARIO_WEIGHTS.reduce((s, [, w]) => s + w, 0)
  let roll = rng.next() * total
  for (const [scenario, weight] of SCENARIO_WEIGHTS) {
    roll -= weight
    if (roll < 0) return scenario
  }
  return SCENARIO_WEIGHTS[SCENARIO_WEIGHTS.length - 1][0]
}

function populateVendor(b: LedgerBuilder, v: Vendor): void {
  const background: FixtureRecord[] = []
  const count = b.rng.int(4, 9)
  for (let i = 0; i < count; i++) background.push(b.bill(v, addDays(START, b.rng.int(0, 364)), randomAmountCents(b.rng)))
  b.addCase(v, 'background_distinct_bills', 'not_duplicate', background)
  const scenarios = b.rng.int(2, 3)
  for (let i = 0; i < scenarios; i++) SCENARIOS[pickScenario(b.rng)](b, v, addDays(START, b.rng.int(0, 300)))
}

export interface GenerateOptions {
  split: Split
  seed: number
  /** Stop adding suppliers once this many rows exist (perf runs). Defaults to every supplier in the split's pool. */
  targetRows?: number
}

export function generateLedger(opts: GenerateOptions): FixtureFile {
  const b = new LedgerBuilder(opts.split, opts.seed)
  const pools = splitWordPools()
  const vendorRng = rngFrom(opts.seed ^ 0x5bd1e995)

  if (opts.split === 'perf') {
    const target = opts.targetRows ?? 1_000
    const firsts = [...FIRST_WORDS]
    let i = 0
    while (b.records.length < target) {
      const first = firsts[i % firsts.length]
      const second = SECOND_WORDS[Math.floor(i / firsts.length) % SECOND_WORDS.length]
      const region = REGIONS[Math.floor(i / (firsts.length * SECOND_WORDS.length)) % REGIONS.length]
      const cycle = Math.floor(i / (firsts.length * SECOND_WORDS.length * REGIONS.length))
      const vendor = makeVendor(vendorRng, first, second, cycle === 0 ? region : `${region} ${cycle}`)
      populateVendor(b, vendor)
      i++
    }
    return b.finish(opts.seed)
  }

  // Two suppliers per first word ("Acme Supply", "Acme Freight"), with different industry words.
  for (const first of pools[opts.split]) {
    const [secondA, secondB] = vendorRng.shuffle([...SECOND_WORDS])
    for (const second of [secondA, secondB]) populateVendor(b, makeVendor(vendorRng, first, second, null))
  }
  return b.finish(opts.seed)
}

export function generateSplit(split: 'dev' | 'heldout'): FixtureFile {
  return generateLedger({ split, seed: SPLIT_SEEDS[split] })
}

/** Fixture records as the APRecords detection and the matcher consume. */
export function toAPRecords(file: FixtureFile): APRecord[] {
  const date = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return file.records.map((r) => ({
    id: r.id,
    importBatchId: r.importBatchId,
    vendor: r.vendor,
    invoiceNumber: r.invoiceNumber,
    invoiceDate: r.invoiceDate ? date(r.invoiceDate) : null,
    paymentDate: date(r.paymentDate),
    invoiceAmount: r.invoiceAmount,
    amountPaid: r.amountPaid,
    terms: null,
    bankAccountLast4: r.bankAccountLast4,
    category: null,
    transactionType: r.transactionType,
    currency: r.currency,
    externalTransactionId: r.externalTransactionId,
    identityKey: r.identityKey ?? undefined,
    rowIndex: r.rowIndex,
  }))
}

/** Stable, diff-friendly JSON: one record / case / pair per line. */
export function serializeFixture(file: FixtureFile): string {
  const list = (items: unknown[]) => (items.length === 0 ? '[]' : `[\n    ${items.map((i) => JSON.stringify(i)).join(',\n    ')}\n  ]`)
  return `{\n  "generator": ${JSON.stringify(file.generator)},\n  "split": ${JSON.stringify(file.split)},\n  "seed": ${file.seed},\n  "records": ${list(file.records)},\n  "cases": ${list(file.cases)},\n  "duplicatePairs": ${list(file.duplicatePairs)}\n}\n`
}
