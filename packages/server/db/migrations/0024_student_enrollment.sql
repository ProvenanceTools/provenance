-- Migration 0024: student enrollment — the `student_ref` ↔ roster mapping and
-- the record of which student keys have been bound to it.
--
-- Program spec §5a (S2). The server holds ONE private key, the per-course
-- ENROLLMENT key, and uses it to sign a token binding a public key the student
-- generated to a roster identity. Neither the enrollment private key nor the
-- signed certificate that authorizes it lives here: they are configured out of
-- band (PROVENANCE_ENROLLMENT_KEYS), deliberately NOT in Postgres, because
-- database dumps travel — nightly backups, the restore drill in
-- docs/admin-guide.md — and this is the highest-value secret the server holds.
--
-- Nothing in this migration stores an event, a keystroke, or any student source.
-- It is roster metadata plus public keys.
--
-- ---------------------------------------------------------------------------
-- student_refs — the opaque identifier that travels in the logs
-- ---------------------------------------------------------------------------
--
-- `student_ref` is written into `session.start.identity` and is therefore
-- readable by anyone who can read the log — including a project partner in a
-- shared CS 61B repo. It must not be derivable from an SID, an email, or a
-- name, so it is a random UUID (gen_random_uuid()) and the mapping back to a
-- person exists only here.
--
-- It is keyed on (semester_id, sid) rather than on roster_entries.id so that it
-- is STABLE for a student:
--
--   * enrolling from a second machine returns the same ref, so their sessions
--     do not fragment into two apparent contributors;
--   * a roster commit that deletes and re-adds the row (accept_deletions)
--     hands the same student their original ref back.
--
-- roster_entries.id is therefore a convenience pointer, nullable and ON DELETE
-- SET NULL: a deleted roster row must NOT take the mapping with it, because an
-- archived bundle years later still names this `student_ref` and an
-- adjudication has to be able to resolve it. The denormalised `sid` is what
-- survives; CLAUDE.md's "rows are kept forever for audit" rule applies here
-- exactly as it does to submissions.
--
-- Scope: per semester, not per course. Roster identity IS per semester, and
-- making the ref span semesters would link a student's Fall and Spring work
-- for no operational gain — a privacy regression, not a feature.

CREATE TABLE student_refs (
  student_ref     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  semester_id     uuid NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
  roster_entry_id uuid REFERENCES roster_entries(id) ON DELETE SET NULL,
  sid             text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (semester_id, sid)
);

CREATE INDEX student_refs_roster_entry_idx ON student_refs(roster_entry_id);

-- ---------------------------------------------------------------------------
-- student_enrollments — which public keys have been bound to a student_ref
-- ---------------------------------------------------------------------------
--
-- One row per (student_ref, student_pubkey). Re-enrolling from a second machine
-- with the same master secret re-derives the SAME per-course public key, so it
-- updates this row rather than creating another.
--
-- `superseded_at` records that a NEWER key has since been minted for the same
-- student — the "lost my master secret" case. It is bookkeeping, not
-- enforcement: an already-issued token stays cryptographically valid until
-- `expires_at`, and it must, because an archived bundle signed under a
-- superseded key has to keep verifying years later during an adjudication. The
-- whole identity chain lives inside the bundle and consults no server, so
-- nothing this table says can invalidate one. Revocation that an offline
-- recorder could honour is impossible without a network call (recorder PRD
-- NG2); the controls that do bite are the token's expiry and rotation of the
-- enrollment certificate itself, which the offline course key performs.
--
-- Only PUBLIC keys are stored. There is no column here whose disclosure would
-- let anyone forge anything.

CREATE TABLE student_enrollments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_ref       uuid NOT NULL REFERENCES student_refs(student_ref) ON DELETE CASCADE,
  -- The enrollment key that signed the most recent token for this pair, so an
  -- adjudicator can tell which certificate window a token was minted under
  -- after the key has rotated. 64 lowercase hex, ed25519 public key.
  enrollment_pubkey text NOT NULL,
  -- The student's per-course ed25519 PUBLIC key. 64 lowercase hex.
  student_pubkey    text NOT NULL,
  issued_at         timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  issue_count       integer NOT NULL DEFAULT 1,
  superseded_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (student_ref, student_pubkey),
  CHECK (student_pubkey ~ '^[0-9a-f]{64}$'),
  CHECK (enrollment_pubkey ~ '^[0-9a-f]{64}$'),
  CHECK (issue_count > 0)
);

CREATE INDEX student_enrollments_student_ref_idx ON student_enrollments(student_ref);
-- Revocation, per program spec §5a, must key on enrollment_pubkey and on
-- student_ref — never on a certificate or token identity, since both travel
-- outside any payload that binds to them.
CREATE INDEX student_enrollments_enrollment_pubkey_idx
  ON student_enrollments(enrollment_pubkey);
