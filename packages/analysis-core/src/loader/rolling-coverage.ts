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
 * ## Except when the writer said it was finished
 *
 * The residual above is only forced while the log can still grow. `dispose()`
 * takes one last roll after `session.end` is emitted and both files are flushed
 * and closed, and marks it `final: true` inside the signed payload. For that
 * seal there is no future to be incapable of attesting to, so the prefix search
 * is not merely unnecessary — running it would be wrong, because it would keep
 * excusing a tail the writer has stated cannot exist. A final seal therefore
 * goes through `wholeFileCoverage` and an append fails at full strength.
 *
 * The marker is signed, so it cannot be added, flipped or stripped without the
 * session key. Its ABSENCE is never a finding: a crash, a power cut, a full
 * disk or a `git checkout` that removed `.provenance/` all leave a last
 * non-final seal, and those sessions keep prefix semantics with the unattested
 * tail reported. See `log-core/rolling-manifest.ts`.
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
 *  - `indeterminate` — the loader could not establish WHICH bytes this seal
 *                    commits to, so no comparison it could make would mean
 *                    anything. Never a finding, and — unlike `unavailable` —
 *                    never a fallback to whole-file equality either. See
 *                    {@link resolveAmbiguousCoverage}.
 */
export type SealCoverage =
  | { kind: 'exact' }
  | { kind: 'partial'; sealed: number; total: number; unit: 'bytes' | 'checkpoints' }
  | { kind: 'no_match' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'indeterminate'; reason: string };

/** One session's rolling-seal coverage over both of its log files. */
export type RollingSealCoverage = {
  /**
   * The LOGICAL session id (`session.start.data.session_id`) this coverage
   * describes — never the `.slog` filename uuid.
   *
   * `verify-log-bytes.ts` keys its `coverageBySession` map on this and looks it
   * up with `bundle.sessions[].sessionId`, which is the same space. Setting it
   * from the filename uuid instead would leave every lookup missing, and a
   * MISSING coverage entry is read as "classic seal" — whole-file equality over
   * a prefix commitment, which accuses honest students. See
   * `loader/types.ts` / `LogicalSessionId`.
   */
  sessionId: string;
  /**
   * The seal declared itself FINAL (`log-core`'s `isFinalRollingSeal`), so its
   * digests were read as WHOLE-FILE commitments and no prefix search was done.
   *
   * Carried through to `verify-log-bytes.ts` so a mismatch can be described
   * accurately — "the finished log was modified" reads very differently from
   * "the sealed prefix was contradicted" — and so a passing verdict can say
   * whether the log is sealed, or sealed in full.
   */
  final: boolean;
  slog: SealCoverage;
  meta: SealCoverage;
};

/**
 * Coverage of a FINAL seal: plain whole-file equality, no prefix search.
 *
 * A final seal is written by `dispose()` after `session.end` is emitted and both
 * files are flushed and closed, so it commits to every byte. Searching for a
 * prefix here would be actively wrong: it would find the honest reading of a
 * seal that no longer needs one, and hand an append the benefit of a doubt the
 * writer explicitly gave up. This is the whole point of the marker.
 *
 * Shares `SealCoverage` with the prefix path so callers keep one shape:
 * `exact` when the bytes agree, `no_match` when they do not, `unavailable` when
 * there was no usable commitment (never a finding).
 */
export function wholeFileCoverage(actual: string, committed: unknown): SealCoverage {
  if (typeof committed !== 'string' || !SHA256_RE.test(committed)) {
    return { kind: 'unavailable', reason: 'the manifest carries no usable digest' };
  }
  return committed === actual ? { kind: 'exact' } : { kind: 'no_match' };
}

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

// ---------------------------------------------------------------------------
// Ambiguity: two `.slog` files claiming the same logical session
// ---------------------------------------------------------------------------

/** Structural equality over a {@link SealCoverage}. */
function sameCoverage(a: SealCoverage, b: SealCoverage): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'partial' && b.kind === 'partial') {
    return a.sealed === b.sealed && a.total === b.total && a.unit === b.unit;
  }
  if (a.kind === 'unavailable' && b.kind === 'unavailable') return a.reason === b.reason;
  if (a.kind === 'indeterminate' && b.kind === 'indeterminate') return a.reason === b.reason;
  return true;
}

/**
 * Resolve one seal's coverage when SEVERAL `.slog` files claim its session.
 *
 * ## Why this exists
 *
 * A rolling seal is named after a LOGICAL session id, and it commits to the
 * bytes of that session's log. Two `.slog` files can carry the same logical id
 * only if a log was duplicated under a second filename — a hand copy of
 * `.provenance/`, a backup taken before a push, an odd merge. The recorder never
 * produces it. When it happens, no single file is "the" file the seal covers.
 *
 * The loader used to answer that by recording NOTHING: the seal produced no
 * coverage entry, and an ABSENT coverage entry is not inert —
 * `verify-log-bytes.ts` reads absence as "this is a classic seal" and applies
 * WHOLE-FILE equality to a digest that, on a non-final seal, only ever committed
 * to a prefix. So the archived log mismatched, and `log_bytes_match` failed at
 * high severity, confidence 1.0. That is the identical outcome bug 10 produced
 * by a different route (a lookup keyed on the wrong id space), reached through
 * the second branch of the same `if`. Fixing one branch of a conditional does
 * not fix the conditional.
 *
 * ## What is honest here
 *
 * "We cannot check" is a different fact from "the bytes do not match", and this
 * codebase already draws that line — `isIdentityCheckFailure` separates "no root
 * key configured" from "the chain failed", and `classify-external-changes.ts`
 * answers `unclassified` rather than the accusatory `external` when its test
 * cannot be run soundly. Same discipline here.
 *
 * But "we cannot check" is a claim too, and it must not be over-used, because
 * OVER-correcting is the dangerous direction: if ambiguity always suppressed the
 * verdict, duplicating a tampered log would become a way to switch off
 * `log_bytes_match` — a student could append to their `.slog`, copy it under a
 * second filename, and buy silence. So the rule is unanimity, not surrender:
 *
 *  - Every candidate agrees → that verdict IS the answer, whichever file the
 *    seal meant, and it is used unchanged. Byte-identical duplicates (the most
 *    likely innocent shape) therefore keep full prefix semantics, and — the part
 *    that matters — a seal that NO candidate reproduces is still `no_match`,
 *    because "no file in this bundle claiming this session reproduces the sealed
 *    digest" is established regardless of which one the seal was written over.
 *  - The candidates disagree → `indeterminate`. The seal is satisfied by some
 *    file that is present and contradicted by another, and nothing in the
 *    archive says which one it named.
 *
 * `indeterminate` is reported, never silent: the loader also records an
 * `ambiguous_session_log` defect (see `parse-bundle.ts`), and
 * `verify-log-bytes.ts` names the unchecked digests in its own verdict text.
 *
 * @param candidates One coverage verdict per `.slog` claiming this session, in
 *   the order the files appeared. Never empty; a single candidate returns itself.
 * @param reason Staff-facing prose for the `indeterminate` case: what could not
 *   be established, and why.
 */
export function resolveAmbiguousCoverage(
  candidates: readonly SealCoverage[],
  reason: string,
): SealCoverage {
  const first = candidates[0];
  if (first === undefined) return { kind: 'indeterminate', reason };
  if (candidates.every((c) => sameCoverage(first, c))) return first;
  return { kind: 'indeterminate', reason };
}
