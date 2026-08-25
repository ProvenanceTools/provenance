-- Migration 0030: btree indexes for the three timestamp keyset paginations.
--
-- ---------------------------------------------------------------------------
-- Why now
-- ---------------------------------------------------------------------------
--
-- Bug 14 (see docs/superpowers/specs/2026-08-19-program-decision-log.md) replaced
-- three hand-rolled millisecond-bucket cursor predicates with a single Postgres
-- ROW-VALUE comparison, `(ts, id) < (cursor_ts, cursor_id)` for DESC and `>` for
-- ASC. That was a correctness fix — the bucket form silently dropped and
-- duplicated rows whenever rows shared a millisecond, which is the normal case
-- wherever a batch is written in one go.
--
-- It also unlocked something the old form could not use. A row-value comparison
-- is a RANGE condition on a matching btree index, so the planner pushes it down
-- as an `Index Cond`. The old OR-of-AND form could not be an index qual at all
-- and degraded to a `Filter` — the scan still had to visit and discard every row
-- ahead of the cursor. Measured on Postgres 16, 200k rows, LIMIT 51, with an
-- index on (semester_id, created_at DESC, id DESC):
--
--   row-value:  Index Only Scan, Index Cond,   10 buffers,  0.054 ms
--   old OR:     Index Only Scan, Filter,     1016 buffers,  3.003 ms
--                                            (10 000 rows removed by filter)
--
-- But NONE of these three tables actually carried an index on its timestamp
-- keyset. `submissions_cohort_idx` is (semester_id, score_total DESC,
-- severity_rank, id) — it serves `sort=score_desc`, not `sort=ingested_desc`.
-- So all three paginations were a sort over a scan, and the cohort list is the
-- most-hit query in the product. This migration adds the missing indexes so the
-- new predicates can be answered from an index instead.
--
-- Index-only, no data change: nothing is rewritten, no column is added or
-- dropped, and no existing index is replaced. Every one of these is additive and
-- safe to roll back by dropping it.
--
-- ---------------------------------------------------------------------------
-- Column ORDER and DIRECTION are load-bearing
-- ---------------------------------------------------------------------------
--
-- Each index must match its query's ORDER BY exactly, because that is what lets
-- the planner both satisfy the row-value range AND skip the sort. The leading
-- equality column comes first, then the timestamp, then the id tiebreak — the
-- same (ts, id) tuple the cursor carries. Changing the order or the direction
-- silently reverts these plans to a sort over a scan; it will not fail a test,
-- it will only get slow. Keep them aligned with `buildOrderBy` in
-- services/cohort/list.ts, the `orderBy` in services/cross-flags/list.ts, and
-- the `orderBy` in api/v1/routes/unmatched.ts.

-- ---------------------------------------------------------------------------
-- 1. cross_flags — GET /semesters/:id/cross-flags
--    WHERE semester_id = $1 [+ heuristic_id / severity / participant filters]
--    ORDER BY created_at DESC, id DESC
--
-- The existing cross_flags_sem_h_idx (semester_id, heuristic_id) answers the
-- heuristic_id filter but carries no timestamp, so it cannot serve the keyset.
-- This one is additive; both are kept and the planner picks per query.
-- ---------------------------------------------------------------------------
CREATE INDEX cross_flags_keyset_idx
  ON cross_flags (semester_id, created_at DESC, id DESC);

COMMENT ON INDEX cross_flags_keyset_idx IS
  'Keyset pagination for the cross-flags list: (semester_id, created_at DESC, id DESC) matches its ORDER BY so the row-value cursor predicate becomes an Index Cond. See migration 0030.';

-- ---------------------------------------------------------------------------
-- 2. submissions — GET /semesters/:id/submissions?sort=ingested_desc
--    WHERE semester_id = $1 AND superseded_by_submission_id IS NULL
--    ORDER BY ingested_at DESC, id DESC
--
-- PARTIAL on the same predicate as submissions_cohort_idx, deliberately:
-- include_superseded defaults to false, so the partial index matches the hot
-- path and stays smaller. `include_superseded=true` does not use this index and
-- plans exactly as it does today — no regression, just no improvement, and that
-- is the rarer, non-default request.
-- ---------------------------------------------------------------------------
CREATE INDEX submissions_ingested_keyset_idx
  ON submissions (semester_id, ingested_at DESC, id DESC)
  WHERE superseded_by_submission_id IS NULL;

COMMENT ON INDEX submissions_ingested_keyset_idx IS
  'Keyset pagination for cohort sort=ingested_desc. Partial on the default include_superseded=false path, mirroring submissions_cohort_idx. See migration 0030.';

-- ---------------------------------------------------------------------------
-- 3. ingest_files — GET /semesters/:id/unmatched
--    JOIN ingest_jobs ON ... WHERE ingest_jobs.semester_id = $1
--      AND ingest_files.status = 'unmatched'
--    ORDER BY ingest_files.created_at ASC, ingest_files.id ASC
--
-- The semester filter lives on the JOINED table, so it cannot be a leading
-- column here. What this index gives the planner is the ORDER BY in index order
-- among unmatched rows, so it can walk them from the cursor and probe
-- ingest_jobs per row, stopping at LIMIT — instead of sorting the whole
-- unmatched set.
--
-- PARTIAL on status='unmatched', matching the existing
-- ingest_files_unmatched_idx (which is (ingest_job_id) WHERE status='unmatched'
-- and answers the per-job lookup, not the keyset). Unmatched files are a small
-- minority of ingest_files, so the partial index is very small.
-- ---------------------------------------------------------------------------
CREATE INDEX ingest_files_unmatched_keyset_idx
  ON ingest_files (created_at, id)
  WHERE status = 'unmatched';

COMMENT ON INDEX ingest_files_unmatched_keyset_idx IS
  'Keyset pagination for the unmatched tray: (created_at, id) ASC among unmatched rows, matching its ORDER BY. Semester lives on ingest_jobs so it cannot lead. See migration 0030.';
