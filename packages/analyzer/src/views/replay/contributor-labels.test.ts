/**
 * contributor-labels.test — the three distinctions that must never collapse.
 *
 * These assertions are deliberately about WORDING, not only about shape. The
 * wording is the safeguard: a renderer that picks the right tone and writes the
 * wrong sentence has still told a grader the wrong thing, and four false
 * accusations this programme has produced were all reachable through prose.
 */

import { describe, it, expect } from 'vitest';
import type { Contributor, SessionContributor } from '@provenance/analysis-core/identity/types.js';
import {
  describeAmbiguityKind,
  labelContributor,
  labelSessionContributor,
  toneIsFinding,
} from './contributor-labels.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const attributed: SessionContributor = {
  kind: 'attributed',
  sessionId: 'sess-alice',
  contributorKey: 'attributed:2.1:institution:inst1:alice',
  studentRef: 'alice',
  identityVersion: '2.1',
  scope: 'institution',
  scopeId: 'inst1',
  studentPubkey: 'pk',
  certWindow: { in_window: true },
  credentialWindow: { in_window: true },
};

const unattributed: SessionContributor = {
  kind: 'unattributed',
  sessionId: 'sess-nobody',
  contributorKey: 'unattributed:sess-nobody',
};

/** "We could not check" — no root public key on this deployment. */
const notChecked: SessionContributor = {
  kind: 'unverifiable',
  sessionId: 'sess-claim',
  contributorKey: 'unverifiable:sess-claim',
  claimedStudentRef: 'carol',
  claimedScopeId: 'inst1',
  claimedIdentityVersion: '2.1',
  reason: { kind: 'no_root_key', detail: 'no root public key is configured' },
};

/** "We checked and it failed." */
const checkFailed: SessionContributor = {
  kind: 'unverifiable',
  sessionId: 'sess-forged',
  contributorKey: 'unverifiable:sess-forged',
  claimedStudentRef: 'dave',
  claimedScopeId: 'inst1',
  claimedIdentityVersion: '2.1',
  reason: {
    kind: 'anchor_not_root_signed',
    detail: 'travelling institution cert does not verify against the root key',
  },
};

// ---------------------------------------------------------------------------
// unverifiable vs unattributed
// ---------------------------------------------------------------------------

describe('unverifiable is not unattributed', () => {
  it('gives the two states different tones', () => {
    expect(labelSessionContributor(unattributed).tone).toBe('unattributed');
    expect(labelSessionContributor(notChecked).tone).not.toBe('unattributed');
    expect(labelSessionContributor(checkFailed).tone).not.toBe('unattributed');
  });

  it('gives the two states different short labels', () => {
    const a = labelSessionContributor(unattributed).short;
    const b = labelSessionContributor(notChecked).short;
    expect(a).not.toBe(b);
  });

  it('never describes an unattributed session as carrying a claim', () => {
    const label = labelSessionContributor(unattributed);
    expect(label.detail).toMatch(/no identity block/i);
    // The words that would turn an administrative gap into a finding.
    expect(label.detail).not.toMatch(/verif/i);
    expect(label.detail).not.toMatch(/fail/i);
    expect(label.detail).not.toMatch(/claim/i);
  });

  it('says an unattributed session is not a finding and is never grouped', () => {
    const label = labelSessionContributor(unattributed);
    expect(label.detail).toMatch(/not a finding/i);
    expect(label.detail).toMatch(/never grouped/i);
  });

  it('does not let an unattributed session read as a finding', () => {
    expect(toneIsFinding(labelSessionContributor(unattributed).tone)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cannot-check vs checked-and-failed
// ---------------------------------------------------------------------------

describe('"we could not check" is not "we checked and it failed"', () => {
  it('separates them by tone', () => {
    expect(labelSessionContributor(notChecked).tone).toBe('identity_not_checked');
    expect(labelSessionContributor(checkFailed).tone).toBe('identity_check_failed');
  });

  it('separates them by checkPerformed', () => {
    expect(labelSessionContributor(notChecked).checkPerformed).toBe(false);
    expect(labelSessionContributor(checkFailed).checkPerformed).toBe(true);
  });

  it('never uses failure language for a check that could not be run', () => {
    const label = labelSessionContributor(notChecked);
    expect(label.short).toMatch(/not checked/i);
    expect(label.short).not.toMatch(/fail/i);
    expect(label.detail).toMatch(/could not be checked/i);
    expect(label.detail).toMatch(/not a failed verification/i);
  });

  it('does use failure language when the check really failed', () => {
    const label = labelSessionContributor(checkFailed);
    expect(label.detail).toMatch(/did not verify/i);
  });

  it('treats only the real failure as a finding', () => {
    expect(toneIsFinding(labelSessionContributor(notChecked).tone)).toBe(false);
    expect(toneIsFinding(labelSessionContributor(checkFailed).tone)).toBe(true);
  });

  it('reports a claim as a claim and never as the contributor', () => {
    // The short label — the text that appears where a reader scans for "who" —
    // must not be the claimed name, or a forged block launders work onto an
    // innocent student simply by being displayed.
    expect(labelSessionContributor(checkFailed).short).not.toContain('dave');
    expect(labelSessionContributor(notChecked).short).not.toContain('carol');
    // It is still stated, as a claim, in the detail.
    expect(labelSessionContributor(checkFailed).detail).toContain('dave');
  });
});

// ---------------------------------------------------------------------------
// attributed
// ---------------------------------------------------------------------------

describe('an attributed contributor', () => {
  it('is named by the verified student ref', () => {
    const label = labelSessionContributor(attributed);
    expect(label.short).toBe('alice');
    expect(label.tone).toBe('attributed');
    expect(toneIsFinding(label.tone)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Grouped contributors
// ---------------------------------------------------------------------------

describe('labelContributor (the switcher option text)', () => {
  const grouped: Contributor = {
    key: 'attributed:2.1:institution:inst1:alice',
    kind: 'attributed',
    studentRef: 'alice',
    identityVersion: '2.1',
    scope: 'institution',
    scopeId: 'inst1',
    sessionIds: ['s1', 's2'],
  };

  it('says two machines of one student are one contributor', () => {
    const label = labelContributor(grouped);
    expect(label.short).toBe('alice');
    expect(label.detail).toMatch(/2 sessions/);
    expect(label.detail).toMatch(/two machines is one contributor/i);
  });

  it('never groups or distinguishes unattributed singletons', () => {
    const singleton: Contributor = {
      key: 'unattributed:s9',
      kind: 'unattributed',
      studentRef: null,
      identityVersion: null,
      scope: null,
      scopeId: null,
      sessionIds: ['s9'],
    };
    const label = labelContributor(singleton);
    expect(label.tone).toBe('unattributed');
    expect(label.detail).toMatch(/never grouped together/i);
    expect(label.detail).toMatch(/never asserted to be different people/i);
    expect(label.detail).toMatch(/not a finding/i);
  });

  it('makes the weaker statement for a grouped unverifiable, which carries no reason', () => {
    const claim: Contributor = {
      key: 'unverifiable:s7',
      kind: 'unverifiable',
      studentRef: null,
      identityVersion: null,
      scope: null,
      scopeId: null,
      sessionIds: ['s7'],
    };
    const label = labelContributor(claim);
    // A `Contributor` does not carry `IdentityUnverifiableReason`, so this shape
    // cannot tell cannot-check from checked-and-failed. It must therefore not
    // assert either — asserting the failure would be the exact collapse the
    // per-session label exists to prevent.
    expect(label.detail).not.toMatch(/did not verify/i);
    expect(label.checkPerformed).toBeNull();
    expect(label.detail).toMatch(/whether the claim failed a check or could not be checked/i);
  });

  it('never names the student an unverified claim points at', () => {
    const claim: Contributor = {
      key: 'unverifiable:s7',
      kind: 'unverifiable',
      studentRef: null,
      identityVersion: null,
      scope: null,
      scopeId: null,
      sessionIds: ['s7'],
    };
    // `Contributor.studentRef` is null for every non-attributed kind by design.
    expect(labelContributor(claim).short).not.toMatch(/alice|bob|carol|dave/i);
  });
});

// ---------------------------------------------------------------------------
// concurrent vs unknown
// ---------------------------------------------------------------------------

describe('concurrent is not unknown', () => {
  it('gives them different titles', () => {
    const c = describeAmbiguityKind('concurrent', 'hw.py');
    const u = describeAmbiguityKind('unknown', 'hw.py');
    expect(c.title).not.toBe(u.title);
  });

  it('states concurrency as a positive fact about the evidence', () => {
    const c = describeAmbiguityKind('concurrent', 'hw.py');
    expect(c.body).toMatch(/does not order/i);
    expect(c.body).toMatch(/clocks are not evidence/i);
    // It must say BOTH are shown and neither is preferred.
    expect(c.body).toMatch(/both versions are shown/i);
    expect(c.body).toMatch(/neither is/i);
  });

  it('states unknown as the absence of a record, not a race', () => {
    const u = describeAmbiguityKind('unknown', 'hw.py');
    expect(u.body).toMatch(/absence of a record/i);
    expect(u.body).toMatch(/not a claim that the edits raced/i);
    expect(u.body).toMatch(/not a finding/i);
  });

  it('does not describe unknown as concurrency', () => {
    const u = describeAmbiguityKind('unknown', 'hw.py');
    expect(u.title).not.toMatch(/no single version/i);
  });

  it('names the file in both', () => {
    expect(describeAmbiguityKind('concurrent', 'a/b.py').body).toContain('a/b.py');
    expect(describeAmbiguityKind('unknown', 'a/b.py').body).toContain('a/b.py');
  });
});
