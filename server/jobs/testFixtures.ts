/**
 * Synthetic cases for the J3 job tests. Test fixture only: no real supplier,
 * customer or address. The vendor name and amount are distinctive so tests
 * can prove they never leak into job payloads, events or notifications.
 */
import type { DatabaseSync } from 'node:sqlite'
import { authorizedProject } from '../testProject.ts'
import { storedCase } from '../recoveryFacts.ts'

export const DAY = 86_400_000
export const VENDOR = 'Zephyr Quillworks Ltd'
export const VENDOR_EMAIL = 'billing@zephyr-quill.example'
export const AMOUNT = 4321.87

/** A request sent `sentAt`, due for follow-up `followUpAt`, and anything else on the case. */
export function requestedProject(id: string, input: { sentAt: number; followUpAt?: number | null; state?: Record<string, unknown>; mode?: 'upload' | 'sample' }) {
  const { project, findingId } = authorizedProject(id, { vendor: VENDOR, invoice: 'INV-77', amount: AMOUNT, requested: AMOUNT })
  const env = project.environment as { caseStates: Record<string, Record<string, unknown>> }
  env.caseStates[findingId] = {
    ...env.caseStates[findingId],
    recoveryStage: 'requested',
    recoveryRequestedAt: input.sentAt,
    recoverySubject: 'Duplicate payment of invoice INV-77',
    recoveryDraft: `Hello,\nWe paid invoice INV-77 twice. Please refund ${AMOUNT}.`,
    recoveryRecipientEmail: VENDOR_EMAIL,
    recoverySentEmail: { channel: 'gmail', messageId: 'msg-1', from: 'ap@customer.example', to: VENDOR_EMAIL, cc: ['controller@customer.example'], sentAt: input.sentAt },
    nextFollowUpAt: input.followUpAt === undefined ? input.sentAt + 7 * DAY : input.followUpAt,
    ...input.state,
  }
  return { project: { ...project, mode: input.mode ?? 'upload' }, findingId }
}

/** A case confirmed but not yet approved by the customer. */
export function awaitingApprovalProject(id: string) {
  const { project, findingId } = authorizedProject(id, { vendor: VENDOR, invoice: 'INV-88', amount: AMOUNT, requested: AMOUNT })
  const env = project.environment as { caseStates: Record<string, Record<string, unknown>> }
  env.caseStates[findingId] = { ...env.caseStates[findingId], approvedAt: null }
  return { project, findingId }
}

export function addUser(db: DatabaseSync, id: string, first = 'Pat', last = 'Lee', company = 'Customer Co'): void {
  db.prepare('INSERT INTO users (id, email, email_verified, first_name, last_name, company, created_at) VALUES (?, ?, 1, ?, ?, ?, 1)').run(id, `${id}@customer.example`, first, last, company)
}

export const fingerprintOf = (project: Record<string, unknown> | null, findingId: string) => storedCase(project, findingId)!.fingerprint
