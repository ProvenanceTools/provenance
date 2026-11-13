/**
 * V45 — /admin landing page.
 *
 * Lightweight overview with quick links into the four admin sub-pages and
 * a brief summary of the surface. The intent is orientation, not a
 * dashboard — the heavy lifting happens inside Courses / Users / Audit.
 */

import { Link } from 'react-router-dom';
import { AdminLayout } from './AdminLayout.js';
import { useAdminCourses, useAdminUsers } from '../../api/queries.js';

function Card({
  to,
  title,
  count,
  description,
}: {
  to: string;
  title: string;
  count: number | string;
  description: string;
}) {
  return (
    <Link
      to={to}
      className="block rounded-lg border bg-card p-5 shadow-sm transition-colors hover:border-berkeley-300 hover:bg-berkeley-50/30"
    >
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900">{count}</div>
      <div className="mt-1 text-sm text-muted-foreground">{description}</div>
    </Link>
  );
}

export function AdminIndexView() {
  const { data: coursesData } = useAdminCourses();
  const { data: usersData } = useAdminUsers();

  return (
    <AdminLayout title="Overview">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card
          to="/admin/courses"
          title="Courses"
          count={coursesData?.courses.length ?? '—'}
          description="Create courses, archive courses, manage semesters within each course."
        />
        <Card
          to="/admin/users"
          title="Platform users"
          count={usersData?.items.length ?? '—'}
          description="List, search, view memberships, delete users, view-as another user."
        />
        <Card
          to="/admin/audit"
          title="Audit log"
          count="View"
          description="Every privileged action recorded across the platform."
        />
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        <strong>Heads up.</strong> Actions taken here apply globally — across every course and
        semester. Course-staff admins can manage their own semester from the regular per-semester
        admin nav at <code>/s/&lt;slug&gt;/members</code>; this page is for cross-semester /
        platform-wide changes.
      </div>
    </AdminLayout>
  );
}
