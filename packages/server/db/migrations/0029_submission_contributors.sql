-- Migration 0029: submission_contributors — a submission belongs to a SET of
-- people, and the version sequence stops being keyed on one of them.
--
-- Program decision D9 (`docs/superpowers/specs/2026-08-19-program-decision-log.md`)
-- and parent spec §7. This is the schema half of the cut-over; the read paths
-- move onto it in the same change.
--
-- ---------------------------------------------------------------------------
-- What was wrong
-- ---------------------------------------------------------------------------
--
-- `submissions.student_id` is NOT NULL, so the schema could express "this
-- submission is Alice's" and nothing else. A pair working in one repo was
-- represented by FANNING OUT: the same bundle bytes were ingested once per
-- co-submitter, producing N independent `submissions` rows with N duplicated
-- blobs, and `dedup.ts` was deliberately narrowed to
-- (semester_id, student_id, blob_sha256) so the second co-submitter did not
-- collapse into a "duplicate" of the first.
--
-- That representation cannot carry the thing group grading actually needs:
-- WHICH PARTNER a finding belongs to. With N rows there is no shared identity
-- to hang a per-contributor score on, so every flag either scored against
-- every partner or against none. Scoring a flag earned by one partner against
-- the other is a manufactured finding against an innocent student, which is
-- the failure this whole programme is judged against (D14).
--
-- ---------------------------------------------------------------------------
-- THE DANGEROUS PART: version uniqueness under a nullable student_id
-- ---------------------------------------------------------------------------
--
-- `submissions_version_key` was UNIQUE (semester_id, assignment_id, student_id,
-- version_index), and `create-submission.ts` takes a FOR UPDATE lock scoped by
-- the same three columns to serialise version allocation and to find the rows
-- it must mark superseded.
--
-- Simply making `student_id` nullable SILENTLY DESTROYS BOTH, and it does so
-- without any error anywhere:
--
--   * Postgres treats NULLs as DISTINCT in a unique constraint, so any number
--     of rows with student_id IS NULL and version_index = 1 coexist happily.
--   * `WHERE student_id = NULL` is never true, so the FOR UPDATE lock matches
--     ZERO rows. maxVersion stays 0, every submission of that group is
--     allocated version_index 1 forever, and `supersededIds` is always empty —
--     so the supersede chain never forms and the cohort list shows every
--     resubmission as live, all at version 1.
--
-- Neither failure raises. Both are exactly the shape of bug that this repo has
-- repeatedly shipped green.
--
-- The fix is to STOP KEYING THE VERSION SEQUENCE ON A NULLABLE COLUMN.
-- `version_owner_key` is a NOT NULL text column naming the LINEAGE — "whose
-- repeated submissions supersede each other" — and it, not `student_id`, is
-- what the unique constraint and the lock use. NULL semantics are then not
-- involved in version allocation at all, in any code path, ever.
--
-- And it is a GENERATED column, so the correspondence is not something
-- application code has to remember and not a CHECK that the wrong value could
-- still satisfy — Postgres derives it from the row and REFUSES any attempt to
-- write it. For every row that existed before this migration the derived value
-- is 'student:' || student_id, so the new unique constraint partitions the
-- existing table point-for-point as the old one did. That makes "existing
-- submissions are unaffected" a property of the schema rather than a claim
-- about test coverage.
--
-- See section 3 for the derivation and the behaviours verified against a real
-- Postgres before adopting it.
--
-- ---------------------------------------------------------------------------
-- The join table
-- ---------------------------------------------------------------------------
--
-- One row per PERSON this submission is attributable to. Two sources feed it
-- and they are reconciled into one row per person, never two:
--
--   * the ROSTER side — whoever submitted it (the filename match, or the
--     Gradescope `match_sid`). Named, but says nothing about who recorded.
--   * the BUNDLE side — `analysis-core`'s `establishBundleContributors`,
--     grouping sessions on the verified `student_ref`. Says who recorded, and
--     is the only side that can attribute a finding.
--
-- `contributor_key` is `analysis-core`'s `Contributor.key` verbatim for a
-- bundle-side contributor, and 'roster:<roster_entry_id>' for someone known
-- only as a submitter. It is the join primitive, deliberately the same string
-- the analysis engine already groups on, so the server cannot invent a second
-- notion of contributor identity that drifts from the one that produced it.
--
-- `submission_contributors_person_key` — UNIQUE (submission_id, roster_entry_id)
-- where roster_entry_id IS NOT NULL — is the load-bearing one. A co-submitter
-- who ALSO recorded arrives from BOTH sources, and writing them as two rows
-- would double-count one human: they would appear twice in the contributor
-- list and, worse, their score would be split across two apparent people. The
-- partial unique index makes that unrepresentable instead of merely tested.
--
-- ---------------------------------------------------------------------------
-- Which contributors get a row, and which deliberately do NOT
-- ---------------------------------------------------------------------------
--
-- Only contributors that can be NAMED or PROVEN DISTINCT:
--
--   * roster-side submitters — named.
--   * bundle-side `attributed` contributors — a chain that verifies, grouped
--     on `student_ref`. Named when a roster row matches; when none does, the
--     row is kept with roster_entry_id NULL, which is D13's `unattributed`
--     presentation: an administrative gap, never an integrity signal.
--
-- Bundle-side `unattributed` sessions (no identity block at all — the ORDINARY
-- state today, and blameless) get NO row. `analysis-core` gives each such
-- session a SINGLETON key precisely because two of them are neither provably
-- the same person nor provably different people. Emitting one row per such
-- session would turn a five-session solo bundle into five apparent
-- contributors — a fabricated relationship, and the exact error
-- `identity/types.ts` documents at length. The count of them is already
-- surfaced as a coverage fact.
--
-- Bundle-side `unverifiable` sessions get NO row either. That is an artifact
-- making a claim it cannot back; it is a finding in its own right and is
-- reported as one. Promoting it into the roster-facing attribution surface is
-- how a forged identity block would launder work onto whoever it names.
--
-- ---------------------------------------------------------------------------
-- Per-contributor scoring (D14)
-- ---------------------------------------------------------------------------
--
-- `score_total` / `score_max_severity` / `flag_counts` are carried PER
-- CONTRIBUTOR as well as per scope, because that is the only shape in which a
-- grader can act on one partner without implicating the other. The scope-level
-- columns on `submissions` keep their exact present meaning and are not
-- touched — the cohort list still reads them, unchanged.
--
-- The single-contributor case is defined to take the WHOLE scope score, which
-- is what keeps a solo submission's rollup byte-identical: with one contributor
-- there is no innocent partner to protect, so "the scope" and "the contributor"
-- are the same entity. See `contributor-scores.ts` for the one definition.
--
-- ---------------------------------------------------------------------------
-- Rows are never deleted by retention
-- ---------------------------------------------------------------------------
--
-- ON DELETE CASCADE on `submission_id` is a structural statement, not a
-- retention hook: no path deletes a `submissions` row (retention deletes blobs
-- only; rows persist for audit — CLAUDE.md, docs/admin-guide.md §6). The
-- cascade exists so that IF such a path is ever written it cannot leave
-- orphaned attribution behind. `roster_entry_id` is ON DELETE RESTRICT, which
-- matches `submissions.student_id`'s existing behaviour: a roster row that a
-- submission is attributed to must not vanish out from under it.

-- ---------------------------------------------------------------------------
-- 1. The join table
-- ---------------------------------------------------------------------------

CREATE TABLE submission_contributors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id   uuid NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  -- Denormalised from `submissions` so semester-scoped reads (the students
  -- rollup, the cohort filter) never have to join back through `submissions`
  -- just to bound the scan.
  semester_id     uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,

  -- `analysis-core` Contributor.key for a bundle-side contributor, or
  -- 'roster:<roster_entry_id>' for a submitter with no recorded sessions.
  contributor_key text NOT NULL,

  -- 'roster'      — known only as a submitter; says nothing about recording.
  -- 'attributed'  — a verified identity chain grouped on student_ref.
  kind            text NOT NULL,

  -- NULL when the contributor is enrolled at the institution but has no row on
  -- THIS semester's roster (D13). Never a reason to block or to flag.
  roster_entry_id uuid REFERENCES roster_entries(id) ON DELETE RESTRICT,

  -- The verified attribution primitive, for 'attributed' rows only. Opaque —
  -- never a name, SID or email.
  student_ref     text,
  -- The long-lived student public key that countersigned the session keys.
  student_pubkey  text,

  -- Coverage detail (parent spec §7): how much of the scope this person
  -- recorded. `session_count` is 0 for a 'roster' contributor by definition.
  session_count   integer NOT NULL DEFAULT 0,
  first_seen      timestamptz,
  last_seen       timestamptz,

  -- Did this person's identity reach us from the roster side (a filename
  -- match or a Gradescope match_sid)? True for BOTH sources when they
  -- reconcile onto one row.
  is_submitter    boolean NOT NULL DEFAULT false,

  -- D14: per-contributor scoring, alongside the per-scope roll-up that stays
  -- on `submissions`.
  score_total        double precision NOT NULL DEFAULT 0,
  score_max_severity text NOT NULL DEFAULT 'info',
  flag_counts        jsonb NOT NULL DEFAULT '{"info":0,"low":0,"medium":0,"high":0}'::jsonb,

  created_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT submission_contributors_kind_check
    CHECK (kind IN ('roster', 'attributed')),
  -- A 'roster' contributor is exactly "a person we know submitted this"; it
  -- has no chain and therefore no ref, no key and no sessions. An 'attributed'
  -- contributor must carry the ref it was grouped on — that ref IS its
  -- identity, and a row without one could not have been produced by the chain
  -- walk.
  CONSTRAINT submission_contributors_shape_check
    CHECK (
      (kind = 'roster'     AND student_ref IS NULL AND roster_entry_id IS NOT NULL)
      OR
      (kind = 'attributed' AND student_ref IS NOT NULL)
    ),
  CONSTRAINT submission_contributors_severity_check
    CHECK (score_max_severity IN ('info','low','medium','high')),
  CONSTRAINT submission_contributors_session_count_check
    CHECK (session_count >= 0),
  -- One row per contributor identity per submission. Makes a repeated ingest
  -- of the same co-submitter an upsert rather than a second row.
  CONSTRAINT submission_contributors_key_unique
    UNIQUE (submission_id, contributor_key)
);

-- THE anti-double-count invariant: one row per HUMAN per submission, however
-- many sources named them. See the header.
CREATE UNIQUE INDEX submission_contributors_person_key
  ON submission_contributors (submission_id, roster_entry_id)
  WHERE roster_entry_id IS NOT NULL;

-- "Which submissions is this student a contributor to?" — the students rollup
-- and the cohort list's student filter.
CREATE INDEX submission_contributors_roster_idx
  ON submission_contributors (semester_id, roster_entry_id);

-- "Who contributed to this submission?" — the per-submission fetch.
CREATE INDEX submission_contributors_submission_idx
  ON submission_contributors (submission_id);

-- ---------------------------------------------------------------------------
-- 2. Backfill: exactly ONE contributor per existing submission
-- ---------------------------------------------------------------------------
--
-- Every pre-existing row has a NOT NULL student_id, so each gets exactly one
-- 'roster' contributor naming that student, carrying the submission's own
-- score verbatim (single contributor ⇒ owns the whole scope score).
--
-- This is what makes the cut-over safe. After it, a read path rewritten to go
-- through `submission_contributors` returns, for every row that existed
-- before, the SAME single student it returned before — the join table is a
-- SUPERSET that reduces exactly to the old join on all existing data.
--
-- Existing FANNED-OUT group submissions are deliberately NOT merged. Merging
-- would mean deleting rows, which this system does not do, and would rewrite
-- history that flags, cross-flag participants and ingest_files all point at.
-- They stay as N one-contributor submissions — exactly as they read today —
-- and only NEW ingests take the one-row-N-contributors shape.

INSERT INTO submission_contributors (
  submission_id, semester_id, contributor_key, kind, roster_entry_id,
  is_submitter, score_total, score_max_severity, flag_counts
)
SELECT
  s.id,
  s.semester_id,
  'roster:' || s.student_id::text,
  'roster',
  s.student_id,
  true,
  s.score_total,
  s.score_max_severity,
  s.flag_counts
FROM submissions s
WHERE s.student_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. The version lineage key — a GENERATED column, not an application value
-- ---------------------------------------------------------------------------
--
-- `version_owner_key` is DERIVED by Postgres from the row itself. That is the
-- whole point: an application-written column could be written wrongly, and a
-- lineage key that disagrees with its row is a version sequence that silently
-- restarts. A generated column cannot be written at all — Postgres answers any
-- attempt with `cannot insert a non-DEFAULT value into column
-- "version_owner_key"` — so the correspondence is not a convention, an
-- assertion, or a CHECK someone could satisfy with the wrong value. It is the
-- only value the row can have.
--
-- It also means every INSERT site in the codebase, production and test alike,
-- keeps working untouched. Nothing had to learn about the new column, which is
-- itself part of the proof that existing behaviour is unchanged.
--
-- The two namespaces are disjoint by construction:
--
--   student_id IS NOT NULL  ->  'student:' || student_id   (a uuid)
--   student_id IS NULL      ->  'group:'   || group_key
--
-- and when BOTH are null the CASE yields NULL, which the NOT NULL rejects. So a
-- submission with no lineage is unrepresentable rather than merely unexpected.
--
-- Verified against Postgres 16 before adoption: a stored generated column is
-- accepted in a UNIQUE constraint; a duplicate solo (semester, assignment,
-- student, version) still collides exactly as before; two DIFFERENT groups at
-- version 1 coexist; the SAME group at version 1 twice collides; and both-null
-- fails NOT NULL.

ALTER TABLE submissions ADD COLUMN group_key text;

-- An empty group key would put every group with a blank key into ONE lineage,
-- superseding unrelated submissions across different pairs.
ALTER TABLE submissions ADD CONSTRAINT submissions_group_key_check
  CHECK (group_key IS NULL OR group_key <> '');

ALTER TABLE submissions ADD COLUMN version_owner_key text
  GENERATED ALWAYS AS (
    CASE
      WHEN student_id IS NOT NULL THEN 'student:' || student_id::text
      ELSE 'group:' || group_key
    END
  ) STORED NOT NULL;

-- Swap the unique constraint onto the lineage key. Same NAME, so the Drizzle
-- schema and every error message that quotes it stay accurate. For every row
-- that existed before this migration the key is 'student:' || student_id, so
-- this constraint partitions the existing table point-for-point as the old one
-- did.
ALTER TABLE submissions DROP CONSTRAINT submissions_version_key;
ALTER TABLE submissions ADD CONSTRAINT submissions_version_key
  UNIQUE (semester_id, assignment_id, version_owner_key, version_index);

-- Only now is it safe for student_id to be nullable: nothing about version
-- allocation reads it any more.
ALTER TABLE submissions ALTER COLUMN student_id DROP NOT NULL;

-- The lineage lookup `create-submission.ts` locks on.
CREATE INDEX submissions_version_owner_idx
  ON submissions (semester_id, assignment_id, version_owner_key);

-- ---------------------------------------------------------------------------
-- 4. Flag attribution (D14)
-- ---------------------------------------------------------------------------
--
-- '' means SCOPE-LEVEL: this finding belongs to the submission, not to any one
-- person. That is the DEFAULT and it is the honest answer whenever a flag's
-- supporting events span more than one contributor, or none — §6 Rule 2, a
-- finding names a person only when the evidence is established FOR THAT
-- PERSON. Every backfilled row is scope-level, which changes nothing about how
-- any existing flag reads or scores.
--
-- Deliberately a KEY, not a uuid FK to submission_contributors. `flags` and
-- `submission_contributors` are both rewritten wholesale on a recompute, and
-- an FK between two wholesale-rewritten tables forces a delete ORDER whose
-- violation is silent under ON DELETE SET NULL — attribution would just
-- disappear. The key is also STABLE across recomputes where a generated uuid
-- is not, and it is the same primitive `analysis-core` already documents as
-- "the identity primitive every downstream consumer should join on".
-- `flags.session_id` is already a bare logical id in this table for the same
-- reason, so this follows the local precedent rather than inventing one.

ALTER TABLE flags ADD COLUMN contributor_key text NOT NULL DEFAULT '';

-- Per-contributor score aggregation reads (submission_id, contributor_key).
CREATE INDEX flags_contributor_idx
  ON flags (submission_id, contributor_key);
