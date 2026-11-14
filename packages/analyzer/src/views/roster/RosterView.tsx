/**
 * RosterView — lists roster entries, CSV upload with diff preview modal.
 *
 * Route: /s/:courseSlug/:semesterSlug/roster
 *
 * - Lists current roster entries (sid + display_name + email).
 * - "Upload CSV" button → modal with file picker → POST /roster:upload → show diff.
 * - "Commit" button on diff → POST /roster:commit.
 */

import { useState, useRef } from 'react';
import { useRoster, useRosterUpload, useRosterCommit } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog.js';
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
import type { RosterDiff } from '@provenance/shared/api-schemas';

// ---------------------------------------------------------------------------
// Upload/diff modal
// ---------------------------------------------------------------------------

interface UploadModalProps {
  semesterId: string;
  onClose: () => void;
  onCommitted: () => void;
  /** Element focus is restored to when the dialog closes (the "Upload CSV" trigger). */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

function UploadModal({ semesterId, onClose, onCommitted, triggerRef }: UploadModalProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [diff, setDiff] = useState<RosterDiff | null>(null);
  const [acceptDeletions, setAcceptDeletions] = useState(false);

  const {
    mutate: upload,
    isPending: isUploading,
    error: uploadError,
  } = useRosterUpload(semesterId);
  const {
    mutate: commit,
    isPending: isCommitting,
    error: commitError,
  } = useRosterCommit(semesterId);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    upload(file, {
      onSuccess: (result) => {
        setDiff(result);
      },
    });
  }

  function handleCommit() {
    if (!diff) return;
    commit(
      { uploadId: diff.upload_id, acceptDeletions },
      {
        onSuccess: () => {
          onCommitted();
          onClose();
        },
      },
    );
  }

  const errorMsg =
    (uploadError instanceof Error ? uploadError.message : null) ||
    (commitError instanceof Error ? commitError.message : null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="max-w-lg"
        data-testid="upload-modal"
        onCloseAutoFocus={(event) => {
          // Not triggered via DialogTrigger (open/close is externally controlled by
          // RosterView's showUpload state), so Radix has no trigger element to
          // restore focus to on its own. Restore it manually (WCAG 2.4.3).
          event.preventDefault();
          triggerRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Upload Roster CSV</DialogTitle>
          <DialogDescription className="sr-only">
            Upload a roster CSV to preview and commit changes to the roster.
          </DialogDescription>
        </DialogHeader>

        {!diff ? (
          <>
            <p className="mb-4 text-sm text-gray-600">
              Required columns: <code className="font-mono">sid</code>,{' '}
              <code className="font-mono">display_name</code>. Optional:{' '}
              <code className="font-mono">email</code>.
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={handleFileChange}
              data-testid="csv-input"
            />

            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              data-testid="select-csv-btn"
            >
              {isUploading ? 'Parsing CSV…' : 'Select CSV file'}
            </Button>

            {errorMsg && (
              <p className="mt-2 text-xs text-red-600" data-testid="upload-error">
                {errorMsg}
              </p>
            )}
          </>
        ) : (
          <>
            {/* Diff preview */}
            <div className="mb-4 rounded-lg bg-gray-50 p-4 text-sm" data-testid="diff-preview">
              <div className="grid grid-cols-2 gap-2">
                <div>Parsed rows</div>
                <div className="font-medium">{diff.parsed_rows}</div>
                <div className="text-green-700">To add</div>
                <div className="font-medium text-green-700" data-testid="diff-to-add">
                  {diff.to_add > 0 ? '+' : ''}
                  {diff.to_add}
                </div>
                <div className="text-yellow-700">To update</div>
                <div className="font-medium text-yellow-700" data-testid="diff-to-update">
                  {diff.to_update}
                </div>
                <div className="text-red-700">To delete</div>
                <div className="font-medium text-red-700" data-testid="diff-to-delete">
                  {diff.to_delete > 0 ? '−' : ''}
                  {diff.to_delete}
                </div>
              </div>

              {diff.errors.length > 0 && (
                <div className="mt-3">
                  <p className="text-xs font-medium text-red-600 mb-1">Parse warnings:</p>
                  <ul className="space-y-0.5">
                    {diff.errors.map((err, i) => (
                      <li key={i} className="text-xs text-red-600">
                        {err.row !== undefined ? `Row ${err.row}: ` : ''}
                        {err.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Accept deletions checkbox (only if there are deletions) */}
            {diff.to_delete > 0 && (
              <label className="mb-4 flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={acceptDeletions}
                  onChange={(e) => setAcceptDeletions(e.target.checked)}
                  className="mt-0.5"
                  data-testid="accept-deletions"
                />
                <span>
                  Delete {diff.to_delete} entries not present in CSV{' '}
                  <span className="text-red-600 font-medium">(destructive)</span>
                </span>
              </label>
            )}

            {errorMsg && (
              <p className="mb-2 text-xs text-red-600" data-testid="commit-error">
                {errorMsg}
              </p>
            )}
          </>
        )}

        <div className="mt-4 flex gap-2 justify-end">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {diff && (
            <Button
              size="sm"
              onClick={handleCommit}
              disabled={isCommitting}
              data-testid="commit-btn"
              aria-label={
                diff.to_delete > 0 && acceptDeletions
                  ? `Commit roster changes, including deleting ${diff.to_delete} entries`
                  : undefined
              }
            >
              {isCommitting ? 'Committing…' : 'Commit'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function RosterView() {
  const { semesterId } = useActiveSemester();

  const { data, isLoading, error } = useRoster(semesterId);
  const [showUpload, setShowUpload] = useState(false);
  const uploadBtnRef = useRef<HTMLButtonElement>(null);

  return (
    <PageContainer>
      <PageHeader
        title="Roster"
        meta={data?.total_count !== undefined ? `${data.total_count} entries` : undefined}
        description="Students enrolled in this semester, used to match submissions to student IDs. Upload a CSV to preview and commit changes."
        actions={
          <Button
            ref={uploadBtnRef}
            size="sm"
            onClick={() => setShowUpload(true)}
            data-testid="upload-csv-btn"
          >
            Upload CSV
          </Button>
        }
      />

      {isLoading && (
        <Panel>
          <p className="py-6 text-center text-sm text-muted-foreground">Loading roster…</p>
        </Panel>
      )}
      {error && (
        <Panel>
          <p className="py-6 text-center text-sm text-red-600" data-testid="roster-error">
            Failed to load roster.
          </p>
        </Panel>
      )}

      {!isLoading && !error && semesterId && (
        <Panel flush>
          <Table data-testid="roster-table">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>SID</TableHead>
                <TableHead>Display Name</TableHead>
                <TableHead>Email</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.entries.length === 0 ? (
                <tr>
                  <td colSpan={3}>
                    <EmptyState title="No roster entries. Upload a CSV to get started." />
                  </td>
                </tr>
              ) : (
                data?.entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell className="font-mono tabular-nums">{entry.sid}</TableCell>
                    <TableCell className="font-medium text-gray-900">
                      {entry.display_name}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{entry.email ?? '—'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Panel>
      )}

      {showUpload && (
        <UploadModal
          semesterId={semesterId}
          onClose={() => setShowUpload(false)}
          onCommitted={() => setShowUpload(false)}
          triggerRef={uploadBtnRef}
        />
      )}
    </PageContainer>
  );
}
