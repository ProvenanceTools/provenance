/**
 * EventSidebar — virtualized event log for the replay view.
 *
 * Auto-scrolls to keep the current event (currentGlobalIdx) visible as the
 * engine advances. Clicking a row calls `onSeek(event.globalIdx)`.
 *
 * Design:
 *   - Uses @tanstack/react-virtual (already a dep from Phase 7's EventList).
 *   - Row format is a one-liner: `#seq wall kind file? terminal-summary?` —
 *     narrower than the full timeline EventList (which also has a session chip).
 *   - Auto-scroll: when `currentGlobalIdx` changes, scroll to that index with
 *     align='center'. We track the last auto-scrolled index to avoid fighting
 *     the user's manual scroll (only re-scroll if the current event has moved).
 *   - Each row highlights when it matches `currentGlobalIdx`.
 *
 * Contributor marker (opt-in, lane mode only — split-replay-lanes design §4/§7,
 * `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`): pass
 * `contributorHueBySession` to paint a subdued left-edge colour bar on each
 * row, in that event's SESSION's lane hue — the same `contributor-palette.ts`
 * mapping `ReplayLanes`' header dot and `ContributorRibbons`' rows already
 * use, so one event reads the same colour everywhere it appears. This sidebar
 * still renders the WHOLE bundle's single interleaved stream (unlike the full
 * timeline's `EventList`, which also carries a session chip — see that
 * component's header for why this one doesn't); the marker exists because two
 * lanes on screen give a scrolled-away-from-the-seam row no other way to say
 * which lane it belongs to. Strictly opt-in and additive: the prop is omitted
 * outside lane mode (single-pane and solo submissions), and omitting it
 * renders byte-identical to before. A session absent from the map — no
 * contributor entry — gets no marker, never a default or fallback colour.
 *
 * PRD ref: §7.2 (scrolling sidebar event log).
 */

import { useRef, useEffect, useCallback, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';
import { formatWall, summarizeTerminalCommand } from '@/lib/format.js';
import { formatGap, type Seam } from './bundle-clock.js';

// ---------------------------------------------------------------------------
// Row height (narrower than EventList; 36px to fit wall + optional summary)
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 36;

/** Seam dividers are taller — they carry a label and the offline duration. */
const SEAM_ROW_HEIGHT = 44;

/** A rendered row: either an event or a session boundary before one. */
type Row = { type: 'event'; event: IndexedEvent } | { type: 'seam'; seam: Seam };

// ---------------------------------------------------------------------------
// Kind chip (compact)
// ---------------------------------------------------------------------------

const KIND_CHIP_CLASSES: Partial<Record<EventKind, string>> = {
  paste: 'bg-orange-100 text-orange-700',
  'paste.anomaly': 'bg-orange-100 text-orange-700',
  'fs.external_change': 'bg-red-100 text-red-700',
  'chain.broken': 'bg-red-100 text-red-700',
  'session.start': 'bg-blue-100 text-blue-700',
  'session.end': 'bg-blue-100 text-blue-700',
  'terminal.command': 'bg-purple-100 text-purple-700',
};

const DEFAULT_KIND_CHIP = 'bg-gray-100 text-gray-600';

/**
 * Determine the chip style + label for an event. Recorder v1.2 marks
 * paste-shaped bulk edits as `doc.change` with `source: 'paste_likely' |
 * 'paste_confirmed'` (PRD §4.3); render those with the paste color and a
 * trailing asterisk so they're visually grouped with native paste events.
 */
function chipFor(event: IndexedEvent): { className: string; label: string } {
  if (event.kind === 'doc.change') {
    const payload = event.payload as Record<string, unknown> | null;
    const source =
      payload !== null && typeof payload['source'] === 'string'
        ? (payload['source'] as string)
        : 'typed';
    if (source === 'paste_likely' || source === 'paste_confirmed') {
      return { className: KIND_CHIP_CLASSES.paste!, label: 'paste*' };
    }
  }
  return {
    className: KIND_CHIP_CLASSES[event.kind] ?? DEFAULT_KIND_CHIP,
    label: event.kind,
  };
}

function SidebarKindChip({ event }: { event: IndexedEvent }) {
  const { className, label } = chipFor(event);
  return (
    <span
      className={cn('shrink-0 rounded px-1 py-0.5 font-mono text-[9px] font-medium', className)}
      title={
        label === 'paste*'
          ? 'paste-shaped doc.change (recorder v1.2 broadened paste classifier — multi-delta or replacement edit)'
          : undefined
      }
    >
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sidebar row
// ---------------------------------------------------------------------------

interface SidebarRowProps {
  event: IndexedEvent;
  isCurrent: boolean;
  onSeek: (globalIdx: number) => void;
  style: React.CSSProperties;
  /**
   * This row's contributor lane hue, or undefined for "no marker" — either
   * lane mode is off, or this event's session has no contributor entry. See
   * `EventSidebar`'s header for why absence must never fall back to a
   * default colour.
   */
  contributorHue?: string | undefined;
}

function terminalSummary(event: IndexedEvent): { text: string; title: string } | null {
  if (event.kind !== 'terminal.command') return null;
  const payload = event.payload as Record<string, unknown> | null;
  const text = summarizeTerminalCommand(payload);
  if (!text) return null;
  const command =
    payload !== null && typeof payload['command'] === 'string' ? payload['command'] : text;
  return { text, title: command };
}

function SidebarRow({ event, isCurrent, onSeek, style, contributorHue }: SidebarRowProps) {
  const filePart = event.file ? (event.file.split('/').pop() ?? event.file) : '';
  const term = terminalSummary(event);

  return (
    <div
      style={style}
      role="button"
      tabIndex={0}
      className={cn(
        'absolute left-0 right-0 flex cursor-pointer items-center gap-1.5 border-b px-2 text-[11px] transition-colors hover:bg-accent/50 focus:outline-none focus:ring-1 focus:ring-ring',
        isCurrent && 'bg-accent font-medium',
      )}
      onClick={() => onSeek(event.globalIdx)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSeek(event.globalIdx);
        }
      }}
      data-testid={`sidebar-row-${event.globalIdx}`}
      data-global-idx={event.globalIdx}
      aria-current={isCurrent ? 'step' : undefined}
    >
      {/* Contributor lane marker — quiet left-edge colour bar, lane mode only.
          Absolutely positioned inside this row (itself `position: absolute`,
          so it's a containing block) rather than laid out in flow: it must
          never add width/height to the row, which the virtualizer sizes on
          (ROW_HEIGHT / SEAM_ROW_HEIGHT). Decorative only — aria-hidden. */}
      {contributorHue !== undefined && (
        <span
          aria-hidden="true"
          data-testid={`sidebar-row-contributor-${event.globalIdx}`}
          className="pointer-events-none absolute inset-y-0 left-0 w-[3px]"
          style={{ backgroundColor: contributorHue }}
        />
      )}

      {/* seq */}
      <span className="w-10 shrink-0 font-mono text-muted-foreground">#{event.seq}</span>

      {/* wall time */}
      <span className="w-[72px] shrink-0 font-mono text-[10px] text-muted-foreground">
        {formatWall(event.wall)}
      </span>

      {/* kind chip */}
      <SidebarKindChip event={event} />

      {/* file (basename only) */}
      {filePart && (
        <span className="min-w-0 truncate font-mono text-muted-foreground" title={event.file}>
          {filePart}
        </span>
      )}

      {term && (
        <span className="min-w-0 truncate text-foreground/80" title={term.title}>
          {term.text}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SeamDivider — a session boundary in the stream
// ---------------------------------------------------------------------------

/**
 * Marks the gap between one session ending and the next beginning.
 *
 * Shows the REAL offline duration (from Seam.realGapMs), not the collapsed
 * playback gap — the collapsed value is a playback detail and would misrepresent
 * how long the student was actually away.
 */
function SeamDivider({
  seam,
  isFlagged,
  style,
}: {
  seam: Seam;
  isFlagged: boolean;
  style: React.CSSProperties;
}) {
  return (
    <div
      style={style}
      className={cn(
        'absolute left-0 right-0 flex flex-col justify-center gap-0.5 border-y px-2 py-1',
        isFlagged ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50/60',
      )}
      data-testid={`seam-divider-${seam.atGlobalIdx}`}
      data-flagged={isFlagged ? 'true' : undefined}
    >
      <div className="flex items-center gap-1.5">
        <span className="h-px flex-1 bg-current opacity-20" aria-hidden="true" />
        <span
          className={cn(
            'shrink-0 text-[10px] font-medium uppercase tracking-wide',
            isFlagged ? 'text-red-700' : 'text-amber-700',
          )}
        >
          {formatGap(seam.realGapMs)} offline
        </span>
        <span className="h-px flex-1 bg-current opacity-20" aria-hidden="true" />
      </div>
      {isFlagged && (
        <span className="text-center text-[9px] leading-tight text-red-700">
          file content changed while the recorder was off
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventSidebar
// ---------------------------------------------------------------------------

interface EventSidebarProps {
  /** All events in the BUNDLE (in chronological order, across every session). */
  events: IndexedEvent[];
  /** The engine's current position (globalIdx of the current event). */
  currentGlobalIdx: number;
  /** Seek the engine to this globalIdx. */
  onSeek: (globalIdx: number) => void;
  /** Session boundaries, rendered as dividers. Empty for a single-session bundle. */
  seams?: readonly Seam[];
  /**
   * `atGlobalIdx` values of seams that carry an inter_session_external_change
   * flag — file content demonstrably changed while the recorder was off.
   */
  flaggedSeamIdxs?: ReadonlySet<number>;
  /**
   * sessionId → lane hue, for the opt-in contributor marker (see this file's
   * header). Only ever passed in lane mode; a session with no entry here
   * renders no marker. Omitted entirely, no row gets a marker and the
   * rendered DOM is exactly what it was before this prop existed.
   */
  contributorHueBySession?: ReadonlyMap<string, string> | undefined;
}

export function EventSidebar({
  events,
  currentGlobalIdx,
  onSeek,
  seams = [],
  flaggedSeamIdxs,
  contributorHueBySession,
}: EventSidebarProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Interleave seam dividers into the row list so the virtualizer can size them
  // independently from event rows.
  const rows = useMemo<Row[]>(() => {
    if (seams.length === 0) return events.map((event) => ({ type: 'event' as const, event }));
    const seamByIdx = new Map(seams.map((s) => [s.atGlobalIdx, s]));
    const out: Row[] = [];
    for (const event of events) {
      const seam = seamByIdx.get(event.globalIdx);
      if (seam !== undefined) out.push({ type: 'seam', seam });
      out.push({ type: 'event', event });
    }
    return out;
  }, [events, seams]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => (rows[i]?.type === 'seam' ? SEAM_ROW_HEIGHT : ROW_HEIGHT),
    overscan: 10,
  });

  // Auto-scroll: keep the current event in view when currentGlobalIdx changes.
  // We track the last value we scrolled to so we don't fight user scroll.
  const lastScrolledIdx = useRef<number>(-2); // -2 to force initial scroll

  const handleSeek = useCallback(
    (globalIdx: number) => {
      onSeek(globalIdx);
    },
    [onSeek],
  );

  useEffect(() => {
    if (currentGlobalIdx === lastScrolledIdx.current) return;
    // Row index != globalIdx once seam dividers are interleaved, so scan `rows`
    // rather than `events`.
    const listIdx = rows.findIndex(
      (r) => r.type === 'event' && r.event.globalIdx === currentGlobalIdx,
    );
    if (listIdx !== -1) {
      virtualizer.scrollToIndex(listIdx, { align: 'center' });
      lastScrolledIdx.current = currentGlobalIdx;
    }
  }, [currentGlobalIdx, rows, virtualizer]);

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      className="flex h-full flex-col overflow-hidden border-l bg-background"
      data-testid="event-sidebar"
    >
      {/* Header */}
      <div className="shrink-0 border-b bg-muted/50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        Events
      </div>

      {/* Empty state */}
      {rows.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          No events
        </div>
      )}

      {/* Virtualized list */}
      {rows.length > 0 && (
        <div
          ref={parentRef}
          className="flex-1 overflow-auto"
          data-testid="sidebar-virtual-container"
        >
          <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
            {virtualItems.map((virtualItem) => {
              const row = rows[virtualItem.index]!;
              const style = {
                height: virtualItem.size,
                transform: `translateY(${virtualItem.start}px)`,
              };
              if (row.type === 'seam') {
                return (
                  <SeamDivider
                    key={virtualItem.key}
                    seam={row.seam}
                    isFlagged={flaggedSeamIdxs?.has(row.seam.atGlobalIdx) ?? false}
                    style={style}
                  />
                );
              }
              return (
                <SidebarRow
                  key={virtualItem.key}
                  event={row.event}
                  isCurrent={row.event.globalIdx === currentGlobalIdx}
                  onSeek={handleSeek}
                  style={style}
                  contributorHue={contributorHueBySession?.get(row.event.sessionId)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
