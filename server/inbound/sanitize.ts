/**
 * Supplier email bodies to plain, inert text (J4).
 *
 * Everything that arrives through the inbound webhook is untrusted data. This
 * module turns it into text a person can read and a rule can scan, and nothing
 * else: no tag survives, no link stays clickable, nothing is ever fetched
 * (images, stylesheets and links are dropped or replaced, never resolved), and
 * the invisible characters people use to hide instructions are removed.
 *
 * `stripQuoted` then cuts the quoted history, forwarded headers and signatures
 * a reply drags along, so the classifier reads only what the supplier wrote
 * this time (an old amount in the quoted request must not look like an offer).
 */

/** Stored text is capped here; the classifier reads at most `CLASSIFY_CHARS`. */
export const MAX_TEXT_CHARS = 20_000
export const CLASSIFY_CHARS = 8_000

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', euro: '€', pound: '£', yen: '¥', cent: '¢', copy: '©', reg: '®', trade: '™',
  bull: '•', middot: '·', zwj: '', zwnj: '', shy: '', lrm: '', rlm: '',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // Out-of-range and surrogate code points become nothing rather than a replacement character a rule might match.
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : ''
    }
    const named = NAMED[body.toLowerCase()]
    return named ?? whole
  })
}

const escapeForHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** URLs and scheme links in plain text. Bare domains are left alone: plain text never makes them clickable. */
const URL_IN_TEXT = /\b(?:https?|ftp):\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|\b(?:javascript|data|file|vbscript):[^\s<>"']+/gi

/**
 * Zero-width, bidi-override, soft-hyphen, invisible "tag" characters and C0/C1
 * controls other than newline and tab. These are how instructions get hidden
 * from the person reading while staying visible to a model.
 */
// eslint-disable-next-line no-control-regex, no-misleading-character-class
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻]|[\u{e0000}-\u{e007f}]|[\u{e0100}-\u{e01ef}]/gu

/** Visible text from an HTML body. Blockquotes become `> ` lines so `stripQuoted` can drop them. */
export function htmlToText(html: string): string {
  let s = html.slice(0, MAX_TEXT_CHARS * 5)
  s = s.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  s = s.replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, '')
  s = s.replace(/<(script|style|head|title|template|noscript|svg|math|object|iframe|xml)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
  s = s.replace(/<(script|style|head|title|template|noscript|svg|math|object|iframe|xml)\b[^>]*\/?>/gi, '')
  // Innermost blockquote first, so nested quotes get one `> ` per level.
  for (let i = 0; i < 20 && /<blockquote\b/i.test(s); i++) {
    const next = s.replace(/<blockquote\b[^>]*>((?:(?!<blockquote\b)[\s\S])*?)(?:<\/blockquote\s*>|$)/gi, (_m, inner: string) => {
      const text = htmlToText(inner).split('\n').map((line) => `> ${line}`).join('\n')
      return `\n${escapeForHtml(text)}\n`
    })
    if (next === s) break
    s = next
  }
  // A link keeps its visible words (minus any URL in them) and loses its target.
  s = s.replace(/<a\b[^>]*>([\s\S]*?)(?:<\/a\s*>|$)/gi, (_m, inner: string) => {
    const label = inner.replace(/<[^>]*>/g, '').trim()
    return label ? `${label} [link removed]` : '[link removed]'
  })
  s = s.replace(/<img\b[^>]*>/gi, '')
  s = s.replace(/<(br|hr)\b[^>]*>/gi, '\n')
  s = s.replace(/<\/(p|div|li|tr|h[1-6]|table|ul|ol|section|article|header|footer|pre)\s*>/gi, '\n')
  s = s.replace(/<(p|div|li|tr|h[1-6]|table|ul|ol|section|article|header|footer|pre)\b[^>]*>/gi, '\n')
  s = s.replace(/<\/?(td|th)\b[^>]*>/gi, ' ')
  s = s.replace(/<[^>]*>/g, '')
  s = s.replace(/</g, '')
  return decodeEntities(s)
}

export interface SanitizedText {
  text: string
  /** Links replaced, characters removed, and whether the cap cut the text. */
  linksRemoved: number
  invisibleRemoved: number
  truncated: boolean
}

/**
 * The one way supplier text becomes stored text. Prefers the plain-text part;
 * falls back to the HTML part converted to text. Never fetches anything.
 */
export function sanitizeEmailBody(input: { text?: string | null; html?: string | null }): SanitizedText {
  const raw = input.text && input.text.trim() ? input.text.slice(0, MAX_TEXT_CHARS * 5) : input.html ? htmlToText(input.html) : ''
  let s = raw.replace(/\r\n?/g, '\n').normalize('NFKC')
  let invisibleRemoved = 0
  s = s.replace(INVISIBLE, () => { invisibleRemoved++; return '' })
  let linksRemoved = 0
  s = s.replace(URL_IN_TEXT, () => { linksRemoved++; return '[link removed]' })
  s = s.replace(/\[link removed\](?:\s*\[link removed\])+/g, '[link removed]')
  s = s.replace(/[ \t  -   　]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  const truncated = s.length > MAX_TEXT_CHARS
  if (truncated) s = s.slice(0, MAX_TEXT_CHARS)
  return { text: s, linksRemoved, invisibleRemoved, truncated }
}

/** One-line header text (subject, display name): sanitized, no newlines, short. */
export function sanitizeLine(value: string | null | undefined, max = 300): string {
  if (!value) return ''
  return sanitizeEmailBody({ text: value }).text.replace(/\s+/g, ' ').slice(0, max)
}

const ON_WROTE = /^(?:on\s.{0,200}?wrote:|on\s.{0,200}\n.{0,200}?wrote:|le\s.{0,200}?a écrit\s?:|am\s.{0,200}?schrieb.{0,100}:|el\s.{0,200}?escribió:)/im
const SEPARATORS = [
  /^-{2,}\s*original message\s*-{2,}/im,
  /^-{2,}\s*forwarded message\s*-{2,}/im,
  /^begin forwarded message:/im,
  /^_{10,}\s*$/m,
  // Outlook's header block: From: … then Sent:/Date: within the next lines.
  /^\*?from:\*?\s.+\n(?:.*\n){0,2}\*?(?:sent|date):\*?\s/im,
  // Signature delimiter and the usual mobile and legal footers.
  /^--\s*$/m,
  /^sent from my (?:iphone|ipad|android|samsung|mobile|blackberry)/im,
  /^get outlook for (?:ios|android)/im,
  /^(?:confidentiality notice|this e-?mail (?:message )?(?:and any attachments )?(?:is|are|may be) (?:confidential|intended))/im,
]

export interface StrippedReply {
  /** What the supplier wrote this time. Offsets in a classification point into this string. */
  text: string
  /** Characters cut as quoted history, forwarded headers or signature. */
  removedChars: number
}

/** The new part of a reply: quoted history, forwarded blocks and signatures removed. */
export function stripQuoted(text: string): StrippedReply {
  let cut = text.length
  const onWrote = ON_WROTE.exec(text)
  if (onWrote) cut = Math.min(cut, onWrote.index)
  for (const re of SEPARATORS) {
    const m = re.exec(text)
    if (m) cut = Math.min(cut, m.index)
  }
  const head = text.slice(0, cut)
  const kept = head.split('\n').filter((line) => !/^\s*>/.test(line)).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, CLASSIFY_CHARS)
  return { text: kept, removedChars: text.length - kept.length }
}

/**
 * Text that reads like instructions to software rather than a reply to a
 * person. Never obeyed anywhere; its presence quarantines the message so a
 * person reads it before anything is proposed from it.
 */
const INSTRUCTION_LIKE = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+|these\s+)*(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules?|messages?|directions?)/i,
  /\b(?:system prompt|you are (?:now )?(?:an? )?(?:ai|assistant|language model|chatbot)|as an ai\b|new instructions?:)/i,
  /\b(?:mark|set|record|update|change|flag)\s+(?:this|the|it|case|claim|invoice|account)?\s*(?:case\s+|claim\s+)?(?:as|to)\s+(?:paid|settled|closed|resolved|recovered|refunded)\b/i,
  /\b(?:close|resolve|settle)\s+(?:this|the)\s+(?:case|claim|ticket)\s+(?:now|immediately|automatically)\b/i,
  /<\/?(?:system|assistant|user|instructions?)>|\[\/?(?:INST|SYS)\]/i,
]
export function instructionLike(text: string): boolean {
  return INSTRUCTION_LIKE.some((re) => re.test(text))
}
