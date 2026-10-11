/**
 * When to rewrite the rolling seal (see `rolling-seal-writer.ts`).
 *
 * Pure scheduling: this module owns the timers, the time floor, the coalescing
 * and the serialization, and knows nothing about VS Code, the filesystem or the
 * seal's contents. `roll` and `prepare` are injected, as are the clock and the
 * timers, so the whole policy is unit-testable with fake time.
 *
 * ## Triggers
 *
 * - `rollNow()`     — the session-start roll. Unconditional.
 * - `onCheckpoint()`— a checkpoint landed. Subject to a time floor
 *                     (`floorMs`, 60 s): a roll walks and hashes the workspace,
 *                     so checkpoint-driven rolls are rate-limited. A checkpoint
 *                     that arrives inside the floor is DEFERRED to the moment
 *                     the floor expires (one pending timer, coalesced), not
 *                     dropped — so the seal is never more than one floor
 *                     interval stale once activity stops.
 * - `onSave()`      — a `doc.save` was recorded. A student saves and then
 *                     commits with the editor still open, so the committed seal
 *                     must reflect the save. Bypasses the floor, but behind a
 *                     trailing debounce (`saveDebounceMs`, 1 s): autosave can
 *                     fire every second and each roll is a workspace walk.
 * - `finalRoll()`   — dispose(). Cancels every timer, discards anything
 *                     queued, and writes the last seal after any in-flight one.
 *
 * ## Serialization
 *
 * Every roll runs on one chain, so two rewrites never interleave their `.json`
 * and `.sig` renames. At most one roll is in flight and at most one is queued
 * behind it; a request that arrives while one is running just marks the queue
 * (latest wins — a roll reads the workspace when it runs, so one queued roll
 * covers any number of requests). After `finalRoll()` begins, no further
 * non-final roll can start, so nothing lands after the final seal.
 */

export type SealTimerHandle = unknown;

export type SealTimers = {
  setTimeout: (fn: () => void, ms: number) => SealTimerHandle;
  clearTimeout: (handle: SealTimerHandle) => void;
};

export const ROLLING_SEAL_MIN_INTERVAL_MS = 60_000;
export const ROLLING_SEAL_SAVE_DEBOUNCE_MS = 1_000;

/** Production timers. `unref` so a pending roll never keeps the host process alive. */
export const defaultSealTimers: SealTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type RollingSealSchedulerDeps = {
  /** Performs one seal rewrite. Must never reject. */
  roll: (opts: { final: boolean }) => Promise<void>;
  /**
   * Runs immediately before every non-start, non-final roll (the owner flushes
   * the log writer here so the seal's slog digest covers every entry chained so
   * far). Failures are swallowed: a seal is best effort.
   */
  prepare?: () => Promise<void>;
  /** Monotonic ms (`clock.now()`). */
  now: () => number;
  timers: SealTimers;
  /** False for bundle-submission assignments: every method becomes a no-op. */
  enabled: boolean;
  floorMs?: number;
  saveDebounceMs?: number;
};

export type RollingSealScheduler = {
  rollNow(): Promise<void>;
  onCheckpoint(): Promise<void>;
  onSave(): void;
  finalRoll(): Promise<void>;
};

export function createRollingSealScheduler(deps: RollingSealSchedulerDeps): RollingSealScheduler {
  const floorMs = deps.floorMs ?? ROLLING_SEAL_MIN_INTERVAL_MS;
  const debounceMs = deps.saveDebounceMs ?? ROLLING_SEAL_SAVE_DEBOUNCE_MS;

  let chain: Promise<void> = Promise.resolve();
  let inFlight = false;
  let queued = false;
  let closed = false;
  let lastRollAt: number | null = null;
  let saveTimer: SealTimerHandle | undefined;
  let floorTimer: SealTimerHandle | undefined;

  function clearSaveTimer(): void {
    if (saveTimer !== undefined) {
      deps.timers.clearTimeout(saveTimer);
      saveTimer = undefined;
    }
  }
  function clearFloorTimer(): void {
    if (floorTimer !== undefined) {
      deps.timers.clearTimeout(floorTimer);
      floorTimer = undefined;
    }
  }

  /** Coalesced non-final roll: run now, or mark one queued behind the in-flight one. */
  function run(withPrepare: boolean): Promise<void> {
    if (closed) return Promise.resolve();
    if (inFlight) {
      queued = true;
      return chain;
    }
    inFlight = true;
    lastRollAt = deps.now();
    clearFloorTimer(); // this roll makes any deferred floor roll redundant
    chain = chain.then(async () => {
      try {
        if (withPrepare && deps.prepare) {
          try {
            await deps.prepare();
          } catch {
            // Best effort: seal whatever is on disk.
          }
        }
        if (!closed) await deps.roll({ final: false });
      } finally {
        inFlight = false;
      }
      if (queued) {
        queued = false;
        // Not awaited: it chains behind this callback; awaiting would deadlock.
        void run(true);
      }
    });
    return chain;
  }

  return {
    rollNow(): Promise<void> {
      if (!deps.enabled) return Promise.resolve();
      return run(false);
    },

    onCheckpoint(): Promise<void> {
      if (!deps.enabled || closed) return Promise.resolve();
      const since = lastRollAt === null ? Infinity : deps.now() - lastRollAt;
      if (since >= floorMs) return run(true);
      // Too soon: defer to when the floor expires. One pending timer.
      if (floorTimer === undefined) {
        floorTimer = deps.timers.setTimeout(() => {
          floorTimer = undefined;
          void run(true);
        }, floorMs - since);
      }
      return Promise.resolve();
    },

    onSave(): void {
      if (!deps.enabled || closed) return;
      clearSaveTimer(); // trailing debounce: the last save in a burst wins
      saveTimer = deps.timers.setTimeout(() => {
        saveTimer = undefined;
        void run(true);
      }, debounceMs);
    },

    finalRoll(): Promise<void> {
      if (!deps.enabled) return Promise.resolve();
      closed = true;
      queued = false;
      clearSaveTimer();
      clearFloorTimer();
      chain = chain.then(() => deps.roll({ final: true }));
      return chain;
    },
  };
}
