/**
 * Unit tests for buildSessionIdentity — the `session.start.identity` block
 * (program spec §5, §5a step 5 of the enrollment flow).
 *
 * The two rules under test, in priority order:
 *
 *  1. **Never block recording.** Anything short of a fully verifying identity
 *     omits the block and records anyway — the same reasoning §4 applies to an
 *     expired `course_cert`. An integrity tool that stops recording is worse
 *     than one recording without an identity claim.
 *  2. **Never emit an identity that does not verify.** The block goes into a
 *     signed, hash-chained log; a broken claim there is permanent.
 *
 * Every key here is derived from a fixed seed, so the suite is deterministic.
 */

import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  signCourseCert,
  signEnrollmentCert,
  signEnrollmentToken,
  verifyIdentityChain,
  deriveCourseKeypair,
  ENROLLMENT_FORMAT_VERSION,
} from '@provenance/log-core';
import type { CourseCert, Manifest } from '@provenance/log-core';
import { buildSessionIdentity } from './session-identity.js';
import { MASTER_SECRET_KEY, saveEnrollment } from './secret-store.js';
import type { SecretStore } from './secret-store.js';

// ---------------------------------------------------------------------------
// Fixed keys — deterministic, never random.
// ---------------------------------------------------------------------------

const seed = (b: number): Uint8Array => new Uint8Array(32).fill(b);

const ROOT_PRIV = seed(0x21);
const COURSE_PRIV = seed(0x22);
const ENROLLMENT_PRIV = seed(0x23);
const MASTER_SECRET = seed(0x24);
const OTHER_MASTER_SECRET = seed(0x25);

const COURSE_ID = 'berkeley-cs61b';
const STUDENT_REF = '11111111-2222-3333-4444-555555555555';
const SESSION_PUBKEY = 'f'.repeat(64);
/** Inside every window used below. */
const SESSION_STARTED_AT = '2026-10-01T12:00:00Z';

function makeStore(initial: Record<string, string> = {}): SecretStore {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(map.get(key)),
    store: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

async function pub(priv: Uint8Array): Promise<string> {
  return bytesToHex(await ed.getPublicKeyAsync(priv));
}

/** A root-verified course cert, as `manifest.course_cert` would carry. */
async function makeCourseCert(overrides: Partial<CourseCert> = {}): Promise<CourseCert> {
  const base = {
    course_id: COURSE_ID,
    course_pubkey: await pub(COURSE_PRIV),
    valid_from: '2026-08-20',
    valid_until: '2027-01-15',
    ...overrides,
  };
  return { ...base, root_sig: await signCourseCert(base, ROOT_PRIV) };
}

async function makeManifest(courseCert?: CourseCert): Promise<Manifest> {
  return {
    format_version: '2.0',
    assignment_id: 'proj2',
    semester: 'fa26',
    issued_at: '2026-09-08T00:00:00Z',
    files_under_review: ['proj2.java'],
    sig: 'e'.repeat(128),
    course_id: COURSE_ID,
    collaboration: 'solo',
    submission: 'bundle',
    scope: 'directory',
    course_cert: courseCert ?? (await makeCourseCert()),
  };
}

/**
 * Mint the `{ enrollment, enrollment_cert }` blob a student pastes in, for the
 * student key derived from `masterSecret`.
 */
async function mintEnrollment(
  opts: {
    masterSecret?: Uint8Array;
    tokenCourseId?: string;
    certCourseId?: string;
    issuedAt?: string;
    expiresAt?: string;
    certValidFrom?: string;
    certValidUntil?: string;
    studentPubkeyOverride?: string;
  } = {},
): Promise<string> {
  const tokenCourseId = opts.tokenCourseId ?? COURSE_ID;
  const certCourseId = opts.certCourseId ?? COURSE_ID;

  const derived = await deriveCourseKeypair(opts.masterSecret ?? MASTER_SECRET, tokenCourseId);

  const certBase = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    course_id: certCourseId,
    enrollment_pubkey: await pub(ENROLLMENT_PRIV),
    valid_from: opts.certValidFrom ?? '2026-08-20',
    valid_until: opts.certValidUntil ?? '2027-01-15',
  };
  const enrollment_cert = {
    ...certBase,
    course_sig: await signEnrollmentCert(certBase, COURSE_PRIV),
  };

  const tokenBase = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    student_ref: STUDENT_REF,
    course_id: tokenCourseId,
    student_pubkey: opts.studentPubkeyOverride ?? derived.publicKeyHex,
    issued_at: opts.issuedAt ?? '2026-08-25T00:00:00Z',
    expires_at: opts.expiresAt ?? '2027-01-15',
  };
  const enrollment = {
    ...tokenBase,
    enrollment_sig: await signEnrollmentToken(tokenBase, ENROLLMENT_PRIV),
  };

  return JSON.stringify({ enrollment, enrollment_cert });
}

/** A store holding MASTER_SECRET plus a freshly minted enrollment. */
async function enrolledStore(
  mintOpts: Parameters<typeof mintEnrollment>[0] = {},
  masterSecret: Uint8Array = MASTER_SECRET,
): Promise<SecretStore> {
  const store = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(masterSecret) });
  const saved = await saveEnrollment(store, await mintEnrollment(mintOpts));
  expect(saved.ok).toBe(true);
  return store;
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

describe('buildSessionIdentity — enrolled', () => {
  it('emits an identity block that verifies against the manifest course_cert', async () => {
    const manifest = await makeManifest();
    const outcome = await buildSessionIdentity({
      manifest,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: await enrolledStore(),
    });

    expect(outcome.kind).toBe('emitted');
    if (outcome.kind !== 'emitted') return;

    // The three fields §5 specifies, and nothing else.
    expect(Object.keys(outcome.identity).sort()).toEqual([
      'enrollment',
      'enrollment_cert',
      'session_pubkey_sig',
    ]);
    expect(outcome.identity.session_pubkey_sig).toMatch(/^[0-9a-f]{128}$/);

    // Independently re-walk the chain exactly as the analyzer will.
    const rewalked = await verifyIdentityChain({
      identity: outcome.identity,
      session_pubkey: SESSION_PUBKEY,
      course_cert: manifest.course_cert as CourseCert,
      session_started_at: SESSION_STARTED_AT,
    });
    expect(rewalked.ok).toBe(true);
    if (!rewalked.ok) return;
    // `IdentityChainOk` is now a union over the identity version; this recorder
    // still emits the 2.0 course-scoped block, so narrow to that branch. The
    // assertions themselves are unchanged.
    expect(rewalked.value.identity_version).toBe('2.0');
    if (rewalked.value.identity_version !== '2.0') return;
    expect(rewalked.value.course_id).toBe(COURSE_ID);
    expect(rewalked.value.student_ref).toBe(STUDENT_REF);
  });

  it('signs THIS session pubkey — the signature does not verify for another', async () => {
    const manifest = await makeManifest();
    const outcome = await buildSessionIdentity({
      manifest,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: await enrolledStore(),
    });
    expect(outcome.kind).toBe('emitted');
    if (outcome.kind !== 'emitted') return;

    const wrongSession = await verifyIdentityChain({
      identity: outcome.identity,
      session_pubkey: '1'.repeat(64),
      course_cert: manifest.course_cert as CourseCert,
      session_started_at: SESSION_STARTED_AT,
    });
    expect(wrongSession.ok).toBe(false);
  });

  it('carries only the opaque student_ref — no name, email, or SID', async () => {
    const outcome = await buildSessionIdentity({
      manifest: await makeManifest(),
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: await enrolledStore(),
    });
    expect(outcome.kind).toBe('emitted');
    if (outcome.kind !== 'emitted') return;
    const serialized = JSON.stringify(outcome.identity);
    expect(outcome.identity.enrollment.student_ref).toBe(STUDENT_REF);
    expect(serialized).not.toMatch(/name|email|sid/i);
  });

  it('emits anyway when the token is out of window — expiry is reported, not enforced', async () => {
    const manifest = await makeManifest();
    // Token expired before this session ran.
    const secrets = await enrolledStore({
      issuedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-02-01',
    });
    const outcome = await buildSessionIdentity({
      manifest,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets,
    });
    // A course letting enrollment lapse mid-semester must not stop the class
    // recording (program spec §4/§5a step 5).
    expect(outcome.kind).toBe('emitted');
    if (outcome.kind !== 'emitted') return;
    const window = outcome.verified.token_window;
    expect(window.in_window).toBe(false);
    if (window.in_window) return;
    expect(window.reason).toBe('after_valid_until');
  });
});

// ---------------------------------------------------------------------------
// Omission — recording always continues
// ---------------------------------------------------------------------------

describe('buildSessionIdentity — omits rather than blocking', () => {
  it('omits when the student holds no token for this course', async () => {
    const outcome = await buildSessionIdentity({
      manifest: await makeManifest(),
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: makeStore({ [MASTER_SECRET_KEY]: bytesToHex(MASTER_SECRET) }),
    });
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason.kind).toBe('not_enrolled');
  });

  it('omits for a 1.x manifest — there is no course_cert to verify against', async () => {
    const legacy: Manifest = {
      assignment_id: 'hw03',
      semester: 'fa26',
      issued_at: '2026-09-15T00:00:00Z',
      files_under_review: ['hw03.py'],
      sig: 'a'.repeat(128),
    };
    const outcome = await buildSessionIdentity({
      manifest: legacy,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: await enrolledStore(),
    });
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason.kind).toBe('manifest_not_2_0');
  });

  it('omits when the enrollment is for a different course than the manifest', async () => {
    const outcome = await buildSessionIdentity({
      manifest: await makeManifest(),
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      // Enrolled in 61C, working in a 61B assignment.
      secrets: await enrolledStore({
        tokenCourseId: 'berkeley-cs61c',
        certCourseId: 'berkeley-cs61c',
      }),
    });
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason.kind).toBe('not_enrolled');
  });

  it('omits when the stored token names a key this master secret cannot derive', async () => {
    // The classic new-machine failure: the token was minted for the key derived
    // from a DIFFERENT master secret. Signing anyway would emit a session_pubkey_sig
    // that cannot verify against token.student_pubkey.
    const store = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(OTHER_MASTER_SECRET) });
    await saveEnrollment(store, await mintEnrollment({ masterSecret: MASTER_SECRET }));

    const outcome = await buildSessionIdentity({
      manifest: await makeManifest(),
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: store,
    });
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason.kind).toBe('student_key_mismatch');
  });

  it('omits when the enrollment_cert was not signed by this manifest course key', async () => {
    // A genuine token from another course's key, presented against 61B's cert.
    const foreignCourseCert = await makeCourseCert({ course_pubkey: await pub(seed(0x99)) });
    const outcome = await buildSessionIdentity({
      manifest: await makeManifest(foreignCourseCert),
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: await enrolledStore(),
    });
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason.kind).toBe('chain_did_not_verify');
    if (outcome.reason.kind !== 'chain_did_not_verify') return;
    expect(outcome.reason.error.kind).toBe('invalid_course_signature');
  });

  it('omits when there is no master secret at all', async () => {
    const store = makeStore();
    await saveEnrollment(store, await mintEnrollment());
    const outcome = await buildSessionIdentity({
      manifest: await makeManifest(),
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: store,
    });
    // Deliberately does NOT create one: a fresh secret can never match a token
    // that already exists, so creating one here would only produce a mismatch.
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason.kind).toBe('master_secret_unavailable');
  });

  it('omits when the session pubkey is not 64-char hex', async () => {
    const outcome = await buildSessionIdentity({
      manifest: await makeManifest(),
      sessionPubkeyHex: '',
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: await enrolledStore(),
    });
    expect(outcome.kind).toBe('skipped');
  });

  it('never throws when the secret store itself fails', async () => {
    const broken: SecretStore = {
      get: () => Promise.reject(new Error('keyring unavailable')),
      store: () => Promise.reject(new Error('keyring unavailable')),
      delete: () => Promise.reject(new Error('keyring unavailable')),
    };
    const outcome = await buildSessionIdentity({
      manifest: await makeManifest(),
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: broken,
    });
    // A Linux box with no keyring must still record.
    expect(outcome.kind).toBe('skipped');
  });
});
