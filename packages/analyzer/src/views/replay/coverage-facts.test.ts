/**
 * coverage-facts.test — the facts the panel states, and the guard that keeps
 * them agreeing with the flags.
 *
 * The load-bearing test in this file is "partitions the overlapping pairs
 * exactly": `concurrentRecordingFacts` re-derives session ranges that
 * `heuristics/multiple-sessions-overlap.ts` also derives, and a second copy of
 * subtle logic drifts. Driving one bundle through BOTH and asserting the fired
 * pairs and the surfaced pairs partition the overlaps makes a drift a failing
 * test rather than two panels quietly disagreeing in front of a grader.
 */

import { describe, it, expect } from 'vitest';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '@provenance/analysis-core/test-support/build-identity.js';
import type { IdentityTestKeys } from '@provenance/analysis-core/test-support/build-identity.js';
import { establishBundleContributors } from '@provenance/analysis-core/identity/resolve-contributors.js';
import { multipleSessionsOverlapHeuristic } from '@provenance/analysis-core/heuristics/multiple-sessions-overlap.js';
import { mergeConfig } from '@provenance/analysis-core/heuristics/config.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import {
  concurrentRecordingFacts,
  coverageFacts,
  formatDuration,
  hasCoverageFacts,
  identityCoverage,
  sessionRanges,
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
 * `buildCollabScope` in analysis-core does the identity half but takes no
 * walls, and overlap is a wall-clock question, so this composes the same
 * identity helpers with the wall control the overlap fixtures need.
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

// ---------------------------------------------------------------------------
// The suppressed overlap becomes a fact
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
    expect(formatDuration(facts[0]!.overlapMs)).toBe('2h 0m');
  });

  it('is exactly the pair the flag suppresses — no flag AND, before this, no fact', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);

    const flags = multipleSessionsOverlapHeuristic.run(index, bundle, mergeConfig());
    expect(flags).toHaveLength(0); // Tier 3.2: proven-different contributors.
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
    // Anonymous sessions are `unknown`, never `different`. The flag keeps
    // firing (pre-3.2 behaviour) and no exculpatory fact may be manufactured —
    // "two people" is exactly what an unattributed session leaves unproven.
    const { bundle, index } = await buildScope([
      { who: 'anonymous', startMin: 0, endMin: 180 },
      { who: 'anonymous', startMin: 60, endMin: 240 },
    ]);

    expect(concurrentRecordingFacts(bundle, index)).toHaveLength(0);
    expect(multipleSessionsOverlapHeuristic.run(index, bundle, mergeConfig()).length).toBe(1);
  });

  it('partitions the overlapping pairs exactly — the anti-drift guard', async () => {
    // Three contributors, all overlapping, plus one of Alice's own sessions
    // overlapping another: a mix of suppressed and fired pairs in one bundle.
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
      { who: { studentRef: 'alice' }, startMin: 90, endMin: 300 },
    ]);

    const ranges = sessionRanges(index);
    const allOverlapping = new Set<string>();
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const a = ranges[i]!;
        const b = ranges[j]!;
        if (a.startWall < b.endWall && b.startWall < a.endWall) {
          allOverlapping.add(pairKey(a.sessionId, b.sessionId));
        }
      }
    }

    const fired = new Set(
      multipleSessionsOverlapHeuristic
        .run(index, bundle, mergeConfig())
        .map((f) => pairKey(String(f.detail!['sessionA']), String(f.detail!['sessionB']))),
    );
    const surfaced = new Set(
      concurrentRecordingFacts(bundle, index).map((f) => pairKey(f.sessionA, f.sessionB)),
    );

    // Disjoint: a pair is either flagged or surfaced as collaboration, never both.
    for (const k of fired) expect(surfaced.has(k)).toBe(false);
    // Exhaustive: every overlap is accounted for by one of the two.
    expect(new Set([...fired, ...surfaced])).toEqual(allOverlapping);
    // And the fixture must actually exercise both sides, or this proves nothing.
    expect(fired.size).toBeGreaterThan(0);
    expect(surfaced.size).toBeGreaterThan(0);
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
// Session ranges
// ---------------------------------------------------------------------------

describe('sessionRanges mirrors the heuristic', () => {
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
  });
});

// ---------------------------------------------------------------------------
// Root key: "not checked" is not "failed"
// ---------------------------------------------------------------------------

describe('a deployment with no root key', () => {
  it('reports rootKeyConfigured false, and that is a deployment fact', async () => {
    const { bundle } = await buildScope(
      [{ who: { studentRef: 'alice' }, startMin: 0, endMin: 60 }],
      {
        rootKey: '',
      },
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
      {
        stamp: false,
      },
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
    expect(hasCoverageFacts(facts)).toBe(false);
  });

  it('has something to report as soon as two partners overlap', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'bob' }, startMin: 60, endMin: 240 },
    ]);
    expect(hasCoverageFacts(coverageFacts(bundle, index))).toBe(true);
  });
});

describe('formatDuration', () => {
  it('is coarse and readable', () => {
    expect(formatDuration(192 * 60_000)).toBe('3h 12m');
    expect(formatDuration(47 * 60_000)).toBe('47m');
    expect(formatDuration(12_000)).toBe('12s');
  });
});
