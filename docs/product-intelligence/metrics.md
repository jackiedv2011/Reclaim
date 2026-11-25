# Product-intelligence metric definitions

**Owner:** CPO workstream (Aditya) · **Contract:** `src/intelligence/contracts.ts` `0.1.0` · **Document version:** 0.1 (25 November 2026)
**Status:** proposal. The spending semantics below are a CPO proposal **pending CTO (Sid) agreement**; the recovery semantics consume Jagan's case model through `CaseReadPort` and are pending his review. Nothing here is a customer-facing claim, and nothing here has been validated on real customer data.

Every read model returns a `ReadModelEnvelope` whose `metricDefinitionVersion` names the version of the definitions in this file. **Any change to what a figure means bumps that version** and adds a row to the changelog at the bottom. Code: `src/intelligence/spend.ts` (`spend-v0.1`) and `src/intelligence/recoveryVisibility.ts` (`recovery-v0.1`).

## Rules that apply to every metric

- **Money** is integer minor units plus an ISO currency code. Figures in different currencies are reported side by side and are **never added together or converted**. A row with no recognisable currency is reported in its own `UNKNOWN` bucket with coverage reason `missing_currency`. More than one currency in a result adds `mixed_currency`.
- **Coverage** is always explicit. A result is `supported`, `limited` (with reason codes) or `not_run`. Missing data never becomes a zero or a "no issues" result. Data read through the legacy adapter always carries `customer_supplied_source` and `snapshot_not_continuous`.
- **Tenant and actor** come from the server session (`TenantContext`). Spend models require `financial:read`; recovery models require `cases:read`. Another tenant's context is refused (`IntelligenceAccessError`, `tenant_mismatch`).
- **Determinism**: the same inputs and the same `now` give byte-identical output. Ties are broken by ordinal (not locale) string comparison.
- **Wording**: figures describe "the covered records". They never say "fraud", "you are owed", "price increase", "all clear", or "verified" (unless a return is independently matched).
- **Pagination** (breakdown models): `limit` 1–100 (default 25); `cursor` is the opaque `nextCursor` from the previous page. A malformed limit or cursor is refused (`IntelligenceQueryError`, `invalid_query`).

## Cross-audit overlap (ordinal identity)

Today each saved audit is a separate snapshot, and a customer often uploads overlapping files. The legacy adapter (`src/intelligence/adapters/legacyAudit.ts`) gives each source row an identity:

- with a source transaction ID: `ext|<account>|<transaction id>`;
- otherwise a fingerprint: `fp|<normalized vendor>|<invoice reference>|<payment calendar date>|<amount in minor units>`;
- plus `#n`, the row's ordinal among rows with the same base **within its own audit**.

Within one audit, two identical rows stay two payments (that is exactly what the duplicate-payment check looks for). Across audits, the same identity *and ordinal* is the same row seen again, and is counted once (the first audit by ID keeps it). `FinancialSourcePort.overlapCount` reports how many rows were folded. Spend models report it as exclusion `cross_audit_overlap` plus warning `cross_audit_overlap_counted_once`.

Known limit: if a later file contains the same payment more times than an earlier one (or a genuine repeat payment that also appears in another audit), the ordinal rule can count one too many or one too few. Sid's canonical source identity (interface request S-1) replaces this.

Cases follow the same rule: `crossAuditKey` = finding type + the sorted identities of its source rows. See "Case deduplication" below.

---

## Spending (`spend-v0.1`)

### What "spend" means here

**Recorded AP payments in the covered records**: payment rows the tenant imported, dated by the payment date the source recorded.

It is **not** total company expenses (payroll, card spend, accruals and anything not imported are absent), **not** cash flow (settlement is unknown and nothing is matched to a bank), and **not** profitability. It is only as complete as the imports that cover the period.

### Inclusion and exclusion rules (all spend models)

| Source row | Treatment |
|---|---|
| `kind: 'payment'`, amount > 0 | Included in **gross payments**. |
| `kind: 'refund'` or `'credit'`, amount ≠ 0 | Included in **recorded refunds and credits**, as an absolute value. Never subtracted from gross. |
| amount = 0 (any kind) | Excluded, code `zero_amount`. |
| `kind: 'unknown'` (a negative amount with no type, or a type such as void, reversal or transfer) | Excluded, code `unclassified_transaction`; amounts reported signed as recorded. |
| No payment date, in a dated view (a `from`/`to` range is set, or the trend) | Excluded, code `missing_payment_date`; coverage `missing_dates`. In an all-time summary or breakdown (no range) the row is included. |
| Payment date outside the range | Out of scope (not an exclusion). |
| Repeated in another saved audit | Counted once; exclusion `cross_audit_overlap` (count only) and a warning. |

Precedence per row: missing date (dated views) → outside range → kind and amount.

**Settlement**: every source row today has `settlement: 'unknown'` (CSV rows and QuickBooks bill payments carry no cleared status). Every spend result therefore carries coverage reason `settlement_unverified`.

**Date basis**: `payment_date`, the calendar date in the source cell. The adapter re-parses the raw cell rather than trusting the stored instant, so a server in another time zone lands on the same day. When the raw cell is missing, the date is read from the stored instant and the result carries warning `calendar_date_from_instant` (may be a day off). Ranges are inclusive calendar dates `YYYY-MM-DD`; an invalid date or `from > to` is refused.

**Net**: `net` is always `null`, with `netUnavailableReason`, and coverage item `net_spend` is `not_run` / `upstream_contract_pending`. Net is Sid's definition to make (see open questions).

**Period coverage**: import date ranges (from `ImportCoverage.dateRange`, the earliest and latest payment date of each import) are merged into covered spans.
- If a requested period overlaps no span and has no rows: `result: null`, coverage `not_run` / `period_not_covered` (never a zero).
- If part of the period lies outside every span: coverage reason `period_partially_covered`.
- Rejected rows in any import add `rejected_rows`.

**Freshness**: `sourceUpdatedAt` is the newest import time (or a caller-supplied value). Stale when older than 35 days (`DEFAULT_STALE_AFTER_MS`).

**Caller-known limits**: callers pass reasons the port cannot see (for example saved audits that could not be read) through `options.extraCoverageReasons`; they are added to the main coverage item.

### Metrics

| Model / figure | Definition |
|---|---|
| `spendSummary` · `gross` | Per currency, the sum of included payment rows dated in the period. |
| `spendSummary` · `recordedRefundsAndCredits` | Per currency, the sum of absolute values of included refund and credit rows dated in the period. Reported beside gross, never netted. |
| `spendSummary` · `net` | Always `null` in v0.1. |
| `spendSummary` · `paymentCount`, `refundAndCreditCount` | Number of included rows of each kind. |
| `spendSummary` · `vendorCount` | Distinct vendor keys with at least one included payment (refund-only vendors are not counted). Also given per currency. |
| `spendByVendor` row | One row per (vendor key, currency): gross, payment count, refunds and credits, first and last payment date, share of that currency's gross in basis points, source record IDs (first 50 by ID, plus the full count and a truncation flag). |
| `spendByVendor` · `displayName` | The most frequent recorded name for the vendor key among in-scope rows; ties go to the alphabetically first. The vendor key is the adapter's deterministic key (supplier ID or normalized name hash), not a reviewed identity. |
| `spendByCategory` row | One row per (category, currency). Category is the recorded value, trimmed, grouped case-insensitively, displayed in its most frequent spelling. Rows with no category form an `Uncategorized` bucket (`uncategorized: true`, `categoryKey: null`) and add coverage `missing_category`. No category is inferred. |
| `shareOfCurrencyBps` | `round_half_up(row gross × 10000 ÷ currency gross)` with exact integer arithmetic. Shares are only within one currency and may not sum to exactly 10000. |
| Row ordering | Currency, then gross descending, then key (uncategorized last on a tie). |
| `spendTrend` | Calendar months (only `month` granularity). The axis is the requested range, or the extent of covered spans and dated rows (at most 120 months; an explicit longer range is refused, an open-ended one keeps the latest 120 with warning `trend_truncated`). Each month is `covered` when any import's date range overlaps it. **A month that is not covered and has no rows reports `null` amounts, not zero.** One series per currency; months covered but without rows for that currency report 0. |
| `importCoverageSummary` | Each import (system, accepted and rejected rows, date range, import time), totals, systems, covered date range, merged covered spans, **gaps** between spans, imports with no dated rows, cross-audit overlap rows, newest import time. |

### Exclusion, warning and coverage codes added by `spend.ts`

- Exclusions: `missing_payment_date`, `zero_amount`, `unclassified_transaction`, `cross_audit_overlap`.
- Warnings: `cross_audit_overlap_counted_once`, `calendar_date_from_instant`, `trend_truncated`.
- Coverage reasons (new): `period_not_covered`, `period_partially_covered`. Shared reasons used: `no_data`, `customer_supplied_source`, `snapshot_not_continuous`, `settlement_unverified`, `missing_dates`, `missing_currency`, `mixed_currency`, `missing_category`, `rejected_rows`, `upstream_contract_pending`.

### Open questions for Sid (spending)

1. **Net**: is there a "net spend" at all? If so, which refunds and applied credits offset which payments, and in which period (the refund's date or the original payment's)?
2. **Cash vs accrual**: v0.1 uses the payment date (cash basis, settlement unknown). Should a bill/invoice-date (accrual) view exist, and from which source fields?
3. **Settlement**: when will a cleared/settled status exist (QuickBooks, bank feed)? Until then every figure is `settlement_unverified`.
4. **Transfers, voids and reversals**: what record kinds will the canonical ledger expose, and should a void or reversal remove its original payment from gross (it does not today; the reversing row is only excluded)?
5. **Canonical identity**: replace the ordinal cross-audit identity with source identity, and say how a genuine repeat payment is distinguished from a re-import.
6. **Account scope**: should spend be split by source account / bank account, and how is "coverage" defined per account?
7. **Categories**: is there an authoritative GL account / category mapping to prefer over the free-text CSV category?

---

## Recovery visibility (`recovery-v0.1`)

### Case deduplication

Snapshots are grouped by `crossAuditKey`. One snapshot per key is kept, by stage rank (higher wins):

`recovered` 7 > `requested` 6 > `not_recovered` 5 > `confirmed` 4 > `dismissed` 3 > `needs_info` 2 > `unreviewed` 1; ties go to the lowest `caseId` (ordinal).

Why: a recorded return is the most informative state; an open request outranks a closure seen in another copy so recorded partial returns and outstanding balances are never hidden; a human dismissal outranks only undecided copies. Folded copies are reported in `result.dedup`, exclusion `cross_audit_overlap`, warning `cross_audit_cases_folded`, and, when the copies disagree on stage, warning `cross_audit_case_states_differ`. All figures below are computed over the kept snapshots only.

"Open" means the stage is not `dismissed`, `recovered` or `not_recovered`.

### Figures (each per currency, never summed with each other or across currencies)

| Figure | Definition (rule) | One-sentence definition shipped to the UI (`RECOVERY_DEFINITIONS`) |
|---|---|---|
| `flaggedForReview` | Open, stage `unreviewed` or `needs_info`, evidence gate not passed (`supportedPotentialMinor` null), finding type not `bank_account_change`, `unclaimed_discount` or `missed_discount`. Amount: `flaggedMinor`. | Open checks in the covered records that have not passed the evidence review; the amount is what the check flagged, not money a supplier owes. |
| `supportedPotential` | Open cases with a supported potential: `max(0, supportedPotentialMinor − customerRecordedReturnMinor)`. | For open cases whose evidence review passed, the supported amount minus any returns you recorded; the most a request could ask for, not a forecast. |
| `approvedOutstanding` | Vendor cases (`isClaim`) with `approvedAt`, stage `confirmed` or `requested`: `outstandingMinor` (approved request minus returns recorded against the active request). | For supplier requests you approved that are still open, the approved amount not yet covered by a return you recorded. |
| `promised` | Vendor cases at stage `requested` whose latest supplier position agreed an amount: `min(promisedMinor, outstandingMinor)`, counted when > 0. | The latest amount a supplier said it would return on an open request, capped at what is still outstanding; a statement, not money received. |
| `customerRecordedReturns` | Every kept case (any stage) with `customerRecordedReturnMinor > 0` (structurally valid settlements, `financials.validSettlements`). | Refunds and applied credits you recorded with a reference; they have not been matched to a bank or accounting record. |
| `matchedReturns` | `null` while `ReturnMatchPort.available` is false (coverage `matched_returns`: `not_run` / `no_independent_return_matching`). When available: verified matches per currency, attributed to the kept case, each distinct match counted once even if reported against two copies; proposed / ambiguous / reversed matches are counted in `returnMatching` but add no money. Matches for cases not visible here are ignored with warning `return_match_unknown_case`. | Returns independently matched to a bank or accounting record; not available yet, so shown as unavailable rather than zero. |
| `partialReturns` (count) | Stage `requested` with a customer-recorded return > 0. | Open supplier requests where you recorded part of the money coming back. |
| `closedWithoutRecovery` (count) | Stage `not_recovered`. | Requests closed with no return recorded. |
| `needingCustomerAction` (count) | `nextAction.requiresCustomer` (includes unreviewed checks). | Cases where the next step is yours, including checks you have not reviewed yet. |
| `byStage`, `claims`, `nonClaims`, `dismissed` | Counts over kept snapshots. | — |

Coverage items: `recovery_cases` (source reasons, `no_data`, `missing_currency`, `mixed_currency`), `flagged_for_review` (always `upstream_contract_pending`, see difference 1), `supported_potential` (`gate_currency_unsupported` when an open case is not USD: the evidence gate supports USD only), `promised` (`promise_return_order_unknown` when a request has both a promise and a recorded return), `matched_returns`.

`recoveryByVendor` gives the same figures and counts per vendor key (display name = most frequent case vendor name, ties alphabetical), ordered by cases needing customer action (desc), case count (desc), vendor key; paginated as above.

Freshness basis: newest case activity (`CaseSnapshot.updatedAt`) unless the caller passes `sourceUpdatedAt` (e.g. `LegacyAuditSource.newestUpdateAt`).

### Differences from `src/workspace/selectors.ts` (intentional or forced)

The tests in `recoveryVisibility.test.ts` cross-check against `ladder()`, `vendorCommitments()` and `recoveryAging()` on single-audit fixtures where the semantics agree (flagged USD, supported potential = `ladder.potential`, approved outstanding = `ladder.inRecovery`, customer-recorded = `ladder.recoveredByCurrency.USD`, promised = `vendorCommitments.confirmed` when the promise precedes the return). Where they differ:

1. **Suppressed signals (forced).** `isFlaggedForReview` excludes findings with a detector `suppressionReason`; `CaseSnapshot` does not carry it, so `flaggedForReview` may include them. Coverage `flagged_for_review` says `upstream_contract_pending`. A decision `confirmed` with no recovery stage (old states) is also indistinguishable from stage `confirmed` and is not counted as flagged here, while the ladder counts it.
2. **Exposure currency (intentional).** `exposureCurrencyOf` reads a row with no currency as USD. Here such a case stays `UNKNOWN` with `missing_currency`, per the shared rule that unknown currency is never assumed.
3. **Approved outstanding (intentional).** `ladder.inRecovery` requires the evidence gate to pass now (or a superseded finding). Here any vendor case (`isClaim`, the same test as `selectors.recoveries()`) with an approved, open request counts, which agrees with `recoveryAging()` and `vendorCommitments()`. Example: an approved duplicate request whose evidence was never attested shows its outstanding balance here and in `recoveryAging`, but not in `ladder.inRecovery`.
4. **Promised (forced).** `vendorCommitments()` subtracts returns recorded *after* the promise. A snapshot has no settlement dates, so v0.1 caps the latest stated amount at the outstanding balance instead and flags `promise_return_order_unknown` when both exist. Example: request 1,410.25, promise 500.00, then 400.00 recorded → here 500.00, `vendorCommitments` 100.00.
5. **Account-wide.** The selectors work on one audit; these models deduplicate across audits.

### What these figures are not

None of them is money the business is owed, a forecast, or "total savings". They are not summed. Customer-recorded returns are not matched to a bank or accounting record, and a supplier promise is not money.

### Open questions (recovery)

- Jagan: add `classification`/`suppressed` and the promise-vs-settlement order (or a `promisedOutstandingMinor` computed like `vendorCommitments`) to the case read contract (see report / interface requests J-1).
- Jagan: confirm the stage rank used to fold cross-audit copies, or provide one case identity across audits.
- Sid: return matching (S-5) to fill `matchedReturns`; how a reversed match affects a customer-recorded return.

---

## Changelog

| Version | Date | Change |
|---|---|---|
| `spend-v0.1` | 2026-11-25 | First definition: recorded AP payments in covered records; gross and refunds/credits apart; net null; ordinal cross-audit identity. |
| `recovery-v0.1` | 2026-11-25 | First definition: per-currency lifecycle figures over deduplicated case snapshots; matched returns unavailable. |
