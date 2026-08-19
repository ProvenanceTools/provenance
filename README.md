<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/exports/lockup-dark.png" />
  <img alt="Provenance" src="brand/exports/lockup-light.png" width="360" />
</picture>

**An academic-integrity telemetry and analysis system.**

Provenance has two halves that share one artifact:

1. **Provenance Recorder** — a VS Code extension that runs while a student works on an assignment and produces a tamper-evident log of how the code came into existence.
2. **Provenance Analyzer** — a full-stack web app used by course staff to ingest, score, and review those logs at scale. Includes: a cohort list with filter/sort/export, per-submission drill-in with timeline replay and validation, a heuristics tuning UI, cross-submission paste detection, and a standalone offline mode (`/local`) that runs entirely in-browser.

The full design lives in [`docs/prd.md`](docs/prd.md). Code conventions for working in this repo are in [`CLAUDE.md`](CLAUDE.md).

## Packages

Provenance is an npm workspace of five packages. Each builds on `log-core`; none of the
top-level packages depend on each other's source.

| Package                                  | What it is                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`packages/log-core`](packages/log-core) | The log format shared by every other package: event types, JCS canonicalization, the hash chain, the validator, ndjson serialization, bundle and manifest shapes, and ed25519 manifest verification. Pure TypeScript with zero dependencies on VS Code, Node, or the DOM, so the same code runs in the extension, the browser, and the server.                                   |
| [`packages/recorder`](packages/recorder) | The VS Code extension that records a tamper-evident `.provenance` log while a student works: all PRD §4 event types, three-signal paste detection, external-change detection, a per-session signing keypair, signed checkpoints, chain recovery, bundle sealing, and a disk-full degraded mode.                                                                                  |
| [`packages/shared`](packages/shared)     | The Zod schemas that define the HTTP API contract, imported by both the server and the analyzer so the two stay in sync.                                                                                                                                                                                                                                                         |
| [`packages/analyzer`](packages/analyzer) | The React/Vite single-page app course staff use to review submissions: Google OAuth login, semester switcher, a virtualized cohort list, per-submission drill-in (overview / timeline / replay / validation), a 25-flag heuristics tuning UI (per-flag weight + on/off), and cross-submission flags. A standalone `/local` route runs entirely in-browser from a dropped `.zip`. |
| [`packages/server`](packages/server)     | The Node.js + Hono API server: PostgreSQL via Drizzle ORM, Google OAuth with sessions and API tokens, the ZIP ingest pipeline (parse → match → heuristics → cross-flags), a pg-boss job queue, an OpenAPI 3.1 spec with Redoc, Prometheus metrics, and retention/purge cron jobs. Object storage is S3-compatible (MinIO in dev).                                                |

## Quickstart — development environment

Requires Node 22+ and npm 10+. Docker is required to run the server (Postgres + MinIO via `docker compose`).

```sh
git clone <repo> provenance
cd provenance
npm install
npm run build
```

`npm run build` is a one-time prerequisite, not just a test step. The workspace
packages (`log-core`, `shared`, `analysis-core`) are consumed through their
`exports` maps, which point at built output in each package's git-ignored `dist/`.
Until you build, that `dist/` is absent and any dev entrypoint that imports these
packages — notably the analyzer frontend — fails to resolve with
`imported but could not be resolved` errors. Re-run `npm run build` (or the
per-package `build` script) after pulling changes to those packages.

### Run all tests

```sh
npm run build && npm run typecheck && npm run lint && npm run test
```

### Run the analyzer v3 server (API + worker)

Requires Docker. The [`packages/server/README.md`](packages/server/README.md) has the
full server dev guide (run modes, migrations, env var reference); the essentials are:

```sh
# 1. Start Postgres + MinIO
docker compose up -d

# 2. Create the MinIO storage bucket (one-time — uploads 404 without it)
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker compose exec minio mc mb local/provenance

# 3. Configure environment. Defaults match the compose stack; fill in Google
#    OAuth creds for real logins (dummy values are fine for API/worker/seed work).
cp packages/server/.env.example packages/server/.env

# 4. Run migrations
npm run db:migrate --workspace=packages/server

# 5. Start the server — API + pg-boss worker in ONE process (`--mode=all`)
npm run dev --workspace=packages/server
```

The server starts on `http://localhost:3000`. Swagger UI at `http://localhost:3000/api/v1/docs`.

`npm run dev` runs the API and the background worker together (via `--mode=all`), so
uploaded bundles are actually ingested. In production the two run as separate
`--mode=api` and `--mode=worker` processes — see the server README. (To run the API
alone in dev: `npm run dev --workspace=packages/server -- --mode=api`.)

### Seed example data

With the server prerequisites above in place (compose up, bucket created, `.env`,
migrations), populate the database with an example cohort:

```sh
npm run seed --workspace=packages/server
```

This generates a Gradescope export (~700 students across three assignments, with a
deliberate spread of paste and cross-submission flags) and runs it through the real ingest
pipeline into an isolated `seed-demo` semester. The ingest takes a few minutes. To view it
in the analyzer, add your Google email to `AUTH_SUPERADMIN_EMAILS` in
`packages/server/.env` and sign in. The export ZIP is committed
(`packages/server/scripts/seed/example-gradescope-export.zip`) for manual upload too.
Details and the `--regenerate` flag are in [`packages/server/README.md`](packages/server/README.md).

### Ingesting submissions

Course staff ingest a Gradescope "Download Submissions" export, which fans out into one
submission per student through the pipeline (roster upsert → match → heuristics →
cross-flags). There are two ways in, both producing identical results:

- **HTTP upload** — the analyzer's Ingest page, or `POST /semesters/:id/ingest:gradescope`.
  The primary path. The upload is streamed to disk (not buffered in memory), so it handles
  multi-GB exports; the analyzer uploads files ≥ 1 GiB **resumably** (chunked) so an
  interrupted transfer continues instead of restarting.
- **Local-path CLI** — `npm run ingest:local` reads an export **directly from the server's
  disk** via a streaming reader, with memory bounded to a single submission bundle. Best
  when a very large export (10 GB+) already lives on the server — instant, no upload.

See [`packages/server/README.md`](packages/server/README.md#ingesting-submissions) for the
full ingest guide, plus the dev tooling for generating large test fixtures (`gen:fixture`)
and profiling the pipeline (`profile:ingest`, `profile:large`).

### Run the analyzer frontend

Requires the workspace to have been built at least once (`npm run build` from the
repo root — see [Quickstart](#quickstart--development-environment)), since the
analyzer imports `log-core` / `shared` / `analysis-core` from their `dist/` output.

```sh
npm run dev --workspace=packages/analyzer
```

Visit `http://localhost:5173`. Sign in with a Google account in `AUTH_ALLOWED_HOSTED_DOMAINS`.

### Offline / local mode (no server required)

Visit `http://localhost:5173/local/load` and drop a `.zip` bundle. No authentication
is required, and it runs entirely in-browser — no data leaves your machine.

### Run the recorder extension

Open this repo in VS Code and press Fn + F5 (or pick **"Run Recorder Extension"** in the
Run & Debug panel). A second VS Code window opens with `test-workspace/` loaded; the
status bar shows "Provenance: recording".

For richer recorder instructions see [`docs/recorder.md`](docs/recorder.md).
The student-facing description that ships with the VSIX lives at
[`packages/recorder/README.md`](packages/recorder/README.md).

### Documentation

- [`docs/admin-guide.md`](docs/admin-guide.md) — hosting, Google OAuth setup, retention policy, backups, restore drill
- [`docs/api-quickstart.md`](docs/api-quickstart.md) — Python and curl examples for the v3 API
- [`packages/server/README.md`](packages/server/README.md) — server-specific dev instructions

## Repo layout

```
provenance/
├── docs/
│   ├── prd.md                          # recorder product spec
│   ├── analyzer-v3-prd.md              # analyzer product spec
│   ├── admin-guide.md                  # hosting + operations guide
│   └── api-quickstart.md               # Python + curl API examples
├── packages/
│   ├── log-core/              # shared event types, hash chain, format
│   ├── recorder/              # VS Code extension
│   ├── shared/                # Zod API schemas shared by server + analyzer
│   ├── analyzer/              # React/Vite SPA frontend
│   └── server/                # Node.js + Hono API server
├── tools/                     # dev scripts (key generation, manifest signing)
├── test-workspace/            # sample student workspace for dev & integration tests
├── compose.yaml               # Docker Compose for Postgres + MinIO
├── CLAUDE.md                  # repo conventions for Claude Code
└── package.json               # npm workspace root
```

## Architecture rules (enforced)

- `packages/log-core` has zero runtime dependencies on VS Code, Node-only APIs, or the DOM. It's pure TypeScript that runs in any JS environment. An ESLint `no-restricted-imports` rule on `packages/log-core/**/*.ts` rejects `vscode`, `node:*`, `fs`, `path`, `worker_threads`, `crypto` imports.
- `packages/recorder` depends on `log-core`, `vscode`, and a small fixed set of approved libraries (`@noble/ed25519`, `@noble/hashes`, `@noble/ciphers`, `canonicalize`, `jszip`). The packaged VSIX is ESM (requires VS Code ≥ 1.100, where the extension host loads ESM entry points via `import()`).
- The log file format is the contract between recorder and analyzer. It's specified in PRD §5 and pinned with test vectors in `packages/log-core/src/hash-chain.test.ts`.

## Common commands

| Command                                                  | What it does                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run build`                                          | TypeScript build for both packages.                                               |
| `npm run test`                                           | Vitest unit tests across all workspaces (~1200 total).                            |
| `npm run typecheck`                                      | `tsc --noEmit` across the workspace.                                              |
| `npm run lint`                                           | ESLint + Prettier check.                                                          |
| `npm run package:recorder`                               | Build the VSIX (`.vsix` file) for local installation.                             |
| `npm run test:integration --workspace packages/recorder` | Download VS Code 1.120 and run integration tests against the real Extension Host. |
| `npm run bench --workspace packages/recorder`            | Run the SessionWriter perf benchmark (p99 should be << 1ms).                      |

## Course staff: key & manifest workflow

The recorder verifies every `.provenance-manifest` manifest through a two-level trust
chain (Manifest 2.0; full design in
[`docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`](docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md) §2–§3):

```
  root keypair            (maintainer; offline; once, ever; NEVER signs a manifest)
        │ signs
        ▼
  course_cert             { course_id, course_pubkey, valid_from, valid_until }
        │ authorizes
        ▼
  course keypair          (course staff; signs .provenance-manifest files)
        │ signs
        ▼
  .provenance-manifest
```

The recorder embeds only the **root** public key — one VSIX build serves every course.
A course's authority comes entirely from its root-signed `course_cert`, which travels
**inline** inside every manifest that course signs, not from anything baked into the
extension. `format_version: "1.0"` manifests (no trust chain, no `course_cert`) remain
permanently supported for archived submissions; everything below produces 2.0 unless
you pass `--format 1.0`.

**The root private key is the highest-value secret in this system.** It transitively
authorizes every course, past and future. Generate it once, offline, on a secured
machine, exactly like a course keypair below — never inside this repo, never emailed,
never logged. A dev root keypair is checked into `.notes/dev-root-keypair.json`
(git-excluded, deliberately public/insecure) purely so local development and the test
fixtures under `test-workspace/` have something to sign against; it must never be used
for a real deployment.

### 1. Root keypair (once, ever, offline)

Generate it the same way `tools/generate-course-keypair.ts` generates a course
keypair (it's the same ed25519 keypair shape — `{ public_key_hex, private_key_hex }`)
on an air-gapped or otherwise hardened machine, and back up the private key to
physical media. There is currently no dedicated root-keypair-generation tool beyond
that — the maintainer runs the same offline procedure once.

### 2. Course keypair + certificate (per course, at onboarding)

**Generate the course keypair** (once per course, on a secured machine):

```sh
node --experimental-strip-types tools/generate-course-keypair.ts /Volumes/SECURE/cs61a-fa26.json
```

The public key is printed to stdout. The private key is written to the chosen path
with mode `0600`. Back it up to physical media.

**Mint the course's certificate**, using the ROOT keypair (typically a separate step
run by whoever holds the root key, not by course staff):

```sh
node --experimental-strip-types tools/mint-course-cert.ts \
  --course-id berkeley-cs61a --course-pubkey <64-hex-from-generate-step> \
  --valid-from 2026-08-20 --valid-until 2027-01-15 \
  --root-keypair /Volumes/SECURE/root-keypair.json \
  --out /Volumes/SECURE/cs61a-fa26.cert.json
```

Keep the validity window short (one semester) — an offline recorder cannot learn about
key revocation, so a short window is the only mitigation. The certificate is
self-verified against the root public key before being written; a tool that hands out
a certificate that fails its own check is worse than no tool.

`tools/generate-course-keypair.ts` can also do both steps in one run — pass
`--course-id`, `--valid-from`, `--valid-until` (and optionally `--root-keypair` /
`--cert-out`) alongside the output path — whenever the same machine holds both keys.

### 3. Manifest signing (per assignment)

**Author the unsigned `.provenance-manifest`** in the assignment starter folder. Drop
this file at the workspace root the students will open:

```json
{
  "assignment_id": "hw03",
  "semester": "fa26",
  "issued_at": "2026-09-15T00:00:00Z",
  "files_under_review": ["hw03.py"],
  "course_id": "berkeley-cs61a",
  "collaboration": "solo",
  "submission": "bundle",
  "scope": "directory",
  "policy": {
    "capture": {
      "selection_change": true,
      "focus_change": true,
      "terminal": true,
      "doc_open_close": true,
      "inline_content": true,
      "heartbeat_interval_ms": 30000
    }
  }
}
```

Field rules (enforced by `parseManifest` / `parseManifestValue` in
`packages/log-core/src/manifest.ts`):

- `assignment_id` — non-empty string, unique per assignment. Rotating it per assignment is what prevents replay of an old session against a new assignment (PRD §6).
- `semester` — non-empty string, e.g. `"fa26"`.
- `issued_at` — non-empty ISO 8601 UTC timestamp.
- `files_under_review` — array of workspace-relative paths. Only files in this list get the in-memory expected-content model used for external-change detection (PRD §4.5). Other files are still recorded for workspace context.
- `course_id` — MUST equal the `course_id` inside the certificate you sign with, or the manifest will fail its own chain check (program spec §3 step 3).
- `collaboration` / `submission` / `scope` — `"solo" | "group"`, `"bundle" | "git"`, `"directory" | "repo"`.
- `policy.capture` — the professor-facing capture controls (program spec §4). A course can turn capture down; a student cannot turn it off, because this block is inside the course-signed payload. Omit keys you don't want to change from the default (everything on, 30s heartbeat).

Omit `sig` and `course_cert`; the signer adds both. (If you re-sign an already-signed manifest, the old `sig`/`course_cert` are stripped first.)

**Sign it**:

```sh
PROVENANCE_COURSE_KEYPAIR_PATH=/Volumes/SECURE/cs61a-fa26.json \
PROVENANCE_COURSE_CERT_PATH=/Volumes/SECURE/cs61a-fa26.cert.json \
  node --experimental-strip-types tools/sign-manifest.ts /path/to/assignment-starter/.provenance-manifest
```

The tool signs with the course private key, staples the certificate inline, then
**self-verifies the full trust chain** (`verifyManifestChain`, root → cert → manifest)
before writing anything to disk — it refuses to write a manifest that would not
itself verify. Pass `--format 1.0` to emit the legacy shape instead (no `course_id` /
`collaboration` / `submission` / `scope` / `policy` / `course_cert` — just the four
original fields), which log-core continues to support permanently.

### Production VSIX (root key — one build serves every course)

```sh
PROVENANCE_ROOT_PUBLIC_KEY_HEX=<the maintainer's root public key> \
  npm run build:prod --workspace packages/recorder
```

`build:prod` embeds the **root** public key (via `tools/embed-root-key.ts`), builds,
packages a VSIX, then restores the source file so further local work uses the dev key.
Unlike the old per-course-key model, this is done **once per root-key rotation, not
once per course** — a course's authority is entirely in its `course_cert`, which the
VSIX never needs to know about ahead of time. The script refuses to run if the env var
is missing, malformed, or matches the dev root key, so a misconfigured release can
never silently ship a dev VSIX.

Optionally also set `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX` (the grandfathered
single course key from before the root-key hierarchy) if this build still needs to
activate against Manifest 1.x files in the field:

```sh
PROVENANCE_ROOT_PUBLIC_KEY_HEX=<the maintainer's root public key> \
PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX=<the old course public key> \
  npm run build:prod --workspace packages/recorder
```

It's optional and only needed while 1.x manifests are still in the field; omitting it
produces a VSIX that will not activate on 1.x manifests (2.0 only). See
`legacy-course-public-key.ts` for the removal condition once every course has
re-issued as 2.0.

**Refresh the analyzer's known-good extension-hash list** so a new VSIX won't trip
`extension_hash_mismatch`:

```sh
npm run update-hashes -- --root-keypair /Volumes/SECURE/root-keypair.json
```

This reads `public_key_hex` from the root keypair JSON, runs the same `build:prod`
pipeline as above, and adds the resulting VSIX's `extension_hash` to the allowlist.
If `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX` is set in the environment, it's passed
through to the build the same way — but note that embedding the legacy key changes
the built `dist/` and therefore the hash, so a build with it set produces a different
hash than one without. The script always hashes whatever `dist/` the build it just
ran actually produced, so the recorded hash is correct for that variant; to allowlist
both a 1.x-compatible and a 2.0-only VSIX, run the script twice, once with the var
set and once without.

Other modes: `--show` (print current list), `--no-build` (hash an already-bundled
`dist/`), `--hash <hex>` / `--remove <hex>` (manual entries), `--clear`, `--help`.

See [`docs/recorder.md`](docs/recorder.md) for the full security model and what the recorder defends against.

## License

Provenance is licensed under the [Apache License, Version 2.0](LICENSE). See [`NOTICE`](NOTICE).

The recorder VSIX, the analyzer SPA bundle, and the deployed server each redistribute a
number of third-party open-source packages. Their licenses and copyright notices are
listed in [`THIRD-PARTY-NOTICES.txt`](THIRD-PARTY-NOTICES.txt).

## Trademarks & third-party services

Provenance is an independent project and is not affiliated with, endorsed by, or
sponsored by Microsoft, Google, or Turnitin.

- **Visual Studio Code** is a trademark of Microsoft Corporation. The recorder
  (`packages/recorder`) is a VS Code extension; it is not produced or endorsed by
  Microsoft.
- **Google** and the Google logo are trademarks of Google LLC. The analyzer and server
  use "Sign in with Google" (Google OAuth) for authentication; Provenance is not
  produced or endorsed by Google.
- **Gradescope** is a trademark of Turnitin, LLC. The server includes an optional
  ingest path for Gradescope autograder exports (`packages/server/src/services/ingest/gradescope/`);
  Provenance is not produced or endorsed by Turnitin.

All other trademarks are the property of their respective owners.
