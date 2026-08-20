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
    expect(typeof s.logFileId).toBe('string');
    expect(s.logFileId.length).toBeGreaterThan(0);
    expect(typeof s.slogText).toBe('string');
    expect(s.slogText.length).toBeGreaterThan(0);
    expect(typeof s.metaJson).toBe('string');
    expect(s.metaJson.length).toBeGreaterThan(0);
  });

  it('reports the .slog FILENAME uuid, not the logical session id', async () => {
    // The two are different values in production, and the loader has already
    // crossed them once — with a maximum-severity false accusation as the
    // result. Pin which one the unzipper reports, on a bundle where they differ.
    const built = await buildTestBundle({
      sessions: [
        {
          sessionId: 'aaaaaaaa-0000-4000-8000-000000000000',
          fileUuid: 'bbbbbbbb-0000-4000-8000-000000000000',
        },
      ],
    });
    const result = await unzipBundle(built.blob);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const s = result.value.sessions[0]!;
    expect(s.logFileId).toBe('bbbbbbbb-0000-4000-8000-000000000000');
    expect(s.logFileId).not.toBe('aaaaaaaa-0000-4000-8000-000000000000');
    expect(built.sessionIds).toEqual(['aaaaaaaa-0000-4000-8000-000000000000']);
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

  // -------------------------------------------------------------------------
  // The read-side orphan guard.
  //
  // PREMISE CHANGE, deliberate: the two tests below used to assert that an
  // orphaned `.slog.meta` and an orphaned `.slog` each FAIL THE WHOLE BUNDLE
  // (`expect(result.ok).toBe(false)`). That premise was wrong, and it was wrong
  // in the direction that costs a student their whole submission.
  //
  // The classic path never produces these shapes — `sealBundle`'s orphan guard
  // drops them before they are packed — so the fatality protected nothing there.
  // The GIT path has no seal step: the student pushes, the grader clones, and
  // whatever is in `.provenance/` is the submission. There a stranded
  // `.slog.meta` is the ORDINARY output of crash recovery (`chain-recovery.ts`
  // quarantines a damaged `.slog` to `.corrupt-<ISO>` and leaves the sidecar),
  // and it made every session the student had recorded unreadable.
  //
  // So the assertion is inverted, not weakened: the bundle must LOAD, the
  // healthy session must survive, and the leftover must be REPORTED. Silence
  // would be a worse outcome than the old hard error, and is asserted against.
  // -------------------------------------------------------------------------

  it('drops an orphaned .slog.meta and reports it, keeping the healthy session', async () => {
    // Two sessions: session[0] is present fully; session[1]'s .slog is omitted
    // but its .meta remains — the shape crash recovery leaves behind.
    const { blob } = await buildTestBundle({ sessions: [{}, {}], tamper: { omitOneSlog: true } });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The healthy session is still analysable — the whole point.
    expect(result.value.sessions).toHaveLength(1);

    const dropped = result.value.droppedArtifacts;
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.kind).toBe('orphaned_meta');
    expect(dropped[0]!.filename).toMatch(/^session-.+\.slog\.meta$/);
    // Reported, not silent — and reported as an incomplete recording rather
    // than as tampering.
    expect(dropped[0]!.detail).toContain('INCOMPLETE RECORDING');
    expect(dropped[0]!.detail).not.toMatch(/tamper/i);
    // The sidecar names the recording that went missing, which is what lets its
    // rolling seal be dropped with it rather than becoming a check-1 failure.
    expect(dropped[0]!.logicalSessionId).toBeDefined();
  });

  it('drops an orphaned .slog and reports it, keeping the healthy session', async () => {
    // omitOneSlogMeta: the LAST session's .meta is omitted but its .slog remains.
    // Two sessions, so that what is measured is the degrade rather than the
    // nothing-left-to-analyse case covered by the next test.
    const { blob } = await buildTestBundle({
      sessions: [{}, {}],
      tamper: { omitOneSlogMeta: true },
    });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sessions).toHaveLength(1);

    const dropped = result.value.droppedArtifacts;
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.kind).toBe('orphaned_slog');
    expect(dropped[0]!.filename).toMatch(/^session-.+\.slog$/);
    expect(dropped[0]!.detail).toContain('INCOMPLETE RECORDING');
  });

  it('still returns no_sessions when dropping leaves nothing analysable', async () => {
    // The one case where degrading has nowhere to degrade TO. A single session
    // whose sidecar is missing is dropped like any other, and then there is no
    // reading left to give — so the load fails, exactly as it always has.
    const { blob } = await buildTestBundle({
      sessions: [{}],
      tamper: { omitOneSlogMeta: true },
    });
    const result = await unzipBundle(blob);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no_sessions');
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
