/**
 * engine-core.ts — pure replay engine (no React, no timers, no side effects).
 *
 * Algorithm overview:
 *
 * STATE:
 *   currentGlobalIdx : the index of the "current" event (inclusive, so file
 *                      state reflects events [0, currentGlobalIdx]).
 *   status           : 'paused' | 'playing'
 *   speed            : playback multiplier (currently reserved; timer lives
 *                      in useReplayEngine)
 *   skipIdle         : when set, tick() compresses long idle gaps to
 *                      MAX_IDLE_GAP_MS of playback (see the constant)
 *   sessionId        : DERIVED — the session the playhead is currently inside
 *
 * SCOPE:
 *   The engine spans the WHOLE bundle (index.ordered), not a single session.
 *   Since event-index.ts guarantees `ordered[i].globalIdx === i`, array position
 *   and globalIdx are the same number throughout this module.
 *
 * TIME:
 *   Playback is driven by `bundleT` (see bundle-clock.ts), not the per-event
 *   `t`. `t` is relative to its own session's start and restarts at every
 *   session boundary, so it cannot drive a cross-session stream.
 *
 * FILES:
 *   "files under review" = union of all event.file values across the bundle
 *   where kind ∈ {doc.change, paste, doc.save, doc.open, fs.external_change}.
 *
 * RECONSTRUCTION:
 *   We maintain one `FileReplayState` per file path. On step/seek we rebuild
 *   from the nearest checkpoint below the target globalIdx, then step forward.
 *
 * CHECKPOINTS:
 *   Every CHECKPOINT_EVERY events we cache the full FileReplayState for all
 *   files. Checkpoints are keyed by checkpointGlobalIdx (a multiple of
 *   CHECKPOINT_EVERY). The map is lazily populated: when seek(T) runs, we find
 *   the highest checkpoint below T, build that checkpoint if missing (walking
 *   from the prior checkpoint or from 0), then step forward from there.
 *
 *   Checkpoint key: checkpointGlobalIdx (number).
 *   Value: Map<filePath, FileReplayState> (immutable snapshot).
 *
 * SEEK(T):
 *   1. Find checkpointFloor = floor(T / CHECKPOINT_EVERY) * CHECKPOINT_EVERY.
 *   2. If checkpoints.has(checkpointFloor) → startState = checkpoints.get(…).
 *      Else build it by walking from the prior known checkpoint forward.
 *   3. From startState, reconstruct each file forward to T (exclusive).
 *   4. Return new fileStates map + new currentGlobalIdx = T.
 *
 * STEP(n):
 *   Clamps to [0, events.length - 1], then delegates to seek.
 *
 * NOTE: this module exports `createEngine` which returns a mutable EngineHandle.
 * The React layer (`useReplayEngine`) drives state changes via the handle and
 * reflects them into React state. The engine itself never calls setState or
 * any async API.
 *
 * PRD ref: §7.2 (replay view core).
 */

import {
  determinateValue,
  reconstructFileSegmentedWithProvenance,
  soloReconstructionScope,
  type ReconstructionScope,
} from '@provenance/analysis-core/index/reconstruct-segments.js';
import type { FileReplayState } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { buildBundleClock, type Seam } from './bundle-clock.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cache a checkpoint every N events. */
const CHECKPOINT_EVERY = 1000;

/**
 * Longest pause `skipIdle` will play through, in ms of bundle time. A within-
 * session gap longer than this is compressed so that only this much of it is
 * played — a 20-minute think pause becomes a 5-second beat.
 *
 * Deliberately equal to SEAM_MAX_GAP_MS: bundle-clock already clamps INTER-
 * session gaps to that value, so the two rules agree and a seam pause is left
 * exactly as the clock rendered it. One concept, one duration.
 *
 * Compression is pacing only. It never applies an event early, and it never
 * touches `bundleT`, so the scrub slider, seam ticks, event counts and the
 * durations shown in the UI all continue to describe real recorded time.
 */
export const MAX_IDLE_GAP_MS = 5_000;

/** Event kinds that "write" to a file; used to build the file list. */
const FILE_WRITING_KINDS = new Set([
  'doc.change',
  'paste',
  'doc.save',
  'doc.open',
  'fs.external_change',
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ReplayStatus = 'paused' | 'playing';

export type ReplayState = {
  status: ReplayStatus;
  /** The index into events[] of the "current" position. -1 means before any event. */
  currentGlobalIdx: number;
  speed: number;
  /**
   * The session the playhead currently sits inside. DERIVED, not an input —
   * the engine spans the whole bundle, so this changes as playback crosses a
   * session seam. Before the first event it is the first session's id.
   */
  sessionId: string;
  /**
   * The engine's current position in BUNDLE time (see bundle-clock.ts), not the
   * per-session `t` — `t` restarts at each session, so it cannot drive playback
   * across a multi-session bundle.
   * Synced to bundleT[currentGlobalIdx] on seek/step; advanced by tick().
   */
  virtualT: number;
  /**
   * When true, tick() compresses within-session idle gaps longer than
   * MAX_IDLE_GAP_MS (see the constant). Defaults to FALSE here so the engine
   * stays a faithful primitive and existing pacing tests keep their meaning;
   * the replay UI turns it on by default because that is the useful default
   * for a reader, not for the model.
   */
  skipIdle: boolean;
};

export type EngineHandle = {
  /** Current immutable snapshot of the engine state. */
  getState(): ReplayState;
  /** Current file states keyed by file path. */
  getFileStates(): Map<string, FileReplayState>;
  /** Ordered list of files under review (across the whole bundle). */
  getFiles(): string[];
  /** Total number of events in the bundle. */
  eventCount(): number;
  /** Session boundaries in the stream. Empty for a single-session bundle. */
  seams(): readonly Seam[];
  /**
   * Files whose content at the CURRENT position has no single truth, and which
   * kind of no it is (Tier 2.2, spec §6 Rule 4: "replay never linearizes
   * concurrency").
   *
   * Such a file's entry in {@link EngineHandle.getFileStates} is empty rather
   * than one branch's content, and the UI is expected to explain the gap. It is
   * always empty for a single-contributor bundle.
   */
  ambiguousFiles(): ReadonlyMap<string, 'concurrent' | 'unknown'>;

  /** Advance by n events (may be negative). Clamps to valid range. Returns new state. */
  step(n?: number): ReplayState;
  /** Jump to a specific event index. Clamps to valid range. Returns new state. */
  seek(globalIdx: number): ReplayState;
  /** Set status to 'playing' (timer management is the React layer's job). */
  setPlaying(): ReplayState;
  /** Set status to 'paused'. Returns new state. */
  setPaused(): ReplayState;
  /** Update speed (does not start/stop playing). Returns new state. */
  setSpeed(speed: number): ReplayState;
  /** Toggle idle-gap compression (see MAX_IDLE_GAP_MS). Returns new state. */
  setSkipIdle(skipIdle: boolean): ReplayState;

  /**
   * Advance the virtual time pointer by `virtualDeltaMs` ms of bundle time.
   * Applies all events whose bundle time falls in
   * [currentVirtualT, currentVirtualT + virtualDeltaMs].
   * If no events fall in the window, just advances virtualT (sits through an
   * idle gap — including a collapsed inter-session gap), unless `skipIdle` is
   * on, in which case a gap longer than MAX_IDLE_GAP_MS is compressed to that
   * length. Returns new state.
   */
  tick(virtualDeltaMs: number): ReplayState;

  /**
   * The bundle-time value of the last event (or 0 if no events).
   * Used by the rAF loop to detect end-of-stream.
   */
  endVirtualT(): number;
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A snapshot of all file states at a checkpoint, keyed by filePath. */
type Checkpoint = Map<string, FileReplayState>;

/** Internal mutable state bag. */
type InternalState = {
  state: ReplayState;
  fileStates: Map<string, FileReplayState>;
  /**
   * Cursor into `events`, where -1 means "before the first event".
   *
   * Because `events` IS `index.ordered`, and `event-index.ts` guarantees
   * `ordered[i].globalIdx === i`, array position and globalIdx are the same
   * number. `pos` and `state.currentGlobalIdx` therefore always agree. (The
   * session-scoped engine needed a translation layer here; the whole-bundle
   * engine does not.)
   */
  pos: number;
  /** All bundle events, ordered by globalIdx. */
  events: readonly IndexedEvent[];
  /** Files under review (derived from events; computed once). */
  files: string[];
  /** Playback timeline, indexed by globalIdx. See bundle-clock.ts. */
  bundleT: Float64Array;
  /** Session boundaries within `events`. */
  seams: readonly Seam[];
  /**
   * Checkpoint cache. Key = globalIdx of the first event AFTER the checkpoint
   * boundary, i.e. the file state reflects events [0, key).
   *
   * Special case: key=0 is the empty initial state (no events applied).
   */
  checkpoints: Map<number, Checkpoint>;
  /** The EventIndex (needed to call reconstructFileWithProvenance). */
  index: EventIndex;
  /** Who each session belongs to, plus `≺`. Solo unless a bundle was supplied. */
  scope: ReconstructionScope;
  /** Files with no single content at the current position. Rebuilt per seek. */
  ambiguous: Map<string, 'concurrent' | 'unknown'>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive the set of "files under review" from the whole bundle's events.
 * These are all file paths touched by the writing-kind events, in the order
 * they first appear.
 *
 * Whole-bundle, not per-session, on purpose: a file edited in session 1 and
 * left alone in session 2 must stay in the tab strip, since its content is
 * still reconstructable and still part of the submission.
 */
function computeFiles(events: readonly IndexedEvent[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const e of events) {
    if (FILE_WRITING_KINDS.has(e.kind) && e.file != null) {
      if (!seen.has(e.file)) {
        seen.add(e.file);
        result.push(e.file);
      }
    }
  }
  return result;
}

/**
 * Build an empty FileReplayState for a file (initial / before any events).
 */
function emptyFileState(): FileReplayState {
  return {
    content: '',
    provenance: new Uint32Array(0),
    kindByGlobalIdx: new Map(),
    hashBySaveSeq: new Map(),
  };
}

/**
 * Reconstruct all files for the engine's session up to (exclusive) upToGlobalIdx.
 * Uses startStates as the baseline (the checkpoint to start from).
 *
 * We call `reconstructFileWithProvenance` for each file with `upToGlobalIdx`.
 * That function always replays from the beginning of the file's event stream.
 * For large sessions, the checkpoint scheme trades off memory for CPU: we cache
 * the state at every CHECKPOINT_EVERY boundary so we don't replay from index 0
 * every time.
 *
 * NOTE: Because `reconstructFileWithProvenance` replays from the very start of
 * the file event stream (it doesn't accept a start offset), we cannot directly
 * use a checkpoint as the starting point for an incremental replay. Instead,
 * checkpoints serve as a pre-compute hint: when the target is large (say
 * globalIdx = 5,000), we first ensure the checkpoint at 4,000 is built, and
 * then call `reconstructFileWithProvenance` with `upToGlobalIdx = 5,001` — which
 * is the same call we'd make without checkpoints. The benefit of building the
 * checkpoint is that the NEXT seek near 5,000 can reuse the same full call,
 * and if we're stepping forward we call it once more rather than twice.
 *
 * For Phase 13, the simple approach is: just call reconstructFileWithProvenance
 * directly with the desired upToGlobalIdx. Checkpoints reduce duplicate work
 * only when scrubbing back to a position that was previously computed, by making
 * the boundary explicit. The perf budget note says this is not a Phase 13 concern.
 *
 * The actual optimized seek path:
 *   - The `upToGlobalIdx` we pass is `currentGlobalIdx + 1` (exclusive).
 *   - reconstruct walks the file's byFile events stopping at that boundary.
 */
function buildFileStates(
  internal: InternalState,
  upToGlobalIdx: number,
): Map<string, FileReplayState> {
  const result = new Map<string, FileReplayState>();
  internal.ambiguous.clear();
  for (const filePath of internal.files) {
    const segmented = reconstructFileSegmentedWithProvenance(
      internal.scope,
      filePath,
      upToGlobalIdx,
    );
    const state = determinateValue(segmented);
    if (state === null) {
      // Spec §6 Rule 4: a replay position inside a concurrent interval shows the
      // branches side by side or REFUSES with an explanation. It does not pick
      // one and it does not interleave. Side-by-side is Tier 5.3 UI; refusing is
      // the honest half we can ship now, and it is the half that matters —
      // picking would put a file that never existed on screen in a meeting.
      internal.ambiguous.set(filePath, segmented.kind === 'concurrent' ? 'concurrent' : 'unknown');
      result.set(filePath, emptyFileState());
      continue;
    }
    result.set(filePath, state);
  }
  return result;
}

/**
 * Ensure the checkpoint at `checkpointIdx` exists in the cache.
 * `checkpointIdx` must be a multiple of CHECKPOINT_EVERY.
 * If it's not cached, build it (this is cheap: we're just calling
 * reconstructFileWithProvenance up to that boundary, same as a seek would do).
 */
function ensureCheckpoint(internal: InternalState, checkpointIdx: number): void {
  if (internal.checkpoints.has(checkpointIdx)) return;
  const states = buildFileStates(internal, checkpointIdx);
  internal.checkpoints.set(checkpointIdx, states);
}

/**
 * Clamp a globalIdx to [−1, events.length − 1].
 * −1 represents "before first event".
 */
function clamp(idx: number, maxIdx: number): number {
  return Math.max(-1, Math.min(maxIdx, idx));
}

// ---------------------------------------------------------------------------
// createEngine — factory
// ---------------------------------------------------------------------------

/**
 * Create a replay engine spanning the WHOLE bundle.
 *
 * The engine is deliberately not scoped to a session: a submission's sessions
 * are one continuous piece of work, and scoping made files edited in earlier
 * sessions vanish, dead-ended the event sidebar at each boundary, and made the
 * inter-session seam (where `inter_session_external_change` fires) unreachable.
 *
 * @param index  The EventIndex for the whole bundle (we read ordered + byFile).
 * @returns      An EngineHandle with mutable internal state.
 */
/**
 * `scope` carries who each session belongs to and the happens-before relation.
 * It defaults to a SOLO scope, which is today's exact behaviour, so a caller
 * that has no bundle to hand keeps working unchanged.
 */
export function createEngine(index: EventIndex, scope?: ReconstructionScope): EngineHandle {
  const events = index.ordered;
  const files = computeFiles(events);
  const { bundleT, seams } = buildBundleClock(events);

  const initialState: ReplayState = {
    status: 'paused',
    currentGlobalIdx: -1,
    speed: 1,
    sessionId: events[0]?.sessionId ?? '',
    // bundleT is zero-based by construction, so the pre-first-event playhead
    // sits at 0 regardless of what the first session's `t` happened to be.
    virtualT: 0,
    skipIdle: false,
  };

  const internal: InternalState = {
    state: { ...initialState },
    fileStates: new Map(files.map((f) => [f, emptyFileState()])),
    pos: -1,
    events,
    files,
    bundleT,
    seams,
    checkpoints: new Map<number, Checkpoint>([
      [0, new Map(files.map((f) => [f, emptyFileState()]))],
    ]),
    index,
    scope: scope ?? soloReconstructionScope(index),
    ambiguous: new Map(),
  };

  // ---------------------------------------------------------------------------
  // Seek implementation — navigate to position `pos`.
  //
  // `pos` is both an array index into `events` and a true globalIdx: `events` is
  // `index.ordered`, and event-index.ts guarantees `ordered[i].globalIdx === i`.
  // -1 means "before any event". Reconstruction is cut at `pos + 1` (exclusive)
  // because reconstructFileWithProvenance walks the whole-bundle byFile stream.
  // ---------------------------------------------------------------------------

  function seekToPos(pos: number): ReplayState {
    const maxIdx = internal.events.length - 1;
    const clamped = clamp(pos, maxIdx);

    // upToGlobalIdx (exclusive). If clamped = -1, upTo = 0 → no events applied.
    const upTo = clamped === -1 ? 0 : clamped + 1;

    // Warm the checkpoint below this position so future adjacent seeks can
    // short-circuit. Keyed by the true-globalIdx cut so the cache boundaries
    // align with the reconstruction the seek performs.
    const checkpointFloor = Math.floor(Math.max(0, upTo - 1) / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
    // Skip warmup for the implicit-empty checkpoint at 0.
    if (checkpointFloor >= CHECKPOINT_EVERY) {
      ensureCheckpoint(internal, checkpointFloor);
    }

    // Rebuild file states up to the target position.
    const newFileStates =
      upTo === 0
        ? new Map(internal.files.map((f) => [f, emptyFileState()]))
        : buildFileStates(internal, upTo);

    // Sync virtualT to the target event's bundle time.
    // At -1 (before any event) the playhead sits at the start of the timeline.
    const targetVirtualT =
      clamped === -1 ? 0 : (internal.bundleT[clamped] ?? internal.state.virtualT);

    // The current session is derived from where the playhead landed.
    const sessionId =
      clamped === -1
        ? (internal.events[0]?.sessionId ?? '')
        : (internal.events[clamped]?.sessionId ?? internal.state.sessionId);

    internal.pos = clamped;
    internal.fileStates = newFileStates;
    internal.state = {
      ...internal.state,
      currentGlobalIdx: clamped,
      sessionId,
      virtualT: targetVirtualT,
    };

    return { ...internal.state };
  }

  // ---------------------------------------------------------------------------
  // Handle
  // ---------------------------------------------------------------------------

  const handle: EngineHandle = {
    getState() {
      return { ...internal.state };
    },

    getFileStates() {
      return new Map(internal.fileStates);
    },

    getFiles() {
      return [...internal.files];
    },

    eventCount() {
      return internal.events.length;
    },

    seams() {
      return internal.seams;
    },
    ambiguousFiles() {
      return internal.ambiguous;
    },

    step(n = 1) {
      return seekToPos(internal.pos + n);
    },

    seek(globalIdx) {
      // Array position and globalIdx are the same number over index.ordered, so
      // sidebar rows, jump targets, and the scrub slider need no translation.
      return seekToPos(globalIdx);
    },

    setPlaying() {
      internal.state = { ...internal.state, status: 'playing' };
      return { ...internal.state };
    },

    setPaused() {
      internal.state = { ...internal.state, status: 'paused' };
      return { ...internal.state };
    },

    setSpeed(speed) {
      internal.state = { ...internal.state, speed };
      return { ...internal.state };
    },

    setSkipIdle(skipIdle) {
      internal.state = { ...internal.state, skipIdle };
      return { ...internal.state };
    },

    tick(virtualDeltaMs) {
      if (internal.events.length === 0) {
        return { ...internal.state };
      }

      const newVirtualT = internal.state.virtualT + virtualDeltaMs;
      const currentIdx = internal.pos;
      const maxIdx = internal.events.length - 1;

      // If already at the end, just update virtualT.
      if (currentIdx >= maxIdx) {
        internal.state = { ...internal.state, virtualT: newVirtualT };
        return { ...internal.state };
      }

      // Find the last event whose bundle time <= newVirtualT, starting after
      // currentIdx. All events in (currentVirtualT, newVirtualT] are applied.
      // Using bundleT (not `t`) is what lets playback cross a session seam:
      // `t` restarts at 0 in the next session and would never satisfy this.
      let targetIdx = currentIdx;
      for (let i = currentIdx + 1; i <= maxIdx; i++) {
        const eventT = internal.bundleT[i] ?? 0;
        if (eventT <= newVirtualT) {
          targetIdx = i;
        } else {
          break;
        }
      }

      if (targetIdx !== currentIdx) {
        // We have new events to apply — seek to the last one in the window.
        // seekToPos also syncs virtualT to the event's t, but we want virtualT
        // to reflect the full advance (including idle time beyond the last
        // event). So we call seekToPos and then overwrite virtualT.
        seekToPos(targetIdx);
        internal.state = { ...internal.state, virtualT: newVirtualT };
      } else {
        // No events fell in the window: we are sitting inside an idle gap.
        //
        // With skipIdle on, if the next event is still more than MAX_IDLE_GAP_MS
        // away we jump the clock to MAX_IDLE_GAP_MS before it, so the remaining
        // pause plays at that length instead of its true one. The guard makes
        // this strictly forward — `nextT - MAX_IDLE_GAP_MS > newVirtualT` is the
        // condition itself — so virtualT can never rewind, and a gap already
        // shorter than the cap (including every collapsed seam gap) is left be.
        let advancedT = newVirtualT;
        if (internal.state.skipIdle) {
          const nextT = internal.bundleT[currentIdx + 1];
          if (nextT !== undefined && nextT - newVirtualT > MAX_IDLE_GAP_MS) {
            advancedT = nextT - MAX_IDLE_GAP_MS;
          }
        }
        internal.state = { ...internal.state, virtualT: advancedT };
      }

      return { ...internal.state };
    },

    endVirtualT() {
      if (internal.bundleT.length === 0) return 0;
      return internal.bundleT[internal.bundleT.length - 1] ?? 0;
    },
  };

  return handle;
}
