# Provenance Analyzer v3 — Phased Implementation Plan

**Scope.** Build the v3 cohort analyzer described in `docs/analyzer-v3-design.md` against the contracts pinned in `docs/analyzer-v3-prd.md`. Three surfaces are touched:

- **NEW** `packages/server/` — the Node API + worker.
- **NEW** `packages/shared/` — cross-package Zod schemas and types.
- **MODIFIED** `packages/analyzer/` — refactor for the `SubmissionDataProvider` abstraction; build cohort UI on top of it; preserve the v2 standalone SPA at `/local`.

`packages/log-core/` and `packages/recorder/` are unchanged.

**Reading order.** Re-read the relevant section of the technical PRD before writing any phase. Where this plan and the PRD disagree, **the PRD wins.** Where this plan and `CLAUDE.md` disagree, **`CLAUDE.md` wins** for code conventions.

**Target end state.** Everything in PRD §1.1 (in scope) shipped; everything in §1.2 (out of scope) left alone. v3.0 tag cut at the end of Phase 25.

**Explicitly out of scope for this plan:** LLM-assisted review (PRD §7.6), student-facing accounts, LMS pull integration, real-time collaboration, user-defined heuristics, mobile UI. Tracked for v3.1+.

---

## 0. Decisions that gate everything

These are made up front because they propagate through every later phase. Each has a PRD anchor; if any is wrong, redirect before Phase 0.

### 0.1 Dependencies needing approval

Approved as a single v3.0 bundle by the PRD's §2 + this plan's §0. Adding anything beyond this list later requires the same per-PR approval CLAUDE.md mandates.

**Backend (`packages/server`):**

| Dependency                                            | Version | Used for                                             |
| ----------------------------------------------------- | ------- | ---------------------------------------------------- |
| `hono`                                                | `^4`    | HTTP framework.                                      |
| `@hono/node-server`                                   | latest  | Hono's Node adapter.                                 |
| `@hono/zod-openapi`                                   | latest  | Route handlers with Zod schemas, OpenAPI generation. |
| `zod`                                                 | `^3`    | Validation throughout.                               |
| `drizzle-orm`, `drizzle-kit`                          | latest  | Postgres ORM + migrations.                           |
| `postgres` (porsager)                                 | `^3`    | Postgres driver Drizzle wraps.                       |
| `pg-boss`                                             | `^10`   | Postgres-backed job queue.                           |
| `arctic`                                              | latest  | OAuth client (Google).                               |
| `oslo`                                                | latest  | Token + session primitives.                          |
| `argon2`                                              | latest  | API-token hashing.                                   |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | latest  | S3-compatible object storage.                        |
| `pino`, `pino-http`                                   | latest  | Structured JSON logs.                                |
| `nodemailer`                                          | latest  | Invitation emails.                                   |
| `papaparse`                                           | `^5`    | Roster CSV parsing.                                  |
| `diff`                                                | `^7`    | Already in v2; re-exported for server use.           |
| `puppeteer`                                           | latest  | PDF export (see OQ-M; chosen here).                  |
| `redoc-cli` (dev)                                     | latest  | Render OpenAPI docs to static HTML during build.     |

**Frontend (`packages/analyzer`):**

| Dependency              | Version | Used for                                                                 |
| ----------------------- | ------- | ------------------------------------------------------------------------ |
| `@tanstack/react-query` | `^5`    | Server-state caching.                                                    |
| `@tanstack/react-table` | `^8`    | Cohort table primitives.                                                 |
| `react-hook-form`       | `^7`    | Forms.                                                                   |
| `zod`                   | `^3`    | Shared with server via `packages/shared`.                                |
| `@hookform/resolvers`   | latest  | Zod resolver for react-hook-form.                                        |
| `recharts`              | `^2`    | Score histogram, sparklines.                                             |
| `date-fns`              | latest  | Date formatting. (Already in some v2 surfaces; promote to a direct dep.) |

**Test infrastructure:**

| Dependency       | Version | Used for                             |
| ---------------- | ------- | ------------------------------------ |
| `testcontainers` | latest  | Postgres in integration tests.       |
| `msw`            | `^2`    | Mock the HTTP API in frontend tests. |
| `supertest`      | latest  | HTTP-level server tests.             |

### 0.2 Other up-front decisions

1. **Branch strategy.** All v3 work on branch `analyzer-v3` off `main`. Merge to `main` after Phase 25 + final review. Tag `v3.0.0-analyzer`. No interim merge to `main`; v3 is too large for the v2 "merge per feature" pattern and the surfaces are isolated from v2's shipping artifacts.
2. **Sub-branches per phase are optional.** A phase whose diff likely exceeds ~500 lines / ~10 files should land on a sub-branch (`analyzer-v3/phaseNN-…`) merged into `analyzer-v3` after review. Smaller phases commit straight to `analyzer-v3`.
3. **Test infrastructure.** Three tiers, mirrored from v2's recorder pattern:
   - **Unit:** Vitest, co-located, no DB. Pure functions only.
   - **Integration:** Vitest + `testcontainers` spinning ephemeral Postgres per file. The server's full request pipeline is exercised over Hono's in-process fetch; no port binding. Workers run in the same process.
   - **End-to-end (smoke):** A small Playwright suite that boots a server against a test DB, walks login (with a Google-token mock), runs an ingest, asserts the cohort list. Lives in `packages/server/test/e2e/`. Not part of the default `npm run test`; runs in CI under a `test:e2e` script.
4. **OAuth in tests.** The Google token-exchange and JWKs fetch are injected through a `GoogleOAuthClient` seam. Tests construct a fake client that returns a pre-baked ID token payload (already PKCE-validated). The seam is the only place mocking is allowed in the auth flow.
5. **Working DB in dev.** A `docker-compose.dev.yml` (or `compose.yaml`) brings up Postgres + an MinIO (S3-compatible object store) for local development. Documented in `packages/server/README.md`. Production object storage (R2 / S3) wires via env vars.
6. **No code coverage gate** beyond what already exists in v2. Per-phase tests aim for "each new pure function gets unit coverage; each new endpoint gets at least one integration test."
7. **Subagent-driven execution.** Same pattern as v2: dispatch implementer → spec-compliance review → code-quality review → mark complete → next phase. Sequential only.
8. **Subagent model selection (initial proposal — adjust per phase).** Pure-TS server phases (1–4, 10–13, 16–18): sonnet impl + sonnet code-review + haiku spec-review. UI phases (20–24): sonnet impl + sonnet code-review. Scaffolding/release (0, 19, 25): haiku across the board. Recompute correctness (13–14): consider opus for impl if the heuristic recompute math review surfaces issues during Phase 13.
9. **Diff size discipline.** Per CLAUDE.md, target ~200 lines / ~5 files. Backend phases naturally trend larger; the per-phase notes below call out which phases to split when implementing.
10. **Co-located tests.** `foo.ts` and `foo.test.ts` in the same dir, server and frontend alike. Integration tests live under `packages/server/test/integration/`.
11. **Deterministic tests.** Inject a clock; never assert against `Date.now()`. Inject a UUID source where it'd otherwise appear in assertions. The DB's `now()` is fine for non-asserted fields.
12. **Migration discipline.** Drizzle generates migration files; the migration file is part of the phase's diff. Migrations are forward-only (see PRD §18.1). A phase that needs a column added writes the migration; squash-rewriting migrations across phases is forbidden after merge to `main`.
13. **`.notes/v3-progress.md`** is a new local-only progress file (gitignored via `.git/info/exclude`), parallel to the v2 `.notes/analyzer-progress.md`. Controller updates it as phases complete.
14. **Re-using v2 modules.** Phases that wrap a v2 module (e.g. Phase 11 wraps `validation/`) must import from the existing path, not copy code. The existing analyzer modules already live in TS files with no DOM dependency for the parts we need; if any phase finds a hidden DOM dep, surface it as a Phase-12-style "extract-the-spine" sub-task and split.
15. **API surface freezes per phase.** When a phase declares an endpoint in this plan, its request/response shape matches the PRD exactly. Any deviation found during implementation is escalated as a PRD revision, not absorbed silently.

---

## Working agreement (recap)

- Branch: `analyzer-v3`.
- Subagent-driven execution; sequential only.
- Each phase: dispatch implementer → spec-compliance → code-quality → mark complete → next.
- Commit conventions match memory `feedback_commit_style` (`--no-gpg-sign`, no Co-Authored-By, conventional prefix, incremental commits).
- Update `.notes/v3-progress.md` at each phase close.

---

# Phase index

| #   | Phase                                                                   | PRD §§                                 | Scale (rough)        |
| --- | ----------------------------------------------------------------------- | -------------------------------------- | -------------------- |
| 0   | Workspace + server scaffold                                             | §2, §3                                 | Small                |
| 1   | Postgres + Drizzle + identity & structure tables                        | §5.1                                   | Small                |
| 2   | Google OAuth + sessions + /me                                           | §4.1–4.2, §8.1                         | Medium               |
| 3   | API tokens + bearer middleware                                          | §4.3, §4.5, §8.12                      | Small                |
| 4   | authorize() + rate limit + audit middleware + error formatter           | §4.5, §7.3, §7.6, §13                  | Medium               |
| 5   | Courses + semesters CRUD                                                | §5.1, §8.2                             | Small                |
| 6   | Members + invitations                                                   | §4.4, §5.1, §8.3                       | Medium               |
| 7   | Roster CSV upload + diff preview + commit                               | §5.2, §8.4                             | Medium               |
| 8   | Object storage + signed URLs                                            | §6, §16.3                              | Small                |
| 9   | Ingest pipeline I: stage / dedup / parse / match / create submission    | §5.3–5.4, §8.6, §9.1–9.4               | Large (likely split) |
| 10  | Ingest pipeline II: events materialization + per-file stats             | §5.4, §9.3                             | Medium               |
| 11  | Validation pipeline server-side                                         | §5.4, §11.3                            | Small                |
| 12  | Heuristics on server (per-submission suite)                             | §5.4, §10.1–10.3                       | Medium               |
| 13  | Heuristic config table + scoring + dry-run + recompute job              | §5.5, §8.11, §10.2–10.5, §12           | Large (likely split) |
| 14  | Cross-submission heuristics + semester recompute hook                   | §5.4, §9.5, §10.1                      | Medium               |
| 15  | Unmatched tray endpoints + ingest job/files endpoints                   | §8.6–8.7                               | Small                |
| 16  | Cohort list + students + assignments + cross-flags APIs                 | §8.2 facets, §8.5, §8.8, §8.10, Appx A | Medium               |
| 17  | Per-submission summary/flags/stats/validation/events APIs               | §8.9, §11                              | Medium               |
| 18  | File reconstruction API + LRU cache + bundle download                   | §8.9, §11.1, §16.1                     | Medium               |
| 19  | OpenAPI spec + Redoc + audit endpoint + observability surfaces          | §7.7, §8.13–8.14, §16.4                | Small                |
| 20  | Frontend: login + nav shell + RequireAuth + home                        | §14.1, §14.3                           | Small                |
| 21  | Frontend: cohort list view + filters + URL state                        | §14.1–14.4, Appx A                     | Large                |
| 22  | Frontend: ingest + roster + members + assignments + settings            | §14.1                                  | Medium               |
| 23  | Frontend: per-submission drill-in via SubmissionDataProvider            | §14.2, Appx C                          | Large (likely split) |
| 24  | Frontend: heuristic tuning + recompute progress + cross-flags + exports | §10.5, §14.1                           | Medium               |
| 25  | Standalone SPA at /local + retention sweep + admin docs + release       | §15, §12.2, §14                        | Medium               |

---

# v3 — phases

## Phase 0 — Workspace + server scaffold

**Goal.** `packages/server/` and `packages/shared/` are real workspace packages. The server builds, type-checks, lints, and serves a healthcheck endpoint over Hono. `npm run dev --workspace=packages/server` boots and responds at `/healthz`.

**PRD anchors.** §2 (stack & deps), §3 (env vars).

**Deliverables:**

- `packages/server/package.json`:
  - `"type": "module"`, Node ≥ 22.
  - Scripts: `dev`, `build`, `start`, `test`, `typecheck`, `lint`.
  - Dependencies: `hono`, `@hono/node-server`, `@hono/zod-openapi`, `zod`, `pino`, `pino-http`. Other v3 backend deps added as they're needed by later phases.
- `packages/server/tsconfig.json` — extends `tsconfig.base.json`, sets `module: ESNext`, `moduleResolution: Bundler` (server is bundled via `tsx` in dev and `esbuild` in build; pattern matches recorder's ESM conversion).
- `packages/server/src/`:
  - `index.ts` — CLI entry (parses `--mode={api,worker,all}`, routes to `api/start.ts` or `jobs/worker.ts`).
  - `api/start.ts` — boots Hono, registers `GET /healthz`, listens on `PORT`.
  - `config/env.ts` — Zod env schema, fails-loud on missing/malformed values per PRD §3.1.
  - `config/index.ts` — exports the parsed config singleton.
  - `logging.ts` — pino logger with JSON output, request-id binding.
- `packages/shared/package.json` — minimal, exports `api-schemas.ts` (empty file with a comment for now; populated in later phases).
- Root `package.json` — `workspaces` array updated to include both new packages.
- ESLint boundary in `eslint.config.mjs`:
  - `packages/server/src/**`: forbid `vscode`, DOM globals.
  - `packages/log-core/src/**`: continues to forbid `node:*`, `fs`, `path`, `worker_threads`, `crypto` (unchanged).
  - `packages/analyzer/src/**`: continues to forbid `node:*`, etc. (unchanged).
- `packages/server/README.md` — dev quickstart, env var reference (table from PRD §3.1), `compose.yaml` instructions.
- `compose.yaml` at repo root — Postgres 16 + MinIO services for dev. NOT used in tests (testcontainers spawn their own).

**Tests:**

- `packages/server/src/config/env.test.ts` — happy path + each required-var-missing case → loud failure.
- `packages/server/src/api/start.test.ts` — boots Hono in-process, hits `/healthz`, expects `{ status: "ok" }`.

**Exit gate.** `npm run typecheck && npm run lint && npm run test && npm run build` green at repo root. Manual: `npm run dev --workspace packages/server` boots, `curl localhost:3000/healthz` returns `{"status":"ok"}`.

**Notes.** No DB or storage yet. The `--mode=all` flag exists but currently just starts the API; worker entry is a no-op until Phase 12.

---

## Phase 1 — Postgres + Drizzle + identity/structure tables

**Goal.** Drizzle is wired with a connection pool; the initial migration creates `users`, `sessions`, `courses`, `semesters`, `memberships`, `pending_invitations`. A repo-level CLI runs migrations. Integration test harness using testcontainers stands up a DB, runs migrations, and tears it down.

**PRD anchors.** §5.1 (schema), §4.4 (pending_invitations).

**Deliverables:**

- Deps added: `drizzle-orm`, `drizzle-kit`, `postgres`, plus dev `testcontainers`, `@testcontainers/postgresql`.
- `packages/server/src/db/schema.ts` — Drizzle table defs for the §5.1 entities. Enums (`role`, `term`) as text columns with CHECK constraints (matches PRD).
- `packages/server/db/migrations/0001_init.sql` — generated migration; reviewed and committed.
- `packages/server/src/db/client.ts` — pool factory, drizzle instance, transaction helper.
- `packages/server/src/db/migrate.ts` — CLI that runs migrations (`npm run db:migrate`).
- `packages/server/test/helpers/db.ts` — testcontainers harness: `withTestDb(fn)` spawns Postgres, runs migrations, yields a connection-string-bound drizzle instance, tears down on completion.
- README updates: `db:migrate`, `db:generate` scripts; how to add a new migration.

**Tests:**

- `packages/server/src/db/client.test.ts` — connects, runs a `SELECT 1`.
- `packages/server/src/db/schema.test.ts` — integration: insert a `course`, then a `semester`, then a `user`, then a `membership`. Assert FK constraints reject orphans. Assert the partial-unique-on-active-config constraint deferred to Phase 13 (this phase only has identity/structure tables).
- `packages/server/test/helpers/db.test.ts` — harness self-test: spawn, migrate, query, tear down.

**Exit gate.** Migration applies cleanly on a fresh Postgres 16. Tests pass. `npm run db:generate` after a schema edit produces a valid follow-up migration.

**Notes.** Other tables (`roster_entries`, `assignments`, `ingest_*`, `submissions`, `events`, `flags`, etc.) are introduced in the phases that need them, each with its own migration file numbered sequentially. This keeps phase diffs small and reviewable.

---

## Phase 2 — Google OAuth + sessions + /me

**Goal.** A user can sign in with Google. The `hd === berkeley.edu` and `email_verified === true` gates are enforced at the callback. Sessions are stored in Postgres and identified by a `__Host-prov_sess` cookie. `GET /api/v1/me` returns the principal.

**PRD anchors.** §4.1–4.2, §8.1, §17 auth errors.

**Deliverables:**

- Deps added: `arctic`, `oslo`.
- `packages/server/src/auth/google.ts` — wraps `arctic`'s Google provider with the PKCE flow. Exports a `GoogleOAuthClient` interface (the seam from §0.2.4) plus a real impl.
- `packages/server/src/auth/sessions.ts` — `createSession`, `findSession`, `deleteSession`, `extendSession`. Backed by the `sessions` table.
- `packages/server/src/auth/cookies.ts` — cookie name from env, `__Host-` enforcement in production, helpers.
- `packages/server/src/api/v1/routes/auth.ts` — `POST /auth/google/start`, `GET /auth/google/callback`, `POST /auth/logout`.
- `packages/server/src/api/v1/routes/me.ts` — `GET /me`. Reads session from cookie OR bearer token (token verification added in Phase 3, but the structure here accommodates).
- `packages/server/src/api/middleware/auth-session.ts` — middleware that resolves `sessions` → principal and binds it to the request.
- `packages/server/src/api/v1/errors.ts` — first iteration of the error taxonomy from PRD §17 covering auth codes (`AUTH_REQUIRED`, `AUTH_OAUTH_STATE_MISMATCH`, `AUTH_OAUTH_CODE_EXCHANGE_FAILED`, `AUTH_DOMAIN_NOT_ALLOWED`, `AUTH_EMAIL_NOT_VERIFIED`).
- `packages/server/src/api/v1/index.ts` — Hono app composition; mounts auth + me routes.

**Tests:**

- `packages/server/src/auth/google.test.ts` — unit tests using the `GoogleOAuthClient` seam: state mismatch, PKCE verifier handling, ID-token signature verify path.
- `packages/server/src/api/v1/routes/auth.test.ts` — integration: full /start → /callback round trip with the seam. Assert `hd` mismatch → 403; `email_verified=false` → 403; happy path → session row inserted, cookie set, redirect to `return_to`.
- `packages/server/src/api/v1/routes/me.test.ts` — unauthenticated → 401 `AUTH_REQUIRED`. Authenticated → returns user + (empty) memberships.

**Exit gate.** Integration tests cover all four error paths and the happy path. Logout deletes the row + clears the cookie. The `__Host-` prefix is enforced when `NODE_ENV=production`.

**Notes.** Membership reflection in `/me` returns `[]` until Phase 5. Superadmin bootstrap (`AUTH_SUPERADMIN_EMAILS`) is read at login time. The `pending_invitations` activation step is added in Phase 6.

**Split candidate.** If this phase exceeds ~600 lines, split into 2a (OAuth client + sessions, no routes) and 2b (routes + middleware).

---

## Phase 3 — API tokens + bearer middleware

**Goal.** Logged-in users can mint, list, and revoke API tokens. Tokens authenticate API requests via `Authorization: Bearer`. Token scopes (`read_only`, `semester_ids`, `include_blobs`) are stored and surfaced; the actual scope enforcement lands in Phase 4 with `authorize()`.

**PRD anchors.** §4.3, §4.5, §8.12.

**Deliverables:**

- Deps added: `argon2`.
- Migration `0002_api_tokens.sql` — `api_tokens` table per PRD §4.3.
- `packages/server/src/auth/tokens.ts` — `createToken`, `findTokenByPrefix`, `verifyToken` (argon2id), `revokeToken`.
- `packages/server/src/api/middleware/auth-token.ts` — middleware: if `Authorization: Bearer` present, parse prefix, look up, verify, attach `principal = { kind: 'token', user, token }`. Updates `last_used_at`.
- `packages/server/src/api/middleware/auth-resolve.ts` — wraps session + token middlewares with a precedence rule (header beats cookie; consistent across phases).
- `packages/server/src/api/v1/routes/me-tokens.ts` — `GET /me/tokens`, `POST /me/tokens`, `DELETE /me/tokens/{id}`.

**Tests:**

- Token creation returns a secret exactly once; subsequent reads expose only `prefix`.
- Bearer auth with a valid token resolves to the token's user.
- Revoked tokens 401.
- Expired tokens 401.
- Concurrent revoke is idempotent.
- A token whose user is deleted 401s (CASCADE works).

**Exit gate.** A token created in dev can call `GET /api/v1/me` with `Authorization: Bearer`.

**Notes.** Token-scope enforcement (`read_only`, `semester_ids`, `include_blobs`) is wired in Phase 4 inside `authorize()`. This phase just persists and exposes them.

---

## Phase 4 — authorize() + rate limit + audit middleware + error formatter

**Goal.** Centralize the authorization decision tree and request-pipeline middlewares. After this phase, any new endpoint slots into the pipeline by declaring `(action, target)` once and inherits auth, rate limiting, audit logging, and consistent error formatting.

**PRD anchors.** §4.5 (authorize), §7.3 (errors), §7.6 (rate limits), §13 (audit).

**Deliverables:**

- `packages/server/src/auth/authorize.ts` — the function from PRD §4.5. Pure (takes principal + action + target, returns `Allow | Deny<code>`). No DB calls here — caller passes in the relevant membership(s).
- `packages/server/src/auth/membership-cache.ts` — request-scoped cache for `findMembership(user, semester)`.
- `packages/server/src/api/middleware/authorize.ts` — Hono middleware factory: `requireAuth({ action, target })` resolves principal, looks up memberships, runs `authorize()`, sets `c.var.principal` or 401/403.
- `packages/server/src/api/middleware/rate-limit.ts` — token-bucket per (principal, route class). Backing store: in-memory map by default; Postgres-backed `rate_limit_buckets` table for production correctness across processes. Migration `0003_rate_limit.sql`.
- `packages/server/src/api/middleware/audit.ts` — middleware factory that, on success of a write route, inserts an `audit_log` row. Migration `0004_audit_log.sql`.
- `packages/server/src/api/middleware/error.ts` — global error handler. Maps thrown `ApiError` instances to PRD §17 JSON. Stack traces never leak in production.
- `packages/server/src/api/middleware/request-id.ts` — generates and attaches a request id; sets `X-Request-Id` on responses.
- `packages/server/src/api/v1/errors.ts` — extended to the full PRD §17 catalog (all 40 codes).

**Tests:**

- `authorize` truth table: superadmin yes; non-member 403; grader admin-action 403; admin admin-action allow; token read-only write blocked; token out-of-scope semester blocked; blob without `include_blobs` blocked.
- Rate limit: 31st request inside a 5-min window hits 429 with `Retry-After`.
- Audit: a successful write logs a row with the request id; a 4xx failure does NOT.
- Error formatter: every code in PRD §17 round-trips correctly.

**Exit gate.** A trivial new endpoint can be added in ≤ 30 LOC and inherits auth + rate + audit + errors. Pipeline diagram lives in `packages/server/src/api/README.md`.

**Notes.** Rate-limit Redis path is out of scope here; the Postgres-backed bucket is sufficient for v3.0. The `RATE_LIMIT_REDIS_URL` env var is reserved but unused until a future scaling need.

---

## Phase 5 — Courses + semesters CRUD

**Goal.** Superadmin can create, view, update, archive courses and semesters. Semester members can view their semesters. `/me` now reflects accessible semesters.

**PRD anchors.** §5.1, §8.2.

**Deliverables:**

- `packages/server/src/api/v1/routes/courses.ts` — list, create, get, update, archive.
- `packages/server/src/api/v1/routes/semesters.ts` — list (within course), create, get, update, archive.
- `packages/server/src/services/structure.ts` — service module owning the DB writes (slug uniqueness, archive cascade behavior).
- `packages/server/src/api/v1/schemas/structure.ts` — Zod schemas for request/response per PRD §8.2.
- Update `/me` to include accessible semesters with `my_role`.

**Tests:**

- Slug uniqueness: `COURSE_SLUG_TAKEN`, `SEMESTER_SLUG_TAKEN`.
- Filename-convention regex compile check: `VALIDATION_REGEX`.
- Non-superadmin creating a course: 403.
- Archived semester: writes 403 (read-only); reads still work.

**Exit gate.** A superadmin can fully populate the structure tier via API; a non-superadmin member can list and read but not write.

---

## Phase 6 — Members + invitations

**Goal.** Semester admins invite people by email. Pending invitations are stored and activated on first matching login. Admin/grader role enforcement is correct. "Last admin" guard prevents lockout.

**PRD anchors.** §4.4, §5.1, §8.3.

**Deliverables:**

- `packages/server/src/api/v1/routes/members.ts` — list members + pending; invite; update role; remove.
- `packages/server/src/services/invitations.ts` — invite (creates `pending_invitations` row, sends email if configured), activate-on-login hook, revoke.
- Update Phase 2's OAuth callback to call `activatePendingInvitations(verifiedEmail)` after creating the user.
- `packages/server/src/email/transport.ts` — `nodemailer` SMTP wrapper. When `SMTP_URL=''`, falls back to logging the email to stderr (dev mode).
- `packages/server/src/email/templates/invitation.ts` — text + HTML invitation email.
- Update audit catalog with `member.invite`, `member.update`, `member.remove`, `invitation.revoke`.

**Tests:**

- Invite an existing-user email → membership created immediately, no `pending_invitations` row.
- Invite a non-existing email → `pending_invitations` row + email sent.
- First login with a matching email activates the invitation.
- Last-admin removal blocked; demoting self when sole admin blocked.
- Re-invite while one is open → `INVITATION_ALREADY_OPEN`.
- Non-allowed-domain invitation succeeds but returns a `warning` field (`EMAIL_DOMAIN_NOT_ALLOWED`).

**Exit gate.** Full invitation round-trip in integration tests, including the "user signs in for the first time after being invited" path.

---

## Phase 7 — Roster CSV upload + diff preview + commit

**Goal.** Semester admin uploads a CSV; server parses, diffs against current roster, returns preview. Admin commits with `accept_deletions` true/false. Individual roster entries can be edited.

**PRD anchors.** §5.2, §8.4.

**Deliverables:**

- Deps added: `papaparse`.
- Migration `0005_roster.sql` — `roster_entries` table.
- `packages/server/src/services/roster/parse.ts` — Papa Parse wrapper, column validation, row-error collection.
- `packages/server/src/services/roster/diff.ts` — pure diff: add / update / delete sets given current rows and parsed rows.
- `packages/server/src/services/roster/preview-cache.ts` — in-memory 30-min cache keyed by `upload_id` (rebooting the server forfeits in-flight uploads; acceptable for v3.0).
- `packages/server/src/api/v1/routes/roster.ts` — `GET /roster`, `POST /roster:upload`, `POST /roster:commit`, `PATCH /roster/{id}`.

**Tests:**

- Required-column missing → `ROSTER_CSV_MISSING_REQUIRED_COLUMN`.
- CSV with parse error in one row → preview returns the error, succeeds otherwise.
- `accept_deletions=false` skips deletes.
- Re-commit of an expired `upload_id` → 404.
- `sid` is immutable.

**Exit gate.** A 5k-row CSV uploads, previews, and commits within p95 < 800ms.

---

## Phase 8 — Object storage + signed URLs

**Goal.** S3-compatible blob put/get works; signed-URL issuer hands out short-lived `GET` URLs.

**PRD anchors.** §6, §16.3.

**Deliverables:**

- Deps added: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.
- `packages/server/src/services/storage/client.ts` — S3 client factory keyed off env.
- `packages/server/src/services/storage/blobs.ts` — `putBlob(key, stream) → { sha256, size }`, `getBlob(key) → stream`, `presignGetUrl(key, ttlSeconds) → string`, `deleteBlob(key)`.
- `packages/server/src/services/storage/keys.ts` — key builders for `semesters/.../bundle.zip`, `exports/...`, `ingest-staging/...`.
- Hash-while-streaming: `putBlob` computes sha256 incrementally so callers don't double-read.

**Tests:**

- Integration test against MinIO in testcontainers: put, get, presign, delete.
- Streaming put computes correct sha256 on a 50 MB random buffer.
- Presigned URL is `GET` only and expires within tolerance.

**Exit gate.** Blob round-trip works end-to-end in tests. Presigned URL TTL respects `BLOB_DOWNLOAD_URL_TTL_SECONDS`.

---

## Phase 9 — Ingest pipeline I: stage / dedup / parse / match / create submission

**Goal.** The first half of §9.3. Upload arrives; job + files rows created; per-file pipeline runs through phase 5 (`createSubmission`). Subsequent phases (6+) are stubbed and land in Phase 10. Events not yet materialized; submissions exist but are incomplete.

**PRD anchors.** §5.3 (ingest tables), §5.4 (submissions table), §8.6, §9.1–9.4.

**Deliverables:**

- Deps added: `pg-boss`.
- Migration `0006_ingest_and_submissions.sql` — `ingest_jobs`, `ingest_files`, `assignments`, `submissions` per PRD §5.3–5.4.
- `packages/server/src/jobs/pg-boss.ts` — pg-boss setup, kind registry, singleton-key helpers.
- `packages/server/src/jobs/worker.ts` — worker entry point.
- `packages/server/src/services/ingest/phases.ts` — `stageBlob`, `dedup`, `parseBundle`, `matchStudent`, `createSubmission` per §9.3. Each phase is a pure-ish function with explicit error returns.
- `packages/server/src/services/ingest/filename-convention.ts` — regex compile + run; rejects forbidden flags; named-group introspection.
- `packages/server/src/services/ingest/job-control.ts` — `enqueueIngestJob`, `finalizeIngestJob`, status transitions.
- `packages/server/src/api/v1/routes/ingest.ts` — `POST /ingest` (multipart), `GET /ingest/jobs`, `GET /ingest/jobs/{id}`, `POST /ingest/jobs/{id}/cancel`. The `GET /ingest/jobs/{id}/files` endpoint lands in Phase 15.

**Tests:**

- Filename convention: missing `(?<sid>…)` rejected at semester edit time.
- `dedup`: re-upload of identical bytes → existing submission_id, no new blob.
- `matchStudent`: matching sid in roster → matched; missing in roster → unmatched; missing sid group → unmatched.
- Assignment fallback: filename has no `assignment_id` group → reads from bundle manifest.
- `createSubmission`: version_index 1 for first; 2 for second; first marked superseded.
- Concurrent uploads of same (semester, assignment, student) serialize correctly under the row lock.

**Exit gate.** A single bundle can be uploaded, dedup correctly fires on re-upload, the unmatched path stops cleanly without partial state. Phase 10 picks up event materialization.

**Split candidate.** Very likely. Sub-phases 9a (job + ingest routes + stage/dedup), 9b (parse + match + createSubmission). Each ~5–7 files.

---

## Phase 10 — Ingest pipeline II: events + per-file stats

**Goal.** Phases 6–7 of §9.3. Events materialize into the `events` table; per-file stats compute and insert. After this phase, an ingested submission has full event history queryable from the DB and stats populated. Heuristics and validation still pending.

**PRD anchors.** §5.4 (events, per_file_stats), §9.3.

**Deliverables:**

- Migration `0007_events_per_file_stats.sql` — `events` and `per_file_stats` tables + indexes per PRD §5.4.
- `packages/server/src/services/ingest/materialize-events.ts` — chunked insert (1000 events per multi-row INSERT or `COPY`). Includes a v2 → DB envelope adapter (event payload preserved as-is; envelope fields broken out).
- `packages/server/src/services/ingest/stats.ts` — wrapper around v2's `computeStats`. Reads events from the in-memory bundle (we have it parsed already); writes to `per_file_stats`.
- Connect ingest worker: phases 6 + 7 added after createSubmission; success path advances `ingest_files.status` to `matched`.

**Tests:**

- 10k-event bundle ingests; row count matches; indexes are present.
- Per-file stats match v2's computeStats output for a known fixture.
- Concurrent ingest of two unrelated submissions writes their events without interleaving in the chunks.
- Re-ingest after deletion behaves correctly (CASCADE on submissions wipes events).

**Exit gate.** A real recorder-produced bundle ingests end-to-end through phase 7 of §9.3.

---

## Phase 11 — Validation pipeline server-side

**Goal.** Per PRD §11.3, run v2's `runValidation` at ingest, persist into `validation_results`. `submissions.validation_status` reflects the overall.

**PRD anchors.** §5.4 (validation_results), §11.3.

**Deliverables:**

- Migration `0008_validation_results.sql`.
- `packages/server/src/services/ingest/validation.ts` — wraps v2's validator. Reads the bundle in-memory + events from DB (same data available at ingest time without a second blob read).
- Connect to worker after stats phase.

**Tests:**

- Each of the 8 PRD §5.4 checks toggles status correctly with crafted bundles.
- `validation_status` aggregates: any fail → `fail`; any warn no fail → `warn`; else `pass`.
- Re-running validation is idempotent (same input → same output rows).

**Exit gate.** Validation results visible per submission; matches v2 SPA output on the same fixture.

---

## Phase 12 — Heuristics on server (per-submission suite)

**Goal.** Per-submission heuristics run at ingest. Process-shape + environment + integrity heuristics from PRD §7.4 are ported; cross-submission heuristics are deferred to Phase 14. Heuristic config v0 is hard-coded (defaults from v2) until Phase 13 introduces the config table.

**PRD anchors.** §5.4 (flags), §10.1–10.3.

**Deliverables:**

- Migration `0009_flags.sql`.
- `packages/server/src/services/heuristics/registry.ts` — re-exports v2's `HEURISTIC_REGISTRY` filtered to per-submission heuristics.
- `packages/server/src/services/heuristics/run-per-submission.ts` — given (submission_id, events, bundle, config), reconstructs the v2 `EventIndex` from DB events and runs the registry. Writes `flags` rows.
- `packages/server/src/services/scoring/compute.ts` — applies PRD §10.3 formula; writes `score_total`, `score_max_severity`.
- Connect to worker after validation phase.

**Tests:**

- Each heuristic from PRD §7.4 v1 + v2 process/env/integrity fires correctly against a crafted bundle.
- Score arithmetic matches the formula.
- Re-run produces identical flags + score (deterministic).

**Exit gate.** Full per-submission heuristic + score row present after ingest. Cross-flags still empty.

**Notes.** This phase introduces a _temporary_ hard-coded config used during compute. Phase 13 makes config a DB row and starts populating `heuristic_config_version`. To avoid a rewrite, this phase already writes `weight_at_compute` and `score_contribution` columns; the only future change is the source of `weight`.

---

## Phase 13 — Heuristic config table + dry-run + recompute job

**Goal.** Per-semester heuristic config exists, is editable, has versions. Dry-run preview endpoint computes prospective scores without writes. Commit creates a new active config and enqueues a recompute job that re-runs heuristics across the semester.

**PRD anchors.** §5.5 (heuristic_configs, recompute_jobs), §8.11 (config endpoints), §10.2–10.5 (config schema + recompute lifecycle), §12 (jobs).

**Deliverables:**

- Migration `0010_heuristic_configs_and_recompute.sql`.
- `packages/server/src/services/heuristics/config.ts` — read active config, validate (per PRD §10.2), atomic `commitNewVersion`.
- `packages/server/src/services/scoring/dry-run.ts` — runs candidate config across submissions without inserts; produces the diff payload from PRD §8.11.
- `packages/server/src/services/scoring/recompute-submission.ts` — per-submission recompute (worker job target).
- `packages/server/src/jobs/recompute.ts` — `recompute_semester` enumerator, `recompute_submission` handler, `recompute_finalize` aggregator.
- `packages/server/src/api/v1/routes/heuristic-config.ts` — `GET`, `PUT` (with `?dryRun`), `POST /recompute`, `GET /recompute/{id}`, `GET /heuristic-configs` (history).
- Backfill: on first migration run, insert a v1 default config for every existing semester so `submissions.heuristic_config_version` becomes consistent. Phase 12 work that wrote `heuristic_config_version = 0` is migrated to `= 1`.

**Tests:**

- Dry-run produces the diff payload shape.
- Commit flips active bit atomically (partial unique index enforces single active per semester).
- Recompute job: enumerates submissions, marks recomputing, processes, marks fresh, finalizes job status correctly with partial failures.
- `If-Match` header enforces version conflict.

**Exit gate.** A semester admin can change a weight, see the dry-run diff, commit, and watch the recompute job progress.

**Split candidate.** Likely split into 13a (config table + dry-run) and 13b (recompute job + endpoints).

---

## Phase 14 — Cross-submission heuristics + semester recompute hook

**Goal.** Cross-heuristics (`paste_shared_across_students`, `editing_pattern_clone`) run server-side under a semester-scoped advisory lock. Cross-flags + participants persist. After every ingest and every recompute, a cross-flag recompute is enqueued.

**PRD anchors.** §5.4 (cross_flags, cross_flag_participants), §9.5, §10.1.

**Deliverables:**

- Migration `0011_cross_flags.sql`.
- `packages/server/src/services/heuristics/run-cross.ts` — wraps v2 cross-heuristics. Iterates non-superseded submissions in the semester; calls per-heuristic logic; writes flag rows + participants.
- `packages/server/src/jobs/recompute-cross-flags.ts` — pg-boss handler with semester-scoped singleton key; acquires advisory lock; transactional replace.
- Hook `recompute_finalize` and `ingest_finalize` to enqueue `recompute_cross_flags(semester)`.

**Tests:**

- Synthetic two-bundle paste-shared case produces a cross-flag with both submissions as participants.
- Editing-pattern-clone on N=10 synthetic similar bundles fires once per pair.
- Re-running cross-flags is idempotent (table reset under transaction).
- Concurrent ingests in a semester collapse to one cross-flag recompute.

**Exit gate.** Cross-flags visible in DB after ingest. Recompute lag from ingest finish to cross-flag fresh < 30s for a 50-bundle semester.

**Notes.** OQ-L (cross-flag scaling) is exercised here. If `editing_pattern_clone` blows the budget on a synthetic 1k-submission semester, add an LSH bucketing pass in this phase; otherwise defer.

---

## Phase 15 — Unmatched tray endpoints + ingest job/files endpoints

**Goal.** The unmatched tray is interactive. Admins can list unmatched files, attach to a (student, assignment), or discard. Ingest job detail + files list endpoints land.

**PRD anchors.** §8.6 (ingest job detail), §8.7 (unmatched tray).

**Deliverables:**

- `packages/server/src/api/v1/routes/unmatched.ts` — `GET /unmatched`, `PATCH /unmatched/{id}`, `POST /unmatched/{id}/discard`.
- Extend `ingest.ts` with `GET /ingest/jobs/{id}/files` (paginated).
- `packages/server/src/services/ingest/attach.ts` — re-runs phases 5–9 (createSubmission + materialize + stats + validation + heuristics + score) for a manually attached file.
- Audit actions: `ingest.unmatched.attach`, `ingest.unmatched.discard`.

**Tests:**

- Attach moves file from `unmatched` → `matched`, creates submission, runs heuristics.
- Attach with bundle-manifest assignment-id disagreement → `ASSIGNMENT_ID_MISMATCH_BUNDLE` warning (admin must confirm in UI; API still succeeds with warning field).
- Discard sets status without creating a submission.
- Concurrent attach of the same file: second hits `INGEST_FILE_NOT_UNMATCHED`.

**Exit gate.** A semester admin can clean up unmatched files entirely via API.

---

## Phase 16 — Cohort list + students + assignments + cross-flags APIs

**Goal.** The cohort-list workhorse endpoint and its siblings are live. Filters, sorts, facets, and cursor pagination work. Appendix A's query plan is realized.

**PRD anchors.** §8.2 (assignments), §8.5 (assignments detail), §8.8 (cohort + students), §8.10 (cross-flags), Appendix A.

**Deliverables:**

- `packages/server/src/api/v1/routes/cohort.ts` — `GET /semesters/{id}/submissions`, `GET /semesters/{id}/students`, `GET /semesters/{id}/assignments`.
- `packages/server/src/api/v1/routes/cross-flags.ts` — `GET /semesters/{id}/cross-flags`, `GET /cross-flags/{id}`.
- `packages/server/src/services/cohort/list.ts` — query builder for the cohort list per PRD §8.8 (filters/sorts/cursor + facets via secondary aggregation). Uses the partial covering index from §5.4.
- `packages/server/src/services/cohort/facets.ts` — produces the `facets` block (by_severity, by_validation, by_assignment).
- Update `assignments` table backfill: rolling counts kept fresh via the cohort query, not via triggers; assignment summary uses on-demand aggregation cached per request.

**Tests:**

- Pagination cursor round-trips: page 1 + page 2 + … assembles to the full list.
- Filter combinations: 1, 2, 3 filters each cover one branch of the query builder.
- `include_superseded=false` (default) excludes superseded rows.
- Sort stability: equal scores order by `id DESC` (cursor tuple).
- Facet counts match the `WHERE` clause minus the dimension being faceted.
- 50k-row synthetic semester: cohort-list p95 < 300ms (PRD §16.1 budget).

**Exit gate.** Performance budget met on a synthetic 50k-row dataset; facets correct.

---

## Phase 17 — Per-submission summary/flags/stats/validation/events APIs

**Goal.** Every per-submission read endpoint is live. The events-query endpoint — the API's most-hammered endpoint by external scripts — meets its budget.

**PRD anchors.** §8.9, §11.

**Deliverables:**

- `packages/server/src/api/v1/routes/submissions.ts` — `GET /submissions/{id}`, `.../flags`, `.../stats`, `.../validation`, `.../files`.
- `packages/server/src/api/v1/routes/events.ts` — `GET /submissions/{id}/events`, `.../events/{seq}`.
- `packages/server/src/services/submissions/summary.ts` — aggregate the summary shape (counts, top_flags, files) from already-stored rows.
- `packages/server/src/services/events/query.ts` — translates query params into SQL. Picks the index based on which filters are present.

**Tests:**

- Each filter dimension on events query exercises the right index (verify with `EXPLAIN` capture in a test helper).
- `total_count` included only when cheap.
- `limit > 2000` → `EVENT_QUERY_LIMIT_EXCEEDED`.
- Negative `seq_from` / out-of-order range → `EVENT_QUERY_RANGE_INVALID`.
- Events query p95 < 400ms for 10k-event submission filtered to 1k.

**Exit gate.** External script can paginate through a submission's events efficiently.

---

## Phase 18 — File reconstruction API + LRU cache + bundle download

**Goal.** Per-submission file content and provenance endpoints land, backed by a server-side LRU around v2's `reconstructFileWithProvenance`. Bundle download issues a signed URL.

**PRD anchors.** §8.9 (`/files/...`, `/bundle`), §11.1, §16.1.

**Deliverables:**

- `packages/server/src/services/reconstruction.ts` — wrapper around `reconstructFileWithProvenance`. LRU cache (size from env). Stream events from DB by submission_id ordered by seq.
- `packages/server/src/api/v1/routes/files.ts` — `GET /submissions/{id}/files/{path}/content`, `.../provenance`.
- `packages/server/src/api/v1/routes/bundle.ts` — `GET /submissions/{id}/bundle` (302 to signed URL). Token-scope `include_blobs` enforced.
- Audit: `submission.bundle.download` rows include the request id and presigned-URL expiry.

**Tests:**

- Cold reconstruction completes within budget on a synthetic 4-hour-session bundle.
- Cache hit returns within 20ms.
- Cache eviction works under memory pressure.
- Provenance run-length encoding round-trips through the API.
- Bundle download with a token missing `include_blobs` → `TOKEN_BLOB_NOT_PERMITTED`.

**Exit gate.** The Monaco-replay frontend can fetch content + provenance for any seq position.

---

## Phase 19 — OpenAPI spec + Redoc + audit endpoint + observability surfaces

**Goal.** The API is documented as a published OpenAPI 3.1 spec at `/api/v1/openapi.json` and rendered at `/api/v1/docs`. The audit endpoint is live. `/metrics` exposes Prometheus text. Request logs are clean and consistent.

**PRD anchors.** §7.7 (response headers), §8.13 (audit), §8.14 (OpenAPI), §16.4 (observability).

**Deliverables:**

- `packages/server/src/api/v1/openapi.ts` — composes per-route OpenAPI from `@hono/zod-openapi` into the published spec.
- `packages/server/src/api/v1/docs.ts` — Redoc HTML page.
- `packages/server/src/api/v1/routes/audit.ts` — `GET /audit` with filtering per PRD §8.13.
- `packages/server/src/api/middleware/metrics.ts` — Prometheus counters + histograms; exposed at `/metrics` on a separate listener (not public).
- Final pass on response headers: `X-Request-Id`, `Cache-Control`, rate-limit headers consistent across endpoints.
- `docs/api-quickstart.md` — "Querying the cohort from Python" (matches PRD §14 docs deliverable).

**Tests:**

- OpenAPI spec validates against the OpenAPI 3.1 meta-schema.
- Every route declared in PRD §8 is present in the spec.
- Audit endpoint returns rows for a synthetic action log; filter by `action` works.

**Exit gate.** An external user can read the docs page, mint a token, and successfully call `/submissions/{id}/events` from a one-pager Python script. The script is the smoke test for OQ — PI feedback closed.

---

## Phase 20 — Frontend: login + nav shell + RequireAuth + home

**Goal.** Cohort frontend boots. Unauthenticated → `/login`. Logged-in → `/home` (semester list). Navigation shell + semester switcher present.

**PRD anchors.** §14.1, §14.3.

**Deliverables:**

- Deps added: `@tanstack/react-query`, `react-hook-form`, `@hookform/resolvers`, `recharts`, `date-fns`.
- `packages/shared/src/api-schemas.ts` — populated with shared Zod schemas used by both packages.
- `packages/analyzer/src/api/client.ts` — generated client from shared schemas. Single fetch wrapper handles errors, CSRF-safe defaults.
- `packages/analyzer/src/api/queries.ts` — React-Query hooks per endpoint group (`useMe`, `useSemesters`, etc.).
- `packages/analyzer/src/auth/RequireAuth.tsx` — route guard.
- `packages/analyzer/src/views/login/LoginView.tsx` — single "Sign in with Google" button. Renders error message if `?error=...` query param is present (from the OAuth callback redirect).
- `packages/analyzer/src/views/home/HomeView.tsx` — list of accessible semesters.
- `packages/analyzer/src/components/nav/SemesterSwitcher.tsx`, `nav/AppShell.tsx` — chrome.
- Update `App.tsx` routing to add the new structure (preserves the legacy `/load`/`/overview`/`/timeline`/`/replay` routes during the transition; they'll be moved to `/local` in Phase 25).

**Tests:**

- RTL: unauthenticated visit to `/home` → redirect to `/login`.
- Authenticated `/home` lists semesters from a mocked API (msw).
- Semester switcher navigates between memberships.

**Exit gate.** Manual: log in via Google in dev → land on `/home` → see the test course/semester created via Phase 5.

---

## Phase 21 — Frontend: cohort list view + filters + URL state

**Goal.** The central screen. Virtualized table backed by `@tanstack/react-table`, full filter rail, URL-encoded filters, "by submission" / "by student" toggle, sortable columns, saved-views in localStorage.

**PRD anchors.** §8.8 (cohort APIs), §14.1, §14.2, §14.4 (URL state), Appendix A.

**Deliverables:**

- `packages/analyzer/src/views/cohort/CohortView.tsx` — top-level page.
- `cohort/FilterRail.tsx` — validation status, flag presence checkboxes, severity threshold, score-range slider, signal toggles.
- `cohort/CohortTable.tsx` — virtualized table; columns from PRD §8.8.
- `cohort/StudentRollupTable.tsx` — alternative view.
- `cohort/use-cohort-filters.ts` — URL ↔ filter-state sync; saved-view loaders.
- `cohort/SavedViews.tsx` — localStorage-backed dropdown.
- `cohort/ExportCurrentView.tsx` — client-side CSV of the visible rows.

**Tests:**

- Filter changes update URL.
- Reload from URL restores filters and selection.
- Saved views round-trip through localStorage.
- Virtualization renders correctly on a 5k-row mocked dataset; scrolling p95 keeps frame budget.

**Exit gate.** Manual: load a real semester with N=500 submissions, filter, sort, drill into one (lands on the per-submission route which is still a placeholder; Phase 23 wires the real drill-in).

**Split candidate.** Filter rail + table + URL-state-sync is large. Sub-phases 21a (table + columns), 21b (filter rail + URL state), 21c (saved views + export).

---

## Phase 22 — Frontend: ingest + roster + members + assignments + settings

**Goal.** Admin pages for the semester. Bulk upload, roster diff preview, member invite, assignment label editing, semester settings.

**PRD anchors.** §14.1, §8.3, §8.4, §8.5, §8.6.

**Deliverables:**

- `views/ingest/IngestStartView.tsx` — multi-file drop zone + upload progress. POST `/ingest`.
- `views/ingest/IngestJobView.tsx` — job detail with per-file table, status counts, cancel.
- `views/unmatched/UnmatchedView.tsx` — list + attach modal + discard.
- `views/roster/RosterView.tsx` — list + upload with diff preview modal.
- `views/members/MembersView.tsx` — list + invite form + role change + remove. LAST_ADMIN_REQUIRED handled in UI.
- `views/assignments/AssignmentsView.tsx` — assignment label/sort editing.
- `views/settings/SemesterSettingsView.tsx` — display name, filename convention with live regex tester, retention sliders.

**Tests:**

- Filename-convention live tester shows match groups for sample inputs.
- Diff preview correctly displays add/update/delete counts.
- Invite form validates email format client-side.

**Exit gate.** A semester admin can fully manage their semester via UI.

---

## Phase 23 — Frontend: per-submission drill-in via SubmissionDataProvider

**Goal.** v2's overview/replay/timeline/validation/export components are reused inside the cohort app, sourced from the API. The `SubmissionDataProvider` abstraction is introduced; v2's existing data path is preserved behind the same interface.

**PRD anchors.** §14.2 (provider), Appendix C (module reuse map).

**Deliverables:**

- `packages/analyzer/src/data/SubmissionDataProvider.ts` — interface.
- `packages/analyzer/src/data/ApiSubmissionDataProvider.ts` — backed by API client + React Query.
- `packages/analyzer/src/data/InMemorySubmissionDataProvider.ts` — wraps v2's in-memory bundle path; used by `/local` in Phase 25.
- Refactor v2 view modules (`views/overview`, `views/replay`, `views/timeline`) to consume the provider instead of importing `BundleContext` directly. The refactor is mechanical: add a `useSubmissionData()` hook and replace direct context reads. Existing v2 tests continue to pass against the in-memory provider.
- `views/submission/SubmissionShell.tsx` — tab shell for Overview / Replay / Timeline / Validation / Export.
- Provenance + content fetching paginated where needed (replay scrubs).

**Tests:**

- Same fixture, both providers, identical rendered output (component-level snapshots match).
- Replay smoke: scrub 100 events forward and back via the API provider; matches v2 in-memory.

**Exit gate.** Click a row in the cohort list → land on Overview → switch to Replay → scrub. All from the API.

**Split candidate.** Almost certain: 23a (provider abstraction + Overview migration), 23b (Replay + Timeline migration), 23c (Validation + Export migration).

---

## Phase 24 — Frontend: heuristic tuning + recompute progress + cross-flags + exports

**Goal.** Admins can adjust heuristic weights, see a dry-run diff, commit, and watch recompute progress. Cross-flag list + side-by-side detail are live. Exports trigger downloads.

**PRD anchors.** §10.5 (dry-run + recompute), §8.10 (cross-flags), §8.11 (config), §8.9 (export).

**Deliverables:**

- `views/heuristics/TuningView.tsx` — left: heuristic list with sliders + on/off; right: dry-run preview pane (histogram + top movers via `recharts`).
- `views/heuristics/RecomputeProgress.tsx` — banner shown when a recompute is in flight; reads `/recompute/{id}` periodically.
- `views/cross-flags/CrossFlagListView.tsx`, `CrossFlagDetailView.tsx` — adapted from v2's CompareView.
- `views/submission/ExportPanel.tsx` — POST `/export`, poll if async, prompt download.

**Tests:**

- Slider drag debounces; dry-run only fires after 300ms idle.
- Commit transitions UI to recompute-progress banner.
- Cross-flag detail renders side-by-side using existing v2 compare primitives.

**Exit gate.** Tuning round-trip works end-to-end.

---

## Phase 25 — Standalone SPA at /local + retention sweep + admin docs + release

**Goal.** The v2 standalone "drop a zip" UX is preserved at `/local`. Retention sweep job runs daily. Admin guide + API quickstart documented. v3.0 cut as a release.

**PRD anchors.** §15 (standalone), §12.2 (cron jobs).

**Deliverables:**

- Move existing v2 routes (`/load`, `/overview`, `/timeline`, `/replay/:sessionId`, `/compare`) under a `/local/...` prefix.
- `packages/analyzer/src/views/local/LocalShell.tsx` — no-auth wrapper. Renders v2 chrome unchanged.
- `packages/analyzer/src/auth/RequireAuth.tsx` — explicitly skip the `/local` subtree.
- Code-splitting: confirm `/local` doesn't pull cohort-only chunks (verify via the Vite bundle analyzer output committed under `packages/analyzer/dist/.report.html` or equivalent dev-only).
- `packages/server/src/jobs/retention-sweep.ts` — daily cron via pg-boss; deletes blobs whose submission's semester `blob_retention_days` has elapsed since `archived_at`. Never deletes DB rows.
- `packages/server/src/jobs/purge-expired-sessions.ts` — hourly cron.
- `packages/server/src/jobs/purge-expired-exports.ts` — daily cron.
- `docs/admin-guide.md` — hosting, Google OAuth client setup with `berkeley.edu` `hd`, retention, backups, restore drill.
- `docs/api-quickstart.md` — Python and curl examples.
- Root `README.md` updated to reflect v3.
- `packages/server/README.md` final pass.
- Tag `v3.0.0-analyzer` after merge to `main`.

**Tests:**

- Visit `/local` while logged out → works.
- Visit `/local` while logged in → still works, no cohort chrome.
- Retention sweep test: a synthetic semester archived 600 days ago has its blobs purged; events untouched.

**Exit gate.** End-to-end smoke: a fresh deployment, superadmin bootstrap, course + semester + members + roster + ingest of a 50-bundle batch + cohort review + tuning + export — all green.

---

## Risks and known unknowns

- **OQ-B (scale).** First real semester ingest will tell us whether ingest worker concurrency is enough. Phase 9–14 measurements should be captured in `.notes/v3-progress.md`; if a 5k-bundle ingest takes > 1h with 4 workers, scale workers before launch.
- **OQ-L (cross-flag scaling).** Addressed in Phase 14 if measurements demand it.
- **OQ-M (PDF rendering).** This plan commits to Puppeteer (server-side headless Chromium). Phase 24 implements it. If Puppeteer proves operationally heavy, the fallback is server-side jsPDF without HTML rendering at lower fidelity.
- **Phase split discipline.** Phases 9, 13, 21, 23 are explicitly flagged as likely splits. The controller (whoever orchestrates the subagents) decides at dispatch time.
- **OAuth in production.** Google OAuth client must be created under a course-owned Google Cloud project; this is operational, not engineering. Tracked as a prerequisite to the Phase 25 deploy.
- **DB migrations on production data.** v3 has no production data on day zero; the first ingest is the bootstrap. Forward-only migrations are safe because rollback restores from PITR (PRD §18.1).

---

## What future agents should do when resuming

1. Read this file top-to-bottom.
2. Read the design doc and the technical PRD in that order.
3. Check `git log --oneline analyzer-v3` to verify recorded commits match `.notes/v3-progress.md`.
4. Run `npm run typecheck && npm run lint && npm run test && npm run build` at repo root — should be all green before starting any new phase.
5. Open the next pending phase's section in this file.
6. Open the corresponding PRD sections.
7. Dispatch the implementer per `superpowers:subagent-driven-development`.
8. **Update `.notes/v3-progress.md`** when the phase completes — flip status, add commit SHA, append any new design decisions or PRD-revision proposals.

---

## Per-phase commit conventions (recap)

- `git commit --no-gpg-sign -m "..."` (signing skipped per repo memory).
- NO `Co-Authored-By` trailer.
- Conventional prefixes: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`.
- Scope tag in commit subject identifies the surface: `feat(server):`, `feat(analyzer):`, `feat(shared):`, `chore(repo):`.
- Commit incrementally — one commit per phase is the floor; split if a phase is large per the split-candidate notes above.

---

## Documentation cross-reference

| Doc                                       | Role                                                                                          |
| ----------------------------------------- | --------------------------------------------------------------------------------------------- |
| `docs/prd.md`                             | Product PRD — behavior, log format, heuristics catalog. Source of truth for product behavior. |
| `docs/analyzer-v3-design.md`              | v3 design + architecture + locked brainstorm decisions.                                       |
| `docs/analyzer-v3-prd.md`                 | v3 technical PRD — contracts for DB, API, errors, perf, security.                             |
| `docs/analyzer-v3-implementation-plan.md` | THIS doc — phased build.                                                                      |
| `docs/heuristics.md`                      | Live, code-linked catalog of heuristics with thresholds. Updated as Phase 12 / 14 land.       |
| `docs/analyzer-implementation-plan.md`    | v2 plan (reference for past phasing decisions).                                               |
| `docs/implementation-plan.md`             | Recorder plan (reference).                                                                    |
| `docs/recorder.md`                        | Recorder ops/security doc.                                                                    |
| `CLAUDE.md`                               | Repo conventions; wins on code-style disputes.                                                |

The v3 implementation completes when every phase in this file has its status flipped to ✅ in `.notes/v3-progress.md` and `v3.0.0-analyzer` is tagged on `main`.
