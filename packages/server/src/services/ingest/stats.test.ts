import { vi, describe, it, expect } from 'vitest';
import { eq, count } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { computeAndStoreStats } from './stats.js';
import { per_file_stats, submissions } from '../../db/schema.js';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { computeStats } from '@provenance/analysis-core/index/stats.js';
import type { Bundle, ParsedSession } from '@provenance/analysis-core/loader/types.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic Bundle with doc.open + doc.change + doc.save events
 * for two distinct files. The events have real payload shapes that computeStats
 * and reconstructFile can process correctly.
 */
function makeTwoFileBundle(): Bundle {
  const wallBase = 1_700_000_000_000;
  const sessionId = 'session-0';

  // Each "file" gets: doc.open, doc.change (typed), doc.save
  const makeFile = (path: string, offset: number) => [
    {
      seq: offset,
      t: offset * 100,
      wall: new Date(wallBase + offset * 1000).toISOString(),
      kind: 'doc.open' as const,
      data: { path, content: '' } as unknown as ParsedSession['events'][number]['data'],
      prev_hash: offset === 0 ? 'GENESIS' : `h-${offset - 1}`,
      hash: `h-${offset}`,
    },
    {
      seq: offset + 1,
      t: (offset + 1) * 100,
      wall: new Date(wallBase + (offset + 1) * 1000).toISOString(),
      kind: 'doc.change' as const,
      data: {
        path,
        source: 'typed',
        deltas: [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            text: 'hello',
          },
        ],
      } as unknown as ParsedSession['events'][number]['data'],
      prev_hash: `h-${offset}`,
      hash: `h-${offset + 1}`,
    },
    {
      seq: offset + 2,
      t: (offset + 2) * 100,
      wall: new Date(wallBase + (offset + 2) * 1000).toISOString(),
      kind: 'doc.save' as const,
      data: { path, sha256: 'abc123' } as unknown as ParsedSession['events'][number]['data'],
      prev_hash: `h-${offset + 1}`,
      hash: `h-${offset + 2}`,
    },
  ];

  const fileAEvents = makeFile('hw1.py', 0);
  const fileBEvents = makeFile('hw2.py', 3);
  const allEvents = [...fileAEvents, ...fileBEvents];

  const sessions: ParsedSession[] = [
    {
      sessionId,
      events: allEvents,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
      meta: {} as any,
      slogSha256: 'a'.repeat(64),
      metaSha256: 'b'.repeat(64),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
      firstEvent: allEvents[0] as any,
    },
  ];

  return {
    id: crypto.randomUUID(),
    droppedArtifacts: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
    manifest: {} as any,
    manifestSigHex: '',
    sessions,
    sourceFilename: 'test.zip',
    loadedAt: new Date().toISOString(),
    submissionFiles: new Map(),
  };
}

/**
 * Bundle with events but no file-associated kinds — computeStats.perFile is
 * empty, but active/idle are still defined from the wall-clock gaps.
 */
function makeNoFileBundle(): Bundle {
  const wallBase = 1_700_000_000_000;
  const sessionId = 'session-0';
  const allEvents = [
    {
      seq: 0,
      t: 0,
      wall: new Date(wallBase).toISOString(),
      kind: 'session.start' as const,
      data: { session_id: sessionId } as unknown as ParsedSession['events'][number]['data'],
      prev_hash: 'GENESIS',
      hash: 'h-0',
    },
    {
      seq: 1,
      t: 10_000,
      wall: new Date(wallBase + 10_000).toISOString(),
      kind: 'session.end' as const,
      data: { reason: 'closed' } as unknown as ParsedSession['events'][number]['data'],
      prev_hash: 'h-0',
      hash: 'h-1',
    },
  ];

  const sessions: ParsedSession[] = [
    {
      sessionId,
      events: allEvents,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
      meta: {} as any,
      slogSha256: 'a'.repeat(64),
      metaSha256: 'b'.repeat(64),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
      firstEvent: allEvents[0] as any,
    },
  ];

  return {
    id: crypto.randomUUID(),
    droppedArtifacts: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: synthetic test
    manifest: {} as any,
    manifestSigHex: '',
    sessions,
    sourceFilename: 'test.zip',
    loadedAt: new Date().toISOString(),
    submissionFiles: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeAndStoreStats', () => {
  it('DB rows match direct computeStats output for a 2-file bundle', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeTwoFileBundle();
      await computeAndStoreStats(db, submissionId, bundle);

      // Compute the expected stats via v2 directly.
      const index = buildIndex(bundle);
      const expected = computeStats(index);
      expect(expected.perFile.size).toBe(2);

      const rows = await db
        .select()
        .from(per_file_stats)
        .where(eq(per_file_stats.submission_id, submissionId));
      expect(rows.length).toBe(2);

      for (const row of rows) {
        const fs = expected.perFile.get(row.file_path);
        expect(fs).toBeDefined();
        expect(row.chars_typed).toBe(fs!.charsTyped);
        expect(row.chars_pasted).toBe(fs!.charsPasted);
        expect(row.chars_external_change_delta).toBe(fs!.charsExternalChangeDelta);
        expect(row.saves).toBe(fs!.saves);
        expect(row.reconstruction_tainted).toBe(fs!.reconstructionTainted);
        // Each file is "" → insert "hello" via doc.change → final length 5.
        // start_length stays 0 (recorder always starts from empty file).
        expect(row.final_length).toBe(5);
        expect(row.start_length).toBe(0);
      }
    });
  });

  it('idempotent: re-running on same submissionId does not duplicate rows', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeTwoFileBundle();

      await computeAndStoreStats(db, submissionId, bundle);
      await computeAndStoreStats(db, submissionId, bundle);

      const cntResult = await db
        .select({ cnt: count() })
        .from(per_file_stats)
        .where(eq(per_file_stats.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(2);
    });
  });

  it('CASCADE: deleting submission removes per_file_stats rows', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeTwoFileBundle();
      await computeAndStoreStats(db, submissionId, bundle);

      await db.delete(submissions).where(eq(submissions.id, submissionId));

      const cntResult = await db
        .select({ cnt: count() })
        .from(per_file_stats)
        .where(eq(per_file_stats.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(0);
    });
  });

  it('writes total_active_ms and total_idle_ms onto the submission row', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeTwoFileBundle();
      await computeAndStoreStats(db, submissionId, bundle);

      const index = buildIndex(bundle);
      const expected = computeStats(index);

      const [row] = await db
        .select({
          total_active_ms: submissions.total_active_ms,
          total_idle_ms: submissions.total_idle_ms,
        })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      expect(row!.total_active_ms).toBe(expected.totalActiveMs);
      expect(row!.total_idle_ms).toBe(expected.totalIdleMs);
    });
  });

  it('writes times even when the bundle has events but no files', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = makeNoFileBundle();
      await computeAndStoreStats(db, submissionId, bundle);

      const index = buildIndex(bundle);
      const expected = computeStats(index);

      const [row] = await db
        .select({
          total_active_ms: submissions.total_active_ms,
          total_idle_ms: submissions.total_idle_ms,
        })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      expect(row!.total_active_ms).toBe(expected.totalActiveMs);
      expect(row!.total_idle_ms).toBe(expected.totalIdleMs);
      expect(row!.total_active_ms).not.toBeNull();
      expect(row!.total_idle_ms).not.toBeNull();

      const cntResult = await db
        .select({ cnt: count() })
        .from(per_file_stats)
        .where(eq(per_file_stats.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(0);
    });
  });
});
