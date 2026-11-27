# Business memory, vendor profiles and baselines (P2)

**Owner:** CPO workstream (Aditya) · **Contract versions:** `memory-v0.1`, `vendor-profile-v0.1`, `baseline-v0.1` · **Status:** proposal, implemented in-memory against fixtures and the legacy-audit adapter. Not persisted, not wired to any route, not a completed integration.

Code: `src/intelligence/memory.ts`, `src/intelligence/vendorProfiles.ts`, `src/intelligence/baselines.ts` (tests beside each).

> **Business memory is structured application data. It is not model training data, not prompt history and not a learning system.** Each entry belongs to one tenant and is only ever read for that tenant. There is no cross-tenant learning, no shared model and no aggregation across businesses. Nothing in memory is sent to an external model by this layer.

---

## 1. What is stored

One row per feedback entry a person in the account creates. Every entry has:

| Field | Meaning |
|---|---|
| `id` | Server-assigned (`mem_<seq>_<hash>`). |
| `tenantId`, `authorActorId` | From the signed-in session (`TenantContext`). A request body that contains `tenantId`, `actorId`, `authorActorId` (or `tenant`, `actor`, `author`, `userId`, `revokedBy`) anywhere is **rejected**, not overwritten. |
| `kind` | See below. |
| `scope` | Exactly one of: `{vendor, vendorKey}`, `{recurring_series, vendorKey, recurringSeriesId}`, `{case, caseId}`, `{source_records, sourceRecordIds[1..200]}`. Every reference must exist in the tenant's current data when the entry is created. |
| `sourceRefs` | Derived from the scope (`vendor:`, `series:`, `case:`, `record:`). |
| `rationale` | Required, trimmed, 1–1000 characters, no control characters. Stored as text. **Never parsed for amounts.** |
| `details` | Kind-specific structured fields (below). Money appears only as integer minor units plus an ISO currency. |
| `createdAt`, `expiresAt`, `reviewAt` | Expiry/review must be in the future and at most 3 years out. `intentional_payment` and `recurring_confirmation` get `reviewAt = createdAt + 365 days` unless the author picks earlier. |
| `revokedAt`, `revokedBy`, `revokeReason` | Set once by revocation (reason 1–500 characters). |
| `history` | Append-only: `created`, `revoked`, and `expired` (the last added at read time when `now ≥ expiresAt`). |
| `version` | `memory-v0.1`. |

### Kinds

| Kind | Allowed scope | `details` | Can lead to |
|---|---|---|---|
| `intentional_payment` | source records, case, recurring series, or vendor **only with** `findingType` **and** a narrow `amountBand {currency, minMinor, maxMinor}` (width ≤ 10% of `minMinor`, or ≤ 100 minor units) | `findingType?`, `amountBand?` | Suppression proposal |
| `recurring_confirmation` | recurring series | `assertion: recurring_expected \| not_recurring` | Suppression proposal (expected) or rule feedback (not recurring: false recurrence) |
| `vendor_alias_proposal` | vendor | `aliasName`, `decision: proposed \| confirmed \| rejected`, `pendingCanonicalIdentityConfirmation: true` | Display only; input to canonical identity |
| `vendor_context_note` | vendor, case | — | Display only |
| `recovery_outcome_confirmation` | case that reached a request (`requested`, `recovered`, `not_recovered`) | `outcome: returned_as_recorded \| partially_returned \| not_returned \| disputed_recorded_return` | Display only. Never a matched or verified return. |
| `dismissal_reason` | case | `tag`, `findingType` | **Read-only, derived** from the case's own dismissal (`CaseSnapshot.dismissal`). Not stored here; change it on the case. |

### Read-time status

`status` is evaluated against `now` on every read: `active`, `revoked` or `expired`. Resolution against current data adds:

- **`scope_missing`**: a referenced vendor, series, case or source record no longer exists (for example, the same CSV re-saved as a new audit gives new record IDs). The entry stays stored and visible, but influences nothing until someone re-scopes it. A partially missing scope counts as missing: silently narrowing or widening what the author said would be worse.
- **`reviewDue`**: active, but past `reviewAt`. Still shown; no longer feeds suppression proposals.

---

## 2. What memory can and cannot influence

**Can:**
- be shown beside a vendor profile, case or insight, with entry IDs, so a person sees which context influenced it (`influenceFor`, `VendorProfile.memory`);
- produce **proposals** for the detection owner (`suppressionProposals`), each with `status: 'proposed_for_detection_owner'`. Allowed proposal scopes: one recurring series, specific source records (plus finding type), or vendor + finding type + narrow amount band.
- carry alias statements to the canonical identity owner.

**Cannot, by construction:**
- apply a suppression, dismiss a finding, or change detection thresholds (detection is the financial-foundation workstream's);
- propose suppression of a whole vendor (rejected at validation; and `blanket_vendor_scope_not_allowed` if one were ever stored);
- touch a finding whose evidence gate passed: any suppression proposal whose targets include a case with `supportedPotentialMinor !== null` is **blocked** (`targets_supported_finding`). Rule feedback about such a case is passed on with the case listed under `supportedCaseIds`, never as a target;
- merge vendorKeys. A customer `confirmed` alias is shown as *confirmed by customer — pending canonical identity review*; import similarity suggestions and customer `proposed` aliases as *proposed — not confirmed*. Contradictory in-effect statements (`rejected` alongside `confirmed`/`proposed` for the same normalized alias) are shown as contradictions and count as neither until one is revoked;
- create or change a money amount, attest evidence, mark a return matched/verified, write to source records or case state, or call an external model.

Dismissal tags map to proposals as: `intentional`, `known_vendor_exception` → suppress the specific records for that finding type; `not_a_match`, `detection_error` → rule feedback; `other` / none → nothing.

---

## 3. Permissions and tenancy

| Operation | Permission |
|---|---|
| `validateFeedbackInput`, `store.create`, `store.revoke`, `deleteTenantMemory` | `feedback:write` |
| `store.list`, `store.get`, `exportTenantMemory` | `financial:read` |
| `resolveMemory`, `suppressionProposals`, `influenceFor`, `vendorProfiles` | `financial:read` + `cases:read` |

The store only accepts objects produced by `validateFeedbackInput` (tracked in a module-private `WeakSet`), and refuses one validated for another tenant or another actor. Every store method selects the caller's tenant partition from `ctx`; there is no method that takes a tenant ID from the caller. Losing `feedback:write` takes effect on the next call.

---

## 4. Retention, export and delete

- **Retention (proposal):** entries are kept until account deletion. Revoked and expired entries are retained with their history so a reviewer can see what used to influence a result. A purge of revoked/expired entries after a fixed period (for example 24 months) is a **founder decision**, not implemented.
- **Export:** `exportTenantMemory(ctx, store, now)` returns every stored entry (active or not) with full history, version and tenant. Dismissal reasons are not duplicated here; they are exported with the cases.
- **Delete:** `deleteTenantMemory(ctx, store)` removes every entry of the caller's tenant and nothing else.
- **Wiring:** adding both to `/api/account/export` and `/api/account/delete` in `server/account.ts` is a **CTO-coordinated change** (interface request S-7). It is not done in this workstream.

---

## 5. Proposed SQLite DDL (for the CTO; NOT applied)

A proposal only. Table and column names, the tenant foreign key, and migration numbering are Sid's call.

```sql
-- memory-v0.1: one row per feedback entry. Status is derived at read time
-- (revoked_at / expires_at vs now); it is never stored as a mutable column.
CREATE TABLE business_memory_entries (
  id               TEXT PRIMARY KEY,
  tenant_id        TEXT NOT NULL,              -- FK to the tenant table per the tenancy model
  kind             TEXT NOT NULL CHECK (kind IN ('intentional_payment','recurring_confirmation','vendor_alias_proposal','vendor_context_note','recovery_outcome_confirmation')),
  scope_type       TEXT NOT NULL CHECK (scope_type IN ('vendor','recurring_series','case','source_records')),
  scope_json       TEXT NOT NULL,              -- the validated scope object
  details_json     TEXT NOT NULL,              -- kind-specific; amounts are integers in minor units
  rationale        TEXT NOT NULL CHECK (length(rationale) BETWEEN 1 AND 1000),
  author_actor_id  TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,
  review_at        INTEGER,
  revoked_at       INTEGER,
  revoked_by       TEXT,
  revoke_reason    TEXT CHECK (revoke_reason IS NULL OR length(revoke_reason) BETWEEN 1 AND 500),
  version          TEXT NOT NULL DEFAULT 'memory-v0.1',
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX business_memory_entries_tenant ON business_memory_entries (tenant_id, created_at, id);

-- Lookup by vendor / case / record / series without scanning JSON.
CREATE TABLE business_memory_scope_refs (
  entry_id   TEXT NOT NULL REFERENCES business_memory_entries(id) ON DELETE CASCADE,
  tenant_id  TEXT NOT NULL,
  ref_type   TEXT NOT NULL CHECK (ref_type IN ('vendor','series','case','record')),
  ref_id     TEXT NOT NULL,
  PRIMARY KEY (entry_id, ref_type, ref_id)
);
CREATE INDEX business_memory_scope_refs_lookup ON business_memory_scope_refs (tenant_id, ref_type, ref_id);

-- Append-only audit history.
CREATE TABLE business_memory_events (
  entry_id  TEXT NOT NULL REFERENCES business_memory_entries(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  seq       INTEGER NOT NULL,
  at        INTEGER NOT NULL,
  action    TEXT NOT NULL CHECK (action IN ('created','revoked')),  -- 'expired' is derived at read time
  actor_id  TEXT,
  note      TEXT,
  PRIMARY KEY (entry_id, seq)
);
CREATE TRIGGER business_memory_events_no_update BEFORE UPDATE ON business_memory_events
BEGIN SELECT RAISE(ABORT, 'business_memory_events is append-only'); END;
```

Notes for the migration: every query filters on `tenant_id` from the session; account deletion deletes by `tenant_id` (the cascade covers refs and events; the no-update trigger does not block deletes); revocation is an `UPDATE` of the three `revoked_*` columns guarded by `revoked_at IS NULL`, plus one event row, in one transaction. Rollback is dropping the three tables; nothing else depends on them.

---

## 6. Vendor profiles (`vendor-profile-v0.1`)

Derived, read-only, per `vendorKey` (the deterministic import key, `canonicalVendorId`; not a reviewed identity). Everything is *in the covered records*.

- **Names:** `displayNamesSeen` exactly as recorded (with record and case counts). `primaryName` = most frequent recorded name (ties: code-point order). Never merged across vendorKeys.
- **Spend:** per currency, `grossPaymentsMinor` = sum of kind `payment` rows; refunds/credits reported beside it (signed as recorded), never netted; unknown-kind rows counted, not summed. No currency is combined or converted; `UNKNOWN` is its own bucket.
- **Baselines:** see §7, one per currency with payments.
- **Recurring series:** detector series (`listRecurringSeries`) as recorded per audit, labelled *recurring, not flagged*, with in-effect `recurring_confirmation` entry IDs.
- **Recent change:** anchor = the latest date covered by any import. Recent window = the 90 days ending at the anchor; prior window = the 90 days before that. Computed only when one contiguous covered interval (import date ranges merged when the next starts no later than the day after the previous ends) contains both windows; otherwise `insufficient_history` + `window_not_covered`. `changeBps = round((recent − prior) / prior × 10000)`, null when prior is 0. UNKNOWN currency is never compared.
- **Cases:** one per `crossAuditKey` (most recently updated copy; ties lowest `caseId`). Counts by stage; `supportedPotentialInPlay` (supported cases not dismissed/recovered/not recovered) and `customerRecordedReturn` per currency, kept apart; `matchedReturn: 'not_available'`.
- **Evidence quality:** share (basis points) of the vendor's records with an invoice reference, a category, a known currency, a payment date. Data quality of the records, not a judgement about the supplier.
- **Memory:** in-effect and not-in-effect entries touching the vendor, with IDs, status and influence.

Ordering: primary name lower-cased, then vendorKey (code-point order). Cursor = last item's sort key. Display order is a design decision and may change.

## 7. Baselines (`baseline-v0.1`)

Per (vendorKey, currency), over dated `payment` rows with amount > 0. Constants (exported from `baselines.ts`):

| Constant | Value | Meaning |
|---|---|---|
| `BASELINE_MIN_PAYMENTS` | 5 | dated payments needed for `established` |
| `BASELINE_MIN_COVERED_MONTHS` | 3 | distinct calendar months with a payment |
| `SEASONAL_MIN_MONTHS` | 24 | two yearly cycles; the audit asks for ≥ 12 before any seasonal modelling, one cycle cannot separate season from change. Seasonal comparison is `not_supported` in v0.1 regardless (`seasonal_model_not_implemented` at ≥ 24) |
| `BASELINE_MAD_K` | 3 | range = median ± max(k·MAD, floor) |
| `BASELINE_MIN_TOLERANCE_BPS` | 500 | floor = ceil(5% of median); handles MAD = 0 |

Median and MAD use the **lower-middle** value for even counts (an integer that occurred; no averaging). Cadence = lower-middle median of day gaps between consecutive dated payments. Undated payments are counted (`undatedPaymentCount`, reason `missing_dates`) and excluded from statistics. UNKNOWN currency never establishes. `compareToBaseline` returns `within_range` / `above_range` / `below_range` with `ratioBps = round(amount / median × 10000)`, or `insufficient_history`. These are presentation inputs only; they do not alter detection or its thresholds.

## 8. Known limitations

- In-memory store only; nothing survives a restart. No HTTP route.
- Scope existence is checked against the legacy adapter, which drops cross-audit repeat rows, so records only present as repeats cannot be scoped.
- Import date ranges come from payment dates, not declared import periods, so a quiet week between imports reads as a coverage gap (conservative).
- Proposals go nowhere until the detection owner publishes an intake contract (interface request S-6).
