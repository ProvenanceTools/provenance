/**
 * SessionHost — owns the running session's chain state.
 * Tracks seq, prevHash, and tStart; emits chained log entries synchronously.
 * CLAUDE.md: "No `Promise.all` over operations that must be ordered. Log writes are ordered."
 */

import {
  Clock,
  EventKind,
  EventPayload,
  HashedEnvelope,
  CapturePolicy,
  GENESIS_PREV_HASH,
  DEFAULT_CAPTURE_POLICY,
  chainEntry,
  isEventKindCaptured,
} from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionHost {
  /**
   * Emit a new log entry, chain it, and call the onEntry sink. Returns the chained
   * entry, or `null` if the capture policy suppresses this event kind.
   *
   * A suppressed event is dropped BEFORE chaining, so it consumes no `seq` and the
   * chain stays contiguous.
   */
  emit<K extends EventKind>(kind: K, data: EventPayload<K>): HashedEnvelope<K> | null;
  /** The session UUID for this session. */
  readonly sessionId: string;
  /** The current sequence number (increments after each emit). */
  readonly seq: number;
  /** The monotonic clock value at session start (performance.now() units). */
  readonly tStartMs: number;
}

export type SessionHostDeps = {
  sessionId: string;
  clock: Clock;
  /** Sink for emitted entries. Phase 4 wires this to the writer; Phase 3 may use a simple appender. */
  onEntry: (entry: HashedEnvelope) => void;
  /**
   * The course's effective capture policy, resolved from the VERIFIED manifest
   * (program spec §4). Defaults to {@link DEFAULT_CAPTURE_POLICY} — everything on —
   * which is exactly v1.x behaviour, so a 1.x manifest and an omitted dep both
   * record the full event set.
   *
   * Resolve it once, here. `emit` reads plain booleans off this object; it must
   * never re-verify or re-parse anything, because `doc.change` fires per keystroke.
   */
  capturePolicy?: CapturePolicy;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Create a SessionHost.
 *
 * The host is synchronous: emit() builds the envelope, chains it (computing the hash),
 * calls onEntry, and returns the HashedEnvelope. No awaits.
 *
 * seq starts at 0. prevHash starts at GENESIS_PREV_HASH.
 * tStart is captured from clock.now() at creation time.
 */
export function createSessionHost(deps: SessionHostDeps): SessionHost {
  const { sessionId, clock, onEntry, capturePolicy = DEFAULT_CAPTURE_POLICY } = deps;

  let currentSeq = 0;
  let prevHash = GENESIS_PREV_HASH;
  const tStart = clock.now();

  const host: SessionHost = {
    get sessionId(): string {
      return sessionId;
    },

    get seq(): number {
      return currentSeq;
    },

    get tStartMs(): number {
      return tStart;
    },

    emit<K extends EventKind>(kind: K, data: EventPayload<K>): HashedEnvelope<K> | null {
      // The single choke point for the capture policy (program spec §4). Gating
      // here rather than at each wiring call site means no code path — present or
      // future — can emit a policy-disabled kind by forgetting a check.
      //
      // Cost on the hot path is one property lookup in a frozen constant map plus a
      // boolean read; floor kinds (doc.change among them) miss the map and return
      // immediately. No parsing, no verification, no allocation.
      //
      // Suppression happens BEFORE chainEntry, so a dropped event consumes no seq.
      // Dropping after chaining would leave a hole that validation check 3 reads as
      // a deleted entry.
      if (!isEventKindCaptured(kind, capturePolicy)) {
        return null;
      }

      const seq = currentSeq;
      // t: ms elapsed since session start (monotonic). Non-negative; floor at 0.
      const t = Math.max(0, Math.round(clock.now() - tStart));
      const wall = clock.wall();

      // Build the Envelope (no prev_hash / hash yet), then chain it.
      const entry = chainEntry(prevHash, { seq, t, wall, kind, data });

      // Advance state before calling onEntry to maintain consistency even if onEntry throws.
      currentSeq = seq + 1;
      prevHash = entry.hash;

      onEntry(entry);
      return entry;
    },
  };

  return host;
}
