/**
 * Phase 3 of the per-file ingest pipeline: parse bundle (PRD §9.3).
 *
 * Reads the staged blob from object storage and parses it via the analyzer's
 * `loadBundle` function (which delegates to log-core). Returns the parsed
 * Bundle on success or a structured error on failure.
 *
 * This is the server-side wrapper around the loader. It does NOT materialize
 * events (Phase 10) — it only parses enough to extract the manifest and
 * session metadata needed by later pipeline phases (matchStudent,
 * createSubmission).
 *
 * Design: the function returns a discriminated result rather than throwing.
 * The worker catches the error and marks `ingest_files.status='failed'` with
 * `error: { phase: 'parse_bundle', cause, detail? }`.
 */

import { getBlob } from '../storage/blobs.js';
import type { StorageClient } from '../storage/client.js';
import { recordPhase } from '../../jobs/ingest-profile.js';
import { getLogger } from '../../logging.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { LoaderError, SessionParseError } from '@provenance/analysis-core/loader/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParseBundlePhaseSuccess = {
  ok: true;
  bundle: Bundle;
};

export type ParseBundlePhaseError = {
  ok: false;
  phase: 'parse_bundle';
  cause: string;
  detail?: string | undefined;
};

export type ParseBundlePhaseResult = ParseBundlePhaseSuccess | ParseBundlePhaseError;

// ---------------------------------------------------------------------------
// parseBundlePhase
// ---------------------------------------------------------------------------

/**
 * Read a staged blob from object storage and parse it as a bundle ZIP.
 *
 * Returns `{ ok: true, bundle }` on success.
 * Returns `{ ok: false, phase, cause, detail? }` on any failure — the worker
 * maps this to `ingest_files.status='failed'` with the structured error.
 *
 * Errors caught here:
 *   - Object-storage retrieval failures (network / auth / missing key).
 *   - Any loader error (not_a_zip, missing_manifest, invalid_manifest,
 *     ndjson_parse_failed, etc.).
 *
 * The function does NOT propagate throws — all failures surface as the error
 * variant of the discriminated result.
 */
export async function parseBundlePhase(
  storageClient: StorageClient,
  blobKey: string,
  originalFilename: string,
): Promise<ParseBundlePhaseResult> {
  // -------------------------------------------------------------------------
  // Step 1: Read blob from object storage.
  // -------------------------------------------------------------------------
  const blobReadStart = performance.now();
  let blobStream: ReadableStream<Uint8Array>;
  try {
    blobStream = await getBlob(storageClient, blobKey);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, phase: 'parse_bundle', cause: 'blob_read_failed', detail };
  }

  // Buffer the stream into an ArrayBuffer so we can pass it to loadBundle.
  let blobBuffer: ArrayBuffer;
  try {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = blobStream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      totalBytes += value.byteLength;
    }
    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    blobBuffer = combined.buffer as ArrayBuffer;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, phase: 'parse_bundle', cause: 'blob_read_failed', detail };
  }
  recordPhase('parse:blob_read', performance.now() - blobReadStart);

  // -------------------------------------------------------------------------
  // Step 2: Parse via analyzer loader (unzip + JCS hash chain + ed25519 verify).
  // -------------------------------------------------------------------------
  const loadStart = performance.now();
  let parseResult: Awaited<ReturnType<typeof loadBundle>>;
  try {
    parseResult = await loadBundle(blobBuffer, originalFilename);
  } catch (err) {
    // loadBundle should not throw for valid inputs; if it does it's a bug.
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, phase: 'parse_bundle', cause: 'loader_threw', detail };
  }
  recordPhase('parse:load+crypto', performance.now() - loadStart);

  if (!parseResult.ok) {
    const detail = errorDetail(parseResult.error);
    const errResult: ParseBundlePhaseError = {
      ok: false,
      phase: 'parse_bundle',
      cause: parseResult.error.kind,
      ...(detail !== undefined && { detail }),
    };
    return errResult;
  }

  const bundle = parseResult.value;

  // -------------------------------------------------------------------------
  // Report anything the loader could not analyse.
  //
  // `analysis-core`'s read-side orphan guard no longer fails a whole submission
  // over a leftover `.slog.meta`, a zero-byte `.slog`, a quarantined
  // `.corrupt-*` log or an orphaned rolling seal — the shapes a GIT submission
  // carries because no seal step ran to filter them. It drops them and records
  // them instead, which is only the right trade if the drop is visible: a silent
  // exclusion is worse than the hard error it replaces.
  //
  // Logged at `warn`, NOT stored as an ingest failure and NOT turned into a
  // finding. The submission ingested successfully and its sessions were analysed
  // in full; this says the RECORDING was incomplete, not that anything is wrong
  // with it. `ingest_files.error` is reserved for files that did not ingest.
  //
  // Read paths need no persistence for this: they re-parse the stored bundle
  // through `loadSubmissionIndex`, so `bundle.droppedArtifacts` is recomputed
  // and available on every one of them.
  // -------------------------------------------------------------------------
  if (bundle.droppedArtifacts.length > 0) {
    getLogger().warn(
      {
        filename: originalFilename,
        droppedArtifacts: bundle.droppedArtifacts.map((a) => ({
          kind: a.kind,
          filename: a.filename,
        })),
        analysedSessions: bundle.sessions.length,
      },
      'incomplete recording: artifacts left out of analysis (not an integrity finding)',
    );
  }

  return { ok: true, bundle };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function errorDetail(error: LoaderError | SessionParseError): string | undefined {
  // Surface any human-readable detail stored on the error variants.
  const e = error as Record<string, unknown>;

  // Loader errors.
  if (typeof e['detail'] === 'string') return e['detail'];

  // SessionParseError variants.
  if (typeof e['line'] === 'number') {
    return `line ${String(e['line'])}${typeof e['detail'] === 'string' ? `: ${e['detail']}` : ''}`;
  }
  if (typeof e['actualKind'] === 'string') return `actualKind: ${e['actualKind']}`;
  // `session_id_mismatch`. Both values ARE logical session ids — but bare
  // `slog=` / `meta=` reads as "the file called this", which sends a grader
  // searching for `session-<value>.slog`. No file is named that. Say what the
  // values are and where they were read from.
  if (typeof e['slogSessionId'] === 'string' && typeof e['metaSessionId'] === 'string') {
    return (
      `logical session id in the .slog's session.start=${String(e['slogSessionId'])} ` +
      `but in its .slog.meta=${String(e['metaSessionId'])} ` +
      `(logical session ids, not filenames)`
    );
  }
  // The `.slog` FILENAME uuid, from `orphaned_meta` / `orphaned_slog`. Labelling
  // it `sessionId:` sent a grader searching the archive for a session that does
  // not exist under that id — on a failure path, which is exactly when they are
  // looking. Name the file instead, and say which space it is.
  //
  // Reachability: the loader no longer fails a bundle on either orphan shape
  // (`analysis-core`'s read-side orphan guard drops and reports the artifact
  // instead), so no NEW row takes this branch. It is kept correct because
  // `ingest_files.error` rows written before that change persist forever and are
  // still read by staff — the same reason the analyzer's `ErrorPanel` keeps its
  // two cases.
  if (typeof e['sessionId'] === 'string') {
    return `log file: session-${String(e['sessionId'])}.slog (.slog filename uuid, not a session id)`;
  }

  return undefined;
}
