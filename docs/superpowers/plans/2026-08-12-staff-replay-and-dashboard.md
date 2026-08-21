# Staff Replay + Dashboard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show terminal command + exit code and wall-clock times in the replay sidebar; make cohort flag-count badges open an in-place list of that severity; persist and display Active/Idle time on the cohort table.

**Architecture:** Replay is a UI-only change on `EventSidebar` plus two shared format helpers. Flag counts fetch the existing `GET /submissions/:id/flags` on dropdown open. Active/Idle are denormalized onto `submissions` at ingest/recompute (`computeAndStoreStats` already runs `computeStats`) so the cohort list stays one indexed query.

**Tech Stack:** TypeScript strict, Vitest, React, TanStack Query, existing Radix `DropdownMenu`, Drizzle + SQL migration. No new npm packages.

**Spec:** `docs/superpowers/specs/2026-08-12-staff-replay-and-dashboard-design.md`

## Global Constraints

- No new dependencies. Use `DropdownMenu`, not a new Popover package.
- `log-core` / `analysis-core` stay isomorphic. This work does not touch them except reading `computeStats` output that already exists.
- Cohort list must not parse bundles. Times are persisted columns; flags are fetched per-row on click.
- Do not backfill historical Active/Idle. `NULL` → `—`.
- Do not change Top Flags chips, `StudentRollupTable`, server Overview, or `/stats.total_wall_ms`.
- Do not sort by time. No cursor/index change.
- Architecture page: update `er.ts` + `readpath.ts` for the new columns. Dot node names are unchanged — only regenerate diagrams if a `.dot` label actually changes.
- Tests: analyzer Vitest for UI; server `stats.test.ts` + `list.test.ts` use testcontainers (Docker required). Do not run the full repo suite unless a task says so.
- Do not commit unless the user asks. Pathspec-only if they do.

---

## File Structure

| File                                                                 | Responsibility                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/analyzer/src/lib/format.ts`                                | `formatWall`, `summarizeTerminalCommand`                                 |
| `packages/analyzer/src/views/replay/EventSidebar.tsx`                | Wall time + terminal summary on rows                                     |
| `packages/analyzer/src/views/timeline/EventList.tsx`                 | Use terminal helper (exit code on timeline too)                          |
| `packages/server/db/migrations/0021_submissions_active_idle_ms.sql`  | Nullable bigint columns                                                  |
| `packages/server/db/migrations/meta/_journal.json`                   | Journal entry idx 19                                                     |
| `packages/server/src/db/schema.ts`                                   | Drizzle columns                                                          |
| `packages/server/src/services/ingest/stats.ts`                       | Always UPDATE submissions times; skip per_file insert only when no files |
| `packages/shared/src/api-schemas.ts`                                 | `total_active_ms` / `total_idle_ms` on `SubmissionRow`                   |
| `packages/server/src/openapi/spec/components.ts`                     | Same, not in `required[]`                                                |
| `packages/server/src/services/cohort/list.ts`                        | SELECT + map the two columns                                             |
| `packages/analyzer/src/views/cohort/CohortTable.tsx`                 | Time columns + flag-count dropdown                                       |
| `packages/analyzer/src/views/cohort/ExportCurrentView.tsx`           | CSV columns                                                              |
| `packages/analyzer/src/test/msw-handlers.ts`                         | Fixture defaults                                                         |
| `packages/analyzer/src/views/architecture/content/nodes/er.ts`       | submissions denorm prose                                                 |
| `packages/analyzer/src/views/architecture/content/nodes/readpath.ts` | cohort list prose                                                        |

---

### Task 1: Format helpers

**Files:**

- Modify: `packages/analyzer/src/lib/format.ts`
- Test: `packages/analyzer/src/lib/format.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `format.test.ts`:

```ts
import { formatDuration, formatWall, summarizeTerminalCommand } from './format.js';

describe('formatWall', () => {
  it('renders HH:MM:SS.mmm for a valid ISO wall', () => {
    expect(formatWall('2026-01-01T12:34:56.789Z')).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
  });

  it('returns an em dash for unparseable wall', () => {
    expect(formatWall('not-a-date')).toBe('—');
    expect(formatWall('')).toBe('—');
  });
});

describe('summarizeTerminalCommand', () => {
  it('returns the command when there is no exit_code', () => {
    expect(summarizeTerminalCommand({ command: 'python hw1.py' })).toBe('python hw1.py');
  });

  it('appends exit N when exit_code is a number', () => {
    expect(summarizeTerminalCommand({ command: 'python hw1.py', exit_code: 0 })).toBe(
      'python hw1.py · exit 0',
    );
    expect(summarizeTerminalCommand({ command: 'false', exit_code: 1 })).toBe('false · exit 1');
  });

  it('truncates commands longer than 60 chars before appending exit', () => {
    const cmd = 'python ' + 'x'.repeat(70);
    const result = summarizeTerminalCommand({ command: cmd, exit_code: 0 });
    expect(result.startsWith(cmd.slice(0, 60) + '…')).toBe(true);
    expect(result.endsWith(' · exit 0')).toBe(true);
  });

  it('ignores a non-number exit_code', () => {
    expect(summarizeTerminalCommand({ command: 'ls', exit_code: '0' })).toBe('ls');
  });

  it('returns empty string for null / missing command', () => {
    expect(summarizeTerminalCommand(null)).toBe('');
    expect(summarizeTerminalCommand({})).toBe('');
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```
npx vitest run packages/analyzer/src/lib/format.test.ts
```

- [ ] **Step 3: Implement**

In `format.ts`, add:

```ts
export function formatWall(wall: string): string {
  const d = new Date(wall);
  if (Number.isNaN(d.getTime())) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

const COMMAND_MAX = 60;

export function summarizeTerminalCommand(payload: Record<string, unknown> | null): string {
  if (payload === null) return '';
  const cmd = typeof payload['command'] === 'string' ? payload['command'] : '';
  const truncated = cmd.length > COMMAND_MAX ? cmd.slice(0, COMMAND_MAX) + '…' : cmd;
  const exit = payload['exit_code'];
  if (typeof exit === 'number') {
    return truncated ? `${truncated} · exit ${exit}` : `exit ${exit}`;
  }
  return truncated;
}
```

Do **not** use try/catch around `new Date` — invalid input does not throw; it yields `Invalid Date`. Gate on `Number.isNaN(d.getTime())`.

- [ ] **Step 4: Run tests — expect PASS**

```
npx vitest run packages/analyzer/src/lib/format.test.ts
```

---

### Task 2: Replay sidebar + timeline exit code

**Files:**

- Modify: `packages/analyzer/src/views/replay/EventSidebar.tsx`
- Modify: `packages/analyzer/src/views/timeline/EventList.tsx`
- Test: `packages/analyzer/src/views/replay/EventSidebar.test.tsx`
- Test: `packages/analyzer/src/views/timeline/EventList.test.tsx`

- [ ] **Step 1: Write the failing tests**

In `EventSidebar.test.tsx`, add a describe (import `formatWall`):

```ts
describe('EventSidebar — wall time and terminal summary', () => {
  it('renders wall time on each event row', async () => {
    render(<EventSidebar events={THREE_EVENTS} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-row-0')).toHaveTextContent(
        formatWall('2026-01-01T00:00:00.000Z'),
      );
    });
  });

  it('renders an em dash for unparseable wall', async () => {
    const events = [{ ...THREE_EVENTS[0]!, wall: 'not-a-date', globalIdx: 0, seq: 0 }];
    render(<EventSidebar events={events} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-row-0')).toHaveTextContent('—');
    });
  });

  it('shows command and exit code on terminal.command rows', async () => {
    const events: IndexedEvent[] = [
      {
        sessionId: 'sess1',
        seq: 0,
        globalIdx: 0,
        t: 0,
        wall: '2026-01-01T00:00:00.000Z',
        kind: 'terminal.command',
        payload: { terminal_id: 't1', command: 'python hw.py', exit_code: 0 },
      },
    ];
    render(<EventSidebar events={events} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('sidebar-row-0')).toHaveTextContent('python hw.py · exit 0');
    });
  });

  it('omits exit when exit_code is absent', async () => {
    const events: IndexedEvent[] = [
      {
        sessionId: 'sess1',
        seq: 0,
        globalIdx: 0,
        t: 0,
        wall: '2026-01-01T00:00:00.000Z',
        kind: 'terminal.command',
        payload: { terminal_id: 't1', command: 'python hw.py' },
      },
    ];
    render(<EventSidebar events={events} currentGlobalIdx={-1} onSeek={vi.fn()} />);
    await waitFor(() => {
      const row = screen.getByTestId('sidebar-row-0');
      expect(row).toHaveTextContent('python hw.py');
      expect(row).not.toHaveTextContent('exit');
    });
  });
});
```

In `EventList.test.tsx`, add next to the existing terminal.command cases:

```ts
it('terminal.command: appends exit code when present', () => {
  const event = makeEvent({
    kind: 'terminal.command',
    payload: { terminal_id: 'term-1', command: 'python hw1.py', exit_code: 0 },
  });
  expect(payloadSummary(event)).toBe('python hw1.py · exit 0');
});
```

The existing "shows command" test (`python hw1.py`, no exit_code) must still pass.

- [ ] **Step 2: Run tests — expect FAIL**

```
npx vitest run packages/analyzer/src/views/replay/EventSidebar.test.ts packages/analyzer/src/views/timeline/EventList.test.ts
```

(Use `.tsx` if that's the actual extension.)

- [ ] **Step 3: Implement**

`EventSidebar.tsx`:

- `const ROW_HEIGHT = 36;`
- Import `formatWall`, `summarizeTerminalCommand` from `@/lib/format.js`.
- In `SidebarRow`, after the seq span, add:

```tsx
<span className="w-[72px] shrink-0 font-mono text-[10px] text-muted-foreground">
  {formatWall(event.wall)}
</span>
```

- After the file span, if `event.kind === 'terminal.command'`:

```tsx
{
  event.kind === 'terminal.command' &&
    (() => {
      const summary = summarizeTerminalCommand(event.payload as Record<string, unknown> | null);
      if (!summary) return null;
      const full =
        event.payload !== null &&
        typeof (event.payload as Record<string, unknown>)['command'] === 'string'
          ? ((event.payload as Record<string, unknown>)['command'] as string)
          : summary;
      return (
        <span className="min-w-0 truncate text-foreground/80" title={full}>
          {summary}
        </span>
      );
    })();
}
```

Prefer a small helper `function terminalSummary(event: IndexedEvent): { text: string; title: string } | null` in the same file rather than an IIFE if it reads cleaner.

`EventList.tsx` `payloadSummary` terminal.command case becomes:

```ts
case 'terminal.command':
  return summarizeTerminalCommand(p);
```

Delete the local `formatWall` in EventList and import the shared one for the row's wall column. Behaviour for valid timestamps is identical; unparseable walls change from a 12-char slice (or `NaN` padded) to `—`.

- [ ] **Step 4: Run tests — expect PASS**

```
npx vitest run packages/analyzer/src/views/replay/EventSidebar.test.tsx packages/analyzer/src/views/timeline/EventList.test.tsx packages/analyzer/src/lib/format.test.ts
```

No architecture-page change.

---

### Task 3: Persist Active/Idle on submissions

**Files:**

- Create: `packages/server/db/migrations/0021_submissions_active_idle_ms.sql`
- Modify: `packages/server/db/migrations/meta/_journal.json`
- Modify: `packages/server/src/db/schema.ts`
- Modify: `packages/server/src/services/ingest/stats.ts`
- Test: `packages/server/src/services/ingest/stats.test.ts`

Docker must be running (testcontainers).

- [ ] **Step 1: Write the failing tests**

In `stats.test.ts`, after the existing cases:

```ts
it('writes total_active_ms and total_idle_ms onto the submission row', async () => {
  await withTestDb(async (db) => {
    const submissionId = await seedSubmission(db);
    const bundle = makeTwoFileBundle();
    await computeAndStoreStats(db, submissionId, bundle);

    const index = buildIndex(bundle);
    const expected = computeStats(index);

    const [row] = await db
      .select({
        total_active_ms: submissions.total_active_ms,
        total_idle_ms: submissions.total_idle_ms,
      })
      .from(submissions)
      .where(eq(submissions.id, submissionId));
    expect(row!.total_active_ms).toBe(expected.totalActiveMs);
    expect(row!.total_idle_ms).toBe(expected.totalIdleMs);
  });
});

it('writes times even when the bundle has events but no files', async () => {
  await withTestDb(async (db) => {
    const submissionId = await seedSubmission(db);
    const bundle = makeNoFileBundle(); // session.start + session.end only; see below
    await computeAndStoreStats(db, submissionId, bundle);

    const [row] = await db
      .select({
        total_active_ms: submissions.total_active_ms,
        total_idle_ms: submissions.total_idle_ms,
      })
      .from(submissions)
      .where(eq(submissions.id, submissionId));
    expect(row!.total_active_ms).not.toBeNull();
    expect(row!.total_idle_ms).not.toBeNull();

    const cnt = await db
      .select({ cnt: count() })
      .from(per_file_stats)
      .where(eq(per_file_stats.submission_id, submissionId));
    expect(cnt[0]!.cnt).toBe(0);
  });
});
```

Add `makeNoFileBundle()` next to `makeTwoFileBundle`: one session, `session.start` then `session.end` 10s later, no `path`. Mirror the existing synthetic event shape.

- [ ] **Step 2: Run tests — expect FAIL** (missing columns / early return)

```
npx vitest run packages/server/src/services/ingest/stats.test.ts
```

- [ ] **Step 3: Migration + schema + write path**

`0021_submissions_active_idle_ms.sql`:

```sql
-- Migration 0021: denormalize bundle active/idle time onto submissions
--
-- computeStats already produces totalActiveMs / totalIdleMs (60s event-gap)
-- at ingest and recompute, but only per_file_stats was persisted. The cohort
-- list cannot parse bundles, so these two columns let it show Active/Idle
-- without a second read. NULL means not yet written (pre-0021 rows); the
-- analyzer renders an em dash until the next ingest or heuristics recompute.
-- No backfill.

ALTER TABLE submissions
  ADD COLUMN total_active_ms bigint,
  ADD COLUMN total_idle_ms   bigint;
```

Journal: append idx 19, tag `0021_submissions_active_idle_ms`, `when` ≈ now (ms). Follow the 0020 entry shape. No snapshot JSON — 0020 didn't add one.

`schema.ts` on `submissions`, after `top_flags`:

```ts
total_active_ms: bigint('total_active_ms', { mode: 'number' }),
total_idle_ms: bigint('total_idle_ms', { mode: 'number' }),
```

Nullable (no `.notNull()`). `mode: 'number'` matches `size_bytes`.

`stats.ts`: import `eq` and `submissions`. Restructure so the submissions UPDATE always runs:

```ts
const bundleStats = computeStats(index);

await db
  .update(submissions)
  .set({
    total_active_ms: bundleStats.totalActiveMs,
    total_idle_ms: bundleStats.totalIdleMs,
  })
  .where(eq(submissions.id, submissionId));

if (bundleStats.perFile.size === 0) return;
// existing per_file_stats insert unchanged
```

- [ ] **Step 4: Run tests — expect PASS**

```
npx vitest run packages/server/src/services/ingest/stats.test.ts
```

Recompute already calls `computeAndStoreStats` — no separate recompute change.

---

### Task 4: Cohort API + table times + CSV

**Files:**

- Modify: `packages/shared/src/api-schemas.ts` (`SubmissionRowSchema`)
- Modify: `packages/server/src/openapi/spec/components.ts`
- Modify: `packages/server/src/services/cohort/list.ts` (local `SubmissionRow` type + SELECT + map)
- Modify: `packages/analyzer/src/test/msw-handlers.ts`
- Modify: `packages/analyzer/src/views/cohort/CohortTable.tsx`
- Modify: `packages/analyzer/src/views/cohort/ExportCurrentView.tsx`
- Test: `packages/analyzer/src/views/cohort/CohortTable.test.tsx`
- Test: `packages/server/src/services/cohort/list.test.ts` (one assertion that a freshly-seeded row returns `null` times; optional ingest-then-list if cheap)

`total_active_ms` / `total_idle_ms` are **required keys, nullable values**:

```ts
total_active_ms: z.number().int().nullable(),
total_idle_ms: z.number().int().nullable(),
```

OpenAPI: add properties with `nullable: true`; do **not** add them to `required[]` if that would break older documented clients — actually the Zod schema requires the keys, so the live API always sends them. Add to OpenAPI `required` as well so contract and spec agree. Spec said "not in required[]" meaning old rows can be null, not that the key is omitted. **Send the keys always; value may be null. Put them in OpenAPI `required`.**

`list.ts` SELECT adds the two columns; map:

```ts
total_active_ms: row.total_active_ms,
total_idle_ms: row.total_idle_ms,
```

`makeSubmissionRow` defaults: `total_active_ms: null, total_idle_ms: null`.

`CohortTable`: two columns after Flags, before Top Flags. Header tooltips: "Gaps under 60s between events" / "Gaps of 60s or more". Cell: `formatDuration(ms)` or `—`. `data-testid={`active-time-${id}`}` / `idle-time-${id}`.

CSV: headers `active_time`, `idle_time`; values `formatDuration` or `''`.

Tests:

- Row with `total_active_ms: 75_000` shows `1m 15s`.
- Row with `null` shows `—`.
- (CSV) if there is no ExportCurrentView test, add a small unit test of `buildCsv` only if it's exported; otherwise don't extract it just for a test — cover via a focused export of the helper if already testable. If `buildCsv` is not exported, leave CSV untested rather than refactoring for coverage. Prefer exporting `buildCsv` only if it's a one-line `export`. **Do not export just for a test.** Skip CSV unit test; the column list change is obvious.

- [ ] Implement, then:

```
npx vitest run packages/analyzer/src/views/cohort/CohortTable.test.tsx
npx vitest run packages/server/src/services/cohort/list.test.ts
```

`list.test.ts` currently seeds submissions without going through stats — expect `total_active_ms === null`. Add that assertion on an existing list result so a forgotten map shows up.

---

### Task 5: Flag-count dropdown

**Files:**

- Modify: `packages/analyzer/src/views/cohort/CohortTable.tsx`
- Test: `packages/analyzer/src/views/cohort/CohortTable.test.tsx`

Replace the inert `SeverityBadge` in the Flags column with a `FlagCountBadge` that:

- Renders nothing when `count === 0` (same as today).
- Is a `DropdownMenu` trigger (button) showing the count, same colour classes.
- `onClick` / `onPointerDown` `stopPropagation` so the student-cell link is not involved (the badge is a different cell; still stop it).
- `useQuery` with `queryKey: ['submission', submissionId, 'flags']`, `enabled: open`, `staleTime: 30_000`.
- `apiFetch('/submissions/${id}/flags', undefined, z.object({ flags: z.array(FlagRowSchema) }))`.
- Filter `flags.filter((f) => f.severity === sev)`.
- Loading: "Loading…" in the menu. Empty: "No flags". Error: "Couldn't load flags".
- Each item: `DropdownMenuItem asChild` wrapping ``<Link to={`${basePath}/sub/${id}?tab=overview&flag=${heuristic_id}`}>``. Label: `title` if non-empty, else `heuristic_id.replace(/_/g, ' ')`.
- `data-testid={`flag-count-${sev}-${submissionId}`}`.

MSW: `test-setup` already runs the default handlers. Override per test:

```ts
import { mswServer } from '../../test-setup.js';
import { http, HttpResponse } from 'msw';

mswServer.use(
  http.get('/api/v1/submissions/:id/flags', () =>
    HttpResponse.json({
      flags: [
        {
          id: '...',
          heuristic_id: 'large_paste',
          severity: 'high',
          confidence: 1,
          score_contribution: 1,
          title: 'Large paste in hw.py',
        },
        {
          id: '...',
          heuristic_id: 'external_edits',
          severity: 'medium',
          confidence: 1,
          score_contribution: 1,
        },
      ],
    }),
  ),
);
```

Use `DropdownMenu open` if portal content is hard to query after click (see `SpeedControl.test.tsx`). Prefer a real click on the badge first; fall back to `open` if jsdom + radix fights you.

Tests:

1. `flag_counts.high === 0` → no `flag-count-high-*` in the document.
2. `flag_counts.high === 2` → badge is a button named `2` (or with accessible name including 2).
3. Open menu → lists only `high` flags; medium flag absent.
4. Item is a link to `.../sub/<id>?tab=overview&flag=large_paste`.

FlagRow required fields: `id`, `heuristic_id`, `severity`, `confidence`, `score_contribution`. Optional `title`. Check `FlagRowSchema` and include every required key in the mock.

- [ ] Run:

```
npx vitest run packages/analyzer/src/views/cohort/CohortTable.test.tsx
```

No architecture-page change.

---

### Task 6: Architecture page

**Files:**

- Modify: `packages/analyzer/src/views/architecture/content/nodes/er.ts`
- Modify: `packages/analyzer/src/views/architecture/content/nodes/readpath.ts`

`er.ts` `submissions.body`: the paragraph that starts "Three columns exist purely so the cohort list can be a single query" — extend it. The denormalized set is flag_counts, top_flags, severity_rank, **plus** `total_active_ms` / `total_idle_ms` written by `computeAndStoreStats` (nullable until the next ingest/recompute). Add a link to `0021_submissions_active_idle_ms.sql` next to 0014.

`readpath.ts` `r_cohort.body`: list also reads `total_active_ms` / `total_idle_ms`; still no bundle parse. Add the same migration link.

Do **not** edit `.dot` files unless a node label must change (it doesn't). Skip `build_diagrams.py`.

- [ ] Run:

```
npx vitest run packages/analyzer/src/views/architecture
```

---

### Task 7: Lint / typecheck the touched packages

```
npm run typecheck --workspace=packages/shared
npm run typecheck --workspace=packages/server
npm run typecheck --workspace=packages/analyzer
npm run lint
```

Fix anything this change introduced. Do not opportunistically reformat unrelated files.

---

## Done when

- Replay sidebar shows wall time on every event and command + exit code on `terminal.command`.
- Timeline `payloadSummary` shows exit code too.
- Flag count badges open a severity-filtered list; names deep-link to Overview.
- New ingest/recompute writes Active/Idle; old rows are `null` / `—`.
- CSV has the two time columns.
- Architecture prose matches.
- Tests above pass. No new dependencies.
