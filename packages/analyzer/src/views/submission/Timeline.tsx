/**
 * Timeline tab — the full events browser, backed by the server API.
 *
 * Mounts the same TimelineInner the /local route uses, against an EventIndex
 * built by paging GET /submissions/:id/events to exhaustion. This mirrors how
 * the Replay tab (views/submission/Replay.tsx) already sources its index.
 *
 * Previously this was a bespoke list: `events.slice(0, 500)` over a query
 * already capped at limit=2000, with no detail pane, no jump-to-replay, no
 * session filter, and no virtualization. Large submissions silently showed a
 * fraction of their events. The 200k ceiling in useFullEventIndex is now
 * surfaced as a visible error rather than being indistinguishable from a
 * small submission.
 */

import { useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { useFullEventIndex } from '../../data/useFullEventIndex.js';
import { useServerScope } from '../../data/useServerScope.js';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';
import { TimelineInner } from '../timeline/TimelineInner.js';
import { StatusRegion } from '../../components/a11y/StatusRegion.js';
import { ErrorRegion } from '../../components/a11y/ErrorRegion.js';

export function Timeline() {
  const { submissionId = '' } = useParams<{ submissionId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const indexQuery = useFullEventIndex(submissionId);
  const summaryQuery = useSubmissionData().useSummary();

  // The SAME scope the Replay tab builds, from the same two inputs. Without it
  // this tab ordered events by `globalIdx`, which is wall-derived and across two
  // machines can contradict proven happens-before — and it drew no break markers
  // where the order shown is not evidence.
  const serverScope = useServerScope(indexQuery.data ?? null, summaryQuery.data);

  // The Replay tab reads ?session= and ?event=; hand it both so it opens at
  // exactly this moment rather than at the session's first event.
  const handleJumpToReplay = useCallback(
    (event: IndexedEvent) => {
      const next = new URLSearchParams(searchParams);
      next.set('tab', 'replay');
      next.set('session', event.sessionId);
      next.set('event', String(event.globalIdx));
      setSearchParams(next);
    },
    [searchParams, setSearchParams],
  );

  // `submission-timeline` identifies the tab itself and is present in every
  // state — loading, error, empty, and loaded — so the shell can assert the tab
  // rendered without knowing which state it settled into.
  return <div data-testid="submission-timeline">{renderBody()}</div>;

  function renderBody() {
    if (indexQuery.isLoading) {
      return (
        <StatusRegion className="container mx-auto py-12 text-center text-gray-600">
          <p className="text-sm" data-testid="timeline-loading">
            Loading events…
          </p>
        </StatusRegion>
      );
    }

    if (indexQuery.isError) {
      return (
        <ErrorRegion className="container mx-auto py-12 text-center text-red-600">
          <p className="text-sm" data-testid="timeline-error">
            Failed to load events:{' '}
            {indexQuery.error instanceof Error
              ? indexQuery.error.message
              : String(indexQuery.error)}
          </p>
        </ErrorRegion>
      );
    }

    const index = indexQuery.data;
    if (index === undefined || index.ordered.length === 0) {
      return (
        <div
          className="container mx-auto py-12 text-center text-sm text-gray-600"
          data-testid="timeline-empty"
        >
          No events in this submission.
        </div>
      );
    }

    return (
      <TimelineInner
        index={index}
        onJumpToReplay={handleJumpToReplay}
        scope={serverScope?.scope ?? null}
      />
    );
  }
}
