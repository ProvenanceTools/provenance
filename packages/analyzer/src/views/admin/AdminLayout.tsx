/**
 * V45 — AdminLayout
 *
 * Wraps every /admin/* page with the shared page container, a PageHeader and
 * the same sub-nav (Overview / Courses / Users / Audit). Sits inside the
 * regular AppShell — RequireSuperadmin gates the route upstream.
 */

import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { PageContainer, PageHeader } from '@/components/layout/Page';

interface AdminLayoutProps {
  children: ReactNode;
  /** Page `<h1>`; defaults to "Admin". */
  title?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  /** Line above the title (e.g. a back link); defaults to "Superadmin". */
  eyebrow?: ReactNode;
}

const NAV_LINKS: { to: string; label: string; end?: boolean }[] = [
  { to: '/admin', label: 'Overview', end: true },
  { to: '/admin/courses', label: 'Courses' },
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/audit', label: 'Audit log' },
];

export function AdminLayout({
  children,
  title = 'Admin',
  description,
  meta,
  actions,
  eyebrow = 'Superadmin',
}: AdminLayoutProps) {
  return (
    <PageContainer>
      <PageHeader
        title={title}
        description={description}
        meta={meta}
        actions={actions}
        eyebrow={eyebrow}
      />

      <nav className="flex gap-1 border-b border-gray-200" aria-label="Admin sub-nav">
        {NAV_LINKS.map(({ to, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end ?? false}
            className={({ isActive }) =>
              `-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                isActive
                  ? 'border-berkeley-700 font-medium text-berkeley-700'
                  : 'border-transparent text-gray-500 hover:text-gray-900'
              }`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>

      {children}
    </PageContainer>
  );
}
