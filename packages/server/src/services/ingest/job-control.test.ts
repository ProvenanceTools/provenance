/**
 * Integration tests for ingest job-control (enqueueIngestJob, finalizeIngestJob, cancelIngestJob).
 *
 * Uses withTestDb — requires Docker.
 */

import { vi, describe, it, expect } from 'vitest';

// Mock the logging module so tests don't require a fully-configured env singleton.
vi.mock('../../logging.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    debug: () => {},
    error: () => {},
  }),
}));

import { eq } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import {
  enqueueIngestJob,
  finalizeIngestJob,
  cancelIngestJob,
  failIngestJob,
  markStagingStarted,
  markStagingComplete,
  maybeEnqueueFinalize,
  recordIngestJobSkipped,
} from './job-control.js';
import { users, courses, semesters, ingest_jobs, ingest_files } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

async function seedUser(db: DrizzleDb) {
  const id = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id,
      google_subject: `sub-${id}`,
      email: `user-${id}@berkeley.edu`,
      display_name: 'Test User',
      is_superadmin: false,
    })
    .returning();
  return user!;
}

async function seedSemester(db: DrizzleDb, _userId: string) {
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

// ---------------------------------------------------------------------------
// enqueueIngestJob
// ---------------------------------------------------------------------------

describe('enqueueIngestJob', () => {
  it('inserts a row with status=queued and returns jobId', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);

      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      expect(jobId).toBeTruthy();

      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe('queued');
      expect(row.semester_id).toBe(semester.id);
      expect(row.uploaded_by).toBe(user.id);
      expect(row.summary).toEqual({});
      expect(row.started_at).toBeNull();
      expect(row.completed_at).toBeNull();
    });
  });

  it('creates distinct jobIds for multiple calls', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);

      const { jobId: j1 } = await enqueueIngestJob(db, semester.id, user.id);
      const { jobId: j2 } = await enqueueIngestJob(db, semester.id, user.id);
      expect(j1).not.toBe(j2);
    });
  });
});

// ---------------------------------------------------------------------------
// finalizeIngestJob (phase 9b — full aggregation)
// ---------------------------------------------------------------------------

describe('finalizeIngestJob', () => {
  it('sets status=succeeded on a running job with no files', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      // Move to running first (finalize only transitions from running).
      await db
        .update(ingest_jobs)
        .set({ status: 'running', started_at: new Date() })
        .where(eq(ingest_jobs.id, jobId));

      await expect(finalizeIngestJob(db, jobId)).resolves.toBeUndefined();

      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows[0]!.status).toBe('succeeded');
    });
  });

  it('no-ops gracefully if jobId does not exist', async () => {
    await withTestDb(async (db) => {
      const nonExistent = crypto.randomUUID();
      await expect(finalizeIngestJob(db, nonExistent)).resolves.toBeUndefined();
    });
  });

  it('no-ops gracefully for a cancelled job', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await cancelIngestJob(db, jobId, semester.id);
      // Should not throw even though status is cancelled.
      await expect(finalizeIngestJob(db, jobId)).resolves.toBeUndefined();

      // Status should remain cancelled.
      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows[0]!.status).toBe('cancelled');
    });
  });
});

// ---------------------------------------------------------------------------
// cancelIngestJob
// ---------------------------------------------------------------------------

describe('cancelIngestJob', () => {
  it('sets status=cancelled on a queued job and returns cancelled:true', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      const result = await cancelIngestJob(db, jobId, semester.id);
      expect(result.cancelled).toBe(true);
      expect(result.previous_status).toBe('queued');

      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows[0]!.status).toBe('cancelled');
      expect(rows[0]!.completed_at).not.toBeNull();
    });
  });

  it('is idempotent — cancelling an already-cancelled job returns cancelled:false', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await cancelIngestJob(db, jobId, semester.id);
      const result = await cancelIngestJob(db, jobId, semester.id);
      expect(result.cancelled).toBe(false);
      expect(result.previous_status).toBe('cancelled');
    });
  });

  it('throws INGEST_JOB_NOT_CANCELLABLE (409) when job is in a terminal state', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      // Force-set to 'failed' via failIngestJob (simulates a terminal state).
      await failIngestJob(db, jobId, 'forced failure for test');

      const err = await cancelIngestJob(db, jobId, semester.id).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe('INGEST_JOB_NOT_CANCELLABLE');
    });
  });

  it('throws NOT_FOUND if jobId does not exist in the semester', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const nonExistent = crypto.randomUUID();
      await expect(cancelIngestJob(db, nonExistent, semester.id)).rejects.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// failIngestJob
// ---------------------------------------------------------------------------

describe('failIngestJob', () => {
  it('sets status=failed with error detail in summary', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await failIngestJob(db, jobId, 'stageBlob threw on file 2');

      const rows = await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId));
      expect(rows[0]!.status).toBe('failed');
      expect(rows[0]!.completed_at).not.toBeNull();
      expect((rows[0]!.summary as Record<string, string>).error).toBe('stageBlob threw on file 2');
    });
  });

  it('no-ops silently if jobId does not exist', async () => {
    await withTestDb(async (db) => {
      // Should not throw.
      await expect(failIngestJob(db, crypto.randomUUID(), 'irrelevant')).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// maybeEnqueueFinalize — staging_complete gate
// ---------------------------------------------------------------------------

/** Insert a terminal (non-pending) ingest_files row so it is NOT counted as pending. */
async function seedTerminalFile(db: DrizzleDb, jobId: string) {
  await db.insert(ingest_files).values({
    id: crypto.randomUUID(),
    ingest_job_id: jobId,
    original_filename: 'f.zip',
    size_bytes: 1,
    blob_sha256: 'a'.repeat(64),
    status: 'matched',
  });
}

/** Insert a pending ingest_files row. */
async function seedPendingFile(db: DrizzleDb, jobId: string) {
  await db.insert(ingest_files).values({
    id: crypto.randomUUID(),
    ingest_job_id: jobId,
    original_filename: 'p.zip',
    size_bytes: 1,
    blob_sha256: 'b'.repeat(64),
    status: 'pending',
  });
}

describe('maybeEnqueueFinalize gate', () => {
  it('does NOT enqueue finalize while staging_complete is false, even with 0 pending', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markStagingStarted(db, jobId); // staging_complete = false
      await seedTerminalFile(db, jobId); // 0 pending

      const boss = { send: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await maybeEnqueueFinalize(boss as any, db, jobId);

      expect(boss.send).not.toHaveBeenCalled();
    });
  });

  it('enqueues finalize once staging_complete is true and 0 pending', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markStagingStarted(db, jobId);
      await seedTerminalFile(db, jobId);
      await markStagingComplete(db, jobId); // staging_complete = true

      const boss = { send: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await maybeEnqueueFinalize(boss as any, db, jobId);

      expect(boss.send).toHaveBeenCalledTimes(1);
      expect(boss.send).toHaveBeenCalledWith(
        'ingest_finalize',
        { ingestJobId: jobId },
        { singletonKey: jobId, retryLimit: 5 },
      );
    });
  });

  it('does NOT enqueue finalize when files are still pending', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      // staging_complete defaults true; but a pending file remains.
      await seedPendingFile(db, jobId);

      const boss = { send: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await maybeEnqueueFinalize(boss as any, db, jobId);

      expect(boss.send).not.toHaveBeenCalled();
    });
  });

  it('markStagingStarted then markStagingComplete flips staging_complete', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await markStagingStarted(db, jobId);
      let row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.staging_complete).toBe(false);

      await markStagingComplete(db, jobId);
      row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.staging_complete).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// recordIngestJobSkipped (migration 0028)
// ---------------------------------------------------------------------------
//
// A scope rejected during resolution never becomes an `ingest_files` row — that
// is what being skipped means — so it is structurally invisible to `summary`,
// which is nothing but a count of those rows. `ingest_jobs.skipped` is the only
// record it existed, and it is what lets the chunked-upload path report skips
// at all. These tests pin the two things that make it trustworthy: `null` and
// `[]` mean different things, and nothing on the finish/cancel/fail paths is
// allowed to overwrite it.

/** The wire shape the column stores, as `toSkippedWire` produces it. */
const SKIPPED_FIXTURE = [
  { folder_key: 'submission_101', scope_path: '', reason: 'submission_type_mismatch' },
  { folder_key: 'submission_101', scope_path: 'proj2/', reason: 'submission_type_mismatch' },
  { folder_key: 'submission_202', scope_path: 'lab5/', reason: 'no_seal' },
];

async function readSkipped(db: DrizzleDb, jobId: string): Promise<unknown> {
  const rows = await db
    .select({ skipped: ingest_jobs.skipped })
    .from(ingest_jobs)
    .where(eq(ingest_jobs.id, jobId));
  return rows[0]!.skipped;
}

describe('recordIngestJobSkipped', () => {
  it('a fresh job reads back null — UNKNOWN, not an empty list', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      // The whole point of the column being nullable with no DEFAULT. A job that
      // has not resolved scopes yet must not be able to claim it skipped nothing.
      expect(await readSkipped(db, jobId)).toBeNull();
    });
  });

  it('persists the list in wire shape', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await recordIngestJobSkipped(db, jobId, SKIPPED_FIXTURE);
      expect(await readSkipped(db, jobId)).toEqual(SKIPPED_FIXTURE);
    });
  });

  it('writes [] as a real value, distinguishable from the null default', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await recordIngestJobSkipped(db, jobId, []);

      // `[]` is a positive statement ("resolution ran and skipped nothing"), so
      // it must survive as an array and NOT collapse back to null.
      const stored = await readSkipped(db, jobId);
      expect(stored).toEqual([]);
      expect(stored).not.toBeNull();
    });
  });

  it('REPLACES rather than appends, so a retry cannot duplicate reasons', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      // Re-running staging recomputes an identical list. The ingest pipeline is
      // required to be idempotent — a retry must produce the same result — so
      // recording twice must leave three entries, not six.
      await recordIngestJobSkipped(db, jobId, SKIPPED_FIXTURE);
      await recordIngestJobSkipped(db, jobId, SKIPPED_FIXTURE);

      expect(await readSkipped(db, jobId)).toEqual(SKIPPED_FIXTURE);
    });
  });

  it('a later write can shrink the list back to empty', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await recordIngestJobSkipped(db, jobId, SKIPPED_FIXTURE);
      await recordIngestJobSkipped(db, jobId, []);

      // Proves replacement semantics in the direction an append-only child table
      // could never express: a re-ingest of a now-fixed export reports clean.
      expect(await readSkipped(db, jobId)).toEqual([]);
    });
  });

  it('no-ops silently if jobId does not exist', async () => {
    await withTestDb(async (db) => {
      await expect(
        recordIngestJobSkipped(db, crypto.randomUUID(), SKIPPED_FIXTURE),
      ).resolves.toBeUndefined();
    });
  });
});

describe('skipped survives every terminal-state write', () => {
  it('finalizeIngestJob (succeeded) does not clobber it', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await recordIngestJobSkipped(db, jobId, SKIPPED_FIXTURE);

      await db
        .update(ingest_jobs)
        .set({ status: 'running', started_at: new Date() })
        .where(eq(ingest_jobs.id, jobId));
      await finalizeIngestJob(db, jobId);

      const row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.status).toBe('succeeded');
      // finalize REWRITES `summary` wholesale, which is exactly why `skipped`
      // could not live inside it. It must not name this column.
      expect(row.summary).toMatchObject({ total: 0 });
      expect(row.skipped).toEqual(SKIPPED_FIXTURE);
    });
  });

  it('finalizeIngestJob (partial) does not clobber it', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await recordIngestJobSkipped(db, jobId, SKIPPED_FIXTURE);

      await db.insert(ingest_files).values({
        ingest_job_id: jobId,
        original_filename: 'a.zip',
        size_bytes: 10,
        blob_sha256: `sha-${crypto.randomUUID()}`,
        status: 'unmatched',
      });
      await db
        .update(ingest_jobs)
        .set({ status: 'running', started_at: new Date() })
        .where(eq(ingest_jobs.id, jobId));
      await finalizeIngestJob(db, jobId);

      const row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.status).toBe('partial');
      expect(row.skipped).toEqual(SKIPPED_FIXTURE);
    });
  });

  it('a CANCELLED job keeps them across both the cancel and the summary refresh', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await recordIngestJobSkipped(db, jobId, SKIPPED_FIXTURE);

      await cancelIngestJob(db, jobId, semester.id);
      expect(await readSkipped(db, jobId)).toEqual(SKIPPED_FIXTURE);

      // A cancelled job is the one terminal state finalize still writes to: it
      // refreshes `summary` so the cooperative-cancel counts show up. That second
      // write is the easiest place to lose the reasons.
      await finalizeIngestJob(db, jobId);
      const row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.status).toBe('cancelled');
      expect(row.skipped).toEqual(SKIPPED_FIXTURE);
    });
  });

  it('failIngestJob does not clobber them', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await recordIngestJobSkipped(db, jobId, SKIPPED_FIXTURE);

      await failIngestJob(db, jobId, 'boom');

      const row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.status).toBe('failed');
      expect(row.summary).toEqual({ error: 'boom' });
      expect(row.skipped).toEqual(SKIPPED_FIXTURE);
    });
  });

  it('a run that aborts BEFORE recording leaves null, not []', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      // e.g. too_many_files, an invalid export, or a mid-stream staging error:
      // scope resolution never finished, so the list it had is incomplete and
      // must be reported as unknown rather than published as if it were whole.
      await failIngestJob(db, jobId, 'exceeded INGEST_MAX_BATCH_FILES (10)');

      expect(await readSkipped(db, jobId)).toBeNull();
    });
  });
});
