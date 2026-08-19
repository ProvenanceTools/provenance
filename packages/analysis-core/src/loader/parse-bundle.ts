/**
 * loadBundle — orchestrates unzip + per-session parse into a typed Bundle.
 * parseBundles — fan-out wrapper that loads N blobs and returns Bundle[] + per-blob errors.
 *
 * PRD §5.1, §5.3, §4.6.
 *
 * Steps (loadBundle):
 *   1. Unzip → BundleFiles (or LoaderError).
 *   2. Parse sessions in parallel (order-independent per CLAUDE.md rule on Promise.all).
 *   3. Sort sessions by firstEvent.wall ascending.
 *   4. Validate manifest JSON shape via log-core's validateBundleManifestShape.
 *   5. Assign a stable id via crypto.randomUUID() (WebCrypto, available in browsers + jsdom).
 *   6. Return Bundle.
 *
 * TWO SEAL SHAPES. A classic bundle is sealed once into `manifest.json` +
 * `manifest.sig`. A git-submitted bundle is ROLLING-sealed: one
 * `manifest-<session_id>.json` + `.sig` per session, each covering only its own
 * session and signed by that session's own key (program spec §8). Both are
 * accepted here. For a rolling bundle `bundle.manifest` is the SYNTHESIZED union
 * at `format_version: '1.2'` and `bundle.rollingSeal` carries the per-session
 * seals that check 1 verifies individually. A bundle with no rolling manifests
 * takes the identical path it always took and never gets a `rollingSeal`.
 *
 * NOTE: signature verification is NOT done here — that is Phase 2
 * (validation/verify-manifest-sig.ts). The loader checks structure only.
 */

import { validateBundleManifestShape, sha256Hex, ok, err } from '@provenance/log-core';
import type { BundleManifest, Result } from '@provenance/log-core';
import { unzipBundle } from './unzip.js';
import { parseSession } from './parse-session.js';
import {
  validateRollingSeals,
  reconcileRollingSealsWithSessions,
  synthesizeRollingUnionManifest,
} from './rolling-seal.js';
import type {
  Bundle,
  BundleRollingSeal,
  LoaderError,
  RollingSealDefect,
  SessionParseError,
} from './types.js';

// ---------------------------------------------------------------------------
// Multi-bundle types
// ---------------------------------------------------------------------------

/** Per-blob load error from parseBundles. */
export type BlobLoadError = {
  /** Zero-based index into the Blob[] that was passed to parseBundles. */
  index: number;
  filename: string;
  error: LoaderError | SessionParseError;
};

/** Result of parseBundles — successes + per-blob failures. */
export type ParseBundlesResult = {
  bundles: Bundle[];
  errors: BlobLoadError[];
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load a bundle ZIP into a fully typed Bundle.
 *
 * @param input           A Blob or ArrayBuffer containing the ZIP bytes.
 * @param sourceFilename  The original filename (e.g. "hw1-bundle-2026-05-19.zip").
 * @param nowFn           Injectable clock for `loadedAt` — defaults to Date.
 *                        Inject a fixed value in tests to get deterministic output.
 */
export async function loadBundle(
  input: Blob | ArrayBuffer,
  sourceFilename: string,
  nowFn: () => string = () => new Date().toISOString(),
): Promise<Result<Bundle, LoaderError | SessionParseError>> {
  // ---------------------------------------------------------------------------
  // Step 1: Unzip.
  // ---------------------------------------------------------------------------
  const unzipResult = await unzipBundle(input);
  if (!unzipResult.ok) {
    return unzipResult;
  }

  const {
    manifestJson,
    manifestSigHex,
    rollingSeals: rawRollingSeals,
    sessions: sessionFiles,
    submissionFiles: bundleSubmissionFiles,
  } = unzipResult.value;

  // ---------------------------------------------------------------------------
  // Step 2: Validate the manifest JSON shape.
  //
  // Do this before parsing sessions so a malformed manifest fails fast.
  // ---------------------------------------------------------------------------
  // Structural validation of manifest.json: invalid JSON or wrong shape both
  // surface as 'invalid_manifest' so callers can distinguish them from the
  // ZIP-itself-couldn't-be-read case.
  let classicManifest: BundleManifest | null = null;
  if (manifestJson !== null) {
    let parsedManifestRaw: unknown;
    try {
      parsedManifestRaw = JSON.parse(manifestJson);
    } catch (e) {
      return err({
        kind: 'invalid_manifest',
        detail: `manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    const manifestResult = validateBundleManifestShape(parsedManifestRaw);
    if (!manifestResult.ok) {
      const me = manifestResult.error;
      const detail =
        me.kind === 'not_object'
          ? 'not_object'
          : me.kind === 'wrong_version'
            ? `wrong_version: ${String(me.actual)}`
            : me.kind === 'missing_field'
              ? `missing_field: ${me.field}`
              : `invalid_field: ${me.field} — ${me.reason}`;
      return err({ kind: 'invalid_manifest', detail: `manifest.json shape invalid: ${detail}` });
    }

    classicManifest = manifestResult.value;
  }

  // ---------------------------------------------------------------------------
  // Step 2b: Validate the rolling seals, if this bundle has any.
  //
  // Shape + the filename ↔ session_id binding only; the signatures need session
  // public keys and are check 1's job. Defects never fail the load — see the
  // module docstring of rolling-seal.ts.
  // ---------------------------------------------------------------------------
  const rollingValidation =
    rawRollingSeals.length > 0 ? validateRollingSeals(rawRollingSeals) : null;

  // ---------------------------------------------------------------------------
  // Step 3: Parse all sessions in parallel (they are order-independent).
  //
  // CLAUDE.md: "No Promise.all over operations that must be ordered."
  // Session parses are NOT ordered — each .slog is self-contained. The sort
  // in step 4 imposes the final order.
  // ---------------------------------------------------------------------------
  const sessionResults = await Promise.all(
    sessionFiles.map(({ slogText, metaJson, slogSha256, metaSha256 }) =>
      parseSession(slogText, metaJson, { slogSha256, metaSha256 }),
    ),
  );

  // Collect results — fail fast on the first error.
  const parsedSessions = [];
  for (const result of sessionResults) {
    if (!result.ok) {
      return result;
    }
    parsedSessions.push(result.value);
  }

  // ---------------------------------------------------------------------------
  // Step 4: Sort sessions oldest → newest by firstEvent.wall.
  //
  // NOTE: `wall` is on the HashedEnvelope top level, not inside `data`.
  // `SessionStartPayload` has no `wall` field; the envelope itself does.
  // ---------------------------------------------------------------------------
  parsedSessions.sort(
    (a, b) => new Date(a.firstEvent.wall).getTime() - new Date(b.firstEvent.wall).getTime(),
  );

  // ---------------------------------------------------------------------------
  // Step 4b: Resolve the rolling seal against the sessions that actually parsed,
  // and synthesize the union manifest.
  //
  // This has to happen after the sort: `submission_files` is merged in session
  // order (oldest → newest), so the newest session's recorded hash for a file is
  // the one the union carries. See synthesizeRollingUnionManifest.
  // ---------------------------------------------------------------------------
  let rollingSeal: BundleRollingSeal | undefined;
  let unionManifest: BundleManifest | null = null;

  if (rollingValidation !== null) {
    const defects: RollingSealDefect[] = [...rollingValidation.defects];

    defects.push(
      ...reconcileRollingSealsWithSessions(
        rawRollingSeals.map((s) => s.sessionId),
        parsedSessions.map((s) => s.sessionId),
        classicManifest !== null,
      ),
    );

    const synthesized = synthesizeRollingUnionManifest(
      rollingValidation.seals,
      parsedSessions.map((s) => s.sessionId),
    );
    if (synthesized !== null) {
      unionManifest = synthesized.manifest;
      defects.push(...synthesized.defects);
    }

    rollingSeal = { seals: rollingValidation.seals, defects };
  }

  // ---------------------------------------------------------------------------
  // Step 4c: Pick the manifest the rest of analysis-core reads.
  //
  // The classic `manifest.json` wins whenever it is present, so a classic bundle
  // — and a bundle that carries both shapes — behaves exactly as it always has.
  // The rolling seals of a both-shapes bundle are still verified by check 1
  // alongside the classic signature; nothing is discarded.
  // ---------------------------------------------------------------------------
  const manifest = classicManifest ?? unionManifest;
  if (manifest === null) {
    // Rolling manifests were present but not one of them was usable, and there is
    // no classic manifest either, so there is nothing to synthesize a manifest
    // from. Report why, per file.
    const why = (rollingSeal?.defects ?? []).map((d) => d.detail).join(' | ');
    return err({
      kind: 'invalid_manifest',
      detail: `no usable manifest: every rolling manifest was rejected. ${why}`,
    });
  }

  // A synthesized union must satisfy the same shape contract as an on-disk
  // manifest. Cheap, and it stops a synthesis bug being mistaken for a bad bundle.
  if (classicManifest === null) {
    const unionShape = validateBundleManifestShape(manifest);
    if (!unionShape.ok) {
      return err({
        kind: 'invalid_manifest',
        detail: `synthesized rolling union manifest is not a valid manifest: ${unionShape.error.kind}`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Step 5: Build the submissionFiles map from manifest.submission_files.
  //
  // For each entry in the (optional) submission_files array, re-verify the
  // bundled bytes against the manifest's sha256 (bundle self-check). Missing
  // entries have no bytes, so hashOk is trivially true (nothing to check).
  // 1.0 bundles lack submission_files entirely → empty map, same as before.
  // ---------------------------------------------------------------------------
  const submissionFiles = new Map<
    string,
    { status: 'present' | 'missing'; sha256: string | null; bytes?: Uint8Array; hashOk: boolean }
  >();
  for (const f of manifest.submission_files ?? []) {
    if (f.status === 'missing') {
      submissionFiles.set(f.path, { status: 'missing', sha256: null, hashOk: true });
      continue;
    }
    const bytes = bundleSubmissionFiles.get(f.path);
    const hashOk = bytes !== undefined && sha256Hex(bytes) === f.sha256;
    submissionFiles.set(f.path, {
      status: 'present',
      sha256: f.sha256,
      ...(bytes !== undefined ? { bytes } : {}),
      hashOk,
    });
  }

  return ok({
    id: crypto.randomUUID(),
    manifest,
    manifestSigHex,
    ...(rollingSeal !== undefined ? { rollingSeal } : {}),
    sessions: parsedSessions,
    sourceFilename,
    loadedAt: nowFn(),
    submissionFiles,
  });
}

// ---------------------------------------------------------------------------
// parseBundles — multi-file fan-out
// ---------------------------------------------------------------------------

/**
 * Load N bundle ZIPs in parallel.
 *
 * Returns a ParseBundlesResult with:
 *   - `bundles`: successfully parsed bundles (may be fewer than blobs.length)
 *   - `errors`: per-blob failures with index + filename for UI display
 *
 * Design choice (A26): discriminated per-blob errors rather than fail-fast.
 * When a course staff member drops 10 student bundles, partial success is much
 * more useful than aborting on the first bad file. Callers can choose to surface
 * errors via a warning rather than replacing the whole UI with an error state.
 *
 * Does NOT preserve order — each blob is loaded independently in parallel and
 * successful bundles are pushed in completion order. Consumers must sort if
 * order matters (e.g., by sourceFilename or loadedAt).
 *
 * @param blobs     Array of blobs to load (e.g. from DataTransfer.files).
 * @param filenames Array of filenames, same length as blobs, for error reporting.
 * @param nowFn     Injectable clock, defaults to Date; inject in tests.
 */
export async function parseBundles(
  blobs: Blob[],
  filenames: string[],
  nowFn: () => string = () => new Date().toISOString(),
): Promise<ParseBundlesResult> {
  const results = await Promise.all(
    blobs.map((blob, i) => loadBundle(blob, filenames[i] ?? `bundle-${i}.zip`, nowFn)),
  );

  const bundles: Bundle[] = [];
  const errors: BlobLoadError[] = [];

  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.ok) {
      bundles.push(r.value);
    } else {
      errors.push({ index: i, filename: filenames[i] ?? `bundle-${i}.zip`, error: r.error });
    }
  }

  return { bundles, errors };
}
