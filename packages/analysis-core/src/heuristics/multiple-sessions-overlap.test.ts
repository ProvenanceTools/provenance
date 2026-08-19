/**
 * Tests for the multiple_sessions_overlap heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { multipleSessionsOverlapHeuristic } from './multiple-sessions-overlap.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '../test-support/build-identity.js';
import type { IdentityTestKeys } from '../test-support/build-identity.js';
import { establishBundleContributors } from '../identity/resolve-contributors.js';
import { mergeConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

const defaultConfig = mergeConfig();

// Wall-time helpers using a fixed base epoch so tests are deterministic.
// Base: 2026-02-01T08:00:00.000Z
const BASE_MS = new Date('2026-02-01T08:00:00.000Z').getTime();
function wallAt(offsetMinutes: number): string {
  return new Date(BASE_MS + offsetMinutes * 60_000).toISOString();
}

/** A `session.end` at the given offset — the clean-shutdown bound. */
function endsAt(offsetMinutes: number) {
  return {
    kind: 'session.end',
    data: { reason: 'deactivate' },
    wall: wallAt(offsetMinutes),
    t: offsetMinutes * 60_000,
  };
}

/**
 * An ordinary non-terminal event at the given offset. Used to give a crashed
 * session (no `session.end`) a last-recorded-event wall, which is what now
 * bounds its range.
 */
function activityAt(offsetMinutes: number) {
  return {
    kind: 'doc.change',
    data: {
      path: '/test/file.py',
      deltas: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, text: 'x' },
      ],
      source: 'typed',
    },
    wall: wallAt(offsetMinutes),
    t: offsetMinutes * 60_000,
  };
}

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe('multiple_sessions_overlap — negative', () => {
  it('produces no flags for a single-session bundle', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags for two non-overlapping sessions (A ends before B starts)', async () => {
    // Session A: wall 0..10min; Session B: wall 15..25min → no overlap
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(10), t: 600_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(25), t: 600_000 },
          ],
          walls: [wallAt(15)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags for two adjacent sessions (A.end === B.start)', async () => {
    // Strict overlap: a.start < b.end AND b.start < a.end
    // Adjacent: B.start = A.end → b.start < a.end is false → no overlap
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(10), t: 600_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 600_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Crashed sessions (no session.end)
//
// Regression coverage for the +Infinity bug: a session with no `session.end`
// used to be modelled as running forever, so a single crash flagged every
// session that started after it — for the rest of the assignment. A crashed
// session is now bounded at its last recorded event.
// ---------------------------------------------------------------------------

describe('multiple_sessions_overlap — crashed sessions', () => {
  it('does NOT flag a crashed session against a session starting after its last event', async () => {
    // Session A: starts at 0, last event at 10, then crashes (no session.end).
    // Session B: starts at 15 — after A's last sign of life → no overlap.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: [activityAt(10)], walls: [wallAt(0)] },
        { events: [endsAt(25)], walls: [wallAt(15)] },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag one crashed session against many later sessions', async () => {
    // The shape that produced 13 false flags on a real bundle: one early crash
    // followed by four ordinary, strictly sequential sessions.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: [activityAt(5)], walls: [wallAt(0)] }, // crash at 5
        { events: [endsAt(20)], walls: [wallAt(10)] },
        { events: [endsAt(40)], walls: [wallAt(30)] },
        { events: [endsAt(60)], walls: [wallAt(50)] },
        { events: [endsAt(80)], walls: [wallAt(70)] },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('does NOT flag a session whose only event is session.start', async () => {
    // Zero-length range — it never demonstrably ran concurrently with anything.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: [], walls: [wallAt(0)] },
        { events: [endsAt(30)], walls: [wallAt(10)] },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('DOES flag a crashed session whose recorded activity overlaps a later session', async () => {
    // Session A: starts at 0, still recording events at 20, then crashes.
    // Session B: starts at 10 — genuinely concurrent recorded activity.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        { events: [activityAt(20)], walls: [wallAt(0)] },
        { events: [endsAt(30)], walls: [wallAt(10)] },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail).toMatchObject({
      sessionAOpenEnded: true,
      sessionBOpenEnded: false,
      sessionAEndWall: `${wallAt(20)} (last event; no session.end)`,
      sessionBEndWall: wallAt(30),
    });
  });
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('multiple_sessions_overlap — positive', () => {
  it('flags two sessions with overlapping wall-time ranges (different hosts)', async () => {
    // Session A: [0, 20min]; Session B: [10, 30min] → overlap at [10, 20]
    // Distinct machine_ids → a real cross-host "stitched together" signal.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'machine-a',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'machine-b',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('multiple_sessions_overlap');
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.confidence).toBe(0.95);
    expect(flags[0]!.supportingSeqs).toHaveLength(2);
  });

  it('flags two crashed sessions whose recorded activity overlaps in wall-time', async () => {
    // Session A: [0, 25] (crashed); Session B: [10, 30] (crashed) → overlap.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'machine-a',
          events: [activityAt(25)],
          walls: [wallAt(0)],
        },
        {
          machineId: 'machine-b',
          events: [activityAt(30)],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('multiple_sessions_overlap');
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.detail).toMatchObject({
      sessionA: expect.any(String),
      sessionB: expect.any(String),
      sessionAOpenEnded: true,
      sessionBOpenEnded: true,
      sessionAEndWall: `${wallAt(25)} (last event; no session.end)`,
      sessionBEndWall: `${wallAt(30)} (last event; no session.end)`,
    });
  });

  it('flag ID is stable across runs', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'machine-a',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'machine-b',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags1 = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    const flags2 = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags1[0]!.id).toBe(flags2[0]!.id);
  });

  it('emits N*(N-1)/2 flags for N mutually overlapping sessions', async () => {
    // Three sessions that all overlap, each on a distinct host → all pairs flagged.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'machine-a',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_800_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'machine-b',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
        {
          machineId: 'machine-c',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 600_000 },
          ],
          walls: [wallAt(20)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    // 3 choose 2 = 3 pairs, all overlapping → 3 flags
    expect(flags).toHaveLength(3);
    // All IDs should be unique
    const ids = flags.map((f) => f.id);
    expect(new Set(ids).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Recorder identity does not suppress
//
// An earlier version suppressed overlaps when both sessions shared a
// machine_id AND an extension_id. That guard was unreachable: machine_id is
// sha256(hostname:username:sessionId) in all three recorders — session-salted
// by design (PRD §5.1) — so it is unique per session and can never match. The
// guard's own tests passed only because the fixtures hand-set a shared
// machine_id no recorder can emit. These tests pin the removal: identity, in
// any combination, no longer changes the verdict.
// ---------------------------------------------------------------------------

describe('multiple_sessions_overlap — recorder identity does not suppress', () => {
  it('flags overlapping sessions even when host and recorder identity match', async () => {
    // Both sessions overlap [10, 20], same machine_id + same extension_id.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [endsAt(20)],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [endsAt(30)],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });

  it('still flags overlapping sessions from the same host but DIFFERENT recorders', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.vscode',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });

  it('still flags overlapping sessions from DIFFERENT hosts but the same recorder', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(20), t: 1_200_000 },
          ],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-2',
          extensionId: 'provenance.recorder.nvim',
          events: [
            { kind: 'session.end', data: { reason: 'deactivate' }, wall: wallAt(30), t: 1_200_000 },
          ],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });

  it('flags every pair when three same-host sessions all overlap', async () => {
    // All three share a host+recorder and all three overlap → 3 choose 2 = 3.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [endsAt(30)],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [endsAt(30)],
          walls: [wallAt(10)],
        },
        {
          machineId: 'laptop-2',
          extensionId: 'provenance.recorder.nvim',
          events: [endsAt(30)],
          walls: [wallAt(20)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(3);
  });

  it('flags a same-host overlap when one session is missing recorder identity', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          machineId: 'laptop-1',
          extensionId: 'provenance.recorder.nvim',
          events: [endsAt(20)],
          walls: [wallAt(0)],
        },
        {
          machineId: 'laptop-1',
          extensionId: '',
          events: [endsAt(30)],
          walls: [wallAt(10)],
        },
      ],
    });
    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Contributor keying (Tier 3.2)
//
// The reason this heuristic was re-keyed: two partners sharing a repo, each
// running their own recorder, overlap in wall time every single time they work
// together, and the flag accused them of log forgery for it. Suppression is
// permitted ONLY where both sides resolve to verified, distinct contributors —
// never on a bare `contributorKey` inequality, which reads "unproven" as
// "different people".
// ---------------------------------------------------------------------------

describe('multiple_sessions_overlap — contributor keying', () => {
  const ALICE = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';
  const BOB = '3a1d0e55-8c44-4b2a-a7f0-11c9d2e3f4a5';

  let cachedKeys: IdentityTestKeys | null = null;
  async function keys(): Promise<IdentityTestKeys> {
    cachedKeys ??= await buildIdentityKeys();
    return cachedKeys;
  }

  type Who = { studentRef: string } | 'anonymous';

  /**
   * Two sessions that overlap in wall time (0..30 and 10..30), each optionally
   * carrying a fully-signed 2.1 identity block, with the bundle stamped so
   * `contributorOf` can answer.
   */
  async function overlappingPair(whoA: Who, whoB: Who) {
    const k = await keys();
    const specs: Who[] = [whoA, whoB];
    const sessions = [];
    for (let i = 0; i < 2; i++) {
      const sk = await seededKeypair(0x60 + i);
      const who = specs[i]!;
      sessions.push({
        events: [endsAt(30)],
        walls: [wallAt(i * 10)],
        sessionStart: {
          session_pubkey: sk.pubkeyHex,
          ...(who === 'anonymous'
            ? {}
            : {
                identity: await buildInstitutionIdentity({
                  keys: k,
                  sessionPubkeyHex: sk.pubkeyHex,
                  studentRef: who.studentRef,
                }),
              }),
        },
      });
    }

    const { zipBuffer } = await buildTestBundle({ sessions });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
    const bundle = result.value;
    const resolved = await establishBundleContributors(bundle, k.root.pubkeyHex);
    return { index: buildIndex(bundle), bundle, resolved };
  }

  it('does NOT flag two attributed partners recording simultaneously', async () => {
    const { index, bundle, resolved } = await overlappingPair(
      { studentRef: ALICE },
      { studentRef: BOB },
    );
    // Guard the premise: both sides really did verify, so the suppression below
    // is the 'different' branch and not an accidental resolution failure.
    expect(resolved.counts).toEqual({ attributed: 2, unverifiable: 0, unattributed: 0 });

    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('STILL flags one contributor whose own two sessions overlap', async () => {
    const { index, bundle, resolved } = await overlappingPair(
      { studentRef: ALICE },
      { studentRef: ALICE },
    );
    expect(resolved.counts).toEqual({ attributed: 2, unverifiable: 0, unattributed: 0 });
    expect(resolved.contributors).toHaveLength(1);

    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    const f = flags[0]!;
    // The original signal, at its original strength.
    expect(f.severity).toBe('high');
    expect(f.confidence).toBeCloseTo(0.95);
    expect(f.detail!['contributorComparison']).toBe('same');
    expect(f.description).toContain('same verified contributor');
    expect(f.description).toContain(ALICE);
  });

  it('STILL flags when session A is unattributed and session B is attributed', async () => {
    const { index, bundle, resolved } = await overlappingPair('anonymous', { studentRef: BOB });
    expect(resolved.counts).toEqual({ attributed: 1, unverifiable: 0, unattributed: 1 });

    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributorComparison']).toBe('unknown');
    expect(flags[0]!.severity).toBe('high');
  });

  it('STILL flags when session B is unattributed and session A is attributed', async () => {
    const { index, bundle, resolved } = await overlappingPair({ studentRef: ALICE }, 'anonymous');
    expect(resolved.counts).toEqual({ attributed: 1, unverifiable: 0, unattributed: 1 });

    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributorComparison']).toBe('unknown');
  });

  it('STILL flags when BOTH sessions are unattributed — distinct singleton keys must not read as "different people"', async () => {
    const { index, bundle, resolved } = await overlappingPair('anonymous', 'anonymous');
    expect(resolved.counts).toEqual({ attributed: 0, unverifiable: 0, unattributed: 2 });
    // Two unattributed sessions get DIFFERENT singleton contributorKeys. A
    // direct key compare would call them "different people" and suppress —
    // this assertion is what goes red if someone does that.
    expect(resolved.contributors).toHaveLength(2);
    expect(resolved.contributors[0]!.key).not.toBe(resolved.contributors[1]!.key);

    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributorComparison']).toBe('unknown');
  });

  it('STILL flags when the identity block is present but does not verify', async () => {
    // A block claiming ALICE signed by a key that is not the root: `unverifiable`,
    // never quietly merged into ALICE, and never treated as proof of a second
    // person either.
    const k = await keys();
    const wrongRoot = await seededKeypair(0x77);
    const sessions = [];
    for (let i = 0; i < 2; i++) {
      const sk = await seededKeypair(0x60 + i);
      sessions.push({
        events: [endsAt(30)],
        walls: [wallAt(i * 10)],
        sessionStart: {
          session_pubkey: sk.pubkeyHex,
          identity: await buildInstitutionIdentity({
            keys: k,
            sessionPubkeyHex: sk.pubkeyHex,
            studentRef: i === 0 ? ALICE : BOB,
            ...(i === 0 ? { certSignedBy: wrongRoot.privkey } : {}),
          }),
        },
      });
    }
    const { zipBuffer } = await buildTestBundle({ sessions });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
    const bundle = result.value;
    const resolved = await establishBundleContributors(bundle, k.root.pubkeyHex);
    expect(resolved.counts).toEqual({ attributed: 1, unverifiable: 1, unattributed: 0 });

    const flags = multipleSessionsOverlapHeuristic.run(buildIndex(bundle), bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributorComparison']).toBe('unknown');
  });

  it('an UNSTAMPED bundle behaves exactly as it did before Tier 3.2', async () => {
    // No caller ran establishBundleContributors. Every session reads
    // `unattributed`, so nothing is suppressed. An analyzer or server path that
    // forgets to stamp must lose no findings.
    const k = await keys();
    const sessions = [];
    for (let i = 0; i < 2; i++) {
      const sk = await seededKeypair(0x60 + i);
      sessions.push({
        events: [endsAt(30)],
        walls: [wallAt(i * 10)],
        sessionStart: {
          session_pubkey: sk.pubkeyHex,
          identity: await buildInstitutionIdentity({
            keys: k,
            sessionPubkeyHex: sk.pubkeyHex,
            studentRef: i === 0 ? ALICE : BOB,
          }),
        },
      });
    }
    const { zipBuffer } = await buildTestBundle({ sessions });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
    const bundle = result.value;
    expect(bundle.contributors).toBeUndefined();

    const flags = multipleSessionsOverlapHeuristic.run(buildIndex(bundle), bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributorComparison']).toBe('unknown');
  });

  it('no longer claims the overlap is "impossible" on any path', async () => {
    // The old text — carried into the grader-visible flag — asserted forgery
    // about something that is routine and innocent in a shared repo.
    const pairs: Array<[Who, Who]> = [
      [{ studentRef: ALICE }, { studentRef: ALICE }],
      ['anonymous', 'anonymous'],
      [{ studentRef: ALICE }, 'anonymous'],
    ];
    for (const [a, b] of pairs) {
      const { index, bundle } = await overlappingPair(a, b);
      const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
      expect(flags).toHaveLength(1);
      expect(flags[0]!.description).not.toContain('impossible');
    }
  });
});
