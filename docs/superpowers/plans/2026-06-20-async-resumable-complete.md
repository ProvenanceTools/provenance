# Async resumable `/complete` (fix stuck-at-100% large upload) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the resumable Gradescope upload `/complete` endpoint return a `job_id` immediately and perform the heavy assemble→download→stage work in a background pg-boss job, so the analyzer stops appearing frozen at "Uploading… 100%" on 2+ GB exports.

**Architecture:** Today `POST /ingest/uploads/:uploadId/complete` runs `completeResumableUpload` synchronously inside the HTTP request — completing the S3 multipart upload, downloading the whole assembled ZIP to a temp file, then staging one blob + `ingest_files` row per submitter — which takes minutes for a large export while the UI sits at 100% with no feedback. We move that work to a new `ingest_stage_upload` background job: the route creates the `ingest_jobs` row up front (status `queued`), enqueues the staging job, and returns `202 { job_id, … }` at once. The analyzer already navigates to the job view on `job_id` and polls `GET /ingest/jobs/:jobId` every 3 s, so the existing per-file → finalize machinery surfaces progress with **no client changes**. The staging job reuses `completeResumableUpload`/`ingestLocalPath` via a threaded pre-created `jobId`.

**Tech Stack:** Node + Hono + Drizzle + pg-boss + S3/MinIO; Vitest with testcontainers (ephemeral Postgres + MinIO).

## Global Constraints

- **Scope is server-only.** Do NOT modify `packages/analyzer/**`, `packages/shared/**`, or any DB migration. The HTTP response shape of `/complete` is preserved (`{ job_id, roster, bundles_processed, submissions_queued, skipped }`); the immediate response carries placeholder values (`roster {added:0,updated:0}`, counts `0`, `skipped []`) because the real counts are reported via the polled job. The analyzer navigates on `job_id` and ignores these fields.
- **Reuse the existing ingest-job status channel.** No new status table, no new `ingest_jobs.status` value. The `queued → running → {succeeded|partial|failed}` lifecycle and `finalizeIngestJob`/`maybeEnqueueFinalize` machinery are unchanged.
- **The staging job does NOT auto-retry.** S3 multipart completion is non-idempotent (the upload id is consumed on first complete), so the `ingest_stage_upload` job is enqueued with `retryLimit: 0`; on any failure the handler marks the ingest job `failed` so the UI surfaces it rather than hanging.
- **Stage-all-then-enqueue ordering.** `ingestLocalPath` already stages every `ingest_files` row before enqueuing any per-file job; preserve this so a crash mid-staging never triggers a premature finalize.
- **Architecture rule:** `enqueueIngestJob` only creates the row (status `queued`); the per-file worker transitions it to `running` via `markIngestJobRunning`. Do not transition status from the route or the staging job (except the explicit `failIngestJob` compensation path and the roster-only finalize enqueue).
- Conventional-commit messages; `git commit --no-gpg-sign`; no `Co-Authored-By` trailer.
- TypeScript strict mode; no `any` except at FFI boundaries with a comment.

---

## File Structure

- **Modify** `packages/server/src/jobs/pg-boss.ts` — add `INGEST_STAGE_UPLOAD` to `JOB_KINDS`.
- **Modify** `packages/server/src/services/ingest/local-path.ts` — accept an optional pre-created `jobId` in `IngestLocalPathArgs`.
- **Modify** `packages/server/src/services/ingest/resumable-upload.ts` — accept an optional `jobId` in `CompleteResumableArgs`, thread it to `ingestLocalPath`.
- **Create** `packages/server/src/services/ingest/stage-upload-job.ts` — `IngestStageUploadPayload` type + `stageUploadIntoJob(deps, args)` orchestration (calls `completeResumableUpload` with the pre-created `jobId`, fails the job on error, enqueues finalize for the roster-only/all-skipped case).
- **Create** `packages/server/src/services/ingest/stage-upload-job.e2e.test.ts` — testcontainers e2e proving the async path reaches the same end state as the sync service path, plus the roster-only finalize path.
- **Modify** `packages/server/src/jobs/worker.ts` — create the queue and register the `ingest_stage_upload` handler delegating to `stageUploadIntoJob`.
- **Modify** `packages/server/src/api/v1/routes/ingest.ts` — rewrite the `/complete` handler to create the job eagerly, enqueue the staging job, and return `202` immediately.
- **Modify** `packages/server/src/services/ingest/local-path.e2e.test.ts` — add a case for the pre-created-`jobId` path.
- **Modify** `docs/server` ingest docs (the file updated by commit `d92c327`) — note that resumable `/complete` is now async (counts via job status).

---

## Task 1: Add the `ingest_stage_upload` job kind

**Files:**

- Modify: `packages/server/src/jobs/pg-boss.ts:14-55`

**Interfaces:**

- Produces: `JOB_KINDS.INGEST_STAGE_UPLOAD === 'ingest_stage_upload'` (consumed by the route, worker, and staging service).

- [ ] **Step 1: Add the kind to the registry and the doc comment**

In `packages/server/src/jobs/pg-boss.ts`, add the new line to the `JOB_KINDS` object (immediately after `INGEST_FINALIZE`):

```ts
export const JOB_KINDS = {
  INGEST_FILE: 'ingest_file',
  INGEST_FINALIZE: 'ingest_finalize',
  INGEST_STAGE_UPLOAD: 'ingest_stage_upload',
  RECOMPUTE_SEMESTER: 'recompute_semester',
  RECOMPUTE_SUBMISSION: 'recompute_submission',
  RECOMPUTE_FINALIZE: 'recompute_finalize',
  RECOMPUTE_CROSS_FLAGS: 'recompute_cross_flags',
  PURGE_EXPIRED_EXPORTS: 'purge_expired_exports',
  PURGE_EXPIRED_SESSIONS: 'purge_expired_sessions',
  RETENTION_SWEEP: 'retention_sweep',
} as const;
```

And add one line to the job-kinds doc comment block (after the `ingest_finalize` line, around line 16):

```
 *   ingest_stage_upload   — assemble a completed resumable upload + stage its bundles
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=packages/server`
Expected: PASS (no usages yet; the const is additive).

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/jobs/pg-boss.ts
git commit --no-gpg-sign -m "feat(server): add ingest_stage_upload job kind"
```

---

## Task 2: Thread an optional pre-created `jobId` through `ingestLocalPath` and `completeResumableUpload`

This lets the background staging job stage into an `ingest_jobs` row the route created up front, instead of `ingestLocalPath` lazily creating its own. Existing callers that omit `jobId` keep today's lazy-create behavior exactly.

**Files:**

- Modify: `packages/server/src/services/ingest/local-path.ts:34-93`
- Modify: `packages/server/src/services/ingest/resumable-upload.ts:120-159`
- Test: `packages/server/src/services/ingest/local-path.e2e.test.ts`

**Interfaces:**

- Consumes: `JOB_KINDS` (unused here), `enqueueIngestJob` (existing).
- Produces:
  - `IngestLocalPathArgs.jobId?: string` — when set, stage into this job (no lazy create); the result's `jobId` equals it even for a roster-only export (`submissionsQueued: 0`).
  - `CompleteResumableArgs.jobId?: string` — forwarded to `ingestLocalPath`.

- [ ] **Step 1: Add the failing test for the pre-created-`jobId` path**

Open `packages/server/src/services/ingest/local-path.e2e.test.ts`, read it fully to match its setup helpers (it already builds a Gradescope export and a semester/user). Add a new `it(...)` inside the existing `describe`, mirroring the existing happy-path test but pre-creating the job and passing `jobId`. Use the file's existing helpers/fixtures for building the export and the DB rows; the assertion is the new behavior:

```ts
it('stages into a pre-created job when jobId is supplied', async () => {
  // ... reuse the file's existing setup to get: db, storageClient, semesterId,
  // userId, archivePath, and cfg (see the existing happy-path test above) ...

  const { jobId } = await enqueueIngestJob(db, semesterId, userId);

  const result = await ingestLocalPath(
    { db, storageClient },
    {
      semesterId,
      userId,
      archivePath,
      maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
      maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
      jobId,
    },
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  // Stages into the SAME job we created — no second job row.
  expect(result.jobId).toBe(jobId);
  const jobRows = await db.select({ id: ingest_jobs.id }).from(ingest_jobs);
  expect(jobRows).toHaveLength(1);
});
```

Add the imports the test needs at the top of the file if missing: `enqueueIngestJob` from `./job-control.js` and `ingest_jobs` from `../../db/schema.js` (match the existing import style in the file).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=packages/server -- local-path.e2e`
Expected: FAIL — `ingestLocalPath` does not yet accept `jobId`, so either a TS error surfaces or `result.jobId` is a freshly-created id ≠ `jobId` and the "1 job row" assertion fails (a second row was created).

- [ ] **Step 3: Add `jobId` to `IngestLocalPathArgs` and use it**

In `packages/server/src/services/ingest/local-path.ts`, add the field to the args interface (after `maxBatchFiles`):

```ts
export interface IngestLocalPathArgs {
  semesterId: string;
  /** User id recorded as `ingest_jobs.uploaded_by`. */
  userId: string;
  /** Absolute (or process-cwd-relative) path to the export ZIP on disk. */
  archivePath: string;
  maxBundleBytes: number;
  maxBatchFiles: number;
  /**
   * Optional pre-created ingest job to stage into. When set, the function does
   * NOT lazily create its own job — even a roster-only export returns this id
   * (with `submissionsQueued: 0`) so the caller can settle the job. Used by the
   * async resumable `ingest_stage_upload` path; omit it for the synchronous
   * single-request / CLI local-path callers (which keep lazy creation).
   */
  jobId?: string;
}
```

Then change the destructure and the `jobId` initializer. Replace:

```ts
const { semesterId, userId, archivePath, maxBundleBytes, maxBatchFiles } = args;
```

with:

```ts
const { semesterId, userId, archivePath, maxBundleBytes, maxBatchFiles } = args;
const existingJobId = args.jobId ?? null;
```

And replace the `let jobId` declaration:

```ts
let jobId: string | null = null;
```

with:

```ts
let jobId: string | null = existingJobId;
```

The existing lazy-create guard `if (jobId === null) { jobId = (await enqueueIngestJob(...)).jobId; }` now only fires when no `jobId` was supplied — exactly the desired behavior. The rest of the function (per-file staging, the `stagedFileIds.length > 0` enqueue block, the `roster`/`bundlesProcessed`/`submissionsQueued` result) is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test --workspace=packages/server -- local-path.e2e`
Expected: PASS — both the existing happy-path test (no `jobId`, lazy create) and the new pre-created-`jobId` test pass.

- [ ] **Step 5: Thread `jobId` through `completeResumableUpload`**

In `packages/server/src/services/ingest/resumable-upload.ts`, add the field to `CompleteResumableArgs` (after `maxBatchFiles`):

```ts
export interface CompleteResumableArgs {
  db: DrizzleDb;
  semesterId: string;
  userId: string;
  uploadId: string;
  s3UploadId: string;
  maxBundleBytes: number;
  maxBatchFiles: number;
  /** Optional pre-created ingest job to stage into (see ingestLocalPath). */
  jobId?: string;
}
```

Then forward it in the `ingestLocalPath` call inside `completeResumableUpload` (add one line to the args object):

```ts
return await ingestLocalPath(
  { db: args.db, storageClient },
  {
    semesterId: args.semesterId,
    userId: args.userId,
    archivePath: tmp.path,
    maxBundleBytes: args.maxBundleBytes,
    maxBatchFiles: args.maxBatchFiles,
    jobId: args.jobId,
  },
);
```

- [ ] **Step 6: Run the resumable service e2e to confirm no regression**

Run: `npm run test --workspace=packages/server -- resumable-upload.e2e`
Expected: PASS — that test calls `completeResumableUpload` WITHOUT `jobId`, so lazy creation still applies and its `roster {added:3}` / `bundlesProcessed:2` / `submissionsQueued:3` assertions hold.

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck --workspace=packages/server`
Expected: PASS

```bash
git add packages/server/src/services/ingest/local-path.ts \
        packages/server/src/services/ingest/resumable-upload.ts \
        packages/server/src/services/ingest/local-path.e2e.test.ts
git commit --no-gpg-sign -m "feat(server): let ingest stage into a pre-created job id"
```

---

## Task 3: `stage-upload-job` service — orchestrate background staging

**Files:**

- Create: `packages/server/src/services/ingest/stage-upload-job.ts`
- Create: `packages/server/src/services/ingest/stage-upload-job.e2e.test.ts`

**Interfaces:**

- Consumes: `completeResumableUpload` (now accepts `jobId`), `failIngestJob`, `JOB_KINDS`, `DrizzleDb`, `StorageClient`, `PgBoss`.
- Produces:
  - `interface IngestStageUploadPayload { ingestJobId: string; semesterId: string; userId: string; uploadId: string; s3UploadId: string }`
  - `interface StageUploadArgs extends IngestStageUploadPayload { maxBundleBytes: number; maxBatchFiles: number }`
  - `interface StageUploadDeps { db: DrizzleDb; storageClient: StorageClient; boss: PgBoss }`
  - `async function stageUploadIntoJob(deps: StageUploadDeps, args: StageUploadArgs): Promise<void>` — assembles + stages into `args.ingestJobId`; on `!ok` marks the job failed; when no per-file jobs were enqueued (roster-only / all skipped) enqueues `ingest_finalize` so the job settles instead of sitting `queued`.

- [ ] **Step 1: Write the service module**

Create `packages/server/src/services/ingest/stage-upload-job.ts`:

```ts
/**
 * Background staging for a completed resumable upload.
 *
 * The HTTP `/complete` route no longer assembles + downloads + stages a multi-GB
 * export inside the request (that took minutes and left the UI stuck at 100%).
 * Instead it creates the `ingest_jobs` row up front and enqueues one
 * `ingest_stage_upload` job; this module is that job's body.
 *
 * It reuses `completeResumableUpload` (which completes the S3 multipart upload,
 * downloads the assembled ZIP to a temp file, and runs the shared
 * `ingestLocalPath` staging) — passing the pre-created `ingestJobId` so the
 * per-file jobs and the `finalizeIngestJob` machinery surface progress through
 * the normal job-status endpoint the analyzer already polls.
 *
 * Failure handling: S3 multipart completion is non-idempotent (the upload id is
 * consumed on first complete), so the job is enqueued with `retryLimit: 0`. On
 * any error we mark the ingest job `failed` so the UI shows the failure rather
 * than hanging.
 */

import type PgBoss from 'pg-boss';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { completeResumableUpload } from './resumable-upload.js';
import { failIngestJob } from './job-control.js';
import { JOB_KINDS } from '../../jobs/pg-boss.js';
import { getLogger } from '../../logging.js';

/** pg-boss payload for an `ingest_stage_upload` job. */
export interface IngestStageUploadPayload {
  ingestJobId: string;
  semesterId: string;
  userId: string;
  uploadId: string;
  s3UploadId: string;
}

export interface StageUploadArgs extends IngestStageUploadPayload {
  maxBundleBytes: number;
  maxBatchFiles: number;
}

export interface StageUploadDeps {
  db: DrizzleDb;
  storageClient: StorageClient;
  boss: PgBoss;
}

/**
 * Assemble a completed resumable upload and stage its bundles into the
 * pre-created ingest job `args.ingestJobId`. Settles the job on the paths that
 * would otherwise leave it `queued` forever.
 */
export async function stageUploadIntoJob(
  deps: StageUploadDeps,
  args: StageUploadArgs,
): Promise<void> {
  const { db, storageClient, boss } = deps;
  const logger = getLogger();

  const result = await completeResumableUpload(
    { storageClient },
    {
      db,
      semesterId: args.semesterId,
      userId: args.userId,
      uploadId: args.uploadId,
      s3UploadId: args.s3UploadId,
      maxBundleBytes: args.maxBundleBytes,
      maxBatchFiles: args.maxBatchFiles,
      jobId: args.ingestJobId,
    },
  );

  if (!result.ok) {
    logger.warn(
      { ingestJobId: args.ingestJobId, error: result.error, detail: result.detail },
      'ingest_stage_upload: invalid export — marking job failed',
    );
    await failIngestJob(db, args.ingestJobId, `${result.error}: ${result.detail}`);
    return;
  }

  // When no per-file jobs were enqueued (roster-only export, or every bundle
  // skipped), nothing will ever trigger maybeEnqueueFinalize — so settle the
  // job here. finalizeIngestJob on a 0-file job yields status 'succeeded'.
  if (result.submissionsQueued === 0) {
    await boss.send(
      JOB_KINDS.INGEST_FINALIZE,
      { ingestJobId: args.ingestJobId },
      { singletonKey: args.ingestJobId, retryLimit: 5 },
    );
    logger.info(
      { ingestJobId: args.ingestJobId },
      'ingest_stage_upload: no stageable bundles — enqueued finalize',
    );
  }
}
```

- [ ] **Step 2: Write the e2e test (drives the full async path through the worker)**

Create `packages/server/src/services/ingest/stage-upload-job.e2e.test.ts`. Mirror `resumable-upload.e2e.test.ts` for all the container/config/setup boilerplate (copy its `beforeEach`/`afterEach`, the `buildExportBytes`/`layBundleIntoFolder`/`METADATA` helpers, and the user/course/semester/membership inserts verbatim). The body differs only in HOW completion runs: pre-create the job, call `stageUploadIntoJob` (the worker's body), and assert the same end state.

```ts
it('stages a completed upload into a pre-created job and reaches succeeded', async () => {
  await withTestMinio(async ({ client, bucketName }) => {
    // ... identical config + user/course/semester/membership setup as
    //     resumable-upload.e2e.test.ts ...

    workerStop = await startWorker();

    const cfg = getConfig();
    const storageClient = createStorageClient(storageConfigFromEnv(cfg));
    const exportBytes = await buildExportBytes();

    const uploadId = crypto.randomUUID();
    const chunkBytes = resolveChunkBytes(undefined);
    const { s3UploadId } = await createResumableUpload(
      { storageClient },
      { semesterId: semester!.id, uploadId, totalBytes: exportBytes.byteLength, chunkBytes },
    );
    await putResumablePart(
      { storageClient },
      { semesterId: semester!.id, uploadId, s3UploadId, partNumber: 1, body: exportBytes },
    );

    // The route's eager step: create the job row, then run the staging body.
    const { jobId } = await enqueueIngestJob(db, semester!.id, userId);
    const boss = await getBoss();
    await stageUploadIntoJob(
      { db, storageClient, boss },
      {
        ingestJobId: jobId,
        semesterId: semester!.id,
        userId,
        uploadId,
        s3UploadId,
        maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
        maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
      },
    );

    // Per-file jobs + finalize run on the worker; wait for terminal status.
    const start = Date.now();
    let finalStatus: string | null = null;
    while (Date.now() - start < 120_000) {
      const [jobRow] = await db
        .select({ status: ingest_jobs.status })
        .from(ingest_jobs)
        .where(eq(ingest_jobs.id, jobId));
      if (jobRow && jobRow.status !== 'queued' && jobRow.status !== 'running') {
        finalStatus = jobRow.status;
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(finalStatus).toBe('succeeded');

    const fileRows = await db
      .select({ status: ingest_files.status })
      .from(ingest_files)
      .where(eq(ingest_files.ingest_job_id, jobId));
    expect(fileRows).toHaveLength(3);
    expect(fileRows.every((f) => f.status === 'matched')).toBe(true);
  });
});
```

Add to the imports (copied from `resumable-upload.e2e.test.ts`) these extra names: `enqueueIngestJob` from `./job-control.js`, `getBoss` from `../../jobs/pg-boss.js`, and `stageUploadIntoJob` from `./stage-upload-job.js`. Keep `createResumableUpload`, `putResumablePart`, `resolveChunkBytes` from `./resumable-upload.js`.

- [ ] **Step 3: Run the new e2e test**

Run: `npm run test --workspace=packages/server -- stage-upload-job.e2e`
Expected: PASS — the job reaches `succeeded` with 3 matched files, proving the async staging path reaches the same end state as the sync service path. (Requires Docker for testcontainers.)

- [ ] **Step 4: Typecheck + lint + commit**

Run: `npm run typecheck --workspace=packages/server && npm run lint`
Expected: PASS

```bash
git add packages/server/src/services/ingest/stage-upload-job.ts \
        packages/server/src/services/ingest/stage-upload-job.e2e.test.ts
git commit --no-gpg-sign -m "feat(server): stage completed resumable uploads in a background job"
```

---

## Task 4: Register the `ingest_stage_upload` worker handler

**Files:**

- Modify: `packages/server/src/jobs/worker.ts:42-66` (imports), `:103-108` (queue creation), `:544-614` (register after the ingest_finalize handler)

**Interfaces:**

- Consumes: `stageUploadIntoJob`, `IngestStageUploadPayload` (from `stage-upload-job.ts`), `JOB_KINDS.INGEST_STAGE_UPLOAD`, `getConfig`, `createStorageClient`, `failIngestJob` (already imported).
- Produces: a registered pg-boss worker for `ingest_stage_upload`.

- [ ] **Step 1: Import the staging service**

In `packages/server/src/jobs/worker.ts`, add to the imports near the other ingest-service imports (after the `job-control.js` import block, ~line 49):

```ts
import {
  stageUploadIntoJob,
  type IngestStageUploadPayload,
} from '../services/ingest/stage-upload-job.js';
```

- [ ] **Step 2: Create the queue**

In the queue-creation block (after `await boss.createQueue(JOB_KINDS.INGEST_FINALIZE);`, ~line 104) add:

```ts
await boss.createQueue(JOB_KINDS.INGEST_STAGE_UPLOAD);
```

- [ ] **Step 3: Register the handler**

Immediately after the `JOB_KINDS.INGEST_FINALIZE` `boss.work(...)` registration block closes (after line 614, before the `registerRecomputeHandlers` call) add:

```ts
// -------------------------------------------------------------------------
// ingest_stage_upload handler
//
// Assembles a completed resumable (chunked) upload and stages its bundles
// into the pre-created ingest job, off the HTTP request path. Enqueued with
// retryLimit: 0 by the route (S3 multipart completion is non-idempotent), so
// on any failure we mark the job failed here rather than letting it hang.
// -------------------------------------------------------------------------
await boss.work<IngestStageUploadPayload>(
  JOB_KINDS.INGEST_STAGE_UPLOAD,
  { batchSize: 1, pollingIntervalSeconds },
  async (jobs) => {
    const job = jobs[0]!;
    const db = getDb();
    const cfg = getConfig();
    const storageClient = createStorageClient(storageConfigFromEnv(cfg));
    const stageBoss = await getBoss();

    logger.info({ ingestJobId: job.data.ingestJobId }, 'ingest_stage_upload: started');
    try {
      await stageUploadIntoJob(
        { db, storageClient, boss: stageBoss },
        {
          ...job.data,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
        },
      );
      logger.info({ ingestJobId: job.data.ingestJobId }, 'ingest_stage_upload: completed');
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      logger.error({ ingestJobId: job.data.ingestJobId, err }, 'ingest_stage_upload: failed');
      await failIngestJob(db, job.data.ingestJobId, `stage_upload error: ${cause}`).catch(() => {
        // Best-effort — do not re-throw (retryLimit is 0; nothing to retry).
      });
    }
  },
);
```

(`getBoss`, `getConfig`, `getDb`, `createStorageClient`, `storageConfigFromEnv`, `failIngestJob`, and `logger` are all already imported/in scope in `startWorker`.)

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck --workspace=packages/server`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/jobs/worker.ts
git commit --no-gpg-sign -m "feat(server): register ingest_stage_upload worker handler"
```

---

## Task 5: Rewrite the `/complete` route to enqueue staging and return immediately

**Files:**

- Modify: `packages/server/src/api/v1/routes/ingest.ts:1118-1187` (the body of the `/complete` handler after the `s3UploadId` validation), `:55-63` (imports)
- Test: `packages/server/src/api/v1/routes/ingest-gradescope.e2e.test.ts`

**Interfaces:**

- Consumes: `enqueueIngestJob`, `getBoss`, `JOB_KINDS` (already imported in the route), `IngestStageUploadPayload` (new import from `stage-upload-job.ts`).
- Produces: `POST /ingest/uploads/:uploadId/complete` returns `202 { job_id, roster:{added:0,updated:0}, bundles_processed:0, submissions_queued:0, skipped:[] }` immediately and enqueues one `ingest_stage_upload` job.

- [ ] **Step 1: Write the failing route e2e test**

Read `packages/server/src/api/v1/routes/ingest-gradescope.e2e.test.ts` fully to reuse its app/auth/container harness (it constructs the Hono app and an authenticated request helper). Add a test that drives the resumable route sequence end-to-end and asserts the async contract. Use the file's existing request helper (named `request`/`api`/similar — match the file) for authenticated calls.

```ts
it('completes a resumable upload asynchronously and reaches succeeded', async () => {
  // ... reuse the file's harness to get: an authed request helper, semesterId,
  //     the running worker, a storageClient, and exportBytes (a valid Gradescope
  //     export — reuse the helper this file already uses to build one) ...

  // create
  const createRes = await request('POST', `/semesters/${semesterId}/ingest/uploads`, {
    body: { filename: 'export.zip', total_bytes: exportBytes.byteLength },
  });
  expect(createRes.status).toBe(201);
  const { upload_id, s3_upload_id } = await createRes.json();

  // one part
  const putRes = await request(
    'PUT',
    `/semesters/${semesterId}/ingest/uploads/${upload_id}/parts/1?s3_upload_id=${encodeURIComponent(s3_upload_id)}`,
    { rawBody: Buffer.from(exportBytes) },
  );
  expect(putRes.status).toBe(200);

  // complete — must return FAST with a job id (no synchronous staging).
  const completeRes = await request(
    'POST',
    `/semesters/${semesterId}/ingest/uploads/${upload_id}/complete`,
    { body: { s3_upload_id } },
  );
  expect(completeRes.status).toBe(202);
  const completeBody = await completeRes.json();
  expect(completeBody.job_id).toEqual(expect.any(String));

  // the background stage + per-file + finalize jobs settle the job.
  const jobId = completeBody.job_id;
  const start = Date.now();
  let finalStatus: string | null = null;
  while (Date.now() - start < 120_000) {
    const statusRes = await request('GET', `/semesters/${semesterId}/ingest/jobs/${jobId}`);
    const body = await statusRes.json();
    if (['succeeded', 'partial', 'failed', 'cancelled'].includes(body.status)) {
      finalStatus = body.status;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(finalStatus).toBe('succeeded');
});
```

Adapt the helper call shapes (`rawBody`/binary PUT, JSON `body`, header/auth args) to exactly match the conventions already used in this test file — do not invent a new request helper.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test --workspace=packages/server -- ingest-gradescope.e2e`
Expected: FAIL — today's `/complete` does the staging synchronously and returns the real counts; the new assertion that the response is fast/`202` with a job that then settles via background jobs is what we're about to implement. (Depending on harness, the existing sync path may still return 202 with a job id, but the staging-via-background-jobs wiring under test does not exist yet; if the pre-change handler happens to pass, proceed — the value of this test is locking the async contract once Step 3 lands. Re-run after Step 3 and confirm it passes against the new code path.)

- [ ] **Step 3: Add the import and rewrite the handler body**

In `packages/server/src/api/v1/routes/ingest.ts`, add to the resumable-upload import block (`:55-62`) a new import line for the payload type:

```ts
import type { IngestStageUploadPayload } from '../../../services/ingest/stage-upload-job.js';
```

Then replace the handler body from the `storageClient`/`completeResumableUpload` call through the end of the two `c.json(...)` returns (current `:1119-1186`) with:

```ts
// Create the ingest job row up front so the client gets a job_id to poll
// immediately, then hand the heavy assemble→download→stage work to a
// background `ingest_stage_upload` job. This keeps the request fast: a
// multi-GB export no longer blocks /complete for minutes (which left the
// UI stuck at "Uploading… 100%").
const { jobId } = await enqueueIngestJob(db, semesterId, principal.user.id);

const boss = await getBoss();
await boss.send(
  JOB_KINDS.INGEST_STAGE_UPLOAD,
  {
    ingestJobId: jobId,
    semesterId,
    userId: principal.user.id,
    uploadId,
    s3UploadId,
  } satisfies IngestStageUploadPayload,
  // Not retryable: S3 multipart completion is non-idempotent. On failure
  // the worker marks the job failed so the UI surfaces it.
  { singletonKey: jobId, retryLimit: 0 },
);

c.set('auditDetail', { job_id: jobId });

// The roster/counts/skipped are reported via GET /ingest/jobs/:jobId as the
// background job runs; the immediate response carries placeholders so the
// wire shape (and the analyzer's GradescopeIngestResponse parse) is stable.
return c.json(
  {
    job_id: jobId,
    roster: { added: 0, updated: 0 },
    bundles_processed: 0,
    submissions_queued: 0,
    skipped: [],
  },
  202,
);
```

Delete the now-unused `storageClient` creation, the `completeResumableUpload` call, the `if (!result.ok)` block, the `skippedSummary` mapping, and the `if (result.jobId === null)` branch — they are all replaced by the above. Keep everything ABOVE it (the `s3UploadId` presence validation at `:1111-1117`).

- [ ] **Step 4: Remove the now-unused import if needed**

If `completeResumableUpload` is no longer referenced anywhere in `ingest.ts` after this change, remove it from the import block at `:55-62` (leave `createResumableUpload`, `putResumablePart`, `listResumablePartNumbers`, `abortResumableUpload`, `resolveChunkBytes`). Run `npm run lint` to confirm no unused-import error remains.

- [ ] **Step 5: Run the route e2e test to verify it passes**

Run: `npm run test --workspace=packages/server -- ingest-gradescope.e2e`
Expected: PASS — `/complete` returns `202` with a `job_id` promptly, and the polled job reaches `succeeded`.

- [ ] **Step 6: Typecheck + lint + commit**

Run: `npm run typecheck --workspace=packages/server && npm run lint`
Expected: PASS

```bash
git add packages/server/src/api/v1/routes/ingest.ts \
        packages/server/src/api/v1/routes/ingest-gradescope.e2e.test.ts
git commit --no-gpg-sign -m "feat(server): make resumable upload /complete async via ingest_stage_upload"
```

---

## Task 6: Documentation

**Files:**

- Modify: the ingest docs file last touched by commit `d92c327` ("docs: update ingest docs for streaming + resumable HTTP upload") — locate with `git show --stat d92c327`.

**Interfaces:** none (docs only).

- [ ] **Step 1: Find the doc**

Run: `git show --stat d92c327`
Identify the ingest docs file (under `docs/`).

- [ ] **Step 2: Add the async-complete note**

In the section describing the resumable upload `complete` step, add a short paragraph stating that `POST …/uploads/:uploadId/complete` now returns `202 { job_id, … }` immediately and performs assembly + staging in a background `ingest_stage_upload` job; the `roster`/`bundles_processed`/`submissions_queued`/`skipped` fields in that immediate response are placeholders, and the real outcome (roster upsert, per-file results, terminal status) is reported via `GET /semesters/:semesterId/ingest/jobs/:jobId` — the same job-status endpoint every other ingest path uses. Note that an invalid export now surfaces as a `failed` job rather than a synchronous `400`.

- [ ] **Step 3: Commit**

```bash
git add docs/
git commit --no-gpg-sign -m "docs: resumable upload /complete is now async (counts via job status)"
```

---

## Final verification

- [ ] **Run the full server suite + typecheck + lint**

Run: `npm run typecheck && npm run lint && npm run test --workspace=packages/server`
Expected: PASS (Docker must be running for the testcontainers e2e suites).

- [ ] **Manual smoke (optional, requires dev stack):** `docker compose up -d`, start `npm run dev --workspace=packages/server` and the analyzer, upload a >1 GiB Gradescope export, and confirm the UI navigates to the job view (status `queued` → `running` → terminal) instead of freezing at "Uploading… 100%".

---

## Self-Review notes

- **Spec coverage:** The user-approved approach — "Async `/complete` + job + polling" — is implemented: Task 5 makes `/complete` async + returns `job_id`; Tasks 3–4 add the background job; polling already exists in the analyzer (`useIngestJob`, 3 s `refetchInterval`), so no client task is needed.
- **No analyzer/shared/migration changes:** Response shape preserved (placeholder zeros); `ingest_jobs`/`ingest_files` reused as-is; no new status value. Confirmed the analyzer client test (`resumable-upload.test.ts`) and the service e2e (`resumable-upload.e2e.test.ts`) remain valid because the client is unchanged and the service keeps its lazy-create behavior when `jobId` is omitted.
- **Type consistency:** `IngestStageUploadPayload` is defined once in `stage-upload-job.ts` and imported by both the worker (Task 4) and the route (Task 5). `stageUploadIntoJob(deps, args)` signature matches its call sites. `IngestLocalPathArgs.jobId` / `CompleteResumableArgs.jobId` are the same optional `string`.
- **Known behavior change (intended):** a roster-only or fully-skipped resumable export now navigates to a job view (status `succeeded`, 0 submissions) instead of showing the in-place roster summary; and an invalid export surfaces as a `failed` job instead of a synchronous `400`. Both are inherent to moving validation/staging off the request path and are noted in the docs (Task 6).
