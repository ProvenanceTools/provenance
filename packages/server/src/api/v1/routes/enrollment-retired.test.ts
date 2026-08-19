/**
 * The 2.0 enrollment MINTING route is retired; 2.0 VERIFICATION is not.
 *
 * `POST /semesters/:semesterId/enrollment` (identity `format_version` 2.0) was
 * superseded by `POST /identity/credential` (2.1) before either shipped, and it
 * was structurally deadlocked besides: it required a `roster_entries` match,
 * and rosters are populated by Gradescope ingest, which runs only *after* a
 * student submits. Its 17 route tests went with the route — every one of them
 * drove it over HTTP, so none survives its removal.
 *
 * What must NOT go with it is the ability to verify identity 2.0 material.
 * Archived bundles carry 2.0 tokens and have to keep verifying years later;
 * that is the entire justification for this system (spec §9). This file is the
 * standing guard on both halves of that statement:
 *
 *  1. the minting route is gone and stays gone;
 *  2. a complete archived 2.0 identity chain — root → course_cert →
 *     enrollment_cert → enrollment token → session_pubkey_sig — still verifies
 *     with `log-core` alone, including under a certificate that has since
 *     expired and a key the server would now consider superseded.
 *
 * (2) is the property the deleted `enrollment.test.ts` pinned in its tail
 * ("supersedes an old key without invalidating the token already signed under
 * it"), reconstructed here without the route: the chain is walked entirely from
 * inside the bundle and never consults this server, so nothing the server stops
 * issuing can reach it. Broader 2.0 verification coverage lives in
 * `log-core/src/enrollment.test.ts` and
 * `analysis-core/src/identity/resolve-contributors.test.ts` ("still attributes
 * an ARCHIVED 2.0 course-scoped session"); this file is the server-side
 * reminder that retiring the issuer did not retire the verifier.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  signCourseCert,
  signEnrollmentCert,
  signEnrollmentToken,
  signSessionPubkey,
  deriveCourseKeypair,
  verifyIdentityChain,
  ENROLLMENT_FORMAT_VERSION,
} from '@provenance/log-core';
import type { CourseCert } from '@provenance/log-core';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';

const COURSE_ID = 'berkeley-cs61b';

function seed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-retirement-tests-1234567',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// 1. The minting route is gone.
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/enrollment (retired)', () => {
  it('is not routed at all', async () => {
    const app = createV1App();
    const res = await app.fetch(
      new Request('http://localhost/semesters/11111111-2222-3333-4444-555555555555/enrollment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_pubkey: 'a'.repeat(64) }),
      }),
    );

    // 404, not 401. An unauthenticated request to a route that EXISTS is
    // answered AUTH_REQUIRED by the handler's own guard, so 401 here would mean
    // the route had been quietly re-added. This assertion is the discriminator.
    expect(res.status).toBe(404);
  });

  it('is absent from the published OpenAPI document', async () => {
    const { openApiSpec } = await import('../../../openapi/spec/index.js');
    const spec = openApiSpec as unknown as { paths: Record<string, unknown> };
    expect(Object.keys(spec.paths)).not.toContain('/semesters/{semesterId}/enrollment');
    // The replacement is still there — this test must fail loudly if the whole
    // identity surface vanished rather than just the 2.0 half.
    expect(Object.keys(spec.paths)).toContain('/identity/credential');
  });
});

// ---------------------------------------------------------------------------
// 2. Identity 2.0 verification is untouched.
// ---------------------------------------------------------------------------

describe('archived identity 2.0 material still verifies', () => {
  it('walks a full 2.0 chain offline under an expired cert and a superseded key', async () => {
    const root = await deriveCourseKeypair(seed(0x01), 'fixture-root');
    const course = await deriveCourseKeypair(seed(0x02), 'fixture-course');
    const enrollment = await deriveCourseKeypair(seed(0x03), 'fixture-enrollment');
    // The student's ORIGINAL per-course key. Under 2.0 the server marked this
    // `superseded_at` as soon as the student re-enrolled from a second machine.
    // Superseding was always bookkeeping only, and it is now unreachable — the
    // archived chain below must not notice either fact.
    const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);
    const sessionKey = await deriveCourseKeypair(seed(0x55), 'fixture-session');

    const unsignedCourseCert = {
      course_id: COURSE_ID,
      course_pubkey: course.publicKeyHex,
      valid_from: '2020-01-01',
      valid_until: '2021-12-31',
    };
    const courseCert: CourseCert = {
      ...unsignedCourseCert,
      root_sig: await signCourseCert(unsignedCourseCert, root.privateKey),
    };

    const unsignedCert = {
      format_version: ENROLLMENT_FORMAT_VERSION,
      course_id: COURSE_ID,
      enrollment_pubkey: enrollment.publicKeyHex,
      valid_from: '2020-01-01',
      // Long expired as of the wall clock. An archived bundle must still verify.
      valid_until: '2021-12-31',
    };
    const enrollmentCert = {
      ...unsignedCert,
      course_sig: await signEnrollmentCert(
        unsignedCert as Parameters<typeof signEnrollmentCert>[0],
        course.privateKey,
      ),
    };

    const unsignedToken = {
      format_version: ENROLLMENT_FORMAT_VERSION,
      student_ref: '9f3c1b52-0d44-4a1e-9c7b-2f6a8e1d0c33',
      course_id: COURSE_ID,
      student_pubkey: student.publicKeyHex,
      issued_at: '2021-01-15T10:00:00.000Z',
      expires_at: '2021-12-31',
    };
    const token = {
      ...unsignedToken,
      enrollment_sig: await signEnrollmentToken(unsignedToken, enrollment.privateKey),
    };

    const sessionPubkeySig = await signSessionPubkey(
      {
        course_id: COURSE_ID,
        student_ref: unsignedToken.student_ref,
        session_pubkey: sessionKey.publicKeyHex,
      },
      student.privateKey,
    );

    const walked = await verifyIdentityChain({
      identity: {
        enrollment: token as never,
        enrollment_cert: enrollmentCert as never,
        session_pubkey_sig: sessionPubkeySig,
      },
      session_pubkey: sessionKey.publicKeyHex,
      course_cert: courseCert,
      // Judged as the session actually ran, not as of now.
      session_started_at: '2021-03-04T09:00:00.000Z',
    });

    expect(walked.ok).toBe(true);
  });

  it('still rejects a 2.0 chain whose countersignature was made by someone else', async () => {
    // The other direction: retirement must not have loosened anything either.
    const root = await deriveCourseKeypair(seed(0x01), 'fixture-root');
    const course = await deriveCourseKeypair(seed(0x02), 'fixture-course');
    const enrollment = await deriveCourseKeypair(seed(0x03), 'fixture-enrollment');
    const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);
    const impostor = await deriveCourseKeypair(seed(0x77), COURSE_ID);
    const sessionKey = await deriveCourseKeypair(seed(0x55), 'fixture-session');

    const unsignedCourseCert = {
      course_id: COURSE_ID,
      course_pubkey: course.publicKeyHex,
      valid_from: '2020-01-01',
      valid_until: '2099-12-31',
    };
    const courseCert: CourseCert = {
      ...unsignedCourseCert,
      root_sig: await signCourseCert(unsignedCourseCert, root.privateKey),
    };

    const unsignedCert = {
      format_version: ENROLLMENT_FORMAT_VERSION,
      course_id: COURSE_ID,
      enrollment_pubkey: enrollment.publicKeyHex,
      valid_from: '2020-01-01',
      valid_until: '2099-12-31',
    };
    const enrollmentCert = {
      ...unsignedCert,
      course_sig: await signEnrollmentCert(
        unsignedCert as Parameters<typeof signEnrollmentCert>[0],
        course.privateKey,
      ),
    };

    const unsignedToken = {
      format_version: ENROLLMENT_FORMAT_VERSION,
      student_ref: '9f3c1b52-0d44-4a1e-9c7b-2f6a8e1d0c33',
      course_id: COURSE_ID,
      student_pubkey: student.publicKeyHex,
      issued_at: '2026-01-15T10:00:00.000Z',
      expires_at: '2099-12-31',
    };
    const token = {
      ...unsignedToken,
      enrollment_sig: await signEnrollmentToken(unsignedToken, enrollment.privateKey),
    };

    // Countersigned by the impostor, not by the key the token binds.
    const sessionPubkeySig = await signSessionPubkey(
      {
        course_id: COURSE_ID,
        student_ref: unsignedToken.student_ref,
        session_pubkey: sessionKey.publicKeyHex,
      },
      impostor.privateKey,
    );

    const walked = await verifyIdentityChain({
      identity: {
        enrollment: token as never,
        enrollment_cert: enrollmentCert as never,
        session_pubkey_sig: sessionPubkeySig,
      },
      session_pubkey: sessionKey.publicKeyHex,
      course_cert: courseCert,
      session_started_at: '2026-03-04T09:00:00.000Z',
    });

    expect(walked.ok).toBe(false);
  });
});
