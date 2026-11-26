import type { APRecord } from '../../types.ts'
import { normalizeVendor, normalizeAccountLast4, toCents } from '../format.ts'
import { normalizeReference, referenceStrength } from '../sourceIdentity.ts'
import { normalizeVendorName } from '../vendorResolution.ts'

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Words that describe the legal form or are filler, not the supplier. Dropped before comparing names. */
const VENDOR_FILLER = new Set(['the', 'co', 'company', 'corp', 'corporation', 'inc', 'incorporated', 'llc', 'ltd', 'limited', 'plc', 'lp', 'llp', 'and'])

export type RecordKind = 'payment' | 'refund_or_credit' | 'void_or_reversal' | 'zero'

/** A record reduced to the fields the matcher compares. Computed once per record. */
export interface PreparedRecord {
  record: APRecord
  id: string
  /** Mirrors detection's vendor identity: stable supplier ID, QuickBooks vendor ID, canonical ID, normalized name. */
  vendorKey: string
  /** Name with punctuation, legal form and filler words removed ("acme supply"). */
  vendorName: string
  vendorTokens: string[]
  referenceNormalized: string | null
  referenceStrength: 'none' | 'short' | 'strong'
  /** Digits of the reference with leading zeros dropped ("INV-001001-A" → "1001"); null when fewer than three digits. */
  referenceDigits: string | null
  cents: number
  currency: string | null
  company: string | null
  paymentDay: number
  invoiceDay: number | null
  invoiceCents: number | null
  bankLast4: string | null
  externalTransactionId: string | null
  identityKey: string | null
  kind: RecordKind
}

export function vendorIdentity(record: APRecord): string {
  if (record.stableSupplierId) return `supplier:${record.stableSupplierId.trim().toLowerCase()}`
  if (record.quickbooks?.vendorId) return `qbo:${record.quickbooks.vendorId}`
  return record.canonicalVendorId ?? normalizeVendor(record.vendor)
}

export function vendorComparisonName(vendor: string): string {
  const words = normalizeVendorName(vendor).split(' ').filter((w) => w && !VENDOR_FILLER.has(w))
  return words.join(' ')
}

export function referenceDigitCore(normalized: string | null): string | null {
  if (!normalized) return null
  const digits = normalized.replace(/\D/g, '').replace(/^0+/, '')
  return digits.length >= 3 ? digits : null
}

function kindOf(record: APRecord): RecordKind {
  const type = (record.transactionType ?? '').trim().toLowerCase()
  if (/void|revers/.test(type)) return 'void_or_reversal'
  if (record.amountPaid < 0 || /refund|credit/.test(type)) return 'refund_or_credit'
  if (record.amountPaid === 0) return 'zero'
  return 'payment'
}

const dayNumber = (d: Date) => Math.round(d.getTime() / MS_PER_DAY)

export function prepareRecord(record: APRecord): PreparedRecord {
  const ref = normalizeReference(record.invoiceNumber).value
  const strength = referenceStrength(record.invoiceNumber)
  const vendorName = vendorComparisonName(record.vendor)
  const currency = record.currency?.trim().toUpperCase() || null
  return {
    record,
    id: record.id,
    vendorKey: vendorIdentity(record),
    vendorName,
    vendorTokens: vendorName.split(' ').filter(Boolean),
    referenceNormalized: strength === 'none' ? null : ref,
    referenceStrength: strength,
    referenceDigits: strength === 'strong' ? referenceDigitCore(ref) : null,
    cents: toCents(record.amountPaid),
    currency,
    company: record.company?.trim().toLowerCase() || null,
    paymentDay: dayNumber(record.paymentDate),
    invoiceDay: record.invoiceDate ? dayNumber(record.invoiceDate) : null,
    invoiceCents: record.invoiceAmount === null ? null : toCents(record.invoiceAmount),
    bankLast4: normalizeAccountLast4(record.bankAccountLast4),
    externalTransactionId: record.externalTransactionId?.trim() || null,
    identityKey: record.identityKey?.trim() || null,
    kind: kindOf(record),
  }
}
