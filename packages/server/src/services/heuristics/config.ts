/**
 * Heuristic config service — Phase 13a.
 *
 * Provides:
 *   - getActiveConfig(db, semesterId)   — fetch the active config row.
 *   - listConfigHistory(db, semesterId) — list all versions, newest first.
 *   - validateConfig(input)             — validate a PRD §10.2 config candidate.
 *
 * Phase 13b will add commitNewVersion (atomic flip + recompute enqueue).
 *
 * ## Known heuristic IDs
 *
 * KNOWN_HEURISTIC_IDS is DERIVED from analysis-core's ALL_FLAG_IDS — the
 * canonical enumeration built from the three live registries the engine
 * actually runs. Any config PUT against the API must include an entry for
 * every known ID (none missing, none unknown). This matches the PRD §10.2
 * validation rule and the convention stated in
 * docs/analyzer-v3-implementation-plan.md §13a.
 *
 * It used to be a hand-maintained literal, and it drifted: it listed 24 ids
 * while the engine emitted 26 (`inter_session_external_change` and
 * `submitted_code_match` were absent). Deriving it means that cannot recur —
 * see config.test.ts, which fails if the two ever diverge again.
 *
 * ## Missing per_flag entries
 *
 * A stored config can legitimately predate a newly shipped flag. The single
 * definition of what that means lives in `resolvePerFlag` below: a missing
 * entry is ENABLED at weight 1.0. Every consumer (ingest and recompute) must
 * go through it — they previously disagreed, and the disagreement silently
 * dropped real flags on recompute. See resolvePerFlag's JSDoc for the
 * rationale behind choosing "enabled".
 */

import { eq, desc, and, count, sql } from 'drizzle-orm';
import { ALL_FLAG_IDS } from '@provenance/analysis-core/heuristics/known-flag-ids.js';
import { heuristic_configs, recompute_jobs, submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';
import { Errors } from '../../api/v1/errors.js';

// ---------------------------------------------------------------------------
// PRD §10.2 server-side config shape
// ---------------------------------------------------------------------------

export type PerFlagEntry = {
  enabled: boolean;
  weight: number;
  thresholds?: Record<string, unknown>;
};

export type SeverityWeights = {
  info: number;
  low: number;
  medium: number;
  high: number;
};

/**
 * Server-side heuristic config stored in heuristic_configs.config (PRD §10.2).
 *
 * This is DISTINCT from v2's HeuristicConfig (which carries threshold values
 * for each heuristic). This shape carries enabled/weight/thresholds per heuristic
 * ID plus overall severity_weights.
 */
export type ServerHeuristicConfig = {
  per_flag: Record<string, PerFlagEntry>;
  severity_weights: SeverityWeights;
  config_format_version: 1;
};

// ---------------------------------------------------------------------------
// Default server-side config values
// ---------------------------------------------------------------------------

/** Default severity weights per PRD §10.2. */
export const DEFAULT_SEVERITY_WEIGHTS: SeverityWeights = {
  info: 0,
  low: 1,
  medium: 3,
  high: 8,
};

/**
 * The set of known heuristic IDs, derived from analysis-core.
 *
 * PRD §10.2: "Every known heuristicId must have a per_flag entry."
 * Source of truth: `ALL_FLAG_IDS` — the union of the per-submission heuristic
 * registry, the validation-derived integrity flags, and the cross-submission
 * registry, all read straight off the objects the engine iterates at runtime.
 *
 * Integrity-derived flags (chain_broken, manifest_sig_invalid,
 * submitted_code_match, ...) are included because they appear as Flag rows and
 * must be configurable. So are the cross-submission heuristics.
 *
 * The Set shape is kept because validateConfig does O(1) membership tests
 * against it and callers outside this module read `.size` / iterate it.
 */
export const KNOWN_HEURISTIC_IDS: ReadonlySet<string> = new Set(ALL_FLAG_IDS);

/**
 * What a per_flag entry means when the stored config does not have one.
 *
 * ENABLED, weight 1.0 — deliberately the permissive option. See resolvePerFlag.
 */
export const DEFAULT_PER_FLAG_ENTRY: Readonly<PerFlagEntry> = Object.freeze({
  enabled: true,
  weight: 1.0,
});

/**
 * Resolve the effective per_flag entry for one heuristic id.
 *
 * This is the ONLY place that decides what a missing entry means, and every
 * consumer of a stored config must route through it. Before this existed,
 * ingest read a missing entry as `{ enabled: true, weight: 1.0 }` while the
 * recompute path read it as disabled, so two flags that the server's config
 * had never listed (`inter_session_external_change`, `submitted_code_match`)
 * were scored at ingest and then silently erased — unscored and invisible —
 * the moment any staff member adjusted any weight.
 *
 * ## Why "enabled" rather than "disabled"
 *
 * Both are defensible: enabled-by-default fails safe toward surfacing
 * evidence, disabled-by-default fails safe toward not accusing. We choose
 * enabled, for four reasons:
 *
 *   1. A missing entry means "this flag is newer than this config row", not
 *      "staff turned this off". Staff intent to suppress a flag is always
 *      recorded explicitly as `enabled: false`; absence carries no intent, so
 *      inferring suppression from it invents a decision nobody made.
 *   2. Disabled-by-default is silent and indefinite. A newly shipped heuristic
 *      would stay invisible on every semester whose config predates it, with
 *      no signal anywhere that it was being suppressed — a clean-looking
 *      submission and a suppressed-flag submission are indistinguishable in
 *      the UI. An unexpectedly-present flag, by contrast, is visible and can
 *      be weighted down in one PUT.
 *   3. Flags are evidence for a human, not a verdict. Nothing is decided by
 *      score alone; staff read the timeline and the supporting events. The
 *      asymmetry that matters in an integrity proceeding is between "staff saw
 *      the evidence and judged it" and "staff never saw it" — and only the
 *      latter is unrecoverable.
 *   4. It matches the system's own stated default everywhere else:
 *      DEFAULT_SERVER_CONFIG enables every flag at weight 1.0, and migration
 *      0010 backfilled every semester with all-enabled. Enabled-by-default is
 *      the posture Provenance already ships; the ingest path was the one that
 *      already implemented it, and it is the one that has been running in
 *      production against every ingested submission.
 *
 * Predictability for pre-existing rows is provided by normalizeStoredConfig,
 * which materializes the same default into the config on read (and by
 * migration 0022, which materializes it in the stored rows), so a 24-entry row
 * behaves identically to the 26-entry row a staff member would write today.
 */
export function resolvePerFlag(config: ServerHeuristicConfig, heuristicId: string): PerFlagEntry {
  return config.per_flag[heuristicId] ?? DEFAULT_PER_FLAG_ENTRY;
}

/**
 * Fill in defaults for any known heuristic id a stored config is missing.
 *
 * Read-side upgrade path for `heuristic_configs.config` rows written before a
 * flag id existed. Rows backfilled by migration 0010 carry 24 entries; the
 * known set is now 26. Without this, the analyzer would GET a 24-entry config
 * and PUT it straight back, and validateConfig would 422 it for the two
 * entries the row could not possibly have contained when it was written.
 *
 * Entries that ARE present are returned untouched — including `enabled: false`
 * ones, which are recorded staff intent. Unknown ids are preserved rather than
 * dropped, for the same reason: if a heuristic is retired and later restored,
 * silently discarding the staff setting for it is worse than carrying a key
 * nobody reads. (validateConfig still rejects unknown ids on WRITE; this is a
 * read-side normalization, not a write-side one.)
 *
 * Pure: never mutates its input.
 */
export function normalizeStoredConfig(config: ServerHeuristicConfig): ServerHeuristicConfig {
  const perFlag: Record<string, PerFlagEntry> = { ...config.per_flag };
  for (const id of KNOWN_HEURISTIC_IDS) {
    if (perFlag[id] === undefined) {
      perFlag[id] = { ...DEFAULT_PER_FLAG_ENTRY };
    }
  }
  return {
    ...config,
    per_flag: perFlag,
  };
}

/** The default server-side config (all heuristics enabled, weight 1.0). */
export const DEFAULT_SERVER_CONFIG: ServerHeuristicConfig = {
  per_flag: Object.fromEntries(
    [...KNOWN_HEURISTIC_IDS].map((id) => [id, { ...DEFAULT_PER_FLAG_ENTRY }]),
  ),
  severity_weights: DEFAULT_SEVERITY_WEIGHTS,
  config_format_version: 1,
};

// ---------------------------------------------------------------------------
// getActiveConfig
// ---------------------------------------------------------------------------

export type ActiveConfigRow = {
  id: string;
  version: number;
  config: ServerHeuristicConfig;
  set_at: Date;
  note: string;
};

/**
 * Fetch the currently active heuristic config for a semester.
 *
 * Returns null if no active config exists (e.g. a semester created before
 * the backfill migration ran, or a semester with no admin member).
 * Callers that need a config should fall back to DEFAULT_SERVER_CONFIG in that case.
 *
 * The returned `config` is passed through normalizeStoredConfig, so a row
 * written before a flag id existed reads back with that id present at the
 * default entry. This keeps the GET → PUT round-trip valid (the PUT validator
 * requires an entry for every known id) and means ingest, recompute and the
 * API all observe the same complete per_flag map. The stored row is not
 * rewritten here — migration 0022 does that once, offline.
 */
export async function getActiveConfig(
  db: DrizzleDb,
  semesterId: string,
): Promise<ActiveConfigRow | null> {
  // Use is_active = true in the WHERE clause so Postgres can use the partial
  // unique index heuristic_configs_active_idx (WHERE is_active) — at most one
  // row is returned without a full table scan.
  const rows = await db
    .select({
      id: heuristic_configs.id,
      version: heuristic_configs.version,
      config: heuristic_configs.config,
      set_at: heuristic_configs.set_at,
      note: heuristic_configs.note,
    })
    .from(heuristic_configs)
    .where(
      and(eq(heuristic_configs.semester_id, semesterId), eq(heuristic_configs.is_active, true)),
    )
    .limit(1);

  const activeRow = rows[0];
  if (!activeRow) return null;

  return {
    id: activeRow.id,
    version: activeRow.version,
    config: normalizeStoredConfig(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb stored as unknown, validated at write-time
      activeRow.config as any as ServerHeuristicConfig,
    ),
    set_at: activeRow.set_at,
    note: activeRow.note,
  };
}

// ---------------------------------------------------------------------------
// listConfigHistory
// ---------------------------------------------------------------------------

export type ConfigHistoryRow = {
  id: string;
  version: number;
  set_at: Date;
  set_by: string;
  note: string;
  is_active: boolean;
};

/**
 * List all heuristic config versions for a semester, newest first.
 */
export async function listConfigHistory(
  db: DrizzleDb,
  semesterId: string,
): Promise<ConfigHistoryRow[]> {
  const rows = await db
    .select({
      id: heuristic_configs.id,
      version: heuristic_configs.version,
      set_at: heuristic_configs.set_at,
      set_by: heuristic_configs.set_by,
      note: heuristic_configs.note,
      is_active: heuristic_configs.is_active,
    })
    .from(heuristic_configs)
    .where(eq(heuristic_configs.semester_id, semesterId))
    .orderBy(desc(heuristic_configs.version));

  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    set_at: r.set_at,
    set_by: r.set_by,
    note: r.note,
    is_active: r.is_active,
  }));
}

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

export type ValidateConfigResult =
  | { ok: true; config: ServerHeuristicConfig }
  | { ok: false; errors: string[] };

/**
 * Validate a raw candidate config against PRD §10.2 rules.
 *
 * Rules:
 *   1. config_format_version must be 1.
 *   2. per_flag must have an entry for EVERY known heuristic ID (no missing).
 *   3. per_flag must NOT have entries for UNKNOWN heuristic IDs (no extras).
 *   4. Each entry's weight must be in [0, 100].
 *   5. Each entry's enabled must be a boolean.
 *   6. severity_weights must have all 4 keys (info, low, medium, high) with
 *      numeric values >= 0.
 *
 * The "known" set is KNOWN_HEURISTIC_IDS (per convention in plan §13a:
 * these are the known IDs; the set is the same as the migration backfill).
 */
export function validateConfig(input: unknown): ValidateConfigResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['config must be an object'] };
  }

  const obj = input as Record<string, unknown>;

  // Rule 1: config_format_version
  if (obj['config_format_version'] !== 1) {
    errors.push('config_format_version must be 1');
  }

  // Rule 6: severity_weights
  const sw = obj['severity_weights'];
  if (typeof sw !== 'object' || sw === null || Array.isArray(sw)) {
    errors.push('severity_weights must be an object');
  } else {
    const swObj = sw as Record<string, unknown>;
    for (const key of ['info', 'low', 'medium', 'high'] as const) {
      const val = swObj[key];
      if (typeof val !== 'number' || !isFinite(val) || val < 0) {
        errors.push(`severity_weights.${key} must be a non-negative number`);
      }
    }
    // No extra keys check for severity_weights — PRD doesn't require it.
  }

  // Rules 2, 3, 4, 5: per_flag
  const pf = obj['per_flag'];
  if (typeof pf !== 'object' || pf === null || Array.isArray(pf)) {
    errors.push('per_flag must be an object');
  } else {
    const pfObj = pf as Record<string, unknown>;
    const inputIds = new Set(Object.keys(pfObj));

    // Rule 3: reject unknown IDs
    for (const id of inputIds) {
      if (!KNOWN_HEURISTIC_IDS.has(id)) {
        errors.push(`per_flag contains unknown heuristic ID: '${id}'`);
      }
    }

    // Rule 2: missing IDs
    for (const id of KNOWN_HEURISTIC_IDS) {
      if (!inputIds.has(id)) {
        errors.push(`per_flag is missing required heuristic ID: '${id}'`);
      }
    }

    // Rules 4 and 5: validate each entry
    for (const id of inputIds) {
      if (!KNOWN_HEURISTIC_IDS.has(id)) continue; // already reported above
      const entry = pfObj[id];
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        errors.push(`per_flag['${id}'] must be an object`);
        continue;
      }
      const entryObj = entry as Record<string, unknown>;

      // Rule 5: enabled
      if (typeof entryObj['enabled'] !== 'boolean') {
        errors.push(`per_flag['${id}'].enabled must be a boolean`);
      }

      // Rule 4: weight in [0, 100]
      const w = entryObj['weight'];
      if (typeof w !== 'number' || !isFinite(w) || w < 0 || w > 100) {
        errors.push(`per_flag['${id}'].weight must be a number in [0, 100]`);
      }

      // thresholds is optional and opaque — no validation here.
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Safe cast: all validation passed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- validated above
  return { ok: true, config: input as any as ServerHeuristicConfig };
}

// ---------------------------------------------------------------------------
// commitNewVersion — Phase 13b
// ---------------------------------------------------------------------------

export type CommitNewVersionResult = {
  newConfigId: string;
  newVersion: number;
  newConfigSetAt: Date;
  recomputeJobId: string;
};

/**
 * Atomically commit a new active heuristic config version and create a
 * recompute_jobs row for it.
 *
 * Transaction contract:
 *   1. SELECT ... FOR UPDATE on the current active config row (advisory row-lock
 *      prevents concurrent commits from racing past the version bump).
 *   2. If-Match check INSIDE the transaction, after the lock is held.
 *      The loser of a concurrent race will observe the updated version under
 *      lock and throw CONFIG_VERSION_CONFLICT → 409 instead of a unique
 *      constraint violation → 500.
 *   3. UPDATE prior active row → is_active=false.
 *   4. INSERT new row → version=prior.version+1, is_active=true.
 *   5. INSERT recompute_jobs row → status='queued',
 *        progress_total = count of non-superseded submissions.
 *
 * The pg-boss enqueue (boss.send) MUST happen OUTSIDE this transaction so the
 * queue insert is not blocked by the row lock. Callers are responsible for
 * calling boss.send after the transaction commits.
 *
 * If no active config exists, version starts at 1 (and expectedVersion must be 0).
 *
 * @param db - Drizzle DB handle (transaction-capable).
 * @param semesterId - UUID of the semester.
 * @param candidateConfig - Already-validated ServerHeuristicConfig.
 * @param triggeredBy - UUID of the user committing the config.
 * @param note - Optional admin note for the config version.
 * @param expectedVersion - The If-Match version the caller observed before the
 *   transaction. Checked again after FOR UPDATE to close the TOCTOU race.
 */
export async function commitNewVersion(
  db: DrizzleDb,
  semesterId: string,
  candidateConfig: ServerHeuristicConfig,
  triggeredBy: string,
  note: string,
  expectedVersion: number,
): Promise<CommitNewVersionResult> {
  let newConfigId: string;
  let newVersion: number;
  let newConfigSetAt: Date;
  let recomputeJobId: string;

  await withTransaction(db, async (tx) => {
    // -------------------------------------------------------------------------
    // Step 1: Lock the current active config row.
    //
    // Using raw SQL for SELECT ... FOR UPDATE because Drizzle's typed builder
    // does not expose the FOR UPDATE clause (V25 pattern).
    // -------------------------------------------------------------------------
    const lockedRows = await tx.execute(sql`
      SELECT id, version
      FROM heuristic_configs
      WHERE semester_id = ${semesterId}
        AND is_active = true
      FOR UPDATE
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: postgres.js raw result
    const lockedRowsArr = lockedRows as any as Array<{ id: string; version: number }>;
    const currentActive = lockedRowsArr[0];
    const priorVersion = currentActive?.version ?? 0;
    newVersion = priorVersion + 1;

    // -------------------------------------------------------------------------
    // Step 1b: If-Match check INSIDE the transaction, after the lock is held.
    //
    // This closes the TOCTOU race: both concurrent requests can pass the
    // pre-tx If-Match check, but only the winner's committed version is visible
    // here under the FOR UPDATE lock. The loser sees priorVersion != expectedVersion
    // and throws CONFIG_VERSION_CONFLICT → 409 instead of crashing with a
    // unique constraint violation → 500.
    // -------------------------------------------------------------------------
    if (priorVersion !== expectedVersion) {
      throw Errors.configVersionConflict(priorVersion);
    }

    // -------------------------------------------------------------------------
    // Step 2: Deactivate the current active config (if one exists).
    // -------------------------------------------------------------------------
    if (currentActive) {
      await tx
        .update(heuristic_configs)
        .set({ is_active: false })
        .where(eq(heuristic_configs.id, currentActive.id));
    }

    // -------------------------------------------------------------------------
    // Step 3: Insert the new active config row.
    // -------------------------------------------------------------------------
    const [inserted] = await tx
      .insert(heuristic_configs)
      .values({
        semester_id: semesterId,
        version: newVersion,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- jsonb accepts validated config
        config: candidateConfig as any,
        set_by: triggeredBy,
        is_active: true,
        note,
      })
      .returning({ id: heuristic_configs.id, set_at: heuristic_configs.set_at });

    newConfigId = inserted!.id;
    newConfigSetAt = inserted!.set_at;

    // -------------------------------------------------------------------------
    // Step 4: Count non-superseded submissions for the recompute_jobs row.
    // -------------------------------------------------------------------------
    const countResult = await tx
      .select({ cnt: count() })
      .from(submissions)
      .where(
        and(
          eq(submissions.semester_id, semesterId),
          sql`${submissions.superseded_by_submission_id} IS NULL`,
        ),
      );
    const progressTotal = countResult[0]?.cnt ?? 0;

    // -------------------------------------------------------------------------
    // Step 5: Insert the recompute_jobs row.
    // -------------------------------------------------------------------------
    const [jobRow] = await tx
      .insert(recompute_jobs)
      .values({
        semester_id: semesterId,
        target_config_id: newConfigId,
        triggered_by: triggeredBy,
        status: 'queued',
        progress_total: progressTotal,
      })
      .returning({ id: recompute_jobs.id });

    recomputeJobId = jobRow!.id;
  });

  return {
    newConfigId: newConfigId!,
    newVersion: newVersion!,
    newConfigSetAt: newConfigSetAt!,
    recomputeJobId: recomputeJobId!,
  };
}

export type CreateRecomputeJobRow = {
  id: string;
  semester_id: string;
  target_config_id: string;
  triggered_by: string;
  status: string;
  progress_total: number;
  progress_done: number;
  progress_failed: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  summary: unknown;
};

/**
 * Insert a recompute_jobs row against the CURRENT active config (no config change).
 * Used by POST /recompute.
 *
 * Returns null if no active config exists for the semester.
 *
 * @param note - Optional admin note passed as { note?: string } in the request body.
 */
export async function createRecomputeJob(
  db: DrizzleDb,
  semesterId: string,
  triggeredBy: string,
  note?: string,
): Promise<{
  recomputeJobId: string;
  targetConfigId: string;
  jobRow: CreateRecomputeJobRow;
} | null> {
  const active = await getActiveConfig(db, semesterId);
  if (!active) return null;

  // Count non-superseded submissions for the progress_total field.
  const countResult = await db
    .select({ cnt: count() })
    .from(submissions)
    .where(
      and(
        eq(submissions.semester_id, semesterId),
        sql`${submissions.superseded_by_submission_id} IS NULL`,
      ),
    );
  const progressTotal = countResult[0]?.cnt ?? 0;

  const [insertedRow] = await db
    .insert(recompute_jobs)
    .values({
      semester_id: semesterId,
      target_config_id: active.id,
      triggered_by: triggeredBy,
      status: 'queued',
      progress_total: progressTotal,
      summary: note !== undefined ? { note } : {},
    })
    .returning();

  const jobRow: CreateRecomputeJobRow = {
    id: insertedRow!.id,
    semester_id: insertedRow!.semester_id,
    target_config_id: insertedRow!.target_config_id,
    triggered_by: insertedRow!.triggered_by,
    status: insertedRow!.status,
    progress_total: insertedRow!.progress_total,
    progress_done: insertedRow!.progress_done,
    progress_failed: insertedRow!.progress_failed,
    created_at: insertedRow!.created_at,
    started_at: insertedRow!.started_at ?? null,
    completed_at: insertedRow!.completed_at ?? null,
    summary: insertedRow!.summary,
  };

  return {
    recomputeJobId: insertedRow!.id,
    targetConfigId: active.id,
    jobRow,
  };
}
