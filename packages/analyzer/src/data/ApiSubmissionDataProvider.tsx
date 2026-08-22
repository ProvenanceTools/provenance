/**
 * ApiSubmissionDataProvider — SubmissionDataProvider backed by the v3 REST API.
 *
 * Phase 23. Wraps the server API endpoints (PRD §8.9) in React Query hooks
 * that conform to the SubmissionDataProvider interface.
 *
 * Usage:
 *   <ApiSubmissionDataProviderContext submissionId="...">
 *     <SubmissionShell />
 *   </ApiSubmissionDataProviderContext>
 *
 * All hooks are stable references (same queryKey, same fetch function) so that
 * React Query deduplicates parallel calls from multiple children.
 */

import type { ReactNode } from 'react';
import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch, UnauthorizedError } from '../api/client.js';
import { SubmissionDataContext } from './SubmissionDataProvider.js';
import {
  SubmissionSummarySchema,
  FlagRowSchema,
  EventRowSchema,
  SubmittedFileListSchema,
  SubmittedFileContentSchema,
} from '@provenance/shared/api-schemas';
import { z } from 'zod';
import type {
  SubmissionDataProvider,
  SubmissionStats,
  ValidationResults,
  FileListResult,
  FileContentResult,
  FileProvenanceResult,
  ProvenanceRun,
  EventQueryFilters,
  SubmittedFileListResult,
  SubmittedFileContentResult,
} from './SubmissionDataProvider.js';
import type { FlagRow, EventRow, SubmissionSummary } from '@provenance/shared/api-schemas';
import type { UseQueryResult } from '@tanstack/react-query';
import { buildQueryString } from '../api/queries.js';

// ---------------------------------------------------------------------------
// Retry helper (mirrors queries.ts)
// ---------------------------------------------------------------------------

function noRetryOn401(failureCount: number, error: Error): boolean {
  if (error instanceof UnauthorizedError) return false;
  return failureCount < 2;
}

// ---------------------------------------------------------------------------
// Zod schemas for endpoints not yet in shared/api-schemas.ts
// ---------------------------------------------------------------------------

const PerFileStatsSchema = z.object({
  path: z.string(),
  final_length: z.number().int(),
  saves: z.number().int(),
  // Optional: /stats per_file always includes this; /files list omits it.
  // OpenAPI marks it non-required on PerFileStats.
  reconstruction_tainted: z.boolean().optional(),
});

const SubmissionStatsSchema = z.object({
  per_file: z.array(PerFileStatsSchema),
  aggregate: z.object({
    total_events: z.number().int(),
    total_saves: z.number().int(),
    total_sessions: z.number().int(),
    total_wall_ms: z.number(),
  }),
});

const ValidationCheckSchema = z.object({
  id: z.string(),
  /** Human-readable check name. Absent on very old rows; UI falls back to `id`. */
  label: z.string().optional(),
  status: z.enum(['pass', 'fail', 'warn', 'skipped']),
  detail: z.string().nullable().optional(),
});

const ValidationResultsSchema = z.object({
  overall: z.enum(['pass', 'warn', 'fail']),
  checks: z.array(ValidationCheckSchema),
  /**
   * When the server computed these results — i.e. ingest time, because
   * validation runs once and every read serves the stored row. The server has
   * always sent it (validation.ts) and OpenAPI has always marked it required;
   * this schema simply dropped it, so the UI had no way to tell a grader how old
   * the verdict was. Optional here only so a pre-`validated_at` row cannot fail
   * the whole parse.
   */
  validated_at: z.string().optional(),
});

const FileListResponseSchema = z.object({
  files: z.array(PerFileStatsSchema),
});

const FileContentResponseSchema = z.object({
  content: z.string(),
  at_seq: z.number().int(),
  computed_at_ms: z.number(),
  warning: z.string().optional(),
});

const ProvenanceRunSchema = z.object({
  offset: z.number().int(),
  length: z.number().int(),
  kind: z.enum(['typed', 'pasted', 'loaded']),
  event_seq: z.number().int(),
});

const FileProvenanceResponseSchema = z.object({
  length: z.number().int(),
  provenance: z.array(ProvenanceRunSchema),
  at_seq: z.number().int(),
});

const EventListResponseSchema = z.object({
  items: z.array(EventRowSchema),
  next_cursor: z.string().nullable().optional(),
  total_count: z.number().int().optional(),
});

const FlagListResponseSchema = z.object({
  flags: z.array(FlagRowSchema),
});

// ---------------------------------------------------------------------------
// Factory: createApiSubmissionDataProvider
// ---------------------------------------------------------------------------

/**
 * Creates a SubmissionDataProvider that calls the server API.
 *
 * This is a factory (not a hook) that captures `submissionId`. The hooks it
 * returns all use `submissionId` in their query keys and fetch URLs.
 */
function createApiSubmissionDataProvider(submissionId: string): SubmissionDataProvider {
  return {
    useSummary(): UseQueryResult<SubmissionSummary> {
      return useQuery({
        queryKey: ['submission', submissionId, 'summary'],
        queryFn: () =>
          apiFetch(`/submissions/${submissionId}/summary`, undefined, SubmissionSummarySchema),
        staleTime: 30 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '',
      });
    },

    useEvents(filters: EventQueryFilters): UseQueryResult<EventRow[]> {
      const params: Record<string, string | string[] | undefined> = {};
      if (filters.kind?.length) params['kind'] = filters.kind;
      if (filters.seqFrom !== undefined) params['seq_from'] = String(filters.seqFrom);
      if (filters.seqTo !== undefined) params['seq_to'] = String(filters.seqTo);
      if (filters.sessionId) params['session_id'] = filters.sessionId;
      if (filters.file) params['file'] = filters.file;
      // Fetch up to 2000 events (server MAX_LIMIT). For Replay/Timeline,
      // this is sufficient for typical submission sizes. Phase 24 can add
      // cursor-based infinite scrolling if needed.
      params['limit'] = '2000';
      const qs = buildQueryString(params);

      return useQuery({
        queryKey: ['submission', submissionId, 'events', filters],
        queryFn: async () => {
          const resp = await apiFetch(
            `/submissions/${submissionId}/events${qs ? `?${qs}` : ''}`,
            undefined,
            EventListResponseSchema,
          );
          return resp.items;
        },
        staleTime: 30 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '',
      });
    },

    useEvent(seq: number): UseQueryResult<EventRow | null> {
      return useQuery({
        queryKey: ['submission', submissionId, 'event', seq],
        queryFn: () =>
          apiFetch(`/submissions/${submissionId}/events/${seq}`, undefined, EventRowSchema),
        staleTime: 5 * 60 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '' && seq >= 0,
      });
    },

    useFlags(): UseQueryResult<FlagRow[]> {
      return useQuery({
        queryKey: ['submission', submissionId, 'flags'],
        queryFn: async () => {
          const resp = await apiFetch(
            `/submissions/${submissionId}/flags`,
            undefined,
            FlagListResponseSchema,
          );
          return resp.flags;
        },
        staleTime: 30 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '',
      });
    },

    useStats(): UseQueryResult<SubmissionStats> {
      return useQuery({
        queryKey: ['submission', submissionId, 'stats'],
        queryFn: () =>
          apiFetch(`/submissions/${submissionId}/stats`, undefined, SubmissionStatsSchema),
        staleTime: 30 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '',
      });
    },

    useValidation(): UseQueryResult<ValidationResults> {
      return useQuery({
        queryKey: ['submission', submissionId, 'validation'],
        queryFn: () =>
          apiFetch(`/submissions/${submissionId}/validation`, undefined, ValidationResultsSchema),
        staleTime: 30 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '',
      });
    },

    useFiles(): UseQueryResult<FileListResult> {
      return useQuery({
        queryKey: ['submission', submissionId, 'files'],
        queryFn: () =>
          apiFetch(`/submissions/${submissionId}/files`, undefined, FileListResponseSchema),
        staleTime: 30 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '',
      });
    },

    useFileContent(path: string, atSeq?: number): UseQueryResult<FileContentResult> {
      const encodedPath = encodeURIComponent(path);
      const qs = atSeq !== undefined ? `?at_seq=${atSeq}` : '';
      return useQuery({
        queryKey: ['submission', submissionId, 'file-content', path, atSeq],
        queryFn: () =>
          apiFetch(
            `/submissions/${submissionId}/files/${encodedPath}/content${qs}`,
            undefined,
            FileContentResponseSchema,
          ),
        staleTime: 5 * 60 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '' && path !== '',
      });
    },

    useFileProvenance(path: string, atSeq?: number): UseQueryResult<FileProvenanceResult> {
      const encodedPath = encodeURIComponent(path);
      const qs = atSeq !== undefined ? `?at_seq=${atSeq}` : '';
      return useQuery({
        queryKey: ['submission', submissionId, 'file-provenance', path, atSeq],
        queryFn: (): Promise<FileProvenanceResult> =>
          apiFetch(
            `/submissions/${submissionId}/files/${encodedPath}/provenance${qs}`,
            undefined,
            FileProvenanceResponseSchema,
          ) as Promise<{ length: number; provenance: ProvenanceRun[]; at_seq: number }>,
        staleTime: 5 * 60 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '' && path !== '',
      });
    },

    useSubmittedFiles(): UseQueryResult<SubmittedFileListResult> {
      return useQuery({
        queryKey: ['submission', submissionId, 'submitted-files'],
        queryFn: () =>
          apiFetch(
            `/submissions/${submissionId}/submitted-files`,
            undefined,
            SubmittedFileListSchema,
          ),
        staleTime: 30 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '',
      });
    },

    useSubmittedFileContent(path: string): UseQueryResult<SubmittedFileContentResult> {
      const encoded = encodeURIComponent(path);
      return useQuery({
        queryKey: ['submission', submissionId, 'submitted-content', path],
        queryFn: () =>
          apiFetch(
            `/submissions/${submissionId}/submitted-files/${encoded}`,
            undefined,
            SubmittedFileContentSchema,
          ),
        staleTime: 5 * 60 * 1000,
        retry: noRetryOn401,
        enabled: submissionId !== '' && path.length > 0,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Provider component
// ---------------------------------------------------------------------------

interface ApiSubmissionDataProviderContextProps {
  submissionId: string;
  children: ReactNode;
}

/**
 * Wraps children with a SubmissionDataProvider backed by the API.
 *
 * Place this around the SubmissionShell route so that all tab components
 * can call useSubmissionData() to access submission data.
 */
export function ApiSubmissionDataProviderContext({
  submissionId,
  children,
}: ApiSubmissionDataProviderContextProps) {
  const provider = useMemo(() => createApiSubmissionDataProvider(submissionId), [submissionId]);
  return (
    <SubmissionDataContext.Provider value={provider}>{children}</SubmissionDataContext.Provider>
  );
}
