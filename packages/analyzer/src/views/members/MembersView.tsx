/**
 * MembersView — list members, invite form, role change, remove.
 *
 * Route: /s/:courseSlug/:semesterSlug/members
 *
 * - Lists active members (display_name + email + role).
 * - Lists pending invitations.
 * - Invite form: email + role select + submit.
 * - Per-member role dropdown for role change.
 * - Per-member Remove button; LAST_ADMIN_REQUIRED error shown in toast.
 * - Client-side email validation.
 */

import { useState } from 'react';
import { useActiveSemester } from '../../api/use-active-semester.js';
import {
  useMembers,
  useInviteMember,
  useUpdateMemberRole,
  useRemoveMember,
} from '../../api/queries.js';
import { ApiError } from '../../api/client.js';

// ---------------------------------------------------------------------------
// Simple inline toast
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Email validation
// ---------------------------------------------------------------------------

function isValidEmail(email: string): boolean {
  // RFC-5321-lite: local@domain.tld — good enough for client-side pre-flight
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function MembersView() {
  const { semesterId } = useActiveSemester();

  const { data, isLoading, error } = useMembers(semesterId);
  const { mutate: invite, isPending: isInviting } = useInviteMember(semesterId);
  const { mutate: updateRole } = useUpdateMemberRole(semesterId);
  const { mutate: removeMember } = useRemoveMember(semesterId);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'admin' | 'grader'>('grader');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [removeConfirm, setRemoveConfirm] = useState<string | null>(null); // userId

  function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValidEmail(inviteEmail)) {
      setEmailError('Please enter a valid email address.');
      return;
    }
    setEmailError(null);
    invite(
      { email: inviteEmail, role: inviteRole },
      {
        onSuccess: () => {
          setInviteEmail('');
          setInviteRole('grader');
        },
        onError: (err) => {
          const msg = err instanceof ApiError ? err.message : 'Failed to invite member.';
          setToast(msg);
        },
      },
    );
  }

  function handleRoleChange(userId: string, role: 'admin' | 'grader') {
    updateRole(
      { userId, role },
      {
        onError: (err) => {
          const msg = err instanceof ApiError ? err.message : 'Failed to update role.';
          setToast(msg);
        },
      },
    );
  }

  function handleRemove(userId: string) {
    removeMember(userId, {
      onSuccess: () => {
        setRemoveConfirm(null);
      },
      onError: (err) => {
        setRemoveConfirm(null);
        const msg = err instanceof ApiError ? err.message : 'Failed to remove member.';
        setToast(msg);
      },
    });
  }

  const emailIsValid = inviteEmail === '' || isValidEmail(inviteEmail);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-xl font-semibold text-gray-900">Members</h1>

      {/* Invite form */}
      <div className="mb-8 rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Invite Member</h2>
        <form onSubmit={handleInviteSubmit} className="flex items-start gap-2 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <input
              type="email"
              placeholder="email@example.com"
              value={inviteEmail}
              onChange={(e) => {
                setInviteEmail(e.target.value);
                setEmailError(null);
              }}
              className={`w-full rounded border px-3 py-1.5 text-sm ${
                emailError || (!emailIsValid && inviteEmail !== '')
                  ? 'border-red-400'
                  : 'border-gray-300'
              }`}
              data-testid="invite-email-input"
            />
            {(emailError || (!emailIsValid && inviteEmail !== '')) && (
              <p className="mt-0.5 text-xs text-red-600" data-testid="email-error">
                {emailError ?? 'Invalid email address.'}
              </p>
            )}
          </div>

          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value as 'admin' | 'grader')}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm"
            data-testid="invite-role-select"
          >
            <option value="grader">Grader</option>
            <option value="admin">Admin</option>
          </select>

          <button
            type="submit"
            disabled={isInviting || inviteEmail === '' || !emailIsValid}
            className="rounded bg-berkeley-700 px-3 py-1.5 text-sm text-white hover:bg-berkeley-800 disabled:opacity-50"
            data-testid="invite-submit"
          >
            {isInviting ? 'Inviting…' : 'Invite'}
          </button>
        </form>
      </div>

      {isLoading && <div className="py-8 text-center text-sm text-gray-400">Loading members…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-red-500" data-testid="members-error">
          Failed to load members.
        </div>
      )}

      {/* Active members */}
      {!isLoading && !error && semesterId && (
        <>
          <div className="mb-6 rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="w-full text-sm" data-testid="members-table">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-4 py-2 text-left">Name / Email</th>
                  <th className="px-4 py-2 text-left">Role</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data?.members.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-gray-400">
                      No members yet.
                    </td>
                  </tr>
                ) : (
                  data?.members.map((member) => (
                    <tr key={member.user_id} className="hover:bg-gray-50">
                      <td className="px-4 py-2">
                        <div className="text-xs font-medium text-gray-900">
                          {member.display_name ?? member.email}
                        </div>
                        <div className="text-xs text-gray-500">{member.email}</div>
                      </td>
                      <td className="px-4 py-2">
                        <select
                          value={member.role}
                          onChange={(e) =>
                            handleRoleChange(member.user_id, e.target.value as 'admin' | 'grader')
                          }
                          className="rounded border border-gray-300 px-2 py-0.5 text-xs"
                          data-testid={`role-select-${member.user_id}`}
                        >
                          <option value="admin">Admin</option>
                          <option value="grader">Grader</option>
                        </select>
                      </td>
                      <td className="px-4 py-2 text-right">
                        {removeConfirm === member.user_id ? (
                          <span className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => handleRemove(member.user_id)}
                              className="rounded bg-red-600 px-2.5 py-1 text-xs text-white hover:bg-red-700"
                              data-testid={`remove-confirm-${member.user_id}`}
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setRemoveConfirm(null)}
                              className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setRemoveConfirm(member.user_id)}
                            className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                            data-testid={`remove-btn-${member.user_id}`}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pending invitations */}
          {(data?.pending.length ?? 0) > 0 && (
            <div>
              <h2 className="mb-2 text-sm font-semibold text-gray-700">Pending Invitations</h2>
              <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
                <table className="w-full text-sm" data-testid="pending-table">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-4 py-2 text-left">Email</th>
                      <th className="px-4 py-2 text-left">Role</th>
                      <th className="px-4 py-2 text-left">Invited</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {data?.pending.map((inv) => (
                      <tr key={inv.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 text-xs">{inv.email}</td>
                        <td className="px-4 py-2 text-xs capitalize">{inv.role}</td>
                        <td className="px-4 py-2 text-xs text-gray-500">
                          {new Date(inv.invited_at).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {/* Toast */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
