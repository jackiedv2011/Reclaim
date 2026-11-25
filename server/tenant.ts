/**
 * Who is acting, for whom, with which permissions: always derived on the
 * server from the signed-in session, never from anything the caller sends.
 *
 * FIXTURE ADAPTER (workstream/recovery-ai, contract v0.1). Reclaim has no
 * organisations or roles yet: every account is a tenant of one person who
 * holds every permission. Sid owns the real tenancy and role primitives; when
 * they land, `tenantForUser` is the one function to replace. Everything in
 * the recovery and AI workstream asks this module, so separation of duties
 * (preparer vs approver) switches on without touching the callers.
 */
import { HttpError } from './http.ts'

export const PERMISSIONS = [
  'case.read',
  /** Create an action proposal (a person, a job, an AI task or an inbound reply can propose). */
  'case.propose',
  /** Approve, reject or execute a consequential action. */
  'case.approve',
  /** Run an AI task the tenant's policy allows. */
  'ai.invoke',
  /** Change the tenant's AI policy and grant or revoke consent. */
  'ai.manage',
  'jobs.manage',
  'documents.write',
  'inbound.read',
] as const
export type Permission = typeof PERMISSIONS[number]

export interface TenantContext {
  /** The data-isolation key. Today the user id; an organisation id later. */
  tenantId: string
  actorId: string
  /** What audit rows record as the actor. */
  actorLabel: string
  permissions: ReadonlySet<Permission>
  /** Where these permissions came from, so nothing mistakes the fixture for real roles. */
  source: 'single_user_fixture' | 'system_job'
}

export function tenantForUser(user: { id: string; email: string }): TenantContext {
  return { tenantId: user.id, actorId: user.id, actorLabel: user.email, permissions: new Set(PERMISSIONS), source: 'single_user_fixture' }
}

/**
 * A background job acting for a tenant. It may prepare and propose, never
 * approve: whatever a job produces waits for a person.
 */
export function systemContext(tenantId: string, job: string): TenantContext {
  return { tenantId, actorId: `job:${job}`, actorLabel: `Reclaim (${job})`, permissions: new Set<Permission>(['case.read', 'case.propose']), source: 'system_job' }
}

export function requirePermission(ctx: TenantContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) throw new HttpError(403, 'Your role does not allow this action.', 'forbidden')
}
