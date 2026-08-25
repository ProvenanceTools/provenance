# Monorepo scope selection: `/local` picker + provgate per-assignment scoping

**Date:** 2026-08-23
**Status:** Design, approved in chat; not yet planned or implemented
**Repos touched:** `provenance` (analysis-core, analyzer, server imports, architecture page),
`provenance-gradescope-gateway` (provgate)

## 1. Problem

CS 61B/61C students keep every assignment as a subdirectory of one large monorepo. At
submission time the course pulls the **entire** monorepo into Gradescope and grades only the
relevant folder. Each assignment directory carries its own recording, so one submitted tree
looks like:

```
proj2/.provenance/…   proj2/Gitlet.java
lab5/.provenance/…    lab5/Lab5.java
proj1/.provenance/…   proj1/…
README.md
```

Ingesting that export today fans out **one submission per sealed scope** — ten assignments in
the tree means ten submissions, nine of them noise for the assignment actually being graded.

We want to ingest only the relevant folder, on two surfaces:

- **provgate**, so the automated Gradescope→Provenance sync sends the right scope per assignment.
- **The analyzer's `/local` route**, so staff dropping a monorepo zip can pick which recording
  to analyze.

## 2. What already exists (do not rebuild)

This is most of the feature. The server side is **already built and needs no behavior change.**

- `IngestScopeConfig` (`server/src/services/ingest/gradescope/repo-scopes.ts:129`) has four
  modes: `self_identifying` (default), `bundle_zip`, `repo_whole`, `repo_scoped`.
  `repo_scoped` + `path_glob` selects scopes by directory and is exactly this feature.
- All three ingest entry points accept a **per-request override**:
  - `POST /semesters/:sid/ingest` — query params (`routes/ingest.ts:389`)
  - `POST /semesters/:sid/ingest:gradescope` — query params (`routes/ingest.ts:754`)
  - `POST /semesters/:sid/ingest/uploads/:uid/complete` — `ingest_scope` JSON body
    (`routes/ingest.ts:1353`)

  Query form: `?scope_mode=repo_scoped&scope_path_glob=proj2/**&scope_on_multiple=ingest_all`

- `ingestLocalPath` already takes `ingestScopeOverride` (`local-path.ts:109`).
- `IngestJobStatusResponse.skipped` already carries `GradescopeSkippedEntry[] | null`
  (`shared/src/api-schemas.ts:621`), so excluded scopes are already reportable to a client.
- Scope discovery is well tested (`repo-scopes.test.ts`, ~15 cases on `repo_scoped` alone).

### 2.1 Why the persisted per-assignment default does not solve this

`assignments.ingest_scope` exists and looks like the natural home for a glob. It is not, and
this is non-obvious enough to be worth recording.

`resolveRepoScopes`'s path-glob pass looks up config **per scope, keyed by that scope's own
declared `assignment_id`** (`repo-scopes.ts:498-500`). Setting `proj2`'s persisted config to
`repo_scoped, proj2/**` therefore excludes nothing: `lab5/` resolves to _lab5's_ config, which
is the `self_identifying` default, and is accepted anyway. Excluding the other nine would mean
setting a deliberately-non-matching glob on every other assignment in the semester.

The **per-request override** is the correct mechanism: its resolver ignores the key
(`routes/ingest.ts:438`), so every scope in the tree sees the same declaration.

The folder-level mode assertion (`folderConfig`, `repo-scopes.ts:450`) is resolved from
`scopes[0]` — the lexicographically first scope — which is arbitrary in a monorepo. That is
fine for `bundle_zip`/`repo_whole` and irrelevant under an override, but it is another reason
not to route this through the persisted default.

## 3. Decisions

| #   | Decision                                                                        | Rationale                                                                                                                                       |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `/local` shows a **scope picker**, not a glob dry-run tool and not auto-fan-out | Solves the stated problem with the least surface; `/local` needs discovery, not policy                                                          |
| D2  | provgate sends **`path_glob` on the wire**, derived from the assignment id      | Zero server change; `repo_scoped` already does exactly this                                                                                     |
| D3  | provgate keys config on a **per-`(class, gs_assignment)` mapping row**          | Unmapped assignments send no override ⇒ existing classes provably unaffected                                                                    |
| D4  | Move **discovery** to `analysis-core`; **policy stays in the server**           | `/local` needs `discoverRepoScopes`, not `IngestScopeConfig`; keeps the API-contract vocabulary server-side                                     |
| D5  | No new `IngestScopeConfig` mode                                                 | An `assignment_pinned` mode (select by signed manifest's declared id, robust to renames) was considered and rejected as unnecessary given D2/D3 |

D5 is worth revisiting if courses turn out to move or rename assignment directories between
semesters — pinning by declared `assignment_id` is more robust than a path glob, at the cost of
a versioned change to `IngestScopeConfigSchema`, the server, tests, and `/architecture`.

## 4. Design

### 4.1 Package move: discovery → `analysis-core`

The importers of `repo-scopes.ts` split into two groups wanting different things:

- **Discovery** — `discoverRepoScopes`, `RepoScope`, `selectBundleEntries`, `zipBundleEntries`,
  `BundleEntry`. Pure; imports only `jszip` and `@provenance/log-core`, both already permitted
  in `analysis-core`. Wanted by `parse-export.ts`, `stream-export.ts`, `repo-zip.ts`, and — new
  — `/local`.
- **Policy** — `IngestScopeConfig`, `parseIngestScopeConfig`, `resolveRepoScopes`,
  `IngestScopeConfigResolver`, `DEFAULT_INGEST_SCOPE`. Bound to `packages/shared`'s API contract
  and to a Drizzle column. Wanted by the routes, `scope-config.ts`, `cohort/assignments.ts`.

**Move discovery only.** New `packages/analysis-core/src/scopes/`:

- `discover-scopes.ts` — `discoverRepoScopes`, `provenanceScopePrefix`, `scopeIdentity`,
  `isJunkPath`, `RepoScope`, `DiscoverRepoScopesResult` (moved verbatim)
- `select-entries.ts` — the whole of `build-bundle-zip.ts` (moved verbatim)
- co-located tests, moved with them

`server/.../repo-scopes.ts` shrinks to the policy half and imports `RepoScope` from
`@provenance/analysis-core`. `analysis-core` exposes them through its existing `./*.js` deep-path
exports map; no new export entries needed.

Blast radius: 10 non-test import sites for `repo-scopes`, 5 for `build-bundle-zip`, most of them
`import type`. `packages/shared` only _mentions_ `repo-scopes` in a docstring — no import — so
shared stays zod-only.

**Type split.** `UnusableScope.reason` currently mixes one discovery reason (`no_seal`) with
three policy reasons (`scope_excluded`, `ambiguous_scope`, `submission_type_mismatch`). After
the split:

- `analysis-core` exports `UnusableScope` with `reason: 'no_seal'`
- the server widens it to the four-reason union for `resolveRepoScopes`'s output

The wire vocabulary in `GradescopeSkippedEntrySchema` is unchanged.

**Rejected alternatives.** (a) A separate lightweight discovery implementation in the browser —
`repo-scopes.ts`'s own docstring calls single-implementation selection load-bearing, because
entry order fixes the rebuilt archive's byte layout and therefore the sha256 that is the ingest
dedup key. (b) `/local` slicing the zip in place without `selectBundleEntries` — diverges from
ingest's whitelist and macOS-junk rules, which is precisely wrong for the surface staff use to
understand what ingest did.

This move is a **no-behavior-change refactor** and should land as its own PR.

### 4.2 `/local` scope picker

Today `/local` calls `loadBundle` directly on the dropped `File`
(`analyzer/src/context/BundleContext.tsx:36`), which requires a flat sealed bundle. A monorepo
zip fails in `unzipBundle`.

The picker needs a user decision mid-load, so it cannot live inside `loadBundleFiles` (a promise
that resolves once). **Two-phase load, leaving the existing pipeline untouched:**

**Phase A — inspect (new module, `analyzer/src/lib/inspect-dropped-files.ts`).** For each
dropped file, apply the same name-only predicate `repo-zip.ts:160` uses: does any non-junk entry
sit under a `.provenance/` directory? A flat sealed bundle fails the test and passes through
unchanged. A repo-shaped zip goes to `discoverRepoScopes`.

**Phase B — resolve.**

- Every dropped file yielded exactly one candidate ⇒ load immediately. **Zero UX change for
  every existing workflow**, including the multi-file "load N bundles for cross-flags" case.
- Any file yielded more than one ⇒ render the picker. On confirm, `zipBundleEntries` each
  selected scope into a synthetic `File` named `<stem>/<scope>.zip` (`new File([ab], name)` —
  `loadBundleFiles` reads `.name` for the bundle label), and hand those to the existing,
  unmodified `loadBundleFiles`.

**State lives in `BundleContext`, not `LoadView`.** `status` already drives the routing guards
(`RequireLocalBundle` redirects on `status !== 'loaded'`), so a new `'choosing'` status is
handled correctly by guards that already exist. New context surface:

```ts
status: … | 'choosing'
pendingScopes: PendingScope[] | null
chooseScopes(selected: string[]): Promise<void>
cancelChoice(): void
```

**Picker contents.** Per scope: `scopePath`, `declaredAssignmentId`, `declaredSemester`,
session count, approximate event count, total bytes.

- Session count and bytes are free from the discovered `BundleEntry[]`.
- **Event counts are line counts, not parsed events.** Discovery already inflates every file into
  memory, so counting `\n` bytes in the `.slog` entries is a linear scan with no JSON parsing and
  no `buildIndex`. NDJSON is one event per line, so it is exact except for a torn tail or a
  trailing blank line. Render as `~4.1k events`. The alternative — real counts — means fully
  parsing all ten scopes to display a number for the one scope about to be picked.

**Multi-select, nothing pre-selected**, "Analyze selected" disabled until at least one is chosen.
Keeps the ≥2-bundle cross-flags path reachable.

Unsealed directories discovered as `no_seal` are listed greyed-out and unselectable rather than
hidden, so a student whose recording never sealed is visible rather than absent.

### 4.3 provgate

New table, following the existing idempotent `CREATE TABLE IF NOT EXISTS` style in
`store/db.py` (provgate has no migration framework and does not need one here):

```sql
CREATE TABLE IF NOT EXISTS assignment_scopes (
    class_id                 INTEGER NOT NULL,
    gs_assignment_id         TEXT NOT NULL,
    provenance_assignment_id TEXT NOT NULL,
    path_glob                TEXT,        -- NULL = derive from provenance_assignment_id
    PRIMARY KEY (class_id, gs_assignment_id)
);
```

Derivation: `path_glob or f"{provenance_assignment_id}/**"`, sent as
`mode=repo_scoped, on_multiple=ingest_all`.

**No row ⇒ no override ⇒ byte-identical behavior to today.** This is the entire migration story:
existing classes and flat-bundle classes cannot be affected by this change.

**Both wire paths need it**, and the chunked one is the one that will actually run — a monorepo
export will exceed the 16 MB `ingest_chunk_threshold_bytes` routinely:

- `_ingest_single` → query params on `POST …/ingest:gradescope`
- `_complete_upload` → `{"s3_upload_id": …, "ingest_scope": {…}}`

Threading: `repository` → `sync/engine.py` → `ProvenanceClient.ingest_gradescope_export(…,
scope: IngestScope | None = None)` → the two request builders.

**CLI:** `provgate assignment-scope set|list|unset`, mirroring the existing class-management
commands.

```
provgate assignment-scope set --class cs61b-fa26 --gs-assignment 409194023 --assignment-id proj2
```

**Reporting (required, not optional).** `JobStatus` gains `skipped: list[SkippedEntry]`, read
from the existing `IngestJobStatusResponse.skipped`. The run summary and webhook render surface
per-reason counts. Without this, a typo'd glob is indistinguishable from a quiet cohort; with it,
it reads as "300 submissions, 300 scope_excluded, 0 ingested".

### 4.4 The glob limitation (sharpest edge in this design)

`globToRegExp` (`repo-scopes.ts:284`) supports only `*` and `**`. There is **no brace
expansion**, so no single derived glob matches both a root-level and a nested assignment
directory:

| glob          | regex           | `proj2/`              | `projects/proj2/` |
| ------------- | --------------- | --------------------- | ----------------- |
| `proj2/**`    | `^proj2/.*$`    | ✅                    | ❌                |
| `**/proj2/**` | `^.*/proj2/.*$` | ❌ (no leading slash) | ✅                |

61B/61C put assignments at the repo root, so deriving `{id}/**` is correct for the target
courses. The nullable `path_glob` column exists precisely so a course with a nested layout can
override the derivation.

`**proj2/**` (`^.*proj2/.*$`) does match both, but also matches `myproj2/` and `notproj2/`. It is
a footgun and must not be the derived default.

This is the failure mode most likely to bite in production, which is why §4.3's reporting
requirement is not optional.

### 4.5 `/architecture`

A required same-PR update (CLAUDE.md). This change hits three listed triggers: ingest module
ownership moving packages, an analyzer route's flow changing, and the read path for a dropped
bundle gaining a step. `content/nodes/ingest.ts` already references `repo-scopes` and goes stale
the moment the module moves; `nodes.coverage.test.ts` fails rather than letting it rot.

Edit the relevant `tools/architecture/dot/*.dot`, run
`python3 tools/architecture/build_diagrams.py`, then author node detail in
`content/nodes/<diagram>.ts` keyed by the bare dot node name.

## 5. Testing

- **Package move:** existing `repo-scopes.test.ts` / `build-bundle-zip.test.ts` move with their
  modules and must pass unchanged. That they pass unchanged _is_ the assertion that the move is
  behavior-preserving. Add an `analysis-core` isomorphism check (the ESLint
  `no-restricted-imports` rule already covers `node:*`/`fs`/`path`; the suite must run in the
  jsdom environment).
- **`/local`:** unit tests for the inspect module (flat bundle → passthrough; repo zip → N
  candidates; junk-only `.provenance/` → passthrough; unsealed dir → `no_seal` candidate).
  Component tests for the picker (renders on >1 candidate, does not render on exactly 1, disabled
  confirm with empty selection). A regression test asserting a single flat bundle still loads
  with no picker, since that is the path every existing user takes.
- **provgate:** repository round-trip; derivation (`None` → `{id}/**`, explicit glob wins);
  engine sends the override on both single and chunked paths; unmapped assignment sends no
  override (the safety property — assert the request has no `scope_*` params at all); job-status
  parsing of `skipped`; render includes per-reason counts.
- **Cross-repo:** one end-to-end check that a glob derived by provgate selects the intended
  scope in `resolveRepoScopes`. Belongs in `provenance` as a fixture test — provgate cannot
  import TypeScript — asserting `{id}/**` matches `{id}/` for a representative id set.

## 6. Out of scope

- Any new `IngestScopeConfig` mode (see D5).
- Server behavior changes. The only server edits are import paths from §4.1.
- A glob dry-run / preview UI in `/local` (considered, rejected as D1).
- Changing `globToRegExp` to support brace expansion. If nested layouts become common, that is a
  separate, self-contained change to the glob grammar plus its tests.
- Auto-deriving `provenance_assignment_id` from a Gradescope assignment title.

## 7. Sequencing

Three PRs, in order:

1. **`provenance`** — package move (§4.1). Mechanical, no behavior change, lands alone so the
   behavior PRs have a clean diff.
2. **`provenance`** — `/local` picker (§4.2) + `/architecture` (§4.5).
3. **`provenance-gradescope-gateway`** — per-assignment scoping (§4.3).

PR 3 is independent of 1 and 2 and can land in parallel; it needs no `provenance` change.

Rough effort: ½ day + 1 day + ½ day (architecture) + 1 day ≈ **3 days**.
