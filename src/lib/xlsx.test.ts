import { describe, expect, it } from 'vitest'
import { WorkbookError, readWorkbook, spreadsheetKind } from '@/lib/xlsx'
import { buildXlsx, plainRows, zip } from '@/test/buildXlsx'

const rowsOf = async (rows: string, options?: Parameters<typeof buildXlsx>[1]) => (await readWorkbook(buildXlsx([{ name: 'Payments', rows }], options)))[0].rows

describe('reading a workbook', () => {
  it('reads text, numbers, shared strings and formula results, stored or deflated', async () => {
    const strings = '<si><t>Acme &amp; Sons</t></si><si><r><t>Bold</t></r><r><t xml:space="preserve"> half</t></r><rPh><t>ignored</t></rPh></si><si/>'
    const rows = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1"><v>1200.5</v></c><c r="E1" t="str"><f>A1</f><v>calc</v></c><c r="F1" t="b"><v>1</v></c><c r="G1" t="e"><v>#N/A</v></c></row>'
    for (const compress of [true, false]) expect(await rowsOf(rows, { strings, compress })).toEqual([['Acme & Sons', 'Bold half', '', '1200.5', 'calc', 'TRUE', '#N/A']])
  })

  it('keeps row and column positions, so row numbers match Excel', async () => {
    expect(await rowsOf('<row r="3"><c r="B3"><v>7</v></c></row><row r="5"/><row r="6"><c r="AA6"><v>1</v></c></row>')).toEqual([[], [], ['', '7'], [], [], [...Array(26).fill(''), '1']])
    expect(await rowsOf('<row><c><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row>')).toEqual([['1', '2'], ['3']])
  })

  it('turns Excel dates into ISO dates, by built-in and custom format, and leaves amounts alone', async () => {
    const rows = '<row r="1"><c r="A1" s="1"><v>46085</v></c><c r="B1" s="2"><v>46085</v></c><c r="C1" s="3"><v>46085</v></c><c r="D1" s="1"><v>46085.5</v></c><c r="E1" s="1"><v>59</v></c></row>'
    expect(await rowsOf(rows)).toEqual([['2026-03-04', '2026-03-04', '46085', '2026-03-04 12:00:00', '1900-02-28']])
    expect((await rowsOf('<row r="1"><c r="A1" s="1"><v>44623</v></c></row>', { date1904: true }))[0][0]).toBe('2026-03-04')
  })

  it('a date cell holding nothing is blank, not 1899', async () => {
    expect(await rowsOf('<row r="1"><c r="A1" s="1"><v></v></c><c r="B1" s="1"><v>0</v></c><c r="C1"><v>5</v></c></row>')).toEqual([['', '', '5']])
  })

  it('keeps a currency and leading zeros the format shows', async () => {
    expect(await rowsOf('<row r="1"><c r="A1" s="4"><v>100</v></c><c r="B1" s="5"><v>123</v></c><c r="C1" s="6"><v>46085</v></c><c r="D1" s="4"><v>-7.5</v></c></row>')).toEqual([['€100', '00123', '2026-03-04', '€-7.5']])
  })

  it('reads markup other tools write', async () => {
    expect(await rowsOf('<!-- <row r="1"><c><v>9</v></c></row> --><row r="1"><c r="A1" t="inlineStr"><is><t xml:space="preserve"/><t>INV_x2024_7</t></is></c></row><row r="1"><c r="A1"><v>2</v></c></row>')).toEqual([['INV_x2024_7'], ['2']])
  })

  it('writes numbers the way a person would: no float noise, no exponent', async () => {
    expect(await rowsOf('<row r="1"><c r="A1"><v>1203.0000000000002</v></c><c r="B1"><v>1E-7</v></c><c r="C1"><v>-80.5</v></c><c r="D1"><v>0.1</v></c></row>')).toEqual([['1203', '0.0000001', '-80.5', '0.1']])
  })

  it('reads markup with a namespace prefix', async () => {
    expect(await rowsOf('<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>Hi</x:t></x:is></x:c></x:row>')).toEqual([['Hi']])
  })

  it('lists the sheets that hold something, saying which are hidden', async () => {
    const sheets = await readWorkbook(buildXlsx([
      { name: 'Cover', rows: '' },
      { name: 'A &amp; B', rows: plainRows([['x', 1]]) },
      { name: 'Old', rows: plainRows([['y']]), state: 'hidden' },
      { name: 'Two', rows: plainRows([['z']]) },
    ]))
    expect(sheets).toEqual([{ name: 'A & B', rows: [['x', '1']], hidden: false }, { name: 'Old', rows: [['y']], hidden: true }, { name: 'Two', rows: [['z']], hidden: false }])
  })

  it('reads a large sheet quickly', async () => {
    const rows = plainRows(Array.from({ length: 50_000 }, (_, i) => ['Acme', `INV-${i}`, 46085, 12.5, 'note', 'more']))
    const bytes = buildXlsx([{ name: 'Big', rows }])
    const started = performance.now()
    expect((await readWorkbook(bytes))[0].rows).toHaveLength(50_000)
    expect(performance.now() - started).toBeLessThan(5000)
  })

  it('refuses what it cannot read, saying what to do', async () => {
    await expect(readWorkbook(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]))).rejects.toThrow(/password-protected|old \.xls/)
    await expect(readWorkbook(new TextEncoder().encode('vendor,amount'))).rejects.toThrow(WorkbookError)
    await expect(readWorkbook(zip({ 'word/document.xml': '<x/>' }))).rejects.toThrow(/isn’t a readable Excel workbook/)
    await expect(readWorkbook(buildXlsx([{ name: 'P', rows: plainRows([['x']]) }]).subarray(0, 120))).rejects.toThrow(WorkbookError)
  })

  it('tells spreadsheets from text by their first bytes', () => {
    expect(spreadsheetKind(zip({ a: 'b' }))).toBe('xlsx')
    expect(spreadsheetKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('old-or-locked')
    expect(spreadsheetKind(new TextEncoder().encode('vendor'))).toBeNull()
  })
})
