/**
 * Unit tests for git-repo scope RESOLUTION — pure (scopes in, scopes out), no DB.
 *
 * The DISCOVERY half of this suite moved to
 * `analysis-core/src/scopes/discover-scopes.test.ts` along with the code it
 * exercises. What remains is the policy half: which discovered scopes the
 * declared submission type accepts, and how `assignments.ingest_scope` is
 * narrowed.
 *
 * One case still drives both halves together — resolution over scopes recovered
 * from a real rolling-sealed repo tree — because it is the seam between them
 * and a fixture-only `fakeScope` would not exercise it.
 */

import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  discoverRepoScopes,
  type RepoScope,
} from '@provenance/analysis-core/scopes/discover-scopes.js';
import {
  resolveRepoScopes,
  parseIngestScopeConfig,
  DEFAULT_INGEST_SCOPE,
  type IngestScopeConfig,
} from './repo-scopes.js';

const PROVENANCE_FILE =
  /^(manifest\.json|manifest\.sig|manifest-[0-9a-f-]+\.(json|sig)|session-.*\.slog(\.meta)?)$/;

/**
 * Explode a sealed flat bundle into the on-disk shape a submission tree has:
 * provenance files under `<scopeDir>.provenance/`, submission files at
 * `<scopeDir>`. Returns a plain path → bytes map, the adapter's input.
 *
 * `rolling: true` produces a ROLLING-sealed scope (program spec §8): per-session
 * `manifest-<session_id>.json` + `.sig` and NO classic `manifest.json` — i.e.
 * exactly what a git-submitted `.provenance/` looks like.
 */
async function layScope(
  files: Map<string, Uint8Array>,
  scopeDir: string,
  opts: {
    assignmentId: string;
    submissionFiles?: Array<{ path: string; content: string }>;
    rolling?: boolean;
  },
): Promise<void> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId: opts.assignmentId,
    semester: 'fa2026',
    ...(opts.rolling === true && { rollingSeal: {} }),
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

const allDefault = (): IngestScopeConfig => DEFAULT_INGEST_SCOPE;

// ---------------------------------------------------------------------------
// Resolution over scopes discovered from a real repo tree
// ---------------------------------------------------------------------------

describe('resolveRepoScopes — rolling-sealed scopes discovered from a repo tree', () => {
  it('honours on_multiple=error for two rolling scopes declaring the same assignment', async () => {
    const files = new Map<string, Uint8Array>();
    await layScope(files, 'proj2/', { assignmentId: 'proj2', rolling: true });
    await layScope(files, 'vendor/proj2/', { assignmentId: 'proj2', rolling: true });

    const discovered = discoverRepoScopes(files);
    expect(discovered.ok).toBe(true);
    if (!discovered.ok) return;
    expect(discovered.scopes.length).toBe(2);

    const resolved = resolveRepoScopes(discovered.scopes, () => ({
      mode: 'self_identifying',
      on_multiple: 'error',
    }));
    expect(resolved.accepted).toEqual([]);
    expect(resolved.rejected.map((r) => r.reason)).toEqual(['ambiguous_scope', 'ambiguous_scope']);

    // …and path_glob disambiguates them instead of refusing both.
    const byPath = resolveRepoScopes(discovered.scopes, () => ({
      mode: 'repo_scoped',
      path_glob: 'proj2/**',
      on_multiple: 'error',
    }));
    expect(byPath.accepted.map((s) => s.scopePath)).toEqual(['proj2/']);
    expect(byPath.rejected).toEqual([{ scopePath: 'vendor/proj2/', reason: 'scope_excluded' }]);
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

  it('mode=repo_scoped keeps only scopes matching path_glob', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('vendor/proj2/', 'proj2')];
    const config: IngestScopeConfig = {
      mode: 'repo_scoped',
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
        ? { mode: 'repo_scoped', path_glob: 'never/**', on_multiple: 'ingest_all' }
        : DEFAULT_INGEST_SCOPE,
    );
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['proj2/']);
    expect(resolved.rejected).toEqual([{ scopePath: 'lab5/', reason: 'scope_excluded' }]);
  });

  it('matches a bare directory glob as well as an explicit /**', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'proj2')];
    const resolved = resolveRepoScopes(scopes, () => ({
      mode: 'repo_scoped',
      path_glob: 'proj2',
      on_multiple: 'ingest_all',
    }));
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['proj2/']);
  });

  it('a * glob does not cross a path separator', () => {
    const scopes = [fakeScope('a/b/', 'x'), fakeScope('a/', 'x')];
    const resolved = resolveRepoScopes(scopes, () => ({
      mode: 'repo_scoped',
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
      parseIngestScopeConfig({ mode: 'repo_scoped', path_glob: 'proj2/**', on_multiple: 'error' }),
    ).toEqual({ mode: 'repo_scoped', path_glob: 'proj2/**', on_multiple: 'error' });
  });
});

// ---------------------------------------------------------------------------
// Declared submission types + homogeneity (a batch is checked against its
// declaration, and a submission of the wrong shape FAILS)
// ---------------------------------------------------------------------------

const declare = (config: IngestScopeConfig) => (): IngestScopeConfig => config;

describe('resolveRepoScopes — declared submission type: bundle_zip', () => {
  const bundleZip = declare({ mode: 'bundle_zip', on_multiple: 'ingest_all' });

  it('accepts the classic shape: exactly one scope, at the tree root', () => {
    const resolved = resolveRepoScopes([fakeScope('', 'hw1')], bundleZip);
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['']);
    expect(resolved.rejected).toEqual([]);
  });

  it('FAILS a repo: a root scope plus a nested one is not a bundle zip', () => {
    const scopes = [fakeScope('', 'hw1'), fakeScope('lab5/', 'lab5')];
    const resolved = resolveRepoScopes(scopes, bundleZip);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.rejected).toEqual([
      { scopePath: '', reason: 'submission_type_mismatch' },
      { scopePath: 'lab5/', reason: 'submission_type_mismatch' },
    ]);
  });

  it('FAILS a tree whose only scope is nested — a bundle zip seals at its root', () => {
    const resolved = resolveRepoScopes([fakeScope('proj2/', 'proj2')], bundleZip);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.rejected).toEqual([
      { scopePath: 'proj2/', reason: 'submission_type_mismatch' },
    ]);
  });

  it('fails exactly what self_identifying would have accepted — the declaration is the difference', () => {
    // Same input, same discovery; only the declaration differs. That is the
    // whole point: heterogeneity is invisible without one.
    const scopes = [fakeScope('', 'hw1'), fakeScope('lab5/', 'lab5')];
    expect(resolveRepoScopes(scopes, allDefault).accepted).toHaveLength(2);
    expect(resolveRepoScopes(scopes, bundleZip).accepted).toHaveLength(0);
  });
});

describe('resolveRepoScopes — declared submission type: repo_whole', () => {
  const repoWhole = declare({ mode: 'repo_whole', on_multiple: 'ingest_all' });

  it('treats the repo as ONE scope: keeps the root, excludes every nested scope', () => {
    const scopes = [fakeScope('', 'proj2'), fakeScope('vendor/', 'lab5')];
    const resolved = resolveRepoScopes(scopes, repoWhole);
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['']);
    // Excluded by declaration, not a mismatch — a repo may legitimately vendor
    // another sealed scope; it just is not a second submission.
    expect(resolved.rejected).toEqual([{ scopePath: 'vendor/', reason: 'scope_excluded' }]);
  });

  it('FAILS a repo with no root scope — that shape is repo_scoped, not whole', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    const resolved = resolveRepoScopes(scopes, repoWhole);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.rejected).toEqual([
      { scopePath: 'proj2/', reason: 'submission_type_mismatch' },
      { scopePath: 'lab5/', reason: 'submission_type_mismatch' },
    ]);
  });

  it('collapses a many-scope repo to one submission, where self_identifying fans out', () => {
    const scopes = [fakeScope('', 'proj2'), fakeScope('a/', 'x'), fakeScope('b/', 'y')];
    expect(resolveRepoScopes(scopes, allDefault).accepted).toHaveLength(3);
    expect(resolveRepoScopes(scopes, repoWhole).accepted).toHaveLength(1);
  });
});

describe('resolveRepoScopes — declared submission type: repo_scoped', () => {
  const scoped = (glob: string) =>
    declare({ mode: 'repo_scoped', path_glob: glob, on_multiple: 'ingest_all' });

  it('selects the globbed scope and excludes the rest', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    const resolved = resolveRepoScopes(scopes, scoped('proj2/**'));
    expect(resolved.accepted.map((s) => s.scopePath)).toEqual(['proj2/']);
    expect(resolved.rejected).toEqual([{ scopePath: 'lab5/', reason: 'scope_excluded' }]);
  });

  it('FAILS when the glob selects NOTHING, rather than quietly ingesting zero', () => {
    // The mutation this catches: a typo'd glob silently dropping a whole cohort
    // while the ingest still reports success.
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    const resolved = resolveRepoScopes(scopes, scoped('proj3/**'));
    expect(resolved.accepted).toEqual([]);
    expect(resolved.rejected).toContainEqual({ scopePath: '', reason: 'submission_type_mismatch' });
    // The per-scope detail survives alongside it — two distinct true facts.
    expect(resolved.rejected).toContainEqual({ scopePath: 'proj2/', reason: 'scope_excluded' });
    expect(resolved.rejected).toContainEqual({ scopePath: 'lab5/', reason: 'scope_excluded' });
  });

  it('does not fire the mismatch when the glob DID select something', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    const resolved = resolveRepoScopes(scopes, scoped('proj2/**'));
    expect(resolved.rejected.map((r) => r.reason)).not.toContain('submission_type_mismatch');
  });

  it('also fails when on_multiple=error consumed every candidate', () => {
    const scopes = [fakeScope('a/', 'proj2'), fakeScope('b/', 'proj2')];
    const resolved = resolveRepoScopes(
      scopes,
      declare({ mode: 'repo_scoped', path_glob: '*/', on_multiple: 'error' }),
    );
    expect(resolved.accepted).toEqual([]);
    expect(resolved.rejected).toContainEqual({ scopePath: '', reason: 'submission_type_mismatch' });
  });
});

describe('resolveRepoScopes — self_identifying asserts nothing (back-compat)', () => {
  it('never emits submission_type_mismatch, whatever the tree looks like', () => {
    const shapes: RepoScope[][] = [
      [fakeScope('', 'hw1')],
      [fakeScope('proj2/', 'proj2')],
      [fakeScope('', 'hw1'), fakeScope('a/b/', 'x'), fakeScope('c/', 'y')],
      [],
    ];
    for (const scopes of shapes) {
      const resolved = resolveRepoScopes(scopes, allDefault);
      expect(resolved.rejected.map((r) => r.reason)).not.toContain('submission_type_mismatch');
      expect(resolved.accepted).toHaveLength(scopes.length);
    }
  });

  it('an empty scope list asserts nothing even under a strict declaration', () => {
    // Discovery already reported each unsealed directory as `no_seal`; piling a
    // type mismatch on top would be noise, not information.
    for (const mode of ['bundle_zip', 'repo_whole', 'self_identifying'] as const) {
      const resolved = resolveRepoScopes([], declare({ mode, on_multiple: 'ingest_all' }));
      expect(resolved).toEqual({ accepted: [], rejected: [] });
    }
  });
});

describe('resolveRepoScopes — a per-request override beats the per-assignment default', () => {
  it('the override resolver ignores the assignment key and wins for every scope', () => {
    const scopes = [fakeScope('', 'hw1'), fakeScope('lab5/', 'lab5')];

    // The per-assignment defaults accept both (each assignment self-identifies).
    expect(resolveRepoScopes(scopes, allDefault).accepted).toHaveLength(2);

    // The override declares bundle_zip for the whole batch, and this tree is a
    // repo — so it fails, where the defaults would have ingested it.
    const override = declare({ mode: 'bundle_zip', on_multiple: 'ingest_all' });
    const resolved = resolveRepoScopes(scopes, override);
    expect(resolved.accepted).toEqual([]);
    expect(resolved.rejected.map((r) => r.reason)).toEqual([
      'submission_type_mismatch',
      'submission_type_mismatch',
    ]);
  });

  it('an override can also RELAX a restrictive persisted default', () => {
    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    const persisted = declare({ mode: 'repo_whole', on_multiple: 'ingest_all' });
    expect(resolveRepoScopes(scopes, persisted).accepted).toEqual([]);

    const override = declare({ mode: 'self_identifying', on_multiple: 'ingest_all' });
    expect(resolveRepoScopes(scopes, override).accepted).toHaveLength(2);
  });
});

describe('resolveRepoScopes — idempotence under every mode', () => {
  it('resolving the same scopes twice yields identical accepted + rejected', () => {
    const configs: IngestScopeConfig[] = [
      { mode: 'self_identifying', on_multiple: 'ingest_all' },
      { mode: 'bundle_zip', on_multiple: 'ingest_all' },
      { mode: 'repo_whole', on_multiple: 'ingest_all' },
      { mode: 'repo_scoped', path_glob: 'proj2/**', on_multiple: 'ingest_all' },
      { mode: 'repo_scoped', path_glob: 'nope/**', on_multiple: 'error' },
    ];
    const scopes = [fakeScope('', 'hw1'), fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    for (const config of configs) {
      const a = resolveRepoScopes(scopes, declare(config));
      const b = resolveRepoScopes(scopes, declare(config));
      expect(a.accepted.map((s) => s.scopePath)).toEqual(b.accepted.map((s) => s.scopePath));
      expect(a.rejected).toEqual(b.rejected);
    }
  });
});

describe("parseIngestScopeConfig — 'path' is the pre-0026 spelling of 'repo_scoped'", () => {
  it('normalizes a legacy row to repo_scoped with the glob and on_multiple intact', () => {
    // This alias, not the 0026 rewrite, is what makes the rename deployable in
    // either order: an un-migrated row must behave exactly as it did before.
    expect(
      parseIngestScopeConfig({ mode: 'path', path_glob: 'proj2/**', on_multiple: 'error' }),
    ).toEqual({ mode: 'repo_scoped', path_glob: 'proj2/**', on_multiple: 'error' });
  });

  it('a legacy path row and a rewritten repo_scoped row resolve identically', () => {
    const legacy = parseIngestScopeConfig({ mode: 'path', path_glob: 'proj2/**' });
    const rewritten = parseIngestScopeConfig({ mode: 'repo_scoped', path_glob: 'proj2/**' });
    expect(legacy).toEqual(rewritten);

    const scopes = [fakeScope('proj2/', 'proj2'), fakeScope('lab5/', 'lab5')];
    expect(resolveRepoScopes(scopes, () => legacy)).toEqual(
      resolveRepoScopes(scopes, () => rewritten),
    );
  });

  it('accepts the two new modes and ignores a path_glob they cannot use', () => {
    expect(parseIngestScopeConfig({ mode: 'bundle_zip' })).toEqual({
      mode: 'bundle_zip',
      on_multiple: 'ingest_all',
    });
    expect(parseIngestScopeConfig({ mode: 'repo_whole', on_multiple: 'error' })).toEqual({
      mode: 'repo_whole',
      on_multiple: 'error',
    });
    expect(parseIngestScopeConfig({ mode: 'repo_whole', path_glob: 'x/**' })).toEqual({
      mode: 'repo_whole',
      on_multiple: 'ingest_all',
    });
  });

  it('degrades a glob-less repo_scoped rather than making a cohort un-ingestable', () => {
    expect(parseIngestScopeConfig({ mode: 'repo_scoped' })).toEqual(DEFAULT_INGEST_SCOPE);
    expect(parseIngestScopeConfig({ mode: 'repo_scoped', path_glob: '' })).toEqual(
      DEFAULT_INGEST_SCOPE,
    );
  });
});
