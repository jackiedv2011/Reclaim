# Workstream 02 handoff: recovery automation & secure AI

Owner: Jagan. Branch `workstream/recovery-ai` (local only, not pushed), base `main` @ `a1b976e` (2026-11-25). Contract v0.1-proposed: `contracts.md`.
Detailed designs: `J3-jobs.md`, `J4-inbound.md`, `J5-documents.md`. Pre-pilot gates: `pilot-checklist.md`.

> Everything below is **verified locally** with synthetic data, mock providers, a fake Gmail and signed fixture webhooks. Nothing was deployed, no live provider was called, no supplier was contacted, no real customer data was opened. Green tests do not prove real-world results.

## Executive summary (for Jagan)

- **External AI is off for every account by default**, existing ones included. An owner must turn it on and consent to a task, either once for the exact data shown in a preview or for the task's listed fields until revoked. Automatic AI processing is a code constant set to false.
- **"Draft with AI" works before approval** and no longer sees real names: supplier, invoice numbers, dates and the sender are placeholders that Reclaim fills in locally; the sender's email is never sent; ledger free text never reaches the model. Every AI output is checked for unsupported amounts (any format), links, contact/bank details, dates, threats, accusations and invented placeholders. Every invocation is logged by hash, never by content.
- **One approval queue** for everything consequential: approve a request, send it, send a follow-up, record a vendor reply, a return, a closure. Each item is bound to its exact payload and the case's current state; if the case changes it goes stale. Execution runs the existing case commands and Gmail checks, so nothing bypasses the old controls. Supplier text and AI can only *suggest* a status or follow-up; only a person or Sid's return matcher can propose money, and only a person approves.
- **Jobs** prepare follow-up drafts and reminders and put them in the queue; nothing sends. No scheduler runs anywhere.
- **Supplier replies** can arrive at a per-case reply address through a signed webhook; spoofed, unsigned, replayed or mismatched mail is quarantined; replies become suggested status updates for approval. Not live: needs a provider and domain.
- **Documents** can be uploaded safely, read into *proposed* facts with line-level provenance for Sid to verify, and summarised with citations. PDFs are stored but not read (no PDF/OCR reader).
- **Decisions for you:** inbound provider + domain/DNS; whether a scheduler and digest email should run; AI provider terms (retention, no-training, DPA) before any pilot; whether automatic AI is ever on the roadmap.

## Status (execution ledger)

| Item | Status | Evidence |
|---|---|---|
| J0 preflight, baseline, contracts | **verified locally** | Baseline on `main`: 77 files / 952 tests pass on Node 24.22 (the audit's 5 failing live-server suites load here: the `node:sqlite` bundling issue is a Node 22 behaviour). tsc clean, oxlint 0 errors. |
| J1 AI gateway & privacy | **verified locally** | `server/aiGateway/**`, 15 gateway tests + draft tests in `app.test.ts` / `security.test.ts` |
| J2 lifecycle & approval backend | **verified locally (backend)**; extended gates **blocked on Sid**; settlement reversal **blocked on Sid** | `server/approvals.ts`, `recoveryRoutes.ts`, 8 queue tests, e2e |
| J3 jobs & follow-ups | **verified locally**; production scheduler **deferred (founder decision)** | `server/jobs/**`, 57 tests |
| J4 inbound & classification | **verified locally with fixtures**; live provider **blocked (decision)**; Reply-To in sends **not done** | `server/inbound/**`, 47 tests; rules: 43/43 on the tuning corpus; the only out-of-sample figure is the frozen first run on a second set, 35% exact with 2/20 wrong proposals. Both sets now give 0 wrong proposals, but the second set is no longer out-of-sample (J4 doc) |
| J5 documents & evidence intelligence | **verified locally**; Sid's verifier **FIXTURE**; PDF/OCR **not supported** | `server/documents/**`, 55 tests |
| J6 integration & hardening | **verified locally** | `server/e2e/recoveryFlow.test.ts` (3 scenarios); full suite below |

## Commits on `workstream/recovery-ai`

| Commit | What |
|---|---|
| `55322c0` | Foundation: gateway, consent, ledger, draft task, approval queue, routes, contract |
| `2f3f105` | Packet-only consent scopes, read-only queue listing, gateway + queue tests |
| `d41fd62` | Merge J3 (`claude/j3-jobs-04f650`: runner, handlers, notifications, routes, doc) |
| `8d7f206` | Merge J4 (`claude/j4-inbound-91ff98`: sanitizer, classifier, corpus, webhook, AI task, doc) |
| `5065ad2` | Merge J5 (`claude/j5-documents-c7e62b`: intake, extraction, summaries, AI tasks, doc) |
| (this commit) | J5 extraction uses gateway packet-only consent; unnamed runs use a matching one-time consent; J6 end-to-end test; handoff docs |

## Test results (local, serial)

```bash
npx tsc -p tsconfig.server.json --noEmit && npx tsc -p tsconfig.app.json --noEmit   # 0 errors
npx oxlint                                                                           # 0 errors (pre-existing landing-site warnings only)
npx vitest run --no-file-parallelism                                                 # 91 files, 1139 tests passed, 0 skipped
```

Per area: `server/aiGateway` 15 · `server/approvals.test.ts` 8 · `server/jobs` 57 · `server/inbound` 47 · `server/documents` 55 · `server/e2e` 3 · `server/app.test.ts` 30 · `server/security.test.ts` 25.
Observed flake: `server/app.test.ts › an expired session is refused and its cookie cleared` failed once in five full runs and never alone (timing; not touched by this work).

## The end-to-end scenario (synthetic)

`server/e2e/recoveryFlow.test.ts`: AI off → preview shows a packet with no names → one-time consent → draft before approval (consent then spent) → reviewer edits and approves the exact package → an altered send is refused by the Gmail route (nothing sent) → the exact version is sent once (fake Gmail) and the receipt recorded → 8 days later the job prepares one follow-up (a rerun doesn't duplicate) → approved and sent → a spoofed reply with prompt injection is quarantined → the genuine reply becomes a `promised` suggestion that changes nothing until approved, and quoted history ($9,999) is ignored → FIXTURE return matches: $2,000 (partial), a duplicate match refused, $4,800 → recovered → reconciled. Audit trails contain no supplier names, invoice numbers, amounts or reply text; payloads are sealed.
Negative scenarios: uncertain Gmail send (proposal failed, case unsent, retry held); missing evidence blocks drafting and approval; rejected proposal changes nothing; no AI call made.

## New tables (for Sid's migration review)

All additive `CREATE TABLE IF NOT EXISTS`, every row carries `user_id` so account deletion (`deleteAccount`) removes it. Rollback: drop the tables; nothing existing was altered.

| Table | Module | Holds |
|---|---|---|
| `ai_policies`, `ai_consents` | aiGateway/policy.ts | mode + version; consents (task, scope, purpose, field-set hash, packet hash, provider, model, policy version) |
| `ai_invocations` | aiGateway/ledger.ts | hashes, outcomes, codes, token counts; no text |
| `action_proposals`, `action_proposal_events` | approvals.ts | sealed payloads, hashes, case fingerprint, lifecycle |
| `jobs`, `job_events` | jobs/runner.ts | refs-only payloads, leases, retries |
| `notifications`, `notification_preferences` | jobs/notifications.ts | counts/ids only; digest opt-in default off |
| `inbound_routes`, `inbound_webhook_seen`, `inbound_messages` | inbound/store.ts | token hashes, replay guard, sealed sanitized replies |
| `documents`, `proposed_facts` | documents/store.ts | sealed content, sha256, retention; untrusted facts |

## Security and consent controls

- Tenant from the server session only (`server/tenant.ts`, FIXTURE until Sid's roles); every query filters on `user_id`; jobs and webhooks act through `systemContext` (read + propose, never approve).
- AI: off by default; consent bound to task, purpose, fields, provider, model, policy version (and packet for one-time); revocation and policy change end consents; budgets, timeout, ≤1 retry; output schema + validators; local restoration; ledger by hash. Default `ANTHROPIC_MODEL` (`claude-opus-5`) and provider terms are **unverified**.
- Approvals: exact payload hash, case fingerprint staleness, expiry, separation of duties ready for real roles, single execution (claim), fixed command ids (idempotent), origin rules (no money or closure from text or AI).
- Inbound: HMAC + timestamp, replay and duplicate guards, 1 MB cap, DMARC/DKIM and recipient-domain checks, generation/stage checks, sanitising, quarantined attachments by hash only.
- Documents: magic-byte sniffing, 2 MB cap, sealed at rest, retention, packet-only AI consent and line-level minimisation.

## Integration order

1. Sid reviews the tables above and the `tenant.ts` seam; merges his tenancy so `tenantForUser` returns real roles (separation of duties then switches on).
2. Land `reclaim-fixes` and this branch: one trivial `server/app.ts` import conflict (keep both import lists; drop the now-unused `authorizedDraftFacts` import). After it lands, `draftableRequest` (`server/recoveryFacts.ts`) should apply `claimContext` (linked claims) the way `authorizedRequest` does.
3. Sid's `ReturnMatch` → `return_match` settlement proposals; `FactVerifier` for J5; validated facts for overpayment/credit gates; a settlement-reversal transition.
4. Aditya's screens (approval inbox, AI settings/consent preview, inbound panel, evidence panel, notifications); enable "Draft with AI" before approval in `RecoveryPanels.tsx`.
5. Founder decisions + `pilot-checklist.md`, then wire `INBOUND_*` config and a scheduler.

## Requests collected from the sessions

**Sid:** tenancy/roles; migration review (table above); `ReturnMatch` results; `verifyProposedFacts` (J5 `FactVerifier`); overpayment/credit gate facts; settlement reversal; whether `wrong_contact` should also suggest a contact hold; job registration for sync/scan via `jobSystemFor(db).register(...)`.
**Aditya:** approval inbox (`/api/approvals`); AI settings + consent preview (`/api/ai/policy`, `/preview`, `/consent`); inbound panel and "Read with AI"; evidence/document panel; notifications + digest opt-in with time-zone picker; "Draft with AI" before approval; `src/lib/followUps.ts` relative `.ts` imports so the server can reuse it (then delete `server/jobs/followUpText.ts`).
**Jagan:** inbound provider/domain/DNS/secret rotation/retention; Reply-To in Gmail sends (changes the approved package); scheduler + digest provider; AI provider terms; account export should include notifications/preferences, AI consents and invocations, proposals.

## Remaining limitations

- No live provider, mailbox, domain, model or ledger has been exercised. Rule-based reply classification accuracy on real mail is unknown.
- Overpayment and credit cases still cannot be approved (gate is duplicates-only until Sid's facts exist).
- A verified return reversal has no case transition yet; until Sid adds one, a reversal must be handled by a person.
- Privacy page (`PrivacyPage.tsx`) does not yet describe the new AI policy, consent and pseudonymisation; Aditya/legal to update before customers see it.
