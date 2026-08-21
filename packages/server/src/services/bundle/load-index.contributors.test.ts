/**
 * `loadSubmissionIndex` stamps the contributor verdict — Tier 1.1 wiring.
 *
 * `establishBundleContributors` is the one implementation of "which contributor
 * produced this session?". Until something CALLS it, every bundle everywhere
 * reads `unattributed` and the whole contributor programme is inert. On the
 * server that call belongs in exactly one place: `loadSubmissionIndex`, the
 * choke point every read path goes through (events API, replay/reconstruction,
 * per-submission recompute, cross-flags, submission summary/stats, Source tab).
 *
 * These tests exist because the failure mode is SILENT. Drop the call and
 * nothing throws, nothing 500s, no assertion about events or flags changes —
 * the stamp simply is not there and every session reads `unattributed`. So the
 * assertions here are deliberately about the stamp itself, and about the two
 * ways the LRU cache could get it wrong: dropping it on a hit, or handing one
 * bundle's stamp to another.
 *
 * The blameless states get as much coverage as the attributed one:
 *
 *  - a bundle with NO identity block reads `unattributed` end to end. That is an
 *    ordinary student who never enrolled, and NOTHING about it may read as
 *    suspicious — no claim, no reason, no student ref, no grouping with anyone.
 *  - a deployment with NO root public key still serves the submission. Every
 *    identified session reads `unverifiable / no_root_key`, and
 *    `isIdentityCheckFailure()` reports that as FALSE: "we could not check",
 *    never "we checked and it failed". Rendering a whole cohort as failing
 *    identity verification because an operator has not set an env var would be a
 *    deployment misconfiguration presented as a class-wide integrity finding.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Testcontainers spin up Postgres + MinIO per file; vitest.config.ts raises
// the default testTimeout/hookTimeout to 180s workspace-wide so container
// startup under a loaded full-suite run doesn't look like a product failure.

import { withTestDb } from '../../../test/helpers/db.js';
import { withTestMinio } from '../../../test/helpers/minio.js';
import { putSubmissionBundle } from '../../../test/helpers/seed-bundle.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '@provenance/analysis-core/test-support/build-identity.js';
import type { IdentityTestKeys } from '@provenance/analysis-core/test-support/build-identity.js';
import {
  contributorOf,
  contributorsOf,
  attributedContributorsOf,
  isIdentityCheckFailure,
} from '@provenance/analysis-core/identity/resolve-contributors.js';
import type { SessionIdentity } from '@provenance/log-core';
import {
  courses,
  semesters,
  roster_entries,
  assignments,
  ingest_jobs,
  submissions,
  users,
} from '../../db/schema.js';
import type { DrizzleDb } from '../../db/client.js';
import type { StorageClient } from '../storage/client.js';
import { _resetConfigForTest, _setConfigForTest } from '../../config/index.js';
import { parseEnv } from '../../config/env.js';
import { loadSubmissionIndex, _resetBundleIndexCacheForTest } from './load-index.js';

const ALICE = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';
const BOB = '3a1d0e55-8c44-4b2a-a7f0-11c9d2e3f4a5';

// ---------------------------------------------------------------------------
// Deployment config
// ---------------------------------------------------------------------------

const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  PUBLIC_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/provenance',
  OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
  OBJECT_STORAGE_BUCKET: 'provenance',
  OBJECT_STORAGE_ACCESS_KEY_ID: 'minioadmin',
  OBJECT_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  GOOGLE_OAUTH_CLIENT_ID: 'client-id',
  GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
  AUTH_ALLOWED_HOSTED_DOMAINS: '["berkeley.edu"]',
  AUTH_SUPERADMIN_EMAILS: '["admin@berkeley.edu"]',
  AUTH_COOKIE_SIGNING_SECRET: 'test-signing-secret-for-contributor-tests-123456',
  SESSION_TTL_DAYS: '14',
};

/** Configure the deployment WITH a root public key. */
function setRootKey(hex: string): void {
  _resetConfigForTest();
  _setConfigForTest(parseEnv({ ...BASE_ENV, PROVENANCE_ROOT_PUBLIC_KEY_HEX: hex }));
}

/** Configure the deployment with NO root public key — a supported state. */
function setNoRootKey(): void {
  _resetConfigForTest();
  _setConfigForTest(parseEnv({ ...BASE_ENV, PROVENANCE_ROOT_PUBLIC_KEY_HEX: '' }));
}

beforeEach(() => {
  _resetBundleIndexCacheForTest();
  _resetConfigForTest();
});

afterEach(() => {
  _resetBundleIndexCacheForTest();
  _resetConfigForTest();
});

// ---------------------------------------------------------------------------
// Key material — deterministic, no randomness anywhere.
// ---------------------------------------------------------------------------

let aliceKeys: IdentityTestKeys | null = null;
let bobKeys: IdentityTestKeys | null = null;

async function keysFor(who: 'alice' | 'bob'): Promise<IdentityTestKeys> {
  if (who === 'alice') {
    // Default student seed.
    aliceKeys ??= await buildIdentityKeys();
    return aliceKeys;
  }
  // Same root + institution — one deployment — but a DIFFERENT student key, so
  // the two contributors are distinct all the way down, not just by ref string.
  bobKeys ??= await buildIdentityKeys({ studentSeedByte: 0x56 });
  return bobKeys;
}

// ---------------------------------------------------------------------------
// DB / storage seeding
// ---------------------------------------------------------------------------

async function seedSubmissionRow(db: DrizzleDb): Promise<string> {
  const uid = crypto.randomUUID().slice(0, 8);
  const [course] = await db
    .insert(courses)
    .values({ name: 'CS 61A', slug: `cs61a-contrib-${uid}` })
    .returning();
  const [semester] = await db
    .insert(semesters)
    .values({
      course_id: course!.id,
      term: 'fa',
      year: 2026,
      slug: `fa2026-contrib-${uid}`,
      display_name: 'Fall 2026',
      filename_convention: '{sid}_{assignment}.zip',
    })
    .returning();
  const [assignment] = await db
    .insert(assignments)
    .values({ semester_id: semester!.id, assignment_id_str: `hw-${uid}`, label: 'HW1' })
    .returning();
  const [student] = await db
    .insert(roster_entries)
    .values({ semester_id: semester!.id, sid: `303${uid}`, display_name: 'Ada Lovelace' })
    .returning();
  const userId = crypto.randomUUID();
  const [user] = await db
    .insert(users)
    .values({
      id: userId,
      google_subject: `sub-contrib-${userId}`,
      email: `staff-${userId}@berkeley.edu`,
      display_name: 'Staff',
    })
    .returning();
  const [job] = await db
    .insert(ingest_jobs)
    .values({ semester_id: semester!.id, uploaded_by: user!.id, status: 'succeeded' })
    .returning();

  const id = crypto.randomUUID();
  await db.insert(submissions).values({
    id,
    semester_id: semester!.id,
    assignment_id: assignment!.id,
    student_id: student!.id,
    blob_object_key: `semesters/${semester!.id}/submissions/${id}/bundle.zip`,
    blob_sha256: `sha256-${id}`,
    source_filename: 'test.zip',
    ingest_job_id: job!.id,
    version_index: 1,
    score_total: 0,
    score_max_severity: 'info',
    validation_status: 'pass',
  });
  return id;
}

type SessionSpec = {
  /** Omit for a session with NO identity block — the blameless, ordinary case. */
  identity?: SessionIdentity;
  sessionPubkeyHex: string;
};

/** Build a bundle with the given sessions and store it against a fresh submission. */
async function seedBundle(
  db: DrizzleDb,
  storage: StorageClient,
  specs: SessionSpec[],
): Promise<string> {
  const submissionId = await seedSubmissionRow(db);
  const { zipBuffer } = await buildTestBundle({
    sessions: specs.map((spec) => ({
      sessionStart: {
        session_pubkey: spec.sessionPubkeyHex,
        ...(spec.identity !== undefined ? { identity: spec.identity } : {}),
      },
    })),
  });
  await putSubmissionBundle(db, storage, submissionId, new Uint8Array(zipBuffer));
  return submissionId;
}

/** A distinct per-session ephemeral key — the real shape. */
const sessionKey = (i: number) => seededKeypair(0x60 + i);

// ---------------------------------------------------------------------------
// Attributed
// ---------------------------------------------------------------------------

describe('loadSubmissionIndex — attributed contributors', () => {
  it('resolves BOTH contributors of a two-contributor submission through the read path', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const alice = await keysFor('alice');
        const bob = await keysFor('bob');
        setRootKey(alice.root.pubkeyHex);

        const sk0 = await sessionKey(0);
        const sk1 = await sessionKey(1);
        const submissionId = await seedBundle(db, client, [
          {
            sessionPubkeyHex: sk0.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: alice,
              sessionPubkeyHex: sk0.pubkeyHex,
              studentRef: ALICE,
            }),
          },
          {
            sessionPubkeyHex: sk1.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: bob,
              sessionPubkeyHex: sk1.pubkeyHex,
              studentRef: BOB,
            }),
          },
        ]);

        const { bundle } = await loadSubmissionIndex(db, client, submissionId);

        // The stamp is present at all. This is the assertion that goes red if
        // the establishBundleContributors call is ever dropped.
        expect(bundle.contributors).toBeDefined();
        expect(bundle.contributors!.rootKeyConfigured).toBe(true);
        expect(bundle.contributors!.counts).toEqual({
          attributed: 2,
          unverifiable: 0,
          unattributed: 0,
        });

        const attributed = attributedContributorsOf(bundle);
        expect(attributed).toHaveLength(2);
        expect(attributed.map((c) => c.studentRef).sort()).toEqual([BOB, ALICE].sort());
        // Two contributors, not one collapsed pair.
        expect(new Set(attributed.map((c) => c.key)).size).toBe(2);

        // And the synchronous accessor every downstream consumer uses agrees.
        for (const session of bundle.sessions) {
          const verdict = contributorOf(bundle, session.sessionId);
          expect(verdict.kind).toBe('attributed');
        }
        const refs = bundle.sessions
          .map((s) => contributorOf(bundle, s.sessionId))
          .map((v) => (v.kind === 'attributed' ? v.studentRef : null));
        expect(refs.sort()).toEqual([BOB, ALICE].sort());
      });
    });
  });

  it('passes the DEPLOYMENT root key — a different root does not attribute', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const alice = await keysFor('alice');
        // A root key that is real, well-formed, and simply not the one that
        // signed this bundle's institution cert.
        const wrongRoot = await seededKeypair(0x12);
        setRootKey(wrongRoot.pubkeyHex);

        const sk0 = await sessionKey(0);
        const submissionId = await seedBundle(db, client, [
          {
            sessionPubkeyHex: sk0.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: alice,
              sessionPubkeyHex: sk0.pubkeyHex,
              studentRef: ALICE,
            }),
          },
        ]);

        const { bundle } = await loadSubmissionIndex(db, client, submissionId);
        const verdict = contributorOf(bundle, bundle.sessions[0]!.sessionId);

        expect(verdict.kind).toBe('unverifiable');
        if (verdict.kind !== 'unverifiable') throw new Error('unreachable');
        // Under the WRONG key the anchor is not root-signed. That IS a check
        // failure — we had a key, we checked, it did not verify.
        expect(verdict.reason.kind).toBe('anchor_not_root_signed');
        expect(isIdentityCheckFailure(verdict.reason)).toBe(true);
        // And it is never merged into the contributor it names.
        expect(verdict.contributorKey).not.toContain(ALICE);
        expect(attributedContributorsOf(bundle)).toHaveLength(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Unattributed — the blameless, ordinary state
// ---------------------------------------------------------------------------

describe('loadSubmissionIndex — a bundle with no identity is blameless', () => {
  it('reads unattributed end to end, with nothing that could render as suspicious', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const alice = await keysFor('alice');
        setRootKey(alice.root.pubkeyHex);

        const sk0 = await sessionKey(0);
        const sk1 = await sessionKey(1);
        const submissionId = await seedBundle(db, client, [
          { sessionPubkeyHex: sk0.pubkeyHex },
          { sessionPubkeyHex: sk1.pubkeyHex },
        ]);

        const { bundle, index } = await loadSubmissionIndex(db, client, submissionId);

        // It still loads and still analyses — the submission is served normally.
        expect(index.ordered.length).toBeGreaterThan(0);

        expect(bundle.contributors!.counts).toEqual({
          attributed: 0,
          unverifiable: 0,
          unattributed: 2,
        });

        for (const session of bundle.sessions) {
          const verdict = contributorOf(bundle, session.sessionId);
          expect(verdict.kind).toBe('unattributed');
          if (verdict.kind !== 'unattributed') throw new Error('unreachable');
          // Nothing here is a claim, a reason, or a name. An absent identity
          // block is a student who never enrolled, not an allegation.
          expect(verdict).not.toHaveProperty('reason');
          expect(verdict).not.toHaveProperty('claimedStudentRef');
          expect(verdict.contributorKey).toBe(`unattributed:${session.sessionId}`);
        }

        // Two unattributed sessions are NEVER grouped: two unenrolled people are
        // indistinguishable from one person recording twice, and asserting
        // either way fabricates a relationship.
        const all = contributorsOf(bundle);
        expect(all).toHaveLength(2);
        expect(all.every((c) => c.kind === 'unattributed')).toBe(true);
        expect(all.every((c) => c.studentRef === null)).toBe(true);
        expect(attributedContributorsOf(bundle)).toHaveLength(0);
        // And above all: absence of identity is never promoted to unverifiable.
        expect(bundle.contributors!.counts.unverifiable).toBe(0);
      });
    });
  });
});

// ---------------------------------------------------------------------------
// No root key — a supported deployment state
// ---------------------------------------------------------------------------

describe('loadSubmissionIndex — a deployment with no root public key', () => {
  it('still serves the submission, reporting no_root_key rather than a check failure', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const alice = await keysFor('alice');
        setNoRootKey();

        const sk0 = await sessionKey(0);
        const submissionId = await seedBundle(db, client, [
          {
            sessionPubkeyHex: sk0.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: alice,
              sessionPubkeyHex: sk0.pubkeyHex,
              studentRef: ALICE,
            }),
          },
        ]);

        // Analysis must NOT depend on key configuration.
        const { bundle, index } = await loadSubmissionIndex(db, client, submissionId);
        expect(index.ordered.length).toBeGreaterThan(0);

        expect(bundle.contributors!.rootKeyConfigured).toBe(false);
        const verdict = contributorOf(bundle, bundle.sessions[0]!.sessionId);
        expect(verdict.kind).toBe('unverifiable');
        if (verdict.kind !== 'unverifiable') throw new Error('unreachable');
        expect(verdict.reason.kind).toBe('no_root_key');

        // THE assertion. "We could not check" must never be reported as "we
        // checked and it failed" — that would turn an unset env var into a
        // class-wide integrity finding against innocent students.
        expect(isIdentityCheckFailure(verdict.reason)).toBe(false);
      });
    });
  });

  it('does not turn a session with NO identity block into unverifiable', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        setNoRootKey();
        const sk0 = await sessionKey(0);
        const submissionId = await seedBundle(db, client, [{ sessionPubkeyHex: sk0.pubkeyHex }]);

        const { bundle } = await loadSubmissionIndex(db, client, submissionId);
        expect(bundle.contributors!.counts).toEqual({
          attributed: 0,
          unverifiable: 0,
          unattributed: 1,
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// The LRU cache
// ---------------------------------------------------------------------------

describe('loadSubmissionIndex — the contributor stamp and the LRU cache', () => {
  it('returns a correctly-stamped bundle on a cache hit', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const alice = await keysFor('alice');
        setRootKey(alice.root.pubkeyHex);

        const sk0 = await sessionKey(0);
        const submissionId = await seedBundle(db, client, [
          {
            sessionPubkeyHex: sk0.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: alice,
              sessionPubkeyHex: sk0.pubkeyHex,
              studentRef: ALICE,
            }),
          },
        ]);

        const first = await loadSubmissionIndex(db, client, submissionId);
        const second = await loadSubmissionIndex(db, client, submissionId);

        // Same cached parse — the stamp rides along with it rather than being
        // recomputed per read.
        expect(second.bundle).toBe(first.bundle);
        expect(second.bundle.contributors).toBe(first.bundle.contributors);

        const verdict = contributorOf(second.bundle, second.bundle.sessions[0]!.sessionId);
        expect(verdict.kind).toBe('attributed');
        if (verdict.kind !== 'attributed') throw new Error('unreachable');
        expect(verdict.studentRef).toBe(ALICE);
      });
    });
  });

  it('never hands one submission the contributor stamp of another', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const alice = await keysFor('alice');
        const bob = await keysFor('bob');
        setRootKey(alice.root.pubkeyHex);

        const sk0 = await sessionKey(0);
        const sk1 = await sessionKey(1);
        const aliceSubmission = await seedBundle(db, client, [
          {
            sessionPubkeyHex: sk0.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: alice,
              sessionPubkeyHex: sk0.pubkeyHex,
              studentRef: ALICE,
            }),
          },
        ]);
        const bobSubmission = await seedBundle(db, client, [
          {
            sessionPubkeyHex: sk1.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: bob,
              sessionPubkeyHex: sk1.pubkeyHex,
              studentRef: BOB,
            }),
          },
        ]);

        const a1 = await loadSubmissionIndex(db, client, aliceSubmission);
        const b1 = await loadSubmissionIndex(db, client, bobSubmission);
        // Re-read Alice AFTER Bob, so a stamp shared through the cache would
        // show up here as Alice reading BOB.
        const a2 = await loadSubmissionIndex(db, client, aliceSubmission);

        const refOf = (r: Awaited<ReturnType<typeof loadSubmissionIndex>>): string | null => {
          const v = contributorOf(r.bundle, r.bundle.sessions[0]!.sessionId);
          return v.kind === 'attributed' ? v.studentRef : null;
        };

        expect(refOf(a1)).toBe(ALICE);
        expect(refOf(b1)).toBe(BOB);
        expect(refOf(a2)).toBe(ALICE);
        // Distinct stamp objects, not one shared map.
        expect(a1.bundle.contributors).not.toBe(b1.bundle.contributors);
      });
    });
  });

  it('re-stamps after the cache is reset, so a cold read is not left unattributed', async () => {
    await withTestMinio(async ({ client }) => {
      await withTestDb(async (db) => {
        const alice = await keysFor('alice');
        setRootKey(alice.root.pubkeyHex);

        const sk0 = await sessionKey(0);
        const submissionId = await seedBundle(db, client, [
          {
            sessionPubkeyHex: sk0.pubkeyHex,
            identity: await buildInstitutionIdentity({
              keys: alice,
              sessionPubkeyHex: sk0.pubkeyHex,
              studentRef: ALICE,
            }),
          },
        ]);

        const warm = await loadSubmissionIndex(db, client, submissionId);
        _resetBundleIndexCacheForTest();
        const cold = await loadSubmissionIndex(db, client, submissionId);

        expect(cold.bundle).not.toBe(warm.bundle);
        const verdict = contributorOf(cold.bundle, cold.bundle.sessions[0]!.sessionId);
        expect(verdict.kind).toBe('attributed');
        if (verdict.kind !== 'attributed') throw new Error('unreachable');
        expect(verdict.studentRef).toBe(ALICE);
      });
    });
  });
});
