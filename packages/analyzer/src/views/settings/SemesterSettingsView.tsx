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
import { PageContainer, PageHeader, Panel } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

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
    <div className="mt-3 space-y-2 rounded-lg border bg-gray-50 p-3">
      <Label htmlFor="regex-tester-sample" className="block text-xs text-gray-600">
        Live Tester
      </Label>
      <Input
        id="regex-tester-sample"
        type="text"
        value={sample}
        onChange={(e) => setSample(e.target.value)}
        className="h-8 w-full bg-white font-mono text-xs"
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
    <PageContainer>
      <PageHeader
        title="Semester Settings"
        description="Name this semester, set the filename convention used to match uploaded submissions, and choose how long data is retained."
      />

      <form onSubmit={handleSubmit} className="space-y-6">
        <Panel title="General">
          <div className="space-y-5">
            {/* Display name */}
            <div className="space-y-1.5">
              <Label htmlFor="settings-display-name">Display Name</Label>
              <Input
                id="settings-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                data-testid="display-name-input"
              />
            </div>

            {/* Filename convention */}
            <div className="space-y-1.5">
              <Label htmlFor="settings-filename-convention">Filename Convention (regex)</Label>
              <p className="text-xs text-muted-foreground">
                Named groups <code className="font-mono">(?&lt;sid&gt;...)</code> and{' '}
                <code className="font-mono">(?&lt;assignment_id&gt;...)</code> are extracted for
                automatic matching.
              </p>
              <Input
                id="settings-filename-convention"
                type="text"
                value={filenameConvention}
                onChange={(e) => handleFilenameConventionChange(e.target.value)}
                className={`font-mono ${regexError ? 'border-red-400 focus-visible:ring-red-500' : ''}`}
                aria-invalid={regexError !== null}
                aria-describedby={regexError ? 'settings-filename-convention-error' : undefined}
                data-testid="filename-convention-input"
              />
              {regexError && (
                <ErrorRegion className="text-xs text-red-600">
                  <p id="settings-filename-convention-error" data-testid="regex-error">
                    {regexError}
                  </p>
                </ErrorRegion>
              )}

              {/* Live tester */}
              <RegexTester pattern={filenameConvention} />
            </div>
          </div>
        </Panel>

        <Panel title="Retention">
          <div className="flex flex-wrap gap-6">
            {/* Blob retention */}
            <div className="space-y-1.5">
              <Label htmlFor="settings-blob-retention">Blob Retention (days)</Label>
              <Input
                id="settings-blob-retention"
                type="number"
                min={1}
                max={3650}
                value={blobRetentionDays}
                onChange={(e) => setBlobRetentionDays(Number(e.target.value))}
                className="w-32 tabular-nums"
                data-testid="blob-retention-input"
              />
            </div>

            {/* Derived retention */}
            <div className="space-y-1.5">
              <Label htmlFor="settings-derived-retention">Derived Data Retention (days)</Label>
              <Input
                id="settings-derived-retention"
                type="number"
                min={1}
                max={3650}
                value={derivedRetentionDays}
                onChange={(e) => setDerivedRetentionDays(Number(e.target.value))}
                className="w-32 tabular-nums"
                data-testid="derived-retention-input"
              />
            </div>
          </div>
        </Panel>

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

        <div className="flex justify-end">
          <Button
            type="submit"
            disabled={isPending || regexError !== null || isLoading || !semesterId}
            data-testid="save-settings-btn"
          >
            {isPending ? 'Saving…' : 'Save Settings'}
          </Button>
        </div>
      </form>
    </PageContainer>
  );
}
