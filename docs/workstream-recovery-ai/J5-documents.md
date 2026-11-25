# J5 — Financial document and investigation intelligence

Workstream 02 (owner: Jagan). Branch `claude/j5-documents-c7e62b`, cut from `workstream/recovery-ai` @ `55322c0`. Everything lives in `server/documents/`; no file outside it was changed.

**What it is:** a person can attach a supplier document (invoice, remittance advice, supplier statement) to an audit or a case. Reclaim reads the labelled lines of text and CSV documents into *proposed facts*, each pointing at the exact line it came from. It writes a cited evidence summary and a "second look" listing ordinary explanations for the flag. Three opt-in AI tasks can do the same jobs through the gateway.

**What it is not:** none of this changes a case, its evidence or the ledger. Reading a document is never a reviewer attestation, and a fact is never authoritative. The evidence gate (`src/recovery/eligibility.ts`) is still the only thing that establishes an amount. A second look cannot dismiss, suppress or promote a case.

## Files

| File | Job |
|---|---|
| `sniff.ts` | Works out the real file type from its bytes, decodes base64 strictly, and cleans filenames |
| `store.ts` | `documents` and `proposed_facts` tables, sealed at rest, retention, deletion |
| `extract.ts` | Deterministic reader for text and CSV documents |
| `facts.ts` | Fact schema, conflict marking, the `FactVerifier` interface and the FIXTURE adapter |
| `summary.ts` | Deterministic cited evidence summary |
| `secondLook.ts` | Deterministic candidate explanations |
| `aiTasks.ts` | `summarize_case_evidence`, `second_look`, `extract_document_facts` |
| `routes.ts` | HTTP, registered by `createDocumentRoutes` (already wired in `app.ts`) |
| `fixtures.ts` | Synthetic documents and a test harness (tests only) |
| `*.test.ts` | 55 tests in 4 files |

## Intake

`POST /api/documents` requires a signed-in user with permission `documents.write`. Body:

```json
{ "projectId": "p1", "findingId": "exact_duplicate-p1", "kind": "invoice | remittance | supplier_statement | other", "filename": "x.txt", "contentBase64": "…" }
```

- The project, and the case if one is named, must be on the caller's own account; anything else is a 404. Unknown fields are a 400.
- Strict base64 only, at most 2 MB after decoding (413 above that). Empty files are a 400.
- **The type comes from the bytes alone.** The declared kind, the filename and its extension are never used to decide it.
  - **Parsed:** UTF-8 text (with or without a BOM). If most lines split into the same number of comma, semicolon or tab cells, it is treated as CSV.
  - **Stored but not read:** PDF (`%PDF-`). Its status is `unsupported_format`, with the note *"Stored, not read: Reclaim has no PDF or OCR reader…"*. Extraction returns 422 `unsupported_format`.
  - **Refused with 415 `document_<reason>`:**

    | Reason | What it covers |
    |---|---|
    | `executable` | PE/MZ, ELF, Mach-O, WebAssembly, dex |
    | `archive` | zip (so docx, xlsx, xlsm), rar, 7z, gzip, bzip2, xz, zstd, cab, tar |
    | `office_container` | OLE files such as .doc and .xls, which can carry macros |
    | `image` | PNG, JPEG, GIF, TIFF, BMP (there is no OCR) |
    | `rtf` | RTF documents |
    | `markup` | HTML, SVG, XML, and `javascript:`, `vbscript:` or `data:text/html` URLs |
    | `script` | shebang, PHP, ASP, batch files, VBA macro source, PowerShell and WScript patterns |
    | `binary` | NUL bytes or other control bytes |
    | `not_utf8` | UTF-16 or invalid UTF-8 |
- Duplicates are matched by SHA-256 of the bytes, per tenant. Uploading the same file again returns `200 { document, duplicate: true }`, pointing at the existing document, which may belong to another audit of the same account.
- Each audit holds at most 200 documents.
- Reclaim never fetches a link from a document, never executes one, and never forwards one anywhere. The bytes are stored and only ever read by the parser on this server.

`GET /api/documents?projectId=&findingId=` requires `case.read`. Each document comes back with `caseMissing` (the linked case is no longer in the saved audit) and its fact count. `GET /api/documents/:id` returns the document with its facts. `DELETE /api/documents/:id` requires `documents.write` and deletes the row and all its facts.

**Storage:** the filename and the content are sealed with `deps.sealer`, and the context string binds the tenant and the document id. The plain columns hold only id, tenant, project, case, kind, format, status, SHA-256, size, creator and times. The test harness sets a `DATA_KEY` and checks that neither the invoice number nor the filename appears in the stored rows.

**Retention:** `retention_until = created_at + 365 days`. Expired documents and their facts are deleted on the next request to these routes (`sweepExpired`). After a delete, SQLite can keep freed pages until it reuses them. With `DATA_KEY` set, those pages only ever held ciphertext. The retention period is a constant, `DEFAULT_RETENTION_MS`; making it a per-tenant setting needs a founder decision.

## Deterministic extraction (`extract.ts`)

`POST /api/documents/:id/extract` requires `documents.write`. Running it again on the same document gives the same fact ids, so reading twice does not duplicate anything.

Rules:
- A value is taken only from:
  - the text after a recognised label, for example `Invoice no:`, `Supplier ID:`, `Invoice date:`, `Due date:`, `Amount due:`, `Total due:`, `Amount paid:`, `Payment date:`, `Payment reference:`, `Credit note no:`, `Credit amount:`, `Applied to invoice:`, `Closing balance:`, `Currency:`;
  - the invoice, amount and date columns of a CSV table.
- **Amounts** need two decimals or a currency marker. A bare `$` does not establish the currency, because it could be USD, CAD, AUD or others. Currency comes only from an ISO code, `US$`, `€` or `£`.
- **Dates:** ISO, `5 March 2026`, `March 5, 2026`. A numeric date such as `03/04/2026`, which could be read day-first or month-first, is ambiguous and is never picked.
- **Conflicts:** if a one-per-document field (`SINGLE_FACT_KINDS`) has two different values, both are kept. Each one lists the other in `conflicts`, both drop to `low` confidence, and nothing is picked. The same value printed twice counts as one reading. Conflicts are recalculated over every fact on the document, whether the parser or the AI task read it.
- **Ambiguous lines:** Reclaim keeps a list of lines it could not read with confidence, each with a reason:

  | Reason | Meaning |
  |---|---|
  | `unlabelled_amount` | an amount with no label |
  | `label_without_value` | a label with nothing readable after it |
  | `several_values` | more than one amount on a label line |
  | `ambiguous_date` | a date that could be day-first or month-first |
  | `decimal_comma` | an amount written like `1.234,56` |

  These lines are the only text the AI extraction task can ever be sent.
- **Withheld lines:** no fact is read from these lines, and they are never sent anywhere:
  - `instruction_like`: "ignore all rules…", "system prompt", "you are an AI…", "say … is owed", and similar;
  - `bank_detail`: IBAN, SWIFT/BIC, routing, sort code or account numbers.

  Reclaim never takes bank details from a document.
- **Nothing is inferred.** A payment row is a payment row. The reader proposes no "owed", dispute or delivery fact, and a statement balance is labelled as the supplier's figure.
- `unknownFields` lists the fields expected for that kind of document that were not found. They are never guessed.

| Document kind | Expected fields |
|---|---|
| invoice | supplier_ref, invoice_ref, currency, invoice_date, due_date, amount_due |
| remittance | supplier_ref, payment_date, payment_ref, amount_paid, currency (plus repeatable rows) |
| supplier_statement | supplier_ref, statement_balance, currency |
| other | none |

### Fact schema

```ts
interface ProposedFact {
  id: string                    // fact_<32 hex>, stable for (document, origin, kind, line, offset, value)
  documentId: string
  kind: 'supplier_ref' | 'invoice_ref' | 'currency' | 'invoice_date' | 'due_date' | 'amount_due' | 'amount_paid'
      | 'payment_date' | 'payment_ref' | 'credit_note_ref' | 'credit_amount' | 'credit_applied_to' | 'statement_balance'
      | 'line_invoice_ref' | 'line_amount' | 'line_date'
  value: string                 // amounts "1250.00", dates "YYYY-MM-DD", references as written
  amountMinor?: number          // amounts only, sign kept as written
  row?: number                  // line_* kinds: the table row
  provenance: { line: number; charStart: number; charEnd: number; excerpt: string /* ≤120 chars */ }
  confidence: 'high' | 'medium' | 'low'
  conflicts: Array<{ value: string; line: number; factId: string }>
  origin: 'deterministic' | 'ai'
}
// API view adds: status 'proposed' | 'handed_off' | 'rejected', projectId, findingId, createdAt,
// verification { verifier, fixture, outcome, reason, at } | null, authoritative: false
```

The `proposed_facts` table holds id, tenant, document, project, case, kind, origin, status, confidence, the **case fingerprint at read time**, the AI invocation id, and the verifier's verdict. The value, row, provenance excerpt and conflicts are sealed, because they are document text.

## Hand-off to Sid: `FactVerifier`

`POST /api/documents/:id/facts/:factId/handoff` requires `documents.write`. It is refused with 409 `fact_stale` if the case fingerprint has changed since the document was read, and 409 `fact_not_proposed` if the fact was already handed off.

```ts
interface FactVerifier {
  readonly name: string
  readonly fixture: boolean
  verifyProposedFacts(tenant: TenantContext, projectId: string, facts: readonly ProposedFact[]):
    Promise<Array<{ factId: string; outcome: 'accepted' | 'rejected' | 'needs_review'; reason: string }>>
}
```

A `rejected` verdict retires the fact. Anything else marks it `handed_off` and records the verdict. **The hand-off never writes to the case.**

**FIXTURE:** `fixtureFactVerifier` (`fixture-shape-check`) checks shape only: a known kind, a well-formed value, a two-decimal amount, an ISO date and a source line. It answers `needs_review` for every well-formed fact and `rejected` for a malformed one. **It never accepts.** Every API response that involves it carries `fixture: true`.

**Request to Sid:**
1. Implement `verifyProposedFacts` against your ledger and source identity:
   - `invoice_ref` and `line_invoice_ref` → bill or obligation identity;
   - `supplier_ref` → stable supplier id;
   - `amount_paid` and `line_amount` → settled payments;
   - `credit_*` → vendor credits;
   - `statement_balance` → the supplier's own figure, which is never a debt.

   Pass it in as `createDocumentRoutes(deps, { verifier })`. That is a one-line change in `app.ts`, which we will coordinate.
2. Decide what `accepted` should *enable*. Today it only records the verdict. If an accepted fact should pre-fill evidence, it has to follow the QuickBooks pattern: an `EvidenceAutofill` entry that informs the reviewer and never counts as an attestation, written by your code, not by J5.
3. Review the migration for the `documents` and `proposed_facts` tables in `store.ts`.

## Evidence summary (`summary.ts`)

`GET /api/recovery/cases/:projectId/:findingId/evidence` requires `case.read` and returns:

```json
{ "summary": EvidenceSummary, "secondLook": SecondLook, "documents": [...], "facts": [...], "factVerifier": { "name", "fixture" } }
```

The summary is built from the server's own copy of the case, using fixed sentence templates as in `server/assistant.ts`. Every sentence carries citations:

| Citation | Points to |
|---|---|
| `case:<findingId>@<revision>` | the saved case at that revision |
| `rule:<type>` | the detection rule |
| `rule:evidence_gate` | the evidence gate |
| `record:<id>` | a ledger row |
| `obligation:<id>` | the attested obligation |
| `document:<id>` | a linked document |
| `document:<id>#L<line>` | one line of a linked document |

It covers:
- the rule and the flagged value, which is a review signal and not an amount owed;
- the gate result, each missing evidence item, and each contradiction;
- the amount breakdown, only when the gate passes, and taken from the gate;
- the number and statuses of supplier updates (`vendorUpdates`);
- each linked document and its status;
- each proposed fact with its line, conflicts and origin, and whether a document's invoice number appears on the case's payment rows;
- the standing limitation that facts are proposals and reading is not attestation.

## Second look (`secondLook.ts`)

The detector's own result appears first and is unchanged: type, title, explanation, severity, classification, flagged amount and evidence state. Under it are seven candidates, each marked `indicated` or `not_indicated`:

| Candidate | What indicates it |
|---|---|
| `legitimate_recurrence` | a saved recurring series that includes the rows, or distinct invoice numbers |
| `instalments_or_split` | partial payments, payments that add up to the invoice, or instalment, deposit or retainage terms |
| `duplicate_import` | the same source transaction id or row fingerprint, an importer overlap flag, or identical rows across different imports |
| `adjustment` | void, reversal, adjustment or journal rows for the supplier |
| `refund` | supplier refund rows, QuickBooks refunds applied, or a confirmed prior refund |
| `credit` | ledger or QuickBooks credits, or credit lines in linked documents |
| `uncertain` | nothing else is indicated |

Each candidate carries:
- cited record ids or document lines;
- the evidence gap that would settle it;
- the reviewer evidence check it maps to (from `EVIDENCE_CHECKS`) and whether that check is already confirmed;
- internal next actions only. Nothing here contacts a supplier.

## AI tasks (opt-in, through the gateway)

All three tasks are registered from `createDocumentRoutes` with `deps.ai.register`. The tenant policy defaults to `off`, which returns the deterministic answer with `code: 'ai_off'` and sends nothing. All three need permission `ai.invoke`.

| Task | Packet | Output checks | Fallback |
|---|---|---|---|
| `summarize_case_evidence` | Built from the stored case. Supplier and invoice numbers become `[[SUPPLIER]]` and `[[INVOICE_n]]`; document references become `[[DOCUMENT_REF_n]]` and `[[SUPPLIER_REF_n]]`. Dates become day offsets, or are dropped from facts. Free text (gate messages) is scrubbed and the supplier name replaced. | Every citation must be one of the packet's ids (`forgedReferences`), including ids written inline in the text. Amounts must be in the packet. No dates, links, contact or bank details, or unknown placeholders. No claim that money is owed, that something is verified, or that the case is approved, dismissed or closed (`invalid_state`). | Deterministic summary |
| `second_look` | The summary packet plus the deterministic candidates (kind, status, cited ids) | The same checks on the explanation and the evidence gap; the kind must be one of the seven | Deterministic second look |
| `extract_document_facts` | Only the ambiguous lines, at most 20, each scrubbed and capped at 160 characters. Links, emails, phone numbers, long digit runs and any `[[…]]` the document itself contains are removed. The case's supplier name and invoice numbers are replaced with placeholders. Withheld lines and the rest of the document are never sent. | The line must be one that was sent. The value must literally appear on that line. An amount must be one of that line's amounts. A date must be an unambiguous date on that line, so the model cannot settle a day-first/month-first question. A currency must be an ISO code written on the line. The usual text checks apply. | Deterministic extraction |

`extract_document_facts` accepts **one-time packet consent only.** While any standing field-set consent exists for the task, it refuses with 409 `ai_packet_consent_only`, and that includes the generic `/api/ai/tasks/:task/run`. The document route also requires `consentId` to name a packet-scope consent for this task, and answers 409 `ai_packet_consent_required` otherwise. Facts the model reads are stored through the same `proposed_facts` path with `origin: 'ai'` and `low` confidence, beside the deterministic reading, never over it.

Routes:

| Method & path | Body | Result |
|---|---|---|
| `POST /api/recovery/cases/:projectId/:findingId/summary/ai` | `{ consentId? }` | the gateway outcome. When `source: 'ai'` it also includes `deterministic` (the summary) and `notice` |
| `POST /api/recovery/cases/:projectId/:findingId/second-look/ai` | `{ consentId? }` | the same, with the deterministic second look, so the detector result stays visible |
| `POST /api/documents/:id/extract/ai` | `{ consentId }` (ignored while AI is off) | `{ source, code?, reason?, invocationId, facts, authoritative: false }` |

Preview and consent use the existing gateway routes: `POST /api/ai/tasks/<task>/preview` with `input: {}` for the case tasks or `input: { documentId }` for extraction, then `POST /api/ai/tasks/<task>/consent`.

The ledger records hashes, outcomes and codes only. The tests confirm that no document text, filename, supplier name or invoice number appears in `ai_invocations`, and that none appears in any `console.*` output in any test.

**For Aditya:** these are narrow, read-only data APIs for embedded insights, not a chatbot or a query engine. Things to show:
- `authoritative: false` on every fact;
- `fixture: true` on the verifier;
- the PDF note;
- `ai_off`, `ai_consent_required`, `ai_packet_consent_required`, `ai_packet_consent_only` and `nothing_to_send`.

## Needs manual confirmation

- **Real documents:** the labels and the CSV column matching were written against synthetic layouts. Before a pilot, someone should try them on a handful of real, consented supplier documents. No real customer data was used here.
- **Provider:** whether the AI tasks should run against any live provider is the founders' call under the J1 pilot checklist. No live provider was called.
- **Instruction detection:** the patterns are heuristic. They are defence in depth; the main defences are the output validators and the rule that only parser-ambiguous lines are ever sent.
- **Retention:** whether 365 days suits customers' document-retention obligations. Also whether deleting a document should leave a tombstone for audit; today it leaves none.

## PDF and OCR status

There is no PDF text extraction and no OCR in Reclaim, and none was added: that would mean no new dependencies and no paid services. PDFs are stored sealed with status `unsupported_format`, and the API says so in plain words. Images are refused, because without OCR they can't be used.

## Tests

The tests use synthetic fixtures only (`server/documents/fixtures.ts`), with the mock provider from `createMockProvider` passed as `aiProvider` to `createApp` and a random `DATA_KEY`.

```bash
npx tsc -p tsconfig.server.json --noEmit             # clean
npx oxlint server/documents                          # clean
npx vitest run server/documents                      # 4 files, 55 tests, all pass
npx vitest run server                                # 18 files, 258 tests, all pass
```

| File | Tests | Covers |
|---|---|---|
| `sniff.test.ts` | 9 | HTML, SVG, XML and script files; EXE, ELF, Mach-O, zip/docx/xlsm, gzip, OLE, PNG, RTF; binary, UTF-16, empty, oversize; strict base64; filename cleaning |
| `extract.test.ts` | 13 | Complete invoice with provenance; incomplete invoice and labels with no value; conflicting amounts, invoice numbers and currencies; a bare `$`; ambiguous dates; withheld instruction and bank lines; CSV remittance rows with no inferences; statement and credit note; money parsing; the FIXTURE verifier never accepting |
| `intelligence.test.ts` | 10 | Second-look signals (recurrence, duplicate import, instalments, refund, adjustment, credit from a document, rejected facts ignored, malformed projects); summary amounts only when the gate passes, missing evidence, contradictions, invoice-number comparison |
| `routes.test.ts` | 23 | **Intake:** sealing at rest, spoofed HTML and EXE named `.txt`, xlsm named `.csv`, PDF stored but not read, oversize, malformed and empty input, dedupe, wrong tenant, project and case ids, signed out, delete with facts, retention expiry. **Extraction:** the case's revision and fingerprint are unchanged, FIXTURE hand-off, stale facts, conflicts through the API. **Evidence:** every sentence is cited, the detector stays visible. **AI:** off by default, placeholders only and names restored, forged citations and invented `$9,999.00 is owed` rejected, an accepted second look keeps the detector, a one-time consent goes stale when the case changes, the extraction packet holds only the ambiguous line (no instruction, no invoice number, no link), AI facts that are off the line, invented or cite an unsent line are rejected, field-set consent refused, no document text in the ledger. **No provider:** `ai_unavailable` |

The `afterEach` in `routes.test.ts` captures every `console.*` call and fails the test if any synthetic document text appears.

## Requests for changes outside `server/documents/`

1. **`server/aiGateway/types.ts` and `service.ts` (Jagan):** add an optional `consentScopes?: ['packet']` to `AiTask`, enforced in `AiPolicyStore.grant` and `resolve`. J5 currently enforces packet-only consent inside the task's `build`, by refusing while a field-set consent exists, and in its own route. A field-set consent for `extract_document_facts` can still be *granted* through `/api/ai/tasks/:task/consent`; it just can't be used.
2. **`server/app.ts` (coordinate):** pass Sid's verifier with `createDocumentRoutes(workstream, { verifier })` once it exists.
3. **`contracts.md`:** add the J5 routes above and the `documents` and `proposed_facts` tables to the migration-review list for Sid.
4. **Sid:** see "Hand-off to Sid" above (`verifyProposedFacts`, what `accepted` enables, and the migration review).
5. **Aditya:** the evidence panel, document upload and the AI buttons over the routes above, showing the statuses and codes listed in the "For Aditya" note.
