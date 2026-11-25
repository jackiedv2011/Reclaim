# Insight catalog (P3)

**Owner:** CPO workstream (Aditya) · **Engine version:** `insights-v0.1` · **Contract:** `src/intelligence/contracts.ts` `0.1.1` · **Document version:** 0.1 (25 November 2026)
**Status:** proposal, implemented and tested against synthetic fixtures and the legacy-audit adapter only. Not wired to a route, not persisted, not validated on customer data. Wording is engineering copy pending Aditya's product-language review.

Code: `src/intelligence/insights.ts` (engine, dismiss store), `src/intelligence/insightRefresh.ts` (job handler, snapshot cache, fixture runner). Tests beside each.

---

## 1. Principles

- **Rules first, deterministic.** Each insight is a pure function of read-model envelopes this workstream already ships. Same inputs, same dismiss state and same `now` give byte-identical output. No model is needed for any insight.
- **No new money.** Every amount on an insight (`figures[]`) is copied from a read model and cites it (`source.model`, `source.field`, `source.metricDefinitionVersion`). Figures of different lifecycle stages or currencies are listed separately, never summed.
- **Careful wording.** Insights describe "the covered records" or "the saved case state". They never say fraud, overcharge, owed, verified, all clear, no issues or price increase (a test scans every insight produced by every test scenario). Every insight carries one `limits` sentence saying what it does not show.
- **No clean bill of health.** Coverage problems are always surfaced as `import_coverage_gap` insights. When no other insight is active, the engine adds a `checks_limited` insight listing the limited checks. An empty list reports `emptyState` (`no_data` or `none_met_thresholds_in_covered_records`), never "nothing wrong".
- **Safe next actions.** `nextAction` is a typed navigation hint (`review_vendor`, `open_case`, `open_attention`, `request_records`, `review_import_coverage`, `review_finding`, `review_prevention`) with `sideEffects: 'none'`. Nothing executes.
- **Memory is shown, never applied.** `influencedBy` lists the in-effect business-memory entries touching the subject (`memory.influenceFor`). Memory can lower a severity (with the entry ID in `severityReason`); it never hides an insight.

## 2. Insight shape (summary)

`id` (`ins_<rule>_<12 hex>`, hash of tenant + `dedupKey`), `dedupKey` (`<rule>|<subject>|<period>`), `tenantId`, `rule`, `ruleVersion` (`<rule>@<n>`), `severity` + `severityReason`, `title`, `explanation`, `limits`, `subject` (`vendor` / `case` / `import` / `account`), `period` (`from`, `to`, `dataAsOf` = newest covered payment date, `computedAt`), `figures[]`, `measures[]` (counts, days, basis points, each citing its source), `sourceRefs[]` (≤ 50, with `sourceRefCount` and `sourceRefsTruncated`), `coverage[]` (the consumed read models' coverage items), `freshness`, `provenance` (engine and contract versions, origin, read models + metric versions), `nextAction`, `influencedBy[]`, `evidenceFingerprint`, `status` (`active` / `dismissed` / `expired`), `expiresAt`, `dismissal`, `previousDismissal`, `advisorySummary` + `ai`.

## 3. Ordering, paging, counts

Order (`compareInsights`): status (active, expired, dismissed) → severity (high, medium, low) → rule priority (table below) → first figure: insights with a figure first, by currency code, larger amount first within a currency (never compared across currencies) → `id`.

`limit` 1–200 (default 25), `cursor` = opaque `o:<offset>`; malformed values are refused (`IntelligenceQueryError`). Dismissed insights are hidden by default (`includeDismissed`) and counted in `suppressedByDismissal`; expired ones are listed after active ones (`includeExpired`, default true). `countsByRule` / `countsBySeverity` cover the listed set; `countsByStatus` covers everything generated.

Severity scale: **high** = time-sensitive action on a supplier request; **medium** = a review is recommended; **low** = visibility or guidance.

## 4. Rules

### 4.1 `vendor_spend_above_baseline` @1 · priority 5

| | |
|---|---|
| Trigger | A vendor/currency with an **established** baseline (`baselines.ts`: ≥ 5 dated payments over ≥ 3 months, known currency) has at least one payment dated in the latest `ABOVE_BASELINE_LOOKBACK_DAYS` = **60** days up to the newest covered date that `compareToBaseline` labels `above_range` (above median + max(3·MAD, 5% of median)). |
| Never | Insufficient history, UNKNOWN currency, below-range or within-range payments. |
| Severity | medium when the highest such payment is ≥ `ABOVE_BASELINE_MEDIUM_RATIO_BPS` = 20000 bps (2×) of the median, else low. Low whenever an in-effect `intentional_payment` memory entry covers every above-range payment (entry ID in the reason). |
| Wording | "Payments to {vendor} in the covered records were above its usual range" · "In the covered records, {n} payment(s) to {vendor} in the latest 60 days of covered data … The highest was {amount} on {date}, about {x} times the median payment of {median} (usual range up to {upper}, from {n} payments over {m} months). This compares amounts only." |
| Figures | Each above-range payment (`source_records.amountMinor`), median and upper bound (`vendor_baselines`, `baseline-v0.1`). Measure: ratio in bps. |
| Coverage | `vendor_baselines`, `seasonal_comparison` (always not run in v0.1). |
| Next action | `review_vendor {vendorKey}` |
| Limits | Compares amounts with the vendor's own covered history; does not show why, what was bought, or whether the payment was right. |
| Dismissal holds while | the same above-range record IDs and amounts and the same in-effect memory. Period key = currency + month of the latest above-range payment, so a later month is a new insight. |
| Expires | 120 days after the latest above-range payment date. |

Note: the baseline includes the compared payments (robust median/MAD), which makes the rule conservative.

### 4.2 `recurring_payment_visible` @1 · priority 9

| | |
|---|---|
| Trigger | A detector recurring series (`FinancialSourcePort.listRecurringSeries`) none of whose payments is part of an open, unsuppressed case. Series repeated across saved audits are folded per vendor + currency + amount (latest-ending kept; all series IDs cited). |
| Severity | Always low (visibility). |
| Wording | "Recurring payment to {vendor}, about every {n} days" · "In the covered records, {vendor} was paid {amount} about every {n} days ({k} payments, {first} to {last}). The detector treats this as recurring and does not flag it. Review it if you no longer expect it." |
| Figures | Series amount. Measures: cadence days, payment count. |
| Next action | `review_vendor` |
| Limits | A repeating pattern only; not whether the service is still used or the amount matches an agreement. |
| Dismissal holds while | the vendor, amount and cadence are unchanged (a new month of the same payment does not reopen it). |
| Expires | 120 days after the series' last payment. |

### 4.3 `vendor_concentration` @1 · priority 8

| | |
|---|---|
| Trigger | A `spend.by_vendor` row whose `shareOfCurrencyBps` ≥ `CONCENTRATION_SHARE_BPS` = **4000** (40%) in a currency with ≥ `CONCENTRATION_MIN_VENDORS` = **3** vendors. Never UNKNOWN currency. |
| Severity | Always low (context, not a problem). |
| Wording | "{vendor} received {p}% of covered {CUR} payments" · "…were {gross} of {currency total} paid in {CUR} ({p}%), across {n} vendors. This shows where covered payments went." |
| Figures | Vendor gross and currency total (`spend.by_vendor`, `spend-v0.1`). Measure: share bps. |
| Coverage | `covered_spend` (includes `settlement_unverified`). |
| Next action | `review_vendor` |
| Limits | Imported AP payments only; not total company spending; says nothing about whether the share is appropriate. |
| Dismissal holds while | the share stays in the same 10-percentage-point band. |
| Expires | 120 days after the newest covered date. |

### 4.4 `vendor_change` @1 · priority 6

| | |
|---|---|
| Trigger | A vendor profile `recentChange` entry with `status: 'computed'` (both 90-day windows inside one covered interval), prior window with ≥ `VENDOR_CHANGE_MIN_PRIOR_PAYMENTS` = 2 payments, and \|change\| ≥ `VENDOR_CHANGE_THRESHOLD_BPS` = **5000** (50%). |
| Never | `window_not_covered`, `insufficient_history`, prior total 0, UNKNOWN currency. |
| Severity | medium when ≥ `VENDOR_CHANGE_MEDIUM_BPS` = 10000 (doubled) higher; otherwise low (including decreases). |
| Wording | "Payments to {vendor} in the covered records were higher/lower in the latest 90 days" · "…were {recent} ({n} payments) from {from} to {to}, against {prior} ({m}) from {from} to {to}: {p}% higher/lower. This compares totals only." |
| Figures | Recent and prior window totals (`vendor_profiles`, `vendor-profile-v0.1`). Measures: change bps, payment counts. |
| Coverage | `recent_change`. |
| Next action | `review_vendor` |
| Limits | Two equal covered windows; does not show why (volume, timing, terms). |
| Dismissal holds while | both window totals are unchanged. Period key = currency + recent-window end. |
| Expires | 120 days after the recent window ends. |

### 4.5 `import_coverage_gap` @1 · priority 4 (always surfaced)

One insight per condition (from `spend.import_coverage`, `spend.summary` and the caller's unreadable-audit list):

| Period key | Trigger | Severity | Next action |
|---|---|---|---|
| `no_data` | No records and no imports. "No covered records yet … no payment checks could run. Nothing has been reviewed yet." | medium | `request_records` |
| `unreadable_audits` | `unreadableAuditIds` non-empty. | medium | `review_import_coverage {auditIds}` |
| `period_gaps` | Gaps between merged import date ranges. | medium if any gap ≥ `COVERAGE_GAP_MEDIUM_DAYS` = 31, else low | `request_records {first gap}` |
| `rejected_rows` (subject = import) | `rejectedRows > 0` in an import. | medium if ≥ `REJECTED_ROWS_MEDIUM_BPS` = 500 (5%) of its rows, else low | `review_import_coverage {importId}` |
| `undated_imports` | Imports with no dated rows. | low | `review_import_coverage` |
| `missing_currency` | Rows in the UNKNOWN currency bucket. | low | `review_import_coverage` |
| `stale_data` | `spend.import_coverage` freshness stale (newest import older than 35 days by default). Text says insights are historical, not current monitoring. | medium | `request_records {from: covered end}` |
| `checks_limited` | Fallback: no non-coverage insight is active and at least one rule check is limited or not run. "No insight met its threshold in the covered records, but that is not a confirmation that payments are in order. {n} checks ran with limits or could not run: …" | low | `review_import_coverage` |

Limits differ per condition (e.g. "A gap may be a quiet period with no payments; the covered records cannot tell the difference."). Dismissal holds while the condition's facts (gap list, rejected counts, newest import time, unreadable IDs, limited checks) are unchanged. Condition-based: no expiry.

### 4.6 `unresolved_recovery` @1 · priority 3

| | |
|---|---|
| Trigger | A deduplicated case (`foldCases`) that is a vendor claim at stage `requested` with `outstandingMinor > 0` and any of: request older than `UNRESOLVED_AGE_DAYS` = **30** days; latest supplier position `disputed` or `partial_acceptance`; a customer-recorded return > 0 (partial); request date unknown. Age uses the same local-calendar-day rule as `selectors.recoveryAging`. |
| Severity | high when older than `UNRESOLVED_HIGH_AGE_DAYS` = 60 days; medium when older than 30, disputed/partial, or partly returned; low when the date is unknown. |
| Wording | "Request to {vendor} still open after {n} days" · "In the saved case state, the {type} request to {vendor} was sent {n} days ago and {outstanding} is still open on it." + optional supplier position, "You recorded {x} coming back; it has not been matched to a bank or accounting record.", "The supplier said it would return {y}; that is a statement, not money received." |
| Figures | Still open (`approvedOutstanding`), promised, customer-recorded returns: separate figures citing `recovery.overview` / `recovery-v0.1` (`caseContributions`). Never summed. |
| Coverage | `recovery_cases`, `promised`, `matched_returns` (not run while return matching is unavailable). |
| Next action | `open_case {caseId}` |
| Limits | Saved case state only; replies or payments not recorded in Reclaim are not visible; returns are not matched. |
| Dismissal holds while | the age bucket (≤30 / >30 / >60), dispute, partial flag, outstanding, supplier position and recorded return are unchanged. Period key = request generation. |
| Expires | Condition-based. |

### 4.7 `approvals_due` @1 · priority 1 and `follow_ups_due` @1 · priority 2

| | approvals_due | follow_ups_due |
|---|---|---|
| Trigger | `attentionQueue` items in category `requires_approval` | items of kind `follow_up_due` / `follow_up_overdue` |
| Severity | high when ≥ `APPROVALS_HIGH_COUNT` = 5, else medium | high when any is overdue (> 3 days past due, `OVERDUE_GRACE_DAYS`), else medium |
| Wording | "{n} supplier request(s) are waiting for your approval" · "…Approving does not send anything; each request is sent as a separate step." | "{n} supplier follow-up(s) are due" · "{d} reached their date and {o} are more than 3 days past it." |
| Figures | None (counts only, as measures citing `attention_queue` / `attention-1`). Amounts of different kinds are not mixed into one figure. |
| Next action | `open_attention {category: requires_approval}` | `open_attention {kinds: [follow_up_due, follow_up_overdue]}` |
| Limits | Derived from saved case state, not an approval service; may need revalidation. | Follow-up dates only; messages outside Reclaim are not visible. |
| Dismissal holds while | the set of attention item IDs is unchanged (item IDs embed the case revision). | the item IDs and their due/overdue kinds are unchanged. |

### 4.8 `prevention_guidance` @1 · priority 7

| | |
|---|---|
| Trigger A | ≥ `PREVENTION_MIN_ROOT_CAUSES` = 1 reconciled case of a finding type with a recorded `rootCause`. |
| Trigger B | ≥ `PREVENTION_MIN_REPEATED_DISMISSALS` = 3 dismissed cases with the same finding type and dismissal tag. |
| Severity | Always low (guidance). |
| Wording A | "A prevention step to consider for {type}s" · "You recorded a cause for {n} reconciled {type} case(s) in the covered records ("{cause}" {k}, …). {guidance}" where guidance is static per type (`PREVENTION_GUIDANCE`), e.g. duplicate → "Consider checking duplicate-bill warnings in your accounting system, if it offers them, before each payment run." Never claims the setting exists or is off. |
| Wording B | intentional / known exception → recording vendor context helps the next review; not a match / detection error → passed on as feedback about the check; always "nothing is suppressed automatically". |
| Evidence | Case IDs; `influencedBy` lists the derived `dismissal:<caseId>` memory entries. |
| Next action | `review_prevention {findingType}` |
| Limits | General guidance; does not know the accounting system's settings or existing controls. / Counts your own dismissals; does not judge them or change any check. |
| Dismissal holds while | the contributing cases (and causes) are unchanged. |
| Expires | 365 days after the latest reconciliation / dismissal. |

## 5. Dismissal and expiry

- `InsightStateStore` (reference: `InMemoryInsightStateStore`) is tenant-partitioned. `dismiss` needs `feedback:write` and a 1–500 character reason; reads need `financial:read`. `dismissInsight(ctx, deps, insightId, reason, now, {ttlDays})` looks the insight up and stores its `dedupKey` and `evidenceFingerprint`.
- A dismissal hides the insight only while **(a)** the current evidence fingerprint equals the stored one and **(b)** the dismissal has not expired (default 90 days, max 365). Otherwise the insight is active again with `previousDismissal.invalidatedBecause` = `evidence_changed` or `dismissal_expired`, and the envelope warns `dismissals_invalidated`.
- The fingerprint covers the rule version, the rule's evidence (section 4) and the in-effect memory IDs. A reimport (new record IDs), a correction, a new or revoked memory entry or a changed case therefore re-shows a dismissed insight.
- `expired`: data-anchored insights (`INSIGHT_TTL_DAYS`) become historical when `now ≥ expiresAt`; they stay listed, after active ones, labelled `expired`. Persistence of dismissals is part of interface request S-7.

## 6. Refresh semantics (`insightRefresh.ts`)

- **Handler interface** (proposed for Jagan's runner, J-4): `JobHandler<I, O> { operation; run(JobContext<I>) → JobOutcome<O> }`, `JobContext = { tenantId, actorId | null, operation, idempotencyKey, attempt, checkpoint, now, input }`, `JobOutcome = { status: succeeded | retry | failed, output?, checkpoint?, error?: { code, message }, auditEvent }`.
- **`refreshInsightsHandler`** (`operation: 'insights.refresh'`, input `{ trigger, tenantId?, maxInsights? }`):
  - validates the envelope and input; an input `tenantId` different from the job's is refused (`tenant_mismatch`);
  - idempotent: same key + same input → stored outcome replayed (`auditEvent.replayed: true`, no reads); same key + different input → `idempotency_conflict`; only terminal outcomes are stored;
  - an actor-initiated job needs `authorizeActor(tenant, actor)` to return true (`forbidden` otherwise); runner jobs use `SYSTEM_ACTOR_ID`;
  - builds the context from the job tenant (`jobTenantContext`: `financial:read`, `cases:read`, `insights:refresh` only); a loader that returns another tenant's ports is detected by the ports and refused (`tenant_mismatch`), nothing is written;
  - read-only; bounded (`maxInsights` ≤ 200); **never calls AI** (no automatic external processing);
  - errors thrown by ports → `retry` until `maxAttempts` (default 3), then `retries_exhausted`; access/validation errors fail at once. Error messages are fixed strings; audit events carry counts only (no amounts, vendor names or record details).
- **Snapshot cache** (`InsightSnapshotStore`, in memory): latest envelope per tenant with `generatedAt` and `inputsFingerprint` (records, imports, overlap, series, cases, return matches, memory status at `now`, dismissals, unreadable audits). A refresh reuses the snapshot when the fingerprint matches and it is younger than 24 h (`reusedSnapshot: true`).
- **`readInsights`** returns the cached envelope with `stale` + `staleReasons` (`never_generated`, `inputs_changed`, `older_than_threshold`) and, separately, `historical` (the covered records themselves are old: the insights describe the past, not current monitoring).
- **Manual refresh**: `refreshInsightsNow(ctx, …)` needs `insights:refresh`; same work, same result as the job.
- **`FixtureJobRunner`** is a FIXTURE: it runs one job's attempts in sequence inside the call. No timers, no queue, no background service.

## 7. Optional AI summaries and the evaluation plan

Mechanics: `generateInsights` (async) may attach an `advisorySummary` only when `deps.ai` is enabled **and** the tenant policy is not `off`, for at most 10 active items on the returned page. The packet (`aiPacketFor`) holds the rule's static description, severity, figure labels (dates replaced), figure amounts as plain decimals, currencies, measures and the limits sentence: no vendor names, record IDs or dates. Output is rejected when `rejectUnsupportedAiText` finds a number, link, address or citation not in the packet, or when it contains a forbidden claim word (`unsupported_claim_wording`). Gateway errors read as `unavailable`. Deterministic fields are identical with and without AI (tested). The default `DISABLED_AI_GATEWAY` changes nothing. Background refresh never requests AI.

**Evaluation before enabling** (synthetic data only until founders and customers authorize otherwise):

1. **Question.** Do AI summaries make insights more useful than the deterministic explanation alone, without reducing accuracy or trust?
2. **Corpus.** A versioned synthetic set (≥ 200 insights covering all nine rules, all severities, coverage-limited cases, mixed currencies, memory-influenced and intentional-downgraded cases), generated from fixture ledgers like `src/intelligence/fixtures/synthetic.ts`. No customer data.
3. **Automatic gates** (must pass on 100% of outputs before any human study): validator pass rate; zero invented numbers, causes, amounts or actions; zero forbidden claim words; citation only to the insight; no meaning reversal (a reviewer rubric item, double-coded).
4. **Blind comparison.** Reviewers (internal first; customer participants only after consent) see deterministic-only vs deterministic + summary in random order and rate: comprehension (can they state what the insight shows and what it does not?), actionability (do they pick the right next action?), perceived accuracy, and time to decide. Pre-register the success threshold (e.g. comprehension and correct-action rates improve by ≥ 10 points with no drop in accuracy ratings).
5. **Decision.** If thresholds are not met, AI summaries stay disabled. If met, enabling remains a founder decision per tenant policy, with Jagan's gateway logging and a kill switch. Re-run after any rule wording or model change.

## 8. Codes and contract notes

- New reason / warning codes (string literals in `insights.ts`): `insight_input_truncated` (a paged input stopped at its bound), warning `dismissals_invalidated`, exclusion `dismissed_by_user`. Refresh error codes: `invalid_job`, `invalid_input`, `tenant_mismatch`, `tenant_not_found`, `forbidden`, `idempotency_conflict`, `transient_failure`, `retries_exhausted`.
- **Contract request:** `TenantContext.source` has no job value. Jobs currently use `'single_user_session'` with a read-only permission set and a system actor (`jobTenantContext`). Proposed: add `'job_runner'` (and a system actor convention) in contract 0.1.2.
- Amounts are formatted with two decimals for every currency, matching the adapter's `toMinor` (hundredths). A zero-decimal currency would need a minor-unit table from the financial-foundation owner.

## 9. Known limitations

- Fixtures and the legacy snapshot adapter only; every insight from saved audits carries `customer_supplied_source` and `snapshot_not_continuous`.
- `influenceFor` is evaluated per subject, which re-resolves memory each time (acceptable at fixture scale; batch resolution is a later optimisation).
- Dismissals and snapshots are in memory only (S-7). No HTTP route is wired.
- Thresholds are CPO proposals, not calibrated on real data; changing any bumps the rule version.
- Recovery ages and due dates use the process time zone (as `selectors.recoveryAging` and `status.ts` do).
