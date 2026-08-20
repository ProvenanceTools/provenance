/**
 * Peer-witness reconciliation — what a `peer.observed` event proves once it is
 * checked against the logs actually present in the bundle.
 *
 * Spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md`
 * §7 mechanism 2; `2026-08-19-git-collaboration-semantics.md` §5.5, Tier 4.3.
 *
 * ## What this closes
 *
 * A rolling seal present with no `.slog` (`no_session_log`) is equally
 * consistent with a partner's log having been DELETED and with an innocent
 * partial push — the partner committed `manifest-<id>.json` before their
 * `.slog` landed, or a `.gitignore` caught it. Those produce identical archives,
 * so `loader/rolling-seal.ts` deliberately states it cannot tell them apart. A
 * witness is the missing evidence: someone else's signed chain recording that
 * the log was there.
 *
 * ## The five verdicts, and why collapsing any two is a wrongful accusation
 *
 * These are five DIFFERENT facts, in the manner of `attributed` /
 * `unattributed` / `unverifiable` and `determinate` / `concurrent` / `unknown`:
 *
 *  - **`corroborated`** — the present log reaches the witnessed `seq_high` and
 *    the hash there is the witnessed `last_hash`. The witness is satisfied.
 *
 *  - **`absent`** — witnessed, and NO log for that session is in the bundle.
 *    Suspicious ONLY IN COMBINATION. A partner who simply has not pushed yet
 *    produces exactly this, and that innocent case is the one the system
 *    currently accuses. On its own it is a gap in the record, not an act.
 *
 *  - **`short`** — the present log stops before the witnessed `seq_high`. Either
 *    it was truncated, or the witness saw a later state than was committed —
 *    which happens honestly when a partner records after their last push.
 *
 *  - **`tip_mismatch`** — the present log reaches the witnessed seq with a
 *    DIFFERENT hash. Two chains cannot both be the real history at one position.
 *    The strongest signal available here.
 *
 *  - **`indeterminate`** — we cannot check. The witness read no chain out of the
 *    file, or the bundle's own state makes the comparison unanswerable. Never a
 *    finding, and deliberately not folded into `absent`: "no log is here" and
 *    "we could not look" are different claims, and the codebase has already paid
 *    for treating an unanswerable question as an answer (see
 *    `rolling-coverage.ts`'s `indeterminate` and `classify-external-changes`'s
 *    `unclassified`).
 *
 * And one fact that is NOT a verdict because it is not about a witness at all:
 *
 *  - **`unwitnessed`** — a present log that no witness names. **This is the
 *    ORDINARY case.** The partner may not have been recording, their recorder
 *    may predate this feature (which is every recorder shipped to date), or
 *    nobody's session ever overlapped theirs. It is entirely blameless and must
 *    never render as "unverified, therefore suspect". It is tracked per SESSION,
 *    on {@link SessionWitnessCoverage}, so it cannot be reached by iterating
 *    verdicts and cannot acquire one by accident.
 *
 * ## sha256 is NOT the test
 *
 * The obvious implementation compares `payload.sha256` against the archived
 * file's digest. It is wrong, and wrong in the exact way that has produced three
 * separate maximum-severity false accusations in this system (decision-log bugs
 * 5, 10 and 12). A foreign log is append-only and its owner keeps recording, so
 * the bytes a witness saw are normally a PREFIX of the bytes finally committed:
 * digest inequality is the NORMAL case. The chain commitment — `seq_high` plus
 * `last_hash` — is what a shorter or rewritten log cannot reproduce, and it is
 * the only thing tested here. `payload.sha256` is carried for display.
 *
 * ## A witness is only as good as the chain it sits in
 *
 * A witness is one contributor's claim about another's artifact.
 * {@link WitnessAuthority} carries the witnessing session's own identity verdict
 * onto every record, and {@link isWitnessAlterationEvidence} is the single
 * gate a consumer must pass a reconciliation through before treating it as
 * evidence of anything. A witness inside an `unverifiable` session — an artifact
 * asserting an identity it cannot back — never passes it.
 *
 * ## Two kinds of witness that prove nothing, and are excluded rather than counted
 *
 *  - **Self-witness** — a session witnessing its own log. A chain vouching for
 *    itself is circular. (The recorder excludes its own files by path, so this
 *    should not occur; a reader must not depend on that.)
 *  - **Same-contributor witness** — a witness about another session of the SAME
 *    proven contributor. Not peer evidence: whoever could alter one chain could
 *    alter both. Excluded only when `compareContributors` answers `'same'`,
 *    which requires BOTH sessions to be attributed — an unproven relationship is
 *    never used to discard evidence.
 *
 * ## This module produces no findings
 *
 * It reports facts. No `Flag`, no validation check, no severity, no score. What
 * a grader is shown, and under what wording, is a presentation decision (spec §6)
 * that has to be taken with the contributor schema, not inferred here.
 *
 * Pure and deterministic: no wall clock in any decision, no randomness, and
 * every iteration is over an explicitly ordered structure, so a re-run over the
 * same bundle produces identical output — the ingest-retry contract.
 */

import { validatePeerObservedPayload, describePeerObservedShapeError } from '@provenance/log-core';
import type { PeerObservedPayload, PeerObservedShapeError } from '@provenance/log-core';
import { contributorOf } from '../identity/resolve-contributors.js';
import { compareContributors } from '../identity/types.js';
import type { Bundle, ParsedSession } from '../loader/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * How far the WITNESSING session's own identity was established.
 *
 * Deliberately mirrors `SessionContributor['kind']` rather than inventing a
 * parallel scale: the trustworthiness of a witness is exactly the
 * trustworthiness of the chain carrying it, and a second vocabulary would drift
 * from the first.
 */
export type WitnessAuthority = 'attributed' | 'unattributed' | 'unverifiable';

/**
 * How far a consumer may stand behind a witness, in the three-state vocabulary
 * spec §6 Rule 1 uses everywhere else.
 *
 * It grades the WITNESS, not the verdict. Whether the reconciliation says
 * anything worth reporting is a separate question — see
 * {@link isWitnessAlterationEvidence}.
 */
export type WitnessEvidenceGrade = 'established' | 'inferred' | 'unknown';

/** The reconciliation of one witness against the logs present. */
export type WitnessVerdict =
  | 'corroborated'
  | 'absent'
  | 'short'
  | 'tip_mismatch'
  | 'indeterminate';

/** One `peer.observed` event, located in the chain that carries it. */
export type PeerWitnessRecord = {
  /** The logical session id of the chain this witness sits IN. */
  witnessSessionId: string;
  /** The witnessing session's own identity verdict. */
  authority: WitnessAuthority;
  /** `seq` of the `peer.observed` entry within its own chain. */
  seq: number;
  /** `wall` of that entry. Carried for display; never used in a decision. */
  wall: string;
  payload: PeerObservedPayload;
};

/** A witness that was read but must not be reconciled, and why. */
export type WitnessExclusion = {
  witness: PeerWitnessRecord;
  reason:
    /** The witness names its own session. A chain cannot corroborate itself. */
    | 'self_witness'
    /** The witnessed session is a PROVEN same-contributor session. Not peer evidence. */
    | 'same_contributor';
  detail: string;
};

/** A `peer.observed` entry whose payload could not be narrowed. Never a finding. */
export type MalformedWitness = {
  witnessSessionId: string;
  seq: number;
  error: PeerObservedShapeError;
  detail: string;
};

/** One witness, reconciled. */
export type WitnessReconciliation = {
  witness: PeerWitnessRecord;
  verdict: WitnessVerdict;
  /**
   * The present session id the witness was reconciled against, or `null` when
   * no log was found (`absent`) or none was looked for (`indeterminate`).
   */
  matchedSessionId: string | null;
  /** Highest `seq` in the matched log. `null` when nothing was matched. */
  presentSeqHigh: number | null;
  /**
   * The hash at the witnessed `seq_high` in the matched log. `null` when the log
   * does not reach it, has a hole there, or nothing was matched.
   */
  presentHashAtWitnessedSeq: string | null;
  /**
   * What was compared and what came of it — the FACT, never an interpretation.
   * The distinction bug 13's fix turns on: state what is established, and leave
   * which reading applies to a human.
   */
  detail: string;
};

/** Whether any witness names a given present session. */
export type SessionWitnessCoverage = {
  sessionId: string;
  /**
   * `'unwitnessed'` is ORDINARY and BLAMELESS — it is the state of every log in
   * every bundle recorded to date, because no recorder emits `peer.observed`.
   */
  state: 'witnessed' | 'unwitnessed';
  /** Reconciled witnesses naming this session. Excluded ones do not count. */
  witnessCount: number;
};

/** The bundle-level result. */
export type BundleWitnessReconciliation = {
  /** Every reconciled witness, in (session order, seq order). */
  witnesses: readonly WitnessReconciliation[];
  /** Every session present in the bundle. Total — no session is omitted. */
  sessions: readonly SessionWitnessCoverage[];
  /** Witnesses read but deliberately not reconciled. */
  excluded: readonly WitnessExclusion[];
  /** `peer.observed` entries whose payload did not narrow. */
  malformed: readonly MalformedWitness[];
  /** Coverage-panel input (spec §6 Rule 3). */
  counts: {
    corroborated: number;
    absent: number;
    short: number;
    tip_mismatch: number;
    indeterminate: number;
    /** Present logs no witness names. Context, never a finding. */
    unwitnessedSessions: number;
    witnessedSessions: number;
    excluded: number;
    malformed: number;
  };
};

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

/**
 * Grade a witness by the identity state of the session carrying it.
 *
 * `unattributed` is `'inferred'`, not `'unknown'`: the chain itself verifies, so
 * the observation is real evidence — we simply cannot say whose observation it
 * is. Grading it `'unknown'` would silently discard honest evidence from every
 * student who never enrolled, which is the majority case today.
 *
 * `unverifiable` is `'unknown'`: the artifact asserts an identity it cannot
 * back, and §5.1's rule is that an unverified claim is not honoured.
 */
export function witnessEvidenceGrade(authority: WitnessAuthority): WitnessEvidenceGrade {
  switch (authority) {
    case 'attributed':
      return 'established';
    case 'unattributed':
      return 'inferred';
    case 'unverifiable':
      return 'unknown';
  }
}

/**
 * The single gate a consumer must pass a reconciliation through before treating
 * it as evidence that a log was altered.
 *
 * Two independent conditions, and both directions of collapsing them are the
 * failures this whole module exists to avoid:
 *
 *  1. **The verdict must be `short` or `tip_mismatch`.** `absent` is
 *     deliberately excluded: a partner who has not pushed yet produces it, and
 *     nothing in the archive distinguishes that from a deletion. `absent` is
 *     context for a human, never evidence on its own.
 *  2. **The witness must not sit in an `unverifiable` session.** An artifact
 *     claiming an identity it cannot back does not get to testify about someone
 *     else's.
 *
 * Note what this does NOT license, ever: naming a person. A witness establishes
 * that a LOG was altered, never who altered it (spec §5, S26). Attribution of
 * the ACT is not available from any evidence in this module.
 */
export function isWitnessAlterationEvidence(r: WitnessReconciliation): boolean {
  if (r.verdict !== 'short' && r.verdict !== 'tip_mismatch') return false;
  return r.witness.authority !== 'unverifiable';
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function seqHighOf(session: ParsedSession): number | null {
  let high: number | null = null;
  for (const event of session.events) {
    if (high === null || event.seq > high) high = event.seq;
  }
  return high;
}

function hashAtSeq(session: ParsedSession, seq: number): string | null {
  for (const event of session.events) {
    if (event.seq === seq) return event.hash;
  }
  return null;
}

/** The four-way comparison against ONE present log. */
function reconcileAgainst(
  session: ParsedSession,
  seqHigh: number,
  lastHash: string,
): {
  verdict: Exclude<WitnessVerdict, 'absent'>;
  presentSeqHigh: number | null;
  presentHashAtWitnessedSeq: string | null;
} {
  const presentSeqHigh = seqHighOf(session);
  if (presentSeqHigh === null || presentSeqHigh < seqHigh) {
    return { verdict: 'short', presentSeqHigh, presentHashAtWitnessedSeq: null };
  }
  const presentHash = hashAtSeq(session, seqHigh);
  if (presentHash === null) {
    // The log reaches past the witnessed seq but has no entry AT it — a hole,
    // which checks 3 and 4 report as a chain defect in their own right. From the
    // witness's side the honest answer is that the comparison could not be made,
    // not that the log is short (it is not) and not that it mismatches (nothing
    // was compared).
    return { verdict: 'indeterminate', presentSeqHigh, presentHashAtWitnessedSeq: null };
  }
  return {
    verdict: presentHash === lastHash ? 'corroborated' : 'tip_mismatch',
    presentSeqHigh,
    presentHashAtWitnessedSeq: presentHash,
  };
}

function describe(
  verdict: WitnessVerdict,
  payload: PeerObservedPayload,
  presentSeqHigh: number | null,
): string {
  const seen = `${payload.file} at seq ${String(payload.seq_high)}`;
  switch (verdict) {
    case 'corroborated':
      return (
        `A log for this session is present and reaches seq ${String(payload.seq_high)} with the ` +
        `witnessed hash, so the witnessed prefix is intact.`
      );
    case 'absent':
      return (
        `Another session's chain recorded seeing ${seen}, and no log for that session is in ` +
        `this bundle. This is NOT established as a deletion: a partner who had not yet pushed ` +
        `their log produces an identical archive. What is established is only that the log ` +
        `existed at the moment it was witnessed.`
      );
    case 'short':
      return (
        `The present log stops at seq ${presentSeqHigh === null ? 'none' : String(presentSeqHigh)}, ` +
        `before the witnessed seq ${String(payload.seq_high)}. Either it was truncated, or the ` +
        `witness saw work that was recorded after the last push.`
      );
    case 'tip_mismatch':
      return (
        `The present log reaches seq ${String(payload.seq_high)} with a different hash than the ` +
        `one witnessed. Two chains cannot both be this session's history at that position.`
      );
    case 'indeterminate':
      return (
        payload.seq_high === null
          ? `The observation read no chain out of ${payload.file}, so it commits to nothing that ` +
            `can be checked against this bundle.`
          : `The witnessed session could not be resolved to a single comparable log in this ` +
            `bundle, so the comparison was not made.`
      );
  }
}

/**
 * Reconcile every `peer.observed` witness in a bundle against the logs present.
 *
 * Reads `bundle.contributors` through `contributorOf`, so an UNSTAMPED bundle
 * grades every witness `unattributed` / `'inferred'`. That is the safe
 * direction: it keeps witnesses visible and out of
 * {@link isWitnessAlterationEvidence}'s `unverifiable` exclusion, rather than
 * promoting an unresolved identity to authoritative.
 */
export function reconcileWitnesses(bundle: Bundle): BundleWitnessReconciliation {
  // Present logs, grouped by LOGICAL session id. A bundle can legitimately carry
  // two `.slog` files claiming one logical id (`ambiguous_session_log`), so this
  // is a list per id, never a single entry.
  const presentBySession = new Map<string, ParsedSession[]>();
  for (const session of bundle.sessions) {
    const existing = presentBySession.get(session.sessionId);
    if (existing === undefined) presentBySession.set(session.sessionId, [session]);
    else existing.push(session);
  }

  const witnesses: WitnessReconciliation[] = [];
  const excluded: WitnessExclusion[] = [];
  const malformed: MalformedWitness[] = [];
  const witnessCounts = new Map<string, number>();

  for (const session of bundle.sessions) {
    const contributor = contributorOf(bundle, session.sessionId);
    const authority: WitnessAuthority = contributor.kind;

    for (const event of session.events) {
      if (event.kind !== 'peer.observed') continue;

      const parsed = validatePeerObservedPayload(event.data);
      if (!parsed.ok) {
        malformed.push({
          witnessSessionId: session.sessionId,
          seq: event.seq,
          error: parsed.error,
          detail: `A peer observation could not be read: ${describePeerObservedShapeError(parsed.error)}.`,
        });
        continue;
      }
      const payload = parsed.value;
      const record: PeerWitnessRecord = {
        witnessSessionId: session.sessionId,
        authority,
        seq: event.seq,
        wall: event.wall,
        payload,
      };

      if (payload.session_id !== null && payload.session_id === session.sessionId) {
        excluded.push({
          witness: record,
          reason: 'self_witness',
          detail:
            `This observation names the session that recorded it, so it corroborates only ` +
            `itself.`,
        });
        continue;
      }

      // Nothing checkable: the foreign chain was not read.
      if (payload.session_id === null || payload.seq_high === null || payload.last_hash === null) {
        witnesses.push({
          witness: record,
          verdict: 'indeterminate',
          matchedSessionId: null,
          presentSeqHigh: null,
          presentHashAtWitnessedSeq: null,
          detail: describe('indeterminate', payload, null),
        });
        continue;
      }

      const matches = presentBySession.get(payload.session_id) ?? [];

      if (matches.length > 0) {
        const witnessedIsSameContributor = matches.every(
          (m) => compareContributors(contributor, contributorOf(bundle, m.sessionId)) === 'same',
        );
        if (witnessedIsSameContributor) {
          excluded.push({
            witness: record,
            reason: 'same_contributor',
            detail:
              `This observation is about another session of the same proven contributor, so it ` +
              `is not independent evidence.`,
          });
          continue;
        }
      }

      if (matches.length === 0) {
        witnesses.push({
          witness: record,
          verdict: 'absent',
          matchedSessionId: null,
          presentSeqHigh: null,
          presentHashAtWitnessedSeq: null,
          detail: describe('absent', payload, null),
        });
        witnessCounts.set(payload.session_id, (witnessCounts.get(payload.session_id) ?? 0) + 1);
        continue;
      }

      // One or more present logs claim this id. Resolve on what they AGREE
      // about — the answer `resolveAmbiguousCoverage` already settled for the
      // duplicated-log case. Unanimity is an answer whichever file the witness
      // actually saw; genuine disagreement is `indeterminate`, which reads as
      // "we cannot check", never as a fallback to the harsher reading.
      const results = matches.map((m) => reconcileAgainst(m, payload.seq_high!, payload.last_hash!));
      const first = results[0]!;
      const unanimous = results.every((r) => r.verdict === first.verdict);

      witnesses.push({
        witness: record,
        verdict: unanimous ? first.verdict : 'indeterminate',
        matchedSessionId: matches.length === 1 ? matches[0]!.sessionId : payload.session_id,
        presentSeqHigh: unanimous ? first.presentSeqHigh : null,
        presentHashAtWitnessedSeq: unanimous ? first.presentHashAtWitnessedSeq : null,
        detail: unanimous
          ? describe(first.verdict, payload, first.presentSeqHigh)
          : describe('indeterminate', payload, null),
      });
      witnessCounts.set(payload.session_id, (witnessCounts.get(payload.session_id) ?? 0) + 1);
    }
  }

  const sessions: SessionWitnessCoverage[] = bundle.sessions.map((s) => {
    const count = witnessCounts.get(s.sessionId) ?? 0;
    return {
      sessionId: s.sessionId,
      state: count > 0 ? 'witnessed' : 'unwitnessed',
      witnessCount: count,
    };
  });

  const counts = {
    corroborated: 0,
    absent: 0,
    short: 0,
    tip_mismatch: 0,
    indeterminate: 0,
    unwitnessedSessions: 0,
    witnessedSessions: 0,
    excluded: excluded.length,
    malformed: malformed.length,
  };
  for (const w of witnesses) counts[w.verdict] += 1;
  for (const s of sessions) {
    if (s.state === 'witnessed') counts.witnessedSessions += 1;
    else counts.unwitnessedSessions += 1;
  }

  return { witnesses, sessions, excluded, malformed, counts };
}
