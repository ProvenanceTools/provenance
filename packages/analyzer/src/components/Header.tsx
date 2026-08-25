/**
 * Header — bundle info, bundle switcher, "Load more bundles" button, "Load different bundle".
 *
 * v2 Phase 11:
 * - When bundles.length >= 2, a bundle switcher dropdown appears in the centre.
 *   Selecting an item calls selectBundle(id), updating all single-bundle consumers
 *   transparently (index, validationReport, flags derived scalars update automatically).
 * - "Load more bundles" button appears when bundles.length >= 1. Clicking it opens
 *   a hidden multi-file <input> that appends to the existing list (does NOT clear).
 * - "Load different bundle" clears all state and navigates to /load.
 *
 * Hidden when no bundle is loaded (bundles.length === 0).
 *
 * NOTE: all hooks must be declared before any early returns (React rule of hooks).
 */

import { useRef, useCallback, useState } from 'react';
import { useNavigate, NavLink } from 'react-router-dom';
import { ChevronDown, X } from 'lucide-react';
import { useBundle } from '../context/BundleContext.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu.js';
import type { BlobLoadError } from '@provenance/analysis-core/loader/parse-bundle.js';
import type { DroppedArtifact } from '@provenance/analysis-core/loader/types.js';

// ---------------------------------------------------------------------------
// PartialLoadErrorBanner — shown in header when some files failed to load.
// ---------------------------------------------------------------------------

/** Formats a BlobLoadError.error.kind into a short human-readable label. */
function errorLabel(err: BlobLoadError): string {
  const { kind } = err.error;
  switch (kind) {
    case 'not_a_zip':
      return 'not a ZIP file';
    case 'missing_manifest':
      return 'missing manifest';
    case 'invalid_manifest':
      return 'invalid manifest';
    case 'missing_signature':
      return 'missing signature';
    case 'no_sessions':
      return 'no sessions found';
    case 'orphaned_meta':
    case 'orphaned_slog':
      return 'orphaned session file';
    case 'unexpected_file':
      return 'unexpected file in archive';
    case 'ndjson_parse_failed':
      return 'session parse error';
    case 'meta_invalid_shape':
      return 'session meta invalid';
    case 'first_event_not_session_start':
      return 'first event not session start';
    case 'session_id_mismatch':
      return 'session id mismatch';
    case 'unknown_failure':
      return 'unexpected error';
    default: {
      const _exhaustive: never = kind;
      return String(_exhaustive);
    }
  }
}

interface PartialLoadErrorBannerProps {
  errors: BlobLoadError[];
  onDismiss: () => void;
}

function PartialLoadErrorBanner({ errors, onDismiss }: PartialLoadErrorBannerProps) {
  if (errors.length === 0) return null;
  return (
    <div
      data-testid="partial-load-error-banner"
      role="alert"
      className="flex items-start gap-2 rounded border border-amber-400 bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-200"
    >
      <span className="flex-1">
        <strong>
          {errors.length} bundle{errors.length > 1 ? 's' : ''} failed to load:
        </strong>{' '}
        {errors.map((e) => `${e.filename} (${errorLabel(e)})`).join(', ')}
      </span>
      <button
        data-testid="partial-load-error-dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="ml-2 shrink-0 text-amber-700 hover:text-amber-900 dark:text-amber-400 dark:hover:text-amber-200"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IncompleteRecordingBanner — artifacts the loader could not analyse.
//
// The reporting half of the read-side orphan guard. `analysis-core`'s loader no
// longer fails a whole submission over a leftover `.slog.meta`, a zero-byte
// `.slog`, a quarantined `.corrupt-*` log or an orphaned rolling seal — it drops
// them and records them on `bundle.droppedArtifacts`. That is only the right
// trade if the drop is VISIBLE: a silent exclusion is worse than the hard error
// it replaced, because nobody can tell that anything was left out.
//
// Deliberately worded and coloured as an INCOMPLETE RECORDING, not a finding.
// These artifacts are the ordinary residue of a crash on the git path, where no
// seal step runs to filter them, and a grader must not read them as tampering.
// Nothing here is a Flag and nothing here fails a check.
// ---------------------------------------------------------------------------

interface IncompleteRecordingBannerProps {
  artifacts: readonly DroppedArtifact[];
  onDismiss: () => void;
}

function IncompleteRecordingBanner({ artifacts, onDismiss }: IncompleteRecordingBannerProps) {
  if (artifacts.length === 0) return null;
  return (
    <div
      data-testid="incomplete-recording-banner"
      role="status"
      className="flex items-start gap-2 rounded border border-slate-400 bg-slate-50 px-4 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200"
    >
      <span className="flex-1">
        <strong>
          Incomplete recording: {artifacts.length} file{artifacts.length > 1 ? 's' : ''} in this
          submission could not be analysed.
        </strong>{' '}
        The sessions shown below were analysed in full. This is not an integrity finding — it
        usually means a session ended abruptly and the recorder left an artifact behind.{' '}
        {artifacts.map((a) => a.filename).join(', ')}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss incomplete recording notice"
        data-testid="incomplete-recording-dismiss"
        className="ml-2 shrink-0 text-slate-700 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export function Header() {
  const {
    bundles,
    selectedBundleId,
    selectBundle,
    clearBundle,
    loadBundleFiles,
    partialLoadErrors,
  } = useBundle();
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [droppedDismissed, setDroppedDismissed] = useState(false);
  const navigate = useNavigate();
  const loadMoreInputRef = useRef<HTMLInputElement>(null);

  // All hooks must appear before any conditional returns.

  const handleLoadDifferent = useCallback(() => {
    clearBundle();
    void navigate('/local/load');
  }, [clearBundle, navigate]);

  const handleLoadMoreClick = useCallback(() => {
    loadMoreInputRef.current?.click();
  }, []);

  const handleLoadMoreChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) {
        // Un-dismiss so any new partial errors become visible.
        setBannerDismissed(false);
        setDroppedDismissed(false);
        void loadBundleFiles(files);
      }
      // Reset so the same file(s) can be re-selected if needed.
      e.target.value = '';
    },
    [loadBundleFiles],
  );

  // Hidden when no bundle is loaded.
  if (bundles.length === 0) {
    return null;
  }

  const selectedBundle = bundles.find((b) => b.id === selectedBundleId) ?? bundles[0]!;
  const showBanner = partialLoadErrors.length > 0 && !bannerDismissed;
  // Scoped to the SELECTED bundle: a dropped artifact belongs to one submission,
  // and attributing it to whichever bundle happens to be on screen would be a
  // way of implying something about a student who did nothing.
  const droppedArtifacts = selectedBundle.droppedArtifacts;
  const showDropped = droppedArtifacts.length > 0 && !droppedDismissed;

  return (
    <header data-testid="header" className="sticky top-0 z-10 flex flex-col border-b bg-background">
      {showBanner && (
        <div className="px-6 pt-2">
          <PartialLoadErrorBanner
            errors={partialLoadErrors}
            onDismiss={() => setBannerDismissed(true)}
          />
        </div>
      )}
      {showDropped && (
        <div className="px-6 pt-2">
          <IncompleteRecordingBanner
            artifacts={droppedArtifacts}
            onDismiss={() => setDroppedDismissed(true)}
          />
        </div>
      )}
      <div className="flex items-center justify-between px-6 py-3 gap-4">
        {/* Left: selected bundle info */}
        <div className="flex items-center gap-4 min-w-0 flex-1">
          {bundles.length === 1 ? (
            /* Single bundle: show filename + assignment inline */
            <div className="min-w-0">
              <p
                data-testid="header-filename"
                className="truncate text-sm font-semibold"
                title={selectedBundle.sourceFilename}
              >
                {selectedBundle.sourceFilename}
              </p>
              <p data-testid="header-assignment-id" className="text-xs text-muted-foreground">
                Assignment: {selectedBundle.manifest.assignment_id}
              </p>
            </div>
          ) : (
            /* Multiple bundles: show a switcher dropdown */
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex items-center gap-2 h-auto py-1 px-2 min-w-0"
                  data-testid="bundle-switcher-trigger"
                  aria-label="Switch active bundle"
                >
                  <div className="min-w-0 text-left">
                    <p
                      className="truncate text-sm font-semibold max-w-[200px]"
                      title={selectedBundle.sourceFilename}
                    >
                      {selectedBundle.sourceFilename}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Assignment: {selectedBundle.manifest.assignment_id}
                    </p>
                  </div>
                  <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-80">
                <DropdownMenuLabel>{bundles.length} bundles loaded</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {bundles.map((b) => (
                  <DropdownMenuItem
                    key={b.id}
                    onSelect={() => selectBundle(b.id)}
                    data-testid={`bundle-option-${b.id}`}
                    className="flex flex-col items-start gap-0.5 py-2"
                  >
                    <span className="font-medium truncate max-w-full" title={b.sourceFilename}>
                      {b.sourceFilename}
                      {b.id === selectedBundleId && (
                        <span className="ml-2 text-xs text-muted-foreground">(active)</span>
                      )}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {b.manifest.assignment_id} · {b.sessions.length}{' '}
                      {b.sessions.length === 1 ? 'session' : 'sessions'}
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <Badge variant="secondary" data-testid="header-session-count">
            {selectedBundle.sessions.length}{' '}
            {selectedBundle.sessions.length === 1 ? 'session' : 'sessions'}
          </Badge>

          {bundles.length > 1 && (
            <Badge variant="outline" data-testid="header-bundle-count">
              {bundles.length} bundles
            </Badge>
          )}
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2 shrink-0">
          {/* "Load more bundles" — visible when at least one bundle is loaded */}
          <Button
            variant="outline"
            size="sm"
            onClick={handleLoadMoreClick}
            data-testid="header-load-more-btn"
          >
            Load more bundles
          </Button>

          {/* Hidden multi-file input for "Load more bundles" */}
          <input
            ref={loadMoreInputRef}
            type="file"
            accept=".zip,application/zip"
            multiple
            className="hidden"
            data-testid="header-load-more-input"
            onChange={handleLoadMoreChange}
            aria-label="Choose additional bundle files"
          />

          <Button
            variant="outline"
            size="sm"
            onClick={handleLoadDifferent}
            data-testid="header-load-different-btn"
          >
            Load different bundle
          </Button>
        </div>
      </div>

      {/* Nav links row: pill-style links between views. Desktop only. */}
      <nav
        className="flex items-center gap-1 border-t px-6 py-1.5 text-sm"
        aria-label="Primary navigation"
        data-testid="header-nav"
      >
        <NavLink
          to="/local/overview"
          data-testid="nav-link-overview"
          className={({ isActive }) =>
            `rounded-md px-3 py-1 transition-colors ${
              isActive
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            }`
          }
        >
          Overview
        </NavLink>
        <NavLink
          to="/local/timeline"
          data-testid="nav-link-timeline"
          className={({ isActive }) =>
            `rounded-md px-3 py-1 transition-colors ${
              isActive
                ? 'bg-accent text-accent-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
            }`
          }
        >
          Raw timeline
        </NavLink>
        {bundles.length >= 2 && (
          <NavLink
            to="/local/compare"
            data-testid="nav-link-compare"
            className={({ isActive }) =>
              `rounded-md px-3 py-1 transition-colors ${
                isActive
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
              }`
            }
          >
            Compare
          </NavLink>
        )}
      </nav>
    </header>
  );
}
