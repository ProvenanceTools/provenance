/**
 * FileTabs — one tab per file under review in the replay view.
 *
 * Clicking a tab calls onFileChange(filePath), which switches the Monaco model
 * in the parent ReplayView.
 *
 * Because replay spans the whole bundle, this lists EVERY file in the
 * submission, not just the ones touched in the session the playhead is in — a
 * file edited in session 1 and left alone in session 2 is still part of the
 * work and its content is still reconstructable. To keep that from being
 * misleading, each tab carries a last-edited badge, and files with no activity
 * in the current session render dimmed.
 *
 * Displays only the filename (basename) to keep tabs short; full path is shown
 * in the aria-label for accessibility.
 */

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js';
import { cn } from '@/lib/utils';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import { computeFileRecency, formatRecency, type FileRecency } from './file-recency.js';
import { byRelevance, splitTabs } from './tab-overflow.js';

type FileTabsProps = {
  /** Ordered list of files under review (from engine.getFiles() — whole bundle). */
  files: string[];
  /** Currently selected file path. */
  activeFile: string | null;
  /** Called when the user clicks a tab. */
  onFileChange(filePath: string): void;
  /** Whole-bundle index, for resolving each file's last edit. */
  index?: EventIndex | undefined;
  /** Playhead position, as a globalIdx. */
  currentGlobalIdx?: number | undefined;
  /** The session the playhead is currently inside. */
  currentSessionId?: string | undefined;
};

function basename(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

function dirname(filePath: string): string {
  const i = filePath.lastIndexOf('/');
  return i <= 0 ? '' : filePath.slice(0, i);
}

/** Tab gap (`gap-1`) in px, counted into each measured tab width. */
const TAB_GAP = 4;
/** Room kept for the "+N files" button when anything overflows. */
const MORE_BUTTON_WIDTH = 104;

/** Shared by the real tab and its off-screen measuring twin so widths agree. */
const TAB_CLASS = 'h-7 px-2 py-1 text-xs';

function TabLabel({ filePath, badge }: { filePath: string; badge: string | null }) {
  return (
    <>
      {basename(filePath)}
      {badge !== null && (
        <span
          className="ml-1.5 text-[10px] font-normal text-muted-foreground"
          data-testid={`file-tab-recency-${filePath}`}
        >
          {badge}
        </span>
      )}
    </>
  );
}

export function FileTabs({
  files,
  activeFile,
  onFileChange,
  index,
  currentGlobalIdx,
  currentSessionId,
}: FileTabsProps) {
  const selected = activeFile ?? files[0] ?? '';

  // Recency per file at the playhead (null when no index is supplied).
  const recency = useMemo(() => {
    const m = new Map<string, FileRecency | null>();
    for (const f of files) {
      m.set(
        f,
        index !== undefined && currentGlobalIdx !== undefined && currentSessionId !== undefined
          ? computeFileRecency(index, f, currentGlobalIdx, currentSessionId)
          : null,
      );
    }
    return m;
  }, [files, index, currentGlobalIdx, currentSessionId]);
  const badgeOf = (f: string): string | null => {
    const r = recency.get(f) ?? null;
    return r !== null ? formatRecency(r) : null;
  };

  // --- Measurement: every tab is rendered once off-screen to learn its width;
  // the visible row then shows the most relevant tabs that fit (tab-overflow.ts).
  const rowRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [available, setAvailable] = useState(0);
  const [widths, setWidths] = useState<ReadonlyMap<string, number>>(new Map());

  useLayoutEffect(() => {
    const el = measureRef.current;
    if (el === null) return;
    const next = new Map<string, number>();
    for (const child of Array.from(el.children)) {
      const path = (child as HTMLElement).dataset['path'];
      if (path === undefined) continue;
      const w = (child as HTMLElement).offsetWidth;
      next.set(path, w > 0 ? w + TAB_GAP : 0); // 0 = unmeasured (jsdom)
    }
    setWidths((prev) => {
      if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev;
      return next;
    });
  });

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (el === null) return;
    setAvailable(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setAvailable(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ranked = useMemo(
    () => byRelevance(files, selected, (f) => recency.get(f) ?? null),
    [files, selected, recency],
  );
  const { visible, overflow } = splitTabs(
    files,
    ranked,
    (f) => widths.get(f) ?? 0,
    available,
    MORE_BUTTON_WIDTH,
  );

  if (files.length === 0) {
    return (
      <div className="text-xs text-muted-foreground px-2 py-1" data-testid="file-tabs-empty">
        No files
      </div>
    );
  }

  // Overflow menu groups, in relevance order (overflow is already ranked).
  const groups: Array<{ label: string; items: string[] }> = [
    {
      label: 'Edited this session',
      items: overflow.filter((f) => recency.get(f)?.state === 'current-session'),
    },
    {
      label: 'Edited in earlier sessions',
      items: overflow.filter((f) => recency.get(f)?.state === 'earlier-session'),
    },
    {
      label:
        recency.size > 0 && [...recency.values()].some((r) => r !== null)
          ? 'Not edited yet'
          : 'Files',
      items: overflow.filter((f) => {
        const r = recency.get(f) ?? null;
        return r === null || r.state === 'untouched';
      }),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <div ref={rowRef} className="relative flex min-w-0 items-center gap-1">
      {/* Off-screen measuring row: same classes, every file, no roles/testids. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute left-0 top-0 flex h-0 gap-1 overflow-hidden whitespace-nowrap"
      >
        {files.map((f) => (
          <span
            key={f}
            data-path={f}
            className={cn(
              'inline-flex items-center whitespace-nowrap rounded-sm font-medium',
              TAB_CLASS,
            )}
          >
            {basename(f)}
            {badgeOf(f) !== null && (
              <span className="ml-1.5 text-[10px] font-normal">{badgeOf(f)}</span>
            )}
          </span>
        ))}
      </div>

      <Tabs
        value={selected}
        onValueChange={onFileChange}
        data-testid="file-tabs"
        className="min-w-0"
      >
        <TabsList className="h-auto flex-nowrap gap-1 overflow-hidden bg-transparent p-0">
          {visible.map((filePath) => {
            const r = recency.get(filePath) ?? null;
            const badge = badgeOf(filePath);
            // Dim anything with no activity in the session the playhead is in,
            // so stale tabs don't read as active work.
            const isStale = r !== null && r.state !== 'current-session';

            return (
              <TabsTrigger
                key={filePath}
                value={filePath}
                aria-label={filePath}
                className={cn(TAB_CLASS, isStale && 'opacity-50')}
                title={
                  isStale && badge !== null
                    ? `${filePath} — not edited in this session (last edited ${badge})`
                    : filePath
                }
                data-testid={`file-tab-${filePath}`}
                data-stale={isStale ? 'true' : undefined}
              >
                <TabLabel filePath={filePath} badge={badge} />
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>

      {overflow.length > 0 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center gap-1 whitespace-nowrap rounded-sm border border-input px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`${overflow.length} more files`}
              data-testid="file-tabs-more"
            >
              +{overflow.length} {overflow.length === 1 ? 'file' : 'files'}
              <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-[60vh] w-80 overflow-y-auto">
            {groups.map((g, gi) => (
              <div key={g.label}>
                {gi > 0 && <DropdownMenuSeparator />}
                <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                  {g.label}
                </DropdownMenuLabel>
                {g.items.map((f) => (
                  <DropdownMenuItem
                    key={f}
                    onSelect={() => onFileChange(f)}
                    className="flex items-baseline justify-between gap-3"
                    data-testid={`file-menu-item-${f}`}
                  >
                    <span className="min-w-0 truncate">
                      <span className="text-sm">{basename(f)}</span>
                      {dirname(f) !== '' && (
                        <span className="ml-1.5 text-xs text-muted-foreground">{dirname(f)}</span>
                      )}
                    </span>
                    {badgeOf(f) !== null && (
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {badgeOf(f)}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
              </div>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
