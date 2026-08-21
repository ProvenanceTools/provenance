/**
 * Test-only helper: builds a self-consistent bundle ZIP in memory.
 *
 * This is test infrastructure; it does not need to be browser-safe (vitest runs
 * it under jsdom which has crypto.getRandomValues). No Node-specific APIs are
 * used — just @noble/ed25519, log-core, and jszip.
 */

import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import JSZip from 'jszip';
import {
  chainEntry,
  sha256Hex,
  canonicalize,
  serializeEntry,
  rollingManifestFilenames,
  GENESIS_PREV_HASH,
} from '@provenance/log-core';
import type { BundleManifest, SlogMeta } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Wire SHA-512 into @noble/ed25519 so it works in jsdom where SubtleCrypto
// does not accept SharedArrayBuffer from concatBytes as the 2nd argument to
// digest(). Use @noble/hashes/sha2 (pure JS, no WebCrypto) for both paths.
// The docs-recommended pattern: set ed.hashes.sha512 = sha512.
// ---------------------------------------------------------------------------
ed.hashes.sha512 = sha512;
// Override sha512Async too: the default implementation calls SubtleCrypto.digest
// with `m.buffer` which may be a SharedArrayBuffer, rejected by jsdom's WebCrypto.
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single explicitly-specified event (post-session.start) for Phase 3 tests.
 * The `kind` and `data` must be consistent with log-core event types.
 * Wall and t are optional; if omitted they are auto-generated.
 */
export type EventSpec = {
  kind: string;
  data: Record<string, unknown>;
  wall?: string;
  t?: number;
};

/**
 * A submission file entry for 1.1 bundle tests.
 * `content` is optional — if omitted (and status is 'present'), the file entry
 * is added to the manifest but NOT to the zip (simulating a present-but-absent
 * bytes scenario for hash-mismatch testing, or you can supply wrong bytes via
 * tamper.submissionFileBytes).
 */
export type SubmissionFileSpec = {
  path: string;
  status: 'present' | 'missing';
  /** Raw string content of the file (UTF-8). Required when status === 'present'. */
  content?: string;
  /**
   * Override the sha256 recorded in the manifest (for self-check mismatch tests).
   * Default: computed from `content`.
   */
  manifestSha256Override?: string;
};

/**
 * Build a ROLLING-sealed bundle (program spec §8) — `manifest-<session_id>.json`
 * + `.sig` per session instead of a single `manifest.json`.
 *
 * When this is set, each session gets its OWN ed25519 keypair (a classic bundle
 * keeps sharing one, unchanged) and each session's rolling manifest is signed by
 * that session's own key — which is the property the reader has to enforce.
 */
export type RollingSealSpec = {
  /**
   * Also emit the classic `manifest.json` + `manifest.sig`, producing a bundle
   * that carries BOTH seal shapes.
   */
  alsoClassic?: boolean;
  /**
   * Make the `alsoClassic` manifest **stale**: mint its `slog_sha256` for one
   * session over only the first `entries` log entries, as if the classic seal
   * had been taken at that moment and the session had gone on recording.
   *
   * Without this, `alsoClassic: true` mints the classic manifest over the SAME
   * final bytes as the rolling seals, so the classic digest is never stale and
   * the both-shapes bundle a real student produces is not constructible here.
   *
   * That student is easy to find. `commands/seal.ts` writes `manifest.json` +
   * `manifest.sig` INTO `.provenance/` and never removes them, so anyone who
   * runs "Prepare Submission Bundle" once — curiosity, a ZIP-submitted sibling
   * assignment, a mixed cohort — and then keeps working and pushes ships a
   * stale classic manifest alongside live rolling seals.
   *
   * Only the `.slog` digest is staled; the `.slog.meta` digest stays current,
   * because this builder has no snapshot of the sidecar as it stood at that
   * entry. The `.slog` mismatch is what the accusation was built on, so the
   * shape is faithful where it matters and is called out where it is not.
   */
  staleClassicAfterEntries?: { sessionIndex: number; entries: number };
  /**
   * Mark each session's rolling seal FINAL — the seal the recorder writes at
   * `dispose()` over a log that will not grow again. A final seal commits to the
   * WHOLE file, so an append to it fails `log_bytes_match`; a non-final one
   * commits to a prefix and honest later growth is not a finding.
   *
   * **Defaults to `true`**, because that is what this builder actually
   * constructs: every session's digests are taken over its FINISHED `.slog` and
   * `.slog.meta`, which is a state only `dispose()` can seal. Defaulting to
   * non-final would have the builder emit a manifest whose own contents
   * contradict its claim — a seal signed mid-session that somehow already knows
   * the finished bytes.
   *
   * Set `false` for the mid-session shape: a seal signed while its session was
   * still running. Note that on its own that only changes the CLAIM, not the
   * digests — to get a genuinely unattested tail, tamper the `.slog` afterwards
   * (as `verify-log-bytes.test.ts` does) or drive the real writer, as
   * `tools/recorder-seal-conformance.test.ts` does.
   */
  final?: boolean;
  tamper?: {
    /** Session indices whose `manifest-<id>.sig` is omitted (unsigned manifest). */
    omitSigFor?: number[];
    /** Session indices whose `manifest-<id>.json` is omitted (stray sig). */
    omitJsonFor?: number[];
    /** Session indices whose rolling seal is omitted entirely (unsealed session). */
    omitSealFor?: number[];
    /**
     * Emit a rolling seal naming a session id that has no `.slog` in the bundle.
     * The manifest is a copy of session 0's with the id swapped, signed by
     * session 0's key.
     */
    extraSealForSessionId?: string;
    /**
     * A SIDEWAYS COPY: write `manifestOfSessionIndex`'s manifest content under
     * `sessionIndex`'s filenames, signed with `sessionIndex`'s OWN key.
     *
     * This is the adversarial case the filename ↔ session_id binding exists for:
     * the signature verifies (right key, right bytes), so only
     * `validateRollingSessionManifest(manifest, sessionIdFromFilename)` can catch
     * it.
     */
    sidewaysCopyFor?: { sessionIndex: number; manifestOfSessionIndex: number };
    /** Sign one session's rolling manifest with a DIFFERENT session's key. */
    signWithKeyOf?: { sessionIndex: number; keyOfSessionIndex: number };
    /** Replace one session's `manifest-<id>.json` with arbitrary text. */
    replaceJsonFor?: { sessionIndex: number; text: string };
    /** Override `assignment_id` in one session's rolling manifest. */
    assignmentIdFor?: { sessionIndex: number; assignmentId: string };
    /**
     * Override `extension_hash` in one session's rolling manifest.
     *
     * Not tampering: a student who updates their recorder mid-assignment
     * produces exactly this. Named alongside the tamper options because it
     * shares their "patch one session's manifest" plumbing.
     */
    extensionHashFor?: { sessionIndex: number; extensionHash: string };
  };
};

export type BuildBundleOpts = {
  assignmentId?: string;
  semester?: string;
  /**
   * Run git's end-of-line filter over the `.slog` bytes, the way a real
   * repository does.
   *
   * Deliberately NOT under `tamper`. Nothing here is tampering: git rewrites
   * these bytes on its own, under `core.autocrlf=true`, `core.eol=crlf`, or a
   * `.gitattributes` carrying `* text=auto eol=crlf` — and the git submission
   * path has no seal step to re-hash the result, so the analyzer receives the
   * rewritten file with the pre-rewrite digest still signed beside it. Filing it
   * under `tamper` would teach exactly the wrong thing about a shape that
   * belongs to honest students.
   *
   * The repo had NO CRLF `.slog` fixture at all, which is why a maximum-severity
   * false accusation on the flagship git path survived every suite. Both
   * directions are offered because both are reachable and only one of them is
   * recoverable — see `loader/line-endings.ts`.
   */
  gitLineEndings?: {
    /**
     * `archive_crlf` (default) — the recorder sealed over LF and the delivered
     * working tree carries CRLF. What a checkout under `eol=crlf` produces, and
     * the direction the loader can undo and prove benign.
     *
     * `seal_crlf` — the reverse: the rolling seal was taken over bytes git had
     * already widened (it re-reads the `.slog` from disk), and git's clean
     * filter then normalized the committed blob back to LF. NOT recoverable by
     * hashing, so this direction must still fail — and must still be described
     * without asserting that a benign cause is impossible.
     */
    direction?: 'archive_crlf' | 'seal_crlf';
    /** Session build indexes to affect. Defaults to every session. */
    sessionIndexes?: number[];
  };
  /**
   * Emit a rolling seal (program spec §8) rather than / as well as the classic
   * `manifest.json`. See {@link RollingSealSpec}.
   */
  rollingSeal?: RollingSealSpec;
  /**
   * Submission files to include (makes this a 1.1 bundle).
   * If undefined, the manifest is 1.0 and no submission_files are present.
   */
  submissionFiles?: SubmissionFileSpec[];
  sessions?: Array<{
    /** Defaults to a deterministic UUID based on session index. */
    sessionId?: string;
    /**
     * The uuid in the `.slog` FILENAME, when a test needs to control it.
     *
     * Defaults to a value that DIFFERS from `sessionId`, because that is what
     * production does — see {@link fakeLogFileUuid} for why the default is not
     * `sessionId`. Pass `fileUuid: sessionId` to opt back into the old
     * same-value shape, and say in the test why that is what it means to assert.
     */
    fileUuid?: string;
    /** Additional events after session.start; defaults to 5. */
    eventCount?: number;
    /** Optional explicit wall timestamps for events (starting from session.start). */
    walls?: string[];
    /** Override session.start.data.machine_id (host identity). Defaults to 'test-machine'. */
    machineId?: string;
    /** Override session.start.data.recorder.extension_id (recorder identity). Defaults to 'provenance.recorder'. */
    extensionId?: string;
    /**
     * Shallow-merged into `session.start.data` before the entry is chained.
     *
     * This is how a test builds a Manifest 2.0 bundle: set
     * `{ format_version: '2.0', manifest, manifest_sig: manifest.sig, host }`.
     * The merge happens BEFORE chaining, so the resulting bundle is chain- and
     * signature-consistent (unlike the `tamper.*` options, which patch after).
     */
    sessionStart?: Record<string, unknown>;
    /**
     * If true, append a doc.save event at the end whose sha256 matches the
     * in-memory content built by the doc.change events. Used for check 7 tests.
     */
    appendDocSave?: boolean;
    /**
     * Explicit events to append after session.start (instead of/in addition to
     * the generic doc.change sequence). When provided, `eventCount` is ignored
     * and `appendDocSave` is also ignored (include doc.save in the events array
     * if needed).
     *
     * Each EventSpec is chained into the session's hash chain in order.
     * Walls auto-increment from the session base unless overridden per-event.
     */
    events?: EventSpec[];
  }>;
  tamper?: {
    omitManifest?: boolean;
    omitSig?: boolean;
    omitAllSlogs?: boolean;
    /**
     * Omit one session's .slog.meta, keeping its .slog.
     *
     * No longer an error: the loader's read-side orphan guard DROPS the
     * unpairable log and reports it on `Bundle.droppedArtifacts`. Only a bundle
     * left with no analysable session at all still fails (`no_sessions`).
     */
    omitOneSlogMeta?: boolean;
    /**
     * Omit one session's .slog while keeping its .meta — the shape a
     * crash-recovery quarantine leaves in a git-submitted `.provenance/`.
     *
     * No longer an error: the loader drops the stranded sidecar (and that
     * session's rolling seal) and reports both. See
     * `loader/orphan-guard-git-path.test.ts`.
     */
    omitOneSlog?: boolean;
    addStrayFile?: { name: string; content: string };
    corruptNdjsonAtLine?: { sessionIndex: number; line: number };
    /**
     * Mutate the hash field of one or more entries (by 0-based entryIndex
     * within the session) to break the hash chain at those points.
     * Accepts a single object or an array for multiple mutations.
     */
    breakChainAt?:
      | { sessionIndex: number; entryIndex: number }
      | Array<{ sessionIndex: number; entryIndex: number }>;
    /**
     * Drop one or more entries from a session's event stream by their 0-based
     * afterEntryIndex, creating seq gaps at the following entries.
     * Accepts a single object or an array for multiple mutations.
     */
    addSeqGap?:
      | { sessionIndex: number; afterEntryIndex: number }
      | Array<{ sessionIndex: number; afterEntryIndex: number }>;
    /**
     * Subtract deltaMs from the `t` field of one or more entries to make them
     * regress. The entry still needs to be valid JSON (we patch post-chain-build).
     * Accepts a single object or an array for multiple mutations.
     */
    regressT?:
      | { sessionIndex: number; entryIndex: number; deltaMs: number }
      | Array<{ sessionIndex: number; entryIndex: number; deltaMs: number }>;
    /**
     * Replace the wall timestamp of one or more entries with an earlier wall to
     * make them regress (no clock.skew in the stream, so this should fail check 6).
     * Accepts a single object or an array for multiple mutations.
     */
    regressWall?:
      | { sessionIndex: number; entryIndex: number; earlierWall: string }
      | Array<{ sessionIndex: number; entryIndex: number; earlierWall: string }>;
    /**
     * Override the manifest_sig field in one session's session.start.data to
     * make it disagree with the other sessions (fails check 2).
     */
    mismatchManifestSig?: { sessionIndex: number; manifest_sig: string };
    /**
     * Replace the sha256 field on a doc.save entry (by 0-based entryIndex
     * within the session) to make the doc-save hash check fail.
     */
    mismatchDocSaveHash?: { sessionIndex: number; saveEntryIndex: number; newHash: string };
  };
};

export type BuiltBundle = {
  blob: Blob;
  /** Raw ArrayBuffer of the ZIP — use this when blob.arrayBuffer() is unavailable. */
  zipBuffer: ArrayBuffer;
  manifest: BundleManifest;
  /** Hex-encoded ed25519 private key used to sign the manifest. */
  sessionPrivkeyHex: string;
  /**
   * LOGICAL session ids in build order (index 0 = first session spec) —
   * `session.start.data.session_id`. This is what a rolling seal is named after
   * (`manifest-<session_id>.json`), what the manifest's `sessions[].session_id`
   * carries, and what per-session check details quote.
   *
   * It is NOT what the `.slog` file is called. See {@link BuiltBundle.logFileIds}.
   */
  sessionIds: string[];
  /**
   * The `.slog` FILENAME uuids in build order — what `session-<uuid>.slog` and
   * `session-<uuid>.slog.meta` are actually named in the ZIP.
   *
   * Deliberately DIFFERENT from {@link BuiltBundle.sessionIds} unless a spec
   * pins `fileUuid`, because that is what production does. A test that wants to
   * reach into the ZIP for a session's log must index this, not `sessionIds` —
   * the two used to be the same value, which is why crossing them went
   * undetected all the way into a false accusation against real students.
   */
  logFileIds: string[];
  /**
   * The per-session rolling manifests actually emitted, keyed by session id.
   * Empty unless `rollingSeal` was requested.
   */
  rollingManifests: Map<string, BundleManifest>;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID-shaped string for a given index. */
function fakeUuid(index: number): string {
  const hex = index.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
}

/**
 * The uuid in a session's `.slog` FILENAME — deliberately DIFFERENT from the
 * logical `session.start.data.session_id` that {@link fakeUuid} produces.
 *
 * ## The fixture rule this encodes
 *
 * In production these are two independently minted uuids: the writer names the
 * file `session-${randomUUID()}.slog` (`session-registry.ts`) while the logical
 * id is `recorderContext.session_id`. Every fixture in this repo used to spell
 * both with the same value, so a bundle in which they were CONFUSED was
 * indistinguishable from one in which they were handled correctly — and a
 * fixture that cannot distinguish two ids cannot fail on crossing them.
 *
 * It cost a maximum-severity false accusation to learn that: `parse-bundle.ts`
 * keyed its rolling-seal → files map by the filename uuid and looked it up by
 * the logical id, so prefix coverage came out empty for every git submission and
 * `log_bytes_match` accused every honest student whose last seal was non-final.
 * Not one test noticed, because in every fixture the lookup hit.
 *
 * So the default DIFFERS. A test that genuinely needs them equal must say so
 * with `fileUuid: <the same value>`, which is a visible, reviewable claim.
 */
function fakeLogFileUuid(index: number): string {
  const hex = index.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-f11e00000000`;
}

/**
 * git's smudge filter, exactly: widen every LF to CRLF, idempotently.
 *
 * The first replace collapses any CRLF already present so the second cannot
 * produce `\r\r\n` — which is what a naive `\n` → `\r\n` does when run over
 * text that is already widened, and is not a state git ever produces.
 */
function toCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/** ISO timestamp offset from a base epoch for deterministic walls. */
function wallAt(sessionIndex: number, eventIndex: number): string {
  // Base: 2026-01-01T00:00:00.000Z plus (session * 1 hour) + (event * 10 seconds)
  const baseMs = 1767225600000; // 2026-01-01T00:00:00.000Z
  const ms = baseMs + sessionIndex * 3_600_000 + eventIndex * 10_000;
  return new Date(ms).toISOString();
}

/**
 * Build a self-consistent slog (NDJSON text) and meta (JSON text) for one session.
 */
async function buildSession(opts: {
  sessionId: string;
  sessionIndex: number;
  pubkeyHex: string;
  eventCount: number;
  walls?: string[];
  assignmentId: string;
  semester: string;
  appendDocSave?: boolean;
  events?: EventSpec[];
  machineId?: string;
  extensionId?: string;
  sessionStart?: Record<string, unknown>;
}): Promise<{ slogText: string; metaJson: string }> {
  const {
    sessionId,
    sessionIndex,
    pubkeyHex,
    eventCount,
    walls,
    assignmentId,
    semester,
    appendDocSave,
    events: explicitEvents,
    machineId,
    extensionId,
    sessionStart,
  } = opts;

  const lines: string[] = [];
  let prevHash = GENESIS_PREV_HASH;

  // session.start (seq 0)
  const startEnvelope = {
    seq: 0,
    t: 0,
    wall: walls?.[0] ?? wallAt(sessionIndex, 0),
    kind: 'session.start' as const,
    data: {
      format_version: '1.0',
      session_id: sessionId,
      prev_session_id: null as string | null,
      assignment: { id: assignmentId, semester },
      manifest_sig: 'placeholder-sig',
      machine_id: machineId ?? 'test-machine',
      vscode: { version: '1.90.0', commit: '', platform: 'darwin' },
      recorder: { version: '0.0.1', extension_id: extensionId ?? 'provenance.recorder' },
      session_pubkey: pubkeyHex,
      ...(sessionStart ?? {}),
    },
  };

  const startEntry = chainEntry(prevHash, startEnvelope);
  lines.push(serializeEntry(startEntry).trimEnd());
  prevHash = startEntry.hash;

  if (explicitEvents !== undefined) {
    // ---------------------------------------------------------------------------
    // Explicit event list — used by Phase 3+ tests that need specific event kinds
    // and payloads (paste, doc.save, fs.external_change, etc.).
    // ---------------------------------------------------------------------------
    for (let i = 0; i < explicitEvents.length; i++) {
      const spec = explicitEvents[i]!;
      const seq = i + 1;
      const envelope = {
        seq,
        t: spec.t ?? seq * 1000,
        wall: spec.wall ?? wallAt(sessionIndex, seq),
        kind: spec.kind,
        data: spec.data,
      };
      // chainEntry is typed as accepting a specific Envelope<K>; we cast here
      // because EventSpec is intentionally loose (supports any kind string).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entry = chainEntry(prevHash, envelope as any);
      lines.push(serializeEntry(entry).trimEnd());
      prevHash = entry.hash;
    }
  } else {
    // ---------------------------------------------------------------------------
    // Legacy synthetic doc.change events (original behaviour, unchanged).
    // ---------------------------------------------------------------------------

    // Additional synthetic doc.change events
    // Track content for doc.save hash computation.
    let fileContent = '';
    for (let i = 1; i <= eventCount; i++) {
      const insertText = `x${i}`;
      // All inserts go at position (0,0) with no deletion — they accumulate.
      fileContent = insertText + fileContent;

      const changeEnvelope = {
        seq: i,
        t: i * 1000,
        wall: walls?.[i] ?? wallAt(sessionIndex, i),
        kind: 'doc.change' as const,
        data: {
          path: '/test/file.py',
          deltas: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              text: insertText,
            },
          ],
          source: 'typed' as const,
        },
      };

      const entry = chainEntry(prevHash, changeEnvelope);
      lines.push(serializeEntry(entry).trimEnd());
      prevHash = entry.hash;
    }

    // Optionally append a doc.save whose sha256 matches the in-memory content.
    if (appendDocSave === true) {
      const saveSeq = eventCount + 1;
      const saveHash = sha256Hex(fileContent);
      const saveEnvelope = {
        seq: saveSeq,
        t: saveSeq * 1000,
        wall: walls?.[saveSeq] ?? wallAt(sessionIndex, saveSeq),
        kind: 'doc.save' as const,
        data: {
          path: '/test/file.py',
          sha256: saveHash,
        },
      };
      const saveEntry = chainEntry(prevHash, saveEnvelope);
      lines.push(serializeEntry(saveEntry).trimEnd());
      prevHash = saveEntry.hash;
    }
  }

  const slogText = lines.join('\n') + '\n';

  // .slog.meta
  const meta: SlogMeta = {
    format_version: '1.0',
    session_id: sessionId,
    session_pubkey: pubkeyHex,
    encrypted_session_privkey: {
      algorithm: 'xchacha20-poly1305-hkdf-sha256-v1',
      nonce: 'ab'.repeat(12), // 24 hex chars = 12 bytes
      ciphertext: 'cd'.repeat(48), // 96 hex chars = placeholder ciphertext
      salt: 'ef'.repeat(16), // 32 hex chars = 16 bytes
      info: 'provenance-session-v1',
    },
    checkpoints: [],
  };

  const metaJson = JSON.stringify(meta);
  return { slogText, metaJson };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildTestBundle(opts?: BuildBundleOpts): Promise<BuiltBundle> {
  const assignmentId = opts?.assignmentId ?? 'hw1';
  const semester = opts?.semester ?? 'sp26';
  const sessionSpecs = opts?.sessions ?? [{}];
  const tamper = opts?.tamper ?? {};

  const rollingSpec = opts?.rollingSeal;

  // Generate one keypair shared across sessions (manifest sig is all that matters here).
  const privkey = ed.utils.randomSecretKey();
  const pubkey = await ed.getPublicKeyAsync(privkey);
  const pubkeyHex = bytesToHex(pubkey);
  const sessionPrivkeyHex = bytesToHex(privkey);

  // A ROLLING-sealed bundle gets one keypair PER SESSION, because that is the
  // real thing: each session signs its own manifest with its own ephemeral key,
  // and in a shared 61B repo a partner's sessions carry a partner's keys. A
  // classic bundle keeps the single shared keypair above, unchanged.
  const perSessionKeys: Array<{ privkey: Uint8Array; pubkeyHex: string }> = [];
  if (rollingSpec !== undefined) {
    for (let i = 0; i < sessionSpecs.length; i++) {
      const sk = ed.utils.randomSecretKey();
      perSessionKeys.push({ privkey: sk, pubkeyHex: bytesToHex(await ed.getPublicKeyAsync(sk)) });
    }
  }

  // ---------------------------------------------------------------------------
  // 1. Build each session's slog + meta.
  // ---------------------------------------------------------------------------
  type SessionData = {
    /** Logical id: `session.start.data.session_id`. */
    sessionId: string;
    /** The uuid in the `.slog` FILENAME. Different from `sessionId` by default. */
    fileUuid: string;
    slogText: string;
    metaJson: string;
    slogSha256: string;
    metaSha256: string;
    /** Write this session's `.slog` into the ZIP with CRLF terminators. */
    archiveAsCrlf: boolean;
  };

  const sessions: SessionData[] = [];
  for (let i = 0; i < sessionSpecs.length; i++) {
    const spec = sessionSpecs[i]!;
    const sessionId = spec.sessionId ?? fakeUuid(i);
    const fileUuid = spec.fileUuid ?? fakeLogFileUuid(i);
    const eventCount = spec.eventCount ?? 5;
    const walls = spec.walls;

    const { slogText, metaJson } = await buildSession({
      sessionId,
      sessionIndex: i,
      pubkeyHex: perSessionKeys[i]?.pubkeyHex ?? pubkeyHex,
      eventCount,
      ...(walls !== undefined ? { walls } : {}),
      assignmentId,
      semester,
      ...(spec.appendDocSave !== undefined ? { appendDocSave: spec.appendDocSave } : {}),
      ...(spec.events !== undefined ? { events: spec.events } : {}),
      ...(spec.machineId !== undefined ? { machineId: spec.machineId } : {}),
      ...(spec.extensionId !== undefined ? { extensionId: spec.extensionId } : {}),
      ...(spec.sessionStart !== undefined ? { sessionStart: spec.sessionStart } : {}),
    });

    sessions.push({
      sessionId,
      fileUuid,
      slogText,
      metaJson,
      slogSha256: sha256Hex(slogText),
      metaSha256: sha256Hex(metaJson),
      archiveAsCrlf: false,
    });
  }

  // ---------------------------------------------------------------------------
  // 1b. Apply git's end-of-line filter.
  //
  // Ordering matters and mirrors reality. `archive_crlf` leaves the digests over
  // the LF bytes the recorder actually wrote and widens only what goes into the
  // archive, because that is what a checkout does to an already-sealed log.
  // `seal_crlf` moves the DIGEST onto the widened bytes and archives the narrow
  // ones, because there the recorder re-read a smudged working-tree file and
  // git's clean filter then normalized the commit back.
  // ---------------------------------------------------------------------------
  if (opts?.gitLineEndings !== undefined) {
    const direction = opts.gitLineEndings.direction ?? 'archive_crlf';
    const targets = opts.gitLineEndings.sessionIndexes ?? sessions.map((_, i) => i);
    for (const i of targets) {
      const session = sessions[i];
      if (session === undefined) continue;
      if (direction === 'archive_crlf') {
        session.archiveAsCrlf = true;
      } else {
        session.slogSha256 = sha256Hex(toCrlf(session.slogText));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Apply corruptNdjsonAtLine tamper (before manifest sha256 computation).
  // ---------------------------------------------------------------------------
  if (tamper.corruptNdjsonAtLine !== undefined) {
    const { sessionIndex, line } = tamper.corruptNdjsonAtLine;
    const session = sessions[sessionIndex];
    if (session !== undefined) {
      const slogLines = session.slogText.split('\n');
      const targetLine = line - 1; // 0-indexed
      if (slogLines[targetLine] !== undefined) {
        slogLines[targetLine] = 'NOT VALID JSON {{{';
      }
      session.slogText = slogLines.join('\n');
    }
  }

  // ---------------------------------------------------------------------------
  // 2b. Apply new validation-pipeline tamper options (post-chain, pre-manifest).
  // These mutations corrupt specific fields in the NDJSON by finding and
  // replacing the JSON line for the targeted entry.
  // ---------------------------------------------------------------------------

  /** Parse all entries in an NDJSON slog, return as an array of parsed objects. */
  function parseSlogLines(slogText: string): Array<Record<string, unknown>> {
    return slogText
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  /** Serialize an array of parsed objects back to NDJSON. */
  function serializeSlogLines(entries: Array<Record<string, unknown>>): string {
    return entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  // breakChainAt: mutate entry.hash to a wrong value.
  if (tamper.breakChainAt !== undefined) {
    const mutations = Array.isArray(tamper.breakChainAt)
      ? tamper.breakChainAt
      : [tamper.breakChainAt];
    for (const { sessionIndex, entryIndex } of mutations) {
      const session = sessions[sessionIndex];
      if (session !== undefined) {
        const entries = parseSlogLines(session.slogText);
        const entry = entries[entryIndex];
        if (entry !== undefined) {
          entry['hash'] = 'dead'.repeat(16); // 64 hex chars, wrong value
        }
        session.slogText = serializeSlogLines(entries);
      }
    }
  }

  // addSeqGap: drop the entry AFTER afterEntryIndex to create a gap.
  // When applying multiple gaps, sort by afterEntryIndex descending so that
  // earlier drops don't shift the indices for later ones.
  if (tamper.addSeqGap !== undefined) {
    const mutations = (Array.isArray(tamper.addSeqGap) ? tamper.addSeqGap : [tamper.addSeqGap])
      .slice()
      .sort((a, b) => b.afterEntryIndex - a.afterEntryIndex);
    for (const { sessionIndex, afterEntryIndex } of mutations) {
      const session = sessions[sessionIndex];
      if (session !== undefined) {
        const entries = parseSlogLines(session.slogText);
        // Drop the entry at afterEntryIndex + 1
        const dropIndex = afterEntryIndex + 1;
        if (dropIndex < entries.length) {
          entries.splice(dropIndex, 1);
        }
        session.slogText = serializeSlogLines(entries);
      }
    }
  }

  // regressT: subtract deltaMs from entry.t.
  if (tamper.regressT !== undefined) {
    const mutations = Array.isArray(tamper.regressT) ? tamper.regressT : [tamper.regressT];
    for (const { sessionIndex, entryIndex, deltaMs } of mutations) {
      const session = sessions[sessionIndex];
      if (session !== undefined) {
        const entries = parseSlogLines(session.slogText);
        const entry = entries[entryIndex];
        if (entry !== undefined && typeof entry['t'] === 'number') {
          entry['t'] = entry['t'] - deltaMs;
          // Recomputing the hash would re-validate the chain, which is not what
          // we want — we want the chain validator to catch the t regression
          // separately from hash integrity. So leave hash as-is (the hash check
          // catches this entry's hash too, but the test must pick a chain-valid
          // entry for regressT to have the t_regression fail in isolation).
          // NOTE: tests using regressT should set the entry's hash to the
          // recomputed value if they only want t_regression, not hash_mismatch.
          // For simplicity we leave the hash stale — tests check for either.
        }
        session.slogText = serializeSlogLines(entries);
      }
    }
  }

  // regressWall: replace entry.wall with an earlier timestamp.
  if (tamper.regressWall !== undefined) {
    const mutations = Array.isArray(tamper.regressWall) ? tamper.regressWall : [tamper.regressWall];
    for (const { sessionIndex, entryIndex, earlierWall } of mutations) {
      const session = sessions[sessionIndex];
      if (session !== undefined) {
        const entries = parseSlogLines(session.slogText);
        const entry = entries[entryIndex];
        if (entry !== undefined) {
          entry['wall'] = earlierWall;
          // Leave hash stale — same rationale as regressT.
        }
        session.slogText = serializeSlogLines(entries);
      }
    }
  }

  // mismatchManifestSig: replace session.start.data.manifest_sig.
  if (tamper.mismatchManifestSig !== undefined) {
    const { sessionIndex, manifest_sig } = tamper.mismatchManifestSig;
    const session = sessions[sessionIndex];
    if (session !== undefined) {
      const entries = parseSlogLines(session.slogText);
      const startEntry = entries[0];
      if (startEntry !== undefined) {
        const data = startEntry['data'] as Record<string, unknown> | undefined;
        if (data !== undefined) {
          data['manifest_sig'] = manifest_sig;
        }
      }
      session.slogText = serializeSlogLines(entries);
    }
  }

  // mismatchDocSaveHash: replace the sha256 on the Nth doc.save entry.
  if (tamper.mismatchDocSaveHash !== undefined) {
    const { sessionIndex, saveEntryIndex, newHash } = tamper.mismatchDocSaveHash;
    const session = sessions[sessionIndex];
    if (session !== undefined) {
      const entries = parseSlogLines(session.slogText);
      let saveCount = 0;
      for (const entry of entries) {
        if (entry['kind'] === 'doc.save') {
          if (saveCount === saveEntryIndex) {
            const data = entry['data'] as Record<string, unknown> | undefined;
            if (data !== undefined) {
              data['sha256'] = newHash;
            }
            break;
          }
          saveCount++;
        }
      }
      session.slogText = serializeSlogLines(entries);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Build BundleManifest.
  //
  // If submissionFiles are specified, produce a 1.1 manifest with
  // submission_files. Otherwise produce a legacy 1.0 manifest.
  // ---------------------------------------------------------------------------
  const submissionFileSpecs = opts?.submissionFiles;

  // Build the submission_files manifest entries (1.1 only).
  type SubmissionEntry = { path: string; status: 'present' | 'missing'; sha256: string | null };
  const submissionEntries: SubmissionEntry[] = [];
  if (submissionFileSpecs !== undefined) {
    for (const spec of submissionFileSpecs) {
      if (spec.status === 'missing') {
        submissionEntries.push({ path: spec.path, status: 'missing', sha256: null });
      } else {
        // Compute sha256 from content, or use the override.
        const content = spec.content ?? '';
        const computedSha = sha256Hex(new TextEncoder().encode(content));
        const manifestSha = spec.manifestSha256Override ?? computedSha;
        submissionEntries.push({ path: spec.path, status: 'present', sha256: manifestSha });
      }
    }
  }

  // The digest the CLASSIC manifest commits to for session `i`. Normally the
  // finished log's, exactly as before. With `staleClassicAfterEntries` it is the
  // digest of a PREFIX — the log as it stood when the classic seal was taken,
  // after which the session went on recording. See `staleClassicAfterEntries`.
  const stale = rollingSpec?.staleClassicAfterEntries;
  const classicSlogShaFor = (i: number): string => {
    const s = sessions[i]!;
    if (stale === undefined || stale.sessionIndex !== i) return s.slogSha256;
    const entries = s.slogText.split('\n').filter((l) => l !== '');
    return sha256Hex(entries.slice(0, stale.entries).join('\n') + '\n');
  };

  const manifest: BundleManifest =
    submissionFileSpecs !== undefined
      ? {
          format_version: '1.1',
          assignment_id: assignmentId,
          semester,
          extension_hash: 'a'.repeat(64),
          sessions: sessions.map((s, i) => ({
            session_id: s.sessionId,
            prev_session_id: null,
            slog_sha256: classicSlogShaFor(i),
            meta_sha256: s.metaSha256,
          })),
          submission_files: submissionEntries,
        }
      : {
          format_version: '1.0',
          assignment_id: assignmentId,
          semester,
          extension_hash: 'a'.repeat(64),
          sessions: sessions.map((s, i) => ({
            session_id: s.sessionId,
            prev_session_id: null,
            slog_sha256: classicSlogShaFor(i),
            meta_sha256: s.metaSha256,
          })),
        };

  // ---------------------------------------------------------------------------
  // 4. Sign manifest.
  //
  // A rolling bundle's sessions have their own keys, so the shared `privkey`
  // would match nothing. Sign the classic manifest with the LAST session's key,
  // which is what the real seal command does (the active session signs).
  // ---------------------------------------------------------------------------
  const classicSigningKey =
    perSessionKeys.length > 0 ? perSessionKeys[perSessionKeys.length - 1]!.privkey : privkey;
  const canonicalManifest = canonicalize(manifest);
  const canonicalBytes = new TextEncoder().encode(canonicalManifest);
  const sigBytes = await ed.signAsync(canonicalBytes, classicSigningKey);
  const sigHex = bytesToHex(sigBytes);

  // ---------------------------------------------------------------------------
  // 4b. Build + sign the per-session ROLLING manifests (program spec §8).
  //
  // Each one covers exactly its own session and is signed by that session's own
  // key. The tamper options deliberately produce the adversarial shapes the
  // reader has to refuse.
  // ---------------------------------------------------------------------------
  const rollingManifests = new Map<string, BundleManifest>();
  /** filename → text, applied to the zip below. */
  const rollingFiles = new Map<string, string>();

  if (rollingSpec !== undefined) {
    const rTamper = rollingSpec.tamper ?? {};
    // See RollingSealSpec.final: the digests below are taken over the FINISHED
    // logs, which only a dispose()-time seal can honestly commit to.
    const sealIsFinal = rollingSpec.final !== false;

    /** Build session i's own rolling manifest. */
    const rollingManifestFor = (i: number): BundleManifest => {
      const s = sessions[i]!;
      return {
        format_version: '1.2',
        assignment_id:
          rTamper.assignmentIdFor?.sessionIndex === i
            ? rTamper.assignmentIdFor.assignmentId
            : assignmentId,
        semester,
        extension_hash:
          rTamper.extensionHashFor?.sessionIndex === i
            ? rTamper.extensionHashFor.extensionHash
            : 'a'.repeat(64),
        sessions: [
          {
            session_id: s.sessionId,
            prev_session_id: null,
            slog_sha256: s.slogSha256,
            meta_sha256: s.metaSha256,
          },
        ],
        submission_files: submissionEntries,
        // Omitted, never written as `final: false` — a non-final rolling
        // manifest must stay byte-identical to what 1.2 emitted before this
        // field existed.
        ...(sealIsFinal ? { final: true } : {}),
      };
    };

    for (let i = 0; i < sessions.length; i++) {
      if (rTamper.omitSealFor?.includes(i) === true) continue;

      const sessionId = sessions[i]!.sessionId;
      const names = rollingManifestFilenames(sessionId);

      // A sideways copy: another session's manifest content under THIS session's
      // filenames, signed with THIS session's own key. The signature is valid, so
      // only the filename ↔ session_id binding can catch it.
      const contentIndex =
        rTamper.sidewaysCopyFor?.sessionIndex === i
          ? rTamper.sidewaysCopyFor.manifestOfSessionIndex
          : i;
      const rolling = rollingManifestFor(contentIndex);
      rollingManifests.set(sessionId, rolling);

      const canonicalRolling = canonicalize(rolling);
      const signingIndex =
        rTamper.signWithKeyOf?.sessionIndex === i ? rTamper.signWithKeyOf.keyOfSessionIndex : i;
      const rollingSigHex = bytesToHex(
        await ed.signAsync(
          new TextEncoder().encode(canonicalRolling),
          perSessionKeys[signingIndex]!.privkey,
        ),
      );

      if (rTamper.omitJsonFor?.includes(i) !== true) {
        rollingFiles.set(
          names.json,
          rTamper.replaceJsonFor?.sessionIndex === i
            ? rTamper.replaceJsonFor.text
            : canonicalRolling,
        );
      }
      if (rTamper.omitSigFor?.includes(i) !== true) {
        rollingFiles.set(names.sig, rollingSigHex);
      }
    }

    // A seal naming a session that has no .slog in this bundle.
    if (rTamper.extraSealForSessionId !== undefined) {
      const ghostId = rTamper.extraSealForSessionId;
      const base = rollingManifestFor(0);
      const ghost: BundleManifest = {
        ...base,
        sessions: [{ ...base.sessions[0]!, session_id: ghostId }],
      };
      const names = rollingManifestFilenames(ghostId);
      const canonicalGhost = canonicalize(ghost);
      rollingFiles.set(names.json, canonicalGhost);
      rollingFiles.set(
        names.sig,
        bytesToHex(
          await ed.signAsync(new TextEncoder().encode(canonicalGhost), perSessionKeys[0]!.privkey),
        ),
      );
      rollingManifests.set(ghostId, ghost);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Build ZIP, applying tamper mutations.
  // ---------------------------------------------------------------------------
  const zip = new JSZip();

  // A rolling-sealed bundle has no classic manifest at all unless the test asks
  // for the both-shapes case.
  const emitClassic = rollingSpec === undefined || rollingSpec.alsoClassic === true;

  if (emitClassic && !tamper.omitManifest) {
    zip.file('manifest.json', canonicalManifest);
  }
  if (emitClassic && !tamper.omitSig) {
    zip.file('manifest.sig', sigHex);
  }
  for (const [name, text] of rollingFiles) {
    zip.file(name, text);
  }

  if (!tamper.omitAllSlogs) {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      // The FILENAME uuid, never the logical session id. See fakeLogFileUuid.
      const slogName = `session-${s.fileUuid}.slog`;
      const metaName = `session-${s.fileUuid}.slog.meta`;

      const isLastSession = i === sessions.length - 1;

      // omitOneSlogMeta: omit meta for the last session → an unpairable .slog,
      // which the loader's orphan guard drops and reports (it used to be fatal).
      const skipMeta = tamper.omitOneSlogMeta === true && isLastSession;
      // omitOneSlog: omit slog for the last session but keep its meta → a
      // stranded sidecar, dropped and reported (it used to be fatal).
      const skipSlog = tamper.omitOneSlog === true && isLastSession;

      if (!skipSlog) {
        zip.file(slogName, s.archiveAsCrlf ? toCrlf(s.slogText) : s.slogText);
      }
      if (!skipMeta) {
        zip.file(metaName, s.metaJson);
      }
    }
  }

  if (tamper.addStrayFile !== undefined) {
    zip.file(tamper.addStrayFile.name, tamper.addStrayFile.content);
  }

  // Add submission file bytes at the zip root (1.1 bundles only).
  if (submissionFileSpecs !== undefined) {
    for (const spec of submissionFileSpecs) {
      if (spec.status === 'present' && spec.content !== undefined) {
        zip.file(spec.path, spec.content);
      }
    }
  }

  const zipBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  const blob = new Blob([zipBuffer], { type: 'application/zip' });

  return {
    blob,
    zipBuffer,
    manifest,
    sessionPrivkeyHex,
    sessionIds: sessions.map((s) => s.sessionId),
    logFileIds: sessions.map((s) => s.fileUuid),
    rollingManifests,
  };
}
