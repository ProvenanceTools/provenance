/**
 * external_edits heuristic (Phase 4).
 *
 * PRD §7.4: "Any fs.external_change event not preceded by a known formatter."
 *
 * Emits one Flag per group of coalesced fs.external_change events. Grouping
 * rule: consecutive events on the SAME FILE within a 2-second window (measured
 * by the `t` field — ms since session start) are merged into a single flag.
 * This prevents one CLI operation that touches multiple successive saves from
 * flooding the dashboard.
 *
 * A fs.external_change event is "explained" if its payload contains:
 *   explanation: 'formatter' | 'git'
 * Explained events are silently skipped and do NOT produce flags.
 *
 * Severity:
 *   - medium: any unexplained fs.external_change
 *   - high:   unexplained AND |diff_size| > highSeverityCharsChanged (default 100)
 *
 * Confidence: 0.9 for unexplained external changes (hard signal — the recorder
 * only emits fs.external_change when a file changes without a VS Code editor
 * being responsible).
 *
 * ## Tier 3.1 — content-based reclassification
 *
 * In a COLLABORATIVE scope (see `classifyExternalChanges`) each event also
 * carries a content-derived classification, and this heuristic consumes it:
 *
 *  - `git_merge_in` — the bytes are byte-identical to a state a provably
 *    different verified contributor recorded on the same path, and git moved
 *    HEAD in this session beforehand. That is a partner's work arriving through
 *    a merge, not an external edit, so no flag is raised. The event is NOT
 *    hidden: it stays in `byKind`, `byFile` and `ordered`, and the verdict is
 *    published on the classification for the timeline to render — the same
 *    arrangement `selfInflictedExternalChanges` uses.
 *  - `git_unrecorded_in` — attributable to a git operation, but matching nothing
 *    anyone recorded. **Still flagged, at unchanged severity and confidence.**
 *    Code arriving with no recorded process is what this system exists to
 *    surface; folding it in with `git_merge_in` because both involve git would
 *    delete the finding that matters most.
 *  - `external` / `unclassified` — flagged exactly as before. `unclassified`
 *    says why it could not be checked, in the description and in `detail`, so
 *    "we could not tell" never reads as "we checked and it was external".
 *
 * A SOLO scope produces no verdicts at all, so every flag this heuristic emits
 * there is byte-for-byte what it emitted before Tier 3.1.
 */

import type { EventIndex, IndexedEvent } from '../index/event-index.js';
import type { Bundle } from '../loader/types.js';
import type { Flag, Heuristic, Severity } from './types.js';
import type { HeuristicConfig } from './config.js';
import {
  externalChangeClassificationFor,
  describeClassification,
  type ExternalChangeVerdict,
} from '../index/classify-external-changes.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONFIDENCE = 0.9;

const EXPLAINED_VALUES = new Set<string>(['formatter', 'git']);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isExplained(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const p = payload as Record<string, unknown>;
  const explanation = p['explanation'];
  return typeof explanation === 'string' && EXPLAINED_VALUES.has(explanation);
}

function getDiffSize(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return 0;
  const p = payload as Record<string, unknown>;
  const diffSize = p['diff_size'];
  return typeof diffSize === 'number' ? Math.abs(diffSize) : 0;
}

function getFilePath(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return 'unknown';
  const p = payload as Record<string, unknown>;
  return typeof p['path'] === 'string' ? p['path'] : 'unknown';
}

function getOperation(payload: unknown): 'modify' | 'delete' | 'create' {
  if (typeof payload !== 'object' || payload === null) return 'modify';
  const p = payload as Record<string, unknown>;
  const op = p['operation'];
  return op === 'delete' || op === 'create' ? op : 'modify';
}

function flagId(seqKey: string, index: number): string {
  return `external_edits-${seqKey}-${index}`;
}

// ---------------------------------------------------------------------------
// Coalesce groups
// ---------------------------------------------------------------------------

/**
 * A group of fs.external_change events that have been coalesced into a single
 * flag. All events are on the same file and within the coalesce window.
 */
type CoalescedGroup = {
  file: string;
  events: IndexedEvent[];
  /** Maximum |diff_size| seen in the group. */
  maxDiffSize: number;
  /** Set of operations seen in the group ('modify' | 'delete' | 'create'). */
  operations: Set<'modify' | 'delete' | 'create'>;
};

/**
 * The verdict a coalesced group should be described by.
 *
 * A group can mix classifications — a pull can rewrite a file twice, once with
 * partner bytes and once with bytes nobody recorded. Ranked so the group is
 * described by its most consequential member: a `git_unrecorded_in` is a claim
 * about code with no process behind it and must not be buried under a
 * neighbouring `external`, and an `unclassified` reason must not be buried
 * either. `null` when no member had a verdict (a solo scope) — which is what
 * keeps the description byte-for-byte identical there.
 */
const CLASSIFICATION_RANK: Record<ExternalChangeVerdict['classification'], number> = {
  git_unrecorded_in: 3,
  unclassified: 2,
  external: 1,
  // Never present: git_merge_in events are filtered out before grouping.
  git_merge_in: 0,
};

function leadVerdict(
  events: readonly IndexedEvent[],
  verdicts: ReadonlyMap<number, ExternalChangeVerdict>,
): ExternalChangeVerdict | null {
  let lead: ExternalChangeVerdict | null = null;
  for (const e of events) {
    const v = verdicts.get(e.globalIdx);
    if (v === undefined) continue;
    if (
      lead === null ||
      CLASSIFICATION_RANK[v.classification] > CLASSIFICATION_RANK[lead.classification]
    ) {
      lead = v;
    }
  }
  return lead;
}

/**
 * Given a list of unexplained fs.external_change events (all for a given file,
 * already in chronological order by `t`), group them into coalesced windows.
 *
 * The 2-second window is measured between consecutive events' `t` values
 * (ms since session start). Two events on different sessions cannot be
 * coalesced even if their wall times overlap — the `t` field is session-local.
 * Therefore we coalesce only within sessions.
 */
function coalesceGroups(events: IndexedEvent[], windowMs: number): CoalescedGroup[] {
  if (events.length === 0) return [];

  const groups: CoalescedGroup[] = [];
  let currentGroup: CoalescedGroup | null = null;

  for (const e of events) {
    const diffSize = getDiffSize(e.payload);
    const file = getFilePath(e.payload);
    const op = getOperation(e.payload);

    if (currentGroup === null) {
      currentGroup = { file, events: [e], maxDiffSize: diffSize, operations: new Set([op]) };
      continue;
    }

    // Only coalesce within the same session (t is session-local).
    const prev = currentGroup.events[currentGroup.events.length - 1]!;
    const sameSession = prev.sessionId === e.sessionId;
    const withinWindow = sameSession && e.t - prev.t <= windowMs;

    if (withinWindow) {
      currentGroup.events.push(e);
      currentGroup.operations.add(op);
      if (diffSize > currentGroup.maxDiffSize) {
        currentGroup.maxDiffSize = diffSize;
      }
    } else {
      groups.push(currentGroup);
      currentGroup = { file, events: [e], maxDiffSize: diffSize, operations: new Set([op]) };
    }
  }

  if (currentGroup !== null) {
    groups.push(currentGroup);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Heuristic implementation
// ---------------------------------------------------------------------------

function run(index: EventIndex, bundle: Bundle, config: HeuristicConfig): Flag[] {
  const { coalesceWindowMs, highSeverityCharsChanged } = config.externalEdits;

  const externalEvents = index.byKind.get('fs.external_change') ?? [];
  const classification = externalChangeClassificationFor(bundle, index);

  // Separate by file, collecting only unexplained events.
  const unexplainedByFile = new Map<string, IndexedEvent[]>();
  for (const e of externalEvents) {
    // D1: never happened -- the recorder reported the editor's own save.
    if (index.selfInflictedExternalChanges?.has(e.globalIdx)) continue;
    // Tier 3.1: the bytes are a partner's recorded work delivered by git. Not an
    // external edit. Skipped here only -- the event stays in the index and in
    // the classification, so the timeline can still show it as reclassified.
    if (classification.gitMergeIn.has(e.globalIdx)) continue;
    if (isExplained(e.payload)) continue;
    const file = getFilePath(e.payload);
    let arr = unexplainedByFile.get(file);
    if (arr === undefined) {
      arr = [];
      unexplainedByFile.set(file, arr);
    }
    arr.push(e);
  }

  const flags: Flag[] = [];
  let flagIndex = 0;

  for (const [file, events] of unexplainedByFile) {
    // Events within a file are already in chronological order (byFile is ordered).
    const groups = coalesceGroups(events, coalesceWindowMs);

    for (const group of groups) {
      const severity: Severity = group.maxDiffSize > highSeverityCharsChanged ? 'high' : 'medium';

      const supportingSeqs = group.events.map((e) => `${e.sessionId}:${e.seq}`);
      const seqKey0 = supportingSeqs[0]!;
      const id = flagId(seqKey0, flagIndex++);

      const eventCount = group.events.length;
      // Build operation-aware description. A single-op group says exactly
      // what happened ("deleted", "created", "modified"); a mixed-op group
      // (e.g. delete→create from a tool that rewrites by replacing) lists
      // all observed operations.
      const ops = [...group.operations];
      const opLabel =
        ops.length === 1
          ? ops[0] === 'delete'
            ? 'deleted'
            : ops[0] === 'create'
              ? 'created'
              : 'modified'
          : `affected (${ops.sort().join(', ')})`;
      const plural = eventCount === 1 ? 'event' : 'events';

      // Tier 3.1. Empty string for a solo scope and for `external`, so those
      // descriptions and details stay byte-for-byte what they were.
      const verdict = leadVerdict(group.events, classification.byGlobalIdx);
      const classificationNote = describeClassification(verdict);

      flags.push({
        id,
        heuristic: 'external_edits',
        title: `Unexplained external edit(s) in ${file}`,
        severity,
        confidence: CONFIDENCE,
        supportingSeqs,
        description:
          `${file} was ${opLabel} outside VS Code (${eventCount} unexplained ${plural})` +
          (group.maxDiffSize > 0 ? ` (max ±${group.maxDiffSize} chars).` : '.') +
          classificationNote,
        detail: {
          file,
          eventCount,
          maxDiffSize: group.maxDiffSize,
          operations: ops,
          seqs: supportingSeqs,
          ...(verdict === null
            ? {}
            : {
                externalChangeClass: verdict.classification,
                externalChangeReason: verdict.reason?.kind ?? null,
                externalChangeDetail: verdict.detail,
              }),
        },
      });
    }
  }

  return flags;
}

export const externalEditsHeuristic: Heuristic = {
  id: 'external_edits',
  label: 'Unexplained external edits',
  run,
};
