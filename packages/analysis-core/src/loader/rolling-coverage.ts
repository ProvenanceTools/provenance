/**
 * How much of a session's logs a ROLLING seal actually covers.
 *
 * ## The bug this exists to fix
 *
 * `verify-log-bytes.ts` compares `sessions[].slog_sha256` from the signed
 * manifest against the digest of the archived `.slog`, and reports a difference
 * as tampering at **high severity, confidence 1.0**. For a classic
 * `manifest.json` that is exactly right: the classic seal is taken once, by an
 * explicit `seal` command, over a finished log.
 *
 * A rolling seal is not taken once. `rolling-seal-writer.ts` rewrites
 * `manifest-<session_id>.json` at session start, at every checkpoint, and at
 * `dispose()` — hashing the log **as it stands at that moment**. Its digests are
 * stale between writes by design, and a git-submitted assignment has no seal
 * step to make them fresh: the student pushes whenever, the grader clones
 * whenever, and `dispose()` may never run (a crash, a force-quit, a partner's
 * repo cloned mid-session). So the archived `.slog` is routinely LONGER than the
 * digest its own signed manifest names.
 *
 * Read as a whole-file commitment, that is a false accusation against an honest
 * student — the worst failure mode this system has, and one that fired on every
 * git-submitted bundle. Read as what the writer actually meant, it is a
 * commitment to a PREFIX, and this module recovers which prefix.
 *
 * ## Why the two files need different models
 *
 * They are written by different writers with different structures:
 *
 *  - **`.slog`** is append-only NDJSON. Every state it has ever been in is a
 *    prefix of every later state, so `findSha256PrefixLength` (log-core) finds
 *    the sealed prefix directly from the bytes.
 *  - **`.slog.meta`** is NOT append-only. `MetaWriter._write` re-serializes the
 *    whole `SlogMeta` as JCS-canonical JSON on every checkpoint, and
 *    `checkpoints` sorts near the FRONT of the object, so appending a checkpoint
 *    rewrites bytes in the middle. A byte-prefix search would find nothing.
 *    But the only field that changes over a session's life IS `checkpoints`, so
 *    the states the file has passed through are exactly
 *    `canonicalize({...meta, checkpoints: checkpoints.slice(0, k)})` for
 *    k = 0..n. Re-deriving those and looking for the committed digest is the
 *    same question, asked in the right unit.
 *
 * ## What survives, and what does not
 *
 * A match at prefix N proves bytes `[0, N)` — or the first k checkpoints — are
 * byte-for-byte what the session's own key signed. Editing, reordering or
 * dropping anything inside that region breaks every candidate, so it still fails
 * at full strength. Deleting a checkpoint from the middle of the `.slog.meta`
 * likewise reproduces no truncation, so it fails.
 *
 * What is NOT covered is anything at or after the sealed point. Nothing can
 * cover it: those bytes did not exist when the signature was made, and no
 * reader-side change can conjure an attestation the writer never made. That
 * residual is inherent to a continuously-rewritten seal, and it is reported —
 * `verify-log-bytes.ts` states the size of the unattested tail on the passing
 * verdict, so "sealed" is never confused with "sealed in full".
 *
 * ## Scope: rolling seals only
 *
 * `parse-bundle.ts` computes this ONLY when the synthesized union manifest is
 * the bundle's manifest — i.e. when there is no classic `manifest.json` at all.
 * A classic bundle, and a bundle carrying BOTH shapes, keeps whole-file equality
 * and keeps catching a post-seal append at full strength.
 *
 * Pure: no I/O.
 */

import { canonicalize, sha256Hex, findSha256PrefixLength } from '@provenance/log-core';

/** A well-formed sha256 commitment. Anything else is not a commitment at all. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * What a rolling seal's digest turned out to commit to.
 *
 *  - `exact`       — the digest covers the archived file in full.
 *  - `partial`     — it covers a verified prefix, and `total - sealed` more
 *                    arrived afterwards. Honest growth; NOT a finding.
 *  - `no_match`    — no state this file could have passed through hashes to the
 *                    committed value. The sealed region was contradicted.
 *  - `unavailable` — the comparison could not be made at all. Never a finding;
 *                    the caller falls back to whole-file equality.
 */
export type SealCoverage =
  | { kind: 'exact' }
  | { kind: 'partial'; sealed: number; total: number; unit: 'bytes' | 'checkpoints' }
  | { kind: 'no_match' }
  | { kind: 'unavailable'; reason: string };

/** One session's rolling-seal coverage over both of its log files. */
export type RollingSealCoverage = {
  sessionId: string;
  slog: SealCoverage;
  meta: SealCoverage;
};

/**
 * Coverage of a rolling seal's `slog_sha256` over the archived `.slog`.
 *
 * @param slogText   The `.slog` as the loader decoded it.
 * @param slogSha256 Digest of the raw ZIP bytes, from the unzipper.
 * @param committed  `slog_sha256` from the session's own signed rolling manifest.
 */
export function computeSlogCoverage(
  slogText: string,
  slogSha256: string,
  committed: unknown,
): SealCoverage {
  if (typeof committed !== 'string' || !SHA256_RE.test(committed)) {
    return { kind: 'unavailable', reason: 'the manifest carries no usable slog_sha256' };
  }
  if (committed === slogSha256) return { kind: 'exact' };

  const bytes = new TextEncoder().encode(slogText);

  // The loader hashes the RAW ZIP bytes but hands on decoded text. For the
  // UTF-8 JSON the recorder writes those round-trip exactly; for anything that
  // did not (invalid UTF-8 replaced with U+FFFD) a prefix search would be
  // searching a different file than the one that was hashed, so refuse rather
  // than answer confidently about the wrong bytes.
  if (sha256Hex(bytes) !== slogSha256) {
    return {
      kind: 'unavailable',
      reason: 'the .slog text does not re-encode to the archived bytes',
    };
  }

  const sealed = findSha256PrefixLength(bytes, committed);
  if (sealed === null) return { kind: 'no_match' };
  return { kind: 'partial', sealed, total: bytes.length, unit: 'bytes' };
}

/**
 * Coverage of a rolling seal's `meta_sha256` over the archived `.slog.meta`.
 *
 * Searches the states the file has actually passed through — the same object
 * with `checkpoints` truncated to each earlier length — rather than byte
 * prefixes, because `MetaWriter` rewrites the file whole on every checkpoint.
 */
export function computeMetaCoverage(
  metaJson: string,
  metaSha256: string,
  committed: unknown,
): SealCoverage {
  if (typeof committed !== 'string' || !SHA256_RE.test(committed)) {
    return { kind: 'unavailable', reason: 'the manifest carries no usable meta_sha256' };
  }
  if (committed === metaSha256) return { kind: 'exact' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(metaJson);
  } catch {
    return { kind: 'unavailable', reason: 'the .slog.meta is not parseable JSON' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unavailable', reason: 'the .slog.meta is not a JSON object' };
  }

  const meta = parsed as Record<string, unknown>;
  const checkpoints = meta['checkpoints'];
  if (!Array.isArray(checkpoints)) {
    return { kind: 'unavailable', reason: 'the .slog.meta has no checkpoints array' };
  }

  // Only a file that IS its own canonical form can be re-derived from its parse.
  // A hand-written or legacy `.slog.meta` cannot, so do not guess at it.
  if (sha256Hex(canonicalize(meta)) !== metaSha256) {
    return { kind: 'unavailable', reason: 'the .slog.meta is not in canonical form' };
  }

  // k = checkpoints.length is the `exact` case, already returned above.
  for (let k = checkpoints.length - 1; k >= 0; k--) {
    const candidate = canonicalize({ ...meta, checkpoints: checkpoints.slice(0, k) });
    if (sha256Hex(candidate) === committed) {
      return { kind: 'partial', sealed: k, total: checkpoints.length, unit: 'checkpoints' };
    }
  }

  return { kind: 'no_match' };
}
