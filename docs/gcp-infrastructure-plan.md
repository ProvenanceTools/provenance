# GCP infrastructure review & migration plan

Drafted **2026-06-20** (branch `feat/large-file-ingest`). Target deployment:
**2–3 UC Berkeley courses on Google Cloud Platform.** Companion to
`ingest-700x50k-run.md` (the measured fleet-scale run this plan is sized
against) and `admin-guide.md` (the current single-node operational guide).

This document is a **target architecture and migration plan**, not a record of
deployed infrastructure. It describes the GCP shape the system should move to,
why each component is chosen, the database-setup changes that should land with
the move, and the phased migration from the current dev `compose.yaml` stack.

## TL;DR

- The workload is **bursty batch writes on a tiny always-on baseline**: a
  Gradescope import a handful of times per semester (write-heavy, DB-bound),
  plus light interactive reads from a small number of course staff. This shape
  dictates everything below — **scale-to-zero worker + right-sized managed
  core**, not always-on big iron.
- **Right-sized single-node Postgres is the endgame at this scale**, not
  distributed Postgres. 2–3 courses accumulate low-hundreds of GB of
  audit-permanent event rows over years — comfortably one managed instance.
- Target stack: **Cloud Run** (API + worker, split), **Cloud SQL for
  PostgreSQL** (+ read replica), **GCS** (bundles), **Firebase Hosting / Cloud
  CDN** (SPA), **Secret Manager**, **Identity-Aware Proxy** in front of Google
  OAuth, all in **us-west1**.
- Berkeley is a Google Workspace org (`@berkeley.edu`), so the existing
  `hd`-claim OAuth control (`AUTH_ALLOWED_HOSTED_DOMAINS=berkeley.edu`) maps
  cleanly, and IAP adds an edge-level SSO gate for free.
- A set of **database-setup changes should land with the migration**: split
  pg-boss onto its own instance, partition the `events` table, set
  `synchronous_commit=off`, and get the blob copy out of the
  `create_submission` transaction. These matter more than the DB engine choice.
- A **future incremental Gradescope sweep** (ingest new submissions hourly
  instead of one big export) would smooth the burst into a trickle and is a
  strong long-term fit — but it depends on an undocumented client API and
  carries real fragility/ToS risk. Scoped at the end as forward-looking.

---

## 1. Current state and why it doesn't translate

The dev stack (`compose.yaml`) is a single Node process serving both API and
worker, a single Postgres 16 container, and MinIO for object storage, all on one
host. `admin-guide.md` §1 documents this as the supported single-node
deployment.

This is correct for development and small self-hosting, but three properties
make it the wrong shape for a managed Berkeley deployment:

1. **API and worker share a process.** The interactive API (light, always-on)
   and the ingest worker (heavy, bursty) cannot be scaled or sized
   independently. An import starves the API; an idle semester pays for worker
   capacity it isn't using.
2. **The queue shares the OLTP database.** pg-boss runs on `DATABASE_URL`
   (`packages/server/src/jobs/pg-boss.ts`), so during a 35M-row import the
   queue's own send/fetch/complete/archive writes and its monitor/expire pollers
   contend with the event load on the same node and the same connection budget
   (`env.ts` already notes this tension around `DATABASE_POOL_MAX`).
3. **MinIO and local disk are not durable enough for audit data.** The system's
   whole premise is tamper-evident, permanently-retained records (rows kept
   forever; see `admin-guide.md` §6). That belongs on managed object storage and
   managed Postgres with PITR, not a container volume.

## 2. Workload characterization

Everything downstream follows from the measured shape of the load. From
`ingest-700x50k-run.md` (700 students × 50k events, the headline fleet-scale
scenario):

| Property                               | Measured / observed                                                                  | Infra implication                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Ingest is **bursty and batch**         | one 2.5 GB export, ~17.8 min processing window, a few times/semester                 | worker tier should **burst then scale toward zero**       |
| Ingest is **DB-write-bound**           | `materialize_events` 20.6% + `create_submission` 6.6%; ~76% of per-bundle work is DB | DB write throughput is the lever, not app CPU             |
| Reads are **light, low-concurrency**   | tens of course staff drilling into submissions                                       | small always-on API; a read replica covers serving        |
| Data is **audit-permanent, monotonic** | ~22 GB rows + ~12 GB blobs per 700×50k cohort, kept forever                          | storage grows every semester; size for years, one node    |
| Data is **FERPA / UC P3–P4 sensitive** | student academic-integrity records                                                   | private networking, CMEK option, audit logging, US region |

The defining trait — **spiky compute on a tiny baseline with durable
ever-growing storage** — is what rules out Kubernetes, AlloyDB-as-day-one, and
distributed Postgres for this scale, and rules _in_ serverless containers + a
right-sized managed core.

## 3. Where time goes today (and the levers)

Grounded in `ingest-700x50k-run.md`. The end-to-end run was ~1369 s, in three
cost centers with very different optimization stories:

| Bucket           |                              Share | Nature                                                                | Lever                                                                              |
| ---------------- | ---------------------------------: | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Worker DB writes | gates throughput @ ~0.70 bundles/s | `materialize_events` + `create_submission` + tx                       | `synchronous_commit=off`, partition `events`, Aurora/AlloyDB-class storage         |
| Staging pass     |                       804.6 s wall | serial, but **outpaces** the worker (0.87 vs 0.70 b/s) — not the gate | lower priority; only matters if the worker gets much faster                        |
| Cross-flags      |            300 s+ (did not finish) | re-reads all 35M rows to build tiny feature vectors                   | compute features **at ingest**, persist them; cross-flags reads vectors not events |

Two findings from the code review behind this plan are worth carrying into the
migration because they are host-independent:

- **`create_submission` does a ~34 MB S3 round-trip inside the DB transaction**
  (`create-submission.ts`: `getBlob(staging)` → buffer → `putBlob(final)` →
  `deleteBlob`), holding a Postgres connection + `FOR UPDATE` lock across two
  object-store round-trips. On GCS this should become a **server-side object
  copy** (or stage straight to the final key), moving the bytes out of the
  transaction entirely.
- **Cross-flags re-reads the entire `events` table** to rebuild a small n-gram +
  paste feature set per submission (`extract-cross-features-from-db.ts`). The
  worker already holds the full `EventIndex` at ingest time; extracting and
  persisting `CrossSubmissionFeatures` there turns the 300 s+ re-read into
  seconds and is _more_ correct (real `globalIdx` vs the replicated sort).

These are tracked as pre/with-migration DB work in §5.

## 4. Target GCP architecture

### 4.1 Component map

| Concern        | GCP service                                           | Day-one sizing (2–3 courses)                              |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| API server     | **Cloud Run**                                         | 1 vCPU / 1 GB, min-instances **1**, max ~5                |
| Ingest worker  | **Cloud Run** (CPU always-allocated)                  | 4–8 vCPU / 4–8 GB, min **1**, scale up per import         |
| Primary DB     | **Cloud SQL for PostgreSQL** (Enterprise Plus, PG 16) | ~4 vCPU / 16 GB, SSD, HA                                  |
| Read replica   | Cloud SQL replica                                     | 1, for analyzer + any event-reads                         |
| Job queue DB   | **separate** small Cloud SQL instance                 | db-g1-small (pg-boss only)                                |
| Bundle storage | **GCS** bucket (Standard)                             | + lifecycle rules for blob retention                      |
| Analyzer SPA   | **Firebase Hosting** (or GCS + Cloud CDN)             | static build, global CDN                                  |
| Secrets        | **Secret Manager**                                    | OAuth secrets, DB creds, signing keys                     |
| Edge auth      | **Identity-Aware Proxy**                              | Google SSO gate ahead of the app                          |
| WAF / LB       | **Cloud Armor** + external HTTPS LB                   | API ingress                                               |
| Scheduled jobs | **Cloud Scheduler**                                   | retention sweep, session purge (replaces in-process cron) |
| Metrics / logs | **Cloud Monitoring** + Managed Service for Prometheus | existing `/metrics` exports in                            |

Region: **us-west1 (Oregon)** — nearest GCP region to Berkeley; keeps all data
US-resident in one region for the data-classification story.

### 4.2 Compute — split API and worker

The single most important change: run the **API and worker as separate Cloud Run
services** from separate images. The worker entrypoint already exists
(`startWorker`); it just needs its own container target. This lets the worker be
fatter (more vCPU/RAM — `INGEST_CONCURRENCY` scales with cores) and scale
independently of the always-on API.

**The pg-boss / Cloud Run wrinkle (be explicit about it).** pg-boss is a
_polling_ subscriber — it pulls jobs from Postgres. Cloud Run autoscales on
inbound _requests_, so a poller does **not** autoscale on queue depth natively.
Two paths:

- **Pragmatic (day one):** keep pg-boss; run the worker as a Cloud Run service
  with CPU always allocated and min-instances=1 (small, cheap, keeps the poller
  alive). For a large import, bump its vCPU / `INGEST_CONCURRENCY` for that
  window, or raise max-instances to 2–4 — pg-boss supports multiple subscribers
  coordinating via Postgres row locks, so several worker instances safely share
  one backlog. No rewrite; nobody waits on ingest in real time anyway.
- **Idiomatic (the evolution):** replace the pg-boss enqueue with **Cloud Tasks
  → HTTP push to the worker Cloud Run service.** Each `ingest_file` becomes a
  push; Cloud Run autoscales on push volume and **scales to zero** when the
  backlog drains. This also removes the queue from Postgres entirely (killing
  the §1.2 contention). Cost: rewriting the job layer off pg-boss. Worth it once
  imports get frequent enough that manual scaling annoys — and it is the natural
  substrate for the incremental-sweep design in §6.

Ship pragmatic; keep Cloud Tasks as a planned migration. (The incremental-sweep
work in §6 strengthens the case for it.)

### 4.3 Database — Cloud SQL now, AlloyDB as a known upgrade

Start on **Cloud SQL for PostgreSQL (Enterprise Plus)**, not AlloyDB:

- AlloyDB is the better _write-burst_ engine (its distributed storage offloads
  the WAL-fsync wall that dominates `materialize_events`), but it has a higher
  always-on floor — you'd pay for it through the idle 99% of the semester.
- At 2–3 courses, a right-sized Cloud SQL Enterprise Plus instance (data cache +
  faster storage) handles the import windows, and you can **resize the tier up
  for a big import and back down after** since imports are predictable.
- Keep AlloyDB as a documented upgrade path if write-burst stays painful after
  the §5 DB changes. The partitioning + `synchronous_commit` + queue-split work
  matters more than the engine choice at this scale.

Add **one read replica** for the analyzer's serving reads (and for cross-flags
event-reads, if the §5 "features-at-ingest" change isn't done yet). Replicas do
**not** help ingest writes — they are a serving-side decision.

### 4.4 Object storage — GCS

MinIO is dev-only. Use a **GCS bucket** (the SDK is already S3-compatible — an
endpoint + credential swap, via a GCS HMAC key or the native client):

- 11-nines durability for audit blobs.
- **Delegate the time-based portion of the retention sweep to bucket lifecycle
  rules**, keeping app logic only for the conditional cases (`admin-guide.md`
  §6 deletes blobs only; rows persist).
- Uniform bucket-level access; CMEK if campus ISO requires customer-managed keys.

### 4.5 SPA — CDN, not a Node server

The analyzer is a static Vite build. Serve it from **Firebase Hosting** (or GCS

- Cloud CDN) — global CDN, near-zero cost, no container. Do not run a Node
  process to serve static assets.

### 4.6 Auth — IAP + the existing hd-claim

The app already enforces the Google ID-token `hd` claim against
`AUTH_ALLOWED_HOSTED_DOMAINS` (CLAUDE.md "OAuth `hd` claim"). Set it to
`berkeley.edu`. Layer **Identity-Aware Proxy** in front of the SPA/API so Google
SSO is enforced at the infra edge _before_ a request reaches the app — defense
in depth that complements, not replaces, the hd-claim. Berkeley accounts are
Google-backed, so this is friction-free for staff.

### 4.7 Networking & security (UC P3–P4)

Academic-integrity records are UC data-classification **P3/P4** territory:

- Cloud SQL on **private IP** (Private Service Access); no public DB endpoint.
  Cloud Run reaches it via the built-in Cloud SQL connector or a Serverless VPC
  connector.
- **Cloud Armor** (WAF) on the API load balancer.
- **CMEK** on Cloud SQL + GCS if campus Information Security requires
  customer-managed keys.
- **Cloud Audit Logs** on all services — aligned with the system's audit premise.
- **Action item:** confirm the data-classification requirements with Berkeley's
  Information Security Office before go-live; student-conduct data usually
  triggers a review.

### 4.8 Observability

The server already exposes Prometheus metrics. Point **Managed Service for
Prometheus** at `/metrics` and ship logs to **Cloud Logging**. Alert on queue
depth, worker error rate, DB connection saturation, and ingest job failure.

## 5. Database-setup changes to land with the migration

These are host-independent but should ship as part of (or just before) the move,
because they target the measured bottleneck and change the schema/topology:

1. **Split pg-boss onto its own Cloud SQL instance** (or move to Cloud Tasks per
   §4.2). Removes queue churn from the OLTP node.
2. **Partition `events` by `HASH(submission_id)`** (16–32 partitions).
   Smaller per-partition B-trees → cheaper index maintenance and better cache
   residency under concurrent writers; every analyzer query is
   `WHERE submission_id = ?`, so reads get **perfect partition pruning** too.
   Hand-authored SQL migration (Drizzle can't express partitioning — consistent
   with the existing SQL-only index migrations); mind the `events → submissions`
   FK + cascade under partitioning.
3. **`synchronous_commit = off`** on the ingest path. Durability risk is "lose
   the last few in-flight txns on a hard crash," not corruption — and ingest is
   idempotent/retryable via the queue, so a lost txn just re-runs. Highest-
   leverage single knob for the whole DB-bound window.
4. **Get the blob copy out of the `create_submission` transaction** — use GCS
   server-side copy (or stage straight to the final key). Stops holding a
   connection + lock across two object-store round-trips.
5. **Compute `CrossSubmissionFeatures` at ingest and persist them**, so
   cross-flags stops re-reading the 35M-row `events` table. Biggest structural
   win for the cross-flags bucket.

Items 1–4 are tuning/topology; item 5 is an architecture improvement. Benchmark
2 and validate 3/4 against the `profile:ingest` harness before/after.

## 6. Future: incremental Gradescope sweep (forward-looking, not yet scoped)

> Status: **exploratory.** This section records the design intent and its risks
> so the architecture above leaves room for it. It is not a committed feature.

### 6.1 The idea

Instead of one all-at-once export per assignment, run an **hourly (or so) sweep**
that pulls _new_ student submissions from Gradescope as they arrive and ingests
them one-at-a-time. A new submission's files already contain the `.provenance`
bundle (it is part of what the student submits), so each swept submission is the
same per-submission shape the current export path already rebuilds.

### 6.2 Why it fits the architecture well

It **smooths the burst into a trickle**, which is strictly good for everything in
this plan:

- The worker autoscaling problem largely disappears — 1–few bundles/hour instead
  of a 700-bundle firehose.
- DB write contention drops from 8 concurrent 50k-row inserts to near-serial
  low-contention writes.
- It is the natural fit for the **Cloud Tasks → Cloud Run** model (§4.2): each
  newly-discovered submission becomes one task; **Cloud Scheduler** triggers the
  hourly sweep.
- Cross-flags can move toward **incremental** updates as submissions arrive,
  rather than an O(S²) all-at-once recompute.

### 6.3 Shape

A new **ingest source** that feeds the _existing_ per-file pipeline — it must not
fork the pipeline:

```
Cloud Scheduler (hourly)
  → Gradescope poller (Cloud Run job)
      authenticate (instructor session, creds in Secret Manager)
      for each tracked assignment:
        list submissions  →  diff against already-ingested (dedup by blob sha256 / GS submission id)
        download only new submission files
        → stageBlob → ingest_files row → enqueue (same as local-path / HTTP route today)
```

The pipeline already dedups by `blob_sha256`, so a re-downloaded unchanged
submission should no-op — the sweep leans on that heavily. New state needed: a
per-assignment "tracked" flag + last-swept cursor, and the set of
already-ingested Gradescope submission ids.

### 6.4 Risks — these are real and gate the work

- **No public API.** Gradescope (Turnitin-owned) has no public developer API;
  integrations reverse-engineer the web client's internal endpoints (the
  approach taken by community tools). **Fragile** — endpoints can change without
  notice and break mid-semester.
- **Authentication is the hardest part.** Requires an instructor session: stored
  credentials (Secret Manager), cookie/CSRF handling, session expiry, and
  possible bot-detection / CAPTCHA. This is the primary operational risk.
- **Terms of Service / institutional.** Scraping an undocumented API may violate
  Gradescope's ToS. Berkeley licenses Gradescope campus-wide — **check first**
  whether an instructor-sanctioned path exists (official export, LTI 1.3, or a
  Canvas/bCourses integration angle, since Berkeley uses bCourses) before relying
  on scraping.
- **Rate limits / politeness.** Hourly × many assignments × bundle downloads
  needs backoff, conditional fetches, and caching.

### 6.5 Design guardrails (if it is built)

- Implement it as a **pluggable ingest source behind a clear adapter boundary**,
  isolating the fragile Gradescope-client code from the stable pipeline.
- **Keep the bulk-export path as the canonical fallback.** It is robust and has
  no undocumented-API dependency; the sweep is an optimization on top, gated by a
  per-assignment feature flag.
- Make sweeps **idempotent and dedup-driven** so a partial or repeated sweep is
  always safe.
- Pair with **incremental cross-flags** as a follow-on, so each sweep doesn't
  trigger a full O(S²) recompute.

## 7. Migration plan (phased)

Ordered so each phase is independently shippable and de-risks the next.

1. **Re-baseline off Docker-for-Mac.** The measured run was local Docker on
   macOS, whose virtualized `fsync` path penalizes exactly this write workload.
   Re-measure on a Linux/managed target before sizing — the single-node ceiling
   may be largely the laptop. (See `ingest-700x50k-run.md` caveats.)
2. **Code prerequisites** (host-independent, do before lift):
   - GCS storage-client config (endpoint/credentials swap).
   - Split the worker into its own entrypoint/image.
   - Server-side blob copy in `create_submission` (§5.4).
3. **Stand up the managed core:** Cloud SQL primary + replica, separate queue
   instance, GCS bucket, Secret Manager, private networking. Run Drizzle
   migrations; add the partitioning migration (§5.2) and `synchronous_commit`
   config (§5.3).
4. **Deploy compute:** API and worker as separate Cloud Run services; SPA to
   Firebase Hosting; Cloud Scheduler for retention/purge crons; IAP + Cloud
   Armor; `AUTH_ALLOWED_HOSTED_DOMAINS=berkeley.edu`.
5. **Validate** with `profile:ingest` against the managed stack; confirm the
   §5 DB changes moved the numbers; load-test a representative import.
6. **(Later) cross-features-at-ingest** (§5.5), then **Cloud Tasks worker**
   (§4.2), then evaluate the **incremental sweep** (§6).

## 8. Cost posture

The architecture is deliberately **idle-cheap, burst-on-demand**. At idle (most
of the semester): one small API instance, one small worker, a modest Cloud SQL
primary + replica, a tiny queue instance, GCS at pennies, near-free static
hosting. The only spend that spikes is the worker (and optionally a temporary DB
tier bump) during the few import windows per semester. Because ingest is not
latency-critical, the worker can be deliberately under-provisioned — letting an
import take 30 min instead of 18 — to trade wall-clock for cost.

Explicitly **out of scope at this scale:** GKE/Kubernetes (no platform team to
justify it), AlloyDB/Citus as day-one (one node holds years of data here), and
multi-region. Those enter only if the system grows beyond Berkeley into a
multi-institution service.

## 9. Open decisions to confirm

- **Campus data classification** — confirm UC P3/P4 requirements and whether
  CMEK / specific audit controls are mandated (Berkeley ISO).
- **Queue substrate** — keep pg-boss-on-its-own-instance, or commit early to
  Cloud Tasks (favored if §6 is on the roadmap).
- **Cloud SQL vs AlloyDB** — start Cloud SQL; set a concrete trigger (e.g.
  import wall-clock or write-saturation threshold) for revisiting AlloyDB.
- **Gradescope integration path** — whether an instructor-sanctioned/official
  route exists before committing to the undocumented-client approach (§6.4).
