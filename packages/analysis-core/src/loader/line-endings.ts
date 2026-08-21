/**
 * Git line-ending translation, recognized rather than accused.
 *
 * ## The bug this exists to answer
 *
 * A `.slog` is NDJSON. Nothing in a student's repository tells git it is
 * anything other than text, so git applies its end-of-line filters to it, and
 * those filters are not byte-preserving. Under a `.gitattributes` carrying
 * `* text=auto eol=crlf`, under `core.eol=crlf`, or under `core.autocrlf=true`
 * on the machine that materializes the working tree, the LF the recorder wrote
 * becomes CRLF in the tree the grader receives.
 *
 * The git path has no seal step: the student pushes, Gradescope clones, and
 * whatever sits in `.provenance/` **in the delivered working tree** is the
 * submission. So the bytes `verify-log-bytes.ts` hashes are post-filter bytes,
 * while `slog_sha256` in the signed manifest was computed by the recorder over
 * pre-filter bytes. They differ, and the difference is entirely git's doing.
 *
 * Read as tampering — which is how it was read — that is a false accusation at
 * **high severity, confidence 1.0**, carrying the sentence *"This is not
 * recoverable from a benign cause."* It is recoverable from a benign cause. It
 * is recoverable from the single most common configuration hazard in the tool
 * the whole git path is built on.
 *
 * And it is the worst-shaped false accusation available, because **nothing else
 * fails**. `parseEntries` splits on `'\n'`, leaving a trailing `'\r'` that
 * `JSON.parse` accepts as insignificant whitespace, so every entry parses to the
 * identical object, the hash chain verifies, the checkpoints verify and the
 * manifest signature verifies. Seven of the eight PRD §5.4 checks pass. Only the
 * byte digest fails, which makes it read as a surgical, deliberate edit rather
 * than as an artifact of `git clone`.
 *
 * ## Why matching the normalized digest is PROOF, not leniency
 *
 * The retry here is narrow on purpose. It is one fixed, total function applied
 * to the archived bytes, and its result must hit the committed digest exactly.
 * It is not a search, there is no tolerance, and no attacker-supplied value
 * steers it.
 *
 * Let `S` be the sealed bytes (`sha256(S)` is what the signed manifest commits
 * to) and `B` the archived bytes. If `sha256(toLf(B)) === committed` then, by
 * collision resistance, `toLf(B) === S`. The recorder's `.slog` is
 * JCS-canonical JSON, one entry per line, so `S` contains **no CR byte at all** —
 * `canonicalize` escapes any control character inside a string as `\r`, and the
 * only raw line terminator it emits is the LF that `serializeEntry` appends.
 * Since `toLf` rewrites only `\r\n` and leaves a lone `\r` in place, a lone `\r`
 * anywhere in `B` would survive into `toLf(B)` and therefore into `S` — which
 * cannot be. So `B` is exactly `S` with some subset of its LF terminators
 * widened to CRLF, and nothing else.
 *
 * That is a complete characterization, and it is what makes this safe: the set
 * of files that pass the retry contains **no file whose event stream differs
 * from `S`**. An appended entry, a removed entry, a reordered entry, a flipped
 * byte inside an entry — every one of them survives `toLf` and breaks the
 * digest. The retry therefore cannot be used to smuggle a modification past the
 * check, and an attacker who could construct a passing `B` would have to already
 * possess `S`, in which case submitting `S` unchanged was always open to them.
 * It grants no capability that did not already exist.
 *
 * This is deliberately NOT the dangerous shape of the same idea. Comparing
 * *parsed event streams*, or re-canonicalizing and comparing, would discard the
 * byte commitment and let the actual JSON vary. This compares bytes to bytes,
 * through one fixed rewrite, against the same signed digest.
 *
 * ## What it does NOT cover, stated because the gap is real
 *
 * Only the direction "sealed LF, archived CRLF" is recoverable by hashing. The
 * reverse — the recorder sealing over bytes that git had already widened to
 * CRLF, with the archive delivering them back as LF — is not, and neither is a
 * MIXED file (a log that was smudged mid-session and then appended to with LF).
 * Recovering those would mean guessing which of `n` terminators were wide, and
 * that search is `2^n`.
 *
 * Both are reachable: `core.autocrlf=true`, a `git checkout` that re-materializes
 * a committed `.slog` mid-session, and the rolling seal writer's re-read of the
 * file from disk produce exactly that shape. So this module is a partial remedy
 * for repositories that already exist, and **prevention in the recorder — the
 * `.gitattributes` it now writes into `.provenance/` — is the only complete
 * fix.** `verify-log-bytes.ts`'s unexplained-mismatch wording therefore still
 * has to name line-ending translation as a cause it cannot exclude, rather than
 * asserting modification.
 */

import { sha256Hex } from '@provenance/log-core';

/**
 * Does this text carry CRLF line terminators?
 *
 * Checked first and cheaply so the overwhelmingly normal case — a `.slog` git
 * never touched — costs one substring scan and no hashing at all. Every hash in
 * this module is gated behind this.
 */
export function hasCrlf(text: string): boolean {
  return text.includes('\r\n');
}

/**
 * Undo git's LF→CRLF widening: the exact inverse of the `smudge` half of the
 * `text` filter.
 *
 * Rewrites `\r\n` to `\n` and NOTHING else. A lone `\r` is left alone on
 * purpose — it is not something git's filter produces, so preserving it is what
 * lets the digest comparison reject a file carrying one. See the module
 * docstring for why that matters.
 */
export function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * The digest this `.slog` would have had if git had not widened its line
 * terminators — or `null` when that question does not arise or cannot be
 * answered soundly.
 *
 * `null` in three cases, and each is a refusal rather than a verdict:
 *
 *  - the text carries no CRLF, so there is nothing to undo and the normalized
 *    digest would merely restate `archivedSha256`;
 *  - the text does not re-encode to the archived bytes. The loader hashes the
 *    RAW ZIP bytes but hands on decoded text, and for anything that was not
 *    valid UTF-8 the decoder substituted U+FFFD. Normalizing that would produce
 *    a confident answer about a different file, so refuse — the same guard
 *    `computeSlogCoverage` already applies before its prefix search.
 *
 * The caller compares the result against the committed digest. A hit is the
 * proof described in the module docstring; a miss is simply not this
 * explanation, and the mismatch stands.
 *
 * @param slogText        The `.slog` as the loader decoded it.
 * @param archivedSha256  Digest of the raw ZIP bytes, from the unzipper.
 */
export function lfNormalizedSha256(slogText: string, archivedSha256: string): string | null {
  if (!hasCrlf(slogText)) return null;
  if (sha256Hex(slogText) !== archivedSha256) return null;
  return sha256Hex(toLf(slogText));
}
