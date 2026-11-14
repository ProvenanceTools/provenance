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
import { EmptyState, Panel } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
    <AdminLayout
      title="Users"
      description="List, search, view memberships, delete users, view-as another user."
    >
      <Input
        type="text"
        placeholder="Search by email or name…"
        aria-label="Search users"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        data-testid="user-search-input"
      />

      {isLoading && <div className="py-8 text-center text-sm text-gray-600">Loading users…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-destructive" data-testid="users-error">
          Failed to load users.
        </div>
      )}

      {!isLoading && !error && (
        <Panel flush>
          {data?.items.length === 0 ? (
            <EmptyState title="No users match." />
          ) : (
            <Table data-testid="users-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name / Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Last login</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((u) => (
                  <TableRow key={u.id} data-testid={`user-row-${u.id}`}>
                    <TableCell>
                      <Link
                        to={`/admin/users/${u.id}`}
                        className="font-medium text-berkeley-700 hover:underline"
                      >
                        {u.display_name ?? u.email}
                      </Link>
                      <div className="text-xs text-gray-500">{u.email}</div>
                    </TableCell>
                    <TableCell>
                      {u.is_superadmin ? (
                        <span className="inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                          superadmin
                        </span>
                      ) : (
                        <span className="text-gray-600">user</span>
                      )}
                    </TableCell>
                    <TableCell className="text-gray-500">
                      {u.last_login_at !== null
                        ? new Date(u.last_login_at).toLocaleDateString()
                        : 'never'}
                    </TableCell>
                    <TableCell className="text-gray-500">
                      {new Date(u.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="flex items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleViewAs(u)}
                          disabled={isStartingViewAs}
                          data-testid={`view-as-btn-${u.id}`}
                        >
                          View as
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setProtected({ userId: u.id, protected: !u.protected })}
                          disabled={u.id === me?.user.id}
                          data-testid={`protected-toggle-${u.id}`}
                        >
                          {u.protected ? 'Unprotect' : 'Protect'}
                        </Button>
                        {deleteConfirm === u.id ? (
                          <>
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleDelete(u.id)}
                              data-testid={`delete-confirm-${u.id}`}
                            >
                              Confirm
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setDeleteConfirm(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-700"
                            onClick={() => setDeleteConfirm(u.id)}
                            data-testid={`delete-btn-${u.id}`}
                          >
                            Delete
                          </Button>
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}

      {toast !== null && <Toast message={toast} onClose={() => setToast(null)} />}
    </AdminLayout>
  );
}
