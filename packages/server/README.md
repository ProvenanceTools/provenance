# @provenance/server

Node.js API server for the Provenance Analyzer v3.

Current schema version: **0029** (`submission_contributors` — a submission belongs to a set of people; see `db/migrations/0029_submission_contributors.sql`).

## Dev quickstart

### 1. Start backing services

```bash
# From the repo root
docker compose up -d
```

This starts Postgres 16 (port 5432) and MinIO (ports 9000/9001).
The MinIO web console is at http://localhost:9001 (user: `minioadmin`, password: `minioadmin`).

Create the storage bucket (one-time):

```bash
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker compose exec minio mc mb local/provenance
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET from Google Cloud Console.
```

See `docs/analyzer-v3-prd.md §3` for the full env var reference.

### 3. Run the server

```bash
npm run dev --workspace=packages/server
```

`npm run dev` runs in `--mode=all`: the HTTP API **and** the pg-boss worker in one
process, so uploaded bundles are actually ingested. Override with
`npm run dev --workspace=packages/server -- --mode=api` to run the API alone.

Verify:

```bash
curl localhost:3000/healthz
# {"status":"ok"}
```

## Run modes

```bash
# API server only (no background jobs)
node dist/index.js --mode=api

# Worker only (pg-boss job handlers + cron jobs)
node dist/index.js --mode=worker

# Both in one process — for single-machine dev / staging (what `npm run dev` uses)
node dist/index.js --mode=all
```

Mode defaults to `api` when no flag is given. The last `--mode=` wins, so a script
default can be overridden on the command line. In production, run `--mode=api` and
`--mode=worker` as separate processes so they can be scaled independently.

## Seeding example data

`npm run seed` populates a local database with an example cohort so other staff can
click around the analyzer without hunting for real submissions. It does the realistic
thing end to end: it generates a Gradescope export ZIP and runs it through the **real**
ingest pipeline (the same `POST /ingest:gradescope` route + worker that production uses).

Prerequisites are the same as `npm run dev`: `docker compose up -d`, the MinIO bucket
created (step 1 above), `.env` present, and migrations applied. Then:

```bash
npm run seed --workspace=packages/server
```

What it creates (all under an isolated `seed-demo` semester, so it never collides with
a real one):

- a `CS 61A (seed)` course + `Seed Demo — CS 61A` semester,
- **~700 rostered students** across three assignments (`hw10`, `hw11`, `proj02`),
  including a few **group submissions** (co-submitters share a bundle) and a few students
  who submitted **without the recorder** (skipped, but rostered),
- a recorder bundle per student, fully ingested (events, per-file stats, validation,
  heuristics), with a deliberate spread of findings: most students type normally; ~214
  paste a large blob (`large_paste`, `paste_is_solution`, `low_typing_high_output`); six
  clusters paste identical blobs on the same assignment, producing
  `paste_shared_across_students` cross-flags (plus a handful of `editing_pattern_clone`).

This is intentionally cohort-sized so the analyzer's pagination, filters, and
cross-submission views have real volume — and so the ingest flow itself can be
stress-tested. Expect the ingest to take a few minutes (the worker processes bundles one
at a time).

Flags and notes:

- **Idempotent by default.** Re-running once `seed-demo` is populated is a no-op.
- **`--regenerate`** wipes the seed semester's own data (scoped strictly to `seed-demo`),
  rebuilds the committed example export (`scripts/seed/example-gradescope-export.zip`,
  ~6 MB), and reseeds from scratch:
  `npm run seed --workspace=packages/server -- --regenerate`. The export content (roster,
  event timelines, paste contents) is deterministic; only the per-build signing key differs.
- **Viewing it.** The seed authors the ingest as a synthetic `seed-admin@berkeley.edu`
  user (not a real login). To see the data in the analyzer UI, add your own Google email
  to `AUTH_SUPERADMIN_EMAILS` in `.env`, restart the server, and sign in — superadmins
  see every semester.

The example export ZIP is committed, so you can also upload it manually via the UI or
`POST /ingest:gradescope` against any semester you own — handy for stress-testing the
ingestion flow by hand.

## Ingesting submissions

Both ingest paths feed the **same** pipeline — roster upsert → match → parse →
heuristics → cross-flags, run by the pg-boss worker — and produce identical results.
They differ only in how the export ZIP reaches the server.

### 1. HTTP upload (the analyzer UI and the API)

The primary path. Course staff upload a Gradescope "Download Submissions" export from
the analyzer's Ingest page, or via the API:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -F "archive=@export.zip;type=application/zip" \
  "$BASE_URL/semesters/$SEMESTER_ID/ingest:gradescope"
```

The upload is **streamed straight to a temp file** on the server (not buffered in
memory) and then read with the same streaming reader as local-path ingest, so it is
bounded by disk — `INGEST_MAX_UPLOAD_BYTES` (default 10 GiB) — not by heap. Multi-GB
exports go through this single endpoint with no special handling.

For very large exports the analyzer uploads **resumably**: files at or above 1 GiB are
split into parts backed by an S3 multipart upload, so an interrupted transfer (dropped
connection, page reload) resumes by re-sending only the parts the server is missing
rather than restarting from zero. Smaller exports use a single request. Both produce
the same result. The resumable protocol is also available directly on the API
(`POST …/ingest/uploads`, `PUT …/parts/:n`, `GET …/parts`, `POST …/complete`,
`DELETE …`); see the OpenAPI spec.

**`POST …/complete` is asynchronous.** It returns `202 { job_id, … }` immediately;
the `roster`, `bundles_processed`, `submissions_queued`, and `skipped` fields in that
response are placeholder zeros. Assembly and staging run in a background
`ingest_stage_upload` job — poll `GET /semesters/:semesterId/ingest/jobs/:jobId` until
`status` is terminal (`succeeded` / `partial` / `failed`) to get the real outcome. An
invalid export surfaces as a `failed` job rather than a synchronous `400`.

### 2. Local-path ingest (`npm run ingest:local`) — for very large exports

When the export already lives on the server's disk (e.g. a multi-GB or 10 GB+
Gradescope export), ingest it directly from the filesystem — no upload, no in-memory
size limit:

```bash
npm run ingest:local --workspace=packages/server -- \
  --path ./export.zip --semester <semester-id> --user staff@berkeley.edu
```

It reads the ZIP with a **streaming random-access reader** (`yauzl`): the central
directory is read up front (filenames only), then each submission folder is extracted,
rebuilt into a sealed bundle, staged, and released one at a time. **Peak memory is a
single submission bundle** (tens of MB) regardless of the total archive size, so it
scales to arbitrarily large exports. Because it is bounded per-bundle, it deliberately
does **not** apply the `INGEST_MAX_BATCH_BYTES` total cap (the per-bundle
`INGEST_MAX_BUNDLE_BYTES` and the `INGEST_MAX_BATCH_FILES` count cap still apply).

Arguments:

| Flag         | Required | Description                                                |
| ------------ | -------- | ---------------------------------------------------------- |
| `--path`     | yes      | Path to the Gradescope export ZIP on the server's disk.    |
| `--semester` | yes      | Target semester id (must already exist).                   |
| `--user`     | yes      | Email of an existing user, recorded as the job's uploader. |

Like the HTTP path it upserts the roster from the export metadata (no pre-existing
roster required) and enqueues one `ingest_file` job per submitter. **A worker must be
running** (`npm run dev` in `--mode=all`, or a separate `--mode=worker` process) to
process the queued submissions. It prints a summary (job id, roster added/updated,
bundles processed, submissions queued, skipped folders by reason).

## Cron jobs

Five scheduled jobs are registered in pg-boss on worker startup (`boss.schedule()` is
idempotent, so registration is repeated on every start):

| Job                      | Cron (UTC)  | Description                                                        |
| ------------------------ | ----------- | ------------------------------------------------------------------ |
| `retention_sweep`        | `0 2 * * *` | Purge blobs past semester retention window (PRD §16)               |
| `purge_expired_sessions` | `0 * * * *` | DELETE expired session rows                                        |
| `purge_expired_exports`  | `0 3 * * *` | Stub — export artifacts (v3.1)                                     |
| `reap_stale_uploads`     | `0 4 * * *` | Reclaim abandoned multipart staging dirs (fs backend; no-op on s3) |
| `storage_quota_check`    | `0 * * * *` | Measure disk use against `STORAGE_QUOTA_BYTES` and set the gauges  |

Handler sources: `src/jobs/retention-sweep.ts`, `src/jobs/purge-expired-sessions.ts`,
`src/jobs/purge-expired-exports.ts`, `src/jobs/reap-stale-uploads.ts`,
`src/jobs/storage-quota-check.ts`. Registered via `boss.schedule()` in `src/jobs/worker.ts`.

## Database migrations

### Apply migrations

```bash
# Run all pending migrations against DATABASE_URL
npm run db:migrate --workspace=packages/server
```

### Generate a new migration after editing the schema

```bash
# 1. Edit packages/server/src/db/schema.ts
# 2. Run drizzle-kit to generate the migration SQL:
npm run db:generate --workspace=packages/server
# 3. Review the generated file in packages/server/db/migrations/.
#    drizzle-kit cannot express partial/functional indexes — hand-edit those.
#    Pattern: grep for "IMPORTANT: hand-edit" comments in the schema for known gaps.
# 4. Apply to local dev DB:
npm run db:migrate --workspace=packages/server
# 5. Commit both schema.ts and the new .sql migration file together.
# 6. Update the "Current schema version" in this README.
```

**Migrations through 0012:**

| Migration | Contents                                                                              |
| --------- | ------------------------------------------------------------------------------------- |
| 0001      | users, sessions, courses, semesters, memberships, roster_entries, pending_invitations |
| 0002      | api_tokens                                                                            |
| 0003      | rate_limit_buckets                                                                    |
| 0004      | audit_log                                                                             |
| 0005      | roster_entries (index fix)                                                            |
| 0006      | ingest_jobs, ingest_files, assignments, submissions                                   |
| 0007      | events, per_file_stats                                                                |
| 0008      | validation_results                                                                    |
| 0009      | flags                                                                                 |
| 0010      | heuristic_configs, recompute_jobs                                                     |
| 0011      | (reserved)                                                                            |
| 0012      | cross_flags, cross_flag_participants                                                  |

Migrations are stored in `packages/server/db/migrations/` and tracked by
`meta/_journal.json`. The `db:migrate` script runs `drizzle-orm`'s migrator
directly (no drizzle-kit CLI needed at runtime).

> **npm workspaces note:** `drizzle-kit` is hoisted to the repo root by npm
> workspaces, but `drizzle-orm` lives in `packages/server/node_modules/`.
> If `npm run db:generate` errors with "Please install latest version of
> drizzle-orm", create a temporary symlink in the repo-root `node_modules/`:
>
> ```bash
> ln -s packages/server/node_modules/drizzle-orm node_modules/drizzle-orm
> ```
>
> Remove it after generating the migration. A permanent fix is to move
> `drizzle-kit` to the root `devDependencies` alongside `drizzle-orm`.
> (Tracked in TODO — needs approval per CLAUDE.md.)

### Testcontainers requirement

Integration tests (`src/db/*.test.ts`, `test/helpers/*.test.ts`) spawn a
real Postgres 16 container via testcontainers. **Docker must be running** on
the host when you run `npm run test`. Tests are skipped (with a clear error)
if Docker is unavailable.

Each test case gets its own container and database, so tests are fully
isolated with no shared state.

## Scripts

| Script                   | Description                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `npm run dev`            | Dev server with file-watching via tsx (`--mode=all` by default)                                  |
| `npm run build`          | Bundle to `dist/index.js` via esbuild                                                            |
| `npm run start`          | Run the production bundle                                                                        |
| `npm run test`           | Run unit + integration tests (vitest)                                                            |
| `npm run test:perf`      | Run the perf suite (`test/perf`) with `ANALYZE_PERF=1`                                           |
| `npm run typecheck`      | Type-check without emit                                                                          |
| `npm run lint`           | ESLint                                                                                           |
| `npm run db:migrate`     | Apply pending migrations to DATABASE_URL                                                         |
| `npm run db:generate`    | Generate new migration from schema changes                                                       |
| `npm run seed`           | Populate a local `seed-demo` semester via the real ingest pipeline (above)                       |
| `npm run ingest:local`   | Ingest a large Gradescope export from disk (see [Ingesting submissions](#ingesting-submissions)) |
| `npm run gen:fixture`    | Generate a large signed test-fixture export (see below)                                          |
| `npm run profile:ingest` | Profile the ingest pipeline phase-by-phase (see below)                                           |
| `npm run profile:large`  | Profile ingest of a single very large bundle (see below)                                         |

## Development & profiling tooling

These scripts under `scripts/` are dev/test tooling, not shipped server code. They drive
the server's own modules directly.

### `gen:fixture` — large export generator

Generates a faithful Gradescope export of N students, each with one fully signed,
hash-chained `.provenance` bundle of M events, using the real `@provenance/log-core`
crypto core (so every bundle passes validation and matches the analyzer's extension-hash
allowlist). Defaults to the "700 large bundles" scenario (700 students × 50,000 events).

```bash
npm run gen:fixture --workspace=packages/server
npm run gen:fixture --workspace=packages/server -- --students 700 --events 50000 --out /tmp/fix.zip
```

It is memory-safe by construction: each bundle is built, written to a staging directory,
and released before the next, then the staging tree is packaged with the streaming system
`zip` (never a whole-export JSZip in memory). The result is one large export ZIP — ingest
it via [`npm run ingest:local`](#ingesting-submissions) (reads it straight from disk), or
upload it through the analyzer (the upload is streamed/resumable, so a multi-GB single
file is fine). The fixture's sids are `200001..200000+N` and its assignment is `hw10` —
the target semester's roster and assignment must match (or use the Gradescope path, which
upserts the roster from the export metadata automatically).

### `profile:ingest` / `profile:large` — pipeline profiling

Both drive the real route + worker in-process and print a per-phase timing table (parse,
match, heuristics, stats, validation, crypto, DB, S3). They need the same backing services
as `npm run dev` (Postgres + MinIO up, migrations applied) and set `INGEST_PROFILE=1`
inline. Use them to check the cost model after changing any pipeline stage.

- `profile:ingest` runs the committed ~700-bundle example export against a fresh,
  deterministically-wiped `perf-test` semester, with wall-clock segmentation (upload /
  worker drain / cross-flags).
- `profile:large` profiles **one** very large bundle (default 50,000 events; pass a custom
  count positionally) to see how per-bundle cost scales with event count and which phase
  dominates.

```bash
npm run profile:ingest --workspace=packages/server
npm run profile:large --workspace=packages/server            # 50k events
npm run profile:large --workspace=packages/server -- 100000  # custom event count
```

## Environment variables

See `docs/analyzer-v3-prd.md §3.1` for the full table. A copy with local-dev defaults is in `.env.example`.
