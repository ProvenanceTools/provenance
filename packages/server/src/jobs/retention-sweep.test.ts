/**
 * Integration tests for the retention-sweep cron job (Phase 25).
 *
 * Tests:
 *   1. Happy path: semester archived 600 days ago, blob_retention_days=365.
 *      runRetentionSweep calls deleteBlob for the submission's blob_object_key.
 *   2. Not yet eligible: semester archived 100 days ago, blob_retention_days=365.
 *      runRetentionSweep does NOT call deleteBlob.
 *   3. Contract: DB rows are NEVER deleted — only the blob in storage.
 *      After the sweep, the submissions row is still present.
 *   4. Not archived: semester has archived_at=null → blob is not purged.
 *
 * Uses withTestDb (testcontainers) for real Postgres, and a mock storageClient
 * so the test does not require a running MinIO instance.
 */

import { vi, describe, it, expect } from 'vitest';

// Mock the logging module so tests don't require a fully-configured env singleton.
vi.mock('../logging.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

import { withTestDb } from '../../test/helpers/db.js';
import { runRetentionSweep } from './retention-sweep.js';
import {
  users,
  courses,
  semesters,
  roster_entries,
  ingest_jobs,
  assignments,
  submissions,
} from '../db/schema.js';
import type { StorageClient } from '../services/storage/client.js';
import type { AwsClient } from 'aws4fetch';
import { sql } from 'drizzle-orm';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Mock storage client
// ---------------------------------------------------------------------------

function makeStorageMock(): Extract<StorageClient, { kind: 's3' }> & { deletedKeys: string[] } {
  const deletedKeys: string[] = [];
  const mock = {
    kind: 's3' as const,
    aws: {} as AwsClient,
    bucketUrl: 'http://localhost:9000/test',
    deletedKeys,
  };
  return mock;
}

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(db: Parameters<Parameters<typeof withTestDb>[0]>[0]): Promise<string> {
  const rows = await db
    .insert(users)
    .values({ google_subject: `sub-${Math.random()}`, email: 'ta@b.edu', display_name: 'TA' })
    .returning({ id: users.id });
  return rows[0]!.id;
}

async function seedCourse(db: Parameters<Parameters<typeof withTestDb>[0]>[0]): Promise<string> {
  const rows = await db
    .insert(courses)
    .values({ name: 'CS 61A', slug: `cs61a-${Math.random()}` })
    .returning({ id: courses.id });
  return rows[0]!.id;
}

async function seedSemester(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  courseId: string,
  archivedDaysAgo: number | null,
  blobRetentionDays: number,
): Promise<string> {
  const archivedAt =
    archivedDaysAgo !== null ? new Date(Date.now() - archivedDaysAgo * 24 * 60 * 60 * 1000) : null;

  const rows = await db
    .insert(semesters)
    .values({
      course_id: courseId,
      term: 'fa',
      year: 2022,
      slug: `fa22-${Math.random()}`,
      display_name: 'Fall 2022',
      filename_convention: '^(?P<sid>\\d+)-hw1\\.zip$',
      blob_retention_days: blobRetentionDays,
      derived_retention_days: Math.max(blobRetentionDays + 1, 1825),
      archived_at: archivedAt,
    })
    .returning({ id: semesters.id });
  return rows[0]!.id;
}

async function seedIngestJob(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  semesterId: string,
  userId: string,
): Promise<string> {
  const rows = await db
    .insert(ingest_jobs)
    .values({
      semester_id: semesterId,
      uploaded_by: userId,
      status: 'succeeded',
    })
    .returning({ id: ingest_jobs.id });
  return rows[0]!.id;
}

async function seedAssignment(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  semesterId: string,
): Promise<string> {
  const rows = await db
    .insert(assignments)
    .values({
      semester_id: semesterId,
      assignment_id_str: 'hw1',
      label: 'Homework 1',
    })
    .returning({ id: assignments.id });
  return rows[0]!.id;
}

async function seedRosterEntry(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  semesterId: string,
): Promise<string> {
  const rows = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: `3${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`,
      email: `student${Math.random()}@b.edu`,
      display_name: 'Student',
    })
    .returning({ id: roster_entries.id });
  return rows[0]!.id;
}

async function seedSubmission(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  opts: {
    semesterId: string;
    assignmentId: string;
    studentId: string;
    ingestJobId: string;
    blobObjectKey: string;
  },
): Promise<string> {
  const rows = await db
    .insert(submissions)
    .values({
      semester_id: opts.semesterId,
      assignment_id: opts.assignmentId,
      student_id: opts.studentId,
      ingest_job_id: opts.ingestJobId,
      blob_object_key: opts.blobObjectKey,
      blob_sha256: `sha256-${Math.random()}`,
      source_filename: 'test.zip',
      version_index: 1,
    })
    .returning({ id: submissions.id });
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runRetentionSweep', () => {
  it('deletes blob for submission in a semester archived 600 days ago (retention=365)', async () => {
    await withTestDb(async (db) => {
      const userId = await seedUser(db);
      const courseId = await seedCourse(db);
      const semesterId = await seedSemester(db, courseId, 600, 365);
      const ingestJobId = await seedIngestJob(db, semesterId, userId);
      const assignmentId = await seedAssignment(db, semesterId);
      const studentId = await seedRosterEntry(db, semesterId);
      const blobKey = `submissions/${Math.random()}/bundle.zip`;
      await seedSubmission(db, {
        semesterId,
        assignmentId,
        studentId,
        ingestJobId,
        blobObjectKey: blobKey,
      });

      const storage = makeStorageMock();
      // Wire deleteBlob mock on the storage client's aws property.
      // The real deleteBlob takes (client, key); we mock it via vi.spyOn on the module.
      const { deleteBlob } = await import('../services/storage/blobs.js');
      const spy = vi
        .spyOn(await import('../services/storage/blobs.js'), 'deleteBlob')
        .mockResolvedValue(undefined);

      const result = await runRetentionSweep(db, storage);

      expect(result.purged).toBe(1);
      expect(result.errors).toBe(0);
      expect(spy).toHaveBeenCalledWith(storage, blobKey);

      spy.mockRestore();
      void deleteBlob; // suppress unused-import warning
    });
  });

  it('does NOT delete blob for submission archived only 100 days ago (retention=365)', async () => {
    await withTestDb(async (db) => {
      const userId = await seedUser(db);
      const courseId = await seedCourse(db);
      const semesterId = await seedSemester(db, courseId, 100, 365);
      const ingestJobId = await seedIngestJob(db, semesterId, userId);
      const assignmentId = await seedAssignment(db, semesterId);
      const studentId = await seedRosterEntry(db, semesterId);
      const blobKey = `submissions/${Math.random()}/bundle.zip`;
      await seedSubmission(db, {
        semesterId,
        assignmentId,
        studentId,
        ingestJobId,
        blobObjectKey: blobKey,
      });

      const storage = makeStorageMock();
      const spy = vi
        .spyOn(await import('../services/storage/blobs.js'), 'deleteBlob')
        .mockResolvedValue(undefined);

      const result = await runRetentionSweep(db, storage);

      expect(result.purged).toBe(0);
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });

  it('never deletes DB rows — submissions row is untouched after sweep', async () => {
    await withTestDb(async (db) => {
      const userId = await seedUser(db);
      const courseId = await seedCourse(db);
      const semesterId = await seedSemester(db, courseId, 600, 365);
      const ingestJobId = await seedIngestJob(db, semesterId, userId);
      const assignmentId = await seedAssignment(db, semesterId);
      const studentId = await seedRosterEntry(db, semesterId);
      const blobKey = `submissions/${Math.random()}/bundle.zip`;
      const submissionId = await seedSubmission(db, {
        semesterId,
        assignmentId,
        studentId,
        ingestJobId,
        blobObjectKey: blobKey,
      });

      const storage = makeStorageMock();
      const spy = vi
        .spyOn(await import('../services/storage/blobs.js'), 'deleteBlob')
        .mockResolvedValue(undefined);

      await runRetentionSweep(db, storage);

      // Verify submissions row still exists.
      const rows = await db
        .select({ id: submissions.id })
        .from(submissions)
        .where(sql`${submissions.id} = ${submissionId}::uuid`);
      expect(rows).toHaveLength(1);

      spy.mockRestore();
    });
  });

  it('does NOT delete blob when semester is not archived (archived_at = null)', async () => {
    await withTestDb(async (db) => {
      const userId = await seedUser(db);
      const courseId = await seedCourse(db);
      // archivedDaysAgo = null → semester not archived
      const semesterId = await seedSemester(db, courseId, null, 365);
      const ingestJobId = await seedIngestJob(db, semesterId, userId);
      const assignmentId = await seedAssignment(db, semesterId);
      const studentId = await seedRosterEntry(db, semesterId);
      const blobKey = `submissions/${Math.random()}/bundle.zip`;
      await seedSubmission(db, {
        semesterId,
        assignmentId,
        studentId,
        ingestJobId,
        blobObjectKey: blobKey,
      });

      const storage = makeStorageMock();
      const spy = vi
        .spyOn(await import('../services/storage/blobs.js'), 'deleteBlob')
        .mockResolvedValue(undefined);

      const result = await runRetentionSweep(db, storage);

      expect(result.purged).toBe(0);
      expect(spy).not.toHaveBeenCalled();

      spy.mockRestore();
    });
  });
});
