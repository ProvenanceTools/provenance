/**
 * Unit tests for buildBundleZipForFolder — pure (JSZip in/out), no DB.
 *
 * The strongest assertion is a round-trip: the rebuilt ZIP must parse cleanly
 * through the analyzer loader (loadBundle), proving it is a valid flat bundle.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildTestBundle } from '../test-support/build-test-bundle.js';
import { loadBundle } from '../loader/parse-bundle.js';
import { buildBundleZipForFolder, buildBundleZipFromFiles } from './select-entries.js';

const PROVENANCE_FILE = /^(manifest\.json|manifest\.sig|session-.*\.slog(\.meta)?)$/;

/**
 * UTF-8 fixture bytes in THIS realm.
 *
 * analysis-core's suite runs under jsdom (JSZip needs FileReader), and jsdom's
 * `TextEncoder` returns a Uint8Array from the jsdom VM context. JSZip type-tests
 * its input with `instanceof Uint8Array`, which is false across realms, so a
 * bare `new TextEncoder().encode(...)` fixture is rejected as unreadable data.
 * `Uint8Array.from` copies into the test realm. Bytes are identical either way —
 * this is a test-fixture concern only, not a property of the code under test.
 */
function utf8(text: string): Uint8Array {
  return Uint8Array.from(new TextEncoder().encode(text));
}

/**
 * Lay a flat bundle ZIP's entries into an outer export folder.
 *
 * @param layout 'nested' puts provenance files under `<folder>/.provenance/`;
 *               'flat' puts everything at `<folder>/`. Submission files always
 *               sit at the folder root (mirrors the seal's workspace layout).
 */
async function layBundleIntoFolder(
  outer: JSZip,
  folderPrefix: string,
  flatBundleZip: ArrayBuffer,
  layout: 'nested' | 'flat',
): Promise<void> {
  const inner = await JSZip.loadAsync(flatBundleZip);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    const isProvenance = PROVENANCE_FILE.test(name);
    const dest =
      isProvenance && layout === 'nested'
        ? `${folderPrefix}.provenance/${name}`
        : `${folderPrefix}${name}`;
    outer.file(dest, bytes);
  }
}

async function builtBundleWithSubmissionFile(): Promise<ArrayBuffer> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId: 'hw10',
    semester: 'fa2026',
    submissionFiles: [{ path: 'hw10.sql', status: 'present', content: 'SELECT 1;\n' }],
    sessions: [{ eventCount: 3 }],
  });
  return zipBuffer;
}

describe('buildBundleZipForFolder', () => {
  it('rebuilds a loadable flat bundle from a .provenance-nested folder, dropping junk', async () => {
    const flat = await builtBundleWithSubmissionFile();
    const outer = new JSZip();
    const prefix = 'assignment_1_export/submission_42/';
    await layBundleIntoFolder(outer, prefix, flat, 'nested');
    // Add noise that must be excluded.
    outer.file(`${prefix}.DS_Store`, new Uint8Array([0]));
    outer.file(`__MACOSX/${prefix}._manifest.json`, new Uint8Array([0]));
    outer.file(`${prefix}.provenance/._session-x.slog`, new Uint8Array([0]));
    outer.file(`${prefix}notes.txt`, utf8('not in manifest'));

    const built = await buildBundleZipForFolder(outer, prefix);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // Round-trips through the real loader.
    const loaded = await loadBundle(built.data, 'submission_42.zip');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.manifest.assignment_id).toBe('hw10');

    // The rebuilt ZIP is flat and excludes junk + the unexpected notes.txt.
    const rebuilt = await JSZip.loadAsync(built.data);
    const names = Object.keys(rebuilt.files).filter((n) => !rebuilt.files[n]!.dir);
    expect(names).toContain('manifest.json');
    expect(names).toContain('manifest.sig');
    expect(names).toContain('hw10.sql');
    expect(names.some((n) => n.startsWith('.provenance/'))).toBe(false);
    expect(names).not.toContain('.DS_Store');
    expect(names).not.toContain('notes.txt');
    expect(names.some((n) => n.startsWith('._') || n.includes('__MACOSX'))).toBe(false);
  });

  it('rebuilds a loadable bundle from a flat folder layout', async () => {
    const flat = await builtBundleWithSubmissionFile();
    const outer = new JSZip();
    const prefix = 'export/submission_7/';
    await layBundleIntoFolder(outer, prefix, flat, 'flat');

    const built = await buildBundleZipForFolder(outer, prefix);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const loaded = await loadBundle(built.data, 'submission_7.zip');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.submissionFiles.get('hw10.sql')?.hashOk).toBe(true);
  });

  it('returns no_manifest when the folder has no manifest.json', async () => {
    const outer = new JSZip();
    const prefix = 'export/submission_empty/';
    outer.file(`${prefix}hw10.sql`, utf8('SELECT 1;\n'));
    outer.file(`${prefix}.DS_Store`, new Uint8Array([0]));

    const built = await buildBundleZipForFolder(outer, prefix);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe('no_manifest');
  });
});

// ---------------------------------------------------------------------------
// buildBundleZipFromFiles (the map-based core the streaming reader uses)
// ---------------------------------------------------------------------------

/** Flatten an inner bundle ZIP into a folder-relative files map. */
async function bundleToFolderFiles(
  flat: ArrayBuffer,
  layout: 'nested' | 'flat',
): Promise<Map<string, Uint8Array>> {
  const inner = await JSZip.loadAsync(flat);
  const files = new Map<string, Uint8Array>();
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    const rel = PROVENANCE_FILE.test(name) && layout === 'nested' ? `.provenance/${name}` : name;
    files.set(rel, bytes);
  }
  return files;
}

describe('buildBundleZipFromFiles', () => {
  it('rebuilds a loadable flat bundle from a folder-relative files map (nested)', async () => {
    const flat = await builtBundleWithSubmissionFile();
    const files = await bundleToFolderFiles(flat, 'nested');
    // Junk in the map must be dropped, not included.
    files.set('.DS_Store', new Uint8Array([0]));

    const built = await buildBundleZipFromFiles(files);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const loaded = await loadBundle(built.data, 'submission_42.zip');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.submissionFiles.get('hw10.sql')?.hashOk).toBe(true);
  });

  it('returns no_manifest when the map has no manifest.json', async () => {
    const files = new Map<string, Uint8Array>([['hw10.sql', utf8('SELECT 1;\n')]]);
    const built = await buildBundleZipFromFiles(files);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe('no_manifest');
  });
});
