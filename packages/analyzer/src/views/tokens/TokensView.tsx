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
          className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-700"
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
    active: 'bg-green-100 text-green-700',
    revoked: 'bg-gray-200 text-gray-600',
    expired: 'bg-amber-100 text-amber-700',
  };
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium capitalize ${styles[status]}`}
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
      <div className="w-full max-w-lg rounded-lg bg-white p-6 shadow-xl">
        <h2 id="secret-modal-title" className="mb-2 text-base font-semibold text-gray-900">
          Save your token
        </h2>
        <p className="mb-4 text-xs text-gray-600">
          This is the only time the full token will be shown. Copy it now and store it somewhere
          safe — a password manager or environment variable. Once you acknowledge, the token will be
          cleared from this page.
        </p>

        <div className="mb-3 flex items-stretch gap-2">
          <textarea
            readOnly
            value={secret}
            className="flex-1 resize-none rounded border border-gray-300 bg-gray-50 px-2 py-1.5 font-mono text-xs text-gray-900 break-all"
            rows={2}
            data-testid="secret-value"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            onClick={handleCopy}
            className="shrink-0 rounded bg-berkeley-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-berkeley-800"
            data-testid="secret-copy"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <label className="mb-4 flex items-start gap-2 text-xs text-gray-700">
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
          <button
            type="button"
            disabled={!acknowledged}
            onClick={onAcknowledge}
            className="rounded bg-berkeley-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-berkeley-800 disabled:opacity-50"
            data-testid="secret-ack-close"
          >
            Done
          </button>
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
    <form
      onSubmit={handleSubmit}
      className="rounded-lg border border-gray-200 bg-white p-4"
      data-testid="create-token-form"
    >
      <h2 className="mb-3 text-sm font-semibold text-gray-700">Create token</h2>

      <label className="mb-3 block">
        <span className="mb-1 block text-xs text-gray-600">Label</span>
        <input
          type="text"
          required
          maxLength={64}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. nightly-cohort-export"
          className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
          data-testid="token-label-input"
        />
      </label>

      <fieldset className="mb-3">
        <legend className="mb-1 text-xs text-gray-600">Scopes</legend>
        <div className="space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-gray-700">
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
          <label className="flex items-center gap-2 text-xs text-gray-700">
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
          <label className="flex items-center gap-2 text-xs text-gray-700">
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
            className="mt-2 max-h-32 space-y-1 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2"
            data-testid="semester-picker"
          >
            {(memberships ?? []).length === 0 && (
              <p className="text-xs text-gray-500">You have no semester memberships.</p>
            )}
            {(memberships ?? []).map((m) => (
              <label key={m.semester_id} className="flex items-center gap-2 text-xs text-gray-700">
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

      <label className="mb-4 block">
        <span className="mb-1 block text-xs text-gray-600">
          Expires <span className="text-gray-400">(optional)</span>
        </span>
        <input
          type="date"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1.5 text-sm"
          data-testid="token-expires-input"
        />
      </label>

      <button
        type="submit"
        disabled={!canSubmit}
        className="rounded bg-berkeley-700 px-3 py-1.5 text-sm text-white hover:bg-berkeley-800 disabled:opacity-50"
        data-testid="create-token-submit"
      >
        {isPending ? 'Creating…' : 'Create token'}
      </button>
    </form>
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
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-2 text-xl font-semibold text-gray-900">API tokens</h1>
      <p className="mb-6 text-xs text-gray-600">
        Personal access tokens authenticate scripts and external tools against the Provenance API.
        Each token inherits your current memberships, intersected with its scopes. See{' '}
        <a
          href="/api/v1/docs"
          target="_blank"
          rel="noreferrer"
          className="text-berkeley-700 hover:underline"
        >
          API docs
        </a>{' '}
        for endpoint reference.
      </p>

      <div className="mb-8">
        <CreateForm onCreated={(s) => setNewSecret(s)} onError={(m) => setToast(m)} />
      </div>

      {isLoading && <div className="py-8 text-center text-sm text-gray-400">Loading tokens…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-red-500" data-testid="tokens-error">
          Failed to load tokens.
        </div>
      )}

      {!isLoading && !error && (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm" data-testid="tokens-table">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Label</th>
                <th className="px-4 py-2 text-left">Prefix</th>
                <th className="px-4 py-2 text-left">Scopes</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-left">Last used</th>
                <th className="px-4 py-2 text-left">Created</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data?.tokens.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    No tokens yet. Create one above to get started.
                  </td>
                </tr>
              ) : (
                data?.tokens.map((token) => {
                  const status = statusOf(token, now);
                  const isActive = status === 'active';
                  return (
                    <tr
                      key={token.id}
                      className="hover:bg-gray-50"
                      data-testid={`token-row-${token.id}`}
                    >
                      <td className="px-4 py-2 text-xs font-medium text-gray-900">{token.label}</td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-700">
                        prov_{token.prefix}…
                      </td>
                      <td className="px-4 py-2">
                        <ScopeChips scopes={token.scopes} />
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge status={status} />
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {token.last_used_at
                          ? new Date(token.last_used_at).toLocaleDateString()
                          : 'never'}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {new Date(token.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2 text-right">
                        {!isActive ? (
                          <span className="text-xs text-gray-400">—</span>
                        ) : revokeConfirm === token.id ? (
                          <span className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => handleRevoke(token.id)}
                              className="rounded bg-red-600 px-2.5 py-1 text-xs text-white hover:bg-red-700"
                              data-testid={`revoke-confirm-${token.id}`}
                            >
                              Confirm
                            </button>
                            <button
                              onClick={() => setRevokeConfirm(null)}
                              className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                          </span>
                        ) : (
                          <button
                            onClick={() => setRevokeConfirm(token.id)}
                            className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                            data-testid={`revoke-btn-${token.id}`}
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {newSecret !== null && (
        <SecretModal secret={newSecret} onAcknowledge={() => setNewSecret(null)} />
      )}
      {toast && <Toast message={toast} onClose={() => setToast(null)} />}
    </div>
  );
}
