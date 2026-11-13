/**
 * AppShell — top navigation bar + content area.
 *
 * Structure:
 * - Top bar: Provenance logo, SemesterSwitcher (if multiple semesters), user menu
 * - User menu: displays email, "API tokens" link to /me/tokens, logout button
 * - Children rendered below the top bar in a flex-grow content area
 */

import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useMe, useLogout } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { SemesterSwitcher } from './SemesterSwitcher.js';
import { ViewAsBanner } from './ViewAsBanner.js';
import { ProtectedModeBanner } from './ProtectedModeBanner.js';
import { ProvenanceMark } from './ProvenanceMark.js';

interface AppShellProps {
  children: ReactNode;
}

// ---------------------------------------------------------------------------
// Admin nav links — visible only to admins on /s/:courseSlug/:semesterSlug/* routes
// ---------------------------------------------------------------------------

function SemesterAdminNav() {
  const { semesterSlug, membership, basePath } = useActiveSemester();

  if (!semesterSlug) return null;
  if (membership?.role !== 'admin') return null;

  const base = basePath;
  const navClass = ({ isActive }: { isActive: boolean }) =>
    `text-xs px-2 py-1 rounded transition-colors ${
      isActive
        ? 'bg-berkeley-100 text-berkeley-700 font-medium'
        : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
    }`;

  const adminLinks: Array<{ to: string; label: string; end?: boolean }> = [
    { to: base, label: 'Cohort', end: true },
    { to: `${base}/ingest`, label: 'Ingest' },
    { to: `${base}/unmatched`, label: 'Unmatched' },
    { to: `${base}/roster`, label: 'Roster' },
    { to: `${base}/members`, label: 'Members' },
    { to: `${base}/assignments`, label: 'Assignments' },
    { to: `${base}/cross-flags`, label: 'Cross-Flags' },
    { to: `${base}/tuning`, label: 'Tuning' },
    { to: `${base}/settings`, label: 'Settings' },
  ];

  return (
    <nav
      className="flex items-center gap-1 ml-4"
      aria-label="Semester admin"
      data-testid="admin-nav"
    >
      {adminLinks.map(({ to, label, end }) => (
        <NavLink key={to} to={to} end={end ?? false} className={navClass}>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

export function AppShell({ children }: AppShellProps) {
  const { data: me } = useMe();
  const { mutate: logout, isPending: isLoggingOut } = useLogout();
  const navigate = useNavigate();

  function handleLogout() {
    logout(undefined, {
      onSuccess: () => {
        void navigate('/login');
      },
    });
  }

  const isSuperadmin = me?.user.is_superadmin ?? false;

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* View-as banner (only renders when /me reports active view-as) */}
      <ViewAsBanner />
      {/* Protected-mode banner (only renders when current user has protected flag) */}
      <ProtectedModeBanner />

      {/* Top bar */}
      <header className="flex h-14 items-center border-b border-gray-200 bg-white px-4 overflow-x-auto">
        {/* Logo */}
        <Link
          to="/home"
          className="mr-4 flex shrink-0 items-center gap-2 text-sm font-semibold text-berkeley-700"
          aria-label="Provenance home"
        >
          <ProvenanceMark className="h-6 w-6" />
          Provenance
        </Link>

        {/* Semester switcher (renders nothing if <= 1 semester) */}
        <SemesterSwitcher />

        {/* Admin nav links (only on /s/:courseSlug/:semesterSlug routes for admins) */}
        <SemesterAdminNav />

        {/* Spacer */}
        <div className="flex-1" />

        {/* User menu */}
        {me !== undefined && (
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-xs text-gray-500">{me.user.email}</span>
            {isSuperadmin && (
              <Link
                to="/admin"
                className="rounded-md border border-berkeley-300 bg-white px-3 py-1 text-xs font-medium text-berkeley-700 hover:bg-berkeley-50"
                data-testid="admin-link"
              >
                Admin
              </Link>
            )}
            <Link
              to="/me/tokens"
              className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
              data-testid="tokens-link"
            >
              API tokens
            </Link>
            <button
              onClick={handleLogout}
              disabled={isLoggingOut}
              className="rounded-md border border-gray-300 bg-white px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              data-testid="logout-button"
            >
              {isLoggingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
        )}
      </header>

      {/* Page content
          - flex-1 + min-h-0: main fills the remaining column space.
          - overflow-auto: non-tab routes (HomeView, AssignmentsView, etc.) scroll
            internally — the page itself stays viewport-locked, header stays put.
          - Tabbed routes (SubmissionShell) carry their own overflow rules per
            tab. The Replay tab uses overflow-hidden + h-full so the transport
            and jump bars never get pushed off-screen by a tall event sidebar. */}
      <main className="flex flex-1 flex-col min-h-0 overflow-auto">{children}</main>
    </div>
  );
}
