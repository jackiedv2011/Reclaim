# Attention and approval presentation contract (P4)

**Contract 0.1.0 · metric definition `attention-1` · 25 Nov 2026 · CPO workstream · proposal, not a completed integration**

Code: `src/intelligence/attention.ts`, tests `src/intelligence/attention.test.ts` (synthetic fixtures only).

This is the read model and interaction contract for an account-wide "what needs me" view and an approval inbox. It is a **presentation layer**. Jagan owns approval objects, approval policy, execution and scheduling; there is no approval backend today beyond saved case state, so every item is derived from case snapshots read through `CaseReadPort` (currently the legacy audit snapshot adapter). Nothing in this layer writes, sends, schedules or calls a model. Visual design is out of scope and belongs to Aditya (see the open questions at the end).

The existing Dashboard "Recovery tasks" and "Up next" panels and the case screens are unchanged and remain the working approval path.

## 1. Read model

`attentionQueue(ctx, cases, now, { limit, cursor, include })` returns a standard `ReadModelEnvelope<AttentionQueueResult>` (`model: 'attention_queue'`). It requires `cases:read`; the port refuses another tenant's context (`IntelligenceAccessError`).

### 1.1 Item

| Field | Meaning |
|---|---|
| `id` | `${kind}:${caseId}:${revision ?? 'r?'}:g${hash}`; the hash covers stage, approval time, request time, next-action label, due date and reconciliation time. Deterministic. Changes when the case or its audit revision changes. |
| `tenantId` | From the server-derived context, never from the case. |
| `kind`, `category`, `reasonCode` | See 1.2. `reasonCode` is a machine sub-reason (vendor status, `partially_returned`, `return_amount_missing`, ...). |
| `caseId`, `auditId`, `findingId`, `findingType`, `vendor` | Source case. `auditId` is the project id the case-command route takes. |
| `owner` | `{ party: 'customer', actorId, assignment: 'single_user_default' }` for anything needing the customer; `{ party: 'vendor', actorId: null }` for informational items where the ball is with the supplier. Single user today; no assignment model exists. |
| `actionLabel` | The case's next-action label from `recoveryNextAction` (src/recovery/model.ts), verbatim. |
| `dueAt`, `overdue` | `dueAt` from the case's next action. `overdue` = more than `OVERDUE_GRACE_DAYS` (3) calendar days past `dueAt`, same day arithmetic as src/recovery/status.ts (process-local zone). |
| `statusLabel` | `CaseSnapshot.statusLabel` verbatim (the existing `recoveryStatusLabel` vocabulary). |
| `stage`, `revision` | Case stage and the **project (audit) revision** it was read at. Case commands need this revision as `expectedRevision`. |
| `amount` | `{ kind, money }`, one lifecycle figure, labelled; see 1.3. |
| `permissionsRequired`, `proposedPermissions` | Permissions any offered interaction needs; the second list are names that do not exist in the role model yet (`cases:approve`, `cases:write`). |
| `allowedInteractions` | All seven interactions with availability; see section 2. |
| `resolvedBy` | Existing case-command types that would move the item on (navigation hint only). |
| `cautions` | Machine codes the UI must surface: `send_state_not_in_snapshot` (ready to send), `revalidation_not_in_snapshot` (approval), `no_independent_return_matching` (return-related), `revision_unknown`, `cross_audit_overlap`. |
| `alsoInCaseIds` | Other saved cases for the same check on the same payments, collapsed into this one. |
| `sideEffects` | Always `'none_in_this_layer'`. |

### 1.2 Kinds and categories

Category rule: `outbound_approval` is `requires_approval`. `missing_evidence` (a needs-information decision) is always `requires_action`. Every other kind is `requires_action` when the case's `requiresCustomerAction` is true and `informational` otherwise. A property test checks that every case for which `requiresCustomerAction` is true (and every needs-information case) yields a `requires_*` item.

| Kind | Case state (next action) | Amount shown |
|---|---|---|
| `outbound_approval` | Confirmed, not approved, no hold ("Approve recovery") | supported potential |
| `ready_to_send` | Approved, not yet recorded as sent ("Send the request"). **Not sent, not recovered.** | approved request |
| `contact_on_hold` | Confirmed with a vendor-contact hold | supported potential |
| `unreviewed_finding` | No decision yet (includes a new review started from a historical request) | supported potential |
| `missing_evidence` | Decision "needs information" | supported potential |
| `internal_review` | Internal (non-vendor) review to file or close | none |
| `vendor_response_review` | Vendor reply needing a look: documents requested, payment not found, says nothing owed, wrong contact | outstanding |
| `disputed_or_partial` | Vendor disputed, accepted part, or a partial return is recorded and the remainder is open | outstanding |
| `follow_up_due` / `follow_up_overdue` | Scheduled follow-up date reached / more than 3 days past | outstanding |
| `verify_promised_return` | Vendor promised or accepted, issued a credit, or reports a refund; confirm it actually settles | promised (if the reply carried an amount), else outstanding |
| `record_in_books` | Return recorded by the customer, accounting reconciliation missing; or an older closed case with no recorded return | none |
| `historical_request_review` | A sent request that needs revalidation before any further contact | outstanding |
| `unmapped_case_state` | Customer action needed but the next-action label is unknown to this layer (guard; also a warning and coverage reason) | none |

No item: dismissed, waiting on the vendor with no date reached, reconciled, closed without recovery, internal review closed.

### 1.3 Amounts

`amount.kind` is one of `supported_potential` (evidence-gate amount), `approved_request` (the customer-approved request), `outstanding` (approved request minus customer-recorded returns for the active request), `promised` (latest supplier statement of intent with an amount), or `none`. Only positive integer minor units are shown, with the case currency. The flagged exposure of a finding is never shown: it is not money owed. Figures are never added together, across kinds or currencies. Customer-recorded returns are not matched returns; return-related items carry `no_independent_return_matching`.

### 1.4 Order, dedupe, counts, paging

- **Order** (`compareAttentionItems`): category (approval, action, informational); overdue first; `dueAt` ascending, no date last; items with an amount before those without; currency code ascending; larger amount first within a currency; `caseId`; `id`.
- **Dedupe**: one item per `crossAuditKey`. The kept case is the most advanced stage (unreviewed < needs info < dismissed < confirmed < requested < recovered/not recovered), then the most recently updated, then `caseId`. Collapsed cases are listed in `alsoInCaseIds`, counted in `duplicatesCollapsed` and the `cross_audit_overlap` exclusion. If collapsed cases were reviewed differently, a `cross_audit_divergent_state` warning names them. A dismissed copy hides an unreviewed copy of the same check, so the customer is not asked twice.
- **Counts**: `byCategory` and `byKind` cover every item before the `include` filter; `total` is after it.
- **Paging**: `limit` default 50, 1..200; `nextCursor` is an opaque offset (`o:<n>`). An unrecognised cursor returns the first page with an `invalid_cursor` warning.

### 1.5 Coverage (always stated, never "clear")

| Check | Reasons |
|---|---|
| `case_state` | `customer_supplied_source`, `snapshot_not_continuous` (legacy origin); `no_data`; `cross_audit_overlap`; `revision_unknown`; `unmapped_case_state` |
| `pending_approvals` | `upstream_contract_pending` (derived from case state, not an approval service), `revalidation_not_in_snapshot`, plus the legacy reasons |
| `send_state` | `send_state_not_in_snapshot` (Gmail `sending`/`sent`/`uncertain` rows are server tables the snapshot cannot see), `upstream_contract_pending` |
| `returns` | `no_independent_return_matching` |

`emptyState` is `no_cases` or `none_in_covered_cases`; neither means "nothing is wrong".

New reason codes in this module (not yet in `COVERAGE_REASONS`): `send_state_not_in_snapshot`, `revalidation_not_in_snapshot`, `revision_unknown`, `unmapped_case_state`.

## 2. Interactions

Each item lists all seven interactions with `executesVia`:

| Interaction | executesVia | Existing command | Permission |
|---|---|---|---|
| `view_case` | read only | none | `cases:read` |
| `inspect_evidence` | read only | none | `cases:read` |
| `review_exact_package` | read only, approval and ready-to-send items only | none | `cases:read` |
| `approve` | `outbound_approval` only | `approve` (input: exact package + prior-knowledge answer) | `cases:approve` (proposed) |
| `reject` | approval / ready to send: `contact_hold` with a reason (withdraws approval); unreviewed / needs info: `decision` `{decision:'expected'}` | see left | `cases:write` (proposed) |
| `request_more_evidence` | before a request is sent: `decision` `{decision:'needs_info'}` | `decision` | `cases:write` (proposed) |
| `open_source_case` | read only | none | `cases:read` |

Once a request is out, approve, reject and request-more-evidence are `not_available`; the customer works from the case page (`resolvedBy` names the commands).

**Permissions today.** The role model has only `cases:read`. `server/caseCommands.ts` lets any signed-in owner run any command, so a `single_user_session` context holds `cases:approve` and `cases:write` implicitly (`hasCasePermission`). Any other context must hold them explicitly; without them, interactions are listed with `enabled: false, disabledReason: 'permission_missing'`.

### 2.1 Proposals

`proposeApprovalAction(ctx, item, interaction, { expectedRevision, input?, current?, now? })` returns either a typed proposal or a typed refusal. It never executes.

Proposal: `route: '/api/projects/:id/case-commands'`, `path` (filled), `method: 'POST'`, `action`, `findingId`, `expectedRevision`, `commandId`, `input` (person's input plus fixed fields), `inputRequired` (still missing), `readyToSubmit`, `requiresHumanConfirmation: true`, `exactVersionCheck: true`, `sideEffects: 'none_in_this_layer'`, `serverRefusals` (codes the UI must handle).

`commandId` is a UUID-shaped (RFC 9562 version 8) deterministic id from tenant, actor, item id, action, revision and canonical input. Retrying the same proposal replays the same command (the server returns `replayed: true`); changing the input produces a new id, so the server never sees one id with two contents (`command_reused`).

Refusals: another tenant's item throws `IntelligenceAccessError`. Otherwise `not_available` (not offered or read-only), `forbidden` (permission), `already_resolved` (a fresh snapshot shows the case moved on or is gone), `stale_revision` (the person's or the fresh snapshot's revision differs from the item's), `revision_unknown` (no saved revision).

The server remains authoritative and re-checks everything: actor/tenant from the session, `expectedRevision` (`409 revision_conflict`), `commandId` idempotency, evidence gate and amount, `revalidation_required`, `gmail_receipt_pending`, and exact version: `request` refuses any package that differs from the approved one, and Gmail send refuses a differing email or recipient with `not_approved_version`.

## 3. Required UI states

| State | Source | Requirement |
|---|---|---|
| Empty | `emptyState` | Say what was covered and what was not (coverage). Never "all clear" or "no issues". |
| Loading | client | Keep the last known list visible and marked as refreshing, or a neutral placeholder; do not show zero counts while loading. |
| Error | 4xx/5xx, `IntelligenceAccessError` | 403/404 shown without revealing other tenants. Offer retry for reads. |
| Stale revision | proposal `stale_revision`, server `revision_conflict` | Reload, show what changed, ask the person to review again. Note the revision is per audit, so an unrelated case change in the same audit also makes an item stale. |
| Already resolved | proposal `already_resolved`, server `invalid_transition` / `no_change` | Show the case's current status; remove or update the item; no silent re-submit. |
| Permission disabled | `enabled: false`, `permission_missing`, proposal `forbidden` | Show the action as unavailable with the reason; do not hide that approval is needed. |
| Approved, not sent | `ready_to_send` | Must not read as sent or recovered. Before offering send, check Gmail state (`GET /api/integrations/gmail/attempts`). |
| Uncertain send | Gmail `gmail_send_uncertain` (not in snapshot) | "The email may have gone out. Check your Gmail Sent folder." Retry only with the person's explicit `retryUncertain` confirmation. Never record as sent without Gmail's message id. |
| Send in progress / receipt pending | `gmail_send_in_progress`, `gmail_receipt_pending` | Disable approve/reject/decision changes for that case until the receipt is recorded. |
| Revalidation required | `revalidation_required`, caution `revalidation_not_in_snapshot` | Route to evidence review; do not offer approval as if it will succeed. |
| Failure / retry | network failure after submit | Retry with the **same** proposal (same `commandId`) so the server replays rather than duplicates; `command_reused` means the input changed: build a new proposal. |

## 4. Interface request to Jagan (recovery/approval owner)

1. **Authoritative pending-approval / pending-action read endpoint**, tenant-scoped, server-derived actor, paginated. Per object: `approvalId` (stable), `tenantId`, `caseId` / `projectId` / `findingId`, `requestGeneration`, `actionType` (outbound request, follow-up, close, reconcile, ...), `state` (`pending`, `approved`, `rejected`, `expired`, `superseded`, `executing`, `executed`, `execution_uncertain`, `failed`), `exactVersion` (`contentHash`, subject, body, recipient(s), cc, attachment reference, amount minor + currency, method), `evidenceSnapshotRef` and gate result, `requestedBy`/`requestedAt`, `approver` requirements (role, count), `approvedBy`/`approvedAt`, `dueAt`/`expiresAt`, `caseRevision` (per case if possible), `sendState` (`not_started`, `sending`, `sent` + message id, `uncertain`, `rejected`), `lastError` (bounded code), `allowedCommands` for this actor.
2. **Approval policy hooks**: who may approve which action type and amount; whether approval expires; re-approval on any content/recipient/amount change; separation of duties once multi-user exists; how a policy refusal is reported (machine code).
3. **A dedicated reject / withdraw-approval command** (today the nearest are `contact_hold` and `decision`).
4. **Send state on the case read** (or the endpoint above), so uncertain and in-progress sends are visible without a separate Gmail call.
5. **Per-case revision** (today the project revision is used, so any case change stales every item in the audit).

**What this layer stops computing once those exist:** deriving approvals from `stage`/`approvedAt`; inferring `ready_to_send` from snapshot fields; the `send_state_not_in_snapshot` and `revalidation_not_in_snapshot` cautions; the implied single-user permissions; mapping interactions to command names (taken from `allowedCommands`); the `upstream_contract_pending` reason on `pending_approvals`. It keeps ordering, dedupe across audits, amount labelling, coverage and presentation states.

### Requests to the CPO contract (`CaseSnapshot`)

Add `requiresRevalidation`, `activeRequestGeneration`, `contactHold` presence and the latest vendor status code (today read back from `statusLabel`). The legacy adapter gives a needs-information case the next action "Case closed" with `requiresCustomer: false`; this layer overrides it, but the adapter should report it as customer action.

## 5. Open design questions for Aditya

1. Is the attention queue a separate inbox, a Dashboard section, or both? Does it replace or sit beside "Recovery tasks" and "Up next"?
2. Should approvals be visually separated from other actions (tabs by category, or one list with sections)? Are informational items shown by default?
3. Should unreviewed findings appear in the account-wide queue or stay in Findings / "Up next"?
4. How is each amount kind labelled in plain language ("supported", "approved", "still open", "promised"), and is a row with no supported amount shown with a placeholder or nothing?
5. Due vs overdue presentation, and whether informational items with a date show it.
6. Where does exact-package review happen: inline in the queue, a side panel, or the existing case page only?
7. How much of the uncertain-send and stale-revision explanation appears inline versus on the case page?
8. Should cross-audit duplicates show their other audits to the user, and how?
9. Bulk actions: none are proposed (each approval is one exact version). Confirm that is the intended direction.

## 6. Known limitations

- Derived from customer-supplied saved snapshots; no approval service, no send state, no revalidation flag, no case-level revision.
- Due/overdue uses the process time zone, as status.ts does; server and browser can differ near midnight.
- One item per case; a case needing two things shows its primary next action.
- Ordering compares amounts of different kinds within a currency (for ordering only, never summed).
- Fixtures only; no live Gmail, server or customer data was used. Not a release.
