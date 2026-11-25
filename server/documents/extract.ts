/**
 * Deterministic reading of text invoices, remittance advices and supplier
 * statements. It only proposes what a labelled line literally says:
 *
 * - a value is taken only after a recognised label ("Amount due:", "Invoice
 *   no:"), or from a recognised column of a CSV table;
 * - two different readings of a one-per-document field are both kept as
 *   conflicts, never resolved;
 * - a line it can't read with confidence (an amount with no label, a label
 *   with no value, a date that could be day-first or month-first, several
 *   amounts) is listed as ambiguous, which is the only text the optional AI
 *   extraction task may ever see;
 * - lines that look like instructions to a model, and lines with bank
 *   details, are withheld: no fact is read from them and they are never sent;
 * - nothing is inferred. A payment row is a payment row: it says nothing
 *   about delivery, disputes or what is owed.
 */
import { sha256 } from '../sealedJson.ts'
import { splitCsvLine } from './sniff.ts'
import { EXPECTED_FIELDS, markConflicts, type DocumentKind, type FactKind, type ProposedFact } from './facts.ts'

export const PARSER_VERSION = 'reclaim-text-2026-11-25.1'

export type AmbiguityReason = 'unlabelled_amount' | 'label_without_value' | 'several_values' | 'ambiguous_date' | 'decimal_comma'
export type WithheldReason = 'instruction_like' | 'bank_detail'

export interface ExtractionResult {
  documentId: string
  kind: DocumentKind
  parser: string
  facts: ProposedFact[]
  /** Expected for this kind of document and not found. Never filled in by guessing. */
  unknownFields: FactKind[]
  ambiguousLines: Array<{ line: number; reason: AmbiguityReason }>
  /** Not read and never sent anywhere. */
  withheldLines: Array<{ line: number; reason: WithheldReason }>
  warnings: string[]
  lineCount: number
}

type ValueType = 'ref' | 'money' | 'date' | 'currency'
interface Label { kind: FactKind; re: RegExp; type: ValueType }

// Order matters only for ties at the same position: the longer, more specific label wins.
const LABELS: Label[] = [
  { kind: 'credit_applied_to', re: /\b(?:credit\s+)?applied\s+(?:to|against)(?:\s+invoice)?(?:\s*(?:no\.?|number|#))?\s*[:#]?\s*/gi, type: 'ref' },
  { kind: 'credit_note_ref', re: /\bcredit\s+(?:note|memo)\s*(?:no\.?|number|#|ref(?:erence)?|id)?\s*[:#]\s*/gi, type: 'ref' },
  { kind: 'credit_amount', re: /\bcredit\s+(?:amount|total|value)\s*[:#]?\s*/gi, type: 'money' },
  { kind: 'supplier_ref', re: /\b(?:supplier|vendor)\s*(?:id|no\.?|number|#|ref(?:erence)?|code)\s*[:#]?\s*/gi, type: 'ref' },
  { kind: 'invoice_date', re: /\b(?:invoice\s+date|date\s+of\s+invoice|invoice\s+dated)\s*[:#]?\s*/gi, type: 'date' },
  { kind: 'due_date', re: /\b(?:due\s+date|payment\s+due(?:\s+(?:date|by|on))?|due\s+(?:by|on))\s*[:#]?\s*/gi, type: 'date' },
  { kind: 'payment_date', re: /\b(?:payment\s+date|date\s+paid|paid\s+on|value\s+date)\s*[:#]?\s*/gi, type: 'date' },
  { kind: 'payment_ref', re: /\b(?:payment|remittance)\s+(?:ref(?:erence)?|id|no\.?|number)\s*[:#]?\s*/gi, type: 'ref' },
  { kind: 'invoice_ref', re: /\binvoice\s*(?:no\.?|number|#|ref(?:erence)?|id)?\s*[:#]\s*/gi, type: 'ref' },
  { kind: 'amount_due', re: /\b(?:amount\s+due|balance\s+due|total\s+due|total\s+payable|amount\s+payable|please\s+pay)\s*[:#]?\s*/gi, type: 'money' },
  { kind: 'amount_paid', re: /\b(?:amount\s+paid|total\s+paid|payment\s+amount|paid\s+amount|amount\s+remitted)\s*[:#]?\s*/gi, type: 'money' },
  { kind: 'statement_balance', re: /\b(?:closing\s+balance|statement\s+balance|account\s+balance|outstanding\s+balance|balance\s+(?:outstanding|carried\s+forward|brought\s+forward))\s*[:#]?\s*/gi, type: 'money' },
  { kind: 'currency', re: /\bcurrency\s*[:#]?\s*/gi, type: 'currency' },
]

/** Text written to steer a model. Such a line is never read for facts and never sent. */
export const INSTRUCTION_LIKE = /\b(?:ignore|disregard|forget|override|bypass)\b.{0,40}\b(?:instructions?|rules?|previous|above|prompts?|polic(?:y|ies))\b|\bsystem\s+prompt\b|\byou\s+are\s+(?:now\s+)?(?:an?|the)\s+(?:ai|assistant|model|chatbot)\b|\b(?:assistant|system)\s*:|\bsay\b.{0,40}\b(?:owed|owes?|due|payable)\b|\bjailbreak\b/i
const BANK_LINE = /\b(?:iban|swift|bic|routing|aba|sort\s+code|account\s+(?:number|no\.?|#)|acct\.?\s*(?:no|#)|bank\s+details)\b|\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b/i

const ISO_CURRENCY = /\b(USD|EUR|GBP|CAD|AUD|JPY|INR|CHF|NZD)\b/
const SYMBOL_CURRENCY: Record<string, string | null> = { 'US$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', 'C$': 'CAD', 'A$': 'AUD', '$': null }
// An amount is a number with two decimals, or any number next to a currency marker.
const MONEY = /(\(|-\s?)?(US\$|C\$|A\$|\$|€|£|¥|₹|\b(?:USD|EUR|GBP|CAD|AUD|JPY|INR|CHF|NZD)\b)?\s?(\d{1,3}(?:,\d{3})+(?:\.\d{2})?|\d+\.\d{2}|\d+)(\))?(?:\s?\b(USD|EUR|GBP|CAD|AUD|JPY|INR|CHF|NZD)\b)?/g
const DECIMAL_COMMA = /\b\d{1,3}(?:\.\d{3})+,\d{2}\b|\b\d+,\d{2}\b(?!\d)/

export interface MoneyHit { start: number; end: number; minor: number; currency: string | null; explicit: boolean }

/** Every amount in a piece of text, with where it is. Bare integers count only next to a currency marker. */
export function findMoney(text: string): MoneyHit[] {
  const hits: MoneyHit[] = []
  for (const m of text.matchAll(MONEY)) {
    const [whole, neg, prefix, num, close, suffix] = m
    const marker = prefix ?? suffix ?? null
    if (!marker && !/\.\d{2}$/.test(num)) continue
    // A date such as 2026.01.05 or a version number is not money.
    if (!marker && /\d\.\d{2}\.\d/.test(text.slice(m.index, m.index + whole.length + 3))) continue
    const minor = Math.round(Number(num.replace(/,/g, '')) * 100)
    if (!Number.isSafeInteger(minor)) continue
    const negative = Boolean(neg?.includes('-') || (neg === '(' && close === ')'))
    const currency = marker ? (SYMBOL_CURRENCY[marker] !== undefined ? SYMBOL_CURRENCY[marker] : marker.toUpperCase()) : null
    const lead = whole.length - whole.trimStart().length
    hits.push({ start: m.index + lead, end: m.index + whole.length, minor: negative ? -minor : minor, currency, explicit: Boolean(marker) })
  }
  return hits
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n: number) => String(n).padStart(2, '0')
function validDay(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null
}

/** A date at the start of `text`: ISO, "5 March 2026", "March 5, 2026", or numeric when only one reading is possible. */
export function readDate(text: string): { value: string; length: number } | { ambiguous: true; length: number } | null {
  let m = text.match(/^(\d{4})-(\d{2})-(\d{2})\b/)
  if (m) { const v = validDay(+m[1], +m[2], +m[3]); return v ? { value: v, length: m[0].length } : null }
  m = text.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/)
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) { const v = validDay(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]); return v ? { value: v, length: m[0].length } : null }
  m = text.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/)
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) { const v = validDay(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]); return v ? { value: v, length: m[0].length } : null }
  m = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/)
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3]
    const monthFirst = validDay(y, a, b)
    const dayFirst = validDay(y, b, a)
    if (monthFirst && dayFirst && monthFirst !== dayFirst) return { ambiguous: true, length: m[0].length }
    const v = monthFirst ?? dayFirst
    return v ? { value: v, length: m[0].length } : null
  }
  return null
}

const REF = /^[A-Za-z0-9][A-Za-z0-9\-/._]{0,39}/
const STOPWORDS = /^(?:date|due|amount|total|the|and|of|for|on|to|is|n\/?a|none|tbc|tbd|see)$/i

interface Draft { kind: FactKind; value: string; amountMinor?: number; row?: number; line: number; charStart: number; charEnd: number; confidence: ProposedFact['confidence'] }

function labelMatches(line: string): Array<{ label: Label; start: number; end: number }> {
  const found: Array<{ label: Label; start: number; end: number }> = []
  for (const label of LABELS) for (const m of line.matchAll(label.re)) found.push({ label, start: m.index, end: m.index + m[0].length })
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: typeof found = []
  for (const f of found) if (!kept.some((k) => f.start < k.end)) kept.push(f)
  return kept
}

export function extractDocument(input: { documentId: string; kind: DocumentKind; text: string; format: 'text' | 'csv' }): ExtractionResult {
  const lines = input.text.split('\n')
  const drafts: Draft[] = []
  const ambiguous = new Map<number, AmbiguityReason>()
  const withheld: ExtractionResult['withheldLines'] = []
  const warnings = new Set<string>()
  const flag = (line: number, reason: AmbiguityReason) => { if (!ambiguous.has(line)) ambiguous.set(line, reason) }
  const currencyFromMoney = (hit: MoneyHit, lineNo: number, offset: number) => {
    if (hit.currency) drafts.push({ kind: 'currency', value: hit.currency, line: lineNo, charStart: offset + hit.start, charEnd: offset + hit.end, confidence: 'medium' })
  }

  const table = input.format === 'csv' ? csvTable(lines) : null

  lines.forEach((raw, index) => {
    const lineNo = index + 1
    if (!raw.trim()) return
    if (INSTRUCTION_LIKE.test(raw)) { withheld.push({ line: lineNo, reason: 'instruction_like' }); warnings.add('Some lines read like instructions to a computer; they were not read and are never sent anywhere.'); return }
    if (BANK_LINE.test(raw)) { withheld.push({ line: lineNo, reason: 'bank_detail' }); warnings.add('Lines with bank details were not read. Reclaim never takes bank details from a document.'); return }
    if (table && lineNo === table.headerLine) return
    if (table && lineNo > table.headerLine) {
      const cells = splitCsvLine(raw, table.sep)
      readTableRow(cells, table, lineNo, drafts, flag, currencyFromMoney)
      return
    }
    if (DECIMAL_COMMA.test(raw) && !findMoney(raw).length) { flag(lineNo, 'decimal_comma'); return }

    const labels = labelMatches(raw)
    if (!labels.length) {
      if (findMoney(raw).length) flag(lineNo, 'unlabelled_amount')
      return
    }
    labels.forEach((hit, i) => {
      const segEnd = labels[i + 1]?.start ?? raw.length
      const segment = raw.slice(hit.end, segEnd)
      const offset = hit.end
      const kind = hit.label.kind
      if (hit.label.type === 'money') {
        const amounts = findMoney(segment)
        const distinct = new Set(amounts.map((a) => a.minor))
        if (!amounts.length) return flag(lineNo, DECIMAL_COMMA.test(segment) ? 'decimal_comma' : 'label_without_value')
        if (distinct.size > 1) return flag(lineNo, 'several_values')
        const a = amounts[0]
        drafts.push({ kind, value: (a.minor / 100).toFixed(2), amountMinor: a.minor, line: lineNo, charStart: offset + a.start, charEnd: offset + a.end, confidence: 'high' })
        currencyFromMoney(a, lineNo, offset)
      } else if (hit.label.type === 'date') {
        const lead = segment.length - segment.trimStart().length
        const d = readDate(segment.trimStart())
        if (!d) return flag(lineNo, 'label_without_value')
        if ('ambiguous' in d) return flag(lineNo, 'ambiguous_date')
        drafts.push({ kind, value: d.value, line: lineNo, charStart: offset + lead, charEnd: offset + lead + d.length, confidence: 'high' })
      } else if (hit.label.type === 'currency') {
        const iso = segment.match(ISO_CURRENCY)
        const usd = segment.indexOf('US$')
        if (!iso && usd === -1) return flag(lineNo, 'label_without_value')
        const at = iso ? iso.index! : usd
        drafts.push({ kind, value: iso ? iso[1] : 'USD', line: lineNo, charStart: offset + at, charEnd: offset + at + 3, confidence: 'high' })
      } else {
        const lead = segment.length - segment.trimStart().length
        const token = segment.trimStart().match(REF)?.[0]?.replace(/[.,]+$/, '')
        const needsDigit = kind !== 'supplier_ref'
        if (!token || STOPWORDS.test(token) || (needsDigit && !/\d/.test(token)) || token.length < 2) return flag(lineNo, 'label_without_value')
        drafts.push({ kind, value: token, line: lineNo, charStart: offset + lead, charEnd: offset + lead + token.length, confidence: 'high' })
      }
    })
  })

  // Several readings of one field on the same line and value are one fact.
  const seen = new Set<string>()
  const facts: ProposedFact[] = []
  for (const d of drafts) {
    const key = `${d.kind}|${d.row ?? ''}|${d.value}|${d.line}`
    if (seen.has(key)) continue
    seen.add(key)
    const raw = lines[d.line - 1]
    facts.push({
      id: factId(input.documentId, 'deterministic', d.kind, d.line, d.charStart, d.value),
      documentId: input.documentId, kind: d.kind, value: d.value,
      ...(d.amountMinor !== undefined ? { amountMinor: d.amountMinor } : {}),
      ...(d.row !== undefined ? { row: d.row } : {}),
      provenance: { line: d.line, charStart: d.charStart, charEnd: d.charEnd, excerpt: excerptOf(raw) },
      confidence: d.confidence, conflicts: [], origin: 'deterministic',
    })
  }
  // The same currency written on several lines is one reading, not a conflict.
  const marked = markConflicts(dedupeSingleValues(facts))
  if (marked.some((f) => f.conflicts.length)) warnings.add('The document gives different values for the same field. Both are kept; a person must decide.')
  const found = new Set(marked.map((f) => f.kind))
  return {
    documentId: input.documentId, kind: input.kind, parser: PARSER_VERSION, facts: marked,
    unknownFields: EXPECTED_FIELDS[input.kind].filter((k) => !found.has(k)),
    ambiguousLines: [...ambiguous].map(([line, reason]) => ({ line, reason })).sort((a, b) => a.line - b.line),
    withheldLines: withheld, warnings: [...warnings], lineCount: lines.length,
  }
}

/** Repeats of the same single-value fact with the same value (a total printed twice) collapse to the first. */
function dedupeSingleValues(facts: ProposedFact[]): ProposedFact[] {
  const first = new Map<string, ProposedFact>()
  return facts.filter((f) => {
    if (f.row !== undefined) return true
    const key = `${f.kind}|${f.value}`
    if (first.has(key)) return false
    first.set(key, f)
    return true
  })
}

export const excerptOf = (line: string) => line.trim().replace(/\s+/g, ' ').slice(0, 120)

export function factId(documentId: string, origin: string, kind: string, line: number, charStart: number, value: string): string {
  return `fact_${sha256(`${documentId}|${origin}|${kind}|${line}|${charStart}|${value}`).slice(0, 32)}`
}

interface Table { headerLine: number; sep: string; invoiceCol: number | null; amountCol: number | null; dateCol: number | null }

function csvTable(lines: string[]): Table | null {
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    for (const sep of [',', ';', '\t']) {
      const cells = splitCsvLine(lines[i], sep).map((c) => c.value.toLowerCase())
      if (cells.length < 2) continue
      const find = (re: RegExp) => { const at = cells.findIndex((c) => re.test(c) && !/date/.test(c)); return at === -1 ? null : at }
      const invoiceCol = find(/invoice|^inv\b|document|^ref/)
      const amountCol = find(/paid|remitted/) ?? find(/amount/) ?? find(/payment|total|debit|balance/)
      const dateAt = cells.findIndex((c) => /date/.test(c))
      const dateCol = dateAt === -1 ? null : dateAt
      if ((invoiceCol !== null || dateCol !== null) && amountCol !== null) return { headerLine: i + 1, sep, invoiceCol, amountCol, dateCol }
    }
  }
  return null
}

function readTableRow(cells: Array<{ value: string; start: number; end: number }>, table: Table, lineNo: number, drafts: Draft[], flag: (line: number, reason: AmbiguityReason) => void, currencyFromMoney: (hit: MoneyHit, lineNo: number, offset: number) => void) {
  const row = lineNo
  const cell = (i: number | null) => (i === null ? undefined : cells[i])
  const inv = cell(table.invoiceCol)
  if (inv?.value) {
    const token = inv.value.match(REF)?.[0]
    if (token && /\d/.test(token)) drafts.push({ kind: 'line_invoice_ref', value: token, row, line: lineNo, charStart: inv.start, charEnd: inv.end, confidence: 'high' })
  }
  const amt = cell(table.amountCol)
  if (amt?.value) {
    const amounts = findMoney(amt.value)
    const bare = amounts.length === 0 && /^-?\d+$/.test(amt.value) ? [{ start: 0, end: amt.value.length, minor: Number(amt.value) * 100, currency: null, explicit: false }] : amounts
    if (bare.length === 1 && Number.isSafeInteger(bare[0].minor)) {
      drafts.push({ kind: 'line_amount', value: (bare[0].minor / 100).toFixed(2), amountMinor: bare[0].minor, row, line: lineNo, charStart: amt.start, charEnd: amt.end, confidence: 'medium' })
      currencyFromMoney(bare[0], lineNo, amt.start)
    } else flag(lineNo, DECIMAL_COMMA.test(amt.value) ? 'decimal_comma' : bare.length > 1 ? 'several_values' : 'label_without_value')
  }
  const date = cell(table.dateCol)
  if (date?.value) {
    const d = readDate(date.value)
    if (d && 'value' in d) drafts.push({ kind: 'line_date', value: d.value, row, line: lineNo, charStart: date.start, charEnd: date.start + d.length, confidence: 'high' })
    else if (d) flag(lineNo, 'ambiguous_date')
  }
}
