import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { matchesScopeEntry, validateScopeEntry, resolvePathRole } from '@provenance/log-core';
import type { ResolvedScope } from '@provenance/log-core';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(here, 'path-scope-vectors.json'), 'utf8')) as {
  match: { path: string; entry: string; expect: boolean }[];
  editorGlobHazards: { cases: { path: string; entry: string; expect: boolean }[] };
  validate: { entry: string; problem: string | null }[];
  role: { path: string; scope: ResolvedScope; expect: string }[];
};

describe('path-scope conformance vectors', () => {
  it.each([...vectors.match, ...vectors.editorGlobHazards.cases])(
    'matchesScopeEntry($path, $entry) === $expect',
    ({ path, entry, expect: want }) => {
      expect(matchesScopeEntry(path, entry)).toBe(want);
    },
  );

  it.each(vectors.validate)('validateScopeEntry($entry) -> $problem', ({ entry, problem }) => {
    expect(validateScopeEntry(entry)?.kind ?? null).toBe(problem);
  });

  it.each(vectors.role)('resolvePathRole($path) === $expect', ({ path, scope, expect: want }) => {
    expect(resolvePathRole(path, scope)).toBe(want);
  });

  it('every vector list is non-empty, so a truncated file cannot pass silently', () => {
    expect(vectors.match.length).toBeGreaterThan(10);
    expect(vectors.editorGlobHazards.cases.length).toBeGreaterThan(0);
    expect(vectors.validate.length).toBeGreaterThan(15);
    expect(vectors.role.length).toBeGreaterThan(4);
  });
});
