/**
 * Student enrollment route integration tests (program spec §5a — S2).
 *
 * Goes through the full v1 pipeline via createV1App(), per the V18 rule.
 *
 * The properties these tests exist to pin, in order of how much it would cost
 * to get them wrong:
 *
 *  1. a token is never minted for an identity the roster does not know;
 *  2. the minted token verifies as a real identity chain, root → course_cert →
 *     enrollment_cert → token → session_pubkey_sig, using only log-core;
 *  3. `student_ref` is opaque, random, and STABLE — the same student enrolling
 *     twice, from two machines, is one contributor and not two;
 *  4. an archived bundle signed under a SUPERSEDED key still verifies, because
 *     verification never consults this server;
 *  5. the private key never appears in a response.
 */

import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  signCourseCert,
  signEnrollmentCert,
  signSessionPubkey,
  deriveCourseKeypair,
  verifyIdentityChain,
  ENROLLMENT_FORMAT_VERSION,
} from '@provenance/log-core';
import type { CourseCert } from '@provenance/log-core';
import { EnrollmentResponseSchema } from '@provenance/shared/api-schemas';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetEnrollmentKeysForTest } from '../../../config/enrollment-keys.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import {
  users,
  sessions,
  courses,
  semesters,
  roster_entries,
  student_refs,
  student_enrollments,
  api_tokens,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

// ---------------------------------------------------------------------------
// Deterministic key material — HKDF over fixed bytes, no randomness anywhere.
// ---------------------------------------------------------------------------

function seed(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const COURSE_ID = 'berkeley-cs61b';

type Chain = {
  rootPubHex: string;
  courseCert: CourseCert;
  cert: Record<string, unknown>;
  enrollmentPrivHex: string;
};

/** Build root → course_cert → enrollment_cert once, deterministically. */
async function buildChain(certOverrides: Record<string, unknown> = {}): Promise<Chain> {
  const root = await deriveCourseKeypair(seed(0x01), 'fixture-root');
  const course = await deriveCourseKeypair(seed(0x02), 'fixture-course');
  const enrollment = await deriveCourseKeypair(seed(0x03), 'fixture-enrollment');

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
    ...certOverrides,
  };
  const cert = {
    ...unsignedCert,
    course_sig: await signEnrollmentCert(
      unsignedCert as Parameters<typeof signEnrollmentCert>[0],
      course.privateKey,
    ),
  };

  return {
    rootPubHex: root.publicKeyHex,
    courseCert,
    cert,
    enrollmentPrivHex: toHex(enrollment.privateKey),
  };
}

// ---------------------------------------------------------------------------
// Test env
// ---------------------------------------------------------------------------

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-enrollment-tests-1234567',
  SESSION_TTL_DAYS: '14',
};

function setEnv(enrollmentKeys?: Record<string, unknown>): void {
  _resetConfigForTest();
  _resetEnrollmentKeysForTest();
  _setConfigForTest(
    parseEnv(
      enrollmentKeys === undefined
        ? BASE_ENV
        : { ...BASE_ENV, PROVENANCE_ENROLLMENT_KEYS: JSON.stringify(enrollmentKeys) },
    ),
  );
}

beforeEach(() => {
  _resetConfigForTest();
  _resetEnrollmentKeysForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// DB injection
//
// ONE container for the whole file rather than one per `it`. Every test seeds
// its own course/semester/user, so they are independent without paying for a
// fresh Postgres each time — this file would otherwise start sixteen.
// ---------------------------------------------------------------------------

let _testDb: DrizzleDb | null = null;
let releaseDb: (() => void) | null = null;

vi.mock('../../../db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../db/client.js')>();
  return {
    ...original,
    getDb: () => {
      if (_testDb !== null) return _testDb;
      return original.getDb();
    },
  };
});

function getTestDb(): DrizzleDb {
  if (_testDb === null) throw new Error('test database not initialised');
  return _testDb;
}

beforeAll(async () => {
  // withTestDb takes a callback, so hold it open with a promise resolved in
  // afterAll — the same shape contract.test.ts uses.
  let resolveCleanup!: () => void;
  const cleanup = new Promise<void>((res) => {
    resolveCleanup = res;
  });
  const ready = new Promise<void>((res, rej) => {
    void withTestDb(async (instance) => {
      _testDb = instance;
      res();
      await cleanup;
    }).catch(rej);
  });
  releaseDb = resolveCleanup;
  await ready;
});

afterAll(() => {
  releaseDb?.();
  releaseDb = null;
  _testDb = null;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Run a test body against the file-scoped database. */
async function withDb(fn: (instance: DrizzleDb) => Promise<void>): Promise<void> {
  await fn(getTestDb());
}

let sessionCounter = 0;

/**
 * A fresh address per test. `users.email` is globally unique (lower(email)), so
 * a file-scoped database needs distinct addresses; the roster row and the
 * Google account in a given test still share one.
 */
function uniqueEmail(): string {
  return `student-${sessionCounter++}@berkeley.edu`;
}

async function seedSemester(db: DrizzleDb) {
  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61B', slug: `cs61b-${sessionCounter++}` })
    .returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2026,
      slug: `fa26-${sessionCounter++}`,
      display_name: 'Fall 2026',
      filename_convention: '{sid}_{assignment}.zip',
    })
    .returning();
  return semester!;
}

async function seedUser(db: DrizzleDb, email: string) {
  const [user] = await db
    .insert(users)
    .values({
      google_subject: `sub-${sessionCounter++}-${email}`,
      email,
      display_name: 'Student',
      is_superadmin: false,
    })
    .returning();
  const sessionId = `sess-${sessionCounter++}`.padEnd(43, 'x').slice(0, 43);
  await db.insert(sessions).values({
    id: sessionId,
    user_id: user!.id,
    expires_at: new Date(Date.now() + 14 * 86400_000),
  });
  return { user: user!, sessionId };
}

function enrollRequest(semesterId: string, sessionId: string, studentPubkey: string): Request {
  return new Request(`http://localhost/semesters/${semesterId}/enrollment`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `__Host-prov_sess=${sessionId}`,
    },
    body: JSON.stringify({ student_pubkey: studentPubkey }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/enrollment', () => {
  it('mints a token whose full identity chain verifies offline', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { sessionId } = await seedUser(db, email);

      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);
      const app = createV1App();
      const res = await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex));

      expect(res.status).toBe(200);
      const body: unknown = await res.json();

      // The response matches the contract the recorder will parse.
      const parsed = EnrollmentResponseSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      if (!parsed.success) return;

      expect(parsed.data.course_id).toBe(COURSE_ID);
      expect(parsed.data.reissued).toBe(false);
      expect(parsed.data.enrollment.student_pubkey).toBe(student.publicKeyHex);

      // The full offline walk: a recorder holding only the root public key can
      // do exactly this, with nothing fetched and nothing from the server
      // trusted.
      const sessionKey = await deriveCourseKeypair(seed(0x55), 'fixture-session');
      const sig = await signSessionPubkey(
        {
          course_id: COURSE_ID,
          student_ref: parsed.data.student_ref,
          session_pubkey: sessionKey.publicKeyHex,
        },
        student.privateKey,
      );

      const walked = await verifyIdentityChain({
        identity: {
          enrollment: parsed.data.enrollment,
          enrollment_cert: parsed.data.enrollment_cert,
          session_pubkey_sig: sig,
        },
        session_pubkey: sessionKey.publicKeyHex,
        course_cert: chain.courseCert,
        session_started_at: new Date().toISOString(),
      });

      expect(walked.ok, JSON.stringify(walked.ok ? {} : walked.error)).toBe(true);
      if (!walked.ok) return;
      expect(walked.value.student_ref).toBe(parsed.data.student_ref);
      expect(walked.value.cert_window.in_window).toBe(true);
      expect(walked.value.token_window.in_window).toBe(true);
    });
  });

  it('never returns the enrollment private key', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const res = await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex));
      const text = await res.text();

      expect(text).not.toContain(chain.enrollmentPrivHex);
    });
  });

  it('refuses an authenticated account that is not on the roster', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      // Roster has someone else entirely.
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032400000',
        display_name: 'Grace Hopper',
        email: uniqueEmail(),
      });
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const res = await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex));

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('ENROLLMENT_NOT_ON_ROSTER');

      const rows = await db
        .select()
        .from(student_refs)
        .where(eq(student_refs.semester_id, semester.id));
      expect(rows.length).toBe(0);
    });
  });

  it('matches the roster email case-insensitively', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email: email.toUpperCase(),
      });
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const res = await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex));
      expect(res.status).toBe(200);
    });
  });

  it('refuses when several roster entries share the email', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values([
        {
          semester_id: semester.id,
          sid: '3032412345',
          display_name: 'Ada Lovelace',
          email,
        },
        {
          semester_id: semester.id,
          sid: '3032499999',
          display_name: 'Ada Lovelace (dup)',
          email,
        },
      ]);
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const res = await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex));

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('ENROLLMENT_ROSTER_AMBIGUOUS');
    });
  });

  it('returns 503 when the semester has no enrollment key configured', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const semester = await seedSemester(db);
      setEnv();
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const res = await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex));

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string; details: { reason: string } } };
      expect(body.error.code).toBe('ENROLLMENT_UNAVAILABLE');
      expect(body.error.details.reason).toBe('no_enrollment_key');
    });
  });

  it('refuses to mint under an out-of-window enrollment certificate', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain({ valid_from: '2000-01-01', valid_until: '2000-12-31' });
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const res = await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex));

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { details: { reason: string } } };
      expect(body.error.details.reason).toBe('cert_out_of_window');
    });
  });

  it('returns 503 rather than an unverifiable token when the private key does not match the cert', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const wrong = await deriveCourseKeypair(seed(0x77), 'wrong-enrollment');
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: toHex(wrong.privateKey), cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const res = await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex));

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { details: { reason: string } } };
      expect(body.error.details.reason).toBe('key_mismatch');
    });
  });

  it('gives the same student the same student_ref on a second machine', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);
      const app = createV1App();

      const first = (await (
        await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex))
      ).json()) as { student_ref: string; reissued: boolean };
      const second = (await (
        await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex))
      ).json()) as { student_ref: string; reissued: boolean };

      expect(second.student_ref).toBe(first.student_ref);
      expect(first.reissued).toBe(false);
      expect(second.reissued).toBe(true);

      // Same key on a second machine is ONE binding, not two contributors.
      const bindings = await db
        .select()
        .from(student_enrollments)
        .where(eq(student_enrollments.student_ref, first.student_ref));
      expect(bindings.length).toBe(1);
      expect(bindings[0]!.issue_count).toBe(2);
    });
  });

  it('student_ref is not derived from the sid, the email, or the roster row id', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      const [entry] = await db
        .insert(roster_entries)
        .values({
          semester_id: semester.id,
          sid: '3032412345',
          display_name: 'Ada Lovelace',
          email,
        })
        .returning();
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const body = (await (
        await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex))
      ).json()) as { student_ref: string };

      expect(body.student_ref).not.toBe(entry!.id);
      expect(body.student_ref).not.toContain('3032412345');
      expect(body.student_ref).not.toContain('ada');
      expect(body.student_ref).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  it('supersedes an old key without invalidating the token already signed under it', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { sessionId } = await seedUser(db, email);
      const app = createV1App();

      // First master secret, then a lost-and-regenerated one.
      const oldKey = await deriveCourseKeypair(seed(0x44), COURSE_ID);
      const newKey = await deriveCourseKeypair(seed(0x66), COURSE_ID);

      const oldBody = (await (
        await app.fetch(enrollRequest(semester.id, sessionId, oldKey.publicKeyHex))
      ).json()) as { enrollment: Record<string, unknown>; student_ref: string };
      const newBody = (await (
        await app.fetch(enrollRequest(semester.id, sessionId, newKey.publicKeyHex))
      ).json()) as { student_ref: string };

      expect(newBody.student_ref).toBe(oldBody.student_ref);

      const rows = await db
        .select()
        .from(student_enrollments)
        .where(eq(student_enrollments.student_ref, oldBody.student_ref));
      expect(rows.length).toBe(2);
      const supersededRow = rows.find((r) => r.student_pubkey === oldKey.publicKeyHex);
      const currentRow = rows.find((r) => r.student_pubkey === newKey.publicKeyHex);
      expect(supersededRow?.superseded_at).not.toBeNull();
      expect(currentRow?.superseded_at).toBeNull();

      // The adjudication case: an archived bundle recorded under the SUPERSEDED
      // key still verifies, because the chain is walked entirely from inside the
      // bundle and never consults this server. Nothing above can take that away.
      const sessionKey = await deriveCourseKeypair(seed(0x55), 'fixture-session');
      const sig = await signSessionPubkey(
        {
          course_id: COURSE_ID,
          student_ref: oldBody.student_ref,
          session_pubkey: sessionKey.publicKeyHex,
        },
        oldKey.privateKey,
      );
      const walked = await verifyIdentityChain({
        identity: {
          enrollment: oldBody.enrollment as never,
          enrollment_cert: chain.cert as never,
          session_pubkey_sig: sig,
        },
        session_pubkey: sessionKey.publicKeyHex,
        course_cert: chain.courseCert,
        session_started_at: new Date().toISOString(),
      });
      expect(walked.ok).toBe(true);
    });
  });

  it('re-issues the same student_ref after the roster row is deleted and re-added', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);
      const app = createV1App();

      const first = (await (
        await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex))
      ).json()) as { student_ref: string };

      // A roster commit with accept_deletions removes and re-adds the student.
      await db
        .delete(roster_entries)
        .where(
          and(eq(roster_entries.semester_id, semester.id), eq(roster_entries.sid, '3032412345')),
        );
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });

      const second = (await (
        await app.fetch(enrollRequest(semester.id, sessionId, student.publicKeyHex))
      ).json()) as { student_ref: string };

      expect(second.student_ref).toBe(first.student_ref);
    });
  });

  it('rejects an unauthenticated request', async () => {
    await withDb(async (db) => {
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/enrollment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ student_pubkey: student.publicKeyHex }),
        }),
      );

      expect(res.status).toBe(401);
    });
  });

  it('refuses an API token, even one belonging to a rostered student', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { user } = await seedUser(db, email);

      // Mint a real API token for that user via the same helpers the token
      // middleware verifies against.
      const { generateToken, hashToken } = await import('../../../auth/tokens.js');
      const { prefix, secret } = generateToken();
      await db.insert(api_tokens).values({
        user_id: user.id,
        label: 'test',
        prefix,
        hashed_token: await hashToken(secret),
        scopes: { read_only: false, semester_ids: null, allow_blob_download: false },
      });

      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);
      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/enrollment`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({ student_pubkey: student.publicKeyHex }),
        }),
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('ENROLLMENT_SESSION_REQUIRED');
    });
  });

  it('rejects a student_pubkey that is not 64 lowercase hex characters', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      const chain = await buildChain();
      const semester = await seedSemester(db);
      setEnv({
        [semester.id]: { private_key_hex: chain.enrollmentPrivHex, cert: chain.cert },
      });
      await db.insert(roster_entries).values({
        semester_id: semester.id,
        sid: '3032412345',
        display_name: 'Ada Lovelace',
        email,
      });
      const { sessionId } = await seedUser(db, email);

      const app = createV1App();
      const res = await app.fetch(enrollRequest(semester.id, sessionId, 'NOT-A-KEY'));
      expect(res.status).toBe(400);
    });
  });

  it('returns 404 for an unknown semester', async () => {
    await withDb(async (db) => {
      const email = uniqueEmail();
      setEnv();
      const { sessionId } = await seedUser(db, email);
      const student = await deriveCourseKeypair(seed(0x44), COURSE_ID);

      const app = createV1App();
      const res = await app.fetch(
        enrollRequest('00000000-0000-4000-8000-000000000000', sessionId, student.publicKeyHex),
      );
      expect(res.status).toBe(404);
    });
  });
});
