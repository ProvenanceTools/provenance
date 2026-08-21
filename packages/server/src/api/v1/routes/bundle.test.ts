/**
 * Bundle download endpoint integration tests (Phase 18).
 *
 * Tests the bundle endpoint through createV1App() per V18 rule.
 * Requires both Postgres (testcontainers) and MinIO (for signed URL
 * generation — presignGetUrl makes an AWS4 HTTP request to MinIO).
 *
 * Test groups:
 *   1. GET /submissions/:id/bundle — returns 302 with Location header
 *   2. GET /submissions/:id/bundle — audit row created (V20 rule)
 *   3. GET /submissions/:id/bundle — token without include_blobs → 403
 *   4. GET /submissions/:id/bundle — unauthenticated → 401
 *
 * Implementation note on signed URLs: `presignGetUrl` calls MinIO's S3
 * presign API. We need a real MinIO container OR we can mock storageClient.
 * To keep tests fast we mock `presignGetUrl` directly — the signed-URL
 * generation is already tested in blobs.test.ts. What we're testing here
 * is the route wiring: auth, audit, token scope, 302 location.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../../test/helpers/db.js';
import { waitForAuditRow } from '../../../../test/helpers/audit.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import {
  users,
  sessions,
  courses,
  semesters,
  memberships,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import { createToken } from '../../../auth/tokens.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Mock presignGetUrl to avoid needing a real MinIO container.
// blobs.test.ts covers the actual S3 signing; here we test route wiring.
// ---------------------------------------------------------------------------

vi.mock('../../../services/storage/blobs.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../services/storage/blobs.js')>();
  return {
    ...original,
    presignGetUrl: vi.fn().mockResolvedValue('https://storage.example.com/signed-url?expires=1234'),
  };
});

// ---------------------------------------------------------------------------
// DB injection
// ---------------------------------------------------------------------------

let _testDb: DrizzleDb | null = null;

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

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeTestEnv(extra?: Record<string, string>) {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-bundle-tests-12345678901',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
    BLOB_DOWNLOAD_URL_TTL_SECONDS: '300',
    ...extra,
  };
}

async function seedUser(db: DrizzleDb) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: `user-${id}@berkeley.edu`,
      display_name: 'Test User',
    })
    .returning();
  return user!;
}

async function seedSession(db: DrizzleDb, userId: string): Promise<string> {
  const id = `sess-${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 43);
  await db.insert(sessions).values({
    id,
    user_id: userId,
    expires_at: new Date(Date.now() + 14 * 86400_000),
  });
  return id;
}

async function seedCourseAndSemester(db: DrizzleDb) {
  const uid = crypto.randomUUID().slice(0, 8);
  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61A', slug: `cs61a-${uid}` })
    .returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `fa2024-${uid}`,
      display_name: 'Fall 2024',
      filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
    })
    .returning();
  return { course: course!, semester: semester! };
}

async function seedMembership(db: DrizzleDb, userId: string, semesterId: string) {
  await db.insert(memberships).values({
    user_id: userId,
    semester_id: semesterId,
    role: 'admin',
    granted_by: userId,
  });
}

async function seedSubmission(db: DrizzleDb, semesterId: string, userId: string) {
  const uid = crypto.randomUUID().slice(0, 8);

  const [student] = await db
    .insert(roster_entries)
    .values({ semester_id: semesterId, sid: `s-${uid}`, display_name: 'Alice' })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semesterId, assignment_id_str: `hw-${uid}`, label: 'HW1' })
    .returning();

  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'succeeded' })
    .returning();

  const submissionId = crypto.randomUUID();
  await db.insert(submissions).values({
    id: submissionId,
    semester_id: semesterId,
    assignment_id: assignment!.id,
    student_id: student!.id,
    blob_object_key: `semesters/${semesterId}/submissions/${submissionId}/bundle.zip`,
    blob_sha256: `sha256-${submissionId}`,
    source_filename: 'test.zip',
    ingest_job_id: job!.id,
    version_index: 1,
  });

  return submissionId;
}

/**
 * Create an API token with the given scopes via the canonical createToken helper.
 * Returns the full prov_<prefix>_<random> secret for Authorization: Bearer headers.
 * Uses argon2-hashed storage matching production token creation.
 */
async function seedToken(
  db: DrizzleDb,
  userId: string,
  semesterId: string,
  scopes: { read_only?: boolean; semester_ids?: string[] | null; include_blobs?: boolean },
): Promise<string> {
  const { secret } = await createToken(db, {
    userId,
    label: 'test-token',
    scopes: {
      read_only: scopes.read_only ?? true,
      semester_ids: scopes.semester_ids !== undefined ? scopes.semester_ids : [semesterId],
      include_blobs: scopes.include_blobs ?? false,
    },
  });
  return secret;
}

// ---------------------------------------------------------------------------
// §1. Returns 302 with Location header
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/bundle', () => {
  it('returns 302 with signed Location URL', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);
      const submissionId = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/bundle`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          redirect: 'manual',
        }),
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toBeTruthy();
      expect(location).toContain('signed-url');
    });
  });

  // -------------------------------------------------------------------------
  // §2. Audit row created (V20 rule)
  // -------------------------------------------------------------------------

  it('creates a bundle.download audit row', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);
      const submissionId = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/bundle`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          redirect: 'manual',
        }),
      );

      const auditRow = await waitForAuditRow(db, 'bundle.download', submissionId);
      expect(auditRow).toBeTruthy();
      expect(auditRow!.target_type).toBe('submission');
      const detail = auditRow!.detail as Record<string, unknown>;
      expect(detail['submission_id']).toBe(submissionId);
      expect(typeof detail['expires_at']).toBe('string');
    });
  });

  // -------------------------------------------------------------------------
  // §3. Token without include_blobs → 403 TOKEN_BLOB_NOT_PERMITTED
  // -------------------------------------------------------------------------

  it('token without include_blobs → 403 TOKEN_BLOB_NOT_PERMITTED', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id);
      const submissionId = await seedSubmission(db, semester.id, user.id);

      // Token with include_blobs: false (default).
      const rawToken = await seedToken(db, user.id, semester.id, { include_blobs: false });

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${submissionId}/bundle`, {
          headers: { Authorization: `Bearer ${rawToken}` },
          redirect: 'manual',
        }),
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      const error = body['error'] as Record<string, unknown>;
      expect(error['code']).toBe('TOKEN_BLOB_NOT_PERMITTED');
    });
  });

  // -------------------------------------------------------------------------
  // §4. Unauthenticated → 401
  // -------------------------------------------------------------------------

  it('returns 401 without authentication', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const fakeId = crypto.randomUUID();
      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${fakeId}/bundle`, { redirect: 'manual' }),
      );

      expect(res.status).toBe(401);
    });
  });
});
