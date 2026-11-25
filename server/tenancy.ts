/**
 * Organisations, memberships and the tenant context every ledger read and
 * write is scoped by (C4, contract `TenantContext`).
 *
 * - The server derives the tenant and the actor from the session. A caller may
 *   *choose* among organisations it belongs to, but the choice is checked
 *   against an active membership here; it is never trusted on its own.
 * - Every account has exactly one personal organisation it owns. Existing
 *   accounts are migrated into one on startup (additive, idempotent), so
 *   nobody loses ownership of, or access to, anything.
 * - Deleting an account deletes its personal organisation (foreign-key
 *   cascade), and with it every tenant-scoped ledger row stored under it.
 *
 * Roles here are access primitives only. Which role may approve which recovery
 * action is Jagan's approval policy, built on top of these.
 */
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { TenantContext, TenantPermission, TenantRole } from '../src/contracts/financial.ts'

export const TENANT_ROLES: readonly TenantRole[] = ['owner', 'admin', 'member', 'viewer']

export const ROLE_PERMISSIONS: Readonly<Record<TenantRole, readonly TenantPermission[]>> = {
  owner: ['ledger:read', 'ledger:import', 'findings:read', 'cases:write', 'integrations:manage', 'members:manage', 'data:export', 'data:delete'],
  admin: ['ledger:read', 'ledger:import', 'findings:read', 'cases:write', 'integrations:manage', 'members:manage', 'data:export'],
  member: ['ledger:read', 'ledger:import', 'findings:read', 'cases:write'],
  viewer: ['ledger:read', 'findings:read'],
}

export class TenantAccessError extends Error {
  readonly status: 403 | 404
  readonly code: string
  constructor(status: 403 | 404, message: string, code: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function ensureTenancySchema(db: DatabaseSync, now = Date.now()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    personal_user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS memberships (
    org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    PRIMARY KEY (org_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS memberships_user ON memberships(user_id, revoked_at);`)
  // Every existing account becomes the owner of a one-member organisation.
  const missing = db.prepare('SELECT id, company, created_at FROM users WHERE id NOT IN (SELECT personal_user_id FROM organizations WHERE personal_user_id IS NOT NULL)').all() as Array<{ id: string; company: string; created_at: number }>
  if (missing.length === 0) return
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const u of missing) insertPersonalOrganization(db, u.id, u.company, now)
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}

function insertPersonalOrganization(db: DatabaseSync, userId: string, company: string, now: number): string {
  const id = `org_${randomUUID()}`
  db.prepare('INSERT INTO organizations (id, name, created_at, personal_user_id) VALUES (?, ?, ?, ?)').run(id, company.trim() || 'My organisation', now, userId)
  db.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(id, userId, now)
  return id
}

/** The account's own organisation, created on first use for accounts that signed up after startup. */
export function personalOrganizationId(db: DatabaseSync, userId: string, now = Date.now()): string {
  const row = db.prepare('SELECT id FROM organizations WHERE personal_user_id = ?').get(userId) as { id: string } | undefined
  if (row) return row.id
  const user = db.prepare('SELECT company FROM users WHERE id = ?').get(userId) as { company: string } | undefined
  if (!user) throw new TenantAccessError(404, 'Account not found.', 'account_not_found')
  return insertPersonalOrganization(db, userId, user.company, now)
}

const contextOf = (tenantId: string, actorUserId: string, role: TenantRole): TenantContext => ({ tenantId, actorUserId, role, permissions: ROLE_PERMISSIONS[role] })

/**
 * The tenant a signed-in user acts in. Without `requestedTenantId` it is their
 * personal organisation. With one, it must be an organisation they hold an
 * active membership in; otherwise 404, so the response does not reveal whether
 * the organisation exists.
 */
export function tenantContextFor(db: DatabaseSync, userId: string, requestedTenantId?: string | null): TenantContext {
  const tenantId = requestedTenantId ?? personalOrganizationId(db, userId)
  if (typeof tenantId !== 'string' || !/^[\w-]{1,100}$/.test(tenantId)) throw new TenantAccessError(404, 'Organisation not found.', 'tenant_not_found')
  const row = db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL').get(tenantId, userId) as { role: TenantRole } | undefined
  if (!row) throw new TenantAccessError(404, 'Organisation not found.', 'tenant_not_found')
  return contextOf(tenantId, userId, row.role)
}

export function can(ctx: TenantContext, permission: TenantPermission): boolean {
  return ctx.permissions.includes(permission)
}

export function requirePermission(ctx: TenantContext, permission: TenantPermission): void {
  if (!can(ctx, permission)) throw new TenantAccessError(403, 'Your role does not allow this.', 'permission_denied')
}

export interface MembershipView {
  userId: string
  role: TenantRole
  createdAt: number
}

export function listMembers(db: DatabaseSync, ctx: TenantContext): MembershipView[] {
  requirePermission(ctx, 'ledger:read')
  return (db.prepare('SELECT user_id, role, created_at FROM memberships WHERE org_id = ? AND revoked_at IS NULL ORDER BY created_at, user_id').all(ctx.tenantId) as Array<{ user_id: string; role: TenantRole; created_at: number }>)
    .map((m) => ({ userId: m.user_id, role: m.role, createdAt: m.created_at }))
}

const activeOwners = (db: DatabaseSync, orgId: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE org_id = ? AND role = 'owner' AND revoked_at IS NULL").get(orgId) as { n: number }).n

/**
 * Adds a member or changes an active member's role. Only owners grant or take
 * away ownership; admins manage the other roles. The last owner cannot be
 * demoted. A revoked member added again gets a fresh membership.
 */
export function setMemberRole(db: DatabaseSync, ctx: TenantContext, userId: string, role: TenantRole, now = Date.now()): void {
  requirePermission(ctx, 'members:manage')
  if (!TENANT_ROLES.includes(role)) throw new TenantAccessError(403, 'Unknown role.', 'invalid_role')
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) throw new TenantAccessError(404, 'Account not found.', 'account_not_found')
  const current = db.prepare('SELECT role, revoked_at FROM memberships WHERE org_id = ? AND user_id = ?').get(ctx.tenantId, userId) as { role: TenantRole; revoked_at: number | null } | undefined
  const touchesOwner = role === 'owner' || (current?.revoked_at === null && current.role === 'owner')
  if (touchesOwner && ctx.role !== 'owner') throw new TenantAccessError(403, 'Only an owner can change ownership.', 'permission_denied')
  if (current?.revoked_at === null && current.role === 'owner' && role !== 'owner' && activeOwners(db, ctx.tenantId) <= 1) {
    throw new TenantAccessError(403, 'An organisation needs at least one owner.', 'last_owner')
  }
  db.prepare(`INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = excluded.role,
      created_at = CASE WHEN memberships.revoked_at IS NULL THEN memberships.created_at ELSE excluded.created_at END,
      revoked_at = NULL`).run(ctx.tenantId, userId, role, now)
}

/** Revokes a membership. The row is kept (revoked_at) for the audit trail; access ends immediately. */
export function revokeMember(db: DatabaseSync, ctx: TenantContext, userId: string, now = Date.now()): void {
  requirePermission(ctx, 'members:manage')
  const current = db.prepare('SELECT role FROM memberships WHERE org_id = ? AND user_id = ? AND revoked_at IS NULL').get(ctx.tenantId, userId) as { role: TenantRole } | undefined
  if (!current) throw new TenantAccessError(404, 'Member not found.', 'member_not_found')
  if (current.role === 'owner' && ctx.role !== 'owner') throw new TenantAccessError(403, 'Only an owner can remove an owner.', 'permission_denied')
  if (current.role === 'owner' && activeOwners(db, ctx.tenantId) <= 1) throw new TenantAccessError(403, 'An organisation needs at least one owner.', 'last_owner')
  const personal = db.prepare('SELECT personal_user_id FROM organizations WHERE id = ?').get(ctx.tenantId) as { personal_user_id: string | null } | undefined
  if (personal?.personal_user_id === userId) throw new TenantAccessError(403, 'The account that owns a personal organisation cannot be removed from it.', 'personal_owner')
  db.prepare('UPDATE memberships SET revoked_at = ? WHERE org_id = ? AND user_id = ?').run(now, ctx.tenantId, userId)
}
