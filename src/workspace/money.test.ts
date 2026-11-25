import { describe, expect, it } from 'vitest'
import type { APRecord, Finding } from '@/types'
import { findingMoney, formatMoney, moneyText, otherCurrencies, recordMoney, totalsByCurrency } from './money'

const record = (currency: string | null) => ({ currency, amountPaid: 100 }) as APRecord
const finding = (...currencies: Array<string | null>) => ({ currency: null, relatedRecords: currencies.map(record) }) as unknown as Finding

describe('money in its own currency', () => {
  it('uses the currency the records are in', () => {
    expect(formatMoney(1200, 'USD')).toBe('$1,200.00')
    expect(formatMoney(1200, 'EUR')).toBe('€1,200.00')
    expect(formatMoney(1200, 'GBP', { cents: false })).toBe('£1,200')
    expect(findingMoney({ ...finding('CAD'), currency: 'CAD' }, 10)).toBe('CA$10.00')
  })
  it('reads a file with no currency column as USD, and rows that disagree as no currency', () => {
    expect(findingMoney(finding(null, null), 10)).toBe('$10.00')
    expect(findingMoney(finding('EUR', null), 10)).toBe('10.00')
    const rows = [record('EUR'), record(null)]
    expect(rows.map((r) => recordMoney(r, 10, rows))).toEqual(['€10.00', '10.00'])
  })
  it('shows a code it does not know rather than failing', () => {
    expect(formatMoney(10, 'US DOLLARS')).toBe('10.00 US DOLLARS')
  })
  it('rewords an explanation saved with dollar signs, and nothing already in another currency', () => {
    expect(moneyText('Paid $1,200.00 against a $900.00 invoice.', 'EUR')).toBe('Paid €1,200.00 against a €900.00 invoice.')
    expect(moneyText('Paid $1,200.00.', 'USD')).toBe('Paid $1,200.00.')
    expect(moneyText('Paid CA$1,200.00.', 'CAD')).toBe('Paid CA$1,200.00.')
  })
  it('keeps totals apart by currency', () => {
    expect(totalsByCurrency([{ amount: 0.1, currency: 'USD' }, { amount: 5, currency: 'EUR' }, { amount: 0.2, currency: 'USD' }])).toEqual([{ currency: 'EUR', amount: 5 }, { currency: 'USD', amount: 0.3 }])
    expect(otherCurrencies({ USD: 5 })).toBeNull()
    expect(otherCurrencies({ USD: 5, EUR: 300, Unknown: 400 })).toBe('€300.00 and 400.00 with no single currency')
  })
})
