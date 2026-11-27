/** A byte-order mark, so spreadsheet apps read the file as UTF-8 and keep accents and currency signs. */
const BOM = '﻿'
const REAL_NUMBER = /^-?\d+(?:\.\d+)?$/

/**
 * One cell. Text from a ledger can start with a character a spreadsheet runs as
 * a formula (`=HYPERLINK(...)`, `+1`, `@SUM`), so it is kept as text with a
 * leading apostrophe. Real numbers, negative ones included, stay numbers.
 */
export function csvCell(value: string | number): string {
  const raw = String(value)
  const text = typeof value === 'number' || REAL_NUMBER.test(raw) || !/^[=+\-@\t\r]/.test(raw) ? raw : `'${raw}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(rows: Array<Array<string | number>>): string {
  return BOM + rows.map((row) => row.map(csvCell).join(',')).join('\n')
}

export function downloadCsv(name: string, rows: Array<Array<string | number>>): void {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
