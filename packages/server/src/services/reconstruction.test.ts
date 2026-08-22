/**
 * Unit/integration tests for services/reconstruction.ts — Phase 18.
 *
 * Events are no longer stored in Postgres: reconstructFile parses the stored
 * bundle blob (via loadSubmissionIndex) and replays the file. Tests seed a real
 * bundle whose events (doc.open 'hello' + doc.change ' world') reconstruct to
 * 'hello world', plus the per_file_stats row reconstructFile checks first.
 *
 * Note on provenance indices: with a real bundle the session's `session.start`
 * is globalIdx 0, so doc.open is globalIdx 1 and doc.change is globalIdx 2 (the
 * old DB-seeded test used 0 and 1 because it had no session.start row).
 *
 * Tests:
 *   1. Cold reconstruction returns 'hello world' with correct provenance.
 *   2. Cache hit returns same object reference.
 *   3. Eviction: fill cache past capacity → oldest entry evicted.
 *   4. Tainted file path → tainted flag returned.
 *   5. Missing file path → throws FILE_NOT_FOUND.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { withTestDb } from '../../test/helpers/db.js';
import { withTestMinio } from '../../test/helpers/minio.js';
import { putSubmissionBundle } from '../../test/helpers/seed-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '@provenance/analysis-core/test-support/build-identity.js';
import type { IdentityTestKeys } from '@provenance/analysis-core/test-support/build-identity.js';
import { _resetConfigForTest, _setConfigForTest } from '../config/index.js';
import { _resetLoggerForTest } from '../logging.js';
import { parseEnv } from '../config/env.js';
import {
  users,
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  per_file_stats,
} from '../db/schema.js';
import type { DrizzleDb } from '../db/client.js';
import type { StorageClient } from './storage/client.js';
import { reconstructFile, _resetReconstructionCacheForTest } from './reconstruction.js';
import { _resetBundleIndexCacheForTest } from './bundle/load-index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTestEnv(extra?: Record<string, string>) {
  return {
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_BUCKET: 'test-bucket',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
    OBJECT_STORAGE_REGION: 'us-east-1',
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
    AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
    AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-reconstruction-tests-1234567',
    SESSION_TTL_DAYS: '14',
    INGEST_MAX_BUNDLE_BYTES: '52428800',
    INGEST_MAX_BATCH_BYTES: '5368709120',
    INGEST_MAX_BATCH_FILES: '10000',
    ...extra,
  };
}

async function seedSubmission(db: DrizzleDb) {
  const uid = crypto.randomUUID();

  const [user] = await db
    .insert(users)
    .values({ google_subject: `sub-${uid}`, email: `u-${uid}@test.com`, display_name: 'U' })
    .returning();

  const [course] = await db
    .insert(courses)
    .values({ name: 'CS', slug: `c-${uid.slice(0, 8)}` })
    .returning();

  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2024,
      slug: `fa24-${uid.slice(0, 8)}`,
      display_name: 'Fall 2024',
      filename_convention: '(?<sid>\\d+)',
    })
    .returning();

  const [student] = await db
    .insert(roster_entries)
    .values({ semester_id: semester!.id, sid: `s-${uid.slice(0, 6)}`, display_name: 'Alice' })
    .returning();

  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semester!.id, assignment_id_str: 'hw1', label: 'HW1' })
    .returning();

  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semester!.id, uploaded_by: user!.id, status: 'succeeded' })
    .returning();

  const submissionId = crypto.randomUUID();

  await db.insert(submissions).values({
    id: submissionId,
    semester_id: semester!.id,
    assignment_id: assignment!.id,
    student_id: student!.id,
    blob_object_key: `semesters/${semester!.id}/submissions/${submissionId}/bundle.zip`,
    blob_sha256: `sha256-${submissionId}`,
    source_filename: 'test.zip',
    ingest_job_id: job!.id,
    version_index: 1,
  });

  return { submissionId, semesterId: semester!.id };
}

/**
 * Build + store a bundle whose events reconstruct file `main.py` to
 * 'hello world': doc.open seeds 'hello', doc.change appends ' world'.
 */
async function putFileBundle(db: DrizzleDb, storage: StorageClient, submissionId: string) {
  const { zipBuffer } = await buildTestBundle({
    sessions: [
      {
        events: [
          { kind: 'doc.open', data: { path: 'main.py', content: 'hello' } },
          {
            kind: 'doc.change',
            data: {
              path: 'main.py',
              deltas: [
                {
                  range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } },
                  text: ' world',
                },
              ],
            },
          },
        ],
      },
    ],
  });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
}

async function seedPerFileStats(
  db: DrizzleDb,
  submissionId: string,
  filePath: string,
  opts?: { tainted?: boolean },
) {
  await db.insert(per_file_stats).values({
    submission_id: submissionId,
    file_path: filePath,
    chars_typed: 0,
    chars_pasted: 0,
    chars_external_change_delta: 0,
    saves: 0,
    final_length: 11,
    start_length: 0,
    reconstruction_tainted: opts?.tainted ?? false,
  });
}

beforeEach(() => {
  _resetConfigForTest();
  _resetLoggerForTest();
  _resetReconstructionCacheForTest();
  _resetBundleIndexCacheForTest();
});

// ---------------------------------------------------------------------------
// §1. Cold reconstruction
// ---------------------------------------------------------------------------

describe('reconstructFile — cold reconstruction', () => {
  it('returns expected content from doc.open + doc.change events', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(parseEnv(makeTestEnv()));

        const { submissionId } = await seedSubmission(db);
        await putFileBundle(db, client, submissionId);
        await seedPerFileStats(db, submissionId, 'main.py');

        const result = await reconstructFile(db, client, submissionId, 'main.py');

        expect(result.content).toBe('hello world');
        // provenance should have 11 entries (one per char)
        expect(result.provenance).toHaveLength(11);
        // First 5 chars come from doc.open (globalIdx 1), next 6 from
        // doc.change (globalIdx 2). globalIdx 0 is the session.start event.
        expect(result.provenance.slice(0, 5).every((v) => v === 1)).toBe(true);
        expect(result.provenance.slice(5).every((v) => v === 2)).toBe(true);
        expect(result.tainted).toBe(false);
        expect(result.computedAtMs).toBeGreaterThanOrEqual(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// §2. Cache hit
// ---------------------------------------------------------------------------

describe('reconstructFile — cache hit', () => {
  it('returns same object reference on second call', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(parseEnv(makeTestEnv()));

        const { submissionId } = await seedSubmission(db);
        await putFileBundle(db, client, submissionId);
        await seedPerFileStats(db, submissionId, 'main.py');

        const first = await reconstructFile(db, client, submissionId, 'main.py');
        const t0 = Date.now();
        const second = await reconstructFile(db, client, submissionId, 'main.py');
        const elapsed = Date.now() - t0;

        // Same object reference proves no recomputation.
        expect(second).toBe(first);
        // Cache hit should be very fast (no blob round-trip).
        expect(elapsed).toBeLessThan(50);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// §3. Cache eviction
// ---------------------------------------------------------------------------

describe('reconstructFile — cache eviction', () => {
  it('evicts oldest entry when capacity is exceeded', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        // Set cache capacity to 2 so we can test eviction easily.
        _setConfigForTest(parseEnv(makeTestEnv({ RECONSTRUCTION_CACHE_SIZE: '2' })));

        // Seed 3 submissions, each with a file.
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          const { submissionId } = await seedSubmission(db);
          await putFileBundle(db, client, submissionId);
          await seedPerFileStats(db, submissionId, 'main.py');
          ids.push(submissionId);
        }
        const [s0, s1, s2] = ids;

        const first0 = await reconstructFile(db, client, s0!, 'main.py');
        await reconstructFile(db, client, s1!, 'main.py');
        await reconstructFile(db, client, s2!, 'main.py'); // evicts s0

        const second0 = await reconstructFile(db, client, s0!, 'main.py');
        expect(second0).not.toBe(first0);
        expect(second0.content).toBe(first0.content); // Same content, different object.
      });
    });
  });
});

// ---------------------------------------------------------------------------
// §4. Tainted file
// ---------------------------------------------------------------------------

describe('reconstructFile — tainted file', () => {
  it('returns tainted=true when per_file_stats.reconstruction_tainted is true', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(parseEnv(makeTestEnv()));

        const { submissionId } = await seedSubmission(db);
        await putFileBundle(db, client, submissionId);
        await seedPerFileStats(db, submissionId, 'main.py', { tainted: true });

        const result = await reconstructFile(db, client, submissionId, 'main.py');

        expect(result.tainted).toBe(true);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// §5. Missing file path
// ---------------------------------------------------------------------------

describe('reconstructFile — missing file path', () => {
  it('throws FILE_NOT_FOUND for path not in per_file_stats', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(parseEnv(makeTestEnv()));

        const { submissionId } = await seedSubmission(db);
        // Do NOT seed per_file_stats for this path — reconstructFile checks
        // per_file_stats before touching the blob, so no bundle is needed.

        await expect(
          reconstructFile(db, client, submissionId, 'nonexistent.py'),
        ).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// §6. Two contributors on unordered lineages (Tier 2.2)
// ---------------------------------------------------------------------------

/**
 * Two partners, each with a verified institution identity, each typing a
 * distinctive line into the SAME file. No `git.event` and no `prev_session_id`,
 * so nothing in the recorded evidence orders the two sessions.
 *
 * This is the case that survived unnoticed: `reconstruction.ts` called the
 * UNSCOPED `reconstructFileWithProvenance`, which replays one wall-derived
 * stream and therefore returned an interleaving of both partners' work — with
 * per-character attribution, over a public OpenAPI endpoint, with no warning.
 */
async function putConcurrentPartnersBundle(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  k: IdentityTestKeys,
) {
  const sessions = [];
  const lines = ['ALICE_LINE', 'BOB_LINE'];
  for (let i = 0; i < lines.length; i++) {
    const sk = await seededKeypair(0xa0 + i);
    sessions.push({
      events: [
        {
          kind: 'doc.change',
          data: {
            path: 'main.py',
            deltas: [
              {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
                text: lines[i]!,
              },
            ],
            source: 'typed',
          },
        },
      ],
      sessionStart: {
        session_pubkey: sk.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: k,
          sessionPubkeyHex: sk.pubkeyHex,
          studentRef: i === 0 ? 'alice' : 'bob',
        }),
      },
    });
  }
  const { zipBuffer } = await buildTestBundle({ sessions });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
}

describe('reconstructFile — two contributors, unordered lineages', () => {
  it('refuses to linearize: no content, no provenance, a concurrent verdict', async () => {
    const k = await buildIdentityKeys();
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(
          parseEnv(makeTestEnv({ PROVENANCE_ROOT_PUBLIC_KEY_HEX: k.root.pubkeyHex })),
        );

        const { submissionId } = await seedSubmission(db);
        await putConcurrentPartnersBundle(db, client, submissionId, k);
        await seedPerFileStats(db, submissionId, 'main.py');

        const result = await reconstructFile(db, client, submissionId, 'main.py');

        expect(result.ambiguity?.kind).toBe('concurrent');
        // Not "unknown" — we hold both records, and saying we cannot see would
        // throw away a fact we actually have.
        expect(result.ambiguity?.detail).not.toBe('');

        // No branch is served, and no interleaving of the two is served either.
        expect(result.content).toBe('');
        expect(result.provenance).toEqual([]);
        expect(result.kindByGlobalIdx.size).toBe(0);
      });
    });
  });

  /**
   * The counterpart that proves the feature is GATED rather than merely usually
   * inactive: the same deployment, the same root key, one contributor — and the
   * answer is byte for byte what it was before any of this existed.
   */
  it('leaves a solo submission byte-identical on the same deployment', async () => {
    const k = await buildIdentityKeys();
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        _setConfigForTest(
          parseEnv(makeTestEnv({ PROVENANCE_ROOT_PUBLIC_KEY_HEX: k.root.pubkeyHex })),
        );

        const { submissionId } = await seedSubmission(db);
        await putFileBundle(db, client, submissionId);
        await seedPerFileStats(db, submissionId, 'main.py');

        const result = await reconstructFile(db, client, submissionId, 'main.py');

        expect(result.ambiguity).toBeNull();
        expect(result.content).toBe('hello world');
        expect(result.provenance).toHaveLength(11);
      });
    });
  });
});
