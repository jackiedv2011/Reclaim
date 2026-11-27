import { describe, expect, it } from 'vitest'
import { csvCell, toCsv } from './csvExport'

describe('CSV export cells', () => {
  it.each([
    ['=HYPERLINK("http://x","Pay")', `"'=HYPERLINK(""http://x"",""Pay"")"`],
    ['+1 555 0100', `'+1 555 0100`],
    ['-2+3', `'-2+3`],
    ['@SUM(A1)', `'@SUM(A1)`],
    ['\t=1', `'\t=1`],
    ['\r=1', `"'\r=1"`],
  ])('keeps %j as text', (value, cell) => expect(csvCell(value)).toBe(cell))

  it.each([['-125.50', '-125.50'], ['1200.00', '1200.00'], ['0', '0']])('leaves the number %s alone', (value, cell) => expect(csvCell(value)).toBe(cell))
  it('leaves a negative number passed as a number alone', () => expect(csvCell(-5)).toBe('-5'))

  it('quotes commas, quotes, line feeds and carriage returns', () => {
    expect(csvCell('Smith, Jones')).toBe('"Smith, Jones"')
    expect(csvCell('6" pipe')).toBe('"6"" pipe"')
    expect(csvCell('a\nb')).toBe('"a\nb"')
    expect(csvCell('a\rb')).toBe('"a\rb"')
  })

  it('starts with a UTF-8 mark so Café and € survive a spreadsheet', () => {
    const csv = toCsv([['Vendor', 'Currency'], ['Café', 'EUR']])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(csv.slice(1)).toBe('Vendor,Currency\nCafé,EUR')
  })
})
