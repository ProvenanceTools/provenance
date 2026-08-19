/**
 * Unit tests for the git-repo scope adapter — pure (bytes in, bytes out), no DB.
 *
 * Covers the three shapes S3 must handle:
 *   - a flat Gradescope submission folder (one `.provenance/` at the root) —
 *     must stay byte-for-byte identical to the pre-fan-out behavior, because the
 *     rebuilt archive's sha256 is the Gradescope dedup key;
 *   - a git repo with several assignment directories, each with its own
 *     `.provenance/` — one bundle per scope, carrying that scope's own
 *     relative paths;
 *   - a `.provenance/` with no seal (`manifest.json`), which is the normal
 *     state of a git submission until the rolling seal lands.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { selectBundleEntries, zipBundleEntries } from './build-bundle-zip.js';
import {
  discoverRepoScopes,
  resolveRepoScopes,
  parseIngestScopeConfig,
  DEFAULT_INGEST_SCOPE,
  type IngestScopeConfig,
  type RepoScope,
} from './repo-scopes.js';

const PROVENANCE_FILE = /^(manifest\.json|manifest\.sig|session-.*\.slog(\.meta)?)$/;

/**
 * Explode a sealed flat bundle into the on-disk shape a submission tree has:
 * provenance files under `<scopeDir>.provenance/`, submission files at
 * `<scopeDir>`. Returns a plain path → bytes map, the adapter's input.
 */
async function layScope(
  files: Map<string, Uint8Array>,
  scopeDir: string,
  opts: { assignmentId: string; submissionFiles?: Array<{ path: string; content: string }> },
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId: opts.assignmentId,
    semester: 'fa2026',
    ...(opts.submissionFiles !== undefined && {
      submissionFiles: opts.submissionFiles.map((f) => ({
        path: f.path,
        status: 'present' as const,
        content: f.content,
      })),
    }),
    sessions: [{ eventCount: 3 }],
  });
  const inner = await JSZip.loadAsync(zipBuffer);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    const dest = PROVENANCE_FILE.test(name)
      ? `${scopeDir}.provenance/${name}`
      : `${scopeDir}${name}`;
    files.set(dest, bytes);
  }
}

function scopeByPath(scopes: RepoScope[], scopePath: string): RepoScope {
  const found = scopes.find((s) => s.scopePath === scopePath);
  if (found === undefined) throw new Error(`no scope at ${JSON.stringify(scopePath)}`);
  return found;
}

const allDefault = (): IngestScopeConfig => DEFAULT_INGEST_SCOPE;

// ---------------------------------------------------------------------------
// Regression: the existing flat Gradescope folder must be unchanged
// ---------------------------------------------------------------------------

describe('discoverRepoScopes — flat Gradescope folder (regression)', () => {
  it('produces exactly one root scope whose entries are byte-identical to selectBundleEntries', async () => {
    const files = new Map<string, Uint8Array>();
    await layScope(files, '', {
      assignmentId: 'hw10',
      submissionFiles: [{ path: 'hw10.sql', content: 'SELECT 1;\n' }],
    });
    files.set('.DS_Store', new Uint8Array([0]));

    const legacy = selectBundleEntries(files);
    expect(legacy.ok).toBe(true);
    if (!legacy.ok) return;

    const discovered = discoverRepoScopes(files);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;

    expect(discovered.unusable).toEqual([]);
    expect(discovered.scopes).toHaveLength(1);
    const root = discovered.scopes[0]!;
    expect(root.scopePath).toBe('');
    expect(root.declaredAssignmentId).toBe('hw10');
    expect(root.declaredSemester).toBe('fa2026');

    // Same names, same ORDER, same bytes — the archive sha256 must not move.
    expect(root.entries.map((e) => e.name)).toEqual(legacy.entries.map((e) => e.name));
    for (let i = 0; i < root.entries.length; i++) {
      expect(root.entries[i]!.data).toEqual(legacy.entries[i]!.data);
    }

    const a = Buffer.from(await zipBundleEntries(root.entries));
    const b = Buffer.from(await zipBundleEntries(legacy.entries));
    expect(a.equals(b)).toBe(true);
  });

  it('also handles the legacy fully-flat folder (no .provenance/ prefix)', async () => {
    const files = new Map<string, Uint8Array>();
    const { zipBuffer } = await buildTestBundle({
      assignmentId: 'hw10',
      semester: 'fa2026',
      sessions: [{ eventCount: 2 }],
    });
    const inner = await JSZip.loadAsync(zipBuffer);
    for (const [name, obj] of Object.entries(inner.files)) {
      if (obj.dir) continue;
      files.set(name, await obj.async('uint8array'));
    }

    const discovered = discoverRepoScopes(files);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.scopes.map((s) => s.scopePath)).toEqual(['']);
  });

  it('reports no_manifest for a folder that is not a bundle at all', () => {
    const files = new Map<string, Uint8Array>([['README.md', new TextEncoder().encode('hi')]]);
    const discovered = discoverRepoScopes(files);
    expect(discovered.ok).toBe(false);
    if (discovered.ok) return;
    expect(discovered.reason).toBe('no_manifest');
  });
});

// ---------------------------------------------------------------------------
// Fan-out: several assignment scopes in one repo
// ---------------------------------------------------------------------------

describe('discoverRepoScopes — multi-scope git repo', () => {
  it('finds every .provenance/ at any depth and builds one loadable bundle per scope', async () => {
    const files = new Map<string, Uint8Array>();
    await layScope(files, 'proj2/', {
      assignmentId: 'proj2',
      submissionFiles: [{ path: 'Gitlet.java', content: 'class Gitlet {}\n' }],
    });
    await layScope(files, 'lab5/', {
      assignmentId: 'lab5',
      submissionFiles: [{ path: 'Lab5.java', content: 'class Lab5 {}\n' }],
    });
    files.set('README.md', new TextEncoder().encode('# repo\n'));
    files.set('proj2/.DS_Store', new Uint8Array([0]));

    const discovered = discoverRepoScopes(files);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;

    expect(discovered.unusable).toEqual([]);
    expect(discovered.scopes.map((s) => s.scopePath).sort()).toEqual(['lab5/', 'proj2/']);
    expect(discovered.scopes.map((s) => s.declaredAssignmentId).sort()).toEqual(['lab5', 'proj2']);

    // Each bundle carries ITS OWN scope-relative submission path and loads.
    const proj2 = scopeByPath(discovered.scopes, 'proj2/');
    expect(proj2.entries.map((e) => e.name)).toContain('Gitlet.java');
    expect(proj2.entries.map((e) => e.name)).not.toContain('Lab5.java');
    expect(proj2.entries.map((e) => e.name)).not.toContain('README.md');

    const loaded = await loadBundle(await zipBundleEntries(proj2.entries), 'proj2.zip');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.manifest.assignment_id).toBe('proj2');
  });

  it('does not let an outer scope swallow a nested scope’s .provenance/', async () => {
    const files = new Map<string, Uint8Array>();
    await layScope(files, '', { assignmentId: 'root' });
    await layScope(files, 'vendor/copy/', { assignmentId: 'vendored' });

    const discovered = discoverRepoScopes(files);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.scopes.map((s) => s.scopePath).sort()).toEqual(['', 'vendor/copy/']);

    const root = scopeByPath(discovered.scopes, '');
    expect(root.entries.some((e) => e.name.includes('vendor/'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A scope with no seal
// ---------------------------------------------------------------------------

describe('discoverRepoScopes — unsealed scope', () => {
  it('records a .provenance/ with no manifest.json as no_seal, never dropping it silently', async () => {
    const files = new Map<string, Uint8Array>();
    await layScope(files, 'proj2/', { assignmentId: 'proj2' });
    // A git-submitted scope: session logs, no seal.
    files.set(
      'lab5/.provenance/session-11111111-1111-4111-8111-111111111111.slog',
      new TextEncoder().encode('{}\n'),
    );

    const discovered = discoverRepoScopes(files);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;

    expect(discovered.scopes.map((s) => s.scopePath)).toEqual(['proj2/']);
    expect(discovered.unusable).toEqual([{ scopePath: 'lab5/', reason: 'no_seal' }]);
  });

  it('a repo whose only scope is unsealed still reports it (ok, zero bundles)', () => {
    const files = new Map<string, Uint8Array>([
      [
        '.provenance/session-11111111-1111-4111-8111-111111111111.slog',
        new TextEncoder().encode('{}\n'),
      ],
    ]);
    const discovered = discoverRepoScopes(files);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.scopes).toEqual([]);
    expect(discovered.unusable).toEqual([{ scopePath: '', reason: 'no_seal' }]);
  });
});

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

function fakeScope(scopePath: string, assignmentId: string | null): RepoScope {
  return { scopePath, entries: [], declaredAssignmentId: assignmentId, declaredSemester: null };
}

describe('resolveRepoScopes', () => {
  it('accepts every self-identifying scope by default', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    const resolved = resolveRepoScopes(scopes, allDefault);
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['proj2/', 'lab5/']);
    expect(resolved.rejected).toEqual([]);
  });

  it('mode=path keeps only scopes matching path_glob', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('vendor/proj2/', 'proj2')];
    const config: IngestScopeConfig = {
      mode: 'path',
      path_glob: 'proj2/**',
      on_multiple: 'ingest_all',
    };
    const resolved = resolveRepoScopes(scopes, () => config);
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['proj2/']);
    expect(resolved.rejected).toEqual([{ scopePath: 'vendor/proj2/', reason: 'scope_excluded' }]);
  });

  it('on_multiple=error rejects all scopes declaring the same assignment id', () => {
    const scopes = [fakeScope('a/', 'proj2'), fakeScope('b/', 'proj2'), fakeScope('c/', 'lab5')];
    const config: IngestScopeConfig = { mode: 'self_identifying', on_multiple: 'error' };
    const resolved = resolveRepoScopes(scopes, () => config);
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['c/']);
    expect(resolved.rejected).toEqual([
      { scopePath: 'a/', reason: 'ambiguous_scope' },
      { scopePath: 'b/', reason: 'ambiguous_scope' },
    ]);
  });

  it('on_multiple only fires within one assignment id, not across the repo', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    const config: IngestScopeConfig = { mode: 'self_identifying', on_multiple: 'error' };
    const resolved = resolveRepoScopes(scopes, () => config);
    expect(resolved.accepted).toHaveLength(2);
    expect(resolved.rejected).toEqual([]);
  });

  it('looks the config up per declared assignment id', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    const resolved = resolveRepoScopes(scopes, (id) =>
      id === 'lab5'
        ? { mode: 'path', path_glob: 'never/**', on_multiple: 'ingest_all' }
        : DEFAULT_INGEST_SCOPE,
    );
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['proj2/']);
    expect(resolved.rejected).toEqual([{ scopePath: 'lab5/', reason: 'scope_excluded' }]);
  });

  it('matches a bare directory glob as well as an explicit /**', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'proj2')];
    const resolved = resolveRepoScopes(scopes, () => ({
      mode: 'path',
      path_glob: 'proj2',
      on_multiple: 'ingest_all',
    }));
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['proj2/']);
  });

  it('a * glob does not cross a path separator', () => {
    const scopes = [fakeScope('a/b/', 'x'), fakeScope('a/', 'x')];
    const resolved = resolveRepoScopes(scopes, () => ({
      mode: 'path',
      path_glob: '*/',
      on_multiple: 'ingest_all',
    }));
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['a/']);
  });
});

describe('parseIngestScopeConfig', () => {
  it('falls back to the default for anything unrecognized', () => {
    expect(parseIngestScopeConfig(null)).toEqual(DEFAULT_INGEST_SCOPE);
    expect(parseIngestScopeConfig({})).toEqual(DEFAULT_INGEST_SCOPE);
    expect(parseIngestScopeConfig({ mode: 'nonsense' })).toEqual(DEFAULT_INGEST_SCOPE);
    expect(parseIngestScopeConfig({ mode: 'path' })).toEqual({
      mode: 'self_identifying',
      on_multiple: 'ingest_all',
    });
  });

  it('accepts a well-formed override', () => {
    expect(
      parseIngestScopeConfig({ mode: 'path', path_glob: 'proj2/**', on_multiple: 'error' }),
    ).toEqual({ mode: 'path', path_glob: 'proj2/**', on_multiple: 'error' });
  });
});
