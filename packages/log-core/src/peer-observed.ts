/**
 * Shape validation for the `peer.observed` payload — peer witnessing (program
 * spec §7 mechanism 2, collaboration spec §5.5, Tier 4.1).
 *
 * The type lives in `events.ts` with every other payload; the runtime narrowing
 * lives here, in the same style as `rolling-manifest.ts` and `enrollment.ts`,
 * because it is a cross-language contract rather than a private detail of one
 * reader.
 *
 * ## Why this is in log-core and not in the reader
 *
 * `ndjson.ts` deliberately does not reject unknown `kind` values and does not
 * look inside `data` at all (PRD §5.1, forward compatibility). So every consumer
 * of a `peer.observed` event has to narrow it itself, and there are four of them
 * — this monorepo's analyzer and server through `analysis-core`, plus the two
 * sibling recorder repos, which need the identical rules to emit conformant
 * payloads. One narrowing function, with vectors, is how the three ports are
 * kept from diverging. The hash chain has exactly one implementation for the
 * same reason.
 *
 * ## Why a malformed payload is REJECTED rather than partially read
 *
 * A witness is an assertion about a **different student's** artifact. A payload
 * we cannot fully narrow is an assertion we cannot evaluate, and the safe
 * direction for an unevaluable claim against a third party is to decline it —
 * never to keep the fields that happened to parse and reason from those. Half a
 * witness could name a session and omit the chain commitment that bounds what it
 * proves, which is the shape most likely to be read as stronger than it is.
 *
 * Rejection here is NOT a finding and NOT a load failure. It is one witness that
 * cannot be used, reported as such.
 *
 * ## Cross-field rule: parsed-ness is all-or-nothing
 *
 * `session_id`, `seq_high` and `last_hash` are the three values read out of the
 * foreign chain. Either the recorder parsed that chain or it did not, so these
 * are all non-null together or all null together. A payload with some of them is
 * self-contradictory — a witness claiming to know the session but not the tip is
 * exactly the half-witness above — and is rejected as `partially_parsed`.
 *
 * The one exception is not an exception at all: `state: 'unparseable'` REQUIRES
 * all three to be null, because that state is by definition the case where the
 * foreign chain could not be read.
 */

import type { PeerObservedPayload } from './events.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Every legal value of {@link PeerObservedPayload.state}, in a fixed order.
 *
 * Exported so a port can assert its own enum against it, and so
 * `tools/export-conformance-vectors.ts` publishes the set rather than restating
 * it. An unrecognised state is rejected: unlike an unknown event KIND — which is
 * forward compatibility and must pass — an unknown state inside a payload we do
 * understand would have to be given a meaning, and inventing one is how a reader
 * ends up treating an unfamiliar observation as an accusation.
 */
export const PEER_OBSERVED_STATES = [
  'appeared',
  'grew',
  'shrank',
  'disappeared',
  'unparseable',
] as const satisfies readonly PeerObservedPayload['state'][];

/** sha256 hex, lowercase, as everything else in the format spells it. */
const HEX_64_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Why a `peer.observed` payload could not be narrowed. */
export type PeerObservedShapeError =
  /** Not a JSON object. */
  | { kind: 'not_an_object' }
  /** A required field is absent or of the wrong type. */
  | { kind: 'bad_field'; field: keyof PeerObservedPayload }
  /** `state` is a string, but not one of {@link PEER_OBSERVED_STATES}. */
  | { kind: 'unknown_state'; state: string }
  /**
   * The three foreign-chain fields are not all-null or all-non-null. See the
   * module docstring: a witness that knows the session but not the tip commits
   * to nothing checkable while looking as though it does.
   */
  | { kind: 'partially_parsed'; present: readonly string[]; absent: readonly string[] }
  /**
   * `state` is `'unparseable'` yet the payload carries foreign-chain values. The
   * recorder cannot both have failed to parse the file and have read its chain.
   */
  | { kind: 'unparseable_with_chain_values'; present: readonly string[] }
  /** `seq_high` is not a non-negative integer. */
  | { kind: 'bad_seq_high'; value: number }
  /** `bytes` is not a non-negative integer. */
  | { kind: 'bad_bytes'; value: number };

/** Human-readable one-liner for a shape error. For UI and export text. */
export function describePeerObservedShapeError(error: PeerObservedShapeError): string {
  switch (error.kind) {
    case 'not_an_object':
      return 'the payload is not a JSON object';
    case 'bad_field':
      return `the field "${error.field}" is missing or of the wrong type`;
    case 'unknown_state':
      return `"${error.state}" is not a recognised observation state`;
    case 'partially_parsed':
      return (
        `the foreign chain was read only in part — ${error.present.join(', ')} present, ` +
        `${error.absent.join(', ')} absent; these are all read together or not at all`
      );
    case 'unparseable_with_chain_values':
      return (
        `the observation says the file did not parse, yet it carries ` +
        `${error.present.join(', ')} read from that file`
      );
    case 'bad_seq_high':
      return `seq_high must be a non-negative integer, not ${error.value}`;
    case 'bad_bytes':
      return `bytes must be a non-negative integer, not ${error.value}`;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Narrow an untyped `peer.observed` `data` value to a {@link PeerObservedPayload}.
 *
 * Pure and total: never throws, never mutates, and returns a `Result` because a
 * malformed payload is an EXPECTED input (the log is a student-editable file).
 *
 * Unknown extra keys are ignored, not rejected — the same forward-compatibility
 * rule `resolveCapturePolicy` applies to unknown capture keys. A future field
 * added by a newer recorder must not make this reader refuse the whole witness.
 */
export function validatePeerObservedPayload(
  value: unknown,
): Result<PeerObservedPayload, PeerObservedShapeError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'not_an_object' });
  }
  const obj = value as Record<string, unknown>;

  const file = obj['file'];
  if (typeof file !== 'string' || file.length === 0) {
    return err({ kind: 'bad_field', field: 'file' });
  }

  const sha256 = obj['sha256'];
  if (typeof sha256 !== 'string' || !HEX_64_RE.test(sha256)) {
    return err({ kind: 'bad_field', field: 'sha256' });
  }

  const bytes = obj['bytes'];
  if (typeof bytes !== 'number') {
    return err({ kind: 'bad_field', field: 'bytes' });
  }
  if (!isNonNegativeInteger(bytes)) {
    return err({ kind: 'bad_bytes', value: bytes });
  }

  const state = obj['state'];
  if (typeof state !== 'string') {
    return err({ kind: 'bad_field', field: 'state' });
  }
  if (!(PEER_OBSERVED_STATES as readonly string[]).includes(state)) {
    return err({ kind: 'unknown_state', state });
  }

  const sessionId = obj['session_id'];
  if (sessionId !== null && typeof sessionId !== 'string') {
    return err({ kind: 'bad_field', field: 'session_id' });
  }

  const seqHigh = obj['seq_high'];
  if (seqHigh !== null && typeof seqHigh !== 'number') {
    return err({ kind: 'bad_field', field: 'seq_high' });
  }
  if (typeof seqHigh === 'number' && !isNonNegativeInteger(seqHigh)) {
    return err({ kind: 'bad_seq_high', value: seqHigh });
  }

  const lastHash = obj['last_hash'];
  if (lastHash !== null && (typeof lastHash !== 'string' || !HEX_64_RE.test(lastHash))) {
    return err({ kind: 'bad_field', field: 'last_hash' });
  }

  // Cross-field: the three foreign-chain reads travel together.
  const chainFields: ReadonlyArray<[string, unknown]> = [
    ['session_id', sessionId],
    ['seq_high', seqHigh],
    ['last_hash', lastHash],
  ];
  const present = chainFields.filter(([, v]) => v !== null).map(([k]) => k);
  const absent = chainFields.filter(([, v]) => v === null).map(([k]) => k);

  if (state === 'unparseable') {
    if (present.length > 0) {
      return err({ kind: 'unparseable_with_chain_values', present });
    }
  } else if (present.length > 0 && absent.length > 0) {
    return err({ kind: 'partially_parsed', present, absent });
  }

  return ok({
    file,
    sha256,
    bytes,
    session_id: sessionId as string | null,
    seq_high: seqHigh as number | null,
    last_hash: lastHash as string | null,
    state: state as PeerObservedPayload['state'],
  });
}
