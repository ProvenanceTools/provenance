/**
 * Unit tests for `expandRepoZip` — git-repo expansion on the plain multipart
 * upload route (`POST /semesters/:semesterId/ingest`).
 *
 * Three properties are under test, and they are of different kinds:
 *
 *  1. **The guard holds.** Every shape this route handled before — a single
 *     sealed bundle, an inner bundle out of a zip-of-bundles, a non-zip —
 *     returns `null`, meaning the route stages its ORIGINAL bytes. A `null`
 *     return is the only way the pre-existing code path is reached, so these
 *     assertions are the byte-for-byte guarantee: nothing is rebuilt, so no
 *     staged `blob_sha256` (the dedup key) can move.
 *  2. **A repo zip is expanded, and by the Gradescope path's own code.** The
 *     equivalence test drives the SAME repo tree through `openLocalExport` (the
 *     Gradescope/local-path reader) and through `expandRepoZip`, and requires
 *     identical scopes, identical skip reasons and byte-identical rebuilt
 *     bundles. A second, divergent implementation of scope discovery fails it.
 *  3. **The declared submission type is asserted, and failures are legible**
 *     through the existing `no_seal` / `scope_excluded` / `ambiguous_scope` /
 *     `submission_type_mismatch` vocabulary — never a new channel.
 *
 * Pure: no DB, no MinIO, no containers.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import JSZip from 'jszip';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { runValidation } from '@provenance/analysis-core/validation/run-validation.js';
import { expandRepoZip } from './repo-zip.js';
import { openLocalExport, type StreamedSubmission } from './gradescope/stream-export.js';
import { zipBundleEntries } from './gradescope/build-bundle-zip.js';
import {
  DEFAULT_INGEST_SCOPE,
  type IngestScopeConfig,
  type IngestScopeConfigResolver,
} from './gradescope/repo-scopes.js';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

const PROVENANCE_FILE =
  /^(manifest\.json|manifest\.sig|manifest-[0-9a-f-]+\.(json|sig)|session-.*\.slog(\.meta)?)$/;

const resolverFor =
  (config: IngestScopeConfig): IngestScopeConfigResolver =>
  () =>
    config;
const DEFAULT: IngestScopeConfigResolver = resolverFor(DEFAULT_INGEST_SCOPE);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Lay one sealed bundle's files into `files` under `prefix`, `.provenance/`-nested. */
async function layScope(
  files: Map<string, Uint8Array>,
  prefix: string,
  assignmentId: string,
  opts?: { rolling?: boolean },
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId,
    semester: 'fa2026',
    ...(opts?.rolling === true ? { rollingSeal: {} } : {}),
    sessions: [{ eventCount: 4 }],
    submissionFiles: [
      { path: 'Main.java', status: 'present', content: `class Main {} // ${assignmentId}\n` },
    ],
  });
  const inner = await JSZip.loadAsync(zipBuffer);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    files.set(
      PROVENANCE_FILE.test(name) ? `${prefix}.provenance/${name}` : `${prefix}${name}`,
      bytes,
    );
  }
}

/** Serialize a tree-relative file map into a `.zip` the route would receive. */
async function zipTree(files: Map<string, Uint8Array>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [name, bytes] of files) zip.file(name, bytes);
  return zip.generateAsync({ type: 'arraybuffer' });
}

/** A repo with a sealed ROOT scope plus a nested vendored one. */
async function repoRootedTree(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  await layScope(files, '', 'hw10');
  await layScope(files, 'vendor/', 'lab5');
  files.set('README.md', new TextEncoder().encode('# repo\n'));
  return files;
}

/** A repo with NO root scope: two nested sealed scopes. */
async function repoNestedTree(): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  await layScope(files, 'proj2/', 'proj2');
  await layScope(files, 'lab5/', 'lab5');
  files.set('README.md', new TextEncoder().encode('# repo\n'));
  return files;
}

const REPO_METADATA = `submission_repo:
  :submitters:
  - :name: Repo Student
    :sid: '555'
    :email: repo@berkeley.edu
`;

// ---------------------------------------------------------------------------
// 1. The guard — the two shapes this route already handled are never touched
// ---------------------------------------------------------------------------

describe('expandRepoZip — shapes the route already handled are returned untouched', () => {
  it('returns null for a single flat sealed bundle (classic manifest at the root)', async () => {
    const { zipBuffer } = await buildTestBundle({ assignmentId: 'hw1', sessions: [{}] });
    expect(await expandRepoZip('hw1-123456.zip', zipBuffer, DEFAULT)).toBeNull();
  });

  it('returns null for a flat ROLLING-sealed bundle (no classic manifest at all)', async () => {
    const { zipBuffer } = await buildTestBundle({
      assignmentId: 'proj2',
      rollingSeal: {},
      sessions: [{ eventCount: 4 }],
    });
    expect(await expandRepoZip('proj2-123456.zip', zipBuffer, DEFAULT)).toBeNull();
  });

  it('returns null for the inner bundles of a zip-of-bundles', async () => {
    // The route expands the outer archive itself and hands each inner entry
    // here; every one is a flat bundle, so every one falls straight through.
    const a = await buildTestBundle({ assignmentId: 'hw1', sessions: [{}] });
    const b = await buildTestBundle({ assignmentId: 'hw1', sessions: [{}] });
    expect(await expandRepoZip('student1.zip', a.zipBuffer, DEFAULT)).toBeNull();
    expect(await expandRepoZip('student2.zip', b.zipBuffer, DEFAULT)).toBeNull();
  });

  it('returns null for a name that is not a .zip, and for bytes that are not a zip', async () => {
    const notAZip = new TextEncoder().encode('this is not a zip').buffer as ArrayBuffer;
    expect(await expandRepoZip('notes.txt', notAZip, DEFAULT)).toBeNull();
    expect(await expandRepoZip('notes.zip', notAZip, DEFAULT)).toBeNull();
  });

  it('returns null when the only .provenance/ path is macOS junk', async () => {
    const files = new Map<string, Uint8Array>();
    files.set('README.md', new TextEncoder().encode('# repo\n'));
    files.set('__MACOSX/proj2/.provenance/._manifest.json', new Uint8Array([0]));
    expect(await expandRepoZip('repo.zip', await zipTree(files), DEFAULT)).toBeNull();
  });

  it('the guard is decided WITHOUT rebuilding, so a bundle it passes over is bit-identical', async () => {
    // The strongest available statement of "existing behaviour is untouched":
    // a null return means the route stages the very ArrayBuffer it was given.
    const { zipBuffer } = await buildTestBundle({ assignmentId: 'hw1', sessions: [{}] });
    const before = Buffer.from(zipBuffer);
    expect(await expandRepoZip('hw1-123456.zip', zipBuffer, DEFAULT)).toBeNull();
    expect(Buffer.from(zipBuffer)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// 2. A git repo zip is expanded
// ---------------------------------------------------------------------------

describe('expandRepoZip — a git repo zip', () => {
  it('fans a two-scope repo out into one bundle per scope', async () => {
    const result = await expandRepoZip('repo.zip', await zipTree(await repoNestedTree()), DEFAULT);
    expect(result).not.toBeNull();
    expect(result!.bundles.map((b) => b.scopePath)).toEqual(['lab5/', 'proj2/']);
    // A fanned-out scope names its directory beneath the upload's stem, the
    // same shape local-path.ts uses for a Gradescope fan-out.
    expect(result!.bundles.map((b) => b.filename)).toEqual(['repo/lab5.zip', 'repo/proj2.zip']);
    expect(result!.skipped).toEqual([]);
  });

  it('keeps the uploaded filename verbatim for a scope at the repo root', async () => {
    // This is what preserves filename-convention matching for a repo whose
    // provenance sits at its root: the staged name is the name that was sent.
    const result = await expandRepoZip(
      'hw10-123456.zip',
      await zipTree(await repoRootedTree()),
      resolverFor({ mode: 'repo_whole', on_multiple: 'ingest_all' }),
    );
    expect(result!.bundles.map((b) => b.filename)).toEqual(['hw10-123456.zip']);
  });

  it('produces bundles the real loader accepts and the real validation passes', async () => {
    const files = new Map<string, Uint8Array>();
    await layScope(files, 'proj2/', 'proj2', { rolling: true });
    files.set('README.md', new TextEncoder().encode('# repo\n'));

    const result = await expandRepoZip('repo.zip', await zipTree(files), DEFAULT);
    expect(result!.bundles).toHaveLength(1);

    const loaded = await loadBundle(result!.bundles[0]!.data, 'proj2.zip');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const report = await runValidation(loaded.value);
    // The eight are a frozen persisted contract; ingest asserts the count.
    expect(report.checks).toHaveLength(8);
    // A rolling-sealed scope survives the round trip with its signature and its
    // hash chain intact — the rebuild never touches a signed byte.
    expect(report.checks.find((c) => c.id === 'manifest_sig')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'chain_integrity')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'session_binding')?.status).toBe('pass');
  });

  it('is idempotent: the same upload twice yields byte-identical bundles', async () => {
    // The staged blob's sha256 is the ingest dedup key, so a re-ingest that
    // rebuilt different bytes would create a duplicate submission instead of
    // deduping. Ordered stages plus a deterministic rebuild is the contract.
    const zip = await zipTree(await repoNestedTree());
    const first = await expandRepoZip('repo.zip', zip, DEFAULT);
    const second = await expandRepoZip('repo.zip', zip, DEFAULT);
    expect(first!.bundles.map((b) => b.filename)).toEqual(second!.bundles.map((b) => b.filename));
    for (let i = 0; i < first!.bundles.length; i++) {
      expect(Buffer.from(first!.bundles[i]!.data)).toEqual(Buffer.from(second!.bundles[i]!.data));
    }
    expect(first!.skipped).toEqual(second!.skipped);
  });

  it('reports a .provenance/ that nothing seals as no_seal rather than dropping it', async () => {
    const files = new Map<string, Uint8Array>();
    await layScope(files, 'proj2/', 'proj2');
    files.set('lab5/.provenance/notes.txt', new TextEncoder().encode('not a seal'));
    const result = await expandRepoZip('repo.zip', await zipTree(files), DEFAULT);
    expect(result!.bundles.map((b) => b.scopePath)).toEqual(['proj2/']);
    expect(result!.skipped).toEqual([{ folderKey: 'repo', scopePath: 'lab5/', reason: 'no_seal' }]);
  });
});

// ---------------------------------------------------------------------------
// 3. Scope discovery is the Gradescope path's, not a second copy
// ---------------------------------------------------------------------------

describe('expandRepoZip — discovery is shared with the Gradescope path', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'prov-repo-zip-'));
  });
  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Run the SAME tree through the Gradescope/local-path streaming reader. */
  async function viaGradescope(
    files: Map<string, Uint8Array>,
    config: IngestScopeConfig,
  ): Promise<StreamedSubmission[]> {
    const root = 'assignment_9100_export/';
    const outer = new JSZip();
    outer.file(`${root}submission_metadata.yml`, REPO_METADATA);
    for (const [name, bytes] of files) outer.file(`${root}submission_repo/${name}`, bytes);
    const zipPath = path.join(tmpDir, `export-${crypto.randomUUID()}.zip`);
    await writeFile(zipPath, await outer.generateAsync({ type: 'nodebuffer' }));

    const opened = await openLocalExport(zipPath, { scopeConfigFor: () => config });
    if (!opened.ok) throw new Error(`openLocalExport failed: ${opened.error}`);
    const seen: StreamedSubmission[] = [];
    for await (const sub of opened.submissions()) seen.push(sub);
    await opened.close();
    return seen;
  }

  const cases: Array<[string, IngestScopeConfig]> = [
    ['self_identifying', DEFAULT_INGEST_SCOPE],
    ['bundle_zip', { mode: 'bundle_zip', on_multiple: 'ingest_all' }],
    ['repo_whole', { mode: 'repo_whole', on_multiple: 'ingest_all' }],
    ['repo_scoped', { mode: 'repo_scoped', path_glob: 'proj2/**', on_multiple: 'ingest_all' }],
  ];

  for (const [name, config] of cases) {
    it(`agrees with openLocalExport under ${name} — same scopes, same reasons, same bytes`, async () => {
      for (const tree of [await repoRootedTree(), await repoNestedTree()]) {
        const mine = await expandRepoZip('repo.zip', await zipTree(tree), resolverFor(config));
        const theirs = await viaGradescope(tree, config);

        expect(mine!.bundles.map((b) => b.scopePath)).toEqual(
          theirs.filter((s) => s.kind === 'bundle').map((s) => s.scopePath),
        );
        expect(mine!.skipped.map((s) => `${s.scopePath}:${s.reason}`)).toEqual(
          theirs
            .filter((s) => s.kind === 'skipped')
            .map((s) => `${s.scopePath}:${s.kind === 'skipped' ? s.reason : ''}`),
        );

        // Byte equality is the part a divergent reimplementation cannot fake:
        // entry selection AND entry order fix the archive's sha256.
        const theirBundles = theirs.filter((s) => s.kind === 'bundle');
        for (let i = 0; i < theirBundles.length; i++) {
          const t = theirBundles[i]!;
          if (t.kind !== 'bundle') continue;
          expect(Buffer.from(mine!.bundles[i]!.data)).toEqual(
            Buffer.from(await zipBundleEntries(t.entries)),
          );
        }
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 4. The declared submission type, and legible failure
// ---------------------------------------------------------------------------

describe('expandRepoZip — declared submission type', () => {
  it('bundle_zip refuses a repo, through the normal skipped channel', async () => {
    const result = await expandRepoZip(
      'repo.zip',
      await zipTree(await repoRootedTree()),
      resolverFor({ mode: 'bundle_zip', on_multiple: 'ingest_all' }),
    );
    expect(result!.bundles).toEqual([]);
    expect(result!.skipped.map((s) => s.reason)).toEqual([
      'submission_type_mismatch',
      'submission_type_mismatch',
    ]);
    // Every skip is attributed to the upload it came from.
    expect(result!.skipped.every((s) => s.folderKey === 'repo')).toBe(true);
  });

  it('repo_whole keeps the root and excludes the nested scope rather than fanning out', async () => {
    const tree = await repoRootedTree();
    const whole = await expandRepoZip(
      'repo.zip',
      await zipTree(tree),
      resolverFor({ mode: 'repo_whole', on_multiple: 'ingest_all' }),
    );
    expect(whole!.bundles.map((b) => b.scopePath)).toEqual(['']);
    expect(whole!.skipped).toEqual([
      { folderKey: 'repo', scopePath: 'vendor/', reason: 'scope_excluded' },
    ]);
    // Contrast: the default would have produced TWO submissions.
    const dflt = await expandRepoZip('repo.zip', await zipTree(tree), DEFAULT);
    expect(dflt!.bundles.map((b) => b.scopePath)).toEqual(['', 'vendor/']);
  });

  it('repo_whole refuses a repo that seals nothing at its root', async () => {
    const result = await expandRepoZip(
      'repo.zip',
      await zipTree(await repoNestedTree()),
      resolverFor({ mode: 'repo_whole', on_multiple: 'ingest_all' }),
    );
    expect(result!.bundles).toEqual([]);
    expect(result!.skipped.map((s) => s.reason)).toEqual([
      'submission_type_mismatch',
      'submission_type_mismatch',
    ]);
  });

  it('repo_scoped ingests only the globbed scope', async () => {
    const result = await expandRepoZip(
      'repo.zip',
      await zipTree(await repoNestedTree()),
      resolverFor({ mode: 'repo_scoped', path_glob: 'proj2/**', on_multiple: 'ingest_all' }),
    );
    expect(result!.bundles.map((b) => b.scopePath)).toEqual(['proj2/']);
    expect(result!.skipped).toEqual([
      { folderKey: 'repo', scopePath: 'lab5/', reason: 'scope_excluded' },
    ]);
  });

  it('repo_scoped whose glob selects nothing fails loudly, never as a silent success', async () => {
    const result = await expandRepoZip(
      'repo.zip',
      await zipTree(await repoNestedTree()),
      resolverFor({ mode: 'repo_scoped', path_glob: 'proj3/**', on_multiple: 'ingest_all' }),
    );
    expect(result!.bundles).toEqual([]);
    expect(result!.skipped.map((s) => s.reason)).toContain('submission_type_mismatch');
  });

  it("on_multiple:'error' refuses two scopes that declare the same assignment id", async () => {
    const files = new Map<string, Uint8Array>();
    await layScope(files, 'proj2/', 'proj2');
    await layScope(files, 'stale-copy/', 'proj2');
    const result = await expandRepoZip(
      'repo.zip',
      await zipTree(files),
      resolverFor({ mode: 'self_identifying', on_multiple: 'error' }),
    );
    expect(result!.bundles).toEqual([]);
    expect(result!.skipped.map((s) => s.reason)).toEqual(['ambiguous_scope', 'ambiguous_scope']);
  });
});
