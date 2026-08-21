/**
 * End-to-end test for the resumable (chunked) upload service: create →
 * upload part → complete → ingest, driven through the worker.
 *
 * Multi-part assembly + resume (listParts) is covered by
 * storage/multipart.test.ts; this proves the service integration — a completed
 * multipart upload is downloaded and fed through the SAME ingestLocalPath
 * pipeline, reaching the same end state as every other ingest path.
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
import { _resetBossForTest } from '../../jobs/pg-boss.js';
import { parseEnv } from '../../config/env.js';
import {
  users,
  courses,
  semesters,
  memberships,
  roster_entries,
  ingest_jobs,
} from '../../db/schema.js';
import * as schema from '../../db/schema.js';
import { startWorker } from '../../jobs/worker.js';
import { createStorageClient, storageConfigFromEnv } from '../storage/client.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  createResumableUpload,
  putResumablePart,
  completeResumableUpload,
  resolveChunkBytes,
} from './resumable-upload.js';
import { expectSoloPlusPairEndState } from '../../../test/helpers/gradescope-group-shape.js';
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

describe('resumable upload (create → part → complete → ingest)', () => {
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

  it('ingests a completed multipart upload to the same end state', async () => {
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

      // create → upload as a single part → complete + ingest.
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
      const result = await completeResumableUpload(
        { storageClient },
        {
          db,
          semesterId: semester!.id,
          userId,
          uploadId,
          s3UploadId,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.roster).toEqual({ added: 3, updated: 0 });
      expect(result.bundlesProcessed).toBe(2);
      expect(result.submissionsQueued).toBe(3);
      expect(result.jobId).not.toBeNull();
      const jobId = result.jobId!;

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

      const roster = await db
        .select({ sid: roster_entries.sid })
        .from(roster_entries)
        .where(eq(roster_entries.semester_id, semester!.id));
      expect(new Set(roster.map((r) => r.sid))).toEqual(new Set(['111', '222', '333']));

      // "The same end state" is the entire point of this test, so it asserts it
      // with the SAME function the direct and staged paths use — not a
      // hand-copied subset of it, which is how this assertion came to be a
      // weaker `.every(status === 'matched')` over three fanned-out rows in the
      // first place. Post-D9: matched/matched/duplicate, TWO submissions, and
      // both co-submitters as contributors on the shared one.
      await expectSoloPlusPairEndState(db, semester!.id, jobId);
    });
  });
});
