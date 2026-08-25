/**
 * Git-repo scope DISCOVERY (program architecture §1 and §6).
 *
 * Today's ingest assumes one flat bundle per submission folder: a Gradescope
 * "Download Submissions" export unzips each sealed bundle into
 * `submission_<id>/`, and `select-entries.ts` normalizes exactly one
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
 *     `selectBundleEntries` (select-entries.ts) applied to that scope's
 *     sub-tree, so the whitelist, the macOS-junk rules, and — critically — the
 *     entry ORDER are the same code. Entry order fixes the archive's byte
 *     layout and therefore its sha256, which is the ingest dedup key.
 *
 *  2. **The flat case is a special case of the general one.** A submission
 *     folder with a single root `.provenance/` yields exactly one scope at `''`
 *     whose entries are byte-identical to what `selectBundleEntries` returned
 *     before fan-out existed. The Gradescope path is unchanged.
 *
 * ## Why discovery lives in analysis-core and resolution does not
 *
 * Discovery answers "what sealed scopes does this tree contain?" — a question
 * about bytes, with no configuration, no database and no policy in it. Two
 * callers ask it: the server's ingest pipeline, and the analyzer's `/local`
 * route, which lets staff drop a monorepo zip and pick which recording to
 * analyze. `/local` runs entirely in the browser, so the code it needs has to
 * be isomorphic — hence this module, which imports only `@provenance/log-core`
 * and `./select-entries.js`.
 *
 * Scope RESOLUTION (§6) is a different question — "which of those scopes should
 * become submissions?" — and it is bound to a Drizzle column, `packages/shared`'s
 * API contract, and the per-batch declaration an operator makes. That half stays
 * in `server/src/services/ingest/gradescope/repo-scopes.ts`, alongside
 * `IngestScopeConfig` and `resolveRepoScopes`.
 *
 * The split matters beyond tidiness: `/local` exists partly so staff can see
 * what ingest did with a repo. Re-spelling the junk rule or the scope-prefix
 * rule in the browser would let the two drift, and the drift would show up as
 * the analyzer disagreeing with ingest about what a submission even is. So
 * `isJunkPath` and `provenanceScopePrefix` are exported rather than private.
 *
 * Pure: bytes in, bytes out. No DB, no storage, no clock.
 */

import { parseRollingManifestFilename } from '@provenance/log-core';
import { selectBundleEntries, type BundleEntry } from './select-entries.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVENANCE_DIR = '.provenance/';
const MANIFEST_JSON = 'manifest.json';

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
 * A scope that exists but cannot become a bundle.
 *
 * `no_seal` — a `.provenance/` sealed by NOTHING: no classic `manifest.json`
 * and no rolling `manifest-<session_id>.json` either. A git-submitted scope is
 * no longer in this bucket — the recorder's rolling seal (program spec §8)
 * seals it as the student works, with no seal command, so it is accepted like
 * any other scope. What remains here is a genuinely unsealed directory, which
 * the loader cannot accept and which no signature covers. It is reported
 * per-scope rather than dropped, so a repo never vanishes from ingest without a
 * record.
 *
 * This is the ONLY issue discovery can report; it knows nothing about the
 * per-batch declaration. The server's `UnusableScope` widens it to the three
 * further POLICY reasons (`scope_excluded`, `ambiguous_scope`,
 * `submission_type_mismatch`) that `resolveRepoScopes` adds, and
 * `DiscoveredScopeIssue` is structurally assignable to it.
 */
export interface DiscoveredScopeIssue {
  scopePath: string;
  reason: 'no_seal';
}

export type DiscoverRepoScopesResult =
  | { ok: true; scopes: RepoScope[]; unusable: DiscoveredScopeIssue[] }
  /** No `.provenance/` anywhere and no root `manifest.json` — not a bundle tree. */
  | { ok: false; reason: 'no_manifest' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * macOS archive noise; mirrors select-entries' own rule.
 *
 * Exported because the analyzer's `/local` inspect step applies the same
 * repo-shape predicate the server's `repo-zip.ts` does, and that predicate is
 * this rule plus {@link provenanceScopePrefix}. Two spellings would drift.
 */
export function isJunkPath(relPath: string): boolean {
  if (relPath.includes('__MACOSX/')) return true;
  return relPath.split('/').some((seg) => seg === '.DS_Store' || seg.startsWith('._'));
}

/**
 * The directory prefix of the `.provenance/` segment in `relPath`, or null when
 * the path does not sit under one. `'.provenance/x'` → `''`;
 * `'proj2/.provenance/x'` → `'proj2/'`. Only the OUTERMOST occurrence counts.
 *
 * Exported for the same reason as {@link isJunkPath}.
 */
export function provenanceScopePrefix(relPath: string): string | null {
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
  const unusable: DiscoveredScopeIssue[] = [];

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
