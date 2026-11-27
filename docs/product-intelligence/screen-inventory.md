# Reclaim workspace: screen inventory (as built)

Factual inventory of the workspace UI at `dcf3eb5` (2026-11-25). No proposals. Paths are under `src/` unless noted.

**Money semantics used below:** **FE** = flagged exposure (`ladder().flagged` / `finding.dollarImpact`; payments involved, not owed) · **SP** = supported potential (`eligiblePotential`, `ladder().potential` / `.verified`) · **IR** = in recovery (`ladder().inRecovery` = `authorizedOutstanding` on approved cases) · **PR** = promised / vendor-agreed (`vendorCommitments()`) · **CR** = customer-recorded return (`verifiedReturned` / `activeReturned`; `recovery/financials.ts:17` says "not independent bank matching").

## Wiring

`AuditApp.tsx` routes on `route.mode` (`dashboard | audits | findings | recoveries | reports | plans | settings`) plus `route.caseId`. With no environment loaded, every mode except `plans` and `settings` renders `Launch` inside the shell (`AuditApp.tsx:747-776`), so Findings, Recoveries, Reports and Audits show the Launch empty state under their own title and description. Every case action goes through `persistCaseState` (`AuditApp.tsx:378`). Signed-in users also queue `POST /api/projects/:id/case-commands` with a command type (`ledger/projectSync.ts:146`). All view data is computed synchronously from the in-memory `LedgerEnvironment` for the **one open audit**.

## Screens

### Overview (`workspace/views/Dashboard.tsx`)
**Job:** see where the open audit stands and pick the next action.
**Sections, in order:** a header with meta (source, payments, vendors, date range), the "Overview" title, a summary sentence and a primary "next step" button. Then Totals (4 tiles), then two columns. Main column: **Recovery tasks**, **Up next**, **By finding type**, **Recent activity**. Side column: **Recovery progress**, **Top vendors**. A disclaimer closes the page. Users can reorder and hide sections in Customize (`preferences.tsx:46-59`, stored in localStorage).

| Figure | Label (file:line) | Source | Semantic |
|---|---|---|---|
| Tile 1 | "Evidence-supported possible requests" (:127) | `ladder().verified` | SP |
| Tile 2 | "Payments involved in checks" (:132), note "this is not an amount owed" | `ladder().flagged` | FE |
| Tile 3 | "Approved outstanding requests" (:137) | `ladder().inRecovery` | IR |
| Tile 4 | "Returns recorded by your team" (:142), note "not independently bank-matched" (:144) | `ladder().recovered` | CR |
| Header sentence | "N recovery candidates worth $X … $Y of it has confirmed evidence" (:418) | `ladder().potential`, `.verified` | SP |
| Recovery tasks row | outstanding (:163) | `recoveries()` + `internalReviews()` + `recoveryNextAction` | IR / FE |
| Up next row | amount (:206) | `opportunities()` filtered | FE |
| Pipeline kv | "Vendor agreed" / "Return pending" (:266-267) | `vendorCommitments()` | PR |
| "Latest money back" (:277) | amounts | `recentReturns()` | CR, **no qualifier on the list** |
| By finding type | value per check (:312) | `rootCauses()` | FE |
| "Causes you confirmed when reconciling" | "$X back" (:322) | `recordedRootCauses()` | CR |
| Top vendors | "Most money still in play" | `vendors().potential` | SP |
| Recent activity | event amount | `caseState.history` (last 6) | mixed |

**Actions:** tiles, rows and bars navigate to Findings (with query params), Recoveries, Reports, Plans, or a case.
**States:** empty copy for Up next and Recent activity. Tasks, types and vendors sections disappear when they have no rows. Locked: Up next rows are redacted with an upsell (:224), and Top vendors is wrapped in `Locked`. No loading or stale states. A QuickBooks sync line appears above the page (`AuditApp.tsx:836`).
**Accessibility:** sections are `aria-labelledby`; the pipeline bar is `role="img"`; locked rows have their own aria-label.

### Findings (`views/Findings.tsx`)
**Job:** triage every finding.
**Sections:** kind tabs (All / Recovery candidates / Flagged for review / Security alerts / Future savings, each with a count). A toolbar with search, a decision filter, sort and "Export CSV". A grid with columns Vendor and records, Finding, Evidence, Status, Amount. A footer.
**Data:** `opportunities()`, `ladder()`, and `evaluateEligibility` per row.
**Money:** row amount is FE ("Flagged amount"). The sub-line "Potential $X" is SP from `finding.potentialAmountMinor`. The footer shows "$X flagged for review" (FE) and "$Y eligible and waiting on you" (`ladder().awaitingDecision`, SP) (:170).
**Actions:** open a case, or open `UpgradeDialog` on a locked row. Export runs client-side (visible rows only). Filters sync to the URL.
**States:** an empty audit shows "Nothing flagged" (:139). No matches shows "Clear filters". Locked rows carry no vendor or amount. No loading or error states.
**Accessibility:** tabs use `role="tab"`/`aria-selected` but have no tabpanel and no arrow-key handling. Selects have `sr-only` labels.

### Recoveries (`views/Recoveries.tsx`)
**Job:** run vendor recovery cases.
**Sections:** 4 total tiles with `MiniPie`. **Needs your action**. A board of 4 lanes: Prepared / With the vendor / Money back / Closed.
**Money:** "In recovery" = IR (:76). "Vendor agreed" = PR (:82). "Return pending" = PR (:88). "Recovered" = CR, note "Only money you recorded as settled" (:94-96). Lane totals come from `caseValue()` (:21), which mixes semantics by stage: amount to request (FE), outstanding (IR), returned (CR) and unreturned.
**Actions:** open a case.
**States:** with no rows it shows "No recoveries yet" and "Review findings" (:53). Each empty lane shows a hint. No plan lock.

### Case detail (`views/CaseDetail.tsx`)
**Job:** decide on one finding, prove it, request the money, track it and close it.
**Sections, main column:** header (kind, reference, vendor, status, type, strength, "Flagged value" = FE, :393) → **Why it was flagged** → **Amount** (duplicates only: "Outstanding", with "Confirmed refunds" and "Confirmed applied credits", :422-427) → work panel (RecoveryRequestPanel, or GmailFollowUp + RecoveryProgressPanel, or InternalReviewPanel) → **Historical request** → **Earlier requests** → **Evidence** (with "Matched ledger rows" and "Before asking the vendor") → **Review the evidence** (EvidencePanel) → **In your books** → **Money timeline** → **Activity**.
**Sections, side column:** **Ask Reclaim** → **Next step** (5-step list) → **Your decision** / **Decision** → **Recovery** / **Internal review** facts.
**Money in facts (:225-233):** "Flagged value" (FE), "Requested", "Return recorded by customer" (CR), "Older unverified amount (not counted)", "Still outstanding" / "Unreturned balance" (IR).
**Decision actions:** "I reviewed this check" / "I need more detail" / "Not an issue" open `DecisionDialog` and send the `decision` command. "Change decision" and "Reopen case" send `reopen`. "Reopen remaining balance" sends `reopen_balance`. "Start a separate request review" sends `begin_new_request_review`. "Record earlier return" sends `historical_settlement`.
**States:** a locked finding renders a placeholder (`AuditApp.tsx:868`). Activity history is locked without `fullRecoveryWorkflow` (:510). A case requiring revalidation is handled. No loading state.

**EvidencePanel** (`views/EvidencePanel.tsx`): "Review the evidence", with fieldsets 1–5 (company and supplier, one bill, payments cleared, refund/credit/void, really a duplicate), then a "Details" disclosure. It shows SP as "Possible request supported up to $X … a reviewer assertion" (:117). Answers filled from QuickBooks are labelled. "Save evidence" calls `recordEvidence` and sends the `evidence` command.

**RecoveryPanels** (`views/RecoveryPanels.tsx`): **Recovery request** / **Internal note** (amount, recipient, attachment). "Draft with AI" calls `/api/ai/draft` and is gated by `aiDrafts`. Copy draft / Download. Under "Approve before it goes out", the actions send these commands: "Approve recovery request" (`approve`), "Mark request sent" / "Simulate sending request" (`request`), "Approve and mark sent" (`approve_and_request`), "Hold vendor contact instead" (`contact_hold`). The Gmail send step calls `/api/integrations/gmail/send` and sends `email_sent`. **Internal investigation** has "Close internal review" (`close`).

**RecoveryJourney** (`views/RecoveryJourney.tsx`): **With the vendor** ("Asked for $X · $Y back so far · $Z outstanding", :120), a vendor log ("$X came back", :141), and the "Next follow-up" date (`followup`). Tabs: Log a reply (`vendor_update`), Record money back (`settlement`, :246; the "Checked against" options include "Bank transaction", :228), Close (`close`). **In your books** ("$X came back across N settlements", :298) has "Mark reconciled" (`reconcile`).

**CaseAssistant** (`views/CaseAssistant.tsx`): **Ask Reclaim**, with 4 suggested questions and a free-text field. It calls `POST /api/assistant/ask` with `{projectId, findingId, question}` and shows the answer, the limitation and the sources. It is hidden for guests, sample sessions and unsaved projects (:14). It shows a busy label and an error alert (`role="alert"`). Scope is **one finding**.

### Reports (`views/Reports.tsx`)
**Sections:** **This audit** (Facts), per-currency Facts, **By check** (table), **Every vendor checked** (table, locked without `advancedReports`).
**Money:** "Open flagged value (USD)" FE · "Potential recovery (USD)" SP · "Payments to verify (USD)" `ladder().atRisk` · "Recovered" CR with no qualifier (:49) · "**Verified returned · USD**" CR (:57) · By-check "Value" FE · vendor columns "Recovered" (CR) and "Flagged value" (header :129), whose cell shows `vendors().potential`, i.e. SP (:159).
**Actions:** none. The page is read-only and has no export.

### Audits (`views/Audits.tsx`)
**Sections:** **Your audits** (table), "What an audit is" card, **What the open audit was built from** ("N of 7 checks", record readiness), **Sources** (import batches with skipped and uncertain rows).
**Money:** the column header is "Potential recovery" (:70). The sample row shows `ladder().potential` (SP, :88). Saved rows show `p.flaggedValue` = `ladder().flagged` (FE, :109; `ledger/projects.ts:71`).
**Actions:** open an audit, "Start a new audit", "Try the sample ledger", "Add records to this audit".
**States:** "No audits yet". This is the only screen that shows coverage (checks available and limitations).

### Plans (`views/Plans.tsx`)
Hero, 3 plan cards from `PLAN_PITCH` (`lib/plans.ts`), the **Compare the tracks** table, and the Free confirmation dialog. CTAs go to `/checkout?plan=`, or `/signup?next=` for guests.

### Settings (`views/Settings.tsx`) and Your data (`views/AccountData.tsx`)
Sections in order: **Account** · **Appearance and layout** (CustomizeControls) · **Your plan** (`PlanBilling`: "Customer-recorded returns on this audit … not independent proof", `components/plan/PlanBilling.tsx:82-83`) · **Connected accounts** (QuickBooks, Gmail) · **Appearance** (theme radiogroup) · **Your setup** (edit onboarding answers, "Take the tour again") · **Legal** · **Your data** (Export, which calls `/api/account/export`; Delete account, which calls `/api/account/delete` after typing the email) · **This audit's data** ("Delete this audit").

### Launch (`views/Launch.tsx`)
A "No audit yet" empty state with "Upload a ledger" and "Run the sample". The running state ("Reading the ledger…") is an `aria-live` status. Errors show as `role="alert"`.

### Onboarding and tour
`onboarding/Onboarding.tsx` has 4 steps: business and role → payment source → "How much should Reclaim do?" (show / draft / follow up) → first audit. It saves through `/api/account/onboarding`. Each step title receives focus. The role, tools and autonomy answers are not read anywhere in `src/workspace` or `AuditApp`.
`workspace/WorkspaceTour.tsx` is a modal tour of about 70 steps across 9 sections. It auto-starts once on Overview and sets `/api/account/tour-seen`. Arrow keys move between steps, and there are Skip section and Skip tour controls. The key handler does not include Escape.

## Navigation today (`WorkspaceShell.tsx:105-115`)
- **Primary nav:** Overview · Findings (badge: undecided findings, `AuditApp.tsx:812`) · Recoveries (badge: `ladder().counts.inRecovery`, :813) · Reports · Audits (badge: project count, plus 1 for the sample).
- **Secondary nav:** Plans · Settings. Badges are hidden at 0 (:164).
- **Chrome:** the brand row includes a plan chip. Find (F or Cmd/Ctrl-K) covers pages and visible findings. The topbar has the audit switcher (current audit and "All audits"), breadcrumb, theme toggle, Customize, and "Start an audit" (or "Back" on a case). The sidebar foot has the landing page link, Customize, Collapse and Log out.

## Visualization today
- `MiniPie` (SVG, `role="img"`) is used only on the Recoveries tiles.
- `CountUp` animates the tile figures on Overview and Recoveries and respects reduced motion.
- CSS bars: the Overview pipeline bar (`.wk-flow-bar`) and the by-type and top-vendor bars (`.wk-bars-track`).
- `ToneBar` (`StatusChip.tsx:16`) and `countByTone` (`recovery/status.ts:129`) are defined but unused.
- **Recharts:** `README.md:117` lists "Recharts for data visualization", but it is not in `package.json` dependencies or `node_modules`. Confirmed absent. There are no chart library, time-series or trend charts.

## Gaps relevant to product intelligence
- **No spending view.** Nothing shows spend by vendor, category or period. `vendors()` reports `recordCount` only.
- **No account-wide view.** Every screen reads one open audit. Audits lists per-project summaries only, and nothing aggregates findings, recoveries or returns across audits.
- **No approval inbox.** Approvals happen inside each case. Overview "Recovery tasks" and Recoveries "Needs your action" are per-audit queues, with no approver or role separation.
- **No insight surface.** `rootCauses` and `recordedRootCauses` are the only explanatory rollups. `OverviewSummary.statusMix`, `exposureByType`, `nextRecommendedCase` and `newSinceLastVisitCount`, as well as `lastScanReceipt`, `findingsQueue`, `recoveryQueue` and `awaitingDecision()`, are not used by any workspace view.
- **No coverage or freshness display on the main screens.** Check coverage appears only on Audits. Data freshness appears only as the QuickBooks sync line on Overview. `newFindingIds` is tracked and cleared (`AuditApp.tsx:339`) but never displayed. There is no "as of" date on totals.
- **Assistant limited to one case.** `CaseAssistant` requires `findingId`, and there is no assistant at audit or account level.
- **States:** no view has a loading skeleton or an error boundary. Error handling is limited to shell-level notices (sync, storage, import).

## Observed inconsistencies
1. **CR labelled as verified:** Reports "Verified returned · USD" (`Reports.tsx:57`). The tour describes the CR tile as "Recovered — Money that actually came back" (`WorkspaceTour.tsx:66`). The Recoveries lane hint says "Money that actually came back" (`Recoveries.tsx:15`). Reports "Recovered" has no qualifier (`Reports.tsx:49`). Overview "Latest money back" has no qualifier (`Dashboard.tsx:277`). The Amount panel says "Confirmed refunds" (`CaseDetail.tsx:422`). The selector name `verifiedReturned` (`recovery/financials.ts:18`) contradicts its own docstring.
2. **The same CR value has four labels:** "Returns recorded by your team" (Overview), "Recovered" (Recoveries, Reports), "Verified returned" (Reports), "Return recorded" (pipeline, `Dashboard.tsx:240`).
3. **Same column header, different semantic:** the Audits "Potential recovery" column shows FE for saved audits and SP for the sample (`Audits.tsx:70,88,109`). The Reports vendor column "Flagged value" shows SP (`Reports.tsx:129,159`).
4. **"Open findings" has three definitions:** Settings uses the queue groups (`Settings.tsx:174`), Audits uses `openCaseCount` (`ledger/projects.ts:57`), and Reports "Findings" uses `ladder().openCount` (`Reports.tsx:45`).
5. **Pipeline double count:** an approved but unsent case counts in both "Confirmed" (`Dashboard.tsx:95`) and "Requested" (`:96`, `ladder().counts.inRecovery`). The "requests out with vendors" notes (`Dashboard.tsx:139`, `Recoveries.tsx:78`) also include these unsent approved cases.
6. **Check count:** "eight checks" (`Audits.tsx:123`, `Plans.tsx:10`, `lib/plans.ts:37`, `WorkspaceTour.tsx:126`) vs `totalCheckCount: 7` (`ledger/views.ts:85`) vs "seven checks" on the site (`components/site/siteData.ts:24`).
7. **"Pro" vs Growth/Flat:** server 402 messages say "Upgrade to Pro" (`server/app.ts:544`) and "part of the Pro plan" (`server/app.ts:611`). `billing/entitlement.ts:3` still has `Plan = 'free' | 'pro'`.
8. **Free audit limit:** `auditsPerMonth` is `null` for every plan (`server/plans.ts:52`), yet the UpgradeDialog reason reads "You've used N of ∞ audits this month on the Free plan" (`AuditApp.tsx:780,966`).
9. **Plans vs gates:** Compare marks "Approvals, follow-ups and partial returns" as not included on Free (`Plans.tsx:16`), but `fullRecoveryWorkflow` gates only the Activity history (`CaseDetail.tsx:510`). The tour says Growth takes "a share of only the money that actually comes back" (`WorkspaceTour.tsx:127`), while the fee is disabled (`Plans.tsx:138`).
10. **Tour copy vs on-screen labels:** tile names in the tour (`WorkspaceTour.tsx:63-66`) differ from the on-screen tiles. "What happened" vs "Why it was flagged". "This is real" vs "I reviewed this check" (`CaseDetail.tsx:108`). "At a glance" vs "Recovery". "History" vs "Activity". "Recovered" vs "Return recorded" in the pipeline (`:68`). "Values highlighted in green" (`:78`). The Customize detail for Totals lists "Ready to claim, needs more context, in recovery, recovered" (`preferences.tsx:37`).
11. **Taxonomy:** `KIND_LABEL` ("Money to claim back / Needs more context / Prevention", `KindChip.tsx:13`) does not match the Findings tabs (5 classifications), and both differ from the Findings evidence statuses (`Findings.tsx:82-90`).
12. **Settings:** there are two sections named "Appearance and layout" and "Appearance" (`Settings.tsx:71,92`). "Dashboard tour" uses a page name that doesn't exist in the nav (`:125`). The tour's "Your data" step points at "This audit's data" but says "Download everything" (`WorkspaceTour.tsx:139`).
13. **Accounting connection:** Audits says "It has no connection to your accounting system" (`Audits.tsx:232`) while the same list shows QuickBooks sync sources (`:211`).
