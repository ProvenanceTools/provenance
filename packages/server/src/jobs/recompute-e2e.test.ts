/**
 * End-to-end recompute pipeline test: POST /recompute → worker processes → status='succeeded'.
 *
 * Phase 13b review (C-Quality-2):
 *   - An ingested submission exists (flags from ingest pipeline).
 *   - POST /recompute against the active config triggers recompute_semester.
 *   - Worker processes recompute_submission jobs.
 *   - recompute_jobs.status reaches 'succeeded'.
 *   - All non-superseded submissions have recompute_status='fresh'.
 *
 * Mirrors the ingest-e2e.test.ts pattern: real pg-boss + testcontainers,
 * no mocks.
 *
 * Also covers RECOMPUTE_MAX_PARALLEL (jobs/recompute.ts): with batchSize > 1,
 * several submissions recompute concurrently in one worker invocation. The
 * "concurrent recomputes match sequential" test below ingests several
 * submissions, recomputes them all at once with RECOMPUTE_MAX_PARALLEL > 1,
 * and checks each submission's persisted score/flags against an independent
 * simulate=true computation of the same submission — a duplicated flag row or
 * a value borrowed from a different concurrently-running submission would
 * show up as a mismatch there.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq, and, sql } from 'drizzle-orm';
import { withTestMinio } from '../../test/helpers/minio.js';
import { _setConfigForTest, _resetConfigForTest, getConfig } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { _resetDbForTest } from '../db/client.js';
import { _resetBossForTest } from './pg-boss.js';
import { parseEnv } from '../config/env.js';
import { createV1App } from '../api/v1/index.js';
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
  heuristic_configs,
  recompute_jobs,
  per_file_stats,
  flags,
} from '../db/schema.js';
import * as schema from '../db/schema.js';
import { startWorker } from './worker.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import type { DrizzleDb } from '../db/client.js';
import { recomputeSubmission } from '../services/scoring/recompute-submission.js';
import { createStorageClient, storageConfigFromEnv } from '../services/storage/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

// ---------------------------------------------------------------------------
// Helper: build a real bundle ZIP
// ---------------------------------------------------------------------------

async function makeRealBundleBytes(opts: { assignmentId: string; semester: string }): Promise<{
  bytes: Uint8Array;
}> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId: opts.assignmentId,
    semester: opts.semester,
    sessions: [{ eventCount: 3 }],
  });
  return { bytes: new Uint8Array(zipBuffer) };
}

// ---------------------------------------------------------------------------
// Test: one Postgres container per test for isolation.
// ---------------------------------------------------------------------------

describe('recompute e2e pipeline (POST /recompute → worker → status=succeeded)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let dbSql: postgres.Sql;
  let db: DrizzleDb;
  let workerStop: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('provenance_test')
      .withUsername('test')
      .withPassword('test')
      .start();

    const connectionString = pgContainer.getConnectionUri();
    dbSql = postgres(connectionString, { max: 5 });
    db = drizzle(dbSql, { schema }) as DrizzleDb;
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

    _resetConfigForTest();
    _resetLoggerForTest();
    await _resetDbForTest();
    _resetBossForTest();
  });

  afterEach(async () => {
    if (workerStop !== null) {
      await workerStop();
      workerStop = null;
    }
    _resetConfigForTest();
    _resetLoggerForTest();
    await _resetDbForTest();
    _resetBossForTest();
    await dbSql.end();
    await pgContainer.stop();
  });

  it('recomputes ingested submission to succeeded with recompute_status=fresh', async () => {
    await withTestMinio(async ({ client, bucketName }) => {
      const connectionString = pgContainer.getConnectionUri();
      const minioEndpoint = client.bucketUrl.replace(`/${bucketName}`, '');

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
          AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-recompute-e2e-1234567',
          SESSION_TTL_DAYS: '14',
          INGEST_MAX_BUNDLE_BYTES: '52428800',
          INGEST_MAX_BATCH_BYTES: '5368709120',
          INGEST_MAX_BATCH_FILES: '10000',
        }),
      );

      // Seed domain data.
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

      await db.insert(roster_entries).values({
        semester_id: semester!.id,
        sid: '123456',
        display_name: 'Test Student',
      });

      // Insert a heuristic_configs row (active v1) so createRecomputeJob can find it.
      const { DEFAULT_SERVER_CONFIG } = await import('../services/heuristics/config.js');
      const [configRow] = await db
        .insert(heuristic_configs)
        .values({
          semester_id: semester!.id,
          version: 1,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb
          config: DEFAULT_SERVER_CONFIG as any,
          set_by: userId,
          is_active: true,
          note: 'e2e test config',
        })
        .returning();

      // Build + ingest a real bundle so there's a submission with events+flags.
      const { bytes: bundleBytes } = await makeRealBundleBytes({
        assignmentId: 'hw01',
        semester: 'fa2024',
      });
      const filename = 'hw01-123456.zip';

      // Start the worker.
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
      const { job_id: ingestJobId } = (await ingestRes.json()) as { job_id: string };

      // Wait for ingest to finish.
      const POLL_INTERVAL_MS = 500;
      const POLL_TIMEOUT_MS = 90_000;
      let ingestFinalStatus: string | null = null;
      const ingestStart = Date.now();
      while (Date.now() - ingestStart < POLL_TIMEOUT_MS) {
        const [jobRow] = await db
          .select({ status: ingest_jobs.status })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, ingestJobId));
        if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
          ingestFinalStatus = jobRow.status;
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      expect(ingestFinalStatus, 'Ingest job must reach terminal status').toBe('succeeded');

      // Verify ingest produced a submission.
      const [fileRow] = await db
        .select({ submission_id: ingest_files.submission_id })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, ingestJobId));
      expect(fileRow?.submission_id).toBeTruthy();
      const submissionId = fileRow!.submission_id!;

      // -----------------------------------------------------------------------
      // Poison per_file_stats to stand in for "derived by an older analyzer".
      //
      // These columns used to be written only at ingest, so a recompute that
      // revised the flags left them frozen — the Source tab kept calling a
      // now-clean reconstruction tainted, and the Stats panel kept attributing
      // characters to external writes that had been reclassified away. The
      // recompute must rewrite them.
      // -----------------------------------------------------------------------
      const statsBefore = await db
        .select()
        .from(per_file_stats)
        .where(eq(per_file_stats.submission_id, submissionId));
      expect(statsBefore.length, 'ingest must have written per_file_stats').toBeGreaterThan(0);
      const poisonedPath = statsBefore[0]!.file_path;

      await db
        .update(per_file_stats)
        .set({ reconstruction_tainted: true, chars_external_change_delta: 9999, chars_typed: 1 })
        .where(eq(per_file_stats.submission_id, submissionId));

      // -----------------------------------------------------------------------
      // POST /recompute against the active config.
      // -----------------------------------------------------------------------
      const recomputeRes = await app.fetch(
        new Request(`http://localhost/semesters/${semester!.id}/recompute`, {
          method: 'POST',
          headers: {
            Cookie: `__Host-prov_sess=${sessionToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ note: 'e2e recompute test' }),
        }),
      );
      expect(recomputeRes.status).toBe(200);
      const recomputeBody = (await recomputeRes.json()) as {
        recompute_job: { id: string; status: string };
      };
      const recomputeJobId = recomputeBody.recompute_job.id;
      expect(recomputeJobId).toBeTruthy();

      // Poll GET /recompute/:jobId until terminal.
      let recomputeFinalStatus: string | null = null;
      const recomputeStart = Date.now();
      while (Date.now() - recomputeStart < POLL_TIMEOUT_MS) {
        const getRes = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}/recompute/${recomputeJobId}`, {
            headers: { Cookie: `__Host-prov_sess=${sessionToken}` },
          }),
        );
        expect(getRes.status).toBe(200);
        const getBody = (await getRes.json()) as {
          status: string;
          progress_done: number;
          progress_total: number;
          progress_failed: number;
        };

        if (getBody.status !== 'queued' && getBody.status !== 'running') {
          recomputeFinalStatus = getBody.status;
          // Assert final progress state.
          expect(getBody.progress_done, 'progress_done must equal progress_total').toBe(
            getBody.progress_total,
          );
          expect(getBody.progress_failed, 'progress_failed must be 0').toBe(0);
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      expect(recomputeFinalStatus, `Recompute job never reached terminal status (timed out)`).toBe(
        'succeeded',
      );

      // Assert all non-superseded submissions have recompute_status='fresh'.
      const subsRows = await db
        .select({ id: submissions.id, recompute_status: submissions.recompute_status })
        .from(submissions)
        .where(and(eq(submissions.semester_id, semester!.id), eq(submissions.id, submissionId)));
      expect(subsRows).toHaveLength(1);
      expect(subsRows[0]!.recompute_status).toBe('fresh');

      // Assert a recompute_jobs row with target_config_id matching the active config.
      const [rjRow] = await db
        .select({ target_config_id: recompute_jobs.target_config_id })
        .from(recompute_jobs)
        .where(eq(recompute_jobs.id, recomputeJobId));
      expect(rjRow!.target_config_id).toBe(configRow!.id);

      // Assert per_file_stats was rewritten back to the values the bundle
      // actually implies, not left at the poisoned ones.
      const [statsAfter] = await db
        .select()
        .from(per_file_stats)
        .where(
          and(
            eq(per_file_stats.submission_id, submissionId),
            eq(per_file_stats.file_path, poisonedPath),
          ),
        );
      const expected = statsBefore.find((r) => r.file_path === poisonedPath)!;
      expect(statsAfter!.reconstruction_tainted).toBe(expected.reconstruction_tainted);
      expect(statsAfter!.chars_external_change_delta).toBe(expected.chars_external_change_delta);
      expect(statsAfter!.chars_typed).toBe(expected.chars_typed);
    });
  });

  it(
    'RECOMPUTE_MAX_PARALLEL: concurrent recomputes produce the same result as an ' +
      'independent sequential recompute of each submission',
    async () => {
      await withTestMinio(async ({ client, bucketName }) => {
        const connectionString = pgContainer.getConnectionUri();
        const minioEndpoint = client.bucketUrl.replace(`/${bucketName}`, '');

        // RECOMPUTE_MAX_PARALLEL=3 with 6 submissions forces at least two
        // batches of genuinely concurrent recompute_submission processing.
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
            AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-recompute-e2e-1234567',
            SESSION_TTL_DAYS: '14',
            INGEST_MAX_BUNDLE_BYTES: '52428800',
            INGEST_MAX_BATCH_BYTES: '5368709120',
            INGEST_MAX_BATCH_FILES: '10000',
            RECOMPUTE_MAX_PARALLEL: '3',
          }),
        );

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

        const SUBMISSION_COUNT = 6;
        const sids = Array.from({ length: SUBMISSION_COUNT }, (_, i) =>
          `20000${i}`.padStart(6, '0'),
        );
        for (const sid of sids) {
          await db.insert(roster_entries).values({
            semester_id: semester!.id,
            sid,
            display_name: `Student ${sid}`,
          });
        }

        const { DEFAULT_SERVER_CONFIG, normalizeStoredConfig } =
          await import('../services/heuristics/config.js');
        const [configRow] = await db
          .insert(heuristic_configs)
          .values({
            semester_id: semester!.id,
            version: 1,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb
            config: DEFAULT_SERVER_CONFIG as any,
            set_by: userId,
            is_active: true,
            note: 'concurrent-recompute test config',
          })
          .returning();

        // Build one INDEPENDENT bundle per submission (distinct session/event
        // ids), each with a large paste so ingest produces at least one flag —
        // an empty flag set would make a duplicate-row race invisible.
        workerStop = await startWorker();
        const app = createV1App();
        const formData = new FormData();
        // 250-char paste reliably fires large_paste (minChars=200 by default),
        // so every submission is guaranteed at least one flag row — an empty
        // flag set would make a duplicate-INSERT race invisible to the count
        // comparison below.
        const pasteContent = 'x'.repeat(250);
        for (const sid of sids) {
          const { zipBuffer } = await buildTestBundle({
            assignmentId: 'hw01',
            semester: 'fa2024',
            sessions: [
              {
                events: [
                  {
                    kind: 'paste',
                    data: {
                      path: '/hw1.py',
                      content: pasteContent,
                      length: pasteContent.length,
                      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                    },
                  },
                ],
              },
            ],
          });
          formData.append(
            'files[]',
            new Blob([zipBuffer], { type: 'application/zip' }),
            `hw01-${sid}.zip`,
          );
        }

        const ingestRes = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}/ingest`, {
            method: 'POST',
            headers: { Cookie: `__Host-prov_sess=${sessionToken}` },
            body: formData,
          }),
        );
        expect(ingestRes.status).toBe(202);
        const { job_id: ingestJobId } = (await ingestRes.json()) as { job_id: string };

        const POLL_INTERVAL_MS = 500;
        const POLL_TIMEOUT_MS = 90_000;
        let ingestFinalStatus: string | null = null;
        const ingestStart = Date.now();
        while (Date.now() - ingestStart < POLL_TIMEOUT_MS) {
          const [jobRow] = await db
            .select({ status: ingest_jobs.status })
            .from(ingest_jobs)
            .where(eq(ingest_jobs.id, ingestJobId));
          if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
            ingestFinalStatus = jobRow.status;
            break;
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        expect(ingestFinalStatus).toBe('succeeded');

        const fileRows = await db
          .select({ submission_id: ingest_files.submission_id })
          .from(ingest_files)
          .where(eq(ingest_files.ingest_job_id, ingestJobId));
        const submissionIds = fileRows.map((r) => r.submission_id!).filter(Boolean);
        expect(submissionIds).toHaveLength(SUBMISSION_COUNT);

        // -----------------------------------------------------------------------
        // POST /recompute against the active config — one recompute_semester job
        // enumerates all SUBMISSION_COUNT submissions and, per jobs/recompute.ts,
        // the worker processes them with batchSize=RECOMPUTE_MAX_PARALLEL=3, so
        // this exercises genuine concurrent recompute of DISTINCT submissions.
        // -----------------------------------------------------------------------
        const recomputeRes = await app.fetch(
          new Request(`http://localhost/semesters/${semester!.id}/recompute`, {
            method: 'POST',
            headers: {
              Cookie: `__Host-prov_sess=${sessionToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ note: 'concurrent recompute test' }),
          }),
        );
        expect(recomputeRes.status).toBe(200);
        const recomputeBody = (await recomputeRes.json()) as {
          recompute_job: { id: string; status: string };
        };
        const recomputeJobId = recomputeBody.recompute_job.id;

        let recomputeFinalStatus: string | null = null;
        const recomputeStart = Date.now();
        while (Date.now() - recomputeStart < POLL_TIMEOUT_MS) {
          const [jobRow] = await db
            .select({
              status: recompute_jobs.status,
              progress_done: recompute_jobs.progress_done,
              progress_total: recompute_jobs.progress_total,
              progress_failed: recompute_jobs.progress_failed,
            })
            .from(recompute_jobs)
            .where(eq(recompute_jobs.id, recomputeJobId));
          if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
            recomputeFinalStatus = jobRow.status;
            expect(jobRow.progress_done).toBe(SUBMISSION_COUNT);
            expect(jobRow.progress_failed).toBe(0);
            break;
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        expect(recomputeFinalStatus).toBe('succeeded');

        // -----------------------------------------------------------------------
        // Per submission: compare the CONCURRENTLY-persisted state against an
        // independent, uncontended simulate=true recompute of that submission
        // alone. If concurrency had caused cross-submission corruption or a
        // duplicated flags INSERT from an overlapping transaction, either the
        // persisted score/severity would disagree with the reference, or the
        // flags row COUNT would exceed the reference flag_count.
        // -----------------------------------------------------------------------
        const storage = createStorageClient(storageConfigFromEnv(getConfig()));
        for (const submissionId of submissionIds) {
          const reference = await recomputeSubmission(
            db,
            storage,
            submissionId,
            semester!.id,
            normalizeStoredConfig(DEFAULT_SERVER_CONFIG),
            configRow!.version,
            { simulate: true },
          );

          const [persisted] = await db
            .select({
              score_total: submissions.score_total,
              score_max_severity: submissions.score_max_severity,
              recompute_status: submissions.recompute_status,
              heuristic_config_version: submissions.heuristic_config_version,
            })
            .from(submissions)
            .where(eq(submissions.id, submissionId));

          expect(persisted?.recompute_status).toBe('fresh');
          expect(persisted?.heuristic_config_version).toBe(configRow!.version);
          expect(persisted?.score_total).toBe(reference.score_total);
          expect(persisted?.score_max_severity).toBe(reference.score_max_severity);

          const countRows = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(flags)
            .where(eq(flags.submission_id, submissionId));
          const count = countRows[0]?.count ?? 0;
          expect(count, `submission ${submissionId} must not have duplicated flag rows`).toBe(
            reference.flag_count,
          );
        }
      });
    },
  );
});
