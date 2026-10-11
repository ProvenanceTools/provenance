# Analyzer v3 — Technical PRD

**Status:** Draft v0.1
**Audience:** Implementing engineers (Aaryan + Claude Code).
**Drives:** `docs/analyzer-v3-implementation-plan.md` (next deliverable, after this is approved).
**Driven by:** `docs/analyzer-v3-design.md` (architecture + locked brainstorm decisions), `docs/prd.md` (product behavior + log format), `CLAUDE.md` (repo code conventions).
**Format:** This document specifies contracts (DB schema, HTTP API, config, error codes, performance budgets, security posture) at a precision sufficient to implement against. Where this PRD and `docs/prd.md` disagree on product behavior, `docs/prd.md` wins. Where this PRD and `CLAUDE.md` disagree on code conventions, `CLAUDE.md` wins.

---

## Table of contents

1. Scope
2. Stack & dependencies
3. Configuration & environment
4. Identity, sessions, and authorization
5. Database schema
6. Object storage layout
7. HTTP API — conventions
8. HTTP API — endpoints
9. Ingest pipeline
10. Heuristics, scoring, and recompute
11. Per-submission computation
12. Background jobs
13. Audit logging
14. Frontend architecture
15. Standalone SPA (`/local`)
16. Non-functional requirements
17. Error taxonomy
18. Schema and API migrations
19. Open questions
20. Glossary

---

## 1. Scope

### 1.1 In scope (v3.0)

- Server-backed cohort analyzer reachable at the deployment's root path; cohort UI is auth-gated.
- Documented REST + JSON API at `/api/v1`, OpenAPI 3.1 spec auto-generated from route handlers.
- Google OAuth login restricted to the `berkeley.edu` Google Workspace (`hd` claim).
- Per-user API tokens for non-UI clients.
- Full ingest pipeline: bulk bundle upload, roster CSV + filename-convention matching, unmatched tray, dedup, validation, event materialization, per-file stats, heuristic scoring.
- Full v2 heuristic suite running server-side, per-semester tunable config, background recompute.
- Cross-submission heuristics per semester.
- Per-submission drill-in reusing v2 modules (`overview/`, `replay/`, `timeline/`, validation, export), data-sourced from the API.
- Standalone single-bundle SPA at `/local` (no auth, no DB), reusing the same modules in-browser as today.
- Markdown + PDF findings export, server-rendered.

### 1.2 Out of scope (v3.0)

- LLM-assisted review (PRD §7.6).
- Student-facing accounts.
- LMS / Gradescope pull integration.
- Real-time collaboration / websockets.
- User-defined heuristics (config is tunable; the heuristic _logic_ is code-only).
- Mobile UI.
- Multi-institution tenants (the `hd` allowlist is single-entry by config but no UI for multi-tenant data isolation).

---

## 2. Stack & dependencies

### 2.1 Backend

| Concern             | Choice                                                                                  | Why / notes                                                                                                                                                                                                                     |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime             | Node ≥ 22 (LTS; matches existing recorder/analyzer requirement)                         | ESM throughout. `--experimental-strip-types` not used in server build.                                                                                                                                                          |
| Language            | TypeScript 5.6+, `strict: true`, `exactOptionalPropertyTypes: true`                     | Matches CLAUDE.md.                                                                                                                                                                                                              |
| HTTP framework      | **Hono**                                                                                | ESM-first; Zod-OpenAPI plugin (`@hono/zod-openapi`) gives us request/response validation and the OpenAPI spec for free. Fastify alternative noted but rejected: heavier, OpenAPI tooling less polished for our Zod-first style. |
| Database            | **Postgres ≥ 16**                                                                       | Stable. JSONB + GIN where needed.                                                                                                                                                                                               |
| ORM / query         | **Drizzle**                                                                             | TS-native schema + migrations + queries with full inference. Migrations live in `packages/server/db/migrations/`. Prisma alternative rejected (runtime overhead, less control over migrations).                                 |
| Background jobs     | **pg-boss**                                                                             | Postgres-backed queue; no Redis dependency; ESM-friendly; durable. BullMQ alternative rejected (Redis dependency adds an op surface).                                                                                           |
| Object storage      | **S3-compatible** via `@aws-sdk/client-s3`                                              | Default proposed provider: Cloudflare R2 (no egress fees). AWS S3 fully supported; provider is config.                                                                                                                          |
| OAuth               | **`arctic`** (lightweight OAuth-only library) + **`oslo`** for token/session primitives | No Lucia (deprecated as a library), no Auth.js (heavier, not Hono-native). Direct OAuth gives us tight control over the `hd` gate.                                                                                              |
| Validation          | **Zod**                                                                                 | Already implied by Hono Zod-OpenAPI.                                                                                                                                                                                            |
| Logging             | **pino** (JSON)                                                                         | Standard for Hono.                                                                                                                                                                                                              |
| Email (invitations) | **`nodemailer`** with SMTP relay                                                        | Used only to send membership-invite notifications. Magic-link login is NOT supported (see §4).                                                                                                                                  |
| Process management  | systemd unit on the host VM                                                             | No Docker required for v3.0; can be added later.                                                                                                                                                                                |

### 2.2 Frontend

Reuses the existing `packages/analyzer` Vite + React 18 + Tailwind 3 + shadcn stack. New runtime additions:

| Library                 | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `@tanstack/react-query` | Server-state caching for API calls. Replaces ad-hoc `useEffect` fetches. |
| `@tanstack/react-table` | Cohort-list virtualized table with sorting/filtering primitives.         |
| `react-hook-form`       | Forms (roster upload, member invite, heuristic tuning, settings).        |
| `zod`                   | Shared schemas between server and client.                                |

No new shadcn primitives required beyond what v2 already scaffolds.

### 2.3 Repository layout (additions)

```
packages/
  log-core/               # existing, unchanged
  recorder/               # existing, unchanged
  analyzer/               # existing v2 SPA; refactored to source data via DataProvider
  server/                 # NEW: Node API server
    src/
      auth/               # Google OAuth flow, session cookies, token verification
      db/
        schema.ts         # Drizzle table definitions
        migrations/       # generated Drizzle migrations
        client.ts         # pool + drizzle instance
      api/
        v1/
          routes/         # one file per resource group; each exports a Hono app
          openapi.ts      # composes per-route OpenAPI metadata into the spec
          errors.ts       # the error taxonomy (§17) as a typed module
        middleware/       # auth, rate-limit, audit, error-formatter
      services/
        ingest/           # bundle parsing, matching, materialization
        heuristics/       # server-side wrappers around analyzer modules
        scoring/          # score computation + recompute
        export/           # markdown + PDF rendering
        storage/          # S3-compatible blob put/get with signed URLs
      jobs/               # pg-boss queue definitions + worker entry points
      audit/              # write-side audit helpers
      config/             # env loader + config schema (Zod)
      index.ts            # entrypoint: starts API + workers (or split into two processes per config)
    test/
    package.json
    tsconfig.json
  shared/                 # NEW: cross-package types + zod schemas
    src/
      api-schemas.ts      # request/response types used by both server and client
      events-query.ts     # re-exports event kind types from log-core for FE
```

`packages/analyzer` does not import from `packages/server`. `packages/server` imports from `packages/log-core`, `packages/analyzer/src/index/` (the reconstruction + indexing modules), `packages/analyzer/src/heuristics/`, and `packages/analyzer/src/export/`. Those analyzer subpaths are already pure TS with no DOM dependency; they will be re-verified during implementation.

### 2.4 No new approval cycle needed for v2-listed deps

`diff`, `jsdiff`, `jspdf`, and `html2canvas` already exist in v2 and remain in use. New dependencies introduced by this PRD (Hono, Drizzle, pg-boss, arctic, oslo, AWS SDK, pino, nodemailer, react-query, react-table, react-hook-form, zod-extras) are explicitly approved as a v3.0 dependency bundle in this document; later additions require the same per-PRD approval CLAUDE.md mandates.

---

## 3. Configuration & environment

### 3.1 Environment variables

All env vars are loaded once at process start via a Zod schema (`packages/server/src/config/env.ts`); missing or malformed values cause an early, loud crash.

| Variable                           | Type / format                                       | Required | Default                         | Notes                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | --------------------------------------------------- | -------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                         | `'development' \| 'production' \| 'test'`           | yes      | `'development'`                 | Used for cookie `Secure` flag, log verbosity.                                                                                                                                                                                                                                                                             |
| `PORT`                             | int                                                 | no       | `3000`                          | HTTP listen port.                                                                                                                                                                                                                                                                                                         |
| `PUBLIC_BASE_URL`                  | URL                                                 | yes      | —                               | Origin used for OAuth callbacks and CORS allowlist. Example: `https://provenance.example.edu`.                                                                                                                                                                                                                            |
| `DATABASE_URL`                     | Postgres URL                                        | yes      | —                               | Pooler-safe URL (e.g. PgBouncer transaction mode).                                                                                                                                                                                                                                                                        |
| `DATABASE_POOL_MAX`                | int                                                 | no       | `10`                            | Per-process connection cap. Must exceed `INGEST_CONCURRENCY` with headroom — each in-flight ingest job holds ~1 connection, plus pg-boss needs its own. Raise the two together for large imports.                                                                                                                         |
| `OBJECT_STORAGE_ENDPOINT`          | URL                                                 | yes      | —                               | S3 endpoint. R2 example: `https://<account>.r2.cloudflarestorage.com`.                                                                                                                                                                                                                                                    |
| `OBJECT_STORAGE_REGION`            | string                                              | yes      | `auto`                          | R2 uses `auto`; AWS uses real region.                                                                                                                                                                                                                                                                                     |
| `OBJECT_STORAGE_BUCKET`            | string                                              | yes      | —                               | Single bucket for all bundles + exports.                                                                                                                                                                                                                                                                                  |
| `OBJECT_STORAGE_ACCESS_KEY_ID`     | string                                              | yes      | —                               |                                                                                                                                                                                                                                                                                                                           |
| `OBJECT_STORAGE_SECRET_ACCESS_KEY` | string                                              | yes      | —                               |                                                                                                                                                                                                                                                                                                                           |
| `GOOGLE_OAUTH_CLIENT_ID`           | string                                              | yes      | —                               | From a course-owned Google Cloud project.                                                                                                                                                                                                                                                                                 |
| `GOOGLE_OAUTH_CLIENT_SECRET`       | string                                              | yes      | —                               |                                                                                                                                                                                                                                                                                                                           |
| `AUTH_ALLOWED_HOSTED_DOMAINS`      | JSON array of strings                               | yes      | `["berkeley.edu"]`              | The `hd` claim allowlist. Must be non-empty.                                                                                                                                                                                                                                                                              |
| `AUTH_SUPERADMIN_EMAILS`           | JSON array of strings                               | yes      | `[]`                            | Bootstrap superadmin list; matched against verified email at login. Loaded once at boot; changes require restart. Empty array is allowed only when `NODE_ENV=development`.                                                                                                                                                |
| `SESSION_COOKIE_NAME`              | string                                              | no       | `__Host-prov_sess`              | Must start with `__Host-` in production.                                                                                                                                                                                                                                                                                  |
| `SESSION_TTL_DAYS`                 | int                                                 | no       | `14`                            | Session sliding expiry.                                                                                                                                                                                                                                                                                                   |
| `SMTP_URL`                         | URL                                                 | no       | `''` (disabled)                 | If empty, invitations log to stderr instead of sending mail (dev mode).                                                                                                                                                                                                                                                   |
| `SMTP_FROM`                        | email                                               | no       | `noreply@<derived>`             |                                                                                                                                                                                                                                                                                                                           |
| `RATE_LIMIT_REDIS_URL`             | URL                                                 | no       | `''` (disabled, in-memory only) | Optional; production should set this. v3.0 ships with a Postgres-backed fallback if both Redis and in-memory are unavailable.                                                                                                                                                                                             |
| `LOG_LEVEL`                        | `'trace' \| 'debug' \| 'info' \| 'warn' \| 'error'` | no       | `'info'`                        |                                                                                                                                                                                                                                                                                                                           |
| `INGEST_MAX_BUNDLE_BYTES`          | int (bytes)                                         | no       | `52428800` (50 MB)              | Single-bundle upload cap. Matches v2 PRD §7.3 performance target.                                                                                                                                                                                                                                                         |
| `INGEST_MAX_BATCH_BYTES`           | int (bytes)                                         | no       | `5368709120` (5 GB)             | Total upload size per ingest job.                                                                                                                                                                                                                                                                                         |
| `INGEST_MAX_BATCH_FILES`           | int                                                 | no       | `10000`                         | Hard ceiling on files per job.                                                                                                                                                                                                                                                                                            |
| `RECOMPUTE_MAX_PARALLEL`           | int                                                 | no       | `4`                             | Worker concurrency.                                                                                                                                                                                                                                                                                                       |
| `INGEST_CONCURRENCY`               | int                                                 | no       | `4`                             | How many `ingest_file` jobs the worker drains concurrently (pg-boss batch size). Each holds ~1 DB pool connection, so keep it below `DATABASE_POOL_MAX`. Scales near-linearly with cores up to where Postgres write-saturates (~6–8 on one instance). See `docs/ingest-complexity.md` and `docs/admin-guide.md` §scaling. |
| `BLOB_DOWNLOAD_URL_TTL_SECONDS`    | int                                                 | no       | `300`                           | Signed-URL expiry for blob downloads.                                                                                                                                                                                                                                                                                     |

### 3.2 Process model

Two run modes, selected by command-line flag:

- `node dist/index.js --mode=api` — HTTP API + UI static asset serving. Stateless; horizontally scalable.
- `node dist/index.js --mode=worker` — pg-boss worker process. At least one required; can run multiple for ingest throughput.

A `--mode=all` exists for development, running both in-process.

---

## 4. Identity, sessions, and authorization

### 4.1 Login flow (Google OAuth)

1. Unauthenticated request to a protected route → 401 with `WWW-Authenticate: Cookie` and a JSON body `{ "error": { "code": "AUTH_REQUIRED", "login_url": "/api/v1/auth/google/start?return_to=/path" } }`. The UI shell intercepts 401 and redirects.
2. `GET /api/v1/auth/google/start?return_to=<path>` — server:
   - Generates `state` (CSRF nonce) and `code_verifier` (PKCE S256). Stores both in a short-lived cookie `__Host-prov_oauth` (HttpOnly, Secure, SameSite=Lax, 10 min TTL).
   - Constructs Google authorize URL with `client_id`, `redirect_uri=<PUBLIC_BASE_URL>/api/v1/auth/google/callback`, `scope=openid email profile`, `code_challenge`, `code_challenge_method=S256`, `state`, `hd=berkeley.edu` (hint, not security boundary).
   - Returns HTTP 302 to that URL.
3. `GET /api/v1/auth/google/callback?code=...&state=...` — server:
   - Validates `state` against the cookie; mismatch → 400 `AUTH_OAUTH_STATE_MISMATCH`.
   - Exchanges `code` for tokens via Google's token endpoint with PKCE.
   - Verifies the ID token signature against Google's JWKs.
   - Enforces **both** gates: `payload.hd === <env value of AUTH_ALLOWED_HOSTED_DOMAINS[i]>` for some `i`, and `payload.email_verified === true`. Either fails → 403 `AUTH_DOMAIN_NOT_ALLOWED`, no session issued.
   - `payload.sub` is the immutable Google subject. Look up `users.google_subject = payload.sub`:
     - Found → update `last_login_at`, `display_name`, `email` (in case of Workspace email change).
     - Not found → create `users` row with `is_superadmin = (email ∈ AUTH_SUPERADMIN_EMAILS)`. Memberships handled in step 4.
   - Activate any pending invitations matching the verified email (see §4.4).
   - Create `sessions` row, set session cookie, 302 to the `return_to` (defaulted to `/`).
4. `POST /api/v1/auth/logout` — deletes the session row, clears cookie, 204.

### 4.2 Session storage

Sessions are server-side, keyed by a 256-bit random session id (base64url-encoded, 43 chars).

```
sessions (
  id              text PRIMARY KEY,           -- base64url session id
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  ip              inet,
  user_agent      text
)
CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
```

Cookie: `__Host-prov_sess=<id>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<SESSION_TTL_SECONDS>`. The `__Host-` prefix is mandatory in production (enforced at boot).

Sliding expiry: every authenticated request bumps `last_seen_at` and may extend `expires_at` if more than half the TTL has elapsed. A background job (§12) purges expired sessions hourly.

### 4.3 API tokens

```
api_tokens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           text NOT NULL,
  prefix          text NOT NULL,                 -- first 8 chars, displayed in UI; UNIQUE
  hashed_token    text NOT NULL,                 -- argon2id of the full token
  scopes          jsonb NOT NULL DEFAULT '{}',   -- see §4.5
  last_used_at    timestamptz,
  expires_at      timestamptz,                   -- nullable = no expiry
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
)
CREATE UNIQUE INDEX api_tokens_prefix_idx ON api_tokens(prefix);
CREATE INDEX api_tokens_user_id_idx ON api_tokens(user_id);
```

Token format: `prov_<prefix>_<random>`. The full token is displayed exactly once at creation; only the prefix + argon2id hash are persisted.

`Authorization: Bearer <token>` is parsed by middleware: split on `_`, look up by prefix, verify with argon2id, check `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`, update `last_used_at`.

A token's effective permissions are the **intersection** of: (a) the owning user's current memberships and superadmin bit, and (b) the token's `scopes`. Revoking a user (membership removed, account deleted) immediately invalidates their tokens.

### 4.4 Pending invitations

```
pending_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  semester_id     uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  role            text NOT NULL,                 -- 'admin' | 'grader'
  invited_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  consumed_at     timestamptz
)
CREATE UNIQUE INDEX pending_invitations_unique_open
  ON pending_invitations(LOWER(email), semester_id) WHERE consumed_at IS NULL;
```

When a semester admin invites someone by email, a `pending_invitations` row is inserted and an email is sent (if `SMTP_URL` set). On a successful login whose verified email matches an open invitation, the server creates the corresponding `memberships` row and stamps `consumed_at`.

Open invitations can be revoked by deleting the row; once consumed, removal happens through the `memberships` API instead.

### 4.5 Roles & token scopes

Role enum (used in `memberships.role` and `pending_invitations.role`):

| Value    | Meaning                                                                                                                                                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admin`  | Course-staff admin. Can read everything in the semester, invite/remove other members, edit roster, edit assignments, edit heuristic config, trigger recompute, run exports, delete submissions, view audit log for this semester. |
| `grader` | Read everything in the semester. Run exports. Cannot edit any config or roster, cannot delete anything.                                                                                                                           |

Token scope shape (`api_tokens.scopes`):

```
{
  "read_only": boolean,                // if true, blocks ALL writes regardless of role
  "semester_ids": null | uuid[],       // null = all of user's semesters; array = restrict
  "include_blobs": boolean             // default false; if false, .../bundle endpoint is blocked
}
```

The `authorize(principal, action, target)` function is the single decision point. Pseudocode:

```
function authorize(p, action, target):
  if not p.active: return DENY('AUTH_REQUIRED')
  if p.kind === 'token' and p.scopes.read_only and action !== 'read':
    return DENY('TOKEN_READ_ONLY')
  if p.kind === 'token' and p.scopes.semester_ids is not null
       and target.semesterId not in p.scopes.semester_ids:
    return DENY('TOKEN_SCOPE_OUT_OF_BAND')
  if p.user.is_superadmin: return ALLOW
  m = membership(p.user, target.semesterId)
  if m is null: return DENY('NOT_A_MEMBER')
  if action === 'admin' and m.role !== 'admin': return DENY('INSUFFICIENT_ROLE')
  if action === 'write' and m.role !== 'admin': return DENY('INSUFFICIENT_ROLE')
  return ALLOW
```

A separate `authorizeBlob(p, submission)` check applies on `GET /api/v1/submissions/:id/bundle`: requires `action='read'` _and_ (for tokens) `scopes.include_blobs === true`. Reason: bundle download is the most-sensitive operation; default-deny on tokens forces explicit opt-in when issuing a script token.

### 4.6 CSRF

- Mutating routes (`POST`/`PUT`/`PATCH`/`DELETE`) require either an `Authorization: Bearer ...` header (tokens, immune to CSRF) or an `Origin` / `Referer` header whose origin matches `PUBLIC_BASE_URL`.
- SameSite=Lax on the session cookie handles the common case.
- `GET` requests, including cohort listing, are never gated by CSRF.

---

## 5. Database schema

Conventions:

- All primary keys are `uuid DEFAULT gen_random_uuid()` unless noted (events PK is composite; sessions PK is text).
- `created_at`, `updated_at` use `timestamptz`; `now()` default.
- Soft-delete is `archived_at timestamptz` set on the row (used for courses and semesters). Other tables hard-delete with cascade.
- `text` is preferred over `varchar(n)` (Postgres treats them identically; max length is enforced in app-level validation).
- All `jsonb` columns are non-null with a default `'{}'::jsonb` or `'[]'::jsonb` as appropriate; nullability is reserved for genuinely optional structured data.

### 5.1 Identity & structure

```
users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_subject  text NOT NULL UNIQUE,            -- Google ID token `sub` claim
  email           text NOT NULL,                   -- verified email; case-preserving but compared LOWER()
  display_name    text NOT NULL DEFAULT '',
  is_superadmin   boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_login_at   timestamptz
)
CREATE UNIQUE INDEX users_email_lower_idx ON users(LOWER(email));

courses (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text NOT NULL,                   -- "CS 61A"
  slug            text NOT NULL UNIQUE,            -- "cs61a", URL-safe
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz
)

semesters (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id           uuid NOT NULL REFERENCES courses(id) ON DELETE RESTRICT,
  term                text NOT NULL,               -- 'fa' | 'sp' | 'su' | 'wi'
  year                int  NOT NULL,               -- e.g. 2026
  slug                text NOT NULL,               -- "fa26"; unique within course
  display_name        text NOT NULL,               -- "Fall 2026"
  filename_convention text NOT NULL,               -- regex string; see §9.2
  blob_retention_days int  NOT NULL DEFAULT 540,
  derived_retention_days int NOT NULL DEFAULT 1825,
  archived_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (course_id, slug),
  CHECK (term IN ('fa','sp','su','wi')),
  CHECK (year BETWEEN 2000 AND 2100),
  CHECK (blob_retention_days >= 30),
  CHECK (derived_retention_days >= blob_retention_days)
)

memberships (
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  semester_id     uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  role            text NOT NULL,                   -- 'admin' | 'grader'
  granted_by      uuid NOT NULL REFERENCES users(id),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, semester_id),
  CHECK (role IN ('admin','grader'))
)
CREATE INDEX memberships_semester_id_idx ON memberships(semester_id);
```

### 5.2 Roster & assignments

```
roster_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id     uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  sid             text NOT NULL,                   -- student identifier, opaque
  display_name    text NOT NULL,
  email           text,                            -- nullable; not all rosters carry email
  extras          jsonb NOT NULL DEFAULT '{}',     -- extra columns from the CSV, opaque
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semester_id, sid)
)
CREATE INDEX roster_entries_semester_email_idx ON roster_entries(semester_id, LOWER(email));

assignments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id         uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  assignment_id_str   text NOT NULL,               -- "hw03", taken from the .provenance-manifest manifest
  label               text NOT NULL DEFAULT '',    -- staff-friendly, settable later
  sort_order          int  NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semester_id, assignment_id_str)
)
```

### 5.3 Ingest

```
ingest_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id         uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  uploaded_by         uuid NOT NULL REFERENCES users(id),
  status              text NOT NULL,               -- enum, see below
  summary             jsonb NOT NULL DEFAULT '{}', -- counts by terminal status
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  CHECK (status IN ('queued','running','succeeded','partial','failed','cancelled'))
)
CREATE INDEX ingest_jobs_semester_id_idx ON ingest_jobs(semester_id, created_at DESC);

ingest_files (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ingest_job_id           uuid NOT NULL REFERENCES ingest_jobs(id) ON DELETE CASCADE,
  original_filename       text NOT NULL,
  size_bytes              bigint NOT NULL,
  blob_sha256             text NOT NULL,           -- hex, 64 chars
  status                  text NOT NULL,           -- enum, see below
  matched_student_id      uuid REFERENCES roster_entries(id) ON DELETE SET NULL,
  matched_assignment_id   uuid REFERENCES assignments(id) ON DELETE SET NULL,
  submission_id           uuid REFERENCES submissions(id) ON DELETE SET NULL,
  filename_capture        jsonb,                   -- {sid: "...", assignment_id: "..."} or null
  error                   jsonb,                   -- structured error if status='failed'
  created_at              timestamptz NOT NULL DEFAULT now(),
  resolved_at             timestamptz,
  resolved_by             uuid REFERENCES users(id),
  CHECK (status IN ('pending','matched','unmatched','duplicate','failed','superseded','discarded'))
)
CREATE INDEX ingest_files_job_idx ON ingest_files(ingest_job_id);
CREATE INDEX ingest_files_blob_sha256_idx ON ingest_files(blob_sha256);
CREATE INDEX ingest_files_unmatched_idx ON ingest_files(ingest_job_id) WHERE status='unmatched';
```

Status transitions are documented in §9.

### 5.4 Submissions, events, derived

```
submissions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id                 uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  assignment_id               uuid NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  student_id                  uuid NOT NULL REFERENCES roster_entries(id) ON DELETE RESTRICT,
  blob_object_key             text NOT NULL,                 -- s3 key
  blob_sha256                 text NOT NULL,                 -- hex
  recorder_version            text NOT NULL DEFAULT '',
  format_version              text NOT NULL DEFAULT '',
  source_filename             text NOT NULL,
  ingest_job_id               uuid NOT NULL REFERENCES ingest_jobs(id) ON DELETE RESTRICT,
  ingested_at                 timestamptz NOT NULL DEFAULT now(),
  version_index               int NOT NULL,                  -- 1, 2, 3, ... within (semester, assignment, student)
  superseded_by_submission_id uuid REFERENCES submissions(id) ON DELETE SET NULL,
  score_total                 double precision NOT NULL DEFAULT 0,
  score_max_severity          text NOT NULL DEFAULT 'info',  -- 'info'|'low'|'medium'|'high'
  validation_status           text NOT NULL DEFAULT 'pending', -- 'pending'|'pass'|'warn'|'fail'
  heuristic_config_version    int NOT NULL DEFAULT 0,
  recompute_status            text NOT NULL DEFAULT 'fresh', -- 'fresh'|'stale'|'recomputing'|'error'
  created_at                  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semester_id, assignment_id, student_id, version_index)
)
CREATE INDEX submissions_cohort_idx
  ON submissions (semester_id, assignment_id, score_total DESC)
  WHERE superseded_by_submission_id IS NULL;
CREATE INDEX submissions_student_idx
  ON submissions (semester_id, student_id);
CREATE INDEX submissions_blob_sha_idx
  ON submissions (semester_id, blob_sha256);
```

Events:

```
events (
  submission_id   uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  seq             int  NOT NULL,                   -- monotonic within submission (across sessions too)
  session_id      text NOT NULL,                   -- session uuid from the bundle
  t               int  NOT NULL,                   -- ms since session start
  wall            timestamptz NOT NULL,
  kind            text NOT NULL,                   -- event kind from EventKindMap
  payload         jsonb NOT NULL,
  prev_hash       text NOT NULL,
  hash            text NOT NULL,
  PRIMARY KEY (submission_id, seq)
)
CREATE INDEX events_sub_kind_t_idx ON events (submission_id, kind, t);
CREATE INDEX events_sub_t_idx     ON events (submission_id, t);
CREATE INDEX events_sub_session_seq_idx ON events (submission_id, session_id, seq);
```

Per-file stats:

```
per_file_stats (
  submission_id               uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  file_path                   text NOT NULL,
  chars_typed                 int NOT NULL DEFAULT 0,
  chars_pasted                int NOT NULL DEFAULT 0,
  chars_external_change_delta int NOT NULL DEFAULT 0,
  saves                       int NOT NULL DEFAULT 0,
  final_length                int NOT NULL DEFAULT 0,
  start_length                int NOT NULL DEFAULT 0,
  reconstruction_tainted      boolean NOT NULL DEFAULT false,
  PRIMARY KEY (submission_id, file_path)
)
```

Flags:

```
flags (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id               uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  semester_id                 uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  heuristic_id                text NOT NULL,
  severity                    text NOT NULL,                 -- 'info'|'low'|'medium'|'high'
  confidence                  double precision NOT NULL,     -- [0, 1]
  weight_at_compute           double precision NOT NULL,
  score_contribution          double precision NOT NULL,
  detail                      jsonb NOT NULL DEFAULT '{}',
  supporting_seqs             int[] NOT NULL DEFAULT '{}',
  session_id                  text NOT NULL DEFAULT '',
  heuristic_config_version    int NOT NULL,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  CHECK (severity IN ('info','low','medium','high')),
  CHECK (confidence BETWEEN 0 AND 1)
)
CREATE INDEX flags_sub_idx       ON flags (submission_id);
CREATE INDEX flags_sem_heur_idx  ON flags (semester_id, heuristic_id);
CREATE INDEX flags_sem_sev_idx   ON flags (semester_id, severity);
```

Validation:

```
validation_results (
  submission_id   uuid PRIMARY KEY REFERENCES submissions(id) ON DELETE CASCADE,
  check_1_status  text NOT NULL,            -- 'pass'|'fail'|'warn'|'skipped'
  check_2_status  text NOT NULL,
  check_3_status  text NOT NULL,
  check_4_status  text NOT NULL,
  check_5_status  text NOT NULL,
  check_6_status  text NOT NULL,
  check_7_status  text NOT NULL,
  check_8_status  text NOT NULL,
  overall         text NOT NULL,            -- 'pass'|'warn'|'fail'
  detail          jsonb NOT NULL DEFAULT '{}',
  validated_at    timestamptz NOT NULL DEFAULT now()
)
```

Cross-flags:

```
cross_flags (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id              uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  heuristic_id             text NOT NULL,
  severity                 text NOT NULL,
  confidence               double precision NOT NULL,
  detail                   jsonb NOT NULL DEFAULT '{}',
  heuristic_config_version int NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now()
)

cross_flag_participants (
  cross_flag_id    uuid NOT NULL REFERENCES cross_flags(id) ON DELETE CASCADE,
  submission_id    uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  supporting_seqs  int[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (cross_flag_id, submission_id)
)
CREATE INDEX cfp_submission_idx ON cross_flag_participants(submission_id);
CREATE INDEX cross_flags_sem_h_idx ON cross_flags(semester_id, heuristic_id);
```

### 5.5 Heuristic config & recompute

```
heuristic_configs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id     uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  version         int NOT NULL,                    -- monotonic per semester
  config          jsonb NOT NULL,                  -- see §10.2
  set_by          uuid NOT NULL REFERENCES users(id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  note            text NOT NULL DEFAULT '',
  is_active       boolean NOT NULL DEFAULT false,
  UNIQUE (semester_id, version)
)
CREATE UNIQUE INDEX heuristic_configs_active_idx
  ON heuristic_configs(semester_id) WHERE is_active;

recompute_jobs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id         uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  target_config_id    uuid NOT NULL REFERENCES heuristic_configs(id),
  triggered_by        uuid NOT NULL REFERENCES users(id),
  status              text NOT NULL,               -- 'queued'|'running'|'succeeded'|'partial'|'failed'|'cancelled'
  progress_total      int NOT NULL DEFAULT 0,
  progress_done       int NOT NULL DEFAULT 0,
  progress_failed     int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  summary             jsonb NOT NULL DEFAULT '{}'
)
CREATE INDEX recompute_jobs_sem_idx ON recompute_jobs(semester_id, created_at DESC);
```

### 5.6 Exports

```
export_artifacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  format          text NOT NULL,                   -- 'markdown' | 'pdf'
  object_key      text NOT NULL,                   -- s3 key under exports/
  size_bytes      bigint NOT NULL,
  generated_by    uuid NOT NULL REFERENCES users(id),
  generated_at    timestamptz NOT NULL DEFAULT now(),
  input_bundle_sha256 text NOT NULL,               -- snapshot for tamper-evidence
  config_version  int NOT NULL,
  expires_at      timestamptz NOT NULL             -- 7 days from generation; auto-deleted by job
)
CREATE INDEX export_artifacts_sub_idx ON export_artifacts(submission_id, generated_at DESC);
CREATE INDEX export_artifacts_expires_idx ON export_artifacts(expires_at);
```

### 5.7 Audit

```
audit_log (
  id              bigserial PRIMARY KEY,
  actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_token_id  uuid REFERENCES api_tokens(id) ON DELETE SET NULL,
  semester_id     uuid REFERENCES semesters(id) ON DELETE SET NULL,
  action          text NOT NULL,                   -- see §13 catalog
  target_type     text NOT NULL,
  target_id       text NOT NULL,
  detail          jsonb NOT NULL DEFAULT '{}',
  ip              inet,
  user_agent      text,
  at              timestamptz NOT NULL DEFAULT now()
)
CREATE INDEX audit_log_semester_at_idx ON audit_log(semester_id, at DESC);
CREATE INDEX audit_log_actor_at_idx    ON audit_log(actor_user_id, at DESC);
CREATE INDEX audit_log_action_at_idx   ON audit_log(action, at DESC);
```

---

## 6. Object storage layout

Single bucket. Prefix structure:

```
semesters/{semesterId}/submissions/{submissionId}/bundle.zip
exports/{exportArtifactId}.{md|pdf}
ingest-staging/{ingestJobId}/{ingestFileId}  -- transient; deleted after job terminal status
```

- Bundles are immutable. Re-uploads with the same hash are deduped at the application layer; the blob is uploaded once.
- Exports expire after 7 days; a daily background job lists and deletes objects whose corresponding `export_artifacts.expires_at` is in the past, then deletes the row.
- Staging objects are deleted by the ingest worker on terminal job status.
- Lifecycle policy on the bucket: nothing automatic. All deletion is application-driven so audit can capture the "who deleted what" record.
- All uploads use SSE (provider-managed keys); v3.0 does not implement client-side encryption.

---

## 7. HTTP API — conventions

### 7.1 Versioning

- Single version `/api/v1`. Breaking changes move to `/api/v2` with a deprecation header on `/v1` routes for at least 90 days before removal.
- `OPTIONS` requests return CORS headers. Allowed origins: exactly `PUBLIC_BASE_URL`. Wildcard origins are never enabled.

### 7.2 Content types

- All request bodies are JSON unless the route is multipart (ingest, roster upload).
- All responses are JSON with `Content-Type: application/json; charset=utf-8` unless the route returns a redirect or a signed URL.
- Numbers are JSON numbers (double precision is fine for scores; `bigint` IDs are not exposed — UUIDs are used). Where an integer is required (event seq, t, sizes), the schema specifies `integer`.

### 7.3 Errors

All error responses have the same shape:

```
{
  "error": {
    "code": "MACHINE_READABLE_CODE",
    "message": "human-readable summary",
    "details": { /* optional, error-specific structured data */ }
  }
}
```

HTTP status codes used:

| Status | Meaning                                                                             |
| ------ | ----------------------------------------------------------------------------------- |
| 400    | Validation error or malformed request.                                              |
| 401    | Not authenticated.                                                                  |
| 403    | Authenticated but not authorized.                                                   |
| 404    | Resource not found _or_ not visible to the principal (we don't leak existence).     |
| 409    | Conflict (idempotency, version mismatch, optimistic lock).                          |
| 413    | Payload too large.                                                                  |
| 415    | Unsupported media type.                                                             |
| 422    | Semantic validation failure (request was well-formed but referenced invalid state). |
| 429    | Rate-limited.                                                                       |
| 500    | Internal error; carries a request id but never a stack trace.                       |
| 503    | Dependency unavailable (DB, object store, queue).                                   |

The full error code catalog is §17.

### 7.4 Pagination

Cursor-based pagination on all list endpoints:

- Query params: `limit` (default 50, max 500), `cursor` (opaque base64 string).
- Response includes `next_cursor` (string or null) and `total_count` (only when cheap to compute — set explicitly per endpoint).

### 7.5 Idempotency

- Ingest is idempotent on `(semester_id, blob_sha256)`.
- All other write endpoints support an `Idempotency-Key: <client-uuid>` header which, when present, caches the response for 24 hours so a retry produces the same response (including the same status code). Not required; recommended for token clients.

### 7.6 Rate limiting

Token-bucket per (principal, route class). Defaults:

| Route class                                          | Bucket size | Refill rate |
| ---------------------------------------------------- | ----------- | ----------- |
| `auth` (login/callback/logout)                       | 30          | 30 / 5 min  |
| `read.cohort` (cohort lists)                         | 600         | 600 / min   |
| `read.detail` (per-submission and event endpoints)   | 1200        | 1200 / min  |
| `write.config` (heuristic config, semester settings) | 60          | 60 / min    |
| `write.ingest` (ingest start, unmatched edit)        | 30          | 30 / 5 min  |
| `write.misc`                                         | 120         | 120 / min   |
| `blob.download`                                      | 30          | 30 / min    |

Exceeded → 429 with `Retry-After` and `X-RateLimit-Reset` headers.

### 7.7 Headers used on every response

- `X-Request-Id` (UUID, also written to logs and audit entries).
- `X-RateLimit-Remaining`, `X-RateLimit-Reset` (where applicable).
- `Cache-Control: no-store` on all authenticated responses by default. Specific resource endpoints (e.g. immutable event-by-seq) may opt into `max-age=86400, private, immutable`.

### 7.8 Common scalar types

```ts
type UUID = string; // canonical lower-hex with dashes
type ISODate = string; // RFC 3339, e.g. "2026-09-15T18:42:11.034Z"
type Severity = 'info' | 'low' | 'medium' | 'high';
type ValidationStatus = 'pending' | 'pass' | 'warn' | 'fail';
type Role = 'admin' | 'grader';
```

---

## 8. HTTP API — endpoints

For brevity, each endpoint is specified as `METHOD path` + auth requirement + request shape + response shape + error codes + rate class. Shapes use TypeScript-ish notation. Optional fields end with `?`. Arrays use `T[]`. Maps use `Record<K, V>`.

### 8.1 Auth

**`POST /api/v1/auth/google/start`**

- Auth: none.
- Query: `return_to?: string` — defaults to `/`. Must be a same-origin path.
- Response: 302 to Google authorize URL, sets `__Host-prov_oauth` cookie.
- Errors: `BAD_REQUEST_RETURN_TO_INVALID`.
- Rate: `auth`.

**`GET /api/v1/auth/google/callback`**

- Auth: none.
- Query: `code: string`, `state: string`.
- Response: 302 to `return_to` from the oauth cookie; sets session cookie.
- Errors: `AUTH_OAUTH_STATE_MISMATCH`, `AUTH_OAUTH_CODE_EXCHANGE_FAILED`, `AUTH_DOMAIN_NOT_ALLOWED`, `AUTH_EMAIL_NOT_VERIFIED`.
- Rate: `auth`.

**`POST /api/v1/auth/logout`**

- Auth: session.
- Response: 204.
- Rate: `auth`.

**`GET /api/v1/me`**

- Auth: session or token.
- Response:

```ts
{
  user: {
    id: UUID, email: string, display_name: string,
    is_superadmin: boolean, created_at: ISODate, last_login_at: ISODate | null
  },
  memberships: {
    semester_id: UUID, semester_slug: string, course_slug: string,
    role: Role, granted_at: ISODate
  }[],
  principal_kind: 'session' | 'token',
  token?: { id: UUID, label: string, scopes: { read_only: boolean, semester_ids: UUID[] | null, include_blobs: boolean } }
}
```

- Rate: `read.detail`.

### 8.2 Courses & semesters

**`GET /api/v1/courses`**

- Auth: any authenticated principal. Returns courses the principal can see (superadmin: all; others: courses containing at least one semester they're a member of).
- Response: `{ courses: { id: UUID, name: string, slug: string, archived: boolean, semesters_count: int }[] }`.
- Rate: `read.cohort`.

**`POST /api/v1/courses`** _(superadmin only)_

- Body: `{ name: string, slug: string }`.
- Response: 201, full course object.
- Errors: `VALIDATION`, `COURSE_SLUG_TAKEN`.
- Rate: `write.misc`.

**`GET /api/v1/courses/{courseId}`**

- Response: `{ id, name, slug, archived, created_at }`.

**`PATCH /api/v1/courses/{courseId}`** _(superadmin only)_

- Body: `{ name?: string }`.

**`POST /api/v1/courses/{courseId}/archive`** _(superadmin only)_

- Response: 204; flips `archived_at`. Cascades: every not-yet-archived semester in the course is also archived (its `archived_at` is set, starting its blob-retention clock). Already-archived semesters keep their original `archived_at`. Archived data remains readable but read-only. Forward-only; no unarchive (revert via PITR).

**`GET /api/v1/courses/{courseId}/semesters`**

- Response: `{ semesters: SemesterSummary[] }`.
- `SemesterSummary`:

```ts
{
  id: UUID, course_id: UUID, slug: string, term: 'fa'|'sp'|'su'|'wi', year: int,
  display_name: string, archived: boolean,
  submission_count: int, student_count: int, assignment_count: int,
  active_config_version: int, my_role: Role | null
}
```

**`POST /api/v1/courses/{courseId}/semesters`** _(superadmin only)_

- Body: `{ term, year, slug, display_name, filename_convention, blob_retention_days?, derived_retention_days? }`.
- Errors: `VALIDATION_REGEX` (filename_convention fails to compile), `SEMESTER_SLUG_TAKEN`.

**`GET /api/v1/semesters/{semesterId}`**

- Response: SemesterSummary + `filename_convention: string`, `blob_retention_days: int`, `derived_retention_days: int`.

**`PATCH /api/v1/semesters/{semesterId}`** _(semester admin)_

- Body: `{ display_name?, filename_convention?, blob_retention_days?, derived_retention_days? }`.
- Changing `filename_convention` does not retroactively re-match prior ingest_files; admin can re-run match from the unmatched tray.

**`POST /api/v1/semesters/{semesterId}/archive`** _(superadmin only)_

### 8.3 Members

**`GET /api/v1/semesters/{semesterId}/members`**

- Auth: semester member.
- Response:

```ts
{
  members: { user_id: UUID, email: string, display_name: string, role: Role, granted_at: ISODate, granted_by_email: string }[],
  pending: { id: UUID, email: string, role: Role, invited_at: ISODate, invited_by_email: string }[]
}
```

**`POST /api/v1/semesters/{semesterId}/members`** _(semester admin)_

- Body: `{ email: string, role: Role }`.
- Behavior: if a user with that verified email already exists, creates the membership directly. Otherwise inserts a `pending_invitations` row and sends an email.
- Errors: `MEMBER_ALREADY`, `INVITATION_ALREADY_OPEN`, `EMAIL_DOMAIN_NOT_ALLOWED` (warn-level — invitations to non-allowed domains succeed since the user might be added to the allowlist later, but the response carries a `warning` field).

**`PATCH /api/v1/semesters/{semesterId}/members/{userId}`** _(semester admin)_

- Body: `{ role: Role }`.
- Errors: `CANNOT_DEMOTE_SELF`, `LAST_ADMIN_REQUIRED`.

**`DELETE /api/v1/semesters/{semesterId}/members/{userId}`** _(semester admin)_

- Errors: `LAST_ADMIN_REQUIRED`.

**`DELETE /api/v1/semesters/{semesterId}/invitations/{invitationId}`** _(semester admin)_

### 8.4 Roster

**`GET /api/v1/semesters/{semesterId}/roster`**

- Auth: semester member.
- Query: `cursor?`, `limit?`, `q?` (free text on display_name or email).
- Response: `{ entries: RosterEntry[], next_cursor: string | null, total_count: int }`.
- `RosterEntry`: `{ id, sid, display_name, email: string | null, extras: jsonb }`.

**`POST /api/v1/semesters/{semesterId}/roster:upload`** _(semester admin)_

- Multipart, single field `file` (CSV).
- Required columns: `sid`, `display_name`. Optional: `email`. Additional columns stored as `extras` (object with one key per extra column).
- Response: a _diff preview_ without committing:

```ts
{
  upload_id: UUID,           // server-cached preview; expires in 30 min
  parsed_rows: int,
  to_add: int,
  to_update: int,            // existing sid, different other fields
  to_delete: int,            // existing sid not in CSV
  errors: { row: int, message: string }[]
}
```

- Errors: `ROSTER_CSV_MISSING_REQUIRED_COLUMN`, `ROSTER_CSV_TOO_LARGE`, `ROSTER_CSV_PARSE`.

**`POST /api/v1/semesters/{semesterId}/roster:commit`** _(semester admin)_

- Body: `{ upload_id: UUID, accept_deletions: boolean }`.
- Commits the diff to `roster_entries`. If `accept_deletions=false`, missing rows are kept (additive-only). `accept_deletions=true` deletes rows not present in the CSV; this is the destructive option that must be intentional.
- Response: 200 with applied counts.

**`PATCH /api/v1/semesters/{semesterId}/roster/{rosterEntryId}`** _(semester admin)_

- Body: `{ display_name?, email?, extras? }`. `sid` is immutable.

### 8.5 Assignments

**`GET /api/v1/semesters/{semesterId}/assignments`**

- Auth: semester member.
- Response: `{ assignments: AssignmentSummary[] }`.
- `AssignmentSummary`:

```ts
{
  id, semester_id, assignment_id_str, label, sort_order,
  submission_count: int, distinct_students: int,
  mean_score: number, median_score: number, p95_score: number,
  fail_count: int, warn_count: int
}
```

**`PATCH /api/v1/semesters/{semesterId}/assignments/{assignmentId}`** _(semester admin)_

- Body: `{ label?: string, sort_order?: int }`.

### 8.6 Ingest

**`POST /api/v1/semesters/{semesterId}/ingest`** _(semester admin)_

- Multipart. Either:
  - `files[]` — multiple `.zip` bundles, OR
  - `archive` — a single `.zip` containing many bundles.
- Headers: `Content-Length` enforced against `INGEST_MAX_BATCH_BYTES`.
- Response: 202 with `{ job_id: UUID }`. Job is enqueued and processed asynchronously.
- Errors: `INGEST_BATCH_TOO_LARGE`, `INGEST_FILE_TOO_LARGE`, `INGEST_TOO_MANY_FILES`, `ROSTER_REQUIRED` (semester has no roster yet).
- Rate: `write.ingest`.

**`POST /api/v1/semesters/{semesterId}/ingest:gradescope`** _(semester admin)_ — **primary upload path**

- Multipart, single field `archive` — the ZIP produced by Gradescope's "Download
  Submissions". This is a single archive containing a `submission_metadata.yml`
  and one **folder per submission** (`submission_<id>/`), because Gradescope
  unzips each student's bundle on upload. Folders may nest provenance files under
  `.provenance/` or hold them flat; both are accepted.
- Unlike `POST /ingest`, this does **not** require a pre-existing roster. The
  server **upserts** `roster_entries` from the metadata's submitters (add/update
  by `sid`, never delete), then rebuilds a sealed bundle ZIP from each submission
  folder and stages **one file per submitter** with a `match_sid` hint. The
  worker matches by that hint (not the filename convention) and dedups per
  `(semester, student, blob)`, so each co-submitter of a group project gets their
  own submission from the shared bundle.
- Headers: `Content-Length` enforced against `INGEST_MAX_BATCH_BYTES`.
- Response:
  - `202` with `{ job_id, roster: { added, updated }, bundles_processed, submissions_queued, skipped: [{ folder_key, reason }] }` when an ingest job was enqueued.
  - `200` with the same shape and `job_id: null` when the export had no
    processable bundles (the roster was still upserted). `skipped[].reason` is
    `no_manifest` (folder has no provenance bundle) or `no_submitters`.
- Errors: `VALIDATION` (not a ZIP / missing `submission_metadata.yml` / unparseable metadata), `INGEST_BATCH_TOO_LARGE`, `INGEST_FILE_TOO_LARGE`, `INGEST_TOO_MANY_FILES`.
- Rate: `write.ingest`.

**`GET /api/v1/semesters/{semesterId}/ingest/jobs`**

- Query: `status?`, `cursor?`, `limit?`.
- Response: paginated `IngestJobSummary[]`.

**`GET /api/v1/semesters/{semesterId}/ingest/jobs/{jobId}`**

- Response:

```ts
{
  id, semester_id, status: 'queued'|'running'|'succeeded'|'partial'|'failed'|'cancelled',
  created_at, started_at?, completed_at?,
  summary: {
    total: int, matched: int, unmatched: int, duplicate: int, failed: int, superseded: int, discarded: int
  },
  files: IngestFileSummary[]   // first 200; use /files for pagination
}
```

**`GET /api/v1/semesters/{semesterId}/ingest/jobs/{jobId}/files`**

- Paginated `IngestFileSummary[]`.
- `IngestFileSummary`:

```ts
{
  id, original_filename, size_bytes, blob_sha256, status,
  matched_student?: { id, sid, display_name },
  matched_assignment?: { id, assignment_id_str, label },
  submission_id?: UUID,
  filename_capture?: { sid?: string, assignment_id?: string },
  error?: { code: string, message: string, details?: jsonb }
}
```

**`POST /api/v1/semesters/{semesterId}/ingest/jobs/{jobId}/cancel`** _(semester admin)_

- Cancels remaining work; files already processed are kept. 202.

### 8.7 Unmatched tray

**`GET /api/v1/semesters/{semesterId}/unmatched`**

- Auth: semester member.
- Query: `cursor?`, `limit?`.
- Response: `{ items: IngestFileSummary[], next_cursor }`.

**`PATCH /api/v1/semesters/{semesterId}/unmatched/{ingestFileId}`** _(semester admin)_

- Body: `{ student_id: UUID, assignment_id_str: string }`.
- Server creates the submission as if the original ingest match had succeeded (validation + heuristics + scoring). Returns 200 with the new `IngestFileSummary`.
- Errors: `INGEST_FILE_NOT_UNMATCHED`, `ROSTER_ENTRY_NOT_FOUND`, `ASSIGNMENT_ID_MISMATCH_BUNDLE` (warn — bundle's signed manifest disagrees; UI must confirm).

**`POST /api/v1/semesters/{semesterId}/unmatched/{ingestFileId}/discard`** _(semester admin)_

- Body: `{ reason?: string }`. Marks `status='discarded'`; blob remains until retention sweep.

### 8.8 Cohort

**`GET /api/v1/semesters/{semesterId}/submissions`** — _the workhorse_

- Auth: semester member.
- Query:

```
assignment_id?: UUID
student_id?: UUID
flag_id?: string                   // heuristic id; multi via repeated key
severity_min?: 'info'|'low'|'medium'|'high'
validation_status?: 'pass'|'warn'|'fail'
score_min?: number
score_max?: number
has_external_edits?: boolean
has_large_paste?: boolean
recorder_version?: string
include_superseded?: boolean       // default false
q?: string                         // free-text on student display_name or sid
sort?: 'score_desc'|'score_asc'|'ingested_desc'|'student_asc'|'student_desc'|'assignment_asc'
cursor?: string
limit?: int                        // default 50, max 500
```

- Response:

```ts
{
  items: SubmissionRow[],
  next_cursor: string | null,
  total_count: int,
  facets: {
    by_severity: { info: int, low: int, medium: int, high: int },
    by_validation: { pass: int, warn: int, fail: int },
    by_assignment: { id: UUID, label: string, count: int }[]
  }
}
```

- `SubmissionRow`:

```ts
{
  id: UUID,
  semester_id: UUID,
  assignment: { id: UUID, assignment_id_str: string, label: string },
  student:    { id: UUID, sid: string, display_name: string },
  score_total: number,
  score_max_severity: Severity,
  flag_counts: { info: int, low: int, medium: int, high: int },
  top_flags: { heuristic_id: string, severity: Severity }[],
  validation_status: ValidationStatus,
  ingested_at: ISODate,
  recorder_version: string,
  superseded: boolean,
  recompute_status: 'fresh'|'stale'|'recomputing'|'error'
}
```

- Rate: `read.cohort`.

**`GET /api/v1/semesters/{semesterId}/students`**

- Auth: semester member.
- Query: same filter set where it makes sense + `sort ∈ {'score_sum_desc','score_max_desc','student_asc'}`.
- Response: items shaped as:

```ts
{
  student: { id, sid, display_name, email? },
  submission_count: int,
  score_sum: number, score_max: number,
  flag_counts: { info, low, medium, high },
  worst_submission: SubmissionRow,
  recompute_status: 'fresh'|'stale'|'recomputing'|'error'
}
```

### 8.9 Per-submission

**`GET /api/v1/submissions/{submissionId}`**

- Auth: read on submission's semester.
- Response:

```ts
{
  id, semester_id, assignment, student,
  ingested_at, source_filename, blob_sha256,
  recorder_version, format_version,
  validation_status, validation_overall_detail: string | null,
  score_total, score_max_severity,
  flag_counts: { info, low, medium, high },
  session_ids: string[],
  files: { path: string, final_length: int, saves: int }[],
  superseded: boolean,
  superseded_by_submission_id: UUID | null,
  heuristic_config_version: int,
  recompute_status
}
```

**`GET /api/v1/submissions/{submissionId}/events`** — _the process-log query endpoint_

- Auth: read.
- Query:

```
kind?: string                   // repeated key for multi
seq_from?: int
seq_to?: int
t_from?: int
t_to?: int
wall_from?: ISODate
wall_to?: ISODate
file?: string                   // matches payload.path == file
session_id?: string
order?: 'seq_asc'|'seq_desc'    // default seq_asc
cursor?: string
limit?: int                     // default 200, max 2000
```

- Response: `{ items: EventRow[], next_cursor: string | null, total_count?: int }`.
- `EventRow`:

```ts
{
  submission_id: UUID,
  seq: int,
  session_id: string,
  t: int,
  wall: ISODate,
  kind: string,
  payload: jsonb,
  prev_hash: string,
  hash: string
}
```

- `total_count` is included only if the query has at least one of `kind` / `file` / `session_id` (cheap with indexes). Otherwise the response omits it.
- Errors: `EVENT_QUERY_LIMIT_EXCEEDED` (limit > 2000), `EVENT_QUERY_RANGE_INVALID`.
- Rate: `read.detail`.

**`GET /api/v1/submissions/{submissionId}/events/{seq}`**

- Auth: read.
- Response: a single `EventRow` or 404.

**`GET /api/v1/submissions/{submissionId}/flags`**

- Response: `{ flags: FlagRow[] }`.
- `FlagRow`:

```ts
{
  id, heuristic_id, severity, confidence, weight_at_compute, score_contribution,
  detail: jsonb, supporting_seqs: int[], session_id, created_at, heuristic_config_version
}
```

**`GET /api/v1/submissions/{submissionId}/stats`**

- Response:

```ts
{
  per_file: { path, chars_typed, chars_pasted, chars_external_change_delta, saves, final_length, start_length, reconstruction_tainted }[],
  aggregate: { chars_typed: int, chars_pasted: int, chars_external_change_delta: int, saves: int, files: int }
}
```

**`GET /api/v1/submissions/{submissionId}/validation`**

- Response:

```ts
{
  overall: 'pass' | 'warn' | 'fail',
  checks: {
    id: 'manifest_sig' | 'session_binding' | 'chain_integrity' | 'seq_gaps'
       | 'monotonic_t' | 'monotonic_wall' | 'doc_save_hashes' | 'submitted_code_match',
    status: 'pass' | 'fail' | 'warn' | 'skipped',
    detail?: string,
  }[], // always 8 entries in PRD §5.4 spec order
  validated_at: string, // ISO-8601
}
```

- `checks` is sourced from the `validation_results.detail` jsonb column, which stores the full `ValidationCheck[]` produced by `runValidation` at ingest. The flat `check_N_status` columns on the row are a storage artifact used by cohort-list filtering and are not exposed by this endpoint.

**`GET /api/v1/submissions/{submissionId}/files`**

- Response: `{ files: { path, final_length, saves }[] }`.

**`GET /api/v1/submissions/{submissionId}/files/{path}/content`**

- Query: `at_seq?: int` (default = the last save's seq for that file; `0` means starting content).
- Response: `{ submission_id, path, at_seq, content: string, computed_at_ms: int }`.
- Caching: `Cache-Control: max-age=60, private`. The cache key includes `at_seq`.
- Errors: `FILE_NOT_FOUND`, `FILE_RECONSTRUCTION_TAINTED` (returns 200 with `content: ""` and a `warning` field; clients can choose to show a placeholder).

**`GET /api/v1/submissions/{submissionId}/files/{path}/provenance`**

- Query: `at_seq?`.
- Response:

```ts
{
  submission_id, path, at_seq,
  length: int,
  provenance: { offset: int, length: int, kind: 'typed'|'paste'|'external_change'|'preexisting', event_seq: int }[],
  // Run-length encoded for transport efficiency.
}
```

**`GET /api/v1/submissions/{submissionId}/bundle`**

- Auth: read + (for tokens) `scopes.include_blobs=true`.
- Response: 302 to a short-lived signed object-storage URL. Logged in audit (`bundle.download`).
- Rate: `blob.download`.

**`POST /api/v1/submissions/{submissionId}/export`**

- Auth: read.
- Body: `{ format: 'markdown' | 'pdf' }`.
- Response (synchronous for markdown, async for pdf if estimated render > 5s):

```ts
// sync:
{ artifact_id: UUID, format, expires_at: ISODate, download_url: string }
// async:
{ job_id: UUID, status: 'queued' }
```

- Errors: `EXPORT_FORMAT_UNSUPPORTED`, `EXPORT_RENDER_FAILED`.
- Rate: `write.misc`.

### 8.10 Cross-submission

**`GET /api/v1/semesters/{semesterId}/cross-flags`**

- Auth: semester member.
- Query: `heuristic_id?`, `severity_min?`, `submission_id?` (filter to flags involving a specific submission), `cursor?`, `limit?`.
- Response: `{ items: CrossFlagSummary[], next_cursor }`.
- `CrossFlagSummary`:

```ts
{
  id, heuristic_id, severity, confidence,
  participants: { submission_id, student: { id, sid, display_name }, assignment: { id, assignment_id_str }, supporting_seqs: int[] }[],
  detail: jsonb,
  created_at
}
```

**`GET /api/v1/cross-flags/{crossFlagId}`** — detail (same shape with full participants).

### 8.11 Heuristic config & recompute

**`GET /api/v1/semesters/{semesterId}/heuristic-config`**

- Auth: semester member.
- Response: the active `heuristic_configs` row with `version` and `config` (see §10.2).

**`GET /api/v1/semesters/{semesterId}/heuristic-configs`** — version history.

**`PUT /api/v1/semesters/{semesterId}/heuristic-config`** _(semester admin)_

- Query: `dryRun?: boolean` (default false).
- Body: the full config object (full-document update; deltas computed server-side).
- Response (dryRun):

```ts
{
  candidate_version: int,
  diff: {
    submissions_with_tier_change: int,
    top_movers: { submission_id, student: {...}, assignment: {...}, old_score, new_score, old_tier, new_tier }[],
    score_histogram_old: number[],   // 10 buckets
    score_histogram_new: number[]
  }
}
```

- Response (commit, dryRun=false):

```ts
{
  new_config: { id, version, set_at, ... },
  recompute_job: { id, status: 'queued' }
}
```

- Errors: `HEURISTIC_CONFIG_INVALID`, `CONFIG_VERSION_CONFLICT` (if header `If-Match: <currentVersion>` doesn't match — used to prevent concurrent admin edits).

**`POST /api/v1/semesters/{semesterId}/recompute`** _(semester admin)_

- Body: `{ note?: string }`. Triggers a recompute against the _current_ active config (no config change).

**`GET /api/v1/semesters/{semesterId}/recompute/{jobId}`**

- Response: full job row.

### 8.12 User tokens

**`GET /api/v1/me/tokens`**

- Response: `{ tokens: { id, label, prefix, scopes, last_used_at, expires_at?, revoked_at?, created_at }[] }`.

**`POST /api/v1/me/tokens`**

- Body: `{ label: string, scopes?: TokenScopes, expires_at?: ISODate }`.
- Response: `{ token: TokenSummary, secret: string }` — `secret` is the full token shown once.

**`DELETE /api/v1/me/tokens/{tokenId}`** — sets `revoked_at`.

### 8.13 Audit

**`GET /api/v1/audit`**

- Auth: semester admin (sees their semester) or superadmin (sees all).
- Query: `semester_id?`, `actor_user_id?`, `action?`, `since?`, `until?`, `cursor?`, `limit?`.
- Response: `{ items: AuditLogRow[], next_cursor }`.

### 8.14 OpenAPI

**`GET /api/v1/openapi.json`** — the generated OpenAPI 3.1 document.
**`GET /api/v1/docs`** — Redoc-rendered HTML.

Both are public (no auth) so external scripts can discover the API.

---

## 9. Ingest pipeline

### 9.1 Job lifecycle

```
ingest_jobs.status:
  queued -> running -> { succeeded | partial | failed | cancelled }

ingest_files.status:
  pending -> { matched | unmatched | duplicate | failed | superseded | discarded }
              (matched is the success terminal; others are terminal-ish but can be revived via the unmatched tray for unmatched/discarded)
```

A job moves to `succeeded` iff every file is in {`matched`, `duplicate`, `superseded`}. `partial` iff some files are terminal-failure (`failed`, `unmatched`, `discarded`) but the job otherwise completed. `failed` iff the worker hit an unrecoverable error and the job is abandoned.

### 9.2 Filename convention

A semester's `filename_convention` is a JavaScript-compatible regex string (ECMA-262 syntax, no `g` or `y` flag). Named groups expected:

- `sid` — required.
- `assignment_id` — optional; if absent, fall back to the bundle's signed manifest `assignment.id`.

Validation at semester creation/edit time:

- Must compile.
- Must contain a `(?<sid>...)` named group.
- Length ≤ 500 chars.
- Test against a small sample of synthetic filenames if the UI supplies them (UI feature).

Default convention shipped by the superadmin tooling (suggested): `^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\d{6,12})\.zip$`.

### 9.3 Per-file phases (worker side)

Implemented in `packages/server/src/services/ingest/`. Each phase is a pure function with explicit inputs and outputs; the worker glues them and persists between phases.

1. **`stageBlob(file)`** — Stream the upload to `ingest-staging/{job}/{file}`. Compute `sha256` incrementally. Resulting `blob_sha256` recorded on `ingest_files`.
2. **`dedup(semesterId, sha256)`** — Lookup existing `submissions` row with the same `(semester_id, blob_sha256)`. If found: status=`duplicate`, link `submission_id`, _skip remaining phases_.
3. **`parseBundle(blob)`** — Read manifest + sessions via `packages/log-core`. Verify session signatures. Walk events. Failure → status=`failed`, `error` populated.
4. **`matchStudent(filename_convention, original_filename, manifest)`** — Apply regex. If `sid` resolves to a roster entry, capture matched student. Determine assignment from `assignment_id` group or fall back to manifest `assignment.id`. If `sid` group present but unknown to roster, or if regex fails: status=`unmatched`; _skip remaining phases_.
5. **`createSubmission(semesterId, assignmentId, studentId, blob)`** — Move blob from staging to `semesters/.../submissions/.../bundle.zip`. Allocate `version_index`. Existing matching submissions (older `version_index`) get `superseded_by_submission_id` updated to this new row.
6. **`materializeEvents(submissionId, parsedSessions)`** — Insert event rows in bulk (`COPY` or chunked multi-row insert; 1000 events per chunk).
7. **`computeStats(submissionId)`** — Compute and insert `per_file_stats`.
8. **`runValidation(submissionId)`** — Insert `validation_results`.
9. **`runHeuristics(submissionId, activeConfig)`** — Insert `flags`.
10. **`computeScore(submissionId)`** — Update `submissions.score_total` and `score_max_severity`.

After all per-file phases, the worker enqueues a `cross_flags_for_job(jobId)` job (§9.5).

Each phase that fails marks the file failed with a structured error containing `phase`, `cause`, and any structured detail (e.g. line/event seq).

### 9.4 Concurrency & ordering

- Multiple ingest workers run in parallel. A single job's files are processed concurrently (worker pool sized by `RECOMPUTE_MAX_PARALLEL`); per-file phases for a given file are sequential.
- `submission.version_index` allocation uses a row lock on `(semester_id, assignment_id, student_id)` to avoid races between concurrent uploads of the same student-assignment.
- Cross-flag recompute is single-threaded per semester (one worker holds a semester-scoped lock for the duration of the cross job).

### 9.5 Cross-flags after ingest

When a job's per-file phases complete:

- The worker enqueues a `recompute_cross_flags` job for the semester at the current active config version.
- That job:
  - Acquires a semester-scoped advisory lock.
  - Selects all non-superseded submissions in the semester.
  - Runs each cross-heuristic (`paste_shared_across_students`, plus any v3.1+ additions; `editing_pattern_clone` was retired 2026-09).
  - Replaces `cross_flags` + `cross_flag_participants` rows for this semester atomically in a single transaction.
  - Releases the lock.

A subsequent ingest before the cross job finishes does NOT wait; it enqueues another cross job. The lock ensures only one runs at a time per semester; the queue collapses multiple pending cross jobs to one ("singleton key" feature of pg-boss).

---

## 10. Heuristics, scoring, and recompute

### 10.1 Heuristic catalog

The full v3.0 catalog is the v2 PRD §7.4 set, ported server-side. For the record:

Process-shape (per-submission): `large_paste`, `paste_is_solution`, `external_edits`, `mass_external_replacement`, `low_typing_high_output`, `time_to_first_save_anomaly`, `idle_then_complete`, `no_intermediate_errors`, `paste_matches_known_source`.

Environment (per-submission): `ai_extension_active`, `terminal_active_during_external_change`, `extension_set_changed_mid_assignment`, `shell_integration_disabled`.

Integrity (per-submission): `chain_broken`, `clock_jumps`, `gap_in_heartbeats`, `multiple_sessions_overlap`, `extension_hash_mismatch`.

Cross-submission: `paste_shared_across_students`. (`editing_pattern_clone` was retired 2026-09; see `docs/heuristics.md`.)

Each heuristic is a pure function in `packages/analyzer/src/heuristics/<id>.ts` that already takes `(EventIndex, Bundle, Config)` and returns `Flag[]`. The server wraps these unchanged.

### 10.2 Heuristic config schema

```ts
// stored in heuristic_configs.config
{
  per_flag: {
    [heuristicId: string]: {
      enabled: boolean,
      weight: number,                  // default 1.0; multiplies severity * confidence
      thresholds?: jsonb               // heuristic-specific override (e.g. paste_min_chars)
    }
  },
  severity_weights: {
    info: number, low: number, medium: number, high: number   // default {0, 1, 3, 8}
  },
  config_format_version: 1
}
```

Validation:

- Every known `heuristicId` must have a `per_flag` entry. Setting up a new heuristic ships a migration that backfills entries with default `enabled: true, weight: 1.0`.
- `weight` is in `[0, 100]`.
- Unknown heuristic ids in the config are rejected.

### 10.3 Score formula

For each per-submission flag:

```
score_contribution = severity_weights[flag.severity]
                   * flag.confidence
                   * config.per_flag[flag.heuristic_id].weight
```

Disabled heuristics contribute zero. Cross-submission flags contribute to _every_ participant's submission with the same formula. `score_max_severity` is the highest severity among enabled-and-fired flags (no contribution if all disabled). `submissions.score_total` is the sum.

### 10.4 Recompute lifecycle

When a config is committed (`PUT .../heuristic-config` with `dryRun=false`) OR a manual recompute is triggered:

1. Insert a new `heuristic_configs` row with `is_active=false`. Bump the per-semester version. (The active config is the one with `is_active=true`; we flip the bit only after recompute completes, so the cohort view shows fresh+stale rows during the transition.)
2. Wait — actually for v3.0 we activate immediately on commit; the cohort UI shows `recompute_status='stale'` on rows that haven't been reprocessed yet.
3. Enqueue a `recompute_semester` job carrying `(semester_id, target_config_id)`.
4. Worker enumerates non-superseded submissions in the semester. For each:
   - Mark `submissions.recompute_status='recomputing'`.
   - Read events from DB (not blob).
   - Run heuristics + score with the new config.
   - In a single transaction: delete old `flags` for this submission, insert new flags, update score, set `heuristic_config_version` to the new version, set `recompute_status='fresh'`.
   - On error: set `recompute_status='error'`, persist error in a job summary entry; continue.
5. After all submissions, enqueue a cross-flag recompute (§9.5) using the new config.
6. Mark the recompute job terminal.

### 10.5 Dry-run computation

`PUT .../heuristic-config?dryRun=true`:

- Does NOT touch `heuristic_configs` or `flags`.
- For each non-superseded submission, runs heuristics with the candidate config against the existing in-DB events. Computes the prospective `score_total` and `score_max_severity`. Compares with current.
- Returns the diff payload (§8.11).
- Budget: must complete within 800ms server-side for ≤ 1000 submissions. For larger semesters the route still works but its rate limit kicks in.

Dry-run executes the heuristic functions but does not insert any rows; results live only in the response.

---

## 11. Per-submission computation

### 11.1 File reconstruction

Reuses `packages/analyzer/src/index/reconstruct-file-provenance.ts` (Phase 12 in the v2 plan).

Server-side wrapper at `packages/server/src/services/reconstruction.ts`:

- `getOrComputeContent(submissionId, path, at_seq) -> Promise<{ content, provenance, computed_at_ms }>`.
- LRU cache (size: configurable; default 256 entries, evicting per submission first). Cache keys are `${submissionId}:${path}:${at_seq}`.
- Cache hit: returns immediately. Miss: streams events for the submission ordered by seq, runs the v2 reconstructor, populates cache, returns.
- Cache invalidation: on any new ingest that supersedes the submission, on any deletion of the submission, on process restart.

The reconstructor is unchanged from v2. The only adapter work is the data source: instead of taking a `Bundle` it accepts an `AsyncIterable<HashedEnvelope>`. v2 helpers will need a small shim — flagged as an implementation detail, not an API change.

### 11.2 Stats

`computeStats` from v2 runs unchanged. Inputs are events; outputs are inserted into `per_file_stats`.

### 11.3 Validation

`runValidation` from v2 runs against the bundle + events. The Blob is read once during ingest for hash-chain re-validation; the result is stored in `validation_results` and never re-read for normal API calls. The `bundle download` endpoint re-validates on demand if a query param `validate=true` is supplied (used only by the staff "verify before integrity hearing" workflow).

### 11.4 Findings export

- Markdown: `packages/analyzer/src/export/findings-markdown.ts` runs server-side over the DB-sourced flags + validation + bundle metadata. Output uploaded to `exports/{artifactId}.md` and the row stored in `export_artifacts`.
- PDF: `packages/analyzer/src/export/findings-pdf.ts` already uses `jspdf` + `html2canvas`. Server-side rendering requires a jsdom + headless canvas shim; the implementation plan will pin the exact approach (likely Puppeteer rendering of an HTML report, instead of porting `html2canvas` to Node).
- Both formats produce identical content to v2; this is reuse, not redesign.

---

## 12. Background jobs

### 12.1 Job table

pg-boss owns its own queue tables (e.g. `pgboss.job`); we do NOT mirror status into our domain tables. Our `ingest_jobs` and `recompute_jobs` track _domain-level_ job state (totals, per-file outcomes); the queue is for delivery.

### 12.2 Job kinds

| Kind                     | Trigger                                        | Worker action                                                                                            | Singleton key         |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------- |
| `ingest_file`            | per ingest_files row                           | runs §9.3 phases                                                                                         | none                  |
| `ingest_finalize`        | last `ingest_file` of a job completes          | aggregate ingest_files into ingest_jobs.summary; set terminal status                                     | `${ingest_job_id}`    |
| `recompute_submission`   | recompute job enumeration                      | runs §10.4 step 4 for one submission                                                                     | none                  |
| `recompute_finalize`     | last `recompute_submission` of a job completes | sets terminal status; enqueues `recompute_cross_flags`                                                   | `${recompute_job_id}` |
| `recompute_cross_flags`  | end of ingest job OR end of recompute job      | per §9.5 / §10.4                                                                                         | `${semester_id}`      |
| `purge_expired_exports`  | daily cron                                     | delete `export_artifacts` rows + blobs where `expires_at < now()`                                        | `daily-expires`       |
| `purge_expired_sessions` | hourly cron                                    | delete `sessions` rows where `expires_at < now()`                                                        | `hourly-sessions`     |
| `retention_sweep`        | daily cron                                     | for each semester, delete blobs of submissions older than `blob_retention_days`; nothing deleted from DB | `daily-retention`     |

### 12.3 Retry policy

- `ingest_file` and `recompute_submission` jobs retry up to 3 times with exponential backoff. Final failure marks the corresponding `ingest_files.status='failed'` or `submissions.recompute_status='error'` with the error preserved.
- Finalize / cross-flag jobs retry up to 5 times — they're cheap and must complete.
- Cron jobs do not retry within the day; failures alert.

### 12.4 Worker concurrency

- API process does not consume jobs.
- Worker processes consume jobs with `RECOMPUTE_MAX_PARALLEL` concurrent handlers per worker.
- Singleton keys are honored by pg-boss; jobs with the same key are coalesced.

---

## 13. Audit logging

### 13.1 What is logged

All write actions and all blob downloads. Reads of individual submissions are logged. Reads of cohort lists are NOT.

### 13.2 Action catalog

| `action`                                                 | `target_type`            | When                            |
| -------------------------------------------------------- | ------------------------ | ------------------------------- |
| `user.login`                                             | `user`                   | OAuth callback success          |
| `user.logout`                                            | `user`                   | logout endpoint                 |
| `user.token.create`                                      | `api_token`              | token created                   |
| `user.token.revoke`                                      | `api_token`              | token revoked                   |
| `course.create`, `course.update`, `course.archive`       | `course`                 | superadmin actions              |
| `semester.create`, `semester.update`, `semester.archive` | `semester`               | superadmin / admin              |
| `member.invite`, `member.update`, `member.remove`        | `semester` (with detail) | admin actions                   |
| `roster.upload`, `roster.commit`, `roster.update_entry`  | `semester`               | admin                           |
| `assignment.create`                                      | `assignment`             | admin                           |
| `assignment.update`                                      | `assignment`             | admin                           |
| `ingest.start`, `ingest.cancel`                          | `ingest_job`             | admin                           |
| `ingest.unmatched.attach`, `ingest.unmatched.discard`    | `ingest_file`            | admin                           |
| `heuristic_config.commit`                                | `semester`               | admin                           |
| `recompute.trigger`                                      | `semester`               | admin                           |
| `submission.view`                                        | `submission`             | any read of the detail endpoint |
| `submission.bundle.download`                             | `submission`             | bundle endpoint                 |
| `submission.export.create`                               | `submission`             | export endpoint                 |
| `submission.delete`                                      | `submission`             | manual deletion (admin)         |

### 13.3 Retention

Audit retention is `max(semester.derived_retention_days, 1825)` (5 years floor). Audit rows are NEVER deleted by application code outside the retention sweep, and the retention sweep never deletes audit rows belonging to incidents marked `preserve=true` (a future field on `audit_log`, deferred for v3.0).

---

## 14. Frontend architecture

### 14.1 Routing

React Router v6, declarative routes.

```
/                                 -> redirect to /home if authed, /login otherwise
/login                            -> login page (single "Sign in with Google" button)
/home                             -> list of accessible semesters
/s/:semesterSlug                  -> SemesterRoot (default tab: cohort)
  /                               -> Cohort list (default)
  /students                       -> Student rollup table
  /assignments                    -> Assignment summary table
  /unmatched                      -> Unmatched tray
  /ingest                         -> Ingest start + job history
  /ingest/jobs/:jobId             -> Ingest job detail
  /roster                         -> Roster view + upload
  /heuristics                     -> Heuristic tuning UI
  /members                        -> Member management
  /settings                       -> Semester settings (admin only)
  /cross-flags                    -> Cross-flag list
  /sub/:submissionId              -> Submission drill-in (default: Overview)
    /                             -> Overview
    /replay                       -> Replay UI
    /timeline                     -> Raw timeline
    /validation                   -> Validation detail
    /export                       -> Export panel
  /student/:studentId             -> Student detail (all submissions, sparkline)
/admin                            -> Superadmin: courses CRUD (admin nav visible only if superadmin)
/me/tokens                        -> Token management
/audit                            -> Audit log viewer (admin / superadmin)
/local                            -> Standalone SPA (no auth wrapper)
```

### 14.2 Data layer

- React Query for all API calls. Query keys derive from the URL path + relevant filters.
- A single typed API client in `packages/analyzer/src/api/client.ts` generated from the shared Zod schemas (in `packages/shared`). No hand-written fetch calls.
- The per-submission viz modules consume a `SubmissionDataProvider` interface:

```ts
interface SubmissionDataProvider {
  getSummary(): Promise<SubmissionSummary>;
  getEvents(query: EventQuery): Promise<EventPage>;
  getFlags(): Promise<FlagRow[]>;
  getStats(): Promise<StatsResult>;
  getValidation(): Promise<ValidationReport>;
  getFiles(): Promise<FileSummary[]>;
  getFileContent(
    path: string,
    atSeq?: number,
  ): Promise<{ content: string; provenance: ProvenanceRun[] }>;
}
```

Two implementations: `ApiSubmissionDataProvider` (cohort app) and `InMemorySubmissionDataProvider` (standalone SPA).

### 14.3 Auth gating

A `<RequireAuth>` wrapper at the route level redirects to `/login` on 401 from `GET /api/v1/me`. The login page has a single Google button and no other content. Email-domain rejection is rendered in-page if the user lands there after a failed callback.

### 14.4 State that is NOT in URLs

- Sort order on the cohort list IS in the URL (`?sort=score_desc`).
- Filters ARE in the URL (`?assignment_id=...&severity_min=medium`).
- Saved-view names are stored client-side in localStorage v3.0 (server-stored saved views are deferred).
- The replay engine's transient state (current event index, play/pause, speed) IS in the URL (`?event=...&speed=...`), matching v2's behavior.

---

## 15. Standalone SPA (`/local`)

- Reachable at `<PUBLIC_BASE_URL>/local`. Static assets, in-browser analysis (no API calls for the analysis itself).
- **Staff-gated (amended 2026-07-10).** `/local` requires an authenticated principal who is course staff — i.e. has ≥1 semester membership, or is a superadmin. Enforced client-side by `RequireAuth` + `RequireStaff`. This supersedes the original "no auth" rule below: on the public hosted deployment, unauthenticated/unauthorized access would let any `@berkeley.edu` account (every student) run arbitrary bundles through the analyzer. Anonymous visitors are redirected to sign-in; signed-in non-staff are redirected to `/home`. See `docs/superpowers/specs/2026-07-10-public-landing-and-local-gate-design.md`.
  - _Superseded original intent (kept for history):_ local mode was to be reachable with no auth and no API calls so instructors could run the analyzer offline without a deployed backend. The tool is now a required, department-hosted deployment, so the offline-no-backend path is no longer a supported goal.
- Drop-a-zip UX is exactly v2's `LoadView`.
- Per-submission views are the SAME components used by the cohort app, parameterized by `SubmissionDataProvider`. The `/local` route wires `InMemorySubmissionDataProvider`.
- No nav chrome from the cohort app appears under `/local`.
- The cohort app and `/local` ship in the same Vite build. Code is split by route to keep `/local` cold-loadable.

---

## 16. Non-functional requirements

### 16.1 Performance budgets

| Operation                                                               | Budget                  | Notes                                                           |
| ----------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| Cohort list (500 rows, no filters)                                      | p95 < 300ms server-side | Cold cache.                                                     |
| Cohort list with score-range + 1 filter (5000 rows total, 500 returned) | p95 < 500ms             |                                                                 |
| Per-submission summary                                                  | p95 < 150ms             | Single-row reads + counts.                                      |
| Events query (single submission, 10k events filtered to ~1k)            | p95 < 400ms             |                                                                 |
| File reconstruction cold (one file, average bundle)                     | p95 < 800ms             | Subsequent reads on the same `(submission,file,at_seq)` < 20ms. |
| Heuristic dry-run (1k submissions)                                      | p95 < 800ms             |                                                                 |
| Full-semester recompute (1k submissions, 1 worker)                      | p95 < 5 min             | Scales linearly with workers.                                   |
| Ingest one bundle (5 MB, ~10k events)                                   | p95 < 8s                |                                                                 |
| Login round-trip (Google included)                                      | p95 < 4s                |                                                                 |

### 16.2 Scale targets

- 50,000 submissions per semester ("Open Question B" needs to confirm; current best guess).
- 100M event rows per semester before partitioning is required.
- 100 concurrent users on the cohort app.

### 16.3 Security posture

- TLS terminated at the deployment edge (Berkeley IT VM or reverse proxy). HTTP-only traffic refused.
- All cookies `Secure` + `HttpOnly` + `SameSite=Lax` + `__Host-` prefix in production.
- CSP header on the UI: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://accounts.google.com; frame-ancestors 'none'`.
- Argon2id for API token hashing (cost params: m=64MB, t=3, p=1).
- All Postgres queries via parameterized statements (Drizzle's prepared statements).
- No third-party JS at runtime (Google login is a redirect-based flow; no Google SDKs loaded on the page).
- Object-store presigned URLs scoped to `GET`, single object, expiry ≤ `BLOB_DOWNLOAD_URL_TTL_SECONDS`.

### 16.4 Observability

- Structured JSON logs via `pino` to stdout. One line per request including `request_id`, `principal_id`, `route`, `latency_ms`, `status_code`, `error_code` if any.
- Metrics emitted as Prometheus text endpoint at `/metrics` (internal port only): per-route latency histogram, queue depth, worker concurrency, recompute lag.
- Alerting rules (configured in deployment, not in code): API error rate > 1% over 5 min, recompute job stuck > 1h, queue depth > 1000.

### 16.5 Backups

- Postgres point-in-time recovery via continuous WAL archival to a separate prefix in object storage.
- Daily full base backup; WAL retention ≥ 14 days.
- Quarterly restore drill (operational, not part of code).
- Object-store cross-region replication if the provider supports it.

---

## 17. Error taxonomy

Codes are UPPER_SNAKE_CASE strings. The same code may appear at different HTTP statuses; consumers should match on code, not status.

| Code                                            | Status     | Where                                                       |
| ----------------------------------------------- | ---------- | ----------------------------------------------------------- |
| `VALIDATION`                                    | 400        | request schema invalid; `details.issues` carries Zod issues |
| `BAD_REQUEST_RETURN_TO_INVALID`                 | 400        | auth start                                                  |
| `AUTH_REQUIRED`                                 | 401        | no session/token on a protected route                       |
| `AUTH_OAUTH_STATE_MISMATCH`                     | 400        | OAuth callback                                              |
| `AUTH_OAUTH_CODE_EXCHANGE_FAILED`               | 502        | Google token endpoint                                       |
| `AUTH_DOMAIN_NOT_ALLOWED`                       | 403        | OAuth callback `hd` mismatch                                |
| `AUTH_EMAIL_NOT_VERIFIED`                       | 403        | OAuth callback                                              |
| `TOKEN_READ_ONLY`                               | 403        | token write attempt                                         |
| `TOKEN_SCOPE_OUT_OF_BAND`                       | 403        | token semester scope mismatch                               |
| `TOKEN_BLOB_NOT_PERMITTED`                      | 403        | token blob download without `include_blobs`                 |
| `NOT_A_MEMBER`                                  | 403        | non-member access                                           |
| `INSUFFICIENT_ROLE`                             | 403        | grader attempting admin action                              |
| `NOT_FOUND`                                     | 404        | resource not found (or not visible)                         |
| `COURSE_SLUG_TAKEN`                             | 409        |                                                             |
| `SEMESTER_SLUG_TAKEN`                           | 409        |                                                             |
| `VALIDATION_REGEX`                              | 400        | filename_convention parse                                   |
| `MEMBER_ALREADY`                                | 409        |                                                             |
| `INVITATION_ALREADY_OPEN`                       | 409        |                                                             |
| `EMAIL_DOMAIN_NOT_ALLOWED`                      | 200 (warn) | invitation to non-allowlisted domain                        |
| `CANNOT_DEMOTE_SELF`                            | 409        |                                                             |
| `LAST_ADMIN_REQUIRED`                           | 409        | removing the only admin                                     |
| `ROSTER_CSV_MISSING_REQUIRED_COLUMN`            | 400        |                                                             |
| `ROSTER_CSV_TOO_LARGE`                          | 413        |                                                             |
| `ROSTER_CSV_PARSE`                              | 400        |                                                             |
| `ROSTER_REQUIRED`                               | 422        | ingest without roster                                       |
| `INGEST_BATCH_TOO_LARGE`                        | 413        |                                                             |
| `INGEST_FILE_TOO_LARGE`                         | 413        |                                                             |
| `INGEST_TOO_MANY_FILES`                         | 400        |                                                             |
| `INGEST_FILE_NOT_UNMATCHED`                     | 409        | unmatched-tray edit on a different status                   |
| `ASSIGNMENT_ID_MISMATCH_BUNDLE`                 | 200 (warn) | unmatched-tray attach disagreement                          |
| `EVENT_QUERY_LIMIT_EXCEEDED`                    | 400        |                                                             |
| `EVENT_QUERY_RANGE_INVALID`                     | 400        |                                                             |
| `FILE_NOT_FOUND`                                | 404        | per-submission file                                         |
| `FILE_RECONSTRUCTION_TAINTED`                   | 200 (warn) | reconstruction can't proceed                                |
| `EXPORT_FORMAT_UNSUPPORTED`                     | 400        |                                                             |
| `EXPORT_RENDER_FAILED`                          | 500        |                                                             |
| `HEURISTIC_CONFIG_INVALID`                      | 422        | unknown id, weight out of range, etc.                       |
| `CONFIG_VERSION_CONFLICT`                       | 409        | If-Match version mismatch                                   |
| `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD` | 409        |                                                             |
| `RATE_LIMITED`                                  | 429        | with `Retry-After`                                          |
| `INTERNAL`                                      | 500        | catch-all; `details` empty in production                    |
| `DEPENDENCY_UNAVAILABLE`                        | 503        | DB / object store / queue down                              |

All warn-level codes (HTTP 200) carry a `warning` field in the response body in addition to the normal payload.

---

## 18. Schema and API migrations

### 18.1 Postgres migrations

- Drizzle `drizzle-kit generate` produces SQL migration files under `packages/server/db/migrations/`. Migrations are committed and applied via `drizzle-kit migrate` at deploy time.
- Forward-only. To revert, restore from PITR.
- Migration files are numbered + named (`0001_init.sql`, `0002_add_extras_jsonb.sql`, ...).
- Long-running migrations (e.g. adding indexes on `events`) MUST use `CREATE INDEX CONCURRENTLY` and run outside transactions; the migration framework supports this via raw SQL files.

### 18.2 API versioning

- `/api/v1` is permanent for the lifetime of v3.x. Additive changes (new endpoints, new optional fields, new error codes for warn-level returns) do not require a version bump.
- Removing a field, changing the type of a field, changing default behavior of an endpoint, or removing a route is a breaking change. Breaking changes go to `/api/v2` with a minimum 90-day deprecation window during which `/v1` continues to function and emits `Deprecation: <date>` + `Sunset: <date>` headers on affected routes.

### 18.3 Config format versioning

- `heuristic_configs.config.config_format_version` is incremented when the structure changes.
- Old config rows are migrated forward when their semester next commits a new config; the server can read all known versions.

### 18.4 Event payload schema

- The bundle's `format_version` (PRD §5.1) is recorded on `submissions.format_version`.
- Materialized `events.payload` is the bundle's JSON, untouched. Heuristics and reconstructors that depend on payload shape continue to use the same field-access patterns they did in v2.
- A future recorder bumping `format_version` to 2.0 (breaking) would require a code path that translates 2.0 events back to a 1.x equivalent on the way in, or branches on `submission.format_version`. v3.0 ships supporting 1.0 only.

---

## 19. Open questions

These need answers before or during implementation:

- **OQ-B (carried from design).** Real scale per semester: median bundle size, peak submissions per assignment, peak events per bundle. Affects partition strategy, worker sizing.
- **OQ-D.** Retention defaults: this PRD proposes 540 days for blobs, 1825 days for derived rows. Confirm with course staff / Berkeley legal.
- **OQ-K.** Saved-view storage: client-only for v3.0 (this PRD); add server storage in v3.1 if usage data warrants.
- **OQ-L.** Cross-flag scaling: `editing_pattern_clone` is O(N²) per assignment; v2 has early-termination but is unmeasured at scale. Confirm during ingest-pipeline implementation; if it blows the budget, add an LSH bucketing pass. **Resolved 2026-09:** it did — ~5.9M pairs on a ~7.7k-submission semester exhausted the worker heap on every attempt, and since it also fired on 94% of pairs the heuristic was retired rather than bucketed. `paste_shared_across_students`'s fuzzy grouping is also quadratic in paste count and remains unmeasured at that scale.
- **OQ-M.** PDF rendering on the server: `jspdf` + `html2canvas` is browser-native. Implementation can either (a) move to Puppeteer rendering of an HTML report, or (b) keep `jspdf` plus a Node-canvas polyfill. Decision deferred to the implementation plan; both produce identical content.
- **OQ-N.** Roster size limits: this PRD has none. Should there be a per-row count cap or per-CSV byte cap?
- **OQ-O.** Subdomain emails in the `hd` check: Berkeley uses `berkeley.edu` for the Workspace `hd` value, but some accounts have `@<sub>.berkeley.edu` _email_ with `hd: 'berkeley.edu'`. This PRD relies only on `hd`, not on email suffix, so subdomain emails are accepted as long as `hd` matches. Confirm.

---

## 20. Glossary

- **Bundle.** A ZIP of `.provenance/` from a recorder session; the unit of ingest.
- **Submission.** A row in `submissions`; a (semester, assignment, student) version of a bundle.
- **Cohort.** All non-superseded submissions in a semester (sometimes scoped further by filters).
- **Unmatched tray.** The UI/list of `ingest_files` with status `unmatched`, awaiting manual reconciliation.
- **Score.** The numeric per-submission rank produced by the scoring formula (§10.3).
- **Heuristic config.** The per-semester JSON document controlling per-flag enabled/weight/thresholds and severity weights.
- **Recompute.** The background job that re-runs heuristics + scoring on a semester's submissions, typically after a config change or new ingest.
- **Drill-in.** Navigating from cohort list to a single submission's overview/replay/timeline/validation/export.
- **Provenance kind.** One of `typed | paste | external_change | preexisting`; the v2-defined attribution per character.
- **`hd` claim.** Google ID token claim identifying the Workspace tenant. `berkeley.edu` is required.
- **Superadmin.** A user with `is_superadmin=true`; can create courses/semesters, see audit across the deployment, never auto-included in semester content access.
- **Membership.** A row in `memberships`; (user, semester, role) tuple.
- **Pending invitation.** A `pending_invitations` row for someone who has not yet logged in; consumed at first successful login on a matching email.

---

## Appendix A — Cohort list query plan

For reviewers (and the implementer), one query plan worth pinning early. The cohort list endpoint (§8.8) on a 50k-submission semester with no filters:

```sql
SELECT s.id, s.score_total, s.score_max_severity, s.validation_status,
       s.ingested_at, s.recorder_version, s.superseded_by_submission_id IS NOT NULL AS superseded,
       s.recompute_status,
       a.id, a.assignment_id_str, a.label,
       r.id, r.sid, r.display_name
FROM submissions s
JOIN assignments a ON a.id = s.assignment_id
JOIN roster_entries r ON r.id = s.student_id
WHERE s.semester_id = $1
  AND s.superseded_by_submission_id IS NULL
ORDER BY s.score_total DESC, s.id DESC
LIMIT 50;
```

Plan: index-only scan on `submissions_cohort_idx` (a partial covering index for the `superseded_by_submission_id IS NULL` predicate), followed by two indexed lookups. p95 < 200ms even on 50k rows. Cursor-based pagination uses `(score_total, id)` as the cursor tuple to avoid OFFSET.

The `flag_counts` and `top_flags` fields are populated by a secondary query keyed on the returned `submission_id` list:

```sql
SELECT submission_id, severity, COUNT(*)
FROM flags
WHERE submission_id = ANY($1::uuid[])
GROUP BY submission_id, severity;
```

Plus a similar TOP-N for top_flags. The frontend can choose to omit these on initial render and lazy-load per-row to keep p95 lower; design budget assumes they're included.

---

## Appendix B — Event row size estimate

Mean event payload from v2 sample bundles: ~250 bytes JSON, ~350 bytes JSONB on disk. At 10k events/submission × 50k submissions/semester = 500M events × 350 bytes ≈ 175 GB per semester. Add indexes (~50% overhead) → 260 GB.

This is past the comfort zone of a single Postgres instance without partitioning. The mitigation:

1. v3.0 ships unpartitioned. Most semesters will be far smaller than the 50k upper bound.
2. If a semester exceeds 10M events (measured at retention-sweep time), a migration moves that semester's events into a partitioned shadow table by `submission_id` hash. The submission-scoped indexes work identically.
3. Document this threshold and the migration steps; do not preemptively partition.

This is the partitioning revisit noted in the design doc §6.2.

---

## Appendix C — Reused v2 modules and their adapters

| v2 module                                                 | Reuse                         | Adapter needed                                                                     |
| --------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------- |
| `analyzer/src/index/parse-bundle.ts` + `parse-session.ts` | Yes — server ingest           | No adapter; pure functions over Uint8Array.                                        |
| `analyzer/src/index/build-index.ts`                       | Partial                       | Server reads events from DB and re-builds `EventIndex` for heuristics. Same shape. |
| `analyzer/src/index/reconstruct-file.ts`                  | Partial                       | Replaced in API by `reconstruct-file-provenance.ts` (the v2 default for replay).   |
| `analyzer/src/index/reconstruct-file-provenance.ts`       | Yes                           | Wrapper at `server/src/services/reconstruction.ts` adds caching.                   |
| `analyzer/src/index/stats.ts`                             | Yes                           | Wrapped during ingest.                                                             |
| `analyzer/src/heuristics/*.ts`                            | Yes (all)                     | Wrapper threads per-semester config.                                               |
| `analyzer/src/heuristics/run-heuristics.ts`               | Yes                           | Wrapped.                                                                           |
| `analyzer/src/heuristics/cross/*`                         | Yes                           | Wrapped as a semester-scoped job.                                                  |
| `analyzer/src/validation/*`                               | Yes                           | Wrapped at ingest.                                                                 |
| `analyzer/src/export/findings-markdown.ts`                | Yes                           | Wrapped at server.                                                                 |
| `analyzer/src/export/findings-pdf.ts`                     | Yes (with OQ-M decision)      | TBD.                                                                               |
| `analyzer/src/views/overview/*`                           | Yes                           | Data fetched via `SubmissionDataProvider`.                                         |
| `analyzer/src/views/replay/*`                             | Yes                           | Same.                                                                              |
| `analyzer/src/views/timeline/*`                           | Yes                           | Same.                                                                              |
| `analyzer/src/views/compare/*`                            | Yes                           | Repurposed for cross-flag side-by-side.                                            |
| `analyzer/src/views/load/*`                               | Yes — only on `/local` route. | None.                                                                              |

---

This PRD is intentionally exhaustive on contracts (data, API, errors) and intentionally light on UI specifics (those belong in the design doc and in implementation tickets). When the implementation plan is drafted, each phase will reference specific sections here as its acceptance criteria.
