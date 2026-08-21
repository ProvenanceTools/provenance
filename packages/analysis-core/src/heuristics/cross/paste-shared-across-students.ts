/**
 * paste_shared_across_students cross-heuristic (Phase 18).
 *
 * PRD §7.4 cross-submission heuristics.
 *
 * For each paste event with length >= minLength (default 100 chars), groups
 * pastes across all loaded bundles by content identity (exact or fuzzy). When
 * a group contains pastes from >= 2 different bundles, one CrossFlag is emitted
 * for that shared paste, listing the involved bundles and their paste seqs.
 *
 * Grouping algorithm (A60 — unified transitive-closure):
 *   Pastes are matched into groups using a single unified pass. A new paste
 *   joins an existing group if EITHER:
 *     a) Its sha256 matches any paste already in the group (exact match), OR
 *     b) It has inline content AND its diffLines line-overlap ratio with any
 *        paste already in the group with inline content exceeds fuzzyThreshold
 *        (default 90%).
 *
 *   This is a linear scan over groups (not a full transitive-closure graph).
 *   Each paste is checked against all existing groups; it joins the first
 *   matching group or starts a new one. This is O(N_pastes × N_groups) which
 *   is fine for typical 10–100 paste counts.
 *
 *   Rationale for unified (single-flavor) matching: two separate flag flavors
 *   (exact vs fuzzy) would fragment related findings and force the UI to
 *   de-duplicate. A single group covers both match mechanisms. The `matchKind`
 *   in detail records which mechanism triggered.
 *
 * Severity: high (confidence 0.95 for sha256-grouped, 0.8 for fuzzy-only).
 */

import { diffLines } from 'diff';
import type {
  CrossFlag,
  CrossHeuristic,
  CrossHeuristicConfig,
  CrossSubmissionFeatures,
} from './types.js';
import type { CrossScopePartition } from '../../coverage/cross-scope.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type PasteRecord = {
  bundleId: string;
  seqKey: string; // `${sessionId}:${seq}`
  sha256: string | undefined;
  content: string | undefined; // inline content (if present in payload)
  length: number;
};

type PasteGroup = {
  pastes: PasteRecord[];
  /** sha256 values observed in this group (for fast exact-match lookup). */
  hashes: Set<string>;
  /** Whether any match in this group was fuzzy-only (lowers confidence). */
  hasFuzzyMatch: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the ratio of shared lines between two strings.
 * Returns shared_lines / max(lines_a, lines_b).
 */
function fuzzyLineRatio(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const parts = diffLines(a, b);
  let shared = 0;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      shared += part.count ?? 0;
    }
  }
  const aLines = a.split('\n').length;
  const bLines = b.split('\n').length;
  return shared / Math.max(aLines, bLines);
}

/**
 * Check whether a new paste belongs to an existing group.
 * Returns true if it matches via sha256 OR fuzzy line overlap.
 * Side-effect: updates `group.hasFuzzyMatch` if the match is fuzzy-only.
 */
function matchesGroup(paste: PasteRecord, group: PasteGroup, fuzzyThreshold: number): boolean {
  // 1. Exact sha256 match.
  if (paste.sha256 !== undefined && group.hashes.has(paste.sha256)) {
    return true;
  }

  // 2. Fuzzy content match: compare against every in-group paste that has content.
  if (paste.content !== undefined) {
    for (const existing of group.pastes) {
      if (existing.content === undefined) continue;
      const ratio = fuzzyLineRatio(paste.content, existing.content);
      if (ratio >= fuzzyThreshold) {
        group.hasFuzzyMatch = true;
        return true;
      }
    }
  }

  return false;
}

/**
 * Add a paste to a group, updating the hashes set.
 */
function addToGroup(paste: PasteRecord, group: PasteGroup): void {
  group.pastes.push(paste);
  if (paste.sha256 !== undefined) {
    group.hashes.add(paste.sha256);
  }
}

// ---------------------------------------------------------------------------
// Cross-heuristic implementation
// ---------------------------------------------------------------------------

/**
 * Do the bundles in this paste group span more than one repository lineage?
 *
 * A group confined to ONE lineage is not evidence of sharing between students:
 * it is one student's paste, inside one shared `.provenance/`, seen once per
 * partner archive (spec S20). Every such group used to emit a
 * high-severity / 0.95 "may indicate content sharing" flag naming both partners.
 *
 * A group that spans two lineages stays a finding and is emitted unchanged,
 * including the partners it also contains — they really do hold the content, and
 * the exclusion register states which of the named bundles are one repository.
 * Splitting the group into per-lineage pairs would fragment one shared paste
 * into several findings about the same bytes.
 */
function spansMoreThanOneLineage(
  bundleIds: readonly string[],
  scopes: CrossScopePartition,
): boolean {
  const lineages = new Set<number>();
  for (const id of bundleIds) {
    const lineage = scopes.lineageOf.get(id);
    // An unknown bundle is not proved to share a repository with anything, so it
    // counts as its own lineage. Fail toward reporting the finding.
    if (lineage === undefined) return true;
    lineages.add(lineage);
    if (lineages.size > 1) return true;
  }
  return false;
}

function run(
  features: CrossSubmissionFeatures[],
  config: CrossHeuristicConfig,
  scopes: CrossScopePartition,
): CrossFlag[] {
  const { pasteSharedMinLength: minLength, pasteSharedFuzzyThreshold: fuzzyThreshold } = config;

  // Collect all qualifying paste events across all submissions.
  const allPastes: PasteRecord[] = [];

  for (const f of features) {
    for (const paste of f.pastes) {
      if (paste.length < minLength) continue;

      allPastes.push({
        bundleId: f.bundleId,
        seqKey: paste.seqKey,
        sha256: paste.sha256,
        content: paste.content,
        length: paste.length,
      });
    }
  }

  if (allPastes.length === 0) return [];

  // Group pastes using unified exact+fuzzy matching (transitive-closure-by-linear-scan).
  const groups: PasteGroup[] = [];

  for (const paste of allPastes) {
    let placed = false;
    for (const group of groups) {
      if (matchesGroup(paste, group, fuzzyThreshold)) {
        addToGroup(paste, group);
        placed = true;
        break;
      }
    }
    if (!placed) {
      const newGroup: PasteGroup = {
        pastes: [paste],
        hashes: new Set(paste.sha256 !== undefined ? [paste.sha256] : []),
        hasFuzzyMatch: false,
      };
      groups.push(newGroup);
    }
  }

  // Emit one CrossFlag per group that spans >= 2 different bundles.
  const flags: CrossFlag[] = [];
  let flagIndex = 0;

  for (const group of groups) {
    // Gather unique bundle ids in this group.
    const bundleIdSet = new Set(group.pastes.map((p) => p.bundleId));
    if (bundleIdSet.size < 2) continue;

    const bundleIds = [...bundleIdSet].sort();

    // Same-scope exclusion (spec S20). Suppressed pairs are NOT silently
    // dropped: `coverage/cross-scope.ts` states every one of them, with the
    // commits that proved it, as a coverage fact.
    if (!spansMoreThanOneLineage(bundleIds, scopes)) continue;

    // Build eventsPerBundle.
    const eventsPerBundle: Record<string, string[]> = {};
    for (const paste of group.pastes) {
      if (!(paste.bundleId in eventsPerBundle)) {
        eventsPerBundle[paste.bundleId] = [];
      }
      eventsPerBundle[paste.bundleId]!.push(paste.seqKey);
    }

    const confidence = group.hasFuzzyMatch ? 0.8 : 0.95;
    const matchKind = group.hasFuzzyMatch ? 'fuzzy_and_or_exact' : 'sha256_exact';
    const id = `paste_shared_across_students-${bundleIds.join('|')}-${flagIndex++}`;

    // Pick a representative paste length for the description.
    const maxLength = Math.max(...group.pastes.map((p) => p.length));

    flags.push({
      id,
      heuristic: 'paste_shared_across_students',
      title: `Shared paste detected across ${bundleIds.length} bundles`,
      severity: 'high',
      confidence,
      bundleIds,
      eventsPerBundle,
      description:
        `A paste of ${maxLength} characters appears in ${bundleIds.length} different student ` +
        `bundles (match kind: ${matchKind}). This may indicate content sharing or submission from ` +
        `a common external source.`,
      detail: {
        matchKind,
        pasteCount: group.pastes.length,
        maxLength,
        fuzzyThreshold,
      },
    });
  }

  return flags;
}

export const pasteSharedAcrossStudentsHeuristic: CrossHeuristic = {
  id: 'paste_shared_across_students',
  label: 'Shared paste across students',
  run,
};
