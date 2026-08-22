/**
 * Tests for the read-only slog ownership table.
 *
 * `classifySlogOwnership` / `isEligible` are the whole of the ownership decision;
 * `selectEligible` is the only place that combines it with wall ordering. The
 * quarantine side of recovery lives in `chain-recovery.test.ts`, because this
 * module never renames anything.
 */

import { describe, it, expect } from 'vitest';
import { chainEntry, GENESIS_PREV_HASH, serializeEntry, sha256Hex } from '@provenance/log-core';
import type { Envelope, SessionIdentity } from '@provenance/log-core';
import { classifySlogOwnership, isEligible, selectEligible } from './slog-ownership.js';
import type { ReadSlogFile } from './slog-ownership.js';

/** Opaque roster refs — never a SID, name, or email (program spec §5a). */
const ALICE_REF = 'aaaaaaaa-0000-4000-8000-000000000001';
const BOB_REF = 'bbbbbbbb-0000-4000-8000-000000000002';

/**
 * A syntactically complete `SessionIdentity`. The signatures are placeholders:
 * ownership reads exactly one field off the first line — `student_ref` — and
 * deliberately does no crypto.
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

/** One real chained `session.start` line — the only line this module reads. */
function startOnlySlog(sessionId: string, wall: string, studentRef?: string): string {
  const env: Envelope<'session.start'> = {
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
  return serializeEntry(chainEntry(GENESIS_PREV_HASH, env, sha256Hex));
}

/**
 * A `.slog` whose first line is a perfectly readable `session.start` naming its
 * author, but whose `wall` is not a parseable timestamp.
 *
 * The realistic shape of one flipped byte in a committed log, and also the
 * cheapest thing an attacker can do to a partner's file: `wall` is a plain
 * string in the clear, and damaging it costs nothing.
 */
function wallDamagedSlog(sessionId: string, studentRef: string): string {
  return startOnlySlog(sessionId, '2026-01-01T09:00:00.000Z', studentRef).replace(
    /"wall":"[^"]*"/,
    '"wall":"2026-13-45T99:99:99.999Z"',
  );
}

/** In-memory `readSlogFile`. No filesystem, no rename — this module cannot write. */
function makeReader(files: Record<string, string>): ReadSlogFile {
  return async (filePath) => {
    const filename = filePath.split('/').pop() ?? filePath;
    const content = files[filename];
    if (content === undefined) return { ok: false, reason: 'not_found' };
    return { ok: true, text: content };
  };
}

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

describe('isEligible', () => {
  it('always admits our own session', () => {
    expect(isEligible('own', ALICE_REF)).toBe(true);
  });

  it('never admits a foreign session, enrolled or not', () => {
    expect(isEligible('foreign', ALICE_REF)).toBe(false);
    expect(isEligible('foreign', null)).toBe(false);
  });

  it('admits an unattributed session only to an unattributed recorder', () => {
    expect(isEligible('unattributed', null)).toBe(true);
    expect(isEligible('unattributed', ALICE_REF)).toBe(false);
  });
});

describe('selectEligible', () => {
  it('picks the latest session.start wall, not the alphabetically last filename', async () => {
    // Filenames are UUIDv4-derived and carry no ordering information, so
    // alphabetical order must lose to the recorded wall.
    const files = {
      'session-aaa.slog': startOnlySlog('recent-session-id', '2026-01-01T05:00:00.000Z'),
      'session-zzz.slog': startOnlySlog('older-session-id', '2026-01-01T00:00:00.000Z'),
    };

    const picked = await selectEligible(
      Object.keys(files).sort(),
      '/fake/.provenance',
      makeReader(files),
      null,
    );

    expect(picked.best?.filename).toBe('session-aaa.slog');
    expect(picked.best?.text).toBe(files['session-aaa.slog']);
  });

  it("never selects a partner's newer session", async () => {
    const files = {
      'session-alice.slog': startOnlySlog('alice-1', '2026-01-01T01:00:00.000Z', ALICE_REF),
      'session-bob.slog': startOnlySlog('bob-1', '2026-01-01T09:00:00.000Z', BOB_REF),
    };

    const picked = await selectEligible(
      Object.keys(files).sort(),
      '/fake/.provenance',
      makeReader(files),
      ALICE_REF,
    );

    expect(picked.best?.filename).toBe('session-alice.slog');
    // Nothing foreign may reach the caller's quarantine path either.
    expect(picked.eligibleFallback).toBe('session-alice.slog');
  });

  it('offers the alphabetically last ELIGIBLE filename as the fallback', async () => {
    // An unenrolled recorder: no eligible file has a parseable session.start, so
    // the caller's corrupt path still needs a name it is entitled to touch — and
    // it must not be the enrolled partner's, which sorts last.
    const files = {
      'session-mine-a.slog': 'NOT VALID JSON\n',
      'session-mine-b.slog': 'ALSO NOT VALID\n',
      'session-zbob.slog': startOnlySlog('bob-1', '2026-01-01T09:00:00.000Z', BOB_REF),
    };

    const picked = await selectEligible(
      Object.keys(files).sort(),
      '/fake/.provenance',
      makeReader(files),
      null,
    );

    expect(picked.best).toBeNull();
    expect(picked.eligibleFallback).toBe('session-mine-b.slog');
  });

  it('offers nothing at all when the whole directory is foreign', async () => {
    const files = {
      'session-bob.slog': startOnlySlog('bob-1', '2026-01-01T09:00:00.000Z', BOB_REF),
    };

    const picked = await selectEligible(
      Object.keys(files).sort(),
      '/fake/.provenance',
      makeReader(files),
      ALICE_REF,
    );

    expect(picked.best).toBeNull();
    expect(picked.eligibleFallback).toBeNull();
  });

  it('still reads ownership off a session.start whose wall is unparseable', async () => {
    // Ownership is `student_ref` and ONLY `student_ref`. A damaged `wall` costs
    // a file its place in the ordering; it must never cost it its author.
    // Before this was true, one flipped byte in a partner's timestamp demoted
    // their log to `unattributed`, which an UNENROLLED recorder may select and
    // quarantine — so damaging a stranger's `wall` made someone else's tooling
    // delete their evidence for you.
    const files = {
      'session-bob.slog': wallDamagedSlog('bob-1', BOB_REF),
    };

    const picked = await selectEligible(
      Object.keys(files).sort(),
      '/fake/.provenance',
      makeReader(files),
      null,
    );

    expect(picked.best).toBeNull();
    expect(picked.eligibleFallback).toBeNull();
  });

  it('an unparseable wall on OUR own log still leaves it quarantinable', async () => {
    // The other half of the same rule: reading ownership independently of the
    // wall also means an enrolled recorder can still act on its OWN damaged log,
    // which the all-or-nothing parse denied it.
    const files = {
      'session-mine.slog': wallDamagedSlog('mine-1', ALICE_REF),
    };

    const picked = await selectEligible(
      Object.keys(files).sort(),
      '/fake/.provenance',
      makeReader(files),
      ALICE_REF,
    );

    expect(picked.best).toBeNull();
    expect(picked.eligibleFallback).toBe('session-mine.slog');
  });

  it('breaks a wall tie on filename, descending', async () => {
    const wall = '2026-01-01T05:00:00.000Z';
    const files = {
      'session-aaa.slog': startOnlySlog('tie-a', wall),
      'session-bbb.slog': startOnlySlog('tie-b', wall),
    };

    const picked = await selectEligible(
      Object.keys(files).sort(),
      '/fake/.provenance',
      makeReader(files),
      null,
    );

    expect(picked.best?.filename).toBe('session-bbb.slog');
  });
});
