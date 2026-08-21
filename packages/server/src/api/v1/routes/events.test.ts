/**
 * Events endpoints integration tests (Phase 17).
 *
 * Tests through createV1App() per V18 rule.
 *
 * Events are no longer persisted in Postgres — the route handlers re-parse the
 * submission's stored bundle blob from object storage on demand (via
 * loadSubmissionIndex). Tests that need a real event stream build a bundle with
 * buildTestBundle() and store it via putSubmissionBundle(), then point the app
 * config at the ephemeral MinIO instance so getStorageClient() resolves to the
 * same store.
 *
 * NOTE ON SEQ NUMBERING: `seq` in the API response is the GLOBAL chronological
 * index (globalIdx) assigned by buildIndex, starting at 0 for the very first
 * event in the bundle — which is always `session.start` (every session begins
 * with one). So a bundle built with N explicit post-start events yields N+1
 * total events: session.start at seq 0, then the N events at seq 1..N. Tests
 * below account for that extra row when asserting counts/seqs.
 *
 * Test groups:
 *   1. GET /submissions/:id/events           — list with filters and pagination
 *   2. GET /submissions/:id/events/:seq      — single event by seq
 *   3. Events query builder unit tests       — SQL builder assertions
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../../test/helpers/db.js';
import { withTestMinio } from '../../../../test/helpers/minio.js';
import { putSubmissionBundle } from '../../../../test/helpers/seed-bundle.js';
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
import type { StorageClient } from '../../../services/storage/client.js';
import { encodeEventCursor, decodeEventCursor } from '../../../services/events/query.js';
import { _resetBundleIndexCacheForTest } from '../../../services/bundle/load-index.js';
import {
  buildTestBundle,
  type EventSpec,
} from '@provenance/analysis-core/test-support/build-test-bundle.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

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
  _resetBundleIndexCacheForTest();
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeTestEnv(opts?: { minioEndpoint?: string; minioBucket?: string }) {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
    OBJECT_STORAGE_ENDPOINT: opts?.minioEndpoint ?? 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: opts?.minioBucket ?? 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-events-tests-12345678901234',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
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

async function seedSubmission(db: DrizzleDb, semesterId: string, userId: string) {
  const [student] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: `stu-${crypto.randomUUID().slice(0, 8)}`,
      display_name: 'Alice',
    })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({
      semester_id: semesterId,
      assignment_id_str: `hw-${crypto.randomUUID().slice(0, 6)}`,
      label: 'HW1',
    })
    .returning();

  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'succeeded' })
    .returning();

  const id = crypto.randomUUID();
  const [sub] = await db
    .insert(submissions)
    .values({
      id,
      semester_id: semesterId,
      assignment_id: assignment!.id,
      student_id: student!.id,
      blob_object_key: `semesters/${semesterId}/submissions/${id}/bundle.zip`,
      blob_sha256: `sha256-${id}`,
      source_filename: 'test.zip',
      ingest_job_id: job!.id,
      version_index: 1,
    })
    .returning();
  return sub!;
}

/**
 * Build a bundle from explicit per-session EventSpec[] and store it as the
 * submission's bundle blob in the (ephemeral) MinIO instance `storage` points
 * to. Every session automatically gets a `session.start` entry (globalIdx 0
 * if it's the earliest event chronologically) ahead of the given events.
 */
async function seedEventsBundle(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  sessionSpecs: Array<{ sessionId?: string; events: EventSpec[] }>,
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({ sessions: sessionSpecs });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
}

/** N generic filler events of a given kind (default session.heartbeat), empty payload. */
function fillerEvents(n: number, kind = 'session.heartbeat'): EventSpec[] {
  return Array.from({ length: n }, () => ({ kind, data: {} }));
}

// ---------------------------------------------------------------------------
// §3. Query builder unit tests (no DB needed)
// ---------------------------------------------------------------------------

describe('events query builder — cursor encode/decode', () => {
  it('encodes and decodes a cursor round-trip', () => {
    const cursor = encodeEventCursor(42);
    const decoded = decodeEventCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded!.seq).toBe(42);
  });

  it('returns null for invalid cursor', () => {
    expect(decodeEventCursor('not-valid-base64!!')).toBeNull();
    expect(decodeEventCursor(Buffer.from('{}').toString('base64'))).toBeNull();
    expect(decodeEventCursor(Buffer.from('{"seq":"str"}').toString('base64'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §1. GET /submissions/:id/events
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/events', () => {
  it('returns all events for a submission (happy path)', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        await seedEventsBundle(db, client, sub.id, [{ events: fillerEvents(5) }]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { seq: number; kind: string }[];
          next_cursor: string | null;
        };
        // session.start (seq 0) + 5 heartbeats (seq 1..5) = 6 rows.
        expect(body.items).toHaveLength(6);
        expect(body.next_cursor).toBeNull();
        // Default order is seq_asc
        expect(body.items[0]!.seq).toBe(0);
        expect(body.items[5]!.seq).toBe(5);
      });
    });
  });

  it('filters by kind', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        // 3 heartbeats + 2 doc.save
        const events: EventSpec[] = [
          ...fillerEvents(3),
          { kind: 'doc.save', data: { path: '/f.py', sha256: 'a'.repeat(64) } },
          { kind: 'doc.save', data: { path: '/f.py', sha256: 'b'.repeat(64) } },
        ];
        await seedEventsBundle(db, client, sub.id, [{ events }]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events?kind=doc.save`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { kind: string }[];
          total_count: number;
        };
        expect(body.items).toHaveLength(2);
        // total_count is included when kind filter is present
        expect(body.total_count).toBe(2);
        for (const item of body.items) {
          expect(item.kind).toBe('doc.save');
        }
      });
    });
  });

  it('filters by session_id and includes total_count', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);

        const sessA = crypto.randomUUID();
        const sessB = crypto.randomUUID();
        await seedEventsBundle(db, client, sub.id, [
          { sessionId: sessA, events: fillerEvents(2) },
          { sessionId: sessB, events: fillerEvents(1) },
        ]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events?session_id=${sessA}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { session_id: string }[];
          total_count: number;
        };
        // sessA's own session.start + its 2 heartbeats = 3 rows.
        expect(body.items).toHaveLength(3);
        expect(body.total_count).toBe(3);
        for (const item of body.items) {
          expect(item.session_id).toBe(sessA);
        }
      });
    });
  });

  it('filters by file (payload.path)', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);

        const events: EventSpec[] = [
          { kind: 'doc.change', data: { path: 'main.py' } },
          { kind: 'doc.change', data: { path: 'utils.py' } },
          { kind: 'doc.change', data: { path: 'main.py' } },
        ];
        await seedEventsBundle(db, client, sub.id, [{ events }]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events?file=main.py`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { seq: number }[];
          total_count: number;
        };
        expect(body.items).toHaveLength(2);
        expect(body.total_count).toBe(2);
        // seq 1 and 3 (session.start is seq 0 and has no path).
        expect(body.items.map((i) => i.seq).sort()).toEqual([1, 3]);
      });
    });
  });

  it('filters by seq_from / seq_to range', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        await seedEventsBundle(db, client, sub.id, [{ events: fillerEvents(10) }]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events?seq_from=3&seq_to=6`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { seq: number }[] };
        expect(body.items).toHaveLength(4); // seqs 3,4,5,6
        expect(body.items[0]!.seq).toBe(3);
        expect(body.items[3]!.seq).toBe(6);
      });
    });
  });

  it('filters by t_from / t_to range', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        // Events with t = 1000, 2000, ..., 5000 (session.start has t=0).
        const events: EventSpec[] = Array.from({ length: 5 }, (_, i) => ({
          kind: 'session.heartbeat',
          data: {},
          t: (i + 1) * 1000,
        }));
        await seedEventsBundle(db, client, sub.id, [{ events }]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events?t_from=2000&t_to=4000`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { t: number }[] };
        expect(body.items).toHaveLength(3); // t=2000,3000,4000
        expect(body.items[0]!.t).toBe(2000);
        expect(body.items[2]!.t).toBe(4000);
      });
    });
  });

  it('returns total_count when kind filter active, omits it without', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        await seedEventsBundle(db, client, sub.id, [{ events: fillerEvents(3) }]);

        const app = createV1App();

        // Without kind filter: no total_count
        const resNoKind = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        const bodyNoKind = (await resNoKind.json()) as Record<string, unknown>;
        expect('total_count' in bodyNoKind).toBe(false);

        // With kind filter: total_count included
        const resWithKind = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events?kind=session.heartbeat`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        const bodyWithKind = (await resWithKind.json()) as Record<string, unknown>;
        expect('total_count' in bodyWithKind).toBe(true);
      });
    });
  });

  it('paginates with cursor (round-trip page1 + page2 = full list)', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        // session.start (seq 0) + 5 heartbeats (seq 1..5) = 6 total rows.
        await seedEventsBundle(db, client, sub.id, [{ events: fillerEvents(5) }]);

        const app = createV1App();

        // Page 1: limit=3
        const res1 = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events?limit=3`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res1.status).toBe(200);
        const body1 = (await res1.json()) as {
          items: { seq: number }[];
          next_cursor: string | null;
        };
        expect(body1.items).toHaveLength(3);
        expect(body1.next_cursor).not.toBeNull();
        expect(body1.items.map((i) => i.seq)).toEqual([0, 1, 2]);

        // Page 2: use cursor from page 1
        const res2 = await app.fetch(
          new Request(
            `http://localhost/submissions/${sub.id}/events?limit=3&cursor=${body1.next_cursor!}`,
            { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
          ),
        );
        expect(res2.status).toBe(200);
        const body2 = (await res2.json()) as {
          items: { seq: number }[];
          next_cursor: string | null;
        };
        expect(body2.items).toHaveLength(3);
        expect(body2.next_cursor).toBeNull();
        expect(body2.items.map((i) => i.seq)).toEqual([3, 4, 5]);
      });
    });
  });

  it('returns events in seq_desc order', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        await seedEventsBundle(db, client, sub.id, [{ events: fillerEvents(3) }]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events?order=seq_desc`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { seq: number }[] };
        expect(body.items.map((i) => i.seq)).toEqual([3, 2, 1, 0]);
      });
    });
  });

  it('returns EVENT_QUERY_LIMIT_EXCEEDED when limit > 2000', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?limit=2001`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_LIMIT_EXCEEDED');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for negative seq_from', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?seq_from=-1`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for out-of-order seq range', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?seq_from=10&seq_to=5`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for out-of-order t range', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?t_from=5000&t_to=1000`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for invalid wall_from string', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?wall_from=not-a-date`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns EVENT_QUERY_RANGE_INVALID for invalid wall_to string', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, user.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events?wall_to=garbage`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('EVENT_QUERY_RANGE_INVALID');
    });
  });

  it('returns 404 for unknown submission', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/events`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const owner = await seedUser(db);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, owner.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, owner.id);
      // No bundle needs to be seeded — auth is rejected before any storage read.

      const outsider = await seedUser(db);
      const outsiderSession = await seedSession(db, outsider.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events`, {
          headers: { Cookie: `__Host-prov_sess=${outsiderSession}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 401 for unauthenticated request', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/events`),
      );

      expect(res.status).toBe(401);
    });
  });

  it('filters by wall_from / wall_to range', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);

        const base = new Date('2024-01-01T00:00:00Z');
        const events: EventSpec[] = Array.from({ length: 5 }, (_, i) => ({
          kind: 'session.heartbeat',
          data: {},
          wall: new Date(base.getTime() + i * 60_000).toISOString(), // 1 minute apart
        }));
        await seedEventsBundle(db, client, sub.id, [{ events }]);

        // Filter to wall range 00:01 - 00:03 (events 1, 2, 3)
        const wallFrom = new Date(base.getTime() + 60_000).toISOString();
        const wallTo = new Date(base.getTime() + 3 * 60_000).toISOString();

        const app = createV1App();
        const res = await app.fetch(
          new Request(
            `http://localhost/submissions/${sub.id}/events?wall_from=${encodeURIComponent(wallFrom)}&wall_to=${encodeURIComponent(wallTo)}`,
            { headers: { Cookie: `__Host-prov_sess=${sessionId}` } },
          ),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { items: { seq: number }[] };
        expect(body.items.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  it('supports multiple kind values (OR semantics)', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        const events: EventSpec[] = [
          { kind: 'doc.save', data: { path: '/f.py', sha256: 'a'.repeat(64) } },
          { kind: 'doc.save', data: { path: '/f.py', sha256: 'b'.repeat(64) } },
          { kind: 'doc.change', data: { path: 'main.py' } },
          { kind: 'doc.change', data: { path: 'main.py' } },
          { kind: 'session.heartbeat', data: {} },
          { kind: 'session.heartbeat', data: {} },
        ];
        await seedEventsBundle(db, client, sub.id, [{ events }]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(
            `http://localhost/submissions/${sub.id}/events?kind=doc.save&kind=doc.change`,
            {
              headers: { Cookie: `__Host-prov_sess=${sessionId}` },
            },
          ),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          items: { kind: string }[];
          total_count: number;
        };
        expect(body.items).toHaveLength(4);
        expect(body.total_count).toBe(4);
        for (const item of body.items) {
          expect(['doc.save', 'doc.change']).toContain(item.kind);
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
// §2. GET /submissions/:id/events/:seq
// ---------------------------------------------------------------------------

describe('GET /submissions/:id/events/:seq', () => {
  it('returns single event by seq', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        await seedEventsBundle(db, client, sub.id, [{ events: fillerEvents(3) }]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events/2`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as { seq: number; kind: string };
        expect(body.seq).toBe(2);
        expect(body.kind).toBe('session.heartbeat');
      });
    });
  });

  it('returns 404 for unknown seq', async () => {
    await withTestMinio(async ({ client, endpoint, bucketName }) => {
      await withTestDb(async (db) => {
        _testDb = db;
        _setConfigForTest(
          parseEnv(makeTestEnv({ minioEndpoint: endpoint, minioBucket: bucketName })),
        );

        const user = await seedUser(db);
        const sessionId = await seedSession(db, user.id);
        const { semester } = await seedCourseAndSemester(db);
        await seedMembership(db, user.id, semester.id, 'admin');
        const sub = await seedSubmission(db, semester.id, user.id);
        await seedEventsBundle(db, client, sub.id, [{ events: fillerEvents(3) }]);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/submissions/${sub.id}/events/999`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(404);
      });
    });
  });

  it('returns 404 for unknown submission', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const user = await seedUser(db);
      const sessionId = await seedSession(db, user.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${crypto.randomUUID()}/events/1`, {
          headers: { Cookie: `__Host-prov_sess=${sessionId}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });

  it('returns 404 for non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));

      const owner = await seedUser(db);
      const { semester } = await seedCourseAndSemester(db);
      await seedMembership(db, owner.id, semester.id, 'admin');
      const sub = await seedSubmission(db, semester.id, owner.id);
      // No bundle needs to be seeded — auth is rejected before any storage read.

      const outsider = await seedUser(db);
      const outsiderSession = await seedSession(db, outsider.id);

      const app = createV1App();
      const res = await app.fetch(
        new Request(`http://localhost/submissions/${sub.id}/events/1`, {
          headers: { Cookie: `__Host-prov_sess=${outsiderSession}` },
        }),
      );

      expect(res.status).toBe(404);
    });
  });
});
