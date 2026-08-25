/**
 * Startup chain recovery.
 *
 * PRD §4.8: on extension crash → new session, link via prev_session_id.
 * PRD §4.8: on corrupted log → quarantine, new session, emit recovered_from_corruption.
 * PRD §4.6: on startup, validate existing chain.
 *
 * WHICH `.slog` we are allowed to look at, link to, or quarantine is decided
 * entirely by `slog-ownership.ts` — `.provenance/` is committed and shared with a
 * partner, so most of the subtlety lives there. Read that module first. This file
 * only turns the selected file into one of three decisions:
 *
 * Decision — prev_session_id linkage:
 *   We only set prev_session_id on the dangling case (crash, no session.end).
 *   For a completed session (last entry is session.end) the prior session ended cleanly;
 *   linking to it adds no information and clutters the analyzer's session graph.
 *   This matches PRD §4.8: "On reload, we open a new session, link it to the previous
 *   via the prev_session_id field" — "reload" implies a crash, not a clean close.
 *
 * Decision — corruption surfacing:
 *   When the prior chain fails to validate, we DO NOT emit a `chain.broken` event into
 *   the new session. We quarantine the corrupt file (renamed to `<slog>.corrupt-<ISO>`)
 *   and emit `recorder.recovered_from_corruption` with the quarantined path; the analyzer
 *   inspects the quarantined file directly. PRD §4.6 documents this as the canonical
 *   behavior. `chain.broken` remains in the event type system but is reserved for any
 *   future case where the live session detects its own chain breaking mid-stream.
 *
 *   NOT FIXED HERE, deliberately: `prev_session_id` is still set only on the dangling
 *   path, so removing a cleanly-ended session is still undetectable by program spec §7
 *   mechanism 1. Spec §3 S9 calls that "a real hole and it predates this program", but
 *   Tier 0.2 scopes this change to ownership, and linking on clean end reverses a
 *   documented product decision (see "Decision — prev_session_id linkage" above) and
 *   changes the analyzer's session graph for solo students too. That is a product call,
 *   not a coding one.
 */

import { parseEntries, validateChain } from '@provenance/log-core';
import { selectEligible } from './slog-ownership.js';
import type { ReadSlogFile } from './slog-ownership.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecoveryDecision =
  | { kind: 'clean_start' }
  | { kind: 'previous_session_complete'; prevSessionId: string }
  | { kind: 'previous_session_dangling'; prevSessionId: string; danglingPath: string }
  | { kind: 'previous_session_corrupt'; quarantinedPath: string };

export type RecoveryDeps = {
  provenanceDir: string;
  /** Read a .slog file; returns its text or an error indication. */
  readSlogFile: ReadSlogFile;
  /** Rename a file (used for quarantine). */
  rename: (from: string, to: string) => Promise<void>;
  /** List all .slog files in the directory (filenames only, not full paths). */
  listSlogFiles: (dir: string) => Promise<string[]>;
  /** Returns current Date (for quarantine timestamp). */
  now: () => Date;
  /**
   * `identity.enrollment.student_ref` of the session that is STARTING, or null
   * when this recorder holds no verifying enrollment for this course.
   *
   * This is the whole ownership signal — see `slog-ownership.ts`.
   * Optional, and absent means null, so callers and tests that predate the
   * enrollment work keep exactly the behaviour they had.
   */
  ownStudentRef?: string | null;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Move a damaged `.slog` aside so the new session starts on a clean directory.
 *
 * The ONE destructive act in recovery, and therefore the one call site: it may
 * only ever run on a path `selectEligible` handed back, never on a file that
 * belongs to another contributor.
 */
async function quarantine(
  slogPath: string,
  rename: RecoveryDeps['rename'],
  now: RecoveryDeps['now'],
): Promise<Extract<RecoveryDecision, { kind: 'previous_session_corrupt' }>> {
  const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
  await rename(slogPath, quarantinedPath);
  return { kind: 'previous_session_corrupt', quarantinedPath };
}

/**
 * Inspect the provenanceDir for a previous session and return a recovery decision.
 *
 * Side effects:
 *   - If the chain is invalid: renames the slog to <slog>.corrupt-<ISO> (quarantine)
 *     — but ONLY for a `.slog` this recorder is entitled to touch. A file belonging
 *     to another contributor is never read past its first line, never selected,
 *     never linked, and never renamed. See `slog-ownership.ts`.
 *
 * Returns RecoveryDecision — callers decide what to do (e.g. set prev_session_id).
 */
export async function recoverPreviousSession(deps: RecoveryDeps): Promise<RecoveryDecision> {
  const { provenanceDir, readSlogFile, rename, listSlogFiles, now } = deps;
  const ownStudentRef = deps.ownStudentRef ?? null;

  // List all .slog files.
  const filenames = await listSlogFiles(provenanceDir);
  const slogFiles = filenames.filter((f) => f.endsWith('.slog')).sort();

  if (slogFiles.length === 0) {
    return { kind: 'clean_start' };
  }

  // Most recent ELIGIBLE session by session.start wall — see `slog-ownership.ts`.
  // A partner's `.slog` never reaches this point.
  const { best: selected, eligibleFallback } = await selectEligible(
    slogFiles,
    provenanceDir,
    readSlogFile,
    ownStudentRef,
  );

  // No eligible file yielded a parseable session.start: fall back to the
  // alphabetically last ELIGIBLE one so the corrupt/quarantine path below still
  // runs on something we are entitled to touch. When nothing is eligible — the
  // whole directory belongs to other contributors — we start clean and leave
  // every one of their files exactly where it is.
  const chosen = selected?.filename ?? eligibleFallback;
  if (chosen === null || chosen === undefined) {
    return { kind: 'clean_start' };
  }

  const slogPath = `${provenanceDir}/${chosen}`;
  // Reuse the text from selection when we have it; only re-read on the fallback.
  const readResult: Awaited<ReturnType<RecoveryDeps['readSlogFile']>> =
    selected !== null ? { ok: true, text: selected.text } : await readSlogFile(slogPath);

  // Can't read the file at all — treat as corrupt.
  if (!readResult.ok) {
    return quarantine(slogPath, rename, now);
  }

  // Parse the entries.
  const parseResult = parseEntries(readResult.text);
  if (!parseResult.ok) {
    return quarantine(slogPath, rename, now);
  }

  const entries = parseResult.value;

  // Validate the chain.
  const chainResult = validateChain(entries);
  if (!chainResult.ok) {
    return quarantine(slogPath, rename, now);
  }

  // Chain is valid — extract session_id from the first entry (session.start, seq 0).
  const firstEntry = entries[0];
  if (firstEntry === undefined || firstEntry.kind !== 'session.start') {
    // No session.start — malformed; quarantine.
    return quarantine(slogPath, rename, now);
  }

  const data = firstEntry.data as Record<string, unknown>;
  const prevSessionId = typeof data['session_id'] === 'string' ? data['session_id'] : null;

  if (prevSessionId === null) {
    // session.start data doesn't have a session_id — malformed; quarantine.
    return quarantine(slogPath, rename, now);
  }

  // Determine if the session ended cleanly.
  const lastEntry = entries[entries.length - 1];
  const isComplete = lastEntry !== undefined && lastEntry.kind === 'session.end';

  if (isComplete) {
    return { kind: 'previous_session_complete', prevSessionId };
  } else {
    // Dangling — extension crashed without emitting session.end.
    return { kind: 'previous_session_dangling', prevSessionId, danglingPath: slogPath };
  }
}
