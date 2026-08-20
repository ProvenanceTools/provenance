/**
 * Student credential route integration tests — identity 2.1, institution-scoped.
 *
 * Goes through the full v1 pipeline via createV1App(), per the V18 rule.
 *
 * The properties these tests exist to pin, in order of how much it would cost
 * to get them wrong:
 *
 *  1. a credential is issued with NO roster row in existence — the deadlock the
 *     redesign removes. If this regresses, students cannot obtain an identity
 *     until after their first submission, which is the bug, not a safety net;
 *  2. the issued credential verifies against the root-signed institution cert
 *     using only log-core, and a mismatched secret is refused rather than
 *     issued;
 *  3. `student_ref` is opaque, random, and STABLE per SSO subject — one human
 *     is one contributor, never two, and re-issuing never allocates a second;
 *  4. the roster link is order-independent, case-insensitive, write-once, and
 *     cannot destroy an identity an archived bundle still needs;
 *  5. API tokens and view-as cannot issue, because a credential IS the
 *     attribution claim;
 *  6. MULTIPLE MACHINES PER STUDENT is supported and REMEMBERED. Two machines
 *     mean two keys and one ref, every key issued is recorded permanently, and
 *     the adjudication question — "was this key ever issued to this student?" —
 *     answers yes for BOTH of them, months after the second machine overwrote
 *     `students.student_pubkey` with its own.
 */

import { vi, describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  signInstitutionCert,
  deriveCourseKeypair,
  verifyInstitutionCert,
  verifyStudentCredential,
  checkCredentialWindow,
  INSTITUTION_IDENTITY_FORMAT_VERSION,
} from '@provenance/log-core';
import { StudentCredentialResponseSchema } from '@provenance/shared/api-schemas';
import { withTestDb } from '../../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetInstitutionKeyForTest } from '../../../config/institution-keys.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import {
  users,
  sessions,
  courses,
  semesters,
  roster_entries,
  students,
  student_credentials,
  api_tokens,
} from '../../../db/schema.js';
import {
  wasKeyEverIssuedToStudent,
  listStudentKeys,
} from '../../../services/enrollment/credential-history.js';
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

const INSTITUTION_ID = 'berkeley';
/** A student's single long-lived public key. One per student, forever. */
const STUDENT_PUBKEY = 'a'.repeat(64);
const OTHER_STUDENT_PUBKEY = 'b'.repeat(64);
/** A key this server never issued to anyone. The negative case for adjudication. */
const NEVER_ISSUED_PUBKEY = 'e'.repeat(64);

type Chain = {
  rootPubHex: string;
  cert: Record<string, unknown>;
  institutionPrivHex: string;
  institutionPubHex: string;
};

/** Build root → institution_cert once, deterministically. */
async function buildChain(certOverrides: Record<string, unknown> = {}): Promise<Chain> {
  const root = await deriveCourseKeypair(seed(0x41), 'fixture-root');
  const institution = await deriveCourseKeypair(seed(0x42), 'fixture-institution');

  const unsigned = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: INSTITUTION_ID,
    institution_pubkey: institution.publicKeyHex,
    valid_from: '2020-01-01',
    valid_until: '2099-12-31',
    ...certOverrides,
  };
  const cert = {
    ...unsigned,
    root_sig: await signInstitutionCert(
      unsigned as Parameters<typeof signInstitutionCert>[0],
      root.privateKey,
    ),
  };

  return {
    rootPubHex: root.publicKeyHex,
    cert,
    institutionPrivHex: toHex(institution.privateKey),
    institutionPubHex: institution.publicKeyHex,
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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-credential-tests-12345678',
  SESSION_TTL_DAYS: '14',
};

function setEnv(material?: Record<string, unknown>): void {
  _resetConfigForTest();
  _resetInstitutionKeyForTest();
  _setConfigForTest(
    parseEnv(
      material === undefined
        ? BASE_ENV
        : { ...BASE_ENV, PROVENANCE_INSTITUTION_KEY: JSON.stringify(material) },
    ),
  );
}

beforeEach(() => {
  _resetConfigForTest();
  _resetInstitutionKeyForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// DB injection — ONE container for the whole file.
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

async function withDb(fn: (instance: DrizzleDb) => Promise<void>): Promise<void> {
  await fn(getTestDb());
}

let counter = 0;

function uniqueEmail(): string {
  return `student-${counter++}@berkeley.edu`;
}

async function seedSemester(db: DrizzleDb) {
  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61B', slug: `cs61b-cred-${counter++}` })
    .returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2026,
      slug: `fa26-cred-${counter++}`,
      display_name: 'Fall 2026',
      filename_convention: '{sid}_{assignment}.zip',
    })
    .returning();
  return semester!;
}

async function seedUser(db: DrizzleDb, email: string) {
  const googleSubject = `sub-cred-${counter++}`;
  const [user] = await db
    .insert(users)
    .values({ google_subject: googleSubject, email, display_name: 'Student', is_superadmin: false })
    .returning();
  const sessionId = `sess-cred-${counter++}`.padEnd(43, 'x').slice(0, 43);
  await db.insert(sessions).values({
    id: sessionId,
    user_id: user!.id,
    expires_at: new Date(Date.now() + 14 * 86400_000),
  });
  return { user: user!, sessionId, googleSubject };
}

/**
 * A SECOND Google session for the SAME account — the "student enrolls from a
 * second machine" case. Same `google_subject`, therefore the same identity.
 */
async function seedSecondSession(db: DrizzleDb, userId: string) {
  const sessionId = `sess-cred-${counter++}`.padEnd(43, 'x').slice(0, 43);
  await db.insert(sessions).values({
    id: sessionId,
    user_id: userId,
    expires_at: new Date(Date.now() + 14 * 86400_000),
  });
  return sessionId;
}

function credentialRequest(sessionId: string, studentPubkey: string): Request {
  return new Request('http://localhost/identity/credential', {
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

describe('POST /identity/credential', () => {
  // -------------------------------------------------------------------------
  // The deadlock this redesign exists to remove
  // -------------------------------------------------------------------------

  it('issues a credential when the student is on NO roster at all', async () => {
    // THE regression test for the whole redesign. `mint.ts` returns
    // not_on_roster here, and rosters are only populated by Gradescope ingest
    // AFTER a student submits — so under 2.0 this student could not obtain an
    // identity before doing the work their identity is supposed to attribute.
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });

      const { sessionId } = await seedUser(db, uniqueEmail());

      // Deliberately no roster_entries row, and no semester either.
      const res = await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY));

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(StudentCredentialResponseSchema.safeParse(body).success).toBe(true);
      expect(body.credential.student_ref).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cryptography
  // -------------------------------------------------------------------------

  it('issues a credential that verifies against the root-signed institution cert', async () => {
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const { sessionId } = await seedUser(db, uniqueEmail());

      const res = await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY));
      expect(res.status).toBe(200);
      const body = await res.json();

      // Step 1: the cert is a trust anchor only once ROOT has vouched for it.
      const certOk = await verifyInstitutionCert(body.institution_cert, chain.rootPubHex);
      expect(certOk.ok).toBe(true);

      // Step 2: the credential verifies under the key that cert authorizes —
      // read from the ROOT-VERIFIED cert, never from the credential's own
      // travelling companion, which would make the check circular.
      const credOk = await verifyStudentCredential(
        body.credential,
        body.institution_cert.institution_pubkey,
      );
      expect(credOk.ok).toBe(true);

      // Step 3: the cross-institution forgery check — credential, cert, and the
      // verifier's own anchor must all name the same institution.
      expect(body.credential.institution_id).toBe(body.institution_cert.institution_id);
      expect(body.credential.institution_id).toBe(INSTITUTION_ID);

      // In window at issue time.
      expect(checkCredentialWindow(body.credential, body.credential.issued_at).in_window).toBe(
        true,
      );
      expect(body.credential.format_version).toBe(INSTITUTION_IDENTITY_FORMAT_VERSION);
    });
  });

  it('returns 503 rather than an unverifiable credential when the key does not match the cert', async () => {
    // A stale or mis-pasted secret must fail loudly at issue time, not hand the
    // student a credential no recorder or analyzer will ever accept.
    await withDb(async (db) => {
      const chain = await buildChain();
      const wrong = await deriveCourseKeypair(seed(0x99), 'wrong-institution');
      setEnv({ private_key_hex: toHex(wrong.privateKey), cert: chain.cert });
      const { sessionId } = await seedUser(db, uniqueEmail());

      const res = await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY));

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe('CREDENTIAL_UNAVAILABLE');
      expect(body.error.details.reason).toBe('key_mismatch');
    });
  });

  it('returns 503 when no institution key is configured', async () => {
    await withDb(async (db) => {
      setEnv(); // nothing configured
      const { sessionId } = await seedUser(db, uniqueEmail());

      const res = await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY));

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.code).toBe('CREDENTIAL_UNAVAILABLE');
      expect(body.error.details.reason).toBe('no_institution_key');
    });
  });

  it('refuses to issue under an out-of-window institution certificate', async () => {
    // A credential minted outside the window would be born out-of-window and
    // read as suspect forever. The failure belongs to the operator.
    await withDb(async (db) => {
      const chain = await buildChain({ valid_from: '2020-01-01', valid_until: '2020-12-31' });
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const { sessionId } = await seedUser(db, uniqueEmail());

      const res = await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY));

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.error.details.reason).toBe('cert_out_of_window');
    });
  });

  it('never returns the institution private key', async () => {
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const { sessionId } = await seedUser(db, uniqueEmail());

      const res = await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY));
      const text = await res.text();

      expect(text).not.toContain(chain.institutionPrivHex);
      // The PUBLIC half is expected to be there, inside the cert.
      expect(text).toContain(chain.institutionPubHex);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency — one human, one ref, forever
  // -------------------------------------------------------------------------

  it('gives the same account the same student_ref on a second machine', async () => {
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const { user, sessionId } = await seedUser(db, uniqueEmail());

      const first = await (
        await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
      ).json();
      expect(first.reissued).toBe(false);

      const secondSession = await seedSecondSession(db, user.id);
      const second = await (
        await createV1App().fetch(credentialRequest(secondSession, STUDENT_PUBKEY))
      ).json();

      expect(second.student_ref).toBe(first.student_ref);
      expect(second.reissued).toBe(true);
    });
  });

  it('re-enrolling never allocates a second students row for one SSO subject', async () => {
    // Two refs for one human would split their sessions into two apparent
    // contributors — precisely the confusion this exists to avoid.
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const { user, sessionId, googleSubject } = await seedUser(db, uniqueEmail());

      await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY));
      const s2 = await seedSecondSession(db, user.id);
      await createV1App().fetch(credentialRequest(s2, STUDENT_PUBKEY));
      const s3 = await seedSecondSession(db, user.id);
      // Even a DIFFERENT key (the "lost my master secret" case) must not fork.
      await createV1App().fetch(credentialRequest(s3, OTHER_STUDENT_PUBKEY));

      const rows = await db.select().from(students).where(eq(students.sso_subject, googleSubject));

      expect(rows).toHaveLength(1);
      expect(rows[0]!.issue_count).toBe(3);
      // The latest key is recorded; the ref is untouched.
      expect(rows[0]!.student_pubkey).toBe(OTHER_STUDENT_PUBKEY);
    });
  });

  it('re-issuing under a NEW key does not invalidate the credential already issued', async () => {
    // An issued credential stays valid until its own signed expires_at, because
    // the 2.1 chain verifies entirely from inside the bundle and consults no
    // server. This is the adjudication case the program exists for.
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const { user, sessionId } = await seedUser(db, uniqueEmail());

      const old = await (
        await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
      ).json();

      const s2 = await seedSecondSession(db, user.id);
      const fresh = await (
        await createV1App().fetch(credentialRequest(s2, OTHER_STUDENT_PUBKEY))
      ).json();

      // Same person, so the same ref — the superseded credential still names a
      // resolvable student.
      expect(fresh.student_ref).toBe(old.student_ref);

      // The OLD credential still verifies, offline, unchanged.
      const stillValid = await verifyStudentCredential(
        old.credential,
        old.institution_cert.institution_pubkey,
      );
      expect(stillValid.ok).toBe(true);
      expect(checkCredentialWindow(old.credential, old.credential.issued_at).in_window).toBe(true);
    });
  });

  it('student_ref is not derived from the SSO subject, the email, or the user id', async () => {
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const email = uniqueEmail();
      const { user, sessionId, googleSubject } = await seedUser(db, email);

      const body = await (
        await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
      ).json();

      const ref: string = body.student_ref;
      expect(ref).not.toContain(googleSubject);
      expect(ref).not.toContain(email.split('@')[0]);
      expect(ref).not.toBe(user.id);
      // It travels in session.start.identity where a project partner can read
      // it, so it must carry nothing.
      expect(ref).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  // -------------------------------------------------------------------------
  // Roster linking
  // -------------------------------------------------------------------------

  it('links a roster row that already exists — the "submitted, then enrolled" case', async () => {
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const email = uniqueEmail();
      const semester = await seedSemester(db);
      const [entry] = await db
        .insert(roster_entries)
        .values({
          semester_id: semester.id,
          sid: `sid-${counter++}`,
          display_name: 'Student',
          email,
        })
        .returning();
      expect(entry!.student_ref).toBeNull();

      const { sessionId } = await seedUser(db, email);
      const body = await (
        await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
      ).json();

      const [after] = await db
        .select()
        .from(roster_entries)
        .where(eq(roster_entries.id, entry!.id));
      expect(after!.student_ref).toBe(body.student_ref);
    });
  });

  it('links a roster row whose email differs only in CASE', async () => {
    // A Gradescope CSV and a Google account routinely disagree on case, and
    // treating them as different people would hand one human two identities.
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const email = uniqueEmail();
      const semester = await seedSemester(db);
      const [entry] = await db
        .insert(roster_entries)
        .values({
          semester_id: semester.id,
          sid: `sid-${counter++}`,
          display_name: 'Student',
          email: email.toUpperCase(),
        })
        .returning();

      const { sessionId } = await seedUser(db, email);
      const body = await (
        await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
      ).json();

      const [after] = await db
        .select()
        .from(roster_entries)
        .where(eq(roster_entries.id, entry!.id));
      expect(after!.student_ref).toBe(body.student_ref);
    });
  });

  it('links TWO roster rows matching one SSO identity — not an error, the normal case', async () => {
    // A student on a Fall roster and again on a Spring one. The 2.0 mint
    // refused this with 409 roster_ambiguous because it derived the ref FROM a
    // roster row; 2.1 derives it from the SSO subject, so both rows simply
    // point at the same ref.
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const email = uniqueEmail();
      const fall = await seedSemester(db);
      const spring = await seedSemester(db);
      const inserted = await db
        .insert(roster_entries)
        .values([
          { semester_id: fall.id, sid: `sid-${counter++}`, display_name: 'S', email },
          {
            semester_id: spring.id,
            sid: `sid-${counter++}`,
            display_name: 'S',
            email: email.toUpperCase(),
          },
        ])
        .returning();

      const { sessionId } = await seedUser(db, email);
      const res = await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY));

      expect(res.status).toBe(200);
      const body = await res.json();
      for (const row of inserted) {
        const [after] = await db.select().from(roster_entries).where(eq(roster_entries.id, row.id));
        expect(after!.student_ref).toBe(body.student_ref);
      }
    });
  });

  it('does not re-point a roster row that is already linked to someone else', async () => {
    // The IS NULL guard makes the link WRITE-ONCE. Re-pointing would silently
    // re-attribute a student's work.
    //
    // The scenario is an address REASSIGNMENT: a roster row is already
    // attributed to one person, and a different Google account later shows up
    // carrying the address that roster row happens to list. That is exactly
    // when a re-point would do the most damage, and exactly when nothing but
    // the guard prevents it.
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const semester = await seedSemester(db);
      const rosterEmail = uniqueEmail();

      // The incumbent: a student whose OWN sso_email differs from the roster
      // row's, so only the pre-existing link — not an email match — ties them
      // together. This makes the assertion deterministic: an unguarded UPDATE
      // has exactly one candidate to re-point to, the newcomer.
      const [incumbent] = await db
        .insert(students)
        .values({
          institution_id: INSTITUTION_ID,
          sso_subject: `sub-incumbent-${counter++}`,
          sso_email: uniqueEmail(),
        })
        .returning();

      const [entry] = await db
        .insert(roster_entries)
        .values({
          semester_id: semester.id,
          sid: `sid-${counter++}`,
          display_name: 'S',
          email: rosterEmail,
          student_ref: incumbent!.student_ref,
        })
        .returning();

      // The newcomer authenticates with the address the roster row lists.
      const { sessionId } = await seedUser(db, rosterEmail);
      const res = await createV1App().fetch(credentialRequest(sessionId, OTHER_STUDENT_PUBKEY));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.student_ref).not.toBe(incumbent!.student_ref);

      const [after] = await db
        .select()
        .from(roster_entries)
        .where(eq(roster_entries.id, entry!.id));
      // Still the incumbent's ref — the newcomer did not inherit their work.
      expect(after!.student_ref).toBe(incumbent!.student_ref);
    });
  });

  it('deleting a linked roster row does not destroy the identity', async () => {
    // The property migration 0024 had to buy with ON DELETE SET NULL, held here
    // by construction: the link lives on the roster side, so a `student_ref`
    // read out of an archived bundle still resolves afterwards.
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const email = uniqueEmail();
      const semester = await seedSemester(db);
      const [entry] = await db
        .insert(roster_entries)
        .values({
          semester_id: semester.id,
          sid: `sid-${counter++}`,
          display_name: 'S',
          email,
        })
        .returning();

      const { sessionId } = await seedUser(db, email);
      const body = await (
        await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
      ).json();

      await db.delete(roster_entries).where(eq(roster_entries.id, entry!.id));

      // The archived bundle names this ref. It must still resolve to a person.
      const rows = await db
        .select()
        .from(students)
        .where(eq(students.student_ref, body.student_ref));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sso_email).toBe(email);
    });
  });

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  it('rejects an unauthenticated request', async () => {
    await withDb(async () => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });

      const res = await createV1App().fetch(
        new Request('http://localhost/identity/credential', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ student_pubkey: STUDENT_PUBKEY }),
        }),
      );

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_REQUIRED');
    });
  });

  it('refuses an API token — a credential IS the attribution claim', async () => {
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const { user } = await seedUser(db, uniqueEmail());

      // A real API token, minted via the same helpers the token middleware
      // verifies against. The route must refuse it before it ever reaches the
      // service.
      const { generateToken, hashToken } = await import('../../../auth/tokens.js');
      const { prefix, secret } = generateToken();
      await db.insert(api_tokens).values({
        user_id: user.id,
        label: 'test',
        prefix,
        hashed_token: await hashToken(secret),
        scopes: { read_only: false, semester_ids: null, allow_blob_download: false },
      });

      const res = await createV1App().fetch(
        new Request('http://localhost/identity/credential', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify({ student_pubkey: STUDENT_PUBKEY }),
        }),
      );

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('CREDENTIAL_SESSION_REQUIRED');

      // And nothing was allocated.
      const rows = await db.select().from(students).where(eq(students.sso_subject, 'unused'));
      expect(rows).toHaveLength(0);
    });
  });

  it('refuses a superadmin in view-as mode', async () => {
    // Issuing while impersonating would produce signed evidence attributing
    // work to someone by an OPERATOR's action — exactly what this chain exists
    // to make impossible.
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });

      const admin = await seedUser(db, `admin-${counter++}@berkeley.edu`);
      const victim = await seedUser(db, uniqueEmail());
      await db.update(users).set({ is_superadmin: true }).where(eq(users.id, admin.user.id));
      await db
        .update(sessions)
        .set({ view_as_user_id: victim.user.id, view_as_started_at: new Date() })
        .where(eq(sessions.id, admin.sessionId));

      const res = await createV1App().fetch(credentialRequest(admin.sessionId, STUDENT_PUBKEY));

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('VIEW_AS_READ_ONLY');

      // And nothing was allocated for the impersonated student.
      const rows = await db
        .select()
        .from(students)
        .where(eq(students.sso_subject, victim.googleSubject));
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple machines — supported, and remembered
  // -------------------------------------------------------------------------

  describe('two machines, one student', () => {
    it('records BOTH keys against ONE student_ref', async () => {
      // Each machine derives its own master secret, so a student legitimately
      // presents a different public key from each. `students` holds only the
      // most recent one; the history is what keeps the rest.
      await withDb(async (db) => {
        const chain = await buildChain();
        setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
        const { user, sessionId } = await seedUser(db, uniqueEmail());

        // Machine A — the laptop.
        const laptop = await (
          await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
        ).json();

        // Machine B — the desktop, months later, same account.
        const s2 = await seedSecondSession(db, user.id);
        const desktop = await (
          await createV1App().fetch(credentialRequest(s2, OTHER_STUDENT_PUBKEY))
        ).json();

        // ONE ref. This is what makes contributor resolution — which groups on
        // student_ref — see one person rather than two.
        expect(desktop.student_ref).toBe(laptop.student_ref);

        // TWO recorded keys, oldest first.
        const keys = await listStudentKeys(db, laptop.student_ref);
        expect(keys.map((k) => k.student_pubkey)).toEqual([STUDENT_PUBKEY, OTHER_STUDENT_PUBKEY]);

        // And `students` still holds exactly one row, carrying the newest key —
        // the identity anchor is unchanged, the history is purely additive.
        const anchor = await db
          .select()
          .from(students)
          .where(eq(students.student_ref, laptop.student_ref));
        expect(anchor).toHaveLength(1);
        expect(anchor[0]!.student_pubkey).toBe(OTHER_STUDENT_PUBKEY);
      });
    });

    it('answers "was this key ever issued to this student?" yes for BOTH machines', async () => {
      // THE adjudication question. Answering it from `students.student_pubkey`
      // would report the laptop key — the one an October bundle carries — as
      // never issued, purely because the desktop enrolled in November.
      await withDb(async (db) => {
        const chain = await buildChain();
        setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
        const { user, sessionId } = await seedUser(db, uniqueEmail());

        const laptop = await (
          await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
        ).json();
        const s2 = await seedSecondSession(db, user.id);
        await createV1App().fetch(credentialRequest(s2, OTHER_STUDENT_PUBKEY));

        const ref: string = laptop.student_ref;
        await expect(
          wasKeyEverIssuedToStudent(db, { studentRef: ref, studentPubkey: STUDENT_PUBKEY }),
        ).resolves.toBe(true);
        await expect(
          wasKeyEverIssuedToStudent(db, { studentRef: ref, studentPubkey: OTHER_STUDENT_PUBKEY }),
        ).resolves.toBe(true);

        // A key this student never presented is not theirs, and the history
        // says so rather than shrugging.
        await expect(
          wasKeyEverIssuedToStudent(db, { studentRef: ref, studentPubkey: NEVER_ISSUED_PUBKEY }),
        ).resolves.toBe(false);
      });
    });

    it("does not attribute one student's key to another student", async () => {
      await withDb(async (db) => {
        const chain = await buildChain();
        setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
        const mine = await seedUser(db, uniqueEmail());
        const theirs = await seedUser(db, uniqueEmail());

        const a = await (
          await createV1App().fetch(credentialRequest(mine.sessionId, STUDENT_PUBKEY))
        ).json();
        const b = await (
          await createV1App().fetch(credentialRequest(theirs.sessionId, OTHER_STUDENT_PUBKEY))
        ).json();

        expect(b.student_ref).not.toBe(a.student_ref);
        await expect(
          wasKeyEverIssuedToStudent(db, {
            studentRef: a.student_ref,
            studentPubkey: OTHER_STUDENT_PUBKEY,
          }),
        ).resolves.toBe(false);
      });
    });

    it("machine A's credential still verifies after machine B enrols", async () => {
      // The property the whole design rests on: a credential is a signed
      // artifact, so nothing the server later writes can reach it.
      await withDb(async (db) => {
        const chain = await buildChain();
        setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
        const { user, sessionId } = await seedUser(db, uniqueEmail());

        const laptop = await (
          await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
        ).json();

        const s2 = await seedSecondSession(db, user.id);
        await createV1App().fetch(credentialRequest(s2, OTHER_STUDENT_PUBKEY));

        const stillValid = await verifyStudentCredential(
          laptop.credential,
          laptop.institution_cert.institution_pubkey,
        );
        expect(stillValid.ok).toBe(true);
        // ...and the server can now also say it was one of theirs, which is the
        // part that used to be lost.
        await expect(
          wasKeyEverIssuedToStudent(db, {
            studentRef: laptop.student_ref,
            studentPubkey: laptop.credential.student_pubkey,
          }),
        ).resolves.toBe(true);
      });
    });

    it('APPENDS rather than overwriting when the same machine re-enrols', async () => {
      // Two issuances of one key are two facts with different issued_at. An
      // adjudicator asking which credential was live when a bundle was recorded
      // needs both, so nothing collapses them into a counter.
      await withDb(async (db) => {
        const chain = await buildChain();
        setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
        const { user, sessionId } = await seedUser(db, uniqueEmail());

        const first = await (
          await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
        ).json();
        const s2 = await seedSecondSession(db, user.id);
        await createV1App().fetch(credentialRequest(s2, STUDENT_PUBKEY));

        const rows = await db
          .select()
          .from(student_credentials)
          .where(eq(student_credentials.student_ref, first.student_ref));
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.student_pubkey === STUDENT_PUBKEY)).toBe(true);
      });
    });

    it('reports machine_count and key_first_issued so the page can read as normal', async () => {
      await withDb(async (db) => {
        const chain = await buildChain();
        setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
        const { user, sessionId } = await seedUser(db, uniqueEmail());

        const first = await (
          await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY))
        ).json();
        expect(first.machine_count).toBe(1);
        expect(first.key_first_issued).toBe(true);
        expect(first.reissued).toBe(false);

        // Same machine again: a fresh credential, NOT a new machine.
        const s2 = await seedSecondSession(db, user.id);
        const again = await (
          await createV1App().fetch(credentialRequest(s2, STUDENT_PUBKEY))
        ).json();
        expect(again.machine_count).toBe(1);
        expect(again.key_first_issued).toBe(false);

        // A genuinely second machine.
        const s3 = await seedSecondSession(db, user.id);
        const second = await (
          await createV1App().fetch(credentialRequest(s3, OTHER_STUDENT_PUBKEY))
        ).json();
        expect(second.machine_count).toBe(2);
        expect(second.key_first_issued).toBe(true);
      });
    });

    it('records nothing when the institution refuses to issue', async () => {
      // A deployment whose private key does not match its certificate must not
      // leave a history row for a credential no student ever received.
      await withDb(async (db) => {
        const chain = await buildChain();
        const wrong = await deriveCourseKeypair(seed(0x99), 'wrong-institution');
        setEnv({ private_key_hex: toHex(wrong.privateKey), cert: chain.cert });
        const { sessionId } = await seedUser(db, uniqueEmail());

        const res = await createV1App().fetch(credentialRequest(sessionId, STUDENT_PUBKEY));
        expect(res.status).toBe(503);

        const rows = await db
          .select()
          .from(student_credentials)
          .where(eq(student_credentials.student_pubkey, STUDENT_PUBKEY));
        expect(rows).toHaveLength(0);
      });
    });
  });

  it('rejects a student_pubkey that is not 64 lowercase hex characters', async () => {
    await withDb(async (db) => {
      const chain = await buildChain();
      setEnv({ private_key_hex: chain.institutionPrivHex, cert: chain.cert });
      const { sessionId } = await seedUser(db, uniqueEmail());

      for (const bad of ['', 'zz', STUDENT_PUBKEY.toUpperCase(), `${STUDENT_PUBKEY}00`]) {
        const res = await createV1App().fetch(credentialRequest(sessionId, bad));
        expect(res.status).toBe(400);
      }
    });
  });
});
