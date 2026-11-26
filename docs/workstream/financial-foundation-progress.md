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
| C1.1 | Import coverage service | C0.4 | verified | `114766c`. `src/ingestion/coverage.ts`: per-rule run/limited/not_run with reasons, rejected rows and reason codes, report type, periods, freshness. A bill export without settled status leaves settled-duplicate checks `not_run`; missing columns are never read as zero. 20 tests. |
| C1.2 | Versioned per-tenant column mappings with confirmation | C0.4, C4.1 | verified | `114766c`. `src/ingestion/columnMapping.ts` + `server/columnMappings.ts`: known formats auto-resolve; unfamiliar headers produce a local proposal that must be confirmed; versions per tenant and header signature; locale conflicts (day-first dates, comma decimals) force re-confirmation. 29 + 10 tests. No external LLM. |
| C1.3 | Coverage UI | C1.1 | deferred | Aditya owns UX. The service and the `/api/ledger/imports` payload are ready to consume. |
| C2.1 | Matcher module (blocking, transparent features, default-off) | C0.4 | verified | `562776e`. `src/lib/matcher/**`, flag `RECLAIM_EXPERIMENT_RECORD_MATCHER` off by default. Candidates only: never creates amounts, never calls past `evaluateEligibility`, never suppresses a finding (tested). 32 + 7 tests. |
| C2.2 | Frozen dev and held-out fixtures, benchmark | C2.1 | verified, gain not proven | `562776e`, `docs/workstream/matcher-benchmark.md`. At the same review budget the matcher adds no true cases; it adds them only with ~25% more review. **Stays off.** Uplift criteria need Sid's decision. |
| C2.3 | Multi-export (accounting + payment) matching | C2.2, C3 | deferred | Waits on a matcher that earns its place on the single-file benchmark and on contract sign-off. |
| C3.1 | Tenant-scoped imports and source_records tables | C4.1 | verified | `8048b7a`. Additive tables; payloads sealed with AAD-bound keys; blind index for dedup. |
| C3.2 | Server ingestion and server-side detection | C3.1, C1.1 | verified | `8048b7a`. `importCsv` → confirmed mapping (409 until confirmed) → existing `parseCSV`/`detectFindings`, unchanged. Client-authored findings are ignored. Cross-import dedup: `exact_duplicate` / `possible_overlap` / `newly_imported`, also across CSV and QuickBooks sources. 23 tests. |
| C3.3 | Scoped read APIs (records, vendor/period aggregates) | C3.1 | verified | `8048b7a`. `/api/ledger/{imports,records,findings,aggregates}`, paged, tenant-filtered, mixed currencies never summed. Behind `RECLAIM_SERVER_LEDGER` (404 while off). |
| C3.4 | Switch the browser to the server ledger; legacy audit migration | C3.3 | deferred | Integration and UX step. Legacy encrypted audits are untouched; the browser-only path still works. Needs Aditya (UX) and Sid (consent wording for upload). |
| C4.1 | Organisations and memberships, users migrated to one-member orgs | none | verified | `e51bd85`. `server/tenancy.ts`; last-owner and personal-owner guards; account deletion cascades. 8 tests. |
| C4.2 | S8: QuickBooks link ownership check | none | verified | `e51bd85`. Link returns 404 unless the audit belongs to the caller; the client saves first. |
| C4.3 | QuickBooks write-method block test | none | verified | `e51bd85`. A new client method fails `server/quickbooks.test.ts` until reviewed. |
| C4.4 | localStorage, CSP and token-scope assessment | none | assessed, not fixed | See handoff §Security gaps: plaintext ledger cache in localStorage, CSP enforced only for `frame-ancestors`/`object-src`/`base-uri` (rest report-only), OAuth scope `com.intuit.quickbooks.accounting` grants write. Fixes touch shared front-end and provider config, so they go to Sid/Aditya. |
| C5.1 | Persist normalized QuickBooks facts per tenant and realm | C3.1 | verified (mocked provider) | `7098c88`. `importQuickBooksPull`, provenance `connector_authenticated`, realm-scoped identities. |
| C5.2 | Sync state, idempotent handlers, fake runner | C5.1 | verified (mocked provider) | `7098c88`. `server/ledgerSync.ts`; handlers for `quickbooks.sync` and `ledger.scan`; fake runner fixture only; removals-only pulls stored; `getSyncState` takes a `TenantContext`. 16 tests. |
| C5.3 | Live QuickBooks sandbox smoke test | C5.2 | blocked | Separate authorized release gate. Not run. |
| C6.1 | Return/credit matching to open requests | C0.4 | verified (synthetic) | `a75d63a`. `src/reconciliation/returnMatching.ts`, keyed by tenant + id, shared credits attributed by bill reference. 42 tests. Not wired to cases (Jagan owns transitions). |
| C6.2 | Unused supplier credit reconciliation | C6.1 | verified (synthetic) | `a75d63a`. Balance only with complete coverage, otherwise `unknown`; keyed by tenant + id. 13 tests. |
| C6.3 | QuickBooks facts → `ReturnSourceRecord` adapter | C5.1, C6.1 | blocked | Needs additive `QuickBooksFacts` fields (per-credit currency, DocNumber/PrivateNote, vendor display name). Cross-workstream interface change: **question for Sid/Jagan.** |

## Final status

| Check | Command | Baseline (b27ee30) | Final (branch head) |
|---|---|---|---|
| Unit/integration | `npx vitest run` | 75 files, 818 passed, 0 failed, 0 skipped | 85 files, 1021 passed, 0 failed, 0 skipped |
| Types | `npx tsc -b` | exit 0 | exit 0 |
| Lint | `npx oxlint` | exit 0 (warnings) | exit 0 (warnings all pre-existing, none in changed files) |

Nothing here was run against a live provider, real customer data or a deployed environment. The full technical handoff is `docs/workstream/HANDOFF-financial-foundation.md`.

The final status of every row is in the "Final status" section, filled in at the end of the session.

Review findings 1–6 from the independent review pass are fixed in `2e618c1`, each with a regression test (handoff §13).
