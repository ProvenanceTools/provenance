-- Migration 0025: institution-scoped student identity — the `students` table
-- and its link to the roster.
--
-- Identity format_version 2.1 (`packages/log-core/src/institution.ts`). This is
-- the SERVER half of the chain
--
--   root ──▶ institution_cert ──▶ student_credential ──▶ session countersignature
--
-- Neither the institution private key nor its root-signed certificate lives
-- here. They are configured out of band (PROVENANCE_INSTITUTION_KEY),
-- deliberately NOT in Postgres, for exactly the reason migration 0024 gave for
-- the enrollment key: database dumps travel — nightly backups, the restore
-- drill in docs/admin-guide.md, an operator debugging a copy — and the one
-- secret whose theft forges student attribution must not ride along.
--
-- Nothing in this migration stores an event, a keystroke, or any student
-- source. It is identity metadata plus one public key per student.
--
-- ---------------------------------------------------------------------------
-- Why a new table rather than a change to student_refs
-- ---------------------------------------------------------------------------
--
-- `student_refs` (migration 0024) is PER-SEMESTER and keyed on (semester_id,
-- sid): it maps a course-scoped 2.0 enrollment token's `student_ref` back to a
-- roster row. It is NOT migrated, NOT backfilled, and NOT dropped, because
-- there is no correct mapping from it into this table:
--
--   * one person has N per-semester 2.0 refs but exactly ONE global 2.1 ref, so
--     any merge would either collapse refs that archived bundles distinguish or
--     fabricate a global ref for a student who never obtained a 2.1 credential;
--   * a 2.0 ref is keyed by SID, which the server learned from a roster; a 2.1
--     ref is keyed by an authenticated SSO subject, which no roster carries.
--     There is nothing to join on.
--
-- Both tables therefore stay live forever, exactly as `enrollment.ts` and
-- `institution.ts` both stay live in log-core. A `student_ref` arriving from an
-- archived bundle resolves against whichever table its era wrote it to, and
-- `student_enrollments` keeps its FK into `student_refs` untouched.
--
-- ---------------------------------------------------------------------------
-- students — the global, opaque identifier a student obtains ONCE
-- ---------------------------------------------------------------------------
--
-- The deadlock this removes: rosters are populated by the Gradescope ingest
-- path, which only runs AFTER a student submits, but a student needs an
-- identity BEFORE they work or their sessions carry none. The 2.0 mint refused
-- with `not_on_roster` when no roster row existed, so a student could not
-- enroll before their first submission. A row here is therefore allocatable
-- with NO roster row in existence — roster membership is not a precondition of
-- having an identity, it is a question the server answers later against data it
-- owns.
--
-- Keyed on (institution_id, sso_subject):
--
--   * `sso_subject` is the Google `sub` claim — the stable, authenticated,
--     opaque account identifier. Deliberately NOT the email: an email can be
--     reassigned by an IT department and its case is not normalised anywhere,
--     and keying identity on a mutable attribute is how one person ends up with
--     two refs and their sessions split into two apparent contributors.
--   * `institution_id` scopes it, because the `hd` gate can admit more than one
--     hosted domain and `institution_id` is inside both signed payloads of the
--     2.1 chain.
--
-- `student_ref` is a random UUID, never derived from an SSO subject, an SID, or
-- an email, because it travels in `session.start.identity` where a project
-- partner in a shared repo can read it. The mapping back to a person exists
-- only here.

CREATE TABLE students (
  student_ref    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id text NOT NULL,
  -- Google `sub`. Stable across email changes; the authorization key.
  sso_subject    text NOT NULL,
  -- The authenticated email, kept ONLY to link roster rows by. Matched
  -- case-insensitively everywhere; see students_institution_email_lower_idx.
  sso_email      text NOT NULL,
  -- The student's single long-lived ed25519 PUBLIC key, 64 lowercase hex.
  -- NULL until the first credential is issued. Only the public half is ever
  -- stored; there is no column here whose disclosure would forge anything.
  student_pubkey text,
  -- Bookkeeping for the most recently issued credential. NOT enforcement: the
  -- 2.1 chain is verified entirely from inside the bundle and consults no
  -- server, so nothing this table says can invalidate an issued credential. It
  -- stays cryptographically valid until its own `expires_at`, and it must —
  -- an archived bundle has to keep verifying years later during an
  -- adjudication. Re-issuing OVERWRITES these columns and orphans nothing.
  issued_at      timestamptz,
  expires_at     timestamptz,
  issue_count    integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, sso_subject),
  CHECK (student_pubkey IS NULL OR student_pubkey ~ '^[0-9a-f]{64}$'),
  CHECK (issue_count >= 0)
);

-- The roster-link lookup: "which student is this roster email?". Functional
-- index because every comparison against sso_email is lower()ed — a roster CSV
-- and a Google account routinely disagree on case.
CREATE INDEX students_institution_email_lower_idx
  ON students (institution_id, lower(sso_email));

-- ---------------------------------------------------------------------------
-- roster_entries.student_ref — the link, deliberately on the ROSTER side
-- ---------------------------------------------------------------------------
--
-- The direction of this FK is the whole design. Putting the pointer on the
-- roster row (many roster rows ──▶ one student) rather than a roster pointer on
-- the student gives three properties for free:
--
--  1. DELETING A ROSTER ROW CANNOT DESTROY AN IDENTITY. The `students` row and
--     its `student_ref` are untouched by any roster edit, so a `student_ref`
--     read out of an archived bundle still resolves after the roster row that
--     was once linked to it has been deleted. This is the property migration
--     0024 had to buy with a nullable ON DELETE SET NULL pointer on
--     `student_refs`; here it holds by construction. (0024's column is
--     unchanged and keeps that property for the 2.0 era.)
--
--  2. TWO ROSTER ROWS MATCHING ONE SSO IDENTITY IS NOT AN ERROR. It is the
--     normal case — one student appears on a roster in Fall and again in
--     Spring — and both rows simply point at the same `student_ref`. The 2.0
--     mint had to refuse this with a 409 `roster_ambiguous` because it derived
--     the ref FROM a roster row and could not pick one; 2.1 derives the ref
--     from the SSO subject, so there is nothing to disambiguate.
--
--  3. THE LINK IS ORDER-INDEPENDENT. Whichever of "student enrolls" and
--     "Gradescope ingest creates the roster row" happens first, the other side
--     backfills. Both directions are the same idempotent UPDATE ... WHERE
--     lower(email) = lower(sso_email) AND student_ref IS NULL.
--
-- ON DELETE SET NULL fires only if a `students` row were ever deleted, which no
-- retention path does — CLAUDE.md keeps rows forever for audit, and only blobs
-- are swept. It is here so that a hypothetical future deletion drops the link
-- rather than the roster row.
--
-- The `IS NULL` guard on every link write is what stops a later roster commit
-- from RE-POINTING an already-linked roster row at a different student. A link
-- is set once; changing it would silently re-attribute work.

ALTER TABLE roster_entries
  ADD COLUMN student_ref uuid REFERENCES students(student_ref) ON DELETE SET NULL;

CREATE INDEX roster_entries_student_ref_idx ON roster_entries(student_ref);
