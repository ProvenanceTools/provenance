/**
 * TimelineView — /local route wrapper around TimelineInner.
 *
 * Supplies the EventIndex from BundleContext and the /local replay target.
 * All behavior lives in TimelineInner, which the server-backed Timeline tab
 * mounts against an API-derived index.
 *
 * PRD §7.2 ("Raw timeline").
 */

import { useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBundle } from '../../context/BundleContext.js';
import type { IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import { reconstructionScopeFor } from '@provenance/analysis-core/index/reconstruct-segments.js';
import { TimelineInner } from './TimelineInner.js';

export function TimelineView() {
  const { index, bundles, selectedBundleId } = useBundle();
  const navigate = useNavigate();

  // The same memoized scope reconstruction uses, so the timeline and the file
  // views cannot disagree about who recorded what. Free for a solo bundle: the
  // scope is `ordering: null` and nothing builds a graph.
  const scope = useMemo(() => {
    if (index === null || selectedBundleId === null) return null;
    const bundle = bundles.find((b) => b.id === selectedBundleId);
    return bundle === undefined ? null : reconstructionScopeFor(bundle, index);
  }, [index, bundles, selectedBundleId]);

  const handleJumpToReplay = useCallback(
    (event: IndexedEvent) => {
      void navigate(`/local/replay/${event.sessionId}?event=${event.globalIdx}`);
    },
    [navigate],
  );

  return <TimelineInner index={index} onJumpToReplay={handleJumpToReplay} scope={scope} />;
}
