/**
 * Integration tests for finalizeIngestJob (Phase 9b) — the real aggregation logic.
 *
 * Uses withTestDb — requires Docker.
 */

import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { enqueueIngestJob, finalizeIngestJob, markIngestJobRunning } from './job-control.js';
import { users, courses, semesters, ingest_jobs, ingest_files } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

async function seedIngestFile(
  db: DrizzleDb,
  jobId: string,
  status: string,
  filename = 'hw01-123456.zip',
) {
  const [file] = await db
    .insert(ingest_files)
    .values({
      ingest_job_id: jobId,
      original_filename: filename,
      size_bytes: 100,
      blob_sha256: crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, ''),
      status,
    })
    .returning();
  return file!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('finalizeIngestJob (phase 9b)', () => {
  it('sets status=succeeded when all files are matched', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      await seedIngestFile(db, jobId, 'matched', 'f1.zip');
      await seedIngestFile(db, jobId, 'matched', 'f2.zip');
      await seedIngestFile(db, jobId, 'matched', 'f3.zip');

      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(job!.status).toBe('succeeded');
      expect(job!.completed_at).not.toBeNull();

      const summary = job!.summary as Record<string, number>;
      expect(summary['total']).toBe(3);
      expect(summary['matched']).toBe(3);
      expect(summary['failed']).toBe(0);
    });
  });

  it('sets status=succeeded for all-duplicate files', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      await seedIngestFile(db, jobId, 'duplicate');
      await seedIngestFile(db, jobId, 'duplicate');

      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(job!.status).toBe('succeeded');

      const summary = job!.summary as Record<string, number>;
      expect(summary['duplicate']).toBe(2);
    });
  });

  it('sets status=succeeded for mixed matched/duplicate/superseded', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      await seedIngestFile(db, jobId, 'matched');
      await seedIngestFile(db, jobId, 'duplicate');
      await seedIngestFile(db, jobId, 'superseded');

      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(job!.status).toBe('succeeded');
    });
  });

  it('sets status=partial when some files are unmatched', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      await seedIngestFile(db, jobId, 'matched');
      await seedIngestFile(db, jobId, 'unmatched');
      await seedIngestFile(db, jobId, 'matched');

      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(job!.status).toBe('partial');

      const summary = job!.summary as Record<string, number>;
      expect(summary['matched']).toBe(2);
      expect(summary['unmatched']).toBe(1);
    });
  });

  it('sets status=partial when some files failed', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      await seedIngestFile(db, jobId, 'matched');
      await seedIngestFile(db, jobId, 'failed');

      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(job!.status).toBe('partial');
    });
  });

  it('sets status=partial when all files are failed (not completely failed job)', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      await seedIngestFile(db, jobId, 'failed');
      await seedIngestFile(db, jobId, 'failed');

      await finalizeIngestJob(db, jobId);

      // All files failed but the worker finished — 'partial' not 'failed'
      // ('failed' is for worker-level abort; this uses failIngestJob separately).
      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(job!.status).toBe('partial');
    });
  });

  it('computes correct summary counts for all statuses', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      await seedIngestFile(db, jobId, 'matched');
      await seedIngestFile(db, jobId, 'matched');
      await seedIngestFile(db, jobId, 'unmatched');
      await seedIngestFile(db, jobId, 'duplicate');
      await seedIngestFile(db, jobId, 'failed');
      await seedIngestFile(db, jobId, 'superseded');
      await seedIngestFile(db, jobId, 'discarded');

      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      const summary = job!.summary as Record<string, number>;
      expect(summary['total']).toBe(7);
      expect(summary['matched']).toBe(2);
      expect(summary['unmatched']).toBe(1);
      expect(summary['duplicate']).toBe(1);
      expect(summary['failed']).toBe(1);
      expect(summary['superseded']).toBe(1);
      expect(summary['discarded']).toBe(1);
    });
  });

  it('is idempotent — does not change a job that is already succeeded', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      await seedIngestFile(db, jobId, 'matched');
      await finalizeIngestJob(db, jobId);

      // Modify a file to 'failed' after the first finalize — should not affect the result.
      const files = await db
        .select()
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId));
      await db
        .update(ingest_files)
        .set({ status: 'failed' })
        .where(eq(ingest_files.id, files[0]!.id));

      // Second finalize call: should no-op (already succeeded).
      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      // Should still be succeeded (idempotent).
      expect(job!.status).toBe('succeeded');
    });
  });

  it('no-ops for a non-existent job (worker idempotency)', async () => {
    await withTestDb(async (db) => {
      await expect(finalizeIngestJob(db, crypto.randomUUID())).resolves.toBeUndefined();
    });
  });

  it('no-ops for a cancelled job', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      // Set to cancelled directly.
      await db
        .update(ingest_jobs)
        .set({ status: 'cancelled', completed_at: new Date() })
        .where(eq(ingest_jobs.id, jobId));

      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(job!.status).toBe('cancelled'); // unchanged
    });
  });

  it('refreshes the summary for a cancelled job while keeping status cancelled', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      // A run that was cancelled mid-flight: one file had already matched, the
      // rest were discarded by the cooperative-cancel gate in the worker.
      await seedIngestFile(db, jobId, 'matched', 'f1.zip');
      await seedIngestFile(db, jobId, 'discarded', 'f2.zip');
      await seedIngestFile(db, jobId, 'discarded', 'f3.zip');

      // Cancel the job (terminal).
      await db
        .update(ingest_jobs)
        .set({ status: 'cancelled', completed_at: new Date() })
        .where(eq(ingest_jobs.id, jobId));

      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      // Status is preserved — cancel is terminal and never becomes succeeded/partial.
      expect(job!.status).toBe('cancelled');
      // ...but the summary now reflects what actually happened.
      const summary = job!.summary as Record<string, number>;
      expect(summary['total']).toBe(3);
      expect(summary['matched']).toBe(1);
      expect(summary['discarded']).toBe(2);
    });
  });

  it('sets total=0 and status=succeeded for a job with no files', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markIngestJobRunning(db, jobId);

      // No files inserted.
      await finalizeIngestJob(db, jobId);

      const [job] = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(job!.status).toBe('succeeded');
      expect((job!.summary as Record<string, number>)['total']).toBe(0);
    });
  });
});
