# Recovery automation & secure AI: interface contracts

Workstream 02 (owner: Jagan). Contract version **0.1-proposed**, base `main` @ `a1b976e`, branch `workstream/recovery-ai`.
Everything here is a proposal for Sid and Aditya to accept or change. Items marked **FIXTURE** stand in for something another founder owns and must not be described as integrated.

## Ownership map (files this workstream creates or changes)

| Area | Files | Owner |
|---|---|---|
| Tenant context (fixture adapter) | `server/tenant.ts` | Sid replaces `tenantForUser` with real org/roles |
| Sealed JSON at rest, canonical hashing | `server/sealedJson.ts` | Jagan (same scheme as `projectStore.ts`) |
| AI gateway: policy, consent, ledger, providers, validators, pseudonymisation, tasks | `server/aiGateway/**` | Jagan; the only provider path |
| Case read helpers | `server/recoveryFacts.ts` | Jagan |
| Action proposals & approval queue | `server/approvals.ts` | Jagan (backend); Aditya (inbox UI) |
| HTTP for the above | `server/recoveryRoutes.ts` | Jagan |
| Shared route-group deps | `server/workstream.ts` | Jagan |
| Jobs / scheduler (J3) | `server/jobs/**` | Jagan; Sid and Aditya register handlers |
| Inbound replies (J4) | `server/inbound/**` | Jagan |
| Documents & evidence intelligence (J5) | `server/documents/**` | Jagan; facts handed to Sid |
| Shared entry points touched | `server/app.ts` (one wiring block, `/api/ai/draft` body) | coordinate |

Not touched: detection, ledger/import, eligibility rules, money calculations, case state machine (`caseCommands.ts`, `caseState.ts`, `model.ts`), Gmail send logic, UI.

## Tenant context — FIXTURE
`TenantContext { tenantId, actorId, actorLabel, permissions, source }`. Today `tenantId = user.id` and the single user holds every permission (`source: 'single_user_fixture'`). Jobs act through `systemContext(tenantId, job)`: `case.read` + `case.propose` only, never approve.
Permissions: `case.read, case.propose, case.approve, ai.invoke, ai.manage, jobs.manage, documents.write, inbound.read`.
**Request to Sid:** organisation + membership + role primitives; we only need `tenantForUser(user) → TenantContext` from you.

## AI execution (J1)

- Policy per tenant: `off` (default, existing accounts included) | `on_demand`. Changing it bumps `version` and revokes every consent. Automatic external processing is the constant `AUTOMATIC_EXTERNAL_AI_ENABLED = false`; a `trigger: 'automatic'` call always falls back.
- Consent: `packet` (one use, exact `packetHash`, case-scoped, 1 h) or `field_set` (standing, bound to task + purpose + `fieldSetHash` + provider + model + policy version; revocable). Any change to a task's field list, purpose, provider or model invalidates standing consents.
- Every task: input schema → server-built packet from the stored case → size cap → consent → budgets (per day count and tokens, concurrency) → provider (timeout, ≤1 retry on transient) → output schema → task validators → local restoration of pseudonyms. Failures fall back to the task's deterministic answer.
- Ledger `ai_invocations`: tenant, actor, task+version, provider, model, policy version, consent id, project/finding, **packet hash**, outcome, validation codes, attempts, tokens. No packet, prompt or output text.

HTTP (all signed-in, tenant-scoped):

| Method & path | Body | Result |
|---|---|---|
| `GET /api/ai/policy` | | `{ policy, consents, tasks }` |
| `PUT /api/ai/policy` | `{ mode, acknowledged: true }` | `{ policy }` |
| `GET /api/ai/tasks` | | `{ tasks: [{ id, version, purpose, fields, fieldSetHash, permission, provider, model }] }` |
| `POST /api/ai/tasks/:task/preview` | `{ projectId, findingId, input }` | exact pseudonymised packet + `packetHash`, `fieldSetHash`, provider, model |
| `POST /api/ai/tasks/:task/consent` | `{ scope, packetHash?, projectId?, findingId? }` | `{ consent }` |
| `POST /api/ai/consents/:id/revoke` | | `{ ok }` |
| `POST /api/ai/tasks/:task/run` | `{ projectId, findingId, input, consentId? }` | `{ source: 'ai', result, invocationId }` or `{ source: 'deterministic', result, code, reason }` |
| `GET /api/ai/invocations` | | ledger rows |
| `POST /api/ai/draft` (existing browser contract, unchanged shape) | as before | `{ subject, body, invocationId }`; `403 ai_off`, `409 ai_consent_required` |

Registered tasks: `draft_recovery_request` (J1). J4 adds `classify_supplier_reply`; J5 adds `extract_document_facts`, `summarize_case_evidence`, `second_look`. Groups register their tasks from their own `create*Routes`.

Validators (`server/aiGateway/validators.ts`): money in `$`, `USD`, `US$`, "dollars", `k`/`million`, other currencies and percentages; links and bare domains; emails and phone numbers; bank details (IBAN, routing/account wording, long digit runs); commitments; legal threats and accusations (outbound); written dates; unknown `[[TOKENS]]`; forged record ids.

## Approval queue (J2)

`action_proposals` (+ append-only `action_proposal_events`). Payload sealed at rest; `payloadHash` over canonical JSON; bound to the case **fingerprint** (hash of finding, evidence, source rows and case state — other cases changing doesn't stale it) and the project revision at creation.

Payload kinds: `case_command` (`vendor_update | followup | followup_days | contact_hold | settlement | close | reconcile`), `approve_request` (the existing exact package), `send_request`, `send_follow_up` (exact to/cc/subject/body/generation/sequence).

Who may propose what: user → anything; job → follow-up drafts and follow-up dates; inbound/AI → vendor status, follow-up date, contact hold (inbound) and follow-up drafts (AI); document → vendor status; `return_match` (Sid) → settlement only. Nothing but a person or the return matcher proposes money; nothing but a person approves.

Lifecycle: `pending → executing → executed | failed`; `pending → rejected | expired | stale | superseded`. Approve = `POST /api/approvals/:id/approve { payloadHash }`: checks expiry, separation of duties (on for non-fixture tenants), and that the case fingerprint is unchanged, then executes through `CaseCommands.execute` (command id fixed per proposal, so idempotent) or the existing Gmail routes via internal dispatch as the approving person (exact-version and single-send checks unchanged), then records the Gmail receipt with a derived, stable command id.

| Method & path | Notes |
|---|---|
| `GET /api/approvals?status=&projectId=&findingId=` | account-wide queue; `stale` computed on read |
| `POST /api/approvals` | a person's proposal (`origin` forced to `user`) |
| `GET /api/approvals/:id`, `GET /api/approvals/:id/events` | |
| `POST /api/approvals/:id/approve` | `{ payloadHash }` |
| `POST /api/approvals/:id/reject` | `{ note }` |
| `POST /api/approvals/:id/edit` | `{ payload }` → new proposal, old one `superseded` |

## Requests to other founders

- **Sid** — (1) tenancy/roles to replace `server/tenant.ts`; (2) a typed `ReturnMatch` result (proposed/verified, partial, reversed) we turn into `return_match` settlement proposals — we will not match money ourselves; (3) validated facts for overpayment and unapplied-credit gates; (4) a `verifyProposedFacts()` entry point for document extraction (J5); (5) migration review of the new tables: `ai_policies, ai_consents, ai_invocations, action_proposals, action_proposal_events` (+ J3–J5 tables); (6) a settlement-reversal transition in the case model (we won't edit `caseState.ts`/`financials.ts`).
- **Aditya** — approval inbox UI over `/api/approvals`; AI settings + consent preview screen over `/api/ai/policy`, `/preview`, `/consent`; the "Draft with AI" button can now be enabled before approval (`RecoveryPanels.tsx` still requires approval first) and should show the `ai_off` / `ai_consent_required` messages.
