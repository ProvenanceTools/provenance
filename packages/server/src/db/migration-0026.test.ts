/**
 * Migration 0026 applied in the UPGRADE direction (declared submission types).
 *
 * `withTestDb` proves the empty-database direction by construction: every other
 * server integration test runs the full migration chain against a fresh
 * Postgres before it starts. What that cannot prove is the direction that
 * actually matters here — 0026 landing on a deployment whose `assignments`
 * rows were written under migration 0023's two-value enum:
 *
 *     mode: 'self_identifying' | 'path'
 *
 * 0026 widens that enum to four declared submission types and renames `'path'`
 * to `'repo_scoped'`. A deployed assignment must not start behaving differently
 * because of it, and this file is the proof.
 *
 * So: apply 0001–0025, seed the three shapes a pre-0026 row can actually have,
 * apply 0026, and assert what moved and what did not.
 *
 *   1. a row left at the column DEFAULT               → untouched, byte for byte
 *   2. an explicit `mode: 'self_identifying'` row     → untouched
 *   3. a `mode: 'path'` row with a glob + on_multiple → mode renamed, and
 *                                                        NOTHING else altered
 *
 * The rename is behaviour-preserving because `resolveRepoScopes` applies the
 * identical glob filter for `repo_scoped` as it did for `path` — asserted
 * directly in repo-scopes.test.ts, which runs both through the resolver and
 * compares the results.
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
import { parseIngestScopeConfig } from '../services/ingest/gradescope/repo-scopes.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file is at packages/server/src/db/. Migrations are at packages/server/db/migrations/.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

const TAG_0026 = '0026_ingest_scope_submission_types';

type Journal = { version: string; dialect: string; entries: { tag: string }[] };

/**
 * Build a temporary migrations folder holding every migration STRICTLY BEFORE
 * `stopBeforeTag`, so we can bring a database up to the previous release and
 * then apply the new migration to it separately. Mirrors migration-0025.test.ts.
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

describe('migration 0026 — declared submission types', () => {
  it('renames only mode=path rows and leaves every other assignment untouched', async () => {
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
      truncatedDir = makeTruncatedMigrationsDir(TAG_0026);
      await migrate(db, { migrationsFolder: truncatedDir });

      // Sanity: the 0023 column exists with the 0023 default, so we really are
      // standing on the pre-0026 world.
      const [defaultRow] = await sql`
        SELECT column_default AS d FROM information_schema.columns
         WHERE table_name = 'assignments' AND column_name = 'ingest_scope'`;
      expect(String(defaultRow!['d'])).toContain('self_identifying');

      // ---------------------------------------------------------------------
      // 2. Seed the three shapes a pre-0026 row can have.
      // ---------------------------------------------------------------------
      const [course] = await sql`
        INSERT INTO courses (name, slug) VALUES ('CS 61B', 'cs61b-mig26') RETURNING id`;
      const [semester] = await sql`
        INSERT INTO semesters (course_id, term, year, slug, display_name, filename_convention)
        VALUES (${course!['id']}, 'fa', 2026, 'fa26-mig26', 'Fall 2026', '{sid}_{assignment}.zip')
        RETURNING id`;
      const semesterId = semester!['id'];

      // (1) Never configured — the overwhelmingly common case, since ingest
      //     auto-creates assignments and never sets this column.
      const [defaulted] = await sql`
        INSERT INTO assignments (semester_id, assignment_id_str, label)
        VALUES (${semesterId}, 'hw1', 'Homework 1') RETURNING id, ingest_scope`;
      const defaultedBefore = defaulted!['ingest_scope'];

      // (2) Explicitly self_identifying, with a non-default on_multiple.
      const [explicit] = await sql`
        INSERT INTO assignments (semester_id, assignment_id_str, label, ingest_scope)
        VALUES (${semesterId}, 'hw2', 'Homework 2',
                '{"mode":"self_identifying","on_multiple":"error"}'::jsonb)
        RETURNING id, ingest_scope`;
      const explicitBefore = explicit!['ingest_scope'];

      // (3) The only shape 0026 rewrites.
      const [legacyPath] = await sql`
        INSERT INTO assignments (semester_id, assignment_id_str, label, ingest_scope)
        VALUES (${semesterId}, 'proj2', 'Project 2',
                '{"mode":"path","path_glob":"proj2/**","on_multiple":"error"}'::jsonb)
        RETURNING id, ingest_scope`;
      const legacyBefore = legacyPath!['ingest_scope'] as Record<string, unknown>;
      expect(legacyBefore['mode']).toBe('path');

      // ---------------------------------------------------------------------
      // 3. Apply 0026 on top.
      // ---------------------------------------------------------------------
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

      const after = async (id: unknown) => {
        const [row] = await sql`SELECT ingest_scope FROM assignments WHERE id = ${id as string}`;
        return row!['ingest_scope'] as Record<string, unknown>;
      };

      // (1) + (2): not rewritten. Deep-equal against the value read BEFORE the
      //     migration ran, which is the strongest form of "behaves identically".
      expect(await after(defaulted!['id'])).toEqual(defaultedBefore);
      expect(await after(defaulted!['id'])).toEqual({
        mode: 'self_identifying',
        on_multiple: 'ingest_all',
      });
      expect(await after(explicit!['id'])).toEqual(explicitBefore);
      expect(await after(explicit!['id'])).toEqual({
        mode: 'self_identifying',
        on_multiple: 'error',
      });

      // (3): mode renamed, and ONLY mode. `path_glob` and `on_multiple` are the
      //      fields that decide behaviour, so a rewrite that disturbed either
      //      would silently re-scope a live assignment.
      const legacyAfter = await after(legacyPath!['id']);
      expect(legacyAfter).toEqual({
        mode: 'repo_scoped',
        path_glob: 'proj2/**',
        on_multiple: 'error',
      });
      expect(legacyAfter['path_glob']).toBe(legacyBefore['path_glob']);
      expect(legacyAfter['on_multiple']).toBe(legacyBefore['on_multiple']);

      // The server reads the pre- and post-migration values to the SAME config,
      // which is what actually guarantees the deployment order does not matter:
      // an un-migrated replica behaves exactly like a migrated one.
      expect(parseIngestScopeConfig(legacyBefore)).toEqual(
        parseIngestScopeConfig(legacyAfter),
      );

      // The column DEFAULT is untouched, so rows created after the migration
      // are indistinguishable from rows created before it.
      const [defaultAfter] = await sql`
        SELECT column_default AS d FROM information_schema.columns
         WHERE table_name = 'assignments' AND column_name = 'ingest_scope'`;
      expect(defaultAfter!['d']).toEqual(defaultRow!['d']);

      // Nothing was deleted: all three rows are still here.
      const [countRow] = await sql`
        SELECT COUNT(*)::int AS n FROM assignments WHERE semester_id = ${semesterId as string}`;
      expect(countRow!['n']).toBe(3);
    } finally {
      await sql.end();
      await container.stop();
      if (truncatedDir !== undefined) fs.rmSync(truncatedDir, { recursive: true, force: true });
    }
  });
});
