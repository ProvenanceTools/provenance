/**
 * Testcontainers harness for database integration tests.
 *
 * Usage:
 *   import { withTestDb } from '../../test/helpers/db.js';
 *
 *   it('can insert a user', async () => {
 *     await withTestDb(async (db) => {
 *       // db is a fully-migrated Drizzle instance
 *     });
 *   });
 *
 * Requirements:
 * - Docker must be running (testcontainers spawns a Postgres 16 container).
 * - Each `withTestDb` call gets its own isolated database container, so tests
 *   are fully independent without manual cleanup between runs.
 *
 * The harness guarantees container teardown even if `fn` throws.
 */

import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as schema from '../../src/db/schema.js';
import type { DrizzleDb } from '../../src/db/client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file is at packages/server/test/helpers/db.ts.
// Migrations are at packages/server/db/migrations/.
const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

/**
 * Spawns a Postgres 16 container, runs all migrations, then calls `fn` with a
 * bound Drizzle instance. Tears down the container when done, even on error.
 *
 * Isolation level: per-call (one container per `withTestDb` invocation).
 */
export async function withTestDb(fn: (db: DrizzleDb) => Promise<void>): Promise<void> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('provenance_test')
    .withUsername('test')
    .withPassword('test')
    // testcontainers waits for the container's ports to bind on its OWN 10s
    // timer, which is independent of vitest's testTimeout — raising that alone
    // leaves this failing as `Timed out after 10000ms while waiting for
    // container ports to be bound to the host`. On a machine already running
    // other suites, Docker routinely needs longer than 10s to publish a port.
    .withStartupTimeout(120_000)
    .start();

  const connectionString = container.getConnectionUri();
  // Use max:1 to keep test connections predictable.
  const sql = postgres(connectionString, { max: 1 });

  try {
    const db = drizzle(sql, { schema }) as DrizzleDb;
    await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    await fn(db);
  } finally {
    // Always close pool and stop container, even if fn() threw.
    await sql.end();
    await container.stop();
  }
}
