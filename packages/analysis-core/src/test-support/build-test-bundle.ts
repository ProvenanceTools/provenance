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

export type BuildBundleOpts = {
  assignmentId?: string;
  semester?: string;
  /**
   * Submission files to include (makes this a 1.1 bundle).
   * If undefined, the manifest is 1.0 and no submission_files are present.
   */
  submissionFiles?: SubmissionFileSpec[];
  sessions?: Array<{
    /** Defaults to a deterministic UUID based on session index. */
    sessionId?: string;
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
    /** Omit one session's .slog.meta — produces orphaned_slog error. */
    omitOneSlogMeta?: boolean;
    /** Omit one session's .slog (while keeping its .meta) — produces orphaned_meta error. */
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
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID-shaped string for a given index. */
function fakeUuid(index: number): string {
  const hex = index.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
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

  // Generate one keypair shared across sessions (manifest sig is all that matters here).
  const privkey = ed.utils.randomSecretKey();
  const pubkey = await ed.getPublicKeyAsync(privkey);
  const pubkeyHex = bytesToHex(pubkey);
  const sessionPrivkeyHex = bytesToHex(privkey);

  // ---------------------------------------------------------------------------
  // 1. Build each session's slog + meta.
  // ---------------------------------------------------------------------------
  type SessionData = {
    sessionId: string;
    slogText: string;
    metaJson: string;
    slogSha256: string;
    metaSha256: string;
  };

  const sessions: SessionData[] = [];
  for (let i = 0; i < sessionSpecs.length; i++) {
    const spec = sessionSpecs[i]!;
    const sessionId = spec.sessionId ?? fakeUuid(i);
    const eventCount = spec.eventCount ?? 5;
    const walls = spec.walls;

    const { slogText, metaJson } = await buildSession({
      sessionId,
      sessionIndex: i,
      pubkeyHex,
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
      slogText,
      metaJson,
      slogSha256: sha256Hex(slogText),
      metaSha256: sha256Hex(metaJson),
    });
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

  const manifest: BundleManifest =
    submissionFileSpecs !== undefined
      ? {
          format_version: '1.1',
          assignment_id: assignmentId,
          semester,
          extension_hash: 'a'.repeat(64),
          sessions: sessions.map((s) => ({
            session_id: s.sessionId,
            prev_session_id: null,
            slog_sha256: s.slogSha256,
            meta_sha256: s.metaSha256,
          })),
          submission_files: submissionEntries,
        }
      : {
          format_version: '1.0',
          assignment_id: assignmentId,
          semester,
          extension_hash: 'a'.repeat(64),
          sessions: sessions.map((s) => ({
            session_id: s.sessionId,
            prev_session_id: null,
            slog_sha256: s.slogSha256,
            meta_sha256: s.metaSha256,
          })),
        };

  // ---------------------------------------------------------------------------
  // 4. Sign manifest.
  // ---------------------------------------------------------------------------
  const canonicalManifest = canonicalize(manifest);
  const canonicalBytes = new TextEncoder().encode(canonicalManifest);
  const sigBytes = await ed.signAsync(canonicalBytes, privkey);
  const sigHex = bytesToHex(sigBytes);

  // ---------------------------------------------------------------------------
  // 5. Build ZIP, applying tamper mutations.
  // ---------------------------------------------------------------------------
  const zip = new JSZip();

  if (!tamper.omitManifest) {
    zip.file('manifest.json', canonicalManifest);
  }
  if (!tamper.omitSig) {
    zip.file('manifest.sig', sigHex);
  }

  if (!tamper.omitAllSlogs) {
    for (let i = 0; i < sessions.length; i++) {
      const s = sessions[i]!;
      const slogName = `session-${s.sessionId}.slog`;
      const metaName = `session-${s.sessionId}.slog.meta`;

      const isLastSession = i === sessions.length - 1;

      // omitOneSlogMeta: omit meta for the last session → orphaned_slog error.
      const skipMeta = tamper.omitOneSlogMeta === true && isLastSession;
      // omitOneSlog: omit slog for the last session but keep its meta → orphaned_meta error.
      const skipSlog = tamper.omitOneSlog === true && isLastSession;

      if (!skipSlog) {
        zip.file(slogName, s.slogText);
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

  return { blob, zipBuffer, manifest, sessionPrivkeyHex };
}
