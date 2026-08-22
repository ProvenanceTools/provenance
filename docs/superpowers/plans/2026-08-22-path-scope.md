# Path Scope Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a course-signed manifest name a folder or suffix instead of only exact files, exclude files from capture entirely, and carry files into the bundle without capturing them.

**Architecture:** One tiny matcher in `log-core` (three entry forms, no glob engine) is the single authority on whether a path is in scope. Every other layer — recorder registry, filesystem watchers, seal, analyzer coverage, staff composer — calls it and nothing else. Two new required fields in the Manifest 2.0 signed payload (`ignore`, `attachments`) carry the lists; two additive optional fields on `BundleManifest` (`role`, `scope_capped`) carry what the recorder actually did.

**Tech Stack:** TypeScript (strict), Vitest, React + Vite (analyzer), VS Code extension API (recorder), ed25519 via `@noble/ed25519`, JCS via `canonicalize`.

**Spec:** [`docs/superpowers/specs/2026-08-22-path-scope-design.md`](../specs/2026-08-22-path-scope-design.md)

## Global Constraints

- **Scope of this plan is the `provenance` monorepo only.** Spec worklist items 9 and 10 (provjet/Kotlin, provnvim/Lua) live in separate repos and get their own plans. Task 3's vector file is the handoff artifact for both.
- **`log-core` has zero runtime dependencies on VS Code, Node APIs, or the DOM.** An ESLint `no-restricted-imports` rule rejects `vscode`, `node:*`, `fs`, `path`, `worker_threads`, `crypto` in `packages/log-core/**/*.ts`. `path-scope.ts` is pure string manipulation — no imports at all beyond `./result.js` if needed.
- **Never change the 1.x manifest signed payload.** `buildSignedPayload`'s 1.x branch must stay byte-identical. `manifest.test.ts` pins this ("1.0 signed payload is byte-identical to the pre-2.0 bytes"). If that test fails, you broke every archived submission.
- **`EXPECTED_CONTENT_MAX_FILES = 512`** and **`FILE_SCOPE_MAX_ENTRIES = 4096`** are writer-contract constants. All three recorders must use the same numbers.
- **Hard-exclude set:** prefixes `.provenance/`, `.git/`; exact `.provenance-manifest`, `provenance-manifest`.
- **Entry forms:** exact path, trailing-`/` directory prefix, leading-`*` suffix. Nothing else. No `**`, `?`, `[`, `]`, `{`, `}`, negation.
- **Matching is byte-exact and case-sensitive.** Never normalize separators or resolve `.` segments at match time.
- **Commits:** `git commit --no-gpg-sign`, conventional-commit prefix, **no** `Co-Authored-By` trailer, and **always an explicit pathspec** (`git commit ... -- path/one path/two`). The working tree routinely holds unrelated in-flight work.
- **Never run the full `npm run test`.** Scope to the touched workspace: `npm run test --workspace=packages/<name>`.
- **Never `git stash`.** `refs/stash` is repo-wide, not per-worktree.

## Deviation from the spec

**Spec §9.2 is implemented at the writer, not the reader.** The spec places
"the absent-at-seal finding fires only for exact-path entries" under §6
(analyzer). This plan puts it in Task 7 (`seal.ts`) instead, because the seal is
the only place that knows which entries were exact: by the time
`verify-submitted-code.ts` sees a `submission_files` entry it has a path and a
status, not the entry that produced it, so a reader-side fix would have to
re-derive the manifest's entry grammar to answer a question the writer already
knew. Seal never emits a `missing` entry for a rule match, so the reader needs
no change at all. Task 7 step 5 carries the regression test.

Everything else follows the spec as written.

---

### Task 1: The matcher (`log-core/path-scope.ts`)

**Files:**

- Create: `packages/log-core/src/path-scope.ts`
- Create: `packages/log-core/src/path-scope.test.ts`
- Modify: `packages/log-core/src/index.ts` (add export block near the `policy.js` block at ~line 158)

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type ScopeEntryProblem = { kind: 'empty' | 'whitespace' | 'backslash' | 'absolute' | 'dot_segment' | 'empty_segment' | 'bad_wildcard' | 'forbidden_char'; detail: string }`
  - `function validateScopeEntry(entry: string): ScopeEntryProblem | null`
  - `function isExactEntry(entry: string): boolean`
  - `function matchesScopeEntry(path: string, entry: string): boolean`
  - `function matchesAnyScopeEntry(path: string, entries: readonly string[]): boolean`
  - `function isHardExcluded(path: string): boolean`
  - `type ResolvedScope = { readonly track: readonly string[]; readonly ignore: readonly string[]; readonly attachments: readonly string[] }`
  - `type PathRole = 'excluded' | 'ignored' | 'attachment' | 'reviewed' | 'unscoped'`
  - `function resolvePathRole(path: string, scope: ResolvedScope): PathRole`
  - `const HARD_EXCLUDED_PREFIXES: readonly string[]`, `const HARD_EXCLUDED_PATHS: readonly string[]`

- [ ] **Step 1: Write the failing test**

Create `packages/log-core/src/path-scope.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/log-core -- path-scope`
Expected: FAIL — `Failed to resolve import "./path-scope.js"`.

- [ ] **Step 3: Write the implementation**

Create `packages/log-core/src/path-scope.ts`:

```ts
/**
 * Path scope — the ONLY matcher that decides whether a path is in scope.
 *
 * Design spec: `docs/superpowers/specs/2026-08-22-path-scope-design.md` §3.
 * Answers `2026-08-19-git-collaboration-semantics.md` §8.7 / S25.
 *
 * ## Why three forms and not a glob
 *
 * This rule is re-implemented by hand in Kotlin (provjet) and Lua (provnvim).
 * A real glob engine written three times is three chances for the same manifest
 * to watch different files on different editors, which is the divergence risk
 * parent spec §10 exists to prevent. Three forms reduce the matcher to a size
 * a port cannot plausibly get wrong, and `tools/path-scope-vectors.json` pins
 * it across all three.
 *
 * ## Why matching is byte-exact
 *
 * No separator normalization, no `.` resolution, no case folding. `wasFileWatched`
 * in `analysis-core` documents the same rule for the same reason: normalizing on
 * one axis would quietly make two recorders' spellings compare equal here and
 * unequal everywhere else. macOS being case-insensitive on disk is a known and
 * accepted consequence — it is exactly the behaviour `files_under_review` has
 * always had.
 *
 * ## The editor glob is never the authority
 *
 * A recorder may hand a directory entry to its editor's file watcher as a coarse
 * pre-filter (`src/` -> `src/**`). It MUST re-check the resulting path here
 * before emitting anything. See the design spec §4.2.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScopeEntryProblem = {
  kind:
    | 'empty'
    | 'whitespace'
    | 'backslash'
    | 'absolute'
    | 'dot_segment'
    | 'empty_segment'
    | 'bad_wildcard'
    | 'forbidden_char';
  /** A complete sentence, safe to show staff in the composer. */
  detail: string;
};

/** The three course-signed lists, already extracted from a manifest. */
export type ResolvedScope = {
  readonly track: readonly string[];
  readonly ignore: readonly string[];
  readonly attachments: readonly string[];
};

/**
 * What the recorder does with a path. Ordered by the precedence in §3.4:
 * excluded > ignored > attachment > reviewed > unscoped.
 */
export type PathRole = 'excluded' | 'ignored' | 'attachment' | 'reviewed' | 'unscoped';

// ---------------------------------------------------------------------------
// Hard exclusions — not course-controllable
// ---------------------------------------------------------------------------

/**
 * Never in scope, whatever the manifest says.
 *
 * With exact-path lists this came for free: nobody lists their own provenance
 * directory. With rules it does not — `ignore: ["*.json"]` would otherwise reach
 * `.provenance/manifest.json`, and a broad `attachments` entry would seal the
 * log directory into itself.
 */
export const HARD_EXCLUDED_PREFIXES: readonly string[] = ['.provenance/', '.git/'];

export const HARD_EXCLUDED_PATHS: readonly string[] = [
  '.provenance-manifest',
  'provenance-manifest',
];

export function isHardExcluded(path: string): boolean {
  for (const p of HARD_EXCLUDED_PREFIXES) {
    if (path.startsWith(p)) return true;
  }
  return HARD_EXCLUDED_PATHS.includes(path);
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** True iff `entry` is the exact-path form (neither directory nor suffix). */
export function isExactEntry(entry: string): boolean {
  return !entry.endsWith('/') && !entry.startsWith('*');
}

/**
 * The whole matching rule. Assumes `entry` has already passed
 * {@link validateScopeEntry} — a malformed entry is rejected at manifest parse
 * time, so it never reaches here.
 */
export function matchesScopeEntry(path: string, entry: string): boolean {
  if (entry.endsWith('/')) return path.startsWith(entry);
  if (entry.startsWith('*')) return path.endsWith(entry.slice(1));
  return path === entry;
}

export function matchesAnyScopeEntry(path: string, entries: readonly string[]): boolean {
  for (const entry of entries) {
    if (matchesScopeEntry(path, entry)) return true;
  }
  return false;
}

/** Precedence chain, §3.4. First match wins. */
export function resolvePathRole(path: string, scope: ResolvedScope): PathRole {
  if (isHardExcluded(path)) return 'excluded';
  if (matchesAnyScopeEntry(path, scope.ignore)) return 'ignored';
  if (matchesAnyScopeEntry(path, scope.attachments)) return 'attachment';
  if (matchesAnyScopeEntry(path, scope.track)) return 'reviewed';
  return 'unscoped';
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const FORBIDDEN_CHARS = ['?', '[', ']', '{', '}'];

/**
 * Everything wrong with one entry, or null if it is legal.
 *
 * Runs at manifest PARSE time and rejects the manifest. A malformed entry is a
 * staff error that must be caught before a manifest is distributed to a class,
 * not a runtime surprise diagnosed weeks later.
 */
export function validateScopeEntry(entry: string): ScopeEntryProblem | null {
  if (entry.length === 0) {
    return { kind: 'empty', detail: 'An entry may not be empty.' };
  }
  if (entry !== entry.trim()) {
    return {
      kind: 'whitespace',
      detail:
        'An entry may not begin or end with whitespace. A trailing space is invisible here and ' +
        'produces an entry that matches nothing.',
    };
  }
  if (entry.includes('\\')) {
    return {
      kind: 'backslash',
      detail: 'Use forward slashes. A backslash never matches, on any platform.',
    };
  }
  if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry)) {
    return {
      kind: 'absolute',
      detail: 'An entry must be relative to the folder holding the manifest.',
    };
  }

  const starCount = (entry.match(/\*/g) ?? []).length;
  if (starCount > 1 || (starCount === 1 && !entry.startsWith('*'))) {
    return {
      kind: 'bad_wildcard',
      detail:
        'The only wildcard is a single leading "*", which matches a filename suffix at any ' +
        'depth (e.g. "*.java"). There is no "**" and no mid-path wildcard.',
    };
  }
  if (entry === '*') {
    return { kind: 'bad_wildcard', detail: 'A leading "*" must be followed by a suffix.' };
  }

  for (const c of FORBIDDEN_CHARS) {
    if (entry.includes(c)) {
      return {
        kind: 'forbidden_char',
        detail: `"${c}" is not supported. The only forms are an exact path, a "dir/" prefix, and a leading "*" suffix.`,
      };
    }
  }

  // Segment checks run on the path part only, so a leading "*" is not mistaken
  // for a segment. A directory entry's trailing "/" produces a final empty
  // segment that is legal, so it is dropped before checking.
  const pathPart = entry.startsWith('*') ? entry.slice(1) : entry;
  const segments = (pathPart.endsWith('/') ? pathPart.slice(0, -1) : pathPart).split('/');
  for (const seg of segments) {
    if (seg === '.' || seg === '..') {
      return {
        kind: 'dot_segment',
        detail: 'An entry may not contain a "." or ".." segment.',
      };
    }
    if (seg.length === 0) {
      return { kind: 'empty_segment', detail: 'An entry may not contain an empty path segment.' };
    }
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/log-core -- path-scope`
Expected: PASS, all cases.

Note: `validateScopeEntry('/')` must report `absolute` — the `startsWith('/')` check runs before segment checks, so it does. The test asserts this explicitly.

- [ ] **Step 5: Export from the barrel**

In `packages/log-core/src/index.ts`, immediately after the `// Capture policy` export block (ends `export type { CapturePolicy, CapturePolicyBlock } from './policy.js';`, ~line 168), add:

```ts
// Path scope (design spec 2026-08-22 §3) — the single matcher for scope entries
export {
  validateScopeEntry,
  isExactEntry,
  matchesScopeEntry,
  matchesAnyScopeEntry,
  isHardExcluded,
  resolvePathRole,
  HARD_EXCLUDED_PREFIXES,
  HARD_EXCLUDED_PATHS,
} from './path-scope.js';
export type { ScopeEntryProblem, ResolvedScope, PathRole } from './path-scope.js';
```

- [ ] **Step 6: Verify types, lint, and the log-core suite**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/log-core`
Expected: all pass. The `no-restricted-imports` rule must not fire — `path-scope.ts` imports nothing.

- [ ] **Step 7: Commit**

```bash
git add packages/log-core/src/path-scope.ts packages/log-core/src/path-scope.test.ts packages/log-core/src/index.ts
git commit --no-gpg-sign -m "feat(log-core): the path-scope matcher, three forms and no glob engine" -- packages/log-core/src/path-scope.ts packages/log-core/src/path-scope.test.ts packages/log-core/src/index.ts
```

---

### Task 2: Manifest 2.0 gains `ignore` and `attachments`

**Files:**

- Modify: `packages/log-core/src/manifest.ts` (`Manifest` type, `buildSignedPayload`, `parseManifestValue`)
- Modify: `packages/log-core/src/manifest.test.ts`

**Interfaces:**

- Consumes: `validateScopeEntry`, `isExactEntry` from Task 1.
- Produces:
  - `Manifest.ignore?: readonly string[]`
  - `Manifest.attachments?: readonly string[]`
  - `function scopeFromManifest(manifest: Manifest): ResolvedScope` — exported from `manifest.ts`, re-exported from the barrel. This is how every downstream consumer gets a `ResolvedScope`; nobody builds one by hand.

- [ ] **Step 1: Write the failing test**

Append to `packages/log-core/src/manifest.test.ts`:

```ts
describe('Manifest 2.0 path scope fields', () => {
  it('requires ignore and attachments on a 2.0 manifest', async () => {
    const m = await buildValid2xManifest(); // existing helper in this file
    const withoutIgnore = { ...m };
    delete (withoutIgnore as Record<string, unknown>)['ignore'];
    const r = parseManifestValue(withoutIgnore);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'invalid_shape', field: 'ignore' });

    const withoutAttachments = { ...m };
    delete (withoutAttachments as Record<string, unknown>)['attachments'];
    const r2 = parseManifestValue(withoutAttachments);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toMatchObject({ kind: 'invalid_shape', field: 'attachments' });
  });

  it('accepts empty arrays as the explicit "not used" spelling', async () => {
    const m = await buildValid2xManifest();
    const r = parseManifestValue({ ...m, ignore: [], attachments: [] });
    expect(r.ok).toBe(true);
  });

  it('rejects a malformed entry in any of the three lists', async () => {
    const m = await buildValid2xManifest();
    for (const field of ['files_under_review', 'ignore', 'attachments'] as const) {
      const r = parseManifestValue({ ...m, [field]: ['../escape'] });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ kind: 'invalid_shape', field });
    }
  });

  it('accepts the new entry forms at 2.0', async () => {
    const m = await buildValid2xManifest();
    const r = parseManifestValue({
      ...m,
      files_under_review: ['src/', 'Makefile', '*.java'],
      ignore: ['*.class', 'target/'],
      attachments: ['logs/'],
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a directory-shaped entry at 1.x rather than rejecting it', () => {
    // 1.x parsing must NEVER reject: archived submissions have to validate for
    // years. At 1.x "src/" simply means a file named "src/", which matches
    // nothing — exactly the pre-2.0 behaviour.
    const legacy = {
      assignment_id: 'a',
      semester: 'fa26',
      issued_at: '2026-01-01T00:00:00Z',
      files_under_review: ['src/', '*.java', '../escape'],
      sig: 'a'.repeat(128),
    };
    const r = parseManifestValue(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.files_under_review).toEqual(['src/', '*.java', '../escape']);
  });

  it('scopeFromManifest reads the three lists, defaulting 1.x to empty', () => {
    const legacy = {
      assignment_id: 'a',
      semester: 'fa26',
      issued_at: '2026-01-01T00:00:00Z',
      files_under_review: ['Main.java'],
      sig: 'a'.repeat(128),
    };
    const parsed = parseManifestValue(legacy);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(scopeFromManifest(parsed.value)).toEqual({
      track: ['Main.java'],
      ignore: [],
      attachments: [],
    });
  });
});
```

Add `scopeFromManifest` to the existing import from `./manifest.js` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/log-core -- manifest`
Expected: FAIL — `scopeFromManifest` is not exported; the required-field tests pass a manifest that currently parses fine.

If `buildValid2xManifest` does not exist under that exact name in `manifest.test.ts`, use whatever the file's existing 2.0 fixture helper is named and keep the same shape; do not invent a second fixture.

- [ ] **Step 3: Add the type fields**

In `packages/log-core/src/manifest.ts`, inside `export type Manifest`, after the `policy?: CapturePolicyBlock;` field:

```ts
  /**
   * Paths the recorder must NOT capture at all (design spec §3, §3.4).
   *
   * Inside the signed payload for the same reason `policy` is: a professor can
   * narrow capture, a student cannot. An entry here means no events are
   * produced for those paths — INCLUDING exculpatory ones, which is why the
   * composer says so in as many words.
   */
  ignore?: readonly string[];
  /**
   * Paths sealed into the bundle and hashed, but never captured (design spec §3).
   *
   * An attachment has no event provenance by definition, so check 8 must not
   * compare it against reconstruction — see `verify-submitted-code.ts`.
   */
  attachments?: readonly string[];
```

- [ ] **Step 4: Add both keys to the 2.0 signed payload**

In `buildSignedPayload`, the 2.0 branch only. Add `ignore` and `attachments` to the `canonicalize({...})` object:

```ts
const payload = canonicalize({
  format_version: MANIFEST_FORMAT_VERSION_2,
  course_id: manifest.course_id,
  assignment_id: manifest.assignment_id,
  semester: manifest.semester,
  issued_at: manifest.issued_at,
  files_under_review: manifest.files_under_review,
  ignore: manifest.ignore,
  attachments: manifest.attachments,
  collaboration: manifest.collaboration,
  submission: manifest.submission,
  scope: manifest.scope,
  policy: manifest.policy,
});
```

**Do not touch the 1.x branch below it.** JCS sorts keys, so the literal order above has no effect on output.

- [ ] **Step 5: Validate the lists in `parseManifestValue`**

Add this helper above `parseManifestValue` in `manifest.ts`:

```ts
/**
 * Validate one scope list. Used for all three at 2.0.
 *
 * At 1.x this is NOT called: 1.x parsing must never reject (see the module
 * docstring), and a 1.x manifest's entries carry exact-path meaning regardless
 * of how they are spelled.
 */
function checkScopeList(value: unknown, field: string): ManifestError | null {
  if (!Array.isArray(value)) {
    return { kind: 'invalid_shape', field, reason: 'must be an array' };
  }
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string') {
      return { kind: 'invalid_shape', field, reason: 'all elements must be strings' };
    }
    const problem = validateScopeEntry(entry);
    if (problem !== null) {
      return { kind: 'invalid_shape', field, reason: `"${entry}": ${problem.detail}` };
    }
  }
  return null;
}
```

Import `validateScopeEntry` at the top of `manifest.ts`:

```ts
import { validateScopeEntry } from './path-scope.js';
```

In `parseManifestValue`, inside the `// --- 2.0-only fields, all required ---` block (after the `course_id` check, before `enumField`), add:

```ts
const ignoreProblem = checkScopeList(obj['ignore'], 'ignore');
if (ignoreProblem !== null) return err(ignoreProblem);
const attachmentsProblem = checkScopeList(obj['attachments'], 'attachments');
if (attachmentsProblem !== null) return err(attachmentsProblem);
// files_under_review already passed the array/string check in the shared
// section above; at 2.0 its entries must also satisfy the entry grammar.
const trackProblem = checkScopeList(obj['files_under_review'], 'files_under_review');
if (trackProblem !== null) return err(trackProblem);
```

And add both to the returned object in the 2.0 `return ok({...})`:

```ts
    ignore: obj['ignore'] as readonly string[],
    attachments: obj['attachments'] as readonly string[],
```

- [ ] **Step 6: Add `scopeFromManifest`**

Append to `packages/log-core/src/manifest.ts`:

```ts
/**
 * The three scope lists as a {@link ResolvedScope}.
 *
 * The ONLY way a consumer should build one. A 1.x manifest has no `ignore` or
 * `attachments`, so both default to empty — which resolves every path to
 * `'reviewed'` or `'unscoped'` exactly as 1.x always behaved.
 */
export function scopeFromManifest(manifest: Manifest): ResolvedScope {
  return {
    track: manifest.files_under_review,
    ignore: manifest.ignore ?? [],
    attachments: manifest.attachments ?? [],
  };
}
```

Add `ResolvedScope` to the `path-scope.js` type import at the top of `manifest.ts`, and export `scopeFromManifest` from `packages/log-core/src/index.ts` in the manifest export block.

- [ ] **Step 7: Run the tests**

Run: `npm run test --workspace=packages/log-core`
Expected: PASS — **including** the existing `"1.0 signed payload is byte-identical to the pre-2.0 bytes"` test. If that one fails you edited the 1.x branch; revert step 4 and redo it touching only the 2.0 branch.

Existing 2.0 fixtures across the workspace will now fail to parse because they lack the new required fields. Fix them by adding `ignore: []` and `attachments: []` — do **not** make the fields optional to make tests pass. That is the constraint-softening CLAUDE.md forbids.

- [ ] **Step 8: Repair 2.0 fixtures workspace-wide**

Run: `grep -rln "MANIFEST_FORMAT_VERSION_2\|format_version: '2.0'\|\"format_version\": \"2.0\"" --include=*.ts packages/ tools/`

For each hit that constructs a 2.0 manifest — notably `packages/analysis-core/src/test-support/build-manifest-2.ts:103,151` — add `ignore: []` and `attachments: []` (or plumb them through as parameters where the helper already takes `filesUnderReview`).

- [ ] **Step 9: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/log-core && npm run test --workspace=packages/analysis-core`
Expected: all pass.

```bash
git add packages/log-core/src/manifest.ts packages/log-core/src/manifest.test.ts packages/log-core/src/index.ts packages/analysis-core/src/test-support/build-manifest-2.ts
git commit --no-gpg-sign -m "feat(log-core): manifest 2.0 carries ignore and attachments in the signed payload" -- packages/log-core/src/manifest.ts packages/log-core/src/manifest.test.ts packages/log-core/src/index.ts packages/analysis-core/src/test-support/build-manifest-2.ts
```

Add any other fixture files you touched in step 8 to both the `add` and the pathspec.

---

### Task 3: Cross-port conformance vectors

**Files:**

- Create: `tools/path-scope-vectors.json`
- Create: `tools/path-scope-vectors.test.ts`

**Interfaces:**

- Consumes: `matchesScopeEntry`, `validateScopeEntry`, `resolvePathRole` from Task 1.
- Produces: `tools/path-scope-vectors.json` — the handoff artifact for the provjet (Kotlin) and provnvim (Lua) plans. Its shape is a contract; changing it means changing three repos.

- [ ] **Step 1: Write the vector file**

Create `tools/path-scope-vectors.json`:

```json
{
  "comment": "Cross-port conformance vectors for the path-scope matcher. Consumed by packages/log-core (TypeScript), provjet (Kotlin) and provnvim (Lua). Design spec: docs/superpowers/specs/2026-08-22-path-scope-design.md. Changing this file means changing three repos.",
  "match": [
    { "path": "Makefile", "entry": "Makefile", "expect": true },
    { "path": "src/Makefile", "entry": "Makefile", "expect": false },
    { "path": "Makefile2", "entry": "Makefile", "expect": false },
    { "path": "src/Main.java", "entry": "src/", "expect": true },
    { "path": "src/util/deep/A.java", "entry": "src/", "expect": true },
    { "path": "src", "entry": "src/", "expect": false },
    { "path": "srcx/A.java", "entry": "src/", "expect": false },
    { "path": "Main.java", "entry": "*.java", "expect": true },
    { "path": "src/util/Main.java", "entry": "*.java", "expect": true },
    { "path": "Main.javax", "entry": "*.java", "expect": false },
    { "path": "Main.JAVA", "entry": "*.java", "expect": false },
    { "path": "SRC/A.java", "entry": "src/", "expect": false },
    { "path": ".java", "entry": "*.java", "expect": true },
    { "path": "a/b/c/d/e.java", "entry": "a/b/", "expect": true }
  ],
  "editorGlobHazards": {
    "comment": "Paths a permissive editor watcher glob would plausibly deliver but the matcher rejects. A port that emits on its watcher's verdict alone fails here. Design spec §4.2.",
    "cases": [
      { "path": "src", "entry": "src/", "expect": false },
      { "path": "srcextra/A.java", "entry": "src/", "expect": false },
      { "path": "notes.java.bak", "entry": "*.java", "expect": false },
      { "path": "SRC/Main.java", "entry": "src/", "expect": false }
    ]
  },
  "validate": [
    { "entry": "Makefile", "problem": null },
    { "entry": "src/util/Main.java", "problem": null },
    { "entry": "src/", "problem": null },
    { "entry": "*.java", "problem": null },
    { "entry": "", "problem": "empty" },
    { "entry": " src/", "problem": "whitespace" },
    { "entry": "Makefile ", "problem": "whitespace" },
    { "entry": "src\\Main.java", "problem": "backslash" },
    { "entry": "/etc/passwd", "problem": "absolute" },
    { "entry": "C:/Users/a", "problem": "absolute" },
    { "entry": "/", "problem": "absolute" },
    { "entry": "../secrets", "problem": "dot_segment" },
    { "entry": "src/../etc", "problem": "dot_segment" },
    { "entry": "./src/", "problem": "dot_segment" },
    { "entry": "src//a.java", "problem": "empty_segment" },
    { "entry": "src/*.java", "problem": "bad_wildcard" },
    { "entry": "**/a.java", "problem": "bad_wildcard" },
    { "entry": "*", "problem": "bad_wildcard" },
    { "entry": "a?.java", "problem": "forbidden_char" },
    { "entry": "a[0-9].java", "problem": "forbidden_char" },
    { "entry": "{a,b}.java", "problem": "forbidden_char" }
  ],
  "role": [
    {
      "comment": "Hard exclusion beats every course list.",
      "path": ".provenance/manifest.json",
      "scope": { "track": ["*.json"], "ignore": [], "attachments": ["*.json"] },
      "expect": "excluded"
    },
    {
      "comment": "ignore beats attachments beats track.",
      "path": "src/A.class",
      "scope": { "track": ["src/"], "ignore": ["*.class"], "attachments": ["src/"] },
      "expect": "ignored"
    },
    {
      "path": "src/build.log",
      "scope": { "track": ["src/"], "ignore": [], "attachments": ["src/build.log"] },
      "expect": "attachment"
    },
    {
      "path": "src/Main.java",
      "scope": { "track": ["src/"], "ignore": ["*.class"], "attachments": ["logs/"] },
      "expect": "reviewed"
    },
    {
      "path": "README.md",
      "scope": { "track": ["src/"], "ignore": [], "attachments": [] },
      "expect": "unscoped"
    },
    {
      "path": ".git/config",
      "scope": { "track": ["*"], "ignore": [], "attachments": [] },
      "expect": "excluded"
    }
  ]
}
```

Note the last `role` case uses `track: ["*"]`, which `validateScopeEntry` rejects. That is deliberate: `resolvePathRole` does not re-validate, and the vector proves hard exclusion holds even against an entry that should never have been signed.

- [ ] **Step 2: Write the consumer test**

Create `tools/path-scope-vectors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  matchesScopeEntry,
  validateScopeEntry,
  resolvePathRole,
} from '../packages/log-core/src/path-scope.js';
import type { ResolvedScope } from '../packages/log-core/src/path-scope.js';

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
```

- [ ] **Step 3: Run the tools suite**

Run: `npm run test:tools`
Expected: PASS. `tools/` is not an npm workspace, so `npm run test` does **not** cover it — this is the only command that runs these.

- [ ] **Step 4: Commit**

```bash
git add tools/path-scope-vectors.json tools/path-scope-vectors.test.ts
git commit --no-gpg-sign -m "test(tools): cross-port conformance vectors for the path-scope matcher" -- tools/path-scope-vectors.json tools/path-scope-vectors.test.ts
```

---

### Task 4: Live membership in `ExpectedContentRegistry`, with a memory cap

**Files:**

- Modify: `packages/recorder/src/state/expected-content-registry.ts`
- Modify: `packages/recorder/src/state/expected-content-registry.test.ts`

**Interfaces:**

- Consumes: `ResolvedScope`, `resolvePathRole` (Task 1).
- Produces:
  - `new ExpectedContentRegistry(scope: ResolvedScope, opts?: { maxFiles?: number })`
  - `EXPECTED_CONTENT_MAX_FILES = 512`
  - `registry.isWatched(relativePath: string): boolean` — unchanged signature
  - `registry.capHit(): boolean` — new; feeds `scope_capped` in Task 7

- [ ] **Step 1: Write the failing test**

Replace the `isWatched` describe block in `packages/recorder/src/state/expected-content-registry.test.ts` with:

```ts
import {
  ExpectedContentRegistry,
  EXPECTED_CONTENT_MAX_FILES,
} from './expected-content-registry.js';
import type { ResolvedScope } from '@provenance/log-core';

const scope = (over: Partial<ResolvedScope> = {}): ResolvedScope => ({
  track: [],
  ignore: [],
  attachments: [],
  ...over,
});

describe('isWatched', () => {
  it('is true for an exact-path entry', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/foo.py', 'src/bar.py'] }));
    expect(reg.isWatched('src/foo.py')).toBe(true);
    expect(reg.isWatched('src/bar.py')).toBe(true);
  });

  it('is false for paths outside the scope', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/foo.py'] }));
    expect(reg.isWatched('src/other.py')).toBe(false);
    expect(reg.isWatched('')).toBe(false);
  });

  it('admits a file created mid-session under a directory rule', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'] }));
    expect(reg.isWatched('src/written_later.py')).toBe(true);
  });

  it('never watches an ignored path, even inside a tracked folder', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'], ignore: ['*.class'] }));
    expect(reg.isWatched('src/A.class')).toBe(false);
  });

  it('never watches an attachment', () => {
    const reg = new ExpectedContentRegistry(
      scope({ track: ['src/'], attachments: ['src/build.log'] }),
    );
    expect(reg.isWatched('src/build.log')).toBe(false);
  });

  it('never watches a hard-excluded path however greedy the manifest is', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['*.json'] }));
    expect(reg.isWatched('.provenance/manifest.json')).toBe(false);
  });
});

describe('the memory cap', () => {
  it('stops admitting new paths once full, and says so', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'] }), { maxFiles: 2 });
    expect(reg.capHit()).toBe(false);

    expect(reg.isWatched('src/a.py')).toBe(true);
    reg.getOrCreate('src/a.py', '');
    expect(reg.isWatched('src/b.py')).toBe(true);
    reg.getOrCreate('src/b.py', '');

    expect(reg.isWatched('src/c.py')).toBe(false);
    expect(reg.capHit()).toBe(true);
  });

  it('keeps watching paths already admitted after the cap bites', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'] }), { maxFiles: 1 });
    expect(reg.isWatched('src/a.py')).toBe(true);
    reg.getOrCreate('src/a.py', '');
    expect(reg.isWatched('src/b.py')).toBe(false);
    expect(reg.isWatched('src/a.py')).toBe(true);
  });

  it('does not report a cap hit for a path that was never in scope', () => {
    const reg = new ExpectedContentRegistry(scope({ track: ['src/'] }), { maxFiles: 0 });
    expect(reg.isWatched('README.md')).toBe(false);
    expect(reg.capHit()).toBe(false);
  });

  it('defaults to the writer-contract cap', () => {
    expect(EXPECTED_CONTENT_MAX_FILES).toBe(512);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- expected-content-registry`
Expected: FAIL — the constructor takes a string array, and `capHit` / `EXPECTED_CONTENT_MAX_FILES` do not exist.

- [ ] **Step 3: Write the implementation**

Replace `packages/recorder/src/state/expected-content-registry.ts` with:

```ts
/**
 * ExpectedContentRegistry — maps relative file paths to their ExpectedContent
 * instances, for every path the manifest puts under review (PRD §4.5).
 *
 * ## Live membership
 *
 * Membership is a RULE evaluation, not a set lookup (design spec §4.1). A
 * manifest may name a folder, so the watched set is not knowable at session
 * start: a file the student creates ten minutes in is watched from its first
 * keystroke. Snapshotting instead would make "I wrote it in a new file" — which
 * is ordinary, innocent behaviour — produce a silent gap in the record.
 *
 * ## The cap
 *
 * `ExpectedContent` holds full file content per path. Exact-path lists bounded
 * that naturally; a `src/` rule does not. {@link EXPECTED_CONTENT_MAX_FILES} is
 * the bound, and {@link ExpectedContentRegistry.capHit} is how the seal learns
 * it bit. Disclosure is mandatory, not decorative: a session that silently
 * stopped watching files it was told to watch would let the analyzer conclude
 * "in scope, no activity" about a student who did nothing wrong.
 */

import { resolvePathRole } from '@provenance/log-core';
import type { ResolvedScope } from '@provenance/log-core';
import { ExpectedContent } from './expected-content.js';

/**
 * Maximum number of files whose expected content is held in memory.
 *
 * Part of the writer contract: all three recorders must use the same number, or
 * two ports disagree about when a session is capped. Companion to
 * `FILE_SCOPE_MAX_ENTRIES` in `session/recorder-context.ts`.
 */
export const EXPECTED_CONTENT_MAX_FILES = 512;

export class ExpectedContentRegistry {
  private readonly _scope: ResolvedScope;
  private readonly _maxFiles: number;
  private readonly _map = new Map<string, ExpectedContent>();
  private _capHit = false;

  constructor(scope: ResolvedScope, opts?: { maxFiles?: number }) {
    this._scope = scope;
    this._maxFiles = opts?.maxFiles ?? EXPECTED_CONTENT_MAX_FILES;
  }

  /**
   * Whether this path is under review right now.
   *
   * Note the deliberate side effect: a path that WOULD have been admitted but
   * for the cap flips {@link capHit}. That is the only moment the cap is
   * observable, and the fact has to be recorded when it happens rather than
   * inferred later. A path that was never in scope does not set it — the cap
   * did not cost us that file.
   */
  isWatched(relativePath: string): boolean {
    if (this._map.has(relativePath)) return true;
    if (resolvePathRole(relativePath, this._scope) !== 'reviewed') return false;
    if (this._map.size >= this._maxFiles) {
      this._capHit = true;
      return false;
    }
    return true;
  }

  /** True once the cap has refused a path that was otherwise under review. */
  capHit(): boolean {
    return this._capHit;
  }

  /**
   * Get or create the ExpectedContent for a relative path.
   * If the path already exists in the registry, returns the existing instance.
   * If it's new, creates one with initialContent.
   */
  getOrCreate(relativePath: string, initialContent: string): ExpectedContent {
    const existing = this._map.get(relativePath);
    if (existing !== undefined) {
      return existing;
    }
    const ec = new ExpectedContent(initialContent);
    this._map.set(relativePath, ec);
    return ec;
  }

  /** Get the ExpectedContent for a path, or undefined if not tracked. */
  get(relativePath: string): ExpectedContent | undefined {
    return this._map.get(relativePath);
  }

  /** Remove the ExpectedContent entry for a path. */
  delete(relativePath: string): void {
    this._map.delete(relativePath);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- expected-content-registry`
Expected: PASS.

- [ ] **Step 5: Fix the construction sites**

Run: `grep -rn "new ExpectedContentRegistry(" --include=*.ts packages/recorder/src packages/recorder/test`

Each site currently passes `manifest.files_under_review`. Change it to `scopeFromManifest(manifest)`, importing `scopeFromManifest` from `@provenance/log-core`. In tests that build a bare list, use an inline `{ track: [...], ignore: [], attachments: [] }`.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/recorder`
Expected: PASS.

```bash
git add packages/recorder/src/state/expected-content-registry.ts packages/recorder/src/state/expected-content-registry.test.ts
git commit --no-gpg-sign -m "feat(recorder): live scope membership in the expected-content registry, with a memory cap" -- packages/recorder/src/state/expected-content-registry.ts packages/recorder/src/state/expected-content-registry.test.ts
```

Add any construction sites you touched in step 5 to both the `add` and the pathspec.

---

### Task 5: Watcher patterns are a pre-filter, never the authority

**Files:**

- Modify: `packages/recorder/src/wiring/fs-watcher.ts`
- Modify: `packages/recorder/src/wiring/fs-watcher.test.ts`

**Interfaces:**

- Consumes: `ResolvedScope`, `resolvePathRole` (Task 1).
- Produces:
  - `function watcherPatternFor(entry: string): string` — exported for testing
  - `FsWatcherDeps.scope: ResolvedScope` replaces `FsWatcherDeps.filesUnderReview`

- [ ] **Step 1: Write the failing test**

Add to `packages/recorder/src/wiring/fs-watcher.test.ts`:

```ts
import { watcherPatternFor } from './fs-watcher.js';

describe('watcherPatternFor', () => {
  it('widens a directory entry to a recursive editor glob', () => {
    expect(watcherPatternFor('src/')).toBe('src/**');
  });

  it('widens a suffix entry to any depth', () => {
    expect(watcherPatternFor('*.java')).toBe('**/*.java');
  });

  it('leaves an exact path alone', () => {
    expect(watcherPatternFor('Makefile')).toBe('Makefile');
  });
});
```

Then add a behavioural test asserting the re-check. Using the existing harness in this file (which fakes `vscode.workspace.createFileSystemWatcher`), add:

```ts
it('does not emit for a path the editor glob admits but the matcher rejects', async () => {
  // 'src/**' is handed to VS Code as a coarse pre-filter. If the editor
  // delivers something outside our own matcher — a different glob dialect, a
  // case-insensitive filesystem — we must stay silent. Design spec §4.2.
  const emitted: FsExternalChangeData[] = [];
  const harness = startWatcherHarness({
    scope: { track: ['src/'], ignore: ['*.class'], attachments: [] },
    emit: (d) => emitted.push(d),
    files: { 'src/A.class': 'compiled' },
  });

  await harness.fireCreate('src/A.class');

  expect(emitted).toEqual([]);
  harness.dispose();
});
```

If `startWatcherHarness` is not the existing helper's name, use whatever this file already uses to drive a fake watcher; do not build a second harness.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- fs-watcher`
Expected: FAIL — `watcherPatternFor` is not exported, and `FsWatcherDeps` has no `scope`.

- [ ] **Step 3: Add the pattern helper and the re-check**

In `packages/recorder/src/wiring/fs-watcher.ts`:

Add the import and helper near the top:

```ts
import { resolvePathRole } from '@provenance/log-core';
import type { ResolvedScope } from '@provenance/log-core';

/**
 * Widen a scope entry into an editor watcher glob.
 *
 * This is a COARSE PRE-FILTER and nothing more (design spec §4.2). VS Code's
 * glob engine is not our matcher, and JetBrains' and Neovim's are two more; a
 * port that emitted on its watcher's verdict alone would make the same manifest
 * watch different files on different editors. Every path a watcher delivers is
 * re-checked with `resolvePathRole` before anything is emitted, so widening
 * here is safe and narrowing here would be a bug.
 */
export function watcherPatternFor(entry: string): string {
  if (entry.endsWith('/')) return `${entry}**`;
  if (entry.startsWith('*')) return `**/${entry}`;
  return entry;
}
```

Change `FsWatcherDeps`: replace

```ts
  filesUnderReview: readonly string[];
```

with

```ts
/** The resolved scope. Watchers are built from `scope.track`; every delivered path is re-checked. */
scope: ResolvedScope;
```

In `startFsWatcher`, replace `filesUnderReview` in the destructure with `scope`, and change the loop header:

```ts
  for (const entry of scope.track) {
    const pattern = new vscode.RelativePattern(assignmentRoot, watcherPatternFor(entry));
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
```

The handlers currently close over `relativePath` from the loop variable. With a widened pattern that is no longer correct — the watcher now covers many paths — so each handler must derive the path from its `uri`. Add near the helper:

```ts
/**
 * The workspace-relative, forward-slash path for a watcher URI.
 *
 * Forward slashes always: the whole protocol — `doc.*` payload paths,
 * `files_under_review`, the matcher — is forward-slash, and a Windows recorder
 * emitting backslashes would join against nothing.
 */
function relativePathOf(assignmentRoot: string, uri: vscode.Uri): string {
  const root = assignmentRoot.endsWith('/') ? assignmentRoot : `${assignmentRoot}/`;
  const full = uri.fsPath.split('\\').join('/');
  const normalizedRoot = root.split('\\').join('/');
  return full.startsWith(normalizedRoot) ? full.slice(normalizedRoot.length) : full;
}
```

Change each handler's signature from `(_uri: vscode.Uri)` to `(uri: vscode.Uri)` and open each with:

```ts
const relativePath = relativePathOf(assignmentRoot, uri);
if (resolvePathRole(relativePath, scope) !== 'reviewed') return;
```

That guard is the authority. It must be the first statement in `handleChange`, `handleCreate`, and `handleDelete`, before any tolerance window, registry lookup, or read.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- fs-watcher`
Expected: PASS.

- [ ] **Step 5: Fix the caller**

Run: `grep -rn "startFsWatcher(" --include=*.ts packages/recorder/src`

Update the call site to pass `scope: scopeFromManifest(manifest)` instead of `filesUnderReview`.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/recorder`
Expected: PASS.

```bash
git add packages/recorder/src/wiring/fs-watcher.ts packages/recorder/src/wiring/fs-watcher.test.ts
git commit --no-gpg-sign -m "feat(recorder): the editor glob is a pre-filter, the path-scope matcher is the authority" -- packages/recorder/src/wiring/fs-watcher.ts packages/recorder/src/wiring/fs-watcher.test.ts
```

Add the call site you touched in step 5 to both the `add` and the pathspec.

---

### Task 6: `file_scope.complete` goes false when the scope carries rules

**Files:**

- Modify: `packages/recorder/src/session/recorder-context.ts` (`resolveFileScope`, ~line 84)
- Modify: `packages/recorder/src/session/recorder-context.test.ts`

**Interfaces:**

- Consumes: `isExactEntry` (Task 1).
- Produces: `resolveFileScope` keeps its signature `(filesUnderReview: readonly string[]) => SessionFileScope | undefined`.

- [ ] **Step 1: Write the failing test**

Add to `packages/recorder/src/session/recorder-context.test.ts`:

```ts
describe('resolveFileScope with rule entries', () => {
  it('stays complete for an all-exact list', () => {
    const scope = resolveFileScope(['Main.java', 'src/Board.java']);
    expect(scope).toEqual({ watched: ['Main.java', 'src/Board.java'], complete: true });
  });

  it('reports incomplete and lists only the exact entries when a rule is present', () => {
    // A rule cannot be enumerated, so absence from `watched` must no longer be
    // readable as "not watched". `complete: false` is exactly that downgrade.
    const scope = resolveFileScope(['src/', 'Main.java', '*.java']);
    expect(scope).toEqual({ watched: ['Main.java'], complete: false });
  });

  it('reports incomplete with an empty list when every entry is a rule', () => {
    expect(resolveFileScope(['src/'])).toEqual({ watched: [], complete: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- recorder-context`
Expected: FAIL — `resolveFileScope` currently copies the list verbatim and reports `complete: true`.

- [ ] **Step 3: Write the implementation**

In `packages/recorder/src/session/recorder-context.ts`, replace the body of `resolveFileScope`:

```ts
export function resolveFileScope(
  filesUnderReview: readonly string[],
): SessionFileScope | undefined {
  // A rule entry cannot be enumerated, so it cannot go in `watched` — and its
  // presence means absence from `watched` no longer proves "not watched".
  // `complete: false` is precisely the downgrade-to-unknown this field already
  // defines for the truncation case; rules reuse it unchanged.
  const exact = filesUnderReview.filter(isExactEntry);
  const hasRules = exact.length !== filesUnderReview.length;
  const complete = !hasRules && exact.length <= FILE_SCOPE_MAX_ENTRIES;
  const watched =
    exact.length <= FILE_SCOPE_MAX_ENTRIES ? exact : exact.slice(0, FILE_SCOPE_MAX_ENTRIES);
  return buildFileScope(watched, complete);
}
```

Add `isExactEntry` to the `@provenance/log-core` import at the top of the file.

Extend the docstring above it with:

```
 * ## Rules make the list partial, not wrong
 *
 * A manifest may now name a folder or a suffix (design spec §3). Those entries
 * cannot be enumerated at session start — that is the whole point of naming one
 * — so `watched` carries the exact-path entries only and `complete` goes false.
 * The analyzer then has two better answers available before it falls back to
 * `unknown`: it can evaluate the rules itself against the signed manifest in
 * `session.start` (§5.1 tier 1), and any file with recorded activity was
 * self-evidently watched.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- recorder-context`
Expected: PASS, including the existing truncation tests.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/recorder`

```bash
git add packages/recorder/src/session/recorder-context.ts packages/recorder/src/session/recorder-context.test.ts
git commit --no-gpg-sign -m "feat(recorder): file_scope reports incomplete when the scope carries rule entries" -- packages/recorder/src/session/recorder-context.ts packages/recorder/src/session/recorder-context.test.ts
```

---

### Task 7: Seal collects attachments, records `role` and `scope_capped`

**Files:**

- Modify: `packages/log-core/src/bundle.ts` (`SubmissionFileEntry`, `BundleManifest`, `validateBundleManifestShape`)
- Modify: `packages/log-core/src/bundle.test.ts`
- Modify: `packages/recorder/src/commands/seal.ts`
- Modify: `packages/recorder/src/commands/seal.test.ts`
- Modify: `packages/analysis-core/src/loader/parse-bundle.ts` (~line 580, carry `role` into the map)

**Interfaces:**

- Consumes: `ResolvedScope`, `resolvePathRole`, `isExactEntry` (Task 1); `registry.capHit()` (Task 4).
- Produces:
  - `SubmissionFileEntry.role?: 'reviewed' | 'attachment'` — absent reads as `'reviewed'`
  - `BundleManifest.scope_capped?: boolean`
  - `SealDeps.scope: ResolvedScope` replaces `SealDeps.filesUnderReview`
  - `SealDeps.scopeCapped: boolean`
  - `Bundle.submissionFiles` values gain `role: 'reviewed' | 'attachment'` (always populated, defaulting to `'reviewed'`)

- [ ] **Step 1: Write the failing bundle-shape test**

Add to `packages/log-core/src/bundle.test.ts`:

```ts
describe('submission_files role and scope_capped', () => {
  it('accepts a manifest with no role, meaning every file is reviewed', () => {
    const m = validManifest11(); // existing helper in this file
    expect(validateBundleManifestShape(m).ok).toBe(true);
  });

  it('accepts both role values', () => {
    for (const role of ['reviewed', 'attachment'] as const) {
      const m = validManifest11();
      m.submission_files[0].role = role;
      expect(validateBundleManifestShape(m).ok).toBe(true);
    }
  });

  it('rejects a role outside the pair', () => {
    const m = validManifest11();
    m.submission_files[0].role = 'whatever';
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'invalid_field' });
  });

  it('rejects a non-boolean scope_capped but accepts its absence', () => {
    const m = validManifest11();
    expect(validateBundleManifestShape({ ...m, scope_capped: true }).ok).toBe(true);
    expect(validateBundleManifestShape({ ...m, scope_capped: 'yes' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/log-core -- bundle`
Expected: FAIL on the invalid-role and non-boolean-`scope_capped` cases — the validator accepts unknown keys today.

- [ ] **Step 3: Extend the bundle types and validator**

In `packages/log-core/src/bundle.ts`, add to `SubmissionFileEntry`:

```ts
  /**
   * What this file was in the recording, not just in the ZIP.
   *
   * ABSENT READS AS `'reviewed'`, which is what every 1.1/1.2 bundle sealed
   * before path scope existed means. Additive and optional for the same reason
   * `final` is: no version bump, and absence is never a finding.
   *
   * An `'attachment'` was sealed and hashed but never captured — it has no
   * event provenance by definition, so check 8 must not compare it against
   * reconstruction. See `verify-submitted-code.ts`.
   */
  role?: 'reviewed' | 'attachment';
```

Add to `BundleManifest`, next to `final`:

```ts
  /**
   * Whether the recorder's expected-content cap refused a path that the scope
   * put under review (design spec §4.3).
   *
   * Additive and optional. Absent means "this recorder does not report", which
   * is what every bundle sealed before path scope says, and is not a finding.
   *
   * True is not an accusation either — it is the recorder disclosing that its
   * record of this session is incomplete, so a reader must NOT conclude
   * "in scope, no activity" about any file. Without it that inference would be
   * wrong and would land on a student who did nothing.
   */
  scope_capped?: boolean;
```

In `validateBundleManifestShape`, inside the per-entry loop after the `sha256` checks:

```ts
const role = fObj['role'];
if (role !== undefined && role !== 'reviewed' && role !== 'attachment') {
  return err({
    kind: 'invalid_field',
    field: `submission_files[${i}].role`,
    reason: "must be 'reviewed' or 'attachment' when present",
  });
}
```

And beside the `final` check:

```ts
if (obj['scope_capped'] !== undefined && typeof obj['scope_capped'] !== 'boolean') {
  return err({
    kind: 'invalid_field',
    field: 'scope_capped',
    reason: 'must be a boolean when present',
  });
}
```

- [ ] **Step 4: Run the bundle test**

Run: `npm run test --workspace=packages/log-core -- bundle`
Expected: PASS.

- [ ] **Step 5: Write the failing seal test**

Add to `packages/recorder/src/commands/seal.test.ts`:

```ts
describe('path scope at seal time', () => {
  it('walks the workspace and seals every rule-matched file with its role', async () => {
    const root = await makeWorkspace({
      'src/Main.java': 'class Main {}',
      'src/A.class': 'BINARY',
      'logs/run.log': 'output',
      'README.md': 'notes',
    });
    const result = await sealBundle(
      sealDeps(root, {
        scope: { track: ['src/'], ignore: ['*.class'], attachments: ['logs/'] },
      }),
    );
    expect(result.kind).toBe('ok');

    const manifest = await readSealedManifest(root);
    const byPath = new Map(manifest.submission_files.map((f) => [f.path, f]));

    expect(byPath.get('src/Main.java')?.role).toBe('reviewed');
    expect(byPath.get('logs/run.log')?.role).toBe('attachment');
    // ignored and unscoped files are not in the bundle at all
    expect(byPath.has('src/A.class')).toBe(false);
    expect(byPath.has('README.md')).toBe(false);
  });

  it('never seals a hard-excluded path, however greedy the manifest', async () => {
    const root = await makeWorkspace({ 'src/Main.java': 'x' });
    await sealBundle(sealDeps(root, { scope: { track: ['*'], ignore: [], attachments: [] } }));
    const manifest = await readSealedManifest(root);
    for (const f of manifest.submission_files) {
      expect(f.path.startsWith('.provenance/')).toBe(false);
      expect(f.path.startsWith('.git/')).toBe(false);
    }
  });

  it('marks an absent EXACT entry missing, and says nothing about rule entries', async () => {
    // R2. A course writing "*.java" asserts nothing about any particular file
    // existing, so a .java file the student did not write is not a fact about
    // the student. Only an exact entry is a claim that can go unmet.
    const root = await makeWorkspace({ 'Present.java': 'x' });
    await sealBundle(
      sealDeps(root, {
        scope: { track: ['*.java', 'Required.java'], ignore: [], attachments: [] },
      }),
    );
    const manifest = await readSealedManifest(root);
    const missing = manifest.submission_files.filter((f) => f.status === 'missing');
    expect(missing.map((f) => f.path)).toEqual(['Required.java']);
  });

  it('records scope_capped when the recorder says its registry filled', async () => {
    const root = await makeWorkspace({ 'a.java': 'x' });
    await sealBundle(
      sealDeps(root, {
        scope: { track: ['*.java'], ignore: [], attachments: [] },
        scopeCapped: true,
      }),
    );
    expect((await readSealedManifest(root)).scope_capped).toBe(true);
  });

  it('omits scope_capped entirely when the cap did not bite', async () => {
    const root = await makeWorkspace({ 'a.java': 'x' });
    await sealBundle(
      sealDeps(root, {
        scope: { track: ['*.java'], ignore: [], attachments: [] },
        scopeCapped: false,
      }),
    );
    expect('scope_capped' in (await readSealedManifest(root))).toBe(false);
  });
});
```

Use the file's existing workspace/deps helpers if they are named differently; keep the assertions.

- [ ] **Step 6: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- seal`
Expected: FAIL — `SealDeps` has `filesUnderReview`, not `scope`.

- [ ] **Step 7: Implement the walk and the roles**

In `packages/recorder/src/commands/seal.ts`:

Import:

```ts
import { resolvePathRole, isExactEntry } from '@provenance/log-core';
import type { ResolvedScope } from '@provenance/log-core';
```

Replace the `filesUnderReview` field in `SealDeps`:

```ts
/** The resolved scope from the course manifest. Replaces the old exact-path list. */
scope: ResolvedScope;
/** Whether the recorder's expected-content cap refused an in-scope path this session. */
scopeCapped: boolean;
```

Add the walker beside `readReviewedFile`:

```ts
/**
 * Every file under `root`, as workspace-relative forward-slash paths.
 *
 * Hard-excluded directories are skipped at the DIRECTORY level rather than
 * filtered afterwards: `.git/` in a real assignment holds thousands of objects,
 * and walking them to throw them away is the difference between a seal that
 * feels instant and one that does not.
 */
async function walkWorkspace(root: string, rel = ''): Promise<string[]> {
  let dirents;
  try {
    dirents = await fsPromises.readdir(path.join(root, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    const childRel = rel === '' ? d.name : `${rel}/${d.name}`;
    if (d.isDirectory()) {
      if (isHardExcluded(`${childRel}/`)) continue;
      out.push(...(await walkWorkspace(root, childRel)));
    } else if (d.isFile()) {
      out.push(childRel);
    }
  }
  return out;
}
```

Import `isHardExcluded` alongside the others.

Replace step 3's loop (currently `for (const rel of filesUnderReview)`) with:

```ts
// Step 3: Walk the workspace and assign each file its role. A rule entry
// cannot be enumerated from the manifest, so the file set is discovered here
// rather than read off the list.
const workspaceRoot = assignmentRoot;
const onDisk = await walkWorkspace(workspaceRoot);
const present = new Set(onDisk);

const reviewedFiles: Array<ReviewedFile & { role: 'reviewed' | 'attachment' }> = [];
for (const rel of onDisk) {
  const role = resolvePathRole(rel, scope);
  if (role !== 'reviewed' && role !== 'attachment') continue;
  reviewedFiles.push({ ...(await readReviewedFile(workspaceRoot, rel)), role });
}

// An EXACT track entry is a claim that a specific file should exist, so an
// absent one is reportable. A rule entry claims nothing about any particular
// file, so an absent rule-match is not a fact about the student at all —
// reporting one would produce a finding per file they never wrote (R2).
for (const entry of scope.track) {
  if (!isExactEntry(entry)) continue;
  if (present.has(entry)) continue;
  if (resolvePathRole(entry, scope) !== 'reviewed') continue;
  reviewedFiles.push({ path: entry, status: 'missing', sha256: null, role: 'reviewed' });
}

const submissionFiles = reviewedFiles.map((f) =>
  f.status === 'present'
    ? { path: f.path, status: 'present' as const, sha256: f.sha256, role: f.role }
    : { path: f.path, status: 'missing' as const, sha256: null, role: f.role },
);
```

In step 4, where the `BundleManifest` object is built, spread `scope_capped` so `false` OMITS the key (matching how `final` and the `session.start` capability reports are handled — an absent key and a `false` value are different facts, and absence is what every pre-scope bundle says):

```ts
    ...(deps.scopeCapped ? { scope_capped: true } : {}),
```

In step 6, the ZIP must include the bytes of every `present` entry regardless of role — attachments are in the bundle, that is what makes them attachments. If the existing zip loop filters on anything other than `status === 'present'`, leave it; it already does the right thing.

- [ ] **Step 8: Run the seal test**

Run: `npm run test --workspace=packages/recorder -- seal`
Expected: PASS.

- [ ] **Step 9: Carry `role` through the loader**

In `packages/analysis-core/src/loader/parse-bundle.ts`, step 5 (~line 580), add `role` to both the map's value type and both `set` calls:

```ts
const submissionFiles = new Map<
  string,
  {
    status: 'present' | 'missing';
    sha256: string | null;
    bytes?: Uint8Array;
    hashOk: boolean;
    role: 'reviewed' | 'attachment';
  }
>();
for (const f of manifest.submission_files ?? []) {
  // Absent role reads as 'reviewed' — every bundle sealed before path scope.
  const role = f.role ?? 'reviewed';
  if (f.status === 'missing') {
    submissionFiles.set(f.path, { status: 'missing', sha256: null, hashOk: true, role });
    continue;
  }
  const bytes = bundleSubmissionFiles.get(f.path);
  const hashOk = bytes !== undefined && sha256Hex(bytes) === f.sha256;
  submissionFiles.set(f.path, {
    status: 'present',
    sha256: f.sha256,
    ...(bytes !== undefined ? { bytes } : {}),
    hashOk,
    role,
  });
}
```

Update the matching declaration on the `Bundle` type at `packages/analysis-core/src/loader/types.ts:605` so the two shapes stay in step. (The unrelated `submissionFiles: Map<string, Uint8Array>` at `types.ts:293` is the raw ZIP-entry map and must NOT gain a role.)

- [ ] **Step 10: Fix the seal call site**

Run: `grep -rn "sealBundle(" --include=*.ts packages/recorder/src`

Pass `scope: scopeFromManifest(manifest)` and `scopeCapped: registry.capHit()`.

- [ ] **Step 11: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/log-core && npm run test --workspace=packages/recorder && npm run test --workspace=packages/analysis-core`

```bash
git add packages/log-core/src/bundle.ts packages/log-core/src/bundle.test.ts packages/recorder/src/commands/seal.ts packages/recorder/src/commands/seal.test.ts packages/analysis-core/src/loader/parse-bundle.ts
git commit --no-gpg-sign -m "feat(recorder): seal discovers rule-matched files and records role and scope_capped" -- packages/log-core/src/bundle.ts packages/log-core/src/bundle.test.ts packages/recorder/src/commands/seal.ts packages/recorder/src/commands/seal.test.ts packages/analysis-core/src/loader/parse-bundle.ts
```

---

### Task 8: Check 8 never accuses an attachment (spec §9.1)

**Files:**

- Modify: `packages/analysis-core/src/validation/verify-submitted-code.ts` (`SubmittedFileVerdict` at :67, `submittedFileVerdicts` at :227)
- Modify: `packages/analysis-core/src/validation/verify-submitted-code.test.ts`

**Interfaces:**

- Consumes: `Bundle.submissionFiles[].role` (Task 7).
- Produces: `SubmittedFileVerdict.verdict` gains `'attachment'`.

- [ ] **Step 1: Write the failing regression test**

Add to `packages/analysis-core/src/validation/verify-submitted-code.test.ts`:

```ts
describe('attachments are never compared against reconstruction (R2)', () => {
  it('reports an attachment as attested rather than mismatched', () => {
    // An attachment has no event provenance BY DEFINITION — that is what makes
    // it an attachment. Comparing it against reconstruction reports every
    // attachment in every bundle as tampered, on a check used in
    // academic-integrity proceedings. Spec §9.1.
    const bundle = bundleWithSubmissionFiles({
      'logs/run.log': {
        status: 'present',
        sha256: 'ab'.repeat(32),
        hashOk: true,
        role: 'attachment',
      },
    });
    const verdicts = submittedFileVerdicts(bundle, { chainIntact: true });
    const v = verdicts.find((x) => x.path === 'logs/run.log');
    expect(v?.verdict).toBe('attachment');
    expect(v?.detail).toMatch(/never captured/i);
  });

  it('still compares a reviewed file in the same bundle', () => {
    const bundle = bundleWithSubmissionFiles({
      'logs/run.log': {
        status: 'present',
        sha256: 'ab'.repeat(32),
        hashOk: true,
        role: 'attachment',
      },
      'Main.java': { status: 'present', sha256: 'cd'.repeat(32), hashOk: true, role: 'reviewed' },
    });
    const verdicts = submittedFileVerdicts(bundle, { chainIntact: true });
    expect(verdicts.find((x) => x.path === 'Main.java')?.verdict).not.toBe('attachment');
  });
});
```

Use the file's existing bundle-building helper if it is named differently.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analysis-core -- verify-submitted-code`
Expected: FAIL — the attachment comes back `'mismatch'` or `'unknown'`, never `'attachment'`.

- [ ] **Step 3: Implement**

Widen the verdict union at `verify-submitted-code.ts:67`:

```ts
/**
 * 'match' | 'mismatch' | 'unknown' (skip) | 'attachment' (not comparable).
 *
 * `'attachment'` is NOT a weaker 'unknown'. Unknown means we could not tell;
 * attachment means the question does not apply, because the file was sealed
 * and hashed but deliberately never captured. Collapsing the two would put
 * attachments into whatever surface renders unresolved files.
 */
verdict: 'match' | 'mismatch' | 'unknown' | 'attachment';
```

In `submittedFileVerdicts`, as the **first** statement inside the `for (const [path, f] of bundle.submissionFiles)` loop — before the `missing` branch, before the tamper sub-check:

```ts
if (f.role === 'attachment') {
  // Attested by hash in the signed manifest, never captured, so there is
  // nothing to reconstruct and nothing to compare. Spec §9.1.
  verdicts.push({
    path,
    status: f.status,
    verdict: 'attachment',
    submittedSha: f.sha256,
    recordedSha: null,
    detail:
      'Carried in the bundle and covered by the signed manifest, but never captured — ' +
      'the assignment lists it as an attachment, so no event history exists to compare against.',
    supportingSeqs: [],
  });
  continue;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/analysis-core -- verify-submitted-code`
Expected: PASS.

- [ ] **Step 5: Handle the new verdict everywhere it is rendered**

Run: `grep -rn "'mismatch'" --include=*.ts --include=*.tsx packages/analysis-core/src packages/analyzer/src packages/server/src | grep -v "\.test\."`

Every exhaustive switch or mapping over `verdict` needs an `'attachment'` arm. In the analyzer's Source tab and any check-8 summary, render it as a neutral, non-accusatory state — never in the same visual bucket as `mismatch`. In counts of "files that failed check 8", attachments must not be counted at all.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/analysis-core && npm run test --workspace=packages/analyzer`

```bash
git add packages/analysis-core/src/validation/verify-submitted-code.ts packages/analysis-core/src/validation/verify-submitted-code.test.ts
git commit --no-gpg-sign -m "fix(analysis-core): check 8 attests attachments instead of reporting them tampered" -- packages/analysis-core/src/validation/verify-submitted-code.ts packages/analysis-core/src/validation/verify-submitted-code.test.ts
```

Add any render sites you touched in step 5 to both the `add` and the pathspec.

---

### Task 9: Coverage answers "was it watched?" from the rules (spec §5.1)

**Files:**

- Modify: `packages/analysis-core/src/capability/session-capabilities.ts` (`wasFileWatched` at :295)
- Modify: `packages/analysis-core/src/capability/session-capabilities.test.ts`

**Interfaces:**

- Consumes: `resolvePathRole`, `scopeFromManifest` (Tasks 1–2).
- Produces: `wasFileWatched(facts, path, scope?: ResolvedScope): WatchedFileAnswer` — third parameter optional, so every existing call site keeps compiling and keeps its current behaviour.

- [ ] **Step 1: Write the failing test**

Add to `packages/analysis-core/src/capability/session-capabilities.test.ts`:

```ts
describe('wasFileWatched with a resolved scope (tier 1)', () => {
  const scope = { track: ['src/'], ignore: ['*.class'], attachments: [] };

  it('answers definitively from the rules even when the list is incomplete', () => {
    // The rules come from the SIGNED manifest in session.start, so this is not
    // a guess — it is the same evaluation the recorder made. Spec §5.1 tier 1.
    const facts = factsWithFileScope({ watched: [], complete: false });
    expect(wasFileWatched(facts, 'src/Solver.java', scope)).toBe('watched');
    expect(wasFileWatched(facts, 'README.md', scope)).toBe('not_watched');
    expect(wasFileWatched(facts, 'src/A.class', scope)).toBe('not_watched');
  });

  it('falls back to the list when no scope is supplied', () => {
    const facts = factsWithFileScope({ watched: ['Main.java'], complete: true });
    expect(wasFileWatched(facts, 'Main.java')).toBe('watched');
    expect(wasFileWatched(facts, 'Other.java')).toBe('not_watched');
  });

  it('returns unknown from the rules when the recorder reported a capped session', () => {
    // scope_capped means the recorder stopped admitting in-scope paths. The
    // rules then describe what SHOULD have been watched, not what was — so
    // "in scope, no activity" must not be concluded. R2.
    const facts = factsWithFileScope({ watched: [], complete: false }, { scopeCapped: true });
    expect(wasFileWatched(facts, 'src/Solver.java', scope)).toBe('unknown');
  });
});
```

Extend the file's existing `factsWithFileScope` helper (or its equivalent) to accept a second argument setting `scopeCapped`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analysis-core -- session-capabilities`
Expected: FAIL — `wasFileWatched` takes two parameters.

- [ ] **Step 3: Add `scopeCapped` to the facts**

`BundleCapabilityFacts` needs to carry the seal's `scope_capped`. Add to its type:

```ts
/**
 * Any session's recorder reported that its expected-content cap refused an
 * in-scope path (design spec §4.3). When true, the scope RULES describe what
 * should have been watched rather than what was, so rule evaluation must
 * degrade to `unknown` rather than assert `not_watched`.
 */
scopeCapped: boolean;
```

Populate it where the facts are built, from `bundle.manifest.scope_capped === true`.

- [ ] **Step 4: Implement the tiered answer**

Replace `wasFileWatched`:

```ts
export function wasFileWatched(
  facts: BundleCapabilityFacts,
  path: string,
  scope?: ResolvedScope,
): WatchedFileAnswer {
  // Tier 1 — evaluate the course's own rules. Available whenever the caller
  // holds a 2.0 manifest, which travels inside session.start, so this needs
  // nothing from the server and nothing the student could edit.
  //
  // Skipped when a recorder reported a capped session: the rules then say what
  // should have been watched, and asserting `not_watched` OR `watched` from
  // them would be a claim the record cannot support.
  if (scope !== undefined && !facts.scopeCapped) {
    return resolvePathRole(path, scope) === 'reviewed' ? 'watched' : 'not_watched';
  }

  // Tier 2 — the recorder's own enumerated list. A TRUNCATED or rule-bearing
  // list can prove 'watched' (the path is in it) but never 'not_watched'.
  let everySessionComplete = facts.counts.sessions > 0;
  for (const session of facts.sessions) {
    if (session.fileScope.kind !== 'recorded') {
      everySessionComplete = false;
      continue;
    }
    if (session.fileScope.watched.includes(path)) return 'watched';
    if (!session.fileScope.complete) everySessionComplete = false;
  }
  // Tier 3 — unknown.
  return everySessionComplete ? 'not_watched' : 'unknown';
}
```

Import `resolvePathRole` and the `ResolvedScope` type from `@provenance/log-core`.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace=packages/analysis-core -- session-capabilities`
Expected: PASS, including every pre-existing `wasFileWatched` test (they pass no third argument and take tier 2 unchanged).

- [ ] **Step 6: Pass the scope from the coverage caller**

Run: `grep -rn "wasFileWatched(" --include=*.ts --include=*.tsx packages/analysis-core/src packages/analyzer/src | grep -v "\.test\."`

Where the caller has the bundle's `session.start` manifest available, pass `scopeFromManifest(manifest)`. Where it does not, leave the two-argument call — tier 2 is correct there.

- [ ] **Step 7: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/analysis-core`

```bash
git add packages/analysis-core/src/capability/session-capabilities.ts packages/analysis-core/src/capability/session-capabilities.test.ts
git commit --no-gpg-sign -m "feat(analysis-core): answer was-it-watched from the signed scope rules" -- packages/analysis-core/src/capability/session-capabilities.ts packages/analysis-core/src/capability/session-capabilities.test.ts
```

---

### Task 10: The staff composer and the signing CLI, in lockstep

**Files:**

- Modify: `packages/analyzer/src/views/compose/manifest-composer.ts`
- Modify: `packages/analyzer/src/views/compose/manifest-composer.test.ts`
- Modify: `packages/analyzer/src/views/compose/ManifestComposerView.tsx`
- Modify: `packages/analyzer/src/views/compose/ManifestComposerView.test.tsx`
- Modify: `tools/sign-manifest.ts`

**Interfaces:**

- Consumes: `validateScopeEntry` (Task 1); the manifest fields (Task 2).
- Produces:
  - `ComposerForm.ignore: readonly string[]`, `ComposerForm.attachments: readonly string[]`
  - `splitPathList(text: string): readonly string[]` replaces `splitFilesUnderReview` (keep the old name as a re-export if any other module imports it)

**Note:** the working tree may hold in-flight edits to these four analyzer files. Read each one before editing and preserve what is already there — in particular `issuedAtFrom`, which is new and uncommitted.

- [ ] **Step 1: Write the failing test**

Add to `packages/analyzer/src/views/compose/manifest-composer.test.ts`:

```ts
describe('the scope lists', () => {
  it('emits ignore and attachments at 2.0 and neither at 1.x', () => {
    const form = {
      ...EMPTY_COMPOSER_FORM,
      assignment_id: 'a',
      semester: 'fa26',
      issued_at: '2026-09-08T00:00:00Z',
      course_id: 'c',
      files_under_review: ['src/'],
      ignore: ['*.class'],
      attachments: ['logs/'],
    };
    const v2 = buildUnsignedManifest(form) as Record<string, unknown>;
    expect(v2['ignore']).toEqual(['*.class']);
    expect(v2['attachments']).toEqual(['logs/']);

    const v1 = buildUnsignedManifest({ ...form, format: '1.0' }) as Record<string, unknown>;
    expect('ignore' in v1).toBe(false);
    expect('attachments' in v1).toBe(false);
  });

  it('reports the offending entry and why, per list', () => {
    const form = {
      ...EMPTY_COMPOSER_FORM,
      assignment_id: 'a',
      semester: 'fa26',
      issued_at: '2026-09-08T00:00:00Z',
      course_id: 'c',
      files_under_review: ['src/*.java'],
      ignore: ['../escape'],
      attachments: ['a?.log'],
    };
    const issues = validateComposerForm(form, null);
    const byField = new Map(issues.map((i) => [i.field, i.message]));
    expect(byField.get('files_under_review')).toContain('src/*.java');
    expect(byField.get('ignore')).toContain('../escape');
    expect(byField.get('attachments')).toContain('a?.log');
  });

  it('accepts empty ignore and attachments lists', () => {
    const form = {
      ...EMPTY_COMPOSER_FORM,
      assignment_id: 'a',
      semester: 'fa26',
      issued_at: '2026-09-08T00:00:00Z',
      course_id: 'c',
      files_under_review: ['Main.java'],
    };
    const issues = validateComposerForm(form, null);
    expect(issues.some((i) => i.field === 'ignore')).toBe(false);
    expect(issues.some((i) => i.field === 'attachments')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- manifest-composer`
Expected: FAIL — `ComposerForm` has no `ignore` / `attachments`.

- [ ] **Step 3: Extend the form model**

In `manifest-composer.ts`, add to `ComposerForm` after `files_under_review`:

```ts
  /** One entry per line in the UI; split by {@link splitPathList}. 2.0 only. */
  readonly ignore: readonly string[];
  /** One entry per line in the UI; split by {@link splitPathList}. 2.0 only. */
  readonly attachments: readonly string[];
```

Add both to `EMPTY_COMPOSER_FORM` as `[]`.

Rename `splitFilesUnderReview` to `splitPathList`, update its docstring to say "path list" rather than "files textarea", and keep a one-line alias so nothing else breaks:

```ts
/** @deprecated Use {@link splitPathList}. Kept so existing imports keep working. */
export const splitFilesUnderReview = splitPathList;
```

- [ ] **Step 4: Validate every entry**

In `validateComposerForm`, after the existing `files_under_review` empty check, add:

```ts
const checkList = (field: string, entries: readonly string[]): void => {
  for (const entry of entries) {
    const problem = validateScopeEntry(entry);
    if (problem !== null) {
      issues.push({ field, message: `"${entry}" — ${problem.detail}` });
      return; // one message per field; the first bad entry is the one to fix
    }
  }
};
checkList('files_under_review', form.files_under_review);
```

And inside the 2.0-only section (after `return issues` for 1.x):

```ts
checkList('ignore', form.ignore);
checkList('attachments', form.attachments);
```

Import `validateScopeEntry` from `@provenance/log-core`.

**`files_under_review` is checked for all formats but the new FORMS are only legal at 2.0.** At 1.x an entry like `src/` is a file named `src/` — legal to sign, matches nothing. Rather than let staff sign a 1.x manifest that silently matches nothing, add inside the 1.x path, before `return issues`:

```ts
for (const entry of form.files_under_review) {
  if (isExactEntry(entry)) continue;
  issues.push({
    field: 'files_under_review',
    message:
      `"${entry}" is a folder or suffix rule, which only exists at format 2.0. In a 1.x ` +
      'manifest it means a file with that literal name, so it would match nothing. Switch the ' +
      'format to 2.0, or list exact paths.',
  });
  break;
}
```

Import `isExactEntry` too.

- [ ] **Step 5: Emit both fields**

In `buildUnsignedManifest`, add to the 2.0 return object only:

```ts
    ignore: form.ignore,
    attachments: form.attachments,
```

- [ ] **Step 6: Run the logic tests**

Run: `npm run test --workspace=packages/analyzer -- manifest-composer`
Expected: PASS.

- [ ] **Step 7: Add the two textareas**

In `ManifestComposerView.tsx`, inside the `{isV2 && (` block, following the existing `composer-files` field pattern exactly (label, `textarea` with `INPUT_CLASS} font-mono`, help `<p>`, `FieldError`), add local state `ignoreText` / `attachmentsText` beside the existing `filesText`, and:

```tsx
<div className="sm:col-span-2">
  <label htmlFor="composer-ignore" className="text-xs font-medium text-gray-700">
    ignore — one entry per line
  </label>
  <textarea
    id="composer-ignore"
    rows={3}
    className={`${INPUT_CLASS} font-mono`}
    value={ignoreText}
    onChange={(e) => {
      setIgnoreText(e.target.value);
      update({ ignore: splitPathList(e.target.value) });
    }}
    placeholder={'*.class\ntarget/'}
    data-testid="composer-ignore"
  />
  <p className="mt-1 text-xs text-gray-500">
    Files the recorder will not capture at all. This is a real cost, not just less noise: no
    events are produced for these paths, and that includes the evidence that would{' '}
    <em>exculpate</em> a student — the typing history showing they wrote the code themselves.
    Ignore build output and dependencies, not source.
  </p>
  {submitted && <FieldError id="composer-ignore-error" message={issueFor('ignore')} />}
</div>
<div className="sm:col-span-2">
  <label htmlFor="composer-attachments" className="text-xs font-medium text-gray-700">
    attachments — one entry per line
  </label>
  <textarea
    id="composer-attachments"
    rows={3}
    className={`${INPUT_CLASS} font-mono`}
    value={attachmentsText}
    onChange={(e) => {
      setAttachmentsText(e.target.value);
      update({ attachments: splitPathList(e.target.value) });
    }}
    placeholder={'logs/\n*.log'}
    data-testid="composer-attachments"
  />
  <p className="mt-1 text-xs text-gray-500">
    Files that travel with the submission but are never recorded — run logs, generated output.
    Their path and hash are covered by the signed bundle manifest, so they cannot be altered
    unnoticed, but they have no typing history and are never compared against one.
  </p>
  {submitted && <FieldError id="composer-attachments-error" message={issueFor('attachments')} />}
</div>
```

Add a matching entry-forms note under the existing `files_under_review` help text:

```tsx
<p className="mt-1 text-xs text-gray-500">
  Three forms: an exact path (<code>Makefile</code>), a folder and everything under it (
  <code>src/</code>), or a filename suffix at any depth (<code>*.java</code>). There is no{' '}
  <code>**</code> and no mid-path wildcard.
</p>
```

- [ ] **Step 8: Test the view**

Add to `ManifestComposerView.test.tsx`:

```tsx
it('signs a manifest carrying the ignore and attachments lists', async () => {
  renderComposer();
  await fillValidV2Form(); // existing helper
  fireEvent.change(screen.getByTestId('composer-ignore'), { target: { value: '*.class' } });
  fireEvent.change(screen.getByTestId('composer-attachments'), { target: { value: 'logs/' } });
  const produced = await signAndReadBlob();
  expect(produced['ignore']).toEqual(['*.class']);
  expect(produced['attachments']).toEqual(['logs/']);
});

it('refuses to sign when an entry is malformed, and names it', async () => {
  renderComposer();
  await fillValidV2Form();
  fireEvent.change(screen.getByTestId('composer-ignore'), { target: { value: '../escape' } });
  fireEvent.click(screen.getByRole('button', { name: /sign/i }));
  expect(await screen.findByText(/\.\.\/escape/)).toBeInTheDocument();
});
```

Run: `npm run test --workspace=packages/analyzer -- ManifestComposerView`
Expected: PASS.

- [ ] **Step 9: Update the CLI in the same commit**

In `tools/sign-manifest.ts`, add `ignore` and `attachments` to the 2.0 required-field list and to the object it builds (mirroring lines 213–225's 1.x handling), and update the two docstring lines at :24 and :34 that enumerate the signed fields.

- [ ] **Step 10: Verify byte identity**

Run: `npm run test:tools`
Expected: PASS — `manifest-composer-conformance.test.ts` runs the real CLI as a subprocess and compares bytes. **A failure here means the composer and the CLI disagree**, which is the exact thing this gate exists to catch. Fix the mismatch; do not relax the test.

- [ ] **Step 11: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/analyzer && npm run test:tools`

```bash
git add packages/analyzer/src/views/compose/manifest-composer.ts packages/analyzer/src/views/compose/manifest-composer.test.ts packages/analyzer/src/views/compose/ManifestComposerView.tsx packages/analyzer/src/views/compose/ManifestComposerView.test.tsx tools/sign-manifest.ts
git commit --no-gpg-sign -m "feat(analyzer): compose ignore and attachments lists, validated per entry" -- packages/analyzer/src/views/compose/manifest-composer.ts packages/analyzer/src/views/compose/manifest-composer.test.ts packages/analyzer/src/views/compose/ManifestComposerView.tsx packages/analyzer/src/views/compose/ManifestComposerView.test.tsx tools/sign-manifest.ts
```

---

### Task 11: Silence about an ignored path is never read as a fact about the student (spec §9.3, R1)

**Files:**

- Modify: `packages/analysis-core/src/capability/session-capabilities.ts` (add `ignoredByAssignment`)
- Modify: `packages/analysis-core/src/capability/session-capabilities.test.ts`

**Interfaces:**

- Consumes: `resolvePathRole`, `ResolvedScope` (Task 1); `wasFileWatched` (Task 9).
- Produces: `function ignoredByAssignment(path: string, scope: ResolvedScope): boolean`

**Why this is its own task.** Spec §9.3 requires that a signal missing because the
course excluded it is reported with that reason, never as a zero. Task 9 gets
most of the way there — `wasFileWatched` already returns `'not_watched'` for an
ignored path rather than `'unknown'` — but `'not_watched'` does not say _why_,
and "the recorder never watched it" and "the course forbade watching it" are
different sentences to put in front of someone adjudicating a case.

- [ ] **Step 1: Write the failing test**

Add to `packages/analysis-core/src/capability/session-capabilities.test.ts`:

```ts
describe('ignoredByAssignment', () => {
  const scope = { track: ['src/'], ignore: ['*.class', 'vendor/'], attachments: ['logs/'] };

  it('is true only for a path the course ignore list matches', () => {
    expect(ignoredByAssignment('src/A.class', scope)).toBe(true);
    expect(ignoredByAssignment('vendor/dep.java', scope)).toBe(true);
    expect(ignoredByAssignment('src/Main.java', scope)).toBe(false);
    expect(ignoredByAssignment('logs/run.log', scope)).toBe(false);
  });

  it("does not claim a hard-excluded path was the course's choice", () => {
    // `.provenance/` is excluded by the protocol, not by the assignment. Saying
    // "your course excluded this" about it would be false.
    expect(ignoredByAssignment('.provenance/manifest.json', scope)).toBe(false);
  });

  it('pairs with wasFileWatched to distinguish the two silences', () => {
    const facts = factsWithFileScope({ watched: [], complete: false });
    // Both are not_watched, but only one of them is the course's doing.
    expect(wasFileWatched(facts, 'src/A.class', scope)).toBe('not_watched');
    expect(wasFileWatched(facts, 'README.md', scope)).toBe('not_watched');
    expect(ignoredByAssignment('src/A.class', scope)).toBe(true);
    expect(ignoredByAssignment('README.md', scope)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analysis-core -- session-capabilities`
Expected: FAIL — `ignoredByAssignment` is not exported.

- [ ] **Step 3: Implement**

Add to `packages/analysis-core/src/capability/session-capabilities.ts`:

```ts
/**
 * Was this path excluded by the ASSIGNMENT, as opposed to merely unwatched?
 *
 * Spec §9.3 / R1. "No evidence exists for this file" and "no evidence exists
 * for this file because the course excluded it" are different sentences, and
 * only the second one is fair to put in front of someone adjudicating a case.
 * `wasFileWatched` answers whether; this answers why.
 *
 * Deliberately false for a hard-excluded path: `.provenance/` and `.git/` are
 * excluded by the protocol, not by anyone's course policy, and attributing that
 * choice to the course would be false.
 */
export function ignoredByAssignment(path: string, scope: ResolvedScope): boolean {
  return resolvePathRole(path, scope) === 'ignored';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/analysis-core -- session-capabilities`
Expected: PASS.

- [ ] **Step 5: Audit the per-submission heuristics for absence-reasoning**

Run: `grep -rln "submissionFiles\|filesUnderReview\|file_scope" --include=*.ts packages/analysis-core/src/heuristics`

For each hit, check whether the heuristic draws a conclusion from a file having
**no** events. Most do not — they flag what is present in the event stream, so
an ignored file simply contributes nothing and no flag is produced, which is
already correct. `reconstruction-gate.ts:35` already carries a note that its
skip "is not yet a visible `not_applicable` flag with a reason attached"; if it
is the only hit that reasons from absence, wire `ignoredByAssignment` into its
reason string and leave the rest alone.

**If a heuristic is found that returns a zero or a flag for an ignored path,
stop and report it rather than fixing it inline** — that is a scoring change,
which is a product decision, not a coding one.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/analysis-core`

```bash
git add packages/analysis-core/src/capability/session-capabilities.ts packages/analysis-core/src/capability/session-capabilities.test.ts
git commit --no-gpg-sign -m "feat(analysis-core): say when a file is silent because the course excluded it" -- packages/analysis-core/src/capability/session-capabilities.ts packages/analysis-core/src/capability/session-capabilities.test.ts
```

---

### Task 12: The architecture page tells the truth again

**Files:**

- Modify: `tools/architecture/dot/*.dot` (the manifest, recorder-activation, and ingest diagrams)
- Modify: `packages/analyzer/src/views/architecture/content/nodes/<diagram>.ts` for each diagram touched
- Regenerate: diagram assets via `python3 tools/architecture/build_diagrams.py`

**Interfaces:**

- Consumes: everything above.
- Produces: an `/architecture` page whose claims match the code, and a passing `nodes.coverage.test.ts`.

- [ ] **Step 1: Find the nodes that now make false claims**

Run: `grep -rln "files_under_review\|submission_files\|file_scope" tools/architecture/dot/ packages/analyzer/src/views/architecture/content/nodes/`

- [ ] **Step 2: Update the diagrams**

Edit the relevant `tools/architecture/dot/*.dot` files. The claims that changed:

- The manifest node: the signed payload now carries `ignore` and `attachments`, and `files_under_review` entries have three forms.
- The recorder activation / watch-set node: membership is live and rule-based, not a fixed list read at session start.
- The seal node: the file set is discovered by walking the workspace, and each file carries a `role`.
- The ingest strip node: unchanged in behaviour, but should say that attachment bytes are dropped by the same allowlist that drops source — it is a question a reader will now have.

- [ ] **Step 3: Regenerate**

Run: `python3 tools/architecture/build_diagrams.py`
Expected: regenerated assets. Requires Graphviz (`brew install graphviz`). Dev-time only — never needed by `npm run build` or CI.

- [ ] **Step 4: Author the node detail**

Edit `packages/analyzer/src/views/architecture/content/nodes/<diagram>.ts`, keyed by the **bare** dot node name. Do **not** hand-edit `content/nodes.ts` — it is a derived barrel that prefixes each key with its diagram id.

- [ ] **Step 5: Verify the coverage test**

Run: `npm run test --workspace=packages/analyzer -- nodes.coverage`
Expected: PASS. This suite fails if a diagram gains a node with no detail, or keeps metadata for a node that no longer exists.

- [ ] **Step 6: Full verification and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/log-core && npm run test --workspace=packages/recorder && npm run test --workspace=packages/analysis-core && npm run test --workspace=packages/analyzer && npm run test:tools`
Expected: all pass.

```bash
git add tools/architecture/dot packages/analyzer/src/views/architecture
git commit --no-gpg-sign -m "docs(architecture): the map shows rule-based scope, roles, and the seal walk" -- tools/architecture/dot packages/analyzer/src/views/architecture
```

---

## Follow-on plans (not in this plan)

- **provjet (Kotlin)** — port `matchesScopeEntry` / `validateScopeEntry` / `resolvePathRole`, drive `tools/path-scope-vectors.json`, apply the §4.2 pre-filter rule to its own file watcher, cap at 512. Separate repo: `~/projects/provenance-jetbrains-recorder`.
- **provnvim (Lua)** — same, in `~/projects/provenance-neovim-recorder`. Note its manifest lives at exactly `<cwd>/.provenance-manifest`, and its JCS sorts keys bytewise — but scope entries are array VALUES, not object keys, so the ASCII-key constraint does not bind them.
- **Server-side surfacing** — if a grader should see attachment paths/hashes in the submission UI, that is its own small plan on top of Task 7's `role`.

---

### Task 13: The rolling seal learns the same scope (added during execution)

**Why this task exists.** It was missing from the plan as written, and Task 7's review found the gap. `packages/recorder/src/io/rolling-seal-writer.ts` still takes `filesUnderReview: readonly string[]` and enumerates it exactly (`:102`, `:224`). A rolling seal is the **git-submission** path — the format-1.2 manifest maintained continuously so a git-submitted repo is always sealed. So a course whose scope is `src/` gets a rolling manifest that lists **nothing at all**, and the classic and rolling seals of the same session disagree about what was under review. Not an R2 risk (its exact-list `missing` behaviour is safe), but the feature is incomplete for `submission: 'git'` without it, and that mode is the whole point of the multi-course program.

**Files:**

- Modify: `packages/recorder/src/io/rolling-seal-writer.ts`
- Modify: `packages/recorder/src/io/rolling-seal-writer.test.ts`
- Modify: the rolling-seal call site (find with `grep -rn "RollingSealWriter\|startRollingSeal" --include=*.ts packages/recorder/src | grep -v test`)

**Interfaces:**

- Consumes: `ResolvedScope`, `resolvePathRole`, `isExactEntry`, `scopeFromManifest` (Tasks 1–2); the workspace walk and role assignment from Task 7's `seal.ts`.
- Produces: `RollingSealDeps.scope: ResolvedScope` replacing `filesUnderReview`; `RollingSealDeps.scopeCapped: boolean`.

- [ ] **Step 1: Extract the walk so it is written once**

Task 7 put `walkWorkspace` in `seal.ts`. Both seals now need it, and two copies of a directory walk that must agree about hard exclusions is exactly the divergence this feature exists to avoid. Move it to `packages/recorder/src/io/workspace-walk.ts`, exported, and have `seal.ts` import it. Move its tests with it. No behaviour change in this step — `npm run test --workspace=packages/recorder` must stay green.

- [ ] **Step 2: Write the failing test**

Add to `packages/recorder/src/io/rolling-seal-writer.test.ts`:

```ts
it('seals rule-matched files, so a folder-scoped course is not sealed empty', async () => {
  const root = await makeWorkspace({
    'src/Main.java': 'class Main {}',
    'src/A.class': 'BINARY',
    'logs/run.log': 'output',
  });
  await writeRollingSeal(
    rollingDeps(root, {
      scope: { track: ['src/'], ignore: ['*.class'], attachments: ['logs/'] },
    }),
  );
  const m = await readRollingManifest(root);
  const byPath = new Map(m.submission_files.map((f) => [f.path, f]));
  expect(byPath.get('src/Main.java')?.role).toBe('reviewed');
  expect(byPath.get('logs/run.log')?.role).toBe('attachment');
  expect(byPath.has('src/A.class')).toBe(false);
});

it('marks an absent EXACT entry missing and says nothing about rule entries', async () => {
  const root = await makeWorkspace({ 'Present.java': 'x' });
  await writeRollingSeal(
    rollingDeps(root, {
      scope: { track: ['*.java', 'Required.java'], ignore: [], attachments: [] },
    }),
  );
  const m = await readRollingManifest(root);
  expect(m.submission_files.filter((f) => f.status === 'missing').map((f) => f.path)).toEqual([
    'Required.java',
  ]);
});

it('omits scope_capped when the cap did not bite', async () => {
  const root = await makeWorkspace({ 'a.java': 'x' });
  await writeRollingSeal(
    rollingDeps(root, {
      scope: { track: ['*.java'], ignore: [], attachments: [] },
      scopeCapped: false,
    }),
  );
  expect('scope_capped' in (await readRollingManifest(root))).toBe(false);
});
```

Use the file's existing helper names if they differ; keep the assertions.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- rolling-seal-writer`
Expected: FAIL — `RollingSealDeps` has `filesUnderReview`, not `scope`.

- [ ] **Step 4: Implement**

Replace `filesUnderReview: readonly string[]` in `RollingSealDeps` with `scope: ResolvedScope` and add `scopeCapped: boolean`. Replace the enumeration loop with the same three-part logic Task 7 put in `seal.ts`: walk the workspace, assign each file a role via `resolvePathRole`, keep `'reviewed'` and `'attachment'`, then add a `missing` record for each EXACT track entry that is absent — attempting a read before concluding absence, exactly as `seal.ts` does. Spread `scope_capped` so `false` omits the key.

**A rolling seal runs on a cadence, not once.** The classic seal walks the workspace one time; this one walks on every checkpoint. Confirm against the file's existing docstring what that cadence is, and if the walk makes a checkpoint materially more expensive, say so in your report rather than optimising unasked — a correctness-preserving perf note is wanted, an invented cache is not.

- [ ] **Step 5: Update the call site**

Pass `scope: scopeFromManifest(manifest)` and `scopeCapped: registry.capHit()`, matching how `extension.ts` feeds `sealBundle`.

- [ ] **Step 6: Verify and commit**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/recorder && npm run test --workspace=packages/log-core && npm run test --workspace=packages/analysis-core`

```bash
git add packages/recorder/src/io/rolling-seal-writer.ts packages/recorder/src/io/rolling-seal-writer.test.ts packages/recorder/src/io/workspace-walk.ts packages/recorder/src/commands/seal.ts
git commit --no-gpg-sign -m "feat(recorder): the rolling seal resolves the same path scope as the classic seal" -- packages/recorder/src/io/rolling-seal-writer.ts packages/recorder/src/io/rolling-seal-writer.test.ts packages/recorder/src/io/workspace-walk.ts packages/recorder/src/commands/seal.ts
```

Add the call site and any moved test files to both the `add` and the pathspec.
