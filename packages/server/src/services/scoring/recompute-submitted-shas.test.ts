/**
 * Persisted submitted shas: ingest → strip → recompute / Source tab / API.
 *
 * Ingest computes check 8 on the bundle WITH its source, then stores a
 * source-stripped copy. Every later re-run of check 8 (per-submission
 * recompute, the Source tab) sees only the stripped copy, so ingest persists
 * the sha256 of each submitted file's bytes on the stored check-8 entry and the
 * re-runs read it back (services/ingest/submitted-shas.ts). These tests drive
 * the real stages against Postgres (testcontainers) and an fs blob store:
 *
 *   - ingest persists the shas;
 *   - a provisional rolling seal (written before the last save) still passes
 *     check 8 on recompute with stored shas, and degrades to `skipped` — never
 *     `fail`, never a flag — without them;
 *   - a final-seal tamper verdict found at ingest survives a recompute (and
 *     would not without the stored shas — asserted, so the test cannot pass
 *     vacuously);
 *   - the shas survive repeated recomputes and any validation rewrite;
 *   - no API-facing reader exposes them.
 */

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { eq, sql as dsql } from 'drizzle-orm';
import { sha256Hex } from '@provenance/log-core';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import type { BuildBundleOpts } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import * as schema from '../../db/schema.js';
import { flags, submissions, validation_results } from '../../db/schema.js';
import { withTransaction, type DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { parseEnv } from '../../config/env.js';
import { _setConfigForTest, _resetConfigForTest } from '../../config/index.js';
import { seedSubmission } from '../../../test/helpers/seed-submission.js';
import { putSubmissionBundle } from '../../../test/helpers/seed-bundle.js';
import { stripBundleSourceFiles } from '../ingest/strip-bundle.js';
import { runAndStoreValidation, ingestValidationOptions } from '../ingest/validation.js';
import { readSubmittedShas, loadStoredSubmittedShas } from '../ingest/submitted-shas.js';
import { runAndStoreHeuristics } from '../heuristics/run-per-submission.js';
import { DEFAULT_SERVER_CONFIG } from '../heuristics/config.js';
import { reconstructBundleFromDb } from '../heuristics/reconstruct-bundle.js';
import { getSubmissionValidation, getStoredSourceGate } from '../submissions/validation.js';
import { extractSubmittedFiles } from '../submissions/submitted-files.js';
import { getBlob } from '../storage/blobs.js';
import { recomputeSubmission } from './recompute-submission.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../db/migrations');

// ---------------------------------------------------------------------------
// Fixture content (mirrors analysis-core's provisional-rolling-seal.test.ts)
// ---------------------------------------------------------------------------

const shaOf = (text: string): string => sha256Hex(new TextEncoder().encode(text));

const FILE = 'solution.py';
/** Opened at session start. */
const V0 = 'def f():\n    return 0\n';
/** Saved, then captured by the last checkpoint's seal. */
const V1 = 'def f():\n    return 1\n';
/** Saved AFTER the last checkpoint, then committed with the editor still open. */
const V2 = 'def f():\n    return 2\n';
/** Never on disk while the recorder was watching. */
const FOREIGN = 'def f():\n    return 42  # pasted in after the fact\n';

type Shape = {
  seal: 'rolling-provisional' | 'rolling-final' | 'classic';
  /** Bytes in the uploaded archive. */
  submitted: string;
  /** Content the seal's `submission_files` sha256 is taken over. */
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
    ...(shape.seal === 'classic' ? {} : { rollingSeal: { final: shape.seal === 'rolling-final' } }),
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let pg: StartedPostgreSqlContainer;
let pgSql: postgres.Sql;
let db: DrizzleDb;
let blobRoot: string;
let storage: StorageClient;

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
  pgSql = postgres(pg.getConnectionUri(), { max: 3 });
  db = drizzle(pgSql, { schema }) as DrizzleDb;
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });

  blobRoot = await mkdtemp(join(tmpdir(), 'prov-shas-'));
  storage = {
    kind: 'fs',
    rootDir: blobRoot,
    signingSecret: 's'.repeat(32),
    publicBaseUrl: 'http://x',
  };

  // recompute reads the (optional) root key through getConfig().
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

/**
 * The ingest stages that matter here, in pipeline order: validation +
 * heuristics on the FULL bundle, and the stored blob source-stripped exactly as
 * create-submission.ts strips it. `persistShas: false` models a row ingested
 * before the shas were recorded.
 */
async function ingest(
  shape: Shape,
  { persistShas }: { persistShas: boolean },
): Promise<{ submissionId: string; semesterId: string }> {
  const submissionId = await seedSubmission(db);
  const [row] = await db
    .select({ semesterId: submissions.semester_id })
    .from(submissions)
    .where(eq(submissions.id, submissionId));

  const { zipBuffer } = await buildTestBundle(bundleOpts(shape));
  const loaded = await loadBundle(zipBuffer, 'hw.zip');
  if (!loaded.ok) throw new Error(`load failed: ${JSON.stringify(loaded.error)}`);
  const bundle = loaded.value;

  await putSubmissionBundle(
    db,
    storage,
    submissionId,
    await stripBundleSourceFiles(new Uint8Array(zipBuffer)),
  );

  await withTransaction(db, async (tx) => {
    const report = await runAndStoreValidation(
      tx,
      submissionId,
      bundle,
      persistShas ? ingestValidationOptions(bundle) : {},
    );
    await runAndStoreHeuristics(tx, submissionId, row!.semesterId, bundle, report);
  });
  return { submissionId, semesterId: row!.semesterId };
}

async function recompute(submissionId: string, semesterId: string): Promise<void> {
  await recomputeSubmission(db, storage, submissionId, semesterId, DEFAULT_SERVER_CONFIG, 1);
}

async function stored(submissionId: string): Promise<{ check8: string; detail: unknown }> {
  const [r] = await db
    .select({ check8: validation_results.check_8_status, detail: validation_results.detail })
    .from(validation_results)
    .where(eq(validation_results.submission_id, submissionId));
  return r!;
}

async function codeMatchFlags(submissionId: string): Promise<number> {
  const rows = await db
    .select({ id: flags.heuristic_id })
    .from(flags)
    .where(eq(flags.submission_id, submissionId));
  return rows.filter((r) => r.id === 'submitted_code_match').length;
}

/** Drop the persisted shas from a stored row, as if it predated them. */
async function forgetShas(submissionId: string): Promise<void> {
  await db
    .update(validation_results)
    .set({ detail: dsql`jsonb_set(detail, '{7}', (detail -> 7) - 'submitted_shas')` })
    .where(eq(validation_results.submission_id, submissionId));
}

async function readBlob(submissionId: string): Promise<ArrayBuffer> {
  const [r] = await db
    .select({ key: submissions.blob_object_key })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  return new Response(await getBlob(storage, r!.key)).arrayBuffer();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ingest persists the submitted shas', () => {
  it('stores the actual bytes’ sha on the check-8 entry of validation_results.detail', async () => {
    const { submissionId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: true },
    );
    const row = await stored(submissionId);
    expect(readSubmittedShas(row.detail)).toEqual({ [FILE]: shaOf(V2) });
    // Index 7 is check 8, which is what the upsert's preservation clause reads.
    expect((row.detail as Array<{ id: string }>)[7]!.id).toBe('submitted_code_match');
    expect(row.check8).toBe('pass');
  });
});

describe('recompute on the stripped bundle', () => {
  it('keeps a provisional-seal pass when the shas were stored', async () => {
    const { submissionId, semesterId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: true },
    );
    await recompute(submissionId, semesterId);

    const row = await stored(submissionId);
    expect(row.check8).toBe('pass');
    expect(await codeMatchFlags(submissionId)).toBe(0);
    expect(readSubmittedShas(row.detail)).toEqual({ [FILE]: shaOf(V2) });
  });

  it('reads a provisional seal as skipped, with no flag, when no shas were stored', async () => {
    const { submissionId, semesterId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: false },
    );
    await recompute(submissionId, semesterId);

    const row = await stored(submissionId);
    expect(row.check8).toBe('skipped');
    expect(await codeMatchFlags(submissionId)).toBe(0);
    // Nothing is invented: a recompute cannot recover shas it never had.
    expect(readSubmittedShas(row.detail)).toBeUndefined();
  });

  it('keeps a final-seal tamper verdict found at ingest — which it would lose without the shas', async () => {
    // The seal commits to V2, the last recorded save; the archive carries bytes
    // nobody recorded. At ingest the bytes disagree with their own seal.
    const shape: Shape = { seal: 'rolling-final', submitted: FOREIGN, sealedAs: V2 };
    const { submissionId, semesterId } = await ingest(shape, { persistShas: true });
    expect((await stored(submissionId)).check8).toBe('fail');
    expect(await codeMatchFlags(submissionId)).toBe(1);

    await recompute(submissionId, semesterId);
    expect((await stored(submissionId)).check8).toBe('fail');
    expect(await codeMatchFlags(submissionId)).toBe(1);

    // Control: the same row with its shas removed. The stripped copy then
    // compares the seal's V2 against the recorded V2 and passes — the verdict
    // the stored shas exist to prevent.
    await forgetShas(submissionId);
    await recompute(submissionId, semesterId);
    expect((await stored(submissionId)).check8).toBe('pass');
    expect(await codeMatchFlags(submissionId)).toBe(0);
  });

  it('keeps the shas across repeated recomputes', async () => {
    const { submissionId, semesterId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: true },
    );
    for (let i = 0; i < 3; i++) await recompute(submissionId, semesterId);
    const row = await stored(submissionId);
    expect(readSubmittedShas(row.detail)).toEqual({ [FILE]: shaOf(V2) });
    expect(row.check8).toBe('pass');
  });

  it('a dry run (simulate) writes nothing', async () => {
    const { submissionId, semesterId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: true },
    );
    const before = await stored(submissionId);
    await recomputeSubmission(db, storage, submissionId, semesterId, DEFAULT_SERVER_CONFIG, 1, {
      simulate: true,
    });
    expect(await stored(submissionId)).toEqual(before);
  });
});

describe('runAndStoreValidation never drops stored shas', () => {
  it('preserves them when a rewrite carries none', async () => {
    const { submissionId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: true },
    );
    const { bundle } = await reconstructBundleFromDb(db, storage, submissionId);
    await runAndStoreValidation(db, submissionId, bundle, {});
    expect(await loadStoredSubmittedShas(db, submissionId)).toEqual({ [FILE]: shaOf(V2) });
  });

  it('replaces them when a rewrite carries its own', async () => {
    const { submissionId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: true },
    );
    const { bundle } = await reconstructBundleFromDb(db, storage, submissionId);
    await runAndStoreValidation(db, submissionId, bundle, { submittedShas: { [FILE]: shaOf(V1) } });
    expect(await loadStoredSubmittedShas(db, submissionId)).toEqual({ [FILE]: shaOf(V1) });
  });
});

describe('the Source tab and the API', () => {
  it('Source tab verdicts use the stored shas (provisional seal → match)', async () => {
    const { submissionId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: true },
    );
    const gate = await getStoredSourceGate(db, submissionId);
    expect(gate.submittedShas).toEqual({ [FILE]: shaOf(V2) });

    const list = await extractSubmittedFiles(await readBlob(submissionId), gate);
    expect(list.files).toEqual([
      { path: FILE, status: 'present', verdict: 'match', sha256: shaOf(V2) },
    ]);
    // Never part of the HTTP contract.
    expect(JSON.stringify(list)).not.toContain('submitted_shas');
  });

  it('Source tab reads unknown — not mismatch — for a pre-shas row with a provisional seal', async () => {
    const { submissionId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: false },
    );
    const gate = await getStoredSourceGate(db, submissionId);
    expect(gate.submittedShas).toBeUndefined();
    const list = await extractSubmittedFiles(await readBlob(submissionId), gate);
    expect(list.files.map((f) => f.verdict)).toEqual(['unknown']);
  });

  it('the validation endpoint payload and the rebuilt report carry no submitted_shas', async () => {
    const { submissionId } = await ingest(
      { seal: 'rolling-provisional', submitted: V2, sealedAs: V1 },
      { persistShas: true },
    );
    // Sanity: the field IS stored, so the absence below is a real strip.
    expect(JSON.stringify((await stored(submissionId)).detail)).toContain('submitted_shas');

    const v = await getSubmissionValidation(db, submissionId);
    expect(v!.checks.find((c) => c.id === 'submitted_code_match')!.status).toBe('pass');
    expect(JSON.stringify(v)).not.toContain('submitted_shas');

    const { validationReport } = await reconstructBundleFromDb(db, storage, submissionId);
    expect(JSON.stringify(validationReport)).not.toContain('submitted_shas');
  });
});
