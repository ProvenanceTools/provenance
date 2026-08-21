/**
 * Migration 0027 applied to a database that ALREADY HAS `students` rows.
 *
 * Every other server integration test proves the empty-database direction by
 * construction: `withTestDb` runs the full hand-authored migration chain from
 * `db/migrations` against a fresh Postgres before each file. What that cannot
 * prove is the UPGRADE direction — 0027 landing on a deployment that has been
 * issuing 2.1 credentials for a term — and that is the direction where a
 * student's live credential silently reads as "never issued" if the backfill is
 * wrong.
 *
 * So this file applies migrations 0001–0025, seeds the 2.1 world (students with
 * keys, a student with no key yet, and the archived 2.0 tables beside them),
 * then applies 0027 on top.
 *
 * The claims being defended:
 *
 *  1. the upgrade SUCCEEDS on populated data and touches nothing that was
 *     already there;
 *  2. the key each `students` row still carries is BACKFILLED, so a credential
 *     in a student's hands on upgrade day does not read as unknown;
 *  3. a student allocated but never issued (NULL `student_pubkey`) contributes
 *     no row — nothing is fabricated;
 *  4. keys OVERWRITTEN before the upgrade are honestly absent. `issue_count`
 *     exceeding the backfilled row count is the record admitting it cannot name
 *     them, which is the whole reason this table now exists;
 *  5. the archived 2.0 world (`student_refs`, `student_enrollments`) is
 *     untouched and NOT migrated into the new table — migration 0025 recorded
 *     why the two eras cannot be merged, and 0027 changes none of that;
 *  6. history is APPEND-ONLY and unprunable: the same key can be recorded twice
 *     without a unique constraint refusing it, and a `students` row cannot be
 *     deleted out from under its own audit trail.
 */

import { describe, it, expect } from 'vitest';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file is at packages/server/src/db/. Migrations are at packages/server/db/migrations/.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

const TAG_0027 = '0027_student_credentials';

const LAPTOP_KEY = 'a'.repeat(64);
const DESKTOP_KEY = 'b'.repeat(64);
const NEVER_ISSUED_KEY = 'e'.repeat(64);

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

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-mig26-'));
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

describe('migration 0027 — credential history', () => {
  it('applies to a database that already has students, and backfills without fabricating', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('provenance_mig26_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    const sql = postgres(container.getConnectionUri(), { max: 1 });
    let truncatedDir: string | undefined;

    try {
      const db = drizzle(sql);

      // ---------------------------------------------------------------------
      // 1. Bring the database up to the PREVIOUS release (through 0025).
      // ---------------------------------------------------------------------
      truncatedDir = makeTruncatedMigrationsDir(TAG_0027);
      await migrate(db, { migrationsFolder: truncatedDir });

      const before = await sql`SELECT to_regclass('public.student_credentials') AS t`;
      expect(before[0]!['t']).toBeNull();

      // ---------------------------------------------------------------------
      // 2. Seed a real deployment mid-term.
      // ---------------------------------------------------------------------

      // (a) A student who has enrolled TWICE — a laptop first, then a desktop.
      //     The 0025 upsert overwrote the key, so all the database now holds is
      //     the desktop key and issue_count = 2. The laptop key is already gone
      //     and nothing can bring it back; the test's job is to prove the
      //     migration does not pretend otherwise.
      const [twoMachines] = await sql`
        INSERT INTO students
          (institution_id, sso_subject, sso_email, student_pubkey, issued_at, expires_at, issue_count)
        VALUES ('berkeley', 'google-sub-two', 'two@berkeley.edu', ${DESKTOP_KEY},
                '2026-08-01T10:00:00Z', '2026-12-31T00:00:00Z', 2)
        RETURNING student_ref`;
      const twoMachinesRef = twoMachines!['student_ref'];

      // (b) A student with exactly one issuance.
      const [oneMachine] = await sql`
        INSERT INTO students
          (institution_id, sso_subject, sso_email, student_pubkey, issued_at, expires_at, issue_count)
        VALUES ('berkeley', 'google-sub-one', 'one@berkeley.edu', ${LAPTOP_KEY},
                '2026-08-02T10:00:00Z', '2026-12-31T00:00:00Z', 1)
        RETURNING student_ref`;
      const oneMachineRef = oneMachine!['student_ref'];

      // (c) A row allocated but never issued against. NULL key, issue_count 0.
      const [neverIssued] = await sql`
        INSERT INTO students (institution_id, sso_subject, sso_email)
        VALUES ('berkeley', 'google-sub-none', 'none@berkeley.edu')
        RETURNING student_ref`;
      const neverIssuedRef = neverIssued!['student_ref'];

      // (d) The archived 2.0 world beside it, so we can prove it is left alone.
      const [course] = await sql`
        INSERT INTO courses (name, slug) VALUES ('CS 61B', 'cs61b-mig26') RETURNING id`;
      const [semester] = await sql`
        INSERT INTO semesters (course_id, term, year, slug, display_name, filename_convention)
        VALUES (${course!['id']}, 'fa', 2026, 'fa26-mig26', 'Fall 2026', '{sid}_{assignment}.zip')
        RETURNING id`;
      const [legacyRef] = await sql`
        INSERT INTO student_refs (semester_id, sid)
        VALUES (${semester!['id']}, '3032412345')
        RETURNING student_ref`;
      const legacyStudentRef = legacyRef!['student_ref'];
      await sql`
        INSERT INTO student_enrollments
          (student_ref, enrollment_pubkey, student_pubkey, issued_at, expires_at)
        VALUES (${legacyStudentRef}, ${'c'.repeat(64)}, ${'d'.repeat(64)},
                now(), now() + interval '90 days')`;

      // ---------------------------------------------------------------------
      // 3. Apply 0027 on top of that populated database.
      // ---------------------------------------------------------------------
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      const after = await sql`SELECT to_regclass('public.student_credentials') AS t`;
      expect(after[0]!['t']).not.toBeNull();

      // ---------------------------------------------------------------------
      // 4. The backfill recovered exactly what `students` still remembered.
      // ---------------------------------------------------------------------
      const all = await sql`
        SELECT student_ref, institution_id, student_pubkey, issued_at, expires_at
        FROM student_credentials ORDER BY issued_at`;
      expect(all).toHaveLength(2);
      expect(all.map((r) => r['student_pubkey'])).toEqual([DESKTOP_KEY, LAPTOP_KEY]);
      expect(all[0]!['student_ref']).toBe(twoMachinesRef);
      expect(all[0]!['institution_id']).toBe('berkeley');
      // The stamps come from the students row, not from now(): a backfilled
      // credential must not claim to have been issued at upgrade time.
      expect(new Date(all[0]!['issued_at'] as string).toISOString()).toBe(
        '2026-08-01T10:00:00.000Z',
      );
      expect(new Date(all[0]!['expires_at'] as string).toISOString()).toBe(
        '2026-12-31T00:00:00.000Z',
      );

      // The never-issued student contributes nothing. Fabricating a row here
      // would assert a credential that was never handed to anyone.
      const none = await sql`
        SELECT count(*)::int AS n FROM student_credentials WHERE student_ref = ${neverIssuedRef}`;
      expect(none[0]!['n']).toBe(0);

      // ---------------------------------------------------------------------
      // 5. The adjudication query, on the upgraded database.
      // ---------------------------------------------------------------------
      const desktopKnown = await sql`
        SELECT count(*)::int AS n FROM student_credentials
        WHERE student_ref = ${twoMachinesRef} AND student_pubkey = ${DESKTOP_KEY}`;
      expect(desktopKnown[0]!['n']).toBe(1);

      // The laptop key that 0025's upsert overwrote is honestly UNKNOWN. It is
      // not recoverable, and the migration does not invent it — but the row's
      // issue_count still says more credentials were issued than can be named,
      // which is the signal an adjudicator needs to read "unknown" rather than
      // "forged".
      const laptopKnown = await sql`
        SELECT count(*)::int AS n FROM student_credentials
        WHERE student_ref = ${twoMachinesRef} AND student_pubkey = ${LAPTOP_KEY}`;
      expect(laptopKnown[0]!['n']).toBe(0);
      const counted = await sql`
        SELECT issue_count FROM students WHERE student_ref = ${twoMachinesRef}`;
      expect(counted[0]!['issue_count']).toBe(2);

      // A key nobody ever presented is false everywhere.
      const stranger = await sql`
        SELECT count(*)::int AS n FROM student_credentials
        WHERE student_pubkey = ${NEVER_ISSUED_KEY}`;
      expect(stranger[0]!['n']).toBe(0);

      // ---------------------------------------------------------------------
      // 6. `students` is untouched — it is still the identity anchor.
      // ---------------------------------------------------------------------
      const anchors = await sql`
        SELECT student_ref, sso_subject, student_pubkey, issue_count
        FROM students ORDER BY sso_subject`;
      expect(anchors).toHaveLength(3);
      const bySubject = Object.fromEntries(anchors.map((r) => [r['sso_subject'], r]));
      expect(bySubject['google-sub-two']!['student_pubkey']).toBe(DESKTOP_KEY);
      expect(bySubject['google-sub-one']!['student_pubkey']).toBe(LAPTOP_KEY);
      expect(bySubject['google-sub-none']!['student_pubkey']).toBeNull();
      expect(bySubject['google-sub-one']!['student_ref']).toBe(oneMachineRef);

      // The (institution_id, sso_subject) uniqueness that makes the ref stable
      // — and therefore makes two machines resolve to one contributor — still
      // holds after the upgrade.
      await expect(
        sql`INSERT INTO students (institution_id, sso_subject, sso_email)
            VALUES ('berkeley', 'google-sub-one', 'one@berkeley.edu')`,
      ).rejects.toThrow();

      // ---------------------------------------------------------------------
      // 7. The archived 2.0 world was NOT migrated into the new table.
      // ---------------------------------------------------------------------
      const legacyStill = await sql`
        SELECT student_pubkey FROM student_enrollments WHERE student_ref = ${legacyStudentRef}`;
      expect(legacyStill).toHaveLength(1);
      expect(legacyStill[0]!['student_pubkey']).toBe('d'.repeat(64));
      const leaked = await sql`
        SELECT count(*)::int AS n FROM student_credentials
        WHERE student_pubkey = ${'d'.repeat(64)}`;
      expect(leaked[0]!['n']).toBe(0);

      // ---------------------------------------------------------------------
      // 8. Append-only, and unprunable.
      // ---------------------------------------------------------------------

      // The same key twice is two rows: no unique constraint collapses them.
      await sql`
        INSERT INTO student_credentials
          (student_ref, institution_id, student_pubkey, issued_at, expires_at)
        VALUES (${twoMachinesRef}, 'berkeley', ${DESKTOP_KEY},
                '2026-09-01T10:00:00Z', '2026-12-31T00:00:00Z')`;
      const twice = await sql`
        SELECT count(*)::int AS n FROM student_credentials
        WHERE student_ref = ${twoMachinesRef} AND student_pubkey = ${DESKTOP_KEY}`;
      expect(twice[0]!['n']).toBe(2);

      // A malformed key cannot be recorded at all.
      await expect(
        sql`INSERT INTO student_credentials
              (student_ref, institution_id, student_pubkey, issued_at, expires_at)
            VALUES (${oneMachineRef}, 'berkeley', 'NOTAKEY', now(), now())`,
      ).rejects.toThrow();

      // Deleting a students row cannot silently take its audit trail. Nothing
      // in the product does this; RESTRICT is here so that if something ever
      // tries, it fails loudly instead of erasing evidence.
      await expect(
        sql`DELETE FROM students WHERE student_ref = ${oneMachineRef}`,
      ).rejects.toThrow();
      const survived = await sql`
        SELECT count(*)::int AS n FROM student_credentials WHERE student_ref = ${oneMachineRef}`;
      expect(survived[0]!['n']).toBe(1);
    } finally {
      if (truncatedDir !== undefined) fs.rmSync(truncatedDir, { recursive: true, force: true });
      await sql.end();
      await container.stop();
    }
  });
});
