/**
 * End-to-end test for POST /semesters/:id/ingest:gradescope.
 *
 * Uploads a real Gradescope export ZIP (submission_metadata.yml + one folder per
 * submission), drives the worker through pg-boss, and asserts:
 *   - the roster is populated from the metadata (no pre-existing roster needed),
 *   - a single-submitter submission is matched,
 *   - a group submission yields one submission per co-submitter (shared blob),
 *   - a folder with no bundle is reported as skipped.
 *
 * Mirrors ingest-e2e.test.ts: real pg-boss + Postgres + MinIO via testcontainers.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../../db/migrations');

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
    :email: one@berkeley.edu
  - :name: Pair Two
    :sid: '333'
    :email: two@berkeley.edu
submission_nobundle:
  :submitters:
  - :name: No Recorder
    :sid: '444'
`;

async function buildExportZip(): Promise<Uint8Array> {
  const root = 'assignment_8046601_export/';
  const outer = new JSZip();
  outer.file(`${root}submission_metadata.yml`, METADATA);
  outer.file(`${root}.DS_Store`, new Uint8Array([0]));
  await layBundleIntoFolder(outer, `${root}submission_solo/`, 'hw10');
  await layBundleIntoFolder(outer, `${root}submission_pair/`, 'proj02');
  outer.file(`${root}submission_nobundle/answers.txt`, new TextEncoder().encode('no recorder'));
  const buf = await outer.generateAsync({ type: 'arraybuffer' });
  return new Uint8Array(buf);
}

describe('POST /ingest:gradescope (export → roster + worker)', () => {
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

  it('resumable /complete returns 202 with job_id and the background job reaches succeeded', async () => {
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

      // Seed an admin + session + semester. NO roster — the export creates it.
      const userId = crypto.randomUUID();
      await db.insert(users).values({
        id: userId,
        google_subject: `sub-${userId}`,
        email: `admin-${userId}@berkeley.edu`,
        display_name: 'Admin',
      });
      const sessionToken = `sess-${'y'.repeat(37)}`.slice(0, 43);
      await db.insert(sessions).values({
        id: sessionToken,
        user_id: userId,
        expires_at: new Date(Date.now() + 14 * 86400_000),
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

      const exportBytes = await buildExportZip();
      const app = createV1App();
      const semesterId = semester!.id;
      const authHeader = { Cookie: `__Host-prov_sess=${sessionToken}` };

      // --- create a resumable upload ---
      const createRes = await app.fetch(
        new Request(`http://localhost/semesters/${semesterId}/ingest/uploads`, {
          method: 'POST',
          headers: { ...authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: 'export.zip', total_bytes: exportBytes.byteLength }),
        }),
      );
      expect(createRes.status).toBe(201);
      const createBody = (await createRes.json()) as {
        upload_id: string;
        s3_upload_id: string;
        chunk_size: number;
        total_parts: number;
      };
      const { upload_id, s3_upload_id } = createBody;

      // --- upload one part (the whole export fits in one part) ---
      const putRes = await app.fetch(
        new Request(
          `http://localhost/semesters/${semesterId}/ingest/uploads/${upload_id}/parts/1?s3_upload_id=${encodeURIComponent(s3_upload_id)}`,
          {
            method: 'PUT',
            headers: { ...authHeader, 'Content-Type': 'application/octet-stream' },
            body: exportBytes.buffer as ArrayBuffer,
          },
        ),
      );
      expect(putRes.status).toBe(200);

      // --- complete the upload — must return 202 with job_id immediately ---
      const completeRes = await app.fetch(
        new Request(
          `http://localhost/semesters/${semesterId}/ingest/uploads/${upload_id}/complete`,
          {
            method: 'POST',
            headers: { ...authHeader, 'Content-Type': 'application/json' },
            body: JSON.stringify({ s3_upload_id }),
          },
        ),
      );
      expect(completeRes.status).toBe(202);
      const completeBody = (await completeRes.json()) as {
        job_id: string;
        roster: { added: number; updated: number };
        bundles_processed: number;
        submissions_queued: number;
        skipped: unknown[];
      };
      expect(typeof completeBody.job_id).toBe('string');
      expect(completeBody.job_id.length).toBeGreaterThan(0);
      // Placeholder counts — the real counts come from the background job.
      expect(completeBody.roster).toEqual({ added: 0, updated: 0 });
      expect(completeBody.bundles_processed).toBe(0);
      expect(completeBody.submissions_queued).toBe(0);

      const jobId = completeBody.job_id;

      // --- poll the job status until it reaches a terminal state ---
      const start = Date.now();
      let finalStatus: string | null = null;
      while (Date.now() - start < 120_000) {
        const statusRes = await app.fetch(
          new Request(`http://localhost/semesters/${semesterId}/ingest/jobs/${jobId}`, {
            headers: authHeader,
          }),
        );
        const statusBody = (await statusRes.json()) as { status: string };
        if (['succeeded', 'partial', 'failed', 'cancelled'].includes(statusBody.status)) {
          finalStatus = statusBody.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(finalStatus).toBe('succeeded');
    });
  });

  it('upserts roster, matches solo + group submitters, reports skipped folders', async () => {
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

      // Seed an admin + session + semester. NO roster — the export creates it.
      const userId = crypto.randomUUID();
      await db.insert(users).values({
        id: userId,
        google_subject: `sub-${userId}`,
        email: `admin-${userId}@berkeley.edu`,
        display_name: 'Admin',
      });
      const sessionToken = `sess-${'x'.repeat(37)}`.slice(0, 43);
      await db.insert(sessions).values({
        id: sessionToken,
        user_id: userId,
        expires_at: new Date(Date.now() + 14 * 86400_000),
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

      const exportBytes = await buildExportZip();
      const app = createV1App();
      const formData = new FormData();
      formData.append(
        'archive',
        new Blob([exportBytes.buffer as ArrayBuffer], { type: 'application/zip' }),
        'assignment_8046601_export.zip',
      );

      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semester!.id}/ingest:gradescope`, {
          method: 'POST',
          headers: { Cookie: `__Host-prov_sess=${sessionToken}` },
          body: formData,
        }),
      );

      expect(res.status).toBe(202);
      const body = (await res.json()) as {
        job_id: string;
        roster: { added: number; updated: number };
        bundles_processed: number;
        submissions_queued: number;
        skipped: Array<{ folder_key: string; reason: string }>;
      };
      expect(body.roster).toEqual({ added: 4, updated: 0 });
      expect(body.bundles_processed).toBe(2);
      expect(body.submissions_queued).toBe(3);
      // REGRESSION GUARD: the flat Gradescope folder path is unchanged by the
      // git-repo scope fan-out — one `.provenance/` per folder still yields one
      // bundle at the root scope, and a non-bundle folder is still no_manifest.
      expect(body.skipped).toEqual([
        { folder_key: 'submission_nobundle', scope_path: '', reason: 'no_manifest' },
      ]);

      // Roster was populated from the metadata (all four submitters).
      const roster = await db
        .select({ sid: roster_entries.sid })
        .from(roster_entries)
        .where(eq(roster_entries.semester_id, semester!.id));
      expect(new Set(roster.map((r) => r.sid))).toEqual(new Set(['111', '222', '333', '444']));

      // Poll the ingest job to terminal.
      const start = Date.now();
      let finalStatus: string | null = null;
      while (Date.now() - start < 120_000) {
        const [jobRow] = await db
          .select({ status: ingest_jobs.status })
          .from(ingest_jobs)
          .where(eq(ingest_jobs.id, body.job_id));
        if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
          finalStatus = jobRow.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(finalStatus).toBe('succeeded');

      // All three files matched.
      const fileRows = await db
        .select({ status: ingest_files.status, match_sid: ingest_files.match_sid })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, body.job_id));
      expect(fileRows).toHaveLength(3);
      expect(fileRows.every((f) => f.status === 'matched')).toBe(true);

      // Three submissions; the two co-submitters share one blob.
      const subs = await db
        .select({
          student_id: submissions.student_id,
          blob_sha256: submissions.blob_sha256,
        })
        .from(submissions)
        .where(eq(submissions.semester_id, semester!.id));
      expect(subs).toHaveLength(3);

      const rosterBySid = new Map(
        (
          await db
            .select({ id: roster_entries.id, sid: roster_entries.sid })
            .from(roster_entries)
            .where(eq(roster_entries.semester_id, semester!.id))
        ).map((r) => [r.sid, r.id]),
      );
      const subByStudent = new Map(subs.map((s) => [s.student_id, s.blob_sha256]));
      // The pair (222, 333) share blob bytes; the solo (111) differs.
      const pairBlobs = [
        subByStudent.get(rosterBySid.get('222')!),
        subByStudent.get(rosterBySid.get('333')!),
      ];
      expect(pairBlobs[0]).toBeTruthy();
      expect(pairBlobs[0]).toBe(pairBlobs[1]);
      expect(subByStudent.get(rosterBySid.get('111')!)).not.toBe(pairBlobs[0]);
    });
  });
});
