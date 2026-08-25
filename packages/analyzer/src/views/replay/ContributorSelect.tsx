/**
 * ContributorSelect — which contributor the playhead is currently inside, plus
 * random access to any other contributor in the submission.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §5.1
 * (contributor) and §6 (presenting ambiguity). Tier 5.3.
 *
 * The same two-jobs-in-one shape as its neighbour {@link SessionSelect}, one
 * level up:
 *
 *   1. A LIVE READOUT of whose session the playhead sits in, derived from engine
 *      state, so it changes on its own as playback crosses a seam.
 *   2. A SEEK to a contributor's first recorded event. It does NOT re-scope the
 *      engine and it does NOT filter the stream.
 *
 * ## Why seeking, and not filtering
 *
 * A control that hid the other contributor's events would produce, on screen, a
 * single-contributor reading of a collaborative submission — which is the
 * fabrication this whole tier exists to prevent. Worse, it would give the
 * concurrent case an escape hatch: "just look at Alice's" is how a grader ends
 * up believing they saw the file. So this moves the playhead and nothing else.
 *
 * ## The grouping rules, which are the load-bearing part
 *
 * The option list is `BundleContributors.contributors` exactly as analysis-core
 * resolved it. That is deliberate rather than lazy — the grouping rules are
 * subtle and re-deriving them here would eventually get one of them wrong:
 *
 *  - Attributed sessions group by verified `student_ref`, so a student's two
 *    machines are ONE contributor (decision D5) even though the two sessions
 *    share no key material.
 *  - Unattributed sessions are singleton pseudo-contributors. Two of them are
 *    never merged (two unenrolled people look exactly like one person recording
 *    twice) and are never asserted distinct either.
 *  - An unverifiable session is its own contributor and is NEVER folded into the
 *    student it claims to be — folding is precisely how a forged identity block
 *    would launder work onto an innocent student.
 */

import { useMemo } from 'react';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { BundleContributors } from '@provenance/analysis-core/identity/types.js';
import { labelContributor } from './contributor-labels.js';

type ContributorSelectProps = {
  /**
   * The bundle's contributor stamp, or `null` when there is none.
   *
   * `null` is the ordinary case, not an error: the server-backed Replay tab
   * builds its index from API rows and has no parsed Bundle, and an unstamped
   * bundle reads as fully unattributed by design. Both render nothing here
   * rather than an empty or apologetic control.
   */
  contributors: BundleContributors | null;
  /** Whole-bundle index. Seek targets come from `bySessionId`. */
  index: EventIndex;
  /** The session the playhead is inside — engine-derived, not URL-derived. */
  currentSessionId: string;
  /** Seek the whole-bundle playhead to this globalIdx. */
  onSeek(globalIdx: number): void;
};

export function ContributorSelect({
  contributors,
  index,
  currentSessionId,
  onSeek,
}: ContributorSelectProps) {
  const options = useMemo(() => {
    if (contributors === null) return [];
    return contributors.contributors.map((c) => ({
      key: c.key,
      label: labelContributor(c),
      /**
       * The earliest event this contributor recorded, over the sessions the
       * index actually holds. `sessionIds` is in bundle order, but a session can
       * be present in the stamp and absent from the index, so the minimum is
       * taken over what is really there rather than over `sessionIds[0]`.
       */
      firstGlobalIdx: c.sessionIds.reduce<number | null>((best, sessionId) => {
        const first = index.bySessionId.get(sessionId)?.[0];
        if (first === undefined) return best;
        return best === null || first.globalIdx < best ? first.globalIdx : best;
      }, null),
    }));
  }, [contributors, index]);

  // Nothing to choose between. One contributor is the overwhelmingly common
  // case (every solo submission), and it renders exactly as it did before this
  // control existed — no empty select, no "1 of 1".
  if (options.length <= 1) return null;

  const currentKey = contributors?.bySession.get(currentSessionId)?.contributorKey ?? '';

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const target = options.find((o) => o.key === e.target.value);
    if (target?.firstGlobalIdx != null) onSeek(target.firstGlobalIdx);
  }

  const current = options.find((o) => o.key === currentKey) ?? null;

  return (
    <div
      className="flex shrink-0 items-center gap-2 border-r pr-3"
      data-testid="replay-contributor-switcher"
      data-contributor-count={options.length}
    >
      <select
        aria-label="Contributor"
        value={currentKey}
        onChange={handleChange}
        className="max-w-[22rem] rounded-md border bg-background px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        data-testid="replay-contributor-select"
      >
        {/*
          When the playhead sits in a session the stamp does not cover, no option
          matches and a bare <select> would silently display the FIRST one —
          naming a contributor the playhead is not inside. An explicit empty
          option holds that state instead.
        */}
        {current === null && (
          <option value="" data-testid="replay-contributor-unresolved">
            Contributor not resolved for this session
          </option>
        )}
        {options.map((o) => (
          <option key={o.key} value={o.key} data-tone={o.label.tone}>
            {o.label.short}
          </option>
        ))}
      </select>
      {current !== null && (
        <span
          className="min-w-0 max-w-[18rem] truncate text-xs text-muted-foreground"
          data-testid="replay-contributor-detail"
          data-tone={current.label.tone}
          title={current.label.detail}
        >
          {current.label.detail}
        </span>
      )}
    </div>
  );
}
