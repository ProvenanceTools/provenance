/**
 * P1-1: 50k cohort-list performance budget (PRD §16.1).
 *
 * Asserts p95 < 300ms for GET /semesters/:id/submissions under a realistic
 * 50k-submission cohort. If the budget is missed, EXPLAIN ANALYZE output for
 * the slowest run is captured and logged, and denormalization options are
 * documented below.
 *
 * Denormalization proposal (if budget is missed):
 * -------------------------------------------------
 * The primary cost driver is the flags sub-query (top_flags + flag_counts)
 * which runs a correlated aggregation per page. Two columns on `submissions`
 * would eliminate it:
 *
 *   flag_counts  jsonb  DEFAULT '{}'   -- { "high": 2, "medium": 1, ... }
 *   top_flags    jsonb  DEFAULT '[]'   -- [{ heuristic_id, severity }, ...] (top 3)
 *
 * These would be written by the heuristic compute step (same place
 * score_total / score_max_severity are written) and included in
 * submissions_cohort_idx. The list query would become a pure index scan with
 * no join.  Migration cost: one ALTER TABLE + one backfill UPDATE.
 *
 * The secondary cost driver (when severity_min filter is active) is the
 * OR-expansion across severity levels. A numeric severity_rank column
 * (info=0, low=1, medium=2, high=3) stored on submissions and indexed in
 * submissions_cohort_idx would convert this to a single range predicate.
 *
 * Neither change is in scope for P1-1; this comment captures the design for
 * Phase 25 (perf pass) per the v3-progress.md O5 tracking item.
 */

import { vi, describe, it, expect } from 'vitest';
import { withTestDb } from '../helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../src/config/index.js';
import { _resetLoggerForTest } from '../../src/logging.js';
import { parseEnv } from '../../src/config/env.js';
import { createV1App } from '../../src/api/v1/index.js';
import { sql } from 'drizzle-orm';
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
} from '../../src/db/schema.js';
import type { DrizzleDb } from '../../src/db/client.js';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

// ---------------------------------------------------------------------------
// DB injection (mirrors cohort.test.ts pattern)
// ---------------------------------------------------------------------------

let _testDb: DrizzleDb | null = null;

vi.mock('../../src/db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/db/client.js')>();
  return {
    ...original,
    getDb: () => {
      if (_testDb !== null) return _testDb;
      return original.getDb();
    },
  };
});

// ---------------------------------------------------------------------------
// Env stub (same as cohort.test.ts)
// ---------------------------------------------------------------------------

function makeTestEnv() {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'rustfsadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'rustfsadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-cohort-perf-tests-12345678',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

// ---------------------------------------------------------------------------
// Latency helpers
// ---------------------------------------------------------------------------

function p95(latencies: number[]): number {
  const sorted = [...latencies].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)]!;
}

// ---------------------------------------------------------------------------
// Seeding constants
// ---------------------------------------------------------------------------

const NUM_STUDENTS = 100;
const NUM_ASSIGNMENTS = 50;
const TOTAL_SUBMISSIONS = 50_000;
// Max params per INSERT: postgres limit is 65535.
// Each submissions row has ~17 columns → 10k rows × 17 = 170k params would
// blow the limit. We use 2000 rows per batch (2000 × 17 = 34k params < 65535).
const INSERT_BATCH_ROWS = 2_000;

// ---------------------------------------------------------------------------
// Perf test
// ---------------------------------------------------------------------------

describe('P1-1: cohort list 50k perf budget', () => {
  it('p95 < 300ms across 10 varied filter requests', async () => {
    await withTestDb(async (db) => {
      _testDb = db;
      _setConfigForTest(parseEnv(makeTestEnv()));
      _resetLoggerForTest();

      // -----------------------------------------------------------------------
      // 1. Seed admin user + session
      // -----------------------------------------------------------------------
      const adminId = crypto.randomUUID();
      await db.insert(users).values({
        id: adminId,
        google_subject: `sub-${adminId}`,
        email: `admin-perf-${adminId}@berkeley.edu`,
        display_name: 'Perf Admin',
      });

      const sessionId = `sess-${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 43);
      await db.insert(sessions).values({
        id: sessionId,
        user_id: adminId,
        expires_at: new Date(Date.now() + 14 * 86400_000),
      });

      // -----------------------------------------------------------------------
      // 2. Seed course + semester
      // -----------------------------------------------------------------------
      const uid = crypto.randomUUID().slice(0, 8);
      const [course] = await db
        .insert(courses)
        .values({ name: 'CS 61A Perf', slug: `cs61a-perf-${uid}` })
        .returning();

      const [semester] = await db
        .insert(semesters)
        .values({
          course_id: course!.id,
          term: 'fa',
          year: 2024,
          slug: `fa2024-perf-${uid}`,
          display_name: 'Fall 2024 Perf',
          filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
        })
        .returning();
      const semesterId = semester!.id;

      await db.insert(memberships).values({
        user_id: adminId,
        semester_id: semesterId,
        role: 'admin',
        granted_by: adminId,
      });

      // -----------------------------------------------------------------------
      // 3. Seed 100 students
      // -----------------------------------------------------------------------
      const studentIds: string[] = [];
      {
        const rows = Array.from({ length: NUM_STUDENTS }, (_, i) => ({
          semester_id: semesterId,
          sid: `perf-stu-${String(i).padStart(4, '0')}`,
          display_name: `Student ${i}`,
        }));
        const inserted = await db
          .insert(roster_entries)
          .values(rows)
          .returning({ id: roster_entries.id });
        studentIds.push(...inserted.map((r) => r.id));
      }

      // -----------------------------------------------------------------------
      // 4. Seed 50 assignments
      // -----------------------------------------------------------------------
      const assignmentIds: string[] = [];
      {
        const rows = Array.from({ length: NUM_ASSIGNMENTS }, (_, i) => ({
          semester_id: semesterId,
          assignment_id_str: `hw${String(i).padStart(2, '0')}`,
          label: `HW ${i}`,
        }));
        const inserted = await db
          .insert(assignments)
          .values(rows)
          .returning({ id: assignments.id });
        assignmentIds.push(...inserted.map((r) => r.id));
      }

      // -----------------------------------------------------------------------
      // 5. Seed ingest job
      // -----------------------------------------------------------------------
      const [job] = await db
        .insert(ingest_jobs)
        .values({ semester_id: semesterId, uploaded_by: adminId, status: 'succeeded' })
        .returning();
      const jobId = job!.id;

      // -----------------------------------------------------------------------
      // 6. Seed 50k submissions in batches of INSERT_BATCH_ROWS
      // -----------------------------------------------------------------------
      console.log(
        `[perf] Seeding ${TOTAL_SUBMISSIONS} submissions in batches of ${INSERT_BATCH_ROWS}…`,
      );

      const severities = ['info', 'low', 'medium', 'high'] as const;
      const statuses = ['pass', 'warn', 'fail'] as const;

      // Build a deterministic student-assignment assignment: round-robin through
      // all student×assignment combinations so the distribution is uniform.
      // With 100 students × 50 assignments = 5000 unique pairs and 50k total,
      // each pair gets exactly 10 versions on average.
      let subIdx = 0;
      let batch: {
        id: string;
        semester_id: string;
        assignment_id: string;
        student_id: string;
        blob_object_key: string;
        blob_sha256: string;
        source_filename: string;
        ingest_job_id: string;
        version_index: number;
        score_total: number;
        score_max_severity: string;
        validation_status: string;
        recorder_version: string;
      }[] = [];

      const flushBatch = async () => {
        if (batch.length === 0) return;
        await db.insert(submissions).values(batch);
        batch = [];
      };

      for (let i = 0; i < TOTAL_SUBMISSIONS; i++) {
        const pairIdx = i % (NUM_STUDENTS * NUM_ASSIGNMENTS);
        const studentIdx = pairIdx % NUM_STUDENTS;
        const assignmentIdx = Math.floor(pairIdx / NUM_STUDENTS) % NUM_ASSIGNMENTS;
        const versionIndex = Math.floor(i / (NUM_STUDENTS * NUM_ASSIGNMENTS)) + 1;

        const id = crypto.randomUUID();
        const severity = severities[i % severities.length]!;
        const status = statuses[i % statuses.length]!;

        batch.push({
          id,
          semester_id: semesterId,
          assignment_id: assignmentIds[assignmentIdx]!,
          student_id: studentIds[studentIdx]!,
          blob_object_key: `semesters/${semesterId}/submissions/${id}/bundle.zip`,
          blob_sha256: `sha256-${subIdx++}`,
          source_filename: 'bundle.zip',
          ingest_job_id: jobId,
          version_index: versionIndex,
          score_total: (i % 20) * 1.0,
          score_max_severity: severity,
          validation_status: status,
          recorder_version: '1.0.0',
        });

        if (batch.length >= INSERT_BATCH_ROWS) {
          await flushBatch();
        }
      }
      await flushBatch();

      console.log(`[perf] Seeding complete. Running benchmark…`);

      // -----------------------------------------------------------------------
      // 7. Run 10 varied requests and measure latencies
      // -----------------------------------------------------------------------
      const app = createV1App();
      const base = `http://localhost/semesters/${semesterId}/submissions`;
      const cookie = `__Host-prov_sess=${sessionId}`;

      const requestConfigs = [
        // 1. Default: score_desc, no filters (exercises submissions_cohort_idx)
        `${base}?limit=50`,
        // 2. severity_min=high
        `${base}?severity_min=high&limit=50`,
        // 3. severity_min=medium
        `${base}?severity_min=medium&limit=50`,
        // 4. assignment filter
        `${base}?assignment_id=${assignmentIds[0]!}&limit=50`,
        // 5. validation_status=fail
        `${base}?validation_status=fail&limit=50`,
        // 6. score range
        `${base}?score_min=5&score_max=15&limit=50`,
        // 7. student filter
        `${base}?student_id=${studentIds[0]!}&limit=50`,
        // 8. include_superseded=true
        `${base}?include_superseded=true&limit=50`,
        // 9. sort=ingested_desc
        `${base}?sort=ingested_desc&limit=50`,
        // 10. sort=student_asc + severity_min=low
        `${base}?sort=student_asc&severity_min=low&limit=50`,
      ];

      const latencies: number[] = [];
      let slowestUrl = '';
      let slowestMs = 0;

      for (const url of requestConfigs) {
        const t0 = performance.now();
        const res = await app.fetch(new Request(url, { headers: { Cookie: cookie } }));
        const ms = performance.now() - t0;

        expect(res.status).toBe(200);
        await res.json(); // consume body to include serialization

        latencies.push(ms);
        console.log(`[perf] ${ms.toFixed(1)}ms  ${url.replace(base, '')}`);

        if (ms > slowestMs) {
          slowestMs = ms;
          slowestUrl = url;
        }
      }

      const p95ms = p95(latencies);
      const maxMs = Math.max(...latencies);
      const meanMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;

      console.log(
        `[perf] p95=${p95ms.toFixed(1)}ms  max=${maxMs.toFixed(1)}ms  mean=${meanMs.toFixed(1)}ms`,
      );

      // -----------------------------------------------------------------------
      // 8. If budget missed: capture EXPLAIN ANALYZE for diagnostics
      // -----------------------------------------------------------------------
      if (p95ms >= 300) {
        console.warn(`[perf] BUDGET MISSED: p95=${p95ms.toFixed(1)}ms >= 300ms`);
        console.warn(`[perf] Slowest request: ${slowestUrl}`);

        // Run EXPLAIN ANALYZE on the slowest query path via raw SQL.
        // We approximate it as the default cohort list query which is what the
        // planner actually runs.
        try {
          const explainRows = await db.execute(
            sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
                SELECT s.id
                FROM submissions s
                WHERE s.semester_id = ${semesterId}
                  AND s.superseded_by_submission_id IS NULL
                ORDER BY s.score_total DESC, s.id DESC
                LIMIT 50`,
          );
          const plan = explainRows
            .map((r: Record<string, unknown>) => Object.values(r)[0])
            .join('\n');
          console.warn('[perf] EXPLAIN ANALYZE (default sort path):\n' + plan);
        } catch (e) {
          console.warn('[perf] Could not capture EXPLAIN ANALYZE:', e);
        }
      }

      // -----------------------------------------------------------------------
      // 9. Assert budget
      // -----------------------------------------------------------------------
      expect(
        p95ms,
        `p95 latency ${p95ms.toFixed(1)}ms exceeded 300ms budget (PRD §16.1). ` +
          `See EXPLAIN ANALYZE output above and denormalization proposal in this file.`,
      ).toBeLessThan(300);
    });
  });
});
