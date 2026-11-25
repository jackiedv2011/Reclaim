import type { APRecord, ImportReading, ParseResult, ImportRowResult } from '@/types'
import { isoDay, numericDateParts, parseDate, parseMoney, normalizeVendor, type AmountStyle, type DateOrder } from '@/lib/format'
import { columnCount, columnName, dateOrderEvidence, headingsOf, isBlankRow, readCsvTable, recognizedColumns, recognizedField, sameColumns, uniqueKeys, type ColumnMap, type CsvField, type CsvTable } from '@/lib/csvMapping'
import { resolveVendors } from '@/lib/vendorResolution'
import { checksum, normalizeReference, vendorTransformations, recordIdentity } from './sourceIdentity'

export interface ParseOptions {
  /** Position of the heading row. Found automatically when not given. */
  headerIndex?: number
  /** Which column supplies each field. Recognised headings are used when not given. */
  columns?: ColumnMap
  /** How to read dates like 04/03/2026. Month first when not given. */
  dateOrder?: DateOrder
  /** How amounts write decimals. 1,234.56 when not given. */
  amountStyle?: AmountStyle
  /** Read negative amounts paid as payments and positive ones as money back. For files that write payments as negatives. */
  flipSign?: boolean
  /** Take a missing vendor from the last line that named one, for reports grouped by vendor. */
  vendorGrouped?: boolean
}

function cellOrNull(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'na' || trimmed.toLowerCase() === 'n/a') return null
  return trimmed
}

/** Why a row was left out, in the words of the spreadsheet it came from. */
function rejectionReason(vendor: string | null, date: string | null, paymentDate: Date | null, paid: string | null, amountPaid: number | null): string {
  const missing: string[] = []
  if (!vendor) missing.push('no vendor name')
  if (!date) missing.push('no payment date')
  else if (!paymentDate) missing.push(`“${date}” isn’t a date`)
  if (!paid) missing.push('no amount paid')
  else if (amountPaid === null) missing.push(`“${paid}” isn’t an amount`)
  return missing.join(', ')
}

/** What people type in a currency column for the codes everything else compares. */
const CURRENCY_NAMES: Record<string, string> = { $: 'USD', us$: 'USD', 'us dollar': 'USD', 'us dollars': 'USD', 'u.s. dollar': 'USD', dollar: 'USD', dollars: 'USD', 'united states dollar': 'USD', '€': 'EUR', euro: 'EUR', euros: 'EUR', '£': 'GBP', 'pound sterling': 'GBP', 'british pound': 'GBP', c$: 'CAD', ca$: 'CAD', 'canadian dollar': 'CAD', a$: 'AUD', au$: 'AUD', 'australian dollar': 'AUD' }

/** "1,234.56" without quotes is two cells, and the first alone would import as 1. */
function splitAmount(cells: string[], index: number | undefined): string | null {
  if (index === undefined) return null
  const [whole, rest] = [cells[index]?.trim() ?? '', cells[index + 1]?.trim() ?? '']
  return /^[-($]*\d{1,3}$/.test(whole) && /^\d{3}(?:\.\d+)?\)?$/.test(rest) ? `the amount looks split in two by a comma without quotation marks: ${whole},${rest}` : null
}

const negate = (amount: number) => (amount === 0 ? 0 : -amount)

function dateSteps(raw: string, order: DateOrder): string[] {
  if (numericDateParts(raw)) return ['parse_date', order === 'day-first' ? 'read_day_first' : 'read_month_first']
  return /[a-z]{3}/i.test(raw) ? ['parse_date', 'read_month_name'] : ['parse_date']
}

export function parseCsv(input: string | CsvTable, options: ParseOptions = {}): ParseResult {
  const table = typeof input === 'string' ? readCsvTable(input) : input
  const headerIndex = options.headerIndex ?? table.headerIndex
  const dateOrder = options.dateOrder ?? 'month-first'
  const headings = headingsOf(table, headerIndex)
  const recognized = recognizedColumns(headings)
  const columns = options.columns ?? recognized
  // A person matched the columns: keep the row under the file's own headings and say which one fed each field.
  const matchedByHand = !sameColumns(columns, recognized)
  const keys = matchedByHand
    ? uniqueKeys(Array.from({ length: columnCount(table, headerIndex) }, (_, index) => columnName(headings, index)))
    : uniqueKeys(headings.map((heading) => recognizedField(heading) ?? heading), headings)
  const mapped = (Object.entries(columns) as [CsvField, number][]).sort((a, b) => a[1] - b[1])
  const sourceColumns = matchedByHand ? Object.fromEntries(mapped.map(([field, index]) => [field, keys[index]])) : undefined

  const records: APRecord[] = []
  const rowResults: ImportRowResult[] = []
  let skippedCount = 0
  let group: { vendor: string; rowNumber: number } | null = null

  for (let position = headerIndex + 1; position < table.rows.length; position += 1) {
    const cells = table.rows[position]
    if (isBlankRow(cells)) continue
    const rowNumber = position + 1
    const cell = (field: CsvField): string | undefined => {
      const index = columns[field]
      return index === undefined ? undefined : cells[index]
    }
    const value = (field: CsvField) => cellOrNull(cell(field))
    const raw = rawRow(keys, cells)

    const paymentDateRaw = value('payment_date')
    const amountPaidRaw = value('amount_paid')
    const paymentDate = parseDate(paymentDateRaw, dateOrder)
    const money = parseMoney(amountPaidRaw, options.amountStyle)
    const amountInFile = money?.amount ?? null

    let vendor = value('vendor')
    let carriedFrom: number | null = null
    if (options.vendorGrouped) {
      // A line naming a vendor and paying nothing starts a group; a total line names one too, but has an amount and no date.
      if (vendor && !amountPaidRaw && !paymentDateRaw) {
        group = { vendor, rowNumber }
        continue
      }
      if (vendor && paymentDate && money) group = { vendor, rowNumber }
      else if (!vendor && group && paymentDate) {
        vendor = group.vendor
        carriedFrom = group.rowNumber
      }
    }

    const split = headings.length > 0 && cells.length > headings.length ? splitAmount(cells, columns.amount_paid) : null
    if (!vendor || !paymentDateRaw || !paymentDate || money === null || amountInFile === null || split) {
      skippedCount += 1
      rowResults.push({ rowNumber, status: 'rejected', reason: split ?? rejectionReason(vendor, paymentDateRaw, paymentDate, amountPaidRaw, amountInFile), raw })
      continue
    }
    const amountPaid = options.flipSign ? negate(amountInFile) : amountInFile
    const invoiceMoney = parseMoney(value('invoice_amount'), options.amountStyle)
    const flipInvoice = Boolean(options.flipSign) && invoiceMoney !== null && invoiceMoney.amount < 0
    const invoiceAmount = invoiceMoney === null ? null : flipInvoice ? negate(invoiceMoney.amount) : invoiceMoney.amount
    const invoiceDateRaw = value('invoice_date')
    const reference = normalizeReference(cell('invoice_number') ?? null)
    const written = value('currency')
    const currency = written ? CURRENCY_NAMES[written.toLowerCase()] ?? written.toUpperCase() : money.currency ?? invoiceMoney?.currency ?? null
    records.push({
      source: {
        schemaVersion: 2, rawAvailable: true, raw, ...(sourceColumns ? { columns: sourceColumns } : {}),
        parsed: { vendor, invoiceReference: value('invoice_number'), paymentDate: isoDay(paymentDate), amountPaid, invoiceAmount, currency },
        normalized: { vendor: normalizeVendor(vendor), invoiceReference: reference.value },
        transformations: {
          vendor: carriedFrom === null ? vendorTransformations(cell('vendor') ?? '') : [`taken_from_row_${carriedFrom}`, ...vendorTransformations(vendor)],
          invoiceReference: reference.transformations,
          amountPaid: [...(amountPaidRaw !== String(amountInFile) ? ['parse_amount'] : []), ...(options.flipSign ? ['flip_sign'] : [])],
          paymentDate: dateSteps(paymentDateRaw, dateOrder),
          currency: written === null ? (currency ? ['read_from_amount'] : []) : currency !== cell('currency') ? ['trim_and_uppercase'] : [],
          ...(invoiceDateRaw && numericDateParts(invoiceDateRaw) ? { invoiceDate: dateSteps(invoiceDateRaw, dateOrder) } : {}),
          ...(flipInvoice ? { invoiceAmount: ['flip_sign'] } : {}),
        },
        filename: null, rowNumber, batchId: '',
      },
      currency,
      externalTransactionId: value('transaction_id'),
      company: value('company'),
      sourceAccount: value('source_account'),
      transactionType: value('transaction_type'),
      stableSupplierId: value('supplier_id'),
      // Placeholder identity — the ledger store assigns the real global id
      // and importBatchId when this record is merged into the environment.
      id: `pending:${rowNumber - 2}`,
      importBatchId: '',
      vendor,
      invoiceNumber: value('invoice_number'),
      invoiceDate: parseDate(invoiceDateRaw, dateOrder),
      paymentDate,
      invoiceAmount,
      amountPaid,
      terms: value('terms'),
      bankAccountLast4: value('bank_account_last4'),
      category: value('category'),
      rowIndex: rowNumber - 2,
    })
  }

  const vendorResolution = resolveVendors(
    records.map((r) => ({ vendor: r.vendor, bankAccountLast4: r.bankAccountLast4 }))
  )
  for (const record of records) {
    const resolved = vendorResolution.resolveVendorName(record.vendor)
    // A fuzzy name resemblance is a suggestion, not proof that two rows have
    // the same supplier. Group only the deterministic normalized name until a
    // person reviews the alias against a stable supplier identity.
    const canonical = normalizeVendor(record.vendor)
    record.canonicalVendorId = record.stableSupplierId ? `supplier_${checksum(record.stableSupplierId.trim().toLowerCase())}` : `vendor_${checksum(canonical)}`
    if (normalizeVendor(resolved) !== canonical) record.suggestedVendorAlias = resolved
    record.identityKey = recordIdentity(record)
    record.rowFingerprint = checksum(record.identityKey)
  }

  const assigned = new Set(mapped.map(([, index]) => index))
  return {
    records,
    skippedCount,
    detectedColumns: mapped.map(([field]) => field),
    unrecognizedHeaders: keys.filter((_, index) => !assigned.has(index)),
    schemaVersion: 2,
    fileChecksum: checksum(table.text),
    rowResults,
    ...(table.warnings.length > 0 ? { warnings: table.warnings } : {}),
    ...readingOf(table, headerIndex, columns, sourceColumns, options),
  }
}

/** One object per row, keyed by column. Cells past the last heading go under `__parsed_extra`, as Papa Parse puts them. */
function rawRow(keys: string[], cells: string[]): Record<string, string> {
  const raw: Record<string, unknown> = {}
  // Defined rather than assigned, so a heading called __proto__ is a key like any other.
  const put = (key: string, value: unknown) => Object.defineProperty(raw, key, { value, enumerable: true, configurable: true, writable: true })
  cells.slice(0, keys.length).forEach((cell, index) => put(keys[index], cell))
  if (cells.length > keys.length) put('__parsed_extra', cells.slice(keys.length))
  return raw as Record<string, string>
}

/** What a person should be told about how the file was read; nothing when the headings were simply recognised. */
function readingOf(table: CsvTable, headerIndex: number, columns: ColumnMap, sourceColumns: Record<string, string> | undefined, options: ParseOptions): { reading?: ImportReading } {
  const titleLines = table.rows.slice(0, Math.max(0, headerIndex)).filter((row) => row.some((cell) => cell.trim() !== '')).length
  const evidence = options.dateOrder ? dateOrderEvidence(table, columns, headerIndex, options.vendorGrouped) : null
  const dateOrder = evidence && (evidence.question !== null || (options.dateOrder === 'day-first' && evidence.monthFirst + evidence.dayFirst > 0)) ? options.dateOrder : undefined
  const decimalComma = options.amountStyle === 'comma'
  if (titleLines === 0 && !sourceColumns && !dateOrder && !options.flipSign && !options.vendorGrouped && !decimalComma && !table.sheet) return {}
  return {
    reading: {
      headerRow: headerIndex + 1,
      titleLines,
      ...(sourceColumns ? { columns: sourceColumns } : {}),
      ...(dateOrder ? { dateOrder } : {}),
      ...(options.flipSign ? { signFlipped: true as const } : {}),
      ...(options.vendorGrouped ? { vendorGrouped: true as const } : {}),
      ...(decimalComma ? { decimalComma: true as const } : {}),
      ...(table.sheet ? { sheet: table.sheet } : {}),
    },
  }
}
