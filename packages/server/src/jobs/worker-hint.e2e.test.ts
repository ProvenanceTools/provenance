/**
 * End-to-end test for the worker's match-hint path (Gradescope export ingest).
 *
 * When an ingest_files row carries `match_sid`, the worker must:
 *   - match the bundle to the roster by that sid (NOT the filename_convention),
 *   - take the assignment from the signed bundle manifest,
 *   - dedup per (semester, blob) so two co-submitters of ONE group bundle
 *     (identical blob bytes) end up on ONE submission carrying both of them as
 *     contributors — the second resolves as `duplicate` and is ATTACHED, not
 *     fanned out into a second row and a second copy of the blob (D9,
 *     migration 0029),
 *   - and route an unknown sid to the unmatched tray.
 *
 * Until 0029 this file asserted the opposite: two submissions, one per
 * co-submitter, "no duplicate collapse". The artifact is not duplicated any
 * more; the PERSON still must not be lost, and that is what is asserted here.
 *
 * This stages blobs + ingest_files rows directly (the route is built in a later
 * phase) and drives the real worker through pg-boss, mirroring ingest-e2e.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  submission_contributors,
} from '../db/schema.js';
import * as schema from '../db/schema.js';
import { startWorker } from './worker.js';
import { enqueueIngestJob } from '../services/ingest/job-control.js';
import { stageBlob } from '../services/ingest/stage-blob.js';
import { createStorageClient, storageConfigFromEnv } from '../services/storage/client.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import type { DrizzleDb } from '../db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 120_000;

/** Stage a bundle blob + create an ingest_files row carrying a match hint. */
async function stageHintedFile(
  db: DrizzleDb,
  jobId: string,
  bundleBytes: Uint8Array,
  matchSid: string | null,
): Promise<string> {
  const storageClient = createStorageClient(storageConfigFromEnv(getConfig()));
  const fileId = crypto.randomUUID();
  const { blobSha256, sizeBytes } = await stageBlob(
    { storageClient },
    { jobId, ingestFileId: fileId, body: bundleBytes.buffer as ArrayBuffer },
  );
  await db.insert(ingest_files).values({
    id: fileId,
    ingest_job_id: jobId,
    original_filename: matchSid === null ? 'submission_000.zip' : `submission_${matchSid}.zip`,
    size_bytes: sizeBytes,
    blob_sha256: blobSha256,
    status: 'pending',
    match_sid: matchSid,
  });
  return fileId;
}

async function waitForJobTerminal(db: DrizzleDb, jobId: string): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const [jobRow] = await db
      .select({ status: ingest_jobs.status })
      .from(ingest_jobs)
      .where(eq(ingest_jobs.id, jobId));
    if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
      return jobRow.status;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

describe('worker match-hint path (Gradescope export ingest)', () => {
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

  it('puts two co-submitters of one group bundle on ONE submission, both attached as contributors', async () => {
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

      // Seed user + course + semester + two roster entries (the two submitters).
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
          // A convention that would NOT match the filenames below — proving the
          // hint path bypasses it entirely.
          filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
        })
        .returning();
      const [studentA] = await db
        .insert(roster_entries)
        .values({ semester_id: semester!.id, sid: '111111', display_name: 'Student A' })
        .returning();
      const [studentB] = await db
        .insert(roster_entries)
        .values({ semester_id: semester!.id, sid: '222222', display_name: 'Student B' })
        .returning();

      // ONE group bundle — identical bytes staged once per co-submitter.
      const { zipBuffer } = await buildTestBundle({
        assignmentId: 'proj02',
        semester: 'fa2024',
        sessions: [{ eventCount: 3 }],
      });
      const bundleBytes = new Uint8Array(zipBuffer);

      workerStop = await startWorker();

      const { jobId } = await enqueueIngestJob(db, semester!.id, userId);
      const fileA = await stageHintedFile(db, jobId, bundleBytes, '111111');
      const fileB = await stageHintedFile(db, jobId, bundleBytes, '222222');

      const boss = await getBoss();
      await boss.send(JOB_KINDS.INGEST_FILE, { ingestFileId: fileA, ingestJobId: jobId });
      await boss.send(JOB_KINDS.INGEST_FILE, { ingestFileId: fileB, ingestJobId: jobId });

      const finalStatus = await waitForJobTerminal(db, jobId);
      expect(finalStatus).toBe('succeeded');

      const fileRows = await db
        .select({
          id: ingest_files.id,
          status: ingest_files.status,
          matched_student_id: ingest_files.matched_student_id,
          submission_id: ingest_files.submission_id,
        })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId));
      expect(fileRows).toHaveLength(2);

      const rowA = fileRows.find((r) => r.id === fileA)!;
      const rowB = fileRows.find((r) => r.id === fileB)!;

      // The EXACT status multiset: one creates the submission, the other is a
      // duplicate of it. Which one wins is a race — the worker drains the batch
      // with `Promise.all` up to INGEST_CONCURRENCY — so this is asserted as a
      // sorted pair rather than per row.
      //
      // Deliberately not `every(s => s === 'matched' || s === 'duplicate')`:
      // that spelling passes both when the fan-out is gone AND when it comes
      // back, which makes it no test at all. `['duplicate','matched']` fails on
      // two matched (fan-out reinstated) and on two duplicates (the first
      // submitter's own submission lost).
      expect([rowA.status, rowB.status].sort()).toEqual(['duplicate', 'matched']);

      // NEITHER row loses its student. The duplicate above all: it is the row
      // whose person exists only in `matched_student_id` and in the contributor
      // table, so a null here — or the other partner's id — is the co-submitter
      // being silently erased (census scenario S20) while the job still reports
      // `succeeded`.
      expect(rowA.matched_student_id).toBe(studentA!.id);
      expect(rowB.matched_student_id).toBe(studentB!.id);

      // Both point at the SAME submission. The old assertion here was
      // `not.toBe` — the fan-out — and its requirement (the second submitter is
      // not dropped) is now carried by the two assertions above plus the
      // contributor rows below, which is strictly more than it checked.
      expect(rowA.submission_id).not.toBeNull();
      expect(rowB.submission_id).toBe(rowA.submission_id);

      // ONE submission for one artifact — not two rows and two copies of one
      // blob. Two rows here is the fan-out returning.
      const subs = await db
        .select({ id: submissions.id, student_id: submissions.student_id })
        .from(submissions)
        .where(eq(submissions.semester_id, semester!.id));
      expect(subs).toHaveLength(1);
      expect(subs[0]!.id).toBe(rowA.submission_id);

      // The submitter of record is the LOWER sid of the two co-submitters —
      // whichever side of the race won.
      //
      // This assertion used to read `subs[0].student_id === the row that won`,
      // which pinned the defect rather than a requirement: the winner is a
      // `Promise.all` race, so it made "the student" an arbitrary one of two
      // people and made a re-ingest of the same export able to name the other
      // one. It is not weakened here, it is inverted: the outcome is now
      // asserted against a value fixed OUTSIDE the race (`roster_entries.sid`,
      // which the institution assigns), so it fails if either order produces
      // anything else. Student A's sid is '111111' and B's is '222222'.
      expect(subs[0]!.student_id).toBe(studentA!.id);

      // The load-bearing assertion: BOTH people are contributors on that one
      // submission. Exactly two rows — one per human. `attachCoSubmitter` going
      // no-op, or upserting the co-submitter onto the wrong key, shows up here
      // and nowhere else, because every status column above still looks healthy
      // when the contributor is lost.
      const contribRows = await db
        .select({
          submission_id: submission_contributors.submission_id,
          roster_entry_id: submission_contributors.roster_entry_id,
          kind: submission_contributors.kind,
          is_submitter: submission_contributors.is_submitter,
        })
        .from(submission_contributors)
        .where(eq(submission_contributors.semester_id, semester!.id));
      expect(contribRows).toHaveLength(2);
      expect(contribRows.every((c) => c.submission_id === subs[0]!.id)).toBe(true);
      expect(new Set(contribRows.map((c) => c.roster_entry_id))).toEqual(
        new Set([studentA!.id, studentB!.id]),
      );
      for (const contrib of contribRows) {
        expect(contrib.kind).toBe('roster');
        expect(contrib.is_submitter).toBe(true);
      }
    });
  });

  it('routes an unknown match_sid to the unmatched tray', async () => {
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
      // Note: no roster entry for sid '999999'.

      const { zipBuffer } = await buildTestBundle({
        assignmentId: 'proj02',
        semester: 'fa2024',
        sessions: [{ eventCount: 3 }],
      });
      const bundleBytes = new Uint8Array(zipBuffer);

      workerStop = await startWorker();

      const { jobId } = await enqueueIngestJob(db, semester!.id, userId);
      const fileId = await stageHintedFile(db, jobId, bundleBytes, '999999');

      const boss = await getBoss();
      await boss.send(JOB_KINDS.INGEST_FILE, { ingestFileId: fileId, ingestJobId: jobId });

      const finalStatus = await waitForJobTerminal(db, jobId);
      expect(['partial', 'failed', 'succeeded']).toContain(finalStatus);

      const [row] = await db
        .select({ status: ingest_files.status, error: ingest_files.error })
        .from(ingest_files)
        .where(eq(ingest_files.id, fileId));
      expect(row!.status).toBe('unmatched');
      expect(row!.error).toMatchObject({ phase: 'match_student', cause: 'unknown_sid' });

      const subs = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.semester_id, semester!.id));
      expect(subs).toHaveLength(0);
    });
  });
});
