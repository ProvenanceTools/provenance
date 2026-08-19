import { describe, it, expect } from 'vitest';
import {
  resolveCapturePolicy,
  isEventKindCaptured,
  DEFAULT_CAPTURE_POLICY,
  FLOOR_EVENT_KINDS,
  POLICY_GATED_EVENT_KINDS,
  HEARTBEAT_INTERVAL_MIN_MS,
  HEARTBEAT_INTERVAL_MAX_MS,
} from './policy.js';
import type { CapturePolicy } from './policy.js';
import type { EventKind } from './events.js';

// ---------------------------------------------------------------------------
// resolveCapturePolicy — defaults
// ---------------------------------------------------------------------------

describe('resolveCapturePolicy defaults', () => {
  it('resolves an absent block to the defaults (a 1.x manifest gets today’s behaviour)', () => {
    expect(resolveCapturePolicy(undefined)).toEqual(DEFAULT_CAPTURE_POLICY);
  });

  it('defaults everything on with a 30s heartbeat', () => {
    expect(DEFAULT_CAPTURE_POLICY).toEqual({
      selection_change: true,
      focus_change: true,
      terminal: true,
      doc_open_close: true,
      inline_content: true,
      heartbeat_interval_ms: 30_000,
    });
  });

  it('resolves an empty block, an empty capture object, and a null block to the defaults', () => {
    expect(resolveCapturePolicy({})).toEqual(DEFAULT_CAPTURE_POLICY);
    expect(resolveCapturePolicy({ capture: {} })).toEqual(DEFAULT_CAPTURE_POLICY);
    expect(resolveCapturePolicy(null)).toEqual(DEFAULT_CAPTURE_POLICY);
  });

  it('returns a fresh object rather than aliasing DEFAULT_CAPTURE_POLICY', () => {
    const resolved = resolveCapturePolicy(undefined);
    expect(resolved).not.toBe(DEFAULT_CAPTURE_POLICY);
  });

  it.each([42, 'policy', [], [{ capture: {} }]])(
    'resolves the non-object block %j to the defaults',
    (block) => {
      expect(resolveCapturePolicy(block)).toEqual(DEFAULT_CAPTURE_POLICY);
    },
  );

  it('falls back per key: only the keys the course specified move', () => {
    expect(resolveCapturePolicy({ capture: { selection_change: false } })).toEqual({
      ...DEFAULT_CAPTURE_POLICY,
      selection_change: false,
    });
  });

  it('falls back to the default for a non-boolean value', () => {
    expect(resolveCapturePolicy({ capture: { terminal: 'off' } as never })).toEqual(
      DEFAULT_CAPTURE_POLICY,
    );
  });

  it('honours every boolean knob turned off', () => {
    expect(
      resolveCapturePolicy({
        capture: {
          selection_change: false,
          focus_change: false,
          terminal: false,
          doc_open_close: false,
          inline_content: false,
        },
      }),
    ).toEqual({
      selection_change: false,
      focus_change: false,
      terminal: false,
      doc_open_close: false,
      inline_content: false,
      heartbeat_interval_ms: 30_000,
    });
  });

  it('ignores unknown capture keys', () => {
    expect(
      resolveCapturePolicy({ capture: { future_signal: true, selection_change: false } as never }),
    ).toEqual({ ...DEFAULT_CAPTURE_POLICY, selection_change: false });
  });
});

// ---------------------------------------------------------------------------
// resolveCapturePolicy — heartbeat clamping
// ---------------------------------------------------------------------------

describe('resolveCapturePolicy heartbeat clamping', () => {
  it('clamps to [5000, 120000]', () => {
    expect(HEARTBEAT_INTERVAL_MIN_MS).toBe(5_000);
    expect(HEARTBEAT_INTERVAL_MAX_MS).toBe(120_000);
  });

  it.each([
    ['below the floor', 1_000, 5_000],
    ['at the floor', 5_000, 5_000],
    ['inside the range', 45_000, 45_000],
    ['at the ceiling', 120_000, 120_000],
    ['above the ceiling', 999_999, 120_000],
    ['zero', 0, 5_000],
    ['negative', -1, 5_000],
  ])('%s: %d resolves to %d', (_label, input, expected) => {
    expect(resolveCapturePolicy({ capture: { heartbeat_interval_ms: input } })).toEqual({
      ...DEFAULT_CAPTURE_POLICY,
      heartbeat_interval_ms: expected,
    });
  });

  it.each([NaN, Infinity, -Infinity])(
    'falls back to the default (not the floor) for the non-finite value %j',
    (value) => {
      expect(
        resolveCapturePolicy({ capture: { heartbeat_interval_ms: value } }).heartbeat_interval_ms,
      ).toBe(30_000);
    },
  );

  it('falls back to the default for a non-number', () => {
    expect(
      resolveCapturePolicy({ capture: { heartbeat_interval_ms: '10000' } as never })
        .heartbeat_interval_ms,
    ).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// The hard floor
// ---------------------------------------------------------------------------

describe('the hard floor', () => {
  it('is disjoint from the policy-gated set: no kind is both floor and gated', () => {
    const gated = Object.keys(POLICY_GATED_EVENT_KINDS);
    for (const kind of FLOOR_EVENT_KINDS) {
      expect(gated).not.toContain(kind);
    }
  });

  it('cannot be switched off: no capture key resolves to a gate for a floor kind', () => {
    // The stated property of the schema, exercised rather than asserted
    // structurally: drive every combination of every boolean knob and confirm no
    // floor kind ever reads as uncaptured.
    const knobs = [
      'selection_change',
      'focus_change',
      'terminal',
      'doc_open_close',
      'inline_content',
    ] as const;
    for (let mask = 0; mask < 1 << knobs.length; mask++) {
      const capture: Record<string, boolean> = {};
      knobs.forEach((knob, i) => {
        capture[knob] = (mask & (1 << i)) !== 0;
      });
      const policy = resolveCapturePolicy({ capture });
      for (const kind of FLOOR_EVENT_KINDS) {
        expect(isEventKindCaptured(kind, policy), `${kind} under mask ${mask}`).toBe(true);
      }
    }
  });

  it('covers every event kind exactly once between floor and gated (compile-time)', () => {
    type Covered = (typeof FLOOR_EVENT_KINDS)[number] | keyof typeof POLICY_GATED_EVENT_KINDS;
    type Mutual<A, B> = [A] extends [B]
      ? [B] extends [A]
        ? true
        : { missing_from_A: Exclude<B, A> }
      : { extra_in_A: Exclude<A, B> };
    // If a new event kind is added to EventKindMap without deciding whether it is
    // floor or policy-gated, this assignment stops compiling.
    const coverage: Mutual<Covered, EventKind> = true;
    expect(coverage).toBe(true);
  });

  it('lists the kinds validation checks 3–8 depend on', () => {
    for (const kind of [
      'session.start',
      'session.end',
      'session.heartbeat',
      'doc.change',
      'doc.save',
      'paste',
      'fs.external_change',
      'chain.broken',
    ] as const) {
      expect(FLOOR_EVENT_KINDS).toContain(kind);
    }
  });

  it('keeps session.heartbeat on the floor — only its interval is tunable', () => {
    expect(FLOOR_EVENT_KINDS).toContain('session.heartbeat');
    expect(Object.keys(POLICY_GATED_EVENT_KINDS)).not.toContain('session.heartbeat');
  });
});

// ---------------------------------------------------------------------------
// isEventKindCaptured
// ---------------------------------------------------------------------------

describe('isEventKindCaptured', () => {
  const allOff: CapturePolicy = {
    selection_change: false,
    focus_change: false,
    terminal: false,
    doc_open_close: false,
    inline_content: false,
    heartbeat_interval_ms: 5_000,
  };

  it('keeps every floor kind captured even with every knob off', () => {
    for (const kind of FLOOR_EVENT_KINDS) {
      expect(isEventKindCaptured(kind, allOff)).toBe(true);
    }
  });

  it.each([
    ['doc.open', 'doc_open_close'],
    ['doc.close', 'doc_open_close'],
    ['selection.change', 'selection_change'],
    ['focus.change', 'focus_change'],
    ['terminal.open', 'terminal'],
    ['terminal.command', 'terminal'],
  ] as const)('gates %s on %s', (kind, gate) => {
    expect(isEventKindCaptured(kind, allOff)).toBe(false);
    expect(isEventKindCaptured(kind, { ...allOff, [gate]: true })).toBe(true);
  });

  it('does not treat inline_content as an event gate', () => {
    // inline_content controls content snippets inside paste / fs.external_change
    // payloads; both events are on the floor and are always emitted.
    expect(isEventKindCaptured('paste', allOff)).toBe(true);
    expect(isEventKindCaptured('fs.external_change', allOff)).toBe(true);
  });
});
