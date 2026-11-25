/**
 * Money on screen, in the currency the records are in. Amounts in different
 * currencies are never added into one figure: totals are kept per currency.
 */
import { sumMoney } from '@/lib/claims'
import type { APRecord, Finding } from '@/types'

/** Rows of one finding that disagree on currency. Shown as a plain number: naming any currency would be a guess. */
export const UNKNOWN_CURRENCY = 'Unknown'

const formats = new Map<string, Intl.NumberFormat | null>()
function formatFor(currency: string, cents: boolean): Intl.NumberFormat | null {
  const key = `${currency}|${cents}`
  if (!formats.has(key)) {
    let format: Intl.NumberFormat | null = null
    try {
      format = new Intl.NumberFormat('en-US', { style: 'currency', currency, ...(cents ? {} : { minimumFractionDigits: 0, maximumFractionDigits: 0 }) })
    } catch {
      // Not a currency code the browser knows: fall back to the number and the code.
    }
    formats.set(key, format)
  }
  return formats.get(key)!
}

const plain = (cents: boolean) => new Intl.NumberFormat('en-US', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })

/** An amount in its own currency: $1,200.00, €1,200.00, or a plain 1,200.00 when the currency isn't known. */
export function formatMoney(value: number, currency: string, options: { cents?: boolean } = {}): string {
  const cents = options.cents ?? true
  if (currency === UNKNOWN_CURRENCY) return plain(cents).format(value)
  return formatFor(currency, cents)?.format(value) ?? `${plain(cents).format(value)} ${currency}`
}

const code = (value: string | null | undefined) => value?.trim().toUpperCase() || null

/**
 * Currency for money that moves (in recovery, recovered). It may come from an
 * attested obligation even when the source CSV omitted its column, but is never
 * assumed: unknown currency keeps unattested money out of the USD totals.
 */
export function currencyOf(finding: Finding): string {
  if (finding.currency) return finding.currency
  const obligation = finding.evidence?.obligation
  if (obligation?.reference?.trim() && obligation.confirmedBy?.trim() && code(obligation.currency)) return code(obligation.currency)!
  return UNKNOWN_CURRENCY
}

/**
 * Currency for exposure figures (flagged, payments to verify, by check), which
 * are never money owed. Reclaim only supports USD, so a payment row with no
 * currency (a file without a currency column) is read as USD. A finding stays
 * 'Unknown' only when its rows disagree, e.g. one in EUR and one blank.
 */
export function exposureCurrencyOf(finding: Finding): string {
  const known = currencyOf(finding)
  if (known !== UNKNOWN_CURRENCY) return known
  const currencies = new Set(finding.relatedRecords.map((r) => code(r.currency) ?? 'USD'))
  return currencies.size === 1 ? [...currencies][0] : UNKNOWN_CURRENCY
}

/** An amount on a finding, in the finding's currency. */
export function findingMoney(finding: Finding, value: number, options?: { cents?: boolean }): string {
  return formatMoney(value, exposureCurrencyOf(finding), options)
}

/** One row's amount. A row with no currency beside rows that have one is left without a symbol. */
export function recordMoney(record: APRecord, value: number, rows: APRecord[]): string {
  return formatMoney(value, code(record.currency) ?? (rows.some((r) => code(r.currency)) ? UNKNOWN_CURRENCY : 'USD'))
}

/**
 * A finding's wording in its own currency. Findings saved before amounts knew
 * their currency say "$" whatever the file was in.
 */
export function moneyText(text: string, currency: string): string {
  if (currency === 'USD') return text
  return text.replace(/(?<![A-Za-z$])\$(\d[\d,]*(?:\.\d{1,2})?)/g, (_match, digits: string) => formatMoney(Number(digits.replace(/,/g, '')), currency))
}

/** Totals per currency, largest first; no figure ever mixes two. */
export function totalsByCurrency(amounts: Array<{ amount: number; currency: string }>): Array<{ currency: string; amount: number }> {
  const totals = new Map<string, number[]>()
  for (const { amount, currency } of amounts) totals.set(currency, [...(totals.get(currency) ?? []), amount])
  return [...totals].map(([currency, values]) => ({ currency, amount: sumMoney(values) })).sort((a, b) => b.amount - a.amount)
}

/** "€300.00 and 400.00 with no single currency": the totals a USD figure leaves out. Null when there are none. */
export function otherCurrencies(byCurrency: Record<string, number>): string | null {
  const parts = Object.entries(byCurrency)
    .filter(([currency, amount]) => currency !== 'USD' && amount > 0)
    .map(([currency, amount]) => (currency === UNKNOWN_CURRENCY ? `${formatMoney(amount, currency)} with no single currency` : formatMoney(amount, currency)))
  return parts.length ? parts.join(' and ') : null
}
