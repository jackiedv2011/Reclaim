import Papa from 'papaparse'
import type { ImportReading } from '@/types'
import { numericDateParts, parseDate, parseMoney, type AmountStyle, type DateOrder } from '@/lib/format'

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
/** A number that names something. "Payment No" is one; "Check Amount" is not. */
const IDENTIFIER_HEADING = /(^|_)(no|num|number|id|ref|reference|code|zip|postcode|phone|year|line|row|qty|quantity)$|^(check|cheque|account|acct)$/
/** Dates and amounts of money still owed. They may be what a file offers, but they are never proposed as a payment. */
const UNPAID_HEADING = /(^|_)(due|balance|outstanding|open|unpaid|remaining|expected)(_|$)/

/** Title lines are only looked for this far down, and never past the first payment. */
const HEADER_SCAN_ROWS = 200
const SAMPLE_CELLS = 200
/** A column counts as dates or amounts when most of its filled cells read that way; total and note lines are the exceptions. */
const COLUMN_SHARE = 0.6
/** Below this share of the dates, a few that only work one way look more like typing mistakes than proof. */
const PROOF_SHARE = 0.25
/** A date that contradicts this many others is a mistake in its row, not a question about the file. */
const OUTVOTED = 20
/** Payments missing a vendor, past which the vendor is probably written once above each group. */
const GROUPED_SHARE = 0.3

/** The file has no heading row: every row is data and columns go by their letters. */
export const NO_HEADINGS = -1

export interface CsvTable {
  text: string
  /** Every row of the file, blank lines included, so position + 1 is the row number a spreadsheet shows. */
  rows: string[][]
  /** Position of the row the headings were found on, or NO_HEADINGS. */
  headerIndex: number
  /** Things about the file itself a person has to know, such as a quotation mark that is never closed. */
  warnings: string[]
  /** The sheet of a workbook this came from, and the others it left out. */
  sheet?: { name: string; others: string[] }
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
const readsAsAmount = (cell: string) => parseMoney(cell) !== null || parseMoney(cell, 'comma') !== null

/** A row with a date in one cell and an amount in another: a payment, whatever its columns are called. */
function looksLikeData(row: string[]): boolean {
  const filled = row.filter((cell) => cell.trim() !== '')
  if (filled.length < REQUIRED_FIELDS.length) return false
  return filled.some((cell, index) => readsAsDate(cell) && filled.some((other, at) => at !== index && !readsAsDate(other) && readsAsAmount(other)))
}

const DELIMITERS = [',', '\t', ';', '|']

/** Papa Parse judges the first ten lines, which can all be titles. When that finds no table, take the delimiter that makes one. */
function delimiterOf(text: string): string {
  const guess = Papa.parse<string[]>(text, { preview: HEADER_SCAN_ROWS, skipEmptyLines: true })
  const tableRows = (rows: string[][]) => rows.filter((row) => row.length >= REQUIRED_FIELDS.length).length
  if (tableRows(guess.data) * 2 >= guess.data.length) return guess.meta.delimiter
  let best = guess.meta.delimiter
  let most = tableRows(guess.data)
  for (const delimiter of DELIMITERS) {
    const count = tableRows(Papa.parse<string[]>(text, { delimiter, preview: HEADER_SCAN_ROWS, skipEmptyLines: true }).data)
    if (count > most) {
      best = delimiter
      most = count
    }
  }
  return best
}

export function readCsvTable(text: string): CsvTable {
  // Some exports mix line endings; with one kind throughout, no row is run into the next. Line breaks inside cells are single already.
  const even = /\r\n/.test(text) && /[^\r]\n/.test(text) ? text.replace(/\r\n/g, '\n') : text
  // Every line is kept, blank ones too, so row numbers match the file.
  const parsed = Papa.parse<string[]>(even, { delimiter: delimiterOf(even), skipEmptyLines: false })
  const unclosed = parsed.errors.find((error) => error.code === 'MissingQuotes')
  const warnings = unclosed ? [`A quotation mark on row ${(unclosed.row ?? 0) + 1} is never closed, so everything after it was read as part of one cell. Fix that row and upload the file again.`] : []
  return tableOf(text, parsed.data, warnings)
}

/** A table from rows already split into cells: a CSV's, or a worksheet's. */
export function tableOf(text: string, rows: string[][], warnings: string[] = [], sheet?: CsvTable['sheet']): CsvTable {
  const kept = [...rows]
  while (kept.length > 0 && isBlankRow(kept[kept.length - 1])) kept.pop()
  return { text, rows: kept, headerIndex: findHeaderRow(kept), warnings, ...(sheet ? { sheet } : {}) }
}

/**
 * Exports often start with a company name, a report title and a date range.
 * The heading row is above the first payment: the first row naming everything
 * a payment needs, or else the one that reads most like headings, or else the
 * last wide line of text. Nothing at or below the first payment is considered,
 * so a second block further down can never turn real payments into "title
 * lines". When the file opens with payments, it has no headings.
 */
function findHeaderRow(rows: string[][]): number {
  const texts: number[] = []
  let first: number | null = null
  let foundData = false
  const nextFilled = (from: number) => {
    for (let index = from + 1; index < rows.length; index += 1) if (!isEmptyRow(rows[index])) return rows[index]
    return null
  }
  for (let index = 0; index < rows.length && index < HEADER_SCAN_ROWS; index += 1) {
    if (isEmptyRow(rows[index])) continue
    first ??= index
    const cells = rows[index].filter((cell) => cell.trim() !== '')
    const known = new Set(cells.map(recognizedField).filter((field) => field !== null))
    if (REQUIRED_FIELDS.every((field) => known.has(field))) return index
    if (looksLikeData(rows[index])) {
      const next = nextFilled(index)
      foundData = true
      // One row like this above a line of text is a title ("Run date, 2026-01-31, Page, 1"); payments come in rows.
      if (next === null || looksLikeData(next) || texts.length > 0) break
      continue
    }
    if (cells.length >= 2 && (known.size >= 2 || !cells.some((cell) => readsAsDate(cell) || readsAsAmount(cell)))) texts.push(index)
  }
  if (first === null) return 0
  const wide = texts.filter((index) => rows[index].filter((cell) => cell.trim() !== '').length >= REQUIRED_FIELDS.length)
  const pool = wide.length > 0 ? wide : texts
  let best: number | null = null
  let bestScore = 0
  for (const index of pool) {
    const score = headingScore(rows[index].filter((cell) => cell.trim() !== ''))
    if (score > bestScore) {
      best = index
      bestScore = score
    }
  }
  if (best !== null) return best
  if (pool.length > 0 && !(foundData && looksLikeData(rows[first]))) return foundData ? pool[pool.length - 1] : pool[0]
  return foundData ? NO_HEADINGS : first
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

/** The row of headings; empty when the file has none. */
export function headingsOf(table: CsvTable, headerIndex = table.headerIndex): string[] {
  return headerIndex === NO_HEADINGS ? [] : table.rows[headerIndex] ?? []
}

/** How many columns the file has: its headings, or wider if its rows are. */
export function columnCount(table: CsvTable, headerIndex = table.headerIndex): number {
  let width = headingsOf(table, headerIndex).length
  for (let position = headerIndex + 1; position < table.rows.length; position += 1) {
    const row = table.rows[position]
    let last = row.length
    while (last > width && row[last - 1].trim() === '') last -= 1
    if (last > width) width = last
  }
  return width
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
  /** The vendor is written on a line of its own above each group of payments. */
  vendorGrouped: boolean
  /** Many payments name no vendor, whether or not the file is grouped. */
  vendorMissing: boolean
}

export function dataRows(table: CsvTable, headerIndex = table.headerIndex): string[][] {
  return table.rows.slice(headerIndex + 1).filter((row) => !isEmptyRow(row))
}

/** Which column supplies which field, as far as the headings and cells say. Two possible date or amount columns are never chosen between. */
export function suggestColumns(table: CsvTable, headerIndex = table.headerIndex): ColumnSuggestion {
  const headings = headingsOf(table, headerIndex)
  const rows = dataRows(table, headerIndex)
  const width = columnCount(table, headerIndex)
  const heading = (index: number) => headings[index] ?? ''
  const columns: ColumnMap = {}
  const recognized: CsvField[] = []
  const suggested: CsvField[] = []
  const ambiguous: ColumnSuggestion['ambiguous'] = {}

  const byField = new Map<CsvField, number[]>()
  headings.forEach((name, index) => {
    const field = recognizedField(name)
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

  const unclaimed = Array.from({ length: width }, (_, index) => index).filter((index) => recognizedField(heading(index)) === null)
  const suggest = (field: CsvField, candidates: number[]) => {
    if (byField.has(field)) return
    if (candidates.length > 1) ambiguous[field] = candidates
    else if (candidates.length === 1 && !UNPAID_HEADING.test(headingKey(heading(candidates[0])))) {
      columns[field] = candidates[0]
      suggested.push(field)
    }
  }
  const hinted = (field: CsvField) => unclaimed.filter((index) => HEADING_HINTS[field]?.includes(headingKey(heading(index)).replaceAll('_', '')))

  // The first filled cells of each column, however far down they start: a refunds column may be empty for hundreds of rows.
  const samples = new Map<number, string[]>()
  const filled = (index: number): string[] => {
    const known = samples.get(index)
    if (known) return known
    const cells: string[] = []
    for (const row of rows) {
      const cell = (row[index] ?? '').trim()
      if (cell !== '') cells.push(cell)
      if (cells.length >= SAMPLE_CELLS) break
    }
    samples.set(index, cells)
    return cells
  }
  const mostly = (cells: string[], test: (cell: string) => boolean) => cells.length > 0 && cells.filter(test).length / cells.length >= COLUMN_SHARE
  const dates = unclaimed.filter((index) => !IDENTIFIER_HEADING.test(headingKey(heading(index))) && mostly(filled(index), readsAsDate))
  const amounts = unclaimed.filter((index) => {
    const key = headingKey(heading(index))
    if (dates.includes(index) || IDENTIFIER_HEADING.test(key)) return false
    const cells = filled(index)
    if (cells.length === 0) return false
    // An amount heading counts even when its cells can't be read: choosing around it would be a guess.
    if (AMOUNT_WORD.test(key) && mostly(cells, (cell) => /\d/.test(cell))) return true
    return mostly(cells, readsAsAmount) && cells.some((cell) => /[.$€£,()-]/.test(cell))
  })
  const text = (index: number) => !dates.includes(index) && !amounts.includes(index)

  suggest('payment_date', dates)
  suggest('amount_paid', amounts)
  suggest('vendor', hinted('vendor').filter(text))
  suggest('invoice_number', hinted('invoice_number').filter(text))
  suggest('transaction_type', hinted('transaction_type').filter(text))

  const { payment_date: date, amount_paid: paid } = columns
  let vendorGrouped = false
  let vendorMissing = false
  if (date !== undefined && paid !== undefined) {
    const payments = rows.filter((row) => readsAsDate((row[date] ?? '').trim()) && readsAsAmount((row[paid] ?? '').trim()))
    const missing = (index: number) => payments.filter((row) => (row[index] ?? '').trim() === '').length
    const often = (index: number) => payments.length > 0 && missing(index) / payments.length >= GROUPED_SHARE
    // A name alone on its line. Blank vendors without one are just blank: bank fees, say, which belong to nobody above them.
    const namedLines = (index: number) => rows.some((row) => (row[index] ?? '').trim() !== '' && !/^(grand )?total\b/i.test(row[index].trim()) && row.filter((cell) => cell.trim() !== '').length === 1)
    const grouped = (index: number) => often(index) && namedLines(index)
    if (columns.vendor !== undefined) {
      vendorMissing = often(columns.vendor)
      vendorGrouped = grouped(columns.vendor)
    }
    else if (!ambiguous.vendor && !byField.has('vendor')) {
      const index = unclaimed.find((candidate) => candidate !== date && candidate !== paid && heading(candidate).trim() === '' && grouped(candidate))
      if (index !== undefined) {
        columns.vendor = index
        suggested.push('vendor')
        vendorGrouped = true
        vendorMissing = true
      }
    }
  }
  return { columns, recognized, suggested, ambiguous, vendorGrouped, vendorMissing }
}

/** Rows that could import: an amount, and a vendor of their own or, in a grouped file, from above. Totals and notes say nothing about how a file is written. */
function paymentLike(table: CsvTable, columns: ColumnMap, headerIndex: number, vendorGrouped: boolean): string[][] {
  const { vendor, amount_paid: paid } = columns
  if (paid === undefined) return dataRows(table, headerIndex)
  return dataRows(table, headerIndex).filter((row) => readsAsAmount((row[paid] ?? '').trim()) && (vendorGrouped || vendor === undefined || (row[vendor] ?? '').trim() !== ''))
}

export interface DateOrderEvidence {
  /** The order the file itself proves, or null when a person has to say. */
  order: DateOrder | null
  /** Why there is no proven order: nearly every date works both ways, or different dates prove different orders. */
  question: 'ambiguous' | 'mixed' | null
  /** Dates that only work month first / only day first. */
  monthFirst: number
  dayFirst: number
  /** A date whose meaning depends on the answer. */
  example: string | null
}

/**
 * Which way round all-number dates are written, judged over the whole file: one
 * export writes every date the same way, so dates like 25/02/2026 settle what
 * 04/03/2026 means. One of them among dozens that work both ways settles
 * nothing, because it may be a typing mistake; nor does a two-digit year,
 * because 25/02/03 may be a year first. Those files are asked about.
 */
export function dateOrderEvidence(table: CsvTable, columns: ColumnMap, headerIndex = table.headerIndex, vendorGrouped = false): DateOrderEvidence {
  let monthFirst = 0
  let dayFirst = 0
  let unsettled = 0
  let example: string | null = null
  for (const row of paymentLike(table, columns, headerIndex, vendorGrouped)) {
    for (const field of ['payment_date', 'invoice_date'] as const) {
      const index = columns[field]
      const cell = index === undefined ? undefined : row[index]
      const parts = numericDateParts(cell)
      if (!cell || !parts) continue
      const { first, second, year } = parts
      if (first <= 12 && second > 12) monthFirst += 1
      else if (first > 12 && second <= 12 && year.length === 4) dayFirst += 1
      else if (second <= 12 && first !== second) {
        unsettled += 1
        example ??= cell.trim()
      }
    }
  }
  const evidence = { monthFirst, dayFirst, example }
  const proofs = Math.max(monthFirst, dayFirst)
  const against = Math.min(monthFirst, dayFirst)
  if (proofs === 0) return unsettled > 0 ? { ...evidence, order: null, question: 'ambiguous' } : { ...evidence, order: 'month-first', question: null }
  if (against > 0 && against * OUTVOTED > proofs) return { ...evidence, order: null, question: 'mixed' }
  if (unsettled > 0 && proofs < (proofs + unsettled) * PROOF_SHARE) return { ...evidence, order: null, question: 'ambiguous' }
  return { ...evidence, order: dayFirst > monthFirst ? 'day-first' : 'month-first', question: null }
}

export interface AmountStyleEvidence {
  /** How the file writes amounts, or null when a person has to say. */
  style: AmountStyle | null
  /** An amount whose size depends on the answer. */
  example: string | null
}

/**
 * How the file writes decimals. A decimal comma has to be proven by more than
 * one amount, with nothing against it: "1,500" is against it, because in such a
 * file it would be one and a half. When the only separators are like 1.500,
 * which is either 1,500 or 1.5, a person has to say.
 */
export function amountStyleOf(table: CsvTable, columns: ColumnMap, headerIndex = table.headerIndex): AmountStyleEvidence {
  let comma = 0
  let point = 0
  let groupedByComma = 0
  let threeDecimals: string | null = null
  for (const row of dataRows(table, headerIndex)) {
    for (const index of [columns.amount_paid, columns.invoice_amount]) {
      const cell = index === undefined ? '' : (row[index] ?? '').trim()
      if (cell === '') continue
      const asPoint = parseMoney(cell) !== null
      const asComma = parseMoney(cell, 'comma') !== null
      if (asComma && !asPoint) comma += 1
      else if (asPoint && !asComma) point += 1
      else if (asPoint && /\d,\d{3}(?!\d)/.test(cell)) groupedByComma += 1
      else if (asPoint && parseMoney(cell, 'point-strict') === null) threeDecimals ??= cell
    }
  }
  if (comma >= 2 && point === 0 && groupedByComma === 0) return { style: 'comma', example: null }
  if (comma > 0) return { style: 'point-strict', example: null }
  return threeDecimals !== null && point === 0 && groupedByComma === 0 ? { style: null, example: threeDecimals } : { style: 'point', example: null }
}

export interface NegativePayments {
  negative: number
  positive: number
  /** The first negative amount, as the file writes it. */
  example: string
}

/** Set when most of the rows that would import pay a negative amount: the export probably writes payments as negatives. */
export function negativePayments(table: CsvTable, columns: ColumnMap, options: { dateOrder: DateOrder; amountStyle?: AmountStyle; headerIndex?: number; vendorGrouped?: boolean }): NegativePayments | null {
  const { vendor, payment_date: date, amount_paid: paid } = columns
  if (vendor === undefined || date === undefined || paid === undefined) return null
  let negative = 0
  let positive = 0
  let example: string | null = null
  for (const row of dataRows(table, options.headerIndex ?? table.headerIndex)) {
    const amount = parseMoney(row[paid], options.amountStyle)?.amount
    if (!amount || !parseDate(row[date], options.dateOrder) || (!options.vendorGrouped && !(row[vendor] ?? '').trim())) continue
    if (amount > 0) positive += 1
    else {
      negative += 1
      example ??= row[paid].trim()
    }
  }
  return example !== null && negative > positive ? { negative, positive, example } : null
}

export interface ReadingChoices {
  dateOrder: DateOrder
  amountStyle: AmountStyle
}

/** Rows above the headings that could be payments rather than titles: never left out without a person seeing it. */
function rowsAboveHeadings(table: CsvTable): boolean {
  return table.rows.slice(0, Math.max(0, table.headerIndex)).some((row) => {
    const filled = row.filter((cell) => cell.trim() !== '')
    return filled.length >= REQUIRED_FIELDS.length && filled.some((cell) => readsAsAmount(cell))
  })
}

/**
 * Whether a file can be imported as it stands: every required heading is
 * recognised once, its dates and amounts can only be read one way, every
 * payment names its vendor, and it holds payments. When so, how to read it.
 */
export function readsWithoutAsking(table: CsvTable): ({ ask: false } & ReadingChoices) | { ask: true } {
  const { columns, recognized, ambiguous, vendorMissing } = suggestColumns(table)
  if (table.headerIndex === NO_HEADINGS || vendorMissing || rowsAboveHeadings(table)) return { ask: true }
  if (REQUIRED_FIELDS.some((field) => !recognized.includes(field)) || NEVER_GUESSED.some((field) => ambiguous[field])) return { ask: true }
  const { order } = dateOrderEvidence(table, columns)
  const { style: amountStyle } = amountStyleOf(table, columns)
  if (order === null || amountStyle === null || negativePayments(table, columns, { dateOrder: order, amountStyle })) return { ask: true }
  return { ask: false, dateOrder: order, amountStyle }
}

/** A table with enough columns to hold a vendor, a date and an amount, and at least one row of data. */
export function canMatchColumns(table: CsvTable): boolean {
  return columnCount(table) >= REQUIRED_FIELDS.length && dataRows(table).length > 0
}

/** The columns worth offering: any with a heading or something in it. */
export function offeredColumns(table: CsvTable, headerIndex = table.headerIndex): number[] {
  const headings = headingsOf(table, headerIndex)
  const used = new Set<number>()
  headings.forEach((heading, index) => { if (heading.trim() !== '') used.add(index) })
  for (let position = headerIndex + 1; position < table.rows.length; position += 1) {
    table.rows[position].forEach((cell, index) => { if (cell.trim() !== '') used.add(index) })
  }
  return [...used].sort((a, b) => a - b)
}

/** How the file was read, when that took more than recognising its headings. */
export function readingNotes(reading: ImportReading | undefined): string[] {
  if (!reading) return []
  const notes: string[] = []
  if (reading.sheet) notes.push(`Read from the sheet “${reading.sheet.name}”${reading.sheet.others.length > 0 ? `; left out: ${reading.sheet.others.map((name) => `“${name}”`).join(', ')}` : ''}.`)
  if (reading.headerRow === 0) notes.push('Read without a heading row; columns go by their letters.')
  if (reading.titleLines > 0) notes.push(`Headings found on row ${reading.headerRow}; ${reading.titleLines} line${reading.titleLines === 1 ? '' : 's'} above them skipped.`)
  if (reading.columns) notes.push(`Columns matched by hand: ${(Object.entries(reading.columns) as [CsvField, string][]).map(([field, heading]) => `${FIELD_LABELS[field].toLowerCase()} from “${heading}”`).join(', ')}.`)
  if (reading.dateOrder) notes.push(`Dates read ${reading.dateOrder === 'day-first' ? 'day first' : 'month first'}.`)
  if (reading.vendorGrouped) notes.push('Vendor names taken from the line above each group of payments.')
  if (reading.decimalComma) notes.push('Amounts read with a decimal comma (1.234,56 is 1,234.56).')
  if (reading.signFlipped) notes.push('Negative amounts read as payments (every sign flipped).')
  return notes
}
