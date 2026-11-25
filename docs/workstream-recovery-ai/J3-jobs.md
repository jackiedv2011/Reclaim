# J3: Durable background jobs and follow-up orchestration

Workstream 02 (owner: Jagan). Branch `claude/j3-jobs-04f650`, cut from `workstream/recovery-ai` @ `55322c0`. Code lives only in `server/jobs/`.

## What this adds, and what it doesn't

Reclaim can now do recovery work on a schedule: find follow-ups that are due, prepare the exact follow-up letter, remind the customer about cases that need them, flag evidence gaps, and send an opt-in daily digest.

It does **not** send supplier email, move money, edit books or move a case forward. The furthest a job goes is putting an exact follow-up in the approval queue (`server/approvals.ts`, origin `job`). A person approves that exact payload, and the existing Gmail route sends it with its own checks. A prepared or queued follow-up is never recorded as sent.

Nothing runs on its own. `app.ts` builds the job system when it registers the routes, but nothing starts a scheduler. Jobs run only when something calls `runDue` or `tick`. Today that means the tests, which use a fake clock.

## Files

| File | What it holds |
|---|---|
| `server/jobs/runner.ts` | `JobRunner`: tables, `register`, `enqueue`, `claim`, `runDue`, `cancel`, checkpoints, lease recovery, backoff, `startScheduler` helper |
| `server/jobs/handlers.ts` | `recovery.scan`, `recovery.reminder`, `recovery.prepare_follow_up`, `recovery.collect_evidence`, `notify.digest`; `planDailyScans`, `planDigests` |
| `server/jobs/notifications.ts` | `NotificationStore` (notifications + preferences), `DigestTransport`, `RecordingDigestTransport`, time-zone helpers |
| `server/jobs/system.ts` | `createJobSystem` wires runner, handlers and notifications for one database; `jobSystemFor(db)` returns it |
| `server/jobs/routes.ts` | `createJobRoutes` (already registered in `app.ts`) |
| `server/jobs/followUpText.ts` | Server copy of `generateFollowUp`. A test checks it gives exactly the same text (request 1 below) |
| `server/jobs/testFixtures.ts` | Synthetic cases for the tests (made-up supplier, address and amount) |

## Tables

All of them carry `user_id NOT NULL REFERENCES users(id) ON DELETE CASCADE`, so `deleteAccount` (which deletes from every table with a `user_id` column) and the foreign key both remove them. A test covers this.

**`jobs`**: `id`, `user_id`, `kind`, `payload` (JSON), `idempotency_key`, `run_at`, `status` (`queued | leased | done | failed | cancelled | dead`), `attempts`, `max_attempts`, `lease_owner`, `lease_until`, `checkpoint` (JSON), `last_error_code`, `result_code`, `cancel_requested`, `defers`, `timeout_ms`, `created_at`, `updated_at`.
- `UNIQUE (user_id, kind, idempotency_key)`: enqueue is idempotent.
- Partial unique index `jobs(user_id) WHERE status = 'leased'`: the database itself stops a tenant from having two running jobs.
- Indexes: `(status, run_at)`, `(user_id, created_at)`.

**`job_events`** (append-only; a trigger rejects `UPDATE`): `user_id`, `job_id`, `at`, `event`, `code`, `attempt`. Event types: `enqueued`, `claimed`, `succeeded`, `deferred`, `retry_scheduled`, `failed`, `dead_lettered`, `lease_expired`, `lease_lost`, `cancel_requested`, `cancelled`.

**`notifications`**: `id`, `user_id`, `dedupe_key` (unique per user), `kind`, `project_id`, `finding_id`, `ref_id` (a proposal id), `detail` (JSON, whole-number counts only), `due_at`, `created_at`, `read_at`. Kinds: `follow_up_due`, `follow_up_prepared`, `awaiting_approval`, `proposal_pending`, `vendor_reply`, `unreconciled_return`, `evidence_gap`.

**`notification_preferences`**: `user_id` (PK), `digest_enabled` (default **0**), `time_zone` (IANA, default `UTC`), `local_hour` (0–23, default 8), `last_digest_on` (local `YYYY-MM-DD`), `updated_at`.

### What is never stored in these tables
Job payloads, checkpoints and notifications hold only ids, fingerprints, dates and counts. On the way in, `assertRefsOnly` rejects:
- strings that don't match `[\w:.-]{0,500}` (spaces, `@`, `$`, `/` and commas all fail);
- anything nested deeper than 4 levels;
- anything larger than 4 KB.

Error columns hold short codes (`timeout`, `handler_error`, `digest_transport_failed`), never an exception message. A test runs the whole pipeline on a case with a distinctive supplier name, address, amount, invoice number, sender name and letter. It then checks that none of them appear in `jobs`, `job_events`, `notifications` or `notification_preferences`.

The letter itself lives only in the proposal, which `approvals.ts` seals at rest.

## Runner contract

```ts
const jobs = jobSystemFor(db)!            // built by app.ts via createJobRoutes
jobs.register('ledger.sync', {            // Sid; or 'analytics.rollup' for Aditya
  payloadSchema: z.object({ connectionId: z.string().regex(/^[\w-]+$/) }).strict(),
  maxAttempts: 5,                          // default 5 (1–25)
  timeoutMs: 60_000,                       // default 30 s (≤ 15 min)
  backoff: { baseMs: 60_000, maxMs: 3_600_000 }, // base·2^(attempt−1), capped
  async handler({ tenant, payload, signal, checkpoint, now, attempt, jobId }) {
    // tenant = systemContext(tenantId, kind): case.read + case.propose only.
    // Re-check permissions, the case version, approvals and freshness HERE.
    // Return { code } (short outcome), or { code, deferUntil } to come back later,
    // or throw JobError('code', { retryable }) / anything else (→ 'handler_error', retried).
  },
})
jobs.enqueue(tenantId, 'ledger.sync', { connectionId }, { idempotencyKey: `sync:${connectionId}:${day}`, runAt: now })
```

- **Kinds** look like `area.action`. A runner only claims kinds it has registered, so two processes with different handlers can share one queue.
- **Enqueue** checks the payload against the schema and `assertRefsOnly`, and checks the tenant exists. The same `(tenant, kind, idempotencyKey)` returns the existing job (`created: false`) whatever its state, so put whatever makes the work distinct in the key: a case fingerprint, a local date.
- **Claim** runs inside `BEGIN IMMEDIATE`. It picks the oldest due job of a known kind whose tenant has nothing running, then gives it a lease of `timeout + 30 s` (`LEASE_GRACE_MS`) and counts the attempt.
- **runDue(now, owner)** takes back expired leases, then claims and runs due jobs one after another, up to `limit` (default 100). Several workers can call it on the same file at the same time; the leases keep them apart. Jobs that a handler enqueues for "now" (scan → per-case jobs) run in the same pass.
- **Timeout**: the `AbortSignal` fires after `timeoutMs` and the run is recorded as `timeout`. The handler's promise is abandoned, so handlers must pass the signal on and make their side effects idempotent. The approval queue's `dedupeKey` does that for proposals.
- **Retry**: a retryable failure goes back to `queued` with backoff. When attempts run out it becomes `dead` (dead-lettered). A non-retryable `JobError`, a 4xx `HttpError` other than 409/429, or an invalid payload makes it `failed` straight away.
- **Expired lease** (the worker crashed): the job goes back to `queued` with backoff and `last_error_code = 'lease_expired'`, or to `dead` if it is out of attempts. If a worker finishes after losing its lease, its result is thrown away and it records `lease_lost`.
- **Cancel**: a queued job becomes `cancelled` at once. A running job gets `cancel_requested`; its signal is aborted if it runs in this process, and it ends `cancelled` whatever it returns. Cancelling twice is harmless. Finished jobs are left as they are.
- **Checkpoint**: `ctx.checkpoint.set(value)` is saved immediately, and only by the worker that holds the lease. The next attempt reads it back. It follows the same ids-only rules as payloads.
- **Defer**: `{ deferUntil }` puts the job back without using up an attempt. It runs again no sooner than one minute later, and it can defer at most 20 times (`MAX_DEFERS`). After that the job closes as `done` / `defer_limit`.

## Recovery handlers

All of them act as `systemContext(tenantId, kind)` and read the case through `storedCase()` (`server/recoveryFacts.ts`). Only findings classified `recovery_candidate` are considered: internal reviews never get reminders or outreach. Sample audits are skipped.

**`recovery.scan`** `{ projectId? }`: the planner, which plans one tenant at a time.
- It walks `deps.projects.list(tenant)` in project-id order and checkpoints after each project, so a crash resumes where it stopped.
- For each case it enqueues:
  - a `recovery.reminder` when the case has a reason to remind, or pending proposals. The key is `reminder:<project>:<finding>:<hash of fingerprint + reasons + proposal ids>`.
  - a `recovery.prepare_follow_up` when `followUpStatus` says the follow-up is due and its sequence number is 5 or less. The key is `follow_up:<project>:<finding>:g<generation>:s<sequence>:<fingerprint>`.
  - a `recovery.collect_evidence` when a confirmed case fails `evaluateEligibility`. The key is `evidence:<project>:<finding>:<fingerprint>`.
- Because the fingerprint is in every key, a rerun never duplicates work, and a changed case gets fresh jobs.

**`recovery.prepare_follow_up`** `{ projectId, findingId, fingerprint, generation, sequence }`. At run time it checks the following in order. Every "no" ends the job `done` with that code and **no proposal**:
- the case still exists and its fingerprint is unchanged (`skipped_case_gone`, `skipped_case_changed`);
- not a sample audit (`skipped_sample`); same request generation (`skipped_generation_changed`); a recovery candidate (`skipped_not_recovery`);
- the stage is `requested`, which rules out closed and recovered cases (`skipped_case_closed`);
- no revalidation needed (`skipped_revalidation`); no contact hold (`skipped_contact_hold`);
- the supplier's latest position doesn't need the customer's action: disputed, documents requested, payment not found, wrong contact, already refunded, partial acceptance, says resolved, credit issued (`skipped_vendor_needs_action`);
- no supplier reply since the last email (`skipped_vendor_replied`);
- the same sequence number the job was planned for (`skipped_sequence_changed`); at most `MAX_FOLLOW_UPS = 5` (`skipped_follow_up_limit`);
- due now. If not, it defers until `dueAt` (`not_due`);
- `authorizedFollowUpFacts` allows it, which also covers a request settled in full (`skipped_not_authorized`), and there is a recipient (`skipped_no_recipient`);
- Gmail's own records: no follow-up is sending or uncertain (`skipped_send_in_flight`), and the count of sent follow-ups equals sequence − 1 (`skipped_sequence_mismatch`);
- at least `MIN_FOLLOW_UP_GAP_MS = 24 h` since the last email, counting Gmail's record of the request and follow-ups as well as the case's own. If not, it defers until the 24 hours are up (`deferred_min_gap`);
- no follow-up for this sequence and generation already pending and current in the queue, whoever prepared it (`already_proposed`).

It then builds the letter with the deterministic `generateFollowUp` text. The sender name and business come from the `users` row. The recipient and cc come from `authorizedFollowUpFacts`. It calls:

```ts
approvals.propose(systemContext(tenant, 'recovery.prepare_follow_up'), {
  origin: 'job', payload: { kind: 'send_follow_up', to, cc, subject, body, generation, sequence },
  dedupeKey: `job:follow_up:<project>:<finding>:g<gen>:s<seq>:<fingerprint>`, reason, sourceRefs: ['job:<jobId>'] })
```

It also leaves a `follow_up_prepared` notification. If the person rejected an earlier proposal for the same case version, the dedupe key returns that rejected proposal (`already_decided`). The job does not ask again until the case changes. Once the case changes, the old proposal shows `stale: true` and approving it fails with `proposal_stale`; the next scan prepares a new one from the current case.

**`recovery.reminder`** `{ projectId, findingId, fingerprint }`: re-reads the case and adds one notification per reason:
- `follow_up_due` (key includes generation, sequence and due date);
- `awaiting_approval` (confirmed, not approved, no hold);
- `vendor_reply` (the latest position needs action; key includes the reply time);
- `unreconciled_return` (recovered with no verified return, or not reconciled);
- `proposal_pending` (one per pending, non-stale proposal).

**`recovery.collect_evidence`** `{ projectId, findingId, fingerprint }`: adds an `evidence_gap` notification with `{ missing, contradictions }` counts only. It is an internal task; nothing else happens.

**`notify.digest`** `{ localDate }`, keyed `digest:<localDate>`:
- `planDigests(now)` enqueues one for each subscriber whose local hour has come today, in their own IANA zone, and who hasn't had today's.
- The handler checks again that the digest is still enabled, that it is still that date locally and the hour has come (if not, it defers 15 min), and that today's hasn't already gone.
- It counts unread notifications that are already due (`due_at` empty or no later than now) and sends `{ localDate, timeZone, total, items: [{ kind, count, links }] }` through the injected `DigestTransport`. Links are relative `/audit?project=…&case=…`.
- The transport gets the tenant id, not an address, plus an idempotency key `digest:<tenant>:<date>`.
- On a transport error it retries with backoff, at most 4 attempts. If no transport is configured it ends `skipped_no_transport` and does not mark the digest sent.
- Only `RecordingDigestTransport` exists. **No real email.**

## HTTP (signed-in, tenant-scoped through `deps.tenantFor(deps.requireUser(req))`)

| Method & path | Permission | Result |
|---|---|---|
| `GET /api/jobs?status=` | `case.read` | `{ jobs: JobView[] }` (latest 100; no payloads) |
| `GET /api/jobs/:id` · `GET /api/jobs/:id/events` | `case.read` | `{ job }` · `{ events }`; 404 for another tenant's |
| `POST /api/jobs/:id/cancel` | `jobs.manage` | `{ job }` (cancelled, or running with `cancelRequested`); 404 not yours; 409 `job_finished` |
| `POST /api/jobs/scan` | `jobs.manage` | 202 `{ job }` (queued, **not run**); 200 same job within the same minute |
| `GET /api/notifications?unread=1` | `case.read` | `{ notifications: NotificationView[], unread }` |
| `POST /api/notifications/:id/read` | `case.read` | `{ notification }`; 404 not yours |
| `GET /api/notifications/preferences` | `case.read` | `{ preferences: { digestEnabled, timeZone, localHour, lastDigestOn } }` |
| `PUT /api/notifications/preferences` | `jobs.manage` | body `{ digestEnabled, timeZone, localHour }`; 400 on an unknown zone or an hour outside 0–23 |

`JobView`: `id, kind, status, attempts, maxAttempts, runAt, lastErrorCode, resultCode, cancelRequested, createdAt, updatedAt`. `NotificationView`: `id, kind, projectId, findingId, refId, detail, dueAt, createdAt, readAt, link`. These are data APIs only; Aditya owns the screens.

## Operations notes

**Running it.** Nothing in `index.ts` or `app.ts` starts jobs, deliberately. A deployment that wants them has two options:
- **In-process:** after `createApp`, call `startScheduler((now) => jobSystemFor(app.db)!.tick(now, \`web-${process.pid}\`), { intervalMs: 60_000 })`. `tick` plans the daily scans (one per tenant per UTC day) and due digests, then calls `runDue`. The timer is `unref`'d and never runs two ticks at once.
- **Separate worker:** a small `server/worker.ts` opens the same database file, builds the same deps and runs that loop. Not written. Adding a process is a founder decision (pilot checklist).

A digest transport is set with `jobSystemFor(db)!.setDigestTransport(t)`. Until a provider is approved it stays unset, so digests are planned but marked `skipped_no_transport`.

**Single writer.** SQLite allows one writer at a time. Every queue change is a short `BEGIN IMMEDIATE` transaction, and handlers run outside any transaction. That means a slow handler never holds the write lock, but it also means:
- Throughput is bounded by write transactions per second on one file (comfortably thousands per minute here).
- Workers must be processes on the **same host** sharing the file. Network file systems break SQLite locking.
- `runDue` runs jobs one at a time per call. To run more in parallel, call it from more processes or more loops; there is still at most one job per tenant.
- After a crash, jobs come back when their lease runs out: timeout + 30 s.
- At-least-once execution: a handler can run again after a crash or timeout. Handlers here are idempotent through notification dedupe keys and proposal dedupe keys. A real digest transport must honour the idempotency key.

**Watching it.** Look for `dead` and `failed` jobs (`SELECT kind, last_error_code, COUNT(*) FROM jobs WHERE status IN ('dead','failed') GROUP BY 1,2`). `job_events` has the history.

**Retention** is not implemented. A later pass should prune `done` / `cancelled` jobs and their events after N days.

**Moving to Postgres** would change:
- `BEGIN IMMEDIATE` + `SELECT … LIMIT 1` becomes `SELECT … FOR UPDATE SKIP LOCKED` inside a short transaction, so many workers on many hosts can claim at once.
- The partial unique index ports as is (`CREATE UNIQUE INDEX … WHERE status = 'leased'`).
- `ON CONFLICT DO NOTHING` stays the same.
- Leases should use the database clock (`now()`), not each worker's.
- `LISTEN/NOTIFY` could wake workers instead of polling.
- The append-only trigger becomes a `REVOKE UPDATE` on `job_events` plus a trigger.
- JSON columns become `jsonb`.
- The handler contract and the HTTP API do not change.

## Tests

All tests use in-memory SQLite, synthetic fixtures and a fake clock. They make no network calls and send no email.

```bash
npx tsc -p tsconfig.server.json --noEmit
```
```bash
npx oxlint server/jobs
```
```bash
npx vitest run server/jobs
```
```bash
npx vitest run server
```

Results on this branch (2026-11-25):
- `tsc`: clean.
- `oxlint server/jobs`: exit 0, no findings.
- `vitest run server/jobs`: **4 files, 57 passed, 0 failed** (runner 19, handlers 27, followUpText 6, routes 5).
- `vitest run server`: **18 files, 260 passed, 0 failed**.

What they cover:
- **Runner:** idempotent enqueue (including after a job finished), the payload guard, bad registrations, a three-worker race (each job runs once, never two per tenant), the database refusing a second lease, not-yet-due and unknown kinds, a crashed worker's expired lease being recovered and then dead-lettered, a lost lease, backoff exactly as specified (capped) and dead-lettering with only a code stored, non-retryable failure, timeout through the signal, invalid payload at run time, cancelling queued and running jobs, other tenants unable to cancel, a checkpoint surviving a failure, deferral and its limit, append-only events, and the scheduler.
- **Handlers:** the exact proposal and that nothing is sent or recorded; no duplicate proposal across reruns, separately planned jobs, or after a rejection; every follow-up rule (not due, 24 h gap from case and from Gmail, 5 cap, hold, revalidation, dispute, documents requested, a reply, closed, recovered, settled, sample, generation, in-flight send, count mismatch); a stale proposal after the case changes (approval refused; the old job stops; a rescan proposes afresh); reminders for each reason without duplicates; the evidence task; resuming from a checkpoint; tenant isolation (a spy proves a tenant's jobs only read that tenant's data, and a job naming another tenant's project finds nothing); no secrets or names stored; digests by time zone and due date; digest off by default; retry without a second send; no transport.
- **Routes:** scan queued but not run, and deduped per minute; list, get and events; cancel limited to the tenant's own jobs (idempotent; 409 when finished); 401 without a session; notifications and preferences per tenant with validation; account deletion removing `jobs`, `job_events`, `notifications`, `notification_preferences` (and proposals) for that tenant only.
- **followUpText:** byte-identical to `generateFollowUp` across first and second follow-ups, partial return, credit, offset, missing draft or subject, and missing sender.

## Requests (changes outside `server/jobs/` that this work did not make)

1. **`src/lib/followUps.ts`** (Aditya / shared lib). Its `@/lib/format`, `@/recovery/financials` imports don't resolve under Node's type stripping or `tsconfig.server.json`, so the server can't import `generateFollowUp`. Switch them to relative `.ts` imports (as `src/recovery/model.ts` already does). Then delete `server/jobs/followUpText.ts` and its parity test, and import the original in `handlers.ts`.
2. **`server/account.ts` `exportAccount`** (owner of account export). Include the tenant's `notifications` (kind, ids, dates) and `notification_preferences` in the export. Deletion already covers them.
3. **Sid**: please review the migrations for `jobs`, `job_events`, `notifications` and `notification_preferences` (they join the list in contracts.md, request 5). Sync and scan handlers register through `jobSystemFor(db).register('ledger.…', …)`. When real tenancy lands, `systemContext` and `tenantId` are the only things the runner relies on.
4. **Aditya**: screens over `/api/jobs`, `/api/notifications` and `/api/notifications/preferences`. A digest opt-in with a time-zone picker; it defaults to the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`, and the server rejects unknown zones.
5. **Founders**: approve (or not) a running scheduler and a digest email provider. Until then nothing runs in production and no digest is delivered. A real `DigestTransport` would likely wrap `server/mailer.ts`, look the address up from the tenant id, and honour the idempotency key.
6. **`contracts.md`** (parent session): add a J3 section that links here and lists the four new tables. This session only edits this file.
7. **`server/approvals.ts`** (optional, Jagan). `list()` expires pending proposals as a side effect. The scan calls it as the system tenant, which is harmless but means a read-only job writes. A `listPending(tenant, filter)` without that write, or a separate expiry sweep, would be cleaner.
