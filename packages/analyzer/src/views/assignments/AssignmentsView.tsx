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
      <Input
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        aria-label="Assignment label"
        className="h-8 w-56"
        autoFocus
        data-testid={`label-input-${assignment.id}`}
      />
      <Button
        type="submit"
        size="sm"
        disabled={isPending || label.trim() === ''}
        data-testid={`label-save-${assignment.id}`}
      >
        {isPending ? 'Saving…' : 'Save'}
      </Button>
      <Button type="button" variant="outline" size="sm" onClick={onDone}>
        Cancel
      </Button>
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
    <Panel
      title="Create assignment"
      description="The ID must match the filename convention / manifest id that submissions will use, so later-ingested or attached files link to this assignment."
    >
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="create-assignment-id">Assignment ID</Label>
          <Input
            id="create-assignment-id"
            type="text"
            value={assignmentIdStr}
            onChange={(e) => setAssignmentIdStr(e.target.value)}
            placeholder="hw1"
            className="w-40 font-mono"
            data-testid="create-assignment-id-input"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="create-assignment-label">Label (optional)</Label>
          <Input
            id="create-assignment-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Homework 1"
            className="w-56"
            data-testid="create-assignment-label-input"
          />
        </div>
        <Button
          type="submit"
          disabled={isPending || assignmentIdStr.trim() === ''}
          data-testid="create-assignment-submit"
        >
          {isPending ? 'Creating…' : 'Create'}
        </Button>
        {errorMsg && (
          <span className="text-xs text-red-600" data-testid="create-assignment-error">
            {errorMsg}
          </span>
        )}
      </form>
    </Panel>
  );
}

export function AssignmentsView() {
  const { semesterId } = useActiveSemester();

  const { data, isLoading, error } = useAssignments(semesterId);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <PageContainer>
      <PageHeader
        title="Assignments"
        description="Assignments in this semester, with submission and student counts. Click a label to edit it inline."
      />

      {semesterId && <CreateAssignmentForm semesterId={semesterId} />}

      {isLoading && (
        <Panel>
          <p className="py-6 text-center text-sm text-muted-foreground">Loading assignments…</p>
        </Panel>
      )}
      {error && (
        <Panel>
          <p className="py-6 text-center text-sm text-red-600" data-testid="assignments-error">
            Failed to load assignments.
          </p>
        </Panel>
      )}

      {!isLoading && !error && semesterId && (
        <Panel flush>
          <Table data-testid="assignments-table">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>ID</TableHead>
                <TableHead>Label</TableHead>
                <TableHead className="text-right">Submissions</TableHead>
                <TableHead className="text-right">Students</TableHead>
                <TableHead className="text-right">Sort Order</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data?.items.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <EmptyState title="No assignments yet." />
                  </td>
                </tr>
              ) : (
                data?.items.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-mono tabular-nums text-muted-foreground">
                      {a.assignment_id_str}
                    </TableCell>
                    <TableCell>
                      {editingId === a.id ? (
                        <EditRow
                          assignment={a}
                          semesterId={semesterId}
                          onDone={() => setEditingId(null)}
                        />
                      ) : (
                        <button
                          onClick={() => setEditingId(a.id)}
                          className="text-left font-medium text-gray-900 hover:text-berkeley-700 hover:underline"
                          data-testid={`label-${a.id}`}
                        >
                          {a.label}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{a.submission_count}</TableCell>
                    <TableCell className="text-right tabular-nums">{a.distinct_students}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {a.sort_order}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </Panel>
      )}
    </PageContainer>
  );
}
