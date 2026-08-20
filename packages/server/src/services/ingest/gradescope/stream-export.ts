/**
 * Stream a Gradescope assignment export ZIP from a local file path, yielding one
 * submission at a time so peak memory is a single rebuilt bundle (~tens of MB)
 * regardless of the total export size (10 GB+).
 *
 * This is the random-access counterpart to `parse-export.ts` (which loads the
 * whole export into JSZip in memory and therefore trips a ~2 GiB-class ceiling).
 * It uses `yauzl` to read the ZIP central directory up front — filenames and
 * offsets only, no file bytes — then opens a read stream per entry on demand:
 *
 *   1. drain the central directory (cheap; metadata only, even at 10 GB),
 *   2. locate + read `submission_metadata.yml` (small) → submitters,
 *   3. bucket the remaining entries by submission folder (Entry refs, not bytes),
 *   4. an async generator extracts ONE folder's bytes at a time, rebuilds its
 *      flat bundle via `buildBundleZipFromFiles`, yields it, and releases it
 *      before moving to the next folder.
 *
 * The shared selection/whitelist logic lives in `build-bundle-zip.ts`; metadata
 * parsing in `parse-metadata.ts`. This module only adds the on-disk, bounded-
 * memory outer read.
 */

import yauzl from 'yauzl';
import { parseSubmissionMetadata, type GradescopeSubmitter } from './parse-metadata.js';
import type { BundleEntry } from './build-bundle-zip.js';
import {
  discoverRepoScopes,
  resolveRepoScopes,
  DEFAULT_INGEST_SCOPE,
  type IngestScopeConfigResolver,
} from './repo-scopes.js';

const METADATA_FILENAME = 'submission_metadata.yml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Why one scope of a submission folder produced no bundle. */
export type StreamedSkipReason =
  | 'no_manifest'
  | 'no_submitters'
  | 'no_seal'
  | 'scope_excluded'
  | 'ambiguous_scope'
  | 'submission_type_mismatch';

/**
 * One assignment scope of one submission, streamed: either the selected bundle
 * entries (ready to zip) or a skip. The expensive ZIP serialization is
 * intentionally NOT done here — the caller offloads `zipBundleEntries` to a
 * worker pool so rebuilds run in parallel rather than serially on this
 * generator's thread.
 *
 * A submission folder yields ONE item per discovered scope, so a git repo with
 * `proj2/` and `lab5/` yields two bundles. A classic flat Gradescope folder has
 * exactly one scope (`scopePath: ''`) and therefore yields exactly one item,
 * unchanged from before fan-out existed.
 */
export type StreamedSubmission =
  | {
      kind: 'bundle';
      folderKey: string;
      /** `''` for the folder root, else the scope's directory prefix (`proj2/`). */
      scopePath: string;
      submitters: GradescopeSubmitter[];
      entries: BundleEntry[];
    }
  | {
      kind: 'skipped';
      folderKey: string;
      scopePath: string;
      submitters: GradescopeSubmitter[];
      reason: StreamedSkipReason;
    };

export interface OpenLocalExportOptions {
  /**
   * Per-assignment scope-resolution config (§6), keyed by the scope's DECLARED
   * `assignment_id`. Defaults to accepting every sealed scope.
   */
  scopeConfigFor?: IngestScopeConfigResolver;
}

export type OpenLocalExportResult =
  | { ok: false; error: 'not_a_zip' | 'missing_metadata' | 'invalid_metadata'; detail: string }
  | {
      ok: true;
      /** All submitters across the export, deduped by sid (roster upsert source). */
      rosterSubmitters: GradescopeSubmitter[];
      /** Yields one submission at a time; iterate to completion (bounded memory). */
      submissions: () => AsyncGenerator<StreamedSubmission, void, void>;
      /** Release the underlying file handle. Always call when done. */
      close: () => Promise<void>;
    };

// ---------------------------------------------------------------------------
// yauzl promisified helpers
// ---------------------------------------------------------------------------

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // lazyEntries: pull entries one-by-one (we drive the cursor); autoClose
    // false: keep the fd open so we can random-access entries after draining
    // the central directory.
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || zip === undefined) {
        reject(err ?? new Error('yauzl.open returned no zipfile'));
        return;
      }
      resolve(zip);
    });
  });
}

/** Drain the entire central directory into memory (metadata only, no bytes). */
function readAllEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on('entry', (entry: yauzl.Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

/** Read one entry's decompressed bytes via a fresh read stream. */
function readEntryBytes(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || stream === undefined) {
        reject(err ?? new Error('openReadStream returned no stream'));
        return;
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

function closeZip(zip: yauzl.ZipFile): Promise<void> {
  return new Promise((resolve) => {
    zip.on('close', () => resolve());
    zip.close();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDirEntry(entry: yauzl.Entry): boolean {
  return entry.fileName.endsWith('/');
}

/**
 * Locate the metadata entry and return it plus the export's folder prefix
 * (everything before the filename). Picks the shallowest match; ignores macOS
 * archive noise. Returns null when absent.
 */
function locateMetadata(
  entries: yauzl.Entry[],
): { entry: yauzl.Entry; exportPrefix: string } | null {
  let best: { entry: yauzl.Entry; exportPrefix: string } | null = null;
  for (const entry of entries) {
    if (isDirEntry(entry)) continue;
    const name = entry.fileName;
    if (name.includes('__MACOSX/')) continue;
    if (name !== METADATA_FILENAME && !name.endsWith(`/${METADATA_FILENAME}`)) continue;
    const exportPrefix = name.slice(0, name.length - METADATA_FILENAME.length);
    if (best === null || exportPrefix.length < best.exportPrefix.length) {
      best = { entry, exportPrefix };
    }
  }
  return best;
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
// openLocalExport
// ---------------------------------------------------------------------------

/**
 * Open a Gradescope export ZIP at `archivePath` for streaming ingest.
 *
 * On success returns the deduped roster submitters plus a `submissions()` async
 * generator. The caller MUST iterate `submissions()` to completion (or stop and
 * call `close()`), then `close()` to release the file handle.
 */
export async function openLocalExport(
  archivePath: string,
  options: OpenLocalExportOptions = {},
): Promise<OpenLocalExportResult> {
  const scopeConfigFor = options.scopeConfigFor ?? (() => DEFAULT_INGEST_SCOPE);
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(archivePath);
  } catch (e) {
    return { ok: false, error: 'not_a_zip', detail: e instanceof Error ? e.message : String(e) };
  }

  let entries: yauzl.Entry[];
  try {
    entries = await readAllEntries(zip);
  } catch (e) {
    await closeZip(zip);
    return { ok: false, error: 'not_a_zip', detail: e instanceof Error ? e.message : String(e) };
  }

  const located = locateMetadata(entries);
  if (located === null) {
    await closeZip(zip);
    return { ok: false, error: 'missing_metadata', detail: `no ${METADATA_FILENAME} in export` };
  }

  let metaText: string;
  try {
    metaText = new TextDecoder().decode(await readEntryBytes(zip, located.entry));
  } catch (e) {
    await closeZip(zip);
    return { ok: false, error: 'not_a_zip', detail: e instanceof Error ? e.message : String(e) };
  }

  const parsed = parseSubmissionMetadata(metaText);
  if (!parsed.ok) {
    await closeZip(zip);
    return { ok: false, error: 'invalid_metadata', detail: `${parsed.error}: ${parsed.detail}` };
  }
  // Capture the narrowed value: the generator closure below would otherwise
  // lose the `parsed.ok` narrowing.
  const meta = parsed.value;

  // Bucket non-metadata entries by submission folder (Entry refs only — no
  // bytes are read here). Key = folder name; value = {rel, entry} where rel is
  // the path within the folder (the input shape buildBundleZipFromFiles wants).
  const byFolder = new Map<string, Array<{ rel: string; entry: yauzl.Entry }>>();
  const exportPrefix = located.exportPrefix;
  for (const entry of entries) {
    if (isDirEntry(entry)) continue;
    const name = entry.fileName;
    if (!name.startsWith(exportPrefix)) continue;
    const rest = name.slice(exportPrefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) continue; // a file directly under the export root (e.g. the metadata) — not a folder
    const folderKey = rest.slice(0, slash);
    const rel = rest.slice(slash + 1);
    if (rel.length === 0) continue;
    let bucket = byFolder.get(folderKey);
    if (bucket === undefined) {
      bucket = [];
      byFolder.set(folderKey, bucket);
    }
    bucket.push({ rel, entry });
  }

  const rosterSubmitters = dedupeSubmitters(meta.submissions.flatMap((s) => s.submitters));

  async function* submissions(): AsyncGenerator<StreamedSubmission, void, void> {
    for (const sub of meta.submissions) {
      if (sub.submitters.length === 0) {
        yield {
          kind: 'skipped',
          folderKey: sub.folderKey,
          scopePath: '',
          submitters: [],
          reason: 'no_submitters',
        };
        continue;
      }

      // Materialize ONLY this folder's bytes, fan out, yield, release.
      const bucket = byFolder.get(sub.folderKey) ?? [];
      const files = new Map<string, Uint8Array>();
      for (const { rel, entry } of bucket) {
        files.set(rel, await readEntryBytes(zip, entry));
      }

      const discovered = discoverRepoScopes(files);
      if (!discovered.ok) {
        yield {
          kind: 'skipped',
          folderKey: sub.folderKey,
          scopePath: '',
          submitters: sub.submitters,
          reason: discovered.reason,
        };
        continue;
      }

      const resolved = resolveRepoScopes(discovered.scopes, scopeConfigFor);
      for (const scope of resolved.accepted) {
        yield {
          kind: 'bundle',
          folderKey: sub.folderKey,
          scopePath: scope.scopePath,
          submitters: sub.submitters,
          entries: scope.entries,
        };
      }
      // Scopes that exist but produce no submission are reported, never
      // silently dropped — a `.provenance/` that nothing seals (neither a
      // classic nor a rolling manifest), or one excluded by scope config,
      // still needs to be visible in the job summary.
      for (const unusable of [...discovered.unusable, ...resolved.rejected]) {
        yield {
          kind: 'skipped',
          folderKey: sub.folderKey,
          scopePath: unusable.scopePath,
          submitters: sub.submitters,
          reason: unusable.reason,
        };
      }
    }
  }

  return {
    ok: true,
    rosterSubmitters,
    submissions,
    close: () => closeZip(zip),
  };
}
