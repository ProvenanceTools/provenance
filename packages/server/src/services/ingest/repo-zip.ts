/**
 * Git-repo expansion for the plain multipart upload route
 * (`POST /semesters/:semesterId/ingest`).
 *
 * The Gradescope entry points reach `repo-scopes.ts` through
 * `stream-export.ts`, which walks an *export* — a metadata file plus one folder
 * per submission. The plain upload route has no export and no metadata: it is
 * handed loose `.zip` files. Before this module it understood exactly two
 * shapes, "a sealed bundle" and "a zip whose entries are all `.zip`", and a git
 * repo zip matched neither. It fell through to the bundle branch and was staged
 * whole, so the loader was handed a tree it cannot parse — and, worse, that is
 * a silent misinterpretation rather than an error, on the route staff reach for
 * precisely when the automated path has already gone wrong.
 *
 * This module closes that hole without becoming a second implementation of
 * anything. Discovery, scope resolution, entry selection, entry ORDER and the
 * ZIP rebuild are all `repo-scopes.ts` / `analysis-core/scopes/select-entries.ts` — the same code,
 * called with the same arguments, in the same order as `stream-export.ts` calls
 * it. What lives here is only the adapter: JSZip archive in, per-scope bundle
 * ZIPs plus skip reasons out.
 *
 * ## The guard, and why it is spelled this way
 *
 * `expandRepoZip` refuses to touch anything that is not a repo zip, and it
 * decides that from ENTRY NAMES ALONE — no inflation, no rebuild:
 *
 *   an archive is a repo zip iff some non-junk entry sits under a
 *   `.provenance/` directory.
 *
 * A sealed bundle is FLAT by construction (recorder PRD §5.3): `manifest.json`,
 * `manifest.sig` and the `session-*.slog` files are all at the archive root,
 * never under `.provenance/`. So the two shapes the route already handled —
 * a single sealed bundle, and a zip whose entries are all `.zip` — cannot
 * satisfy the predicate, take the original code path untouched, and stage the
 * exact bytes they staged before. That is a stronger guarantee than "the
 * rebuild is deterministic": their bytes are never rebuilt at all, so the
 * staged `blob_sha256` — the dedup key — is unchanged by construction.
 *
 * The predicate is also why the declared submission TYPE is asserted only on
 * the repo-shaped branch here. Asserting it on a flat bundle would mean
 * rebuilding one to learn its declared assignment id, which would change the
 * staged bytes of the shape this change is required to leave alone.
 *
 * Pure: bytes in, bytes out. No DB, no storage, no clock.
 */

import JSZip from 'jszip';
import {
  resolveRepoScopes,
  type IngestScopeConfigResolver,
  type UnusableScope,
} from './gradescope/repo-scopes.js';
import { discoverRepoScopes } from '@provenance/analysis-core/scopes/discover-scopes.js';
import { zipBundleEntries } from '@provenance/analysis-core/scopes/select-entries.js';
import type { IngestLocalPathSkipped } from './local-path.js';

const PROVENANCE_DIR = '.provenance/';

/** macOS archive noise; mirrors `repo-scopes.ts`'s own rule. */
function isJunkPath(relPath: string): boolean {
  if (relPath.includes('__MACOSX/')) return true;
  return relPath.split('/').some((seg) => seg === '.DS_Store' || seg.startsWith('._'));
}

/**
 * Does this path sit under a `.provenance/` directory? `'.provenance/x'` and
 * `'proj2/.provenance/x'` both do; a flat `'manifest.json'` does not.
 */
function isUnderProvenanceDir(relPath: string): boolean {
  return relPath.startsWith(PROVENANCE_DIR) || relPath.includes(`/${PROVENANCE_DIR}`);
}

/** One accepted scope, rebuilt into the flat bundle ZIP the pipeline consumes. */
export interface RepoZipBundle {
  /**
   * Staging filename. The ROOT scope keeps the uploaded name verbatim, so a
   * repo whose provenance sits at its root still matches the semester's
   * filename convention exactly as a flat bundle of the same name would. A
   * fanned-out scope names its directory (`<stem>/proj2.zip`) so the unmatched
   * tray shows which part of the repo it came from — the same shape
   * `local-path.ts` uses for a Gradescope fan-out.
   */
  filename: string;
  data: ArrayBuffer;
  /** `''` for the repo root, else the scope's directory prefix (`proj2/`). */
  scopePath: string;
}

export interface ExpandRepoZipResult {
  /**
   * The uploaded filename with any trailing `.zip` removed — the `folder_key`
   * every skip for this upload is reported under, and the prefix a fanned-out
   * scope's staging filename is built from. Exposed so the caller can report a
   * skip of its own (an oversize rebuilt bundle) under the same key rather than
   * re-deriving it.
   */
  folderKey: string;
  bundles: RepoZipBundle[];
  /**
   * Every scope that will NOT become a submission, with its reason — the same
   * `no_seal` / `scope_excluded` / `ambiguous_scope` / `submission_type_mismatch`
   * vocabulary the Gradescope path reports, through the same channel. There is
   * deliberately no new failure channel: a heterogeneous batch shows up here as
   * a pile of `submission_type_mismatch` entries and nowhere else.
   */
  skipped: IngestLocalPathSkipped[];
}

/**
 * Strip one trailing `.zip` so the root scope can be renamed back to exactly
 * the uploaded filename and a fanned-out scope can be nested beneath it.
 */
function stemOf(filename: string): string {
  return filename.endsWith('.zip') ? filename.slice(0, -4) : filename;
}

/**
 * Expand a git repo zip into one flat bundle ZIP per accepted assignment scope.
 *
 * Returns `null` — meaning "not a repo zip, leave this upload exactly as it
 * was" — for every input that is not unambiguously repo-shaped:
 *
 *   - a file whose name does not end in `.zip`;
 *   - bytes that are not a readable ZIP;
 *   - an archive with no non-junk entry under a `.provenance/` directory
 *     (a flat sealed bundle, and anything else the route stages raw today);
 *   - an archive whose `.provenance/` entries are all macOS junk, so discovery
 *     finds no tree at all.
 *
 * A `null` return is the ONLY path by which the pre-existing behaviour of this
 * route is reached, and every one of those cases takes it.
 *
 * @param filename  The uploaded name; used to derive staging filenames and the
 *                  `folder_key` reported on skips.
 * @param body      The uploaded bytes.
 * @param configFor Scope-resolution config, keyed by a scope's DECLARED
 *                  assignment id. A per-request override is a resolver that
 *                  ignores its key — exactly as on the other two routes, so
 *                  nothing below here can tell an override from a persisted
 *                  per-assignment default.
 */
export async function expandRepoZip(
  filename: string,
  body: ArrayBuffer,
  configFor: IngestScopeConfigResolver,
): Promise<ExpandRepoZipResult | null> {
  if (!filename.endsWith('.zip')) return null;

  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(body);
  } catch {
    return null;
  }

  // Name-only test. Nothing is inflated until we know this is a repo.
  const names = Object.entries(archive.files)
    .filter(([, obj]) => !obj.dir)
    .map(([name]) => name);
  if (!names.some((n) => !isJunkPath(n) && isUnderProvenanceDir(n))) return null;

  const files = new Map<string, Uint8Array>();
  for (const [name, obj] of Object.entries(archive.files)) {
    if (obj.dir) continue;
    files.set(name, await obj.async('uint8array'));
  }

  const discovered = discoverRepoScopes(files);
  if (!discovered.ok) {
    // Unreachable today: the guard above and `discoverRepoScopes`'s step 1
    // apply the SAME junk rule to the SAME paths, so a guard that passed on a
    // non-junk `.provenance/` entry guarantees at least one discovered prefix.
    // Kept as a fallback that hands the upload back untouched — if the two
    // rules ever drift, the route degrades to its pre-existing behaviour
    // rather than dropping the file with a reason nobody computed.
    return null;
  }

  const resolved = resolveRepoScopes(discovered.scopes, configFor);

  const folderKey = stemOf(filename);
  const toSkip = (u: UnusableScope): IngestLocalPathSkipped => ({
    folderKey,
    scopePath: u.scopePath,
    reason: u.reason,
  });

  const bundles: RepoZipBundle[] = [];
  for (const scope of resolved.accepted) {
    bundles.push({
      filename:
        scope.scopePath === ''
          ? `${folderKey}.zip`
          : `${folderKey}/${scope.scopePath.slice(0, -1)}.zip`,
      data: await zipBundleEntries(scope.entries),
      scopePath: scope.scopePath,
    });
  }

  return {
    folderKey,
    bundles,
    // Discovery's unusable list first (unsealed directories), then resolution's
    // rejections — the same order `stream-export.ts` yields them in.
    skipped: [...discovered.unusable.map(toSkip), ...resolved.rejected.map(toSkip)],
  };
}
