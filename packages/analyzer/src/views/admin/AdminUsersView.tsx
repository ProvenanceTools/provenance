/**
 * V45 — /admin/users
 *
 * Platform-wide user list. Free-text search on email + display_name (server
 * does ILIKE on both columns). Per-row "View as", "Open" (cross-semester
 * memberships in /admin/users/:id), and "Delete" with two-step confirm.
 *
 * View-as kicks off via useStartViewAs which clears the query cache so
 * /me + memberships re-fetch under the target's perspective. The banner
 * (rendered in AppShell) then shows "Viewing as X".
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AdminLayout } from './AdminLayout.js';
import {
  useAdminUsers,
  useDeleteUser,
  useMe,
  useSetUserProtected,
  useStartViewAs,
} from '../../api/queries.js';
import { ApiError } from '../../api/client.js';
import type { AdminUserSummary } from '@provenance/shared/api-schemas';

function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg bg-red-600 px-4 py-3 text-sm text-white shadow-lg"
      data-testid="toast"
      role="alert"
    >
      <span>{message}</span>
      <button onClick={onClose} className="text-white/80 hover:text-white" aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}

export function AdminUsersView() {
  const [q, setQ] = useState('');
  const { data, isLoading, error } = useAdminUsers(q);
  const { mutate: deleteUser } = useDeleteUser();
  const { mutate: startViewAs, isPending: isStartingViewAs } = useStartViewAs();
  const { mutate: setProtected } = useSetUserProtected();
  const { data: me } = useMe();
  const navigate = useNavigate();

  const [toast, setToast] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  function handleDelete(userId: string) {
    deleteUser(userId, {
      onSuccess: () => setDeleteConfirm(null),
      onError: (err) => {
        setDeleteConfirm(null);
        setToast(err instanceof ApiError ? err.message : 'Failed to delete user.');
      },
    });
  }

  function handleViewAs(user: AdminUserSummary) {
    startViewAs(user.id, {
      onSuccess: () => {
        // Land on /home so the target's normal landing renders.
        void navigate('/home');
      },
      onError: (err) => {
        setToast(err instanceof ApiError ? err.message : 'Failed to start view-as.');
      },
    });
  }

  return (
    <AdminLayout>
      <div className="mb-4 flex items-center gap-2">
        <input
          type="text"
          placeholder="Search by email or name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm"
          data-testid="user-search-input"
        />
      </div>

      {isLoading && <div className="py-8 text-center text-sm text-gray-600">Loading users…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-destructive" data-testid="users-error">
          Failed to load users.
        </div>
      )}

      {!isLoading && !error && (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm" data-testid="users-table">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Name / Email</th>
                <th className="px-4 py-2 text-left">Role</th>
                <th className="px-4 py-2 text-left">Last login</th>
                <th className="px-4 py-2 text-left">Created</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data?.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-600">
                    No users match.
                  </td>
                </tr>
              ) : (
                data?.items.map((u) => (
                  <tr key={u.id} className="hover:bg-gray-50" data-testid={`user-row-${u.id}`}>
                    <td className="px-4 py-2">
                      <Link
                        to={`/admin/users/${u.id}`}
                        className="text-xs font-medium text-berkeley-700 hover:underline"
                      >
                        {u.display_name ?? u.email}
                      </Link>
                      <div className="text-xs text-gray-500">{u.email}</div>
                    </td>
                    <td className="px-4 py-2">
                      {u.is_superadmin ? (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                          superadmin
                        </span>
                      ) : (
                        <span className="text-xs text-gray-600">user</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">
                      {u.last_login_at !== null
                        ? new Date(u.last_login_at).toLocaleDateString()
                        : 'never'}
                    </td>
                    <td className="px-4 py-2 text-xs text-gray-500">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleViewAs(u)}
                          disabled={isStartingViewAs}
                          className="rounded border border-berkeley-300 px-2.5 py-1 text-xs text-berkeley-700 hover:bg-berkeley-50 disabled:opacity-50"
                          data-testid={`view-as-btn-${u.id}`}
                        >
                          View as
                        </button>
                        <button
                          type="button"
                          onClick={() => setProtected({ userId: u.id, protected: !u.protected })}
                          disabled={u.id === me?.user.id}
                          className="rounded border border-amber-300 px-2.5 py-1 text-xs text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                          data-testid={`protected-toggle-${u.id}`}
                        >
                          {u.protected ? 'Unprotect' : 'Protect'}
                        </button>
                        {deleteConfirm === u.id ? (
                          <>
                            <button
                              onClick={() => handleDelete(u.id)}
                              className="rounded bg-red-600 px-2.5 py-1 text-xs text-white hover:bg-red-700"
                              data-testid={`delete-confirm-${u.id}`}
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(u.id)}
                            className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                            data-testid={`delete-btn-${u.id}`}
                          >
                            Delete
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {toast !== null && <Toast message={toast} onClose={() => setToast(null)} />}
    </AdminLayout>
  );
}
