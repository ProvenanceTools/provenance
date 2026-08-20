/**
 * THE READ-SIDE ORPHAN GUARD, driven end to end over a git-shaped submission.
 *
 * ## The real incident this file pins
 *
 * A student's editor crashes mid-session. On the next start, `chain-recovery.ts`
 * cannot chain-validate the damaged `.slog`, so it quarantines it — renamed to
 * `<slog>.corrupt-<ISO>` — and starts a fresh session. PRD §4.8 behaviour,
 * working exactly as designed. What it leaves behind in `.provenance/` is the
 * quarantined log, a `.slog.meta` sidecar with no log beside it any more, and
 * that session's `manifest-<id>.json` rolling seal.
 *
 * On the ZIP path none of that ever reaches a reader: `sealBundle`'s orphan
 * guard drops all three before packing and tells the student it did. **The git
 * path never runs seal.** The student pushes, the grader clones, and whatever is
 * in `.provenance/` on disk IS the submission.
 *
 * So the stranded sidecar reached `unzipBundle` as `orphaned_meta` — a HARD
 * ERROR FOR THE WHOLE BUNDLE, returned before a single validation check ran. The
 * server's `loadSubmissionIndex` throws on it, so every read path throws with
 * it. Every healthy session the student recorded became unreadable because of
 * one leftover file produced by a crash they could not have prevented.
 *
 * These tests drive the REAL `loadBundle` + `runValidation` over that exact
 * archive shape and hold three things at once:
 *
 *   1. it LOADS — degraded, not destroyed;
 *   2. the healthy session is analysed IN FULL, with a clean validation report;
 *   3. the leftover is REPORTED, and reported as an incomplete recording rather
 *      than as anything a grader could read as tampering.
 *
 * (3) is not decoration. Degrading silently would be a worse outcome than the
 * fatal error it replaces, so every assertion about reporting here is
 * load-bearing.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import JSZip from 'jszip';
import { loadBundle } from './parse-bundle.js';
import { runValidation } from '../validation/run-validation.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';

// Wire SHA-512 for jsdom compatibility (same pattern as build-test-bundle).
beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

const fixedNow = (): string => '2026-08-20T00:00:00.000Z';

/**
 * A git-shaped `.provenance/`: per-session rolling seals, NO classic
 * `manifest.json`, and session[1]'s `.slog` gone while its `.slog.meta` remains
 * — the shape a crash-recovery quarantine leaves on disk.
 */
async function buildQuarantinedGitScope(): Promise<{ blob: Blob }> {
  const built = await buildTestBundle({
    sessions: [
      { eventCount: 5, appendDocSave: true },
      { eventCount: 4, appendDocSave: true },
    ],
    submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x5x4x3x2x1' }],
    // No `alsoClassic`: this is a git submission, so the rolling seals are the
    // only thing sealing it.
    rollingSeal: {},
    // Session[1]'s `.slog` is omitted while its `.slog.meta` stays — precisely
    // what the quarantine rename produces.
    tamper: { omitOneSlog: true },
  });
  return { blob: built.blob };
}

describe('git-path orphan guard: a crash-recovery quarantine degrades, it does not destroy', () => {
  it('loads the submission instead of failing it outright', async () => {
    const { blob } = await buildQuarantinedGitScope();

    const result = await loadBundle(blob, 'student-repo.zip', fixedNow);

    // The whole point. Before the guard this was
    // `err({ kind: 'orphaned_meta', ... })` and the student's entire submission
    // was unreadable.
    expect(result.ok).toBe(true);
  });

  it('still analyses the healthy session in full', async () => {
    const { blob } = await buildQuarantinedGitScope();
    const result = await loadBundle(blob, 'student-repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundle = result.value;
    // One healthy session survives, with its events intact — this is the
    // evidence that used to be thrown away.
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.sessions[0]!.events.length).toBeGreaterThan(0);
    // The synthesized union manifest covers exactly the session that is here.
    expect(bundle.manifest.sessions).toHaveLength(1);
    expect(bundle.manifest.sessions[0]!.session_id).toBe(bundle.sessions[0]!.sessionId);
  });

  it('reports the leftover rather than dropping it silently', async () => {
    const { blob } = await buildQuarantinedGitScope();
    const result = await loadBundle(blob, 'student-repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dropped = result.value.droppedArtifacts;

    // The stranded sidecar, plus the rolling seal of the session it belonged to.
    expect(dropped.map((d) => d.kind).sort()).toEqual(['orphaned_meta', 'orphaned_rolling_seal']);

    const meta = dropped.find((d) => d.kind === 'orphaned_meta')!;
    // Named by the FILE it actually is, so a grader can go and look at it.
    expect(meta.filename).toMatch(/^session-[0-9a-f-]+\.slog\.meta$/);
    expect(meta.logFileId).toBeDefined();
    expect(meta.filename).toContain(meta.logFileId!);

    // The sidecar names the recording that went missing. This is what makes the
    // seal drop possible, and it is a LOGICAL id, so it must NOT equal the
    // filename uuid.
    expect(meta.logicalSessionId).toBeDefined();
    expect(meta.logicalSessionId).not.toBe(meta.logFileId);

    const seal = dropped.find((d) => d.kind === 'orphaned_rolling_seal')!;
    // The seal is named after the LOGICAL id — the other id space — and the
    // two records agree about which recording was lost.
    expect(seal.filename).toBe(`manifest-${meta.logicalSessionId!}.json`);
  });

  it('describes the leftover as an incomplete recording, never as tampering', async () => {
    const { blob } = await buildQuarantinedGitScope();
    const result = await loadBundle(blob, 'student-repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    for (const artifact of result.value.droppedArtifacts) {
      expect(artifact.detail).toContain('INCOMPLETE RECORDING');
      // A leftover file must not be readable as an accusation. The old
      // `no_session_log` text offered "either the log was deleted or the seal
      // was planted" — for a power cut.
      expect(artifact.detail).not.toMatch(/tamper|planted|deleted the|forged/i);
    }
  });

  it('manufactures NO finding: validation stays clean over the surviving session', async () => {
    const { blob } = await buildQuarantinedGitScope();
    const result = await loadBundle(blob, 'student-repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const report = await runValidation(result.value);

    // THE ASSERTION THIS FILE EXISTS FOR.
    //
    // Degrading is only correct if it does not convert a crash into an
    // accusation. Without the rolling-seal half of the guard, session[1]'s
    // orphaned seal becomes a `no_session_log` defect, `verify-manifest-sig.ts`
    // folds every defect into check 1, and check 1 fails at high severity /
    // confidence 1.0 — producing a `manifest_sig_invalid` Flag against a student
    // whose editor crashed. That is strictly worse than the load failure this
    // change replaced.
    const manifestSig = report.checks.find((c) => c.id === 'manifest_sig')!;
    expect(manifestSig.status).toBe('pass');

    expect(report.checks).toHaveLength(8);
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
    expect(report.overall).not.toBe('fail');

    // The out-of-band bundle detections must be clean too — `log_bytes_match` is
    // the check that produced the last maximum-severity false accusation on this
    // exact path.
    for (const detection of report.bundleDetections ?? []) {
      expect(detection.status).not.toBe('fail');
    }
  });
});

describe('the other shapes a git-submitted .provenance/ can present', () => {
  /**
   * Add raw extra entries to a built bundle's ZIP.
   *
   * Takes the ArrayBuffer rather than the Blob: jsdom's Blob has no
   * `arrayBuffer()`, which is why `buildTestBundle` returns both.
   */
  async function withExtraEntries(
    zipBuffer: ArrayBuffer,
    entries: Record<string, string>,
  ): Promise<ArrayBuffer> {
    const zip = await JSZip.loadAsync(zipBuffer);
    for (const [name, content] of Object.entries(entries)) zip.file(name, content);
    return zip.generateAsync({ type: 'arraybuffer' });
  }

  it('tolerates a quarantined .corrupt-* log and reports it', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    // What `chain-recovery.ts` leaves on disk. `sealBundle` filters it out of a
    // ZIP; on the git path nothing does, and it used to be `unexpected_file` —
    // fatal to the whole submission.
    const buffer = await withExtraEntries(zipBuffer, {
      'session-11111111-2222-4333-8444-555555555555.slog.corrupt-2026-08-19T12:00:00.000Z':
        'garbage that never parsed',
    });

    const result = await loadBundle(buffer, 'student-repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.sessions).toHaveLength(1);
    const dropped = result.value.droppedArtifacts;
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.kind).toBe('quarantined_log');
    expect(dropped[0]!.detail).toContain('INCOMPLETE RECORDING');
  });

  it('tolerates a zero-byte .slog, drops its sidecar with it, and names the session', async () => {
    // The other shape that is not hypothetical. `SessionWriter.open` creates the
    // `.slog` eagerly while the buffer policy holds the first entries, and the
    // sidecar is written eagerly too — so a session torn down before its first
    // flush leaves a complete `.slog.meta` beside a log of zero bytes. It used to
    // reach `parseSession` as `first_event_not_session_start` (actualKind
    // "none"), and `parse-bundle.ts` fails fast on the first session parse error,
    // so it killed the whole submission.
    const ghostLogic = '99999999-0000-4000-8000-aaaaaaaaaaaa';
    const ghostFile = '88888888-0000-4000-8000-bbbbbbbbbbbb';
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const buffer = await withExtraEntries(zipBuffer, {
      [`session-${ghostFile}.slog`]: '',
      [`session-${ghostFile}.slog.meta`]: JSON.stringify({
        format_version: '1.0',
        session_id: ghostLogic,
        session_pubkey: 'ab'.repeat(32),
        encrypted_session_privkey: '',
        checkpoints: [],
      }),
    });

    const result = await loadBundle(buffer, 'student-repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The real session is untouched.
    expect(result.value.sessions).toHaveLength(1);

    const dropped = result.value.droppedArtifacts;
    expect(dropped.map((d) => d.kind)).toEqual(['empty_slog']);
    expect(dropped[0]!.filename).toBe(`session-${ghostFile}.slog`);
    // Zero bytes means zero recorded events, so dropping discards no evidence —
    // whereas keeping it discarded all of it.
    expect(dropped[0]!.detail).toContain('INCOMPLETE RECORDING');
    // The sidecar still names the recording, in the LOGICAL id space, even
    // though the log itself never got a byte written to it. That is what would
    // let this session's rolling seal be dropped with it.
    expect(dropped[0]!.logicalSessionId).toBe(ghostLogic);
    expect(dropped[0]!.logFileId).toBe(ghostFile);
  });

  it('tolerates a .tmp staging leftover and reports it', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const buffer = await withExtraEntries(zipBuffer, {
      'session-11111111-2222-4333-8444-555555555555.slog.tmp': 'half a write',
    });

    const result = await loadBundle(buffer, 'student-repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.droppedArtifacts.map((d) => d.kind)).toEqual(['staging_leftover']);
  });

  it('never drops a seal a SURVIVING session still claims', async () => {
    // The guard on the guard. A stranded `.slog.meta` names its recording by
    // LOGICAL id — but if a sidecar was copied or renamed, a dropped one can
    // name the same recording a session that IS here claims. Dropping "the
    // dropped session's seal" would then strip a healthy session's cover, and
    // that session comes out `unsealed_session`: a finding manufactured against
    // work we actually hold, by the code meant to stop findings being
    // manufactured.
    const built = await buildTestBundle({
      sessions: [{ eventCount: 5, appendDocSave: true }],
      rollingSeal: {},
    });
    const liveLogicalId = built.sessionIds[0]!;

    // A stranded sidecar claiming the LIVE session's logical id.
    const buffer = await withExtraEntries(built.zipBuffer, {
      'session-77777777-0000-4000-8000-cccccccccccc.slog.meta': JSON.stringify({
        format_version: '1.0',
        session_id: liveLogicalId,
        session_pubkey: 'ab'.repeat(32),
        encrypted_session_privkey: '',
        checkpoints: [],
      }),
    });

    const result = await loadBundle(buffer, 'student-repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The stray sidecar is still dropped and reported.
    expect(result.value.droppedArtifacts.map((d) => d.kind)).toEqual(['orphaned_meta']);
    // But the live session KEEPS its seal ...
    expect(result.value.rollingSeal!.seals.map((s) => s.sessionId)).toContain(liveLogicalId);
    // ... so no unsealed_session is invented for it, and check 1 still passes.
    expect(result.value.rollingSeal!.defects.map((d) => d.kind)).not.toContain('unsealed_session');

    const report = await runValidation(result.value);
    expect(report.checks.find((c) => c.id === 'manifest_sig')!.status).toBe('pass');
  });

  it('still refuses a genuinely unrecognized file — the contents stay a closed set', async () => {
    const { blob } = await buildTestBundle({
      tamper: { addStrayFile: { name: 'notes.txt', content: 'hello' } },
    });

    const result = await loadBundle(blob, 'student-repo.zip', fixedNow);

    // Deliberately unchanged. The two tolerated patterns above are narrow
    // because they name artifacts the recorder itself creates under names it
    // chooses; an unexplained file is exactly what no later stage should have
    // to reason about.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unexpected_file');
  });

  it('leaves a healthy git submission byte-for-byte unaffected', async () => {
    // The control. A `.provenance/` with nothing left over must produce exactly
    // what it always did, with an empty report.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 5, appendDocSave: true }, { eventCount: 4 }],
      submissionFiles: [{ path: '/test/file.py', status: 'present', content: 'x5x4x3x2x1' }],
      rollingSeal: {},
    });

    const result = await loadBundle(blob, 'student-repo.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.droppedArtifacts).toEqual([]);
    expect(result.value.sessions).toHaveLength(2);

    const report = await runValidation(result.value);
    expect(report.checks.filter((c) => c.status === 'fail')).toEqual([]);
  });
});
