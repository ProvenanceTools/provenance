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
 * ## Both seal shapes, one loop — but NOT one meaning
 *
 * `bundle.manifest.sessions` is uniform across both shapes. On a classic bundle
 * it is `manifest.json`'s own array. On a rolling-sealed bundle
 * (`loader/rolling-seal.ts`) there is no `manifest.json`, and the loader
 * synthesizes a `format_version: '1.2'` union whose `sessions` entries are the
 * per-session rolling manifests' single entries **verbatim** — each carrying the
 * `slog_sha256` / `meta_sha256` that that session's own key signed. So one loop
 * covers both.
 *
 * What the two digests MEAN is not the same, and conflating them was a
 * false-accusation bug that fired at high severity, confidence 1.0 on every
 * honest git submission. A classic seal is taken once, by an explicit `seal`
 * command, over a finished log: whole-file equality is exactly right, and a
 * post-seal append must fail. A ROLLING seal is rewritten at session start, at
 * every checkpoint and at `dispose()`, hashing the log as it stands at that
 * moment — and a git-submitted assignment has no seal step at all, so the
 * archived `.slog` is routinely longer than the digest naming it. Its digests
 * commit to a PREFIX.
 *
 * `loader/rolling-coverage.ts` resolves which prefix, and does so ONLY for a
 * bundle whose manifest is the rolling union. A classic bundle — and a
 * both-shapes bundle, which uses the classic manifest — gets no coverage and
 * therefore keeps whole-file equality and full append detection. The residual is
 * stated rather than hidden: a rolling seal cannot attest to bytes written after
 * it, so the passing verdict reports how much of each log is actually sealed.
 *
 * ## FINAL seals close the append hole
 *
 * The prefix reading costs something real: while a seal can still be superseded,
 * an append past the last checkpoint is indistinguishable from honest growth.
 *
 * The recorder's `dispose()` takes one last roll after `session.end` is emitted
 * and both files are flushed and closed, and marks it `final: true` INSIDE the
 * signed payload. That seal has no future to be incapable of attesting to, so
 * the loader reads it as a whole-file commitment and an append after the session
 * ended fails here at full strength.
 *
 * Three things keep that from becoming a new way to accuse people:
 *
 *  - `final` is signed, so it cannot be added, flipped or stripped without the
 *    session's key;
 *  - its ABSENCE is never a finding. A crash, a power cut, a full disk, a
 *    read-only checkout, `.provenance/` removed by a `git checkout` — every one
 *    leaves a non-final seal, which keeps prefix semantics and reports its
 *    unattested tail. Those are documented, expected paths belonging to students
 *    who did nothing wrong;
 *  - it only ever tightens. There is no value of `final` that makes a bundle
 *    easier to forge.
 *
 * The residual is the downgrade: restoring an earlier, genuinely-signed
 * non-final seal in place of the final one re-opens the gap. It cannot be
 * refuted cryptographically — both seals are real statements by the same key —
 * and it is byte-for-byte indistinguishable from an honest mid-session archive,
 * so it is NOT a finding. It is reported: the passing verdict names the
 * unattested tail and says outright that no final seal is present.
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

import type { Bundle, SealCoverage } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

const ID = 'log_bytes_match' as const;
const LABEL = 'Session log bytes match the signed manifest';

/** A manifest digest is usable only if it is a well-formed sha256. */
const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * How the commitment that was contradicted should be described.
 *
 *  - `whole_file`     — a classic (or both-shapes) manifest digest.
 *  - `rolling_final`  — a rolling seal the recorder marked `final` at dispose(),
 *                       so it too covers the whole file.
 *  - `rolling_prefix` — a non-final rolling seal, whose committed PREFIX no
 *                       state of the archived file reproduces.
 *
 * These are separated because the sentence staff read has to claim exactly what
 * the evidence supports, and no more.
 */
type MismatchMode = 'whole_file' | 'rolling_final' | 'rolling_prefix';

type Mismatch = {
  sessionId: string;
  /** Which of the two files disagreed. */
  file: '.slog' | '.slog.meta';
  expected: string;
  actual: string;
  mode: MismatchMode;
};

/** A rolling seal that covered a verified prefix, with more written after it. */
type PrefixPartial = {
  sessionId: string;
  file: '.slog' | '.slog.meta';
  sealed: number;
  total: number;
  unit: 'bytes' | 'checkpoints';
};

/**
 * One digest's verdict. `evaluated: false` means there was no usable commitment
 * to compare against — not a pass and emphatically not a failure.
 */
type Verdict =
  | { evaluated: false }
  | { evaluated: true; mismatch: Mismatch | null; partial: PrefixPartial | null };

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
): Verdict {
  if (typeof committed !== 'string' || !SHA256_RE.test(committed)) {
    return { evaluated: false };
  }
  if (committed === actual) return { evaluated: true, mismatch: null, partial: null };
  return {
    evaluated: true,
    partial: null,
    mismatch: { sessionId, file, expected: committed, actual, mode: 'whole_file' },
  };
}

/**
 * Read a ROLLING seal's coverage verdict for one file.
 *
 * The loader has already done the work (`loader/rolling-coverage.ts`), because
 * only it has the bytes — `ParsedSession` deliberately keeps just the digest so
 * the server's LRU of parsed bundles does not carry a second copy of every log.
 *
 * `unavailable` falls through to whole-file equality: refusing to answer is not
 * a licence to stay silent, and the fallback is the stricter of the two.
 */
function fromCoverage(
  sessionId: string,
  file: '.slog' | '.slog.meta',
  coverage: SealCoverage,
  committed: unknown,
  actual: string,
  /** The seal declared itself FINAL, so the loader read it as a whole-file digest. */
  final: boolean,
): Verdict {
  switch (coverage.kind) {
    case 'exact':
      return { evaluated: true, mismatch: null, partial: null };
    case 'partial':
      // Only a non-final seal can produce this: `wholeFileCoverage` never
      // returns `partial`. Honest growth past a seal that was signed while the
      // session was still running — reported, never a finding.
      return {
        evaluated: true,
        mismatch: null,
        partial: {
          sessionId,
          file,
          sealed: coverage.sealed,
          total: coverage.total,
          unit: coverage.unit,
        },
      };
    case 'no_match':
      return {
        evaluated: true,
        partial: null,
        mismatch: {
          sessionId,
          file,
          expected: typeof committed === 'string' ? committed : '(absent)',
          actual,
          mode: final ? 'rolling_final' : 'rolling_prefix',
        },
      };
    case 'unavailable':
      return compare(sessionId, file, committed, actual);
  }
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
  const partials: PrefixPartial[] = [];
  let evaluated = 0;

  // Non-empty only on a bundle whose manifest IS the rolling union — see
  // `loader/rolling-coverage.ts` for why a rolling digest is a prefix
  // commitment and a classic one is not.
  const coverageBySession = new Map(
    (bundle.rollingSeal?.coverage ?? []).map((c) => [c.sessionId, c]),
  );

  for (const session of bundle.sessions) {
    // A manifest MAY legitimately carry several entries; `session_id: null`
    // marks one whose .slog the sealer could not parse. Match on id only, and
    // check every entry that claims this session rather than just the first —
    // two entries disagreeing about the same session is itself evidence, and
    // taking `find()`'s first hit would let the honest one mask the other.
    const entries = bundle.manifest.sessions.filter((s) => s.session_id === session.sessionId);
    if (entries.length === 0) continue;

    const coverage = coverageBySession.get(session.sessionId);

    for (const entry of entries) {
      const slog =
        coverage !== undefined
          ? fromCoverage(
              session.sessionId,
              '.slog',
              coverage.slog,
              entry.slog_sha256,
              session.slogSha256,
              coverage.final,
            )
          : compare(session.sessionId, '.slog', entry.slog_sha256, session.slogSha256);
      if (slog.evaluated) {
        evaluated++;
        if (slog.mismatch !== null) mismatches.push(slog.mismatch);
        if (slog.partial !== null) partials.push(slog.partial);
      }

      const meta =
        coverage !== undefined
          ? fromCoverage(
              session.sessionId,
              '.slog.meta',
              coverage.meta,
              entry.meta_sha256,
              session.metaSha256,
              coverage.final,
            )
          : compare(session.sessionId, '.slog.meta', entry.meta_sha256, session.metaSha256);
      if (meta.evaluated) {
        evaluated++;
        if (meta.mismatch !== null) mismatches.push(meta.mismatch);
        if (meta.partial !== null) partials.push(meta.partial);
      }
    }
  }

  if (mismatches.length > 0) {
    const per = mismatches
      .map((m) =>
        m.mode === 'rolling_prefix'
          ? `session ${m.sessionId} ${m.file}: no state this file could have passed through ` +
            `hashes to the sealed value ${m.expected} (bundled bytes hash to ${m.actual})`
          : `session ${m.sessionId} ${m.file}: manifest commits to ${m.expected}, ` +
            `bundled bytes hash to ${m.actual}`,
      )
      .join('; ');

    // Each seal shape's failure has to be described as what it actually is —
    // otherwise the wording would claim more than the evidence supports. A
    // non-final rolling seal commits only to a prefix, so its failure is a
    // contradicted prefix; a final one, like a classic seal, commits to the
    // whole file, so its failure is a modified finished log.
    const why = mismatches.some((m) => m.mode === 'rolling_prefix')
      ? `A rolling seal is rewritten as its session grows, so its digests commit to the log ` +
        `PREFIX that existed when each seal was signed. Growth past that point is expected. ` +
        `What is reported here is different: no prefix of the archived file — and no ` +
        `truncation of the checkpoint list — reproduces the digest the session's own key ` +
        `signed. The sealed region itself was modified after sealing: edited, reordered, or ` +
        `truncated below the sealed point.`
      : mismatches.some((m) => m.mode === 'rolling_final')
        ? `This session's last rolling seal is marked FINAL: the recorder wrote it at ` +
          `shutdown, after session.end was recorded and both log files were flushed and ` +
          `closed, and signed that claim with the session's own key. A final seal commits to ` +
          `the WHOLE log, not to a prefix, so there is no honest later growth to excuse — the ` +
          `file was appended to, truncated, or edited after the session ended.`
        : `The manifest is ed25519-signed, so these digests were fixed when the bundle was ` +
          `sealed and cannot change without the signing key. A differing digest means the log ` +
          `file was modified after sealing — appended to, truncated, or edited. This is not ` +
          `recoverable from a benign cause: the recorder writes each log once and seals over ` +
          `the finished bytes.`;

    return {
      id: ID,
      label: LABEL,
      status: 'fail',
      detail: `Session log bytes do not match the signed manifest: ${per}. ${why}`,
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

  // How the rolling seals described themselves, so a passing verdict can say
  // whether these logs are sealed or sealed IN FULL. Empty for a classic or
  // both-shapes bundle, which is already whole-file everywhere.
  const rollingCoverage = [...coverageBySession.values()];
  const finalSeals = rollingCoverage.filter((c) => c.final).length;
  const nonFinalSeals = rollingCoverage.length - finalSeals;

  if (partials.length === 0) {
    return {
      id: ID,
      label: LABEL,
      status: 'pass',
      detail:
        `${evaluated} log-file digest(s) matched the signed manifest exactly. The bytes of ` +
        `every checked .slog and .slog.meta are the bytes that were sealed.` +
        (rollingCoverage.length === 0
          ? ''
          : ` ${finalSeals} of ${rollingCoverage.length} rolling seal(s) are marked FINAL ` +
            `(written at session shutdown over a finished log), so those logs are covered in ` +
            `full and an append after the session ended would have failed this check.` +
            (nonFinalSeals === 0
              ? ''
              : ` The other ${nonFinalSeals} were signed while their session was still ` +
                `running, and happen to match the archived bytes exactly, so nothing was ` +
                `written after them either.`)),
    };
  }

  // Passing, but say exactly how much is actually attested. A rolling seal
  // cannot sign bytes that did not exist yet, so the tail past the last seal is
  // unattested by construction — for a git submission, where the grader clones
  // whenever they like, that is the normal case and not a finding. Reporting the
  // size is the difference between "sealed" and "sealed in full", and staff are
  // entitled to see which one they have.
  const per = partials
    .map(
      (p) =>
        `session ${p.sessionId} ${p.file}: ${p.sealed} of ${p.total} ${p.unit} sealed, ` +
        `${p.total - p.sealed} written after the last seal`,
    )
    .join('; ');

  return {
    id: ID,
    label: LABEL,
    status: 'pass',
    detail:
      `${evaluated} log-file digest(s) agree with the signed manifest. ${partials.length} of ` +
      `them are rolling seals covering a verified PREFIX rather than the whole file — ${per}. ` +
      `A rolling seal is rewritten at session start, at each checkpoint and at shutdown, so a ` +
      `log archived mid-session (a git submission, a crash, a partner's clone) legitimately ` +
      `runs past its own last seal. Everything up to the sealed point is byte-for-byte what ` +
      `that session's key signed; anything after it is covered by the chain and checkpoint ` +
      `checks but by no bundle-level signature. ` +
      // The unattested tail is stated, and so is the reason it exists: NO FINAL
      // SEAL. That is what makes the downgrade visible. A student who replaces
      // their session's final seal with an earlier, non-final one they also
      // legitimately signed re-opens exactly this gap — and it lands here, in
      // plain numbers, instead of passing silently as "sealed".
      //
      // It stays a PASS, deliberately. An honest mid-session archive produces a
      // byte-for-byte identical shape, and there is no evidence that
      // distinguishes them. Turning a coverage gap into a finding would accuse
      // every student whose editor crashed. Reporting the size of the gap is
      // what staff are entitled to; inferring intent from it is not.
      `${nonFinalSeals} of ${rollingCoverage.length} rolling seal(s) here are NOT marked ` +
      `final, which is why a tail is unattested: a session that shuts down cleanly writes a ` +
      `final seal covering its whole log, and no such seal is present for these. That is ` +
      `expected for work archived mid-session and is not by itself evidence of anything — but ` +
      `it does mean the bytes after each sealed point carry no bundle-level signature, so an ` +
      `append there could not be detected.`,
  };
}
