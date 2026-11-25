# Product-intelligence design brief

**For:** Aditya (CPO, owns visual direction, information hierarchy, navigation and wording) · **From:** CPO engineering workstream · **Status:** input for design, not a design · 25 Nov 2026

This brief tells you what now exists underneath the product, what any screen built on it must handle, and which decisions are yours. It proposes no visual system, layout, colours, fonts or navigation. Nothing in the current app was changed. The engineering is usable through typed functions and a read-only API that is **off by default** (`RECLAIM_INTELLIGENCE_API=1`).

Companion documents:
- `screen-inventory.md`: what each current screen shows, with file:line references
- `metrics.md`: exact metric definitions
- `attention-contract.md`: approval and attention items, interactions, UI states
- `insight-catalog.md`: every insight rule
- `assistant-contract.md`: account assistant intents and limits
- `business-memory.md`: corrections and feedback
- `interface-requests.md`: what is pending from Sid and Jagan

## 1. Where the product is today (summary of `screen-inventory.md`)

- **Every screen reads one audit at a time.** There is no account-wide view, spending view, approval inbox or insight surface. The case assistant answers about one case.
- **Visualization is minimal:** one small pie chart (Recoveries), animated numbers and CSS bars. The README's Recharts is not installed.
- **Money labels are inconsistent, and some overstate.** A return the customer typed in is called "Verified returned" (Reports), "Money that actually came back" (Recoveries and tour) and "Confirmed refunds" (case amount panel). The same value carries four names. These breach the shared contract ("never present a customer-recorded return as matched or verified"). They are copy and layout changes on screens you own, so they are **listed for your decision and not changed** (section 6, D1).
- **Other mismatches** (inventory §"Observed inconsistencies"):
  - The pipeline double-counts approved but unsent cases.
  - "Open findings" has three definitions.
  - Screens say "eight checks" while the code counts 7.
  - Messages still say "Pro" though the plans are Growth and Flat.

## 2. User jobs this layer serves (recovery first, spending as context)

1. **What needs me right now?** Approvals, evidence to supply, supplier replies, follow-ups. *Attention queue.*
2. **How much is in play, and how much actually came back?** Six figures that are never added together. *Recovery overview.*
3. **What do I usually pay this supplier, and is anything unusual?** *Vendor profile, baselines and insights.*
4. **Where is my money going, in the records Reclaim has seen?** *Covered spend by vendor, category and month.*
5. **What could Reclaim not check?** *Coverage, on every view.*
6. **Why does Reclaim think this?** *Citations, provenance and the "influenced by" memory entries.*
7. **Tell Reclaim it got something wrong.** *Business-memory corrections; the contract exists, persistence is pending S-7.*
8. **Ask a question.** *Account assistant with fixed intents; the case assistant is unchanged.*

Out of scope by the founders' brief: full accounting, revenue, profit, budgeting, forecasting.

## 3. Available read models and actions

| Read model | Function | API (flag on, GET) | Answers job |
|---|---|---|---|
| Attention queue | `attentionQueue` | `/api/intelligence/attention` | 1 |
| Approval action proposal | `proposeApprovalAction` | none: produces a typed proposal for the existing case-command route | 1 |
| Recovery overview / by vendor | `recoveryOverview`, `recoveryByVendor` | `/recovery`, `/recovery/vendors` | 2 |
| Vendor profiles | `vendorProfiles`, `vendorProfile` | `/vendors`, `/vendors/:key` | 3 |
| Baselines | `vendorBaselines` | `/baselines` | 3 |
| Covered spend | `spendSummary`, `spendByVendor`, `spendByCategory`, `spendTrend` | `/spend/summary`, `/spend/vendors`, `/spend/categories`, `/spend/trend` | 4 |
| Import coverage | `importCoverageSummary` | `/coverage` | 5 |
| Insights | `generateInsights`, `findInsight` | see `insight-catalog.md` | 3, 5, 6 |
| Account assistant | `askAccount` | see `assistant-contract.md` | 8 |
| Business memory | `validateFeedbackInput`, `FeedbackStore`, `influenceFor` | none until persistence (S-7) | 6, 7 |

Every response is a `ReadModelEnvelope` with the same fields:
- `result` (null when Reclaim could not look);
- `coverage` items with reason codes;
- `freshness` (`stale`, `sourceUpdatedAt`);
- `origin` (today always `legacy_audit_snapshot`, i.e. built from saved audits);
- `sources` (citations), `exclusions` and `warnings`.

`src/intelligence/viewModels.ts` turns any envelope into a UI state, standing notices and exact per-currency money strings. That file is logic only, and its copy is a draft.

## 4. States every view must design for

| State | Meaning | Source |
|---|---|---|
| `ready` | Covered data, nothing limited beyond the standing notices | `uiStateOf` |
| `empty` | Reclaim looked and the covered records hold nothing (e.g. no approvals due) | `uiStateOf` |
| `partial` | Some checks limited: missing dates, mixed currency, rejected rows, a partly covered period, … | `uiStateOf` + reason copy |
| `stale` | Newest source data is older than 35 days | `freshness.stale` |
| `not_covered` | Reclaim could not look: no data or no import for the period. **Never show it as zero or "all clear".** | `result === null` / all `not_run` |
| Loading, error | Not modelled by the envelope; the existing app has no skeletons or error boundaries (inventory) | design |
| Locked by plan | Pending decision D3 | design + founders |
| Stale revision / already resolved / permission disabled | Approval interactions only | `attention-contract.md` |
| Uncertain send | The Gmail send outcome is unknown; shown on the case today, not in snapshots | `attention-contract.md` |

**Standing notices** are always true of today's data source, whatever the state: "based on files you provided", "not a continuous connection", "settlement not verified", "returns not matched". Decide where they live (D6). They must not disappear.

## 5. Interaction constraints (non-negotiable, from the shared contract)

- **Money:**
  - Per currency, never added across currencies or converted.
  - Never sum potential, approved, promised, customer-recorded and matched figures into one total.
  - "Matched returns" shows as *not available*, not zero, until Sid's matching exists.
- **Approvals:**
  - Approve, reject and request-evidence go through the existing server case commands, with a revision check and the exact approved version.
  - The inbox shows the exact subject, body, recipient and attachment before approval.
  - Being approved is not being sent; being sent is not being recovered.
  - No bulk approval is proposed.
- **Insights:**
  - Wording stays within "in the covered records".
  - No "fraud", "overcharged", "owed", "verified" or "all clear".
  - Each insight links to its evidence and to the corrections that influenced it.
- **Assistant:**
  - Numbers are computed by code, with citations.
  - Action requests produce proposals that a person confirms; nothing is executed from chat.
  - It works with AI off (the default).
- **Corrections:**
  - Scoped narrowly and revocable.
  - Never dismiss a case that has supported evidence.
- **Accessibility:** the existing app has aria labels in places, but no systematic keyboard model for queues. Every list in this layer is deterministically ordered and paginated, which supports keyboard navigation and screen readers. The approval inbox needs a defined focus order.

## 6. Decisions needed from you

| # | Decision | Options (none chosen) | Blocks |
|---|---|---|---|
| D1 | Names for the six recovery figures, and fixing the current "Verified returned" / "Money that actually came back" labels | Draft labels in `viewModels.ts` `DRAFT_RECOVERY_LABELS`; or your own | Any recovery UI; correcting current screens |
| D2 | Where account-wide views live | (a) the Overview becomes account-wide; (b) a new "Account" view beside per-audit views; (c) an audit selector with an "All audits" option | All UI integration |
| D3 | Plan availability (Free / Growth / Flat) of spend, vendor, insight and assistant features | Founder decision with pricing | Exposing routes beyond the flag |
| D4 | Is the approval inbox a separate destination or part of the Overview? Should unreviewed findings appear in it? | `attention-contract.md` §6 | P4 UI |
| D5 | Is spending visibility released at all, and how prominently, given that recovery is the entry point? | Founder decision (contract §5) | P1 UI |
| D6 | Where standing notices and coverage appear (banner, per-figure marker, footnote, coverage page) | — | All UI |
| D7 | Chart approach for trends and vendors: none, existing CSS bars, or a library (adding one is a dependency change for Sid) | — | P1 and P2 visuals |
| D8 | One assistant entry point (routing case questions to the case assistant) or two | `assistant-contract.md` | P5 UI |
| D9 | Correction interaction: where a user says "this is intentional" or "same supplier", and how revocation is shown | `business-memory.md` | P2 UI, after S-7 |
| D10 | Empty, partial and not-covered copy | Draft copy in `DRAFT_COVERAGE_COPY` | All UI |

## 7. Fixtures for design

`src/intelligence/fixtures/synthetic.ts` builds fictional tenants (fixture vendors, 2026 dates) through the real import pipeline. Running the read models over them gives real response shapes, including:
- mixed currency (EUR);
- missing categories;
- a refund row;
- a duplicate payment;
- recurring rent;
- an overlapping second upload counted once;
- a second tenant with the same vendor names.

`docs/product-intelligence/fixtures/` holds example JSON responses generated from them, for designing against without running anything. Regenerate with `UPDATE_DESIGN_FIXTURES=1 npx vitest run src/intelligence/designFixtures.test.ts`. The same test fails if a response shape changes without regenerating.

## 8. What happens after your direction

When you supply approved designs or references, engineering will implement them faithfully, raise only material ambiguities, keep the current product working during the transition, and verify:
- responsiveness and keyboard access;
- the evidence and approval paths;
- every state in section 4.

Until then, no customer-facing screen is added or changed.
