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
