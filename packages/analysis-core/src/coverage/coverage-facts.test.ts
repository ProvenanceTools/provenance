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
import { sha256Hex } from '@provenance/log-core';
import type { Manifest, PeerObservedPayload } from '@provenance/log-core';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import type { EventSpec } from '../test-support/build-test-bundle.js';
import { buildCollabScope, collabGitEvent } from '../test-support/build-collab-scope.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '../test-support/build-identity.js';
import type { IdentityTestKeys } from '../test-support/build-identity.js';
import { establishBundleContributors } from '../identity/resolve-contributors.js';
import { multipleSessionsOverlapHeuristic } from '../heuristics/multiple-sessions-overlap.js';
import { mergeConfig } from '../heuristics/config.js';
import { establishBundleTrust } from '../manifest/bundle-manifest.js';
import {
  buildTrustChainKeys,
  buildManifest2,
  sessionStart2,
} from '../test-support/build-manifest-2.js';
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
  multiMachineRecordingFacts,
  unattestedTails,
} from './coverage-facts.js';
import type { CoverageFacts } from './coverage-facts.js';
import { ASSUMED_SINGLE_REPOSITORY, buildObservedDag } from '../git/observed-dag.js';

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

/**
 * A commit observation. `rootCommitSha` OMITTED models a recorder that names no
 * repository — every bundle recorded before D12's writer half, and every
 * shallow clone — and is what lands in `ASSUMED_SINGLE_REPOSITORY`.
 */
type CommitSpec = { sha: string; rootCommitSha?: string; atMin: number };

const commitAt = (c: CommitSpec) => ({
  kind: 'git.event',
  data: {
    operation: 'commit',
    sha: c.sha,
    parents: [],
    ...(c.rootCommitSha === undefined ? {} : { root_commit_sha: c.rootCommitSha }),
  },
  wall: wallAt(c.atMin),
  t: c.atMin * 60_000,
});

/** Readable stand-ins. Opaque to the reader, which only compares for equality. */
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const ROOT_ONE = '1'.repeat(40);
const ROOT_TWO = '2'.repeat(40);

let cachedKeys: IdentityTestKeys | null = null;
async function keys(): Promise<IdentityTestKeys> {
  cachedKeys ??= await buildIdentityKeys();
  return cachedKeys;
}

/**
 * A SECOND enrolled machine for the same deployment (D5). Same root, same
 * institution — only the student keypair differs, which is exactly what a
 * second independent enrolment produces.
 */
let cachedSecondMachine: IdentityTestKeys | null = null;
async function secondMachine(): Promise<IdentityTestKeys> {
  cachedSecondMachine ??= await buildIdentityKeys({ studentSeedByte: 0x56 });
  return cachedSecondMachine;
}

type Who = { studentRef: string; machine?: IdentityTestKeys } | 'anonymous';

/**
 * A bundle whose sessions carry real verifiable identities AND explicit wall
 * ranges.
 *
 * `buildCollabScope` does the identity half but takes no walls, and overlap is a
 * wall-clock question, so this composes the same identity helpers with the wall
 * control the overlap fixtures need.
 */
async function buildScope(
  specs: Array<{ who: Who; startMin: number; endMin: number; commits?: CommitSpec[] }>,
  opts: { stamp?: boolean; rootKey?: string } = {},
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const k = await keys();
  const sessions = [];
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    const sk = await seededKeypair(0x70 + i);
    sessions.push({
      events: [...(spec.commits ?? []).map(commitAt), endsAt(spec.endMin)],
      walls: [wallAt(spec.startMin)],
      sessionStart: {
        session_pubkey: sk.pubkeyHex,
        ...(spec.who === 'anonymous'
          ? {}
          : {
              identity: await buildInstitutionIdentity({
                keys: spec.who.machine ?? k,
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
      // Alice's SECOND enrolled machine, overlapping both of her own sessions
      // and Bob's — so all three arms of the partition are populated and none
      // of the assertions below is vacuous.
      {
        who: { studentRef: 'alice', machine: await secondMachine() },
        startMin: 120,
        endMin: 360,
      },
    ]);
  }

  it('splits the overlapping pairs into three disjoint, exhaustive parts', async () => {
    const { bundle, index } = await mixedScope();
    const { judged, collaboration, multiMachine } = partitionSessionOverlaps(bundle, index);

    const judgedKeys = new Set(judged.map((p) => pairKey(p.a.sessionId, p.b.sessionId)));
    const collabKeys = new Set(collaboration.map((p) => pairKey(p.a.sessionId, p.b.sessionId)));
    const machineKeys = new Set(multiMachine.map((p) => pairKey(p.a.sessionId, p.b.sessionId)));

    // Pairwise disjoint.
    for (const k of judgedKeys) expect(collabKeys.has(k)).toBe(false);
    for (const k of judgedKeys) expect(machineKeys.has(k)).toBe(false);
    for (const k of collabKeys) expect(machineKeys.has(k)).toBe(false);
    // Exhaustive over the overlapping pairs, and nothing invented.
    expect(new Set([...judgedKeys, ...collabKeys, ...machineKeys])).toEqual(
      allOverlappingPairs(index),
    );
    // Every arm exercised, or the assertions above prove nothing.
    expect(judgedKeys.size).toBeGreaterThan(0);
    expect(collabKeys.size).toBeGreaterThan(0);
    expect(machineKeys.size).toBeGreaterThan(0);
    // No pair counted twice within an arm.
    expect(judgedKeys.size).toBe(judged.length);
    expect(collabKeys.size).toBe(collaboration.length);
    expect(machineKeys.size).toBe(multiMachine.length);
  });

  it('a suppressed pair is not representable as judged — both sides are attributed', async () => {
    const { bundle, index } = await mixedScope();
    const { judged, collaboration, multiMachine } = partitionSessionOverlaps(bundle, index);

    // The compiler already forbids `comparison: 'different'` on JudgedOverlap.
    // This pins the runtime value too, so a future widening of the type is a
    // failing test rather than a silent re-admission.
    for (const p of judged) expect(['same_machine', 'unknown']).toContain(p.comparison);
    for (const p of collaboration) {
      expect(p.contributorA.kind).toBe('attributed');
      expect(p.contributorB.kind).toBe('attributed');
      expect(p.contributorA.contributorKey).not.toBe(p.contributorB.contributorKey);
    }
    // Same guarantee on the two-machine arm: a suppression may never rest on
    // an unproven relationship, so both sides must be attributed there too.
    for (const p of multiMachine) {
      expect(p.contributorA.kind).toBe('attributed');
      expect(p.contributorB.kind).toBe('attributed');
    }
  });

  it('the two-machine arm is one person on proven-distinct machines — never two people', async () => {
    const { bundle, index } = await mixedScope();
    const { multiMachine } = partitionSessionOverlaps(bundle, index);

    expect(multiMachine.length).toBeGreaterThan(0);
    for (const p of multiMachine) {
      // Both sides verified — the suppression rests on PROOF, never on an
      // unproven relationship.
      expect(p.contributorA.kind).toBe('attributed');
      expect(p.contributorB.kind).toBe('attributed');
      // One person...
      expect(p.contributorA.contributorKey).toBe(p.contributorB.contributorKey);
      expect(p.studentRef).toBe('alice');
      // ...two machines.
      expect(p.studentPubkeyA).not.toBe(p.studentPubkeyB);
      expect(p.contributorA.studentPubkey).not.toBe(p.contributorB.studentPubkey);
    }
  });

  it('a same-machine overlap and a two-machine overlap are DIFFERENT facts', async () => {
    // Alice's two sessions on ONE machine are judged; Alice's session against
    // her SECOND machine is not. Collapsing the two either loses the clock
    // manipulation signal or accuses a supported flow.
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'alice' }, startMin: 30, endMin: 120 },
      { who: { studentRef: 'alice', machine: await secondMachine() }, startMin: 60, endMin: 240 },
    ]);
    const { judged, multiMachine } = partitionSessionOverlaps(bundle, index);

    // Sessions 0 and 1 are one machine — judged, at full strength.
    expect(judged).toHaveLength(1);
    expect(judged[0]!.comparison).toBe('same_machine');
    // Sessions 0-2 and 1-2 cross the machine boundary — suppressed.
    expect(multiMachine).toHaveLength(2);
  });

  it('the heuristic flags the judged part and nothing else', async () => {
    const { bundle, index } = await mixedScope();
    const { judged, collaboration, multiMachine } = partitionSessionOverlaps(bundle, index);

    const fired = new Set(
      multipleSessionsOverlapHeuristic
        .run(index, bundle, mergeConfig())
        .map((f) => pairKey(String(f.detail!['sessionA']), String(f.detail!['sessionB']))),
    );
    expect(fired).toEqual(new Set(judged.map((p) => pairKey(p.a.sessionId, p.b.sessionId))));

    // And the coverage stage states exactly the other two parts — every
    // suppressed pair is a stated fact, never silence.
    const surfaced = new Set(
      concurrentRecordingFacts(bundle, index).map((f) => pairKey(f.sessionA, f.sessionB)),
    );
    expect(surfaced).toEqual(
      new Set(collaboration.map((p) => pairKey(p.a.sessionId, p.b.sessionId))),
    );
    const machineSurfaced = new Set(
      multiMachineRecordingFacts(bundle, index).map((f) => pairKey(f.sessionA, f.sessionB)),
    );
    expect(machineSurfaced).toEqual(
      new Set(multiMachine.map((p) => pairKey(p.a.sessionId, p.b.sessionId))),
    );
    // Which together is still the whole overlap set, stated end to end.
    expect(new Set([...fired, ...surfaced, ...machineSurfaced])).toEqual(
      allOverlappingPairs(index),
    );
    for (const k of fired) {
      expect(surfaced.has(k)).toBe(false);
      expect(machineSurfaced.has(k)).toBe(false);
    }
  });

  it('returns empty parts for a bundle with fewer than two sessions', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    expect(partitionSessionOverlaps(bundle, index)).toEqual({
      judged: [],
      collaboration: [],
      multiMachine: [],
    });
  });
});

// ---------------------------------------------------------------------------
// The suppressed overlap is now a fact
// ---------------------------------------------------------------------------

describe('a suppressed two-machine overlap is surfaced as a fact', () => {
  it('reports one verified student recording on two enrolled machines', async () => {
    // Alice's machine 1 runs 0..180min, her machine 2 runs 60..240min → 120
    // minutes of genuine overlap. Suppressed as a finding, STATED as a fact —
    // the whole reason the coverage stage exists is that a suppressed pair
    // used to produce no flag and no fact at all.
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'alice', machine: await secondMachine() }, startMin: 60, endMin: 240 },
    ]);

    const facts = multiMachineRecordingFacts(bundle, index);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.studentRef).toBe('alice');
    expect(facts[0]!.overlapMs).toBe(120 * 60_000);
    expect(facts[0]!.crashBounded).toBe(false);

    // And the heuristic says nothing about it.
    expect(multipleSessionsOverlapHeuristic.run(index, bundle, mergeConfig())).toEqual([]);

    // It is a separate fact from concurrent PARTNER recording. Collapsing the
    // two would tell a grader that two different people were working together
    // when one person was moving between their own machines.
    expect(concurrentRecordingFacts(bundle, index)).toEqual([]);
  });

  it('is included in the aggregate, so a bundle carrying only this fact is not "nothing to note"', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 180 },
      { who: { studentRef: 'alice', machine: await secondMachine() }, startMin: 60, endMin: 240 },
    ]);
    const facts = coverageFacts(bundle, index);
    expect(facts.multiMachineRecording).toHaveLength(1);
    expect(hasCoverageFacts(facts)).toBe(true);
  });
});

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
// The single-repository caveat (D12)
// ---------------------------------------------------------------------------

/**
 * `repositoryAssumedSingle` answers "is any part of this graph folded into the
 * sentinel repository?" — NOT "did nothing name a repository?".
 *
 * The two agree everywhere except a `'mixed'` scope, which is the whole point of
 * this suite. Mixed is reachable in production as of 2026-08-20: all three
 * recorders emit `root_commit_sha`, so one partner on a newer recorder — or on a
 * shallow clone, where the writer contract says OMIT — puts labelled and
 * unlabelled observations in one scope. There `discriminatorRecorded` is true
 * while the unlabelled half really is merged, so the old `!discriminatorRecorded`
 * form went silent on exactly the scope the caveat exists for.
 *
 * Every assertion below guards its premise by naming the scope `kind`, because a
 * test that believes it drives a mixed scope and actually drives an
 * `assumed_single` one proves nothing about the predicate.
 */
describe('the assumed-single-repository caveat', () => {
  it('states the caveat when nothing named a repository — every bundle to date', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        commits: [{ sha: SHA_A, atMin: 10 }],
      },
    ]);
    const scope = buildObservedDag(bundle).repositoryScope;
    expect(scope.kind).toBe('assumed_single');
    expect(scope.repositories).toEqual([ASSUMED_SINGLE_REPOSITORY]);

    expect(coverageFacts(bundle, index).repositoryAssumedSingle).toBe(true);
  });

  it('STILL states the caveat in a mixed scope, where only one partner labels', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        commits: [{ sha: SHA_A, rootCommitSha: ROOT_ONE, atMin: 10 }],
      },
      {
        who: { studentRef: 'bob' },
        startMin: 120,
        endMin: 180,
        commits: [{ sha: SHA_B, atMin: 130 }],
      },
    ]);
    // The premise, guarded: a genuinely MIXED scope. `discriminatorRecorded` is
    // TRUE here, so the old `!discriminatorRecorded` predicate reports `false`
    // and the caveat disappears — while Bob's commit is folded into the
    // sentinel exactly as it always was.
    const scope = buildObservedDag(bundle).repositoryScope;
    expect(scope.kind).toBe('mixed');
    expect(scope.discriminatorRecorded).toBe(true);
    expect(scope.repositories).toContain(ASSUMED_SINGLE_REPOSITORY);

    expect(coverageFacts(bundle, index).repositoryAssumedSingle).toBe(true);
  });

  it('drops the caveat when every observation named its repository', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        commits: [
          { sha: SHA_A, rootCommitSha: ROOT_ONE, atMin: 10 },
          { sha: SHA_B, rootCommitSha: ROOT_TWO, atMin: 20 },
        ],
      },
    ]);
    const scope = buildObservedDag(bundle).repositoryScope;
    expect(scope.kind).toBe('discriminated');
    expect(scope.repositories).not.toContain(ASSUMED_SINGLE_REPOSITORY);

    // Two repositories, both named: nothing is merged, so there is nothing to
    // caveat. Two is not a finding either — see observed-dag's header.
    expect(scope.repositories).toHaveLength(2);
    expect(coverageFacts(bundle, index).repositoryAssumedSingle).toBe(false);
  });

  it('says nothing about a scope that observed no commits at all', async () => {
    const { bundle, index } = await buildScope([
      { who: { studentRef: 'alice' }, startMin: 0, endMin: 60 },
    ]);
    // This is what the old `commits > 0` guard was for, and sentinel membership
    // subsumes it: the sentinel only enters `repositories` when a node keyed to
    // it exists, so an empty graph carries no caveat rather than one about a
    // graph that is not there.
    const dag = buildObservedDag(bundle);
    expect(dag.coverage.commits).toBe(0);
    expect(dag.repositoryScope.repositories).toEqual([]);

    expect(coverageFacts(bundle, index).repositoryAssumedSingle).toBe(false);
  });

  it('is never a defect — the caveat brings no dagDefect and no dropped artifact', async () => {
    const { bundle, index } = await buildScope([
      {
        who: { studentRef: 'alice' },
        startMin: 0,
        endMin: 60,
        commits: [{ sha: SHA_A, atMin: 10 }],
      },
    ]);
    const facts = coverageFacts(bundle, index);
    expect(facts.repositoryAssumedSingle).toBe(true);
    expect(facts.dagDefects).toEqual([]);
    expect(facts.droppedArtifacts).toEqual([]);
    expect(facts.dagCoverage.gitEventsWithUnreadableRepository).toBe(0);
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

// ---------------------------------------------------------------------------
// §5.6 — peer witnessing and git observability, as coverage FACTS
// ---------------------------------------------------------------------------

/**
 * These two blocks are the production caller for `reconcileWitnesses` and for
 * `gitImpossibleReason` / `gitObservationGap`, all three of which shipped with
 * no caller at all.
 *
 * What they are protecting is one rule stated twice: **"nobody reported" is a
 * third answer, and it is the answer for every bundle in the archive.** If the
 * unreported state ever tips `hasCoverageFacts`, every submission recorded
 * before §5.6 leaves "nothing to note" on the strength of a field its recorder
 * never had — the same class of error as reading absence of a witness as
 * absence of a log.
 */

const DOC_CHANGE = {
  path: 'hw1.py',
  deltas: [{ range: null, text: 'x = 1\n' }],
  source: 'keystroke',
};

/**
 * Two sessions where the second witnesses the first, built in two passes: once
 * to learn the witnessed chain's real tip, then again with a witness naming it.
 *
 * `buildCollabScope` derives session ids and keys from the session INDEX, so
 * the witnessed session reproduces exactly as long as it keeps index 0. With
 * `omitWitnessed` the witness names an id one index PAST the end, which is what
 * makes the witnessed log genuinely missing rather than merely different.
 */
async function witnessedScope(
  opts: {
    state?: PeerObservedPayload['state'];
    omitWitnessed?: boolean;
    repeats?: number;
  } = {},
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const witnessedIndex = opts.omitWitnessed === true ? 2 : 0;
  const work: EventSpec[] = [{ kind: 'doc.change', data: DOC_CHANGE }];

  const probe = await buildCollabScope(
    Array.from({ length: witnessedIndex + 1 }, () => ({
      who: { studentRef: 'bob' } as const,
      events: work,
    })),
  );
  const witnessed = probe.bundle.sessions[witnessedIndex]!;
  const tip = witnessed.events[witnessed.events.length - 1]!;

  const payload: PeerObservedPayload = {
    file: 'session-0badf00d-0000-4000-8000-00000000beef.slog',
    // Deliberately NOT the archived digest: a witness sees a PREFIX, so
    // inequality here is the normal case.
    sha256: sha256Hex('bytes as seen at observation time'),
    bytes: 2048,
    session_id: witnessed.sessionId,
    seq_high: tip.seq,
    last_hash: tip.hash,
    state: opts.state ?? 'appeared',
  };

  const witnessEvents: EventSpec[] = Array.from({ length: opts.repeats ?? 1 }, () => ({
    kind: 'peer.observed',
    data: { ...payload },
  }));

  const built = await buildCollabScope([
    { who: { studentRef: 'bob' }, events: work },
    { who: { studentRef: 'alice' }, events: witnessEvents },
  ]);
  if (opts.omitWitnessed === true) {
    // Load-bearing: were the witnessed id present after all, the `absent`
    // assertions would be testing something else entirely.
    expect(built.bundle.sessions.map((s) => s.sessionId)).not.toContain(witnessed.sessionId);
  }
  return built;
}

/** A bundle + index whose sessions carry exactly the given `session.start` extras. */
async function capabilityScope(
  ...sessionStarts: Array<Record<string, unknown>>
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const { zipBuffer } = await buildTestBundle({
    sessions: sessionStarts.map((sessionStart) => ({ eventCount: 2, sessionStart })),
  });
  const result = await loadBundle(zipBuffer, 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  const bundle = result.value;
  return { bundle, index: buildIndex(bundle) };
}

describe('an unreported §5.6 capability never makes the panel speak', () => {
  it('a clean solo bundle whose recorder predates §5.6 still reports "nothing to note"', async () => {
    // THE LOAD-BEARING TEST. Every submission in the archive is in exactly this
    // state: `capability`/`availability` unknown and every log unwitnessed. If
    // any of that tipped `hasCoverageFacts`, the whole archive would grow a
    // coverage panel on the strength of a field its recorder never had — and a
    // panel that appears is read as a panel that found something.
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: 'alice' }, events: [{ kind: 'doc.change', data: DOC_CHANGE }] },
    ]);
    const facts = coverageFacts(bundle, index);

    expect(facts.witnessing.capability).toBe('unknown');
    expect(facts.witnessing.unwitnessedSessions).toBe(1);
    expect(facts.gitObservation.availability).toBe('unknown');
    expect(facts.gitObservation.silentAndUnreported).toBe(1);
    expect(hasCoverageFacts(facts)).toBe(false);
  });

  it('but a capability that WAS reported does, in either direction', async () => {
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: 'alice' }, events: [{ kind: 'doc.change', data: DOC_CHANGE }] },
    ]);
    const base = coverageFacts(bundle, index);

    expect(
      hasCoverageFacts({
        ...base,
        gitObservation: { ...base.gitObservation, availability: 'available' },
      }),
    ).toBe(true);
    expect(
      hasCoverageFacts({
        ...base,
        witnessing: { ...base.witnessing, capability: 'impossible' },
      }),
    ).toBe(true);
    // …and an unwitnessed log on its own still does NOT.
    expect(
      hasCoverageFacts({
        ...base,
        witnessing: { ...base.witnessing, unwitnessedSessions: 99 },
      }),
    ).toBe(false);
  });
});

describe('git observability is a coverage fact, not a finding', () => {
  it('a recorder that reports nothing reads UNKNOWN, and does not make the panel speak', async () => {
    // EVERY bundle recorded before §5.6. `{}` is production, not a fixture.
    const { bundle, index } = await capabilityScope({}, {});
    const facts = coverageFacts(bundle, index);

    expect(facts.gitObservation.availability).toBe('unknown');
    expect(facts.gitObservation.impossibleReason).toBeNull();
    expect(facts.gitObservation.silentAndUnreported).toBe(2);
    expect(facts.gitObservation.silentAndIncapable).toBe(0);
    expect(facts.gitObservation.silentThoughCapable).toBe(0);
  });

  it('every session reporting `unavailable` reads impossible/unavailable', async () => {
    const { bundle, index } = await capabilityScope(
      { git_capture: 'unavailable' },
      { git_capture: 'unavailable' },
    );
    const facts = coverageFacts(bundle, index);

    expect(facts.gitObservation.availability).toBe('impossible');
    expect(facts.gitObservation.impossibleReason).toBe('unavailable');
    expect(facts.gitObservation.silentAndIncapable).toBe(2);
    // A report existed, so the panel now has something true to say.
    expect(hasCoverageFacts(facts)).toBe(true);
  });

  it('every session reporting `not_owned` reads impossible/not_owned — a DIFFERENT fact', async () => {
    const { bundle, index } = await capabilityScope(
      { git_capture: 'not_owned' },
      { git_capture: 'not_owned' },
    );
    const facts = coverageFacts(bundle, index);

    expect(facts.gitObservation.availability).toBe('impossible');
    // Collapsing this onto `unavailable` is what §5.6 item 2 exists to prevent:
    // one says the machine had no git, the other says git worked and the
    // assignment sat outside every repository it could see.
    expect(facts.gitObservation.impossibleReason).toBe('not_owned');
  });

  it('a mixed incapacity is reported as mixed, not as either half', async () => {
    const { bundle, index } = await capabilityScope(
      { git_capture: 'unavailable' },
      { git_capture: 'not_owned' },
    );
    expect(coverageFacts(bundle, index).gitObservation.impossibleReason).toBe('mixed');
  });

  it('one unreported session takes the answer to unknown — never to impossible', async () => {
    // Fail toward not knowing: the silent session might have been the capable
    // one, and a bundle is a set of machines.
    const { bundle, index } = await capabilityScope({ git_capture: 'unavailable' }, {});
    const facts = coverageFacts(bundle, index);

    expect(facts.gitObservation.availability).toBe('unknown');
    expect(facts.gitObservation.impossibleReason).toBeNull();
    expect(facts.gitObservation.silentAndIncapable).toBe(1);
    expect(facts.gitObservation.silentAndUnreported).toBe(1);
  });

  it('git available and no commits is a statement about git ACTIVITY, and is not a defect', async () => {
    const { bundle, index } = await capabilityScope({ git_capture: 'available' });
    const facts = coverageFacts(bundle, index);

    expect(facts.gitObservation.availability).toBe('available');
    expect(facts.gitObservation.silentThoughCapable).toBe(1);
    expect(facts.gitObservation.observing).toBe(0);
    // Nothing about this is a flag, a check, or a score.
    expect(facts.gitObservation.impossibleReason).toBeNull();
  });

  it('an undefined git_capture value is malformed — a recorder fact, never a student fact', async () => {
    const { bundle, index } = await capabilityScope({ git_capture: 'sort-of' });
    const facts = coverageFacts(bundle, index);

    expect(facts.gitObservation.malformed).toBe(1);
    // Malformed is not `unavailable`: nothing was established about capture.
    expect(facts.gitObservation.availability).toBe('unknown');
    expect(facts.gitObservation.silentAndUnreported).toBe(1);
  });

  it('counts observing sessions from the DAG it is a caveat on', async () => {
    const { bundle, index } = await buildCollabScope([
      { who: { studentRef: 'alice' }, events: [collabGitEvent('a'.repeat(40), [])] },
      { who: { studentRef: 'bob' }, events: [{ kind: 'doc.change', data: DOC_CHANGE }] },
    ]);
    const facts = coverageFacts(bundle, index);

    expect(facts.gitObservation.observing).toBe(1);
    expect(facts.gitObservation.observing).toBe(facts.dagCoverage.sessionsObserving);
    expect(facts.gitObservation.sessions).toBe(2);
  });
});

describe('peer witnessing is a coverage fact, not a finding', () => {
  it('a bundle with no witnesses says nothing and stays "nothing to note"', async () => {
    const { bundle, index } = await capabilityScope({}, {});
    const facts = coverageFacts(bundle, index);

    expect(facts.witnessing.capability).toBe('unknown');
    expect(facts.witnessing.sessions).toBe(2);
    // Unwitnessed is the ORDINARY state of every log ever recorded. It is
    // reported, and it deliberately does not make the panel speak.
    expect(facts.witnessing.unwitnessedSessions).toBe(2);
    expect(facts.witnessing.witnessedSessions).toBe(0);
    expect(facts.witnessing.discrepancies).toEqual([]);
  });

  it('a witnessing capability report alone is enough to have something to state', async () => {
    const { bundle, index } = await capabilityScope(
      { witness_capture: 'unavailable' },
      { witness_capture: 'unavailable' },
    );
    const facts = coverageFacts(bundle, index);

    expect(facts.witnessing.capability).toBe('impossible');
    expect(hasCoverageFacts(facts)).toBe(true);
  });

  it('a corroborated witness is counted, and never becomes a discrepancy row', async () => {
    const { bundle, index } = await witnessedScope();
    const facts = coverageFacts(bundle, index);

    expect(facts.witnessing.corroborated).toBe(1);
    expect(facts.witnessing.discrepancies).toEqual([]);
    expect(facts.witnessing.witnessedSessions).toBe(1);
    expect(facts.witnessing.unwitnessedSessions).toBe(1);
  });

  it('a `disappeared` observation is carried DESCRIPTIVELY and does not change the verdict', async () => {
    // The trap: `disappeared` is what a branch checkout and a stash both look
    // like. It must never promote a verdict or produce a finding.
    const { bundle, index } = await witnessedScope({ state: 'disappeared' });
    const facts = coverageFacts(bundle, index);

    expect(facts.witnessing.corroborated).toBe(1);
    expect(facts.witnessing.discrepancies).toEqual([]);
  });

  it('an absent witnessed log is a discrepancy row that carries no name', async () => {
    const { bundle, index } = await witnessedScope({ omitWitnessed: true, state: 'disappeared' });
    const facts = coverageFacts(bundle, index);

    expect(facts.witnessing.discrepancies).toHaveLength(1);
    const d = facts.witnessing.discrepancies[0]!;
    expect(d.verdict).toBe('absent');
    expect(d.states).toEqual(['disappeared']);
    // The detail is `reconcile-witnesses`'s own wording, carried verbatim so a
    // second surface cannot rephrase a five-way verdict.
    expect(d.detail).toContain('NOT established as a deletion');
    // A witness shows that a LOG was in a state, never who put it there.
    expect(Object.keys(d).sort()).toEqual([
      'authority',
      'detail',
      'file',
      'observations',
      'states',
      'verdict',
      'witnessedSessionId',
    ]);
  });

  it('repeats of one observation collapse to one row with a count', async () => {
    // `peer.observed` fires on the checkpoint cadence, so an absent partner log
    // produces one witness per drain. Hundreds of identical rows saying one
    // thing is both a wire-size problem and a reading problem.
    const { bundle, index } = await witnessedScope({ omitWitnessed: true, repeats: 4 });
    const facts = coverageFacts(bundle, index);

    expect(facts.witnessing.discrepancies).toHaveLength(1);
    expect(facts.witnessing.discrepancies[0]!.observations).toBe(4);
  });

  it('is deterministic over a bundle carrying witnesses', async () => {
    const { bundle, index } = await witnessedScope({ omitWitnessed: true, repeats: 3 });
    expect(coverageFacts(bundle, index)).toEqual(coverageFacts(bundle, index));
  });
});

// ---------------------------------------------------------------------------
// File scope (§5.6 item 1)
// ---------------------------------------------------------------------------

/**
 * A bundle whose manifest puts `files` under review and whose sessions carry
 * exactly the given `session.start` extras.
 *
 * `activity` names the paths the first session edits, which is what separates
 * "this file was silent" from "this file was busy" — the whole point of asking
 * whether a SILENT file was being watched at all.
 */
async function fileScopeScope(opts: {
  files: string[];
  sessionStarts: Array<Record<string, unknown>>;
  activity?: string[];
}): Promise<{ bundle: Bundle; index: EventIndex }> {
  const { zipBuffer } = await buildTestBundle({
    submissionFiles: opts.files.map((path) => ({
      path,
      status: 'present' as const,
      content: `# ${path}\n`,
    })),
    sessions: opts.sessionStarts.map((sessionStart, i) => ({
      sessionStart,
      events:
        i === 0
          ? (opts.activity ?? []).map((path) => ({
              kind: 'doc.change',
              data: { path, deltas: [{ range: null, text: 'x = 1\n' }], source: 'keystroke' },
            }))
          : [],
    })),
  });
  const result = await loadBundle(zipBuffer, 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  const bundle = result.value;
  return { bundle, index: buildIndex(bundle) };
}

/**
 * `fileScopeScope` never resolves contributors, so its bundles report
 * `rootKeyConfigured: false`, which tips `hasCoverageFacts` on its own. Neutral
 * identity isolates the ONE question these assertions are about: does a file
 * scope, or its absence, make the panel speak?
 */
function withNeutralIdentity(facts: CoverageFacts): CoverageFacts {
  return {
    ...facts,
    identity: { ...facts.identity, resolved: true, rootKeyConfigured: true },
  };
}

describe('file scope is a coverage fact, not a finding', () => {
  it('a recorder that reports nothing reads UNREPORTED, every file UNKNOWN, and stays silent', async () => {
    // EVERY bundle recorded before §5.6, permanently. If this ever reads as
    // `not_watched`, the whole archive starts asserting that files nobody could
    // prove were watched were provably not watched.
    const { bundle, index } = await fileScopeScope({
      files: ['hw1.py', 'util.py'],
      sessionStarts: [{}],
    });
    const facts = coverageFacts(bundle, index);

    expect(facts.fileScope.reporting).toBe('unreported');
    expect(facts.fileScope.unreportedSessions).toBe(1);
    expect(facts.fileScope.watchedFiles).toEqual([]);
    expect(facts.fileScope.files.map((f) => f.watched)).toEqual(['unknown', 'unknown']);
    // An absent report is a fact about a release date, never about a submission.
    expect(hasCoverageFacts(withNeutralIdentity(facts))).toBe(false);
  });

  it('a complete scope answers WATCHED for what it names and NOT_WATCHED for what it does not', async () => {
    const { bundle, index } = await fileScopeScope({
      files: ['hw1.py', 'provided.py'],
      sessionStarts: [{ file_scope: { watched: ['hw1.py'], complete: true } }],
    });
    const facts = coverageFacts(bundle, index);

    expect(facts.fileScope.reporting).toBe('reported');
    expect(facts.fileScope.reportedSessions).toBe(1);
    expect(facts.fileScope.incompleteSessions).toBe(0);
    expect(facts.fileScope.watchedFiles).toEqual(['hw1.py']);
    expect(facts.fileScope.files).toEqual([
      { path: 'hw1.py', watched: 'watched', recordedActivity: false, notWatchedReason: null },
      {
        path: 'provided.py',
        watched: 'not_watched',
        recordedActivity: false,
        // Tier 2 answered, so there is no trusted scope to derive a reason
        // from — inventing one would be a claim the record cannot support.
        notWatchedReason: null,
      },
    ]);
    // A report existed, so there is now something true to say.
    expect(hasCoverageFacts(withNeutralIdentity(facts))).toBe(true);
  });

  it('a TRUNCATED list can prove watched and can never prove not_watched', async () => {
    // The asymmetry is the whole reason `complete` is a required boolean: a path
    // missing from a capped list may be in the part that was cut.
    const { bundle, index } = await fileScopeScope({
      files: ['hw1.py', 'provided.py'],
      sessionStarts: [{ file_scope: { watched: ['hw1.py'], complete: false } }],
    });
    const facts = coverageFacts(bundle, index);

    expect(facts.fileScope.reporting).toBe('reported');
    expect(facts.fileScope.incompleteSessions).toBe(1);
    expect(facts.fileScope.files.map((f) => f.watched)).toEqual(['watched', 'unknown']);
  });

  it('one silent session takes every unnamed file to UNKNOWN — never to not_watched', async () => {
    // Fail toward not knowing: the session that said nothing may have been the
    // one watching the file.
    const { bundle, index } = await fileScopeScope({
      files: ['hw1.py', 'provided.py'],
      sessionStarts: [{ file_scope: { watched: ['hw1.py'], complete: true } }, {}],
    });
    const facts = coverageFacts(bundle, index);

    expect(facts.fileScope.reporting).toBe('partial');
    expect(facts.fileScope.reportedSessions).toBe(1);
    expect(facts.fileScope.unreportedSessions).toBe(1);
    expect(facts.fileScope.files.map((f) => f.watched)).toEqual(['watched', 'unknown']);
  });

  it('an EMPTY complete scope is a real answer, not an absent one', async () => {
    const { bundle, index } = await fileScopeScope({
      files: ['hw1.py'],
      sessionStarts: [{ file_scope: { watched: [], complete: true } }],
    });
    const facts = coverageFacts(bundle, index);

    expect(facts.fileScope.reporting).toBe('reported');
    expect(facts.fileScope.files[0]!.watched).toBe('not_watched');
  });

  it('records whether a file has activity, so a busy file is never called silent', async () => {
    const { bundle, index } = await fileScopeScope({
      files: ['hw1.py', 'provided.py'],
      sessionStarts: [{ file_scope: { watched: ['hw1.py'], complete: true } }],
      activity: ['hw1.py'],
    });
    const facts = coverageFacts(bundle, index);

    expect(facts.fileScope.files).toEqual([
      { path: 'hw1.py', watched: 'watched', recordedActivity: true, notWatchedReason: null },
      {
        path: 'provided.py',
        watched: 'not_watched',
        recordedActivity: false,
        notWatchedReason: null,
      },
    ]);
  });

  it('a malformed scope is rejected whole and named by problem, never by path', async () => {
    const { bundle, index } = await fileScopeScope({
      files: ['hw1.py'],
      sessionStarts: [{ file_scope: { watched: ['/Users/someone/hw1.py'], complete: true } }],
    });
    const facts = coverageFacts(bundle, index);

    expect(facts.fileScope.malformedSessions).toBe(1);
    expect(facts.fileScope.reportedSessions).toBe(0);
    expect(facts.fileScope.malformedProblems).toEqual(['path_absolute']);
    // Rejected WHOLE: the offending path never reaches the fact, and the file it
    // could not answer for stays unknown rather than becoming not_watched.
    expect(facts.fileScope.watchedFiles).toEqual([]);
    expect(facts.fileScope.files[0]!.watched).toBe('unknown');
    // Something reported, unreadably. That is still a report.
    expect(facts.fileScope.reporting).toBe('partial');
  });

  it('a legacy 1.0 bundle has no file set to ask about, which is not a negative answer', async () => {
    const { bundle, index } = await capabilityScope({
      file_scope: { watched: ['hw1.py'], complete: true },
    });
    const facts = coverageFacts(bundle, index);

    expect(bundle.manifest.submission_files).toBeUndefined();
    expect(facts.fileScope.files).toEqual([]);
    expect(facts.fileScope.watchedFiles).toEqual(['hw1.py']);
  });

  it('is deterministic', async () => {
    const { bundle, index } = await fileScopeScope({
      files: ['hw1.py', 'provided.py'],
      sessionStarts: [{ file_scope: { watched: ['hw1.py'], complete: true } }, {}],
    });
    expect(coverageFacts(bundle, index)).toEqual(coverageFacts(bundle, index));
  });
});

// ---------------------------------------------------------------------------
// coverageFacts wires the course's own §5.1 tier-1 rules into wasFileWatched
// ---------------------------------------------------------------------------

describe('file scope coverage evaluates the signed 2.0 scope rules (tier 1)', () => {
  it('answers WATCHED from the rules for an in-scope path even off an incomplete list', async () => {
    // Without the rules wired in, an incomplete file_scope list can only ever
    // prove `unknown` for a path it does not name. §5.1 tier 1 exists to do
    // better than that when a verified 2.0 manifest is present — this is the
    // exculpatory row the whole slice is for.
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys, filesUnderReview: ['src/'] });
    const { bundle, index } = await fileScopeScope({
      files: ['src/Solver.java'],
      sessionStarts: [{ ...sessionStart2(manifest), file_scope: { watched: [], complete: false } }],
    });
    const chain = await establishBundleTrust(bundle, keys.rootPubkeyHex);
    expect(chain.kind).toBe('verified');

    const facts = coverageFacts(bundle, index);
    expect(facts.fileScope.files).toEqual([
      {
        path: 'src/Solver.java',
        watched: 'watched',
        recordedActivity: false,
        notWatchedReason: null,
      },
    ]);
  });

  it('does not assert from the rules when no session shows it evaluated them', async () => {
    // A session that embeds a verified 2.0 manifest but reports no `file_scope`
    // at all gives no evidence the recorder ever applied the rules — asserting
    // 'watched' from them anyway would be exactly the accusatory error tier 1
    // must not make (session-capabilities.ts, Important 2).
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys, filesUnderReview: ['src/'] });
    const { bundle, index } = await fileScopeScope({
      files: ['src/Solver.java'],
      sessionStarts: [sessionStart2(manifest)],
    });
    const chain = await establishBundleTrust(bundle, keys.rootPubkeyHex);
    expect(chain.kind).toBe('verified');

    const facts = coverageFacts(bundle, index);
    expect(facts.fileScope.files).toEqual([
      {
        path: 'src/Solver.java',
        watched: 'unknown',
        recordedActivity: false,
        notWatchedReason: null,
      },
    ]);
  });

  it("does not INVERT a stale recorder's complete:true on a rule-bearing scope into WATCHED", async () => {
    // The real-world hazard, end to end through the wired production path: a
    // course issues a rule-bearing 2.0 manifest (`track: ['src/']`), a student
    // is on a not-yet-updated recorder build, and trust verifies correctly
    // because the MANIFEST is genuinely course-signed — it is the recorder
    // that is stale. That old recorder treats 'src/' as a literal filename,
    // matches nothing real, and — believing it fully enumerated a one-entry
    // list — reports `{ watched: ['src/'], complete: true }`. The honest
    // answer is 'unknown': tier 1 must not fire (the recorder never evaluated
    // the rule), and tier 2 must not fire either (its own 'complete' claim is
    // the same stale, untrustworthy signature) — asserting 'watched', the most
    // accusatory answer, about a file the recorder demonstrably never watched
    // is exactly what this fix removes.
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys, filesUnderReview: ['src/'] });
    const { bundle, index } = await fileScopeScope({
      files: ['src/Solver.java'],
      sessionStarts: [
        { ...sessionStart2(manifest), file_scope: { watched: ['src/'], complete: true } },
      ],
    });
    const chain = await establishBundleTrust(bundle, keys.rootPubkeyHex);
    expect(chain.kind).toBe('verified');

    const facts = coverageFacts(bundle, index);
    expect(facts.fileScope.files).toEqual([
      {
        path: 'src/Solver.java',
        watched: 'unknown',
        recordedActivity: false,
        notWatchedReason: null,
      },
    ]);
  });

  it("takes `track` from the VERIFIED binding, so a sibling's rules never engage tier 1", async () => {
    // A bundle can carry different manifests per session — a course re-issuing
    // a corrected manifest mid-assignment is the ordinary way to get one — and
    // `resolveBundleCapturePolicy` / `bundleCollaboration` already assume that.
    // But `track` is the one list that can only make the answer MORE accusatory:
    // a rule entry in it sets `hasRuleEntries` and can resolve a path to
    // 'reviewed', which is what makes `wasFileWatched` say 'watched'. So `track`
    // is read from the walked manifest ALONE (the first 2.0 binding), while
    // `ignore` and `attachments` — which can only move a path away from
    // 'reviewed' — stay unioned across every binding.
    const keys = await buildTrustChainKeys();
    const exactOnly = await buildManifest2({ keys, filesUnderReview: ['hw1.py'] });
    const ruleBearing = await buildManifest2({ keys, filesUnderReview: ['src/'] });
    const { bundle, index } = await fileScopeScope({
      files: ['src/Solver.java'],
      sessionStarts: [
        // Session 1's own list is complete — legitimately, since its manifest
        // carries no rule entry at all.
        { ...sessionStart2(exactOnly), file_scope: { watched: ['hw1.py'], complete: true } },
        { ...sessionStart2(ruleBearing), file_scope: { watched: [], complete: false } },
      ],
    });
    // Stamped directly rather than earned through `establishBundleTrust`. That
    // is a faithful stand-in for a state the system genuinely produces, and NOT
    // for the reason an earlier version of this comment gave: it claimed checks
    // 2 and 3 catch a bundle whose sessions carry genuinely different manifests
    // on their own. They do not. The check-2 binding loop compares each
    // session's SELF-DECLARED `manifest_sig` against the walked manifest's
    // `sig` and never compares a sibling `binding.manifest.sig` to it, so a
    // session embedding a different manifest while copying the real
    // `manifest_sig` passes manifest_sig, session_binding and chain_integrity
    // intact — see the forged-sibling test below, which earns the stamp for
    // real. This test is about what the MERGE does once the gate is open.
    bundle.capturePolicyTrust = 'verified';

    const facts = coverageFacts(bundle, index);
    // The sibling's `src/` is not in the resolved `track`, so `hasRuleEntries`
    // is false, tier 1 engages on the walked manifest's exact-only scope, and
    // `src/Solver.java` is simply outside it. The binding invariant, stated
    // separately because it is the one that matters: never the accusatory answer.
    expect(facts.fileScope.files[0]!.watched).not.toBe('watched');
    expect(facts.fileScope.files[0]!.watched).toBe('not_watched');
    expect(facts.fileScope.files[0]!.notWatchedReason).toBe('out_of_scope');
  });

  it('refuses a forged sibling binding that reaches a VERIFIED trust chain', async () => {
    // The probe that disproved "a forged sibling can only ever suppress".
    //
    // `verifyBundleTrustChain` walks `withV2[0].manifest` and then requires
    // every session's `session.start.data.manifest_sig` to equal that
    // manifest's `sig`. It never compares a sibling `binding.manifest.sig` to
    // it. So a second session can embed a COMPLETELY different manifest —
    // garbage `sig`, garbage `course_cert.root_sig` — and still land the whole
    // bundle on `kind: 'verified'` just by declaring the real manifest's sig.
    //
    // Both sessions report `complete: false`, so nothing suppresses tier 1.
    // Before the fix the union put the forged `src/` into `track`,
    // `resolvePathRole` returned 'reviewed', and `wasFileWatched` returned
    // 'watched' — the strongest and most accusatory of its three answers, about
    // a file the real manifest never put under review. R2: a forged artifact
    // must never be able to manufacture a finding.
    const keys = await buildTrustChainKeys();
    const real = await buildManifest2({ keys, filesUnderReview: ['hw1.py'] });
    const other = await buildManifest2({ keys, filesUnderReview: ['src/'] });
    const garbage = 'ab'.repeat(64);
    // `course_cert` is OPTIONAL on `Manifest` — a 1.x manifest carries none —
    // so it is narrowed before being spread. Spreading a possibly-undefined
    // value would make every property of the result optional, which
    // `exactOptionalPropertyTypes` refuses, and the forgery has to be as
    // well-typed as a production manifest for the test to mean anything: the
    // claim is that a REALISTIC forged sibling gets through, not that a
    // half-built object does.
    const realCert = other.course_cert;
    if (realCert === undefined) throw new Error('buildManifest2 always mints a course_cert');
    const forged: Manifest = {
      ...other,
      sig: garbage,
      course_cert: { ...realCert, root_sig: garbage },
    };

    const { bundle, index } = await fileScopeScope({
      files: ['src/Solver.java'],
      sessionStarts: [
        { ...sessionStart2(real), file_scope: { watched: [], complete: false } },
        // Copies the real `manifest_sig` while embedding the forged manifest.
        {
          ...sessionStart2(forged),
          manifest_sig: real.sig,
          file_scope: { watched: [], complete: false },
        },
      ],
    });

    // The gap this test documents: the chain verifies anyway.
    const chain = await establishBundleTrust(bundle, keys.rootPubkeyHex);
    expect(chain.kind).toBe('verified');

    const facts = coverageFacts(bundle, index);
    expect(facts.fileScope.files[0]!.watched).not.toBe('watched');
    expect(facts.fileScope.files[0]!.watched).toBe('not_watched');
    expect(facts.fileScope.files[0]!.notWatchedReason).toBe('out_of_scope');
  });

  it('still unions a sibling `ignore`, which can only ever suppress', async () => {
    // The other half of the asymmetry. A forged sibling adding to `ignore`
    // moves the path AWAY from 'reviewed' (precedence: ignored > attachment >
    // reviewed > unscoped), so honouring it can only make the answer less
    // accusatory — the same direction `resolveBundleCapturePolicy`'s AND errs
    // in. That is why the union stays for `ignore`/`attachments`.
    const keys = await buildTrustChainKeys();
    const real = await buildManifest2({ keys, filesUnderReview: ['src/'] });
    const sibling = await buildManifest2({
      keys,
      filesUnderReview: ['src/'],
      ignore: ['*.java'],
    });
    const { bundle, index } = await fileScopeScope({
      files: ['src/Solver.java'],
      sessionStarts: [
        { ...sessionStart2(real), file_scope: { watched: [], complete: false } },
        {
          ...sessionStart2(sibling),
          manifest_sig: real.sig,
          file_scope: { watched: [], complete: false },
        },
      ],
    });
    const chain = await establishBundleTrust(bundle, keys.rootPubkeyHex);
    expect(chain.kind).toBe('verified');

    const facts = coverageFacts(bundle, index);
    expect(facts.fileScope.files[0]!.watched).toBe('not_watched');
    expect(facts.fileScope.files[0]!.notWatchedReason).toBe('ignored_by_assignment');
  });

  it('takes the STRICTEST role across manifests: one manifest ignoring beats another tracking', async () => {
    // `resolvePathRole`'s precedence runs ignored > attachment > reviewed, so
    // the union merge lands on the least accusatory answer available — the same
    // direction `resolveBundleCapturePolicy`'s AND errs in.
    const keys = await buildTrustChainKeys();
    const tracks = await buildManifest2({ keys, filesUnderReview: ['src/'] });
    const ignores = await buildManifest2({
      keys,
      filesUnderReview: ['src/'],
      ignore: ['*.java'],
    });
    const { bundle, index } = await fileScopeScope({
      files: ['src/Solver.java'],
      sessionStarts: [
        { ...sessionStart2(tracks), file_scope: { watched: [], complete: false } },
        { ...sessionStart2(ignores), file_scope: { watched: [], complete: false } },
      ],
    });
    // See the note on the stamp in "takes `track` from the VERIFIED binding"
    // above for why this is set directly rather than earned.
    bundle.capturePolicyTrust = 'verified';

    const facts = coverageFacts(bundle, index);
    expect(facts.fileScope.files[0]!.watched).toBe('not_watched');
    // §9.3: and it says WHY — "the course excluded it", not merely "no evidence".
    expect(facts.fileScope.files[0]!.notWatchedReason).toBe('ignored_by_assignment');
  });

  it('names the course ignore list as the reason a file has no evidence (§9.3)', async () => {
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      filesUnderReview: ['src/'],
      ignore: ['*.class'],
    });
    const { bundle, index } = await fileScopeScope({
      files: ['src/A.class'],
      sessionStarts: [{ ...sessionStart2(manifest), file_scope: { watched: [], complete: false } }],
    });
    const chain = await establishBundleTrust(bundle, keys.rootPubkeyHex);
    expect(chain.kind).toBe('verified');

    const facts = coverageFacts(bundle, index);
    expect(facts.fileScope.files).toEqual([
      {
        path: 'src/A.class',
        watched: 'not_watched',
        recordedActivity: false,
        notWatchedReason: 'ignored_by_assignment',
      },
    ]);
  });

  it('distinguishes an ATTACHMENT from a file outside every scope', async () => {
    // An attachment has no event history BY DESIGN. Telling a grader it was
    // "outside every watched scope" is a different and false sentence.
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({
      keys,
      filesUnderReview: ['src/'],
      attachments: ['*.log'],
    });
    const { bundle, index } = await fileScopeScope({
      files: ['run.log', 'README.md'],
      sessionStarts: [{ ...sessionStart2(manifest), file_scope: { watched: [], complete: false } }],
    });
    const chain = await establishBundleTrust(bundle, keys.rootPubkeyHex);
    expect(chain.kind).toBe('verified');

    const facts = coverageFacts(bundle, index);
    expect(facts.fileScope.files.map((f) => f.notWatchedReason)).toEqual([
      'attachment',
      'out_of_scope',
    ]);
  });

  it('does not honour scope rules from an UNVERIFIED manifest', async () => {
    // `session.start.data.manifest` arrives from a file the student can edit.
    // Trusting its ignore/track lists without verifying the trust chain would
    // let a student fabricate the exculpatory "outside every watched scope"
    // sentence for a file that was never actually excluded — the mirror image
    // of `resolveBundleCapturePolicy`'s "an unverified policy is not a policy".
    const keys = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys, filesUnderReview: ['src/'] });
    const { bundle, index } = await fileScopeScope({
      files: ['src/Solver.java'],
      sessionStarts: [{ ...sessionStart2(manifest), file_scope: { watched: [], complete: false } }],
    });
    // No root key supplied — establishBundleTrust cannot verify, so the chain
    // is 'unconfigured' rather than 'verified'.
    const chain = await establishBundleTrust(bundle, undefined);
    expect(chain.kind).toBe('unconfigured');

    const facts = coverageFacts(bundle, index);
    // Falls back to tier 2: the list is incomplete and names nothing, so the
    // honest answer is unknown — never the rules-based 'watched'.
    expect(facts.fileScope.files).toEqual([
      {
        path: 'src/Solver.java',
        watched: 'unknown',
        recordedActivity: false,
        notWatchedReason: null,
      },
    ]);
  });
});

describe('a malformed git capture says WHICH way it was malformed', () => {
  it('distinguishes a non-string value from a value outside the enum', async () => {
    // The two are different nonconformance and a surface holding only a count
    // can describe at most one of them — so it describes the wrong one for the
    // other. Carried so `describeCapabilityValueProblem` can say which.
    const notAString = await capabilityScope({ git_capture: 7 });
    expect(coverageFacts(notAString.bundle, notAString.index).gitObservation).toMatchObject({
      malformed: 1,
      malformedProblems: ['not_a_string'],
    });

    const unknownValue = await capabilityScope({ git_capture: 'sort-of' });
    expect(coverageFacts(unknownValue.bundle, unknownValue.index).gitObservation).toMatchObject({
      malformed: 1,
      malformedProblems: ['unknown_value'],
    });
  });

  it('is empty when nothing was malformed', async () => {
    const { bundle, index } = await capabilityScope({ git_capture: 'available' });
    expect(coverageFacts(bundle, index).gitObservation.malformedProblems).toEqual([]);
  });
});
