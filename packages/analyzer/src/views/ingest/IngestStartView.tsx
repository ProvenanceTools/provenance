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
import { UploadCloud } from 'lucide-react';
import { PageContainer, PageHeader, Panel } from '@/components/layout/Page';
import { Button } from '@/components/ui/button';
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
    <PageContainer>
      <PageHeader
        title="Upload Submissions"
        description="Add student submissions to this semester, either from a Gradescope export or as sealed bundle .zip files."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Primary path: Gradescope export (populates the roster + all bundles). */}
        <Panel
          data-testid="gradescope-section"
          title={
            <span className="flex flex-wrap items-center gap-2">
              Gradescope export
              <span className="inline-flex items-center rounded-full border border-berkeley-200 bg-berkeley-50 px-2.5 py-0.5 text-xs font-medium text-berkeley-700">
                Recommended
              </span>
            </span>
          }
          description="Upload the ZIP from Gradescope’s “Download Submissions” — the roster and every student bundle are processed in one step."
        >
          <GradescopeUpload basePath={basePath} semesterId={semesterId} />
        </Panel>

        {/* Secondary path: direct bundle .zip upload (requires an existing roster). */}
        <Panel
          data-testid="bundles-section"
          title="Bundle .zip files"
          description={
            <>
              Upload sealed bundle <span className="font-medium">.zip</span> files directly (or a
              zip-of-zips). Requires the roster to be uploaded already.
            </>
          }
        >
          <form onSubmit={handleSubmit}>
            {/* Drop zone */}
            <div
              role="button"
              tabIndex={0}
              data-testid="drop-zone"
              className={`flex flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors ${
                isDragOver
                  ? 'border-berkeley-500 bg-berkeley-50'
                  : 'border-gray-300 bg-gray-50/60 hover:border-berkeley-300 hover:bg-berkeley-50/40'
              }`}
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
              }}
            >
              <UploadCloud className="mb-1 h-6 w-6 text-gray-400" aria-hidden />
              <p className="text-sm text-gray-700">
                Drag and drop <span className="font-medium">.zip</span> files here, or click to
                select
              </p>
              <p className="text-xs text-muted-foreground">
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
                    <span className="text-muted-foreground">({(f.size / 1024).toFixed(1)} KB)</span>
                  </li>
                ))}
              </ul>
            )}

            {/* Validation error */}
            {validationError && (
              <p className="mt-3 text-xs text-red-600" data-testid="validation-error">
                {validationError}
              </p>
            )}

            {/* Upload progress */}
            {uploadProgress !== null && (
              <div className="mt-4" data-testid="upload-progress">
                <div className="mb-1 flex justify-between text-xs text-gray-600">
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
              <p className="mt-3 text-xs text-red-600" data-testid="upload-error">
                {uploadError}
              </p>
            )}

            {/* Submit */}
            <div className="mt-4 flex justify-end">
              <Button
                type="submit"
                size="sm"
                disabled={
                  isPending || files.length === 0 || validationError !== null || !semesterId
                }
                data-testid="upload-button"
              >
                {isPending
                  ? 'Uploading…'
                  : `Upload ${files.length > 0 ? `${files.length} file(s)` : ''}`}
              </Button>
            </div>
          </form>
        </Panel>
      </div>
    </PageContainer>
  );
}
