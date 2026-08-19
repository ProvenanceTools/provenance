-- migration: 0022_heuristic_config_backfill_missing_flags
--
-- Backfills the per_flag entries that migration 0010 could not contain.
--
-- 0010 backfilled a 24-entry per_flag map, taken from a hand-maintained list in
-- services/heuristics/config.ts. That list had drifted from the analysis-core
-- registries, which emit 26 flag ids: `inter_session_external_change` (an
-- event-stream heuristic) and `submitted_code_match` (the check-8 tamper
-- detection flag) were never in it. Both fired and scored at ingest, then were
-- dropped by the recompute path, which read a missing per_flag entry as
-- "disabled". So adjusting any weight erased them from the flags table and from
-- the score.
--
-- KNOWN_HEURISTIC_IDS is now derived from analysis-core's ALL_FLAG_IDS, and
-- both consumers route the missing-entry decision through resolvePerFlag
-- (missing => enabled, weight 1.0). This migration materializes that same
-- default into the stored rows so the DB agrees with the code, rather than
-- leaving every row dependent on a read-side fill forever.
--
-- Semantics:
--   - Adds ONLY keys that are absent. `||` on jsonb is right-biased, so putting
--     the existing map on the RIGHT means any entry a staff member actually set
--     (including `enabled: false` and custom weights and thresholds) wins.
--   - Touches ALL rows, not just is_active ones. recompute_jobs.target_config_id
--     references a specific heuristic_configs row and jobs/recompute.ts loads
--     the config by that id, so a non-active row is an operational input to a
--     future recompute, not just an audit record. Leaving historical rows
--     un-backfilled would leave that path depending on the read-side fill.
--   - Idempotent: re-running is a no-op once both keys are present, and the
--     WHERE clause skips rows that already have them.
--   - Uses `->> ... IS NULL` rather than the jsonb `?` operator so the SQL is
--     safe to hand to any driver's raw-query path (`?` collides with the
--     placeholder syntax of several of them).
--
-- This does NOT rewrite any decision staff made. The two keys could not have
-- been expressed when these rows were written; there was no setting to
-- overwrite.
--
-- IMPORTANT: as with 0010, do NOT edit this SQL retroactively. A future flag id
-- needs its own follow-up migration.

UPDATE heuristic_configs
SET config = jsonb_set(
  config,
  '{per_flag}',
  '{
     "inter_session_external_change": {"enabled": true, "weight": 1.0},
     "submitted_code_match":          {"enabled": true, "weight": 1.0}
   }'::jsonb || COALESCE(config -> 'per_flag', '{}'::jsonb)
)
WHERE COALESCE(config -> 'per_flag', '{}'::jsonb) -> 'inter_session_external_change' IS NULL
   OR COALESCE(config -> 'per_flag', '{}'::jsonb) -> 'submitted_code_match' IS NULL;
