/**
 * MSW request handlers for analyzer tests.
 *
 * These handlers mock the Provenance API endpoints at the network layer.
 * Tests that need different responses should use server.use() to override
 * specific handlers for the duration of that test.
 */

import { http, HttpResponse } from 'msw';
import type { z } from 'zod';
import {
  AssignmentListResponseSchema,
  CohortListResponseSchema,
  IngestJobListResponseSchema,
  IngestJobSchema,
  MeResponseSchema,
  MembersListResponseSchema,
  RosterListResponseSchema,
  SemesterDetailResponseSchema,
  StudentListResponseSchema,
  UnmatchedListResponseSchema,
  type Membership,
  type SubmissionRow,
  type CohortFacets,
  type StudentRollupRow,
} from '@provenance/shared/api-schemas';

/**
 * Wraps HttpResponse.json with Zod validation. If the body doesn't match the
 * schema, throws synchronously at handler-creation time so the test fails
 * on setup rather than producing a misleading "Failed to load X" UI assertion.
 *
 * This is the analyzer-side mirror of the server's contract.test.ts: it
 * guarantees that MSW handlers are returning shapes the analyzer's Zod
 * parsing will actually accept. Without it, a stale handler could feed an
 * invalid response and the analyzer's own Zod parse would throw — the test
 * would then "succeed" only because it observed the error state.
 */
function validatedJson<T>(body: T, schema: z.ZodType<T>, where: string) {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - path=${i.path.join('.')} code=${i.code} msg=${i.message}`)
      .join('\n');
    throw new Error(
      `MSW handler "${where}" returned a body that does not match its shared Zod schema:\n${issues}`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MSW's HttpResponse.json wants JsonBodyType; the parse above already constrained T
  return HttpResponse.json(parsed.data as any);
}

// ---------------------------------------------------------------------------
// Default response fixtures
// ---------------------------------------------------------------------------

export const defaultUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'ta@berkeley.edu',
  display_name: 'Test TA',
  is_superadmin: false,
  protected: false,
  created_at: '2025-01-01T00:00:00.000Z',
  last_login_at: '2025-01-15T10:00:00.000Z',
} as const;

export const defaultMembership = {
  semester_id: '00000000-0000-0000-0000-000000000010',
  semester_slug: 'sp25',
  semester_display_name: 'Spring 2025',
  course_slug: 'cs61a',
  course_name: 'CS 61A',
  role: 'admin' as const,
  granted_at: '2025-01-01T00:00:00.000Z',
};

export const defaultMeResponse = {
  principal_kind: 'session' as const,
  user: defaultUser,
  memberships: [defaultMembership],
  view_as: null,
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const handlers = [
  // GET /api/v1/me — returns authenticated user with one semester
  http.get('/api/v1/me', () => validatedJson(defaultMeResponse, MeResponseSchema, 'GET /me')),

  // POST /api/v1/auth/logout — returns 204
  http.post('/api/v1/auth/logout', () => {
    return new HttpResponse(null, { status: 204 });
  }),
];

// Module-load assertion: the default fixtures must match their schemas. If
// you change a shared schema and forget to update the matching fixture here,
// any analyzer test that imports msw-handlers will fail at import time with
// a clear schema-diff diagnostic — long before the test gets a chance to
// emit a misleading "Failed to load X" UI assertion.
MeResponseSchema.parse(defaultMeResponse);

// ---------------------------------------------------------------------------
// Helper factories for per-test overrides
// ---------------------------------------------------------------------------

/** Returns a /me handler that responds with 401 (not authenticated). */
export function meUnauthorizedHandler() {
  return http.get('/api/v1/me', () => {
    return HttpResponse.json(
      {
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
        },
      },
      { status: 401 },
    );
  });
}

/** Returns a /me handler that responds with empty memberships. */
export function meNoSemestersHandler() {
  return http.get('/api/v1/me', () =>
    validatedJson(
      { ...defaultMeResponse, memberships: [] },
      MeResponseSchema,
      'GET /me (no semesters)',
    ),
  );
}

/** Returns a /me handler that responds with the given memberships. */
export function meWithMembershipsHandler(memberships: Membership[]) {
  return http.get('/api/v1/me', () =>
    validatedJson(
      { ...defaultMeResponse, memberships },
      MeResponseSchema,
      'GET /me (custom memberships)',
    ),
  );
}

// ---------------------------------------------------------------------------
// Cohort fixture factories (Phase 21)
// ---------------------------------------------------------------------------

export const DEFAULT_SEMESTER_ID = defaultMembership.semester_id;
export const DEFAULT_SEMESTER_SLUG = defaultMembership.semester_slug;
export const DEFAULT_COURSE_SLUG = defaultMembership.course_slug;

export function makeSubmissionRow(overrides: Partial<SubmissionRow> = {}): SubmissionRow {
  const base: SubmissionRow = {
    id: '10000000-0000-0000-0000-000000000001',
    semester_id: DEFAULT_SEMESTER_ID,
    assignment: {
      id: '20000000-0000-0000-0000-000000000001',
      assignment_id_str: 'hw1',
      label: 'Homework 1',
    },
    student: {
      id: '30000000-0000-0000-0000-000000000001',
      sid: '3031234',
      display_name: 'Alice Liddell',
    },
    score_total: 5.0,
    score_max_severity: 'medium',
    flag_counts: { info: 1, low: 2, medium: 1, high: 0 },
    top_flags: [{ heuristic_id: 'large_paste', severity: 'medium' }],
    total_active_ms: null,
    total_idle_ms: null,
    validation_status: 'pass',
    ingested_at: '2025-01-10T12:00:00.000Z',
    recorder_version: '1.2.0',
    superseded: false,
    recompute_status: 'fresh',
  };
  // Merge overrides carefully: top-level fields override base, nested objects
  // (assignment, student, flag_counts) are replaced entirely if provided.
  return { ...base, ...overrides };
}

export const defaultFacets: CohortFacets = {
  by_severity: { info: 2, low: 3, medium: 1, high: 0 },
  by_validation: { pass: 4, warn: 1, fail: 0 },
  by_assignment: [{ id: '20000000-0000-0000-0000-000000000001', label: 'Homework 1', count: 5 }],
};

export function cohortSubmissionsHandler(
  items: SubmissionRow[],
  options: {
    next_cursor?: string | null;
    total_count?: number;
    facets?: CohortFacets;
  } = {},
) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/submissions`, () =>
    validatedJson(
      {
        items,
        next_cursor: options.next_cursor ?? null,
        total_count: options.total_count ?? items.length,
        facets: options.facets ?? defaultFacets,
      },
      CohortListResponseSchema,
      'GET /submissions',
    ),
  );
}

export function cohortStudentsHandler(
  items: StudentRollupRow[],
  options: { next_cursor?: string | null; total_count?: number } = {},
) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/students`, () =>
    validatedJson(
      {
        items,
        next_cursor: options.next_cursor ?? null,
        total_count: options.total_count ?? items.length,
      },
      StudentListResponseSchema,
      'GET /students',
    ),
  );
}

export function assignmentsHandler() {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/assignments`, () =>
    validatedJson(
      {
        items: [
          {
            id: '20000000-0000-0000-0000-000000000001',
            semester_id: DEFAULT_SEMESTER_ID,
            assignment_id_str: 'hw1',
            label: 'Homework 1',
            sort_order: 1,
            submission_count: 5,
            distinct_students: 5,
            mean_score: 4.2,
            median_score: 4.5,
            p95_score: 8.0,
            fail_count: 0,
            warn_count: 1,
            // The server always sends this (NOT NULL column, narrowed through
            // parseIngestScopeConfig); `self_identifying` is its default value.
            ingest_scope: { mode: 'self_identifying', on_multiple: 'ingest_all' },
          },
        ],
      },
      AssignmentListResponseSchema,
      'GET /assignments',
    ),
  );
}

// ---------------------------------------------------------------------------
// Phase 22 fixture factories
// ---------------------------------------------------------------------------

export const DEFAULT_JOB_ID = 'aaaa0000-0000-0000-0000-000000000001';

export function makeIngestJob(status: string = 'succeeded', files: object[] = []): object {
  return {
    id: DEFAULT_JOB_ID,
    semester_id: DEFAULT_SEMESTER_ID,
    status,
    created_at: '2025-01-10T12:00:00.000Z',
    started_at: '2025-01-10T12:00:05.000Z',
    completed_at: status === 'succeeded' ? '2025-01-10T12:01:00.000Z' : null,
    summary: {
      total: files.length,
      matched: files.length,
      unmatched: 0,
      duplicate: 0,
      failed: 0,
      superseded: 0,
      discarded: 0,
    },
    files,
  };
}

export function makeIngestFile(
  overrides: Partial<{
    id: string;
    original_filename: string;
    size_bytes: number;
    blob_sha256: string;
    status: string;
    matched_student: { id: string; sid: string; display_name: string };
    matched_assignment: { id: string; assignment_id_str: string; label: string };
  }> = {},
): object {
  return {
    id: overrides.id ?? 'ff000000-0000-0000-0000-000000000001',
    original_filename: overrides.original_filename ?? 'alice_hw1.zip',
    size_bytes: overrides.size_bytes ?? 1024,
    blob_sha256: overrides.blob_sha256 ?? 'abc123',
    status: overrides.status ?? 'matched',
    matched_student: overrides.matched_student ?? {
      id: '30000000-0000-0000-0000-000000000001',
      sid: '3031234',
      display_name: 'Alice Liddell',
    },
    matched_assignment: overrides.matched_assignment ?? {
      id: '20000000-0000-0000-0000-000000000001',
      assignment_id_str: 'hw1',
      label: 'Homework 1',
    },
  };
}

export function ingestJobHandler(job: object) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/ingest/jobs/${DEFAULT_JOB_ID}`, () =>
    validatedJson(
      job as z.infer<typeof IngestJobSchema>,
      IngestJobSchema,
      'GET /ingest/jobs/:jobId',
    ),
  );
}

export function ingestJobsListHandler(items: object[] = []) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/ingest/jobs`, () =>
    validatedJson(
      { items, next_cursor: null } as z.infer<typeof IngestJobListResponseSchema>,
      IngestJobListResponseSchema,
      'GET /ingest/jobs',
    ),
  );
}

export function unmatchedHandler(items: object[] = []) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/unmatched`, () =>
    validatedJson(
      { items, next_cursor: null } as z.infer<typeof UnmatchedListResponseSchema>,
      UnmatchedListResponseSchema,
      'GET /unmatched',
    ),
  );
}

export function rosterHandler(entries: object[] = [], totalCount = 0) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/roster`, () =>
    validatedJson(
      { entries, next_cursor: null, total_count: totalCount } as z.infer<
        typeof RosterListResponseSchema
      >,
      RosterListResponseSchema,
      'GET /roster',
    ),
  );
}

export function membersHandler(members: object[] = [], pending: object[] = []) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/members`, () =>
    validatedJson(
      { members, pending } as z.infer<typeof MembersListResponseSchema>,
      MembersListResponseSchema,
      'GET /members',
    ),
  );
}

export function semesterDetailHandler(
  overrides: Partial<{
    display_name: string;
    filename_convention: string;
  }> = {},
) {
  return http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}`, () =>
    validatedJson(
      {
        semester: {
          id: DEFAULT_SEMESTER_ID,
          course_id: 'cc000000-0000-0000-0000-000000000001',
          slug: DEFAULT_SEMESTER_SLUG,
          term: 'Spring',
          year: 2025,
          display_name: overrides.display_name ?? 'CS 61A Spring 2025',
          filename_convention:
            overrides.filename_convention ?? '(?<sid>\\d+)_(?<assignment_id>hw\\d+)',
          blob_retention_days: 90,
          derived_retention_days: 365,
          archived: false,
          submission_count: 0,
          student_count: 0,
          assignment_count: 0,
          active_config_version: 0,
          my_role: 'admin',
          created_at: '2025-01-01T00:00:00.000Z',
        },
      } as z.infer<typeof SemesterDetailResponseSchema>,
      SemesterDetailResponseSchema,
      'GET /semesters/:id',
    ),
  );
}

export function makeStudentRollupRow(overrides: Partial<StudentRollupRow> = {}): StudentRollupRow {
  return {
    student: overrides.student ?? {
      id: '30000000-0000-0000-0000-000000000001',
      sid: '3031234',
      display_name: 'Alice Liddell',
    },
    submission_count: overrides.submission_count ?? 2,
    score_sum: overrides.score_sum ?? 10.0,
    score_max: overrides.score_max ?? 7.5,
    flag_counts: overrides.flag_counts ?? { info: 1, low: 2, medium: 1, high: 0 },
    worst_submission: overrides.worst_submission ?? makeSubmissionRow(),
    recompute_status: overrides.recompute_status ?? 'fresh',
  };
}
