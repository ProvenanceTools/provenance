/**
 * Startup chain recovery.
 *
 * PRD §4.8: on extension crash → new session, link via prev_session_id.
 * PRD §4.8: on corrupted log → quarantine, new session, emit recovered_from_corruption.
 * PRD §4.6: on startup, validate existing chain.
 *
 * Decision — multiple .slog files / choosing the previous session:
 *   When multiple .slog files exist in provenanceDir we take the one whose
 *   `session.start` carries the latest wall clock — i.e. the genuinely most
 *   recent session.
 *
 *   This used to take the alphabetically last filename, on the reasoning that
 *   "session UUIDs sort in approximate creation order because they embed a
 *   timestamp-influenced prefix in practice." That is not true: these are
 *   UUIDv4 from node:crypto.randomUUID — 122 random bits, no timestamp. Worse,
 *   the filename UUID is a *different* random UUID from the session's own
 *   session_id (see `session-${randomUUID()}.slog` in session-registry.ts), so
 *   filename order carries no information about session order at all.
 *
 *   The observed effect on a real 10-session bundle: six consecutive sessions
 *   all reported the same `prev_session_id`, because one file happened to sort
 *   last and kept winning — including for sessions whose actual predecessor was
 *   a different dangling session. That makes prev_session_id actively
 *   misleading in the analyzer's session graph.
 *
 *   Cost: this reads each .slog once to extract its session.start wall (only
 *   the first line is parsed). provenanceDir holds one file per session for a
 *   single assignment, so the count stays modest. mtime-based ordering would
 *   avoid the reads but needs stat() plumbed through the deps and is falsifiable
 *   by a touch; the recorded wall is the value we actually care about.
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
 * Decision — OWNERSHIP. `.provenance/` is not necessarily ours.
 *   (git-collaboration spec §2 A4, §3 S9/S19/S22; worklist Tier 0.1 + 0.2.)
 *
 *   In CS 61B/61C two partners share one git repo, so both recorders write into the
 *   SAME committed `.provenance/` directory. Everything above was written under the
 *   assumption that every `.slog` in that directory is ours. It is not, and the two
 *   consequences were live defects:
 *
 *     1. The most-recent `.slog` — very possibly the PARTNER'S, because a partner
 *        whose editor is open right now has no `session.end` and a fresh clone has
 *        no local memory — was RENAMED to `<slog>.corrupt-<ISO>` whenever it failed
 *        to read, parse, or validate. `sealBundle` excludes `.corrupt-` files, so
 *        that rename removes the partner's evidence from the submission entirely.
 *        Because `.provenance/` is committed, git history shows the INNOCENT
 *        student performing the deletion. It is also a free attack: flip one byte
 *        of your partner's log and their own partner's tooling erases it for you.
 *
 *     2. `prev_session_id` pointed at whichever session had the latest
 *        `session.start.wall` regardless of author, so a "contributor's session
 *        chain" could link to a stranger — which makes the deletion detector of
 *        program spec §7 mechanism 1 ("a missing middle session is visible from
 *        the next one's back-pointer") not merely useless but actively false.
 *
 *   The only cross-session identity signal that exists is
 *   `session.start.identity.enrollment.student_ref` (program spec §5a). It is NOT
 *   `machine_id` — that is salted with the session id (`recorder-context.ts`) and
 *   can never match across sessions — and it is NOT `session_pubkey`, which is a
 *   fresh ephemeral keypair per session. Ownership is therefore decided by
 *   `student_ref`, and only by `student_ref`.
 *
 *   Three classes, from this recorder's own ref and the candidate's:
 *
 *     own          both present and equal          → eligible: may be linked AND quarantined
 *     foreign      both present and different, OR  → NEVER touched. Not selected, not
 *                  we have none and it has one       renamed, not linked, not even read past
 *                                                    its first line.
 *     unattributed neither has one, or we have    → eligible ONLY when this recorder is
 *                  one and it does not              itself unattributed (see below)
 *
 *   Why `unattributed` is eligible only for an unattributed recorder: when nothing
 *   in the directory carries an identity, the directory is indistinguishable from a
 *   solo one, and refusing to act would silently turn off crash recovery for every
 *   student who has not enrolled — a behaviour change well beyond fixing a bug.
 *   When THIS recorder does hold an identity, an unattributed file is a file we
 *   cannot prove is ours, so we leave it alone: losing a back-pointer costs a link,
 *   whereas renaming someone's only record costs the evidence.
 *
 *   KNOWN RESIDUAL GAP, stated rather than papered over: when *neither* partner has
 *   enrolled, every file in the directory is `unattributed` and no signal exists that
 *   could separate them. Both defects remain reachable in that configuration. Closing
 *   it requires enrollment (program spec §5a) or peer witnessing (spec §5.5, Tier 4.1,
 *   which is gated on an unanswered CPHS question, §8.5). Nothing in this module can.
 *
 *   NOT FIXED HERE, deliberately: `prev_session_id` is still set only on the dangling
 *   path, so removing a cleanly-ended session is still undetectable by §7 mechanism 1.
 *   Spec §3 S9 calls that "a real hole and it predates this program", but Tier 0.2
 *   scopes this change to ownership, and linking on clean end reverses a documented
 *   product decision (see "Decision — prev_session_id linkage" above) and changes the
 *   analyzer's session graph for solo students too. That is a product call, not a
 *   coding one.
 */

import { parseEntries, validateChain } from '@provenance/log-core';

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
  readSlogFile: (
    path: string,
  ) => Promise<{ ok: true; text: string } | { ok: false; reason: 'not_found' | 'read_error' }>;
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
   * This is the whole ownership signal — see "Decision — OWNERSHIP" above.
   * Optional, and absent means null, so callers and tests that predate the
   * enrollment work keep exactly the behaviour they had.
   */
  ownStudentRef?: string | null;
};

/**
 * How a `.slog` in `.provenance/` relates to the session that is starting.
 * See "Decision — OWNERSHIP" in the module docstring for the full table.
 */
export type SlogOwnership = 'own' | 'foreign' | 'unattributed';

/**
 * Classify a candidate `.slog` from the two `student_ref`s.
 *
 * Note the asymmetric `foreign` case: when this recorder has NO identity and the
 * candidate HAS one, the candidate is foreign rather than unattributed. We cannot
 * claim to be a contributor we cannot name, and the cost of being wrong is
 * asymmetric — misclassifying our own pre-enrollment log as foreign loses a
 * back-pointer, while misclassifying a partner's log as ours destroys it.
 */
export function classifySlogOwnership(
  ownStudentRef: string | null,
  candidateStudentRef: string | null,
): SlogOwnership {
  // A candidate that names nobody can never be PROVEN ours, whoever we are.
  if (candidateStudentRef === null) return 'unattributed';
  if (ownStudentRef === null) return 'foreign';
  return candidateStudentRef === ownStudentRef ? 'own' : 'foreign';
}

/**
 * May this recorder select, link to, and (if corrupt) quarantine a candidate of
 * the given class?
 *
 * `own` always. `foreign` never. `unattributed` only when this recorder is itself
 * unattributed, because only then is the directory indistinguishable from a solo
 * one and today's behaviour the honest default.
 */
function isEligible(ownership: SlogOwnership, ownStudentRef: string | null): boolean {
  if (ownership === 'own') return true;
  if (ownership === 'foreign') return false;
  return ownStudentRef === null;
}

// ---------------------------------------------------------------------------
// Choosing the previous session
// ---------------------------------------------------------------------------

/**
 * The two facts we need off a .slog's FIRST LINE: when its session started, and
 * whose session it claims to be.
 *
 * Only the first line is parsed — this runs once per file at startup and must not
 * become proportional to log size. `student_ref` sits in `session.start`, which is
 * always seq 0, so one line is enough.
 *
 * Returns null when the file doesn't start with a parseable `session.start`. Such
 * a file is not a usable ordering candidate; the corrupt-handling path deals with
 * it if it ends up being chosen, and its ownership is `unattributed` because a
 * file we cannot read cannot tell us whose it is.
 */
function parseSessionStartHead(text: string): { wall: number; studentRef: string | null } | null {
  const newlineIdx = text.indexOf('\n');
  const firstLine = newlineIdx === -1 ? text : text.slice(0, newlineIdx);
  if (firstLine.trim().length === 0) return null;

  let entry: { kind?: unknown; wall?: unknown; data?: unknown };
  try {
    entry = JSON.parse(firstLine) as { kind?: unknown; wall?: unknown; data?: unknown };
  } catch {
    return null;
  }

  if (entry.kind !== 'session.start' || typeof entry.wall !== 'string') return null;

  const wall = Date.parse(entry.wall);
  if (Number.isNaN(wall)) return null;

  return { wall, studentRef: extractStudentRef(entry.data) };
}

/**
 * Pull `data.identity.enrollment.student_ref` out of an untyped `session.start`
 * payload, or null when any hop is missing or the wrong shape.
 *
 * Narrowed by hand rather than by a schema: 1.x payloads have no `identity` at
 * all, this runs on a file written by a possibly-different recorder version, and
 * "absent" must never become "throws".
 */
function extractStudentRef(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const identity = (data as Record<string, unknown>)['identity'];
  if (typeof identity !== 'object' || identity === null) return null;
  const enrollment = (identity as Record<string, unknown>)['enrollment'];
  if (typeof enrollment !== 'object' || enrollment === null) return null;
  const ref = (enrollment as Record<string, unknown>)['student_ref'];
  return typeof ref === 'string' && ref.length > 0 ? ref : null;
}

/** One `.slog` in the directory, after the single first-line read. */
type SlogCandidate = {
  filename: string;
  ownership: SlogOwnership;
  /** Retained only for the current best, so a large directory is not held in memory. */
  text: string | null;
  wall: number | null;
};

/**
 * Scan the directory once and pick the ELIGIBLE `.slog` whose session.start wall
 * is latest, returning it with the text already read (so the caller doesn't
 * re-read it).
 *
 * `eligibleFallback` is the alphabetically last eligible filename, used when no
 * eligible file yields a parseable session.start so that the corrupt/quarantine
 * path still runs on something we are allowed to touch.
 *
 * Wall clock is used ONLY to order sessions that are already known to be the same
 * contributor's, which is the narrowest defensible use of it (spec §5.2 L3): it is
 * a display-grade primitive even between one person's two machines. The
 * authoritative fix is the signed per-contributor session ordinal (spec Tier 4.2),
 * which is a `session.start` format change and therefore out of scope here.
 *
 * Reads are sequential, not Promise.all: only one file's text is held at a time
 * besides the current best.
 */
async function chooseMostRecentOwnSlog(
  slogFiles: string[],
  provenanceDir: string,
  readSlogFile: RecoveryDeps['readSlogFile'],
  ownStudentRef: string | null,
): Promise<{ best: { filename: string; text: string } | null; eligibleFallback: string | null }> {
  let best: (SlogCandidate & { text: string; wall: number }) | null = null;
  let eligibleFallback: string | null = null;

  for (const filename of slogFiles) {
    const read = await readSlogFile(`${provenanceDir}/${filename}`);

    // An unreadable file tells us nothing about whose it is.
    const head = read.ok ? parseSessionStartHead(read.text) : null;
    const ownership = classifySlogOwnership(ownStudentRef, head?.studentRef ?? null);

    // A foreign session is dropped HERE, before anything else can happen to it:
    // never selected, never linked, never renamed. That is the whole of Tier 0.1
    // and 0.2 — everything downstream operates on our own sessions only.
    if (!isEligible(ownership, ownStudentRef)) continue;

    // slogFiles arrives sorted, so the last eligible one seen is the
    // alphabetically last eligible one.
    eligibleFallback = filename;

    if (!read.ok || head === null) continue;

    // Ties (two sessions starting in the same millisecond) fall back to
    // filename order, so the choice stays deterministic.
    if (
      best === null ||
      head.wall > best.wall ||
      (head.wall === best.wall && filename > best.filename)
    ) {
      best = { filename, text: read.text, wall: head.wall, ownership };
    }
  }

  return {
    best: best === null ? null : { filename: best.filename, text: best.text },
    eligibleFallback,
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Inspect the provenanceDir for a previous session and return a recovery decision.
 *
 * Side effects:
 *   - If the chain is invalid: renames the slog to <slog>.corrupt-<ISO> (quarantine)
 *     — but ONLY for a `.slog` this recorder is entitled to touch. A file belonging
 *     to another contributor is never read past its first line, never selected,
 *     never linked, and never renamed. See "Decision — OWNERSHIP".
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

  // Most recent ELIGIBLE session by session.start wall — see the module-level
  // "Decision — OWNERSHIP" comment. A partner's `.slog` never reaches this point.
  const { best: selected, eligibleFallback } = await chooseMostRecentOwnSlog(
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

  if (!readResult.ok) {
    // Can't read the file at all — treat as corrupt.
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
  }

  // Parse the entries.
  const parseResult = parseEntries(readResult.text);
  if (!parseResult.ok) {
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
  }

  const entries = parseResult.value;

  // Validate the chain.
  const chainResult = validateChain(entries);
  if (!chainResult.ok) {
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
  }

  // Chain is valid — extract session_id from the first entry (session.start, seq 0).
  const firstEntry = entries[0];
  if (firstEntry === undefined || firstEntry.kind !== 'session.start') {
    // No session.start — malformed; quarantine.
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
  }

  const data = firstEntry.data as Record<string, unknown>;
  const prevSessionId = typeof data['session_id'] === 'string' ? data['session_id'] : null;

  if (prevSessionId === null) {
    // session.start data doesn't have a session_id — malformed; quarantine.
    const quarantinedPath = `${slogPath}.corrupt-${now().toISOString().replace(/[:.]/g, '-')}`;
    await rename(slogPath, quarantinedPath);
    return { kind: 'previous_session_corrupt', quarantinedPath };
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
