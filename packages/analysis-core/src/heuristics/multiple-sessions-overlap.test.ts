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

  /**
   * A SECOND enrolled machine belonging to the same deployment.
   *
   * D5: "each machine enrols independently, generating its own keypair; the
   * shared `student_ref` groups them into one contributor". So the root and the
   * institution keys are identical — it is the same institution issuing the
   * second credential — and ONLY the student keypair differs. That is the whole
   * difference a second enrolment produces, and it is what
   * `mint-credential.ts` counts as `machine_count`.
   */
  let cachedSecondMachine: IdentityTestKeys | null = null;
  async function secondMachine(): Promise<IdentityTestKeys> {
    cachedSecondMachine ??= await buildIdentityKeys({ studentSeedByte: 0x56 });
    return cachedSecondMachine;
  }

  /**
   * `machine` selects WHICH enrolled keypair countersigns the session key.
   * Omitted means the default (first) machine, so every pre-existing caller
   * keeps describing one person on one machine.
   */
  type Who = { studentRef: string; machine?: IdentityTestKeys } | 'anonymous';

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
                  keys: who.machine ?? k,
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

  it('STILL flags one contributor whose own two sessions overlap ON ONE MACHINE', async () => {
    // The NEGATIVE CONTROL for the two-machine suppression below. Both sessions
    // countersigned under the SAME enrolled student key, so "they used two
    // machines" is excluded by the evidence and clock manipulation is what is
    // left. Full strength, unchanged.
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
    expect(f.detail!['contributorComparison']).toBe('same_machine');
    expect(f.description).toContain('same verified contributor');
    expect(f.description).toContain(ALICE);
  });

  // -------------------------------------------------------------------------
  // D5 — multiple machines per student is a first-class flow
  //
  // "Each machine enrols independently, generating its own keypair; the shared
  // `student_ref` groups them into one contributor." The flag used to accuse
  // that flow of log forgery in its first clause and concede it in its last.
  // The evidence that tells the two apart was already in the bundle: the
  // long-lived `student_pubkey` the chain walk returns is per-MACHINE, while
  // `student_ref` is per-PERSON.
  // -------------------------------------------------------------------------
  describe('two enrolled machines, one student (D5)', () => {
    it('does NOT flag one student recording on two independently enrolled machines', async () => {
      const { index, bundle, resolved } = await overlappingPair(
        { studentRef: ALICE },
        { studentRef: ALICE, machine: await secondMachine() },
      );
      // Guard the premise on BOTH axes, or the suppression below could be an
      // accidental resolution failure rather than the two-machine branch.
      expect(resolved.counts).toEqual({ attributed: 2, unverifiable: 0, unattributed: 0 });

      const [ca, cb] = [...resolved.bySession.values()];
      if (ca?.kind !== 'attributed' || cb?.kind !== 'attributed') {
        throw new Error('premise: both sessions must resolve attributed');
      }
      // ONE person...
      expect(ca.studentRef).toBe(ALICE);
      expect(cb.studentRef).toBe(ALICE);
      // ...on two PROVEN-distinct enrolled machines.
      expect(ca.studentPubkey).not.toBe(cb.studentPubkey);

      const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
      expect(flags).toEqual([]);
    });

    it('keeps ONE contributor — the machine is visible to the overlap judgement, not to attribution', async () => {
      // D14's per-contributor scoring and migration 0029 both depend on one key
      // per person. Splitting a student into two contributors would split their
      // score across two apparent people, which is the exact failure 0029
      // exists to prevent. So the two machines must NOT become two
      // contributors.
      const { resolved } = await overlappingPair(
        { studentRef: ALICE },
        { studentRef: ALICE, machine: await secondMachine() },
      );
      expect(resolved.contributors).toHaveLength(1);
      expect(resolved.contributors[0]!.studentRef).toBe(ALICE);
      expect(resolved.contributors[0]!.sessionIds).toHaveLength(2);
    });

    it('does not let a second machine launder an overlap between two DIFFERENT students', async () => {
      // The suppression must key on the ref being the SAME and the machine
      // being different — never on the machine alone. Two different people
      // always have different machine keys, and that pair is suppressed for a
      // different reason (proven collaboration), which must stay distinct.
      const { index, bundle } = await overlappingPair(
        { studentRef: ALICE },
        { studentRef: BOB, machine: await secondMachine() },
      );
      const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
      expect(flags).toEqual([]);
    });
  });

  it('STILL flags when session A is unattributed and session B is attributed', async () => {
    const { index, bundle, resolved } = await overlappingPair('anonymous', { studentRef: BOB });
    expect(resolved.counts).toEqual({ attributed: 1, unverifiable: 0, unattributed: 1 });

    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.detail!['contributorComparison']).toBe('unknown');
    // Kept as a finding, but NOT as a high-severity accusation: which of the
    // two readings applies is exactly what the evidence does not establish.
    expect(flags[0]!.severity).toBe('low');
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

  // -------------------------------------------------------------------------
  // The undecidable majority
  //
  // `compareContributors` needs BOTH sides attributed, so `'unknown'` is the
  // answer for the ordinary cases: one partner unenrolled, neither enrolled,
  // any 1.x bundle (no identity block exists below Manifest 2.0), and any
  // deployment with no root key configured. This flag emits N*(N-1)/2 of them
  // per bundle. §6 Rule 2 — a finding names a person only when the evidence is
  // `established` — and Rule 1's third state is `unknown`, STATED, with what
  // would have resolved it. A high-severity accusation is not that statement.
  //
  // The finding is KEPT, at every one of those states. What changes is the
  // weight it carries into a grader's triage, and the lever is available here
  // in a way bug 13's was not: the partition separates the decidable
  // single-machine case cleanly, so lowering the undecidable one costs the
  // genuine detection nothing.
  // -------------------------------------------------------------------------
  describe('an undecidable overlap is stated, not accused', () => {
    it('states the case rather than asserting it, when neither side is attributed', async () => {
      const { index, bundle } = await overlappingPair('anonymous', 'anonymous');
      const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);

      expect(flags).toHaveLength(1);
      const f = flags[0]!;
      // Not dropped — the overlap itself is established and stays visible.
      expect(f.heuristic).toBe('multiple_sessions_overlap');
      expect(f.severity).toBe('low');
      expect(f.confidence).toBeLessThan(0.95);
      // Rule 1: what would have resolved it, named.
      expect(f.description).toContain('not established');
      expect(f.description).toMatch(/enrol/i);
      expect(f.detail!['unresolvedBy']).toBe('no_identity_block');
    });

    it('does NOT turn a deployment with no root key into a class-wide accusation', async () => {
      // `resolve-contributors.ts` answers `unverifiable / no_root_key` for
      // EVERY identified session when the deployment has no root public key.
      // That is one unset environment variable. It previously made every
      // partner overlap in every bundle a HIGH flag.
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
      // No root key. Both blocks are perfectly good; nothing can check them.
      const resolved = await establishBundleContributors(bundle);
      expect(resolved.rootKeyConfigured).toBe(false);
      expect(resolved.counts).toEqual({ attributed: 0, unverifiable: 2, unattributed: 0 });

      const flags = multipleSessionsOverlapHeuristic.run(buildIndex(bundle), bundle, defaultConfig);
      // Still stated — a deployment must not be able to switch a heuristic OFF
      // by unsetting a variable, which is the over-correction hazard bug 12
      // warns about.
      expect(flags).toHaveLength(1);
      const f = flags[0]!;
      expect(f.severity).not.toBe('high');
      expect(f.severity).toBe('low');
      // And it must say WHOSE problem this is. A grader reading this must not
      // think a student did something.
      expect(f.detail!['unresolvedBy']).toBe('no_root_key');
      expect(f.description).toContain('root public key');
      expect(f.description).toMatch(/deployment/i);
    });

    it('separates "we could not check" from "we checked and it failed"', async () => {
      // An identity block that IS present and does NOT verify on a deployment
      // whose root key IS configured. Still `unknown` for THIS flag — a failed
      // block establishes nothing about who recorded either session — but the
      // resolution sentence is a different one, and that block is a finding in
      // its own right elsewhere.
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
      expect(resolved.rootKeyConfigured).toBe(true);
      expect(resolved.counts).toEqual({ attributed: 1, unverifiable: 1, unattributed: 0 });

      const flags = multipleSessionsOverlapHeuristic.run(buildIndex(bundle), bundle, defaultConfig);
      expect(flags).toHaveLength(1);
      const f = flags[0]!;
      expect(f.severity).toBe('low');
      expect(f.detail!['unresolvedBy']).toBe('identity_did_not_verify');
      // The no-root-key sentence must NOT appear here — the check DID run.
      expect(f.description).not.toContain('no root public key');
    });

    it('never names a person on an undecidable overlap (§6 Rule 2)', async () => {
      // One side verified as Alice, the other unattributed. The flag may say
      // what each side resolved to, but must not assert that Alice recorded
      // both — which is what a high-severity "one person recorded both" reads
      // as.
      const { index, bundle } = await overlappingPair({ studentRef: ALICE }, 'anonymous');
      const flags = multipleSessionsOverlapHeuristic.run(index, bundle, defaultConfig);
      expect(flags).toHaveLength(1);
      const f = flags[0]!;
      expect(f.severity).toBe('low');
      expect(f.description).toContain('not established');
      expect(f.detail!['unresolvedBy']).toBe('no_identity_block');
    });
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
