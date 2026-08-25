/**
 * HomeView tests.
 *
 * - Renders semester list from mocked GET /me.
 * - Empty memberships shows the "Ask an admin to invite you." message.
 * - Multiple semesters are all rendered.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mswServer } from '../../test-setup.js';
import { meNoSemestersHandler, meWithMembershipsHandler } from '../../test/msw-handlers.js';
import { HomeView } from './HomeView.js';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
}

function renderHomeView() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter>
        <HomeView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('HomeView', () => {
  it('renders semester list when user has memberships', async () => {
    renderHomeView();

    await waitFor(() => {
      expect(screen.getByTestId('semester-list')).toBeInTheDocument();
    });

    // Default handler returns one semester: CS 61A — Spring 2025
    expect(screen.getByText(/CS 61A.*Spring 2025/i)).toBeInTheDocument();
  });

  it('renders a link to /s/:semesterSlug for each semester', async () => {
    renderHomeView();

    await waitFor(() => {
      expect(screen.getByTestId('semester-link-sp25')).toBeInTheDocument();
    });

    const link = screen.getByTestId('semester-link-sp25');
    expect(link).toHaveAttribute('href', '/s/cs61a/sp25');
  });

  it('shows the "ask an admin" message when user has no semesters', async () => {
    mswServer.use(meNoSemestersHandler());

    renderHomeView();

    await waitFor(() => {
      expect(screen.getByTestId('no-semesters-message')).toBeInTheDocument();
    });

    expect(screen.getByTestId('no-semesters-message')).toHaveTextContent(
      /ask an admin to invite you/i,
    );
    expect(screen.queryByTestId('semester-list')).not.toBeInTheDocument();
  });

  it('renders multiple semesters when user has multiple memberships', async () => {
    mswServer.use(
      meWithMembershipsHandler([
        {
          semester_id: '00000000-0000-0000-0000-000000000010',
          semester_slug: 'sp25',
          semester_display_name: 'Spring 2025',
          course_slug: 'cs61a',
          course_name: 'CS 61A',
          role: 'admin',
          granted_at: '2025-01-01T00:00:00.000Z',
        },
        {
          semester_id: '00000000-0000-0000-0000-000000000011',
          semester_slug: 'fa24',
          semester_display_name: 'Fall 2024',
          course_slug: 'cs61a',
          course_name: 'CS 61A',
          role: 'grader',
          granted_at: '2024-08-15T00:00:00.000Z',
        },
      ]),
    );

    renderHomeView();

    await waitFor(() => {
      expect(screen.getByTestId('semester-list')).toBeInTheDocument();
    });

    expect(screen.getByTestId('semester-link-sp25')).toBeInTheDocument();
    expect(screen.getByTestId('semester-link-fa24')).toBeInTheDocument();
  });

  it('shows each semester role', async () => {
    renderHomeView();

    await waitFor(() => {
      expect(screen.getByText(/admin/i)).toBeInTheDocument();
    });
  });

  it('shows a "Local analysis" link to /local/load on the populated dashboard', async () => {
    renderHomeView();
    await waitFor(() => {
      expect(screen.getByTestId('local-analysis-link')).toBeInTheDocument();
    });
    expect(screen.getByTestId('local-analysis-link')).toHaveAttribute('href', '/local/load');
  });

  it('points a student at /enroll from the empty state', async () => {
    // A student with no memberships lands here, and /enroll is the only thing
    // they can do. Nothing else in the app links to it.
    mswServer.use(meNoSemestersHandler());
    renderHomeView();
    await waitFor(() => {
      expect(screen.getByTestId('enroll-link')).toBeInTheDocument();
    });
    expect(screen.getByTestId('enroll-link')).toHaveAttribute('href', '/enroll');
  });

  it('does NOT show the enrollment link once the user has a semester', async () => {
    renderHomeView();
    await waitFor(() => {
      expect(screen.getByTestId('semester-list')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('enroll-link')).not.toBeInTheDocument();
  });

  it('does NOT show the "Local analysis" link in the empty state', async () => {
    mswServer.use(meNoSemestersHandler());
    renderHomeView();
    await waitFor(() => {
      expect(screen.getByTestId('no-semesters-message')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('local-analysis-link')).not.toBeInTheDocument();
  });
});
