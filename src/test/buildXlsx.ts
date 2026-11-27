import { deflateRawSync } from 'node:zlib'

/** A zip with no checksums, which is all the reader looks at. */
export function zip(files: Record<string, string>, compress = true): Uint8Array {
  const parts: Uint8Array[] = []
  const directory: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name)
    const plain = new TextEncoder().encode(content)
    const data = compress ? new Uint8Array(deflateRawSync(plain)) : plain
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(8, compress ? 8 : 0, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(10, compress ? 8 : 0, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, plain.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    parts.push(local, data)
    directory.push(central)
    offset += local.length + data.length
  }
  const size = directory.reduce((sum, entry) => sum + entry.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, directory.length, true)
  ev.setUint16(10, directory.length, true)
  ev.setUint32(12, size, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...directory, end]
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of all) {
    out.set(part, at)
    at += part.length
  }
  return out
}

const STYLES = '<styleSheet><numFmts count="5"><numFmt numFmtId="166" formatCode="#,##0.00\\ [$€-407]"/><numFmt numFmtId="167" formatCode="00000"/><numFmt numFmtId="168" formatCode="[>1]dd/mm/yyyy"/><numFmt numFmtId="164" formatCode="dd\\-mmm\\-yyyy"/><numFmt numFmtId="165" formatCode="&quot;Paid&quot; #,##0.00;[Red]-#,##0.00"/></numFmts><cellXfs count="7"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="167"/><xf numFmtId="168"/></cellXfs></styleSheet>'

/** A workbook whose sheets are given as raw `<row>` markup. */
export function buildXlsx(sheets: { name: string; rows: string; state?: string }[], options: { strings?: string; compress?: boolean; date1904?: boolean } = {}): Uint8Array {
  return zip(
    {
      'xl/workbook.xml': `<workbook xmlns:r="r">${options.date1904 ? '<workbookPr date1904="1"/>' : '<workbookPr/>'}<sheets>${sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships>${sheets.map((_, index) => `<Relationship Id="rId${index + 1}" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`,
      'xl/styles.xml': STYLES,
      ...(options.strings ? { 'xl/sharedStrings.xml': `<sst>${options.strings}</sst>` } : {}),
      ...Object.fromEntries(sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, `<worksheet><sheetData>${sheet.rows}</sheetData></worksheet>`])),
    },
    options.compress
  )
}

/** Rows of plain text and numbers as `<row>` markup. */
export function plainRows(rows: (string | number)[][]): string {
  return rows
    .map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => (typeof cell === 'number' ? `<c r="${String.fromCharCode(65 + c)}${r + 1}"><v>${cell}</v></c>` : `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${cell.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</t></is></c>`)).join('')}</row>`)
    .join('')
}
