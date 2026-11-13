/**
 * IngestStartView — multi-file drop zone + upload progress.
 *
 * Route: /s/:courseSlug/:semesterSlug/ingest
 *
 * - Drag-and-drop or click to select .zip files.
 * - Validates all selected files are .zip.
 * - POSTs via XMLHttpRequest (so we get upload progress).
 * - On 202, navigates to /s/:courseSlug/:semesterSlug/ingest/jobs/:jobId.
 */

import { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStartIngest } from '../../api/queries.js';
import { useActiveSemester } from '../../api/use-active-semester.js';
import { ApiError } from '../../api/client.js';
import { GradescopeUpload } from './GradescopeUpload.js';

export function IngestStartView() {
  const navigate = useNavigate();

  const { semesterId, basePath } = useActiveSemester();

  const { mutate: startIngest, isPending } = useStartIngest(semesterId);

  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  function validateFiles(selectedFiles: File[]): string | null {
    const nonZip = selectedFiles.filter((f) => !f.name.endsWith('.zip'));
    if (nonZip.length > 0) {
      return `All files must be .zip archives. Invalid: ${nonZip.map((f) => f.name).join(', ')}`;
    }
    if (selectedFiles.length === 0) return 'No files selected.';
    return null;
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    const err = validateFiles(selected);
    setValidationError(err);
    setFiles(selected);
    setUploadError(null);
  }

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = Array.from(e.dataTransfer.files);
    const err = validateFiles(dropped);
    setValidationError(err);
    setFiles(dropped);
    setUploadError(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (validationError || files.length === 0 || !semesterId) return;

    setUploadProgress(0);
    setUploadError(null);

    startIngest(
      {
        files,
        onProgress: (pct) => setUploadProgress(pct),
      },
      {
        onSuccess: (data) => {
          void navigate(`${basePath}/ingest/jobs/${data.job_id}`);
        },
        onError: (err) => {
          setUploadProgress(null);
          if (err instanceof ApiError) {
            setUploadError(err.message);
          } else if (err instanceof Error) {
            setUploadError(err.message);
          } else {
            setUploadError('Upload failed. Please try again.');
          }
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-6 text-xl font-semibold text-gray-900">Upload Submissions</h1>

      {/* Primary path: Gradescope export (populates the roster + all bundles). */}
      <section className="mb-8" data-testid="gradescope-section">
        <h2 className="mb-1 text-sm font-medium text-gray-900">
          Gradescope export <span className="text-berkeley-700">(recommended)</span>
        </h2>
        <p className="mb-3 text-xs text-gray-500">
          Upload the ZIP from Gradescope’s “Download Submissions” — the roster and every student
          bundle are processed in one step.
        </p>
        <GradescopeUpload basePath={basePath} semesterId={semesterId} />
      </section>

      {/* Secondary path: direct bundle .zip upload (requires an existing roster). */}
      <section className="border-t border-gray-200 pt-6" data-testid="bundles-section">
        <h2 className="mb-1 text-sm font-medium text-gray-900">Bundle .zip files</h2>
        <p className="mb-3 text-xs text-gray-500">
          Upload sealed bundle <span className="font-medium">.zip</span> files directly (or a
          zip-of-zips). Requires the roster to be uploaded already.
        </p>

        <form onSubmit={handleSubmit}>
          {/* Drop zone */}
          <div
            role="button"
            tabIndex={0}
            data-testid="drop-zone"
            className={`flex flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-12 transition-colors ${
              isDragOver
                ? 'border-berkeley-500 bg-berkeley-50'
                : 'border-gray-300 bg-gray-50 hover:border-gray-400'
            }`}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
            }}
          >
            <p className="text-sm text-gray-600">
              Drag and drop <span className="font-medium">.zip</span> files here, or click to select
            </p>
            <p className="mt-1 text-xs text-gray-400">
              You can upload a zip-of-zips (one outer archive containing many student bundles)
            </p>
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            multiple
            className="hidden"
            onChange={handleFileChange}
            data-testid="file-input"
          />

          {/* Selected files list */}
          {files.length > 0 && (
            <ul className="mt-3 space-y-1" data-testid="selected-files">
              {files.map((f, i) => (
                <li key={i} className="flex items-center gap-2 text-xs text-gray-700">
                  <span className="font-mono">{f.name}</span>
                  <span className="text-gray-400">({(f.size / 1024).toFixed(1)} KB)</span>
                </li>
              ))}
            </ul>
          )}

          {/* Validation error */}
          {validationError && (
            <p className="mt-2 text-xs text-red-600" data-testid="validation-error">
              {validationError}
            </p>
          )}

          {/* Upload progress */}
          {uploadProgress !== null && (
            <div className="mt-4" data-testid="upload-progress">
              <div className="flex justify-between text-xs text-gray-600 mb-1">
                <span>Uploading…</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="h-2 w-full rounded-full bg-gray-200">
                <div
                  className="h-2 rounded-full bg-berkeley-700 transition-all"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          {/* Upload error */}
          {uploadError && (
            <p className="mt-2 text-xs text-red-600" data-testid="upload-error">
              {uploadError}
            </p>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={isPending || files.length === 0 || validationError !== null || !semesterId}
            className="mt-4 rounded-md bg-berkeley-700 px-4 py-2 text-sm text-white hover:bg-berkeley-800 disabled:opacity-50"
            data-testid="upload-button"
          >
            {isPending
              ? 'Uploading…'
              : `Upload ${files.length > 0 ? `${files.length} file(s)` : ''}`}
          </button>
        </form>
      </section>
    </div>
  );
}
