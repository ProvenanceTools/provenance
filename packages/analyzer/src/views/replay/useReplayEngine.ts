/**
 * useReplayEngine — React adapter over the pure engine-core.
 *
 * Responsibilities:
 *  - Instantiates/re-instantiates the engine when the index changes.
 *  - Manages the playback rAF loop. CLAUDE.md rule: every timer/RAF
 *    has an explicit cleanup path.
 *  - Exposes `play`, `pause`, `step`, `seek` to React components.
 *  - Exposes reactive `state`, `fileStates`, `files` (via useState).
 *
 * Design choice: the engine handle is stored in a ref (not state) to avoid
 * re-creating it on every render. Only the *output* (ReplayState + fileStates)
 * is stored in state so React re-renders on meaningful changes.
 *
 * rAF loop contract:
 *  - `play(speed?)`: captures wall-clock t0 = performance.now(), schedules a
 *    requestAnimationFrame loop. Each frame: compute wallDelta since last frame,
 *    scale by speed to get virtualDelta, call engine.tick(virtualDelta).
 *    If engine.getVirtualT() >= engine.endVirtualT(), auto-pause.
 *  - `pause()`: cancels pending rAF, sets engine to paused.
 *  - On unmount: rAF is cancelled via useEffect cleanup.
 *  - On index change: engine is recreated; any running rAF
 *    is cancelled first.
 *  - Speed change while playing: restarts the rAF loop with the new multiplier
 *    (play() is called again, which cancels the old rAF before starting a new one).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createEngine } from './engine-core.js';
import {
  buildReconstructionScope,
  soloReconstructionScope,
} from '@provenance/analysis-core/index/reconstruct-segments.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { AmbiguousReconstruction, EngineHandle, ReplayState } from './engine-core.js';
import type { FileReplayState } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { Seam } from './bundle-clock.js';

// Re-export for convenience.
export type { ReplayState } from './engine-core.js';

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export type UseReplayEngineResult = {
  state: ReplayState;
  fileStates: Map<string, FileReplayState>;
  files: string[];
  /** Session boundaries in the stream. Empty for a single-session bundle. */
  seams: readonly Seam[];
  /**
   * Files with no single content at the current playhead, and which kind of no
   * it is. Their `fileStates` entry is empty rather than one branch's content
   * (Tier 2.2, spec §6 Rule 4). Always empty for a single-contributor bundle.
   */
  ambiguousFiles: ReadonlyMap<string, 'concurrent' | 'unknown'>;
  /**
   * The same files as {@link ambiguousFiles}, carrying the evidence: for a
   * `concurrent` file, every live branch with its contributor and its own
   * content, so the UI can show them side by side instead of only refusing.
   */
  fileAmbiguity: ReadonlyMap<string, AmbiguousReconstruction>;
  play(speed?: number): void;
  pause(): void;
  step(n?: number): void;
  seek(globalIdx: number): void;
};

export type UseReplayEngineOptions = {
  /**
   * Compress within-session idle gaps during playback (see MAX_IDLE_GAP_MS).
   * Declarative rather than an imperative setter: the engine is re-created
   * whenever `index` changes, and a setter's effect would be silently dropped
   * by that. Defaults to the engine's own default (off).
   */
  skipIdle?: boolean;
  /**
   * The bundle behind `index`. Supplying it lets replay tell a file whose
   * content at the playhead has no single truth from one that simply has none
   * (Tier 2.2, spec §6 Rule 4). Omitted, the engine takes a solo scope, which
   * is the behaviour that predates this and is correct for every
   * single-contributor bundle.
   */
  bundle?: Bundle | null | undefined;
};

/**
 * @param index The EventIndex for the whole bundle. May be null (guard: returns no-op).
 *
 * The engine spans every session in the bundle; there is no session parameter.
 * `state.sessionId` is derived from wherever the playhead currently sits.
 */
export function useReplayEngine(
  index: EventIndex | null,
  options: UseReplayEngineOptions = {},
): UseReplayEngineResult {
  const skipIdle = options.skipIdle ?? false;
  const bundle = options.bundle ?? null;

  // Engine handle lives in a ref so we don't re-create it on every render.
  const engineRef = useRef<EngineHandle | null>(null);
  // rAF id lives in a ref so the cancel callback always sees the latest id.
  const rafRef = useRef<number | null>(null);
  // Last wall-clock timestamp for rAF loop delta computation.
  const lastFrameWallMsRef = useRef<number>(0);
  // Speed ref: always reflects the latest speed, read inside the rAF closure
  // so there is no stale-closure footgun when speed changes during playback.
  const speedRef = useRef<number>(1);
  // Same trick for skipIdle: the engine-creation effect must apply the CURRENT
  // value without taking skipIdle as a dependency, which would rebuild the
  // engine (and lose the playhead) every time the toggle flips.
  const skipIdleRef = useRef<boolean>(skipIdle);
  skipIdleRef.current = skipIdle;

  // React state: the only things that trigger re-renders.
  const [replayState, setReplayState] = useState<ReplayState>(() => ({
    status: 'paused',
    currentGlobalIdx: -1,
    speed: 1,
    sessionId: index?.ordered[0]?.sessionId ?? '',
    virtualT: 0,
    skipIdle,
  }));
  const [fileStates, setFileStates] = useState<Map<string, FileReplayState>>(new Map());
  const [ambiguousFiles, setAmbiguousFiles] = useState<
    ReadonlyMap<string, 'concurrent' | 'unknown'>
  >(new Map());
  const [fileAmbiguity, setFileAmbiguity] = useState<
    ReadonlyMap<string, AmbiguousReconstruction>
  >(new Map());
  const [files, setFiles] = useState<string[]>([]);
  const [seams, setSeams] = useState<readonly Seam[]>([]);

  // ---------------------------------------------------------------------------
  // (Re-)create engine when the index changes.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    // Cancel any running rAF before recreating the engine.
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (index === null) {
      engineRef.current = null;
      setReplayState({
        status: 'paused',
        currentGlobalIdx: -1,
        speed: 1,
        sessionId: '',
        virtualT: 0,
        skipIdle: skipIdleRef.current,
      });
      setFileStates(new Map());
      setAmbiguousFiles(new Map());
      setFileAmbiguity(new Map());
      setFiles([]);
      setSeams([]);
      return;
    }

    const engine = createEngine(
      index,
      bundle === null ? soloReconstructionScope(index) : buildReconstructionScope(bundle, index),
    );
    engineRef.current = engine;
    speedRef.current = engine.getState().speed;
    engine.setSkipIdle(skipIdleRef.current);

    setReplayState(engine.getState());
    setFileStates(engine.getFileStates());
    setAmbiguousFiles(new Map(engine.ambiguousFiles()));
    setFileAmbiguity(new Map(engine.fileAmbiguity()));
    setFiles(engine.getFiles());
    setSeams(engine.seams());

    return () => {
      // Cleanup: cancel rAF when engine is replaced or component unmounts.
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [index, bundle]);

  // ---------------------------------------------------------------------------
  // Helper: sync React state from the engine after a mutation.
  // ---------------------------------------------------------------------------
  const syncFromEngine = useCallback((engine: EngineHandle) => {
    setReplayState(engine.getState());
    setFileStates(engine.getFileStates());
    setAmbiguousFiles(new Map(engine.ambiguousFiles()));
    setFileAmbiguity(new Map(engine.fileAmbiguity()));
  }, []);

  // ---------------------------------------------------------------------------
  // Apply skipIdle changes to the live engine.
  //
  // Separate from the creation effect so flipping the toggle does not rebuild
  // the engine. Only pacing changes — the playhead stays exactly where it is,
  // so the toggle is safe to hit mid-playback.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const engine = engineRef.current;
    if (engine === null) return;
    engine.setSkipIdle(skipIdle);
    setReplayState(engine.getState());
  }, [skipIdle]);

  // ---------------------------------------------------------------------------
  // cancelRaf helper (idempotent)
  // ---------------------------------------------------------------------------
  const cancelRaf = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // ---------------------------------------------------------------------------
  // play(speed?)
  //
  // Uses a requestAnimationFrame loop so events replay at the actual rate they
  // were recorded. virtualDelta = wallDelta * speed, passed to engine.tick().
  // ---------------------------------------------------------------------------
  const play = useCallback(
    (speed?: number) => {
      const engine = engineRef.current;
      if (engine === null) return;

      cancelRaf();

      const effectiveSpeed = speed ?? engine.getState().speed;
      engine.setSpeed(effectiveSpeed);
      speedRef.current = effectiveSpeed;
      engine.setPlaying();
      syncFromEngine(engine);

      // Capture starting wall time.
      lastFrameWallMsRef.current = performance.now();

      function rafCallback(nowWall: number) {
        const eng = engineRef.current;
        if (eng === null) {
          rafRef.current = null;
          return;
        }

        const wallDelta = nowWall - lastFrameWallMsRef.current;
        lastFrameWallMsRef.current = nowWall;

        const virtualDelta = wallDelta * speedRef.current;
        eng.tick(virtualDelta);
        syncFromEngine(eng);

        // Check for end-of-stream: virtualT reached or passed endVirtualT.
        if (eng.getState().virtualT >= eng.endVirtualT() && eng.eventCount() > 0) {
          // Auto-pause at end of stream.
          rafRef.current = null;
          eng.setPaused();
          syncFromEngine(eng);
          return;
        }

        rafRef.current = requestAnimationFrame(rafCallback);
      }

      rafRef.current = requestAnimationFrame(rafCallback);
    },
    [cancelRaf, syncFromEngine],
  );

  // ---------------------------------------------------------------------------
  // pause()
  // ---------------------------------------------------------------------------
  const pause = useCallback(() => {
    cancelRaf();
    const engine = engineRef.current;
    if (engine === null) return;
    engine.setPaused();
    syncFromEngine(engine);
  }, [cancelRaf, syncFromEngine]);

  // ---------------------------------------------------------------------------
  // step(n)
  // ---------------------------------------------------------------------------
  const step = useCallback(
    (n = 1) => {
      const engine = engineRef.current;
      if (engine === null) return;
      // Always pause before stepping: standard media-player UX.
      // (Matches behavior of conventional playback controls: step is a scrub operation.)
      cancelRaf();
      engine.setPaused();
      engine.step(n);
      syncFromEngine(engine);
    },
    [cancelRaf, syncFromEngine],
  );

  // ---------------------------------------------------------------------------
  // seek(globalIdx)
  // ---------------------------------------------------------------------------
  const seek = useCallback(
    (globalIdx: number) => {
      const engine = engineRef.current;
      if (engine === null) return;
      engine.seek(globalIdx);
      syncFromEngine(engine);
    },
    [syncFromEngine],
  );

  // ---------------------------------------------------------------------------
  // Stable result object (avoids unnecessary re-renders in consumers).
  // ---------------------------------------------------------------------------
  return useMemo(
    () => ({
      state: replayState,
      fileStates,
      files,
      seams,
      ambiguousFiles,
      fileAmbiguity,
      play,
      pause,
      step,
      seek,
    }),
    [replayState, fileStates, files, seams, ambiguousFiles, fileAmbiguity, play, pause, step, seek],
  );
}
