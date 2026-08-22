/**
 * Reading a ROLLING-SEALED bundle (program spec §8, S3).
 *
 * A git-submitted assignment has no seal step, so its `.provenance/` carries no
 * `manifest.json` at all. Instead the recorder rewrites, on every checkpoint,
 * `manifest-<session_id>.json` + `manifest-<session_id>.sig` — one pair per
 * session, each covering exactly its own session and signed by that session's
 * own ephemeral key. See `log-core/src/rolling-manifest.ts` for why the
 * filenames are per-session and why that is load-bearing rather than cosmetic.
 *
 * This module is the READ side. It does three things and no I/O:
 *
 *   1. `validateRollingSeals` — turns the raw `.json`/`.sig` pairs the unzipper
 *      found into shape-verified seals, and turns everything that is wrong with
 *      them into {@link RollingSealDefect}s instead of throwing them away.
 *   2. `reconcileRollingSealsWithSessions` — cross-checks the set of seals
 *      against the set of `.slog`s actually present.
 *   3. `synthesizeRollingUnionManifest` — builds the in-memory union manifest at
 *      `format_version: '1.2'` that the rest of analysis-core reads as
 *      `bundle.manifest`.
 *
 * ## Why defects rather than hard loader errors
 *
 * Every one of these problems is *evidence*, and the channel for evidence is
 * the validation report, not a load failure. Rejecting the ZIP because one of
 * six sessions has a half-written seal would throw away the other five
 * sessions' heuristics, timeline and replay — that is failing toward FEWER
 * findings, which is exactly backwards for an integrity tool. So the bundle
 * loads, and check 1 (`manifest_sig`) fails naming the specific session.
 *
 * The single exception is a bundle where nothing is left to synthesize from: no
 * classic manifest and no rolling manifest that even parses. That bundle has no
 * manifest at all, and the loader reports `invalid_manifest` as it always has.
 *
 * ## Why the classic path cannot be affected
 *
 * A bundle with zero `manifest-<id>.json` entries never reaches this module.
 * `parseRollingManifestFilename` deliberately does not match `manifest.json`,
 * so a classic sealed bundle produces zero candidates, `rollingSeal` stays
 * `undefined` on the Bundle, and every consumer takes the byte-for-byte
 * identical path it took before.
 *
 * Pure: no I/O, no crypto. Signature verification lives in
 * `validation/verify-manifest-sig.ts`, which is the only place that has the
 * session public keys.
 */

import {
  validateBundleManifestShape,
  validateRollingSessionManifest,
  describeRollingManifestError,
  ROLLING_MANIFEST_FORMAT_VERSION,
} from '@provenance/log-core';
import type { BundleManifest, SubmissionFileEntry } from '@provenance/log-core';
import { asLogicalSessionId } from './types.js';
import type {
  LogicalSessionId,
  RawRollingSealFiles,
  RollingSeal,
  RollingSealDefect,
} from './types.js';

// ---------------------------------------------------------------------------
// 1. Shape + filename-binding validation
// ---------------------------------------------------------------------------

/**
 * Validate each `manifest-<session_id>.json` / `.sig` pair the unzipper found.
 *
 * Candidates are processed in ascending `sessionId` order so the output is
 * deterministic regardless of ZIP entry order (CLAUDE.md: tests must be
 * deterministic).
 *
 * A seal survives only if it has a `.json` that parses, passes
 * `validateBundleManifestShape`, and passes
 * `validateRollingSessionManifest(manifest, sessionIdFromFilename)` — the last
 * of which is what refuses a manifest copied sideways under another session's
 * filename. Everything else becomes a defect.
 */
export function validateRollingSeals(candidates: readonly RawRollingSealFiles[]): {
  seals: RollingSeal[];
  defects: RollingSealDefect[];
} {
  const seals: RollingSeal[] = [];
  const defects: RollingSealDefect[] = [];

  const ordered = [...candidates].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));

  for (const candidate of ordered) {
    const { sessionId, manifestJson, sigHex } = candidate;

    // A `.sig` with no `.json`: there is nothing to verify, and the absence is
    // itself evidence that a sealed manifest was removed. Surface it.
    if (manifestJson === null) {
      defects.push({
        sessionId,
        kind: 'missing_manifest',
        detail:
          `manifest-${sessionId}.sig is present but manifest-${sessionId}.json is not — ` +
          `the sealed manifest was removed.`,
      });
      continue;
    }

    // A `.json` with no `.sig`: an unsigned manifest is not a seal. It still
    // contributes its content to the union (so check 8 can see what it claims),
    // but check 1 must fail — nothing vouches for those claims.
    const unsigned = sigHex === null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestJson);
    } catch (e) {
      defects.push({
        sessionId,
        kind: 'invalid_json',
        detail:
          `manifest-${sessionId}.json is not valid JSON: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }

    const shape = validateBundleManifestShape(parsed);
    if (!shape.ok) {
      const se = shape.error;
      const reason =
        se.kind === 'not_object'
          ? 'not_object'
          : se.kind === 'wrong_version'
            ? `wrong_version: ${String(se.actual)}`
            : se.kind === 'missing_field'
              ? `missing_field: ${se.field}`
              : `invalid_field: ${se.field} — ${se.reason}`;
      defects.push({
        sessionId,
        kind: 'invalid_shape',
        detail: `manifest-${sessionId}.json shape invalid: ${reason}`,
      });
      continue;
    }

    // The filename ↔ session_id binding. This is the one rule that stops
    // `manifest-A.json` being a copy of B's seal: such a file would otherwise
    // verify (it IS B's manifest, signed by B's key) but be read as A's seal.
    const rolling = validateRollingSessionManifest(shape.value, sessionId);
    if (!rolling.ok) {
      defects.push({
        sessionId,
        kind: rolling.error.kind === 'session_id_mismatch' ? 'session_id_mismatch' : 'not_rolling',
        detail: `manifest-${sessionId}.json: ${describeRollingManifestError(rolling.error)}`,
      });
      continue;
    }

    if (unsigned) {
      defects.push({
        sessionId,
        kind: 'missing_sig',
        detail:
          `manifest-${sessionId}.json is present but manifest-${sessionId}.sig is not — ` +
          `the manifest is unsigned, so nothing vouches for what it claims.`,
      });
    }

    // The only entry into the logical id space on this path: the id came from
    // a `manifest-<session_id>.json` filename and `validateRollingSessionManifest`
    // has just proven the manifest inside agrees with it.
    seals.push({
      sessionId: asLogicalSessionId(sessionId),
      manifestJson,
      manifest: rolling.value,
      sigHex,
    });
  }

  return { seals, defects };
}

// ---------------------------------------------------------------------------
// 2. Reconciliation against the sessions actually in the bundle
// ---------------------------------------------------------------------------

/**
 * Cross-check the seals against the `.slog`s present.
 *
 * @param sealSessionIds Ids of every rolling seal FILE found, including ones
 *   that turned into defects — a seal that failed its shape check still proves
 *   the session was sealed, so it must not also be reported as unsealed.
 * @param parsedSessionIds Ids of the sessions that actually parsed.
 * @param hasClassicSeal When the bundle ALSO carries `manifest.json`, that
 *   classic seal covers every session, so a session without a rolling seal is
 *   not an anomaly and `unsealed_session` is not reported.
 */
export function reconcileRollingSealsWithSessions(
  sealSessionIds: readonly string[],
  parsedSessionIds: readonly string[],
  hasClassicSeal: boolean,
): RollingSealDefect[] {
  const defects: RollingSealDefect[] = [];
  const sealed = new Set(sealSessionIds);
  const present = new Set(parsedSessionIds);

  // A seal for a session whose .slog is not in the bundle.
  //
  // This used to be described as "either the log was deleted or the seal was
  // planted". Both of those are inferences about how the archive came to look
  // this way, and on the GIT path the evidence does not support either: a
  // partner who committed `.provenance/manifest-<id>.json` before their `.slog`
  // landed — or whose `.slog` is caught by a `.gitignore` — produces the
  // identical archive. Nothing in the bundle separates a partial push from a
  // deletion, so the text below states the gap and stops.
  //
  // It is still reported, and still fails check 1. A signed claim that cannot be
  // checked IS a hole in the record: the public key that would verify it lives
  // in that session's own session.start event, which is the file that is
  // missing. Hiding it would be failing toward fewer findings. What changes is
  // that the finding no longer asserts what it cannot establish.
  for (const sessionId of [...sealed].sort()) {
    if (!present.has(sessionId)) {
      defects.push({
        sessionId,
        kind: 'no_session_log',
        // Names the FACT, not a filename that cannot exist.
        //
        // This used to read "…but no `session-<sessionId>.slog` is present".
        // `sessionId` here is the LOGICAL session id — it came from a
        // `manifest-<session_id>.json` filename — but `.slog` files are named
        // after a per-file uuid the writer mints separately, so NO FILE IS EVER
        // NAMED THAT. This string reaches staff through check 1's `detail` and
        // is persisted to `check_1_detail`, so it is read at exactly the moment
        // someone goes looking through the archive; the filename we printed
        // would return nothing and leave our own report unverifiable by
        // inspection. Say which id space this is, since a reader cannot be
        // expected to know there are two.
        detail:
          `manifest-${sessionId}.json seals session ${sessionId}, but no .slog in ` +
          `this bundle records that session. What is established is the gap: the seal ` +
          `is here, the log it names is not, and its signature therefore cannot be ` +
          `checked against any session key — the key that would verify it lives in ` +
          `that session's own session.start event, inside the missing log. HOW the ` +
          `two came apart is NOT established. On a git-submitted assignment a partner ` +
          `who committed .provenance/manifest-${sessionId}.json before their .slog ` +
          `landed, or whose .slog is excluded by a .gitignore, produces this exact ` +
          `archive; so does a log that was removed, and so does a seal that never had ` +
          `a recording behind it. Nothing in this bundle tells those apart, so treat ` +
          `it as an incomplete record and not, on its own, as evidence of any of them. ` +
          `What would settle it: the missing .slog arriving in a later push, or a peer ` +
          `witness record proving the session existed (peer.observed — designed, not ` +
          `yet built). (Session ${sessionId} is a LOGICAL session id, from ` +
          `session.start; log files are named after a separate per-file uuid, so no ` +
          `file is named after this id.)`,
      });
    }
  }

  // A session with no rolling seal at all, in a bundle that has no classic seal
  // either. Nothing covers this session's log.
  if (!hasClassicSeal) {
    for (const sessionId of [...present].sort()) {
      if (!sealed.has(sessionId)) {
        defects.push({
          sessionId,
          kind: 'unsealed_session',
          detail:
            `session ${sessionId} has no manifest-${sessionId}.json — ` +
            `its log is not covered by any seal.`,
        });
      }
    }
  }

  return defects;
}

// ---------------------------------------------------------------------------
// 3. Union synthesis
// ---------------------------------------------------------------------------

/**
 * Build the in-memory union manifest spanning every valid rolling seal.
 *
 * This is the object the rest of analysis-core reads as `bundle.manifest`, and
 * it is why `validateBundleManifestShape` accepts N sessions at 1.2 while
 * `validateRollingSessionManifest` enforces exactly-one on each on-disk FILE.
 *
 * `assignment_id` / `semester` are scalars the union can only have one of. They
 * are taken from the first seal in `sessionOrder`; any seal that disagrees
 * becomes a `divergent_scope` defect rather than being silently dropped, because
 * two seals claiming different assignments inside one `.provenance/` is
 * precisely what an integrity tool exists to notice.
 *
 * `extension_hash` is NOT one of those. It records which recorder BUILD produced
 * a session, and a student who updates their recorder part-way through an
 * assignment produces sessions with different build hashes for entirely honest
 * reasons — a single `manifest.json` simply carries whichever build was current
 * at seal time and passes. So variance is normal and must not be a defect.
 *
 * The union still has to carry one, and it carries the NEWEST session's: it is
 * the build behind the final state of the work, and it matches the
 * last-writer-wins rule already used for `submission_files`. Picking a single
 * scalar would, on its own, hide a build — a student could record one session
 * under an official recorder and the rest under a modified one, and only the
 * session that happened to sort first would ever be checked against the
 * allowlist. So the loader also keeps EVERY observed hash on
 * `bundle.rollingSeal.observedExtensionHashes`, and
 * `heuristics/extension-hash-mismatch.ts` checks all of them.
 *
 * `submission_files` is a last-writer-wins merge in `sessionOrder`. That matches
 * check 8's model: each rolling manifest records the on-disk state as of ITS
 * session's last checkpoint, so for a file touched across several sessions the
 * newest session's hash is the current truth — the same "last recorded hash
 * wins" rule `lastRecordedHashes` applies to events.
 *
 * @param seals        Seals that survived {@link validateRollingSeals}.
 * @param sessionOrder LOGICAL session ids oldest → newest, as the loader sorted
 *   them — read out of each packed `.slog`'s `session.start`, never from a
 *   filename. Branded so a `.slog` filename uuid cannot be passed here: matching
 *   seals against filename uuids is what silently emptied prefix coverage on
 *   every git submission. Seals whose session is not in this list (no `.slog`)
 *   are appended after it in ascending id order, so the result is deterministic
 *   either way.
 * @returns `null` when there is no seal to synthesize from.
 */
export function synthesizeRollingUnionManifest(
  seals: readonly RollingSeal[],
  sessionOrder: readonly LogicalSessionId[],
): { manifest: BundleManifest; defects: RollingSealDefect[] } | null {
  if (seals.length === 0) return null;

  const bySession = new Map(seals.map((s) => [s.sessionId, s]));
  const ordered: RollingSeal[] = [];
  for (const sessionId of sessionOrder) {
    const seal = bySession.get(sessionId);
    if (seal !== undefined) {
      ordered.push(seal);
      bySession.delete(sessionId);
    }
  }
  // Seals with no corresponding .slog — deterministic tail, ascending id.
  for (const seal of [...bySession.values()].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))) {
    ordered.push(seal);
  }

  const first = ordered[0]!;
  const defects: RollingSealDefect[] = [];

  for (const seal of ordered.slice(1)) {
    const disagreements: string[] = [];
    if (seal.manifest.assignment_id !== first.manifest.assignment_id) {
      disagreements.push(
        `assignment_id ${seal.manifest.assignment_id} != ${first.manifest.assignment_id}`,
      );
    }
    if (seal.manifest.semester !== first.manifest.semester) {
      disagreements.push(`semester ${seal.manifest.semester} != ${first.manifest.semester}`);
    }
    // `extension_hash` is deliberately NOT a scope disagreement. A student who
    // updates their recorder mid-assignment legitimately records sessions under
    // different build hashes, and today's single `manifest.json` carries only
    // the hash current at seal time and passes. Treating variance as a defect
    // failed check 1 for updating the extension — an accusation against an
    // honest student. The hashes are not discarded: every one is preserved on
    // `bundle.rollingSeal.observedExtensionHashes` and checked against the
    // known-good allowlist by `heuristics/extension-hash-mismatch.ts`.
    if (disagreements.length > 0) {
      defects.push({
        sessionId: seal.sessionId,
        kind: 'divergent_scope',
        detail:
          `manifest-${seal.sessionId}.json disagrees with manifest-${first.sessionId}.json: ` +
          `${disagreements.join('; ')}.`,
      });
    }
  }

  // Last-writer-wins merge over submission_files, in session order.
  const submissionFiles = new Map<string, SubmissionFileEntry>();
  for (const seal of ordered) {
    for (const f of seal.manifest.submission_files ?? []) {
      submissionFiles.set(f.path, f);
    }
  }

  // `scope_capped`'s own doc comment promises "ANY session's recorder
  // reported…", so the union must OR every per-session value together rather
  // than silently dropping the field. A git-submitted (rolling-sealed) bundle
  // whose recorder disclosed a capped session must not read `false` here —
  // that would let `wasFileWatched` assert "in scope, no activity" against a
  // student from a record the recorder itself said was incomplete. Omitted
  // (not `false`) when no per-session manifest reports it at all, matching the
  // field's own "absent means this recorder does not report" contract.
  const scopeCapped = ordered.some((seal) => seal.manifest.scope_capped === true);

  const manifest: BundleManifest = {
    format_version: ROLLING_MANIFEST_FORMAT_VERSION,
    assignment_id: first.manifest.assignment_id,
    semester: first.manifest.semester,
    // Newest session's build, not the first — see the docstring. Every observed
    // hash is preserved separately so none is hidden by this choice.
    extension_hash: ordered[ordered.length - 1]!.manifest.extension_hash,
    sessions: ordered.map((seal) => seal.manifest.sessions[0]),
    submission_files: [...submissionFiles.values()],
    ...(scopeCapped ? { scope_capped: true } : {}),
  };

  return { manifest, defects };
}
