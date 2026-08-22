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
 *  - **"nobody reported" ≠ "the answer was no".** {@link WitnessCoverage} and
 *    {@link GitObservationCoverage} each carry an explicit third state for a
 *    recorder that says nothing (§5.6), which is the permanent state of every
 *    bundle recorded before those fields existed. Folding it into `unavailable`
 *    or `impossible` would make years of archived submissions assert that their
 *    own capture was broken.
 *
 * ## The §5.6 readers this module is the production caller for
 *
 * `witness/reconcile-witnesses.ts` and `capability/session-capabilities.ts` both
 * state in their own headers that they produce no findings and exist to feed a
 * presentation layer. This is that layer's input. Nothing below turns any of it
 * into a `Flag`, a validation check, or a score contribution, and
 * `isWitnessAlterationEvidence` is deliberately NOT called here: what a witness
 * licenses saying about a person is not a question a coverage fact answers.
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

import { scopeFromManifest } from '@provenance/log-core';
import type {
  CapabilityValueProblem,
  FileScopeProblem,
  PeerObservedPayload,
  ResolvedScope,
} from '@provenance/log-core';
import {
  gitObservationGap,
  readBundleCapabilities,
  wasFileWatched,
} from '../capability/session-capabilities.js';
import type {
  BundleCapabilityFacts,
  BundleCapabilitySummary,
  GitImpossibleReason,
  WatchedFileAnswer,
} from '../capability/session-capabilities.js';
import { ASSUMED_SINGLE_REPOSITORY, buildObservedDag } from '../git/observed-dag.js';
import type { ObservedDagCoverage, ObservedDagDefect } from '../git/observed-dag.js';
import type { BundleContributors } from '../identity/types.js';
import type { EventIndex } from '../index/event-index.js';
import type { Bundle, DroppedArtifact } from '../loader/types.js';
import {
  bundleCapturePolicyTrust,
  isManifest2Binding,
  readSessionManifests,
} from '../manifest/bundle-manifest.js';
import { reconcileWitnesses } from '../witness/reconcile-witnesses.js';
import type {
  BundleWitnessReconciliation,
  WitnessAuthority,
  WitnessVerdict,
} from '../witness/reconcile-witnesses.js';
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
// Peer witnessing (§5.5)
// ---------------------------------------------------------------------------

/**
 * One partner log a witness could NOT corroborate, aggregated over every
 * observation that reached the same verdict about the same file.
 *
 * ## Why this is aggregated rather than one row per observation
 *
 * `peer.observed` is emitted on the checkpoint cadence, so a partner's log that
 * is not in the archive produces one `absent` witness per drain for the whole
 * session — hundreds of identical rows saying one thing. Collapsing them on
 * `(file, verdict)` is lossless for a reader (the verdict is a function of the
 * file and the bundle, not of which drain saw it) and keeps the wire shape
 * bounded by partner-files × verdicts rather than by session length.
 *
 * `corroborated` never appears here. It is a positive fact and is carried as a
 * count on {@link WitnessCoverage}; giving it a row in a list of things that did
 * not line up is how a reader starts scanning the list as a list of problems.
 *
 * ## Nothing in here names anybody
 *
 * A witness establishes that a LOG was in a particular state, never who put it
 * there (collaboration spec §5, S26). There is deliberately no contributor field
 * on this type: the evidence does not support one, so the shape cannot carry
 * one.
 */
export type WitnessDiscrepancy = {
  /** `.provenance/`-relative filename exactly as the witness saw it. */
  file: string;
  /**
   * The witnessed logical session id, or `null` when the recorder could not read
   * a chain out of the foreign file at all.
   */
  witnessedSessionId: string | null;
  /** Never `'corroborated'` — see above. */
  verdict: Exclude<WitnessVerdict, 'corroborated'>;
  /** How many observations reached this same verdict about this file. */
  observations: number;
  /**
   * Every `state` the recorder recorded for this file, sorted and deduplicated.
   *
   * **Descriptive only.** `'disappeared'` in particular is NOT misconduct: a
   * checkout of a branch that never contained a partner's log removes it from
   * the working tree, and so does a stash. `'shrank'` and `'unparseable'` have
   * the same ordinary causes. Carried so a reader can see what the recorder saw,
   * never so a reader can grade it.
   */
  states: readonly PeerObservedPayload['state'][];
  /**
   * How far the WITNESSING session's own identity was established. An
   * `'unverifiable'` witness is recorded and not relied on — an artifact
   * asserting an identity it cannot back does not get to testify about someone
   * else's.
   */
  authority: WitnessAuthority;
  /**
   * `reconcile-witnesses`'s own statement of what was compared and what came of
   * it. Carried verbatim rather than re-derived: that module is the authority on
   * this wording, and a second phrasing of a five-way verdict is how two
   * surfaces start disagreeing about what a witness proves.
   */
  detail: string;
};

/**
 * What peer witnessing does and does not establish about this bundle.
 *
 * Never a `Flag`, never a check, never a score. `reconcileWitnesses` deliberately
 * produces no findings; this is the presentation input §6 Rule 3 asks for, and
 * every field below is a statement about the RECORD.
 *
 * The load-bearing distinction: {@link WitnessCoverage.capability} and
 * {@link WitnessCoverage.unwitnessedSessions} are different axes and must never
 * be read together as one number. `capability` says whether anything here could
 * have witnessed; `unwitnessedSessions` says how many logs nobody named. An
 * unwitnessed log is blameless in every combination of the two.
 */
export type WitnessCoverage = {
  /**
   * Whether ANY session in this bundle could watch `.provenance/` (§5.6 item 3).
   *
   * `'unknown'` means at least one session did not report — **the state of every
   * bundle recorded before the field existed**, and never a defect.
   */
  capability: BundleCapabilitySummary;
  /** Sessions present in the bundle. The denominator for the two below. */
  sessions: number;
  /** Logs that at least one reconciled witness names. */
  witnessedSessions: number;
  /**
   * Logs that no witness names. **ORDINARY AND BLAMELESS.** The partner may not
   * have been recording, their recorder may predate peer witnessing, or their
   * sessions may simply never have overlapped. Never a finding, and never to be
   * rendered as "unverified, therefore suspect".
   */
  unwitnessedSessions: number;
  /** Observations whose witnessed prefix is intact in the log that is here. */
  corroborated: number;
  /**
   * Observations read and deliberately not reconciled — a chain witnessing
   * itself, or a witness about another session of the same PROVEN contributor.
   * Neither is peer evidence. Hygiene, not a finding.
   */
  excluded: number;
  /**
   * `peer.observed` payloads that did not narrow to the shape this format
   * defines. A fact about the recorder that wrote them, never about a student.
   */
  malformed: number;
  /** Non-corroborated verdicts, aggregated per file. */
  discrepancies: readonly WitnessDiscrepancy[];
};

function witnessCoverage(r: BundleWitnessReconciliation): WitnessCoverage {
  // Keyed on `(file, verdict)`; insertion order is the reconciliation's own
  // (session, seq) order, so the output is deterministic without a sort.
  type Accumulator = Omit<WitnessDiscrepancy, 'states'> & {
    states: Set<PeerObservedPayload['state']>;
  };
  const byFileVerdict = new Map<string, Accumulator>();

  for (const w of r.witnesses) {
    if (w.verdict === 'corroborated') continue;
    const key = `${w.witness.payload.file} ${w.verdict}`;
    const existing = byFileVerdict.get(key);
    if (existing === undefined) {
      byFileVerdict.set(key, {
        file: w.witness.payload.file,
        witnessedSessionId: w.witness.payload.session_id,
        verdict: w.verdict,
        observations: 1,
        states: new Set([w.witness.payload.state]),
        authority: w.witness.authority,
        detail: w.detail,
      });
    } else {
      existing.observations += 1;
      existing.states.add(w.witness.payload.state);
    }
  }

  const discrepancies: WitnessDiscrepancy[] = [];
  for (const d of byFileVerdict.values()) {
    discrepancies.push({
      file: d.file,
      witnessedSessionId: d.witnessedSessionId,
      verdict: d.verdict,
      observations: d.observations,
      states: [...d.states].sort(),
      authority: d.authority,
      detail: d.detail,
    });
  }

  return {
    capability: r.witnessingCapability,
    sessions: r.sessions.length,
    witnessedSessions: r.counts.witnessedSessions,
    unwitnessedSessions: r.counts.unwitnessedSessions,
    corroborated: r.counts.corroborated,
    excluded: r.counts.excluded,
    malformed: r.counts.malformed,
    discrepancies,
  };
}

// ---------------------------------------------------------------------------
// Git observability (§5.6 item 2)
// ---------------------------------------------------------------------------

/**
 * Whether git could be observed at all, paired with what the commit DAG saw.
 *
 * This is what lets a coverage surface say **"we could not check"** instead of
 * silently implying git was fine. Without it an absence of `git.event` is
 * equally consistent with _no git activity happened_ and with _git was never
 * observable_, and the second reading is invisible — which is the exact ambiguity
 * §5.6 item 2 exists to close, and the context `git_unrecorded_in` has to be read
 * against.
 *
 * Never a `Flag`, never a check, never a score. {@link
 * GitObservationCoverage.silentThoughCapable} in particular is NOT evidence of
 * anything: a student who ran no git command all session produces it, and that
 * is the majority of honest sessions.
 */
export type GitObservationCoverage = {
  /**
   * `'available'` — at least one session reported it could observe git.
   * `'impossible'` — every session reported, none could.
   * `'unknown'` — at least one session said nothing. **The state of every bundle
   * recorded before the field existed**, and never a defect.
   */
  availability: BundleCapabilitySummary;
  /**
   * Why `availability` came out `'impossible'`; `null` otherwise.
   *
   * `'unavailable'` (the machine had no git integration) and `'not_owned'` (git
   * worked, the assignment sat outside every repository it could see) are
   * different situations with the same consequence, and a grader acts
   * differently on the two.
   */
  impossibleReason: GitImpossibleReason;
  /** Sessions in the bundle. */
  sessions: number;
  /** Sessions that recorded at least one commit observation. */
  observing: number;
  /** Recorded no commits AND reported they could not observe git. Explained. */
  silentAndIncapable: number;
  /**
   * Recorded no commits and reported git WAS available. Their silence is a
   * statement about git activity, not about capture — and is not a finding.
   */
  silentThoughCapable: number;
  /**
   * Recorded no commits and said nothing about their capability. **Every session
   * of every bundle recorded before the field existed lands here**, and their
   * silence stays exactly as ambiguous as it has always been.
   */
  silentAndUnreported: number;
  /**
   * Sessions reporting a git-capture value this format does not define, so their
   * report could not be used. A fact about the recorder, never about a student.
   */
  malformed: number;
  /**
   * Every distinct reason a present git-capture value could not be read, sorted
   * and deduplicated. Empty iff {@link GitObservationCoverage.malformed} is 0.
   *
   * Carried so a surface can say WHICH way the value was wrong through
   * `log-core`'s `describeCapabilityValueProblem` rather than guessing. The two
   * problems are genuinely different — a non-string value and a string outside
   * the closed enum are different nonconformance — and a surface that renders
   * `malformed` alone can only describe one of them.
   */
  malformedProblems: readonly CapabilityValueProblem[];
};

// ---------------------------------------------------------------------------
// File scope (§5.6 item 1)
// ---------------------------------------------------------------------------

/**
 * One file the assignment put under review, and whether anything was watching it.
 *
 * The join is by VERBATIM path, which is sound by construction rather than by
 * luck: `file_scope.watched` is resolved from the manifest's
 * `files_under_review` (see the recorder's `resolveFileScope`), and
 * `submission_files[].path` is documented as matching a `files_under_review`
 * entry. Both spellings come from the same manifest list, so neither side
 * normalizes and neither may start to — see {@link wasFileWatched}.
 */
export type WatchedFileFact = {
  /** Manifest path, verbatim, exactly as a grader can grep for it. */
  path: string;
  /**
   * {@link WatchedFileAnswer} for this path. `'unknown'` is the permanent state
   * of every file of every bundle recorded before §5.6, and is never a defect.
   */
  watched: WatchedFileAnswer;
  /**
   * Whether this record carries any event at all for this path.
   *
   * Present so a consumer never says "this file has no recorded activity" about
   * a file that has some. The S25 ambiguity only exists for a file with NO
   * activity; a file with activity was self-evidently being watched, whatever a
   * capability report says about it.
   */
  recordedActivity: boolean;
};

/**
 * How much of the file set this record was actually watching (§5.6 item 1).
 *
 * ## The inference this exists to remove
 *
 * "No events for `Solver.java`" is ambiguous between _nothing happened in it_
 * and _it was never watched_ (S25). Nothing else in a bundle can tell those
 * apart: a file the recorder was never told to watch produces exactly the same
 * silence as a file the student never opened. This is the only field that
 * separates them, and it separates them per file rather than in aggregate,
 * because a scope is a set and a grader's question is about one member of it.
 *
 * ## Never a finding, in either direction
 *
 * `'not_watched'` is EXCULPATORY: it says the recorder was not told to watch
 * that file, which is a course-configuration fact about the assignment manifest,
 * not conduct by the student. `'unknown'` is the ordinary, permanent state of
 * every pre-§5.6 bundle and means only that the recorder does not report. No
 * `Flag`, no check, no score — see the module docstring.
 */
export type FileScopeCoverage = {
  /**
   *  - `'reported'` — every session said which files it was watching.
   *  - `'partial'` — some did and some did not, so the watched set is a lower
   *    bound rather than the whole scope.
   *  - `'unreported'` — no session said anything usable. **The state of every
   *    bundle recorded before the field existed**, and never a defect.
   */
  reporting: 'reported' | 'partial' | 'unreported';
  /** Sessions in the bundle. The denominator for the three below. */
  sessions: number;
  /** Sessions carrying a readable file scope, complete or truncated. */
  reportedSessions: number;
  /**
   * Of those, how many said their list had been capped. A capped list can prove
   * a file WAS watched and can never prove one was not — see
   * {@link wasFileWatched}.
   */
  incompleteSessions: number;
  /** Sessions whose recorder does not report a file scope. Never a defect. */
  unreportedSessions: number;
  /** Sessions whose file scope was present and could not be read. */
  malformedSessions: number;
  /**
   * Every distinct reason a present file scope could not be read, sorted and
   * deduplicated, for `log-core`'s `describeFileScopeProblem`. Note these are
   * reported by NAME and never quote the offending path — that is the privacy
   * check the reader exists to perform.
   */
  malformedProblems: readonly FileScopeProblem[];
  /**
   * The union of every session's watched list, sorted and deduplicated.
   *
   * Display only, and a LOWER BOUND whenever `reporting` is not `'reported'` or
   * any session's list was capped. It is not the basis of {@link files}.
   */
  watchedFiles: readonly string[];
  /**
   * One entry per `submission_files` path, in manifest order.
   *
   * Empty on a legacy 1.0 bundle, which carries no `submission_files` at all —
   * so there is no file set to ask the question about, which is absence of a
   * question rather than a negative answer.
   */
  files: readonly WatchedFileFact[];
};

/**
 * The course-signed §5.1 tier-1 rules for this bundle, or `undefined` when
 * there is none to trust.
 *
 * `undefined` — never the rules from an unverified manifest — whenever the
 * bundle's trust chain has not verified. `session.start.data.manifest` arrives
 * from a file the student can edit; the `ignore`/`attachments`/`track` lists
 * are exactly the course policy the false-accusation work in this slice exists
 * to protect, and honouring an UNSIGNED (or wrongly signed) version of it would
 * let a student fabricate the very explanation `wasFileWatched` hands back as
 * exculpatory context — the mirror image of `resolveBundleCapturePolicy`'s "an
 * unverified policy is not a policy" (`manifest/bundle-manifest.ts`). Falling
 * back to `undefined` degrades tier 1 straight to tier 2, the answer this
 * behaved with before path scope existed.
 */
function resolvedScopeFor(bundle: Bundle): ResolvedScope | undefined {
  if (bundleCapturePolicyTrust(bundle) !== 'verified') return undefined;
  const binding = readSessionManifests(bundle).find(isManifest2Binding);
  return binding === undefined ? undefined : scopeFromManifest(binding.manifest);
}

function fileScopeCoverage(
  bundle: Bundle,
  index: EventIndex,
  capabilities: BundleCapabilityFacts,
): FileScopeCoverage {
  const c = capabilities.counts;

  const problems = new Set<FileScopeProblem>();
  for (const session of capabilities.sessions) {
    if (session.fileScope.kind === 'malformed') problems.add(session.fileScope.problem);
  }

  const reporting: FileScopeCoverage['reporting'] =
    c.sessions === 0
      ? 'unreported'
      : c.fileScopeReported === c.sessions
        ? 'reported'
        : c.fileScopeReported === 0 && c.fileScopeMalformed === 0
          ? 'unreported'
          : 'partial';

  const scope = resolvedScopeFor(bundle);
  const files: WatchedFileFact[] = [];
  for (const path of bundle.manifest.submission_files ?? []) {
    files.push({
      path: path.path,
      watched: wasFileWatched(capabilities, path.path, scope),
      recordedActivity: (index.byFile.get(path.path)?.length ?? 0) > 0,
    });
  }

  return {
    reporting,
    sessions: c.sessions,
    reportedSessions: c.fileScopeReported,
    incompleteSessions: c.fileScopeIncomplete,
    unreportedSessions: c.fileScopeUnreported,
    malformedSessions: c.fileScopeMalformed,
    malformedProblems: [...problems].sort(),
    watchedFiles: capabilities.watchedFiles,
    files,
  };
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
  /**
   * What peer witnessing establishes about this bundle (§5.5). Facts only —
   * `reconcileWitnesses` produces no findings and this carries none.
   */
  witnessing: WitnessCoverage;
  /**
   * Whether git could be observed at all (§5.6 item 2), paired with what the
   * commit DAG saw. Kept SEPARATE from `dagCoverage`: that counts what WAS seen,
   * this says whether seeing was possible at all. Merging them would let
   * "nothing was observed" pass for "nothing happened".
   */
  gitObservation: GitObservationCoverage;
  /**
   * Which files this record was actually watching (§5.6 item 1), and therefore
   * which files' silence is explained by scope rather than by inactivity.
   *
   * Kept SEPARATE from every other field here for the same reason
   * `gitObservation` is separate from `dagCoverage`: this says whether a file
   * could have been seen at all, and nothing else in the bundle does.
   */
  fileScope: FileScopeCoverage;
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
  const capabilities = readBundleCapabilities(bundle);
  // Exactly the set `observed-dag` itself counts as `sessionsObserving`: a
  // session enters `observations` iff it produced a `git.event` carrying a
  // readable sha. Taking it from the DAG rather than rewalking the events is
  // what keeps this from drifting away from the graph it is a caveat on.
  const gap = gitObservationGap(capabilities, new Set(dag.observations.map((o) => o.sessionId)));

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
    witnessing: witnessCoverage(reconcileWitnesses(bundle)),
    gitObservation: {
      availability: capabilities.gitObservation,
      impossibleReason: capabilities.gitImpossibleReason,
      sessions: gap.sessions,
      observing: gap.observing,
      silentAndIncapable: gap.silentAndIncapable,
      silentThoughCapable: gap.silentThoughCapable,
      silentAndUnreported: gap.silentAndUnreported,
      malformed: capabilities.counts.gitMalformed,
      malformedProblems: gitMalformedProblems(capabilities),
    },
    fileScope: fileScopeCoverage(bundle, index, capabilities),
  };
}

/** Every distinct reason a present `git_capture` could not be read. */
function gitMalformedProblems(
  capabilities: BundleCapabilityFacts,
): readonly CapabilityValueProblem[] {
  const problems = new Set<CapabilityValueProblem>();
  for (const session of capabilities.sessions) {
    if (session.git.kind === 'malformed') problems.add(session.git.problem);
  }
  return [...problems].sort();
}

/**
 * Is there anything at all to state?
 *
 * Keeps a consumer from rendering an empty frame for a solo, fully attributed,
 * classically sealed bundle that has nothing to say. Note this is NOT the same
 * question as "is there a bundle" — a caller with no bundle must say the facts
 * were not available rather than call this on an empty one, because a panel of
 * zeroes is a stronger and falser claim than "not available".
 *
 * ## The §5.6 rule: a report existing is the trigger, its absence never is
 *
 * The capability and witnessing fields are added on exactly one condition —
 * **something actually reported**. `witnessing.capability === 'unknown'`,
 * `gitObservation.availability === 'unknown'` and a nonzero
 * `unwitnessedSessions` are the permanent state of every bundle recorded before
 * §5.6 existed, so letting any of them tip this predicate would take every
 * archived submission in the system out of "nothing to note" on the strength of
 * a field its recorder never had. Absence of a report is not a fact about a
 * submission; it is a fact about a release date.
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
    !f.identity.rootKeyConfigured ||
    // Someone reported whether they could witness, or a witness was actually
    // read. Note `unwitnessedSessions` is deliberately NOT here.
    f.witnessing.capability !== 'unknown' ||
    f.witnessing.corroborated > 0 ||
    f.witnessing.discrepancies.length > 0 ||
    f.witnessing.excluded > 0 ||
    f.witnessing.malformed > 0 ||
    // Someone reported whether git was observable. `'unknown'` is not a report.
    f.gitObservation.availability !== 'unknown' ||
    f.gitObservation.malformed > 0 ||
    // Someone reported which files they were watching. `'unreported'` is not a
    // report, and a file answering `'unknown'` is not one either — that is every
    // file of every pre-§5.6 bundle.
    f.fileScope.reporting !== 'unreported'
  );
}
