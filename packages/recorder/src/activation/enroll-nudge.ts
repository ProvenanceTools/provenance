/**
 * Pointing an un-enrolled student at the enrollment page.
 *
 * A student who never enrols still records perfectly good bundles — the event
 * stream, the hash chain, and the seal are all unaffected (see rule 1 in
 * `identity/session-identity.ts`). What they lose is ATTRIBUTION: nothing in the
 * bundle says who produced it. That failure is silent, it is the default state
 * of every fresh install, and until this module existed the only trace of it was
 * a `console.warn` in the Extension Host log that no student will ever read.
 *
 * ## Why this reads the identity outcome instead of looking up a credential
 *
 * "Is this student enrolled?" looks like a one-line SecretStorage lookup, and a
 * lookup gets it wrong. A student holding a LEGACY 2.0 course token has no 2.1
 * credential stored, so the lookup says "not enrolled" — but their sessions do
 * emit an identity and their work IS attributed. Telling them otherwise would be
 * false, and it would push them to re-enrol for no reason.
 *
 * `buildSessionIdentity` has already answered the real question. It returns
 * `emitted` or `skipped(reason)`, both families handled, and all three recorders
 * already compute it and throw it away. This module consumes that value.
 *
 * ## Not every skip is the student's problem
 *
 * Of the eleven skip reasons, only two mean "you have no credential and enrolling
 * would fix it" — see {@link isUnenrolledSkip}. The rest are broken builds, an
 * unavailable keyring, or a chain that did not verify. Attaching an enrollment
 * URL to a packaging bug would send the student somewhere that cannot help them,
 * and would bury the real fault. Those stay diagnostic.
 *
 * ## No network, still
 *
 * Recorder PRD NG2 forbids the recorder making network calls during a session.
 * Nothing here fetches. The URL is a string the student is shown; opening it is
 * the student's own click, in the student's own browser, and enrollment remains
 * a paste in both directions (`commands/enrollment.ts`).
 */

import type { IdentityOutcome, IdentitySkipReason } from '../identity/session-identity.js';

// ---------------------------------------------------------------------------
// The destination
// ---------------------------------------------------------------------------

/**
 * The enrollment page.
 *
 * Hardcoded, and deliberately not a setting. Every institution running this
 * recorder today is Berkeley, and the value cannot be derived from anything an
 * un-enrolled student holds: `institution_id` lives inside the credential and the
 * institution cert (`log-core/institution.ts`), which is exactly what a student
 * who has not enrolled does not have. The manifest carries no institution field
 * at all.
 *
 * When a second institution appears, this becomes a signed manifest field or a
 * setting — and that is the point at which it deserves a design, with the
 * `institution_id` already in the credential to key the lookup off.
 */
export const ENROLL_URL = 'https://provenance.eecs.berkeley.edu/enroll';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * How far the student has got with the nudge. Persisted per MACHINE, globally —
 * never per course. A 2.1 credential is institution-scoped and covers every
 * course at once, so a student taking 61B and 61C is one person with one
 * enrollment, and must be nudged once, not once per assignment root.
 *
 * This is not a secret. It goes in ordinary extension state (`globalState`),
 * not `SecretStorage` — that store is for the master secret alone.
 */
export type NudgeState = 'unseen' | 'intent' | 'done';

/** `globalState` key holding a {@link NudgeState}. */
export const NUDGE_STATE_KEY = 'provenance.enrollNudge';

/** Anything unrecognised (absent key, older build, hand-edited state) reads as fresh. */
export function parseNudgeState(raw: unknown): NudgeState {
  return raw === 'intent' || raw === 'done' ? raw : 'unseen';
}

// ---------------------------------------------------------------------------
// Which skips mean "go and enrol"
// ---------------------------------------------------------------------------

/**
 * Does this skip reason mean the student has no credential and enrolling fixes it?
 *
 * Only two of the eleven do:
 *
 * - `not_enrolled` — the 2.0 path found no token for this course.
 * - `manifest_not_2_0` — reached ONLY after the 2.1 lookup found no credential
 *   (see the precedence block in `buildSessionIdentity`), so it means "no 2.1
 *   credential, and the manifest is too old to carry a 2.0 anchor". A student who
 *   enrols gets a 2.1 credential, the 2.1 path runs first, and the manifest
 *   version stops mattering. So: actionable.
 *
 * Everything else is withheld deliberately:
 *
 * - `no_root_public_key`, `institution_cert_not_root_signed` — the build shipped
 *   without a usable trust anchor. A student cannot fix that by enrolling, and
 *   pointing them at a web page hides a packaging fault that needs staff.
 * - `master_secret_unavailable` — the OS keyring is unavailable. Enrolling needs
 *   that same keyring, so the advice would fail on arrival.
 * - `credential_key_mismatch`, `student_key_mismatch` — they HAVE a credential;
 *   it belongs to another machine. The fix is re-enrolling this machine or
 *   restoring a backup, which `importEnrollmentToken` already says at the moment
 *   it happens, in more detail than a nudge could.
 * - `chain_did_not_verify`, `invalid_session_pubkey`, `unexpected_error` —
 *   something is wrong that a student cannot act on.
 */
export function isUnenrolledSkip(reason: IdentitySkipReason): boolean {
  return reason.kind === 'not_enrolled' || reason.kind === 'manifest_not_2_0';
}

/**
 * Did any session on this machine successfully claim an identity?
 *
 * All-or-nothing on purpose. With several assignment roots open, a 2.1 credential
 * covers all of them, so mixed outcomes are only reachable by a legacy 2.0 holder
 * enrolled in some of their courses but not others. For that student "recording"
 * is the honest status line: at least one session IS attributed, and claiming
 * "not enrolled" would be false. The per-course gap surfaces where it belongs —
 * on the analyzer, against the submission that lacks a contributor.
 */
export function anyIdentityEmitted(outcomes: readonly IdentityOutcome[]): boolean {
  return outcomes.some((o) => o.kind === 'emitted');
}

/**
 * Should the student see "(not enrolled)" in the status bar?
 *
 * True only when no session emitted an identity AND at least one skipped for a
 * reason enrolling would fix. A machine whose keyring is broken reads as plain
 * "recording": the identity is missing, but "not enrolled" would be the wrong
 * diagnosis and the wrong instruction.
 */
export function isUnenrolled(outcomes: readonly IdentityOutcome[]): boolean {
  if (anyIdentityEmitted(outcomes)) return false;
  return outcomes.some((o) => o.kind === 'skipped' && isUnenrolledSkip(o.reason));
}

// ---------------------------------------------------------------------------
// Status bar wording
// ---------------------------------------------------------------------------

/**
 * The status bar's text and tooltip, as pure strings.
 *
 * Kept here rather than in `status-bar.ts` so the wording is unit-testable
 * without the VS Code runtime; `status-bar.ts` stays thin glue that renders it.
 */
export function enrollmentStatusBar(unenrolled: boolean): { text: string; tooltip: string } {
  if (!unenrolled) {
    return {
      text: '$(record) Provenance: recording',
      tooltip: 'Provenance recorder is active for this assignment.',
    };
  }
  return {
    text: '$(record) Provenance: recording (not enrolled)',
    tooltip:
      'Provenance is recording, but you have not enrolled, so this work is not attributed ' +
      `to you.\nEnrol at ${ENROLL_URL}, then run "Provenance: Import Enrollment Token".`,
  };
}

// ---------------------------------------------------------------------------
// The nudge
// ---------------------------------------------------------------------------

/** What the student did with the notification. */
export type NudgeAction = 'enroll' | 'show_key' | 'dismiss';

/** Button labels, in the order they are offered. */
export const NUDGE_ENROLL_LABEL = 'Enroll';
export const NUDGE_SHOW_KEY_LABEL = 'Show My Key';
export const NUDGE_LATER_LABEL = 'Later';

export const NUDGE_MESSAGE =
  'Provenance is recording, but you have not enrolled — this work will not be attributed to you.';

/**
 * Show the nudge this session?
 *
 * `done` is terminal. `unseen` and `intent` both show, which caps the student's
 * lifetime exposure at two notifications: one on the first un-enrolled session,
 * and one more only if they showed intent and did not finish.
 */
export function shouldShowNudge(input: {
  outcomes: readonly IdentityOutcome[];
  state: NudgeState;
}): boolean {
  if (input.state === 'done') return false;
  return isUnenrolled(input.outcomes);
}

/**
 * The state to persist after the student acts.
 *
 * Dismissing means no, and no is permanent — a student who has decided must not
 * be asked again. Clicking through to enrol or to see their key is intent, which
 * buys exactly one follow-up: the browser opens, real life intervenes, and the
 * token never gets pasted. The second nudge catches that. There is no third,
 * whatever they click, because at that point the persistent "(not enrolled)"
 * status bar has said it every session and a popup is nagging.
 */
export function nextNudgeState(current: NudgeState, action: NudgeAction): NudgeState {
  if (current === 'done') return 'done';
  if (action === 'dismiss') return 'done';
  // 'enroll' | 'show_key'
  return current === 'unseen' ? 'intent' : 'done';
}
