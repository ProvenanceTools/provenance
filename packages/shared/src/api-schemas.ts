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
  })
  .refine((v) => v.label !== undefined || v.sort_order !== undefined, {
    message: 'at least one of label or sort_order is required',
  });
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
 *   - `scope_excluded` — the assignment's `ingest_scope.path_glob` did not
 *     match this scope's directory.
 *   - `ambiguous_scope` — `ingest_scope.on_multiple = 'error'` and more than
 *     one scope declared this assignment id.
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
  ]),
});
export type GradescopeSkippedEntry = z.infer<typeof GradescopeSkippedEntrySchema>;

/**
 * Response from POST /ingest:gradescope. `job_id` is null when the export has
 * no processable bundles (roster was still upserted). Otherwise it is the
 * enqueued ingest job, with one staged submission per submitter.
 */
export const GradescopeIngestResponseSchema = z.object({
  job_id: z.string().uuid().nullable(),
  roster: RosterUpsertSummarySchema,
  bundles_processed: z.number().int(),
  submissions_queued: z.number().int(),
  skipped: z.array(GradescopeSkippedEntrySchema),
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
