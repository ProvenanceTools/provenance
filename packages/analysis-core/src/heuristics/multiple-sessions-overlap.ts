/**
 * multiple_sessions_overlap heuristic (Phase 17).
 *
 * PRD §7.4 integrity: two sessions have overlapping wall-time ranges.
 *
 * ## Keyed on CONTRIBUTOR, not on the bundle (Tier 3.2)
 *
 * The original wording of this flag — carried verbatim into its description —
 * was that overlapping sessions are "impossible on a single machine without
 * clock manipulation or log forging". In a shared repo worked by two partners,
 * each running their own recorder, that overlap is produced every single time
 * two people sit down together. The flag was therefore a high/0.95 forgery
 * accusation against the assignment being done exactly as assigned. See
 * `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §3 S5.
 *
 * So a pair is now judged on the two sessions' resolved contributors, and on
 * the two things a verified identity establishes — WHO, and on WHICH MACHINE:
 *
 *  - **one person, one machine** — the same verified `student_ref` AND the same
 *    long-lived `student_pubkey`. The ORIGINAL signal, at its original
 *    severity and confidence. Fires.
 *  - **one person, two machines** — the same `student_ref`, two proven-distinct
 *    `student_pubkey`s. D5's supported flow; no flag. See below.
 *  - **two people** — two verified, distinct `student_ref`s. Expected
 *    collaboration; no flag.
 *  - **undecided** — at least one side is `unattributed` or `unverifiable`, so
 *    NONE of the above is established. Still stated, at a severity that says
 *    so; see "The undecidable majority" below.
 *
 * Never compare `contributorKey` strings directly here. That reads "unproven"
 * as "different people" and reintroduces the accusation through the back door,
 * because every unattributed session carries a per-session singleton key.
 *
 * ## D5: two machines is a supported flow, and the log already proves it
 *
 * This flag used to accuse the two-machine flow of forgery in its first clause
 * ("On a single machine that does not happen without clock manipulation or log
 * forging") and concede it in its last ("the remaining innocent explanation is
 * that this person recorded on two machines under one identity"). D5 makes that
 * flow first class: each machine enrolls independently with its own keypair and
 * the shared `student_ref` groups them into one contributor, so no secret is
 * ever copied.
 *
 * The evidence that separates the two was already in the bundle. `student_ref`
 * is per-PERSON; the long-lived `student_pubkey` that countersigned the session
 * key is per-MACHINE, because a second enrolment mints a fresh student keypair
 * over the same ref — `mint-credential.ts` counts precisely this as
 * `machine_count`. No format change and no new event field was needed.
 *
 * The contributor is NOT split. `attributedContributorKey` still keys on
 * `student_ref` alone, so D14's per-contributor scoring, the
 * `submission_contributors` cut-over and the sole-contributor rule keep seeing
 * one person; splitting them would split that person's score across two
 * apparent people, which migration 0029 exists to prevent. Only the overlap
 * judgement gained sight of the machine.
 *
 * The gain is not only a suppression. On the pairs that DO fire, "they used two
 * machines" is now excluded by evidence rather than conceded, so the wording is
 * stronger and the high severity is honest for the first time.
 *
 * ## The undecidable majority
 *
 * `compareContributors` needs BOTH sides attributed, so the answer is
 * `unknown` for the cases that are ordinary today: one partner unenrolled,
 * neither enrolled, any 1.x bundle (no identity block exists below Manifest
 * 2.0), and any deployment with no root key — where
 * `identity/resolve-contributors.ts` makes every identified session
 * `unverifiable`, so a MISCONFIGURATION used to turn every partner overlap into
 * a high-severity accusation. At `N*(N-1)/2` flags per bundle.
 *
 * The finding is KEPT in every one of those states — dropping it would fail
 * toward fewer findings, and a deployment must never be able to switch a
 * heuristic off by unsetting a variable (the over-correction hazard of decision
 * log bug 12). What changed is the weight it carries: `low` / 0.5 rather than
 * `high` / 0.95, with wording that states the overlap, names both readings,
 * refuses to choose between them, and says what would have settled it — spec §6
 * Rule 1's third state, and Rule 2's bar for naming a person.
 *
 * This is deliberately NOT the call bug 13 made for `no_session_log`, and the
 * difference is the lever. There, severity was shared with genuine signature
 * forgery, so lowering it to soften one defect would have weakened the
 * strongest detection in the check, and only the text could move. Here the
 * partition separates the decidable single-machine case cleanly into its own
 * arm, so the undecided arm can be lowered at zero cost to the detection this
 * heuristic exists for. `same_machine` keeps `high` / 0.95 exactly.
 *
 * ## Where the suppression actually lives
 *
 * Not in this file. `coverage/session-overlap.ts` owns the ONE enumeration of
 * overlapping session pairs and the ONE place both suppressions are decided,
 * and returns a three-part partition: `judged` (what this heuristic flags),
 * `collaboration` (two proven-different people) and `multiMachine` (one person,
 * two enrolled machines) — the last two being what the §5.4 step 5 coverage
 * stage states as exculpatory facts.
 *
 * That move is the whole point. The suppression used to be a bare `continue`
 * here, taken before `pairId`, before `emittedPairs`, and before the `detail`
 * object existed — and `run()` returns only `Flag[]`, with no side channel. So a
 * suppressed overlap produced **no flag and no fact**, which is weaker than §6
 * Rule 3 intends. Reading the fact back out now requires no second copy of the
 * range rules, the strict-`<` overlap test, or the three-valued comparison.
 * `JudgedOverlap.comparison` cannot be `'different'`, so this file cannot
 * re-admit a suppressed pair even by accident, and a two-machine pair has no
 * arm to arrive in at all.
 *
 * The verdict is read through `contributorOf`, which answers `unattributed` for
 * a bundle no caller has stamped via `establishBundleContributors`. That is the
 * fail-toward-more-findings direction: an unstamped bundle behaves exactly as
 * this heuristic did before Tier 3.2.
 *
 * For each pair of sessions in the bundle, compare:
 *   - rangeA: [session.start.wall, session.end.wall]
 *   - rangeB: [session.start.wall, session.end.wall]
 *
 * If the two ranges overlap (i.e., A.start < B.end AND B.start < A.end),
 * emit a flag for that pair.
 *
 * Sessions with no `session.end` event are bounded at their LAST RECORDED
 * EVENT's wall, not at +Infinity.
 *
 * A missing `session.end` is the ordinary crash signature, not a suspicious
 * one: the recorder only emits `session.end` from `deactivate()`, which the
 * editor skips whenever the window is killed, the OS shuts down, or the host
 * process dies. The recorder itself already reads this as a crash — see
 * `previous_session_dangling` in the recorder's `startup/chain-recovery.ts`.
 *
 * Treating such a session as running until +Infinity claimed it overlapped
 * every session that started after it, forever — one crash on day 1 flagged
 * every session for the rest of the assignment. The last recorded event is the
 * last moment the session demonstrably existed; extending the range past it
 * invents evidence. A session whose only event is `session.start` therefore
 * has a zero-length range and cannot overlap anything, which is correct: it
 * never demonstrably ran concurrently with anything.
 *
 * This preserves the real signal — two sessions genuinely recording events in
 * the same wall-clock window still overlap and still flag.
 *
 * Do NOT reintroduce a "same machine_id → suppress" guard. `machine_id` is
 * sha256(hostname:username:sessionId) in all three recorders (VS Code,
 * JetBrains, Neovim) — session-salted by design, per PRD §5.1, to prevent
 * cross-assignment correlation. It is therefore unique per session and can
 * never match across two sessions, so such a guard is unreachable. An earlier
 * version of this file carried one; it was dead code, and its unit tests passed
 * only because the fixtures hand-set a shared machine_id no recorder can emit.
 * The contributor gate above is the discriminator that guard was reaching for,
 * and it is grounded in a signed identity chain rather than in a salted hash.
 *
 * Note on bundle.sessions ordering: sessions are sorted oldest-first by
 * firstEvent.wall (done in the loader). We iterate all pairs N*(N-1)/2.
 * With typical bundle sizes (1–10 sessions) this is negligible.
 *
 * Severity follows what was ESTABLISHED, and nothing else:
 *
 *  - `same_machine` → 'high' / 0.95, unchanged. Tier 3.2 narrowed WHICH pairs
 *    are judged and this change narrows it further, but neither softens the
 *    judgement on the pairs that survive. The one innocent explanation left is
 *    a misconfigured clock, which is named in the description rather than
 *    asserted away and would also trigger monotonic_wall_regression.
 *  - `unknown` → 'low' / 0.5. Not a softer accusation — a statement instead of
 *    an accusation, because which reading applies is precisely what the
 *    evidence does not say.
 *
 * One flag per overlapping pair. The supporting seqs are the session.start
 * events of each session.
 */

import type { EventIndex } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import { describeSessionContributor } from '../identity/resolve-contributors.js';
import type { SessionContributor } from '../identity/types.js';
import {
  partitionSessionOverlaps,
  type JudgedOverlap,
  type SessionRange,
} from '../coverage/session-overlap.js';
import type { Flag, Heuristic } from './types.js';
import type { HeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flagId(sessionIdA: string, sessionIdB: string): string {
  // Lexicographic sort to ensure A < B → stable, pair-order-independent ID.
  const [first, second] =
    sessionIdA < sessionIdB ? [sessionIdA, sessionIdB] : [sessionIdB, sessionIdA];
  return `multiple_sessions_overlap-${first}-${second}`;
}

/**
 * WHY the identity evidence could not decide, and therefore what would have
 * resolved it (spec §6 Rule 1: `unknown` is stated, with what would have
 * resolved it). Ordered by which fact dominates, not by session order.
 *
 * `no_root_key` comes first because it is a DEPLOYMENT fact, not a fact about
 * this submission: one unset environment variable makes EVERY identified
 * session in EVERY bundle `unverifiable`, and a grader must not read that as
 * something a student did.
 */
type UnresolvedBy = 'no_root_key' | 'identity_did_not_verify' | 'no_identity_block';

function unresolvedBy(ca: SessionContributor, cb: SessionContributor): UnresolvedBy {
  for (const c of [ca, cb]) {
    if (c.kind === 'unverifiable' && c.reason.kind === 'no_root_key') return 'no_root_key';
  }
  for (const c of [ca, cb]) {
    if (c.kind === 'unverifiable') return 'identity_did_not_verify';
  }
  return 'no_identity_block';
}

/** The sentence that names what would have settled the question. */
function resolutionClause(by: UnresolvedBy): string {
  switch (by) {
    case 'no_root_key':
      return (
        `This analyzer has no root public key configured, so no session's enrollment chain — in ` +
        `this bundle or any other — could be checked at all. That is a deployment setting, not ` +
        `anything this submission did or failed to do; configuring it is what would decide this.`
      );
    case 'identity_did_not_verify':
      return (
        `An identity block on at least one of these sessions is present and did not verify, which ` +
        `is reported on its own terms elsewhere. It establishes nothing about who recorded either ` +
        `session, so it cannot settle this question either way.`
      );
    case 'no_identity_block':
      return (
        `At least one of these sessions carries no identity block at all — the ordinary, blameless ` +
        `state for a student who has not enrolled, and for every bundle recorded below Manifest ` +
        `2.0. Every collaborator on this scope being enrolled is what would decide this.`
      );
  }
}

/**
 * The clause that says what the overlap MEANS, given who recorded the two
 * sessions. Never reached for a suppressed pair — those produce no flag.
 */
function contributorClause(pair: JudgedOverlap): string {
  if (pair.comparison === 'same_machine') {
    // Both sides are typed `attributed`, so this names a person on
    // `established` evidence — §6 Rule 2 is satisfied by the type.
    return (
      `Both sessions are attributed to the same verified contributor (${pair.studentRef}), and ` +
      `both were countersigned by the SAME enrolled machine key ` +
      `(${pair.studentPubkey.slice(0, 16)}…), so this is one person's single enrolled machine ` +
      `covering the same wall-clock window twice. Working on two machines does not produce this: ` +
      `each machine enrolls separately and gets its own key, so that explanation is excluded here ` +
      `by the identity evidence itself. What remains is clock manipulation or log forging.`
    );
  }
  return (
    `It is NOT established who recorded these sessions, so it is not established whether this ` +
    `overlap means anything: session A is ${describeSessionContributor(pair.contributorA)}; ` +
    `session B is ${describeSessionContributor(pair.contributorB)}. If one person on one machine ` +
    `recorded both, the overlap would indicate clock manipulation or log forging. If two ` +
    `collaborators sharing a repository recorded them, or one person moved between two enrolled ` +
    `machines, it is ordinary work and no finding at all. This flag states the overlap; it does ` +
    `not choose between those readings and no one should read it as choosing. ` +
    resolutionClause(unresolvedBy(pair.contributorA, pair.contributorB))
  );
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, _config: HeuristicConfig): Flag[] {
  // Two PROVEN-different contributors recording at once is the expected shape
  // of pair work, and one person on two independently enrolled machines is
  // D5's supported flow. Neither is evidence of forgery, and NEITHER
  // suppression is made here — `coverage/session-overlap.ts` owns the single
  // enumeration of overlapping pairs and the single place both are decided,
  // and hands back a partition. This heuristic judges the `judged` part; the
  // coverage stage states the other two as facts, which is how a suppressed
  // overlap stopped being invisible.
  //
  // `JudgedOverlap.comparison` is typed `'same_machine' | 'unknown'`, so a
  // suppressed pair is not merely filtered out here — it is unrepresentable.
  // The consumers cannot drift apart about which pairs were suppressed because
  // none of them computes it.
  const { judged } = partitionSessionOverlaps(bundle, index);

  const flags: Flag[] = [];
  const emittedPairs = new Set<string>();

  for (const pair of judged) {
    const { a, b, contributorA: ca, contributorB: cb, comparison } = pair;

    const pairId = flagId(a.sessionId, b.sessionId);

    if (emittedPairs.has(pairId)) continue;
    emittedPairs.add(pairId);

    // Supporting seqs: the session.start events of both sessions.
    const supportingSeqs = [`${a.sessionId}:${a.startSeq}`, `${b.sessionId}:${b.startSeq}`];

    // Label a crash-bounded end so a reader knows the bound came from the last
    // recorded event rather than a real session.end.
    const endLabel = (r: SessionRange): string =>
      r.openEnded
        ? `${new Date(r.endWall).toISOString()} (last event; no session.end)`
        : new Date(r.endWall).toISOString();

    const aEndLabel = endLabel(a);
    const bEndLabel = endLabel(b);

    // Severity and confidence follow WHAT WAS ESTABLISHED, which is the only
    // thing that differs between the two arms. See the header.
    const decided = comparison === 'same_machine';

    flags.push({
      id: pairId,
      heuristic: 'multiple_sessions_overlap',
      title: decided
        ? `Sessions overlap on one machine: ${a.sessionId.slice(0, 8)}… and ${b.sessionId.slice(0, 8)}…`
        : `Sessions overlap, recorder unidentified: ${a.sessionId.slice(0, 8)}… and ${b.sessionId.slice(0, 8)}…`,
      severity: decided ? 'high' : 'low',
      confidence: decided ? 0.95 : 0.5,
      supportingSeqs,
      description:
        `Sessions "${a.sessionId}" and "${b.sessionId}" have overlapping wall-time ranges. ` +
        `Session A: [${new Date(a.startWall).toISOString()}, ${aEndLabel}]. ` +
        `Session B: [${new Date(b.startWall).toISOString()}, ${bEndLabel}]. ` +
        contributorClause(pair),
      detail: {
        sessionA: a.sessionId,
        sessionB: b.sessionId,
        sessionAStartWall: new Date(a.startWall).toISOString(),
        sessionAEndWall: aEndLabel,
        sessionBStartWall: new Date(b.startWall).toISOString(),
        sessionBEndWall: bEndLabel,
        sessionAOpenEnded: a.openEnded,
        sessionBOpenEnded: b.openEnded,
        contributorComparison: comparison,
        sessionAContributor: describeSessionContributor(ca),
        sessionBContributor: describeSessionContributor(cb),
        // Only on the undecided arm: which of the three ways identity failed
        // to decide, so a surface can route the reader to the right fix
        // without re-deriving it from the prose.
        ...(pair.comparison === 'unknown'
          ? { unresolvedBy: unresolvedBy(pair.contributorA, pair.contributorB) }
          : {}),
      },
    });
  }

  return flags;
}

export const multipleSessionsOverlapHeuristic: Heuristic = {
  id: 'multiple_sessions_overlap',
  label: 'Multiple sessions with overlapping wall-time ranges',
  run,
};
