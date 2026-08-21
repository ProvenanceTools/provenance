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
 * Any UNRECOGNIZED file produces `unexpected_file` — the contents are a closed
 * set, and strictness is cheap here.
 *
 * ## The read-side orphan guard (step 5)
 *
 * Recognized-but-unanalysable artifacts are a different matter. A `.slog.meta`
 * with no `.slog`, a `.slog` with no `.slog.meta`, a zero-byte `.slog`, a
 * quarantined `.corrupt-<ISO>` log and a `.tmp` staging leftover used to be
 * FATAL TO THE WHOLE BUNDLE, before a single validation check ran. They are now
 * dropped from the analysis and reported as {@link DroppedArtifact}s.
 *
 * This is the same guard all three recorders apply in `sealBundle`, moved to the
 * read side because THE GIT PATH NEVER RUNS SEAL: the student pushes, the grader
 * clones, and whatever sits in `.provenance/` is the submission. See the
 * {@link DroppedArtifact} docstring for the full argument, including why the
 * loader is the right layer and why nothing here is an integrity finding.
 *
 * Zero ANALYSABLE .slog files → `no_sessions`, as before.
 *
 * Design: pure except for the JSZip async read. No Node APIs; browser-safe.
 */

import JSZip from 'jszip';
import {
  ok,
  err,
  parseRollingManifestFilename,
  sha256Hex,
  PROVENANCE_GITATTRIBUTES_FILENAME,
} from '@provenance/log-core';
import type { Result } from '@provenance/log-core';
import { asLogFileId, asLogicalSessionId } from './types.js';
import type {
  BundleFiles,
  DroppedArtifact,
  LogFileId,
  LogicalSessionId,
  LoaderError,
  RawRollingSealFiles,
} from './types.js';

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

/**
 * A log the recorder's chain recovery quarantined: `<slog>.corrupt-<ISO>`.
 *
 * PRD §4.8 — on a log it cannot read, parse or chain-validate, the recorder
 * renames it out of the way and starts a fresh session, emitting
 * `recorder.recovered_from_corruption` with the quarantined path. `sealBundle`
 * excludes these from the ZIP, so they only ever reach a reader on the GIT path,
 * where the on-disk directory is the submission and nothing filtered it.
 *
 * Recognized rather than rejected: this is a file the recorder itself created,
 * with a name it chose, and its presence is explained evidence — the surviving
 * log records the recovery event. It is not analysable (that is why it was
 * quarantined), so it is dropped and reported.
 */
const QUARANTINED_LOG_RE = /^session-[0-9a-f-]+\.slog\.corrupt-.+$/;

/**
 * A leftover from an interrupted atomic write (write-temp-then-rename).
 *
 * Same story as {@link QUARANTINED_LOG_RE}: recorder-authored, excluded by
 * `sealBundle`, reachable only on the git path, and never analysable — a `.tmp`
 * is by definition a partial write.
 */
const STAGING_LEFTOVER_RE = /\.tmp$/;

/**
 * Best-effort read of the LOGICAL session id out of a `.slog.meta` sidecar.
 *
 * The sidecar carries `session_id` — `session.start.data.session_id`, the id
 * space rolling seals are named after — and it survives even when the log it
 * describes does not. That is what makes a stranded sidecar informative rather
 * than merely a nuisance: it names exactly which recording went missing, so the
 * seal for that recording can be dropped alongside it instead of surfacing as a
 * `no_session_log` defect that fails check 1 for the whole bundle.
 *
 * Returns `null` on anything unparseable. A sidecar we cannot read is still
 * dropped and still reported; we simply cannot name its session.
 */
export function logicalSessionIdFromMeta(metaJson: string): LogicalSessionId | null {
  try {
    const parsed: unknown = JSON.parse(metaJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const id = (parsed as { session_id?: unknown }).session_id;
    return typeof id === 'string' && id.length > 0 ? asLogicalSessionId(id) : null;
  } catch {
    return null;
  }
}

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
  const droppedArtifacts: DroppedArtifact[] = [];

  const submissionFiles = new Map<string, Uint8Array>();
  for (const [filename, zipObject] of deferred) {
    if (submissionPaths.has(filename)) {
      submissionFiles.set(filename, await zipObject.async('uint8array'));
      continue;
    }

    // Two recorder-authored artifacts that a GIT submission necessarily carries,
    // because no seal step ran to filter them. Neither is analysable, and
    // neither is an anomaly — one is the documented output of crash recovery,
    // the other of an interrupted atomic write. Failing the whole submission on
    // them would be punishing a student for a crash. Drop and report.
    if (QUARANTINED_LOG_RE.test(filename)) {
      droppedArtifacts.push({
        kind: 'quarantined_log',
        filename,
        detail:
          `${filename} is a log the recorder quarantined after failing to read or ` +
          `chain-validate it (PRD §4.8), so it cannot be analysed and is left out. ` +
          `This records an INCOMPLETE RECORDING, not an integrity problem: the ` +
          `recovery is itself an event in the session that followed it.`,
      });
      continue;
    }

    if (STAGING_LEFTOVER_RE.test(filename)) {
      droppedArtifacts.push({
        kind: 'staging_leftover',
        filename,
        detail:
          `${filename} is a partial write left behind by an interrupted ` +
          `write-temp-then-rename, so it cannot be analysed and is left out. This ` +
          `records an INCOMPLETE RECORDING, not an integrity problem.`,
      });
      continue;
    }

    // The `.gitattributes` every recorder writes into `.provenance/` to stop git
    // rewriting the signed bytes (see `log-core/git-attributes.ts`). Recognized
    // and IGNORED — not dropped-and-reported, because a `DroppedArtifact` means
    // "an INCOMPLETE RECORDING: something analysable was left out", and this is
    // neither analysable nor missing. It is a git control file with no session
    // data and no signature over it, in the same category as a file this loader
    // consumes and says nothing further about.
    //
    // Neither producer should send it: `seal.ts` skips it when packing, and the
    // git path's `selectBundleEntries` drops anything that is not a provenance
    // or submission file. It is tolerated here anyway because the loader is
    // where all three consumers converge — including a student hand-zipping
    // `.provenance/` for the analyzer's `/local` route, which no producer
    // filters — and because failing a whole submission on a file the recorder
    // itself wrote is precisely the class of defect the orphan guard above
    // exists to undo.
    if (filename === PROVENANCE_GITATTRIBUTES_FILENAME) {
      continue;
    }

    // Genuinely unrecognized. Still fatal, deliberately: the bundle's contents
    // are a closed set, and an unexplained file is exactly what no later stage
    // should have to reason about. The two branches above are narrow because
    // they name artifacts the recorder itself creates, under names it chooses.
    return err({ kind: 'unexpected_file', filename, detail: 'not a recognized bundle file' });
  }

  // ---------------------------------------------------------------------------
  // 5. Structural checks.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // THE READ-SIDE ORPHAN GUARD.
  //
  // Each of the three shapes below used to `return err(...)`, killing the WHOLE
  // bundle before any check ran — every healthy session in the archive thrown
  // away because one artifact beside them was unpairable. On the classic path
  // that was survivable, because `sealBundle`'s orphan guard drops these before
  // they are ever packed. THE GIT PATH HAS NO SEAL STEP, so on git the fatality
  // was reachable by a crash and by nothing else the student did.
  //
  // The rule now matches the recorders': drop the artifact, report it, never
  // abort, and never touch anything (this module only reads).
  //
  // Ordering matters. Empty logs are handled FIRST so that a `.slog.meta` beside
  // a zero-byte `.slog` is reported as part of that pair rather than separately
  // as an orphan — one fact, not two.
  // ---------------------------------------------------------------------------

  /** Log file ids that will not be analysed, whatever the reason. */
  const droppedLogFileIds = new Set<LogFileId>();

  const dropSessionPair = (
    logFileId: LogFileId,
    kind: 'empty_slog' | 'orphaned_meta' | 'orphaned_slog',
    detail: string,
  ): void => {
    droppedLogFileIds.add(logFileId);
    const metaText = metaContents.get(logFileId)?.text;
    droppedArtifacts.push({
      kind,
      filename:
        kind === 'orphaned_meta' ? `session-${logFileId}.slog.meta` : `session-${logFileId}.slog`,
      logFileId,
      // The sidecar names the recording even when the log is gone. Carried so
      // `parse-bundle.ts` can drop this session's rolling seal WITH it, instead
      // of letting the seal surface as a `no_session_log` defect — which fails
      // check 1 for the whole bundle over a crash this loader can explain.
      ...(metaText !== undefined
        ? (() => {
            const logicalSessionId = logicalSessionIdFromMeta(metaText);
            return logicalSessionId !== null ? { logicalSessionId } : {};
          })()
        : {}),
      detail,
    });
  };

  // 1. A CONTENTLESS `.slog`. `SessionWriter.open` creates the file eagerly
  //    while the buffer policy holds the first entries, so a session torn down
  //    before its first flush leaves a zero-byte log — with a complete sidecar
  //    beside it and, on the git path, a rolling seal signed over nothing.
  //    Zero bytes means zero recorded events, so dropping it discards no
  //    evidence, whereas keeping it used to discard ALL of it: it reaches
  //    `parseSession` as `first_event_not_session_start` (actualKind "none"),
  //    and `parse-bundle.ts` fails fast on the first session parse error.
  for (const logFileId of [...slogIds].sort()) {
    if (slogContents.get(logFileId)!.text.length === 0) {
      dropSessionPair(
        logFileId,
        'empty_slog',
        `session-${logFileId}.slog is zero bytes — a session that started and was ` +
          `torn down before its first flush, so it recorded no events. Left out ` +
          `along with its sidecar. This records an INCOMPLETE RECORDING, not an ` +
          `integrity problem.`,
      );
    }
  }

  // 2. A `.slog.meta` whose `.slog` is not here. The recorder's chain recovery
  //    renames a damaged log to `.corrupt-<ISO>` and leaves the sidecar under
  //    its original name, so the SALVAGE PATH produces this shape by itself.
  for (const metaId of [...metaIds].sort()) {
    if (!slogIds.has(metaId)) {
      dropSessionPair(
        metaId,
        'orphaned_meta',
        `session-${metaId}.slog.meta is present but its log session-${metaId}.slog ` +
          `is not — most often because the recorder quarantined a damaged log and ` +
          `left the sidecar behind. A sidecar holds no events, so nothing ` +
          `analysable was lost by leaving it out. This records an INCOMPLETE ` +
          `RECORDING, not an integrity problem.`,
      );
    }
  }

  // 3. A `.slog` with no sidecar. The recorder does not produce this shape
  //    (`MetaWriter.create` writes the `.meta` in the same breath as the
  //    `.slog`), but the loader must not die on it either.
  for (const slogId of [...slogIds].sort()) {
    if (!metaIds.has(slogId) && !droppedLogFileIds.has(slogId)) {
      dropSessionPair(
        slogId,
        'orphaned_slog',
        `session-${slogId}.slog is present but its sidecar ` +
          `session-${slogId}.slog.meta is not. Without the sidecar there is no ` +
          `session public key and no signed checkpoints, so this log cannot be ` +
          `verified and is left out. This records an INCOMPLETE RECORDING, not an ` +
          `integrity problem.`,
      );
    }
  }

  const analysableLogFileIds = [...slogIds].filter((id) => !droppedLogFileIds.has(id));

  // Nothing analysable left. Unchanged behaviour, and still the right one: a
  // bundle with no readable session cannot be analysed at all, so there is no
  // degraded reading to fall back to.
  if (analysableLogFileIds.length === 0) {
    return err({ kind: 'no_sessions' });
  }

  // ---------------------------------------------------------------------------
  // 6. Build the result.
  // ---------------------------------------------------------------------------

  const sessions = analysableLogFileIds.map((logFileId) => {
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
    // Sorted so the report is deterministic regardless of ZIP entry order.
    droppedArtifacts: droppedArtifacts.sort((a, b) =>
      a.filename === b.filename ? 0 : a.filename < b.filename ? -1 : 1,
    ),
  });
}
