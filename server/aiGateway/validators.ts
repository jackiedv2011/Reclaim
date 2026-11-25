/**
 * Deterministic checks on anything a model wrote, run before a person ever
 * sees it. They are a filter, not a guarantee: a human still reviews every
 * output, and anything consequential still needs an exact approval.
 */

export type ValidationCode =
  | 'unsupported_amount' | 'unsupported_currency' | 'link' | 'contact_detail' | 'bank_detail'
  | 'unsupported_commitment' | 'legal_threat' | 'accusation' | 'unknown_token' | 'unsupported_date'
  | 'forged_reference' | 'invalid_state' | 'too_long' | 'malformed' | 'refused'

export interface MoneyMention { raw: string; minor: number | null; currency: string }

const CURRENCY_WORDS: Array<[RegExp, string]> = [
  [/^(us\$|\$|usd|dollars?|bucks)$/i, 'USD'], [/^(€|eur|euros?)$/i, 'EUR'], [/^(£|gbp|pounds?)$/i, 'GBP'],
  [/^(¥|jpy|yen)$/i, 'JPY'], [/^(cad|c\$)$/i, 'CAD'], [/^(aud|a\$)$/i, 'AUD'], [/^(inr|₹|rs\.?|rupees?)$/i, 'INR'],
]
const currencyOf = (word: string) => CURRENCY_WORDS.find(([re]) => re.test(word.trim()))?.[1] ?? null

const NUMBER = String.raw`(\d{1,3}(?:[,\s]\d{3})+|\d+)(?:\.(\d{1,2}))?(?:\s?(k|thousand|m|million))?`
const PREFIX = new RegExp(String.raw`(us\$|c\$|a\$|\$|€|£|¥|₹|\b(?:usd|eur|gbp|jpy|cad|aud|inr|rs\.?)\b)\s?${NUMBER}`, 'gi')
const SUFFIX = new RegExp(String.raw`(?<![\w$€£¥₹.])${NUMBER}\s?(\b(?:usd|eur|gbp|jpy|cad|aud|inr|dollars?|euros?|pounds?|yen|rupees?|bucks)\b)`, 'gi')

function toMinor(whole: string, cents: string | undefined, scale: string | undefined): number | null {
  const base = Number(whole.replace(/[,\s]/g, ''))
  if (!Number.isFinite(base)) return null
  const factor = /^(k|thousand)$/i.test(scale ?? '') ? 1000 : /^(m|million)$/i.test(scale ?? '') ? 1_000_000 : 1
  if (factor !== 1 && cents) return null
  return Math.round((base * factor) * 100 + (factor === 1 ? Number((cents ?? '0').padEnd(2, '0')) : 0))
}

/** Every amount of money the text states, in any of the common written forms. */
export function moneyMentions(text: string): MoneyMention[] {
  const out: MoneyMention[] = []
  for (const m of text.matchAll(PREFIX)) out.push({ raw: m[0], minor: toMinor(m[2], m[3], m[4]), currency: currencyOf(m[1]) ?? 'UNKNOWN' })
  for (const m of text.matchAll(SUFFIX)) out.push({ raw: m[0], minor: toMinor(m[1], m[2], m[3]), currency: currencyOf(m[4]) ?? 'UNKNOWN' })
  return out
}

export function percentMentions(text: string): string[] {
  return [...text.matchAll(/\b\d+(?:\.\d+)?\s?(?:%|percent\b|per cent\b)/gi)].map((m) => m[0])
}

const LINK = /\b(?:https?:\/\/|ftp:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|biz|info|us|uk|ly|app|dev|xyz|me|link|site|online)\b(?:\/\S*)?/i
const EMAIL = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[a-z]{2,}/i
const PHONE = /(?:\+?\d[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/
const BANK = /\b(?:iban|swift|bic|routing|aba|sort code|account (?:number|no\.?|#)|acct\.? ?(?:no|#))\b|\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}\b|\b\d{9,18}\b/i
const COMMITMENT = /\b(?:we (?:will|shall) (?:pay|refund|credit|waive)|guarantee[ds]?|we promise|we agree to|you (?:must|are required to) pay within|deadline of|final notice|no later than)\b/i
const LEGAL = /\b(?:legal action|lawsuit|sue|court|attorney|lawyer|solicitor|litigation|collections? agency|penalt(?:y|ies)|late fees?|interest (?:charge|rate|at)|statutory|breach of contract)\b/i
const ACCUSATION = /\b(?:fraud(?:ulent)?|scam|stole|steal(?:ing)?|dishonest|deceiv\w*|embezzl\w*|criminal)\b/i
const TOKEN = /\[\[([A-Z][A-Z0-9_]*)\]\]/g
const WRITTEN_DATE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2} (?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{4})\b/i

export interface TextPolicy {
  /** Amounts in minor units (USD cents) the text may state. Empty: none at all. */
  allowedAmountsMinor?: Iterable<number>
  /** Placeholder tokens the text may contain; anything else in [[…]] is invented. */
  allowedTokens?: Iterable<string>
  /** Written dates are refused unless allowed (draft packets carry dates as tokens). */
  allowDates?: boolean
  /** Supplier-facing prose must not threaten or accuse. */
  outbound?: boolean
  maxChars?: number
}

/** The reasons this text may not be shown as an AI proposal, or an empty list. */
export function checkText(text: string, policy: TextPolicy = {}): ValidationCode[] {
  const codes = new Set<ValidationCode>()
  if (policy.maxChars !== undefined && text.length > policy.maxChars) codes.add('too_long')
  const allowed = new Set(policy.allowedAmountsMinor ?? [])
  for (const mention of moneyMentions(text)) {
    if (mention.currency !== 'USD') codes.add('unsupported_currency')
    else if (mention.minor === null || !allowed.has(mention.minor)) codes.add('unsupported_amount')
  }
  if (percentMentions(text).length) codes.add('unsupported_amount')
  if (LINK.test(text)) codes.add('link')
  if (EMAIL.test(text) || PHONE.test(text)) codes.add('contact_detail')
  if (BANK.test(text)) codes.add('bank_detail')
  if (COMMITMENT.test(text)) codes.add('unsupported_commitment')
  if (policy.outbound && LEGAL.test(text)) codes.add('legal_threat')
  if (policy.outbound && ACCUSATION.test(text)) codes.add('accusation')
  if (!policy.allowDates && WRITTEN_DATE.test(text)) codes.add('unsupported_date')
  const tokens = new Set(policy.allowedTokens ?? [])
  for (const m of text.matchAll(TOKEN)) if (!tokens.has(m[1])) codes.add('unknown_token')
  return [...codes]
}

/** Record ids a model cited must all be ids the packet actually gave it. */
export function forgedReferences(cited: Iterable<string>, allowed: Iterable<string>): string[] {
  const ok = new Set(allowed)
  return [...cited].filter((id) => !ok.has(id))
}

/**
 * Free text a person typed (a tone note, a reply excerpt) before it can enter
 * a packet: contact details, links and long digit runs removed, whitespace
 * folded, length capped. Returns how much was removed so the preview can say so.
 */
export function scrubFreeText(text: string, maxChars: number): { text: string; removed: number } {
  let removed = 0
  const strip = (re: RegExp, label: string) => (value: string) => value.replace(re, () => { removed++; return label })
  const steps = [
    strip(new RegExp(EMAIL.source, 'gi'), '[email removed]'),
    strip(new RegExp(LINK.source, 'gi'), '[link removed]'),
    strip(new RegExp(PHONE.source, 'g'), '[number removed]'),
    strip(/\b\d{6,}\b/g, '[number removed]'),
    strip(/\[\[[^\]]*\]\]/g, ''),
  ]
  let out = steps.reduce((value, step) => step(value), text.normalize('NFKC'))
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (out.length > maxChars) {
    out = out.slice(0, maxChars)
    removed++
  }
  return { text: out, removed }
}
