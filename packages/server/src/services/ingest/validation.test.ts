/**
 * Tests for runAndStoreValidation (PRD §9.3 phase 8, §11.3).
 *
 * Uses buildTestBundle (analyzer test helper) + loadBundle to produce real
 * Bundle values that pass through v2's runValidation unchanged.
 *
 * Strategy: 2–3 tests using synthetic bundles. We do NOT re-test all 8 check
 * outcomes individually — that is v2's job (run-validation.test.ts). Our job
 * is to verify the wrapper:
 *   - Persists v2's output correctly into the DB columns.
 *   - Updates submissions.validation_status.
 *   - Is idempotent (re-run produces exactly one row with the same content).
 *   - CASCADE: deleting the submission removes the row.
 *
 * Bundle characteristics:
 *   - Clean bundle (5 events): checks 1-7 pass, check 8 skipped → overall 'warn'.
 *   - Tampered bundle (broken chain): chain_integrity fails → overall 'fail'.
 */

import { vi, describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { eq, count } from 'drizzle-orm';
import { withTestDb } from '../../../test/helpers/db.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { runAndStoreValidation } from './validation.js';
import { validation_results, submissions } from '../../db/schema.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Wire SHA-512 for @noble/ed25519 (required in non-browser environments).
// Same pattern as run-validation.test.ts in the analyzer package.
// ---------------------------------------------------------------------------
beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

// ---------------------------------------------------------------------------
// Helper: build a parsed Bundle from buildTestBundle options
// ---------------------------------------------------------------------------

async function makeBundle(opts?: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(zipBuffer, 'test.zip');
  if (!result.ok) {
    throw new Error(`loadBundle failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAndStoreValidation', () => {
  it('persists validation_results row and updates submissions.validation_status for a clean bundle', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);

      // Clean bundle: checks 1-7 pass, check 8 skipped → overall 'warn'.
      const bundle = await makeBundle({ sessions: [{ eventCount: 5 }] });
      await runAndStoreValidation(db, submissionId, bundle);

      const rows = await db
        .select()
        .from(validation_results)
        .where(eq(validation_results.submission_id, submissionId));

      expect(rows.length).toBe(1);
      const row = rows[0]!;

      // Check 8 is always 'skipped' in v1 by design; verify it landed in check_8_status.
      expect(row.check_8_status).toBe('skipped');
      // Overall is 'warn' because check 8 is skipped (no fail, ≥1 skipped → warn).
      expect(row.overall).toBe('warn');

      // Checks 1–7 should all pass for a clean bundle.
      expect(row.check_1_status).toBe('pass');
      expect(row.check_2_status).toBe('pass');
      expect(row.check_3_status).toBe('pass');
      expect(row.check_4_status).toBe('pass');
      expect(row.check_5_status).toBe('pass');
      expect(row.check_6_status).toBe('pass');
      expect(row.check_7_status).toBe('pass');

      // detail should be a non-empty array of 8 check objects.
      expect(Array.isArray(row.detail)).toBe(true);
      expect((row.detail as unknown[]).length).toBe(8);

      // submissions.validation_status updated from 'pending' → 'warn'.
      const subRows = await db
        .select({ validation_status: submissions.validation_status })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      expect(subRows[0]!.validation_status).toBe('warn');
    });
  });

  it('persists overall=fail when chain integrity is broken', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);

      // Tampered bundle: break the hash chain on session 0, entry 3.
      const bundle = await makeBundle({
        sessions: [{ eventCount: 5 }],
        tamper: { breakChainAt: { sessionIndex: 0, entryIndex: 3 } },
      });
      await runAndStoreValidation(db, submissionId, bundle);

      const rows = await db
        .select()
        .from(validation_results)
        .where(eq(validation_results.submission_id, submissionId));

      expect(rows.length).toBe(1);
      const row = rows[0]!;

      // overall must be 'fail'.
      expect(row.overall).toBe('fail');

      // submissions.validation_status must be updated to 'fail'.
      const subRows = await db
        .select({ validation_status: submissions.validation_status })
        .from(submissions)
        .where(eq(submissions.id, submissionId));
      expect(subRows[0]!.validation_status).toBe('fail');

      // At least one check must have status 'fail'.
      const statuses = [
        row.check_1_status,
        row.check_2_status,
        row.check_3_status,
        row.check_4_status,
        row.check_5_status,
        row.check_6_status,
        row.check_7_status,
        row.check_8_status,
      ];
      expect(statuses.some((s) => s === 'fail')).toBe(true);
    });
  });

  it('idempotent: running twice produces exactly one row with identical content', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = await makeBundle({ sessions: [{ eventCount: 5 }] });

      await runAndStoreValidation(db, submissionId, bundle);
      await runAndStoreValidation(db, submissionId, bundle);

      const cntResult = await db
        .select({ cnt: count() })
        .from(validation_results)
        .where(eq(validation_results.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(1);

      // Row content should reflect the expected overall from a clean bundle.
      const rows = await db
        .select({ overall: validation_results.overall })
        .from(validation_results)
        .where(eq(validation_results.submission_id, submissionId));
      expect(rows[0]!.overall).toBe('warn');
    });
  });

  it('CASCADE: deleting submission removes validation_results row', async () => {
    await withTestDb(async (db) => {
      const submissionId = await seedSubmission(db);
      const bundle = await makeBundle({ sessions: [{ eventCount: 3 }] });
      await runAndStoreValidation(db, submissionId, bundle);

      await db.delete(submissions).where(eq(submissions.id, submissionId));

      const cntResult = await db
        .select({ cnt: count() })
        .from(validation_results)
        .where(eq(validation_results.submission_id, submissionId));
      expect(cntResult[0]!.cnt).toBe(0);
    });
  });
});
