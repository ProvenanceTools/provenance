/**
 * session-overlap — the ONE place that decides which session pairs overlap and
 * which of those overlaps is proven collaboration.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md`
 * §5.4 step 5 (compute coverage) and §3 S5 (the overlap accusation).
 *
 * ## Why this module exists
 *
 * `multiple_sessions_overlap` suppresses a pair whose two contributors are
 * PROVABLY different — two partners recording at once is the expected shape of
 * pair work, not evidence of forgery. The suppression used to be a bare
 * `continue` inside the heuristic, taken before any `detail` object existed, and
 * `run()` returns only `Flag[]`. So a suppressed overlap produced **no flag and
 * no fact**: the strongest positive evidence of legitimate collaboration in the
 * whole system was computed and thrown away, which is precisely the gap §6
 * Rule 3's coverage panel exists to close.
 *
 * ## The second suppression: one person, two machines (D5)
 *
 * D5 makes multiple machines per student a FIRST-CLASS FLOW — "each machine
 * enrols independently, generating its own keypair; the shared `student_ref`
 * groups them into one contributor" — so no secret is copied and nothing is
 * shared between the two. The heuristic nevertheless accused that flow of log
 * forging in its first clause and conceded it in its last ("the remaining
 * innocent explanation is that this person recorded on two machines under one
 * identity"), because {@link compareContributors} answers `'same'` for it.
 *
 * The evidence that separates them was already in the bundle and was being
 * discarded. `student_ref` is per-PERSON; the long-lived `student_pubkey` the
 * chain walk returns is per-MACHINE, because a second enrolment mints a fresh
 * student keypair over the same ref (`mint-credential.ts` counts exactly this
 * as `machine_count`). No format change and no new event field: the same
 * `session.start.identity` block already carries it.
 *
 * **This does not split the contributor.** `attributedContributorKey` still
 * keys on `student_ref` alone, so D14's per-contributor scoring, the
 * `submission_contributors` cut-over and the sole-contributor rule keep seeing
 * ONE person — splitting them would split that person's score across two
 * apparent people, which migration 0029 exists to prevent. What gained sight of
 * the machine is the overlap JUDGEMENT, and nothing else.
 *
 * A same-machine overlap and a two-machine overlap are kept as DIFFERENT FACTS
 * in different arms. Collapsing them either way is a wrongful accusation: fold
 * two machines into `judged` and the supported flow is accused; fold one
 * machine into `multiMachine` and genuine clock manipulation — the case this
 * heuristic exists for — goes undetected. And two machines is not the same fact
 * as two PEOPLE either, which is why it is a third arm rather than more
 * `collaboration`.
 *
 * The obvious fix — recompute the overlap wherever the fact is needed — was
 * taken once and was wrong. Two implementations of a subtle rule (crash
 * bounding, backwards-clock collapse, strict-`<` overlap, three-valued
 * contributor comparison) agree on the day they are written and drift after.
 * This repo has already paid for that twice ("26 vs 25 flags", "21 vs 25
 * tables").
 *
 * ## How drift is prevented STRUCTURALLY, not by a test
 *
 * There is exactly one enumeration ({@link partitionSessionOverlaps}) and
 * exactly one place the suppressions are decided, inside it. The consumers do
 * not each apply a rule and then get compared — they receive the three parts of
 * a partition produced by a single pass, and the type system makes the other
 * parts unreachable:
 *
 *  - {@link JudgedOverlap} is a union whose `comparison` is
 *    `'same_machine' | 'unknown'`. A `'different'` pair is **not representable**
 *    in what the heuristic consumes, so re-adding a local
 *    `if (comparison === 'different') continue;` is a **TS2367 build failure**
 *    rather than a silent divergence — verified by mutation. Nor is a
 *    two-machine pair representable: there is no arm for it.
 *  - {@link JudgedOverlap}'s `same_machine` arm carries `attributed`
 *    contributors, so the flag that names a person is typed to have proof of
 *    who. There is no runtime fallback to "the same contributor" left to reach
 *    for.
 *  - {@link CollaborationOverlap} and {@link MultiMachineOverlap} carry
 *    `attributed` contributors, so an unattributed or unverifiable session is
 *    **not representable** in what the coverage stage consumes. That is not a
 *    stylistic nicety: it is the `unverifiable` ≠ `unattributed` distinction
 *    enforced by the compiler, so a coverage panel can never name an unproven
 *    claim as a verified partner or as a verified second machine.
 *
 * A future edit cannot make the consumers disagree about which pairs were
 * suppressed without first deleting the partition, which is a visible change to
 * this file rather than a silent divergence in two others.
 *
 * Nothing here is a Flag, contributes to a score, or fails a check. It computes
 * ranges and a partition; the heuristic decides what to accuse and the coverage
 * stage decides what to state.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import { contributorOf } from '../identity/resolve-contributors.js';
import { compareContributors, type SessionContributor } from '../identity/types.js';

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/** The wall-clock extent of one session, plus what bounded it. */
export type SessionRange = {
  sessionId: string;
  /** `Date.parse` of `session.start.wall`. */
  startWall: number;
  /**
   * `Date.parse` of `session.end.wall`, or — when the session has no
   * `session.end` (crash) — of its last recorded event's wall. Never
   * `+Infinity`: see {@link sessionRanges}.
   */
  endWall: number;
  /** `seq` of the `session.start` event, for a flag's supporting evidence. */
  startSeq: number;
  /** True when the session has no `session.end` event (crashed / killed). */
  openEnded: boolean;
};

/**
 * Wall-clock extent of every session in the index.
 *
 * The rules, each of which exists because breaking it manufactured a finding:
 *
 *  - A session with no `session.end` is bounded at its **last recorded event**,
 *    the last moment it demonstrably existed — never `+Infinity`. A missing
 *    `session.end` is the ordinary crash signature (the recorder only emits it
 *    from `deactivate()`, which the editor skips on a kill or a power cut).
 *    Extending such a range to infinity claimed one crash on day 1 overlapped
 *    every session for the rest of the assignment.
 *  - An unparseable or backwards end collapses the range to **zero length**
 *    rather than extending it. Clock damage has its own heuristic
 *    (`monotonic_wall_regression`) and must not leak into this one.
 *  - A session with no parseable `session.start` is skipped entirely.
 *
 * `index.bySessionId` is chronological, which is what makes "last recorded
 * event" the last element.
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

    ranges.push({ sessionId, startWall, endWall, startSeq: startEvent.seq, openEnded });
  }

  return ranges;
}

/**
 * Standard interval overlap, strict on both sides.
 *
 * Strict `<` means a zero-length range (a session whose only event is
 * `session.start`, or one whose end collapsed) never overlaps anything, and two
 * adjacent sessions (`a.end === b.start`) do not overlap. Both are correct:
 * neither demonstrably ran concurrently with anything.
 */
export function rangesOverlap(a: SessionRange, b: SessionRange): boolean {
  return a.startWall < b.endWall && b.startWall < a.endWall;
}

/** Milliseconds of genuine overlap, or `0` when the ranges do not overlap. */
export function overlapDurationMs(a: SessionRange, b: SessionRange): number {
  if (!rangesOverlap(a, b)) return 0;
  return Math.min(a.endWall, b.endWall) - Math.max(a.startWall, b.startWall);
}

// ---------------------------------------------------------------------------
// The partition
// ---------------------------------------------------------------------------

/** A `SessionContributor` narrowed to the attributed branch. */
export type AttributedContributor = Extract<SessionContributor, { kind: 'attributed' }>;

/**
 * An overlapping pair that is NOT proven collaboration and NOT one person's two
 * enrolled machines, and is therefore judged by `multiple_sessions_overlap`.
 *
 * A discriminated union rather than a struct with a mode field, because the two
 * arms carry different evidence and the `same_machine` arm can NAME the person
 * without a runtime narrowing. `comparison` deliberately cannot be
 * `'different'`: a pair the partition suppressed is not representable here, so
 * the heuristic cannot re-admit one by accident.
 */
export type JudgedOverlap =
  | {
      /**
       * One verified person, ONE verified enrolled machine — the two sessions
       * were countersigned by the same long-lived `student_pubkey`. The
       * original signal, and the only arm where "they used two machines" is
       * positively EXCLUDED by evidence rather than merely unproven.
       */
      comparison: 'same_machine';
      a: SessionRange;
      b: SessionRange;
      overlapMs: number;
      contributorA: AttributedContributor;
      contributorB: AttributedContributor;
      /** The shared verified `student_ref`. */
      studentRef: string;
      /** The single enrolled machine key both sessions were bound to. */
      studentPubkey: string;
    }
  | {
      /**
       * At least one side is `unattributed` or `unverifiable`, so neither "one
       * person recorded both" nor "two people recorded them" is established.
       * This is the ordinary majority today — an unenrolled partner, a 1.x
       * bundle, or a deployment with no root key.
       */
      comparison: 'unknown';
      a: SessionRange;
      b: SessionRange;
      overlapMs: number;
      contributorA: SessionContributor;
      contributorB: SessionContributor;
    };

/**
 * An overlapping pair recorded by two PROVABLY different verified contributors.
 *
 * Exculpatory context, never a finding. Both contributors are typed
 * `attributed`, so this shape cannot carry an unverifiable claim or an
 * unattributed session — the compiler enforces what the copy promises.
 */
export type CollaborationOverlap = {
  a: SessionRange;
  b: SessionRange;
  overlapMs: number;
  contributorA: AttributedContributor;
  contributorB: AttributedContributor;
};

/**
 * An overlapping pair recorded by ONE verified student on TWO independently
 * enrolled machines (D5).
 *
 * Exculpatory context, never a finding — and a DIFFERENT fact from
 * {@link CollaborationOverlap}. Telling a grader that two people worked
 * together when one person moved between their own machines is a fabricated
 * relationship in the opposite direction; telling them nothing at all is the
 * gap the coverage stage exists to close.
 *
 * Both contributors are `attributed` and share one `contributorKey`, so this
 * shape can never rest on an unproven relationship.
 */
export type MultiMachineOverlap = {
  a: SessionRange;
  b: SessionRange;
  overlapMs: number;
  contributorA: AttributedContributor;
  contributorB: AttributedContributor;
  /** The shared verified `student_ref` — ONE person. */
  studentRef: string;
  /** The two proven-distinct enrolled machine keys. */
  studentPubkeyA: string;
  studentPubkeyB: string;
};

/**
 * Every overlapping session pair, split into the three parts that must never
 * disagree.
 *
 * `judged ∪ collaboration ∪ multiMachine` is exactly the set of overlapping
 * pairs and the three are pairwise disjoint, **by construction** — one loop,
 * one decision, one `push` per pair.
 */
export type OverlapPartition = {
  /** Pairs `multiple_sessions_overlap` flags. */
  judged: readonly JudgedOverlap[];
  /** Two proven-different people. Suppressed; stated by the coverage stage. */
  collaboration: readonly CollaborationOverlap[];
  /** One person, two enrolled machines. Suppressed; stated by the coverage stage. */
  multiMachine: readonly MultiMachineOverlap[];
};

/**
 * The single enumeration of overlapping session pairs, and the single decision
 * about which of them are proven collaboration.
 *
 * The verdict is read through `contributorOf`, which answers `unattributed` for
 * a bundle no caller has stamped via `establishBundleContributors`. That is the
 * fail-toward-more-findings direction: an unstamped bundle produces an empty
 * `collaboration` half and a `judged` half identical to the pre-Tier-3.2
 * behaviour.
 *
 * Never compare `contributorKey` strings here. That reads "unproven" as
 * "different people" and would both suppress a real finding and manufacture a
 * false exculpation, because every unattributed session carries a per-session
 * singleton key.
 *
 * Pairs are enumerated `i < j` over `sessionRanges` order, so the output is
 * deterministic — required by the ingest-retry contract.
 */
export function partitionSessionOverlaps(bundle: Bundle, index: EventIndex): OverlapPartition {
  const ranges = sessionRanges(index);
  if (ranges.length < 2) return { judged: [], collaboration: [], multiMachine: [] };

  const judged: JudgedOverlap[] = [];
  const collaboration: CollaborationOverlap[] = [];
  const multiMachine: MultiMachineOverlap[] = [];

  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const a = ranges[i]!;
      const b = ranges[j]!;

      if (!rangesOverlap(a, b)) continue;
      const overlapMs = overlapDurationMs(a, b);

      const contributorA = contributorOf(bundle, a.sessionId);
      const contributorB = contributorOf(bundle, b.sessionId);
      const comparison = compareContributors(contributorA, contributorB);

      // Both suppressions and the `same_machine` judgement need the attributed
      // branch, and `compareContributors` only ever answers `'same'` or
      // `'different'` when both sides are on it. Narrowing once here makes
      // that a compiler fact rather than three defensive re-checks.
      if (contributorA.kind === 'attributed' && contributorB.kind === 'attributed') {
        // -------------------------------------------------------------------
        // SUPPRESSION 1 — two proven-different people. Pair work.
        // -------------------------------------------------------------------
        if (comparison === 'different') {
          collaboration.push({ a, b, overlapMs, contributorA, contributorB });
          continue;
        }

        // -------------------------------------------------------------------
        // SUPPRESSION 2 — one person, two independently enrolled machines (D5).
        //
        // `student_ref` is per-PERSON and `student_pubkey` is per-MACHINE: a
        // second enrolment mints a fresh student keypair over the same ref
        // (`mint-credential.ts`, "Idempotency, and the second machine"). Both
        // keys are root-anchored and both countersigned their own session key,
        // so this rests on PROOF of two distinct machines under one verified
        // identity — never on an unproven relationship.
        //
        // This does NOT split the contributor. `attributedContributorKey`
        // still keys on `student_ref` alone, so scoring, the
        // `submission_contributors` join and the sole-contributor rule all
        // continue to see one person. Only the overlap JUDGEMENT can see the
        // machine.
        // -------------------------------------------------------------------
        if (comparison === 'same' && contributorA.studentPubkey !== contributorB.studentPubkey) {
          multiMachine.push({
            a,
            b,
            overlapMs,
            contributorA,
            contributorB,
            studentRef: contributorA.studentRef,
            studentPubkeyA: contributorA.studentPubkey,
            studentPubkeyB: contributorB.studentPubkey,
          });
          continue;
        }

        // -------------------------------------------------------------------
        // JUDGED, at full strength: one person, one machine. The remaining
        // innocent explanation the old wording conceded — "they recorded on
        // two machines" — is excluded here by the identity evidence itself.
        // -------------------------------------------------------------------
        if (comparison === 'same') {
          judged.push({
            comparison: 'same_machine',
            a,
            b,
            overlapMs,
            contributorA,
            contributorB,
            studentRef: contributorA.studentRef,
            studentPubkey: contributorA.studentPubkey,
          });
          continue;
        }
      }

      // Neither side proven, or only one of them. "Two different people" and
      // "one person twice" are both unestablished; see the heuristic for what
      // it is entitled to say about that.
      judged.push({ comparison: 'unknown', a, b, overlapMs, contributorA, contributorB });
    }
  }

  return { judged, collaboration, multiMachine };
}
