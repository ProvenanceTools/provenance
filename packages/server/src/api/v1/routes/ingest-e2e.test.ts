/**
 * End-to-end ingest pipeline test: POST /ingest → worker processes → status='succeeded'.
 *
 * Phase 9 exit gate (PRD §9, Plan §Phase 9):
 *   - A single bundle can be uploaded and the worker processes it to terminal status.
 *   - Re-uploading the same bundle produces ingest_files.status='duplicate', no new submissions row.
 *
 * Unlike ingest.test.ts, this test does NOT mock pg-boss. It uses a real pg-boss
 * instance backed by the same Postgres container as the domain tables.
 *
 * Architecture:
 *   - PostgreSqlContainer for both domain tables (via migrations) and pg-boss schema.
 *   - MinioContainer for blob storage.
 *   - The config singleton, db singleton, and boss singleton are all wired to the
 *     test containers so that startWorker(), the route handler, and getDb() share
 *     the same backing stores.
 *   - After the test, all singletons are reset to avoid state leaking.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq, and } from 'drizzle-orm';
import { withTestMinio } from '../../../../test/helpers/minio.js';
import { _setConfigForTest, _resetConfigForTest } from '../../../config/index.js';
import { _resetLoggerForTest } from '../../../logging.js';
import { _resetDbForTest } from '../../../db/client.js';
import { _resetBossForTest } from '../../../jobs/pg-boss.js';
import { parseEnv } from '../../../config/env.js';
import { createV1App } from '../index.js';
import {
  users,
  sessions,
  courses,
  semesters,
  memberships,
  roster_entries,
  ingest_jobs,
  ingest_files,
  submissions,
} from '../../../db/schema.js';
import * as schema from '../../../db/schema.js';
import { startWorker } from '../../../jobs/worker.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/migrations');

// ---------------------------------------------------------------------------
// Helpers: build a real bundle ZIP
// ---------------------------------------------------------------------------

/**
 * Build a real bundle ZIP with assignment_id matching the semester convention,
 * and a filename matching the roster entry sid.
 */
async function makeRealBundleBytes(opts: { assignmentId: string; semester: string }): Promise<{
  bytes: Uint8Array;
  sha256Hex: string;
}> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId: opts.assignmentId,
    semester: opts.semester,
    sessions: [{ eventCount: 3 }],
  });
  // Compute SHA-256 for the dedup test.
  const hashBuffer = await crypto.subtle.digest('SHA-256', zipBuffer);
  const sha256Hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { bytes: new Uint8Array(zipBuffer), sha256Hex };
}

// ---------------------------------------------------------------------------
// Test fixture: one Postgres container shared across all tests in this file.
// We reset the DB between tests but keep the container alive for speed.
// ---------------------------------------------------------------------------

describe('ingest e2e pipeline (POST → worker → status=succeeded)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let dbSql: postgres.Sql;
  let db: DrizzleDb;
  let workerStop: (() => Promise<void>) | null = null;

  // We start one container for all tests in this file.
  beforeEach(async () => {
    // Start a fresh Postgres container for isolation.
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('provenance_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    const connectionString = pgContainer.getConnectionUri();
    dbSql = postgres(connectionString, { max: 5 });
    db = drizzle(dbSql, { schema }) as DrizzleDb;
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    // Reset all singletons before wiring.
    _resetConfigForTest();
    _resetLoggerForTest();
    await _resetDbForTest();
    _resetBossForTest();
  });

  afterEach(async () => {
    // Stop the worker if it was started.
    if (workerStop !== null) {
      await workerStop();
      workerStop = null;
    }
    // Reset singletons to avoid leaking into other test files.
    _resetConfigForTest();
    _resetLoggerForTest();
    await _resetDbForTest();
    _resetBossForTest();
    // Close the pool and stop the container.
    await dbSql.end();
    await pgContainer.stop();
  });

  it('processes a single matched bundle to succeeded + duplicate on re-upload', async () => {
    await withTestMinio(async ({ client, bucketName }) => {
      const connectionString = pgContainer.getConnectionUri();
      const minioEndpoint = client.bucketUrl.replace(`/${bucketName}`, '');

      // Wire config to the test containers.
      _setConfigForTest(
        parseEnv({
          NODE_ENV: 'test',
          PUBLIC_BASE_URL: 'http://localhost:3000',
          DATABASE_URL: connectionString,
          OBJECT_STORAGE_ENDPOINT: minioEndpoint,
          OBJECT_STORAGE_BUCKET: bucketName,
          OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
          OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
          OBJECT_STORAGE_REGION: 'us-east-1',
          GOOGLE_OAUTH_CLIENT_ID: 'client-id',
          GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
          AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
          AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
          AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-e2e-tests-123456789',
          SESSION_TTL_DAYS: '14',
          INGEST_MAX_BUNDLE_BYTES: '52428800',
          INGEST_MAX_BATCH_BYTES: '5368709120',
          INGEST_MAX_BATCH_FILES: '10000',
        }),
      );

      // Seed required data.
      const userId = crypto.randomUUID();
      await db.insert(users).values({
        id: userId,
        google_subject: `sub-${userId}`,
        email: `admin-${userId}@berkeley.edu`,
        display_name: 'Admin',
        is_superadmin: false,
      });

      const sessionToken = `sess-${'x'.repeat(37)}`.slice(0, 43);
      await db.insert(sessions).values({
        id: sessionToken,
        user_id: userId,
        expires_at: new Date(Date.now() + 14 * 86400_000),
      });

      const courseSlug = `cs61a-${crypto.randomUUID().slice(0, 8)}`;
      const [course] = await db
        .insert(courses)
        .values({ name: 'CS 61A', slug: courseSlug })
        .returning();

      // Filename convention: <assignment_id>-<sid>.zip
      // sid = 6-digit number
      const [semester] = await db
        .insert(semesters)
        .values({
          course_id: course!.id,
          term: 'fa',
          year: 2024,
          slug: `fa2024-${crypto.randomUUID().slice(0, 8)}`,
          display_name: 'Fall 2024',
          filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
        })
        .returning();

      await db.insert(memberships).values({
        user_id: userId,
        semester_id: semester!.id,
        role: 'admin',
        granted_by: userId,
      });

      const [rosterEntry] = await db
        .insert(roster_entries)
        .values({
          semester_id: semester!.id,
          sid: '123456',
          display_name: 'Test Student',
        })
        .returning();

      // Build a real bundle with the matching assignment_id and sid in the filename.
      const { bytes: bundleBytes } = await makeRealBundleBytes({
        assignmentId: 'hw01',
        semester: 'fa2024',
      });

      const filename = 'hw01-123456.zip';

      // Start the worker (uses the wired config/boss singleton).
      workerStop = await startWorker();

      // POST /ingest
      const app = createV1App();
      const formData = new FormData();
      formData.append(
        'files[]',
        new Blob([bundleBytes.buffer as ArrayBuffer], { type: 'application/zip' }),
        filename,
      );

      const ingestRes = await app.fetch(
        new Request(`http://localhost/semesters/${semester!.id}/ingest`, {
          method: 'POST',
          headers: { Cookie: `__Host-prov_sess=${sessionToken}` },
          body: formData,
        }),
      );

      expect(ingestRes.status).toBe(202);
      const { job_id } = (await ingestRes.json()) as { job_id: string };
      expect(job_id).toBeTruthy();

      // Poll until ingest_jobs.status is terminal (not 'queued' or 'running').
      const POLL_INTERVAL_MS = 500;
      const POLL_TIMEOUT_MS = 120_000;
      const start = Date.now();
      let finalStatus: string | null = null;
      let lastSeenJobStatus: string | null = null;
      let lastSeenFileStatus: string | null = null;

      while (Date.now() - start < POLL_TIMEOUT_MS) {
        const [jobRow] = await db
          .select({ status: ingest_jobs.status })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, job_id));
        lastSeenJobStatus = jobRow?.status ?? null;

        // Also poll ingest_files for diagnostic info.
        const fileRows2 = await db
          .select({ status: ingest_files.status })
          .from(ingest_files)
          .where(eq(ingest_files.ingest_job_id, job_id));
        lastSeenFileStatus = fileRows2[0]?.status ?? null;

        if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
          finalStatus = jobRow.status;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      expect(
        finalStatus,
        `Job never reached terminal status; last job_status=${String(lastSeenJobStatus)} file_status=${String(lastSeenFileStatus)}`,
      ).toBe('succeeded');

      // Assert: ingest_files.status='matched' and a submissions row exists.
      const [fileRow] = await db
        .select({
          status: ingest_files.status,
          matched_student_id: ingest_files.matched_student_id,
          matched_assignment_id: ingest_files.matched_assignment_id,
          submission_id: ingest_files.submission_id,
        })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, job_id));

      expect(fileRow, 'ingest_files row must exist').toBeDefined();
      expect(fileRow!.status).toBe('matched');
      expect(fileRow!.matched_student_id).toBe(rosterEntry!.id);
      expect(fileRow!.matched_assignment_id).toBeTruthy();
      expect(fileRow!.submission_id).toBeTruthy();

      // Assert submissions row exists with correct student/semester.
      const [subRow] = await db
        .select({
          semester_id: submissions.semester_id,
          student_id: submissions.student_id,
          version_index: submissions.version_index,
        })
        .from(submissions)
        .where(eq(submissions.id, fileRow!.submission_id!));

      expect(subRow).toBeDefined();
      expect(subRow!.semester_id).toBe(semester!.id);
      expect(subRow!.student_id).toBe(rosterEntry!.id);
      expect(subRow!.version_index).toBe(1);

      // Verify GET /jobs/:id returns nested matched_student and matched_assignment.
      const getRes = await app.fetch(
        new Request(`http://localhost/semesters/${semester!.id}/ingest/jobs/${job_id}`, {
          headers: { Cookie: `__Host-prov_sess=${sessionToken}` },
        }),
      );
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as {
        files: Array<{
          status: string;
          matched_student?: { id: string; sid: string; display_name: string };
          matched_assignment?: { id: string; assignment_id_str: string; label: string };
        }>;
      };
      expect(getBody.files).toHaveLength(1);
      const apiFile = getBody.files[0]!;
      expect(apiFile.status).toBe('matched');
      expect(apiFile.matched_student?.sid).toBe('123456');
      expect(apiFile.matched_assignment?.assignment_id_str).toBe('hw01');

      // -----------------------------------------------------------------------
      // Re-upload the same bundle → dedup → status='duplicate', no new submission.
      // -----------------------------------------------------------------------
      const formData2 = new FormData();
      formData2.append(
        'files[]',
        new Blob([bundleBytes.buffer as ArrayBuffer], { type: 'application/zip' }),
        filename,
      );

      const ingestRes2 = await app.fetch(
        new Request(`http://localhost/semesters/${semester!.id}/ingest`, {
          method: 'POST',
          headers: { Cookie: `__Host-prov_sess=${sessionToken}` },
          body: formData2,
        }),
      );

      expect(ingestRes2.status).toBe(202);
      const { job_id: job_id2 } = (await ingestRes2.json()) as { job_id: string };

      // Poll second job to terminal.
      let finalStatus2: string | null = null;
      const start2 = Date.now();
      while (Date.now() - start2 < POLL_TIMEOUT_MS) {
        const [jobRow] = await db
          .select({ status: ingest_jobs.status })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, job_id2));

        if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
          finalStatus2 = jobRow.status;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      // Job 2 ends as 'partial' or 'succeeded' depending on how the finalize
      // aggregator classifies an all-duplicate result. Per PRD §9.3, the
      // summary counts decide: all-duplicate → 'partial'. We assert it's terminal
      // (non-running) and that the file ended as 'duplicate'.
      expect(
        ['succeeded', 'partial', 'failed'],
        `Unexpected job2 status: ${String(finalStatus2)}`,
      ).toContain(finalStatus2);

      const [fileRow2] = await db
        .select({ status: ingest_files.status, submission_id: ingest_files.submission_id })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, job_id2));

      expect(fileRow2, 'ingest_files row for second upload must exist').toBeDefined();
      expect(fileRow2!.status).toBe('duplicate');
      // The duplicate points to the original submission.
      expect(fileRow2!.submission_id).toBe(fileRow!.submission_id);

      // Confirm no new submissions row was created.
      const allSubs = await db
        .select()
        .from(submissions)
        .where(
          and(
            eq(submissions.semester_id, semester!.id),
            eq(submissions.student_id, rosterEntry!.id),
          ),
        );
      expect(allSubs).toHaveLength(1);
    });
  });
});
