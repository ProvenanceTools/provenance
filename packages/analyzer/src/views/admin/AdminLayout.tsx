/**
 * V45 — AdminLayout
 *
 * Wraps every /admin/* page with the same sub-nav (Overview / Courses /
 * Users / Audit). Sits inside the regular AppShell — RequireSuperadmin
 * gates the route upstream.
 */

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

interface AdminLayoutProps {
  children: ReactNode;
}

const NAV_LINKS: { to: string; label: string; end?: boolean }[] = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/courses', label: 'Courses' },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/audit', label: 'Audit log' },
];

export function AdminLayout({ children }: AdminLayoutProps) {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-berkeley-700">Superadmin</div>
      <h1 className="mb-4 text-xl font-semibold text-gray-900">Admin</h1>

      <nav className="mb-6 flex gap-1 border-b border-gray-200" aria-label="Admin sub-nav">
        {NAV_LINKS.map(({ to, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end ?? false}
            className={({ isActive }) =>
              `px-3 py-1.5 text-xs transition-colors border-b-2 -mb-px ${
                isActive
                  ? 'border-gold text-berkeley-700 font-medium'
                  : 'border-transparent text-gray-500 hover:text-gray-900'
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      <div>{children}</div>
    </div>
  );
}
