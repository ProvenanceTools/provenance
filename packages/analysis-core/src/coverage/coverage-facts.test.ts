/**
 * coverage-facts.test — the §5.4 step 5 coverage stage, and the guarantee that
 * it and `multiple_sessions_overlap` can never disagree about which overlapping
 * pairs were suppressed.
 *
 * The load-bearing suite here is "the partition". It is deliberately stronger
 * than the after-the-fact comparison it replaces: rather than driving one bundle
 * through two implementations and checking they agree, it asserts the property
 * that makes agreement structural — `judged` and `collaboration` come out of one
 * pass, they are disjoint, and together they are exactly the overlapping pairs.
 * The heuristic and the coverage stage are then checked to be faithful readers
 * of those two halves, which is a much smaller claim than "two copies of a
 * subtle rule still match".
 */

import { describe, it, expect } from 'vitest';
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
import { multipleSessionsOverlapHeuristic } from '../heuristics/multiple-sessions-overlap.js';
import { mergeConfig } from '../heuristics/config.js';
import type { Bundle } from '../loader/types.js';
import type { EventIndex } from '../index/event-index.js';
import {
  partitionSessionOverlaps,
  rangesOverlap,
  sessionRanges,
  overlapDurationMs,
} from './session-overlap.js';
import {
  concurrentRecordingFacts,
  coverageFacts,
  hasCoverageFacts,
  identityCoverage,
  unattestedTails,
} from './coverage-facts.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MS = new Date('2026-02-01T08:00:00.000Z').getTime();
const wallAt = (min: number) => new Date(BASE_MS + min * 60_000).toISOString();

const endsAt = (min: number) => ({
  kind: 'session.end',
  data: { reason: 'deactivate' },
  wall: wallAt(min),
  t: min * 60_000,
});

let cachedKeys: IdentityTestKeys | null = null;
async function keys(): Promise<IdentityTestKeys> {
  cachedKeys ??= await buildIdentityKeys();
  return cachedKeys;
}

type Who = { studentRef: string } | 'anonymous';

/**
 * A bundle whose sessions carry real verifiable identities AND explicit wall
 * ranges.
 *
 * `buildCollabScope` does the identity half but takes no walls, and overlap is a
 * wall-clock question, so this composes the same identity helpers with the wall
 * control the overlap fixtures need.
 */
async function buildScope(
  specs: Array<{ who: Who; startMin: number; endMin: number }>,
  opts: { stamp?: boolean; rootKey?: string } = {},
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const k = await keys();
  const sessions = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sk = await seededKeypair(0x70 + i);
    sessions.push({
      events: [endsAt(spec.endMin)],
      walls: [wallAt(spec.startMin)],
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
  if (!result.ok) throw new Error(`load failed: ${JSON.stringify(result.error)}`);
  const bundle = result.value;
  if (opts.stamp !== false) {
    await establishBundleContributors(bundle, opts.rootKey ?? k.root.pubkeyHex);
  }
  return { bundle, index: buildIndex(bundle) };
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Every overlapping pair, derived from ranges alone — no contributor input. */
function allOverlappingPairs(index: EventIndex): Set<string> {
  const ranges = sessionRanges(index);
  const out = new Set<string>();
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (rangesOverlap(ranges[i]!, ranges[j]!)) {
        out.add(pairKey(ranges[i]!.sessionId, ranges[j]!.sessionId));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The partition — the anti-drift guarantee
// ---------------------------------------------------------------------------

describe('partitionSessionOverlaps is a partition', () => {
  /**
   * Three contributors' worth of sessions, all overlapping, including two of
   * Alice's own: a mix of suppressed and judged pairs in one bundle, so neither
   * half of the assertion below is vacuous.
   */
  async function mixedScope() {
    return buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
      { who: { studentRef: 'alice' }, startMin: 90, endMin: 300 },
    ]);
  }

  it('splits the overlapping pairs into two disjoint, exhaustive halves', async () => {
    const { bundle, index } = await mixedScope();
    const { judged, collaboration } = partitionSessionOverlaps(bundle, index);

    const judgedKeys = new Set(judged.map((p) => pairKey(p.a.sessionId, p.b.sessionId)));
    const collabKeys = new Set(collaboration.map((p) => pairKey(p.a.sessionId, p.b.sessionId)));

    // Disjoint.
    for (const k of judgedKeys) expect(collabKeys.has(k)).toBe(false);
    // Exhaustive over the overlapping pairs, and nothing invented.
    expect(new Set([...judgedKeys, ...collabKeys])).toEqual(allOverlappingPairs(index));
    // Both sides exercised, or the assertions above prove nothing.
    expect(judgedKeys.size).toBeGreaterThan(0);
    expect(collabKeys.size).toBeGreaterThan(0);
    // No pair counted twice within a half.
    expect(judgedKeys.size).toBe(judged.length);
    expect(collabKeys.size).toBe(collaboration.length);
  });

  it('a suppressed pair is not representable as judged — both sides are attributed', async () => {
    const { bundle, index } = await mixedScope();
    const { judged, collaboration } = partitionSessionOverlaps(bundle, index);

    // The compiler already forbids `comparison: 'different'` on JudgedOverlap.
    // This pins the runtime value too, so a future widening of the type is a
    // failing test rather than a silent re-admission.
    for (const p of judged) expect(['same', 'unknown']).toContain(p.comparison);
    for (const p of collaboration) {
      expect(p.contributorA.kind).toBe('attributed');
      expect(p.contributorB.kind).toBe('attributed');
      expect(p.contributorA.contributorKey).not.toBe(p.contributorB.contributorKey);
    }
  });

  it('the heuristic flags the judged half and nothing else', async () => {
    const { bundle, index } = await mixedScope();
    const { judged, collaboration } = partitionSessionOverlaps(bundle, index);

    const fired = new Set(
      multipleSessionsOverlapHeuristic
        .run(index, bundle, mergeConfig())
        .map((f) => pairKey(String(f.detail!['sessionA']), String(f.detail!['sessionB']))),
    );
    expect(fired).toEqual(new Set(judged.map((p) => pairKey(p.a.sessionId, p.b.sessionId))));

    // And the coverage stage states exactly the other half.
    const surfaced = new Set(
      concurrentRecordingFacts(bundle, index).map((f) => pairKey(f.sessionA, f.sessionB)),
    );
    expect(surfaced).toEqual(
      new Set(collaboration.map((p) => pairKey(p.a.sessionId, p.b.sessionId))),
    );
    // Which together is still the whole overlap set, stated end to end.
    expect(new Set([...fired, ...surfaced])).toEqual(allOverlappingPairs(index));
    for (const k of fired) expect(surfaced.has(k)).toBe(false);
  });

  it('returns empty halves for a bundle with fewer than two sessions', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    expect(partitionSessionOverlaps(bundle, index)).toEqual({ judged: [], collaboration: [] });
  });
});

// ---------------------------------------------------------------------------
// The suppressed overlap is now a fact
// ---------------------------------------------------------------------------

describe('a suppressed concurrent overlap is surfaced as a fact', () => {
  it('reports two verified partners recording at the same time', async () => {
    // Alice 0..180min, Bob 60..240min → 120 minutes of genuine overlap.
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);

    const facts = concurrentRecordingFacts(bundle, index);
    expect(facts).toHaveLength(1);
    expect([facts[0]!.contributorA, facts[0]!.contributorB].sort()).toEqual(['alice', 'bob']);
    expect(facts[0]!.overlapMs).toBe(120 * 60_000);
    expect(facts[0]!.crashBounded).toBe(false);
  });

  it('is exactly the pair the flag suppresses — no flag, and now a fact', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);

    expect(multipleSessionsOverlapHeuristic.run(index, bundle, mergeConfig())).toHaveLength(0);
    expect(concurrentRecordingFacts(bundle, index)).toHaveLength(1);
  });

  it('does NOT surface a pair the flag still fires on', async () => {
    // One student, two overlapping sessions. The flag fires; this is not the
    // exculpatory fact and must not be presented as one.
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'alice' }, startMin: 60, endMin: 240 },
    ]);

    expect(multipleSessionsOverlapHeuristic.run(index, bundle, mergeConfig())).toHaveLength(1);
    expect(concurrentRecordingFacts(bundle, index)).toHaveLength(0);
  });

  it('never names an unattributed session as a concurrent partner', async () => {
    // Anonymous sessions compare `unknown`, never `different`. The flag keeps
    // firing (pre-3.2 behaviour) and no exculpatory fact may be manufactured —
    // "two people" is exactly what an unattributed session leaves unproven.
    const { bundle, index } = await buildScope([
      { who: 'anonymous', startMin: 0, endMin: 180 },
      { who: 'anonymous', startMin: 60, endMin: 240 },
    ]);

    expect(concurrentRecordingFacts(bundle, index)).toHaveLength(0);
    expect(multipleSessionsOverlapHeuristic.run(index, bundle, mergeConfig())).toHaveLength(1);
  });

  it('says so when a range was bounded by a crash rather than a session.end', async () => {
    const k = await keys();
    const sk = await seededKeypair(0x80);
    const sk2 = await seededKeypair(0x81);
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          // No session.end: bounded at its last recorded event.
          events: [
            {
              kind: 'doc.change',
              data: {
                path: 'f.py',
                deltas: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    text: 'x',
                  },
                ],
                source: 'typed',
              },
              wall: wallAt(180),
              t: 180 * 60_000,
            },
          ],
          walls: [wallAt(0)],
          sessionStart: {
            session_pubkey: sk.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: k,
              sessionPubkeyHex: sk.pubkeyHex,
              studentRef: 'alice',
            }),
          },
        },
        {
          events: [endsAt(240)],
          walls: [wallAt(60)],
          sessionStart: {
            session_pubkey: sk2.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: k,
              sessionPubkeyHex: sk2.pubkeyHex,
              studentRef: 'bob',
            }),
          },
        },
      ],
    });
    const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
    if (!result.ok) throw new Error('load failed');
    await establishBundleContributors(result.value, k.root.pubkeyHex);
    const index = buildIndex(result.value);

    const facts = concurrentRecordingFacts(result.value, index);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.crashBounded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

describe('sessionRanges', () => {
  it('bounds a crashed session at its last event, never at infinity', async () => {
    const { index } = await buildScope([{ who: 'anonymous', startMin: 0, endMin: 30 }]);
    const ranges = sessionRanges(index);
    expect(ranges).toHaveLength(1);
    expect(Number.isFinite(ranges[0]!.endWall)).toBe(true);
  });

  it('treats adjacent sessions as non-overlapping (strict <)', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 120 },
    ]);
    expect(concurrentRecordingFacts(bundle, index)).toHaveLength(0);
    const ranges = sessionRanges(index);
    expect(rangesOverlap(ranges[0]!, ranges[1]!)).toBe(false);
    expect(overlapDurationMs(ranges[0]!, ranges[1]!)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Root key: "not checked" is not "failed"
// ---------------------------------------------------------------------------

describe('a deployment with no root key', () => {
  it('reports rootKeyConfigured false, and that is a deployment fact', async () => {
    const { bundle } = await buildScope(
      [{ who: { studentRef: 'alice' }, startMin: 0, endMin: 60 }],
      { rootKey: '' },
    );
    const cov = identityCoverage(bundle.contributors ?? null);
    expect(cov.resolved).toBe(true);
    expect(cov.rootKeyConfigured).toBe(false);
    // The session HAD an identity block, so it is unverifiable — but for the
    // "could not check" reason, never for a failure.
    expect(cov.attributed).toBe(0);
    expect(cov.unverifiable).toBe(1);
  });

  it('distinguishes "resolution never ran" from "ran with no root key"', async () => {
    const { bundle } = await buildScope(
      [{ who: { studentRef: 'alice' }, startMin: 0, endMin: 60 }],
      { stamp: false },
    );
    const cov = identityCoverage(bundle.contributors ?? null);
    // Unstamped: we cannot say anything about the deployment's key at all.
    expect(cov.resolved).toBe(false);
  });

  it('attributes normally when the root key IS configured', async () => {
    const { bundle } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    const cov = identityCoverage(bundle.contributors ?? null);
    expect(cov.rootKeyConfigured).toBe(true);
    expect(cov.attributed).toBe(1);
    expect(cov.unverifiable).toBe(0);
  });

  it('counts a session with no identity block as unattributed, not unverifiable', async () => {
    const { bundle } = await buildScope([{ who: 'anonymous', startMin: 0, endMin: 60 }]);
    const cov = identityCoverage(bundle.contributors ?? null);
    expect(cov.unattributed).toBe(1);
    expect(cov.unverifiable).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Seal tails
// ---------------------------------------------------------------------------

describe('unattested seal tails', () => {
  it('reads absent rolling coverage as "classic, whole-file", not as "nothing sealed"', async () => {
    const { bundle } = await buildScope([{ who: 'anonymous', startMin: 0, endMin: 60 }]);
    expect(bundle.rollingSeal?.coverage).toBeUndefined();
    expect(unattestedTails(bundle)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

describe('coverageFacts', () => {
  it('a solo, fully attributed, classically sealed bundle has nothing to report', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    const facts = coverageFacts(bundle, index);
    expect(facts.concurrentRecording).toEqual([]);
    expect(facts.unattestedTails).toEqual([]);
    expect(facts.dagDefects).toEqual([]);
    expect(facts.droppedArtifacts).toEqual([]);
    expect(facts.repositoryAssumedSingle).toBe(false);
    expect(hasCoverageFacts(facts)).toBe(false);
  });

  it('has something to report as soon as two partners overlap', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    expect(hasCoverageFacts(coverageFacts(bundle, index))).toBe(true);
  });

  it('is deterministic — the same bundle twice gives the same facts', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
      { who: { studentRef: 'alice' }, startMin: 90, endMin: 300 },
    ]);
    expect(coverageFacts(bundle, index)).toEqual(coverageFacts(bundle, index));
  });
});
