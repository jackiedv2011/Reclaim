# Product intelligence (CPO workstream): integration report and execution ledger

**Branch:** `claude/pensive-thompson-rnchb6` · **Base:** `main` @ `b27ee30` · **Contract:** `src/intelligence/contracts.ts` `0.1.2` · **Date:** 25 Nov 2026
**Status:** verified locally on synthetic data only. Not merged, not deployed, not exercised with a live provider, real ledger or real customer. The read-only API is **off by default** (`RECLAIM_INTELLIGENCE_API=1` turns it on). No customer-facing screen was added or changed.

## 1. Execution ledger (P0–P7)

| Item | Status | Where | Evidence |
|---|---|---|---|
| P0 preflight and baseline | Verified locally | §4 below | Audit baseline reproduced exactly: 778 tests passed in 70 files; 5 live-server files failed to load |
| P0 test-harness repair | Verified locally | `870fac6` (cherry-picked `4de78bc` from `claude/busy-meitner-fnpiak`, not rewritten) | The 5 files now load; their 40 tests pass |
| P0 contracts, envelope, adapter, fixtures | Verified locally | `src/intelligence/{contracts,envelope}.ts`, `adapters/legacyAudit.ts`, `fixtures/synthetic.ts` | `legacyAudit.test.ts` |
| P1 covered spend and coverage | Verified locally (fixture / legacy-snapshot data) | `spend.ts`, `metrics.md` | `spend.test.ts`: hand-calculated per-currency totals |
| P1 account-wide recovery visibility | Verified locally | `recoveryVisibility.ts` | Cross-checked against `ladder()`, `vendorCommitments()`, `recoveryAging()`; remaining differences documented |
| P2 baselines, vendor profiles | Verified locally | `baselines.ts`, `vendorProfiles.ts` | Tests |
| P2 business memory | **Partial**: contract and reference store only; **persistence blocked on S-7** | `memory.ts`, `business-memory.md` | Tests; no HTTP write route |
| P3 insights and refresh handler | Verified locally; dismissals not persisted (S-7); runner integration pending J-4 | `insights.ts`, `insightRefresh.ts`, `insight-catalog.md` | Tests; forbidden-word scan |
| P4 attention queue and approval proposals | Verified locally against case state; authoritative approval objects pending J-2 | `attention.ts`, `attention-contract.md` | Tests plus end-to-end submission of a proposal to the real case-command route |
| P5 account assistant | Verified locally; external AI not authorized (gated off) | `assistant.ts`, `assistant-contract.md` | Tests (injection, forged IDs, refused actions) |
| P6 design brief, view models, design fixtures | Delivered; **visual implementation blocked on Aditya's design decisions D1–D10** | `design-brief.md`, `screen-inventory.md`, `viewModels.ts`, `fixtures/*.json` | Fixtures regenerate deterministically |
| P7 gated server API | Verified locally; wiring awaits CTO review (S-9) | `server/intelligence.ts`; 6 lines each in `server/app.ts` and `server/config.ts` | `server/intelligence.test.ts` |
| P7 synthetic end-to-end | Verified locally | `server/intelligence.e2e.test.ts` | Saved audit → evidence → approval proposal → real case command → send → promise → partial return → visibility; second tenant refused |
| P7 cross-workstream integration | **Blocked**: no financial-foundation or recovery-AI branch or contract exists yet | `interface-requests.md` | — |

## 2. What was built

All product-intelligence logic is pure, server-safe TypeScript in `src/intelligence/`. It uses only relative `.ts` imports, so the Node server can load it. It reads through three ports:
- `FinancialSourcePort` (Sid's ledger);
- `CaseReadPort` (Jagan's cases);
- `ReturnMatchPort` (Sid's return matching).

The **only implementation of those ports today is `adapters/legacyAudit.ts`**. It reads the tenant's saved audit snapshots and labels every answer `origin: 'legacy_audit_snapshot'` with the coverage limits that come with that source:
- the rows were supplied by the customer;
- the snapshots are not a continuous record;
- settlement is unverified;
- returns are not independently matched.

Replacing the adapter with the real services does not change any read model.

| Module | Version | Purpose |
|---|---|---|
| `contracts.ts` / `envelope.ts` | 0.1.2 | Tenant context, read-model envelope (coverage, freshness, sources, exclusions), source record, case snapshot, ports, money helpers |
| `spend.ts` | spend-v0.1 | Gross recorded AP payments per currency by payment date; refunds and credits apart; `net` undefined pending Sid; vendor, category and month views; uncovered months are null, not zero |
| `recoveryVisibility.ts` | recovery-v0.1 | Six per-currency figures, never summed; cross-audit copies counted once; matched returns *unavailable* |
| `baselines.ts` | baseline-v0.1 | Median, MAD and cadence per vendor and currency; minimum-sample rules; seasonality always reported as unsupported |
| `vendorProfiles.ts` | — | Recorded names, alias proposals and customer statements kept apart; never merges vendors |
| `memory.ts` | memory-v0.1 | Versioned, revocable, tenant-scoped corrections with history; narrowly scoped suppression *proposals* for the detection owner, never touching supported cases |
| `attention.ts` | attention-1 | One item per case needing attention, categorised and ordered; approval interactions produce typed proposals for the existing case-command route |
| `insights.ts` / `insightRefresh.ts` | insights-v0.1 | 9 deterministic rules; coverage insights instead of "all clear"; idempotent job handler for the shared runner; no scheduler |
| `assistant.ts` | account-assistant-v0.1 | 9 fixed intents; code-computed figures; validated citations; action proposals only |
| `aiGateway.ts` | — | The only AI seam; ships `DISABLED_AI_GATEWAY`; output validator; a test forbids provider SDK imports |
| `viewModels.ts` | view-models-v0.1 | UI state (ready / empty / partial / stale / not_covered), exact money formatting, draft copy |

Server (behind the flag; read-only, session-derived tenant, 300 reads per hour per user):
- **GET** `/api/intelligence/` + `attention`, `spend/summary`, `spend/vendors`, `spend/categories`, `spend/trend`, `coverage`, `recovery`, `recovery/vendors`, `vendors`, `vendors/:key`, `baselines`, `insights`.
- **POST** `/api/intelligence/assistant/ask`.

## 3. Ownership boundaries kept

- **Not built:** a ledger, matcher, return matching, tenancy or roles, schema migration, case state machine, approval backend, scheduler, inbound transport or AI provider path.
- **No new tables.** Shared entrypoints were touched only in the small flag-gated wiring commit.
- **Unchanged:** `server/assistant.ts` and every UI file.

## 4. Test evidence (local, serial, no credentials)

| Check | Baseline (`main` @ `b27ee30`) | This branch |
|---|---|---|
| `npx vitest run` | 778 passed in 70 files; **5 files failed to load** | FINAL_VITEST |
| `npx tsc -p tsconfig.app.json --noEmit` | 0 errors | FINAL_TSC_APP |
| `npx tsc -p tsconfig.server.json --noEmit` | 0 errors | FINAL_TSC_SERVER |
| `npx oxlint` | 0 errors (warnings only) | FINAL_OXLINT |
| `npm run build` | not run in audit | FINAL_BUILD |

Product-intelligence tests by file: FINAL_BREAKDOWN

No test was skipped, weakened or deleted. Tests changed after the first commit of a slice:
- **P1 recovery tests** that pinned two known gaps now assert agreement with the selectors, because contract 0.1.1 closed those gaps.
- **P1 spend tests** that pinned a false coverage gap (an adapter bug, now fixed) now assert that March is covered and June is partly covered.
- **One P3 assertion** changed from `single_user_session` to `job_runner` (section 6).

## 5. Metric and data semantics (see `metrics.md`)

- **Spend means recorded AP payments in the covered records.** It is not total company expenses, cash flow or profitability. Settlement is always unverified.
- **Cross-audit repeats** are counted once by an ordinal row identity. A truly identical second payment that also appears in another audit can be miscounted by one. Canonical identity (S-1) removes this.
- **Recovery figures** are never summed. "Customer-recorded return" is never called verified or matched, and "matched" stays null until S-5.
- **Unknown currency** stays `UNKNOWN`. It is never assumed to be USD (the existing selectors assume USD; documented).

## 6. Security and privacy

**Verified locally:**
- tenant derived from the session only;
- every port call re-checks the tenant;
- cross-tenant reads and actions are refused at the HTTP level;
- forged tenant hints in the query, the question text and the subject are ignored or refused;
- input validation (dates, limits, cursors, question length, subject shape, body size, JSON content type);
- no writes, sends or model calls;
- display names sanitised in assistant answers;
- AI off with a validator for any future output.

**Fixed during integration:** background refresh jobs had borrowed the signed-in-session source. Through `hasCasePermission`, that would have given a system job the implicit owner rights to approve and write cases. Jobs now run as `job_runner` with read-only permissions, and a test pins it.

**Open (not fixed here, owner noted):**
- Source rows are still browser-authored (audit S1, Sid).
- No organisations or separation of duties (S2, Sid).
- Plaintext localStorage cache and report-only CSP (S4, product security). The intelligence API adds no new browser cache.
- The Free-plan finding limit is client-side presentation only; the intelligence routes are not plan-gated (decision D3, founders).
- Each request decodes all of the tenant's audits. That is fine for a pilot, but needs caching or Sid's ledger before larger tenants.
- Thresholds are uncalibrated.
- Business memory and insight dismissals are not persisted (S-7).

Independent review: see section 10.

## 7. Founder and design decisions outstanding

1. **Release scope:** whether spending visibility, insights and the assistant reach customers (contract §5).
2. **Plan availability** (D3) and pricing.
3. **External AI:** whether any task is authorized, the tenant opt-in model, a zero-retention agreement with the provider. Everything is off today.
4. **Aditya's design decisions D1–D10** (`design-brief.md` §6), including correcting today's "Verified returned" and "Money that actually came back" labels on returns the customer typed in.
5. **Retention:** how long memory entries and dismissals are kept, and who may revoke in multi-user accounts.
6. **Thresholds** for insights and baselines (`insight-catalog.md`).

## 8. Interface requests (detail in `interface-requests.md`)

| Request | To | Asked for |
|---|---|---|
| S-1…S-9 | Sid | Source records, spend semantics, coverage, canonical vendor identity, return matching, detection-feedback intake, persistence migration, organisations and roles, entrypoint review |
| J-1…J-6 | Jagan | Case read service, pending-approval objects, command contract, job-runner interface, AI task API, assistant route ownership |

Also asked of Jagan:
- carry `classification`, `suppressed`, `promisedOutstandingMinor` and request generation in the case read;
- a dedicated reject command;
- send state on the case;
- a per-case revision.

## 9. Proposed merge and test sequence (for human review; nothing merged)

1. **Harness fix** `870fac6`: independent, test-only. Merge first; it restores 40 browser-level tests including the end-to-end recovery demo.
2. **Contracts, adapter and read models** (`src/intelligence/**`, `docs/product-intelligence/**`): additive and not imported by the app, so there is no runtime effect. Have Sid and Jagan review `contracts.ts` against their own designs before merging.
3. **Gated API** (`server/intelligence.ts`, plus 6-line `app.ts` and `config.ts` wiring): the CTO reviews (S-9) and keeps the flag off.
4. Before enabling the flag anywhere:
   - founder decisions 1–3;
   - S-7 persistence (if memory or dismissals are wanted);
   - the security gates in contract §5;
   - Aditya-approved UI.
5. **After each upstream service lands:** swap the adapter for the real port, run the same suites plus `server/intelligence.e2e.test.ts`, then regenerate the design fixtures (`UPDATE_DESIGN_FIXTURES=1`).

To reproduce:

```bash
npm ci
```

```bash
npx vitest run
```

```bash
npx tsc -p tsconfig.app.json --noEmit && npx tsc -p tsconfig.server.json --noEmit && npx oxlint
```

## 10. Independent review

REVIEW_SECTION

## 11. Pilot questions and metrics (after authorization only)

**Questions:**
- Can users find real opportunities and their evidence?
- Can they tell a supplier promise from money returned, and a customer-recorded return from a matched one?
- Do they understand "covered spending" and its gaps?
- Do they act on insights?
- Do they find and complete approvals?
- Do they trust the privacy controls?

**Metrics:**
- confirmed vs dismissed findings, and candidates reviewed;
- time to action;
- matched returns (once S-5 exists);
- insight usefulness ratings and corrections;
- comprehension checks;
- approval completion.

No data was collected and no outreach was done.

## 12. Resume instructions

The ledger above is current at the final commit on this branch. To continue:
1. Read `interface-requests.md` for upstream status.
2. Pick the next unblocked row in section 1.
3. Keep the "fixture is not an integration" rule: an item counts as integrated only after it runs against a real port.
