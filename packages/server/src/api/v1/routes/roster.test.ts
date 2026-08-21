/**
 * Roster routes integration tests.
 *
 * All tests go through the full v1 app pipeline via createV1App() (V18 rule).
 * Audit log assertions follow V20 rule.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../../test/helpers/db.js';
import { waitForAuditRow } from '../../../../test/helpers/audit.js';
import { _resetConfigForTest, _setConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import { _resetPreviewCacheForTest } from '../../../services/roster/preview-cache.js';
import {
  users,
  sessions,
  courses,
  semesters,
  memberships,
  roster_entries,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-roster-tests-123456789012',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
  _resetPreviewCacheForTest();
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

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function insertUser(db: DrizzleDb, overrides?: Partial<typeof users.$inferInsert>) {
  const randomId = Math.random().toString(36).slice(2);
  const [user] = await db
    .insert(users)
    .values({
      google_subject: `sub-${randomId}`,
      email: `user-${randomId}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: false,
      ...overrides,
    })
    .returning();
  return user!;
}

async function insertSession(
  db: DrizzleDb,
  userId: string,
  expiresAt: Date = new Date(Date.now() + 14 * 86400_000),
): Promise<string> {
  const uniqueId = `sess-${Math.random().toString(36).slice(2)}`.padEnd(43, 'x').slice(0, 43);
  await db.insert(sessions).values({ id: uniqueId, user_id: userId, expires_at: expiresAt });
  return uniqueId;
}

async function insertCourse(db: DrizzleDb) {
  const randomId = Math.random().toString(36).slice(2);
  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61A', slug: `cs61a-${randomId}` })
    .returning();
  return course!;
}

async function insertSemester(db: DrizzleDb, courseId: string) {
  const randomId = Math.random().toString(36).slice(2);
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: courseId,
      term: 'fa',
      year: 2024,
      slug: `fa2024-${randomId}`,
      display_name: 'Fall 2024',
      filename_convention: '(?<sid>[a-z0-9]+)_hw',
    })
    .returning();
  return semester!;
}

async function insertMembership(
  db: DrizzleDb,
  userId: string,
  semesterId: string,
  role: 'admin' | 'grader',
  grantedBy: string,
) {
  await db
    .insert(memberships)
    .values({ user_id: userId, semester_id: semesterId, role, granted_by: grantedBy });
}

async function insertRosterEntry(
  db: DrizzleDb,
  semesterId: string,
  overrides?: Partial<typeof roster_entries.$inferInsert>,
) {
  const randomId = Math.random().toString(36).slice(2);
  const [entry] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: `student-${randomId}`,
      display_name: 'Test Student',
      ...overrides,
    })
    .returning();
  return entry!;
}

/** Build a simple multipart FormData request body for CSV upload. */
function makeCsvUploadRequest(
  url: string,
  csvContent: string,
  sessionId: string,
  filename = 'roster.csv',
): Request {
  const formData = new FormData();
  const blob = new Blob([csvContent], { type: 'text/csv' });
  formData.append('file', blob, filename);
  return new Request(url, {
    method: 'POST',
    headers: { Cookie: `__Host-prov_sess=${sessionId}` },
    body: formData,
  });
}

// ---------------------------------------------------------------------------
// GET /semesters/:semesterId/roster — list
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/roster', () => {
  it('returns 401 when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster`),
        );
        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 403 for non-member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const user = await insertUser(db);
        const sessionId = await insertSession(db, user.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 200 with entries for a member', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertRosterEntry(db, semester.id, { sid: 'stu001', display_name: 'Alice' });
        await insertRosterEntry(db, semester.id, { sid: 'stu002', display_name: 'Bob' });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          entries: unknown[];
          next_cursor: null;
          total_count: number;
        };
        expect(body.entries).toHaveLength(2);
        expect(body.total_count).toBe(2);
        expect(body.next_cursor).toBeNull();
      } finally {
        _testDb = null;
      }
    });
  });

  it('filters by q (display_name match)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertRosterEntry(db, semester.id, { sid: 'stu001', display_name: 'Alice Smith' });
        await insertRosterEntry(db, semester.id, { sid: 'stu002', display_name: 'Bob Jones' });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster?q=alice`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { entries: { display_name: string }[] };
        expect(body.entries).toHaveLength(1);
        expect(body.entries[0]?.display_name).toBe('Alice Smith');
      } finally {
        _testDb = null;
      }
    });
  });

  it('paginates with limit and next_cursor', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        // Insert 3 entries.
        for (let i = 0; i < 3; i++) {
          await insertRosterEntry(db, semester.id, {
            sid: `stu${i}`,
            display_name: `Student ${i}`,
          });
        }

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster?limit=2`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { entries: unknown[]; next_cursor: string | null };
        expect(body.entries).toHaveLength(2);
        expect(body.next_cursor).not.toBeNull();
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/roster:upload
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/roster:upload', () => {
  it('returns 401 when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const formData = new FormData();
        formData.append('file', new Blob(['sid,display_name\n1,A'], { type: 'text/csv' }), 'r.csv');
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster:upload`, {
            method: 'POST',
            body: formData,
          }),
        );
        expect(res.status).toBe(401);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 403 for grader (write requires admin)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const grader = await insertUser(db, { email: 'grader@berkeley.edu' });
        const sessionId = await insertSession(db, grader.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, grader.id, semester.id, 'grader', admin.id);
        const app = createV1App();
        const res = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            'sid,display_name\n1,Alice',
            sessionId,
          ),
        );
        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });

  it('happy path: returns 200 with upload_id and diff counts', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const csv = `sid,display_name,email\nstu001,Alice Smith,alice@berkeley.edu\nstu002,Bob Jones,`;
        const app = createV1App();
        const res = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          upload_id: string;
          parsed_rows: number;
          to_add: number;
          to_update: number;
          to_delete: number;
          errors: unknown[];
        };
        expect(typeof body.upload_id).toBe('string');
        expect(body.parsed_rows).toBe(2);
        expect(body.to_add).toBe(2);
        expect(body.to_update).toBe(0);
        expect(body.to_delete).toBe(0);
        expect(body.errors).toHaveLength(0);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 400 ROSTER_CSV_MISSING_REQUIRED_COLUMN when sid column is absent', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const csv = `display_name\nAlice Smith`;
        const app = createV1App();
        const res = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ROSTER_CSV_MISSING_REQUIRED_COLUMN');
      } finally {
        _testDb = null;
      }
    });
  });

  it('row-level parse errors return 200 with errors array, other rows counted', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        // Row 2 has empty sid (error), row 3 is valid.
        const csv = `sid,display_name\n,Alice Smith\nstu002,Bob Jones`;
        const app = createV1App();
        const res = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          parsed_rows: number;
          to_add: number;
          errors: { row: number; message: string }[];
        };
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0]?.row).toBe(2);
        expect(body.parsed_rows).toBe(1); // only valid rows counted
        expect(body.to_add).toBe(1);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 413 ROSTER_CSV_TOO_LARGE when file exceeds limit', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        // Override max bytes to 10 for this test.
        _setConfigForTest(parseEnv({ ...BASE_ENV, ROSTER_CSV_MAX_BYTES: '10' }));

        const csv = `sid,display_name\nstu001,Alice Smith who has a very long name`;
        const app = createV1App();
        const res = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );
        expect(res.status).toBe(413);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ROSTER_CSV_TOO_LARGE');
      } finally {
        _testDb = null;
      }
    });
  });

  it('audit: roster.upload row is created on success', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const csv = `sid,display_name\nstu001,Alice`;
        const app = createV1App();
        await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );

        const auditRow = await waitForAuditRow(db, 'roster.upload', semester.id);
        expect(auditRow).toBeDefined();
        expect(auditRow!.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// POST /semesters/:semesterId/roster:commit
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/roster:commit', () => {
  it('returns 404 for expired/missing upload_id', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster:commit`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              upload_id: '00000000-0000-0000-0000-000000000000',
              accept_deletions: false,
            }),
          }),
        );
        expect(res.status).toBe(404);
      } finally {
        _testDb = null;
      }
    });
  });

  it('happy path: commit applies additions and returns counts; audit row created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const app = createV1App();

        // Upload CSV to get an upload_id.
        const csv = `sid,display_name\nstu001,Alice\nstu002,Bob`;
        const uploadRes = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );
        expect(uploadRes.status).toBe(200);
        const { upload_id } = (await uploadRes.json()) as { upload_id: string };

        // Commit.
        const commitRes = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster:commit`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ upload_id, accept_deletions: false }),
          }),
        );
        expect(commitRes.status).toBe(200);
        const counts = (await commitRes.json()) as {
          added: number;
          updated: number;
          deleted: number;
        };
        expect(counts.added).toBe(2);
        expect(counts.updated).toBe(0);
        expect(counts.deleted).toBe(0);

        // Verify DB has the entries.
        const allEntries = await db.select().from(roster_entries);
        expect(allEntries.filter((e) => e.semester_id === semester.id)).toHaveLength(2);

        // Audit row.
        const auditRow = await waitForAuditRow(db, 'roster.commit', semester.id);
        expect(auditRow).toBeDefined();
        expect(auditRow!.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('accept_deletions=false skips deletions', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        // Pre-populate roster with one entry.
        await insertRosterEntry(db, semester.id, {
          sid: 'existing',
          display_name: 'Existing Student',
        });

        const app = createV1App();

        // Upload CSV with only a new student (no 'existing' sid).
        const csv = `sid,display_name\nnewstu,New Student`;
        const uploadRes = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );
        const { upload_id } = (await uploadRes.json()) as { upload_id: string };

        // Commit WITHOUT accepting deletions.
        const commitRes = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster:commit`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ upload_id, accept_deletions: false }),
          }),
        );
        expect(commitRes.status).toBe(200);
        const counts = (await commitRes.json()) as { added: number; deleted: number };
        expect(counts.added).toBe(1);
        expect(counts.deleted).toBe(0); // 'existing' should be kept

        // Both entries still in DB.
        const allEntries = await db.select().from(roster_entries);
        expect(allEntries.filter((e) => e.semester_id === semester.id)).toHaveLength(2);
      } finally {
        _testDb = null;
      }
    });
  });

  it('accept_deletions=true deletes missing rows', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        // Pre-populate roster.
        await insertRosterEntry(db, semester.id, { sid: 'todelete', display_name: 'To Delete' });

        const app = createV1App();

        // Upload CSV without 'todelete'.
        const csv = `sid,display_name\nnewstu,New Student`;
        const uploadRes = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );
        const { upload_id } = (await uploadRes.json()) as { upload_id: string };

        // Commit WITH accept_deletions=true.
        const commitRes = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster:commit`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ upload_id, accept_deletions: true }),
          }),
        );
        expect(commitRes.status).toBe(200);
        const counts = (await commitRes.json()) as { added: number; deleted: number };
        expect(counts.added).toBe(1);
        expect(counts.deleted).toBe(1);

        // Only 'newstu' should remain.
        const allEntries = await db.select().from(roster_entries);
        const semEntries = allEntries.filter((e) => e.semester_id === semester.id);
        expect(semEntries).toHaveLength(1);
        expect(semEntries[0]?.sid).toBe('newstu');
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// PATCH /semesters/:semesterId/roster/:rosterEntryId
// ---------------------------------------------------------------------------

describe('PATCH /semesters/:semesterId/roster/:rosterEntryId', () => {
  it('happy path: updates display_name; audit row created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        const entry = await insertRosterEntry(db, semester.id, {
          sid: 'stu001',
          display_name: 'Old Name',
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster/${entry.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ display_name: 'New Name' }),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { display_name: string; sid: string };
        expect(body.display_name).toBe('New Name');
        expect(body.sid).toBe('stu001'); // sid unchanged

        // Audit row.
        const auditRow = await waitForAuditRow(db, 'roster.update_entry', entry.id);
        expect(auditRow).toBeDefined();
        expect(auditRow!.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 400 VALIDATION when sid is in the body', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        const entry = await insertRosterEntry(db, semester.id, { sid: 'stu001' });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster/${entry.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ sid: 'newsid', display_name: 'Alice' }),
          }),
        );
        expect(res.status).toBe(400);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('VALIDATION');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 when entry does not exist', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(
            `http://localhost/semesters/${semester.id}/roster/00000000-0000-0000-0000-000000000000`,
            {
              method: 'PATCH',
              headers: {
                Cookie: `__Host-prov_sess=${sessionId}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ display_name: 'Alice' }),
            },
          ),
        );
        expect(res.status).toBe(404);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 when entry belongs to a different semester', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester1 = await insertSemester(db, course.id);
        const semester2 = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester1.id, 'admin', admin.id);
        await insertMembership(db, admin.id, semester2.id, 'admin', admin.id);

        // Entry belongs to semester2.
        const entry = await insertRosterEntry(db, semester2.id, { sid: 'stu001' });

        const app = createV1App();
        // Try to PATCH it via semester1's path.
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester1.id}/roster/${entry.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ display_name: 'Hacked' }),
          }),
        );
        expect(res.status).toBe(404);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Critical 1: Cross-semester preview commit guard
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/roster:commit — cross-semester guard', () => {
  it('returns 404 when upload_id was created for a different semester', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        // Two semesters; admin has write access to both.
        const semesterA = await insertSemester(db, course.id);
        const semesterB = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semesterA.id, 'admin', admin.id);
        await insertMembership(db, admin.id, semesterB.id, 'admin', admin.id);

        const app = createV1App();

        // Upload CSV against semester A → get upload_id for A.
        const csv = `sid,display_name\nstu001,Alice`;
        const uploadRes = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semesterA.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );
        expect(uploadRes.status).toBe(200);
        const { upload_id } = (await uploadRes.json()) as { upload_id: string };

        // Attempt to commit that upload_id against semester B — must return 404.
        const commitRes = await app.fetch(
          new Request(`http://localhost/semesters/${semesterB.id}/roster:commit`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ upload_id, accept_deletions: false }),
          }),
        );
        expect(commitRes.status).toBe(404);

        // Verify semester B has no entries (the commit was rejected).
        const bEntries = await db
          .select()
          .from(roster_entries)
          .then((rows) => rows.filter((r) => r.semester_id === semesterB.id));
        expect(bEntries).toHaveLength(0);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Critical 2: PATCH email: null clears the email column
// ---------------------------------------------------------------------------

describe('PATCH /semesters/:semesterId/roster/:id — email null clear', () => {
  it('clears email when patched with null', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        // Insert entry with a non-null email.
        const entry = await insertRosterEntry(db, semester.id, {
          sid: 'stu001',
          display_name: 'Alice',
          email: 'alice@berkeley.edu',
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster/${entry.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email: null }),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { email: string | null };
        // Route response must reflect the cleared value.
        expect(body.email).toBeNull();

        // Verify the DB row was actually updated to NULL.
        const [dbRow] = await db
          .select()
          .from(roster_entries)
          .where(eq(roster_entries.id, entry.id));
        expect(dbRow?.email).toBeNull();
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Important 3: Duplicate sid in CSV upload returns row-level error
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/roster:upload — duplicate sid', () => {
  it('returns 200 with row-level error for duplicate sid in the CSV', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        // Row 2 and row 4 have the same sid (12345). Row 3 is unique.
        const csv = `sid,display_name\n12345,Alice\n67890,Bob\n12345,Alice Duplicate`;
        const app = createV1App();
        const res = await app.fetch(
          makeCsvUploadRequest(
            `http://localhost/semesters/${semester.id}/roster:upload`,
            csv,
            sessionId,
          ),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          parsed_rows: number;
          to_add: number;
          errors: { row: number; message: string }[];
        };
        // The duplicate row should appear in errors.
        expect(body.errors).toHaveLength(1);
        expect(body.errors[0]?.row).toBe(4);
        expect(body.errors[0]?.message).toMatch(/duplicate sid/i);
        // Only the two unique rows are counted.
        expect(body.parsed_rows).toBe(2);
        expect(body.to_add).toBe(2);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Important 4: Content-Length pre-check returns 413 without buffering body
// ---------------------------------------------------------------------------

describe('POST /semesters/:semesterId/roster:upload — Content-Length pre-check', () => {
  it('returns 413 immediately when Content-Length header exceeds the cap', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        // Cap = 10 bytes for this test.
        _setConfigForTest(parseEnv({ ...BASE_ENV, ROSTER_CSV_MAX_BYTES: '10' }));

        // Send a small body but declare a Content-Length larger than the cap.
        // The route should reject via the pre-check before parseBody is reached.
        const formData = new FormData();
        formData.append(
          'file',
          new Blob(['sid,display_name\nstu,A'], { type: 'text/csv' }),
          'r.csv',
        );
        const req = new Request(`http://localhost/semesters/${semester.id}/roster:upload`, {
          method: 'POST',
          headers: {
            Cookie: `__Host-prov_sess=${sessionId}`,
            // Declare a content-length far above the cap.
            'content-length': '99999',
          },
          body: formData,
        });
        const app = createV1App();
        const res = await app.fetch(req);
        expect(res.status).toBe(413);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ROSTER_CSV_TOO_LARGE');
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Note: commitRoster transactional rollback
// ---------------------------------------------------------------------------
// Transaction rollback is exercised by Drizzle's withTransaction internally.
// Testing it meaningfully would require injecting a failure mid-commit (e.g.
// a mid-insert constraint violation) which requires concurrency machinery.
// The accept_deletions=true and accept_deletions=false paths are already
// exercised by the route-level tests above. The former placeholder test
// `expect(true).toBe(true)` has been removed — it implied coverage that did
// not exist.

// ---------------------------------------------------------------------------
// Phase 6: Protected mode — roster listing masking
// ---------------------------------------------------------------------------

describe('GET /semesters/:semesterId/roster — protected mode masking', () => {
  it('returns masked identity (Student N / SN / null email / null extras) for a protected user', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        // Protected superadmin: has membership to the semester.
        const admin = await insertUser(db, {
          email: 'admin@berkeley.edu',
          is_superadmin: true,
          protected: true,
        });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        // Seed two roster entries with known protected_index and real identity.
        await insertRosterEntry(db, semester.id, {
          sid: 'stu001',
          display_name: 'Alice Zhao',
          email: 'alice@berkeley.edu',
          extras: { section: '1A' },
          protected_index: 1,
        });
        await insertRosterEntry(db, semester.id, {
          sid: 'stu002',
          display_name: 'Bob Lee',
          email: 'bob@berkeley.edu',
          extras: { section: '1B' },
          protected_index: 2,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          entries: { display_name: string; sid: string; email: unknown; extras: unknown }[];
          total_count: number;
        };
        expect(body.total_count).toBe(2);

        for (const entry of body.entries) {
          // display_name must be masked
          expect(entry.display_name).toMatch(/^Student \d+$/);
          // real names must not appear
          expect(entry.display_name).not.toBe('Alice Zhao');
          expect(entry.display_name).not.toBe('Bob Lee');
          // sid must be masked (Sn)
          expect(entry.sid).toMatch(/^S\d+$/);
          expect(entry.sid).not.toBe('stu001');
          expect(entry.sid).not.toBe('stu002');
          // email and extras must be null
          expect(entry.email).toBeNull();
          expect(entry.extras).toBeNull();
        }
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns real identity for a non-protected user', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, {
          email: 'admin@berkeley.edu',
          is_superadmin: true,
          protected: false,
        });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        await insertRosterEntry(db, semester.id, {
          sid: 'stu001',
          display_name: 'Alice Zhao',
          email: 'alice@berkeley.edu',
          extras: { section: '1A' },
          protected_index: 1,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster`, {
            headers: { Cookie: `__Host-prov_sess=${sessionId}` },
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          entries: { display_name: string; sid: string; email: unknown; extras: unknown }[];
        };
        expect(body.entries).toHaveLength(1);
        const entry = body.entries[0]!;
        expect(entry.display_name).toBe('Alice Zhao');
        expect(entry.sid).toBe('stu001');
        expect(entry.email).toBe('alice@berkeley.edu');
        expect(entry.extras).toEqual({ section: '1A' });
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 6 (cont.): Protected mode — PATCH echo masking
// ---------------------------------------------------------------------------

describe('PATCH /semesters/:semesterId/roster/:id — protected mode masking', () => {
  it('protected PATCH echo returns masked identity (Student N / SN / null email / null extras)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, {
          email: 'admin@berkeley.edu',
          is_superadmin: true,
          protected: true,
        });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        // Entry with known protected_index.
        const entry = await insertRosterEntry(db, semester.id, {
          sid: 'patch_real_sid',
          display_name: 'Patch Real Name',
          email: 'patch@berkeley.edu',
          extras: { section: '2A' },
          protected_index: 5,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster/${entry.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ display_name: 'Updated Real Name' }),
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          id: string;
          display_name: string;
          sid: string;
          email: unknown;
          extras: unknown;
        };

        // display_name must be masked (Student 5 for protected_index=5).
        expect(body.display_name).toBe('Student 5');
        expect(body.sid).toBe('S5');
        // email and extras must be null.
        expect(body.email).toBeNull();
        expect(body.extras).toBeNull();
        // Real values must not appear.
        expect(body.display_name).not.toBe('Updated Real Name');
        expect(body.sid).not.toBe('patch_real_sid');
      } finally {
        _testDb = null;
      }
    });
  });

  it('non-protected PATCH echo returns real identity', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, {
          email: 'admin@berkeley.edu',
          is_superadmin: true,
          protected: false,
        });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);

        const entry = await insertRosterEntry(db, semester.id, {
          sid: 'np_real_sid',
          display_name: 'NP Real Name',
          email: 'np@berkeley.edu',
          extras: { section: '3A' },
          protected_index: 9,
        });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/roster/${entry.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ display_name: 'NP Updated Name' }),
          }),
        );

        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          display_name: string;
          sid: string;
          email: unknown;
          extras: unknown;
        };
        expect(body.display_name).toBe('NP Updated Name');
        expect(body.sid).toBe('np_real_sid');
        expect(body.email).toBe('np@berkeley.edu');
        expect(body.extras).toEqual({ section: '3A' });
      } finally {
        _testDb = null;
      }
    });
  });
});
