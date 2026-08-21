/**
 * The three `session.start` capability reports, read off a real bundle
 * (collaboration spec §5.6).
 *
 * ## What these tests are protecting
 *
 * The trap this whole change walks into is decision-log bug 12: an assertion
 * about an ABSENT value is only meaningful if you know what the consumer does
 * with absence. Absence is the UNIVERSAL case here — no recorder shipped to date
 * emits any of these fields — so the first block below drives a bundle carrying
 * none of them and pins what every consumer concludes from it. If any of those
 * conclusions were `unavailable` / `impossible` / `not_watched`, every archived
 * submission would start asserting that its own capture was broken.
 *
 * The second thing under protection is the `unavailable` / `not_owned`
 * distinction. They lead to the same consequence (no `git.event`) and are
 * different facts (no git integration on the machine vs. the assignment sitting
 * outside every repository git could see). A grader acts differently on the two.
 */

import { describe, it, expect } from 'vitest';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { loadBundle } from '../loader/parse-bundle.js';
import type { Bundle } from '../loader/types.js';
import {
  readBundleCapabilities,
  wasFileWatched,
  gitObservationGap,
} from './session-capabilities.js';

/** A bundle whose sessions carry exactly the given `session.start` extras. */
async function scope(...sessionStarts: Array<Record<string, unknown>>): Promise<Bundle> {
  const { zipBuffer } = await buildTestBundle({
    sessions: sessionStarts.map((sessionStart) => ({ eventCount: 2, sessionStart })),
  });
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// Absence — the universal case
// ---------------------------------------------------------------------------

describe('a bundle whose recorder reports no capabilities at all', () => {
  it('reads all three as UNREPORTED, never as a missing capability', async () => {
    // This is EVERY bundle in existence. `{}` is not a special fixture — it is
    // production, for every submission recorded before §5.6 landed.
    const bundle = await scope({}, {});
    const facts = readBundleCapabilities(bundle);

    expect(facts.counts.sessions).toBe(2);
    expect(facts.counts.gitUnreported).toBe(2);
    expect(facts.counts.witnessUnreported).toBe(2);
    expect(facts.counts.fileScopeUnreported).toBe(2);

    // Nothing was reported as broken.
    expect(facts.counts.gitUnavailable).toBe(0);
    expect(facts.counts.gitNotOwned).toBe(0);
    expect(facts.counts.witnessUnavailable).toBe(0);
    expect(facts.counts.gitMalformed).toBe(0);
    expect(facts.counts.witnessMalformed).toBe(0);
    expect(facts.counts.fileScopeMalformed).toBe(0);
  });

  it('summarizes git and witnessing as UNKNOWN — not impossible', async () => {
    const facts = readBundleCapabilities(await scope({}, {}));
    expect(facts.gitObservation).toBe('unknown');
    expect(facts.witnessing).toBe('unknown');
    expect(facts.gitImpossibleReason).toBeNull();
  });

  it('answers "was this file watched?" with UNKNOWN — the ambiguity that exists today', async () => {
    const facts = readBundleCapabilities(await scope({}, {}));
    expect(wasFileWatched(facts, 'Solver.java')).toBe('unknown');
    expect(facts.watchedFiles).toEqual([]);
  });

  it('classifies every silent session as silent-and-UNREPORTED', async () => {
    const facts = readBundleCapabilities(await scope({}, {}));
    const gap = gitObservationGap(facts, new Set());
    expect(gap).toEqual({
      sessions: 2,
      observing: 0,
      silentAndIncapable: 0,
      silentThoughCapable: 0,
      silentAndUnreported: 2,
    });
  });
});

// ---------------------------------------------------------------------------
// §5.6 item 2 — git
// ---------------------------------------------------------------------------

describe('git capture', () => {
  it('counts the three values apart', async () => {
    const facts = readBundleCapabilities(
      await scope(
        { git_capture: 'available' },
        { git_capture: 'unavailable' },
        { git_capture: 'not_owned' },
      ),
    );
    expect(facts.counts.gitAvailable).toBe(1);
    expect(facts.counts.gitUnavailable).toBe(1);
    expect(facts.counts.gitNotOwned).toBe(1);
    expect(facts.counts.gitUnreported).toBe(0);
  });

  it('says AVAILABLE when any session could observe, even beside one that could not', async () => {
    // One partner's machine has no git integration; the other's does. The scope
    // had git observation.
    const facts = readBundleCapabilities(
      await scope({ git_capture: 'unavailable' }, { git_capture: 'available' }),
    );
    expect(facts.gitObservation).toBe('available');
    expect(facts.gitImpossibleReason).toBeNull();
  });

  it('says IMPOSSIBLE, with a reason, when every session reported it could not', async () => {
    const unavailable = readBundleCapabilities(
      await scope({ git_capture: 'unavailable' }, { git_capture: 'unavailable' }),
    );
    expect(unavailable.gitObservation).toBe('impossible');
    expect(unavailable.gitImpossibleReason).toBe('unavailable');

    const notOwned = readBundleCapabilities(
      await scope({ git_capture: 'not_owned' }, { git_capture: 'not_owned' }),
    );
    expect(notOwned.gitObservation).toBe('impossible');
    expect(notOwned.gitImpossibleReason).toBe('not_owned');
  });

  it('keeps UNAVAILABLE and NOT_OWNED apart in the reason, and in the counts', async () => {
    // The whole point of §5.6 item 2. "No git integration on this machine" and
    // "the assignment sits outside every repository git could see" are different
    // situations a grader acts on differently, and they reach the same
    // consequence — so nothing but this distinction separates them.
    const unavailable = readBundleCapabilities(await scope({ git_capture: 'unavailable' }));
    const notOwned = readBundleCapabilities(await scope({ git_capture: 'not_owned' }));
    expect(unavailable.gitImpossibleReason).not.toBe(notOwned.gitImpossibleReason);
    expect(unavailable.counts.gitUnavailable).toBe(1);
    expect(unavailable.counts.gitNotOwned).toBe(0);
    expect(notOwned.counts.gitUnavailable).toBe(0);
    expect(notOwned.counts.gitNotOwned).toBe(1);
  });

  it('reports a MIXED reason rather than picking one of the two', async () => {
    const facts = readBundleCapabilities(
      await scope({ git_capture: 'unavailable' }, { git_capture: 'not_owned' }),
    );
    expect(facts.gitObservation).toBe('impossible');
    expect(facts.gitImpossibleReason).toBe('mixed');
  });

  it('falls back to UNKNOWN when one session said nothing — it might have been the capable one', async () => {
    const facts = readBundleCapabilities(await scope({ git_capture: 'unavailable' }, {}));
    expect(facts.gitObservation).toBe('unknown');
    expect(facts.gitImpossibleReason).toBeNull();
  });

  it('treats a value outside the enum as MALFORMED, and never as a capability', async () => {
    const facts = readBundleCapabilities(await scope({ git_capture: 'sort-of' }));
    expect(facts.counts.gitMalformed).toBe(1);
    expect(facts.counts.gitAvailable).toBe(0);
    expect(facts.counts.gitUnavailable).toBe(0);
    expect(facts.counts.gitNotOwned).toBe(0);
    // A nonconforming writer must not be able to assert a capability by
    // inventing a word for it.
    expect(facts.gitObservation).toBe('unknown');
    expect(facts.sessions[0]!.git).toEqual({ kind: 'malformed', problem: 'unknown_value' });
  });

  it('does not let a malformed report make the scope look INCAPABLE either', async () => {
    // Both directions are wrong. `unknown` is the only honest answer.
    const facts = readBundleCapabilities(
      await scope({ git_capture: 'unavailable' }, { git_capture: 42 }),
    );
    expect(facts.gitObservation).toBe('unknown');
  });
});

describe('gitObservationGap', () => {
  it('separates silence that IS explained from silence that is not', async () => {
    const bundle = await scope(
      { git_capture: 'available' },
      { git_capture: 'available' },
      { git_capture: 'unavailable' },
      {},
    );
    const facts = readBundleCapabilities(bundle);
    const observing = new Set([bundle.sessions[0]!.sessionId]);
    expect(gitObservationGap(facts, observing)).toEqual({
      sessions: 4,
      observing: 1,
      // Session 2 could not observe git at all.
      silentAndIncapable: 1,
      // Session 1 could, and saw nothing. That is a statement about git
      // activity, and it is NOT evidence of anything.
      silentThoughCapable: 1,
      // Session 3 said nothing.
      silentAndUnreported: 1,
    });
  });

  it('counts a not_owned session as incapable, same as unavailable — the CONSEQUENCE is shared', async () => {
    const facts = readBundleCapabilities(await scope({ git_capture: 'not_owned' }));
    expect(gitObservationGap(facts, new Set()).silentAndIncapable).toBe(1);
    // ...while the REASON stays distinguishable on the facts themselves.
    expect(facts.counts.gitNotOwned).toBe(1);
  });

  it('counts a malformed report as unreported, never as incapable', async () => {
    const facts = readBundleCapabilities(await scope({ git_capture: 'nope' }));
    const gap = gitObservationGap(facts, new Set());
    expect(gap.silentAndUnreported).toBe(1);
    expect(gap.silentAndIncapable).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §5.6 item 3 — witnessing
// ---------------------------------------------------------------------------

describe('witness capture', () => {
  it('reads both values and summarizes them', async () => {
    const available = readBundleCapabilities(await scope({ witness_capture: 'available' }));
    expect(available.witnessing).toBe('available');
    expect(available.counts.witnessAvailable).toBe(1);

    const unavailable = readBundleCapabilities(await scope({ witness_capture: 'unavailable' }));
    expect(unavailable.witnessing).toBe('impossible');
    expect(unavailable.counts.witnessUnavailable).toBe(1);
  });

  it('falls back to UNKNOWN when one session said nothing', async () => {
    const facts = readBundleCapabilities(await scope({ witness_capture: 'unavailable' }, {}));
    expect(facts.witnessing).toBe('unknown');
  });

  it('rejects git_capture’s third value here rather than inventing a meaning', async () => {
    const facts = readBundleCapabilities(await scope({ witness_capture: 'not_owned' }));
    expect(facts.counts.witnessMalformed).toBe(1);
    expect(facts.witnessing).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// §5.6 item 1 — the effective resolved file set
// ---------------------------------------------------------------------------

describe('the resolved file set', () => {
  it('answers WATCHED for a path a session names', async () => {
    const facts = readBundleCapabilities(
      await scope({ file_scope: { watched: ['Solver.java', 'src/Board.java'], complete: true } }),
    );
    expect(wasFileWatched(facts, 'Solver.java')).toBe('watched');
    expect(wasFileWatched(facts, 'src/Board.java')).toBe('watched');
    expect(facts.watchedFiles).toEqual(['Solver.java', 'src/Board.java']);
  });

  it('answers NOT_WATCHED only when every session reported a COMPLETE set', async () => {
    // This is the answer that makes "no events for this file" unambiguous, and
    // it is the only one that lets a file-scoped heuristic say "not applicable"
    // instead of implying there was nothing to find.
    const facts = readBundleCapabilities(
      await scope(
        { file_scope: { watched: ['Solver.java'], complete: true } },
        { file_scope: { watched: ['Solver.java'], complete: true } },
      ),
    );
    expect(wasFileWatched(facts, 'Secret.java')).toBe('not_watched');
  });

  it('answers UNKNOWN when any session did not report, even if another did', async () => {
    const facts = readBundleCapabilities(
      await scope({ file_scope: { watched: ['Solver.java'], complete: true } }, {}),
    );
    expect(wasFileWatched(facts, 'Secret.java')).toBe('unknown');
    // ...and a positive match still stands, because membership needs no
    // unanimity.
    expect(wasFileWatched(facts, 'Solver.java')).toBe('watched');
  });

  it('never answers NOT_WATCHED off a TRUNCATED list — the path may be in the part that was cut', async () => {
    const facts = readBundleCapabilities(
      await scope({ file_scope: { watched: ['Solver.java'], complete: false } }),
    );
    expect(wasFileWatched(facts, 'Secret.java')).toBe('unknown');
    expect(wasFileWatched(facts, 'Solver.java')).toBe('watched');
    expect(facts.counts.fileScopeIncomplete).toBe(1);
  });

  it('treats an EMPTY complete set as a real answer, not as absence', async () => {
    // "The scope resolved to nothing" is a positive claim: every file's silence
    // is explained.
    const facts = readBundleCapabilities(
      await scope({ file_scope: { watched: [], complete: true } }),
    );
    expect(facts.counts.fileScopeReported).toBe(1);
    expect(facts.counts.fileScopeUnreported).toBe(0);
    expect(wasFileWatched(facts, 'Solver.java')).toBe('not_watched');
  });

  it('discards a set containing an absolute path WHOLE, and answers UNKNOWN', async () => {
    // S14(b): an absolute path embeds the account name and the machine layout.
    // Dropping only the offending entry would leave a silently narrowed list
    // that says "not watched" about a file that was.
    const facts = readBundleCapabilities(
      await scope({
        file_scope: {
          watched: ['Solver.java', '/Users/student/cs61b/Secret.java'],
          complete: true,
        },
      }),
    );
    expect(facts.counts.fileScopeMalformed).toBe(1);
    expect(facts.counts.fileScopeReported).toBe(0);
    expect(facts.watchedFiles).toEqual([]);
    expect(wasFileWatched(facts, 'Solver.java')).toBe('unknown');
  });

  it('never lets a rejected path reach the union a UI would render', async () => {
    const facts = readBundleCapabilities(
      await scope({
        file_scope: {
          watched: ['https://github.com/some-student/proj2/Solver.java'],
          complete: true,
        },
      }),
    );
    expect(facts.watchedFiles).toEqual([]);
    expect(facts.sessions[0]!.fileScope).toEqual({
      kind: 'malformed',
      problem: 'path_has_colon',
    });
  });

  it('unions and sorts the sets across sessions, deduplicating', async () => {
    const facts = readBundleCapabilities(
      await scope(
        { file_scope: { watched: ['b.py', 'a.py'], complete: true } },
        { file_scope: { watched: ['a.py', 'c.py'], complete: true } },
      ),
    );
    expect(facts.watchedFiles).toEqual(['a.py', 'b.py', 'c.py']);
  });

  it('compares paths verbatim rather than normalizing separators', async () => {
    // Deliberate: normalizing here would make two recorders' spellings compare
    // equal on this one axis and unequal everywhere else in the log.
    const facts = readBundleCapabilities(
      await scope({ file_scope: { watched: ['src/Board.java'], complete: true } }),
    );
    expect(wasFileWatched(facts, 'src/Board.java')).toBe('watched');
    expect(wasFileWatched(facts, 'src\\Board.java')).toBe('not_watched');
  });
});

// ---------------------------------------------------------------------------
// Independence
// ---------------------------------------------------------------------------

describe('the three reports are independent', () => {
  it('a recorder may report one and not the others', async () => {
    const facts = readBundleCapabilities(await scope({ git_capture: 'available' }));
    expect(facts.gitObservation).toBe('available');
    expect(facts.witnessing).toBe('unknown');
    expect(wasFileWatched(facts, 'Solver.java')).toBe('unknown');
  });

  it('reports every session, in bundle order, with no session omitted', async () => {
    const bundle = await scope({ git_capture: 'available' }, {}, { witness_capture: 'available' });
    const facts = readBundleCapabilities(bundle);
    expect(facts.sessions.map((s) => s.sessionId)).toEqual(
      bundle.sessions.map((s) => s.sessionId),
    );
  });
});
