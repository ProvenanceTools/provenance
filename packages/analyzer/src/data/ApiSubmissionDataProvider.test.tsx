/**
 * ApiSubmissionDataProvider integration tests.
 *
 * Tests:
 * 1. useSummary() fetches /submissions/:id/summary and returns data
 * 2. useFlags() fetches /submissions/:id/flags and returns array
 * 3. useStats() fetches /submissions/:id/stats and returns aggregate
 * 4. Overview renders submission summary fields from API
 * 5. Overview renders validation section from API
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../test-setup.js';
import { ApiSubmissionDataProviderContext } from './ApiSubmissionDataProvider.js';
import { useSubmissionData } from './SubmissionDataProvider.js';
import { Overview } from '../views/submission/Overview.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBMISSION_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const submissionSummaryFixture = {
  id: SUBMISSION_ID,
  student: { sid: '3031234', display_name: 'Alice Liddell' },
  // Solo submission: exactly one contributor, the same person as `student`.
  contributors: [
    {
      contributor_key: 'roster:30000000-0000-0000-0000-000000000001',
      kind: 'roster',
      student: {
        id: '30000000-0000-0000-0000-000000000001',
        sid: '3031234',
        display_name: 'Alice Liddell',
      },
      student_ref: null,
      session_count: 0,
      is_submitter: true,
      score_total: 5.5,
      score_max_severity: 'medium',
      flag_counts: { info: 0, low: 0, medium: 2, high: 0 },
    },
  ],
  assignment: { assignment_id_str: 'hw1', label: 'Homework 1' },
  version_index: 1,
  score_total: 5.5,
  score_max_severity: 'medium',
  validation_status: 'warn',
  validation_overall_detail: null,
  heuristic_config_version: 1,
  flag_count: 2,
  ingested_at: '2025-01-10T12:00:00.000Z',
};

const flagsFixture = [
  {
    id: '11111111-0000-0000-0000-000000000001',
    heuristic_id: 'large_paste',
    severity: 'medium',
    confidence: 0.85,
    score_contribution: 2.55,
    detail: { chars: 500 },
  },
];

const statsFixture = {
  per_file: [
    {
      path: 'hw1.py',
      final_length: 200,
      saves: 5,
      reconstruction_tainted: false,
    },
  ],
  aggregate: {
    total_events: 100,
    total_saves: 5,
    total_sessions: 1,
    total_wall_ms: 3600000,
  },
};

const validationFixture = {
  overall: 'warn',
  checks: [
    { id: 'manifest_sig', status: 'pass', detail: null },
    { id: 'chain_integrity', status: 'pass', detail: null },
    { id: 'submitted_code_match', status: 'skipped', detail: 'No reference hash available' },
  ],
};

const filesFixture = {
  files: [{ path: 'hw1.py', final_length: 200, saves: 5, reconstruction_tainted: false }],
};

// ---------------------------------------------------------------------------
// MSW handlers
// ---------------------------------------------------------------------------

function submissionSummaryHandler() {
  return http.get(`/api/v1/submissions/${SUBMISSION_ID}/summary`, () =>
    HttpResponse.json(submissionSummaryFixture),
  );
}

function submissionFlagsHandler() {
  return http.get(`/api/v1/submissions/${SUBMISSION_ID}/flags`, () =>
    HttpResponse.json({ flags: flagsFixture }),
  );
}

// Stats endpoint handler for future integration tests that exercise the stats section.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function submissionStatsHandler() {
  return http.get(`/api/v1/submissions/${SUBMISSION_ID}/stats`, () =>
    HttpResponse.json(statsFixture),
  );
}

function submissionValidationHandler() {
  return http.get(`/api/v1/submissions/${SUBMISSION_ID}/validation`, () =>
    HttpResponse.json(validationFixture),
  );
}

function submissionFilesHandler() {
  return http.get(`/api/v1/submissions/${SUBMISSION_ID}/files`, () =>
    HttpResponse.json(filesFixture),
  );
}

function submissionEventsHandler() {
  return http.get(`/api/v1/submissions/${SUBMISSION_ID}/events`, () =>
    HttpResponse.json({ items: [], next_cursor: null, total_count: 0 }),
  );
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
}

function renderOverviewWithApiProvider(submissionId: string = SUBMISSION_ID) {
  const qc = makeQueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/s/cs61a/sp25/sub/${submissionId}`]}>
        <Routes>
          <Route
            path="/s/:courseSlug/:semesterSlug/sub/:submissionId"
            element={
              <ApiSubmissionDataProviderContext submissionId={submissionId}>
                <Overview />
              </ApiSubmissionDataProviderContext>
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// The warn envelope on file content
// ---------------------------------------------------------------------------

/**
 * A qualified reconstruction arrives as `{ warning: { code, message } }` and
 * `content: ""`. This provider declared `warning: z.string()`, which no
 * response has ever matched, so a warned response failed the parse outright and
 * the tab showed a load error instead of the explanation the server sent.
 *
 * That matters more now that two of the three codes mean "there is no single
 * content" rather than "this content is best-effort": a client that drops the
 * warning renders an empty editor for a file two partners edited concurrently,
 * with nothing on screen saying why.
 */
function FileContentProbe({ path }: { path: string }) {
  const { data, isError } = useSubmissionData().useFileContent(path);
  if (isError) return <div data-testid="probe-error">error</div>;
  if (data === undefined) return <div data-testid="probe-loading">loading</div>;
  return (
    <div>
      <div data-testid="probe-content">{data.content}</div>
      <div data-testid="probe-warning">{data.warning ?? ''}</div>
      <div data-testid="probe-warning-detail">{data.warning_detail ?? ''}</div>
    </div>
  );
}

function renderFileContentProbe(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/submissions/${SUBMISSION_ID}`]}>
        <ApiSubmissionDataProviderContext submissionId={SUBMISSION_ID}>
          <FileContentProbe path={path} />
        </ApiSubmissionDataProviderContext>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ApiSubmissionDataProvider — file content warnings', () => {
  it.each([
    ['FILE_RECONSTRUCTION_CONCURRENT', '2 lineage(s) of hw1.py are live and unordered'],
    ['FILE_RECONSTRUCTION_UNKNOWN', 'the happens-before relation does not cover'],
    ['FILE_RECONSTRUCTION_TAINTED', 'Reconstruction tainted for file hw1.py'],
  ])('surfaces %s rather than failing the parse', async (code, message) => {
    mswServer.use(
      http.get(`/api/v1/submissions/${SUBMISSION_ID}/files/hw1.py/content`, () =>
        HttpResponse.json({
          submission_id: SUBMISSION_ID,
          path: 'hw1.py',
          at_seq: 12,
          content: '',
          computed_at_ms: 3,
          warning: { code, message, details: { path: 'hw1.py' } },
        }),
      ),
    );

    renderFileContentProbe('hw1.py');

    await waitFor(() => {
      expect(screen.getByTestId('probe-warning')).toHaveTextContent(code);
    });
    // The server's prose travels verbatim; the client does not re-word it.
    expect(screen.getByTestId('probe-warning-detail')).toHaveTextContent(message);
    expect(screen.queryByTestId('probe-error')).toBeNull();
  });

  it('leaves an ordinary response with no warning at all', async () => {
    mswServer.use(
      http.get(`/api/v1/submissions/${SUBMISSION_ID}/files/hw1.py/content`, () =>
        HttpResponse.json({
          submission_id: SUBMISSION_ID,
          path: 'hw1.py',
          at_seq: 12,
          content: 'print(1)\n',
          computed_at_ms: 3,
        }),
      ),
    );

    renderFileContentProbe('hw1.py');

    await waitFor(() => {
      expect(screen.getByTestId('probe-content')).toHaveTextContent('print(1)');
    });
    expect(screen.getByTestId('probe-warning')).toHaveTextContent('');
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApiSubmissionDataProvider — Overview renders from API', () => {
  it('renders student name and assignment from summary', async () => {
    mswServer.use(
      submissionSummaryHandler(),
      submissionFlagsHandler(),
      submissionValidationHandler(),
      submissionFilesHandler(),
      submissionEventsHandler(),
    );

    renderOverviewWithApiProvider();

    await waitFor(
      () => {
        expect(screen.getByTestId('summary-student')).toHaveTextContent('Alice Liddell');
        expect(screen.getByTestId('summary-assignment')).toHaveTextContent('Homework 1');
      },
      { timeout: 3000 },
    );
  });

  it('renders score from summary', async () => {
    mswServer.use(
      submissionSummaryHandler(),
      submissionFlagsHandler(),
      submissionValidationHandler(),
      submissionFilesHandler(),
      submissionEventsHandler(),
    );

    renderOverviewWithApiProvider();

    await waitFor(
      () => {
        expect(screen.getByTestId('summary-score')).toHaveTextContent('5.5');
      },
      { timeout: 3000 },
    );
  });

  it('renders flag count', async () => {
    mswServer.use(
      submissionSummaryHandler(),
      submissionFlagsHandler(),
      submissionValidationHandler(),
      submissionFilesHandler(),
      submissionEventsHandler(),
    );

    renderOverviewWithApiProvider();

    await waitFor(
      () => {
        expect(screen.getByTestId('summary-flag-count')).toHaveTextContent('2');
      },
      { timeout: 3000 },
    );
  });

  it('renders validation status from summary', async () => {
    mswServer.use(
      submissionSummaryHandler(),
      submissionFlagsHandler(),
      submissionValidationHandler(),
      submissionFilesHandler(),
      submissionEventsHandler(),
    );

    renderOverviewWithApiProvider();

    await waitFor(
      () => {
        expect(screen.getByTestId('summary-validation')).toHaveTextContent('WARN');
      },
      { timeout: 3000 },
    );
  });

  it('renders flag row from flags response', async () => {
    mswServer.use(
      submissionSummaryHandler(),
      submissionFlagsHandler(),
      submissionValidationHandler(),
      submissionFilesHandler(),
      submissionEventsHandler(),
    );

    renderOverviewWithApiProvider();

    await waitFor(
      () => {
        expect(
          screen.getByTestId('flag-row-11111111-0000-0000-0000-000000000001'),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('renders validation check statuses', async () => {
    mswServer.use(
      submissionSummaryHandler(),
      submissionFlagsHandler(),
      submissionValidationHandler(),
      submissionFilesHandler(),
      submissionEventsHandler(),
    );

    renderOverviewWithApiProvider();

    await waitFor(
      () => {
        // Validation section should show check IDs
        expect(screen.getByTestId('check-status-manifest_sig')).toBeInTheDocument();
        expect(screen.getByTestId('check-status-submitted_code_match')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('renders file from files response', async () => {
    mswServer.use(
      submissionSummaryHandler(),
      submissionFlagsHandler(),
      submissionValidationHandler(),
      submissionFilesHandler(),
      submissionEventsHandler(),
    );

    renderOverviewWithApiProvider();

    await waitFor(
      () => {
        expect(screen.getByTestId('file-row-hw1.py')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('shows loading state before data arrives', async () => {
    // Use a handler that never resolves (no handler registered for this path)
    // The component starts in loading state
    mswServer.use(
      http.get(`/api/v1/submissions/${SUBMISSION_ID}/summary`, () => {
        // Respond with a slow response by simply returning JSON after a tick
        return new Promise((resolve) => {
          setTimeout(() => resolve(HttpResponse.json(submissionSummaryFixture)), 100);
        });
      }),
    );

    renderOverviewWithApiProvider();

    // Should initially show loading
    expect(screen.getByTestId('overview-loading')).toBeInTheDocument();
  });
});
