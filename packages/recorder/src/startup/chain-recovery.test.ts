/**
 * Tests for recoverPreviousSession.
 *
 * Branch table:
 * 1. Empty directory → clean_start.
 * 2. Valid chain + session.end (complete) → previous_session_complete.
 * 3. Valid chain + no session.end (dangling) → previous_session_dangling.
 * 4. Parse error (bad JSON) → quarantined + previous_session_corrupt.
 * 5. Chain validation failure → quarantined + previous_session_corrupt.
 * 6. Read error (e.g., permission denied) → quarantined + previous_session_corrupt.
 * 7. Multiple .slog files → the one with the latest session.start wall wins,
 *    regardless of filename order (filenames are UUIDv4 and carry no ordering).
 */

import { describe, it, expect } from 'vitest';
import { chainEntry, GENESIS_PREV_HASH, serializeEntry, sha256Hex } from '@provenance/log-core';
import type { Envelope, SessionIdentity } from '@provenance/log-core';
import { classifySlogOwnership, recoverPreviousSession } from './chain-recovery.js';
import type { RecoveryDeps } from './chain-recovery.js';

// ---------------------------------------------------------------------------
// Helpers to build valid .slog content
// ---------------------------------------------------------------------------

const FAKE_SESSION_ID = '00000000-0000-0000-0000-000000000001';

/** Opaque roster refs — never a SID, name, or email (program spec §5a). */
const ALICE_REF = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB_REF = 'bbbbbbbb-0000-4000-8000-000000000002';

/**
 * A syntactically complete `SessionIdentity`. The signatures are placeholders:
 * chain recovery reads exactly one field off the first line — `student_ref` —
 * and deliberately does no crypto (it runs on the startup path and must not
 * block recording). Any test that cares about verification belongs in
 * `identity/`, not here.
 */
function makeIdentity(studentRef: string): SessionIdentity {
  return {
    enrollment: {
      format_version: '2.0',
      student_ref: studentRef,
      course_id: 'cs61b-fa26',
      student_pubkey: 'c'.repeat(64),
      issued_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-12-31T23:59:59.000Z',
      enrollment_sig: 'd'.repeat(128),
    },
    enrollment_cert: {
      format_version: '2.0',
      course_id: 'cs61b-fa26',
      enrollment_pubkey: 'e'.repeat(64),
      valid_from: '2026-01-01',
      valid_until: '2026-12-31',
      course_sig: 'f'.repeat(128),
    },
    session_pubkey_sig: '0'.repeat(128),
  };
}

function makeStartEnvelope(
  sessionId: string = FAKE_SESSION_ID,
  wall = '2026-01-01T00:00:00.000Z',
  studentRef?: string,
): Envelope<'session.start'> {
  return {
    seq: 0,
    t: 0,
    wall,
    kind: 'session.start',
    data: {
      format_version: '1.0',
      session_id: sessionId,
      prev_session_id: null,
      assignment: { id: 'hw03', semester: 'fa26' },
      manifest_sig: 'a'.repeat(128),
      machine_id: 'b'.repeat(64),
      vscode: { version: '1.97.0', commit: '', platform: 'darwin-arm64' },
      recorder: { version: '0.0.0', extension_id: 'test.recorder' },
      session_pubkey: '',
      ...(studentRef !== undefined ? { identity: makeIdentity(studentRef) } : {}),
    },
  };
}

/**
 * `wall` is derived from the session's start so the chain stays non-decreasing:
 * `validateChain` rejects a wall regression outright, and a hard-coded end wall
 * silently made any session that started later than it an INVALID chain rather
 * than a complete one.
 */
function makeEndEnvelope(
  seq: number,
  startWall = '2026-01-01T00:00:00.000Z',
): Envelope<'session.end'> {
  return {
    seq,
    t: 100,
    wall: new Date(Date.parse(startWall) + 1000).toISOString(),
    kind: 'session.end',
    data: { reason: 'deactivate' },
  };
}

function buildCompleteSlog(
  sessionId: string = FAKE_SESSION_ID,
  startWall?: string,
  studentRef?: string,
): string {
  const startEnv = makeStartEnvelope(sessionId, startWall, studentRef);
  const startEntry = chainEntry(GENESIS_PREV_HASH, startEnv, sha256Hex);

  const endEnv = makeEndEnvelope(1, startWall);
  const endEntry = chainEntry(startEntry.hash, endEnv, sha256Hex);

  return serializeEntry(startEntry) + serializeEntry(endEntry);
}

function buildDanglingSlog(
  sessionId: string = FAKE_SESSION_ID,
  startWall?: string,
  studentRef?: string,
): string {
  const startEnv = makeStartEnvelope(sessionId, startWall, studentRef);
  const startEntry = chainEntry(GENESIS_PREV_HASH, startEnv, sha256Hex);
  return serializeEntry(startEntry);
}

/**
 * A `.slog` whose `session.start` is intact and attributable but whose chain is
 * broken further in — the realistic shape of a log damaged by a merge-conflict
 * resolution, a checkout that caught a partial write, or one flipped byte.
 *
 * This shape is what makes the ownership defect reachable: the file is readable
 * enough to say WHOSE it is, and invalid enough to trigger the quarantine.
 */
function buildCorruptSlog(sessionId: string, startWall: string, studentRef?: string): string {
  const startEnv = makeStartEnvelope(sessionId, startWall, studentRef);
  const startEntry = chainEntry(GENESIS_PREV_HASH, startEnv, sha256Hex);
  const endEntry = chainEntry(startEntry.hash, makeEndEnvelope(1, startWall), sha256Hex);
  // Break the SECOND entry's prev_hash so the first line still parses cleanly.
  const tamperedEnd = serializeEntry(endEntry).replace(/"prev_hash":"[0-9a-f]/, '"prev_hash":"0');
  return serializeEntry(startEntry) + tamperedEnd;
}

// ---------------------------------------------------------------------------
// Build deps
// ---------------------------------------------------------------------------

function makeDeps(files: Record<string, string>, opts: Partial<RecoveryDeps> = {}): RecoveryDeps {
  const fixedNow = new Date('2026-01-02T00:00:00.000Z');
  const renamedFiles: Array<{ from: string; to: string }> = [];

  return {
    provenanceDir: '/fake/.provenance',
    listSlogFiles: async (dir) => {
      void dir;
      return Object.keys(files).filter((f) => f.endsWith('.slog'));
    },
    readSlogFile: async (filePath) => {
      const filename = filePath.split('/').pop() ?? filePath;
      const content = files[filename];
      if (content === undefined) {
        return { ok: false, reason: 'not_found' };
      }
      return { ok: true, text: content };
    },
    rename: async (from, to) => {
      renamedFiles.push({ from, to });
      // Remove the file from the in-memory map so it looks moved.
      const filename = from.split('/').pop() ?? from;
      delete files[filename];
    },
    now: () => fixedNow,
    ...opts,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('recoverPreviousSession', () => {
  it('returns clean_start when no .slog files exist', async () => {
    const deps = makeDeps({});
    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('clean_start');
  });

  it('returns previous_session_complete for a valid chain ending with session.end', async () => {
    const slogContent = buildCompleteSlog();
    const deps = makeDeps({ 'session-abc.slog': slogContent });
    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_complete');
    if (result.kind !== 'previous_session_complete') return;
    expect(result.prevSessionId).toBe(FAKE_SESSION_ID);
  });

  it('returns previous_session_dangling for a valid chain with no session.end', async () => {
    const slogContent = buildDanglingSlog();
    const deps = makeDeps({ 'session-abc.slog': slogContent });
    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_dangling');
    if (result.kind !== 'previous_session_dangling') return;
    expect(result.prevSessionId).toBe(FAKE_SESSION_ID);
    expect(result.danglingPath).toContain('session-abc.slog');
  });

  it('returns previous_session_corrupt and quarantines file on invalid JSON', async () => {
    const deps = makeDeps({ 'session-bad.slog': 'NOT VALID JSON\n' });

    let renamedFrom = '';
    let renamedTo = '';
    const origRename = deps.rename;
    deps.rename = async (from, to) => {
      renamedFrom = from;
      renamedTo = to;
      await origRename(from, to);
    };

    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_corrupt');
    if (result.kind !== 'previous_session_corrupt') return;
    expect(result.quarantinedPath).toContain('.corrupt-');
    expect(renamedFrom).toContain('session-bad.slog');
    expect(renamedTo).toContain('.corrupt-');
  });

  it('returns previous_session_corrupt and quarantines file on broken chain', async () => {
    // Build a dangling slog then corrupt its content.
    const valid = buildDanglingSlog();
    const lines = valid.split('\n').filter((l) => l.length > 0);
    // Tamper with the first line by changing a hash byte.
    const tampered = lines[0]!.replace(/"hash":"[0-9a-f]/, '"hash":"z') + '\n';

    const deps = makeDeps({ 'session-tampered.slog': tampered });
    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_corrupt');
  });

  it('returns previous_session_corrupt and quarantines file on read error', async () => {
    const deps = makeDeps({ 'session-err.slog': '' });
    // Override readSlogFile to return a read_error.
    deps.readSlogFile = async () => ({ ok: false, reason: 'read_error' });

    let renamedCalled = false;
    deps.rename = async () => {
      renamedCalled = true;
    };

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_corrupt');
    expect(renamedCalled).toBe(true);
  });

  it('picks the .slog with the latest session.start wall, not the alphabetically last', async () => {
    // session-aaa started later than session-zzz. Filenames are UUIDv4-derived
    // and carry no ordering information, so alphabetical order must lose.
    const slogRecent = buildDanglingSlog('recent-session-id', '2026-01-01T05:00:00.000Z');
    const slogOlder = buildCompleteSlog('older-session-id', '2026-01-01T00:00:00.000Z');

    const deps = makeDeps({
      'session-aaa.slog': slogRecent,
      'session-zzz.slog': slogOlder, // alphabetically last, but older
    });

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_dangling');
    if (result.kind !== 'previous_session_dangling') return;
    expect(result.prevSessionId).toBe('recent-session-id');
    expect(result.danglingPath).toContain('session-aaa.slog');
  });

  it('picks the most recent session across more than two .slog files', async () => {
    // Regression for the observed real-world failure: several sessions in one
    // provenanceDir all reported the same prev_session_id because one filename
    // kept sorting last. The middle session here is the newest.
    const deps = makeDeps({
      'session-ddd.slog': buildCompleteSlog('oldest', '2026-01-01T00:00:00.000Z'),
      'session-bbb.slog': buildDanglingSlog('newest', '2026-01-01T09:00:00.000Z'),
      'session-ccc.slog': buildCompleteSlog('middle', '2026-01-01T04:00:00.000Z'),
    });

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_dangling');
    if (result.kind !== 'previous_session_dangling') return;
    expect(result.prevSessionId).toBe('newest');
  });

  it('falls back to the alphabetically last .slog when none has a parseable session.start', async () => {
    // Both unusable → the fallback still runs the quarantine path.
    const deps = makeDeps({
      'session-aaa.slog': 'NOT VALID JSON\n',
      'session-zzz.slog': 'ALSO NOT VALID\n',
    });

    let renamedFrom = '';
    deps.rename = async (from) => {
      renamedFrom = from;
    };

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_corrupt');
    expect(renamedFrom).toContain('session-zzz.slog');
  });

  it('ignores an unreadable .slog when a readable, older one exists', async () => {
    const deps = makeDeps({
      'session-aaa.slog': buildCompleteSlog('readable', '2026-01-01T00:00:00.000Z'),
      'session-zzz.slog': 'NOT VALID JSON\n',
    });

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_complete');
    if (result.kind !== 'previous_session_complete') return;
    expect(result.prevSessionId).toBe('readable');
  });

  it('quarantine path includes ISO timestamp', async () => {
    const deps = makeDeps({ 'session-bad.slog': 'bad json\n' });

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('previous_session_corrupt');
    if (result.kind !== 'previous_session_corrupt') return;
    // ISO timestamp in quarantine filename (colons/dots replaced with dashes)
    expect(result.quarantinedPath).toContain('2026-01-02');
  });
});

// ---------------------------------------------------------------------------
// Shared repository: two contributors, ONE committed .provenance/
//
// CS 61B/61C partners share a git repo, so both recorders write into the same
// committed `.provenance/`. Every test below puts Alice's and Bob's sessions in
// one directory and asserts that Alice's recorder confines itself to Alice's
// files (git-collaboration spec §3 S9/S19/S22, worklist Tier 0.1 + 0.2).
// ---------------------------------------------------------------------------

describe('recoverPreviousSession — shared .provenance/ with two contributors', () => {
  it("leaves a partner's corrupt .slog untouched instead of quarantining it", async () => {
    // Bob's log is the most recent AND it is corrupt: exactly the selection the
    // old code made, and exactly the file it renamed to `.corrupt-<ISO>`.
    // `sealBundle` excludes `.corrupt-` files, so that rename removed Bob's
    // evidence from the submission — with Alice's commit as the paper trail.
    const files = {
      'session-alice.slog': buildCompleteSlog(
        'alice-session-1',
        '2026-01-01T01:00:00.000Z',
        ALICE_REF,
      ),
      'session-bob.slog': buildCorruptSlog('bob-session-1', '2026-01-01T09:00:00.000Z', BOB_REF),
    };
    const renames: Array<{ from: string; to: string }> = [];
    const deps = makeDeps(files, {
      ownStudentRef: ALICE_REF,
      rename: async (from, to) => {
        renames.push({ from, to });
      },
    });

    const result = await recoverPreviousSession(deps);

    // Nothing of Bob's was renamed, moved, or deleted.
    expect(renames).toEqual([]);
    expect(Object.keys(files).sort()).toEqual(['session-alice.slog', 'session-bob.slog']);
    // And Bob's session was never adopted as Alice's predecessor.
    expect(result.kind).toBe('previous_session_complete');
    if (result.kind !== 'previous_session_complete') return;
    expect(result.prevSessionId).toBe('alice-session-1');
  });

  it("does not quarantine a partner's .slog even when it is the only file present", async () => {
    // The dangerous shape on a fresh clone: Alice pulls, opens the folder, and
    // the only log in the tree is Bob's — damaged in transit.
    const files = {
      'session-bob.slog': buildCorruptSlog('bob-session-1', '2026-01-01T09:00:00.000Z', BOB_REF),
    };
    let renameCalled = false;
    const deps = makeDeps(files, {
      ownStudentRef: ALICE_REF,
      rename: async () => {
        renameCalled = true;
      },
    });

    const result = await recoverPreviousSession(deps);

    expect(renameCalled).toBe(false);
    expect(files['session-bob.slog']).toBeDefined();
    // Nothing of ours here — start clean rather than claim a stranger's session.
    expect(result.kind).toBe('clean_start');
  });

  it("skips a partner's newer dangling session and links to the contributor's own", async () => {
    // Bob's editor is open right now, so his log has no `session.end` and the
    // latest `session.start.wall` in the directory is his. The old code linked
    // `prev_session_id` to it, asserting continuity with a stranger and making
    // program spec §7 mechanism 1 report a relationship that does not exist.
    const deps = makeDeps(
      {
        'session-alice-old.slog': buildCompleteSlog(
          'alice-session-1',
          '2026-01-01T01:00:00.000Z',
          ALICE_REF,
        ),
        'session-alice-crashed.slog': buildDanglingSlog(
          'alice-session-2',
          '2026-01-01T05:00:00.000Z',
          ALICE_REF,
        ),
        'session-bob.slog': buildDanglingSlog('bob-session-1', '2026-01-01T09:00:00.000Z', BOB_REF),
      },
      { ownStudentRef: ALICE_REF },
    );

    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_dangling');
    if (result.kind !== 'previous_session_dangling') return;
    expect(result.prevSessionId).toBe('alice-session-2');
    expect(result.danglingPath).toContain('session-alice-crashed.slog');
  });

  it("never links to a partner's session even when we have none of our own", async () => {
    const deps = makeDeps(
      {
        'session-bob.slog': buildDanglingSlog('bob-session-1', '2026-01-01T09:00:00.000Z', BOB_REF),
      },
      { ownStudentRef: ALICE_REF },
    );

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('clean_start');
  });

  it("does not touch a partner's file it cannot even read", async () => {
    // An unreadable file cannot say whose it is, so it is unattributable — and an
    // attributed recorder never renames what it cannot prove is its own.
    const deps = makeDeps(
      { 'session-bob.slog': buildDanglingSlog('bob-session-1', undefined, BOB_REF) },
      { ownStudentRef: ALICE_REF, readSlogFile: async () => ({ ok: false, reason: 'read_error' }) },
    );

    let renameCalled = false;
    deps.rename = async () => {
      renameCalled = true;
    };

    const result = await recoverPreviousSession(deps);
    expect(renameCalled).toBe(false);
    expect(result.kind).toBe('clean_start');
  });

  it("does not adopt an unattributed session as the enrolled contributor's own", async () => {
    // Could be Alice's own pre-enrollment log; could be an unenrolled partner's.
    // Unprovable either way, so it costs a back-pointer rather than a file.
    const deps = makeDeps(
      { 'session-mystery.slog': buildDanglingSlog('mystery-session', '2026-01-01T09:00:00.000Z') },
      { ownStudentRef: ALICE_REF },
    );

    const result = await recoverPreviousSession(deps);
    expect(result.kind).toBe('clean_start');
  });

  it("an unenrolled recorder still ignores an enrolled partner's log", async () => {
    // Alice has not enrolled, so she can prove nothing about anyone — but Bob's
    // log NAMES a contributor she cannot claim to be, which is enough to keep her
    // hands off it. This is the case that protects an enrolled student from an
    // unenrolled partner's recorder.
    const files = {
      'session-bob.slog': buildCorruptSlog('bob-session-1', '2026-01-01T09:00:00.000Z', BOB_REF),
      'session-mine.slog': buildDanglingSlog('my-session-1', '2026-01-01T01:00:00.000Z'),
    };
    const renames: Array<{ from: string; to: string }> = [];
    const deps = makeDeps(files, {
      rename: async (from, to) => {
        renames.push({ from, to });
      },
    });

    const result = await recoverPreviousSession(deps);

    expect(renames).toEqual([]);
    expect(result.kind).toBe('previous_session_dangling');
    if (result.kind !== 'previous_session_dangling') return;
    expect(result.prevSessionId).toBe('my-session-1');
  });

  it('still recovers normally when every session in the directory is ours', async () => {
    // The enrolled solo case must be completely unaffected by the ownership gate.
    const files = {
      'session-1.slog': buildCompleteSlog('mine-1', '2026-01-01T01:00:00.000Z', ALICE_REF),
      'session-2.slog': buildCorruptSlog('mine-2', '2026-01-01T09:00:00.000Z', ALICE_REF),
    };
    const renames: Array<{ from: string; to: string }> = [];
    const deps = makeDeps(files, {
      ownStudentRef: ALICE_REF,
      rename: async (from, to) => {
        renames.push({ from, to });
      },
    });

    const result = await recoverPreviousSession(deps);

    expect(result.kind).toBe('previous_session_corrupt');
    expect(renames).toHaveLength(1);
    expect(renames[0]?.from).toContain('session-2.slog');
  });
});

describe('classifySlogOwnership', () => {
  it('is own only when both refs are present and equal', () => {
    expect(classifySlogOwnership(ALICE_REF, ALICE_REF)).toBe('own');
  });

  it('is foreign when the refs differ', () => {
    expect(classifySlogOwnership(ALICE_REF, BOB_REF)).toBe('foreign');
  });

  it('is foreign when we have no ref and the candidate names one', () => {
    // Asymmetric on purpose: losing a back-pointer costs a link, adopting a
    // partner's log costs their evidence.
    expect(classifySlogOwnership(null, BOB_REF)).toBe('foreign');
  });

  it('is unattributed when the candidate names nobody, whoever we are', () => {
    expect(classifySlogOwnership(ALICE_REF, null)).toBe('unattributed');
    expect(classifySlogOwnership(null, null)).toBe('unattributed');
  });
});
