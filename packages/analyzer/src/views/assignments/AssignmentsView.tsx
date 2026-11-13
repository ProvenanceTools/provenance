/**
 * AssignmentsView — lists assignments with inline label editing.
 *
 * Route: /s/:courseSlug/:semesterSlug/assignments
 *
 * - Lists assignments with label, assignment_id_str, submission count.
 * - Click label → inline edit field → PATCH /assignments/:id (V46).
 */

import { useState } from 'react';
import { useAssignments, useUpdateAssignment, useCreateAssignment } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { ApiError } from '../../api/client.js';
import type { AssignmentSummary } from '@provenance/shared/api-schemas';

interface EditRowProps {
  assignment: AssignmentSummary;
  semesterId: string;
  onDone: () => void;
}

function EditRow({ assignment, semesterId, onDone }: EditRowProps) {
  const [label, setLabel] = useState(assignment.label);
  const { mutate: updateAssignment, isPending, error } = useUpdateAssignment(semesterId);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (label.trim() === '') return;
    updateAssignment(
      { assignmentId: assignment.id, label: label.trim() },
      {
        onSuccess: onDone,
      },
    );
  }

  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2">
      <input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        className="rounded border border-berkeley-400 px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-berkeley-400"
        autoFocus
        data-testid={`label-input-${assignment.id}`}
      />
      <button
        type="submit"
        disabled={isPending || label.trim() === ''}
        className="rounded bg-berkeley-700 px-2.5 py-0.5 text-xs text-white hover:bg-berkeley-800 disabled:opacity-50"
        data-testid={`label-save-${assignment.id}`}
      >
        {isPending ? 'Saving…' : 'Save'}
      </button>
      <button
        type="button"
        onClick={onDone}
        className="rounded border border-gray-300 px-2.5 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
      >
        Cancel
      </button>
      {errorMsg && (
        <span className="text-xs text-red-600" data-testid={`label-error-${assignment.id}`}>
          {errorMsg}
        </span>
      )}
    </form>
  );
}

function CreateAssignmentForm({ semesterId }: { semesterId: string }) {
  const [assignmentIdStr, setAssignmentIdStr] = useState('');
  const [label, setLabel] = useState('');
  const { mutate: createAssignment, isPending, error } = useCreateAssignment(semesterId);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const id = assignmentIdStr.trim();
    if (id === '') return;
    createAssignment(
      { assignmentIdStr: id, label: label.trim() },
      {
        onSuccess: () => {
          setAssignmentIdStr('');
          setLabel('');
        },
      },
    );
  }

  const errorMsg =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;

  return (
    <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-gray-700">Create assignment</h2>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-2">
        <label className="text-xs text-gray-600">
          Assignment ID
          <input
            type="text"
            value={assignmentIdStr}
            onChange={(e) => setAssignmentIdStr(e.target.value)}
            placeholder="hw1"
            className="mt-0.5 block w-40 rounded border border-gray-300 px-2 py-1.5 font-mono text-xs"
            data-testid="create-assignment-id-input"
          />
        </label>
        <label className="text-xs text-gray-600">
          Label (optional)
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Homework 1"
            className="mt-0.5 block w-56 rounded border border-gray-300 px-2 py-1.5 text-sm"
            data-testid="create-assignment-label-input"
          />
        </label>
        <button
          type="submit"
          disabled={isPending || assignmentIdStr.trim() === ''}
          className="rounded bg-berkeley-700 px-3 py-1.5 text-sm text-white hover:bg-berkeley-800 disabled:opacity-50"
          data-testid="create-assignment-submit"
        >
          {isPending ? 'Creating…' : 'Create'}
        </button>
        {errorMsg && (
          <span className="text-xs text-red-600" data-testid="create-assignment-error">
            {errorMsg}
          </span>
        )}
      </form>
      <p className="mt-2 text-[11px] text-gray-400">
        The ID must match the filename convention / manifest id that submissions will use, so
        later-ingested or attached files link to this assignment.
      </p>
    </div>
  );
}

export function AssignmentsView() {
  const { semesterId } = useActiveSemester();

  const { data, isLoading, error } = useAssignments(semesterId);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-xl font-semibold text-gray-900">Assignments</h1>
      <p className="mb-4 text-xs text-gray-500">Click a label to edit it inline.</p>

      {semesterId && <CreateAssignmentForm semesterId={semesterId} />}

      {isLoading && (
        <div className="py-8 text-center text-sm text-gray-400">Loading assignments…</div>
      )}
      {error && (
        <div className="py-8 text-center text-sm text-red-500" data-testid="assignments-error">
          Failed to load assignments.
        </div>
      )}

      {!isLoading && !error && semesterId && (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm" data-testid="assignments-table">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">ID</th>
                <th className="px-4 py-2 text-left">Label</th>
                <th className="px-4 py-2 text-right">Submissions</th>
                <th className="px-4 py-2 text-right">Students</th>
                <th className="px-4 py-2 text-right">Sort Order</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data?.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-400">
                    No assignments yet.
                  </td>
                </tr>
              ) : (
                data?.items.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-mono text-xs text-gray-500">
                      {a.assignment_id_str}
                    </td>
                    <td className="px-4 py-2">
                      {editingId === a.id ? (
                        <EditRow
                          assignment={a}
                          semesterId={semesterId}
                          onDone={() => setEditingId(null)}
                        />
                      ) : (
                        <button
                          onClick={() => setEditingId(a.id)}
                          className="text-left text-sm text-gray-900 hover:text-berkeley-700 hover:underline"
                          data-testid={`label-${a.id}`}
                        >
                          {a.label}
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-gray-600">
                      {a.submission_count}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-gray-600">
                      {a.distinct_students}
                    </td>
                    <td className="px-4 py-2 text-right text-xs text-gray-500">{a.sort_order}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
