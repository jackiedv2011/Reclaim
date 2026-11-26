import type { MatchFeature } from '../../contracts/financial.ts'
import type { PreparedRecord } from './prepare.ts'
import {
  WEIGHTS,
  AMOUNT_CLOSE_RATIO,
  AMOUNT_CLOSE_CENTS,
  TIMING_CLOSE_DAYS,
  TIMING_WINDOW_DAYS,
  TIMING_FAR_DAYS,
} from './config.ts'

/**
 * Transparent weighted feature scoring. Every feature that contributes to the
 * score is listed with its weight and a plain-language reason; the score is
 * their sum. Feature details never quote amounts or other values the reviewer
 * cannot already see on the two rows.
 */

export interface PairScore {
  score: number
  features: MatchFeature[]
  evidenceGaps: string[]
}

const MAX_NAME_LENGTH_FOR_EDIT_DISTANCE = 64

const feature = (name: string, weight: number, detail: string): MatchFeature => ({ name, weight, detail })

/**
 * True when the restricted Damerau-Levenshtein distance (the variant in
 * ../stringDistance.ts) is at most `limit`. Only the diagonal band |i - j| <= limit
 * can lie on such a path, so cells outside it are skipped and the scan stops once
 * two consecutive rows exceed the limit. O(length x limit) with no matrix allocation:
 * the matcher calls this for most candidate pairs.
 */
export function withinEditDistance(a: string, b: string, limit: number): boolean {
  const al = a.length
  const bl = b.length
  if (Math.abs(al - bl) > limit) return false
  if (al === 0 || bl === 0) return Math.max(al, bl) <= limit
  const OVER = limit + 1
  let prev2 = new Array<number>(bl + 1).fill(OVER)
  let prev = new Array<number>(bl + 1).fill(OVER)
  let cur = new Array<number>(bl + 1).fill(OVER)
  for (let j = 0; j <= Math.min(bl, limit); j++) prev[j] = j
  let prevRowMin = 0
  for (let i = 1; i <= al; i++) {
    cur.fill(OVER)
    if (i <= limit) cur[0] = i
    let rowMin = cur[0]
    const from = Math.max(1, i - limit)
    const to = Math.min(bl, i + limit)
    for (let j = from; j <= to; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let best = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, prev2[j - 2] + cost)
      cur[j] = Math.min(best, OVER)
      if (cur[j] < rowMin) rowMin = cur[j]
    }
    if (rowMin > limit && prevRowMin > limit) return false
    prevRowMin = rowMin
    const spare = prev2
    prev2 = prev
    prev = cur
    cur = spare
  }
  return prev[bl] <= limit
}

function hamming(a: string, b: string): number {
  let diff = 0
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++
  return diff
}

export function referenceFeature(a: PreparedRecord, b: PreparedRecord): MatchFeature | null {
  if (a.referenceNormalized === null || b.referenceNormalized === null) return null
  if (a.referenceNormalized === b.referenceNormalized) {
    if (a.referenceStrength === 'short' || b.referenceStrength === 'short') {
      return feature('reference_exact_short', WEIGHTS.referenceExact / 2, 'Both rows carry the same one- or two-character reference, which many unrelated invoices share.')
    }
    return feature('reference_exact', WEIGHTS.referenceExact, 'References are identical once case, spacing, punctuation and an "INV" prefix are ignored.')
  }
  const da = a.referenceDigits
  const db = b.referenceDigits
  if (da && db) {
    if (da === db) {
      return feature('reference_digit_core', WEIGHTS.referenceDigitCore, 'References carry the same invoice number once letters, prefixes and suffixes are ignored.')
    }
    if (da.length === db.length) {
      const sameDigits = [...da].sort().join('') === [...db].sort().join('')
      if (sameDigits && withinEditDistance(da, db, 1)) {
        return feature('reference_transposition', WEIGHTS.referenceTransposition, 'References differ only by two swapped neighbouring digits, a common keying error.')
      }
      if (hamming(da, db) === 1) {
        return feature('reference_one_digit_off', WEIGHTS.referenceOneDigitOff, 'References differ in one digit; consecutive invoice numbers usually look like this, so it counts against a match.')
      }
    }
  }
  if (a.referenceStrength === 'strong' && b.referenceStrength === 'strong') {
    return feature('reference_unrelated', WEIGHTS.referenceUnrelated, 'Both rows carry invoice references and they do not match.')
  }
  return feature('reference_not_comparable', 0, 'At least one reference is too short to compare.')
}

function digitTokens(tokens: string[]): string {
  return tokens.filter((t) => /\d/.test(t)).sort().join(' ')
}

export function vendorFeature(a: PreparedRecord, b: PreparedRecord): MatchFeature {
  if (a.vendorKey === b.vendorKey) {
    return feature('vendor_same_identity', WEIGHTS.vendorSameKey, 'Both rows resolve to the same supplier identity used by detection.')
  }
  // Numbers in a name identify ("Store 1042" vs "Store 1043"): never a typo.
  if (digitTokens(a.vendorTokens) !== digitTokens(b.vendorTokens)) {
    return feature('vendor_unrelated', WEIGHTS.vendorUnrelated, 'Supplier names carry different numbers, so they name different suppliers.')
  }
  if (a.vendorName && a.vendorName === b.vendorName) {
    return feature('vendor_same_name', WEIGHTS.vendorSameName, 'Supplier names match once legal form ("Inc", "LLC", "Company") and punctuation are ignored.')
  }
  const shorter = Math.min(a.vendorName.length, b.vendorName.length)
  if (shorter >= 5 && a.vendorName.length <= MAX_NAME_LENGTH_FOR_EDIT_DISTANCE && b.vendorName.length <= MAX_NAME_LENGTH_FOR_EDIT_DISTANCE) {
    const allowed = Math.max(1, Math.floor(shorter * 0.12))
    if (withinEditDistance(a.vendorName, b.vendorName, allowed)) {
      return feature('vendor_spelling_variant', WEIGHTS.vendorTypo, 'Supplier names differ by a letter or two, consistent with a typo or alternate spelling.')
    }
  }
  const setA = new Set(a.vendorTokens)
  const setB = new Set(b.vendorTokens)
  let shared = 0
  for (const t of setA) if (setB.has(t)) shared++
  const union = new Set([...setA, ...setB]).size
  const jaccard = union === 0 ? 0 : shared / union
  if (jaccard >= 0.5) {
    const weight = Math.round(WEIGHTS.vendorTokenOverlap * jaccard * 10_000) / 10_000
    return feature('vendor_token_overlap', weight, 'Supplier names share most of their words; this may be the same supplier under another name.')
  }
  return feature('vendor_unrelated', WEIGHTS.vendorUnrelated, 'Supplier names do not resemble each other.')
}

export function amountFeature(a: PreparedRecord, b: PreparedRecord): MatchFeature {
  if (a.cents === b.cents) return feature('amount_exact', WEIGHTS.amountExact, 'Amounts agree to the cent.')
  const diff = Math.abs(a.cents - b.cents)
  const larger = Math.max(Math.abs(a.cents), Math.abs(b.cents))
  if (diff <= AMOUNT_CLOSE_CENTS && diff <= larger * AMOUNT_CLOSE_RATIO) {
    return feature('amount_close', WEIGHTS.amountClose, 'Amounts differ by under 2%, as a bank fee or rounding would cause.')
  }
  return feature('amount_different', WEIGHTS.amountFar, 'Amounts differ materially.')
}

export function timingFeature(a: PreparedRecord, b: PreparedRecord): MatchFeature {
  const days = Math.abs(a.paymentDay - b.paymentDay)
  if (days <= TIMING_CLOSE_DAYS) return feature('timing_close', WEIGHTS.timingClose, `Paid ${days} ${days === 1 ? 'day' : 'days'} apart.`)
  if (days <= TIMING_WINDOW_DAYS) return feature('timing_window', WEIGHTS.timingWindow, `Paid ${days} days apart, inside the usual review window.`)
  if (days <= TIMING_FAR_DAYS) return feature('timing_outside_window', 0, `Paid ${days} days apart, outside the usual review window (a re-payment after a reminder can be this late).`)
  return feature('timing_far', WEIGHTS.timingFar, `Paid ${days} days apart.`)
}

export function invoiceDateFeature(a: PreparedRecord, b: PreparedRecord): MatchFeature | null {
  if (a.invoiceDay === null || b.invoiceDay === null) return null
  const days = Math.abs(a.invoiceDay - b.invoiceDay)
  if (days <= 1) return feature('invoice_date_same', WEIGHTS.invoiceDateSame, 'Both rows carry the same invoice date.')
  if (days > 3) return feature('invoice_date_differs', WEIGHTS.invoiceDateDiffers, 'The rows carry different invoice dates, which points to separate bills.')
  return feature('invoice_date_near', 0, 'Invoice dates are within a few days of each other.')
}

export function invoiceAmountFeature(a: PreparedRecord, b: PreparedRecord): MatchFeature | null {
  if (a.invoiceCents === null || b.invoiceCents === null || a.invoiceCents !== b.invoiceCents) return null
  return feature('invoice_amount_same', WEIGHTS.invoiceAmountSame, 'Both rows carry the same invoice amount.')
}

export function bankFeature(a: PreparedRecord, b: PreparedRecord): MatchFeature | null {
  if (a.bankLast4 === null || b.bankLast4 === null) return null
  if (a.bankLast4 === b.bankLast4) return feature('bank_account_same', WEIGHTS.bankSame, 'Paid to the same bank account (last four digits).')
  return feature('bank_account_differs', WEIGHTS.bankDiffers, 'Paid to different bank accounts (last four digits).')
}

/** Features that indicate a near-match rather than an agreement. */
const APPROXIMATE_FEATURES = new Set(['reference_transposition', 'vendor_spelling_variant', 'vendor_token_overlap', 'amount_close'])

export function scorePair(a: PreparedRecord, b: PreparedRecord): PairScore {
  const features: MatchFeature[] = []
  const gaps = ['distinct_settlement_not_verified', 'bill_linkage_unknown', 'refund_credit_search_not_verified']

  const reference = referenceFeature(a, b)
  if (reference) features.push(reference)
  else gaps.push('reference_missing')

  const vendor = vendorFeature(a, b)
  features.push(vendor)
  if (vendor.name !== 'vendor_same_identity') gaps.push('supplier_identity_unconfirmed')

  features.push(amountFeature(a, b))
  features.push(timingFeature(a, b))

  const invoiceDate = invoiceDateFeature(a, b)
  if (invoiceDate) features.push(invoiceDate)
  else gaps.push('invoice_date_unknown')

  const invoiceAmount = invoiceAmountFeature(a, b)
  if (invoiceAmount) features.push(invoiceAmount)

  const bank = bankFeature(a, b)
  if (bank) features.push(bank)

  if (a.currency === null || b.currency === null) gaps.push('currency_unknown')

  const approximate = features.filter((f) => APPROXIMATE_FEATURES.has(f.name)).length
  if (approximate >= 2) {
    features.push(
      feature('multiple_approximate_signals', WEIGHTS.multipleApproximate, `${approximate} signals agree only approximately; together they are weaker than each looks alone.`)
    )
  }

  const score = Math.round(features.reduce((sum, f) => sum + f.weight, 0) * 10_000) / 10_000
  return { score, features, evidenceGaps: gaps }
}
