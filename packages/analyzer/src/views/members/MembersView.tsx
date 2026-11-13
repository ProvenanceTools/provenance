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
import { UserPlus, Trash2 } from 'lucide-react';
import { PageContainer, PageHeader, Panel, EmptyState } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
// Avatar + role badge
// ---------------------------------------------------------------------------

/** Initial-letter avatar. Decorative: the name beside it carries the meaning. */
function Avatar({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold uppercase ${
        muted ? 'bg-gray-100 text-gray-500' : 'bg-berkeley-100 text-berkeley-700'
      }`}
    >
      {label.trim().charAt(0) || '?'}
    </span>
  );
}

function RoleBadge({ role }: { role: string }) {
  const cls =
    role === 'admin'
      ? 'border-berkeley-200 bg-berkeley-50 text-berkeley-700'
      : 'border-gray-200 bg-gray-50 text-gray-700';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${cls}`}
    >
      {role}
    </span>
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
  const showEmailError = emailError !== null || !emailIsValid;
  const memberCount = data?.members.length ?? 0;
  const pendingCount = data?.pending.length ?? 0;

  return (
    <PageContainer>
      <PageHeader
        title="Members"
        meta={
          data
            ? `${memberCount} ${memberCount === 1 ? 'member' : 'members'}${
                pendingCount > 0 ? ` · ${pendingCount} pending` : ''
              }`
            : undefined
        }
        description="Staff with access to this semester. Admins manage uploads, the roster, and members; graders review submissions."
      />

      {/* Invite form */}
      <Panel
        title="Invite a member"
        description="Someone who has signed in before gets access immediately; anyone else gets it the first time they sign in with that Google account."
      >
        <form onSubmit={handleInviteSubmit} className="flex flex-wrap items-start gap-3">
          <div className="min-w-[240px] flex-1 space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              type="email"
              placeholder="name@berkeley.edu"
              value={inviteEmail}
              onChange={(e) => {
                setInviteEmail(e.target.value);
                setEmailError(null);
              }}
              aria-invalid={showEmailError}
              aria-describedby={showEmailError ? 'invite-email-error' : undefined}
              className={showEmailError ? 'border-red-400 focus-visible:ring-red-500' : ''}
              data-testid="invite-email-input"
            />
            {showEmailError && (
              <p id="invite-email-error" className="text-xs text-red-600" data-testid="email-error">
                {emailError ?? 'Invalid email address.'}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <NativeSelect
              id="invite-role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as 'admin' | 'grader')}
              className="w-32"
              data-testid="invite-role-select"
            >
              <option value="grader">Grader</option>
              <option value="admin">Admin</option>
            </NativeSelect>
          </div>

          {/* Spacer label keeps the button aligned with the inputs, not the labels. */}
          <div className="space-y-1.5">
            <span aria-hidden="true" className="block text-sm leading-none">
              &nbsp;
            </span>
            <Button
              type="submit"
              size="sm"
              disabled={isInviting || inviteEmail === '' || !emailIsValid}
              data-testid="invite-submit"
            >
              <UserPlus />
              {isInviting ? 'Inviting…' : 'Send invite'}
            </Button>
          </div>
        </form>
      </Panel>

      {isLoading && (
        <Panel>
          <p className="py-6 text-center text-sm text-muted-foreground">Loading members…</p>
        </Panel>
      )}
      {error && (
        <Panel>
          <p className="py-6 text-center text-sm text-red-600" data-testid="members-error">
            Failed to load members.
          </p>
        </Panel>
      )}

      {/* Active members */}
      {!isLoading && !error && semesterId && (
        <>
          <Panel title="Active members" flush>
            <Table data-testid="members-table">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Member</TableHead>
                  <TableHead className="w-40">Role</TableHead>
                  <TableHead className="w-48 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.members.length === 0 ? (
                  <tr>
                    <td colSpan={3}>
                      <EmptyState
                        title="No members yet"
                        description="Invite course staff above to give them access."
                      />
                    </td>
                  </tr>
                ) : (
                  data?.members.map((member) => (
                    <TableRow key={member.user_id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar label={member.display_name ?? member.email} />
                          <div className="min-w-0">
                            <div className="truncate font-medium text-gray-900">
                              {member.display_name ?? member.email}
                            </div>
                            {member.display_name && (
                              <div className="truncate text-xs text-muted-foreground">
                                {member.email}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <NativeSelect
                          value={member.role}
                          onChange={(e) =>
                            handleRoleChange(member.user_id, e.target.value as 'admin' | 'grader')
                          }
                          aria-label={`Role for ${member.display_name ?? member.email}`}
                          className="h-8 w-28"
                          data-testid={`role-select-${member.user_id}`}
                        >
                          <option value="admin">Admin</option>
                          <option value="grader">Grader</option>
                        </NativeSelect>
                      </TableCell>
                      <TableCell className="text-right">
                        {removeConfirm === member.user_id ? (
                          <span className="inline-flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">Remove access?</span>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-8"
                              onClick={() => handleRemove(member.user_id)}
                              data-testid={`remove-confirm-${member.user_id}`}
                            >
                              Remove
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8"
                              onClick={() => setRemoveConfirm(null)}
                            >
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 text-red-700 hover:bg-red-50 hover:text-red-800"
                            onClick={() => setRemoveConfirm(member.user_id)}
                            aria-label={`Remove ${member.display_name ?? member.email}`}
                            data-testid={`remove-btn-${member.user_id}`}
                          >
                            <Trash2 />
                            Remove
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Panel>

          {/* Pending invitations */}
          {pendingCount > 0 && (
            <Panel
              title="Pending invitations"
              description="Invited, but they haven't signed in yet."
              flush
            >
              <Table data-testid="pending-table">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Email</TableHead>
                    <TableHead className="w-40">Role</TableHead>
                    <TableHead className="w-48 text-right">Invited</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data?.pending.map((inv) => (
                    <TableRow key={inv.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar label={inv.email} muted />
                          <span className="truncate text-gray-900">{inv.email}</span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <RoleBadge role={inv.role} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {new Date(inv.invited_at).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          )}
        </>
      )}

      {/* Toast */}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </PageContainer>
  );
}
