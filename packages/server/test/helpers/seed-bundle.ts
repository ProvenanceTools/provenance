/**
 * Test helper: store a bundle blob for an already-seeded submission.
 *
 * Since events are no longer persisted in Postgres, tests that exercise any read
 * path (events API, replay/reconstruction, recompute, cross-flags, summary,
 * stats, Source tab) must put the submission's bundle blob in object storage so
 * the service can re-parse it via loadSubmissionIndex.
 *
 * Usage:
 *   await withTestRustfs(async ({ client }) => {
 *     await withTestDb(async (db) => {
 *       const submissionId = await seedSubmission(db);
 *       const { blob } = await buildTestBundle({ events: [...] });
 *       await putSubmissionBundle(db, client, submissionId, new Uint8Array(await blob.arrayBuffer()));
 *       // ...call the service with `client` as the storage arg...
 *     });
 *   });
 */

import { eq } from 'drizzle-orm';
import { putBlob } from '../../src/services/storage/blobs.js';
import type { StorageClient } from '../../src/services/storage/client.js';
import { submissions } from '../../src/db/schema.js';
import type { DrizzleDb } from '../../src/db/client.js';

/**
 * Put `bundleBytes` at the submission's `blob_object_key` and update its
 * `blob_sha256` to the stored object's real digest. Returns the sha256.
 */
export async function putSubmissionBundle(
  db: DrizzleDb,
  storage: StorageClient,
  submissionId: string,
  bundleBytes: Uint8Array,
): Promise<string> {
  const [sub] = await db
    .select({ key: submissions.blob_object_key })
    .from(submissions)
    .where(eq(submissions.id, submissionId))
    .limit(1);
  if (sub === undefined)
    throw new Error(`putSubmissionBundle: submission not found: ${submissionId}`);

  const { sha256 } = await putBlob(storage, sub.key, bundleBytes);
  await db.update(submissions).set({ blob_sha256: sha256 }).where(eq(submissions.id, submissionId));
  return sha256;
}
