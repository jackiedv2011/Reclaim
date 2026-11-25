import type { Finding } from '@/types'
import { normalizeVendor } from '@/lib/format'
import { referenceKey, referenceStrength } from '@/lib/sourceIdentity'

export interface RuleCheck {
  label: string
  /** true renders a ✓ (matching signal), false renders a ○ (a real, visible difference). */
  matched: boolean
}

const EPSILON = 0.01

/** What the two payments' references really show. A placeholder such as "Autopay" is no reference. */
function referenceCheck(a: string | null, b: string | null): RuleCheck {
  const [hasA, hasB] = [referenceStrength(a) !== 'none', referenceStrength(b) !== 'none']
  if (!hasA && !hasB) return { label: 'No invoice reference on either payment', matched: false }
  if (!hasA || !hasB) return { label: 'Invoice reference on only one payment', matched: false }
  if (referenceKey(a) !== referenceKey(b)) return { label: 'Different invoice reference', matched: false }
  // One label repeated as it stands (an account number) says nothing; one invoice number written two ways does.
  const asWritten = (raw: string | null) => raw!.trim().toLowerCase().replace(/\s+/g, ' ')
  return asWritten(a) === asWritten(b)
    ? { label: 'Same reference on both payments', matched: true }
    : { label: 'Same invoice reference, written differently', matched: true }
}

/**
 * Plain-language breakdown of why a finding was flagged, built from the
 * actual related records rather than a confidence score. Every entry
 * reflects a condition the detection rule genuinely required (✓) or a
 * genuine difference that remains visible in the evidence (○).
 */
export function buildRuleChecklist(finding: Finding): RuleCheck[] {
  const [a, b] = finding.relatedRecords

  switch (finding.type) {
    case 'exact_duplicate': {
      const sameAmount = finding.relatedRecords.every((r) => Math.abs(a.amountPaid - r.amountPaid) < EPSILON)
      const sameDate = b ? a.paymentDate.getTime() === b.paymentDate.getTime() : true
      return [
        { label: 'Same vendor', matched: true },
        { label: 'Same invoice reference', matched: true },
        { label: sameAmount ? 'Same amount' : 'Different amount', matched: sameAmount },
        { label: sameDate ? 'Same payment date' : 'Different payment date', matched: sameDate },
      ]
    }

    case 'near_duplicate': {
      const sameDate = b ? a.paymentDate.getTime() === b.paymentDate.getTime() : true
      const vendorCheck =
        finding.ruleId !== 'cross_vendor_duplicate_v1'
          ? { label: 'Same vendor', matched: true }
          : b && normalizeVendor(a.vendor) === normalizeVendor(b.vendor)
            ? { label: 'Same vendor name on two vendor records', matched: false }
            : { label: 'Near-identical vendor names, not the same one', matched: false }
      return [
        vendorCheck,
        referenceCheck(a.invoiceNumber, b?.invoiceNumber ?? null),
        { label: 'Same amount', matched: true },
        { label: sameDate ? 'Same payment date' : 'Different payment date', matched: sameDate },
      ]
    }

    case 'overpayment': {
      return [
        { label: 'Matches an invoice on file', matched: true },
        { label: 'Amount paid exceeds the invoice amount', matched: false },
      ]
    }

    case 'unclaimed_discount': {
      return [
        { label: 'Paid within the early-payment discount window', matched: true },
        { label: 'Full price paid — discount not applied', matched: false },
      ]
    }

    case 'missed_discount': {
      return [
        { label: 'Discount terms were available on this invoice', matched: true },
        { label: 'Paid after the discount window closed', matched: false },
      ]
    }

    case 'bank_account_change': {
      return [
        { label: 'Same vendor', matched: true },
        { label: 'Sequential payment history', matched: true },
        { label: 'Different bank account on file', matched: false },
      ]
    }

    case 'amount_outlier': {
      return [
        { label: "Same vendor's payment pattern", matched: true },
        { label: "Well above this vendor's typical payment", matched: false },
      ]
    }

    case 'shared_invoice_number': {
      return [
        { label: 'Same invoice number', matched: true },
        { label: 'Different vendor on file', matched: false },
      ]
    }
  }
}

export type EvidenceStrength = 'Strong' | 'Moderate' | 'Limited'

/**
 * A plain-language evidence-strength label derived from how many checklist
 * conditions actually matched, deliberately not a numeric confidence score.
 * Severity acts as a floor: a rule that inherently produces ambiguous
 * evidence (e.g. near-duplicate) never reads as "Strong".
 */
export function evidenceStrength(finding: Finding): EvidenceStrength {
  const checks = buildRuleChecklist(finding)
  const matchedRatio = checks.filter((c) => c.matched).length / checks.length
  if (finding.severity === 'low' || matchedRatio < 0.5) return 'Limited'
  if (finding.severity === 'high' && matchedRatio >= 0.75) return 'Strong'
  return 'Moderate'
}

/** The first unmatched checklist item — the case's key open uncertainty. */
export function keyUncertainty(finding: Finding): string | null {
  const unmatched = buildRuleChecklist(finding).find((c) => !c.matched)
  return unmatched ? unmatched.label : null
}
