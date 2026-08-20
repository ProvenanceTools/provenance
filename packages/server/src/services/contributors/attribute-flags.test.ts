/**
 * Which findings may name a person — §6 Rule 2.
 *
 * Pure tests over {@link contributorKeyForSession}, the single predicate
 * deciding whether a flag is charged to a contributor or left scope-level.
 *
 * The rule: a finding names a person ONLY when the evidence is `established`
 * for that person. `attributed` — a chain that was walked and verified — is the
 * only verdict that qualifies.
 *
 * The two that must NOT qualify are different mistakes with the same victim:
 *
 *  - `unattributed` (no identity block at all) is the ORDINARY, blameless state
 *    for almost every bundle today. Charging it to anyone would attribute a
 *    finding on the basis of no identity evidence whatsoever.
 *  - `unverifiable` (an identity block that is present and does NOT verify) is
 *    the dangerous one. The block NAMES someone. Charging the finding to the
 *    contributor it names is exactly how a forged identity block would launder
 *    work onto an innocent student — the artifact would be choosing who gets
 *    blamed.
 */

import { describe, it, expect } from 'vitest';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { SessionContributor } from '@provenance/analysis-core/identity/types.js';
import { contributorKeyForSession, SCOPE_LEVEL } from './attribute-flags.js';

const ALICE_KEY = 'attributed:2.1:institution:berkeley:alice-ref';

/** A Bundle carrying only the contributor stamp these tests read. */
function bundleWith(bySession: Record<string, SessionContributor>): Bundle {
  return {
    contributors: {
      bySession: new Map(Object.entries(bySession)),
      contributors: [],
      rootKeyConfigured: true,
      counts: { attributed: 0, unverifiable: 0, unattributed: 0 },
    },
  } as unknown as Bundle;
}

describe('contributorKeyForSession', () => {
  it('names the contributor for a session whose chain verified', () => {
    const bundle = bundleWith({
      s1: {
        kind: 'attributed',
        sessionId: 's1',
        contributorKey: ALICE_KEY,
        studentRef: 'alice-ref',
        identityVersion: '2.1',
        scope: 'institution',
        scopeId: 'berkeley',
        studentPubkey: 'a'.repeat(64),
        certWindow: { in_window: true },
        credentialWindow: { in_window: true },
      } as SessionContributor,
    });

    expect(contributorKeyForSession(bundle, 's1')).toBe(ALICE_KEY);
  });

  it('names NOBODY for a session with no identity block (the ordinary case)', () => {
    const bundle = bundleWith({
      s1: { kind: 'unattributed', sessionId: 's1', contributorKey: 'unattributed:s1' },
    });

    expect(contributorKeyForSession(bundle, 's1')).toBe(SCOPE_LEVEL);
  });

  it('names NOBODY for an identity block that does not verify, even though it names someone', () => {
    const bundle = bundleWith({
      s1: {
        kind: 'unverifiable',
        sessionId: 's1',
        contributorKey: 'unverifiable:s1',
        // The artifact CLAIMS to be Alice. It cannot back the claim.
        claimedStudentRef: 'alice-ref',
        claimedScopeId: 'berkeley',
        claimedIdentityVersion: '2.1',
        reason: { kind: 'chain_failed', error: 'bad_signature', detail: 'x' },
      } as unknown as SessionContributor,
    });

    // Not `ALICE_KEY`, and not the singleton either — nothing is charged to a
    // person on the strength of a claim that did not verify.
    expect(contributorKeyForSession(bundle, 's1')).toBe(SCOPE_LEVEL);
  });

  it('names nobody for a flag with no single session (multi-session or none)', () => {
    // `run-per-submission.ts` already writes '' when a flag's supporting events
    // span more than one session, or when it has none (the validation-derived
    // integrity flags, which are properties of the bundle, not of a person).
    const bundle = bundleWith({});
    expect(contributorKeyForSession(bundle, '')).toBe(SCOPE_LEVEL);
  });

  it('names nobody for a session the stamp does not know', () => {
    const bundle = bundleWith({});
    expect(contributorKeyForSession(bundle, 'ghost')).toBe(SCOPE_LEVEL);
  });

  it('names nobody when the bundle carries no contributor stamp at all', () => {
    // An UNSTAMPED bundle reads as fully unattributed — the fail-toward-fewer-
    // NAMES direction. Findings are still produced; none of them names a person.
    expect(contributorKeyForSession({} as Bundle, 's1')).toBe(SCOPE_LEVEL);
  });
});
