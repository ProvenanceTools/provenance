/**
 * Unmatched tray routes integration tests (Phase 15).
 *
 * Tests all unmatched endpoints through createV1App() per V18 rule.
 * Per V20, all write endpoints assert an audit_log row.
 * Per V21, the PATCH attach has a concurrent attach test (two simultaneous
 * requests for the same file — exactly one succeeds, the other gets 409).
 *
 * Test groups:
 *   1. GET /unmatched — list tests (DB only, no MinIO needed)
 *   2. POST /unmatched/:id/discard — discard tests (DB only)
 *   3. PATCH /unmatched/:id — attach tests (requires MinIO for real bundle parse)
 *   4. Concurrent attach — concurrency test with real MinIO
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { withTestDb } from '../../../../test/helpers/db.js';
import { withTestMinio } from '../../../../test/helpers/minio.js';
import { waitForAuditRow } from '../../../../test/helpers/audit.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { _resetDbForTest } from '../../../db/client.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import {
  users,
  sessions,
  courses,
  semesters,
  memberships,
  roster_entries,
  ingest_jobs,
  ingest_files,
  submissions,
  validation_results,
  per_file_stats,
} from '../../../db/schema.js';
import * as schema from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import { putBlob } from '../../../services/storage/blobs.js';
import { ingestStagingKey } from '../../../services/storage/keys.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';

// ---------------------------------------------------------------------------
// Mock pg-boss so PATCH /unmatched doesn't require a real pg-boss connection.
// The attach service calls boss.send(recompute_cross_flags) after commit.
// We verify the pipeline ran by checking DB rows — not by running the worker.
// ---------------------------------------------------------------------------
vi.mock('../../../jobs/pg-boss.js', () => ({
  getBoss: vi.fn().mockResolvedValue({
    send: vi.fn().mockResolvedValue(null),
    work: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createQueue: vi.fn().mockResolvedValue(undefined),
  }),
  stopBoss: vi.fn().mockResolvedValue(undefined),
  JOB_KINDS: {
    INGEST_FILE: 'ingest_file',
    INGEST_FINALIZE: 'ingest_finalize',
    RECOMPUTE_SEMESTER: 'recompute_semester',
    RECOMPUTE_SUBMISSION: 'recompute_submission',
    RECOMPUTE_FINALIZE: 'recompute_finalize',
    RECOMPUTE_CROSS_FLAGS: 'recompute_cross_flags',
  },
  _resetBossForTest: vi.fn(),
}));

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

// ---------------------------------------------------------------------------
// beforeEach: reset config / logger
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(db: DrizzleDb, opts?: { isAdmin?: boolean; protected?: boolean }) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: `user-${id}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: opts?.isAdmin ?? false,
      protected: opts?.protected ?? false,
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

async function seedMembership(
  db: DrizzleDb,
  userId: string,
  semesterId: string,
  role: 'admin' | 'grader',
) {
  await db.insert(memberships).values({
    user_id: userId,
    semester_id: semesterId,
    role,
    granted_by: userId,
  });
}

async function seedRosterEntry(db: DrizzleDb, semesterId: string, sid?: string) {
  const [entry] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: sid ?? `stu-${crypto.randomUUID().slice(0, 8)}`,
      display_name: 'Test Student',
    })
    .returning();
  return entry!;
}

async function seedIngestJob(db: DrizzleDb, semesterId: string, userId: string) {
  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'running' })
    .returning();
  return job!;
}

async function seedUnmatchedFile(db: DrizzleDb, ingestJobId: string) {
  const [file] = await db
    .insert(ingest_files)
    .values({
      ingest_job_id: ingestJobId,
      original_filename: 'hw01-123456.zip',
      size_bytes: 1024,
      blob_sha256: `sha256-${crypto.randomUUID()}`,
      status: 'unmatched',
      error: { phase: 'match_student', cause: 'unknown_sid' },
      resolved_at: new Date(),
    })
    .returning();
  return file!;
}

// ---------------------------------------------------------------------------
// Test env builder (no MinIO needed for non-attach tests)
// ---------------------------------------------------------------------------

function makeTestEnv(opts?: { minioEndpoint?: string; minioBucket?: string }) {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance', // overridden by mock
    OBJECT_STORAGE_ENDPOINT: opts?.minioEndpoint ?? 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: opts?.minioBucket ?? 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-unmatched-tests-123456789',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

// ---------------------------------------------------------------------------
// §1. GET /unmatched — list tests
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/unmatched', () => {
  it('returns paginated unmatched files', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const job = await seedIngestJob(db, semester.id, user.id);

      // Seed 3 unmatched files.
      await seedUnmatchedFile(db, job.id);
      await seedUnmatchedFile(db, job.id);
      await seedUnmatchedFile(db, job.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/unmatched`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; next_cursor: string | null };
      expect(body.items).toHaveLength(3);
      expect(body.next_cursor).toBeNull();
    });
  });

  it('returns empty items when no unmatched files exist', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/unmatched`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; next_cursor: string | null };
      expect(body.items).toHaveLength(0);
      expect(body.next_cursor).toBeNull();
    });
  });

  it('paginates with cursor (limit=1)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const job = await seedIngestJob(db, semester.id, user.id);

      // Seed 2 unmatched files with deliberate time gap.
      await seedUnmatchedFile(db, job.id);
      await new Promise((r) => setTimeout(r, 5)); // ensure distinct created_at
      await seedUnmatchedFile(db, job.id);

      const app = createV1App();
      const res1 = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/unmatched?limit=1`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );
      expect(res1.status).toBe(200);
      const body1 = (await res1.json()) as {
        items: Array<{ id: string }>;
        next_cursor: string | null;
      };
      expect(body1.items).toHaveLength(1);
      expect(body1.next_cursor).toBeTruthy();

      // Fetch second page.
      const res2 = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/unmatched?limit=1&cursor=${body1.next_cursor!}`,
          { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
        ),
      );
      expect(res2.status).toBe(200);
      const body2 = (await res2.json()) as {
        items: Array<{ id: string }>;
        next_cursor: string | null;
      };
      expect(body2.items).toHaveLength(1);
      expect(body2.next_cursor).toBeNull();
      // Pages must have different items.
      expect(body2.items[0]!.id).not.toBe(body1.items[0]!.id);
    });
  });

  // -------------------------------------------------------------------------
  // Keyset pagination across a shared millisecond.
  //
  // Postgres stores `timestamptz` at MICROSECOND precision; a JS `Date` — which
  // is what Drizzle's default `mode: 'date'` hands back — carries only
  // MILLISECONDS. The cursor used to be minted from that Date, so it could not
  // express the true position of the last row on the page, and every same-ms
  // row had to be decided by the uuid tiebreak instead. `id` is a random
  // `gen_random_uuid()`, so that tiebreak contradicts the true microsecond
  // ordering the query ORDERs BY: rows fall through both branches and vanish,
  // with `next_cursor` still reporting success.
  //
  // Batch ingest writes a whole tray of files in one go, so sharing a
  // millisecond is the normal case here, not an edge case.
  //
  // The timestamps are literal rather than defaulted so this is deterministic.
  // -------------------------------------------------------------------------
  it('does not drop unmatched files that share a millisecond with the cursor row', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const job = await seedIngestJob(db, semester.id, user.id);

      // Five files inside ONE millisecond, each with a distinct non-zero
      // microsecond remainder. A `Date` cannot express microseconds, so the
      // value is written as a literal string.
      const SHARED_MS = '2026-08-20T12:00:00.500';
      const MICROS = ['123', '456', '789', '012', '345'];
      for (const us of MICROS) {
        await db.insert(ingest_files).values({
          ingest_job_id: job.id,
          original_filename: `hw01-${us}.zip`,
          size_bytes: 1024,
          blob_sha256: `sha256-${crypto.randomUUID()}`,
          status: 'unmatched',
          error: { phase: 'match_student', cause: 'unknown_sid' },
          created_at: sql`${`${SHARED_MS}${us}+00`}::timestamptz`,
        });
      }

      const app = createV1App();
      const base = `http://localhost/semesters/${semester.id}/unmatched`;

      // Walk every page to exhaustion, exactly as a client would.
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const url: string =
          cursor === null ? `${base}?limit=2` : `${base}?limit=2&cursor=${cursor}`;
        const res = await app.fetch(
          new Request(url, { headers: { Cookie: `__Host-prov_sess=${sessionId}` } }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: Array<{ id: string }>;
          next_cursor: string | null;
        };
        seen.push(...body.items.map((i) => i.id));
        cursor = body.next_cursor;
        if (cursor === null) break;
      }

      // Every file is reachable, exactly once. `Set` size guards the opposite
      // failure: a cursor that re-serves rows is not a fix either.
      expect(seen).toHaveLength(MICROS.length);
      expect(new Set(seen).size).toBe(MICROS.length);
    });
  });

  // A cursor minted before the microsecond fix carries a millisecond-precision
  // timestamp. Honouring it would silently drop the rest of its millisecond
  // bucket, so it is rejected and the client restarts pagination.
  it('rejects a legacy millisecond-precision cursor with 400', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const job = await seedIngestJob(db, semester.id, user.id);
      await seedUnmatchedFile(db, job.id);

      // Exactly the shape `encodeCursor` produced before this change.
      const legacy = Buffer.from(
        JSON.stringify({ ca: '2026-08-20T12:00:00.500Z', id: crypto.randomUUID() }),
      ).toString('base64url');

      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/unmatched?limit=2&cursor=${legacy}`,
          {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          },
        ),
      );
      expect(res.status).toBe(400);
    });
  });

  it('rejects a structurally invalid cursor with 400', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');

      const app = createV1App();
      const res = await app.fetch(
        new Request(
          `http://localhost/semesters/${semester.id}/unmatched?limit=2&cursor=not-base64`,
          {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          },
        ),
      );
      expect(res.status).toBe(400);
    });
  });
});

// ---------------------------------------------------------------------------
// §2. POST /unmatched/:id/discard
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/unmatched/:id/discard', () => {
  it('marks an unmatched file as discarded and returns IngestFileSummary', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const job = await seedIngestJob(db, semester.id, user.id);
      const file = await seedUnmatchedFile(db, job.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/unmatched/${file.id}/discard`, {
          method: 'POST',
          headers: {
            Cookie: `__Host-prov_sess=${sessionId}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: 'student withdrew' }),
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body['status']).toBe('discarded');
      expect(body['id']).toBe(file.id);

      // Verify DB state.
      const [updated] = await db
        .select({ status: ingest_files.status, error: ingest_files.error })
        .from(ingest_files)
        .where(eq(ingest_files.id, file.id));
      expect(updated!.status).toBe('discarded');
      const error = updated!.error as Record<string, unknown>;
      expect(error['code']).toBe('DISCARDED');
      expect(error['message']).toBe('student withdrew');
      expect((error['details'] as Record<string, unknown>)['reason']).toBe('student withdrew');

      // V20: assert audit row.
      const auditRow = await waitForAuditRow(db, 'ingest.unmatched.discard', file.id);
      expect(auditRow).toBeDefined();
    });
  });

  it('returns 409 INGEST_FILE_NOT_UNMATCHED when file is already matched', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const job = await seedIngestJob(db, semester.id, user.id);

      // Create a file in 'matched' status.
      const [file] = await db
        .insert(ingest_files)
        .values({
          ingest_job_id: job.id,
          original_filename: 'hw01-123456.zip',
          size_bytes: 1024,
          blob_sha256: `sha256-${crypto.randomUUID()}`,
          status: 'matched',
        })
        .returning();

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/unmatched/${file!.id}/discard`, {
          method: 'POST',
          headers: {
            Cookie: `__Host-prov_sess=${sessionId}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        }),
      );

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INGEST_FILE_NOT_UNMATCHED');
    });
  });
});

// ---------------------------------------------------------------------------
// §3. PATCH /unmatched/:id — attach tests (require MinIO + real bundle)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/migrations');

import type { StorageClient } from '../../../services/storage/client.js';

/**
 * Build a real bundle ZIP + stage it at the expected staging key.
 */
async function stageTestBundle(
  storageClient: StorageClient,
  ingestJobId: string,
  ingestFileId: string,
  assignmentId: string,
): Promise<{ blobSha256: string }> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId,
    semester: 'fa2024',
    sessions: [{ eventCount: 5 }],
  });
  const bytes = new Uint8Array(zipBuffer);
  const stagingKey = ingestStagingKey(ingestJobId, ingestFileId);
  const { sha256 } = await putBlob(storageClient, stagingKey, bytes);
  return { blobSha256: sha256 };
}

describe('PATCH /semesters/:semesterId/unmatched/:id — attach (requires MinIO)', () => {
  it('happy path: moves file unmatched → matched, creates submission, materializes pipeline', async () => {
    await withTestMinio(async ({ client: storageClient, bucketName }) => {
      const minioEndpoint = storageClient.bucketUrl.replace(`/${bucketName}`, '');

      // Use a dedicated Postgres container so we don't compete with withTestDb.
      const pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('provenance_test')
        .withUsername('test')
        .withPassword('test')
        .start();
      const connStr = pgContainer.getConnectionUri();
      const dbSql = postgres(connStr, { max: 5 });
      const db = drizzle(dbSql, { schema }) as DrizzleDb;
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      _testDb = db;
      _resetConfigForTest();
      _resetLoggerForTest();
      await _resetDbForTest();

      _setConfigForTest(
        parseEnv(
          makeTestEnv({
            minioEndpoint: minioEndpoint ?? 'http://localhost:9000',
            minioBucket: bucketName,
          }),
        ),
      );

      try {
        // Seed test data.
        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const student = await seedRosterEntry(db, semester.id, '123456');
        const job = await seedIngestJob(db, semester.id, user.id);

        // Pre-allocate the ingestFileId so we can build the staging key.
        const ingestFileId = crypto.randomUUID();
        const assignmentId = 'hw01';

        const { blobSha256 } = await stageTestBundle(
          storageClient,
          job.id,
          ingestFileId,
          assignmentId,
        );

        // Create the ingest_files row in 'unmatched' state.
        await db.insert(ingest_files).values({
          id: ingestFileId,
          ingest_job_id: job.id,
          original_filename: `${assignmentId}-123456.zip`,
          size_bytes: 1024,
          blob_sha256: blobSha256,
          status: 'unmatched',
          error: { phase: 'match_student', cause: 'unknown_sid' },
          resolved_at: new Date(),
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/unmatched/${ingestFileId}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              student_id: student.id,
              assignment_id_str: assignmentId,
            }),
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body['status']).toBe('matched');
        expect(body['id']).toBe(ingestFileId);
        expect((body as Record<string, unknown>)['warnings']).toEqual([]);

        // Verify the ingest_files row was updated.
        const [fileRow] = await db
          .select({
            status: ingest_files.status,
            matched_student_id: ingest_files.matched_student_id,
            submission_id: ingest_files.submission_id,
          })
          .from(ingest_files)
          .where(eq(ingest_files.id, ingestFileId));
        expect(fileRow!.status).toBe('matched');
        expect(fileRow!.matched_student_id).toBe(student.id);
        expect(fileRow!.submission_id).toBeTruthy();

        const submissionId = fileRow!.submission_id!;

        // Verify the submissions row exists.
        const [sub] = await db
          .select({ id: submissions.id })
          .from(submissions)
          .where(eq(submissions.id, submissionId));
        expect(sub).toBeDefined();

        // NOTE: events are no longer materialized into Postgres (the events
        // table was dropped — migration 0019). The previous "events were
        // materialized" assertion here has been removed; the event stream now
        // lives only in the stored bundle blob and is re-parsed on demand by
        // read paths (see events.test.ts).

        // Verify per_file_stats row exists.
        const statsRows = await db
          .select({ submission_id: per_file_stats.submission_id })
          .from(per_file_stats)
          .where(eq(per_file_stats.submission_id, submissionId));
        expect(statsRows.length).toBeGreaterThan(0);

        // Verify validation_results row exists.
        const valRows = await db
          .select({ submission_id: validation_results.submission_id })
          .from(validation_results)
          .where(eq(validation_results.submission_id, submissionId));
        expect(valRows.length).toBeGreaterThan(0);

        // V20: assert audit row.
        const auditRow = await waitForAuditRow(db, 'ingest.unmatched.attach', ingestFileId);
        expect(auditRow).toBeDefined();
      } finally {
        _testDb = null;
        _resetConfigForTest();
        _resetLoggerForTest();
        await _resetDbForTest();
        await dbSql.end();
        await pgContainer.stop();
      }
    });
  });

  it('attach with bundle manifest assignment_id mismatch → 200 + warning', async () => {
    await withTestMinio(async ({ client: storageClient, bucketName }) => {
      const minioEndpoint = storageClient.bucketUrl.replace(`/${bucketName}`, '');

      const pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('provenance_test')
        .withUsername('test')
        .withPassword('test')
        .start();
      const connStr = pgContainer.getConnectionUri();
      const dbSql = postgres(connStr, { max: 5 });
      const db = drizzle(dbSql, { schema }) as DrizzleDb;
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      _testDb = db;
      _resetConfigForTest();
      _resetLoggerForTest();
      await _resetDbForTest();
      _setConfigForTest(
        parseEnv(
          makeTestEnv({
            minioEndpoint: minioEndpoint,
            minioBucket: bucketName,
          }),
        ),
      );

      try {
        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const student = await seedRosterEntry(db, semester.id, '123456');
        const job = await seedIngestJob(db, semester.id, user.id);

        const ingestFileId = crypto.randomUUID();
        // Bundle is built with assignmentId='hw01' in the manifest.
        const bundleAssignmentId = 'hw01';
        const { blobSha256 } = await stageTestBundle(
          storageClient,
          job.id,
          ingestFileId,
          bundleAssignmentId,
        );

        await db.insert(ingest_files).values({
          id: ingestFileId,
          ingest_job_id: job.id,
          original_filename: `${bundleAssignmentId}-123456.zip`,
          size_bytes: 1024,
          blob_sha256: blobSha256,
          status: 'unmatched',
          error: { phase: 'match_student', cause: 'unknown_sid' },
          resolved_at: new Date(),
        });

        const app = createV1App();
        // Admin supplies a DIFFERENT assignment_id_str than the bundle manifest.
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/unmatched/${ingestFileId}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              student_id: student.id,
              assignment_id_str: 'hw02', // Disagrees with bundle manifest 'hw01'
            }),
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, unknown>;
        expect(body['status']).toBe('matched');
        const warnings = body['warnings'] as Array<{ code: string }>;
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.code).toBe('ASSIGNMENT_ID_MISMATCH_BUNDLE');
      } finally {
        _testDb = null;
        _resetConfigForTest();
        _resetLoggerForTest();
        await _resetDbForTest();
        await dbSql.end();
        await pgContainer.stop();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// §3b. PATCH attach — error cases (DB only, no real bundle needed)
// ---------------------------------------------------------------------------

describe('PATCH /unmatched/:id — error cases', () => {
  it('returns 409 INGEST_FILE_NOT_UNMATCHED when file is already matched', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const student = await seedRosterEntry(db, semester.id);
      const job = await seedIngestJob(db, semester.id, user.id);

      // Create a file in 'matched' status.
      const [file] = await db
        .insert(ingest_files)
        .values({
          ingest_job_id: job.id,
          original_filename: 'hw01-123456.zip',
          size_bytes: 1024,
          blob_sha256: `sha256-${crypto.randomUUID()}`,
          status: 'matched',
        })
        .returning();

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/unmatched/${file!.id}`, {
          method: 'PATCH',
          headers: {
            Cookie: `__Host-prov_sess=${sessionId}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            student_id: student.id,
            assignment_id_str: 'hw01',
          }),
        }),
      );

      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INGEST_FILE_NOT_UNMATCHED');
    });
  });

  it('returns 404 ROSTER_ENTRY_NOT_FOUND when student is not in this semester', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const job = await seedIngestJob(db, semester.id, user.id);
      const file = await seedUnmatchedFile(db, job.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/unmatched/${file.id}`, {
          method: 'PATCH',
          headers: {
            Cookie: `__Host-prov_sess=${sessionId}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            student_id: crypto.randomUUID(), // Doesn't exist in roster
            assignment_id_str: 'hw01',
          }),
        }),
      );

      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('ROSTER_ENTRY_NOT_FOUND');
    });
  });
});

// ---------------------------------------------------------------------------
// §4. Concurrent attach — V21 concurrency test
//
// Two PATCH requests fired simultaneously for the same ingestFileId.
// Exactly one must succeed with 200; the other must get 409.
// The FOR UPDATE lock in attachUnmatchedFile.step1 enforces this.
// ---------------------------------------------------------------------------

describe('PATCH /unmatched/:id — concurrent attach (V21)', () => {
  it('exactly one succeeds and one gets 409 when two requests race', async () => {
    await withTestMinio(async ({ client: storageClient, bucketName }) => {
      const pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
        .withDatabase('provenance_test')
        .withUsername('test')
        .withPassword('test')
        .start();
      const connStr = pgContainer.getConnectionUri();
      // Use pool size > 1 so both transactions can run concurrently.
      const dbSql = postgres(connStr, { max: 5 });
      const db = drizzle(dbSql, { schema }) as DrizzleDb;
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      _testDb = db;
      _resetConfigForTest();
      _resetLoggerForTest();
      await _resetDbForTest();

      const minioEndpoint = storageClient.bucketUrl.replace(`/${bucketName}`, '');

      _setConfigForTest(
        parseEnv(
          makeTestEnv({
            minioEndpoint,
            minioBucket: bucketName,
          }),
        ),
      );

      try {
        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const student = await seedRosterEntry(db, semester.id, '123456');
        const job = await seedIngestJob(db, semester.id, user.id);

        const ingestFileId = crypto.randomUUID();
        const { blobSha256 } = await stageTestBundle(storageClient, job.id, ingestFileId, 'hw01');

        await db.insert(ingest_files).values({
          id: ingestFileId,
          ingest_job_id: job.id,
          original_filename: 'hw01-123456.zip',
          size_bytes: 1024,
          blob_sha256: blobSha256,
          status: 'unmatched',
          error: { phase: 'match_student', cause: 'unknown_sid' },
          resolved_at: new Date(),
        });

        const app = createV1App();
        const makeAttachRequest = () =>
          app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/unmatched/${ingestFileId}`, {
              method: 'PATCH',
              headers: {
                Cookie: `__Host-prov_sess=${sessionId}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                student_id: student.id,
                assignment_id_str: 'hw01',
              }),
            }),
          );

        // Fire both requests simultaneously.
        const [res1, res2] = await Promise.all([makeAttachRequest(), makeAttachRequest()]);

        const statuses = [res1.status, res2.status].sort();

        // Exactly one 200, one 409.
        expect(statuses).toEqual([200, 409]);

        // The 409 response must carry INGEST_FILE_NOT_UNMATCHED code.
        const failedRes = res1.status === 409 ? res1 : res2;
        const failedBody = (await failedRes.json()) as { error: { code: string } };
        expect(failedBody.error.code).toBe('INGEST_FILE_NOT_UNMATCHED');

        // After both settle, the file must be in 'matched' state (only one submission).
        const [fileRow] = await db
          .select({ status: ingest_files.status })
          .from(ingest_files)
          .where(eq(ingest_files.id, ingestFileId));
        expect(fileRow!.status).toBe('matched');

        // Only one submission row must exist for this semester/student.
        const subs = await db
          .select({ id: submissions.id })
          .from(submissions)
          .where(eq(submissions.student_id, student.id));
        expect(subs).toHaveLength(1);
      } finally {
        _testDb = null;
        _resetConfigForTest();
        _resetLoggerForTest();
        await _resetDbForTest();
        await dbSql.end();
        await pgContainer.stop();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// §5. Protected mode — filename and matched_student masking
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/unmatched — protected mode', () => {
  it('masks original_filename and matched_student when user is protected', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      // Protected user
      const user = await seedUser(db, { protected: true });
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const job = await seedIngestJob(db, semester.id, user.id);

      // Seed a roster entry with a real name and protected_index
      const [student] = await db
        .insert(roster_entries)
        .values({
          semester_id: semester.id,
          sid: '123456',
          display_name: 'Chan Alice',
          protected_index: 3,
        })
        .returning();

      // Seed a matched file with a name-bearing filename
      const [file] = await db
        .insert(ingest_files)
        .values({
          ingest_job_id: job.id,
          original_filename: 'chan_alice_lab03.zip',
          size_bytes: 1024,
          blob_sha256: `sha256-${crypto.randomUUID()}`,
          status: 'unmatched',
          matched_student_id: student!.id,
        })
        .returning();
      expect(file).toBeDefined();

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/unmatched`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{
          original_filename: string;
          matched_student?: { display_name: string; sid: string };
          filename_capture?: unknown;
        }>;
      };
      expect(body.items).toHaveLength(1);
      const item = body.items[0]!;

      // filename must not contain real name tokens
      expect(item.original_filename).not.toMatch(/chan|alice/i);
      expect(item.original_filename).toMatch(/Student 3/);

      // matched_student must be masked
      expect(item.matched_student).toBeDefined();
      expect(item.matched_student!.display_name).toMatch(/^Student \d+$/);
      expect(item.matched_student!.sid).toBe('S3');

      // filename_capture must be absent in protected mode
      expect(item.filename_capture).toBeUndefined();
    });
  });

  it('returns real filename and matched_student when user is NOT protected', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db, { protected: false });
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const job = await seedIngestJob(db, semester.id, user.id);

      const [student] = await db
        .insert(roster_entries)
        .values({
          semester_id: semester.id,
          sid: '123456',
          display_name: 'Chan Alice',
          protected_index: 3,
        })
        .returning();

      const [file] = await db
        .insert(ingest_files)
        .values({
          ingest_job_id: job.id,
          original_filename: 'chan_alice_lab03.zip',
          size_bytes: 1024,
          blob_sha256: `sha256-${crypto.randomUUID()}`,
          status: 'unmatched',
          matched_student_id: student!.id,
        })
        .returning();
      expect(file).toBeDefined();

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester.id}/unmatched`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{
          original_filename: string;
          matched_student?: { display_name: string; sid: string };
        }>;
      };
      expect(body.items).toHaveLength(1);
      const item = body.items[0]!;

      // Real values must appear
      expect(item.original_filename).toBe('chan_alice_lab03.zip');
      expect(item.matched_student).toBeDefined();
      expect(item.matched_student!.display_name).toBe('Chan Alice');
      expect(item.matched_student!.sid).toBe('123456');
    });
  });
});
