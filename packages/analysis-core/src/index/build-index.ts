/**
 * buildIndex — construct an EventIndex from a Bundle (Phase 3).
 *
 * PRD §7.3.
 *
 * Pure function: O(N log N) for the chronological sort; O(N) for the index
 * construction passes (maps, byFile, byKind, etc.).
 * Target: <100ms on a 10k-event bundle (see build-index.test.ts perf test).
 */

import type { EventKind } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { EventIndex, IndexedEvent } from './event-index.js';
import { isSelfInflictedSave, findEditDerivedExternalChanges } from './reconstruct-file.js';

// ---------------------------------------------------------------------------
// File-path extraction
// ---------------------------------------------------------------------------

/**
 * Extract the file path from an event payload, if the event kind carries one.
 *
 * This is the single place in the codebase that knows which event kinds have
 * a `path` field. All other code routes through this helper so that payload
 * shape changes only need to be updated here.
 *
 * Returns `undefined` for event kinds that don't carry a file path (e.g.
 * session.start, session.heartbeat, terminal.open, git.event, etc.).
 */
export function getFileFromPayload(kind: EventKind, payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;

  switch (kind) {
    case 'doc.open':
    case 'doc.change':
    case 'doc.save':
    case 'doc.close':
    case 'paste':
    case 'selection.change':
    case 'fs.external_change':
      // All of these carry a top-level `path` string.
      return typeof p['path'] === 'string' ? p['path'] : undefined;

    // focus.change carries gained/reason but no file path.
    // terminal.open, terminal.command, ext.snapshot, ext.activate,
    // session.start, session.heartbeat, session.end,
    // git.event, clock.skew, paste.anomaly, chain.broken,
    // recorder.degraded, recorder.recovered_from_corruption
    // — none of these carry a file-level path.
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// buildIndex
// ---------------------------------------------------------------------------

/**
 * Resolve workspace-root path aliases (D3).
 *
 * Paths are recorded relative to whichever folder the student opened. A student
 * who works on one file from two different workspace roots produces two
 * different relative paths for it — `hw.py` from the assignment folder, and
 * `sub/hw.py` from its parent. They then index as two unrelated files and the
 * events from one root are silently orphaned.
 *
 * Returns a map of alias path → canonical (manifest-named) path. An alias is
 * only accepted when ALL of the following hold:
 *
 *   - the canonical path `P` is named in the manifest's submission_files,
 *   - the alias `X/P` is NOT itself named in submission_files (it would be a
 *     real, distinct submitted file),
 *   - the two paths appear in DISJOINT session sets.
 *
 * The disjointness rule is what makes this safe. A single workspace root yields
 * exactly one relative path per file, so a genuine alias can never appear
 * alongside its canonical form inside one session. Two genuinely different
 * files that merely share a basename (`hw.py` and `old/hw.py`, both real) would
 * be edited from the same root and therefore appear together in at least one
 * session — so they are left alone. When in doubt this refuses to merge, which
 * is the safe direction: an un-merged file reconstructs partially, a wrongly
 * merged one reconstructs garbage.
 *
 * See `.notes/reconstruction-triage.md` (D3).
 */
export function resolveWorkspaceRootAliases(
  bundle: Bundle,
  sessionsByPath: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, string> {
  const aliases = new Map<string, string>();
  const manifestPaths = new Set(
    (bundle.manifest.submission_files ?? [])
      .map((f) => f.path)
      .filter((p) => typeof p === 'string'),
  );
  if (manifestPaths.size === 0) return aliases;

  for (const [candidate, candidateSessions] of sessionsByPath) {
    if (manifestPaths.has(candidate)) continue; // already canonical
    for (const canonical of manifestPaths) {
      if (!candidate.endsWith('/' + canonical)) continue;
      const canonicalSessions = sessionsByPath.get(canonical);
      if (canonicalSessions === undefined) continue;
      let overlaps = false;
      for (const s of candidateSessions) {
        if (canonicalSessions.has(s)) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) aliases.set(candidate, canonical);
      break;
    }
  }
  return aliases;
}

/**
 * Build an EventIndex from a fully-loaded Bundle.
 *
 * Algorithm:
 *  1. Flatten all events from all sessions into a single array, tagging each
 *     with its sessionId.
 *  1b. Canonicalize workspace-root path aliases (D3) so one file has one key.
 *  2. Sort by (wall, sessionId, seq) — wall is the primary key; ties are
 *     broken deterministically by sessionId then seq.
 *  3. Walk the sorted array once, assigning globalIdx and populating all
 *     index maps in a single pass.
 */
/**
 * Compute the workspace-root alias map for a bundle without building a full
 * index. Used by consumers that scan `bundle.sessions` directly (e.g. check 8,
 * `verify-submitted-code.ts`) so they resolve the same canonical paths that
 * `buildIndex` does. Same rules — see `resolveWorkspaceRootAliases`.
 */
export function resolveAliasesForBundle(bundle: Bundle): Map<string, string> {
  const sessionsByPath = new Map<string, Set<string>>();
  for (const session of bundle.sessions) {
    for (const envelope of session.events) {
      const file = getFileFromPayload(envelope.kind, envelope.data);
      if (file === undefined) continue;
      let set = sessionsByPath.get(file);
      if (set === undefined) {
        set = new Set();
        sessionsByPath.set(file, set);
      }
      set.add(session.sessionId);
    }
  }
  return resolveWorkspaceRootAliases(bundle, sessionsByPath);
}

export function buildIndex(bundle: Bundle): EventIndex {
  // ---------------------------------------------------------------------------
  // Step 1: flatten
  // ---------------------------------------------------------------------------
  type FlatEvent = {
    sessionId: string;
    seq: number;
    wall: string;
    t: number;
    kind: EventKind;
    payload: unknown;
    // Optional, omitted entirely when there is no path (exactOptionalPropertyTypes).
    file?: string;
  };

  // ---------------------------------------------------------------------------
  // ONE logical session is replayed ONCE, however many files record it.
  //
  // `bundle.sessions` deliberately carries every `.slog` that claims a logical
  // session id — a log duplicated under a second filename by a hand copy of
  // `.provenance/`, a backup taken before a push, an odd merge. Two consumers
  // genuinely need all of them: the rolling seal is resolved on what the
  // claimants AGREE about (`resolveAmbiguousCoverage`, bug 12), and the witness
  // reconciler answers `indeterminate` rather than the harsher `tip_mismatch`
  // when they disagree. Removing the duplicate upstream in `parse-bundle.ts`
  // silently took both of those answers away — measured, not assumed: it turned
  // two `witness/reconcile-witnesses.test.ts` cases red, one of them by
  // producing exactly the harsher verdict that test exists to prevent.
  //
  // The INDEX is the one consumer that must not see them all. It dedupes only
  // `bySeq` (a Map); `byKind`, `byFile` and `bySessionId` all push. So a second
  // copy replayed every delta twice: `reconstructFile` returned content the
  // student never wrote ("x2x2x1x1" for a file written as "x2x1"), `charsTyped`
  // doubled, and every heuristic dividing by it saw a fabricated denominator.
  //
  // Ties break on `slogSha256` — content-derived, so the choice depends on
  // neither the archive's entry order nor either id space, and the server's
  // repeated re-parses of one stored blob agree with each other. WHICH copy is
  // observable only when the copies disagree, and that case is already reported
  // (an `ambiguous_session_log` defect naming both files, and coverage
  // degraded to `indeterminate`). Replaying both is not the cautious
  // alternative to choosing one: it is the only option that invents events.
  const sessionsToReplay = [...bundle.sessions]
    .sort((a, b) => (a.slogSha256 < b.slogSha256 ? -1 : a.slogSha256 > b.slogSha256 ? 1 : 0))
    .filter((s, i, all) => all.findIndex((o) => o.sessionId === s.sessionId) === i);

  const flat: FlatEvent[] = [];
  for (const session of sessionsToReplay) {
    for (const envelope of session.events) {
      const file = getFileFromPayload(envelope.kind, envelope.data);
      const event: FlatEvent = {
        sessionId: session.sessionId,
        seq: envelope.seq,
        wall: envelope.wall,
        t: envelope.t,
        kind: envelope.kind,
        payload: envelope.data,
      };
      if (file !== undefined) {
        event.file = file;
      }
      flat.push(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Step 1b: canonicalize workspace-root path aliases (D3).
  //
  // Done before sorting/indexing so every downstream consumer — byFile,
  // reconstruction, heuristics, stats — sees one file under one key.
  // ---------------------------------------------------------------------------
  const sessionsByPath = new Map<string, Set<string>>();
  for (const f of flat) {
    if (f.file === undefined) continue;
    let set = sessionsByPath.get(f.file);
    if (set === undefined) {
      set = new Set();
      sessionsByPath.set(f.file, set);
    }
    set.add(f.sessionId);
  }
  const pathAliases = resolveWorkspaceRootAliases(bundle, sessionsByPath);
  if (pathAliases.size > 0) {
    for (const f of flat) {
      if (f.file === undefined) continue;
      const canonical = pathAliases.get(f.file);
      if (canonical !== undefined) f.file = canonical;
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: sort
  //
  // Tie-break rule (documented in IndexedEvent.globalIdx JSDoc):
  //   primary: wall (lexicographic ISO string compare = chronological)
  //   secondary: sessionId (deterministic across identical walls)
  //   tertiary: seq (natural ordering within session)
  // ---------------------------------------------------------------------------
  flat.sort((a, b) => {
    if (a.wall < b.wall) return -1;
    if (a.wall > b.wall) return 1;
    if (a.sessionId < b.sessionId) return -1;
    if (a.sessionId > b.sessionId) return 1;
    return a.seq - b.seq;
  });

  // ---------------------------------------------------------------------------
  // Step 3: single-pass index construction
  // ---------------------------------------------------------------------------
  const bySeq = new Map<string, IndexedEvent>();
  const byKind = new Map<EventKind, IndexedEvent[]>();
  const byFile = new Map<string, IndexedEvent[]>();
  const bySessionId = new Map<string, IndexedEvent[]>();
  const ordered: IndexedEvent[] = [];

  for (let i = 0; i < flat.length; i++) {
    const f = flat[i]!;

    const event: IndexedEvent = {
      sessionId: f.sessionId,
      seq: f.seq,
      globalIdx: i, // ordered[i].globalIdx === i
      wall: f.wall,
      t: f.t,
      kind: f.kind,
      payload: f.payload,
      ...(f.file !== undefined ? { file: f.file } : {}),
    };

    ordered.push(event);

    // bySeq
    bySeq.set(`${f.sessionId}:${f.seq}`, event);

    // byKind
    let kindArr = byKind.get(f.kind);
    if (kindArr === undefined) {
      kindArr = [];
      byKind.set(f.kind, kindArr);
    }
    kindArr.push(event);

    // byFile
    if (f.file !== undefined) {
      let fileArr = byFile.get(f.file);
      if (fileArr === undefined) {
        fileArr = [];
        byFile.set(f.file, fileArr);
      }
      fileArr.push(event);
    }

    // bySessionId
    let sessionArr = bySessionId.get(f.sessionId);
    if (sessionArr === undefined) {
      sessionArr = [];
      bySessionId.set(f.sessionId, sessionArr);
    }
    sessionArr.push(event);
  }

  // D1: identify recorder-self-inflicted external changes once, so
  // reconstruction and all heuristics share one verdict.
  const selfInflictedExternalChanges = new Set<number>();
  for (const events of byFile.values()) {
    // D1c needs one replay of the file, so it is computed per file rather than
    // per event. D1/D1b stay per event — they are local scans.
    const editDerived = findEditDerivedExternalChanges(events);
    for (let i = 0; i < events.length; i++) {
      const e = events[i]!;
      if (e.kind !== 'fs.external_change') continue;
      if (editDerived.has(e.globalIdx) || isSelfInflictedSave(events, i)) {
        selfInflictedExternalChanges.add(e.globalIdx);
      }
    }
  }

  return {
    bySeq,
    byKind,
    byFile,
    bySessionId,
    ordered,
    pathAliases,
    selfInflictedExternalChanges,
  };
}

// ---------------------------------------------------------------------------
// buildIndexFromEventRows
// ---------------------------------------------------------------------------

/**
 * Row shape returned by GET /submissions/:id/events. Defined locally rather
 * than imported from @provenance/shared to keep this module dependency-free.
 */
export type ServerEventRow = {
  seq: number;
  kind: string;
  t: number;
  wall: string;
  session_id: string;
  payload: unknown;
};

/**
 * Build an EventIndex from a flat list of server-shape event rows.
 *
 * Used by the v3 Replay tab, which fetches events directly from the API
 * rather than parsing a local ZIP bundle. Mirrors buildIndex's
 * sort + single-pass construction.
 */
export function buildIndexFromEventRows(rows: ReadonlyArray<ServerEventRow>): EventIndex {
  type FlatEvent = {
    sessionId: string;
    seq: number;
    wall: string;
    t: number;
    kind: EventKind;
    payload: unknown;
    file?: string;
  };

  const flat: FlatEvent[] = rows.map((r) => {
    const kind = r.kind as EventKind;
    const file = getFileFromPayload(kind, r.payload);
    const event: FlatEvent = {
      sessionId: r.session_id,
      seq: r.seq,
      wall: r.wall,
      t: r.t,
      kind,
      payload: r.payload,
    };
    if (file !== undefined) {
      event.file = file;
    }
    return event;
  });

  flat.sort((a, b) => {
    if (a.wall < b.wall) return -1;
    if (a.wall > b.wall) return 1;
    if (a.sessionId < b.sessionId) return -1;
    if (a.sessionId > b.sessionId) return 1;
    return a.seq - b.seq;
  });

  const bySeq = new Map<string, IndexedEvent>();
  const byKind = new Map<EventKind, IndexedEvent[]>();
  const byFile = new Map<string, IndexedEvent[]>();
  const bySessionId = new Map<string, IndexedEvent[]>();
  const ordered: IndexedEvent[] = [];

  for (let i = 0; i < flat.length; i++) {
    const f = flat[i]!;
    const event: IndexedEvent = {
      sessionId: f.sessionId,
      seq: f.seq,
      globalIdx: i,
      wall: f.wall,
      t: f.t,
      kind: f.kind,
      payload: f.payload,
      ...(f.file !== undefined ? { file: f.file } : {}),
    };

    ordered.push(event);
    bySeq.set(`${f.sessionId}:${f.seq}`, event);

    let kindArr = byKind.get(f.kind);
    if (kindArr === undefined) {
      kindArr = [];
      byKind.set(f.kind, kindArr);
    }
    kindArr.push(event);

    if (f.file !== undefined) {
      let fileArr = byFile.get(f.file);
      if (fileArr === undefined) {
        fileArr = [];
        byFile.set(f.file, fileArr);
      }
      fileArr.push(event);
    }

    let sessionArr = bySessionId.get(f.sessionId);
    if (sessionArr === undefined) {
      sessionArr = [];
      bySessionId.set(f.sessionId, sessionArr);
    }
    sessionArr.push(event);
  }

  return { bySeq, byKind, byFile, bySessionId, ordered };
}

// ---------------------------------------------------------------------------
// sessionsFromEventRows
// ---------------------------------------------------------------------------

/**
 * Regroup a flat list of server-shape rows into the per-session shape the
 * ordering tiers take (`ObservedDagSource` / `EventOrderingSource`).
 *
 * The companion to {@link buildIndexFromEventRows}: that one produces the
 * `EventIndex`, this one produces the second half of what
 * `buildReconstructionScopeFromSessions` needs, so a client with nothing but
 * an index built from paged rows can build the SAME happens-before relation the
 * server builds from the parsed bundle. Without it, every server-backed surface
 * — Replay and Timeline both — has no choice but to assume one contributor.
 *
 * Takes the INDEX rather than the rows, deliberately. Every consumer already
 * holds an index and not all of them still hold the rows that produced it, and
 * `index.bySessionId` carries the four fields the ordering tiers read, in full,
 * for both a row-built and a bundle-built index. One input, both callers.
 *
 * Two things this deliberately does not do:
 *
 *  - It does not invent `hash` / `prev_hash`. The ordering tiers read `seq`,
 *    `kind`, `wall` and `data` and nothing else (`SourceEnvelope`), and writing
 *    empty strings into hash fields to satisfy a type would put a value that
 *    looks like a chain where there is no chain.
 *  - It does not re-order sessions. Sessions appear in `bySessionId` order;
 *    `buildEventOrdering` sorts session ids itself, so nothing downstream
 *    depends on the choice.
 *
 * Events within a session are sorted by `seq` — the hash chain's own order, and
 * the one `buildSegments` and the observation buckets assume. That matters here
 * rather than being belt-and-braces: an index's own order is `globalIdx`, which
 * is WALL-derived and across two machines can contradict the chain.
 */
export function sessionsFromIndex(index: EventIndex): {
  sessions: {
    sessionId: string;
    events: { seq: number; kind: string; wall: string; data: unknown }[];
  }[];
} {
  const sessions: {
    sessionId: string;
    events: { seq: number; kind: string; wall: string; data: unknown }[];
  }[] = [];
  for (const [sessionId, events] of index.bySessionId) {
    sessions.push({
      sessionId,
      events: [...events]
        .sort((a, b) => a.seq - b.seq)
        .map((e) => ({ seq: e.seq, kind: e.kind, wall: e.wall, data: e.payload })),
    });
  }
  return { sessions };
}
