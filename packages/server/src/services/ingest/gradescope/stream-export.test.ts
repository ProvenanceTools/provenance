/**
 * Unit tests for openLocalExport — the yauzl-backed streaming reader.
 *
 * Builds a faithful Gradescope export ZIP (submission_metadata.yml + one folder
 * per submission, with macOS noise), writes it to a real temp file on disk
 * (yauzl reads from a path), and asserts the streamed roster + per-submission
 * results. No DB/MinIO — this exercises only the on-disk outer read.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { openLocalExport, type StreamedSubmission } from './stream-export.js';
import { zipBundleEntries } from './build-bundle-zip.js';
import { DEFAULT_INGEST_SCOPE, type IngestScopeConfig } from './repo-scopes.js';

const PROVENANCE_FILE = /^(manifest\.json|manifest\.sig|session-.*\.slog(\.meta)?)$/;

async function layBundleIntoFolder(
  outer: JSZip,
  folderPrefix: string,
  assignmentId: string,
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId,
    semester: 'fa2026',
    sessions: [{ eventCount: 3 }],
  });
  const inner = await JSZip.loadAsync(zipBuffer);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    // Nest provenance files under .provenance/ to exercise prefix stripping.
    const dest = PROVENANCE_FILE.test(name)
      ? `${folderPrefix}.provenance/${name}`
      : `${folderPrefix}${name}`;
    outer.file(dest, bytes);
  }
}

/**
 * Metadata for the git-repo export: one submitter, one repo folder holding two
 * sealed assignment scopes, one unsealed scope, and repo noise.
 */
const REPO_METADATA = `submission_repo:
  :submitters:
  - :name: Repo Student
    :sid: '555'
    :email: repo@berkeley.edu
`;

const METADATA = `submission_solo:
  :submitters:
  - :name: Solo Student
    :sid: '111'
    :email: solo@berkeley.edu
submission_pair:
  :submitters:
  - :name: Pair One
    :sid: '222'
  - :name: Pair Two
    :sid: '333'
submission_nobundle:
  :submitters:
  - :name: No Recorder
    :sid: '444'
submission_empty:
  :submitters: []
`;

describe('openLocalExport (streaming local-path reader)', () => {
  let tmpDir: string;
  let zipPath: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'prov-stream-export-'));
    zipPath = path.join(tmpDir, 'export.zip');

    const root = 'assignment_8046601_export/';
    const outer = new JSZip();
    outer.file(`${root}submission_metadata.yml`, METADATA);
    outer.file(`${root}.DS_Store`, new Uint8Array([0]));
    outer.file(`__MACOSX/${root}._submission_metadata.yml`, new Uint8Array([0]));
    await layBundleIntoFolder(outer, `${root}submission_solo/`, 'hw10');
    await layBundleIntoFolder(outer, `${root}submission_pair/`, 'proj02');
    // A folder with files but no manifest → skipped no_manifest, submitter still rostered.
    outer.file(`${root}submission_nobundle/answers.txt`, new TextEncoder().encode('no recorder'));

    const buf = await outer.generateAsync({ type: 'nodebuffer' });
    await writeFile(zipPath, buf);
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reports not_a_zip for a non-zip file', async () => {
    const bad = path.join(tmpDir, 'not.zip');
    await writeFile(bad, 'this is not a zip');
    const res = await openLocalExport(bad);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('not_a_zip');
  });

  it('rosters every submitter and streams bundles + skipped folders, bounded', async () => {
    const opened = await openLocalExport(zipPath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    // Roster includes the no-bundle submitter (444); the empty folder adds none.
    expect(new Set(opened.rosterSubmitters.map((s) => s.sid))).toEqual(
      new Set(['111', '222', '333', '444']),
    );

    const seen: StreamedSubmission[] = [];
    for await (const sub of opened.submissions()) {
      seen.push(sub);
    }
    await opened.close();

    const bundles = seen.filter((s) => s.kind === 'bundle');
    const skipped = seen.filter((s) => s.kind === 'skipped');

    // Two real bundles (solo + pair).
    expect(bundles.map((b) => b.folderKey).sort()).toEqual(['submission_pair', 'submission_solo']);

    // The pair carries both co-submitters (caller stages one row each).
    const pair = bundles.find((b) => b.folderKey === 'submission_pair');
    expect(pair?.submitters.map((s) => s.sid).sort()).toEqual(['222', '333']);

    // Each bundle's selected entries zip into a valid flat ZIP with a manifest
    // at the root (the caller offloads this zipBundleEntries step to a pool).
    for (const b of bundles) {
      if (b.kind !== 'bundle') continue;
      expect(b.entries.some((e) => e.name === 'manifest.json')).toBe(true);
      const inner = await JSZip.loadAsync(await zipBundleEntries(b.entries));
      expect(inner.file('manifest.json')).not.toBeNull();
    }

    // Skips: nobundle → no_manifest, empty → no_submitters.
    const skipReasons = Object.fromEntries(
      skipped.map((s) => [s.folderKey, s.kind === 'skipped' ? s.reason : '']),
    );
    expect(skipReasons['submission_nobundle']).toBe('no_manifest');
    expect(skipReasons['submission_empty']).toBe('no_submitters');
  });
});

// ---------------------------------------------------------------------------
// Git-native ingest: one repository, several assignment scopes
// ---------------------------------------------------------------------------

describe('openLocalExport — git repo with several .provenance/ scopes', () => {
  let tmpDir: string;
  let zipPath: string;
  const root = 'assignment_9000_export/';
  const folder = `${root}submission_repo/`;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'prov-stream-repo-'));
    zipPath = path.join(tmpDir, 'repo-export.zip');

    const outer = new JSZip();
    outer.file(`${root}submission_metadata.yml`, REPO_METADATA);
    await layBundleIntoFolder(outer, `${folder}proj2/`, 'proj2');
    await layBundleIntoFolder(outer, `${folder}lab5/`, 'lab5');
    // A scope the student worked in but never sealed: session logs, no manifest.
    outer.file(
      `${folder}lab6/.provenance/session-11111111-1111-4111-8111-111111111111.slog`,
      new TextEncoder().encode('{}\n'),
    );
    outer.file(`${folder}README.md`, new TextEncoder().encode('# repo\n'));

    await writeFile(zipPath, await outer.generateAsync({ type: 'nodebuffer' }));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function drain(scopeConfig?: IngestScopeConfig): Promise<StreamedSubmission[]> {
    const opened = await openLocalExport(
      zipPath,
      scopeConfig === undefined ? {} : { scopeConfigFor: () => scopeConfig },
    );
    if (!opened.ok) throw new Error(`openLocalExport failed: ${opened.error}`);
    const seen: StreamedSubmission[] = [];
    for await (const sub of opened.submissions()) seen.push(sub);
    await opened.close();
    return seen;
  }

  it('yields one bundle per sealed scope, each with its own declared assignment', async () => {
    const seen = await drain();
    const bundles = seen.filter((s) => s.kind === 'bundle');

    expect(bundles.map((b) => b.scopePath).sort()).toEqual(['lab5/', 'proj2/']);
    // All from ONE uploaded folder and ONE submitter — the fan-out is per scope.
    expect(new Set(bundles.map((b) => b.folderKey))).toEqual(new Set(['submission_repo']));
    for (const b of bundles) {
      if (b.kind !== 'bundle') continue;
      expect(b.submitters.map((s) => s.sid)).toEqual(['555']);
      const inner = await JSZip.loadAsync(await zipBundleEntries(b.entries));
      const manifestFile = inner.file('manifest.json');
      expect(manifestFile).not.toBeNull();
      const manifest = JSON.parse(await manifestFile!.async('string')) as {
        assignment_id: string;
      };
      expect(manifest.assignment_id).toBe(b.scopePath.slice(0, -1));
    }
  });

  it('reports the unsealed scope as no_seal rather than dropping the repo', async () => {
    const seen = await drain();
    const skipped = seen.filter((s) => s.kind === 'skipped');
    expect(skipped.map((s) => (s.kind === 'skipped' ? [s.scopePath, s.reason] : []))).toEqual([
      ['lab6/', 'no_seal'],
    ]);
  });

  it('honours ingest_scope mode=path, excluding the non-matching scopes', async () => {
    const seen = await drain({ mode: 'path', path_glob: 'proj2/**', on_multiple: 'ingest_all' });
    const bundles = seen.filter((s) => s.kind === 'bundle');
    expect(bundles.map((b) => b.scopePath)).toEqual(['proj2/']);
    const excluded = seen.filter((s) => s.kind === 'skipped' && s.reason === 'scope_excluded');
    expect(excluded.map((s) => (s.kind === 'skipped' ? s.scopePath : ''))).toEqual(['lab5/']);
  });

  it('defaults to accepting every sealed scope when no config is supplied', async () => {
    const withDefault = await drain(DEFAULT_INGEST_SCOPE);
    const implicit = await drain();
    expect(withDefault.filter((s) => s.kind === 'bundle').map((b) => b.scopePath)).toEqual(
      implicit.filter((s) => s.kind === 'bundle').map((b) => b.scopePath),
    );
  });
});
