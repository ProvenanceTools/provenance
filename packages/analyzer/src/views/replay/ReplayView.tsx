/**
 * ReplayView — top-level layout for the /replay/:sessionId route.
 *
 * Layout (Phase 14):
 *   ┌─────────────────────────────────────┬──────────────┐
 *   │ SessionSelect │ FileTabs            │              │
 *   ├─────────────────────────────────────┤ EventSidebar │
 *   │ MonacoMount (70% width)             │ (30% width)  │
 *   │ + GutterDecorations (headless)      │              │
 *   │ + LineHoverProvider (headless)      │              │
 *   │ + ColorLegend (overlay)             │              │
 *   ├─────────────────────────────────────┴──────────────┤
 *   │ TransportBar (full width)                          │
 *   └────────────────────────────────────────────────────┘
 *
 * Route guard:
 *   - Requires a loaded bundle (RequireBundle via App.tsx wrapping this route).
 *   - Requires that sessionId exists in the selected bundle's index.
 *     If not found: redirects to /overview with console.warn.
 *     Design choice (A34): /overview rather than /load because the user has a
 *     loaded bundle and /overview gives them a useful view with session info.
 *
 * URL state:
 *   ?event=:globalIdx  — current position (written back on change, debounced ~100ms).
 *   ?speed=:n          — playback speed (written back on state change).
 *   ?skipIdle=0|1      — idle-gap compression. Defaults ON; only `0` opts out.
 *   ?split=0|1         — split contributor lanes. Absent defaults ON for a
 *                        multi-contributor bundle and OFF otherwise, and is
 *                        written back ONLY when a human touches the toggle —
 *                        see `handleSplitToggle` for why it is not mirrored on
 *                        every write-back the way `skipIdle` is.
 *
 *   On mount: parse params → seek(event).
 *   On state change: debounced write-back.
 *   Pattern mirrors TimelineView's A16 deep-link approach.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, Navigate, useNavigate } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import type * as MonacoType from 'monaco-editor';
import { useBundle } from '../../context/BundleContext.js';
import type { EventIndex, IndexedEvent } from '@provenance/analysis-core/index/event-index.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import { reconstructionScopeFor } from '@provenance/analysis-core/index/reconstruct-segments.js';
import type { ReconstructionScope } from '@provenance/analysis-core/index/reconstruct-segments.js';
import type { BundleContributors } from '@provenance/analysis-core/identity/types.js';
import type { FileReplayState } from '@provenance/analysis-core/index/reconstruct-file-provenance.js';
import { useReplayEngine } from './useReplayEngine.js';
import { FileTabs } from './FileTabs.js';
import { SessionSelect } from './SessionSelect.js';
import { ContributorSelect } from './ContributorSelect.js';
import { SplitLanesToggle } from './SplitLanesToggle.js';
import { ReplayLanes } from './ReplayLanes.js';
import type { LaneCell } from './lane-groups.js';
import { buildContributorPalette } from './contributor-palette.js';
import { buildContributorActivity, RIBBON_IDLE_GAP_MS } from './contributor-activity.js';
import { activeFilesAt, buildActiveFileTimelines } from './contributor-active-file.js';
import { labelContributor } from './contributor-labels.js';
import type { RibbonRow } from './ContributorRibbons.js';
import { BranchedFileView } from './BranchedFileView.js';
import { MonacoMount, languageFromPath } from './MonacoMount.js';
import { TransportBar } from './TransportBar.js';
import { SpeedControl } from './SpeedControl.js';
import { SkipIdleToggle } from './SkipIdleToggle.js';
import { JumpControls } from './JumpControls.js';
import { GutterDecorations } from './GutterDecorations.js';
import { LineHoverProvider } from './LineHoverProvider.js';
import { EventSidebar } from './EventSidebar.js';
import { ColorLegend } from './ColorLegend.js';
import { FocusAwayOverlay } from './FocusAwayOverlay.js';
import { currentFocusAwaySpan, currentEditedFile } from './focus-and-follow.js';
import type { FocusAwayState } from './focus-and-follow.js';
import { CursorMarker } from './CursorMarker.js';
import { FollowCursor } from './FollowCursor.js';
import { currentSelection } from './cursor-position.js';
import { currentExternalChange, externalChangePosition } from './external-change-focus.js';
import {
  findNextPaste,
  findNextExternalChange,
  findNextFlag,
  findNextFileSwitch,
  buildFlaggedGlobalIdxSet,
  countRemainingPastes,
  countRemainingExternalChanges,
  countRemainingFlags,
  countRemainingFileSwitches,
  findNextSeam,
  countRemainingSeams,
} from './jump-predicates.js';
import { buildFlaggedSeamIdxs } from './seam-flags.js';

// ---------------------------------------------------------------------------
// ReplayHeader — back button + which bundle you're looking at.
// Sits above the FileTabs row; shrink-0 so it doesn't compete with the editor.
//
// Deliberately says nothing about sessions. The route's :sessionId is only an
// ENTRY ANCHOR — the playhead moves across sessions freely once replay starts —
// so naming it here (label or tooltip) would go stale the moment you press play.
// Session identity lives in exactly one place: <SessionSelect>, which reads the
// playhead rather than the URL.
// ---------------------------------------------------------------------------

interface ReplayHeaderProps {
  sourceFilename: string;
}

function ReplayHeader({ sourceFilename }: ReplayHeaderProps) {
  const navigate = useNavigate();

  const handleBack = () => {
    // go back in history if there's a previous entry, else fall back to /local/overview.
    if (window.history.length > 1) {
      navigate(-1);
    } else {
      void navigate('/local/overview');
    }
  };

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b bg-background px-4"
      style={{ height: '44px' }}
      data-testid="replay-header"
    >
      <button
        type="button"
        onClick={handleBack}
        className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        data-testid="replay-back-btn"
        aria-label="Back"
      >
        <ChevronLeft className="h-4 w-4" />
        Back
      </button>
      <span className="mx-2 h-4 border-l" aria-hidden="true" />
      <span className="min-w-0 truncate text-xs text-muted-foreground" title={sourceFilename}>
        {sourceFilename}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LanePane — the content pane inside one split lane.
//
// This is `ReplayLanes`' `renderPane`, factored out as a real component for one
// reason that is not stylistic: EACH LANE NEEDS ITS OWN EDITOR HANDLE. The
// single-pane path keeps `monacoEditor` in `ReplayInner` state because there is
// exactly one editor; with three lanes mounting three editors, one shared
// `useState` would end up holding whichever mounted last and
// `GutterDecorations` would then paint one lane's provenance onto another
// lane's file. Owning the handle here makes the pairing structural rather than
// a thing to remember.
//
// Deliberately NOT mounted here, and each for a stated reason:
//
//  - `LineHoverProvider` registers a hover provider with the monaco NAMESPACE,
//    keyed by language, not with one editor. Three lanes on three .py files
//    would register three providers each answering for a different file, and
//    Monaco would show all three on any hover. The single pane keeps its hover
//    exactly as it is; lanes go without rather than showing a hover that may
//    describe a different lane's line.
//  - `ColorLegend` is one absolutely-positioned overlay for the code area. It
//    is mounted ONCE by the lane container, not per lane — it explains the
//    gutter colours, which are the same colours in every lane.
//
// `FocusAwayOverlay` IS mounted here, gated on `ownsCaret` exactly like the
// caret and follow-cursor below it, for the same reason: it must belong to
// ONE contributor. Rendering it over every lane (the outer, whole-code-area
// placement this component used before) would claim every contributor had
// tabbed away, on the evidence of one of them. `ReplayLanes`' `replay-lane-pane`
// wrapper is `position: relative`, so the overlay's `absolute inset-0` is
// confined to THIS lane's content area — below its header and file strip,
// never over them, and never reaching another lane's DOM subtree at all.
//
// `ownsCaret` alone is not enough, though: it says WHICH LANE may show an
// overlay, not whose evidence that overlay is allowed to show. The
// `focusAway` prop passed in here is `laneFocusAway` (`ReplayInner`) —
// `currentFocusAwaySpan` FILTERED to the owning contributor's own session
// IDs, not the unfiltered whole-bundle scan the single pane still uses. Pass
// the unfiltered value here by mistake and a lane would show ownsCaret's
// contributor drawn accurately, but be washed red by a DIFFERENT
// contributor's `focus.change` — a false accusation with a name attached to
// it, which is strictly worse than the un-attributed wash this component
// replaced.
//
// The caret (`CursorMarker`) and the viewport-follow (`FollowCursor`) render
// only when `ownsCaret` — design §7: "a stale caret drawn in another lane would
// imply live presence at a position that contributor left."
// ---------------------------------------------------------------------------

type LanePaneProps = {
  readonly filePath: string;
  readonly fileState: FileReplayState | null;
  readonly ownsCaret: boolean;
  readonly events: readonly IndexedEvent[];
  readonly currentGlobalIdx: number;
  /** The focus-away state, filtered to the OWNING contributor's own sessions
   *  (`laneFocusAway` in `ReplayInner`) — never the unfiltered whole-bundle
   *  scan. Only painted in the lane that owns the caret — see the header
   *  above, and `currentFocusAwaySpan`'s header for why the filter matters. */
  readonly focusAway: FocusAwayState;
};

function LanePane({
  filePath,
  fileState,
  ownsCaret,
  events,
  currentGlobalIdx,
  focusAway,
}: LanePaneProps) {
  const [editor, setEditor] = useState<MonacoEditorNS.IStandaloneCodeEditor | null>(null);

  const handleMount = useCallback((ed: MonacoEditorNS.IStandaloneCodeEditor) => {
    setEditor(ed);
  }, []);

  const content = fileState?.content ?? '';

  // Both scans are gated on `ownsCaret`, so at most ONE lane pays for them per
  // frame — the same single scan the one-pane path already does.
  const selection = useMemo(
    () => (ownsCaret ? currentSelection(events, currentGlobalIdx, filePath) : null),
    [ownsCaret, events, currentGlobalIdx, filePath],
  );
  const heldByExternalChange = useMemo(
    () => (ownsCaret ? currentExternalChange(events, currentGlobalIdx, filePath) : null),
    [ownsCaret, events, currentGlobalIdx, filePath],
  );
  const externalChangeFocus = useMemo(
    () => externalChangePosition(fileState, heldByExternalChange),
    [fileState, heldByExternalChange],
  );

  return (
    <>
      <MonacoMount
        content={content}
        filePath={filePath}
        className="h-full w-full"
        onMount={handleMount}
      />
      <GutterDecorations editor={editor} fileState={fileState} />
      {ownsCaret && (
        <>
          <CursorMarker editor={editor} selection={selection} />
          <FollowCursor
            editor={editor}
            selection={selection}
            externalChange={externalChangeFocus}
            content={content}
            verticalOnly
          />
        </>
      )}
      {ownsCaret && focusAway !== null && <FocusAwayOverlay reason={focusAway.reason} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// ReplayView — entry + session guard
// ---------------------------------------------------------------------------

/**
 * ReplayView is split into two components so that all hooks always execute
 * in the same order regardless of the guard result (React rules of hooks).
 *
 * ReplayView:
 *   1. Reads sessionId from URL params.
 *   2. Reads index from BundleContext.
 *   3. If session not found → <Navigate to="/local/overview" />.
 *   4. Otherwise renders <ReplayViewInner>.
 *
 * ReplayViewInner:
 *   - Only called when session is confirmed present.
 *   - Contains all engine + URL-state logic.
 */
export function ReplayView() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { index, flags, bundles, selectedBundleId } = useBundle();

  const sessionExists = useMemo(() => {
    if (index === null || !sessionId) return false;
    return index.bySessionId.has(sessionId);
  }, [index, sessionId]);

  const selectedBundle = useMemo(
    () => bundles.find((b) => b.id === selectedBundleId) ?? bundles[0] ?? null,
    [bundles, selectedBundleId],
  );
  const sourceFilename = selectedBundle?.sourceFilename ?? '';

  // The same memoized scope the timeline and the file views use, so no two tabs
  // can disagree about who recorded what. Free for a solo bundle: the scope is
  // `ordering: null` and nothing builds a graph.
  const scope = useMemo(
    () =>
      index === null || selectedBundle === null
        ? null
        : reconstructionScopeFor(selectedBundle, index),
    [index, selectedBundle],
  );

  if (!sessionId || index === null || !sessionExists) {
    if (sessionId && index !== null && !sessionExists) {
      console.warn(
        `[ReplayView] session "${sessionId}" not found in index; redirecting to /local/overview`,
      );
    }
    return <Navigate to="/local/overview" replace />;
  }

  return (
    <ReplayInner
      sessionId={sessionId}
      index={index}
      flags={flags}
      sourceFilename={sourceFilename}
      showHeader={true}
      scope={scope}
      contributors={selectedBundle?.contributors ?? null}
    />
  );
}

// ---------------------------------------------------------------------------
// ReplayInner — engine + UI, no BundleContext dependency
// ---------------------------------------------------------------------------

export type ReplayInnerProps = {
  sessionId: string;
  index: EventIndex;
  flags: Flag[];
  /** Shown in ReplayHeader's context label. Pass empty string to skip. */
  sourceFilename: string;
  /** Render the back-button header above FileTabs. Default true (used by /local). */
  showHeader?: boolean;
  /**
   * The reconstruction scope for `index`. Lets replay refuse to render a file
   * whose content at the playhead has no single truth, instead of picking a
   * branch (Tier 2.2, spec §6 Rule 4).
   *
   * A SCOPE rather than a `Bundle`, deliberately and for the same reason
   * `TimelineInner` takes one: `/local` builds it with
   * `reconstructionScopeFor(bundle, index)`, and the server-backed tab builds
   * the identical thing from the paged rows plus the summary's contributor
   * stamp (`useServerScope`). A `Bundle` prop could only ever be supplied by one
   * of the two, which is exactly how the deployed tab ended up silently taking
   * the solo scope while `/local` refused to linearize the same submission.
   *
   * Omitted, or `ordering: null` inside it (a scope with fewer than two provably
   * different contributors), is the untouched linear behaviour.
   */
  scope?: ReconstructionScope | null | undefined;
  /**
   * The bundle-level contributor stamp, for the switcher. `null` renders no
   * switcher at all — the right answer both for a solo submission and for an
   * unstamped one, and never an apologetic empty control.
   */
  contributors?: BundleContributors | null | undefined;
};

export function ReplayInner({
  sessionId,
  index,
  flags,
  sourceFilename,
  showHeader = true,
  scope = null,
  contributors = null,
}: ReplayInnerProps) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Idle-gap compression. Default ON — a recorded session is mostly waiting,
  // and raising the speed multiplier alone never removes the dead air. `?skipIdle=0`
  // opts out; any other value (or none) leaves it on.
  const [skipIdle, setSkipIdle] = useState<boolean>(() => searchParams.get('skipIdle') !== '0');

  // Split contributor lanes (design §3 "Default state", §7 "Wiring").
  //
  // DERIVED on every render, deliberately NOT `useState` — do not "make it
  // consistent" with `skipIdle` above. The difference is where the default
  // comes from: `skipIdle`'s is a constant, so a lazy initializer that runs
  // once at mount can never go stale. `split`'s default is derived from DATA —
  // `contributors`, a prop — and `/local` changes that prop on an
  // already-mounted view when the bundle selector switches submissions. A
  // captured default would then describe a bundle the reader has left: switch
  // from a solo submission to a two-contributor one and lanes would stay off
  // with nothing on screen explaining why, short of a reload.
  //
  // So the URL is the single source of truth and the fallback is recomputed
  // from current props: `'0'`/`'1'` mean an explicit human choice, which always
  // wins in both directions, and absence means "on for more than one
  // contributor" — the on-by-default behaviour change design §3 accepts
  // knowingly. `handleSplitToggle` only writes the param; there is no setter
  // and nothing to keep in sync.
  const splitParam = searchParams.get('split');
  const split =
    splitParam === '0'
      ? false
      : splitParam === '1'
        ? true
        : contributors !== null && contributors.contributors.length > 1;

  const engine = useReplayEngine(index, { skipIdle, scope });
  const { state, fileStates, files, seams, fileAmbiguity, play, pause, step, seek } = engine;

  // Active file tab — null means "use first file".
  const [activeFile, setActiveFile] = useState<string | null>(null);

  // Resolved file: either the selected tab or the first available file.
  const resolvedFile = activeFile ?? files[0] ?? null;

  // Content for Monaco.
  const content = resolvedFile !== null ? (fileStates.get(resolvedFile)?.content ?? '') : '';

  // FileReplayState for the active file (used by GutterDecorations + LineHoverProvider).
  const activeFileState = resolvedFile !== null ? (fileStates.get(resolvedFile) ?? null) : null;

  // Set when the active file has no single content at the playhead (Tier 2.2),
  // carrying the branches when it is `concurrent`. Always undefined for a
  // single-contributor bundle.
  const ambiguity = resolvedFile !== null ? fileAmbiguity.get(resolvedFile) : undefined;

  // Total event count for the bundle (passed to TransportBar).
  const eventCount = index?.ordered.length ?? 0;

  // The whole bundle's events, across every session. Replay is not scoped to a
  // session: the sidebar, jump targets, focus-away spans, and edited-file
  // tracking all span the full submission.
  const bundleEvents = useMemo(() => index?.ordered ?? [], [index]);

  // ---------------------------------------------------------------------------
  // Split lanes — derived inputs.
  //
  // Everything below is gated on `laneMode` and yields `null` when lanes are
  // off, so an opted-out session and every solo submission pay one boolean and
  // nothing else. That is design §7's hard requirement read as a COST statement
  // as well as a markup one: a feature nobody asked for must not walk the event
  // stream on their behalf.
  //
  // The memo dependency lists are the load-bearing part here:
  //
  //  - `activity` depends on the INDEX and the session→contributor map, and
  //    pointedly NOT on the playhead. Activity runs are a property of the whole
  //    stream; recomputing them per frame would make playback O(events) per
  //    tick — quadratic over a playthrough — for a ribbon that never changes.
  //  - `activeFileTimelines` is likewise per-stream, built once.
  //  - `activeFileByContributor` is the ONE thing that legitimately moves with
  //    the playhead, and it is a binary search per contributor over the
  //    precomputed change points, not a scan (see `contributor-active-file.ts`).
  // ---------------------------------------------------------------------------

  const laneMode = split && contributors !== null && contributors.contributors.length > 1;

  const palette = useMemo(
    () => (contributors === null ? null : buildContributorPalette(contributors.contributors)),
    [contributors],
  );

  // Prefer the SCOPE's map — it is the one reconstruction itself reasoned with,
  // so ribbons and panes can never disagree about who owns a session. The stamp
  // is the fallback for a caller that supplied contributors but no scope.
  const contributorBySession = scope?.contributorBySession ?? contributors?.bySession ?? null;

  const activity = useMemo(
    () =>
      !laneMode || contributorBySession === null
        ? null
        : buildContributorActivity(index.ordered, contributorBySession, {
            idleGapMs: RIBBON_IDLE_GAP_MS,
          }),
    [laneMode, index, contributorBySession],
  );

  const activeFileTimelines = useMemo(() => {
    if (!laneMode || contributors === null) return null;
    const sessionIdsByContributor = new Map<string, ReadonlySet<string>>(
      contributors.contributors.map((c) => [c.key, new Set(c.sessionIds)]),
    );
    return buildActiveFileTimelines(index.ordered, sessionIdsByContributor);
  }, [laneMode, index, contributors]);

  const activeFileByContributor = useMemo(
    () =>
      activeFileTimelines === null
        ? null
        : activeFilesAt(activeFileTimelines, state.currentGlobalIdx),
    [activeFileTimelines, state.currentGlobalIdx],
  );

  // Mirrors the render guard below (`laneMode && contributors !== null &&
  // activeFileByContributor !== null && palette !== null`) as a plain boolean,
  // so the single-pane `FocusAwayOverlay` placement can ask "is the lane grid
  // actually on screen" without re-narrowing three nullable values inline —
  // narrowing that JSX ternary already does for `ReplayLanes`' props.
  const showLaneGrid =
    laneMode && contributors !== null && activeFileByContributor !== null && palette !== null;

  // Who owns the caret: the contributor whose session the playhead is inside.
  const activeContributorKey = laneMode
    ? (contributors?.bySession.get(state.sessionId)?.contributorKey ?? null)
    : null;

  // That contributor's own session IDs — the filter `currentFocusAwaySpan`
  // needs so a lane's overlay can only ever be driven by ITS OWN
  // contributor's `focus.change` events. See `laneFocusAway` below.
  const activeContributorSessionIds = useMemo(() => {
    if (activeContributorKey === null || contributors === null) return null;
    const c = contributors.contributors.find((candidate) => candidate.key === activeContributorKey);
    return c === undefined ? null : new Set(c.sessionIds);
  }, [activeContributorKey, contributors]);

  // One ribbon row per contributor, in `BundleContributors.contributors` order
  // — the same order the lanes use, so a row and a lane line up.
  const ribbons = useMemo<readonly RibbonRow[] | undefined>(() => {
    if (activity === null || palette === null || contributors === null) return undefined;
    return contributors.contributors.flatMap((c) => {
      const hue = palette.get(c.key);
      if (hue === undefined) return [];
      return [
        {
          key: c.key,
          label: labelContributor(c).short,
          hue: hue.hue,
          soft: hue.soft,
          runs: activity.runs.get(c.key) ?? [],
        },
      ];
    });
  }, [activity, palette, contributors]);

  // ---------------------------------------------------------------------------
  // Focus-away overlay + auto-follow the edited file.
  // ---------------------------------------------------------------------------

  // Whether the student is focused away from the window at the current
  // playhead, scanning the WHOLE bundle unfiltered — i.e. driven by whichever
  // contributor's `focus.change` happens to be most recent, not necessarily
  // the one whose session currently owns the playhead.
  //
  // This stays unfiltered ON PURPOSE, for the single-pane path only (see the
  // single-pane render site below). It is a known, pre-existing inaccuracy —
  // not the one this file fixes — and deliberately not touched here: changing
  // what the overlay means for every existing single-pane submission is a
  // product decision to make separately, not one to ride along inside the
  // split-lanes work. `laneFocusAway` below is the lane-mode fix; this value
  // is now used ONLY by the single-pane fallback.
  const focusAway = useMemo(
    () => currentFocusAwaySpan(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );

  // Lane mode's corrected version of the same fact, filtered to the
  // caret-owning contributor's OWN sessions. Unfiltered, a lane's overlay
  // could be driven by a DIFFERENT contributor's `focus.change` — and because
  // lane mode draws the overlay inside one named contributor's lane (unlike
  // the un-attributed single pane), that misattribution stops being merely
  // imprecise and becomes a specific false accusation against someone the
  // evidence never implicated. `LanePane` receives this instead of the
  // unfiltered `focusAway` above; null whenever no contributor owns the
  // caret, which `LanePane`'s `ownsCaret` gate already prevents it from
  // showing anyway.
  const laneFocusAway = useMemo(
    () =>
      activeContributorSessionIds === null
        ? null
        : currentFocusAwaySpan(bundleEvents, state.currentGlobalIdx, activeContributorSessionIds),
    [bundleEvents, state.currentGlobalIdx, activeContributorSessionIds],
  );

  // The file being edited at the current playhead.
  const editedFile = useMemo(
    () => currentEditedFile(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );

  // Auto-follow: switch the active file ONLY when the edited file transitions to a
  // new path. This follows the action during playback without overriding a manual
  // tab selection while paused (the playhead — and thus editedFile — isn't moving).
  const prevEditedFileRef = useRef<string | null>(null);
  useEffect(() => {
    if (editedFile !== null && editedFile !== prevEditedFileRef.current) {
      prevEditedFileRef.current = editedFile;
      setActiveFile(editedFile);
    }
  }, [editedFile]);

  // The student's cursor/selection in the shown file at the current playhead.
  const cursorSelection = useMemo(
    () => currentSelection(bundleEvents, state.currentGlobalIdx, resolvedFile),
    [bundleEvents, state.currentGlobalIdx, resolvedFile],
  );

  // An fs.external_change holding the viewport, and where to look for it. Null
  // whenever no external change is in force or the bundle never recorded the
  // post-change bytes — either way the viewport just follows the caret.
  const heldByExternalChange = useMemo(
    () => currentExternalChange(bundleEvents, state.currentGlobalIdx, resolvedFile),
    [bundleEvents, state.currentGlobalIdx, resolvedFile],
  );
  const externalChangeFocus = useMemo(
    () => externalChangePosition(activeFileState, heldByExternalChange),
    [activeFileState, heldByExternalChange],
  );

  // ---------------------------------------------------------------------------
  // Jump controls: pre-compute next targets + remaining counts.
  // (A44): flaggedSet is memoized so buildFlaggedGlobalIdxSet doesn't rebuild
  // on every render. It only changes when flags or the index's bySeq changes.
  // ---------------------------------------------------------------------------
  const flaggedSet = useMemo(
    () => buildFlaggedGlobalIdxSet(flags, index?.bySeq ?? new Map()),
    [flags, index],
  );

  const nextPaste = useMemo(
    () => findNextPaste(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const nextExternalChange = useMemo(
    () => findNextExternalChange(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const nextFlag = useMemo(
    () => findNextFlag(bundleEvents, state.currentGlobalIdx, flaggedSet),
    [bundleEvents, state.currentGlobalIdx, flaggedSet],
  );
  const nextFileSwitch = useMemo(
    () => findNextFileSwitch(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const remainingPastes = useMemo(
    () => countRemainingPastes(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const remainingExternalChanges = useMemo(
    () => countRemainingExternalChanges(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const remainingFlags = useMemo(
    () => countRemainingFlags(bundleEvents, state.currentGlobalIdx, flaggedSet),
    [bundleEvents, state.currentGlobalIdx, flaggedSet],
  );
  const remainingFileSwitches = useMemo(
    () => countRemainingFileSwitches(bundleEvents, state.currentGlobalIdx),
    [bundleEvents, state.currentGlobalIdx],
  );
  const nextSeam = useMemo(
    () => findNextSeam(seams, state.currentGlobalIdx),
    [seams, state.currentGlobalIdx],
  );
  const remainingSeams = useMemo(
    () => countRemainingSeams(seams, state.currentGlobalIdx),
    [seams, state.currentGlobalIdx],
  );

  // Seams where the inter_session_external_change heuristic fired — file content
  // demonstrably changed while the recorder was off.
  const flaggedSeamIdxs = useMemo(
    () => buildFlaggedSeamIdxs(seams, flags, index?.bySeq ?? new Map()),
    [seams, flags, index],
  );

  // Monaco editor + monaco instances (set via onMount callback).
  const [monacoEditor, setMonacoEditor] = useState<MonacoEditorNS.IStandaloneCodeEditor | null>(
    null,
  );
  const [monacoInstance, setMonacoInstance] = useState<typeof MonacoType | null>(null);

  const handleEditorMount = useCallback(
    (ed: MonacoEditorNS.IStandaloneCodeEditor, monaco: typeof MonacoType) => {
      setMonacoEditor(ed);
      setMonacoInstance(monaco);
    },
    [],
  );

  // Language for the hover provider (derived from the active file path).
  const language = useMemo(() => {
    return resolvedFile !== null ? languageFromPath(resolvedFile) : 'plaintext';
  }, [resolvedFile]);

  // ---------------------------------------------------------------------------
  // Mount: parse URL params → seek to initial event.
  // Only fires once (empty dep array, same rationale as A16).
  // ---------------------------------------------------------------------------
  const didInitRef = useRef(false);
  useEffect(() => {
    if (didInitRef.current) return;
    didInitRef.current = true;

    // ?event= is the position of record and wins when present.
    const eventParam = searchParams.get('event');
    if (eventParam !== null) {
      const idx = parseInt(eventParam, 10);
      if (!isNaN(idx)) {
        seek(idx);
        return;
      }
    }

    // Otherwise the session id in the route/query is an ENTRY ANCHOR, not a
    // scope: open the whole-bundle engine at that session's first event.
    const anchor = index?.bySessionId.get(sessionId)?.[0];
    if (anchor !== undefined) {
      seek(anchor.globalIdx);
    }
    // Mount-only: didInitRef guards re-fires; seek is stable via useCallback.
    // Intentionally empty dep array: this effect handles initial URL→engine sync only
    // on mount. Re-firing on searchParams changes would re-seek on every URL write-back,
    // overriding navigation that happened during the session.
  }, []);

  // ---------------------------------------------------------------------------
  // URL write-back: debounced ~100ms on currentGlobalIdx or speed change.
  // Avoids infinite loop: setSearchParams with { replace: true } updates the
  // URL without pushing a history entry; the effect deps are engine state values,
  // not the searchParams object, so the URL change does not re-trigger this effect.
  // ---------------------------------------------------------------------------
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('event', String(state.currentGlobalIdx));
          next.set('speed', String(state.speed));
          next.set('skipIdle', skipIdle ? '1' : '0');
          return next;
        },
        { replace: true },
      );
    }, 100);

    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [state.currentGlobalIdx, state.speed, skipIdle, setSearchParams]);

  // ---------------------------------------------------------------------------
  // If files list changes (e.g. new session) and activeFile is no longer valid,
  // reset to default (first file).
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (activeFile !== null && !files.includes(activeFile)) {
      setActiveFile(null);
    }
  }, [files, activeFile]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  function handlePlay() {
    // Use current engine speed. URL ?speed= is a delayed mirror (debounced 100ms),
    // not the source of truth. state.speed is updated synchronously by handleSpeedChange.
    // Reading the stale URL param here risks a race: if the user changes speed then
    // clicks Play within 100ms, the URL hasn't been written yet (A47).
    play(state.speed);
  }

  // SpeedControl: update the engine speed.
  // - If playing: restart with the new speed (recreates the interval).
  // - If paused: play(newSpeed) sets the engine's speed, then pause() immediately
  //   cancels the interval. The URL write-back effect picks up state.speed on the
  //   next render.
  const handleSpeedChange = useCallback(
    (newSpeed: number) => {
      if (state.status === 'playing') {
        // Restart the playback interval at the new rate.
        play(newSpeed);
      } else {
        // Update engine speed without actually playing: play sets speed,
        // pause cancels the interval. Net result: engine.speed === newSpeed,
        // status stays 'paused'.
        play(newSpeed);
        pause();
      }
    },
    [state.status, play, pause],
  );

  // JumpControls: seek to the target globalIdx. Seek does not change play
  // status (the engine stays playing/paused). We pause before seeking so
  // jumps always land in a paused/browseable state.
  const handleJumpSeek = useCallback(
    (globalIdx: number) => {
      pause();
      seek(globalIdx);
    },
    [pause, seek],
  );

  /**
   * Toggling lanes writes an EXPLICIT `?split=0` or `?split=1` — never clears
   * the param, in either direction. Writing the param IS the state change:
   * `split` above is derived from it on every render, so there is no local
   * copy to set and no way for the two to disagree.
   *
   * Design §3: on-by-default is a behaviour change to links already shared, and
   * the mitigation is that any link produced AFTER a human touches this control
   * pins its own mode instead of inheriting a default that may change again.
   * Clearing the param on "off" would defeat that for exactly the reader who
   * opted out.
   *
   * And it is written HERE rather than in the debounced write-back below, which
   * is where `skipIdle` is mirrored. That asymmetry is deliberate: the
   * write-back runs on every playhead move, so mirroring `split` there would
   * stamp `?split=0` into the URL of every solo submission that never had a
   * toggle to press — a way for an untouched, unaffected session to notice this
   * feature exists, which §7 forbids.
   */
  const handleSplitToggle = useCallback(
    (next: boolean) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set('split', next ? '1' : '0');
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return (
    <div className="flex flex-col h-full" data-testid="replay-view">
      {/* Back button + bundle name — only shown in the /local route. */}
      {showHeader && <ReplayHeader sourceFilename={sourceFilename} />}

      {/* Session select + file tabs share one row. SessionSelect renders null for
          single-session bundles, in which case the tabs get the full width.
          FileTabs is min-w-0 flex-1 so its wrapping tab list can't squeeze the
          select out of the row. */}
      <div className="flex items-center gap-3 px-4 pt-3 pb-1 border-b bg-background shrink-0">
        <ContributorSelect
          contributors={contributors}
          index={index}
          currentSessionId={state.sessionId}
          onSeek={handleJumpSeek}
        />
        <SplitLanesToggle
          contributors={contributors}
          enabled={split}
          onToggle={handleSplitToggle}
        />
        <SessionSelect index={index} currentSessionId={state.sessionId} onSeek={handleJumpSeek} />
        {/* In lane mode each lane names its own file, so the GLOBAL file tabs
            would be a second, contradictory answer to "which file am I looking
            at" — and picking a tab could only ever apply to one lane. Design §7
            replaces them along with the single Monaco pane. */}
        {!laneMode && (
          <div className="min-w-0 flex-1">
            <FileTabs
              files={files}
              activeFile={resolvedFile}
              onFileChange={setActiveFile}
              index={index}
              currentGlobalIdx={state.currentGlobalIdx}
              currentSessionId={state.sessionId}
            />
          </div>
        )}
      </div>

      {/* Main area: Monaco (70%) + EventSidebar (30%) */}
      <div className="flex flex-1 min-h-0">
        {/* Monaco editor — 70% width */}
        <div className="relative flex-1 min-w-0" style={{ flex: '0 0 70%' }}>
          {laneMode &&
          contributors !== null &&
          activeFileByContributor !== null &&
          palette !== null ? (
            /*
             * Split lanes (design §4). The grid REPLACES the single pane; it
             * never sits beside it. `renderPane` is the only place Monaco is
             * mounted, so `ReplayLanes` itself stays layout + chrome.
             */
            <>
              <ReplayLanes
                contributors={contributors.contributors}
                activeFileByContributor={activeFileByContributor}
                fileAmbiguity={fileAmbiguity}
                palette={palette}
                activeContributorKey={activeContributorKey}
                renderPane={({ cell, ownsCaret }: { cell: LaneCell; ownsCaret: boolean }) =>
                  cell.filePath === null ? null : (
                    <LanePane
                      filePath={cell.filePath}
                      fileState={fileStates.get(cell.filePath) ?? null}
                      ownsCaret={ownsCaret}
                      events={bundleEvents}
                      currentGlobalIdx={state.currentGlobalIdx}
                      focusAway={laneFocusAway}
                    />
                  )
                }
              />
              {/* One legend for the whole code area — the gutter colours it
                  explains are the same in every lane. */}
              <ColorLegend />
            </>
          ) : resolvedFile !== null && ambiguity !== undefined ? (
            /*
             * Spec §6 Rule 4: replay never linearizes concurrency. It shows the
             * branches side by side or refuses with an explanation — it does not
             * pick one and it does not interleave.
             *
             * Tier 5.3 promotes this from a refusal to the side-by-side reading:
             * the branches were always being computed and were being discarded
             * one frame later. What has NOT changed is that no branch reaches
             * `content` above, so the Monaco pane can still never show one
             * lineage as though it were the file.
             */
            <BranchedFileView filePath={resolvedFile} ambiguity={ambiguity} />
          ) : resolvedFile !== null ? (
            <>
              <MonacoMount
                content={content}
                filePath={resolvedFile}
                className="h-full w-full"
                onMount={handleEditorMount}
              />
              {/* Phase 14: headless side-effect drivers */}
              <GutterDecorations editor={monacoEditor} fileState={activeFileState} />
              {/* Student cursor / selection marker at the playhead. */}
              <CursorMarker editor={monacoEditor} selection={cursorSelection} />
              {/* Scroll the editor to keep that marker in view as replay plays. */}
              <FollowCursor
                editor={monacoEditor}
                selection={cursorSelection}
                externalChange={externalChangeFocus}
                content={content}
              />
              <LineHoverProvider
                editor={monacoEditor}
                monaco={monacoInstance}
                fileState={activeFileState}
                language={language}
                orderedEvents={bundleEvents}
              />
              {/* Color legend overlay */}
              <ColorLegend />
            </>
          ) : (
            <div
              className="flex items-center justify-center h-full text-sm text-muted-foreground"
              data-testid="no-file-placeholder"
            >
              No files under review in this session.
            </div>
          )}
          {/* Focus-away overlay — covers the code pane while the student is focused away.
              Single-pane only: in lane mode the overlay is painted per-lane, inside
              `LanePane`, scoped to whichever lane owns the playhead's caret (see the
              `LanePane` header comment above).

              This single-pane `focusAway` is still the UNFILTERED, whole-bundle scan
              (`currentFocusAwaySpan(bundleEvents, ...)` with no session filter) — the
              same inaccuracy lane mode had before it was scoped to `laneFocusAway`
              above: a solo pane can be washed by evidence from a session other than
              the one the playhead is currently in. That is a real bug, but it is NOT
              fixed here, on purpose: the single pane has no per-contributor identity
              on screen to misattribute TO (there is only ever one pane, unlabelled),
              so the failure mode is imprecise rather than a false accusation against
              a named person. Changing what this overlay means for every existing
              single-pane submission is a product decision to make deliberately and
              separately — not one that should ride along inside the split-lanes
              fix. Known and deferred; not an oversight. */}
          {!showLaneGrid && focusAway !== null && <FocusAwayOverlay reason={focusAway.reason} />}
        </div>

        {/* Event sidebar — 30% width */}
        <div className="flex-1 min-w-0 min-h-0" style={{ flex: '0 0 30%' }}>
          <EventSidebar
            seams={seams}
            flaggedSeamIdxs={flaggedSeamIdxs}
            events={bundleEvents}
            currentGlobalIdx={state.currentGlobalIdx}
            onSeek={seek}
          />
        </div>
      </div>

      {/* Transport bar row: SpeedControl on right, TransportBar fills remaining space */}
      <div className="shrink-0">
        <div className="flex items-center border-t bg-background">
          <div className="flex-1">
            <TransportBar
              seams={seams}
              state={state}
              events={bundleEvents}
              {...(laneMode && ribbons !== undefined
                ? { ribbons, overlaps: activity?.overlaps ?? [] }
                : {})}
              onPlay={handlePlay}
              onPause={pause}
              onStep={step}
              onSeek={seek}
            />
          </div>
          {/* Pacing controls sit at the right edge of the transport row */}
          <div
            className="shrink-0 flex items-center gap-2 px-3 py-2 border-l"
            data-testid="speed-control-wrapper"
          >
            <SkipIdleToggle
              skipIdle={skipIdle}
              onSkipIdleChange={setSkipIdle}
              disabled={eventCount === 0}
            />
            <SpeedControl
              speed={state.speed}
              onSpeedChange={handleSpeedChange}
              disabled={eventCount === 0}
            />
          </div>
        </div>
      </div>

      {/*
        The coverage panel used to sit here, collapsed by default. It moved to
        the submission level (`views/coverage/CoveragePanel.tsx`, mounted on both
        overview surfaces): §6 Rule 3 wants the coverage statement per SCOPE and
        always visible, and a collapsed panel behind a tab is neither. The facts
        it states — dropped artifacts, unattested seal tails, no root key, two
        contributors recording concurrently — describe the submission, not the
        replay.
      */}

      {/* Jump controls strip */}
      <div className="shrink-0">
        <JumpControls
          nextPaste={nextPaste}
          nextExternalChange={nextExternalChange}
          nextFlag={nextFlag}
          nextFileSwitch={nextFileSwitch}
          remainingPastes={remainingPastes}
          remainingExternalChanges={remainingExternalChanges}
          remainingFlags={remainingFlags}
          remainingFileSwitches={remainingFileSwitches}
          nextSeam={nextSeam}
          remainingSeams={remainingSeams}
          hasSeams={seams.length > 0}
          onSeek={handleJumpSeek}
        />
      </div>
    </div>
  );
}
