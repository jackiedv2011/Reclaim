/**
 * Deterministic reading of a supplier reply (J4).
 *
 * Fixed rules over the stripped reply (sanitize.ts `stripQuoted`): what kind
 * of answer it is, which existing vendor status that is, and the amounts and
 * dates it mentions, each with character offsets into the text so a person
 * can see exactly what a suggestion rests on.
 *
 * It only ever suggests. The output is at most a `vendor_update` case-command
 * payload that waits in the approval queue for a person. It never records
 * money, closes a case, accepts an offer or sends anything, and a promise to
 * pay is never read as money returned (`promised`, never a settlement).
 *
 * When the reply is ambiguous it says `unknown` and proposes nothing:
 * conflicting answers, several different amounts where an amount matters, an
 * amount above what was asked for, any non-USD currency, or text that reads
 * like instructions to software.
 */
import type { RecoveryMethod, VendorUpdateStatus } from '../../src/ledger/caseState.ts'
import { VENDOR_STATUS } from '../../src/recovery/vendorStatus.ts'
import { instructionLike } from './sanitize.ts'

export const REPLY_CATEGORIES = [
  'acknowledgement', 'dispute', 'request_for_information', 'partial_acceptance', 'refund_or_credit_commitment',
  'already_refunded', 'payment_not_found', 'wrong_contact', 'unclear', 'unknown',
] as const
export type ReplyCategory = typeof REPLY_CATEGORIES[number]

/** Statuses each category may produce. `unclear` and `unknown` produce none. */
export const CATEGORY_STATUSES: Record<ReplyCategory, readonly VendorUpdateStatus[]> = {
  acknowledgement: ['acknowledged'],
  dispute: ['disputed'],
  request_for_information: ['needs_documents'],
  partial_acceptance: ['partial_acceptance'],
  refund_or_credit_commitment: ['promised', 'credit_issued', 'accepted'],
  already_refunded: ['already_refunded'],
  payment_not_found: ['payment_not_found'],
  wrong_contact: ['wrong_contact'],
  unclear: [],
  unknown: [],
}

export interface Span { start: number; end: number; text: string }
export interface AmountCandidate extends Span { currency: string; minor: number | null }
export interface DateCandidate extends Span { iso: string | null; ambiguous: boolean }

export interface ReplyClassification {
  source: 'rules' | 'ai'
  category: ReplyCategory
  status: VendorUpdateStatus | null
  /** USD, only when the status allows one and exactly one unambiguous amount ≤ the request was found. */
  amount: number | null
  method: RecoveryMethod | null
  /** YYYY-MM-DD, only for a promise with exactly one unambiguous date. */
  expectedDate: string | null
  /** Where in the stripped reply each signal was found. */
  evidence: Span[]
  amounts: AmountCandidate[]
  dates: DateCandidate[]
  /** Why it is unknown, or what was set aside (an ambiguous date, an ignored amount). */
  flags: string[]
  /** Model's own estimate for AI results; null for rules. */
  confidence: number | null
}

export interface CaseContext {
  /** What the supplier was asked for, in USD; null when the case has none. */
  requestedAmount: number | null
  requestedMethod: RecoveryMethod | null
  /** When the reply arrived (ms); dates before it can't be an expected date. */
  receivedAt: number
}

// ---------- amounts ----------

const NUM = String.raw`(\d{1,3}(?:[,.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)(?:\s?(k|thousand|m|million)\b)?`
const USD_PREFIX = String.raw`US\$|USD|(?<![A-Za-z])\$`
const OTHER_PREFIX = String.raw`C\$|CA\$|A\$|AU\$|NZ\$|HK\$|S\$|MX\$|€|£|¥|₹|₩|₽|₺|\b(?:EUR|GBP|CAD|AUD|NZD|JPY|INR|MXN|CHF|CNY|RMB|SEK|NOK|DKK|PLN|ZAR|BRL)\b`
const SUFFIX_WORDS = String.raw`USD|US dollars?|dollars?|bucks|€|EUR|euros?|GBP|£|pounds sterling|CAD|AUD|JPY|yen|INR|rupees?|MXN|pesos?|CHF|francs?`
const MONEY = new RegExp(String.raw`(?:(${USD_PREFIX}|${OTHER_PREFIX})\s?${NUM})|(?:(?<![\w$€£¥₹.,])${NUM}\s?(${SUFFIX_WORDS})(?![A-Za-z]))`, 'gi')

function currencyOf(symbol: string): string {
  const s = symbol.trim().toLowerCase()
  if (['us$', 'usd', '$', 'us dollar', 'us dollars', 'dollar', 'dollars', 'bucks'].includes(s)) return 'USD'
  if (['€', 'eur', 'euro', 'euros'].includes(s)) return 'EUR'
  if (['£', 'gbp', 'pounds sterling'].includes(s)) return 'GBP'
  return s.toUpperCase()
}

/** USD minor units from a written number, or null when the format is ambiguous (1.234,56) or unparseable. */
function usdMinor(num: string, scale: string | undefined): number | null {
  const n = num.replace(/\s/g, '')
  let whole: string
  let cents = '0'
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(n) || /^\d+(?:\.\d{1,2})?$/.test(n)) {
    const [w, c] = n.split('.')
    whole = w.replace(/,/g, '')
    cents = c ?? '0'
  } else return null
  const factor = /^(k|thousand)$/i.test(scale ?? '') ? 1000 : /^(m|million)$/i.test(scale ?? '') ? 1_000_000 : 1
  const value = Number(whole) * factor * 100 + (factor === 1 ? Number(cents.padEnd(2, '0')) : Math.round(Number(`0.${cents}`) * factor * 100))
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function findAmounts(text: string): AmountCandidate[] {
  const out: AmountCandidate[] = []
  for (const m of text.matchAll(MONEY)) {
    const symbol = m[1] ?? m[6]
    const num = m[1] ? m[2] : m[4]
    const scale = m[1] ? m[3] : m[5]
    const currency = currencyOf(symbol)
    const start = m.index
    out.push({ start, end: start + m[0].length, text: m[0], currency, minor: currency === 'USD' ? usdMinor(num, scale) : null })
  }
  return out
}

// ---------- dates ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`
const DATE_PATTERNS: Array<{ re: RegExp; parse: (m: RegExpMatchArray) => { y: number | null; mo: number; d: number; ambiguous: boolean } }> = [
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g, parse: (m) => ({ y: +m[1], mo: +m[2], d: +m[3], ambiguous: false }) },
  {
    re: /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/g,
    parse: (m) => {
      const a = +m[1]
      const b = +m[2]
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3]
      // 03/04/2026 is March 4 in the US and 3 April elsewhere: never guess.
      if (a <= 12 && b <= 12 && a !== b) return { y, mo: a, d: b, ambiguous: true }
      return a > 12 ? { y, mo: b, d: a, ambiguous: false } : { y, mo: a, d: b, ambiguous: false }
    },
  },
  { re: new RegExp(String.raw`\b${MONTH}\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s+(\d{4})\b)?`, 'gi'), parse: (m) => ({ y: m[3] ? +m[3] : null, mo: MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, d: +m[2], ambiguous: !m[3] }) },
  { re: new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH}(?:,?\s+(\d{4})\b)?`, 'gi'), parse: (m) => ({ y: m[3] ? +m[3] : null, mo: MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, d: +m[1], ambiguous: !m[3] }) },
]

export function findDates(text: string): DateCandidate[] {
  const out: DateCandidate[] = []
  for (const { re, parse } of DATE_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index
      const end = start + m[0].length
      if (out.some((o) => start < o.end && end > o.start)) continue
      const p = parse(m)
      const valid = p.y !== null && p.mo >= 1 && p.mo <= 12 && p.d >= 1 && p.d <= new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate()
      const iso = valid && p.y !== null ? `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}` : null
      out.push({ start, end, text: m[0], iso: p.ambiguous ? null : iso, ambiguous: p.ambiguous || iso === null })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

// ---------- signals ----------

type Signal = { category: Exclude<ReplyCategory, 'unclear' | 'unknown'>; re: RegExp; status?: VendorUpdateStatus; negatable?: boolean }

const SIGNALS: Signal[] = [
  // Acknowledgement: weak, loses to anything substantive.
  { category: 'acknowledgement', re: /\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:received|got)\s+(?:your|the)\s+(?:e-?mail|message|request|note|letter|claim|inquiry|enquiry)/gi },
  { category: 'acknowledgement', re: /\b(?:looking into (?:this|it|the matter|your request)|(?:will|are going to|'ll)\s+(?:review|look into|investigate|research|check (?:on )?(?:this|it|with))|get back to you|follow up (?:with you )?(?:shortly|soon|once)|(?:is|are) (?:under|in) review|being (?:reviewed|investigated|researched)|reviewing (?:this|your|the)|have (?:opened|logged|created) a (?:ticket|case))/gi },
  { category: 'acknowledgement', re: /\b(?:forwarded|passed|escalated|sent)\s+(?:this|it|your (?:request|e-?mail|message|note))\s+(?:on\s+)?to\s+(?:our|the)\s+/gi },

  // Dispute.
  { category: 'dispute', re: /\b(?:is not|isn't|was not|wasn't|are not|aren't|were not|weren't|not)\s+(?:a\s+)?(?:duplicates?|double (?:payments?|charges?)|overpaid|an overpayment)\b/gi },
  { category: 'dispute', re: /\b(?:both|each|the two|these|those)\s+(?:payments?|invoices?|charges?)\s+(?:were|are|was|is)\s+(?:valid|correct|legitimate|accurate|for (?:separate|different|two))/gi },
  { category: 'dispute', re: /\b(?:separate|different|distinct|two)\s+(?:orders?|shipments?|deliver(?:y|ies)|invoices?|purchase orders?|pos|services?|jobs?|visits?)\b(?=[^.?!\n]{0,80}\b(?:valid|correct|owed|due|both|each|separately|legitimate|not a duplicate)\b|[^.?!\n]{0,20}[.?!\n])/gi },
  { category: 'dispute', re: /\b(?:disagree|dispute|reject|deny|cannot accept|can't accept|do not accept|don't accept)\b(?:\s+(?:with\s+)?(?:your|this|the)\s+(?:claim|request|finding|assessment))?/gi, negatable: true },
  { category: 'dispute', re: /\b(?:claim|request|refund request)\s+(?:has been|was|is)\s+(?:rejected|denied|declined)\b|\b(?:there is|there's|we see|we find)\s+no\s+(?:overpayment|duplicate|double payment)\b|\bnot\s+(?:been\s+)?(?:paid|charged|billed)\s+twice\b/gi },
  { category: 'dispute', re: /\b(?:no|not any)\s+(?:refund|credit|money|balance|amount|reimbursement)\s+(?:is\s+)?(?:due|owed|owing|outstanding|warranted|applicable)\b/gi },
  { category: 'dispute', re: /\b(?:we|you)\s+(?:do not|don't|does not|doesn't)\s+owe\b|\bnothing\s+(?:is\s+)?(?:owed|due|outstanding)\b/gi },
  { category: 'dispute', re: /\b(?:unable|not able|cannot|can't|will not|won't|are not able|not in a position)\s+(?:to\s+)?(?:be\s+)?(?:issu|process|provid|offer|giv|grant|approv|refund|credit|reimburs|return)\w*\b(?:\s+(?:a|any|the|this|your))?(?:\s+(?:refund|credit|reimbursement|money|amount))?/gi },
  { category: 'dispute', re: /\b(?:our records|records)\s+(?:show|indicate|confirm)\s+(?:that\s+)?(?:the|this|your)\s+(?:account|balance|invoices?|payments?)\s+(?:is|are|was|were)\s+(?:correct|accurate|applied correctly|in order|valid)/gi },

  // Request for information.
  { category: 'request_for_information', re: /\b(?:please|kindly|could you|can you|would you)\s+(?:please\s+)?(?:send|provide|share|forward|attach|resend|supply)\b(?!\s+(?:it|this|your request)\s+to\b)/gi },
  { category: 'request_for_information', re: /\b(?:we|i)\s+(?:will\s+)?(?:need|require|would need)\s+(?:a\s+|the\s+|your\s+|some\s+|more\s+|additional\s+|both\s+)?(?:[a-z-]+\s+){0,2}(?:copy|copies|proof|documentation|documents|details|information|remittance|bank statements?|w-?9|backup|invoice|statement|check images?|vendor id|account number)\b/gi },
  { category: 'request_for_information', re: /\b(?:proof of payment|remittance (?:advice|details|detail)|copies? of (?:the|both|your|each)|bank statements?|cancell?ed checks?|check images?|w-?9)\b/gi },
  { category: 'request_for_information', re: /\b(?:what|which)\s+(?:invoice|po|purchase order|payment|check|account|reference)\s+(?:number|date|was|is|did)\b[^?\n]{0,80}\?/gi },

  // Partial acceptance.
  { category: 'partial_acceptance', re: /\bpartial\s+(?:refund|credit|payment|reimbursement|return)\b/gi, negatable: true },
  { category: 'partial_acceptance', re: /\b(?:only|just)\s+(?:part|a portion|some|one)\s+of\s+(?:the|your|this)\b/gi },
  { category: 'partial_acceptance', re: /\b(?:accept|agree|approve|refund|credit)\w*\s+(?:only\s+)?(?:part|a portion|some)\s+of\b/gi, negatable: true },
  { category: 'partial_acceptance', re: /\b(?:only|just)\s+(?:be\s+able\s+to\s+|able\s+to\s+|can\s+)?(?:refund|credit|return|issue|reimburse|accept)\w*\s+(?:you\s+)?(?:back\s+)?(?:a\s+(?:refund|credit)\s+(?:of|for)\s+)?(?:US\$|USD|\$)/gi },
  { category: 'partial_acceptance', re: /\b(?:the remaining|the rest|the balance|the other|remainder)\b[^.?!\n]{0,40}\b(?:is|was|remains|will be|are)\s+(?:valid|owed|due|correct|legitimate|for (?:a |the )?(?:separate|different|other))/gi },

  // Commitments (never money returned): a promise, an issued but unapplied credit, or agreement alone.
  { category: 'refund_or_credit_commitment', status: 'promised', negatable: true, re: /\b(?:we|i)\s*(?:will|'ll|shall|are going to|plan to|intend to|can|are happy to|would be happy to)\s+(?:be\s+)?(?:issu(?:e|ing)|process(?:ing)?|refund(?:ing)?|credit(?:ing)?|reimburs(?:e|ing)|return(?:ing)?\s+(?:the|your)|apply(?:ing)?\s+(?:a|the)\s+credit|send(?:ing)?\s+(?:you\s+)?(?:a|the)\s+(?:refund|credit|check|cheque|payment))\b/gi },
  { category: 'refund_or_credit_commitment', status: 'promised', negatable: true, re: /\b(?:we|i)\s*(?:will|'ll|shall|are going to|can)\s+(?:apply|deduct|offset|net)\b/gi },
  { category: 'refund_or_credit_commitment', status: 'promised', negatable: true, re: /\b(?:refund|credit(?: memo| note)?|check|cheque|reimbursement)\s+(?:will be|is being|is going to be|should be|is scheduled to be|is set to be)\s+(?:issued|processed|sent|applied|mailed|posted|released|on its way)/gi },
  { category: 'refund_or_credit_commitment', status: 'promised', negatable: true, re: /\b(?:approved\s+(?:the|your|a)\s+(?:refund|credit)|(?:refund|credit)\s+(?:has been\s+|was\s+|is\s+)?approved)\b/gi },
  { category: 'refund_or_credit_commitment', status: 'promised', negatable: true, re: /\b(?:will|'ll)\s+(?:cut|mail|send|issue|release)\s+(?:you\s+)?a\s+(?:check|cheque|refund|credit)\b|\bexpect\s+(?:a|the|your)\s+(?:check|cheque|refund|credit|reimbursement)\b/gi },
  { category: 'refund_or_credit_commitment', status: 'credit_issued', negatable: true, re: /\b(?:credit(?: memo| note)?)\s+(?:#?\s?[A-Z0-9-]{2,20}\s+)?(?:has been|was|have been|is now)\s+(?:issued|created|posted|raised|applied to your account|added to your account)/gi },
  { category: 'refund_or_credit_commitment', status: 'credit_issued', negatable: true, re: /\b(?:credited|applied)\s+(?:US\$|USD|\$)?\s?[\d,.]*\s*(?:to|on)\s+your\s+account\b|\b(?:already\s+)?issued\s+(?:a\s+|the\s+|an\s+)?credit\s+(?:memo|note)\b/gi },
  { category: 'refund_or_credit_commitment', status: 'credit_issued', negatable: true, re: /\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:issued|created|posted|raised|applied|added)\s+(?:a|the|an)\s+(?:credit|credit memo|credit note|account credit)\b/gi },
  { category: 'refund_or_credit_commitment', status: 'accepted', negatable: true, re: /\b(?:we\s+)?(?:agree|confirm|can confirm|acknowledge)\w*\s+(?:that\s+)?(?:this|it|the (?:second |later |duplicate )?payment|invoice \S+)\s+(?:was|is|has been)\s+(?:paid twice|a duplicate|duplicated|an overpayment|overpaid)/gi },
  { category: 'refund_or_credit_commitment', status: 'accepted', negatable: true, re: /\b(?:agreed|confirmed|correct|yes)\s*[,.;:—–-]\s*(?:it|this|that)\s*(?:'s|is|was)\s+(?:a\s+)?(?:duplicate|double payment|overpayment)\b/gi },
  { category: 'refund_or_credit_commitment', status: 'accepted', negatable: true, re: /\b(?:you are|you're)\s+(?:correct|right)\b[^.?!\n]{0,60}\b(?:duplicate|paid twice|twice|overpa)/gi },

  // Says the money already went back.
  { category: 'already_refunded', negatable: true, re: /\b(?:refund|reimbursement|refund check|refund cheque|ach refund|wire|reversal)\s+(?:(?:was|has been|had been|were)\s+(?:already\s+)?(?:sent|issued|processed|mailed|returned|completed|initiated|deposited|wired)|went out|already went out)/gi },
  { category: 'already_refunded', negatable: true, re: /\b(?:we(?:'ve| have)?|i(?:'ve| have)?)\s+(?:already\s+)?(?:refunded|reimbursed|reversed|returned the|sent (?:the|a|your) refund|issued (?:the|a|your) refund|processed (?:the|a|your) refund|mailed (?:the|a) (?:refund )?check)/gi },
  { category: 'already_refunded', negatable: true, re: /\balready\s+(?:been\s+)?(?:refunded|reimbursed|returned|credited back|paid back)/gi },
  { category: 'already_refunded', negatable: true, re: /\brefunded\s+(?:on|to your|via|by|back)\b/gi },

  { category: 'payment_not_found', re: /\b(?:can(?:no|')t|cannot|could(?:n't| not)|unable to|were unable to|are unable to|not able to)\s+(?:find|locate|see|trace|identify|match)\s+(?:a\s+|the\s+|any\s+|your\s+|this\s+|that\s+)?(?:second\s+|duplicate\s+|double\s+|other\s+)?(?:payment|record|remittance|deposit|transaction|charge)/gi },
  { category: 'payment_not_found', re: /\bno\s+record\s+of\s+(?:a\s+|the\s+|any\s+|your\s+)?(?:second\s+|duplicate\s+|double\s+)?(?:payment|remittance|deposit|transaction)/gi },
  { category: 'payment_not_found', re: /\b(?:did not|didn't|never)\s+receive\s+(?:a\s+|the\s+|any\s+)?(?:second|duplicate|double|this|that)?\s*(?:payment|remittance|funds)/gi },
  { category: 'payment_not_found', re: /\b(?:only|just)\s+(?:received|see|show|shows|have|has)\s+(?:one|a single)\s+payment/gi },
  { category: 'payment_not_found', re: /\b(?:payment|remittance)\s+(?:was\s+|is\s+)?not\s+(?:found|received|on file)\b/gi },

  { category: 'wrong_contact', re: /\bno longer\s+(?:with|at|employed|works?|working|handles?|handling|responsible|manages?|monitored|in charge)\b/gi },
  { category: 'wrong_contact', re: /\b(?:wrong|incorrect|not the (?:right|correct|appropriate))\s+(?:person|contact|department|team|address|e-?mail|mailbox|recipient)\b/gi },
  { category: 'wrong_contact', re: /\b(?:please|kindly)\s+(?:contact|reach out to|e-?mail|write to|direct (?:this|your (?:request|inquiry|email)|(?:[a-z]+\s+){0,2}(?:requests?|questions?|inquiries|claims?)) to|send (?:this|it|your (?:request|inquiry|email)) to|redirect (?:this|your request) to)\s+(?:our\s+|the\s+)?(?:accounts receivable|a\/r|ar|billing|finance|credit|accounting|collections|refunds?|customer service)\b/gi },
  { category: 'wrong_contact', re: /\b(?:please|kindly)\s+(?:direct|send|forward|address)\s+(?:[a-z]+\s+){0,2}(?:requests?|questions?|inquiries|claims?)\s+to\b/gi },
  { category: 'wrong_contact', re: /\b(?:this (?:mailbox|inbox|address) is (?:not monitored|unmonitored|no longer)|i (?:don't|do not) handle|not (?:my|our) (?:department|area|team))\b/gi },
]

/** A counter-offer or settlement proposal: never read as an answer, a person decides (Reclaim never accepts an offer). */
const OFFER = /\b(?:goodwill|as a (?:one-time )?courtesy|settle (?:this )?for|in full settlement|in exchange for|counter-?offer|(?:we|i) (?:can|could|would|are willing to|are prepared to) offer|our offer|if you (?:agree|accept|waive|withdraw))\b/i
const AUTO_REPLY = /\b(?:out of (?:the )?office|automatic reply|auto-?reply|autoreply|on (?:annual |parental |medical |vacation )?leave until|away from (?:my desk|the office)|limited access to e-?mail|unsubscribe|this is an automated (?:message|notification))\b/i
/** "Once we receive X, we will refund": a condition, not a promise. */
const CONDITIONAL = /\b(?:before|until|unless|if|once|when|after|provided|pending)\b[^.?!\n]{0,45}$/i
const NEGATION = /\b(?:not|no|never|unable|cannot|can't|won't|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|haven't|hasn't|without)\b[^.?!\n]{0,25}$/i

const METHODS: Array<[RecoveryMethod, RegExp]> = [
  ['offset', /\b(?:against\s+(?:your\s+)?(?:next|future|upcoming)\s+(?:invoice|bill|payment)s?|offset|deduct(?:ed)?\s+(?:it\s+)?from\s+(?:your\s+)?(?:next|future|upcoming)|(?:apply|applied)\s+(?:it\s+|the\s+(?:amount|credit)\s+)?(?:to|against)\s+(?:your\s+)?(?:next|future|upcoming)\s+(?:invoice|bill|payment)|net(?:ted)?\s+(?:it\s+)?against)\b/i],
  ['credit', /\b(?:credit memo|credit note|account credit|credit (?:to|on) your account|credit your account|credited to your account|store credit|(?:issu|appl|post|rais)\w*\s+(?:a|an|the)\s+credit)\b/i],
  ['refund', /\b(?:refund(?:ed|ing|s)?|cheque|ach|wire(?:d)?|bank transfer|reimburs\w*|(?:mail|send|sen|issu)\w*\s+(?:you\s+)?a\s+check)\b/i],
]

/** Category pairs that read as one answer; anything else is a conflict. */
const COMPATIBLE: Array<[ReplyCategory, ReplyCategory, ReplyCategory]> = [
  ['partial_acceptance', 'refund_or_credit_commitment', 'partial_acceptance'],
  ['partial_acceptance', 'request_for_information', 'partial_acceptance'],
  ['partial_acceptance', 'dispute', 'partial_acceptance'],
  ['refund_or_credit_commitment', 'request_for_information', 'refund_or_credit_commitment'],
  ['already_refunded', 'request_for_information', 'already_refunded'],
  ['payment_not_found', 'request_for_information', 'payment_not_found'],
  ['payment_not_found', 'dispute', 'payment_not_found'],
  ['wrong_contact', 'request_for_information', 'wrong_contact'],
]

function resolve(categories: Set<ReplyCategory>): ReplyCategory {
  const list = [...categories]
  if (list.length === 1) return list[0]
  let current = list[0]
  for (const next of list.slice(1)) {
    const pair = COMPATIBLE.find(([a, b]) => (a === current && b === next) || (a === next && b === current))
    if (!pair) return 'unknown'
    current = pair[2]
  }
  // Re-check every pair against the result: three-way mixes must all agree with it.
  return list.every((c) => c === current || COMPATIBLE.some(([a, b, r]) => r === current && (a === c || b === c))) ? current : 'unknown'
}

const DAY_MS = 86_400_000
const empty = (category: ReplyCategory, flags: string[], evidence: Span[] = [], amounts: AmountCandidate[] = [], dates: DateCandidate[] = []): ReplyClassification =>
  ({ source: 'rules', category, status: null, amount: null, method: null, expectedDate: null, evidence, amounts, dates, flags, confidence: null })

/** The deterministic answer for a stripped reply. Pure: same text and case, same result. */
export function classifyReply(original: string, ctx: CaseContext): ReplyClassification {
  // Typographic apostrophes and quotes become ASCII one for one, so offsets still point into the original.
  const text = original.replace(/[’‘ʼ]/g, "'").replace(/[“”]/g, '"')
  const amounts = findAmounts(text)
  const dates = findDates(text)
  if (!text.trim()) return empty('unclear', ['empty_reply'])
  if (instructionLike(text)) return empty('unknown', ['instruction_like_text'], [], amounts, dates)
  if (AUTO_REPLY.test(text)) return empty('unclear', ['auto_reply'], [], amounts, dates)
  if (OFFER.test(text)) return empty('unknown', ['offer_needs_person'], [], amounts, dates)

  const flags = new Set<string>()
  const hits: Array<Span & { category: Signal['category']; status?: VendorUpdateStatus }> = []
  for (const signal of SIGNALS) {
    for (const m of text.matchAll(signal.re)) {
      const start = m.index
      if (signal.negatable && NEGATION.test(text.slice(Math.max(0, start - 30), start))) {
        flags.add(`negated_${signal.category}`)
        continue
      }
      if (signal.category === 'refund_or_credit_commitment' && CONDITIONAL.test(text.slice(Math.max(0, start - 50), start))) {
        flags.add('conditional_commitment')
        continue
      }
      hits.push({ start, end: start + m[0].length, text: original.slice(start, start + m[0].length), category: signal.category, status: signal.status })
    }
  }
  const substantive = new Set<ReplyCategory>(hits.filter((h) => h.category !== 'acknowledgement').map((h) => h.category))
  const category: ReplyCategory = substantive.size ? resolve(substantive) : hits.length ? 'acknowledgement' : 'unclear'
  const evidence = hits.filter((h) => h.category === category).sort((a, b) => a.start - b.start).map(({ start, end, text: t }) => ({ start, end, text: t }))
  if (category === 'unknown') return empty('unknown', [...flags, 'conflicting_signals'], hits.map(({ start, end, text: t }) => ({ start, end, text: t })), amounts, dates)
  if (category === 'unclear') return empty('unclear', [...flags, 'no_signal'], [], amounts, dates)
  if (amounts.some((a) => a.currency !== 'USD')) return empty('unknown', [...flags, 'non_usd_currency'], evidence, amounts, dates)

  let status: VendorUpdateStatus = CATEGORY_STATUSES[category][0]
  if (category === 'refund_or_credit_commitment') {
    const statuses = new Set(hits.filter((h) => h.category === category).map((h) => h.status))
    status = statuses.has('credit_issued') && !statuses.has('promised') ? 'credit_issued' : statuses.has('promised') ? 'promised' : 'accepted'
    if (statuses.has('credit_issued') && statuses.has('promised')) flags.add('promise_and_issued_credit')
  }

  const rule = VENDOR_STATUS[status].amount
  let amount: number | null = null
  let method: RecoveryMethod | null = null
  let expectedDate: string | null = null
  if (rule !== 'none') {
    const usd = amounts.filter((a) => a.currency === 'USD')
    const distinct = [...new Set(usd.map((a) => a.minor))]
    if (usd.some((a) => a.minor === null)) return empty('unknown', [...flags, 'unparseable_amount'], evidence, amounts, dates)
    if (/\b\d+(?:\.\d+)?\s?(?:%|percent\b|per cent\b)/i.test(text)) return empty('unknown', [...flags, 'percentage'], evidence, amounts, dates)
    if (distinct.length > 1) return empty('unknown', [...flags, 'multiple_amounts'], evidence, amounts, dates)
    if (distinct.length === 1) {
      const minor = distinct[0]!
      const requestedMinor = ctx.requestedAmount === null ? null : Math.round(ctx.requestedAmount * 100)
      if (requestedMinor === null) return empty('unknown', [...flags, 'no_requested_amount'], evidence, amounts, dates)
      if (minor > requestedMinor) return empty('unknown', [...flags, 'amount_exceeds_request'], evidence, amounts, dates)
      if (status === 'partial_acceptance' && minor === requestedMinor) return empty('unknown', [...flags, 'partial_equals_request'], evidence, amounts, dates)
      amount = minor / 100
    } else if (rule === 'required') return empty('unknown', [...flags, 'amount_missing'], evidence, amounts, dates)
    const methods = METHODS.filter(([, re]) => re.test(text)).map(([m]) => m)
    // "refund" also appears in "refund or credit"; a more specific method wins only when it is the only specific one.
    const specific = methods.filter((m) => m !== 'refund')
    method = specific.length === 1 ? specific[0] : specific.length === 0 && methods.includes('refund') ? 'refund' : null
    if (specific.length > 1) flags.add('several_methods')
  } else if (amounts.length) flags.add('amounts_ignored_for_status')

  if (status === 'promised') {
    const usable = dates.filter((d) => !d.ambiguous && d.iso !== null && Date.parse(`${d.iso}T23:59:59Z`) >= ctx.receivedAt - DAY_MS)
    if (dates.some((d) => d.ambiguous)) flags.add('ambiguous_date')
    if (usable.length === 1 && !dates.some((d) => d.ambiguous)) expectedDate = usable[0].iso
    else if (usable.length > 1) flags.add('several_dates')
  }

  return { source: 'rules', category, status, amount, method, expectedDate, evidence, amounts, dates, flags: [...flags], confidence: null }
}

export const CATEGORY_LABEL: Record<ReplyCategory, string> = {
  acknowledgement: 'an acknowledgement', dispute: 'a dispute', request_for_information: 'a request for information',
  partial_acceptance: 'a partial acceptance', refund_or_credit_commitment: 'a refund or credit commitment', already_refunded: 'a report that a refund was sent',
  payment_not_found: 'a report that the payment cannot be found', wrong_contact: 'a wrong-contact reply', unclear: 'unclear', unknown: 'ambiguous',
}

export interface VendorUpdateInput {
  status: VendorUpdateStatus
  note: string
  at: number
  amount?: number
  method?: RecoveryMethod
  expectedAt?: number
}

/**
 * The `vendor_update` case-command input for a classification, or null.
 * The note is fixed wording: supplier text never enters case history unread.
 */
export function vendorUpdateFor(c: ReplyClassification, ref: { messageId: string; receivedAt: number; origin: 'inbound' | 'ai' }): VendorUpdateInput | null {
  if (!c.status || c.category === 'unknown' || c.category === 'unclear') return null
  if (!CATEGORY_STATUSES[c.category].includes(c.status)) return null
  const rule = VENDOR_STATUS[c.status].amount
  if (rule === 'required' && c.amount === null) return null
  const who = ref.origin === 'ai' ? 'An AI reading' : "Reclaim's rules"
  const input: VendorUpdateInput = {
    status: c.status,
    note: `${who} of the supplier reply received ${new Date(ref.receivedAt).toISOString().slice(0, 10)} (inbound message ${ref.messageId}) suggest ${CATEGORY_LABEL[c.category]}. Read the reply before approving.`,
    at: ref.receivedAt,
  }
  if (rule !== 'none' && c.amount !== null) input.amount = c.amount
  if (rule !== 'none' && c.method) input.method = c.method
  if (c.status === 'promised' && c.expectedDate) input.expectedAt = Date.parse(`${c.expectedDate}T12:00:00Z`)
  return input
}
