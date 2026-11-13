/**
 * V45 — /admin/courses
 *
 * Lists every course; offers inline create (name + slug) and per-row
 * archive. Clicking into a course routes to /admin/courses/:id/semesters
 * for the semester management page.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AdminLayout } from './AdminLayout.js';
import { useAdminCourses, useCreateCourse, useArchiveCourse } from '../../api/queries.js';
import { ApiError } from '../../api/client.js';
import { EmptyState, Panel } from '@/components/layout/Page';
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

export function AdminCoursesView() {
  const { data, isLoading, error } = useAdminCourses();
  const { mutate: createCourse, isPending: isCreating } = useCreateCourse();
  const { mutate: archiveCourse } = useArchiveCourse();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [archiveConfirm, setArchiveConfirm] = useState<string | null>(null);

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim() === '' || slug.trim() === '') return;
    createCourse(
      { name: name.trim(), slug: slug.trim() },
      {
        onSuccess: () => {
          setName('');
          setSlug('');
        },
        onError: (err) => {
          setToast(err instanceof ApiError ? err.message : 'Failed to create course.');
        },
      },
    );
  }

  function handleArchive(courseId: string) {
    archiveCourse(courseId, {
      onSuccess: () => setArchiveConfirm(null),
      onError: (err) => {
        setArchiveConfirm(null);
        setToast(err instanceof ApiError ? err.message : 'Failed to archive course.');
      },
    });
  }

  return (
    <AdminLayout
      title="Courses"
      description="Create courses, archive courses, manage semesters within each course."
    >
      <Panel title="Create course" data-testid="create-course-form">
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-3">
          <div className="min-w-[200px] flex-1 space-y-1.5">
            <Label htmlFor="course-name">Course name</Label>
            <Input
              id="course-name"
              type="text"
              placeholder="Course name (e.g. CS 61A)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="course-name-input"
            />
          </div>
          <div className="w-40 space-y-1.5">
            <Label htmlFor="course-slug">Slug</Label>
            <Input
              id="course-slug"
              type="text"
              placeholder="Slug (e.g. cs61a)"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              pattern="[a-z0-9-]+"
              title="lowercase letters, digits, and hyphens"
              data-testid="course-slug-input"
            />
          </div>
          <Button
            type="submit"
            disabled={isCreating || name.trim() === '' || slug.trim() === ''}
            data-testid="create-course-submit"
          >
            {isCreating ? 'Creating…' : 'Create'}
          </Button>
        </form>
      </Panel>

      {isLoading && <div className="py-8 text-center text-sm text-gray-600">Loading courses…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-destructive" data-testid="courses-error">
          Failed to load courses.
        </div>
      )}

      {!isLoading && !error && (
        <Panel flush>
          {data?.courses.length === 0 ? (
            <EmptyState title="No courses yet." description="Create one above." />
          ) : (
            <Table data-testid="courses-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Semesters</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.courses.map((course) => (
                  <TableRow key={course.id} data-testid={`course-row-${course.id}`}>
                    <TableCell>
                      <Link
                        to={`/admin/courses/${course.id}/semesters`}
                        className="font-medium text-berkeley-700 hover:underline"
                      >
                        {course.name}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{course.slug}</TableCell>
                    <TableCell>{course.semesters_count}</TableCell>
                    <TableCell>
                      {course.archived ? (
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
                      {course.archived ? (
                        <span className="text-gray-600">—</span>
                      ) : archiveConfirm === course.id ? (
                        <div
                          className="ml-auto max-w-xs space-y-2 text-left"
                          data-testid={`archive-confirm-panel-${course.id}`}
                        >
                          <p className="text-xs text-gray-600">
                            Archiving <span className="font-medium">{course.name}</span> also
                            archives all of its semesters. They become read-only and their
                            data-retention countdown starts, after which stored recordings are
                            purged. This can’t be undone.
                          </p>
                          <span className="flex items-center gap-2">
                            <Button
                              variant="destructive"
                              size="sm"
                              onClick={() => handleArchive(course.id)}
                              data-testid={`archive-confirm-${course.id}`}
                            >
                              Archive course
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
                          onClick={() => setArchiveConfirm(course.id)}
                          data-testid={`archive-btn-${course.id}`}
                        >
                          Archive
                        </Button>
                      )}
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
