/**
 * Assignment route integration tests (V46).
 *
 * Covers PATCH /semesters/:semesterId/assignments/:assignmentId. Follows the
 * V18 rule (full v1 app pipeline via createV1App) + V20 rule (audit-row
 * assertion on every mutation route).
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
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
  assignments,
} from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-assignment-tests-12345678',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

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

async function insertSession(db: DrizzleDb, userId: string): Promise<string> {
  const expiresAt = new Date(Date.now() + 14 * 86400_000);
  const id = `sess-${Math.random().toString(36).slice(2)}`.padEnd(43, 'x').slice(0, 43);
  await db.insert(sessions).values({ id, user_id: userId, expires_at: expiresAt });
  return id;
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

async function insertAssignment(
  db: DrizzleDb,
  semesterId: string,
  overrides?: Partial<typeof assignments.$inferInsert>,
) {
  const randomId = Math.random().toString(36).slice(2);
  const [row] = await db
    .insert(assignments)
    .values({
      semester_id: semesterId,
      assignment_id_str: `hw-${randomId}`,
      label: 'HW',
      ...overrides,
    })
    .returning();
  return row!;
}

// ---------------------------------------------------------------------------
// PATCH /semesters/:semesterId/assignments/:assignmentId
// ---------------------------------------------------------------------------

describe('PATCH /semesters/:semesterId/assignments/:assignmentId', () => {
  it('happy path: updates label, returns summary, audit row created', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        const a = await insertAssignment(db, semester.id, { label: 'Old Label' });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments/${a.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ label: 'Homework 1' }),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { assignment: { id: string; label: string } };
        expect(body.assignment.id).toBe(a.id);
        expect(body.assignment.label).toBe('Homework 1');

        // Persisted in DB.
        const [row] = await db.select().from(assignments).where(eq(assignments.id, a.id));
        expect(row!.label).toBe('Homework 1');

        const auditRow = await waitForAuditRow(db, 'assignment.update', a.id);
        expect(auditRow).toBeDefined();
        expect(auditRow!.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('happy path: updates sort_order', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        const a = await insertAssignment(db, semester.id, { sort_order: 0 });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments/${a.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ sort_order: 5 }),
          }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { assignment: { sort_order: number } };
        expect(body.assignment.sort_order).toBe(5);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 401 when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const a = await insertAssignment(db, semester.id);
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments/${a.id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ label: 'X' }),
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
        const grader = await insertUser(db);
        const sessionId = await insertSession(db, grader.id);
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, grader.id, semester.id, 'grader', admin.id);
        const a = await insertAssignment(db, semester.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments/${a.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ label: 'Nope' }),
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 when assignment does not exist', async () => {
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
            `http://localhost/semesters/${semester.id}/assignments/00000000-0000-0000-0000-000000000000`,
            {
              method: 'PATCH',
              headers: {
                Cookie: `__Host-prov_sess=${sessionId}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({ label: 'X' }),
            },
          ),
        );
        expect(res.status).toBe(404);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 404 when assignment belongs to a different semester', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semesterA = await insertSemester(db, course.id);
        const semesterB = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semesterA.id, 'admin', admin.id);
        await insertMembership(db, admin.id, semesterB.id, 'admin', admin.id);
        // Assignment belongs to semesterB.
        const a = await insertAssignment(db, semesterB.id);

        const app = createV1App();
        // PATCH it via semesterA's path.
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semesterA.id}/assignments/${a.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ label: 'Hacked' }),
          }),
        );
        expect(res.status).toBe(404);
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 400 VALIDATION when body has neither label nor sort_order', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        const a = await insertAssignment(db, semester.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments/${a.id}`, {
            method: 'PATCH',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
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
});

describe('POST /semesters/:semesterId/assignments', () => {
  it('happy path: creates assignment, returns summary, audit row created', async () => {
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
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ assignment_id_str: 'hw1', label: 'Homework 1' }),
          }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as {
          assignment: {
            id: string;
            assignment_id_str: string;
            label: string;
            submission_count: number;
          };
        };
        expect(body.assignment.assignment_id_str).toBe('hw1');
        expect(body.assignment.label).toBe('Homework 1');
        expect(body.assignment.submission_count).toBe(0);

        const [row] = await db
          .select()
          .from(assignments)
          .where(eq(assignments.id, body.assignment.id));
        expect(row!.assignment_id_str).toBe('hw1');

        const auditRow = await waitForAuditRow(db, 'assignment.create', body.assignment.id);
        expect(auditRow).toBeDefined();
        expect(auditRow!.actor_user_id).toBe(admin.id);
      } finally {
        _testDb = null;
      }
    });
  });

  it('defaults a blank label to assignment_id_str', async () => {
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
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ assignment_id_str: 'lab3' }),
          }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { assignment: { label: string } };
        expect(body.assignment.label).toBe('lab3');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 409 when assignment_id_str already exists', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const sessionId = await insertSession(db, admin.id);
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
        await insertAssignment(db, semester.id, { assignment_id_str: 'hw1' });

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ assignment_id_str: 'hw1' }),
          }),
        );
        expect(res.status).toBe(409);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('ASSIGNMENT_ID_STR_TAKEN');
      } finally {
        _testDb = null;
      }
    });
  });

  it('returns 400 VALIDATION when assignment_id_str is missing', async () => {
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
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ label: 'no id' }),
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

  it('returns 401 when unauthenticated', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ assignment_id_str: 'hw1' }),
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
        const grader = await insertUser(db);
        const sessionId = await insertSession(db, grader.id);
        const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
        const course = await insertCourse(db);
        const semester = await insertSemester(db, course.id);
        await insertMembership(db, grader.id, semester.id, 'grader', admin.id);

        const app = createV1App();
        const res = await app.fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ assignment_id_str: 'hw1' }),
          }),
        );
        expect(res.status).toBe(403);
      } finally {
        _testDb = null;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// ingest_scope — the per-assignment persisted default, over the API
//
// This column has existed since migration 0023 but no route could write it, so
// provgate could only configure anything by writing Postgres directly. These
// cover the read+write surface it actually uses.
// ---------------------------------------------------------------------------

describe('assignments ingest_scope — the persisted declared submission type', () => {
  /** Boilerplate every case below shares: admin + session + semester. */
  async function seedAdmin(db: DrizzleDb) {
    const admin = await insertUser(db, { email: 'admin@berkeley.edu' });
    const sessionId = await insertSession(db, admin.id);
    const course = await insertCourse(db);
    const semester = await insertSemester(db, course.id);
    await insertMembership(db, admin.id, semester.id, 'admin', admin.id);
    return { admin, sessionId, semester };
  }

  function patch(semesterId: string, assignmentId: string, sessionId: string, body: unknown) {
    return new Request(`http://localhost/semesters/${semesterId}/assignments/${assignmentId}`, {
      method: 'PATCH',
      headers: { Cookie: `__Host-prov_sess=${sessionId}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('defaults to self_identifying, and reports it on the summary', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const { sessionId, semester } = await seedAdmin(db);
        const a = await insertAssignment(db, semester.id);

        const res = await createV1App().fetch(
          patch(semester.id, a.id, sessionId, { label: 'untouched-scope' }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { assignment: { ingest_scope: unknown } };
        // The column default, surfaced verbatim — this is what "an existing
        // assignment behaves as before" looks like from the API.
        expect(body.assignment.ingest_scope).toEqual({
          mode: 'self_identifying',
          on_multiple: 'ingest_all',
        });
      } finally {
        _testDb = null;
      }
    });
  });

  it('PATCH writes each declared type and reads it straight back', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const { sessionId, semester } = await seedAdmin(db);
        const a = await insertAssignment(db, semester.id);
        const app = createV1App();

        const declarations = [
          { mode: 'bundle_zip', on_multiple: 'ingest_all' },
          { mode: 'repo_whole', on_multiple: 'error' },
          { mode: 'repo_scoped', path_glob: 'proj2/**', on_multiple: 'ingest_all' },
          { mode: 'self_identifying', on_multiple: 'ingest_all' },
        ];

        for (const ingest_scope of declarations) {
          const res = await app.fetch(patch(semester.id, a.id, sessionId, { ingest_scope }));
          expect(res.status).toBe(200);
          const body = (await res.json()) as { assignment: { ingest_scope: unknown } };
          expect(body.assignment.ingest_scope).toEqual(ingest_scope);

          const [row] = await db.select().from(assignments).where(eq(assignments.id, a.id));
          expect(row!.ingest_scope).toEqual(ingest_scope);
        }
      } finally {
        _testDb = null;
      }
    });
  });

  it('replaces ingest_scope wholesale rather than merging — no stale path_glob survives', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const { sessionId, semester } = await seedAdmin(db);
        const a = await insertAssignment(db, semester.id, {
          ingest_scope: { mode: 'repo_scoped', path_glob: 'proj2/**', on_multiple: 'ingest_all' },
        });
        const app = createV1App();

        const res = await app.fetch(
          patch(semester.id, a.id, sessionId, {
            ingest_scope: { mode: 'repo_whole', on_multiple: 'ingest_all' },
          }),
        );
        expect(res.status).toBe(200);
        const [row] = await db.select().from(assignments).where(eq(assignments.id, a.id));
        // A merge would have left `proj2/**` behind, silently scoping a repo
        // that the operator just declared to be whole.
        expect(row!.ingest_scope).toEqual({ mode: 'repo_whole', on_multiple: 'ingest_all' });
      } finally {
        _testDb = null;
      }
    });
  });

  it('rejects a repo_scoped with no path_glob — a glob-less scope selects nothing', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const { sessionId, semester } = await seedAdmin(db);
        const a = await insertAssignment(db, semester.id);

        const res = await createV1App().fetch(
          patch(semester.id, a.id, sessionId, {
            ingest_scope: { mode: 'repo_scoped', on_multiple: 'ingest_all' },
          }),
        );
        expect(res.status).toBe(400);

        // Nothing was written.
        const [row] = await db.select().from(assignments).where(eq(assignments.id, a.id));
        expect(row!.ingest_scope).toEqual({
          mode: 'self_identifying',
          on_multiple: 'ingest_all',
        });
      } finally {
        _testDb = null;
      }
    });
  });

  it("rejects the pre-0026 'path' spelling and an unknown mode at the API boundary", async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const { sessionId, semester } = await seedAdmin(db);
        const a = await insertAssignment(db, semester.id);
        const app = createV1App();

        for (const mode of ['path', 'nonsense']) {
          const res = await app.fetch(
            patch(semester.id, a.id, sessionId, {
              ingest_scope: { mode, path_glob: 'proj2/**', on_multiple: 'ingest_all' },
            }),
          );
          expect(res.status).toBe(400);
        }
      } finally {
        _testDb = null;
      }
    });
  });

  it('a pre-0026 row stored as mode=path still reads back as repo_scoped', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const { sessionId, semester } = await seedAdmin(db);
        // Exactly what migration 0023 could produce and 0026 rewrites. Written
        // straight to the column, bypassing the API, to stand in for a row that
        // predates the rename — proving the SERVER, not the rewrite, is what
        // keeps such a row working.
        const a = await insertAssignment(db, semester.id, {
          ingest_scope: { mode: 'path', path_glob: 'proj2/**', on_multiple: 'error' },
        });

        const res = await createV1App().fetch(
          patch(semester.id, a.id, sessionId, { label: 'legacy' }),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as { assignment: { ingest_scope: unknown } };
        expect(body.assignment.ingest_scope).toEqual({
          mode: 'repo_scoped',
          path_glob: 'proj2/**',
          on_multiple: 'error',
        });
      } finally {
        _testDb = null;
      }
    });
  });

  it('POST /assignments declares the scope at creation time (provgate mapping)', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const { sessionId, semester } = await seedAdmin(db);

        const res = await createV1App().fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              assignment_id_str: 'proj2',
              label: 'Project 2',
              ingest_scope: {
                mode: 'repo_scoped',
                path_glob: 'proj2/**',
                on_multiple: 'ingest_all',
              },
            }),
          }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { assignment: { id: string; ingest_scope: unknown } };
        expect(body.assignment.ingest_scope).toEqual({
          mode: 'repo_scoped',
          path_glob: 'proj2/**',
          on_multiple: 'ingest_all',
        });

        const [row] = await db
          .select()
          .from(assignments)
          .where(eq(assignments.id, body.assignment.id));
        expect(row!.ingest_scope).toEqual({
          mode: 'repo_scoped',
          path_glob: 'proj2/**',
          on_multiple: 'ingest_all',
        });
      } finally {
        _testDb = null;
      }
    });
  });

  it('POST without ingest_scope leaves the column DEFAULT in place', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const { sessionId, semester } = await seedAdmin(db);

        const res = await createV1App().fetch(
          new Request(`http://localhost/semesters/${semester.id}/assignments`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionId}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ assignment_id_str: 'hw9' }),
          }),
        );
        expect(res.status).toBe(201);
        const body = (await res.json()) as { assignment: { ingest_scope: unknown } };
        expect(body.assignment.ingest_scope).toEqual({
          mode: 'self_identifying',
          on_multiple: 'ingest_all',
        });
      } finally {
        _testDb = null;
      }
    });
  });

  it('an empty PATCH body is still rejected now that a third field exists', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      try {
        const { sessionId, semester } = await seedAdmin(db);
        const a = await insertAssignment(db, semester.id);
        const res = await createV1App().fetch(patch(semester.id, a.id, sessionId, {}));
        expect(res.status).toBe(400);
      } finally {
        _testDb = null;
      }
    });
  });
});
