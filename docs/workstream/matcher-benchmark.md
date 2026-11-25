# Intelligent record matching (experiment C2): benchmark

Algorithm `record-matcher-0.1.0`, threshold 0.60, Node v24.14.1. Run on 2026-11-25 (`generatedAt` 2026-11-25T23:29:09Z).
Reproduce with `node scripts/matcher-benchmark.ts`. Every number below comes from that run.

> **All results are on synthetic data.** They are not customer evidence. The fixture generator and the matcher were written by the same author, so held-out data guards against overfitting to particular records, not against shared blind spots. The "uplift threshold" (how much extra recall justifies extra review) is a **proposal; it needs Sid's decision.**

## What the experiment is

- It is "intelligent record matching", not ML. It is a transparent weighted sum of named features: reference, supplier name, amount, timing, invoice date, invoice amount and bank account. Each feature carries a plain-language reason.
- **Off by default.** It runs only when `RECLAIM_EXPERIMENT_RECORD_MATCHER` is `1`, `true`, `yes` or `on`, or when the caller passes `enabled: true`.
- **Strictly additive and read-only.** It returns `MatchCandidate`s for pairs that the exact and near duplicate findings did not already surface. It never edits, removes, re-ranks or suppresses a finding, and it carries no amount, no dollar impact and no eligibility. Anything bound for recovery still has to pass `src/recovery/eligibility.ts`, which this module neither calls nor bypasses.
- **Deterministic exclusions run before scoring:**
  - the same source transaction (repeated import copy);
  - a different company;
  - a currency mismatch;
  - a recurring series, including off-cadence rows inside the series span;
  - a void or reversal;
  - refunds or credits that cover the smaller payment;
  - partial payments within the invoice amount.
- **Blocking keeps the work sub-quadratic.** Each record gets at most five keys: supplier + cents, name prefix + cents, reference digit core, and sorted reference digits.
  - Blocks of up to 40 rows are compared all-pairs.
  - In larger blocks, each row is compared only with its next 8 rows by payment date.
  - There is a hard cap of 2,000,000 pairs.
  - The bound is n × 5 × 39 pairs, plus caps of 2 candidates per record and 5,000 per run.

## Method

- **Fixtures.** A seeded generator (`src/lib/matcher/fixtures/generate.ts`) produces the frozen `dev.json` (1,052 records, 286 cases, 80 labelled duplicate pairs) and `heldout.json` (1,037 records, 275 cases, 76 labelled pairs).
  - The two splits use disjoint supplier name pools, groups and record ids. A test asserts this, and another asserts that the frozen files equal the generator's output.
  - Positive scenarios: exact duplicate, reference format variant, card double charge, reference suffix late re-pay, supplier legal-suffix rename, supplier typo, transposed reference paid late, amount fee variant, missing invoice date paid late, and alias without reference.
  - Negative scenarios: distinct background bills, recurring equal amounts, overlapping export (the same transaction in two imports), partial payments, void and reissue, refunded duplicate, adjustment payment, similar supplier names, same-amount separate bills, currency mismatch, and transposed references with different amounts.
- **Tuning on dev only.** Weights and threshold were set on dev. Two dev-motivated changes were made before held-out was ever run:
  - a −0.15 penalty when two or more signals agree only approximately;
  - excluding off-cadence same-amount rows that fall inside a recurring series.

  Together these removed dev's three matcher false positives.
- **Held-out evaluated once with the frozen weights.** After that run, the only code change was a speed fix. It replaced the full-matrix edit distance with a banded check that gives the same yes/no answer. Candidate output on dev, held-out and a 10k perf ledger was compared byte for byte and was identical. Accuracy numbers from the re-run were also identical, and only runtimes changed.
- **Review unit.** One distinct record pair put in front of a reviewer. A baseline finding with three records counts as three pairs.
  - TP: a surfaced pair that is a labelled duplicate.
  - FP: any other surfaced pair.
  - FN: a labelled pair that was not surfaced.
- **Baseline.** The pairs inside the unchanged `detectFindings` output's `exact_duplicate` and `near_duplicate` findings.
- **Matched budgets.** With review budget B equal to the baseline's pair count, the reviewer sees every baseline pair and then the top-scored matcher candidates until the budget runs out. Budgets B + 10%, B + 25% and unlimited are reported.
- **Counterfactual swap at budget B.** This is analysis only and the product never does it. The B slots are filled from (baseline ∪ candidates) ranked by matcher score, with excluded pairs ranked last.

## Accuracy

| Split | Arm | Reviewed | TP | FP | FN | Precision | Recall |
|---|---|---:|---:|---:|---:|---:|---:|
| dev | baseline | 63 | 30 | 33 | 50 | 0.476 | 0.375 |
| dev | matcher candidates only | 47 | 47 | 0 | 33 | 1.000 | 0.588 |
| dev | baseline + matcher | 110 | 77 | 33 | 3 | 0.700 | 0.963 |
| **held-out** | baseline | 62 | 33 | 29 | 43 | 0.532 | 0.434 |
| **held-out** | matcher candidates only | 39 | 38 | 1 | 38 | 0.974 | 0.500 |
| **held-out** | baseline + matcher | 101 | 71 | 30 | 5 | 0.703 | 0.934 |

On both splits, findings were deep-equal before and after the matcher ran, and no candidate carried an amount.

### Matched review budget (held-out)

| Budget | Pairs reviewed | Matcher slots | TP | FP | FN | Precision | Recall |
|---|---:|---:|---:|---:|---:|---:|---:|
| B (baseline workload) | 62 | 0 | 33 | 29 | 43 | 0.532 | 0.434 |
| B + 10% | 69 | 7 | 40 | 29 | 36 | 0.580 | 0.526 |
| B + 25% | 78 | 16 | 49 | 29 | 27 | 0.628 | 0.645 |
| unlimited | 101 | 39 | 71 | 30 | 5 | 0.703 | 0.934 |
| counterfactual swap at B | 62 | – | 62 | 0 | 14 | 1.000 | 0.816 |

On dev, the same budgets gave 30 / 37 / 46 / 77 TP, and the counterfactual swap gave 63 TP and 0 FP out of 63.

At exactly budget B, the additive matcher adds nothing, because it never displaces a finding. Its value shows up only when reviewers spend extra time. On held-out, every one of the first 16 extra slots found a real duplicate. The counterfactual swap suggests that ranking by matcher score would remove most baseline false positives at the same workload. That is a finding about the baseline's precision, and acting on it would be a separate change that this experiment does not make.

### Overlap with Rule 8

Of the held-out matcher true positives, 13 of 38 are pairs that already appear together in a `shared_invoice_number` (Rule 8) finding; on dev the figure is 14 of 47. Rule 8 is not a duplicate finding and is not counted in the baseline, but a reviewer may already have seen those rows. The net new exposure is 25 true pairs on held-out and 33 on dev.

### Where the gains come from (held-out, additional TP / labelled pairs)

| Scenario | Labelled pairs | Baseline TP | Additional matcher TP |
|---|---:|---:|---:|
| exact duplicate | 19 | 19 | 0 |
| reference format variant | 8 | 8 | 0 |
| card double charge | 6 | 6 | 0 |
| reference suffix, re-paid late | 4 | 0 | 4 |
| supplier legal-suffix rename | 6 | 0 | 6 |
| supplier typo | 10 | 0 | 10 |
| transposed reference, paid late | 3 | 0 | 3 |
| amount fee variant | 4 | 0 | 4 |
| missing invoice date, paid late | 9 | 0 | 9 |
| alias without reference | 7 | 0 | 2 |

## Failure cases

- **Matcher false positive (held-out, 1):** `heldout-r000258` / `heldout-r000262`. This is a same-supplier, same-amount pair paid 11 days apart. One row is an unreferenced expense in a recurring series and the other is a referenced bill payment. It scored exactly 0.60: same identity 0.25, exact amount 0.25, timing within 14 days 0.10. Nothing in the record contradicts it, which is why reference-less pairs need a reviewer. Because held-out has been used, this was **not** tuned away. Any fix would need a fresh held-out set.
- **False negatives (3 dev, 5 held-out), all "alias without reference".** These are the same payment booked under a different supplier name with no invoice number. Without a reference the best possible score is about 0.57 (similar name, exact amount, close timing), which is below threshold. This is a deliberate trade: lowering the threshold would admit the same-amount separate-bill negatives.
- **Baseline false positives that the matcher's exclusions would avoid (held-out):** overlapping export 13, currency mismatch 7, void and reissue 7, same-amount separate bills 2. The matcher does not suppress these. They stay exactly as detection produces them.
- **Synthetic blind spots:**
  - The fixture has no multi-entity company data.
  - There are no real QuickBooks bill links or credit applications.
  - Name variants come only from a small set of suffixes and typos.
  - Reference styles are limited to the ones the generator writes.

## Performance

Each size runs in its own child process on a generated ledger (seed 9001). "Pairs compared" is the number of pairs after blocking.

| Rows | detectFindings | Matcher | Pairs compared | Oversized blocks (largest) | Truncated | Candidates | Heap after | Peak RSS |
|---:|---:|---:|---:|---:|---|---:|---:|---:|
| 1,001 | 50 ms | 16 ms | 1,166 | 0 (12) | no | 46 | 17 MB | 83 MB |
| 10,007 | 298 ms | 266 ms | 45,428 | 14 (143) | no | 533 | 81 MB | 300 MB |
| 50,002 | 1,468 ms | 4,526 ms | 543,193 | 260 (308) | no | 2,750 | 388 MB | 712 MB |

- Pair growth from 10k to 50k rows (12×) is faster than linear. The perf ledger reuses a small name vocabulary, so name-prefix blocks get large.
- The windowed comparison holds pairs well under the documented bound: n × 5 × 39 is about 9.75M at 50k rows.
- At 50k rows the matcher is slower than detection (4.5 s against 1.5 s). Before the edit-distance fix it was 13.4 s.
- Peak RSS covers the whole child process, including generation and detection.
- The figures come from a single run on a Windows developer machine and are indicative only.

## Acceptance decision

**Proposed gate:** enable only if held-out shows additional true positives, matcher-added precision at or above baseline precision (so no greater review cost per true duplicate), and no new unsupported claims (no amounts, no eligibility, no change to findings).

**On synthetic held-out data the gate is met:**
- 38 additional true pairs (25 not already visible through Rule 8);
- matcher-added precision 0.974 against baseline 0.532;
- findings unchanged and no amounts.

**Recommendation: keep `RECLAIM_EXPERIMENT_RECORD_MATCHER` off by default.** The synthetic pass is necessary but not sufficient. Next steps:
1. Run the matcher in shadow mode on reviewed real ledgers, with reviewer outcomes recorded per candidate.
2. Build a fresh held-out set before any re-tuning.
3. Decide the uplift threshold; this is Sid's call. Proposed: at least 10% more confirmed duplicates per 10% more review, measured on real reviewed data.

Only then consider turning it on for customers.
