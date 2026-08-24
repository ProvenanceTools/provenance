/**
 * LoadView — full-screen drop zone with file-picker fallback.
 *
 * Drag-and-drop uses native HTML5 events (no lib). The file picker is a
 * hidden <input type="file"> activated by the "Choose file" button.
 *
 * On status === 'loaded', navigates to /local/overview via useEffect so the
 * navigation is decoupled from the async load pipeline.
 *
 * Phase 25: this view is now mounted under /local/load; navigation uses the
 * /local prefix so it works correctly within the LocalShell subtree.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBundle } from '../../context/BundleContext.js';
import { LoadingPanel } from './LoadingPanel.js';
import { ErrorPanel } from './ErrorPanel.js';
import { ScopePicker } from './ScopePicker.js';
import { Card, CardContent } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';

export function LoadView() {
  const { status, loadingStage, loadError, pendingScopes, beginLoad, clearBundle } = useBundle();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Navigate to /local/overview once a bundle is successfully loaded.
  // The /local prefix matches the LocalShell subtree mounted in App.tsx (Phase 25).
  useEffect(() => {
    if (status === 'loaded') {
      void navigate('/local/overview', { replace: true });
    }
  }, [status, navigate]);

  // ---------------------------------------------------------------------------
  // File handling — accepts one or more files
  // ---------------------------------------------------------------------------

  // beginLoad, not loadBundleFiles: a dropped file may be a repo holding
  // several recordings, and that question has to be asked before the loader
  // runs. For a flat sealed bundle beginLoad forwards straight through, so
  // this path is unchanged for every existing workflow.
  const handleFiles = useCallback(
    (files: File[]) => {
      if (files.length > 0) {
        void beginLoad(files);
      }
    },
    [beginLoad],
  );

  // ---------------------------------------------------------------------------
  // Drag-and-drop handlers (multi-file)
  // ---------------------------------------------------------------------------

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      handleFiles(files);
    },
    [handleFiles],
  );

  // ---------------------------------------------------------------------------
  // File picker handler (multi-file)
  // ---------------------------------------------------------------------------

  const onFilePickerChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      handleFiles(files);
      // Reset the input so the same file can be re-selected after clearing.
      e.target.value = '';
    },
    [handleFiles],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // ---------------------------------------------------------------------------
  // Retry: clear error state and allow a new drop.
  // ---------------------------------------------------------------------------

  const handleRetry = useCallback(() => {
    clearBundle();
  }, [clearBundle]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  if (status === 'loading') {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background">
        <LoadingPanel stage={loadingStage} />
      </div>
    );
  }

  if (status === 'choosing' && pendingScopes !== null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-8">
        <ScopePicker />
      </div>
    );
  }

  if (status === 'error' && loadError !== null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background p-8">
        <ErrorPanel error={loadError} onRetry={handleRetry} />
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background p-8">
      <div className="w-full max-w-lg space-y-6">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Provenance Analyzer</h1>
          <p className="text-muted-foreground">
            Drop a submission bundle to inspect the recording.
          </p>
        </div>

        {/* Drop zone */}
        <Card
          data-testid="drop-zone"
          className={[
            'cursor-pointer border-2 border-dashed transition-colors',
            isDragOver
              ? 'border-primary bg-accent'
              : 'border-muted-foreground/30 hover:border-primary/60',
          ].join(' ')}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onClick={openFilePicker}
          role="button"
          tabIndex={0}
          aria-label="Drop zone — click or drag .zip bundle(s) here"
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') openFilePicker();
          }}
        >
          <CardContent className="flex flex-col items-center gap-4 py-16">
            <svg
              aria-hidden="true"
              className="h-12 w-12 text-muted-foreground"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
            <div className="text-center">
              <p className="text-base font-medium">Drop your .zip bundle(s) here</p>
              <p className="text-sm text-muted-foreground mt-1">
                or click to choose one or more files
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Hidden file input — multiple to support batch loading */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          multiple
          className="hidden"
          data-testid="file-input"
          onChange={onFilePickerChange}
          aria-label="Choose bundle file(s)"
        />

        <div className="flex justify-center">
          <Button variant="outline" onClick={openFilePicker} data-testid="choose-file-btn">
            Choose file
          </Button>
        </div>
      </div>
    </div>
  );
}
