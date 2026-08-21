/**
 * Rate limit middleware tests — Postgres backend.
 *
 * Uses withTestDb and clock injection for deterministic refill behavior.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../../test/helpers/db.js';
import { consumeTokenPg } from './rate-limit-pg.js';
import { _resetConfigForTest, _setConfigForTest } from '../../config/index.js';
import { _resetLoggerForTest } from '../../logging.js';
import { parseEnv } from '../../config/env.js';
import type { BucketConfig } from './rate-limit.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

// ---------------------------------------------------------------------------
// Test env
// ---------------------------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-rate-limit-pg-tests-abcde',
  SESSION_TTL_DAYS: '14',
};

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));
});

// ---------------------------------------------------------------------------
// Config for tests (small bucket for speed)
// ---------------------------------------------------------------------------

const testConfig: BucketConfig = {
  bucketSize: 5,
  refillCount: 5,
  windowMs: 60_000, // 1 minute
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('consumeTokenPg (Postgres backend)', () => {
  it('allows up to bucket size requests then denies', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      for (let i = 0; i < 5; i++) {
        const result = await consumeTokenPg(
          db,
          principalId,
          'test.class',
          testConfig,
          () => fakeNow,
        );
        expect(result.allowed).toBe(true);
      }

      // 6th should be denied
      const denied = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      expect(denied.allowed).toBe(false);
      expect(denied.remaining).toBe(0);
    });
  });

  it('denied result includes retryAfterSeconds', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      // Exhaust
      for (let i = 0; i < 5; i++) {
        await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      }
      const denied = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    });
  });

  it('bucket refills after time passes', async () => {
    await withTestDb(async (db) => {
      let fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      // Exhaust
      for (let i = 0; i < 5; i++) {
        await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      }

      // Advance by full window (1 minute = full refill)
      fakeNow += 60_000;

      const result = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      expect(result.allowed).toBe(true);
    });
  });

  it('different principals do not share buckets', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId1 = `user:${crypto.randomUUID()}`;
      const principalId2 = `user:${crypto.randomUUID()}`;

      // Exhaust principal 1
      for (let i = 0; i < 5; i++) {
        await consumeTokenPg(db, principalId1, 'test.class', testConfig, () => fakeNow);
      }
      const denied = await consumeTokenPg(
        db,
        principalId1,
        'test.class',
        testConfig,
        () => fakeNow,
      );
      expect(denied.allowed).toBe(false);

      // Principal 2 should have its own full bucket
      const allowed = await consumeTokenPg(
        db,
        principalId2,
        'test.class',
        testConfig,
        () => fakeNow,
      );
      expect(allowed.allowed).toBe(true);
    });
  });

  it('concurrent requests do not double-spend (atomic upsert)', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      // Send 6 concurrent requests against a 5-token bucket.
      // At most 5 should be allowed; at least 1 must be denied.
      const results = await Promise.all(
        Array.from({ length: 6 }).map(() =>
          consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow),
        ),
      );

      const allowedCount = results.filter((r) => r.allowed).length;
      const deniedCount = results.filter((r) => !r.allowed).length;

      // Due to atomic upsert, total consumed ≤ bucketSize
      expect(allowedCount).toBeLessThanOrEqual(5);
      expect(deniedCount).toBeGreaterThanOrEqual(1);
      expect(allowedCount + deniedCount).toBe(6);
    });
  });

  it('returns resetAt as future unix timestamp', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      const result = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
      expect(result.resetAt).toBeGreaterThan(Math.floor(fakeNow / 1000));
    });
  });

  // -------------------------------------------------------------------------
  // Important 3: post-deny token value matches in-memory backend semantics
  //
  // After a deny, Postgres must store the actual refilled amount (not 0),
  // so that both backends have identical post-deny state. This makes the
  // next-token-available time consistent regardless of which backend is used.
  // -------------------------------------------------------------------------

  it('post-deny bucket stores refilled value (not zero), symmetric with in-memory backend', async () => {
    await withTestDb(async (db) => {
      // Use a fixed epoch for reproducibility.
      let fakeNow = 1_000_000_000_000; // ms (year 2001 – avoids Date.now() drift)
      const principalId = `user:${crypto.randomUUID()}`;

      // Strategy: exhaust the bucket, advance by a small amount (less than one
      // full token refill period), trigger a deny, then advance by a further
      // small amount that is enough to get to ≥1 token when accumulated on top
      // of the partial refill from the deny — but NOT enough if starting from 0.
      //
      // testConfig: bucketSize=5, refillCount=5, windowMs=60_000.
      // One token refills every 12 seconds (60s / 5 tokens).
      //
      // Step 1: exhaust the bucket.
      for (let i = 0; i < 5; i++) {
        const r = await consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow);
        expect(r.allowed).toBe(true);
      }
      // Row now: tokens=0, last_refill_at=T0.

      // Step 2: advance 5 seconds → 0.4167 tokens refilled (< 1 → deny).
      fakeNow += 5_000;
      const deniedResult = await consumeTokenPg(
        db,
        principalId,
        'test.class',
        testConfig,
        () => fakeNow,
      );
      expect(deniedResult.allowed).toBe(false);
      expect(deniedResult.remaining).toBe(0); // floor of 0.4167
      // Row now (with the fix): tokens=0.4167, last_refill_at=T0+5s.
      // Row (without fix, old bug): tokens=0, last_refill_at=T0+5s.

      // Step 3: advance another 10 seconds (total 15s from T0, but 10s from deny).
      // - With fix: 0.4167 + 10s * (5/60000ms) = 0.4167 + 0.8333 = 1.25 ≥ 1 → ALLOW.
      // - Without fix: 0 + 10s * (5/60000ms) = 0.8333 < 1 → DENY.
      fakeNow += 10_000;
      const allowedResult = await consumeTokenPg(
        db,
        principalId,
        'test.class',
        testConfig,
        () => fakeNow,
      );
      // With the fix, the post-deny value accumulated correctly → allowed.
      // Without the fix, 10s from a 0 baseline gives 0.833 tokens → still denied.
      expect(allowedResult.allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Important 4: concurrent first requests for new principal do not double-spend
  //
  // The pre-seed INSERT prevents the FOR UPDATE no-op when the row doesn't exist.
  // Both concurrent first-requests should serialize, not both see an empty bucket.
  // -------------------------------------------------------------------------

  it('concurrent first requests for new principal do not double-spend', async () => {
    await withTestDb(async (db) => {
      const fakeNow = Date.now();
      const principalId = `user:${crypto.randomUUID()}`;

      // Fire N concurrent requests against a fresh principal (no existing row).
      // With a 5-token bucket and 6 requests, exactly 5 should be allowed (not 6).
      const N = 6;
      const results = await Promise.all(
        Array.from({ length: N }).map(() =>
          consumeTokenPg(db, principalId, 'test.class', testConfig, () => fakeNow),
        ),
      );

      const allowedCount = results.filter((r) => r.allowed).length;
      const deniedCount = results.filter((r) => !r.allowed).length;

      // Without the pre-seed fix, at most 6 might be "allowed" due to the race.
      // With the fix, exactly bucketSize (5) are allowed.
      expect(allowedCount).toBe(testConfig.bucketSize); // exactly 5, not 5 or 6
      expect(deniedCount).toBe(N - testConfig.bucketSize); // exactly 1
    });
  });
});
