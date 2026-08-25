/**
 * Unit tests for parseGradescopeExport — pure (JSZip in/out), no DB.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { parseGradescopeExport } from './parse-export.js';

const PROVENANCE_FILE = /^(manifest\.json|manifest\.sig|session-.*\.slog(\.meta)?)$/;

async function layBundleIntoFolder(
  outer: JSZip,
  folderPrefix: string,
  flatBundleZip: ArrayBuffer,
): Promise<void> {
  const inner = await JSZip.loadAsync(flatBundleZip);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    const dest = PROVENANCE_FILE.test(name)
      ? `${folderPrefix}.provenance/${name}`
      : `${folderPrefix}${name}`;
    outer.file(dest, bytes);
  }
}

async function bundleBytes(assignmentId: string): Promise<ArrayBuffer> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId,
    semester: 'fa2026',
    sessions: [{ eventCount: 3 }],
  });
  return zipBuffer;
}

/** Build a realistic export ZIP under one top-level export folder. */
async function buildExportZip(metadataYaml: string): Promise<ArrayBuffer> {
  const root = 'assignment_8046601_export/';
  const outer = new JSZip();
  outer.file(`${root}submission_metadata.yml`, metadataYaml);
  // macOS noise at the export root.
  outer.file(`${root}.DS_Store`, new Uint8Array([0]));
  outer.file(`__MACOSX/${root}._submission_metadata.yml`, new Uint8Array([0]));

  // A single-submitter submission and a group submission (real bundles).
  await layBundleIntoFolder(outer, `${root}submission_single/`, await bundleBytes('hw10'));
  await layBundleIntoFolder(outer, `${root}submission_group/`, await bundleBytes('proj02'));
  // A folder with no provenance bundle (only a student file).
  outer.file(`${root}submission_nobundle/answers.txt`, new TextEncoder().encode('no recorder'));

  return outer.generateAsync({ type: 'arraybuffer' });
}

const METADATA = `submission_single:
  :submitters:
  - :name: Solo Student
    :sid: '100'
    :email: solo@berkeley.edu
submission_group:
  :submitters:
  - :name: Pair One
    :sid: '200'
    :email: one@berkeley.edu
  - :name: Pair Two
    :sid: '201'
    :email: two@berkeley.edu
submission_nobundle:
  :submitters:
  - :name: No Recorder
    :sid: '300'
`;

describe('parseGradescopeExport', () => {
  it('parses metadata, rebuilds bundles, and reports roster + skipped', async () => {
    const zip = await buildExportZip(METADATA);
    const res = await parseGradescopeExport(zip);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Roster: every submitter across the export, deduped by sid.
    expect(new Set(res.value.rosterSubmitters.map((s) => s.sid))).toEqual(
      new Set(['100', '200', '201', '300']),
    );

    // Two real bundles (single + group); the no-bundle folder is skipped.
    const byFolder = new Map(res.value.bundles.map((b) => [b.folderKey, b]));
    expect(new Set(byFolder.keys())).toEqual(new Set(['submission_single', 'submission_group']));

    // The group bundle carries both submitters (caller fans out one row each).
    expect(
      byFolder
        .get('submission_group')!
        .submitters.map((s) => s.sid)
        .sort(),
    ).toEqual(['200', '201']);

    // Each rebuilt bundle is loadable.
    const single = await loadBundle(byFolder.get('submission_single')!.bundleZip, 's.zip');
    expect(single.ok).toBe(true);
    if (single.ok) expect(single.value.manifest.assignment_id).toBe('hw10');

    // The no-manifest folder is reported as skipped, still rostered.
    expect(res.value.skipped).toHaveLength(1);
    expect(res.value.skipped[0]).toMatchObject({
      folderKey: 'submission_nobundle',
      reason: 'no_manifest',
    });
  });

  it('returns missing_metadata when there is no submission_metadata.yml', async () => {
    const outer = new JSZip();
    outer.file('export/submission_1/.provenance/manifest.json', '{}');
    const res = await parseGradescopeExport(await outer.generateAsync({ type: 'arraybuffer' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('missing_metadata');
  });

  it('returns not_a_zip for non-zip bytes', async () => {
    const res = await parseGradescopeExport(new TextEncoder().encode('not a zip').buffer);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not_a_zip');
  });

  it('skips a submission whose submitter list is empty', async () => {
    const zip = await buildExportZip(`submission_single:
  :submitters: []
`);
    const res = await parseGradescopeExport(zip);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.bundles).toHaveLength(0);
    expect(res.value.skipped).toEqual([
      { folderKey: 'submission_single', scopePath: '', submitters: [], reason: 'no_submitters' },
    ]);
  });
});
