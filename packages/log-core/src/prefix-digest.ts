/**
 * Prefix digests — "does this digest commit to some PREFIX of these bytes?"
 *
 * ## Why this exists
 *
 * A classic seal (`manifest.json`) is taken once, over a finished `.slog`, so
 * `slog_sha256` is a commitment to the whole file and whole-file equality is the
 * right test.
 *
 * A ROLLING seal is not that. `recorder/src/io/rolling-seal-writer.ts` rewrites
 * `manifest-<session_id>.json` at session start, at every checkpoint, and at
 * `dispose()`, hashing the `.slog` **as it stands at that moment**. The subject
 * of the commitment keeps growing after the commitment is made. For a
 * git-submitted assignment there is no seal step at all — the student pushes and
 * the grader clones whenever they like — so the archived `.slog` is routinely
 * longer than the digest its own signed manifest names. That is the design
 * working, not a student cheating.
 *
 * The honest reading of such a digest is therefore: *"the first N bytes of this
 * file were exactly these, at the moment I signed."* This function recovers N.
 *
 * ## What this does and does not prove
 *
 * A match at length N proves bytes `[0, N)` are byte-for-byte what was signed.
 * So it still catches, at full strength:
 *
 *  - **any edit inside the sealed region** — the prefix at N no longer hashes to
 *    the committed value, and no other prefix can, because every other prefix
 *    has a different length and therefore different bytes;
 *  - **truncation below N** — the committed prefix no longer exists in the file.
 *
 * It does NOT prove anything about bytes at or after N. Nothing can: those bytes
 * did not exist when the signature was made. A rolling seal is structurally
 * incapable of attesting to its own future, and pretending otherwise is exactly
 * what makes an honest mid-session archive look like tampering. Callers must
 * surface the size of that unattested tail rather than ignore it.
 *
 * ## Why boundaries, and why this is cheap
 *
 * A `.slog` is NDJSON: the recorder's writer only ever appends whole
 * newline-terminated entries, so every state the file has ever been in ends at a
 * `\n` (or, after a power cut mid-write, at the end of the file). Only those
 * offsets can be candidates, which turns an O(file length) search into one
 * candidate per entry.
 *
 * Cost is a single pass: the bytes are hashed once, incrementally, and each
 * candidate offset costs one `clone()` plus one finalization of an already-fed
 * hash state. No quadratic re-hashing.
 *
 * Pure. No I/O, no Node APIs — `log-core` runs in the browser too.
 */

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** `\n`. Every `.slog` entry the recorder writes is terminated by one. */
const LF = 0x0a;

/**
 * Find the length of the prefix of `bytes` whose sha256 is `targetHex`.
 *
 * Candidate lengths are `0`, every offset just past a `boundary` byte, and
 * `bytes.length` itself (which covers a file that does not end in a boundary —
 * a `.slog` cut off mid-entry by a power failure).
 *
 * At most one candidate can match: distinct candidate lengths mean distinct
 * byte strings, and two of those hashing alike is a sha256 collision.
 *
 * @param bytes     The file as it actually arrived.
 * @param targetHex The digest the signed manifest committed to. Compared
 *                  case-insensitively; anything that is not 64 hex characters
 *                  is rejected outright rather than searched for.
 * @param boundary  Byte that terminates a candidate prefix. Defaults to `\n`.
 * @returns The matching prefix length, or `null` if no prefix matches.
 */
export function findSha256PrefixLength(
  bytes: Uint8Array,
  targetHex: string,
  boundary: number = LF,
): number | null {
  if (!/^[0-9a-fA-F]{64}$/.test(targetHex)) return null;
  const target = targetHex.toLowerCase();

  const hash = sha256.create();

  // The empty prefix. A seal written before the writer had flushed anything —
  // or one whose `.slog` was unreadable, which the rolling-seal writer records
  // as sha256('') on purpose — commits to exactly this. It is a real match, and
  // it means the seal attests to nothing; the caller reports the coverage so
  // that fact is visible rather than silently green.
  if (bytesToHex(hash.clone().digest()) === target) return 0;

  let fed = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== boundary) continue;
    hash.update(bytes.subarray(fed, i + 1));
    fed = i + 1;
    if (bytesToHex(hash.clone().digest()) === target) return fed;
  }

  // A trailing partial entry: the file does not end at a boundary, so its full
  // length is a candidate the loop above never offered.
  if (fed < bytes.length) {
    hash.update(bytes.subarray(fed));
    if (bytesToHex(hash.clone().digest()) === target) return bytes.length;
  }

  return null;
}
