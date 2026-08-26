import { describe, it, expect } from 'vitest';
import {
  ENROLL_URL,
  NUDGE_MESSAGE,
  anyIdentityEmitted,
  enrollmentStatusBar,
  isUnenrolled,
  isUnenrolledSkip,
  nextNudgeState,
  parseNudgeState,
  shouldShowNudge,
} from './enroll-nudge.js';
import type { EnrollmentSession, NudgeAction, NudgeState } from './enroll-nudge.js';
import type { IdentityOutcome, IdentitySkipReason } from '../identity/session-identity.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Every skip reason the builder can return, so the partition below is exhaustive. */
const ALL_SKIP_REASONS: readonly IdentitySkipReason[] = [
  { kind: 'no_root_public_key' },
  { kind: 'institution_cert_not_root_signed' },
  { kind: 'credential_key_mismatch', credential_student_pubkey: 'aa', derived_pubkey: 'bb' },
  { kind: 'manifest_not_2_0' },
  { kind: 'not_enrolled', course_id: 'cs61b' },
  { kind: 'master_secret_unavailable', reason: 'keyring_unavailable' },
  { kind: 'invalid_session_pubkey' },
  { kind: 'student_key_mismatch', token_student_pubkey: 'aa', derived_pubkey: 'bb' },
  { kind: 'chain_did_not_verify', error: { kind: 'bad_signature' } as never },
  { kind: 'unexpected_error', reason: 'boom' },
];

const skipped = (reason: IdentitySkipReason): IdentityOutcome => ({ kind: 'skipped', reason });

/** An `emitted` outcome. The payload is never read by this module, only the tag. */
const emitted = (): IdentityOutcome =>
  ({ kind: 'emitted', identity: {}, verified: {} }) as unknown as IdentityOutcome;

/**
 * A session whose course REQUIRES enrollment — the default, and what every
 * manifest issued before `policy.enrollment` existed means.
 */
const req = (outcome: IdentityOutcome): EnrollmentSession => ({
  outcome,
  enrollmentRequired: true,
});

/** A session whose course signed `policy.enrollment.required: false`. */
const opt = (outcome: IdentityOutcome): EnrollmentSession => ({
  outcome,
  enrollmentRequired: false,
});

// ---------------------------------------------------------------------------
// isUnenrolledSkip — the partition
// ---------------------------------------------------------------------------

describe('isUnenrolledSkip', () => {
  it('is true for exactly the two reasons enrolling would fix', () => {
    const actionable = ALL_SKIP_REASONS.filter(isUnenrolledSkip).map((r) => r.kind);
    expect(actionable.sort()).toEqual(['manifest_not_2_0', 'not_enrolled']);
  });

  it.each([
    'no_root_public_key',
    'institution_cert_not_root_signed',
    'master_secret_unavailable',
    'invalid_session_pubkey',
    'chain_did_not_verify',
    'unexpected_error',
  ])('does not blame the student for %s', (kind) => {
    const reason = ALL_SKIP_REASONS.find((r) => r.kind === kind);
    expect(reason && isUnenrolledSkip(reason)).toBe(false);
  });

  it.each(['credential_key_mismatch', 'student_key_mismatch'])(
    'stays quiet for %s — they have a credential, it is the wrong machine',
    (kind) => {
      const reason = ALL_SKIP_REASONS.find((r) => r.kind === kind);
      expect(reason && isUnenrolledSkip(reason)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// isUnenrolled — across sessions
// ---------------------------------------------------------------------------

describe('isUnenrolled', () => {
  it('is false when a session emitted an identity', () => {
    expect(isUnenrolled([req(emitted())])).toBe(false);
  });

  it('is false for a LEGACY 2.0 holder: they emit, so they are attributed', () => {
    // The regression this module exists to avoid. A 2.0 token stores no 2.1
    // credential, so a credential lookup would call this student "not enrolled"
    // and tell them their work is unattributed. It is not.
    expect(isUnenrolled([req(emitted())])).toBe(false);
    expect(anyIdentityEmitted([emitted(), skipped({ kind: 'not_enrolled', course_id: 'x' })])).toBe(
      true,
    );
  });

  it('is false when one root of several emitted', () => {
    expect(
      isUnenrolled([req(skipped({ kind: 'not_enrolled', course_id: 'x' })), req(emitted())]),
    ).toBe(false);
  });

  it('is true when every session skipped for want of a credential', () => {
    expect(isUnenrolled([req(skipped({ kind: 'not_enrolled', course_id: 'cs61b' }))])).toBe(true);
    expect(isUnenrolled([req(skipped({ kind: 'manifest_not_2_0' }))])).toBe(true);
  });

  it('is false when the only skip is a broken build, not a missing enrollment', () => {
    expect(isUnenrolled([req(skipped({ kind: 'no_root_public_key' }))])).toBe(false);
    expect(
      isUnenrolled([req(skipped({ kind: 'master_secret_unavailable', reason: 'locked' }))]),
    ).toBe(false);
  });

  it('is true when a broken root sits alongside an un-enrolled one', () => {
    expect(
      isUnenrolled([
        req(skipped({ kind: 'no_root_public_key' })),
        req(skipped({ kind: 'not_enrolled', course_id: 'cs61c' })),
      ]),
    ).toBe(true);
  });

  it('is false with no sessions at all', () => {
    expect(isUnenrolled([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Status bar wording
// ---------------------------------------------------------------------------

describe('enrollmentStatusBar', () => {
  it('is unchanged from the pre-nudge build when enrolled', () => {
    const { text, tooltip } = enrollmentStatusBar(false);
    expect(text).toBe('$(record) Provenance: recording');
    expect(tooltip).toBe('Provenance recorder is active for this assignment.');
  });

  it('still says "recording" first when un-enrolled — recording never stopped', () => {
    expect(enrollmentStatusBar(true).text).toContain('Provenance: recording');
  });

  it('names the consequence and carries the URL in the tooltip', () => {
    const { text, tooltip } = enrollmentStatusBar(true);
    expect(text).toContain('(not enrolled)');
    expect(tooltip).toContain('not attributed');
    expect(tooltip).toContain(ENROLL_URL);
  });
});

// ---------------------------------------------------------------------------
// shouldShowNudge
// ---------------------------------------------------------------------------

describe('shouldShowNudge', () => {
  const unenrolled = [req(skipped({ kind: 'not_enrolled', course_id: 'cs61b' }))];

  it.each<NudgeState>(['unseen', 'intent'])('shows while state is %s', (state) => {
    expect(shouldShowNudge({ sessions: unenrolled, state })).toBe(true);
  });

  it('never shows once done', () => {
    expect(shouldShowNudge({ sessions: unenrolled, state: 'done' })).toBe(false);
  });

  it('never shows to an enrolled student, whatever the state', () => {
    for (const state of ['unseen', 'intent', 'done'] as NudgeState[]) {
      expect(shouldShowNudge({ sessions: [req(emitted())], state })).toBe(false);
    }
  });

  it('never shows when the identity failed for a reason enrolling cannot fix', () => {
    expect(
      shouldShowNudge({ sessions: [req(skipped({ kind: 'no_root_public_key' }))], state: 'unseen' }),
    ).toBe(false);
  });

  it('names the consequence rather than just asking them to enrol', () => {
    expect(NUDGE_MESSAGE).toContain('not be attributed');
  });
});

// ---------------------------------------------------------------------------
// nextNudgeState — the two-notification ceiling
// ---------------------------------------------------------------------------

describe('nextNudgeState', () => {
  it('dismissing is permanent, from either live state', () => {
    expect(nextNudgeState('unseen', 'dismiss')).toBe('done');
    expect(nextNudgeState('intent', 'dismiss')).toBe('done');
  });

  it.each<NudgeAction>(['enroll', 'show_key'])('%s from unseen buys one follow-up', (action) => {
    expect(nextNudgeState('unseen', action)).toBe('intent');
  });

  it.each<NudgeAction>(['enroll', 'show_key'])('%s from intent ends it', (action) => {
    expect(nextNudgeState('intent', action)).toBe('done');
  });

  it('done is terminal under every action', () => {
    for (const action of ['enroll', 'show_key', 'dismiss'] as NudgeAction[]) {
      expect(nextNudgeState('done', action)).toBe('done');
    }
  });

  it('caps lifetime notifications at two on the click-through path', () => {
    const unenrolled = [req(skipped({ kind: 'not_enrolled', course_id: 'cs61b' }))];
    let state: NudgeState = 'unseen';
    let shown = 0;
    // Ten un-enrolled sessions, the student clicking "Enroll" every time and
    // never finishing. The status bar keeps saying it; the popup must not.
    for (let i = 0; i < 10; i++) {
      if (shouldShowNudge({ sessions: unenrolled, state })) {
        shown++;
        state = nextNudgeState(state, 'enroll');
      }
    }
    expect(shown).toBe(2);
    expect(state).toBe('done');
  });

  it('caps at one when the student dismisses', () => {
    const unenrolled = [req(skipped({ kind: 'not_enrolled', course_id: 'cs61b' }))];
    let state: NudgeState = 'unseen';
    let shown = 0;
    for (let i = 0; i < 10; i++) {
      if (shouldShowNudge({ sessions: unenrolled, state })) {
        shown++;
        state = nextNudgeState(state, 'dismiss');
      }
    }
    expect(shown).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// parseNudgeState
// ---------------------------------------------------------------------------

describe('parseNudgeState', () => {
  it('round-trips the two persisted states', () => {
    expect(parseNudgeState('intent')).toBe('intent');
    expect(parseNudgeState('done')).toBe('done');
  });

  it.each([undefined, null, '', 'nonsense', 42, {}])('treats %o as fresh', (raw) => {
    expect(parseNudgeState(raw)).toBe('unseen');
  });
});

// ---------------------------------------------------------------------------
// policy.enrollment.required: false — the course that does not prompt
// ---------------------------------------------------------------------------

describe('a course that does not require enrollment', () => {
  const noCredential = () => skipped({ kind: 'not_enrolled', course_id: 'cs61a' });

  it('shows no un-enrolled state when it is the only course open', () => {
    expect(isUnenrolled([opt(noCredential())])).toBe(false);
  });

  it('shows no nudge, in any state', () => {
    for (const state of ['unseen', 'intent'] as NudgeState[]) {
      expect(shouldShowNudge({ sessions: [opt(noCredential())], state })).toBe(false);
    }
  });

  it('silences a manifest_not_2_0 skip too, not just not_enrolled', () => {
    expect(isUnenrolled([opt(skipped({ kind: 'manifest_not_2_0' }))])).toBe(false);
  });

  it('silences several such roots at once', () => {
    expect(isUnenrolled([opt(noCredential()), opt(noCredential())])).toBe(false);
  });

  // The status bar is ONE global item across every open assignment root, so a
  // course that waived enrollment must not speak for a course that did not.
  it('does not speak for a second course that DOES require enrollment', () => {
    const sessions = [opt(noCredential()), req(skipped({ kind: 'not_enrolled', course_id: 'cs61b' }))];
    expect(isUnenrolled(sessions)).toBe(true);
    expect(shouldShowNudge({ sessions, state: 'unseen' })).toBe(true);
  });

  it('is silent when the requiring course is the one that succeeded', () => {
    expect(isUnenrolled([opt(noCredential()), req(emitted())])).toBe(false);
  });

  // The legacy-2.0 rule survives the filter. A student holding a per-course 2.0
  // token enrolled in cs61b but not cs61c IS attributed somewhere, so "recording"
  // stays the honest status line — `anyIdentityEmitted` still reads EVERY
  // session, waived ones included, and only the "who still needs it" side is
  // filtered. Reversing that would call an attributed student un-enrolled.
  it('still counts an emitted identity from a waived course as being enrolled', () => {
    const sessions = [opt(emitted()), req(skipped({ kind: 'not_enrolled', course_id: 'cs61b' }))];
    expect(isUnenrolled(sessions)).toBe(false);
    expect(shouldShowNudge({ sessions, state: 'unseen' })).toBe(false);
  });

  it('does not suppress a diagnostic the student could not act on anyway', () => {
    // A waived course with a broken keyring reads exactly as it did before:
    // not un-enrolled, because "not enrolled" was never the right diagnosis.
    expect(
      isUnenrolled([opt(skipped({ kind: 'master_secret_unavailable', reason: 'locked' }))]),
    ).toBe(false);
  });
});
