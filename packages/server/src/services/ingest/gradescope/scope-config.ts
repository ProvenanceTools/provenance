/**
 * Load the per-assignment scope-resolution config (program architecture §6)
 * that the git-repo scope adapter consults.
 *
 * A discovered `.provenance/` already declares its own `assignment_id`, so the
 * config is keyed by that declared id — not by a path the operator has to know
 * up front. `assignments.ingest_scope` exists only to settle what
 * self-identification cannot: two directories declaring the same id, or a stale
 * vendored copy.
 *
 * Semester-wide rather than per-assignment lookup: an export is streamed one
 * folder at a time and each folder can declare a different assignment, so the
 * whole semester's map is read once (a handful of rows) instead of issuing a
 * query per discovered scope.
 */

import { eq } from 'drizzle-orm';
import { assignments } from '../../../db/schema.js';
import type { DrizzleDb } from '../../../db/client.js';
import {
  parseIngestScopeConfig,
  DEFAULT_INGEST_SCOPE,
  type IngestScopeConfig,
  type IngestScopeConfigResolver,
} from './repo-scopes.js';

/**
 * Read every assignment's `ingest_scope` for one semester, keyed by
 * `assignment_id_str`. Malformed values degrade to the default (see
 * `parseIngestScopeConfig`) rather than failing the ingest.
 */
export async function loadIngestScopeConfigs(
  db: DrizzleDb,
  semesterId: string,
): Promise<Map<string, IngestScopeConfig>> {
  const rows = await db
    .select({
      assignment_id_str: assignments.assignment_id_str,
      ingest_scope: assignments.ingest_scope,
    })
    .from(assignments)
    .where(eq(assignments.semester_id, semesterId));

  const byAssignmentId = new Map<string, IngestScopeConfig>();
  for (const row of rows) {
    byAssignmentId.set(row.assignment_id_str, parseIngestScopeConfig(row.ingest_scope));
  }
  return byAssignmentId;
}

/**
 * Turn the map into the resolver the adapter takes. An assignment that has no
 * row yet — the common case, since the row is created by `createSubmission`
 * downstream — gets the default: accept the scope wherever it sits.
 */
export function scopeConfigResolver(
  byAssignmentId: Map<string, IngestScopeConfig>,
): IngestScopeConfigResolver {
  return (assignmentId) =>
    (assignmentId === null ? undefined : byAssignmentId.get(assignmentId)) ?? DEFAULT_INGEST_SCOPE;
}
