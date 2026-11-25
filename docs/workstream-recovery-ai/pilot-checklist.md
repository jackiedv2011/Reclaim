# Pilot checklist: recovery automation & secure AI

Nothing on this list is done. Each item needs a named founder's explicit approval; none is implied by local tests passing.

| # | Gate | Owner | Status |
|---|---|---|---|
| 1 | Secure staging deployment with `DATA_KEY`, TLS, backups and a restore drill | Sid | not started |
| 2 | AI provider: verify model id (`ANTHROPIC_MODEL`), retention, no-training terms, DPA / zero-retention; one sandbox smoke call per task | Jagan | not started |
| 3 | Decide whether external AI is offered to pilots at all (on-demand only; automatic stays off) | founders | open |
| 4 | Inbound: choose provider, reply domain, DNS (MX/SPF/DKIM/DMARC), webhook secret storage and rotation, retention; then wire `INBOUND_WEBHOOK_SECRET` / `INBOUND_DOMAIN` | Jagan | open |
| 5 | Reply-To header in Gmail sends, included in the exact approved package | Jagan + Sid | not built |
| 6 | Google verification for `gmail.send`; live send test to a mailbox we own | Jagan | not started |
| 7 | Scheduler process and digest email provider (or keep manual) | founders | open |
| 8 | Real tenancy and roles; turn on separation of duties | Sid | not started |
| 9 | Return matching (`ReturnMatch`) and fact verification (`FactVerifier`) replace fixtures | Sid | not started |
| 10 | Security review: enforced CSP, plaintext localStorage cache, red-team prompt injection through ledger/reply/document text, permission review | all | not started |
| 11 | Privacy page and customer consent text describe AI policy, pseudonymisation, inbound replies and document retention accurately | Aditya + legal | not started |
| 12 | Cost controls: per-tenant AI budgets set from real usage; alerts | Jagan | defaults only |
| 13 | Data handling plan: synthetic or consented, de-identified pilot data only; deletion/export verified for every new table | Sid | partial (deletion covered) |
| 14 | Release approval for the exact scope shipped | founders | open |
