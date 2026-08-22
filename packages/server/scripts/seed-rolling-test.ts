/**
 * Seed the local dev database for ROLLING-SEAL testing (program spec §8).
 *
 * Companion to `~/Downloads/provenance-rolling-test/` — the git-submitted
 * assignment scope whose `.provenance-manifest` declares `submission: git`.
 * This script creates just enough structure for that repo's zip to ingest:
 * a course, a semester whose filename convention resolves the uploader, an
 * assignment declaring the repo shape, one roster row, and an API token to
 * upload with.
 *
 * Run from the repo root:
 *
 *   npm exec --workspace=packages/server -- tsx --env-file=packages/server/.env \
 *     packages/server/scripts/seed-rolling-test.ts
 *
 * Prerequisites (same as `npm run dev`):
 *   - docker compose up -d   (Postgres + MinIO)
 *   - npm run db:migrate --workspace=packages/server
 *   - packages/server/.env present
 *
 * Idempotent: every row is looked up before it is inserted, so re-running
 * changes nothing. The one exception is the API token — a token's secret only
 * exists at creation time, so `--new-token` mints a fresh one and prints it.
 *
 * Deliberately does NOT ingest anything. `scripts/seed.ts` exists for a
 * populated demo cohort; this one leaves the semester empty so the FIRST
 * submission in it is the rolling-sealed repo you are testing.
 *
 * Dev tooling, not shipped server code — hence scripts/, alongside seed.ts.
 */

import { and, eq, sql } from 'drizzle-orm';

import { getDb, closeDb } from '../src/db/client.js';
import {
  users,
  courses,
  semesters,
  memberships,
  roster_entries,
  assignments,
  submissions,
} from '../src/db/schema.js';
import { createToken } from '../src/auth/tokens.js';
import type { DrizzleDb } from '../src/db/client.js';

// ---------------------------------------------------------------------------
// What gets created. These constants are the contract with the test workspace:
// change one here and you must change the matching field in
// ~/Downloads/provenance-rolling-test/.provenance-manifest.
// ---------------------------------------------------------------------------

/** Must equal the manifest's `course_id`, which must equal the dev course cert's. */
const COURSE_SLUG = 'dev-course';
const COURSE_NAME = 'Dev Course';

/** Must equal the manifest's `semester`. */
const SEMESTER_SLUG = 'rolling-test';
const SEMESTER = {
  // `semesters_term_check` allows only 'fa' | 'sp' | 'su' | 'wi'.
  term: 'fa',
  year: 2026,
  displayName: 'Rolling-Seal Test (Fall 2026)',
  /**
   * Resolves BOTH the assignment and the student from the uploaded filename, so
   * `rolling-000000001.zip` → assignment `rolling`, sid `000000001`. The
   * assignment capture is optional in the pipeline (it falls back to the
   * manifest's `assignment_id`); the `sid` capture is not — without it every
   * upload lands unmatched.
   */
  filenameConvention: String.raw`^(?<assignment_id>[a-z0-9_-]+)-(?<sid>\d{6,12})\.zip$`,
};

/** Must equal the manifest's `assignment_id`. */
const ASSIGNMENT_ID_STR = 'rolling';

/**
 * `repo_whole`: the submission is ONE git repo, one sealed scope, at the repo
 * root — exactly the shape the test workspace has. Declaring it means a
 * wrong-shaped upload fails loudly instead of ingesting as something else.
 * Switch to `self_identifying` (the permissive default) if you start testing
 * nested multi-assignment repos.
 */
const INGEST_SCOPE = { mode: 'repo_whole', on_multiple: 'ingest_all' } as const;

/** Must match the `sid` your uploaded filename carries. */
const STUDENT = {
  sid: '000000001',
  displayName: 'Test Student',
  email: 'test-student@example.invalid',
};

/**
 * A synthetic uploader, NOT a real staff email. A real one would collide with
 * the `users` row your own Google login creates — the same trap `seed.ts`
 * documents. You never sign in as this user; it exists to own the ingest job
 * and the API token. To VIEW the result in the analyzer, sign in normally: your
 * email is already in AUTH_SUPERADMIN_EMAILS, and a superadmin sees every
 * semester without needing a membership row.
 */
const UPLOADER = {
  googleSubject: 'rolling-test-uploader-subject',
  email: 'rolling-test-uploader@example.invalid',
  displayName: 'Rolling Test Uploader',
};

function log(msg: string): void {
  process.stdout.write(`[seed:rolling] ${msg}\n`);
}

async function ensureUploader(db: DrizzleDb): Promise<string> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.google_subject, UPLOADER.googleSubject))
    .limit(1);
  if (existing[0] !== undefined) return existing[0].id;

  const [row] = await db
    .insert(users)
    .values({
      google_subject: UPLOADER.googleSubject,
      email: UPLOADER.email,
      display_name: UPLOADER.displayName,
    })
    .returning({ id: users.id });
  return row!.id;
}

async function ensureCourse(db: DrizzleDb): Promise<string> {
  const existing = await db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.slug, COURSE_SLUG))
    .limit(1);
  if (existing[0] !== undefined) return existing[0].id;

  const [row] = await db
    .insert(courses)
    .values({ name: COURSE_NAME, slug: COURSE_SLUG })
    .returning({ id: courses.id });
  return row!.id;
}

async function ensureSemester(db: DrizzleDb, courseId: string): Promise<string> {
  const existing = await db
    .select({ id: semesters.id })
    .from(semesters)
    .where(and(eq(semesters.course_id, courseId), eq(semesters.slug, SEMESTER_SLUG)))
    .limit(1);
  if (existing[0] !== undefined) return existing[0].id;

  const [row] = await db
    .insert(semesters)
    .values({
      course_id: courseId,
      term: SEMESTER.term,
      year: SEMESTER.year,
      slug: SEMESTER_SLUG,
      display_name: SEMESTER.displayName,
      filename_convention: SEMESTER.filenameConvention,
    })
    .returning({ id: semesters.id });
  return row!.id;
}

async function ensureMembership(db: DrizzleDb, userId: string, semesterId: string): Promise<void> {
  const existing = await db
    .select({ user_id: memberships.user_id })
    .from(memberships)
    .where(and(eq(memberships.user_id, userId), eq(memberships.semester_id, semesterId)))
    .limit(1);
  if (existing.length > 0) return;

  // `POST /ingest` requires semester admin (write), so 'grader' would 403.
  await db
    .insert(memberships)
    .values({ user_id: userId, semester_id: semesterId, role: 'admin', granted_by: userId });
}

async function ensureAssignment(db: DrizzleDb, semesterId: string): Promise<string> {
  const existing = await db
    .select({ id: assignments.id, ingest_scope: assignments.ingest_scope })
    .from(assignments)
    .where(
      and(
        eq(assignments.semester_id, semesterId),
        eq(assignments.assignment_id_str, ASSIGNMENT_ID_STR),
      ),
    )
    .limit(1);
  if (existing[0] !== undefined) {
    // Re-assert the scope: an earlier run (or a PATCH) may have left the
    // permissive default behind, which would silently stop testing the shape
    // assertion this seed exists to exercise.
    await db
      .update(assignments)
      .set({ ingest_scope: INGEST_SCOPE })
      .where(eq(assignments.id, existing[0].id));
    return existing[0].id;
  }

  const [row] = await db
    .insert(assignments)
    .values({
      semester_id: semesterId,
      assignment_id_str: ASSIGNMENT_ID_STR,
      label: 'Rolling Seal Test',
      ingest_scope: INGEST_SCOPE,
    })
    .returning({ id: assignments.id });
  return row!.id;
}

async function ensureRosterEntry(db: DrizzleDb, semesterId: string): Promise<string> {
  const existing = await db
    .select({ id: roster_entries.id })
    .from(roster_entries)
    .where(and(eq(roster_entries.semester_id, semesterId), eq(roster_entries.sid, STUDENT.sid)))
    .limit(1);
  if (existing[0] !== undefined) return existing[0].id;

  const [row] = await db
    .insert(roster_entries)
    .values({
      semester_id: semesterId,
      sid: STUDENT.sid,
      display_name: STUDENT.displayName,
      email: STUDENT.email,
    })
    .returning({ id: roster_entries.id });
  return row!.id;
}

async function main(): Promise<void> {
  const mintToken = process.argv.includes('--new-token');
  const db = getDb();

  const uploaderId = await ensureUploader(db);
  const courseId = await ensureCourse(db);
  const semesterId = await ensureSemester(db, courseId);
  await ensureMembership(db, uploaderId, semesterId);
  const assignmentId = await ensureAssignment(db, semesterId);
  const rosterEntryId = await ensureRosterEntry(db, semesterId);

  const [{ value: submissionCount } = { value: 0 }] = await db
    .select({ value: sql<number>`count(*)::int` })
    .from(submissions)
    .where(eq(submissions.semester_id, semesterId));

  log(`course     ${COURSE_SLUG} → ${courseId}`);
  log(`semester   ${SEMESTER_SLUG} → ${semesterId}`);
  log(`assignment ${ASSIGNMENT_ID_STR} → ${assignmentId}  (ingest_scope: ${INGEST_SCOPE.mode})`);
  log(`roster     sid=${STUDENT.sid} → ${rosterEntryId}`);
  log(`uploader   ${UPLOADER.email} → ${uploaderId} (admin on this semester)`);
  log(`filename   ${SEMESTER.filenameConvention}`);
  log(`submissions in this semester: ${submissionCount}`);

  if (mintToken) {
    const { secret } = await createToken(db, {
      userId: uploaderId,
      label: 'rolling-seal test upload',
      scopes: { read_only: false, semester_ids: [semesterId], include_blobs: false },
      expiresAt: null,
    });
    log('');
    log('API token (shown ONCE — copy it now):');
    log(`  ${secret}`);
    log('');
    log('Upload a repo zip with:');
    log(`  curl -X POST http://localhost:3000/api/v1/semesters/${semesterId}/ingest \\`);
    log(`    -H "Authorization: Bearer ${secret}" \\`);
    log(`    -F "files=@/tmp/rolling-000000001.zip"`);
  } else {
    log('');
    log('Re-run with --new-token to mint an API token for curl uploads.');
  }

  await closeDb();
  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`[seed:rolling] FAILED: ${String(err)}\n`);
  process.exit(1);
});
