/**
 * Tests for reconstructBundleFromDb.
 *
 * Events are no longer persisted in Postgres — reconstructBundleFromDb now loads
 * the real Bundle + EventIndex from the stored bundle blob (via
 * loadSubmissionIndex) and the ValidationReport from the validation_results row.
 *
 * Verifies:
 *   1. Happy path: the stored blob is parsed into a Bundle + EventIndex with the
 *      expected sessions / event count.
 *   2. ValidationReport reflects the persisted validation_results row.
 *   3. Missing validation row → falls back to all-skipped ValidationReport.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../test/helpers/db.js';
import { withTestRustfs } from '../../../test/helpers/rustfs.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { putSubmissionBundle } from '../../../test/helpers/seed-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { reconstructBundleFromDb } from './reconstruct-bundle.js';
import { _resetBundleIndexCacheForTest } from '../bundle/load-index.js';
import { validation_results } from '../../db/schema.js';

beforeEach(() => {
  _resetBundleIndexCacheForTest();
});

describe('reconstructBundleFromDb', () => {
  it('loads the Bundle + EventIndex from the stored blob', async () => {
    await withTestRustfs(async ({ client }) => {
      await withTestDb(async (db) => {
        const submissionId = await seedSubmission(db);
        const sessionId = crypto.randomUUID();
        const { zipBuffer } = await buildTestBundle({
          sessions: [{ sessionId, eventCount: 5 }],
        });
        await putSubmissionBundle(db, client, submissionId, new Uint8Array(zipBuffer));

        const { bundle, index } = await reconstructBundleFromDb(db, client, submissionId);

        expect(bundle.sessions).toHaveLength(1);
        expect(bundle.sessions[0]!.sessionId).toBe(sessionId);
        // session.start + 5 events.
        expect(bundle.sessions[0]!.events).toHaveLength(6);
        expect(index.bySeq.size).toBe(6);
      });
    });
  });

  it('handles multiple sessions', async () => {
    await withTestRustfs(async ({ client }) => {
      await withTestDb(async (db) => {
        const submissionId = await seedSubmission(db);
        const { zipBuffer } = await buildTestBundle({
          sessions: [{ eventCount: 2 }, { eventCount: 3 }],
        });
        await putSubmissionBundle(db, client, submissionId, new Uint8Array(zipBuffer));

        const { bundle, index } = await reconstructBundleFromDb(db, client, submissionId);

        expect(bundle.sessions).toHaveLength(2);
        // (session.start + 2) + (session.start + 3) = 3 + 4 = 7
        expect(index.bySeq.size).toBe(7);
      });
    });
  });

  it('reconstructs the ValidationReport from the persisted validation_results row', async () => {
    await withTestRustfs(async ({ client }) => {
      await withTestDb(async (db) => {
        const submissionId = await seedSubmission(db);
        const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
        await putSubmissionBundle(db, client, submissionId, new Uint8Array(zipBuffer));

        await db.insert(validation_results).values({
          submission_id: submissionId,
          check_1_status: 'pass',
          check_2_status: 'pass',
          check_3_status: 'pass',
          check_4_status: 'pass',
          check_5_status: 'pass',
          check_6_status: 'pass',
          check_7_status: 'pass',
          check_8_status: 'skipped',
          overall: 'pass',
          // Empty detail → reconstructValidationReport rebuilds from the
          // individual check_N_status columns.
          detail: [],
        });

        const { validationReport } = await reconstructBundleFromDb(db, client, submissionId);

        expect(validationReport.overall).toBe('pass');
        expect(validationReport.checks).toHaveLength(8);
        expect(validationReport.checks[0]!.status).toBe('pass');
        expect(validationReport.checks[7]!.status).toBe('skipped');
      });
    });
  });

  it('falls back to an all-skipped ValidationReport when no row exists', async () => {
    await withTestRustfs(async ({ client }) => {
      await withTestDb(async (db) => {
        const submissionId = await seedSubmission(db);
        const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
        await putSubmissionBundle(db, client, submissionId, new Uint8Array(zipBuffer));

        const { validationReport } = await reconstructBundleFromDb(db, client, submissionId);

        expect(validationReport.checks).toHaveLength(8);
        expect(validationReport.checks.every((c) => c.status === 'skipped')).toBe(true);
      });
    });
  });
});
