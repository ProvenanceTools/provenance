/**
 * The ROLLING SEAL — per-session manifests maintained by the recorder as it works.
 *
 * ## Why this exists
 *
 * A classic bundle is sealed once, by an explicit `seal` command, into
 * `.provenance/manifest.json` + `manifest.sig`. That works because there is a
 * packaging step to hook: the student runs seal, gets a `.zip`, uploads it.
 *
 * A git-submitted assignment (CS 61B / 61C, program spec §1) has no such step.
 * The student pushes; Gradescope clones. Nothing ever runs seal, so a
 * git-submitted `.provenance/` carries no signed manifest at all and every
 * scope reports `no_seal`. The fix is to move the seal off the submission event
 * and onto the recording itself: the recorder rewrites a seal of its own
 * session on every checkpoint, so **whatever is committed is always a valid
 * seal of the state at that moment**.
 *
 * ## Why per-session filenames, and why that is not cosmetic
 *
 * The rolling seal lives at `.provenance/manifest-<session_id>.json` (+ `.sig`).
 *
 * In a shared 61B repo two partners' recorders both write into the SAME
 * `.provenance/` directory, and both partners push. A single shared
 * `manifest.json` would then conflict on literally every merge — two different
 * signed blobs at one path, which git cannot reconcile and a student cannot
 * hand-resolve without destroying a signature. Per-session filenames make the
 * directory **add-only**: each recorder only ever writes files named after its
 * own session, so a merge is a union of disjoint paths. That is the identical
 * property that already makes `session-<uuid>.slog` mergeable, applied to the
 * seal.
 *
 * It follows that each rolling manifest covers **only its own session** and is
 * signed by **that session's** ephemeral key. Nothing needs a key it does not
 * have; verification stays per-session; a partner's sessions verify against a
 * partner's keys.
 *
 * ## Format version 1.2
 *
 * A rolling manifest is a `BundleManifest` at `format_version: '1.2'`. It reuses
 * the 1.1 field set verbatim — `assignment_id`, `semester`, `extension_hash`,
 * `sessions[]`, `submission_files[]` — and adds exactly one rule, which is why
 * it needs a version of its own rather than being a 1.1 with one session:
 *
 *   **A rolling manifest FILE describes exactly one session, whose
 *   `session_id` is non-null and equals the id in its filename.**
 *
 * The filename binding is what stops a rolling manifest being copied sideways:
 * `manifest-A.json` claiming session B would be verified against B's pubkey but
 * read as A's seal. `validateRollingSessionManifest` is the one place that rule
 * is enforced, so no reader can forget it.
 *
 * ## The `final` marker — closing the append hole
 *
 * A rolling seal is signed BEFORE the log's trailing bytes exist. It is
 * rewritten at session start, at every checkpoint, and at `dispose()`, hashing
 * the `.slog` as it stands at that moment, so its `slog_sha256` legitimately
 * commits only to a PREFIX (see `prefix-digest.ts`). That is not a defect — it
 * is what stops an honest mid-session archive being read as tampering — but it
 * costs something real: an entry appended past the final checkpoint is
 * indistinguishable from honest mid-session growth.
 *
 * `final: true` is what recovers that. The recorder writes it on exactly one
 * roll: the `dispose()`-time one, taken after `session.end` has been emitted
 * and the writer flushed, when the log provably will not grow again. A reader
 * that sees it is entitled to whole-file semantics, and an append then fails.
 *
 *   final seal      => WHOLE-FILE. Any append, truncation or edit fails.
 *   non-final seal  => PREFIX, exactly as before. Honest growth is never a finding.
 *
 * Three properties make this safe rather than a new way to accuse people:
 *
 *  1. **It is inside the signed payload.** `signBundleManifest` canonicalizes
 *     the whole manifest, so a student cannot add `final`, flip it, or strip it
 *     from a seal without the session's private key. Doing so breaks check 1.
 *  2. **Absence is never a finding.** A session that dies without a clean
 *     dispose — a crash, a power cut, a full disk, a read-only `.provenance/`,
 *     the directory removed by a `git checkout` — simply has no final seal, and
 *     falls back to prefix semantics with the unattested tail REPORTED. Those
 *     are documented, expected failure paths; every one of them belongs to a
 *     student who did nothing wrong. This is exactly why finality is an
 *     explicit, signed claim by the writer rather than something a reader
 *     infers from the presence of a `session.end` entry: `session.end` is in the
 *     log, and the log is the thing whose completeness is in question.
 *  3. **It is a one-way ratchet.** `final` only ever tightens what the reader
 *     will accept. There is no shape of this field that makes a bundle easier
 *     to forge.
 *
 * The residual is the DOWNGRADE: a student restores an earlier, non-final seal
 * of their own (an older git commit has one) in place of the final one, and
 * their tail becomes unattested again. Nothing crypto can prevent that — both
 * seals are genuinely signed by the same session key, and the earlier one is a
 * true statement about an earlier moment. It is not silent, though: the tail is
 * measured and reported as unattested by `verify-log-bytes.ts`, and it is
 * deliberately NOT a finding, because an honest mid-session archive produces a
 * byte-for-byte identical shape.
 *
 * `1.2` also appears as the `format_version` of the manifest the analyzer's
 * loader SYNTHESIZES for a rolling-sealed bundle (the union over every
 * per-session manifest present). That object legitimately covers N sessions, so
 * the shape validator in `bundle.ts` accepts one-or-more; the exactly-one rule
 * belongs to the on-disk file and lives here.
 *
 * ## What a rolling manifest does NOT change
 *
 * Nothing about `manifest.json` / `manifest.sig`. A classic sealed bundle is
 * byte-for-byte what it was: same 1.1 manifest, same canonical bytes, same
 * signature, same loader path. The rolling seal is a second, additive shape.
 *
 * Pure: types + validators only, no I/O.
 */

import { ok, err } from './result.js';
import type { Result } from './result.js';
import type { BundleManifest } from './bundle.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** `format_version` of a rolling seal. */
export const ROLLING_MANIFEST_FORMAT_VERSION = '1.2';

/**
 * `manifest-<session_id>.json` / `manifest-<session_id>.sig`.
 *
 * The session-id character class matches the one `session-<uuid>.slog` files use
 * (hex + dashes), so a rolling manifest can only ever be named after something
 * that could be a session id. `manifest.json` and `manifest.sig` cannot match:
 * the `-` after `manifest` is mandatory and the id is non-empty.
 */
const ROLLING_MANIFEST_RE = /^manifest-([0-9a-f-]+)\.(json|sig)$/;

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

/** The two filenames a session's rolling seal occupies inside `.provenance/`. */
export function rollingManifestFilenames(sessionId: string): { json: string; sig: string } {
  return { json: `manifest-${sessionId}.json`, sig: `manifest-${sessionId}.sig` };
}

/**
 * Read a `.provenance/` entry name as a rolling-seal file.
 *
 * Returns `null` for anything that is not one — including `manifest.json` and
 * `manifest.sig`, which belong to the classic seal.
 */
export function parseRollingManifestFilename(
  filename: string,
): { sessionId: string; part: 'json' | 'sig' } | null {
  const m = ROLLING_MANIFEST_RE.exec(filename);
  if (m === null) return null;
  return { sessionId: m[1]!, part: m[2] as 'json' | 'sig' };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export type RollingManifestError =
  /** `format_version` is not `'1.2'` — this is a classic manifest, not a rolling one. */
  | { kind: 'not_rolling'; format_version: string }
  /** A rolling manifest FILE must describe exactly one session. */
  | { kind: 'wrong_session_count'; count: number }
  /** The single session's `session_id` is null (unparseable `.slog` at seal time). */
  | { kind: 'null_session_id' }
  /** The manifest names a different session than its filename does. */
  | { kind: 'session_id_mismatch'; expected: string; actual: string };

/**
 * A single-session rolling manifest, as it appears on disk.
 *
 * The `sessions` tuple is narrowed to length 1 so callers can read
 * `manifest.sessions[0]` without a non-null assertion.
 */
export type RollingSessionManifest = Omit<BundleManifest, 'format_version' | 'sessions'> & {
  format_version: '1.2';
  sessions: readonly [BundleManifest['sessions'][number] & { session_id: string }];
};

/**
 * Enforce the rolling-seal file rule on an already shape-validated manifest.
 *
 * @param manifest          Output of `validateBundleManifestShape`.
 * @param expectedSessionId The id from the FILENAME, when the caller has one.
 *   Omit only when reading a manifest that did not come from a named file.
 */
export function validateRollingSessionManifest(
  manifest: BundleManifest,
  expectedSessionId?: string,
): Result<RollingSessionManifest, RollingManifestError> {
  if (manifest.format_version !== ROLLING_MANIFEST_FORMAT_VERSION) {
    return err({ kind: 'not_rolling', format_version: manifest.format_version });
  }
  if (manifest.sessions.length !== 1) {
    return err({ kind: 'wrong_session_count', count: manifest.sessions.length });
  }
  const only = manifest.sessions[0]!;
  if (only.session_id === null) {
    return err({ kind: 'null_session_id' });
  }
  if (expectedSessionId !== undefined && only.session_id !== expectedSessionId) {
    return err({
      kind: 'session_id_mismatch',
      expected: expectedSessionId,
      actual: only.session_id,
    });
  }
  return ok(manifest as RollingSessionManifest);
}

/**
 * Does this seal claim to be the LAST one its session will get?
 *
 * The single definition of finality, for the same reason
 * `parseRollingManifestFilename` is the single definition of the filename rule:
 * every reader that chooses whole-file over prefix semantics must choose it the
 * same way. Strictly `=== true`, so a manifest carrying anything else — a
 * truthy string, a 1, `undefined` — falls back to the SAFER prefix reading and
 * cannot be tricked into strictness.
 *
 * Only meaningful for a 1.2 rolling seal. A classic 1.0 / 1.1 manifest is
 * sealed once over a finished log and never goes through this: see
 * `analysis-core/loader/parse-bundle.ts`, which computes coverage only when the
 * rolling union IS the bundle's manifest.
 */
export function isFinalRollingSeal(manifest: Pick<BundleManifest, 'final'>): boolean {
  return manifest.final === true;
}

/** Human-readable form of a {@link RollingManifestError}, for check details. */
export function describeRollingManifestError(error: RollingManifestError): string {
  switch (error.kind) {
    case 'not_rolling':
      return `format_version is ${error.format_version}, not ${ROLLING_MANIFEST_FORMAT_VERSION}`;
    case 'wrong_session_count':
      return `a rolling manifest must cover exactly one session, found ${error.count}`;
    case 'null_session_id':
      return 'the covered session has a null session_id';
    case 'session_id_mismatch':
      return `filename names session ${error.expected} but the manifest covers ${error.actual}`;
  }
}
