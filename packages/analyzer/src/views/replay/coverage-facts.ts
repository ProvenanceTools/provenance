/**
 * coverage-facts — the per-scope facts a grader needs in order to read the flags
 * correctly.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §6
 * Rule 3 — "a coverage panel per scope, always visible. […] Low coverage is
 * displayed as low coverage. It is **never a flag and never a score
 * contribution** — it is context a human needs to read the flags correctly."
 *
 * Nothing computed here is a Flag, contributes to a score, or fails a check.
 * Every field is a statement about what the record contains or does not contain.
 *
 * ## The gap this closes
 *
 * `multiple_sessions_overlap` correctly stopped firing for two PROVABLY
 * different contributors (Tier 3.2) — two partners recording at the same time is
 * the expected shape of pair work, not evidence of forgery. But the suppression
 * is a bare `continue` in the heuristic, taken before any `detail` object
 * exists, and `run()` returns only `Flag[]`. So a suppressed overlap currently
 * produces **no flag and no fact**: the strongest positive evidence of
 * legitimate collaboration in the whole system is computed and thrown away.
 * {@link concurrentRecordingFacts} recovers it.
 *
 * ## Why this is recomputed rather than read from the heuristic
 *
 * It has to be: there is no side channel to read. The real fix is the
 * "compute coverage" stage the spec puts in §5.4 step 5, which belongs in
 * `analysis-core` and does not exist yet.
 *
 * The hazard of a second copy is that it drifts from the heuristic and the panel
 * starts disagreeing with the flags. Two things hold it: the range derivation
 * below mirrors `heuristics/multiple-sessions-overlap.ts` decision for decision
 * (crash bounding, backwards-clock collapse, strict-`<` overlap), and
 * `coverage-facts.test.ts` drives one bundle through BOTH the real heuristic and
 * this module and asserts the fired pairs and the suppressed pairs partition the
 * overlapping pairs exactly. A divergence is a failing test, not a silent
 * disagreement between two panels.
 */

import {
  buildObservedDag,
  type ObservedDagCoverage,
  type ObservedDagDefect,
} from '@provenance/analysis-core/git/observed-dag.js';
import {
  compareContributors,
  type BundleContributors,
  type SessionContributor,
} from '@provenance/analysis-core/identity/types.js';
import { contributorOf } from '@provenance/analysis-core/identity/resolve-contributors.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { Bundle, DroppedArtifact } from '@provenance/analysis-core/loader/types.js';
import { labelSessionContributor } from './contributor-labels.js';

// ---------------------------------------------------------------------------
// Session ranges — mirrors heuristics/multiple-sessions-overlap.ts
// ---------------------------------------------------------------------------

type SessionRange = {
  sessionId: string;
  startWall: number;
  endWall: number;
  /** True when the session has no `session.end` event (crashed / killed). */
  openEnded: boolean;
};

/**
 * Wall-clock extent of every session, by the same rules the overlap heuristic
 * uses.
 *
 * The rules that must not drift, each of which exists for a reason:
 *  - A session with no `session.end` is bounded at its LAST RECORDED EVENT, the
 *    last moment it demonstrably existed. Never `+Infinity` — a crash must not
 *    manufacture an overlap with everything after it.
 *  - An unparseable or backwards end collapses the range to zero length rather
 *    than extending it. Clock damage is covered by its own heuristic and must
 *    not leak into this one.
 *  - A session with no parseable `session.start` is skipped entirely.
 */
export function sessionRanges(index: EventIndex): SessionRange[] {
  const ranges: SessionRange[] = [];

  for (const [sessionId, sessionEvents] of index.bySessionId) {
    const startEvent = sessionEvents.find((e) => e.kind === 'session.start');
    const endEvent = sessionEvents.find((e) => e.kind === 'session.end');
    if (startEvent === undefined) continue;

    const startWall = Date.parse(startEvent.wall);
    if (Number.isNaN(startWall)) continue;

    const openEnded = endEvent === undefined;
    const boundingEvent = endEvent ?? sessionEvents[sessionEvents.length - 1];
    const parsedEnd = boundingEvent !== undefined ? Date.parse(boundingEvent.wall) : NaN;
    const endWall = Number.isNaN(parsedEnd) ? startWall : Math.max(parsedEnd, startWall);

    ranges.push({ sessionId, startWall, endWall, openEnded });
  }

  return ranges;
}

/** Strict on both sides, so a zero-length range never overlaps anything. */
function overlapMs(a: SessionRange, b: SessionRange): number {
  if (!(a.startWall < b.endWall && b.startWall < a.endWall)) return 0;
  return Math.min(a.endWall, b.endWall) - Math.max(a.startWall, b.startWall);
}

// ---------------------------------------------------------------------------
// Concurrent recording
// ---------------------------------------------------------------------------

/**
 * Two provably different contributors recorded at the same wall-clock time.
 *
 * This is the fact the spec asks to be surfaced — "Alice and Bob recorded
 * concurrently for 3h12m" — and it is EXCULPATORY context, not a finding. It is
 * produced only for a pair `compareContributors` calls `'different'`, which
 * requires both sides attributed and verified, so it can never name an
 * unattributed session or an unverified claim.
 */
export type ConcurrentRecordingFact = {
  sessionA: string;
  sessionB: string;
  /** Verified `student_ref`s. Only ever a verified name — see above. */
  contributorA: string;
  contributorB: string;
  overlapMs: number;
  /** Either range was bounded by its last event rather than a real `session.end`. */
  crashBounded: boolean;
};

/**
 * Every overlapping session pair whose contributors are PROVABLY different.
 *
 * Exactly the pairs `multiple_sessions_overlap` suppresses — same range rules,
 * same strict overlap test, same `compareContributors === 'different'` gate — so
 * the panel says what the flag deliberately stopped saying instead of
 * second-guessing it.
 */
export function concurrentRecordingFacts(
  bundle: Bundle,
  index: EventIndex,
): ConcurrentRecordingFact[] {
  const ranges = sessionRanges(index);
  if (ranges.length < 2) return [];

  const facts: ConcurrentRecordingFact[] = [];

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!;
      const b = ranges[j]!;

      const ms = overlapMs(a, b);
      if (ms <= 0) continue;

      const ca = contributorOf(bundle, a.sessionId);
      const cb = contributorOf(bundle, b.sessionId);
      if (compareContributors(ca, cb) !== 'different') continue;

      facts.push({
        sessionA: a.sessionId,
        sessionB: b.sessionId,
        contributorA: nameOf(ca),
        contributorB: nameOf(cb),
        overlapMs: ms,
        crashBounded: a.openEnded || b.openEnded,
      });
    }
  }

  return facts;
}

/**
 * `'different'` requires both sides attributed, so `studentRef` is non-null on
 * both by construction. The fallback exists only to keep this total.
 */
function nameOf(c: SessionContributor): string {
  return c.kind === 'attributed' ? c.studentRef : labelSessionContributor(c).short;
}

/** `3h 12m`, `47m`, `12s`. Deliberately coarse — this is context, not a measurement. */
export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

// ---------------------------------------------------------------------------
// Identity coverage
// ---------------------------------------------------------------------------

export type IdentityCoverage = {
  /**
   * `false` when the bundle carries no contributor stamp at all. Distinct from
   * `rootKeyConfigured: false`: one is "resolution never ran", the other is
   * "resolution ran on a deployment with no root key". Rendering the first as
   * the second would report a deployment fact that was never established.
   */
  resolved: boolean;
  /**
   * `false` means NO IDENTITY CHECK WAS POSSIBLE for any session — one unset
   * environment variable, not a page of failed students.
   */
  rootKeyConfigured: boolean;
  attributed: number;
  unverifiable: number;
  unattributed: number;
};

export function identityCoverage(contributors: BundleContributors | null): IdentityCoverage {
  if (contributors === null) {
    return {
      resolved: false,
      rootKeyConfigured: false,
      attributed: 0,
      unverifiable: 0,
      unattributed: 0,
    };
  }
  return {
    resolved: true,
    rootKeyConfigured: contributors.rootKeyConfigured,
    attributed: contributors.counts.attributed,
    unverifiable: contributors.counts.unverifiable,
    unattributed: contributors.counts.unattributed,
  };
}

// ---------------------------------------------------------------------------
// Unattested seal tails
// ---------------------------------------------------------------------------

/**
 * A rolling seal that committed only to a PREFIX of its log, leaving a tail no
 * signature covers.
 *
 * Ordinary and blameless: a seal is written on the checkpoint cadence, so any
 * session ended by a crash, a power cut, a full disk, or simply an archive taken
 * mid-session has one. It is a limit on what can be verified, not a suggestion
 * that the tail was tampered with — which is the exact reading that produced a
 * maximum-severity false accusation three separate times (bugs 5, 10 and 12).
 */
export type UnattestedTail = {
  sessionId: string;
  /** `'slog'` or `'meta'` — which of the session's two files the tail is in. */
  file: 'slog' | 'meta';
  sealed: number;
  total: number;
  unit: 'bytes' | 'checkpoints';
};

export function unattestedTails(bundle: Bundle): UnattestedTail[] {
  const coverage = bundle.rollingSeal?.coverage;
  // Absent coverage means "classic, whole-file sealed", NOT "nothing is sealed".
  // Reading absence as no-coverage is how a prefix commitment got graded as a
  // whole-file one; it must stay an explicit non-answer here.
  if (coverage === undefined) return [];

  const tails: UnattestedTail[] = [];
  for (const entry of coverage) {
    for (const file of ['slog', 'meta'] as const) {
      const c = entry[file];
      if (c.kind !== 'partial') continue;
      tails.push({
        sessionId: entry.sessionId,
        file,
        sealed: c.sealed,
        total: c.total,
        unit: c.unit,
      });
    }
  }
  return tails;
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

export type CoverageFacts = {
  identity: IdentityCoverage;
  concurrentRecording: ConcurrentRecordingFact[];
  droppedArtifacts: readonly DroppedArtifact[];
  unattestedTails: UnattestedTail[];
  dagDefects: readonly ObservedDagDefect[];
  dagCoverage: ObservedDagCoverage;
  /**
   * True when the scope observed commits but the repository discriminator is not
   * in the signed format yet, so every sha was folded into one assumed
   * repository. A caveat on the DAG's soundness, stated rather than assumed.
   */
  repositoryAssumedSingle: boolean;
};

/**
 * Everything the coverage panel shows, from a loaded bundle.
 *
 * Pure and synchronous. The observed DAG is rebuilt here rather than borrowed
 * from `ReconstructionScope`, which exposes only the ordering — but the walk is
 * over `git.event`s alone, so a bundle that recorded none pays essentially
 * nothing, and the caller memoizes on the bundle regardless.
 */
export function coverageFacts(bundle: Bundle, index: EventIndex): CoverageFacts {
  const dag = buildObservedDag(bundle);

  return {
    identity: identityCoverage(bundle.contributors ?? null),
    concurrentRecording: concurrentRecordingFacts(bundle, index),
    droppedArtifacts: bundle.droppedArtifacts,
    unattestedTails: unattestedTails(bundle),
    dagDefects: dag.defects,
    dagCoverage: dag.coverage,
    repositoryAssumedSingle: dag.coverage.commits > 0 && !dag.repositoryScope.discriminatorRecorded,
  };
}

/** Is there anything at all to show? Keeps the panel off a bundle with nothing to say. */
export function hasCoverageFacts(f: CoverageFacts): boolean {
  return (
    f.concurrentRecording.length > 0 ||
    f.droppedArtifacts.length > 0 ||
    f.unattestedTails.length > 0 ||
    f.dagDefects.length > 0 ||
    f.dagCoverage.commits > 0 ||
    f.identity.unverifiable > 0 ||
    f.identity.unattributed > 0 ||
    !f.identity.rootKeyConfigured
  );
}
