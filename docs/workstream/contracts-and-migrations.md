# Contracts, ownership and migrations (financial foundation v0.1)

## 1. Contract versions

| Contract | Location | Version | Status |
|---|---|---|---|
| Tenant context, source record, import coverage, match candidate, return match, job handler | `src/contracts/financial.ts` | `FINANCIAL_CONTRACT_VERSION = 0.1.0` | Proposed. Needs Jagan's sign-off (return match, job handler) and Aditya's (scoped reads, coverage). |
| Source normalization | `SOURCE_NORMALIZATION_VERSION = 1` | 1 | Proposed |
| Matcher algorithm | `src/lib/matcher` (`MATCHER_VERSION`) | see matcher report | Experiment, default off |
| Return matching algorithm | `src/reconciliation` (`RETURN_MATCH_VERSION`) | see module | Proposed |

Breaking changes bump the minor version while the contract is at 0.x, and are announced to the consuming owner before they are made.

## 2. File ownership map

| Area | Files | Owner | Overlap |
|---|---|---|---|
| Contracts | `src/contracts/**` | Sid | Consumed by Jagan and Aditya |
| Engine | `src/lib/detection.ts`, `csv.ts`, `sourceIdentity.ts`, `vendorResolution.ts`, `findingMetadata.ts` | Sid | Import paths only were changed (C0.5) |
| Matcher | `src/lib/matcher/**`, `scripts/matcher-benchmark.ts` | Sid | none |
| Ingestion and coverage | `src/ingestion/**`, `server/columnMappings.ts` | Sid | Coverage UI belongs to Aditya |
| Ledger store and reads | `server/ledger*.ts`, `server/tenancy.ts` | Sid | `server/app.ts` routes (shared entrypoint) |
| Reconciliation | `src/reconciliation/**` | Sid | Jagan consumes `ReturnMatch`; Jagan owns case transitions |
| Shared entrypoints | `server/app.ts`, `server/db.ts`, `src/types.ts`, `vite.config.ts` | Integrator (Sid for this branch) | Small, separate commits only |
| Eligibility gate | `src/recovery/eligibility.ts` | Jagan | Not modified |
| Case commands, model | `server/caseCommands.ts`, `src/recovery/model.ts` | Jagan | Not modified |

## 3. Migrations (all additive)

Every migration runs inside `openDatabase` (`server/db.ts`) with `CREATE TABLE IF NOT EXISTS` and is idempotent. Nothing is dropped, renamed or rewritten. To roll back, deploy the previous build: old code ignores the new tables. The new tables can be dropped by hand only after a backup, and only with founder approval.

The concrete tables are listed in the technical handoff (`docs/workstream/HANDOFF-financial-foundation.md`).

## 4. SQLite pilot assessment (C0.6)

Current state: one `node:sqlite` `DatabaseSync` per server process, WAL mode, foreign keys on, `secure_delete` and `VACUUM` scrub for deletions, backup via `server/backup.ts`.

Single-writer pilot: **adequate**. Reasons:
- WAL allows concurrent readers while one writer commits. The server already serialises writes on a single Node event loop (synchronous driver).
- Pilot volumes are small. A 50k-row ledger import is a few seconds of synchronous inserts inside one transaction, measured in the C3 tests.
- Tenant isolation is enforced in queries (`tenant_id` on every row, every statement filters on it), not by the engine.

Limits that need a founder decision before scaling past a pilot:
1. **One process only.** There is no multi-instance writer coordination. Horizontal scaling needs Postgres or a single-writer service.
2. **Synchronous driver.** Long imports block the event loop. That is acceptable for a pilot. Beyond that, imports should move to the shared job runner (Jagan) or a worker thread.
3. **Durable jobs.** SQLite can host a jobs table with leases (single process). The runner itself is Jagan's, so this workstream only provides handlers.
4. **Backups.** `server/backup.ts` covers the file. Hosted backup/restore is a pilot gate that has not been exercised.

Recommendation: stay on SQLite for the pilot with additive migrations. Revisit Postgres before multi-instance hosting or more than one pilot customer at production volume. That is a founder decision; no infrastructure was introduced.
