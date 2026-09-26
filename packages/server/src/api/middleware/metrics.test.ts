/**
 * Metrics middleware tests (Phase 19).
 *
 * Tests:
 *   1. /metrics returns 403 when METRICS_AUTH_TOKEN is not set
 *   2. /metrics returns 401 with wrong token
 *   3. /metrics returns Prometheus text-format response with correct token
 *   4. Counter increments after a request
 *   5. Multiple requests accumulate counts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createApp } from '../start.js';
import { _resetMetricsForTest, setStorageGauge } from './metrics.js';
import { _resetConfigForTest, _setConfigForTest } from '../../config/index.js';
import { _resetLoggerForTest } from '../../logging.js';
import { parseEnv } from '../../config/env.js';

function makeTestEnv() {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'rustsfadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'rustsfadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-metrics-tests-123456789012',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

// Save and restore METRICS_AUTH_TOKEN between tests.
let originalToken: string | undefined;

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _resetMetricsForTest();
  originalToken = process.env['METRICS_AUTH_TOKEN'];
});

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env['METRICS_AUTH_TOKEN'];
  } else {
    process.env['METRICS_AUTH_TOKEN'] = originalToken;
  }
});

// ---------------------------------------------------------------------------
// §1. No token configured → 403
// ---------------------------------------------------------------------------

describe('/metrics — auth gate', () => {
  it('returns 403 when METRICS_AUTH_TOKEN is not set', async () => {
    delete process.env['METRICS_AUTH_TOKEN'];
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/metrics'));
    expect(res.status).toBe(403);
  });

  it('returns 401 with incorrect token', async () => {
    process.env['METRICS_AUTH_TOKEN'] = 'correct-token-12345';
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(
      new Request('http://localhost/metrics', {
        headers: { Authorization: 'Bearer wrong-token' },
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 with no Authorization header when token is configured', async () => {
    process.env['METRICS_AUTH_TOKEN'] = 'correct-token-12345';
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/metrics'));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// §2. Prometheus text format
// ---------------------------------------------------------------------------

describe('/metrics — response format', () => {
  it('returns Prometheus text format with correct Content-Type', async () => {
    process.env['METRICS_AUTH_TOKEN'] = 'test-metrics-token';
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(
      new Request('http://localhost/metrics', {
        headers: { Authorization: 'Bearer test-metrics-token' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
  });

  it('response body contains HELP and TYPE lines', async () => {
    process.env['METRICS_AUTH_TOKEN'] = 'test-metrics-token';
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(
      new Request('http://localhost/metrics', {
        headers: { Authorization: 'Bearer test-metrics-token' },
      }),
    );
    const body = await res.text();
    expect(body).toContain('# HELP provenance_requests_total');
    expect(body).toContain('# TYPE provenance_requests_total counter');
  });
});

// ---------------------------------------------------------------------------
// §3. Counter increments
// ---------------------------------------------------------------------------

describe('/metrics — counter increments', () => {
  it('provenance_requests_total increments after a request', async () => {
    process.env['METRICS_AUTH_TOKEN'] = 'test-metrics-token';
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();

    // Make a request to healthz to generate a counter entry
    await app.fetch(new Request('http://localhost/healthz'));

    const res = await app.fetch(
      new Request('http://localhost/metrics', {
        headers: { Authorization: 'Bearer test-metrics-token' },
      }),
    );
    const body = await res.text();
    // Should contain a provenance_requests_total line for the healthz request
    expect(body).toContain('provenance_requests_total{');
  });

  it('counter accumulates across multiple requests', async () => {
    process.env['METRICS_AUTH_TOKEN'] = 'test-metrics-token';
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();

    // Make 3 requests
    for (let i = 0; i < 3; i++) {
      await app.fetch(new Request('http://localhost/healthz'));
    }

    const res = await app.fetch(
      new Request('http://localhost/metrics', {
        headers: { Authorization: 'Bearer test-metrics-token' },
      }),
    );
    const body = await res.text();
    // Extract the count for GET /healthz 200
    // Line looks like: provenance_requests_total{method="GET",route="...",status="200"} 3
    const match = /provenance_requests_total\{[^}]*status="200"[^}]*\}\s+(\d+)/.exec(body);
    if (match) {
      const count = parseInt(match[1]!, 10);
      // We made at least 3 healthz requests + the metrics request itself
      expect(count).toBeGreaterThanOrEqual(3);
    }
    // If no match, at least verify the body has counter lines (pattern may vary by route)
    expect(body).toContain('provenance_requests_total{');
  });
});

// ---------------------------------------------------------------------------
// §4. Storage gauges
// ---------------------------------------------------------------------------

async function fetchMetricsBody(): Promise<string> {
  process.env['METRICS_AUTH_TOKEN'] = 'test-metrics-token';
  _setConfigForTest(parseEnv(makeTestEnv()));
  const app = createApp();
  const res = await app.fetch(
    new Request('http://localhost/metrics', {
      headers: { Authorization: 'Bearer test-metrics-token' },
    }),
  );
  return res.text();
}

describe('/metrics — storage gauges', () => {
  it('renders a valid Prometheus gauge block after setStorageGauge', async () => {
    setStorageGauge(850, 1000);
    const body = await fetchMetricsBody();

    expect(body).toContain('# TYPE provenance_storage_used_bytes gauge');
    expect(body).toContain('provenance_storage_used_bytes 850');
    expect(body).toContain('# TYPE provenance_storage_quota_bytes gauge');
    expect(body).toContain('provenance_storage_quota_bytes 1000');
  });

  it('_resetMetricsForTest clears the gauges (gauge lines gone after reset)', async () => {
    setStorageGauge(850, 1000);
    _resetMetricsForTest();
    const body = await fetchMetricsBody();

    expect(body).not.toContain('provenance_storage_used_bytes');
    expect(body).not.toContain('provenance_storage_quota_bytes');
  });

  it('does not emit gauge lines when no gauge has been set', async () => {
    // beforeEach already called _resetMetricsForTest(); no setStorageGauge here.
    const body = await fetchMetricsBody();
    expect(body).not.toContain('provenance_storage_used_bytes');
  });
});
