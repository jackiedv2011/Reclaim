import Papa from 'papaparse'
import type { ImportReading } from '@/types'
import { numericDateParts, parseCurrency, parseDate, type DateOrder } from '@/lib/format'

/** Header spellings seen in QuickBooks, Xero, Bill and hand-built AP exports, after headingKey. These import with nothing to confirm. */
const COLUMN_ALIASES: Record<string, CsvField> = {
  vendor: 'vendor',
  vendor_name: 'vendor',
  supplier: 'vendor',
  supplier_name: 'vendor',
  payee: 'vendor',
  payee_name: 'vendor',
  invoice_number: 'invoice_number',
  invoicenumber: 'invoice_number',
  invoice_no: 'invoice_number',
  invoice_num: 'invoice_number',
  invoice_id: 'invoice_number',
  invoice: 'invoice_number',
  inv_no: 'invoice_number',
  bill_number: 'invoice_number',
  bill_no: 'invoice_number',
  invoice_date: 'invoice_date',
  invoicedate: 'invoice_date',
  bill_date: 'invoice_date',
  payment_date: 'payment_date',
  paymentdate: 'payment_date',
  date_paid: 'payment_date',
  paid_date: 'payment_date',
  pay_date: 'payment_date',
  invoice_amount: 'invoice_amount',
  invoiceamount: 'invoice_amount',
  invoice_total: 'invoice_amount',
  bill_amount: 'invoice_amount',
  amount_paid: 'amount_paid',
  amountpaid: 'amount_paid',
  payment_amount: 'amount_paid',
  paid_amount: 'amount_paid',
  terms: 'terms',
  payment_terms: 'terms',
  bank_account_last4: 'bank_account_last4',
  bank_account_last_4: 'bank_account_last4',
  bankaccountlast4: 'bank_account_last4',
  bank_last4: 'bank_account_last4',
  account_last4: 'bank_account_last4',
  category: 'category',
  gl_category: 'category',
  currency: 'currency',
  currency_code: 'currency',
  transaction_id: 'transaction_id',
  payment_id: 'transaction_id',
  external_transaction_id: 'transaction_id',
  company: 'company',
  company_id: 'company',
  source_account: 'source_account',
  source_system_account: 'source_account',
  transaction_type: 'transaction_type',
  supplier_id: 'supplier_id',
  vendor_id: 'supplier_id',
}

export type CsvField =
  | 'vendor'
  | 'payment_date'
  | 'amount_paid'
  | 'invoice_number'
  | 'invoice_date'
  | 'invoice_amount'
  | 'terms'
  | 'bank_account_last4'
  | 'currency'
  | 'category'
  | 'transaction_id'
  | 'transaction_type'
  | 'supplier_id'
  | 'company'
  | 'source_account'

export const REQUIRED_FIELDS: readonly CsvField[] = ['vendor', 'payment_date', 'amount_paid']
export const OPTIONAL_FIELDS: readonly CsvField[] = ['invoice_number', 'invoice_date', 'invoice_amount', 'terms', 'bank_account_last4', 'currency', 'category', 'transaction_id', 'transaction_type', 'supplier_id', 'company', 'source_account']
/** Fields where picking the wrong one of two columns would put a wrong date or amount in the ledger. */
const NEVER_GUESSED: readonly CsvField[] = ['payment_date', 'amount_paid', 'invoice_date', 'invoice_amount']

/** Each field in words a person would recognise from their own spreadsheet. */
export const FIELD_LABELS: Record<CsvField, string> = {
  vendor: 'Vendor',
  payment_date: 'Payment date',
  amount_paid: 'Amount paid',
  invoice_number: 'Invoice number',
  invoice_date: 'Invoice date',
  invoice_amount: 'Invoice amount',
  terms: 'Payment terms',
  bank_account_last4: 'Bank account (last 4)',
  currency: 'Currency',
  category: 'Category',
  transaction_id: 'Transaction ID',
  transaction_type: 'Transaction type',
  supplier_id: 'Supplier ID',
  company: 'Company',
  source_account: 'Paid from account',
}

/** Field → column position in the file. */
export type ColumnMap = Partial<Record<CsvField, number>>

/**
 * Headings that usually mean a field but are too general to trust without a
 * person looking. Compared with punctuation removed ("*ContactName", "Ref No.").
 * "Num" and "No." are left out: in payment reports they are check numbers, and a
 * check number read as an invoice number hides an invoice paid twice.
 */
const HEADING_HINTS: Partial<Record<CsvField, readonly string[]>> = {
  vendor: ['name', 'contact', 'contactname', 'vendorfullname', 'vendordisplayname', 'vendorpayee', 'supplierpayee', 'payto', 'paidto', 'beneficiary', 'beneficiaryname', 'merchant', 'merchantname', 'entity', 'entityname', 'mainlinename', 'counterparty'],
  invoice_number: ['reference', 'ref', 'refno', 'refnumber', 'referenceno', 'referencenumber', 'documentnumber', 'documentno', 'docnumber', 'docno', 'invoiceref', 'invoicereference', 'invoiceinfo', 'bill', 'billref'],
  transaction_type: ['type'],
}
/** Other words that appear in a heading row; used only to tell headings from title lines and data. */
const HEADING_WORDS = new Set(['date', 'amount', 'debit', 'credit', 'balance', 'total', 'memo', 'description', 'account', 'split', 'status', 'processdate', 'duedate', 'posting', 'method', 'bank', 'num', 'no', 'check', 'checkno', 'class', 'period'])

const AMOUNT_WORD = /(^|_)(amount|amt|debit|credit|total|paid|payment|payments|value|balance|gross|net|sum|subtotal|tax|cost|price|spent|withdrawal|withdrawals)(_|$)/
const IDENTIFIER_WORD = /(^|_)(no|num|number|id|ref|reference|check|cheque|account|acct|phone|zip|postcode|code|qty|quantity|year|line|row)(_|$)/

/** Title lines are only looked for this far down. */
const HEADER_SCAN_ROWS = 30
const SAMPLE_ROWS = 200
/** A column counts as dates or amounts when most of its filled cells read that way; total and note lines are the exceptions. */
const COLUMN_SHARE = 0.6

export interface CsvTable {
  text: string
  /** Every row of the file, blank lines included, so position + 1 is the row number a spreadsheet shows. */
  rows: string[][]
  /** Position of the row the headings were found on. */
  headerIndex: number
}

/** "Invoice No.", " PAYMENT DATE ", "Invoice #" → invoice_no, payment_date, invoice. */
function headingKey(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export function recognizedField(heading: string): CsvField | null {
  const key = headingKey(heading)
  return Object.hasOwn(COLUMN_ALIASES, key) ? COLUMN_ALIASES[key] : null
}

/** A line with nothing on it. A row of empty cells (",,,") is still a row. */
export function isBlankRow(row: string[]): boolean {
  return row.length === 0 || (row.length === 1 && row[0] === '')
}

const isEmptyRow = (row: string[]) => row.every((cell) => cell.trim() === '')
const readsAsDate = (cell: string) => parseDate(cell, 'month-first') !== null || parseDate(cell, 'day-first') !== null

export function readCsvTable(text: string): CsvTable {
  // The delimiter is worked out with blank lines ignored, then every line is kept so row numbers match the file.
  const { delimiter } = Papa.parse<string[]>(text, { preview: 1, skipEmptyLines: true }).meta
  const rows = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: false }).data
  while (rows.length > 0 && isBlankRow(rows[rows.length - 1])) rows.pop()
  return { text, rows, headerIndex: findHeaderRow(rows) }
}

/**
 * Exports often start with a company name, a report title and a date range.
 * The heading row is the one that reads most like headings; a line holding a
 * date or a number is never one. When nothing looks like headings at all, it
 * is the first line wide enough to be a table.
 */
function findHeaderRow(rows: string[][]): number {
  const candidates: number[] = []
  for (let index = 0; index < rows.length && index < HEADER_SCAN_ROWS; index += 1) if (!isEmptyRow(rows[index])) candidates.push(index)
  if (candidates.length === 0) return 0

  let best = candidates[0]
  let bestScore = 0
  let firstWide: number | null = null
  for (const index of candidates) {
    const cells = rows[index].filter((cell) => cell.trim() !== '')
    if (cells.length < 2 || cells.some((cell) => readsAsDate(cell) || parseCurrency(cell) !== null)) continue
    if (cells.length >= REQUIRED_FIELDS.length && firstWide === null) firstWide = index
    const score = headingScore(cells)
    if (score > bestScore) {
      best = index
      bestScore = score
    }
  }
  return bestScore > 0 ? best : firstWide ?? best
}

function headingScore(cells: string[]): number {
  const fields = new Set<CsvField>()
  let hinted = 0
  for (const cell of cells) {
    const field = recognizedField(cell)
    if (field) fields.add(field)
    else {
      const word = headingKey(cell).replaceAll('_', '')
      if (HEADING_WORDS.has(word) || Object.values(HEADING_HINTS).some((hints) => hints.includes(word))) hinted += 1
    }
  }
  return fields.size * 2 + hinted
}

/** The columns whose headings Reclaim knows, taking the first of each. */
export function recognizedColumns(headings: string[]): ColumnMap {
  const columns: ColumnMap = {}
  headings.forEach((heading, index) => {
    const field = recognizedField(heading)
    if (field && columns[field] === undefined) columns[field] = index
  })
  return columns
}

export function sameColumns(a: ColumnMap, b: ColumnMap): boolean {
  return [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS].every((field) => a[field] === b[field])
}

/** How a column is named to a person: its own heading, or its spreadsheet letter when it has none. */
export function columnName(headings: string[], index: number): string {
  const heading = headings[index]?.trim()
  if (heading) return heading
  let letters = ''
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  return `Column ${letters}`
}

/** One key per column. Repeats are numbered the way Papa Parse numbers them, so rows already stored keep the same keys. */
export function uniqueKeys(names: string[], originals: string[] = names): string[] {
  const counts = new Map<string, number>()
  const used = new Set(originals)
  return names.map((name) => {
    const count = counts.get(name)
    if (count === undefined) {
      counts.set(name, 1)
      used.add(name)
      return name
    }
    let suffix = count
    let key: string
    do {
      key = `${name}_${suffix}`
      suffix += 1
    } while (used.has(key))
    used.add(key)
    counts.set(name, count + 1)
    return key
  })
}

export interface ColumnSuggestion {
  columns: ColumnMap
  /** Filled in from a heading Reclaim knows. */
  recognized: CsvField[]
  /** Filled in as a suggestion for a person to check. */
  suggested: CsvField[]
  /** Left empty because more than one column could be it. */
  ambiguous: Partial<Record<CsvField, number[]>>
}

export function dataRows(table: CsvTable, headerIndex = table.headerIndex): string[][] {
  return table.rows.slice(headerIndex + 1).filter((row) => !isEmptyRow(row))
}

/** Which column supplies which field, as far as the headings and cells say. Two possible date or amount columns are never chosen between. */
export function suggestColumns(table: CsvTable, headerIndex = table.headerIndex): ColumnSuggestion {
  const headings = table.rows[headerIndex] ?? []
  const rows = dataRows(table, headerIndex)
  const columns: ColumnMap = {}
  const recognized: CsvField[] = []
  const suggested: CsvField[] = []
  const ambiguous: ColumnSuggestion['ambiguous'] = {}

  const byField = new Map<CsvField, number[]>()
  headings.forEach((heading, index) => {
    const field = recognizedField(heading)
    if (field) byField.set(field, [...(byField.get(field) ?? []), index])
  })
  for (const [field, indexes] of byField) {
    const disagree = indexes.length > 1 && rows.some((row) => new Set(indexes.map((index) => (row[index] ?? '').trim())).size > 1)
    if (disagree && NEVER_GUESSED.includes(field)) ambiguous[field] = indexes
    else {
      columns[field] = indexes[0]
      recognized.push(field)
    }
  }

  const unclaimed = headings.map((_, index) => index).filter((index) => recognizedField(headings[index]) === null)
  const suggest = (field: CsvField, candidates: number[]) => {
    if (byField.has(field)) return
    if (candidates.length === 1) {
      columns[field] = candidates[0]
      suggested.push(field)
    } else if (candidates.length > 1) ambiguous[field] = candidates
  }
  const hinted = (field: CsvField) => unclaimed.filter((index) => HEADING_HINTS[field]?.includes(headingKey(headings[index]).replaceAll('_', '')))

  const sample = rows.slice(0, SAMPLE_ROWS)
  const filled = (index: number) => sample.map((row) => (row[index] ?? '').trim()).filter((cell) => cell !== '')
  const mostly = (cells: string[], test: (cell: string) => boolean) => cells.length > 0 && cells.filter(test).length / cells.length >= COLUMN_SHARE
  const dates = unclaimed.filter((index) => mostly(filled(index), readsAsDate))
  const amounts = unclaimed.filter((index) => {
    if (dates.includes(index)) return false
    const cells = filled(index)
    if (!mostly(cells, (cell) => parseCurrency(cell) !== null)) return false
    const key = headingKey(headings[index])
    return AMOUNT_WORD.test(key) || (!IDENTIFIER_WORD.test(key) && cells.some((cell) => /[.$,()-]/.test(cell)))
  })

  suggest('payment_date', dates)
  suggest('amount_paid', amounts)
  suggest('vendor', hinted('vendor').filter((index) => !dates.includes(index) && !amounts.includes(index)))
  suggest('invoice_number', hinted('invoice_number').filter((index) => !dates.includes(index) && !amounts.includes(index)))
  suggest('transaction_type', hinted('transaction_type'))
  return { columns, recognized, suggested, ambiguous }
}

export interface DateOrderEvidence {
  /** The order the file itself proves, or null when a person has to say. */
  order: DateOrder | null
  /** Why there is no proven order: every date works both ways, or different dates prove different orders. */
  question: 'ambiguous' | 'mixed' | null
  /** Dates that only work month first / only day first. */
  monthFirst: number
  dayFirst: number
  /** A date whose meaning depends on the answer. */
  example: string | null
}

/**
 * Which way round all-number dates are written, judged over the whole file: one
 * export writes every date the same way, so a single 25/02/2026 settles what
 * 04/03/2026 means. A two-digit year settles nothing — 25/02/03 may be a year
 * first — so those files are asked about.
 */
export function dateOrderEvidence(table: CsvTable, columns: ColumnMap, headerIndex = table.headerIndex): DateOrderEvidence {
  let monthFirst = 0
  let dayFirst = 0
  let unsettled = 0
  let example: string | null = null
  for (const row of dataRows(table, headerIndex)) {
    for (const field of ['payment_date', 'invoice_date'] as const) {
      const index = columns[field]
      const cell = index === undefined ? undefined : row[index]
      const parts = numericDateParts(cell)
      if (!cell || !parts) continue
      const { first, second, year } = parts
      if (first <= 12 && second > 12) monthFirst += 1
      else if (first > 12 && second <= 12 && year.length === 4) dayFirst += 1
      else if (first > 12 && second <= 12) {
        unsettled += 1
        example ??= cell.trim()
      } else if (first !== second && first <= 12) {
        unsettled += 1
        example ??= cell.trim()
      }
    }
  }
  const evidence = { monthFirst, dayFirst, example }
  if (monthFirst > 0 && dayFirst > 0) return { ...evidence, order: null, question: 'mixed' }
  if (dayFirst > 0) return { ...evidence, order: 'day-first', question: null }
  if (monthFirst > 0) return { ...evidence, order: 'month-first', question: null }
  return unsettled > 0 ? { ...evidence, order: null, question: 'ambiguous' } : { ...evidence, order: 'month-first', question: null }
}

const amountsIn = (rows: string[][], index: number | undefined) =>
  index === undefined ? [] : rows.map((row) => parseCurrency(row[index])).filter((amount): amount is number => amount !== null && amount !== 0)

/** Every invoice amount the file gives is negative too, so flipping payments without them would break the comparison. */
export function invoiceAmountsAllNegative(table: CsvTable, columns: ColumnMap, headerIndex = table.headerIndex): boolean {
  const amounts = amountsIn(dataRows(table, headerIndex), columns.invoice_amount)
  return amounts.length > 0 && amounts.every((amount) => amount < 0)
}

export interface NegativePayments {
  count: number
  /** The first negative amount, as the file writes it. */
  example: string
}

/** Set when every row that would import pays a negative amount. Such a file holds no payments as far as detection is concerned. */
export function negativePayments(table: CsvTable, columns: ColumnMap, dateOrder: DateOrder, headerIndex = table.headerIndex): NegativePayments | null {
  const { vendor, payment_date: date, amount_paid: paid } = columns
  if (vendor === undefined || date === undefined || paid === undefined) return null
  let count = 0
  let example: string | null = null
  for (const row of dataRows(table, headerIndex)) {
    const amount = parseCurrency(row[paid])
    if (!amount || !(row[vendor] ?? '').trim() || !parseDate(row[date], dateOrder)) continue
    if (amount > 0) return null
    count += 1
    example ??= row[paid].trim()
  }
  return example === null ? null : { count, example }
}

/**
 * Whether a file can be imported as it stands: every required heading is
 * recognised once, its dates can only be read one way, and it holds payments.
 * When so, `dateOrder` is the order to read it in.
 */
export function readsWithoutAsking(table: CsvTable): { ask: false; dateOrder: DateOrder } | { ask: true } {
  const { columns, recognized, ambiguous } = suggestColumns(table)
  if (REQUIRED_FIELDS.some((field) => !recognized.includes(field)) || Object.keys(ambiguous).length > 0) return { ask: true }
  const { order } = dateOrderEvidence(table, columns)
  if (order === null || negativePayments(table, columns, order)) return { ask: true }
  return { ask: false, dateOrder: order }
}

/** A table with enough columns to hold a vendor, a date and an amount, and at least one row under its headings. */
export function canMatchColumns(table: CsvTable): boolean {
  return (table.rows[table.headerIndex] ?? []).length >= REQUIRED_FIELDS.length && dataRows(table).length > 0
}

/** How the file was read, when that took more than recognising its headings. */
export function readingNotes(reading: ImportReading | undefined): string[] {
  if (!reading) return []
  const notes: string[] = []
  if (reading.titleLines > 0) notes.push(`Headings found on row ${reading.headerRow}; ${reading.titleLines} line${reading.titleLines === 1 ? '' : 's'} above them skipped.`)
  if (reading.columns) notes.push(`Columns matched by hand: ${(Object.entries(reading.columns) as [CsvField, string][]).map(([field, heading]) => `${FIELD_LABELS[field].toLowerCase()} from “${heading}”`).join(', ')}.`)
  if (reading.dateOrder) notes.push(`Dates read ${reading.dateOrder === 'day-first' ? 'day first' : 'month first'}.`)
  if (reading.signFlipped) notes.push('Negative amounts read as payments (sign flipped).')
  return notes
}
