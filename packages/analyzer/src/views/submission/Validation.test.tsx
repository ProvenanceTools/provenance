/**
 * Validation.test.tsx — tests for the Validation tab.
 *
 * Tests:
 * 1. Renders 8 check rows from provider.useValidation()
 * 2. Renders overall status badge
 * 3. Renders check detail text when present
 * 4. Shows loading state
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';

import { SubmissionDataContext } from '../../data/SubmissionDataProvider.js';
import type {
  SubmissionDataProvider,
  ValidationResults,
  ValidationCheckResult,
  FileListResult,
  FileContentResult,
  FileProvenanceResult,
  SubmissionStats,
  SubmittedFileListResult,
  SubmittedFileContentResult,
} from '../../data/SubmissionDataProvider.js';
import type { SubmissionSummary, FlagRow, EventRow } from '@provenance/shared/api-schemas';
import { Validation } from './Validation.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryResult<T>(data: T): UseQueryResult<T> {
  return {
    data,
    isLoading: false,
    isError: false,
    isPending: false,
    isSuccess: true,
    error: null,
    status: 'success',
    fetchStatus: 'idle',
    isLoadingError: false,
    isRefetchError: false,
    isFetching: false,
    isRefetching: false,
    isStale: false,
    isPaused: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
  } as unknown as UseQueryResult<T>;
}

function makeLoadingResult<T>(): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: true,
    isError: false,
    isPending: true,
    isSuccess: false,
    error: null,
    status: 'pending',
    fetchStatus: 'fetching',
    isLoadingError: false,
    isRefetchError: false,
    isFetching: true,
    isRefetching: false,
    isStale: false,
    isPaused: false,
    isPlaceholderData: false,
    refetch: vi.fn(),
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
  } as unknown as UseQueryResult<T>;
}

// 8 checks matching the v2 validation spec
const EIGHT_CHECKS: ValidationCheckResult[] = [
  { id: 'manifest_sig', status: 'pass' },
  { id: 'chain_integrity', status: 'pass' },
  { id: 'submitted_code_match', status: 'skipped', detail: 'No reference hash' },
  { id: 'session_continuity', status: 'pass' },
  { id: 'clock_monotone', status: 'pass' },
  { id: 'no_external_edit', status: 'warn', detail: '1 external edit detected' },
  { id: 'extension_hash', status: 'pass' },
  { id: 'event_count_reasonable', status: 'pass' },
];

function makeProvider(validation: ValidationResults, loading = false): SubmissionDataProvider {
  const validationResult = loading
    ? makeLoadingResult<ValidationResults>()
    : makeQueryResult(validation);

  return {
    useSummary: () =>
      makeQueryResult({
        id: 'test',
        student: { sid: 'test', display_name: 'Test' },
        assignment: { assignment_id_str: 'hw1', label: 'HW1' },
        version_index: 1,
        score_total: 0,
        score_max_severity: null,
        validation_status: validation.overall,
        validation_overall_detail: null,
        heuristic_config_version: 1,
        flag_count: 0,
        ingested_at: '2025-01-01T00:00:00.000Z',
      } as SubmissionSummary),
    useEvents: () => makeQueryResult([] as EventRow[]),
    useEvent: () => makeQueryResult(null),
    useFlags: () => makeQueryResult([] as FlagRow[]),
    useStats: () =>
      makeQueryResult({
        per_file: [],
        aggregate: { total_events: 0, total_saves: 0, total_sessions: 0, total_wall_ms: 0 },
      } as SubmissionStats),
    useValidation: () => validationResult,
    useFiles: () => makeQueryResult({ files: [] } as FileListResult),
    useFileContent: () =>
      makeQueryResult({ content: '', at_seq: 0, computed_at_ms: 0 } as FileContentResult),
    useFileProvenance: () =>
      makeQueryResult({ length: 0, provenance: [], at_seq: 0 } as FileProvenanceResult),
    useSubmittedFiles: () =>
      makeQueryResult({ available: true, files: [] } as SubmittedFileListResult),
    useSubmittedFileContent: (_path: string) =>
      makeQueryResult({
        path: '',
        content: '',
        status: 'missing',
        verdict: 'unknown',
      } as SubmittedFileContentResult),
  };
}

function renderValidation(provider: SubmissionDataProvider) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SubmissionDataContext.Provider value={provider}>
          <Validation />
        </SubmissionDataContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Validation tab', () => {
  it('renders all 8 check rows', async () => {
    const provider = makeProvider({ overall: 'warn', checks: EIGHT_CHECKS });
    renderValidation(provider);

    await waitFor(() => {
      expect(screen.getByTestId('validation-panel')).toBeInTheDocument();
    });

    for (const check of EIGHT_CHECKS) {
      expect(screen.getByTestId(`check-row-${check.id}`)).toBeInTheDocument();
    }
  });

  it('renders overall status badge', async () => {
    const provider = makeProvider({ overall: 'fail', checks: EIGHT_CHECKS });
    renderValidation(provider);

    await waitFor(() => {
      expect(screen.getByTestId('overall-validation-badge')).toHaveTextContent('FAIL');
    });
  });

  it('renders pass overall badge', async () => {
    const provider = makeProvider({ overall: 'pass', checks: EIGHT_CHECKS });
    renderValidation(provider);

    await waitFor(() => {
      expect(screen.getByTestId('overall-validation-badge')).toHaveTextContent('PASS');
    });
  });

  it('renders detail text on a check that has it', async () => {
    const provider = makeProvider({ overall: 'pass', checks: EIGHT_CHECKS });
    renderValidation(provider);

    await waitFor(() => {
      // submitted_code_match has detail: 'No reference hash'
      expect(screen.getByTestId('check-row-submitted_code_match')).toHaveTextContent(
        'No reference hash',
      );
    });
  });

  it('renders check status badge for each check', async () => {
    const provider = makeProvider({ overall: 'pass', checks: EIGHT_CHECKS });
    renderValidation(provider);

    await waitFor(() => {
      expect(screen.getByTestId('check-status-manifest_sig')).toHaveTextContent('PASS');
      expect(screen.getByTestId('check-status-submitted_code_match')).toHaveTextContent('SKIPPED');
      expect(screen.getByTestId('check-status-no_external_edit')).toHaveTextContent('WARN');
    });
  });

  // The server computes validation once, at ingest. A verdict printed with no
  // date on it reads as current, and the client schema used to drop
  // `validated_at` entirely, so staleness could not be shown even in principle.
  it('states when the results were computed', async () => {
    const provider = makeProvider({
      overall: 'pass',
      checks: EIGHT_CHECKS,
      validated_at: '2026-03-04T05:06:07.000Z',
    });
    renderValidation(provider);

    await waitFor(() => {
      const el = screen.getByTestId('validation-computed-at');
      expect(el).toHaveTextContent('Computed once at ingest');
      expect(el).toHaveTextContent('not recomputed for this page');
    });
  });

  it('omits the computed-at line when the provider recomputes live (no validated_at)', async () => {
    const provider = makeProvider({ overall: 'pass', checks: EIGHT_CHECKS });
    renderValidation(provider);

    await waitFor(() => {
      expect(screen.getByTestId('validation-panel')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('validation-computed-at')).toBeNull();
  });

  it('shows loading state when data is pending, announced via role=status', () => {
    const provider = makeProvider({ overall: 'pass', checks: [] }, /* loading= */ true);
    renderValidation(provider);

    const loadingEl = screen.getByTestId('validation-loading');
    expect(loadingEl).toBeInTheDocument();
    expect(loadingEl.closest('[role="status"]')).not.toBeNull();
  });

  it('shows error state announced via role=alert', () => {
    const provider = makeProvider({ overall: 'pass', checks: EIGHT_CHECKS });
    provider.useValidation = () =>
      ({
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error('boom'),
      }) as unknown as ReturnType<SubmissionDataProvider['useValidation']>;
    renderValidation(provider);

    const errorEl = screen.getByTestId('validation-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl.closest('[role="alert"]')).not.toBeNull();
  });
});
