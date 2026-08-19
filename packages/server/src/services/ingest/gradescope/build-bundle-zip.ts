/**
 * Rebuild a sealed-bundle ZIP from an unzipped Gradescope submission folder.
 *
 * Gradescope unzips each student's submitted bundle on upload, so in the export
 * a submission appears as a *folder* (e.g. `submission_409194023/`) rather than
 * a `.zip`. The recorder's seal (recorder PRD §5.3, seal.ts) produces a FLAT
 * bundle ZIP — `manifest.json`, `manifest.sig`, `session-*.slog`,
 * `session-*.slog.meta`, and any submission files all at the ZIP root — and the
 * analyzer loader (`loader/unzip.ts`) requires exactly that flat shape, rejecting
 * any unrecognized file.
 *
 * This module reconstructs that flat ZIP from a folder so the existing parse →
 * validation → heuristics pipeline can consume it unchanged. It is robust to
 * both observed folder layouts:
 *   - provenance files nested under `<folder>/.provenance/…` (we strip the prefix), and
 *   - provenance files flat at `<folder>/…`.
 * Only recognized provenance files plus the manifest-whitelisted submission
 * files are included; macOS junk (`.DS_Store`, `__MACOSX/`, AppleDouble `._*`)
 * and any other stray files are dropped so the loader never sees an unexpected
 * entry.
 *
 * Pure with respect to business logic; the only effect is JSZip in/out.
 */

import JSZip from 'jszip';
import { parseRollingManifestFilename } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVENANCE_PREFIX = '.provenance/';
const MANIFEST_JSON = 'manifest.json';
const MANIFEST_SIG = 'manifest.sig';
const SLOG_RE = /^session-[0-9a-fA-F-]+\.slog$/;
const SLOG_META_RE = /^session-[0-9a-fA-F-]+\.slog\.meta$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BuildBundleZipResult =
  | { ok: true; data: ArrayBuffer }
  /** The folder carries no manifest at all (classic or rolling) — not a bundle. */
  | { ok: false; reason: 'no_manifest' };

/** One flat bundle-root entry, ready to be zipped. */
export interface BundleEntry {
  name: string;
  data: Uint8Array;
}

export type SelectBundleEntriesResult =
  | { ok: true; entries: BundleEntry[] }
  | { ok: false; reason: 'no_manifest' };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** macOS archive noise that must never reach the bundle loader. */
function isJunkPath(relPath: string): boolean {
  if (relPath.includes('__MACOSX/')) return true;
  return relPath.split('/').some((seg) => seg === '.DS_Store' || seg.startsWith('._'));
}

/** Normalize a folder-relative path to its bundle-root equivalent. */
function toBundlePath(relPath: string): string {
  return relPath.startsWith(PROVENANCE_PREFIX) ? relPath.slice(PROVENANCE_PREFIX.length) : relPath;
}

/**
 * A recognized provenance file, classic or rolling.
 *
 * `manifest-<session_id>.json` / `.sig` is the ROLLING seal (program spec §8):
 * a git-submitted scope has no classic `manifest.json`, and these files are the
 * only thing sealing it, so they must survive selection. The pattern is
 * log-core's — never re-spelled locally — and deliberately does not match
 * `manifest.json` (handled above) or a decoy like `manifest-notes.json`.
 */
function isProvenanceFile(bundlePath: string): boolean {
  return (
    bundlePath === MANIFEST_JSON ||
    bundlePath === MANIFEST_SIG ||
    parseRollingManifestFilename(bundlePath) !== null ||
    SLOG_RE.test(bundlePath) ||
    SLOG_META_RE.test(bundlePath)
  );
}

/** Best-effort read of submission_files[].path from raw manifest JSON, into `into`. */
function collectSubmissionPaths(manifestJson: string, into: Set<string>): void {
  try {
    const parsed = JSON.parse(manifestJson) as { submission_files?: Array<{ path?: unknown }> };
    for (const f of parsed.submission_files ?? []) {
      if (typeof f?.path === 'string') into.add(f.path);
    }
  } catch {
    // Malformed manifest — the parse phase will surface invalid_manifest later.
  }
}

// ---------------------------------------------------------------------------
// buildBundleZipFromFiles (core)
// ---------------------------------------------------------------------------

/**
 * Rebuild a flat bundle ZIP from one submission folder's already-materialized
 * files, keyed by folder-relative path (e.g. `manifest.json`,
 * `.provenance/manifest.json`, `hw10.py`).
 *
 * This is the storage-agnostic core: it takes raw bytes per path rather than a
 * JSZip handle, so both the in-memory JSZip path (`buildBundleZipForFolder`)
 * and the streaming local-path reader (`stream-export.ts`, which extracts one
 * folder at a time from disk) share identical selection/whitelist logic.
 *
 * @param files Map of folder-relative path → file bytes for ONE submission
 *              folder. Directory entries must already be excluded.
 * @returns `{ ok: true, data }` with the rebuilt ZIP bytes, or
 *          `{ ok: false, reason: 'no_manifest' }` when the folder is not a bundle.
 */
export async function buildBundleZipFromFiles(
  files: Map<string, Uint8Array>,
): Promise<BuildBundleZipResult> {
  const selected = selectBundleEntries(files);
  if (!selected.ok) return selected;
  return { ok: true, data: await zipBundleEntries(selected.entries) };
}

/**
 * The cheap half of {@link buildBundleZipFromFiles}: apply the junk/whitelist
 * selection and `.provenance/`-prefix normalization, returning the flat entries
 * that make up the bundle — in the exact order they must be zipped. No ZIP work
 * happens here, so this stays fast enough to run on the serial staging producer
 * while the (expensive) {@link zipBundleEntries} step is offloaded to a worker.
 *
 * Entry order is significant: it is the order the entries are written into the
 * ZIP, which fixes the archive's byte layout and therefore its sha256 (the
 * Gradescope dedup key). Keep it identical to the historical single-pass order.
 */
export function selectBundleEntries(files: Map<string, Uint8Array>): SelectBundleEntriesResult {
  const candidates = new Map<string, Uint8Array>();
  let manifestJsonBytes: Uint8Array | null = null;
  /** Rolling-seal `manifest-<session_id>.json` bytes, keyed by session id. */
  const rollingManifestJson = new Map<string, Uint8Array>();

  for (const [rel, bytes] of files) {
    if (rel.length === 0 || isJunkPath(rel)) continue;

    const bundlePath = toBundlePath(rel);
    // Prefer a `.provenance/`-nested entry over a flat one on collision: a
    // stripped path wins because it is the canonical bundle location.
    const isStripped = rel.startsWith(PROVENANCE_PREFIX);
    if (!candidates.has(bundlePath) || isStripped) {
      candidates.set(bundlePath, bytes);
    }

    if (bundlePath === MANIFEST_JSON && (isStripped || manifestJsonBytes === null)) {
      manifestJsonBytes = bytes;
    }

    const rolling = parseRollingManifestFilename(bundlePath);
    if (rolling !== null && rolling.part === 'json') {
      if (isStripped || !rollingManifestJson.has(rolling.sessionId)) {
        rollingManifestJson.set(rolling.sessionId, bytes);
      }
    }
  }

  // A scope is sealed by the classic manifest OR by at least one rolling
  // manifest (program spec §8). A git-submitted scope only ever has the latter,
  // and requiring `manifest.json` here is what used to discard it outright.
  if (manifestJsonBytes === null && rollingManifestJson.size === 0) {
    return { ok: false, reason: 'no_manifest' };
  }

  // The whitelist is the UNION over every manifest present: each rolling
  // manifest lists the files under review as of its own session, so a file
  // touched only in session 2 is named only by session 2's manifest. This
  // mirrors `loader/unzip.ts`, which builds the same union on the read side.
  // Session ids are visited in sorted order so the result is deterministic
  // regardless of the input map's iteration order.
  const submissionPaths = new Set<string>();
  if (manifestJsonBytes !== null) {
    collectSubmissionPaths(new TextDecoder().decode(manifestJsonBytes), submissionPaths);
  }
  for (const sessionId of [...rollingManifestJson.keys()].sort()) {
    collectSubmissionPaths(
      new TextDecoder().decode(rollingManifestJson.get(sessionId)!),
      submissionPaths,
    );
  }

  const entries: BundleEntry[] = [];
  for (const [bundlePath, bytes] of candidates) {
    if (!isProvenanceFile(bundlePath) && !submissionPaths.has(bundlePath)) {
      continue; // not a recognized bundle file — drop it
    }
    entries.push({ name: bundlePath, data: bytes });
  }
  return { ok: true, entries };
}

/**
 * The expensive half: serialize pre-selected entries into a flat STORE ZIP.
 * Kept byte-identical to the historical `new JSZip(); file(...); generateAsync`
 * path (same entries, same order) so the archive sha256 is unchanged — the
 * `rebuild-pool` worker performs the exact same steps off-thread.
 */
export async function zipBundleEntries(entries: BundleEntry[]): Promise<ArrayBuffer> {
  const out = new JSZip();
  for (const e of entries) out.file(e.name, e.data);
  return out.generateAsync({ type: 'arraybuffer' });
}

// ---------------------------------------------------------------------------
// buildBundleZipForFolder (JSZip adapter)
// ---------------------------------------------------------------------------

/**
 * Rebuild a flat bundle ZIP from the entries of one submission folder of a
 * loaded export ZIP. Thin adapter over `buildBundleZipFromFiles`.
 *
 * @param outer        The loaded export ZIP.
 * @param folderPrefix The folder's prefix within `outer`, INCLUDING the trailing
 *                     slash (e.g. `assignment_8046601_export/submission_409194023/`).
 * @returns `{ ok: true, data }` with the rebuilt ZIP bytes, or
 *          `{ ok: false, reason: 'no_manifest' }` when the folder is not a bundle.
 */
export async function buildBundleZipForFolder(
  outer: JSZip,
  folderPrefix: string,
): Promise<BuildBundleZipResult> {
  const files = new Map<string, Uint8Array>();
  for (const [name, obj] of Object.entries(outer.files)) {
    if (obj.dir) continue;
    if (!name.startsWith(folderPrefix)) continue;
    const rel = name.slice(folderPrefix.length);
    if (rel.length === 0) continue;
    files.set(rel, await obj.async('uint8array'));
  }
  return buildBundleZipFromFiles(files);
}
