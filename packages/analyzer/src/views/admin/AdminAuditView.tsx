/**
 * V45 — /admin/audit
 *
 * Audit log list. Filters by action substring and date range (since/until).
 * The server endpoint already supports semester_id / actor_user_id filters too;
 * this UI exposes the most common ones (action + range) since the others are
 * typically followed from the per-user / per-semester pages.
 *
 * Layout: one compact row per event (when · action · one-line summary) that
 * expands to the full ids and the pretty-printed `detail` JSON. The previous
 * six-column table printed every uuid and the raw JSON inline, so a single
 * dry-run row scrolled the page sideways.
 *
 * Paging: infinite. Older rows load when the sentinel at the bottom scrolls
 * into view, with a "Load more" button as the keyboard / no-observer path.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AuditLogRow } from '@provenance/shared/api-schemas';
import { AdminLayout } from './AdminLayout.js';
import { useAdminAudit, useAdminUsers } from '../../api/queries.js';
import { EmptyState, Panel } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/** First 8 hex chars of a uuid — enough to tell rows apart at a glance. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatWhen(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
    time: d.toLocaleTimeString(),
  };
}

/** `heuristic_config.dry_run` → namespace `heuristic_config`, verb `dry_run`. */
function splitAction(action: string): { ns: string; verb: string } {
  const dot = action.indexOf('.');
  return dot === -1
    ? { ns: '', verb: action }
    : { ns: action.slice(0, dot + 1), verb: action.slice(dot + 1) };
}

function hasDetail(detail: unknown): boolean {
  if (detail === null || detail === undefined) return false;
  if (typeof detail === 'object' && Object.keys(detail).length === 0) return false;
  return true;
}

// ---------------------------------------------------------------------------
// One event
// ---------------------------------------------------------------------------

function AuditEvent({
  row,
  emailById,
}: {
  row: AuditLogRow;
  emailById: ReadonlyMap<string, string>;
}) {
  const when = formatWhen(row.at);
  const { ns, verb } = splitAction(row.action);
  const actor =
    row.actor_user_id !== null
      ? (emailById.get(row.actor_user_id) ?? `user ${shortId(row.actor_user_id)}`)
      : row.actor_token_id !== null
        ? `API token ${shortId(row.actor_token_id)}`
        : 'system';

  return (
    <li data-testid={`audit-row-${row.id}`}>
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[1rem_8.5rem_minmax(0,1fr)] items-start gap-x-3 px-4 py-3 hover:bg-gray-50/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="mt-0.5 h-4 w-4 text-gray-400 transition-transform group-open:rotate-90"
            aria-hidden="true"
          />
          <div className="text-xs leading-5 text-gray-500" title={row.at}>
            <div className="text-gray-700">{when.date}</div>
            <div className="tabular-nums">{when.time}</div>
          </div>
          <div className="min-w-0 space-y-0.5">
            <div className="truncate font-mono text-sm">
              <span className="text-gray-400">{ns}</span>
              <span className="font-medium text-gray-900">{verb}</span>
            </div>
            <div className="truncate text-xs text-gray-500">
              by <span className="text-gray-700">{actor}</span>
              {' · '}
              {row.target_type} <span className="font-mono">{shortId(row.target_id)}</span>
              {row.semester_id !== null && row.semester_id !== row.target_id && (
                <>
                  {' · '}semester <span className="font-mono">{shortId(row.semester_id)}</span>
                </>
              )}
            </div>
          </div>
        </summary>

        {/* Expanded: full ids + detail. Everything wraps; nothing scrolls sideways. */}
        <div className="space-y-3 border-t border-gray-100 bg-gray-50/60 px-4 py-3 pl-11 text-xs">
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-gray-500">Actor</dt>
            <dd className="break-all font-mono text-gray-700">
              {row.actor_user_id ??
                (row.actor_token_id !== null ? `token ${row.actor_token_id}` : '—')}
            </dd>
            <dt className="text-gray-500">Target</dt>
            <dd className="break-all font-mono text-gray-700">
              {row.target_type} {row.target_id}
            </dd>
            <dt className="text-gray-500">Semester</dt>
            <dd className="break-all font-mono text-gray-700">{row.semester_id ?? '—'}</dd>
            <dt className="text-gray-500">At</dt>
            <dd className="font-mono text-gray-700">{row.at}</dd>
          </dl>
          {hasDetail(row.detail) && (
            <pre
              className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-gray-200 bg-white p-3 font-mono text-[11px] text-gray-700"
              data-testid={`audit-detail-${row.id}`}
            >
              {JSON.stringify(row.detail, null, 2)}
            </pre>
          )}
        </div>
      </details>
    </li>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function AdminAuditView() {
  const [action, setAction] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const query = useAdminAudit({
    ...(action !== '' ? { action } : {}),
    ...(since !== '' ? { since: new Date(`${since}T00:00:00Z`).toISOString() } : {}),
    ...(until !== '' ? { until: new Date(`${until}T23:59:59Z`).toISOString() } : {}),
  });
  const { fetchNextPage, hasNextPage, isFetchingNextPage } = query;

  // Actor uuid → email, from the first page of users (staff counts are small).
  // A miss just falls back to a short id; it never hides the row.
  const users = useAdminUsers('');
  const emailById = useMemo(
    () => new Map((users.data?.items ?? []).map((u) => [u.id, u.email] as const)),
    [users.data],
  );

  const rows = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);

  // Infinite scroll: load the next page when the sentinel nears the viewport.
  // jsdom (tests) has no IntersectionObserver — the Load more button covers it.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (el === null || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) {
          void fetchNextPage();
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <AdminLayout
      title="Audit log"
      description="Every privileged action recorded across the platform."
      meta={rows.length > 0 ? `${rows.length}${hasNextPage ? '+' : ''} events` : undefined}
    >
      <Panel>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="audit-action">Action contains</Label>
            <Input
              id="audit-action"
              type="text"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              placeholder="e.g. admin."
              data-testid="audit-action-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-since">Since</Label>
            <Input
              id="audit-since"
              type="date"
              value={since}
              onChange={(e) => setSince(e.target.value)}
              data-testid="audit-since-input"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="audit-until">Until</Label>
            <Input
              id="audit-until"
              type="date"
              value={until}
              onChange={(e) => setUntil(e.target.value)}
              data-testid="audit-until-input"
            />
          </div>
        </div>
      </Panel>

      {query.isLoading && (
        <div className="py-8 text-center text-sm text-gray-600">Loading audit log…</div>
      )}
      {query.error && (
        <div className="py-8 text-center text-sm text-destructive" data-testid="audit-error">
          Failed to load audit log.
        </div>
      )}

      {!query.isLoading && !query.error && (
        <Panel flush>
          {rows.length === 0 ? (
            <EmptyState title="No audit rows match." />
          ) : (
            <>
              <ul className="divide-y divide-gray-100" data-testid="audit-table">
                {rows.map((row) => (
                  <AuditEvent key={row.id} row={row} emailById={emailById} />
                ))}
              </ul>
              <div
                ref={sentinelRef}
                className="flex items-center justify-center border-t border-gray-100 px-4 py-3"
              >
                {hasNextPage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void fetchNextPage()}
                    disabled={isFetchingNextPage}
                    data-testid="audit-load-more"
                  >
                    {isFetchingNextPage ? 'Loading…' : 'Load more'}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground" data-testid="audit-end">
                    End of audit log
                  </span>
                )}
              </div>
            </>
          )}
        </Panel>
      )}
    </AdminLayout>
  );
}
