/**
 * OpenAPI spec validation + drift tests (Phase 19 / P1-5).
 *
 * Test groups:
 *   1. Spec structure — valid OpenAPI 3.1 top-level shape
 *   2. Coverage — all PRD §8 routes are present in the spec (path-level prefix check)
 *   3. GET /openapi.json — returns valid JSON spec via HTTP
 *   4. GET /docs — returns HTML with Redoc script tag
 *   5. Schema-level drift — every route registered in createV1App() has a matching
 *      path + method in the spec (exhaustive, not prefix-based)
 *   6. 2xx response schema quality — every 2xx with a body has at least one $ref
 *      pointing to a named component (no fully-inline success shapes)
 *   7. Fake-route probe — confirms the §5 drift check actually catches a missing path
 *
 * TODO(P1-5 follow-up): enforce that the top-level 2xx response schema IS a $ref
 * (not merely contains one). Currently most responses wrap their $ref in an inline
 * `{ type: 'object', properties: { items: [...] } }` envelope. Enforcing the strict
 * form would require rewriting most of paths-*.ts and is deferred.
 *
 * TODO(P1-5 follow-up): implement check (3) — security/auth shape on each route
 * matches the spec's `security` declaration. Blocked on a reliable way to detect
 * whether a Hono route handler chain includes requireAuth() without running the
 * handler. Deferred; add to backlog as P2-X.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { openApiSpec } from './spec/index.js';
import { createApp } from '../api/start.js';
import { createV1App } from '../api/v1/index.js';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';

function makeTestEnv() {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'rustfsadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'rustfsadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-openapi-tests-1234567890123',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
  };
}

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
});

// ---------------------------------------------------------------------------
// §1. Spec structure
// ---------------------------------------------------------------------------

describe('OpenAPI spec structure', () => {
  it('has top-level openapi version 3.1.x', () => {
    expect(openApiSpec.openapi).toMatch(/^3\.1\./);
  });

  it('has info with title and version', () => {
    expect(typeof openApiSpec.info.title).toBe('string');
    expect(openApiSpec.info.title.length).toBeGreaterThan(0);
    expect(typeof openApiSpec.info.version).toBe('string');
  });

  it('has a non-empty paths object', () => {
    expect(typeof openApiSpec.paths).toBe('object');
    expect(Object.keys(openApiSpec.paths).length).toBeGreaterThan(10);
  });

  it('has components.schemas with at least 10 shared types', () => {
    expect(typeof openApiSpec.components.schemas).toBe('object');
    expect(Object.keys(openApiSpec.components.schemas).length).toBeGreaterThanOrEqual(10);
  });

  it('has securitySchemes with BearerAuth', () => {
    expect(openApiSpec.components.securitySchemes).toBeDefined();
    const schemes = openApiSpec.components.securitySchemes as Record<string, unknown>;
    expect(schemes).toHaveProperty('BearerAuth');
  });

  it('every path entry has at least one HTTP method with a responses field', () => {
    for (const [path, pathItem] of Object.entries(openApiSpec.paths)) {
      const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
      const hasMethod = methods.some((m) => m in pathItem);
      expect(hasMethod, `Path ${path} has no HTTP method`).toBe(true);

      for (const method of methods) {
        if (method in pathItem) {
          const op = (pathItem as Record<string, unknown>)[method] as Record<string, unknown>;
          expect(op['responses'], `${method.toUpperCase()} ${path} has no responses`).toBeDefined();
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §2. Coverage — key PRD §8 routes must appear in spec paths
// ---------------------------------------------------------------------------

describe('PRD §8 route coverage', () => {
  /**
   * These are the canonical path prefixes from each PRD §8 section.
   * We check that at least one spec path starts with each prefix.
   *
   * We do NOT check every possible path — that would be fragile.
   * Instead we verify each PRD section has coverage.
   */
  const REQUIRED_PATH_PREFIXES: Array<[string, string]> = [
    // §8.1 Auth
    ['/auth/google/start', 'Auth start (§8.1)'],
    ['/auth/google/callback', 'Auth callback (§8.1)'],
    ['/auth/logout', 'Logout (§8.1)'],
    ['/me', 'Me endpoint (§8.1)'],
    ['/me/tokens', 'Token management (§8.1, §8.12)'],
    // §8.2 Courses
    ['/courses', 'Courses (§8.2)'],
    ['/semesters/{semesterId}', 'Semesters (§8.2)'],
    // §8.3 Members
    ['/semesters/{semesterId}/members', 'Members (§8.3)'],
    // §8.4 Roster
    ['/semesters/{semesterId}/roster', 'Roster (§8.4)'],
    // §8.5 Assignments
    ['/semesters/{semesterId}/assignments', 'Assignments (§8.5)'],
    // §8.6 Ingest
    ['/semesters/{semesterId}/ingest', 'Ingest (§8.6)'],
    // §8.7 Unmatched
    ['/semesters/{semesterId}/unmatched', 'Unmatched (§8.7)'],
    // §8.8 Cohort
    ['/semesters/{semesterId}/submissions', 'Cohort submissions (§8.8)'],
    // §8.9 Per-submission
    ['/submissions/{submissionId}', 'Per-submission (§8.9)'],
    ['/submissions/{submissionId}/events', 'Events (§8.9)'],
    ['/submissions/{submissionId}/bundle', 'Bundle (§8.9)'],
    // §8.10 Cross-flags
    ['/semesters/{semesterId}/cross-flags', 'Cross-flags list (§8.10)'],
    ['/cross-flags/{crossFlagId}', 'Cross-flag detail (§8.10)'],
    // §8.11 Heuristic config
    ['/semesters/{semesterId}/heuristic-config', 'Heuristic config (§8.11)'],
    // §8.13 Audit
    ['/audit', 'Audit (§8.13)'],
    // §8.14 OpenAPI
    ['/openapi.json', 'OpenAPI spec (§8.14)'],
    ['/docs', 'Redoc docs (§8.14)'],
  ];

  const specPaths = Object.keys(openApiSpec.paths);

  for (const [prefix, label] of REQUIRED_PATH_PREFIXES) {
    it(`has coverage for ${label}`, () => {
      const covered = specPaths.some((p) => p === prefix || p.startsWith(prefix));
      expect(covered, `No spec path matches prefix "${prefix}" (${label})`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// §3. GET /api/v1/openapi.json
// ---------------------------------------------------------------------------

describe('GET /api/v1/openapi.json', () => {
  it('returns 200 with valid JSON and correct Content-Type', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/openapi.json'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('application/json');

    const body = (await res.json()) as Record<string, unknown>;
    expect(body['openapi']).toMatch(/^3\.1\./);
    expect(typeof body['paths']).toBe('object');
  });

  it('returns Cache-Control: public, max-age=3600', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/openapi.json'));

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('does not require auth (public endpoint)', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/openapi.json'));
    // No Authorization header — must still return 200
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// §4. GET /api/v1/docs
// ---------------------------------------------------------------------------

describe('GET /api/v1/docs', () => {
  it('returns 200 with HTML content type', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/docs'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
  });

  it('contains Redoc script tag', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/docs'));

    const html = await res.text();
    expect(html).toContain('redoc.standalone.js');
  });

  it('contains spec-url pointing to openapi.json', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/docs'));

    const html = await res.text();
    expect(html).toContain('/api/v1/openapi.json');
  });

  it('does not require auth (public endpoint)', async () => {
    _setConfigForTest(parseEnv(makeTestEnv()));
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/v1/docs'));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Drift helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Hono-style path (/semesters/:semesterId/assignments/:assignmentId)
 * to an OpenAPI-style path (/semesters/{semesterId}/assignments/{assignmentId}).
 *
 * Special cases handled:
 *   /:param{.+}  — wildcard path params (e.g. /:path{.+}) → {param} (strip the {.+} regex)
 *   /:action  where action is not a real param but an action suffix (roster:upload)
 *             — Hono parses "roster:upload" as { path: 'roster/:upload', params: {upload} }
 *             — but the spec registers the route as '/semesters/.../roster:upload'
 *             — We keep the segment as-is when it is a known action suffix.
 */
function honoPathToOpenApi(honoPath: string): string {
  // First: strip Hono regex constraints from params (e.g. :path{.+} → :path)
  const cleaned = honoPath.replace(/:([A-Za-z_][A-Za-z0-9_]*)\{[^}]*\}/g, ':$1');
  // Second: replace :param with {param}
  return cleaned.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');
}

/**
 * Known path equivalences: routes where the Hono path param name differs
 * from the OpenAPI path param name (pre-existing naming inconsistencies in
 * the codebase that we normalise here rather than breaking the route/spec).
 *
 * Key: OpenAPI path after honoPathToOpenApi conversion
 * Value: canonical OpenAPI path as declared in the spec
 */
const PATH_EQUIVALENCES: Record<string, string> = {
  // me-tokens router uses /:id but spec uses /{tokenId}
  '/me/tokens/{id}': '/me/tokens/{tokenId}',
  // roster action routes: Hono sees ":upload"/":commit" as params; spec uses colon-action syntax
  '/semesters/{semesterId}/roster{upload}': '/semesters/{semesterId}/roster:upload',
  '/semesters/{semesterId}/roster{commit}': '/semesters/{semesterId}/roster:commit',
  // ingest:gradescope is likewise a colon-action route, not a path param.
  '/semesters/{semesterId}/ingest{gradescope}': '/semesters/{semesterId}/ingest:gradescope',
  // submissions summary: route is /summary but spec uses bare /submissions/{id}
  '/submissions/{submissionId}/summary': '/submissions/{submissionId}',
  // files content/provenance: after stripping {.+} regex, path ends up without the .+
  '/submissions/{submissionId}/files/{path}/content':
    '/submissions/{submissionId}/files/{path}/content',
  '/submissions/{submissionId}/files/{path}/provenance':
    '/submissions/{submissionId}/files/{path}/provenance',
};

/**
 * Paths (OpenAPI style) that are intentionally excluded from exhaustive drift
 * checking because they are infrastructure/public routes with no meaningful
 * request/response schema contract to enforce.
 */
const EXCLUDED_PATHS = new Set([
  '/openapi.json',
  '/docs',
  // fs-backend presigned download target: the on-server stand-in for the S3
  // presigned-URL target (absent from our server in s3 mode), not documented
  // API surface. Clients follow it opaquely from bundle.download's signedUrl.
  '/blob',
]);

/**
 * Extract all non-middleware (non-ALL) routes from a Hono app.
 * Returns deduplicated { method, openApiPath } pairs after normalisation.
 */
function extractRoutes(app: Hono): Array<{ method: string; openApiPath: string }> {
  const seen = new Set<string>();
  const result: Array<{ method: string; openApiPath: string }> = [];

  for (const route of app.routes) {
    if (route.method === 'ALL') continue; // middleware, not a route handler

    const rawOpenApiPath = honoPathToOpenApi(route.path);
    // Apply known equivalences (param name mismatches, action-param patterns, etc.)
    const openApiPath = PATH_EQUIVALENCES[rawOpenApiPath] ?? rawOpenApiPath;

    const key = `${route.method.toLowerCase()} ${openApiPath}`;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({ method: route.method.toLowerCase(), openApiPath });
  }

  return result;
}

/**
 * Recursively check if a schema object contains at least one $ref.
 * Used for the lenient 2xx-has-$ref check.
 */
function schemaHasRef(schema: unknown): boolean {
  if (typeof schema !== 'object' || schema === null) return false;
  const obj = schema as Record<string, unknown>;
  if ('$ref' in obj) return true;
  for (const val of Object.values(obj)) {
    if (schemaHasRef(val)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// §5. Schema-level drift — every route in createV1App() is in the spec
// ---------------------------------------------------------------------------

describe('Schema-level drift: every registered route has a spec entry (P1-5 check 1)', () => {
  const app = createV1App();
  const routes = extractRoutes(app).filter((r) => !EXCLUDED_PATHS.has(r.openApiPath));
  const specPaths = openApiSpec.paths as Record<string, Record<string, unknown>>;

  for (const { method, openApiPath } of routes) {
    it(`${method.toUpperCase()} ${openApiPath} exists in spec`, () => {
      const pathItem = specPaths[openApiPath];
      expect(
        pathItem,
        `No spec entry for path "${openApiPath}" — add it to an appropriate paths-*.ts file`,
      ).toBeDefined();
      if (!pathItem) return; // narrow for TS

      expect(
        pathItem[method],
        `Spec path "${openApiPath}" is missing method "${method.toUpperCase()}"`,
      ).toBeDefined();
    });
  }
});

// ---------------------------------------------------------------------------
// §6. 2xx response schema quality — success bodies reference named components
// ---------------------------------------------------------------------------

describe('2xx response schema quality: success bodies use $ref (P1-5 check 2)', () => {
  const specPaths = openApiSpec.paths as Record<
    string,
    Record<
      string,
      {
        responses?: Record<
          string,
          { content?: Record<string, { schema?: unknown }>; description?: string }
        >;
      }
    >
  >;

  const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

  for (const [path, pathItem] of Object.entries(specPaths)) {
    if (EXCLUDED_PATHS.has(path)) continue;

    for (const method of HTTP_METHODS) {
      if (!(method in pathItem)) continue;
      const op = pathItem[method];
      if (!op?.responses) continue;

      for (const [statusCode, response] of Object.entries(op.responses)) {
        const code = parseInt(statusCode, 10);
        if (code < 200 || code >= 300) continue; // only 2xx
        if (!response.content) continue; // 204 No Content is fine

        for (const [contentType, mediaType] of Object.entries(response.content)) {
          if (!contentType.includes('json')) continue; // only check JSON bodies
          if (!mediaType.schema) continue;

          it(`${method.toUpperCase()} ${path} → ${statusCode} JSON schema references a named component`, () => {
            expect(
              schemaHasRef(mediaType.schema),
              [
                `${method.toUpperCase()} ${path} → ${statusCode}: success body schema has no $ref`,
                `to a named component. Either add a named component in components.ts or`,
                `promote the inline schema to a named type.`,
              ].join(' '),
            ).toBe(true);
          });
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// §7. Fake-route probe — confirms §5 drift check catches a missing path
// ---------------------------------------------------------------------------

describe('Fake-route probe: drift check catches a route missing from the spec', () => {
  it('detects a synthetic route not present in the spec', () => {
    // Build a minimal Hono app with one route that is definitely not in the spec.
    const fakeApp = new Hono();
    fakeApp.get('/nonexistent-fake-route-for-drift-probe', (c) => c.json({ ok: true }));

    const routes = extractRoutes(fakeApp);
    const specPaths = openApiSpec.paths as Record<string, Record<string, unknown>>;

    const missingRoutes = routes.filter((r) => {
      const pathItem = specPaths[r.openApiPath];
      return !pathItem || !(r.method in pathItem);
    });

    // The fake route must appear as missing.
    expect(missingRoutes.length).toBeGreaterThan(0);
    expect(
      missingRoutes.some((r) => r.openApiPath === '/nonexistent-fake-route-for-drift-probe'),
    ).toBe(true);
  });
});
