# Split replay lanes: one lane per contributor on a shared playhead

**Date:** 2026-08-24
**Status:** Design, approved in chat; plan follows
**Repos touched:** `provenance` (analyzer only — `views/replay/`, `views/submission/Replay.tsx`,
architecture page prose)

## 1. Problem

A group submission has more than one author. The Replay tab shows **one** stream and offers
`ContributorSelect`, which _seeks_ between contributors and deliberately never filters — a control
that hid a contributor would manufacture a solo reading of a collaborative submission (see the
header comment in `ContributorSelect.tsx`).

Seeking is not enough for the question graders actually arrive with: _what were these two people
doing at the same time?_ Answering it today means scrubbing back and forth and holding two
timelines in your head.

**Split lanes** render every contributor at once, side by side, on one clock. This is allowed
where filtering is not, for one reason that is the whole design: lanes **add** a contributor to
the view, they never remove one. Nothing is hidden, so no single-contributor reading can be taken
away from the screen.

## 2. What already exists (do not rebuild)

- **Per-contributor content for divergent files.** `fileAmbiguity()`
  (`engine-core.ts:178`) returns `concurrent` branches already tagged with `contributorKey`,
  `contributor`, `tip`, and their own `FileReplayState`
  (`reconstruct-segments.ts:148-166`). A lane picks its branch. **No new reconstruction work.**
- **Shared truth for non-divergent files.** `fileStates` (`engine-core.ts:142`) is one
  `Map<path, FileReplayState>` at the playhead. Ambiguity is decided **per file**
  (`reconstruct-segments.ts:412-419`), so a bundle can be collaborative while most files remain
  determinate. A determinate file has exactly one recorded truth and every lane showing it shows
  the same bytes — which is correct, not a bug. See §4 for how the layout says so.
- **Both call sites already pass what lanes need.** `/local` `ReplayView.tsx:186-192` and the
  server tab `views/submission/Replay.tsx:167-168` both hand `scope` + `contributors` to
  `ReplayInner`. The server path is **not** incrementally paged: `useFullEventIndex` loops until
  `next_cursor` is null and only then resolves, and `Replay.tsx:113` gates render on it. Its
  `contributor_stamp` decodes to the same `BundleContributors`. **Lanes built inside `ReplayInner`
  land on both surfaces with no per-surface wiring.**
- **Refusal surface.** `BranchedFileView` owns the `concurrent` / `unknown` copy and branch
  panels. It is reused as-is (§6), not re-implemented.
- **Track geometry.** `TransportBar.tsx:159-181` already overlays absolutely-positioned seam ticks
  at `left% = atGlobalIdx / sliderMax * 100` inside one `relative flex-1` wrapper. Ribbons extend
  that pattern and must use the same index-space math.
- **Stable contributor order.** `BundleContributors.contributors` is first-appearance ordered and
  deterministic across re-runs (`resolve-contributors.ts:438-469`). Lane order and palette index
  derive from it; neither is a ranking.

## 3. Decisions

| Decision                     | Choice                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------- |
| Surface                      | Both call sites, via `ReplayInner`. One PR.                                      |
| More than three contributors | Up to **3 code lanes**; the rest are ribbon-only **rails** that can be promoted. |
| Concurrent refusal           | **One `BranchedFileView`**, two containers. No second rendering of the copy.     |
| Default state                | **On** when `contributors.contributors.length > 1`; `?split=0` opts out.         |
| Lane order                   | `BundleContributors.contributors` order. Never re-sorted by activity.            |
| Which 3 get code lanes       | The first 3 in that order. Promotion from a rail is explicit and manual.         |

Rationale for the last two: an activity-ranked or recency-ranked lane order would reshuffle the
screen during playback and would read as a ranking of who did more. Stable beats clever here.

**On-by-default is a behaviour change to existing links.** Every multi-contributor replay URL
already shared — in a case write-up, an IRB appendix, a screenshot — renders differently after
this ships. Mitigation: the toggle always writes `?split=0` or `?split=1` explicitly when a human
touches it, so any link produced _after_ this change pins its own mode. Links produced _before_ it
inherit the new default. Accepted knowingly.

## 4. The lane grid is a grid of files, keyed by who is in them

This is the core of the design and the part that is easy to get wrong.

At playhead `T`, for each contributor `c`, derive `activeFile(c, T)` — the path named by the most
recent event at or before `T` belonging to any session of `c`. Then **group the lanes by that
path** and render one cell per group:

| Group                                | Rendering                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `activeFile` is `null`               | "No recorded activity yet" lane. Neutral, not an error — the contributor's first event is later than `T`.                                 |
| One contributor, determinate file    | Ordinary lane: header + file strip + Monaco with the existing gutter decorations.                                                         |
| **Two or more, determinate file**    | **One converged cell spanning their columns**, headed by every contributor chip in the group, captioned _"One file, one recorded truth."_ |
| Any group whose file is `concurrent` | The cell spans the group's columns and renders `BranchedFileView`'s refusal band + branch panels.                                         |
| Any group whose file is `unknown`    | Same span, the `unknown` arm of `BranchedFileView`.                                                                                       |

The converged cell is why the grid is keyed by file rather than by person. Rendering the same
determinate bytes into two adjacent Monaco panes is not wrong, but it _looks_ like two versions,
and this product cannot afford a layout that looks like a claim it is not making. One pane with
two chips on it says the true thing: they were both in this file, and the file has one history.

Note that a `concurrent` file's branch list belongs to the **file**, not to the group — it can
include a contributor who edited earlier and has since moved elsewhere. Render the branches
`BranchedFileView` gives you. Do not filter them to the group.

## 5. Ribbons, and one correction to the mock

Each contributor gets a row in the transport, under the scrubber, in index space (`globalIdx`),
matching the seam-tick math exactly. A run is a maximal span of consecutive `index.ordered`
entries whose session belongs to that contributor; a run splits into `idle: true` sub-runs where
the wall gap between consecutive events exceeds an injected threshold.

**Correction:** the mock labelled a hatched band _"unordered — 6 min"_ spanning a region of the
timeline. **That band cannot honestly exist.** Unordered-ness is decided per file at a specific
playhead (`resolve()`, `reconstruct-segments.ts:391-487`); knowing every unordered interval across
the whole timeline would mean re-running reconstruction at every index. What _is_ cheaply knowable
is **overlap**: two or more contributors with activity runs covering the same index. That is a
different and still useful fact, so v1 ships the band with honest wording — **"both recording"** —
and the unordered state stays what it already is: a per-playhead pane state.

Axis ticks are labelled with the bundle clock's time at that _index_, since the slider is
index-based. Spacing is uniform in events, not in seconds, and the labels must not imply otherwise.

## 6. New modules

All analyzer-side. **`analysis-core` is not touched** — nothing here needs new reconstruction.

| File (`packages/analyzer/src/views/replay/`) | Responsibility                                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `contributor-palette.ts`                     | `contributorKey` → stable hue, indexed off `contributors` order. Six hues, cycling.                            |
| `contributor-activity.ts`                    | `buildContributorActivity(ordered, contributorBySession, {idleGapMs})` → runs per key; plus overlap intervals. |
| `contributor-active-file.ts`                 | `activeFileAt(events, sessionKeys, globalIdx)` → path or null. Pure; the one genuinely new derivation.         |
| `lane-groups.ts`                             | The §4 grouping: contributors + active files + `fileAmbiguity` → the ordered list of cells to render.          |
| `ReplayLanes.tsx`                            | The grid. Renders cells, converged cells, rails, promotion.                                                    |
| `ContributorRibbons.tsx`                     | The ribbon rows + overlap band, inside `TransportBar`'s existing `relative flex-1` wrapper.                    |
| `SplitLanesToggle.tsx`                       | The control. Hidden entirely when `contributors` is null or has ≤1 contributor.                                |

**Palette constraint.** Lane hues must share no hue with the semantic colours already in use:
paste orange, external red, and the emerald/slate/amber `ContributorTone` chrome. Blue, violet,
pink, indigo, fuchsia, sky. A lane colour identifies a person; it must never be readable as a
finding against them.

**Reuse of `BranchedFileView`** (decision: one component, two containers). Extract the branch-panel
list into an exported subcomponent and have the existing full-pane component render it inside its
current chrome. The existing `data-testid`s — `replay-ambiguous`, `replay-branches`,
`replay-branch`, `replay-branch-*` — keep their exact current meaning under the non-lane path.
`contributor-labels.ts` stays the single source of the wording.

## 7. Wiring

- `ReplayInner` gains `split` state: `searchParams.get('split')` — `'0'` off, `'1'` on, absent →
  `contributors !== null && contributors.contributors.length > 1`. Toggling always writes an
  explicit value.
- When off, the render path is **byte-for-byte what it is today**. This is a hard requirement, not
  an aspiration: solo submissions and opted-out sessions must not notice this feature exists.
- When on, the lane grid replaces the single Monaco + global `FileTabs`. `EventSidebar`,
  `TransportBar`, `SessionSelect`, `ContributorSelect`, `SkipIdleToggle` all stay.
- Caret: shown only in the lane whose contributor owns the playhead's current session. A stale
  caret drawn in another lane would imply live presence at a position that contributor left.

## 8. Non-goals

- No lane can be soloed. There is no "show only X" affordance, at any contributor count.
- No merged content inside an unordered interval, ever.
- No re-ordering of lanes by activity, edit volume, or flag count.
- No new event types, no format change, no `analysis-core` change, no server change.
- No new dependency.

## 9. Test plan

- Pure modules (`contributor-palette`, `contributor-activity`, `contributor-active-file`,
  `lane-groups`) get full-branch unit tests with injected clocks and thresholds — no `Date.now()`.
- `ReplayLanes` component tests over hand-built cell lists: converged cell, `null`-activity lane,
  concurrent group spanning, rails and promotion, 1/2/3/5-contributor counts.
- `ContributorRibbons`: run placement math, overlap band, and non-collision with `seam-tick-*`.
- Integration: extend `ReplayView.concurrent.test.tsx`'s `buildScope` helper (the existing,
  cheapest real 2-contributor fixture — cached keypairs, two signed sessions) rather than
  hand-rolling a second builder. Assert lanes-on-by-default for that bundle, `?split=0` restores
  today's markup exactly, and the solo control path is untouched.
- Server parity: one test in `views/submission/Replay.test.tsx` proving lanes render through that
  mount too, since both go through `ReplayInner`.
- **Any existing assertion that has to change gets raised for approval, not edited.** The suites in
  `ReplayView.test.tsx`, `ReplayView.concurrent.test.tsx`, `TransportBar.test.tsx` and
  `Replay.test.tsx` encode requirements; loosening one is a product decision.

## 10. Architecture page

Prose-only, and confined to the node **detail** in `content/nodes/readpath.ts` (`r_replay`).

`master.dot`'s `drill` label is deliberately **not** touched. Label text is baked into the
committed `.svg` at generation time, so editing a label without running `build_diagrams.py` leaves
the source and the rendered diagram silently disagreeing — and `nodes.coverage.test.ts` would not
catch it, since it only checks that node `<title>`s have matching detail entries. The label lists
the drill-in tab names, which lane mode does not change: replay is still a tab. No new dot node, no
`<title>` change, no Graphviz run, and the coverage test stays green.

## 11. Open, deliberately deferred

- Promoted-rail selection is component state, not URL state, in v1. A shared link therefore always
  shows the first three contributors. Worth revisiting if anyone asks for it.
- Three Monaco instances is the heaviest this tab has ever been. The cap at three is partly a
  performance decision. If it bites, lanes past the first could fall back to a plain read-only
  renderer — but they would then look different from lane one, which is its own problem.
- A jump predicate for "end of the current unordered interval" is in scope only if it stays small;
  it is the first thing to cut.
