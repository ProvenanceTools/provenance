# Ingest pipeline time complexity

Last assessed **2026-06-20** (branch `feat/large-file-ingest`), after the
reconstruction O(n²)→O(n) fix, the shared-index / json-bulk-insert round, and
the large-file staging work.

This document records the time complexity of every ingestion stage, the
empirical evidence behind it, and where (if anywhere) further optimization is
worth doing. It is a companion to the profiling notes captured during the June
2026 perf work.

## TL;DR

- **The per-bundle pipeline is linear in event count.** The previous O(n²)
  (file-content reconstruction) is gone; an empirical sweep from 1k→100k events
  shows flat cost-per-event across every stage.
- A 100k-event bundle (a ~4-hour heavy session) costs **~1.0s of CPU**.
- The single dominant cost is **hash-chain verification** (validation Check 3):
  ~44% of CPU. It is cryptographically irreducible, runs exactly once per
  bundle, and has **no redundant double-hashing** anywhere else in the pipeline.
- **For append-dominated streams there is no remaining algorithmic win.** The
  lever for fleet-scale imports (hundreds–thousands of bundles) is throughput
  (`INGEST_CONCURRENCY`), not per-bundle work.
- **Interior-edit reconstruction was O(L²)** (template-fill assignments, hidden
  by the append-only bench) — **fixed 2026-06-21** via a line-cell content model
  in both reconstructors + per-index reconstruction sharing. On the corpus-derived
  `methodfill` workload (original → now): reconstruction stages **1.3–4.4× faster**
  across 10k→100k events (widening with size), whole CPU pipeline **1.0–1.5×**
  (**1.27× at 50k**). See "Interior edits" below.
- **A 700-bundle × 50k-event import** (the headline fleet-scale scenario) is
  predicted to drop from **~7.0 min → ~5.8 min serial** (~1.22× end-to-end), or
  **~54s → ~44s at `INGEST_CONCURRENCY=8`**. The win is per-bundle CPU; it
  compresses toward 1× as concurrency rises and fixed DB/S3 I/O dominates. See
  "Fleet-scale" below.

## Notation

| symbol | meaning                                                                  |
| ------ | ------------------------------------------------------------------------ |
| **n**  | events in one bundle                                                     |
| **L**  | total file content size in one bundle                                    |
| **F**  | files in an upload batch                                                 |
| **S**  | non-superseded submissions in a semester                                 |
| **P**  | total paste events in a semester                                         |
| **G**  | n-gram fingerprint size (bounded by the event-kind alphabet ⇒ ~constant) |

## Per-stage complexity

| #   | Stage                            | Code                                                | Complexity                                        | Notes                                                                                                                                                |
| --- | -------------------------------- | --------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | Upload / staging                 | `resumable-upload.ts`, `stage-upload-job.ts`        | **O(bytes)**, memory-bounded                      | Streamed chunks + temp file. Interleaving (commit `2f343cd`) enqueues per-file jobs as each stages — improves wall-clock, not asymptotics.           |
| 2   | Dedup                            | `dedup.ts`                                          | **O(log D)**                                      | One indexed `LIMIT 1` on `(semester, blob_sha256)`. Negligible.                                                                                      |
| 3   | Parse bundle (`loadBundle`)      | `parse-bundle-phase.ts`                             | **O(bytes + n)**                                  | Unzip (inflate) + per-line `JSON.parse` + ed25519 manifest/checkpoint verify + per-submission-file sha256. Does **not** hash the chain. ~23% of CPU. |
| 4   | Match student                    | `match-student.ts`                                  | **O(filename)** + 1 indexed lookup                | Negligible.                                                                                                                                          |
| 5   | Create submission                | `create-submission.ts`                              | **O(versions)** + `FOR UPDATE` + S3 copy O(bytes) | A few indexed queries. Negligible.                                                                                                                   |
| —   | Build index (shared, built once) | `build-index.ts`                                    | **O(n log n)**                                    | Flatten + chronological sort + single-pass maps. ~5% of CPU.                                                                                         |
| 6   | Materialize events               | `materialize-events.ts`                             | **O(n log n)** DB, O(n) app, **1 round-trip**     | Single `json_to_recordset` INSERT; cost is heap insert + index maintenance (irreducible DB floor). Not CPU-bound.                                    |
| 7   | Compute stats                    | `stats.ts`, `reconstruct-file*.ts`                  | **O(n)** (was O(n²))                              | Reconstruction uses a line-cell content model — O(line) per intra-line edit, no whole-file copy (see "Interior edits"). ~3% of CPU.                  |
| 8   | Run validation                   | `run-validation.ts`                                 | **O(n + bytes)**                                  | 8 checks. **Dominant stage (~44%)**, but linear. Dominated entirely by Check 3 — see below.                                                          |
| 12  | Run heuristics                   | `run-per-submission.ts`                             | **O(n)**                                          | ~19 detectors over the shared index. ~25% of CPU.                                                                                                    |
| —   | Finalize                         | `job-control.ts`                                    | **O(F)**                                          | Aggregate sibling file statuses. Negligible.                                                                                                         |
| 14  | Cross-flags (semester)           | `run-cross.ts`, `extract-cross-features-from-db.ts` | **O(Σ nₛ log nₛ) + O(S²·G) + O(P²)**              | The only super-linear stage — in **S**, not n. See below.                                                                                            |

## The enqueue / "front half" (before any worker runs)

Everything above is per-bundle worker cost. Before the worker runs, the request
path must stage blobs, write `ingest_files` rows, and enqueue per-file jobs.
This phase is **O(F)** in the number of submission files, with **three
sequential round-trips per file** and no bulk batching:

1. `stageBlob` — one S3/MinIO `PUT` of the bundle ZIP. **O(bundle bytes)** and
   the dominant per-file cost.
2. `INSERT` one `ingest_files` row (one DB round-trip).
3. `boss.send(INGEST_FILE, …)` — one pg-boss enqueue = one `INSERT` into
   `pgboss.job` (one DB round-trip).

So the literal "queue up the jobs" cost is **F sequential `boss.send` calls**
(F single-row inserts into `pgboss.job`) — linear in F, latency-bound, and
cheap relative to staging (the S3 PUTs) and processing (~1s CPU/bundle).
Empirically the whole front half ran ~5s for a 700-small-bundle export
(~7ms/file, dominated by S3 + DB round-trip latency, not CPU). This phase is
I/O-bound and needs Postgres + MinIO to measure, so it is **not** covered by
`bench:stages`; use `profile:ingest` for it.

Where the O(F) work sits relative to the HTTP response differs by entry path:

| Entry path                                | Code               | Enqueue location                                                                                                                              | Request latency     |
| ----------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Multipart `POST /ingest`                  | `ingest.ts` ~L455  | Inline: stage all files, then a second loop of F `boss.send`                                                                                  | **O(F)** in-request |
| `POST /ingest:gradescope` (sync)          | `local-path.ts`    | Inline, **interleaved**: per file stage + insert + send, worker starts mid-stream                                                             | **O(F)** in-request |
| Resumable `POST …/complete` (large files) | `ingest.ts` ~L1123 | **Background**: request does 1 job-row insert + 1 `boss.send` (`ingest_stage_upload`), returns 202; the O(F) staging+enqueue runs in that job | **O(1)** in-request |

The resumable path — the one used for multi-GB exports — already moves the
entire O(F) front half off the request, so user-perceived latency there is O(1).

### Is the enqueue worth optimizing?

- **Multipart `POST /ingest` (the non-interleaved path) — DONE.**
  It already stages all files first and _then_ enqueues, so the F `boss.send`
  calls collapsed into a single `boss.insert([…])` (pg-boss binds the whole job
  array as one JSON param — no bind-param ceiling, no chunking) and the F
  `ingest_files` inserts into a chunked bulk insert (`INGEST_FILE_INSERT_CHUNK`
  = 1000 rows/statement, to stay under Postgres's 65535-param ceiling since
  `INGEST_MAX_BATCH_FILES` is admin-raisable). Turns ~2F + 1 DB/queue round-trips
  into ~⌈F/1000⌉ + 1, with no loss of interleaving (there was none). As a bonus
  it tightened the failure semantics: rows are written only after all staging
  succeeds (a mid-staging failure now leaves zero `ingest_files` rows, not a
  partial set), and the `getBoss()`/enqueue step is now inside the compensation
  `try` so an enqueue failure marks the job `failed` instead of orphaning it as
  `queued`. The S3 PUTs (the dominant front-half cost) are unchanged, so the
  wall-clock win is modest. See `chunk.ts` and the handler in `ingest.ts`.
- **Interleaved paths (`:gradescope`, resumable) should keep per-file sends.**
  Sending each job as its bundle finishes staging lets the worker start while the
  rest of a large export is still streaming. With ~1s of processing per bundle,
  early worker start is worth far more than saving a few ms of enqueue
  round-trips. Batching here would trade that away.
- **The dominant front-half cost is the S3 PUTs (`stageBlob`), not the enqueue.**
  These are sequential and O(total bytes). Bounded-concurrency PUTs could speed a
  large export, but that competes with worker concurrency for resources and
  complicates the deliberate memory-bounded streaming on the large-file path.
  Not worth it without evidence the front half is the bottleneck (it isn't —
  per-bundle processing dominates).

## Empirical evidence

Measured with `packages/server/scripts/bench-stages.ts` (median of 3 reps, no
DB/S3 — pure CPU stages only). One faithful signed bundle is generated per size
and pushed through parse → buildIndex → computeStats → runValidation →
runHeuristics.

```
Absolute median ms per stage:
events       slogMB     parse  buildIdx     stats     valid      heur   CPU sum
10,003          3.5      25.3       3.1       5.4      51.4      22.5     107.6
25,003          8.8      59.1       8.1       8.1     116.8      53.7     245.8
50,003         17.7     113.1      24.4      14.3     220.1     116.6     488.6
100,003        35.4     229.9      47.5      31.2     441.5     247.6     997.6

Normalized ms per 10k events (flat = linear, rising = super-linear):
events        parse  buildIdx     stats     valid      heur   CPU sum
10,003        25.24      3.14      5.36     51.38     22.48    107.60
25,003        23.63      3.25      3.25     46.70     21.48     98.32
50,003        22.62      4.88      2.86     44.02     23.33     97.72
100,003       22.98      4.75      3.12     44.15     24.76     99.76
```

Every normalized column is flat. If reconstruction were still O(n²), the 100k
row's per-event cost would be ~100× the 1k row's; instead it is constant. This
is the end-to-end confirmation that the reconstruction fix holds.

### Validation is one check

Per-check breakdown (`BENCH_CHECKS=1`, 50k events):

```
1 manifest_sig=0.6  2 session_bind=0.0  3 chain=219.3  4 seq=0.1
5 monotonic_t=0.1   6 monotonic_wall=1.6  7 doc_save_hash=8.3  8 submitted_code=0.4
```

Validation's ~220ms is **entirely Check 3** (`verifyChain`). The other seven
checks are noise. Check 3 recomputes `sha256(prev_hash + JCS-canonicalize(envelope))`
for every event — the JCS canonicalization is the expensive part.

This is the tamper-evidence guarantee (recorder PRD §5.2): to detect tampering
you must recompute the chain; there is no shortcut. It is **non-negotiable** per
`CLAUDE.md` and must not be weakened.

We verified there is **no redundant hashing**: `loadBundle` reads the stored
`hash`/`prev_hash` fields without recomputing them, materialize stores them
verbatim, and cross-flags never re-hashes. The chain is recomputed exactly once
per ingest, in Check 3.

## Cross-flags: the one super-linear stage

Cross-flags is semester-scoped and the only stage that is super-linear — but in
**submission count S**, not event count n:

- **Feature extraction** (`extract-cross-features-from-db.ts`): streams one
  submission's events at a time, O(nₛ log nₛ) each, reducing to a compact
  fingerprint (pastes + bounded kind-stream n-gram set). Memory-bounded by
  design — holding full bundles for a whole semester previously OOM'd the worker.
- **`editing_pattern_clone`**: O(S²) pairwise Jaccard over the n-gram sets. Each
  comparison is O(G) with G bounded by the kind alphabet, so it is effectively
  O(S²) with a small constant.
- **`paste_shared_across_students`**: ~O(P²) worst case over pastes (sha256
  grouping is near-linear; the fuzzy fallback scans group members).

For typical cohorts this is fine. S² is the term to watch at large semester
scale, but the bounded fingerprint keeps each comparison cheap, and it runs once
per semester (debounced via pg-boss `singletonKey`), off the per-file path.

## Is there anything more to optimize?

Short answer: **not meaningfully.** The pipeline is at its algorithmic floor.

Levers considered and their verdicts:

- **Chain verification (44%, the dominant cost) — irreducible.** It is the
  tamper-evidence check; it cannot be skipped or weakened. It already runs
  exactly once with no redundancy.
  - _Theoretical lever:_ Check 3 is embarrassingly parallel (each entry verifies
    against its own stored `prev_hash`, not a running value), so the per-event
    hash recompute could be sharded across `worker_threads`. This would only
    help **single-giant-bundle latency**, not throughput (throughput already
    saturates all cores via `INGEST_CONCURRENCY`). High complexity (thread pool,
    event serialization) for a narrow benefit. **Not worth it** unless one-bundle
    latency becomes a UX problem.
- **Share one reconstruction per file (the old "Lever 2") — DONE (2026-06-21).**
  Full-stream reconstructions are memoized per `EventIndex` (a `WeakMap` in each
  reconstructor), shared across consumers of the same index with no
  pure-function-API change (the cache keys on the index identity, not a threaded
  param). A cheap ~10–15% on the reconstruction stages on top of the line-cell
  fix — see "Interior edits" below.
- **`buildIndex` sort O(n log n) → k-way merge O(n log S) — marginal.**
  buildIndex is only ~5% of CPU; not worth the complexity.
- **Throughput for fleet-scale imports — already handled.** `INGEST_CONCURRENCY`
  processes a pg-boss batch concurrently and scales near-linearly with cores
  (700-bundle drain: 348s @ c=1 → 87s @ c=4 → 44s @ c=8). Raise it together with
  `DATABASE_POOL_MAX` (each in-flight job holds ~1 pool connection).

### Interior edits: the O(L²) reconstruction (fixed 2026-06-21)

The linear result above was measured on an **append-only** edit stream (the
bench typed every line at end-of-file — the pattern V8 keeps cheap via
cons-strings). For an assignment style where students fill in method bodies
inside template code, most `doc.change` events instead land in the **interior**
of the file. The original materialized-string content model
(`content.slice(0,start) + text + content.slice(end)` plus an O(lines)
`lineStarts` shift) copied O(L) per interior edit ⇒ O(L²) per reconstruction —
and reconstruction runs ~10× per submission file (`stats` ×1, validation ×2,
and ~7 heuristic detectors), so the cost was ~10 × O(L²), with `runHeuristics`
the largest victim.

**Fix:** both reconstructors (`reconstruct-file.ts`,
`reconstruct-file-provenance.ts`) now store content as a **line-cell array** —
each cell is one line including its trailing `\n`, with a parallel per-cell
provenance array (`provCells[k].length === cells[k].length`). A position maps
directly to (cell, char), so there is no `lineStarts` index, and an **intra-line
edit rewrites a single cell — O(line length), with no array shift**. Verified
byte-identical (content + per-char provenance + every prefix cut) against the
independent old-`split('\n')` oracle in `reconstruct-line-index.fuzz.test.ts`
(1000 random streams) plus the full analyzer suite (1188 tests).

A **second lever** layers on top: full-stream reconstructions are now memoized
per `EventIndex` (a `WeakMap` in each reconstructor), so the full replay runs
once per file and is shared across consumers of the same index — `computeStats`
↔ `low-typing-high-output` (plain) and `paste-is-solution` ↔
`idle-then-complete` (provenance). Cut-point (`upToGlobalIdx`) reconstructions
are detector-specific and uncached (bounds replay-UI memory). This is the old
"Lever 2", now worth doing as a cheap follow-on.

Measured with `BENCH_EDIT=methodfill`, **original → now (line-cell + sharing)**
on the same stream, faithful cold measurement (fresh index per rep). The
`methodfill` model was since refined to a **corpus-derived single-keystroke
generator** — one `doc.change` per character (~3.5% Enter, with the character
mix and auto-indent measured from a real CS 61A homework/lab/project corpus,
~28 content chars/line), replacing the earlier coarse model (multi-char bursts,
~12% newline). The same generator now backs `gen-large-fixture.ts`. The refined
model types ~1 char/event, so it produces **smaller, more realistic files** per
event (25 KB at 50k vs 64 KB under the old model) — which lowers the absolute
reconstruction cost and so reports **smaller, more honest speedups** than the
earlier coarse table did:

```
events  fileKB   stats          heur            recon (stats+heur)     CPU sum
10,003   6.2     4.5 →  4.1     12.7 →  8.8     17.2 →  12.9 (1.3×)     95.8 →  96.0 (1.00×)
25,003  13.2    16.0 → 10.3     37.9 → 17.8     53.9 →  28.1 (1.9×)    228.1 → 198.9 (1.15×)
50,003  25.0    38.4 → 15.9    119.8 → 34.6    158.2 →  50.5 (3.1×)    513.0 → 404.5 (1.27×)
100,003 48.7   114.0 → 44.0    420.0 → 78.3    534.0 → 122.3 (4.4×)   1312.2 → 891.1 (1.47×)
```

`stats`/`heur` per-event cost is flat after the fix (e.g. `heur` 8.8→7.1→6.9→7.8
ms/10k) and rising before it (12.7→15.2→24.0→42.0 ms/10k) — the super-linear term
is gone. The reconstruction-heavy stages (stats+heur) are **1.3–4.4× faster,
widening with file size**; the whole CPU pipeline is **1.0–1.5×** (1.27× at 50k)
— the rest is `valid`, dominated by the irreducible O(bytes) chain-hash (Check 3),
plus parse, both untouched by this change (their before/after deltas are run
noise). The line-cell model is the bulk of the win; sharing adds ~10–15% on the
reconstruction stages. `append` is unchanged (marginally faster).

**Caveat — the line-cell model's weak case is pure line-insertion.** An edit
that adds/removes whole lines shifts the cell array O(lines). A stream that is
_dominated_ by interior whole-line insertion (`BENCH_EDIT=mid`/`scatter`)
therefore regresses vs the old string model (e.g. `mid` @25k/408 KB: 3029 →
7306 ms). This is not the real recorder pattern — `doc.change` events are
overwhelmingly intra-line keystrokes, and `methodfill` (~3.5% newlines) already
nets a win — and the quadratic constant is over the _line_ count, so at
realistic file sizes (≤ ~50 KB / ~1k lines) even this pattern is a few ms. If
real bundles ever prove line-insertion-heavy at large file sizes, the next step
is a **gap buffer over the cell array** (O(1) amortized for localized
insertion), which would also make `mid` linear; `scatter` (random) stays the
hard case for any non-tree structure.

## Fleet-scale: the 700 × 50k import

> **⚠️ Superseded by a real run (2026-06-20) — the CPU-only prediction below was
> ~24× optimistic.** A full-stack ingest of an actual 700 × 50k export took
> **~17.8 min at c=8**, not the ~44 s predicted here, because this section is
> built on `bench:stages` (which has **no database**) and the per-bundle cost is
> dominated by `materialize_events` — inserting 50k event rows/bundle (35 M
> total). The reconstruction stages are <2% of real ingest. The CPU-only
> analysis below is still correct _as a CPU analysis_; it just isn't the
> end-to-end story. See [`ingest-700x50k-run.md`](./ingest-700x50k-run.md) for
> the measured numbers.

The headline scenario is a single Gradescope export of **700 students, each a
~50k-event bundle** (`gen-large-fixture.ts` defaults; ~17 MB/bundle, ~12 GB
total). What does the reconstruction fix buy at that scale, and how long does the
whole import take?

**Per-bundle, at 50k events** (from the table above, realistic `methodfill`):

| stage group                          | before all opts | after  | saving              |
| ------------------------------------ | --------------- | ------ | ------------------- |
| reconstruction stages (stats+heur)   | 158 ms          | 51 ms  | **3.1×**            |
| whole CPU pipeline (bench, no DB/S3) | 513 ms          | 404 ms | **1.27×** (−109 ms) |

The 109 ms/bundle saving is _entirely_ the stats+heur reconstruction delta; the
other ~400 ms (parse + chain-hash validation) is reconstruction-independent and
unchanged.

**Pure analysis CPU for 700 bundles:** 700 × 513 ms = **359 s → 700 × 404 ms =
283 s** (~76 s saved).

**End-to-end wall-clock.** Worker wall time adds ~90 ms/bundle of DB materialize

- S3 ops + staging share on top of CPU (the measured `c=1` drain of ~348 s ÷ 700
  ≈ 497 ms/bundle vs 404 ms CPU), and `INGEST_CONCURRENCY` parallelizes the drain
  near-linearly with cores. The 109 ms CPU saving is fixed (it does not
  parallelize away), so the ratio holds across concurrency:

| `INGEST_CONCURRENCY` | before all opts  | after (predicted)    |
| -------------------- | ---------------- | -------------------- |
| 1 (serial)           | ~7.1 min (424 s) | **~5.8 min (348 s)** |
| 4                    | ~106 s           | **~87 s**            |
| 8                    | ~53 s            | **~44 s**            |

So **expect ~1.2× faster end-to-end** for the 700 × 50k import (slightly below
the 1.27× CPU figure, because the fixed DB/S3 overhead is unchanged), saving
~1.3 min serial or ~9 s at `c=8`.

**Two things move this number:**

- **Bigger bundles widen it.** The win is super-linear in the _old_ cost, so it
  grows with event count: 1.0× (10k) → 1.15× (25k) → 1.27× (50k) → 1.47× (100k)
  on CPU. A 700 × 100k import would see ~1.4× end-to-end.
- **Saturated I/O shrinks it.** The speedup is a CPU saving; once
  `INGEST_CONCURRENCY` is high enough (or the object store slow enough) that
  S3/DB throughput is the ceiling, both before and after converge on that ceiling
  and the ratio fades toward 1×. The lever there is storage/DB throughput, not
  this fix.

**One-time costs not in the above:** unzipping the ~12 GB outer export and the
front-half staging (700 × 17 MB of S3 PUTs, O(bytes), overlapped with processing
on the interleaved/resumable paths). Also raise `INGEST_MAX_BATCH_BYTES` (default
5 GB) for a ~12 GB batch. Measure the I/O-inclusive path with `profile:large`,
not `bench:stages`.

## Running the benchmark

```bash
# Default sweep (1k, 2k, 5k, 10k, 25k, 50k, 100k events):
npm run bench:stages --workspace=packages/server

# Custom sizes:
npm run bench:stages --workspace=packages/server -- 10000 50000 100000

# With the per-validation-check breakdown:
BENCH_CHECKS=1 npm run bench:stages --workspace=packages/server -- 50000

# Edit-position model (default `append`): `mid`/`scatter` place each typed line
# in the file interior to model template-fill workloads — see "Known worst case".
BENCH_EDIT=mid npm run bench:stages --workspace=packages/server -- 5000 10000 25000
```

No infrastructure required — it generates bundles in-process and times the pure
CPU stages. For the full route+worker path against Postgres/MinIO (DB/S3
included), use `npm run profile:large` instead.
