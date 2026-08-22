/**
 * SubmissionDataProvider — interface for per-submission data access.
 *
 * Phase 23. Both the API-backed path (ApiSubmissionDataProvider) and the
 * in-memory v2 path (InMemorySubmissionDataProvider) implement this interface.
 * All per-submission view components (Overview, Timeline, Replay, Validation,
 * Export) consume data exclusively through this interface so they can operate
 * in both the v3 API-backed context and the v2 standalone /local context.
 *
 * PRD §14.2 (provider abstraction), Appendix C (module reuse map).
 *
 * Design notes:
 * - All hooks return TanStack Query result shapes so view components can handle
 *   loading/error states uniformly regardless of provider.
 * - For InMemorySubmissionDataProvider, data is available synchronously but we
 *   still wrap it in useQuery to keep the consumer interface identical.
 * - `useEvents` is NOT paginated here; events are returned as a flat array. The
 *   server paginates (PRD §8.9) but the in-memory provider has all events
 *   available. The Timeline and Replay views work with the full event array
 *   once loaded. Full cursor-based pagination is a Phase 24 enhancement.
 */

import { useContext, createContext } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import type {
  SubmissionSummary,
  FlagRow,
  EventRow,
  SubmittedContentSource,
} from '@provenance/shared/api-schemas';

export type { SubmittedContentSource };

// ---------------------------------------------------------------------------
// Sub-shapes returned by the provider hooks
// ---------------------------------------------------------------------------

export type PerFileStats = {
  path: string;
  final_length: number;
  saves: number;
  reconstruction_tainted?: boolean | undefined;
};

export type SubmissionStats = {
  per_file: PerFileStats[];
  aggregate: {
    total_events: number;
    total_saves: number;
    total_sessions: number;
    total_wall_ms: number;
  };
};

export type ValidationCheckResult = {
  id: string;
  /** Human-readable check name. Absent on very old rows; UI falls back to `id`. */
  label?: string | undefined;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  detail?: string | null | undefined;
};

export type ValidationResults = {
  overall: 'pass' | 'warn' | 'fail';
  checks: ValidationCheckResult[];
  /**
   * When these results were computed — the server runs validation ONCE, at
   * ingest, and every read serves that stored row. Without this on the wire the
   * UI could not tell a grader how old the verdict in front of them is. Absent
   * on the in-browser `/local` provider, which recomputes on load and so has no
   * staleness to declare.
   */
  validated_at?: string | undefined;
};

export type FileListResult = {
  files: PerFileStats[];
};

export type FileContentResult = {
  content: string;
  at_seq: number;
  computed_at_ms: number;
  /**
   * `FILE_RECONSTRUCTION_TAINTED` — one content, best-effort.
   * `FILE_RECONSTRUCTION_CONCURRENT` — two contributors' edits are unordered
   * here, so there is NO single content and `content` is empty rather than one
   * branch presented as the file (Tier 2.2).
   * `FILE_RECONSTRUCTION_UNKNOWN` — the happens-before relation does not cover
   * these events. A different fact from `CONCURRENT`: no record, versus two
   * records that race.
   */
  warning?: string | undefined;
  /** Human-readable explanation for the warning, when one is available. */
  warning_detail?: string | undefined;
};

export type ProvenanceRun = {
  offset: number;
  length: number;
  kind: 'typed' | 'pasted' | 'loaded';
  event_seq: number;
};

export type FileProvenanceResult = {
  length: number;
  provenance: ProvenanceRun[];
  at_seq: number;
};

export type SubmittedFileEntry = {
  path: string;
  status: 'present' | 'missing';
  /** 'match' | 'mismatch' | 'unknown' — Check 8 verdict for this file. */
  verdict: 'match' | 'mismatch' | 'unknown';
  sha256: string | null;
};

export type SubmittedFileListResult = {
  files: SubmittedFileEntry[];
  /** False when the bundle blob is gone (server, post-retention). */
  available: boolean;
};

export type SubmittedFileContentResult = {
  path: string;
  /**
   * UTF-8 decoded content. What this IS depends on `content_source` — read that
   * before rendering it as the student's submission.
   */
  content: string;
  status: 'present' | 'missing';
  verdict: 'match' | 'mismatch' | 'unknown';
  /**
   * `'submitted_bytes'` — the literal bytes sealed into the bundle (only the
   * in-browser `/local` provider can produce this).
   * `'event_replay'` — reconstructed by replaying the recording; the server can
   * serve nothing else, because stored bundles are provenance-only. On a
   * `mismatch` verdict this is provably NOT what was submitted.
   *
   * Absent (a server predating the field) is read as `'event_replay'`: the more
   * caveated of the two, so an unknown provenance never gets upgraded into the
   * claim that the pane is the submission.
   */
  content_source?: SubmittedContentSource | undefined;
};

export type EventQueryFilters = {
  kind?: string[];
  seqFrom?: number;
  seqTo?: number;
  sessionId?: string;
  file?: string;
};

// ---------------------------------------------------------------------------
// SubmissionDataProvider interface
// ---------------------------------------------------------------------------

export interface SubmissionDataProvider {
  /** Submission summary card (PRD §8.9 /summary). */
  useSummary(): UseQueryResult<SubmissionSummary>;

  /** Flat list of events matching optional filters. */
  useEvents(filters: EventQueryFilters): UseQueryResult<EventRow[]>;

  /** Single event by seq. */
  useEvent(seq: number): UseQueryResult<EventRow | null>;

  /** Per-submission heuristic flags. */
  useFlags(): UseQueryResult<FlagRow[]>;

  /** Per-file + aggregate stats. */
  useStats(): UseQueryResult<SubmissionStats>;

  /** Validation check results. */
  useValidation(): UseQueryResult<ValidationResults>;

  /** Files list (paths + basic stats). */
  useFiles(): UseQueryResult<FileListResult>;

  /**
   * File content at a specific event sequence.
   * When atSeq is undefined, the provider returns content at the last save.
   */
  useFileContent(path: string, atSeq?: number): UseQueryResult<FileContentResult>;

  /** File provenance (RLE-encoded attribution runs) at a specific event sequence. */
  useFileProvenance(path: string, atSeq?: number): UseQueryResult<FileProvenanceResult>;

  /** Submitted files (final on-disk bytes) + per-file Check 8 verdict. 1.1+ only. */
  useSubmittedFiles(): UseQueryResult<SubmittedFileListResult>;

  /** Submitted content of one file (UTF-8). */
  useSubmittedFileContent(path: string): UseQueryResult<SubmittedFileContentResult>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export const SubmissionDataContext = createContext<SubmissionDataProvider | null>(null);

/**
 * Read the current SubmissionDataProvider from context.
 *
 * Must be called inside a component tree wrapped by either
 * <ApiSubmissionDataProviderContext> or <InMemorySubmissionDataProviderContext>.
 */
export function useSubmissionData(): SubmissionDataProvider {
  const ctx = useContext(SubmissionDataContext);
  if (ctx === null) {
    throw new Error('useSubmissionData must be called inside a SubmissionDataProvider context');
  }
  return ctx;
}
