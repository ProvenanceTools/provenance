import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `er` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Identity & access ─────────────────────────────────────────────────────
  users: {
    title: 'users',
    body: 'Identity is the Google subject, not the email address. google_subject carries the only column-level UNIQUE constraint here, so a staff member whose institutional email changes keeps the same row and the same history. Email uniqueness is real but invisible in the schema file: it is a functional index on LOWER(email) that exists only in the migration SQL, because Drizzle cannot express expression indexes, the same reason several partial indexes in this diagram appear in no TypeScript declaration.\n\nDeleting a user cascades to sessions, api_tokens and memberships, but not to audit_log: that reference is ON DELETE SET NULL, so the record of what a person did outlives the removal of the person. One asymmetry is worth knowing: memberships.granted_by also points here with no cascade at all, so an admin who has granted access to others cannot be deleted while those grants stand.\n\nprotected is a superadmin-only switch that masks student identity in every API response. The toggle endpoint refuses to let a user clear it on themselves, which is what makes blind review something a course can impose rather than merely offer.',
    links: [
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
      { label: '0001_init.sql', href: `${GH}/packages/server/db/migrations/0001_init.sql` },
    ],
  },
  sessions: {
    title: 'sessions',
    body: 'Browser sessions are rows, not signed cookies: the primary key is an opaque text id issued server-side, so revoking access is a DELETE rather than a wait for an expiry claim to lapse. Two indexes exist for two different readers: sessions_user_id_idx for "log me out everywhere", sessions_expires_at_idx for the hourly purge cron, which deletes strictly where expires_at is already in the past.\n\nThe view_as columns are superadmin-only read-only impersonation, and both are null when it is not active. view_as_user_id is a second reference to users, and it is ON DELETE SET NULL rather than CASCADE on purpose: deleting the impersonated user must drop a sticky session back to its own identity, not destroy the superadmin’s session.',
    links: [
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
      {
        label: 'purge-expired-sessions.ts',
        href: `${GH}/packages/server/src/jobs/purge-expired-sessions.ts`,
      },
    ],
  },
  api_tokens: {
    title: 'api_tokens',
    body: 'The secret is never here. Only an 8-character prefix (UNIQUE, so it can be looked up directly) and an argon2id hash of the full token are stored; the token itself is shown once at creation and cannot be recovered. scopes is jsonb carrying read-only, the permitted semester ids, and whether blob access is allowed, so a token can be issued for one course without being able to read another.\n\nRevocation and expiry are nullable timestamps rather than deletions. Keeping the row is what keeps attribution intact: audit_log.actor_token_id points here, and while that reference is ON DELETE SET NULL and so would not lose the audit entry, it would lose which token performed the action, which is the whole reason for issuing more than one.',
    links: [
      { label: 'tokens.ts', href: `${GH}/packages/server/src/auth/tokens.ts` },
      {
        label: '0002_api_tokens.sql',
        href: `${GH}/packages/server/db/migrations/0002_api_tokens.sql`,
      },
    ],
  },
  memberships: {
    title: 'memberships',
    body: 'The primary key is the pair (user_id, semester_id), which is the schema stating that authorization is per semester and nothing else. A person can be admin of one semester and grader of another; the only role that is not scoped this way is users.is_superadmin, and it is a column rather than a membership row precisely so it cannot be granted by a course admin.\n\nThe extra index on semester_id exists because the primary key leads with user_id, while the question the app asks most often is "who can see this semester". Every authorization check for a submission resolves its semester first and then looks for a row here.\n\ngranted_by records who authorized the grant and references users with no cascade, so that provenance cannot be erased by deleting the granting account.',
    links: [
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
      { label: 'authorize', href: `${GH}/packages/server/src/auth/authorize.ts` },
    ],
  },
  pending: {
    title: 'pending_invitations',
    body: 'Access has to be grantable before the person exists. A membership needs a user row, and a user row only appears after someone has actually logged in through Google, so an invitation is keyed by email instead and is consumed at first login.\n\nThe constraint that matters is a partial unique index on (LOWER(email), semester_id) WHERE consumed_at IS NULL: at most one open invitation per email per semester, case-insensitively, while any number of previously consumed rows may sit beside it. Consumed invitations are never deleted, so "who was invited to this semester, by whom, and when" survives the invitation being used.',
    links: [
      { label: 'invitations.ts', href: `${GH}/packages/server/src/services/invitations.ts` },
      { label: '0001_init.sql', href: `${GH}/packages/server/db/migrations/0001_init.sql` },
    ],
  },
  audit: {
    title: 'audit_log',
    body: 'Append-only, and unusual in this schema for having a bigserial primary key rather than a uuid: rows are written in time order and read in time order, and the three indexes all end in at DESC for exactly that.\n\nAll three references out of this table (actor user, actor token, semester) are ON DELETE SET NULL, which is what makes the trail durable: an audit row can outlive every entity it names. The middleware writes only on a 2xx response, so this records completed actions rather than attempts, and the insert is fire-and-forget, so a failure to audit can never fail the request it was auditing.\n\nNo job deletes from this table. The retention sweep touches blobs only.',
    links: [
      { label: 'audit.ts (middleware)', href: `${GH}/packages/server/src/api/middleware/audit.ts` },
      {
        label: '0004_audit_log.sql',
        href: `${GH}/packages/server/db/migrations/0004_audit_log.sql`,
      },
    ],
  },

  // ── Organisation ──────────────────────────────────────────────────────────
  courses: {
    title: 'courses',
    body: 'The only parent link in this diagram that refuses instead of cascading: semesters.course_id is ON DELETE RESTRICT, so a course with any semester cannot be deleted at all. Deletion is not the intended end state; archiving is.\n\nArchiving a course is an application-level cascade rather than a database one. Every not-yet-archived semester in it gets its own archived_at and therefore starts its own retention clock, while semesters already archived keep the timestamp they had. There is no unarchive.\n\nslug is globally unique here; a semester’s slug is only unique within its course, which is why the semester key is the pair.',
    links: [
      { label: 'structure.ts', href: `${GH}/packages/server/src/services/structure.ts` },
      { label: 'admin guide §6', href: `${GH}/docs/admin-guide.md` },
    ],
  },
  semesters: {
    title: 'semesters',
    body: 'The cascade hub. Ten tables reference this one with ON DELETE CASCADE (memberships, pending_invitations, roster_entries, assignments, ingest_jobs, submissions, flags, heuristic_configs, recompute_jobs, cross_flags), which makes a semester the unit of both authorization and disposal. audit_log is the deliberate exception at ON DELETE SET NULL.\n\nfilename_convention is a per-semester regex, and it is the reason the roster join works at all: it is what extracts a student id out of an uploaded bundle’s filename. Change it and the next upload matches differently; it is course policy stored as data.\n\nRetention is configured here and constrained in the schema: blob_retention_days must be at least 30, and derived_retention_days must be at least blob_retention_days. Only the first is acted on. The retention sweep deletes blobs for archived semesters past their window and nothing else, so derived_retention_days is at present a recorded intention rather than a behaviour.',
    invariant:
      'archived_at starts the retention clock. Archiving is forward-only, and no new ingest is accepted afterwards.',
    links: [
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
      { label: 'retention-sweep.ts', href: `${GH}/packages/server/src/jobs/retention-sweep.ts` },
    ],
  },
  assignments: {
    title: 'assignments',
    body: 'Assignments are not configured up front; they are discovered. Ingest upserts this row with INSERT … ON CONFLICT DO NOTHING on (semester_id, assignment_id_str) and falls back to a SELECT when it conflicts, so an assignment exists because a bundle’s signed manifest claimed it, not because staff created it.\n\nThat is why there are two names. assignment_id_str is the canonical string from the manifest and is the join key; label is human prose, defaults to the id string, and is the only one an admin can edit. Renaming for the reader can therefore never break the match.\n\nsubmissions.assignment_id is ON DELETE RESTRICT, so once anything has been submitted against an assignment the row is pinned.',
    links: [
      {
        label: 'create-submission.ts',
        href: `${GH}/packages/server/src/services/ingest/create-submission.ts`,
      },
    ],
  },
  roster: {
    title: 'roster_entries',
    body: 'One row per enrolled student, keyed by (semester_id, sid): the student id from the course roster is the join key, and it is what the semester’s filename convention captures out of an uploaded bundle. A second uniqueness rule, (semester_id, protected_index), backs protected mode: protected_index is a per-semester, randomized, name-independent ordinal that produces stable "Student N" labels. It is nullable, and because Postgres treats NULLs as distinct, rows can exist without one until the backfill assigns them. New indices continue from the current maximum, so a student who already has a label keeps it across roster imports.\n\nemail is optional and only half-indexed: there is a functional index on (semester_id, LOWER(email)), while the free-text cohort filter also searches display_name, and that half is a scan. This was a deliberate choice: staff look people up by email.\n\nsubmissions.student_id is ON DELETE RESTRICT, so a roster commit that accepts deletions cannot remove a student who has submitted anything.',
    links: [
      {
        label: 'protected-index.ts',
        href: `${GH}/packages/server/src/services/protected-index.ts`,
      },
      {
        label: '0005_roster_entries.sql',
        href: `${GH}/packages/server/db/migrations/0005_roster_entries.sql`,
      },
    ],
  },

  // ── Submissions ───────────────────────────────────────────────────────────
  submissions: {
    title: 'submissions',
    body: 'A resubmission never overwrites anything. version_index is allocated as the current maximum plus one under a FOR UPDATE lock over the existing (semester, assignment, student) rows, it is part of the unique key, and the older rows have superseded_by_submission_id pointed at the new one. Every attempt therefore stays queryable, and the cohort list simply filters superseded_by_submission_id IS NULL, which is exactly the predicate on the partial index that serves it. That self-reference is the one FK Drizzle cannot declare (the table is not built yet at declaration time), so it lives in the migration, ON DELETE SET NULL.\n\nblob_sha256 is the hash of the bundle as the student submitted it, before source stripping, not of the object actually sitting at blob_object_key. It is the dedup key, it is the stable identity of what was handed in, and loadSubmissionIndex borrows it only as a cache key.\n\nThe columns that exist purely so the cohort list can be a single query are flag_counts and top_flags (jsonb denormalizations that the heuristic write path keeps in step with score_total), severity_rank (GENERATED ALWAYS from score_max_severity, so "medium and above" is a range predicate on an indexed integer instead of an OR across strings), and total_active_ms / total_idle_ms (the 60s event-gap Active/Idle pair computeStats already produced, written by computeAndStoreStats at ingest and recompute). Those two time columns are nullable: pre-0021 rows stay NULL until the next ingest or heuristics recompute, and the analyzer renders an em dash. At fifty thousand submissions the two correlated sub-queries the flag columns replaced were the p95.',
    invariant:
      'version_index is allocated under a row lock. The (semester, assignment, student, version) key means a resubmission adds a row; it never replaces one.',
    links: [
      {
        label: 'create-submission.ts',
        href: `${GH}/packages/server/src/services/ingest/create-submission.ts`,
      },
      {
        label: '0014_submissions_denormalized_flags.sql',
        href: `${GH}/packages/server/db/migrations/0014_submissions_denormalized_flags.sql`,
      },
      {
        label: '0021_submissions_active_idle_ms.sql',
        href: `${GH}/packages/server/db/migrations/0021_submissions_active_idle_ms.sql`,
      },
    ],
  },
  stats: {
    title: 'per_file_stats',
    body: 'Separate from submissions because the grain is different: the primary key is (submission_id, file_path), one row per file the recording touched. Folded into submissions it would be a jsonb blob no index could filter, and the file list is something the UI asks for on its own.\n\nMost columns are counters, but two are not. final_length and start_length come from actually replaying the file at ingest, while the bundle is still in memory, and reconstruction_tainted records that the replay met a large paste or an external change and therefore cannot claim to be a complete account of how the file was built. That flag has teeth at read time: the replay endpoint returns an empty body plus a warning rather than content it cannot vouch for.\n\nThe table also doubles as the file registry. The replay route looks a path up here first and answers FILE_NOT_FOUND from its absence, rather than parsing the bundle and discovering emptiness.',
    links: [
      { label: 'ingest/stats.ts', href: `${GH}/packages/server/src/services/ingest/stats.ts` },
      { label: 'reconstruction.ts', href: `${GH}/packages/server/src/services/reconstruction.ts` },
    ],
  },
  valres: {
    title: 'validation_results',
    body: 'submission_id is the primary key, not merely a foreign key, so this is strictly one row per submission, the only true 1:1 in the diagram. Validation runs once, at ingest, against the bundle while the student’s source is still in memory, and read paths serve this row.\n\nThe eight flat check_N_status columns and the detail jsonb hold the same verdicts twice, on purpose. The flat columns are what cohort filtering reads; detail carries the full check array (labels, causes, the entries that failed) and is what the validation tab renders and what recompute reads back to rebuild a report without re-deciding integrity. Recompute is about heuristic weights; it must not be able to change whether a chain verified.\n\nOne read path does re-run validation: the Source tab parses a fresh copy of the blob to recover whether the chain is intact, because a per-file verdict is only meaningful when it is.',
    links: [
      {
        label: 'run-validation.ts',
        href: `${GH}/packages/analysis-core/src/validation/run-validation.ts`,
      },
      {
        label: 'reconstruct-bundle.ts',
        href: `${GH}/packages/server/src/services/heuristics/reconstruct-bundle.ts`,
      },
    ],
  },
  flags: {
    title: 'flags',
    body: 'The primary key is a random uuid rather than (submission, heuristic), because one heuristic can fire many times on one submission: large_paste writes a row per paste over the threshold. semester_id sits here alongside submission_id as a denormalization, so the cohort facets can index (semester, heuristic) and (semester, severity) without joining through submissions.\n\nsupporting_seqs is an int[] of globalIdx values: positions in the single chronological ordering buildIndex assigns across every session in the bundle. That indirection is why dropping the events table cost this table nothing: globalIdx is recomputed identically from the re-parsed bundle, so the integers still resolve. session_id beside it is a deep-link convenience, set only when every supporting event happens to be in one session and empty otherwise; it is never how evidence is resolved.\n\nweight_at_compute and heuristic_config_version freeze the configuration in force when the flag was written, which is what lets an old score still be explained after the sliders have moved.',
    invariant:
      'supporting_seqs are globalIdx values, not session-local seq. Evidence resolves through them, never through session_id.',
    links: [
      {
        label: 'run-per-submission.ts',
        href: `${GH}/packages/server/src/services/heuristics/run-per-submission.ts`,
      },
      { label: 'schema.ts', href: `${GH}/packages/server/src/db/schema.ts` },
    ],
  },

  // ── Cross-submission ──────────────────────────────────────────────────────
  xflags: {
    title: 'cross_flags',
    body: 'Semester-scoped rather than submission-scoped, which is the entire reason this is not just another row in flags: a finding about two students belongs to neither of them.\n\nThe whole set is deleted and re-inserted on every cross run, inside one transaction guarded by a transaction-scoped pg_advisory_xact_lock. Merging was rejected for two reasons. A fresh run can legitimately produce fewer findings than the last, which a merge would leave as stale rows, and a cross flag has no identity that survives a run, because the participant set changes as submissions arrive. So there is no natural unique key here at all, only a (semester_id, heuristic_id) index.\n\nEach row keeps the heuristic_config_version it was computed under, exactly as per-submission flags do.',
    links: [
      { label: 'run-cross.ts', href: `${GH}/packages/server/src/services/heuristics/run-cross.ts` },
      {
        label: '0012_cross_flags.sql',
        href: `${GH}/packages/server/db/migrations/0012_cross_flags.sql`,
      },
    ],
  },
  xparts: {
    title: 'cross_flag_participants',
    body: 'The join between a semester-scoped finding and the submissions it implicates. Composite primary key (cross_flag_id, submission_id), plus a separate index on submission_id alone so a submission’s drill-in can ask the question from the other end.\n\nBoth foreign keys cascade, for different reasons. Cascade on cross_flag_id is the mechanism the whole-set replacement relies on: one DELETE over the semester’s cross_flags takes every participant row with it, with no second statement to get wrong. Cascade on submission_id means removing a submission detaches it from a finding without destroying the finding: the other participants and the evidence against them remain, which matters because a paste shared by three students is still a finding when one of them is gone.\n\nsupporting_seqs carries the same globalIdx integers as per-submission flags, so evidence resolves through the same path.',
    links: [
      { label: 'run-cross.ts', href: `${GH}/packages/server/src/services/heuristics/run-cross.ts` },
    ],
  },

  // ── Ingest ────────────────────────────────────────────────────────────────
  ijobs: {
    title: 'ingest_jobs',
    body: 'One row per upload batch, holding the status the analyzer polls and a jsonb summary of the outcome. Its index is (semester_id, created_at DESC), which is the only ordering anyone asks for.\n\nstaging_complete is the column that is easy to miss and load-bearing. The streaming local-path importer sets it false while it is still adding ingest_files rows and true when it has finished; the finalize check refuses to declare a batch done until it is true. Without it, a worker that finished the first three files of a still-streaming import would count zero files pending, conclude it was last, and finalize a job that was not fully staged. Callers that create every row before any worker can run (the HTTP ingest and Gradescope paths) leave the default true.\n\nuploaded_by references users with no cascade: who ran an import is part of the import.',
    links: [
      { label: 'worker.ts', href: `${GH}/packages/server/src/jobs/worker.ts` },
      {
        label: 'job-control.ts',
        href: `${GH}/packages/server/src/services/ingest/job-control.ts`,
      },
    ],
  },
  ifiles: {
    title: 'ingest_files',
    body: 'One row per file inside an upload, and the reason a batch can be partially successful. status carries seven values and three of them are not failures: duplicate points at the submission whose bytes it matched, superseded marks a row whose submission a later version replaced, and discarded marks one a staff member resolved away. A partial index on status = \'unmatched\' serves the tray where that resolution happens.\n\nAll three matching references (student, assignment, submission) are ON DELETE SET NULL, so an ingest report degrades to "this file was uploaded" rather than vanishing when a target is removed.\n\nmatch_sid is the Gradescope seam. When it is set, the worker skips the semester’s filename regex and matches straight to the roster by that sid, and dedup narrows from (semester, blob) to (semester, student, blob), which is how two co-submitters of one group bundle each get their own submission out of byte-identical input.',
    links: [
      { label: 'dedup.ts', href: `${GH}/packages/server/src/services/ingest/dedup.ts` },
      { label: 'attach.ts', href: `${GH}/packages/server/src/services/ingest/attach.ts` },
    ],
  },
  rjobs: {
    title: 'recompute_jobs',
    body: 'A recompute is a semester-wide re-scoring of already-ingested submissions under a new configuration, so this row is scoped to the semester and points at the exact heuristic_configs version it targets, with no cascade on that reference, so a config version cannot be deleted while a job that used it exists.\n\nThe three progress counters (total, done, failed) are separate rather than a percentage because a recompute can partially fail: a submission whose blob has been swept by retention can no longer be re-analysed, and the job has to finish and say so rather than abort. That is also why the status enum includes partial, exactly as ingest_jobs does.\n\nThe row is the durable record of a tuning decision: who triggered it, against which config, and what it moved.',
    links: [
      { label: 'recompute.ts', href: `${GH}/packages/server/src/jobs/recompute.ts` },
      {
        label: '0010_heuristic_configs_and_recompute.sql',
        href: `${GH}/packages/server/db/migrations/0010_heuristic_configs_and_recompute.sql`,
      },
    ],
  },

  // ── Operations ────────────────────────────────────────────────────────────
  hcfg: {
    title: 'heuristic_configs',
    body: 'Configuration is versioned and never edited in place. UNIQUE (semester_id, version) keeps the history dense, and a partial unique index WHERE is_active allows at most one active row per semester, a constraint the database enforces rather than the application hoping.\n\nCommitting takes a row lock on the current active row, flips it to inactive, and inserts version + 1; the caller must send the version it observed, so two admins tuning the same semester at once cannot silently overwrite one another: the loser is told what it missed. config is a jsonb object of per-flag enable/weight pairs plus the severity weights.\n\nKeeping superseded versions is what makes a score explainable. Every flag stores the heuristic_config_version it was computed under, so the configuration that produced last month’s number is still on disk when someone asks about it.',
    links: [
      {
        label: 'heuristics/config.ts',
        href: `${GH}/packages/server/src/services/heuristics/config.ts`,
      },
    ],
  },
  rate: {
    title: 'rate_limit_buckets',
    body: 'The only table in this diagram with no foreign keys at all, and that is deliberate: principal_id is a string of the form user:<uuid>, token:<uuid> or anon:<ip>, so an unauthenticated caller gets a bucket without needing a row anywhere else in the schema. The primary key is (principal_id, route_class), so limits are per principal per class of route rather than one global tap.\n\nIt exists only because a limit has to hold across processes. When the Postgres backend is selected, each check is a pre-seeding upsert plus a single CTE that locks the row FOR UPDATE, refills by elapsed time, and deducts: one round-trip, no double-spend between concurrent API instances. The in-memory backend used in development touches none of this and is per-process, which stops being correct the moment there are two.\n\nNothing prunes it. The row count is bounded by distinct principals times route classes, not by traffic.',
    links: [
      {
        label: 'rate-limit-pg.ts',
        href: `${GH}/packages/server/src/api/middleware/rate-limit-pg.ts`,
      },
    ],
  },

  // ── Blob store ────────────────────────────────────────────────────────────
  blobstore: {
    title: 'Blob store',
    body: 'Not a table. One object per submission, at semesters/{semesterId}/submissions/{submissionId}/bundle.zip, holding the signed manifest and the .slog logs and nothing else. Ingest strips the student’s source after the last computation that needs it, and copies the manifest through verbatim so the object stays signature- and chain-verifiable.\n\nThis is the only place the event stream exists. There is no events table, and the columns in this diagram that appear to reference events (supporting_seqs on flags and on cross_flag_participants) are integers into an ordering that is rebuilt by re-parsing this object.\n\nRetention deletes the object and only the object. Every row in every cluster above survives, so a swept semester still shows its cohort, its scores, its flags and its validation verdicts; what stops working is replay, the timeline, recompute and anything else that needs the raw stream. The rows are kept because a conduct case can outlive a course by years, and the derived findings are what such a case was built on.',
    invariant:
      'Retention deletes blobs only; no DB row is ever deleted for retention. manifest.json and manifest.sig inside the blob are never modified.',
    links: [
      {
        label: 'strip-bundle.ts',
        href: `${GH}/packages/server/src/services/ingest/strip-bundle.ts`,
      },
      { label: 'retention-sweep.ts', href: `${GH}/packages/server/src/jobs/retention-sweep.ts` },
      { label: 'admin guide §6', href: `${GH}/docs/admin-guide.md` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = [];
