/**
 * End-to-end test for the stage-upload-job service: pre-create an ingest job,
 * call stageUploadIntoJob (the worker's body), then poll for terminal status.
 *
 * This proves the async staging path (route creates job → worker assembles +
 * stages → per-file jobs + finalize run on worker) reaches the same end state
 * as the sync completeResumableUpload path.
 *
 * Real pg-boss + Postgres + MinIO via testcontainers.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { _setConfigForTest, _resetConfigForTest, getConfig } from '../../config/index.js';
import { _resetLoggerForTest } from '../../logging.js';
import { _resetDbForTest } from '../../db/client.js';
import { _resetBossForTest, getBoss } from '../../jobs/pg-boss.js';
import { parseEnv } from '../../config/env.js';
import {
  users,
  courses,
  semesters,
  memberships,
  ingest_jobs,
  ingest_files,
} from '../../db/schema.js';
import * as schema from '../../db/schema.js';
import { startWorker } from '../../jobs/worker.js';
import { createStorageClient, storageConfigFromEnv } from '../storage/client.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { createResumableUpload, putResumablePart, resolveChunkBytes } from './resumable-upload.js';
import { enqueueIngestJob } from './job-control.js';
import { stageUploadIntoJob } from './stage-upload-job.js';
import { ingestLocalPath, toSkippedWire } from './local-path.js';
import type { IngestScopeConfig } from './gradescope/repo-scopes.js';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import type { DrizzleDb } from '../../db/client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations');
const PROVENANCE_FILE = /^(manifest\.json|manifest\.sig|session-.*\.slog(\.meta)?)$/;

async function layBundleIntoFolder(
  outer: JSZip,
  folderPrefix: string,
  assignmentId: string,
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId,
    semester: 'fa2026',
    sessions: [{ eventCount: 3 }],
  });
  const inner = await JSZip.loadAsync(zipBuffer);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    const dest = PROVENANCE_FILE.test(name)
      ? `${folderPrefix}.provenance/${name}`
      : `${folderPrefix}${name}`;
    outer.file(dest, bytes);
  }
}

const METADATA = `submission_solo:
  :submitters:
  - :name: Solo Student
    :sid: '111'
    :email: solo@berkeley.edu
submission_pair:
  :submitters:
  - :name: Pair One
    :sid: '222'
  - :name: Pair Two
    :sid: '333'
`;

async function buildExportBytes(): Promise<ArrayBuffer> {
  const root = 'assignment_8046601_export/';
  const outer = new JSZip();
  outer.file(`${root}submission_metadata.yml`, METADATA);
  await layBundleIntoFolder(outer, `${root}submission_solo/`, 'hw10');
  await layBundleIntoFolder(outer, `${root}submission_pair/`, 'proj02');
  return outer.generateAsync({ type: 'arraybuffer' });
}

// ---------------------------------------------------------------------------
// A deliberately HETEROGENEOUS batch
// ---------------------------------------------------------------------------
//
// One folder is a classic flat bundle zip (a single `.provenance/` at its
// root); the other is a cloned git repo carrying two assignment scopes. Declare
// the batch `bundle_zip` and the repo does not have the shape the batch claims,
// so `resolveRepoScopes` rejects both of its scopes as
// `submission_type_mismatch`. That is the whole point of declaring a submission
// type — and on the chunked path it used to fail invisibly.

const HETERO_METADATA = `submission_flat:
  :submitters:
  - :name: Flat Student
    :sid: '444'
    :email: flat@berkeley.edu
submission_repo:
  :submitters:
  - :name: Repo Student
    :sid: '555'
    :email: repo@berkeley.edu
`;

/** Declared for the whole batch; rides the pg-boss payload on the chunked path. */
const BUNDLE_ZIP_OVERRIDE: IngestScopeConfig = { mode: 'bundle_zip', on_multiple: 'ingest_all' };

/**
 * What BOTH upload routes must report for `buildHeterogeneousExportBytes()`.
 *
 * Only the repo folder contributes: its two nested scopes are rejected in
 * discovery (lexicographic) order. The flat folder matches the declaration and
 * ingests normally, so it contributes nothing — this is a per-submission
 * failure, not a batch abort.
 */
const EXPECTED_HETERO_SKIPPED = [
  { folder_key: 'submission_repo', scope_path: 'lab5/', reason: 'submission_type_mismatch' },
  { folder_key: 'submission_repo', scope_path: 'proj2/', reason: 'submission_type_mismatch' },
];

async function buildHeterogeneousExportBytes(): Promise<ArrayBuffer> {
  const root = 'assignment_9000001_export/';
  const outer = new JSZip();
  outer.file(`${root}submission_metadata.yml`, HETERO_METADATA);
  // Shape the batch declares: exactly one scope, at the folder root.
  await layBundleIntoFolder(outer, `${root}submission_flat/`, 'hw10');
  // Shape it does not: a repo with two sealed scopes and nothing at its root.
  await layBundleIntoFolder(outer, `${root}submission_repo/proj2/`, 'proj02');
  await layBundleIntoFolder(outer, `${root}submission_repo/lab5/`, 'lab05');
  return outer.generateAsync({ type: 'arraybuffer' });
}

describe('stage-upload-job (pre-create job → stageUploadIntoJob → worker → succeeded)', () => {
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

  it('stages a completed upload into a pre-created job and reaches succeeded', async () => {
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
          year: 2026,
          slug: `fa2026-${crypto.randomUUID().slice(0, 8)}`,
          display_name: 'Fall 2026',
          filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
        })
        .returning();
      await db.insert(memberships).values({
        user_id: userId,
        semester_id: semester!.id,
        role: 'admin',
        granted_by: userId,
      });

      workerStop = await startWorker();

      const cfg = getConfig();
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      const exportBytes = await buildExportBytes();

      const uploadId = crypto.randomUUID();
      const chunkBytes = resolveChunkBytes(undefined);
      const { s3UploadId } = await createResumableUpload(
        { storageClient },
        { semesterId: semester!.id, uploadId, totalBytes: exportBytes.byteLength, chunkBytes },
      );
      await putResumablePart(
        { storageClient },
        { semesterId: semester!.id, uploadId, s3UploadId, partNumber: 1, body: exportBytes },
      );

      // The route's eager step: create the job row, then run the staging body.
      const { jobId } = await enqueueIngestJob(db, semester!.id, userId);
      const boss = await getBoss();
      await stageUploadIntoJob(
        { db, storageClient, boss },
        {
          ingestJobId: jobId,
          semesterId: semester!.id,
          userId,
          uploadId,
          s3UploadId,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
        },
      );

      // Per-file jobs + finalize run on the worker; wait for terminal status.
      const start = Date.now();
      let finalStatus: string | null = null;
      while (Date.now() - start < 120_000) {
        const [jobRow] = await db
          .select({ status: ingest_jobs.status })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, jobId));
        if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
          finalStatus = jobRow.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(finalStatus).toBe('succeeded');

      const fileRows = await db
        .select({ status: ingest_files.status })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId));
      expect(fileRows).toHaveLength(3);
      expect(fileRows.every((f) => f.status === 'matched')).toBe(true);

      // A genuinely clean batch reports an EMPTY list that means empty — not a
      // null standing in for "we never looked". The distinction only exists
      // because the column is nullable with no default, and this is the half of
      // it that a `DEFAULT '[]'` would have made untestable.
      const [skippedRow] = await db
        .select({ skipped: ingest_jobs.skipped })
        .from(ingest_jobs)
        .where(eq(ingest_jobs.id, jobId));
      expect(skippedRow!.skipped).toEqual([]);
      expect(skippedRow!.skipped).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // The hole this closes: a heterogeneous batch on the chunked path
  // -------------------------------------------------------------------------
  //
  // `/complete` answers 202 and the real work happens later in the
  // `ingest_stage_upload` worker, so the route's own response can never carry
  // the scope-resolution reasons. They used to be computed in that worker and
  // discarded, and `finalizeIngestJob` cannot recover them: it counts
  // `ingest_files` rows, and a skipped scope has none. The mismatched
  // submission just never appeared.
  it('surfaces submission_type_mismatch through the job row, identically to the direct path', async () => {
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
        .values({ name: 'CS 61B', slug: `cs61b-${crypto.randomUUID().slice(0, 8)}` })
        .returning();
      const [semester] = await db
        .insert(semesters)
        .values({
          course_id: course!.id,
          term: 'fa',
          year: 2026,
          slug: `fa2026-${crypto.randomUUID().slice(0, 8)}`,
          display_name: 'Fall 2026',
          filename_convention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
        })
        .returning();
      await db.insert(memberships).values({
        user_id: userId,
        semester_id: semester!.id,
        role: 'admin',
        granted_by: userId,
      });

      workerStop = await startWorker();

      const cfg = getConfig();
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      const exportBytes = await buildHeterogeneousExportBytes();

      // --- Path 1: chunked upload -----------------------------------------
      const uploadId = crypto.randomUUID();
      const { s3UploadId } = await createResumableUpload(
        { storageClient },
        {
          semesterId: semester!.id,
          uploadId,
          totalBytes: exportBytes.byteLength,
          chunkBytes: resolveChunkBytes(undefined),
        },
      );
      await putResumablePart(
        { storageClient },
        { semesterId: semester!.id, uploadId, s3UploadId, partNumber: 1, body: exportBytes },
      );

      const { jobId: chunkedJobId } = await enqueueIngestJob(db, semester!.id, userId);
      const boss = await getBoss();
      await stageUploadIntoJob(
        { db, storageClient, boss },
        {
          ingestJobId: chunkedJobId,
          semesterId: semester!.id,
          userId,
          uploadId,
          s3UploadId,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
          // The declared batch type rides the pg-boss payload. Drop it there and
          // no mismatch is ever detected, so this arg is load-bearing for the
          // whole test, not scenery.
          ingestScopeOverride: BUNDLE_ZIP_OVERRIDE,
        },
      );

      const readSkipped = async (jobId: string): Promise<unknown> => {
        const [row] = await db
          .select({ skipped: ingest_jobs.skipped })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, jobId));
        return row!.skipped;
      };

      // Visible immediately — the stager records before it opens the finalize
      // gate, so there is no window in which a settled job still reads null.
      expect(await readSkipped(chunkedJobId)).toEqual(EXPECTED_HETERO_SKIPPED);

      // ...and still visible after the worker has run finalize over it.
      const start = Date.now();
      let finalStatus: string | null = null;
      while (Date.now() - start < 120_000) {
        const [jobRow] = await db
          .select({ status: ingest_jobs.status })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, chunkedJobId));
        if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
          finalStatus = jobRow.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(finalStatus).not.toBeNull();
      expect(await readSkipped(chunkedJobId)).toEqual(EXPECTED_HETERO_SKIPPED);

      // The conforming folder still ingested: one bad repo does not take the
      // batch down with it.
      const chunkedFiles = await db
        .select({ status: ingest_files.status })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, chunkedJobId));
      expect(chunkedFiles).toHaveLength(1);

      // --- Path 2: the single-shot / local-path route, same export ---------
      const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'prov-hetero-'));
      try {
        const archivePath = path.join(tmpDir, 'export.zip');
        await writeFile(archivePath, Buffer.from(exportBytes));

        const { jobId: directJobId } = await enqueueIngestJob(db, semester!.id, userId);
        const direct = await ingestLocalPath(
          { db, storageClient },
          {
            semesterId: semester!.id,
            userId,
            archivePath,
            maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
            maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
            jobId: directJobId,
            ingestScopeOverride: BUNDLE_ZIP_OVERRIDE,
          },
        );
        expect(direct.ok).toBe(true);
        if (!direct.ok) return;

        // THE PROOF. The array the single-shot route inlines in its HTTP
        // response, the array it persists, and the array the chunked route
        // persists are all the same value for the same export. A consumer
        // reading skip reasons cannot tell which upload mechanism was used.
        expect(toSkippedWire(direct.skipped)).toEqual(EXPECTED_HETERO_SKIPPED);
        expect(await readSkipped(directJobId)).toEqual(EXPECTED_HETERO_SKIPPED);
        expect(await readSkipped(directJobId)).toEqual(await readSkipped(chunkedJobId));

        // Re-ingesting the same export did not accumulate reasons: the write
        // replaces, so two runs leave two entries rather than four. (The bundles
        // themselves dedup, which is a separate mechanism and not what this
        // asserts.)
        expect((await readSkipped(directJobId)) as unknown[]).toHaveLength(
          EXPECTED_HETERO_SKIPPED.length,
        );
      } finally {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });
  });
});
