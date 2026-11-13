/**
 * SemesterSettingsView — display name, filename convention with live regex tester.
 *
 * Route: /s/:courseSlug/:semesterSlug/settings
 *
 * - Form: display_name, filename_convention (regex), retention days.
 * - Live regex tester: user types sample filename, shows match result + groups.
 * - Validates regex compiles before submit; shows inline error if invalid.
 * - Submit → PATCH /semesters/:id.
 */

import { useState, useEffect } from 'react';
import { useSemester, useUpdateSemester } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { ApiError } from '../../api/client.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';

// ---------------------------------------------------------------------------
// Live regex tester
// ---------------------------------------------------------------------------

interface RegexTesterProps {
  pattern: string;
}

function RegexTester({ pattern }: RegexTesterProps) {
  const [sample, setSample] = useState('alice_hw1_v2.zip');

  let result: { ok: boolean; groups?: Record<string, string>; error?: string } | null = null;

  if (pattern.trim() !== '') {
    try {
      const re = new RegExp(pattern);
      const match = re.exec(sample);
      if (match) {
        result = { ok: true, groups: match.groups ?? {} };
      } else {
        result = { ok: false };
      }
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : 'Invalid regex' };
    }
  }

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <label htmlFor="regex-tester-sample" className="mb-2 block text-xs font-medium text-gray-600">
        Live Tester
      </label>
      <input
        id="regex-tester-sample"
        type="text"
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        className="w-full rounded border border-gray-300 px-2 py-1 text-xs font-mono"
        placeholder="Type a sample filename…"
        data-testid="regex-sample-input"
      />

      {result !== null && (
        <div className="mt-2 text-xs" data-testid="regex-result">
          {result.error ? (
            <span className="text-red-600">Error: {result.error}</span>
          ) : result.ok ? (
            <div>
              <span className="text-green-700 font-medium">Matches</span>
              {Object.keys(result.groups ?? {}).length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {Object.entries(result.groups ?? {}).map(([k, v]) => (
                    <li key={k} className="font-mono">
                      <span className="text-gray-500">{k}:</span>{' '}
                      <span className="text-gray-900" data-testid={`group-${k}`}>
                        {v}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {Object.keys(result.groups ?? {}).length === 0 && (
                <span className="ml-1 text-gray-500">(no named groups)</span>
              )}
            </div>
          ) : (
            <span className="text-gray-500">No match</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function SemesterSettingsView() {
  const { semesterId } = useActiveSemester();

  const { data: semesterData, isLoading } = useSemester(semesterId);
  const { mutate: updateSemester, isPending, isSuccess, error } = useUpdateSemester(semesterId);

  const semester = semesterData?.semester;

  const [displayName, setDisplayName] = useState('');
  const [filenameConvention, setFilenameConvention] = useState('');
  const [blobRetentionDays, setBlobRetentionDays] = useState(90);
  const [derivedRetentionDays, setDerivedRetentionDays] = useState(365);
  const [regexError, setRegexError] = useState<string | null>(null);

  // Sync form state when semester data loads
  useEffect(() => {
    if (semester) {
      setDisplayName(semester.display_name ?? '');
      setFilenameConvention(semester.filename_convention ?? '');
      setBlobRetentionDays(semester.blob_retention_days ?? 90);
      setDerivedRetentionDays(semester.derived_retention_days ?? 365);
    }
  }, [semester]);

  function validateRegex(pattern: string): boolean {
    if (pattern.trim() === '') return true;
    try {
      new RegExp(pattern);
      setRegexError(null);
      return true;
    } catch (e) {
      setRegexError(e instanceof Error ? e.message : 'Invalid regex');
      return false;
    }
  }

  function handleFilenameConventionChange(val: string) {
    setFilenameConvention(val);
    validateRegex(val);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validateRegex(filenameConvention)) return;

    updateSemester({
      display_name: displayName,
      filename_convention: filenameConvention,
      blob_retention_days: blobRetentionDays,
      derived_retention_days: derivedRetentionDays,
    });
  }

  const submitError =
    error instanceof ApiError ? error.message : error instanceof Error ? error.message : null;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-xl font-semibold text-gray-900">Semester Settings</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Display name */}
        <div>
          <label
            htmlFor="settings-display-name"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Display Name
          </label>
          <input
            id="settings-display-name"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            data-testid="display-name-input"
          />
        </div>

        {/* Filename convention */}
        <div>
          <label
            htmlFor="settings-filename-convention"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Filename Convention (regex)
          </label>
          <p className="mb-1 text-xs text-gray-500">
            Named groups <code className="font-mono">(?&lt;sid&gt;...)</code> and{' '}
            <code className="font-mono">(?&lt;assignment_id&gt;...)</code> are extracted for
            automatic matching.
          </p>
          <input
            id="settings-filename-convention"
            type="text"
            value={filenameConvention}
            onChange={(e) => handleFilenameConventionChange(e.target.value)}
            className={`w-full rounded-md border px-3 py-2 text-sm font-mono ${
              regexError ? 'border-red-400' : 'border-gray-300'
            }`}
            aria-invalid={regexError !== null}
            aria-describedby={regexError ? 'settings-filename-convention-error' : undefined}
            data-testid="filename-convention-input"
          />
          {regexError && (
            <ErrorRegion className="mt-1 text-xs text-red-600">
              <p id="settings-filename-convention-error" data-testid="regex-error">
                {regexError}
              </p>
            </ErrorRegion>
          )}

          {/* Live tester */}
          <RegexTester pattern={filenameConvention} />
        </div>

        {/* Blob retention */}
        <div>
          <label
            htmlFor="settings-blob-retention"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Blob Retention (days)
          </label>
          <input
            id="settings-blob-retention"
            type="number"
            min={1}
            max={3650}
            value={blobRetentionDays}
            onChange={(e) => setBlobRetentionDays(Number(e.target.value))}
            className="w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
            data-testid="blob-retention-input"
          />
        </div>

        {/* Derived retention */}
        <div>
          <label
            htmlFor="settings-derived-retention"
            className="block text-sm font-medium text-gray-700 mb-1"
          >
            Derived Data Retention (days)
          </label>
          <input
            id="settings-derived-retention"
            type="number"
            min={1}
            max={3650}
            value={derivedRetentionDays}
            onChange={(e) => setDerivedRetentionDays(Number(e.target.value))}
            className="w-32 rounded-md border border-gray-300 px-3 py-2 text-sm"
            data-testid="derived-retention-input"
          />
        </div>

        {/* Error */}
        {submitError && (
          <p className="text-sm text-red-600" data-testid="submit-error">
            {submitError}
          </p>
        )}

        {/* Success */}
        {isSuccess && (
          <p className="text-sm text-green-700" data-testid="submit-success">
            Settings saved.
          </p>
        )}

        <button
          type="submit"
          disabled={isPending || regexError !== null || isLoading || !semesterId}
          className="rounded-md bg-berkeley-700 px-4 py-2 text-sm text-white hover:bg-berkeley-800 disabled:opacity-50"
          data-testid="save-settings-btn"
        >
          {isPending ? 'Saving…' : 'Save Settings'}
        </button>
      </form>
    </div>
  );
}
