import { formatMoney, UNKNOWN_CURRENCY } from '../money'

/**
 * A per-check total for display: USD in the viewer's headline style, anything
 * else in its own currency. Rows that disagree on currency show a plain number.
 */
export function formatCauseValue(value: number, currency: string, money: (value: number) => string): string {
  return currency === 'USD' ? money(value) : formatMoney(value, currency)
}

/** "Flagged exposure · Unknown" reads as an error; say what it means. */
export function currencyLabel(currency: string): string {
  return currency === UNKNOWN_CURRENCY ? 'currency not known' : currency
}

/** Dollars as typed ("6,800" or "$6800.50") to whole cents, without floating point. 0 when it isn't an amount. */
export function dollarsToCents(text: string): number {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text.replace(/[$,\s]/g, ''))
  if (!match) return 0
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : 0
}
