/**
 * Tests for the inter_session_external_change heuristic.
 */

import { describe, it, expect } from 'vitest';
import { interSessionExternalChangeHeuristic } from './inter-session-external-change.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { DEFAULT_HEURISTIC_CONFIG } from './config.js';
import type { EventSpec } from '../test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '../test-support/build-identity.js';
import type { IdentityTestKeys } from '../test-support/build-identity.js';
import { establishBundleContributors } from '../identity/resolve-contributors.js';

const cfg = DEFAULT_HEURISTIC_CONFIG;

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

// Convenience: like sessionThat, but with explicit wall timestamps stamped
// onto each of the 3 events (doc.open, doc.change, doc.save), in order. Used
// by the overlap-suppression tests below, which need precise control over
// each session's start/end wall time.
function sessionThatAt(
  file: string,
  openContent: string,
  appended: string,
  walls: [string, string, string],
): EventSpec[] {
  const [openWall, changeWall, saveWall] = walls;
  const [openEvent, changeEvent, saveEvent] = sessionThat(file, openContent, appended);
  return [
    { ...openEvent!, wall: openWall },
    { ...changeEvent!, wall: changeWall },
    { ...saveEvent!, wall: saveWall },
  ];
}

// Convenience: build a session that opens `file` at `content`, types one
// `appended` chunk at the end, then saves.
function sessionThat(file: string, openContent: string, appended: string): EventSpec[] {
  return [
    { kind: 'doc.open', data: { path: file, content: openContent } },
    {
      kind: 'doc.change',
      data: {
        path: file,
        source: 'typed',
        deltas: [
          {
            range: {
              start: { line: 0, character: openContent.length },
              end: { line: 0, character: openContent.length },
            },
            text: appended,
          },
        ],
      },
    },
    { kind: 'doc.save', data: { path: file, sha256: 'unused-in-this-test' } },
  ];
}

describe('inter_session_external_change', () => {
  it('emits no flags for a single-session bundle', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [{ events: sessionThat('hw1.py', '', 'def foo():\n    return 1\n') }],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('emits no flags when the file is unchanged across the gap', async () => {
    const finalA = 'def foo():\n    return 1\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', 'def foo():\n    return 1\n') },
        { events: sessionThat('hw1.py', finalA, '    # comment\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('flags a file that diverged between sessions', async () => {
    const finalA = 'def foo():\n    return 1\n';
    // Simulated external edit: someone added a print between sessions.
    const externallyEdited = finalA + 'print("oops")\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', finalA) },
        { events: sessionThat('hw1.py', externallyEdited, '\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);

    const f = flags[0]!;
    expect(f.heuristic).toBe('inter_session_external_change');
    expect(f.title).toContain('hw1.py');
    // |26 - 38| = 12, below default highSeverityCharsChanged (100) → medium.
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBeCloseTo(0.85);
    expect(f.supportingSeqs).toHaveLength(1);
    const detail = f.detail as Record<string, unknown>;
    expect(detail['file']).toBe('hw1.py');
    expect(detail['prev_length']).toBe(finalA.length);
    expect(detail['next_length']).toBe(externallyEdited.length);
  });

  it('marks divergence above the threshold as high severity', async () => {
    const finalA = 'x = 1\n';
    // Massive divergence.
    const externallyEdited = finalA + 'y = 2\n'.repeat(40); // 240 chars added
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', finalA) },
        { events: sessionThat('hw1.py', externallyEdited, '\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
  });

  it('does not flag files that the prior session never touched', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', 'a = 1\n') },
        // Session 2 opens a different file. We have no prior reconstruction
        // for utils.py from session 1, so we skip.
        { events: sessionThat('utils.py', 'def helper():\n    pass\n', '\n') },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does not flag when the second session uses pre-v1.1 doc.open without content', async () => {
    const finalA = 'def foo():\n    return 1\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: sessionThat('hw1.py', '', finalA) },
        {
          events: [
            // No content field → pre-v1.1 recorder. Cannot detect divergence.
            { kind: 'doc.open', data: { path: 'hw1.py' } },
            { kind: 'doc.save', data: { path: 'hw1.py', sha256: 'unused' } },
          ],
        },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Contributor scoping (Tier 3.3)
//
// This heuristic can only support "the file changed while MY recorder was off".
// Across two partners it was reporting a difference that is guaranteed by
// construction — different person, different machine, different working tree —
// at confidence 0.85, on every partner commit. Suppression is permitted ONLY
// where both sides resolve to verified, distinct contributors.
// ---------------------------------------------------------------------------

describe('inter_session_external_change — contributor scoping', () => {
  const ALICE = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';
  const BOB = '3a1d0e55-8c44-4b2a-a7f0-11c9d2e3f4a5';

  let cachedKeys: IdentityTestKeys | null = null;
  async function keys(): Promise<IdentityTestKeys> {
    cachedKeys ??= await buildIdentityKeys();
    return cachedKeys;
  }

  type Who = { studentRef: string } | 'anonymous';

  /**
   * Build a bundle from a list of (contributor, events) sessions and stamp it.
   * `stamp: false` leaves the bundle unstamped, which is how a caller that
   * forgot to establish contributors sees the world.
   */
  async function buildAttributed(
    specs: Array<{ who: Who; events: EventSpec[] }>,
    opts?: { stamp?: boolean },
  ) {
    const k = await keys();
    const sessions = [];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i]!;
      const sk = await seededKeypair(0x60 + i);
      sessions.push({
        events: spec.events,
        sessionStart: {
          session_pubkey: sk.pubkeyHex,
          ...(spec.who === 'anonymous'
            ? {}
            : {
                identity: await buildInstitutionIdentity({
                  keys: k,
                  sessionPubkeyHex: sk.pubkeyHex,
                  studentRef: spec.who.studentRef,
                }),
              }),
        },
      });
    }
    const { zipBuffer } = await buildTestBundle({ sessions });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
    const bundle = result.value;
    const resolved =
      opts?.stamp === false ? null : await establishBundleContributors(bundle, k.root.pubkeyHex);
    return { index: buildIndex(bundle), bundle, resolved };
  }

  // Alice ends her session with this; the partner's commit then lands on top.
  const ALICE_FINAL = 'def foo():\n    return 1\n';
  const AFTER_PARTNER_COMMIT = ALICE_FINAL + 'def bar():\n    return 2\n';

  it("does NOT flag a partner's commit landing between contributor A's sessions", async () => {
    // Wall order: Alice, Bob (who commits his own work), Alice again. Both
    // consecutive pairs cross contributors, so neither is a claim about Alice.
    const { index, bundle, resolved } = await buildAttributed([
      { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
      {
        who: { studentRef: BOB },
        events: sessionThat('hw1.py', AFTER_PARTNER_COMMIT, 'x = 3\n'),
      },
      {
        who: { studentRef: ALICE },
        events: sessionThat('hw1.py', AFTER_PARTNER_COMMIT + 'x = 3\n', '\n'),
      },
    ]);
    expect(resolved!.counts).toEqual({ attributed: 3, unverifiable: 0, unattributed: 0 });

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag a straight two-partner handoff', async () => {
    const { index, bundle, resolved } = await buildAttributed([
      { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
      { who: { studentRef: BOB }, events: sessionThat('hw1.py', AFTER_PARTNER_COMMIT, '\n') },
    ]);
    expect(resolved!.counts).toEqual({ attributed: 2, unverifiable: 0, unattributed: 0 });

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it("STILL flags divergence between one contributor's own consecutive sessions", async () => {
    // The real signal: Alice's file changed under an editor that was not
    // recording, between two of HER sessions.
    const { index, bundle, resolved } = await buildAttributed([
      { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
      {
        who: { studentRef: ALICE },
        events: sessionThat('hw1.py', ALICE_FINAL + 'print("oops")\n', '\n'),
      },
    ]);
    expect(resolved!.contributors).toHaveLength(1);

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    expect(f.severity).toBe('medium');
    expect(f.confidence).toBeCloseTo(0.85);
    expect(f.detail!['contributor_comparison']).toBe('same');
    expect(f.description).toContain('same verified contributor');
  });

  it('STILL flags when one side is unattributed', async () => {
    const { index, bundle, resolved } = await buildAttributed([
      { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
      { who: 'anonymous', events: sessionThat('hw1.py', ALICE_FINAL + 'print("x")\n', '\n') },
    ]);
    expect(resolved!.counts).toEqual({ attributed: 1, unverifiable: 0, unattributed: 1 });

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributor_comparison']).toBe('unknown');
  });

  it('STILL flags when BOTH sides are unattributed — singleton keys must not read as "different people"', async () => {
    const { index, bundle, resolved } = await buildAttributed([
      { who: 'anonymous', events: sessionThat('hw1.py', '', ALICE_FINAL) },
      { who: 'anonymous', events: sessionThat('hw1.py', ALICE_FINAL + 'print("x")\n', '\n') },
    ]);
    // Distinct singleton keys — a direct key compare would suppress here.
    expect(resolved!.contributors).toHaveLength(2);
    expect(resolved!.contributors[0]!.key).not.toBe(resolved!.contributors[1]!.key);

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributor_comparison']).toBe('unknown');
  });

  it('an UNSTAMPED bundle behaves exactly as it did before Tier 3.3', async () => {
    // Two DIFFERENT verified partners — but nobody stamped the bundle, so every
    // session reads unattributed and the pre-3.3 comparison is preserved. A
    // caller that forgets to stamp must lose no findings.
    const { index, bundle } = await buildAttributed(
      [
        { who: { studentRef: ALICE }, events: sessionThat('hw1.py', '', ALICE_FINAL) },
        { who: { studentRef: BOB }, events: sessionThat('hw1.py', AFTER_PARTNER_COMMIT, '\n') },
      ],
      { stamp: false },
    );
    expect(bundle.contributors).toBeUndefined();

    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributor_comparison']).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Overlap suppression
//
// A negative or zero gap between sessionA's last event and sessionB's first
// event is proof the two sessions were never sequential — a second recorder
// was running the whole time sessionA's clock says it was "off". See the
// "Scoped to non-overlapping pairs" header comment.
// ---------------------------------------------------------------------------

describe('inter_session_external_change — session overlap', () => {
  const FINAL_A = 'def foo():\n    return 1\n';
  const EXTERNALLY_EDITED = FINAL_A + 'print("oops")\n';

  it('does NOT flag a pair whose sessions overlap in wall time, even though the file differs', async () => {
    // Mirrors a real bundle: session B (23:41:08 → 23:48:58) is entirely
    // NESTED inside session A (23:35:51 → 23:57:26). gap = bStart - aEnd =
    // 23:41:08 - 23:57:26 = -978s, exactly the negative gap the bug report
    // printed as "over a -978s gap" — proof the interval never existed.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          walls: ['2026-06-01T23:35:51.000Z'],
          events: sessionThatAt('hw1.py', '', FINAL_A, [
            '2026-06-01T23:36:00.000Z',
            '2026-06-01T23:45:00.000Z',
            '2026-06-01T23:57:26.000Z',
          ]),
        },
        {
          walls: ['2026-06-01T23:41:08.000Z'],
          events: sessionThatAt('hw1.py', EXTERNALLY_EDITED, '\n', [
            '2026-06-01T23:41:09.000Z',
            '2026-06-01T23:45:30.000Z',
            '2026-06-01T23:48:58.000Z',
          ]),
        },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  it('STILL flags a genuinely sequential pair (positive gap) with a differing file', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          walls: ['2026-06-01T10:00:00.000Z'],
          events: sessionThatAt('hw1.py', '', FINAL_A, [
            '2026-06-01T10:00:10.000Z',
            '2026-06-01T10:00:20.000Z',
            '2026-06-01T10:00:30.000Z',
          ]),
        },
        {
          walls: ['2026-06-01T10:05:30.000Z'],
          events: sessionThatAt('hw1.py', EXTERNALLY_EDITED, '\n', [
            '2026-06-01T10:05:31.000Z',
            '2026-06-01T10:05:40.000Z',
            '2026-06-01T10:05:50.000Z',
          ]),
        },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    // aEnd = 10:00:30, bStart = 10:05:30 → 300s gap, computed once and reused
    // for the description text.
    expect(flags[0]!.description).toContain('over a 300s gap');
    expect(flags[0]!.detail!['gap_wall_ms']).toBe(300_000);
  });

  it('still compares a pair when the wall gap cannot be established, without fabricating a gap figure', async () => {
    // sessionA's last event carries an unparseable wall (a malformed timezone
    // suffix, not a garbage string, so it still sorts into the right position
    // lexicographically among real ISO timestamps). Date.parse of it is NaN,
    // so the gap is null — "cannot establish" — which must NOT suppress the
    // pair (null is not evidence of overlap) and must NOT print a fabricated
    // "0s gap" either.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          walls: ['2026-06-01T09:59:50.000Z'],
          events: sessionThatAt('hw1.py', '', FINAL_A, [
            '2026-06-01T10:00:00.000Z',
            '2026-06-01T10:00:10.000Z',
            '2026-06-01T10:00:20.000X', // malformed timezone designator -> Date.parse = NaN
          ]),
        },
        {
          walls: ['2026-06-01T10:01:00.000Z'],
          events: sessionThatAt('hw1.py', EXTERNALLY_EDITED, '\n', [
            '2026-06-01T10:01:01.000Z',
            '2026-06-01T10:01:10.000Z',
            '2026-06-01T10:01:20.000Z',
          ]),
        },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['gap_wall_ms']).toBeNull();
    expect(flags[0]!.description).not.toMatch(/\d+s gap/);
    expect(flags[0]!.description).toContain('could not be established');
  });

  // A rotation (the recorder hit ROTATE_AT_BYTES and started a fresh session
  // in the same scope) leaves no time window in which anything could edit the
  // file, and the successor's catch-up doc.open carries the live BUFFER
  // content — so the seam must produce no flag. See
  // docs/superpowers/specs/2026-09-21-log-size-rotation-design.md §3.3.
  it('emits no flags across a rotation seam', async () => {
    const finalA = 'def foo():\n    return 1\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
          events: [
            ...sessionThat('hw1.py', '', finalA),
            { kind: 'session.end', data: { reason: 'rotate' } },
          ],
        },
        {
          sessionId: 'aaaaaaaa-0000-4000-8000-000000000002',
          sessionStart: { prev_session_id: 'aaaaaaaa-0000-4000-8000-000000000001' },
          events: sessionThat('hw1.py', finalA, '    # more\n'),
        },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  // The seam must also be clean when the buffer was DIRTY at rotation: session
  // A's reconstruction includes the unsaved edit, and B's doc.open baseline is
  // read from the buffer, so both sides carry it. A recorder that seeded B from
  // disk instead would diverge here and produce a false accusation.
  it('emits no flags across a rotation seam with an unsaved edit', async () => {
    const saved = 'def foo():\n    return 1\n';
    const unsaved = saved + '# typed but never saved\n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          sessionId: 'bbbbbbbb-0000-4000-8000-000000000001',
          events: [
            { kind: 'doc.open', data: { path: 'hw1.py', content: saved } },
            {
              kind: 'doc.change',
              data: {
                path: 'hw1.py',
                source: 'typed',
                deltas: [
                  {
                    range: {
                      start: { line: 2, character: 0 },
                      end: { line: 2, character: 0 },
                    },
                    text: '# typed but never saved\n',
                  },
                ],
              },
            },
            { kind: 'session.end', data: { reason: 'rotate' } },
          ],
        },
        {
          sessionId: 'bbbbbbbb-0000-4000-8000-000000000002',
          sessionStart: { prev_session_id: 'bbbbbbbb-0000-4000-8000-000000000001' },
          events: [{ kind: 'doc.open', data: { path: 'hw1.py', content: unsaved } }],
        },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(0);
  });

  // Negative control for the two "emits no flags across a rotation seam" tests
  // above (design doc §3.3, §5 item 8). Those tests hand-build a seam where
  // content is identical on both sides, so by themselves they cannot tell "the
  // recorders produce an empty seam" apart from "this heuristic stopped
  // comparing anything at all" — a regression that would silently blind the
  // one check that catches out-of-band editing. This test builds the seam
  // LOSSY instead: B's first doc.open (the live buffer read) differs from A's
  // reconstructed end state, exactly as if a keystroke were dropped inside the
  // rotation teardown window. It must still flag, and the student-controlled
  // `reason: 'rotate'` string must play no part in suppressing it — rotation
  // is not an exemption, it is only expected to produce an empty seam when the
  // recorder holds up its end (idle gate + no chain recovery).
  it('still flags a rotation seam that LOST content (negative control)', async () => {
    const finalA = 'def foo():\n    return 1\n';
    // What B's live buffer would read if the last keystroke before rotation
    // never made it into A's reconstruction.
    const lossyOpen = 'def foo():\n    return \n';
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          sessionId: 'cccccccc-0000-4000-8000-000000000001',
          events: [
            ...sessionThat('hw1.py', '', finalA),
            { kind: 'session.end', data: { reason: 'rotate' } },
          ],
        },
        {
          sessionId: 'cccccccc-0000-4000-8000-000000000002',
          sessionStart: { prev_session_id: 'cccccccc-0000-4000-8000-000000000001' },
          events: sessionThat('hw1.py', lossyOpen, '\n'),
        },
      ],
    });
    const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('inter_session_external_change');
  });
});
