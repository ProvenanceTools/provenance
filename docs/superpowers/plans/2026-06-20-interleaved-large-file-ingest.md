# Interleaved Large-File Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the large-file (resumable / local-path) ingest start processing bundles as soon as their rows are staged, instead of staging every row first and only then enqueuing any processing.

**Architecture:** Today `ingestLocalPath` runs in two phases — stage _all_ `ingest_files` rows (the "Total" the UI watches climb), then enqueue all `ingest_file` jobs at the end. We move the per-file `boss.send(INGEST_FILE)` _inside_ the staging loop so workers begin immediately. The reason it was batched at the end is the finalize trigger: `maybeEnqueueFinalize` fires when zero `ingest_files` rows are still `pending`, so a fast worker draining the queue during a staging lull would finalize the job before later bundles are staged. We gate finalize behind a new `ingest_jobs.staging_complete` flag (default `true`); the streaming stager sets it `false` while it runs and `true` when the loop finishes, then triggers one finalize check. Atomic-staging callers (HTTP routes) keep the `true` default and are untouched.

**Tech Stack:** TypeScript (strict, ESM), Hono, Drizzle ORM, Postgres, pg-boss, S3/MinIO, Vitest + testcontainers.

## Global Constraints

- **No new dependencies.** Everything used here (`drizzle-orm`, `pg-boss`, `vitest`, testcontainers helpers) already exists in `packages/server`.
- **Events are append-only; ingest stages are ordered and idempotent.** A retry of any stage must produce the same flags/stats. Do not change the parse → match → heuristics → cross-flags ordering inside a single file's processing.
- **There is exactly one finalize-trigger function.** After this change it lives in `services/ingest/job-control.ts` and is imported by both the worker and the local-path stager. Do not create a second copy.
- **`log-core` import rules do not apply here** — all files touched are in `packages/server` (Node runtime).
- **Migrations live in `packages/server/db/migrations/`** and are tracked by `db/migrations/meta/_journal.json`. Generate them with `npm run db:generate --workspace=packages/server` (drizzle-kit diffs `schema.ts` against the latest snapshot — no DB connection needed for `generate`). Never hand-edit the journal.
- **Tests use testcontainers** (`withTestDb`, `withTestMinio`) — Docker must be running. Do not point tests at the dev compose stack.

---

## File Structure

- `packages/server/src/db/schema.ts` — add `staging_complete` column to `ingest_jobs`.
- `packages/server/db/migrations/0018_*.sql` (+ snapshot + journal) — generated migration for the new column.
- `packages/server/src/services/ingest/job-control.ts` — new home for `maybeEnqueueFinalize` (now gated on `staging_complete`) plus `markStagingStarted` / `markStagingComplete`; new exported `IngestFinalizePayload` type.
- `packages/server/src/services/ingest/job-control.test.ts` — unit tests for the gate and the two flag setters.
- `packages/server/src/jobs/worker.ts` — delete the private `maybeEnqueueFinalize` and private `IngestFinalizePayload`; import both from `job-control.js`. Call sites unchanged.
- `packages/server/src/services/ingest/local-path.ts` — enqueue `ingest_file` jobs inside the staging loop; set `staging_complete=false` on entry and `true` after the loop, then trigger one finalize check.
- `packages/server/src/services/ingest/local-path.e2e.test.ts` — existing multi-bundle e2e remains the end-to-end regression guard; assert final counts.

---

## Task 1: Add `staging_complete` column to `ingest_jobs`

**Files:**

- Modify: `packages/server/src/db/schema.ts:373-403` (the `ingest_jobs` table)
- Create: `packages/server/db/migrations/0018_<generated>.sql` (+ `meta/0018_snapshot.json`, updated `meta/_journal.json`) via drizzle-kit

**Interfaces:**

- Consumes: nothing.
- Produces: `ingest_jobs.staging_complete: boolean` (NOT NULL, default `true`). Column name `staging_complete`; Drizzle field name `staging_complete`.

- [ ] **Step 1: Ensure `boolean` is imported in schema.ts**

Check the top-of-file `drizzle-orm/pg-core` import. If `boolean` is not already in the list, add it. The import looks like:

```typescript
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  boolean, // <-- add if missing
  // ...existing imports...
} from 'drizzle-orm/pg-core';
```

- [ ] **Step 2: Add the column to the `ingest_jobs` table**

In `packages/server/src/db/schema.ts`, inside the `ingest_jobs` `pgTable` column object, add `staging_complete` immediately after `summary`:

```typescript
    summary: jsonb('summary')
      .notNull()
      .default(sql`'{}'`),
    // True once all ingest_files rows for this job have been staged (no more
    // will be added). The streaming local-path stager sets this false while it
    // streams and true when done; maybeEnqueueFinalize will not finalize a job
    // until it is true. Atomic-staging callers (HTTP /ingest, :gradescope)
    // create all rows before any worker runs, so they keep the default true.
    staging_complete: boolean('staging_complete')
      .notNull()
      .default(true),
```

- [ ] **Step 3: Generate the migration**

Run: `npm run db:generate --workspace=packages/server`
Expected: a new file `packages/server/db/migrations/0018_<random-name>.sql`, a new `meta/0018_snapshot.json`, and an appended entry in `meta/_journal.json`.

- [ ] **Step 4: Verify the generated SQL**

Read the generated `0018_*.sql`. Expected content (exact column clause):

```sql
ALTER TABLE "ingest_jobs" ADD COLUMN "staging_complete" boolean DEFAULT true NOT NULL;
```

If drizzle-kit also tries to drop/recreate unrelated objects, discard the migration, re-check Step 2, and regenerate — the only change must be this one column.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck --workspace=packages/server`
Expected: passes (the new field is referenced by name in Task 2).

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/db/schema.ts packages/server/db/migrations/0018_*.sql packages/server/db/migrations/meta/_journal.json packages/server/db/migrations/meta/0018_snapshot.json
git commit --no-gpg-sign -m "feat(server): add ingest_jobs.staging_complete column"
```

---

## Task 2: Finalize gate + staging-flag setters in job-control

Add the gated finalize trigger and the two flag setters, owned by `job-control.ts` (it already owns all `ingest_jobs` lifecycle writes). Test-first.

**Files:**

- Modify: `packages/server/src/services/ingest/job-control.ts`
- Test: `packages/server/src/services/ingest/job-control.test.ts`

**Interfaces:**

- Consumes: `ingest_jobs`, `ingest_files` (schema); `JOB_KINDS` from `../../jobs/pg-boss.js`; `getLogger` from `../../logging.js`; `count, and, eq` from `drizzle-orm`; `PgBoss` type from `pg-boss`.
- Produces (all exported from `job-control.ts`):
  - `interface IngestFinalizePayload { ingestJobId: string }`
  - `async function markStagingStarted(db: DrizzleDb, jobId: string): Promise<void>` — sets `staging_complete=false`.
  - `async function markStagingComplete(db: DrizzleDb, jobId: string): Promise<void>` — sets `staging_complete=true`.
  - `async function maybeEnqueueFinalize(boss: PgBoss, db: DrizzleDb, ingestJobId: string): Promise<void>` — sends `INGEST_FINALIZE` (singletonKey, retryLimit 5) **only when** the job's `staging_complete` is `true` **and** zero `ingest_files` rows remain `pending`. Signature is `(boss, db, jobId)` to match the existing worker call sites verbatim.

- [ ] **Step 1: Write the failing tests**

Append to `packages/server/src/services/ingest/job-control.test.ts`. Add these imports to the existing import block if absent: `ingest_files` (from schema), `markStagingStarted`, `markStagingComplete`, `maybeEnqueueFinalize` (from `./job-control.js`). Reuse the existing `seedUser` / `seedSemester` helpers.

```typescript
// ---------------------------------------------------------------------------
// maybeEnqueueFinalize — staging_complete gate
// ---------------------------------------------------------------------------

/** Insert a terminal (non-pending) ingest_files row so it is NOT counted as pending. */
async function seedTerminalFile(db: DrizzleDb, jobId: string) {
  await db.insert(ingest_files).values({
    id: crypto.randomUUID(),
    ingest_job_id: jobId,
    original_filename: 'f.zip',
    size_bytes: 1,
    blob_sha256: 'a'.repeat(64),
    status: 'matched',
  });
}

/** Insert a pending ingest_files row. */
async function seedPendingFile(db: DrizzleDb, jobId: string) {
  await db.insert(ingest_files).values({
    id: crypto.randomUUID(),
    ingest_job_id: jobId,
    original_filename: 'p.zip',
    size_bytes: 1,
    blob_sha256: 'b'.repeat(64),
    status: 'pending',
  });
}

describe('maybeEnqueueFinalize gate', () => {
  it('does NOT enqueue finalize while staging_complete is false, even with 0 pending', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markStagingStarted(db, jobId); // staging_complete = false
      await seedTerminalFile(db, jobId); // 0 pending

      const boss = { send: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await maybeEnqueueFinalize(boss as any, db, jobId);

      expect(boss.send).not.toHaveBeenCalled();
    });
  });

  it('enqueues finalize once staging_complete is true and 0 pending', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      await markStagingStarted(db, jobId);
      await seedTerminalFile(db, jobId);
      await markStagingComplete(db, jobId); // staging_complete = true

      const boss = { send: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await maybeEnqueueFinalize(boss as any, db, jobId);

      expect(boss.send).toHaveBeenCalledTimes(1);
    });
  });

  it('does NOT enqueue finalize when files are still pending', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);
      // staging_complete defaults true; but a pending file remains.
      await seedPendingFile(db, jobId);

      const boss = { send: vi.fn() };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await maybeEnqueueFinalize(boss as any, db, jobId);

      expect(boss.send).not.toHaveBeenCalled();
    });
  });

  it('markStagingStarted then markStagingComplete flips staging_complete', async () => {
    await withTestDb(async (db) => {
      const user = await seedUser(db);
      const semester = await seedSemester(db, user.id);
      const { jobId } = await enqueueIngestJob(db, semester.id, user.id);

      await markStagingStarted(db, jobId);
      let row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.staging_complete).toBe(false);

      await markStagingComplete(db, jobId);
      row = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
      expect(row.staging_complete).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test --workspace=packages/server -- job-control.test`
Expected: FAIL — `markStagingStarted` / `markStagingComplete` / `maybeEnqueueFinalize` are not exported from `job-control.js`.

- [ ] **Step 3: Implement the additions in job-control.ts**

Update the imports at the top of `packages/server/src/services/ingest/job-control.ts`:

```typescript
import type { DrizzleDb } from '../../db/client.js';
import { ingest_jobs, ingest_files } from '../../db/schema.js';
import { eq, and, ne, count } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { JOB_KINDS } from '../../jobs/pg-boss.js';
import { getLogger } from '../../logging.js';
import { Errors } from '../../api/v1/errors.js';
```

Append these to the module (e.g. just after `failIngestJob`):

```typescript
// ---------------------------------------------------------------------------
// Staging-completion flags + gated finalize trigger
// ---------------------------------------------------------------------------

/** pg-boss payload for an `ingest_finalize` job. */
export interface IngestFinalizePayload {
  ingestJobId: string;
}

/**
 * Marks a job as still staging (`staging_complete=false`). Called by the
 * streaming local-path stager before it enqueues any per-file jobs, so a worker
 * that drains the queue during a staging lull cannot finalize the job early.
 */
export async function markStagingStarted(db: DrizzleDb, jobId: string): Promise<void> {
  await db.update(ingest_jobs).set({ staging_complete: false }).where(eq(ingest_jobs.id, jobId));
}

/**
 * Marks a job as fully staged (`staging_complete=true`). Called by the stager
 * once its loop completes; after this, maybeEnqueueFinalize is allowed to settle
 * the job.
 */
export async function markStagingComplete(db: DrizzleDb, jobId: string): Promise<void> {
  await db.update(ingest_jobs).set({ staging_complete: true }).where(eq(ingest_jobs.id, jobId));
}

/**
 * After a file transitions to a terminal status, settle the job if (a) staging
 * is complete and (b) no files remain pending. Enqueues one `ingest_finalize`
 * job with `singletonKey = ingestJobId` so pg-boss deduplicates concurrent
 * sends and only one finalize runs per job.
 *
 * The `staging_complete` gate is what makes interleaved staging safe: while the
 * streaming stager is still adding rows, a momentarily-empty pending count must
 * NOT finalize the job.
 *
 * Signature is (boss, db, jobId) to match the worker's existing call sites.
 */
export async function maybeEnqueueFinalize(
  boss: PgBoss,
  db: DrizzleDb,
  ingestJobId: string,
): Promise<void> {
  const jobRows = await db
    .select({ stagingComplete: ingest_jobs.staging_complete })
    .from(ingest_jobs)
    .where(eq(ingest_jobs.id, ingestJobId));
  const job = jobRows[0];
  if (!job || !job.stagingComplete) {
    // Job gone, or staging still in flight — don't finalize yet.
    return;
  }

  const pendingCount = await db
    .select({ cnt: count() })
    .from(ingest_files)
    .where(and(eq(ingest_files.ingest_job_id, ingestJobId), eq(ingest_files.status, 'pending')));

  const remaining = pendingCount[0]?.cnt ?? 0;
  if (remaining === 0) {
    // PRD §12.3: finalize jobs retry up to 5 times.
    await boss.send(JOB_KINDS.INGEST_FINALIZE, { ingestJobId } satisfies IngestFinalizePayload, {
      singletonKey: ingestJobId,
      retryLimit: 5,
    });
    getLogger().info({ ingestJobId }, 'ingest_finalize: enqueued');
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace=packages/server -- job-control.test`
Expected: PASS (all four new tests, plus the pre-existing job-control tests).

- [ ] **Step 5: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/server && npm run lint`
Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/services/ingest/job-control.ts packages/server/src/services/ingest/job-control.test.ts
git commit --no-gpg-sign -m "feat(server): gate ingest finalize on staging_complete flag"
```

---

## Task 3: Point the worker at the shared finalize trigger

Pure refactor: delete the worker's private `maybeEnqueueFinalize` and private `IngestFinalizePayload`, import both from `job-control.js`. The six call sites stay byte-for-byte identical because the signature is preserved.

**Files:**

- Modify: `packages/server/src/jobs/worker.ts` (delete lines `81` interface and `731-750` function; add an import)

**Interfaces:**

- Consumes: `maybeEnqueueFinalize`, `IngestFinalizePayload` from `../services/ingest/job-control.js`.
- Produces: nothing new.

- [ ] **Step 1: Add the import**

In `packages/server/src/jobs/worker.ts`, find the existing import from `job-control.js` (it already imports e.g. `failIngestJob`, `markIngestJobRunning`). Add `maybeEnqueueFinalize` and the type `IngestFinalizePayload` to it:

```typescript
import {
  // ...existing job-control imports...
  maybeEnqueueFinalize,
} from '../services/ingest/job-control.js';
import type { IngestFinalizePayload } from '../services/ingest/job-control.js';
```

(If the existing import is a single statement, fold `maybeEnqueueFinalize` into it and add a sibling `import type { IngestFinalizePayload }` line.)

- [ ] **Step 2: Delete the private `IngestFinalizePayload` interface**

Remove the local declaration at `worker.ts:81`:

```typescript
interface IngestFinalizePayload {
  ingestJobId: string;
}
```

The remaining use at `worker.ts:557` (`boss.work<IngestFinalizePayload>(...)`) now resolves to the imported type.

- [ ] **Step 3: Delete the private `maybeEnqueueFinalize` function**

Remove the entire private function at `worker.ts:731-750` (the `async function maybeEnqueueFinalize(...) { ... }` block and its doc comment). All call sites (`worker.ts:259, 287, 314, 358, 532`) keep calling `maybeEnqueueFinalize(boss, db, ingestJobId)` — now the imported version.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=packages/server`
Expected: passes. (If it reports `count` is now unused in worker.ts, leave it only if still used elsewhere; otherwise remove `count` from the worker's `drizzle-orm` import.)

- [ ] **Step 5: Run the worker/ingest e2e suites**

Run: `npm run test --workspace=packages/server -- worker ingest-gradescope`
Expected: PASS. These jobs are created via the HTTP routes (default `staging_complete=true`), so the gate is transparent and finalize still fires exactly as before.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/jobs/worker.ts
git commit --no-gpg-sign -m "refactor(server): move maybeEnqueueFinalize into job-control"
```

---

## Task 4: Interleave enqueue with staging in `ingestLocalPath`

Move the per-file `boss.send` into the staging loop; mark staging started on entry and complete after the loop, then trigger one finalize check. This is the change the user actually asked for — processing begins while later bundles are still being staged.

**Files:**

- Modify: `packages/server/src/services/ingest/local-path.ts`
- Test: `packages/server/src/services/ingest/local-path.e2e.test.ts` (existing multi-bundle e2e is the regression guard)

**Interfaces:**

- Consumes: `markStagingStarted`, `markStagingComplete`, `maybeEnqueueFinalize` from `./job-control.js`; `getBoss`, `JOB_KINDS` (already imported).
- Produces: unchanged `IngestLocalPathResult`.

- [ ] **Step 1: Update imports in local-path.ts**

Extend the existing `job-control.js` import:

```typescript
import {
  enqueueIngestJob,
  failIngestJob,
  markStagingStarted,
  markStagingComplete,
  maybeEnqueueFinalize,
} from './job-control.js';
```

- [ ] **Step 2: Mark staging started for a pre-created job, and grab the boss**

In `ingestLocalPath`, just after `let jobId: string | null = existingJobId;` (currently around line 102) and before the `try`/`for await` staging loop, add:

```typescript
const boss = await getBoss();

// A pre-created job (resumable /complete path) exists with the default
// staging_complete=true; flip it false before we enqueue anything so a fast
// worker cannot finalize mid-stream. Lazily-created jobs are flipped at
// creation time below.
if (jobId !== null) {
  await markStagingStarted(db, jobId);
}
```

- [ ] **Step 3: Mark staging started on lazy job creation**

In the loop, update the lazy-create branch (currently lines 128-131):

```typescript
// Lazily create the job on the first real bundle.
if (jobId === null) {
  jobId = (await enqueueIngestJob(db, semesterId, userId)).jobId;
  await markStagingStarted(db, jobId);
}
```

- [ ] **Step 4: Enqueue each file inside the loop, right after its row is inserted**

Replace the inner submitter loop (currently lines 134-151) so the `boss.send` happens per row instead of in a batch at the end:

```typescript
bundlesProcessed++;
for (const submitter of sub.submitters) {
  const fileId = crypto.randomUUID();
  const { blobSha256, sizeBytes } = await stageBlob(
    { storageClient },
    { jobId, ingestFileId: fileId, body: sub.bundleZip },
  );
  await db.insert(ingest_files).values({
    id: fileId,
    ingest_job_id: jobId,
    original_filename: `${sub.folderKey}.zip`,
    size_bytes: sizeBytes,
    blob_sha256: blobSha256,
    status: 'pending',
    match_sid: submitter.sid,
  });
  // Enqueue immediately so the worker starts on this bundle while we
  // stream the next ones. Safe because the job's staging_complete is
  // false until the loop finishes (see Step 2/3), so maybeEnqueueFinalize
  // will not settle the job early. PRD §12.3: retry up to 3 times.
  await boss.send(
    JOB_KINDS.INGEST_FILE,
    { ingestFileId: fileId, ingestJobId: jobId },
    { retryLimit: 3 },
  );
  submissionsQueued++;
}
```

Note: the `stagedFileIds` array is no longer needed — remove its declaration (`const stagedFileIds: string[] = [];`, currently line 99) and the `stagedFileIds.push(fileId);` line.

- [ ] **Step 5: Replace the batched end-of-loop enqueue with the staging-complete barrier**

Delete the post-loop block that read rows back and enqueued them (currently lines 161-178, the `// Enqueue one ingest_file job per staged file, after all staging succeeds` block). Replace it with:

```typescript
// Staging finished cleanly. Mark the job fully staged so finalize is now
// permitted, then trigger one check in case every enqueued file already
// drained before we got here (no worker would otherwise re-trigger it).
if (jobId !== null) {
  await markStagingComplete(db, jobId);
  await maybeEnqueueFinalize(boss, db, jobId);
}
```

The `eq` import and the read-back of `ingest_files` rows are no longer used by this block — if `eq` is now unused in the file, remove it from the `drizzle-orm` import. (It may still be used elsewhere; check before removing.)

Leave the `catch (stagingErr)` compensation (`failIngestJob`) unchanged. **Known behavior change to note in the commit body:** with interleaving, bundles staged _before_ a mid-stream staging error have already been enqueued and may be processed by workers; the job is still marked `failed` (its `staging_complete` stays `false`, so `maybeEnqueueFinalize` never settles it). This matches the existing contract that a staging error fails the job; the difference is that earlier, valid submissions may have been materialized. This is acceptable — they are real submissions — and the failure is surfaced via `failIngestJob`.

- [ ] **Step 6: Run the local-path e2e**

Run: `npm run test --workspace=packages/server -- local-path.e2e`
Expected: PASS. The existing multi-bundle export test drives the real worker through pg-boss and asserts the final job/summary state. If interleaving caused an early finalize, the asserted counts (or job status) would be wrong — so this test passing under real timing confirms the gate holds.

- [ ] **Step 7: Add an explicit final-count assertion if not already present**

Open `packages/server/src/services/ingest/local-path.e2e.test.ts`. Confirm the multi-bundle test asserts on the _finalized_ `ingest_jobs` row — specifically that `status` is `succeeded` (or `partial`) and `summary.total` equals the number of staged submissions. If such an assertion is missing, add it after the worker drains:

```typescript
const jobRow = (await db.select().from(ingest_jobs).where(eq(ingest_jobs.id, jobId)))[0]!;
expect(jobRow.staging_complete).toBe(true);
expect(['succeeded', 'partial']).toContain(jobRow.status);
// total must equal every submission we staged — an early finalize would
// under-count or leave the job settled before later files landed.
expect((jobRow.summary as { total: number }).total).toBe(expectedSubmissionCount);
```

Replace `expectedSubmissionCount` with the count the test already knows it staged (the test constructs the export, so this is a literal or a derived count already in scope).

- [ ] **Step 8: Run the local-path e2e again**

Run: `npm run test --workspace=packages/server -- local-path.e2e`
Expected: PASS.

- [ ] **Step 9: Typecheck + lint**

Run: `npm run typecheck --workspace=packages/server && npm run lint`
Expected: passes.

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/services/ingest/local-path.ts packages/server/src/services/ingest/local-path.e2e.test.ts
git commit --no-gpg-sign -m "feat(server): interleave per-file processing with large-file staging"
```

---

## Final verification

- [ ] **Run the full server suite**

Run: `npm run test --workspace=packages/server`
Expected: PASS (Docker running for testcontainers).

- [ ] **Whole-repo gates**

Run: `npm run typecheck && npm run lint`
Expected: passes.

---

## Self-Review notes

- **Spec coverage:** The user's request ("process bundles as they're staged instead of staging all rows first") is implemented in Task 4 (interleaved `boss.send`). The correctness hazard it exposes (early finalize) is handled by Tasks 1–3 (the `staging_complete` gate). No PRD product behavior changes — the parse → match → heuristics → cross-flags ordering within a file is untouched, and the finalize/summary contract is preserved.
- **Scope:** Atomic-staging callers (HTTP `/ingest`, `:gradescope`) are deliberately untouched — their jobs default `staging_complete=true`, so the gate is a no-op for them. Only `ingestLocalPath` (resumable large-file + CLI local-path) opts in.
- **Type consistency:** `maybeEnqueueFinalize(boss, db, jobId)` keeps the exact signature the worker already calls, so Task 3 needs zero call-site edits. `IngestFinalizePayload` moves from `worker.ts` to `job-control.ts` and is imported back — one definition, no duplication. The Drizzle field is `staging_complete` everywhere (schema, setters, gate query, test assertions).
- **Open question for the reviewer:** the interleaving behavior change on the mid-stream staging-error path (Step 5 note) — earlier valid bundles may be materialized before the job is marked `failed`. Flagged in the commit body; confirm this is acceptable, or we add a cancellation sweep for in-flight files on staging error (out of scope for this plan).
