/**
 * V45 — /admin/audit
 *
 * Audit log list. Filters by action substring and date range (since/until).
 * The server endpoint already supports semester_id / actor_user_id filters too;
 * this UI exposes the most common ones (action + range) since the others are
 * typically followed from the per-user / per-semester pages.
 */

import { useState } from 'react';
import { AdminLayout } from './AdminLayout.js';
import { useAdminAudit } from '../../api/queries.js';
import { EmptyState, Panel } from '@/components/layout/Page';
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

export function AdminAuditView() {
  const [action, setAction] = useState('');
  const [since, setSince] = useState('');
  const [until, setUntil] = useState('');

  const query = useAdminAudit({
    ...(action !== '' ? { action } : {}),
    ...(since !== '' ? { since: new Date(`${since}T00:00:00Z`).toISOString() } : {}),
    ...(until !== '' ? { until: new Date(`${until}T23:59:59Z`).toISOString() } : {}),
  });

  return (
    <AdminLayout
      title="Audit log"
      description="Every privileged action recorded across the platform."
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
          {query.data?.items.length === 0 ? (
            <EmptyState title="No audit rows match." />
          ) : (
            <Table data-testid="audit-table">
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Semester</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {query.data?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-xs text-gray-500">
                      {new Date(row.at).toLocaleString()}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{row.action}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.actor_user_id ?? row.actor_token_id ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="text-gray-500">{row.target_type}</span>{' '}
                      <span className="font-mono">{row.target_id}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-gray-500">
                      {row.semester_id ?? '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-gray-600">
                      {JSON.stringify(row.detail)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}
    </AdminLayout>
  );
}
