/**
 * Contributor resolution — Tier 1.1.
 *
 * The assertions that matter most here are the NEGATIVE ones. `unattributed`
 * (no identity block — a student who never enrolled) and `unverifiable` (a block
 * that claims something it cannot back) must never collapse into each other, and
 * a session must never be grouped with, or named as, a contributor the evidence
 * does not establish. Each of those is a wrongful-accusation failure, so each one
 * has a test whose only job is to go red if the distinction is lost.
 */

import { describe, it, expect } from 'vitest';
import type { SessionIdentity } from '@provenance/log-core';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import {
  buildTrustChainKeys,
  buildManifest2,
  buildManifest1x,
  sessionStart2,
  sessionStart1x,
} from '../test-support/build-manifest-2.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  buildCourseIdentity,
  seededKeypair,
} from '../test-support/build-identity.js';
import type { IdentityTestKeys } from '../test-support/build-identity.js';
import { loadBundle } from '../loader/parse-bundle.js';
import type { Bundle } from '../loader/types.js';
import {
  resolveBundleContributors,
  establishBundleContributors,
  contributorOf,
  contributorsOf,
  attributedContributorsOf,
  compareContributors,
  isIdentityCheckFailure,
  describeSessionContributor,
  attributedContributorKey,
} from './resolve-contributors.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';
const BOB = '3a1d0e55-8c44-4b2a-a7f0-11c9d2e3f4a5';

type SessionSpec = {
  /** Omit for a session with NO identity block — the blameless, ordinary case. */
  identity?: SessionIdentity | Record<string, unknown>;
  sessionPubkeyHex: string;
  /** Extra `session.start.data` fields, e.g. an embedded Manifest 2.0. */
  extra?: Record<string, unknown>;
};

async function loadWith(specs: SessionSpec[]): Promise<Bundle> {
  const built = await buildTestBundle({
    sessions: specs.map((spec) => ({
      sessionStart: {
        ...(spec.extra ?? {}),
        session_pubkey: spec.sessionPubkeyHex,
        ...(spec.identity !== undefined ? { identity: spec.identity } : {}),
      },
    })),
  });
  const res = await loadBundle(built.zipBuffer, 'b.zip', () => '2026-01-01T00:00:00.000Z');
  if (!res.ok) throw new Error(`load failed: ${JSON.stringify(res.error)}`);
  return res.value;
}

/** Distinct per-session ephemeral keys — the real shape, and the reason they cannot group. */
const sessionKey = (i: number): Promise<{ privkey: Uint8Array; pubkeyHex: string }> =>
  seededKeypair(0x60 + i);

let cachedKeys: IdentityTestKeys | null = null;
async function keys(): Promise<IdentityTestKeys> {
  cachedKeys ??= await buildIdentityKeys();
  return cachedKeys;
}

// ---------------------------------------------------------------------------
// attributed — a chain that verified
// ---------------------------------------------------------------------------

describe('attributed', () => {
  it('attributes a 2.1 institution-scoped session to its student_ref', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    const resolved = await resolveBundleContributors(bundle, k.root.pubkeyHex);
    const verdict = resolved.bySession.get(bundle.sessions[0]!.sessionId)!;

    expect(verdict.kind).toBe('attributed');
    if (verdict.kind !== 'attributed') throw new Error('unreachable');
    expect(verdict.studentRef).toBe(ALICE);
    expect(verdict.identityVersion).toBe('2.1');
    expect(verdict.scope).toBe('institution');
    expect(verdict.scopeId).toBe('berkeley');
    expect(verdict.studentPubkey).toBe(k.student.pubkeyHex);
    expect(resolved.counts).toEqual({ attributed: 1, unverifiable: 0, unattributed: 0 });
  });

  it('still attributes an ARCHIVED 2.0 course-scoped session', async () => {
    const k = await keys();
    const chain = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys: chain });
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        extra: sessionStart2(manifest),
        identity: await buildCourseIdentity({
          keys: k,
          coursePrivkey: chain.coursePrivkey,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    const resolved = await resolveBundleContributors(bundle, chain.rootPubkeyHex);
    const verdict = resolved.bySession.get(bundle.sessions[0]!.sessionId)!;

    expect(verdict.kind).toBe('attributed');
    if (verdict.kind !== 'attributed') throw new Error('unreachable');
    expect(verdict.studentRef).toBe(ALICE);
    expect(verdict.identityVersion).toBe('2.0');
    expect(verdict.scope).toBe('course');
    expect(verdict.scopeId).toBe('berkeley-cs61b');
  });

  it('reports an out-of-window credential without withdrawing the attribution', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
          // The session runs at 2026-01-01; this credential lapsed in 2025.
          issuedAt: '2025-01-01T00:00:00Z',
          expiresAt: '2025-06-30',
          validFrom: '2024-12-01',
          validUntil: '2025-12-31',
        }),
      },
    ]);

    const resolved = await resolveBundleContributors(bundle, k.root.pubkeyHex);
    const verdict = resolved.bySession.get(bundle.sessions[0]!.sessionId)!;

    expect(verdict.kind).toBe('attributed');
    if (verdict.kind !== 'attributed') throw new Error('unreachable');
    expect(verdict.credentialWindow.in_window).toBe(false);
    expect(verdict.certWindow.in_window).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// unattributed — blameless, and never confused with a failure
// ---------------------------------------------------------------------------

describe('unattributed', () => {
  it('a bundle with no identity block anywhere is fully unattributed and never unverifiable', async () => {
    const k = await keys();
    const bundle = await loadWith([
      { sessionPubkeyHex: (await sessionKey(0)).pubkeyHex },
      { sessionPubkeyHex: (await sessionKey(1)).pubkeyHex },
    ]);

    const resolved = await resolveBundleContributors(bundle, k.root.pubkeyHex);

    expect(resolved.counts).toEqual({ attributed: 0, unverifiable: 0, unattributed: 2 });
  });

  it('never groups two unattributed sessions together', async () => {
    const k = await keys();
    const bundle = await loadWith([
      { sessionPubkeyHex: (await sessionKey(0)).pubkeyHex },
      { sessionPubkeyHex: (await sessionKey(1)).pubkeyHex },
    ]);

    const resolved = await resolveBundleContributors(bundle, k.root.pubkeyHex);
    const keysSeen = resolved.contributors.map((c) => c.key);

    // Two unenrolled people are indistinguishable from one person recording
    // twice. Merging them asserts a relationship no evidence supports.
    expect(resolved.contributors).toHaveLength(2);
    expect(new Set(keysSeen).size).toBe(2);
    for (const c of resolved.contributors) {
      expect(c.kind).toBe('unattributed');
      expect(c.studentRef).toBeNull();
      expect(c.sessionIds).toHaveLength(1);
    }
  });

  it('never reads as suspicious: no claim, no reason, no student ref', async () => {
    const k = await keys();
    const bundle = await loadWith([{ sessionPubkeyHex: (await sessionKey(0)).pubkeyHex }]);
    const resolved = await resolveBundleContributors(bundle, k.root.pubkeyHex);
    const verdict = [...resolved.bySession.values()][0]!;

    expect(verdict.kind).toBe('unattributed');
    expect(Object.keys(verdict)).toEqual(['kind', 'sessionId', 'contributorKey']);
    expect(describeSessionContributor(verdict)).toBe(
      'no identity block recorded — this session is not attributed to anyone',
    );
  });
});

// ---------------------------------------------------------------------------
// unverifiable — present, and not stood behind
// ---------------------------------------------------------------------------

describe('unverifiable', () => {
  it('reports a credential signed by the wrong institution key as a CHECK FAILURE', async () => {
    const k = await keys();
    const impostor = await seededKeypair(0x7a);
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
          credentialSignedBy: impostor.privkey,
        }),
      },
    ]);

    const resolved = await resolveBundleContributors(bundle, k.root.pubkeyHex);
    const verdict = [...resolved.bySession.values()][0]!;

    expect(verdict.kind).toBe('unverifiable');
    if (verdict.kind !== 'unverifiable') throw new Error('unreachable');
    expect(verdict.reason.kind).toBe('chain_failed');
    expect(isIdentityCheckFailure(verdict.reason)).toBe(true);
    if (verdict.reason.kind !== 'chain_failed') throw new Error('unreachable');
    expect(verdict.reason.error.kind).toBe('invalid_institution_signature');
  });

  it('reports a session countersignature made by someone else', async () => {
    const k = await keys();
    const notTheStudent = await seededKeypair(0x7b);
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
          countersignedBy: notTheStudent.privkey,
        }),
      },
    ]);

    const verdict = [
      ...(await resolveBundleContributors(bundle, k.root.pubkeyHex)).bySession.values(),
    ][0]!;
    expect(verdict.kind).toBe('unverifiable');
    if (verdict.kind !== 'unverifiable') throw new Error('unreachable');
    if (verdict.reason.kind !== 'chain_failed') throw new Error('expected chain_failed');
    expect(verdict.reason.error.kind).toBe('invalid_session_pubkey_signature');
  });

  it('refuses an institution cert that root did not sign', async () => {
    const k = await keys();
    const fakeRoot = await seededKeypair(0x7c);
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
          certSignedBy: fakeRoot.privkey,
        }),
      },
    ]);

    const verdict = [
      ...(await resolveBundleContributors(bundle, k.root.pubkeyHex)).bySession.values(),
    ][0]!;
    expect(verdict.kind).toBe('unverifiable');
    if (verdict.kind !== 'unverifiable') throw new Error('unreachable');
    expect(verdict.reason.kind).toBe('anchor_not_root_signed');
    expect(isIdentityCheckFailure(verdict.reason)).toBe(true);
  });

  it('catches the cross-institution forgery (genuine cert for A, credential naming B)', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
          institutionId: 'berkeley',
          // A genuinely root-signed cert — for a DIFFERENT institution.
          certInstitutionId: 'stanford',
        }),
      },
    ]);

    const verdict = [
      ...(await resolveBundleContributors(bundle, k.root.pubkeyHex)).bySession.values(),
    ][0]!;
    if (verdict.kind !== 'unverifiable') throw new Error('expected unverifiable');
    if (verdict.reason.kind !== 'chain_failed') throw new Error('expected chain_failed');
    expect(verdict.reason.error.kind).toBe('institution_mismatch');
  });

  it('NEVER merges an unverifiable session into the contributor it claims', async () => {
    const k = await keys();
    const impostor = await seededKeypair(0x7a);
    const skGood = await sessionKey(0);
    const skBad = await sessionKey(1);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: skGood.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: skGood.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      {
        // Claims to be Alice; the credential is forged.
        sessionPubkeyHex: skBad.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: skBad.pubkeyHex,
          studentRef: ALICE,
          credentialSignedBy: impostor.privkey,
        }),
      },
    ]);

    const resolved = await resolveBundleContributors(bundle, k.root.pubkeyHex);
    const [good, bad] = bundle.sessions.map((s) => resolved.bySession.get(s.sessionId)!);

    expect(good!.kind).toBe('attributed');
    expect(bad!.kind).toBe('unverifiable');
    // Two contributors, not one: the forged block must not launder a second
    // session onto Alice.
    expect(resolved.contributors).toHaveLength(2);
    expect(good!.contributorKey).not.toBe(bad!.contributorKey);
    expect(attributedContributorsOf(bundle)).toEqual([]);

    if (bad!.kind !== 'unverifiable') throw new Error('unreachable');
    // The claim is retained for display — but only as a claim.
    expect(bad!.claimedStudentRef).toBe(ALICE);
    expect(bad!.contributorKey).not.toContain(ALICE);
  });

  it('surfaces an unsupported identity version rather than dropping it', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: {
          enrollment: { format_version: '3.0', student_ref: ALICE },
          enrollment_cert: { format_version: '3.0' },
          session_pubkey_sig: '00'.repeat(64),
        },
      },
    ]);

    const verdict = [
      ...(await resolveBundleContributors(bundle, k.root.pubkeyHex)).bySession.values(),
    ][0]!;
    expect(verdict.kind).toBe('unverifiable');
    if (verdict.kind !== 'unverifiable') throw new Error('unreachable');
    if (verdict.reason.kind !== 'chain_failed') throw new Error('expected chain_failed');
    expect(verdict.reason.error.kind).toBe('unsupported_identity_version');
    expect(verdict.claimedIdentityVersion).toBe('3.0');
  });

  it('treats a present-but-empty identity object as a claim, not as absence', async () => {
    const k = await keys();
    const bundle = await loadWith([
      { sessionPubkeyHex: (await sessionKey(0)).pubkeyHex, identity: {} },
    ]);

    const verdict = [
      ...(await resolveBundleContributors(bundle, k.root.pubkeyHex)).bySession.values(),
    ][0]!;
    expect(verdict.kind).toBe('unverifiable');
  });
});

// ---------------------------------------------------------------------------
// "we cannot check" — a deployment fact, not a student's problem
// ---------------------------------------------------------------------------

describe('no root public key configured', () => {
  it('still loads and analyses, reporting no_root_key rather than a check failure', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    const resolved = await resolveBundleContributors(bundle);

    expect(resolved.rootKeyConfigured).toBe(false);
    expect(bundle.sessions).toHaveLength(1);
    const verdict = [...resolved.bySession.values()][0]!;
    expect(verdict.kind).toBe('unverifiable');
    if (verdict.kind !== 'unverifiable') throw new Error('unreachable');
    expect(verdict.reason.kind).toBe('no_root_key');
    // "we cannot check" — NOT "we checked and it failed".
    expect(isIdentityCheckFailure(verdict.reason)).toBe(false);
  });

  it('an empty-string root key is the same as none', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);
    const resolved = await resolveBundleContributors(bundle, '');
    expect(resolved.rootKeyConfigured).toBe(false);
    expect([...resolved.bySession.values()][0]!.kind).toBe('unverifiable');
  });

  it('does NOT turn a session with no identity block into unverifiable', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      { sessionPubkeyHex: (await sessionKey(1)).pubkeyHex },
    ]);

    const resolved = await resolveBundleContributors(bundle);
    expect(resolved.counts).toEqual({ attributed: 0, unverifiable: 1, unattributed: 1 });
  });

  it('leaves an all-unenrolled cohort entirely blameless on an unconfigured deployment', async () => {
    // A misconfigured deployment must not convert a class of students who never
    // enrolled into a page of identity findings.
    const bundle = await loadWith([
      { sessionPubkeyHex: (await sessionKey(0)).pubkeyHex },
      { sessionPubkeyHex: (await sessionKey(1)).pubkeyHex },
      { sessionPubkeyHex: (await sessionKey(2)).pubkeyHex },
    ]);

    const resolved = await resolveBundleContributors(bundle);
    expect(resolved.rootKeyConfigured).toBe(false);
    expect(resolved.counts).toEqual({ attributed: 0, unverifiable: 0, unattributed: 3 });
    for (const verdict of resolved.bySession.values()) {
      expect(verdict.kind).toBe('unattributed');
    }
  });
});

describe('no trust anchor for an archived 2.0 identity', () => {
  it('reports no_trust_anchor when the bundle carries only a 1.x manifest', async () => {
    const k = await keys();
    const chain = await buildTrustChainKeys();
    const manifest1x = await buildManifest1x({ keys: chain });
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        extra: sessionStart1x(manifest1x),
        identity: await buildCourseIdentity({
          keys: k,
          coursePrivkey: chain.coursePrivkey,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    const verdict = [
      ...(await resolveBundleContributors(bundle, chain.rootPubkeyHex)).bySession.values(),
    ][0]!;
    expect(verdict.kind).toBe('unverifiable');
    if (verdict.kind !== 'unverifiable') throw new Error('unreachable');
    expect(verdict.reason.kind).toBe('no_trust_anchor');
    // Cannot check — distinct from a failed check.
    expect(isIdentityCheckFailure(verdict.reason)).toBe(false);
  });

  it('reports no_trust_anchor when the manifest chain itself does not verify', async () => {
    const k = await keys();
    // The manifest's course_cert is signed by a root the analyzer does not trust.
    const wrongRoot = await buildTrustChainKeys(0x99, 0x22);
    const manifest = await buildManifest2({ keys: wrongRoot });
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        extra: sessionStart2(manifest),
        identity: await buildCourseIdentity({
          keys: k,
          coursePrivkey: wrongRoot.coursePrivkey,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    const trusted = await buildTrustChainKeys();
    const verdict = [
      ...(await resolveBundleContributors(bundle, trusted.rootPubkeyHex)).bySession.values(),
    ][0]!;
    if (verdict.kind !== 'unverifiable') throw new Error('expected unverifiable');
    expect(verdict.reason.kind).toBe('no_trust_anchor');
    expect(verdict.reason.detail).toContain('does not verify');
  });
});

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

describe('grouping sessions into contributors', () => {
  it('groups two sessions of one student despite different ephemeral session keys', async () => {
    const k = await keys();
    const sk0 = await sessionKey(0);
    const sk1 = await sessionKey(1);
    expect(sk0.pubkeyHex).not.toBe(sk1.pubkeyHex);

    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      {
        sessionPubkeyHex: sk1.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk1.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    const resolved = await resolveBundleContributors(bundle, k.root.pubkeyHex);
    expect(resolved.contributors).toHaveLength(1);
    expect(resolved.contributors[0]!.studentRef).toBe(ALICE);
    expect(resolved.contributors[0]!.sessionIds).toEqual(bundle.sessions.map((s) => s.sessionId));
  });

  it('keys on student_ref, never on session_pubkey', async () => {
    const k = await keys();
    const sk0 = await sessionKey(0);
    const sk1 = await sessionKey(1);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      {
        sessionPubkeyHex: sk1.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk1.pubkeyHex,
          studentRef: BOB,
        }),
      },
    ]);

    const resolved = await resolveBundleContributors(bundle, k.root.pubkeyHex);
    expect(resolved.contributors.map((c) => c.studentRef).sort()).toEqual([BOB, ALICE].sort());
    for (const c of resolved.contributors) {
      expect(c.key).not.toContain(sk0.pubkeyHex);
      expect(c.key).not.toContain(sk1.pubkeyHex);
    }
  });

  it('does not merge a 2.0 and a 2.1 ref even when the ref strings are identical', async () => {
    const k = await keys();
    const chain = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys: chain });
    const sk0 = await sessionKey(0);
    const sk1 = await sessionKey(1);

    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        extra: sessionStart2(manifest),
        identity: await buildCourseIdentity({
          keys: k,
          coursePrivkey: chain.coursePrivkey,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      {
        sessionPubkeyHex: sk1.pubkeyHex,
        extra: sessionStart2(manifest),
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk1.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    const resolved = await resolveBundleContributors(bundle, chain.rootPubkeyHex);
    // A 2.0 ref is per-COURSE and a 2.1 ref is GLOBAL: different namespaces.
    // Nothing offline links them, so they stay two contributors.
    expect(resolved.counts.attributed).toBe(2);
    expect(resolved.contributors).toHaveLength(2);
    expect(resolved.contributors.map((c) => c.identityVersion).sort()).toEqual(['2.0', '2.1']);
  });

  it('builds a key that a separator inside an id cannot collide', () => {
    const a = attributedContributorKey('2.1', 'institution', 'berk:eley', 'x');
    const b = attributedContributorKey('2.1', 'institution', 'berk', 'eley:x');
    expect(a).not.toBe(b);
  });
});

// ---------------------------------------------------------------------------
// The shared-repo cases the whole tier exists for
// ---------------------------------------------------------------------------

describe('shared repository', () => {
  it('separates two contributors when one is attributed and one has no identity', async () => {
    const k = await keys();
    const sk0 = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      { sessionPubkeyHex: (await sessionKey(1)).pubkeyHex },
    ]);

    const resolved = await establishBundleContributors(bundle, k.root.pubkeyHex);
    const [alice, partner] = bundle.sessions.map((s) => contributorOf(bundle, s.sessionId));

    expect(alice!.kind).toBe('attributed');
    expect(partner!.kind).toBe('unattributed');
    expect(resolved.counts).toEqual({ attributed: 1, unverifiable: 0, unattributed: 1 });
    // Only Alice may be named.
    expect(attributedContributorsOf(bundle).map((c) => c.studentRef)).toEqual([ALICE]);
    // And we do NOT claim the partner is a different person — only that we do
    // not know.
    expect(compareContributors(alice!, partner!)).toBe('unknown');
  });

  it("keeps one partner attributed when the other's identity fails verification", async () => {
    const k = await keys();
    const fakeRoot = await seededKeypair(0x7c);
    const sk0 = await sessionKey(0);
    const sk1 = await sessionKey(1);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      {
        sessionPubkeyHex: sk1.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk1.pubkeyHex,
          studentRef: BOB,
          certSignedBy: fakeRoot.privkey,
        }),
      },
    ]);

    await establishBundleContributors(bundle, k.root.pubkeyHex);
    const [alice, bob] = bundle.sessions.map((s) => contributorOf(bundle, s.sessionId));

    expect(alice!.kind).toBe('attributed');
    expect(bob!.kind).toBe('unverifiable');
    // The failure is visible, not dropped.
    if (bob!.kind !== 'unverifiable') throw new Error('unreachable');
    expect(bob!.claimedStudentRef).toBe(BOB);
    expect(isIdentityCheckFailure(bob!.reason)).toBe(true);
    expect(contributorsOf(bundle)).toHaveLength(2);
  });

  it('resolves a mixed 2.0 + 2.1 bundle, attributing both', async () => {
    const k = await keys();
    const chain = await buildTrustChainKeys();
    const manifest = await buildManifest2({ keys: chain });
    const sk0 = await sessionKey(0);
    const sk1 = await sessionKey(1);

    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        extra: sessionStart2(manifest),
        identity: await buildCourseIdentity({
          keys: k,
          coursePrivkey: chain.coursePrivkey,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      {
        sessionPubkeyHex: sk1.pubkeyHex,
        extra: sessionStart2(manifest),
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk1.pubkeyHex,
          studentRef: BOB,
        }),
      },
    ]);

    await establishBundleContributors(bundle, chain.rootPubkeyHex);
    const [a, b] = bundle.sessions.map((s) => contributorOf(bundle, s.sessionId));

    expect(a!.kind).toBe('attributed');
    expect(b!.kind).toBe('attributed');
    if (a!.kind !== 'attributed' || b!.kind !== 'attributed') throw new Error('unreachable');
    expect(a!.identityVersion).toBe('2.0');
    expect(a!.scope).toBe('course');
    expect(b!.identityVersion).toBe('2.1');
    expect(b!.scope).toBe('institution');
    expect(compareContributors(a!, b!)).toBe('different');
  });
});

// ---------------------------------------------------------------------------
// compareContributors — the three-valued primitive Tier 3 must use
// ---------------------------------------------------------------------------

describe('compareContributors', () => {
  it('answers same / different / unknown, never guessing about unattributed sessions', async () => {
    const k = await keys();
    const sk0 = await sessionKey(0);
    const sk1 = await sessionKey(1);
    const sk2 = await sessionKey(2);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      {
        sessionPubkeyHex: sk1.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk1.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      {
        sessionPubkeyHex: sk2.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk2.pubkeyHex,
          studentRef: BOB,
        }),
      },
      { sessionPubkeyHex: (await sessionKey(3)).pubkeyHex },
      { sessionPubkeyHex: (await sessionKey(4)).pubkeyHex },
    ]);

    await establishBundleContributors(bundle, k.root.pubkeyHex);
    const [a0, a1, b0, u0, u1] = bundle.sessions.map((s) => contributorOf(bundle, s.sessionId));

    expect(compareContributors(a0!, a1!)).toBe('same');
    expect(compareContributors(a0!, b0!)).toBe('different');
    expect(compareContributors(a0!, u0!)).toBe('unknown');
    // Two unattributed sessions are NOT proven distinct either.
    expect(compareContributors(u0!, u1!)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// The stamp, and the synchronous accessor
// ---------------------------------------------------------------------------

describe('the Bundle stamp', () => {
  it('resolveBundleContributors does not mutate; establishBundleContributors does', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    await resolveBundleContributors(bundle, k.root.pubkeyHex);
    expect(bundle.contributors).toBeUndefined();

    const stamped = await establishBundleContributors(bundle, k.root.pubkeyHex);
    expect(bundle.contributors).toBe(stamped);
    expect(contributorOf(bundle, bundle.sessions[0]!.sessionId).kind).toBe('attributed');
  });

  it('treats an UNSTAMPED bundle as fully unattributed', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    // No `establishBundleContributors` call — the loader performs no signature
    // work, so nothing is attributed until something with a root key says so.
    const verdict = contributorOf(bundle, bundle.sessions[0]!.sessionId);
    expect(verdict.kind).toBe('unattributed');
    expect(contributorsOf(bundle)).toEqual([]);
    expect(attributedContributorsOf(bundle)).toEqual([]);
  });

  it('answers unattributed for a session id the bundle does not contain', async () => {
    const k = await keys();
    const bundle = await loadWith([{ sessionPubkeyHex: (await sessionKey(0)).pubkeyHex }]);
    await establishBundleContributors(bundle, k.root.pubkeyHex);
    expect(contributorOf(bundle, 'not-a-session').kind).toBe('unattributed');
  });

  it('is idempotent', async () => {
    const k = await keys();
    const sk = await sessionKey(0);
    const bundle = await loadWith([
      {
        sessionPubkeyHex: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);
    const first = await establishBundleContributors(bundle, k.root.pubkeyHex);
    const second = await establishBundleContributors(bundle, k.root.pubkeyHex);
    expect(second.counts).toEqual(first.counts);
    expect(second.contributors.map((c) => c.key)).toEqual(first.contributors.map((c) => c.key));
  });
});
