/**
 * Header → canonical column proposals for uploaded AP exports.
 *
 * Order of trust:
 * 1. A known export format (KNOWN_FORMATS, matched by header-set signature).
 * 2. Exact alias matches from the parser's own COLUMN_ALIASES table.
 * 3. Deterministic local heuristics (token similarity to aliases). These are
 *    only ever proposals: they put the mapping into `pending_confirmation` and
 *    are never applied without a person confirming them.
 *
 * Ambiguity is never resolved by guessing: two headers claiming one canonical
 * field, one header plausibly meaning two fields, duplicate header names, and
 * date/decimal conventions the parser would misread all stop the mapping in
 * `pending_confirmation` or `conflict`.
 *
 * `applyMapping` only rewrites the header row, so `parseCsv` keeps doing all
 * value parsing with its existing strictness. No parsing is reimplemented here.
 *
 * Nothing in this module logs or returns row values; issues name headers and
 * canonical fields only.
 */
import Papa from 'papaparse'
import { COLUMN_ALIASES } from '../lib/csv.ts'
import { checksum } from '../lib/sourceIdentity.ts'
import type { MappingStatus, ReportType } from '../contracts/financial.ts'

export const MAPPING_ALGORITHM_VERSION = 1 as const

/** Every canonical column the parser understands. */
export const CANONICAL_FIELDS: readonly string[] = Array.from(new Set(Object.values(COLUMN_ALIASES)))
/** Without these, `parseCsv` rejects every row. */
export const REQUIRED_FIELDS: readonly string[] = ['vendor', 'payment_date', 'amount_paid']
/**
 * Fields that drive a detection rule or a record's import identity
 * (recordIdentity uses company, source_account, transaction_id and
 * transaction_type). Changing which header feeds one of these is material and
 * needs re-confirmation. Only `category` is presentation-only.
 */
export const RULE_DRIVING_FIELDS: readonly string[] = CANONICAL_FIELDS.filter((f) => f !== 'category')

export const MAX_HEADERS = 500
export const MAX_HEADER_LENGTH = 256
export const MAX_SAMPLE_ROWS = 200
/** A heuristic proposal needs at least this similarity to be offered at all. */
export const HEURISTIC_MIN_SCORE = 0.6
/** Two candidates closer than this are ambiguous; neither is proposed. */
export const HEURISTIC_AMBIGUITY_MARGIN = 0.15

// ---------------------------------------------------------------- types

/** How slash dates in the file are ordered. The parser only reads month-first. */
export type DateOrder = 'month_first' | 'day_first' | 'unknown'
/** The decimal separator in amounts. The parser only reads dot decimals. */
export type DecimalSeparator = 'dot' | 'comma' | 'unknown'
export interface MappingLocale {
  dateOrder: DateOrder
  decimal: DecimalSeparator
}

export interface ColumnAssignment {
  /** Normalized header key (lowercase, non-alphanumerics → `_`). */
  key: string
  /** The header as written in the file (display only). */
  header: string
  canonical: string | null
}

/** A mapping keyed by header key, so it survives column reordering. */
export interface ColumnMapping {
  signature: string
  formatId: string | null
  columns: ColumnAssignment[]
  locale: MappingLocale
}

export type ProposalSource = 'known_format' | 'exact_alias' | 'heuristic' | 'none'

export interface ColumnProposal {
  index: number
  header: string
  key: string
  /** Null when nothing matched, or when the match is ambiguous and left for a person. */
  canonical: string | null
  confidence: number
  source: ProposalSource
  reason: string
  alternatives: Array<{ canonical: string; confidence: number }>
  needsConfirmation: boolean
}

export type MappingIssueCode =
  | 'no_headers'
  | 'too_many_columns'
  | 'duplicate_header'
  | 'canonical_collision'
  | 'ambiguous_header'
  | 'heuristic_unconfirmed'
  | 'missing_required'
  | 'unknown_canonical'
  | 'date_order_ambiguous'
  | 'date_day_first'
  | 'date_order_inconsistent'
  | 'decimal_comma'
  | 'decimal_inconsistent'
  | 'locale_unconfirmed'
  | 'signature_mismatch'

/**
 * `conflict` issues cannot be confirmed away: the file or mapping must change.
 * `confirm` issues need a person to look and confirm before import.
 */
export interface MappingIssue {
  code: MappingIssueCode
  severity: 'conflict' | 'confirm'
  message: string
  fields: string[]
  headers: string[]
}

export interface MappingProposal {
  algorithmVersion: typeof MAPPING_ALGORITHM_VERSION
  signature: string
  status: MappingStatus
  formatId: string | null
  reportType: ReportType
  proposals: ColumnProposal[]
  /** The mapping a confirmation would store. Heuristic and ambiguous columns are left unmapped until a person chooses. */
  mapping: ColumnMapping
  issues: MappingIssue[]
  /** Canonical fields waiting on a person. */
  pendingFields: string[]
  missingRequired: string[]
}

export interface KnownFormat {
  id: string
  label: string
  reportType: ReportType
  headers: readonly string[]
  /** header key → canonical (null = deliberately not imported). */
  mapping: Readonly<Record<string, string | null>>
  locale: MappingLocale
  signature: string
}

// ---------------------------------------------------------------- headers and signatures

/** The same normalization `parseCsv` applies before alias lookup. */
export function headerKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** The canonical column `parseCsv` itself would give this header, or null. */
export function parserCanonical(header: string): string | null {
  return COLUMN_ALIASES[headerKey(header)] ?? null
}

/**
 * Order-insensitive signature of a header row: the same export with columns
 * reordered keeps its signature; any added, removed or renamed column changes it.
 */
export function formatSignature(headers: readonly string[]): string {
  const keys = headers.map(headerKey).sort()
  return `hdr1_${checksum(`${keys.length}\n${keys.join('\n')}`)}`
}

function defineFormat(f: Omit<KnownFormat, 'signature'>): KnownFormat {
  return { ...f, signature: formatSignature(f.headers) }
}

const US_LOCALE: MappingLocale = { dateOrder: 'month_first', decimal: 'dot' }

/**
 * Export layouts recognised without confirmation. The QuickBooks layouts are
 * modelled on the standard report columns and should be checked against a
 * real export before relying on them; matching is by exact header set.
 */
export const KNOWN_FORMATS: readonly KnownFormat[] = [
  defineFormat({
    id: 'reclaim_template',
    label: 'Reclaim AP template',
    reportType: 'bills_with_payments',
    headers: ['vendor', 'invoice_number', 'invoice_date', 'payment_date', 'invoice_amount', 'amount_paid', 'terms', 'bank_account_last4', 'category', 'currency'],
    mapping: {
      vendor: 'vendor', invoice_number: 'invoice_number', invoice_date: 'invoice_date', payment_date: 'payment_date',
      invoice_amount: 'invoice_amount', amount_paid: 'amount_paid', terms: 'terms', bank_account_last4: 'bank_account_last4',
      category: 'category', currency: 'currency',
    },
    locale: US_LOCALE,
  }),
  defineFormat({
    id: 'generic_ap_payments',
    label: 'Generic AP payment export',
    reportType: 'bills_with_payments',
    headers: ['Supplier', 'Invoice No', 'Invoice Date', 'Date Paid', 'Invoice Total', 'Payment Amount', 'Payment Terms', 'Currency'],
    mapping: {
      supplier: 'vendor', invoice_no: 'invoice_number', invoice_date: 'invoice_date', date_paid: 'payment_date',
      invoice_total: 'invoice_amount', payment_amount: 'amount_paid', payment_terms: 'terms', currency: 'currency',
    },
    locale: US_LOCALE,
  }),
  defineFormat({
    id: 'quickbooks_bill_payment_list',
    label: 'QuickBooks bill payment list',
    reportType: 'payments',
    headers: ['Date', 'Transaction Type', 'Num', 'Vendor', 'Account', 'Amount'],
    // "Num" on a bill payment is the check/payment number, not the vendor's
    // invoice number; mapping it to invoice_number would group unrelated bills.
    mapping: { date: 'payment_date', transaction_type: 'transaction_type', num: 'transaction_id', vendor: 'vendor', account: 'source_account', amount: 'amount_paid' },
    locale: US_LOCALE,
  }),
  defineFormat({
    id: 'quickbooks_bill_list',
    label: 'QuickBooks bill list (bills only, no payments)',
    reportType: 'bills',
    headers: ['Date', 'Num', 'Vendor', 'Due Date', 'Amount', 'Open Balance'],
    // A bill list says what was owed, not what was paid. There is deliberately
    // no payment_date or amount_paid here: the bill date and amount are not payments.
    mapping: { date: 'invoice_date', num: 'invoice_number', vendor: 'vendor', due_date: null, amount: 'invoice_amount', open_balance: null },
    locale: US_LOCALE,
  }),
]

export function matchKnownFormat(headers: readonly string[]): KnownFormat | null {
  const signature = formatSignature(headers)
  return KNOWN_FORMATS.find((f) => f.signature === signature) ?? null
}

/**
 * A coarse report-type guess from header names alone, for when no known format
 * or caller hint says. Bill-only signals (due date, open balance) without any
 * payment column mean the file cannot establish payments.
 */
export function inferReportType(headers: readonly string[], canonicals: ReadonlyArray<string | null> = headers.map(parserCanonical)): ReportType {
  const keys = new Set(headers.map(headerKey))
  const mapped = new Set(canonicals.filter((c): c is string => c !== null))
  const billSignals = ['due_date', 'open_balance', 'balance_due', 'amount_due', 'bill_status'].some((k) => keys.has(k))
  const hasPayment = mapped.has('payment_date') && mapped.has('amount_paid')
  if (!hasPayment) return billSignals || mapped.has('invoice_amount') ? 'bills' : 'unknown'
  if (billSignals) return 'unknown'
  return mapped.has('invoice_amount') || mapped.has('invoice_date') ? 'bills_with_payments' : 'payments'
}

// ---------------------------------------------------------------- heuristics

const STOPWORDS = new Set(['the', 'of', 'name', 'a', 'an'])
const TOKEN_SYNONYMS: Record<string, string> = {
  vendor: 'vendor', supplier: 'vendor', payee: 'vendor', merchant: 'vendor', creditor: 'vendor', beneficiary: 'vendor', seller: 'vendor',
  inv: 'invoice', invoice: 'invoice', bill: 'invoice',
  no: 'number', num: 'number', nbr: 'number', nr: 'number', number: 'number',
  amt: 'amount', amount: 'amount', total: 'amount', sum: 'amount',
  paid: 'payment', payment: 'payment', pmt: 'payment', pay: 'payment', disbursement: 'payment', disbursed: 'payment',
  check: 'payment', cheque: 'payment', remittance: 'payment', settled: 'payment', cleared: 'payment',
  dt: 'date', date: 'date',
  acct: 'account', acc: 'account', account: 'account',
  ccy: 'currency', cur: 'currency', curr: 'currency', currency: 'currency',
  txn: 'transaction', trans: 'transaction', transaction: 'transaction',
  id: 'id', identifier: 'id', code: 'id', key: 'id',
  ref: 'reference', reference: 'reference',
  term: 'terms', terms: 'terms',
  category: 'category', gl: 'category', ledger: 'category', expense: 'category', class: 'category',
  last4: 'last4', last: 'last4', ending: 'last4',
  company: 'company', entity: 'company', subsidiary: 'company',
  type: 'type', kind: 'type',
}

/** Extra phrasings per canonical field, used only for heuristic scoring (never by the parser). */
const HEURISTIC_PHRASES: Record<string, readonly string[]> = {
  vendor: ['pay to', 'vendor name'],
  invoice_number: ['reference', 'vendor reference', 'document number', 'doc number', 'supplier invoice'],
  payment_date: ['paid on', 'check date', 'cleared date', 'posting date', 'transaction date', 'settlement date'],
  amount_paid: ['total paid', 'net paid', 'check amount', 'disbursement amount', 'debit amount'],
  invoice_amount: ['invoice value', 'gross invoice', 'bill total'],
  transaction_id: ['transaction reference', 'payment reference', 'check number'],
  bank_account_last4: ['bank account', 'remit to account'],
  currency: ['ccy'],
}

function conceptTokens(header: string): string[] {
  const spaced = header.slice(0, MAX_HEADER_LENGTH).replace(/([a-z])([A-Z])/g, '$1 $2')
  const tokens = headerKey(spaced)
    .split('_')
    .filter((t) => t !== '' && !STOPWORDS.has(t))
    .map((t) => TOKEN_SYNONYMS[t] ?? t)
    // "Last 4" → last4 + "4": the bare digit adds nothing once last4 is there.
    .filter((t, _i, all) => !(t === '4' && all.includes('last4')))
  return Array.from(new Set(tokens))
}

function dice(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  const shared = a.filter((t) => setB.has(t)).length
  return (2 * shared) / (a.length + b.length)
}

const CANDIDATE_PHRASES: ReadonlyArray<{ canonical: string; tokens: string[] }> = (() => {
  const out: Array<{ canonical: string; tokens: string[] }> = []
  for (const [alias, canonical] of Object.entries(COLUMN_ALIASES)) out.push({ canonical, tokens: conceptTokens(alias) })
  for (const [canonical, phrases] of Object.entries(HEURISTIC_PHRASES)) for (const p of phrases) out.push({ canonical, tokens: conceptTokens(p) })
  return out.filter((c) => c.tokens.length > 0)
})()

/** Every canonical field this header resembles, best first, with a similarity in [0, 1]. Deterministic. */
export function scoreHeader(header: string): Array<{ canonical: string; confidence: number }> {
  const tokens = conceptTokens(header)
  if (tokens.length === 0) return []
  const best = new Map<string, number>()
  for (const c of CANDIDATE_PHRASES) {
    const s = dice(tokens, c.tokens)
    if (s > (best.get(c.canonical) ?? 0)) best.set(c.canonical, s)
  }
  return Array.from(best, ([canonical, confidence]) => ({ canonical, confidence: Math.round(confidence * 1000) / 1000 }))
    .filter((c) => c.confidence > 0)
    .sort((a, b) => b.confidence - a.confidence || a.canonical.localeCompare(b.canonical))
}

// ---------------------------------------------------------------- locale

const DATE_FIELDS = new Set(['payment_date', 'invoice_date'])
const AMOUNT_FIELDS = new Set(['amount_paid', 'invoice_amount'])

export interface DateEvidence { monthFirst: number; dayFirst: number; ambiguous: number; iso: number }
export interface AmountEvidence { dot: number; comma: number }

export function dateEvidence(values: readonly string[]): DateEvidence {
  const e: DateEvidence = { monthFirst: 0, dayFirst: 0, ambiguous: 0, iso: 0 }
  for (const raw of values) {
    const v = raw.trim()
    if (/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/.test(v)) { e.iso += 1; continue }
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(v)
    if (!m) continue
    const a = Number(m[1])
    const b = Number(m[2])
    if (a > 12 && b <= 12) e.dayFirst += 1
    else if (b > 12 && a <= 12) e.monthFirst += 1
    else if (a !== b && a <= 12 && b <= 12) e.ambiguous += 1
  }
  return e
}

export function amountEvidence(values: readonly string[]): AmountEvidence {
  const e: AmountEvidence = { dot: 0, comma: 0 }
  for (const raw of values) {
    const v = raw.replace(/[^\d.,]/g, '')
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(v) || /^\d+,\d{1,2}$/.test(v)) e.comma += 1
    else if (/^\d{1,3}(,\d{3})+\.\d{1,2}$/.test(v) || /^\d+\.\d{1,2}$/.test(v)) e.dot += 1
  }
  return e
}

/**
 * Detect the file's date order and decimal separator from sample values in
 * the mapped date and amount columns. `defaultLocale` (from a known format, or
 * the parser's documented month-first convention for alias headers) settles
 * samples that carry no evidence either way; it never overrides contrary evidence.
 */
export function detectLocale(
  mapping: Pick<ColumnMapping, 'columns'>,
  headers: readonly string[],
  sampleRows: readonly (readonly string[])[],
  defaultLocale: MappingLocale | null,
): { locale: MappingLocale; issues: MappingIssue[] } {
  const issues: MappingIssue[] = []
  const byKey = new Map(mapping.columns.map((c) => [c.key, c.canonical]))
  const dateCols: number[] = []
  const amountCols: number[] = []
  headers.forEach((h, i) => {
    const canonical = byKey.get(headerKey(h)) ?? null
    if (canonical && DATE_FIELDS.has(canonical)) dateCols.push(i)
    if (canonical && AMOUNT_FIELDS.has(canonical)) amountCols.push(i)
  })
  const rows = sampleRows.slice(0, MAX_SAMPLE_ROWS)
  const pick = (cols: number[]) => rows.flatMap((r) => cols.map((i) => r[i]).filter((v): v is string => typeof v === 'string'))
  const fieldsOf = (cols: number[]) => Array.from(new Set(cols.map((i) => byKey.get(headerKey(headers[i])) ?? ''))).filter(Boolean)
  const headersOf = (cols: number[]) => cols.map((i) => headers[i])

  const d = dateEvidence(pick(dateCols))
  let dateOrder: DateOrder
  if (d.dayFirst > 0 && d.monthFirst > 0) {
    dateOrder = 'unknown'
    issues.push({ code: 'date_order_inconsistent', severity: 'conflict', message: 'Date columns mix day-first and month-first dates, so no single reading is safe.', fields: fieldsOf(dateCols), headers: headersOf(dateCols) })
  } else if (d.dayFirst > 0) {
    dateOrder = 'day_first'
    issues.push({ code: 'date_day_first', severity: 'conflict', message: 'Dates are written day-first. The importer reads slash dates month-first, so these would be misread or rejected. Re-export with ISO (YYYY-MM-DD) or US dates.', fields: fieldsOf(dateCols), headers: headersOf(dateCols) })
  } else if (d.monthFirst > 0) {
    dateOrder = 'month_first'
  } else if (d.ambiguous > 0) {
    dateOrder = defaultLocale?.dateOrder ?? 'unknown'
    if (dateOrder === 'unknown') issues.push({ code: 'date_order_ambiguous', severity: 'confirm', message: 'Every sampled date reads validly as both month-first and day-first. Confirm the date order before import.', fields: fieldsOf(dateCols), headers: headersOf(dateCols) })
  } else {
    dateOrder = defaultLocale?.dateOrder ?? 'month_first'
  }

  const a = amountEvidence(pick(amountCols))
  let decimal: DecimalSeparator
  if (a.comma > 0 && a.dot > 0) {
    decimal = 'unknown'
    issues.push({ code: 'decimal_inconsistent', severity: 'conflict', message: 'Amount columns mix comma-decimal and dot-decimal values.', fields: fieldsOf(amountCols), headers: headersOf(amountCols) })
  } else if (a.comma > 0) {
    decimal = 'comma'
    issues.push({ code: 'decimal_comma', severity: 'conflict', message: 'Amounts use a comma as the decimal separator. The importer only reads dot decimals and would reject these rows. Re-export with dot decimals.', fields: fieldsOf(amountCols), headers: headersOf(amountCols) })
  } else {
    decimal = defaultLocale?.decimal ?? 'dot'
  }
  return { locale: { dateOrder, decimal }, issues }
}

// ---------------------------------------------------------------- proposal

function uniq(values: Iterable<string>): string[] {
  return Array.from(new Set(values))
}

function statusFrom(issues: readonly MappingIssue[], fallback: MappingStatus): MappingStatus {
  if (issues.some((i) => i.severity === 'conflict')) return 'conflict'
  if (issues.some((i) => i.severity === 'confirm')) return 'pending_confirmation'
  return fallback
}

/**
 * Propose a mapping for a header row. `sampleRows` are the first data rows as
 * arrays aligned with `headers`; they are only inspected for date/decimal
 * conventions and never copied into the result.
 */
export function proposeColumnMapping(headers: readonly string[], sampleRows: readonly (readonly string[])[] = []): MappingProposal {
  const signature = formatSignature(headers)
  const issues: MappingIssue[] = []
  const emptyMapping = (): ColumnMapping => ({ signature, formatId: null, columns: [], locale: { dateOrder: 'unknown', decimal: 'unknown' } })

  if (headers.length === 0 || headers.every((h) => headerKey(h) === '')) {
    issues.push({ code: 'no_headers', severity: 'conflict', message: 'The file has no header row.', fields: [...REQUIRED_FIELDS], headers: [] })
    return { algorithmVersion: MAPPING_ALGORITHM_VERSION, signature, status: 'conflict', formatId: null, reportType: 'unknown', proposals: [], mapping: emptyMapping(), issues, pendingFields: [...REQUIRED_FIELDS], missingRequired: [...REQUIRED_FIELDS] }
  }
  if (headers.length > MAX_HEADERS) {
    issues.push({ code: 'too_many_columns', severity: 'conflict', message: `The file has ${headers.length} columns; at most ${MAX_HEADERS} are supported.`, fields: [], headers: [] })
    return { algorithmVersion: MAPPING_ALGORITHM_VERSION, signature, status: 'conflict', formatId: null, reportType: 'unknown', proposals: [], mapping: emptyMapping(), issues, pendingFields: [...REQUIRED_FIELDS], missingRequired: [...REQUIRED_FIELDS] }
  }

  const known = matchKnownFormat(headers)
  const proposals: ColumnProposal[] = headers.map((header, index) => {
    const key = headerKey(header)
    if (known) {
      const canonical = known.mapping[key] ?? null
      return { index, header, key, canonical, confidence: 1, source: canonical ? 'known_format' : 'none', reason: canonical ? `Known format: ${known.label}.` : `Not imported in ${known.label}.`, alternatives: [], needsConfirmation: false }
    }
    const alias = COLUMN_ALIASES[key] ?? null
    if (alias) return { index, header, key, canonical: alias, confidence: 1, source: 'exact_alias', reason: 'Exact match to a recognised column name.', alternatives: [], needsConfirmation: false }
    const scored = scoreHeader(header).filter((s) => s.confidence >= HEURISTIC_MIN_SCORE)
    if (scored.length === 0) return { index, header, key, canonical: null, confidence: 0, source: 'none', reason: 'No recognised column resembles this header; it will not be imported.', alternatives: [], needsConfirmation: false }
    const [best, second] = scored
    if (second && best.confidence - second.confidence < HEURISTIC_AMBIGUITY_MARGIN) {
      return { index, header, key, canonical: null, confidence: best.confidence, source: 'heuristic', reason: `Could mean ${scored.slice(0, 3).map((s) => s.canonical).join(' or ')}; choose one.`, alternatives: scored.slice(0, 3), needsConfirmation: true }
    }
    return { index, header, key, canonical: best.canonical, confidence: best.confidence, source: 'heuristic', reason: `Resembles ${best.canonical}; confirm before import.`, alternatives: scored.slice(1, 3), needsConfirmation: true }
  })

  // Duplicate header names: the parser silently renames the second copy, so a
  // mapped duplicate would feed one field from an arbitrary column.
  const byKey = new Map<string, ColumnProposal[]>()
  for (const p of proposals) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p])
  for (const [key, group] of byKey) {
    // Blank header cells (trailing delimiters from spreadsheets) are never imported.
    if (group.length < 2 || key === '') continue
    const mapped = group.some((p) => p.canonical !== null || p.alternatives.length > 0)
    issues.push({
      code: 'duplicate_header',
      severity: mapped ? 'conflict' : 'confirm',
      message: mapped ? 'The same column name appears more than once and maps to a recognised field; rename one copy before import.' : 'The same column name appears more than once; neither copy will be imported.',
      fields: uniq(group.map((p) => p.canonical).filter((c): c is string => c !== null)),
      headers: group.map((p) => p.header || `(blank column ${p.index + 1})`),
    })
    if (mapped) for (const p of group) p.needsConfirmation = true
  }

  // Heuristic proposals never displace a known or exact column.
  const firm = new Map<string, ColumnProposal[]>()
  for (const p of proposals) if (p.canonical && p.source !== 'heuristic') firm.set(p.canonical, [...(firm.get(p.canonical) ?? []), p])
  for (const p of proposals) {
    if (p.source !== 'heuristic' || !p.canonical || !firm.has(p.canonical)) continue
    p.alternatives = [{ canonical: p.canonical, confidence: p.confidence }, ...p.alternatives]
    p.canonical = null
    p.needsConfirmation = false
    p.reason = 'Resembles a field another column already provides; it will not be imported.'
  }

  // Two headers claiming one canonical field.
  const claims = new Map<string, ColumnProposal[]>()
  for (const p of proposals) if (p.canonical) claims.set(p.canonical, [...(claims.get(p.canonical) ?? []), p])
  for (const [canonical, group] of claims) {
    if (group.length < 2) continue
    const firmCollision = group.filter((p) => p.source !== 'heuristic').length > 1
    issues.push({
      code: 'canonical_collision',
      severity: firmCollision ? 'conflict' : 'confirm',
      message: `${group.length} columns would all feed ${canonical}; choose one.`,
      fields: [canonical],
      headers: group.map((p) => p.header),
    })
    if (!firmCollision) {
      for (const p of group) {
        if (p.source !== 'heuristic') continue
        p.alternatives = [{ canonical, confidence: p.confidence }, ...p.alternatives.filter((a) => a.canonical !== canonical)]
        p.canonical = null
        p.needsConfirmation = true
        p.reason = `Several columns resemble ${canonical}; choose one.`
      }
    } else {
      for (const p of group) p.needsConfirmation = true
    }
  }

  for (const p of proposals) {
    if (p.source !== 'heuristic' || !p.needsConfirmation) continue
    const fields = p.canonical ? [p.canonical] : p.alternatives.map((a) => a.canonical)
    issues.push({
      code: p.canonical ? 'heuristic_unconfirmed' : 'ambiguous_header',
      severity: 'confirm',
      message: p.canonical ? `"${p.header}" looks like ${p.canonical} but was not an exact match; confirm it.` : `"${p.header}" could mean ${fields.join(' or ')}; choose one or leave it unmapped.`,
      fields,
      headers: [p.header],
    })
  }

  // The confirmable mapping carries heuristic suggestions, so confirming the proposal as-is accepts them.
  // Ambiguous and colliding heuristic columns are already null: a person must choose.
  const suggested: ColumnAssignment[] = proposals.map((p) => ({ key: p.key, header: p.header, canonical: p.canonical }))
  const allAlias = !known && proposals.every((p) => p.source !== 'heuristic')
  const defaultLocale = known ? known.locale : allAlias ? US_LOCALE : null
  const { locale, issues: localeIssues } = detectLocale({ columns: suggested }, headers, sampleRows, defaultLocale)
  issues.push(...localeIssues)

  const mappedFields = new Set(suggested.map((c) => c.canonical).filter((c): c is string => c !== null))
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mappedFields.has(f))
  const ambiguousFor = new Set(proposals.filter((p) => !p.canonical).flatMap((p) => (p.needsConfirmation ? p.alternatives.map((a) => a.canonical) : [])))
  if (missingRequired.length > 0 && !known) {
    issues.push({
      code: 'missing_required',
      severity: 'confirm',
      message: `No column provides ${missingRequired.join(', ')}; rows cannot be imported until one is mapped.`,
      fields: missingRequired,
      headers: [],
    })
  }

  const reportType = known ? known.reportType : inferReportType(headers, suggested.map((c) => c.canonical))
  const status = statusFrom(issues, 'known_format')
  const pendingFields = uniq([
    ...issues.filter((i) => i.code !== 'no_headers').flatMap((i) => i.fields),
    ...ambiguousFor,
    ...(known ? [] : missingRequired),
  ]).sort()

  return {
    algorithmVersion: MAPPING_ALGORITHM_VERSION,
    signature,
    status,
    formatId: known ? known.id : allAlias ? 'alias_headers' : null,
    reportType,
    proposals,
    mapping: { signature, formatId: known ? known.id : allAlias ? 'alias_headers' : null, columns: suggested, locale },
    issues,
    pendingFields: status === 'known_format' ? [] : pendingFields,
    missingRequired,
  }
}

// ---------------------------------------------------------------- validation, application, diff

/**
 * Problems that make a mapping unsafe to store or apply. Empty means the
 * mapping can be confirmed. Never inspects row values.
 */
export function validateMapping(mapping: ColumnMapping, opts: { requireRequiredFields?: boolean } = {}): MappingIssue[] {
  const issues: MappingIssue[] = []
  const canonicalSet = new Set(CANONICAL_FIELDS)
  if (mapping.columns.length === 0) issues.push({ code: 'no_headers', severity: 'conflict', message: 'The mapping has no columns.', fields: [], headers: [] })
  if (mapping.columns.length > MAX_HEADERS) issues.push({ code: 'too_many_columns', severity: 'conflict', message: `At most ${MAX_HEADERS} columns are supported.`, fields: [], headers: [] })

  const keyGroups = new Map<string, ColumnAssignment[]>()
  for (const c of mapping.columns) keyGroups.set(c.key, [...(keyGroups.get(c.key) ?? []), c])
  for (const group of keyGroups.values()) {
    if (group.length > 1 && group.some((c) => c.canonical !== null)) {
      issues.push({ code: 'duplicate_header', severity: 'conflict', message: 'A mapped column name appears more than once.', fields: uniq(group.map((c) => c.canonical).filter((c): c is string => c !== null)), headers: group.map((c) => c.header) })
    }
  }
  const claimGroups = new Map<string, ColumnAssignment[]>()
  for (const c of mapping.columns) {
    if (c.canonical === null) continue
    if (!canonicalSet.has(c.canonical)) issues.push({ code: 'unknown_canonical', severity: 'conflict', message: `${c.canonical} is not a recognised field.`, fields: [c.canonical], headers: [c.header] })
    claimGroups.set(c.canonical, [...(claimGroups.get(c.canonical) ?? []), c])
  }
  for (const [canonical, group] of claimGroups) {
    if (group.length > 1) issues.push({ code: 'canonical_collision', severity: 'conflict', message: `${group.length} columns feed ${canonical}.`, fields: [canonical], headers: group.map((c) => c.header) })
  }
  const keys = mapping.columns.map((c) => c.key)
  if (keys.length > 0 && formatSignature(keys) !== mapping.signature) {
    issues.push({ code: 'signature_mismatch', severity: 'conflict', message: 'The mapping does not describe the header row it claims to.', fields: [], headers: [] })
  }
  if (mapping.locale.dateOrder !== 'month_first') {
    issues.push({ code: mapping.locale.dateOrder === 'day_first' ? 'date_day_first' : 'locale_unconfirmed', severity: 'conflict', message: 'Only month-first slash dates (or ISO dates) can be imported.', fields: ['payment_date', 'invoice_date'], headers: [] })
  }
  if (mapping.locale.decimal !== 'dot') {
    issues.push({ code: mapping.locale.decimal === 'comma' ? 'decimal_comma' : 'locale_unconfirmed', severity: 'conflict', message: 'Only dot-decimal amounts can be imported.', fields: ['amount_paid', 'invoice_amount'], headers: [] })
  }
  if (opts.requireRequiredFields ?? true) {
    const mapped = new Set(mapping.columns.map((c) => c.canonical))
    const missing = REQUIRED_FIELDS.filter((f) => !mapped.has(f))
    if (missing.length > 0) issues.push({ code: 'missing_required', severity: 'conflict', message: `No column provides ${missing.join(', ')}.`, fields: missing, headers: [] })
  }
  return issues
}

export class MappingConflictError extends Error {
  readonly issues: MappingIssue[]
  constructor(issues: MappingIssue[]) {
    super(`Column mapping has unresolved conflicts: ${uniq(issues.map((i) => i.code)).join(', ')}`)
    this.name = 'MappingConflictError'
    this.issues = issues
  }
}

const MAX_SNIFF_ROWS = 10
const BOM = String.fromCharCode(0xfeff)

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** The header row and up to `maxRows` data rows, as the parser would split them. For proposals only. */
export function readHeaderAndSample(csvText: string, maxRows = MAX_SAMPLE_ROWS): { headers: string[]; sampleRows: string[][] } {
  const text = stripBom(csvText)
  if (text.trim() === '') return { headers: [], sampleRows: [] }
  const parsed = Papa.parse<string[]>(text, { header: false, skipEmptyLines: true, preview: Math.max(1, Math.min(maxRows, MAX_SAMPLE_ROWS) + 1) })
  const [headers = [], ...rows] = parsed.data
  return { headers: headers.map((h) => String(h)), sampleRows: rows.map((r) => r.map((v) => String(v))) }
}

/**
 * Index where the header row ends (at its line break, or end of text). Papa's
 * `meta.cursor` with `preview: 1` can run past the first row, so the boundary
 * is found directly: the first line break outside a quoted field.
 */
function headerRowEnd(text: string, linebreak: string): number {
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '"') inQuotes = !inQuotes
    else if (!inQuotes && text.startsWith(linebreak, i)) return i
  }
  return text.length
}

/**
 * Rewrite only the header row so `parseCsv` sees canonical names, leaving every
 * data byte untouched. Columns mapped to null whose own name the parser would
 * recognise are renamed out of the way, so an unmapped column is never picked
 * up by alias. Throws MappingConflictError for a mapping that is not safe to
 * apply (collisions, duplicates, unknown fields, unsupported locale), or when
 * the file's header row does not match the mapping's signature.
 *
 * When the mapping changes nothing the parser would not already do, the
 * original text is returned unchanged (same bytes, same file checksum).
 */
export function applyMapping(csvText: string, mapping: ColumnMapping): string {
  const conflicts = validateMapping(mapping, { requireRequiredFields: false })
  if (conflicts.length > 0) throw new MappingConflictError(conflicts)

  const hadBom = csvText.charCodeAt(0) === 0xfeff
  const text = stripBom(csvText)
  if (text.trim() === '') return csvText
  const sniff = Papa.parse<string[]>(text, { header: false, preview: MAX_SNIFF_ROWS })
  const delimiter = sniff.meta.delimiter
  const first = Papa.parse<string[]>(text, { header: false, preview: 1, delimiter })
  const headers = (first.data[0] ?? []).map((h) => String(h))
  if (formatSignature(headers) !== mapping.signature) {
    throw new MappingConflictError([{ code: 'signature_mismatch', severity: 'conflict', message: 'The file header row does not match this mapping.', fields: [], headers: [] }])
  }

  const target = new Map(mapping.columns.map((c) => [c.key, c.canonical]))
  const taken = new Set(headers.map((h) => h.trim()))
  let changed = false
  const out = headers.map((h) => {
    const canonical = target.get(headerKey(h)) ?? null
    const parserSees = parserCanonical(h)
    if (canonical === parserSees) return h
    changed = true
    if (canonical !== null) return canonical
    // Unmapped but parser-recognisable: give it a name no alias matches.
    let renamed = `${h.trim()} (unmapped)`
    while (taken.has(renamed)) renamed = `${renamed}_`
    taken.add(renamed)
    return renamed
  })
  if (!changed) return csvText

  const linebreak = first.meta.linebreak || '\n'
  const headerEnd = headerRowEnd(text, linebreak)
  const newHeader = Papa.unparse([out], { delimiter, newline: linebreak, quotes: false })
  return `${hadBom ? BOM : ''}${newHeader}${text.slice(headerEnd)}`
}

export interface MappingChange {
  field: string
  from: string | null
  to: string | null
  material: boolean
}
export interface MappingDiff {
  material: boolean
  changes: MappingChange[]
}

/**
 * What changed between two mappings, by canonical field. A change is material
 * when a rule-driving or identity field is fed from a different header (or
 * lost or gained), or the date/decimal convention changed.
 */
export function diffMappings(prev: ColumnMapping, next: ColumnMapping): MappingDiff {
  const sourceOf = (m: ColumnMapping) => {
    const out = new Map<string, string>()
    for (const c of m.columns) if (c.canonical) out.set(c.canonical, c.key)
    return out
  }
  const a = sourceOf(prev)
  const b = sourceOf(next)
  const changes: MappingChange[] = []
  for (const field of uniq([...a.keys(), ...b.keys()]).sort()) {
    const from = a.get(field) ?? null
    const to = b.get(field) ?? null
    if (from !== to) changes.push({ field, from, to, material: RULE_DRIVING_FIELDS.includes(field) })
  }
  if (prev.locale.dateOrder !== next.locale.dateOrder) changes.push({ field: 'locale.dateOrder', from: prev.locale.dateOrder, to: next.locale.dateOrder, material: true })
  if (prev.locale.decimal !== next.locale.decimal) changes.push({ field: 'locale.decimal', from: prev.locale.decimal, to: next.locale.decimal, material: true })
  return { material: changes.some((c) => c.material), changes }
}
