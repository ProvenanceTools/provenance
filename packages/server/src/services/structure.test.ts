/**
 * Service layer tests for courses and semesters.
 *
 * Integration tests via withTestDb that verify:
 * - CRUD operations
 * - Slug uniqueness
 * - Filename convention validation
 * - Membership queries
 */

import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../test/helpers/db.js';
import { semesters } from '../db/schema.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
import * as structureService from './structure.js';
import type { Principal } from '../api/middleware/auth-session.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const superAdminPrincipal: Principal = {
  principal_kind: 'session',
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    google_subject: 'admin@example.com',
    email: 'admin@example.com',
    display_name: 'Admin User',
    is_superadmin: true,
    protected: false,
    created_at: new Date(),
    last_login_at: new Date(),
  },
  session: {
    id: 'a'.repeat(43),
    user_id: '00000000-0000-0000-0000-000000000001',
    created_at: new Date(),
    last_seen_at: new Date(),
    expires_at: new Date(Date.now() + 1000000),
    ip: null,
    user_agent: null,
    view_as_user_id: null,
    view_as_started_at: null,
  },
};

// Future: regular user principal for testing
// const regularUserPrincipal: Principal = {
//   principal_kind: 'session',
//   user: {
//     id: 'user-id',
//     google_subject: 'user@example.com',
//     email: 'user@example.com',
//     display_name: 'Regular User',
//     is_superadmin: false,
//     created_at: new Date(),
//     last_login_at: new Date(),
//   },
//   session: {
//     id: 'session-id-2',
//     user_id: 'user-id',
//     created_at: new Date(),
//     last_seen_at: new Date(),
//     expires_at: new Date(Date.now() + 1000000),
//     ip: null,
//     user_agent: null,
//   },
// };

// ---------------------------------------------------------------------------
// Courses tests
// ---------------------------------------------------------------------------

describe('structureService.courses', () => {
  it('creates a course', async () => {
    await withTestDb(async (db) => {
      const course = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      expect(course.name).toBe('CS 61A');
      expect(course.slug).toBe('cs61a');
      expect(course.archived_at).toBeNull();
      expect(course.id).toBeTruthy();
    });
  });

  it('rejects duplicate course slug', async () => {
    await withTestDb(async (db) => {
      await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      try {
        await structureService.createCourse(db, {
          name: 'Another Course',
          slug: 'cs61a',
        });
        expect.fail('Should have thrown COURSE_SLUG_TAKEN');
      } catch (err) {
        // ApiError carries the code in `err.code`, not in `err.message`.
        if (err instanceof Error && (err as { code?: string }).code === 'COURSE_SLUG_TAKEN') {
          expect(true).toBe(true);
        } else {
          throw err;
        }
      }
    });
  });

  it('lists all courses for superadmin', async () => {
    await withTestDb(async (db) => {
      const course1 = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });
      const course2 = await structureService.createCourse(db, {
        name: 'CS 61B',
        slug: 'cs61b',
      });

      const courses = await structureService.listCoursesForPrincipal(db, superAdminPrincipal);

      expect(courses.length).toBeGreaterThanOrEqual(2);
      expect(courses.some((c) => c.id === course1.id)).toBe(true);
      expect(courses.some((c) => c.id === course2.id)).toBe(true);
    });
  });

  it('gets a course by ID', async () => {
    await withTestDb(async (db) => {
      const created = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      const course = await structureService.getCourse(db, created.id);

      expect(course).toBeTruthy();
      expect(course?.name).toBe('CS 61A');
      expect(course?.slug).toBe('cs61a');
    });
  });

  it('updates course name', async () => {
    await withTestDb(async (db) => {
      const created = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      const updated = await structureService.updateCourse(db, created.id, {
        name: 'Computer Science 61A',
      });

      expect(updated?.name).toBe('Computer Science 61A');
      expect(updated?.slug).toBe('cs61a');
    });
  });

  it('archives a course', async () => {
    await withTestDb(async (db) => {
      const created = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      await structureService.archiveCourse(db, created.id);

      const course = await structureService.getCourse(db, created.id);
      expect(course?.archived_at).toBeTruthy();
    });
  });

  it('archiving a course cascades to its not-yet-archived semesters', async () => {
    await withTestDb(async (db) => {
      const course = await structureService.createCourse(db, { name: 'CS 61A', slug: 'cs61a' });

      const active = await structureService.createSemester(db, {
        courseId: course.id,
        term: 'fa',
        year: 2026,
        slug: 'fa26',
        displayName: 'Fall 2026',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
      });
      const other = await structureService.createSemester(db, {
        courseId: course.id,
        term: 'sp',
        year: 2026,
        slug: 'sp26',
        displayName: 'Spring 2026',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
      });

      await structureService.archiveCourse(db, course.id);

      expect(await structureService.isArchivedSemester(db, active.id)).toBe(true);
      expect(await structureService.isArchivedSemester(db, other.id)).toBe(true);
    });
  });

  it('cascade preserves an already-archived semester’s original archived_at', async () => {
    await withTestDb(async (db) => {
      const course = await structureService.createCourse(db, { name: 'CS 61A', slug: 'cs61a' });
      const sem = await structureService.createSemester(db, {
        courseId: course.id,
        term: 'fa',
        year: 2026,
        slug: 'fa26',
        displayName: 'Fall 2026',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
      });

      // Archive the semester directly first, then archive the parent course.
      await structureService.archiveSemester(db, sem.id);
      const [before] = await db
        .select({ archived_at: semesters.archived_at })
        .from(semesters)
        .where(eq(semesters.id, sem.id));

      await structureService.archiveCourse(db, course.id);
      const [after] = await db
        .select({ archived_at: semesters.archived_at })
        .from(semesters)
        .where(eq(semesters.id, sem.id));

      // The cascade must not reset (push forward) an already-running retention clock.
      expect(after?.archived_at).toBeTruthy();
      expect(after?.archived_at?.getTime()).toBe(before?.archived_at?.getTime());
    });
  });
});

// ---------------------------------------------------------------------------
// Semesters tests
// ---------------------------------------------------------------------------

describe('structureService.semesters', () => {
  it('validates filename convention', () => {
    // Valid regex with sid group
    expect(() => {
      structureService.validateFilenameConvention('(?<sid>[a-z0-9]+)_hw');
    }).not.toThrow();

    // Missing sid group
    expect(() => {
      structureService.validateFilenameConvention('(?<other>[a-z0-9]+)_hw');
    }).toThrow();

    // Invalid regex
    expect(() => {
      structureService.validateFilenameConvention('(?<sid>[unclosed');
    }).toThrow();

    // Too long
    expect(() => {
      structureService.validateFilenameConvention('(?<sid>...)' + 'x'.repeat(500));
    }).toThrow();
  });

  it('throws VALIDATION_REGEX (not a raw SyntaxError) for invalid regex syntax', () => {
    // Regression for Critical 2: the catch block used `err instanceof Errors.constructor`
    // which evaluates to `err instanceof Object` — always true — so the re-throw branch
    // for our own ApiError ran for ALL errors, meaning the SyntaxError from `new RegExp`
    // was never rewrapped as VALIDATION_REGEX. This test ensures the rewrap happens.

    const patterns = [
      '(?<sid>[bad-regex-with-unclosed-bracket', // unclosed character class
      '(?<sid>(?P<bad>nested))', // invalid named group syntax in JS
      '(?<sid>\\p{NotACategory})', // invalid unicode property
    ];

    for (const pattern of patterns) {
      try {
        structureService.validateFilenameConvention(pattern);
        // If it didn't throw, the regex might have been accepted — that's fine for the second pattern
        // on some engines, but for the first one it must throw.
        if (pattern === '(?<sid>[bad-regex-with-unclosed-bracket') {
          expect.fail(`Expected VALIDATION_REGEX for pattern: ${pattern}`);
        }
      } catch (err) {
        // Must be an ApiError with code VALIDATION_REGEX, NOT a raw SyntaxError
        expect(err).toBeInstanceOf(Error);
        expect((err as { code?: string }).code).toBe('VALIDATION_REGEX');
        expect(err).not.toBeInstanceOf(SyntaxError);
      }
    }
  });

  it('creates a semester', async () => {
    await withTestDb(async (db) => {
      const course = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      const semester = await structureService.createSemester(db, {
        courseId: course.id,
        term: 'fa',
        year: 2024,
        slug: 'fa2024',
        displayName: 'Fall 2024',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
      });

      expect(semester.slug).toBe('fa2024');
      expect(semester.term).toBe('fa');
      expect(semester.year).toBe(2024);
      expect(semester.archived_at).toBeNull();
    });
  });

  it('rejects duplicate semester slug within course', async () => {
    await withTestDb(async (db) => {
      const course = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      await structureService.createSemester(db, {
        courseId: course.id,
        term: 'fa',
        year: 2024,
        slug: 'fa2024',
        displayName: 'Fall 2024',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
      });

      try {
        await structureService.createSemester(db, {
          courseId: course.id,
          term: 'sp',
          year: 2025,
          slug: 'fa2024',
          displayName: 'Spring 2025',
          filenameConvention: '(?<sid>[a-z0-9]+)_hw',
        });
        expect.fail('Should have thrown SEMESTER_SLUG_TAKEN');
      } catch (err) {
        // ApiError carries the code in `err.code`, not in `err.message`.
        if (err instanceof Error && (err as { code?: string }).code === 'SEMESTER_SLUG_TAKEN') {
          expect(true).toBe(true);
        } else {
          throw err;
        }
      }
    });
  });

  it('lists semesters in a course', async () => {
    await withTestDb(async (db) => {
      const course = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      const sem1 = await structureService.createSemester(db, {
        courseId: course.id,
        term: 'fa',
        year: 2024,
        slug: 'fa2024',
        displayName: 'Fall 2024',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
      });

      const sem2 = await structureService.createSemester(db, {
        courseId: course.id,
        term: 'sp',
        year: 2025,
        slug: 'sp2025',
        displayName: 'Spring 2025',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
      });

      const semesters = await structureService.listSemestersInCourse(
        db,
        course.id,
        superAdminPrincipal,
      );

      expect(semesters.length).toBe(2);
      expect(semesters.some((s) => s.id === sem1.id)).toBe(true);
      expect(semesters.some((s) => s.id === sem2.id)).toBe(true);
    });
  });

  it('gets a semester with details', async () => {
    await withTestDb(async (db) => {
      const course = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      const created = await structureService.createSemester(db, {
        courseId: course.id,
        term: 'fa',
        year: 2024,
        slug: 'fa2024',
        displayName: 'Fall 2024',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
        blobRetentionDays: 100,
        derivedRetentionDays: 2000,
      });

      const semester = await structureService.getSemester(db, created.id);

      expect(semester).toBeTruthy();
      expect(semester?.slug).toBe('fa2024');
      expect(semester?.filename_convention).toBe('(?<sid>[a-z0-9]+)_hw');
      expect(semester?.blob_retention_days).toBe(100);
      expect(semester?.derived_retention_days).toBe(2000);
    });
  });

  it('updates semester', async () => {
    await withTestDb(async (db) => {
      const course = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      const created = await structureService.createSemester(db, {
        courseId: course.id,
        term: 'fa',
        year: 2024,
        slug: 'fa2024',
        displayName: 'Fall 2024',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
      });

      const updated = await structureService.updateSemester(db, created.id, {
        displayName: 'Fall 2024 (Updated)',
        blobRetentionDays: 300,
      });

      expect(updated?.display_name).toBe('Fall 2024 (Updated)');
      expect(updated?.blob_retention_days).toBe(300);
    });
  });

  it('archives a semester', async () => {
    await withTestDb(async (db) => {
      const course = await structureService.createCourse(db, {
        name: 'CS 61A',
        slug: 'cs61a',
      });

      const created = await structureService.createSemester(db, {
        courseId: course.id,
        term: 'fa',
        year: 2024,
        slug: 'fa2024',
        displayName: 'Fall 2024',
        filenameConvention: '(?<sid>[a-z0-9]+)_hw',
      });

      await structureService.archiveSemester(db, created.id);

      const isArchived = await structureService.isArchivedSemester(db, created.id);
      expect(isArchived).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Memberships tests
// ---------------------------------------------------------------------------

describe('structureService.memberships', () => {
  it('gets user memberships', async () => {
    await withTestDb(async (db) => {
      // This test would require inserting users and memberships,
      // which is more complex. For now, just verify the function exists
      // and returns an array for a user with no memberships.
      const memberships = await structureService.getUserMemberships(
        db,
        '00000000-0000-0000-0000-000000000099',
      );
      expect(Array.isArray(memberships)).toBe(true);
    });
  });
});
