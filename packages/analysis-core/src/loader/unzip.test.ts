/**
 * Unit tests for unzipBundle.
 *
 * Uses buildTestBundle to produce real ZIPs in memory. Each test asserts on the
 * shape of the Result returned by unzipBundle — never on internal implementation.
 */

import { describe, it, expect } from 'vitest';
import { unzipBundle } from './unzip.js';
import { buildTestBundle } from '../test-support/build-test-bundle.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function validZip() {
  return buildTestBundle({ sessions: [{}] });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('unzipBundle', () => {
  it('returns ok with expected BundleFiles shape for a valid single-session ZIP', async () => {
    const { blob } = await validZip();
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(typeof result.value.manifestJson).toBe('string');
    expect(result.value.manifestJson!.length).toBeGreaterThan(0);

    expect(typeof result.value.manifestSigHex).toBe('string');
    expect(result.value.manifestSigHex!.length).toBeGreaterThan(0);

    expect(result.value.sessions).toHaveLength(1);
    const s = result.value.sessions[0]!;
    expect(typeof s.sessionId).toBe('string');
    expect(s.sessionId.length).toBeGreaterThan(0);
    expect(typeof s.slogText).toBe('string');
    expect(s.slogText.length).toBeGreaterThan(0);
    expect(typeof s.metaJson).toBe('string');
    expect(s.metaJson.length).toBeGreaterThan(0);
  });

  it('returns ok for a multi-session ZIP', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}, {}] });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions).toHaveLength(2);
  });

  it('accepts ArrayBuffer input as well as Blob', async () => {
    // Use zipBuffer directly — jsdom's Blob may not expose .arrayBuffer().
    const { zipBuffer } = await buildTestBundle({ sessions: [{}] });
    const result = await unzipBundle(zipBuffer);
    expect(result.ok).toBe(true);
  });

  it('returns not_a_zip for garbage bytes', async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    const result = await unzipBundle(garbage.buffer as ArrayBuffer);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_a_zip');
  });

  it('returns missing_manifest when manifest.json is absent', async () => {
    const { blob } = await buildTestBundle({ tamper: { omitManifest: true } });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing_manifest');
  });

  it('returns missing_signature when manifest.sig is absent', async () => {
    const { blob } = await buildTestBundle({ tamper: { omitSig: true } });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing_signature');
  });

  it('returns no_sessions when no .slog files are present', async () => {
    const { blob } = await buildTestBundle({ tamper: { omitAllSlogs: true } });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no_sessions');
  });

  it('returns orphaned_meta when a .slog.meta has no matching .slog', async () => {
    // Two sessions: session[0] is present fully; session[1]'s .slog is omitted
    // but its .meta remains → orphaned_meta for session[1].
    const { blob } = await buildTestBundle({ sessions: [{}, {}], tamper: { omitOneSlog: true } });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('orphaned_meta');
  });

  it('returns orphaned_slog when a .slog has no matching .slog.meta', async () => {
    // omitOneSlogMeta: the last session's .meta is omitted but its .slog remains
    const { blob } = await buildTestBundle({
      sessions: [{}],
      tamper: { omitOneSlogMeta: true },
    });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('orphaned_slog');
  });

  it('returns unexpected_file for a stray file in the ZIP', async () => {
    const { blob } = await buildTestBundle({
      tamper: { addStrayFile: { name: 'README.txt', content: 'hello' } },
    });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unexpected_file');
    if (result.error.kind !== 'unexpected_file') return;
    expect(result.error.filename).toBe('README.txt');
  });

  // ---------------------------------------------------------------------------
  // 1.1 bundle — submission file whitelisting (Task C1)
  // ---------------------------------------------------------------------------

  it('accepts submission files listed in the manifest and returns their bytes', async () => {
    const { blob } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [{ path: 'hw03.py', status: 'present', content: 'print(1)\n' }],
    });

    const result = await unzipBundle(blob);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bytes = result.value.submissionFiles.get('hw03.py');
    expect(bytes).toBeDefined();
    expect(new TextDecoder().decode(bytes!)).toBe('print(1)\n');
  });

  it('returns an empty submissionFiles map for a 1.0 bundle', async () => {
    const { blob } = await buildTestBundle({ sessions: [{}] });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.submissionFiles.size).toBe(0);
  });

  it('rejects a root file that is not a recognized bundle file nor a whitelisted submission file (1.1 bundle)', async () => {
    // Build a valid 1.1 bundle, then add an extra stray file not in the manifest.
    const { blob } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [{ path: 'hw03.py', status: 'present', content: 'x=1\n' }],
      tamper: { addStrayFile: { name: 'stray.txt', content: 'junk' } },
    });

    const result = await unzipBundle(blob);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unexpected_file');
    if (result.error.kind !== 'unexpected_file') return;
    expect(result.error.filename).toBe('stray.txt');
  });
});
