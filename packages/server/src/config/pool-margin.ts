/**
 * Connection-pool headroom check for the worker's concurrency knobs.
 *
 * `INGEST_CONCURRENCY`, `INGEST_STAGE_CONCURRENCY`, and `RECOMPUTE_MAX_PARALLEL`
 * each hold roughly one `DATABASE_POOL_MAX` connection per in-flight job (see
 * the comments on those settings in env.ts). But they are not the only
 * consumers of a `--mode=worker` (or `--mode=all`) process's pool: HTTP
 * request handling (in `all` mode) and the other `batchSize: 1` pg-boss
 * queues/crons registered in `startWorker` — `ingest_finalize`,
 * `ingest_stage_upload`, `recompute_semester`, `recompute_finalize`,
 * `recompute_cross_flags`, `retention_sweep`, `purge_expired_sessions`,
 * `purge_expired_exports`, `reap_stale_uploads`, `storage_quota_check` — all
 * draw from the same pool and are not accounted for anywhere.
 *
 * This module is a pure, side-effect-free check so it can be unit tested
 * without booting pg-boss; `startWorker` (src/jobs/worker.ts) calls it once
 * at startup and logs a warning when the result is thin. It never throws —
 * see the docstring on `checkPoolMargin` for why this stays a warning.
 */

export interface PoolMarginCheck {
  /** INGEST_CONCURRENCY + INGEST_STAGE_CONCURRENCY + RECOMPUTE_MAX_PARALLEL. */
  concurrencySum: number;
  /** DATABASE_POOL_MAX − concurrencySum. Can be negative. */
  margin: number;
  /** The minimum margin this check considers safe, given DATABASE_POOL_MAX. */
  minMargin: number;
  /** True when margin < minMargin — the case worth logging. */
  thin: boolean;
}

/** Inputs this check reads — a subset of `Env` so callers don't need the full config type. */
export interface PoolMarginConfig {
  DATABASE_POOL_MAX: number;
  INGEST_CONCURRENCY: number;
  INGEST_STAGE_CONCURRENCY: number;
  RECOMPUTE_MAX_PARALLEL: number;
}

/**
 * Checks whether the worker's three concurrency knobs leave enough
 * `DATABASE_POOL_MAX` headroom for everything else sharing the pool.
 *
 * This is a WARNING signal, not a hard limit. None of these knobs are
 * cross-validated against `DATABASE_POOL_MAX` at config-parse time (unlike,
 * say, `AUTH_ALLOWED_HOSTED_DOMAINS`'s non-empty check in env.ts), and this
 * function never throws — a thin margin degrades to job queuing/retry under
 * load, not a crash, and the deployment at provenance.eecs.berkeley.edu is
 * running today with the current defaults (sum 9 of 10). A hard failure here
 * would risk taking down a live instance over a configuration that works in
 * practice; see docs/admin-guide.md §2.6/§10.4.
 *
 * Threshold: the margin must be at least 3 connections, or 25% of
 * `DATABASE_POOL_MAX`, whichever is larger.
 *   - 3 is a floor for small pools (the shipped default is 10): enough for a
 *     couple of concurrent HTTP requests plus one of the ~10 other
 *     single-concurrency pg-boss subscriptions to fire without immediately
 *     exhausting the pool.
 *   - 25% scales the floor for larger deployments, so raising
 *     `DATABASE_POOL_MAX` together with the concurrency knobs (as §2.6
 *     recommends for a large semester import) doesn't quietly erode the
 *     margin back down to a fixed handful of connections.
 *
 * At the shipped defaults (POOL_MAX=10, INGEST=4, STAGE=1, RECOMPUTE=4):
 * concurrencySum=9, margin=1, minMargin=max(3, ceil(10*0.25))=3 → thin.
 */
export function checkPoolMargin(cfg: PoolMarginConfig): PoolMarginCheck {
  const concurrencySum =
    cfg.INGEST_CONCURRENCY + cfg.INGEST_STAGE_CONCURRENCY + cfg.RECOMPUTE_MAX_PARALLEL;
  const margin = cfg.DATABASE_POOL_MAX - concurrencySum;
  const minMargin = Math.max(3, Math.ceil(cfg.DATABASE_POOL_MAX * 0.25));
  return { concurrencySum, margin, minMargin, thin: margin < minMargin };
}
