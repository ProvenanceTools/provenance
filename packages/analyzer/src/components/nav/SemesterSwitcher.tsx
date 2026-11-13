/**
 * SemesterSwitcher — dropdown listing the user's accessible semesters.
 *
 * The active semester is determined by the (:courseSlug, :semesterSlug) URL
 * pair (from /s/:courseSlug/:semesterSlug routes). Selecting a different
 * semester navigates to the same sub-path within that semester.
 *
 * Options are keyed and valued by `semester_id` (not slug) so two semesters
 * that share a slug across different courses remain distinct, unambiguous
 * choices. Navigation rebuilds the course-qualified base path from the
 * selected membership rather than string-replacing the slug in the URL.
 *
 * If the user has one or zero semesters, no switcher is rendered.
 */

import { useNavigate, useLocation } from 'react-router-dom';
import { useSemesters } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';

export function SemesterSwitcher() {
  const { data: semesters } = useSemesters();
  const { membership: active, basePath } = useActiveSemester();
  const navigate = useNavigate();
  const location = useLocation();

  if (!semesters || semesters.length <= 1) {
    return null;
  }

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const newId = e.target.value;
    if (!newId || newId === active?.semester_id) return;

    const target = semesters?.find((s) => s.semester_id === newId);
    if (!target) return;

    const newBase = `/s/${target.course_slug}/${target.semester_slug}`;
    // Preserve the current sub-path (e.g. /roster) when switching semesters.
    const subPath =
      basePath && location.pathname.startsWith(basePath)
        ? location.pathname.slice(basePath.length)
        : '';
    void navigate(newBase + subPath + location.search);
  }

  return (
    <select
      value={active?.semester_id ?? ''}
      onChange={handleChange}
      aria-label="Switch semester"
      className="rounded-md border border-gray-300 bg-white px-2 py-1 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-berkeley-500"
      data-testid="semester-switcher"
    >
      {semesters.map((s) => (
        <option key={s.semester_id} value={s.semester_id}>
          {s.course_name} — {s.semester_display_name}
        </option>
      ))}
    </select>
  );
}
