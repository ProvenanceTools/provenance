/**
 * Regression test: ingest accepts 1.1 bundles and persists Check 8 results.
 *
 * F5 exit gates:
 *   - Tampered 1.1 bundle: check_8_status='fail', overall='fail', and a
 *     flags row with heuristic_id='submitted_code_match' exists.
 *   - Clean 1.1 bundle: check_8_status='pass' (all other checks pass + all
 *     submitted files match the recorded on-disk hashes).
 *   - format_version='1.1' stored in submissions row.
 *   - parse-bundle-phase.ts needs no change (verified by the test reaching
 *     the validation step without a parse_bundle error).
 *
 * Uses testcontainers (Postgres + MinIO). Both containers are shared across
 * all tests in this file (started once in beforeAll, stopped in afterAll)
 * to avoid the ~60-90s startup cost per test.
 *
 * Timeout: 180s per vitest.setConfig (container start + pipeline).
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createStorageClient, type StorageClient } from '../../services/storage/client.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { sha256Hex } from '@provenance/log-core';
import { putBlob } from '../storage/blobs.js';
import { bundleKey } from '../storage/keys.js';
import { parseBundlePhase } from './parse-bundle-phase.js';
import { runAndStoreValidation } from './validation.js';
import { runAndStoreHeuristics } from '../heuristics/run-per-submission.js';
import { withTransaction } from '../../db/client.js';
import {
  users,
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  validation_results,
  flags,
} from '../../db/schema.js';
import * as schema from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Module-level path resolution
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// __dirname is packages/server/src/services/ingest.
// Navigate 3 levels up to packages/server/, then into db/migrations.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations');

const MINIO_IMAGE = 'minio/minio:RELEASE.2025-04-22T22-12-26Z';
const MINIO_USER = 'minioadmin';
const MINIO_PASSWORD = 'minioadmin';
const BUCKET_NAME = 'test-bucket';

// ---------------------------------------------------------------------------
// Shared containers (started once, shared across all tests)
// ---------------------------------------------------------------------------

let pgContainer: StartedPostgreSqlContainer;
let minioContainer: StartedMinioContainer;
let sql: postgres.Sql;
let db: DrizzleDb;
let storageClient: StorageClient;

beforeAll(async () => {
  // Start Postgres and MinIO in parallel to cut startup time.
  [pgContainer, minioContainer] = await Promise.all([
    new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('provenance_test')
      .withUsername('test')
      .withPassword('test')
      .start(),
    new MinioContainer(MINIO_IMAGE).withUsername(MINIO_USER).withPassword(MINIO_PASSWORD).start(),
  ]);

  sql = postgres(pgContainer.getConnectionUri(), { max: 3 });
  db = drizzle(sql, { schema }) as DrizzleDb;
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  const endpoint = minioContainer.getConnectionUrl();
  storageClient = createStorageClient({
    kind: 's3',
    endpoint,
    region: 'us-east-1',
    bucket: BUCKET_NAME,
    accessKeyId: MINIO_USER,
    secretAccessKey: MINIO_PASSWORD,
  });
  if (storageClient.kind !== 's3') throw new Error('expected s3 client from s3 config');

  // Create the bucket (with retries for container readiness).
  const bucketUrl = `${endpoint}/${BUCKET_NAME}`;
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500));
    const res = await storageClient.aws.fetch(bucketUrl, { method: 'PUT' });
    if (res.ok || res.status === 409) break;
    if (attempt === 9) throw new Error(`Failed to create MinIO test bucket after retries`);
  }
});

afterAll(async () => {
  await sql.end();
  await Promise.all([pgContainer.stop(), minioContainer.stop()]);
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedMinimal(db: DrizzleDb): Promise<{
  semesterId: string;
  studentId: string;
  assignmentId: string;
  userId: string;
  jobId: string;
}> {
  const uid = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({ google_subject: `sub-${uid}`, email: `u-${uid}@berkeley.edu`, display_name: 'U' })
    .returning();

  const courseSlug = `cs61a-${uid.slice(0, 8)}`;
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
      slug: `fa24-${uid.slice(0, 8)}`,
      display_name: 'Fall 2024',
      filename_convention: '(?<sid>\\d+)',
    })
    .returning();

  const [student] = await db
    .insert(roster_entries)
    .values({ semester_id: semester!.id, sid: '123456', display_name: 'Alice' })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semester!.id, assignment_id_str: 'hw01', label: 'HW01' })
    .returning();

  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semester!.id, uploaded_by: user!.id, status: 'running', summary: {} })
    .returning();

  return {
    semesterId: semester!.id,
    studentId: student!.id,
    assignmentId: assignment!.id,
    userId: user!.id,
    jobId: job!.id,
  };
}

/**
 * Seed a submission row pointing to the final bundle blob key.
 */
async function seedSubmissionRow(
  db: DrizzleDb,
  opts: {
    semesterId: string;
    studentId: string;
    assignmentId: string;
    jobId: string;
    submissionId: string;
    blobSha256: string;
    formatVersion: string;
  },
): Promise<void> {
  const key = bundleKey(opts.semesterId, opts.submissionId);
  await db.insert(submissions).values({
    id: opts.submissionId,
    semester_id: opts.semesterId,
    assignment_id: opts.assignmentId,
    student_id: opts.studentId,
    blob_object_key: key,
    blob_sha256: opts.blobSha256,
    source_filename: 'hw01-123456.zip',
    ingest_job_id: opts.jobId,
    version_index: 1,
    format_version: opts.formatVersion,
    recorder_version: '1.1.0',
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Check 8 ingest regression (1.1 bundles)', () => {
  it('tampered 1.1 bundle → check_8_status=fail + submitted_code_match flag', async () => {
    const seed = await seedMinimal(db);
    const submissionId = crypto.randomUUID();

    // Build a 1.1 bundle where the submitted file was tampered:
    // doc.save records "original" hash, but the bundle contains "tampered" bytes.
    const originalContent = 'def original(): pass\n';
    const tamperedContent = 'def tampered(): pass\n'; // different from recorded hash
    const recordedHash = sha256Hex(new TextEncoder().encode(originalContent));

    const { zipBuffer } = await buildTestBundle({
      assignmentId: 'hw01',
      semester: 'fa2024',
      sessions: [
        {
          events: [{ kind: 'doc.save', data: { path: 'hw01.py', sha256: recordedHash } }],
        },
      ],
      submissionFiles: [{ path: 'hw01.py', status: 'present', content: tamperedContent }],
    });

    // Stage and persist to final key.
    const key = bundleKey(seed.semesterId, submissionId);
    await putBlob(storageClient, key, zipBuffer);

    // Compute sha256 for the submission row.
    const hashBuffer = await crypto.subtle.digest('SHA-256', zipBuffer);
    const blobSha256 = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    await seedSubmissionRow(db, {
      semesterId: seed.semesterId,
      studentId: seed.studentId,
      assignmentId: seed.assignmentId,
      jobId: seed.jobId,
      submissionId,
      blobSha256,
      formatVersion: '1.1',
    });

    // Run parse → validate → heuristics (the real ingest pipeline stages).
    const parseResult = await parseBundlePhase(storageClient, key, 'hw01-123456.zip');
    expect(parseResult.ok, `parse_bundle failed: ${JSON.stringify(parseResult)}`).toBe(true);
    if (!parseResult.ok) return;

    const bundle = parseResult.bundle;
    let report: Awaited<ReturnType<typeof runAndStoreValidation>>;
    await withTransaction(db, async (tx) => {
      report = await runAndStoreValidation(tx, submissionId, bundle);
    });

    await withTransaction(db, async (tx) => {
      await runAndStoreHeuristics(tx, submissionId, seed.semesterId, bundle, report!);
    });

    // Assert validation_results.
    const [valRow] = await db
      .select({
        check_8_status: validation_results.check_8_status,
        overall: validation_results.overall,
      })
      .from(validation_results)
      .where(eq(validation_results.submission_id, submissionId));

    expect(valRow, 'validation_results row must exist').toBeDefined();
    expect(valRow!.check_8_status).toBe('fail');
    expect(valRow!.overall).toBe('fail');

    // Assert flags table has a submitted_code_match flag.
    const flagRows = await db
      .select({ heuristic_id: flags.heuristic_id })
      .from(flags)
      .where(eq(flags.submission_id, submissionId));

    const codeMatchFlag = flagRows.find((f) => f.heuristic_id === 'submitted_code_match');
    expect(codeMatchFlag, 'submitted_code_match flag must exist').toBeDefined();

    // Assert format_version stored in submissions row.
    const [subRow] = await db
      .select({ format_version: submissions.format_version })
      .from(submissions)
      .where(eq(submissions.id, submissionId));

    expect(subRow!.format_version).toBe('1.1');
  });

  it('clean 1.1 bundle → check_8_status=pass', async () => {
    const seed = await seedMinimal(db);
    const submissionId = crypto.randomUUID();

    // Build a clean 1.1 bundle where the submitted file content matches
    // the last recorded on-disk hash (doc.save sha256).
    //
    // buildTestBundle with appendDocSave:true + eventCount:5 produces a
    // doc.change sequence that accumulates to 'x5x4x3x2x1' and appends a
    // doc.save with sha256(that content). We pass the same content as the
    // submitted file so Check 8 produces 'match'.
    //
    // The path MUST match the doc.save path ('/test/file.py') produced by
    // buildTestBundle's default doc.change events, so we use that path.
    const submittedContent = 'x5x4x3x2x1';
    const submittedPath = '/test/file.py';

    const { zipBuffer } = await buildTestBundle({
      assignmentId: 'hw01',
      semester: 'fa2024',
      sessions: [{ eventCount: 5, appendDocSave: true }],
      submissionFiles: [{ path: submittedPath, status: 'present', content: submittedContent }],
    });

    const key = bundleKey(seed.semesterId, submissionId);
    await putBlob(storageClient, key, zipBuffer);

    const hashBuffer = await crypto.subtle.digest('SHA-256', zipBuffer);
    const blobSha256 = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    await seedSubmissionRow(db, {
      semesterId: seed.semesterId,
      studentId: seed.studentId,
      assignmentId: seed.assignmentId,
      jobId: seed.jobId,
      submissionId,
      blobSha256,
      formatVersion: '1.1',
    });

    const parseResult = await parseBundlePhase(storageClient, key, 'hw01-123456.zip');
    expect(parseResult.ok, `parse_bundle failed: ${JSON.stringify(parseResult)}`).toBe(true);
    if (!parseResult.ok) return;

    const bundle = parseResult.bundle;
    let report: Awaited<ReturnType<typeof runAndStoreValidation>>;
    await withTransaction(db, async (tx) => {
      report = await runAndStoreValidation(tx, submissionId, bundle);
    });

    await withTransaction(db, async (tx) => {
      await runAndStoreHeuristics(tx, submissionId, seed.semesterId, bundle, report!);
    });

    const [valRow] = await db
      .select({
        check_8_status: validation_results.check_8_status,
        overall: validation_results.overall,
      })
      .from(validation_results)
      .where(eq(validation_results.submission_id, submissionId));

    expect(valRow, 'validation_results row must exist').toBeDefined();
    // Check 8 passes: submitted content matches the last recorded doc.save hash.
    expect(valRow!.check_8_status).toBe('pass');
    // A clean 1.1 bundle can now reach overall 'pass' (Check 8 is no longer skipped).
    expect(valRow!.overall).toBe('pass');

    // Assert format_version stored in submissions row.
    const [subRow] = await db
      .select({ format_version: submissions.format_version })
      .from(submissions)
      .where(eq(submissions.id, submissionId));

    expect(subRow!.format_version).toBe('1.1');
  });
});
