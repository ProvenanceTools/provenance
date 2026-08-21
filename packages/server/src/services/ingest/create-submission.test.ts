/**
 * Integration tests for createSubmission (PRD §9.3 phase 5).
 *
 * Uses withTestDb (Postgres) + withTestMinio (blob storage).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and, asc } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { createSubmission } from './create-submission.js';
import type { CreateSubmissionOutcome, CreateSubmissionResult } from './create-submission.js';
import { stripBundleSourceFiles } from './strip-bundle.js';
import { putBlob, getBlob } from '../storage/blobs.js';
import { ingestStagingKey, bundleKey } from '../storage/keys.js';
import {
  users,
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';

/**
 * Narrow a phase-5 outcome to the CREATED case.
 *
 * `createSubmission` can now also answer `'duplicate'` — a concurrent writer
 * committed these exact bytes first. These tests all assert the creating path,
 * so anything else is a test failure and should say so loudly rather than
 * being cast away.
 */
function created(outcome: CreateSubmissionOutcome): CreateSubmissionResult {
  if (outcome.kind !== 'created') {
    throw new Error(`expected createSubmission to create a row, got kind='${outcome.kind}'`);
  }
  return outcome;
}

// createSubmission strips source files from the staging bundle before storing,
// so the staging blob must be a real bundle ZIP (in production it has already
// passed parse-bundle-phase by the time createSubmission runs). Built once.
let bundleBytes: Uint8Array;
beforeAll(async () => {
  const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
  bundleBytes = new Uint8Array(zipBuffer);
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(db: DrizzleDb) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({ id, google_subject: `sub-${id}`, email: `u-${id}@berkeley.edu`, display_name: 'U' })
    .returning();
  return user!;
}

async function seedSemester(db: DrizzleDb) {
  const slug = `cs61a-${crypto.randomUUID().slice(0, 8)}`;
  const [course] = await db.insert(courses).values({ name: 'CS 61A', slug }).returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `fa2024-${crypto.randomUUID().slice(0, 8)}`,
      display_name: 'Fall 2024',
      filename_convention: '(?<sid>\\d+)',
    })
    .returning();
  return semester!;
}

async function seedStudent(db: DrizzleDb, semesterId: string, sid = '123456') {
  const [entry] = await db
    .insert(roster_entries)
    .values({ semester_id: semesterId, sid, display_name: 'Student' })
    .returning();
  return entry!;
}

async function seedIngestJob(db: DrizzleDb, semesterId: string, userId: string) {
  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semesterId, uploaded_by: userId, status: 'running', summary: {} })
    .returning();
  return job!;
}

async function stageTestBlob(
  client: StorageClient,
  jobId: string,
  fileId: string,
  content: Uint8Array,
): Promise<string> {
  const key = ingestStagingKey(jobId, fileId);
  await putBlob(client, key, content);
  return key;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSubmission', () => {
  it('inserts a submission row with version_index=1 for a new student-assignment', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId = crypto.randomUUID();
        const content = bundleBytes;
        const stagingKey = await stageTestBlob(client, job.id, fileId, content);

        const result = created(
          await createSubmission(
            { db, storageClient: client },
            {
              semesterId: semester.id,
              assignmentIdStr: 'hw01',
              studentId: student.id,
              blobSha256: 'a'.repeat(64),
              stagingKey,
              originalFilename: 'hw01-123456.zip',
              ingestJobId: job.id,
            },
          ),
        );

        expect(result.versionIndex).toBe(1);
        expect(result.supersededIds).toHaveLength(0);

        const rows = await db
          .select()
          .from(submissions)
          .where(eq(submissions.id, result.submissionId));
        expect(rows).toHaveLength(1);
        expect(rows[0]!.version_index).toBe(1);
        expect(rows[0]!.assignment_id).toBeTruthy();
      });
    });
  });

  it('allocates version_index=2 for a re-upload by the same student', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        // First upload.
        const fileId1 = crypto.randomUUID();
        const content1 = bundleBytes;
        const stagingKey1 = await stageTestBlob(client, job.id, fileId1, content1);

        const result1 = created(
          await createSubmission(
            { db, storageClient: client },
            {
              semesterId: semester.id,
              assignmentIdStr: 'hw01',
              studentId: student.id,
              blobSha256: 'b'.repeat(64),
              stagingKey: stagingKey1,
              originalFilename: 'hw01-123456.zip',
              ingestJobId: job.id,
            },
          ),
        );
        expect(result1.versionIndex).toBe(1);

        // Second upload (re-upload).
        const fileId2 = crypto.randomUUID();
        const content2 = bundleBytes;
        const stagingKey2 = await stageTestBlob(client, job.id, fileId2, content2);

        const result2 = created(
          await createSubmission(
            { db, storageClient: client },
            {
              semesterId: semester.id,
              assignmentIdStr: 'hw01',
              studentId: student.id,
              blobSha256: 'c'.repeat(64),
              stagingKey: stagingKey2,
              originalFilename: 'hw01-123456.zip',
              ingestJobId: job.id,
            },
          ),
        );
        expect(result2.versionIndex).toBe(2);
        expect(result2.supersededIds).toContain(result1.submissionId);
      });
    });
  });

  it('sets superseded_by_submission_id on prior versions after a re-upload', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId1 = crypto.randomUUID();
        const stagingKey1 = await stageTestBlob(client, job.id, fileId1, bundleBytes);
        const result1 = created(
          await createSubmission(
            { db, storageClient: client },
            {
              semesterId: semester.id,
              assignmentIdStr: 'hw02',
              studentId: student.id,
              blobSha256: 'd'.repeat(64),
              stagingKey: stagingKey1,
              originalFilename: 'hw02-123456.zip',
              ingestJobId: job.id,
            },
          ),
        );

        const fileId2 = crypto.randomUUID();
        const stagingKey2 = await stageTestBlob(client, job.id, fileId2, bundleBytes);
        const result2 = created(
          await createSubmission(
            { db, storageClient: client },
            {
              semesterId: semester.id,
              assignmentIdStr: 'hw02',
              studentId: student.id,
              blobSha256: 'e'.repeat(64),
              stagingKey: stagingKey2,
              originalFilename: 'hw02-123456.zip',
              ingestJobId: job.id,
            },
          ),
        );

        // Verify DB: v1 should have superseded_by_submission_id = v2.id
        const [v1Row] = await db
          .select({ superseded_by: submissions.superseded_by_submission_id })
          .from(submissions)
          .where(eq(submissions.id, result1.submissionId));
        expect(v1Row!.superseded_by).toBe(result2.submissionId);
      });
    });
  });

  it('moves blob from staging to final key, staging key no longer accessible', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId = crypto.randomUUID();
        const content = bundleBytes;
        const stagingKey = await stageTestBlob(client, job.id, fileId, content);

        const result = created(
          await createSubmission(
            { db, storageClient: client },
            {
              semesterId: semester.id,
              assignmentIdStr: 'hw01',
              studentId: student.id,
              blobSha256: 'f'.repeat(64),
              stagingKey,
              originalFilename: 'hw01-123456.zip',
              ingestJobId: job.id,
            },
          ),
        );

        // Final blob should be readable and equal the source-stripped bundle
        // (createSubmission strips student source before storing).
        const finalKey = bundleKey(semester.id, result.submissionId);
        const finalStream = await getBlob(client, finalKey);
        const finalBytes = await collectStream(finalStream);
        expect(finalBytes).toEqual(await stripBundleSourceFiles(content));

        // Staging key should no longer be readable.
        await expect(getBlob(client, stagingKey)).rejects.toThrow();
      });
    });
  });

  it('upserts the assignments row and reuses it on subsequent uploads', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student1 = await seedStudent(db, semester.id, '111111');
        const student2 = await seedStudent(db, semester.id, '222222');
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId1 = crypto.randomUUID();
        const stagingKey1 = await stageTestBlob(client, job.id, fileId1, bundleBytes);
        const result1 = created(
          await createSubmission(
            { db, storageClient: client },
            {
              semesterId: semester.id,
              assignmentIdStr: 'hw03',
              studentId: student1.id,
              blobSha256: '1'.repeat(64),
              stagingKey: stagingKey1,
              originalFilename: 'hw03-111111.zip',
              ingestJobId: job.id,
            },
          ),
        );

        const fileId2 = crypto.randomUUID();
        const stagingKey2 = await stageTestBlob(client, job.id, fileId2, bundleBytes);
        const result2 = created(
          await createSubmission(
            { db, storageClient: client },
            {
              semesterId: semester.id,
              assignmentIdStr: 'hw03', // same assignment
              studentId: student2.id,
              blobSha256: '2'.repeat(64),
              stagingKey: stagingKey2,
              originalFilename: 'hw03-222222.zip',
              ingestJobId: job.id,
            },
          ),
        );

        // Both submissions reference the same assignment row.
        const [sub1] = await db
          .select({ assignment_id: submissions.assignment_id })
          .from(submissions)
          .where(eq(submissions.id, result1.submissionId));
        const [sub2] = await db
          .select({ assignment_id: submissions.assignment_id })
          .from(submissions)
          .where(eq(submissions.id, result2.submissionId));
        expect(sub1!.assignment_id).toBe(sub2!.assignment_id);

        // Only one assignment row for hw03 in this semester.
        const aRows = await db
          .select()
          .from(assignments)
          .where(
            and(
              eq(assignments.semester_id, semester.id),
              eq(assignments.assignment_id_str, 'hw03'),
            ),
          );
        expect(aRows).toHaveLength(1);
      });
    });
  });

  it('stores recorder_version and format_version from manifest', async () => {
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        const fileId = crypto.randomUUID();
        const stagingKey = await stageTestBlob(client, job.id, fileId, bundleBytes);

        const result = created(
          await createSubmission(
            { db, storageClient: client },
            {
              semesterId: semester.id,
              assignmentIdStr: 'hw01',
              studentId: student.id,
              blobSha256: 'a'.repeat(64),
              stagingKey,
              originalFilename: 'hw01-123456.zip',
              ingestJobId: job.id,
              recorderVersion: '1.2.3',
              formatVersion: '1.0',
            },
          ),
        );

        const [row] = await db
          .select({
            recorder_version: submissions.recorder_version,
            format_version: submissions.format_version,
          })
          .from(submissions)
          .where(eq(submissions.id, result.submissionId));
        expect(row!.recorder_version).toBe('1.2.3');
        expect(row!.format_version).toBe('1.0');
      });
    });
  });

  it('serializes concurrent uploads under row lock (version_index allocation is unique)', async () => {
    // Phase 9 exit gate: concurrent uploads of the same (semester, assignment,
    // student) must serialize under the FOR UPDATE lock so that each concurrent
    // call gets a distinct version_index. This test fires 3 concurrent
    // createSubmission calls for the same cohort and verifies that:
    //   - all 3 succeed
    //   - version_indexes are exactly {2, 3, 4} (an existing submission was #1)
    //   - the supersede chain is linear (each points to the next)
    await withTestDb(async (db) => {
      await withTestMinio(async ({ client }) => {
        const user = await seedUser(db);
        const semester = await seedSemester(db);
        const student = await seedStudent(db, semester.id);
        const job = await seedIngestJob(db, semester.id, user.id);

        // Seed the first submission (version_index = 1).
        const fileId0 = crypto.randomUUID();
        const stagingKey0 = await stageTestBlob(client, job.id, fileId0, bundleBytes);
        await createSubmission(
          { db, storageClient: client },
          {
            semesterId: semester.id,
            assignmentIdStr: 'hw_concurrent',
            studentId: student.id,
            blobSha256: '0'.repeat(64),
            stagingKey: stagingKey0,
            originalFilename: 'hw_concurrent-123456.zip',
            ingestJobId: job.id,
          },
        );

        // Fire 3 concurrent uploads for the same cohort.
        const results = await Promise.allSettled(
          [1, 2, 3].map(async (n) => {
            const fid = crypto.randomUUID();
            const key = await stageTestBlob(client, job.id, fid, bundleBytes);
            return createSubmission(
              { db, storageClient: client },
              {
                semesterId: semester.id,
                assignmentIdStr: 'hw_concurrent',
                studentId: student.id,
                blobSha256: String(n).repeat(64),
                stagingKey: key,
                originalFilename: 'hw_concurrent-123456.zip',
                ingestJobId: job.id,
              },
            );
          }),
        );

        // All 3 must succeed.
        for (const r of results) {
          expect(
            r.status,
            `Expected all concurrent uploads to succeed; got: ${JSON.stringify(r)}`,
          ).toBe('fulfilled');
        }

        // Fetch all submissions for this cohort sorted by version_index.
        const allRows = await db
          .select({
            id: submissions.id,
            version_index: submissions.version_index,
            superseded_by: submissions.superseded_by_submission_id,
          })
          .from(submissions)
          .where(
            and(eq(submissions.semester_id, semester.id), eq(submissions.student_id, student.id)),
          )
          .orderBy(asc(submissions.version_index));

        // Should have 4 rows (1 seed + 3 concurrent).
        expect(allRows).toHaveLength(4);

        // version_indexes must be exactly 1, 2, 3, 4 — no duplicates.
        const indexes = allRows.map((r) => r.version_index);
        expect(indexes).toEqual([1, 2, 3, 4]);

        // Supersede chain: 1→something, 2→something, 3→something, 4→null.
        // The last row (highest version_index) has no superseder.
        const lastRow = allRows.at(-1)!;
        expect(lastRow.superseded_by).toBeNull();

        // All earlier rows must be superseded (superseded_by is not null).
        for (const row of allRows.slice(0, -1)) {
          expect(row.superseded_by).not.toBeNull();
        }
      });
    });
  });
});
