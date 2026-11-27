/**
 * What an uploaded file really is, read from its bytes. The declared kind,
 * the filename and its extension are never consulted: a renamed executable is
 * still an executable.
 *
 * Accepted for parsing: UTF-8 plain text and CSV. Accepted for storage only:
 * PDF (there is no PDF or OCR parser in Reclaim; such a file is kept as
 * `unsupported_format` so a person can still read it). Everything else is
 * refused: markup (HTML, SVG, XML), scripts, executables, archives (which
 * includes every modern Office file), legacy Office containers (macros),
 * RTF, images and binary data.
 */

export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024

export type SniffResult =
  | { ok: true; format: 'text' | 'csv'; text: string }
  | { ok: true; format: 'pdf'; text: null }
  | { ok: false; code: SniffRefusal; reason: string }

export type SniffRefusal = 'empty' | 'too_large' | 'executable' | 'archive' | 'office_container' | 'markup' | 'script' | 'binary' | 'image' | 'rtf' | 'not_utf8'

const startsWith = (bytes: Uint8Array, sig: number[], offset = 0) => bytes.length >= offset + sig.length && sig.every((b, i) => bytes[offset + i] === b)
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0))

const EXECUTABLE: number[][] = [
  ascii('MZ'), // Windows PE / DOS
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal / Java class
  [0x00, 0x61, 0x73, 0x6d], // WebAssembly
  ascii('dex\n'), // Android
]
const ARCHIVE: number[][] = [
  [0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06], [0x50, 0x4b, 0x07, 0x08], // zip, and so docx/xlsx/xlsm/pptx/jar/apk
  ascii('Rar!'), [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], [0x1f, 0x8b], ascii('BZh'), [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  [0x28, 0xb5, 0x2f, 0xfd], // zstd
  ascii('MSCF'), // cab
]
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] // .doc/.xls/.msg with possible VBA macros
const IMAGE: number[][] = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], ascii('GIF8'), ascii('II*\0'), ascii('MM\0*'), ascii('BM')]

/** Markup and active content a browser or viewer would interpret. Checked on the decoded text. */
const MARKUP = /<\s*(?:!doctype|html|head|body|script|svg|iframe|frame|object|embed|meta|link|style|form|img|a\s|base|xml|math|template|\?xml)\b|<\?xml|\bjavascript:|\bvbscript:|\bdata:text\/html/i
/** Scripts and macro source, by their first meaningful line or tell-tale statements. */
const SCRIPT = /^\s*(?:#!|<\?php|<%|@echo off\b)|\b(?:Attribute VB_\w+|Sub (?:Auto_?Open|Document_Open|Workbook_Open)\b|CreateObject\s*\(\s*["']WScript|powershell(?:\.exe)?\s+-|Invoke-Expression|IEX\s*\(|eval\s*\(\s*atob)/im

export function sniffDocument(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, code: 'empty', reason: 'The file is empty.' }
  if (bytes.length > MAX_DOCUMENT_BYTES) return { ok: false, code: 'too_large', reason: 'Documents are limited to 2 MB.' }
  if (EXECUTABLE.some((sig) => startsWith(bytes, sig))) return { ok: false, code: 'executable', reason: 'Programs are not accepted.' }
  if (ARCHIVE.some((sig) => startsWith(bytes, sig)) || startsWith(bytes, ascii('ustar'), 257)) return { ok: false, code: 'archive', reason: 'Archives and Office files (Word, Excel, including macro-enabled ones) are not accepted. Export the document as CSV or text, or upload the PDF.' }
  if (startsWith(bytes, OLE)) return { ok: false, code: 'office_container', reason: 'Older Office files can carry macros and are not accepted. Export the document as CSV or text.' }
  if (startsWith(bytes, ascii('%PDF-'))) return { ok: true, format: 'pdf', text: null }
  if (IMAGE.some((sig) => startsWith(bytes, sig))) return { ok: false, code: 'image', reason: 'Images are not accepted: Reclaim has no OCR. Upload the text, CSV or PDF version.' }
  if (startsWith(bytes, ascii('{\\rtf'))) return { ok: false, code: 'rtf', reason: 'RTF files can embed objects and are not accepted. Export the document as text.' }

  let body = bytes
  if (startsWith(body, [0xef, 0xbb, 0xbf])) body = body.subarray(3)
  if (startsWith(body, [0xff, 0xfe]) || startsWith(body, [0xfe, 0xff])) return { ok: false, code: 'not_utf8', reason: 'Only UTF-8 text is accepted.' }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    return { ok: false, code: 'not_utf8', reason: 'The file is not UTF-8 text, CSV or PDF.' }
  }
  // NUL and most C0 controls mean binary data, whatever the decoder thought.
  // eslint-disable-next-line no-control-regex
  const controls = text.match(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g)?.length ?? 0
  if (controls > 0) return { ok: false, code: 'binary', reason: 'The file contains binary data.' }
  if (MARKUP.test(text)) return { ok: false, code: 'markup', reason: 'HTML, SVG and XML are not accepted. Upload plain text, CSV or PDF.' }
  if (SCRIPT.test(text)) return { ok: false, code: 'script', reason: 'Scripts and macros are not accepted.' }
  if (!text.trim()) return { ok: false, code: 'empty', reason: 'The file has no text.' }
  return { ok: true, format: looksLikeCsv(text) ? 'csv' : 'text', text: text.replace(/\r\n?/g, '\n') }
}

/** Two or more lines that split into the same number (≥2) of comma, semicolon or tab separated cells. */
export function looksLikeCsv(text: string): boolean {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20)
  if (lines.length < 2) return false
  return [',', ';', '\t'].some((sep) => {
    const counts = lines.map((l) => splitCsvLine(l, sep).length)
    return counts[0] >= 2 && counts.filter((n) => n === counts[0]).length >= Math.ceil(lines.length * 0.8)
  })
}

/** One CSV line into cells, honouring double quotes. Positions are kept so provenance can point into the line. */
export function splitCsvLine(line: string, sep = ','): Array<{ value: string; start: number; end: number }> {
  const cells: Array<{ value: string; start: number; end: number }> = []
  let i = 0
  while (i <= line.length) {
    const start = i
    let value = ''
    if (line[i] === '"') {
      i++
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { value += '"'; i += 2 }
        else if (line[i] === '"') { i++; break }
        else value += line[i++]
      }
      while (i < line.length && line[i] !== sep) i++
    } else {
      while (i < line.length && line[i] !== sep) value += line[i++]
    }
    cells.push({ value: value.trim(), start, end: i })
    i++
  }
  return cells
}

/** Strict base64 (standard alphabet, optional padding, whitespace ignored). Null when it is not base64. */
export function decodeBase64(input: string, maxBytes = MAX_DOCUMENT_BYTES): { ok: true; bytes: Buffer } | { ok: false; code: 'malformed' | 'too_large' } {
  const compact = input.replace(/\s+/g, '')
  if (compact.length > Math.ceil((maxBytes * 4) / 3) + 4) return { ok: false, code: 'too_large' }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=|[A-Za-z0-9+/]{2,3})?$/.test(compact)) return { ok: false, code: 'malformed' }
  const bytes = Buffer.from(compact, 'base64')
  if (bytes.length > maxBytes) return { ok: false, code: 'too_large' }
  return { ok: true, bytes }
}

/** A display name only: path and control characters removed, length capped. Never used to decide the type. */
export function cleanFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.normalize('NFKC').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').trim()
  return (base || 'document').slice(0, 200)
}
