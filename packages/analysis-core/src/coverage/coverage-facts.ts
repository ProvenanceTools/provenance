/**
 * coverage-facts — §5.4 step 5, "compute coverage": the per-scope facts a
 * grader needs in order to read the flags correctly.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md`
 * §5.4 step 5 puts this stage here, in `analysis-core`, as one pure function run
 * once per scope per load. §6 Rule 3 says what it is for — "a coverage panel per
 * scope, always visible. […] Low coverage is displayed as low coverage. It is
 * **never a flag and never a score contribution** — it is context a human needs
 * to read the flags correctly."
 *
 * ## The contract every field here is held to
 *
 * Nothing computed in this module is a Flag, contributes to a score, or fails a
 * check. Every field is a statement about what the record contains or does not
 * contain. Three distinctions are load-bearing and must never be collapsed by a
 * consumer:
 *
 *  - `unverifiable` ≠ `unattributed`. One is a claim we could not stand behind;
 *    the other is the ordinary, blameless state of a student who never enrolled.
 *  - "could not check" ≠ "checked and failed". {@link IdentityCoverage.rootKeyConfigured}
 *    is a DEPLOYMENT fact — one unset environment variable, not a page of failed
 *    students.
 *  - `concurrent` ≠ `unknown`. A {@link CollaborationOverlap} is only ever a pair
 *    of two verified, provably different people; an unproven pair is not
 *    representable in it.
 *  - **two machines ≠ two people.** {@link MultiMachineRecordingFact} is ONE
 *    verified student on two independently enrolled machines (D5). It is kept in
 *    its own field for the same reason the three identity states are kept apart:
 *    merging it into {@link ConcurrentRecordingFact} would tell a grader two
 *    people collaborated when one person moved between their own machines.
 *
 * ## Where the concurrency facts come from
 *
 * `coverage/session-overlap.ts` owns the single enumeration of overlapping
 * session pairs and the single place the suppressions are decided.
 * `heuristics/multiple-sessions-overlap.ts` consumes the `judged` part; this
 * module consumes the `collaboration` and `multiMachine` parts. They cannot
 * disagree about which pairs were suppressed because neither computes it — see
 * that module's header for why this is a type-level guarantee rather than a
 * tested-after-the-fact one.
 */

import { ASSUMED_SINGLE_REPOSITORY, buildObservedDag } from '../git/observed-dag.js';
import type { ObservedDagCoverage, ObservedDagDefect } from '../git/observed-dag.js';
import type { BundleContributors } from '../identity/types.js';
import type { EventIndex } from '../index/event-index.js';
import type { Bundle, DroppedArtifact } from '../loader/types.js';
import {
  partitionSessionOverlaps,
  type CollaborationOverlap,
  type MultiMachineOverlap,
} from './session-overlap.js';

// ---------------------------------------------------------------------------
// Concurrent recording
// ---------------------------------------------------------------------------

/**
 * Two provably different contributors recorded at the same wall-clock time.
 *
 * This is the fact §6 Rule 3 asks to be surfaced — "Alice and Bob recorded
 * concurrently for 3h12m" — and it is EXCULPATORY context, not a finding. It is
 * produced only from the `collaboration` half of the overlap partition, which
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
  /**
   * Either range was bounded by its last recorded event rather than a real
   * `session.end`, so the true overlap may be longer. Stated because a coverage
   * fact that quietly under-reports is still a claim.
   */
  crashBounded: boolean;
};

function toFact(o: CollaborationOverlap): ConcurrentRecordingFact {
  return {
    sessionA: o.a.sessionId,
    sessionB: o.b.sessionId,
    // Non-null by type: both sides are the `attributed` branch.
    contributorA: o.contributorA.studentRef,
    contributorB: o.contributorB.studentRef,
    overlapMs: o.overlapMs,
    crashBounded: o.a.openEnded || o.b.openEnded,
  };
}

/**
 * Every overlapping session pair whose contributors are PROVABLY different —
 * one of the two kinds of pair `multiple_sessions_overlap` suppresses, read
 * from the partition rather than recomputed.
 */
export function concurrentRecordingFacts(
  bundle: Bundle,
  index: EventIndex,
): ConcurrentRecordingFact[] {
  return partitionSessionOverlaps(bundle, index).collaboration.map(toFact);
}

// ---------------------------------------------------------------------------
// One student, two machines
// ---------------------------------------------------------------------------

/**
 * ONE verified student recorded on TWO independently enrolled machines at the
 * same wall-clock time (D5).
 *
 * Exculpatory context, never a finding — and a DIFFERENT fact from
 * {@link ConcurrentRecordingFact}. Rendering this as "two contributors recorded
 * concurrently" would tell a grader that two people worked together when one
 * person moved between their own machines, which is a fabricated relationship
 * in the opposite direction from the one this module usually guards against.
 *
 * Produced only from the `multiMachine` arm of the overlap partition, which
 * requires both sides attributed, sharing one `student_ref`, and carrying two
 * proven-distinct `student_pubkey`s — so it can never rest on an unproven
 * relationship.
 */
export type MultiMachineRecordingFact = {
  sessionA: string;
  sessionB: string;
  /** The one verified `student_ref`. Only ever a verified name. */
  studentRef: string;
  overlapMs: number;
  /** Either range was bounded by its last recorded event; see above. */
  crashBounded: boolean;
};

function toMachineFact(o: MultiMachineOverlap): MultiMachineRecordingFact {
  return {
    sessionA: o.a.sessionId,
    sessionB: o.b.sessionId,
    studentRef: o.studentRef,
    overlapMs: o.overlapMs,
    crashBounded: o.a.openEnded || o.b.openEnded,
  };
}

/**
 * Every overlapping session pair recorded by one verified student on two
 * enrolled machines — the other kind of pair `multiple_sessions_overlap`
 * suppresses, read from the partition rather than recomputed.
 */
export function multiMachineRecordingFacts(
  bundle: Bundle,
  index: EventIndex,
): MultiMachineRecordingFact[] {
  return partitionSessionOverlaps(bundle, index).multiMachine.map(toMachineFact);
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
   * environment variable, not a page of failed students. A consumer that renders
   * this as "these identities failed verification" turns a deployment
   * misconfiguration into a class-wide integrity finding.
   */
  rootKeyConfigured: boolean;
  attributed: number;
  /** An identity claim was present and we could not stand behind it. */
  unverifiable: number;
  /** No identity block at all. Ordinary and blameless — never a finding. */
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
 * maximum-severity false accusation three separate times (decision log bugs 5,
 * 10 and 12).
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
  // whole-file one (bugs 10 and 12); it must stay an explicit non-answer here.
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
// Torn final lines
// ---------------------------------------------------------------------------

/**
 * A session whose `.slog` ended part-way through a line, so the loader read it
 * up to its last COMPLETE entry and left the fragment out.
 *
 * The signature of an INTERRUPTED WRITE — a power cut, a full disk, the editor
 * killed mid-flush — and the only corruption an honest student produces by
 * doing nothing at all. It used to fail the whole submission to load; it is now
 * absorbed, and this is the channel that keeps the absorption from being
 * SILENT. A truncation nobody is told about is worse than the fatal error it
 * replaced, for the same reason `droppedArtifacts` exists.
 *
 * Never a `Flag`, never a check failure, never a score. The digests
 * `log_bytes_match` compares are still taken over the FULL archived bytes, so
 * nothing here weakens any verdict. See `loader/types.ts` / `ParsedSession`.
 */
export type TornTailFact = {
  sessionId: string;
  /** 1-indexed line number of the incomplete final line. */
  line: number;
  /** How many characters were left out of the analysis. */
  discardedChars: number;
  /** Staff-facing prose: what was left out, and why it is not a finding. */
  detail: string;
};

export function tornTails(bundle: Bundle): TornTailFact[] {
  const facts: TornTailFact[] = [];
  for (const session of bundle.sessions) {
    const t = session.tornTail;
    if (t === null) continue;
    facts.push({
      sessionId: session.sessionId,
      line: t.line,
      discardedChars: t.discardedChars,
      detail: t.detail,
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// The aggregate
// ---------------------------------------------------------------------------

export type CoverageFacts = {
  identity: IdentityCoverage;
  concurrentRecording: readonly ConcurrentRecordingFact[];
  /**
   * One student on two enrolled machines. Kept SEPARATE from
   * `concurrentRecording`: two machines is not two people, and a consumer that
   * merges them names a collaboration that did not happen.
   */
  multiMachineRecording: readonly MultiMachineRecordingFact[];
  droppedArtifacts: readonly DroppedArtifact[];
  tornTails: readonly TornTailFact[];
  unattestedTails: readonly UnattestedTail[];
  dagDefects: readonly ObservedDagDefect[];
  dagCoverage: ObservedDagCoverage;
  /**
   * True when SOME observation in this scope named no usable repository, so its
   * commits were folded into {@link ASSUMED_SINGLE_REPOSITORY} (D12). A caveat
   * on the DAG's soundness, stated rather than assumed.
   *
   * The predicate is membership of the sentinel in the DAG's
   * `repositoryScope.repositories`, NOT `!discriminatorRecorded`. Those
   * two agree on `'assumed_single'` and on `'discriminated'` and disagree on
   * `'mixed'` — where some observations carry `root_commit_sha` and some do not
   * (one partner on a newer recorder, or on a shallow clone). In a mixed scope
   * `discriminatorRecorded` is TRUE while part of the graph genuinely IS folded
   * into the sentinel, so the negated form goes silent on exactly the scope the
   * caveat is about.
   *
   * There is no separate `commits > 0` guard because the predicate already
   * implies one: the sentinel only enters `repositories` when a node keyed to it
   * was created, so a scope that observed nothing has an empty list and reports
   * `false`. A zero-commit scope has no graph to caveat.
   */
  repositoryAssumedSingle: boolean;
};

/**
 * Everything the coverage panel states, computed once from a loaded bundle.
 *
 * Pure, synchronous and deterministic — no wall clock, no `Math.random`, no
 * iteration over an unordered structure. The observed DAG is rebuilt here rather
 * than borrowed from `ReconstructionScope`, which exposes only the ordering; the
 * walk is over `git.event`s alone, so a bundle that recorded none pays
 * essentially nothing, and callers memoize on the bundle regardless.
 */
export function coverageFacts(bundle: Bundle, index: EventIndex): CoverageFacts {
  const dag = buildObservedDag(bundle);

  return {
    identity: identityCoverage(bundle.contributors ?? null),
    concurrentRecording: concurrentRecordingFacts(bundle, index),
    multiMachineRecording: multiMachineRecordingFacts(bundle, index),
    droppedArtifacts: bundle.droppedArtifacts,
    tornTails: tornTails(bundle),
    unattestedTails: unattestedTails(bundle),
    dagDefects: dag.defects,
    dagCoverage: dag.coverage,
    repositoryAssumedSingle: dag.repositoryScope.repositories.includes(ASSUMED_SINGLE_REPOSITORY),
  };
}

/**
 * Is there anything at all to state?
 *
 * Keeps a consumer from rendering an empty frame for a solo, fully attributed,
 * classically sealed bundle that has nothing to say. Note this is NOT the same
 * question as "is there a bundle" — a caller with no bundle must say the facts
 * were not available rather than call this on an empty one, because a panel of
 * zeroes is a stronger and falser claim than "not available".
 */
export function hasCoverageFacts(f: CoverageFacts): boolean {
  return (
    f.concurrentRecording.length > 0 ||
    f.multiMachineRecording.length > 0 ||
    f.droppedArtifacts.length > 0 ||
    f.tornTails.length > 0 ||
    f.unattestedTails.length > 0 ||
    f.dagDefects.length > 0 ||
    f.dagCoverage.commits > 0 ||
    f.identity.unverifiable > 0 ||
    f.identity.unattributed > 0 ||
    !f.identity.rootKeyConfigured
  );
}
