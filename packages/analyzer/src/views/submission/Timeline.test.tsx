/**
 * Timeline.test.tsx — the submission Timeline tab.
 *
 * Covers two things:
 *  1. Accessibility of the async loading/error states (WCAG 4.1.3 Status
 *     Messages) — loading announced via role=status, errors via role=alert.
 *     These assertions predate the TimelineInner rewrite and are preserved.
 *  2. That the tab renders the FULL event stream. It previously sliced to the
 *     first 500 rows of a limit=2000 query and gave no indication that
 *     anything had been dropped.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route, useSearchParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import {
  buildIndexFromEventRows,
  type ServerEventRow,
} from '@provenance/analysis-core/index/build-index.js';

// useFullEventIndex is a module-level hook (not part of SubmissionDataProvider),
// so it is mocked at the module seam.
const mockUseFullEventIndex = vi.fn<() => UseQueryResult<EventIndex>>();
vi.mock('../../data/useFullEventIndex.js', () => ({
  useFullEventIndex: () => mockUseFullEventIndex(),
}));

import { Timeline } from './Timeline.js';
import { SubmissionDataContext } from '../../data/SubmissionDataProvider.js';
import type { SubmissionDataProvider } from '../../data/SubmissionDataProvider.js';
import type { SubmissionSummary } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Query-result helpers
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
  } as unknown as UseQueryResult<T>;
}

function makeErrorResult<T>(error: Error): UseQueryResult<T> {
  return {
    data: undefined,
    isLoading: false,
    isError: true,
    isPending: false,
    isSuccess: false,
    error,
    status: 'error',
    fetchStatus: 'idle',
  } as unknown as UseQueryResult<T>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function rows(count: number, sessionId = 'sess-a'): ServerEventRow[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i,
    kind: 'doc.change',
    t: i * 10,
    wall: new Date(Date.UTC(2026, 0, 1, 0, 0, 0, i)).toISOString(),
    session_id: sessionId,
    payload: { path: 'hw1.py', deltas: [] },
  }));
}

function indexOf(count: number): EventIndex {
  return buildIndexFromEventRows(rows(count));
}

/** Surfaces the current search params so tests can assert on navigation. */
function SearchParamProbe() {
  const [params] = useSearchParams();
  return <div data-testid="search-params">{params.toString()}</div>;
}

/**
 * The tab reads the submission summary for its contributor stamp — the input the
 * happens-before relation needs and the paged event rows cannot carry. Only
 * `useSummary` is exercised; the rest of the provider throws if anything starts
 * reaching for it, rather than silently returning an empty answer.
 */
function makeSummaryOnlyProvider(summary: SubmissionSummary | undefined): SubmissionDataProvider {
  const unused = () => {
    throw new Error('the Timeline tab should not call this provider hook');
  };
  return {
    useSummary: () =>
      (summary === undefined
        ? makeLoadingResult<SubmissionSummary>()
        : makeQueryResult(summary)) as UseQueryResult<SubmissionSummary>,
    useEvents: unused,
    useEvent: unused,
    useFlags: unused,
    useStats: unused,
    useValidation: unused,
    useFileList: unused,
    useFileContent: unused,
    useFileProvenance: unused,
    useSubmittedFileList: unused,
    useSubmittedFileContent: unused,
  } as unknown as SubmissionDataProvider;
}

function renderTimeline(summary?: SubmissionSummary) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/submissions/sub-1?tab=timeline']}>
        <div style={{ height: '600px', width: '800px' }}>
          <SubmissionDataContext.Provider value={makeSummaryOnlyProvider(summary)}>
            <Routes>
              <Route
                path="/submissions/:submissionId"
                element={
                  <>
                    <Timeline />
                    <SearchParamProbe />
                  </>
                }
              />
            </Routes>
          </SubmissionDataContext.Provider>
        </div>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Timeline tab', () => {
  it('shows loading state announced via role=status', () => {
    mockUseFullEventIndex.mockReturnValue(makeLoadingResult<EventIndex>());
    renderTimeline();

    const loadingEl = screen.getByTestId('timeline-loading');
    expect(loadingEl).toBeInTheDocument();
    expect(loadingEl.closest('[role="status"]')).not.toBeNull();
  });

  it('shows error state announced via role=alert', () => {
    mockUseFullEventIndex.mockReturnValue(makeErrorResult<EventIndex>(new Error('boom')));
    renderTimeline();

    const errorEl = screen.getByTestId('timeline-error');
    expect(errorEl).toBeInTheDocument();
    expect(errorEl.closest('[role="alert"]')).not.toBeNull();
  });

  it('surfaces the event-ceiling failure instead of silently truncating', () => {
    mockUseFullEventIndex.mockReturnValue(
      makeErrorResult<EventIndex>(
        new Error('Refusing to load >200000 events for replay (got 200001).'),
      ),
    );
    renderTimeline();

    expect(screen.getByTestId('timeline-error')).toHaveTextContent('Refusing to load');
  });

  it('renders the empty state when the submission has no events', () => {
    mockUseFullEventIndex.mockReturnValue(makeQueryResult(indexOf(0)));
    renderTimeline();

    expect(screen.getByTestId('timeline-empty')).toBeInTheDocument();
  });

  it('counts every event, not just the first 500', () => {
    mockUseFullEventIndex.mockReturnValue(makeQueryResult(indexOf(600)));
    renderTimeline();

    expect(screen.getByTestId('event-count-label')).toHaveTextContent('600 events');
  });

  it('renders the full event browser, not the old flat list', () => {
    mockUseFullEventIndex.mockReturnValue(makeQueryResult(indexOf(5)));
    renderTimeline();

    // Filter bar + detail pane are what the old bespoke list lacked.
    expect(screen.getByTestId('filter-bar')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-grid')).toBeInTheDocument();
  });

  it('navigates to the replay tab at the clicked event', () => {
    mockUseFullEventIndex.mockReturnValue(makeQueryResult(indexOf(5)));
    renderTimeline();

    fireEvent.click(screen.getByTestId('replay-btn-3'));

    const params = new URLSearchParams(screen.getByTestId('search-params').textContent ?? '');
    expect(params.get('tab')).toBe('replay');
    expect(params.get('event')).toBe('3');
    expect(params.get('session')).toBe('sess-a');
  });
});
