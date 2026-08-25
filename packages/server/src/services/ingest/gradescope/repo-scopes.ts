/**
 * Git-repo scope POLICY (program architecture §1 and §6).
 *
 * This file is one half of a pair. Scope DISCOVERY — "what sealed scopes does
 * this submission tree contain?" — now lives in
 * `@provenance/analysis-core/scopes/discover-scopes.js`, because the analyzer's
 * `/local` route needs the same answer in the browser and re-spelling it there
 * would let ingest and the analyzer drift about what a submission even is.
 * Discovery is pure bytes-in/bytes-out and has no configuration in it.
 *
 * What stays here is the half that is bound to this server: which of the
 * discovered scopes actually become submissions. That decision reads
 * `assignments.ingest_scope` (a Drizzle jsonb column) or a per-request override
 * carried by `packages/shared`'s API contract, so it cannot be isomorphic and
 * has no business in `analysis-core`.
 *
 * Scope RESOLUTION (§6) is separate from discovery and deliberately so: a
 * discovered scope is already self-identifying — both `.provenance-manifest`
 * and the sealed `manifest.json` carry `assignment_id` and `semester` — so
 * ingest does not need to be told where to look, only what to accept. The
 * default (`self_identifying`) accepts every sealed scope; declaring a
 * submission TYPE narrows that, both to settle what self-identification cannot
 * (two directories claiming the same id, a stale vendored copy) and to assert
 * that a whole batch has one shape, so a submission of the wrong shape fails
 * loudly instead of ingesting as something it is not. See `IngestScopeConfig`
 * and `resolveRepoScopes`.
 *
 * Pure: scopes in, scopes out. No DB, no storage, no clock — the config is
 * handed in as a resolver rather than read from here.
 */

import type { RepoScope } from '@provenance/analysis-core/scopes/discover-scopes.js';

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
 *
 * All four reasons are still reported through this one type at the wire
 * boundary (`GradescopeSkippedEntrySchema`), which is why the union did not
 * narrow when discovery moved out. Only the FIRST of them is something
 * discovery can observe; `analysis-core` therefore exports the one-reason
 * `DiscoveredScopeIssue`, which is structurally assignable to this, so
 * `discovered.unusable` flows into these lists with no conversion.
 */
export interface UnusableScope {
  scopePath: string;
  reason: 'no_seal' | 'scope_excluded' | 'ambiguous_scope' | 'submission_type_mismatch';
}

export interface ResolveRepoScopesResult {
  accepted: RepoScope[];
  rejected: UnusableScope[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
