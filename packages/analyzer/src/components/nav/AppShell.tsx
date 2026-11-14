/**
 * AppShell — top navigation bar + content area.
 *
 * Structure:
 * - Top bar: Provenance logo, SemesterSwitcher (if multiple semesters), account menu
 * - Account menu (dropdown): email, Admin (superadmins), API tokens, sign out
 * - Semester nav: a tab row under the top bar, admins on semester routes only
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
import { initials } from '../../lib/initials.js';
import { ChevronDown, KeyRound, LogOut, Shield } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';

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
    `-mb-px whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${
      isActive
        ? 'border-berkeley-700 font-medium text-berkeley-700'
        : 'border-transparent text-gray-600 hover:border-gray-300 hover:text-gray-900'
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
      className="flex flex-wrap items-center gap-x-1 border-b border-gray-200 bg-white px-4"
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

      {/* Top bar. Never scrolls sideways: the semester switcher truncates
          and the account actions live behind one menu, so the row's width is
          bounded regardless of course-name length. */}
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-gray-200 bg-white px-4">
        {/* Logo */}
        <Link
          to="/home"
          className="flex shrink-0 items-center gap-2 text-sm font-semibold text-berkeley-700"
          aria-label="Provenance home"
        >
          <ProvenanceMark className="h-6 w-6" />
          <span className="hidden sm:inline">Provenance</span>
        </Link>

        {/* Semester switcher (renders nothing if <= 1 semester) */}
        <div className="min-w-0">
          <SemesterSwitcher />
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Account menu */}
        {me !== undefined && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-sm text-gray-700 hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Account menu for ${me.user.email}`}
                data-testid="account-menu-trigger"
              >
                <span
                  aria-hidden="true"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-berkeley-100 text-[11px] font-semibold uppercase text-berkeley-700"
                >
                  {initials(me.user.display_name, me.user.email)}
                </span>
                <span className="hidden max-w-[14rem] truncate lg:inline">
                  {me.user.display_name ?? me.user.email}
                </span>
                <ChevronDown className="h-4 w-4 text-gray-500" aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuLabel className="font-normal">
                <div className="text-xs text-muted-foreground">Signed in as</div>
                {me.user.display_name && (
                  <div className="truncate text-sm font-medium">{me.user.display_name}</div>
                )}
                <div
                  className={
                    me.user.display_name
                      ? 'truncate text-xs text-muted-foreground'
                      : 'truncate text-sm font-medium'
                  }
                >
                  {me.user.email}
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {isSuperadmin && (
                <DropdownMenuItem asChild className="gap-2">
                  <Link to="/admin" data-testid="admin-link">
                    <Shield className="h-4 w-4" aria-hidden="true" />
                    Admin
                  </Link>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem asChild className="gap-2">
                <Link to="/me/tokens" data-testid="tokens-link">
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                  API tokens
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2"
                onSelect={handleLogout}
                disabled={isLoggingOut}
                data-testid="logout-button"
              >
                <LogOut className="h-4 w-4" aria-hidden="true" />
                {isLoggingOut ? 'Signing out…' : 'Sign out'}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </header>

      {/* Admin nav tabs (only on /s/:courseSlug/:semesterSlug routes for admins) */}
      <SemesterAdminNav />

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
