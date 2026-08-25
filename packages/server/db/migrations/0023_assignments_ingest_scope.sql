-- Migration 0023: per-assignment scope resolution for git-repo submissions.
--
-- CS 61B/61C do not produce sealed bundles from a single flat folder: students
-- push a git repo and Gradescope clones the WHOLE repository, so one submission
-- tree can contain several assignment directories, each with its own
-- `.provenance/`. Ingest now walks the tree, finds every scope, and fans out to
-- one submission per accepted scope
-- (services/ingest/gradescope/repo-scopes.ts).
--
-- Every discovered scope is already self-identifying — both
-- `.provenance-manifest` and the sealed `manifest.json` carry `assignment_id`
-- and `semester` — so ingest does not need to be told WHERE to look, only WHAT
-- to accept. Hence the default below accepts every sealed scope wherever it
-- sits, and this column exists purely as an override for what
-- self-identification cannot settle:
--
--   mode           'self_identifying' (default) | 'path'
--   path_glob      required by mode='path'; matched against the scope's
--                  directory prefix, e.g. 'proj2/**'. Excludes a stale
--                  vendored copy.
--   on_multiple    'ingest_all' (default) | 'error' — what to do when more
--                  than one accepted scope declares the SAME assignment_id.
--
-- Malformed values degrade to the default in parseIngestScopeConfig rather than
-- failing ingest, so no data migration or backfill is required: every existing
-- row picks up the default and behaves exactly as it did before fan-out.

ALTER TABLE assignments
  ADD COLUMN ingest_scope jsonb NOT NULL
  DEFAULT '{"mode":"self_identifying","on_multiple":"ingest_all"}'::jsonb;
