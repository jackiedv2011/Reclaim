/**
 * Reads the cell values of an .xlsx workbook, with nothing but the browser's
 * own inflate. Only what an export needs: text, numbers, dates and cached
 * formula results, each sheet as rows of strings so it goes through exactly
 * the same reading as a CSV. Nothing in the workbook is ever evaluated.
 */

export class WorkbookError extends Error {}

export interface WorkbookSheet {
  name: string
  /** Every row from the first, blanks included, so position + 1 is the row number Excel shows. */
  rows: string[][]
}

/** A real export is a few MB unpacked; past this it is a mistake or a trap. */
const MAX_UNPACKED_BYTES = 400 * 1024 * 1024
const MAX_COLUMNS = 16_384
const MAX_ROWS = 1_048_576

const NOT_A_WORKBOOK = 'That file isn’t a readable Excel workbook. Open it in Excel and save it again, or save it as CSV.'

const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
/** Old .xls files and password-protected workbooks share this container. */
const isOle = (bytes: Uint8Array) => bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0

interface ZipEntry {
  method: number
  compressedSize: number
  size: number
  offset: number
}

function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let at = bytes.length - 22; at >= 0 && at >= bytes.length - 22 - 0xffff; at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at
      break
    }
  }
  if (end < 0) throw new WorkbookError(NOT_A_WORKBOOK)
  const entries = new Map<string, ZipEntry>()
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) throw new WorkbookError(NOT_A_WORKBOOK)
    const nameLength = view.getUint16(at + 28, true)
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength))
    entries.set(name.replace(/^\//, '').replaceAll('\\', '/'), {
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    })
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  return entries
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('deflate-raw')
  const writer = stream.writable.getWriter()
  // Errors surface on the reading side; this only keeps them from being reported twice.
  const written = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => undefined)
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > MAX_UNPACKED_BYTES) {
      await reader.cancel()
      throw new WorkbookError('That workbook is too large to read. Split the export by date range and add each part to the same audit.')
    }
    chunks.push(value)
  }
  await written
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}

async function entryText(bytes: Uint8Array, entry: ZipEntry | undefined): Promise<string | null> {
  if (!entry) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50) throw new WorkbookError(NOT_A_WORKBOOK)
  if (entry.size > MAX_UNPACKED_BYTES) throw new WorkbookError('That workbook is too large to read. Split the export by date range and add each part to the same audit.')
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method !== 0 && entry.method !== 8) throw new WorkbookError(NOT_A_WORKBOOK)
  return new TextDecoder().decode(entry.method === 0 ? data : await inflate(data))
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function unescapeXml(text: string): string {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, body: string) => body.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, code: string) => {
      if (code[0] !== '#') return ENTITIES[code] ?? whole
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return point <= 0x10ffff ? String.fromCodePoint(point) : whole
    })
    // Excel writes characters XML can't hold as _x000D_ and the like.
    .replace(/_x([0-9a-f]{4})_/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
}

const attributePatterns = new Map<string, RegExp>()

function attribute(attributes: string, name: string): string | null {
  let pattern = attributePatterns.get(name)
  if (!pattern) attributePatterns.set(name, (pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`)))
  const match = attributes.match(pattern)
  return match ? unescapeXml(match[1] ?? match[2] ?? '') : null
}

/** The text of a shared or inline string, without the phonetic guides Excel keeps beside it. */
function stringOf(xml: string): string {
  const body = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '')
  let text = ''
  for (const match of body.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) text += match[1]
  return unescapeXml(text)
}

const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58])

/** For each cell style, whether Excel shows its number as a date. */
function dateStyles(xml: string | null): boolean[] {
  if (!xml) return []
  const custom = new Map<number, boolean>()
  for (const match of xml.matchAll(/<(?:\w+:)?numFmt\s([^>]*?)\/?>/g)) {
    const id = Number(attribute(match[1], 'numFmtId'))
    const code = (attribute(match[1], 'formatCode') ?? '').replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '')
    custom.set(id, /[dy]/i.test(code))
  }
  const cellFormats = xml.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/)?.[1] ?? ''
  return [...cellFormats.matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?>/g)].map((match) => {
    const id = Number(attribute(match[1], 'numFmtId') ?? 0)
    return custom.get(id) ?? BUILT_IN_DATE_FORMATS.has(id)
  })
}

const two = (value: number) => String(value).padStart(2, '0')

/** Excel's day count as an ISO date: the one form with no day and month order to get wrong. */
function serialDate(serial: number, epoch1904: boolean): string | null {
  // Excel counts a 29 February 1900 that never happened, so its first two months are a day out.
  const days = epoch1904 ? serial + 1462 : serial < 60 ? serial + 1 : serial
  if (!(days >= 1) || days > 2_958_466) return null
  const seconds = Math.round(days * 86_400)
  const date = new Date(Date.UTC(1899, 11, 30) + seconds * 1000)
  const day = `${date.getUTCFullYear()}-${two(date.getUTCMonth() + 1)}-${two(date.getUTCDate())}`
  return seconds % 86_400 === 0 ? day : `${day} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`
}

/** The number as Excel would show it unformatted: 15 significant digits, so 1203.0000000000002 is 1203, and no exponent. */
function plainNumber(raw: string): string {
  const value = Number(raw)
  if (!Number.isFinite(value) || raw.trim() === '') return raw
  const rounded = Number(value.toPrecision(15))
  const text = String(rounded)
  return /e/i.test(text) ? rounded.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : text
}

function columnIndex(reference: string): number {
  let index = 0
  for (const letter of reference) {
    const code = letter.charCodeAt(0)
    if (code < 65 || code > 90) break
    index = index * 26 + code - 64
  }
  return index - 1
}

function sheetRows(xml: string, strings: string[], dates: boolean[], epoch1904: boolean): string[][] {
  const rows: string[][] = []
  let previousRow = 0
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const rowNumber = Number(attribute(rowMatch[1], 'r') ?? previousRow + 1)
    if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > MAX_ROWS) throw new WorkbookError(NOT_A_WORKBOOK)
    previousRow = rowNumber
    if (!rowMatch[2]) continue
    const cells: string[] = []
    let previousColumn = -1
    for (const cellMatch of rowMatch[2].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const reference = attribute(cellMatch[1], 'r')
      const column = reference ? columnIndex(reference) : previousColumn + 1
      if (column < 0 || column >= MAX_COLUMNS) throw new WorkbookError(NOT_A_WORKBOOK)
      previousColumn = column
      const body = cellMatch[2] ?? ''
      const type = attribute(cellMatch[1], 't') ?? 'n'
      const stored = body.match(/<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1]
      let text = ''
      if (type === 'inlineStr') text = stringOf(body)
      else if (stored === undefined) text = ''
      else if (type === 's') text = strings[Number(stored)] ?? ''
      else if (type === 'b') text = stored === '1' ? 'TRUE' : 'FALSE'
      else if (type === 'n') {
        const style = Number(attribute(cellMatch[1], 's') ?? 0)
        text = (dates[style] ? serialDate(Number(stored), epoch1904) : null) ?? plainNumber(unescapeXml(stored))
      } else text = unescapeXml(stored)
      if (text === '') continue
      while (cells.length < column) cells.push('')
      cells[column] = text
    }
    if (cells.length === 0) continue
    while (rows.length < rowNumber - 1) rows.push([])
    rows[rowNumber - 1] = cells
  }
  return rows
}

/** Whether these are the first bytes of a spreadsheet rather than of text. */
export function spreadsheetKind(bytes: Uint8Array): 'xlsx' | 'old-or-locked' | null {
  return isZip(bytes) ? 'xlsx' : isOle(bytes) ? 'old-or-locked' : null
}

/** The visible sheets that hold anything, in workbook order. */
export async function readWorkbook(bytes: Uint8Array): Promise<WorkbookSheet[]> {
  if (isOle(bytes)) throw new WorkbookError('That is an old .xls file or a password-protected workbook. Open it in Excel and save it as .xlsx without a password, or as CSV.')
  if (!isZip(bytes)) throw new WorkbookError(NOT_A_WORKBOOK)
  const entries = zipEntries(bytes)
  const text = (name: string) => entryText(bytes, entries.get(name))
  const workbook = await text('xl/workbook.xml')
  if (!workbook) throw new WorkbookError(NOT_A_WORKBOOK)

  const targets = new Map<string, string>()
  for (const match of ((await text('xl/_rels/workbook.xml.rels')) ?? '').matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const id = attribute(match[1], 'Id')
    const target = attribute(match[1], 'Target')
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  const strings = [...((await text('xl/sharedStrings.xml')) ?? '').matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map((match) => stringOf(match[1] ?? ''))
  const dates = dateStyles(await text('xl/styles.xml'))
  const epoch1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(workbook)

  const sheets: WorkbookSheet[] = []
  for (const match of workbook.matchAll(/<(?:\w+:)?sheet\s([^>]*?)\/?>/g)) {
    if (/hidden/i.test(attribute(match[1], 'state') ?? '')) continue
    const id = attribute(match[1], '(?:\\w+:)?id')
    const xml = id ? await text(targets.get(id) ?? '') : null
    if (xml === null) continue
    const rows = sheetRows(xml, strings, dates, epoch1904)
    if (rows.length > 0) sheets.push({ name: attribute(match[1], 'name') ?? `Sheet ${sheets.length + 1}`, rows })
  }
  return sheets
}
