/**
 * Phase 7 of the per-file ingest pipeline: compute and store per-file stats
 * (PRD §9.3, §5.4).
 *
 * Wraps v2's pure computeStats (over EventIndex built from the in-memory
 * bundle) and persists one row per file into per_file_stats. Idempotent via
 * ON CONFLICT DO UPDATE.
 *
 * final_length: reconstruct the file from the in-memory bundle and read content
 * length at the end of the stream.
 * start_length: length of the initial content carried by the file's first
 * `doc.open` event (recorder v1.1+). Pre-v1.1 doc.open has no content field
 * and start_length stays 0.
 */

import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { computeStats } from '@provenance/analysis-core/index/stats.js';
import { reconstructFileWithProvenance } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { per_file_stats, submissions } from '../../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../../db/client.js';

function startLengthForFile(events: IndexedEvent[] | undefined): number {
  if (events === undefined) return 0;
  for (const e of events) {
    if (e.kind !== 'doc.open') continue;
    const payload = e.payload as { content?: unknown } | null;
    if (payload !== null && typeof payload.content === 'string') {
      return payload.content.length;
    }
    return 0;
  }
  return 0;
}

export async function computeAndStoreStats(
  db: DrizzleDb,
  submissionId: string,
  bundle: Bundle,
  index: EventIndex = buildIndex(bundle),
): Promise<void> {
  const bundleStats = computeStats(index);

  // Always persist bundle-level times, even when there are no per-file rows
  // (a session with events but no file activity still has Active/Idle).
  await db
    .update(submissions)
    .set({
      total_active_ms: bundleStats.totalActiveMs,
      total_idle_ms: bundleStats.totalIdleMs,
    })
    .where(eq(submissions.id, submissionId));

  if (bundleStats.perFile.size === 0) return;

  const rows = Array.from(bundleStats.perFile.values()).map((fs) => {
    const replayState = reconstructFileWithProvenance(index, fs.filePath);
    return {
      submission_id: submissionId,
      file_path: fs.filePath,
      chars_typed: fs.charsTyped,
      chars_pasted: fs.charsPasted,
      chars_external_change_delta: fs.charsExternalChangeDelta,
      saves: fs.saves,
      final_length: replayState.content.length,
      start_length: startLengthForFile(index.byFile.get(fs.filePath)),
      reconstruction_tainted: fs.reconstructionTainted,
    };
  });

  await db
    .insert(per_file_stats)
    .values(rows)
    .onConflictDoUpdate({
      target: [per_file_stats.submission_id, per_file_stats.file_path],
      set: {
        chars_typed: sql`EXCLUDED.chars_typed`,
        chars_pasted: sql`EXCLUDED.chars_pasted`,
        chars_external_change_delta: sql`EXCLUDED.chars_external_change_delta`,
        saves: sql`EXCLUDED.saves`,
        final_length: sql`EXCLUDED.final_length`,
        start_length: sql`EXCLUDED.start_length`,
        reconstruction_tainted: sql`EXCLUDED.reconstruction_tainted`,
      },
    });
}
