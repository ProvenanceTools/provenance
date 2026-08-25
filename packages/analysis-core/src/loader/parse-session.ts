/**
 * parseSession — turn raw slog NDJSON + meta JSON into a typed ParsedSession.
 *
 * PRD §5.1 (slog format), §5.3 (meta format), §4.6 (session.start as first entry).
 *
 * Pure function: no I/O, no side effects.
 * Uses log-core's `parseEntries` and `validateMetaShape` — does NOT re-implement
 * parsing or validation.
 */

import { parseEntriesToleratingTornTail, validateMetaShape, ok, err } from '@provenance/log-core';
import type { HashedEnvelope, SessionStartPayload, Result } from '@provenance/log-core';
import type { ParsedSession, SessionParseError } from './types.js';
import { lfNormalizedSha256 } from './line-endings.js';

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
  //
  // A TORN FINAL LINE — a fragment with no terminator, left by a write
  // interrupted part-way through — is tolerated, truncated away and REPORTED.
  // It is the one corruption an honest student produces by doing nothing at
  // all (a power cut, a full disk, an OS kill mid-flush), it arrives under the
  // log's completely normal filename so no name-based guard can see it, and
  // failing on it cost that student every session in the submission because
  // `parse-bundle.ts` returns this error for the whole bundle.
  //
  // A corrupt line in the MIDDLE is a different fact and still fails here. See
  // `log-core/ndjson.ts` for the byte-level rule that separates them.
  //
  // NOTHING BELOW IS RECOMPUTED FROM THE TRUNCATED VIEW. `hashes` come from the
  // unzipper's read of the raw archive bytes and are carried through verbatim,
  // and `slogSha256Lf` is derived from the FULL `slogText`. That is what keeps
  // truncation from being able to launder a modification: a caller that hashed
  // only what was kept would let someone append past a seal, tear the last
  // line, and turn a failing `log_bytes_match` into a passing one. The rolling
  // seal's prefix search is likewise run by `parse-bundle.ts` over
  // `SessionFiles.slogText`, the full text, never over this parse.
  // ---------------------------------------------------------------------------
  const entriesResult = parseEntriesToleratingTornTail(slogText);
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

  const { entries: events, tornTail } = entriesResult.value;

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
    // Computed HERE because this is the last point that holds the log text —
    // `ParsedSession` deliberately keeps only digests. Costs one substring scan
    // on a normal `.slog` and hashes nothing unless CRLF is actually present.
    slogSha256Lf: lfNormalizedSha256(slogText, hashes.slogSha256),
    metaSha256: hashes.metaSha256,
    firstEvent,
    tornTail:
      tornTail === null
        ? null
        : {
            line: tornTail.line,
            discardedChars: tornTail.discardedChars,
            // Staff-facing prose. It states what is established (the file ends
            // mid-line, and those bytes are not an entry), names the innocent
            // reading FIRST because it is the only one a recorder can produce,
            // and warns about the one downstream reading that could otherwise
            // be misread as deletion. It asserts nothing about how it got
            // there — the same discipline D16 and the `no_session_log` rewrite
            // applied.
            detail:
              `This log ends part-way through line ${tornTail.line}: ` +
              `${tornTail.discardedChars} character(s) with no line terminator, which are not a ` +
              `complete entry (${tornTail.reason}). The recorder appends a whole line at a ` +
              `time, so an unterminated final line is the signature of an INTERRUPTED WRITE — a ` +
              `power cut, a full disk, or the editor being killed mid-flush. Everything before ` +
              `it was read and analysed in full, and the hash chain, the signed checkpoints and ` +
              `the seal all still cover it. The fragment was left out of the analysis only; ` +
              `nothing was altered or deleted, and the archived bytes are still what every ` +
              `digest check compares against. Note that if a signed checkpoint names a sequence ` +
              `number inside the lost fragment, it will read as a missing entry: that is this ` +
              `same interruption, not a removal.`,
          },
  });
}
