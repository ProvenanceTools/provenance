/**
 * S20 end to end — the flagship collusion detector firing on an honest partner
 * pair, driven through the real loader, the real index, the real feature
 * extraction and the real cross-heuristics.
 *
 * The unit tests in `../../coverage/cross-scope.test.ts` pin the partition rule.
 * These pin the thing that actually matters: that a bundle built the way a
 * git-native group submission is actually built produces no accusation, and that
 * two unrelated students still do.
 *
 * ## What the "honest partners" fixture is
 *
 * A git submission's `.provenance/` is committed and add-only, so after a push
 * and a pull BOTH partners' repositories contain BOTH partners' signed `.slog`
 * files. Gradescope then receives two archives with the same two sessions in
 * them. That is why the pastes match: they are not two students' pastes, they
 * are ONE student's paste seen twice. The fixture therefore builds two bundles
 * that each contain both sessions — not two bundles that happen to contain equal
 * content.
 *
 * Every fixture here leaves `fileUuid` at its default, so each session's `.slog`
 * FILENAME uuid differs from its logical `session.start` id (the fixture rule
 * that exists because crossing those two ids produced a live maximum-severity
 * false accusation).
 */

import { describe, expect, it } from 'vitest';
import { buildIndex } from '../../index/build-index.js';
import { loadBundle } from '../../loader/parse-bundle.js';
import { buildTestBundle } from '../../test-support/build-test-bundle.js';
import { partitionCrossScopes } from '../../coverage/cross-scope.js';
import { extractCrossFeatures } from './features.js';
import { runCrossHeuristics } from './run-cross-heuristics.js';
import { pasteSharedAcrossStudentsHeuristic } from './paste-shared-across-students.js';
import { editingPatternCloneHeuristic } from './editing-pattern-clone.js';
import { DEFAULT_CROSS_HEURISTIC_CONFIG } from './types.js';
import type { Bundle } from '../../loader/types.js';
import type { EventIndex } from '../../index/event-index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MS = new Date('2026-03-02T09:00:00.000Z').getTime();
const wallAt = (min: number) => new Date(BASE_MS + min * 60_000).toISOString();

/** A shared commit sha. Opaque — nothing in the pipeline parses it. */
const ALICE_COMMIT = 'a1'.repeat(20);
const BOB_COMMIT = 'b2'.repeat(20);
const CAROL_COMMIT = 'c3'.repeat(20);
const DAVE_COMMIT = 'd4'.repeat(20);

/**
 * A paste big enough to clear `pasteSharedMinLength` (100 chars). Realistic
 * shape: this is what a student actually pastes.
 */
const PASTED_CODE = [
  'public static int[] mergeSort(int[] a, int lo, int hi) {',
  '    if (hi - lo < 2) return a;',
  '    int mid = lo + (hi - lo) / 2;',
  '    mergeSort(a, lo, mid);',
  '    mergeSort(a, mid, hi);',
  '    return merge(a, lo, mid, hi);',
  '}',
].join('\n');

/** sha256 of the paste, as the recorder would have written it. */
async function sha256Hex(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type SessionSpec = {
  minute: number;
  /** Commit shas this session was observed AT (`git.event.sha`). */
  observed: readonly string[];
  /**
   * Parents recorded for each observed commit. A sha that appears ONLY here is
   * witnessed-only: proof a commit existed with no session recording work at it,
   * which is exactly the shape a course-issued skeleton's history takes.
   */
  parents?: readonly string[];
  /** Paste this content, if given. */
  paste?: string;
  pasteSha?: string;
};

function sessionEvents(spec: SessionSpec) {
  const events: Array<{ kind: string; data: Record<string, unknown>; wall: string; t: number }> =
    [];
  let n = 0;
  const at = () => {
    n += 1;
    return { wall: wallAt(spec.minute + n), t: n * 60_000 };
  };

  if (spec.paste !== undefined) {
    events.push({
      kind: 'paste',
      data: {
        path: 'Sort.java',
        range: { start: { line: 0, character: 0 }, end: { line: 6, character: 1 } },
        length: spec.paste.length,
        sha256: spec.pasteSha,
        content: spec.paste,
        signals: { size: true, speed: true, clipboard: true },
      },
      ...at(),
    });
  }

  for (const sha of spec.observed) {
    events.push({
      kind: 'git.event',
      data: {
        operation: 'commit',
        sha,
        commit_sha: sha,
        parents: spec.parents ?? [],
        branch: 'main',
      },
      ...at(),
    });
  }

  events.push({ kind: 'session.end', data: { reason: 'deactivate' }, ...at() });
  return events;
}

/**
 * Build one submission archive from N sessions and load it the way the analyzer
 * and the server both do.
 */
async function buildSubmission(
  sourceFilename: string,
  specs: readonly SessionSpec[],
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId: 'proj1',
    sessions: specs.map((s) => ({
      walls: [wallAt(s.minute)],
      events: sessionEvents(s),
    })),
  });
  const result = await loadBundle(new Blob([zipBuffer]), sourceFilename);
  if (!result.ok) throw new Error(`fixture failed to load: ${JSON.stringify(result.error)}`);
  return { bundle: result.value, index: buildIndex(result.value) };
}

function featuresOf(loaded: { bundle: Bundle; index: EventIndex }) {
  return extractCrossFeatures(loaded.bundle, loaded.index);
}

const pasteFlags = (flags: ReturnType<typeof runCrossHeuristics>) =>
  flags.filter((f) => f.heuristic === 'paste_shared_across_students');

// ---------------------------------------------------------------------------

describe('S20 — two honest partners on one shared repository', () => {
  it('does not fire paste_shared_across_students on the partner pair', async () => {
    const sha = await sha256Hex(PASTED_CODE);

    // Alice pastes; both sessions land in BOTH archives because `.provenance/`
    // is committed and add-only.
    const aliceSession: SessionSpec = {
      minute: 0,
      observed: [ALICE_COMMIT],
      paste: PASTED_CODE,
      pasteSha: sha,
    };
    const bobSession: SessionSpec = { minute: 60, observed: [ALICE_COMMIT, BOB_COMMIT] };

    const alice = await buildSubmission('alice_proj1.zip', [aliceSession, bobSession]);
    const bob = await buildSubmission('bob_proj1.zip', [aliceSession, bobSession]);

    const features = [featuresOf(alice), featuresOf(bob)];

    // The premise: they really do look identical to the heuristic.
    expect(features[0]!.pastes).toHaveLength(1);
    expect(features[1]!.pastes).toHaveLength(1);
    expect(features[0]!.pastes[0]!.sha256).toBe(features[1]!.pastes[0]!.sha256);

    expect(pasteFlags(runCrossHeuristics(features))).toEqual([]);
  });

  it('does not fire editing_pattern_clone on the partner pair either', async () => {
    const aliceSession: SessionSpec = { minute: 0, observed: [ALICE_COMMIT] };
    const bobSession: SessionSpec = { minute: 60, observed: [ALICE_COMMIT, BOB_COMMIT] };

    const alice = await buildSubmission('alice_proj1.zip', [aliceSession, bobSession]);
    const bob = await buildSubmission('bob_proj1.zip', [aliceSession, bobSession]);

    const flags = runCrossHeuristics([featuresOf(alice), featuresOf(bob)]);
    expect(flags.filter((f) => f.heuristic === 'editing_pattern_clone')).toEqual([]);
  });

  it('states the exclusion as a visible fact, naming the shared commit', async () => {
    // The consumer of the ABSENT flag above is a grader, and a grader reading
    // "no findings" must be able to tell a searched comparison from a withheld
    // one. This is the assertion that makes the two previous ones honest.
    const aliceSession: SessionSpec = { minute: 0, observed: [ALICE_COMMIT] };
    const bobSession: SessionSpec = { minute: 60, observed: [ALICE_COMMIT, BOB_COMMIT] };

    const alice = await buildSubmission('alice_proj1.zip', [aliceSession, bobSession]);
    const bob = await buildSubmission('bob_proj1.zip', [aliceSession, bobSession]);

    const partition = partitionCrossScopes([featuresOf(alice), featuresOf(bob)]);

    expect(partition.exclusions).toHaveLength(1);
    const ex = partition.exclusions[0]!;
    expect(ex.reason).toBe('same_repository_lineage');
    expect(ex.sourceFilenames).toEqual(['alice_proj1.zip', 'bob_proj1.zip']);
    expect(ex.excludedPairCount).toBe(1);
    expect(ex.sharedCommits.join(' ')).toContain(ALICE_COMMIT);
    expect(ex.sharedCommits.join(' ')).toContain(BOB_COMMIT);
  });
});

describe('S20 — the negative controls, which are not optional', () => {
  it('STILL fires on two unrelated students who genuinely shared a paste', async () => {
    const sha = await sha256Hex(PASTED_CODE);

    // Two separate repositories: no commit is observed by both.
    const carol = await buildSubmission('carol_proj1.zip', [
      { minute: 0, observed: [CAROL_COMMIT], paste: PASTED_CODE, pasteSha: sha },
    ]);
    const dave = await buildSubmission('dave_proj1.zip', [
      { minute: 240, observed: [DAVE_COMMIT], paste: PASTED_CODE, pasteSha: sha },
    ]);

    const features = [featuresOf(carol), featuresOf(dave)];
    expect(partitionCrossScopes(features).exclusions).toEqual([]);

    const flags = pasteFlags(runCrossHeuristics(features));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('high');
    expect(flags[0]!.bundleIds).toHaveLength(2);
  });

  it('STILL fires when neither student recorded a repository discriminator', async () => {
    // Both scopes fold into ASSUMED_SINGLE_REPOSITORY — the state of every
    // bundle recorded to date. Excluding on the sentinel would switch
    // cross-detection off for the whole corpus, which is strictly worse than the
    // bug being fixed.
    const sha = await sha256Hex(PASTED_CODE);

    const carol = await buildSubmission('carol_proj1.zip', [
      { minute: 0, observed: [CAROL_COMMIT], paste: PASTED_CODE, pasteSha: sha },
    ]);
    const dave = await buildSubmission('dave_proj1.zip', [
      { minute: 240, observed: [DAVE_COMMIT], paste: PASTED_CODE, pasteSha: sha },
    ]);

    // The premise: neither side named a repository, so both key on the sentinel.
    for (const f of [featuresOf(carol), featuresOf(dave)]) {
      expect(f.observedCommitKeys!.every((k) => k.startsWith('repository:assumed-single '))).toBe(
        true,
      );
    }

    expect(pasteFlags(runCrossHeuristics([featuresOf(carol), featuresOf(dave)]))).toHaveLength(1);
  });

  it('STILL fires when neither student ran git at all', async () => {
    // No observed commits on either side. Absence is not a shared commit.
    const sha = await sha256Hex(PASTED_CODE);

    const carol = await buildSubmission('carol_proj1.zip', [
      { minute: 0, observed: [], paste: PASTED_CODE, pasteSha: sha },
    ]);
    const dave = await buildSubmission('dave_proj1.zip', [
      { minute: 240, observed: [], paste: PASTED_CODE, pasteSha: sha },
    ]);

    const features = [featuresOf(carol), featuresOf(dave)];
    expect(features[0]!.observedCommitKeys).toEqual([]);
    expect(pasteFlags(runCrossHeuristics(features))).toHaveLength(1);
  });

  it('STILL fires for two students who cloned the same course skeleton', async () => {
    // THE case that decides whether this fix is a fix or a course-wide outage.
    // Every student clones the same starter, so every student's history contains
    // the same ancestors. Those ancestors are WITNESSED-ONLY — they appear in a
    // `parents` array and no session ever recorded work at them. Keying the
    // exclusion on ancestry rather than on observation would put the entire
    // cohort into one lineage and switch cross-submission detection off for the
    // whole course, which is strictly worse than the bug being fixed.
    const sha = await sha256Hex(PASTED_CODE);
    const SKELETON = '0f'.repeat(20);

    const carol = await buildSubmission('carol_proj1.zip', [
      {
        minute: 0,
        observed: [CAROL_COMMIT],
        parents: [SKELETON],
        paste: PASTED_CODE,
        pasteSha: sha,
      },
    ]);
    const dave = await buildSubmission('dave_proj1.zip', [
      {
        minute: 240,
        observed: [DAVE_COMMIT],
        parents: [SKELETON],
        paste: PASTED_CODE,
        pasteSha: sha,
      },
    ]);

    const features = [featuresOf(carol), featuresOf(dave)];

    // The premise: both really do carry the skeleton commit, and neither keys on
    // it — only their own commits are observed.
    for (const f of features) {
      expect(f.observedCommitKeys!.join(' ')).not.toContain(SKELETON);
      expect(f.observedCommitKeys).toHaveLength(1);
    }

    expect(partitionCrossScopes(features).exclusions).toEqual([]);
    expect(pasteFlags(runCrossHeuristics(features))).toHaveLength(1);
  });

  it('STILL fires when the partition does not know either bundle', async () => {
    // A mismatched or stale partition — a bundle id the pass never saw — must
    // fail toward reporting the finding. Suppression is the direction that
    // silently loses evidence, and a silent loss is the one failure mode nobody
    // is told about; a spurious finding is at least reviewable.
    const sha = await sha256Hex(PASTED_CODE);

    const carol = await buildSubmission('carol_proj1.zip', [
      { minute: 0, observed: [CAROL_COMMIT], paste: PASTED_CODE, pasteSha: sha },
    ]);
    const dave = await buildSubmission('dave_proj1.zip', [
      { minute: 240, observed: [CAROL_COMMIT], paste: PASTED_CODE, pasteSha: sha },
    ]);

    const features = [featuresOf(carol), featuresOf(dave)];
    // They ARE one lineage under their own partition, so this proves the flag
    // comes back purely because the partition handed in knows neither of them.
    expect(partitionCrossScopes(features).exclusions).toHaveLength(1);

    const emptyPartition = partitionCrossScopes([]);
    const paste = pasteSharedAcrossStudentsHeuristic.run(
      features,
      DEFAULT_CROSS_HEURISTIC_CONFIG,
      emptyPartition,
    );
    const clone = editingPatternCloneHeuristic.run(
      features,
      DEFAULT_CROSS_HEURISTIC_CONFIG,
      emptyPartition,
    );

    expect(paste).toHaveLength(1);
    expect(clone.length).toBeGreaterThan(0);
  });

  it('STILL fires between a partner and an outsider who shares the same paste', async () => {
    // A three-way group: Alice and Bob are partners; Carol is not. Suppressing
    // the partner pair must not suppress either partner against Carol.
    const sha = await sha256Hex(PASTED_CODE);

    const aliceSession: SessionSpec = {
      minute: 0,
      observed: [ALICE_COMMIT],
      paste: PASTED_CODE,
      pasteSha: sha,
    };
    const bobSession: SessionSpec = { minute: 60, observed: [ALICE_COMMIT, BOB_COMMIT] };

    const alice = await buildSubmission('alice_proj1.zip', [aliceSession, bobSession]);
    const bob = await buildSubmission('bob_proj1.zip', [aliceSession, bobSession]);
    const carol = await buildSubmission('carol_proj1.zip', [
      { minute: 600, observed: [CAROL_COMMIT], paste: PASTED_CODE, pasteSha: sha },
    ]);

    const flags = pasteFlags(
      runCrossHeuristics([featuresOf(alice), featuresOf(bob), featuresOf(carol)]),
    );

    expect(flags).toHaveLength(1);
    expect(flags[0]!.bundleIds).toHaveLength(3);
    // The finding is real — a paste in Carol's bundle matches one in a
    // repository she is not part of. All three are named because all three do
    // hold the content; the exclusion register says which two of them are one
    // repository.
    expect(flags[0]!.severity).toBe('high');
  });
});
