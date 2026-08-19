/**
 * Capture policy — the professor-facing control over what a recorder records.
 *
 * Program spec: `docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md` §4.
 *
 * The block lives INSIDE the course-signed manifest payload, which is the whole
 * point: a professor can turn capture down, a student cannot turn it off.
 *
 * ```jsonc
 * "policy": {
 *   "capture": {
 *     "selection_change":      true,
 *     "focus_change":          true,
 *     "terminal":              true,
 *     "inline_content":        true,   // paste + fs.external_change content snippets
 *     "heartbeat_interval_ms": 30000   // clamped to [5000, 120000]
 *   }
 * }
 * ```
 *
 * ## The hard floor
 *
 * Most event kinds cannot be disabled at all, because validation checks 3–8 and
 * the integrity story depend on them. The floor is enforced **by the schema
 * itself**: a floor event simply has no key in `policy.capture`, so there is no
 * way to express "off" for it. {@link FLOOR_EVENT_KINDS} is that set written out
 * so an implementation can assert it, and {@link POLICY_GATED_EVENT_KINDS} is
 * its complement — the only kinds a policy can reach.
 *
 * ## Where the floor is drawn
 *
 * **The floor is defined by what reconstruction and validation depend on, not by
 * privacy sensitivity.** A signal being sensitive is an argument *for* giving it
 * a knob; a signal being load-bearing is a *veto* on one. Nothing critical to
 * reconstruction may be disableable by capture policy — if it were, a course
 * could switch off file reconstruction, replay, and the Source tab for its whole
 * cohort with nothing warning it that it had. Apply that test before adding any
 * key here.
 *
 * ## The absence-vs-disabled rule
 *
 * The effective policy MUST travel into the bundle (it does, inside the manifest
 * carried by `session.start`). Without it the analyzer cannot tell "this student
 * produced no `selection.change` events" from "this course disabled
 * `selection.change`", and heuristics mis-fire on the difference. Any heuristic
 * consuming an optional signal must consult the recorded policy and return
 * *not-applicable* rather than a flag or a zero.
 *
 * ## Permanent constraint: no user-derived object keys
 *
 * Every key in `policy.capture` is a fixed ASCII identifier chosen by us, and
 * every future addition must be too. Never a course id, assignment id, path, or
 * any other user-supplied string promoted to a key. provnvim's hand-rolled Lua
 * JCS sorts object keys bytewise while the JS and Kotlin implementations sort by
 * UTF-16 code unit; the two agree only for ASCII. A non-ASCII key would silently
 * produce divergent canonical bytes and break signature cross-verification
 * between recorders. Values are unconstrained. See also `course-cert.ts`.
 */

import type { EventKind } from './events.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The `policy` block exactly as it appears in the manifest — every key optional,
 * because a course may specify only the knobs it cares about.
 *
 * NOTE: this type describes the *known* keys. When canonicalizing for signature
 * purposes the block is passed through verbatim, unknown keys included, because
 * it sits inside the course-signed payload and must round-trip byte-for-byte.
 */
export type CapturePolicyBlock = {
  capture?: {
    selection_change?: boolean;
    focus_change?: boolean;
    terminal?: boolean;
    inline_content?: boolean;
    heartbeat_interval_ms?: number;
  };
};

/** The resolved, fully-populated policy a recorder actually runs against. */
export type CapturePolicy = {
  /** Capture `selection.change` events. */
  selection_change: boolean;
  /** Capture `focus.change` events. */
  focus_change: boolean;
  /** Capture `terminal.open` and `terminal.command` events. */
  terminal: boolean;
  /**
   * Inline content snippets in `paste` and `fs.external_change` payloads.
   * Not an event gate — the events themselves are on the floor; this controls
   * whether their `content` / `new_content` fields are populated.
   */
  inline_content: boolean;
  /** Heartbeat cadence in milliseconds, always within the clamp range. */
  heartbeat_interval_ms: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Applied when the manifest carries no `policy` block at all, and per-key when a
 * key is absent or malformed. Everything on, 30s heartbeat — i.e. exactly the
 * v1.x recorder behaviour, so a 1.x manifest resolves to today's capture set.
 */
export const DEFAULT_CAPTURE_POLICY: CapturePolicy = {
  selection_change: true,
  focus_change: true,
  terminal: true,
  inline_content: true,
  heartbeat_interval_ms: 30_000,
};

/** Inclusive lower clamp for `heartbeat_interval_ms` (program spec §4). */
export const HEARTBEAT_INTERVAL_MIN_MS = 5_000;

/** Inclusive upper clamp for `heartbeat_interval_ms` (program spec §4). */
export const HEARTBEAT_INTERVAL_MAX_MS = 120_000;

/**
 * Event kinds that can NEVER be disabled, because validation checks 3–8 and the
 * integrity story depend on them.
 *
 * These have no key in `policy.capture` **by design** — the schema is the
 * enforcement mechanism, this list is only the assertable statement of it. Do
 * not add a `policy.capture` key for anything on this list.
 *
 * `session.heartbeat` is here because bundle-level Active/Idle and the
 * `gap_in_heartbeats` heuristic depend on it; only its *interval* is tunable.
 *
 * `paste.anomaly` is on the floor by the schema rule (it has no
 * `policy.capture` key) even though program spec §4's prose list omits it. It is
 * a paste-integrity signal, so floor is the correct and safe reading.
 *
 * `doc.open` and `doc.close` are here — there was briefly a `doc_open_close`
 * knob, and it was removed. `DocOpenPayload.content` is the **reconstruction
 * seed**: `reconstruct-file.ts` starts from it, so switching `doc.open` off
 * breaks file reconstruction, replay, and the Source tab for the entire cohort,
 * with nothing telling the course it had done that. That makes it load-bearing,
 * and load-bearing vetoes a knob regardless of how sensitive the signal is.
 * `DocClosePayload` is `{ path }` only — no content, no reconstruction role, and
 * so negligible privacy exposure: a knob governing a bare path is surface for
 * nothing. Both are floor.
 */
export const FLOOR_EVENT_KINDS = [
  'session.start',
  'session.end',
  'session.resumed',
  'session.heartbeat',
  'doc.open',
  'doc.close',
  'doc.change',
  'doc.save',
  'paste',
  'paste.anomaly',
  'fs.external_change',
  'git.event',
  'clock.skew',
  'chain.broken',
  'ext.snapshot',
  'ext.activate',
  'recorder.degraded',
  'recorder.recovered_from_corruption',
] as const satisfies readonly EventKind[];

/**
 * The complement of {@link FLOOR_EVENT_KINDS}: every event kind a policy can
 * switch off, mapped to the boolean key that switches it.
 *
 * `FLOOR_EVENT_KINDS ∪ keys(POLICY_GATED_EVENT_KINDS)` is exactly `EventKind`;
 * `policy.test.ts` asserts that at compile time.
 */
export const POLICY_GATED_EVENT_KINDS = {
  'selection.change': 'selection_change',
  'focus.change': 'focus_change',
  'terminal.open': 'terminal',
  'terminal.command': 'terminal',
} as const satisfies Readonly<Partial<Record<EventKind, keyof CapturePolicy>>>;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function resolveBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Clamp `heartbeat_interval_ms` into `[HEARTBEAT_INTERVAL_MIN_MS,
 * HEARTBEAT_INTERVAL_MAX_MS]`.
 *
 * A non-number, `NaN`, or non-finite value falls back to the default rather than
 * clamping — clamping `NaN` is meaningless, and a course that wrote garbage here
 * should get the safe cadence, not the floor.
 */
function resolveHeartbeatInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CAPTURE_POLICY.heartbeat_interval_ms;
  }
  if (value < HEARTBEAT_INTERVAL_MIN_MS) return HEARTBEAT_INTERVAL_MIN_MS;
  if (value > HEARTBEAT_INTERVAL_MAX_MS) return HEARTBEAT_INTERVAL_MAX_MS;
  return value;
}

/**
 * Resolve a manifest `policy` block into the effective {@link CapturePolicy}.
 *
 * Total by construction: any absent, malformed, or out-of-range input resolves
 * to a well-defined value, so this never fails and returns no `Result`. A
 * missing block (a 1.x manifest, or a 2.0 manifest whose course specified
 * nothing) resolves to {@link DEFAULT_CAPTURE_POLICY}.
 *
 * Takes `unknown` so it can be applied directly to untrusted parsed JSON.
 */
export function resolveCapturePolicy(block?: CapturePolicyBlock | unknown): CapturePolicy {
  if (typeof block !== 'object' || block === null || Array.isArray(block)) {
    return { ...DEFAULT_CAPTURE_POLICY };
  }
  const capture = (block as Record<string, unknown>)['capture'];
  if (typeof capture !== 'object' || capture === null || Array.isArray(capture)) {
    return { ...DEFAULT_CAPTURE_POLICY };
  }
  const c = capture as Record<string, unknown>;

  return {
    selection_change: resolveBool(c['selection_change'], DEFAULT_CAPTURE_POLICY.selection_change),
    focus_change: resolveBool(c['focus_change'], DEFAULT_CAPTURE_POLICY.focus_change),
    terminal: resolveBool(c['terminal'], DEFAULT_CAPTURE_POLICY.terminal),
    inline_content: resolveBool(c['inline_content'], DEFAULT_CAPTURE_POLICY.inline_content),
    heartbeat_interval_ms: resolveHeartbeatInterval(c['heartbeat_interval_ms']),
  };
}

/**
 * Is `kind` captured under `policy`?
 *
 * Floor kinds always return `true` — there is no key that could turn them off.
 */
export function isEventKindCaptured(kind: EventKind, policy: CapturePolicy): boolean {
  const gate = (POLICY_GATED_EVENT_KINDS as Readonly<Record<string, keyof CapturePolicy>>)[kind];
  if (gate === undefined) return true;
  const value = policy[gate];
  // Every gated kind maps to a boolean key; the numeric key is never a gate.
  return typeof value === 'boolean' ? value : true;
}
