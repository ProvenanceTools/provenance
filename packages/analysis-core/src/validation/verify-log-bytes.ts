/**
 * Log-bytes detection — the signed manifest's commitment to each session's
 * `.slog` / `.slog.meta` bytes, actually enforced.
 *
 * ## The hole this closes
 *
 * Every bundle manifest — classic `manifest.json` and per-session
 * `manifest-<session_id>.json` alike — carries, for each session:
 *
 *   { session_id, slog_sha256, meta_sha256 }
 *
 * and the whole manifest is ed25519-signed. Those two digests are a
 * cryptographic commitment to the exact bytes of the two log files. Until this
 * module, **nothing in analysis-core ever read them.** They appeared only in
 * `test-support/build-test-bundle.ts`. The commitment was written, signed,
 * shipped, and then ignored.
 *
 * The consequence was demonstrable and was in fact demonstrated: a
 * characterization test in `tools/recorder-seal-conformance.test.ts` appended a
 * well-formed, correctly-chained entry to a sealed `.slog` and watched it pass
 * **all eight** PRD §5.4 checks. It self-verifies under check 3 (it is chained
 * with the real `chainEntry`), keeps `seq` contiguous for check 4, keeps `t` and
 * `wall` non-decreasing for checks 5–6, and touches no file for checks 7–8. The
 * eight checks read the *parsed event stream*; not one of them reads the *file*.
 *
 * This module reads the file. Appending, truncating, or flipping a byte all
 * change `sha256(.slog)`, and the signed manifest says what that digest must be.
 *
 * ## Why this is the append defence, and checkpoints are not
 *
 * Worth being precise, because it is easy to assume the signed checkpoints in
 * `.slog.meta` cover this. They do not. A checkpoint commits to `(seq, hash)`
 * at the moment it was written, so `verify-checkpoint-chain.ts` catches any
 * modification of a *checkpointed prefix* and catches truncation below the last
 * checkpoint — but an entry appended *after* the final checkpoint leaves every
 * existing checkpoint verifying perfectly. Nothing about a trailing append
 * contradicts a checkpoint.
 *
 * So this check — and only this check — is what catches the append. The two are
 * complements, not redundant belts: checkpoints cover the prefix with a
 * per-session signature, the manifest digest covers the whole file with a
 * bundle-level one.
 *
 * ## Both seal shapes, one loop
 *
 * `bundle.manifest.sessions` is uniform across both shapes. On a classic bundle
 * it is `manifest.json`'s own array. On a rolling-sealed bundle
 * (`loader/rolling-seal.ts`) there is no `manifest.json`, and the loader
 * synthesizes a `format_version: '1.2'` union whose `sessions` entries are the
 * per-session rolling manifests' single entries **verbatim** — each carrying the
 * `slog_sha256` / `meta_sha256` that that session's own key signed. So one loop
 * covers both, and no branch here can drift between them.
 *
 * ## Re-runnable against a STORED bundle
 *
 * This is the property that decides whether the detection is worth anything,
 * because check 8 got it wrong once (2026-07) and reported every stored bundle
 * as tampered.
 *
 * Ingest strips student source files and stores a provenance-only bundle:
 * `manifest.json`, `manifest.sig`, `*.slog`, `*.slog.meta` — see
 * `server/services/ingest/strip-bundle.ts`, whose `isProvenanceEntry` keeps
 * exactly those four. Both inputs to this check are on that list, and the
 * stripper copies entries verbatim (DEFLATE is lossless), so the digests are
 * bit-identical before and after stripping. Stripping cannot make this check
 * fail. `verify-log-bytes.test.ts` asserts it against a genuinely stripped
 * bundle rather than trusting this paragraph.
 *
 * ## Absent is not wrong
 *
 * Every "cannot evaluate" path returns `skipped`, never `fail`. A commitment
 * that isn't there is not a commitment that was broken:
 *
 *  - a manifest entry whose `session_id` is `null` (the loader's marker for a
 *    session whose `.slog` could not be parsed) matches no session;
 *  - a session with no manifest entry at all — an unsealed session, which is
 *    check 1's finding via the rolling-seal `unsealed_session` defect, not a
 *    byte mismatch;
 *  - a digest that is absent, empty, or not 64 lowercase hex — malformed
 *    manifest shape, which is check 1/2 territory.
 *
 * Only a well-formed digest that is present on both sides and *differs* is a
 * finding. That is the same discipline check 8's tamper sub-check had to learn:
 * gate on the evidence actually being present, so "absent" can never be
 * mistaken for "wrong".
 *
 * ## Not one of the eight
 *
 * PRD §5.4's eight are a frozen, persisted contract: the server has eight
 * `check_N_status` columns and `runAndStoreValidation` throws unless
 * `checks.length === 8`. So this is deliberately NOT in
 * `ValidationReport.checks`. It rides in `ValidationReport.bundleDetections`
 * and reaches staff as a `Flag` through `heuristics/integrity-flags.ts`,
 * exactly like `verify-manifest-downgrade.ts`. Because both ingest and
 * recompute call `runValidation` against the freshly parsed bundle, the verdict
 * is recomputed every time rather than resurrected from a stored row.
 */

import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

const ID = 'log_bytes_match' as const;
const LABEL = 'Session log bytes match the signed manifest';

/** A manifest digest is usable only if it is a well-formed sha256. */
const SHA256_RE = /^[0-9a-f]{64}$/;

type Mismatch = {
  sessionId: string;
  /** Which of the two files disagreed. */
  file: '.slog' | '.slog.meta';
  expected: string;
  actual: string;
};

/**
 * Compare one committed digest against one computed digest.
 *
 * Returns `null` when the commitment is unusable (absent / malformed), which
 * the caller treats as "not evaluated" rather than as a pass or a failure.
 */
function compare(
  sessionId: string,
  file: '.slog' | '.slog.meta',
  committed: unknown,
  actual: string,
): { evaluated: false } | { evaluated: true; mismatch: Mismatch | null } {
  if (typeof committed !== 'string' || !SHA256_RE.test(committed)) {
    return { evaluated: false };
  }
  if (committed === actual) return { evaluated: true, mismatch: null };
  return { evaluated: true, mismatch: { sessionId, file, expected: committed, actual } };
}

/**
 * Verify each session's log bytes against the digests the signed manifest
 * commits to.
 *
 * Pure and synchronous: the digests were computed by the loader from the exact
 * ZIP bytes (`loader/unzip.ts`), so this does no hashing, no crypto and no I/O.
 * It is a comparison, and its authority comes from check 1 having verified the
 * signature over the manifest that supplied the expected values.
 *
 * Statuses:
 *  - `fail`    — at least one session's `.slog` or `.slog.meta` digest differs
 *                from the signed commitment.
 *  - `pass`    — at least one digest was evaluated and every one matched.
 *  - `skipped` — no session had a usable commitment to compare against.
 */
export function verifyLogBytes(bundle: Bundle): ValidationCheck {
  const mismatches: Mismatch[] = [];
  let evaluated = 0;

  for (const session of bundle.sessions) {
    // A manifest MAY legitimately carry several entries; `session_id: null`
    // marks one whose .slog the sealer could not parse. Match on id only, and
    // check every entry that claims this session rather than just the first —
    // two entries disagreeing about the same session is itself evidence, and
    // taking `find()`'s first hit would let the honest one mask the other.
    const entries = bundle.manifest.sessions.filter((s) => s.session_id === session.sessionId);
    if (entries.length === 0) continue;

    for (const entry of entries) {
      const slog = compare(session.sessionId, '.slog', entry.slog_sha256, session.slogSha256);
      if (slog.evaluated) {
        evaluated++;
        if (slog.mismatch !== null) mismatches.push(slog.mismatch);
      }

      const meta = compare(session.sessionId, '.slog.meta', entry.meta_sha256, session.metaSha256);
      if (meta.evaluated) {
        evaluated++;
        if (meta.mismatch !== null) mismatches.push(meta.mismatch);
      }
    }
  }

  if (mismatches.length > 0) {
    const per = mismatches
      .map(
        (m) =>
          `session ${m.sessionId} ${m.file}: manifest commits to ${m.expected}, ` +
          `bundled bytes hash to ${m.actual}`,
      )
      .join('; ');

    return {
      id: ID,
      label: LABEL,
      status: 'fail',
      detail:
        `Session log bytes do not match the signed manifest: ${per}. The manifest is ` +
        `ed25519-signed, so these digests were fixed when the bundle was sealed and cannot ` +
        `change without the signing key. A differing digest means the log file was modified ` +
        `after sealing — appended to, truncated, or edited. This is not recoverable from a ` +
        `benign cause: the recorder writes each log once and seals over the finished bytes.`,
      // Seq 0 is the session.start of the affected session — the stable anchor
      // for a finding about the file as a whole rather than any one entry.
      supportingSeqs: mismatches.map((m) => ({ sessionId: m.sessionId, seq: 0 })),
    };
  }

  if (evaluated === 0) {
    return {
      id: ID,
      label: LABEL,
      status: 'skipped',
      detail:
        'No session carried a usable manifest commitment to its log bytes (no matching ' +
        'manifest entry, or the recorded digests are absent or malformed), so there is ' +
        'nothing for this check to compare against.',
    };
  }

  return {
    id: ID,
    label: LABEL,
    status: 'pass',
    detail:
      `${evaluated} log-file digest(s) matched the signed manifest exactly. The bytes of ` +
      `every checked .slog and .slog.meta are the bytes that were sealed.`,
  };
}
