/**
 * Import coverage: for one import, which detection checks the data can
 * actually support, which it supports only partly, and which it cannot run.
 *
 * The rule: a missing column is unknown, never zero and never a clean result.
 * A check that could not run produces no findings, and "no findings" from a
 * check that did not run says nothing about the ledger. `summarizeCoverage`
 * therefore never lets a caller say the import is clear while any check is
 * limited or not run.
 *
 * Field requirements per rule are derived from src/lib/detection.ts (see
 * RULE_REQUIREMENTS). Nothing here reads or returns row values; rejected rows
 * are reported by row number and reason code only.
 */
import type { APRecord, ImportRowResult, ParseResult } from '../types.ts'
import {
  DETECTION_RULES,
  FINANCIAL_CONTRACT_VERSION,
  type CheckCoverage,
  type CheckStatus,
  type CoverageReason,
  type CoverageReasonCode,
  type DetectionRule,
  type ImportCoverage,
  type RejectReasonCode,
  type ReportType,
  type SourceSystem,
} from '../contracts/financial.ts'
import { normalizeAccountLast4, parseCurrency, parseDate, parseTerms } from '../lib/format.ts'
import { referenceStrength } from '../lib/sourceIdentity.ts'
import { inferReportType } from './columnMapping.ts'

/** A required field present on fewer than this share of rows only partly supports its checks. */
export const FIELD_SPARSE_THRESHOLD = 0.5
/** Same as detection.ts OUTLIER_MIN_PAYMENTS: the least per-vendor history the median can stand on. */
export const OUTLIER_MIN_PAYMENTS_PER_VENDOR = 5
/** Payment dates spanning less than this many days give an outlier baseline no history to compare against. */
export const SINGLE_PERIOD_MAX_DAYS = 31
/** The recovery evidence gate is USD-only. */
export const DEFAULT_SUPPORTED_CURRENCIES: readonly string[] = ['USD']

export interface RuleRequirement {
  /** Fields the rule cannot run without; a missing one means `not_run`. */
  required: readonly string[]
  /** Fields that sharpen the rule but whose absence does not stop it (documentation only). */
  optional: readonly string[]
  /** Whether the rule compares amounts, so mixed or unsupported currencies limit it. */
  comparesAmounts: boolean
}

/**
 * Derived from detection.ts:
 * - exact_duplicate groups payments by vendor + invoice reference (rows without
 *   a reference never enter it), then compares amounts and dates; invoice_amount
 *   separates instalments from duplicates, transaction_type nets booked refunds.
 * - near_duplicate pairs same-vendor, same-amount payments within a date window;
 *   invoice references enable the stronger reference-variant signal and the
 *   longer window; currency/company keep incompatible rows apart.
 * - overpayment compares amount_paid with invoice_amount per row.
 * - unclaimed/missed discount need parseable discount terms, invoice date,
 *   payment date, invoice amount and amount paid.
 * - bank_account_change needs a vendor paid at least twice with account digits.
 * - amount_outlier needs at least five payments to one vendor.
 * - shared_invoice_number needs strong references across two or more vendors.
 */
export const RULE_REQUIREMENTS: Readonly<Record<DetectionRule, RuleRequirement>> = {
  exact_duplicate: { required: ['vendor', 'payment_date', 'amount_paid', 'invoice_number'], optional: ['invoice_amount', 'transaction_type', 'supplier_id'], comparesAmounts: true },
  near_duplicate: { required: ['vendor', 'payment_date', 'amount_paid'], optional: ['invoice_number', 'currency', 'company', 'supplier_id'], comparesAmounts: true },
  overpayment: { required: ['vendor', 'amount_paid', 'invoice_amount'], optional: ['invoice_number', 'transaction_type'], comparesAmounts: true },
  unclaimed_discount: { required: ['amount_paid', 'payment_date', 'invoice_date', 'invoice_amount', 'terms'], optional: ['invoice_number'], comparesAmounts: true },
  missed_discount: { required: ['amount_paid', 'payment_date', 'invoice_date', 'invoice_amount', 'terms'], optional: ['invoice_number'], comparesAmounts: true },
  bank_account_change: { required: ['vendor', 'payment_date', 'amount_paid', 'bank_account_last4'], optional: ['supplier_id'], comparesAmounts: false },
  amount_outlier: { required: ['vendor', 'amount_paid'], optional: ['supplier_id', 'payment_date'], comparesAmounts: true },
  shared_invoice_number: { required: ['vendor', 'invoice_number', 'amount_paid'], optional: ['supplier_id'], comparesAmounts: true },
}

/** Rules that look for money paid more than once; they need rows that are payments, not bills. */
const PAYMENT_DUPLICATE_RULES: ReadonlySet<DetectionRule> = new Set(['exact_duplicate', 'near_duplicate'])
/** Rules that need a payment (amount and date actually paid) to say anything. */
const PAYMENT_RULES: ReadonlySet<DetectionRule> = new Set(['exact_duplicate', 'near_duplicate', 'overpayment', 'unclaimed_discount', 'missed_discount'])

/** Whether a record carries a usable value for a canonical field (as the detection rules would use it). */
const FIELD_PRESENT: Readonly<Record<string, (r: APRecord) => boolean>> = {
  vendor: (r) => r.vendor.trim() !== '',
  payment_date: (r) => r.paymentDate instanceof Date && !Number.isNaN(r.paymentDate.getTime()),
  amount_paid: (r) => Number.isFinite(r.amountPaid),
  invoice_number: (r) => referenceStrength(r.invoiceNumber) !== 'none',
  invoice_amount: (r) => r.invoiceAmount !== null,
  invoice_date: (r) => r.invoiceDate !== null,
  terms: (r) => r.terms !== null && r.terms.trim() !== '',
  bank_account_last4: (r) => normalizeAccountLast4(r.bankAccountLast4) !== null,
  currency: (r) => Boolean(r.currency),
  supplier_id: (r) => Boolean(r.stableSupplierId),
  transaction_type: (r) => Boolean(r.transactionType),
  company: (r) => Boolean(r.company),
}

export interface ComputeImportCoverageInput {
  importId: string
  sourceSystem: SourceSystem
  /** What kind of report the file is. When omitted, inferred from the detected columns. */
  reportType?: ReportType | null
  parse: Pick<ParseResult, 'records' | 'detectedColumns' | 'skippedCount'> & { rowResults?: ImportRowResult[] }
  mapping: ImportCoverage['mapping']
  dedup: ImportCoverage['dedup']
  freshAsOf?: string | null
  /** Currencies the recovery gate accepts. Defaults to USD only. */
  supportedCurrencies?: readonly string[]
}

type Level = 'limited' | 'not_run'
interface LeveledReason extends CoverageReason { level: Level }

function blank(v: string | undefined | null): boolean {
  if (v === undefined || v === null) return true
  const t = v.trim().toLowerCase()
  return t === '' || t === 'na' || t === 'n/a'
}

/** Why `parseCsv` rejected a row, as a code. Reads the row's cells only to classify; never returns them. */
export function rejectReasonFor(raw: Record<string, string> | null | undefined): RejectReasonCode {
  if (!raw) return 'other'
  if (Object.values(raw).every((v) => typeof v !== 'string' || v.trim() === '')) return 'blank_row'
  if (blank(raw.vendor)) return 'missing_vendor'
  if (blank(raw.payment_date)) return 'missing_payment_date'
  if (parseDate(raw.payment_date) === null) return 'invalid_payment_date'
  if (blank(raw.amount_paid)) return 'missing_amount'
  if (parseCurrency(raw.amount_paid) === null) return 'invalid_amount'
  return 'other'
}

const localIsoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

interface FieldStat { columnPresent: boolean; populated: number; share: number }

function vendorKey(r: APRecord): string {
  return r.stableSupplierId ? `s:${r.stableSupplierId.trim().toLowerCase()}` : r.canonicalVendorId ?? r.vendor.trim().toLowerCase()
}

export function computeImportCoverage(input: ComputeImportCoverageInput): ImportCoverage {
  const { records, detectedColumns, skippedCount } = input.parse
  const supported = new Set((input.supportedCurrencies ?? DEFAULT_SUPPORTED_CURRENCIES).map((c) => c.toUpperCase()))
  const rejectedResults = (input.parse.rowResults ?? []).filter((r) => r.status === 'rejected')
  const rejectedCount = input.parse.rowResults ? rejectedResults.length : skippedCount
  const reportType: ReportType = input.reportType ?? inferReportType(detectedColumns, detectedColumns)

  // Detection only assesses positive payments; credits and zero lines never drive a rule.
  const payments = records.filter((r) => Number.isFinite(r.amountPaid) && r.amountPaid > 0)
  const basis = payments.length > 0 ? payments : records
  const detected = new Set(detectedColumns)
  const stat = (field: string): FieldStat => {
    const present = FIELD_PRESENT[field]
    const populated = present ? basis.filter(present).length : 0
    return { columnPresent: detected.has(field) || populated > 0, populated, share: basis.length === 0 ? 0 : populated / basis.length }
  }

  const currencies = Array.from(new Set(records.map((r) => r.currency?.toUpperCase()).filter((c): c is string => Boolean(c)))).sort()
  const withoutCurrency = records.filter((r) => !r.currency).length
  const currencyColumn = detected.has('currency') || currencies.length > 0
  const mixedCurrencies = currencies.length > 1 || (currencyColumn && currencies.length > 0 && withoutCurrency > 0)
  const unsupportedCurrencies = currencies.filter((c) => !supported.has(c))

  const paymentDates = records.map((r) => r.paymentDate).filter((d) => d instanceof Date && !Number.isNaN(d.getTime())).sort((a, b) => a.getTime() - b.getTime())
  const dateRange = paymentDates.length > 0 ? { from: localIsoDate(paymentDates[0]), to: localIsoDate(paymentDates[paymentDates.length - 1]) } : null
  const spanDays = paymentDates.length > 1 ? Math.round((paymentDates[paymentDates.length - 1].getTime() - paymentDates[0].getTime()) / 86_400_000) : 0

  const byVendor = new Map<string, APRecord[]>()
  for (const r of payments) byVendor.set(vendorKey(r), [...(byVendor.get(vendorKey(r)) ?? []), r])

  const checks: CheckCoverage[] = DETECTION_RULES.map((rule) => {
    const req = RULE_REQUIREMENTS[rule]
    const reasons: LeveledReason[] = []
    const missingFields: string[] = []
    const add = (level: Level, code: CoverageReasonCode, message: string, fields?: string[]) => reasons.push({ level, code, message, ...(fields ? { fields } : {}) })

    // Mapping first: if the columns' meaning is unconfirmed, nothing below is trustworthy.
    if (input.mapping.status === 'conflict') add('not_run', 'mapping_unconfirmed', 'The column mapping has unresolved conflicts, so this check was not run.', input.mapping.pendingFields)
    else if (input.mapping.status === 'pending_confirmation') add('limited', 'mapping_unconfirmed', 'The column mapping has not been confirmed; results depend on unconfirmed columns.', input.mapping.pendingFields)

    if (records.length === 0) add('not_run', 'too_few_records', 'No rows were accepted, so this check had nothing to examine.')

    for (const field of req.required) {
      const s = stat(field)
      if (!s.columnPresent || s.populated === 0) {
        missingFields.push(field)
        if (records.length === 0) continue
        add('not_run', 'missing_required_field', s.columnPresent ? `The ${field} column is present but empty, so this check could not run. An empty column is not evidence of no issues.` : `The file has no ${field} column, so this check could not run. A missing column is not evidence of no issues.`, [field])
        if (field === 'terms') add('not_run', 'no_terms', 'No payment terms were provided, so discount terms cannot be assessed.', [field])
        if (field === 'bank_account_last4') add('not_run', 'no_bank_details', 'No bank account details were provided, so account changes cannot be seen.', [field])
      } else if (s.share < FIELD_SPARSE_THRESHOLD) {
        add('limited', 'field_sparse', `${field} is filled on ${Math.round(s.share * 100)}% of payment rows; rows without it were not assessed by this check.`, [field])
      }
    }

    // Report type: a bill list records what was owed, not what was paid or whether it settled.
    if (reportType === 'bills' && PAYMENT_RULES.has(rule)) {
      add('not_run', 'report_type_cannot_establish', 'A bill export does not record payments, so it cannot establish this.')
      if (PAYMENT_DUPLICATE_RULES.has(rule)) add('not_run', 'no_settlement_status', 'Without payment dates and settlement status, a repeated bill is not evidence of a duplicate settled payment.')
    } else if (reportType === 'bills') {
      add('limited', 'report_type_cannot_establish', 'A bill export shows bills, not payments; this check only partly applies.')
    } else if (reportType === 'unknown' && PAYMENT_DUPLICATE_RULES.has(rule)) {
      add('limited', 'no_settlement_status', 'The report type is unknown, so rows cannot be confirmed as settled payments.')
    }

    // Record-count requirements, as the rules themselves apply them.
    if (records.length > 0) {
      if ((rule === 'exact_duplicate' || rule === 'near_duplicate') && payments.length < 2) add('not_run', 'too_few_records', 'Fewer than two payments were accepted, so there is nothing to compare.')
      if (rule === 'bank_account_change' && !missingFields.includes('bank_account_last4')) {
        const eligible = [...byVendor.values()].some((rows) => rows.filter(FIELD_PRESENT.bank_account_last4).length >= 2)
        if (!eligible) add('not_run', 'too_few_records', 'No vendor was paid at least twice with bank account details, so a change cannot be seen.')
      }
      if (rule === 'amount_outlier') {
        const covered = [...byVendor.values()].filter((rows) => rows.length >= OUTLIER_MIN_PAYMENTS_PER_VENDOR)
        const coveredPayments = covered.reduce((n, rows) => n + rows.length, 0)
        if (covered.length === 0) add('not_run', 'too_few_records', `No vendor has ${OUTLIER_MIN_PAYMENTS_PER_VENDOR} or more payments, the least history a typical amount can be judged from.`)
        else if (coveredPayments / Math.max(1, payments.length) < FIELD_SPARSE_THRESHOLD) add('limited', 'too_few_records', `Only ${covered.length} vendor(s) have enough payment history; most payments were not assessed.`)
        if (covered.length > 0 && spanDays < SINGLE_PERIOD_MAX_DAYS) add('limited', 'single_period', 'All payments fall within a single month, so there is little history to compare against.')
      }
      if (rule === 'shared_invoice_number' && !missingFields.includes('invoice_number')) {
        const vendorsWithRefs = new Set(payments.filter((r) => referenceStrength(r.invoiceNumber) === 'strong').map(vendorKey))
        if (vendorsWithRefs.size < 2) add('not_run', 'too_few_records', 'Fewer than two vendors have distinctive invoice numbers, so none can be shared.')
      }
      if ((rule === 'unclaimed_discount' || rule === 'missed_discount') && !missingFields.includes('terms') && !payments.some((r) => parseTerms(r.terms) !== null)) {
        add('limited', 'no_terms', 'Payment terms are present but none offer an early-payment discount in a recognised form.', ['terms'])
      }
    }

    if (req.comparesAmounts) {
      if (mixedCurrencies) add('limited', 'mixed_currencies', currencies.length > 1 ? `Rows are in ${currencies.length} currencies; amounts in different currencies are never compared or summed.` : 'Some rows state a currency and others do not; rows of unknown currency were not compared with the rest.', ['currency'])
      if (unsupportedCurrencies.length > 0) add('limited', 'unsupported_currency', `Rows in ${unsupportedCurrencies.join(', ')} can be reviewed but not taken to recovery, which supports ${[...supported].join(', ')} only.`, ['currency'])
    }

    const status: CheckStatus = reasons.some((r) => r.level === 'not_run') ? 'not_run' : reasons.length > 0 ? 'limited' : 'supported'
    const dedupedReasons: CoverageReason[] = []
    const seen = new Set<string>()
    for (const { level: _level, ...reason } of reasons) {
      const k = `${reason.code}|${(reason.fields ?? []).join(',')}`
      if (seen.has(k)) continue
      seen.add(k)
      dedupedReasons.push(reason)
    }
    return { rule, status, requiredFields: [...req.required], missingFields, reasons: dedupedReasons }
  })

  return {
    contractVersion: FINANCIAL_CONTRACT_VERSION,
    importId: input.importId,
    sourceSystem: input.sourceSystem,
    reportType,
    rows: { total: records.length + rejectedCount, accepted: records.length, rejected: rejectedCount },
    rejected: rejectedResults.map((r) => ({ row: r.rowNumber, reason: rejectReasonFor(r.raw) })),
    mapping: { ...input.mapping, pendingFields: [...input.mapping.pendingFields] },
    dedup: { ...input.dedup },
    checks,
    dateRange,
    currencies,
    sourceAccounts: Array.from(new Set(records.map((r) => r.sourceAccount?.trim()).filter((a): a is string => Boolean(a)))).sort(),
    freshAsOf: input.freshAsOf ?? null,
  }
}

export interface CoverageSummary {
  checksTotal: number
  checksRun: number
  checksLimited: number
  checksNotRun: number
  limitedRules: DetectionRule[]
  notRunRules: DetectionRule[]
  /**
   * True only when every check ran fully on a confirmed mapping with accepted
   * rows, so an empty findings list may be presented as "no findings". Even
   * then it means "these checks found nothing", never that the ledger is clean.
   */
  canSayNoFindings: boolean
  /** Plain-language status line. Never claims the data is clean or issue-free. */
  statement: string
}

export function summarizeCoverage(coverage: ImportCoverage): CoverageSummary {
  const limitedRules = coverage.checks.filter((c) => c.status === 'limited').map((c) => c.rule)
  const notRunRules = coverage.checks.filter((c) => c.status === 'not_run').map((c) => c.rule)
  const checksTotal = coverage.checks.length
  const checksRun = coverage.checks.filter((c) => c.status === 'supported').length
  const mappingSettled = coverage.mapping.status === 'known_format' || coverage.mapping.status === 'confirmed'
  const canSayNoFindings = checksTotal > 0 && checksRun === checksTotal && mappingSettled && coverage.rows.accepted > 0

  let statement: string
  if (coverage.rows.accepted === 0) statement = 'No rows were accepted, so no checks could run.'
  else if (canSayNoFindings) statement = `All ${checksTotal} checks ran on ${coverage.rows.accepted} accepted rows.`
  else {
    const parts = [`${checksRun} of ${checksTotal} checks ran fully`]
    if (limitedRules.length > 0) parts.push(`${limitedRules.length} ran with limits`)
    if (notRunRules.length > 0) parts.push(`${notRunRules.length} could not run`)
    statement = `${parts.join('; ')}. Results cover only the checks that ran; a check that did not run is not a pass.`
  }
  if (coverage.rows.rejected > 0) statement += ` ${coverage.rows.rejected} row(s) were rejected and not checked.`
  return { checksTotal, checksRun, checksLimited: limitedRules.length, checksNotRun: notRunRules.length, limitedRules, notRunRules, canSayNoFindings, statement }
}
