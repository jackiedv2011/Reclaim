import { describe, expect, it } from 'vitest'
import { formatCurrency, normalizeVendor, parseCurrency, parseDate, parseTerms } from '@/lib/format'

describe('parseCurrency', () => {
  it('accepts complete currency values', () => {
    expect(parseCurrency('$1,240.50')).toBe(1240.5)
  })

  it('rejects partial or malformed values', () => {
    expect(parseCurrency('100abc')).toBeNull()
    expect(parseCurrency('$1,2x0')).toBeNull()
  })

  it('reads accounting-style parentheses as a negative', () => {
    expect(parseCurrency('(150.00)')).toBe(-150)
    expect(parseCurrency('($1,250.50)')).toBe(-1250.5)
    expect(parseCurrency('-42')).toBe(-42)
  })
})

describe('parseDate', () => {
  it('accepts valid ISO dates', () => {
    expect(parseDate('2025-02-28')?.getDate()).toBe(28)
  })

  it('rejects impossible dates and trailing characters', () => {
    expect(parseDate('2025-02-31')).toBeNull()
    expect(parseDate('2025-02-28 extra')).toBeNull()
    expect(parseDate('02/31/2025')).toBeNull()
  })

  it('accepts US month-first and slash-separated ISO dates, and an ISO timestamp', () => {
    expect(parseDate('03/15/2025')?.toDateString()).toBe(new Date(2025, 2, 15).toDateString())
    expect(parseDate('3/5/2025')?.toDateString()).toBe(new Date(2025, 2, 5).toDateString())
    expect(parseDate('2025/03/20')?.toDateString()).toBe(new Date(2025, 2, 20).toDateString())
    expect(parseDate('2025-03-20T00:00:00Z')?.toDateString()).toBe(new Date(2025, 2, 20).toDateString())
  })

  it('reads a date with the month written out, in any order it is written', () => {
    const march4 = new Date(2026, 2, 4)
    for (const raw of ['4 Mar 2026', '04 Mar 2026', '04-Mar-2026', '4-Mar-26', '4/Mar/2026', "4 Mar '26", 'Mar 4, 2026', 'Mar. 4, 2026', 'March 4 2026', 'MARCH 4TH, 2026', '4th March 2026', '2026-Mar-04', 'Wed, 4 March 2026', 'Wednesday 4 March 2026']) {
      expect(parseDate(raw), raw).toEqual(march4)
      expect(parseDate(raw, 'day-first'), raw).toEqual(march4)
    }
    expect(parseDate('1 Sept 2026')).toEqual(new Date(2026, 8, 1))
  })

  it('reads past a time of day, and YYYYMMDD', () => {
    for (const raw of ['03/04/2026 12:00:00 AM', '3/4/2026 10:15', '4 Mar 2026 10:15 pm', '2026-03-04 00:00:00', '20260304', '03.04.2026', '2026.03.04', '2026-03-04 10:30 AM', '2026-03-04 9:30']) expect(parseDate(raw), raw).toEqual(new Date(2026, 2, 4))
    for (const raw of ['20261304', '12345678', '2026030', '03/04.2026']) expect(parseDate(raw), raw).toBeNull()
  })

  it('rejects a month-name date that does not exist or is incomplete', () => {
    for (const raw of ['31 Feb 2026', 'Mar 2026', '4 Mar', '4 Foo 2026', '4 Mars 2026', '4 constructor 2026', 'Total Mar 4 2026', 'Acme 12 2026 Ltd']) expect(parseDate(raw), raw).toBeNull()
  })

  it('reads an all-number date in the order the file uses, and never the other way round to make it fit', () => {
    expect(parseDate('04/03/2026', 'day-first')).toEqual(new Date(2026, 2, 4))
    expect(parseDate('25-02-2026', 'day-first')).toEqual(new Date(2026, 1, 25))
    expect(parseDate('02/25/2026', 'day-first')).toBeNull()
    expect(parseDate('2026-03-04', 'day-first')).toEqual(new Date(2026, 2, 4))
  })

  it('reads a slash date as month-first unless told the file is day-first', () => {
    expect(parseDate('04/03/2025')?.getMonth()).toBe(3)
    expect(parseDate('13/03/2025')).toBeNull()
  })
})

describe('normalizeVendor', () => {
  it('reads legal words, punctuation, articles and initials as one vendor', () => {
    const same = (names: string[]) => expect(new Set(names.map(normalizeVendor)).size, names.map((n) => `${n} → ${normalizeVendor(n)}`).join('; ')).toBe(1)
    same(['Acme', 'ACME Inc', 'Acme, Inc.', 'Acme Incorporated', 'Acme L.L.C.', 'Acme, LLC', 'Acme Ltd.', 'Acme Limited', 'Acme Corp', 'Acme Corporation', 'Acme Co.', 'Acme Company', 'Acme PLC', 'Acme GmbH', 'Acme Pty Ltd', ' acme ', 'The Acme Company'])
    same(['Smith & Jones', 'Smith and Jones', 'SMITH AND JONES, LLP', 'Smith & Jones Co', 'Smith & Jones & Co.'])
    same(["Lowe's", 'LOWES', 'Lowe’s'])
    same(['A.B.C. Supply', 'ABC Supply', 'A B C Supply', 'ABC Supply Co., Inc.'])
    same(['J.P. Morgan', 'JP Morgan', 'J. P. Morgan'])
    same(['Home Depot', 'The Home Depot'])
    same(['Coca-Cola', 'Coca Cola'])
  })
  it('keeps different vendors and numbered locations apart', () => {
    const distinct = ['Station 1042', 'Station 1043', 'Acme Steel', 'Acme Stone', 'Acme', 'Sysco #214', 'Sysco #215', 'Amazon', 'Amazon.com', 'Company', 'Co', 'The']
    expect(new Set(distinct.map(normalizeVendor)).size).toBe(distinct.length)
  })
  it('never normalizes a name away, and is stable when applied twice', () => {
    for (const name of ['Inc.', 'The', '***', 'Co & Co', '株式会社', 'Café Noir', 'The Company', 'A.B.C.', 'Smith & Co', 'The The', 'X & Y']) {
      expect(normalizeVendor(name).length, name).toBeGreaterThan(0)
      expect(normalizeVendor(normalizeVendor(name)), name).toBe(normalizeVendor(name))
    }
  })
})

describe('parseTerms', () => {
  it('reads the spellings exports use', () => {
    for (const raw of ['2/10 net 30', '2/10 net 30 days', '2% 10 Days Net 30 Days', '2%10 Net30', '2/10, Net 30.', '2/10-N30', '2/10; net 30', 'Net 30, 2/10', 'Net 30 2/10', 'n/30; 2% 10 days', '2% 10, net 30', ' 2 / 10 , n / 30 ', '2/10 NET 30 DAYS.', '2.0/10 net 30']) {
      expect(parseTerms(raw), raw).toEqual({ discountPct: 2, discountDays: 10, netDays: 30 })
    }
  })
  it('marks end-of-month terms', () => {
    for (const raw of ['2/10, n/30 EOM', '2/10 net 30 E.O.M.', '2/10 EOM, net 30', '2/10 net 30 end of month']) expect(parseTerms(raw), raw).toEqual({ discountPct: 2, discountDays: 10, netDays: 30, endOfMonth: true })
  })
  it('rejects what is not a discount', () => {
    for (const raw of ['Net 30', 'Net 302/10', '2/10', '0/10 net 30', '100/10 net 30', '2/30 net 10', '210 net 30', 'Due on receipt', '1st 2/10 net 30', '2/10 net 30 or else', null, '']) expect(parseTerms(raw), String(raw)).toBeNull()
  })
})

describe('formatCurrency', () => {
  it('is dollars unless told otherwise, and never throws on an odd code', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50')
    expect(formatCurrency(1234.5, 'eur')).toBe('€1,234.50')
    expect(formatCurrency(1234.5, null)).toBe('$1,234.50')
    expect(formatCurrency(1234.5, 'ZZZZ')).toBe('ZZZZ 1,234.50')
  })
})
