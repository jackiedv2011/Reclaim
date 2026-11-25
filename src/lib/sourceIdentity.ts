import type { APRecord, SourceProvenance } from '@/types'
import { normalizeVendor } from './format'

/** SHA-256 over UTF-8. Synchronous because CSV parsing and ledger merges are synchronous. */
export function checksum(value: string): string {
  const bytes = new TextEncoder().encode(value)
  const size = Math.ceil((bytes.length + 9) / 64) * 64
  const buffer = new Uint8Array(size)
  buffer.set(bytes); buffer[bytes.length] = 128
  const view = new DataView(buffer.buffer)
  view.setUint32(size - 8, Math.floor(bytes.length / 0x20000000))
  view.setUint32(size - 4, bytes.length * 8)
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  const rotr = (x:number,n:number) => (x >>> n) | (x << (32-n))
  const w = new Uint32Array(64)
  for (let offset=0;offset<size;offset+=64) {
    for(let i=0;i<16;i++) w[i]=view.getUint32(offset+i*4)
    for(let i=16;i<64;i++) {
      const a=w[i-15],b=w[i-2]
      w[i]=(rotr(a,7)^rotr(a,18)^(a>>>3))+w[i-16]+(rotr(b,17)^rotr(b,19)^(b>>>10))+w[i-7]
    }
    let [a,b,c,d,e,f,g,z]=h
    for(let i=0;i<64;i++) {
      const t=(z+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+k[i]+w[i])|0
      const u=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))|0
      z=g;g=f;f=e;e=(d+t)|0;d=c;c=b;b=a;a=(t+u)|0
    }
    ;[a,b,c,d,e,f,g,z].forEach((v,i)=>h[i]=(h[i]+v)>>>0)
  }
  return h.map(v=>v.toString(16).padStart(8,'0')).join('')
}

export function normalizeReference(raw: string | null): { value: string | null; transformations: string[] } {
  if (raw === null) return {value:null,transformations:[]}
  let value=raw
  const transformations:string[]=[]
  const step=(name:string,next:string)=>{if(next!==value) transformations.push(name);value=next}
  step('trim_whitespace',value.trim())
  step('lowercase',value.toLowerCase())
  // "Inv. 1001", "INV#1001", "Invoice No. 1001" and "INV1001" all name invoice 1001.
  step('remove_invoice_prefix',value.replace(/^(?:invoice|inv)(?:[\s.#:_/-]+(?=\w)|(?=\d))(?:(?:number|num|no)[\s.#:_-]*(?=\d))?/,''))
  step('remove_spacing_and_punctuation',value.replace(/[\s\-_.:#/]/g,''))
  return {value:value||null,transformations}
}
/**
 * The reference two rows are compared by: normalized, and without the padding
 * ("0042", "PO-00042") some systems print in front of a number. The stored
 * normalized value keeps its zeros.
 */
export function referenceKey(raw: string | null): string | null {
  const { value } = normalizeReference(raw)
  return value === null ? null : value.replace(/^([a-z]*)0+(?=\d)/,'$1')
}
/**
 * Words that stand in the reference field when there is no invoice number: how
 * it was paid ("Debit", which QuickBooks writes on card purchases), what it was
 * for ("Rent"), how often, or which month. A reference made up only of these
 * words identifies no invoice; one with a number or a name in it still does.
 */
const PLACEHOLDER_REFERENCES = new Set((
  'debit credit cash check cheque chk card creditcard debitcard visa mastercard amex discover ach eft wire transfer zelle venmo paypal ' +
  'payment pmt pymt pay paid billpay autopay auto autopayment autodebit autodraft autowithdrawal draft withdrawal direct directdebit directdeposit ' +
  'online web internet phone electronic epay bank ' +
  'recurring standing standingorder daily weekly biweekly monthly quarterly annual annually yearly month week quarter year ' +
  'rent rental lease subscription membership dues retainer payroll salary wages deposit loan insurance premium utilities utility tax taxes fee fees service services ' +
  'statement stmt invoice inv bill ref reference receipt memo number no account acct onaccount ' +
  'instalment installment partial balance final advance prepayment prepaid ' +
  'na none null nil tbd unknown misc miscellaneous various other general ' +
  'january february march april may june july august september october november december jan feb mar apr jun jul aug sep sept oct nov dec'
).split(' '))
/** Up to this many characters, a reference ("1", "12", a check number) is too common to identify an invoice on its own. */
const SHORT_REFERENCE_MAX_LENGTH = 2

function isPlaceholder(raw: string): boolean {
  const words = raw.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  // "N/A" and "A.C.H." are one word written with separators.
  return words.every((word) => PLACEHOLDER_REFERENCES.has(word)) || PLACEHOLDER_REFERENCES.has(words.join(''))
}

/**
 * How far an invoice reference can be trusted to identify one invoice.
 * - none: missing, blank, all zeros or only placeholder words; treated as no reference.
 * - short: one or two characters; the same invoice only when the amount matches too.
 * - strong: everything else. Leading zeros count: "001" is a three-character reference.
 */
export function referenceStrength(raw: string | null): 'none' | 'short' | 'strong' {
  const { value } = normalizeReference(raw)
  if (raw === null || value === null || /^0+$/.test(value) || isPlaceholder(raw)) return 'none'
  return value.length <= SHORT_REFERENCE_MAX_LENGTH ? 'short' : 'strong'
}
export function vendorTransformations(raw:string):string[] {
  const steps:string[]=[]
  let value=raw
  for(const [name,next] of [['trim_whitespace',value.trim()],['lowercase',value.trim().toLowerCase()]] ) {
    if(next!==value) steps.push(name); value=next
  }
  if (value.replace(/\s+/g,' ')!==value) steps.push('collapse_whitespace')
  value=value.replace(/\s+/g,' ')
  if(value.replace(/[.,]+$/g,'')!==value) steps.push('remove_trailing_punctuation')
  value=value.replace(/[.,]+$/g,'')
  if(normalizeVendor(raw)!==value) steps.push('remove_legal_suffix')
  return steps
}
/** The untouched cell a field came from, whichever heading the file put it under. */
export function sourceCell(source: SourceProvenance | undefined, field: string): string | undefined {
  if (!source?.raw) return undefined
  const key = source.columns ? source.columns[field] : field
  return key === undefined ? undefined : source.raw[key]
}
export function sourceSignature(record: APRecord): string {
  const raw=record.source?.raw
  return JSON.stringify(raw ? Object.keys(raw).sort().map(k=>[k,raw[k]]) : [record.vendor,record.invoiceNumber,record.paymentDate.toISOString(),record.invoiceAmount,record.amountPaid,record.currency??null,record.terms,record.bankAccountLast4,record.category])
}
export function recordIdentity(record:APRecord):string {
  return record.externalTransactionId
    ? JSON.stringify(['external',record.company??null,record.sourceAccount??null,record.externalTransactionId])
    : JSON.stringify(['raw', record.company??null,record.sourceAccount??null,sourceCell(record.source,'vendor')??record.vendor,sourceCell(record.source,'invoice_number')??record.invoiceNumber,record.paymentDate.toISOString(),record.amountPaid,record.currency??null,record.transactionType??null])
}
