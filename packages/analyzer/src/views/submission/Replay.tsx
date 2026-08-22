/**
 * Replay tab — feeds the v2 ReplayInner (transport bar, event sidebar,
 * jump controls, real-time playback, gutter decorations) with data fetched
 * from the server API.
 *
 * Data flow:
 *  1. useFullEventIndex(submissionId) → pages /events and builds an EventIndex
 *  2. useSubmissionData().useSummary() → session_ids + source_filename
 *  3. useSubmissionData().useFlags() → flag list for "next flag" jumps
 *  4. <ReplayInner index={…} sessionId={…} flags={…} sourceFilename={…} showHeader={false}/>
 *
 * Session selection: ?session= (or the session holding ?event=) is only an ENTRY
 * ANCHOR — where replay opens. It is never written back, because the playhead
 * roams the whole bundle and a URL that kept asserting one session would go stale
 * the moment playback crossed a seam. ?event= is the position of record, and the
 * session dropdown belongs to ReplayInner, which drives it off the playhead.
 */

import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import { useFullEventIndex } from '../../data/useFullEventIndex.js';
import { useServerScope } from '../../data/useServerScope.js';
import { buildGlobalSeqLookup } from '../../data/global-seq-lookup.js';
import { ReplayInner } from '../replay/ReplayView.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { FlagRow } from '@provenance/shared/api-schemas';

/**
 * Project the server's FlagRow shape onto the analyzer's Flag shape so the
 * v2 ReplayInner (and its JumpControls) can consume it.
 *
 * `Flag.supportingSeqs` are `${sessionId}:${seq}` keys that must resolve in
 * `index.bySeq`, so they are rebuilt by looking each supporting globalIdx up in
 * the index and reading the session off the event we find. This used to build
 * them as `${row.session_id}:${seq}`, which silently produced unresolvable
 * keys like ":4880" for every flag whose evidence spans more than one session —
 * `session_id` is '' in exactly that case — so "jump to next flag" did nothing
 * on the submissions where it matters most.
 *
 * Unresolvable seqs are dropped rather than passed through as broken keys: a
 * flag with no landable evidence should be skipped by the jump controls, not
 * jump to nowhere.
 */
export function toFlag(row: FlagRow, bySeq: ReadonlyMap<number, IndexedEvent>): Flag {
  const supportingSeqs: string[] = [];
  for (const globalIdx of row.supporting_seqs ?? []) {
    const event = bySeq.get(globalIdx);
    if (event !== undefined) supportingSeqs.push(`${event.sessionId}:${event.seq}`);
  }
  return {
    id: row.id,
    heuristic: row.heuristic_id,
    // Fall back to the id for flags stored before the server persisted prose.
    title: row.title !== undefined && row.title !== '' ? row.title : row.heuristic_id,
    severity: row.severity,
    confidence: row.confidence,
    supportingSeqs,
    description: row.description ?? '',
    ...(row.detail !== null && typeof row.detail === 'object'
      ? { detail: row.detail as Record<string, unknown> }
      : {}),
  };
}

export function Replay() {
  const { submissionId = '' } = useParams<{ submissionId: string }>();
  const provider = useSubmissionData();
  const [searchParams] = useSearchParams();

  const summaryQuery = provider.useSummary();
  const flagsQuery = provider.useFlags();
  const indexQuery = useFullEventIndex(submissionId);

  // Sessions known to the submission, in summary order.
  const sessionIds = useMemo(() => summaryQuery.data?.session_ids ?? [], [summaryQuery.data]);

  // globalIdx → event, for resolving anything that references an event by the
  // server's session-agnostic numbering (flag supporting seqs, ?event=).
  const bySeq = useMemo(() => buildGlobalSeqLookup(indexQuery.data ?? null), [indexQuery.data]);

  // Resolve the active session from the URL.
  //
  // Order matters: an explicit ?session= wins, but a bare ?event= (which is how
  // the flag drawer deep-links, since a supporting seq names an event without
  // naming a session) resolves to whichever session actually contains that
  // event. Falling straight through to sessionIds[0] would silently open the
  // wrong session for any evidence outside the first one.
  const urlSession = searchParams.get('session');
  const urlEvent = searchParams.get('event');
  const sessionId = useMemo(() => {
    if (urlSession !== null && sessionIds.includes(urlSession)) return urlSession;
    if (urlEvent !== null) {
      const globalIdx = parseInt(urlEvent, 10);
      const target = isNaN(globalIdx) ? undefined : bySeq.get(globalIdx);
      if (target !== undefined) return target.sessionId;
    }
    return sessionIds[0] ?? null;
  }, [urlSession, urlEvent, sessionIds, bySeq]);

  const sourceFilename = summaryQuery.data?.source_filename ?? '';

  // The reconstruction scope, from the paged rows plus the summary's contributor
  // stamp. Without it this tab took `soloReconstructionScope` — a statement that
  // the submission has one contributor — and so replayed two partners' unordered
  // work as one linear keystroke sequence, for a submission `/local` refuses to
  // linearize. Solo submissions get the `ordering: null` scope and are unchanged.
  const serverScope = useServerScope(indexQuery.data ?? null, summaryQuery.data);

  if (indexQuery.isLoading || summaryQuery.isLoading) {
    return (
      <StatusRegion className="container mx-auto py-12 text-center text-gray-600">
        <p className="text-sm" data-testid="replay-loading">
          Loading replay data…
        </p>
      </StatusRegion>
    );
  }

  if (indexQuery.isError) {
    return (
      <ErrorRegion className="container mx-auto py-12 text-center text-red-600">
        <p className="text-sm" data-testid="replay-error">
          Failed to load events: {String(indexQuery.error)}
        </p>
      </ErrorRegion>
    );
  }

  const index = indexQuery.data;
  if (index === undefined || sessionId === null) {
    return (
      <div
        className="container mx-auto py-12 text-center text-gray-400"
        data-testid="replay-no-session"
      >
        <p className="text-sm">No replayable session in this submission.</p>
      </div>
    );
  }

  if (!index.bySessionId.has(sessionId)) {
    return (
      <div
        className="container mx-auto py-12 text-center text-gray-400"
        data-testid="replay-session-missing"
      >
        <p className="text-sm">Session {sessionId.slice(0, 8)}… not present in event stream.</p>
      </div>
    );
  }

  // The session dropdown is ReplayInner's — it reads the playhead, so it stays
  // correct as playback crosses seams and it seeks instead of rewriting the URL.
  return (
    <div className="flex h-full flex-col" data-testid="replay-tab-shell">
      <div className="min-h-0 flex-1">
        <ReplayInner
          sessionId={sessionId}
          index={index}
          flags={(flagsQuery.data ?? []).map((row) => toFlag(row, bySeq))}
          sourceFilename={sourceFilename}
          showHeader={false}
          scope={serverScope?.scope ?? null}
          contributors={serverScope?.contributors ?? null}
        />
      </div>
    </div>
  );
}
