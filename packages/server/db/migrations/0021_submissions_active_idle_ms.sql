-- Migration 0021: denormalize bundle active/idle time onto submissions
--
-- computeStats already produces totalActiveMs / totalIdleMs (60s event-gap)
-- at ingest and recompute, but only per_file_stats was persisted. The cohort
-- list cannot parse bundles, so these two columns let it show Active/Idle
-- without a second read. NULL means not yet written (pre-0021 rows); the
-- analyzer renders an em dash until the next ingest or heuristics recompute.
-- No backfill.

ALTER TABLE submissions
  ADD COLUMN total_active_ms bigint,
  ADD COLUMN total_idle_ms   bigint;
