# Interface requests from the product-intelligence workstream

**From:** CPO workstream (Aditya) · **Contract version:** `src/intelligence/contracts.ts` `0.1.1` · **Base commit:** `b27ee30` (main)
**Status:** proposals awaiting owner sign-off. Nothing here is agreed. Until each item is agreed, the product-intelligence layer reads saved audit snapshots through `src/intelligence/adapters/legacyAudit.ts`, labelled `origin: 'legacy_audit_snapshot'`, and reports the gap as coverage `limited` / `upstream_contract_pending`.

Each request says what the consumer needs, not how the owner should build it. The read models depend only on the ports (`FinancialSourcePort`, `CaseReadPort`, `ReturnMatchPort`). Replacing the adapter does not change any read-model code.

---

## To Sid (financial foundation)

| # | Request | Why the consumer needs it | Interim behaviour |
|---|---|---|---|
| S-1 | **Tenant-scoped source records** with stable `recordId`, source system/account/import, native ID, kind (payment / refund / credit / void / transfer), integer `amountMinor`, explicit currency, source calendar dates, category / GL account, and normalization version. Same shape as `SourceRecord` in contracts.ts, or tell us the differences. | Spend, vendor profiles and baselines must not sum raw import snapshots (audit S1: rows are browser-authored today). | Adapter builds them from saved audits. Cross-audit repeats are counted once by an ordinal identity (see `docs/product-intelligence/metrics.md`). |
| S-2 | **Spending semantics decision**: cash (payment date) vs accrual (bill date); how voids, reversals, transfers, refunds and applied credits net; whether `net` is defined at all. | `spendSummary` returns `net: null` until you define it. We will not invent it. | Gross recorded payments plus refunds/credits reported separately. |
| S-3 | **Import coverage per tenant**: accepted / rejected rows with reason codes, mapping confirmations, dedup counts, per-check supported / limited / not-run, date range per source and account. | Insights must never treat missing data as a clean result. Trend months without an import must read as "not covered", not zero. | Built from `ImportBatch` (`recordCount`, `skippedCount`, `detectedColumns`) and record dates. |
| S-4 | **Canonical vendor identity**: `vendorKey` plus confirmed aliases, and an endpoint that accepts alias *proposals* (`vendor_alias_proposal` memory entries) for your review. | Vendor profiles show recorded names and proposals separately. They never merge vendors themselves. | `APRecord.canonicalVendorId` (supplier ID or normalized name hash). |
| S-5 | **Return matching** (`ReturnMatchPort`): proposed / verified / ambiguous / reversed matches against open requests, with source records and algorithm version. | "Matched return" stays a separate figure from "customer-recorded return". It is shown as *not available* until this exists. | `NO_RETURN_MATCHING`: `available: false`; coverage reason `no_independent_return_matching`. |
| S-6 | **Detection feedback intake**: accept narrowly scoped suppression *proposals* (`suppressionProposals()` in `src/intelligence/memory.ts`) and decide whether to apply them under your deterministic controls. | Dismissals and "this is intentional" corrections should reduce repeat false alarms without the CPO layer touching detection. | Proposals are produced and tested. Nothing is applied. |
| S-7 | **Persistence migration** for business memory (proposed DDL in `docs/product-intelligence/business-memory.md`), and for insight dismiss state. Include both in account export and delete (`server/account.ts`). | Memory is in-memory only today. No write route is exposed until it persists. | `InMemoryFeedbackStore` for tests; no HTTP write route. |
| S-8 | **Organisations and roles** to replace `TenantContext.source = 'single_user_session'`. | Permissions such as `cases:approve` (separation of duties) cannot exist until then. | Tenant = user; actor = same user; fixed permission set. |
| S-9 | **Shared entrypoints**: approve the small, flag-gated wiring of `server/intelligence.ts` in `server/app.ts` and `server/config.ts` (separate commit on this branch; flag `RECLAIM_INTELLIGENCE_API`, default off). | Read models need a server-derived tenant context. | Off by default; easy to drop the commit. |

## To Jagan (recovery orchestration, jobs, AI)

| # | Request | Why | Interim behaviour |
|---|---|---|---|
| J-1 | **Case read service** returning `CaseSnapshot` (or your equivalent) per tenant, with revision, request generation and the amounts kept separate (supported potential, approved request, promised, customer-recorded return, outstanding). | Account-wide recovery visibility and the attention queue. | Adapter derives snapshots from saved case states with the existing `src/recovery/*` functions. |
| J-2 | **Pending approval / action objects**: one per exact outbound package (subject, body, recipient, attachment hash, amount, revision), plus follow-up and settlement-acceptance approvals, with status and policy. | The approval inbox must present your objects, not recompute them. | `attention.ts` derives items from case state. Coverage says `upstream_contract_pending` and that uncertain Gmail sends are not visible in snapshots. |
| J-3 | **Command endpoint contract** for approve / reject / request-evidence from the inbox: same revision and `commandId` idempotency as `/api/projects/:id/case-commands`. | The inbox produces typed *proposals* (`proposeApprovalAction`). It never executes them itself. | Proposals point at the existing case-command route and action names. |
| J-4 | **Job runner handler interface** (tenant, operation, idempotency key, checkpoint, bounded error, audit event). | Insight refresh must run on your runner, not a second scheduler. | `refreshInsightsHandler` implements the proposed interface. A fixture runner drives it in tests. |
| J-5 | **AIExecutionService task API**: task registry, per-task packet allowlist, tenant AI policy (off / drafting only / full), invocation log. | Optional natural-language summaries for insights and the assistant must go through your gateway only. | `AiGatewayPort` with a `DISABLED_AI_GATEWAY` default. The deterministic path is the only path. |
| J-6 | **Assistant route ownership**: the existing `/api/assistant/ask` (case-scoped, `server/assistant.ts`) stays yours. The account-scoped intents are added as a separate module (`src/intelligence/assistant.ts`) and route. | Avoid two owners editing one file. | Separate module and route behind the same flag. |

## Founder decisions needed (not engineering)

1. **Release scope** of spending visibility (contract §5: "broad spend dashboard"). The read models exist; whether customers see them is undecided.
2. **Plan availability** of intelligence features (Free / Growth / Flat). The routes are not plan-gated today and are off by default.
3. **External AI opt-in** for insight summaries and assistant interpretation. Off by default; no provider path in this workstream.
4. **Wording** of customer-facing metric names (see `metrics.md` definitions). Product language belongs to Aditya.
