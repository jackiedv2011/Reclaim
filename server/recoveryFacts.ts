/**
 * Read-only views of one saved case, resolved from the account's own stored
 * audit. Everything in the recovery/AI workstream reads cases through here,
 * never from what a browser sends.
 */
import { evaluateEligibility } from '../src/recovery/eligibility.ts'
import { activeReturned, verifiedReturned } from '../src/recovery/financials.ts'
import type { CaseState, RecoveryMethod } from '../src/ledger/caseState.ts'
import type { Finding } from '../src/types.ts'
import { hashJson } from './sealedJson.ts'

type StoredEnv = { records?: Array<Record<string, unknown> & { id: string }>; result?: { findings?: Array<Record<string, unknown> & { id: string }> }; caseStates?: Record<string, CaseState> }

export interface StoredCase {
  finding: Finding
  findings: Finding[]
  state: CaseState
  mode: string
  /** Changes whenever this case's finding, evidence, source rows or state change; not when other cases do. */
  fingerprint: string
}

export function storedCase(project: Record<string, unknown> | null, findingId: string): StoredCase | null {
  const env = project?.environment as StoredEnv | undefined
  if (!env) return null
  const records = new Map((env.records ?? []).map((r) => [r.id, r]))
  const findings = (env.result?.findings ?? []).map((f) => ({ ...f, relatedRecords: ((f.relatedRecords as Array<{ id: string }>) ?? []).map((r) => records.get(r.id) ?? r) })) as unknown as Finding[]
  const finding = findings.find((f) => f.id === findingId)
  if (!finding) return null
  const state = env.caseStates?.[findingId] ?? { decision: null, reason: null, decidedAt: null, recoveryStage: null }
  return { finding, findings, state, mode: String(project?.mode ?? 'upload'), fingerprint: hashJson({ finding, state }) }
}

export function caseIds(project: Record<string, unknown> | null): string[] {
  const env = project?.environment as StoredEnv | undefined
  return Object.keys(env?.caseStates ?? {})
}

export type Draftable =
  | { ok: true; case: StoredCase; potentialMinor: number; method: RecoveryMethod; amountMinor: number }
  | { ok: false; reason: string }

/**
 * Whether a supplier request may be drafted: a recovery candidate that passes
 * the evidence gate, waiting for approval or approved but not sent, with no
 * hold, and an amount within what the evidence supports after earlier returns.
 *
 * Approval is deliberately NOT required: a draft is text for a person to
 * review, never an approved request. Sending still needs approval of the exact
 * final version (caseFacts.ts authorizedSendFacts).
 */
export function draftableRequest(project: Record<string, unknown> | null, findingId: string, amountRequested: number, method?: RecoveryMethod | null): Draftable {
  const c = storedCase(project, findingId)
  if (!c) return { ok: false, reason: 'That case is not in this account.' }
  if (c.finding.classification !== 'recovery_candidate') return { ok: false, reason: 'Only recovery candidates can be drafted.' }
  const gate = evaluateEligibility(c.finding, c.finding.evidence, c.findings)
  if (!gate.eligible || gate.potentialAmountMinor === null) return { ok: false, reason: 'The saved evidence does not pass the recovery gate.' }
  if (c.state.recoveryStage !== 'confirmed') return { ok: false, reason: 'Drafts are available while a confirmed case is waiting to be sent.' }
  if (c.state.contactHold) return { ok: false, reason: 'Vendor contact is on hold.' }
  if (c.state.requiresRevalidation) return { ok: false, reason: 'Revalidate the evidence before drafting a new request.' }
  const cents = Math.round(amountRequested * 100)
  if (!Number.isSafeInteger(cents) || cents <= 0 || Math.abs(amountRequested * 100 - cents) > 1e-6) return { ok: false, reason: 'Enter a positive amount in whole cents.' }
  const olderReturned = Math.round((verifiedReturned(c.state) - activeReturned(c.state)) * 100)
  if (cents > gate.potentialAmountMinor - olderReturned) return { ok: false, reason: 'The amount is more than the evidence supports after earlier returns.' }
  const chosen = method ?? c.state.requestedResolution ?? null
  if (!chosen) return { ok: false, reason: 'Choose a refund, credit or offset first.' }
  return { ok: true, case: c, potentialMinor: gate.potentialAmountMinor - olderReturned, method: chosen, amountMinor: cents }
}
