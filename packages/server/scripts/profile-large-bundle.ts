/**
 * Profile the ingest pipeline for ONE very large bundle — what a student's log
 * looks like after ~4 hours of real work, instead of the tiny (~20-event) seed
 * sessions. Answers: does per-bundle cost scale with event count, and if so,
 * which phase dominates?
 *
 * DEV TOOLING — not shipped server code. Generates a single faithful bundle with
 * the SAME @provenance/log-core core the recorder seal uses (real ed25519
 * session key, hash-chained slog, signed checkpoints every 100 entries, signed
 * manifest, exact doc.save reconstruction), wraps it in a one-submission
 * Gradescope export, and runs it through the real route + worker in-process.
 *
 *   npm run profile:large --workspace=packages/server            # default 50k events
 *   npm run profile:large --workspace=packages/server -- 100000  # custom event count
 *
 * Requires INGEST_PROFILE=1 in the environment (the npm script sets it) so the
 * per-phase table prints. For a single bundle that table IS the per-phase split.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { eq, and, count, inArray } from 'drizzle-orm';
import JSZip from 'jszip';
import {
  chainEntry,
  serializeEntry,
  sha256Hex,
  canonicalize,
  GENESIS_PREV_HASH,
  generateSessionKeypair,
  encryptSessionPrivkey,
  signCheckpoint,
  signBundleManifest,
  signManifest,
} from '@provenance/log-core';
import type { BundleManifest, SlogMeta, Checkpoint, Envelope, Range } from '@provenance/log-core';

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
import { dumpProfile } from '../src/jobs/ingest-profile.js';
import type { DrizzleDb } from '../src/db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ASSIGNMENT = 'hw10';
const SEMESTER_STR = 'fa2026';
const EXTENSION_HASH = 'eb452af1aca3234fcdd23708e491d18b37ae26e2c46df893f787cf2fd9a13932';
const RECORDER_VERSION = '0.2.0';
const VSCODE_VERSION = '1.94.2';
const CHECKPOINT_INTERVAL = 100;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

const PERF = {
  courseName: 'CS 61A (large)',
  courseSlug: 'large-cs61a',
  slug: 'large-bundle-test',
  displayName: 'Large Bundle Test',
  filenameConvention: '^(?<assignment_id>[a-z0-9_-]+)[-_](?<sid>\\d{6,12})\\.zip$',
};
const ADMIN_EMAIL = 'large-admin@berkeley.edu';
const SESSION_ID = 'large000000000000000000000000000000000000z';
const STUDENT = { name: 'Heavy Worker', sid: '900001', email: 'heavy.worker@berkeley.edu' };

function log(msg: string): void {
  process.stdout.write(`[large] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Faithful large-bundle generation (mirrors build-example-export's crypto core,
// but with a 4-hour event stream instead of a ~20-event one).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function endRange(content: string): Range {
  const lines = content.split('\n');
  const last = lines.length - 1;
  const pos = { line: last, character: lines[last]!.length };
  return { start: pos, end: { ...pos } };
}

type EventSpec = { kind: string; data: Record<string, unknown> };

/**
 * Realistic kind mix for an actively-edited session. doc.change + selection.change
 * dominate (that's the real recorder firehose); heartbeats/focus/terminal/git are
 * the slow background. All doc.change deltas are appends at the current end so the
 * single final doc.save reconstructs exactly (analyzer Check 7/8).
 */
const MIX: ReadonlyArray<{ kind: string; w: number }> = [
  { kind: 'doc.change', w: 40 },
  { kind: 'selection.change', w: 38 },
  { kind: 'session.heartbeat', w: 8 },
  { kind: 'focus.change', w: 7 },
  { kind: 'git.event', w: 3 },
  { kind: 'terminal.open', w: 2 },
  { kind: 'doc.close', w: 2 },
];
const MIX_W = MIX.reduce((n, k) => n + k.w, 0);

function buildLargeBundleFiles(
  eventCount: number,
  courseSig: string,
): Promise<Record<string, string>> {
  return (async () => {
    const rng = mulberry32(0xc0ffee);
    const keypair = await generateSessionKeypair();
    const sessionId = '0e33e8dd-584e-4f24-8262-b948264f0001';
    // The uuid in the `.slog` FILENAME — deliberately a DIFFERENT value from the
    // logical `session_id` above, as production mints them (`session-${randomUUID()}
    // .slog` in the writer vs `recorderContext.session_id`). A fixture that spells
    // both the same cannot distinguish code that confuses the two id spaces from
    // code that handles them correctly, which is the property that hid a
    // maximum-severity false accusation from the entire suite. See
    // `analysis-core`'s `fakeLogFileUuid`.
    const logFileUuid = '7c2b41a6-9d05-4e18-9f33-f11e00000001';
    const machineId = sha256Hex(`large-machine:${STUDENT.sid}`);
    const path0 = `${ASSIGNMENT}.py`;

    let content = `# ${ASSIGNMENT} — CS 61A\nfrom operator import add, mul\n\n\ndef solve(data):\n    pass\n`;
    let typed = 0;

    const startData = {
      format_version: '1.0',
      session_id: sessionId,
      prev_session_id: null,
      assignment: { id: ASSIGNMENT, semester: SEMESTER_STR },
      manifest_sig: courseSig,
      machine_id: machineId,
      vscode: { version: VSCODE_VERSION, commit: '', platform: 'darwin' },
      recorder: { version: RECORDER_VERSION, extension_id: 'provenance.recorder' },
      session_pubkey: keypair.publicKeyHex,
    };

    // Spread events across ~4 hours of wall time.
    const baseMs = Date.parse('2026-06-10T15:00:00.000Z');
    const avgGap = Math.max(1, Math.floor(FOUR_HOURS_MS / eventCount));
    let prevHash = GENESIS_PREV_HASH;
    let t = 0;
    let entryCount = 0;
    const lines: string[] = [];
    const checkpoints: Checkpoint[] = [];

    const append = async (
      seq: number,
      kind: string,
      data: Record<string, unknown>,
    ): Promise<void> => {
      const envelope = {
        seq,
        t,
        wall: new Date(baseMs + t).toISOString(),
        kind,
        data,
      } as unknown as Envelope;
      const entry = chainEntry(prevHash, envelope);
      lines.push(serializeEntry(entry).trimEnd());
      prevHash = entry.hash;
      entryCount++;
      if (entryCount % CHECKPOINT_INTERVAL === 0) {
        checkpoints.push(await signCheckpoint(entry.seq, entry.hash, keypair.privateKey));
      }
    };

    const cosmetic = (kind: string): EventSpec => {
      switch (kind) {
        case 'selection.change':
          return {
            kind,
            data: { path: path0, range: endRange(content), was_selection: rng() < 0.4 },
          };
        case 'session.heartbeat':
          return { kind, data: { focused: true, active_file: path0, idle_since_ms: 0 } };
        case 'focus.change':
          return { kind, data: { gained: rng() < 0.5 } };
        case 'git.event':
          return { kind, data: { operation: rng() < 0.5 ? 'status' : 'diff' } };
        case 'doc.close':
          return { kind, data: { path: path0 } };
        default:
          return {
            kind: 'terminal.open',
            data: { terminal_id: 't1', shell: 'bash', shell_integration: true },
          };
      }
    };

    // seq 0: session.start
    await append(0, 'session.start', startData);

    // doc.open (inline content anchors reconstruction)
    let seq = 1;
    t += avgGap;
    const openT = t;
    await append(seq++, 'doc.open', {
      path: path0,
      sha256: sha256Hex(content),
      line_count: content.split('\n').length,
      content,
      truncated: false,
    });

    // The bulk: eventCount mixed events. A couple of realistic pastes mid-session.
    const pasteAt1 = Math.floor(eventCount * 0.3);
    const pasteAt2 = Math.floor(eventCount * 0.7);
    for (let i = 0; i < eventCount; i++) {
      t += 1 + Math.floor(rng() * avgGap * 2);

      if (i === pasteAt1 || i === pasteAt2) {
        const blob =
          `# pasted helper block ${i}\n` +
          Array.from(
            { length: 20 },
            (_, j) => `    val_${i}_${j} = lookup(${j}) + offset(${i})`,
          ).join('\n') +
          '\n';
        const range = endRange(content);
        content += blob;
        await append(seq++, 'paste', {
          path: path0,
          range,
          length: blob.length,
          sha256: sha256Hex(blob),
          content: blob,
        });
        continue;
      }

      let r = rng() * MIX_W;
      let kind = MIX[MIX.length - 1]!.kind;
      for (const k of MIX) {
        if (r < k.w) {
          kind = k.kind;
          break;
        }
        r -= k.w;
      }
      if (kind === 'doc.change') {
        const range = endRange(content);
        const line = `    step_${typed} = transform(data[${typed % 50}], ${typed})\n`;
        content += line;
        typed++;
        await append(seq++, 'doc.change', {
          path: path0,
          deltas: [{ range, text: line }],
          source: 'typed',
        });
      } else {
        const ev = cosmetic(kind);
        await append(seq++, ev.kind, ev.data);
      }
    }

    // Single final doc.save, forced > 35s after open so time_to_first_save never fires.
    t = Math.max(t, openT + 35_000);
    await append(seq++, 'doc.save', { path: path0, sha256: sha256Hex(content) });

    const slogText = lines.join('\n') + '\n';
    const encryptedPrivkey = await encryptSessionPrivkey(keypair.privateKey, courseSig, sessionId);
    const meta: SlogMeta = {
      format_version: '1.0',
      session_id: sessionId,
      session_pubkey: keypair.publicKeyHex,
      encrypted_session_privkey: encryptedPrivkey,
      checkpoints,
    };
    const metaJson = canonicalize(meta);

    const manifest: BundleManifest = {
      format_version: '1.1',
      assignment_id: ASSIGNMENT,
      semester: SEMESTER_STR,
      extension_hash: EXTENSION_HASH,
      sessions: [
        {
          session_id: sessionId,
          prev_session_id: null,
          slog_sha256: sha256Hex(slogText),
          meta_sha256: sha256Hex(metaJson),
        },
      ],
      submission_files: [{ path: path0, status: 'present', sha256: sha256Hex(content) }],
    };
    const signed = await signBundleManifest(manifest, keypair.privateKey);

    log(
      `generated bundle: ${seq} entries, slog ${(slogText.length / 1024 / 1024).toFixed(1)} MB, ` +
        `file ${(content.length / 1024).toFixed(0)} KB, ${checkpoints.length} checkpoints`,
    );

    return {
      'manifest.json': signed.canonicalJson,
      'manifest.sig': signed.signatureHex,
      // Filenames take the FILE uuid; the manifest above takes the LOGICAL id.
      [`session-${logFileUuid}.slog`]: slogText,
      [`session-${logFileUuid}.slog.meta`]: metaJson,
      [path0]: content,
    };
  })();
}

async function buildExportZip(eventCount: number): Promise<Uint8Array> {
  const courseKeypair = await generateSessionKeypair();
  const courseSig = await signManifest(
    {
      assignment_id: ASSIGNMENT,
      semester: SEMESTER_STR,
      issued_at: '2026-01-01T00:00:00.000Z',
      files_under_review: [`${ASSIGNMENT}.py`],
    },
    courseKeypair.privateKey,
  );

  const files = await buildLargeBundleFiles(eventCount, courseSig);

  const root = 'large_export/';
  const folder = 'submission_heavy';
  const zip = new JSZip();
  zip.file(
    `${root}submission_metadata.yml`,
    `${folder}:\n  :submitters:\n  - :name: ${STUDENT.name}\n    :sid: '${STUDENT.sid}'\n    :email: ${STUDENT.email}\n`,
  );
  for (const [name, contents] of Object.entries(files)) {
    zip.file(`${root}${folder}/${name}`, contents);
  }
  const buf = await zip.generateAsync({ type: 'arraybuffer' });
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------
// Semester setup (isolated + wiped each run) and ingest harness.
// ---------------------------------------------------------------------------

async function ensureBucket(): Promise<void> {
  const cfg = getConfig();
  const storage = createStorageClient(storageConfigFromEnv(cfg));
  const res = await storage.aws.fetch(storage.bucketUrl, { method: 'PUT' });
  if (!res.ok && res.status !== 409) log(`warning: bucket ensure HTTP ${res.status}`);
}

async function setup(db: DrizzleDb): Promise<string> {
  const eu = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, ADMIN_EMAIL))
    .limit(1);
  let userId: string;
  if (eu.length > 0) userId = eu[0]!.id;
  else {
    const [row] = await db
      .insert(users)
      .values({
        google_subject: 'large-admin-subject',
        email: ADMIN_EMAIL,
        display_name: 'Large Admin',
      })
      .returning({ id: users.id });
    userId = row!.id;
  }
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const es = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(eq(sessions.id, SESSION_ID))
    .limit(1);
  if (es.length > 0)
    await db.update(sessions).set({ expires_at: expiresAt }).where(eq(sessions.id, SESSION_ID));
  else await db.insert(sessions).values({ id: SESSION_ID, user_id: userId, expires_at: expiresAt });

  let courseId: string;
  const ec = await db
    .select({ id: courses.id })
    .from(courses)
    .where(eq(courses.slug, PERF.courseSlug))
    .limit(1);
  if (ec.length > 0) courseId = ec[0]!.id;
  else {
    const [c] = await db
      .insert(courses)
      .values({ name: PERF.courseName, slug: PERF.courseSlug })
      .returning({ id: courses.id });
    courseId = c!.id;
  }

  let semesterId: string;
  const esem = await db
    .select({ id: semesters.id })
    .from(semesters)
    .where(eq(semesters.slug, PERF.slug))
    .limit(1);
  if (esem.length > 0) semesterId = esem[0]!.id;
  else {
    const [s] = await db
      .insert(semesters)
      .values({
        course_id: courseId,
        term: 'fa',
        year: 2026,
        slug: PERF.slug,
        display_name: PERF.displayName,
        filename_convention: PERF.filenameConvention,
      })
      .returning({ id: semesters.id });
    semesterId = s!.id;
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

  // Wipe prior data scoped to this semester.
  await db.delete(submissions).where(eq(submissions.semester_id, semesterId));
  await db.delete(cross_flags).where(eq(cross_flags.semester_id, semesterId));
  const jobRows = await db
    .select({ id: ingest_jobs.id })
    .from(ingest_jobs)
    .where(eq(ingest_jobs.semester_id, semesterId));
  const jobIds = jobRows.map((r) => r.id);
  if (jobIds.length > 0)
    await db.delete(ingest_files).where(inArray(ingest_files.ingest_job_id, jobIds));
  await db.delete(ingest_jobs).where(eq(ingest_jobs.semester_id, semesterId));
  await db.delete(roster_entries).where(eq(roster_entries.semester_id, semesterId));
  await db.delete(assignments).where(eq(assignments.semester_id, semesterId));

  return semesterId;
}

async function pollTerminal(db: DrizzleDb, jobId: string, timeoutMs: number): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [job] = await db
      .select({ status: ingest_jobs.status })
      .from(ingest_jobs)
      .where(eq(ingest_jobs.id, jobId))
      .limit(1);
    const status = job?.status ?? 'unknown';
    if (status !== 'queued' && status !== 'running') return status;
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'timeout';
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(0)}ms`;
}

async function main(): Promise<void> {
  const eventCount = Number(process.argv[2] ?? '50000');
  if (!Number.isFinite(eventCount) || eventCount < 100) {
    throw new Error(`bad event count: ${process.argv[2]}`);
  }
  const cfg = getConfig();
  const db = getDb();

  log(`building one ~4-hour bundle with ${eventCount.toLocaleString()} events…`);
  const tGen = Date.now();
  const exportBytes = await buildExportZip(eventCount);
  log(
    `export ZIP ${(exportBytes.byteLength / 1024 / 1024).toFixed(1)} MB built in ${fmt(Date.now() - tGen)}`,
  );

  await ensureBucket();
  const semesterId = await setup(db);

  log('starting in-process worker…');
  const stopWorker = await startWorker();

  let uploadMs = 0;
  let drainMs = 0;
  let finalStatus = 'unknown';
  try {
    const app = createV1App();
    const formData = new FormData();
    formData.append(
      'archive',
      new Blob([exportBytes.buffer as ArrayBuffer], { type: 'application/zip' }),
      'large_export.zip',
    );

    log('POST /ingest:gradescope …');
    const tUp = Date.now();
    const res = await app.fetch(
      new Request(`http://localhost/semesters/${semesterId}/ingest:gradescope`, {
        method: 'POST',
        headers: { Cookie: `${cfg.SESSION_COOKIE_NAME}=${SESSION_ID}` },
        body: formData,
      }),
    );
    uploadMs = Date.now() - tUp;
    if (res.status !== 202) throw new Error(`ingest HTTP ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { job_id: string };

    const tDr = Date.now();
    finalStatus = await pollTerminal(db, body.job_id, 1_200_000);
    drainMs = Date.now() - tDr;
  } finally {
    await Promise.race([stopWorker(), new Promise((r) => setTimeout(r, 5_000))]);
  }

  const [{ value: subCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(submissions)
    .where(eq(submissions.semester_id, semesterId));
  const [{ value: flagCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(flags)
    .innerJoin(submissions, eq(submissions.id, flags.submission_id))
    .where(eq(submissions.semester_id, semesterId));

  await closeDb();

  log('');
  log('════════════════ SINGLE LARGE BUNDLE ════════════════');
  log(`events in bundle      : ${eventCount.toLocaleString()}`);
  log(`upload request        : ${fmt(uploadMs)}`);
  log(`worker drain (1 bundle): ${fmt(drainMs)}`);
  log(`ingest status         : ${finalStatus}  (${subCount} submission, ${flagCount} flags)`);
  log('');
  dumpProfile(log);
  log('');
  log(`compare: the 700-small-bundle run averaged ~1.0s/bundle (mostly fixed overhead).`);

  process.exit(finalStatus === 'succeeded' || finalStatus === 'partial' ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[large] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
