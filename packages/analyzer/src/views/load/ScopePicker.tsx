/**
 * ScopePicker — which recording(s) in a dropped repo should be analyzed?
 *
 * Rendered by LoadView when the bundle context is in its 'choosing' phase,
 * which happens only when a dropped file turned out to be a git repo holding
 * more than one sealed `.provenance/` scope. A flat sealed bundle, and a repo
 * holding exactly one recording, never reach here — there is no question to
 * ask, and the load path for those is unchanged.
 *
 * It takes no props: the pending choice, the confirm and the cancel all come
 * from `useBundle()`, so there is no second way to drive it that production
 * does not use.
 */

import { useCallback, useState } from 'react';
import { useBundle, scopeSelectionKey } from '../../context/BundleContext.js';
import type { ScopeCandidate } from '../../lib/inspect-dropped-files.js';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card.js';
import { Button } from '../../components/ui/button.js';

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The root scope has no directory name; `/` is how a repo root reads. */
function displayPath(scopePath: string): string {
  return scopePath === '' ? '/' : scopePath;
}

const EM_DASH = '—';

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function ScopeRow({
  candidate,
  checked,
  onToggle,
}: {
  candidate: ScopeCandidate;
  checked: boolean;
  onToggle: () => void;
}) {
  const disabled = !candidate.selectable;
  const inputId = `scope-${candidate.scopePath === '' ? 'root' : candidate.scopePath}`;

  return (
    <label
      data-testid={`scope-row-${candidate.scopePath === '' ? 'root' : candidate.scopePath}`}
      htmlFor={inputId}
      className={[
        'flex items-start gap-3 rounded-md border p-3 transition-colors',
        disabled
          ? 'cursor-not-allowed border-muted bg-muted/30 opacity-60'
          : 'cursor-pointer border-input hover:bg-accent',
      ].join(' ')}
    >
      <input
        id={inputId}
        type="checkbox"
        className="mt-1 h-4 w-4"
        checked={checked}
        disabled={disabled}
        onChange={onToggle}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-sm font-medium">{displayPath(candidate.scopePath)}</span>
          <span className="text-sm text-muted-foreground">
            {candidate.declaredAssignmentId ?? EM_DASH}
          </span>
          {candidate.declaredSemester !== null && (
            <span className="text-xs text-muted-foreground">{candidate.declaredSemester}</span>
          )}
        </div>
        {disabled ? (
          <p className="text-xs text-muted-foreground">not sealed {EM_DASH} no manifest</p>
        ) : (
          <p className="text-xs text-muted-foreground">
            {candidate.sessionCount} session{candidate.sessionCount === 1 ? '' : 's'}
            {' · '}
            {/* Tilde is load-bearing: this is an NDJSON line count, not a
                parsed event count. See ScopeCandidate.approxEventCount. */}
            ~{candidate.approxEventCount} events
            {' · '}
            {formatBytes(candidate.totalBytes)}
          </p>
        )}
      </div>
    </label>
  );
}

// ---------------------------------------------------------------------------
// ScopePicker
// ---------------------------------------------------------------------------

export function ScopePicker() {
  const { pendingScopes, chooseScopes, cancelChoice } = useBundle();
  // Nothing is pre-selected: analyzing a recording is a deliberate act, and a
  // default selection would quietly make one for the user.
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = useCallback((key: string) => {
    setSelected((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }, []);

  const onConfirm = useCallback(() => {
    void chooseScopes(selected);
  }, [chooseScopes, selected]);

  if (pendingScopes === null) return null;

  const multipleFiles = pendingScopes.groups.length > 1;

  return (
    <Card data-testid="scope-picker" className="w-full max-w-2xl">
      <CardHeader>
        <CardTitle>Which recording do you want to analyze?</CardTitle>
        <p className="text-sm text-muted-foreground">
          This archive is a repository, not a single sealed bundle. Pick one or more assignment
          recordings; choosing two or more also enables the cross-submission comparison.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {pendingScopes.groups.map((group) => (
          <div key={group.stem} className="space-y-2">
            {multipleFiles && (
              <h3 className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
                {group.stem}
              </h3>
            )}
            {group.candidates.map((candidate) => {
              const key = scopeSelectionKey(group.stem, candidate.scopePath);
              return (
                <ScopeRow
                  key={key}
                  candidate={candidate}
                  checked={selected.includes(key)}
                  onToggle={() => toggle(key)}
                />
              );
            })}
          </div>
        ))}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={cancelChoice} data-testid="cancel-choice">
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={selected.length === 0}
            data-testid="analyze-selected"
          >
            Analyze selected
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
