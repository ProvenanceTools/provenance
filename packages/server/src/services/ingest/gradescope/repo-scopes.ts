/**
 * Git-repo scope adapter (program architecture §1 and §6).
 *
 * Today's ingest assumes one flat bundle per submission folder: a Gradescope
 * "Download Submissions" export unzips each sealed bundle into
 * `submission_<id>/`, and `build-bundle-zip.ts` normalizes exactly one
 * `.provenance/` prefix back to the flat shape the loader requires.
 *
 * CS 61B / 61C do not work that way. Students push a git repo and Gradescope
 * clones the WHOLE repository, so one submission tree can contain SEVERAL
 * assignment directories, each with its own `.provenance/`:
 *
 *     proj2/.provenance/…   proj2/Gitlet.java
 *     lab5/.provenance/…    lab5/Lab5.java
 *     README.md
 *
 * This module walks such a tree, finds every `.provenance/` at any depth, and
 * synthesizes one flat bundle per *scope*. Each scope's bundle carries that
 * scope's own directory-relative paths, so `proj2/`'s bundle contains
 * `Gitlet.java` — matching its own manifest's `submission_files` — and nothing
 * from `lab5/` or the repo root.
 *
 * Two invariants make this safe to drop under the existing pipeline:
 *
 *  1. **Selection is not duplicated.** Every scope's entries come from
 *     `selectBundleEntries` (build-bundle-zip.ts) applied to that scope's
 *     sub-tree, so the whitelist, the macOS-junk rules, and — critically — the
 *     entry ORDER are the same code. Entry order fixes the archive's byte
 *     layout and therefore its sha256, which is the ingest dedup key.
 *
 *  2. **The flat case is a special case of the general one.** A submission
 *     folder with a single root `.provenance/` yields exactly one scope at `''`
 *     whose entries are byte-identical to what `selectBundleEntries` returned
 *     before fan-out existed. The Gradescope path is unchanged.
 *
 * Scope RESOLUTION (§6) is separate and deliberately so: a discovered scope is
 * already self-identifying — both `.provenance-manifest` and the sealed
 * `manifest.json` carry `assignment_id` and `semester` — so ingest does not need
 * to be told where to look, only what to accept. The default (`self_identifying`)
 * accepts every sealed scope; declaring a submission TYPE narrows that, both to
 * settle what self-identification cannot (two directories claiming the same id,
 * a stale vendored copy) and to assert that a whole batch has one shape, so a
 * submission of the wrong shape fails loudly instead of ingesting as something
 * it is not. See `IngestScopeConfig` and `resolveRepoScopes`.
 *
 * Pure: bytes in, bytes out. No DB, no storage, no clock.
 */

import { parseRollingManifestFilename } from '@provenance/log-core';
import {
  selectBundleEntries,
  type BundleEntry,
} from '@provenance/analysis-core/scopes/select-entries.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVENANCE_DIR = '.provenance/';
const MANIFEST_JSON = 'manifest.json';

// ---------------------------------------------------------------------------
// Scope-resolution config (assignments.ingest_scope)
// ---------------------------------------------------------------------------

/**
 * The declared submission type for a batch, plus what self-identification
 * cannot resolve on its own.
 *
 * The four modes are one enum because they answer one question — *what shape is
 * a submission, and which of its sealed scopes become submissions?*
 *
 * - `self_identifying` (default) — walk the tree and accept EVERY sealed scope
 *   wherever it sits, however many. Nothing is declared up front; each scope's
 *   manifest already says which assignment it is. This is the permissive mode
 *   that makes a nested multi-assignment repo work, and it is the mode every
 *   pre-existing row has, so it is also what "unchanged behaviour" means.
 * - `bundle_zip` — the classic sealed `.zip` bundle: exactly ONE scope, at the
 *   tree root. A tree that also carries a nested `.provenance/` is not a bundle
 *   zip, and saying so is the whole point of declaring the type.
 * - `repo_whole` — a git repo treated as ONE scope, rooted at the repo root.
 *   Nested scopes are deliberately NOT fanned out; they are excluded by
 *   declaration. Absent a root scope the repo does not match the declaration.
 * - `repo_scoped` — a git repo in which `path_glob` selects the scope(s). This
 *   is the mode formerly spelled `'path'`; the semantics are unchanged and
 *   `parseIngestScopeConfig` still accepts the old spelling (see below).
 *
 * `path_glob` is meaningful only for `repo_scoped`. `on_multiple` decides what
 * to do when more than one *accepted* scope declares the same `assignment_id`:
 * `'ingest_all'` fans out to one submission each, `'error'` refuses them all
 * rather than guessing. It is orthogonal to the mode and applies as before.
 *
 * The type is a property of the BATCH, not of an individual scope: it says what
 * the operator expects every submission in this ingest to look like. It lives
 * in two places — a per-assignment persisted default (`assignments.ingest_scope`,
 * which provgate sets once at mapping time) and a per-ingest-request override
 * that beats it for a one-off re-ingest. The override wins simply by being an
 * `IngestScopeConfigResolver` that ignores its key, so nothing downstream needs
 * to know which of the two it got.
 */
export type IngestScopeMode = 'self_identifying' | 'bundle_zip' | 'repo_whole' | 'repo_scoped';

export interface IngestScopeConfig {
  mode: IngestScopeMode;
  path_glob?: string;
  on_multiple: 'error' | 'ingest_all';
}

export const DEFAULT_INGEST_SCOPE: IngestScopeConfig = {
  mode: 'self_identifying',
  on_multiple: 'ingest_all',
};

/**
 * Narrow an untrusted `assignments.ingest_scope` jsonb value.
 *
 * Anything unrecognized falls back to the default rather than failing ingest —
 * a malformed config must not be able to make a whole cohort un-ingestable. A
 * `repo_scoped` with no usable `path_glob` selects nothing at all, which would
 * fail every submission in the batch, so it degrades to `self_identifying`
 * rather than taking a cohort down. (The API layer is deliberately STRICTER
 * than this: `IngestScopeConfigSchema` rejects a glob-less `repo_scoped` at
 * write time, so the degradation can only ever be reached by a row that
 * predates the check or was written straight to Postgres.)
 *
 * `mode: 'path'` is the pre-migration-0026 spelling of `repo_scoped` and is
 * still accepted here. Migration 0026 rewrites the stored rows, but this alias
 * is what makes the rewrite safe to deploy in either order: a replica still
 * carrying `'path'`, or a provgate still sending it, resolves to exactly the
 * behaviour it had before.
 */
export function parseIngestScopeConfig(raw: unknown): IngestScopeConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_INGEST_SCOPE;
  const obj = raw as Record<string, unknown>;

  const onMultiple = obj['on_multiple'] === 'error' ? 'error' : 'ingest_all';
  const pathGlob = typeof obj['path_glob'] === 'string' ? obj['path_glob'] : undefined;
  const mode = obj['mode'] === 'path' ? 'repo_scoped' : obj['mode'];

  if (mode === 'repo_scoped') {
    if (pathGlob !== undefined && pathGlob.length > 0) {
      return { mode: 'repo_scoped', path_glob: pathGlob, on_multiple: onMultiple };
    }
    return { mode: 'self_identifying', on_multiple: onMultiple };
  }
  if (mode === 'bundle_zip' || mode === 'repo_whole') {
    return { mode, on_multiple: onMultiple };
  }
  return { mode: 'self_identifying', on_multiple: onMultiple };
}

/** Resolves the config for a scope's declared assignment id (null = undeclared). */
export type IngestScopeConfigResolver = (assignmentId: string | null) => IngestScopeConfig;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One assignment scope discovered in a submission tree. */
export interface RepoScope {
  /**
   * The scope's directory within the submission tree: `''` for the tree root,
   * otherwise a prefix ending in `/` (e.g. `proj2/`, `src/proj2/`).
   */
  scopePath: string;
  /** Flat bundle-root entries, in the exact order they must be zipped. */
  entries: BundleEntry[];
  /** `assignment_id` declared by this scope's manifest, if readable. */
  declaredAssignmentId: string | null;
  /** `semester` declared by this scope's manifest, if readable. */
  declaredSemester: string | null;
}

/**
 * A scope that exists but will not become a submission.
 *
 * - `no_seal` — a `.provenance/` sealed by NOTHING: no classic `manifest.json`
 *   and no rolling `manifest-<session_id>.json` either. A git-submitted scope
 *   is no longer in this bucket — the recorder's rolling seal (program spec §8)
 *   seals it as the student works, with no seal command, so it is accepted like
 *   any other scope. What remains here is a genuinely unsealed directory, which
 *   the loader cannot accept and which no signature covers. It is reported
 *   per-scope rather than dropped, so a repo never vanishes from ingest without
 *   a record.
 * - `scope_excluded` — the declared type did not select this scope's directory:
 *   either `repo_scoped` and the directory did not match `path_glob`, or
 *   `repo_whole`, which by declaration ingests only the repo root and excludes
 *   every nested scope.
 * - `ambiguous_scope` — `on_multiple: 'error'` and more than one scope declared
 *   this assignment id.
 * - `submission_type_mismatch` — the submission does not have the shape the
 *   batch declared (see `IngestScopeConfig`). This is the homogeneity failure:
 *   a `bundle_zip` batch handed a multi-scope repo, a `repo_whole` batch handed
 *   a repo with no root scope, or a `repo_scoped` batch whose `path_glob`
 *   selected nothing at all. It fails the SUBMISSION, not the batch — see
 *   `resolveRepoScopes`.
 */
export interface UnusableScope {
  scopePath: string;
  reason: 'no_seal' | 'scope_excluded' | 'ambiguous_scope' | 'submission_type_mismatch';
}

export type DiscoverRepoScopesResult =
  | { ok: true; scopes: RepoScope[]; unusable: UnusableScope[] }
  /** No `.provenance/` anywhere and no root `manifest.json` — not a bundle tree. */
  | { ok: false; reason: 'no_manifest' };

export interface ResolveRepoScopesResult {
  accepted: RepoScope[];
  rejected: UnusableScope[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** macOS archive noise; mirrors build-bundle-zip's own rule. */
function isJunkPath(relPath: string): boolean {
  if (relPath.includes('__MACOSX/')) return true;
  return relPath.split('/').some((seg) => seg === '.DS_Store' || seg.startsWith('._'));
}

/**
 * The directory prefix of the `.provenance/` segment in `relPath`, or null when
 * the path does not sit under one. `'.provenance/x'` → `''`;
 * `'proj2/.provenance/x'` → `'proj2/'`. Only the OUTERMOST occurrence counts.
 */
function provenanceScopePrefix(relPath: string): string | null {
  if (relPath.startsWith(PROVENANCE_DIR)) return '';
  const idx = relPath.indexOf(`/${PROVENANCE_DIR}`);
  return idx === -1 ? null : relPath.slice(0, idx + 1);
}

/** Best-effort read of the manifest's self-identifying fields. */
function declaredIdentity(manifestBytes: Uint8Array): {
  assignmentId: string | null;
  semester: string | null;
} {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<string, unknown>;
    return {
      assignmentId: typeof parsed['assignment_id'] === 'string' ? parsed['assignment_id'] : null,
      semester: typeof parsed['semester'] === 'string' ? parsed['semester'] : null,
    };
  } catch {
    // Malformed manifest — the parse phase surfaces invalid_manifest later.
    return { assignmentId: null, semester: null };
  }
}

/**
 * The scope's self-declared identity, from whichever seal shape it carries.
 *
 * A classic scope declares it once, in `manifest.json`. A ROLLING-sealed scope
 * (program spec §8) has no `manifest.json` at all — its identity lives in every
 * `manifest-<session_id>.json`, each of which declares the same
 * `assignment_id` / `semester` in a well-formed bundle. The lowest session id
 * wins, which both keeps the result deterministic and matches
 * `synthesizeRollingUnionManifest`'s "first seal supplies the scalars" rule on
 * the read side. Seals that disagree are real evidence, and the read side
 * reports them as a `divergent_scope` defect — reconciling them here would hide
 * exactly the thing an integrity tool exists to notice.
 */
function scopeIdentity(entries: readonly BundleEntry[]): {
  assignmentId: string | null;
  semester: string | null;
} {
  const classic = entries.find((e) => e.name === MANIFEST_JSON);
  if (classic !== undefined) return declaredIdentity(classic.data);

  const rolling = entries
    .filter((e) => parseRollingManifestFilename(e.name)?.part === 'json')
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of rolling) {
    const identity = declaredIdentity(entry.data);
    if (identity.assignmentId !== null) return identity;
  }
  return { assignmentId: null, semester: null };
}

/**
 * Translate a path glob to an anchored RegExp. Supports `**` (any characters,
 * separators included) and `*` (any characters except `/`). Everything else is
 * matched literally. No new dependency, and the grammar is small enough that
 * hand-rolling is honest here.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    out += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Match a scope directory against a glob.
 *
 * The canonical target is the scope prefix INCLUDING its trailing slash (`''`
 * for the repo root), so the natural `proj2/**` matches `proj2/`. As a
 * convenience the bare form (`proj2`) is accepted too, since that is what staff
 * will type.
 */
function scopeMatchesGlob(scopePath: string, glob: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(scopePath)) return true;
  return scopePath.endsWith('/') && re.test(scopePath.slice(0, -1));
}

// ---------------------------------------------------------------------------
// discoverRepoScopes
// ---------------------------------------------------------------------------

/**
 * Walk a submission tree and synthesize one flat bundle per assignment scope.
 *
 * @param files Map of tree-relative path → file bytes for ONE submission tree
 *              (a Gradescope submission folder, or a cloned repo). Directory
 *              entries must already be excluded.
 *
 * Scopes are returned in lexicographic order of `scopePath`, so the fan-out is
 * deterministic for a given tree.
 */
export function discoverRepoScopes(files: Map<string, Uint8Array>): DiscoverRepoScopesResult {
  // -------------------------------------------------------------------------
  // Step 1: find every scope prefix.
  // -------------------------------------------------------------------------
  const prefixes = new Set<string>();
  for (const rel of files.keys()) {
    if (rel.length === 0 || isJunkPath(rel)) continue;
    const prefix = provenanceScopePrefix(rel);
    if (prefix !== null) prefixes.add(prefix);
  }

  // The pre-git layout: Gradescope also produced folders with the provenance
  // files sitting flat at the folder root (no `.provenance/` at all). That is
  // only ever the tree root, so recognize it only there.
  if (!prefixes.has('') && files.has(MANIFEST_JSON)) prefixes.add('');

  if (prefixes.size === 0) {
    return { ok: false, reason: 'no_manifest' };
  }

  const ordered = Array.from(prefixes).sort();

  // -------------------------------------------------------------------------
  // Step 2: build each scope from its own sub-tree.
  // -------------------------------------------------------------------------
  const scopes: RepoScope[] = [];
  const unusable: UnusableScope[] = [];

  for (const prefix of ordered) {
    // Everything under this scope EXCEPT another scope's `.provenance/` dir —
    // a nested scope owns its provenance files, never the enclosing one. Its
    // source files are left visible: only the scope's own manifest decides
    // which of them are part of this bundle (selectBundleEntries whitelists on
    // `submission_files`).
    const sub = new Map<string, Uint8Array>();
    for (const [rel, bytes] of files) {
      if (!rel.startsWith(prefix)) continue;
      const owner = provenanceScopePrefix(rel);
      if (owner !== null && owner !== prefix) continue;
      const scopeRel = rel.slice(prefix.length);
      if (scopeRel.length === 0) continue;
      sub.set(scopeRel, bytes);
    }

    const selected = selectBundleEntries(sub);
    if (!selected.ok) {
      // A `.provenance/` carrying neither a classic `manifest.json` nor any
      // rolling `manifest-<session_id>.json`: nothing seals it at all.
      unusable.push({ scopePath: prefix, reason: 'no_seal' });
      continue;
    }

    const identity = scopeIdentity(selected.entries);

    scopes.push({
      scopePath: prefix,
      entries: selected.entries,
      declaredAssignmentId: identity.assignmentId,
      declaredSemester: identity.semester,
    });
  }

  return { ok: true, scopes, unusable };
}

// ---------------------------------------------------------------------------
// resolveRepoScopes
// ---------------------------------------------------------------------------

/**
 * Decide which discovered scopes become submissions (§6).
 *
 * Configuration is looked up per DECLARED assignment id, because that is the
 * only thing a discovered scope knows about itself. `on_multiple` therefore
 * compares scopes *within* one assignment id — two directories both claiming
 * `proj2` are ambiguous; `proj2` and `lab5` side by side are not.
 *
 * ## Homogeneity
 *
 * The declared submission TYPE, unlike `path_glob` and `on_multiple`, is a
 * property of the whole submission tree rather than of one scope: "this batch
 * is flat bundle zips" is a claim about the folder's shape, and a folder cannot
 * be half a bundle zip. So the type assertion resolves ONE effective config per
 * folder — `configFor` applied to the first (root-most, since scopes arrive in
 * lexicographic order and `''` sorts first) scope's declared assignment. Under
 * a per-request override that resolver ignores its key, so every scope shares
 * the same declaration and the choice of key cannot matter; under the
 * per-assignment default it matters only for the mixed-assignment repo that
 * `self_identifying` exists to serve — and `self_identifying` asserts nothing.
 *
 * A submission that does not match the declaration **fails that submission, not
 * the batch.** Three reasons, in order of weight:
 *
 *  1. A batch is streamed folder-by-folder with bounded memory and staged
 *     incrementally; there is no transaction spanning it. Failing the batch
 *     would mean aborting mid-stream with submissions already staged.
 *  2. Rows are never deleted on any path, so a mid-batch abort cannot be
 *     rolled back — it would strand a half-ingested batch. Per-submission
 *     failure leaves the batch coherent and the whole ingest re-runnable.
 *  3. One malformed repo in a 300-student cohort must not block the other 299,
 *     and the aggregate is still perfectly legible: every mismatch is reported
 *     through the SAME `UnusableScope` channel as `no_seal` and `scope_excluded`,
 *     so a heterogeneous batch shows up as a pile of `submission_type_mismatch`
 *     entries in the ingest response's `skipped` array. No parallel channel.
 *
 * Output preserves the input (discovery) order in both lists. A folder-level
 * mismatch that belongs to no single scope is reported at `scopePath: ''` (the
 * folder root), which can coexist with a real root scope's own rejection — two
 * entries, two distinct true facts.
 */
export function resolveRepoScopes(
  scopes: RepoScope[],
  configFor: IngestScopeConfigResolver,
): ResolveRepoScopesResult {
  const rejected = new Map<string, UnusableScope['reason']>();

  // Nothing sealed here at all. Discovery already reported each unsealed
  // directory as `no_seal`; asserting a type on top would only add noise.
  if (scopes.length === 0) return { accepted: [], rejected: [] };

  const folderConfig = configFor(scopes[0]!.declaredAssignmentId);

  // Pass 0: the declared submission type — assertions about the FOLDER's shape.
  //
  // `bundle_zip` and `repo_whole` are decided entirely here because they are
  // claims about how many scopes exist and where, which `path_glob` cannot
  // express. `repo_scoped` is decided after the glob has run (pass 3), since
  // its failure mode is "the glob selected nothing".
  if (folderConfig.mode === 'bundle_zip') {
    // A classic sealed bundle is exactly one scope at the tree root. A nested
    // `.provenance/` anywhere means this is a repo, not a bundle zip — which is
    // precisely the heterogeneity the declaration exists to catch.
    const isLoneRootScope = scopes.length === 1 && scopes[0]!.scopePath === '';
    if (!isLoneRootScope) {
      return {
        accepted: [],
        rejected: scopes.map((s) => ({
          scopePath: s.scopePath,
          reason: 'submission_type_mismatch' as const,
        })),
      };
    }
  }

  if (folderConfig.mode === 'repo_whole') {
    // The repo IS the scope, so the root must be sealed. If it is not, this
    // tree is not the declared shape — a `repo_scoped` repo, most likely.
    if (!scopes.some((s) => s.scopePath === '')) {
      return {
        accepted: [],
        rejected: scopes.map((s) => ({
          scopePath: s.scopePath,
          reason: 'submission_type_mismatch' as const,
        })),
      };
    }
    // Nested scopes are not a mismatch — a repo may legitimately vendor one —
    // they are simply not fanned out, because the declaration says this repo is
    // ONE submission. `scope_excluded` is exactly that statement.
    for (const scope of scopes) {
      if (scope.scopePath !== '') rejected.set(scope.scopePath, 'scope_excluded');
    }
  }

  // Pass 1: path-glob exclusion.
  const surviving: RepoScope[] = [];
  for (const scope of scopes) {
    if (rejected.has(scope.scopePath)) continue;
    const config = configFor(scope.declaredAssignmentId);
    if (
      config.mode === 'repo_scoped' &&
      config.path_glob !== undefined &&
      !scopeMatchesGlob(scope.scopePath, config.path_glob)
    ) {
      rejected.set(scope.scopePath, 'scope_excluded');
      continue;
    }
    surviving.push(scope);
  }

  // Pass 2: ambiguity within one declared assignment id.
  const byAssignment = new Map<string, RepoScope[]>();
  for (const scope of surviving) {
    // Undeclared ids are never grouped together — an unreadable manifest is not
    // evidence that two scopes are the same assignment.
    const key =
      scope.declaredAssignmentId === null
        ? ` undeclared:${scope.scopePath}`
        : `id:${scope.declaredAssignmentId}`;
    const bucket = byAssignment.get(key);
    if (bucket === undefined) byAssignment.set(key, [scope]);
    else bucket.push(scope);
  }

  for (const bucket of byAssignment.values()) {
    if (bucket.length < 2) continue;
    const config = configFor(bucket[0]!.declaredAssignmentId);
    if (config.on_multiple !== 'error') continue;
    for (const scope of bucket) rejected.set(scope.scopePath, 'ambiguous_scope');
  }

  const accepted = surviving.filter((s) => !rejected.has(s.scopePath));
  const rejectedList: UnusableScope[] = scopes
    .filter((s) => rejected.has(s.scopePath))
    .map((s) => ({ scopePath: s.scopePath, reason: rejected.get(s.scopePath)! }));

  // Pass 3: `repo_scoped` selected nothing.
  //
  // The per-scope `scope_excluded` entries above already say WHICH directories
  // the glob passed over, and they stay — they are the useful detail. What they
  // do not say is that the batch's declaration produced no submission at all
  // for this folder, which is a different and louder fact: the operator said
  // "there is a scope at `path_glob`" and there was not. Without this the
  // failure is indistinguishable from a folder that legitimately had nothing to
  // ingest, and a glob with a typo silently drops an entire cohort.
  if (folderConfig.mode === 'repo_scoped' && accepted.length === 0) {
    rejectedList.push({ scopePath: '', reason: 'submission_type_mismatch' });
  }

  return { accepted, rejected: rejectedList };
}
