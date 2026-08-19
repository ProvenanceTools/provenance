/**
 * Discovers `.provenance-manifest`/`provenance-manifest` files nested anywhere under
 * the opened workspace folder(s), verifies each candidate, and reports both the
 * verified set and the skipped (invalid/unreadable) set.
 *
 * PRD relationship: this is the multi-root generalization of manifest-loader.ts's
 * single-root `loadAndVerifyManifest`. Verification itself is delegated to that
 * function unchanged — this module only adds the "find candidate directories" step.
 *
 * A bad manifest at one directory must never block discovery/activation at another
 * (spec integrity invariant) — callers rely on `skipped` being purely informational.
 */

import * as path from 'node:path';
import { loadAndVerifyManifest, type FolderLike, type ActivationError } from './manifest-loader.js';
import type { Manifest } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiscoveredManifest = { root: string; manifest: Manifest };
export type ManifestSkip = { root: string; error: ActivationError };

export type DiscoveryDeps = {
  /** All currently open workspace folders (vscode.workspace.workspaceFolders in production). */
  workspaceFolders: readonly FolderLike[];
  /**
   * Finds candidate manifest file paths under the given include glob, honoring the
   * exclude glob. Production wires this to vscode.workspace.findFiles; tests inject
   * a stub returning fixed paths. Exclude is fixed by the caller (see excludeGlob below)
   * so this seam only needs the include pattern from us.
   */
  findFiles: (include: string, exclude: string) => Promise<readonly { fsPath: string }[]>;
  /**
   * Override for the embedded verification key (tests). Defaults to
   * ROOT_PUBLIC_KEY_HEX inside loadAndVerifyManifest. At Manifest 2.0 this is the
   * root key the inline `course_cert` must chain to; at 1.x it is the key the
   * payload signature is checked against directly.
   */
  pubkeyHex?: string;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Matches both manifest filename variants at any depth. Kept in sync with
 * MANIFEST_FILE_NAMES in manifest-loader.ts (brace-expansion form for findFiles).
 */
export const MANIFEST_INCLUDE_GLOB = '**/{.provenance-manifest,provenance-manifest}';

/**
 * Excludes heavy/irrelevant directories from the scan: VCS metadata, dependency
 * trees, and the recorder's own per-assignment output directories (a `.provenance/`
 * never itself contains a manifest, but excluding it keeps the walk cheap and avoids
 * ever treating a stale bundled manifest.json as an activation manifest).
 */
export const MANIFEST_EXCLUDE_GLOB = '**/{node_modules,.git,.provenance}/**';

// ---------------------------------------------------------------------------
// discoverManifests
// ---------------------------------------------------------------------------

export async function discoverManifests(
  deps: DiscoveryDeps,
): Promise<{ found: DiscoveredManifest[]; skipped: ManifestSkip[] }> {
  const { workspaceFolders, findFiles, pubkeyHex } = deps;

  // Collect candidate manifest directories across all open folders, deduped by
  // resolved directory (a directory yields at most one session — spec Design §1 —
  // even if both filename variants are present there).
  const candidateDirs = new Set<string>();

  for (const folder of workspaceFolders) {
    const matches = await findFiles(MANIFEST_INCLUDE_GLOB, MANIFEST_EXCLUDE_GLOB);
    for (const uri of matches) {
      candidateDirs.add(path.dirname(uri.fsPath));
    }
    void folder; // findFiles already scopes to the workspace in production (VS Code semantics);
    // kept in the loop signature so a future multi-root-aware findFiles implementation
    // (scoped per folder) is a drop-in replacement.
  }

  const found: DiscoveredManifest[] = [];
  const skipped: ManifestSkip[] = [];

  for (const root of [...candidateDirs].sort()) {
    const result = await loadAndVerifyManifest({ uri: { fsPath: root } }, pubkeyHex);
    if (result.ok) {
      found.push({ root, manifest: result.value });
    } else {
      skipped.push({ root, error: result.error });
    }
  }

  return { found, skipped };
}
