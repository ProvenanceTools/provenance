/**
 * Tests for Check 7 — Doc save hash consistency.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { sha256Hex } from '@provenance/log-core';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import type { EventSpec } from '../test-support/build-test-bundle.js';
import { verifyDocSaveHashes } from './verify-doc-save-hashes.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

describe('verifyDocSaveHashes', () => {
  it('returns pass for a bundle with no doc.save events (nothing to check)', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 5 }] });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.id).toBe('doc_save_hashes');
    expect(check.status).toBe('pass');
  });

  it('returns pass when a doc.save hash matches the in-memory reconstruction', async () => {
    // Build a bundle with appendDocSave: the helper computes the correct sha256.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3, appendDocSave: true }],
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.status).toBe('pass');
  });

  it('returns fail when a doc.save hash is tampered with', async () => {
    // Build a bundle with a doc.save event, then corrupt that save's sha256.
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3, appendDocSave: true }],
      tamper: {
        mismatchDocSaveHash: {
          sessionIndex: 0,
          saveEntryIndex: 0,
          newHash: 'f'.repeat(64), // wrong sha256
        },
      },
    });
    const result = await loadBundle(blob, 'test.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/sha256.*does not match/i);
    expect(check.supportingSeqs).toBeDefined();
    expect(check.supportingSeqs!.length).toBeGreaterThan(0);
  });

  it('returns pass (indeterminate) when a doc.open event makes content unknown', async () => {
    // The verifyDocSaveHashes function marks files as indeterminate when
    // doc.open is seen (we have sha256 but not content). We build a bundle
    // with a doc.open event followed by a doc.save without any doc.change
    // events. The save can't be reconstructed from scratch so it's indeterminate.
    //
    // We test this by directly exercising the function with a hand-built bundle.
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
    const baseResult = await loadBundle(blob, 'test.zip');
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;

    // Inject a doc.open + doc.save into the session events manually.
    const baseSession = baseResult.value.sessions[0]!;
    const extraEvents = [
      ...baseSession.events,
      // doc.open at seq 1 — marks file as having unknown content
      {
        seq: 1,
        t: 1000,
        wall: '2026-01-01T00:00:10.000Z',
        kind: 'doc.open' as const,
        data: { path: 'hw.py', sha256: 'a'.repeat(64), line_count: 10 },
        prev_hash: baseSession.events[baseSession.events.length - 1]?.hash ?? '',
        hash: 'placeholder',
      },
      // doc.save at seq 2 — cannot be verified (started with unknown content)
      {
        seq: 2,
        t: 2000,
        wall: '2026-01-01T00:00:20.000Z',
        kind: 'doc.save' as const,
        data: { path: 'hw.py', sha256: 'b'.repeat(64) },
        prev_hash: 'placeholder',
        hash: 'placeholder2',
      },
    ] as typeof baseSession.events;

    const bundle = {
      ...baseResult.value,
      sessions: [{ ...baseSession, events: extraEvents }],
    };

    const check = verifyDocSaveHashes(bundle);
    // Should be pass (indeterminate) with a detail explaining why.
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/reconstruction not possible|indeterminate|unknown content/i);
  });

  it('sha256Hex("") matches a freshly opened empty file save', () => {
    // Sanity-check: the content model starts empty; a save immediately after
    // session.start (no doc.change) should hash to sha256("").
    const emptyHash = sha256Hex('');
    expect(emptyHash).toHaveLength(64);
    expect(emptyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('seeds content from doc.open.content and verifies an unmodified save (recorder v1.1+)', async () => {
    // Recorder v1.1+ inlines initial content in doc.open. When present, the
    // check must seed reconstruction from it — otherwise every bundle's
    // first save lands in the "indeterminate" branch even when there is
    // enough information to verify the hash.
    const initialContent = 'def square(x):\n    return x * x\n';
    const expectedHash = sha256Hex(initialContent);

    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
    const baseResult = await loadBundle(blob, 'test.zip');
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;

    const baseSession = baseResult.value.sessions[0]!;
    const extraEvents = [
      ...baseSession.events,
      {
        seq: 1,
        t: 1000,
        wall: '2026-01-01T00:00:10.000Z',
        kind: 'doc.open' as const,
        data: {
          path: 'hw.py',
          sha256: expectedHash,
          line_count: 2,
          content: initialContent,
        },
        prev_hash: baseSession.events[baseSession.events.length - 1]?.hash ?? '',
        hash: 'placeholder',
      },
      // Save with the same content the file was opened with → must verify.
      {
        seq: 2,
        t: 2000,
        wall: '2026-01-01T00:00:20.000Z',
        kind: 'doc.save' as const,
        data: { path: 'hw.py', sha256: expectedHash },
        prev_hash: 'placeholder',
        hash: 'placeholder2',
      },
    ] as typeof baseSession.events;

    const bundle = {
      ...baseResult.value,
      sessions: [{ ...baseSession, events: extraEvents }],
    };

    const check = verifyDocSaveHashes(bundle);
    // Pass with no indeterminate banner — the save was reconstructable.
    expect(check.status).toBe('pass');
    expect(check.detail).toBeUndefined();
  });

  it('seeds content from doc.open.content and applies a doc.change before save', async () => {
    // End-to-end: open with initial content, type one delta, save the
    // resulting content. The check should hash the reconstruction and find
    // it matches the recorded save hash — no indeterminate, no failure.
    const initialContent = 'def square(x):\n    return x * x\n';
    const appended = '\ndef cube(x):\n    return x * x * x\n';
    const finalContent = initialContent + appended;

    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
    const baseResult = await loadBundle(blob, 'test.zip');
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;

    const baseSession = baseResult.value.sessions[0]!;
    const initialLineCount = initialContent.split('\n').length - 1;
    const lastLineChars = initialContent.split('\n').at(-1)!.length;

    const extraEvents = [
      ...baseSession.events,
      {
        seq: 1,
        t: 1000,
        wall: '2026-01-01T00:00:10.000Z',
        kind: 'doc.open' as const,
        data: {
          path: 'hw.py',
          sha256: sha256Hex(initialContent),
          line_count: initialContent.split('\n').length,
          content: initialContent,
        },
        prev_hash: baseSession.events[baseSession.events.length - 1]?.hash ?? '',
        hash: 'p1',
      },
      {
        seq: 2,
        t: 2000,
        wall: '2026-01-01T00:00:20.000Z',
        kind: 'doc.change' as const,
        data: {
          path: 'hw.py',
          deltas: [
            {
              range: {
                start: { line: initialLineCount, character: lastLineChars },
                end: { line: initialLineCount, character: lastLineChars },
              },
              text: appended,
            },
          ],
          source: 'typed',
        },
        prev_hash: 'p1',
        hash: 'p2',
      },
      {
        seq: 3,
        t: 3000,
        wall: '2026-01-01T00:00:30.000Z',
        kind: 'doc.save' as const,
        data: { path: 'hw.py', sha256: sha256Hex(finalContent) },
        prev_hash: 'p2',
        hash: 'p3',
      },
    ] as typeof baseSession.events;

    const bundle = {
      ...baseResult.value,
      sessions: [{ ...baseSession, events: extraEvents }],
    };

    const check = verifyDocSaveHashes(bundle);
    expect(check.status).toBe('pass');
    expect(check.detail).toBeUndefined();
  });

  it('still indeterminate when doc.open omits content (pre-v1.1 fallback)', async () => {
    // Backward-compat regression: pre-v1.1 doc.open payloads have no
    // `content` field. The check must keep treating those as indeterminate
    // (we have nothing to seed from). This complements the test above and
    // mirrors the older "doc.open makes content unknown" case.
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
    const baseResult = await loadBundle(blob, 'test.zip');
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;

    const baseSession = baseResult.value.sessions[0]!;
    const extraEvents = [
      ...baseSession.events,
      {
        seq: 1,
        t: 1000,
        wall: '2026-01-01T00:00:10.000Z',
        kind: 'doc.open' as const,
        // Note: no `content` field — simulates pre-v1.1 recorder.
        data: { path: 'hw.py', sha256: 'a'.repeat(64), line_count: 10 },
        prev_hash: baseSession.events[baseSession.events.length - 1]?.hash ?? '',
        hash: 'p1',
      },
      {
        seq: 2,
        t: 2000,
        wall: '2026-01-01T00:00:20.000Z',
        kind: 'doc.save' as const,
        data: { path: 'hw.py', sha256: 'b'.repeat(64) },
        prev_hash: 'p1',
        hash: 'p2',
      },
    ] as typeof baseSession.events;

    const bundle = {
      ...baseResult.value,
      sessions: [{ ...baseSession, events: extraEvents }],
    };

    const check = verifyDocSaveHashes(bundle);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/reconstruction not possible|indeterminate|unknown content/i);
  });

  it('still flags a real tamper after a properly seeded doc.open', async () => {
    // Regression: now that the check actually reconstructs from doc.open.content,
    // make sure a doctored save hash still trips a `fail`.
    const initialContent = 'x';
    const expectedHash = sha256Hex(initialContent);
    const tamperedHash = 'f'.repeat(64);

    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 0 }] });
    const baseResult = await loadBundle(blob, 'test.zip');
    expect(baseResult.ok).toBe(true);
    if (!baseResult.ok) return;

    const baseSession = baseResult.value.sessions[0]!;
    const extraEvents = [
      ...baseSession.events,
      {
        seq: 1,
        t: 1000,
        wall: '2026-01-01T00:00:10.000Z',
        kind: 'doc.open' as const,
        data: {
          path: 'hw.py',
          sha256: expectedHash,
          line_count: 1,
          content: initialContent,
        },
        prev_hash: baseSession.events[baseSession.events.length - 1]?.hash ?? '',
        hash: 'p1',
      },
      {
        seq: 2,
        t: 2000,
        wall: '2026-01-01T00:00:20.000Z',
        kind: 'doc.save' as const,
        // Tampered: the file was opened with 'x' and never modified, but the
        // recorded save hash is wrong.
        data: { path: 'hw.py', sha256: tamperedHash },
        prev_hash: 'p1',
        hash: 'p2',
      },
    ] as typeof baseSession.events;

    const bundle = {
      ...baseResult.value,
      sessions: [{ ...baseSession, events: extraEvents }],
    };

    const check = verifyDocSaveHashes(bundle);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/does not match/i);
  });

  // -------------------------------------------------------------------------
  // Two contributors sharing one file (git-repo group submission)
  // -------------------------------------------------------------------------

  const SHARED = '/repo/util.py';
  const ALICE_TEXT = 'def alice():\n    return 1\n';
  const BOB_TEXT = 'def bob():\n    return 2\n';
  /** Line on which an append lands after ALICE_TEXT (which ends in a newline). */
  const APPEND_LINE = ALICE_TEXT.split('\n').length - 1;

  const insertAt = (line: number, text: string) => ({
    path: SHARED,
    deltas: [
      {
        range: { start: { line, character: 0 }, end: { line, character: 0 } },
        text,
      },
    ],
    source: 'typed',
  });

  /** Alice creates the shared file and saves it. Always seeded by her doc.open. */
  const aliceSession = () => ({
    events: [
      {
        kind: 'doc.open',
        data: { path: SHARED, sha256: sha256Hex(''), line_count: 1, content: '' },
      },
      { kind: 'doc.change', data: insertAt(0, ALICE_TEXT) },
      { kind: 'doc.save', data: { path: SHARED, sha256: sha256Hex(ALICE_TEXT) } },
    ],
  });

  it('does not accuse a partner who edits a shared file their session never opened', async () => {
    // Regression for a FALSE ACCUSATION. Bob appends to a file Alice already
    // filled, and records the honest whole-file sha256 of what is on disk. His
    // own session never observed the file's starting content, so reconstructing
    // from an empty baseline yields the sha of his append alone — which can
    // never equal the real one. Before the fix this reported a hash mismatch,
    // i.e. tampering, against a submission with nothing wrong with it.
    const { blob } = await buildTestBundle({
      sessions: [
        aliceSession(),
        {
          events: [
            { kind: 'doc.change', data: insertAt(APPEND_LINE, BOB_TEXT) },
            {
              kind: 'doc.save',
              data: { path: SHARED, sha256: sha256Hex(ALICE_TEXT + BOB_TEXT) },
            },
          ],
        },
      ],
    });
    const result = await loadBundle(blob, 'group.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.status).toBe('pass');
    // The verdict must read as an absence of evidence, never as a finding.
    expect(check.detail).toMatch(/could not be reconstructed/i);
    expect(check.detail).not.toMatch(/does not match|mismatch/i);
    expect(check.supportingSeqs).toBeUndefined();
  });

  it('still fails a tampered save in the session that DID observe the baseline', async () => {
    // The shared-path allowance must not blanket-disable the check: Alice
    // opened the file, so her save is fully reconstructable and a doctored
    // hash on it is still a hard failure even though Bob shares the path.
    const alice = aliceSession();
    const tamperedAlice = {
      events: [
        alice.events[0]!,
        alice.events[1]!,
        { kind: 'doc.save', data: { path: SHARED, sha256: 'f'.repeat(64) } },
      ],
    };

    const { blob } = await buildTestBundle({
      sessions: [
        tamperedAlice,
        {
          events: [
            { kind: 'doc.change', data: insertAt(APPEND_LINE, BOB_TEXT) },
            {
              kind: 'doc.save',
              data: { path: SHARED, sha256: sha256Hex(ALICE_TEXT + BOB_TEXT) },
            },
          ],
        },
      ],
    });
    const result = await loadBundle(blob, 'group.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/does not match/i);
  });

  it('still fails a tampered save on a shared file the partner DID open', async () => {
    // The realistic recorder shape: every recorder emits doc.open for a file it
    // is about to edit, including files already open when the session starts.
    // Bob therefore has a baseline read from disk, so his save is checked in
    // full and a doctored hash on it still fails.
    const { blob } = await buildTestBundle({
      sessions: [
        aliceSession(),
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: SHARED,
                sha256: sha256Hex(ALICE_TEXT),
                line_count: APPEND_LINE + 1,
                content: ALICE_TEXT,
              },
            },
            { kind: 'doc.change', data: insertAt(APPEND_LINE, BOB_TEXT) },
            { kind: 'doc.save', data: { path: SHARED, sha256: 'e'.repeat(64) } },
          ],
        },
      ],
    });
    const result = await loadBundle(blob, 'group.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/does not match/i);
  });

  it('verifies an honest save in full when the partner DID open the shared file', async () => {
    const { blob } = await buildTestBundle({
      sessions: [
        aliceSession(),
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: SHARED,
                sha256: sha256Hex(ALICE_TEXT),
                line_count: APPEND_LINE + 1,
                content: ALICE_TEXT,
              },
            },
            { kind: 'doc.change', data: insertAt(APPEND_LINE, BOB_TEXT) },
            {
              kind: 'doc.save',
              data: { path: SHARED, sha256: sha256Hex(ALICE_TEXT + BOB_TEXT) },
            },
          ],
        },
      ],
    });
    const result = await loadBundle(blob, 'group.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.status).toBe('pass');
    // Fully reconstructed — no "could not be reconstructed" caveat at all.
    expect(check.detail).toBeUndefined();
  });

  it('reports the inline-cap reason, not the shared-file one, for a contentless open', async () => {
    // A doc.open over the recorder's inline cap carries no content, so the save
    // is indeterminate for the cap reason. The path also being shared must not
    // relabel it: the session did observe the open, so "never saw a baseline"
    // is the wrong explanation and the more specific reason wins.
    const { blob } = await buildTestBundle({
      sessions: [
        aliceSession(),
        {
          events: [
            {
              kind: 'doc.open',
              data: {
                path: SHARED,
                sha256: sha256Hex(ALICE_TEXT),
                line_count: APPEND_LINE + 1,
                truncated: true,
              },
            },
            { kind: 'doc.change', data: insertAt(APPEND_LINE, BOB_TEXT) },
            {
              kind: 'doc.save',
              data: { path: SHARED, sha256: sha256Hex(ALICE_TEXT + BOB_TEXT) },
            },
          ],
        },
      ],
    });
    const result = await loadBundle(blob, 'group.zip');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const check = verifyDocSaveHashes(result.value);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/inline cap/i);
    expect(check.detail).not.toMatch(/does not match|mismatch/i);
  });

  // -------------------------------------------------------------------------
  // Autosave observed late (a keystroke landed during the save)
  // -------------------------------------------------------------------------
  //
  // The recorder hashes a save from a disk read that completes after the write.
  // A keystroke that lands in between is logged as a doc.change BEFORE the
  // doc.save, while the save's sha256 is of the bytes written just before that
  // keystroke. The recorder recognises this against a ring of its buffer's
  // recent states (RECENT_HASH_RING_SIZE in recorder/src/state/expected-content.ts)
  // and logs the save as the student's own; check 7 must accept the same saves.

  const LATE = 'hw.py';

  const openEmpty = (): EventSpec => ({
    kind: 'doc.open',
    data: { path: LATE, sha256: sha256Hex(''), line_count: 1, content: '' },
  });

  /** One keystroke: insert `text` at column `col` of line 0. */
  const typeAt = (col: number, text: string): EventSpec => ({
    kind: 'doc.change',
    data: {
      path: LATE,
      deltas: [
        {
          range: { start: { line: 0, character: col }, end: { line: 0, character: col } },
          text,
        },
      ],
      source: 'typed',
    },
  });

  /** `n` single-character keystrokes, each appending 'a' to line 0. */
  const typeRun = (n: number): EventSpec[] => Array.from({ length: n }, (_, i) => typeAt(i, 'a'));

  const saveOf = (content: string): EventSpec => ({
    kind: 'doc.save',
    data: { path: LATE, sha256: sha256Hex(content) },
  });

  const checkEvents = async (events: EventSpec[]) => {
    const { blob } = await buildTestBundle({ sessions: [{ events }] });
    const result = await loadBundle(blob, 'test.zip');
    if (!result.ok) throw new Error('test bundle failed to load');
    return verifyDocSaveHashes(result.value);
  };

  it('accepts an autosave whose disk snapshot predates the last keystroke', async () => {
    // Regression for a FALSE ACCUSATION. The student types "ab"; the autosave
    // wrote "a" and the "b" keystroke landed before the recorder read the file
    // back, so the log reads change("a"), change("b"), save(sha256("a")).
    // Before the fix this was reported as a hash mismatch.
    const check = await checkEvents([openEmpty(), typeAt(0, 'a'), typeAt(1, 'b'), saveOf('a')]);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/1 save\(s\).*before the save was logged/i);
    expect(check.detail).not.toMatch(/does not match|mismatch/i);
    expect(check.supportingSeqs).toBeUndefined();
  });

  it('keeps the live buffer after a late-observed save, so the next save still verifies', async () => {
    // The stale snapshot must not reseed the replay: the buffer is ahead of it
    // and authoritative. Reseeding would make the NEXT honest save mismatch.
    const check = await checkEvents([
      openEmpty(),
      typeAt(0, 'a'),
      typeAt(1, 'b'),
      saveOf('a'), // observed late
      typeAt(2, 'c'),
      saveOf('abc'), // current
    ]);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/1 save\(s\)/);
  });

  it('accepts a snapshot several keystrokes behind, within the recorder window', async () => {
    // 40 keystrokes, then a save of the state 31 keystrokes before the current
    // one: the oldest state the recorder's 32-entry ring (current included) holds.
    const check = await checkEvents([openEmpty(), ...typeRun(40), saveOf('a'.repeat(40 - 31))]);
    expect(check.status).toBe('pass');
  });

  it('still fails a snapshot older than the recorder window', async () => {
    // One state further back than the ring reaches. The recorder would have
    // logged this as an fs.external_change, not as a plain save.
    const check = await checkEvents([openEmpty(), ...typeRun(40), saveOf('a'.repeat(40 - 32))]);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/does not match/i);
  });

  it('still fails a save of content the buffer never held', async () => {
    const check = await checkEvents([openEmpty(), typeAt(0, 'a'), typeAt(1, 'b'), saveOf('ba')]);
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/does not match/i);
  });

  it('does not accept a state between the deltas of a single change event', async () => {
    // A multi-cursor edit applies its deltas atomically, so the half-applied
    // state was never buffer content and never entered the recorder's ring.
    const multiCursor: EventSpec = {
      kind: 'doc.change',
      data: {
        path: LATE,
        deltas: [
          {
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
            text: 'y',
          },
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            text: 'x',
          },
        ],
        source: 'typed',
      },
    };
    // "-" → (y at 1) "-y" → (x at 0) "x-y"; "-y" is the half-applied state.
    const check = await checkEvents([openEmpty(), typeAt(0, '-'), multiCursor, saveOf('-y')]);
    expect(check.status).toBe('fail');
  });

  it('reports late-observed and unreconstructable saves together', async () => {
    const check = await checkEvents([
      openEmpty(),
      typeAt(0, 'a'),
      typeAt(1, 'b'),
      saveOf('a'), // observed late
      {
        kind: 'doc.open',
        data: { path: 'big.py', sha256: 'a'.repeat(64), line_count: 1, truncated: true },
      },
      { kind: 'doc.save', data: { path: 'big.py', sha256: 'b'.repeat(64) } }, // indeterminate
    ]);
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/could not be reconstructed/i);
    expect(check.detail).toMatch(/before the save was logged/i);
  });
});
