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

import {
  validateBundleManifestShape,
  sha256Hex,
  ok,
  err,
  isFinalRollingSeal,
} from '@provenance/log-core';
import type { BundleManifest, Result } from '@provenance/log-core';
import { unzipBundle } from './unzip.js';
import { parseSession } from './parse-session.js';
import {
  validateRollingSeals,
  reconcileRollingSealsWithSessions,
  synthesizeRollingUnionManifest,
} from './rolling-seal.js';
import { computeSlogCoverage, computeMetaCoverage, wholeFileCoverage } from './rolling-coverage.js';
import type { RollingSealCoverage } from './rolling-coverage.js';
import { asLogicalSessionId } from './types.js';
import type {
  Bundle,
  BundleRollingSeal,
  DroppedArtifact,
  LoaderError,
  LogicalSessionId,
  RollingSealDefect,
  SessionFiles,
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
    rollingSeals: allRawRollingSeals,
    sessions: sessionFiles,
    submissionFiles: bundleSubmissionFiles,
    droppedArtifacts: unzipDropped,
  } = unzipResult.value;

  // ---------------------------------------------------------------------------
  // Step 1b: drop the rolling seal of any session the unzipper already dropped.
  //
  // This completes the read-side orphan guard. Without it, degrading gracefully
  // would MANUFACTURE A FINDING out of the very crash it exists to absorb: a
  // seal whose `.slog` is not in the bundle becomes a `no_session_log` defect,
  // which fails check 1 (`manifest_sig`) for the WHOLE bundle at high severity
  // and whose text offers "either the log was deleted or the seal was planted".
  // A student whose editor crashed would go from "your submission will not open"
  // to "your submission looks tampered with" — strictly worse.
  //
  // The seal is matched on the LOGICAL session id recovered from the dropped
  // session's `.slog.meta` sidecar, which is the id space `manifest-<id>.json`
  // filenames live in. The `.slog` FILENAME uuid would match nothing here; the
  // brands make that a compile error rather than a silent miss (types.ts).
  //
  // Dropping a seal cannot itself create a finding: `unsealed_session` is
  // reported only for a session whose log IS present and uncovered, and this
  // only ever drops seals whose session is absent. Same rule the recorders'
  // seal-side guard follows — and, as there, nothing is deleted; the seal is
  // simply not analysed, and the fact is reported.
  // ---------------------------------------------------------------------------
  const droppedArtifacts: DroppedArtifact[] = [...unzipDropped];
  const droppedLogicalIds = new Set<string>(
    unzipDropped
      .map((d) => d.logicalSessionId)
      .filter((id): id is NonNullable<typeof id> => id !== undefined),
  );
  const rawRollingSeals =
    droppedLogicalIds.size === 0
      ? allRawRollingSeals
      : allRawRollingSeals.filter((seal) => {
          if (!droppedLogicalIds.has(seal.sessionId)) return true;
          droppedArtifacts.push({
            kind: 'orphaned_rolling_seal',
            filename: `manifest-${seal.sessionId}.json`,
            logicalSessionId: asLogicalSessionId(seal.sessionId),
            detail:
              `manifest-${seal.sessionId}.json seals a session whose log is not in ` +
              `this bundle, because the log was left out as an incomplete ` +
              `recording. Its signature can never be checked — the key that would ` +
              `verify it lives in that session's own session.start — so it is left ` +
              `out with the session it names. This records an INCOMPLETE ` +
              `RECORDING, not an integrity problem.`,
          });
          return false;
        });

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
  //
  // The pairing between a parsed session and the FILES it was parsed from is
  // established HERE, by index, because `Promise.all` preserves input order and
  // this is the last point at which that correspondence exists — step 4 sorts
  // `parsedSessions` by wall clock and destroys it.
  //
  // Keying by the parsed session's LOGICAL id (`session.start.data.session_id`)
  // is the whole point: that is the id space rolling seals, manifest entries and
  // every downstream consumer live in. The `.slog` FILENAME uuid is a different
  // value in production and is now a distinct branded type so it cannot be used
  // here by accident. See `types.ts` / {@link LogFileId}.
  const parsedSessions = [];
  const filesByLogicalSessionId = new Map<LogicalSessionId, SessionFiles | 'ambiguous'>();
  for (let i = 0; i < sessionResults.length; i++) {
    const result = sessionResults[i]!;
    if (!result.ok) {
      return result;
    }
    parsedSessions.push(result.value);

    // Two `.slog` files can carry the same logical session id only if a log was
    // duplicated under a second filename. Then no single file is "the" file that
    // session's seal covers, and silently taking the last one would compute
    // coverage over bytes the seal never saw. Refuse rather than guess: the seal
    // falls through to whole-file equality, exactly as a classic bundle does.
    const logicalId = asLogicalSessionId(result.value.sessionId);
    const files = sessionFiles[i]!;
    filesByLogicalSessionId.set(
      logicalId,
      filesByLogicalSessionId.has(logicalId) ? 'ambiguous' : files,
    );
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
      // LOGICAL ids, read out of each `.slog`'s session.start by parse-session.
      parsedSessions.map((s) => asLogicalSessionId(s.sessionId)),
    );
    if (synthesized !== null) {
      unionManifest = synthesized.manifest;
      defects.push(...synthesized.defects);
    }

    // Every build hash any seal reported, so the extension-hash allowlist can
    // check all of them rather than only the one the union scalar kept.
    const observedExtensionHashes = [
      ...new Set(rollingValidation.seals.map((s) => s.manifest.extension_hash)),
    ].sort();

    // Prefix coverage, computed ONLY when the union manifest is the one the rest
    // of analysis-core will read. A rolling seal is rewritten as its session
    // grows, so its digests commit to a prefix; a classic seal is taken once
    // over a finished log and commits to the whole file. A both-shapes bundle
    // uses the classic manifest, so it keeps whole-file equality — and keeps
    // catching a post-seal append at full strength. See rolling-coverage.ts.
    let coverage: RollingSealCoverage[] | undefined;
    if (classicManifest === null) {
      coverage = [];
      for (const seal of rollingValidation.seals) {
        // `seal.sessionId` is a LOGICAL session id — a rolling seal is named
        // `manifest-<session.start.data.session_id>.json` — so it is resolved
        // against the map built from the PARSED sessions above, never against
        // the `.slog` filename uuids. Those are two different values in every
        // production bundle; keying this lookup on the filename uuid missed on
        // every git submission, left coverage empty, and sent
        // `log_bytes_match` down the whole-file path that then accused honest
        // students at high severity. See `types.ts` / {@link LogFileId}.
        const files = filesByLogicalSessionId.get(seal.sessionId);
        // undefined → no_session_log, reported as a defect.
        // 'ambiguous' → duplicated log, see the pairing loop above.
        if (files === undefined || files === 'ambiguous') continue;
        const entry = seal.manifest.sessions[0];
        // A FINAL seal (written by dispose() over a finished, flushed log, and
        // signed) commits to the whole file, so it skips the prefix search
        // entirely and an append past it fails. Everything else is still
        // growing when it is signed and keeps prefix semantics — the difference
        // between catching a post-session append and accusing a student whose
        // editor is still open. See loader/rolling-coverage.ts.
        const final = isFinalRollingSeal(seal.manifest);
        coverage.push({
          sessionId: seal.sessionId,
          final,
          slog: final
            ? wholeFileCoverage(files.slogSha256, entry.slog_sha256)
            : computeSlogCoverage(files.slogText, files.slogSha256, entry.slog_sha256),
          meta: final
            ? wholeFileCoverage(files.metaSha256, entry.meta_sha256)
            : computeMetaCoverage(files.metaJson, files.metaSha256, entry.meta_sha256),
        });
      }
    }

    rollingSeal = {
      seals: rollingValidation.seals,
      defects,
      observedExtensionHashes,
      ...(coverage !== undefined ? { coverage } : {}),
    };
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
    droppedArtifacts: droppedArtifacts.sort((a, b) =>
      a.filename === b.filename ? 0 : a.filename < b.filename ? -1 : 1,
    ),
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
