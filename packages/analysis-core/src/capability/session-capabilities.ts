/**
 * Reading the three `session.start` capability reports off a bundle —
 * collaboration spec §5.6.
 *
 * The narrowing lives in `log-core/session-capabilities.ts` (one implementation,
 * four consumers, published as conformance vectors). This module is the READER:
 * it walks a bundle's sessions, applies that narrowing, and turns the per-session
 * reads into the two things a consumer actually asks:
 *
 *  1. **Could this session have seen the thing at all?** — so an absence of
 *     `git.event` / `peer.observed` can be read correctly.
 *  2. **Was this file being watched?** — so "no events for `Solver.java`" stops
 *     being ambiguous between _nothing happened_ and _it was never watched_
 *     (S25).
 *
 * ## Nothing here is a finding
 *
 * No `Flag`, no ninth validation check, no severity, no score. **Facts only.**
 * A capability report describes the RECORDER, never the student it recorded, and
 * a bundle that reports nothing is the ordinary case rather than a suspicious
 * one. This module exists to make an existing finding readable — decision D16's
 * `git_unrecorded_in` in particular — and to let a coverage surface say "we
 * could not check" instead of implying "there was nothing to check".
 *
 * ## Unreported is a first-class answer everywhere
 *
 * **Every bundle in existence carries none of these fields**, so every summary
 * this module produces has a third state that means "the recorder did not say".
 * Folding that into "the capability was missing" would make several years of
 * archived submissions assert that their own capture was broken. Every summary
 * below therefore spells `'unknown'` explicitly and never defaults to a verdict.
 *
 * ## Why the bundle-level summaries require unanimity to say "impossible"
 *
 * A bundle is a set of sessions, potentially from several machines. One session
 * saying "git was unavailable to me" does not mean the scope had no git
 * observation — a partner's session may have had it. So `'impossible'` is
 * reached only when NO session reported the capability as available AND every
 * session in the bundle reported at all. A single unreported session takes the
 * answer to `'unknown'`, because that session might have been the capable one.
 * Fail toward not knowing.
 */

import { readFileScope, readGitCapture, readWitnessCapture } from '@provenance/log-core';
import type { FileScopeRead, GitCaptureRead, WitnessCaptureRead } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three reports one session carries, narrowed. */
export type SessionCapabilityFacts = {
  sessionId: string;
  /** §5.6 item 2 — could this session observe git? */
  git: GitCaptureRead;
  /** §5.6 item 3 — could this session witness `.provenance/`? */
  witness: WitnessCaptureRead;
  /** §5.6 item 1 — which files was this session watching? */
  fileScope: FileScopeRead;
};

/**
 * Whether the bundle as a whole could observe git.
 *
 *  - `'available'` — at least one session reported that it could. An absence of
 *    `git.event` from THAT session is a statement about git activity.
 *  - `'impossible'` — every session reported, none could. A scope with no
 *    `git.event` here is fully explained by incapacity, and a
 *    `git_unrecorded_in` finding must be read with that in front of it.
 *  - `'unknown'` — at least one session said nothing, so we cannot conclude.
 *    **This is the state of every bundle in existence.**
 */
export type BundleCapabilitySummary = 'available' | 'impossible' | 'unknown';

/**
 * Why a bundle-level git summary came out `'impossible'`, when it did.
 *
 * Kept separate from the summary because `'unavailable'` and `'not_owned'` are
 * different situations with the same consequence: one says the machine had no
 * git integration, the other says git worked and the assignment sat outside
 * every repository it could see. A grader acts differently on the two, and
 * collapsing them is the whole thing §5.6 item 2 exists to prevent.
 */
export type GitImpossibleReason = 'unavailable' | 'not_owned' | 'mixed' | null;

export type CapabilityCounts = {
  /** Sessions in the bundle. The denominator for everything below. */
  sessions: number;

  gitAvailable: number;
  gitUnavailable: number;
  gitNotOwned: number;
  /** Sessions whose recorder does not report git capture. Never a defect. */
  gitUnreported: number;
  /** Sessions that reported a git value this format does not define. */
  gitMalformed: number;

  witnessAvailable: number;
  witnessUnavailable: number;
  witnessUnreported: number;
  witnessMalformed: number;

  /** Sessions carrying a usable file scope, complete or not. */
  fileScopeReported: number;
  /** Of those, how many said their list was a strict subset. */
  fileScopeIncomplete: number;
  fileScopeUnreported: number;
  fileScopeMalformed: number;
};

/** Everything §5.6 makes available about one bundle. */
export type BundleCapabilityFacts = {
  /** One entry per session, in bundle order. Total — no session is omitted. */
  sessions: readonly SessionCapabilityFacts[];
  counts: CapabilityCounts;
  /** @see {@link BundleCapabilitySummary} */
  gitObservation: BundleCapabilitySummary;
  /** Populated only when {@link BundleCapabilityFacts.gitObservation} is `'impossible'`. */
  gitImpossibleReason: GitImpossibleReason;
  /** @see {@link BundleCapabilitySummary} */
  witnessing: BundleCapabilitySummary;
  /**
   * The union of every session's watched list, sorted, deduplicated.
   *
   * Present for display. It is NOT the basis of {@link wasFileWatched}, which
   * has to reason about completeness as well as membership.
   */
  watchedFiles: readonly string[];
};

/**
 * Whether a given path was under observation somewhere in this bundle.
 *
 *  - `'watched'` — some session names it. Absence of events for it means the
 *    events did not happen.
 *  - `'not_watched'` — every session reported a COMPLETE file scope and none
 *    names it. Absence of events for it is fully explained, and any file-scoped
 *    heuristic reasoning about it should report _not applicable_ rather than a
 *    flag or a zero.
 *  - `'unknown'` — at least one session did not report, reported a truncated
 *    list, or reported one that could not be read. **This is the state of every
 *    bundle in existence**, and it is exactly the ambiguity that exists today.
 */
export type WatchedFileAnswer = 'watched' | 'not_watched' | 'unknown';

/**
 * How much of a bundle's git silence the capability reports explain.
 *
 * Pairs the §5.6 item 2 reports with what the commit DAG actually saw, which is
 * the shape a coverage surface needs: "3 sessions observed commits, 2 could not
 * observe git at all" is a different sentence from "2 sessions observed no
 * commits".
 */
export type GitObservationGap = {
  /** Sessions in the bundle. */
  sessions: number;
  /** Sessions that produced at least one `git.event` carrying a commit sha. */
  observing: number;
  /**
   * Sessions that observed nothing AND reported that they could not — the
   * silence these explain.
   */
  silentAndIncapable: number;
  /**
   * Sessions that observed nothing and reported that git WAS available. Their
   * silence is a statement about git activity, not about capture.
   */
  silentThoughCapable: number;
  /**
   * Sessions that observed nothing and said nothing about their capability.
   * **Every session of every bundle in existence lands here.** Their silence
   * remains exactly as ambiguous as it is today.
   */
  silentAndUnreported: number;
};

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function emptyCounts(): CapabilityCounts {
  return {
    sessions: 0,
    gitAvailable: 0,
    gitUnavailable: 0,
    gitNotOwned: 0,
    gitUnreported: 0,
    gitMalformed: 0,
    witnessAvailable: 0,
    witnessUnavailable: 0,
    witnessUnreported: 0,
    witnessMalformed: 0,
    fileScopeReported: 0,
    fileScopeIncomplete: 0,
    fileScopeUnreported: 0,
    fileScopeMalformed: 0,
  };
}

/**
 * Read every session's capability reports.
 *
 * Pure and total. A session whose `session.start` payload carries none of the
 * fields — which is every session recorded to date — yields three `'absent'`
 * reads and contributes nothing but an `unreported` count.
 */
export function readBundleCapabilities(bundle: Bundle): BundleCapabilityFacts {
  const sessions: SessionCapabilityFacts[] = [];
  const counts = emptyCounts();
  const watched = new Set<string>();

  for (const session of bundle.sessions) {
    const data = session.firstEvent.data;
    const git = readGitCapture(data);
    const witness = readWitnessCapture(data);
    const fileScope = readFileScope(data);
    sessions.push({ sessionId: session.sessionId, git, witness, fileScope });

    counts.sessions += 1;

    if (git.kind === 'absent') counts.gitUnreported += 1;
    else if (git.kind === 'malformed') counts.gitMalformed += 1;
    else if (git.capture === 'available') counts.gitAvailable += 1;
    else if (git.capture === 'unavailable') counts.gitUnavailable += 1;
    else counts.gitNotOwned += 1;

    if (witness.kind === 'absent') counts.witnessUnreported += 1;
    else if (witness.kind === 'malformed') counts.witnessMalformed += 1;
    else if (witness.capture === 'available') counts.witnessAvailable += 1;
    else counts.witnessUnavailable += 1;

    if (fileScope.kind === 'absent') counts.fileScopeUnreported += 1;
    else if (fileScope.kind === 'malformed') counts.fileScopeMalformed += 1;
    else {
      counts.fileScopeReported += 1;
      if (!fileScope.complete) counts.fileScopeIncomplete += 1;
      for (const p of fileScope.watched) watched.add(p);
    }
  }

  return {
    sessions,
    counts,
    gitObservation: summarizeGit(counts),
    gitImpossibleReason: gitImpossibleReason(counts),
    witnessing: summarizeWitness(counts),
    watchedFiles: [...watched].sort(),
  };
}

/**
 * `'impossible'` requires unanimity AND full reporting — see the module
 * docstring. A single unreported session takes the answer to `'unknown'`.
 */
function summarizeGit(c: CapabilityCounts): BundleCapabilitySummary {
  if (c.gitAvailable > 0) return 'available';
  if (c.sessions === 0) return 'unknown';
  if (c.gitUnreported > 0 || c.gitMalformed > 0) return 'unknown';
  return 'impossible';
}

function gitImpossibleReason(c: CapabilityCounts): GitImpossibleReason {
  if (summarizeGit(c) !== 'impossible') return null;
  if (c.gitUnavailable > 0 && c.gitNotOwned > 0) return 'mixed';
  if (c.gitNotOwned > 0) return 'not_owned';
  return 'unavailable';
}

function summarizeWitness(c: CapabilityCounts): BundleCapabilitySummary {
  if (c.witnessAvailable > 0) return 'available';
  if (c.sessions === 0) return 'unknown';
  if (c.witnessUnreported > 0 || c.witnessMalformed > 0) return 'unknown';
  return 'impossible';
}

// ---------------------------------------------------------------------------
// The question §5.6 item 1 exists to answer
// ---------------------------------------------------------------------------

/**
 * Was `path` under observation anywhere in this bundle?
 *
 * The three answers are not interchangeable and the third is what makes the
 * second safe — see {@link WatchedFileAnswer}. In particular a TRUNCATED list
 * can prove `'watched'` (the path is in it) but can never prove `'not_watched'`
 * (the path may be in the part that was cut).
 *
 * Paths are compared verbatim. This function deliberately does NOT normalize
 * separators or resolve `.` segments: a writer emits assignment-root-relative
 * paths in the same spelling the rest of the log uses, and normalizing here
 * would quietly make two different recorders' spellings compare equal on this
 * one axis and unequal everywhere else.
 */
export function wasFileWatched(facts: BundleCapabilityFacts, path: string): WatchedFileAnswer {
  let everySessionComplete = facts.counts.sessions > 0;
  for (const session of facts.sessions) {
    if (session.fileScope.kind !== 'recorded') {
      everySessionComplete = false;
      continue;
    }
    if (session.fileScope.watched.includes(path)) return 'watched';
    if (!session.fileScope.complete) everySessionComplete = false;
  }
  return everySessionComplete ? 'not_watched' : 'unknown';
}

// ---------------------------------------------------------------------------
// Pairing item 2 with what the commit graph actually saw
// ---------------------------------------------------------------------------

/**
 * Split the bundle's git silence into the part the capability reports explain
 * and the part they do not.
 *
 * `sessionsObserving` is taken from the caller rather than recomputed, so this
 * cannot drift from the observed DAG's own count: pass the set of session ids
 * that produced at least one commit observation (`ObservedDag.observations`).
 *
 * Never a finding. `silentThoughCapable` in particular is NOT evidence of
 * anything — a student who simply did not run a git command all session
 * produces it, and that is the majority of honest sessions.
 */
export function gitObservationGap(
  facts: BundleCapabilityFacts,
  sessionsObserving: ReadonlySet<string>,
): GitObservationGap {
  let silentAndIncapable = 0;
  let silentThoughCapable = 0;
  let silentAndUnreported = 0;

  for (const session of facts.sessions) {
    if (sessionsObserving.has(session.sessionId)) continue;
    if (session.git.kind === 'recorded') {
      if (session.git.capture === 'available') silentThoughCapable += 1;
      else silentAndIncapable += 1;
    } else {
      // `absent` and `malformed` alike: the recorder told us nothing usable.
      silentAndUnreported += 1;
    }
  }

  return {
    sessions: facts.counts.sessions,
    observing: facts.sessions.filter((s) => sessionsObserving.has(s.sessionId)).length,
    silentAndIncapable,
    silentThoughCapable,
    silentAndUnreported,
  };
}
