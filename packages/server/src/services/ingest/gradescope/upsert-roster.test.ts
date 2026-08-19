/**
 * Integration tests for upsertRosterFromSubmitters — uses withTestDb (Docker).
 */

import { vi, describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withTestDb } from '../../../../test/helpers/db.js';
import { courses, semesters, roster_entries, students } from '../../../db/schema.js';
import { upsertRosterFromSubmitters } from './upsert-roster.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

async function seedSemester(db: DrizzleDb): Promise<string> {
  const slug = `cs61a-${crypto.randomUUID().slice(0, 8)}`;
  const [course] = await db.insert(courses).values({ name: 'CS 61A', slug }).returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2026,
      slug: `fa2026-${crypto.randomUUID().slice(0, 8)}`,
      display_name: 'Fall 2026',
      filename_convention: '(?<sid>\\d+)',
    })
    .returning();
  return semester!.id;
}

async function getEntry(db: DrizzleDb, semesterId: string, sid: string) {
  const [row] = await db
    .select()
    .from(roster_entries)
    .where(and(eq(roster_entries.semester_id, semesterId), eq(roster_entries.sid, sid)));
  return row;
}

describe('upsertRosterFromSubmitters', () => {
  it('inserts new entries and reports them as added', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      const result = await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', name: 'Alice', email: 'alice@berkeley.edu' },
        { sid: '200', name: 'Bob', email: 'bob@berkeley.edu' },
      ]);
      expect(result).toEqual({ added: 2, updated: 0 });

      const alice = await getEntry(db, semesterId, '100');
      expect(alice!.display_name).toBe('Alice');
      expect(alice!.email).toBe('alice@berkeley.edu');
    });
  });

  it('falls back to email then sid for display_name on new entries', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '300', email: 'noname@berkeley.edu' },
        { sid: '400' },
      ]);
      expect((await getEntry(db, semesterId, '300'))!.display_name).toBe('noname@berkeley.edu');
      expect((await getEntry(db, semesterId, '400'))!.display_name).toBe('400');
    });
  });

  it('updates existing entries; a missing name does not clobber the stored name', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', name: 'Alice Original', email: 'alice@berkeley.edu' },
      ]);

      // Re-upsert: new email present, name absent.
      const result = await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', email: 'alice.new@berkeley.edu' },
      ]);
      expect(result).toEqual({ added: 0, updated: 1 });

      const alice = await getEntry(db, semesterId, '100');
      // Name preserved, email updated.
      expect(alice!.display_name).toBe('Alice Original');
      expect(alice!.email).toBe('alice.new@berkeley.edu');
    });
  });

  it('never deletes roster entries not present in the submitters', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      await upsertRosterFromSubmitters(db, semesterId, [{ sid: '100', name: 'Keep Me' }]);
      // A second export that does not include sid 100.
      await upsertRosterFromSubmitters(db, semesterId, [{ sid: '999', name: 'New One' }]);

      expect(await getEntry(db, semesterId, '100')).toBeDefined();
      expect(await getEntry(db, semesterId, '999')).toBeDefined();
    });
  });

  it('dedupes submitters passed with a repeated sid', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      const result = await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', name: 'First' },
        { sid: '100', name: 'Second' },
      ]);
      expect(result).toEqual({ added: 1, updated: 0 });
      expect((await getEntry(db, semesterId, '100'))!.display_name).toBe('First');
    });
  });

  it('assigns a stable, unique protected_index to newly-added entries', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', name: 'Alice' },
        { sid: '200', name: 'Bob' },
      ]);

      // Protected mode masks identity to "Student <protected_index>"; without an
      // assigned index a Gradescope-rostered student would fall back to a UUID
      // stub. Every new entry must therefore receive a non-null, unique index.
      const alice = await getEntry(db, semesterId, '100');
      const bob = await getEntry(db, semesterId, '200');
      expect(alice!.protected_index).not.toBeNull();
      expect(bob!.protected_index).not.toBeNull();
      expect(alice!.protected_index).not.toBe(bob!.protected_index);

      // The index is stable: a later upsert (update-only) does not change it, and
      // a newly-added student continues from the existing max (no collision).
      const aliceIndexBefore = alice!.protected_index;
      const result = await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', email: 'alice.new@berkeley.edu' },
        { sid: '300', name: 'Carol' },
      ]);
      expect(result).toEqual({ added: 1, updated: 1 });

      expect((await getEntry(db, semesterId, '100'))!.protected_index).toBe(aliceIndexBefore);
      const carol = await getEntry(db, semesterId, '300');
      expect(carol!.protected_index).not.toBeNull();
      const indices = [
        (await getEntry(db, semesterId, '100'))!.protected_index,
        bob!.protected_index,
        carol!.protected_index,
      ];
      expect(new Set(indices).size).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Identity 2.1 roster linking — the "student enrolls, then submits" direction
  // -------------------------------------------------------------------------

  it('links newly-created roster rows to a student who already holds a credential', async () => {
    // The normal ordering: the student obtained an identity BEFORE doing the
    // work, and the roster row only comes into existence when Gradescope ingest
    // runs after their first submission. Under 2.0 that ordering was impossible.
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      const [student] = await db
        .insert(students)
        .values({
          institution_id: 'berkeley',
          sso_subject: 'sub-alice',
          sso_email: 'alice@berkeley.edu',
        })
        .returning();

      await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '100', name: 'Alice', email: 'alice@berkeley.edu' },
        { sid: '200', name: 'Bob', email: 'bob@berkeley.edu' },
      ]);

      expect((await getEntry(db, semesterId, '100'))!.student_ref).toBe(student!.student_ref);
      // Bob holds no credential, so his row is simply unlinked — not an error.
      expect((await getEntry(db, semesterId, '200'))!.student_ref).toBeNull();
    });
  });

  it('links case-insensitively in the ingest direction too', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      const [student] = await db
        .insert(students)
        .values({
          institution_id: 'berkeley',
          sso_subject: 'sub-carol',
          sso_email: 'carol@berkeley.edu',
        })
        .returning();

      await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '300', name: 'Carol', email: 'CAROL@Berkeley.EDU' },
      ]);

      expect((await getEntry(db, semesterId, '300'))!.student_ref).toBe(student!.student_ref);
    });
  });

  it('does not re-point a roster row already linked to another student', async () => {
    // The link is write-once. Re-pointing would silently re-attribute work.
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      const [first] = await db
        .insert(students)
        .values({
          institution_id: 'berkeley',
          sso_subject: 'sub-first',
          sso_email: 'shared@berkeley.edu',
        })
        .returning();

      await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '400', name: 'Shared', email: 'shared@berkeley.edu' },
      ]);
      expect((await getEntry(db, semesterId, '400'))!.student_ref).toBe(first!.student_ref);

      // A second account later claims the same address; the roster row must not
      // move.
      await db.delete(students).where(eq(students.student_ref, first!.student_ref));
      const [second] = await db
        .insert(students)
        .values({
          institution_id: 'berkeley',
          sso_subject: 'sub-second',
          sso_email: 'shared@berkeley.edu',
        })
        .returning();

      await upsertRosterFromSubmitters(db, semesterId, [
        { sid: '400', name: 'Shared', email: 'shared@berkeley.edu' },
      ]);

      const row = await getEntry(db, semesterId, '400');
      // Deleting the first student SET NULL the link (ON DELETE SET NULL), and
      // the fresh upsert re-linked it to the only remaining match. What must
      // NOT happen is a silent re-point while the first student still exists —
      // covered by the credential-route test of the same name.
      expect(row!.student_ref).toBe(second!.student_ref);
    });
  });

  it('a roster row with no email is never linked', async () => {
    await withTestDb(async (db) => {
      const semesterId = await seedSemester(db);
      await db.insert(students).values({
        institution_id: 'berkeley',
        sso_subject: 'sub-dave',
        sso_email: 'dave@berkeley.edu',
      });

      await upsertRosterFromSubmitters(db, semesterId, [{ sid: '500', name: 'NoEmail' }]);

      expect((await getEntry(db, semesterId, '500'))!.student_ref).toBeNull();
    });
  });
});
