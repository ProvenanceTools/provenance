/**
 * EventList — virtualized event list for the raw timeline view.
 *
 * PRD §7.2 ("Raw timeline"), §7.3 (perf budget).
 *
 * Uses @tanstack/react-virtual for windowed rendering. With 10k+ events, only
 * ~30–50 rows are in the DOM at any time (the overscan window).
 *
 * Row format:
 *   [seq#42] [12:34:56.789] [kind-chip] /path/to/file.py · payload summary    [session-chip]
 */

import { useRef, useEffect, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cn } from '@/lib/utils';
import { formatWall, summarizeTerminalCommand } from '@/lib/format.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { EventKind } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Payload summary
// ---------------------------------------------------------------------------

/**
 * One-line human-readable summary of an event's payload.
 * Exported for unit testing.
 */
export function payloadSummary(event: IndexedEvent): string {
  const p = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case 'doc.change': {
      // Count inserts and deletes across deltas
      type Delta = { text: string; range: { start: unknown; end: unknown } };
      const deltas = (p['deltas'] as Delta[] | undefined) ?? [];
      let inserts = 0;
      let deletes = 0;
      for (const d of deltas) {
        if (d.text && d.text.length > 0) inserts++;
        if (d.range && typeof d.range === 'object' && d.range.start !== d.range.end) {
          // If there's a non-empty range and no text, it's a delete
          if (!d.text || d.text.length === 0) deletes++;
        }
      }
      const parts: string[] = [];
      if (inserts > 0) parts.push(`${inserts} insert${inserts !== 1 ? 's' : ''}`);
      if (deletes > 0) parts.push(`${deletes} delete${deletes !== 1 ? 's' : ''}`);
      if (parts.length === 0 && deltas.length > 0)
        parts.push(`${deltas.length} delta${deltas.length !== 1 ? 's' : ''}`);
      return parts.join(', ');
    }
    case 'paste': {
      const length = typeof p['length'] === 'number' ? p['length'] : 0;
      const head =
        typeof p['content_head'] === 'string'
          ? p['content_head']
          : typeof p['content'] === 'string'
            ? p['content']
            : '';
      const truncated = head.length > 40 ? head.slice(0, 40) + '…' : head;
      return `${length} chars${truncated ? ': ' + truncated : ''}`;
    }
    case 'doc.save': {
      const path = typeof p['path'] === 'string' ? p['path'] : '';
      return path;
    }
    case 'fs.external_change': {
      const operation = typeof p['operation'] === 'string' ? p['operation'] : 'modify';
      const oldHash = typeof p['old_hash'] === 'string' ? p['old_hash'].slice(0, 8) : '?';
      const newHash = typeof p['new_hash'] === 'string' ? p['new_hash'].slice(0, 8) : '?';
      const diffSize = typeof p['diff_size'] === 'number' ? p['diff_size'] : 0;
      // Recorder v1.3+ inlines new_content (≤ 4 KB) or new_content_head (larger).
      // Surface a short snippet so staff can see what the external tool wrote
      // without having to jump to replay.
      const head =
        typeof p['new_content_head'] === 'string'
          ? p['new_content_head']
          : typeof p['new_content'] === 'string'
            ? p['new_content']
            : '';
      const snippet = head ? head.replace(/\s+/g, ' ').slice(0, 40) : '';
      if (operation === 'delete') {
        return `deleted (was ${oldHash}…, ${diffSize} bytes)`;
      }
      if (operation === 'create') {
        const tail = snippet ? `: ${snippet}${head.length > 40 ? '…' : ''}` : '';
        return `created (${newHash}…, ${diffSize} bytes)${tail}`;
      }
      // modify (default)
      const summary = `${oldHash}… → ${newHash}… (diff_size ${diffSize})`;
      return snippet ? `${summary}: ${snippet}${head.length > 40 ? '…' : ''}` : summary;
    }
    case 'terminal.command':
      return summarizeTerminalCommand(p);
    case 'session.start': {
      const sid = typeof p['session_id'] === 'string' ? p['session_id'].slice(0, 8) : '';
      return sid ? `session ${sid}…` : '';
    }
    case 'session.end': {
      const reason = typeof p['reason'] === 'string' ? p['reason'] : '';
      return reason;
    }
    case 'doc.open': {
      const path = typeof p['path'] === 'string' ? p['path'] : '';
      return path;
    }
    case 'terminal.open': {
      const shell = typeof p['shell'] === 'string' ? p['shell'] : '';
      return shell;
    }
    case 'paste.anomaly': {
      const count = typeof p['intercepted_count'] === 'number' ? p['intercepted_count'] : 0;
      return `${count} intercepted`;
    }
    case 'git.event': {
      const op = typeof p['operation'] === 'string' ? p['operation'] : '';
      return op;
    }
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Kind chip color table
// ---------------------------------------------------------------------------

const KIND_CHIP_CLASSES: Partial<Record<EventKind, string>> = {
  paste: 'bg-orange-100 text-orange-700 border-orange-200',
  'paste.anomaly': 'bg-orange-100 text-orange-700 border-orange-200',
  'fs.external_change': 'bg-red-100 text-red-700 border-red-200',
  'chain.broken': 'bg-red-100 text-red-700 border-red-200',
  'recorder.degraded': 'bg-red-100 text-red-700 border-red-200',
  'session.start': 'bg-blue-100 text-blue-700 border-blue-200',
  'session.end': 'bg-blue-100 text-blue-700 border-blue-200',
  'session.heartbeat': 'bg-blue-100 text-blue-700 border-blue-200',
  'terminal.command': 'bg-purple-100 text-purple-700 border-purple-200',
  'terminal.open': 'bg-purple-100 text-purple-700 border-purple-200',
};

const DEFAULT_KIND_CHIP = 'bg-gray-100 text-gray-700 border-gray-200';

/**
 * Style + label for the kind chip. Recorder v1.2 marks paste-shaped bulk
 * edits as `doc.change` with `source: 'paste_likely' | 'paste_confirmed'`
 * (PRD §4.3); render those with the paste color and a "paste*" label so
 * they're visually grouped with native paste events.
 */
function chipFor(event: IndexedEvent): { className: string; label: string; testIdKind: string } {
  if (event.kind === 'doc.change') {
    const payload = event.payload as Record<string, unknown> | null;
    const source =
      payload !== null && typeof payload['source'] === 'string'
        ? (payload['source'] as string)
        : 'typed';
    if (source === 'paste_likely' || source === 'paste_confirmed') {
      return {
        className: KIND_CHIP_CLASSES.paste!,
        label: 'paste*',
        testIdKind: 'doc.change-paste_likely',
      };
    }
  }
  return {
    className: KIND_CHIP_CLASSES[event.kind] ?? DEFAULT_KIND_CHIP,
    label: event.kind,
    testIdKind: event.kind,
  };
}

function KindChip({ event }: { event: IndexedEvent }) {
  const { className, label, testIdKind } = chipFor(event);
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium',
        className,
      )}
      data-testid={`kind-chip-${testIdKind}`}
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
// Row
// ---------------------------------------------------------------------------

interface EventRowProps {
  event: IndexedEvent;
  isSelected: boolean;
  onClick: () => void;
  style: React.CSSProperties;
  onJumpToReplay?: ((event: IndexedEvent) => void) | undefined;
}

function EventRow({ event, isSelected, onClick, style, onJumpToReplay }: EventRowProps) {
  const summary = payloadSummary(event);
  const filePart = event.file
    ? event.file.length > 35
      ? '…' + event.file.slice(-34)
      : event.file
    : '';

  const handleReplayClick = (e: React.MouseEvent) => {
    // Prevent the row's onClick (select event) from also firing.
    e.stopPropagation();
    onJumpToReplay?.(event);
  };

  return (
    <div
      style={style}
      role="button"
      tabIndex={0}
      className={cn(
        'absolute left-0 right-0 flex cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-xs transition-colors hover:bg-accent/50 focus:outline-none focus:ring-1 focus:ring-ring',
        isSelected && 'bg-accent',
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      data-testid={`event-row-${event.globalIdx}`}
      data-global-idx={event.globalIdx}
    >
      {/* seq */}
      <span className="w-12 shrink-0 font-mono text-muted-foreground">#{event.seq}</span>

      {/* wall time */}
      <span className="w-28 shrink-0 font-mono text-muted-foreground">
        {formatWall(event.wall)}
      </span>

      {/* kind chip */}
      <KindChip event={event} />

      {/* file path */}
      {filePart && (
        <span
          className="shrink-0 max-w-[160px] truncate font-mono text-muted-foreground"
          title={event.file}
        >
          {filePart}
        </span>
      )}

      {/* summary */}
      {summary && <span className="min-w-0 flex-1 truncate text-foreground/80">{summary}</span>}
      {!summary && <span className="flex-1" />}

      {/* Replay deep-link button — only when the host route can navigate to a
          replay view (the target differs between /local and the server tab). */}
      {onJumpToReplay && (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          onClick={handleReplayClick}
          aria-label={`Replay at event ${event.globalIdx}`}
          data-testid={`replay-btn-${event.globalIdx}`}
          title="Open replay at this moment"
        >
          ▶
        </button>
      )}

      {/* session chip */}
      <span
        className="ml-1 shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
        data-testid={`session-chip-${event.globalIdx}`}
      >
        {event.sessionId.slice(0, 6)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventList
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 36; // px

interface EventListProps {
  events: IndexedEvent[];
  onSelect: (event: IndexedEvent) => void;
  /** Key of the currently selected event: `${sessionId}:${seq}` */
  selectedKey: string | null;
  /**
   * If set, the list scrolls to and selects the event with this key.
   * Format: `${sessionId}:${seq}` (same as URL param format).
   */
  scrollToKey: string | null;
  onScrollToKeyConsumed?: () => void;
  /**
   * Navigate to the replay view at this event. Supplied by the host route
   * because the target differs: /local uses /local/replay/:sessionId, while
   * the server-backed Timeline tab uses ?tab=replay&event=. When omitted, the
   * per-row replay button is not rendered.
   */
  onJumpToReplay?: ((event: IndexedEvent) => void) | undefined;
}

export function EventList({
  events,
  onSelect,
  selectedKey,
  scrollToKey,
  onJumpToReplay,
}: EventListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  // Handle scrollToKey: find the row and scroll to it.
  useEffect(() => {
    if (!scrollToKey) return;
    const colonIdx = scrollToKey.lastIndexOf(':');
    if (colonIdx === -1) return;
    const sessionId = scrollToKey.slice(0, colonIdx);
    const seq = parseInt(scrollToKey.slice(colonIdx + 1), 10);
    if (isNaN(seq)) return;

    const idx = events.findIndex((e) => e.sessionId === sessionId && e.seq === seq);
    if (idx === -1) return;

    virtualizer.scrollToIndex(idx, { align: 'center' });
  }, [scrollToKey, events, virtualizer]);

  const handleSelect = useCallback(
    (event: IndexedEvent) => {
      onSelect(event);
    },
    [onSelect],
  );

  const totalSize = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border">
      {/* Header row */}
      <div className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        <span className="w-12 shrink-0">Seq</span>
        <span className="w-28 shrink-0">Wall time</span>
        <span className="shrink-0">Kind</span>
        <span className="flex-1">File / Summary</span>
        <span className="ml-auto shrink-0">Session</span>
      </div>

      {/* Empty state */}
      {events.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          No events match the current filters.
        </div>
      )}

      {/* Virtualized list */}
      {events.length > 0 && (
        <div ref={parentRef} className="flex-1 overflow-auto" data-testid="virtual-list-container">
          <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
            {virtualItems.map((virtualItem) => {
              const event = events[virtualItem.index]!;
              const key = `${event.sessionId}:${event.seq}`;
              return (
                <EventRow
                  key={virtualItem.key}
                  event={event}
                  isSelected={selectedKey === key}
                  onClick={() => handleSelect(event)}
                  onJumpToReplay={onJumpToReplay}
                  style={{
                    height: virtualItem.size,
                    transform: `translateY(${virtualItem.start}px)`,
                  }}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
