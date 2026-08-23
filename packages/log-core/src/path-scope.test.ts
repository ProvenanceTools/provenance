import { describe, it, expect } from 'vitest';
import {
  validateScopeEntry,
  isExactEntry,
  matchesScopeEntry,
  matchesAnyScopeEntry,
  isHardExcluded,
  resolvePathRole,
} from './path-scope.js';
import type { ResolvedScope } from './path-scope.js';

describe('matchesScopeEntry', () => {
  it('exact form matches only the identical path', () => {
    expect(matchesScopeEntry('Makefile', 'Makefile')).toBe(true);
    expect(matchesScopeEntry('src/Makefile', 'Makefile')).toBe(false);
    expect(matchesScopeEntry('Makefile2', 'Makefile')).toBe(false);
  });

  it('directory form matches everything beneath it, recursively', () => {
    expect(matchesScopeEntry('src/Main.java', 'src/')).toBe(true);
    expect(matchesScopeEntry('src/util/deep/A.java', 'src/')).toBe(true);
    expect(matchesScopeEntry('src', 'src/')).toBe(false);
    expect(matchesScopeEntry('srcx/A.java', 'src/')).toBe(false);
  });

  it('suffix form matches at any depth', () => {
    expect(matchesScopeEntry('Main.java', '*.java')).toBe(true);
    expect(matchesScopeEntry('src/util/Main.java', '*.java')).toBe(true);
    expect(matchesScopeEntry('Main.javax', '*.java')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(matchesScopeEntry('Main.JAVA', '*.java')).toBe(false);
    expect(matchesScopeEntry('SRC/A.java', 'src/')).toBe(false);
  });
});

describe('isExactEntry', () => {
  it('is true only for the exact form', () => {
    expect(isExactEntry('Makefile')).toBe(true);
    expect(isExactEntry('src/Main.java')).toBe(true);
    expect(isExactEntry('src/')).toBe(false);
    expect(isExactEntry('*.java')).toBe(false);
  });
});

describe('matchesAnyScopeEntry', () => {
  it('is false for an empty list and true on any hit', () => {
    expect(matchesAnyScopeEntry('a.java', [])).toBe(false);
    expect(matchesAnyScopeEntry('a.java', ['*.py', '*.java'])).toBe(true);
  });
});

describe('validateScopeEntry', () => {
  it('accepts the three legal forms', () => {
    expect(validateScopeEntry('Makefile')).toBeNull();
    expect(validateScopeEntry('src/util/Main.java')).toBeNull();
    expect(validateScopeEntry('src/')).toBeNull();
    expect(validateScopeEntry('*.java')).toBeNull();
  });

  it('rejects empty and surrounding whitespace', () => {
    expect(validateScopeEntry('')?.kind).toBe('empty');
    expect(validateScopeEntry(' src/')?.kind).toBe('whitespace');
    expect(validateScopeEntry('Makefile ')?.kind).toBe('whitespace');
  });

  it('rejects backslashes so Windows spellings never reach the signed payload', () => {
    expect(validateScopeEntry('src\\Main.java')?.kind).toBe('backslash');
  });

  it('rejects absolute paths in both spellings', () => {
    expect(validateScopeEntry('/etc/passwd')?.kind).toBe('absolute');
    expect(validateScopeEntry('C:/Users/a')?.kind).toBe('absolute');
  });

  it('rejects dot and empty segments', () => {
    expect(validateScopeEntry('../secrets')?.kind).toBe('dot_segment');
    expect(validateScopeEntry('src/../etc')?.kind).toBe('dot_segment');
    expect(validateScopeEntry('./src/')?.kind).toBe('dot_segment');
    expect(validateScopeEntry('src//a.java')?.kind).toBe('empty_segment');
  });

  it('rejects every wildcard shape but a single leading star', () => {
    expect(validateScopeEntry('src/*.java')?.kind).toBe('bad_wildcard');
    expect(validateScopeEntry('**/a.java')?.kind).toBe('bad_wildcard');
    expect(validateScopeEntry('*')?.kind).toBe('bad_wildcard');
  });

  it('rejects a suffix entry that also ends in "/" — legal-looking but dead', () => {
    // `matchesScopeEntry` tests the directory form FIRST, so `*.java/` can only
    // ever match a path literally starting `*.java/`. Accepting it signs a
    // manifest that watches nothing.
    expect(validateScopeEntry('*.java/')?.kind).toBe('bad_wildcard');
    expect(validateScopeEntry('*/')?.kind).toBe('bad_wildcard');
    expect(matchesScopeEntry('src/Main.java', '*.java/')).toBe(false);
  });

  it('rejects glob metacharacters we do not implement', () => {
    expect(validateScopeEntry('a?.java')?.kind).toBe('forbidden_char');
    expect(validateScopeEntry('a[0-9].java')?.kind).toBe('forbidden_char');
    expect(validateScopeEntry('{a,b}.java')?.kind).toBe('forbidden_char');
  });

  it('rejects a bare slash', () => {
    expect(validateScopeEntry('/')?.kind).toBe('absolute');
  });
});

describe('isHardExcluded', () => {
  it('excludes the provenance and git directories and the manifest itself', () => {
    expect(isHardExcluded('.provenance/manifest.json')).toBe(true);
    expect(isHardExcluded('.provenance/s1.slog')).toBe(true);
    expect(isHardExcluded('.git/config')).toBe(true);
    expect(isHardExcluded('.provenance-manifest')).toBe(true);
    expect(isHardExcluded('provenance-manifest')).toBe(true);
  });

  it('does not exclude ordinary files with similar names', () => {
    expect(isHardExcluded('provenance-notes.md')).toBe(false);
    expect(isHardExcluded('src/.provenance-helper.ts')).toBe(false);
  });
});

describe('resolvePathRole', () => {
  const scope: ResolvedScope = {
    track: ['src/', 'Makefile'],
    ignore: ['*.class', 'src/generated/'],
    attachments: ['logs/', '*.log'],
  };

  it('hard exclusion beats every course list', () => {
    const greedy: ResolvedScope = { track: ['*.json'], ignore: [], attachments: ['*.json'] };
    expect(resolvePathRole('.provenance/manifest.json', greedy)).toBe('excluded');
  });

  it('ignore beats attachments and track', () => {
    expect(resolvePathRole('src/A.class', scope)).toBe('ignored');
    expect(resolvePathRole('src/generated/G.java', scope)).toBe('ignored');
  });

  it('attachments beat track', () => {
    const overlap: ResolvedScope = { track: ['src/'], ignore: [], attachments: ['src/build.log'] };
    expect(resolvePathRole('src/build.log', overlap)).toBe('attachment');
  });

  it('tracks what only the track list matches', () => {
    expect(resolvePathRole('src/Main.java', scope)).toBe('reviewed');
    expect(resolvePathRole('Makefile', scope)).toBe('reviewed');
  });

  it('leaves anything unmatched unscoped', () => {
    expect(resolvePathRole('README.md', scope)).toBe('unscoped');
  });
});
