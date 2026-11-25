import { describe, expect, it } from 'vitest'
import { parseCurrency, parseDate } from '@/lib/format'

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
