/**
 * Unit tests for loadBundle.
 *
 * Builds real in-memory ZIPs via buildTestBundle and verifies the Bundle shape
 * returned by loadBundle. A fixed clock is injected so loadedAt is deterministic.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { sha256Hex } from '@provenance/log-core';
import { loadBundle } from './parse-bundle.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';

// Fixed ISO timestamp injected for all tests — keeps loadedAt assertions stable.
const FIXED_NOW = '2026-01-01T12:00:00.000Z';
const fixedNow = () => FIXED_NOW;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadBundle', () => {
  it('returns ok with a single-session Bundle for a valid ZIP', async () => {
    const { blob, manifest } = await buildTestBundle({
      sessions: [{ eventCount: 3 }],
    });

    const result = await loadBundle(blob, 'hw1-bundle.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundle = result.value;
    expect(bundle.sessions).toHaveLength(1);
    expect(bundle.manifest.assignment_id).toBe(manifest.assignment_id);
    expect(bundle.manifest.semester).toBe(manifest.semester);
    expect(bundle.manifest.format_version).toBe('1.0');
    expect(typeof bundle.manifestSigHex).toBe('string');
    expect(bundle.manifestSigHex!.length).toBeGreaterThan(0);
  });

  it('sourceFilename is propagated to the Bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}] });
    const result = await loadBundle(blob, 'my-hw-bundle.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceFilename).toBe('my-hw-bundle.zip');
  });

  it('loadedAt is the value returned by nowFn', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}] });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.loadedAt).toBe(FIXED_NOW);
  });

  it('sessions are sorted oldest → newest by firstEvent.wall', async () => {
    // Build two sessions with explicit, reversed wall timestamps.
    // Session 0 wall: newer; Session 1 wall: older.
    // After sort, session 1 should come first.
    const olderWall = '2026-01-01T00:00:00.000Z';
    const newerWall = '2026-01-02T00:00:00.000Z';

    const { blob } = await buildTestBundle({
      sessions: [
        { eventCount: 1, walls: [newerWall, newerWall] },
        { eventCount: 1, walls: [olderWall, olderWall] },
      ],
    });

    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const sessions = result.value.sessions;
    expect(sessions).toHaveLength(2);
    // Oldest first — wall is on the envelope, not on data.
    expect(sessions[0]!.firstEvent.wall).toBe(olderWall);
    expect(sessions[1]!.firstEvent.wall).toBe(newerWall);
  });

  it('each ParsedSession has sessionId, events, meta, and firstEvent populated', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 2 }],
    });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const s = result.value.sessions[0]!;
    expect(typeof s.sessionId).toBe('string');
    expect(s.events.length).toBeGreaterThan(0);
    expect(s.firstEvent.kind).toBe('session.start');
    expect(s.meta.format_version).toBe('1.0');
  });

  it('propagates a parse-session error up from a corrupted slog', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{ eventCount: 3 }],
      tamper: { corruptNdjsonAtLine: { sessionIndex: 0, line: 2 } },
    });

    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('ndjson_parse_failed');
  });

  it('propagates a LoaderError (not_a_zip) for garbage input', async () => {
    const garbage = new Uint8Array([0, 1, 2, 3]);
    const result = await loadBundle(garbage.buffer as ArrayBuffer, 'bad.zip', fixedNow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_a_zip');
  });

  it('propagates a LoaderError (missing_manifest) from unzip', async () => {
    const { blob } = await buildTestBundle({ tamper: { omitManifest: true } });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing_manifest');
  });

  it('returns invalid_manifest with detail for invalid manifest JSON content', async () => {
    // Build a valid ZIP, then manually replace manifest.json with garbage JSON.
    // Use zipBuffer directly — jsdom's Blob may not expose .arrayBuffer().
    const { zipBuffer } = await buildTestBundle({ sessions: [{}] });
    const zip = await JSZip.loadAsync(zipBuffer);
    zip.file('manifest.json', 'NOT JSON AT ALL');
    const newAb = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await loadBundle(newAb, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_manifest');
    if (result.error.kind !== 'invalid_manifest') return;
    expect(result.error.detail).toMatch(/manifest\.json/);
  });

  it('returns invalid_manifest for parseable manifest JSON that fails shape validation', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{}] });
    const zip = await JSZip.loadAsync(zipBuffer);
    zip.file('manifest.json', JSON.stringify({ wrong: 'shape' }));
    const newAb = await zip.generateAsync({ type: 'arraybuffer' });

    const result = await loadBundle(newAb, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_manifest');
    if (result.error.kind !== 'invalid_manifest') return;
    expect(result.error.detail).toMatch(/manifest\.json shape invalid/);
  });

  // ---------------------------------------------------------------------------
  // Task C2 — submission files + self-check (1.1 bundles)
  // ---------------------------------------------------------------------------

  it('exposes an empty submissionFiles map for a 1.0 bundle (back-compat)', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}] });
    const result = await loadBundle(blob, 'hw1.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.submissionFiles.size).toBe(0);
    expect(result.value.manifest.format_version).toBe('1.0');
  });

  it('populates submissionFiles for a 1.1 bundle with a present file', async () => {
    const content = 'print("hello")\n';
    const { blob } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [{ path: 'hw03.py', status: 'present', content }],
    });

    const result = await loadBundle(blob, 'hw1-11.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundle = result.value;
    expect(bundle.manifest.format_version).toBe('1.1');
    expect(bundle.submissionFiles.size).toBe(1);

    const f = bundle.submissionFiles.get('hw03.py');
    expect(f).toBeDefined();
    expect(f!.status).toBe('present');
    expect(f!.hashOk).toBe(true);
    expect(new TextDecoder().decode(f!.bytes!)).toBe(content);
  });

  it('populates submissionFiles for a 1.1 bundle with a missing file', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [{ path: 'missing.py', status: 'missing' }],
    });

    const result = await loadBundle(blob, 'hw1-11.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const f = result.value.submissionFiles.get('missing.py');
    expect(f).toBeDefined();
    expect(f!.status).toBe('missing');
    expect(f!.sha256).toBeNull();
    expect(f!.hashOk).toBe(true);
    expect(f!.bytes).toBeUndefined();
  });

  it('flags hashOk=false when bundle bytes do not match the manifest sha256', async () => {
    // Build a 1.1 bundle with a submission file, then corrupt the manifest sha256
    // by overriding it to a wrong value while keeping the real bytes in the zip.
    const content = 'print("correct")\n';
    const wrongSha = 'f'.repeat(64); // clearly wrong sha256

    const { blob } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [
        {
          path: 'bad.py',
          status: 'present',
          content,
          manifestSha256Override: wrongSha,
        },
      ],
    });

    const result = await loadBundle(blob, 'hw1-bad.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const f = result.value.submissionFiles.get('bad.py');
    expect(f).toBeDefined();
    expect(f!.hashOk).toBe(false);
  });

  it('flags hashOk=false when a present file is listed in the manifest but absent from the zip', async () => {
    // A 'present' spec with no content is recorded in submission_files but its bytes
    // are NOT added to the zip — the self-check must report hashOk=false without crashing.
    const { blob } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [{ path: 'ghost.py', status: 'present' }],
    });

    const result = await loadBundle(blob, 'hw1-ghost.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const f = result.value.submissionFiles.get('ghost.py');
    expect(f).toBeDefined();
    expect(f!.status).toBe('present');
    expect(f!.bytes).toBeUndefined();
    expect(f!.hashOk).toBe(false);
  });

  it('flags hashOk=true for a present file with correct sha256 (self-check passes)', async () => {
    const content = 'x = 42\n';
    const correctSha = sha256Hex(new TextEncoder().encode(content));

    const { blob } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [
        {
          path: 'good.py',
          status: 'present',
          content,
          // No override → helper computes sha from content, should match
        },
      ],
    });

    const result = await loadBundle(blob, 'hw1-good.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const f = result.value.submissionFiles.get('good.py');
    expect(f).toBeDefined();
    expect(f!.hashOk).toBe(true);
    expect(f!.sha256).toBe(correctSha);
  });

  it('handles a 1.1 bundle with both a present and a missing file', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [
        { path: 'present.py', status: 'present', content: 'a=1\n' },
        { path: 'absent.py', status: 'missing' },
      ],
    });

    const result = await loadBundle(blob, 'hw1-mixed.zip', fixedNow);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bundle = result.value;
    expect(bundle.submissionFiles.size).toBe(2);

    const present = bundle.submissionFiles.get('present.py');
    expect(present!.status).toBe('present');
    expect(present!.hashOk).toBe(true);

    const absent = bundle.submissionFiles.get('absent.py');
    expect(absent!.status).toBe('missing');
    expect(absent!.hashOk).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two session-id spaces (see loader/types.ts, `LogFileId`)
// ---------------------------------------------------------------------------

describe('loadBundle — rolling-seal coverage lives in the LOGICAL id space', () => {
  it('resolves a seal to its logs when the .slog filename uuid differs', async () => {
    // Production ALWAYS makes these two differ: the writer names the file
    // `session-${randomUUID()}.slog` while the seal is named after
    // `session.start.data.session_id`. Keying the seal → files lookup on the
    // filename uuid misses on every session, leaves `coverage` empty, and
    // `verify-log-bytes.ts` reads empty coverage as "classic seal" — applying
    // whole-file equality to a prefix commitment and accusing honest students.
    const built = await buildTestBundle({
      sessions: [
        {
          sessionId: 'aaaaaaaa-0000-4000-8000-000000000000',
          fileUuid: 'bbbbbbbb-0000-4000-8000-000000000000',
          eventCount: 4,
        },
      ],
      rollingSeal: {},
    });

    const result = await loadBundle(built.zipBuffer, 'git-clone.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const coverage = result.value.rollingSeal!.coverage!;
    expect(coverage).toHaveLength(1);
    expect(coverage[0]!.sessionId).toBe('aaaaaaaa-0000-4000-8000-000000000000');
    expect(coverage[0]!.sessionId).not.toBe('bbbbbbbb-0000-4000-8000-000000000000');
    // The seal covers these exact bytes, so it is exact rather than absent.
    expect(coverage[0]!.slog).toEqual({ kind: 'exact' });
    // And no defect: the seal did find its session.
    expect(result.value.rollingSeal!.defects).toEqual([]);
  });

  it('refuses to guess when two .slog files carry the SAME logical session id', async () => {
    // Only reachable by duplicating a log under a second filename. No single
    // file is then "the" file that session's seal covers, so computing coverage
    // from either would be measuring bytes the seal may never have seen.
    // Refusing leaves whole-file equality in place — the same reading a classic
    // bundle gets — rather than silently taking last-write-wins.
    const built = await buildTestBundle({
      sessions: [
        {
          sessionId: 'aaaaaaaa-0000-4000-8000-000000000000',
          fileUuid: '11111111-0000-4000-8000-000000000000',
          eventCount: 4,
        },
        {
          sessionId: 'aaaaaaaa-0000-4000-8000-000000000000',
          fileUuid: '22222222-0000-4000-8000-000000000000',
          eventCount: 4,
        },
      ],
      rollingSeal: {},
    });

    const result = await loadBundle(built.zipBuffer, 'git-clone.zip', fixedNow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No coverage entry is invented for the ambiguous id.
    expect(result.value.rollingSeal!.coverage).toEqual([]);
  });
});
