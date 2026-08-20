/**
 * Parse a Gradescope assignment export ZIP into rosterable submitters and
 * per-submission rebuilt bundle ZIPs.
 *
 * A Gradescope export (downloaded from "Download Submissions") is a single ZIP
 * containing, under one top-level folder:
 *   submission_metadata.yml         — submitter identities per submission
 *   submission_<id>/…               — one folder per submission (unzipped bundle
 *                                     contents + the student's submitted files)
 * plus macOS archive noise (`.DS_Store`, `__MACOSX/`).
 *
 * This is the entry point of the Gradescope ingest path: it locates and parses
 * the metadata, rebuilds a flat bundle ZIP from each submission folder
 * (build-bundle-zip.ts), and returns:
 *   - `rosterSubmitters`: every submitter across the whole export, deduped by
 *     sid (the roster upsert source — analyzer PRD §8.4 / §9.2),
 *   - `bundles`: one entry per ASSIGNMENT SCOPE of each submission folder,
 *     carrying its rebuilt ZIP and submitters (the caller stages one
 *     ingest_files row per submitter, so group co-submitters each get their own
 *     submission). A flat Gradescope folder has exactly one scope; a cloned git
 *     repo can have several (see repo-scopes.ts),
 *   - `skipped`: folders that are not bundles at all, plus scopes that exist but
 *     produce no submission (e.g. an unsealed `.provenance/`) — still rostered,
 *     but no bundle to process.
 *
 * Pure with respect to business logic; the only effect is JSZip in/out.
 */

import JSZip from 'jszip';
import { parseSubmissionMetadata, type GradescopeSubmitter } from './parse-metadata.js';
import { zipBundleEntries } from './build-bundle-zip.js';
import {
  discoverRepoScopes,
  resolveRepoScopes,
  DEFAULT_INGEST_SCOPE,
  type IngestScopeConfigResolver,
} from './repo-scopes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

const METADATA_FILENAME = 'submission_metadata.yml';

export interface GradescopeBundleEntry {
  /** Submission folder name, e.g. "submission_409194023". */
  folderKey: string;
  /**
   * The assignment scope this bundle came from within the folder: `''` for the
   * folder root (the classic flat Gradescope shape), else a directory prefix
   * such as `proj2/` (a git repo carrying several assignment scopes).
   */
  scopePath: string;
  /** Submitters of this submission (the caller stages one row per submitter). */
  submitters: GradescopeSubmitter[];
  /** Rebuilt flat bundle ZIP bytes (ready for the existing parse pipeline). */
  bundleZip: ArrayBuffer;
}

export interface GradescopeSkippedEntry {
  folderKey: string;
  scopePath: string;
  submitters: GradescopeSubmitter[];
  reason:
    | 'no_manifest'
    | 'no_submitters'
    | 'no_seal'
    | 'scope_excluded'
    | 'ambiguous_scope'
    | 'submission_type_mismatch';
}

export interface ParsedGradescopeExport {
  /** All submitters across the export, deduped by sid (roster upsert source). */
  rosterSubmitters: GradescopeSubmitter[];
  /** Submission folders that are real bundles, with their rebuilt ZIPs. */
  bundles: GradescopeBundleEntry[];
  /** Submission folders that could not be processed as bundles. */
  skipped: GradescopeSkippedEntry[];
}

export type ParseExportResult =
  | { ok: true; value: ParsedGradescopeExport }
  | {
      ok: false;
      error: 'not_a_zip' | 'missing_metadata' | 'invalid_metadata';
      detail: string;
    };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Locate the `submission_metadata.yml` entry and return its zip object plus the
 * export's folder prefix (everything before the filename). Picks the shallowest
 * match if more than one exists. Returns null if absent.
 */
function locateMetadata(outer: JSZip): { obj: JSZip.JSZipObject; exportPrefix: string } | null {
  let best: { obj: JSZip.JSZipObject; exportPrefix: string } | null = null;
  for (const [name, obj] of Object.entries(outer.files)) {
    if (obj.dir) continue;
    if (name !== METADATA_FILENAME && !name.endsWith(`/${METADATA_FILENAME}`)) continue;
    if (name.includes('__MACOSX/')) continue;
    const exportPrefix = name.slice(0, name.length - METADATA_FILENAME.length);
    if (best === null || exportPrefix.length < best.exportPrefix.length) {
      best = { obj, exportPrefix };
    }
  }
  return best;
}

/** Materialize one submission folder's files, keyed by folder-relative path. */
async function folderFiles(outer: JSZip, folderPrefix: string): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const [name, obj] of Object.entries(outer.files)) {
    if (obj.dir) continue;
    if (!name.startsWith(folderPrefix)) continue;
    const rel = name.slice(folderPrefix.length);
    if (rel.length === 0) continue;
    files.set(rel, await obj.async('uint8array'));
  }
  return files;
}

/** Dedupe submitters by sid, merging in the first non-empty name/email seen. */
function dedupeSubmitters(all: GradescopeSubmitter[]): GradescopeSubmitter[] {
  const bySid = new Map<string, GradescopeSubmitter>();
  for (const s of all) {
    const existing = bySid.get(s.sid);
    if (existing === undefined) {
      bySid.set(s.sid, { ...s });
    } else {
      if (existing.name === undefined && s.name !== undefined) existing.name = s.name;
      if (existing.email === undefined && s.email !== undefined) existing.email = s.email;
    }
  }
  return Array.from(bySid.values());
}

// ---------------------------------------------------------------------------
// parseGradescopeExport
// ---------------------------------------------------------------------------

export interface ParseGradescopeExportOptions {
  /**
   * Per-assignment scope-resolution config (§6), keyed by the scope's DECLARED
   * `assignment_id`. Defaults to accepting every sealed scope.
   */
  scopeConfigFor?: IngestScopeConfigResolver;
}

export async function parseGradescopeExport(
  zipBytes: ArrayBuffer | Uint8Array,
  options: ParseGradescopeExportOptions = {},
): Promise<ParseExportResult> {
  const scopeConfigFor = options.scopeConfigFor ?? (() => DEFAULT_INGEST_SCOPE);
  let outer: JSZip;
  try {
    outer = await JSZip.loadAsync(zipBytes);
  } catch (e) {
    return { ok: false, error: 'not_a_zip', detail: e instanceof Error ? e.message : String(e) };
  }

  const located = locateMetadata(outer);
  if (located === null) {
    return { ok: false, error: 'missing_metadata', detail: `no ${METADATA_FILENAME} in export` };
  }

  const metaText = await located.obj.async('string');
  const parsed = parseSubmissionMetadata(metaText);
  if (!parsed.ok) {
    return { ok: false, error: 'invalid_metadata', detail: `${parsed.error}: ${parsed.detail}` };
  }

  const bundles: GradescopeBundleEntry[] = [];
  const skipped: GradescopeSkippedEntry[] = [];
  const allSubmitters: GradescopeSubmitter[] = [];

  for (const sub of parsed.value.submissions) {
    allSubmitters.push(...sub.submitters);

    if (sub.submitters.length === 0) {
      skipped.push({
        folderKey: sub.folderKey,
        scopePath: '',
        submitters: [],
        reason: 'no_submitters',
      });
      continue;
    }

    const folderPrefix = `${located.exportPrefix}${sub.folderKey}/`;
    const files = await folderFiles(outer, folderPrefix);

    const discovered = discoverRepoScopes(files);
    if (!discovered.ok) {
      skipped.push({
        folderKey: sub.folderKey,
        scopePath: '',
        submitters: sub.submitters,
        reason: discovered.reason,
      });
      continue;
    }

    const resolved = resolveRepoScopes(discovered.scopes, scopeConfigFor);
    for (const scope of resolved.accepted) {
      bundles.push({
        folderKey: sub.folderKey,
        scopePath: scope.scopePath,
        submitters: sub.submitters,
        bundleZip: await zipBundleEntries(scope.entries),
      });
    }
    for (const unusable of [...discovered.unusable, ...resolved.rejected]) {
      skipped.push({
        folderKey: sub.folderKey,
        scopePath: unusable.scopePath,
        submitters: sub.submitters,
        reason: unusable.reason,
      });
    }
  }

  return {
    ok: true,
    value: {
      rosterSubmitters: dedupeSubmitters(allSubmitters),
      bundles,
      skipped,
    },
  };
}
