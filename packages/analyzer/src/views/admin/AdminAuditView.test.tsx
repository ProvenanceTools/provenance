/**
 * AdminAuditView — compact event rows, expandable detail, cursor paging.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { mswServer } from '../../test-setup.js';
import { AdminAuditView } from './AdminAuditView.js';

const SUPERADMIN_ME = {
  principal_kind: 'session' as const,
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'sa@berkeley.edu',
    display_name: 'Superadmin',
    is_superadmin: true,
    protected: false,
    created_at: '2025-01-01T00:00:00.000Z',
    last_login_at: '2025-01-15T10:00:00.000Z',
  },
  memberships: [],
  view_as: null,
};

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const SEMESTER_ID = '6c413af0-87e6-4f98-9d24-f60df744a42f';

function row(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    actor_user_id: ACTOR_ID,
    actor_token_id: null,
    semester_id: SEMESTER_ID,
    action: 'heuristic_config.dry_run',
    target_type: 'semester',
    target_id: SEMESTER_ID,
    detail: { semesterId: SEMESTER_ID, candidate_version: id },
    at: '2026-11-13T23:54:13.000Z',
    ...overrides,
  };
}

function render_() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/audit']}>
        <AdminAuditView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function useCommonHandlers() {
  mswServer.use(
    http.get('/api/v1/me', () => HttpResponse.json(SUPERADMIN_ME)),
    http.get('/api/v1/admin/users', () =>
      HttpResponse.json({
        items: [
          {
            id: ACTOR_ID,
            email: 'alpha@berkeley.edu',
            display_name: 'Alpha',
            is_superadmin: false,
            protected: false,
            created_at: '2025-02-01T00:00:00.000Z',
            last_login_at: null,
          },
        ],
        next_cursor: null,
      }),
    ),
  );
}

describe('AdminAuditView', () => {
  it('renders one compact row per event with the actor resolved to an email', async () => {
    useCommonHandlers();
    mswServer.use(
      http.get('/api/v1/audit', () => HttpResponse.json({ items: [row(1)], next_cursor: null })),
    );
    render_();

    const event = await screen.findByTestId('audit-row-1');
    expect(within(event).getByText('dry_run')).toBeInTheDocument();
    await waitFor(() => expect(within(event).getByText('alpha@berkeley.edu')).toBeInTheDocument());
    // Ids are shortened in the summary line, not printed whole.
    expect(within(event).getAllByText('6c413af0').length).toBeGreaterThan(0);
  });

  it('keeps full ids and pretty-printed detail inside the expandable section', async () => {
    useCommonHandlers();
    mswServer.use(
      http.get('/api/v1/audit', () => HttpResponse.json({ items: [row(1)], next_cursor: null })),
    );
    render_();

    const detail = await screen.findByTestId('audit-detail-1');
    // Pretty-printed (multi-line), not one long line.
    expect(detail.textContent).toContain('\n');
    expect(detail.textContent).toContain('"candidate_version": 1');
    // The <details> body holds the full uuid.
    expect(within(screen.getByTestId('audit-row-1')).getByText(ACTOR_ID)).toBeInTheDocument();
  });

  it('omits the detail block when detail is empty', async () => {
    useCommonHandlers();
    mswServer.use(
      http.get('/api/v1/audit', () =>
        HttpResponse.json({ items: [row(1, { detail: {} })], next_cursor: null }),
      ),
    );
    render_();

    await screen.findByTestId('audit-row-1');
    expect(screen.queryByTestId('audit-detail-1')).toBeNull();
  });

  it('Load more follows next_cursor and appends the older page', async () => {
    useCommonHandlers();
    const cursorsSeen: Array<string | null> = [];
    mswServer.use(
      http.get('/api/v1/audit', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        cursorsSeen.push(cursor);
        return cursor === null
          ? HttpResponse.json({ items: [row(2)], next_cursor: 'page-2' })
          : HttpResponse.json({ items: [row(1)], next_cursor: null });
      }),
    );
    render_();

    await screen.findByTestId('audit-row-2');
    expect(screen.queryByTestId('audit-end')).toBeNull();

    fireEvent.click(screen.getByTestId('audit-load-more'));

    await screen.findByTestId('audit-row-1');
    // Page one is still on screen — appended, not replaced.
    expect(screen.getByTestId('audit-row-2')).toBeInTheDocument();
    expect(cursorsSeen).toEqual([null, 'page-2']);
    expect(screen.getByTestId('audit-end')).toBeInTheDocument();
    expect(screen.queryByTestId('audit-load-more')).toBeNull();
  });

  it('shows the empty state when nothing matches', async () => {
    useCommonHandlers();
    mswServer.use(
      http.get('/api/v1/audit', () => HttpResponse.json({ items: [], next_cursor: null })),
    );
    render_();

    expect(await screen.findByText('No audit rows match.')).toBeInTheDocument();
  });
});
