/**
 * Deterministic return matching: does an independent source record (a vendor
 * credit, a deposit from the supplier, a refund) evidence money coming back
 * against an open supplier recovery request?
 *
 * Pure functions only. Nothing here changes a case, closes a case, posts an
 * accounting entry, applies a credit, or produces a "recovered" figure. The
 * output is a proposal for the case gate (recovery workstream) to decide on.
 *
 * Rules this module keeps:
 * - Never cross-tenant. Records from another tenant are not considered and are
 *   never mentioned in a request's rationale (not even as a count).
 * - No currency conversion. A currency mismatch excludes the record.
 * - A record dated before the request (minus a small tolerance) is never a
 *   match for that request; it is labelled a possible prior return.
 * - One record is never allocated across requests beyond its own amount.
 *   When requests compete for a record and reference cannot break the tie,
 *   every competing request is 'ambiguous' and nothing is allocated.
 * - Issued credit is not applied credit is not returned value. Only refunds
 *   and the applied part of a credit count toward `amountMinor` of a
 *   'proposed_source_match'.
 * - Customer-recorded returns are echoed separately and never added to
 *   source-evidenced amounts. Supplier promises are never counted.
 * - Stale or unknown source coverage makes "no match" an unknown, not a
 *   negative conclusion.
 */
import type { ReturnMatch, ReturnMatchStatus, SourceRecord, SourceRecordKind } from '../contracts/financial.ts'
import { FINANCIAL_CONTRACT_VERSION } from '../contracts/financial.ts'
import type { VendorUpdateStatus } from '../ledger/caseState.ts'

export const RETURN_MATCH_VERSION = 'return-match/1.0.0' as const

/** Default days a return may predate the logged request and still count (clock/entry lag). */
export const DEFAULT_DATE_TOLERANCE_DAYS = 2
/** Normalized references shorter than this never count as reference agreement. */
export const MIN_REFERENCE_LENGTH = 4

// ---------------------------------------------------------------- inputs

export type OpenRecoveryRequestStatus = 'requested' | VendorUpdateStatus

export interface OpenRecoveryRequest {
  projectId: string
  findingId: string
  /** Pass only the active generation of each finding; superseded generations would compete. */
  requestGeneration: number
  tenantId: string
  vendorKey: string
  sourceAccount: string | null
  currency: string
  requestedAmountMinor: number
  /** ISO date (YYYY-MM-DD, or a full ISO timestamp; only the date part is used). */
  requestedAt: string
  /** Invoice / claim references, normalized or raw (normalized again here). */
  references: string[]
  /** Returns the customer recorded themselves. Echoed, never summed with source evidence. */
  alreadyRecordedMinor: number
  status: OpenRecoveryRequestStatus
}

export type ReturnRecordKind = Extract<SourceRecordKind, 'vendor_credit' | 'deposit' | 'refund'>

/** A source-system link applying (part of) a credit to a bill, e.g. a BillPayment line. */
export interface BillApplication {
  billRef: string
  amountMinor: number
  date: string | null
}

export interface ReturnSourceRecord extends Omit<SourceRecord, 'kind'> {
  kind: ReturnRecordKind
  /** Verified applications of this credit to bills (vendor_credit only). */
  appliedToBills?: BillApplication[]
  /** ID of the transaction that reversed or voided this one, when known. */
  reversedBy?: string | null
  /** Reference found in the memo / private note (e.g. the disputed invoice number). */
  memoReference?: string | null
}

/** A link proposed by an earlier run, used to detect a matched record that was later reversed. */
export interface PreviousReturnLink {
  requestRef: ReturnMatch['requestRef']
  sourceRecordIds: string[]
}

export interface MatchReturnsOptions {
  /** Date the source data is fresh as of (export or sync time). Undefined/null = unknown. */
  dataAsOf?: string | null
  dateToleranceDays?: number
  previousLinks?: readonly PreviousReturnLink[]
}

// ---------------------------------------------------------------- outputs

export type CoverageState = 'current' | 'stale' | 'unknown'

/**
 * The contract `ReturnMatch` plus fields that keep different kinds of value
 * apart. `amountMinor` semantics by status:
 * - proposed_source_match: refunds plus the APPLIED part of linked credits.
 * - unmatched / customer_recorded with linked credits: credit ISSUED but not
 *   applied (applied = false). Not returned value.
 * - ambiguous / conflict / otherwise: null. `linkedSourceRecordIds` then lists
 *   the records under contention or in conflict, with no amount attributed.
 */
export interface RequestReturnMatch extends ReturnMatch {
  requestKey: string
  /** Credit linked to this request but not applied to any bill. Never returned value. */
  creditIssuedNotAppliedMinor: number | null
  /** Echo of the customer's own recorded returns. Not source evidence; never summed with amountMinor. */
  customerRecordedMinor: number | null
  coverage: CoverageState
}

export interface ReturnAllocation {
  requestKey: string
  requestRef: ReturnMatch['requestRef']
  sourceRecordId: string
  currency: string
  /** Portion of the record attributed to this request (never more than the request's outstanding amount). */
  allocatedMinor: number
  /** Of allocatedMinor, the part that evidences returned value: refunds in full, credits only where applied. */
  returnedEvidenceMinor: number
  method: 'refund' | 'credit'
  /** Null for refunds/deposits (not applicable). */
  applied: boolean | null
  basis: 'reference' | 'exact_amount'
}

export interface UnallocatedReturnRecord {
  sourceRecordId: string
  tenantId: string
  vendorKey: string
  currency: string | null
  /** Value not attributed to any request. 0 for duplicates and reversed records; null when the amount is unknown. */
  unallocatedMinor: number | null
  /** Stable reason codes, e.g. 'pre_request', 'contested', 'excess_over_request', 'duplicate_of:<id>'. */
  reasons: string[]
  /** Request keys the reasons refer to. */
  relatedRequests: string[]
}

export interface ReturnMatchResult {
  contractVersion: typeof FINANCIAL_CONTRACT_VERSION
  algorithmVersion: typeof RETURN_MATCH_VERSION
  /** Exactly one per distinct request, sorted by requestKey. */
  matches: RequestReturnMatch[]
  allocations: ReturnAllocation[]
  unallocatedRecords: UnallocatedReturnRecord[]
}

// ---------------------------------------------------------------- helpers

export function requestKeyOf(ref: { projectId: string; findingId: string; requestGeneration: number }): string {
  return `${ref.projectId}:${ref.findingId}:g${ref.requestGeneration}`
}

export function normalizeReference(value: string | null | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const isMinor = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0

function isoDay(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null
  const day = value.slice(0, 10)
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === day ? day : null
}

function shiftDay(day: string, days: number): string {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10)
}

function recordDay(r: ReturnSourceRecord): string | null {
  return r.kind === 'vendor_credit' ? isoDay(r.invoiceDate ?? r.paymentDate) : isoDay(r.paymentDate ?? r.invoiceDate)
}

const methodOf = (r: ReturnSourceRecord): 'refund' | 'credit' => (r.kind === 'vendor_credit' ? 'credit' : 'refund')

// ---------------------------------------------------------------- record preparation

type RecordIssue =
  | 'unsupported_kind'
  | 'reversed'
  | 'conflicting_duplicate'
  | 'applied_exceeds_credit'
  | 'invalid_application'
  | 'amount_unknown'
  | 'date_unknown'
  | 'currency_unknown'

/** Issues that make any request the record would otherwise fit a 'conflict'. */
const CONFLICT_ISSUES: ReadonlySet<RecordIssue> = new Set(['conflicting_duplicate', 'applied_exceeds_credit', 'invalid_application'])

interface PreparedRecord {
  rec: ReturnSourceRecord
  day: string | null
  issues: RecordIssue[]
  /** Canonical record this one duplicates (exact identity, or same reference/amount/date). */
  duplicateOf: string | null
  duplicateKind: 'identity' | 'possible' | null
  duplicates: string[]
  appliedTotal: number
  refs: string[]
}

function prepareRecords(records: readonly ReturnSourceRecord[]): PreparedRecord[] {
  const byId = new Map<string, ReturnSourceRecord>()
  for (const r of [...records].sort((a, b) => cmp(a.id, b.id))) if (!byId.has(r.id)) byId.set(r.id, r)
  const prepared: PreparedRecord[] = []
  const identity = new Map<string, PreparedRecord>()
  const lookalike = new Map<string, PreparedRecord>()

  for (const rec of byId.values()) {
    const issues: RecordIssue[] = []
    if (rec.kind !== 'vendor_credit' && rec.kind !== 'deposit' && rec.kind !== 'refund') issues.push('unsupported_kind')
    if (rec.status === 'voided' || rec.status === 'reversed' || Boolean(rec.reversedBy)) issues.push('reversed')
    if (!isMinor(rec.amountMinor)) issues.push('amount_unknown')
    const day = recordDay(rec)
    if (!day) issues.push('date_unknown')
    if (!rec.currency) issues.push('currency_unknown')
    let appliedTotal = 0
    if (rec.kind === 'vendor_credit') {
      for (const app of rec.appliedToBills ?? []) {
        if (!isMinor(app.amountMinor) || !normalizeReference(app.billRef)) {
          issues.push('invalid_application')
          break
        }
        appliedTotal += app.amountMinor
      }
      if (isMinor(rec.amountMinor) && appliedTotal > rec.amountMinor) issues.push('applied_exceeds_credit')
    }
    const refs = new Set<string>()
    const own = normalizeReference(rec.referenceNormalized ?? rec.referenceRaw)
    if (own && rec.referenceStrength === 'strong') refs.add(own)
    const memo = normalizeReference(rec.memoReference)
    if (memo) refs.add(memo)
    for (const app of rec.appliedToBills ?? []) {
      const bill = normalizeReference(app.billRef)
      if (bill) refs.add(bill)
    }
    const p: PreparedRecord = {
      rec, day, issues, duplicateOf: null, duplicateKind: null, duplicates: [], appliedTotal,
      refs: [...refs].filter((x) => x.length >= MIN_REFERENCE_LENGTH).sort(cmp),
    }

    // Same transaction imported twice: same identity key, or same source-native ID.
    const keys = [`id|${rec.tenantId}|${rec.identityKey}`]
    if (rec.sourceNativeId) keys.push(`native|${rec.tenantId}|${rec.sourceSystem}|${rec.kind}|${rec.sourceNativeId}`)
    const canonical = keys.map((k) => identity.get(k)).find(Boolean)
    if (canonical) {
      p.duplicateOf = canonical.rec.id
      p.duplicateKind = 'identity'
      canonical.duplicates.push(rec.id)
      const same = canonical.rec.kind === rec.kind && canonical.rec.vendorKey === rec.vendorKey && canonical.rec.currency === rec.currency &&
        canonical.rec.amountMinor === rec.amountMinor && canonical.day === day && canonical.issues.includes('reversed') === issues.includes('reversed')
      if (!same) {
        if (!canonical.issues.includes('conflicting_duplicate')) canonical.issues.push('conflicting_duplicate')
        issues.push('conflicting_duplicate')
      }
    } else {
      for (const k of keys) identity.set(k, p)
      // Same reference, amount, date, supplier and currency under a different identity:
      // possibly the same money from two sources. Counted once (conservative).
      const strongRef = own && rec.referenceStrength === 'strong' ? own : memo
      if (strongRef && strongRef.length >= MIN_REFERENCE_LENGTH && isMinor(rec.amountMinor) && day && rec.currency) {
        const look = `${rec.tenantId}|${rec.vendorKey}|${rec.currency}|${rec.kind}|${rec.amountMinor}|${day}|${strongRef}`
        const first = lookalike.get(look)
        if (first) {
          p.duplicateOf = first.rec.id
          p.duplicateKind = 'possible'
          first.duplicates.push(rec.id)
        } else lookalike.set(look, p)
      }
    }
    prepared.push(p)
  }
  return prepared
}

// ---------------------------------------------------------------- request preparation

interface PreparedRequest {
  req: OpenRecoveryRequest
  key: string
  ref: ReturnMatch['requestRef']
  day: string | null
  refs: Set<string>
  invalid: string[]
  conflicts: string[]
  notes: string[]
  competing: Set<string>
  ambiguousRecords: Set<string>
  conflictRecords: Set<string>
  duplicateInput: boolean
}

function prepareRequest(req: OpenRecoveryRequest): PreparedRequest {
  const ref = { projectId: req.projectId, findingId: req.findingId, requestGeneration: req.requestGeneration }
  const day = isoDay(req.requestedAt)
  const invalid: string[] = []
  if (!Number.isSafeInteger(req.requestGeneration) || req.requestGeneration < 1) invalid.push('request generation is not a positive integer')
  if (!isMinor(req.requestedAmountMinor)) invalid.push('requested amount is not a positive integer of minor units')
  if (!req.currency || !/^[A-Z]{3}$/.test(req.currency)) invalid.push('request currency is not an ISO 4217 code')
  if (!day) invalid.push('request date is not a valid ISO date')
  if (!req.tenantId || !req.vendorKey) invalid.push('request has no tenant or supplier key')
  if (!Number.isSafeInteger(req.alreadyRecordedMinor) || req.alreadyRecordedMinor < 0) invalid.push('customer-recorded amount is not a non-negative integer of minor units')
  return {
    req, key: requestKeyOf(ref), ref, day,
    refs: new Set(req.references.map(normalizeReference).filter((x) => x.length >= MIN_REFERENCE_LENGTH)),
    invalid, conflicts: [], notes: [], competing: new Set(), ambiguousRecords: new Set(), conflictRecords: new Set(), duplicateInput: false,
  }
}

// ---------------------------------------------------------------- matching

type Tier = 'reference' | 'exact_amount' | 'weak'

interface Edge {
  q: PreparedRequest
  p: PreparedRecord
  tier: Tier
  agreed: string[]
}

const SUPPLIER_STATEMENT_STATUSES: ReadonlySet<string> = new Set(['accepted', 'partial_acceptance', 'promised', 'credit_issued', 'already_refunded'])

/**
 * Match open recovery requests to independent return records.
 *
 * Deterministic: the same inputs (in any order) give the same output, sorted by
 * request key, then record id.
 */
export function matchReturns(
  requests: readonly OpenRecoveryRequest[],
  records: readonly ReturnSourceRecord[],
  opts: MatchReturnsOptions = {},
): ReturnMatchResult {
  const tolerance = Number.isSafeInteger(opts.dateToleranceDays) && (opts.dateToleranceDays ?? 0) >= 0 ? opts.dateToleranceDays! : DEFAULT_DATE_TOLERANCE_DAYS
  const dataAsOf = isoDay(opts.dataAsOf ?? null)
  const prepared = prepareRecords(records)

  // One request per key; a repeated key in the input is the same request.
  const reqs: PreparedRequest[] = []
  const seenKeys = new Map<string, PreparedRequest>()
  const sortedInput = [...requests].sort((a, b) => cmp(requestKeyOf(a), requestKeyOf(b)) || cmp(a.tenantId, b.tenantId))
  for (const req of sortedInput) {
    const q = prepareRequest(req)
    const seen = seenKeys.get(q.key)
    if (seen) {
      seen.duplicateInput = true
      continue
    }
    seenKeys.set(q.key, q)
    reqs.push(q)
  }

  const previouslyLinked = new Map<string, Set<string>>()
  for (const link of opts.previousLinks ?? []) {
    const k = requestKeyOf(link.requestRef)
    const set = previouslyLinked.get(k) ?? new Set<string>()
    for (const id of link.sourceRecordIds) set.add(id)
    previouslyLinked.set(k, set)
  }

  // Per-record notes for the unallocated list.
  const recordReasons = new Map<string, Map<string, Set<string>>>()
  const noteRecord = (id: string, reason: string, requestKey?: string) => {
    const reasons = recordReasons.get(id) ?? new Map<string, Set<string>>()
    const related = reasons.get(reason) ?? new Set<string>()
    if (requestKey) related.add(requestKey)
    reasons.set(reason, related)
    recordReasons.set(id, reasons)
  }

  const edges: Edge[] = []
  for (const q of reqs) {
    if (q.invalid.length) continue
    const { req } = q
    const linkedBefore = previouslyLinked.get(q.key) ?? new Set<string>()
    const counts = new Map<string, string[]>()
    const count = (code: string, id: string) => counts.set(code, [...(counts.get(code) ?? []), id])
    const earliest = shiftDay(q.day!, -tolerance)

    for (const p of prepared) {
      const r = p.rec
      // Never cross-tenant, and other suppliers are simply not candidates; neither is mentioned.
      if (r.tenantId !== req.tenantId || r.vendorKey !== req.vendorKey) continue
      if (p.issues.includes('unsupported_kind')) continue
      if (linkedBefore.has(r.id) && p.issues.includes('reversed')) {
        q.conflicts.push(`previously_linked_record_reversed: record ${r.id} was linked to this request earlier and is now voided or reversed`)
        q.conflictRecords.add(r.id)
        continue
      }
      if (p.duplicateOf) continue // reported with its canonical record below
      if (p.issues.includes('currency_unknown')) { count('currency_unknown', r.id); continue }
      if (r.currency !== req.currency) { count('currency_mismatch', r.id); continue }
      if (r.sourceAccount && req.sourceAccount && r.sourceAccount !== req.sourceAccount) { count('source_account_mismatch', r.id); continue }
      if (p.issues.includes('reversed')) { count('reversed_excluded', r.id); noteRecord(r.id, 'reversed', q.key); continue }
      const conflictIssue = p.issues.find((i) => CONFLICT_ISSUES.has(i))
      if (conflictIssue) {
        q.conflicts.push(`record_integrity_conflict: record ${r.id} has ${conflictIssue.replace(/_/g, ' ')}`)
        q.conflictRecords.add(r.id)
        continue
      }
      if (p.issues.includes('amount_unknown') || p.issues.includes('date_unknown')) { count('unevaluable_record', r.id); continue }
      if (p.day! < earliest) {
        count('possible_prior_return', r.id)
        noteRecord(r.id, 'pre_request', q.key)
        continue
      }
      const agreed = p.refs.filter((x) => q.refs.has(x))
      const tier: Tier = agreed.length ? 'reference' : r.amountMinor === req.requestedAmountMinor ? 'exact_amount' : 'weak'
      if (tier === 'weak') {
        count('unlinked_supplier_activity', r.id)
        noteRecord(r.id, 'no_reference_or_amount_agreement', q.key)
        continue
      }
      edges.push({ q, p, tier, agreed })
      for (const dup of p.duplicates) count('duplicate_counted_once', `${dup} (same as ${r.id})`)
    }

    const describe: Record<string, string> = {
      currency_unknown: 'excluded: record currency unknown, so it cannot be compared',
      currency_mismatch: 'excluded: record currency differs from the request; no conversion is done',
      source_account_mismatch: 'excluded: record source account differs from the request',
      reversed_excluded: 'excluded: record is voided or reversed',
      unevaluable_record: 'not evaluated: record amount or date unknown; absence of a match is therefore incomplete',
      possible_prior_return: 'record predates the request, so it is not a return against this request; possible prior return for review',
      unlinked_supplier_activity: 'supplier activity after the request agrees on neither reference nor exact amount; not linked, needs human review',
      duplicate_counted_once: 'duplicate of a candidate record (same transaction imported twice or same reference/amount/date); counted once',
    }
    for (const code of Object.keys(describe)) {
      const ids = counts.get(code)
      if (ids) q.notes.push(`${code}: ${describe[code]} (${ids.sort(cmp).join(', ')})`)
    }
  }

  // ---- ownership: who may take each record, and how much of it.
  const byRecord = new Map<string, Edge[]>()
  for (const e of edges) byRecord.set(e.p.rec.id, [...(byRecord.get(e.p.rec.id) ?? []), e])
  const owned = new Map<string, Array<{ e: Edge; share: number }>>()
  const own = (e: Edge, share: number) => owned.set(e.q.key, [...(owned.get(e.q.key) ?? []), { e, share }])

  for (const [id, list] of [...byRecord.entries()].sort((a, b) => cmp(a[0], b[0]))) {
    const amount = list[0].p.rec.amountMinor!
    const byRef = list.filter((e) => e.tier === 'reference')
    const contenders = byRef.length ? byRef : list
    if (contenders.length === 1) {
      own(contenders[0], amount)
      for (const loser of list.filter((e) => e !== contenders[0])) {
        loser.q.notes.push(`claimed_by_reference_elsewhere: record ${id} agrees by reference with request ${contenders[0].q.key}, not this one`)
      }
      continue
    }
    const demand = contenders.reduce((s, e) => s + e.q.req.requestedAmountMinor, 0)
    if (byRef.length && demand <= amount) {
      // Each reference-agreeing request can be satisfied in full from this one record.
      for (const e of contenders) {
        own(e, e.q.req.requestedAmountMinor)
        e.q.notes.push(`shared_record: record ${id} agrees by reference with ${contenders.length} requests and covers all of them in full; each is allocated at most its own amount`)
      }
      continue
    }
    // Real contention that reference cannot break: nobody gets it.
    const keys = contenders.map((e) => e.q.key)
    for (const e of contenders) {
      e.q.ambiguousRecords.add(id)
      for (const k of keys) if (k !== e.q.key) e.q.competing.add(k)
      e.q.notes.push(`contested_record: record ${id} fits ${contenders.length} requests and ${byRef.length ? 'is smaller than their combined amount' : 'no reference breaks the tie'}; not allocated`)
      noteRecord(id, 'contested', e.q.key)
    }
  }

  // ---- allocation, request by request in key order.
  const recordRemaining = new Map<string, number>()
  const appliedRemaining = new Map<string, number>()
  for (const p of prepared) {
    if (isMinor(p.rec.amountMinor)) recordRemaining.set(p.rec.id, p.rec.amountMinor)
    appliedRemaining.set(p.rec.id, p.appliedTotal)
  }

  const coverage: CoverageState = !dataAsOf ? 'unknown' : 'current'
  const allocations: ReturnAllocation[] = []
  const matches: RequestReturnMatch[] = []

  for (const q of reqs) {
    const { req } = q
    const rationale: string[] = []
    const reqCoverage: CoverageState = coverage === 'unknown' || !q.day ? 'unknown' : dataAsOf! < q.day ? 'stale' : 'current'
    const base = {
      requestKey: q.key,
      requestRef: q.ref,
      currency: q.invalid.length ? null : req.currency,
      algorithmVersion: RETURN_MATCH_VERSION,
      customerRecordedMinor: req.alreadyRecordedMinor > 0 && Number.isSafeInteger(req.alreadyRecordedMinor) ? req.alreadyRecordedMinor : null,
      coverage: reqCoverage,
    }
    if (q.duplicateInput) rationale.push('duplicate_request_input: the same request appeared more than once in the input; evaluated once')

    if (q.invalid.length) {
      matches.push({
        ...base, status: 'conflict', method: null, linkedSourceRecordIds: [], amountMinor: null, date: null, applied: null,
        rationale: [...rationale, ...q.invalid.map((m) => `invalid_request: ${m}`)], competingRequests: [], creditIssuedNotAppliedMinor: null,
      })
      continue
    }

    let status: ReturnMatchStatus
    const mine = (owned.get(q.key) ?? []).sort((a, b) =>
      (a.e.tier === b.e.tier ? 0 : a.e.tier === 'reference' ? -1 : 1) || cmp(a.e.p.day!, b.e.p.day!) || cmp(a.e.p.rec.id, b.e.p.rec.id))
    const byRef = mine.filter((o) => o.e.tier === 'reference')
    const usable = byRef.length ? byRef : mine
    if (byRef.length && byRef.length < mine.length) {
      for (const o of mine.filter((x) => x.e.tier !== 'reference')) {
        q.notes.push(`superseded_by_reference_match: record ${o.e.p.rec.id} equals the requested amount but other records agree by reference; not linked`)
        noteRecord(o.e.p.rec.id, 'superseded_by_reference_match', q.key)
      }
    }
    if (!byRef.length && usable.length > 1) {
      for (const o of usable) {
        q.ambiguousRecords.add(o.e.p.rec.id)
        noteRecord(o.e.p.rec.id, 'contested', q.key)
      }
      q.notes.push(`multiple_exact_amount_records: ${usable.length} records each equal the requested amount and none agrees by reference; none linked`)
    }

    const linked: ReturnAllocation[] = []
    if (q.conflicts.length) status = 'conflict'
    else if (q.ambiguousRecords.size) status = 'ambiguous'
    else {
      let outstanding = req.requestedAmountMinor
      for (const { e, share } of usable) {
        const id = e.p.rec.id
        const available = Math.min(share, recordRemaining.get(id) ?? 0)
        const take = Math.min(available, outstanding)
        if (take <= 0) continue
        const method = methodOf(e.p.rec)
        const returned = method === 'refund' ? take : Math.min(take, appliedRemaining.get(id) ?? 0)
        if (method === 'credit') appliedRemaining.set(id, (appliedRemaining.get(id) ?? 0) - returned)
        recordRemaining.set(id, (recordRemaining.get(id) ?? 0) - take)
        outstanding -= take
        linked.push({
          requestKey: q.key, requestRef: q.ref, sourceRecordId: id, currency: req.currency, allocatedMinor: take,
          returnedEvidenceMinor: returned, method, applied: method === 'refund' ? null : returned === take,
          basis: e.tier === 'reference' ? 'reference' : 'exact_amount',
        })
        if (e.tier === 'reference') rationale.push(`reference_agreement: record ${id} agrees on ${e.agreed.join(', ')}`)
        else rationale.push(`matched_without_reference: record ${id} equals the requested amount exactly; supplier, currency and date agree; no reference agreement`)
        if (available > take) {
          rationale.push(`excess_not_attributed: record ${id} has ${available - take} minor units beyond this request's outstanding amount; the excess is not attributed to this request`)
          noteRecord(id, 'excess_over_request', q.key)
        }
        if (method === 'credit' && returned < take) {
          rationale.push(`credit_issued_not_applied: ${take - returned} minor units of credit ${id} are issued but not applied to any bill; issued is not applied is not returned`)
        }
      }
      for (const { e } of usable) if (!linked.some((a) => a.sourceRecordId === e.p.rec.id) && outstanding === 0) {
        q.notes.push(`request_already_covered: record ${e.p.rec.id} was not needed; the request's amount is already evidenced`)
        noteRecord(e.p.rec.id, 'request_already_covered', q.key)
      }
      const returnedTotal = linked.reduce((s, a) => s + a.returnedEvidenceMinor, 0)
      status = returnedTotal > 0 ? 'proposed_source_match' : base.customerRecordedMinor !== null ? 'customer_recorded' : 'unmatched'
    }

    if (status === 'conflict' || status === 'ambiguous') {
      for (const { e } of mine) if (!q.ambiguousRecords.has(e.p.rec.id)) noteRecord(e.p.rec.id, `held_request_${status}`, q.key)
    }
    const returnedTotal = linked.reduce((s, a) => s + a.returnedEvidenceMinor, 0)
    const issuedNotApplied = linked.reduce((s, a) => s + (a.allocatedMinor - a.returnedEvidenceMinor), 0)
    const hasCredit = linked.some((a) => a.method === 'credit')
    let amountMinor: number | null = null
    let applied: boolean | null = null
    let method: ReturnMatch['method'] = null
    let date: string | null = null
    let linkedIds: string[]

    if (status === 'proposed_source_match') {
      const evidencing = linked.filter((a) => a.returnedEvidenceMinor > 0)
      amountMinor = returnedTotal
      applied = hasCredit ? true : null
      const methods = [...new Set(evidencing.map((a) => a.method))]
      method = methods.length === 1 ? methods[0] : null
      if (methods.length > 1) rationale.push('mixed_methods: refunds and applied credits both evidence this request')
      linkedIds = linked.map((a) => a.sourceRecordId)
      date = evidencing.map((a) => prepared.find((p) => p.rec.id === a.sourceRecordId)!.day!).sort(cmp).at(-1) ?? null
      if (returnedTotal < req.requestedAmountMinor) rationale.push(`partial_return: source records evidence ${returnedTotal} of ${req.requestedAmountMinor} requested minor units`)
      else rationale.push(`full_amount_evidenced: source records evidence the full ${req.requestedAmountMinor} requested minor units`)
      rationale.push('gate_required: a proposed source match is not a case outcome; the case gate decides')
    } else if (linked.length) {
      // Only credit issued, none applied: report it, but never as returned value.
      amountMinor = issuedNotApplied
      applied = false
      method = 'credit'
      linkedIds = linked.map((a) => a.sourceRecordId)
      date = linked.map((a) => prepared.find((p) => p.rec.id === a.sourceRecordId)!.day!).sort(cmp).at(-1) ?? null
      rationale.push('credit_only_not_returned: the linked records are supplier credit issued but not applied to any bill; this is not returned value')
    } else if (status === 'ambiguous') {
      linkedIds = [...q.ambiguousRecords]
    } else if (status === 'conflict') {
      linkedIds = [...q.conflictRecords]
    } else linkedIds = []

    rationale.push(...q.conflicts)
    rationale.push(...q.notes)

    if (base.customerRecordedMinor !== null) {
      rationale.push(status === 'proposed_source_match'
        ? `customer_recorded_separately: customer recorded ${base.customerRecordedMinor} minor units; kept separate from, and never added to, source-evidenced value`
        : `customer_recorded_only: customer recorded ${base.customerRecordedMinor} minor units; no independent source record evidences it as returned`)
    }
    if (SUPPLIER_STATEMENT_STATUSES.has(req.status)) {
      rationale.push(`supplier_statement_not_evidence: the supplier's update (${req.status}) is not a source record and is not counted`)
    }
    if (reqCoverage === 'stale') {
      rationale.push(`coverage_stale: source data is as of ${dataAsOf}, before the request on ${q.day}`)
    }
    if ((status === 'unmatched' || status === 'customer_recorded') && returnedTotal === 0 && reqCoverage !== 'current') {
      rationale.push(reqCoverage === 'stale'
        ? 'absence_unknown: no matching source record, but the data predates the request; this is not evidence that nothing was returned'
        : 'absence_unknown: source data freshness was not supplied; no match is not evidence that nothing was returned')
    } else if (status === 'unmatched' && !linked.length) {
      rationale.push('no_candidates: no return record from this supplier in this currency after the request fits')
    }

    allocations.push(...linked)
    matches.push({
      ...base, status, method, linkedSourceRecordIds: linkedIds.sort(cmp), amountMinor, date, applied,
      rationale, competingRequests: [...q.competing].sort(cmp),
      creditIssuedNotAppliedMinor: hasCredit ? issuedNotApplied : null,
    })
  }

  // ---- records whose value is not (fully) attributed to a request.
  const unallocatedRecords: UnallocatedReturnRecord[] = []
  for (const p of prepared) {
    const r = p.rec
    const id = r.id
    const reasonMap = recordReasons.get(id) ?? new Map<string, Set<string>>()
    const reasons: string[] = []
    const related = new Set<string>()
    let unallocated: number | null
    if (p.duplicateOf) {
      reasons.push(`${p.duplicateKind === 'identity' ? 'duplicate_of' : 'possible_duplicate_of'}:${p.duplicateOf}`)
      unallocated = 0
    } else if (p.issues.includes('reversed')) {
      unallocated = 0
    } else {
      unallocated = isMinor(r.amountMinor) ? recordRemaining.get(id) ?? 0 : null
    }
    for (const issue of p.issues) reasons.push(issue)
    for (const [reason, keys] of reasonMap) {
      if (!reasons.includes(reason)) reasons.push(reason)
      for (const k of keys) related.add(k)
    }
    if (unallocated !== 0 && !reasons.length) reasons.push('no_matching_request')
    if (unallocated === 0 && !reasons.length) continue
    unallocatedRecords.push({
      sourceRecordId: id, tenantId: r.tenantId, vendorKey: r.vendorKey, currency: r.currency,
      unallocatedMinor: unallocated, reasons: reasons.sort(cmp), relatedRequests: [...related].sort(cmp),
    })
  }

  allocations.sort((a, b) => cmp(a.requestKey, b.requestKey) || cmp(a.sourceRecordId, b.sourceRecordId))
  matches.sort((a, b) => cmp(a.requestKey, b.requestKey))
  return {
    contractVersion: FINANCIAL_CONTRACT_VERSION,
    algorithmVersion: RETURN_MATCH_VERSION,
    matches,
    allocations,
    unallocatedRecords,
  }
}
