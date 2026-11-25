/**
 * Derived vendor profiles (CPO workstream P2), metric version `vendor-profile-v0.1`.
 *
 * A profile is a read-only view over one tenant's source records, recurring
 * series, cases and business memory for one `vendorKey`. `vendorKey` is the
 * deterministic key the import already assigns (src/lib/csv.ts:
 * `canonicalVendorId`, supplier ID or normalized name). It is not a reviewed
 * identity: canonical vendor identity belongs to the financial-foundation
 * workstream. This module never merges two vendorKeys. Fuzzy alias
 * suggestions from import (`vendorResolution.ts`) and customer alias
 * statements are shown beside the profile, labelled, and left unmerged.
 *
 * Everything is "in the covered records": imported snapshots, not a
 * continuous ledger.
 *
 * Server-safe: relative `.ts` imports of src/intelligence modules only.
 */
import {
  COVERAGE_REASONS,
  UNKNOWN_CURRENCY,
  type CaseReadPort,
  type CaseSnapshot,
  type CaseStageView,
  type CoverageItem,
  type CurrencyCode,
  type FinancialSourcePort,
  type ImportCoverage,
  type MoneyAmount,
  type Page,
  type ReadModelEnvelope,
  type RecurringSeriesView,
  type SourceRecord,
  type SourceRef,
  type TenantContext,
} from './contracts.ts'
import { CurrencyTotals, coverage, envelope, requirePermission, requireTenant } from './envelope.ts'
import { BASELINE_VERSION, baselineCoverage, computeBaseline, ratioBps, type VendorBaseline } from './baselines.ts'
import {
  aliasStates,
  influenceItems,
  normalizeAliasName,
  resolveMemoryWithProposals,
  type FeedbackStore,
  type InfluenceItem,
  type MemoryEntryView,
} from './memory.ts'

export const VENDOR_PROFILE_VERSION = 'vendor-profile-v0.1'
/** Length of each comparison window for "recent change". */
export const RECENT_WINDOW_DAYS = 90
export const DEFAULT_PAGE_LIMIT = 50
export const MAX_PAGE_LIMIT = 200

export const VENDOR_PROFILE_REASONS = {
  WINDOW_NOT_COVERED: 'window_not_covered',
  VENDOR_NOT_FOUND: 'vendor_not_found',
} as const

export const ALIAS_PROPOSED_LABEL = 'proposed — not confirmed'
export const ALIAS_CONFIRMED_LABEL = 'confirmed by customer — pending canonical identity review'
export const RECURRING_LABEL = 'recurring, not flagged'

const STAGES: CaseStageView[] = ['unreviewed', 'needs_info', 'dismissed', 'confirmed', 'requested', 'recovered', 'not_recovered']

// ---------------------------------------------------------------- types

export interface VendorSpend {
  currency: CurrencyCode
  /** Sum of kind 'payment' amounts in the covered records. Gross: refunds and credits are not netted off. */
  grossPaymentsMinor: number
  paymentCount: number
  /** Refund and credit rows as the source recorded them (signed, usually negative). Kept apart, never netted. */
  refundsAndCredits: { count: number; amountMinor: number }
  /** Rows whose kind could not be established. Not counted as spend. */
  unknownKindCount: number
}

export interface VendorRecentChange {
  currency: CurrencyCode
  status: 'computed' | 'insufficient_history'
  reasons: string[]
  recentWindow: { from: string; to: string } | null
  priorWindow: { from: string; to: string } | null
  recentGrossMinor: number | null
  priorGrossMinor: number | null
  recentPaymentCount: number | null
  priorPaymentCount: number | null
  /** (recent - prior) / prior in basis points; null when prior is 0 or not computed. */
  changeBps: number | null
}

export interface VendorRecurringSeries {
  seriesId: string
  auditId: string
  vendorName: string
  amount: MoneyAmount
  cadenceDays: number
  paymentCount: number
  firstPaymentDate: string
  lastPaymentDate: string
  label: typeof RECURRING_LABEL
  /** In-effect recurring confirmations from business memory. */
  confirmations: Array<{ entryId: string; assertion: 'recurring_expected' | 'not_recurring' }>
}

export interface VendorCaseSummary {
  /** Distinct checks (cross-audit duplicates counted once). */
  caseCount: number
  /** Case rows dropped because another audit holds the same check on the same payments. */
  crossAuditDuplicates: number
  byStage: Record<CaseStageView, number>
  /** Evidence-gate supported potential on cases still in play (not dismissed, recovered or not recovered). Per currency. */
  supportedPotentialInPlay: MoneyAmount[]
  /** Customer-recorded returns (not bank-matched). Per currency. */
  customerRecordedReturn: MoneyAmount[]
  /** Independent return matching does not exist yet. */
  matchedReturn: 'not_available'
  caseIds: string[]
}

export interface VendorEvidenceQuality {
  recordCount: number
  withInvoiceReference: number
  withCategory: number
  withKnownCurrency: number
  withPaymentDate: number
  /** Shares in basis points of recordCount; null with no records. */
  shareBps: { invoiceReference: number | null; category: number | null; knownCurrency: number | null; paymentDate: number | null }
  note: string
}

export interface VendorAliases {
  /** Names exactly as they appear in this vendor's records and cases. Never merged with another vendorKey. */
  displayNamesSeen: Array<{ name: string; recordCount: number; caseCount: number }>
  proposed: Array<{ aliasName: string; origins: Array<'import_similarity' | 'customer_memory'>; entryIds: string[]; recordCount: number; label: typeof ALIAS_PROPOSED_LABEL }>
  confirmedByCustomer: Array<{ aliasName: string; entryIds: string[]; pendingCanonicalIdentityConfirmation: true; label: typeof ALIAS_CONFIRMED_LABEL }>
  rejectedByCustomer: Array<{ aliasName: string; entryIds: string[] }>
  /** In-effect statements that disagree. Shown for a person to resolve; counted as neither confirmed nor rejected. */
  contradictions: Array<{ aliasName: string; entryIds: string[] }>
  identityNote: string
}

export interface VendorProfile {
  vendorKey: string
  /** Most frequent recorded name (ties: lexicographic). A display choice, not an identity decision. */
  primaryName: string
  aliases: VendorAliases
  stableSupplierIds: string[]
  coveredPeriod: { from: string | null; to: string | null }
  spend: VendorSpend[]
  baselines: VendorBaseline[]
  recurringSeries: VendorRecurringSeries[]
  recentChange: VendorRecentChange[]
  cases: VendorCaseSummary
  evidenceQuality: VendorEvidenceQuality
  memory: { inEffect: InfluenceItem[]; notInEffect: InfluenceItem[] }
}

// ---------------------------------------------------------------- helpers

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000)
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`
}

/** Merge import date ranges into covered intervals. Contiguous only when the next range starts no later than the day after the previous one ends. */
export function coveredIntervals(imports: readonly ImportCoverage[]): Array<{ from: string; to: string }> {
  const ranges = imports
    .filter((i) => i.dateRange.from !== null && i.dateRange.to !== null)
    .map((i) => ({ from: i.dateRange.from!, to: i.dateRange.to! }))
    .sort((a, b) => cmp(a.from, b.from) || cmp(a.to, b.to))
  const merged: Array<{ from: string; to: string }> = []
  for (const r of ranges) {
    const last = merged.at(-1)
    if (last && r.from <= addDays(last.to, 1)) {
      if (r.to > last.to) last.to = r.to
    } else merged.push({ ...r })
  }
  return merged
}

function windowCovered(intervals: ReadonlyArray<{ from: string; to: string }>, from: string, to: string): boolean {
  return intervals.some((i) => i.from <= from && i.to >= to)
}

function shareBps(count: number, total: number): number | null {
  return total === 0 ? null : ratioBps(count, total)
}

/** Exact integer sum of one currency's records (CurrencyTotals guards safe-integer overflow). */
function sum(records: readonly SourceRecord[]): number {
  const t = new CurrencyTotals()
  for (const r of records) t.add(r.currency, r.amountMinor)
  const currencies = t.currencies()
  if (currencies.length > 1) throw new Error('sum() called across currencies.')
  return currencies.length ? t.get(currencies[0]) : 0
}

/** One case per cross-audit key: the most recently updated copy (ties: lowest caseId). */
function dedupeCases(cases: readonly CaseSnapshot[]): { kept: CaseSnapshot[]; dropped: number } {
  const byKey = new Map<string, CaseSnapshot>()
  for (const c of [...cases].sort((a, b) => cmp(a.caseId, b.caseId))) {
    const existing = byKey.get(c.crossAuditKey)
    if (!existing || (c.updatedAt ?? -1) > (existing.updatedAt ?? -1)) byKey.set(c.crossAuditKey, c)
  }
  const kept = [...byKey.values()].sort((a, b) => cmp(a.caseId, b.caseId))
  return { kept, dropped: cases.length - kept.length }
}

// ---------------------------------------------------------------- context

interface ProfileContext {
  ctx: TenantContext
  financial: FinancialSourcePort
  records: SourceRecord[]
  recordsByVendor: Map<string, SourceRecord[]>
  casesByVendor: Map<string, CaseSnapshot[]>
  seriesByVendor: Map<string, RecurringSeriesView[]>
  imports: ImportCoverage[]
  intervals: Array<{ from: string; to: string }>
  anchor: string | null
  views: MemoryEntryView[]
  influence: Map<string, InfluenceItem>
  vendorKeys: string[]
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key)
  if (list) list.push(value)
  else map.set(key, [value])
}

function buildContext(ctx: TenantContext, financial: FinancialSourcePort, cases: CaseReadPort, memory: FeedbackStore, now: number): ProfileContext {
  requirePermission(ctx, 'financial:read')
  requirePermission(ctx, 'cases:read')
  const records = financial.listSourceRecords(ctx)
  const recordsByVendor = new Map<string, SourceRecord[]>()
  for (const r of records) {
    // A port that returned another tenant's row is an integrity failure, not something to filter quietly.
    requireTenant(ctx, r.tenantId)
    push(recordsByVendor, r.vendor.vendorKey, r)
  }
  const casesByVendor = new Map<string, CaseSnapshot[]>()
  for (const c of cases.listCases(ctx, now)) push(casesByVendor, c.vendor.vendorKey, c)
  const seriesByVendor = new Map<string, RecurringSeriesView[]>()
  for (const s of financial.listRecurringSeries(ctx)) push(seriesByVendor, s.vendorKey, s)
  const imports = financial.listImportCoverage(ctx)
  const intervals = coveredIntervals(imports)
  const anchor = intervals.reduce<string | null>((m, i) => (m === null || i.to > m ? i.to : m), null)
  const { views, proposals } = resolveMemoryWithProposals(ctx, memory, { financial, cases }, now)
  const influence = new Map(influenceItems(views, proposals).map((i) => [i.entryId, i]))
  const vendorKeys = [...new Set([...recordsByVendor.keys(), ...casesByVendor.keys(), ...seriesByVendor.keys()])].sort(cmp)
  return { ctx, financial, records, recordsByVendor, casesByVendor, seriesByVendor, imports, intervals, anchor, views, influence, vendorKeys }
}

function primaryName(pc: ProfileContext, vendorKey: string): string {
  const counts = new Map<string, number>()
  for (const r of pc.recordsByVendor.get(vendorKey) ?? []) counts.set(r.vendor.displayName, (counts.get(r.vendor.displayName) ?? 0) + 1)
  const ranked = [...counts].sort((a, b) => b[1] - a[1] || cmp(a[0], b[0]))
  if (ranked.length) return ranked[0][0]
  const caseNames = (pc.casesByVendor.get(vendorKey) ?? []).map((c) => c.vendor.displayName).sort(cmp)
  if (caseNames.length) return caseNames[0]
  const seriesNames = (pc.seriesByVendor.get(vendorKey) ?? []).map((s) => s.vendorName).sort(cmp)
  return seriesNames[0] ?? vendorKey
}

function viewsForVendor(pc: ProfileContext, vendorKey: string): MemoryEntryView[] {
  return pc.views.filter((v) => {
    const s = v.entry.scope
    if ((s.type === 'vendor' || s.type === 'recurring_series') && s.vendorKey === vendorKey) return true
    return v.vendorKeys.includes(vendorKey)
  })
}

// ---------------------------------------------------------------- profile pieces

function aliasesFor(vendorKey: string, records: readonly SourceRecord[], cases: readonly CaseSnapshot[], views: readonly MemoryEntryView[]): VendorAliases {
  const names = new Map<string, { recordCount: number; caseCount: number }>()
  for (const r of records) {
    const n = names.get(r.vendor.displayName) ?? { recordCount: 0, caseCount: 0 }
    n.recordCount += 1
    names.set(r.vendor.displayName, n)
  }
  for (const c of cases) {
    const n = names.get(c.vendor.displayName) ?? { recordCount: 0, caseCount: 0 }
    n.caseCount += 1
    names.set(c.vendor.displayName, n)
  }
  const displayNamesSeen = [...names].map(([name, n]) => ({ name, ...n })).sort((a, b) => b.recordCount - a.recordCount || b.caseCount - a.caseCount || cmp(a.name, b.name))

  const suggestions = new Map<string, { aliasName: string; recordCount: number }>()
  for (const r of records) {
    const s = r.vendor.aliasSuggestion?.trim()
    if (!s) continue
    const key = normalizeAliasName(s)
    const existing = suggestions.get(key) ?? { aliasName: s, recordCount: 0 }
    existing.recordCount += 1
    suggestions.set(key, existing)
  }

  const states = new Map(aliasStates(views).filter((s) => s.vendorKey === vendorKey).map((s) => [s.normalizedAlias, s]))
  const proposed: VendorAliases['proposed'] = []
  const confirmedByCustomer: VendorAliases['confirmedByCustomer'] = []
  const rejectedByCustomer: VendorAliases['rejectedByCustomer'] = []
  const contradictions: VendorAliases['contradictions'] = []
  const keys = [...new Set([...suggestions.keys(), ...states.keys()])].sort(cmp)
  for (const key of keys) {
    const state = states.get(key)
    const suggestion = suggestions.get(key)
    const aliasName = state?.aliasName ?? suggestion!.aliasName
    if (state?.contradictory) contradictions.push({ aliasName, entryIds: state.entryIds })
    else if (state?.decision === 'confirmed') confirmedByCustomer.push({ aliasName, entryIds: state.entryIds, pendingCanonicalIdentityConfirmation: true, label: ALIAS_CONFIRMED_LABEL })
    else if (state?.decision === 'rejected') rejectedByCustomer.push({ aliasName, entryIds: state.entryIds })
    else {
      const origins: Array<'import_similarity' | 'customer_memory'> = []
      if (suggestion) origins.push('import_similarity')
      if (state) origins.push('customer_memory')
      proposed.push({ aliasName, origins, entryIds: state?.entryIds ?? [], recordCount: suggestion?.recordCount ?? 0, label: ALIAS_PROPOSED_LABEL })
    }
  }
  return {
    displayNamesSeen,
    proposed,
    confirmedByCustomer,
    rejectedByCustomer,
    contradictions,
    identityNote: 'Names are shown as recorded and never merged here. Canonical vendor identity is decided by the financial-foundation service.',
  }
}

function spendFor(records: readonly SourceRecord[]): VendorSpend[] {
  const gross = new CurrencyTotals()
  const refunds = new CurrencyTotals()
  const counts = new Map<string, { payments: number; refunds: number; unknown: number }>()
  for (const r of records) {
    const c = counts.get(r.currency) ?? { payments: 0, refunds: 0, unknown: 0 }
    counts.set(r.currency, c)
    if (r.kind === 'payment') {
      gross.add(r.currency, r.amountMinor)
      c.payments += 1
    } else if (r.kind === 'refund' || r.kind === 'credit') {
      refunds.add(r.currency, r.amountMinor)
      c.refunds += 1
    } else c.unknown += 1
  }
  return [...counts.keys()].sort(cmp).map((currency) => ({
    currency,
    grossPaymentsMinor: gross.get(currency),
    paymentCount: counts.get(currency)!.payments,
    refundsAndCredits: { count: counts.get(currency)!.refunds, amountMinor: refunds.get(currency) },
    unknownKindCount: counts.get(currency)!.unknown,
  }))
}

function recentChangeFor(pc: ProfileContext, records: readonly SourceRecord[], currencies: readonly string[]): VendorRecentChange[] {
  const out: VendorRecentChange[] = []
  const snapshot: string[] = pc.financial.origin === 'legacy_audit_snapshot' ? [COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS] : []
  for (const currency of currencies) {
    const insufficient = (reasons: string[], recentWindow: VendorRecentChange['recentWindow'] = null, priorWindow: VendorRecentChange['priorWindow'] = null): VendorRecentChange => ({
      currency,
      status: 'insufficient_history',
      reasons: [...new Set([COVERAGE_REASONS.INSUFFICIENT_HISTORY, ...reasons, ...snapshot])].sort(),
      recentWindow,
      priorWindow,
      recentGrossMinor: null,
      priorGrossMinor: null,
      recentPaymentCount: null,
      priorPaymentCount: null,
      changeBps: null,
    })
    if (pc.anchor === null) {
      out.push(insufficient([COVERAGE_REASONS.NO_DATA]))
      continue
    }
    if (currency === UNKNOWN_CURRENCY) {
      out.push(insufficient([COVERAGE_REASONS.MISSING_CURRENCY]))
      continue
    }
    const recentWindow = { from: addDays(pc.anchor, -(RECENT_WINDOW_DAYS - 1)), to: pc.anchor }
    const priorWindow = { from: addDays(pc.anchor, -(2 * RECENT_WINDOW_DAYS - 1)), to: addDays(pc.anchor, -RECENT_WINDOW_DAYS) }
    if (!windowCovered(pc.intervals, priorWindow.from, recentWindow.to)) {
      out.push(insufficient([VENDOR_PROFILE_REASONS.WINDOW_NOT_COVERED], recentWindow, priorWindow))
      continue
    }
    const payments = records.filter((r) => r.kind === 'payment' && r.currency === currency && r.paymentDate !== null)
    const recent = payments.filter((r) => r.paymentDate! >= recentWindow.from && r.paymentDate! <= recentWindow.to)
    const prior = payments.filter((r) => r.paymentDate! >= priorWindow.from && r.paymentDate! <= priorWindow.to)
    const recentGrossMinor = sum(recent)
    const priorGrossMinor = sum(prior)
    out.push({
      currency,
      status: 'computed',
      reasons: [...snapshot],
      recentWindow,
      priorWindow,
      recentGrossMinor,
      priorGrossMinor,
      recentPaymentCount: recent.length,
      priorPaymentCount: prior.length,
      changeBps: priorGrossMinor === 0 ? null : ratioBps(recentGrossMinor - priorGrossMinor, priorGrossMinor),
    })
  }
  return out
}

function casesSummary(cases: readonly CaseSnapshot[]): VendorCaseSummary {
  const { kept, dropped } = dedupeCases(cases)
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<CaseStageView, number>
  const supported = new CurrencyTotals()
  const recorded = new CurrencyTotals()
  for (const c of kept) {
    byStage[c.stage] += 1
    if (c.supportedPotentialMinor !== null && !['dismissed', 'recovered', 'not_recovered'].includes(c.stage)) supported.add(c.currency, c.supportedPotentialMinor)
    if (c.customerRecordedReturnMinor > 0) recorded.add(c.currency, c.customerRecordedReturnMinor)
  }
  return {
    caseCount: kept.length,
    crossAuditDuplicates: dropped,
    byStage,
    supportedPotentialInPlay: supported.list(),
    customerRecordedReturn: recorded.list(),
    matchedReturn: 'not_available',
    caseIds: kept.map((c) => c.caseId),
  }
}

function evidenceQualityFor(records: readonly SourceRecord[]): VendorEvidenceQuality {
  const n = records.length
  const withInvoiceReference = records.filter((r) => Boolean(r.invoiceReference?.trim())).length
  const withCategory = records.filter((r) => r.category !== null).length
  const withKnownCurrency = records.filter((r) => r.currency !== UNKNOWN_CURRENCY).length
  const withPaymentDate = records.filter((r) => r.paymentDate !== null).length
  return {
    recordCount: n,
    withInvoiceReference,
    withCategory,
    withKnownCurrency,
    withPaymentDate,
    shareBps: { invoiceReference: shareBps(withInvoiceReference, n), category: shareBps(withCategory, n), knownCurrency: shareBps(withKnownCurrency, n), paymentDate: shareBps(withPaymentDate, n) },
    note: 'Completeness of the covered records (data quality). It says nothing about the supplier.',
  }
}

function buildProfile(pc: ProfileContext, vendorKey: string): VendorProfile {
  const records = [...(pc.recordsByVendor.get(vendorKey) ?? [])].sort((a, b) => cmp(a.recordId, b.recordId))
  const cases = pc.casesByVendor.get(vendorKey) ?? []
  const views = viewsForVendor(pc, vendorKey)
  const items = views.map((v) => pc.influence.get(v.entry.id)!).filter(Boolean)
  const paymentCurrencies = [...new Set(records.filter((r) => r.kind === 'payment' && r.amountMinor > 0).map((r) => r.currency))].sort(cmp)
  const dates = records.map((r) => r.paymentDate).filter((d): d is string => d !== null).sort(cmp)
  const confirmations = new Map<string, VendorRecurringSeries['confirmations']>()
  for (const v of views) {
    if (!v.inEffect || v.entry.details.kind !== 'recurring_confirmation' || v.entry.scope.type !== 'recurring_series') continue
    push(confirmations, v.entry.scope.recurringSeriesId, { entryId: v.entry.id, assertion: v.entry.details.assertion })
  }
  const series = [...(pc.seriesByVendor.get(vendorKey) ?? [])]
    .sort((a, b) => cmp(a.seriesId, b.seriesId))
    .map((s): VendorRecurringSeries => ({
      seriesId: s.seriesId,
      auditId: s.auditId,
      vendorName: s.vendorName,
      amount: s.amount,
      cadenceDays: s.cadenceDays,
      paymentCount: s.paymentCount,
      firstPaymentDate: s.firstPaymentDate,
      lastPaymentDate: s.lastPaymentDate,
      label: RECURRING_LABEL,
      confirmations: confirmations.get(s.seriesId) ?? [],
    }))
  return {
    vendorKey,
    primaryName: primaryName(pc, vendorKey),
    aliases: aliasesFor(vendorKey, records, cases, views),
    stableSupplierIds: [...new Set(records.map((r) => r.vendor.stableSupplierId).filter((s): s is string => Boolean(s)))].sort(cmp),
    coveredPeriod: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
    spend: spendFor(records),
    baselines: paymentCurrencies.map((c) => computeBaseline(vendorKey, c, records)),
    recurringSeries: series,
    recentChange: recentChangeFor(pc, records, paymentCurrencies),
    cases: casesSummary(cases),
    evidenceQuality: evidenceQualityFor(records),
    memory: { inEffect: items.filter((i) => i.inEffect), notInEffect: items.filter((i) => !i.inEffect) },
  }
}

// ---------------------------------------------------------------- envelope

function profileCoverage(pc: ProfileContext, profiles: readonly VendorProfile[], vendorFound: boolean): CoverageItem[] {
  const snapshot: string[] = pc.financial.origin === 'legacy_audit_snapshot' ? [COVERAGE_REASONS.CUSTOMER_SUPPLIED_SOURCE, COVERAGE_REASONS.SNAPSHOT_NOT_CONTINUOUS] : []
  const recordsInScope = profiles.flatMap((p) => pc.recordsByVendor.get(p.vendorKey) ?? [])
  const reasons = [...snapshot]
  if (!vendorFound) reasons.push(VENDOR_PROFILE_REASONS.VENDOR_NOT_FOUND)
  if (pc.vendorKeys.length === 0) reasons.push(COVERAGE_REASONS.NO_DATA)
  if (recordsInScope.some((r) => r.currency === UNKNOWN_CURRENCY)) reasons.push(COVERAGE_REASONS.MISSING_CURRENCY)
  if (recordsInScope.some((r) => r.paymentDate === null)) reasons.push(COVERAGE_REASONS.MISSING_DATES)
  if (recordsInScope.some((r) => r.category === null)) reasons.push(COVERAGE_REASONS.MISSING_CATEGORY)
  if (pc.financial.overlapCount(pc.ctx) > 0) reasons.push(COVERAGE_REASONS.CROSS_AUDIT_OVERLAP)
  const recentReasons = [...new Set(profiles.flatMap((p) => p.recentChange.flatMap((r) => r.reasons)))]
  return [
    coverage('vendor_profiles', reasons, !vendorFound || pc.vendorKeys.length === 0),
    coverage('canonical_vendor_identity', [COVERAGE_REASONS.UPSTREAM_CONTRACT_PENDING]),
    ...baselineCoverage(profiles.flatMap((p) => p.baselines), pc.financial.origin),
    coverage('recent_change', [...recentReasons, ...snapshot], profiles.length === 0),
    coverage('matched_returns', [COVERAGE_REASONS.NO_INDEPENDENT_RETURN_MATCHING], true),
  ]
}

function profileEnvelope<T>(pc: ProfileContext, now: number, profiles: readonly VendorProfile[], vendorFound: boolean, result: T | null): ReadModelEnvelope<T> {
  const sources: SourceRef[] = [
    { id: `rule:${VENDOR_PROFILE_VERSION}`, label: 'Vendor profile definition' },
    { id: `rule:${BASELINE_VERSION}`, label: 'Vendor baseline method' },
  ]
  for (const i of [...pc.imports].sort((a, b) => cmp(a.auditId, b.auditId) || cmp(a.importId, b.importId))) sources.push({ id: `import:${i.auditId}/${i.importId}`, label: 'Import' })
  const memoryIds = [...new Set(profiles.flatMap((p) => p.memory.inEffect.map((m) => m.entryId)))].sort(cmp)
  for (const id of memoryIds) sources.push({ id: `memory:${id}`, label: 'Business memory entry' })
  const dates = profiles.flatMap((p) => [p.coveredPeriod.from, p.coveredPeriod.to]).filter((d): d is string => d !== null).sort(cmp)
  const currencies = [...new Set(profiles.flatMap((p) => p.spend.map((s) => s.currency)))].sort(cmp)
  const newest = pc.imports.reduce<number | null>((m, i) => (i.importedAt > 0 && (m === null || i.importedAt > m) ? i.importedAt : m), null)
  const crossAudit = profiles.reduce((n, p) => n + p.cases.crossAuditDuplicates, 0)
  return envelope({
    model: 'vendor_profiles',
    metricDefinitionVersion: VENDOR_PROFILE_VERSION,
    ctx: pc.ctx,
    origin: pc.financial.origin,
    scope: { from: dates[0] ?? null, to: dates.at(-1) ?? null, dateBasis: 'payment_date', currencies },
    computedAt: now,
    sourceUpdatedAt: newest,
    coverage: profileCoverage(pc, profiles, vendorFound),
    sources,
    exclusions: [{ code: 'cross_audit_duplicate_case', count: crossAudit, amounts: [], detail: 'The same check on the same payments in another audit, counted once.' }],
    result,
  })
}

// ---------------------------------------------------------------- public read models

interface SortKey {
  name: string
  vendorKey: string
}

function encodeCursor(k: SortKey): string {
  return `${encodeURIComponent(k.name)}|${encodeURIComponent(k.vendorKey)}`
}

function decodeCursor(cursor: string): SortKey {
  const parts = cursor.split('|')
  if (parts.length !== 2) throw new RangeError('Invalid cursor.')
  try {
    return { name: decodeURIComponent(parts[0]), vendorKey: decodeURIComponent(parts[1]) }
  } catch {
    throw new RangeError('Invalid cursor.')
  }
}

/**
 * Profiles for every vendor in the tenant's covered records, cases and
 * recurring series. Ordered by primary name (case-insensitive, code-point
 * order), then vendorKey; the cursor is the last item's sort key, so a page
 * boundary is stable. Display ordering is a design decision and may change.
 */
export function vendorProfiles(
  ctx: TenantContext,
  financial: FinancialSourcePort,
  cases: CaseReadPort,
  memory: FeedbackStore,
  now: number,
  options: { limit?: number; cursor?: string | null } = {},
): ReadModelEnvelope<Page<VendorProfile>> {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) throw new RangeError(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`)
  const after = options.cursor ? decodeCursor(options.cursor) : null
  const pc = buildContext(ctx, financial, cases, memory, now)
  const keyed = pc.vendorKeys
    .map((vendorKey) => ({ name: primaryName(pc, vendorKey).toLowerCase(), vendorKey }))
    .sort((a, b) => cmp(a.name, b.name) || cmp(a.vendorKey, b.vendorKey))
  const remaining = after ? keyed.filter((k) => cmp(k.name, after.name) > 0 || (k.name === after.name && cmp(k.vendorKey, after.vendorKey) > 0)) : keyed
  const page = remaining.slice(0, limit)
  const profiles = page.map((k) => buildProfile(pc, k.vendorKey))
  const nextCursor = remaining.length > limit ? encodeCursor(page.at(-1)!) : null
  return profileEnvelope(pc, now, profiles, true, { items: profiles, nextCursor })
}

/** One vendor's profile. Unknown vendorKey (or another tenant's) → result null with `vendor_not_found`. */
export function vendorProfile(
  ctx: TenantContext,
  financial: FinancialSourcePort,
  cases: CaseReadPort,
  memory: FeedbackStore,
  vendorKey: string,
  now: number,
): ReadModelEnvelope<VendorProfile> {
  const pc = buildContext(ctx, financial, cases, memory, now)
  if (!pc.vendorKeys.includes(vendorKey)) return profileEnvelope<VendorProfile>(pc, now, [], false, null)
  const profile = buildProfile(pc, vendorKey)
  return profileEnvelope(pc, now, [profile], true, profile)
}
