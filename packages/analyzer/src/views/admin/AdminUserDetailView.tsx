/**
 * V45 — /admin/users/:userId
 *
 * Drill-in page: user fields + cross-semester memberships (course · semester ·
 * role) in one table. Per-semester membership *edits* still happen on the
 * existing per-semester /s/:slug/members page; this view just lists.
 */

import { Link, useParams } from 'react-router-dom';
import { AdminLayout } from './AdminLayout.js';
import { useAdminUser } from '../../api/queries.js';
import { EmptyState, Panel } from '@/components/layout/Page';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export function AdminUserDetailView() {
  const { userId = '' } = useParams<{ userId: string }>();
  const { data, isLoading, error } = useAdminUser(userId);

  return (
    <AdminLayout
      title={data !== undefined ? (data.user.display_name ?? data.user.email) : 'User'}
      eyebrow={
        <Link to="/admin/users" className="hover:underline">
          ← Back to users
        </Link>
      }
    >
      {isLoading && <div className="py-8 text-center text-sm text-gray-600">Loading…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-destructive">Failed to load user.</div>
      )}

      {!isLoading && !error && data !== undefined && (
        <>
          <Panel title="Details" description={data.user.email}>
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-gray-500">Role</dt>
                <dd className="font-medium">{data.user.is_superadmin ? 'Superadmin' : 'User'}</dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Last login</dt>
                <dd className="font-medium">
                  {data.user.last_login_at !== null
                    ? new Date(data.user.last_login_at).toLocaleString()
                    : 'never'}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">Created</dt>
                <dd className="font-medium">
                  {new Date(data.user.created_at).toLocaleDateString()}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-gray-500">User ID</dt>
                <dd className="break-all font-mono text-xs">{data.user.id}</dd>
              </div>
            </dl>
          </Panel>

          <Panel title={`Memberships (${data.memberships.length})`} flush>
            {data.memberships.length === 0 ? (
              <EmptyState title="No memberships." />
            ) : (
              <Table data-testid="memberships-table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Course</TableHead>
                    <TableHead>Semester</TableHead>
                    <TableHead>Role</TableHead>
                    <TableHead>Granted</TableHead>
                    <TableHead className="text-right">Manage</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.memberships.map((m) => (
                    <TableRow key={m.semester_id}>
                      <TableCell className="font-mono text-xs">{m.course_slug}</TableCell>
                      <TableCell className="font-mono text-xs">{m.semester_slug}</TableCell>
                      <TableCell className="capitalize">{m.role}</TableCell>
                      <TableCell className="text-gray-500">
                        {new Date(m.granted_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          to={`/s/${m.course_slug}/${m.semester_slug}/members`}
                          className="text-berkeley-700 hover:underline"
                        >
                          Members →
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </>
      )}
    </AdminLayout>
  );
}
