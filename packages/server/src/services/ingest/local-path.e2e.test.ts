/**
 * End-to-end test for ingestLocalPath (local-path ingest of a Gradescope export
 * read directly from disk via the streaming reader — the 10 GB+ path).
 *
 * Writes a real export ZIP to a temp file, calls ingestLocalPath (no HTTP, no
 * in-memory whole-archive buffer), drives the worker through pg-boss, and
 * asserts the SAME end state the HTTP :gradescope route produces:
 *   - roster populated from the metadata (no pre-existing roster needed),
 *   - the solo submitter matched, and the two co-submitters of one group folder
 *     collapsed onto ONE submission carrying both as contributors (D9) — the
 *     second resolves as `duplicate` rather than fanning out a second row,
 *   - a no-manifest folder reported as skipped.
 *
 * Mirrors ingest-gradescope.e2e.test.ts: real pg-boss + Postgres + MinIO via
 * testcontainers.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
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
  assignments,
  ingest_jobs,
  ingest_files,
  submissions,
} from '../../db/schema.js';
import * as schema from '../../db/schema.js';
import { startWorker } from '../../jobs/worker.js';
import { createStorageClient, storageConfigFromEnv } from '../storage/client.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { ingestLocalPath } from './local-path.js';
import { enqueueIngestJob } from './job-control.js';
import { expectSoloPlusPairEndState } from '../../../test/helpers/gradescope-group-shape.js';
import type { DrizzleDb } from '../../db/client.js';

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
submission_nobundle:
  :submitters:
  - :name: No Recorder
    :sid: '444'
`;

/**
 * A git-native export: ONE submitter, ONE repo folder, holding two sealed
 * assignment scopes plus an unsealed one and repo noise. This is the CS 61B/61C
 * shape — Gradescope clones the whole repository, not a sealed bundle.
 */
const REPO_METADATA = `submission_repo:
  :submitters:
  - :name: Repo Student
    :sid: '555'
    :email: repo@berkeley.edu
`;

async function writeRepoExportZip(dir: string): Promise<string> {
  const root = 'assignment_9100_export/';
  const folder = `${root}submission_repo/`;
  const outer = new JSZip();
  outer.file(`${root}submission_metadata.yml`, REPO_METADATA);
  await layBundleIntoFolder(outer, `${folder}proj2/`, 'proj2');
  await layBundleIntoFolder(outer, `${folder}lab5/`, 'lab5');
  // A scope the student worked in but never sealed — no manifest.json, because
  // nothing runs the seal command on a git push.
  outer.file(
    `${folder}lab6/.provenance/session-11111111-1111-4111-8111-111111111111.slog`,
    new TextEncoder().encode('{}\n'),
  );
  outer.file(`${folder}README.md`, new TextEncoder().encode('# repo\n'));
  const buf = await outer.generateAsync({ type: 'nodebuffer' });
  const zipPath = path.join(dir, 'repo-export.zip');
  await writeFile(zipPath, buf);
  return zipPath;
}

async function writeExportZip(dir: string): Promise<string> {
  const root = 'assignment_8046601_export/';
  const outer = new JSZip();
  outer.file(`${root}submission_metadata.yml`, METADATA);
  outer.file(`${root}.DS_Store`, new Uint8Array([0]));
  await layBundleIntoFolder(outer, `${root}submission_solo/`, 'hw10');
  await layBundleIntoFolder(outer, `${root}submission_pair/`, 'proj02');
  outer.file(`${root}submission_nobundle/answers.txt`, new TextEncoder().encode('no recorder'));
  const buf = await outer.generateAsync({ type: 'nodebuffer' });
  const zipPath = path.join(dir, 'export.zip');
  await writeFile(zipPath, buf);
  return zipPath;
}

describe('ingestLocalPath (disk export → roster + worker)', () => {
  let pgContainer: StartedPostgreSqlContainer;
  let dbSql: postgres.Sql;
  let db: DrizzleDb;
  let workerStop: (() => Promise<void>) | null = null;
  let tmpDir: string;

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
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'prov-localpath-'));
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
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('upserts roster, gives the co-submitter pair ONE submission with both contributors, reports skipped folders', async () => {
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

      // Seed an admin + semester. NO roster — the export creates it.
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
      const zipPath = await writeExportZip(tmpDir);

      const result = await ingestLocalPath(
        { db, storageClient },
        {
          semesterId: semester!.id,
          userId,
          archivePath: zipPath,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
          // Exercise the worker-pool rebuild path (concurrency > 1) end-to-end.
          stageConcurrency: 4,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.roster).toEqual({ added: 4, updated: 0 });
      expect(result.bundlesProcessed).toBe(2);
      expect(result.submissionsQueued).toBe(3);
      // REGRESSION GUARD (flat Gradescope path): one `.provenance/` per folder
      // still means ONE bundle per folder, at the root scope, and a folder that
      // is not a bundle at all is still reported as no_manifest — the fan-out
      // adapter must not change any of this.
      expect(result.skipped).toEqual([
        { folderKey: 'submission_nobundle', scopePath: '', reason: 'no_manifest' },
      ]);
      expect(result.jobId).not.toBeNull();
      const jobId = result.jobId!;

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
          .where(eq(ingest_jobs.id, jobId));
        if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
          finalStatus = jobRow.status;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(finalStatus).toBe('succeeded');

      // Confirm the full job row: staging_complete must be true (the gate was
      // lifted), and summary.total must equal the number of staged submissions.
      // An early finalize would under-count or settle the job before later files
      // were staged, so these assertions are the regression guard for interleaving.
      const [jobRow] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(jobRow!.staging_complete).toBe(true);
      expect(['succeeded', 'partial']).toContain(jobRow!.status);
      expect((jobRow!.summary as { total: number }).total).toBe(3);

      // The solo + pair end state, shared with every other upload mechanism
      // (see `expectSoloPlusPairEndState`): three ingest_files rows resolving
      // matched/matched/duplicate, TWO submissions rather than three, and both
      // co-submitters present as contributors on the shared one.
      await expectSoloPlusPairEndState(db, semester!.id, jobId);
    });
  });

  it('stages into a pre-created job when jobId is supplied', async () => {
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

      // Seed an admin + semester. NO roster — the export creates it.
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
      const archivePath = await writeExportZip(tmpDir);

      const { jobId } = await enqueueIngestJob(db, semester!.id, userId);

      const result = await ingestLocalPath(
        { db, storageClient },
        {
          semesterId: semester!.id,
          userId,
          archivePath,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
          jobId,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Stages into the SAME job we created — no second job row.
      expect(result.jobId).toBe(jobId);
      const jobRows = await db.select({ id: ingest_jobs.id }).from(ingest_jobs);
      expect(jobRows).toHaveLength(1);
    });
  });

  it('fans one git repo out to one submission per assignment scope', async () => {
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
      const archivePath = await writeRepoExportZip(tmpDir);

      const result = await ingestLocalPath(
        { db, storageClient },
        {
          semesterId: semester!.id,
          userId,
          archivePath,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // One uploaded repo, one submitter — but TWO sealed scopes, so two bundles
      // and two staged files.
      expect(result.bundlesProcessed).toBe(2);
      expect(result.submissionsQueued).toBe(2);
      // The unsealed scope is reported per-scope, not silently dropped.
      expect(result.skipped).toEqual([
        { folderKey: 'submission_repo', scopePath: 'lab6/', reason: 'no_seal' },
      ]);
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

      const fileRows = await db
        .select({ status: ingest_files.status, original_filename: ingest_files.original_filename })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId));
      expect(fileRows).toHaveLength(2);
      expect(fileRows.every((f) => f.status === 'matched')).toBe(true);
      expect(fileRows.map((f) => f.original_filename).sort()).toEqual([
        'submission_repo/lab5.zip',
        'submission_repo/proj2.zip',
      ]);

      // Two submissions for ONE student, one per scope, each under the
      // assignment its own manifest declared — and each with its own blob.
      const subs = await db
        .select({
          student_id: submissions.student_id,
          blob_sha256: submissions.blob_sha256,
          assignment_id_str: assignments.assignment_id_str,
          version_index: submissions.version_index,
        })
        .from(submissions)
        .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
        .where(eq(submissions.semester_id, semester!.id));

      expect(subs).toHaveLength(2);
      expect(new Set(subs.map((s) => s.student_id)).size).toBe(1);
      expect(subs.map((s) => s.assignment_id_str).sort()).toEqual(['lab5', 'proj2']);
      expect(new Set(subs.map((s) => s.blob_sha256)).size).toBe(2);
      // Independent version streams: each scope is version 1 of its own
      // assignment, not v1 and v2 of a shared one.
      expect(subs.map((s) => s.version_index)).toEqual([1, 1]);
    });
  });

  // -------------------------------------------------------------------------
  // Per-request declared-submission-type override
  //
  // The unit tests prove the resolver mechanism; this proves the WIRING —
  // that `ingestLocalPath` actually honours `args.ingestScopeOverride` and
  // that it beats what the assignment rows say. Dropping the override on the
  // floor is invisible to every other test in the suite, because the same repo
  // ingests perfectly well under the default.
  // -------------------------------------------------------------------------

  async function seedSemesterFor(label: string) {
    const userId = crypto.randomUUID();
    await db.insert(users).values({
      id: userId,
      google_subject: `sub-${userId}`,
      email: `admin-${userId}@berkeley.edu`,
      display_name: 'Admin',
    });
    const [course] = await db
      .insert(courses)
      .values({ name: label, slug: `cs61b-${crypto.randomUUID().slice(0, 8)}` })
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
    return { userId, semesterId: semester!.id };
  }

  function e2eEnv(minioEndpoint: string, bucketName: string) {
    return parseEnv({
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
    });
  }

  it('honours a per-request ingest_scope override, beating the assignment defaults', async () => {
    await withTestMinio(async ({ client, bucketName }) => {
      _setConfigForTest(e2eEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName));
      const { userId, semesterId } = await seedSemesterFor('CS 61B override');

      const cfg = getConfig();
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      const archivePath = await writeRepoExportZip(tmpDir);

      // No assignment rows exist yet, so every scope resolves to the
      // self_identifying DEFAULT — which would fan this repo out to two
      // submissions (proved by the test above). The override says otherwise.
      const result = await ingestLocalPath(
        { db, storageClient },
        {
          semesterId,
          userId,
          archivePath,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
          ingestScopeOverride: {
            mode: 'repo_scoped',
            path_glob: 'proj2/**',
            on_multiple: 'ingest_all',
          },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // ONE submission, not two: the override narrowed the batch.
      expect(result.bundlesProcessed).toBe(1);
      expect(result.submissionsQueued).toBe(1);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          { folderKey: 'submission_repo', scopePath: 'lab5/', reason: 'scope_excluded' },
          { folderKey: 'submission_repo', scopePath: 'lab6/', reason: 'no_seal' },
        ]),
      );
    });
  });

  it('an override that the batch does not match fails the submission, legibly', async () => {
    await withTestMinio(async ({ client, bucketName }) => {
      _setConfigForTest(e2eEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName));
      const { userId, semesterId } = await seedSemesterFor('CS 61B mismatch');

      const cfg = getConfig();
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      const archivePath = await writeRepoExportZip(tmpDir);

      // Declaring bundle_zip over a repo: the homogeneity failure, end to end.
      const result = await ingestLocalPath(
        { db, storageClient },
        {
          semesterId,
          userId,
          archivePath,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
          ingestScopeOverride: { mode: 'bundle_zip', on_multiple: 'ingest_all' },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Nothing ingested, and no job created — but the roster was still
      // upserted and every scope is accounted for by name and reason.
      expect(result.bundlesProcessed).toBe(0);
      expect(result.submissionsQueued).toBe(0);
      expect(result.jobId).toBeNull();
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          {
            folderKey: 'submission_repo',
            scopePath: 'proj2/',
            reason: 'submission_type_mismatch',
          },
          {
            folderKey: 'submission_repo',
            scopePath: 'lab5/',
            reason: 'submission_type_mismatch',
          },
        ]),
      );

      // The batch failed per-submission, not by throwing: no submission rows,
      // and — the constraint that matters — nothing was deleted to get there.
      const subs = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(eq(submissions.semester_id, semesterId));
      expect(subs).toHaveLength(0);
    });
  });

  it('a glob that matches nothing fails loudly rather than reporting a clean empty ingest', async () => {
    await withTestMinio(async ({ client, bucketName }) => {
      _setConfigForTest(e2eEnv(client.bucketUrl.replace(`/${bucketName}`, ''), bucketName));
      const { userId, semesterId } = await seedSemesterFor('CS 61B empty glob');

      const cfg = getConfig();
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      const archivePath = await writeRepoExportZip(tmpDir);

      const result = await ingestLocalPath(
        { db, storageClient },
        {
          semesterId,
          userId,
          archivePath,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
          ingestScopeOverride: {
            mode: 'repo_scoped',
            path_glob: 'proj3/**',
            on_multiple: 'ingest_all',
          },
        },
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.submissionsQueued).toBe(0);
      // Without the folder-level check this is indistinguishable from a repo
      // that legitimately had nothing to ingest — a typo'd glob would silently
      // drop the whole cohort while the ingest reported success.
      expect(result.skipped.map((s) => s.reason)).toContain('submission_type_mismatch');
    });
  });
});
