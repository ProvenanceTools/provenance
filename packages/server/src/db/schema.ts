/**
 * Drizzle ORM table definitions for Provenance Analyzer v3.
 *
 * Schema follows PRD §5.1 (identity & structure) and §4.2 (sessions) exactly.
 *
 * Design notes:
 * - Enums (role, term) are text columns with CHECK constraints — NOT Postgres enum
 *   types. This matches the PRD §5.1 explicit note and avoids DDL pain when
 *   adding values.
 * - gen_random_uuid() is built into Postgres 16 (no extension needed).
 * - Functional indexes (LOWER(email), LOWER(email) + semester_id) and the partial
 *   unique index on pending_invitations are defined in the migration SQL directly
 *   since drizzle-kit cannot generate those expressions fully. The schema file
 *   carries column-level unique constraints where Drizzle supports them; the
 *   expression-based indexes are in 0001_init.sql.
 */

import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  integer,
  smallint,
  index,
  primaryKey,
  inet,
  check,
  unique,
  jsonb,
  bigint,
  bigserial,
  doublePrecision,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// users  (PRD §5.1)
// ---------------------------------------------------------------------------

export const users = pgTable(
  'users',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    google_subject: text('google_subject').notNull().unique(),
    email: text('email').notNull(),
    display_name: text('display_name').notNull().default(''),
    is_superadmin: boolean('is_superadmin').notNull().default(false),
    protected: boolean('protected').notNull().default(false),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    last_login_at: timestamp('last_login_at', { withTimezone: true }),
  },
  // users_email_lower_idx is a functional index (LOWER(email)) and is defined
  // in the migration SQL; Drizzle cannot express functional indexes in the schema.
);

// ---------------------------------------------------------------------------
// sessions  (PRD §4.2)
// ---------------------------------------------------------------------------

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    ip: inet('ip'),
    user_agent: text('user_agent'),
    // View-as (V45): superadmin-only read-only impersonation. Both columns are
    // null when not active. view_as_user_id uses ON DELETE SET NULL so deleting
    // the target user gracefully exits view-as for any sticky session.
    view_as_user_id: uuid('view_as_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    view_as_started_at: timestamp('view_as_started_at', { withTimezone: true }),
  },
  (t) => [
    index('sessions_user_id_idx').on(t.user_id),
    index('sessions_expires_at_idx').on(t.expires_at),
  ],
);

// ---------------------------------------------------------------------------
// courses  (PRD §5.1)
// ---------------------------------------------------------------------------

export const courses = pgTable('courses', {
  id: uuid('id')
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  created_at: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  archived_at: timestamp('archived_at', { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// semesters  (PRD §5.1)
// ---------------------------------------------------------------------------

export const semesters = pgTable(
  'semesters',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    course_id: uuid('course_id')
      .notNull()
      .references(() => courses.id, { onDelete: 'restrict' }),
    term: text('term').notNull(),
    year: integer('year').notNull(),
    slug: text('slug').notNull(),
    display_name: text('display_name').notNull(),
    filename_convention: text('filename_convention').notNull(),
    blob_retention_days: integer('blob_retention_days').notNull().default(540),
    derived_retention_days: integer('derived_retention_days').notNull().default(1825),
    archived_at: timestamp('archived_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('semesters_course_id_slug_key').on(t.course_id, t.slug),
    check('semesters_term_check', sql`${t.term} IN ('fa','sp','su','wi')`),
    check('semesters_year_check', sql`${t.year} BETWEEN 2000 AND 2100`),
    check('semesters_blob_retention_check', sql`${t.blob_retention_days} >= 30`),
    check(
      'semesters_derived_retention_check',
      sql`${t.derived_retention_days} >= ${t.blob_retention_days}`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// memberships  (PRD §5.1)
// ---------------------------------------------------------------------------

export const memberships = pgTable(
  'memberships',
  {
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    granted_by: uuid('granted_by')
      .notNull()
      .references(() => users.id),
    granted_at: timestamp('granted_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.semester_id] }),
    index('memberships_semester_id_idx').on(t.semester_id),
    check('memberships_role_check', sql`${t.role} IN ('admin','grader')`),
  ],
);

// ---------------------------------------------------------------------------
// pending_invitations  (PRD §4.4)
// ---------------------------------------------------------------------------

export const pending_invitations = pgTable(
  'pending_invitations',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    email: text('email').notNull(),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    invited_by: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    check('pending_invitations_role_check', sql`${t.role} IN ('admin','grader')`),
    // pending_invitations_unique_open is a partial unique index on
    // (LOWER(email), semester_id) WHERE consumed_at IS NULL.
    // Drizzle cannot express partial indexes in the schema; it is created
    // in the migration SQL directly.
  ],
);

// ---------------------------------------------------------------------------
// api_tokens  (PRD §4.3)
// ---------------------------------------------------------------------------

export const api_tokens = pgTable(
  'api_tokens',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    prefix: text('prefix').notNull().unique(),
    hashed_token: text('hashed_token').notNull(),
    scopes: jsonb('scopes')
      .notNull()
      .default(sql`'{}'`),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index('api_tokens_user_id_idx').on(t.user_id)],
);

// ---------------------------------------------------------------------------
// roster_entries  (PRD §5.2 / migration 0005)
// ---------------------------------------------------------------------------

/**
 * One row per student enrolled in a semester, keyed by `sid`.
 * Populated via CSV upload + commit (§8.4). `sid` is unique per semester.
 */
export const roster_entries = pgTable(
  'roster_entries',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    sid: text('sid').notNull(),
    display_name: text('display_name').notNull(),
    email: text('email'),
    extras: jsonb('extras')
      .notNull()
      .default(sql`'{}'`),
    protected_index: integer('protected_index'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('roster_entries_semester_sid_key').on(t.semester_id, t.sid),
    index('roster_entries_semester_id_idx').on(t.semester_id),
    unique('roster_entries_semester_protected_index_key').on(t.semester_id, t.protected_index),
  ],
);

// ---------------------------------------------------------------------------
// rate_limit_buckets  (PRD §7.6 / migration 0003)
// ---------------------------------------------------------------------------

/**
 * Postgres-backed rate limit bucket state.
 *
 * Used only when RATE_LIMIT_BACKEND=postgres (production multi-process).
 * The in-memory backend does not touch this table.
 *
 * `principal_id` format:
 *   "user:<uuid>"   — session-authenticated user
 *   "token:<uuid>"  — token-authenticated principal
 *   "anon:<ip>"     — unauthenticated, keyed by IP address
 */
export const rate_limit_buckets = pgTable(
  'rate_limit_buckets',
  {
    principal_id: text('principal_id').notNull(),
    route_class: text('route_class').notNull(),
    tokens: doublePrecision('tokens').notNull(),
    last_refill_at: timestamp('last_refill_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.principal_id, t.route_class] })],
);

// ---------------------------------------------------------------------------
// audit_log  (PRD §5.7 / migration 0004)
// ---------------------------------------------------------------------------

/**
 * Append-only audit trail of all write actions and sensitive read actions.
 * See PRD §13 for the action catalog and retention policy.
 *
 * Rows are NEVER deleted by application code; only the retention sweep removes
 * them after max(semester.derived_retention_days, 1825) days.
 */
export const audit_log = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actor_user_id: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    actor_token_id: uuid('actor_token_id').references(() => api_tokens.id, {
      onDelete: 'set null',
    }),
    semester_id: uuid('semester_id').references(() => semesters.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    target_type: text('target_type').notNull(),
    target_id: text('target_id').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'`),
    ip: inet('ip'),
    user_agent: text('user_agent'),
    at: timestamp('at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('audit_log_semester_at_idx').on(t.semester_id, t.at),
    index('audit_log_actor_at_idx').on(t.actor_user_id, t.at),
    index('audit_log_action_at_idx').on(t.action, t.at),
  ],
);

// ---------------------------------------------------------------------------
// assignments  (PRD §5.2 / migration 0006)
// ---------------------------------------------------------------------------

/**
 * One row per unique assignment within a semester.
 * `assignment_id_str` is the canonical string id from the bundle manifest.
 * `label` is human-readable and editable by admins.
 */
export const assignments = pgTable(
  'assignments',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    assignment_id_str: text('assignment_id_str').notNull(),
    label: text('label').notNull().default(''),
    sort_order: integer('sort_order').notNull().default(0),
    // Scope resolution for git-repo submissions (program architecture §6 /
    // migration 0023). A cloned repo can contain several `.provenance/`
    // directories; each one is self-identifying, so the default accepts every
    // sealed scope wherever it sits. This overrides that for what
    // self-identification cannot settle — two directories declaring the same
    // assignment id, or a stale vendored copy.
    //   { mode: 'self_identifying' | 'path', path_glob?: string,
    //     on_multiple: 'error' | 'ingest_all' }
    // Narrowed by parseIngestScopeConfig (services/ingest/gradescope/repo-scopes.ts).
    ingest_scope: jsonb('ingest_scope')
      .notNull()
      .default(sql`'{"mode":"self_identifying","on_multiple":"ingest_all"}'::jsonb`),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [unique('assignments_semester_assignment_key').on(t.semester_id, t.assignment_id_str)],
);

// ---------------------------------------------------------------------------
// ingest_jobs  (PRD §5.3 / migration 0006)
// ---------------------------------------------------------------------------

export const ingest_jobs = pgTable(
  'ingest_jobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    uploaded_by: uuid('uploaded_by')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(),
    summary: jsonb('summary')
      .notNull()
      .default(sql`'{}'`),
    // True once all ingest_files rows for this job have been staged (no more
    // will be added). The streaming local-path stager sets this false while it
    // streams and true when done; maybeEnqueueFinalize will not finalize a job
    // until it is true. Atomic-staging callers (HTTP /ingest, :gradescope)
    // create all rows before any worker runs, so they keep the default true.
    staging_complete: boolean('staging_complete').notNull().default(true),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    // ingest_jobs_semester_id_idx: defined in SQL with DESC ordering;
    // Drizzle cannot express DESC in index definition, so we omit it here.
    check(
      'ingest_jobs_status_check',
      sql`${t.status} IN ('queued','running','succeeded','partial','failed','cancelled')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// submissions  (PRD §5.4 / migration 0006)
// ---------------------------------------------------------------------------

/**
 * One row per (semester, assignment, student, version_index) tuple.
 * Partial covering index `submissions_cohort_idx` is SQL-only (WHERE clause).
 */
export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    assignment_id: uuid('assignment_id')
      .notNull()
      .references(() => assignments.id, { onDelete: 'restrict' }),
    student_id: uuid('student_id')
      .notNull()
      .references(() => roster_entries.id, { onDelete: 'restrict' }),
    blob_object_key: text('blob_object_key').notNull(),
    blob_sha256: text('blob_sha256').notNull(),
    recorder_version: text('recorder_version').notNull().default(''),
    format_version: text('format_version').notNull().default(''),
    source_filename: text('source_filename').notNull(),
    // Forward reference: ingest_jobs is declared later but FK is fine in SQL.
    ingest_job_id: uuid('ingest_job_id')
      .notNull()
      .references(() => ingest_jobs.id, { onDelete: 'restrict' }),
    ingested_at: timestamp('ingested_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    version_index: integer('version_index').notNull(),
    superseded_by_submission_id: uuid('superseded_by_submission_id'),
    score_total: doublePrecision('score_total').notNull().default(0),
    score_max_severity: text('score_max_severity').notNull().default('info'),
    validation_status: text('validation_status').notNull().default('pending'),
    heuristic_config_version: integer('heuristic_config_version').notNull().default(0),
    recompute_status: text('recompute_status').notNull().default('fresh'),
    // Denormalized cohort-list columns (migration 0014, V47).
    // flag_counts/top_flags are written by run-per-submission and
    // recompute-submission at the same place score_total /
    // score_max_severity are set. Reading from these lets the cohort list
    // query skip the two per-page sub-queries that dominated p95.
    //
    // severity_rank is a Postgres GENERATED ALWAYS column — the application
    // never writes it; the DB derives it from score_max_severity. We declare
    // it here so Drizzle exposes the column for filters / index hints, and
    // mark it generated so it's omitted from INSERT/UPDATE statements.
    flag_counts: jsonb('flag_counts')
      .notNull()
      .default(sql`'{"info":0,"low":0,"medium":0,"high":0}'::jsonb`),
    top_flags: jsonb('top_flags')
      .notNull()
      .default(sql`'[]'::jsonb`),
    // Bundle-level active/idle (60s event-gap), written by computeAndStoreStats.
    // NULL = not yet written (pre-0021 rows); analyzer shows an em dash.
    total_active_ms: bigint('total_active_ms', { mode: 'number' }),
    total_idle_ms: bigint('total_idle_ms', { mode: 'number' }),
    severity_rank: smallint('severity_rank')
      .notNull()
      .generatedAlwaysAs(
        sql`(CASE score_max_severity
            WHEN 'info'   THEN 0::smallint
            WHEN 'low'    THEN 1::smallint
            WHEN 'medium' THEN 2::smallint
            WHEN 'high'   THEN 3::smallint
          END)`,
      ),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique('submissions_version_key').on(
      t.semester_id,
      t.assignment_id,
      t.student_id,
      t.version_index,
    ),
    index('submissions_student_idx').on(t.semester_id, t.student_id),
    index('submissions_blob_sha_idx').on(t.semester_id, t.blob_sha256),
    check(
      'submissions_score_max_severity_check',
      sql`${t.score_max_severity} IN ('info','low','medium','high')`,
    ),
    check(
      'submissions_validation_status_check',
      sql`${t.validation_status} IN ('pending','pass','warn','fail')`,
    ),
    check(
      'submissions_recompute_status_check',
      sql`${t.recompute_status} IN ('fresh','stale','recomputing','error')`,
    ),
    // submissions_cohort_idx (partial) is SQL-only; defined in migration 0006
    // and replaced in 0014 to cover severity_rank.
  ],
);

// Self-referential FK: submissions.superseded_by_submission_id -> submissions.id
// Cannot express this in Drizzle with references(() => submissions.id) at declaration
// time because the table isn't fully built yet. The FK is defined in the SQL migration.

// ---------------------------------------------------------------------------
// ingest_files  (PRD §5.3 / migration 0006)
// ---------------------------------------------------------------------------

export const ingest_files = pgTable(
  'ingest_files',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    ingest_job_id: uuid('ingest_job_id')
      .notNull()
      .references(() => ingest_jobs.id, { onDelete: 'cascade' }),
    original_filename: text('original_filename').notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    blob_sha256: text('blob_sha256').notNull(),
    status: text('status').notNull(),
    matched_student_id: uuid('matched_student_id').references(() => roster_entries.id, {
      onDelete: 'set null',
    }),
    matched_assignment_id: uuid('matched_assignment_id').references(() => assignments.id, {
      onDelete: 'set null',
    }),
    submission_id: uuid('submission_id').references(() => submissions.id, { onDelete: 'set null' }),
    filename_capture: jsonb('filename_capture'),
    /**
     * Out-of-band match hint (Gradescope export ingest, migration 0015).
     *
     * When non-null, the worker matches this file to the roster by this `sid`
     * directly — taken from `submission_metadata.yml` — instead of applying the
     * semester's `filename_convention` regex, and dedups per
     * (semester, student, blob) so co-submitters of one group bundle each get
     * their own submission. Null for the normal /ingest path (filename-regex
     * match, blob-only dedup). See services/ingest/gradescope/.
     */
    match_sid: text('match_sid'),
    error: jsonb('error'),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    resolved_at: timestamp('resolved_at', { withTimezone: true }),
    resolved_by: uuid('resolved_by').references(() => users.id),
  },
  (t) => [
    index('ingest_files_job_idx').on(t.ingest_job_id),
    index('ingest_files_blob_sha256_idx').on(t.blob_sha256),
    // ingest_files_unmatched_idx (partial) is SQL-only; defined in migration 0006.
    check(
      'ingest_files_status_check',
      sql`${t.status} IN ('pending','matched','unmatched','duplicate','failed','superseded','discarded')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// (events table removed — migration 0019)
//
// Events are no longer persisted in Postgres. The `.slog` provenance logs inside
// the stored bundle blob are the source of the event stream; server read paths
// (events API, replay, recompute, cross-flags, summary) re-parse the bundle on
// demand via loadSubmissionIndex. `supporting_seqs` on flags / cross-flags still
// hold `globalIdx` values (the chronological index buildIndex assigns).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// per_file_stats  (PRD §5.4 / migration 0007)
// ---------------------------------------------------------------------------

/**
 * One row per (submission, file_path) with aggregated editing statistics.
 *
 * `final_length` and `start_length` are stored as 0 at ingest time.
 * Computing them requires file reconstruction (Phase 18).
 *
 * `reconstruction_tainted` is true if reconstructFile reported taint (large
 * paste or external change) for this file.
 */
export const per_file_stats = pgTable(
  'per_file_stats',
  {
    submission_id: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    file_path: text('file_path').notNull(),
    chars_typed: integer('chars_typed').notNull().default(0),
    chars_pasted: integer('chars_pasted').notNull().default(0),
    chars_external_change_delta: integer('chars_external_change_delta').notNull().default(0),
    saves: integer('saves').notNull().default(0),
    final_length: integer('final_length').notNull().default(0),
    start_length: integer('start_length').notNull().default(0),
    reconstruction_tainted: boolean('reconstruction_tainted').notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.submission_id, t.file_path] })],
);

// ---------------------------------------------------------------------------
// validation_results  (PRD §5.4 / migration 0008)
// ---------------------------------------------------------------------------

/**
 * One row per submission with the results of running v2's runValidation.
 *
 * The 8 check_N_status columns correspond to PRD §5.4 spec order:
 *   1. manifest_sig        5. monotonic_t
 *   2. session_binding     6. monotonic_wall
 *   3. chain_integrity     7. doc_save_hashes
 *   4. seq_gaps            8. submitted_code_match  (always 'skipped' in v1)
 *
 * CHECK constraints accept all four possible values ('pass'|'fail'|'warn'|'skipped');
 * the SQL migration is the authority. Drizzle check() helpers are omitted here
 * to keep the schema concise — the migration enforces them at the DB layer.
 *
 * `detail` stores the full ValidationReport.checks array for human-readable
 * display by the API without re-running validation.
 */
export const validation_results = pgTable('validation_results', {
  submission_id: uuid('submission_id')
    .primaryKey()
    .references(() => submissions.id, { onDelete: 'cascade' }),
  check_1_status: text('check_1_status').notNull(),
  check_2_status: text('check_2_status').notNull(),
  check_3_status: text('check_3_status').notNull(),
  check_4_status: text('check_4_status').notNull(),
  check_5_status: text('check_5_status').notNull(),
  check_6_status: text('check_6_status').notNull(),
  check_7_status: text('check_7_status').notNull(),
  check_8_status: text('check_8_status').notNull(),
  overall: text('overall').notNull(),
  detail: jsonb('detail')
    .notNull()
    .default(sql`'{}'`),
  validated_at: timestamp('validated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// flags  (PRD §5.4 / migration 0009)
// ---------------------------------------------------------------------------

/**
 * One row per heuristic finding on a submission.
 *
 * A single heuristic can fire multiple flags per submission (e.g. large_paste
 * fires once per paste event above threshold), so the PK is gen_random_uuid()
 * rather than a composite key.
 *
 * `supporting_seqs` is int[] of globalIdx values (events.seq) that
 * contributed to this flag. Translated from v2's `${sessionId}:${seq}` string
 * keys by buildIndex.bySeq at ingest time.
 *
 * `session_id`: set to the sessionId when all supporting_seqs belong to
 * the same session; otherwise '' (the default). This is a display/deep-link
 * convenience only — it is NOT a key. Resolving a supporting seq back to its
 * event goes through supporting_seqs (globalIdx), which is session-agnostic and
 * therefore correct for flags that span sessions.
 *
 * `title` / `description`: the per-instance prose analysis-core generates with
 * each flag ("Large paste in hw.py"). Persisted so the server-backed analyzer
 * can render the same detail drawer the in-memory /local route does. Rows
 * written before migration 0020 carry '' and the client falls back to
 * heuristic_id.
 *
 * CHECK constraints are defined in the SQL migration; omitted from Drizzle to
 * keep the schema concise (V27 convention).
 */
export const flags = pgTable(
  'flags',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    submission_id: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    heuristic_id: text('heuristic_id').notNull(),
    severity: text('severity').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    weight_at_compute: doublePrecision('weight_at_compute').notNull(),
    score_contribution: doublePrecision('score_contribution').notNull(),
    title: text('title').notNull().default(''),
    description: text('description').notNull().default(''),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'`),
    supporting_seqs: integer('supporting_seqs')
      .array()
      .notNull()
      .default(sql`'{}'`),
    session_id: text('session_id').notNull().default(''),
    heuristic_config_version: integer('heuristic_config_version').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index('flags_sub_idx').on(t.submission_id),
    index('flags_sem_heur_idx').on(t.semester_id, t.heuristic_id),
    index('flags_sem_sev_idx').on(t.semester_id, t.severity),
  ],
);

// ---------------------------------------------------------------------------
// heuristic_configs  (PRD §5.5 / migration 0010)
// ---------------------------------------------------------------------------

/**
 * Per-semester heuristic configuration versioning.
 *
 * At most one row per semester has is_active=true; enforced by the partial
 * unique index `heuristic_configs_active_idx` in migration 0010 (SQL-only —
 * Drizzle cannot express partial unique indexes per V27 convention).
 *
 * `config` is a jsonb object conforming to PRD §10.2 schema.
 */
export const heuristic_configs = pgTable(
  'heuristic_configs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    config: jsonb('config').notNull(),
    set_by: uuid('set_by')
      .notNull()
      .references(() => users.id),
    set_at: timestamp('set_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    note: text('note').notNull().default(''),
    is_active: boolean('is_active').notNull().default(false),
  },
  (t) => [
    unique('heuristic_configs_semester_version_key').on(t.semester_id, t.version),
    // heuristic_configs_active_idx is a partial unique index (WHERE is_active);
    // Drizzle cannot express partial unique indexes in the schema; it is created
    // in the migration SQL directly (V27 convention).
  ],
);

// ---------------------------------------------------------------------------
// recompute_jobs  (PRD §5.5 / migration 0010)
// ---------------------------------------------------------------------------

/**
 * Tracks a single recompute run for a semester under a given config.
 * Phase 13b will wire the pg-boss handlers that drive status transitions.
 */
export const recompute_jobs = pgTable(
  'recompute_jobs',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    target_config_id: uuid('target_config_id')
      .notNull()
      .references(() => heuristic_configs.id),
    triggered_by: uuid('triggered_by')
      .notNull()
      .references(() => users.id),
    status: text('status').notNull(),
    progress_total: integer('progress_total').notNull().default(0),
    progress_done: integer('progress_done').notNull().default(0),
    progress_failed: integer('progress_failed').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    summary: jsonb('summary')
      .notNull()
      .default(sql`'{}'`),
  },
  (t) => [
    index('recompute_jobs_sem_idx').on(t.semester_id, t.created_at),
    check(
      'recompute_jobs_status_check',
      sql`${t.status} IN ('queued','running','succeeded','partial','failed','cancelled')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// cross_flags  (PRD §5.4 / migration 0012)
// ---------------------------------------------------------------------------

/**
 * One row per cross-heuristic finding for a semester.
 *
 * Unlike per-submission `flags`, these are semester-scoped: the entire set is
 * replaced atomically on each recompute_cross_flags run (DELETE-then-INSERT
 * contract in run-cross.ts).
 *
 * `severity` CHECK is defined here and in the SQL migration for defence-in-depth.
 * The SQL migration is the authority.
 */
export const cross_flags = pgTable(
  'cross_flags',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    semester_id: uuid('semester_id')
      .notNull()
      .references(() => semesters.id, { onDelete: 'cascade' }),
    heuristic_id: text('heuristic_id').notNull(),
    severity: text('severity').notNull(),
    confidence: doublePrecision('confidence').notNull(),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'`),
    heuristic_config_version: integer('heuristic_config_version').notNull(),
    created_at: timestamp('created_at', { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // cross_flags_sem_h_idx is created in SQL migration; mirrors are defined
    // here for Drizzle query-builder index hints (not relied on for DDL).
    index('cross_flags_sem_h_idx').on(t.semester_id, t.heuristic_id),
    check('cross_flags_severity_check', sql`${t.severity} IN ('info','low','medium','high')`),
  ],
);

// ---------------------------------------------------------------------------
// cross_flag_participants  (PRD §5.4 / migration 0012)
// ---------------------------------------------------------------------------

/**
 * One row per (cross_flag, submission) pair.
 *
 * `supporting_seqs` mirrors the per-submission `flags.supporting_seqs` type:
 * int[] of globalIdx values (events.seq) that constitute the evidence for this
 * submission's involvement in the cross flag.
 *
 * CASCADE on cross_flag_id means deleting a cross_flags row removes all
 * participant rows — this is what the DELETE-then-INSERT contract relies on.
 * CASCADE on submission_id means deleting a submission removes its participant
 * rows without orphaning the cross_flags row (other participants remain).
 */
export const cross_flag_participants = pgTable(
  'cross_flag_participants',
  {
    cross_flag_id: uuid('cross_flag_id')
      .notNull()
      .references(() => cross_flags.id, { onDelete: 'cascade' }),
    submission_id: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    supporting_seqs: integer('supporting_seqs')
      .array()
      .notNull()
      .default(sql`'{}'`),
  },
  (t) => [
    primaryKey({ columns: [t.cross_flag_id, t.submission_id] }),
    // cfp_submission_idx is created in SQL migration.
    index('cfp_submission_idx').on(t.submission_id),
  ],
);

// ---------------------------------------------------------------------------
// Re-exported for convenience
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Course = typeof courses.$inferSelect;
export type NewCourse = typeof courses.$inferInsert;
export type Semester = typeof semesters.$inferSelect;
export type NewSemester = typeof semesters.$inferInsert;
export type Membership = typeof memberships.$inferSelect;
export type NewMembership = typeof memberships.$inferInsert;
export type PendingInvitation = typeof pending_invitations.$inferSelect;
export type NewPendingInvitation = typeof pending_invitations.$inferInsert;
export type ApiToken = typeof api_tokens.$inferSelect;
export type NewApiToken = typeof api_tokens.$inferInsert;
export type RateLimitBucket = typeof rate_limit_buckets.$inferSelect;
export type NewRateLimitBucket = typeof rate_limit_buckets.$inferInsert;
export type RosterEntry = typeof roster_entries.$inferSelect;
export type NewRosterEntry = typeof roster_entries.$inferInsert;
export type AuditLog = typeof audit_log.$inferSelect;
export type NewAuditLog = typeof audit_log.$inferInsert;
export type Assignment = typeof assignments.$inferSelect;
export type NewAssignment = typeof assignments.$inferInsert;
export type IngestJob = typeof ingest_jobs.$inferSelect;
export type NewIngestJob = typeof ingest_jobs.$inferInsert;
export type IngestFile = typeof ingest_files.$inferSelect;
export type NewIngestFile = typeof ingest_files.$inferInsert;
export type Submission = typeof submissions.$inferSelect;
export type NewSubmission = typeof submissions.$inferInsert;
export type PerFileStat = typeof per_file_stats.$inferSelect;
export type NewPerFileStat = typeof per_file_stats.$inferInsert;
export type ValidationResult = typeof validation_results.$inferSelect;
export type NewValidationResult = typeof validation_results.$inferInsert;
export type Flag = typeof flags.$inferSelect;
export type NewFlag = typeof flags.$inferInsert;
export type HeuristicConfig = typeof heuristic_configs.$inferSelect;
export type NewHeuristicConfig = typeof heuristic_configs.$inferInsert;
export type RecomputeJob = typeof recompute_jobs.$inferSelect;
export type NewRecomputeJob = typeof recompute_jobs.$inferInsert;
export type CrossFlag = typeof cross_flags.$inferSelect;
export type NewCrossFlag = typeof cross_flags.$inferInsert;
export type CrossFlagParticipant = typeof cross_flag_participants.$inferSelect;
export type NewCrossFlagParticipant = typeof cross_flag_participants.$inferInsert;
