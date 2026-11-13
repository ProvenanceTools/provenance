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

export function AdminUserDetailView() {
  const { userId = '' } = useParams<{ userId: string }>();
  const { data, isLoading, error } = useAdminUser(userId);

  return (
    <AdminLayout>
      <div className="mb-4 text-xs text-gray-500">
        <Link to="/admin/users" className="hover:underline">
          ← Back to users
        </Link>
      </div>

      {isLoading && <div className="py-8 text-center text-sm text-gray-600">Loading…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-destructive">Failed to load user.</div>
      )}

      {!isLoading && !error && data !== undefined && (
        <>
          <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
            <h2 className="text-base font-semibold text-gray-900">
              {data.user.display_name ?? data.user.email}
            </h2>
            <div className="text-xs text-gray-600">{data.user.email}</div>
            <div className="mt-3 grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
              <div>
                <div className="text-gray-500">Role</div>
                <div className="font-medium">{data.user.is_superadmin ? 'Superadmin' : 'User'}</div>
              </div>
              <div>
                <div className="text-gray-500">Last login</div>
                <div className="font-medium">
                  {data.user.last_login_at !== null
                    ? new Date(data.user.last_login_at).toLocaleString()
                    : 'never'}
                </div>
              </div>
              <div>
                <div className="text-gray-500">Created</div>
                <div className="font-medium">
                  {new Date(data.user.created_at).toLocaleDateString()}
                </div>
              </div>
              <div>
                <div className="text-gray-500">User ID</div>
                <div className="font-mono text-[10px]">{data.user.id}</div>
              </div>
            </div>
          </div>

          <h3 className="mb-2 text-sm font-semibold text-gray-700">
            Memberships <span className="text-gray-600">({data.memberships.length})</span>
          </h3>
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-sm" data-testid="memberships-table">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left">Course</th>
                  <th className="px-4 py-2 text-left">Semester</th>
                  <th className="px-4 py-2 text-left">Role</th>
                  <th className="px-4 py-2 text-left">Granted</th>
                  <th className="px-4 py-2 text-right">Manage</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.memberships.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-gray-600">
                      No memberships.
                    </td>
                  </tr>
                ) : (
                  data.memberships.map((m) => (
                    <tr key={m.semester_id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-xs font-mono">{m.course_slug}</td>
                      <td className="px-4 py-2 text-xs font-mono">{m.semester_slug}</td>
                      <td className="px-4 py-2 text-xs capitalize">{m.role}</td>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {new Date(m.granted_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <Link
                          to={`/s/${m.course_slug}/${m.semester_slug}/members`}
                          className="text-xs text-berkeley-700 hover:underline"
                        >
                          Members →
                        </Link>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AdminLayout>
  );
}
