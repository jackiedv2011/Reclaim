# Financial foundation (CTO workstream C0–C6): technical handoff

For Aditya and Jagan; reviewed by Sid. Status as of 25 Nov 2026.

Everything below was verified **locally on synthetic data only**. Nothing was deployed, pushed, run against a live provider, or run on customer data. "Verified" means tests passed on this branch.

## 1. Branch, base, commits

- Branch: `workstream/financial-foundation`. It is local only and has not been pushed.
- Base: `origin/main` @ `b27ee30`.

| Commit | Slice |
|---|---|
| `450e3bc` | C0: harness fix (live-server front-end tests on Vite's node pipeline; cherry-pick of `4de78bc`) |
| `307836b` | C0: contract draft `src/contracts/financial.ts`; engine importable by the server (import paths only) |
| `e51bd85` | C4: organisations, memberships, S8 QuickBooks link ownership check, QuickBooks client surface guard |
| `a75d63a` | C6: deterministic return matching and unused-credit reconciliation |
| `114766c` | C1: versioned column mappings, machine-readable import coverage |
| `8048b7a` | C3: tenant-scoped server ledger behind `RECLAIM_SERVER_LEDGER` |
| `562776e` | C2: intelligent record matching experiment, default off |
| `7098c88` | C5: QuickBooks pulls persisted as connector records; idempotent sync and scan handlers |
| `2e618c1` | Job contract unified with the handlers; fixes for review findings 1–6 (§13) |
| *(docs)* | This handoff and the final progress ledger |

Diff against base: 55 files changed, about 11.4k lines added, 14 removed (largely new modules, tests and fixtures). Run `git diff --stat b27ee30..workstream/financial-foundation` for the exact list.

## 2. Changed files

**New modules**

| Area | Files |
|---|---|
| Contract | `src/contracts/financial.ts` |
| Ingestion (C1) | `src/ingestion/columnMapping.ts`, `src/ingestion/coverage.ts`, `server/columnMappings.ts` |
| Matcher (C2) | `src/lib/matcher/*`, `scripts/matcher-benchmark.ts` |
| Ledger (C3) | `server/ledger.ts`, `server/ledgerRoutes.ts` |
| Tenancy (C4) | `server/tenancy.ts` |
| Sync (C5) | `server/ledgerSync.ts` |
| Reconciliation (C6) | `src/reconciliation/returnMatching.ts`, `src/reconciliation/unusedCredits.ts` |
| Test harness | `src/test/jsdomServerEnvironment.ts` |

**Shared entrypoints** (small, separate edits)

- `server/app.ts`: mounts ledger routes behind the flag, reseals ledger rows at start-up, adds the S8 ownership check.
- `server/db.ts`: four additive `ensure*Schema` calls.
- `server/config.ts`: `serverLedger` flag.
- `server/quickbooks.ts`: `QuickBooksRateLimitError` on 429, with the same message as before.
- `src/AuditApp.tsx`: the QuickBooks link is sent only after the save has flushed.
- `vite.config.ts`: test-only environment alias.

**Protected engine files** (`detection.ts`, `csv.ts`, `sourceIdentity.ts`, `vendorResolution.ts`, `findingMetadata.ts`)

- Only `@/` imports were changed to relative `.ts` paths, plus `export` on `COLUMN_ALIASES` in `csv.ts`. Behaviour is unchanged.
- `claims.ts`, `src/recovery/model.ts`, `src/recovery/eligibility.ts`, `server/plans.ts`, `server/uploads.ts`, `server/auth.ts`, `server/caseCommands.ts` and the `.wk-*` CSS are **not modified**.

## 3. Migrations

All migrations are additive and idempotent. They run in `openDatabase` with `CREATE TABLE IF NOT EXISTS`. Nothing is dropped, renamed or rewritten.

| Table | Module | Notes |
|---|---|---|
| `organizations`, `memberships` | `server/tenancy.ts` | Every existing user is migrated into a one-member organisation they own. Deleting the account cascades to the personal organisation. |
| `ledger_imports`, `source_records` | `server/ledger.ts` | Tenant FK with cascade delete. Payloads are sealed with AAD-bound keys (`config.dataKeys`). A blind index is used for dedup. `resealLedger` runs at start-up. |
| `column_mappings` (+ history) | `server/columnMappings.ts` | Versioned per tenant and header signature. Stores header names only, never row values. |
| `ledger_sync_state`, `ledger_job_receipts` | `server/ledgerSync.ts` | Per tenant and realm: last requested, last success, last failure and cursor. Receipts are keyed by (tenant, operation, idempotency key). |

**Rollback:** deploy the previous build, which ignores the new tables. Drop the tables only after a backup and with founder approval. A legacy `projects` row is never read or rewritten by the new code.

## 4. Contract versions and fixtures

| Contract | Version | Status |
|---|---|---|
| `src/contracts/financial.ts` (`FINANCIAL_CONTRACT_VERSION`) | 0.1.0 | Proposed; needs sign-off (see below) |
| `SOURCE_NORMALIZATION_VERSION` | 1 | Proposed |
| `LEDGER_ALGORITHM_VERSION` | `server-ledger/1.0.0` | |
| `MAPPING_ALGORITHM_VERSION` | 1 | |
| `MATCHER_VERSION` | `record-matcher-0.1.0` | Experiment, default off |
| `RETURN_MATCH_VERSION` | `return-match/1.0.0` | |
| `UNUSED_CREDIT_VERSION` | `unused-credit/1.0.0` | |
| Job contract (`LEDGER_JOB_CONTRACT_VERSION` = financial contract version) | 0.1.0 | |

Sign-off needed:
- **Jagan:** job handler and return match.
- **Aditya:** scoped reads and coverage.

The job section was revised before anyone consumed it. `JobRequest` now carries `actorUserId`, outcomes carry bounded `JobErrorCode`s, and the audit event gained `already_completed`. The C5 handlers implement the contract's `JobHandler`, which the type checker enforces.

**Fixtures** (all synthetic, generated, no real names or data)

- `src/lib/matcher/fixtures/dev.json` and `heldout.json`, from the seeded generator `generate.ts`. They are frozen.
- `src/reconciliation/fixtures.ts`: requests, returns and credits for C6.
- Fake read-only QuickBooks client and fake runner inside `server/ledgerSync.test.ts`. This is a **fixture, not Jagan's runner.**

## 5. Test results

Commands: `npx vitest run` (serial), `npx tsc -b`, `npx oxlint`.

| | Files | Passed | Failed | Skipped |
|---|---:|---:|---:|---:|
| Baseline `b27ee30` | 75 | 818 | 0 | 0 |
| Final | 85 | 1021 | 0 | 0 |

- `tsc -b` exits 0 on both.
- `oxlint` exits 0 on both. Its warnings are pre-existing; there are none in the changed files.
- New suites:

  | Suite | Tests |
  |---|---:|
  | tenancy | 8 |
  | columnMappings (server) | 10 |
  | ledger | 23 |
  | ledgerSync | 16 |
  | columnMapping | 29 |
  | coverage | 20 |
  | matcher | 32 |
  | matcher integration | 7 |
  | returnMatching | 42 |
  | unusedCredits | 13 |

  Server tests alone: 18 files, 261 tests.

  `quickbooks.test.ts` gained the write-surface guard and the 429 case.
- The audit's "5 files fail to load" does not reproduce on Node 24. The harness fix is in anyway, for Node 22.

## 6. Matcher benchmark (C2)

Full report: `docs/workstream/matcher-benchmark.md`.

**Fixtures:** dev has 1,052 records and 80 labelled pairs; held-out has 1,037 records and 76 labelled pairs. Cases are grouped by underlying bill, vendor and import, so there is no leakage between the sets.

| Held-out | Reviewed | TP | FP | FN | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|
| Baseline rules | 62 | 33 | 29 | 43 | 0.532 | 0.434 |
| Matcher candidates only | 39 | 38 | 1 | 38 | 0.974 | 0.500 |
| Baseline + matcher | 101 | 71 | 30 | 5 | 0.703 | 0.934 |

**Matched review budget (held-out)**

| Budget | TP |
|---|---:|
| B (62 reviews) | 33 |
| B + 10% | 40 |
| B + 25% | 49 |

- At the same workload the matcher adds **nothing**, because it never displaces a rule finding. It adds value only with extra review time.
- 13 of the 38 matcher TPs already sit in a Rule 8 finding.

**Failure cases**
- **One FP:** `heldout-r000258` / `heldout-r000262`, a recurring same-amount pair 11 days apart with no reference, scoring 0.60. It was not tuned away, because held-out has already been used.
- **Five FNs:** all "alias without reference". The best achievable score is about 0.57, which is below the threshold.

**Runtime**

| Rows | Matcher | Detection | Peak RSS |
|---:|---:|---:|---:|
| 1k | 16 ms | – | – |
| 10k | 266 ms | – | – |
| 50k | 4.5 s | 1.5 s | 712 MB |

At 50k rows there were 543k pairs after blocking, with no truncation.

**Safety, tested:**
- no amounts
- no call past `evaluateEligibility`
- no finding suppressed
- the flag `RECLAIM_EXPERIMENT_RECORD_MATCHER` is off by default

**Decision: keep it off.** Synthetic results are not customer evidence. The uplift threshold is Sid's call.

## 7. API and handlers

### HTTP

Routes under `/api/ledger/*` are mounted only when `RECLAIM_SERVER_LEDGER=true`. Otherwise they 404.

- Session auth is required.
- The tenant comes from the server: the caller's personal organisation, or `?tenant=` only if the caller is a member.
- Role permissions are checked on every call.

| Method and path | Permission | Purpose |
|---|---|---|
| `POST /api/ledger/mappings/proposals` `{csv}` | `ledger:import` | Proposes a column mapping. Reads headers and a sample locally; row values are not stored or returned. |
| `POST /api/ledger/mappings` `{signature, mapping}` | `ledger:import` | Confirms a mapping and stores a new version. |
| `POST /api/ledger/imports` `{csv, sourceLabel?}` | `ledger:import` | Server parses with the existing engine and returns import result, coverage and dedup counts. Responds 409 `mapping_*` until the mapping is confirmed, and 200 for an identical file already imported. Rate limited to 60 per hour per user. Client-sent records or findings are ignored. |
| `GET /api/ledger/imports` | `ledger:read` | Imports with coverage, freshness and connector detail. |
| `GET /api/ledger/records?cursor&limit&from&to&currency` or `?ids=` | `ledger:read` | Paged source records (max 200) with provenance and evidence refs. |
| `GET /api/ledger/findings` | `findings:read` | Findings derived on the server by the unchanged `detectFindings`. Each cites source record IDs and versions. |
| `GET /api/ledger/aggregates?from&to` | `ledger:read` | Vendor and period aggregates. Definition `reported_supplier_payments_v1`: reported supplier payments, not total cash flow. Grouped by currency and never summed across currencies; bills and payments are not double-counted. |

**Roles**

| Role | Permissions |
|---|---|
| owner | everything |
| admin | everything except `data:delete` |
| member | ledger read/import, findings, cases |
| viewer | `ledger:read`, `findings:read` |

### Job handlers (`server/ledgerSync.ts`)

These are for Jagan's runner and implement the contract's `JobHandler`.

**`quickBooksSyncHandler({db, keys, client, accessToken})`**, operation `quickbooks.sync`, payload `{realmId}`:
- Runs a change pull since the last success when that was within 29 days; otherwise a full pull.
- Stores the pull through the same idempotent import, with provenance `connector_authenticated`.
- Deletions in the source are reported (`removedInSource`), not applied. A change pull that only deletes is still stored as its own import, so the deletion is not lost when the cursor moves on. The list is capped at 10,000 ids per import.
- An idempotency key that has already completed returns `already_completed`.
- Failures:
  - Retryable errors back off at 60s, 120s, 240s and 480s, then `retries_exhausted`. The last successful sync is kept.
  - `reconnect_required` and `storage_rejected` are not retried.
- The `accessToken` callback belongs to the integration layer. Tokens never enter outcomes, audits or tables (tested).

**`getSyncState(db, ctx, realmId)`** reads the last requested, successful and failed sync for a realm. It takes a server-derived `TenantContext` and needs `ledger:read`; it never accepts a raw tenant id.

**`ledgerScanHandler({db, keys})`**, operation `ledger.scan`:
- Read-only.
- Returns finding counts per rule and a `throughSeq` checkpoint.

### Library services (no HTTP yet)

| Service | Signature | Notes |
|---|---|---|
| C1 coverage | `computeImportCoverage(input)` | |
| C1 mappings | `proposeColumnMapping` / `validateMapping` / `applyMapping` | |
| C2 matcher | `src/lib/matcher` | Candidates only |
| C6 return matching | `matchReturns(requests, returns, opts)` | Returns typed `ReturnMatch` results with status `proposed_source_match`, `customer_recorded`, `unmatched`, `ambiguous` or `conflict`, plus partial and reversed amounts and evidence refs. Nothing is ever `verified` by the matcher. Items are keyed by tenant + id. Never changes a case. |
| C6 credits | `reconcileSupplierCredits(input)` | Returns a balance, or `unknown` without full coverage. |

## 8. Integration order (proposed)

1. **Sign-off:** Jagan and Aditya review `src/contracts/financial.ts`.
2. **Merge to a staging branch:** tenancy (`e51bd85`) and the harness fix first. They are independent and fix S8.
3. **Server ledger:** C1 and C3 with the flag off. Then Aditya wires the coverage and mapping-confirmation UI against `/api/ledger/*` in a dev environment with the flag on.
4. **Jobs:** Jagan's runner calls `quickBooksSyncHandler` and `ledgerScanHandler`. Replace the fake runner fixture with a contract test against the real runner.
5. **Live QuickBooks sandbox smoke test:** authorized gate, run by Sid with sandbox credentials configured outside chat.
6. **C6 adapter:** after the `QuickBooksFacts` extension is agreed (§10). Then Jagan consumes `ReturnMatch` in case transitions and the eligibility gate.
7. **Matcher:** shadow mode only, after a decision on real reviewed data.

## 9. Security gaps (open)

1. **Plaintext ledger cache in the browser.** Audit data is cached in localStorage in plaintext. Current behaviour (`src/lib/auth/AuthContext.tsx`, `src/lib/storageScope.ts`):
   - Signed-in caches are scoped per user (`reclaim.u.<id>.*`) and cleared on sign-out, **except** while an unsynced save is pending or a sync issue exists. Then they stay, in plaintext, until a later merge.
   - The guest scope is cleared on sign-out; account deletion clears the user scope.
   - The unscoped legacy keys `reclaim.ledger.v1` (`src/ledger/store.ts`) and `reclaim.audit.history.v1` (`src/history/store.ts`) are outside the scoped clear. Their writers appear to have no callers outside tests; `src/ledger/projects.ts` migrates them.

   Unchanged on this branch because it is the front-end guest privacy path. Recommendation: encrypt or expire the pending-sync cache, and remove the unused legacy writers. This needs Aditya and Sid.
2. **CSP is partly enforced.** Only `frame-ancestors`, `object-src` and `base-uri` are enforced; `default-src` and the rest are report-only (`server/http.ts`). Promote to enforced after a report-only soak.
3. **QuickBooks OAuth scope is `com.intuit.quickbooks.accounting`, which grants write access.** Read-only is enforced only at the code boundary: a GET-only adapter, and a test that fails if a client method is added. Do not describe the connection as read-only to customers.
4. **Ledger encryption tradeoff (decision for Sid).**
   - Sealed: vendor, reference, memo and raw row.
   - Plaintext: amounts, dates, currency, kind and status, because aggregates and indexes need them.
   - The blind index (HMAC) leaks equality of vendor and reference within a tenant.
5. **Mapping routes are not rate limited.** Only imports are. They store header names only, and are low risk.
6. **Customer CSV status.** Uploaded rows are marked `customer_uploaded` with status `unknown`. Server parsing does not prove the file is genuine.

## 10. Unresolved decisions (for Sid unless noted)

1. Matcher uplift threshold and sample size. Proposed: at least 10% more confirmed duplicates per 10% more review, measured on real reviewed data.
2. The encryption tradeoff in §9.4.
3. SQLite vs Postgres. SQLite is adequate for a single-process pilot; revisit before multi-instance hosting (`contracts-and-migrations.md` §4).
4. Location of Jagan's column-mapping branch (C0.3). It was not found in any remote, local branch, worktree or stash, so C1 mappings were built fresh. Jagan should compare against this branch.
5. **Sid and Jagan:** an additive `QuickBooksFacts` extension for per-credit currency, DocNumber/PrivateNote references and vendor display names. This blocks the C6 QuickBooks adapter.
6. **Jagan:** whether a `ReturnMatch` with status `proposed_source_match` may feed the eligibility gate, and how credit application evidence is attested. The matcher never emits a verified status itself.
7. **Aditya:** confirmation that the aggregate definition `reported_supplier_payments_v1` fits the spending-visibility work.

## 11. Release blockers

- Contract sign-off by Jagan and Aditya.
- Live QuickBooks sandbox smoke test (authorized gate, **unverified**).
- Security gaps 1–3 in §9 reviewed or accepted.
- Hosted backup/restore exercised with the new tables.
- Consent wording before any signed-in upload goes to the server ledger. Guest data is never uploaded silently; today the flag is off and the browser path is unchanged.
- Independent security review.

## 12. Implemented vs mocked vs blocked

| Item | State |
|---|---|
| Tenancy, S8, QuickBooks write-surface guard | Implemented and tested |
| Column mappings, coverage | Implemented and tested; the UI is Aditya's |
| Server ledger, reads, aggregates, server-side detection | Implemented and tested; behind a flag that is off by default; not wired to the browser |
| Matcher | Implemented and benchmarked on synthetic data only; off by default |
| QuickBooks persistence, sync and scan handlers | Implemented, but **mocked**: fake QuickBooks client and fake runner. No live call made. |
| Return matching, unused credits | Implemented and tested on synthetic fixtures; not called by the app or server |
| C6 QuickBooks adapter | **Blocked** on the facts extension (§10.5) |
| Live provider, customer validation, deployment | **Not done.** These need human authorization. |

## 13. Independent review findings (all fixed in `2e618c1`)

A separate review pass looked for correctness and isolation bugs. Each fix has a regression test that was confirmed to fail on the earlier code.

| # | Finding | Fix | Regression test |
|---|---|---|---|
| 1 | A CSV row and a QuickBooks record for the same transaction were stored as two records. | Cross-source dedup on the identity hash. | `server/ledger.test.ts`: CSV/QuickBooks cross-source case |
| 2 | One credit shared by two requests could be allocated to both. | Attribution by bill reference; a credit is never allocated twice. | `src/reconciliation/returnMatching.test.ts`: shared-credit cases |
| 3 | Return matching and unused-credit reconciliation keyed items by id alone, so equal ids in two tenants merged. | Keys are tenant + id. | Tenant-collision tests in both suites |
| 4 | A QuickBooks change pull that only deleted rows returned nothing, so the deletion was lost when the cursor advanced. | Removals-only pulls are stored; removals feed the file checksum. | `server/ledgerSync.test.ts`: deletions-only change set |
| 5 | `resealLedger` dropped the realm scope from import file hashes, so a repeated pull after key rotation looked new; it also rewrote rows already on the current key. | Scope kept in the recomputed hash; current-key rows skipped. | `server/ledger.test.ts`: repeated pull after key rotation; reseal returns 0 when nothing to do |
| 6 | `getSyncState` accepted a raw tenant id; the owner of a personal organisation could be demoted. | It takes a `TenantContext` (`ledger:read`); demoting the personal owner returns 403 `personal_owner`. | `server/ledgerSync.test.ts` and `server/tenancy.test.ts` |

**Known limits after the fixes:** `removedInSource` keeps at most 10,000 ids per import; the blind index still leaks vendor/reference equality within a tenant (§9.4).
