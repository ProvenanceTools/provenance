/**
 * NDJSON serialization and parsing for HashedEnvelope entries.
 * PRD §4.6 / §5.1 — log file is newline-delimited JSON, one event per line.
 */

import type { HashedEnvelope } from './envelope.js';
import { canonicalize } from './canonical.js';
import { ok, err } from './result.js';
import type { Result } from './result.js';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type ParseError =
  | { kind: 'invalid_json'; line: number; message: string }
  | { kind: 'invalid_shape'; line: number; missing_field?: string };

/**
 * A trailing fragment that is not a complete entry — the residue of a write
 * that was interrupted part-way through a line.
 *
 * Reported, never inferred and never silent. See
 * {@link parseEntriesToleratingTornTail}.
 */
export type TornTail = {
  /** 1-indexed line number of the incomplete final line. */
  line: number;
  /** How many characters were discarded. */
  discardedChars: number;
  /** Why the fragment could not be read as an entry. */
  reason: string;
};

/** {@link parseEntriesToleratingTornTail}'s success value. */
export type TolerantParse = {
  entries: readonly HashedEnvelope[];
  /** Non-null iff a trailing fragment was discarded. */
  tornTail: TornTail | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEX_64_RE = /^[0-9a-f]{64}$/;

/**
 * Shape-validate a parsed JSON value as a HashedEnvelope.
 * Validates that all required fields are present and have the correct basic types.
 * Does NOT validate chain linkage — that is the validator's job.
 * Does NOT reject unknown `kind` values (PRD §5.1: forward compat).
 */
function validateShape(value: unknown, lineNumber: number): Result<HashedEnvelope, ParseError> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return err({ kind: 'invalid_shape', line: lineNumber });
  }

  const obj = value as Record<string, unknown>;

  // seq: number
  if (typeof obj['seq'] !== 'number') {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'seq' });
  }
  // t: number
  if (typeof obj['t'] !== 'number') {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 't' });
  }
  // wall: string
  if (typeof obj['wall'] !== 'string') {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'wall' });
  }
  // kind: string
  if (typeof obj['kind'] !== 'string') {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'kind' });
  }
  // data: object (any shape)
  if (typeof obj['data'] !== 'object' || obj['data'] === null || Array.isArray(obj['data'])) {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'data' });
  }
  // prev_hash: string, 64 hex chars
  if (typeof obj['prev_hash'] !== 'string' || !HEX_64_RE.test(obj['prev_hash'])) {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'prev_hash' });
  }
  // hash: string, 64 hex chars
  if (typeof obj['hash'] !== 'string' || !HEX_64_RE.test(obj['hash'])) {
    return err({ kind: 'invalid_shape', line: lineNumber, missing_field: 'hash' });
  }

  // Safe cast: all required fields validated above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ok(value as HashedEnvelope<any>);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize a HashedEnvelope to a single NDJSON line (JCS canonical JSON + newline).
 *
 * The canonical form ensures that hashes over these bytes remain stable regardless
 * of insertion order or whitespace.
 */
export function serializeEntry(entry: HashedEnvelope): string {
  return canonicalize(entry) + '\n';
}

/**
 * Parse a multi-line NDJSON string into an array of HashedEnvelopes.
 *
 * - Splits on '\n'.
 * - Skips empty trailing lines.
 * - JSON-parses each non-empty line and shape-validates it.
 * - Returns on the first error; does not accumulate multiple errors.
 * - Line numbers in errors are 1-indexed.
 */
export function parseEntries(text: string): Result<readonly HashedEnvelope[], ParseError> {
  // Empty string → zero entries (valid)
  if (text === '') {
    return ok([]);
  }

  const lines = text.split('\n');
  const entries: HashedEnvelope[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip empty lines (trailing newline produces one)
    // `lines[i]` is typed as `string | undefined` due to `noUncheckedIndexedAccess`;
    // at runtime `split('\n')` never produces undefined, but the check is required to satisfy the type.
    if (line === '' || line === undefined) {
      continue;
    }

    const lineNumber = i + 1;

    // JSON parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return err({ kind: 'invalid_json', line: lineNumber, message });
    }

    // Shape validate
    const result = validateShape(parsed, lineNumber);
    if (!result.ok) {
      return result;
    }

    entries.push(result.value);
  }

  return ok(entries);
}

/**
 * Parse NDJSON, tolerating a TORN FINAL LINE and reporting it.
 *
 * ## What this is for
 *
 * A `.slog` is written by appending `canonicalize(entry) + '\n'`. An
 * interruption part-way through that write — a power cut, a full disk, an OS
 * kill mid-flush — leaves the file ending in a fragment of a line with **no
 * terminator**. It is the only corruption shape an honest student can produce
 * without doing anything at all, and it arrives under the log's completely
 * normal filename, so no name-based guard can catch it.
 *
 * `parseEntries` rejects it, and the loader turned that rejection into the loss
 * of every session in the submission. This function keeps the complete prefix,
 * which is what the recorder actually managed to write and what the hash chain,
 * the checkpoints and the seal all cover.
 *
 * ## The rule, and why it is a byte-level rule rather than a judgement
 *
 * Tolerance applies to **exactly one thing**: the characters after the final
 * `'\n'`, and only when the text does not end in `'\n'` at all. A completed
 * append always ends the line, so:
 *
 *  - a file ending in `'\n'` has no torn tail by construction, and any parse
 *    failure in it is a MIDDLE failure — not a crash artifact, and it is
 *    returned as an error exactly as before;
 *  - a corrupt line anywhere before the final segment is likewise still an
 *    error, even when a torn tail is also present. The tail cannot be used as
 *    cover for an edit further up.
 *
 * The fragment is discarded only if it does not parse. A complete entry that
 * merely lost its terminator is a complete entry and is KEPT — throwing away a
 * real, chained event over a missing byte would be its own small injustice.
 *
 * ## What tolerance does NOT buy an attacker
 *
 * The discarded fragment is by definition unparseable, so it never carried an
 * event and there is nothing in it to hide. What matters is what callers do
 * NEXT: the digests that `log_bytes_match` compares, and the bytes a rolling
 * seal's prefix search runs over, must stay the **archived** ones. A caller
 * that re-hashed the truncated view would let someone append past a seal, tear
 * the last line, and turn a failing byte check into a passing one — strictly
 * worse than the bug this exists to fix. This function therefore returns only
 * entries and a report; it never returns text, and no digest is computed here.
 *
 * @param text Raw `.slog` contents.
 * @returns The entries, plus a {@link TornTail} report when one was discarded.
 */
export function parseEntriesToleratingTornTail(text: string): Result<TolerantParse, ParseError> {
  // Nothing to tolerate: an empty file, or one whose last line was terminated.
  if (text === '' || text.endsWith('\n')) {
    const strict = parseEntries(text);
    return strict.ok ? ok({ entries: strict.value, tornTail: null }) : strict;
  }

  const lastNewline = text.lastIndexOf('\n');
  // `body` keeps its terminator so line numbering is identical to the strict
  // parse — the fragment is line `body`'s line count + 1 either way.
  const body = text.slice(0, lastNewline + 1);
  const fragment = text.slice(lastNewline + 1);

  const bodyResult = parseEntries(body);
  if (!bodyResult.ok) {
    // A failure BEFORE the final segment. Not a crash artifact, and not made
    // one by the presence of a torn tail.
    return bodyResult;
  }

  const fragmentLine = body === '' ? 1 : body.split('\n').length;

  // The fragment may be a whole entry that merely lost its newline. Ask.
  const tail = parseEntries(fragment);
  if (tail.ok) {
    return ok({ entries: [...bodyResult.value, ...tail.value], tornTail: null });
  }

  return ok({
    entries: bodyResult.value,
    tornTail: {
      line: fragmentLine,
      discardedChars: fragment.length,
      reason:
        tail.error.kind === 'invalid_json'
          ? tail.error.message
          : `invalid_shape: missing field '${tail.error.missing_field ?? 'unknown'}'`,
    },
  });
}
