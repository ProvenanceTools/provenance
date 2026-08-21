/**
 * CrossFlagDetailView tests — Phase 24.
 *
 * Tests:
 * 1. Renders cross-flag detail with participants.
 * 2. Renders heuristic ID, severity badge, confidence.
 * 3. Renders each participant with student display name and supporting seqs.
 * 4. Shows error state on fetch failure.
 * 5. Back link navigates to list.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { CrossFlagDetailView } from './CrossFlagDetailView.js';
import { DEFAULT_COURSE_SLUG, DEFAULT_SEMESTER_SLUG } from '../../test/msw-handlers.js';
import { UNNAMED_CONTRIBUTOR_LABEL } from '../../lib/contributor-display.js';

const CROSS_FLAG_ID = 'cf000000-0000-0000-0000-000000000001';

const DETAIL_FIXTURE = {
  item: {
    id: CROSS_FLAG_ID,
    heuristic_id: 'paste_shared_across_students',
    severity: 'high',
    confidence: 0.92,
    detail: { match_ratio: 0.85 },
    participants: [
      {
        submission_id: 'aa000000-0000-0000-0000-000000000001',
        student: {
          id: '30000000-0000-0000-0000-000000000001',
          sid: '3031234',
          display_name: 'Alice Liddell',
        },
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'hw1' },
        supporting_seqs: [100, 101, 102],
      },
      {
        submission_id: 'bb000000-0000-0000-0000-000000000001',
        student: {
          id: '30000000-0000-0000-0000-000000000002',
          sid: '3032345',
          display_name: 'Bob Builder',
        },
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'hw1' },
        supporting_seqs: [200, 201, 202],
      },
    ],
    created_at: '2025-01-10T12:00:00.000Z',
  },
};

function setupDetailHandler(status = 200, body: object = DETAIL_FIXTURE) {
  mswServer.use(
    http.get(`/api/v1/cross-flags/${CROSS_FLAG_ID}`, () => HttpResponse.json(body, { status })),
  );
}

function renderDetailView() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[
          `/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/cross-flags/${CROSS_FLAG_ID}`,
        ]}
      >
        <Routes>
          <Route
            path="/s/:courseSlug/:semesterSlug/cross-flags/:crossFlagId"
            element={<CrossFlagDetailView />}
          />
          <Route
            path="/s/:courseSlug/:semesterSlug/cross-flags"
            element={<div data-testid="list-page" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossFlagDetailView', () => {
  it('renders cross-flag heuristic, severity, and confidence', async () => {
    setupDetailHandler();
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-flag-detail-view')).toBeInTheDocument();
    });

    expect(screen.getByText('paste_shared_across_students')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText(/92%/)).toBeInTheDocument();
  });

  it('renders both participants', async () => {
    setupDetailHandler();
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-flag-detail-view')).toBeInTheDocument();
    });

    expect(
      screen.getByTestId('participant-aa000000-0000-0000-0000-000000000001'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('participant-bb000000-0000-0000-0000-000000000001'),
    ).toBeInTheDocument();
    expect(screen.getByText('Alice Liddell')).toBeInTheDocument();
    expect(screen.getByText('Bob Builder')).toBeInTheDocument();
  });

  it('renders supporting seqs per participant', async () => {
    setupDetailHandler();
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('participants-grid')).toBeInTheDocument();
    });

    // Alice's supporting seqs
    expect(screen.getByText(/100, 101, 102/)).toBeInTheDocument();
  });

  it('shows error state on fetch failure', async () => {
    setupDetailHandler(404, { error: { code: 'NOT_FOUND', message: 'not found' } });
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-flag-detail-error')).toBeInTheDocument();
    });
  });

  it('back link navigates to cross-flags list', async () => {
    setupDetailHandler();
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('back-to-list')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('back-to-list'));

    await waitFor(() => {
      expect(screen.getByTestId('list-page')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Unnamed participants (0029 cut-over)
// ---------------------------------------------------------------------------

describe('CrossFlagDetailView — participants not on the roster', () => {
  it('still lists a participant whose student is null, with neutral wording', async () => {
    const body = {
      item: {
        ...DETAIL_FIXTURE.item,
        participants: [
          DETAIL_FIXTURE.item.participants[0],
          { ...DETAIL_FIXTURE.item.participants[1], student: null },
        ],
      },
    };
    setupDetailHandler(200, body);
    renderDetailView();

    await waitFor(() => {
      expect(screen.getByTestId('participants-grid')).toBeInTheDocument();
    });

    // Both participants are present — an unnamed one is never dropped, which
    // would turn a two-party cross flag into a one-party one.
    expect(
      screen.getByTestId('participant-aa000000-0000-0000-0000-000000000001'),
    ).toBeInTheDocument();
    const unnamedCard = screen.getByTestId('participant-bb000000-0000-0000-0000-000000000001');
    expect(unnamedCard).toBeInTheDocument();

    expect(within(unnamedCard).getByText(UNNAMED_CONTRIBUTOR_LABEL)).toBeInTheDocument();
    // No invented SID, and the assignment id still renders.
    expect(unnamedCard.textContent).not.toContain('SID:');
    expect(within(unnamedCard).getByText('hw1')).toBeInTheDocument();
    // The named participant is untouched.
    expect(screen.getByText('Alice Liddell')).toBeInTheDocument();
    expect(screen.getByText(/SID: 3031234/)).toBeInTheDocument();
  });
});
