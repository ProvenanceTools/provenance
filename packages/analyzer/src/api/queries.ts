/**
 * React-Query hooks for Provenance API endpoints.
 *
 * Phase 20 endpoints:
 * - GET /me  → useMe(), useSemesters() (semesters derive from /me memberships)
 * - POST /auth/logout → useLogout()
 *
 * Phase 21 endpoints:
 * - GET /semesters/:id/submissions → useCohortSubmissions()
 * - GET /semesters/:id/students    → useCohortStudents()
 * - GET /semesters/:id/assignments → useAssignments()
 *
 * Note: there is no /me/semesters endpoint. The server returns all memberships
 * inline in GET /me. useSemesters() re-uses the same /me query and maps the
 * memberships array to SemesterSummary objects.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, UnauthorizedError } from './client.js';
import { uploadGradescopeResumable, RESUMABLE_THRESHOLD_BYTES } from './resumable-upload.js';
import {
  MeResponseSchema,
  CohortListResponseSchema,
  StudentListResponseSchema,
  AssignmentListResponseSchema,
  UpdateAssignmentResponseSchema,
  CreateAssignmentResponseSchema,
  IngestJobSchema,
  IngestJobListResponseSchema,
  IngestFileListResponseSchema,
  UnmatchedListResponseSchema,
  RosterListResponseSchema,
  RosterDiffSchema,
  RosterCommitResultSchema,
  MembersListResponseSchema,
  SemesterDetailResponseSchema,
  HeuristicConfigSchema,
  HeuristicConfigHistoryResponseSchema,
  DryRunDiffSchema,
  CommitConfigResponseSchema,
  RecomputeJobSchema,
  CrossFlagListResponseSchema,
  CrossFlagDetailResponseSchema,
  TokensListResponseSchema,
  CreateTokenResponseSchema,
  AdminUserListResponseSchema,
  AdminUserDetailResponseSchema,
  CourseListResponseSchema,
  SemesterListResponseSchema,
  AuditListResponseSchema,
  GradescopeIngestResponseSchema,
  EnrollmentResponseSchema,
} from '@provenance/shared/api-schemas';
import type {
  Membership,
  HeuristicConfigBody,
  CreateTokenRequest,
  CreateCourseRequest,
  CreateSemesterRequest,
  GradescopeIngestResponse,
} from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const queryKeys = {
  me: ['me'] as const,
  cohortSubmissions: (semesterId: string, params: Record<string, unknown>) =>
    ['cohort', semesterId, 'submissions', params] as const,
  cohortStudents: (semesterId: string, params: Record<string, unknown>) =>
    ['cohort', semesterId, 'students', params] as const,
  assignments: (semesterId: string) => ['cohort', semesterId, 'assignments'] as const,
  ingestJobs: (semesterId: string) => ['ingest', semesterId, 'jobs'] as const,
  ingestJob: (jobId: string, semesterId: string) => ['ingest', semesterId, 'job', jobId] as const,
  ingestJobFiles: (jobId: string, semesterId: string, cursor?: string) =>
    ['ingest', semesterId, 'job', jobId, 'files', cursor] as const,
  unmatched: (semesterId: string) => ['unmatched', semesterId] as const,
  roster: (semesterId: string, params?: { q?: string; limit?: number }) =>
    ['roster', semesterId, params ?? {}] as const,
  studentSubmissions: (semesterId: string, studentId: string) =>
    ['cohort', semesterId, 'student', studentId, 'submissions'] as const,
  members: (semesterId: string) => ['members', semesterId] as const,
  semester: (semesterId: string) => ['semester', semesterId] as const,
  activeConfig: (semesterId: string) => ['heuristic-config', semesterId, 'active'] as const,
  configHistory: (semesterId: string) => ['heuristic-config', semesterId, 'history'] as const,
  recomputeJob: (semesterId: string, jobId: string) =>
    ['recompute', semesterId, 'job', jobId] as const,
  crossFlags: (semesterId: string, params: Record<string, unknown>) =>
    ['cross-flags', semesterId, params] as const,
  crossFlagDetail: (crossFlagId: string) => ['cross-flag', crossFlagId] as const,
  myTokens: ['me', 'tokens'] as const,
  // V45 — admin surface
  adminUsers: (q: string, cursor: string | null) => ['admin', 'users', { q, cursor }] as const,
  adminUser: (userId: string) => ['admin', 'users', userId] as const,
  adminCourses: ['admin', 'courses'] as const,
  adminSemesters: (courseId: string) => ['admin', 'courses', courseId, 'semesters'] as const,
  adminAudit: (params: Record<string, unknown>) => ['admin', 'audit', params] as const,
} as const;

// ---------------------------------------------------------------------------
// Retry helper
// ---------------------------------------------------------------------------

function noRetryOn401(failureCount: number, error: Error): boolean {
  if (error instanceof UnauthorizedError) return false;
  return failureCount < 2;
}

// ---------------------------------------------------------------------------
// useMe
// ---------------------------------------------------------------------------

/**
 * Fetches the authenticated principal from GET /me.
 *
 * Stale-time: 5 minutes. Auth errors (401) are NOT retried — they indicate
 * the user needs to log in.
 */
export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => apiFetch('/me', undefined, MeResponseSchema),
    staleTime: 5 * 60 * 1000, // 5 minutes
    retry: noRetryOn401,
  });
}

// ---------------------------------------------------------------------------
// useSemesters
// ---------------------------------------------------------------------------

/**
 * Returns the user's accessible semesters as memberships.
 *
 * This is NOT a separate API call: it re-uses the /me endpoint and returns
 * memberships directly.
 */
export function useSemesters() {
  return useQuery<Membership[], Error>({
    queryKey: [...queryKeys.me, 'semesters'],
    queryFn: async () => {
      const me = await apiFetch('/me', undefined, MeResponseSchema);
      return me.memberships;
    },
    staleTime: 5 * 60 * 1000,
    retry: noRetryOn401,
  });
}

// ---------------------------------------------------------------------------
// useLogout
// ---------------------------------------------------------------------------

/**
 * Mutation that posts to POST /auth/logout and invalidates the /me cache.
 *
 * On success the caller should navigate to /login.
 */
export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiFetch('/auth/logout', {
        method: 'POST',
      }),
    onSuccess: () => {
      // Purge all cached data — user is no longer authenticated.
      queryClient.clear();
    },
  });
}

// ---------------------------------------------------------------------------
// CohortFilters + CohortSort types (mirrors server-side shape in list.ts)
// ---------------------------------------------------------------------------

export type CohortFilters = {
  assignmentId?: string;
  flagIds?: string[]; // multi-value; OR semantics
  severityMin?: 'info' | 'low' | 'medium' | 'high';
  validationStatus?: 'pass' | 'warn' | 'fail';
  scoreMin?: number;
  scoreMax?: number;
  hasExternalEdits?: boolean;
  hasLargePaste?: boolean;
  recorderVersion?: string;
  includeSuperseded?: boolean;
  q?: string;
};

export type CohortSort =
  | 'score_desc'
  | 'score_asc'
  | 'ingested_desc'
  | 'student_asc'
  | 'student_desc'
  | 'assignment_asc';

export type StudentSort = 'score_sum_desc' | 'score_max_desc' | 'student_asc';

// ---------------------------------------------------------------------------
// useCohortSubmissions
// ---------------------------------------------------------------------------

/**
 * Fetches a page of submissions for a semester with filters/sort/cursor.
 *
 * Calls GET /semesters/:semesterId/submissions with query params derived from
 * the filters, sort, cursor, and limit arguments.
 */
export function useCohortSubmissions(
  semesterId: string,
  filters: CohortFilters,
  sort: CohortSort = 'score_desc',
  cursor: string | null = null,
  limit = 50,
) {
  const params = buildSubmissionParams(filters, sort, cursor, limit);
  return useQuery({
    queryKey: queryKeys.cohortSubmissions(semesterId, params),
    queryFn: () => {
      const qs = buildQueryString(params);
      return apiFetch(
        `/semesters/${semesterId}/submissions${qs ? `?${qs}` : ''}`,
        undefined,
        CohortListResponseSchema,
      );
    },
    staleTime: 30 * 1000, // 30 seconds
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

// ---------------------------------------------------------------------------
// useCohortStudents
// ---------------------------------------------------------------------------

/**
 * Fetches the student-rollup rows for a semester.
 *
 * Calls GET /semesters/:semesterId/students.
 */
export function useCohortStudents(
  semesterId: string,
  filters: CohortFilters,
  sort: StudentSort = 'score_sum_desc',
  cursor: string | null = null,
  limit = 50,
) {
  const params = buildStudentParams(filters, sort, cursor, limit);
  return useQuery({
    queryKey: queryKeys.cohortStudents(semesterId, params),
    queryFn: () => {
      const qs = buildQueryString(params);
      return apiFetch(
        `/semesters/${semesterId}/students${qs ? `?${qs}` : ''}`,
        undefined,
        StudentListResponseSchema,
      );
    },
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

// ---------------------------------------------------------------------------
// useAssignments
// ---------------------------------------------------------------------------

/**
 * Fetches the assignment list for a semester (for filter dropdown).
 *
 * Calls GET /semesters/:semesterId/assignments.
 */
export function useAssignments(semesterId: string) {
  return useQuery({
    queryKey: queryKeys.assignments(semesterId),
    queryFn: () =>
      apiFetch(`/semesters/${semesterId}/assignments`, undefined, AssignmentListResponseSchema),
    staleTime: 5 * 60 * 1000, // 5 minutes — assignments change infrequently
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

// ---------------------------------------------------------------------------
// Private helpers — param builders
// ---------------------------------------------------------------------------

type QueryParams = Record<string, string | string[] | undefined>;

export function buildSubmissionParams(
  filters: CohortFilters,
  sort: CohortSort,
  cursor: string | null,
  limit: number,
): QueryParams {
  const p: QueryParams = { sort, limit: String(limit) };
  if (filters.assignmentId) p['assignment_id'] = filters.assignmentId;
  if (filters.flagIds?.length) p['flag_id'] = filters.flagIds;
  if (filters.severityMin) p['severity_min'] = filters.severityMin;
  if (filters.validationStatus) p['validation_status'] = filters.validationStatus;
  if (filters.scoreMin !== undefined) p['score_min'] = String(filters.scoreMin);
  if (filters.scoreMax !== undefined) p['score_max'] = String(filters.scoreMax);
  if (filters.hasExternalEdits !== undefined)
    p['has_external_edits'] = String(filters.hasExternalEdits);
  if (filters.hasLargePaste !== undefined) p['has_large_paste'] = String(filters.hasLargePaste);
  if (filters.recorderVersion) p['recorder_version'] = filters.recorderVersion;
  if (filters.includeSuperseded) p['include_superseded'] = 'true';
  if (filters.q) p['q'] = filters.q;
  if (cursor) p['cursor'] = cursor;
  return p;
}

export function buildStudentParams(
  filters: CohortFilters,
  sort: StudentSort,
  cursor: string | null,
  limit: number,
): QueryParams {
  const p: QueryParams = { sort, limit: String(limit) };
  if (filters.assignmentId) p['assignment_id'] = filters.assignmentId;
  if (filters.flagIds?.length) p['flag_id'] = filters.flagIds;
  if (filters.severityMin) p['severity_min'] = filters.severityMin;
  if (filters.validationStatus) p['validation_status'] = filters.validationStatus;
  if (filters.scoreMin !== undefined) p['score_min'] = String(filters.scoreMin);
  if (filters.scoreMax !== undefined) p['score_max'] = String(filters.scoreMax);
  if (filters.hasExternalEdits !== undefined)
    p['has_external_edits'] = String(filters.hasExternalEdits);
  if (filters.hasLargePaste !== undefined) p['has_large_paste'] = String(filters.hasLargePaste);
  if (filters.recorderVersion) p['recorder_version'] = filters.recorderVersion;
  if (filters.includeSuperseded) p['include_superseded'] = 'true';
  if (filters.q) p['q'] = filters.q;
  if (cursor) p['cursor'] = cursor;
  return p;
}

// ---------------------------------------------------------------------------
// Phase 22 — Ingest hooks
// ---------------------------------------------------------------------------

/**
 * Fetches an ingest job by ID. Polls every 3 seconds while not terminal.
 */
export function useIngestJob(jobId: string, semesterId: string) {
  return useQuery({
    queryKey: queryKeys.ingestJob(jobId, semesterId),
    queryFn: () =>
      apiFetch(`/semesters/${semesterId}/ingest/jobs/${jobId}`, undefined, IngestJobSchema),
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const terminal =
        status === 'succeeded' ||
        status === 'partial' ||
        status === 'failed' ||
        status === 'cancelled';
      return terminal ? false : 3000;
    },
    retry: noRetryOn401,
    enabled: jobId !== '' && semesterId !== '',
  });
}

/**
 * Fetches the paginated list of ingest jobs for a semester.
 */
export function useIngestJobsList(semesterId: string) {
  return useQuery({
    queryKey: queryKeys.ingestJobs(semesterId),
    queryFn: () =>
      apiFetch(
        `/semesters/${semesterId}/ingest/jobs?limit=20`,
        undefined,
        IngestJobListResponseSchema,
      ),
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

/**
 * Fetches a paginated file list for an ingest job.
 */
export function useIngestJobFiles(jobId: string, semesterId: string, cursor?: string) {
  return useQuery({
    queryKey: queryKeys.ingestJobFiles(jobId, semesterId, cursor),
    queryFn: () => {
      const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}&limit=50` : '?limit=50';
      return apiFetch(
        `/semesters/${semesterId}/ingest/jobs/${jobId}/files${qs}`,
        undefined,
        IngestFileListResponseSchema,
      );
    },
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: jobId !== '' && semesterId !== '',
  });
}

/**
 * Mutation: POST /semesters/:semesterId/ingest (multipart upload).
 * Uses XMLHttpRequest to support upload progress callbacks.
 */
export function useStartIngest(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      files,
      onProgress,
    }: {
      files: File[];
      onProgress?: (pct: number) => void;
    }): Promise<{ job_id: string }> =>
      new Promise((resolve, reject) => {
        const formData = new FormData();
        for (const file of files) {
          formData.append('files[]', file);
        }
        const xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable && onProgress) {
            onProgress(Math.round((evt.loaded / evt.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status === 202) {
            const data = JSON.parse(xhr.responseText) as { job_id: string };
            resolve(data);
          } else {
            try {
              const err = JSON.parse(xhr.responseText) as {
                error?: { code: string; message: string };
              };
              reject(new Error(err.error?.message ?? `HTTP ${xhr.status}`));
            } catch {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        // Determine base URL
        const base = (typeof window !== 'undefined' ? window.location.origin : '') + '/api/v1';
        xhr.open('POST', `${base}/semesters/${semesterId}/ingest`);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.send(formData);
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ingestJobs(semesterId) });
    },
  });
}

/**
 * Mutation: POST /semesters/:semesterId/ingest:gradescope (multipart upload).
 *
 * The primary upload path: a single Gradescope "Download Submissions" export
 * ZIP in the `archive` field. Uses XMLHttpRequest for upload progress. The
 * server upserts the roster and enqueues an ingest job; the response carries
 * the roster diff, processed/queued counts, and skipped folders. `job_id` is
 * null when the export had no processable bundles (roster-only upload).
 */
export function useStartGradescopeIngest(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      file,
      onProgress,
    }: {
      file: File;
      onProgress?: (pct: number) => void;
    }): Promise<GradescopeIngestResponse> => {
      // Large exports use the resumable (chunked) path; smaller ones the single
      // request (which the server streams to disk).
      if (file.size >= RESUMABLE_THRESHOLD_BYTES) {
        return uploadGradescopeResumable(semesterId, file, onProgress);
      }
      return new Promise((resolve, reject) => {
        const formData = new FormData();
        formData.append('archive', file);
        const xhr = new XMLHttpRequest();
        xhr.withCredentials = true;
        xhr.upload.onprogress = (evt) => {
          if (evt.lengthComputable && onProgress) {
            onProgress(Math.round((evt.loaded / evt.total) * 100));
          }
        };
        xhr.onload = () => {
          // 202 (job enqueued) and 200 (roster-only, no bundles) both succeed.
          if (xhr.status === 202 || xhr.status === 200) {
            try {
              resolve(GradescopeIngestResponseSchema.parse(JSON.parse(xhr.responseText)));
            } catch (e) {
              reject(e instanceof Error ? e : new Error('Invalid server response'));
            }
          } else {
            try {
              const err = JSON.parse(xhr.responseText) as {
                error?: { code: string; message: string };
              };
              reject(new Error(err.error?.message ?? `HTTP ${xhr.status}`));
            } catch {
              reject(new Error(`HTTP ${xhr.status}`));
            }
          }
        };
        xhr.onerror = () => reject(new Error('Network error'));
        const base = (typeof window !== 'undefined' ? window.location.origin : '') + '/api/v1';
        xhr.open('POST', `${base}/semesters/${semesterId}/ingest:gradescope`);
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.send(formData);
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ingestJobs(semesterId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster(semesterId) });
    },
  });
}

/**
 * Mutation: POST /semesters/:semesterId/ingest/jobs/:jobId/cancel
 */
export function useCancelIngest(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      apiFetch(`/semesters/${semesterId}/ingest/jobs/${jobId}/cancel`, { method: 'POST' }),
    onSuccess: (_data, jobId) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.ingestJob(jobId, semesterId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.ingestJobs(semesterId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 22 — Unmatched hooks
// ---------------------------------------------------------------------------

/** Lists unmatched files for a semester. */
export function useUnmatchedFiles(semesterId: string) {
  return useQuery({
    queryKey: queryKeys.unmatched(semesterId),
    queryFn: () =>
      apiFetch(
        `/semesters/${semesterId}/unmatched?limit=50`,
        undefined,
        UnmatchedListResponseSchema,
      ),
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

/** Mutation: PATCH /semesters/:semesterId/unmatched/:ingestFileId */
export function useAttachUnmatched(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      ingestFileId,
      studentId,
      assignmentIdStr,
    }: {
      ingestFileId: string;
      studentId: string;
      assignmentIdStr: string;
    }) =>
      apiFetch(`/semesters/${semesterId}/unmatched/${ingestFileId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ student_id: studentId, assignment_id_str: assignmentIdStr }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.unmatched(semesterId) });
    },
  });
}

/** Mutation: POST /semesters/:semesterId/unmatched/:ingestFileId/discard */
export function useDiscardUnmatched(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ingestFileId, reason }: { ingestFileId: string; reason?: string }) =>
      apiFetch(`/semesters/${semesterId}/unmatched/${ingestFileId}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.unmatched(semesterId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 22 — Roster hooks
// ---------------------------------------------------------------------------

/**
 * Lists roster entries for a semester.
 *
 * Optional `q` runs a server-side substring search across sid/display_name/email;
 * `limit` defaults to 500 (well above a typical course size, so the common case
 * is one page). Callers expecting very large rosters should debounce `q`.
 */
export function useRoster(semesterId: string, opts: { q?: string; limit?: number } = {}) {
  const limit = opts.limit ?? 500;
  const q = opts.q ?? '';
  const params: { q?: string; limit?: number } = { limit };
  if (q !== '') params.q = q;
  return useQuery({
    queryKey: queryKeys.roster(semesterId, params),
    queryFn: () => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (q !== '') qs.set('q', q);
      return apiFetch(
        `/semesters/${semesterId}/roster?${qs.toString()}`,
        undefined,
        RosterListResponseSchema,
      );
    },
    staleTime: 60 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

/**
 * Lists all submissions for a single student, including superseded ones.
 *
 * Used by the unmatched-attach modal to detect (student, assignment) conflicts
 * so we can warn the admin before silently superseding an existing submission.
 */
export function useStudentSubmissions(semesterId: string, studentId: string) {
  return useQuery({
    queryKey: queryKeys.studentSubmissions(semesterId, studentId),
    queryFn: () => {
      const qs = new URLSearchParams({
        student_id: studentId,
        include_superseded: 'true',
        limit: '200',
      });
      return apiFetch(
        `/semesters/${semesterId}/submissions?${qs.toString()}`,
        undefined,
        CohortListResponseSchema,
      );
    },
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '' && studentId !== '',
  });
}

/**
 * Mutation: POST /semesters/:semesterId/roster:upload
 * Returns a diff preview without committing.
 */
export function useRosterUpload(semesterId: string) {
  return useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return apiFetch(
        `/semesters/${semesterId}/roster:upload`,
        { method: 'POST', body: formData },
        RosterDiffSchema,
      );
    },
  });
}

/**
 * Mutation: POST /semesters/:semesterId/roster:commit
 */
export function useRosterCommit(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uploadId, acceptDeletions }: { uploadId: string; acceptDeletions: boolean }) =>
      apiFetch(
        `/semesters/${semesterId}/roster:commit`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ upload_id: uploadId, accept_deletions: acceptDeletions }),
        },
        RosterCommitResultSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.roster(semesterId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 22 — Members hooks
// ---------------------------------------------------------------------------

/** Lists members and pending invitations for a semester. */
export function useMembers(semesterId: string) {
  return useQuery({
    queryKey: queryKeys.members(semesterId),
    queryFn: () =>
      apiFetch(`/semesters/${semesterId}/members`, undefined, MembersListResponseSchema),
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

/** Mutation: POST /semesters/:semesterId/members (invite). */
export function useInviteMember(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role: 'admin' | 'grader' }) =>
      apiFetch(`/semesters/${semesterId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(semesterId) });
      // Inviting yourself changes which semesters you can see/navigate to.
      // /me (and the useSemesters slice derived from it) drives the home tiles
      // and slug→id resolution, so it must be refreshed too. Prefix-matches
      // both ['me'] and ['me','semesters'].
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/** Mutation: PATCH /semesters/:semesterId/members/:userId */
export function useUpdateMemberRole(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: 'admin' | 'grader' }) =>
      apiFetch(`/semesters/${semesterId}/members/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(semesterId) });
      // Changing your own role flips my_role on the home tiles. Refresh /me.
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/** Mutation: DELETE /semesters/:semesterId/members/:userId */
export function useRemoveMember(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch(`/semesters/${semesterId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(semesterId) });
      // Removing yourself drops the semester from your home tiles. Refresh /me.
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

// ---------------------------------------------------------------------------
// Assignment mutation hook — PATCH /semesters/:id/assignments/:assignmentId.
// Backend landed in V46 (was stubbed in Phase 22).
// ---------------------------------------------------------------------------

/** Mutation: PATCH /semesters/:semesterId/assignments/:assignmentId */
export function useUpdateAssignment(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      assignmentId,
      label,
      sortOrder,
    }: {
      assignmentId: string;
      label?: string;
      sortOrder?: number;
    }) => {
      const body: { label?: string; sort_order?: number } = {};
      if (label !== undefined) body.label = label;
      if (sortOrder !== undefined) body.sort_order = sortOrder;
      return apiFetch(
        `/semesters/${semesterId}/assignments/${assignmentId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        UpdateAssignmentResponseSchema,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments(semesterId) });
    },
  });
}

/** Mutation: POST /semesters/:semesterId/assignments */
export function useCreateAssignment(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ assignmentIdStr, label }: { assignmentIdStr: string; label?: string }) => {
      const body: { assignment_id_str: string; label?: string } = {
        assignment_id_str: assignmentIdStr,
      };
      if (label !== undefined && label !== '') body.label = label;
      return apiFetch(
        `/semesters/${semesterId}/assignments`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        CreateAssignmentResponseSchema,
      );
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.assignments(semesterId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 22 — Semester detail + settings hooks
// ---------------------------------------------------------------------------

/** Fetches semester detail by ID (GET /semesters/:semesterId). */
export function useSemester(semesterId: string) {
  return useQuery({
    queryKey: queryKeys.semester(semesterId),
    queryFn: () => apiFetch(`/semesters/${semesterId}`, undefined, SemesterDetailResponseSchema),
    staleTime: 60 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

/** Mutation: PATCH /semesters/:semesterId */
export function useUpdateSemester(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updates: {
      display_name?: string;
      filename_convention?: string;
      blob_retention_days?: number;
      derived_retention_days?: number;
    }) =>
      apiFetch(
        `/semesters/${semesterId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates),
        },
        SemesterDetailResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.semester(semesterId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 24 — Heuristic config hooks
// ---------------------------------------------------------------------------

/** Fetches the active heuristic config for a semester. */
export function useActiveConfig(semesterId: string) {
  return useQuery({
    queryKey: queryKeys.activeConfig(semesterId),
    queryFn: () =>
      apiFetch(`/semesters/${semesterId}/heuristic-config`, undefined, HeuristicConfigSchema),
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

/** Fetches the heuristic config version history for a semester. */
export function useConfigHistory(semesterId: string) {
  return useQuery({
    queryKey: queryKeys.configHistory(semesterId),
    queryFn: () =>
      apiFetch(
        `/semesters/${semesterId}/heuristic-configs`,
        undefined,
        HeuristicConfigHistoryResponseSchema,
      ),
    staleTime: 60 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

/** Mutation: PUT /semesters/:semesterId/heuristic-config?dryRun=true */
export function useDryRunConfig(semesterId: string) {
  return useMutation({
    mutationFn: ({
      config,
      currentVersion,
    }: {
      config: HeuristicConfigBody;
      currentVersion: number;
    }) =>
      apiFetch(
        `/semesters/${semesterId}/heuristic-config?dryRun=true`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'If-Match': String(currentVersion),
          },
          body: JSON.stringify(config),
        },
        DryRunDiffSchema,
      ),
  });
}

/** Mutation: PUT /semesters/:semesterId/heuristic-config (commit) */
export function useCommitConfig(semesterId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      config,
      currentVersion,
      note,
    }: {
      config: HeuristicConfigBody;
      currentVersion: number;
      note?: string;
    }) =>
      apiFetch(
        `/semesters/${semesterId}/heuristic-config`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'If-Match': String(currentVersion),
          },
          body: JSON.stringify({ ...config, note: note ?? '' }),
        },
        CommitConfigResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.activeConfig(semesterId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.configHistory(semesterId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 24 — Recompute job polling hook
// ---------------------------------------------------------------------------

/**
 * Polls a recompute job until it reaches a terminal status.
 * Polls every 2s while not terminal.
 */
export function useRecomputeJob(semesterId: string, jobId: string) {
  return useQuery({
    queryKey: queryKeys.recomputeJob(semesterId, jobId),
    queryFn: () =>
      apiFetch(`/semesters/${semesterId}/recompute/${jobId}`, undefined, RecomputeJobSchema),
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      const terminal =
        status === 'succeeded' ||
        status === 'partial' ||
        status === 'failed' ||
        status === 'cancelled';
      return terminal ? false : 2000;
    },
    retry: noRetryOn401,
    enabled: jobId !== '' && semesterId !== '',
  });
}

// ---------------------------------------------------------------------------
// Phase 24 — Cross-flag hooks
// ---------------------------------------------------------------------------

export type CrossFlagFilters = {
  heuristicId?: string;
  severityMin?: 'info' | 'low' | 'medium' | 'high';
  submissionId?: string;
  cursor?: string;
  limit?: number;
};

/** Lists cross-flags for a semester with optional filters. */
export function useCrossFlagList(semesterId: string, filters: CrossFlagFilters = {}) {
  const params: QueryParams = {};
  if (filters.heuristicId) params['heuristic_id'] = filters.heuristicId;
  if (filters.severityMin) params['severity_min'] = filters.severityMin;
  if (filters.submissionId) params['submission_id'] = filters.submissionId;
  if (filters.cursor) params['cursor'] = filters.cursor;
  if (filters.limit) params['limit'] = String(filters.limit);

  return useQuery({
    queryKey: queryKeys.crossFlags(semesterId, params),
    queryFn: () => {
      const qs = buildQueryString(params);
      return apiFetch(
        `/semesters/${semesterId}/cross-flags${qs ? `?${qs}` : ''}`,
        undefined,
        CrossFlagListResponseSchema,
      );
    },
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: semesterId !== '',
  });
}

/** Fetches a single cross-flag detail by ID. */
export function useCrossFlagDetail(crossFlagId: string) {
  return useQuery({
    queryKey: queryKeys.crossFlagDetail(crossFlagId),
    queryFn: () =>
      apiFetch(`/cross-flags/${crossFlagId}`, undefined, CrossFlagDetailResponseSchema),
    staleTime: 60 * 1000,
    retry: noRetryOn401,
    enabled: crossFlagId !== '',
  });
}

// ---------------------------------------------------------------------------
// Export hook removed in V46.
//
// The Phase 24 useStartExport hook called POST /submissions/:id/export which
// has no server handler. With the export UI now stubbed (ExportPanel.tsx) the
// hook had no callers. When the v3.1 markdown export endpoint lands, restore a
// minimal mutation that parses ExportSyncResponseSchema.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// v3.1 — Personal access token hooks (PRD §8.12)
// ---------------------------------------------------------------------------

/** Lists the current user's API tokens (active + revoked). */
export function useMyTokens() {
  return useQuery({
    queryKey: queryKeys.myTokens,
    queryFn: () => apiFetch('/me/tokens', undefined, TokensListResponseSchema),
    staleTime: 30 * 1000,
    retry: noRetryOn401,
  });
}

/**
 * Mutation: POST /me/tokens. Response includes the full `secret` exactly once;
 * callers must surface it to the user before it leaves component state.
 */
export function useCreateToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateTokenRequest) =>
      apiFetch(
        '/me/tokens',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
        CreateTokenResponseSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTokens });
    },
  });
}

/** Mutation: DELETE /me/tokens/:id (idempotent — 204 whether new or already revoked). */
export function useRevokeToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) => apiFetch(`/me/tokens/${tokenId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.myTokens });
    },
  });
}

// ---------------------------------------------------------------------------
// Student enrollment (program spec §5a — S2)
// ---------------------------------------------------------------------------

/**
 * Mutation: POST /semesters/:semesterId/enrollment — mint this student's
 * enrollment token.
 *
 * The one call in this file made by a student rather than by course staff. Two
 * deliberate omissions:
 *
 *  - **No `onSuccess` invalidation.** Nothing in the query cache describes an
 *    enrollment; a student can read no endpoint that would change. The minted
 *    token lives in component state and is shown once, exactly like the API
 *    token secret in `useCreateToken`.
 *  - **No retry, and no wrapper query.** Minting is not idempotent from the
 *    server's point of view (it writes a `student_enrollments` row and
 *    supersedes any previous key), so a silent retry would churn rows behind a
 *    student who pressed the button once. `useMutation` does not retry by
 *    default; this comment is here so nobody adds one.
 *
 * The response is validated against `EnrollmentResponseSchema` before it
 * reaches the view, so a truncated or altered body fails here rather than being
 * handed to a student as a token to paste.
 */
export function useMintEnrollment(semesterId: string) {
  return useMutation({
    mutationFn: (studentPubkey: string) =>
      apiFetch(
        `/semesters/${semesterId}/enrollment`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ student_pubkey: studentPubkey }),
        },
        EnrollmentResponseSchema,
      ),
  });
}

// ---------------------------------------------------------------------------
// V45 — Admin sub-app hooks (superadmin-only routes)
// ---------------------------------------------------------------------------

/** Lists all platform users; optional free-text search on email + display_name. */
export function useAdminUsers(q = '', cursor: string | null = null) {
  return useQuery({
    queryKey: queryKeys.adminUsers(q, cursor),
    queryFn: () => {
      const qs = buildQueryString({
        ...(q !== '' ? { q } : {}),
        ...(cursor !== null ? { cursor } : {}),
        limit: '50',
      });
      return apiFetch(`/admin/users${qs ? `?${qs}` : ''}`, undefined, AdminUserListResponseSchema);
    },
    staleTime: 30 * 1000,
    retry: noRetryOn401,
  });
}

/** Fetches one user + their memberships across every semester. */
export function useAdminUser(userId: string) {
  return useQuery({
    queryKey: queryKeys.adminUser(userId),
    queryFn: () => apiFetch(`/admin/users/${userId}`, undefined, AdminUserDetailResponseSchema),
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: userId !== '',
  });
}

/** Mutation: DELETE /admin/users/:userId. Refuses to delete self (server-enforced). */
export function useDeleteUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => apiFetch(`/admin/users/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

/** Mutation: PATCH /admin/users/:userId/protected. Cannot be applied to your own account (server-enforced + UI-disabled). */
export function useSetUserProtected() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, protected: isProtected }: { userId: string; protected: boolean }) =>
      apiFetch(`/admin/users/${userId}/protected`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protected: isProtected }),
      }),
    onSuccess: () => {
      // Prefix-match invalidates all pages of the admin users list.
      void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
  });
}

/** Mutation: POST /admin/view-as. Sticky on the session row until exit. */
export function useStartViewAs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      apiFetch('/admin/view-as', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      }),
    onSuccess: () => {
      // Bust /me so the banner + memberships repopulate from the target's view.
      queryClient.clear();
    },
  });
}

/** Mutation: POST /admin/view-as/exit. Idempotent. */
export function useExitViewAs() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch('/admin/view-as/exit', { method: 'POST' }),
    onSuccess: () => {
      queryClient.clear();
    },
  });
}

/** Lists all courses (superadmin: gets every course; non-superadmin: visible subset). */
export function useAdminCourses() {
  return useQuery({
    queryKey: queryKeys.adminCourses,
    queryFn: () => apiFetch('/courses', undefined, CourseListResponseSchema),
    staleTime: 30 * 1000,
    retry: noRetryOn401,
  });
}

/** Mutation: POST /courses (superadmin only). */
export function useCreateCourse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateCourseRequest) =>
      apiFetch('/courses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminCourses });
    },
  });
}

/** Mutation: POST /courses/:id/archive (superadmin only). */
export function useArchiveCourse() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (courseId: string) => apiFetch(`/courses/${courseId}/archive`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminCourses });
    },
  });
}

/**
 * Mutation: POST /semesters/:id/archive (superadmin only).
 *
 * Bound to a course so the semesters list (and course-level semester counts)
 * refetch after the archive lands.
 */
export function useArchiveSemester(courseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (semesterId: string) =>
      apiFetch(`/semesters/${semesterId}/archive`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminSemesters(courseId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminCourses });
    },
  });
}

/** Lists semesters within a course. */
export function useAdminSemesters(courseId: string) {
  return useQuery({
    queryKey: queryKeys.adminSemesters(courseId),
    queryFn: () =>
      apiFetch(`/courses/${courseId}/semesters`, undefined, SemesterListResponseSchema),
    staleTime: 30 * 1000,
    retry: noRetryOn401,
    enabled: courseId !== '',
  });
}

/**
 * Mutation: add the current user to a semester as admin, from the /admin
 * sub-app.
 *
 * Unlike useInviteMember — which is bound to a single semester the caller is
 * already a member of — this takes the semesterId per call. That's what lets a
 * superadmin grant themselves access to a semester they just created: the
 * per-semester Members page can't reach that case because it resolves the
 * semester id from the membership list, which is empty until you're a member.
 * The admin semesters list already carries the real semester id, so the /admin
 * view can break the chicken-and-egg.
 */
export function useAddSelfAsAdmin(courseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ semesterId, email }: { semesterId: string; email: string }) =>
      apiFetch(`/semesters/${semesterId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role: 'admin' }),
      }),
    onSuccess: (_data, { semesterId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.members(semesterId) });
      // my_role on the admin semesters table flips to 'admin'.
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminSemesters(courseId) });
      // /me drives the home tiles + slug→id resolution for the now-reachable
      // per-semester pages. Prefix-matches ['me'] and ['me','semesters'].
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/** Mutation: POST /courses/:id/semesters (superadmin only). */
export function useCreateSemester(courseId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSemesterRequest) =>
      apiFetch(`/courses/${courseId}/semesters`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.adminSemesters(courseId) });
    },
  });
}

/** Lists audit-log rows; supports the standard filter set + cursor. */
export function useAdminAudit(params: {
  semester_id?: string;
  actor_user_id?: string;
  action?: string;
  since?: string;
  until?: string;
  cursor?: string;
}) {
  return useQuery({
    queryKey: queryKeys.adminAudit(params),
    queryFn: () => {
      const qs = buildQueryString({ ...params, limit: '100' });
      return apiFetch(`/audit${qs ? `?${qs}` : ''}`, undefined, AuditListResponseSchema);
    },
    staleTime: 10 * 1000,
    retry: noRetryOn401,
  });
}

/**
 * Builds a URL query string from a params map.
 * Multi-value arrays produce repeated keys (e.g. flag_id=a&flag_id=b).
 */
export function buildQueryString(params: QueryParams): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}
