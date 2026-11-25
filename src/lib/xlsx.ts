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
  hidden: boolean
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
    entries.set(name.replace(/^\//, '').replaceAll('\\', '/').toLowerCase(), {
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      size: view.getUint32(at + 24, true),
      offset: view.getUint32(at + 42, true),
    })
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
  }
  return entries
}

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
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
    if (total > limit) {
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

async function entryText(bytes: Uint8Array, entry: ZipEntry | undefined, budget: { left: number }): Promise<string | null> {
  if (!entry) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (entry.offset + 30 > bytes.length || view.getUint32(entry.offset, true) !== 0x04034b50) throw new WorkbookError(NOT_A_WORKBOOK)
  if (entry.size > budget.left) throw new WorkbookError('That workbook is too large to read. Split the export by date range and add each part to the same audit.')
  const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true)
  const data = bytes.subarray(start, start + entry.compressedSize)
  if (entry.method !== 0 && entry.method !== 8) throw new WorkbookError(NOT_A_WORKBOOK)
  const unpacked = entry.method === 0 ? data : await inflate(data, budget.left)
  budget.left -= unpacked.length
  return new TextDecoder().decode(unpacked)
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
    .replace(/_x(00[01][0-9a-f]|005f)_/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
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
  for (const match of body.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?(?<!\/)>([\s\S]*?)<\/(?:\w+:)?t>/g)) text += match[1]
  return unescapeXml(text)
}

const BUILT_IN_DATE_FORMATS = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 55, 56, 57, 58])

/** An element's attributes, which may hold a ">" of their own. */
const ATTRIBUTES = `((?:[^>"']|"[^"]*"|'[^']*')*?)`
const NUMBER_FORMAT = new RegExp(`<(?:\\w+:)?numFmt\\s${ATTRIBUTES}/?>`, 'g')
const SHEET = new RegExp(`<(?:\\w+:)?sheet\\s${ATTRIBUTES}/?>`, 'g')

interface CellStyle {
  date: boolean
  /** A currency the format shows beside the number, other than a dollar sign, which is every file's default. */
  currency: string
  /** Digits a format like 00000 pads to, so 123 is the reference 00123 it looks like. */
  digits: number
}

function styleOf(id: number, code: string | undefined): CellStyle {
  if (code === undefined) return { date: BUILT_IN_DATE_FORMATS.has(id), currency: '', digits: 0 }
  const bare = code.replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '')
  return {
    date: /[dy]/i.test(bare),
    currency: code.match(/\[\$(€|£|[A-Z]{3})(?:-[^\]]*)?\]|"?\s?(€|£|EUR|GBP|CAD|AUD|NZD|CHF)\s?"?/)?.slice(1).find(Boolean) ?? '',
    digits: /^0{2,}$/.test(code) ? code.length : 0,
  }
}

function cellStyles(xml: string | null): CellStyle[] {
  if (!xml) return []
  const custom = new Map<number, string>()
  for (const match of xml.matchAll(NUMBER_FORMAT)) custom.set(Number(attribute(match[1], 'numFmtId')), attribute(match[1], 'formatCode') ?? '')
  const cellFormats = xml.match(/<(?:\w+:)?cellXfs\b[^>]*>([\s\S]*?)<\/(?:\w+:)?cellXfs>/)?.[1] ?? ''
  return [...cellFormats.matchAll(/<(?:\w+:)?xf\b([^>]*?)\/?>/g)].map((match) => {
    const id = Number(attribute(match[1], 'numFmtId') ?? 0)
    return styleOf(id, custom.get(id))
  })
}

/** A number as its cell shows it. A date cell holding nothing, or a formula never worked out, is blank rather than 1899. */
function styledNumber(raw: string, style: CellStyle | undefined, epoch1904: boolean): string {
  if (raw.trim() === '') return ''
  if (style?.date) {
    const serial = Number(raw)
    if (!epoch1904 && serial >= 0 && serial < 1) return ''
    const date = serialDate(serial, epoch1904)
    if (date) return date
  }
  const number = plainNumber(raw)
  if (style?.digits && /^\d+$/.test(number)) return number.padStart(style.digits, '0')
  return style?.currency ? `${style.currency}${/^[A-Z]/.test(style.currency) ? ' ' : ''}${number}` : number
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

function sheetRows(source: string, strings: string[], styles: CellStyle[], epoch1904: boolean): string[][] {
  const xml = source.includes('<!--') ? source.replace(/<!--[\s\S]*?-->/g, '') : source
  const rows: string[][] = []
  let previousRow = 0
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const given = Number(attribute(rowMatch[1], 'r') ?? previousRow + 1)
    // A row number used twice would overwrite a row; the second goes below instead.
    const rowNumber = Number.isInteger(given) && given <= previousRow ? previousRow + 1 : given
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
      else if (type === 'n') text = styledNumber(unescapeXml(stored), styles[Number(attribute(cellMatch[1], 's') ?? 0)], epoch1904)
      else text = unescapeXml(stored)
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

/** The sheets that hold anything, hidden ones too so a person can be told of them, in workbook order. */
export async function readWorkbook(bytes: Uint8Array): Promise<WorkbookSheet[]> {
  if (isOle(bytes)) throw new WorkbookError('That is an old .xls file or a password-protected workbook. Open it in Excel and save it as .xlsx without a password, or as CSV.')
  if (!isZip(bytes)) throw new WorkbookError(NOT_A_WORKBOOK)
  const entries = zipEntries(bytes)
  const budget = { left: MAX_UNPACKED_BYTES }
  const text = (name: string) => entryText(bytes, entries.get(name.toLowerCase()), budget)
  const workbook = await text('xl/workbook.xml')
  if (!workbook) throw new WorkbookError(NOT_A_WORKBOOK)

  const targets = new Map<string, string>()
  for (const match of ((await text('xl/_rels/workbook.xml.rels')) ?? '').matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
    const id = attribute(match[1], 'Id')
    const target = attribute(match[1], 'Target')
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`)
  }
  const strings = [...((await text('xl/sharedStrings.xml')) ?? '').matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)].map((match) => stringOf(match[1] ?? ''))
  const styles = cellStyles(await text('xl/styles.xml'))
  const epoch1904 = /<(?:\w+:)?workbookPr\b[^>]*\bdate1904\s*=\s*["'](?:1|true)["']/.test(workbook)

  const sheets: WorkbookSheet[] = []
  for (const match of workbook.matchAll(SHEET)) {
    const hidden = /hidden/i.test(attribute(match[1], 'state') ?? '')
    const id = attribute(match[1], '(?:\\w+:)?id')
    const xml = id ? await text(targets.get(id) ?? '') : null
    if (xml === null) continue
    const rows = sheetRows(xml, strings, styles, epoch1904)
    if (rows.length > 0) sheets.push({ name: attribute(match[1], 'name') ?? `Sheet ${sheets.length + 1}`, rows, hidden })
  }
  return sheets
}
