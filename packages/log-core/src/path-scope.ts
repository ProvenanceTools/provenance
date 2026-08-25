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
  // A suffix entry that also ends in "/" validates as legal but is DEAD: the
  // matcher tests the directory form first, so `*.java/` can only ever match a
  // path that literally begins `*.java/`, which no workspace-relative path
  // does. A course that wrote it would sign a manifest that watches nothing and
  // find out weeks later. Rejecting at parse time is the whole point of this
  // function — the two forms are mutually exclusive, so asking for both is
  // always a mistake, never a shorthand.
  if (entry.startsWith('*') && entry.endsWith('/')) {
    return {
      kind: 'bad_wildcard',
      detail:
        'A leading "*" matches a filename suffix, so the entry may not also end with "/". ' +
        'Write "*.java" to match files by suffix, or "java/" to match a directory.',
    };
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
