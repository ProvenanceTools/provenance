/**
 * runAndStoreCrossHeuristics — Phase 14 semester-scoped cross-heuristic service.
 *
 * Runs cross-submission heuristics (paste_shared_across_students,
 * editing_pattern_clone) for all non-superseded submissions in a semester,
 * then atomically replaces the semester's cross_flags + cross_flag_participants
 * rows in a single transaction (DELETE-then-INSERT contract).
 *
 * ## DELETE-then-INSERT contract (V32)
 *
 * Unlike per-submission flags (which are per-submission scoped), cross_flags are
 * semester-scoped: the full set is recomputed from scratch on every run. We use
 * a DELETE-then-INSERT rather than merge/upsert because:
 *   1. A fresh run may produce FEWER flags than prior run (students removed,
 *      submissions superseded). Merge would leave stale rows.
 *   2. The set identity key for a cross_flag is not stable across runs —
 *      bundleIds ordering and heuristic index change when submissions are added.
 *   3. A single DELETE + N INSERTs is simpler to reason about and atomic under
 *      pg_advisory_lock (see advisory lock discussion in run-cross.ts).
 *
 * Uses pg_advisory_xact_lock inside the transaction to prevent concurrent
 * semester-level cross runs from racing on the DELETE-then-INSERT. The lock is
 * transaction-scoped and auto-released at COMMIT/ROLLBACK — no explicit unlock
 * needed, no pool-connection mismatch risk. Combined with pg-boss
 * singletonKey=semesterId, this ensures at most one cross-job runs per semester
 * at any time. See V32 for the rationale.
 *
 * ## Per-flag config
 *
 * The semester's active ServerHeuristicConfig gates which cross heuristics may
 * store rows, through the same `resolvePerFlag` accessor the per-submission
 * path uses (`enabled: false` → not stored; a missing entry → enabled at
 * weight 1.0). Combined with the DELETE-then-INSERT contract below, disabling a
 * cross heuristic removes the rows earlier passes wrote for it on the next run
 * — matching what a per-submission recompute does to a disabled flag's rows.
 *
 * ## Memory: compact features, not full bundles
 *
 * Cross-heuristics consume CrossSubmissionFeatures (paste records + a bounded
 * kind-stream n-gram fingerprint), extracted by streaming each submission from
 * the DB (extract-cross-features-from-db.ts). This avoids holding full Bundles +
 * EventIndices for the whole semester in memory at once, which OOM'd the worker.
 *
 * ## Bundle ID mapping (V32)
 *
 * Each submission is tagged with a fresh crypto.randomUUID() bundleId (the
 * original bundle id is not stored server-side). We maintain a
 * Map<bundleId, submissionId> from the iteration so the CrossFlag.bundleIds can
 * be translated back to submission UUIDs for the cross_flag_participants rows.
 *
 * ## seqKey → globalIdx translation
 *
 * CrossFlag.eventsPerBundle[bundleId] is a string[] of `${sessionId}:${seq}`
 * keys (same format as per-submission Flag.supportingSeqs). These are translated
 * to int[] of globalIdx values via a per-bundle seqKey→globalIdx map built during
 * feature extraction (covering exactly the referenceable events) — same globalIdx
 * values buildIndex would assign (chronological (wall, sessionId, seq) order).
 */

import { eq, isNull, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { runCrossHeuristics } from '@provenance/analysis-core/heuristics/cross/run-cross-heuristics.js';
import type {
  CrossFlag,
  CrossSubmissionFeatures,
} from '@provenance/analysis-core/heuristics/cross/types.js';
import { cross_flags, cross_flag_participants, submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { loadSubmissionIndex } from '../bundle/load-index.js';
import { extractCrossFeaturesFromIndex } from './extract-cross-features.js';
import { getActiveConfig, resolvePerFlag, DEFAULT_SERVER_CONFIG } from './config.js';
import type { ServerHeuristicConfig } from './config.js';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type RunCrossResult = {
  flag_count: number;
  participant_count: number;
};

type CrossFlagRow = typeof cross_flags.$inferInsert;
type ParticipantRow = typeof cross_flag_participants.$inferInsert;

// ---------------------------------------------------------------------------
// CrossFlag[] → DB rows
//
// Exported for unit testing — see run-cross.test.ts, which pins the per_flag
// gating without needing a container.
// ---------------------------------------------------------------------------

/**
 * Translate the cross-heuristic output into cross_flags + cross_flag_participants
 * rows, applying the semester's server-side per_flag config.
 *
 * This is the cross-path counterpart of `translateFlagsToRows` in
 * services/scoring/recompute-submission.ts, and deliberately makes the same
 * three decisions it does:
 *
 *   - `enabled: false` → the flag is not stored (PRD §10.3).
 *   - A MISSING per_flag entry → enabled at weight 1.0, via `resolvePerFlag`.
 *     Absence means the stored config predates the flag id, not that staff
 *     suppressed it; suppression is always written explicitly.
 *   - The gate is applied AFTER the heuristics run, on the emitted flags, so
 *     enabling and disabling an id cannot change what the other ids see.
 *
 * The filter runs here rather than by skipping registry entries inside
 * `runCrossHeuristics` because the config is a server concern and
 * analysis-core is isomorphic — the browser-only /local route runs the same
 * registry with no server config at all.
 *
 * ## Weight
 *
 * `weight` is resolved and returned per row but has nowhere to be applied:
 * `cross_flags` has no `score_contribution`/`weight_at_compute` column and a
 * cross flag contributes to no score anywhere (only per-submission `flags`
 * feed `submissions.score_total`). Wiring the weight through would mean
 * deciding whether — and into whose score — a cross flag counts, which is a
 * product decision, not a coding one. See the note in the tuning UI discussion
 * in the report; today the weight slider for the two cross ids is inert by
 * omission rather than by accident.
 */
export function translateCrossFlagsToRows(
  crossFlags: CrossFlag[],
  semesterId: string,
  bundleIdToSubmissionId: ReadonlyMap<string, string>,
  globalIdxBySeqKeyByBundle: ReadonlyMap<string, ReadonlyMap<string, number>>,
  config: ServerHeuristicConfig,
  configVersion: number,
): Array<{ flagRow: CrossFlagRow; participants: ParticipantRow[] }> {
  const rows: Array<{ flagRow: CrossFlagRow; participants: ParticipantRow[] }> = [];

  for (const cf of crossFlags) {
    const perFlagCfg = resolvePerFlag(config, cf.heuristic);

    // PRD §10.3: disabled heuristics contribute zero and are not stored.
    if (!perFlagCfg.enabled) {
      continue;
    }

    const flagId = crypto.randomUUID();

    const flagRow: CrossFlagRow = {
      id: flagId,
      semester_id: semesterId,
      heuristic_id: cf.heuristic,
      severity: cf.severity,
      confidence: cf.confidence,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FFI: jsonb
      detail: (cf.detail ?? {}) as any,
      heuristic_config_version: configVersion,
    };

    const participants: ParticipantRow[] = [];
    for (const bundleId of cf.bundleIds) {
      const submissionId = bundleIdToSubmissionId.get(bundleId);
      if (!submissionId) {
        // Should not happen: CrossFlag.bundleIds come from the bundles we built.
        continue;
      }

      // Translate seqKeys to globalIdx values via the per-bundle seqKey→globalIdx
      // map built during feature extraction (covers pastes + representatives).
      const globalIdxBySeqKey = globalIdxBySeqKeyByBundle.get(bundleId);
      const seqKeys = cf.eventsPerBundle[bundleId] ?? [];
      const globalIdxs: number[] = [];

      if (globalIdxBySeqKey) {
        for (const seqKey of seqKeys) {
          const globalIdx = globalIdxBySeqKey.get(seqKey);
          if (globalIdx !== undefined) {
            globalIdxs.push(globalIdx);
          }
        }
      }

      participants.push({
        cross_flag_id: flagId,
        submission_id: submissionId,
        supporting_seqs: globalIdxs,
      });
    }

    rows.push({ flagRow, participants });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run cross-submission heuristics for all non-superseded submissions in a
 * semester, then atomically replace the semester's cross_flags rows.
 *
 * Returns a summary of how many cross_flags and cross_flag_participants were
 * inserted.
 *
 * Called by the recompute_cross_flags pg-boss handler (which acquires the
 * semester-scoped advisory lock before calling this function).
 *
 * @param db         - Drizzle DB handle.
 * @param semesterId - UUID of the semester to run cross-heuristics for.
 */
export async function runAndStoreCrossHeuristics(
  db: DrizzleDb,
  storage: StorageClient,
  semesterId: string,
): Promise<RunCrossResult> {
  // -------------------------------------------------------------------------
  // Step 1: Get the active heuristic config for the semester.
  //
  // Supplies BOTH the heuristic_config_version stamped on cross_flags rows and
  // the per_flag gate applied in translateCrossFlagsToRows. Until 2026-08 only
  // `.version` was read here, so the analyzer's on/off toggle for the two cross
  // heuristics was inert — they fired and stored rows no matter what staff set.
  //
  // getActiveConfig returns the row already passed through
  // normalizeStoredConfig, so a config written before a flag id existed reads
  // back with that id at the default entry. Falls back to DEFAULT_SERVER_CONFIG
  // (everything enabled at weight 1.0) at version 0 when the semester has no
  // active config at all.
  // -------------------------------------------------------------------------
  const activeConfig = await getActiveConfig(db, semesterId);
  const config = activeConfig?.config ?? DEFAULT_SERVER_CONFIG;
  const configVersion = activeConfig?.version ?? 0;

  // -------------------------------------------------------------------------
  // Step 2: SELECT all non-superseded submissions in the semester.
  // -------------------------------------------------------------------------
  const submissionRows = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(eq(submissions.semester_id, semesterId), isNull(submissions.superseded_by_submission_id)),
    );

  if (submissionRows.length < 2) {
    // Cross-heuristics require at least 2 bundles. If there's 0 or 1, still
    // run the replace to clear stale cross_flags from prior runs (idempotency).
    await withTransaction(db, async (tx) => {
      // Acquire semester-scoped advisory lock (transaction-scoped; auto-released
      // at COMMIT/ROLLBACK — no pool-connection mismatch risk).
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          ('x' || substr(md5(${semesterId}::text), 1, 16))::bit(64)::bigint
        )
      `);
      await tx.delete(cross_flags).where(eq(cross_flags.semester_id, semesterId));
    });
    return { flag_count: 0, participant_count: 0 };
  }

  // -------------------------------------------------------------------------
  // Step 3: Extract compact cross-features from DB for each submission.
  //
  // We stream each submission's events and reduce them to CrossSubmissionFeatures
  // (paste records + a bounded kind-stream fingerprint) rather than holding full
  // Bundles + EventIndices for the whole semester in memory at once — the latter
  // OOM'd the worker on large cohorts (see extract-cross-features-from-db.ts).
  //
  // Maintain a Map<bundleId, submissionId> so we can translate CrossFlag.bundleIds
  // (which use the synthetic bundleId) back to submission UUIDs, and a
  // Map<bundleId, Map<seqKey, globalIdx>> for the supporting-seq translation that
  // formerly used each bundle's EventIndex.bySeq.
  // -------------------------------------------------------------------------
  const features: CrossSubmissionFeatures[] = [];
  const bundleIdToSubmissionId = new Map<string, string>();
  const globalIdxBySeqKeyByBundle = new Map<string, Map<string, number>>();

  for (const subRow of submissionRows) {
    const bundleId = crypto.randomUUID();
    const { bundle, index } = await loadSubmissionIndex(db, storage, subRow.id);
    const { features: f, globalIdxBySeqKey } = extractCrossFeaturesFromIndex(
      index,
      subRow.id,
      bundleId,
      bundle,
    );
    features.push(f);
    bundleIdToSubmissionId.set(bundleId, subRow.id);
    globalIdxBySeqKeyByBundle.set(bundleId, globalIdxBySeqKey);
  }

  // -------------------------------------------------------------------------
  // Step 4: Run cross-heuristics.
  // -------------------------------------------------------------------------
  const crossFlags = runCrossHeuristics(features, undefined);

  // -------------------------------------------------------------------------
  // Step 5: Translate CrossFlag[] → DB rows.
  //
  // For each CrossFlag, produce:
  //   - One cross_flags row with a fresh id.
  //   - N cross_flag_participants rows (one per bundleId in CrossFlag.bundleIds).
  //
  // seqKey → globalIdx translation: CrossFlag.eventsPerBundle[bundleId] is
  // `${sessionId}:${seq}[]`. We look up each seqKey in the bundle's EventIndex
  // to get the globalIdx (same pattern as per-submission flags in Phase 12/V28).
  //
  // The per_flag gate lives in translateCrossFlagsToRows: a heuristic the
  // semester's config disables produces no row here, so the DELETE-then-INSERT
  // below also clears any rows a previous, still-enabled pass wrote for it.
  // -------------------------------------------------------------------------
  const crossFlagRows = translateCrossFlagsToRows(
    crossFlags,
    semesterId,
    bundleIdToSubmissionId,
    globalIdxBySeqKeyByBundle,
    config,
    configVersion,
  );

  // -------------------------------------------------------------------------
  // Step 6: Atomically replace cross_flags for the semester.
  //
  // DELETE all existing cross_flags for this semester (CASCADE removes
  // cross_flag_participants). INSERT new cross_flags + participants.
  //
  // This is the DELETE-then-INSERT contract (V32). The advisory lock held by
  // the caller prevents concurrent semester-level cross runs from racing here.
  // -------------------------------------------------------------------------
  let totalParticipants = 0;

  await withTransaction(db, async (tx) => {
    // Acquire semester-scoped advisory lock (transaction-scoped; auto-released
    // at COMMIT/ROLLBACK — no pool-connection mismatch risk).
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        ('x' || substr(md5(${semesterId}::text), 1, 16))::bit(64)::bigint
      )
    `);

    // DELETE cascades to cross_flag_participants via FK ON DELETE CASCADE.
    await tx.delete(cross_flags).where(eq(cross_flags.semester_id, semesterId));

    for (const { flagRow, participants } of crossFlagRows) {
      await tx.insert(cross_flags).values(flagRow);

      if (participants.length > 0) {
        await tx.insert(cross_flag_participants).values(participants);
        totalParticipants += participants.length;
      }
    }
  });

  return {
    flag_count: crossFlagRows.length,
    participant_count: totalParticipants,
  };
}
