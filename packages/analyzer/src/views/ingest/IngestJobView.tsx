/**
 * IngestJobView — job detail with per-file table, status counts, cancel.
 *
 * Route: /s/:courseSlug/:semesterSlug/ingest/jobs/:jobId
 *
 * - Polls GET /ingest/jobs/:jobId every 3s while not terminal.
 * - Shows status counts (matched, unmatched, duplicate, failed, superseded).
 * - Lists files in a table.
 * - Cancel button only when status='queued' or 'running'.
 */

import { useParams, Link } from 'react-router-dom';
import { useIngestJob, useCancelIngest } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { PageContainer, PageHeader, Panel, EmptyState } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running…',
  succeeded: 'Succeeded',
  partial: 'Partial',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const STATUS_COLORS: Record<string, string> = {
  queued: 'border-yellow-200 bg-yellow-50 text-yellow-700',
  running: 'border-blue-200 bg-blue-50 text-blue-700',
  succeeded: 'border-green-200 bg-green-50 text-green-700',
  partial: 'border-orange-200 bg-orange-50 text-orange-700',
  failed: 'border-red-200 bg-red-50 text-red-700',
  cancelled: 'border-gray-200 bg-gray-100 text-gray-700',
};

const FILE_STATUS_COLORS: Record<string, string> = {
  matched: 'text-green-700',
  unmatched: 'text-yellow-700',
  duplicate: 'text-gray-500',
  failed: 'text-red-600',
  superseded: 'text-gray-600',
  discarded: 'text-gray-600',
  pending: 'text-blue-600',
};

export function IngestJobView() {
  const { jobId = '' } = useParams<{ jobId: string }>();

  const { semesterId, basePath } = useActiveSemester();

  const { data: job, isLoading, error } = useIngestJob(jobId, semesterId);
  const { mutate: cancelJob, isPending: isCancelling } = useCancelIngest(semesterId);

  const isTerminal =
    job?.status === 'succeeded' ||
    job?.status === 'partial' ||
    job?.status === 'failed' ||
    job?.status === 'cancelled';

  const canCancel = job?.status === 'queued' || job?.status === 'running';

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-sm text-gray-600">
        Loading job…
      </div>
    );
  }

  if (error || !job) {
    return (
      <div
        className="flex flex-1 items-center justify-center py-16 text-sm text-destructive"
        data-testid="job-error"
      >
        Failed to load job. Please try again.
      </div>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow={
          <>
            <Link to={`${basePath}/ingest`} className="hover:underline">
              Ingest
            </Link>
            {' / '}
            <span className="font-mono">{jobId.slice(0, 8)}…</span>
          </>
        }
        title="Ingest job"
        description="Progress and per-file results for one upload."
        meta={
          <span className="inline-flex items-center gap-3" data-testid="job-header">
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[job.status] ?? 'border-gray-200 bg-gray-100 text-gray-700'}`}
              data-testid="job-status"
            >
              {STATUS_LABELS[job.status] ?? job.status}
            </span>
            {!isTerminal && <span className="animate-pulse text-xs">Polling every 3s…</span>}
          </span>
        }
        actions={
          canCancel ? (
            <Button
              variant="outline"
              size="sm"
              className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-700"
              onClick={() => cancelJob(jobId)}
              disabled={isCancelling}
              data-testid="cancel-button"
            >
              {isCancelling ? 'Cancelling…' : 'Cancel Job'}
            </Button>
          ) : undefined
        }
      />

      {/* Summary counts */}
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-7" data-testid="job-summary">
        {Object.entries(job.summary).map(([key, count]) => (
          <div key={key} className="rounded-lg border bg-white p-3 text-center shadow-sm">
            <div className="text-lg font-semibold text-gray-900">{count}</div>
            <div className="text-xs capitalize text-muted-foreground">{key}</div>
          </div>
        ))}
      </div>

      {/* Files table */}
      <Panel title="Files" flush>
        <Table data-testid="files-table">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Filename</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Student</TableHead>
              <TableHead>Assignment</TableHead>
              <TableHead className="text-right">Size</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {job.files.length === 0 ? (
              <tr>
                <td colSpan={5}>
                  <EmptyState title="No files yet." />
                </td>
              </tr>
            ) : (
              job.files.map((file) => (
                <TableRow key={file.id}>
                  <TableCell className="font-mono text-xs">{file.original_filename}</TableCell>
                  <TableCell
                    className={`text-xs font-medium capitalize ${FILE_STATUS_COLORS[file.status] ?? 'text-gray-700'}`}
                  >
                    {file.status}
                  </TableCell>
                  <TableCell className="text-xs text-gray-600">
                    {file.matched_student
                      ? `${file.matched_student.sid} — ${file.matched_student.display_name}`
                      : '—'}
                  </TableCell>
                  <TableCell className="text-xs text-gray-600">
                    {file.matched_assignment
                      ? file.matched_assignment.label || file.matched_assignment.assignment_id_str
                      : '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs text-gray-600">
                    {(file.size_bytes / 1024).toFixed(1)} KB
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </Panel>

      {job.files.length === 200 && (
        <p className="text-xs text-muted-foreground">
          Showing first 200 files. Use the API to retrieve more.
        </p>
      )}
    </PageContainer>
  );
}
