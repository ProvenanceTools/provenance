/**
 * SubmissionShell integration tests.
 *
 * Tests:
 * 1. Renders tab nav with all 6 tabs
 * 2. Defaults to Overview tab
 * 3. Clicking Timeline tab switches to Timeline content
 * 4. Clicking Replay tab shows stub
 * 5. URL ?tab=timeline restores Timeline tab on render
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { SubmissionShell } from './SubmissionShell.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SUBMISSION_ID = 'cccccccc-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------
// MSW handlers — minimal stubs so Overview doesn't error out
// ---------------------------------------------------------------------------

function setupMinimalHandlers() {
  mswServer.use(
    http.get(`/api/v1/submissions/${SUBMISSION_ID}/summary`, () =>
      HttpResponse.json({
        id: SUBMISSION_ID,
        student: { sid: '3031234', display_name: 'Bob Smith' },
        // Solo submission: exactly one contributor, the same person as `student`.
        contributors: [
          {
            contributor_key: 'roster:30000000-0000-0000-0000-000000000001',
            kind: 'roster',
            student: {
              id: '30000000-0000-0000-0000-000000000001',
              sid: '3031234',
              display_name: 'Bob Smith',
            },
            student_ref: null,
            session_count: 0,
            is_submitter: true,
            score_total: 0.0,
            score_max_severity: 'info',
            flag_counts: { info: 0, low: 0, medium: 0, high: 0 },
          },
        ],
        assignment: { assignment_id_str: 'hw2', label: 'Homework 2' },
        version_index: 1,
        score_total: 0.0,
        score_max_severity: null,
        validation_status: 'pass',
        validation_overall_detail: null,
        heuristic_config_version: 1,
        flag_count: 0,
        ingested_at: '2025-01-10T12:00:00.000Z',
      }),
    ),
    http.get(`/api/v1/submissions/${SUBMISSION_ID}/flags`, () => HttpResponse.json({ flags: [] })),
    http.get(`/api/v1/submissions/${SUBMISSION_ID}/validation`, () =>
      HttpResponse.json({ overall: 'pass', checks: [] }),
    ),
    http.get(`/api/v1/submissions/${SUBMISSION_ID}/files`, () => HttpResponse.json({ files: [] })),
    http.get(`/api/v1/submissions/${SUBMISSION_ID}/events`, () =>
      HttpResponse.json({ items: [], next_cursor: null }),
    ),
    http.get(`/api/v1/submissions/${SUBMISSION_ID}/stats`, () =>
      HttpResponse.json({
        per_file: [],
        aggregate: { total_events: 0, total_saves: 0, total_sessions: 0, total_wall_ms: 0 },
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

function renderShell(initialPath = `/s/cs61a/sp25/sub/${SUBMISSION_ID}`) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/s/:courseSlug/:semesterSlug/sub/:submissionId"
            element={<SubmissionShell />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubmissionShell — tab navigation', () => {
  it('renders all 6 tabs', () => {
    setupMinimalHandlers();
    renderShell();

    expect(screen.getByTestId('tab-overview')).toBeInTheDocument();
    expect(screen.getByTestId('tab-timeline')).toBeInTheDocument();
    expect(screen.getByTestId('tab-replay')).toBeInTheDocument();
    expect(screen.getByTestId('tab-validation')).toBeInTheDocument();
    expect(screen.getByTestId('tab-export')).toBeInTheDocument();
    expect(screen.getByTestId('tab-source')).toBeInTheDocument();
  });

  it('defaults to Overview tab content', async () => {
    setupMinimalHandlers();
    renderShell();

    // Overview renders submission-overview when loaded
    await waitFor(
      () => {
        expect(screen.getByTestId('submission-overview')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('clicking Timeline tab shows timeline content', async () => {
    setupMinimalHandlers();
    renderShell();

    // Click timeline tab
    fireEvent.click(screen.getByTestId('tab-timeline'));

    await waitFor(
      () => {
        expect(screen.getByTestId('submission-timeline')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('clicking Replay tab shows replay tab content', async () => {
    setupMinimalHandlers();
    mswServer.use(
      http.get(`/api/v1/submissions/${SUBMISSION_ID}/files`, () =>
        HttpResponse.json({
          files: [{ path: 'hw1.py', final_length: 100, saves: 3, reconstruction_tainted: false }],
        }),
      ),
      http.get(`/api/v1/submissions/${SUBMISSION_ID}/stats`, () =>
        HttpResponse.json({
          per_file: [],
          aggregate: { total_events: 50, total_saves: 3, total_sessions: 1, total_wall_ms: 0 },
        }),
      ),
    );
    renderShell();

    fireEvent.click(screen.getByTestId('tab-replay'));

    // Without session_ids in the summary handler, the Replay tab lands on the
    // "no replayable session" branch. Any of the new test ids confirms the
    // tab content rendered (vs. the prior stub's replay-tab id).
    await waitFor(
      () => {
        expect(screen.getByTestId('replay-no-session')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('clicking Validation tab shows validation panel', async () => {
    setupMinimalHandlers();
    renderShell();

    fireEvent.click(screen.getByTestId('tab-validation'));

    await waitFor(
      () => {
        expect(screen.getByTestId('validation-panel')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('clicking Export tab shows export panel', () => {
    setupMinimalHandlers();
    renderShell();

    fireEvent.click(screen.getByTestId('tab-export'));

    expect(screen.getByTestId('export-panel')).toBeInTheDocument();
  });

  it('?tab=timeline URL param activates timeline tab', async () => {
    setupMinimalHandlers();
    renderShell(`/s/cs61a/sp25/sub/${SUBMISSION_ID}?tab=timeline`);

    // Timeline tab is active from the start
    await waitFor(
      () => {
        expect(screen.getByTestId('submission-timeline')).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it('exposes ARIA tablist semantics with aria-selected on the active tab', async () => {
    setupMinimalHandlers();
    renderShell();

    const tablist = screen.getByRole('tablist', { name: 'Submission views' });
    expect(tablist).toBeInTheDocument();

    const overviewTab = screen.getByTestId('tab-overview');
    expect(overviewTab).toHaveAttribute('role', 'tab');
    expect(overviewTab).toHaveAttribute('aria-selected', 'true');

    const timelineTab = screen.getByTestId('tab-timeline');
    expect(timelineTab).toHaveAttribute('role', 'tab');
    expect(timelineTab).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(timelineTab);

    await waitFor(() => {
      expect(timelineTab).toHaveAttribute('aria-selected', 'true');
    });
    expect(overviewTab).toHaveAttribute('aria-selected', 'false');
  });
});
