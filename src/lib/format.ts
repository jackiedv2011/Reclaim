const VENDOR_SUFFIXES = new Set(['inc', 'llc', 'ltd', 'co', 'corp'])

/** Lowercase, trim, collapse whitespace, strip trailing punctuation and common
 * legal suffixes so the same vendor matches across minor spelling variants. */
export function normalizeVendor(vendor: string): string {
  const cleaned = vendor
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,]+$/g, '')

  const words = cleaned.split(' ')
  while (words.length > 1 && VENDOR_SUFFIXES.has(words[words.length - 1].replace(/[.,]/g, ''))) {
    words.pop()
  }
  return words.join(' ').trim()
}

/**
 * Strip currency symbols/commas and parse a complete number. Returns null for
 * blank/na. Accounting-style "(150.00)" is read as a negative, since that is
 * how most ledgers export credits.
 */
export function parseCurrency(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'na' || trimmed.toLowerCase() === 'n/a') return null
  const parenthesized = /^\((.*)\)$/.exec(trimmed)
  const unsigned = (parenthesized ? `-${parenthesized[1]}` : trimmed).replace(/[$\s]/g, '')
  // Commas are only accepted as US thousands separators. "1.234,56" or "1,23"
  // is some other convention, and reading it as 1.23456 or 123 would put a
  // wrong amount in the ledger without anyone noticing — so the row is skipped.
  if (!/^-?(?:(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)$/.test(unsigned)) return null
  const value = Number(unsigned.replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

/** Whole cents, so two amounts compare the way a bookkeeper reads them rather than as floats. */
export function toCents(value: number): number {
  return Math.round(value * 100)
}

function buildLocalDate(y: number, m: number, d: number): Date | null {
  const date = new Date(y, m - 1, d)
  if (Number.isNaN(date.getTime())) return null
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null
}

export type DateOrder = 'month-first' | 'day-first'

const MONTHS: Record<string, number> = {}
;['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].forEach((name, index) => {
  MONTHS[name] = index + 1
  MONTHS[name.slice(0, 3)] = index + 1
})
MONTHS.sept = 9

/** Two-digit years are how Excel writes m/d/yy; 00–69 are 2000s, 70–99 are 1900s. */
function fullYear(raw: string): number {
  return raw.length === 2 ? (Number(raw) < 70 ? 2000 : 1900) + Number(raw) : Number(raw)
}

/** The parts of a date written only in numbers whose day and month could be either way round, as they stand in the cell. */
export function numericDateParts(raw: string | null | undefined): { first: number; second: number; year: string } | null {
  const match = raw?.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})$/)
  return match ? { first: Number(match[1]), second: Number(match[2]), year: match[3] } : null
}

const GAP = '(?:\\s*[-/,]\\s*|\\.?,?\\s+)'
const DAY = '(\\d{1,2})(?:st|nd|rd|th)?'
const YEAR = "'?(\\d{4}|\\d{2})"
const WEEKDAY = /^(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:day|nesday|rsday|sday|urday)?[.,]?\s+/
const DAY_MONTH_YEAR = new RegExp(`^${DAY}${GAP}([a-z]+)${GAP}${YEAR}$`)
const MONTH_DAY_YEAR = new RegExp(`^([a-z]+)${GAP}${DAY}${GAP}${YEAR}$`)
const YEAR_MONTH_DAY = new RegExp(`^(\\d{4})${GAP}([a-z]+)${GAP}${DAY}$`)

/** "4 Mar 2026", "04-Mar-26", "March 4, 2026", "Wed, 4th March 2026", "2026-Mar-04". The month is spelled out, so there is no order to ask about. */
function parseMonthNameDate(value: string): Date | null {
  const text = value.toLowerCase().replace(WEEKDAY, '')
  const build = (year: string, month: string, day: string) => (Object.hasOwn(MONTHS, month) ? buildLocalDate(fullYear(year), MONTHS[month], Number(day)) : null)
  const dayFirst = text.match(DAY_MONTH_YEAR)
  if (dayFirst) return build(dayFirst[3], dayFirst[2], dayFirst[1])
  const monthFirst = text.match(MONTH_DAY_YEAR)
  if (monthFirst) return build(monthFirst[3], monthFirst[1], monthFirst[2])
  const yearFirst = text.match(YEAR_MONTH_DAY)
  if (yearFirst) return build(yearFirst[1], yearFirst[2], yearFirst[3])
  return null
}

/**
 * Parse a date cell as a local date (avoids UTC off-by-one). Accepts the
 * formats accounting exports actually use: ISO `YYYY-MM-DD` (with or without a
 * time suffix), `YYYY/MM/DD`, a month written as a word, and an all-number
 * `04/03/2026`, which is read in `order`. The caller decides the order for the
 * whole file (see dateOrderEvidence in csvMapping.ts); a date that does not
 * exist in that order is null, so the row is reported as skipped rather than
 * quietly read the other way round.
 */
export function parseDate(raw: string | null | undefined, order: DateOrder = 'month-first'): Date | null {
  if (raw === null || raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'na' || trimmed.toLowerCase() === 'n/a') return null

  const iso = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/)
  if (iso) return buildLocalDate(Number(iso[1]), Number(iso[2]), Number(iso[3]))

  const numeric = numericDateParts(trimmed)
  if (numeric) {
    const [month, day] = order === 'month-first' ? [numeric.first, numeric.second] : [numeric.second, numeric.first]
    return buildLocalDate(fullYear(numeric.year), month, day)
  }

  return parseMonthNameDate(trimmed)
}

export function daysBetween(a: Date, b: Date): number {
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.round((b.getTime() - a.getTime()) / msPerDay)
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}

export function formatDate(date: Date | null): string {
  if (!date) return '—'
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
}

export interface ParsedTerms {
  discountPct: number
  discountDays: number
  netDays: number
}

/** Above this an "early-payment discount" is almost certainly a keying error, and claiming it would ask a vendor for most of an invoice back. */
const MAX_DISCOUNT_PCT = 10

/**
 * Parse early-payment terms into discount %, discount window, and net days.
 * Accepts the spellings exports actually use — "2/10 net 30", "2/10, n/30",
 * "2% 10 net 30", "2/10 N30" — and rejects terms that cannot be real
 * (0% or implausibly large discounts, a window no shorter than the net period).
 */
export function parseTerms(raw: string | null): ParsedTerms | null {
  if (!raw) return null
  const match = raw
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*%?\s*(?:\/\s*|\s+)(\d+)\s*(?:days?)?\s*[,/]?\s*(?:net|n)\s*\/?\s*(\d+)$/i)
  if (!match) return null
  const [, pct, discountDays, netDays] = match
  const terms = {
    discountPct: parseFloat(pct),
    discountDays: parseInt(discountDays, 10),
    netDays: parseInt(netDays, 10),
  }
  if (!(terms.discountPct > 0 && terms.discountPct <= MAX_DISCOUNT_PCT)) return null
  if (!(terms.discountDays > 0 && terms.discountDays < terms.netDays)) return null
  return terms
}

/**
 * The last four digits of a bank account, however the export wrote them:
 * "****1234", "x1234", "acct ending 1234", or "457" after a spreadsheet
 * dropped the leading zero. Null when there are no digits at all.
 */
export function normalizeAccountLast4(raw: string | null): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  return digits.slice(-4).padStart(4, '0')
}

/**
 * `1 payment` / `2 payments`. Finding explanations are read by a controller who
 * is deciding whether to chase a vendor for money — "1 extra payment(s)" reads
 * like a machine wrote it, which is exactly the wrong impression to give.
 */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return count === 1 ? singular : pluralForm
}
