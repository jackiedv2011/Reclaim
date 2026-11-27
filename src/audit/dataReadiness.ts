import type { APRecord, FindingType, ParseResult } from '@/types'
import { formatDate, parseTerms } from '@/lib/format'
import { FINDING_TYPE_ORDER } from '@/lib/labels'
import { referenceStrength } from '@/lib/sourceIdentity'

/** Every check Reclaim has. A file can run some or all of them, see runnableChecks. */
export const TOTAL_CHECK_COUNT = 8

const REQUIRED_COLUMNS = ['vendor', 'payment_date', 'amount_paid']

export interface WeakerCheck {
  label: string
}

export interface DataReadiness {
  recordCount: number
  vendorCount: number
  dateRangeLabel: string | null
  skippedCount: number
  missingInvoiceRefCount: number
  availableCheckCount: number
  totalCheckCount: typeof TOTAL_CHECK_COUNT
  weakerChecks: WeakerCheck[]
}

function dateRangeLabel(records: APRecord[]): string | null {
  if (records.length === 0) return null
  let min = records[0].paymentDate
  let max = records[0].paymentDate
  for (const record of records) {
    if (record.paymentDate < min) min = record.paymentDate
    if (record.paymentDate > max) max = record.paymentDate
  }
  if (min.getTime() === max.getTime()) return formatDate(min)
  return `${formatDate(min)} – ${formatDate(max)}`
}

const hasUsableReference = (r: APRecord) => referenceStrength(r.invoiceNumber) !== 'none'
const hasInvoiceAmount = (r: APRecord) => r.invoiceAmount !== null && r.invoiceAmount > 0

/**
 * The checks these records give something to work on, in the product's order.
 * A blank, all-zero or placeholder reference ("Autopay") is not a reference,
 * and an invoice amount of zero is not an amount. Near-duplicate and outlier
 * detection need only a vendor, an amount and a date, so any record runs them.
 */
export function runnableChecks(records: APRecord[]): FindingType[] {
  if (records.length === 0) return []
  const references = records.some(hasUsableReference)
  const discounts = records.some((r) => parseTerms(r.terms) !== null && r.invoiceDate !== null && hasInvoiceAmount(r))
  const can: Record<FindingType, boolean> = {
    exact_duplicate: references,
    near_duplicate: true,
    overpayment: records.some(hasInvoiceAmount),
    unclaimed_discount: discounts,
    missed_discount: discounts,
    bank_account_change: records.some((r) => r.bankAccountLast4 !== null),
    amount_outlier: true,
    shared_invoice_number: references,
  }
  return FINDING_TYPE_ORDER.filter((type) => can[type])
}

/** How many of the eight checks these records can run. */
export function runnableCheckCount(records: APRecord[]): number {
  return runnableChecks(records).length
}

/**
 * A truthful summary of the records a single import contributed and the
 * coverage those records can support. Column metadata is optional so older
 * persisted ledgers can still produce a receipt from their usable values.
 */
export function assessRecordReadiness(
  records: APRecord[],
  skippedCount: number,
  detectedColumns?: string[]
): DataReadiness {
  const vendorCount = new Set(records.map((r) => r.vendor)).size
  const missingInvoiceRefCount = records.filter((r) => !hasUsableReference(r)).length
  const runnable = new Set(runnableChecks(records))
  const provided = new Set(detectedColumns)
  const knowsColumns = detectedColumns !== undefined
  const weakerChecks: WeakerCheck[] = []

  if (!runnable.has('exact_duplicate')) {
    const because = knowsColumns && !provided.has('invoice_number') ? 'no invoice-reference column was provided' : 'no usable invoice references were found'
    weakerChecks.push({
      label: `Exact-duplicate and shared-invoice-number detection are unavailable because ${because}. Near-duplicate detection still runs, on vendor, amount and date alone, so it is weaker.`,
    })
  } else if (missingInvoiceRefCount > 0) {
    weakerChecks.push({
      label: `Duplicate-invoice detection will be less precise for ${missingInvoiceRefCount} record${
        missingInvoiceRefCount === 1 ? '' : 's'
      } missing a usable invoice reference.`,
    })
  }

  if (!runnable.has('overpayment')) {
    weakerChecks.push({
      label: knowsColumns && !provided.has('invoice_amount')
        ? 'Overpayment detection is unavailable because no invoice-amount column was provided.'
        : 'Overpayment detection is unavailable because no usable invoice amounts were found.',
    })
  }

  if (!runnable.has('bank_account_change')) {
    weakerChecks.push({
      label: knowsColumns && !provided.has('bank_account_last4')
        ? 'Bank-account-change detection is unavailable because no bank-account column was provided.'
        : 'Bank-account-change detection is unavailable because no usable bank-account values were found.',
    })
  }

  if (!runnable.has('unclaimed_discount')) {
    const missingColumns = [
      knowsColumns && !provided.has('terms') ? 'payment terms' : null,
      knowsColumns && !provided.has('invoice_date') ? 'invoice dates' : null,
      knowsColumns && !provided.has('invoice_amount') ? 'invoice amounts' : null,
    ].filter((value): value is string => value !== null)
    weakerChecks.push({
      label: missingColumns.length > 0
        ? `Early-payment discount checks are unavailable because the file did not provide ${missingColumns.join(', ')}.`
        : 'Early-payment discount checks are unavailable because no rows had usable discount terms, invoice dates, and invoice amounts together.',
    })
  }

  return {
    recordCount: records.length,
    vendorCount,
    dateRangeLabel: dateRangeLabel(records),
    skippedCount,
    missingInvoiceRefCount,
    availableCheckCount: runnable.size,
    totalCheckCount: TOTAL_CHECK_COUNT,
    weakerChecks,
  }
}

/** A truthful summary of what Reclaim understood from a newly parsed file. */
export function assessDataReadiness(parsed: ParseResult): DataReadiness {
  return assessRecordReadiness(parsed.records, parsed.skippedCount, parsed.detectedColumns)
}

export interface FatalFileGuidance {
  detectedColumns: string[]
  missingRequiredColumns: string[]
  unrecognizedHeaders: string[]
}

/** When a file produced zero usable rows, explain what Reclaim did and didn't recognize instead of a dead-end error. */
export function assessFatalFile(parsed: ParseResult): FatalFileGuidance {
  const missingRequiredColumns = REQUIRED_COLUMNS.filter((col) => !parsed.detectedColumns.includes(col))
  return {
    detectedColumns: parsed.detectedColumns,
    missingRequiredColumns,
    unrecognizedHeaders: parsed.unrecognizedHeaders,
  }
}
