/**
 * V45 — /admin/courses/:courseId/semesters
 *
 * Lists semesters in a course, lets a superadmin create new semesters
 * (term + year + slug + display name + filename convention) and links into
 * the existing per-semester admin pages (settings, members, etc.) which
 * already exist at /s/:courseSlug/:semesterSlug/...
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AdminLayout } from './AdminLayout.js';
import {
  useAddSelfAsAdmin,
  useAdminCourses,
  useAdminSemesters,
  useArchiveSemester,
  useCreateSemester,
  useMe,
} from '../../api/queries.js';
import { ApiError } from '../../api/client.js';
import type { CreateSemesterRequest } from '@provenance/shared/api-schemas';
import { EmptyState, Panel } from '@/components/layout/Page';
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

const TERMS: ReadonlyArray<CreateSemesterRequest['term']> = ['fa', 'sp', 'su', 'wi'];

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

export function AdminSemestersView() {
  const { courseId = '' } = useParams<{ courseId: string }>();
  const { data: coursesData } = useAdminCourses();
  const course = coursesData?.courses.find((c) => c.id === courseId);

  const { data, isLoading, error } = useAdminSemesters(courseId);
  const { mutate: createSemester, isPending: isCreating } = useCreateSemester(courseId);
  const { data: me } = useMe();
  const myEmail = me?.user.email ?? null;
  const {
    mutate: addSelfAsAdmin,
    isPending: isAddingSelf,
    variables: addingVars,
  } = useAddSelfAsAdmin(courseId);
  const { mutate: archiveSemester } = useArchiveSemester(courseId);

  function handleArchive(semesterId: string) {
    archiveSemester(semesterId, {
      onSuccess: () => setArchiveConfirm(null),
      onError: (err) => {
        setArchiveConfirm(null);
        setToast(err instanceof ApiError ? err.message : 'Failed to archive semester.');
      },
    });
  }

  function handleAddSelf(semesterId: string) {
    if (myEmail === null) return;
    addSelfAsAdmin(
      { semesterId, email: myEmail },
      {
        onError: (err) => {
          setToast(err instanceof ApiError ? err.message : 'Failed to add you to this semester.');
        },
      },
    );
  }

  const [term, setTerm] = useState<CreateSemesterRequest['term']>('fa');
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [filenameConvention, setFilenameConvention] = useState(
    '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
  );
  const [toast, setToast] = useState<string | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (slug.trim() === '' || displayName.trim() === '' || filenameConvention.trim() === '') return;
    createSemester(
      {
        term,
        year,
        slug: slug.trim(),
        display_name: displayName.trim(),
        filename_convention: filenameConvention.trim(),
      },
      {
        onSuccess: () => {
          setSlug('');
          setDisplayName('');
        },
        onError: (err) => {
          setToast(err instanceof ApiError ? err.message : 'Failed to create semester.');
        },
      },
    );
  }

  return (
    <AdminLayout
      title={
        <>
          {course?.name ?? 'Course'} <span className="text-gray-600">/ semesters</span>
        </>
      }
      eyebrow={
        <Link to="/admin/courses" className="hover:underline">
          ← Back to courses
        </Link>
      }
    >
      <Panel title="Create semester">
        <form onSubmit={handleCreate} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="semester-term">Term</Label>
            <NativeSelect
              id="semester-term"
              value={term}
              onChange={(e) => setTerm(e.target.value as CreateSemesterRequest['term'])}
              className="w-full"
              data-testid="semester-term-select"
            >
              {TERMS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </NativeSelect>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="semester-year">Year</Label>
            <Input
              id="semester-year"
              type="number"
              value={year}
              min={2000}
              max={2100}
              onChange={(e) => setYear(parseInt(e.target.value, 10))}
              data-testid="semester-year-input"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="semester-slug">Slug</Label>
            <Input
              id="semester-slug"
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="fa26"
              pattern="[a-z0-9-]+"
              data-testid="semester-slug-input"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="semester-display-name">Display name</Label>
            <Input
              id="semester-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Fall 2026"
              data-testid="semester-display-name-input"
            />
          </div>

          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="semester-filename">
              Filename convention (regex with named groups <code>sid</code> and{' '}
              <code>assignment_id</code>)
            </Label>
            <Input
              id="semester-filename"
              type="text"
              value={filenameConvention}
              onChange={(e) => setFilenameConvention(e.target.value)}
              className="font-mono text-xs"
              data-testid="semester-filename-input"
            />
          </div>

          <div className="sm:col-span-2">
            <Button
              type="submit"
              disabled={isCreating || slug.trim() === '' || displayName.trim() === ''}
              data-testid="create-semester-submit"
            >
              {isCreating ? 'Creating…' : 'Create semester'}
            </Button>
          </div>
        </form>
      </Panel>

      {isLoading && (
        <div className="py-8 text-center text-sm text-gray-600">Loading semesters…</div>
      )}
      {error && (
        <div className="py-8 text-center text-sm text-destructive">Failed to load semesters.</div>
      )}

      {!isLoading && !error && (
        <Panel flush>
          {data?.semesters.length === 0 ? (
            <EmptyState title="No semesters yet." />
          ) : (
            <Table data-testid="semesters-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Slug</TableHead>
                  <TableHead>Display name</TableHead>
                  <TableHead>Term/Year</TableHead>
                  <TableHead>Submissions</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.semesters.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.slug}</TableCell>
                    <TableCell>{s.display_name}</TableCell>
                    <TableCell className="text-gray-600">
                      {s.term} {s.year}
                    </TableCell>
                    <TableCell className="text-gray-600">{s.submission_count}</TableCell>
                    <TableCell>
                      {s.archived ? (
                        <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-50 px-2.5 py-0.5 text-xs font-medium text-gray-600">
                          archived
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-xs font-medium text-green-700">
                          active
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex flex-col items-end gap-2">
                        {s.my_role === null ? (
                          // Not a member yet: the per-semester pages resolve the
                          // semester from your membership list, so they can't load
                          // until you're added. Add yourself here first.
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => handleAddSelf(s.id)}
                            disabled={
                              myEmail === null || (isAddingSelf && addingVars?.semesterId === s.id)
                            }
                            data-testid={`add-me-${s.slug}`}
                          >
                            {isAddingSelf && addingVars?.semesterId === s.id
                              ? 'Adding…'
                              : 'Add me as admin'}
                          </Button>
                        ) : (
                          <Link
                            to={`/s/${course?.slug ?? ''}/${s.slug}/settings`}
                            className="text-berkeley-700 hover:underline"
                          >
                            Open settings →
                          </Link>
                        )}

                        {s.archived ? null : archiveConfirm === s.id ? (
                          <div
                            className="max-w-xs space-y-2 text-left"
                            data-testid={`semester-archive-confirm-panel-${s.id}`}
                          >
                            <p className="text-xs text-gray-600">
                              Archiving <span className="font-medium">{s.display_name}</span> makes
                              it read-only and starts its data-retention countdown, after which
                              stored recordings are purged. This can’t be undone.
                            </p>
                            <span className="flex items-center gap-2">
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={() => handleArchive(s.id)}
                                data-testid={`semester-archive-confirm-${s.id}`}
                              >
                                Archive semester
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setArchiveConfirm(null)}
                              >
                                Cancel
                              </Button>
                            </span>
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="border-red-300 text-red-700 hover:bg-red-50 hover:text-red-700"
                            onClick={() => setArchiveConfirm(s.id)}
                            data-testid={`semester-archive-btn-${s.id}`}
                          >
                            Archive
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      )}

      {toast !== null && <Toast message={toast} onClose={() => setToast(null)} />}
    </AdminLayout>
  );
}
