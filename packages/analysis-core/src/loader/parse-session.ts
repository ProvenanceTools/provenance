/**
 * parseSession — turn raw slog NDJSON + meta JSON into a typed ParsedSession.
 *
 * PRD §5.1 (slog format), §5.3 (meta format), §4.6 (session.start as first entry).
 *
 * Pure function: no I/O, no side effects.
 * Uses log-core's `parseEntries` and `validateMetaShape` — does NOT re-implement
 * parsing or validation.
 */

import { parseEntries, validateMetaShape, ok, err } from '@provenance/log-core';
import type { HashedEnvelope, SessionStartPayload, Result } from '@provenance/log-core';
import type { ParsedSession, SessionParseError } from './types.js';

// ---------------------------------------------------------------------------
// Type guard helpers
// ---------------------------------------------------------------------------

/**
 * Narrow an envelope to `session.start`, confirming the kind field.
 * The data is cast since log-core already validated the envelope shape.
 */
function isSessionStart(
  env: HashedEnvelope,
): env is HashedEnvelope<'session.start'> & { data: SessionStartPayload } {
  return env.kind === 'session.start';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a single session from its raw slog text and meta JSON string.
 *
 * @param slogText  Raw NDJSON text of the .slog file.
 * @param metaJson  Raw JSON text of the .slog.meta file.
 * @param hashes    Hex sha256 of the two files' bytes as they sat in the ZIP,
 *                  computed by the unzipper before decoding. Carried through
 *                  verbatim so `validation/verify-log-bytes.ts` can compare them
 *                  against the signed manifest's commitments; this function
 *                  never recomputes or second-guesses them.
 * @returns A typed ParsedSession, or a SessionParseError describing the failure.
 */
export function parseSession(
  slogText: string,
  metaJson: string,
  hashes: { slogSha256: string; metaSha256: string },
): Result<ParsedSession, SessionParseError> {
  // ---------------------------------------------------------------------------
  // 1. Parse NDJSON entries.
  // ---------------------------------------------------------------------------
  const entriesResult = parseEntries(slogText);
  if (!entriesResult.ok) {
    const e = entriesResult.error;
    return err({
      kind: 'ndjson_parse_failed',
      line: e.line,
      detail:
        e.kind === 'invalid_json'
          ? e.message
          : `invalid_shape: missing field '${e.missing_field ?? 'unknown'}'`,
    });
  }

  const events = entriesResult.value;

  // ---------------------------------------------------------------------------
  // 2. Check first event is session.start.
  // ---------------------------------------------------------------------------
  const first = events[0];
  if (first === undefined || !isSessionStart(first)) {
    return err({
      kind: 'first_event_not_session_start',
      actualKind: first?.kind ?? 'none',
    });
  }

  const firstEvent = first;
  const slogSessionId = firstEvent.data.session_id;

  // ---------------------------------------------------------------------------
  // 3. Parse and validate meta JSON.
  // ---------------------------------------------------------------------------
  let rawMeta: unknown;
  try {
    rawMeta = JSON.parse(metaJson);
  } catch (e) {
    return err({
      kind: 'meta_invalid_shape',
      detail: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const metaResult = validateMetaShape(rawMeta);
  if (!metaResult.ok) {
    const me = metaResult.error;
    const detail =
      me.kind === 'not_object'
        ? 'not_object'
        : me.kind === 'wrong_version'
          ? `wrong_version: ${String(me.actual)}`
          : me.kind === 'missing_field'
            ? `missing_field: ${me.field}`
            : `invalid_field: ${me.field} — ${me.reason}`;
    return err({ kind: 'meta_invalid_shape', detail });
  }

  const meta = metaResult.value;

  // ---------------------------------------------------------------------------
  // 4. Validate session_id consistency.
  // ---------------------------------------------------------------------------
  if (meta.session_id !== slogSessionId) {
    return err({
      kind: 'session_id_mismatch',
      slogSessionId,
      metaSessionId: meta.session_id,
    });
  }

  return ok({
    sessionId: slogSessionId,
    events,
    meta,
    slogSha256: hashes.slogSha256,
    metaSha256: hashes.metaSha256,
    firstEvent,
  });
}
