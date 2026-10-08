import { describe, it, expect } from 'vitest';
import {
  createRollingSealScheduler,
  ROLLING_SEAL_MIN_INTERVAL_MS,
  ROLLING_SEAL_SAVE_DEBOUNCE_MS,
} from './rolling-seal-scheduler.js';
import type { SealTimers } from './rolling-seal-scheduler.js';

/** Manual time + timers: nothing fires until `advance` is called. */
function makeFake() {
  let t = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const seams: SealTimers = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  return {
    now: () => t,
    timers: seams,
    pending: () => timers.size,
    async advance(ms: number): Promise<void> {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, v]) => v.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
        await settle();
      }
      t = target;
      await settle();
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function setup(enabled = true) {
  const fake = makeFake();
  const events: string[] = [];
  let gate: Promise<void> | undefined;
  const s = createRollingSealScheduler({
    enabled,
    now: fake.now,
    timers: fake.timers,
    prepare: () => {
      events.push('flush');
      return Promise.resolve();
    },
    roll: async ({ final }) => {
      events.push(final ? 'roll:final' : 'roll');
      if (gate) await gate;
    },
  });
  return {
    fake,
    events,
    s,
    holdRolls(): () => void {
      let release!: () => void;
      gate = new Promise<void>((r) => (release = r));
      return () => {
        gate = undefined;
        release();
      };
    },
  };
}

describe('rolling seal scheduler', () => {
  it('rolls within the debounce after a save despite a recent roll, flushing first', async () => {
    const { fake, events, s } = setup();
    await s.rollNow();
    await fake.advance(5_000); // well inside the 60 s floor
    events.length = 0;
    s.onSave();
    await fake.advance(ROLLING_SEAL_SAVE_DEBOUNCE_MS - 1);
    expect(events).toEqual([]);
    await fake.advance(1);
    expect(events).toEqual(['flush', 'roll']);
  });

  it('collapses a burst of saves into one roll (trailing debounce)', async () => {
    const { fake, events, s } = setup();
    await s.rollNow();
    events.length = 0;
    for (let i = 0; i < 5; i++) {
      s.onSave();
      await fake.advance(400);
    }
    expect(events).toEqual([]); // each save pushed the roll out
    await fake.advance(ROLLING_SEAL_SAVE_DEBOUNCE_MS);
    expect(events).toEqual(['flush', 'roll']);
  });

  it('defers a too-soon checkpoint roll to when the floor expires instead of dropping it', async () => {
    const { fake, events, s } = setup();
    await s.rollNow();
    await fake.advance(10_000);
    events.length = 0;
    await s.onCheckpoint();
    await s.onCheckpoint(); // coalesced: still one timer
    expect(events).toEqual([]);
    expect(fake.pending()).toBe(1);
    await fake.advance(ROLLING_SEAL_MIN_INTERVAL_MS - 10_000 - 1);
    expect(events).toEqual([]);
    await fake.advance(1);
    expect(events).toEqual(['flush', 'roll']);
  });

  it('rolls a checkpoint immediately once the floor has elapsed', async () => {
    const { fake, events, s } = setup();
    await s.rollNow();
    await fake.advance(ROLLING_SEAL_MIN_INTERVAL_MS);
    events.length = 0;
    await s.onCheckpoint();
    expect(events).toEqual(['flush', 'roll']);
    expect(fake.pending()).toBe(0);
  });

  it('at most one roll in flight and one queued behind it (latest wins)', async () => {
    const { fake, events, s, holdRolls } = setup();
    await s.rollNow();
    events.length = 0;
    const release = holdRolls();
    s.onSave();
    await fake.advance(ROLLING_SEAL_SAVE_DEBOUNCE_MS); // roll #1 starts, blocked
    s.onSave();
    await fake.advance(ROLLING_SEAL_SAVE_DEBOUNCE_MS); // queued
    s.onSave();
    await fake.advance(ROLLING_SEAL_SAVE_DEBOUNCE_MS); // still just queued
    expect(events.filter((e) => e === 'roll')).toHaveLength(1);
    release();
    await settle();
    expect(events.filter((e) => e === 'roll')).toHaveLength(2);
  });

  it('dispose cancels pending timers and the final roll is the last write', async () => {
    const { fake, events, s } = setup();
    await s.rollNow();
    await fake.advance(1_000);
    events.length = 0;
    s.onSave();
    await s.onCheckpoint(); // schedules a floor timer too
    expect(fake.pending()).toBe(2);
    await s.finalRoll();
    expect(fake.pending()).toBe(0);
    await fake.advance(10 * ROLLING_SEAL_MIN_INTERVAL_MS);
    expect(events).toEqual(['roll:final']);
    s.onSave(); // post-dispose requests are ignored
    expect(fake.pending()).toBe(0);
  });

  it('final roll waits for an in-flight roll and discards the queued one', async () => {
    const { fake, events, s, holdRolls } = setup();
    await s.rollNow();
    events.length = 0;
    const release = holdRolls();
    s.onSave();
    await fake.advance(ROLLING_SEAL_SAVE_DEBOUNCE_MS); // in flight
    s.onSave();
    await fake.advance(ROLLING_SEAL_SAVE_DEBOUNCE_MS); // queued
    const done = s.finalRoll();
    release();
    await done;
    await settle();
    expect(events).toEqual(['flush', 'roll', 'roll:final']);
  });

  it('is a complete no-op when disabled (bundle submission)', async () => {
    const { fake, events, s } = setup(false);
    await s.rollNow();
    s.onSave();
    await s.onCheckpoint();
    await fake.advance(10 * ROLLING_SEAL_MIN_INTERVAL_MS);
    await s.finalRoll();
    expect(events).toEqual([]);
    expect(fake.pending()).toBe(0);
  });
});
