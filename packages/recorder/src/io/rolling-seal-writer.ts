/**
 * The ROLLING SEAL, write side (program spec §8, S3).
 *
 * A git-submitted assignment has no seal step: the student pushes, the grader
 * clones, nothing ever runs `provenance.prepareSubmissionBundle`. So the seal
 * has to move off the submission event and onto the recording itself. This
 * module rewrites, on every checkpoint,
 *
 *   .provenance/manifest-<session_id>.json   BundleManifest at format_version 1.2
 *   .provenance/manifest-<session_id>.sig    ed25519 over the canonical JSON
 *
 * so whatever is committed to git is always a valid seal of the state at that
 * moment. `log-core/src/rolling-manifest.ts` is the authoritative design; the
 * two rules this module exists to honour are:
 *
 *   1. The file covers EXACTLY ONE session, whose `session_id` is non-null and
 *      equals the id in the filename. Filenames come from
 *      `rollingManifestFilenames()` and are never spelled by hand here, so the
 *      writer and `parseRollingManifestFilename` cannot drift.
 *   2. It is signed by THAT session's own ephemeral key — the same key whose
 *      public half is recorded in `session.start`. Check 1 verifies a rolling
 *      seal against exactly one pubkey, so signing with anything else fails.
 *
 * ## The `final` marker
 *
 * Every roll but one is taken while the log is still growing, so its digests
 * commit to a PREFIX and a reader must not treat later bytes as tampering. The
 * exception is the roll `dispose()` takes after `session.end` is emitted and the
 * writer flushed: that log is finished, and saying so — `final: true`, inside
 * the signed payload — is what lets the reader enforce WHOLE-FILE equality and
 * catch an entry appended after the session ended.
 *
 * The claim is the caller's to make, because only the caller knows the ordering.
 * This module just records it. Passing `final` from a checkpoint would assert
 * that a live log is finished and turn the student's next keystroke into a
 * finding, so exactly one call site sets it.
 *
 * ## What this module must never touch
 *
 * `manifest.json` / `manifest.sig`. Those are the classic seal, written only by
 * `commands/seal.ts`. A classic sealed bundle keeps the same 1.1 manifest, the
 * same canonical bytes and the same signature it has today.
 *
 * ## Path scope, and inheriting `commands/seal.ts`'s hard-won invariants
 *
 * The `files_under_review` exact list is gone — a course now names a folder
 * (`src/`) or a suffix (`*.java`) via a {@link ResolvedScope}, resolved from the
 * course manifest by `scopeFromManifest`. A rule entry cannot be enumerated, so
 * this module walks the workspace (via the shared `workspace-walk.ts`, the same
 * walk `commands/seal.ts` uses) and assigns each file a role with
 * `resolvePathRole`, exactly as the classic seal does — otherwise a course
 * scoped to `src/` would get a rolling manifest that lists NOTHING, and the two
 * seals of the same session would disagree about what was under review.
 *
 * `missing` is an AFFIRMATIVE claim about the student — "this file was named and
 * is not there" — read by staff in academic-integrity proceedings, so it is
 * reachable from exactly ONE condition: an EXACT `scope.track` entry whose read
 * fails with ENOENT. A rule entry asserts nothing about any particular file
 * existing, so a rule match that vanishes is silently dropped, never `missing`.
 * A walk-discovered file that cannot be read (permission error, race, a
 * directory changing shape underneath the walk), a path that resolves outside
 * the workspace root (a student's `ln -s ~/shared/x x`, or a `..` in an exact
 * entry), and a duplicate real-path collision between an exact entry and a
 * file the walk already sealed under a different spelling are all DROPPED —
 * never recorded `missing`. Unlike `commands/seal.ts`, this module has no
 * `SealWarnings` surface to raise a flag on: a rolling reseal is a background
 * operation with no user-facing "seal now" action to attach a warning banner
 * to, so a drop here is silent rather than disclosed. The property that
 * matters — never a false accusation — holds either way.
 *
 * ## Atomicity, and the window that cannot be closed
 *
 * A rolling manifest is rewritten every ~100 events into a directory that is
 * under git and gets committed. A partial write would leave a corrupt signed
 * artifact there, so both files go through `atomicWriteFilePair`: both temps are
 * written and fsynced, and only then are both renamed back to back.
 *
 * POSIX cannot rename two files as one operation, so a reader that looks between
 * the two renames sees a new `.json` beside the previous `.sig` — a seal that
 * does not verify. Staging first shrinks that window to a single syscall, which
 * is the best available without a journal. It is reported, not silently
 * survived: `git commit` landing inside that window produces a `manifest_sig`
 * failure naming the session, which is the correct outcome for evidence we
 * cannot vouch for.
 *
 * ## Failure is never fatal
 *
 * Recording matters more than sealing. Every failure — the directory deleted by
 * a `git checkout`, a read-only checkout, a full disk — comes back as
 * `{ kind: 'error' }` (CLAUDE.md: errors are values when expected). Nothing here
 * throws, so a checkpoint's sign-and-write cannot be aborted by the seal, and
 * the session records on.
 *
 * ## Cadence and cost
 *
 * This is called at session start, after every checkpoint (every ~100 recorded
 * entries — `session-registry.ts`'s `CHECKPOINT_INTERVAL`), and once more at
 * `dispose()` with `final: true`. Path-scope's walk therefore runs far more
 * often than `commands/seal.ts`'s single walk at submission time: every
 * checkpoint now recurses the whole workspace tree (pruning only `.git/` and
 * `.provenance/`) and reads+hashes every in-scope file, where the pre-path-scope
 * version only read the exact files named in `files_under_review`. See this
 * module's test file and the task report for a measurement; no caching was
 * added here without being asked, per the task's instruction to report the
 * cost rather than invent a fix.
 */

import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  sha256Hex,
  signBundleManifest,
  rollingManifestFilenames,
  ROLLING_MANIFEST_FORMAT_VERSION,
  resolvePathRole,
  isExactEntry,
} from '@provenance/log-core';
import type { BundleManifest, SubmissionFileEntry, ResolvedScope } from '@provenance/log-core';
import { atomicWriteFilePair } from './atomic-write.js';
import type { AtomicWriteFs } from './atomic-write.js';
import { walkWorkspace, hasHardExcludedSegment } from './workspace-walk.js';
import { readWorkspaceFile } from './workspace-file-read.js';
import type { WorkspaceFileReadResult } from './workspace-file-read.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RollingSealOptions = {
  /** `.provenance/` for THIS session's assignment root. */
  provenanceDir: string;
  /**
   * The session id from `session.start` — NOT the uuid in the `.slog` filename.
   * The analyzer keys sessions by `session.start.data.session_id`, and that is
   * the id `reconcileRollingSealsWithSessions` matches seals against.
   */
  sessionId: string;
  prevSessionId: string | null;
  /** Absolute path of this session's `.slog`. Its `.meta` is `${slogPath}.meta`. */
  slogPath: string;
  /** Assignment root, for resolving the scope (rule matches are relative to it). */
  assignmentRoot: string;
  assignmentId: string;
  semester: string;
  /** The resolved scope from the course manifest. Replaces the old exact-path list. */
  scope: ResolvedScope;
  /** Whether the recorder's expected-content cap refused an in-scope path this session. */
  scopeCapped: boolean;
  /** This session's ed25519 private key. 32 bytes. */
  sessionPrivkey: Uint8Array;
  /**
   * Hash of the recorder's own `dist/`, resolved ONCE per session by the caller.
   * `computeExtensionHash` walks the whole directory, so recomputing it on every
   * checkpoint would be the pathological version of this feature.
   */
  extensionHash: string;
  /**
   * Mark this seal FINAL — the last one this session will ever get, so its
   * digests commit to the WHOLE log rather than to a prefix.
   *
   * Set by exactly ONE caller: the `dispose()`-time roll in
   * `session/session-registry.ts`, which runs after `session.end` has been
   * emitted, the writer flushed and the pending checkpoint drained. That is the
   * only moment at which the claim is true.
   *
   * Never set it on the session-start roll or on a checkpoint roll. Doing so
   * would assert that a log which is about to keep growing is finished, and the
   * reader would then read the student's own next keystroke as an append past a
   * final seal — a manufactured finding against someone still working.
   */
  final?: boolean;
  /** Injectable fs for the atomic write, so tests can force rename failures. */
  _fs?: AtomicWriteFs;
};

export type RollingSealResult =
  | {
      kind: 'written';
      manifestPath: string;
      sigPath: string;
      /** Exactly the bytes written to the `.json` — i.e. exactly what was signed. */
      canonicalJson: string;
      signatureHex: string;
    }
  | { kind: 'error'; message: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * sha256 of a file's bytes, or of empty bytes when it cannot be read.
 *
 * The empty-bytes fallback matches `commands/seal.ts`'s existing defensive
 * behaviour, and it is what keeps this path safe when git moves the ground: a
 * `git checkout` that removes the `.slog` mid-session yields a well-formed
 * 64-hex hash rather than an exception or an unwritable manifest.
 */
async function sha256OfFile(filePath: string): Promise<string> {
  try {
    const bytes = await fsPromises.readFile(filePath);
    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return sha256Hex('');
  }
}

/**
 * `readWorkspaceFile`'s `present`/`missing` outcomes (see
 * `io/workspace-file-read.ts`) — the only two that may be pushed into
 * `collectSubmissionFiles`'s `found`. Its other two outcomes, `unreadable`
 * and `out_of_workspace`, are always handled (dropped) at the call sites
 * below before a result ever reaches this narrower type — see
 * `readWorkspaceFile`'s docstring for why `missing` is reachable from exactly
 * ONE condition (ENOENT).
 */
type TrackedFile = Extract<WorkspaceFileReadResult, { status: 'present' | 'missing' }>;

/**
 * Every in-scope file's current on-disk state, as `SubmissionFileEntry`s.
 *
 * Same three-part shape as `commands/seal.ts` step 3:
 *   1. Walk the workspace (shared `workspace-walk.ts`), assign each file a
 *      role via `resolvePathRole`, and read the ones that are `reviewed` or
 *      `attachment`. A walk-discovered path that cannot be read is DROPPED,
 *      never recorded `missing` — a rule entry asserts nothing about any
 *      particular file existing.
 *   2. Every EXACT `scope.track` entry the walk did not already sight gets its
 *      own read attempt, in `scope.track` order for stable output. Only THIS
 *      loop may mint a `missing` record, and only for its own ENOENT.
 *   3. An exact entry whose real path collides with a file the walk already
 *      sealed under a different spelling is DROPPED (the bytes are not lost —
 *      sealed under the other path — but the duplicate claim is not kept).
 *
 * Ordered, not `Promise.all`: the manifest's `submission_files` order must be
 * stable across checkpoints, otherwise the canonical bytes churn for no
 * reason.
 */
async function collectSubmissionFiles(
  workspaceRoot: string,
  scope: ResolvedScope,
): Promise<SubmissionFileEntry[]> {
  let workspaceRealRoot: string;
  try {
    workspaceRealRoot = await fsPromises.realpath(workspaceRoot);
  } catch {
    // Fail CLOSED, matching `resolveContainment`: if the root itself cannot be
    // realpath'd, every candidate's real form will fail to match this lexical
    // fallback, so every candidate is rejected as `outside` rather than opened
    // unverified.
    workspaceRealRoot = path.resolve(workspaceRoot);
  }

  const walkResult = await walkWorkspace(workspaceRoot);

  const sightedInScope = new Set<string>();
  const found: Array<TrackedFile & { role: 'reviewed' | 'attachment' }> = [];

  for (const rel of walkResult.paths) {
    const role = resolvePathRole(rel, scope);
    if (role !== 'reviewed' && role !== 'attachment') continue;
    // Recorded as sighted BEFORE the read is attempted — see
    // `commands/seal.ts` fix round 2, Important 1 — so a file the walk saw but
    // could not re-open is never retried by the exact-entry loop below into a
    // false `missing`.
    sightedInScope.add(rel);
    const result = await readWorkspaceFile(workspaceRoot, workspaceRealRoot, rel);
    if (result.status !== 'present') {
      // 'missing' (vanished between listing and reading), 'unreadable', or
      // 'out_of_workspace' (unreachable via a walk-discovered path in
      // practice, since the walk only yields real, non-symlink dirents, but
      // classified honestly regardless). Never recorded — this path was
      // discovered by the walk, not asserted by the manifest.
      continue;
    }
    found.push({ ...result, role });
  }

  // Real-path cache for the exact-entry dedupe below. Lazy: a session with no
  // exact entry colliding with an already-walked file never calls `realpath`
  // here at all.
  const realPathCache = new Map<string, string>();
  async function realPathOf(relPath: string): Promise<string> {
    const cached = realPathCache.get(relPath);
    if (cached !== undefined) return cached;
    let real: string;
    try {
      real = await fsPromises.realpath(path.join(workspaceRoot, relPath));
    } catch {
      real = path.resolve(workspaceRoot, relPath);
    }
    realPathCache.set(relPath, real);
    return real;
  }

  for (const entry of scope.track) {
    if (!isExactEntry(entry)) continue;
    if (resolvePathRole(entry, scope) !== 'reviewed') continue;
    // The walk's own directory-level pruning never sees an EXACT entry that
    // names a path inside a nested `.git/`/`.provenance/` — this loop reads
    // directly by string, bypassing that pruning entirely.
    if (hasHardExcludedSegment(entry)) continue;
    if (sightedInScope.has(entry)) continue;

    const result = await readWorkspaceFile(workspaceRoot, workspaceRealRoot, entry);
    if (result.status === 'out_of_workspace' || result.status === 'unreadable') {
      // DROPPED, never `missing` — see `readWorkspaceFile`'s docstring.
      continue;
    }
    if (result.status === 'present') {
      const candidateReal = await realPathOf(entry);
      let duplicate = false;
      for (const f of found) {
        if (f.status !== 'present') continue;
        if ((await realPathOf(f.path)) === candidateReal) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;
    }
    found.push({ ...result, role: 'reviewed' });
  }

  return found.map((f) =>
    f.status === 'present'
      ? { path: f.path, status: 'present', sha256: f.sha256, role: f.role }
      : { path: f.path, status: 'missing', sha256: null, role: f.role },
  );
}

// ---------------------------------------------------------------------------
// writeRollingSeal
// ---------------------------------------------------------------------------

/**
 * Rewrite this session's rolling seal to reflect the state right now.
 *
 * Steps:
 *   1. Hash the `.slog` and `.slog.meta` as they currently stand on disk.
 *   2. Walk the workspace and resolve every in-scope file's on-disk state —
 *      see `collectSubmissionFiles`.
 *   3. Build a 1.2 manifest covering this one session.
 *   4. Canonicalize + sign with this session's own private key, via the same
 *      `signBundleManifest` the classic seal uses — so both shapes are produced
 *      byte-identically.
 *   5. Atomically commit `.json` + `.sig` together.
 *
 * Never throws.
 */
export async function writeRollingSeal(opts: RollingSealOptions): Promise<RollingSealResult> {
  const {
    provenanceDir,
    sessionId,
    prevSessionId,
    slogPath,
    assignmentRoot,
    assignmentId,
    semester,
    scope,
    scopeCapped,
    sessionPrivkey,
    extensionHash,
  } = opts;
  const isFinal = opts.final === true;

  try {
    // Step 1: hashes of this session's own log files, as they are right now.
    const slogSha256 = await sha256OfFile(slogPath);
    const metaSha256 = await sha256OfFile(`${slogPath}.meta`);

    // Step 2: walk the workspace and resolve every in-scope file.
    const submissionFiles = await collectSubmissionFiles(assignmentRoot, scope);

    // Step 3: exactly one session, non-null id, matching the filename below.
    const manifest: BundleManifest = {
      format_version: ROLLING_MANIFEST_FORMAT_VERSION,
      assignment_id: assignmentId,
      semester,
      extension_hash: extensionHash,
      sessions: [
        {
          session_id: sessionId,
          prev_session_id: prevSessionId,
          slog_sha256: slogSha256,
          meta_sha256: metaSha256,
        },
      ],
      submission_files: submissionFiles,
      // OMITTED entirely unless capped, never written as `false`. An absent
      // key and a `false` value canonicalize — and therefore hash — to two
      // different byte strings, so writing `false` explicitly would silently
      // change the signed message from what a course whose cap never bit
      // would otherwise produce.
      ...(scopeCapped ? { scope_capped: true } : {}),
      // OMITTED entirely unless final, never written as `final: false`. A
      // non-final rolling manifest must stay byte-identical to what 1.2 emitted
      // before this field existed: the canonical bytes are the signed message,
      // and they are pinned by cross-language conformance vectors that two other
      // recorder implementations verify against.
      ...(isFinal ? { final: true } : {}),
    };

    // Step 4: sign with THIS session's key.
    const signed = await signBundleManifest(manifest, sessionPrivkey);

    // Step 5: commit both files. Filenames come from log-core so the writer and
    // the reader's `parseRollingManifestFilename` share one definition.
    const names = rollingManifestFilenames(sessionId);
    const manifestPath = path.join(provenanceDir, names.json);
    const sigPath = path.join(provenanceDir, names.sig);

    // Deliberately NO mkdir here. `.provenance/` is created once by
    // startSession, and if a `git checkout` has since removed it then the
    // `.slog` this manifest claims to seal is gone too (the SessionWriter's fd
    // survives, but it points at an unlinked inode). Recreating the directory
    // would leave a signed manifest sealing a log that is not there — precisely
    // the `no_session_log` defect the reader exists to report — and would let a
    // straggling write resurrect a directory the student or git just deleted.
    // Failing the seal and leaving the filesystem alone is the honest outcome.
    await atomicWriteFilePair(
      [
        { targetPath: manifestPath, contents: signed.canonicalJson },
        { targetPath: sigPath, contents: signed.signatureHex },
      ],
      opts._fs,
    );

    return {
      kind: 'written',
      manifestPath,
      sigPath,
      canonicalJson: signed.canonicalJson,
      signatureHex: signed.signatureHex,
    };
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) };
  }
}
