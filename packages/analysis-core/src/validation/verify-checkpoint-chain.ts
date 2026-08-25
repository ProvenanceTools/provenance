/**
 * Checkpoint-chain detection — the signed `(seq, hash)` checkpoints in
 * `.slog.meta`, actually verified.
 *
 * ## The hole this closes
 *
 * PRD §4.6 has the recorder sign a checkpoint over `canonicalize({seq, hash})`
 * with the session's own ephemeral private key, every N events and on every
 * save, and store them in `.slog.meta`. `log-core/checkpoint-signer.ts` has
 * shipped `verifyCheckpoint` since that was written.
 *
 * Nothing ever called it on a bundle. The checkpoints were produced, signed,
 * shipped, parsed into `SlogMeta.checkpoints` — and never checked. Two
 * independent tamper defences were designed into the format and neither was
 * wired up; this is the second of them (`verify-log-bytes.ts` is the first).
 *
 * ## What a checkpoint actually proves
 *
 * Each one is a signed statement: *"at seq S, the chain's entry hash was H."*
 * Verifying it therefore catches two distinct attacks:
 *
 *  - **Rewriting history.** Any edit to an entry at or before seq S changes
 *    that entry's hash and, through the chain, every hash after it — so the
 *    entry now at seq S no longer hashes to H. Re-chaining the whole log (which
 *    defeats check 3) cannot help: the attacker would have to re-sign the
 *    checkpoint, and the session private key is stored only in encrypted form
 *    (`encrypted_session_privkey`), sealed against the assignment manifest
 *    signature.
 *  - **Truncation.** Cutting the log short removes the entry a checkpoint names.
 *    A checkpoint pointing past the end of the log is proof that entries that
 *    once existed are gone — and truncation is otherwise nearly invisible,
 *    since a truncated chain still self-verifies under check 3.
 *
 * ## What it does NOT prove — read this before assuming it covers appends
 *
 * A checkpoint says nothing about entries written *after* it. An entry appended
 * past the final checkpoint leaves every checkpoint verifying perfectly, and no
 * amount of checkpoint verification will ever notice it. The recorder
 * checkpoints periodically, so a bundle legitimately ends with uncheckpointed
 * trailing entries; treating those as suspicious would fire on essentially every
 * honest submission.
 *
 * The append is caught by `verify-log-bytes.ts` instead, via the signed
 * manifest's `slog_sha256`. The two detections are complements: checkpoints
 * cover the prefix under a per-session signature, the manifest digest covers the
 * entire file under the bundle seal.
 *
 * ## Absent is not wrong
 *
 * The discipline check 8's tamper sub-check had to learn in 2026-07 — gate on
 * the evidence being present, so "absent" is never mistaken for "wrong". None
 * of the following is tampering, and none of them returns `fail`:
 *
 *  - **No checkpoints.** A short session that never hit a checkpoint trigger
 *    has an empty `checkpoints` array. Legitimate and common.
 *  - **A legacy or minimal `.slog.meta`.** Same shape, same handling.
 *  - **No session pubkey**, or one that is not well-formed hex. Without a key
 *    there is nothing to verify *against*; that is an unverifiable claim, not a
 *    refuted one, and a malformed meta is check 2's finding.
 *
 * A checkpoint is only ever a finding when it is present, verifiable in
 * principle, and *contradicted*.
 *
 * ## Honest crash vs. truncation — the tail is genuinely ambiguous
 *
 * The recorder's `SessionWriter.append` only buffers entries in memory; the
 * `.slog` flush is on a 1s/256KB timer. Checkpoints are signed and appended
 * to `.slog.meta` on an unrelated async chain — nothing orders the two
 * against each other. A crash between "checkpoint signed" and "entry
 * flushed" leaves `.slog.meta` naming a seq S that `.slog` never received a
 * single byte of. On disk that is indistinguishable from an attacker cutting
 * the log short right after S was checkpointed: both leave the log ending
 * before S, with nothing after S either, because in the honest case nothing
 * after S was ever written and in the dishonest case everything after S was
 * removed.
 *
 * A `seq_absent` offence in the MIDDLE of a session's checkpoint history has
 * no such excuse: entries with a greater seq than S survived, which is only
 * possible if S itself was written and then later removed — deletion is the
 * only honest reading, and the finding stays at full severity below.
 *
 * A `seq_absent` offence AT THE TAIL — S is the highest-seq checkpoint this
 * session carries, and no entry with a greater seq is in the log — gets a
 * `flagOverride` (see `check-types.ts`) that turns the resulting `Flag` into
 * a dual reading at reduced severity, worded the way
 * `multiple_sessions_overlap`'s `unknown` arm is: both readings named, the
 * check refuses to choose, and it says why it cannot. This check's `status`
 * is unaffected — it still reports `fail` and the same `detail`, because the
 * checkpoint genuinely IS contradicted by the log it was signed over; what
 * changes is only how confidently that contradiction gets read as an
 * accusation against the student.
 *
 * ## Re-runnable against a STORED bundle
 *
 * `.slog.meta` is on `strip-bundle.ts`'s `isProvenanceEntry` allowlist and is
 * copied verbatim, as is the `.slog` this compares it against. Nothing this
 * check reads is stripped, so it is fully re-runnable server-side — asserted
 * against a genuinely stripped bundle in `verify-log-bytes.test.ts` rather
 * than assumed.
 *
 * ## Not one of the eight
 *
 * Deliberately not in `ValidationReport.checks` — the server persists exactly
 * eight `check_N_status` columns and asserts `checks.length === 8`. This rides
 * in `ValidationReport.bundleDetections` and becomes a `Flag` via
 * `heuristics/integrity-flags.ts`, the same route `verify-manifest-downgrade.ts`
 * established.
 */

import { verifyCheckpoint } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

const ID = 'checkpoint_chain_valid' as const;
const LABEL = 'Signed session checkpoints agree with the log';

/** An ed25519 public key is 32 bytes — 64 lowercase hex chars. */
const PUBKEY_RE = /^[0-9a-f]{64}$/;

type Offence = {
  sessionId: string;
  seq: number;
  kind: 'bad_signature' | 'hash_mismatch' | 'seq_absent';
  detail: string;
  /**
   * Only meaningful for `kind: 'seq_absent'`. True when this offence sits at
   * the very tail of its session: it names the highest-seq checkpoint that
   * session carries, and no entry with a greater seq exists in the log
   * either. See the "Honest crash vs. truncation" section below — that shape
   * is what an honest crash produces too, so it cannot by itself be blamed on
   * deletion the way a mid-log absence can.
   */
  tailAmbiguous?: boolean;
};

/**
 * Verify every signed checkpoint against its session's key and its session's
 * chain.
 *
 * Async because ed25519 verification is — the same reason `runValidation` is
 * async for checks 1 and 2.
 *
 * Statuses:
 *  - `fail`    — a checkpoint's signature is invalid, or it names a seq that is
 *                absent from the log, or the entry at that seq hashes to
 *                something other than what the checkpoint swore to.
 *  - `pass`    — at least one checkpoint was verified and all of them held.
 *  - `skipped` — no session carried a verifiable checkpoint.
 */
export async function verifyCheckpointChain(bundle: Bundle): Promise<ValidationCheck> {
  const offences: Offence[] = [];
  let verified = 0;

  for (const session of bundle.sessions) {
    const checkpoints = session.meta.checkpoints;
    if (checkpoints.length === 0) continue;

    const pubkey = session.meta.session_pubkey;
    // No key, or a malformed one, means these checkpoints are unverifiable
    // rather than refuted. Reporting them as failures would manufacture a
    // finding out of a defect check 2 already owns.
    if (typeof pubkey !== 'string' || !PUBKEY_RE.test(pubkey)) continue;

    // seq -> the hash the chain actually holds at that seq.
    const hashBySeq = new Map<number, string>();
    for (const event of session.events) hashBySeq.set(event.seq, event.hash);

    // The highest seq this session's log actually holds (−1 if the log has
    // no entries at all) and the highest seq this session's checkpoints
    // name. Both are needed to tell a mid-log seq_absent (deletion, no
    // honest reading) from one at the tail (crash and truncation produce the
    // same bytes) — see the "Honest crash vs. truncation" doc above.
    let maxEventSeq = -1;
    for (const event of session.events) {
      if (event.seq > maxEventSeq) maxEventSeq = event.seq;
    }
    let maxCheckpointSeq = -1;
    for (const cp of checkpoints) {
      if (cp.seq > maxCheckpointSeq) maxCheckpointSeq = cp.seq;
    }

    for (const cp of checkpoints) {
      // 1. Is the checkpoint genuine? Verify BEFORE comparing hashes: an
      //    unsigned or forged checkpoint proves nothing about the log, and
      //    reporting a hash mismatch from a checkpoint we cannot authenticate
      //    would be attributing an attacker's own claim to the student.
      const sigOk = await verifyCheckpoint(cp, pubkey);
      if (!sigOk) {
        offences.push({
          sessionId: session.sessionId,
          seq: cp.seq,
          kind: 'bad_signature',
          detail:
            `checkpoint at seq ${cp.seq} does not verify against the session public key ` +
            `recorded in .slog.meta`,
        });
        continue;
      }

      verified++;

      // 2. The checkpoint is genuine. Does the log still agree with it?
      const actual = hashBySeq.get(cp.seq);
      if (actual === undefined) {
        offences.push({
          sessionId: session.sessionId,
          seq: cp.seq,
          kind: 'seq_absent',
          detail:
            `a validly signed checkpoint names seq ${cp.seq}, but no entry with that seq is ` +
            `present in the log — entries that existed when the checkpoint was signed are gone`,
          tailAmbiguous: cp.seq === maxCheckpointSeq && maxEventSeq <= cp.seq,
        });
        continue;
      }

      if (actual !== cp.hash) {
        offences.push({
          sessionId: session.sessionId,
          seq: cp.seq,
          kind: 'hash_mismatch',
          detail:
            `a validly signed checkpoint swears the entry at seq ${cp.seq} hashes to ` +
            `${cp.hash}, but it hashes to ${actual}`,
        });
      }
    }
  }

  if (offences.length > 0) {
    const per = offences.map((o) => `session ${o.sessionId}: ${o.detail}`).join('; ');

    // Every offence is a tail-position seq_absent — the ONLY shape an honest
    // crash between "checkpoint signed" and "entry flushed" can produce. A
    // single bad_signature, hash_mismatch, or mid-log seq_absent anywhere in
    // the bundle rules that reading out (something else is definitely
    // wrong), so the override applies only when nothing else is present.
    const allTailAmbiguous = offences.every(
      (o) => o.kind === 'seq_absent' && o.tailAmbiguous === true,
    );

    return {
      id: ID,
      label: LABEL,
      status: 'fail',
      detail:
        `Signed checkpoint verification failed: ${per}. Checkpoints are signed during the ` +
        `session with the session's own ephemeral private key, which is stored only in ` +
        `encrypted form, so a checkpoint cannot be re-signed after the fact to match an ` +
        `altered log. A contradicted checkpoint means the log was rewritten or truncated ` +
        `after that checkpoint was written.`,
      supportingSeqs: offences.map((o) => ({ sessionId: o.sessionId, seq: o.seq })),
      ...(allTailAmbiguous
        ? {
            flagOverride: {
              severity: 'low' as const,
              confidence: 0.5,
              description:
                `${per}. This is NOT established as tampering: the recorder buffers entries in ` +
                `memory and flushes them to .slog on a timer, independently of when a checkpoint ` +
                `is signed to .slog.meta, so nothing orders the two against each other. A crash ` +
                `between "checkpoint signed" and "entry flushed" leaves exactly this shape — a ` +
                `checkpoint naming a seq that was never written to disk, with nothing after it ` +
                `either — and that is byte-for-byte identical to an attacker truncating the log ` +
                `right after this checkpoint was signed. This flag states the contradiction; it ` +
                `does not choose between an honest crash and a truncation, and no one should read ` +
                `it as choosing. Nothing in the stored bundle can settle which one happened: the ` +
                `two readings are undecidable from the log alone, which is exactly why this sits ` +
                `at the tail — a checkpoint contradicted anywhere earlier, with entries surviving ` +
                `past it, has no such honest explanation and is reported at full severity instead.`,
            },
          }
        : {}),
    };
  }

  if (verified === 0) {
    return {
      id: ID,
      label: LABEL,
      status: 'skipped',
      detail:
        'No session carried a verifiable signed checkpoint (no checkpoints were recorded, ' +
        'or no usable session public key was present), so there is nothing for this check ' +
        'to verify. A session that never reached a checkpoint trigger is normal.',
    };
  }

  return {
    id: ID,
    label: LABEL,
    status: 'pass',
    detail:
      `${verified} signed checkpoint(s) verified against their session keys, and every one ` +
      `agrees with the hash the log actually holds at that seq. Note that checkpoints ` +
      `constrain only the entries up to the last checkpoint; the signed manifest's log-bytes ` +
      `digest is what covers the rest of the file.`,
  };
}
