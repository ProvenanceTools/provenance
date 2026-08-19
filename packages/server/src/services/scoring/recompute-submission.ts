/**
 * recomputeSubmission — Phase 13b per-submission heuristic recompute service.
 *
 * Loads the Bundle from its stored blob, re-runs validation, runs the full
 * heuristic suite, and either:
 *   - Updates flags + submission score in a single transaction (simulate=false).
 *   - Returns prospective scores without any DB writes (simulate=true).
 *
 * ## Bundle reconstruction strategy (Strategy A — see V31)
 *
 * v2's runHeuristics(index, bundle, validationReport, config) receives both an
 * EventIndex and a Bundle. After auditing all 18 heuristics in the registry:
 *
 *   - 17 heuristics: only use `index` (EventIndex). No direct `bundle.*` access
 *     in their `run()` functions.
 *   - 1 heuristic: `extension_hash_mismatch` reads `bundle.manifest.extension_hash`.
 *
 * Bundle reconstruction is delegated to the shared helper in
 * services/heuristics/reconstruct-bundle.ts (extracted in Phase 14 so
 * run-cross.ts can reuse the same logic). See V31 + V32 for design decisions.
 *
 * ## ValidationReport
 *
 * `integrityFlagsFromReport` (called by runHeuristics) reads the ValidationReport
 * to produce chain_broken / manifest_sig_invalid / etc. flags.
 *
 * We RE-RUN validation here rather than reading the stored `validation_results`
 * row. Reusing the stored row meant a recompute could never correct a wrong
 * validation verdict — and since the report feeds runHeuristics, a stale
 * check-8 failure kept re-emitting a high-severity flag on every recompute.
 * Re-running is safe against a stored, source-stripped bundle: every check
 * reads the signed manifest, the .slog chain, or recorded event hashes, none of
 * which are stripped. simulate=true computes the report without persisting it.
 *
 * ## Transaction contract
 *
 * simulate=false writes:
 *   1. UPDATE submissions SET recompute_status='recomputing' WHERE id=...
 *   2. DELETE FROM flags WHERE submission_id=...
 *   3. INSERT INTO flags (...) VALUES ...
 *   4. UPSERT per_file_stats (...) — see below
 *   5. UPDATE submissions SET score_total=..., score_max_severity=...,
 *        heuristic_config_version=..., recompute_status='fresh' WHERE id=...
 *
 * All 5 writes are in a single transaction so pg-boss retry sees a clean state
 * on rollback.
 *
 * ## Why per_file_stats is rewritten here
 *
 * per_file_stats was previously written only at ingest, so two of its columns
 * were derived once and never corrected: `reconstruction_tainted` (which the
 * Source tab reads to decide whether to trust a reconstruction) and
 * `chars_external_change_delta` (which the Stats panel attributes to external
 * writes). Both are downstream of exactly the analyzer verdicts a recompute
 * exists to revise — e.g. reclassifying a batch of false `fs.external_change`
 * events flips a file from tainted to clean — so leaving them frozen at their
 * ingest values meant a recompute silently fixed the flags while the stats kept
 * telling staff the old story.
 *
 * This mirrors ingest, which also calls computeAndStoreStats inside its
 * transaction (worker.ts, attach.ts). The upsert is keyed on
 * (submission_id, file_path) and is idempotent, matching the rest of the
 * pipeline's retry contract.
 *
 * If simulate=true, none of the above writes occur. The function is pure-ish
 * (reads from DB, no writes).
 */

import { eq, inArray, isNull, and } from 'drizzle-orm';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { runHeuristics } from '@provenance/analysis-core/heuristics/run-heuristics.js';
import type { HeuristicConfig } from '@provenance/analysis-core/heuristics/config.js';
import type { Severity } from '@provenance/analysis-core/heuristics/types.js';
import { flags, submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import type { ServerHeuristicConfig } from '../heuristics/config.js';
import { resolvePerFlag } from '../heuristics/config.js';
import { reconstructBundleFromDb } from '../heuristics/reconstruct-bundle.js';
import { runValidation } from '@provenance/analysis-core/validation/run-validation.js';
import { runAndStoreValidation } from '../ingest/validation.js';
import { computeAndStoreStats } from '../ingest/stats.js';
import { computeScore } from './compute.js';
import { computeFlagCounts, computeTopFlags } from './denorm.js';

// ---------------------------------------------------------------------------
// Threshold forwarding: ServerHeuristicConfig.per_flag[id].thresholds →
//   v2 Partial<HeuristicConfig>
//
// PRD §10.2 stores per-heuristic thresholds as an opaque `thresholds?: jsonb`
// under each per_flag entry. The intended runtime contract (encoded here) is:
//
//   - The keys of `thresholds` mirror v2's HeuristicConfig sub-shape for that
//     heuristic. e.g. per_flag['large_paste'].thresholds = { minChars: 300 }
//     maps to v2's largePaste.minChars = 300.
//   - The map below translates the snake_case heuristic_id used by the server
//     to v2's camelCase top-level key. Only heuristics that have a
//     configurable threshold block in DEFAULT_HEURISTIC_CONFIG are listed;
//     integrity-derived flags (chain_broken, manifest_sig_invalid, etc.)
//     have no thresholds and are absent on purpose.
//
// Prior to this layer, configOverride was hardcoded to `undefined`, so
// threshold changes in the candidate config were silently dropped by
// dry-run AND by the recompute worker. See V46 in .notes/v3-progress.md.
// ---------------------------------------------------------------------------

const HEURISTIC_ID_TO_V2_KEY: Readonly<Record<string, keyof HeuristicConfig>> = {
  large_paste: 'largePaste',
  external_edits: 'externalEdits',
  low_typing_high_output: 'lowTypingHighOutput',
  paste_is_solution: 'pasteIsSolution',
  mass_external_replacement: 'massExternalReplacement',
  time_to_first_save_anomaly: 'timeToFirstSaveAnomaly',
  idle_then_complete: 'idleThenComplete',
  paste_matches_known_source: 'pasteMatchesKnownSource',
  ai_extension_active: 'aiExtensionActive',
  extension_hash_mismatch: 'extensionHashMismatch',
  clock_jumps: 'clockJumps',
  gap_in_heartbeats: 'gapInHeartbeats',
};

export function thresholdsToV2Override(
  config: ServerHeuristicConfig,
): Partial<HeuristicConfig> | undefined {
  const override: Partial<HeuristicConfig> = {};
  let hasAny = false;
  for (const [serverId, v2Key] of Object.entries(HEURISTIC_ID_TO_V2_KEY)) {
    const entry = config.per_flag[serverId];
    const t = entry?.thresholds;
    if (t && typeof t === 'object' && !Array.isArray(t) && Object.keys(t).length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- thresholds is opaque jsonb (PRD §10.2); v2 mergeConfig does the shallow merge against its known shape
      (override as Record<string, unknown>)[v2Key] = t as any;
      hasAny = true;
    }
  }
  return hasAny ? override : undefined;
}

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type RecomputeResult = {
  score_total: number;
  score_max_severity: Severity;
  flag_count: number;
};

// ---------------------------------------------------------------------------
// Translate Flag[] to DB rows (same logic as run-per-submission.ts)
//
// Exported for unit testing — see recompute-submission.test.ts, which pins the
// missing-per_flag-entry behaviour without needing a container.
// ---------------------------------------------------------------------------

type FlagRow = typeof flags.$inferInsert;

export function translateFlagsToRows(
  rawFlags: ReturnType<typeof runHeuristics>,
  index: ReturnType<typeof buildIndex>,
  submissionId: string,
  semesterId: string,
  config: ServerHeuristicConfig,
  configVersion: number,
): { flagRows: FlagRow[]; scoreInputs: Array<{ severity: string; score_contribution: number }> } {
  const flagRows: FlagRow[] = [];
  const scoreInputs: Array<{ severity: string; score_contribution: number }> = [];

  for (const flag of rawFlags) {
    // A missing per_flag entry means the stored config predates this flag id,
    // NOT that staff disabled it — resolvePerFlag supplies the enabled default
    // and is the same function ingest uses, so the two paths cannot disagree.
    // This line used to read `if (!perFlagCfg || !perFlagCfg.enabled) continue`,
    // which silently erased every flag the config had never listed.
    const perFlagCfg = resolvePerFlag(config, flag.heuristic);

    // PRD §10.3: disabled heuristics contribute zero and are not stored.
    if (!perFlagCfg.enabled) {
      continue;
    }

    // Translate supportingSeqs: string[] → int[] of globalIdx values.
    const globalIdxs: number[] = [];
    for (const seqKey of flag.supportingSeqs) {
      const event = index.bySeq.get(seqKey);
      if (event !== undefined) {
        globalIdxs.push(event.globalIdx);
      }
    }

    // Determine session_id: set if all supporting seqs share the same session.
    let sessionId = '';
    if (flag.supportingSeqs.length > 0) {
      const uniqueSessions = new Set<string>();
      for (const seqKey of flag.supportingSeqs) {
        const lastColon = seqKey.lastIndexOf(':');
        if (lastColon !== -1) {
          uniqueSessions.add(seqKey.slice(0, lastColon));
        }
      }
      if (uniqueSessions.size === 1) {
        sessionId = uniqueSessions.values().next().value!;
      }
    }

    // score_contribution = severity_weights[severity] * confidence * weight
    const severityWeight =
      config.severity_weights[flag.severity as keyof typeof config.severity_weights] ?? 0;
    const scoreContribution = severityWeight * flag.confidence * perFlagCfg.weight;

    const row: FlagRow = {
      submission_id: submissionId,
      semester_id: semesterId,
      heuristic_id: flag.heuristic,
      severity: flag.severity,
      confidence: flag.confidence,
      weight_at_compute: perFlagCfg.weight,
      score_contribution: scoreContribution,
      title: flag.title,
      description: flag.description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: jsonb accepts JSON-serializable value
      detail: (flag.detail ?? {}) as any,
      supporting_seqs: globalIdxs,
      session_id: sessionId,
      heuristic_config_version: configVersion,
    };

    flagRows.push(row);
    scoreInputs.push({ severity: flag.severity, score_contribution: scoreContribution });
  }

  return { flagRows, scoreInputs };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Recompute heuristics for a single submission using the given config.
 *
 * If simulate=false (default): rewrites flags and updates the submission row
 * inside a single transaction.
 *
 * If simulate=true: reads events + validation, runs heuristics, returns the
 * prospective scores WITHOUT any DB writes.
 *
 * @param db - Drizzle DB handle.
 * @param submissionId - UUID of the submission to recompute.
 * @param semesterId - UUID of the semester (FK for flag rows).
 * @param config - The ServerHeuristicConfig to apply.
 * @param configVersion - The version number to write to flags.heuristic_config_version.
 * @param options.simulate - If true, skip all writes (dry-run mode).
 */
export async function recomputeSubmission(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  semesterId: string,
  config: ServerHeuristicConfig,
  configVersion: number,
  { simulate = false }: { simulate?: boolean } = {},
): Promise<RecomputeResult> {
  // -------------------------------------------------------------------------
  // Step 1: Reconstruct Bundle + EventIndex + ValidationReport from DB.
  //
  // Delegates to the shared reconstructBundleFromDb helper (extracted in
  // Phase 14 for reuse by run-cross.ts). See V31/V32 for strategy rationale.
  // -------------------------------------------------------------------------
  const { bundle, index: reconstructedIndex } = await reconstructBundleFromDb(
    db,
    storage,
    submissionId,
  );

  // -------------------------------------------------------------------------
  // Step 1b: RE-RUN validation against the freshly parsed bundle.
  //
  // reconstructBundleFromDb returns the STORED validation_results row, which is
  // whatever ingest computed at the time — with whatever analyzer bugs were
  // live then. Reusing it means a recompute can never correct a wrong
  // validation verdict, and (because runHeuristics takes the report as input)
  // a stale check-8 failure keeps re-emitting a high-severity flag forever.
  //
  // Re-running is safe against a stored, source-stripped bundle: every check
  // reads the signed manifest, the .slog chain, or recorded event hashes, all
  // of which survive stripping. Check 8's tamper sub-check is gated on
  // submitted bytes actually being present (see verify-submitted-code.ts).
  //
  // simulate = dry-run: compute the report but persist nothing.
  // -------------------------------------------------------------------------
  const validationReport = simulate
    ? await runValidation(bundle)
    : await runAndStoreValidation(db, submissionId, bundle);

  // -------------------------------------------------------------------------
  // Step 2: Build EventIndex and run heuristics.
  //
  // reconstructBundleFromDb already calls buildIndex; we call it again here
  // to get the same index as a ReturnType<typeof buildIndex> for translateFlagsToRows.
  // This is a cheap O(n_events) operation (~1ms for typical bundles; V27).
  //
  // configOverride: thresholds from per_flag[id].thresholds are forwarded to
  // v2's HeuristicConfig shape via thresholdsToV2Override. Heuristics that
  // omit thresholds fall back to v2's DEFAULT_HEURISTIC_CONFIG. The
  // server-side enabled/weight/severity_weights are applied below when
  // translating flags to DB rows.
  //
  // V46 regression fix: prior to this, configOverride was hardcoded to
  // `undefined` so threshold changes were silently dropped — invalidating
  // both dry-run and the live recompute path. See V46 in .notes/v3-progress.md.
  // -------------------------------------------------------------------------
  const index = buildIndex(bundle);
  void reconstructedIndex; // the helper's copy; we rebuild for type compatibility
  const rawFlags = runHeuristics(index, bundle, validationReport, thresholdsToV2Override(config));

  // -------------------------------------------------------------------------
  // Step 3: Translate flags to DB rows using the server-side config.
  // -------------------------------------------------------------------------
  const { flagRows, scoreInputs } = translateFlagsToRows(
    rawFlags,
    index,
    submissionId,
    semesterId,
    config,
    configVersion,
  );

  // -------------------------------------------------------------------------
  // Step 4: Compute aggregate score.
  // -------------------------------------------------------------------------
  const { score_total, score_max_severity } = computeScore(scoreInputs);
  const flag_count = flagRows.length;

  if (simulate) {
    // Dry-run: return scores without writing anything.
    return { score_total, score_max_severity, flag_count };
  }

  // -------------------------------------------------------------------------
  // Step 5: Write to DB in a single transaction.
  //
  // 5a. Mark submission as recomputing (visible to other readers during recompute).
  // 5b. Delete all existing flags.
  // 5c. Insert new flags.
  // 5d. Rewrite per_file_stats from the freshly parsed bundle.
  // 5e. Update submission score + heuristic_config_version + recompute_status='fresh'.
  //
  // All 5 writes are atomic: a retry after crash sees a clean state.
  // -------------------------------------------------------------------------
  await withTransaction(db, async (tx) => {
    // 5a: recomputing sentinel
    await tx
      .update(submissions)
      .set({ recompute_status: 'recomputing' })
      .where(eq(submissions.id, submissionId));

    // 5b: DELETE old flags
    await tx.delete(flags).where(eq(flags.submission_id, submissionId));

    // 5c: INSERT new flags (skip if empty)
    if (flagRows.length > 0) {
      await tx.insert(flags).values(flagRows);
    }

    // 5d: UPSERT per_file_stats. Same call ingest makes, against the same
    // in-memory bundle + index, so the two paths cannot drift.
    await computeAndStoreStats(tx, submissionId, bundle, index);

    // 5e: UPDATE submission — including the P1-1a denormalized cohort
    // columns so the read path can skip the per-page sub-queries.
    // severity_rank is GENERATED from score_max_severity in DB.
    await tx
      .update(submissions)
      .set({
        score_total,
        score_max_severity,
        heuristic_config_version: configVersion,
        recompute_status: 'fresh',
        flag_counts: computeFlagCounts(flagRows),
        top_flags: computeTopFlags(flagRows),
      })
      .where(eq(submissions.id, submissionId));
  });

  return { score_total, score_max_severity, flag_count };
}

// ---------------------------------------------------------------------------
// Exported helper: enumerate non-superseded submissions in a semester
// ---------------------------------------------------------------------------

/**
 * Return IDs of all non-superseded submissions in a semester.
 * Used by the recompute_semester worker to build the work queue.
 */
export async function getNonSupersededSubmissionIds(
  db: DrizzleDb,
  semesterId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(eq(submissions.semester_id, semesterId), isNull(submissions.superseded_by_submission_id)),
    );
  return rows.map((r) => r.id);
}

/**
 * Mark a list of submission IDs as 'stale' (recompute pending).
 * Called by the recompute_semester worker before dispatching per-submission jobs.
 */
export async function markSubmissionsStale(db: DrizzleDb, submissionIds: string[]): Promise<void> {
  if (submissionIds.length === 0) return;
  await db
    .update(submissions)
    .set({ recompute_status: 'stale' })
    .where(inArray(submissions.id, submissionIds));
}

/**
 * Mark a submission as 'error' due to a recompute failure.
 */
export async function markSubmissionRecomputeError(
  db: DrizzleDb,
  submissionId: string,
): Promise<void> {
  await db
    .update(submissions)
    .set({ recompute_status: 'error' })
    .where(eq(submissions.id, submissionId));
}
