// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { openDatabase } from './db.ts'
import { deleteAccount } from './account.ts'
import { ROLE_PERMISSIONS, TenantAccessError, ensureTenancySchema, listMembers, personalOrganizationId, requirePermission, revokeMember, setMemberRole, tenantContextFor } from './tenancy.ts'

const addUser = (db: DatabaseSync, id: string, company = `${id} Co`) =>
  db.prepare('INSERT INTO users (id, email, company, created_at) VALUES (?, ?, ?, ?)').run(id, `${id}@example.test`, company, 1)

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (err) {
    if (err instanceof TenantAccessError) return `${err.status} ${err.code}`
    throw err
  }
  return 'ok'
}

describe('migrating accounts into organisations', () => {
  it('gives every existing account exactly one personal organisation it owns, idempotently', () => {
    const db = openDatabase(':memory:')
    addUser(db, 'alice', 'Alice Co')
    addUser(db, 'bob', '')
    ensureTenancySchema(db)
    ensureTenancySchema(db)
    const orgs = db.prepare('SELECT id, name, personal_user_id FROM organizations ORDER BY personal_user_id').all() as Array<{ id: string; name: string; personal_user_id: string }>
    expect(orgs.map((o) => [o.personal_user_id, o.name])).toEqual([['alice', 'Alice Co'], ['bob', 'My organisation']])
    for (const o of orgs) expect(db.prepare('SELECT user_id, role, revoked_at FROM memberships WHERE org_id = ?').all(o.id)).toEqual([{ user_id: o.personal_user_id, role: 'owner', revoked_at: null }])
  })

  it('migrates a database written before tenancy existed without touching its data', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, company TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL)")
    db.exec("INSERT INTO users VALUES ('legacy', 'legacy@example.test', 'Legacy Co', 1)")
    ensureTenancySchema(db)
    expect(db.prepare('SELECT * FROM users').all()).toEqual([{ id: 'legacy', email: 'legacy@example.test', company: 'Legacy Co', created_at: 1 }])
    expect(tenantContextFor(db, 'legacy').role).toBe('owner')
  })

  it('creates the personal organisation on first use for an account that signed up after startup', () => {
    const db = openDatabase(':memory:')
    addUser(db, 'late')
    const ctx = tenantContextFor(db, 'late')
    expect(ctx).toEqual({ tenantId: personalOrganizationId(db, 'late'), actorUserId: 'late', role: 'owner', permissions: ROLE_PERMISSIONS.owner })
    expect(tenantContextFor(db, 'late').tenantId).toBe(ctx.tenantId)
  })
})

describe('tenant context', () => {
  it('never lets a caller act in an organisation it does not belong to', () => {
    const db = openDatabase(':memory:')
    addUser(db, 'alice')
    addUser(db, 'mallory')
    const aliceOrg = tenantContextFor(db, 'alice').tenantId
    expect(code(() => tenantContextFor(db, 'mallory', aliceOrg))).toBe('404 tenant_not_found')
    expect(code(() => tenantContextFor(db, 'mallory', 'org_does_not_exist'))).toBe('404 tenant_not_found')
    expect(code(() => tenantContextFor(db, 'mallory', "x' OR 1=1 --"))).toBe('404 tenant_not_found')
  })

  it('ends access the moment a membership is revoked, and a re-added member starts fresh', () => {
    const db = openDatabase(':memory:')
    addUser(db, 'alice')
    addUser(db, 'bob')
    const owner = tenantContextFor(db, 'alice')
    setMemberRole(db, owner, 'bob', 'member', 10)
    expect(tenantContextFor(db, 'bob', owner.tenantId).role).toBe('member')
    revokeMember(db, owner, 'bob', 20)
    expect(code(() => tenantContextFor(db, 'bob', owner.tenantId))).toBe('404 tenant_not_found')
    expect(listMembers(db, owner).map((m) => m.userId)).toEqual(['alice'])
    setMemberRole(db, owner, 'bob', 'viewer', 30)
    expect(tenantContextFor(db, 'bob', owner.tenantId).role).toBe('viewer')
    expect(listMembers(db, owner).find((m) => m.userId === 'bob')?.createdAt).toBe(30)
  })

  it('denies writes, member management, export and deletion to roles without them', () => {
    const db = openDatabase(':memory:')
    for (const id of ['alice', 'adam', 'mia', 'vic', 'zed']) addUser(db, id)
    const owner = tenantContextFor(db, 'alice')
    setMemberRole(db, owner, 'adam', 'admin')
    setMemberRole(db, owner, 'mia', 'member')
    setMemberRole(db, owner, 'vic', 'viewer')
    const admin = tenantContextFor(db, 'adam', owner.tenantId)
    const member = tenantContextFor(db, 'mia', owner.tenantId)
    const viewer = tenantContextFor(db, 'vic', owner.tenantId)

    expect(code(() => requirePermission(viewer, 'ledger:import'))).toBe('403 permission_denied')
    expect(code(() => requirePermission(viewer, 'cases:write'))).toBe('403 permission_denied')
    expect(code(() => requirePermission(member, 'integrations:manage'))).toBe('403 permission_denied')
    expect(code(() => requirePermission(member, 'data:export'))).toBe('403 permission_denied')
    expect(code(() => requirePermission(admin, 'data:delete'))).toBe('403 permission_denied')
    expect(code(() => requirePermission(owner, 'data:delete'))).toBe('ok')

    expect(code(() => setMemberRole(db, member, 'zed', 'viewer'))).toBe('403 permission_denied')
    expect(code(() => setMemberRole(db, viewer, 'zed', 'viewer'))).toBe('403 permission_denied')
    expect(code(() => setMemberRole(db, admin, 'zed', 'member'))).toBe('ok')
    // Admins manage roles below owner, never ownership itself.
    expect(code(() => setMemberRole(db, admin, 'zed', 'owner'))).toBe('403 permission_denied')
    expect(code(() => setMemberRole(db, admin, 'alice', 'viewer'))).toBe('403 permission_denied')
    expect(code(() => revokeMember(db, admin, 'alice'))).toBe('403 permission_denied')
    expect(code(() => revokeMember(db, member, 'vic'))).toBe('403 permission_denied')
  })

  it('keeps at least one owner, and never removes the account that owns a personal organisation', () => {
    const db = openDatabase(':memory:')
    addUser(db, 'alice')
    addUser(db, 'bob')
    const owner = tenantContextFor(db, 'alice')
    expect(code(() => setMemberRole(db, owner, 'alice', 'admin'))).toBe('403 last_owner')
    expect(code(() => revokeMember(db, owner, 'alice'))).toBe('403 last_owner')
    setMemberRole(db, owner, 'bob', 'owner')
    expect(code(() => revokeMember(db, owner, 'alice'))).toBe('403 personal_owner')
    // Another owner can't demote the personal account either; a demotion would leave alice unable to manage her own org.
    const bob = tenantContextFor(db, 'bob', owner.tenantId)
    expect(code(() => setMemberRole(db, bob, 'alice', 'viewer'))).toBe('403 personal_owner')
    expect(code(() => setMemberRole(db, owner, 'alice', 'admin'))).toBe('403 personal_owner')
    expect(code(() => setMemberRole(db, owner, 'alice', 'owner'))).toBe('ok')
    expect(code(() => setMemberRole(db, bob, 'bob', 'admin'))).toBe('ok')
    expect(code(() => revokeMember(db, owner, 'nobody'))).toBe('404 member_not_found')
    expect(code(() => setMemberRole(db, owner, 'nobody', 'member'))).toBe('404 account_not_found')
  })
})

describe('deleting an account', () => {
  it('deletes its personal organisation and memberships, and only its own', () => {
    const db = openDatabase(':memory:')
    addUser(db, 'alice')
    addUser(db, 'bob')
    const alice = tenantContextFor(db, 'alice')
    const bob = tenantContextFor(db, 'bob')
    setMemberRole(db, bob, 'alice', 'member')
    deleteAccount(db, { id: 'alice', email: 'alice@example.test' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM organizations WHERE id = ?').get(alice.tenantId)).toEqual({ n: 0 })
    expect(db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = 'alice'").get()).toEqual({ n: 0 })
    expect(tenantContextFor(db, 'bob').tenantId).toBe(bob.tenantId)
    expect(listMembers(db, bob).map((m) => m.userId)).toEqual(['bob'])
  })
})
