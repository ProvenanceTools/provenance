/**
 * Profile the ingest pipeline end-to-end against the committed ~700-bundle
 * Gradescope export, on an isolated, repeatable `perf-test` semester.
 *
 * DEV TOOLING — not shipped server code. It drives the REAL route + worker
 * in-process (same path as `npm run seed`) but adds:
 *   - a fresh, deterministically-wiped semester so every run starts clean,
 *   - wall-clock segmentation (upload request / worker drain / cross-flags),
 *   - a per-phase profile dump (requires INGEST_PROFILE=1; auto-set below).
 *
 * Run from the server workspace (Postgres + RustFS must be up, migrations applied):
 *
 *   npm run profile:ingest --workspace=packages/server
 *
 * The per-phase numbers come from src/jobs/ingest-profile.ts, whose
 * `ingestProfileEnabled` flag is read once at module-load time. ESM evaluates
 * `import`s before any module-body statement, so INGEST_PROFILE MUST already be
 * in the environment when Node starts — the `profile:ingest` npm script sets it
 * inline. (Assigning process.env here would be too late and silently produce an
 * empty profile.)
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq, and, count, inArray } from 'drizzle-orm';

import { getConfig } from '../src/config/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import {
  users,
  sessions,
  courses,
  semesters,
  memberships,
  roster_entries,
  assignments,
  submissions,
  ingest_jobs,
  ingest_files,
  flags,
  cross_flags,
} from '../src/db/schema.js';
import { createStorageClient, storageConfigFromEnv } from '../src/services/storage/client.js';
import { ingestLocalPath } from '../src/services/ingest/local-path.js';
import { startWorker } from '../src/jobs/worker.js';
import { createV1App } from '../src/api/v1/index.js';
import { dumpProfile, getProfileSnapshot } from '../src/jobs/ingest-profile.js';
import { SEED_SEMESTER } from './seed/build-example-export.js';
import type { DrizzleDb } from '../src/db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_ZIP_PATH = path.join(__dirname, 'seed', 'example-gradescope-export.zip');

// Optional overrides for a large-fixture run: `--path <zip>` ingests an
// arbitrary export from disk via the local disk-path (bounded memory, no ~2 GiB
// HTTP/FormData ceiling) instead of the committed example export over the HTTP
// route. `--path` implies `--local`.
const CLI_ARGV = process.argv.slice(2);
function cliVal(flag: string): string | undefined {
  const i = CLI_ARGV.indexOf(flag);
  return i >= 0 ? CLI_ARGV[i + 1] : undefined;
}
const CUSTOM_ZIP_PATH = cliVal('--path');
const USE_LOCAL_PATH = CUSTOM_ZIP_PATH !== undefined || CLI_ARGV.includes('--local');
const ZIP_PATH = CUSTOM_ZIP_PATH ?? EXPORT_ZIP_PATH;

const INGEST_TIMEOUT_MS = 1_200_000; // 20 min
const CROSS_FLAGS_TIMEOUT_MS = 300_000; // 5 min

// Isolated from seed-demo so this never clobbers the demo data and is safe to
// wipe on every run.
const PERF = {
  courseName: 'CS 61A (perf)',
  courseSlug: 'perf-cs61a',
  term: 'fa' as const,
  year: 2026,
  slug: 'perf-test',
  displayName: 'Perf Test — CS 61A',
  filenameConvention: SEED_SEMESTER.filenameConvention,
};

const ADMIN_EMAIL = 'perf-admin@berkeley.edu';
const SESSION_ID = 'perf0000000000000000000000000000000000000z';

function log(msg: string): void {
  process.stdout.write(`[profile] ${msg}\n`);
}

async function ensureBucket(): Promise<void> {
  const cfg = getConfig();
  const storage = createStorageClient(storageConfigFromEnv(cfg));
  const res = await storage.aws.fetch(storage.bucketUrl, { method: 'PUT' });
  if (res.ok || res.status === 409) return;
  log(`warning: could not ensure bucket (HTTP ${res.status}); continuing`);
}

async function ensureAdmin(db: DrizzleDb): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  let userId: string;
  if (existing.length > 0) {
    userId = existing[0]!.id;
  } else {
    const [row] = await db
      .insert(users)
      .values({
        google_subject: 'perf-admin-subject',
        email: ADMIN_EMAIL,
        display_name: 'Perf Admin',
      })
      .returning({ id: users.id });
    userId = row!.id;
  }
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const sess = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, SESSION_ID))
    .limit(1);
  if (sess.length > 0) {
    await db.update(sessions).set({ expires_at: expiresAt }).where(eq(sessions.id, SESSION_ID));
  } else {
    await db.insert(sessions).values({ id: SESSION_ID, user_id: userId, expires_at: expiresAt });
  }
  return userId;
}

async function ensureSemester(db: DrizzleDb, userId: string): Promise<string> {
  let courseId: string;
  const ec = await db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.slug, PERF.courseSlug))
    .limit(1);
  if (ec.length > 0) {
    courseId = ec[0]!.id;
  } else {
    const [course] = await db
      .insert(courses)
      .values({ name: PERF.courseName, slug: PERF.courseSlug })
      .returning({ id: courses.id });
    courseId = course!.id;
  }

  const es = await db
    .select({ id: semesters.id })
    .from(semesters)
    .where(eq(semesters.slug, PERF.slug))
    .limit(1);
  let semesterId: string;
  if (es.length > 0) {
    semesterId = es[0]!.id;
  } else {
    const [sem] = await db
      .insert(semesters)
      .values({
        course_id: courseId,
        term: PERF.term,
        year: PERF.year,
        slug: PERF.slug,
        display_name: PERF.displayName,
        filename_convention: PERF.filenameConvention,
      })
      .returning({ id: semesters.id });
    semesterId = sem!.id;
  }

  const em = await db
    .select({ user_id: memberships.user_id })
    .from(memberships)
    .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)))
    .limit(1);
  if (em.length === 0) {
    await db
      .insert(memberships)
      .values({ user_id: userId, semester_id: semesterId, role: 'admin', granted_by: userId });
  }
  return semesterId;
}

/** Wipe everything scoped to the perf-test semester so each run is clean. */
async function wipeSemester(db: DrizzleDb, semesterId: string): Promise<void> {
  await db.delete(submissions).where(eq(submissions.semester_id, semesterId));
  await db.delete(cross_flags).where(eq(cross_flags.semester_id, semesterId));
  const jobRows = await db
    .select({ id: ingest_jobs.id })
    .from(ingest_jobs)
    .where(eq(ingest_jobs.semester_id, semesterId));
  const jobIds = jobRows.map((r) => r.id);
  if (jobIds.length > 0) {
    await db.delete(ingest_files).where(inArray(ingest_files.ingest_job_id, jobIds));
  }
  await db.delete(ingest_jobs).where(eq(ingest_jobs.semester_id, semesterId));
  await db.delete(roster_entries).where(eq(roster_entries.semester_id, semesterId));
  await db.delete(assignments).where(eq(assignments.semester_id, semesterId));
}

async function pollJobTerminal(db: DrizzleDb, jobId: string, timeoutMs: number): Promise<string> {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeoutMs) {
    const [job] = await db
      .select({ status: ingest_jobs.status })
      .from(ingest_jobs)
      .where(eq(ingest_jobs.id, jobId))
      .limit(1);
    const status = job?.status ?? 'unknown';
    if (status !== 'queued' && status !== 'running') return status;
    if (Date.now() - lastLog > 5000) {
      const [{ value: total } = { value: 0 }] = await db
        .select({ value: count() })
        .from(ingest_files)
        .where(eq(ingest_files.ingest_job_id, jobId));
      const [{ value: done } = { value: 0 }] = await db
        .select({ value: count() })
        .from(ingest_files)
        .where(and(eq(ingest_files.ingest_job_id, jobId), eq(ingest_files.status, 'matched')));
      const elapsed = (Date.now() - start) / 1000;
      const rate = done > 0 ? (done / elapsed).toFixed(1) : '0';
      log(`  …${done}/${total} matched (${elapsed.toFixed(0)}s, ${rate}/s)`);
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 'timeout';
}

async function waitForCrossFlags(
  db: DrizzleDb,
  semesterId: string,
  timeoutMs: number,
): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [{ value } = { value: 0 }] = await db
      .select({ value: count() })
      .from(cross_flags)
      .where(eq(cross_flags.semester_id, semesterId));
    if (value > 0) return value;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 0;
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms.toFixed(0)}ms`;
}

async function main(): Promise<void> {
  const cfg = getConfig();
  const db = getDb();

  if (!existsSync(ZIP_PATH)) {
    throw new Error(
      USE_LOCAL_PATH
        ? `export ZIP missing at ${ZIP_PATH}`
        : `export ZIP missing at ${ZIP_PATH} — run \`npm run seed -- --regenerate\` first.`,
    );
  }

  await ensureBucket();
  const adminId = await ensureAdmin(db);
  const semesterId = await ensureSemester(db, adminId);
  log(`semester ${PERF.slug} → ${semesterId}; wiping prior data…`);
  await wipeSemester(db, semesterId);

  log(
    `mode: ${USE_LOCAL_PATH ? 'local disk-path' : 'HTTP :gradescope route'}; INGEST_CONCURRENCY=${cfg.INGEST_CONCURRENCY}, DATABASE_POOL_MAX=${cfg.DATABASE_POOL_MAX}`,
  );
  log('starting in-process worker…');
  const stopWorker = await startWorker();

  const wall = { upload: 0, drain: 0, crossFlags: 0 };
  let finalStatus = 'unknown';
  let crossFlagCount = 0;

  try {
    let jobId: string;

    if (USE_LOCAL_PATH) {
      // Disk-path ingest: streams the (possibly multi-GB) export from disk and
      // stages + enqueues per bundle while the worker drains concurrently. The
      // "upload" segment here is the stage+enqueue pass; the worker is already
      // processing during it, so `drain` below is just the tail after staging.
      const storageClient = createStorageClient(storageConfigFromEnv(cfg));
      log(`staging from disk: ${ZIP_PATH} (interleaved stage+enqueue) …`);
      const tUpload = Date.now();
      const res = await ingestLocalPath(
        { db, storageClient },
        {
          semesterId,
          userId: adminId,
          archivePath: ZIP_PATH,
          maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
          maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
        },
      );
      wall.upload = Date.now() - tUpload;
      if (!res.ok) {
        throw new Error(`local ingest failed (${res.error}): ${res.detail}`);
      }
      if (res.jobId === null) {
        throw new Error('local ingest staged no bundles (roster-only export?)');
      }
      jobId = res.jobId;
      log(
        `staged in ${fmt(wall.upload)}: ${res.bundlesProcessed} bundles, ` +
          `${res.submissionsQueued} submissions queued, ` +
          `roster +${res.roster.added}/${res.roster.updated}` +
          (res.skipped.length > 0 ? `, ${res.skipped.length} skipped` : ''),
      );
    } else {
      const exportBytes = new Uint8Array(readFileSync(ZIP_PATH));
      log(`loaded export (${(exportBytes.byteLength / 1024 / 1024).toFixed(1)} MB)`);
      const app = createV1App();
      const formData = new FormData();
      formData.append(
        'archive',
        new Blob([exportBytes.buffer as ArrayBuffer], { type: 'application/zip' }),
        'assignment_seed_export.zip',
      );

      log('POST /ingest:gradescope (this blocks while all bundles are staged) …');
      const tUpload = Date.now();
      const res = await app.fetch(
        new Request(`http://localhost/semesters/${semesterId}/ingest:gradescope`, {
          method: 'POST',
          headers: { Cookie: `${cfg.SESSION_COOKIE_NAME}=${SESSION_ID}` },
          body: formData,
        }),
      );
      wall.upload = Date.now() - tUpload;

      if (res.status !== 202) {
        throw new Error(`ingest returned HTTP ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as {
        job_id: string;
        submissions_queued: number;
        bundles_processed: number;
      };
      log(
        `accepted in ${fmt(wall.upload)}: ${body.bundles_processed} bundles, ` +
          `${body.submissions_queued} submissions queued`,
      );
      jobId = body.job_id;
    }

    const tDrain = Date.now();
    finalStatus = await pollJobTerminal(db, jobId, INGEST_TIMEOUT_MS);
    wall.drain = Date.now() - tDrain;
    log(`ingest ${finalStatus} — worker drain ${fmt(wall.drain)}`);

    if (finalStatus === 'succeeded' || finalStatus === 'partial') {
      const tCross = Date.now();
      crossFlagCount = await waitForCrossFlags(db, semesterId, CROSS_FLAGS_TIMEOUT_MS);
      wall.crossFlags = Date.now() - tCross;
    }
  } finally {
    await Promise.race([stopWorker(), new Promise((r) => setTimeout(r, 5_000))]);
  }

  // Counts for context.
  const [{ value: submissionCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(submissions)
    .where(eq(submissions.semester_id, semesterId));
  const [{ value: flagCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(flags)
    .innerJoin(submissions, eq(submissions.id, flags.submission_id))
    .where(eq(submissions.semester_id, semesterId));

  await closeDb();

  // Wall-clock segmentation.
  const totalWall = wall.upload + wall.drain + wall.crossFlags;
  log('');
  log('════════════════ WALL-CLOCK ════════════════');
  const stageLabel = USE_LOCAL_PATH
    ? 'stage+enqueue (interleaved w/ drain)'
    : 'upload request (parse+stage+enqueue)';
  log(`${stageLabel.padEnd(36)} : ${fmt(wall.upload).padStart(8)}  ${pct(wall.upload, totalWall)}`);
  log(
    `worker drain tail (after staging)    : ${fmt(wall.drain).padStart(8)}  ${pct(wall.drain, totalWall)}`,
  );
  log(
    `cross-flags recompute (whole cohort) : ${fmt(wall.crossFlags).padStart(8)}  ${pct(wall.crossFlags, totalWall)}`,
  );
  log(`TOTAL (end-to-end)                   : ${fmt(totalWall).padStart(8)}`);
  if (totalWall > 0 && submissionCount > 0) {
    log('');
    const procWall = wall.upload + wall.drain; // staging+drain overlap → true processing window
    log(
      `throughput: ${submissionCount} submissions / ${(procWall / 1000).toFixed(1)}s ` +
        `= ${(submissionCount / (procWall / 1000)).toFixed(1)} bundles/s ` +
        `(${(procWall / submissionCount).toFixed(1)}ms/bundle wall, INGEST_CONCURRENCY=${cfg.INGEST_CONCURRENCY})`,
    );
  }
  log('');

  // Per-phase profile (from the instrumentation).
  dumpProfile(log);
  if (getProfileSnapshot().length === 0) {
    log('(no per-phase data — was INGEST_PROFILE unset?)');
  }
  log('');
  log(
    `result: ${finalStatus}; ${submissionCount} submissions, ${flagCount} flags, ${crossFlagCount} cross-flags.`,
  );

  process.exit(finalStatus === 'succeeded' || finalStatus === 'partial' ? 0 : 1);
}

function pct(part: number, total: number): string {
  return total > 0 ? `${((part / total) * 100).toFixed(0)}%` : '—';
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[profile] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
