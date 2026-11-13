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
    <AdminLayout>
      <div
        className="mb-6 rounded-lg border border-gray-200 bg-white p-4"
        data-testid="create-course-form"
      >
        <h2 className="mb-3 text-sm font-semibold text-gray-700">Create course</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap items-start gap-2">
          <input
            type="text"
            placeholder="Course name (e.g. CS 61A)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="min-w-[200px] flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm"
            data-testid="course-name-input"
          />
          <input
            type="text"
            placeholder="Slug (e.g. cs61a)"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            pattern="[a-z0-9-]+"
            title="lowercase letters, digits, and hyphens"
            className="w-40 rounded border border-gray-300 px-3 py-1.5 text-sm"
            data-testid="course-slug-input"
          />
          <button
            type="submit"
            disabled={isCreating || name.trim() === '' || slug.trim() === ''}
            className="rounded bg-berkeley-700 px-3 py-1.5 text-sm text-white hover:bg-berkeley-800 disabled:opacity-50"
            data-testid="create-course-submit"
          >
            {isCreating ? 'Creating…' : 'Create'}
          </button>
        </form>
      </div>

      {isLoading && <div className="py-8 text-center text-sm text-gray-600">Loading courses…</div>}
      {error && (
        <div className="py-8 text-center text-sm text-destructive" data-testid="courses-error">
          Failed to load courses.
        </div>
      )}

      {!isLoading && !error && (
        <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm" data-testid="courses-table">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-4 py-2 text-left">Name</th>
                <th className="px-4 py-2 text-left">Slug</th>
                <th className="px-4 py-2 text-left">Semesters</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data?.courses.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-gray-600">
                    No courses yet. Create one above.
                  </td>
                </tr>
              ) : (
                data?.courses.map((course) => (
                  <tr
                    key={course.id}
                    className="hover:bg-gray-50"
                    data-testid={`course-row-${course.id}`}
                  >
                    <td className="px-4 py-2">
                      <Link
                        to={`/admin/courses/${course.id}/semesters`}
                        className="text-xs font-medium text-berkeley-700 hover:underline"
                      >
                        {course.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-gray-700">{course.slug}</td>
                    <td className="px-4 py-2 text-xs text-gray-600">{course.semesters_count}</td>
                    <td className="px-4 py-2">
                      {course.archived ? (
                        <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[10px] font-medium text-gray-600">
                          archived
                        </span>
                      ) : (
                        <span className="rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                          active
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {course.archived ? (
                        <span className="text-xs text-gray-600">—</span>
                      ) : archiveConfirm === course.id ? (
                        <div
                          className="ml-auto max-w-xs text-left"
                          data-testid={`archive-confirm-panel-${course.id}`}
                        >
                          <p className="mb-1.5 text-xs text-gray-600">
                            Archiving <span className="font-medium">{course.name}</span> also
                            archives all of its semesters. They become read-only and their
                            data-retention countdown starts, after which stored recordings are
                            purged. This can’t be undone.
                          </p>
                          <span className="flex items-center gap-1">
                            <button
                              onClick={() => handleArchive(course.id)}
                              className="rounded bg-red-600 px-2.5 py-1 text-xs text-white hover:bg-red-700"
                              data-testid={`archive-confirm-${course.id}`}
                            >
                              Archive course
                            </button>
                            <button
                              onClick={() => setArchiveConfirm(null)}
                              className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
                            >
                              Cancel
                            </button>
                          </span>
                        </div>
                      ) : (
                        <button
                          onClick={() => setArchiveConfirm(course.id)}
                          className="rounded border border-red-300 px-2.5 py-1 text-xs text-red-700 hover:bg-red-50"
                          data-testid={`archive-btn-${course.id}`}
                        >
                          Archive
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {toast !== null && <Toast message={toast} onClose={() => setToast(null)} />}
    </AdminLayout>
  );
}
