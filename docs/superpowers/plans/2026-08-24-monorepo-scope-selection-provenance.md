# Monorepo Scope Selection (provenance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff drop a monorepo repo zip on the analyzer's `/local` route and pick which assignment recording to analyze, by moving scope *discovery* out of the server and into `analysis-core` where the browser can reach it.

**Architecture:** Scope discovery (`discoverRepoScopes`, `selectBundleEntries`, `zipBundleEntries`) is pure and isomorphic but currently lives in `packages/server`. Move it to `packages/analysis-core/src/scopes/`, leaving ingest *policy* (`IngestScopeConfig`, `resolveRepoScopes`) in the server. Then `/local` gains a two-phase load: inspect dropped files for repo shape, show a picker when a file holds more than one sealed scope, rebuild the chosen scopes into flat bundle zips, and hand them to the existing unmodified load pipeline.

**Tech Stack:** TypeScript (strict, `exactOptionalPropertyTypes`), npm workspaces, Vitest (jsdom), React 19 + React Testing Library, JSZip, Graphviz (dev-time, for `/architecture`).

**Spec:** `docs/superpowers/specs/2026-08-23-monorepo-scope-selection-design.md` — read §4.1, §4.2 and §4.5 before starting.

## Global Constraints

- **No server behavior change.** The only server edits in this plan are import paths and the type split. If you find yourself changing what the ingest pipeline *does*, stop — that is out of scope.
- **`analysis-core` must stay isomorphic.** An ESLint `no-restricted-imports` rule rejects `vscode`, `node:*`, `fs`, `path`, `worker_threads`, `crypto` in `packages/analysis-core/**/*.ts`. The moved code already complies (it imports only `jszip` and `@provenance/log-core`, both already `analysis-core` dependencies). Do not add imports that break this.
- **`analysis-core` tests run under jsdom** (`environment: 'jsdom'`, `globals: true`). JSZip reads a `Blob` via `FileReader`, which only exists under jsdom.
- **Consumers import `analysis-core` by package name, never by reaching into `src/`.** The `exports` map has a `./*.js` wildcard, so `@provenance/analysis-core/scopes/discover-scopes.js` resolves with no `package.json` change.
- **Relative imports use explicit `.js` extensions** (ESM/NodeNext).
- **Per-workspace test scoping.** Do NOT run the root `npm run test` — it spins up the server's testcontainers suites and overloads the machine when other work is running. Run only the touched workspaces:
  - `npm run test --workspace=packages/analysis-core`
  - `npm run test --workspace=packages/analyzer`
  - `npm run test --workspace=packages/server`
- **Typecheck/lint gates:** `npm run typecheck` and `npm run lint` from the repo root (lint covers all five `src/` trees plus a repo-wide Prettier check).
- **Commit with `git commit --no-gpg-sign`**, conventional-commit prefixes, **explicit pathspec** (never `git add -A` — the tree often carries unrelated parallel work). No `Co-Authored-By` trailer.
- **Never `git stash`.** `refs/stash` is repo-wide, not per-worktree, and another agent's pop can steal your entry.
- Current branch is `feat/manifest-2.0-trust-chain`. Stay on it; commit incrementally.

---

## File Structure

**Created:**
- `packages/analysis-core/src/scopes/select-entries.ts` — bundle-entry whitelist + zip rebuild (moved from server `build-bundle-zip.ts`)
- `packages/analysis-core/src/scopes/select-entries.test.ts` — moved with it
- `packages/analysis-core/src/scopes/discover-scopes.ts` — walk a tree, find every sealed `.provenance/` scope (moved from server `repo-scopes.ts`)
- `packages/analysis-core/src/scopes/discover-scopes.test.ts` — the discovery half of `repo-scopes.test.ts`
- `packages/analyzer/src/lib/inspect-dropped-files.ts` — Phase A: is this file repo-shaped, and what scopes does it hold?
- `packages/analyzer/src/lib/inspect-dropped-files.test.ts`
- `packages/analyzer/src/views/load/ScopePicker.tsx` — the picker UI
- `packages/analyzer/src/views/load/ScopePicker.test.tsx`

**Deleted:**
- `packages/server/src/services/ingest/gradescope/build-bundle-zip.ts` (+ its test — both move)

**Modified:**
- `packages/server/src/services/ingest/gradescope/repo-scopes.ts` — shrinks to the policy half
- `packages/server/src/services/ingest/gradescope/repo-scopes.test.ts` — policy tests stay, discovery tests move
- 10 server import sites (see Task 2 Step 5)
- `packages/analyzer/src/context/BundleContext.tsx` — `'choosing'` status, `pendingScopes`, `chooseScopes`, `cancelChoice`
- `packages/analyzer/src/views/load/LoadView.tsx` — render the picker when `status === 'choosing'`
- `packages/analyzer/src/views/architecture/content/nodes/ingest.ts`, `.../master.ts` — stale paths + `/local` behavior
- `tools/architecture/dot/master.dot` — `local` node label

---

### Task 1: Move `build-bundle-zip.ts` to `analysis-core/scopes/select-entries.ts`

**Files:**
- Create: `packages/analysis-core/src/scopes/select-entries.ts`, `packages/analysis-core/src/scopes/select-entries.test.ts`
- Delete: `packages/server/src/services/ingest/gradescope/build-bundle-zip.ts`, `build-bundle-zip.test.ts`
- Modify: 5 server import sites

**Interfaces:**
- Consumes: `parseRollingManifestFilename` from `@provenance/log-core` (unchanged).
- Produces, from `@provenance/analysis-core/scopes/select-entries.js`, all identical to today:
  - `interface BundleEntry { name: string; data: Uint8Array }`
  - `type SelectBundleEntriesResult = { ok: true; entries: BundleEntry[] } | { ok: false; reason: 'no_manifest' }`
  - `type BuildBundleZipResult = { ok: true; data: ArrayBuffer } | { ok: false; reason: 'no_manifest' }`
  - `selectBundleEntries(files: Map<string, Uint8Array>): SelectBundleEntriesResult`
  - `zipBundleEntries(entries: BundleEntry[]): Promise<ArrayBuffer>`
  - `buildBundleZipFromFiles(files: Map<string, Uint8Array>): Promise<BuildBundleZipResult>`
  - `buildBundleZipForFolder(outer: JSZip, folderPrefix: string): Promise<BuildBundleZipResult>`

  Tasks 2, 3 and 5 depend on `BundleEntry`, `selectBundleEntries` and `zipBundleEntries`.

**This is a pure move. The moved test passing unchanged IS the assertion that behavior is preserved.** Do not "improve" anything while moving it.

- [ ] **Step 1: Move both files with git, preserving history**

```bash
mkdir -p packages/analysis-core/src/scopes
git mv packages/server/src/services/ingest/gradescope/build-bundle-zip.ts \
       packages/analysis-core/src/scopes/select-entries.ts
git mv packages/server/src/services/ingest/gradescope/build-bundle-zip.test.ts \
       packages/analysis-core/src/scopes/select-entries.test.ts
```

- [ ] **Step 2: Fix the import in the moved test**

In `packages/analysis-core/src/scopes/select-entries.test.ts`, change the import of the module under test from `./build-bundle-zip.js` to `./select-entries.js`. Change nothing else in that file.

- [ ] **Step 3: Run the moved test to verify it passes in its new home**

Run: `npm run test --workspace=packages/analysis-core -- select-entries`

Expected: PASS, same assertions as before the move. If anything fails, the move was not clean — revert and retry rather than editing assertions.

- [ ] **Step 4: Update the 5 server import sites**

Replace the relative import with the package import in each:

| File | Old specifier | New specifier |
|---|---|---|
| `services/ingest/repo-zip.ts` | `./gradescope/build-bundle-zip.js` | `@provenance/analysis-core/scopes/select-entries.js` |
| `services/ingest/local-path.ts` | `./gradescope/build-bundle-zip.js` | `@provenance/analysis-core/scopes/select-entries.js` |
| `services/ingest/gradescope/parse-export.ts` | `./build-bundle-zip.js` | `@provenance/analysis-core/scopes/select-entries.js` |
| `services/ingest/gradescope/rebuild-pool.ts` | `./build-bundle-zip.js` | `@provenance/analysis-core/scopes/select-entries.js` |
| `services/ingest/gradescope/stream-export.ts` | `./build-bundle-zip.js` | `@provenance/analysis-core/scopes/select-entries.js` |

Also update the test files that import it (`rebuild-pool.test.ts`, `repo-zip.test.ts`, `stream-export.test.ts`, `repo-scopes.test.ts`) the same way. Keep the imported symbol lists exactly as they are.

- [ ] **Step 5: Typecheck, lint, and run both touched workspaces**

Run:
```bash
npm run typecheck
npm run lint
npm run test --workspace=packages/analysis-core
npm run test --workspace=packages/server
```

Expected: all green. The server suite uses testcontainers, so Docker must be running.

- [ ] **Step 6: Commit**

```bash
git add packages/analysis-core/src/scopes packages/server/src/services/ingest
git commit --no-gpg-sign -m "refactor(analysis-core): move bundle-entry selection out of the server"
```

---

### Task 2: Move scope discovery to `analysis-core/scopes/discover-scopes.ts`

**Files:**
- Create: `packages/analysis-core/src/scopes/discover-scopes.ts`, `packages/analysis-core/src/scopes/discover-scopes.test.ts`
- Modify: `packages/server/src/services/ingest/gradescope/repo-scopes.ts` (shrinks), `repo-scopes.test.ts` (discovery cases move out)
- Modify: `services/ingest/repo-zip.ts`, `gradescope/parse-export.ts`, `gradescope/stream-export.ts`

**Interfaces:**
- Consumes: `BundleEntry`, `selectBundleEntries` (Task 1).
- Produces, from `@provenance/analysis-core/scopes/discover-scopes.js`:

```ts
export interface RepoScope {
  scopePath: string;
  entries: BundleEntry[];
  declaredAssignmentId: string | null;
  declaredSemester: string | null;
}

/** A `.provenance/` sealed by nothing — the only issue DISCOVERY can report. */
export interface DiscoveredScopeIssue {
  scopePath: string;
  reason: 'no_seal';
}

export type DiscoverRepoScopesResult =
  | { ok: true; scopes: RepoScope[]; unusable: DiscoveredScopeIssue[] }
  | { ok: false; reason: 'no_manifest' };

export function discoverRepoScopes(files: Map<string, Uint8Array>): DiscoverRepoScopesResult;
export function isJunkPath(relPath: string): boolean;
export function provenanceScopePrefix(relPath: string): string | null;
```

`isJunkPath` and `provenanceScopePrefix` become **exported** (they are module-private today) because Task 3 needs the same junk rule and the same prefix rule in the browser — re-spelling either one is exactly the drift this move exists to prevent.

- The server's `repo-scopes.ts` keeps `IngestScopeMode`, `IngestScopeConfig`, `DEFAULT_INGEST_SCOPE`, `parseIngestScopeConfig`, `IngestScopeConfigResolver`, `UnusableScope` (widened to all four reasons), `ResolveRepoScopesResult`, `resolveRepoScopes`.

**Type split note:** `DiscoveredScopeIssue` is structurally assignable to the server's four-reason `UnusableScope`, so `repo-zip.ts`'s `toSkip: (u: UnusableScope) => ...` accepts `discovered.unusable` entries with no change.

- [ ] **Step 1: Create the new module**

Create `packages/analysis-core/src/scopes/discover-scopes.ts`. Move these verbatim out of `packages/server/src/services/ingest/gradescope/repo-scopes.ts`: the `PROVENANCE_DIR` and `MANIFEST_JSON` constants, `isJunkPath`, `provenanceScopePrefix`, `declaredIdentity`, `scopeIdentity`, the `RepoScope` interface, and the whole `discoverRepoScopes` function. Add `export` to `isJunkPath` and `provenanceScopePrefix`. Define `DiscoveredScopeIssue` and the new `DiscoverRepoScopesResult` as given in the Interfaces block above.

Imports at the top of the new file:

```ts
import { parseRollingManifestFilename } from '@provenance/log-core';
import { selectBundleEntries, type BundleEntry } from './select-entries.js';
```

Carry the explanatory comments across with the code — they are the reason the rules are the way they are. Add a module docstring explaining that discovery lives here (isomorphic, used by both server ingest and the analyzer's `/local`) while ingest POLICY stays in the server.

- [ ] **Step 2: Move the discovery tests**

Create `packages/analysis-core/src/scopes/discover-scopes.test.ts` and move every `describe`/`it` from `packages/server/src/services/ingest/gradescope/repo-scopes.test.ts` that exercises `discoverRepoScopes` (not `resolveRepoScopes`, not `parseIngestScopeConfig`). Point their imports at `./discover-scopes.js`. Leave the policy tests where they are.

- [ ] **Step 3: Run the moved tests**

Run: `npm run test --workspace=packages/analysis-core -- discover-scopes`

Expected: PASS, assertions unchanged.

- [ ] **Step 4: Shrink the server module**

In `repo-scopes.ts`, delete everything now living in `analysis-core` and import what the policy half still needs:

```ts
import type { RepoScope } from '@provenance/analysis-core/scopes/discover-scopes.js';
```

Widen the retained `UnusableScope`:

```ts
export interface UnusableScope {
  scopePath: string;
  reason: 'no_seal' | 'scope_excluded' | 'ambiguous_scope' | 'submission_type_mismatch';
}
```

Keep its full doc comment — all four reasons are still reported through this type at the wire boundary. Update the module docstring to say discovery now lives in `analysis-core` and this file is the policy half.

- [ ] **Step 5: Point the three discovery importers at analysis-core**

In `services/ingest/repo-zip.ts`, `gradescope/parse-export.ts` and `gradescope/stream-export.ts`, split the existing `repo-scopes.js` import: `discoverRepoScopes` / `RepoScope` / `DiscoverRepoScopesResult` come from `@provenance/analysis-core/scopes/discover-scopes.js`; `resolveRepoScopes`, `IngestScopeConfigResolver`, `UnusableScope` and the config types keep coming from `./repo-scopes.js` (adjust the relative path per file). Do the same in any test file that imports discovery symbols.

- [ ] **Step 6: Full gate**

Run:
```bash
npm run typecheck
npm run lint
npm run test --workspace=packages/analysis-core
npm run test --workspace=packages/server
```

Expected: all green. **If a server test fails, the move was not clean — do not weaken the assertion.** Tests encode requirements; find the real difference.

- [ ] **Step 7: Commit**

```bash
git add packages/analysis-core/src/scopes packages/server/src/services/ingest
git commit --no-gpg-sign -m "refactor(analysis-core): move scope discovery out of the server"
```

---

### Task 3: `inspectDroppedFiles` — Phase A of the `/local` load

**Files:**
- Create: `packages/analyzer/src/lib/inspect-dropped-files.ts`, `packages/analyzer/src/lib/inspect-dropped-files.test.ts`

**Interfaces:**
- Consumes: `discoverRepoScopes`, `isJunkPath`, `provenanceScopePrefix` (Task 2); `zipBundleEntries`, `BundleEntry` (Task 1).
- Produces:

```ts
export interface ScopeCandidate {
  /** `''` for the tree root, else a prefix ending in `/`. */
  scopePath: string;
  declaredAssignmentId: string | null;
  declaredSemester: string | null;
  sessionCount: number;
  /** Approximate: NDJSON line count, not parsed events. */
  approxEventCount: number;
  totalBytes: number;
  /** False for a `.provenance/` sealed by nothing — listed, not selectable. */
  selectable: boolean;
  entries: BundleEntry[];
}

export interface InspectedFile {
  file: File;
  /** null means not repo-shaped; load the file as-is. */
  candidates: ScopeCandidate[] | null;
}

export async function inspectDroppedFiles(files: File[]): Promise<InspectedFile[]>;
export async function candidateToFile(stem: string, c: ScopeCandidate): Promise<File>;
```

Task 4 calls both.

- [ ] **Step 1: Write the failing test**

Create `packages/analyzer/src/lib/inspect-dropped-files.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { inspectDroppedFiles, candidateToFile } from './inspect-dropped-files.js';

/** Minimal rolling-sealed scope at `prefix` (may be '' for the tree root). */
function addScope(zip: JSZip, prefix: string, assignmentId: string, slogLines: number): void {
  const sid = '11111111-1111-1111-1111-111111111111';
  zip.file(
    `${prefix}.provenance/manifest-${sid}.json`,
    JSON.stringify({ assignment_id: assignmentId, semester: 'fa26', submission_files: [] }),
  );
  zip.file(`${prefix}.provenance/manifest-${sid}.sig`, 'deadbeef');
  zip.file(
    `${prefix}.provenance/session-${sid}.slog`,
    Array.from({ length: slogLines }, (_, i) => `{"seq":${i}}`).join('\n'),
  );
  zip.file(`${prefix}.provenance/session-${sid}.slog.meta`, JSON.stringify({ session_id: sid }));
}

async function zipToFile(zip: JSZip, name: string): Promise<File> {
  const ab = await zip.generateAsync({ type: 'arraybuffer' });
  return new File([ab], name);
}

describe('inspectDroppedFiles', () => {
  it('returns null candidates for a flat sealed bundle', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ assignment_id: 'proj2', submission_files: [] }));
    zip.file('manifest.sig', 'deadbeef');
    zip.file('session-11111111-1111-1111-1111-111111111111.slog', '{"seq":0}');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'bundle.zip')]);
    expect(inspected!.candidates).toBeNull();
  });

  it('finds one candidate per sealed scope in a monorepo, sorted by path', async () => {
    const zip = new JSZip();
    addScope(zip, 'proj2/', 'proj2', 4);
    addScope(zip, 'lab5/', 'lab5', 2);
    zip.file('README.md', '# monorepo');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const candidates = inspected!.candidates!;
    expect(candidates.map((c) => c.scopePath)).toEqual(['lab5/', 'proj2/']);
    expect(candidates.map((c) => c.declaredAssignmentId)).toEqual(['lab5', 'proj2']);
  });

  it('counts sessions and approximates events from slog line counts', async () => {
    const zip = new JSZip();
    addScope(zip, 'proj2/', 'proj2', 4);
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const c = inspected!.candidates![0]!;
    expect(c.sessionCount).toBe(1);
    expect(c.approxEventCount).toBe(4);
    expect(c.totalBytes).toBeGreaterThan(0);
  });

  it('lists an unsealed .provenance/ as a non-selectable candidate', async () => {
    const zip = new JSZip();
    addScope(zip, 'proj2/', 'proj2', 2);
    zip.file('lab5/.provenance/notes.txt', 'nothing seals this');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const lab5 = inspected!.candidates!.find((c) => c.scopePath === 'lab5/')!;
    expect(lab5.selectable).toBe(false);
    expect(lab5.declaredAssignmentId).toBeNull();
  });

  it('treats an archive whose only .provenance entries are macOS junk as not repo-shaped', async () => {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ assignment_id: 'proj2', submission_files: [] }));
    zip.file('manifest.sig', 'deadbeef');
    zip.file('session-11111111-1111-1111-1111-111111111111.slog', '{"seq":0}');
    zip.file('__MACOSX/proj2/.provenance/._manifest.json', 'junk');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'bundle.zip')]);
    expect(inspected!.candidates).toBeNull();
  });

  it('returns null candidates for bytes that are not a zip', async () => {
    const [inspected] = await inspectDroppedFiles([new File([new Uint8Array([1, 2, 3])], 'x.zip')]);
    expect(inspected!.candidates).toBeNull();
  });

  it('candidateToFile rebuilds a loadable flat bundle named for its scope', async () => {
    const zip = new JSZip();
    addScope(zip, 'proj2/', 'proj2', 2);
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const out = await candidateToFile('repo', inspected!.candidates![0]!);
    expect(out.name).toBe('repo/proj2.zip');
    const reread = await JSZip.loadAsync(await out.arrayBuffer());
    expect(Object.keys(reread.files).some((n) => n.startsWith('manifest-'))).toBe(true);
    expect(Object.keys(reread.files).every((n) => !n.includes('.provenance/'))).toBe(true);
  });

  it('names a root-scope candidate with the uploaded stem', async () => {
    const zip = new JSZip();
    addScope(zip, '', 'proj2', 2);
    zip.file('nested/.provenance/manifest-22222222-2222-2222-2222-222222222222.json', '{}');
    const [inspected] = await inspectDroppedFiles([await zipToFile(zip, 'repo.zip')]);
    const root = inspected!.candidates!.find((c) => c.scopePath === '')!;
    expect((await candidateToFile('repo', root)).name).toBe('repo.zip');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- inspect-dropped-files`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/analyzer/src/lib/inspect-dropped-files.ts`:

```ts
/**
 * Phase A of the /local load: decide whether a dropped file is a flat sealed
 * bundle (load it as-is, exactly as before this module existed) or a git repo
 * carrying one or more assignment recordings (offer a choice).
 *
 * The repo-shape predicate, the junk rule and the scope-prefix rule are all
 * imported from analysis-core rather than re-spelled here: ingest decides
 * "what is a scope" with that code, and /local exists partly to show staff
 * what ingest did. Two implementations would drift.
 */

import JSZip from 'jszip';
import {
  discoverRepoScopes,
  isJunkPath,
  provenanceScopePrefix,
} from '@provenance/analysis-core/scopes/discover-scopes.js';
import {
  zipBundleEntries,
  type BundleEntry,
} from '@provenance/analysis-core/scopes/select-entries.js';

export interface ScopeCandidate {
  scopePath: string;
  declaredAssignmentId: string | null;
  declaredSemester: string | null;
  sessionCount: number;
  /**
   * NDJSON line count over this scope's `.slog` entries — NOT a parsed event
   * count. Discovery has already inflated these bytes, so counting newlines is
   * a linear scan with no JSON parsing; parsing every scope to label the one
   * about to be picked would cost most of a full load. Exact for well-formed
   * NDJSON, off by one for a torn tail or a trailing blank line. Render with a
   * leading tilde.
   */
  approxEventCount: number;
  totalBytes: number;
  selectable: boolean;
  entries: BundleEntry[];
}

export interface InspectedFile {
  file: File;
  candidates: ScopeCandidate[] | null;
}

const SLOG_RE = /^session-[0-9a-fA-F-]+\.slog$/;

function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let lines = 0;
  for (const b of bytes) if (b === 0x0a) lines++;
  // A final line with no trailing newline still counts.
  return bytes[bytes.length - 1] === 0x0a ? lines : lines + 1;
}

export async function inspectDroppedFiles(files: File[]): Promise<InspectedFile[]> {
  const out: InspectedFile[] = [];
  for (const file of files) {
    out.push({ file, candidates: await inspectOne(file) });
  }
  return out;
}

async function inspectOne(file: File): Promise<ScopeCandidate[] | null> {
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    return null; // not a zip — let the existing loader report it
  }

  // Name-only repo-shape test, identical to the server's ingest guard: an
  // archive is repo-shaped iff some non-junk entry sits under a `.provenance/`
  // directory. A flat sealed bundle can never satisfy it.
  const names = Object.entries(archive.files)
    .filter(([, o]) => !o.dir)
    .map(([n]) => n);
  const isRepoShaped = names.some((n) => !isJunkPath(n) && provenanceScopePrefix(n) !== null);
  if (!isRepoShaped) return null;

  const contents = new Map<string, Uint8Array>();
  for (const [name, obj] of Object.entries(archive.files)) {
    if (obj.dir) continue;
    contents.set(name, await obj.async('uint8array'));
  }

  const discovered = discoverRepoScopes(contents);
  if (!discovered.ok) return null;

  const sealed: ScopeCandidate[] = discovered.scopes.map((s) => {
    const slogs = s.entries.filter((e) => SLOG_RE.test(e.name));
    return {
      scopePath: s.scopePath,
      declaredAssignmentId: s.declaredAssignmentId,
      declaredSemester: s.declaredSemester,
      sessionCount: slogs.length,
      approxEventCount: slogs.reduce((n, e) => n + countLines(e.data), 0),
      totalBytes: s.entries.reduce((n, e) => n + e.data.length, 0),
      selectable: true,
      entries: s.entries,
    };
  });

  // Unsealed directories are LISTED, not hidden: a student whose recording
  // never sealed should be visible as such rather than silently absent.
  const unsealed: ScopeCandidate[] = discovered.unusable.map((u) => ({
    scopePath: u.scopePath,
    declaredAssignmentId: null,
    declaredSemester: null,
    sessionCount: 0,
    approxEventCount: 0,
    totalBytes: 0,
    selectable: false,
    entries: [],
  }));

  return [...sealed, ...unsealed].sort((a, b) => (a.scopePath < b.scopePath ? -1 : 1));
}

/**
 * Rebuild one chosen scope as the flat bundle zip the loader requires.
 *
 * The root scope keeps the uploaded name so a repo whose provenance sits at its
 * root is labelled exactly as the equivalent flat bundle would be; a nested
 * scope is named for its directory, matching how a fanned-out ingest names it.
 */
export async function candidateToFile(stem: string, c: ScopeCandidate): Promise<File> {
  const name = c.scopePath === '' ? `${stem}.zip` : `${stem}/${c.scopePath.slice(0, -1)}.zip`;
  return new File([await zipBundleEntries(c.entries)], name);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- inspect-dropped-files`

Expected: PASS, all eight cases.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/lib/inspect-dropped-files.ts packages/analyzer/src/lib/inspect-dropped-files.test.ts
git commit --no-gpg-sign -m "feat(analyzer): inspect dropped files for monorepo assignment scopes"
```

---

### Task 4: `BundleContext` gains a `'choosing'` phase

**Files:**
- Modify: `packages/analyzer/src/context/BundleContext.tsx`
- Test: Create `packages/analyzer/src/context/BundleContext.choosing.test.tsx`

**Interfaces:**
- Consumes: `inspectDroppedFiles`, `candidateToFile`, `ScopeCandidate` (Task 3).
- Produces, added to `BundleContextValue`:

```ts
status: 'idle' | 'loading' | 'choosing' | 'loaded' | 'error';
pendingScopes: PendingScopeChoice | null;
beginLoad(files: File[]): Promise<void>;
chooseScopes(selectionKeys: string[]): Promise<void>;
cancelChoice(): void;
```

with

```ts
export interface PendingScopeChoice {
  /** Files that need no choice; loaded as-is once the choice is confirmed. */
  passthrough: File[];
  /** One entry per repo-shaped file that holds more than one scope. */
  groups: Array<{ stem: string; candidates: ScopeCandidate[] }>;
}

export function scopeSelectionKey(stem: string, scopePath: string): string;
```

Task 5 renders `pendingScopes`, calls `beginLoad`, `chooseScopes` and `cancelChoice`, and builds keys with `scopeSelectionKey`.

**Routing note:** `RequireLocalBundle` redirects on `status !== 'loaded'`, so `'choosing'` keeps the user on `/local/load` with no guard change. Verify that rather than assuming it.

- [ ] **Step 1: Write the failing test**

Create `packages/analyzer/src/context/BundleContext.choosing.test.tsx`. Follow `LoadView.test.tsx`'s conventions exactly — the ed25519 SHA-512 jsdom shim at the top, `@testing-library/react`, and a real `<BundleProvider>` wrapper. Build fixtures with the same `addScope` / `zipToFile` helpers as Task 3 (duplicate them locally; they are five lines and test helpers are not shared across packages here).

Write these five cases out fully against the real provider (no mocking of the loader) — a `buildTestBundle`-produced flat bundle for the first, JSZip-built repo zips for the rest:

```tsx
it('goes straight to loaded for a single flat bundle, never entering choosing', async () => {
  // Drop one flat sealed bundle built with buildTestBundle; assert the status
  // reaches 'loaded' and pendingScopes stayed null throughout.
});

it('enters choosing when a dropped file holds more than one scope', async () => {
  // Drop the two-scope monorepo zip; assert status === 'choosing' and
  // pendingScopes.groups[0].candidates has length 2.
});

it('loads only the chosen scope', async () => {
  // chooseScopes([scopeSelectionKey('repo', 'proj2/')]) -> status 'loaded',
  // bundles.length === 1.
});

it('cancelChoice returns to idle without loading anything', async () => {
  // cancelChoice() -> status 'idle', bundles empty, pendingScopes null.
});

it('does not prompt when a repo zip holds exactly one sealed scope', async () => {
  // Single-scope repo zip -> loads directly, status never 'choosing'.
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- BundleContext.choosing`

Expected: FAIL — `status` never becomes `'choosing'`; `pendingScopes` undefined.

- [ ] **Step 3: Add the types and state**

In `BundleContext.tsx`:

1. Widen the status union in `BundleContextValue` to include `'choosing'`.
2. Add the exported `PendingScopeChoice` interface and the four new members to `BundleContextValue`.
3. Add state: `const [pendingScopes, setPendingScopes] = useState<PendingScopeChoice | null>(null);`
4. Add the key helper near the top of the module:

```ts
/**
 * Namespaces a scope path by the file it came from, so two dropped repos that
 * both contain `proj2/` cannot select each other's scope.
 */
export function scopeSelectionKey(stem: string, scopePath: string): string {
  return `${stem} ${scopePath}`;
}
```

- [ ] **Step 4: Add `beginLoad`**

**Do not modify `loadBundleFiles`.** Add a new callback that becomes what `LoadView` calls:

```ts
  const beginLoad = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setStatus('loading');
      setLoadError(null);
      setPartialLoadErrors([]);
      setLoadingStage('unzip');

      const inspected = await inspectDroppedFiles(files);
      const groups: PendingScopeChoice['groups'] = [];
      const direct: File[] = [];

      for (const item of inspected) {
        if (item.candidates === null) {
          direct.push(item.file);
          continue;
        }
        const stem = item.file.name.endsWith('.zip')
          ? item.file.name.slice(0, -4)
          : item.file.name;
        const selectable = item.candidates.filter((c) => c.selectable);
        if (selectable.length === 1) {
          // Exactly one recording in this repo: there is no question to ask.
          direct.push(await candidateToFile(stem, selectable[0]!));
        } else {
          groups.push({ stem, candidates: item.candidates });
        }
      }

      if (groups.length === 0) {
        await loadBundleFiles(direct);
        return;
      }
      setPendingScopes({ passthrough: direct, groups });
      setStatus('choosing');
      setLoadingStage(null);
    },
    [loadBundleFiles],
  );
```

A repo where every `.provenance/` is unsealed has zero selectable scopes and therefore lands in `groups` with nothing pickable — the picker then shows *why*, which beats a bare loader error.

- [ ] **Step 5: Add `chooseScopes` and `cancelChoice`**

```ts
  const chooseScopes = useCallback(
    async (selectionKeys: string[]) => {
      const pending = pendingScopes;
      if (pending === null) return;
      setPendingScopes(null);
      const chosen: File[] = [...pending.passthrough];
      for (const group of pending.groups) {
        for (const c of group.candidates) {
          if (c.selectable && selectionKeys.includes(scopeSelectionKey(group.stem, c.scopePath))) {
            chosen.push(await candidateToFile(group.stem, c));
          }
        }
      }
      if (chosen.length === 0) {
        setStatus('idle');
        return;
      }
      await loadBundleFiles(chosen);
    },
    [pendingScopes, loadBundleFiles],
  );

  const cancelChoice = useCallback(() => {
    setPendingScopes(null);
    setStatus('idle');
    setLoadingStage(null);
  }, []);
```

- [ ] **Step 6: Wire into the context value and `clearBundle`**

Add `pendingScopes`, `beginLoad`, `chooseScopes` and `cancelChoice` to the `useMemo` value object **and to its dependency array** — the array is exhaustive in this file and a missed entry is a stale-closure bug. Add `setPendingScopes(null)` to `clearBundle`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm run test --workspace=packages/analyzer -- BundleContext`

Expected: PASS, including the pre-existing BundleContext tests.

- [ ] **Step 8: Commit**

```bash
git add packages/analyzer/src/context/BundleContext.tsx packages/analyzer/src/context/BundleContext.choosing.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): add a scope-choice phase to the /local load"
```

---

### Task 5: The picker UI

**Files:**
- Create: `packages/analyzer/src/views/load/ScopePicker.tsx`, `packages/analyzer/src/views/load/ScopePicker.test.tsx`
- Modify: `packages/analyzer/src/views/load/LoadView.tsx`, `packages/analyzer/src/views/load/LoadView.test.tsx`

**Interfaces:**
- Consumes: `PendingScopeChoice`, `scopeSelectionKey`, `beginLoad`, `chooseScopes`, `cancelChoice` (Task 4).
- Produces: `export function ScopePicker()` — reads everything from `useBundle()`, takes no props.

- [ ] **Step 1: Write the failing tests**

Create `packages/analyzer/src/views/load/ScopePicker.test.tsx`. Drive it through `LoadView` with a two-scope fixture so the provider state is real — do not add a props-based escape hatch that production never uses. Cover:

```tsx
it('lists every candidate with its assignment id and session count', async () => { /* ... */ });
it('disables the confirm button until something is selected', async () => { /* ... */ });
it('renders an unsealed scope as disabled with a not-sealed reason', async () => { /* ... */ });
it('allows selecting more than one scope', async () => { /* ... */ });
it('calls cancelChoice when dismissed', async () => { /* ... */ });
```

Add to `LoadView.test.tsx` a **regression test** that the existing path is untouched:

```tsx
it('loads a flat bundle with no scope picker', async () => {
  // buildTestBundle -> drop -> waitFor overview-reached
  expect(screen.queryByTestId('scope-picker')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test --workspace=packages/analyzer -- ScopePicker LoadView`

Expected: FAIL — no `scope-picker` testid.

- [ ] **Step 3: Implement `ScopePicker`**

Create `packages/analyzer/src/views/load/ScopePicker.tsx`. Requirements:

- Root element carries `data-testid="scope-picker"`.
- One row per candidate with `data-testid={'scope-row-' + (scopePath || 'root')}`, showing: scope path (render `/` for the root scope), declared assignment id (or an em dash when null), semester, `{n} session(s)`, `~{n} events` (keep the tilde — the count is approximate), and a human-readable byte size.
- A checkbox per selectable row. Unselectable rows render disabled with the reason `not sealed — no manifest`.
- **Nothing is selected initially.** The confirm button (`data-testid="analyze-selected"`, label `Analyze selected`) is `disabled` while the selection is empty.
- A cancel control calling `cancelChoice()`.
- When `pendingScopes.groups.length > 1`, group rows under a heading naming each `stem` so two dropped repos are distinguishable.
- Build selection keys with `scopeSelectionKey(stem, scopePath)`; pass the accumulated array to `chooseScopes`.
- Match the Tailwind idiom of the surrounding `views/load/` components and reuse the existing `Button` component rather than styling a raw `<button>`.

- [ ] **Step 4: Wire it into `LoadView`**

In `LoadView.tsx`: pull `status`, `pendingScopes` and `beginLoad` from `useBundle()`; call `beginLoad` instead of `loadBundleFiles` inside `handleFiles`; render `<ScopePicker />` in place of the drop zone when `status === 'choosing'`. Leave the existing `status === 'loaded'` navigation effect and the error panel alone.

- [ ] **Step 5: Run the analyzer suite**

Run: `npm run test --workspace=packages/analyzer`

Expected: PASS, including every pre-existing LoadView test.

- [ ] **Step 6: Typecheck + lint**

Run: `npm run typecheck && npm run lint`

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/analyzer/src/views/load
git commit --no-gpg-sign -m "feat(analyzer): scope picker for monorepo zips dropped on /local"
```

---

### Task 6: `/architecture`

**Files:**
- Modify: `tools/architecture/dot/master.dot` (the `local` node label, around line 76)
- Modify: `packages/analyzer/src/views/architecture/content/nodes/master.ts` (`local` node), `packages/analyzer/src/views/architecture/content/nodes/ingest.ts` (`scope` node links)

**No node is added or renamed**, so `nodes.coverage.test.ts` — which fails on both an uncovered SVG node and an orphaned metadata key — stays green. Verify that claim by running it; do not assume it.

- [ ] **Step 1: Update the stale source links**

In `content/nodes/ingest.ts`, the `scope` node's `links` point at server paths for code that moved. Update the `build-bundle-zip.ts` / `repo-scopes.ts` hrefs to their `packages/analysis-core/src/scopes/...` locations, keeping a link to the server `repo-scopes.ts` for the policy half. The node's `body` and `invariant` describe the resolution model, which this change does not alter — leave that prose alone.

- [ ] **Step 2: Update the `/local` node**

In `tools/architecture/dot/master.dot`, extend the `local` node's label to say that a monorepo zip offers a scope choice. Then update the matching `local` entry in `content/nodes/master.ts` with a `body` explaining the two-phase load: a flat bundle loads unchanged; a repo zip is discovered with the same `analysis-core` code ingest uses, and staff pick which recording to analyze. Note in the body that the event counts shown in the picker are NDJSON line counts, not parsed events.

- [ ] **Step 3: Regenerate the diagrams**

Run: `python3 tools/architecture/build_diagrams.py`

Expected: regenerated SVGs; only `master.svg` should differ. Confirm with `git status --porcelain packages/analyzer/src/views/architecture/diagrams/`. If more than `master.svg` changed, the generator is not reproducible under the installed Graphviz — **stop and report** rather than committing unrelated diagram churn.

- [ ] **Step 4: Run the coverage test**

Run: `npm run test --workspace=packages/analyzer -- nodes.coverage`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/architecture packages/analyzer/src/views/architecture
git commit --no-gpg-sign -m "docs(architecture): scope discovery moved to analysis-core; /local scope picker"
```

---

### Task 7: Final gate

- [ ] **Step 1: Run every touched workspace plus the repo-wide gates**

```bash
npm run typecheck
npm run lint
npm run test --workspace=packages/analysis-core
npm run test --workspace=packages/analyzer
npm run test --workspace=packages/server
```

All five must be green. Docker must be running for the server suite. **Do not run the root `npm run test`.**

- [ ] **Step 2: Confirm the diff is reviewable**

```bash
git log --oneline -8
git diff --stat HEAD~6
```

Expected: six focused commits, no unrelated files, no `.claude/worktrees` churn.

- [ ] **Step 3: Report**

State explicitly: which tasks completed, any test you could not get green (and why — never by weakening an assertion), and anything you noticed but did not change.
