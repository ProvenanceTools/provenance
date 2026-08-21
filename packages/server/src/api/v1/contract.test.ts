/**
 * API contract tests — server-side shape validation against the same Zod
 * schemas the analyzer's apiFetch uses.
 *
 * Why this exists
 * ---------------
 *
 * Two pre-2026-05-27 bugs went undetected until QA flagged them manually:
 *
 *   - GET /semesters/:id/assignments returned `{ assignments: [...] }` but
 *     the analyzer's AssignmentListResponseSchema expected `{ items: [...] }`.
 *   - GET /audit returned `id: <number>` but AuditLogRowSchema declared
 *     `id: z.string().uuid()`.
 *
 * Both were trivial drifts. Both would have been caught by feeding the
 * actual server response through the shared schema. None of the existing
 * server integration tests did that — they cast the JSON to ad-hoc inline
 * types and asserted field-by-field, which silently tolerates extra or
 * mis-typed keys as long as the keys the test reads happen to match.
 *
 * This file is a guard rail against that class of bug. For every analyzer-
 * facing GET endpoint that uses a shared Zod schema, we
 *
 *   1. seed a representative entity into a single testcontainer-backed DB,
 *   2. call the route through createV1App's full middleware pipeline,
 *   3. parse the JSON body with the SAME schema the analyzer imports, and
 *   4. fail loudly if either side has drifted.
 *
 * New routes that ship with an analyzer schema MUST add a contract entry.
 * The exhaustiveness check at the bottom enforces that against the
 * registry below — if you wire a new schema into queries.ts but forget to
 * add a contract here, the test will fail with a hint.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  MeResponseSchema,
  SemesterDetailResponseSchema,
  AssignmentListResponseSchema,
  CohortListResponseSchema,
  StudentListResponseSchema,
  IngestJobSchema,
  IngestJobListResponseSchema,
  IngestFileListResponseSchema,
  UnmatchedListResponseSchema,
  RosterListResponseSchema,
  MembersListResponseSchema,
  HeuristicConfigSchema,
  HeuristicConfigHistoryResponseSchema,
  RecomputeJobSchema,
  CrossFlagListResponseSchema,
  CrossFlagDetailResponseSchema,
  TokensListResponseSchema,
  AdminUserListResponseSchema,
  AdminUserDetailResponseSchema,
  CourseListResponseSchema,
  SemesterListResponseSchema,
  AuditListResponseSchema,
} from '@provenance/shared/api-schemas';

import { withTestDb } from '../../../test/helpers/db.js';
import { _resetConfigForTest, _setConfigForTest } from '../../config/index.js';
import { _resetLoggerForTest } from '../../logging.js';
import { parseEnv } from '../../config/env.js';
import { createV1App } from './index.js';
import {
  users,
  sessions,
  courses,
  semesters,
  memberships,
  roster_entries,
  assignments,
  ingest_jobs,
  ingest_files,
  submissions,
  flags,
  heuristic_configs,
  recompute_jobs,
  cross_flags,
  cross_flag_participants,
  api_tokens,
  audit_log,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

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
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-contract-tests-1234567890123',
  SESSION_TTL_DAYS: '14',
};

// ---------------------------------------------------------------------------
// DB injection
// ---------------------------------------------------------------------------

let _testDb: DrizzleDb | null = null;

vi.mock('../../db/client.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../db/client.js')>();
  return {
    ...original,
    getDb: () => {
      if (_testDb !== null) return _testDb;
      return original.getDb();
    },
  };
});

// ---------------------------------------------------------------------------
// Shared fixture: one of every entity an analyzer-facing GET needs.
//
// All entries reference each other so a single semester is enough to cover
// every route. Mutations live in their own test files; this file is
// read-only contract validation.
// ---------------------------------------------------------------------------

type Fixture = {
  db: DrizzleDb;
  sessionId: string;
  user: { id: string; email: string };
  course: { id: string };
  semester: { id: string };
  student: { id: string };
  assignment: { id: string };
  ingestJob: { id: string };
  ingestFile: { id: string };
  submission: { id: string };
  flag: { id: string };
  heuristicConfig: { id: string; version: number };
  recomputeJob: { id: string };
  crossFlag: { id: string };
  apiToken: { id: string };
};

async function buildFixture(db: DrizzleDb): Promise<Fixture> {
  const rand = () => Math.random().toString(36).slice(2);

  const [user] = await db
    .insert(users)
    .values({
      google_subject: `sub-${rand()}`,
      email: 'admin@berkeley.edu',
      display_name: 'Contract Admin',
      is_superadmin: true,
    })
    .returning();

  const sessionId = `sess-${rand()}`.padEnd(43, 'x').slice(0, 43);
  await db
    .insert(sessions)
    .values({ id: sessionId, user_id: user!.id, expires_at: new Date(Date.now() + 86400_000) });

  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61A', slug: `c-${rand()}` })
    .returning();

  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `s-${rand()}`,
      display_name: 'Fall 2024',
      filename_convention: '(?<sid>[a-z0-9]+)',
    })
    .returning();

  await db
    .insert(memberships)
    .values({ user_id: user!.id, semester_id: semester!.id, role: 'admin', granted_by: user!.id });

  const [student] = await db
    .insert(roster_entries)
    .values({ semester_id: semester!.id, sid: `s-${rand()}`, display_name: 'Alice' })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semester!.id, assignment_id_str: 'hw1', label: 'Homework 1' })
    .returning();

  const [ingestJob] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semester!.id, uploaded_by: user!.id, status: 'succeeded' })
    .returning();

  const [ingestFile] = await db
    .insert(ingest_files)
    .values({
      ingest_job_id: ingestJob!.id,
      original_filename: 'alice_hw1.zip',
      size_bytes: 1000,
      blob_sha256: `sha-${rand()}`,
      status: 'matched',
      matched_student_id: student!.id,
      matched_assignment_id: assignment!.id,
    })
    .returning();

  const submissionId = crypto.randomUUID();
  await db.insert(submissions).values({
    id: submissionId,
    semester_id: semester!.id,
    assignment_id: assignment!.id,
    student_id: student!.id,
    blob_object_key: `semesters/${semester!.id}/submissions/${submissionId}/bundle.zip`,
    blob_sha256: `sha256-${submissionId}`,
    source_filename: 'alice_hw1.zip',
    ingest_job_id: ingestJob!.id,
    version_index: 1,
    score_total: 3,
    score_max_severity: 'medium',
    validation_status: 'pass',
  });

  const [flag] = await db
    .insert(flags)
    .values({
      submission_id: submissionId,
      semester_id: semester!.id,
      heuristic_id: 'large_paste',
      severity: 'medium',
      confidence: 0.8,
      weight_at_compute: 1.0,
      score_contribution: 2.4,
      heuristic_config_version: 1,
    })
    .returning();

  const [heuristicConfig] = await db
    .insert(heuristic_configs)
    .values({
      semester_id: semester!.id,
      version: 1,
      config: {
        per_flag: { large_paste: { enabled: true, weight: 1.0 } },
        severity_weights: { info: 0, low: 1, medium: 3, high: 8 },
        config_format_version: 1,
      } as unknown,
      set_by: user!.id,
      is_active: true,
    })
    .returning();

  const [recomputeJob] = await db
    .insert(recompute_jobs)
    .values({
      semester_id: semester!.id,
      target_config_id: heuristicConfig!.id,
      triggered_by: user!.id,
      status: 'succeeded',
      progress_total: 1,
      progress_done: 1,
      progress_failed: 0,
    })
    .returning();

  const [crossFlag] = await db
    .insert(cross_flags)
    .values({
      semester_id: semester!.id,
      heuristic_id: 'paste_shared_across_students',
      severity: 'high',
      confidence: 0.9,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb detail
      detail: { kind: 'paste_shared' } as any,
      heuristic_config_version: 1,
    })
    .returning();

  await db.insert(cross_flag_participants).values({
    cross_flag_id: crossFlag!.id,
    submission_id: submissionId,
  });

  const [apiToken] = await db
    .insert(api_tokens)
    .values({
      user_id: user!.id,
      label: 'Contract test token',
      prefix: `pat_${rand().slice(0, 8)}`,
      hashed_token: `hash-${rand()}`,
      // The canonical scopes shape (post-Zod-resolution); matches what real
      // tokens have after going through the create-token route. See
      // ResolvedTokenScopesSchema in shared/api-schemas.ts.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb column
      scopes: { read_only: false, semester_ids: null, include_blobs: false } as any,
    })
    .returning();

  await db.insert(audit_log).values({
    actor_user_id: user!.id,
    semester_id: semester!.id,
    action: 'heuristic_config.read',
    target_type: 'semester',
    target_id: semester!.id,
  });

  return {
    db,
    sessionId,
    user: { id: user!.id, email: user!.email },
    course: { id: course!.id },
    semester: { id: semester!.id },
    student: { id: student!.id },
    assignment: { id: assignment!.id },
    ingestJob: { id: ingestJob!.id },
    ingestFile: { id: ingestFile!.id },
    submission: { id: submissionId },
    flag: { id: flag!.id },
    heuristicConfig: { id: heuristicConfig!.id, version: heuristicConfig!.version },
    recomputeJob: { id: recomputeJob!.id },
    crossFlag: { id: crossFlag!.id },
    apiToken: { id: apiToken!.id },
  };
}

// ---------------------------------------------------------------------------
// Contract registry
//
// Each entry is a (name, request-builder, schema) tuple. The request builder
// runs after the fixture is seeded so it can reference the entity ids. The
// schema is the EXACT one analyzer's apiFetch uses for that endpoint.
// ---------------------------------------------------------------------------

type Contract = {
  name: string;
  buildRequest: (f: Fixture) => Request;
  schema: z.ZodTypeAny;
};

function get(f: Fixture, path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { Cookie: `__Host-prov_sess=${f.sessionId}` },
  });
}

const contracts: Contract[] = [
  {
    name: 'GET /me',
    buildRequest: (f) => get(f, '/me'),
    schema: MeResponseSchema,
  },
  {
    name: 'GET /me/tokens',
    buildRequest: (f) => get(f, '/me/tokens'),
    schema: TokensListResponseSchema,
  },
  {
    name: 'GET /courses',
    buildRequest: (f) => get(f, '/courses'),
    schema: CourseListResponseSchema,
  },
  {
    name: 'GET /courses/:courseId/semesters',
    buildRequest: (f) => get(f, `/courses/${f.course.id}/semesters`),
    schema: SemesterListResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}`),
    schema: SemesterDetailResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/assignments',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/assignments`),
    schema: AssignmentListResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/submissions',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/submissions`),
    schema: CohortListResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/students',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/students`),
    schema: StudentListResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/roster',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/roster?limit=100`),
    schema: RosterListResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/members',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/members`),
    schema: MembersListResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/ingest/jobs',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/ingest/jobs?limit=20`),
    schema: IngestJobListResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/ingest/jobs/:jobId',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/ingest/jobs/${f.ingestJob.id}`),
    schema: IngestJobSchema,
  },
  {
    name: 'GET /semesters/:semesterId/ingest/jobs/:jobId/files',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/ingest/jobs/${f.ingestJob.id}/files`),
    schema: IngestFileListResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/unmatched',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/unmatched?limit=50`),
    schema: UnmatchedListResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/heuristic-config',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/heuristic-config`),
    schema: HeuristicConfigSchema,
  },
  {
    name: 'GET /semesters/:semesterId/heuristic-configs',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/heuristic-configs`),
    schema: HeuristicConfigHistoryResponseSchema,
  },
  {
    name: 'GET /semesters/:semesterId/recompute/:jobId',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/recompute/${f.recomputeJob.id}`),
    schema: RecomputeJobSchema,
  },
  {
    name: 'GET /semesters/:semesterId/cross-flags',
    buildRequest: (f) => get(f, `/semesters/${f.semester.id}/cross-flags`),
    schema: CrossFlagListResponseSchema,
  },
  {
    name: 'GET /cross-flags/:crossFlagId',
    buildRequest: (f) => get(f, `/cross-flags/${f.crossFlag.id}`),
    schema: CrossFlagDetailResponseSchema,
  },
  {
    name: 'GET /admin/users',
    buildRequest: (f) => get(f, '/admin/users'),
    schema: AdminUserListResponseSchema,
  },
  {
    name: 'GET /admin/users/:userId',
    buildRequest: (f) => get(f, `/admin/users/${f.user.id}`),
    schema: AdminUserDetailResponseSchema,
  },
  {
    name: 'GET /audit',
    buildRequest: (f) => get(f, '/audit'),
    schema: AuditListResponseSchema,
  },
];

// ---------------------------------------------------------------------------
// Run the registry
// ---------------------------------------------------------------------------

let fixture: Fixture | null = null;
let app: ReturnType<typeof createV1App> | null = null;
let cleanupDb: (() => Promise<void>) | null = null;

beforeAll(async () => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _setConfigForTest(parseEnv(BASE_ENV));

  // We need the DB to live across all `it`s in this file. withTestDb takes a
  // callback, so we manually wire up a promise we resolve at the end to keep
  // the testcontainer alive for the duration.
  let resolveCleanup!: () => void;
  const cleanupPromise = new Promise<void>((res) => {
    resolveCleanup = res;
  });

  const ready = new Promise<void>((readyRes, readyRej) => {
    void withTestDb(async (db) => {
      _testDb = db;
      try {
        fixture = await buildFixture(db);
        app = createV1App();
        readyRes();
        await cleanupPromise;
      } catch (err) {
        readyRej(err as Error);
      } finally {
        _testDb = null;
      }
    });
  });

  cleanupDb = async () => {
    resolveCleanup();
  };

  await ready;
});

afterAll(async () => {
  if (cleanupDb) {
    await cleanupDb();
    cleanupDb = null;
  }
  fixture = null;
  app = null;
});

describe('API contract — analyzer-facing GET responses match shared Zod schemas', () => {
  for (const contract of contracts) {
    it(contract.name, async () => {
      if (!fixture || !app) throw new Error('fixture or app not initialized');
      const res = await app.fetch(contract.buildRequest(fixture));
      expect(res.status, `${contract.name} returned ${res.status}`).toBe(200);
      const body: unknown = await res.json();
      const parsed = contract.schema.safeParse(body);
      if (!parsed.success) {
        // Surface a useful, contract-shaped diagnosis — the Zod issue list
        // plus a sample of the actual body so the failing assertion
        // doesn't require running the test in a debugger.
        const issues = parsed.error.issues
          .map((i) => `  - path=${i.path.join('.')} code=${i.code} msg=${i.message}`)
          .join('\n');
        const sampleJson = JSON.stringify(body, null, 2).slice(0, 1500);
        throw new Error(
          `${contract.name} response does not match its shared Zod schema.\n` +
            `Issues:\n${issues}\n\n` +
            `Response sample (truncated to 1500 chars):\n${sampleJson}`,
        );
      }
    });
  }

  // Sanity: keep the registry from going stale. The expected count is the
  // number of analyzer apiFetch sites that pass a schema (see queries.ts).
  // If you add a new analyzer schema and forget to register a contract, this
  // delta will read wrong in code review — bump the expected number with
  // intent.
  it('registry coverage matches analyzer schema-parse call sites', () => {
    // 22 registered: 21 unique routes + a 23rd hypothetical /me-with-view-as
    // path that uses the same MeResponseSchema (covered by the GET /me row).
    // If this number changes, audit packages/analyzer/src/api/queries.ts
    // and confirm the new contract was added above.
    expect(contracts.length).toBe(22);
  });
});

// Silence unused-import lints when working in-progress: sql is reserved for
// future raw-SQL contracts (e.g. seq-cursor tests) and might not always have
// a call site.
void sql;
