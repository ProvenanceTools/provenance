/**
 * Migration 0025 applied BOTH directions (identity 2.1).
 *
 * Every other server integration test proves the empty-database direction by
 * construction: `withTestDb` runs the full hand-authored migration chain from
 * `db/migrations` against a fresh Postgres before each file. What that cannot
 * prove is the UPGRADE direction — 0025 landing on a deployment that already
 * carries 2.0 identity data — and that is the direction where an archived
 * bundle stops resolving if something is wrong.
 *
 * So this file applies migrations 0001–0024, seeds the 2.0 world (a semester, a
 * roster, `student_refs`, `student_enrollments`), then applies 0025 on top and
 * asserts that nothing about the old world moved.
 *
 * The claim being defended: `student_refs` is NOT migrated, NOT backfilled, and
 * NOT dropped. One person has N per-semester 2.0 refs but exactly ONE global
 * 2.1 ref, so any merge would either collapse refs that archived bundles
 * distinguish or fabricate a global ref for a student who never obtained a 2.1
 * credential. There is nothing to join on: a 2.0 ref is keyed by roster SID, a
 * 2.1 ref by an authenticated SSO subject, which no roster carries.
 */

import { vi, describe, it, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file is at packages/server/src/db/. Migrations are at packages/server/db/migrations/.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

const TAG_0025 = '0025_students_institution_identity';

type Journal = { version: string; dialect: string; entries: { tag: string }[] };

/**
 * Build a temporary migrations folder holding every migration STRICTLY BEFORE
 * `stopBeforeTag`, so we can bring a database up to the previous release and
 * then apply the new migration to it separately.
 *
 * Drizzle records applied migrations in `__drizzle_migrations` by hash, so
 * pointing `migrate` at the full folder afterwards applies only what is left.
 */
function makeTruncatedMigrationsDir(stopBeforeTag: string): string {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
  ) as Journal;

  const cutoff = journal.entries.findIndex((e) => e.tag === stopBeforeTag);
  expect(cutoff).toBeGreaterThan(-1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-mig-'));
  fs.mkdirSync(path.join(dir, 'meta'), { recursive: true });

  const kept = journal.entries.slice(0, cutoff);
  for (const entry of kept) {
    fs.copyFileSync(
      path.join(MIGRATIONS_DIR, `${entry.tag}.sql`),
      path.join(dir, `${entry.tag}.sql`),
    );
  }
  fs.writeFileSync(
    path.join(dir, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: kept }, null, 2),
  );
  return dir;
}

describe('migration 0025 — institution-scoped identity', () => {
  it('applies to a database that already holds 2.0 identity data, and archived identity still resolves', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('provenance_mig_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    const sql = postgres(container.getConnectionUri(), { max: 1 });
    let truncatedDir: string | undefined;

    try {
      const db = drizzle(sql);

      // ---------------------------------------------------------------------
      // 1. Bring the database up to the PREVIOUS release (through 0024).
      // ---------------------------------------------------------------------
      truncatedDir = makeTruncatedMigrationsDir(TAG_0025);
      await migrate(db, { migrationsFolder: truncatedDir });

      // The new world must not exist yet — otherwise this test proves nothing.
      const before = await sql`SELECT to_regclass('public.students') AS t`;
      expect(before[0]!['t']).toBeNull();

      // ---------------------------------------------------------------------
      // 2. Seed the 2.0 world: a semester, a roster, and the per-semester
      //    course-scoped identity an archived bundle would name.
      // ---------------------------------------------------------------------
      const [course] = await sql`
        INSERT INTO courses (name, slug) VALUES ('CS 61B', 'cs61b-mig') RETURNING id`;
      const [semester] = await sql`
        INSERT INTO semesters (course_id, term, year, slug, display_name, filename_convention)
        VALUES (${course!['id']}, 'fa', 2026, 'fa26-mig', 'Fall 2026', '{sid}_{assignment}.zip')
        RETURNING id`;
      const semesterId = semester!['id'];

      const [rosterRow] = await sql`
        INSERT INTO roster_entries (semester_id, sid, display_name, email)
        VALUES (${semesterId}, '3032412345', 'Ada Lovelace', 'ada@berkeley.edu')
        RETURNING id`;
      const rosterId = rosterRow!['id'];

      const [archivedRef] = await sql`
        INSERT INTO student_refs (semester_id, roster_entry_id, sid)
        VALUES (${semesterId}, ${rosterId}, '3032412345')
        RETURNING student_ref`;
      const archivedStudentRef = archivedRef!['student_ref'];

      // A second, DIFFERENT semester ref for the same human — the case a merge
      // into a single global ref would silently collapse.
      const [semester2] = await sql`
        INSERT INTO semesters (course_id, term, year, slug, display_name, filename_convention)
        VALUES (${course!['id']}, 'sp', 2027, 'sp27-mig', 'Spring 2027', '{sid}_{assignment}.zip')
        RETURNING id`;
      const [archivedRef2] = await sql`
        INSERT INTO student_refs (semester_id, sid)
        VALUES (${semester2!['id']}, '3032412345')
        RETURNING student_ref`;
      const archivedStudentRef2 = archivedRef2!['student_ref'];
      expect(archivedStudentRef2).not.toBe(archivedStudentRef);

      await sql`
        INSERT INTO student_enrollments
          (student_ref, enrollment_pubkey, student_pubkey, issued_at, expires_at)
        VALUES (${archivedStudentRef}, ${'a'.repeat(64)}, ${'b'.repeat(64)},
                now(), now() + interval '90 days')`;

      // ---------------------------------------------------------------------
      // 3. Apply 0025 on top of that populated database.
      // ---------------------------------------------------------------------
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      // ---------------------------------------------------------------------
      // 4. The 2.0 world is completely undisturbed.
      // ---------------------------------------------------------------------
      const refsAfter = await sql`SELECT student_ref, semester_id, sid, roster_entry_id
                                  FROM student_refs ORDER BY sid, semester_id`;
      expect(refsAfter).toHaveLength(2);
      const refIds = refsAfter.map((r) => r['student_ref']).sort();
      expect(refIds).toEqual([archivedStudentRef, archivedStudentRef2].sort());

      // THE archived-identity claim: the ref an archived 2.0 bundle names still
      // resolves, through the same join, to the same person.
      const resolved = await sql`
        SELECT r.display_name, r.email, sr.sid
        FROM student_refs sr
        JOIN roster_entries r ON r.id = sr.roster_entry_id
        WHERE sr.student_ref = ${archivedStudentRef}`;
      expect(resolved).toHaveLength(1);
      expect(resolved[0]!['display_name']).toBe('Ada Lovelace');
      expect(resolved[0]!['sid']).toBe('3032412345');

      // The 2.0 ref whose roster pointer was never set still resolves by the
      // denormalised sid, which is what survives a roster deletion.
      const bySid = await sql`
        SELECT sid, semester_id FROM student_refs WHERE student_ref = ${archivedStudentRef2}`;
      expect(bySid[0]!['sid']).toBe('3032412345');

      // The enrollment FK into student_refs is intact.
      const enrollments = await sql`
        SELECT student_ref FROM student_enrollments WHERE student_ref = ${archivedStudentRef}`;
      expect(enrollments).toHaveLength(1);

      // ---------------------------------------------------------------------
      // 5. The new world exists, is EMPTY, and nothing was backfilled into it.
      // ---------------------------------------------------------------------
      const after = await sql`SELECT to_regclass('public.students') AS t`;
      expect(after[0]!['t']).not.toBeNull();

      const students = await sql`SELECT count(*)::int AS n FROM students`;
      // Backfilling would have had to invent an SSO subject for a student who
      // never obtained a 2.1 credential.
      expect(students[0]!['n']).toBe(0);

      // The link column exists and is NULL everywhere — a pre-existing roster
      // row is not retroactively attributed to anyone.
      const linked = await sql`
        SELECT count(*)::int AS n FROM roster_entries WHERE student_ref IS NOT NULL`;
      expect(linked[0]!['n']).toBe(0);

      // ---------------------------------------------------------------------
      // 6. The new world WORKS on the upgraded database: a student with no
      //    roster row can be allocated a ref, and linking is case-insensitive.
      // ---------------------------------------------------------------------
      const [fresh] = await sql`
        INSERT INTO students (institution_id, sso_subject, sso_email)
        VALUES ('berkeley', 'google-sub-abc', 'ADA@Berkeley.EDU')
        RETURNING student_ref`;
      const globalRef = fresh!['student_ref'];
      // Distinct from BOTH archived per-semester refs — the two eras do not
      // share an identifier space.
      expect(globalRef).not.toBe(archivedStudentRef);
      expect(globalRef).not.toBe(archivedStudentRef2);

      await sql`
        UPDATE roster_entries SET student_ref = ${globalRef}
        WHERE student_ref IS NULL AND lower(email) = lower('ada@BERKELEY.edu')`;
      const nowLinked = await sql`
        SELECT student_ref FROM roster_entries WHERE id = ${rosterId}`;
      expect(nowLinked[0]!['student_ref']).toBe(globalRef);

      // ---------------------------------------------------------------------
      // 7. Deleting the roster row drops the LINK, never the identity — and it
      //    still does not touch the 2.0 mapping either.
      // ---------------------------------------------------------------------
      await sql`DELETE FROM roster_entries WHERE id = ${rosterId}`;

      const survivingGlobal = await sql`
        SELECT sso_email FROM students WHERE student_ref = ${globalRef}`;
      expect(survivingGlobal).toHaveLength(1);

      const survivingLegacy = await sql`
        SELECT sid, roster_entry_id FROM student_refs WHERE student_ref = ${archivedStudentRef}`;
      expect(survivingLegacy).toHaveLength(1);
      // ON DELETE SET NULL from migration 0024, preserved: the mapping an
      // archived bundle needs survives by its denormalised sid.
      expect(survivingLegacy[0]!['roster_entry_id']).toBeNull();
      expect(survivingLegacy[0]!['sid']).toBe('3032412345');
    } finally {
      if (truncatedDir !== undefined) fs.rmSync(truncatedDir, { recursive: true, force: true });
      await sql.end();
      await container.stop();
    }
  });

  it('the students unique key is (institution_id, sso_subject), so one human cannot fork', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('provenance_mig_test2')
      .withUsername('test')
      .withPassword('test')
      .start();

    const sql = postgres(container.getConnectionUri(), { max: 1 });
    try {
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });

      await sql`INSERT INTO students (institution_id, sso_subject, sso_email)
                VALUES ('berkeley', 'sub-1', 'a@berkeley.edu')`;

      // Same subject at the same institution: refused by the database itself,
      // not merely by application logic.
      await expect(
        sql`INSERT INTO students (institution_id, sso_subject, sso_email)
            VALUES ('berkeley', 'sub-1', 'different@berkeley.edu')`,
      ).rejects.toThrow();

      // The SAME subject at a DIFFERENT institution is a different person's
      // identity space and is allowed.
      await sql`INSERT INTO students (institution_id, sso_subject, sso_email)
                VALUES ('stanford', 'sub-1', 'a@stanford.edu')`;

      const rows = await sql`SELECT count(*)::int AS n FROM students`;
      expect(rows[0]!['n']).toBe(2);

      // A non-hex public key is refused by the CHECK constraint.
      await expect(
        sql`INSERT INTO students (institution_id, sso_subject, sso_email, student_pubkey)
            VALUES ('berkeley', 'sub-2', 'b@berkeley.edu', 'not-hex')`,
      ).rejects.toThrow();
    } finally {
      await sql.end();
      await container.stop();
    }
  });
});
