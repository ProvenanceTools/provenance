import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { unzipBundle } from '@provenance/analysis-core/loader/unzip.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { runValidation } from '@provenance/analysis-core/validation/run-validation.js';
import { stripBundleSourceFiles, isProvenanceEntry } from './strip-bundle.js';

// @noble/ed25519 needs SHA-512 wired explicitly outside the browser.
beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

/**
 * The critical contract: strip may re-container the bundle (different zip bytes,
 * native-zlib DEFLATE instead of JSZip/pako) but must preserve the DECOMPRESSED
 * provenance content verbatim — especially the signed manifest.json / manifest.sig
 * — so the stored bundle stays signature- and chain-verifiable, while dropping the
 * student source files.
 */
describe('stripBundleSourceFiles', () => {
  it('preserves provenance entries verbatim and drops source files', async () => {
    const built = await buildTestBundle({
      submissionFiles: [
        { path: 'hw.py', status: 'present', content: 'print("secret student source")\n' },
        { path: 'util.py', status: 'present', content: 'def f():\n    return 42\n' },
      ],
    });
    const fullBytes = new Uint8Array(built.zipBuffer);

    // Baseline: parse the full bundle.
    const fullParsed = await unzipBundle(built.zipBuffer);
    expect(fullParsed.ok).toBe(true);
    if (!fullParsed.ok) return;
    // Sanity: source files are present before stripping.
    expect(fullParsed.value.submissionFiles.size).toBeGreaterThan(0);

    // Strip, then re-parse the stored (provenance-only) bundle.
    const stripped = await stripBundleSourceFiles(fullBytes);
    const strippedParsed = await unzipBundle(stripped.buffer as ArrayBuffer);
    expect(strippedParsed.ok).toBe(true);
    if (!strippedParsed.ok) return;

    // Signed manifest + signature byte-identical (guarantees verifiability).
    expect(strippedParsed.value.manifestJson).toBe(fullParsed.value.manifestJson);
    expect(strippedParsed.value.manifestSigHex).toBe(fullParsed.value.manifestSigHex);

    // Every session's .slog / .slog.meta content preserved verbatim.
    expect(strippedParsed.value.sessions.length).toBe(fullParsed.value.sessions.length);
    for (let i = 0; i < fullParsed.value.sessions.length; i++) {
      expect(strippedParsed.value.sessions[i]!.slogText).toBe(
        fullParsed.value.sessions[i]!.slogText,
      );
      expect(strippedParsed.value.sessions[i]!.metaJson).toBe(
        fullParsed.value.sessions[i]!.metaJson,
      );
    }

    // Source files are gone from the stored bundle.
    expect(strippedParsed.value.submissionFiles.size).toBe(0);
    // And the stripped blob is smaller than the original.
    expect(stripped.length).toBeLessThan(fullBytes.length);
  });

  it('is deterministic (same input → identical stored bytes)', async () => {
    const built = await buildTestBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', content: 'x = 1\n' }],
    });
    const bytes = new Uint8Array(built.zipBuffer);
    const a = await stripBundleSourceFiles(bytes);
    const b = await stripBundleSourceFiles(bytes);
    expect(a).toEqual(b);
  });
});

/**
 * The ROLLING seal (program spec §8) under stripping.
 *
 * A git-submitted bundle has NO classic `manifest.json` — the only thing
 * sealing it is the per-session `manifest-<session_id>.json` / `.sig` pair. The
 * strip allowlist was four patterns (`manifest.json`, `manifest.sig`, `*.slog`,
 * `*.slog.meta`), none of which match those filenames, so stripping deleted the
 * seal from every stored git submission: the blob became unloadable
 * (`missing_manifest`) and permanently unverifiable.
 */
describe('stripBundleSourceFiles — rolling seal', () => {
  it('preserves the rolling seal verbatim, and the stored bundle still VERIFIES', async () => {
    const built = await buildTestBundle({
      rollingSeal: {},
      sessions: [{ eventCount: 5 }, { eventCount: 5 }],
      submissionFiles: [{ path: 'Gitlet.java', status: 'present', content: 'class Gitlet {}\n' }],
    });
    const fullBytes = new Uint8Array(built.zipBuffer);

    // Precondition: this really is a rolling-sealed bundle (no classic manifest).
    const fullParsed = await unzipBundle(built.zipBuffer);
    expect(fullParsed.ok).toBe(true);
    if (!fullParsed.ok) return;
    expect(fullParsed.value.manifestJson).toBeNull();
    expect(fullParsed.value.rollingSeals.length).toBe(2);

    const stripped = await stripBundleSourceFiles(fullBytes);
    const strippedParsed = await unzipBundle(stripped.buffer as ArrayBuffer);
    expect(strippedParsed.ok).toBe(true);
    if (!strippedParsed.ok) return;

    // Every rolling seal survived, byte-for-byte on both halves.
    expect(strippedParsed.value.rollingSeals.length).toBe(2);
    const before = new Map(fullParsed.value.rollingSeals.map((s) => [s.sessionId, s]));
    for (const seal of strippedParsed.value.rollingSeals) {
      const orig = before.get(seal.sessionId);
      expect(orig).toBeDefined();
      expect(seal.manifestJson).toBe(orig!.manifestJson);
      expect(seal.sigHex).toBe(orig!.sigHex);
    }

    // Source is gone.
    expect(strippedParsed.value.submissionFiles.size).toBe(0);

    // The real contract: the STRIPPED bundle still passes signature verification.
    const loaded = await loadBundle(stripped.buffer as ArrayBuffer, 'stored.zip');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const report = await runValidation(loaded.value);
    expect(report.checks.find((c) => c.id === 'manifest_sig')?.status).toBe('pass');
  });

  it('does not treat a decoy `manifest-notes.json` as a seal', () => {
    // A loose regex would swallow this and keep student source in the store.
    expect(isProvenanceEntry('manifest-notes.json')).toBe(false);
    expect(isProvenanceEntry('manifest.json')).toBe(true);
    expect(isProvenanceEntry('manifest-0000000a-0000-4000-8000-000000000000.json')).toBe(true);
    expect(isProvenanceEntry('manifest-0000000a-0000-4000-8000-000000000000.sig')).toBe(true);
  });
});
