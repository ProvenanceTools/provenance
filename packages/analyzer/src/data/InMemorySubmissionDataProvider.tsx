/**
 * InMemorySubmissionDataProvider — SubmissionDataProvider backed by v2's in-memory bundle.
 *
 * Phase 23. Wraps BundleContext's in-memory Bundle + EventIndex into the same
 * SubmissionDataProvider interface as ApiSubmissionDataProvider. Used by the
 * /local (Phase 25) standalone path so that the same SubmissionShell + tab
 * components work in both the v3 API-backed context and the v2 drop-a-zip context.
 *
 * Data is available synchronously from BundleContext, but we still wrap it in
 * useQuery (with a dummy queryFn that resolves immediately) so the consumer
 * interface is identical to the API-backed provider.
 *
 * Translation notes:
 * - v2 Flag.heuristic → FlagRow.heuristic_id
 * - v2 IndexedEvent.globalIdx → EventRow.seq (global, 0-based)
 * - v2 ValidationReport.checks[].status: 'pass'|'fail'|'skipped' →
 *   ValidationResults.checks[].status (API also supports 'warn'; v2 doesn't emit 'warn' per check)
 * - Stats: derived from computeStats(index); FileStats → PerFileStats
 * - File content / provenance: uses v2's reconstructFile + reconstructFileProvenance
 * - Submission summary is synthesized from v2 bundle metadata + heuristic results
 *
 * useFileContent / useFileProvenance: atSeq is the globalIdx of the event to
 * reconstruct up to. The v2 reconstruct* functions accept an event array slice.
 */

import type { ReactNode } from 'react';
import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useBundle } from '../context/BundleContext.js';
import { computeStats } from '@provenance/analysis-core/index/stats.js';
import { reconstructFile } from '@provenance/analysis-core/index/reconstruct-file.js';
import {
  buildReconstructionScope,
  determinateValue,
  describeAmbiguity,
  reconstructFileSegmented,
  reconstructFileSegmentedWithProvenance,
} from '@provenance/analysis-core/index/reconstruct-segments.js';
import { reconstructFileWithProvenance } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import { SubmissionDataContext } from './SubmissionDataProvider.js';
import { submittedFileVerdicts } from '@provenance/analysis-core/validation/verify-submitted-code.js';
import type {
  SubmissionDataProvider,
  SubmissionStats,
  ValidationResults,
  FileListResult,
  FileContentResult,
  FileProvenanceResult,
  EventQueryFilters,
  SubmittedFileListResult,
  SubmittedFileContentResult,
} from './SubmissionDataProvider.js';
import type { FlagRow, EventRow, SubmissionSummary } from '@provenance/shared/api-schemas';
import type { UseQueryResult } from '@tanstack/react-query';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { ValidationReport } from '@provenance/analysis-core/validation/check-types.js';

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

/**
 * Convert v2 Flag[] → FlagRow[].
 *
 * FlagRow.id is a UUID in the DB path; in-memory we use the v2 flag.id string
 * (deterministic, non-UUID). We pad it to look UUID-like for type compatibility.
 */
function flagsToFlagRows(flags: Flag[]): FlagRow[] {
  return flags.map((f, i) => ({
    // Synthesize a stable fake UUID using the flag id + index
    id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    heuristic_id: f.heuristic,
    severity: f.severity,
    confidence: f.confidence,
    score_contribution: 0, // in-memory path doesn't have server-side scoring
    title: f.title,
    description: f.description,
    detail: f.detail ?? null,
  }));
}

/**
 * Convert v2 IndexedEvent[] (from an EventIndex) → EventRow[].
 *
 * The globalIdx becomes the seq field (globally unique, 0-based, monotone).
 */
function indexedEventsToEventRows(events: IndexedEvent[]): EventRow[] {
  return events.map((e) => ({
    seq: e.globalIdx,
    kind: e.kind,
    t: e.t,
    wall: e.wall,
    session_id: e.sessionId,
    payload: e.payload,
  }));
}

/**
 * Convert v2 ValidationReport → ValidationResults.
 *
 * v2 checks[].status is 'pass'|'fail'|'skipped'; API also has 'warn'.
 * We cast directly — 'warn' won't appear from v2.
 */
function validationReportToResults(report: ValidationReport): ValidationResults {
  return {
    overall: report.overall,
    checks: report.checks.map((c) => ({
      id: c.id,
      status: c.status as 'pass' | 'fail' | 'warn' | 'skipped',
      // ValidationCheck.detail is string | undefined; map to string | null for
      // exactOptionalPropertyTypes compatibility with ValidationCheckResult.
      ...(c.detail !== undefined ? { detail: c.detail } : { detail: null }),
    })),
  };
}

/**
 * Synthesize SubmissionSummary from v2 bundle metadata.
 *
 * The in-memory path doesn't have a server-side submission ID or student/
 * assignment metadata. We synthesize a minimal summary that lets the Overview
 * tab render meaningfully.
 */
function bundleToSubmissionSummary(
  bundle: Bundle,
  flags: Flag[],
  validationReport: ValidationReport,
): SubmissionSummary {
  const flagCount = flags.length;
  // Score: count of high+medium flags as a simple proxy
  const scoreTotal = flags.reduce((acc, f) => {
    if (f.severity === 'high') return acc + 8;
    if (f.severity === 'medium') return acc + 3;
    if (f.severity === 'low') return acc + 1;
    return acc;
  }, 0);
  const maxSeverity = flags.some((f) => f.severity === 'high')
    ? 'high'
    : flags.some((f) => f.severity === 'medium')
      ? 'medium'
      : flags.some((f) => f.severity === 'low')
        ? 'low'
        : 'info';

  return {
    id: bundle.id,
    student: { sid: 'local', display_name: 'Local bundle' },
    assignment: { assignment_id_str: bundle.manifest.assignment_id ?? 'unknown', label: null },
    version_index: 1,
    score_total: scoreTotal,
    score_max_severity: flagCount > 0 ? maxSeverity : null,
    validation_status: validationReport.overall,
    validation_overall_detail: null,
    heuristic_config_version: 0,
    flag_count: flagCount,
    ingested_at: new Date().toISOString(),
  };
}

/**
 * Build SubmissionStats from computeStats output.
 */
function bundleStatsToSubmissionStats(index: EventIndex, _bundle: Bundle): SubmissionStats {
  const stats = computeStats(index);
  const perFile = Array.from(stats.perFile.entries()).map(([path, fs]) => ({
    path,
    final_length: 0, // not tracked by in-memory path (same as DB before Phase 18 backfill)
    saves: fs.saves,
    reconstruction_tainted: fs.reconstructionTainted,
  }));
  // Aggregate session wall time = sum of last-event.wall - first-event.wall per session
  let totalWallMs = 0;
  for (const [, sessionEvents] of index.bySessionId) {
    if (sessionEvents.length < 2) continue;
    const first = sessionEvents[0]!;
    const last = sessionEvents[sessionEvents.length - 1]!;
    totalWallMs += Date.parse(last.wall) - Date.parse(first.wall);
  }
  return {
    per_file: perFile,
    aggregate: {
      total_events: index.ordered.length,
      total_saves: perFile.reduce((acc, f) => acc + f.saves, 0),
      total_sessions: index.bySessionId.size,
      total_wall_ms: totalWallMs,
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an InMemorySubmissionDataProvider from the current BundleContext.
 *
 * This is called inside a React component so that BundleContext hooks are
 * called at the top of the component tree, not inside factory-created hooks.
 * The stable references capture snapshots so re-renders don't recreate hooks.
 */
function createInMemoryProvider(
  bundle: Bundle,
  index: EventIndex,
  validationReport: ValidationReport,
  flags: Flag[],
): SubmissionDataProvider {
  // Pre-compute translations once
  // Built once per provider: for a solo bundle this is a contributor scan and
  // no graph at all, so the local route pays nothing it did not pay before.
  const reconstructionScope = buildReconstructionScope(bundle, index);
  const flagRows = flagsToFlagRows(flags);
  const allEventRows = indexedEventsToEventRows(index.ordered);
  const validationResults = validationReportToResults(validationReport);
  const submissionStats = bundleStatsToSubmissionStats(index, bundle);
  const fileListResult: FileListResult = { files: submissionStats.per_file };
  const summary = bundleToSubmissionSummary(bundle, flags, validationReport);

  // Derive chainIntact from the already-computed ValidationReport
  const chainIntact =
    validationReport.checks.find((c) => c.id === 'chain_integrity')?.status === 'pass';
  const verdicts = submittedFileVerdicts(bundle, { chainIntact });
  const verdictByPath = new Map(verdicts.map((v) => [v.path, v]));

  return {
    useSummary(): UseQueryResult<SubmissionSummary> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'summary'],
        queryFn: () => Promise.resolve(summary),
        staleTime: Infinity,
      });
    },

    useEvents(filters: EventQueryFilters): UseQueryResult<EventRow[]> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'events', filters],
        queryFn: () => {
          let rows = allEventRows;
          if (filters.kind?.length) {
            const kindSet = new Set(filters.kind);
            rows = rows.filter((e) => kindSet.has(e.kind));
          }
          if (filters.seqFrom !== undefined) rows = rows.filter((e) => e.seq >= filters.seqFrom!);
          if (filters.seqTo !== undefined) rows = rows.filter((e) => e.seq <= filters.seqTo!);
          if (filters.sessionId) rows = rows.filter((e) => e.session_id === filters.sessionId);
          if (filters.file) {
            const file = filters.file;
            const fileEventSeqs = new Set((index.byFile.get(file) ?? []).map((e) => e.globalIdx));
            rows = rows.filter((e) => fileEventSeqs.has(e.seq));
          }
          return Promise.resolve(rows);
        },
        staleTime: Infinity,
      });
    },

    useEvent(seq: number): UseQueryResult<EventRow | null> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'event', seq],
        queryFn: () => Promise.resolve(allEventRows[seq] ?? null),
        staleTime: Infinity,
      });
    },

    useFlags(): UseQueryResult<FlagRow[]> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'flags'],
        queryFn: () => Promise.resolve(flagRows),
        staleTime: Infinity,
      });
    },

    useStats(): UseQueryResult<SubmissionStats> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'stats'],
        queryFn: () => Promise.resolve(submissionStats),
        staleTime: Infinity,
      });
    },

    useValidation(): UseQueryResult<ValidationResults> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'validation'],
        queryFn: () => Promise.resolve(validationResults),
        staleTime: Infinity,
      });
    },

    useFiles(): UseQueryResult<FileListResult> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'files'],
        queryFn: () => Promise.resolve(fileListResult),
        staleTime: Infinity,
      });
    },

    useFileContent(path: string, atSeq?: number): UseQueryResult<FileContentResult> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'file-content', path, atSeq],
        queryFn: () => {
          // upToGlobalIdx is exclusive. Use atSeq + 1 to include that event.
          const upTo = atSeq !== undefined ? atSeq + 1 : undefined;
          const segmented = reconstructFileSegmented(reconstructionScope, path, upTo);
          const result = determinateValue(segmented);

          // Determine actual seq: last file event up to (inclusive) atSeq
          const fileEvents = index.byFile.get(path) ?? [];
          const slice =
            atSeq !== undefined ? fileEvents.filter((e) => e.globalIdx <= atSeq) : fileEvents;
          const actualSeq = slice.length > 0 ? slice[slice.length - 1]!.globalIdx : 0;

          // Tier 2.2: with two contributors' edits unordered here there is no
          // single content, and showing one branch as "the file" is the exact
          // fabrication this removes. Return nothing plus the reason, the same
          // shape the tainted path already uses — a viewer that renders content
          // it was not given cannot be fixed by a nicer error string.
          if (result === null) {
            return Promise.resolve({
              content: '',
              at_seq: actualSeq,
              computed_at_ms: 0,
              warning:
                segmented.kind === 'concurrent'
                  ? 'FILE_RECONSTRUCTION_CONCURRENT'
                  : 'FILE_RECONSTRUCTION_UNKNOWN',
              warning_detail: describeAmbiguity(segmented) ?? '',
            });
          }

          return Promise.resolve({
            content: result.content,
            at_seq: actualSeq,
            computed_at_ms: 0,
            ...(result.tainted ? { warning: 'FILE_RECONSTRUCTION_TAINTED' } : {}),
          });
        },
        staleTime: Infinity,
      });
    },

    useFileProvenance(path: string, atSeq?: number): UseQueryResult<FileProvenanceResult> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'file-provenance', path, atSeq],
        queryFn: () => {
          // Tier 2.2: no single content means no single per-character
          // attribution either. Colouring one branch's characters as though they
          // were the file's would attribute text to a contributor on the
          // strength of a coin flip.
          const state = determinateValue(
            reconstructFileSegmentedWithProvenance(reconstructionScope, path, atSeq),
          );
          if (state === null) {
            return Promise.resolve({ length: 0, provenance: [], at_seq: 0, computed_at_ms: 0 });
          }
          const provArray = state.provenance;
          const fileEvents = index.byFile.get(path) ?? [];
          const slice =
            atSeq !== undefined ? fileEvents.filter((e) => e.globalIdx <= atSeq) : fileEvents;
          const actualSeq = slice.length > 0 ? slice[slice.length - 1]!.globalIdx : 0;

          // Convert raw provenance Uint32Array to RLE runs
          type ProvenanceKind = 'typed' | 'pasted' | 'loaded';
          type Run = {
            offset: number;
            length: number;
            kind: ProvenanceKind;
            event_seq: number;
          };
          const runs: Run[] = [];
          for (let i = 0; i < provArray.length; i++) {
            const globalIdx = provArray[i]!;
            // Map globalIdx to kind via kindByGlobalIdx map from reconstruction
            const rawKind = state.kindByGlobalIdx.get(globalIdx);
            const kind: ProvenanceKind =
              rawKind === 'paste'
                ? 'pasted'
                : rawKind === 'external_change' || rawKind === 'preexisting'
                  ? 'loaded'
                  : 'typed';
            const last = runs[runs.length - 1];
            if (last && last.kind === kind && last.event_seq === globalIdx) {
              last.length++;
            } else {
              runs.push({ offset: i, length: 1, kind, event_seq: globalIdx });
            }
          }

          return Promise.resolve({
            length: provArray.length,
            provenance: runs,
            at_seq: actualSeq,
          });
        },
        staleTime: Infinity,
      });
    },

    useSubmittedFiles(): UseQueryResult<SubmittedFileListResult> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'submitted-files'],
        queryFn: () =>
          Promise.resolve({
            available: true,
            files: verdicts.map((v) => ({
              path: v.path,
              status: v.status,
              verdict: v.verdict,
              sha256: v.submittedSha,
            })),
          }),
        staleTime: Infinity,
      });
    },

    useSubmittedFileContent(path: string): UseQueryResult<SubmittedFileContentResult> {
      return useQuery({
        queryKey: ['inmem', bundle.id, 'submitted-content', path],
        queryFn: () => {
          const entry = bundle.submissionFiles.get(path);
          const v = verdictByPath.get(path);
          const content = entry?.bytes ? new TextDecoder().decode(entry.bytes) : '';
          return Promise.resolve({
            path,
            content,
            status: (entry?.status ?? 'missing') as 'present' | 'missing',
            verdict: (v?.verdict ?? 'unknown') as 'match' | 'mismatch' | 'unknown',
          });
        },
        staleTime: Infinity,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Provider component
// ---------------------------------------------------------------------------

interface InMemorySubmissionDataProviderContextProps {
  children: ReactNode;
}

/**
 * Wraps children with an InMemorySubmissionDataProvider sourced from BundleContext.
 *
 * Must be placed inside a <BundleProvider> with status === 'loaded'.
 * Returns null when no bundle is loaded (status !== 'loaded').
 */
export function InMemorySubmissionDataProviderContext({
  children,
}: InMemorySubmissionDataProviderContextProps) {
  const { bundles, index, validationReport, flags, status } = useBundle();

  // Data must be available for provider creation
  const bundle = bundles[0] ?? null;
  const provider = useMemo(() => {
    if (!bundle || !index || !validationReport) return null;
    return createInMemoryProvider(bundle, index, validationReport, flags);
  }, [bundle, index, validationReport, flags]);

  if (status !== 'loaded' || !provider) {
    return null;
  }

  return (
    <SubmissionDataContext.Provider value={provider}>{children}</SubmissionDataContext.Provider>
  );
}
