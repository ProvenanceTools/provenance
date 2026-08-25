/**
 * Check 8 — submitted_code_match (PRD §5.4 step 8).
 *
 * For each reviewed file, compare the submitted file's hash (from the bundle's
 * signed manifest, re-verified against the zip bytes during loadBundle) to the
 * recorder's LAST recorded on-disk hash for that file — the sha256 of the most
 * recent doc.save / fs.external_change(new_hash) / doc.open across the bundle.
 *
 *   match               → pass
 *   mismatch, chain ok  → fail  (file edited outside the recording)
 *   chain broken        → skip  (Check 3 already fails this)
 *   no usable events    → skip
 *   status 'missing'    → skip  (nothing submitted to compare)
 *   bytes present but
 *     hashOk === false  → fail  (bundle bytes don't match their own manifest hash)
 *
 * No reconstruction: we compare recorded hashes only, so reconstruction taint
 * is irrelevant here.
 *
 * CONCURRENCY (Tier 2.2 / spec Tier 2.4). "The LAST recorded hash" is an
 * ordering claim, and until now it was a WALL-CLOCK one: `bundle.sessions` is
 * sorted by `firstEvent.wall`, and the scan below is last-write-wins over that
 * order. With two partners on divergent branches, whose hash ends up "last" is
 * then decided by whose laptop clock ran ahead — and the loser's submission is
 * reported as `mismatch`, i.e. "File was changed outside the recording", at
 * severity HIGH against a named student who did nothing wrong (S16, S27).
 *
 * So when a path's on-disk observations span two PROVABLY DIFFERENT contributors,
 * "last" is resolved over `≺` instead of the clock, and the rule becomes:
 *
 *   - the manifest sha matches ANY `≺`-maximal recorded state → `match`;
 *   - it matches none of them                                 → `unknown`, not
 *     `mismatch`.
 *
 * The second half is the conservative half and it is the point. With concurrent
 * branches there is no established "final recorded state" to have departed
 * from: the submitted bytes are quite possibly a merge result that no session
 * ever observed on disk, which is normal, correct group work. Spec §6 Rule 2
 * allows a finding to name a person only on `established` evidence, and a
 * verdict that depends on which clock ran fast is not that. `unknown` says we
 * cannot tell, which is true.
 *
 * A path whose observations do NOT span two different contributors — every solo
 * submission, and every group file only one partner touched — takes the
 * unchanged wall-ordered last-write-wins path below. That is what keeps this
 * check byte-identical for every existing course.
 *
 * RE-RUNNABLE against a stored, source-stripped bundle. The tamper sub-check is
 * gated on bytes actually being present; the match comparison needs only the
 * signed manifest's sha256 and the recorded event hashes, both of which survive
 * source stripping. (Before 2026-07 absent bytes were indistinguishable from
 * wrong bytes, so any re-run reported every stored bundle as tampered — hence
 * the old "never re-run check 8" rule.)
 *
 * NOTE: 1.0 bundles (no submission_files) → check is skipped entirely.
 * 1.1 bundles with at least one matching file can reach overall 'pass'.
 */
import type { HashedEnvelope } from '@provenance/log-core';
import { buildObservedDag } from '../git/observed-dag.js';
import { contributorOf } from '../identity/resolve-contributors.js';
import { compareContributors, type SessionContributor } from '../identity/types.js';
import { resolveAliasesForBundle } from '../index/build-index.js';
import type { Bundle } from '../loader/types.js';
import { buildEventOrdering, compareEvents, type EventOrdering } from '../order/happens-before.js';
import type { ValidationCheck } from './check-types.js';

export type SubmittedFileVerdict = {
  path: string;
  status: 'present' | 'missing';
  /**
   * 'match' | 'mismatch' | 'unknown' (skip) | 'attachment' (not comparable).
   *
   * `'attachment'` is NOT a weaker 'unknown'. Unknown means we could not tell;
   * attachment means the question does not apply, because the file was sealed
   * and hashed but deliberately never captured. Collapsing the two would put
   * attachments into whatever surface renders unresolved files.
   */
  verdict: 'match' | 'mismatch' | 'unknown' | 'attachment';
  submittedSha: string | null;
  recordedSha: string | null;
  detail: string;
  supportingSeqs: Array<{ sessionId: string; seq: number }>;
};

/**
 * Last recorded on-disk hash per file, scanning all sessions in order.
 *
 * Paths are canonicalized through the workspace-root alias map (D3) first. A
 * student who worked on one file from two different workspace roots records it
 * under two relative paths; without this, check 8 looks up only the manifest's
 * spelling and finds a STALE save from whichever sessions used that root —
 * then reports "File was changed outside the recording" against a submission
 * that matches the log exactly. See `.notes/reconstruction-triage.md` (D3).
 */
function lastRecordedHashes(
  bundle: Bundle,
): Map<string, { sha: string; sessionId: string; seq: number }> {
  const out = new Map<string, { sha: string; sessionId: string; seq: number }>();
  for (const [path, observations] of recordedObservations(bundle)) {
    // Wall-ordered last-write-wins, exactly as before: `bundle.sessions` is
    // wall-sorted and `observations` preserves that scan order.
    out.set(path, observations[observations.length - 1]!);
  }
  return out;
}

type Observation = { sha: string; sessionId: string; seq: number };

/**
 * EVERY on-disk observation per file, in the bundle's own scan order.
 *
 * Paths are canonicalized through the workspace-root alias map (D3) first. A
 * student who worked on one file from two different workspace roots records it
 * under two relative paths; without this, check 8 looks up only the manifest's
 * spelling and finds a STALE save from whichever sessions used that root —
 * then reports "File was changed outside the recording" against a submission
 * that matches the log exactly. See `.notes/reconstruction-triage.md` (D3).
 */
function recordedObservations(bundle: Bundle): Map<string, Observation[]> {
  const out = new Map<string, Observation[]>();
  const aliases = resolveAliasesForBundle(bundle);
  for (const session of bundle.sessions) {
    for (const event of session.events as readonly HashedEnvelope[]) {
      let path: string | undefined;
      let sha: string | undefined;
      if (event.kind === 'doc.save' || event.kind === 'doc.open') {
        const d = event.data as { path: string; sha256: string };
        path = d.path;
        sha = d.sha256;
      } else if (event.kind === 'fs.external_change') {
        const d = event.data as { path: string; new_hash: string };
        path = d.path;
        sha = d.new_hash;
      }
      if (path === undefined || sha === undefined) continue;
      const key = aliases.get(path) ?? path;
      let bucket = out.get(key);
      if (bucket === undefined) {
        bucket = [];
        out.set(key, bucket);
      }
      bucket.push({ sha, sessionId: session.sessionId, seq: event.seq });
    }
  }
  return out;
}

/**
 * The `≺`-maximal recorded states for a path, when — and ONLY when — the path's
 * observations span two provably different contributors.
 *
 * `null` means "not a cross-contributor path", i.e. take the unchanged
 * wall-ordered single answer. That is the gate that keeps every solo submission,
 * and every group file only one partner touched, on exactly today's code.
 *
 * Cheap by construction: within one session the hash chain totally orders the
 * observations, so only each session's LAST observation can be maximal. The
 * pairwise comparison is therefore over sessions (a handful), never over saves
 * (thousands).
 */
function concurrentRecordedStates(
  bundle: Bundle,
  observations: readonly Observation[],
  ordering: EventOrdering | null,
): Observation[] | null {
  if (ordering === null) return null;

  const lastPerSession = new Map<string, Observation>();
  for (const observation of observations) lastPerSession.set(observation.sessionId, observation);
  const candidates = [...lastPerSession.values()].sort((a, b) =>
    a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : a.seq - b.seq,
  );
  if (candidates.length < 2) return null;

  const contributors = new Map<string, SessionContributor>();
  for (const candidate of candidates) {
    contributors.set(candidate.sessionId, contributorOf(bundle, candidate.sessionId));
  }
  const spansTwo = candidates.some((a) =>
    candidates.some(
      (b) =>
        compareContributors(contributors.get(a.sessionId)!, contributors.get(b.sessionId)!) ===
        'different',
    ),
  );
  if (!spansTwo) return null;

  const maximal = candidates.filter(
    (a) =>
      !candidates.some(
        (b) =>
          b !== a &&
          compareEvents(
            ordering,
            { sessionId: a.sessionId, seq: a.seq },
            { sessionId: b.sessionId, seq: b.seq },
          ) === 'before',
      ),
  );
  // One maximal state is not a divergence — `≺` established a single latest
  // recorded state across the contributors, which is a stronger answer than the
  // clock ever gave. Fall through to the ordinary comparison against it.
  return maximal.length > 1 ? maximal : null;
}

/**
 * `≺` over the bundle, memoized, and built only when the bundle actually has two
 * different contributors. A solo bundle gets `null` and pays nothing.
 */
const orderingCache = new WeakMap<Bundle, { ordering: EventOrdering | null }>();
function orderingFor(bundle: Bundle): EventOrdering | null {
  const cached = orderingCache.get(bundle);
  if (cached !== undefined) return cached.ordering;

  const contributors = new Map<string, SessionContributor>();
  for (const session of bundle.sessions) {
    contributors.set(session.sessionId, contributorOf(bundle, session.sessionId));
  }
  const keys = new Set(
    [...contributors.values()].filter((c) => c.kind === 'attributed').map((c) => c.contributorKey),
  );
  const ordering =
    keys.size > 1
      ? buildEventOrdering({ source: bundle, dag: buildObservedDag(bundle), contributors })
      : null;
  orderingCache.set(bundle, { ordering });
  return ordering;
}

/** Per-file verdicts; shared by Check 8 and the Source view. */
export function submittedFileVerdicts(
  bundle: Bundle,
  opts: { chainIntact: boolean },
): SubmittedFileVerdict[] {
  const recorded = lastRecordedHashes(bundle);
  const observations = recordedObservations(bundle);
  const ordering = orderingFor(bundle);
  const verdicts: SubmittedFileVerdict[] = [];

  for (const [path, f] of bundle.submissionFiles) {
    if (f.role === 'attachment') {
      // Real, detectable tampering — present bytes that disagree with their own
      // signed manifest sha256 — needs no event provenance to catch, and an
      // attachment is not exempt from it. Reporting 'attachment' here would be
      // an unearned exculpatory claim ("covered by the signed manifest") about
      // bytes the manifest hash has already contradicted. This is the SAME
      // tamper sub-check as the non-attachment path below; it must run before
      // the branch returns, because no attachment may reach the reconstruction
      // comparison the rest of this function performs.
      if (f.bytes !== undefined && !f.hashOk) {
        verdicts.push({
          path,
          status: 'present',
          verdict: 'mismatch',
          submittedSha: f.sha256,
          recordedSha: null,
          detail: 'Submitted bytes do not match their own manifest sha256 (tampered bundle).',
          supportingSeqs: [],
        });
        continue;
      }
      // Attested by hash in the signed manifest, never captured, so there is
      // nothing to reconstruct and nothing to compare. Spec §9.1.
      verdicts.push({
        path,
        status: f.status,
        verdict: 'attachment',
        submittedSha: f.sha256,
        recordedSha: null,
        detail:
          'Carried in the bundle and covered by the signed manifest, but never captured — ' +
          'the assignment lists it as an attachment, so no event history exists to compare against.',
        supportingSeqs: [],
      });
      continue;
    }
    if (f.status === 'missing') {
      verdicts.push({
        path,
        status: 'missing',
        verdict: 'unknown',
        submittedSha: null,
        recordedSha: null,
        detail: 'File listed in files_under_review but absent on disk at seal time.',
        supportingSeqs: [],
      });
      continue;
    }
    // Tamper sub-check. Only assert tampering when we actually HAVE bytes that
    // disagree with the manifest. A stored bundle is provenance-only — student
    // source is stripped after ingest — so `bytes` is absent and `hashOk` is
    // trivially false there (parse-bundle.ts:157 folds "absent" and "wrong"
    // into one flag). Treating that as tampering reported every stored bundle
    // as tampered on any re-run, which is why check 8 was previously
    // un-re-runnable.
    //
    // With bytes absent we fall through to the hash comparison below, which
    // needs only `f.sha256` (from the signed manifest — check 1 verifies that
    // signature) and the recorded event hashes. Both survive stripping, so the
    // match verdict is fully computable against a stored bundle.
    if (f.bytes !== undefined && !f.hashOk) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'mismatch',
        submittedSha: f.sha256,
        recordedSha: null,
        detail: 'Submitted bytes do not match their own manifest sha256 (tampered bundle).',
        supportingSeqs: [],
      });
      continue;
    }
    if (!opts.chainIntact) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'unknown',
        submittedSha: f.sha256,
        recordedSha: null,
        detail: 'Hash chain is broken; cannot trust recorded hashes.',
        supportingSeqs: [],
      });
      continue;
    }
    const rec = recorded.get(path);
    if (rec === undefined) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'unknown',
        submittedSha: f.sha256,
        recordedSha: null,
        detail: 'No doc.open/doc.save/fs.external_change recorded for this file.',
        supportingSeqs: [],
      });
      continue;
    }
    // Tier 2.2 / spec Tier 2.4. When two contributors' recorded states for this
    // path are unordered, "the last recorded state" is not established, so a
    // clock-decided `mismatch` here would be a HIGH-severity accusation resting
    // on whose laptop ran fast. Match against ANY live state; otherwise say we
    // cannot tell.
    const concurrent = concurrentRecordedStates(bundle, observations.get(path) ?? [], ordering);
    if (concurrent !== null) {
      const agreeing = concurrent.find((c) => c.sha === f.sha256);
      if (agreeing !== undefined) {
        verdicts.push({
          path,
          status: 'present',
          verdict: 'match',
          submittedSha: f.sha256,
          recordedSha: agreeing.sha,
          detail:
            'Submitted file matches one of several concurrently recorded on-disk states ' +
            '(contributors edited this file on divergent branches).',
          supportingSeqs: [{ sessionId: agreeing.sessionId, seq: agreeing.seq }],
        });
        continue;
      }
      verdicts.push({
        path,
        status: 'present',
        verdict: 'unknown',
        submittedSha: f.sha256,
        recordedSha: null,
        detail:
          `${concurrent.length} contributors recorded concurrent, unordered on-disk states for ` +
          `this file, so there is no established "last recorded state" to compare against. The ` +
          `submitted bytes match none of them, which is expected when the submission is a merge ` +
          `result no session observed on disk. Not reported as a mismatch: the evidence does ` +
          `not establish that the file was changed outside the recording.`,
        supportingSeqs: concurrent.map((c) => ({ sessionId: c.sessionId, seq: c.seq })),
      });
      continue;
    }

    if (rec.sha === f.sha256) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'match',
        submittedSha: f.sha256,
        recordedSha: rec.sha,
        detail: 'Submitted file matches the last recorded on-disk state.',
        supportingSeqs: [{ sessionId: rec.sessionId, seq: rec.seq }],
      });
    } else {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'mismatch',
        submittedSha: f.sha256,
        recordedSha: rec.sha,
        detail: `Submitted sha256 ${f.sha256} != last recorded on-disk sha256 ${rec.sha}. File was changed outside the recording.`,
        supportingSeqs: [{ sessionId: rec.sessionId, seq: rec.seq }],
      });
    }
  }
  return verdicts;
}

export function verifySubmittedCode(
  bundle: Bundle,
  opts: { chainIntact: boolean },
): ValidationCheck {
  // 1.0 bundles / no submission files → nothing to check.
  if (bundle.submissionFiles.size === 0) {
    return {
      id: 'submitted_code_match',
      label: 'Submitted code matches recorded final state',
      status: 'skipped',
      detail: 'Bundle has no submission files (format 1.0).',
    };
  }

  const verdicts = submittedFileVerdicts(bundle, opts);
  const mismatches = verdicts.filter((v) => v.verdict === 'mismatch');
  const matches = verdicts.filter((v) => v.verdict === 'match');

  if (mismatches.length > 0) {
    return {
      id: 'submitted_code_match',
      label: 'Submitted code matches recorded final state',
      status: 'fail',
      detail: `${mismatches.length} submitted file(s) do not match the recording: ${mismatches.map((m) => `${m.path} (${m.detail})`).join(' | ')}`,
      supportingSeqs: mismatches.flatMap((m) => m.supportingSeqs),
    };
  }
  if (matches.length === 0) {
    // Carry the per-file reasons up. A bare "no submitted file could be checked"
    // reads as a plumbing failure, but a skip caused by concurrent recorded
    // states is a substantive fact a grader needs — it says the contributors
    // diverged and the submission is plausibly a merge nobody observed.
    const unresolved = verdicts.filter((v) => v.verdict === 'unknown');
    // Attachments are the third way to get here, and none of the three reasons
    // the fallback sentence names is true of them: the chain is fine, the files
    // are present, and there is no recorded state BY COURSE POLICY rather than
    // by any failure. Reporting a plumbing failure for a bundle whose file set
    // is attachments is a misattributed skip reason, and R1 requires the check
    // say why it could not evaluate rather than imply something went wrong.
    const attachments = verdicts.filter((v) => v.verdict === 'attachment');
    return {
      id: 'submitted_code_match',
      label: 'Submitted code matches recorded final state',
      status: 'skipped',
      detail:
        unresolved.length > 0
          ? `No submitted file could be checked: ${unresolved
              .map((v) => `${v.path} (${v.detail})`)
              .join(' | ')}`
          : attachments.length > 0
            ? `No submitted file could be checked: all ${attachments.length} file(s) in this bundle are attachments. The assignment manifest lists them, so they are sealed and hashed but never captured, and no event history exists to compare them against. That is course policy, not a fact about the student.`
            : 'No submitted file could be checked (chain broken, missing, or no recorded state).',
    };
  }
  return {
    id: 'submitted_code_match',
    label: 'Submitted code matches recorded final state',
    status: 'pass',
    detail: `${matches.length} submitted file(s) match the recorded final state.`,
  };
}
