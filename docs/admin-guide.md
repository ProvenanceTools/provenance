# Provenance Analyzer v3 — Admin Guide

This document covers deploying, configuring, and operating the Provenance Analyzer
v3 server. Audience: course infrastructure admins and instructors who manage the
instance (not end users).

## Table of Contents

1. [Hosting requirements](#1-hosting-requirements)
2. [Deployment — server](#2-deployment--server)
3. [Google OAuth setup](#3-google-oauth-setup)
4. [Bootstrap — first login and superadmin](#4-bootstrap--first-login-and-superadmin)
5. [Creating courses and semesters](#5-creating-courses-and-semesters)
6. [Retention policy](#6-retention-policy)
7. [Cron jobs](#7-cron-jobs)
8. [Backups](#8-backups)
9. [Restore drill](#9-restore-drill)
10. [Environment variable reference](#10-environment-variable-reference)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Hosting requirements

| Component             | Minimum                                       | Recommended          |
| --------------------- | --------------------------------------------- | -------------------- |
| Node.js               | 22 LTS                                        | 22 LTS               |
| Postgres              | 16                                            | 16                   |
| Object storage        | MinIO (self-hosted) or AWS S3 / Cloudflare R2 | MinIO on same subnet |
| RAM (server)          | 512 MB                                        | 2 GB                 |
| Disk (Postgres data)  | 10 GB                                         | 50 GB                |
| Disk (object storage) | 100 GB                                        | 1 TB                 |

The server runs as a single Node.js process. It serves both the API and the frontend
SPA (the frontend is pre-built and served as static files from `packages/analyzer/dist/`).

---

## 2. Deployment — server

### 2.1 Build

```bash
git clone <repo> provenance
cd provenance
npm install
npm run build
```

This produces:

- `packages/server/dist/index.js` — the server entry point
- `packages/analyzer/dist/` — the SPA static files

### 2.2 Configure environment

Copy `.env.example` to `.env` and fill in required values:

```bash
cp packages/server/.env.example packages/server/.env
```

At minimum, set:

```
DATABASE_URL=postgres://user:password@localhost:5432/provenance
GOOGLE_OAUTH_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=<client-secret>
AUTH_COOKIE_SIGNING_SECRET=<random-32-bytes-base64>
OBJECT_STORAGE_ENDPOINT=http://localhost:9000
OBJECT_STORAGE_ACCESS_KEY_ID=minioadmin
OBJECT_STORAGE_SECRET_ACCESS_KEY=minioadmin
OBJECT_STORAGE_BUCKET=provenance
AUTH_SUPERADMIN_EMAILS=you@berkeley.edu
```

Generate the cookie secret:

```bash
openssl rand -base64 32
```

### Filesystem blob backend (apphost deployment)

Set `BLOB_STORAGE_BACKEND=fs` to store bundles on an ordinary directory
(`BLOB_STORAGE_FS_ROOT`) instead of S3-compatible object storage. Used for the
EECS Instructional apphost, where blobs live on an NFS mount bind-mounted into
the container (which runs as root inside the container so it can write the mount).

Required when `fs`:

- `BLOB_STORAGE_FS_ROOT` — the mount directory (e.g. `/srv/provenance/blobs`).
- `BLOB_URL_SIGNING_SECRET` — ≥32-char HMAC secret. Bundle downloads are served
  by `GET /api/v1/blob` via a signed, TTL-bounded URL (TTL =
  `BLOB_DOWNLOAD_URL_TTL_SECONDS`), replacing S3 presigned URLs. The token is the
  credential — same exposure as an S3 presigned URL.

Multipart/resumable uploads are supported (parts stage under
`<root>/.uploads/`). A daily cron (`reap_stale_uploads`, 04:00 UTC) reclaims
staging dirs older than `BLOB_STORAGE_FS_STAGING_TTL_SECONDS` (default 24h) so a
crashed upload cannot leak disk. Stored bundles remain provenance-only and
write-once; retention still deletes only blobs, never DB rows.

### 2.3 Run database migrations

```bash
node packages/server/dist/index.js --mode=migrate
```

Or use `npm run db:migrate --workspace=packages/server` (requires dev deps installed).

### 2.4 Start the server

**API only (recommended for separate worker deployment):**

```bash
node packages/server/dist/index.js --mode=api
```

**Worker only (runs cron jobs + background job processors):**

```bash
node packages/server/dist/index.js --mode=worker
```

**All-in-one (development / single-machine):**

```bash
node packages/server/dist/index.js --mode=all
```

The default `PORT` is 3000. Override with `PORT=8080`.

### 2.5 Serve the frontend

The SPA (`packages/analyzer/dist/`) can be served by any static file host:

- **Nginx:** configure `try_files $uri /index.html` for client-side routing.
- **Same server:** the Hono server can serve static files if you configure
  `STATIC_DIR=<path-to-dist>` (not yet wired in v3.0 — use a CDN or Nginx).
- **Vite preview** (dev only): `npm run preview --workspace=packages/analyzer`

Point the frontend's `VITE_API_BASE_URL` build-time variable at your API origin:

```bash
VITE_API_BASE_URL=https://provenance.example.edu/api/v1 npm run build --workspace=packages/analyzer
```

### 2.6 Scaling the ingest worker

Per-bundle ingest cost is ~1s of CPU and is at its algorithmic floor (see
`docs/ingest-complexity.md`), so the lever for large imports — a whole
semester of bundles at once — is **throughput**, not per-bundle speed. Three
settings govern it, and they must move together:

- **`INGEST_CONCURRENCY`** (default `4`) — how many `ingest_file` jobs one
  worker process drains at once. Set it roughly to the worker's core count;
  each concurrent job is ~1s of CPU, so it scales near-linearly with cores. A
  700-bundle drain measured **348s at concurrency 1 → 87s at 4 → 44s at 8**.
- **`DATABASE_POOL_MAX`** (default `10`) — per-process Postgres connection cap.
  Each in-flight ingest job holds ~1 connection for its transaction, and
  pg-boss needs its own connections to poll and complete jobs. **Keep
  `INGEST_CONCURRENCY` comfortably below `DATABASE_POOL_MAX`** (e.g. 8 with 16),
  or jobs starve waiting on connections. Confirm Postgres `max_connections`
  covers the pool across every server/worker process you run.
- **Cores and RAM** are the hardware ceilings. CPU saturates around
  **concurrency 6–8 on a single Postgres instance** (large-bundle throughput is
  DB-write-bound, so returns diminish once Postgres saturates on writes). RAM is
  the other bound: each concurrent job holds a full decompressed bundle working
  set in heap, so safe concurrency is roughly
  `min(cores, DATABASE_POOL_MAX − headroom, RAM ÷ peak-bundle-footprint)`.

For more throughput beyond one instance, run multiple `--mode=worker`
processes (§3.2 of the v3 PRD) against the same database; pg-boss distributes
jobs across them. Each process gets its own `DATABASE_POOL_MAX`, so size
Postgres `max_connections` for the total.

Example large-import worker config:

```bash
INGEST_CONCURRENCY=8 DATABASE_POOL_MAX=16 \
  node packages/server/dist/index.js --mode=worker
```

---

## 3. Google OAuth setup

Provenance uses Google OAuth with an `hd` (hosted domain) constraint. Only users
whose Google account belongs to your institution's Google Workspace domain can log in.

### 3.1 Create a project in Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Create a new project: `provenance-<semester>`.
3. Navigate to **APIs & Services → Credentials**.
4. Click **Create Credentials → OAuth client ID**.
5. Application type: **Web application**.
6. Name: `Provenance Analyzer`.
7. **Javascript authorized origins:** add:
   ```
   https://provenance.example.edu
   ```
   (Replace with your actual domain. For local dev: `http://localhost` and `http://localhost:5173`)
8. **Authorized redirect URIs:** add:
   ```
   https://provenance.example.edu/api/v1/auth/google/callback
   ```
   (Replace with your actual domain. For local dev: `http://localhost:3000/api/v1/auth/google/callback`.)
9. Click **Create**. Copy the **Client ID** and **Client Secret**.

### 3.2 Configure hosted domain restriction

Set `AUTH_ALLOWED_HOSTED_DOMAINS` to your institution's Google Workspace domain.
The default is `berkeley.edu`:

```
AUTH_ALLOWED_HOSTED_DOMAINS=berkeley.edu
```

To allow multiple domains (e.g. for cross-listed courses):

```
AUTH_ALLOWED_HOSTED_DOMAINS=berkeley.edu,stanford.edu
```

The server validates the `hd` claim in the Google ID token. Accounts that do not
match the allowed domains are rejected with a `HOSTED_DOMAIN_MISMATCH` error.

### 3.3 OAuth consent screen

In Google Cloud Console → **APIs & Services → OAuth consent screen**:

- User type: **Internal** (restricts to your Workspace domain automatically; recommended).
- App name: `Provenance`.
- Authorized domain: your institution domain.
- No additional scopes needed beyond `openid email profile`.

---

## 4. Bootstrap — first login and superadmin

### 4.1 Set AUTH_SUPERADMIN_EMAILS

Before any user logs in, set the `AUTH_SUPERADMIN_EMAILS` environment variable to
the email addresses that should receive superadmin privileges on first login:

```
AUTH_SUPERADMIN_EMAILS=alice@berkeley.edu,bob@berkeley.edu
```

On first login, the server checks whether the authenticated user's email is in this
list and sets `users.is_superadmin = true` if so.

**Production requirement:** `AUTH_SUPERADMIN_EMAILS` must be non-empty when
`NODE_ENV=production`. The server will refuse to start if it is empty.

### 4.2 Log in

Navigate to `https://provenance.example.edu` and click **Sign in with Google**.
After authenticating, you will land on the Home view. Your account will have
superadmin status if your email was in `AUTH_SUPERADMIN_EMAILS`.

### 4.3 Verify superadmin status

```bash
curl -s -H 'Cookie: __Host-prov_sess=<your-session-cookie>' \
  https://provenance.example.edu/api/v1/me \
  | python3 -m json.tool | grep is_superadmin
```

Expected: `"is_superadmin": true`.

---

## 5. Creating courses and semesters

Via the API (or, in a future release, via the UI):

```bash
# Create a course
curl -s -X POST https://provenance.example.edu/api/v1/courses \
  -H 'Content-Type: application/json' \
  -H 'Cookie: __Host-prov_sess=<session>' \
  -d '{"name": "CS 61A", "slug": "cs61a"}'

# Create a semester
curl -s -X POST https://provenance.example.edu/api/v1/courses/<courseId>/semesters \
  -H 'Content-Type: application/json' \
  -H 'Cookie: __Host-prov_sess=<session>' \
  -d '{
    "term": "fa",
    "year": 2025,
    "slug": "fa25",
    "display_name": "Fall 2025",
    "filename_convention": "^(?P<sid>\\d{8})-(?P<assignment_id>hw\\d+)\\.zip$",
    "blob_retention_days": 540
  }'
```

Invite staff members to the semester via `POST /semesters/<semesterId>/members/invite`.

### 5.1 Ingesting submissions

Once a semester exists, staff ingest a Gradescope "Download Submissions" export. The roster
is upserted from the export's `submission_metadata.yml` (no separate roster upload needed),
and every student bundle is processed through the pipeline (match → parse → heuristics →
cross-flags) by the worker. Both ingest paths produce identical results:

- **HTTP upload** — the analyzer's Ingest page, or `POST /semesters/<id>/ingest:gradescope`.
  The upload is streamed to disk (not buffered in memory), bounded by
  `INGEST_MAX_UPLOAD_BYTES` (default 10 GiB). The analyzer uploads large exports (≥ 1 GiB)
  **resumably** so an interrupted transfer continues instead of restarting.

- **Local-path ingest** — for very large exports (multi-GB / 10 GB+) staged on the server's
  disk, ingest directly from the filesystem with no upload and no in-memory size limit:

  ```bash
  npm run ingest:local --workspace=packages/server -- \
    --path /srv/exports/export.zip --semester <semester-id> --user staff@school.edu
  ```

  It reads the archive with a streaming random-access reader, so peak memory is a single
  submission bundle regardless of total size. A **worker must be running** to process the
  queued submissions. Full details, including arguments and behavior, are in
  [`packages/server/README.md` → Ingesting submissions](../packages/server/README.md#ingesting-submissions).

Whichever path is used, monitor progress via `GET /semesters/<id>/ingest/jobs/<jobId>` or
the analyzer's Ingest job view; unmatched submissions land in the unmatched tray for manual
resolution.

---

## 6. Retention policy

> **Storage model.** Two deliberate cost decisions shape what is stored:
>
> - **Events are not stored in Postgres.** All analysis runs at ingest; only the
>   derived results (`flags`, `per_file_stats`, `validation_results`, `cross_flags`)
>   are persisted. Replay, recompute, cross-flags, the events/timeline API and the
>   Source tab re-parse the stored bundle blob on demand.
> - **Stored bundles are provenance-only.** Ingest strips the student's source
>   files before storing; the blob keeps only the signed manifest + `.slog` logs.
>   It remains fully signature- and hash-chain-verifiable. Consequently, downloading
>   a submission bundle (`include_blobs`) yields no student source — a privacy win.
>   Until the bundle is swept, its event stream is fully recoverable from the logs.

### 6.1 How blob_retention_days works

Each semester has a `blob_retention_days` column (default: **540 days**, minimum: 30).
This controls how long the (provenance-only) submission bundle blobs are kept in
object storage after the semester is archived.

The lifecycle:

1. Semester is archived: `PATCH /semesters/<id>` with `{"archived_at": "<date>"}`.
2. A daily cron job (the **retention sweep**, runs at 2:00 UTC) checks all semesters.
3. For each archived semester where `now() >= archived_at + blob_retention_days`,
   the sweep deletes the blob from object storage. Once the blob is gone the event
   stream can no longer be re-parsed (replay/recompute become unavailable), but all
   derived rows remain.
4. **DB rows are never deleted.** The `submissions`, `flags`, `per_file_stats`,
   `validation_results`, and `cross_flags` rows persist indefinitely for audit.

### 6.2 Configuring retention

To set a custom retention window when creating a semester:

```bash
# 365-day retention (delete blobs 1 year after archiving)
"blob_retention_days": 365
```

To update an existing semester's retention:

```bash
curl -s -X PATCH https://provenance.example.edu/api/v1/semesters/<semesterId> \
  -H 'Content-Type: application/json' \
  -H 'Cookie: __Host-prov_sess=<session>' \
  -d '{"blob_retention_days": 730}'
```

### 6.3 Archiving a semester

```bash
curl -s -X PATCH https://provenance.example.edu/api/v1/semesters/<semesterId> \
  -H 'Content-Type: application/json' \
  -H 'Cookie: __Host-prov_sess=<session>' \
  -d '{"archived_at": "2025-12-31T23:59:59Z"}'
```

Once a semester is archived:

- No new ingests are accepted.
- The retention clock starts.
- Historical data (events, flags, scores) remains accessible.

Archiving a **course** (`POST /courses/<courseId>/archive`) cascades: every
not-yet-archived semester in the course is archived too (each starts its own
retention clock). Semesters already archived keep their original `archived_at`.
Archiving is forward-only — there is no unarchive; revert via point-in-time
recovery.

---

## 7. Cron jobs

Cron jobs are managed by pg-boss and run automatically when the worker process is
running. They are registered on every worker startup (idempotent).

| Job name                 | Schedule (UTC) | Description                                       |
| ------------------------ | -------------- | ------------------------------------------------- |
| `retention_sweep`        | 2:00 daily     | Delete blobs past retention window (PRD §16)      |
| `purge_expired_sessions` | Every hour     | Delete `sessions` rows where `expires_at < now()` |
| `purge_expired_exports`  | 3:00 daily     | Stub — will purge export artifacts in v3.1        |

To verify cron jobs are registered:

```sql
SELECT name, cron, created_on, updated_on
FROM pgboss.schedule
ORDER BY name;
```

Expected output shows all three job names with their cron expressions.

To manually trigger a cron job (e.g. for testing):

```sql
INSERT INTO pgboss.job (name, data) VALUES ('retention_sweep', '{}');
```

---

## 8. Backups

### 8.1 Postgres

Use `pg_dump` for logical backups. Schedule daily with cron:

```bash
# Daily backup at 1:00 UTC (before retention sweep at 2:00)
pg_dump --format=custom --compress=9 \
  --dbname="$DATABASE_URL" \
  --file="/backups/provenance-$(date +%Y%m%d).dump"

# Keep 30 days of backups
find /backups -name 'provenance-*.dump' -mtime +30 -delete
```

Restore from backup:

```bash
pg_restore --clean --if-exists --dbname="$DATABASE_URL" /backups/provenance-20251231.dump
```

### 8.2 Object storage (MinIO)

**Option A — MinIO replication (recommended for production):**

Configure MinIO bucket replication to a second site or S3 bucket:

```bash
mc alias set local http://localhost:9000 $ACCESS_KEY $SECRET_KEY
mc alias set backup https://s3.amazonaws.com $AWS_ACCESS_KEY $AWS_SECRET_KEY

mc replicate add local/provenance \
  --remote-bucket backup/provenance-backup \
  --priority 1
```

**Option B — nightly snapshot:**

```bash
mc mirror local/provenance /backups/minio-$(date +%Y%m%d)/
```

---

## 9. Restore drill

Run this procedure at least once before going to production to verify your backups
are restorable. Schedule quarterly thereafter.

### Step 1: Prepare a clean environment

Start fresh Postgres and MinIO instances (do not touch production):

```bash
docker run -d --name pg-restore \
  -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=provenance \
  -p 5433:5432 postgres:16-alpine

docker run -d --name minio-restore \
  -e MINIO_ROOT_USER=testadmin -e MINIO_ROOT_PASSWORD=testadmin \
  -p 9100:9000 minio/minio:RELEASE.2025-02-28T09-55-16Z server /data
```

### Step 2: Restore Postgres

```bash
pg_restore \
  --clean --if-exists \
  --dbname="postgres://test:test@localhost:5433/provenance" \
  /backups/provenance-<date>.dump
```

Verify row counts:

```sql
SELECT COUNT(*) FROM submissions;   -- expect > 0
SELECT COUNT(*) FROM users;         -- expect > 0
SELECT MAX(created_at) FROM submissions;  -- expect recent date
```

### Step 3: Restore MinIO blobs

```bash
mc alias set restore http://localhost:9100 testadmin testadmin
mc mb restore/provenance
mc mirror /backups/minio-<date>/ restore/provenance/
```

Spot-check a blob:

```bash
mc ls restore/provenance/ | head -5
mc stat restore/provenance/<first-key>
```

### Step 4: Start the server against the restore environment

```bash
DATABASE_URL=postgres://test:test@localhost:5433/provenance \
OBJECT_STORAGE_ENDPOINT=http://localhost:9100 \
node packages/server/dist/index.js --mode=api
```

### Step 5: Verify API responses

```bash
curl localhost:3000/healthz
curl -H 'Cookie: __Host-prov_sess=<test-session>' localhost:3000/api/v1/me
```

Confirm you can see users, semesters, and submissions.

### Step 6: Tear down

```bash
docker stop pg-restore minio-restore && docker rm pg-restore minio-restore
```

Document the time taken and any issues found. Update this runbook if needed.

---

## 10. Environment variable reference

| Variable                           | Required   | Default                                             | Description                                                                    |
| ---------------------------------- | ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`                     | Yes        | —                                                   | PostgreSQL connection string                                                   |
| `DATABASE_POOL_MAX`                | No         | `10`                                                | Per-process Postgres connection cap. Must exceed `INGEST_CONCURRENCY` (§2.6)   |
| `INGEST_CONCURRENCY`               | No         | `4`                                                 | Concurrent `ingest_file` jobs per worker. See §2.6 (Scaling the ingest worker) |
| `PORT`                             | No         | `3000`                                              | HTTP port                                                                      |
| `NODE_ENV`                         | No         | `development`                                       | `development` or `production`                                                  |
| `GOOGLE_OAUTH_CLIENT_ID`           | Yes        | —                                                   | Google OAuth 2.0 client ID                                                     |
| `GOOGLE_OAUTH_CLIENT_SECRET`       | Yes        | —                                                   | Google OAuth 2.0 client secret                                                 |
| `GOOGLE_OAUTH_REDIRECT_URI`        | No         | `http://localhost:3000/api/v1/auth/google/callback` | OAuth callback URL                                                             |
| `AUTH_ALLOWED_HOSTED_DOMAINS`      | No         | `berkeley.edu`                                      | Comma-separated allowed `hd` values                                            |
| `AUTH_SUPERADMIN_EMAILS`           | Yes (prod) | `[]`                                                | Comma-separated superadmin emails                                              |
| `AUTH_COOKIE_SIGNING_SECRET`       | Yes (prod) | dev sentinel                                        | HMAC signing key for OAuth state cookie                                        |
| `AUTH_SESSION_TTL_DAYS`            | No         | `14`                                                | Session lifetime in days                                                       |
| `OBJECT_STORAGE_ENDPOINT`          | Yes        | —                                                   | S3-compatible endpoint URL                                                     |
| `OBJECT_STORAGE_REGION`            | No         | `us-east-1`                                         | S3 region                                                                      |
| `OBJECT_STORAGE_BUCKET`            | Yes        | —                                                   | Bucket name                                                                    |
| `OBJECT_STORAGE_ACCESS_KEY_ID`     | Yes        | —                                                   | S3 access key                                                                  |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | Yes        | —                                                   | S3 secret key                                                                  |
| `METRICS_AUTH_TOKEN`               | No         | —                                                   | Bearer token required for `GET /metrics`. If unset, /metrics returns 403.      |
| `RECONSTRUCTION_CACHE_SIZE`        | No         | `100`                                               | LRU cache capacity for file reconstruction                                     |
| `SMTP_HOST`                        | No         | —                                                   | SMTP server for invitation emails                                              |
| `SMTP_PORT`                        | No         | `587`                                               | SMTP port                                                                      |
| `SMTP_USER`                        | No         | —                                                   | SMTP username                                                                  |
| `SMTP_PASS`                        | No         | —                                                   | SMTP password                                                                  |
| `SMTP_FROM`                        | No         | `provenance@example.edu`                            | From address for invitation emails                                             |
| `LOG_LEVEL`                        | No         | `info`                                              | Pino log level: `trace`, `debug`, `info`, `warn`, `error`                      |
| `PROVENANCE_ROOT_PUBLIC_KEY_HEX`   | No         | —                                                   | Hex ed25519 ROOT public key for the Manifest 2.0 trust chain. See below.       |
| `PROVENANCE_INSTITUTION_KEY`       | No         | `{}`                                                | The institution credential signing key (identity 2.1). **Secret.** See below.  |

### The Manifest 2.0 root public key

`PROVENANCE_ROOT_PUBLIC_KEY_HEX` anchors the trust chain a 2.0 bundle carries:
root → `course_cert` → `.provenance-manifest` → session. Validation check 2 uses
it to verify, entirely offline and without trusting anything the server stored,
that the course key which signed an assignment manifest was itself vouched for
by the root key.

Leaving it unset is a supported state, and is correct until a root key has been
issued:

- **1.0 / 1.1 bundles** never consult it. They carry no chain, and check 2 keeps
  doing exactly what it always did — confirming every session in the bundle
  binds to the same assignment manifest. Archived submissions are unaffected,
  permanently.
- **2.0 bundles** get check 2 = `skipped` (which makes the submission's overall
  validation `warn`), never a false `pass`.

The analyzer front end takes the same key at build time as
`VITE_ROOT_PUBLIC_KEY_HEX`, which is what lets the standalone `/local` route
verify a chain in the browser. It is a public key — baking it into the client
bundle is intended.

### The institution signing key

`PROVENANCE_INSTITUTION_KEY` holds the **only private key this server has**. It
is a single JSON object — there is one institution key per deployment, not one
per semester:

```json
{
  "private_key_hex": "<64 hex — the institution PRIVATE key>",
  "cert": {
    "format_version": "2.1",
    "institution_id": "berkeley",
    "institution_pubkey": "<64 hex>",
    "valid_from": "2026-08-20",
    "valid_until": "2027-01-15",
    "root_sig": "<128 hex>"
  }
}
```

The `cert` is the `institution_cert` signed offline by the **root** key.
Generate the institution keypair on the server, carry only its **public** half
to the offline machine that holds the root key, sign the certificate there, and
bring the certificate back. The root key never touches this host.

The `institution_id` is read off the certificate rather than configured
separately: it is inside the root-signed payload, so it cannot be set to
something the root key did not authorize.

**Treat this variable the way you treat the OAuth client secret, or more
carefully.** Whoever holds the institution private key can mint a credential
binding any public key to any `student_ref` at that institution — that is, forge
attribution — for as long as the certificate's window runs. They cannot sign an
assignment manifest (that needs the offline course key) and cannot reach another
institution (`institution_id` is inside the signed certificate and every
verifier cross-checks the credential, the travelling certificate, and the
root-verified anchor), but inside that blast radius the compromise is total.

It is deliberately **not** stored in Postgres. Database dumps travel — nightly
backups, the restore drill in §7, a copy on an operator's laptop — and the one
secret whose theft forges student identity should not ride along in them. What
the database holds is public only: the `students` rows carrying each opaque
`student_ref` and the public key currently bound to it.

**If it leaks:** sign a fresh `institution_cert` for a newly generated keypair
with the offline root key, replace this variable, and restart. Credentials
issued under the old key stay valid until they expire — they must, because
bundles already recorded under them have to keep verifying — so shorten the new
certificate's window if the exposure window matters. There is no offline
revocation: a recorder cannot learn about it without a network call, which
recorder PRD NG2 forbids. Short certificate windows are the mitigation.

Leaving it unset is a supported state: `POST /api/v1/identity/credential` then
returns `503 CREDENTIAL_UNAVAILABLE` with `reason: "no_institution_key"`, and
students simply record without an identity claim until the key is configured.
The same 503 is returned with `reason: "cert_out_of_window"` when the
certificate has lapsed — watch for it near the end of a certificate's window,
because it presents to students as "we cannot issue credentials right now"
rather than as a server error.

> **Retired:** `PROVENANCE_ENROLLMENT_KEYS` and the per-semester enrollment
> signing keys it held are gone, along with the `POST /semesters/{id}/enrollment`
> route (identity 2.0) and its `503 ENROLLMENT_UNAVAILABLE`. Remove the variable
> from your environment; it is no longer read. Identity 2.0 **verification** is
> unaffected and permanent — archived bundles carrying 2.0 tokens keep verifying
> forever, because that chain is walked from inside the bundle and never
> consults this server, which is exactly why no key is needed for it.

---

## 11. Troubleshooting

### "HOSTED_DOMAIN_MISMATCH" on login

The user's Google account domain does not match `AUTH_ALLOWED_HOSTED_DOMAINS`.
Verify the env var is set correctly and the user is using their institutional
account (not a personal Gmail).

### Worker not processing jobs

1. Confirm the worker is running: `node dist/index.js --mode=worker` (or `--mode=all`).
2. Check pg-boss queue tables: `SELECT * FROM pgboss.job WHERE state = 'failed' ORDER BY created_on DESC LIMIT 20;`
3. Check server logs for `pg-boss error` entries.
4. Verify `DATABASE_URL` is the same for both API and worker processes.

### Retention sweep not running

Check the pg-boss schedule:

```sql
SELECT * FROM pgboss.schedule WHERE name = 'retention_sweep';
```

If missing, restart the worker — `boss.schedule()` is called on startup and is
idempotent. Verify the worker started without errors after the `schedule()` calls.

### MinIO connection refused

Confirm MinIO is running and accessible from the server host:

```bash
curl -f http://<OBJECT_STORAGE_ENDPOINT>/minio/health/live
```

### Postgres migration errors

If `db:migrate` fails with "relation already exists", the migration was partially
applied. Connect to the database and check `drizzle.__drizzle_migrations`:

```sql
SELECT * FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 5;
```

For a clean dev environment, drop and recreate:

```bash
docker compose down -v && docker compose up -d
npm run db:migrate --workspace=packages/server
```

**Never do this in production.** In production, diagnose the failed migration and
apply the missing DDL manually.
