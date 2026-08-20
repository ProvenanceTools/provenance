/**
 * Tests for Check 8 — verify-submitted-code.
 */

import { describe, it, expect } from 'vitest';
import { verifySubmittedCode } from './verify-submitted-code.js';
import type { Bundle, ParsedSession } from '../loader/types.js';
import type { SessionContributor } from '../identity/types.js';
import type { HashedEnvelope, SlogMeta, BundleManifest } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Minimal Bundle fixture helpers
// ---------------------------------------------------------------------------

let _seq = 0;

function resetSeq(): void {
  _seq = 0;
}

function makeEvent(kind: string, data: Record<string, unknown>): HashedEnvelope {
  const seq = _seq++;
  return {
    seq,
    t: seq * 1000,
    wall: `2026-01-01T00:${String(seq).padStart(2, '0')}:00.000Z`,
    kind: kind as HashedEnvelope['kind'],
    data,
    prev_hash: 'prev'.padEnd(64, '0'),
    hash: 'hash'.padEnd(64, '0'),
  } as unknown as HashedEnvelope;
}

function docSave(path: string, sha: string): HashedEnvelope {
  return makeEvent('doc.save', { path, sha256: sha });
}

function docOpen(path: string, sha: string): HashedEnvelope {
  return makeEvent('doc.open', { path, sha256: sha });
}

function fsExternal(path: string, oldHash: string, newHash: string): HashedEnvelope {
  return makeEvent('fs.external_change', { path, old_hash: oldHash, new_hash: newHash });
}

function sessionStart(): HashedEnvelope {
  return makeEvent('session.start', {
    format_version: '1.0',
    session_id: 's1',
    prev_session_id: null,
    assignment: { id: 'hw1', semester: 'sp26' },
    manifest_sig: 'sig',
    machine_id: 'machine',
    vscode: { version: '1.90.0', commit: '', platform: 'darwin' },
    recorder: { version: '0.0.1', extension_id: 'provenance.recorder' },
    session_pubkey: 'pk',
  });
}

type SubmissionFileInput = {
  path: string;
  status: 'present' | 'missing';
  sha256: string | null;
  hashOk: boolean;
  /**
   * Raw submitted bytes. Omit to model a STORED bundle, whose student source is
   * stripped after ingest — that is the only real-world way `hashOk` is false
   * without tampering. Supply bytes to model an actually-tampered bundle.
   */
  bytes?: Uint8Array;
};

function makeBundle(opts: {
  submissionFiles: SubmissionFileInput[];
  events: HashedEnvelope[];
}): Bundle {
  resetSeq();

  const allEvents: HashedEnvelope[] = [sessionStart(), ...opts.events];

  const fakeMeta: SlogMeta = {
    format_version: '1.0',
    session_id: 's1',
    session_pubkey: 'pk',
    encrypted_session_privkey: {
      algorithm: 'xchacha20-poly1305-hkdf-sha256-v1',
      nonce: 'ab'.repeat(12),
      ciphertext: 'cd'.repeat(48),
      salt: 'ef'.repeat(16),
      info: 'provenance-session-v1',
    },
    checkpoints: [],
  };

  const session: ParsedSession = {
    sessionId: 's1',
    events: allEvents,
    meta: fakeMeta,
    // Check 8 does not read the log-byte digests; they are required by the type
    // and carried through from the loader (see verify-log-bytes.ts).
    slogSha256: 'a'.repeat(64),
    metaSha256: 'b'.repeat(64),
    firstEvent: allEvents[0] as ParsedSession['firstEvent'],
  };

  const submissionFilesMap = new Map<
    string,
    { status: 'present' | 'missing'; sha256: string | null; bytes?: Uint8Array; hashOk: boolean }
  >();
  for (const f of opts.submissionFiles) {
    submissionFilesMap.set(f.path, {
      status: f.status,
      sha256: f.sha256,
      hashOk: f.hashOk,
      ...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
    });
  }

  const manifest: BundleManifest =
    opts.submissionFiles.length > 0
      ? {
          format_version: '1.1',
          assignment_id: 'hw1',
          semester: 'sp26',
          extension_hash: 'a'.repeat(64),
          sessions: [
            {
              session_id: 's1',
              prev_session_id: null,
              slog_sha256: 'x'.repeat(64),
              meta_sha256: 'y'.repeat(64),
            },
          ],
          submission_files: opts.submissionFiles.map((f) => ({
            path: f.path,
            status: f.status,
            sha256: f.sha256,
          })),
        }
      : {
          format_version: '1.0',
          assignment_id: 'hw1',
          semester: 'sp26',
          extension_hash: 'a'.repeat(64),
          sessions: [
            {
              session_id: 's1',
              prev_session_id: null,
              slog_sha256: 'x'.repeat(64),
              meta_sha256: 'y'.repeat(64),
            },
          ],
        };

  return {
    id: 'test-bundle',
    manifest,
    manifestSigHex: 'sig'.padEnd(128, '0'),
    sessions: [session],
    sourceFilename: 'test.zip',
    loadedAt: '2026-01-01T00:00:00.000Z',
    submissionFiles: submissionFilesMap,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/** Bytes that deliberately do not hash to their manifest sha256. */
const TAMPERED_BYTES = new TextEncoder().encode('not the submitted content');

describe('verifySubmittedCode (Check 8)', () => {
  it('passes when submitted hash equals the last recorded on-disk hash', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'H', hashOk: true }],
      events: [docSave('a.py', 'H')],
    });
    const check = verifySubmittedCode(bundle, { chainIntact: true });
    expect(check.status).toBe('pass');
  });

  it('fails when submitted hash differs and the chain is intact', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'X', hashOk: true }],
      events: [docSave('a.py', 'H')],
    });
    const check = verifySubmittedCode(bundle, { chainIntact: true });
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs?.length).toBeGreaterThan(0);
  });

  it('uses fs.external_change new_hash as the latest on-disk hash', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'N', hashOk: true }],
      events: [docSave('a.py', 'H'), fsExternal('a.py', 'H', 'N')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('pass');
  });

  it('uses doc.open sha256 as a recorded on-disk hash', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'O', hashOk: true }],
      events: [docOpen('a.py', 'O')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('pass');
  });

  it('uses the LAST event when multiple events record a hash for the same file', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'FINAL', hashOk: true }],
      events: [docSave('a.py', 'FIRST'), docSave('a.py', 'FINAL')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('pass');
  });

  it('skips when the chain is broken', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'X', hashOk: true }],
      events: [docSave('a.py', 'H')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: false }).status).toBe('skipped');
  });

  it('skips a file with no usable events', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'X', hashOk: true }],
      events: [],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('skipped');
  });

  it('skips a missing file', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'missing', sha256: null, hashOk: true }],
      events: [docSave('a.py', 'H')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('skipped');
  });

  it('fails when present bytes failed the bundle self-check (hashOk false)', () => {
    const bundle = makeBundle({
      submissionFiles: [
        // Real tampering: bytes ARE present, they just don't hash to the manifest.
        { path: 'a.py', status: 'present', sha256: 'H', hashOk: false, bytes: TAMPERED_BYTES },
      ],
      events: [docSave('a.py', 'H')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('fail');
  });

  it('fails on hashOk=false even when the chain is also broken (tamper is unconditional)', () => {
    const bundle = makeBundle({
      submissionFiles: [
        { path: 'a.py', status: 'present', sha256: 'H', hashOk: false, bytes: TAMPERED_BYTES },
      ],
      events: [docSave('a.py', 'H')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: false }).status).toBe('fail');
  });

  // A STORED bundle is provenance-only: source is stripped after ingest, so
  // `bytes` is absent and `hashOk` is trivially false. That must not be read as
  // tampering, or every re-run of check 8 against stored data reports the whole
  // corpus as tampered. See .notes/reconstruction-triage.md.
  it('does NOT report tampering for a stored bundle whose source was stripped', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'H', hashOk: false }],
      events: [docSave('a.py', 'H')],
    });
    // Falls through to the hash comparison, which needs only the signed
    // manifest sha and the recorded event hashes — both survive stripping.
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('pass');
  });

  it('still fails a stripped bundle when the recorded hash genuinely differs', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'X', hashOk: false }],
      events: [docSave('a.py', 'H')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('fail');
  });

  it('is skipped entirely on a 1.0 bundle (no submission files)', () => {
    const bundle = makeBundle({ submissionFiles: [], events: [docSave('a.py', 'H')] });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('skipped');
  });

  it('emits id = submitted_code_match', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'H', hashOk: true }],
      events: [docSave('a.py', 'H')],
    });
    const check = verifySubmittedCode(bundle, { chainIntact: true });
    expect(check.id).toBe('submitted_code_match');
  });
});

// ---------------------------------------------------------------------------
// Concurrency (Tier 2.2 / spec Tier 2.4)
// ---------------------------------------------------------------------------

/**
 * "The last recorded hash" was a WALL-CLOCK claim: `bundle.sessions` is sorted
 * by `firstEvent.wall` and the scan is last-write-wins over that order. With two
 * partners on divergent branches that hands a HIGH-severity "File was changed
 * outside the recording" to whichever student's laptop clock ran slow.
 */
describe('Check 8 — two contributors with concurrent recorded states', () => {
  function contributor(sessionId: string, studentRef: string): SessionContributor {
    return {
      kind: 'attributed',
      sessionId,
      contributorKey: `attributed:2.0:course:c1:${studentRef}`,
      studentRef,
      identityVersion: '2.0',
      scope: 'course',
      scopeId: 'c1',
      studentPubkey: 'pk',
      certWindow: { in_window: true },
      credentialWindow: { in_window: true },
    };
  }

  function twoContributorBundle(opts: {
    submittedSha: string;
    aliceSha: string;
    bobSha: string;
    /** Give Bob's tip Alice's tip as a git parent, making Bob strictly later. */
    bobDescendsFromAlice?: boolean;
    /** Resolve both sessions to the SAME student. */
    sameStudent?: boolean;
  }): Bundle {
    const ALICE_TIP = 'a'.repeat(40);
    const BOB_TIP = 'b'.repeat(40);

    const mk = (
      sessionId: string,
      sha: string,
      commit: string,
      parents: readonly string[],
      wallBase: number,
      /**
       * Observe the commit BEFORE saving. This is what makes the save provably
       * later than everything the commit descends from: a save that precedes its
       * own session's only observation is genuinely unordered against another
       * contributor, because the student could have saved before pulling.
       */
      observeFirst = false,
    ): ParsedSession => {
      const at = (seq: number, kind: string, data: Record<string, unknown>) => ({
        seq,
        t: seq,
        wall: new Date(Date.UTC(2026, 0, 1, wallBase, seq)).toISOString(),
        kind,
        data,
        prev_hash: '0'.repeat(64),
        hash: '1'.repeat(64),
      });
      const save = { path: 'a.py', sha256: sha };
      const git = { operation: 'commit', sha: commit, parents: [...parents] };
      const events = [
        at(0, 'session.start', {
          format_version: '1.0',
          session_id: sessionId,
          prev_session_id: null,
          assignment: { id: 'hw1', semester: 'sp26' },
        }),
        observeFirst ? at(1, 'git.event', git) : at(1, 'doc.save', save),
        observeFirst ? at(2, 'doc.save', save) : at(2, 'git.event', git),
      ] as unknown as HashedEnvelope[];
      return {
        sessionId,
        events,
        meta: {} as ParsedSession['meta'],
        slogSha256: 'c'.repeat(64),
        metaSha256: 'd'.repeat(64),
        firstEvent: events[0] as ParsedSession['firstEvent'],
      };
    };

    // Wall order puts Alice first, so wall-ordered last-write-wins picks BOB.
    const sessions = [
      mk('s-alice', opts.aliceSha, ALICE_TIP, [], 1),
      mk(
        's-bob',
        opts.bobSha,
        BOB_TIP,
        opts.bobDescendsFromAlice === true ? [ALICE_TIP] : [],
        2,
        opts.bobDescendsFromAlice === true,
      ),
    ];

    const bySession = new Map<string, SessionContributor>([
      ['s-alice', contributor('s-alice', 'alice')],
      ['s-bob', contributor('s-bob', opts.sameStudent === true ? 'alice' : 'bob')],
    ]);

    return {
      id: 'bundle-1',
      manifest: { format_version: '1.1' } as BundleManifest,
      manifestSigHex: null,
      sessions,
      sourceFilename: 'b.zip',
      loadedAt: '2026-01-01T00:00:00.000Z',
      submissionFiles: new Map([
        ['a.py', { status: 'present' as const, sha256: opts.submittedSha, hashOk: true }],
      ]),
      contributors: {
        bySession,
        contributors: [],
        rootKeyConfigured: true,
        counts: { attributed: 2, unverifiable: 0, unattributed: 0 },
      },
    };
  }

  /**
   * The false accusation this removes. Wall order says Bob's save is "last", so
   * the old rule reported Alice's genuinely-submitted file as changed outside
   * the recording.
   */
  it('matching ANY concurrent recorded state passes', () => {
    const bundle = twoContributorBundle({
      submittedSha: 'ALICE_SHA',
      aliceSha: 'ALICE_SHA',
      bobSha: 'BOB_SHA',
    });
    const check = verifySubmittedCode(bundle, { chainIntact: true });
    expect(check.status).toBe('pass');
    expect(check.detail).toContain('match');
  });

  it('matching the wall-clock-last state also passes', () => {
    const bundle = twoContributorBundle({
      submittedSha: 'BOB_SHA',
      aliceSha: 'ALICE_SHA',
      bobSha: 'BOB_SHA',
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('pass');
  });

  /**
   * THE CONSERVATIVE CHOICE. Matching neither branch is exactly what a merge
   * result no session observed on disk looks like — normal group work. Asserting
   * "changed outside the recording" there is a fabricated high-severity finding.
   */
  it('matching NEITHER branch is skipped, never failed', () => {
    const bundle = twoContributorBundle({
      submittedSha: 'MERGED_SHA',
      aliceSha: 'ALICE_SHA',
      bobSha: 'BOB_SHA',
    });
    const check = verifySubmittedCode(bundle, { chainIntact: true });
    expect(check.status).toBe('skipped');
    expect(check.status).not.toBe('fail');
    expect(verifySubmittedCode(bundle, { chainIntact: true }).detail).toContain('merge');
  });

  /**
   * The gate. `≺` DOES order these two, so there is a single established last
   * recorded state and the ordinary comparison applies — including a real
   * mismatch. Concurrency handling must not become a blanket amnesty.
   */
  it('a DAG-ordered pair still reports a real mismatch', () => {
    const bundle = twoContributorBundle({
      submittedSha: 'SOMETHING_ELSE',
      aliceSha: 'ALICE_SHA',
      bobSha: 'BOB_SHA',
      bobDescendsFromAlice: true,
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('fail');
  });

  /**
   * The solo guarantee for check 8: two sessions of ONE student are not a
   * cross-contributor divergence, so the unchanged wall-ordered rule applies and
   * a genuine mismatch is still reported.
   */
  it('two sessions of one student still report a mismatch', () => {
    const bundle = twoContributorBundle({
      submittedSha: 'SOMETHING_ELSE',
      aliceSha: 'ALICE_SHA',
      bobSha: 'BOB_SHA',
      sameStudent: true,
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('fail');
  });

  it('an unstamped bundle keeps the unchanged wall-ordered rule', () => {
    const bundle = twoContributorBundle({
      submittedSha: 'SOMETHING_ELSE',
      aliceSha: 'ALICE_SHA',
      bobSha: 'BOB_SHA',
    });
    delete bundle.contributors;
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('fail');
  });
});
