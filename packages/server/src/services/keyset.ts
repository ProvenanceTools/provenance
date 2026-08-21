/**
 * Microsecond-precision keyset (cursor) pagination over `timestamptz` columns.
 *
 * ## The bug this exists to prevent
 *
 * Postgres stores `timestamptz` at **microsecond** precision. Drizzle's
 * `timestamp(...)` defaults to `mode: 'date'`, which hands back a JS `Date` —
 * **millisecond** precision. So reading a row's timestamp through the ORM
 * destroys its microseconds *before* a cursor is ever encoded, and a cursor
 * minted from `row.created_at.toISOString()` cannot express the true position
 * of the last row on the page.
 *
 * Every hand-rolled predicate written against such a cursor therefore has to
 * fall back to the id tiebreak for the whole millisecond bucket — and the id is
 * a random `gen_random_uuid()`, which contradicts the true microsecond ordering
 * the query ORDERs BY. Same-bucket rows then fall through both branches and are
 * **dropped**, or satisfy both and are **duplicated**. Neither shows up as a
 * short page: `next_cursor` reports success either way. This is silent data
 * loss on a read path, and rows sharing a millisecond is the *normal* case
 * wherever a batch is written in one go (ingest, `recompute_cross_flags`).
 *
 * ## The fix
 *
 * Read the timestamp as a **string** that preserves microseconds (never as a
 * `Date`), put that in the cursor, and compare with a Postgres **row-value
 * comparison** — `(ts, id) < (cursor_ts, cursor_id)` for DESC, `>` for ASC.
 * That is exactly the total keyset order, so the hand-rolled bucket branches
 * disappear rather than being patched.
 *
 * ## Index behaviour — measured, not assumed
 *
 * A row-value comparison is a *range* condition on a matching btree index, so
 * it is pushed down as an `Index Cond`. The old OR-of-AND form could not be,
 * and degraded to a `Filter`. Measured on Postgres 16, 200k rows, index
 * `(semester_id, created_at DESC, id DESC)`, `LIMIT 51`:
 *
 *   row-value:  Index Only Scan, Index Cond, 10 buffers,   0.054 ms
 *   old OR:     Index Only Scan, Filter,   1016 buffers,   3.003 ms
 *                                          (10 000 rows removed by filter)
 *
 * So this change strictly *improves* index usage; it cannot force a sequential
 * scan that the previous form avoided. (Separately, and pre-existing: none of
 * `cross_flags`, `submissions`, or `ingest_files` currently carries an index on
 * its timestamp keyset, so all three plans are a sort over a scan today. That
 * needs a migration and is deliberately out of scope here — but the row-value
 * form is the one that would benefit from such an index.)
 *
 * ## Cursor compatibility
 *
 * A cursor minted before this change carries a millisecond-precision timestamp.
 * It is **rejected** rather than reinterpreted: treating it as a bucket floor
 * would silently drop the remainder of its millisecond, which is the exact
 * failure being fixed. Callers get a 400 and recover by restarting pagination.
 * Every cursor payload therefore carries an explicit version tag, and the
 * timestamp is additionally shape-checked so a ms-precision value can never be
 * mistaken for a µs one.
 */

import { sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Cursor payload version. Bumped from "absent" when timestamps gained
 * microsecond precision. A payload without it is a pre-fix cursor.
 */
export const KEYSET_CURSOR_VERSION = 2;

/**
 * ISO-8601 UTC with exactly six fractional digits — the shape
 * {@link microTimestamp} emits, e.g. `2026-08-20T12:00:00.500123Z`.
 *
 * Exactly six digits is what separates a new cursor from an old one: a
 * `Date.toISOString()` value has three.
 */
const MICRO_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/**
 * True when `value` is a microsecond-precision UTC ISO timestamp.
 *
 * Used to validate a decoded cursor. Deliberately strict: a three-digit
 * fractional part is a legacy cursor and must be refused, not zero-extended.
 */
export function isMicroTimestamp(value: string): boolean {
  return MICRO_ISO_RE.test(value);
}

/**
 * Projects a `timestamptz` column as a microsecond-precision UTC ISO string.
 *
 * `to_char` with an explicit numeric pattern rather than `::text`: the latter
 * depends on the session's `DateStyle`/`TimeZone` and trims trailing zeros from
 * the fractional part, so its width is not fixed and {@link isMicroTimestamp}
 * could not vet it.
 *
 * Select this **alongside** the `Date`-typed column, not instead of it — the
 * `Date` still feeds the API response field; only the cursor needs the extra
 * precision. This is a read-path projection: nothing about what is stored
 * changes.
 */
export function microTimestamp(column: PgColumn): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/**
 * The keyset predicate selecting exactly the rows that follow the cursor row in
 * `ORDER BY (tsColumn, idColumn)` — descending for `'desc'`, ascending for
 * `'asc'`.
 *
 * A single Postgres row-value comparison, which is precisely lexicographic
 * `(ts, id)` order and therefore agrees with the ORDER BY by construction. No
 * bucket branches, so there is no bucket to get wrong.
 *
 * `cursorTs` must be a microsecond-precision string (see
 * {@link isMicroTimestamp}); callers validate at decode time. Both columns must
 * be `NOT NULL` — a row comparison against NULL yields NULL, which would
 * silently exclude the row. All three call sites satisfy this.
 */
export function keysetAfter(
  tsColumn: PgColumn,
  idColumn: PgColumn,
  cursorTs: string,
  cursorId: string,
  direction: 'asc' | 'desc',
): SQL {
  return direction === 'desc'
    ? sql`(${tsColumn}, ${idColumn}) < (${cursorTs}::timestamptz, ${cursorId}::uuid)`
    : sql`(${tsColumn}, ${idColumn}) > (${cursorTs}::timestamptz, ${cursorId}::uuid)`;
}
