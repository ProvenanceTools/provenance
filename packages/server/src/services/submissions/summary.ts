/**
 * Submission summary service — PRD §8.9.
 *
 * Aggregates the GET /submissions/{id} response from already-stored rows:
 *   - submissions (core columns)
 *   - JOIN assignments (id, assignment_id_str, label)
 *   - JOIN roster_entries (id, sid, display_name)
 *   - flag_counts: {info,low,medium,high} via GROUP BY severity
 *   - session_ids: string[] via DISTINCT events.session_id
 *   - files: {path,final_length,saves}[] from per_file_stats
 *   - validation_overall_detail: string | null — synthesized from validation_results.detail
 *
 * validation_overall_detail synthesis:
 *   Reads the jsonb detail array (array of ValidationCheck objects stored by
 *   runAndStoreValidation). Extracts checks whose status is 'fail' or 'skipped'.
 *   Formats them as "id=status (cause: detail)" joined by ", ". Returns null if
 *   all checks pass.
 *
 * Implementation: 4 separate queries (submissions+joins, flags aggregate,
 * session_ids distinct, per_file_stats) rather than a single sprawling JOIN.
 * Readable and performant at the scale of a single submission.
 */

import { eq, sql } from 'drizzle-orm';
import {
  submissions,
  assignments,
  roster_entries,
  flags,
  per_file_stats,
  validation_results,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { loadSubmissionIndex } from '../bundle/load-index.js';
import { summarizeBundleManifest } from '@provenance/analysis-core/manifest/bundle-manifest.js';
import type { BundleManifestSummary } from '@provenance/analysis-core/manifest/bundle-manifest.js';
import { coverageFacts } from '@provenance/analysis-core/coverage/coverage-facts.js';
import type { CoverageFacts } from '@provenance/analysis-core/coverage/coverage-facts.js';
import { projectStudent, maskFilename, protectedLabel } from '../protect.js';
import { fetchContributors } from '../contributors/fetch-contributors.js';
import type { SubmissionContributor } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export type SubmissionSummary = {
  id: string;
  semester_id: string;
  assignment: { id: string; assignment_id_str: string; label: string };
  /**
   * The submitter of record, or null when no single roster entry owns this
   * submission (D9). Mirrors `SubmissionSummarySchema.student` in
   * `@provenance/shared`.
   */
  student: { id: string; sid: string; display_name: string } | null;
  /** Everyone this submission is attributable to. Exactly one entry for solo. */
  contributors: SubmissionContributor[];
  ingested_at: string;
  source_filename: string;
  blob_sha256: string;
  recorder_version: string;
  format_version: string;
  version_index: number;
  validation_status: string;
  validation_overall_detail: string | null;
  score_total: number;
  score_max_severity: string;
  flag_count: number;
  flag_counts: { info: number; low: number; medium: number; high: number };
  session_ids: string[];
  /**
   * Per-session metadata in bundle (chronological) order. Same source as
   * session_ids — the already-loaded bundle + index — so it adds no query and
   * no extra blob parse, and it saves the analyzer from paging the whole event
   * stream just to label a submission's sessions.
   */
  sessions: { session_id: string; started_at: string | null; event_count: number }[];
  files: { path: string; final_length: number; saves: number }[];
  /**
   * The assignment manifest carried inside the bundle (program spec §3).
   *
   * Derived from the same `loadSubmissionIndex` call that produces
   * `session_ids`, so it costs no extra query and no extra blob parse. For a
   * 1.0/1.1 bundle this is the "nothing recorded" shape: `format_version:
   * '1.x'`, every field null, no disabled signals, `trust_chain: 'legacy'`.
   *
   * Staff need `disabled_signals` in particular: it is what tells them a signal
   * is absent by course policy rather than by student omission.
   */
  assignment_manifest: BundleManifestSummary;
  /**
   * The coverage stage's facts (§6 Rule 3) — concurrent recording, identity
   * counts, commit-graph coverage, DAG defects, the single-repository caveat,
   * unattested seal tails, dropped artifacts.
   *
   * Same source as `sessions` and `assignment_manifest`: the already-parsed
   * bundle + index, so it adds no query and no extra blob parse.
   * `coverageFacts` is pure and isomorphic — nothing new is computed here, it is
   * the same function `/local` runs in the browser.
   *
   * ALWAYS present on this response. Its absence on the wire means exactly one
   * thing — the client is talking to a server that predates the field — and the
   * analyzer renders that as "not available", never as a page of zeroes. A
   * route that shipped an empty-but-present object would destroy that
   * distinction: zeroes assert "no commits observed, no contributors, no root
   * key", which is a stronger and FALSE claim than "not available".
   *
   * This is the `CoverageFacts` AGGREGATE and must stay so. `BundleContributors`
   * must never be put on the wire in its place: its `bySession` is a
   * `ReadonlyMap`, which `JSON.stringify` renders as `{}` — a silent
   * "no contributors" for every submission.
   */
  coverage: CoverageFacts;
  superseded: boolean;
  superseded_by_submission_id: string | null;
  heuristic_config_version: number;
  recompute_status: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Synthesize a human-readable validation detail string from the stored jsonb.
 *
 * The detail column stores the ValidationCheck array as-is (from runValidation).
 * We extract failed/skipped checks and format: "id=status (cause: detail)".
 * If all pass, return null.
 */
function synthesizeValidationDetail(detail: unknown, overall: string): string | null {
  if (overall === 'pass') return null;
  if (!Array.isArray(detail)) return null;

  const failing: string[] = [];
  for (const check of detail) {
    if (check !== null && typeof check === 'object' && 'id' in check && 'status' in check) {
      const c = check as { id: string; status: string; detail?: string };
      if (c.status === 'fail' || c.status === 'skipped') {
        const cause = c.detail ? ` (cause: ${c.detail})` : '';
        failing.push(`${c.id}=${c.status}${cause}`);
      }
    }
  }

  return failing.length > 0 ? failing.join(', ') : null;
}

// ---------------------------------------------------------------------------
// Main query
// ---------------------------------------------------------------------------

export async function getSubmissionSummary(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  protectedMode: boolean,
  /**
   * Manifest 2.0 ROOT public key, for the `assignment_manifest.trust_chain`
   * verdict. A parameter rather than a config read so this service stays
   * testable without a full env; the route supplies `rootPublicKeyHex()`.
   * Omitted means the chain is reported as `unconfigured` for 2.0 bundles and
   * `legacy` for 1.x ones.
   */
  rootPubkeyHex?: string,
): Promise<SubmissionSummary | null> {
  // Query 1: core submission + assignment + student JOINs
  const rows = await db
    .select({
      id: submissions.id,
      semester_id: submissions.semester_id,
      ingested_at: submissions.ingested_at,
      source_filename: submissions.source_filename,
      blob_sha256: submissions.blob_sha256,
      recorder_version: submissions.recorder_version,
      format_version: submissions.format_version,
      validation_status: submissions.validation_status,
      score_total: submissions.score_total,
      score_max_severity: submissions.score_max_severity,
      heuristic_config_version: submissions.heuristic_config_version,
      recompute_status: submissions.recompute_status,
      superseded_by_submission_id: submissions.superseded_by_submission_id,
      version_index: submissions.version_index,
      assignment_id: assignments.id,
      assignment_id_str: assignments.assignment_id_str,
      assignment_label: assignments.label,
      student_id: roster_entries.id,
      student_sid: roster_entries.sid,
      student_display_name: roster_entries.display_name,
      student_protected_index: roster_entries.protected_index,
    })
    .from(submissions)
    .innerJoin(assignments, eq(submissions.assignment_id, assignments.id))
    // LEFT, not INNER (D9). THIS is the one that mattered most: with an INNER
    // join, a submission whose roster join came back empty produced zero rows,
    // this function returned null, and the route turned that null into a 404 —
    // so the entire submission detail shell (overview, timeline, replay,
    // validation, source) went missing for a submission that exists and is
    // perfectly analysable. "No single owning student" and "no such submission"
    // are different facts and must not share a response.
    //
    // Now the row always comes back and `student` carries the absence. The
    // null return below is reserved for its real meaning: no such submission.
    .leftJoin(roster_entries, eq(submissions.student_id, roster_entries.id))
    .where(eq(submissions.id, submissionId))
    .limit(1);

  // The only remaining null: there is no submission with this id.
  if (rows.length === 0) return null;
  const row = rows[0]!;

  // Everyone this submission is attributable to (D9). Always populated for a
  // solo submission — exactly one entry, the same student `student` names.
  const contributors = await fetchContributors(db, submissionId, protectedMode);

  // Query 2: flag_counts (GROUP BY severity)
  const flagRows = await db
    .select({
      severity: flags.severity,
      count: sql<number>`count(*)::int`,
    })
    .from(flags)
    .where(eq(flags.submission_id, submissionId))
    .groupBy(flags.severity);

  const flag_counts = { info: 0, low: 0, medium: 0, high: 0 };
  for (const f of flagRows) {
    const sev = f.severity as 'info' | 'low' | 'medium' | 'high';
    if (sev in flag_counts) flag_counts[sev] = f.count;
  }
  const flag_count = flag_counts.info + flag_counts.low + flag_counts.medium + flag_counts.high;

  // Query 3: session_ids from the stored bundle's sessions (events are no longer
  // persisted in Postgres; the bundle blob is the source of the event stream).
  const { bundle, index } = await loadSubmissionIndex(db, storage, submissionId);
  const assignment_manifest = await summarizeBundleManifest(bundle, rootPubkeyHex);
  const session_ids = bundle.sessions.map((s) => s.sessionId);
  const sessions = bundle.sessions.map((s) => ({
    session_id: s.sessionId,
    started_at: s.firstEvent?.wall ?? null,
    event_count: index.bySessionId.get(s.sessionId)?.length ?? 0,
  }));
  // Same bundle + index, one more pure call. The contributor stamp it reads was
  // established inside loadSubmissionIndex, so this is server/`/local` parity by
  // running the identical function, not by reimplementing it.
  const coverage = coverageFacts(bundle, index);

  // Query 4: per_file_stats for files list
  const fileRows = await db
    .select({
      path: per_file_stats.file_path,
      final_length: per_file_stats.final_length,
      saves: per_file_stats.saves,
    })
    .from(per_file_stats)
    .where(eq(per_file_stats.submission_id, submissionId));

  const files = fileRows.map((f) => ({
    path: f.path,
    final_length: f.final_length,
    saves: f.saves,
  }));

  // Query 5: validation detail (for synthesis)
  const valRows = await db
    .select({ overall: validation_results.overall, detail: validation_results.detail })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId))
    .limit(1);

  const validation_overall_detail =
    valRows.length > 0 ? synthesizeValidationDetail(valRows[0]!.detail, valRows[0]!.overall) : null;

  return {
    id: row.id,
    semester_id: row.semester_id,
    assignment: {
      id: row.assignment_id,
      assignment_id_str: row.assignment_id_str,
      label: row.assignment_label,
    },
    student:
      row.student_id === null || row.student_sid === null || row.student_display_name === null
        ? null
        : projectStudent(
            {
              id: row.student_id,
              sid: row.student_sid,
              display_name: row.student_display_name,
              protected_index: row.student_protected_index,
            },
            protectedMode,
          ),
    contributors,
    ingested_at: row.ingested_at.toISOString(),
    // The protected-mode filename label is derived from the submitter when
    // there is one. With no single student the submission id is the only
    // non-PII handle available, and `protectedLabel` already falls back to a
    // uuid stub — so this stays a stable, name-independent placeholder either
    // way and never degrades to a real filename.
    source_filename: maskFilename(
      row.source_filename,
      protectedMode,
      `${protectedLabel(row.student_protected_index, row.student_id ?? row.id)} — submission`,
    ),
    blob_sha256: row.blob_sha256,
    recorder_version: row.recorder_version,
    format_version: row.format_version,
    version_index: row.version_index,
    validation_status: row.validation_status,
    validation_overall_detail,
    score_total: row.score_total,
    score_max_severity: row.score_max_severity,
    flag_count,
    flag_counts,
    session_ids,
    sessions,
    files,
    assignment_manifest,
    coverage,
    superseded: row.superseded_by_submission_id !== null,
    superseded_by_submission_id: row.superseded_by_submission_id,
    heuristic_config_version: row.heuristic_config_version,
    recompute_status: row.recompute_status,
  };
}
