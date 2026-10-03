# Events-less storage, provenance-only bundles, and the `analysis-core` package

- **Date:** 2026-07-01
- **Status:** Approved (design) — implementing
- **Scope:** `packages/server`, `packages/analyzer`, new `packages/analysis-core`, `packages/shared` (only if API shapes change)
- **Not deployed anywhere yet** → no data backfill, no reversibility scaffolding, no dual-write period. We move straight to the clean end state.

## Motivation

Two storage costs dominate (see memory: `project_cost_model`, `project_ingest_profiling`):

1. The Postgres `events` table holds one row per recorded event, per submission, forever. It is never purged. It is the single largest cost driver.
2. Every stored bundle blob contains the student's raw source files in addition to the `.provenance` logs.

Neither is strictly necessary. All analysis (stats, validation, per-submission heuristics, and cross-flags) is computed at ingest time from the in-memory parsed bundle. The `.slog` provenance logs already contain the full event stream, and file content at any point in time can be reconstructed from those events. So we can:

1. **Stop storing event rows.** Compute everything at ingest as we do today, persist only the _derived_ results, and re-parse the bundle from S3 on demand for the rare read paths that need raw events (replay, recompute, cross-flag recompute, the events/timeline API, session listing).
2. **Stop storing raw source files.** After all ingest-time computation (including hash-chain and manifest-signature verification, which need the source bytes in-memory for check 8), strip the source bytes from the bundle before writing it to its final key. Keep the signed `manifest.json` + `manifest.sig` + `.slog`/`.slog.meta` logs.

While doing this, we also fix a standing architecture violation: the server currently imports analyzer source directly (contrary to `CLAUDE.md`). We extract the shared analysis logic into a new package, `packages/analysis-core`, that both `analyzer` and `server` depend on.

## Goals

- No event rows in Postgres. `events` table dropped.
- Stored bundle blobs contain no student source bytes; only `manifest.json`, `manifest.sig`, `*.slog`, `*.slog.meta`.
- All existing read behavior preserved (timeline API, replay/reconstruction, recompute, cross-flags, validation, stats, Source tab) — served by re-parsing the stored bundle on demand instead of reading Postgres event rows.
- Server no longer imports `packages/analyzer` source. Shared analysis code lives in `packages/analysis-core`, depended on by both.
- Green: `npm run build`, `npm run typecheck`, `npm run lint`, `npm run test`.

## Non-goals

- No change to the recorder, the log file format, the hash chain, or the manifest contents/signature. **The manifest is signed and MUST NOT be modified.**
- No change to the HTTP API _shapes_ unless forced (see §6). If forced, both ends change in one diff.
- No data backfill (nothing deployed).
- No change to retention semantics beyond the fact that there are no longer event rows to (not) purge, and stored blobs are now smaller.

---

## Part 1 — `packages/analysis-core` (shared analysis package)

### What moves

From `packages/analyzer/src/` into `packages/analysis-core/src/` (verbatim, preserving internal relative imports):

- `loader/` — `parse-bundle.ts` (`loadBundle`), `parse-session.ts`, `unzip.ts`, `types.ts` (`Bundle`, `ParsedSession`, `LoaderError`, `SessionParseError`).
- `validation/` — `run-validation.ts` (`runValidation`), `check-types.ts` (`ValidationReport`), all eight `verify-*.ts` checks (incl. `verify-submitted-code.ts` exporting `submittedFileVerdicts`).
- `index/` — `build-index.ts` (`buildIndex`), `event-index.ts` (`EventIndex`, `IndexedEvent`), `stats.ts` (`computeStats`), `reconstruct-file.ts`, `reconstruct-file-provenance.ts` (`reconstructFileWithProvenance`, `ProvenanceKind`), `provenance-utils.ts`.
- `heuristics/` — `run-heuristics.ts` (`runHeuristics`), `config.ts` (`DEFAULT_HEURISTIC_CONFIG`, `HeuristicConfig`), `types.ts` (`Severity`), `candidate-pastes.ts`, all 20 per-submission heuristic modules, `cross/` (`features.ts`, `run-cross-heuristics.ts`, `types.ts` `CrossSubmissionFeatures`, and the cross heuristic modules), and `config/` data files (`ai-extension-list.json`, `known-good-extension-hashes.json`) + `config-schemas.test.ts`.
- `extensions/detect-ai-extension.ts` (+ its `.test.ts`) — the only non-UI file in `src/extensions/`. Its React siblings (`ActiveExtensionsCard.tsx`, `collect-active-extensions.ts`) stay in analyzer.
- Test helper `test/helpers/build-test-bundle.ts` → `packages/analysis-core/test/helpers/build-test-bundle.ts` (pure; used by both analyzer and server tests).

The closure is fully self-contained: nothing in it imports React, the DOM, Vite specifics, or `node:*`/`fs`/`path`/`crypto`/`process`. Verified. So it compiles and runs unchanged in both browser and Node.

### Package shape

`packages/analysis-core/package.json`, mirroring `log-core`/`shared`:

- `"name": "@provenance/analysis-core"`, `"type": "module"`, `"version": "1.0.0"`, `"private": true`.
- `"main"`/`"types"`/`"exports"` → `./dist/index.js` + subpath exports. Provide subpath exports mirroring the internal structure so consumers can import narrowly, plus a barrel `index.ts` re-exporting the public API (`loadBundle`, `runValidation`, `submittedFileVerdicts`, `buildIndex`, `computeStats`, `reconstructFileWithProvenance`, `runHeuristics`, `DEFAULT_HEURISTIC_CONFIG`, cross-feature exports, and the shared types).
- `"scripts": { "build": "tsc -p tsconfig.json" }`.
- `dependencies`: `@provenance/log-core: "*"`, `jszip`, `diff`, `@noble/ed25519`. `devDependencies`: `@types/diff`, `@noble/hashes` (test helper), `vitest`.
- `tsconfig.json` extends `tsconfig.base.json` (NodeNext, like log-core/shared), `outDir: ./dist`, `rootDir: ./src`, `include: ["src/**/*"]`. **Not** Bundler resolution — this must type-check for Node.
- Keep `.js` extension specifiers in relative imports (repo convention under NodeNext).

### Wiring

- Add `"@provenance/analysis-core": "*"` to both `analyzer` and `server` `package.json`.
- Repoint every server import listed in the surface map from `@provenance/analyzer/src/...` (and `@provenance/analyzer/test/helpers/build-test-bundle.js`) to `@provenance/analysis-core` (barrel or subpath).
- Repoint analyzer's own imports of the moved modules from relative paths / `@/loader` etc. to `@provenance/analysis-core`.
- Remove `"@provenance/analyzer": "*"` from `server` `package.json` once no server import references analyzer.
- Root build: analysis-core builds via `npm run build --workspaces` like the other leaf packages. Ensure it builds _before_ analyzer/server consume its `dist/` — the repo builds packages independently and server/analyzer resolve via workspace symlinks; add analysis-core `dist` build to the standard flow (leaf libs build to `dist`; server uses `tsx`/`esbuild --packages=external`, analyzer uses Vite — both resolve the package's `exports`).

### Verification for Part 1 (behavior-preserving refactor)

`npm run build && npm run typecheck && npm run lint && npm run test` all green with **no** behavior change. This is the checkpoint before touching storage.

---

## Part 2 — Events-less storage

### Ingest changes

- **Delete phase 6 `materializeEvents`** and its call in `packages/server/src/jobs/worker.ts`. Remove `packages/server/src/services/ingest/materialize-events.ts` (+ test). Phases 7–9 (stats, validation, heuristics) already consume the in-memory `bundle`/`index` and are unaffected.

### New central read service — `loadSubmissionIndex`

`packages/server/src/services/bundle/load-index.ts` (new):

```
loadSubmissionIndex(db, storage, submissionId)
  -> { bundle: Bundle, index: EventIndex }
```

- Looks up `submissions.blob_object_key` (+ `blob_sha256`), `getBlob`, `loadBundle`, `buildIndex`.
- Wrapped in an **LRU cache keyed by `submissionId + blob_sha256`** (bounded entries; reuse/generalize the existing LRU in `reconstruction.ts`). `blob_sha256` in the key means a re-ingested/superseded blob invalidates naturally.
- This replaces `reconstructBundleFromDb` as the source of the parsed bundle for all later reads.

### Read-path rewiring (Postgres `events` → `loadSubmissionIndex`)

1. `services/heuristics/reconstruct-bundle.ts` `reconstructBundleFromDb` → reimplement on top of `loadSubmissionIndex` (or delete and have callers call it directly). Note: it previously produced a `Bundle` with an empty `submissionFiles` map; `loadSubmissionIndex` produces a real `Bundle` from the stored (source-stripped) blob, whose `submissionFiles` will be empty/hash-mismatched for stripped files — fine, because reconstruction and heuristics use events, not source bytes.
2. `services/reconstruction.ts` (file replay) → use `loadSubmissionIndex`.
3. `services/scoring/recompute-submission.ts` (per-submission recompute) → use `loadSubmissionIndex` instead of `reconstructBundleFromDb`.
4. `services/events/query.ts` (`GET /submissions/:id/events`, `/:seq`) → build results from the in-memory `index` (filter by kind / seq / t / wall / path / session_id; cursor-paginate in memory), **preserving the existing response and cursor contract** in `packages/shared`. This is the largest single rewrite.
5. `services/heuristics/extract-cross-features-from-db.ts` → rename/refactor to extract from the parsed `index` (the analyzer already has a pure `cross/features.ts extractCrossFeatures(index)` in analysis-core; use it). `services/heuristics/run-cross.ts` iterates the semester's submissions and calls `loadSubmissionIndex` per submission (cache-assisted). N S3 gets + N parses per semester recompute — acceptable for a background job; documented.
6. `services/submissions/summary.ts` session list → derive from `bundle.manifest.sessions[]` (or the parsed sessions) via `loadSubmissionIndex`, not `SELECT DISTINCT session_id FROM events`.

### Schema / migration

- New Drizzle migration (hand-authored SQL, per repo convention — see memory `project_drizzle_snapshots`): `DROP TABLE IF EXISTS events CASCADE;` (drops its indexes too). Remove the `events` table definition from `packages/server/src/db/schema.ts` and any exported types/relations referencing it.
- Grep for every remaining reference to the `events` Drizzle table object and remove/rewire.

---

## Part 3 — Provenance-only bundles (strip source)

### Where and how

In `packages/server/src/services/ingest/create-submission.ts`, the blob is currently moved from `ingest-staging/...` to `semesters/.../bundle.zip` via `getBlob → putBlob → deleteBlob`. Replace the verbatim copy with a **strip step**:

- New helper `packages/server/src/services/ingest/strip-bundle.ts`: given the staging bundle ZIP bytes, produce a new ZIP containing **only** `manifest.json`, `manifest.sig`, and every `*.slog` / `*.slog.meta` entry. Drop all other (source) entries. Deterministic zipping (stable order, no timestamps that vary) so the output is reproducible.
- `putBlob` the stripped ZIP to the final key. Store the **stripped** blob's sha256 in `submissions.blob_sha256` (that column describes the object actually at the key). `deleteBlob` the staging blob.
- **Safe ordering:** validation check 8 (`submitted_code_match`) runs in phase 8 against the _in-memory_ full bundle parsed in phase 3 — it never reads the stored blob. So stripping the stored blob in phase 5 does not affect any ingest-time computation. The manifest still lists `submission_files[]` with their `sha256`; we do not touch it, so the signature stays valid and checks 1–7 remain verifiable on the stored bundle.
- **Consequence:** re-running check 8 against a _stored_ (stripped) bundle would fail (bytes absent). We never re-run validation post-ingest (recompute re-runs only heuristics). Documented explicitly.

### Source tab (analyzer) — reconstruct from events

`packages/server/src/services/submissions/submitted-files.ts` currently `loadBundle`s the blob and returns raw submitted bytes + live `submittedFileVerdicts`. After stripping, raw bytes are gone. Change:

- **Content** endpoint (`.../submitted-files/:path/content` and the file list): serve the file **reconstructed from events** at its final state (last `doc.save` for that path), via `loadSubmissionIndex` + `reconstructFileWithProvenance`. Include a **taint indicator** when reconstruction is incomplete (chain gaps / missing seed).
- **Verdicts** (per-file `submitted_code_match` status): served from the **stored ingest-time result** rather than recomputed live. Implementation checkpoint: confirm `validation_results.detail` already persists per-file check-8 verdicts; if it does not, extend what phase 8 stores so the Source tab can render the verdict without raw bytes. Persisting derived verdict data is consistent with the "compute at ingest, store derived" principle.
- Preserve the endpoint response shape where possible; if the verdict fields must change, update `packages/shared` + the analyzer Source-tab view in the same diff.

### Bundle download (`include_blobs`)

`GET /submissions/:id/bundle` now presigns a **provenance-only** bundle. This is a privacy improvement (no student source leaves the system). Note it in `docs/admin-guide.md` / API docs.

---

## §6 API contract impact

- Timeline events API: unchanged shape, different backing store. Cursor semantics preserved.
- Bundle download: same shape, smaller/provenance-only content.
- Submitted-files/Source tab: prefer unchanged shape (reconstructed content + stored verdict). If unavoidable, change `packages/shared` schema + analyzer in one diff.

## Testing

- **Part 1:** existing suites pass unchanged after the move (proves behavior-preserving). Update import paths in moved tests; keep assertions.
- **Delete** `materialize-events.test.ts`.
- **Ingest e2e:** assert (a) no `events` table / no event rows anywhere, (b) the stored bundle contains no source entries but **still signature-verifies** (manifest + sig + logs intact, checks 1–7 pass), (c) validation check 8 still ran and its result is stored (computed pre-strip).
- **Read paths:** timeline API, reconstruction/replay, per-submission recompute, and cross-flag recompute all produce identical results against an events-less DB (parse-from-blob). Add regression tests that would fail if a read path still queried `events`.
- **Source tab:** returns reconstructed content and the stored verdict; taint indicator set when reconstruction is incomplete.
- **strip-bundle:** unit test — output contains exactly the provenance entries, is deterministic, and re-parses via `loadBundle`.
- Server integration tests keep using testcontainers (Postgres + MinIO); never point at dev compose.

## Risks / tradeoffs (on the record)

- **Cold-read latency:** each read path parses a bundle from S3; mitigated by the `loadSubmissionIndex` LRU cache. Cross-flag recompute does N gets/parses per semester (background job) — acceptable, documented.
- **Loss of authoritative submitted bytes:** the Source tab now shows reconstructed content; tainted reconstructions are best-effort. The check-8 verdict (computed at ingest, bytes present) still records whether submitted == recorded.
- **Manifest untouched by design:** stored bundles remain signature/chain-verifiable; only check 8 is non-re-runnable post-strip, and we never re-run it.
- **Architecture rule restored:** server no longer imports analyzer source; the shared closure lives in `analysis-core`. `CLAUDE.md`'s dependency rules should be updated to name `analysis-core`.

## Build order

1. Create `analysis-core`, move the closure, rewire analyzer + server imports, drop `server → analyzer` dep. Verify green (no behavior change).
2. Add `loadSubmissionIndex` + cache; rewire read paths off `events`.
3. Drop phase 6 + `events` table (migration + schema).
4. Add `strip-bundle`; strip on store; switch Source tab to reconstruction; persist verdicts if needed.
5. Update tests, docs (`admin-guide`, API docs, `CLAUDE.md` dependency rules). Full green.
