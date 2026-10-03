# 700 × 50k ingest — measured end-to-end run

**Run date:** 2026-06-20 · **Branch:** `feat/large-file-ingest` · **Machine:** Apple
Silicon MacBook Pro (local Docker: Postgres 16 + MinIO).

A real, full-stack simulation of the headline fleet-scale scenario: a single
Gradescope export of **700 students × 50,000 events each**, ingested through the
actual route + worker against a freshly-wiped Postgres + MinIO. This supersedes
the CPU-only estimate in `ingest-complexity.md` ("Fleet-scale"), which predicted
~5.8 min / ~44s — that estimate was **wrong by ~24×** because it was built on
`bench:stages` (which excludes the database) and on drain numbers measured
against tiny seed bundles. See "Why the earlier prediction missed" below.

## Setup

- **Fixture:** `gen-large-fixture.ts --students 700 --events 50000` →
  `large-700x50000.zip`, **2.5 GB zipped** (the corpus-derived `methodfill`
  keystroke model; hex-hash slogs compress ~5×). Generation took **473 s** at
  ~1.7 bundles/s. Each bundle is ~17 MB uncompressed (50,003 events).
- **Infra reset:** `docker compose down -v` deleted the dev volumes (postgres
  30.4 GB + minio 77.5 GB — **~108 GB of accumulated test artifacts reclaimed**),
  then `up -d` + `db:migrate` on an empty database.
- **Config:** `INGEST_CONCURRENCY=8`, `DATABASE_POOL_MAX=11` (8 worker slots + 3
  spare — no connection starvation). Disk-path ingest (`ingest:local` /
  `ingestLocalPath`) because the HTTP route buffers in memory and trips a ~2 GiB
  ceiling.
- **Harness:** `profile-ingest.ts --path large-700x50000.zip` with
  `INGEST_PROFILE=1`, in-process worker, wall-clock segmentation + per-phase
  profile dump.

## Result

**Succeeded. 700/700 submissions matched (0 unmatched), 1,413 heuristic flags,
35,002,100 event rows materialized.** The hint-path matching (roster upserted
from export metadata, assignment from the manifest) worked exactly as expected.

### End-to-end wall-clock

| segment                                          |                        time | notes                                                                    |
| ------------------------------------------------ | --------------------------: | ------------------------------------------------------------------------ |
| stage + enqueue (interleaved with drain)         |                     804.6 s | sequential per-bundle rebuild-zip + S3 PUT, worker draining concurrently |
| worker drain tail (after staging)                |                     264.0 s | backlog remaining once all 700 were enqueued                             |
| **ingest processing window (stage→last bundle)** |    **1,068.6 s ≈ 17.8 min** | **the headline number**                                                  |
| cross-flags recompute                            | >300 s (**did not finish**) | enqueued + started, cut off at the 5-min poll timeout — see caveat       |

**Throughput: 0.66 bundles/s = ~1.53 s/bundle wall at c=8.**

### Per-phase profile (avg per bundle)

From `INGEST_PROFILE=1`. With c=8 the phases of different bundles overlap, so
per-bundle averages reflect **contended latency** (each bundle's handler shares 8
cores + one Postgres), not isolated cost — the wall throughput is 1.53 s/bundle.
The **relative shares** are the signal. `handler_total` and `tx_total` are parent
spans that contain their children:

```
handler_total            avg 11.43 s   (whole per-file pipeline)        35.8% of summed time
├─ tx_total              avg  8.03 s   (the DB transaction)             25.1%
│  ├─ materialize_events avg  6.58 s   ← INSERT 50k event rows/bundle   20.6%   ◄ dominant
│  └─ create_submission  avg  2.10 s   (FOR UPDATE + S3 copy + flags)    6.6%
├─ parse_bundle          avg  1.24 s   (blob_read 0.65 + load/crypto 0.59) 3.9%
├─ run_validation        avg  0.78 s   (chain hash-verify, Check 3)      2.4%
├─ run_heuristics        avg  0.29 s                                     0.9%
├─ compute_stats         avg  0.22 s                                     0.7%
├─ build_index           avg  0.05 s                                     0.1%
└─ dedup                 avg 0.002 s                                     0.0%
```

### Where the time actually goes

**Database row materialization is the bottleneck, by a wide margin.** Writing
50k event rows per bundle (`materialize_events`, 6.58 s) plus `create_submission`
(2.10 s) is **~76% of per-bundle work** — 35 M row inserts total into a database
that grew to **22 GB**, with eight transactions contending on the same table's
indexes. Parsing + chain validation add ~2 s; everything else is noise.

**The reconstruction stages I optimized are invisible at this scale.**
`compute_stats` + `run_heuristics` together are **0.51 s/bundle (~1.6%)**. The
line-cell reconstruction fix saves ~0.1 s/bundle out of an ~11 s contended
handler — a real win in CPU-only terms, but <1% of real 50k-bundle ingest, which
is I/O/DB-bound, not analyzer-CPU-bound.

## Why the earlier prediction missed (~24×)

`ingest-complexity.md`'s "Fleet-scale" section predicted ~5.8 min serial / ~44 s
at c=8. The real number is **~17.8 min at c=8**. Two compounding errors:

1. **`bench:stages` excludes the database.** It measures parse → index → stats →
   validation → heuristics in-process with no Postgres. But `materialize_events`
   - `create_submission` (the dominant ~8.7 s/bundle) are pure DB work it never
     sees. The CPU-only per-bundle figure (~0.4 s) was real but only ~4% of the
     true cost.
2. **The doc's drain figures (44 s @ c=8) were measured on the small seed
   export**, whose bundles have far fewer events — so far less to materialize.
   They don't transfer to 50k-event bundles.

The lesson: **for 50k-event bundles, ingest cost is dominated by event-row
materialization**, and the lever for fleet-scale throughput is database write
performance (bulk-insert tuning, index/unlogged-table strategy, faster storage),
not the analyzer CPU passes. `INGEST_CONCURRENCY` helps, but is ultimately gated
by single-Postgres write contention.

## Caveats

- **Cross-flags did not complete.** The recompute was enqueued and started, but
  the harness polls for cross-flag rows with a 5-min timeout and then shuts down
  the in-process worker — cutting the O(S²) computation off mid-run. The "0
  cross-flags" is an artifact of that cutoff, **not** a finding that there were
  none. Cross-flags for a 700 × 50k cohort takes **> 5 min** (unmeasured upper
  bound); its feature extraction streams every submission's events back out of
  the 35 M-row table. Measuring it properly needs a longer timeout.
- **Contended per-phase latency.** The per-bundle averages are inflated by 8-way
  contention; treat them as relative shares, not isolated costs.
- **Local single-node Postgres + MinIO.** Production storage/DB throughput would
  shift the absolute numbers; the _shape_ (DB-materialize-dominated) holds.

## Storage footprint

|                                      |    size |
| ------------------------------------ | ------: |
| Fixture zip (on disk)                |  2.5 GB |
| MinIO blobs (700 staged bundles)     | 12.4 GB |
| Postgres (35 M event rows + indexes) |   22 GB |

## Reproduction

```bash
# 1. Generate the fixture (~8 min, ~2.5 GB)
npm run gen:fixture --workspace=packages/server -- \
  --students 700 --events 50000 --out /path/large-700x50000.zip

# 2. Fresh infra
docker compose down -v && docker compose up -d
npm run db:migrate --workspace=packages/server

# 3. Profiled disk-path ingest (INGEST_CONCURRENCY=8, DATABASE_POOL_MAX=11 in .env)
npm run profile:ingest --workspace=packages/server -- --path /path/large-700x50000.zip
```
