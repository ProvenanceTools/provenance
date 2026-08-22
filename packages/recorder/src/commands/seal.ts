/**
 * Bundle seal command.
 *
 * PRD §4.6 (seal operation), §5.3 (bundle = ZIP of .provenance/ + submission files),
 * §5.4 (feeds checks 1-8), §6 (extension_hash in manifest).
 *
 * Produces:
 *   .provenance/manifest.json   — BundleManifest 1.1 (atomically written)
 *   .provenance/manifest.sig    — hex ed25519 signature over canonical manifest JSON (atomic)
 *   <outputDir>/<id>-bundle-<ts>.zip — ZIP of .provenance/ + reviewed files at root
 *
 * The signature covers the JCS-canonical bytes of manifest.json. The Analyzer verifies by:
 *   1. Reading manifest.json → canonicalize → verify sig against session_pubkey from session.start.
 *
 * Design notes:
 *   - NEVER aborts on a broken or unparseable chain. Instead, warnings are accumulated and the
 *     bundle is always sealed. The analyzer detects tampering via Check 3 (hash chain) and
 *     Check 8 (submitted_code_match). This lets students submit even when recording was
 *     interrupted, while keeping all integrity evidence visible to staff.
 *   - meta files are optional: if a .slog.meta doesn't exist, meta_sha256 is the sha256 of
 *     an empty byte sequence (caller is responsible for always writing the meta in Phase 9;
 *     this is a defensive fallback, not a design choice).
 *   - NEVER seals a bundle the analyzer cannot open. `.provenance/` legitimately
 *     accumulates artifacts that the loader treats as fatal to the WHOLE bundle:
 *     a zero-byte log from a session that never flushed, a `.slog.meta` whose
 *     `.slog` was quarantined away, and a rolling seal naming a session that is
 *     not here. Those are excluded from the ZIP and reported in `warnings` —
 *     never deleted from disk, since a git-submitted `.provenance/` is read off
 *     disk and may hold a partner's evidence. See step 1b.
 *   - The ZIP includes ALL files in provenanceDir (slog + meta + manifest + sig), plus the
 *     raw on-disk bytes of every file in filesUnderReview (placed at the workspace-relative
 *     path in the zip root). Missing files are recorded in manifest.submission_files with
 *     status 'missing' but are not added to the zip.
 *   - Atomic writes for manifest.json and manifest.sig prevent partial state.
 */

import * as fsPromises from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import * as ed from '@noble/ed25519';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  parseEntries,
  validateChain,
  sha256Hex,
  signBundleManifest,
  parseRollingManifestFilename,
  PROVENANCE_GITATTRIBUTES_FILENAME,
  resolvePathRole,
  isExactEntry,
  isHardExcluded,
} from '@provenance/log-core';
import type { BundleManifest, SignedBundleManifest, ResolvedScope } from '@provenance/log-core';
import { atomicWriteFile } from '../io/atomic-write.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SealWarnings = {
  /** True if any session's hash chain failed to validate at seal time. */
  chainBroken: boolean;
  /** True if any .slog could not be parsed / had no readable session.start. */
  unreadableSession: boolean;
  /** True if a `.slog.meta` was dropped because its `.slog` is not on disk (quarantined, deleted). */
  orphanedMeta: boolean;
  /** True if a zero-byte `.slog` — a session that started and never flushed — was dropped with its meta. */
  emptySession: boolean;
  /** True if a rolling seal was dropped because the session it seals is not in the bundle. */
  orphanedRollingSeal: boolean;
  /**
   * True if a path the walk discovered as in-scope (reviewed or attachment)
   * could not be read back — edited out from under the seal, permission denied,
   * a transient I/O error. The file is DROPPED from the bundle rather than
   * recorded `missing`: the walk only proves the path existed a moment ago, not
   * that it was ever absent, and only an EXACT `track` entry may claim absence
   * (see `isExactEntry` at step 3). Never a finding by itself; a reader must not
   * treat it as evidence either way about the dropped file's content.
   *
   * Included in `sealDroppedArtifacts` (fix round 2, Important 4): a file that
   * was in scope now vanishes from the evidence bundle, and the only trace is
   * this flag, so it must reach the same "mention this to course staff"
   * disclosure the orphan guard's own drops already get.
   */
  unreadableInScopeFile: boolean;
  /**
   * True if a directory under the workspace could not be listed while walking
   * for in-scope files — most often a permissions problem. Whatever that
   * subtree held is silently absent from the bundle unless this is surfaced:
   * exactly the "in scope, no activity" inference `scope_capped` exists to rule
   * out at the registry level, just one layer lower (the walk, not the cap).
   *
   * Included in `sealDroppedArtifacts` for the same reason as
   * `unreadableInScopeFile` above.
   */
  unreadableScopeDirectory: boolean;
};

/**
 * Did the seal leave anything out of the zip that a reader should be told
 * about? Covers both the `.slog`-family orphan guard (step 1b) and the
 * workspace-walk drops (step 3) — every case here means "the bundle is
 * incomplete in a way that is not evidence of anything," which is exactly the
 * fact `extension.ts`'s "mention this to course staff" warning exists to
 * surface.
 */
export function sealDroppedArtifacts(warnings: SealWarnings): boolean {
  return (
    warnings.orphanedMeta ||
    warnings.emptySession ||
    warnings.orphanedRollingSeal ||
    warnings.unreadableInScopeFile ||
    warnings.unreadableScopeDirectory
  );
}

export type SealResult =
  | { kind: 'ok'; bundlePath: string; manifestSha256: string; warnings: SealWarnings }
  | { kind: 'no_sessions' }
  | { kind: 'write_error'; message: string };

export type SealDeps = {
  /** Assignment root directory (for output path + .provenance/ location). */
  assignmentRoot: string;
  /** Path to .provenance/ (allows override in tests). */
  provenanceDir: string;
  /** Assignment id + semester from the loaded manifest. */
  assignmentId: string;
  semester: string;
  /** The resolved scope from the course manifest. Replaces the old exact-path list. */
  scope: ResolvedScope;
  /** Whether the recorder's expected-content cap refused an in-scope path this session. */
  scopeCapped: boolean;
  /** Active session private key for signing the bundle manifest. 32 bytes. */
  sessionPrivkey: Uint8Array;
  /** Active session public key, hex. */
  sessionPubkeyHex: string;
  /** Computes a sha256 of the recorder's own dist/ directory. */
  computeExtensionHash: () => Promise<string>;
  /** Output directory for the resulting .zip. Defaults to assignmentRoot. */
  outputDir?: string;
  /** Now (for the zip filename timestamp). */
  now: () => Date;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute sha256 of file bytes at the given path.
 * If the file doesn't exist, returns sha256 of empty bytes (defensive fallback).
 */
async function sha256OfFile(filePath: string): Promise<string> {
  try {
    const bytes = await fsPromises.readFile(filePath);
    const hash = createHash('sha256');
    hash.update(bytes);
    return hash.digest('hex');
  } catch {
    // File doesn't exist or can't be read — return sha256('') as a stable fallback.
    return sha256Hex('');
  }
}

/**
 * Size in bytes of the file at `filePath`, or 0 if it cannot be stat'ed.
 *
 * A file that `readdir` just listed but `stat` cannot see is gone; treating it
 * as contentless drops it through the same reported path as a genuinely empty
 * one, rather than failing the whole seal over a file with nothing in it.
 */
async function fileSize(filePath: string): Promise<number> {
  try {
    const st = await fsPromises.stat(filePath);
    return st.size;
  } catch {
    return 0;
  }
}

type ReviewedFile =
  | { path: string; status: 'present'; sha256: string; bytes: Uint8Array }
  | { path: string; status: 'missing'; sha256: null };

/** True iff `absPath` resolves to `root` itself or somewhere underneath it. */
function isWithinRoot(root: string, absPath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(absPath);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
}

/**
 * True if any path SEGMENT of `relPath` is exactly `.git` or `.provenance`.
 *
 * Shared by `walkWorkspace` (which prunes at the directory level, so it only
 * ever needs to check one segment at a time) and the exact-entry loop in
 * `sealBundle` step 3, which reads a manifest-supplied path directly and so
 * never passes through the walk's own pruning at all — an EXACT entry naming
 * a path inside a nested `.git/`/`.provenance/` must be caught here too (fix
 * round 2, Important 2), the same leak `walkWorkspace`'s docstring describes.
 */
function hasHardExcludedSegment(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg === '.git' || seg === '.provenance');
}

/**
 * Read a reviewed file's raw on-disk bytes + sha256, or mark it missing.
 * `relPath` is workspace-relative; resolved against workspaceRoot.
 */
async function readReviewedFile(workspaceRoot: string, relPath: string): Promise<ReviewedFile> {
  const abs = path.join(workspaceRoot, relPath);
  if (!isWithinRoot(workspaceRoot, abs)) {
    // A path that resolves outside the workspace root — most plausibly a `..`
    // segment in an EXACT track entry — is never read, whatever the manifest
    // claims. `validateScopeEntry` deliberately never runs against a 1.x
    // manifest's `files_under_review` (1.x parsing must never reject —
    // `manifest.ts`), so this containment check is the seal's own last line of
    // defense (fix round 2, Important 3): gated only by the course signature,
    // so this is a staff-error/key-compromise concern rather than something a
    // student can trigger, but it must not read or seal a file from outside
    // the workspace either way. A path the walk itself produced can never trip
    // this: it is always built from real directory entries under
    // `workspaceRoot`.
    return { path: relPath, status: 'missing', sha256: null };
  }
  try {
    const bytes = await fsPromises.readFile(abs);
    const hash = createHash('sha256');
    hash.update(bytes);
    return {
      path: relPath,
      status: 'present',
      sha256: hash.digest('hex'),
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  } catch {
    return { path: relPath, status: 'missing', sha256: null };
  }
}

/** Result of walking one subtree: the files found, and whether any directory in it refused to list. */
type WalkResult = { paths: string[]; hadUnreadableDir: boolean };

/**
 * Every file under `root`, as workspace-relative forward-slash paths.
 *
 * Hard-excluded directories are skipped at the DIRECTORY level rather than
 * filtered afterwards: `.git/` in a real assignment holds thousands of objects,
 * and walking them to throw them away is the difference between a seal that
 * feels instant and one that does not.
 *
 * The skip is by SEGMENT NAME (`d.name === '.git' || d.name === '.provenance'`),
 * not `isHardExcluded`'s root-anchored prefix check. `isHardExcluded` only
 * matches a path that STARTS WITH `.git/` or `.provenance/`, so it says nothing
 * about `vendor/lib/.git/` (a submodule) or, worse, a SIBLING assignment's
 * `.provenance/` under this repo's nested/concurrent multi-assignment
 * recording (spec `2026-08-18-multicourse-program-architecture.md`) — a rule
 * entry like `*.json` would otherwise walk into `hw3/.provenance/` and seal
 * that assignment's signed manifest into THIS bundle, leaking one student's
 * provenance into another's evidence. `isHardExcluded` is deliberately NOT
 * changed to do this itself: it is pinned by `tools/path-scope-vectors.json`
 * and re-implemented by hand in the JetBrains and Neovim recorders, so its root
 * semantics stay put and this walk-local rule covers the deeper case instead.
 * The `isHardExcluded` call is kept alongside as a second, redundant check —
 * cheap insurance if the hard-excluded prefix list ever grows past this pair.
 * This pruning only protects paths the WALK produces. An EXACT `track` entry
 * naming a nested `.git/`/`.provenance/` path reads directly by string and
 * never passes through here, so `sealBundle` step 3 applies the same
 * `hasHardExcludedSegment` check again, itself, against the manifest string.
 *
 * `Dirent.isDirectory()` / `isFile()` do not follow symlinks (they classify the
 * directory ENTRY itself, `lstat`-flavoured) — see `should not recurse into a
 * symlinked directory` in `seal.test.ts`. A symlinked directory is therefore
 * neither traversed nor walked into, so this cannot cycle on a self-referential
 * link or walk outside the workspace through one. A symlinked FILE is likewise
 * not reported as `isFile()` here and so never appears in the walk's output; an
 * EXACT `track` entry naming one is still resolved correctly at step 3, because
 * that step reads it directly with `fsPromises.readFile`, which does follow the
 * link.
 *
 * A directory this function cannot `readdir` (most often a permissions
 * problem) is not silently treated as empty: `hadUnreadableDir` bubbles that up
 * so the caller can warn rather than let the subtree's files vanish from the
 * bundle without a trace.
 */
async function walkWorkspace(root: string, rel = ''): Promise<WalkResult> {
  let dirents: Dirent[];
  try {
    dirents = await fsPromises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return { paths: [], hadUnreadableDir: true };
  }
  const out: string[] = [];
  let hadUnreadableDir = false;
  for (const d of dirents) {
    const childRel = rel === '' ? d.name : `${rel}/${d.name}`;
    if (d.isDirectory()) {
      if (hasHardExcludedSegment(d.name) || isHardExcluded(`${childRel}/`)) {
        continue;
      }
      const child = await walkWorkspace(root, childRel);
      out.push(...child.paths);
      if (child.hadUnreadableDir) hadUnreadableDir = true;
    } else if (d.isFile()) {
      out.push(childRel);
    }
  }
  return { paths: out, hadUnreadableDir };
}

/**
 * Extract session_id and prev_session_id from the first entry of a parsed slog.
 * Returns null if the first entry isn't a session.start or data is malformed.
 */
function extractSessionIds(
  entries: readonly import('@provenance/log-core').HashedEnvelope[],
): { session_id: string; prev_session_id: string | null } | null {
  const first = entries[0];
  if (first === undefined || first.kind !== 'session.start') {
    return null;
  }
  const data = first.data as Record<string, unknown>;
  const session_id = typeof data['session_id'] === 'string' ? data['session_id'] : null;
  if (session_id === null) {
    return null;
  }
  const prev_session_id =
    typeof data['prev_session_id'] === 'string' ? data['prev_session_id'] : null;
  return { session_id, prev_session_id };
}

/**
 * ISO timestamp formatted for use in filenames: colons replaced with dashes.
 * E.g. "2026-05-19T14-30-00.000Z"
 */
function filenameTimestamp(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

// ---------------------------------------------------------------------------
// sealBundle
// ---------------------------------------------------------------------------

/**
 * Produce a submission-ready ZIP bundle from the .provenance/ directory.
 *
 * Step-by-step:
 *   1. List .slog files. None → no_sessions.
 *   1b. Orphan guard: drop from the bundle any artifact that would make the analyzer
 *      refuse to open it — an unpaired .slog or .slog.meta, a zero-byte .slog, and
 *      (at step 6) a rolling seal naming a session the bundle does not carry. Dropped
 *      from the ZIP only; nothing on disk is touched. Reported in `warnings`.
 *   2. For each surviving .slog: parse entries + validate chain. NEVER aborts on a broken or
 *      unparseable chain — accumulates warnings instead. For parse failures the
 *      session entry gets session_id: null. For chain breaks, chainBroken is set true.
 *      Collect: session_id (or null), prev_session_id, slog_sha256, meta_sha256.
 *   3. Walk the workspace, assign each file a role via the resolved scope, and
 *      read the ones that are reviewed or attachment. Only an EXACT track entry
 *      the walk did not already capture may be recorded `missing`.
 *   4. Build BundleManifest (format_version 1.1) including submission_files.
 *   5. Canonicalize + sign → atomic-write manifest.json and manifest.sig.
 *   6. ZIP all files in provenanceDir (including new manifest + sig), plus
 *      the raw bytes of each present reviewed file at the workspace-relative path.
 *   7. Write ZIP to outputDir. Return ok with bundlePath, manifestSha256, and warnings.
 */
export async function sealBundle(deps: SealDeps): Promise<SealResult> {
  const {
    assignmentRoot,
    provenanceDir,
    assignmentId,
    semester,
    scope,
    scopeCapped,
    sessionPrivkey,
    computeExtensionHash: getExtensionHash,
    outputDir,
    now,
  } = deps;

  // Step 1: List .slog files.
  let allEntries: string[];
  try {
    allEntries = await fsPromises.readdir(provenanceDir);
  } catch {
    // Directory doesn't exist → no sessions.
    return { kind: 'no_sessions' };
  }

  const warnings: SealWarnings = {
    chainBroken: false,
    unreadableSession: false,
    orphanedMeta: false,
    emptySession: false,
    orphanedRollingSeal: false,
    unreadableInScopeFile: false,
    unreadableScopeDirectory: false,
  };

  // ---------------------------------------------------------------------------
  // Step 1b: THE ORPHAN GUARD.
  //
  // `analysis-core`'s loader used to refuse to open a bundle whose per-session
  // artifacts do not line up, BEFORE a single validation check ran. Three shapes
  // were fatal to THE WHOLE BUNDLE, not to the one session that is malformed:
  //
  //   * a `.slog.meta` with no `.slog`          → `orphaned_meta`
  //   * a zero-byte `.slog`                     → `first_event_not_session_start`
  //                                               (actualKind "none")
  //
  // and one more, handled at the zip step below:
  //
  //   * `manifest-<id>.json` naming a session that is not here → `no_session_log`,
  //     which fails check 1 (`manifest_sig`) for the whole bundle.
  //
  // NOT handled here: a `.slog` with no `.slog.meta` (`orphaned_slog`). That is
  // the same family, but dropping it would contradict this module's documented
  // meta-optional fallback (`meta_sha256` = sha256 of empty), which
  // `seal.test.ts` pins as a requirement — a product decision, not a packaging
  // one. It is also the one shape the recorder does not produce: `MetaWriter.
  // create` writes the `.meta` eagerly, in the same breath as the `.slog`.
  //
  // So one stray file cost a student every session they recorded. That blast
  // radius is the whole reason this guard exists.
  //
  // The loader now degrades instead of dying on all three (its read-side orphan
  // guard drops and reports them), because the GIT path has no seal step to
  // filter anything. That does NOT make this guard redundant. Sealing junk
  // produces a degraded submission where a clean one was available, and — the
  // part that matters here — the seal warnings are the only place the STUDENT
  // is told. Leave it to the reader and the first person to find out is a
  // grader.
  //
  // None of these are hypothetical. A session that starts and is torn down
  // before its first flush leaves ALL THREE artifacts behind: the buffer policy
  // is {256 KiB, 1000 ms} but `SessionWriter.open` creates the `.slog` eagerly,
  // `MetaWriter.create` writes the `.meta` eagerly, and the session-start roll
  // (`session-registry.ts`, step 6c) signs a rolling seal eagerly — so the log
  // is 0 bytes at the instant its seal is written. Separately,
  // `chain-recovery.ts` quarantines a damaged `.slog` to `.corrupt-<ts>` and
  // leaves the `.slog.meta` under its original name, so the salvage path turns
  // the first hazard into the second by itself.
  //
  // THE RULE: an artifact that would make the bundle unopenable is DROPPED FROM
  // THE ZIP and reported in `warnings`.
  //
  //   * Dropped from the zip ONLY. Nothing on disk is deleted or renamed. A
  //     git-submitted `.provenance/` is read directly off disk and must keep the
  //     seal that the session-start roll exists to provide, and in a shared repo
  //     these may be a partner's files. A partner's live session is packed WITH
  //     its seal — their `.slog`, `.slog.meta` and `manifest-<id>.json` all pair
  //     up, so nothing of theirs is dropped.
  //   * Never an abort. Seal must always produce something submittable; a
  //     student cannot fix this at 11pm, and the analyzer still sees every
  //     session that IS there.
  //   * Never silent. The warnings surface at the seal command's call site
  //     exactly like `chainBroken`, so a dropped session is something a student
  //     can tell staff about rather than discover in an integrity meeting.
  //
  // A dropped `.slog` is dropped from the MANIFEST as well as the zip: the two
  // must agree, since a manifest naming a session whose file is absent is just
  // another way to make the bundle unopenable.
  // ---------------------------------------------------------------------------
  const present = new Set(allEntries);

  const slogFiles: string[] = [];
  for (const name of allEntries) {
    // `.slog.meta` ends with `.meta`, so it never matches here.
    if (!name.endsWith('.slog')) continue;

    // A CONTENTLESS `.slog`. Zero bytes means the session recorded literally
    // nothing, so dropping it discards no evidence — whereas keeping it
    // discards all of it, by making the bundle unopenable.
    if ((await fileSize(path.join(provenanceDir, name))) === 0) {
      warnings.emptySession = true;
      continue;
    }
    slogFiles.push(name);
  }

  // A `.slog.meta` whose `.slog` is not on disk at all — deleted, or renamed
  // away by the quarantine path. (The meta of a slog dropped just above is not
  // reported here: it is not orphaned, it is part of a pair this guard chose to
  // drop, and it is already covered by that pair's own warning. It still leaves
  // the zip — see `packable` at the zip step.)
  for (const name of allEntries) {
    if (name.endsWith('.slog.meta') && !present.has(name.slice(0, -'.meta'.length))) {
      warnings.orphanedMeta = true;
    }
  }

  // Everything the zip is allowed to carry from the `.slog` family: the kept
  // logs and their metas, and nothing else.
  const packable = new Set<string>();
  for (const name of slogFiles) {
    packable.add(name);
    packable.add(`${name}.meta`);
  }

  if (slogFiles.length === 0) {
    return { kind: 'no_sessions' };
  }

  // Step 2: Parse and validate each .slog. Warnings accumulate; never abort.
  const sessionEntries: BundleManifest['sessions'][number][] = [];

  // LOGICAL session ids of the sessions this bundle will actually carry, for
  // the rolling-seal half of the guard at the zip step.
  //
  // TWO-UUID RULE: this is `session.start.data.session_id`, NOT the `.slog`
  // FILENAME uuid. In production those are two different values — the writer
  // names the file `session-${randomUUID()}.slog` (`session-registry.ts`) while
  // the rolling seal is named after `recorderContext.session_id`. The analyzer
  // reconciles seals against the ids it reads out of `session.start`
  // (`parse-bundle.ts` passes `parsedSessions.map(s => s.sessionId)`), so the
  // logical id is the only correct key here; using the filename uuid would drop
  // every rolling seal in the directory, including the good ones.
  const packedSessionIds = new Set<string>();

  for (const filename of slogFiles.sort()) {
    const slogPath = path.join(provenanceDir, filename);
    const metaPath = `${slogPath}.meta`;

    // Read and parse the .slog.
    let slogText: string;
    try {
      slogText = await fsPromises.readFile(slogPath, 'utf8');
    } catch (e) {
      return {
        kind: 'write_error',
        message: `Failed to read ${filename}: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const parseResult = parseEntries(slogText);
    if (!parseResult.ok) {
      // Malformed slog — accumulate warning, still include file hashes.
      warnings.unreadableSession = true;
      sessionEntries.push({
        session_id: null,
        prev_session_id: null,
        slog_sha256: await sha256OfFile(slogPath),
        meta_sha256: await sha256OfFile(metaPath),
      });
      continue;
    }

    const entries = parseResult.value;

    // Validate the chain — set warning but do NOT abort.
    const chainResult = validateChain(entries);
    if (!chainResult.ok) {
      warnings.chainBroken = true;
    }

    // Extract session IDs. Missing session.start → unreadable session, use null id.
    const ids = extractSessionIds(entries);
    if (ids === null) {
      warnings.unreadableSession = true;
    } else {
      packedSessionIds.add(ids.session_id);
    }

    // Compute file hashes.
    const slogSha256 = await sha256OfFile(slogPath);
    const metaSha256 = await sha256OfFile(metaPath);

    sessionEntries.push({
      session_id: ids?.session_id ?? null,
      prev_session_id: ids?.prev_session_id ?? null,
      slog_sha256: slogSha256,
      meta_sha256: metaSha256,
    });
  }

  // Step 3: Walk the workspace and assign each file its role. A rule entry
  // cannot be enumerated from the manifest, so the file set is discovered here
  // rather than read off the list.
  const workspaceRoot = assignmentRoot;
  const walkResult = await walkWorkspace(workspaceRoot);
  if (walkResult.hadUnreadableDir) {
    warnings.unreadableScopeDirectory = true;
  }

  // Every path the walk SAW and role-resolved to reviewed/attachment, kept
  // regardless of whether the read below actually succeeded. The exact-entry
  // loop's skip-set (below) is built from these SIGHTINGS, not from successful
  // reads: building it from reads only reopened the exact-entry hole this
  // whole step exists to close, because every 1.x manifest's
  // `files_under_review` is nothing BUT exact entries, so a file the walk saw
  // but could not re-open would otherwise fall all the way through to the
  // exact loop and mint a false `missing` there (fix round 2, Important 1).
  const sightedInScope = new Set<string>();

  const reviewedFiles: Array<ReviewedFile & { role: 'reviewed' | 'attachment' }> = [];
  for (const rel of walkResult.paths) {
    const role = resolvePathRole(rel, scope);
    if (role !== 'reviewed' && role !== 'attachment') continue;
    sightedInScope.add(rel);
    const result = await readReviewedFile(workspaceRoot, rel);
    if (result.status === 'missing') {
      // The walk just listed this path, so its absence now means it vanished
      // (or became unreadable) between listing and reading — edited out from
      // under the seal, a permissions change, a transient I/O error. That is
      // not the same fact as "the student never had this file", so it is
      // DROPPED rather than recorded `missing`: only an EXACT track entry (the
      // loop below) may make that claim, and this path was discovered by the
      // walk, not asserted by the manifest. It is not retried below either —
      // it was SIGHTED, so `sightedInScope` already covers it.
      warnings.unreadableInScopeFile = true;
      continue;
    }
    reviewedFiles.push({ ...result, role });
  }

  // Real (symlink- and filesystem-case-canonicalised) path cache, used only to
  // dedupe an exact entry against a file the walk already sealed under a
  // different spelling — see the dedupe check below. Lazy: a bundle with no
  // exact entry colliding with an already-walked file never calls `realpath`
  // at all.
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

  // An EXACT track entry is a claim that a specific file should exist, so an
  // absent one is reportable. A rule entry claims nothing about any particular
  // file, so an absent rule-match is not a fact about the student at all —
  // reporting one would produce a finding per file they never wrote (R2).
  //
  // Existence here is decided by ATTEMPTING THE READ, never by walk-set
  // membership: the walk enumerates directory entries by the OS's exact
  // on-disk spelling and Dirent's lstat-flavoured type, so it can miss a path
  // that differs only in case on a case-insensitive filesystem, or a symlink
  // (`isFile()` is false for a symlink entry) — both of which `readReviewedFile`
  // resolves correctly because it opens the path directly, the same way the
  // pre-path-scope seal always did.
  for (const entry of scope.track) {
    if (!isExactEntry(entry)) continue;
    if (resolvePathRole(entry, scope) !== 'reviewed') continue;
    // The walk's own directory-level pruning never sees an EXACT entry that
    // names a path inside a nested `.git/`/`.provenance/` — this loop reads
    // directly by string, bypassing that pruning entirely. The same segment
    // check applies here so a manifest cannot seal a sibling assignment's
    // provenance (or a submodule's `.git/`) by naming it exactly (fix round 2,
    // Important 2).
    if (hasHardExcludedSegment(entry)) continue;
    // Already sighted by the walk under this exact spelling — do not re-read.
    if (sightedInScope.has(entry)) continue;

    const result = await readReviewedFile(workspaceRoot, entry);
    if (result.status === 'present') {
      // A case-insensitive filesystem or a symlink can make this exact entry
      // read successfully while pointing at the SAME underlying bytes the walk
      // already sealed under a different spelling. Reconcile by real path
      // rather than by string, or the same file is sealed twice under two
      // paths — doubling the bytes and handing the analyzer a second path no
      // event stream ever watched (fix round 2, Moderate 5).
      const candidateReal = await realPathOf(entry);
      let duplicate = false;
      for (const f of reviewedFiles) {
        if (f.status !== 'present') continue;
        if ((await realPathOf(f.path)) === candidateReal) {
          duplicate = true;
          break;
        }
      }
      if (duplicate) continue;
    }
    reviewedFiles.push({ ...result, role: 'reviewed' });
  }

  const submissionFiles = reviewedFiles.map((f) =>
    f.status === 'present'
      ? { path: f.path, status: 'present' as const, sha256: f.sha256, role: f.role }
      : { path: f.path, status: 'missing' as const, sha256: null, role: f.role },
  );

  // Step 4: Build BundleManifest (format_version 1.1).
  let extensionHash: string;
  try {
    extensionHash = await getExtensionHash();
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to compute extension hash: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const manifest: BundleManifest = {
    format_version: '1.1',
    assignment_id: assignmentId,
    semester,
    extension_hash: extensionHash,
    sessions: sessionEntries,
    submission_files: submissionFiles,
    ...(scopeCapped ? { scope_capped: true } : {}),
  };

  // Step 5: Canonicalize + sign + atomic-write manifest.json and manifest.sig.
  // signBundleManifest is the single signing routine shared with seed tooling so
  // the on-disk manifest.json/.sig are produced identically everywhere.
  const manifestPath = path.join(provenanceDir, 'manifest.json');
  const sigPath = path.join(provenanceDir, 'manifest.sig');

  let signed: SignedBundleManifest;
  try {
    signed = await signBundleManifest(manifest, sessionPrivkey);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to sign manifest: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    // Atomic write for manifest.json (write full canonical JSON, not the manifest object,
    // so what's on disk is exactly what was signed).
    await atomicWriteFile(manifestPath, signed.canonicalJson);
    await atomicWriteFile(sigPath, signed.signatureHex);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to write manifest/sig: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Compute manifest SHA-256 for the return value.
  const manifestSha256 = sha256Hex(new TextEncoder().encode(signed.canonicalJson));

  // Step 6: ZIP all files in provenanceDir.
  let dirEntries: string[];
  try {
    dirEntries = await fsPromises.readdir(provenanceDir);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to read provenance dir: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const zip = new JSZip();

  for (const filename of dirEntries) {
    // Skip quarantine files and temp files.
    if (filename.includes('.corrupt-') || filename.endsWith('.tmp')) {
      continue;
    }

    // Skip the `.gitattributes` this recorder writes into `.provenance/` to stop
    // git rewriting the signed bytes (see `log-core/git-attributes.ts`). It is a
    // git control file, not provenance evidence: it carries no session data, is
    // covered by no signature, and the bundle's contents are a CLOSED SET, so
    // packing it would reach `loader/unzip.ts` as `unexpected_file` and kill the
    // whole bundle. The git submission path drops it for the same reason, in
    // `server/services/ingest/gradescope/build-bundle-zip.ts`.
    if (filename === PROVENANCE_GITATTRIBUTES_FILENAME) {
      continue;
    }

    // PACKING HALF OF THE ORPHAN GUARD (step 1b). A `.slog` / `.slog.meta` is
    // packed only as part of a complete, non-empty pair that step 2 also wrote
    // into the manifest. Everything else in `.provenance/` is packed as before:
    // manifest.json, manifest.sig, and anything a future step drops in here.
    if (
      (filename.endsWith('.slog') || filename.endsWith('.slog.meta')) &&
      !packable.has(filename)
    ) {
      continue;
    }

    // ROLLING-SEAL HALF OF THE ORPHAN GUARD.
    //
    // The rolling seal (`manifest-<session_id>.json` + `.sig`) is a THIRD
    // per-session artifact, written eagerly at session start — before the
    // `.slog` has been flushed even once — and rewritten at every checkpoint
    // and at dispose(). It therefore outlives every reason step 1b has for
    // dropping a session, including the quarantine path, which has no unflushed
    // session involved at all.
    //
    // A seal whose session is not in the bundle is `no_session_log`: it names a
    // recording that is not here, and its signature can never be checked,
    // because the verifying pubkey lives in that session's own session.start.
    //
    // Dropping it cannot itself manufacture a finding. `unsealed_session` is
    // reported only for a bundle with NO classic seal (`reconcileRollingSeals
    // WithSessions` takes `hasClassicSeal`, which `parse-bundle.ts` passes as
    // `classicManifest !== null`), and every bundle this function produces
    // carries `manifest.json` covering every session it packs. Inside a classic
    // bundle a rolling seal is redundant, and a stale one is pure liability.
    //
    // Both halves go together: a `.sig` without its `.json` vouches for nothing,
    // and a `.json` without its `.sig` is an unsigned claim (`missing_sig`).
    // `parseRollingManifestFilename` matches each half independently — and
    // returns null for the classic `manifest.json` / `manifest.sig`, which are
    // always packed — so each half is dropped on its own pass and the pair stays
    // consistent.
    const rollingSeal = parseRollingManifestFilename(filename);
    if (rollingSeal !== null && !packedSessionIds.has(rollingSeal.sessionId)) {
      warnings.orphanedRollingSeal = true;
      continue;
    }

    const filePath = path.join(provenanceDir, filename);
    try {
      const fileBytes = await fsPromises.readFile(filePath);
      zip.file(filename, fileBytes);
    } catch {
      // File disappeared between readdir and readFile — skip it.
    }
  }

  // Add submitted file bytes at the zip root (mirrors the workspace layout).
  for (const f of reviewedFiles) {
    if (f.status === 'present') {
      zip.file(f.path, f.bytes);
    }
  }

  let zipBytes: Uint8Array;
  try {
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    zipBytes = new Uint8Array(zipBuffer.buffer, zipBuffer.byteOffset, zipBuffer.byteLength);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to generate ZIP: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Step 7: Write the ZIP.
  const ts = filenameTimestamp(now());
  const zipFilename = `${assignmentId}-bundle-${ts}.zip`;
  const resolvedOutputDir = outputDir ?? assignmentRoot;
  const bundlePath = path.join(resolvedOutputDir, zipFilename);

  try {
    await fsPromises.writeFile(bundlePath, zipBytes);
  } catch (e) {
    return {
      kind: 'write_error',
      message: `Failed to write bundle ZIP: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { kind: 'ok', bundlePath, manifestSha256, warnings };
}

// ---------------------------------------------------------------------------
// Verify manifest signature (used by tests and the future Analyzer)
// ---------------------------------------------------------------------------

/**
 * Verify a bundle manifest signature.
 *
 * @param canonicalManifestJson  The exact canonical JSON string that was signed.
 * @param sigHex                 Hex-encoded ed25519 signature.
 * @param pubkeyHex              Hex-encoded ed25519 public key.
 * @returns true if the signature is valid.
 */
export async function verifyManifestSig(
  canonicalManifestJson: string,
  sigHex: string,
  pubkeyHex: string,
): Promise<boolean> {
  try {
    const msgBytes = new TextEncoder().encode(canonicalManifestJson);
    const sig = hexToBytes(sigHex);
    const pubkey = hexToBytes(pubkeyHex);
    return await ed.verifyAsync(sig, msgBytes, pubkey);
  } catch {
    return false;
  }
}
