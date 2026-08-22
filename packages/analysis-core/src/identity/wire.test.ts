/**
 * The contributor stamp across the HTTP boundary.
 *
 * These tests exist because a lossy stamp is not a cosmetic bug. The three
 * states are three different facts, and each collapse has a named victim:
 *
 *  - `unverifiable` → `unattributed` hides an artifact making a claim it cannot
 *    back.
 *  - `unattributed` → `unverifiable` manufactures a finding against a student
 *    whose only act was not enrolling.
 *  - "we could not check" → "we checked and it failed" turns one unset
 *    environment variable into a page of failed students.
 *
 * So the round trip is asserted field by field, not by a shape check.
 */

import { describe, expect, it } from 'vitest';
import {
  isIdentityCheckFailure,
  type BundleContributors,
  type SessionContributor,
} from './types.js';
import {
  fromWireBundleContributors,
  fromWireSessionContributor,
  toWireBundleContributors,
  toWireSessionContributor,
} from './wire.js';

function roundTrip(c: SessionContributor): SessionContributor {
  return fromWireSessionContributor(toWireSessionContributor(c));
}

const ATTRIBUTED: SessionContributor = {
  kind: 'attributed',
  sessionId: 's-alice',
  contributorKey: 'attributed:2.1:institution:berkeley:alice',
  studentRef: 'alice',
  identityVersion: '2.1',
  scope: 'institution',
  scopeId: 'berkeley',
  studentPubkey: 'ab'.repeat(32),
  certWindow: { in_window: true },
  credentialWindow: { in_window: false, reason: 'after_valid_until' },
};

const UNATTRIBUTED: SessionContributor = {
  kind: 'unattributed',
  sessionId: 's-nobody',
  contributorKey: 'unattributed:s-nobody',
};

describe('the contributor stamp round-trips through the wire shape', () => {
  it('keeps every field of an attributed session, including both windows', () => {
    expect(roundTrip(ATTRIBUTED)).toEqual(ATTRIBUTED);
  });

  it('keeps an unattributed session unattributed', () => {
    const back = roundTrip(UNATTRIBUTED);
    expect(back).toEqual(UNATTRIBUTED);
    expect(back.kind).toBe('unattributed');
  });

  /**
   * The claim travels VERBATIM and stays a claim: the contributor key is still
   * the per-session singleton, never the ref it names. Merging the two is
   * precisely how a forged identity block would launder work onto an innocent
   * student.
   */
  it('keeps an unverifiable session unverifiable, with its claim intact and unmerged', () => {
    const c: SessionContributor = {
      kind: 'unverifiable',
      sessionId: 's-claimant',
      contributorKey: 'unverifiable:s-claimant',
      claimedStudentRef: 'bob',
      claimedScopeId: 'cs61b-fa26',
      claimedIdentityVersion: '2.0',
      reason: {
        kind: 'chain_failed',
        error: { kind: 'invalid_course_signature' },
        detail: 'bad sig',
      },
    };
    const back = roundTrip(c);
    expect(back).toEqual(c);
    if (back.kind !== 'unverifiable') throw new Error('arm changed');
    expect(back.contributorKey).toBe('unverifiable:s-claimant');
    expect(back.contributorKey).not.toContain('bob');
  });

  /**
   * "We could not check" and "we checked and it failed" are both `unverifiable`
   * and `isIdentityCheckFailure` is the only thing that separates them. A
   * deployment with no root key produces the first for EVERY identified session.
   */
  it.each([
    ['no_root_key', false],
    ['no_trust_anchor', false],
    ['anchor_not_root_signed', true],
    ['chain_failed', true],
  ] as const)('preserves whether the check was performed: %s', (kind, performed) => {
    const reason =
      kind === 'no_trust_anchor'
        ? ({ kind, required: 'institution_cert', detail: 'no anchor' } as const)
        : kind === 'chain_failed'
          ? ({ kind, error: { kind: 'invalid_token_shape' }, detail: 'walk failed' } as const)
          : ({ kind, detail: 'n/a' } as const);
    const back = roundTrip({
      kind: 'unverifiable',
      sessionId: 's-x',
      contributorKey: 'unverifiable:s-x',
      claimedStudentRef: null,
      claimedScopeId: null,
      claimedIdentityVersion: null,
      reason,
    });
    if (back.kind !== 'unverifiable') throw new Error('arm changed');
    expect(back.reason.kind).toBe(kind);
    expect(isIdentityCheckFailure(back.reason)).toBe(performed);
  });

  it('preserves which trust anchor a no_trust_anchor verdict needed', () => {
    const back = roundTrip({
      kind: 'unverifiable',
      sessionId: 's-x',
      contributorKey: 'unverifiable:s-x',
      claimedStudentRef: null,
      claimedScopeId: null,
      claimedIdentityVersion: null,
      reason: { kind: 'no_trust_anchor', required: 'institution_cert', detail: 'd' },
    });
    if (back.kind !== 'unverifiable' || back.reason.kind !== 'no_trust_anchor') {
      throw new Error('arm changed');
    }
    expect(back.reason.required).toBe('institution_cert');
  });
});

describe('the bundle-level stamp', () => {
  const stamp: BundleContributors = {
    bySession: new Map<string, SessionContributor>([
      ['s-alice', ATTRIBUTED],
      ['s-nobody', UNATTRIBUTED],
    ]),
    contributors: [
      {
        key: ATTRIBUTED.contributorKey,
        kind: 'attributed',
        studentRef: 'alice',
        identityVersion: '2.1',
        scope: 'institution',
        scopeId: 'berkeley',
        sessionIds: ['s-alice'],
      },
      {
        key: UNATTRIBUTED.contributorKey,
        kind: 'unattributed',
        studentRef: null,
        identityVersion: null,
        scope: null,
        scopeId: null,
        sessionIds: ['s-nobody'],
      },
    ],
    rootKeyConfigured: true,
    counts: { attributed: 1, unverifiable: 0, unattributed: 1 },
  };

  it('round-trips, with bySession still total over the sessions', () => {
    const back = fromWireBundleContributors(toWireBundleContributors(stamp));
    expect([...back.bySession.keys()].sort()).toEqual(['s-alice', 's-nobody']);
    expect(back.bySession.get('s-alice')).toEqual(ATTRIBUTED);
    expect(back.bySession.get('s-nobody')).toEqual(UNATTRIBUTED);
    expect(back.contributors).toEqual(stamp.contributors);
    expect(back.counts).toEqual(stamp.counts);
  });

  /**
   * A Map serializes to `{}`. If `by_session` were ever an object rather than an
   * array, every submission would arrive reporting no contributors at all —
   * quiet, and a stronger-and-false claim than "not available".
   */
  it('survives an actual JSON round trip, which a Map would not', () => {
    const json = JSON.parse(JSON.stringify(toWireBundleContributors(stamp)));
    const back = fromWireBundleContributors(json);
    expect(back.bySession.size).toBe(2);
    expect(back.bySession.get('s-alice')).toEqual(ATTRIBUTED);
  });

  /**
   * `false` is a DEPLOYMENT fact — no root public key is set, so no chain of any
   * version could be walked. It must not arrive as `true`.
   */
  it('preserves rootKeyConfigured: false', () => {
    const back = fromWireBundleContributors(
      toWireBundleContributors({ ...stamp, rootKeyConfigured: false }),
    );
    expect(back.rootKeyConfigured).toBe(false);
  });
});
