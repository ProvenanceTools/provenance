# Events-less storage + provenance-only bundles + analysis-core Implementation Plan

> **For agentic workers:** Implement task-by-task. Each task ends green (build + typecheck + lint + test where scoped). Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stop persisting Postgres event rows and stop storing raw student source bytes, while extracting the shared analysis logic into a new `@provenance/analysis-core` package that both analyzer and server depend on.

**Architecture:** All analysis already runs at ingest on the in-memory parsed bundle; we persist only derived results and re-parse the stored bundle from S3 on demand for the few read paths that need raw events. Stored bundles keep the signed manifest + `.slog` logs and drop source bytes. The shared loader/validation/index/heuristics closure moves out of analyzer into `analysis-core`.

**Tech Stack:** TypeScript (NodeNext), Vitest, Drizzle/Postgres, Hono, S3 (MinIO in tests via testcontainers), JSZip, `@noble/ed25519`, `diff`.

## Global Constraints

- **Manifest is signed — never modify `manifest.json` / `manifest.sig`.** Strip source bytes only.
- Nothing is deployed → no backfill, no dual-write, no reversibility scaffolding.
- `log-core` stays pure (no vscode/node/DOM/crypto imports). `analysis-core` must run in both browser and Node (no `node:*`/`fs`/`path`/`crypto`/React/DOM/Vite specifics).
- Hand-authored SQL migrations only (repo convention; Drizzle snapshots intentionally incomplete — do not backfill them).
- Relative imports use `.js` extension specifiers (NodeNext).
- Commits: `git commit --no-gpg-sign`, conventional-commit prefixes, no `Co-Authored-By` trailer. Commit per task.
- Contracts: HTTP API shapes in `packages/shared` and the log format are contracts — preserve shapes; if a shape must change, change both ends in one diff.
- Verify commands (run from repo root):
  - `npm run typecheck`
  - `npm run lint`
  - `npm run test` (Docker must be running for server integration tests)
  - `npm run build`

---

## PART 1 — analysis-core extraction (behavior-preserving)

### Task 1: Scaffold `@provenance/analysis-core`

**Files:**

- Create: `packages/analysis-core/package.json`
- Create: `packages/analysis-core/tsconfig.json`
- Create: `packages/analysis-core/src/index.ts` (temporary empty barrel)

**Interfaces:**

- Produces: workspace package `@provenance/analysis-core` building to `dist/` with an `exports` map.

- [ ] **Step 1:** Write `package.json` mirroring `packages/log-core/package.json`:

```json
{
  "name": "@provenance/analysis-core",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./loader": { "types": "./dist/loader/index.d.ts", "import": "./dist/loader/index.js" },
    "./validation": {
      "types": "./dist/validation/index.d.ts",
      "import": "./dist/validation/index.js"
    },
    "./index-core": { "types": "./dist/index/index.d.ts", "import": "./dist/index/index.js" },
    "./heuristics": {
      "types": "./dist/heuristics/index.d.ts",
      "import": "./dist/heuristics/index.js"
    }
  },
  "scripts": { "build": "tsc -p tsconfig.json" },
  "dependencies": {
    "@provenance/log-core": "*",
    "@noble/ed25519": "<copy version from analyzer package.json>",
    "diff": "<copy version from analyzer package.json>",
    "jszip": "<copy version from analyzer package.json>"
  },
  "devDependencies": {
    "@noble/hashes": "<copy version from analyzer/log-core>",
    "@types/diff": "<copy version from analyzer>",
    "vitest": "<copy version from analyzer>"
  }
}
```

- [ ] **Step 2:** Write `tsconfig.json` mirroring `packages/shared/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3:** Create `src/index.ts` with `export {};` (placeholder; filled in Task 2).
- [ ] **Step 4:** `npm install` at repo root to link the workspace. Run `npm run build --workspace=packages/analysis-core`. Expected: builds an (empty) `dist/`.
- [ ] **Step 5:** Commit: `chore(analysis-core): scaffold shared analysis package`.

### Task 2: Move the shared closure into analysis-core

**Files (move with `git mv`, from `packages/analyzer/src/` → `packages/analysis-core/src/`):**

- `loader/` (all), `validation/` (all), `index/` (all), `heuristics/` (all incl. `cross/`, `config/`), `extensions/detect-ai-extension.ts` (+ `.test.ts`).
- `packages/analyzer/test/helpers/build-test-bundle.ts` → `packages/analysis-core/test/helpers/build-test-bundle.ts`.
- Create barrels: `src/index.ts`, `src/loader/index.ts`, `src/validation/index.ts`, `src/index/index.ts`, `src/heuristics/index.ts`.

**Interfaces:**

- Produces (public API re-exported from `src/index.ts`): `loadBundle`, types `Bundle`, `ParsedSession`, `LoaderError`, `SessionParseError`; `runValidation`, `submittedFileVerdicts`, type `ValidationReport`; `buildIndex`, `computeStats`, `reconstructFileWithProvenance`, types `EventIndex`, `IndexedEvent`, `ProvenanceKind`; `runHeuristics`, `DEFAULT_HEURISTIC_CONFIG`, types `HeuristicConfig`, `Severity`; `extractCrossFeatures`, `runCrossHeuristics`, type `CrossSubmissionFeatures`; `detectAiExtension`.

- [ ] **Step 1:** `git mv` each directory/file above. The closure's internal relative imports (e.g. `heuristics/run-heuristics.ts` → `../index/event-index.js`) stay valid because relative structure is preserved. `extensions/detect-ai-extension.ts` is referenced by `heuristics/ai-extension-active.ts` as `../extensions/detect-ai-extension.js` — preserved.
- [ ] **Step 2:** Fix any `@/`-alias imports inside the moved files (analyzer used `@/*` → `./src/*`). Grep the moved tree: `grep -rn "@/" packages/analysis-core/src`. Rewrite each to a relative `.js` specifier.
- [ ] **Step 3:** Write the barrels. `src/index.ts` re-exports the public API from the subpath barrels; each subpath `index.ts` re-exports its dir's public symbols (values + types). Example `src/loader/index.ts`:

```ts
export { loadBundle } from './parse-bundle.js';
export type { Bundle, ParsedSession, LoaderError, SessionParseError } from './types.js';
```

Mirror for validation/index/heuristics. `src/index.ts`:

```ts
export * from './loader/index.js';
export * from './validation/index.js';
export * from './index/index.js';
export * from './heuristics/index.js';
export { detectAiExtension } from './extensions/detect-ai-extension.js';
export type { AiDetection } from './extensions/detect-ai-extension.js';
```

(If `export *` produces type/name collisions across dirs, switch the colliding barrel to explicit named re-exports.)

- [ ] **Step 4:** `npm run build --workspace=packages/analysis-core`. Fix any resolution/type errors until it builds clean. Expected: `dist/` now contains loader/validation/index/heuristics/extensions.
- [ ] **Step 5:** `npm run test --workspace=packages/analysis-core` (moved co-located tests + `config-schemas.test.ts` + `detect-ai-extension.test.ts` run here now). Expected: PASS. (Add a minimal `vitest.config.ts` only if the package needs one — copy analyzer's if tests don't discover.)
- [ ] **Step 6:** Commit: `refactor(analysis-core): move loader/validation/index/heuristics closure out of analyzer`.

### Task 3: Repoint analyzer imports to analysis-core

**Files:** every analyzer file that imported the moved modules (relative or `@/loader` etc.); `packages/analyzer/package.json`.

- [ ] **Step 1:** Add `"@provenance/analysis-core": "*"` to `packages/analyzer/package.json` dependencies. `npm install`.
- [ ] **Step 2:** Grep analyzer for imports of moved paths: `grep -rn -e "loader/" -e "validation/" -e "src/index/" -e "heuristics/" -e "extensions/detect-ai-extension" packages/analyzer/src | grep import`. Repoint each to `@provenance/analysis-core` (barrel) or a subpath export. The `/local` route and replay/timeline views are the heaviest consumers.
- [ ] **Step 3:** Repoint analyzer test imports (incl. `test/helpers/build-test-bundle` now in analysis-core) to `@provenance/analysis-core`.
- [ ] **Step 4:** `npm run typecheck` and `npm run test --workspace=packages/analyzer`. Expected: PASS. `npm run build --workspace=packages/analyzer` (Vite) succeeds.
- [ ] **Step 5:** Commit: `refactor(analyzer): consume analysis-core instead of local analysis modules`.

### Task 4: Repoint server imports; drop server→analyzer dependency

**Files:** the ~20 server files importing `@provenance/analyzer/src/...` (per surface map); `packages/server/package.json`.

- [ ] **Step 1:** Add `"@provenance/analysis-core": "*"` to `packages/server/package.json`. `npm install`.
- [ ] **Step 2:** Repoint every server import from `@provenance/analyzer/src/...js` and `@provenance/analyzer/test/helpers/build-test-bundle.js` to `@provenance/analysis-core` (barrel/subpath). Files include: `jobs/worker.ts`, `services/ingest/{parse-bundle-phase,validation,stats,materialize-events}.ts`, `services/heuristics/{reconstruct-bundle,run-per-submission,run-cross,extract-cross-features-from-db,default-config}.ts`, `services/scoring/recompute-submission.ts`, `services/reconstruction.ts`, `services/provenance-rle.ts`, `services/submissions/submitted-files.ts`, `api/v1/routes/{cohort,cross-flags}.ts`, `services/cohort/list.ts`, `services/cross-flags/{detail,list}.ts`, `services/scoring/{compute,denorm,dry-run}.ts`, and all server test files importing `buildTestBundle`.
- [ ] **Step 3:** Remove `"@provenance/analyzer": "*"` from `packages/server/package.json`. Verify no server import references `@provenance/analyzer`: `grep -rn "@provenance/analyzer" packages/server` → empty. `npm install`.
- [ ] **Step 4:** Full green: `npm run typecheck && npm run lint && npm run test && npm run build`. This is the **Part 1 checkpoint** — identical behavior, server decoupled from analyzer.
- [ ] **Step 5:** Commit: `refactor(server): consume analysis-core; drop dependency on analyzer source`.

---

## PART 2 — Events-less reads + drop events table

### Task 5: `loadSubmissionIndex` + LRU cache

**Files:**

- Create: `packages/server/src/services/bundle/load-index.ts`
- Test: `packages/server/src/services/bundle/load-index.test.ts`
- Reference existing LRU in `packages/server/src/services/reconstruction.ts` (generalize or reuse its cache utility).

**Interfaces:**

- Produces: `loadSubmissionIndex(db, storage, submissionId: string): Promise<{ bundle: Bundle; index: EventIndex }>`. Throws a typed not-found if the submission or blob is missing. Cache key = `${submissionId}:${blob_sha256}`.

- [ ] **Step 1:** Write failing test: seed a submission row with a known `blob_object_key`/`blob_sha256`, put a bundle blob in the test storage, assert `loadSubmissionIndex` returns an index whose event count matches the bundle, and that a second call hits the cache (spy on `getBlob` call count == 1).
- [ ] **Step 2:** Run it — FAIL (module missing).
- [ ] **Step 3:** Implement: select `blob_object_key`, `blob_sha256` from `submissions`; check LRU by key; on miss `getBlob` → `loadBundle` → `buildIndex`, store, return. Bound the cache (e.g. max 32 entries) with the existing LRU pattern.
- [ ] **Step 4:** Run test — PASS.
- [ ] **Step 5:** Commit: `feat(server): add loadSubmissionIndex bundle-parse cache`.

### Task 6: Rewire reconstruction/recompute off the events table

**Files:** `services/heuristics/reconstruct-bundle.ts`, `services/reconstruction.ts`, `services/scoring/recompute-submission.ts`; their tests.

**Interfaces:**

- Consumes: `loadSubmissionIndex` (Task 5).

- [ ] **Step 1:** Update `reconstruct-bundle.ts`: replace the `events`-table SELECT in `reconstructBundleFromDb(db, submissionId)` with `loadSubmissionIndex(db, storage, submissionId)` (thread `storage` through its callers). Keep the returned shape (`{ bundle, index, ... }`) stable for callers. Where it previously also read `flags`/`validation_results`, keep those DB reads.
- [ ] **Step 2:** Update `reconstruction.ts` and `recompute-submission.ts` to obtain `index`/`bundle` via the updated path (pass `storage`). Remove now-dead `events`-table query code.
- [ ] **Step 3:** Update the existing tests to seed a blob (not event rows). Run the affected suites — PASS.
- [ ] **Step 4:** Commit: `refactor(server): serve reconstruction and recompute from stored bundle, not events table`.

### Task 7: Rewire events/timeline API to in-memory index

**Files:** `services/events/query.ts` (`queryEvents`, `getEventBySeq`); `api/v1/routes/events.ts`; tests.

**Interfaces:**

- Consumes: `loadSubmissionIndex`. Preserves the `packages/shared` events response + cursor schema exactly.

- [ ] **Step 1:** Read `packages/shared` events schema + `query.ts` to capture the exact response fields, filters (kind, seq/t/wall ranges, path via `payload.path`, session_id), and cursor semantics.
- [ ] **Step 2:** Update the existing events-query tests to seed a bundle blob instead of event rows; assertions on shape/ordering/cursor unchanged (these encode the contract — do not weaken).
- [ ] **Step 3:** Reimplement `queryEvents`/`getEventBySeq` over `loadSubmissionIndex(...).index`: map indexed events to the response DTO, apply filters, sort by `seq`, apply cursor + limit in memory. Match prior ordering/cursor exactly.
- [ ] **Step 4:** Run events API + service tests — PASS.
- [ ] **Step 5:** Commit: `refactor(server): serve events API from stored bundle`.

### Task 8: Rewire cross-flag feature extraction

**Files:** `services/heuristics/extract-cross-features-from-db.ts` → replace with extraction from `index` (use analysis-core `extractCrossFeatures`); `services/heuristics/run-cross.ts`; tests.

**Interfaces:**

- Consumes: `loadSubmissionIndex`, `extractCrossFeatures` (analysis-core).

- [ ] **Step 1:** Update `run-cross.ts`: for each submission id in the semester, `loadSubmissionIndex` → `extractCrossFeatures(index)` (the pure analyzer function) → same `CrossSubmissionFeatures` used before. Remove `extract-cross-features-from-db.ts` (or reduce it to a thin adapter that only pulls non-event metadata still needed).
- [ ] **Step 2:** Update `recompute-cross-flags` tests to seed blobs; assert identical `cross_flags` + `cross_flag_participants` output. Run — PASS.
- [ ] **Step 3:** Commit: `refactor(server): compute cross-flags from stored bundles, not events table`.

### Task 9: Rewire submission summary session list

**Files:** `services/submissions/summary.ts`; test.

- [ ] **Step 1:** Replace `SELECT DISTINCT session_id FROM events` with the session list from `loadSubmissionIndex(...).bundle.manifest.sessions` (or parsed sessions). Preserve the summary response shape.
- [ ] **Step 2:** Run summary tests — PASS.
- [ ] **Step 3:** Commit: `refactor(server): derive summary session list from bundle manifest`.

### Task 10: Delete phase 6 + drop the events table

**Files:** `jobs/worker.ts` (remove phase 6 call + `materializeEvents` import), delete `services/ingest/materialize-events.ts` + `.test.ts`; `db/schema.ts` (remove `events` table + relations/types); new migration `db/migrations/00NN_drop_events.sql`.

- [ ] **Step 1:** Grep for remaining references to the `events` Drizzle table object: `grep -rn "\bevents\b" packages/server/src/db packages/server/src/services | grep -i event` — ensure only intended removals remain.
- [ ] **Step 2:** Remove the phase-6 `materializeEvents` call from the worker transaction; delete the module + test.
- [ ] **Step 3:** Remove the `events` table definition (and any `eventsRelations`/exported row types) from `db/schema.ts`.
- [ ] **Step 4:** Add hand-authored migration `db/migrations/00NN_drop_events.sql` (next number in sequence): `DROP TABLE IF EXISTS events CASCADE;`. Wire it into the migration list the same way existing SQL migrations are registered.
- [ ] **Step 5:** `npm run typecheck` (catches any lingering `events` references). Run the full server suite — PASS (integration tests apply the new migration on the ephemeral Postgres).
- [ ] **Step 6:** Commit: `feat(server)!: stop materializing events; drop events table`.

---

## PART 3 — Provenance-only bundles + Source tab

### Task 11: `strip-bundle` helper

**Files:**

- Create: `packages/server/src/services/ingest/strip-bundle.ts`
- Test: `packages/server/src/services/ingest/strip-bundle.test.ts`

**Interfaces:**

- Produces: `stripBundleSourceFiles(zipBytes: Uint8Array): Promise<Uint8Array>` — returns a new ZIP containing only `manifest.json`, `manifest.sig`, and every `*.slog` / `*.slog.meta` entry, deterministically ordered.

- [ ] **Step 1:** Write failing test: build a bundle zip (via analysis-core `buildTestBundle`) that includes source files; run `stripBundleSourceFiles`; assert the output entries are exactly the manifest/sig/slog/meta set (no source paths), that `loadBundle(output)` succeeds, and that `runValidation` checks 1–7 still pass on it (manifest sig + chain intact). Assert determinism: stripping twice yields byte-identical output.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement with JSZip: load input, create a new `JSZip`, copy only entries whose name is `manifest.json`, `manifest.sig`, or ends with `.slog`/`.slog.meta`; generate with fixed options (`{ type: "uint8array", compression, streamFiles: false }` and stable date) for deterministic bytes.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit: `feat(server): add stripBundleSourceFiles helper`.

### Task 12: Strip source when persisting the bundle

**Files:** `services/ingest/create-submission.ts`; its test.

**Interfaces:**

- Consumes: `stripBundleSourceFiles` (Task 11).

- [ ] **Step 1:** Update the failing test for `create-submission`: after ingest, the object at `semesters/.../bundle.zip` contains no source entries but re-parses/validates (checks 1–7). Assert `submissions.blob_sha256` equals the sha256 of the **stripped** blob.
- [ ] **Step 2:** In the blob-move step, replace the verbatim `getBlob → putBlob` with `getBlob(staging) → stripBundleSourceFiles → putBlob(final, stripped)`; compute and store the stripped blob's sha256 into `submissions.blob_sha256`; `deleteBlob(staging)`. Do not touch the in-memory `bundle` used by phases 6–9 (it retains source bytes for check 8).
- [ ] **Step 3:** Run `create-submission` + ingest e2e — PASS.
- [ ] **Step 4:** Commit: `feat(server): store provenance-only bundles (strip source files)`.

### Task 13: Source tab reconstruction + verdict persistence

**Files:** `services/submissions/submitted-files.ts`; `services/ingest/validation.ts` (persist per-file check-8 verdicts if not already in `validation_results.detail`); possibly `packages/shared` + analyzer Source view; tests.

**Interfaces:**

- Consumes: `loadSubmissionIndex`, `reconstructFileWithProvenance`, stored `validation_results.detail`.

- [ ] **Step 1 (checkpoint):** Read `validation.ts` + `verify-submitted-code.ts` (`submittedFileVerdicts`) and the `validation_results` schema. Determine whether per-file submitted-code verdicts are already persisted in `detail`. If yes → reuse. If no → extend phase-8 storage to persist them (append to `detail` JSON; no schema change if `detail` is `jsonb`).
- [ ] **Step 2:** Update `submitted-files.test.ts`: content is served reconstructed from events (no raw bytes needed), verdict comes from stored data, taint indicator present when reconstruction incomplete. Preserve the endpoint response shape (update `packages/shared` + analyzer together only if a field must change).
- [ ] **Step 3:** Reimplement `submitted-files.ts`: replace `loadBundle`+raw-bytes with `loadSubmissionIndex` + `reconstructFileWithProvenance` for content; read verdicts from `validation_results.detail`. Set taint flag from reconstruction result.
- [ ] **Step 4:** If the response shape changed, update `packages/shared` schema and the analyzer Source-tab view in this same commit; run analyzer typecheck/tests.
- [ ] **Step 5:** Run submitted-files + affected analyzer tests — PASS.
- [ ] **Step 6:** Commit: `feat: serve Source tab from reconstruction; persist submitted-code verdicts`.

### Task 14: Docs + final green

**Files:** `docs/admin-guide.md`, API docs (`docs/api-quickstart.md` / OpenAPI notes if the bundle content is described), `CLAUDE.md` (dependency rules), `README.md` status table if it references event storage.

- [ ] **Step 1:** `docs/admin-guide.md`: note that stored bundles are provenance-only (no student source), that events are not persisted (replay/recompute re-parse the bundle), and retention still deletes blobs only.
- [ ] **Step 2:** `CLAUDE.md`: update the architecture rules — server no longer imports analyzer; add `analysis-core` (depends on `log-core` + `shared`; consumed by both analyzer and server). Note the manifest-strip invariant.
- [ ] **Step 3:** Update any doc/README lines claiming the `events` table is the replay source of truth.
- [ ] **Step 4:** Full green: `npm run typecheck && npm run lint && npm run test && npm run build`.
- [ ] **Step 5:** Commit: `docs: describe events-less storage, provenance-only bundles, analysis-core`.

---

## Self-review notes

- **Spec coverage:** Part 1 (Tasks 1–4) = analysis-core extraction; Part 2 (Tasks 5–10) = events-less reads + drop table; Part 3 (Tasks 11–13) = strip + Source tab; Task 14 = docs. Every spec section maps to a task.
- **Checkpoint gates:** Task 4 (refactor green, no behavior change) and Task 10 (events gone) and Task 12 (bundles stripped) are the three riskiest gates.
- **Contract care:** Tasks 7 and 13 explicitly preserve `packages/shared` shapes; only Task 13 may touch shared, with both ends in one commit.
- **Open checkpoint:** Task 13 Step 1 resolves whether verdict persistence needs a storage change; no blocking ambiguity elsewhere.
