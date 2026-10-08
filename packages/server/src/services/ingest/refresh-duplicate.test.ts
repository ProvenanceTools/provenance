/**
 * Re-uploading the same artifact refreshes a pre-shas submission.
 *
 * Rows ingested before submitted shas were persisted carry none, so check 8 on
 * their stripped bundle cannot establish what was submitted. Re-uploading the
 * original export hits dedup; when its provenance entries prove it is the same
 * artifact, the duplicate path restores the shas and re-runs validation +
 * heuristics + scoring for that submission (refresh-duplicate.ts).
 *
 * Postgres via testcontainers; blobs in an fs store. The "pre-shas row" is
 * built the way production built one: validate + score the full bundle without
 * recording shas, store the stripped copy, then recompute once (which is what
 * every such row has been through since).
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import JSZip from 'jszip';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { sha256Hex } from '@provenance/log-core';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import type { BuildBundleOpts } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import * as schema from '../../db/schema.js';
import {
  audit_log,
  flags,
  ingest_files,
  submissions,
  validation_results,
} from '../../db/schema.js';
import { withTransaction, type DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { putBlob } from '../storage/blobs.js';
import { ingestStagingKey } from '../storage/keys.js';
import { parseEnv } from '../../config/env.js';
import { _setConfigForTest, _resetConfigForTest } from '../../config/index.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { putSubmissionBundle } from '../../../test/helpers/seed-bundle.js';
import { stripBundleSourceFiles } from './strip-bundle.js';
import { runAndStoreValidation } from './validation.js';
import { loadStoredSubmittedShas } from './submitted-shas.js';
import { runAndStoreHeuristics } from '../heuristics/run-per-submission.js';
import { DEFAULT_SERVER_CONFIG } from '../heuristics/config.js';
import { recomputeSubmission } from '../scoring/recompute-submission.js';
import {
  settleDuplicateWithRefresh,
  planDuplicateRefresh,
  DUPLICATE_REFRESH_AUDIT_ACTION,
} from './refresh-duplicate.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations');

// ---------------------------------------------------------------------------
// Fixture content
// ---------------------------------------------------------------------------

const shaOf = (text: string): string => sha256Hex(new TextEncoder().encode(text));
const FILE = 'solution.py';
const V0 = 'def f():\n    return 0\n';
const V1 = 'def f():\n    return 1\n';
const V2 = 'def f():\n    return 2\n';
const FOREIGN = 'def f():\n    return 42  # pasted in after the fact\n';

type Shape = {
  seal: 'rolling-provisional' | 'rolling-final';
  submitted: string;
  sealedAs: string;
};

function bundleOpts(shape: Shape): BuildBundleOpts {
  return {
    submissionFiles: [
      {
        path: FILE,
        status: 'present',
        content: shape.submitted,
        manifestSha256Override: shaOf(shape.sealedAs),
      },
    ],
    sessions: [
      {
        walls: ['2026-01-01T10:00:00.000Z'],
        events: [
          {
            kind: 'doc.open',
            data: { path: FILE, sha256: shaOf(V0) },
            wall: '2026-01-01T10:00:01.000Z',
            t: 1_000,
          },
          {
            kind: 'doc.save',
            data: { path: FILE, sha256: shaOf(V1) },
            wall: '2026-01-01T10:05:00.000Z',
            t: 300_000,
          },
          {
            kind: 'doc.save',
            data: { path: FILE, sha256: shaOf(V2) },
            wall: '2026-01-01T10:05:40.000Z',
            t: 340_000,
          },
        ],
      },
    ],
    rollingSeal: { final: shape.seal === 'rolling-final' },
  };
}

/** What the export path does: same entries, rebuilt archive, new timestamps. */
async function rezip(zip: Uint8Array): Promise<Uint8Array> {
  const src = await JSZip.loadAsync(zip);
  const out = new JSZip();
  const date = new Date('2030-06-01T00:00:00Z');
  for (const name of Object.keys(src.files).sort().reverse()) {
    const f = src.files[name]!;
    if (f.dir) continue;
    out.file(name, await f.async('uint8array'), { date });
  }
  return out.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let pg: StartedPostgreSqlContainer;
let pgSql: postgres.Sql;
let db: DrizzleDb;
let blobRoot: string;
let storage: StorageClient;
const logger = { info: vi.fn(), error: vi.fn() };

beforeAll(async () => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));

  pg = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('provenance_test')
    .withUsername('test')
    .withPassword('test')
    .withStartupTimeout(120_000)
    .start();
  pgSql = postgres(pg.getConnectionUri(), { max: 4 });
  db = drizzle(pgSql, { schema }) as DrizzleDb;
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  blobRoot = await mkdtemp(join(tmpdir(), 'prov-refresh-'));
  storage = {
    kind: 'fs',
    rootDir: blobRoot,
    signingSecret: 's'.repeat(32),
    publicBaseUrl: 'http://x',
  };
  _setConfigForTest(
    parseEnv({
      PUBLIC_BASE_URL: 'https://example.test',
      DATABASE_URL: pg.getConnectionUri(),
      GOOGLE_OAUTH_CLIENT_ID: 'client-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
      BLOB_STORAGE_BACKEND: 'fs',
      BLOB_STORAGE_FS_ROOT: blobRoot,
      BLOB_URL_SIGNING_SECRET: 'x'.repeat(32),
    }),
  );
});

afterAll(async () => {
  _resetConfigForTest();
  await pgSql.end();
  await pg.stop();
  await rm(blobRoot, { recursive: true, force: true });
});

type Seeded = {
  submissionId: string;
  semesterId: string;
  jobId: string;
  /** The original upload, WITH source. */
  original: Uint8Array;
};

/** A row as ingested before submitted shas existed, then recomputed once. */
async function seedPreShasRow(shape: Shape): Promise<Seeded> {
  const submissionId = await seedSubmission(db);
  const [row] = await db
    .select({ semesterId: submissions.semester_id, jobId: submissions.ingest_job_id })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  const { zipBuffer } = await buildTestBundle(bundleOpts(shape));
  const original = new Uint8Array(zipBuffer);
  const loaded = await loadBundle(zipBuffer, 'hw.zip');
  if (!loaded.ok) throw new Error('load failed');

  await putSubmissionBundle(db, storage, submissionId, await stripBundleSourceFiles(original));
  await withTransaction(db, async (tx) => {
    const report = await runAndStoreValidation(tx, submissionId, loaded.value, {});
    await runAndStoreHeuristics(tx, submissionId, row!.semesterId, loaded.value, report);
  });
  await recomputeSubmission(db, storage, submissionId, row!.semesterId, DEFAULT_SERVER_CONFIG, 0);
  expect(await loadStoredSubmittedShas(db, submissionId)).toBeUndefined();
  return { submissionId, semesterId: row!.semesterId, jobId: row!.jobId, original };
}

/** Stage `bytes` as a new pending ingest file of the row's job. */
async function stageUpload(s: Seeded, bytes: Uint8Array): Promise<string> {
  const [f] = await db
    .insert(ingest_files)
    .values({
      ingest_job_id: s.jobId,
      original_filename: 're-upload.zip',
      size_bytes: bytes.byteLength,
      blob_sha256: sha256Hex(bytes),
      status: 'pending',
    })
    .returning({ id: ingest_files.id });
  await putBlob(storage, ingestStagingKey(s.jobId, f!.id), bytes);
  return f!.id;
}

function markDuplicate(s: Seeded, fileId: string): (h: DrizzleDb) => Promise<void> {
  return (h: DrizzleDb) =>
    h
      .update(ingest_files)
      .set({ status: 'duplicate', submission_id: s.submissionId, resolved_at: new Date() })
      .where(eq(ingest_files.id, fileId))
      .then(() => undefined);
}

function settle(s: Seeded, fileId: string, mark = markDuplicate(s, fileId)) {
  return settleDuplicateWithRefresh(
    { db, storage, logger },
    {
      existingSubmissionId: s.submissionId,
      semesterId: s.semesterId,
      stagingKey: ingestStagingKey(s.jobId, fileId),
      ingestJobId: s.jobId,
      ingestFileId: fileId,
    },
    mark,
  );
}

async function state(s: Seeded) {
  const [v] = await db
    .select({ check8: validation_results.check_8_status })
    .from(validation_results)
    .where(eq(validation_results.submission_id, s.submissionId));
  const [sub] = await db
    .select({ score: submissions.score_total })
    .from(submissions)
    .where(eq(submissions.id, s.submissionId));
  const flagRows = await db
    .select({ id: flags.heuristic_id })
    .from(flags)
    .where(eq(flags.submission_id, s.submissionId));
  const audits = await db
    .select({ detail: audit_log.detail })
    .from(audit_log)
    .where(
      and(
        eq(audit_log.target_id, s.submissionId),
        eq(audit_log.action, DUPLICATE_REFRESH_AUDIT_ACTION),
      ),
    );
  return {
    check8: v!.check8,
    score: sub!.score,
    codeMatchFlags: flagRows.filter((f) => f.id === 'submitted_code_match').length,
    shas: await loadStoredSubmittedShas(db, s.submissionId),
    audits: audits.map((a) => a.detail),
  };
}

async function fileStatus(fileId: string): Promise<string> {
  const [f] = await db
    .select({ status: ingest_files.status })
    .from(ingest_files)
    .where(eq(ingest_files.id, fileId));
  return f!.status;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('duplicate re-upload of a pre-shas submission', () => {
  it('restores the shas and re-evaluates check 8 with the real bytes', async () => {
    const s = await seedPreShasRow({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });
    expect((await state(s)).check8).toBe('skipped');

    const reupload = await rezip(s.original);
    expect(sha256Hex(reupload)).not.toBe(sha256Hex(s.original));
    const fileId = await stageUpload(s, reupload);

    expect(await settle(s, fileId)).toBe('refreshed');

    const after = await state(s);
    expect(after.shas).toEqual({ [FILE]: shaOf(V2) });
    expect(after.check8).toBe('pass');
    expect(after.audits).toEqual([
      expect.objectContaining({
        ingest_file_id: fileId,
        ingest_job_id: s.jobId,
        check_8_before: 'skipped',
        check_8_after: 'pass',
      }),
    ]);
    expect(await fileStatus(fileId)).toBe('duplicate');
  });

  it('updates flags and score: a tamper lost on recompute is found again', async () => {
    // Final seal over the last recorded save; the archive carries bytes nobody
    // recorded. The stripped copy, without shas, compares seal against
    // recording and passes — the tamper is invisible until the bytes return.
    const s = await seedPreShasRow({ seal: 'rolling-final', submitted: FOREIGN, sealedAs: V2 });
    const before = await state(s);
    expect(before.check8).toBe('pass');
    expect(before.codeMatchFlags).toBe(0);

    const fileId = await stageUpload(s, await rezip(s.original));
    expect(await settle(s, fileId)).toBe('refreshed');

    const after = await state(s);
    expect(after.shas).toEqual({ [FILE]: shaOf(FOREIGN) });
    expect(after.check8).toBe('fail');
    expect(after.codeMatchFlags).toBe(1);
    expect(after.score).toBeGreaterThan(before.score);
    expect(await fileStatus(fileId)).toBe('duplicate');
  });

  it('changes nothing when the provenance entries differ', async () => {
    const s = await seedPreShasRow({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });
    const before = await state(s);
    // Same content, separately built: different session keys and signatures.
    const { zipBuffer } = await buildTestBundle(
      bundleOpts({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 }),
    );
    const fileId = await stageUpload(s, new Uint8Array(zipBuffer));

    expect(await settle(s, fileId)).toBe('not_refreshed');
    expect(await state(s)).toEqual(before);
    expect(await fileStatus(fileId)).toBe('duplicate');
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'artifact_mismatch' }),
      expect.any(String),
    );
  });

  it('does no work for a submission that already has stored shas', async () => {
    const s = await seedPreShasRow({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });
    const first = await stageUpload(s, await rezip(s.original));
    expect(await settle(s, first)).toBe('refreshed');
    const before = await state(s);

    // A staging key that does not exist: the cheap path must not read a blob.
    expect(
      await planDuplicateRefresh(db, storage, {
        existingSubmissionId: s.submissionId,
        stagingKey: 'ingest-staging/none/none',
      }),
    ).toEqual({ kind: 'skip', reason: 'already_has_shas' });

    const second = await stageUpload(s, await rezip(s.original));
    expect(await settle(s, second)).toBe('not_refreshed');
    expect(await state(s)).toEqual(before); // one audit row, same verdicts
    expect(await fileStatus(second)).toBe('duplicate');
  });
});

describe('retry and concurrency', () => {
  it('a transient failure rolls the whole refresh back and a retry completes it once', async () => {
    const s = await seedPreShasRow({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });
    const before = await state(s);
    const fileId = await stageUpload(s, await rezip(s.original));

    // Fail at the very end of the transaction, after the recompute wrote.
    const transient = async () => {
      throw Object.assign(new Error('serialization failure'), { code: '40001' });
    };
    await expect(settle(s, fileId, transient)).rejects.toThrow('serialization failure');
    expect(await state(s)).toEqual(before);
    expect(await fileStatus(fileId)).toBe('pending');

    // pg-boss retry: the file is still pending, so the whole thing runs again.
    expect(await settle(s, fileId)).toBe('refreshed');
    const after = await state(s);
    expect(after.check8).toBe('pass');
    expect(after.audits).toHaveLength(1);
    expect(await fileStatus(fileId)).toBe('duplicate');
  });

  it('a non-transient refresh failure settles the file as a plain duplicate', async () => {
    const s = await seedPreShasRow({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });
    const before = await state(s);
    const fileId = await stageUpload(s, await rezip(s.original));
    const plain = markDuplicate(s, fileId);
    let calls = 0;
    const failInsideTx = async (h: DrizzleDb) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      await plain(h);
    };

    expect(await settle(s, fileId, failInsideTx)).toBe('not_refreshed');
    expect(await state(s)).toEqual(before);
    expect(await fileStatus(fileId)).toBe('duplicate');
  });

  it('concurrent duplicates of one artifact refresh it exactly once', async () => {
    const s = await seedPreShasRow({ seal: 'rolling-provisional', submitted: V2, sealedAs: V1 });
    const bytes = await rezip(s.original);
    const a = await stageUpload(s, bytes);
    const b = await stageUpload(s, bytes);

    const outcomes = await Promise.all([settle(s, a), settle(s, b)]);
    expect(outcomes.sort()).toEqual(['not_refreshed', 'refreshed']);

    const after = await state(s);
    expect(after.audits).toHaveLength(1);
    expect(after.check8).toBe('pass');
    // Two interleaved recomputes could leave both runs' flag rows behind.
    const all = await db.select().from(flags).where(eq(flags.submission_id, s.submissionId));
    const expected = await recomputeSubmission(
      db,
      storage,
      s.submissionId,
      s.semesterId,
      DEFAULT_SERVER_CONFIG,
      0,
      { simulate: true },
    );
    expect(all).toHaveLength(expected.flag_count);
    expect(await fileStatus(a)).toBe('duplicate');
    expect(await fileStatus(b)).toBe('duplicate');
  });
});
