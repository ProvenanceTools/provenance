/**
 * Migration 0029 applied to a database that ALREADY HAS submissions.
 *
 * Every other server integration test proves the EMPTY-database direction by
 * construction: `withTestDb` runs the full hand-authored migration chain from
 * `db/migrations` against a fresh Postgres before each file, so if 0029 could
 * not build the schema from nothing, the entire suite would fail to start.
 *
 * What that cannot prove is the UPGRADE direction — 0029 landing on a
 * deployment that has been ingesting for a term — and this is the migration
 * where that matters most. It changes the unique constraint that backs the
 * version sequence and drops a NOT NULL on the column that every read path
 * joins to.
 *
 * So this file applies 0001–0028, seeds a realistic mid-term database, then
 * applies 0029 on top.
 *
 * The claims being defended:
 *
 *  1. the upgrade SUCCEEDS on populated data;
 *  2. **version uniqueness survives**. Every pre-existing row's derived
 *     `version_owner_key` is `'student:' || student_id`, so the new constraint
 *     partitions the table point-for-point as the old one did, and a duplicate
 *     (semester, assignment, student, version) still collides;
 *  3. the NULL-uniqueness hazard is CLOSED rather than introduced: a row with
 *     no student cannot exist without a lineage, two different groups do not
 *     collide, and the SAME group at the same version does;
 *  4. every existing submission gets EXACTLY ONE contributor, naming its own
 *     student and carrying its own score — the property that makes every
 *     rewritten read path return the identical rows for existing data;
 *  5. existing FANNED-OUT group submissions are NOT merged and NOT deleted.
 *     Rows persist for audit; merging would rewrite history that flags,
 *     cross-flag participants and ingest_files all point at;
 *  6. `version_owner_key` cannot be written by anyone, so it can never
 *     disagree with the row it describes.
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
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

const TAG_0029 = '0029_submission_contributors';

type Journal = { version: string; dialect: string; entries: { tag: string }[] };

/**
 * A temporary migrations folder holding every migration STRICTLY BEFORE
 * `stopBeforeTag`, so the database can be brought up to the previous release
 * and the new migration applied to it separately.
 */
function makeTruncatedMigrationsDir(stopBeforeTag: string): string {
  const journal = JSON.parse(
    fs.readFileSync(path.join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8'),
  ) as Journal;

  const cutoff = journal.entries.findIndex((e) => e.tag === stopBeforeTag);
  expect(cutoff).toBeGreaterThan(-1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-mig29-'));
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

describe('migration 0029 — submission_contributors on a populated database', () => {
  it('upgrades without merging, without deleting, and without losing version uniqueness', async () => {
    const container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('provenance_mig29_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    const sql = postgres(container.getConnectionUri(), { max: 1 });
    let truncatedDir: string | undefined;

    try {
      const db = drizzle(sql);

      // ---------------------------------------------------------------------
      // 1. Bring the database up to the PREVIOUS release (through 0028).
      // ---------------------------------------------------------------------
      truncatedDir = makeTruncatedMigrationsDir(TAG_0029);
      await migrate(db, { migrationsFolder: truncatedDir });

      const before = await sql`SELECT to_regclass('public.submission_contributors') AS t`;
      expect(before[0]!['t']).toBeNull();

      // student_id is NOT NULL before the migration.
      const beforeNullable = await sql`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'submissions' AND column_name = 'student_id'`;
      expect(beforeNullable[0]!['is_nullable']).toBe('NO');

      // ---------------------------------------------------------------------
      // 2. Seed a realistic mid-term deployment.
      // ---------------------------------------------------------------------
      const [user] = await sql`
        INSERT INTO users (google_subject, email) VALUES ('g-staff', 'staff@berkeley.edu')
        RETURNING id`;
      const userId = user!['id'] as string;

      const [course] = await sql`
        INSERT INTO courses (name, slug) VALUES ('CS61B', 'cs61b') RETURNING id`;
      const courseId = course!['id'] as string;

      const [semester] = await sql`
        INSERT INTO semesters (course_id, term, year, slug, display_name, filename_convention)
        VALUES (${courseId}, 'fa', 2026, 'fa26', 'Fall 2026', '(?<sid>[0-9]+)')
        RETURNING id`;
      const semesterId = semester!['id'] as string;

      const [alice] = await sql`
        INSERT INTO roster_entries (semester_id, sid, display_name)
        VALUES (${semesterId}, '111111', 'Alice') RETURNING id`;
      const aliceId = alice!['id'] as string;

      const [bob] = await sql`
        INSERT INTO roster_entries (semester_id, sid, display_name)
        VALUES (${semesterId}, '222222', 'Bob') RETURNING id`;
      const bobId = bob!['id'] as string;

      const [assignment] = await sql`
        INSERT INTO assignments (semester_id, assignment_id_str, label)
        VALUES (${semesterId}, 'proj1', 'Project 1') RETURNING id`;
      const assignmentId = assignment!['id'] as string;

      const [job] = await sql`
        INSERT INTO ingest_jobs (semester_id, uploaded_by, status)
        VALUES (${semesterId}, ${userId}, 'succeeded') RETURNING id`;
      const jobId = job!['id'] as string;

      const insertSubmission = async (
        studentId: string,
        versionIndex: number,
        sha: string,
        scoreTotal: number,
        maxSeverity: string,
      ): Promise<string> => {
        const [row] = await sql`
          INSERT INTO submissions
            (semester_id, assignment_id, student_id, blob_object_key, blob_sha256,
             source_filename, ingest_job_id, version_index, score_total,
             score_max_severity, flag_counts)
          VALUES (${semesterId}, ${assignmentId}, ${studentId}, ${'k/' + sha}, ${sha},
                  ${sha + '.zip'}, ${jobId}, ${versionIndex}, ${scoreTotal},
                  ${maxSeverity}, ${'{"info":0,"low":1,"medium":0,"high":2}'}::jsonb)
          RETURNING id`;
        return row!['id'] as string;
      };

      // Alice: two versions of the same assignment — the supersede chain.
      const aliceV1 = await insertSubmission(aliceId, 1, 'a'.repeat(64), 3, 'medium');
      const aliceV2 = await insertSubmission(aliceId, 2, 'b'.repeat(64), 11, 'high');
      await sql`UPDATE submissions SET superseded_by_submission_id = ${aliceV2}
                WHERE id = ${aliceV1}`;

      // A pre-existing FANNED-OUT group submission: identical bytes ingested
      // once per co-submitter, which is exactly what D9 replaces. These rows
      // must survive the migration untouched.
      const groupSha = 'c'.repeat(64);
      const [g] = await sql`
        INSERT INTO submissions
          (semester_id, assignment_id, student_id, blob_object_key, blob_sha256,
           source_filename, ingest_job_id, version_index, score_total, score_max_severity)
        VALUES (${semesterId}, ${assignmentId}, ${aliceId}, 'k/g1', ${groupSha},
                'g.zip', ${jobId}, 3, 5, 'low')
        RETURNING id`;
      const groupA = g!['id'] as string;
      const groupB = await insertSubmission(bobId, 1, groupSha, 5, 'low');

      const rowCountBefore = await sql`SELECT COUNT(*)::int AS n FROM submissions`;
      expect(rowCountBefore[0]!['n']).toBe(4);

      // ---------------------------------------------------------------------
      // 3. Apply 0029.
      // ---------------------------------------------------------------------
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      // -- Claim 1: nothing was lost. -----------------------------------------
      const rowCountAfter = await sql`SELECT COUNT(*)::int AS n FROM submissions`;
      expect(rowCountAfter[0]!['n']).toBe(4);

      // -- Claim 5: the fanned-out pair is NOT merged. -------------------------
      const stillTwo = await sql`
        SELECT id FROM submissions WHERE blob_sha256 = ${groupSha} ORDER BY id`;
      expect(stillTwo.map((r) => r['id']).sort()).toEqual([groupA, groupB].sort());

      // -- Claim 2: every existing row's lineage is its own student. ----------
      const keys = await sql`
        SELECT id, student_id, version_owner_key FROM submissions`;
      for (const row of keys) {
        expect(row['version_owner_key']).toBe(`student:${row['student_id'] as string}`);
      }

      // ...and the constraint moved to it.
      const constraintCols = await sql`
        SELECT a.attname
        FROM pg_constraint c
        JOIN unnest(c.conkey) AS k(attnum) ON TRUE
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conname = 'submissions_version_key'
        ORDER BY a.attname`;
      expect(constraintCols.map((r) => r['attname'])).toEqual([
        'assignment_id',
        'semester_id',
        'version_index',
        'version_owner_key',
      ]);

      // A duplicate (semester, assignment, student, version) STILL collides —
      // the old guarantee, expressed through the new column.
      await expect(insertSubmission(aliceId, 1, 'd'.repeat(64), 0, 'info')).rejects.toThrow(
        /submissions_version_key/,
      );

      // -- Claim 4: exactly one contributor per existing submission. -----------
      const contributors = await sql`
        SELECT submission_id, roster_entry_id, kind, contributor_key, is_submitter,
               score_total, score_max_severity, flag_counts
        FROM submission_contributors ORDER BY submission_id`;
      expect(contributors).toHaveLength(4);

      const bySubmission = new Map(contributors.map((c) => [c['submission_id'], c]));
      const aliceV2Contributor = bySubmission.get(aliceV2)!;
      expect(aliceV2Contributor['roster_entry_id']).toBe(aliceId);
      expect(aliceV2Contributor['kind']).toBe('roster');
      expect(aliceV2Contributor['contributor_key']).toBe(`roster:${aliceId}`);
      expect(aliceV2Contributor['is_submitter']).toBe(true);
      // The contributor carries the submission's OWN score — a single
      // contributor owns the whole scope score, which is what keeps the
      // students rollup byte-identical after the read paths move onto this table.
      expect(aliceV2Contributor['score_total']).toBe(11);
      expect(aliceV2Contributor['score_max_severity']).toBe('high');
      // flag_counts travels with the score, for the same reason.
      expect(aliceV2Contributor['flag_counts']).toEqual({ info: 0, low: 1, medium: 0, high: 2 });

      // -- Claim 3: the NULL hazard is closed, not introduced. -----------------
      const afterNullable = await sql`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'submissions' AND column_name = 'student_id'`;
      expect(afterNullable[0]!['is_nullable']).toBe('YES');

      const insertGroup = async (groupKey: string | null, versionIndex: number) =>
        sql`
          INSERT INTO submissions
            (semester_id, assignment_id, student_id, group_key, blob_object_key,
             blob_sha256, source_filename, ingest_job_id, version_index)
          VALUES (${semesterId}, ${assignmentId}, NULL, ${groupKey}, 'k/x',
                  ${'e'.repeat(64)}, 'x.zip', ${jobId}, ${versionIndex})
          RETURNING id, version_owner_key`;

      // No student AND no group key => no lineage => rejected. Without this, a
      // group submission would restart its version sequence on every upload.
      await expect(insertGroup(null, 1)).rejects.toThrow(/version_owner_key/);

      const [gk1] = await insertGroup('pair-alice-bob', 1);
      expect(gk1!['version_owner_key']).toBe('group:pair-alice-bob');

      // Two DIFFERENT groups at version 1 coexist...
      const [gk2] = await insertGroup('pair-carol-dave', 1);
      expect(gk2!['version_owner_key']).toBe('group:pair-carol-dave');

      // ...and the SAME group at version 1 twice does NOT. This is the exact
      // failure that plain NULL-distinctness would have allowed silently.
      await expect(insertGroup('pair-alice-bob', 1)).rejects.toThrow(/submissions_version_key/);

      // A blank group key would put every keyless group into one lineage.
      await expect(insertGroup('', 1)).rejects.toThrow(/submissions_group_key_check/);

      // -- Claim 6: the lineage key cannot be written. -------------------------
      await expect(
        sql`
          INSERT INTO submissions
            (semester_id, assignment_id, student_id, blob_object_key, blob_sha256,
             source_filename, ingest_job_id, version_index, version_owner_key)
          VALUES (${semesterId}, ${assignmentId}, ${bobId}, 'k/y', ${'f'.repeat(64)},
                  'y.zip', ${jobId}, 9, ${'student:' + aliceId})`,
        // Postgres puts "is a generated column" in DETAIL; the MESSAGE is this.
      ).rejects.toThrow(/cannot insert a non-DEFAULT value/);

      // -- The person-uniqueness invariant. -----------------------------------
      // One row per human per submission, however many sources name them.
      await expect(
        sql`
          INSERT INTO submission_contributors
            (submission_id, semester_id, contributor_key, kind, roster_entry_id, student_ref)
          VALUES (${aliceV2}, ${semesterId}, ${'attributed:2.1:institution:b:alice'},
                  'attributed', ${aliceId}, 'alice-ref')`,
      ).rejects.toThrow(/submission_contributors_person_key/);
    } finally {
      await sql.end({ timeout: 5 });
      await container.stop();
      if (truncatedDir !== undefined) fs.rmSync(truncatedDir, { recursive: true, force: true });
    }
  });
});
