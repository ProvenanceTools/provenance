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
 * to be told where to look, only what to accept. The default accepts every
 * sealed scope; `assignments.ingest_scope` overrides that for the cases
 * self-identification cannot settle (two directories declaring the same id, a
 * stale vendored copy).
 *
 * Pure: bytes in, bytes out. No DB, no storage, no clock.
 */

import { parseRollingManifestFilename } from '@provenance/log-core';
import { selectBundleEntries, type BundleEntry } from './build-bundle-zip.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVENANCE_DIR = '.provenance/';
const MANIFEST_JSON = 'manifest.json';

// ---------------------------------------------------------------------------
// Scope-resolution config (assignments.ingest_scope)
// ---------------------------------------------------------------------------

/**
 * Per-assignment override for what self-identification cannot resolve.
 *
 * - `mode: 'self_identifying'` (default) — accept the scope wherever it sits;
 *   its manifest already says which assignment it is.
 * - `mode: 'path'` — additionally require the scope's directory to match
 *   `path_glob`. Used to exclude a stale vendored copy.
 * - `on_multiple` — what to do when more than one *accepted* scope declares the
 *   same `assignment_id`. `'ingest_all'` fans out to one submission each;
 *   `'error'` refuses them all rather than guessing.
 */
export interface IngestScopeConfig {
  mode: 'self_identifying' | 'path';
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
 * `mode: 'path'` with no usable `path_glob` is meaningless, so it degrades to
 * `self_identifying` too.
 */
export function parseIngestScopeConfig(raw: unknown): IngestScopeConfig {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_INGEST_SCOPE;
  const obj = raw as Record<string, unknown>;

  const onMultiple = obj['on_multiple'] === 'error' ? 'error' : 'ingest_all';
  const pathGlob = typeof obj['path_glob'] === 'string' ? obj['path_glob'] : undefined;

  if (obj['mode'] === 'path' && pathGlob !== undefined && pathGlob.length > 0) {
    return { mode: 'path', path_glob: pathGlob, on_multiple: onMultiple };
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
 * - `scope_excluded` — `mode: 'path'` and the scope's directory did not match
 *   `path_glob`.
 * - `ambiguous_scope` — `on_multiple: 'error'` and more than one scope declared
 *   this assignment id.
 */
export interface UnusableScope {
  scopePath: string;
  reason: 'no_seal' | 'scope_excluded' | 'ambiguous_scope';
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
 * Output preserves the input (discovery) order in both lists.
 */
export function resolveRepoScopes(
  scopes: RepoScope[],
  configFor: IngestScopeConfigResolver,
): ResolveRepoScopesResult {
  const rejected = new Map<string, UnusableScope['reason']>();

  // Pass 1: path-glob exclusion.
  const surviving: RepoScope[] = [];
  for (const scope of scopes) {
    const config = configFor(scope.declaredAssignmentId);
    if (
      config.mode === 'path' &&
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
  return {
    accepted,
    rejected: scopes
      .filter((s) => rejected.has(s.scopePath))
      .map((s) => ({ scopePath: s.scopePath, reason: rejected.get(s.scopePath)! })),
  };
}
