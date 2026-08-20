/**
 * unzipBundle — reads a Blob/ArrayBuffer ZIP and returns typed BundleFiles.
 *
 * PRD §5.3: a sealed bundle ZIP contains (flat, no subdirectories):
 *   manifest.json        — BundleManifest (JCS canonical JSON)
 *   manifest.sig         — hex ed25519 signature
 *   session-<uuid>.slog  — NDJSON event log per session
 *   session-<uuid>.slog.meta — JSON meta per session
 *
 * For 1.1 bundles, submission files listed in `manifest.submission_files[].path`
 * are also present at the zip root. These are whitelisted on a two-pass read.
 *
 * A ROLLING-SEALED bundle (program spec §8) has no `manifest.json` at all.
 * Instead it carries one `manifest-<session_id>.json` + `manifest-<session_id>.sig`
 * pair per session, recognized here via log-core's
 * `parseRollingManifestFilename` — never a locally re-spelled pattern, and
 * deliberately not matching `manifest.json`. Both shapes are accepted, including
 * a bundle that carries both; deciding what the rolling files MEAN is
 * `loader/rolling-seal.ts`'s job, not this module's.
 *
 * Any other file produces `unexpected_file`. Orphaned .slog (no .meta) or
 * orphaned .meta (no .slog) produce typed errors. Zero .slog files → no_sessions.
 *
 * Design: pure except for the JSZip async read. No Node APIs; browser-safe.
 */

import JSZip from 'jszip';
import { ok, err, parseRollingManifestFilename, sha256Hex } from '@provenance/log-core';
import type { Result } from '@provenance/log-core';
import { asLogFileId } from './types.js';
import type { BundleFiles, LogFileId, LoaderError, RawRollingSealFiles } from './types.js';

/**
 * Decode a log file's bytes to text AND hash the bytes, in one decompression.
 *
 * The hash MUST be taken over the bytes exactly as they sit in the ZIP, because
 * that is what the signed manifest's `slog_sha256` / `meta_sha256` commit to
 * (see `validation/verify-log-bytes.ts`). Hashing the decoded string instead
 * would round-trip through UTF-8 re-encoding, which is lossy for any byte
 * sequence that is not valid UTF-8 — turning "these bytes were replaced with
 * garbage" into a hash that silently matched whatever the decoder produced.
 *
 * `ignoreBOM: true` keeps the returned text byte-for-byte what
 * `zipObject.async('string')` used to return: JSZip's UTF-8 decode does not
 * strip a leading BOM, and `TextDecoder` does unless told otherwise. Every
 * caller downstream parses this text, so a silently-dropped BOM would be a
 * behaviour change unrelated to this module's job.
 */
async function readLogFile(zipObject: {
  async(type: 'uint8array'): Promise<Uint8Array>;
}): Promise<{ text: string; sha256: string }> {
  const bytes = await zipObject.async('uint8array');
  return {
    text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
    sha256: sha256Hex(bytes),
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANIFEST_JSON = 'manifest.json';
const MANIFEST_SIG = 'manifest.sig';

/**
 * Matches `session-<uuid>.slog` — captures the UUID.
 * Does NOT match `session-<uuid>.slog.meta` (the `$` anchors at .slog end).
 */
const SLOG_RE = /^session-([0-9a-f-]+)\.slog$/;

/**
 * Matches `session-<uuid>.slog.meta` — captures the UUID.
 */
const SLOG_META_RE = /^session-([0-9a-f-]+)\.slog\.meta$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Unzip a bundle and return its raw constituent files.
 *
 * @param input  A `Blob` or `ArrayBuffer` containing the ZIP bytes.
 *               JSZip's `loadAsync` accepts both; passing an ArrayBuffer is
 *               safe in jsdom (Vitest) environments where Blob may behave
 *               differently. Callers may pass either.
 */
export async function unzipBundle(
  input: Blob | ArrayBuffer,
): Promise<Result<BundleFiles, LoaderError>> {
  // ---------------------------------------------------------------------------
  // 1. Parse the ZIP.
  // ---------------------------------------------------------------------------
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input);
  } catch (e) {
    return err({
      kind: 'not_a_zip',
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  // ---------------------------------------------------------------------------
  // 2. First pass: read manifest + sig + known provenance files; defer the rest.
  //
  // We must read manifest.json before we can whitelist submission files, so
  // unrecognized entries are deferred until after the manifest is parsed.
  // ---------------------------------------------------------------------------

  let manifestJson: string | null = null;
  let manifestSigHex: string | null = null;
  /** Rolling seal halves, keyed by the session id in the filename. */
  const rollingJson = new Map<string, string>();
  const rollingSig = new Map<string, string>();
  // Keyed by the `.slog` FILENAME uuid — a LogFileId, never a logical session
  // id. Those are two different values in production and the brand is what stops
  // the next reader keying one map with the other. See `types.ts`.
  const slogIds = new Set<LogFileId>();
  const metaIds = new Set<LogFileId>();
  const slogContents = new Map<LogFileId, { text: string; sha256: string }>();
  const metaContents = new Map<LogFileId, { text: string; sha256: string }>();
  // Deferred: entries that are neither manifest/sig nor slog/meta — may be
  // submission files (whitelisted below) or genuinely unexpected files.
  type ZipFileObject = Awaited<ReturnType<typeof JSZip.loadAsync>>['files'][string];
  const deferred: Array<[string, ZipFileObject]> = [];

  for (const [filename, zipObject] of Object.entries(zip.files)) {
    // Skip directories (JSZip may include them).
    if (zipObject.dir) {
      continue;
    }

    if (filename === MANIFEST_JSON) {
      manifestJson = await zipObject.async('string');
      continue;
    }

    if (filename === MANIFEST_SIG) {
      manifestSigHex = (await zipObject.async('string')).trim();
      continue;
    }

    // `manifest-<session_id>.json` / `.sig` — the rolling seal. The pattern is
    // log-core's, so recorder and analyzer cannot drift; it does not match
    // `manifest.json`, which the two branches above already consumed anyway.
    const rolling = parseRollingManifestFilename(filename);
    if (rolling !== null) {
      if (rolling.part === 'json') {
        rollingJson.set(rolling.sessionId, await zipObject.async('string'));
      } else {
        rollingSig.set(rolling.sessionId, (await zipObject.async('string')).trim());
      }
      continue;
    }

    const slogMatch = SLOG_RE.exec(filename);
    if (slogMatch !== null) {
      const logFileId = asLogFileId(slogMatch[1]!);
      slogIds.add(logFileId);
      slogContents.set(logFileId, await readLogFile(zipObject));
      continue;
    }

    const metaMatch = SLOG_META_RE.exec(filename);
    if (metaMatch !== null) {
      const logFileId = asLogFileId(metaMatch[1]!);
      metaIds.add(logFileId);
      metaContents.set(logFileId, await readLogFile(zipObject));
      continue;
    }

    // Unknown — defer until we know the submission file whitelist.
    deferred.push([filename, zipObject]);
  }

  const rollingSealIds = [...new Set([...rollingJson.keys(), ...rollingSig.keys()])].sort();

  if (manifestJson === null) {
    // No classic manifest AND no rolling manifest — nothing seals this bundle.
    // This is the `no_seal` case, and it is the same error it has always been.
    //
    // A stray classic `manifest.sig` with no `manifest.json` is also
    // `missing_manifest`, rolling seals present or not: a classic signature whose
    // manifest is gone is exactly what that error names, and it was already a
    // hard error before the rolling seal existed.
    if (rollingSealIds.length === 0 || manifestSigHex !== null) {
      return err({ kind: 'missing_manifest' });
    }
  } else if (manifestSigHex === null) {
    // A classic manifest with no classic signature. The rolling seals cannot
    // stand in for it — they sign their own sessions, not this manifest.
    return err({ kind: 'missing_signature' });
  }

  // ---------------------------------------------------------------------------
  // 3. Build the submission-file whitelist from the manifest (best-effort parse).
  //
  // Full shape validation happens later in parse-bundle. Here we only need the
  // `submission_files[].path` strings to decide which deferred entries are OK.
  // A malformed manifest (bad JSON / missing key) → empty whitelist, so every
  // deferred entry will trigger unexpected_file (parse-bundle will then surface
  // the manifest error independently).
  // ---------------------------------------------------------------------------
  // On a rolling-sealed bundle the whitelist is the UNION over every rolling
  // manifest, since each one lists the files under review as of its own session.
  const submissionPaths = new Set<string>();
  const collectSubmissionPaths = (text: string): void => {
    try {
      const parsed = JSON.parse(text) as { submission_files?: Array<{ path?: unknown }> };
      for (const f of parsed.submission_files ?? []) {
        if (typeof f?.path === 'string') {
          submissionPaths.add(f.path);
        }
      }
    } catch {
      // Malformed manifest JSON — parse-bundle will surface invalid_manifest, or
      // rolling-seal.ts will surface an `invalid_json` defect. Leave this
      // manifest out of the whitelist.
    }
  };
  if (manifestJson !== null) {
    collectSubmissionPaths(manifestJson);
  }
  for (const sessionId of rollingSealIds) {
    const text = rollingJson.get(sessionId);
    if (text !== undefined) {
      collectSubmissionPaths(text);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Process deferred entries: whitelist submission files; reject everything else.
  // ---------------------------------------------------------------------------
  const submissionFiles = new Map<string, Uint8Array>();
  for (const [filename, zipObject] of deferred) {
    if (submissionPaths.has(filename)) {
      submissionFiles.set(filename, await zipObject.async('uint8array'));
    } else {
      return err({ kind: 'unexpected_file', filename, detail: 'not a recognized bundle file' });
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Structural checks.
  // ---------------------------------------------------------------------------

  if (slogIds.size === 0) {
    return err({ kind: 'no_sessions' });
  }

  // Check for orphaned .slog.meta (meta without matching slog).
  for (const metaId of metaIds) {
    if (!slogIds.has(metaId)) {
      return err({ kind: 'orphaned_meta', sessionId: metaId });
    }
  }

  // Check for orphaned .slog (slog without matching meta).
  for (const slogId of slogIds) {
    if (!metaIds.has(slogId)) {
      return err({ kind: 'orphaned_slog', sessionId: slogId });
    }
  }

  // ---------------------------------------------------------------------------
  // 6. Build the result.
  // ---------------------------------------------------------------------------

  const sessions = Array.from(slogIds).map((logFileId) => {
    const slog = slogContents.get(logFileId)!;
    const meta = metaContents.get(logFileId)!;
    return {
      logFileId,
      slogText: slog.text,
      metaJson: meta.text,
      slogSha256: slog.sha256,
      metaSha256: meta.sha256,
    };
  });

  const rollingSeals: RawRollingSealFiles[] = rollingSealIds.map((sessionId) => ({
    sessionId,
    manifestJson: rollingJson.get(sessionId) ?? null,
    sigHex: rollingSig.get(sessionId) ?? null,
  }));

  return ok({
    manifestJson,
    manifestSigHex,
    rollingSeals,
    sessions,
    submissionFiles,
  });
}
