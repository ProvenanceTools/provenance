-- Migration 0032: the second same-scope exclusion proof — shared sessions.
--
-- ---------------------------------------------------------------------------
-- Why
-- ---------------------------------------------------------------------------
--
-- 0031 built the register on ONE proof: a commit two archives both observed.
-- That key is a proxy for what the register's own text tells a grader — "each
-- archive contains the other's recorded sessions" — and the proxy is absent for
-- a whole class of honest partner pairs, because git observation is an OPTIONAL
-- recorder capability (`log-core/session-capabilities.ts`: available /
-- unavailable / not_owned, and provnvim reports only the first two).
--
-- A pair on a host with no git integration, a pair committing from a terminal
-- outside their recording sessions, two people on one laptop or a synced folder
-- — all of them produce the S20 archives, each physically containing the
-- other's signed `.slog` files, with ZERO observed commits. Before this change
-- they were compared, and `paste_shared_across_students` fired at high / 0.95.
--
-- `partitionCrossScopes` now also unions on a shared SESSION, keyed
-- `session:<session_pubkey> <session_id>`, guarded by a cohort-fraction ceiling
-- so a staff-recorded starter session cannot union a whole cohort. See
-- `analysis-core/coverage/cross-scope.ts` for the rule and for why the ceiling
-- is inert on small pools.
--
-- ---------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------
--
-- A second REASON and a second PROOF column, not a widened meaning for the
-- existing ones:
--
--   * `same_repository_lineage` — at least one commit was proved shared. A
--     repository is a thing that demonstrably exists, so this stays the
--     stronger claim and keeps its exact present meaning.
--   * `shared_recording_scope` — no commit was proved shared, but a signed
--     session was. The honest wording for a pair whose recorder never observed
--     git; calling it "same repository lineage" would be a claim the record
--     cannot support, in the one place a grader reads the evidence.
--
-- The reason is DERIVED from the proofs by the partition, never chosen by a
-- caller, so a lineage holding any shared commit reports the repository reason
-- even when sessions also matched. Both proof arrays are carried either way,
-- which is what keeps the register from asserting a commit it does not have
-- and from hiding one it does.
--
-- `shared_sessions` gets the same `DEFAULT '{}'` treatment `shared_commits`
-- has, so every row 0031 already wrote reads back as "proved by commits, no
-- session proof" — which is exactly what those rows mean. No backfill, no
-- rewrite, no row touched.
--
-- ---------------------------------------------------------------------------
-- Blast radius and rollback
-- ---------------------------------------------------------------------------
--
-- Purely additive: one column with a default, one CHECK widened to admit a
-- second value. No index changes, no data rewritten, no other table touched.
-- Widening a CHECK cannot fail on existing rows — every one of them holds the
-- value that was already the only legal one.
--
-- Rollback: drop the column and restore the single-valued CHECK. That is safe
-- only once no row holds the new reason; the register is replaced wholesale by
-- the next `recompute_cross_flags` run for the semester, so the ordinary
-- rollback is to deploy the old code and let the next run rewrite it.

ALTER TABLE cross_flag_exclusions
  ADD COLUMN shared_sessions text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN cross_flag_exclusions.shared_sessions IS
  'The session:<session_pubkey> <session_id> keys proving at least two of these archives physically carry the same signed .slog. Empty for a lineage proved by commits alone. A key the cohort-fraction ceiling rejected is NOT listed — it unioned nothing, so naming it as evidence would be false.';

-- The reason column is deliberately a CHECK rather than free text (0031), so a
-- second value has to be added on purpose, in a migration, at both ends. This
-- is that.
ALTER TABLE cross_flag_exclusions
  DROP CONSTRAINT cross_flag_exclusions_reason_check;

ALTER TABLE cross_flag_exclusions
  ADD CONSTRAINT cross_flag_exclusions_reason_check
    CHECK (reason IN ('same_repository_lineage', 'shared_recording_scope'));
