/**
 * Tests for the gap_in_heartbeats heuristic (Phase 17).
 */

import { describe, it, expect } from 'vitest';
import { gapInHeartbeatsHeuristic } from './gap-in-heartbeats.js';
import { buildIndex } from '../index/build-index.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { mergeConfig } from './config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildAndIndex(opts: Parameters<typeof buildTestBundle>[0]) {
  const { zipBuffer } = await buildTestBundle(opts);
  const result = await loadBundle(new Blob([zipBuffer]), 'test.zip');
  if (!result.ok) throw new Error(`Bundle load failed: ${JSON.stringify(result.error)}`);
  return { index: buildIndex(result.value), bundle: result.value };
}

// Tight config: flag gaps > 2 minutes
const testConfig = mergeConfig({ gapInHeartbeats: { gapThresholdMs: 2 * 60_000 } });
const defaultConfig = mergeConfig();

// ISO wall helper: base + offset in minutes
function wallPlusMinutes(baseMs: number, minutes: number): string {
  return new Date(baseMs + minutes * 60_000).toISOString();
}

// Base epoch for tests: 2026-01-15T10:00:00.000Z
const BASE_MS = new Date('2026-01-15T10:00:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------------

describe('gap_in_heartbeats — negative', () => {
  it('produces no flags when no heartbeat events', async () => {
    const { index, bundle } = await buildAndIndex({ sessions: [{ eventCount: 3 }] });
    const flags = gapInHeartbeatsHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags with only one heartbeat event (need at least two)', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 0),
              t: 1000,
            },
          ],
        },
      ],
    });
    const flags = gapInHeartbeatsHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when consecutive heartbeats are close together', async () => {
    // Gap of 1 minute < 5-minute default threshold
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 0),
              t: 1000,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 1),
              t: 61_000,
            },
          ],
        },
      ],
    });
    const flags = gapInHeartbeatsHeuristic.run(index, bundle, defaultConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when a gap contains zero events of any kind (machine suspend)', async () => {
    // Regression test (2026-07 suspend-aware revision): a large wall-clock gap
    // between two heartbeats with NO other events recorded in between is the
    // signature of machine sleep (OS suspends the extension host — no timers
    // fire, so nothing is written — but the extension is never deactivated,
    // so no session.end is written either). This must not be flagged.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 0),
              t: 1000,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 10),
              t: 601_000,
            },
          ],
        },
      ],
    });
    // testConfig: threshold=2min; gap is 10min but nothing else was recorded
    // in the gap → not flagged.
    const flags = gapInHeartbeatsHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });

  it('produces no flags when a session.end exists between the gapped heartbeats', async () => {
    // Large gap but with a session.end between the two heartbeats → expected
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 0),
              t: 1000,
            },
            {
              kind: 'session.end',
              data: { reason: 'deactivate' },
              wall: wallPlusMinutes(BASE_MS, 1),
              t: 61_000,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 20),
              t: 1_201_000,
            },
          ],
        },
      ],
    });
    // testConfig: threshold=2min; gap is 20min but session.end is in between → no flag
    const flags = gapInHeartbeatsHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });

  it('does not flag when the only intervening event fired in the wake batch', async () => {
    // Regression: on wake, every timer that came due while the machine was
    // suspended fires in one batch, so an ext.snapshot tick lands a few ms
    // after the heartbeat that opens the gap. By seq it sits "inside" the gap,
    // but nothing ran during the intervening 10 minutes. Observed in real
    // bundles as 69 of 74 residual flags (median 1ms from the boundary).
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 0),
              t: 1000,
            },
            {
              kind: 'ext.snapshot',
              data: { extensions: [] },
              // 5ms after the opening heartbeat — same wake batch.
              wall: new Date(BASE_MS + 5).toISOString(),
              t: 1005,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 600_000 },
              wall: wallPlusMinutes(BASE_MS, 10),
              t: 601_000,
            },
          ],
        },
      ],
    });
    const flags = gapInHeartbeatsHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });

  it('does not flag the gap across a rotation seam', async () => {
    // Heartbeats are grouped by session.start.data.session_id (index.bySessionId),
    // so a rotation seam can never produce a "consecutive heartbeat" pair that
    // spans it — session A's heartbeats and session B's heartbeats are simply
    // two disjoint, well-behaved 30s-apart pairs. This pins that a rotation
    // (session.end {reason:'rotate'} followed by a linked session.start) never
    // manufactures a cross-session gap. See
    // docs/superpowers/specs/2026-09-21-log-size-rotation-design.md §3.3.
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          sessionId: 'cccccccc-0000-4000-8000-000000000001',
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 0),
              t: 1000,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: new Date(BASE_MS + 30_000).toISOString(),
              t: 31_000,
            },
            {
              kind: 'session.end',
              data: { reason: 'rotate' },
              wall: new Date(BASE_MS + 30_000).toISOString(),
              t: 31_000,
            },
          ],
        },
        {
          sessionId: 'cccccccc-0000-4000-8000-000000000002',
          sessionStart: { prev_session_id: 'cccccccc-0000-4000-8000-000000000001' },
          walls: [new Date(BASE_MS + 31_000).toISOString()],
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: new Date(BASE_MS + 31_000).toISOString(),
              t: 1000,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: new Date(BASE_MS + 61_000).toISOString(),
              t: 31_000,
            },
          ],
        },
      ],
    });
    const flags = gapInHeartbeatsHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Positive cases
// ---------------------------------------------------------------------------

describe('gap_in_heartbeats — positive', () => {
  it('flags a gap > threshold with an intervening event and no session.end between heartbeats', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 0),
              t: 1000,
            },
            // Any event (not just heartbeats) recorded inside the gap proves
            // the recorder process was alive — this is what distinguishes a
            // stalled/tampered recorder from a machine-sleep gap.
            {
              kind: 'ext.snapshot',
              data: { extensions: [] },
              wall: wallPlusMinutes(BASE_MS, 5),
              t: 301_000,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: false, active_file: null, idle_since_ms: 600_000 },
              wall: wallPlusMinutes(BASE_MS, 10),
              t: 601_000,
            },
          ],
        },
      ],
    });
    // testConfig: threshold=2min; gap is 10min with an intervening event → flag
    const flags = gapInHeartbeatsHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.heuristic).toBe('gap_in_heartbeats');
    expect(flags[0]!.severity).toBe('medium');
    expect(flags[0]!.confidence).toBe(0.75);
    expect(flags[0]!.detail!['gapMs']).toBeCloseTo(10 * 60_000, -1);
    expect(flags[0]!.supportingSeqs).toHaveLength(2);
  });

  it('emits one flag per gap (multiple gaps → multiple flags)', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 0),
              t: 1000,
            },
            // Intervening event in gap 1 (0min → 10min).
            {
              kind: 'ext.snapshot',
              data: { extensions: [] },
              wall: wallPlusMinutes(BASE_MS, 5),
              t: 301_000,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 10),
              t: 601_000,
            },
            // Intervening event in gap 2 (10min → 25min).
            {
              kind: 'ext.snapshot',
              data: { extensions: [] },
              wall: wallPlusMinutes(BASE_MS, 15),
              t: 901_000,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 25),
              t: 1_501_000,
            },
          ],
        },
      ],
    });
    // Two consecutive 10-min and 15-min gaps, each with an intervening event → two flags
    const flags = gapInHeartbeatsHeuristic.run(index, bundle, testConfig);
    expect(flags).toHaveLength(2);
  });

  it('flag IDs are unique and deterministic', async () => {
    const { index, bundle } = await buildAndIndex({
      sessions: [
        {
          events: [
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 0),
              t: 1000,
            },
            {
              kind: 'ext.snapshot',
              data: { extensions: [] },
              wall: wallPlusMinutes(BASE_MS, 5),
              t: 301_000,
            },
            {
              kind: 'session.heartbeat',
              data: { focused: true, active_file: null, idle_since_ms: 0 },
              wall: wallPlusMinutes(BASE_MS, 10),
              t: 601_000,
            },
          ],
        },
      ],
    });
    const flags1 = gapInHeartbeatsHeuristic.run(index, bundle, testConfig);
    const flags2 = gapInHeartbeatsHeuristic.run(index, bundle, testConfig);
    expect(flags1[0]!.id).toBe(flags2[0]!.id);
  });
});
