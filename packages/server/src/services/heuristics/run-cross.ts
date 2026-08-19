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
import type { CrossSubmissionFeatures } from '@provenance/analysis-core/heuristics/cross/types.js';
import { cross_flags, cross_flag_participants, submissions } from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import { withTransaction } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { loadSubmissionIndex } from '../bundle/load-index.js';
import { extractCrossFeaturesFromIndex } from './extract-cross-features.js';
import { getActiveConfig } from './config.js';

// ---------------------------------------------------------------------------
// Return type
// ---------------------------------------------------------------------------

export type RunCrossResult = {
  flag_count: number;
  participant_count: number;
};

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
  // Step 1: Get active heuristic config version for the semester.
  //
  // Needed for heuristic_config_version column on cross_flags rows.
  // Falls back to DEFAULT_SERVER_CONFIG version 0 if no active config.
  // -------------------------------------------------------------------------
  const activeConfig = await getActiveConfig(db, semesterId);
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
  // -------------------------------------------------------------------------
  type CrossFlagRow = typeof cross_flags.$inferInsert;
  type ParticipantRow = typeof cross_flag_participants.$inferInsert;

  const crossFlagRows: Array<{ flagRow: CrossFlagRow; participants: ParticipantRow[] }> = [];

  for (const cf of crossFlags) {
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

    crossFlagRows.push({ flagRow, participants });
  }

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
