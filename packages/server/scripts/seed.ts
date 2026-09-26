/**
 * Seed a local dev database with a large example cohort by running a generated
 * Gradescope export through the REAL ingest pipeline.
 *
 * Run from the server workspace:
 *
 *   npm run seed --workspace=packages/server                 # ingest the committed export
 *   npm run seed --workspace=packages/server -- --regenerate # rebuild the export ZIP + reseed
 *
 * Prerequisites (same as `npm run dev`):
 *   - docker compose up -d   (Postgres + RustSF)
 *   - npm run db:migrate --workspace=packages/server
 *   - packages/server/.env present (copy of .env.example; OAuth creds may be dummy)
 *
 * What it does, end to end:
 *   1. ensures the RustSF bucket exists,
 *   2. seeds an admin user + course + semester + membership (idempotent),
 *   3. builds (or reuses) the committed example Gradescope export ZIP
 *      (~700 students across three assignments, with a spread of pastes),
 *   4. starts the pg-boss worker in-process,
 *   5. POSTs the export to /semesters/:id/ingest:gradescope (the real route),
 *   6. waits for ingest + cross-flag recompute to finish (this can take a few
 *      minutes — the worker processes bundles one at a time),
 *   7. prints a summary including flag + cross-flag counts.
 *
 * Re-running is safe and idempotent: once the seed semester is populated the
 * script short-circuits. Pass --regenerate to rebuild the export and reseed from
 * scratch — that first wipes the seed semester's own data (scoped strictly to
 * `seed-demo`) so the result is deterministic rather than stacking versions.
 *
 * This is dev tooling, not shipped server code, so it lives under scripts/ and
 * drives the server's own modules directly.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq, and, ne, count, inArray } from 'drizzle-orm';

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
import { startWorker } from '../src/jobs/worker.js';
import { createV1App } from '../src/api/v1/index.js';
import { buildSeedExport, SEED_SEMESTER, SEED_ASSIGNMENTS } from './seed/build-example-export.js';
import type { DrizzleDb } from '../src/db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORT_ZIP_PATH = path.join(__dirname, 'seed', 'example-gradescope-export.zip');

// Generous: ~700 bundles are processed one at a time by a single worker.
const INGEST_TIMEOUT_MS = 1_200_000; // 20 min
const CROSS_FLAGS_TIMEOUT_MS = 180_000; // 3 min after ingest

// A clearly-synthetic admin used only to author the ingest job. NOT a real
// person's email — using a real staff email here would collide with the user
// row their Google login creates. To VIEW the seeded data in the analyzer, add
// your own email to AUTH_SUPERADMIN_EMAILS in .env instead (see the README).
const SEED_ADMIN_EMAIL = 'seed-admin@berkeley.edu';
// Stable 43-char session id so re-runs reuse the same row.
const SEED_SESSION_ID = 'seed00000000000000000000000000000000000000z';

function log(msg: string): void {
  process.stdout.write(`[seed] ${msg}\n`);
}

/** Best-effort CreateBucket so a fresh RustSF doesn't 404 the staged uploads. */
async function ensureBucket(): Promise<void> {
  const cfg = getConfig();
  const storage = createStorageClient(storageConfigFromEnv(cfg));
  const res = await storage.aws.fetch(storage.bucketUrl, { method: 'PUT' });
  // 200 = created; 409 BucketAlreadyOwnedByYou / BucketAlreadyExists = fine.
  if (res.ok || res.status === 409) {
    log(`bucket "${cfg.OBJECT_STORAGE_BUCKET}" ready`);
    return;
  }
  log(`warning: could not ensure bucket (HTTP ${res.status}); continuing`);
}

async function ensureAdminUser(db: DrizzleDb): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, SEED_ADMIN_EMAIL))
    .limit(1);
  if (existing.length > 0) return existing[0]!.id;

  const [row] = await db
    .insert(users)
    .values({
      google_subject: 'seed-admin-subject',
      email: SEED_ADMIN_EMAIL,
      display_name: 'Seed Admin',
    })
    .returning({ id: users.id });
  return row!.id;
}

async function ensureSession(db: DrizzleDb, userId: string): Promise<void> {
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const existing = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, SEED_SESSION_ID))
    .limit(1);
  if (existing.length > 0) {
    await db
      .update(sessions)
      .set({ expires_at: expiresAt })
      .where(eq(sessions.id, SEED_SESSION_ID));
    return;
  }
  await db.insert(sessions).values({ id: SEED_SESSION_ID, user_id: userId, expires_at: expiresAt });
}

async function ensureSemester(db: DrizzleDb): Promise<string> {
  const existing = await db
    .select({ id: semesters.id })
    .from(semesters)
    .where(eq(semesters.slug, SEED_SEMESTER.slug))
    .limit(1);
  if (existing.length > 0) return existing[0]!.id;

  let courseId: string;
  const existingCourse = await db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.slug, SEED_SEMESTER.courseSlug))
    .limit(1);
  if (existingCourse.length > 0) {
    courseId = existingCourse[0]!.id;
  } else {
    const [course] = await db
      .insert(courses)
      .values({ name: SEED_SEMESTER.courseName, slug: SEED_SEMESTER.courseSlug })
      .returning({ id: courses.id });
    courseId = course!.id;
  }

  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: courseId,
      term: SEED_SEMESTER.term,
      year: SEED_SEMESTER.year,
      slug: SEED_SEMESTER.slug,
      display_name: SEED_SEMESTER.displayName,
      filename_convention: SEED_SEMESTER.filenameConvention,
    })
    .returning({ id: semesters.id });
  return semester!.id;
}

async function ensureMembership(db: DrizzleDb, userId: string, semesterId: string): Promise<void> {
  const existing = await db
    .select({ user_id: memberships.user_id })
    .from(memberships)
    .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)))
    .limit(1);
  if (existing.length > 0) return;
  await db
    .insert(memberships)
    .values({ user_id: userId, semester_id: semesterId, role: 'admin', granted_by: userId });
}

/**
 * Wipe the seed semester's ingested data so --regenerate produces a clean,
 * deterministic state instead of stacking new submission versions. Scoped
 * strictly to the seed-demo semester — never touches any other semester.
 */
async function resetSeedData(db: DrizzleDb, semesterId: string): Promise<void> {
  // submissions: cascades events / per_file_stats / validation_results / flags /
  // cross_flag_participants.
  await db.delete(submissions).where(eq(submissions.semester_id, semesterId));
  // cross_flags: cascades remaining cross_flag_participants.
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

function loadOrBuildExport(regenerate: boolean): Promise<Uint8Array> {
  if (!regenerate && existsSync(EXPORT_ZIP_PATH)) {
    log(`using committed export ${path.relative(process.cwd(), EXPORT_ZIP_PATH)}`);
    return Promise.resolve(new Uint8Array(readFileSync(EXPORT_ZIP_PATH)));
  }
  log(
    regenerate
      ? 'regenerating export ZIP (this builds ~700 bundles)…'
      : 'export ZIP missing — generating…',
  );
  return buildSeedExport().then(({ bytes, stats }) => {
    writeFileSync(EXPORT_ZIP_PATH, bytes);
    log(
      `wrote ${path.relative(process.cwd(), EXPORT_ZIP_PATH)} ` +
        `(${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; ${stats.roster} students, ` +
        `${stats.bundles} bundles, ${stats.pasteBundles} with pastes, ${stats.skipped} skipped)`,
    );
    return bytes;
  });
}

/** Poll an ingest job to a terminal status, logging processed-file progress. */
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
        .where(and(eq(ingest_files.ingest_job_id, jobId), ne(ingest_files.status, 'pending')));
      log(`  …processed ${done}/${total} files`);
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return 'timeout';
}

/** Wait for the post-ingest cross-flag recompute to populate the table (best-effort). */
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

async function countFlagsForSemester(db: DrizzleDb, semesterId: string): Promise<number> {
  const [{ value } = { value: 0 }] = await db
    .select({ value: count() })
    .from(flags)
    .innerJoin(submissions, eq(submissions.id, flags.submission_id))
    .where(eq(submissions.semester_id, semesterId));
  return value;
}

async function main(): Promise<void> {
  const regenerate = process.argv.slice(2).includes('--regenerate');

  // Touch config early so a bad/missing .env fails loudly before any work.
  const cfg = getConfig();
  const db = getDb();

  await ensureBucket();

  log('seeding admin + course + semester…');
  const adminId = await ensureAdminUser(db);
  await ensureSession(db, adminId);
  const semesterId = await ensureSemester(db);
  await ensureMembership(db, adminId, semesterId);
  log(`semester ${SEED_SEMESTER.slug} → ${semesterId}`);

  const [{ value: existingSubs } = { value: 0 }] = await db
    .select({ value: count() })
    .from(submissions)
    .where(eq(submissions.semester_id, semesterId));

  if (existingSubs > 0 && !regenerate) {
    log(`already populated (${existingSubs} submission(s)) — nothing to do.`);
    log('Re-run with --regenerate to rebuild the export and reseed from scratch.');
    await closeDb();
    process.exit(0);
  }

  if (existingSubs > 0 && regenerate) {
    log(`--regenerate: wiping existing seed-demo data (${existingSubs} submissions)…`);
    await resetSeedData(db, semesterId);
  }

  const exportBytes = await loadOrBuildExport(regenerate);

  log('starting worker…');
  const stopWorker = await startWorker();

  let finalStatus = 'unknown';
  let crossFlagCount = 0;
  try {
    const app = createV1App();
    const formData = new FormData();
    formData.append(
      'archive',
      new Blob([exportBytes.buffer as ArrayBuffer], { type: 'application/zip' }),
      'assignment_seed_export.zip',
    );

    log('POST /ingest:gradescope …');
    const res = await app.fetch(
      new Request(`http://localhost/semesters/${semesterId}/ingest:gradescope`, {
        method: 'POST',
        headers: { Cookie: `${cfg.SESSION_COOKIE_NAME}=${SEED_SESSION_ID}` },
        body: formData,
      }),
    );

    if (res.status !== 202) {
      throw new Error(`ingest returned HTTP ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      job_id: string;
      roster: { added: number; updated: number };
      bundles_processed: number;
      submissions_queued: number;
      skipped: Array<{ folder_key: string; reason: string }>;
    };
    log(
      `accepted: roster +${body.roster.added}/~${body.roster.updated}, ` +
        `${body.bundles_processed} bundles, ${body.submissions_queued} submissions queued, ` +
        `${body.skipped.length} skipped`,
    );

    log('waiting for ingest to finish (a few minutes for ~700 bundles)…');
    finalStatus = await pollJobTerminal(db, body.job_id, INGEST_TIMEOUT_MS);

    if (finalStatus === 'succeeded' || finalStatus === 'partial') {
      log('ingest done — waiting for cross-flag recompute…');
      crossFlagCount = await waitForCrossFlags(db, semesterId, CROSS_FLAGS_TIMEOUT_MS);
    }
  } finally {
    // Best-effort worker drain. pg-boss's graceful stop can take tens of
    // seconds; this is a one-shot script, so cap the wait and let the final
    // process.exit() reclaim the rest.
    await Promise.race([stopWorker(), new Promise((r) => setTimeout(r, 5_000))]);
  }

  // Summary counts straight from the DB.
  const [{ value: rosterCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(roster_entries)
    .where(eq(roster_entries.semester_id, semesterId));
  const [{ value: assignmentCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(assignments)
    .where(eq(assignments.semester_id, semesterId));
  const [{ value: submissionCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(submissions)
    .where(eq(submissions.semester_id, semesterId));
  const flagCount = await countFlagsForSemester(db, semesterId);

  await closeDb();

  log('');
  log(`ingest finished: ${finalStatus}`);
  log(
    `semester "${SEED_SEMESTER.displayName}" (${SEED_SEMESTER.slug}): ` +
      `${rosterCount} roster, ${assignmentCount} assignments (${SEED_ASSIGNMENTS.join(', ')}), ` +
      `${submissionCount} submissions, ${flagCount} flags, ${crossFlagCount} cross-flags.`,
  );
  log('');
  log('To view this in the analyzer, add your Google email to AUTH_SUPERADMIN_EMAILS');
  log('in packages/server/.env, restart the server, and sign in.');

  // Force exit: pg-boss / postgres may keep the event loop alive even after
  // teardown, which would otherwise hang the script.
  process.exit(finalStatus === 'succeeded' ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[seed] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
