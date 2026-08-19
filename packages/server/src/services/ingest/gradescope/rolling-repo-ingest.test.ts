/**
 * End-to-end idempotency for the GIT-NATIVE ingest path (program spec §3, §6, §8).
 *
 * Ingests the SAME rolling-sealed repo twice, through the real stages in the
 * fixed pipeline order — parse → (match, stubbed by seeding) → heuristics →
 * stats — and asserts the two runs produce identical flags and identical stats.
 * That is the contract CLAUDE.md pins on ingest: "stages are ordered and
 * idempotent; a retry must produce the same flags and stats".
 *
 * There is deliberately no event-materialization stage here, and nothing writes
 * events to Postgres: the `.slog` logs inside the bundle remain the only source
 * of the event stream.
 *
 * Uses testcontainers (ephemeral Postgres) via withTestDb.
 */

import { vi, describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import JSZip from 'jszip';
import { eq } from 'drizzle-orm';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { loadBundle } from '@provenance/analysis-core/loader/parse-bundle.js';
import { runValidation } from '@provenance/analysis-core/validation/run-validation.js';
import { withTestDb } from '../../../../test/helpers/db.js';
import { seedSubmission } from '../../../../test/helpers/seed-submission.js';
import { runAndStoreHeuristics } from '../../heuristics/run-per-submission.js';
import { computeAndStoreStats } from '../stats.js';
import { stripBundleSourceFiles } from '../strip-bundle.js';
import { flags, per_file_stats, submissions } from '../../../db/schema.js';
import { discoverRepoScopes } from './repo-scopes.js';
import { zipBundleEntries } from './build-bundle-zip.js';
import type { DrizzleDb } from '../../../db/client.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
    Promise.resolve(sha512(m));
});

const PROVENANCE_FILE =
  /^(manifest\.json|manifest\.sig|manifest-[0-9a-f-]+\.(json|sig)|session-.*\.slog(\.meta)?)$/;

/** A one-scope git repo whose `.provenance/` carries ONLY a rolling seal. */
async function buildRollingRepo(): Promise<Map<string, Uint8Array>> {
  const { zipBuffer } = await buildTestBundle({
    assignmentId: 'proj2',
    semester: 'fa2026',
    rollingSeal: {},
    sessions: [{ eventCount: 6 }, { eventCount: 6 }],
    submissionFiles: [{ path: 'Gitlet.java', status: 'present', content: 'class Gitlet {}\n' }],
  });

  const files = new Map<string, Uint8Array>();
  const inner = await JSZip.loadAsync(zipBuffer);
  for (const [name, obj] of Object.entries(inner.files)) {
    if (obj.dir) continue;
    const bytes = await obj.async('uint8array');
    files.set(PROVENANCE_FILE.test(name) ? `proj2/.provenance/${name}` : `proj2/${name}`, bytes);
  }
  files.set('README.md', new TextEncoder().encode('# repo\n'));
  return files;
}

/** Discover the single scope and rebuild its flat bundle ZIP. */
async function scopeBundleZip(files: Map<string, Uint8Array>): Promise<ArrayBuffer> {
  const discovered = discoverRepoScopes(files);
  if (!discovered.ok) throw new Error(`discovery failed: ${discovered.reason}`);
  if (discovered.scopes.length !== 1) {
    throw new Error(`expected 1 scope, got ${discovered.scopes.length}`);
  }
  return zipBundleEntries(discovered.scopes[0]!.entries);
}

/** One full ingest of a bundle ZIP into a fresh submission row. */
async function ingestOnce(db: DrizzleDb, zip: ArrayBuffer): Promise<string> {
  const submissionId = await seedSubmission(db);
  const semesterRows = await db
    .select({ semester_id: submissions.semester_id })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  const semesterId = semesterRows[0]!.semester_id;

  // parse
  const loaded = await loadBundle(zip, 'proj2.zip');
  if (!loaded.ok) throw new Error(`loadBundle failed: ${JSON.stringify(loaded.error)}`);
  const bundle = loaded.value;

  // validation → heuristics → stats, in pipeline order.
  const report = await runValidation(bundle);
  await runAndStoreHeuristics(db, submissionId, semesterId, bundle, report);
  await computeAndStoreStats(db, submissionId, bundle);

  return submissionId;
}

/** The flag fields that must be reproducible across a retry. */
async function flagFingerprint(db: DrizzleDb, submissionId: string) {
  const rows = await db.select().from(flags).where(eq(flags.submission_id, submissionId));
  return rows
    .map((r) => ({
      heuristic_id: r.heuristic_id,
      severity: r.severity,
      confidence: r.confidence,
      weight_at_compute: r.weight_at_compute,
      score_contribution: r.score_contribution,
      supporting_seqs: r.supporting_seqs,
      session_id: r.session_id,
    }))
    .sort((a, b) =>
      a.heuristic_id === b.heuristic_id
        ? a.session_id.localeCompare(b.session_id)
        : a.heuristic_id.localeCompare(b.heuristic_id),
    );
}

async function statsFingerprint(db: DrizzleDb, submissionId: string) {
  const sub = await db
    .select({
      total_active_ms: submissions.total_active_ms,
      total_idle_ms: submissions.total_idle_ms,
      score_total: submissions.score_total,
      score_max_severity: submissions.score_max_severity,
    })
    .from(submissions)
    .where(eq(submissions.id, submissionId));
  const perFile = await db
    .select()
    .from(per_file_stats)
    .where(eq(per_file_stats.submission_id, submissionId));
  return {
    submission: sub[0]!,
    perFile: perFile
      .map((r) => ({
        file_path: r.file_path,
        chars_typed: r.chars_typed,
        chars_pasted: r.chars_pasted,
        chars_external_change_delta: r.chars_external_change_delta,
        saves: r.saves,
        final_length: r.final_length,
        start_length: r.start_length,
        reconstruction_tainted: r.reconstruction_tainted,
      }))
      .sort((a, b) => a.file_path.localeCompare(b.file_path)),
  };
}

describe('git-native ingest of a rolling-sealed repo', () => {
  it('produces identical flags and stats when the same repo is ingested twice', async () => {
    const files = await buildRollingRepo();
    const zipA = await scopeBundleZip(files);
    const zipB = await scopeBundleZip(files);

    // The rebuilt archive is byte-identical, so the ingest dedup key is stable.
    expect(new Uint8Array(zipB)).toEqual(new Uint8Array(zipA));

    await withTestDb(async (db) => {
      const first = await ingestOnce(db, zipA);
      const second = await ingestOnce(db, zipB);

      const flagsFirst = await flagFingerprint(db, first);
      const flagsSecond = await flagFingerprint(db, second);
      // Guard against a vacuous pass: the suite must actually raise flags.
      expect(flagsFirst.length).toBeGreaterThan(0);
      expect(flagsSecond).toEqual(flagsFirst);

      const statsFirst = await statsFingerprint(db, first);
      const statsSecond = await statsFingerprint(db, second);
      // Guard against a vacuous pass: per-file stats must actually be written.
      expect(statsFirst.perFile.length).toBeGreaterThan(0);
      expect(statsSecond).toEqual(statsFirst);
    });
  });

  it('the stored (stripped) bundle of a git submission still validates', async () => {
    const files = await buildRollingRepo();
    const zip = await scopeBundleZip(files);

    // What createSubmission stores: provenance-only.
    const stored = await stripBundleSourceFiles(new Uint8Array(zip));
    const loaded = await loadBundle(stored.buffer as ArrayBuffer, 'stored.zip');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // The signed manifest is never modified, so it still DECLARES the file —
    // but the student's bytes are gone from the stored blob.
    const entry = loaded.value.submissionFiles.get('Gitlet.java');
    expect(entry).toBeDefined();
    expect(entry!.bytes).toBeUndefined();
    const report = await runValidation(loaded.value);
    expect(report.checks.find((c) => c.id === 'manifest_sig')?.status).toBe('pass');
    expect(report.checks.find((c) => c.id === 'chain_integrity')?.status).toBe('pass');
  });
});
