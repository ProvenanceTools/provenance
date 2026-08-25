/**
 * App routing tests.
 *
 * Tests:
 * - / redirects to /home (v3 behavior; RequireAuth redirects to /login if unauthed)
 * - /local/load shows the drop zone (Phase 25: v2 routes moved under /local)
 * - /load redirects to /local/load (legacy bookmark redirect preserved)
 * - /local/overview redirects to /local/load when no bundle loaded
 * - /local/timeline redirects to /local/load when no bundle loaded
 * - After loading a bundle, /local/load navigates to /local/overview
 *
 * All tests wrap App with QueryClientProvider because App now renders RequireAuth
 * at /home which calls useMe().
 */

import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { App } from './App.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { mswServer } from './test-setup.js';
import { meNoSemestersHandler, meUnauthorizedHandler } from './test/msw-handlers.js';

// Wire SHA-512 override.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderApp(initialPath: string) {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('App routing', () => {
  it('renders the public landing page at / for anonymous visitors', async () => {
    mswServer.use(meUnauthorizedHandler());
    renderApp('/');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: /provenance/i })).toBeInTheDocument();
    });
    // Anonymous → sign-in button, NOT redirected away to a protected page.
    expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    // Assert content unique to the landing page (LoginView has neither h2 nor this heading).
    expect(screen.getByRole('heading', { level: 2, name: /what it does/i })).toBeInTheDocument();
  });

  it('redirects anonymous visitors from /local/load to the login page', async () => {
    mswServer.use(meUnauthorizedHandler());
    renderApp('/local/load');
    // RequireAuth bounces anon → /login, which shows the sign-in button and NOT the drop zone.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('drop-zone')).not.toBeInTheDocument();
  });

  it('renders /enroll for a student with no memberships', async () => {
    // The point of the route: a student session has memberships: [], which
    // RequireStaff would bounce to /home. /enroll must be reachable anyway.
    mswServer.use(meNoSemestersHandler());
    renderApp('/enroll');
    await waitFor(() => {
      expect(screen.getByTestId('enroll-form')).toBeInTheDocument();
    });
  });

  it('sends an anonymous visitor at /enroll to the login page', async () => {
    mswServer.use(meUnauthorizedHandler());
    renderApp('/enroll');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('enroll-form')).not.toBeInTheDocument();
  });

  it('renders /compose/manifest for an authenticated staff member', async () => {
    renderApp('/compose/manifest');
    await waitFor(() => {
      expect(screen.getByTestId('composer-form')).toBeInTheDocument();
    });
  });

  it('keeps a student out of /compose/manifest', async () => {
    // The page handles the course SIGNING key. A student session is a valid
    // session, so RequireAuth alone would let them in; RequireStaff is what
    // does not. Bounced to /home, which for a student is the invite dead end.
    mswServer.use(meNoSemestersHandler());
    renderApp('/compose/manifest');
    await waitFor(() => {
      expect(screen.getByTestId('no-semesters-message')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('composer-form')).not.toBeInTheDocument();
  });

  it('sends an anonymous visitor at /compose/manifest to the login page', async () => {
    mswServer.use(meUnauthorizedHandler());
    renderApp('/compose/manifest');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign in with google/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('composer-form')).not.toBeInTheDocument();
  });

  it('renders /local/load for an authenticated staff member', async () => {
    // Default /me handler returns a user WITH a membership → RequireStaff passes.
    renderApp('/local/load');
    await waitFor(() => {
      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });
  });

  it('renders load view at /local/load', async () => {
    renderApp('/local/load');
    // React.lazy + Suspense: wait for the component to load.
    await waitFor(() => {
      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });
  });

  it('/load redirects to /local/load (legacy bookmark redirect)', async () => {
    renderApp('/load');
    // Legacy redirect: /load → /local/load → shows drop zone.
    await waitFor(() => {
      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });
  });

  it('RequireLocalBundle redirects /local/overview to /local/load when no bundle is loaded', async () => {
    renderApp('/local/overview');
    // Should redirect to /local/load and show the drop zone.
    await waitFor(() => {
      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });
  });

  it('RequireLocalBundle redirects /local/timeline to /local/load when no bundle is loaded', async () => {
    renderApp('/local/timeline');
    await waitFor(() => {
      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });
  });

  it('after a bundle is loaded, /local/load navigates to /local/overview', async () => {
    const { blob } = await buildTestBundle({ sessions: [{ eventCount: 2 }] });
    const file = new File([blob], 'bundle.zip', { type: 'application/zip' });

    renderApp('/local/load');

    // Wait for lazy chunk to load.
    await waitFor(() => {
      expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
    });

    act(() => {
      fireEvent.drop(screen.getByTestId('drop-zone'), {
        dataTransfer: { files: [file] as unknown as FileList },
      });
    });

    // After load completes, the app should navigate to /local/overview.
    await waitFor(
      () => {
        expect(screen.getByTestId('overview-view')).toBeInTheDocument();
      },
      { timeout: 5000 },
    );
  });
});
