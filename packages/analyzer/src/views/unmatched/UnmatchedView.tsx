/**
 * UnmatchedView — lists unmatched files with attach and discard actions.
 *
 * Route: /s/:courseSlug/:semesterSlug/unmatched
 *
 * - Lists unmatched ingest_files.
 * - "Attach" button opens modal with searchable student + assignment comboboxes.
 *   The modal warns and asks the admin to confirm if the chosen
 *   (student, assignment) already has a submission (which would be silently
 *   superseded by the server otherwise).
 * - "Discard" button with confirm dialog.
 */

import { useEffect, useMemo, useState } from 'react';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { Loader2, AlertTriangle } from 'lucide-react';
import {
  useUnmatchedFiles,
  useAttachUnmatched,
  useDiscardUnmatched,
  useRoster,
  useAssignments,
  useStudentSubmissions,
} from '../../api/queries.js';
import type { IngestFileSummary } from '@provenance/shared/api-schemas';
import { ApiError } from '../../api/client.js';
import { Combobox, type ComboboxOption } from '../../components/ui/combobox.js';

// ---------------------------------------------------------------------------
// Small debounced-value hook (local — only used here for the roster query).
// ---------------------------------------------------------------------------

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Attach modal
// ---------------------------------------------------------------------------

interface AttachModalProps {
  file: IngestFileSummary;
  semesterId: string;
  onClose: () => void;
  onAttached: () => void;
}

function AttachModal({ file, semesterId, onClose, onAttached }: AttachModalProps) {
  // --- form state ---------------------------------------------------------
  const [studentId, setStudentId] = useState('');
  const [assignmentIdStr, setAssignmentIdStr] = useState('');
  const [studentQuery, setStudentQuery] = useState('');
  const debouncedStudentQuery = useDebouncedValue(studentQuery, 200);
  const [confirmingOverwrite, setConfirmingOverwrite] = useState(false);

  // --- data ---------------------------------------------------------------
  const { data: roster, isFetching: rosterFetching } = useRoster(semesterId, {
    q: debouncedStudentQuery,
    limit: 500,
  });
  const { data: assignmentsData } = useAssignments(semesterId);
  const { data: studentSubs } = useStudentSubmissions(semesterId, studentId);

  const { mutate: attach, isPending, error } = useAttachUnmatched(semesterId);

  // --- derived ------------------------------------------------------------
  const studentOptions: ComboboxOption[] = useMemo(
    () =>
      (roster?.entries ?? []).map((e) => ({
        value: e.id,
        label: e.display_name,
        secondary: e.sid,
      })),
    [roster],
  );

  // Set of assignment_id_str that already have a submission for the selected
  // student. Used to mark options + drive the confirm-overwrite step.
  const conflictAssignments = useMemo(() => {
    const set = new Set<string>();
    for (const s of studentSubs?.items ?? []) {
      set.add(s.assignment.assignment_id_str);
    }
    return set;
  }, [studentSubs]);

  const assignmentOptions: ComboboxOption[] = useMemo(
    () =>
      (assignmentsData?.items ?? []).map((a) => {
        const conflict = conflictAssignments.has(a.assignment_id_str);
        const opt: ComboboxOption = {
          value: a.assignment_id_str,
          label: a.label,
          secondary: a.assignment_id_str,
        };
        if (conflict) {
          opt.badge = 'existing — will supersede';
          opt.badgeTone = 'warn';
        }
        return opt;
      }),
    [assignmentsData, conflictAssignments],
  );

  const hasConflict = assignmentIdStr !== '' && conflictAssignments.has(assignmentIdStr);

  // --- handlers -----------------------------------------------------------
  function handleStudentChange(next: string) {
    setStudentId(next);
    // Clear assignment when student changes — the conflict set is now stale.
    setAssignmentIdStr('');
    setConfirmingOverwrite(false);
  }

  function handleAssignmentChange(next: string) {
    setAssignmentIdStr(next);
    setConfirmingOverwrite(false);
  }

  function doAttach() {
    attach(
      { ingestFileId: file.id, studentId, assignmentIdStr },
      {
        onSuccess: () => {
          onAttached();
          onClose();
        },
      },
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!studentId || !assignmentIdStr) return;
    if (hasConflict && !confirmingOverwrite) {
      setConfirmingOverwrite(true);
      return;
    }
    doAttach();
  }

  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;

  const submitDisabled = isPending || !studentId || !assignmentIdStr;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid="attach-modal"
    >
      <div className="relative w-full max-w-md rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-1 text-lg font-semibold text-gray-900">Attach File</h2>
        <p className="mb-4 text-xs text-gray-500 font-mono break-all">{file.original_filename}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="attach-student"
              className="block text-xs font-medium text-gray-700 mb-1"
            >
              Student
            </label>
            <Combobox
              id="attach-student"
              data-testid="student-select"
              value={studentId}
              onChange={handleStudentChange}
              options={studentOptions}
              filter="none"
              query={studentQuery}
              onQueryChange={setStudentQuery}
              placeholder="Search by name or SID…"
              emptyText={
                debouncedStudentQuery === '' ? 'Type to search students' : 'No matching students'
              }
              loading={rosterFetching && debouncedStudentQuery !== ''}
              disabled={isPending}
            />
          </div>

          <div>
            <label
              htmlFor="attach-assignment"
              className="block text-xs font-medium text-gray-700 mb-1"
            >
              Assignment
            </label>
            <Combobox
              id="attach-assignment"
              data-testid="assignment-select"
              value={assignmentIdStr}
              onChange={handleAssignmentChange}
              options={assignmentOptions}
              placeholder="Search assignments…"
              emptyText="No matching assignments"
              disabled={isPending || studentId === ''}
            />
            {studentId === '' && (
              <p className="mt-1 text-[11px] text-gray-400">Select a student first.</p>
            )}
          </div>

          {hasConflict && !confirmingOverwrite && (
            <div
              className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
              data-testid="conflict-warning"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                This student already has a submission for this assignment. Attaching will supersede
                the existing one — Attach again to confirm.
              </span>
            </div>
          )}

          {confirmingOverwrite && (
            <div
              className="flex items-start gap-2 rounded border border-amber-300 bg-amber-100 p-3 text-xs text-amber-900"
              data-testid="confirm-overwrite"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Confirm: this will mark the existing submission as superseded and create a new
                latest version. Click <strong>Confirm Attach</strong> to proceed.
              </span>
            </div>
          )}

          {errorMsg && (
            <p className="text-xs text-red-600" data-testid="attach-error">
              {errorMsg}
            </p>
          )}

          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              disabled={isPending}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitDisabled}
              className="rounded bg-berkeley-700 px-3 py-1.5 text-sm text-white hover:bg-berkeley-800 disabled:opacity-50"
              data-testid="attach-submit"
            >
              {isPending
                ? 'Attaching…'
                : confirmingOverwrite
                  ? 'Confirm Attach'
                  : hasConflict
                    ? 'Attach (will supersede)'
                    : 'Attach'}
            </button>
          </div>
        </form>

        {isPending && <AttachProgressOverlay />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Progress overlay shown while the attach mutation is in flight.
//
// The server re-runs phases 5–9 (parse → materialize → stats → validation →
// heuristics) synchronously in the request, which can take tens of seconds for
// a long session. We don't get progress events from that endpoint, so the best
// we can do is be loud about the wait + show elapsed time so the admin doesn't
// think the UI has frozen.
// ---------------------------------------------------------------------------

function AttachProgressOverlay() {
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => {
      setElapsedS(Math.floor((Date.now() - start) / 1000));
    }, 250);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 rounded-lg bg-white/85"
      data-testid="attach-progress"
      role="status"
      aria-live="polite"
    >
      <Loader2 className="h-7 w-7 animate-spin text-berkeley-700" aria-hidden />
      <p className="text-sm font-medium text-gray-900">Attaching file…</p>
      <p className="px-6 text-center text-xs text-gray-500">
        Re-running parse, materialization, validation, and heuristics. This usually takes 10–60
        seconds depending on session length.
      </p>
      <p className="text-xs text-gray-400" data-testid="attach-elapsed">
        Elapsed: {elapsedS}s
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function UnmatchedView() {
  const { semesterId } = useActiveSemester();

  const { data, isLoading, error } = useUnmatchedFiles(semesterId);
  const { mutate: discard } = useDiscardUnmatched(semesterId);

  const [attachFile, setAttachFile] = useState<IngestFileSummary | null>(null);
  const [discardConfirm, setDiscardConfirm] = useState<string | null>(null); // ingestFileId

  function handleDiscard(fileId: string) {
    discard({ ingestFileId: fileId });
    setDiscardConfirm(null);
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-xl font-semibold text-gray-900">Unmatched Files</h1>

      {isLoading && <div className="py-8 text-center text-sm text-gray-400">Loading…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-red-500" data-testid="unmatched-error">
          Failed to load unmatched files.
        </div>
      )}

      {!isLoading && !error && semesterId && (
        <>
          {(data?.items ?? []).length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400" data-testid="unmatched-empty">
              No unmatched files. Great job!
            </div>
          ) : (
            <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
              <table className="w-full text-sm" data-testid="unmatched-table">
                <thead className="bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left">Filename</th>
                    <th className="px-4 py-2 text-right">Size</th>
                    <th className="px-4 py-2 text-left">Error</th>
                    <th className="px-4 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data?.items.map((file) => (
                    <tr key={file.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 font-mono text-xs">{file.original_filename}</td>
                      <td className="px-4 py-2 text-xs text-gray-400 text-right">
                        {(file.size_bytes / 1024).toFixed(1)} KB
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-500">
                        {file.error ? `${file.error.phase}: ${file.error.cause}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => setAttachFile(file)}
                            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                            data-testid={`attach-btn-${file.id}`}
                          >
                            Attach
                          </button>
                          {discardConfirm === file.id ? (
                            <span className="flex items-center gap-1">
                              <button
                                onClick={() => handleDiscard(file.id)}
                                className="rounded bg-red-600 px-2.5 py-1 text-xs text-white hover:bg-red-700"
                                data-testid={`discard-confirm-${file.id}`}
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setDiscardConfirm(null)}
                                className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              onClick={() => setDiscardConfirm(file.id)}
                              className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                              data-testid={`discard-btn-${file.id}`}
                            >
                              Discard
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Attach modal */}
      {attachFile && (
        <AttachModal
          file={attachFile}
          semesterId={semesterId}
          onClose={() => setAttachFile(null)}
          onAttached={() => setAttachFile(null)}
        />
      )}
    </div>
  );
}
