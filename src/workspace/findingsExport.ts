import { formatDate } from '@/lib/format'
import { DECISION_LABEL } from '@/ledger/caseState'
import { recoveryStatusLabel } from '@/recovery/model'
import type { Finding } from '@/types'
import { exposureCurrencyOf, UNKNOWN_CURRENCY } from './money'
import { EVIDENCE_LABEL, figuresOf, type Opportunity } from './selectors'

export type FindingCategory = 'recoverable' | 'review' | 'security' | 'opportunity'
export const FINDING_CATEGORY_LABEL: Record<FindingCategory, string> = {
  recoverable: 'Recovery candidates',
  review: 'Flagged for review',
  security: 'Security alerts',
  opportunity: 'Future savings',
}

/** Tabs follow the finding's classification; `class` is a deprecated mirror of it. */
export function categoryOf(finding: Finding): FindingCategory {
  if (finding.classification === 'recovery_candidate') return 'recoverable'
  if (finding.classification === 'preventive_security') return 'security'
  if (finding.classification === 'future_savings') return 'opportunity'
  return 'review'
}

export const FINDINGS_EXPORT_HEADER = [
  'Vendor', 'Finding', 'Category', 'Rule', 'Invoices', 'Payment dates', 'Evidence', 'Decision', 'Recovery',
  'Currency', 'Flagged amount', 'Flagged for review', 'Payments to verify', 'Potential recovery', 'Approved outstanding', 'Returned',
]

const money = (value: number | null) => (value === null ? '' : value.toFixed(2))

/**
 * Findings as rows a controller can file. Every amount is in the row's own
 * currency, named in its own column, and each money column adds up (per
 * currency) to the same total the screens show.
 */
export function findingsExportRows(rows: Opportunity[], findings: Finding[]): string[][] {
  return [FINDINGS_EXPORT_HEADER, ...rows.map((o) => {
    const figures = figuresOf(o, findings)
    const currency = exposureCurrencyOf(o.finding)
    return [
      o.finding.vendor,
      o.typeLabel,
      FINDING_CATEGORY_LABEL[categoryOf(o.finding)],
      `${o.finding.ruleId ?? o.finding.type} v${o.finding.ruleVersion ?? 1}`,
      [...new Set(o.finding.relatedRecords.map((r) => r.invoiceNumber).filter(Boolean))].join('; '),
      o.finding.relatedRecords.map((r) => formatDate(r.paymentDate)).join('; '),
      (o.finding.evidenceState ?? EVIDENCE_LABEL[o.evidence]).replaceAll('_', ' '),
      o.state.decision ? DECISION_LABEL[o.state.decision] : 'Not reviewed',
      o.state.recoveryStage ? recoveryStatusLabel(o.state, o.finding.class !== 'recoverable') : '',
      currency === UNKNOWN_CURRENCY ? 'Mixed' : currency,
      money(o.finding.flaggedAmount ?? o.finding.dollarImpact),
      money(figures.flagged),
      money(figures.atRisk),
      money(figures.potential),
      money(figures.inRecovery),
      money(figures.returned || null),
    ]
  })]
}
