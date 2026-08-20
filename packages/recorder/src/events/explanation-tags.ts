/**
 * explanation-tags.ts — tracks recent "explanation" events for formatter/git operations.
 *
 * When an fs.external_change is detected, the wiring checks whether a known
 * benign operation (formatter run, git op) occurred within a recent time window.
 * If so, the emitted fs.external_change carries an `explanation` field (PRD §4.5:
 * "Anything we can't explain stays flagged").
 *
 * Callers invoke markFormatter() or markGit() explicitly; no automatic detection
 * happens here.
 *
 * ## What this is for, now that Tier 3.1 has landed
 *
 * This used to describe itself as a bridge to the analyzer's content-based
 * reclassification. That work has shipped
 * (`analysis-core/src/index/classify-external-changes.ts`, Tier 3.1 of
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md`): an
 * external change whose post-change sha256 equals a state a provably different
 * verified contributor recorded on the same path is `git_merge_in`, which is a
 * cryptographic statement rather than a timing guess, and the three
 * external-change heuristics consume it.
 *
 * **This tagger is deliberately kept, and it is no longer a bridge.** What it
 * covers is precisely what the content test cannot:
 *
 *  - **Scopes the content test never runs on.** Tier 3.1 is gated on a
 *    collaborative scope — a course-signed `collaboration: 'group'` on a
 *    VERIFIED manifest, or two contributors whose enrolment chains both verify.
 *    That gate exists so a solo bundle is byte-for-byte unaffected, and its
 *    consequence is that a solo student who runs `git checkout` gets no verdict
 *    at all. The tag is the only thing that explains their rewritten files. The
 *    same applies to every 1.x bundle and to any cohort that has not enrolled.
 *  - **Content the partner never recorded through an editor.** A pull can
 *    deliver a commit made outside any recording, or a merge resolution git
 *    itself synthesised. Those bytes match nothing, correctly, and the analyzer
 *    calls them `git_unrecorded_in`. The tag still says a git operation was
 *    running, which is a true and independently-sourced fact.
 *  - **`formatter`.** The content test says nothing about formatter runs; this
 *    is the only channel for `explanation: 'formatter'` (PRD §4.5). Note
 *    `markFormatter()` has no production caller today — a separate gap.
 *
 * It is also the only signal of the two that is inside the SIGNED chain at the
 * moment the operation happened; the classification is derived later, by a
 * reader. The analyzer records what this tagger said on each event
 * (`ExternalChangeVerdict.recorderExplanation`) as corroboration, and
 * deliberately does not let it decide the classification.
 *
 * ## Why it is a per-path set and not a single slot
 *
 * The tagger used to hold ONE entry, consumed by the first taker. One `git
 * pull` that rewrites twelve files raises twelve `fs.external_change` events
 * and could explain exactly one of them; the other eleven became
 * `external_edits` findings at medium — or high, once the diff passed 100
 * characters — against a student who did nothing but pull their partner's work.
 * That is the single most damaging false-positive generator in the system (spec
 * §3 S2). So a mark now explains EVERY path that asks within its window, up to
 * {@link DEFAULT_MAX_EXPLAINED_PATHS} distinct paths, rather than being spent by
 * whichever path happened to arrive first.
 *
 * ## What it still does not do, and must not be relied on for
 *
 * Timing-based, so wrong at the edges in both directions:
 *
 *  - a genuine hand edit landing inside the window of an unrelated git command
 *    is explained away (too wide — already true of the single slot, and the
 *    per-path set widens it from one path to the budget);
 *  - a watcher event that arrives more than `windowMs` after the git state
 *    change is unexplained even though the pull caused it (too narrow);
 *  - a pull larger than the budget leaves its tail unexplained (too narrow).
 *
 * In a collaborative scope the content test covers all three. Everywhere else
 * these remain live, and the budget's failure mode is the SAFE one: exceeding it
 * produces findings, it does not hide them.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExplanationKind = 'formatter' | 'git';

/**
 * How many distinct paths one mark may explain.
 *
 * A bound rather than a free-for-all so that a single stale mark cannot explain
 * an unbounded number of external changes, and so the retained path set cannot
 * grow without limit. Sized well above an ordinary pull or checkout (the census
 * case is twelve files) while still being a bound; a rewrite bigger than this
 * leaves its tail unexplained, which surfaces findings rather than hiding them.
 */
export const DEFAULT_MAX_EXPLAINED_PATHS = 64;

/** The default explanation window, in milliseconds. */
export const DEFAULT_EXPLANATION_WINDOW_MS = 2000;

type Mark = {
  kind: ExplanationKind;
  at: number; // timestamp from getNow()
  /** Distinct paths this mark has already explained. Bounded by `_maxPaths`. */
  explained: Set<string>;
};

// ---------------------------------------------------------------------------
// ExplanationTagger
// ---------------------------------------------------------------------------

export class ExplanationTagger {
  private readonly _getNow: () => number;
  private readonly _windowMs: number;
  private readonly _maxPaths: number;
  private _mark: Mark | undefined = undefined;

  constructor(deps: { getNow: () => number; windowMs?: number; maxPaths?: number }) {
    this._getNow = deps.getNow;
    this._windowMs = deps.windowMs ?? DEFAULT_EXPLANATION_WINDOW_MS;
    this._maxPaths = deps.maxPaths ?? DEFAULT_MAX_EXPLAINED_PATHS;
  }

  /**
   * Record that a formatter operation just ran.
   *
   * Starts a fresh mark: a new window and a full path budget. The previous
   * mark, and whatever it had already explained, is discarded.
   */
  markFormatter(): void {
    this._mark = { kind: 'formatter', at: this._getNow(), explained: new Set() };
  }

  /** Record that a git operation just ran. See {@link markFormatter}. */
  markGit(): void {
    this._mark = { kind: 'git', at: this._getNow(), explained: new Set() };
  }

  /**
   * Does the live mark explain an external change to `path`?
   *
   * Returns the mark's kind when the mark is unexpired AND either this path has
   * already been explained by it or the budget has room for one more path.
   * Returns undefined otherwise.
   *
   * Unlike the old single-slot version this does NOT clear the mark: the same
   * `git pull` explains every path it rewrote inside the window, which is the
   * whole point of Tier 3.6.
   *
   * Repeating the same path is idempotent and costs no budget. One write can
   * surface through two detection paths — the fs watcher and the save-time
   * compare in `doc-wiring` — and leaving the second of those unexplained
   * reintroduces exactly the false positive this removes.
   */
  consume(path: string): ExplanationKind | undefined {
    const mark = this._mark;
    if (mark === undefined) return undefined;

    const elapsed = this._getNow() - mark.at;
    if (elapsed >= this._windowMs) {
      // Expired; clear it so it isn't checked again.
      this._mark = undefined;
      return undefined;
    }

    if (mark.explained.has(path)) return mark.kind;
    if (mark.explained.size >= this._maxPaths) return undefined;

    mark.explained.add(path);
    return mark.kind;
  }
}
