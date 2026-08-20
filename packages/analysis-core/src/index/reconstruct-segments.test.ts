/**
 * Tier 2.2 — segment-based reconstruction.
 *
 * Written against the FACTS that must be kept apart rather than the
 * implementation. Each test guards a place where a tidy answer is a fabricated
 * one:
 *
 *  - a single contributor reconstructs BYTE-FOR-BYTE as it does today, because
 *    every shipped course depends on it;
 *  - two partners on divergent branches are `concurrent`, both branches are
 *    returned, and neither is chosen;
 *  - a merge commit re-anchors and the answer becomes `determinate` again;
 *  - two partners on DIFFERENT files are both `determinate`;
 *  - `concurrent` (two recorded branches raced) never collapses into `unknown`
 *    (we have no record), and vice versa;
 *  - no wall clock changes any answer.
 */

import { describe, expect, it } from 'vitest';
import type { HashedEnvelope } from '@provenance/log-core';
import type { SessionContributor } from '../identity/types.js';
import type { Bundle, ParsedSession } from '../loader/types.js';
import { buildIndex } from './build-index.js';
import { reconstructFile } from './reconstruct-file.js';
import {
  buildReconstructionScope,
  determinateValue,
  describeAmbiguity,
  reconstructFileSegmented,
  reconstructFileSegmentedWithProvenance,
  soloReconstructionScope,
  type SegmentedResult,
} from './reconstruct-segments.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PATH = 'hw.py';
const OTHER = 'util.py';

const BASE = 'a'.repeat(40);
const ALICE_TIP = 'b'.repeat(40);
const BOB_TIP = 'c'.repeat(40);
const MERGE = 'd'.repeat(40);

let wallCounter = 0;
/** Wall clocks are display only; every test that cares sets them explicitly. */
function nextWall(): string {
  wallCounter += 1000;
  return new Date(Date.UTC(2026, 0, 1) + wallCounter).toISOString();
}

function envelope(
  seq: number,
  kind: string,
  data: Record<string, unknown>,
  wall?: string,
): HashedEnvelope {
  return {
    seq,
    t: seq,
    wall: wall ?? nextWall(),
    kind,
    data,
    prev_hash: '0'.repeat(64),
    hash: '1'.repeat(64),
  } as unknown as HashedEnvelope;
}

function sessionStart(seq: number, sessionId: string, wall?: string): HashedEnvelope {
  return envelope(
    seq,
    'session.start',
    {
      format_version: '2.0',
      session_id: sessionId,
      prev_session_id: null,
      assignment: { id: 'hw1', semester: 'fa26' },
    },
    wall,
  );
}

/** A `doc.open` carrying inline content — an ANCHOR (ground truth from disk). */
function open(seq: number, path: string, content: string, wall?: string): HashedEnvelope {
  return envelope(seq, 'doc.open', { path, content, sha256: '0'.repeat(64) }, wall);
}

/** A `doc.open` with no inline content — pre-v1.1, NOT an anchor. */
function openBare(seq: number, path: string, wall?: string): HashedEnvelope {
  return envelope(seq, 'doc.open', { path, sha256: '0'.repeat(64) }, wall);
}

/** Append `text` at the end of line `line`. */
function append(seq: number, path: string, line: number, text: string, wall?: string) {
  return envelope(
    seq,
    'doc.change',
    {
      path,
      source: 'typed',
      deltas: [
        {
          range: {
            start: { line, character: 10_000 },
            end: { line, character: 10_000 },
          },
          text,
        },
      ],
    },
    wall,
  );
}

function gitEvent(
  seq: number,
  sha: string,
  parents: readonly string[],
  wall?: string,
): HashedEnvelope {
  return envelope(seq, 'git.event', { operation: 'commit', sha, parents: [...parents] }, wall);
}

/** An `fs.external_change` carrying `new_content` — an ANCHOR. */
function externalChange(seq: number, path: string, content: string, wall?: string) {
  return envelope(
    seq,
    'fs.external_change',
    { path, operation: 'modify', new_content: content, new_hash: '2'.repeat(64) },
    wall,
  );
}

function parsedSession(sessionId: string, events: readonly HashedEnvelope[]): ParsedSession {
  return {
    sessionId,
    events,
    meta: {} as ParsedSession['meta'],
    slogSha256: '3'.repeat(64),
    metaSha256: '4'.repeat(64),
    firstEvent: events[0] as ParsedSession['firstEvent'],
  };
}

function attributed(sessionId: string, studentRef: string): SessionContributor {
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

function unattributed(sessionId: string): SessionContributor {
  return { kind: 'unattributed', sessionId, contributorKey: `unattributed:${sessionId}` };
}

type SessionSpec = { id: string; events: readonly HashedEnvelope[]; student?: string };

function bundleOf(specs: readonly SessionSpec[]): Bundle {
  const sessions = specs.map((s) => parsedSession(s.id, s.events));
  const bySession = new Map<string, SessionContributor>();
  for (const spec of specs) {
    bySession.set(
      spec.id,
      spec.student === undefined ? unattributed(spec.id) : attributed(spec.id, spec.student),
    );
  }
  const keys = new Set(
    [...bySession.values()].filter((c) => c.kind === 'attributed').map((c) => c.contributorKey),
  );
  return {
    id: 'bundle-1',
    droppedArtifacts: [],
    manifest: { format_version: '1.1' } as Bundle['manifest'],
    manifestSigHex: null,
    sessions,
    sourceFilename: 'b.zip',
    loadedAt: '2026-01-01T00:00:00.000Z',
    submissionFiles: new Map(),
    contributors: {
      bySession,
      contributors: [...keys].map((key) => ({
        key,
        kind: 'attributed' as const,
        studentRef: key,
        identityVersion: '2.0' as const,
        scope: 'course' as const,
        scopeId: 'c1',
        sessionIds: specs.filter((s) => s.student !== undefined).map((s) => s.id),
      })),
      rootKeyConfigured: true,
      counts: { attributed: keys.size, unverifiable: 0, unattributed: 0 },
    },
  };
}

function scopeOf(specs: readonly SessionSpec[]) {
  const bundle = bundleOf(specs);
  const index = buildIndex(bundle);
  return { bundle, index, scope: buildReconstructionScope(bundle, index) };
}

/** Narrow, failing loudly with the actual shape when the arm is wrong. */
function expectDeterminate<T>(result: SegmentedResult<T>): T {
  if (result.kind !== 'determinate') {
    throw new Error(`expected determinate, got ${result.kind}: ${describeAmbiguity(result)}`);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// The solo guarantee
// ---------------------------------------------------------------------------

describe('single-contributor bundles are byte-for-byte unaffected', () => {
  /**
   * The regression that protects every shipped course. Asserted against
   * `reconstructFile`'s OWN output rather than against a literal, so it keeps
   * holding if reconstruction semantics legitimately change later.
   */
  it('reproduces reconstructFile exactly for one session', () => {
    const events = [
      sessionStart(0, 's1'),
      open(1, PATH, 'seed\n'),
      append(2, PATH, 0, 'one'),
      append(3, PATH, 0, 'two'),
      envelope(4, 'doc.save', { path: PATH, sha256: '9'.repeat(64) }),
    ];
    const { index, scope } = scopeOf([{ id: 's1', events, student: 'alice' }]);

    const expected = reconstructFile(index, PATH);
    const actual = expectDeterminate(reconstructFileSegmented(scope, PATH));

    expect(actual.content).toBe(expected.content);
    expect(actual.tainted).toBe(expected.tainted);
    expect(actual.taintReasons).toEqual(expected.taintReasons);
    expect(actual.suppressedExternalChanges).toEqual(expected.suppressedExternalChanges);
    expect(actual.recoveredPastes).toEqual(expected.recoveredPastes);
    expect([...actual.hashBySaveSeq]).toEqual([...expected.hashBySaveSeq]);
  });

  it('takes the single-session basis and never builds an ordering', () => {
    const { scope } = scopeOf([
      { id: 's1', events: [sessionStart(0, 's1'), open(1, PATH, 'x')], student: 'alice' },
    ]);
    // `ordering === null` IS the perf guarantee: a solo bundle never pays for a
    // DAG or a reachability closure.
    expect(scope.ordering).toBeNull();
    const result = reconstructFileSegmented(scope, PATH);
    expect(result.kind).toBe('determinate');
    expect(result.kind === 'determinate' && result.basis).toBe('single_session');
  });

  /**
   * The case that would break every existing multi-session course if `≺` were
   * applied without the contributor gate: one student, two sessions, no
   * `prev_session_id` and no commits, so `≺` genuinely says `concurrent`.
   * Reconstruction must NOT.
   */
  it('two unlinked sessions of ONE student stay determinate', () => {
    const s1 = [sessionStart(0, 's1'), open(1, PATH, 'seed\n'), append(2, PATH, 0, 'A')];
    const s2 = [sessionStart(0, 's2'), append(1, PATH, 0, 'B')];
    const { index, scope } = scopeOf([
      { id: 's1', events: s1, student: 'alice' },
      { id: 's2', events: s2, student: 'alice' },
    ]);

    expect(scope.ordering).toBeNull();
    const result = reconstructFileSegmented(scope, PATH);
    expect(result.kind).toBe('determinate');
    expect(result.kind === 'determinate' && result.basis).toBe('single_contributor');
    expect(determinateValue(result)?.content).toBe(reconstructFile(index, PATH).content);
  });

  it('a bundle with NO identity at all takes the solo path', () => {
    const s1 = [sessionStart(0, 's1'), open(1, PATH, 'seed\n'), append(2, PATH, 0, 'A')];
    const s2 = [sessionStart(0, 's2'), append(1, PATH, 0, 'B')];
    // No `student` — every session resolves `unattributed`, and
    // `compareContributors` answers `'unknown'`, never `'different'`.
    const { index, scope } = scopeOf([
      { id: 's1', events: s1 },
      { id: 's2', events: s2 },
    ]);

    const result = reconstructFileSegmented(scope, PATH);
    expect(result.kind).toBe('determinate');
    expect(determinateValue(result)?.content).toBe(reconstructFile(index, PATH).content);
  });

  it('an UNSTAMPED bundle takes the solo path', () => {
    const bundle = bundleOf([
      { id: 's1', events: [sessionStart(0, 's1'), open(1, PATH, 'seed')], student: 'alice' },
      { id: 's2', events: [sessionStart(0, 's2'), append(1, PATH, 0, 'B')], student: 'bob' },
    ]);
    delete bundle.contributors;
    const index = buildIndex(bundle);
    const scope = buildReconstructionScope(bundle, index);

    expect(scope.ordering).toBeNull();
    expect(reconstructFileSegmented(scope, PATH).kind).toBe('determinate');
  });

  it('a cut reconstructs identically to a cut on the linear path', () => {
    const events = [
      sessionStart(0, 's1'),
      open(1, PATH, 'seed\n'),
      append(2, PATH, 0, 'one'),
      append(3, PATH, 0, 'two'),
    ];
    const { index, scope } = scopeOf([{ id: 's1', events, student: 'alice' }]);
    const cut = index.byFile.get(PATH)!.at(-1)!.globalIdx;

    expect(determinateValue(reconstructFileSegmented(scope, PATH, cut))?.content).toBe(
      reconstructFile(index, PATH, cut).content,
    );
  });

  it('soloReconstructionScope reproduces the linear path for a hand-built index', () => {
    const { index } = scopeOf([
      { id: 's1', events: [sessionStart(0, 's1'), open(1, PATH, 'x'), append(2, PATH, 0, 'y')] },
    ]);
    const result = reconstructFileSegmented(soloReconstructionScope(index), PATH);
    expect(determinateValue(result)?.content).toBe(reconstructFile(index, PATH).content);
  });
});

// ---------------------------------------------------------------------------
// Divergence
// ---------------------------------------------------------------------------

/**
 * Alice and Bob both branch from BASE and each commits their own tip. Neither
 * tip is an ancestor of the other, so `≺` orders their post-branch edits
 * neither way. Replaying them as one stream would produce a file that existed
 * on no machine.
 */
function divergentPartners(opts?: { path?: string; bobPath?: string }) {
  const alicePath = opts?.path ?? PATH;
  const bobPath = opts?.bobPath ?? alicePath;
  const alice = [
    sessionStart(0, 's-alice'),
    open(1, alicePath, 'shared\n'),
    gitEvent(2, BASE, []),
    append(3, alicePath, 0, 'ALICE'),
    gitEvent(4, ALICE_TIP, [BASE]),
  ];
  const bob = [
    sessionStart(0, 's-bob'),
    open(1, bobPath, 'shared\n'),
    gitEvent(2, BASE, []),
    append(3, bobPath, 0, 'BOB'),
    gitEvent(4, BOB_TIP, [BASE]),
  ];
  return [
    { id: 's-alice', events: alice, student: 'alice' },
    { id: 's-bob', events: bob, student: 'bob' },
  ] satisfies SessionSpec[];
}

describe('two contributors on divergent branches', () => {
  it('reports concurrent and returns BOTH branches', () => {
    const { scope } = scopeOf(divergentPartners());
    const result = reconstructFileSegmented(scope, PATH);

    expect(result.kind).toBe('concurrent');
    if (result.kind !== 'concurrent') return;
    expect(result.branches).toHaveLength(2);
    expect(result.divergence.contributorKeys).toHaveLength(2);
  });

  it('neither branch is chosen — determinateValue returns null', () => {
    const { scope } = scopeOf(divergentPartners());
    expect(determinateValue(reconstructFileSegmented(scope, PATH))).toBeNull();
  });

  it("each branch carries only its own contributor's edit", () => {
    const { scope } = scopeOf(divergentPartners());
    const result = reconstructFileSegmented(scope, PATH);
    if (result.kind !== 'concurrent') throw new Error(`expected concurrent, got ${result.kind}`);

    const contents = result.branches.map((b) => b.value.content).sort();
    expect(contents).toEqual(['sharedALICE\n', 'sharedBOB\n'].sort());

    // The fabrication: neither branch may contain BOTH partners' text. That
    // string is what a wall-clock replay produces and it never existed.
    for (const content of contents) {
      expect(content.includes('ALICE') && content.includes('BOB')).toBe(false);
    }
  });

  it('names each branch by its own contributor', () => {
    const { scope } = scopeOf(divergentPartners());
    const result = reconstructFileSegmented(scope, PATH);
    if (result.kind !== 'concurrent') throw new Error('expected concurrent');

    const byKey = new Map(result.branches.map((b) => [b.contributorKey, b.value.content]));
    expect(byKey.get('attributed:2.0:course:c1:alice')).toBe('sharedALICE\n');
    expect(byKey.get('attributed:2.0:course:c1:bob')).toBe('sharedBOB\n');
  });

  it('explains the ambiguity rather than presenting a number', () => {
    const { scope } = scopeOf(divergentPartners());
    const detail = describeAmbiguity(reconstructFileSegmented(scope, PATH)) ?? '';
    expect(detail).toContain('unordered');
    expect(detail.toLowerCase()).toContain('merge');
  });

  it('the provenance variant diverges identically', () => {
    const { scope } = scopeOf(divergentPartners());
    const result = reconstructFileSegmentedWithProvenance(scope, PATH);
    expect(result.kind).toBe('concurrent');
    if (result.kind !== 'concurrent') return;
    for (const branch of result.branches) {
      expect(branch.value.provenance.length).toBe(branch.value.content.length);
    }
  });

  /**
   * Skew is a measurement, never an ordering authority (spec L3). Moving one
   * machine's clock a year must not change a single answer.
   */
  it('is unchanged by arbitrary clock skew', () => {
    const base = scopeOf(divergentPartners());
    const baseResult = reconstructFileSegmented(base.scope, PATH);

    const skewed = divergentPartners().map((spec) =>
      spec.id !== 's-bob'
        ? spec
        : {
            ...spec,
            events: spec.events.map(
              (e) =>
                ({ ...e, wall: new Date(Date.UTC(2020, 0, 1) + e.seq).toISOString() }) as typeof e,
            ),
          },
    );
    const skewedResult = reconstructFileSegmented(scopeOf(skewed).scope, PATH);

    expect(skewedResult.kind).toBe(baseResult.kind);
    if (skewedResult.kind !== 'concurrent' || baseResult.kind !== 'concurrent') return;
    expect(skewedResult.branches.map((b) => b.value.content).sort()).toEqual(
      baseResult.branches.map((b) => b.value.content).sort(),
    );
  });

  it('is deterministic across runs — ingest retries depend on it', () => {
    const first = reconstructFileSegmented(scopeOf(divergentPartners()).scope, PATH);
    const second = reconstructFileSegmented(scopeOf(divergentPartners()).scope, PATH);
    if (first.kind !== 'concurrent' || second.kind !== 'concurrent') throw new Error('shape');
    expect(second.branches.map((b) => [b.contributorKey, b.value.content])).toEqual(
      first.branches.map((b) => [b.contributorKey, b.value.content]),
    );
  });
});

// ---------------------------------------------------------------------------
// Merges close the divergence
// ---------------------------------------------------------------------------

describe('a merge commit resolves the divergence', () => {
  /**
   * Alice merges Bob's tip and her editor observes the merged file on disk.
   * That observation is an anchor: it is ground truth, it discards whatever the
   * replay had inherited, and it is `≺`-after both tips through the merge
   * commit's ancestry. One lineage resumes.
   */
  function merged() {
    const specs = divergentPartners();
    const alice = specs.find((s) => s.id === 's-alice')!;
    return specs.map((spec) =>
      spec.id !== 's-alice'
        ? spec
        : {
            ...spec,
            events: [
              ...alice.events,
              gitEvent(5, MERGE, [ALICE_TIP, BOB_TIP]),
              externalChange(6, PATH, 'sharedALICEBOB-merged\n'),
            ],
          },
    );
  }

  it('becomes determinate again after the post-merge disk observation', () => {
    const result = reconstructFileSegmented(scopeOf(merged()).scope, PATH);
    expect(result.kind).toBe('determinate');
    expect(result.kind === 'determinate' && result.basis).toBe('reanchored_after_merge');
  });

  it('the determinate content is the observed merged content, not a synthesis', () => {
    const value = expectDeterminate(reconstructFileSegmented(scopeOf(merged()).scope, PATH));
    // Exactly the bytes the recorder saw on disk. Not a concatenation, not a
    // diff3, not a pick.
    expect(value.content).toBe('sharedALICEBOB-merged\n');
  });

  /**
   * The merge commit ALONE is not enough. Until somebody's editor observes the
   * merged file, no contributor has recorded what the merged content is, and
   * inventing one is the fabrication.
   */
  it('a merge commit with no disk observation stays concurrent', () => {
    const specs = divergentPartners();
    const alice = specs.find((s) => s.id === 's-alice')!;
    const withMergeOnly = specs.map((spec) =>
      spec.id !== 's-alice'
        ? spec
        : { ...spec, events: [...alice.events, gitEvent(5, MERGE, [ALICE_TIP, BOB_TIP])] },
    );
    expect(reconstructFileSegmented(scopeOf(withMergeOnly).scope, PATH).kind).toBe('concurrent');
  });

  /**
   * A cut BEFORE the merge must still report the divergence — the answer is a
   * function of the cut, not of how the story ends.
   */
  it('a cut before the merge is still concurrent', () => {
    const { index, scope } = scopeOf(merged());
    const mergeObservation = index.byFile.get(PATH)!.find((e) => e.kind === 'fs.external_change')!;
    expect(reconstructFileSegmented(scope, PATH, mergeObservation.globalIdx).kind).toBe(
      'concurrent',
    );
  });
});

// ---------------------------------------------------------------------------
// Two contributors, different files
// ---------------------------------------------------------------------------

describe('two contributors editing DIFFERENT files', () => {
  it('reports both files determinate', () => {
    const { scope } = scopeOf(divergentPartners({ path: PATH, bobPath: OTHER }));

    const aliceFile = reconstructFileSegmented(scope, PATH);
    const bobFile = reconstructFileSegmented(scope, OTHER);

    expect(aliceFile.kind).toBe('determinate');
    expect(bobFile.kind).toBe('determinate');
    expect(determinateValue(aliceFile)?.content).toBe('sharedALICE\n');
    expect(determinateValue(bobFile)?.content).toBe('sharedBOB\n');
  });

  it('uses the single-contributor basis per file even though the scope has two', () => {
    const { scope } = scopeOf(divergentPartners({ path: PATH, bobPath: OTHER }));
    // The scope DID build an ordering — there really are two contributors — but
    // each individual file is one person's work.
    expect(scope.ordering).not.toBeNull();
    const result = reconstructFileSegmented(scope, PATH);
    expect(result.kind === 'determinate' && result.basis).toBe('single_session');
  });
});

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

describe('degradation when git evidence is absent', () => {
  /**
   * No `git.event` anywhere. Two verified partners edited one file and NOTHING
   * orders them: no chain link, no commit ancestry. `concurrent` is the correct
   * and honest answer — we hold both recordings, and the evidence orders
   * neither. It is not `unknown`, which would claim we have no record.
   */
  it('two contributors with no git.event at all are concurrent, not unknown', () => {
    const specs: SessionSpec[] = [
      {
        id: 's-alice',
        events: [sessionStart(0, 's-alice'), open(1, PATH, 'shared\n'), append(2, PATH, 0, 'A')],
        student: 'alice',
      },
      {
        id: 's-bob',
        events: [sessionStart(0, 's-bob'), openBare(1, PATH), append(2, PATH, 0, 'B')],
        student: 'bob',
      },
    ];
    const result = reconstructFileSegmented(scopeOf(specs).scope, PATH);

    expect(result.kind).toBe('concurrent');
    expect(result.kind).not.toBe('unknown');
    expect(describeAmbiguity(result)).toContain('commit DAG');
  });

  /**
   * The counterpart fact. `unknown` means the RELATION cannot speak, and it must
   * never be produced for a pair we actually hold. Guarding the reason string
   * keeps the two arms from being quietly merged.
   */
  it('concurrent and unknown carry different, non-interchangeable reasons', () => {
    const concurrent = reconstructFileSegmented(scopeOf(divergentPartners()).scope, PATH);
    if (concurrent.kind !== 'concurrent') throw new Error('expected concurrent');
    // A concurrent result has branches; an unknown one structurally cannot.
    expect(concurrent.branches.length).toBeGreaterThan(1);
    expect('reason' in concurrent).toBe(false);
  });

  it('a file with no events at all is determinate and empty', () => {
    const { scope } = scopeOf(divergentPartners());
    const result = reconstructFileSegmented(scope, 'never-touched.py');
    expect(result.kind).toBe('determinate');
    expect(determinateValue(result)?.content).toBe('');
  });

  it('an ordering built over a DIFFERENT scope answers unknown', () => {
    // The relation is asked about events it has never seen. That is the absence
    // of a record, not a race, and it must say so.
    const real = scopeOf(divergentPartners());
    const foreign = scopeOf([
      { id: 's-other', events: [sessionStart(0, 's-other'), open(1, PATH, 'z')], student: 'zoe' },
      {
        id: 's-other2',
        events: [sessionStart(0, 's-other2'), append(1, PATH, 0, 'q')],
        student: 'quinn',
      },
    ]);
    const mismatched = { ...real.scope, ordering: foreign.scope.ordering };

    const result = reconstructFileSegmented(mismatched, PATH);
    expect(result.kind).toBe('unknown');
    expect(result.kind === 'unknown' && result.reason).toBe('event_outside_ordering');
    expect(describeAmbiguity(result)).toContain('absence of a record');
  });
});

// ---------------------------------------------------------------------------
// The gate cannot be opened by a student
// ---------------------------------------------------------------------------

describe('the concurrency gate is not student-controllable', () => {
  /**
   * An `unverifiable` session is a forged or broken identity block. If it could
   * count as a second contributor, a student could talk their own file into
   * `concurrent` and make reconstruction — and every heuristic gated on it —
   * refuse to answer. That is a free evasion, so it must not.
   */
  it('an unverifiable session cannot manufacture a second contributor', () => {
    const bundle = bundleOf(divergentPartners());
    bundle.contributors = {
      ...bundle.contributors!,
      bySession: new Map([
        ['s-alice', attributed('s-alice', 'alice')],
        [
          's-bob',
          {
            kind: 'unverifiable',
            sessionId: 's-bob',
            contributorKey: 'unverifiable:s-bob',
            claimedStudentRef: 'bob',
            claimedScopeId: 'c1',
            claimedIdentityVersion: '2.0',
            reason: { kind: 'no_root_key', detail: 'test fixture' },
          } satisfies SessionContributor,
        ],
      ]),
    };
    const index = buildIndex(bundle);
    const scope = buildReconstructionScope(bundle, index);

    expect(scope.ordering).toBeNull();
    const result = reconstructFileSegmented(scope, PATH);
    expect(result.kind).toBe('determinate');
    expect(determinateValue(result)?.content).toBe(reconstructFile(index, PATH).content);
  });
});
