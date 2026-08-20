/**
 * Shared Zod schemas for the Provenance API.
 *
 * These schemas mirror the response shapes returned by the server and are
 * consumed by the analyzer frontend. Both packages import from here so the
 * shape contract is defined in one place.
 *
 * Phase 20: /me, memberships.
 * Phase 21: cohort list (SubmissionRow, CohortListResponse, StudentRollupRow,
 *            CohortFacets, Severity), assignments list.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  is_superadmin: z.boolean(),
  protected: z.boolean(),
  created_at: z.string().datetime(),
  last_login_at: z.string().datetime().nullable(),
});
export type User = z.infer<typeof UserSchema>;

export const TokenScopesSchema = z.object({
  read_only: z.boolean().default(false),
  semester_ids: z.union([z.null(), z.array(z.string().uuid())]).default(null),
  include_blobs: z.boolean().default(false),
});
export type TokenScopes = z.infer<typeof TokenScopesSchema>;

export const MembershipSchema = z.object({
  semester_id: z.string().uuid(),
  semester_slug: z.string(),
  semester_display_name: z.string(),
  course_slug: z.string(),
  course_name: z.string(),
  role: z.enum(['admin', 'grader']),
  granted_at: z.string().datetime(),
});
export type Membership = z.infer<typeof MembershipSchema>;

// ---------------------------------------------------------------------------
// /me response
// ---------------------------------------------------------------------------

/**
 * View-as block (V45): present on session-principal /me responses.
 * `view_as` is null when the superadmin is not impersonating; a structured
 * summary of the target user (id + email + display_name) plus the start
 * timestamp when impersonation is active. Carries the actor's *target*, not
 * the actor itself — the actor remains on `user`.
 */
export const ViewAsSummarySchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    display_name: z.string().nullable(),
  }),
  started_at: z.string().datetime(),
});
export type ViewAsSummary = z.infer<typeof ViewAsSummarySchema>;

export const MeResponseSchema = z.discriminatedUnion('principal_kind', [
  z.object({
    principal_kind: z.literal('session'),
    user: UserSchema,
    memberships: z.array(MembershipSchema),
    view_as: ViewAsSummarySchema.nullable(),
  }),
  z.object({
    principal_kind: z.literal('token'),
    user: UserSchema,
    memberships: z.array(MembershipSchema),
    token: z.object({
      id: z.string().uuid(),
      label: z.string(),
      scopes: TokenScopesSchema,
    }),
  }),
]);
export type MeResponse = z.infer<typeof MeResponseSchema>;

// ---------------------------------------------------------------------------
// Severity + validation status primitives
// ---------------------------------------------------------------------------

export const SeveritySchema = z.enum(['info', 'low', 'medium', 'high']);
export type Severity = z.infer<typeof SeveritySchema>;

export const ValidationStatusSchema = z.enum(['pass', 'warn', 'fail']);
export type ValidationStatus = z.infer<typeof ValidationStatusSchema>;

// ---------------------------------------------------------------------------
// Phase 21 cohort schemas — SubmissionRow (PRD §8.8 line 1083+)
// ---------------------------------------------------------------------------

export const SubmissionRowSchema = z.object({
  id: z.string().uuid(),
  semester_id: z.string().uuid(),
  assignment: z.object({
    id: z.string().uuid(),
    assignment_id_str: z.string(),
    label: z.string(),
  }),
  student: z.object({
    id: z.string().uuid(),
    sid: z.string(),
    display_name: z.string(),
  }),
  score_total: z.number(),
  score_max_severity: SeveritySchema,
  flag_counts: z.object({
    info: z.number().int(),
    low: z.number().int(),
    medium: z.number().int(),
    high: z.number().int(),
  }),
  top_flags: z.array(
    z.object({
      heuristic_id: z.string(),
      severity: SeveritySchema,
    }),
  ),
  /**
   * Bundle-level active/idle milliseconds (60s event-gap). Null until the
   * next ingest or heuristics recompute writes them (pre-0021 rows).
   */
  total_active_ms: z.number().int().nullable(),
  total_idle_ms: z.number().int().nullable(),
  validation_status: z.string().nullable(),
  ingested_at: z.string().datetime(),
  recorder_version: z.string().nullable(),
  superseded: z.boolean(),
  recompute_status: z.string(),
});
export type SubmissionRow = z.infer<typeof SubmissionRowSchema>;

// ---------------------------------------------------------------------------
// Phase 21 cohort schemas — CohortFacets + CohortListResponse (PRD §8.8 line 1075+)
// ---------------------------------------------------------------------------

export const CohortFacetsSchema = z.object({
  by_severity: z.object({
    info: z.number().int(),
    low: z.number().int(),
    medium: z.number().int(),
    high: z.number().int(),
  }),
  by_validation: z.object({
    pass: z.number().int(),
    warn: z.number().int(),
    fail: z.number().int(),
  }),
  by_assignment: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      count: z.number().int(),
    }),
  ),
});
export type CohortFacets = z.infer<typeof CohortFacetsSchema>;

export const CohortListResponseSchema = z.object({
  items: z.array(SubmissionRowSchema),
  next_cursor: z.string().nullable(),
  total_count: z.number().int(),
  facets: CohortFacetsSchema,
});
export type CohortListResponse = z.infer<typeof CohortListResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 21 cohort schemas — StudentRollupRow (PRD §8.8 line 1110+)
// ---------------------------------------------------------------------------

export const StudentRollupRowSchema = z.object({
  student: z.object({
    id: z.string().uuid(),
    sid: z.string(),
    display_name: z.string(),
    // roster_entries.email is nullable in the DB; the server returns null
    // (not undefined) when unset. Accept both — optional() alone would let
    // the response shape silently degrade if the server ever changes its
    // null-vs-omit policy.
    email: z.string().nullable().optional(),
  }),
  submission_count: z.number().int(),
  score_sum: z.number(),
  score_max: z.number(),
  flag_counts: z.object({
    info: z.number().int(),
    low: z.number().int(),
    medium: z.number().int(),
    high: z.number().int(),
  }),
  worst_submission: SubmissionRowSchema.nullable(),
  recompute_status: z.string(),
});
export type StudentRollupRow = z.infer<typeof StudentRollupRowSchema>;

export const StudentListResponseSchema = z.object({
  items: z.array(StudentRollupRowSchema),
  next_cursor: z.string().nullable(),
  total_count: z.number().int(),
});
export type StudentListResponse = z.infer<typeof StudentListResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 21 — Assignment summary row (for filter dropdown)
// ---------------------------------------------------------------------------

/**
 * The declared submission type for a batch of ingested submissions, plus the
 * two knobs that settle what self-identification cannot.
 *
 * This ONE object lives in two places, deliberately:
 *   - persisted per assignment as `assignments.ingest_scope` — the default
 *     provgate sets once at Gradescope→Provenance mapping time; and
 *   - passed on an individual ingest request as an override, for a one-off
 *     re-ingest or a fixup. The override beats the persisted default.
 *
 * Modes:
 *   - `self_identifying` (DEFAULT) — walk the tree and accept every sealed
 *     `.provenance/` scope wherever it sits, however many. Nothing is declared;
 *     each scope's manifest already says which assignment it is. This is what
 *     makes a nested multi-assignment repo work, and it is what every
 *     assignment predating this field already does.
 *   - `bundle_zip` — the classic sealed `.zip` bundle: exactly one scope, at
 *     the tree root. A tree carrying a nested `.provenance/` is a repo, not a
 *     bundle zip, and fails.
 *   - `repo_whole` — a git repo treated as ONE scope, at the repo root. Nested
 *     scopes are excluded rather than fanned out. No root scope ⇒ fails.
 *   - `repo_scoped` — a git repo in which `path_glob` selects the scope(s).
 *     `path_glob` is REQUIRED. A glob that selects nothing fails, rather than
 *     quietly ingesting zero submissions.
 *
 * A submission that does not match the declaration fails THAT SUBMISSION (not
 * the batch) and is reported through the existing skipped/unmatched channel
 * with reason `submission_type_mismatch` — see `GradescopeSkippedEntrySchema`.
 *
 * `path_glob` matches the scope's directory prefix (`''` = tree root, else e.g.
 * `proj2/`); both `proj2` and `proj2/**` are accepted spellings. `on_multiple`
 * is orthogonal to the mode and decides what happens when more than one
 * ACCEPTED scope declares the same `assignment_id`.
 *
 * `mode: 'path'` was the pre-2026-08 spelling of `repo_scoped`. It is NOT
 * accepted here — the API is the strict boundary — but the server still reads
 * it out of storage as `repo_scoped`, so a row written before migration 0026
 * behaves identically.
 */
export const IngestScopeConfigSchema = z
  .object({
    mode: z.enum(['self_identifying', 'bundle_zip', 'repo_whole', 'repo_scoped']),
    path_glob: z.string().min(1).max(500).optional(),
    // Deliberately required rather than `.default('ingest_all')`: a zod default
    // makes the schema's input and output types diverge, and this object is
    // round-tripped (written on PATCH, read back on AssignmentSummary), so the
    // divergence would infect every consumer with an `on_multiple | undefined`.
    // A declaration API is the right place to make the caller say what it means.
    on_multiple: z.enum(['error', 'ingest_all']),
  })
  .refine((v) => v.mode !== 'repo_scoped' || v.path_glob !== undefined, {
    message: "path_glob is required when mode is 'repo_scoped'",
    path: ['path_glob'],
  })
  .refine((v) => v.mode === 'repo_scoped' || v.path_glob === undefined, {
    message: "path_glob is only meaningful when mode is 'repo_scoped'",
    path: ['path_glob'],
  });
export type IngestScopeConfig = z.infer<typeof IngestScopeConfigSchema>;

export const AssignmentSummarySchema = z.object({
  id: z.string().uuid(),
  semester_id: z.string().uuid(),
  assignment_id_str: z.string(),
  label: z.string(),
  sort_order: z.number().int(),
  submission_count: z.number().int(),
  distinct_students: z.number().int(),
  mean_score: z.number(),
  median_score: z.number(),
  p95_score: z.number(),
  fail_count: z.number().int(),
  warn_count: z.number().int(),
  /**
   * The assignment's persisted ingest-scope default. Always present — the
   * column is NOT NULL with a `self_identifying` default — so provgate can read
   * back exactly what it wrote without a second call.
   */
  ingest_scope: IngestScopeConfigSchema,
});
export type AssignmentSummary = z.infer<typeof AssignmentSummarySchema>;

export const AssignmentListResponseSchema = z.object({
  items: z.array(AssignmentSummarySchema),
});
export type AssignmentListResponse = z.infer<typeof AssignmentListResponseSchema>;

// PATCH /semesters/:semesterId/assignments/:assignmentId — PRD §8.5.
// At least one field must be provided; the route handler enforces that since
// Zod's `refine` rejects an empty object as 422.
export const UpdateAssignmentRequestSchema = z
  .object({
    label: z.string().min(1).max(200).optional(),
    sort_order: z.number().int().optional(),
    /** Replaces the persisted ingest-scope default wholesale (not merged). */
    ingest_scope: IngestScopeConfigSchema.optional(),
  })
  .refine(
    (v) => v.label !== undefined || v.sort_order !== undefined || v.ingest_scope !== undefined,
    { message: 'at least one of label, sort_order or ingest_scope is required' },
  );
export type UpdateAssignmentRequest = z.infer<typeof UpdateAssignmentRequestSchema>;

export const UpdateAssignmentResponseSchema = z.object({
  assignment: AssignmentSummarySchema,
});
export type UpdateAssignmentResponse = z.infer<typeof UpdateAssignmentResponseSchema>;

// POST /semesters/:semesterId/assignments — manual assignment creation.
// label is optional; the server defaults a blank label to assignment_id_str.
export const CreateAssignmentRequestSchema = z.object({
  assignment_id_str: z.string().min(1).max(200),
  label: z.string().max(200).optional(),
  /**
   * Declare the ingest-scope default at mapping time. Omitted ⇒ the column
   * default (`self_identifying`), which is how every assignment auto-created by
   * ingest behaves.
   */
  ingest_scope: IngestScopeConfigSchema.optional(),
});
export type CreateAssignmentRequest = z.infer<typeof CreateAssignmentRequestSchema>;

export const CreateAssignmentResponseSchema = z.object({
  assignment: AssignmentSummarySchema,
});
export type CreateAssignmentResponse = z.infer<typeof CreateAssignmentResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 22 — Ingest schemas (PRD §8.6)
// ---------------------------------------------------------------------------

export const MatchedStudentSchema = z.object({
  id: z.string().uuid(),
  sid: z.string(),
  display_name: z.string(),
});
export type MatchedStudent = z.infer<typeof MatchedStudentSchema>;

export const MatchedAssignmentSchema = z.object({
  id: z.string().uuid(),
  assignment_id_str: z.string(),
  label: z.string(),
});
export type MatchedAssignment = z.infer<typeof MatchedAssignmentSchema>;

export const IngestFileSummarySchema = z.object({
  id: z.string().uuid(),
  original_filename: z.string(),
  size_bytes: z.number().int(),
  blob_sha256: z.string(),
  status: z.enum([
    'pending',
    'matched',
    'unmatched',
    'duplicate',
    'failed',
    'superseded',
    'discarded',
  ]),
  matched_student: MatchedStudentSchema.optional(),
  matched_assignment: MatchedAssignmentSchema.optional(),
  submission_id: z.string().uuid().optional(),
  filename_capture: z.record(z.string(), z.string()).optional(),
  error: z
    .object({
      phase: z.string(),
      cause: z.string(),
      detail: z.unknown().optional(),
    })
    .optional(),
});
export type IngestFileSummary = z.infer<typeof IngestFileSummarySchema>;

// ---------------------------------------------------------------------------
// Ingest skip reasons
// ---------------------------------------------------------------------------
//
// Declared here rather than in the Gradescope-upload section below because it
// is shared by both: the single-shot upload response inlines these entries, and
// `IngestJobSchema` (the poll endpoint) serves the same entries back for a job
// created by EITHER upload route. One schema is the mechanism by which the two
// paths are indistinguishable to a consumer.

/**
 * A submission folder — or one assignment scope within it — that could not be
 * processed as a bundle.
 *
 * `bundle_too_large` arises only on the streaming upload / local-path ingest,
 * where bundle sizes are discovered one at a time (the job is already running),
 * so an oversize bundle is skipped-and-reported rather than failing the whole
 * upload up front.
 *
 * The scope reasons come from git-repo submissions, where one cloned repository
 * can hold several `.provenance/` directories (program architecture §6):
 *   - `no_seal` — a `.provenance/` with no `manifest.json`. Nothing runs the
 *     seal command on a git push, so this is the normal state of a git scope
 *     until the recorder's rolling seal ships. Reported per scope so a repo
 *     never disappears from ingest without a record.
 *   - `scope_excluded` — the effective `ingest_scope` did not select this
 *     scope's directory: either `repo_scoped` and `path_glob` did not match, or
 *     `repo_whole`, which ingests only the repo root and excludes every nested
 *     scope by declaration.
 *   - `ambiguous_scope` — `ingest_scope.on_multiple = 'error'` and more than
 *     one scope declared this assignment id.
 *   - `submission_type_mismatch` — the HOMOGENEITY failure. The submission does
 *     not have the shape the batch declared via `ingest_scope.mode`: a
 *     `bundle_zip` batch handed a multi-scope repo, a `repo_whole` batch handed
 *     a repo with no root scope, or a `repo_scoped` batch whose `path_glob`
 *     selected nothing at all. It fails the submission, never the batch, so one
 *     malformed repo cannot block a cohort — a heterogeneous batch simply shows
 *     up as a pile of these entries.
 *
 * `scope_path` is `''` for the folder root (always so on the flat Gradescope
 * path) and a directory prefix such as `proj2/` for a fanned-out scope. Optional
 * rather than defaulted: apiFetch infers its result type from the schema, and a
 * zod default makes input and output diverge — optional keeps a response from a
 * server predating scope fan-out parseable without that split.
 */
export const GradescopeSkippedEntrySchema = z.object({
  folder_key: z.string(),
  scope_path: z.string().optional(),
  reason: z.enum([
    'no_manifest',
    'no_submitters',
    'bundle_too_large',
    'no_seal',
    'scope_excluded',
    'ambiguous_scope',
    'submission_type_mismatch',
  ]),
});
export type GradescopeSkippedEntry = z.infer<typeof GradescopeSkippedEntrySchema>;

export const IngestJobSummarySchema = z.object({
  total: z.number().int(),
  matched: z.number().int(),
  unmatched: z.number().int(),
  duplicate: z.number().int(),
  failed: z.number().int(),
  superseded: z.number().int(),
  discarded: z.number().int(),
});
export type IngestJobSummary = z.infer<typeof IngestJobSummarySchema>;

export const IngestJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);
export type IngestJobStatus = z.infer<typeof IngestJobStatusSchema>;

export const IngestJobSchema = z.object({
  id: z.string().uuid(),
  semester_id: z.string().uuid(),
  status: IngestJobStatusSchema,
  created_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  summary: IngestJobSummarySchema,
  /**
   * Scope-resolution skips for this job — the canonical, upload-mechanism-
   * independent place to read them.
   *
   * `summary` above cannot carry these: it is a count of `ingest_files` rows,
   * and a skipped scope has no row (that is what being skipped means). The
   * single-shot `POST /ingest:gradescope` also inlines the identical array in
   * its own response; the chunked upload route returns 202 before ingest runs
   * and has no way to, so for that path this field is the only channel. Both
   * produce the same entries for the same export.
   *
   * `null` means UNKNOWN, never "nothing was skipped": staging has not finished
   * resolving scopes yet, or it aborted part-way, or the job predates the
   * column. `[]` is a positive statement that resolution completed and skipped
   * nothing. A consumer that wants "did anything get dropped?" must treat
   * `null` as "ask again later", not as a clean result.
   */
  skipped: z.array(GradescopeSkippedEntrySchema).nullable(),
  files: z.array(IngestFileSummarySchema),
});
export type IngestJob = z.infer<typeof IngestJobSchema>;

export const IngestJobListItemSchema = z.object({
  id: z.string().uuid(),
  semester_id: z.string().uuid(),
  status: IngestJobStatusSchema,
  summary: IngestJobSummarySchema.nullable(),
  created_at: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
});
export type IngestJobListItem = z.infer<typeof IngestJobListItemSchema>;

// ---------------------------------------------------------------------------
// Gradescope export ingest (POST /semesters/:id/ingest:gradescope)
// ---------------------------------------------------------------------------

/** Roster rows added vs updated by the export's roster upsert. */
export const RosterUpsertSummarySchema = z.object({
  added: z.number().int(),
  updated: z.number().int(),
});
export type RosterUpsertSummary = z.infer<typeof RosterUpsertSummarySchema>;

/**
 * Response from POST /ingest:gradescope. `job_id` is null when the export has
 * no processable bundles (roster was still upserted). Otherwise it is the
 * enqueued ingest job, with one staged submission per submitter.
 *
 * Shared with `POST /ingest/uploads/:uploadId/complete`, which returns the same
 * shape — and that is why `skipped` is nullable. The single-shot route ingests
 * inside the request and always knows the answer; the chunked route returns 202
 * before any staging has run, so at that instant it does not, and it says
 * `null` rather than `[]`. An empty array here means resolution completed and
 * skipped nothing; `null` means "not known yet — poll
 * `GET /ingest/jobs/:jobId`", which serves the identical entries for a job from
 * either route. The counts alongside it (`roster`, `bundles_processed`,
 * `submissions_queued`) are placeholder zeros on the chunked route for the same
 * reason; they are numbers with no null to spend, so `job_id` is what
 * distinguishes a poll-me response from a finished one.
 */
export const GradescopeIngestResponseSchema = z.object({
  job_id: z.string().uuid().nullable(),
  roster: RosterUpsertSummarySchema,
  bundles_processed: z.number().int(),
  submissions_queued: z.number().int(),
  skipped: z.array(GradescopeSkippedEntrySchema).nullable(),
});
export type GradescopeIngestResponse = z.infer<typeof GradescopeIngestResponseSchema>;

// ---------------------------------------------------------------------------
// Resumable (chunked) Gradescope upload
// (POST   /semesters/:id/ingest/uploads            — create)
// (PUT    /semesters/:id/ingest/uploads/:uid/parts/:n?s3_upload_id=… — upload part)
// (GET    /semesters/:id/ingest/uploads/:uid/parts?s3_upload_id=…    — resume status)
// (POST   /semesters/:id/ingest/uploads/:uid/complete — complete + ingest)
// (DELETE /semesters/:id/ingest/uploads/:uid?s3_upload_id=…          — abort)
// ---------------------------------------------------------------------------

/** Begin a resumable upload. `chunk_size` is a hint; the server may clamp it. */
export const CreateUploadRequestSchema = z.object({
  filename: z.string().min(1),
  total_bytes: z.number().int().positive(),
  chunk_size: z.number().int().positive().optional(),
});
export type CreateUploadRequest = z.infer<typeof CreateUploadRequestSchema>;

/**
 * Created-upload handle. The client uploads parts 1..total_parts of
 * `chunk_size` bytes each (the last part may be smaller), echoing `s3_upload_id`
 * on every subsequent request.
 */
export const CreateUploadResponseSchema = z.object({
  upload_id: z.string().uuid(),
  s3_upload_id: z.string(),
  chunk_size: z.number().int().positive(),
  total_parts: z.number().int().positive(),
});
export type CreateUploadResponse = z.infer<typeof CreateUploadResponseSchema>;

/**
 * Finalize a resumable upload and ingest it.
 *
 * `ingest_scope` is the PER-REQUEST OVERRIDE: when present it replaces the
 * per-assignment `assignments.ingest_scope` default for every submission in
 * this batch, which is what makes a one-off re-ingest or a fixup possible
 * without mutating the assignment. Omitted ⇒ each scope uses its declared
 * assignment's persisted default, exactly as before this field existed.
 *
 * The override rides the `ingest_stage_upload` pg-boss payload, so it survives
 * the request returning 202 before the staging work runs.
 */
export const FinalizeUploadRequestSchema = z.object({
  s3_upload_id: z.string().min(1),
  ingest_scope: IngestScopeConfigSchema.optional(),
});
export type FinalizeUploadRequest = z.infer<typeof FinalizeUploadRequestSchema>;

/**
 * Per-request ingest-scope override for `POST /ingest:gradescope`, whose body
 * is `multipart/form-data` reserved for the export archive — so the override
 * travels as flat QUERY PARAMETERS instead of a nested JSON object.
 *
 * The three params map one-to-one onto `IngestScopeConfigSchema`:
 *   ?scope_mode=repo_scoped&scope_path_glob=proj2/**&scope_on_multiple=error
 *
 * All absent ⇒ no override; each scope uses its assignment's persisted default.
 * `scope_mode` is the trigger: supplying only `scope_path_glob` is a validation
 * error rather than a silently-ignored parameter, because a typo'd override
 * that quietly does nothing is exactly the failure this feature exists to stop.
 */
export const IngestScopeOverrideQuerySchema = z
  .object({
    scope_mode: z.enum(['self_identifying', 'bundle_zip', 'repo_whole', 'repo_scoped']).optional(),
    scope_path_glob: z.string().min(1).max(500).optional(),
    scope_on_multiple: z.enum(['error', 'ingest_all']).optional(),
  })
  .refine(
    (v) =>
      v.scope_mode !== undefined ||
      (v.scope_path_glob === undefined && v.scope_on_multiple === undefined),
    { message: 'scope_mode is required when any scope_* override parameter is given' },
  );
export type IngestScopeOverrideQuery = z.infer<typeof IngestScopeOverrideQuerySchema>;

/**
 * Fold the flat query form into the canonical object, or `undefined` when no
 * override was requested. Shared so the route and its tests cannot disagree
 * about what a given query string means.
 */
export function ingestScopeFromQuery(q: IngestScopeOverrideQuery): IngestScopeConfig | undefined {
  if (q.scope_mode === undefined) return undefined;
  return IngestScopeConfigSchema.parse({
    mode: q.scope_mode,
    ...(q.scope_path_glob !== undefined ? { path_glob: q.scope_path_glob } : {}),
    // The query form may omit it; the canonical object may not. `ingest_all` is
    // the same fallback `parseIngestScopeConfig` applies to stored jsonb.
    on_multiple: q.scope_on_multiple ?? 'ingest_all',
  });
}

/** Part numbers (1-based) already received — used to resume after an interruption. */
export const UploadStatusResponseSchema = z.object({
  received_parts: z.array(z.number().int().positive()),
});
export type UploadStatusResponse = z.infer<typeof UploadStatusResponseSchema>;

/** Acknowledgement for a single uploaded part. */
export const UploadPartResponseSchema = z.object({
  part_number: z.number().int().positive(),
  received: z.literal(true),
});
export type UploadPartResponse = z.infer<typeof UploadPartResponseSchema>;

export const IngestJobListResponseSchema = z.object({
  items: z.array(IngestJobListItemSchema),
  next_cursor: z.string().nullable(),
});
export type IngestJobListResponse = z.infer<typeof IngestJobListResponseSchema>;

export const IngestFileListResponseSchema = z.object({
  items: z.array(IngestFileSummarySchema),
  next_cursor: z.string().nullable(),
});
export type IngestFileListResponse = z.infer<typeof IngestFileListResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 22 — Roster schemas (PRD §8.4)
// ---------------------------------------------------------------------------

export const RosterEntrySchema = z.object({
  id: z.string().uuid(),
  sid: z.string(),
  display_name: z.string(),
  email: z.string().nullable(),
  extras: z.record(z.string(), z.string()).nullable(),
});
export type RosterEntry = z.infer<typeof RosterEntrySchema>;

export const RosterListResponseSchema = z.object({
  entries: z.array(RosterEntrySchema),
  next_cursor: z.string().nullable(),
  total_count: z.number().int(),
});
export type RosterListResponse = z.infer<typeof RosterListResponseSchema>;

export const RosterDiffSchema = z.object({
  upload_id: z.string().uuid(),
  parsed_rows: z.number().int(),
  to_add: z.number().int(),
  to_update: z.number().int(),
  to_delete: z.number().int(),
  errors: z.array(z.object({ row: z.number().int().optional(), message: z.string() })),
});
export type RosterDiff = z.infer<typeof RosterDiffSchema>;

export const RosterCommitResultSchema = z.object({
  added: z.number().int(),
  updated: z.number().int(),
  deleted: z.number().int(),
});
export type RosterCommitResult = z.infer<typeof RosterCommitResultSchema>;

// ---------------------------------------------------------------------------
// Phase 22 — Assignment detail schema (PRD §8.5)
// ---------------------------------------------------------------------------

export const AssignmentDetailSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  sort_order: z.number().int(),
});
export type AssignmentDetail = z.infer<typeof AssignmentDetailSchema>;

// ---------------------------------------------------------------------------
// Phase 22 — Members/invitation schemas (PRD §8.3)
// ---------------------------------------------------------------------------

export const MemberSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string(),
  display_name: z.string().nullable(),
  role: z.enum(['admin', 'grader']),
  granted_at: z.string(),
  granted_by_email: z.string().nullable(),
});
export type Member = z.infer<typeof MemberSchema>;

export const InvitationSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  role: z.enum(['admin', 'grader']),
  invited_at: z.string(),
  invited_by_email: z.string().nullable(),
});
export type Invitation = z.infer<typeof InvitationSchema>;

export const MembersListResponseSchema = z.object({
  members: z.array(MemberSchema),
  pending: z.array(InvitationSchema),
});
export type MembersListResponse = z.infer<typeof MembersListResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 22 — Semester detail schema
// ---------------------------------------------------------------------------

export const SemesterDetailSchema = z.object({
  id: z.string().uuid(),
  course_id: z.string().uuid(),
  slug: z.string(),
  term: z.string(),
  year: z.number().int(),
  display_name: z.string(),
  filename_convention: z.string(),
  blob_retention_days: z.number().int(),
  derived_retention_days: z.number().int(),
  archived: z.boolean(),
  my_role: z.enum(['admin', 'grader']).nullable(),
  created_at: z.string(),
});
export type SemesterDetail = z.infer<typeof SemesterDetailSchema>;

export const SemesterDetailResponseSchema = z.object({
  semester: SemesterDetailSchema,
});
export type SemesterDetailResponse = z.infer<typeof SemesterDetailResponseSchema>;

// ---------------------------------------------------------------------------
// Unmatched list response schema (PRD §8.7)
// ---------------------------------------------------------------------------

export const UnmatchedListResponseSchema = z.object({
  items: z.array(IngestFileSummarySchema),
  next_cursor: z.string().nullable(),
});
export type UnmatchedListResponse = z.infer<typeof UnmatchedListResponseSchema>;

export const FlagRowSchema = z.object({
  id: z.string().uuid(),
  heuristic_id: z.string(),
  severity: z.enum(['info', 'low', 'medium', 'high']),
  confidence: z.number(),
  score_contribution: z.number(),
  /**
   * Per-instance prose generated by the heuristic ("Large paste in hw.py").
   * Optional, and empty rather than absent on flags stored before server
   * migration 0020 — so consumers must treat '' and undefined alike and fall
   * back to heuristic_id.
   */
  title: z.string().optional(),
  description: z.string().optional(),
  detail: z.unknown().nullable(),
  /**
   * globalIdx values, session-agnostic and unique across the whole submission.
   * These — not `session_id` — are what a supporting event is resolved by, so
   * resolution stays correct for flags whose evidence spans several sessions.
   */
  supporting_seqs: z.array(z.number().int()).optional(),
  /**
   * The single session all supporting_seqs belong to, or '' when they span
   * more than one. Display only; never use it to resolve a supporting seq.
   */
  session_id: z.string().optional(),
});
export type FlagRow = z.infer<typeof FlagRowSchema>;

export const CrossFlagSummarySchema = z.object({
  id: z.string().uuid(),
  heuristic_id: z.string(),
  severity: z.enum(['info', 'low', 'medium', 'high']),
  participant_count: z.number().int(),
  created_at: z.string().datetime(),
});
export type CrossFlagSummary = z.infer<typeof CrossFlagSummarySchema>;

/**
 * The assignment manifest carried inside the submission's bundle (program spec
 * §3, Manifest 2.0).
 *
 * Every field is nullable or defaulted so a 1.0/1.1 submission — which carries
 * no manifest inside the bundle at all — round-trips as the "nothing recorded"
 * shape rather than as an error. `disabled_signals` is the load-bearing one for
 * staff: it says which capture signals are absent by COURSE POLICY rather than
 * by student omission, which is the difference between "they never opened a
 * terminal" and "this course does not record terminals".
 */
export const AssignmentManifestSchema = z.object({
  /** '1.x' for every pre-2.0 bundle — 1.0 and 1.1 are indistinguishable from inside. */
  format_version: z.enum(['1.x', '2.0']),
  course_id: z.string().nullable(),
  collaboration: z.enum(['solo', 'group']).nullable(),
  submission: z.enum(['bundle', 'git']).nullable(),
  scope: z.enum(['directory', 'repo']).nullable(),
  /**
   * Gated capture signals the course switched off. Empty for 1.x — and empty
   * whenever `trust_chain` is not `'verified'`: an unverified policy is not
   * honoured, because `policy` arrives from a file the student can edit. When a
   * refused policy asked for signals to be disabled, `trust_chain_detail` says so.
   */
  disabled_signals: z.array(z.enum(['selection_change', 'focus_change', 'terminal'])),
  heartbeat_interval_ms: z.number().int(),
  /**
   * The root-signed course certificate. `in_window` is evaluated against the
   * manifest's `issued_at`, never wall-clock now: a Fall 2026 bundle must still
   * verify in 2028 for an adjudication case.
   */
  cert: z
    .object({
      course_id: z.string(),
      course_pubkey: z.string(),
      valid_from: z.string(),
      valid_until: z.string(),
      in_window: z.boolean(),
      window_reason: z.string().nullable(),
    })
    .nullable(),
  /**
   * 'legacy' — a 1.x bundle, no chain to walk.
   * 'unconfigured' — a 2.0 bundle, but the server has no root public key set.
   * 'verified' / 'invalid' — the chain was walked.
   */
  trust_chain: z.enum(['legacy', 'unconfigured', 'verified', 'invalid']),
  /**
   * Why the chain is not `'verified'`, and — when the unverified manifest asked
   * for capture signals to be switched off — that the request was refused.
   */
  trust_chain_detail: z.string().nullable(),
});
export type AssignmentManifest = z.infer<typeof AssignmentManifestSchema>;

export const SubmissionSummarySchema = z.object({
  id: z.string().uuid(),
  student: z.object({
    sid: z.string(),
    display_name: z.string(),
  }),
  assignment: z.object({
    assignment_id_str: z.string(),
    label: z.string().nullable(),
  }),
  version_index: z.number().int(),
  score_total: z.number().nullable(),
  score_max_severity: z.string().nullable(),
  validation_status: z.string().nullable(),
  validation_overall_detail: z.string().nullable(),
  heuristic_config_version: z.number().int(),
  flag_count: z.number().int(),
  ingested_at: z.string().datetime(),
  source_filename: z.string().optional(),
  session_ids: z.array(z.string()).optional(),
  /**
   * Per-session metadata in bundle (chronological) order. Derived from the same
   * loadSubmissionIndex call that produces session_ids, so it costs nothing
   * extra server-side and saves the client from paging the whole event stream
   * just to label its sessions.
   */
  sessions: z
    .array(
      z.object({
        session_id: z.string(),
        /** Wall clock of the session's first event; null if it has none. */
        started_at: z.string().datetime().nullable(),
        event_count: z.number().int(),
      }),
    )
    .optional(),
  /**
   * Manifest 2.0 metadata read out of the bundle. Optional so a client talking
   * to a server that predates it keeps parsing; absent is read the same as a
   * 1.x manifest.
   */
  assignment_manifest: AssignmentManifestSchema.optional(),
});
export type SubmissionSummary = z.infer<typeof SubmissionSummarySchema>;

export const EventRowSchema = z.object({
  seq: z.number().int(),
  kind: z.string(),
  t: z.number(),
  wall: z.string().datetime(),
  session_id: z.string(),
  payload: z.unknown(),
});
export type EventRow = z.infer<typeof EventRowSchema>;

// ---------------------------------------------------------------------------
// Phase 24 — Heuristic config schemas (PRD §8.11)
// ---------------------------------------------------------------------------

export const PerFlagConfigSchema = z.object({
  enabled: z.boolean(),
  weight: z.number(),
});
export type PerFlagConfig = z.infer<typeof PerFlagConfigSchema>;

export const HeuristicConfigBodySchema = z.object({
  per_flag: z.record(z.string(), PerFlagConfigSchema),
  severity_weights: z.object({
    info: z.number(),
    low: z.number(),
    medium: z.number(),
    high: z.number(),
  }),
  config_format_version: z.literal(1),
});
export type HeuristicConfigBody = z.infer<typeof HeuristicConfigBodySchema>;

export const HeuristicConfigSchema = z.object({
  id: z.string().uuid().nullable(),
  version: z.number().int(),
  config: HeuristicConfigBodySchema,
  set_at: z.string().datetime().nullable(),
  note: z.string().nullable(),
  is_active: z.boolean(),
});
export type HeuristicConfig = z.infer<typeof HeuristicConfigSchema>;

export const HeuristicConfigVersionSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int(),
  set_at: z.string().datetime(),
  set_by: z.string().uuid(),
  note: z.string().nullable(),
  is_active: z.boolean(),
});
export type HeuristicConfigVersion = z.infer<typeof HeuristicConfigVersionSchema>;

export const HeuristicConfigHistoryResponseSchema = z.object({
  configs: z.array(HeuristicConfigVersionSchema),
});
export type HeuristicConfigHistoryResponse = z.infer<typeof HeuristicConfigHistoryResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 24 — Dry-run diff schema (PRD §8.11)
// ---------------------------------------------------------------------------

export const TopMoverSchema = z.object({
  submission_id: z.string().uuid(),
  student: z.object({
    sid: z.string(),
    display_name: z.string(),
  }),
  assignment: z.object({
    assignment_id_str: z.string(),
    label: z.string().nullable(),
  }),
  old_score: z.number(),
  new_score: z.number(),
  old_tier: z.string().nullable(),
  new_tier: z.string().nullable(),
});
export type TopMover = z.infer<typeof TopMoverSchema>;

export const DryRunDiffSchema = z.object({
  candidate_version: z.number().int(),
  diff: z.object({
    submissions_with_tier_change: z.number().int(),
    top_movers: z.array(TopMoverSchema),
    score_histogram_old: z.array(z.number()),
    score_histogram_new: z.array(z.number()),
    /**
     * Exclusive upper bound for the highest bucket. Each of the 10 buckets is
     * `score_histogram_upper_bound / 10` wide; bucket i covers
     * `[i * width, (i+1) * width)` (the top bucket is inclusive of the upper
     * bound so scores at exactly upper_bound are still counted).
     */
    score_histogram_upper_bound: z.number(),
  }),
});
export type DryRunDiff = z.infer<typeof DryRunDiffSchema>;

// ---------------------------------------------------------------------------
// Phase 24 — Recompute job schema (PRD §5.5)
// ---------------------------------------------------------------------------

export const RecomputeJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'cancelled',
]);
export type RecomputeJobStatus = z.infer<typeof RecomputeJobStatusSchema>;

export const RecomputeJobSchema = z.object({
  id: z.string().uuid(),
  semester_id: z.string().uuid(),
  target_config_id: z.string().uuid().nullable(),
  triggered_by: z.string().uuid().nullable(),
  status: RecomputeJobStatusSchema,
  progress_total: z.number().int().nullable(),
  progress_done: z.number().int().nullable(),
  progress_failed: z.number().int().nullable(),
  created_at: z.string().datetime(),
  started_at: z.string().datetime().nullable(),
  completed_at: z.string().datetime().nullable(),
  summary: z.unknown().nullable(),
});
export type RecomputeJob = z.infer<typeof RecomputeJobSchema>;

export const CommitConfigResponseSchema = z.object({
  new_config: z.object({
    id: z.string().uuid(),
    version: z.number().int(),
    set_at: z.string().datetime(),
    note: z.string(),
    is_active: z.boolean(),
  }),
  recompute_job: z.object({
    id: z.string().uuid(),
    status: z.string(),
  }),
});
export type CommitConfigResponse = z.infer<typeof CommitConfigResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 24 — Cross-flag schemas (PRD §8.10)
// ---------------------------------------------------------------------------

export const CrossFlagParticipantSchema = z.object({
  submission_id: z.string().uuid(),
  student: z.object({
    id: z.string().uuid(),
    sid: z.string(),
    display_name: z.string(),
  }),
  assignment: z.object({
    id: z.string().uuid(),
    assignment_id_str: z.string(),
  }),
  supporting_seqs: z.array(z.number().int()),
});
export type CrossFlagParticipant = z.infer<typeof CrossFlagParticipantSchema>;

export const CrossFlagDetailItemSchema = z.object({
  id: z.string().uuid(),
  heuristic_id: z.string(),
  severity: SeveritySchema,
  confidence: z.number(),
  detail: z.unknown().nullable(),
  participants: z.array(CrossFlagParticipantSchema),
  created_at: z.string().datetime(),
});
export type CrossFlagDetailItem = z.infer<typeof CrossFlagDetailItemSchema>;

export const CrossFlagListResponseSchema = z.object({
  items: z.array(CrossFlagDetailItemSchema),
  next_cursor: z.string().nullable(),
});
export type CrossFlagListResponse = z.infer<typeof CrossFlagListResponseSchema>;

export const CrossFlagDetailResponseSchema = z.object({
  item: CrossFlagDetailItemSchema,
});
export type CrossFlagDetailResponse = z.infer<typeof CrossFlagDetailResponseSchema>;

// ---------------------------------------------------------------------------
// Phase 24 — Export artifact schema (PRD §8.9)
//
// V46: PDF export deferred to v3.1 (Puppeteer is a separate operational
// decision). The async/polling branch and discriminated union were removed
// because nothing currently consumes them; restore them when the v3.1
// server endpoint lands.
// ---------------------------------------------------------------------------

export const ExportSyncResponseSchema = z.object({
  artifact_id: z.string().uuid(),
  format: z.enum(['markdown']),
  expires_at: z.string().datetime(),
  download_url: z.string(),
});
export type ExportSyncResponse = z.infer<typeof ExportSyncResponseSchema>;

// ---------------------------------------------------------------------------
// v3.1 — Personal access token management (PRD §8.12)
//
// GET    /me/tokens         → { tokens: TokenSummary[] }
// POST   /me/tokens         → 201 { token: TokenSummary, secret: string }
// DELETE /me/tokens/{id}    → 204
//
// Server passes `scopes` through as JSON; the schema below pins the same
// shape as TokenScopesSchema (read_only, semester_ids, include_blobs).
// ---------------------------------------------------------------------------

/**
 * Resolved scopes shape used on the response side — same fields as
 * TokenScopesSchema but without `.default()` so the inferred type has required
 * (non-optional) fields. The server always emits a fully resolved scopes
 * object on token reads, so consumers don't need to handle the partial form.
 */
export const ResolvedTokenScopesSchema = z.object({
  read_only: z.boolean(),
  semester_ids: z.array(z.string().uuid()).nullable(),
  include_blobs: z.boolean(),
});
export type ResolvedTokenScopes = z.infer<typeof ResolvedTokenScopesSchema>;

export const TokenSummarySchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  prefix: z.string(),
  scopes: ResolvedTokenScopesSchema,
  last_used_at: z.string().datetime().nullable(),
  expires_at: z.string().datetime().nullable(),
  revoked_at: z.string().datetime().nullable(),
  created_at: z.string().datetime(),
});
export type TokenSummary = z.infer<typeof TokenSummarySchema>;

export const TokensListResponseSchema = z.object({
  tokens: z.array(TokenSummarySchema),
});
export type TokensListResponse = z.infer<typeof TokensListResponseSchema>;

export const CreateTokenRequestSchema = z.object({
  label: z.string().min(1).max(64),
  scopes: TokenScopesSchema.optional(),
  expires_at: z.string().datetime().optional(),
});
export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;

export const CreateTokenResponseSchema = z.object({
  token: TokenSummarySchema,
  secret: z.string(),
});
export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;

// ---------------------------------------------------------------------------
// V45 — Superadmin /admin surface
//
// GET    /admin/users               — { items, next_cursor }
// GET    /admin/users/{userId}      — { user, memberships }
// DELETE /admin/users/{userId}      — 204
// POST   /admin/view-as             — { user_id } → 200 { ok: true }
// POST   /admin/view-as/exit        — 204
// Course/semester management uses the existing /courses + /semesters routes.
// ---------------------------------------------------------------------------

export const AdminUserSummarySchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  display_name: z.string().nullable(),
  is_superadmin: z.boolean(),
  protected: z.boolean(),
  created_at: z.string().datetime(),
  last_login_at: z.string().datetime().nullable(),
});
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

export const AdminUserListResponseSchema = z.object({
  items: z.array(AdminUserSummarySchema),
  next_cursor: z.string().nullable(),
});
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;

export const AdminUserDetailResponseSchema = z.object({
  user: AdminUserSummarySchema,
  memberships: z.array(MembershipSchema),
});
export type AdminUserDetailResponse = z.infer<typeof AdminUserDetailResponseSchema>;

export const ViewAsRequestSchema = z.object({
  user_id: z.string().uuid(),
});
export type ViewAsRequest = z.infer<typeof ViewAsRequestSchema>;

// ---------------------------------------------------------------------------
// V45 — Course / semester management schemas (mirror server schemas/structure.ts)
//
// These were previously server-only because no UI consumed them. The /admin
// sub-app surfaces them now. Kept narrow — only the fields the admin pages
// actually render or post.
// ---------------------------------------------------------------------------

export const CourseSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  archived: z.boolean(),
  semesters_count: z.number().int().nonnegative(),
});
export type CourseSummary = z.infer<typeof CourseSummarySchema>;

export const CourseListResponseSchema = z.object({
  courses: z.array(CourseSummarySchema),
});
export type CourseListResponse = z.infer<typeof CourseListResponseSchema>;

export const CreateCourseRequestSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
});
export type CreateCourseRequest = z.infer<typeof CreateCourseRequestSchema>;

export const SemesterAdminSummarySchema = z.object({
  id: z.string().uuid(),
  course_id: z.string().uuid(),
  slug: z.string(),
  term: z.string(),
  year: z.number().int(),
  display_name: z.string(),
  archived: z.boolean(),
  submission_count: z.number().int().nonnegative(),
  student_count: z.number().int().nonnegative(),
  assignment_count: z.number().int().nonnegative(),
  active_config_version: z.number().int().nonnegative(),
  my_role: z.enum(['admin', 'grader']).nullable(),
});
export type SemesterAdminSummary = z.infer<typeof SemesterAdminSummarySchema>;

export const SemesterListResponseSchema = z.object({
  semesters: z.array(SemesterAdminSummarySchema),
});
export type SemesterListResponse = z.infer<typeof SemesterListResponseSchema>;

export const CreateSemesterRequestSchema = z.object({
  term: z.enum(['fa', 'sp', 'su', 'wi']),
  year: z.number().int().min(2000).max(2100),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  display_name: z.string().min(1).max(255),
  filename_convention: z.string().min(1).max(500),
  blob_retention_days: z.number().int().min(30).optional(),
  derived_retention_days: z.number().int().optional(),
});
export type CreateSemesterRequest = z.infer<typeof CreateSemesterRequestSchema>;

// ---------------------------------------------------------------------------
// V45 — Audit log row schema for the admin audit page.
// ---------------------------------------------------------------------------

export const AuditLogRowSchema = z.object({
  // audit_log.id is a bigserial (sequential integer), not a UUID. Drizzle's
  // mode:'number' returns it as a JS number. The cursor encoding in audit.ts
  // also uses the numeric id directly. If row counts ever approach the JS
  // safe-integer limit (2^53) we'll switch to z.union([z.number(), z.string()])
  // and have drizzle hand back a bigint string, but at our cadence that's
  // never going to be the binding constraint.
  id: z.number().int(),
  actor_user_id: z.string().uuid().nullable(),
  actor_token_id: z.string().uuid().nullable(),
  semester_id: z.string().uuid().nullable(),
  action: z.string(),
  target_type: z.string(),
  target_id: z.string(),
  detail: z.unknown(),
  at: z.string().datetime(),
});
export type AuditLogRow = z.infer<typeof AuditLogRowSchema>;

export const AuditListResponseSchema = z.object({
  items: z.array(AuditLogRowSchema),
  next_cursor: z.string().nullable(),
});
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;

// ---------------------------------------------------------------------------
// Submission bundle — submitted files (Group E / Task F1)
// ---------------------------------------------------------------------------

export const SubmittedFileEntrySchema = z.object({
  path: z.string(),
  status: z.enum(['present', 'missing']),
  verdict: z.enum(['match', 'mismatch', 'unknown']),
  sha256: z.string().nullable(),
});
export type SubmittedFileEntry = z.infer<typeof SubmittedFileEntrySchema>;

export const SubmittedFileListSchema = z.object({
  available: z.boolean(),
  files: z.array(SubmittedFileEntrySchema),
});
export type SubmittedFileList = z.infer<typeof SubmittedFileListSchema>;

export const SubmittedFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  status: z.enum(['present', 'missing']),
  verdict: z.enum(['match', 'mismatch', 'unknown']),
});
export type SubmittedFileContent = z.infer<typeof SubmittedFileContentSchema>;

// ---------------------------------------------------------------------------
// Student enrollment (program spec §5a — S2 identity chain)
// ---------------------------------------------------------------------------

/**
 * The student's per-course ed25519 PUBLIC key, printed by the recorder's
 * enrollment command. 64 lowercase hex characters.
 *
 * Only the public half is ever transmitted: the master secret it is derived
 * from, and the per-course private key, never leave the student's machine.
 */
export const StudentPubkeySchema = z.string().regex(/^[0-9a-f]{64}$/);

export const EnrollmentRequestSchema = z.object({
  student_pubkey: StudentPubkeySchema,
});
export type EnrollmentRequest = z.infer<typeof EnrollmentRequestSchema>;

/**
 * A course-signed authorization for the server's enrollment key. Mirrors
 * `EnrollmentCert` in `@provenance/log-core`; redeclared here because the HTTP
 * contract is validated with Zod at the boundary and must not depend on
 * log-core's structural types.
 */
export const EnrollmentCertSchema = z.object({
  format_version: z.string(),
  course_id: z.string(),
  enrollment_pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  valid_from: z.string(),
  valid_until: z.string(),
  course_sig: z.string().regex(/^[0-9a-f]{128}$/),
});
export type EnrollmentCertPayload = z.infer<typeof EnrollmentCertSchema>;

/** An enrollment-signed statement binding a student public key to a roster identity. */
export const EnrollmentTokenSchema = z.object({
  format_version: z.string(),
  /** Opaque roster reference. Never an SID, name, or email. */
  student_ref: z.string(),
  course_id: z.string(),
  student_pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  issued_at: z.string(),
  expires_at: z.string(),
  enrollment_sig: z.string().regex(/^[0-9a-f]{128}$/),
});
export type EnrollmentTokenPayload = z.infer<typeof EnrollmentTokenSchema>;

/**
 * What the student pastes back into the recorder.
 *
 * `enrollment` and `enrollment_cert` together are two of the three fields of
 * `session.start.identity`; the recorder supplies the third
 * (`session_pubkey_sig`) itself at session start. The certificate travels
 * BESIDE the token rather than inside it for the same reason `course_cert`
 * travels inside a manifest: an issuer does not sign its own authorization,
 * and one bundled blob cannot be separated from what it authorizes.
 */
export const EnrollmentResponseSchema = z.object({
  enrollment: EnrollmentTokenSchema,
  enrollment_cert: EnrollmentCertSchema,
  /** Echoed for display; always equal to `enrollment.course_id`. */
  course_id: z.string(),
  /** Echoed for display; always equal to `enrollment.student_ref`. */
  student_ref: z.string(),
  /**
   * True when this public key had already been enrolled and the server simply
   * re-issued for it — the "second machine, same master secret" case.
   */
  reissued: z.boolean(),
});
export type EnrollmentResponse = z.infer<typeof EnrollmentResponseSchema>;

// ---------------------------------------------------------------------------
// Student credentials (identity format_version 2.1 — institution-scoped)
// ---------------------------------------------------------------------------

/**
 * A ROOT-signed authorization for the server's institution key. Mirrors
 * `InstitutionCert` in `@provenance/log-core`; redeclared here because the HTTP
 * contract is validated with Zod at the boundary and must not depend on
 * log-core's structural types.
 */
export const InstitutionCertSchema = z.object({
  format_version: z.string(),
  institution_id: z.string(),
  institution_pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  valid_from: z.string(),
  valid_until: z.string(),
  root_sig: z.string().regex(/^[0-9a-f]{128}$/),
});
export type InstitutionCertPayload = z.infer<typeof InstitutionCertSchema>;

/**
 * An institution-signed statement binding a student public key to a global
 * opaque `student_ref`.
 *
 * Names no course, no semester, and no assignment — deliberately. Course
 * membership is a roster question the server answers later against data it
 * owns; making it a precondition of having an identity is what deadlocked the
 * 2.0 design.
 */
export const StudentCredentialSchema = z.object({
  format_version: z.string(),
  institution_id: z.string(),
  /** Opaque GLOBAL reference. Never an SID, name, or email. One per student. */
  student_ref: z.string(),
  student_pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  issued_at: z.string(),
  expires_at: z.string(),
  institution_sig: z.string().regex(/^[0-9a-f]{128}$/),
});
export type StudentCredentialPayload = z.infer<typeof StudentCredentialSchema>;

/**
 * What the student pastes back into the recorder, at identity 2.1.
 *
 * `credential` and `institution_cert` together are two of the three fields of
 * `session.start.identity`; the recorder supplies the third
 * (`session_pubkey_sig`) itself at session start. The certificate travels
 * BESIDE the credential rather than inside it for the same reason `course_cert`
 * travels inside a manifest: an issuer does not sign its own authorization.
 */
export const StudentCredentialResponseSchema = z.object({
  credential: StudentCredentialSchema,
  institution_cert: InstitutionCertSchema,
  /** Echoed for display; always equal to `credential.institution_id`. */
  institution_id: z.string(),
  /** Echoed for display; always equal to `credential.student_ref`. */
  student_ref: z.string(),
  /**
   * True when this account had already been issued a credential and the server
   * re-issued for it. The previously issued credential is NOT invalidated — it
   * stays valid until its own signed `expires_at`.
   *
   * On its own this says nothing a student should worry about: enrolling again
   * is how a second machine is set up. Prefer `machine_count` and
   * `key_first_issued` for anything shown to a student — they distinguish "you
   * just added a machine" from "you asked this machine for another credential",
   * which is the distinction that makes the page readable.
   */
  reissued: z.boolean(),
  /**
   * How many DISTINCT public keys have ever been issued to this student,
   * counting the one just issued. Each machine derives its own keypair from its
   * own master secret, so this is the number of machines the student has
   * enrolled. Always ≥ 1.
   *
   * Only ever counts keys the server actually recorded. A deployment that
   * upgraded through migration 0026 has no record of keys overwritten before
   * it, so this can under-count for long-standing accounts.
   */
  machine_count: z.number().int().min(1),
  /**
   * True when the key just issued had never been issued to this student
   * before — a new machine — as opposed to a machine that already had a
   * credential asking for a fresh one.
   */
  key_first_issued: z.boolean(),
});
export type StudentCredentialResponse = z.infer<typeof StudentCredentialResponseSchema>;

/** The request body: the student's single long-lived ed25519 PUBLIC key. */
export const StudentCredentialRequestSchema = z.object({
  student_pubkey: StudentPubkeySchema,
});
export type StudentCredentialRequest = z.infer<typeof StudentCredentialRequestSchema>;
