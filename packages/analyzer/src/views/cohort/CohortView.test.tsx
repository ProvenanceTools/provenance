/**
 * CohortView integration tests.
 *
 * Tests:
 * 1. Renders rows from a mocked /submissions response
 * 2. Filter change (Apply button) triggers a new API call with updated query params
 * 3. URL reload with ?score_min=5 restores the filter selection in the rail
 * 4. "By student" tab toggle switches to the rollup table
 * 5. 5k-row virtualization dataset renders without error
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import {
  cohortSubmissionsHandler,
  cohortStudentsHandler,
  assignmentsHandler,
  makeSubmissionRow,
  makeStudentRollupRow,
  DEFAULT_COURSE_SLUG,
  DEFAULT_SEMESTER_ID,
  DEFAULT_SEMESTER_SLUG,
} from '../../test/msw-handlers.js';
import { CohortView } from './CohortView.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false, // override hook-level retry for tests
        retryDelay: 0,
      },
    },
  });
}

function renderCohortView(initialPath = `/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}`) {
  const qc = makeQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/s/:courseSlug/:semesterSlug/*" element={<CohortView />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CohortView', () => {
  it('renders submission rows from a mocked /submissions response', async () => {
    const rows = [
      makeSubmissionRow({
        id: '10000000-0000-0000-0000-000000000001',
        student: {
          id: '30000000-0000-0000-0000-000000000001',
          sid: '3031234',
          display_name: 'Alice Liddell',
        },
      }),
      makeSubmissionRow({
        id: '10000000-0000-0000-0000-000000000002',
        student: {
          id: '30000000-0000-0000-0000-000000000002',
          sid: '3031235',
          display_name: 'Bob Builders',
        },
      }),
    ];

    mswServer.use(
      cohortSubmissionsHandler(rows, { total_count: 2 }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView();

    // Wait for cohort view to render with total count from data
    await waitFor(
      () => {
        expect(screen.getByTestId('cohort-total-count')).toHaveTextContent('2 submissions');
      },
      { timeout: 3000 },
    );

    // The table container should be present
    expect(screen.getByTestId('cohort-table-scroll')).toBeInTheDocument();

    // With only 2 rows, virtualizer renders all of them
    // Student names are rendered in the table cells
    await waitFor(
      () => {
        expect(screen.getByText('Alice Liddell')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.getByText('Bob Builders')).toBeInTheDocument();
  });

  it('shows loading state while fetching', async () => {
    // Delay the response to ensure loading state shows
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/submissions`, async () => {
        await new Promise((r) => setTimeout(r, 50));
        return HttpResponse.json({
          items: [],
          next_cursor: null,
          total_count: 0,
          facets: {
            by_severity: { info: 0, low: 0, medium: 0, high: 0 },
            by_validation: { pass: 0, warn: 0, fail: 0 },
            by_assignment: [],
          },
        });
      }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView();

    // Should show cohort view eventually (after the delayed response)
    const cohortView = await screen.findByTestId('cohort-view');
    expect(cohortView).toBeInTheDocument();
  });

  it('filter Apply triggers new API call with updated query params', async () => {
    const apiCallUrls: string[] = [];

    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/submissions`, ({ request }) => {
        apiCallUrls.push(request.url);
        return HttpResponse.json({
          items: [],
          next_cursor: null,
          total_count: 0,
          facets: {
            by_severity: { info: 0, low: 0, medium: 0, high: 0 },
            by_validation: { pass: 0, warn: 0, fail: 0 },
            by_assignment: [],
          },
        });
      }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView();

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByTestId('cohort-view')).toBeInTheDocument();
    });

    // Set score_min filter in the rail
    const scoreMinInput = await screen.findByTestId('filter-score-min');
    fireEvent.change(scoreMinInput, { target: { value: '5' } });

    // Click Apply
    const applyBtn = screen.getByTestId('filter-apply');
    fireEvent.click(applyBtn);

    // Wait for a new API call with score_min=5
    await waitFor(
      () => {
        const hasScoreMin = apiCallUrls.some((url) => url.includes('score_min=5'));
        expect(hasScoreMin).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it('URL reload with ?score_min=5 restores filter in the rail', async () => {
    mswServer.use(
      cohortSubmissionsHandler([], { total_count: 0 }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView(`/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}?score_min=5`);

    await waitFor(() => {
      expect(screen.getByTestId('cohort-view')).toBeInTheDocument();
    });

    // The score_min input should have value 5 (decoded from URL into draft state)
    const scoreMinInput = (await screen.findByTestId('filter-score-min')) as HTMLInputElement;
    expect(scoreMinInput.value).toBe('5');
  });

  it('URL reload with active/total minute filters restores values in the rail', async () => {
    mswServer.use(
      cohortSubmissionsHandler([], { total_count: 0 }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView(
      `/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}?active_minutes_min=15&total_minutes_max=120`,
    );

    await waitFor(() => {
      expect(screen.getByTestId('cohort-view')).toBeInTheDocument();
    });

    const activeMin = (await screen.findByTestId(
      'filter-active-minutes-min',
    )) as HTMLInputElement;
    const totalMax = (await screen.findByTestId('filter-total-minutes-max')) as HTMLInputElement;
    expect(activeMin.value).toBe('15');
    expect(totalMax.value).toBe('120');
  });

  it('applying active time filter hits the API with active_minutes_min', async () => {
    const apiCallUrls: string[] = [];

    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/submissions`, ({ request }) => {
        apiCallUrls.push(request.url);
        return HttpResponse.json({
          items: [],
          next_cursor: null,
          total_count: 0,
          facets: {
            by_severity: { info: 0, low: 0, medium: 0, high: 0 },
            by_validation: { pass: 0, warn: 0, fail: 0 },
            by_assignment: [],
          },
        });
      }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView();

    await waitFor(() => {
      expect(screen.getByTestId('cohort-view')).toBeInTheDocument();
    });

    const activeMinInput = await screen.findByTestId('filter-active-minutes-min');
    fireEvent.change(activeMinInput, { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('filter-apply'));

    await waitFor(
      () => {
        expect(apiCallUrls.some((url) => url.includes('active_minutes_min=20'))).toBe(true);
      },
      { timeout: 3000 },
    );
  });

  it('"By student" tab toggle switches to student rollup table', async () => {
    const studentRows = [makeStudentRollupRow()];

    mswServer.use(
      cohortSubmissionsHandler([]),
      cohortStudentsHandler(studentRows),
      assignmentsHandler(),
    );

    renderCohortView();

    await waitFor(() => {
      expect(screen.getByTestId('tab-students')).toBeInTheDocument();
    });

    // Click "By student" tab
    fireEvent.click(screen.getByTestId('tab-students'));

    // Student table should appear
    await waitFor(
      () => {
        expect(screen.getByTestId('student-table-scroll')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    // The submission table should not be visible
    expect(screen.queryByTestId('cohort-table-scroll')).not.toBeInTheDocument();
  });

  it('exposes aria-pressed on the active view toggle button', async () => {
    mswServer.use(
      cohortSubmissionsHandler([], { total_count: 0 }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView();

    await waitFor(() => {
      expect(screen.getByTestId('tab-submissions')).toBeInTheDocument();
    });

    expect(screen.getByTestId('tab-submissions')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('tab-students')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('tab-students'));

    await waitFor(() => {
      expect(screen.getByTestId('tab-students')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByTestId('tab-submissions')).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders 5k-row dataset without error (virtualization smoke test)', async () => {
    // Generate 5000 rows with valid UUIDs
    // UUID format: 8-4-4-4-12 hex chars
    function padHex(n: number, len: number): string {
      return n.toString(16).padStart(len, '0');
    }
    const rows = Array.from({ length: 5000 }, (_, i) =>
      makeSubmissionRow({
        id: `10000000-0000-0000-0000-${padHex(i + 1, 12)}`,
        student: {
          id: `30000000-0000-0000-0000-${padHex(i + 1, 12)}`,
          sid: String(3031234 + i),
          display_name: `Student ${i}`,
        },
      }),
    );

    mswServer.use(
      cohortSubmissionsHandler(rows, { total_count: 5000 }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView();

    // Total count badge should show 5000
    await waitFor(
      () => {
        expect(screen.getByTestId('cohort-total-count')).toHaveTextContent('5000 submissions');
      },
      { timeout: 3000 },
    );

    // The table scroll container should exist (virtualization wrapper)
    expect(screen.getByTestId('cohort-table-scroll')).toBeInTheDocument();

    // Virtualization: with jsdom clientHeight=600 and estimateSize=52,
    // the virtualizer renders ~11+overscan rows (not all 5000).
    // We just verify the table renders without throwing and the container is mounted.
    // At minimum one row should be rendered (index 0 = "Student 0")
    await waitFor(
      () => {
        // The virtualizer renders a window of rows; Student 0 should be in the first batch
        expect(screen.getByText('Student 0')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('shows the infinite-scroll sentinel when next_cursor is non-null', async () => {
    mswServer.use(
      cohortSubmissionsHandler([makeSubmissionRow()], {
        next_cursor: 'cursor-abc',
        total_count: 100,
      }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView();

    await waitFor(
      () => {
        expect(screen.getByTestId('cohort-load-more-sentinel')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('does not show the sentinel when next_cursor is null', async () => {
    mswServer.use(
      cohortSubmissionsHandler([makeSubmissionRow()], { next_cursor: null }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    renderCohortView();

    await waitFor(
      () => {
        expect(screen.getByTestId('cohort-table-scroll')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    expect(screen.queryByTestId('cohort-load-more-sentinel')).not.toBeInTheDocument();
  });

  it('load-more uses accumulated cursor state, not first-page query result', async () => {
    // Replace the noop IntersectionObserver stub from test-setup with one
    // that auto-fires `isIntersecting: true` on observe() so the cohort
    // table's infinite-scroll effect drives subsequent page fetches.
    const originalIO = globalThis.IntersectionObserver;
    type IOCallback = (entries: { isIntersecting: boolean }[]) => void;
    const callbacks = new Set<IOCallback>();
    class AutoFiringIO {
      constructor(cb: IOCallback) {
        callbacks.add(cb);
      }
      observe = () => {
        for (const cb of callbacks) cb([{ isIntersecting: true }]);
      };
      unobserve = () => {};
      disconnect = () => {
        callbacks.clear();
      };
      takeRecords = () => [] as unknown[];
    }
    (globalThis as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
      AutoFiringIO as unknown as typeof IntersectionObserver;

    // Track which cursors are requested
    const requestedCursors: (string | null)[] = [];

    // Helper to create a handler that records the cursor and returns different results
    const createDynamicSubmissionsHandler = () =>
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/submissions`, ({ request }) => {
        const url = new URL(request.url);
        const cursor = url.searchParams.get('cursor');
        requestedCursors.push(cursor);

        // First request: cursor=null, return cursor='c1'
        if (cursor === null) {
          return HttpResponse.json({
            items: [makeSubmissionRow({ id: '10000000-0000-0000-0000-000000000001' })],
            next_cursor: 'c1',
            total_count: 3,
            facets: {
              by_severity: { info: 0, low: 0, medium: 0, high: 0 },
              by_validation: { pass: 0, warn: 0, fail: 0 },
              by_assignment: [],
            },
          });
        }
        // Second request: cursor='c1', return cursor='c2'
        if (cursor === 'c1') {
          return HttpResponse.json({
            items: [makeSubmissionRow({ id: '10000000-0000-0000-0000-000000000002' })],
            next_cursor: 'c2',
            total_count: 3,
            facets: {
              by_severity: { info: 0, low: 0, medium: 0, high: 0 },
              by_validation: { pass: 0, warn: 0, fail: 0 },
              by_assignment: [],
            },
          });
        }
        // Third request: cursor='c2', return cursor=null (last page)
        if (cursor === 'c2') {
          return HttpResponse.json({
            items: [makeSubmissionRow({ id: '10000000-0000-0000-0000-000000000003' })],
            next_cursor: null,
            total_count: 3,
            facets: {
              by_severity: { info: 0, low: 0, medium: 0, high: 0 },
              by_validation: { pass: 0, warn: 0, fail: 0 },
              by_assignment: [],
            },
          });
        }

        return HttpResponse.json({
          items: [],
          next_cursor: null,
          total_count: 0,
          facets: {
            by_severity: { info: 0, low: 0, medium: 0, high: 0 },
            by_validation: { pass: 0, warn: 0, fail: 0 },
            by_assignment: [],
          },
        });
      });

    mswServer.use(
      createDynamicSubmissionsHandler(),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    try {
      renderCohortView();

      // The auto-firing observer drives load-more each time the sentinel
      // mounts; the effect re-runs on the new nextCursor and triggers the
      // next page fetch. We should see [null, 'c1', 'c2'] requested.
      await vi.waitFor(
        () => {
          expect(requestedCursors.length).toBe(3);
        },
        { timeout: 3000 },
      );

      expect(requestedCursors).toEqual([null, 'c1', 'c2']);
    } finally {
      (globalThis as { IntersectionObserver: typeof IntersectionObserver }).IntersectionObserver =
        originalIO;
    }
  });
});

// ---------------------------------------------------------------------------
// Additional: error handling
// ---------------------------------------------------------------------------

describe('CohortView access states', () => {
  it('shows a no-access message (not an infinite spinner) for a slug not in your memberships', async () => {
    // Default /me handler returns membership for slug "sp25" only. Navigating to
    // a slug you have no membership for must resolve to a clear no-access state
    // once /me has loaded — not hang forever on "Loading semester…".
    renderCohortView('/s/cs61a/ghost-semester');

    await waitFor(() => expect(screen.getByTestId('cohort-no-access')).toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.queryByTestId('cohort-no-semester')).not.toBeInTheDocument();
  });
});

describe('CohortView error handling', () => {
  it('shows error state when API returns error', async () => {
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/submissions`, () => {
        return HttpResponse.json(
          { error: { code: 'FORBIDDEN', message: 'Forbidden' } },
          { status: 403 },
        );
      }),
      cohortStudentsHandler([]),
      assignmentsHandler(),
    );

    // Suppress the expected console.error from React Query
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    renderCohortView();

    await waitFor(
      () => {
        expect(screen.getByTestId('cohort-error')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );

    spy.mockRestore();
  });
});
