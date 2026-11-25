# Financial foundation workstream: execution ledger

Owner: Sid (CTO workstream). Branch `workstream/financial-foundation`, base `origin/main` @ `b27ee30`.
Contract: `src/contracts/financial.ts` v0.1.0 (proposed, awaiting sign-off from Jagan and Aditya).
Statuses: ready · in progress · verified · blocked · deferred. "Verified" means tests ran green locally on synthetic data. It never means live or customer validated.

## Baseline (C0)

| Check | Command | Result on b27ee30, Node v24.14.1 |
|---|---|---|
| Unit/integration | `npx vitest run` (serial) | 75 files, 818 passed, 0 failed, 0 skipped |
| Types | `npx tsc -b` | exit 0 |
| Lint | `npx oxlint` | exit 0 (warnings only) |

The audit's "5 files fail to load (`node:sqlite`)" does not reproduce on Node 24, because there `builtinModules` lists `node:sqlite`. Harness fix `4de78bc` was cherry-picked anyway (`450e3bc`) so the suite also loads on Node 22.

## Ledger

| ID | Task | Depends on | Status | Evidence / next action |
|---|---|---|---|---|
| C0.1 | Baseline tests, types, lint | none | verified | Table above |
| C0.2 | Recover harness fix `4de78bc` | C0.1 | verified | `450e3bc`; the 5 affected suites pass (40 tests) |
| C0.3 | Find Jagan's column-mapping branch | none | blocked | Not in remote branches, local branches, worktrees or stash. **Question for Sid.** C1 mappings were built fresh. |
| C0.4 | Contract draft (types) | none | verified | `src/contracts/financial.ts` |
| C0.5 | Make the engine importable by Node server | none | verified | `@/` alias imports replaced with relative `.ts` paths in detection, csv, sourceIdentity, vendorResolution and findingMetadata. Import paths only, no behaviour change; the src/lib suites pass (197). |
| C0.6 | SQLite pilot assessment | none | verified | `docs/workstream/contracts-and-migrations.md` |
| C1.1 | Import coverage service | C0.4 | see final table | |
| C1.2 | Versioned per-tenant column mappings with confirmation | C0.4, C4.1 | see final table | |
| C2.1 | Matcher module (blocking, transparent features, default-off) | C0.4 | see final table | |
| C2.2 | Frozen dev and held-out fixtures, benchmark | C2.1 | see final table | |
| C3.1 | Tenant-scoped imports and source_records tables | C4.1 | see final table | |
| C3.2 | Server ingestion and server-side detection | C3.1, C1.1 | see final table | |
| C3.3 | Scoped read APIs (records, vendor/period aggregates) | C3.1 | see final table | |
| C4.1 | Organisations and memberships, users migrated to one-member orgs | none | see final table | |
| C4.2 | S8: QuickBooks link ownership check | none | see final table | |
| C4.3 | QuickBooks write-method block test | none | see final table | |
| C4.4 | localStorage, CSP and token-scope assessment | none | see final table | |
| C5.1 | Persist normalized QuickBooks facts per tenant and realm | C3.1 | see final table | |
| C5.2 | Sync state, idempotent handlers, fake runner | C5.1 | see final table | |
| C6.1 | Return/credit matching to open requests | C0.4 | see final table | |
| C6.2 | Unused supplier credit reconciliation | C6.1 | see final table | |

The final status of every row is in the "Final status" section, filled in at the end of the session.
