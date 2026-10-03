/**
 * Local-path ingest CLI: ingest a Gradescope export ZIP that lives on this
 * server's disk, without uploading it over HTTP.
 *
 * The HTTP `:gradescope` route buffers the whole upload in memory and trips a
 * ~2 GiB FormData ceiling, so multi-GB exports fail with "Request validation
 * failed". This command reads the archive directly from disk via a streaming
 * random-access reader (bounded memory), so it ingests arbitrarily large
 * exports (10 GB+) — instantly, since there is no upload at all.
 *
 *   npm run ingest:local --workspace=packages/server -- \
 *     --path ./export.zip --semester <semester-uuid> --user staff@berkeley.edu
 *
 * Prerequisites (same as `npm run dev`):
 *   - docker compose up -d        (Postgres + RustFS)
 *   - npm run db:migrate --workspace=packages/server
 *   - a worker running (`npm run dev` with --mode=all, or a separate worker):
 *     this command stages + enqueues the submissions; the worker processes them.
 *   - packages/server/.env present.
 *
 * The target semester must already exist and the --user must be a known user.
 * Submissions match the roster by the sids in the export metadata (the roster
 * is upserted from that metadata, so no pre-existing roster is required).
 */

import { sql, eq } from 'drizzle-orm';
import { getConfig } from '../src/config/index.js';
import { getDb, closeDb } from '../src/db/client.js';
import { users, semesters } from '../src/db/schema.js';
import { createStorageClient, storageConfigFromEnv } from '../src/services/storage/client.js';
import { stopBoss } from '../src/jobs/pg-boss.js';
import { ingestLocalPath } from '../src/services/ingest/local-path.js';

function log(msg: string): void {
  process.stdout.write(`[ingest:local] ${msg}\n`);
}

function parseArgs(argv: string[]): { path: string; semester: string; user: string } {
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (k?.startsWith('--')) a[k.slice(2)] = argv[i + 1] ?? '';
  }
  const path = a['path'];
  const semester = a['semester'];
  const user = a['user'];
  if (!path || !semester || !user) {
    throw new Error(
      'usage: ingest:local --path <export.zip> --semester <semester-id> --user <email>',
    );
  }
  return { path, semester, user };
}

async function main(): Promise<void> {
  const { path, semester, user } = parseArgs(process.argv.slice(2));
  const cfg = getConfig();
  const db = getDb();
  const storageClient = createStorageClient(storageConfigFromEnv(cfg));

  // Resolve the uploader by email (case-insensitive), matching the auth layer.
  const userRows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${user})`)
    .limit(1);
  const uploader = userRows[0];
  if (uploader === undefined) {
    throw new Error(`no user found with email '${user}'`);
  }

  // Validate the semester exists for a clean error (rather than an FK violation).
  const semRows = await db
    .select({ id: semesters.id })
    .from(semesters)
    .where(eq(semesters.id, semester))
    .limit(1);
  if (semRows[0] === undefined) {
    throw new Error(`no semester found with id '${semester}'`);
  }

  log(`ingesting ${path} into semester ${semester} as ${uploader.email}`);
  const tStart = Date.now();

  const result = await ingestLocalPath(
    { db, storageClient },
    {
      semesterId: semester,
      userId: uploader.id,
      archivePath: path,
      maxBundleBytes: cfg.INGEST_MAX_BUNDLE_BYTES,
      maxBatchFiles: cfg.INGEST_MAX_BATCH_FILES,
    },
  );

  if (!result.ok) {
    throw new Error(`ingest failed (${result.error}): ${result.detail}`);
  }

  const secs = ((Date.now() - tStart) / 1000).toFixed(1);
  log(`DONE in ${secs}s`);
  log(`  job_id:            ${result.jobId ?? '(none — roster-only)'}`);
  log(`  roster:            +${result.roster.added} added, ${result.roster.updated} updated`);
  log(`  bundles processed: ${result.bundlesProcessed}`);
  log(`  submissions queued:${result.submissionsQueued}`);
  if (result.skipped.length > 0) {
    log(`  skipped:           ${result.skipped.length}`);
    const byReason = new Map<string, number>();
    for (const s of result.skipped) byReason.set(s.reason, (byReason.get(s.reason) ?? 0) + 1);
    for (const [reason, n] of byReason) log(`    - ${reason}: ${n}`);
  }
  if (result.jobId !== null) {
    log(`a running worker will now process the queued submissions.`);
  }
}

main()
  .then(async () => {
    await stopBoss();
    await closeDb();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    process.stderr.write(
      `[ingest:local] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    await stopBoss().catch(() => {});
    await closeDb().catch(() => {});
    process.exit(1);
  });
