/**
 * GradescopeUpload — primary upload path on the ingest screen.
 *
 * Accepts the single ZIP that Gradescope produces from "Download Submissions".
 * The server upserts the roster from the export's metadata and enqueues an
 * ingest job; on success with a job_id we navigate to the job page. When the
 * export had no processable bundles (job_id null) we show the roster summary
 * in place instead of navigating.
 */

import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStartGradescopeIngest } from '../../api/queries.js';
import type { GradescopeIngestResponse } from '@provenance/shared/api-schemas';
import { ApiError } from '../../api/client.js';

interface GradescopeUploadProps {
  /** Course-qualified base path, e.g. `/s/cs61a/sp25`, used for post-ingest navigation. */
  basePath: string;
  semesterId: string;
}

export function GradescopeUpload({ basePath, semesterId }: GradescopeUploadProps) {
  const navigate = useNavigate();
  const { mutate: startGradescope, isPending } = useStartGradescopeIngest(semesterId);

  const [file, setFile] = useState<File | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [result, setResult] = useState<GradescopeIngestResponse | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function selectFile(selected: File | undefined) {
    setResult(null);
    setUploadError(null);
    if (selected === undefined) {
      setFile(null);
      setValidationError('No file selected.');
      return;
    }
    if (!selected.name.endsWith('.zip')) {
      setFile(null);
      setValidationError('The Gradescope export must be a .zip file.');
      return;
    }
    setValidationError(null);
    setFile(selected);
  }

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    selectFile(Array.from(e.dataTransfer.files)[0]);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validationError || file === null || !semesterId) return;

    setUploadProgress(0);
    setUploadError(null);
    setResult(null);

    startGradescope(
      { file, onProgress: (pct) => setUploadProgress(pct) },
      {
        onSuccess: (data) => {
          setUploadProgress(null);
          if (data.job_id !== null) {
            void navigate(`${basePath}/ingest/jobs/${data.job_id}`);
          } else {
            // Roster-only export (no bundles) — show the summary in place.
            setResult(data);
          }
        },
        onError: (err) => {
          setUploadProgress(null);
          if (err instanceof ApiError || err instanceof Error) {
            setUploadError(err.message);
          } else {
            setUploadError('Upload failed. Please try again.');
          }
        },
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} data-testid="gradescope-upload">
      <div
        role="button"
        tabIndex={0}
        data-testid="gs-drop-zone"
        className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-10 transition-colors ${
          isDragOver
            ? 'border-orange-500 bg-orange-50'
            : 'border-gray-300 bg-gray-50 hover:border-gray-400'
        }`}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
        }}
      >
        <p className="text-sm text-gray-600">
          Drop the <span className="font-medium">Gradescope export .zip</span> here, or click to
          select
        </p>
        <p className="mt-1 text-xs text-gray-400">
          The ZIP you download from Gradescope’s “Download Submissions”. The roster is populated
          automatically from it.
        </p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        data-testid="gs-file-input"
        onChange={(e) => selectFile(Array.from(e.target.files ?? [])[0])}
      />

      {file && (
        <p className="mt-3 flex items-center gap-2 text-xs text-gray-700" data-testid="gs-selected">
          <span className="font-mono">{file.name}</span>
          <span className="text-gray-400">({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
        </p>
      )}

      {validationError && (
        <p className="mt-2 text-xs text-red-600" data-testid="gs-validation-error">
          {validationError}
        </p>
      )}

      {uploadProgress !== null && (
        <div className="mt-4" data-testid="gs-upload-progress">
          <div className="mb-1 flex justify-between text-xs text-gray-600">
            <span>Uploading…</span>
            <span>{uploadProgress}%</span>
          </div>
          <div className="h-2 w-full rounded-full bg-gray-200">
            <div
              className="h-2 rounded-full bg-orange-700 transition-all"
              style={{ width: `${uploadProgress}%` }}
            />
          </div>
        </div>
      )}

      {uploadError && (
        <p className="mt-2 text-xs text-red-600" data-testid="gs-upload-error">
          {uploadError}
        </p>
      )}

      {result && (
        <div
          className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700"
          data-testid="gs-result"
        >
          <p>
            Roster updated: <span className="font-medium">{result.roster.added} added</span>,{' '}
            <span className="font-medium">{result.roster.updated} updated</span>.
          </p>
          <p className="mt-1">
            No provenance bundles were found in this export, so no submissions were queued.
          </p>
          {/* `skipped` is null when the server does not yet know — the chunked
              upload route answers 202 before staging runs. Only a non-null
              array is a statement about what was skipped; null means "poll the
              job", and rendering it as zero would repeat the very claim the
              server stopped making. */}
          {result.skipped !== null && result.skipped.length > 0 && (
            <p className="mt-1 text-gray-500">
              {result.skipped.length} submission folder(s) skipped (no recorded bundle).
            </p>
          )}
        </div>
      )}

      <button
        type="submit"
        disabled={isPending || file === null || validationError !== null || !semesterId}
        className="mt-4 rounded-md bg-orange-700 px-4 py-2 text-sm text-white hover:bg-orange-800 disabled:opacity-50"
        data-testid="gs-upload-button"
      >
        {isPending ? 'Uploading…' : 'Upload Gradescope export'}
      </button>
    </form>
  );
}
