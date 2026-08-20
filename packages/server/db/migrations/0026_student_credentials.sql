-- Migration 0026: student_credentials — the append-only record of every
-- credential this server has ever issued.
--
-- Identity format_version 2.1 (`packages/log-core/src/institution.ts`). This
-- adds NO new secret and NO new authority: every column here is public
-- material that already travels inside a bundle. There is no private key in
-- this table and there must never be one — the student's private half never
-- leaves their machine, which is the property the whole chain rests on.
--
-- ---------------------------------------------------------------------------
-- The question this table exists to answer
-- ---------------------------------------------------------------------------
--
-- Multiple machines per student is a SUPPORTED flow, and the design that makes
-- it work is already right: each machine generates its own master secret and
-- therefore its own keypair; the student signs in with the same account, so the
-- server hands back the SAME global `student_ref`; each machine gets its own
-- credential binding ITS key to that shared ref. Bundles verify independently
-- (the chain walk never consults this server) and contributor resolution groups
-- on `student_ref`, so two machines resolve to ONE contributor.
--
-- What was missing was memory. `students` holds ONE `student_pubkey` per
-- (institution_id, sso_subject) and the enrolment upsert OVERWRITES it. So:
--
--   * October — a student records on their laptop; the bundle carries the
--     laptop key.
--   * November — the same student enrols their desktop; `students` is rewritten
--     with the desktop key.
--   * March — staff adjudicate the October bundle and ask "is this the
--     student's key?". The server answers with the DESKTOP key, and the only
--     honest answer — "yes, that was one of theirs" — is unavailable, because
--     the evidence for it was overwritten four months earlier.
--
-- Verification was never affected: a credential is a signed artifact and stays
-- valid until its own signed `expires_at` no matter what this database says.
-- What was affected is ADJUDICATION, which is a question about history, and
-- history is exactly what an overwriting column cannot keep.
--
-- ---------------------------------------------------------------------------
-- Append-only, one row per issuance
-- ---------------------------------------------------------------------------
--
-- There is deliberately NO unique key on (student_ref, student_pubkey) and no
-- `issue_count` to bump. Two issuances of the same key at different times are
-- two facts, not one fact with a counter: they have different `issued_at` and
-- potentially different `expires_at`, and an adjudicator asking "which
-- credential was live when this bundle was recorded?" needs both. Collapsing
-- them would be a smaller version of the same overwrite this migration exists
-- to stop.
--
-- Growth is bounded by the fact that issuing is a rate-limited, human-driven
-- action (`rateLimit('write.misc')` on POST /api/v1/identity/credential) and a
-- row is a few dozen bytes. This is audit material: NOTHING prunes it. The
-- retention sweep deletes blobs only and DB rows are kept forever
-- (CLAUDE.md, docs/admin-guide.md §6); this table is the strongest case of that
-- rule, not an exception to it.
--
-- ---------------------------------------------------------------------------
-- `students` stays the identity anchor
-- ---------------------------------------------------------------------------
--
-- This is ADDITIVE. `students` keeps its UNIQUE (institution_id, sso_subject),
-- which is what makes `student_ref` stable for one human — and therefore what
-- makes two machines resolve to one contributor. Its `student_pubkey` /
-- `issued_at` / `expires_at` columns keep their existing meaning ("the most
-- recent issuance") and keep being overwritten. The history lives here.
--
-- `student_enrollments` (migration 0024) is NOT touched and NOT migrated into
-- this table. It holds ARCHIVED 2.0, per-course enrollments keyed through
-- `student_refs` by roster SID; 2.1 is keyed by SSO subject. Migration 0025
-- already recorded why the two eras cannot be merged — a merge would either
-- collapse refs that archived bundles distinguish or fabricate refs for
-- students who never obtained a 2.1 credential — and that reasoning applies
-- unchanged here.
--
-- ON DELETE RESTRICT, not CASCADE: no path deletes a `students` row today, and
-- if one is ever written it must not be able to silently take the audit trail
-- with it. RESTRICT turns that into a loud failure instead of a quiet erasure.

CREATE TABLE student_credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The global 2.1 ref the credential was issued over. Many rows per student.
  student_ref    uuid NOT NULL REFERENCES students(student_ref) ON DELETE RESTRICT,
  -- Denormalised from `students`, because it is inside the SIGNED credential
  -- payload and an adjudicator matching a bundle matches on it.
  institution_id text NOT NULL,
  -- The student's ed25519 PUBLIC key, 64 lowercase hex. One per machine, in
  -- practice, because each machine derives from its own master secret. Public
  -- half only — there is no column here whose disclosure would forge anything.
  student_pubkey text NOT NULL,
  -- Copied from the SIGNED credential, so this row says exactly what the
  -- artifact in the student's hands says.
  issued_at      timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (student_pubkey ~ '^[0-9a-f]{64}$')
);

-- THE adjudication index: "was this public key ever issued to this student?".
CREATE INDEX student_credentials_ref_pubkey_idx
  ON student_credentials (student_ref, student_pubkey);

-- The reverse lookup: "this bundle carries a key — whose was it?".
CREATE INDEX student_credentials_institution_pubkey_idx
  ON student_credentials (institution_id, student_pubkey);

-- ---------------------------------------------------------------------------
-- Backfill: recover what `students` still remembers
-- ---------------------------------------------------------------------------
--
-- A deployment upgrading to this migration already has `students` rows, and
-- each one still carries the MOST RECENT issuance it was overwritten to. That
-- is a real credential that really was issued, so it belongs in the history;
-- dropping it would mean a key currently in a student's hands reads as never
-- issued the moment this migration lands.
--
-- What the backfill CANNOT recover is any EARLIER key for a student whose row
-- was overwritten before this migration — those values are gone, which is the
-- whole reason this table exists. `students.issue_count` will therefore exceed
-- the number of backfilled rows for such a student, and that discrepancy is
-- honest: it is the record saying "more credentials were issued than I can
-- name". Nothing fabricates a row to close it.
--
-- Rows with a NULL `student_pubkey` (allocated but never issued) contribute
-- nothing, correctly.

INSERT INTO student_credentials (student_ref, institution_id, student_pubkey, issued_at, expires_at)
SELECT student_ref, institution_id, student_pubkey, issued_at, expires_at
FROM students
WHERE student_pubkey IS NOT NULL
  AND issued_at IS NOT NULL
  AND expires_at IS NOT NULL;
