/**
 * CrossFlagListView tests — Phase 24.
 *
 * Tests:
 * 1. Renders list of cross-flags.
 * 2. Shows empty state when no flags.
 * 3. A cross-flag row is reachable as a keyboard-focusable link with the
 *    correct href/accessible name (WCAG 2.1.1).
 * 4. Clicking a row's link navigates to detail page.
 * 5. Applying heuristic_id filter triggers refetch with param.
 * 6. Applying severity_min filter triggers refetch.
 * 7. Load-more button fetches next page.
 * 8. The cross-scope exclusion register renders as a non-finding panel, and a
 *    response from a server that predates the field still renders the page.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { CrossFlagListView } from './CrossFlagListView.js';
import {
  DEFAULT_COURSE_SLUG,
  DEFAULT_SEMESTER_ID,
  DEFAULT_SEMESTER_SLUG,
  defaultMembership,
  makeSoloContributor,
  meWithMembershipsHandler,
} from '../../test/msw-handlers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LIST_ALICE = {
  id: '30000000-0000-0000-0000-000000000001',
  sid: '3031234',
  display_name: 'Alice',
};
const LIST_BOB = {
  id: '30000000-0000-0000-0000-000000000002',
  sid: '3032345',
  display_name: 'Bob',
};
const LIST_NO_SCORE = {
  score_total: 0,
  score_max_severity: 'info' as const,
  flag_counts: { info: 0, low: 0, medium: 0, high: 0 },
};

function makeCrossFlag(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cf000000-0000-0000-0000-000000000001',
    heuristic_id: 'paste_shared_across_students',
    severity: 'high',
    confidence: 0.9,
    detail: null,
    participants: [
      {
        submission_id: 'aa000000-0000-0000-0000-000000000001',
        student: LIST_ALICE,
        contributors: [makeSoloContributor(LIST_ALICE, LIST_NO_SCORE)],
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'hw1' },
        supporting_seqs: [1, 2, 3],
      },
      {
        submission_id: 'bb000000-0000-0000-0000-000000000001',
        student: LIST_BOB,
        contributors: [makeSoloContributor(LIST_BOB, LIST_NO_SCORE)],
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'hw1' },
        supporting_seqs: [4, 5, 6],
      },
    ],
    created_at: '2025-01-10T12:00:00.000Z',
    ...overrides,
  };
}

/**
 * One row of the S20 exclusion register — a repository lineage whose members
 * were NOT compared against each other. A fact about the recording, never a
 * finding about a person (§6 Rule 3).
 */
function makeExclusion(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'ee000000-0000-0000-0000-000000000001',
    reason: 'same_repository_lineage',
    members: [
      {
        submission_id: 'aa000000-0000-0000-0000-000000000001',
        source_filename: 'alice_proj1.zip',
        contributors: [makeSoloContributor(LIST_ALICE, LIST_NO_SCORE)],
        student: {
          id: '30000000-0000-0000-0000-000000000001',
          sid: '3031234',
          display_name: 'Alice',
        },
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'proj1' },
      },
      {
        submission_id: 'bb000000-0000-0000-0000-000000000001',
        source_filename: 'bob_proj1.zip',
        contributors: [makeSoloContributor(LIST_BOB, LIST_NO_SCORE)],
        student: {
          id: '30000000-0000-0000-0000-000000000002',
          sid: '3032345',
          display_name: 'Bob',
        },
        assignment: { id: '20000000-0000-0000-0000-000000000001', assignment_id_str: 'proj1' },
      },
    ],
    shared_commits: ['repository:assumed-single ' + 'a1'.repeat(20)],
    excluded_pair_count: 1,
    created_at: '2025-01-10T12:00:00.000Z',
    ...overrides,
  };
}

function setupListHandler(
  items: object[] = [],
  nextCursor: string | null = null,
  exclusions: object[] = [],
) {
  mswServer.use(
    http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/cross-flags`, () =>
      HttpResponse.json({ items, next_cursor: nextCursor, exclusions }),
    ),
    meWithMembershipsHandler([defaultMembership]),
  );
}

/** A server that predates the register: no `exclusions` key at all. */
function setupPreRegisterListHandler(items: object[] = []) {
  mswServer.use(
    http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/cross-flags`, () =>
      HttpResponse.json({ items, next_cursor: null }),
    ),
    meWithMembershipsHandler([defaultMembership]),
  );
}

function renderListView() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter
        initialEntries={[`/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/cross-flags`]}
      >
        <Routes>
          <Route path="/s/:courseSlug/:semesterSlug/cross-flags" element={<CrossFlagListView />} />
          <Route
            path="/s/:courseSlug/:semesterSlug/cross-flags/:crossFlagId"
            element={<div data-testid="detail-page" />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CrossFlagListView', () => {
  it('renders cross-flag rows', async () => {
    setupListHandler([makeCrossFlag()]);
    renderListView();

    await waitFor(
      () => {
        expect(
          screen.getByTestId('cross-flag-row-cf000000-0000-0000-0000-000000000001'),
        ).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.getByText('paste_shared_across_students')).toBeInTheDocument();
  });

  it('shows empty state when no flags', async () => {
    setupListHandler([]);
    renderListView();

    await waitFor(() => {
      expect(screen.getByText(/No cross-flags found/)).toBeInTheDocument();
    });
  });

  it('exposes a row as a keyboard-focusable link with the correct href', async () => {
    setupListHandler([makeCrossFlag()]);
    renderListView();

    const link = await screen.findByRole('link', { name: 'paste_shared_across_students' });
    expect(link).toHaveAttribute(
      'href',
      `/s/${DEFAULT_COURSE_SLUG}/${DEFAULT_SEMESTER_SLUG}/cross-flags/cf000000-0000-0000-0000-000000000001`,
    );
  });

  it('clicking a row link navigates to detail page', async () => {
    setupListHandler([makeCrossFlag()]);
    renderListView();

    const link = await screen.findByRole('link', { name: 'paste_shared_across_students' });
    fireEvent.click(link);

    await waitFor(() => {
      expect(screen.getByTestId('detail-page')).toBeInTheDocument();
    });
  });

  it('apply filters button triggers refetch', async () => {
    let requestedUrl = '';
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/cross-flags`, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ items: [], next_cursor: null });
      }),
    );
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-flag-filters')).toBeInTheDocument();
    });

    // Type a heuristic_id filter
    fireEvent.change(screen.getByTestId('filter-heuristic-id'), {
      target: { value: 'editing_pattern_clone' },
    });

    // Apply
    fireEvent.click(screen.getByTestId('apply-filters-btn'));

    await waitFor(() => {
      // URL should contain heuristic_id param
      expect(requestedUrl).toContain('heuristic_id=editing_pattern_clone');
    });
  });

  it('severity_min filter is sent as query param', async () => {
    let requestedUrl = '';
    mswServer.use(
      http.get(`/api/v1/semesters/${DEFAULT_SEMESTER_ID}/cross-flags`, ({ request }) => {
        requestedUrl = request.url;
        return HttpResponse.json({ items: [], next_cursor: null });
      }),
    );
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('filter-severity-min')).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId('filter-severity-min'), {
      target: { value: 'high' },
    });
    fireEvent.click(screen.getByTestId('apply-filters-btn'));

    await waitFor(() => {
      expect(requestedUrl).toContain('severity_min=high');
    });
  });

  it('shows load-more button when next_cursor exists', async () => {
    setupListHandler([makeCrossFlag()], 'cursor-abc');
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('load-more-btn')).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// The exclusion register (spec S20 / §6 Rule 3)
// ---------------------------------------------------------------------------

describe('CrossFlagListView — the cross-scope exclusion register', () => {
  it('renders no panel at all when nothing was excluded', async () => {
    setupListHandler([makeCrossFlag()], null, []);
    renderListView();

    await waitFor(() => {
      expect(screen.getByText('paste_shared_across_students')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('cross-scope-exclusions')).not.toBeInTheDocument();
  });

  it('states an exclusion beside an EMPTY findings list', async () => {
    // The case the register exists for. Without it the grader sees "No
    // cross-flags found" and cannot tell a searched comparison from a withheld
    // one — an absence that reads exactly like a clean result.
    setupListHandler([], null, [makeExclusion()]);
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-scope-exclusions')).toBeInTheDocument();
    });

    expect(screen.getByText(/No cross-flags found/)).toBeInTheDocument();
    expect(
      screen.getByTestId('cross-scope-exclusion-ee000000-0000-0000-0000-000000000001'),
    ).toBeInTheDocument();
    expect(screen.getByText('Alice · Bob')).toBeInTheDocument();
    expect(screen.getByText(/1 comparison not applicable/)).toBeInTheDocument();
    expect(screen.getByText(/Established by 1 commit reference/)).toBeInTheDocument();
  });

  it('names the commits that proved the lineage', async () => {
    setupListHandler([], null, [makeExclusion()]);
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-scope-exclusion-commits')).toBeInTheDocument();
    });
    expect(screen.getByText('repository:assumed-single ' + 'a1'.repeat(20))).toBeInTheDocument();
  });

  it('falls back to the archive filename when no roster entry owns a member (D9)', async () => {
    const ex = makeExclusion();
    // NOTHING names this member: no owning roster entry AND no resolved
    // contributors. Nulling `student` alone is no longer that case — the
    // contributor list names a group submission that has no single owner,
    // which is the point of the test below.
    const members = (ex.members as Array<Record<string, unknown>>).map((m, i) =>
      i === 0 ? { ...m, student: null, contributors: [] } : m,
    );
    setupListHandler([], null, [{ ...ex, members }]);
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-scope-exclusions')).toBeInTheDocument();
    });
    // The member is still LISTED. A group submission with no single owner must
    // not vanish from the register just because it has no name to show.
    expect(screen.getByText('alice_proj1.zip · Bob')).toBeInTheDocument();
  });

  it('names EVERY contributor of a group member, not one arbitrary submitter', async () => {
    // The register exists to say "these submissions are one partnership, so
    // they were deliberately not compared". Naming only `student` — the single
    // submitter of record — names one arbitrary partner in the one place the
    // partnership itself is the point.
    const ex = makeExclusion();
    const members = (ex.members as Array<Record<string, unknown>>).map((m, i) =>
      i === 0
        ? {
            ...m,
            student: null,
            contributors: [
              makeSoloContributor(LIST_ALICE, LIST_NO_SCORE),
              makeSoloContributor(LIST_BOB, LIST_NO_SCORE),
            ],
          }
        : m,
    );
    setupListHandler([], null, [{ ...ex, members }]);
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-scope-exclusions')).toBeInTheDocument();
    });
    expect(screen.getByText(/Alice/)).toBeInTheDocument();
    expect(screen.getByText(/Bob/)).toBeInTheDocument();
    // The filename fallback must NOT be reached when contributors resolve.
    expect(screen.queryByText(/alice_proj1\.zip/)).not.toBeInTheDocument();
  });

  it('is NOT rendered as a finding row', async () => {
    // §6 Rule 3: an exclusion is a statement about the recording, never about a
    // person. It must not acquire a severity, a confidence or a detail link by
    // being folded into the findings table.
    setupListHandler([], null, [makeExclusion()]);
    renderListView();

    await waitFor(() => {
      expect(screen.getByTestId('cross-scope-exclusions')).toBeInTheDocument();
    });

    const panel = screen.getByTestId('cross-scope-exclusions');
    expect(panel.querySelector('a')).toBeNull();
    // The findings table still reports zero rows.
    expect(screen.getByText(/No cross-flags found/)).toBeInTheDocument();
  });

  it('still renders when the server predates the register field', async () => {
    // Rolling deploy: a cached analyzer bundle talking to an older server. The
    // schema default must keep the whole cross-flags view working rather than
    // failing the response parse and blanking the page.
    setupPreRegisterListHandler([makeCrossFlag()]);
    renderListView();

    await waitFor(() => {
      expect(screen.getByText('paste_shared_across_students')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('cross-scope-exclusions')).not.toBeInTheDocument();
  });
});
