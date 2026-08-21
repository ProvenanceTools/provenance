/**
 * Ingest routes integration tests (Phase 9a).
 *
 * Tests all ingest endpoints through createV1App() per V18 rule.
 * Both Postgres (withTestDb) and MinIO (withTestMinio) containers are required.
 * The route handler reads storage config from getConfig(), so we wire the test
 * MinIO endpoint into _setConfigForTest().
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../../test/helpers/db.js';
import { withTestMinio } from '../../../../test/helpers/minio.js';

// ---------------------------------------------------------------------------
// Mock pg-boss so POST /ingest doesn't require a real pg-boss connection.
// The ingest route calls getBoss() after staging to enqueue ingest_file jobs.
// In unit/integration tests we verify the DB state; actual job execution is
// covered by worker tests elsewhere.
// ---------------------------------------------------------------------------
vi.mock('../../../jobs/pg-boss.js', () => ({
  getBoss: vi.fn().mockResolvedValue({
    send: vi.fn().mockResolvedValue(null),
    insert: vi.fn().mockResolvedValue(null),
    work: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  stopBoss: vi.fn().mockResolvedValue(undefined),
  JOB_KINDS: {
    INGEST_FILE: 'ingest_file',
    INGEST_FINALIZE: 'ingest_finalize',
  },
  _resetBossForTest: vi.fn(),
}));
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
  ingest_jobs,
  ingest_files,
  assignments,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

async function seedUser(db: DrizzleDb, overrides?: Partial<typeof users.$inferInsert>) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: `user-${id}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: false,
      protected: false,
      ...overrides,
    })
    .returning();
  return user!;
}

async function seedSession(
  db: DrizzleDb,
  userId: string,
  expiresAt: Date = new Date(Date.now() + 14 * 86400_000),
): Promise<string> {
  const id = `sess-${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 43);
  await db.insert(sessions).values({ id, user_id: userId, expires_at: expiresAt });
  return id;
}

async function seedCourseAndSemester(db: DrizzleDb) {
  const slug = `cs61a-${crypto.randomUUID().slice(0, 8)}`;
  const [course] = await db.insert(courses).values({ name: 'CS 61A', slug }).returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `fa2024-${crypto.randomUUID().slice(0, 8)}`,
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
  await db
    .insert(memberships)
    .values({ user_id: userId, semester_id: semesterId, role, granted_by: userId });
}

async function seedRosterEntry(
  db: DrizzleDb,
  semesterId: string,
  opts?: { sid?: string; display_name?: string; protected_index?: number },
) {
  const [entry] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: opts?.sid ?? `stu-${crypto.randomUUID().slice(0, 8)}`,
      display_name: opts?.display_name ?? 'Test Student',
      protected_index: opts?.protected_index ?? null,
    })
    .returning();
  return entry!;
}

// ---------------------------------------------------------------------------
// Test env builder (includes MinIO endpoint)
// ---------------------------------------------------------------------------

function makeTestEnv(minioEndpoint: string, minioBucket: string): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance', // overridden by mock
    OBJECT_STORAGE_ENDPOINT: minioEndpoint,
    OBJECT_STORAGE_BUCKET: minioBucket,
    OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-ingest-tests-123456789',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

function makeZipBytes(_filename = 'test.zip'): Uint8Array {
  // Minimal valid zip: just a tiny zip with a text file inside.
  // For 9a testing we don't need real bundle content — just valid bytes.
  // We use a hard-coded minimal zip (PKZIP end-of-central-directory record).
  // Empty zip: PK\x05\x06 + 18 zero bytes = 22 bytes.
  const emptyZip = new Uint8Array([
    0x50,
    0x4b,
    0x05,
    0x06, // end of central directory signature
    0x00,
    0x00, // disk number
    0x00,
    0x00, // disk with start of central directory
    0x00,
    0x00, // number of entries on this disk
    0x00,
    0x00, // total number of entries
    0x00,
    0x00,
    0x00,
    0x00, // size of central directory
    0x00,
    0x00,
    0x00,
    0x00, // offset of start of central directory
    0x00,
    0x00, // comment length
  ]);
  return emptyZip;
}

function makeMultipartRequest(
  url: string,
  sessionId: string,
  files: Array<{ field: string; name: string; bytes: Uint8Array }>,
): Request {
  const formData = new FormData();
  for (const f of files) {
    formData.append(
      f.field,
      new Blob([f.bytes.buffer as ArrayBuffer], { type: 'application/zip' }),
      f.name,
    );
  }
  return new Request(url, {
    method: 'POST',
    headers: { Cookie: `__Host-prov_sess=${sessionId}` },
    body: formData,
  });
}

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/ingest — happy paths
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/ingest', () => {
  it('returns 202 with job_id when staging multiple files', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [
              { field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes },
              { field: 'files[]', name: 'hw01-789012.zip', bytes: zipBytes },
            ],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(202);
          const body = (await res.json()) as { job_id: string };
          expect(body.job_id).toBeTruthy();

          // Verify ingest_jobs row.
          const jobs = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, body.job_id));
          expect(jobs).toHaveLength(1);
          expect(jobs[0]!.status).toBe('queued');
          expect(jobs[0]!.semester_id).toBe(semester.id);

          // Verify 2 ingest_files rows.
          const files = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, body.job_id));
          expect(files).toHaveLength(2);
          expect(files.every((f) => f.status === 'pending')).toBe(true);
          expect(files.every((f) => f.blob_sha256 !== '')).toBe(true);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 202 and stages blobs in MinIO', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'hw01-111111.zip', bytes: zipBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(202);
          const { job_id } = (await res.json()) as { job_id: string };

          // Verify blob exists in MinIO by retrieving ingest_files row and checking the staging key.
          const [fileRow] = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, job_id));
          expect(fileRow).toBeDefined();

          // Verify the blob is retrievable from MinIO.
          const { getBlob } = await import('../../../services/storage/blobs.js');
          const { ingestStagingKey } = await import('../../../services/storage/keys.js');
          const key = ingestStagingKey(job_id, fileRow!.id);
          const stream = await getBlob(client, key);
          // Just check it's a ReadableStream (blob is present).
          expect(stream).toBeInstanceOf(ReadableStream);
          // Cancel the stream to avoid resource leak.
          await stream.cancel();
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('expands zip-of-zips and stages each inner .zip', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          // Build a zip-of-zips archive.
          const innerZip1 = makeZipBytes('inner1.zip');
          const innerZip2 = makeZipBytes('inner2.zip');

          const outerZip = new JSZip();
          outerZip.file('student1.zip', innerZip1);
          outerZip.file('student2.zip', innerZip2);
          const outerBytes = await outerZip.generateAsync({ type: 'uint8array' });

          const app = createV1App();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'archive', name: 'batch.zip', bytes: outerBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(202);
          const { job_id } = (await res.json()) as { job_id: string };

          // Should have 2 ingest_files rows (one per inner zip).
          const files = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, job_id));
          expect(files).toHaveLength(2);
          expect(files.every((f) => f.status === 'pending')).toBe(true);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('creates audit row for ingest.start', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'hw01-555555.zip', bytes: zipBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(202);
          const { job_id } = (await res.json()) as { job_id: string };

          // Wait for fire-and-forget audit insert.
          const auditRow = await waitForAuditRow(db, 'ingest.start', job_id);
          expect(auditRow).toBeDefined();
          expect(auditRow!.action).toBe('ingest.start');
          expect(auditRow!.target_type).toBe('ingest_job');
          expect(auditRow!.target_id).toBe(job_id);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  // -----------------------------------------------------------------------
  // Error cases
  // -----------------------------------------------------------------------

  it('returns 422 ROSTER_REQUIRED when semester has no roster entries', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          // No roster entries.

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(422);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('ROSTER_REQUIRED');
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 413 INGEST_BATCH_TOO_LARGE on oversize Content-Length', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          // Set a very small max batch size.
          _setConfigForTest(
            parseEnv({
              ...makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName),
              INGEST_MAX_BATCH_BYTES: '100',
            }),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          // Send a Content-Length that exceeds the tiny cap.
          const req = new Request(`http://localhost/semesters/${semester.id}/ingest`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'Content-Length': '999999',
              'Content-Type': 'multipart/form-data; boundary=----boundary',
            },
            body: '----boundary\r\nContent-Disposition: form-data; name="files[]"; filename="a.zip"\r\n\r\ndata\r\n----boundary--',
          });

          const res = await app.fetch(req);
          expect(res.status).toBe(413);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('INGEST_BATCH_TOO_LARGE');
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 413 INGEST_FILE_TOO_LARGE on oversize individual file', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          // Very small per-file cap.
          _setConfigForTest(
            parseEnv({
              ...makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName),
              INGEST_MAX_BUNDLE_BYTES: '10',
            }),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const bigBytes = new Uint8Array(100).fill(0xff); // 100 bytes > 10 byte cap
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'big.zip', bytes: bigBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(413);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('INGEST_FILE_TOO_LARGE');
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 400 INGEST_TOO_MANY_FILES when file count exceeds cap', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv({
              ...makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName),
              INGEST_MAX_BATCH_FILES: '1',
            }),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [
              { field: 'files[]', name: 'hw01-111111.zip', bytes: zipBytes },
              { field: 'files[]', name: 'hw01-222222.zip', bytes: zipBytes },
            ],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(400);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('INGEST_TOO_MANY_FILES');
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 401 for unauthenticated requests', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const { semester } = await seedCourseAndSemester(db);
          const app = createV1App();

          const res = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest`, {
              method: 'POST',
            }),
          );
          expect(res.status).toBe(401);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 403 for grader (non-admin) role', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const grader = await seedUser(db);
          const sessionId = await seedSession(db, grader.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, grader.id, semester.id, 'grader');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const req = makeMultipartRequest(
            `http://localhost/semesters/${semester.id}/ingest`,
            sessionId,
            [{ field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes }],
          );

          const res = await app.fetch(req);
          expect(res.status).toBe(403);
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// GET /semesters/:semesterId/ingest/jobs
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/ingest/jobs', () => {
  it('returns paginated job list for a semester member', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          // Create 3 jobs via the POST endpoint.
          const app = createV1App();
          const zipBytes = makeZipBytes();

          for (let i = 0; i < 3; i++) {
            const req = makeMultipartRequest(
              `http://localhost/semesters/${semester.id}/ingest`,
              sessionId,
              [{ field: 'files[]', name: `hw0${i}-123456.zip`, bytes: zipBytes }],
            );
            const res = await app.fetch(req);
            expect(res.status).toBe(202);
          }

          // List with limit=2.
          const listRes = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs?limit=2`, {
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            }),
          );
          expect(listRes.status).toBe(200);
          const body = (await listRes.json()) as { items: unknown[]; next_cursor: string | null };
          expect(body.items).toHaveLength(2);
          expect(body.next_cursor).toBeTruthy();

          // Get next page.
          const page2Res = await app.fetch(
            new Request(
              `http://localhost/semesters/${semester.id}/ingest/jobs?limit=2&cursor=${body.next_cursor}`,
              { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
            ),
          );
          expect(page2Res.status).toBe(200);
          const body2 = (await page2Res.json()) as { items: unknown[]; next_cursor: string | null };
          expect(body2.items).toHaveLength(1);
          expect(body2.next_cursor).toBeNull();
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/ingest/jobs/:jobId/cancel
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/ingest/jobs/:jobId/cancel', () => {
  it('cancels a queued job and creates an audit row', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();

          // Create a job.
          const postRes = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes },
            ]),
          );
          expect(postRes.status).toBe(202);
          const { job_id } = (await postRes.json()) as { job_id: string };

          // Cancel it.
          const cancelRes = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs/${job_id}/cancel`, {
              method: 'POST',
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            }),
          );
          expect(cancelRes.status).toBe(202);
          const cancelBody = (await cancelRes.json()) as {
            ok: boolean;
            cancelled: boolean;
            previous_status: string;
          };
          expect(cancelBody.ok).toBe(true);
          expect(cancelBody.cancelled).toBe(true);
          expect(cancelBody.previous_status).toBe('queued');

          // Verify DB status.
          const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, job_id));
          expect(job!.status).toBe('cancelled');

          // Verify audit.
          const auditRow = await waitForAuditRow(db, 'ingest.cancel', job_id);
          expect(auditRow).toBeDefined();
          expect(auditRow!.action).toBe('ingest.cancel');
          expect(auditRow!.target_id).toBe(job_id);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 404 for non-existent job', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');

          const app = createV1App();
          const nonExistent = crypto.randomUUID();
          const res = await app.fetch(
            new Request(
              `http://localhost/semesters/${semester.id}/ingest/jobs/${nonExistent}/cancel`,
              {
                method: 'POST',
                headers: { Cookie: `__Host-prov_sess=${sessionId}` },
              },
            ),
          );
          expect(res.status).toBe(404);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns 409 INGEST_JOB_NOT_CANCELLABLE when job is already terminal (Important 4)', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          const app = createV1App();
          const zipBytes = makeZipBytes();

          // Create a job.
          const postRes = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'files[]', name: 'hw01-123456.zip', bytes: zipBytes },
            ]),
          );
          expect(postRes.status).toBe(202);
          const { job_id } = (await postRes.json()) as { job_id: string };

          // Force the job into 'failed' state directly in the DB.
          const { failIngestJob } = await import('../../../services/ingest/job-control.js');
          await failIngestJob(db, job_id, 'forced terminal for test');

          // Attempt to cancel the terminal job.
          const cancelRes = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs/${job_id}/cancel`, {
              method: 'POST',
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            }),
          );
          expect(cancelRes.status).toBe(409);
          const body = (await cancelRes.json()) as {
            error: { code: string; details: { previous_status: string } };
          };
          expect(body.error.code).toBe('INGEST_JOB_NOT_CANCELLABLE');
          expect(body.error.details.previous_status).toBe('failed');
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: Critical 1 — orphaned ingest_jobs row when staging fails
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/ingest — staging failure compensation (Critical 1)', () => {
  it('marks job failed (not orphaned as queued) and writes no rows when stageBlob throws on second file', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          // Inject a faulty stageBlob that succeeds on call 1, throws on call 2.
          const stageBlobModule = await import('../../../services/ingest/stage-blob.js');
          let callCount = 0;
          const originalStageBlob = stageBlobModule.stageBlob;
          const spy = vi
            .spyOn(stageBlobModule, 'stageBlob')
            .mockImplementation(async (...args: Parameters<typeof stageBlobModule.stageBlob>) => {
              callCount++;
              if (callCount === 2) {
                throw new Error('simulated MinIO failure on file 2');
              }
              return originalStageBlob(...args);
            });

          const app = createV1App();
          const zipBytes = makeZipBytes();
          const res = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'files[]', name: 'hw01-111111.zip', bytes: zipBytes },
              { field: 'files[]', name: 'hw01-222222.zip', bytes: zipBytes },
            ]),
          );

          spy.mockRestore();

          // Route should return 500 (unhandled staging error re-thrown).
          expect(res.status).toBe(500);

          // The ingest_jobs row must exist and be status='failed' (not 'queued').
          const jobs = await db
            .select()
            .from(ingest_jobs)
            .where(eq(ingest_jobs.semester_id, semester.id));
          expect(jobs).toHaveLength(1);
          expect(jobs[0]!.status).toBe('failed');

          // No ingest_files rows: rows are bulk-inserted only after ALL staging
          // succeeds, so a mid-staging failure leaves zero rows (the file-1 blob
          // staged to MinIO is an orphan the retention sweep reclaims).
          const files = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, jobs[0]!.id));
          expect(files).toHaveLength(0);
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: Critical 2 — zip-of-zips total-uncompressed cap (zip-bomb guard)
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/ingest — zip-bomb guard (Critical 2)', () => {
  it('returns 413 INGEST_BATCH_TOO_LARGE when outer zip decompresses beyond batch cap', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          // Set a small batch cap so we can craft a test zip without actual large data.
          _setConfigForTest(
            parseEnv({
              ...makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName),
              INGEST_MAX_BATCH_BYTES: '100',
              INGEST_MAX_BUNDLE_BYTES: '52428800',
            }),
          );
          const admin = await seedUser(db);
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');
          await seedRosterEntry(db, semester.id);

          // Build a zip-of-zips whose combined uncompressed size exceeds the 100-byte cap.
          // Each inner entry is a small but compressible payload > 50 bytes uncompressed.
          const inner1 = new Uint8Array(60).fill(0x41);
          const inner2 = new Uint8Array(60).fill(0x42);

          const innerZip1 = new JSZip();
          innerZip1.file('data.txt', inner1);
          const inner1Bytes = await innerZip1.generateAsync({ type: 'uint8array' });

          const innerZip2 = new JSZip();
          innerZip2.file('data.txt', inner2);
          const inner2Bytes = await innerZip2.generateAsync({ type: 'uint8array' });

          // The outer zip holds two inner .zip files.
          // When expanded, total uncompressed = inner1Bytes + inner2Bytes > 100 bytes.
          const outerZip = new JSZip();
          outerZip.file('student1.zip', inner1Bytes);
          outerZip.file('student2.zip', inner2Bytes);
          const outerBytes = await outerZip.generateAsync({ type: 'uint8array' });

          const app = createV1App();
          const res = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'archive', name: 'batch.zip', bytes: outerBytes },
            ]),
          );

          expect(res.status).toBe(413);
          const body = (await res.json()) as { error: { code: string } };
          expect(body.error.code).toBe('INGEST_BATCH_TOO_LARGE');
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Protected mode — job detail and files listing masking
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/ingest/jobs/:jobId — protected mode', () => {
  it('masks original_filename and matched_student when user is protected', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );

          // Protected user
          const admin = await seedUser(db, { protected: true });
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');

          // Seed a roster entry with a real name
          const student = await seedRosterEntry(db, semester.id, {
            sid: '123456',
            display_name: 'Chan Alice',
            protected_index: 5,
          });

          // Create a job directly
          const [job] = await db
            .insert(ingest_jobs)
            .values({ semester_id: semester.id, uploaded_by: admin.id, status: 'running' })
            .returning();

          // Seed a matched file with a name-bearing filename
          await db.insert(ingest_files).values({
            ingest_job_id: job!.id,
            original_filename: 'chan_alice_lab03.zip',
            size_bytes: 1024,
            blob_sha256: `sha256-${crypto.randomUUID()}`,
            status: 'matched',
            matched_student_id: student.id,
          });

          const app = createV1App();
          const res = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs/${job!.id}`, {
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            files: Array<{
              original_filename: string;
              matched_student?: { display_name: string; sid: string };
              filename_capture?: unknown;
            }>;
          };
          expect(body.files).toHaveLength(1);
          const file = body.files[0]!;

          // filename must not contain real name tokens
          expect(file.original_filename).not.toMatch(/chan|alice/i);
          expect(file.original_filename).toMatch(/Student 5/);

          // matched_student must be masked
          expect(file.matched_student).toBeDefined();
          expect(file.matched_student!.display_name).toMatch(/^Student \d+$/);
          expect(file.matched_student!.sid).toBe('S5');

          // filename_capture must be absent in protected mode
          expect(file.filename_capture).toBeUndefined();
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns real filename and matched_student when user is NOT protected (job detail)', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );

          const admin = await seedUser(db, { protected: false });
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');

          const student = await seedRosterEntry(db, semester.id, {
            sid: '123456',
            display_name: 'Chan Alice',
            protected_index: 5,
          });

          const [job] = await db
            .insert(ingest_jobs)
            .values({ semester_id: semester.id, uploaded_by: admin.id, status: 'running' })
            .returning();

          await db.insert(ingest_files).values({
            ingest_job_id: job!.id,
            original_filename: 'chan_alice_lab03.zip',
            size_bytes: 1024,
            blob_sha256: `sha256-${crypto.randomUUID()}`,
            status: 'matched',
            matched_student_id: student.id,
          });

          const app = createV1App();
          const res = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs/${job!.id}`, {
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            }),
          );

          expect(res.status).toBe(200);
          const body = (await res.json()) as {
            files: Array<{
              original_filename: string;
              matched_student?: { display_name: string; sid: string };
            }>;
          };
          expect(body.files).toHaveLength(1);
          const file = body.files[0]!;

          // Real values must appear
          expect(file.original_filename).toBe('chan_alice_lab03.zip');
          expect(file.matched_student).toBeDefined();
          expect(file.matched_student!.display_name).toBe('Chan Alice');
          expect(file.matched_student!.sid).toBe('123456');
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

describe('GET /semesters/:semesterId/ingest/jobs/:jobId/files — protected mode', () => {
  it('masks filenames and matched_student in files listing when protected', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );

          const admin = await seedUser(db, { protected: true });
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');

          const student = await seedRosterEntry(db, semester.id, {
            sid: '123456',
            display_name: 'Chan Alice',
            protected_index: 7,
          });

          const [job] = await db
            .insert(ingest_jobs)
            .values({ semester_id: semester.id, uploaded_by: admin.id, status: 'running' })
            .returning();

          await db.insert(ingest_files).values({
            ingest_job_id: job!.id,
            original_filename: 'chan_alice_lab03.zip',
            size_bytes: 1024,
            blob_sha256: `sha256-${crypto.randomUUID()}`,
            status: 'matched',
            matched_student_id: student.id,
          });

          const app = createV1App();
          const res = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs/${job!.id}/files`, {
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

          expect(item.original_filename).not.toMatch(/chan|alice/i);
          expect(item.original_filename).toMatch(/Student 7/);
          expect(item.matched_student).toBeDefined();
          expect(item.matched_student!.display_name).toMatch(/^Student \d+$/);
          expect(item.matched_student!.sid).toBe('S7');
          expect(item.filename_capture).toBeUndefined();
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('returns real values in files listing when NOT protected', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );

          const admin = await seedUser(db, { protected: false });
          const sessionId = await seedSession(db, admin.id);
          const { semester } = await seedCourseAndSemester(db);
          await seedMembership(db, admin.id, semester.id, 'admin');

          const student = await seedRosterEntry(db, semester.id, {
            sid: '123456',
            display_name: 'Chan Alice',
            protected_index: 7,
          });

          const [job] = await db
            .insert(ingest_jobs)
            .values({ semester_id: semester.id, uploaded_by: admin.id, status: 'running' })
            .returning();

          await db.insert(ingest_files).values({
            ingest_job_id: job!.id,
            original_filename: 'chan_alice_lab03.zip',
            size_bytes: 1024,
            blob_sha256: `sha256-${crypto.randomUUID()}`,
            status: 'matched',
            matched_student_id: student.id,
          });

          const app = createV1App();
          const res = await app.fetch(
            new Request(`http://localhost/semesters/${semester.id}/ingest/jobs/${job!.id}/files`, {
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

          expect(item.original_filename).toBe('chan_alice_lab03.zip');
          expect(item.matched_student).toBeDefined();
          expect(item.matched_student!.display_name).toBe('Chan Alice');
          expect(item.matched_student!.sid).toBe('123456');
        } finally {
          _testDb = null;
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/ingest — scope awareness (program architecture §6)
//
// This route was the only one of the three ingest entry points with no scope
// handling at all: a git repo zip fell through to the "one bundle" branch and
// was staged whole, silently, on the path staff reach for when the automated
// path has already gone wrong. These tests cover the two directions that
// matter — the shapes it already handled must be untouched, and a repo zip must
// now fan out — plus the per-request override and legible failure.
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/ingest — declared submission types', () => {
  /** Lay one sealed bundle's files under `prefix`, `.provenance/`-nested. */
  async function layScope(
    files: Map<string, Uint8Array>,
    prefix: string,
    assignmentId: string,
  ): Promise<void> {
    const { buildTestBundle } =
      await import('@provenance/analysis-core/test-support/build-test-bundle.js');
    const { zipBuffer } = await buildTestBundle({
      assignmentId,
      semester: 'fa2026',
      sessions: [{ eventCount: 3 }],
      submissionFiles: [
        { path: 'Main.java', status: 'present', content: `class Main {} // ${assignmentId}\n` },
      ],
    });
    const provenanceFile =
      /^(manifest\.json|manifest\.sig|manifest-[0-9a-f-]+\.(json|sig)|session-.*\.slog(\.meta)?)$/;
    const inner = await JSZip.loadAsync(zipBuffer);
    for (const [name, obj] of Object.entries(inner.files)) {
      if (obj.dir) continue;
      const bytes = await obj.async('uint8array');
      files.set(
        provenanceFile.test(name) ? `${prefix}.provenance/${name}` : `${prefix}${name}`,
        bytes,
      );
    }
  }

  async function zipTree(files: Map<string, Uint8Array>): Promise<Uint8Array> {
    const zip = new JSZip();
    for (const [name, bytes] of files) zip.file(name, bytes);
    return zip.generateAsync({ type: 'uint8array' });
  }

  /** A repo whose root is sealed as `hw10`, with a nested `lab5` scope. */
  async function repoRootedZip(): Promise<Uint8Array> {
    const files = new Map<string, Uint8Array>();
    await layScope(files, '', 'hw10');
    await layScope(files, 'vendor/', 'lab5');
    files.set('README.md', new TextEncoder().encode('# repo\n'));
    return zipTree(files);
  }

  async function seedAll(db: DrizzleDb) {
    const admin = await seedUser(db);
    const sessionId = await seedSession(db, admin.id);
    const { semester } = await seedCourseAndSemester(db);
    await seedMembership(db, admin.id, semester.id, 'admin');
    await seedRosterEntry(db, semester.id);
    return { sessionId, semester };
  }

  it('fans a git repo zip out into one ingest_files row per scope', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const { sessionId, semester } = await seedAll(db);

          const app = createV1App();
          const res = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'files[]', name: 'repo.zip', bytes: await repoRootedZip() },
            ]),
          );
          expect(res.status).toBe(202);
          const body = (await res.json()) as { job_id: string; skipped: unknown[] };

          const files = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, body.job_id));
          // Before this change the whole repo staged as ONE malformed bundle.
          expect(files).toHaveLength(2);
          expect(files.map((f) => f.original_filename).sort()).toEqual([
            'repo.zip',
            'repo/vendor.zip',
          ]);

          // Nothing was skipped, and `[]` says so positively — both inline and
          // on the job row, which is what makes GET /ingest/jobs/:id agree.
          expect(body.skipped).toEqual([]);
          const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, body.job_id));
          expect(job!.skipped).toEqual([]);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('a per-request override beats the assignment default', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const { sessionId, semester } = await seedAll(db);
          // The persisted default for `hw10` says "this repo is ONE submission".
          await db.insert(assignments).values({
            semester_id: semester.id,
            assignment_id_str: 'hw10',
            label: 'HW 10',
            ingest_scope: { mode: 'repo_whole', on_multiple: 'ingest_all' },
          });

          const app = createV1App();
          const zipBytes = await repoRootedZip();

          // No override → the persisted default applies: root only, nested
          // scope excluded by declaration rather than fanned out.
          const dflt = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'files[]', name: 'repo.zip', bytes: zipBytes },
            ]),
          );
          expect(dflt.status).toBe(202);
          const dfltBody = (await dflt.json()) as {
            job_id: string;
            skipped: Array<{ reason: string; scope_path?: string }>;
          };
          const dfltFiles = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, dfltBody.job_id));
          expect(dfltFiles.map((f) => f.original_filename)).toEqual(['repo.zip']);
          expect(dfltBody.skipped).toEqual([
            { folder_key: 'repo', scope_path: 'vendor/', reason: 'scope_excluded' },
          ]);

          // Same upload, same assignment row — the override wins.
          const over = await app.fetch(
            makeMultipartRequest(
              `http://localhost/semesters/${semester.id}/ingest?scope_mode=self_identifying`,
              sessionId,
              [{ field: 'files[]', name: 'repo.zip', bytes: zipBytes }],
            ),
          );
          expect(over.status).toBe(202);
          const overBody = (await over.json()) as { job_id: string; skipped: unknown[] };
          const overFiles = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, overBody.job_id));
          expect(overFiles.map((f) => f.original_filename).sort()).toEqual([
            'repo.zip',
            'repo/vendor.zip',
          ]);
          expect(overBody.skipped).toEqual([]);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('a heterogeneous batch fails legibly, through skipped and not a new channel', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const { sessionId, semester } = await seedAll(db);

          const app = createV1App();
          // The batch declares "flat sealed bundles"; it is handed a repo.
          const res = await app.fetch(
            makeMultipartRequest(
              `http://localhost/semesters/${semester.id}/ingest?scope_mode=bundle_zip`,
              sessionId,
              [{ field: 'files[]', name: 'repo.zip', bytes: await repoRootedZip() }],
            ),
          );
          expect(res.status).toBe(202);
          const body = (await res.json()) as {
            job_id: string;
            skipped: Array<{ reason: string }>;
          };
          expect(body.skipped.map((s) => s.reason)).toEqual([
            'submission_type_mismatch',
            'submission_type_mismatch',
          ]);

          // Nothing staged, and the job is settled rather than stuck at
          // 'queued' — no file job will ever run to finalize it.
          const files = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, body.job_id));
          expect(files).toHaveLength(0);
          const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, body.job_id));
          expect(job!.status).toBe('failed');
          // The reasons survive the failure — failIngestJob must not clobber
          // the only record that those scopes ever existed.
          expect((job!.skipped as Array<{ reason: string }>).map((s) => s.reason)).toEqual([
            'submission_type_mismatch',
            'submission_type_mismatch',
          ]);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('re-ingesting the same repo zip stages byte-identical blobs (idempotent)', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const { sessionId, semester } = await seedAll(db);
          const app = createV1App();
          const zipBytes = await repoRootedZip();

          const shas: string[][] = [];
          for (let i = 0; i < 2; i++) {
            const res = await app.fetch(
              makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
                { field: 'files[]', name: 'repo.zip', bytes: zipBytes },
              ]),
            );
            expect(res.status).toBe(202);
            const { job_id } = (await res.json()) as { job_id: string };
            const rows = await db
              .select()
              .from(ingest_files)
              .where(eq(ingest_files.ingest_job_id, job_id));
            shas.push(rows.map((r) => r.blob_sha256).sort());
          }
          // The staged sha256 is the dedup key. A rebuild that was not
          // deterministic would create a duplicate submission on every retry.
          expect(shas[0]).toEqual(shas[1]);
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('a flat sealed bundle stages the EXACT uploaded bytes — unchanged by this feature', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const { sessionId, semester } = await seedAll(db);
          const { buildTestBundle } =
            await import('@provenance/analysis-core/test-support/build-test-bundle.js');
          const { zipBuffer } = await buildTestBundle({
            assignmentId: 'hw10',
            sessions: [{ eventCount: 3 }],
          });
          const uploaded = new Uint8Array(zipBuffer);
          const { createHash } = await import('node:crypto');
          const expectedSha = createHash('sha256').update(uploaded).digest('hex');

          const app = createV1App();
          const res = await app.fetch(
            makeMultipartRequest(`http://localhost/semesters/${semester.id}/ingest`, sessionId, [
              { field: 'files[]', name: 'hw10-123456.zip', bytes: uploaded },
            ]),
          );
          expect(res.status).toBe(202);
          const { job_id } = (await res.json()) as { job_id: string };
          const rows = await db
            .select()
            .from(ingest_files)
            .where(eq(ingest_files.ingest_job_id, job_id));
          expect(rows).toHaveLength(1);
          // Byte-for-byte: the staged blob IS the upload. Never rebuilt.
          expect(rows[0]!.blob_sha256).toBe(expectedSha);
          expect(rows[0]!.original_filename).toBe('hw10-123456.zip');
        } finally {
          _testDb = null;
        }
      });
    });
  });

  it('rejects a scope_* override with no scope_mode rather than ignoring it', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client, bucketName }) => {
        _testDb = db;
        try {
          _setConfigForTest(
            parseEnv(makeTestEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName)),
          );
          const { sessionId, semester } = await seedAll(db);
          const app = createV1App();
          // A typo'd override that quietly did nothing is the failure this
          // whole feature exists to stop, so it is a 400 — same rule, same
          // schema, as POST /ingest:gradescope.
          const res = await app.fetch(
            makeMultipartRequest(
              `http://localhost/semesters/${semester.id}/ingest?scope_path_glob=proj2/**`,
              sessionId,
              [{ field: 'files[]', name: 'hw01-123456.zip', bytes: makeZipBytes() }],
            ),
          );
          expect(res.status).toBe(400);
        } finally {
          _testDb = null;
        }
      });
    });
  });
});
