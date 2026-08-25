# Plan: split replay lanes

**Design:** `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`
**Branch:** `feat/split-replay-lanes`, stacked on `feat/manifest-2.0-trust-chain` (base `c7335a8`)
**Worktree:** `/Users/aaryanmehta/projects/provenance-wt/split-replay-lanes`

Five phases, executed sequentially in one worktree — one writer at a time. Each phase ends green
(`typecheck`, `lint`, its own tests) and gets its own commit. Phases 2 and 3 are file-disjoint but
still run in sequence rather than in parallel worktrees; the merge saving is not worth two trees.

## Phase 1 — pure derivations (no UI)

New, all in `packages/analyzer/src/views/replay/`, each with a co-located `.test.ts`:

1. `contributor-palette.ts` — `contributorKey` → hue, indexed off `BundleContributors.contributors`
   order. Six hues (blue, violet, pink, indigo, fuchsia, sky), cycling. Must share no hue with
   paste orange, external red, or the emerald/slate/amber tone chrome.
2. `contributor-active-file.ts` — `activeFileAt(ordered, sessionIds, globalIdx)` → path or `null`.
   The one genuinely new derivation: which file was this contributor last in at or before `T`.
3. `contributor-activity.ts` — activity runs per contributor in **index space**, plus `idle`
   sub-runs split on an **injected** wall-gap threshold, plus overlap intervals (≥2 contributors
   active over the same index range).
4. `lane-groups.ts` — the §4 grouping. Contributors + active files + `fileAmbiguity` → an ordered
   list of cells: `single | converged | concurrent | unknown | idle`, each carrying its
   contributor keys and column span.

No existing file is touched in this phase.

## Phase 2 — ribbons

`ContributorRibbons.tsx` + test. `TransportBar.tsx` gains **optional** props (`runs`, `overlaps`,
`palette`); with them omitted its render is unchanged and `TransportBar.test.tsx` passes untouched.
Ribbon geometry reuses the seam math (`atGlobalIdx / sliderMax * 100`) and must not collide with
`seam-tick-*` testids.

## Phase 3 — lane grid

`ReplayLanes.tsx`, `SplitLanesToggle.tsx` + tests. Extract `BranchedFileView`'s branch-panel list
into an exported subcomponent; the existing full-pane component renders it inside its current
chrome so every current `data-testid` keeps its exact meaning.

## Phase 4 — wiring

`ReplayInner` gains `split` URL state (`?split=0|1`, absent → on when >1 contributor), mounts the
lane grid in place of the single Monaco + global `FileTabs`, and feeds the ribbons. Integration
tests extend `ReplayView.concurrent.test.tsx`'s existing `buildScope` fixture; one test in
`views/submission/Replay.test.tsx` proves server-path parity.

**Hard requirement:** with lanes off, the render path is byte-for-byte what it is today.

## Phase 5 — architecture page + close-out

Prose in `content/nodes/readpath.ts` (`r_replay`) only. No `.dot` edit — a label change would need an
SVG regeneration to stay in sync, and the `drill` label's tab list is unaffected by lane mode. No new
dot node, so no `build_diagrams.py` run and `nodes.coverage.test.ts` stays green. Then full analyzer suite,
`typecheck`, `lint`, prettier on the two docs.

## Standing rules for every phase

- No new dependency. No `analysis-core`, `server`, `recorder`, or format change.
- No `Date.now()` in tests; inject clocks and thresholds.
- **Do not edit an existing test assertion to make something pass.** If one must change, stop and
  report it — it is a product decision.
- Commit with `--no-gpg-sign`, an explicit pathspec, conventional-commit prefix, no co-author
  trailer.
