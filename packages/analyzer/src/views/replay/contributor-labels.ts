/**
 * contributor-labels — the vocabulary the Replay tab uses to name a contributor.
 *
 * Spec: `docs/superpowers/specs/2026-08-19-git-collaboration-semantics.md` §6.
 *
 * This module exists because three pairs of facts are easy to collapse and
 * expensive to collapse, and all three surface in this UI:
 *
 *   1. `unverifiable` vs `unattributed`. An artifact making an identity claim it
 *      cannot back is a finding. A student who never enrolled is not. Rendering
 *      the second as the first manufactures an accusation out of an
 *      administrative gap (decision D13).
 *   2. "we could not check" vs "we checked and it failed". Both are
 *      `unverifiable`, and {@link isIdentityCheckFailure} is the only thing that
 *      separates them. A deployment with no root public key produces the first
 *      for EVERY identified session; showing that as a page of failures turns one
 *      unset environment variable into a class-wide integrity finding.
 *   3. `concurrent` vs `unknown` — handled in {@link describeAmbiguityKind}
 *      rather than here, but it is the same rule: a refusal to order is not the
 *      absence of a record.
 *
 * Everything here is pure and returns data, never JSX, so the wording is unit
 * testable on its own. That matters: the wording IS the safeguard. A renderer
 * that shows the right `tone` with the wrong sentence has still told a grader
 * the wrong thing.
 */

import {
  isIdentityCheckFailure,
  type Contributor,
  type SessionContributor,
} from '@provenance/analysis-core/identity/types.js';

// ---------------------------------------------------------------------------
// Tone
// ---------------------------------------------------------------------------

/**
 * How a contributor should READ, not how it should be coloured.
 *
 * Deliberately four values, not three: `unverifiable` splits into the two states
 * that must never share a presentation. A component may map two tones to the
 * same colour, but it can never accidentally map two FACTS to the same tone,
 * because they do not share one.
 */
export type ContributorTone =
  /** Identity present and the chain verified. We know who. */
  | 'attributed'
  /** No identity block at all. Ordinary and blameless. Never styled as an alert. */
  | 'unattributed'
  /** An identity claim we ran the check on, and the check failed. A finding. */
  | 'identity_check_failed'
  /** An identity claim we could NOT check. Not a finding — a gap in our ability to look. */
  | 'identity_not_checked';

/** Is this tone something a grader should read as a finding against someone? */
export function toneIsFinding(tone: ContributorTone): boolean {
  return tone === 'identity_check_failed';
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type ContributorLabel = {
  /**
   * Short form, for a dropdown option or a chip. For an attributed contributor
   * this is the verified `student_ref`. For every other state it is a
   * description of the STATE — never a claimed name, because a claim we did not
   * stand behind must not be shown where a reader scans for who did what.
   */
  short: string;
  /**
   * One sentence stating what is established. Appears next to `short` wherever
   * there is room for it.
   */
  detail: string;
  tone: ContributorTone;
  /**
   * `true` — we performed the identity check and it failed.
   * `false` — we could not perform it.
   * `null` — no check was in play (attributed, or no claim was ever made).
   *
   * Exposed separately from `tone` so a caller can assert on the distinction
   * without depending on the wording.
   */
  checkPerformed: boolean | null;
};

/** First 8 characters of a session id — enough to tell two apart in a list. */
function shortSession(sessionId: string): string {
  return sessionId.slice(0, 8);
}

/**
 * Name one session's contributor verdict.
 *
 * Note what is NOT here: no branch produces the string "unknown contributor" or
 * anything else a reader could take as "we suspect this session". The strongest
 * statement any non-attributed branch makes is about the RECORD, never about a
 * person.
 */
export function labelSessionContributor(c: SessionContributor): ContributorLabel {
  switch (c.kind) {
    case 'attributed':
      return {
        short: c.studentRef,
        detail: `Identity verified — the enrollment chain for this session checks out against the deployment root key (identity ${c.identityVersion}, ${c.scope} ${c.scopeId}).`,
        tone: 'attributed',
        checkPerformed: null,
      };

    case 'unattributed':
      return {
        short: `Unattributed session ${shortSession(c.sessionId)}`,
        detail:
          'This session recorded no identity block, so it is not attributed to anyone. ' +
          'The usual cause is that the student had not enrolled yet. It is not a finding, ' +
          'it is not evidence of anything, and it is never grouped with another unattributed session — ' +
          'two unenrolled people and one person recording twice look identical here.',
        tone: 'unattributed',
        checkPerformed: null,
      };

    case 'unverifiable': {
      const checked = isIdentityCheckFailure(c.reason);
      const claimed =
        c.claimedStudentRef === null ? '' : ` The session claims to be ${c.claimedStudentRef}.`;

      if (!checked) {
        return {
          short: `Identity not checked · session ${shortSession(c.sessionId)}`,
          detail:
            `This session carries an identity claim that could not be checked at all: ${c.reason.detail}. ` +
            `This is a gap in what this deployment can verify, not a failed verification, and nothing follows from it about the student.${claimed}`,
          tone: 'identity_not_checked',
          checkPerformed: false,
        };
      }

      return {
        short: `Identity did not verify · session ${shortSession(c.sessionId)}`,
        detail:
          `This session's identity claim was checked and did not verify: ${c.reason.detail}. ` +
          `The claim is reported as a claim and is deliberately not merged into the contributor it names.${claimed}`,
        tone: 'identity_check_failed',
        checkPerformed: true,
      };
    }
  }
}

/**
 * Name a bundle-level {@link Contributor} — the switcher's option text.
 *
 * A `Contributor` is the grouped form: for an attributed contributor its
 * `sessionIds` may span several machines of one student (decision D5), which is
 * exactly the grouping the switcher exists to present. For `unverifiable` and
 * `unattributed` the key is a per-session singleton, so the group is always one
 * session and the count says so rather than implying a person recorded once.
 */
export function labelContributor(c: Contributor): ContributorLabel {
  const sessions = c.sessionIds.length;
  const sessionCount = `${sessions} ${sessions === 1 ? 'session' : 'sessions'}`;

  switch (c.kind) {
    case 'attributed':
      return {
        short: c.studentRef ?? c.key,
        detail: `Identity verified. ${sessionCount} in this submission${
          sessions > 1
            ? ' — grouped by the verified student reference, so one student working on two machines is one contributor.'
            : '.'
        }`,
        tone: 'attributed',
        checkPerformed: null,
      };

    case 'unattributed':
      return {
        short: `Unattributed session ${shortSession(c.sessionIds[0] ?? c.key)}`,
        detail:
          'No identity block was recorded for this session, so it stands alone. ' +
          'Unattributed sessions are never grouped together and are never asserted to be different people. ' +
          'This is an ordinary state and not a finding.',
        tone: 'unattributed',
        checkPerformed: null,
      };

    case 'unverifiable':
      // A grouped `Contributor` does not carry the reason — only the per-session
      // verdict does — so this deliberately makes the WEAKER of the two
      // statements. Saying "did not verify" here would assert a check we cannot
      // see the result of from this shape.
      return {
        short: `Unverified identity claim · session ${shortSession(c.sessionIds[0] ?? c.key)}`,
        detail:
          'This session carries an identity claim that is not being honoured. ' +
          'It is kept as its own contributor rather than merged into the student it names. ' +
          'Open the session to see whether the claim failed a check or could not be checked.',
        tone: 'identity_not_checked',
        checkPerformed: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Ambiguity wording
// ---------------------------------------------------------------------------

/** The two reasons replay will not show one content. Never merged. */
export type AmbiguityKind = 'concurrent' | 'unknown';

export type AmbiguityCopy = {
  /** Headline. States the fact, not an error. */
  title: string;
  /** What is established, and what would resolve it. */
  body: string;
};

/**
 * Copy for a replay position with no single content.
 *
 * The two arms say materially different things and must keep doing so:
 *
 *  - `concurrent` — we have the records, we ordered what could be ordered, and
 *    the answer is that these edits are genuinely unordered. That is a POSITIVE
 *    finding about the evidence.
 *  - `unknown` — the relation does not reach some of these events, so there is
 *    no basis for any statement. That is the ABSENCE of a record.
 *
 * Reading the second as the first claims the edits raced when we simply cannot
 * see. Reading the first as the second throws away a fact we actually hold.
 */
export function describeAmbiguityKind(kind: AmbiguityKind, filePath: string): AmbiguityCopy {
  if (kind === 'concurrent') {
    return {
      title: 'No single version of this file existed at this point',
      body:
        `Two or more contributors edited ${filePath} on lineages the recorded evidence does not order. ` +
        'The hash chains, the session links and the observed commit graph all leave them unordered, and the two ' +
        'machines’ clocks are not evidence of order. Both versions are shown below; neither is “the” file, and ' +
        'showing one alone would show a state that never existed on anyone’s machine. A merge commit followed by ' +
        'any disk observation of this file resolves it.',
    };
  }

  return {
    title: 'This file’s history cannot be ordered at this point',
    body:
      `The happens-before relation does not cover some of ${filePath}’s events, so no statement can be made ` +
      'about their order. This is the absence of a record — it is not a claim that the edits raced, and it is ' +
      'not a finding against anyone.',
  };
}
