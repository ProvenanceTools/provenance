/**
 * TokensView — manage personal access tokens.
 *
 * Route: /me/tokens (any authenticated principal).
 *
 * - Lists the user's tokens (active + revoked) with label, prefix, scope chips,
 *   created/last-used/expires timestamps, and a revoke button.
 * - Create form: label, read_only/include_blobs/semester-allowlist scopes,
 *   optional expiry date.
 * - On successful create, opens a modal that displays the full secret exactly
 *   once with a copy button. The modal cannot be dismissed until the user
 *   acknowledges they've saved the token; the secret is then cleared from
 *   component state and never re-rendered.
 */

import { useState } from 'react';
import { useMyTokens, useCreateToken, useRevokeToken, useSemesters } from '../../api/queries.js';
import { ApiError } from '../../api/client.js';
import type { TokenSummary } from '@provenance/shared/api-schemas';
import { PageContainer, PageHeader, Panel, EmptyState } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// ---------------------------------------------------------------------------
// Inline toast (mirrors MembersView)
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
// Scope chips
// ---------------------------------------------------------------------------

function ScopeChips({ scopes }: { scopes: TokenSummary['scopes'] }) {
  const labels: string[] = [];
  labels.push(scopes.read_only ? 'read-only' : 'read+write');
  if (scopes.include_blobs) labels.push('blobs');
  if (scopes.semester_ids === null) {
    labels.push('all semesters');
  } else {
    labels.push(
      scopes.semester_ids.length === 1 ? '1 semester' : `${scopes.semester_ids.length} semesters`,
    );
  }
  return (
    <div className="flex flex-wrap gap-1">
      {labels.map((l) => (
        <span
          key={l}
          className="rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-xs font-medium text-gray-700"
        >
          {l}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Token status
// ---------------------------------------------------------------------------

type TokenStatus = 'active' | 'revoked' | 'expired';

function statusOf(token: TokenSummary, now: Date): TokenStatus {
  if (token.revoked_at !== null) return 'revoked';
  if (token.expires_at !== null && new Date(token.expires_at) <= now) return 'expired';
  return 'active';
}

function StatusBadge({ status }: { status: TokenStatus }) {
  const styles: Record<TokenStatus, string> = {
    active: 'border-green-200 bg-green-50 text-green-700',
    revoked: 'border-gray-200 bg-gray-100 text-gray-600',
    expired: 'border-amber-200 bg-amber-50 text-amber-700',
  };
  return (
    <span
      className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${styles[status]}`}
      data-testid={`status-${status}`}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// One-time secret modal
// ---------------------------------------------------------------------------

function SecretModal({ secret, onAcknowledge }: { secret: string; onAcknowledge: () => void }) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    void navigator.clipboard
      ?.writeText(secret)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        // Clipboard may be unavailable (e.g. http context, jsdom). Show the
        // secret in the textarea so the user can copy manually.
      });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="secret-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="secret-modal-title"
    >
      <div className="w-full max-w-lg rounded-lg border bg-card p-6 text-card-foreground shadow-xl">
        <h2 id="secret-modal-title" className="mb-2 text-lg font-semibold text-gray-900">
          Save your token
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          This is the only time the full token will be shown. Copy it now and store it somewhere
          safe — a password manager or environment variable. Once you acknowledge, the token will be
          cleared from this page.
        </p>

        <div className="mb-3 flex items-stretch gap-2">
          <textarea
            readOnly
            value={secret}
            className="flex-1 resize-none rounded-md border border-input bg-gray-50 px-3 py-2 font-mono text-xs text-gray-900 break-all"
            rows={2}
            data-testid="secret-value"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            type="button"
            size="sm"
            onClick={handleCopy}
            className="shrink-0"
            data-testid="secret-copy"
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <label className="mb-4 flex items-start gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
            className="mt-0.5"
            data-testid="secret-ack-checkbox"
          />
          <span>I&apos;ve saved this token somewhere safe.</span>
        </label>

        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!acknowledged}
            onClick={onAcknowledge}
            data-testid="secret-ack-close"
          >
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create form
// ---------------------------------------------------------------------------

interface CreateFormProps {
  onCreated: (secret: string) => void;
  onError: (message: string) => void;
}

function CreateForm({ onCreated, onError }: CreateFormProps) {
  const { data: memberships } = useSemesters();
  const { mutate: createToken, isPending } = useCreateToken();

  const [label, setLabel] = useState('');
  const [readOnly, setReadOnly] = useState(true);
  const [includeBlobs, setIncludeBlobs] = useState(false);
  const [restrictSemesters, setRestrictSemesters] = useState(false);
  const [selectedSemesterIds, setSelectedSemesterIds] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState('');

  function toggleSemester(id: string) {
    setSelectedSemesterIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (label.trim() === '') return;

    // Convert YYYY-MM-DD to end-of-day ISO; leave blank → no expiry.
    let expiresAtIso: string | undefined;
    if (expiresAt !== '') {
      const d = new Date(`${expiresAt}T23:59:59.000Z`);
      if (!Number.isNaN(d.getTime())) {
        expiresAtIso = d.toISOString();
      }
    }

    createToken(
      {
        label: label.trim(),
        scopes: {
          read_only: readOnly,
          include_blobs: includeBlobs,
          semester_ids: restrictSemesters ? selectedSemesterIds : null,
        },
        ...(expiresAtIso !== undefined ? { expires_at: expiresAtIso } : {}),
      },
      {
        onSuccess: (data) => {
          onCreated(data.secret);
          setLabel('');
          setReadOnly(true);
          setIncludeBlobs(false);
          setRestrictSemesters(false);
          setSelectedSemesterIds([]);
          setExpiresAt('');
        },
        onError: (err) => {
          const msg = err instanceof ApiError ? err.message : 'Failed to create token.';
          onError(msg);
        },
      },
    );
  }

  const canSubmit =
    label.trim() !== '' && !isPending && (!restrictSemesters || selectedSemesterIds.length > 0);

  return (
    <Panel title="Create token">
      <form onSubmit={handleSubmit} className="space-y-4" data-testid="create-token-form">
        <div className="space-y-1.5">
          <Label htmlFor="token-label">Label</Label>
          <Input
            id="token-label"
            type="text"
            required
            maxLength={64}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. nightly-cohort-export"
            data-testid="token-label-input"
          />
        </div>

        <fieldset className="space-y-1.5">
          <legend className="mb-1.5 text-sm font-medium leading-none">Scopes</legend>
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
                data-testid="scope-readonly"
              />
              <span>
                Read-only <span className="text-gray-400">(recommended)</span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={includeBlobs}
                onChange={(e) => setIncludeBlobs(e.target.checked)}
                data-testid="scope-include-blobs"
              />
              <span>
                Allow bundle downloads{' '}
                <span className="text-gray-400">(needed for /bundle endpoint)</span>
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={restrictSemesters}
                onChange={(e) => setRestrictSemesters(e.target.checked)}
                data-testid="scope-restrict-semesters"
              />
              <span>Restrict to specific semesters</span>
            </label>
          </div>

          {restrictSemesters && (
            <div
              className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded-md border border-gray-200 bg-gray-50 p-3"
              data-testid="semester-picker"
            >
              {(memberships ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">You have no semester memberships.</p>
              )}
              {(memberships ?? []).map((m) => (
                <label
                  key={m.semester_id}
                  className="flex items-center gap-2 text-sm text-gray-700"
                >
                  <input
                    type="checkbox"
                    checked={selectedSemesterIds.includes(m.semester_id)}
                    onChange={() => toggleSemester(m.semester_id)}
                    data-testid={`semester-checkbox-${m.semester_slug}`}
                  />
                  <span>
                    {m.course_name} · {m.semester_display_name}{' '}
                    <span className="text-gray-400">({m.role})</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <div className="space-y-1.5">
          <Label htmlFor="token-expires">
            Expires <span className="font-normal text-gray-400">(optional)</span>
          </Label>
          <Input
            id="token-expires"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="w-auto"
            data-testid="token-expires-input"
          />
        </div>

        <Button type="submit" size="sm" disabled={!canSubmit} data-testid="create-token-submit">
          {isPending ? 'Creating…' : 'Create token'}
        </Button>
      </form>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function TokensView() {
  const { data, isLoading, error } = useMyTokens();
  const { mutate: revokeToken } = useRevokeToken();

  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null);

  const now = new Date();

  function handleRevoke(tokenId: string) {
    revokeToken(tokenId, {
      onSuccess: () => setRevokeConfirm(null),
      onError: (err) => {
        setRevokeConfirm(null);
        const msg = err instanceof ApiError ? err.message : 'Failed to revoke token.';
        setToast(msg);
      },
    });
  }

  return (
    <PageContainer>
      <PageHeader
        title="API tokens"
        description={
          <>
            Personal access tokens authenticate scripts and external tools against the Provenance
            API. Each token inherits your current memberships, intersected with its scopes. See{' '}
            <a
              href="/api/v1/docs"
              target="_blank"
              rel="noreferrer"
              className="text-berkeley-700 hover:underline"
            >
              API docs
            </a>{' '}
            for endpoint reference.
          </>
        }
      />

      <CreateForm onCreated={(s) => setNewSecret(s)} onError={(m) => setToast(m)} />

      {isLoading && (
        <Panel>
          <p className="py-6 text-center text-sm text-muted-foreground">Loading tokens…</p>
        </Panel>
      )}
      {error && (
        <Panel>
          <p className="py-6 text-center text-sm text-red-600" data-testid="tokens-error">
            Failed to load tokens.
          </p>
        </Panel>
      )}

      {!isLoading && !error && (
        <Panel title="Your tokens" flush>
          <Table data-testid="tokens-table">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Label</TableHead>
                <TableHead>Prefix</TableHead>
                <TableHead>Scopes</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.tokens.length === 0 ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      title="No tokens yet"
                      description="Create one above to get started."
                    />
                  </td>
                </tr>
              ) : (
                data?.tokens.map((token) => {
                  const status = statusOf(token, now);
                  const isActive = status === 'active';
                  return (
                    <TableRow key={token.id} data-testid={`token-row-${token.id}`}>
                      <TableCell className="font-medium text-gray-900">{token.label}</TableCell>
                      <TableCell className="font-mono text-xs text-gray-700">
                        prov_{token.prefix}…
                      </TableCell>
                      <TableCell>
                        <ScopeChips scopes={token.scopes} />
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {token.last_used_at
                          ? new Date(token.last_used_at).toLocaleDateString()
                          : 'never'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(token.created_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {!isActive ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : revokeConfirm === token.id ? (
                          <span className="flex items-center justify-end gap-2">
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-8"
                              onClick={() => handleRevoke(token.id)}
                              data-testid={`revoke-confirm-${token.id}`}
                            >
                              Confirm
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8"
                              onClick={() => setRevokeConfirm(null)}
                            >
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 text-red-700 hover:bg-red-50 hover:text-red-800"
                            onClick={() => setRevokeConfirm(token.id)}
                            data-testid={`revoke-btn-${token.id}`}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Panel>
      )}

      {newSecret !== null && (
        <SecretModal secret={newSecret} onAcknowledge={() => setNewSecret(null)} />
      )}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </PageContainer>
  );
}
