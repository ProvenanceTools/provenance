# Staff replay + dashboard: terminal, flag counts, time metrics

**Date:** 2026-08-12
**Status:** Approved, ready for implementation plan

Pilot course staff asked for three analyzer changes: see terminal command + exit
code while scrubbing replay, inspect a severity bucket without leaving the
cohort table, and see Active/Idle time on that table plus wall-clock times in
replay.

## Understanding summary

- **What.** Three staff-facing analyzer changes. No recorder or log-format change.
- **Why.** Pilot feedback: see what the student ran, inspect flags in place, compare how long students worked.
- **Who.** Course staff on the cohort analyzer. Students never see this.
- **Constraints.** Cohort list stays a single indexed query (no bundle parse on list load). `exit_code` is optional. Architecture page updates if we add submission columns.
- **Non-goals.** No heartbeat-based focused time. No transport-bar clock. No terminal detail overlay. No historical backfill of Active/Idle. No change to Top Flags chips, student-rollup table, or server Overview. No sort-by-time in v1.

## Assumptions

- CSV export of the current cohort view gains the two time columns.
- Flag dropdown is per-row, one open at a time, dismiss on outside click / Escape.
- Command truncation matches timeline (~60 chars) with the full command on hover.
- Missing/unparseable wall times render as "—".
- Timeline also starts showing exit code, via a shared helper — consistency, not a new surface.

## Decision log

| Decision | Alternatives | Why |
|---|---|---|
| Flag-count badges open an in-place list of that severity | Navigate away; expand named Top Flags chips | Staff asked to stay on the dashboard ("right there itself"). Named chips already jump to Overview. |
| A listed flag name goes to Overview with that flag's drawer | Names only; jump straight to Replay | Same deep-link as today's Top Flags chips (`?tab=overview&flag=`). |
| Dashboard shows Active + Idle (60s event-gap) | Active only; wall-clock span; heartbeat focused-time | Same pair local Overview already shows. Focused-time aggregation does not exist. |
| Replay timestamps on each sidebar row | Transport bar only; both; playhead clock | Matches the timeline list. |
| Terminal command + exit code on the sidebar row | Detail strip for the current event only | Same one-liner style as the timeline. |
| Existing submissions show "—" until next ingest/recompute | One-shot backfill; compute on list load | No backfill job. List must not open bundles. |
| Approach A: persist two columns, fetch flags on click, extend sidebar | New Popover dep / row accordion; N+1 `/stats` | No new npm packages. Cohort list stays one query. |

This spec **supersedes** the 2026-07-23 clickable-chips spec's "flag_counts badges stay inert" out-of-scope line. Named Top Flags chips are unchanged.

---

## 1. Replay sidebar

`EventSidebar` stays a one-line virtualized list. Two additions on each **event**
row (seam dividers unchanged):

- **Wall time** — same `HH:MM:SS.mmm` local format as the timeline. Unparseable
  `wall` → `—`.
- **`terminal.command` summary** — truncated command (~60 chars) plus `exit N`
  when `exit_code` is present. Full command on `title`. No exit code → command
  only. Other kinds stay kind + file, no extra summary.

Row height bumps from 30px to ~36px. Virtualizer `estimateSize` follows.

Extract `formatWall` and `summarizeTerminalCommand` next to `formatDuration` in
`packages/analyzer/src/lib/format.ts`. `EventList.payloadSummary` uses the
terminal helper so the timeline also shows exit code.

No architecture-page change (no event type, route, or format change).

**Files:** `EventSidebar.tsx` (+ test), `EventList.tsx` (+ existing
`payloadSummary` tests), `lib/format.ts` (+ test).

---

## 2. Flag-count dropdown

The high/med/low/info badges in `CohortTable` become `DropdownMenu` triggers
(already a dependency; there is no Popover). Zero-count badges stay hidden. One
menu open at a time.

**On open:** `GET /api/v1/submissions/:id/flags` (same endpoint Overview uses).
Filter client-side to that severity. Show `title` when present, else
`heuristic_id` with underscores turned into spaces. Each row is a `Link` to:

```
${basePath}/sub/${id}?tab=overview&flag=${heuristic_id}
```

That is the existing Overview `?flag=` deep-link (highest-severity match if
several share the id). Real `<Link>` so middle-click / cmd-click works.

**States:** loading spinner in the menu; empty (stale count) → "No flags"; fetch
error → "Couldn't load flags". No prefetch — a page of 50 would be 50 extra
requests. Stop click propagation so the menu doesn't hit the student-cell row
link.

`StudentRollupTable` is unchanged. No schema or architecture-page change.

**Files:** `CohortTable.tsx` (+ test). Fetch via `apiFetch` + `useQuery` keyed
`['submission', id, 'flags']` so a later Overview visit can reuse the cache.

---

## 3. Active / Idle on the cohort table

Two nullable `bigint` columns on `submissions`: `total_active_ms`,
`total_idle_ms`. Same 60s-gap definition as `computeStats` / local Overview.
`NULL` = not yet written → table shows `—`.

**Write path.** `computeAndStoreStats` already runs `computeStats` at ingest and
recompute. After that call, also `UPDATE submissions SET total_active_ms,
total_idle_ms`. No second parse.

Today the function returns early when `perFile.size === 0`. That early return
must **not** skip the submissions UPDATE — a session with events but no file
activity still has Active/Idle. Only the `per_file_stats` insert is skipped.

**Read path.** Add nullable numbers to `SubmissionRow` in `packages/shared` and
the OpenAPI `SubmissionRow` component (not in `required[]`). Cohort list SELECT
already reads denormalized columns off `submissions` — extend it. Not sortable
in v1 (no index, no cursor change).

**UI.** Two columns after Flags, before Top Flags: **Active** and **Idle**,
tabular nums, `formatDuration`. Header tooltips: "Gaps under 60s between
events" / "Gaps of 60s or more".

**CSV.** `ExportCurrentView` gains `active_time` and `idle_time` as the same
`formatDuration` strings the table shows, or empty when null.

**Architecture page (required).** This adds Postgres columns and changes what
the cohort list persists vs re-parses.

- `er.ts` `submissions` body: the denormalized cohort-list set grows from
  flag_counts / top_flags / severity_rank to also include `total_active_ms` /
  `total_idle_ms`, written by `computeAndStoreStats`.
- `readpath.ts` `r_cohort` body: list also reads those two columns; still no
  bundle parse.
- Link the new migration next to `0014_submissions_denormalized_flags.sql`.
- Dot node names are unchanged, so `nodes.coverage.test.ts` should stay green
  without new node keys. Run `python3 tools/architecture/build_diagrams.py`
  only if a `.dot` label actually changes; otherwise skip.

Ingest stage order is unchanged.

**Out of scope:** server Overview, student-rollup table, `/stats`'s
`total_wall_ms`, heartbeat-based focused time.

**Files:**

- `packages/server/db/migrations/0021_submissions_active_idle_ms.sql`
- `packages/server/src/db/schema.ts`
- `packages/server/src/services/ingest/stats.ts` (+ test)
- `packages/server/src/services/scoring/recompute-submission.ts` (covered by
  existing recompute tests once stats writes the columns)
- `packages/server/src/services/cohort/list.ts` (+ test)
- `packages/shared/src/api-schemas.ts`
- `packages/server/src/openapi/spec/components.ts`
- `packages/analyzer/src/views/cohort/CohortTable.tsx` (+ test)
- `packages/analyzer/src/views/cohort/ExportCurrentView.tsx` (+ test if present)
- `packages/analyzer/src/test/msw-handlers.ts` (`makeSubmissionRow`)
- `packages/analyzer/src/views/architecture/content/nodes/er.ts`
- `packages/analyzer/src/views/architecture/content/nodes/readpath.ts`

---

## Testing

- **Replay.** `EventSidebar`: timestamp present; `python hw.py · exit 0`;
  command without exit code; bad wall → `—`. `payloadSummary`: terminal.command
  with exit code.
- **Flags.** Badge with count > 0 is a menu trigger; click fetches and lists
  that severity only; item `href` matches the Overview deep-link; count 0 still
  renders nothing.
- **Times.** Ingest + recompute persist both values, including a bundle with
  events but no files. Cohort list returns them (`null` on old fixtures). Table
  renders duration vs `—`. CSV includes the columns.

## Architecture-page impact

Replay and flag dropdown: none. Time columns: yes — see §3.
