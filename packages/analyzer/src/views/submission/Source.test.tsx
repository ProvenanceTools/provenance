/**
 * Source.test.tsx — tests for the Source tab.
 *
 * Tests:
 * 1. Lists submitted files with a verdict badge
 * 2. Shows file content when a file is selected
 * 3. Shows loading state when data is pending
 * 4. Shows unavailable state when available:false
 * 5. Shows empty state for a 1.0 bundle (no files)
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
import { Source } from './Source.js';

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

const DUMMY_SUMMARY: SubmissionSummary = {
  id: 'test',
  student: { sid: 'test', display_name: 'Test' },
  contributors: [
    {
      contributor_key: 'roster:30000000-0000-0000-0000-0000000000aa',
      kind: 'roster',
      student: { id: '30000000-0000-0000-0000-0000000000aa', sid: 'test', display_name: 'Test' },
      student_ref: null,
      session_count: 0,
      is_submitter: true,
      score_total: 0,
      score_max_severity: 'info',
      flag_counts: { info: 0, low: 0, medium: 0, high: 0 },
    },
  ],
  assignment: { assignment_id_str: 'hw1', label: 'HW1' },
  version_index: 1,
  score_total: 0,
  score_max_severity: null,
  validation_status: 'pass',
  validation_overall_detail: null,
  heuristic_config_version: 1,
  flag_count: 0,
  ingested_at: '2025-01-01T00:00:00.000Z',
};

const DUMMY_VALIDATION: ValidationResults = {
  overall: 'pass',
  checks: [] as ValidationCheckResult[],
};

// The content map for mock provider: path → content string
function makeProvider(
  filesResult: SubmittedFileListResult,
  contentMap: Record<string, SubmittedFileContentResult> = {},
  loading = false,
): SubmissionDataProvider {
  return {
    useSummary: () => makeQueryResult(DUMMY_SUMMARY),
    useEvents: () => makeQueryResult([] as EventRow[]),
    useEvent: () => makeQueryResult(null),
    useFlags: () => makeQueryResult([] as FlagRow[]),
    useStats: () =>
      makeQueryResult({
        per_file: [],
        aggregate: { total_events: 0, total_saves: 0, total_sessions: 0, total_wall_ms: 0 },
      } as SubmissionStats),
    useValidation: () => makeQueryResult(DUMMY_VALIDATION),
    useFiles: () => makeQueryResult({ files: [] } as FileListResult),
    useFileContent: () =>
      makeQueryResult({ content: '', at_seq: 0, computed_at_ms: 0 } as FileContentResult),
    useFileProvenance: () =>
      makeQueryResult({ length: 0, provenance: [], at_seq: 0 } as FileProvenanceResult),
    useSubmittedFiles: () =>
      loading ? makeLoadingResult<SubmittedFileListResult>() : makeQueryResult(filesResult),
    useSubmittedFileContent: (path: string) => {
      const content = contentMap[path];
      if (content !== undefined) return makeQueryResult(content);
      return makeQueryResult<SubmittedFileContentResult>({
        path,
        content: '',
        status: 'missing',
        verdict: 'unknown',
        content_source: 'event_replay',
      });
    },
  };
}

function renderSource(provider: SubmissionDataProvider) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SubmissionDataContext.Provider value={provider}>
          <Source />
        </SubmissionDataContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Source tab', () => {
  it('lists submitted files with verdict badges', async () => {
    const filesResult: SubmittedFileListResult = {
      available: true,
      files: [
        { path: 'hw03.py', status: 'present', verdict: 'match', sha256: 'abc123' },
        { path: 'utils.py', status: 'present', verdict: 'mismatch', sha256: 'def456' },
      ],
    };
    const provider = makeProvider(filesResult);
    renderSource(provider);

    await waitFor(() => {
      expect(screen.getByText('hw03.py')).toBeInTheDocument();
      expect(screen.getByText('utils.py')).toBeInTheDocument();
    });

    expect(screen.getByTestId('verdict-hw03.py')).toHaveTextContent('match');
    expect(screen.getByTestId('verdict-utils.py')).toHaveTextContent('mismatch');
  });

  it('shows file content when a file is selected', async () => {
    const filesResult: SubmittedFileListResult = {
      available: true,
      files: [{ path: 'hw03.py', status: 'present', verdict: 'match', sha256: 'abc123' }],
    };
    const contentMap: Record<string, SubmittedFileContentResult> = {
      'hw03.py': {
        path: 'hw03.py',
        content: 'print(1)\n',
        status: 'present',
        verdict: 'match',
        content_source: 'event_replay',
      },
    };
    const provider = makeProvider(filesResult, contentMap);
    renderSource(provider);

    // File list renders
    await waitFor(() => {
      expect(screen.getByText('hw03.py')).toBeInTheDocument();
    });

    // Click the file
    fireEvent.click(screen.getByText('hw03.py'));

    // Content should appear
    await waitFor(() => {
      expect(screen.getByTestId('source-content')).toHaveTextContent('print(1)');
    });
  });

  it('shows no-selection prompt before a file is chosen', async () => {
    const filesResult: SubmittedFileListResult = {
      available: true,
      files: [{ path: 'hw03.py', status: 'present', verdict: 'match', sha256: 'abc123' }],
    };
    const provider = makeProvider(filesResult);
    renderSource(provider);

    await waitFor(() => {
      expect(screen.getByTestId('source-no-selection')).toBeInTheDocument();
    });
  });

  it('shows loading state when data is pending, announced via role=status', () => {
    const provider = makeProvider({ available: true, files: [] }, {}, /* loading= */ true);
    renderSource(provider);

    const loadingEl = screen.getByTestId('source-loading');
    expect(loadingEl).toBeInTheDocument();
    expect(loadingEl.closest('[role="status"]')).not.toBeNull();
  });

  it('shows error state announced via role=alert', async () => {
    const provider = makeProvider({ available: true, files: [] });
    provider.useSubmittedFiles = () =>
      ({
        data: undefined,
        isLoading: false,
        isError: true,
        error: new Error('boom'),
      }) as unknown as ReturnType<SubmissionDataProvider['useSubmittedFiles']>;
    renderSource(provider);

    await waitFor(() => {
      const errorEl = screen.getByTestId('source-error');
      expect(errorEl).toBeInTheDocument();
      expect(errorEl.closest('[role="alert"]')).not.toBeNull();
    });
  });

  it('shows unavailable state when available is false', async () => {
    const filesResult: SubmittedFileListResult = { available: false, files: [] };
    const provider = makeProvider(filesResult);
    renderSource(provider);

    await waitFor(() => {
      expect(screen.getByTestId('source-unavailable')).toBeInTheDocument();
    });
  });

  it('shows empty state for a 1.0 bundle with no submission files', async () => {
    const filesResult: SubmittedFileListResult = { available: true, files: [] };
    const provider = makeProvider(filesResult);
    renderSource(provider);

    await waitFor(() => {
      expect(screen.getByTestId('source-empty')).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Content provenance notice
  //
  // The pane is a reconstruction on the server-backed path. Unlabelled, it reads
  // as the submitted code — and under a `mismatch` verdict it is provably not.
  // -------------------------------------------------------------------------

  async function renderSelected(content: SubmittedFileContentResult) {
    const filesResult: SubmittedFileListResult = {
      available: true,
      files: [
        { path: content.path, status: 'present', verdict: content.verdict, sha256: 'abc123' },
      ],
    };
    renderSource(makeProvider(filesResult, { [content.path]: content }));
    await waitFor(() => expect(screen.getByText(content.path)).toBeInTheDocument());
    fireEvent.click(screen.getByText(content.path));
    return waitFor(() => screen.getByTestId('source-content-provenance'));
  }

  it('labels a replayed pane as reconstructed, not as the submitted file', async () => {
    const el = await renderSelected({
      path: 'hw03.py',
      content: 'print(1)\n',
      status: 'present',
      verdict: 'match',
      content_source: 'event_replay',
    });

    expect(el).toHaveTextContent('Reconstructed from the recording');
    expect(el).toHaveTextContent('it is not the file that was submitted');
    // The match verdict is still stated — the caveat must not swallow it.
    expect(el).toHaveTextContent('does match the last state the recorder observed on disk');
  });

  it('says outright that a mismatched pane is not the submitted code', async () => {
    const el = await renderSelected({
      path: 'hw03.py',
      content: 'print(1)\n',
      status: 'present',
      verdict: 'mismatch',
      content_source: 'event_replay',
    });

    expect(el).toHaveTextContent('the submitted file did not match it');
    // The finding itself, plainly, neither hedged nor amplified.
    expect(el).toHaveTextContent('does not match the last state the recorder observed on disk');
    // And the part a grader would otherwise assume: the diff is not on screen.
    expect(el).toHaveTextContent('nothing in it is the submitted code');
  });

  it('says a verdict-less pane establishes nothing about the submitted code', async () => {
    const el = await renderSelected({
      path: 'hw03.py',
      content: 'print(1)\n',
      status: 'present',
      verdict: 'unknown',
      content_source: 'event_replay',
    });

    expect(el).toHaveTextContent('did not reach a verdict');
    expect(el).toHaveTextContent('is not established');
  });

  it('makes the stronger claim when the provider holds the real submitted bytes', async () => {
    const el = await renderSelected({
      path: 'hw03.py',
      content: 'print(1)\n',
      status: 'present',
      verdict: 'match',
      content_source: 'submitted_bytes',
    });

    expect(el).toHaveTextContent('The submitted file, read from the bundle');
    expect(el).toHaveTextContent('literal bytes sealed into the submitted bundle');
    expect(el).not.toHaveTextContent('Reconstructed');
  });

  it('makes no claim about the pane before a file is selected', async () => {
    const filesResult: SubmittedFileListResult = {
      available: true,
      files: [{ path: 'hw03.py', status: 'present', verdict: 'match', sha256: 'abc123' }],
    };
    renderSource(makeProvider(filesResult));

    await waitFor(() => {
      expect(screen.getByTestId('source-no-selection')).toHaveTextContent('Select a file');
    });
    expect(screen.queryByTestId('source-content-provenance')).toBeNull();
  });

  it('shows "missing" label for missing-status files', async () => {
    const filesResult: SubmittedFileListResult = {
      available: true,
      files: [{ path: 'optional.py', status: 'missing', verdict: 'unknown', sha256: null }],
    };
    const provider = makeProvider(filesResult);
    renderSource(provider);

    await waitFor(() => {
      expect(screen.getByTestId('verdict-optional.py')).toHaveTextContent('missing');
    });
  });
});
