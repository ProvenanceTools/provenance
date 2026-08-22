/**
 * The same-scope exclusion for a partner pair that never ran git — driven
 * through the real loader, the real index, the real feature extraction and the
 * real cross-heuristics.
 *
 * `same-scope-exclusion.test.ts` covers the S20 shape the commit key was built
 * for. Every fixture in it emits `git.event`s, which is why the gap below
 * survived: the commit key is a PROXY for "each archive holds the other's
 * recorded sessions", and git observation is an optional capability
 * (`GIT_CAPTURE_VALUES` in `log-core/session-capabilities.ts` is `available` /
 * `unavailable` / `not_owned`, and provnvim reports only the first two). A
 * shared `.provenance/` on a host with no git integration, a pair committing
 * from a terminal outside their sessions, two people on one laptop or a synced
 * folder — all of them produce the S20 archives with ZERO observed commits, and
 * before the session key they fired `paste_shared_across_students` at
 * high / 0.95 on the two people the course assigned to work together.
 *
 * ## What the fixture is, and why the keypair is the whole control
 *
 * `buildTestBundle` mints DETERMINISTIC logical session ids, so every bundle in
 * this repo already shares session ids with every other one. That is exactly
 * why the exclusion key is not a bare uuid: it is
 * `sessionNodeKey(session_pubkey, session_id)`. The partner fixtures pin one
 * `sessionPrivkeyHex` across both archives — which is what physically sharing
 * one `.slog` means — and the unrelated-students control lets both archives take
 * their own random keypair. The ids collide in BOTH cases; only the partners'
 * keys do.
 */

import { describe, expect, it } from 'vitest';
import { buildIndex } from '../../index/build-index.js';
import { loadBundle } from '../../loader/parse-bundle.js';
import { buildTestBundle } from '../../test-support/build-test-bundle.js';
import { partitionCrossScopes } from '../../coverage/cross-scope.js';
import { extractCrossFeatures } from './features.js';
import { runCrossHeuristics } from './run-cross-heuristics.js';
import type { Bundle } from '../../loader/types.js';
import type { EventIndex } from '../../index/event-index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MS = new Date('2026-03-02T09:00:00.000Z').getTime();
const wallAt = (min: number) => new Date(BASE_MS + min * 60_000).toISOString();

/** The 32-byte seed both partners' archives are built from. See the header. */
const SHARED_SEED = '7c'.repeat(32);

const PASTED_CODE = [
  'public static int[] mergeSort(int[] a, int lo, int hi) {',
  '    if (hi - lo < 2) return a;',
  '    int mid = lo + (hi - lo) / 2;',
  '    mergeSort(a, lo, mid);',
  '    mergeSort(a, mid, hi);',
  '    return merge(a, lo, mid, hi);',
  '}',
].join('\n');

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

type SessionSpec = { minute: number; paste?: string; pasteSha?: string };

/** A session with NO `git.event` of any kind — the point of the file. */
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

  events.push({ kind: 'session.end', data: { reason: 'deactivate' }, ...at() });
  return events;
}

async function buildSubmission(
  sourceFilename: string,
  specs: readonly SessionSpec[],
  /** Omit for an independent keypair — the unrelated-students control. */
  sessionPrivkeyHex?: string,
): Promise<{ bundle: Bundle; index: EventIndex }> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId: 'proj1',
    sessions: specs.map((s) => ({ walls: [wallAt(s.minute)], events: sessionEvents(s) })),
    ...(sessionPrivkeyHex === undefined ? {} : { sessionPrivkeyHex }),
  });
  const result = await loadBundle(new Blob([zipBuffer]), sourceFilename);
  if (!result.ok) throw new Error(`fixture failed to load: ${JSON.stringify(result.error)}`);
  return { bundle: result.value, index: buildIndex(result.value) };
}

const featuresOf = (loaded: { bundle: Bundle; index: EventIndex }) =>
  extractCrossFeatures(loaded.bundle, loaded.index);

const byId = (flags: ReturnType<typeof runCrossHeuristics>, id: string) =>
  flags.filter((f) => f.heuristic === id);

// ---------------------------------------------------------------------------

describe('two honest partners sharing a workspace, with no git at all', () => {
  /** Both archives carry both `.slog` files — the add-only `.provenance/`. */
  const partnerSessions = (pasteSha: string): SessionSpec[] => [
    { minute: 0, paste: PASTED_CODE, pasteSha },
    { minute: 60 },
  ];

  it('does not fire paste_shared_across_students on the pair', async () => {
    const sha = await sha256Hex(PASTED_CODE);
    const specs = partnerSessions(sha);
    const alice = await buildSubmission('alice_proj1.zip', specs, SHARED_SEED);
    const bob = await buildSubmission('bob_proj1.zip', specs, SHARED_SEED);

    const features = [featuresOf(alice), featuresOf(bob)];

    // The premise, twice over: they really do look identical to the heuristic,
    // and there is NOTHING in the commit key for the old rule to work with.
    expect(features[0]!.pastes[0]!.sha256).toBe(features[1]!.pastes[0]!.sha256);
    expect(features[0]!.observedCommitKeys).toEqual([]);
    expect(features[1]!.observedCommitKeys).toEqual([]);

    expect(byId(runCrossHeuristics(features), 'paste_shared_across_students')).toEqual([]);
  });

  it('does not fire editing_pattern_clone on the pair either', async () => {
    const sha = await sha256Hex(PASTED_CODE);
    const specs = partnerSessions(sha);
    const alice = await buildSubmission('alice_proj1.zip', specs, SHARED_SEED);
    const bob = await buildSubmission('bob_proj1.zip', specs, SHARED_SEED);

    const flags = runCrossHeuristics([featuresOf(alice), featuresOf(bob)]);
    expect(byId(flags, 'editing_pattern_clone')).toEqual([]);
  });

  it('states the exclusion visibly, naming the sessions and claiming no repository', async () => {
    // The assertion that makes the two above honest: a grader reading "no
    // findings" must be able to tell a searched comparison from a withheld one.
    // And the reason must be the narrow one — these two never ran git, so
    // "same repository lineage" would be a claim the record cannot support.
    const sha = await sha256Hex(PASTED_CODE);
    const specs = partnerSessions(sha);
    const alice = await buildSubmission('alice_proj1.zip', specs, SHARED_SEED);
    const bob = await buildSubmission('bob_proj1.zip', specs, SHARED_SEED);

    const partition = partitionCrossScopes([featuresOf(alice), featuresOf(bob)]);

    expect(partition.exclusions).toHaveLength(1);
    const ex = partition.exclusions[0]!;
    expect(ex.reason).toBe('shared_recording_scope');
    expect(ex.sourceFilenames).toEqual(['alice_proj1.zip', 'bob_proj1.zip']);
    expect(ex.excludedPairCount).toBe(1);
    expect(ex.sharedCommits).toEqual([]);
    // Both sessions are in both archives, so both prove it.
    expect(ex.sharedSessions).toHaveLength(2);
    for (const key of ex.sharedSessions) expect(key.startsWith('session:')).toBe(true);
  });
});

describe('two unrelated students who merely pasted the same thing', () => {
  it('STILL fires paste_shared_across_students — the negative control', async () => {
    // Same fixture shape, same deterministic session ids, same paste. The only
    // difference is that each archive was signed by its own keypair, which is
    // what NOT sharing a `.provenance/` means. If this ever goes quiet the fix
    // has switched the flagship detector off rather than narrowed it.
    const sha = await sha256Hex(PASTED_CODE);
    const specs: SessionSpec[] = [{ minute: 0, paste: PASTED_CODE, pasteSha: sha }];
    const carol = await buildSubmission('carol_proj1.zip', specs);
    const dave = await buildSubmission('dave_proj1.zip', specs);

    const features = [featuresOf(carol), featuresOf(dave)];

    // The ids DO collide; only the keys do not. That is the control.
    const idOf = (k: string) => k.slice(k.indexOf(' ') + 1);
    expect(features[0]!.recordedSessionKeys!.map(idOf)).toEqual(
      features[1]!.recordedSessionKeys!.map(idOf),
    );
    expect(features[0]!.recordedSessionKeys).not.toEqual(features[1]!.recordedSessionKeys);

    const flags = runCrossHeuristics(features);
    expect(byId(flags, 'paste_shared_across_students')).toHaveLength(1);
    expect(partitionCrossScopes(features).exclusions).toEqual([]);
  });
});
