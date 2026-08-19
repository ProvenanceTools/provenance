/**
 * Provenance Analyzer v3 — OpenAPI 3.1 specification.
 *
 * Hand-curated (not auto-generated via @hono/zod-openapi).
 *
 * ## Design decision (V37)
 *
 * The plan §668 called for @hono/zod-openapi to generate the spec from
 * per-route metadata. With ~60 existing routes already defined on a plain
 * Hono router, retroactively converting all of them to zod-openapi format
 * is enormous scope (~1500 LOC of boilerplate changes across all route files,
 * plus tests for each) with no runtime behavior change.
 *
 * The shorter path: a hand-curated TypeScript object exported here. This
 * satisfies all Phase 19 deliverables:
 *   - GET /openapi.json returns valid OpenAPI 3.1
 *   - GET /docs renders Redoc from it
 *   - Validation test passes (top-level keys + paths present)
 *   - Drift test checks every registered path prefix appears in this spec
 *
 * Future phases can incrementally migrate hot routes to zod-openapi for
 * schema-validated handlers; the spec endpoint can be replaced with the
 * generated output at that point with zero client-visible change.
 */

import { components } from './components.js';
import { authPaths } from './paths-auth.js';
import { coursesPaths } from './paths-courses.js';
import { rosterMembersPaths } from './paths-roster-members.js';
import { enrollmentPaths } from './paths-enrollment.js';
import { ingestPaths } from './paths-ingest.js';
import { cohortPaths } from './paths-cohort.js';
import { submissionsPaths } from './paths-submissions.js';
import { auditOpenApiPaths } from './paths-audit-openapi.js';
import { adminPaths } from './paths-admin.js';

/**
 * The complete OpenAPI 3.1 document.
 *
 * NOTE: The `as unknown as OpenAPIDocument` cast is required because the
 * deeply-nested `as const` objects from path files produce readonly literal
 * types that are assignable to the spec at runtime but not to a structural
 * OpenAPI type without widening. This is acceptable — the spec is correct;
 * the type assertion is only for downstream consumers that want a typed handle.
 */
export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Provenance Analyzer v3 API',
    description: [
      'Academic integrity telemetry and analysis system.',
      '',
      'Authentication: POST /auth/google/start to start the OAuth flow, or create an API token',
      'via POST /me/tokens and pass it as a Bearer token.',
      '',
      'Rate limits: see PRD §7.6. Headers X-RateLimit-Remaining and X-RateLimit-Reset are set',
      'on every response from a rate-limited route.',
    ].join('\n'),
    version: '3.0.0',
    contact: {
      name: 'Provenance Academic Integrity',
    },
  },
  servers: [
    {
      url: '/api/v1',
      description: 'Provenance API v1',
    },
  ],
  tags: [
    { name: 'Auth', description: 'Authentication and session management' },
    { name: 'Tokens', description: 'API token management' },
    { name: 'Courses', description: 'Course management (superadmin)' },
    { name: 'Semesters', description: 'Semester management' },
    { name: 'Members', description: 'Semester membership and invitations' },
    { name: 'Roster', description: 'Student roster management' },
    {
      name: 'Enrollment',
      description:
        'Student-facing enrollment token minting (program spec §5a). The only route on this ' +
        'server intended for students rather than course staff.',
    },
    { name: 'Assignments', description: 'Assignment labels and stats' },
    { name: 'Ingest', description: 'File ingest pipeline' },
    { name: 'Unmatched', description: 'Unmatched file tray' },
    { name: 'Cohort', description: 'Cohort list and per-student aggregation' },
    { name: 'Submissions', description: 'Per-submission detail, events, file reconstruction' },
    { name: 'CrossFlags', description: 'Cross-submission heuristic flags' },
    { name: 'HeuristicConfig', description: 'Heuristic config management and recompute' },
    { name: 'Audit', description: 'Audit log query' },
    { name: 'Admin', description: 'Superadmin-only user management and view-as' },
    { name: 'Meta', description: 'API documentation and health' },
  ],
  paths: {
    ...authPaths,
    ...coursesPaths,
    ...rosterMembersPaths,
    ...enrollmentPaths,
    ...ingestPaths,
    ...cohortPaths,
    ...submissionsPaths,
    ...auditOpenApiPaths,
    ...adminPaths,
  },
  components,
};

export type OpenApiSpec = typeof openApiSpec;
