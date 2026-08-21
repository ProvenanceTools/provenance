/**
 * End-to-end test for the worker's cooperative-cancellation gate.
 *
 * Cancelling an ingest job only flips `ingest_jobs.status='cancelled'`; the
 * per-file pg-boss jobs may already be queued (and pg-boss replays them across
 * a server restart). The worker MUST therefore check the parent job's status
 * before processing a file, and — when the job is cancelled — discard the
 * still-pending file WITHOUT creating a submission. This proves "stop actually
 * stops", including the restart-replay path.
 *
 * Mirrors worker-hint.e2e.test.ts for setup.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { withTestMinio } from '../../test/helpers/minio.js';
import { _setConfigForTest, _resetConfigForTest, getConfig } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { _resetDbForTest } from '../db/client.js';
import { _resetBossForTest, getBoss, JOB_KINDS } from './pg-boss.js';
import { parseEnv } from '../config/env.js';
import {
  users,
  courses,
  semesters,
  roster_entries,
  ingest_files,
  ingest_jobs,
  submissions,
} from '../db/schema.js';
import * as schema from '../db/schema.js';
import { startWorker } from './worker.js';
import { enqueueIngestJob, cancelIngestJob } from '../services/ingest/job-control.js';
import { stageBlob } from '../services/ingest/stage-blob.js';
import { createStorageClient, storageConfigFromEnv } from '../services/storage/client.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import type { DrizzleDb } from '../db/client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 120_000;

/** Poll until the file reaches the expected status (or time out). */
async function waitForFileStatus(
  db: DrizzleDb,
  fileId: string,
  expected: string,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const [row] = await db
      .select({ status: ingest_files.status })
      .from(ingest_files)
      .where(eq(ingest_files.id, fileId));
    if (row && row.status === expected) {
      return row.status;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

describe('worker cooperative-cancellation gate', () => {
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

    dbSql = postgres(pgContainer.getConnectionUri(), { max: 5 });
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

  it('discards a pending file and creates no submission when the parent job is cancelled', async () => {
    await withTestMinio(async ({ client, bucketName }) => {
      const minioEndpoint = client.bucketUrl.replace(`/${bucketName}`, '');
      _setConfigForTest(
        parseEnv({
          NODE_ENV: 'test',
          PUBLIC_BASE_URL: 'http://localhost:3000',
          DATABASE_URL: pgContainer.getConnectionUri(),
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

      // Seed a roster entry whose sid is embedded in the filename, so that —
      // absent the cancellation gate — this file WOULD match and create a
      // submission. That makes this a true regression test for the gate.
      const userId = crypto.randomUUID();
      await db.insert(users).values({
        id: userId,
        google_subject: `sub-${userId}`,
        email: `admin-${userId}@berkeley.edu`,
        display_name: 'Admin',
      });
      const [course] = await db
        .insert(courses)
        .values({ name: 'CS 61A', slug: `cs61a-${crypto.randomUUID().slice(0, 8)}` })
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
      await db
        .insert(roster_entries)
        .values({ semester_id: semester!.id, sid: '111111', display_name: 'Student A' });

      const { zipBuffer } = await buildTestBundle({
        assignmentId: 'proj02',
        semester: 'fa2024',
        sessions: [{ eventCount: 3 }],
      });
      const bundleBytes = new Uint8Array(zipBuffer);

      const { jobId } = await enqueueIngestJob(db, semester!.id, userId);

      // Stage a pending file that would otherwise match student 111111.
      const storageClient = createStorageClient(storageConfigFromEnv(getConfig()));
      const fileId = crypto.randomUUID();
      const { blobSha256, sizeBytes } = await stageBlob(
        { storageClient },
        { jobId, ingestFileId: fileId, body: bundleBytes.buffer as ArrayBuffer },
      );
      await db.insert(ingest_files).values({
        id: fileId,
        ingest_job_id: jobId,
        original_filename: 'proj02-111111.zip',
        size_bytes: sizeBytes,
        blob_sha256: blobSha256,
        status: 'pending',
      });

      // Cancel the job BEFORE the worker ever sees the file — this is the
      // "stopped, then restarted" scenario: pg-boss still has the queued job.
      const cancelResult = await cancelIngestJob(db, jobId, semester!.id);
      expect(cancelResult.cancelled).toBe(true);

      // Now bring the worker up and replay the queued file job.
      workerStop = await startWorker();
      const boss = await getBoss();
      await boss.send(JOB_KINDS.INGEST_FILE, { ingestFileId: fileId, ingestJobId: jobId });

      // The worker must discard the file rather than process it.
      const fileStatus = await waitForFileStatus(db, fileId, 'discarded');
      expect(fileStatus).toBe('discarded');

      const [fileRow] = await db
        .select({ status: ingest_files.status, error: ingest_files.error })
        .from(ingest_files)
        .where(eq(ingest_files.id, fileId));
      expect(fileRow!.status).toBe('discarded');
      expect(fileRow!.error).toMatchObject({ cause: 'ingest_job_cancelled' });

      // No submission was created.
      const subs = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.semester_id, semester!.id));
      expect(subs).toHaveLength(0);

      // The job remains cancelled (never flipped back to running/succeeded).
      const [jobRow] = await db
        .select({ status: ingest_jobs.status })
        .from(ingest_jobs)
        .where(eq(ingest_jobs.id, jobId));
      expect(jobRow!.status).toBe('cancelled');
    });
  });
});
