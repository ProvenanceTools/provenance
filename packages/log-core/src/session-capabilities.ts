/**
 * The three `session.start` CAPABILITY REPORTS — collaboration spec §5.6.
 *
 * The types live in `events.ts` with every other payload; the runtime narrowing
 * lives here, in the same style as `git-event.ts` and `peer-observed.ts`,
 * because these are cross-language contracts rather than private details of one
 * reader. Four consumers need identical rules: this monorepo's analyzer and
 * server through `analysis-core`, plus the two sibling recorder repos, which
 * need them to EMIT conformant payloads.
 *
 * ## What a capability report is, and what it is emphatically not
 *
 * The parent spec §4 establishes the **absence-vs-disabled rule**: the effective
 * capture policy must travel into the bundle, because otherwise the analyzer
 * cannot distinguish "this student produced no `selection.change` events" from
 * "this course disabled `selection.change`". Collaboration spec §5.6 adds three
 * more instances of the same rule, and these are they.
 *
 * A capability report says **"I could not"**. A capture knob says **"I was told
 * not to"**. Those are different facts with different owners: a knob is a
 * course-signed manifest field a professor controls, a capability report is the
 * recorder describing the machine it ran on. Nothing here is policy-gated,
 * nothing here appears in `policy.capture`, and adding any of these to the
 * capture-policy surface would be a category error — see `policy.ts`, which
 * already names this file's `git_capture` as the reason `peer.observed` is on
 * the floor rather than behind a knob.
 *
 * ## None of the three is ever a finding
 *
 * No `Flag`, no ninth validation check (the PRD §5.4 eight are a frozen
 * persisted contract), no severity, no score. **Facts only.** They exist for two
 * jobs:
 *
 *  1. to make an EXISTING finding readable — decision D16 made a content-derived
 *     `git_unrecorded_in` no longer suppressible by the recorder's timing tag,
 *     and accepted that it therefore fires for an honest pair whose partner
 *     simply was not recording. "Git capture was impossible on this machine" is
 *     exactly the context a grader needs to read that flag correctly;
 *  2. to let a coverage surface say **"we could not check"** instead of implying
 *     "there was nothing to check".
 *
 * A capability report describes the RECORDER, never the student it recorded.
 *
 * ## Absent is the ordinary case, permanently
 *
 * **Every bundle in existence carries none of these fields**, and every field is
 * optional permanently (1.x support is permanent, program spec §9). Each read
 * therefore models absence as its own answer, and `'absent'` MUST be read as
 * "this recorder does not report the capability" — never as `'unavailable'`.
 * Collapsing the two would make every legacy bundle claim its own capture was
 * broken, which is a false statement about several years of archived
 * submissions.
 *
 * ## Three answers, not two — the D12 shape
 *
 * `readRepositoryDiscriminator` returns `absent` / `recorded` / `malformed`, and
 * the third is what makes the second safe. All three readers here do the same.
 * `git_capture` and `witness_capture` are CLOSED ENUMS: a value outside the set
 * is a nonconforming writer, and folding it into a legal value would put an
 * invented meaning in front of a grader. It is `'malformed'`, it is counted, and
 * it is never a finding.
 *
 * ## Compatibility
 *
 * An older reader meeting these fields is unaffected: `session.start` payload
 * readers ignore keys they do not know, and the chain is computed over the
 * envelope without interpreting `data`. A newer reader meeting a bundle without
 * them is unaffected, which is every bundle in existence — the absent case is
 * byte-identical to the pre-§5.6 world.
 *
 * **Writers OMIT, never `null`.** Omission and `null` canonicalize differently
 * and therefore chain to different hashes, exactly as `parents: []` and an
 * absent `parents` do. Readers accept `null` as absence so a nonconforming log
 * still parses; a writer that emits it is nonconforming.
 */

import type { SessionFileScope, SessionStartPayload } from './events.js';

// ---------------------------------------------------------------------------
// Field names
// ---------------------------------------------------------------------------

/**
 * The payload keys that carry the three reports.
 *
 * Exported so a port names each field through a constant rather than restating
 * the string, and so a rename is a compile error rather than a silent
 * cross-repository disagreement.
 */
export const GIT_CAPTURE_FIELD = 'git_capture' satisfies keyof SessionStartPayload;
export const WITNESS_CAPTURE_FIELD = 'witness_capture' satisfies keyof SessionStartPayload;
export const FILE_SCOPE_FIELD = 'file_scope' satisfies keyof SessionStartPayload;

// ---------------------------------------------------------------------------
// §5.6 item 2 — was git observation available?
// ---------------------------------------------------------------------------

/**
 * Every legal value of `session.start.git_capture`, in a fixed order.
 *
 * Exported so a port can assert its own enum against it, and so
 * `tools/export-conformance-vectors.ts` publishes the set rather than restating
 * it.
 *
 * The three are NOT interchangeable and collapsing any two destroys the point of
 * the field:
 *
 *  - `'available'` — the git integration answered and this session was watching
 *    at least the repositories it owns. An absence of `git.event` in this
 *    session means git activity did not happen, not that it could not be seen.
 *  - `'unavailable'` — the recorder could not observe git AT ALL on this
 *    machine: the git extension was absent, or its API could not be obtained.
 *    Nothing this session did could have produced a `git.event`.
 *  - `'not_owned'` — git observation worked, and every repository visible to it
 *    was outside this session's assignment scope, so its events were
 *    deliberately dropped by the ownership gate. The recorder COULD see git; it
 *    was routing, not incapacity.
 *
 * `'unavailable'` is a statement about the machine's software. `'not_owned'` is
 * a statement about where the assignment sits relative to the repositories. A
 * grader reading a `git_unrecorded_in` flag needs to know which, and a reader
 * that reports one as the other is describing a different situation than the one
 * that occurred.
 */
export const GIT_CAPTURE_VALUES = ['available', 'unavailable', 'not_owned'] as const;

/** @see {@link GIT_CAPTURE_VALUES} */
export type GitCaptureCapability = (typeof GIT_CAPTURE_VALUES)[number];

// ---------------------------------------------------------------------------
// §5.6 item 3 — was `.provenance/` witnessing available?
// ---------------------------------------------------------------------------

/**
 * Every legal value of `session.start.witness_capture`, in a fixed order.
 *
 *  - `'available'` — a `.provenance/` directory watcher was running. Had a
 *    partner's `.slog` appeared, changed or vanished, this session would have
 *    witnessed it.
 *  - `'unavailable'` — no watcher. The absence of `peer.observed` events in this
 *    session says nothing whatsoever about what was in `.provenance/`.
 *
 * **Two values, deliberately, where `git_capture` has three.** There is no
 * witnessing analogue of `'not_owned'`: a recorder witnesses the `.provenance/`
 * directory it is itself writing into, so there is no ownership question to
 * route on. Inventing a third value to make the two enums look alike would
 * publish a state no recorder can be in.
 */
export const WITNESS_CAPTURE_VALUES = ['available', 'unavailable'] as const;

/** @see {@link WITNESS_CAPTURE_VALUES} */
export type WitnessCaptureCapability = (typeof WITNESS_CAPTURE_VALUES)[number];

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Why a present capability value could not be read.
 *
 * Descriptive only. Neither is evidence about a student, and no reader may turn
 * one into a finding — see the module docstring.
 */
export type CapabilityValueProblem =
  /** Present, but not a JSON string. */
  | 'not_a_string'
  /** A string outside the closed enum. A nonconforming writer, or a newer one. */
  | 'unknown_value';

/**
 * What one `session.start` says about whether git observation was available.
 *
 * `'absent'` and `'malformed'` both leave a consumer with no usable answer and
 * are still different facts, which is why they are different variants: one is a
 * recorder with nothing to say, the other a recorder that said something wrong,
 * and only the second is worth counting.
 */
export type GitCaptureRead =
  | { kind: 'absent' }
  | { kind: 'recorded'; capture: GitCaptureCapability }
  | { kind: 'malformed'; problem: CapabilityValueProblem };

/** @see {@link GitCaptureRead} */
export type WitnessCaptureRead =
  | { kind: 'absent' }
  | { kind: 'recorded'; capture: WitnessCaptureCapability }
  | { kind: 'malformed'; problem: CapabilityValueProblem };

function readEnumCapability<T extends string>(
  data: unknown,
  field: string,
  legal: readonly T[],
): { kind: 'absent' } | { kind: 'recorded'; capture: T } | {
  kind: 'malformed';
  problem: CapabilityValueProblem;
} {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { kind: 'absent' };
  }
  const raw = (data as Record<string, unknown>)[field];
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (typeof raw !== 'string') return { kind: 'malformed', problem: 'not_a_string' };
  if (!(legal as readonly string[]).includes(raw)) {
    return { kind: 'malformed', problem: 'unknown_value' };
  }
  return { kind: 'recorded', capture: raw as T };
}

/**
 * Read the git-capture report out of an untyped `session.start` `data` value.
 *
 * Pure and total: never throws, never mutates. A `.slog` is a student-editable
 * file, so every input here is untrusted and a malformed one is EXPECTED rather
 * than exceptional.
 *
 * `null` is accepted as absence so a writer that spelled the unknown case
 * explicitly still reads correctly — but a **writer must OMIT the field**.
 *
 * A payload that is not an object at all reads as `'absent'`: there is no field
 * on a non-object, and manufacturing a problem out of a payload this function
 * does not own would report the same garbage twice.
 */
export function readGitCapture(data: unknown): GitCaptureRead {
  return readEnumCapability(data, GIT_CAPTURE_FIELD, GIT_CAPTURE_VALUES);
}

/** @see {@link readGitCapture} */
export function readWitnessCapture(data: unknown): WitnessCaptureRead {
  return readEnumCapability(data, WITNESS_CAPTURE_FIELD, WITNESS_CAPTURE_VALUES);
}

// ---------------------------------------------------------------------------
// §5.6 item 1 — the effective resolved file set
// ---------------------------------------------------------------------------

/**
 * Why a present `file_scope` could not be read.
 *
 * The last four are the PRIVACY shape check, and they are the reason this reader
 * inspects the value at all — see {@link readFileScope}.
 */
export type FileScopeProblem =
  /** Present, but not a JSON object. */
  | 'not_an_object'
  /** `watched` is missing or not an array. */
  | 'watched_not_an_array'
  /** `complete` is missing or not a boolean. It is never inferred. */
  | 'complete_not_a_boolean'
  /** An element of `watched` is not a string. */
  | 'path_not_a_string'
  /** An element of `watched` is the empty string, which names no file. */
  | 'path_empty'
  /**
   * An element of `watched` is an ABSOLUTE path — POSIX (`/…`), a Windows drive
   * (`C:\…`, `c:/…`) or a UNC share (`\\host\…`). An absolute path embeds the
   * account name and the machine's layout; S14(b) forbids it.
   */
  | 'path_absolute'
  /**
   * An element of `watched` contains a `..` segment, so it names something
   * outside the assignment scope.
   */
  | 'path_escapes_scope'
  /**
   * An element of `watched` contains a colon somewhere other than a Windows
   * drive letter (which is `path_absolute`).
   *
   * That is every spelling of a remote URL — `https://host/…`, `ssh://…`,
   * `file://…` and git's scp-style `user@host:path` — and a remote URL embeds
   * the org and frequently the student's own username, which S14(b) forbids.
   * It is also not a portable filename character, so a conforming
   * assignment-relative path never needs one.
   */
  | 'path_has_colon';

/**
 * What one `session.start` says about the files this session actually watched.
 *
 * @see {@link readFileScope} for why a malformed set is rejected WHOLE.
 */
export type FileScopeRead =
  | { kind: 'absent' }
  | { kind: 'recorded'; watched: readonly string[]; complete: boolean }
  | { kind: 'malformed'; problem: FileScopeProblem };

/** Reject anything that is not a scope-relative path. `null` when acceptable. */
function pathProblem(value: unknown): FileScopeProblem | null {
  if (typeof value !== 'string') return 'path_not_a_string';
  if (value.length === 0) return 'path_empty';
  // Absolute first, so a Windows drive letter is diagnosed as what it is rather
  // than as the colon rule below.
  if (value.startsWith('/') || value.startsWith('\\')) return 'path_absolute';
  if (/^[A-Za-z]:([\\/].*)?$/.test(value)) return 'path_absolute';
  if (value.includes(':')) return 'path_has_colon';
  for (const segment of value.split(/[\\/]/)) {
    if (segment === '..') return 'path_escapes_scope';
  }
  return null;
}

/**
 * Read the effective resolved file set out of an untyped `session.start` `data`
 * value.
 *
 * ## Why the LIST, and not a count or the glob set
 *
 * The question this field exists to answer is S25's: "no events for this file"
 * is ambiguous between _nothing happened_ and _it was never watched_. A COUNT
 * cannot answer it — you cannot ask a number whether it contains `Solver.java`.
 * The unresolved GLOB SET cannot answer it either, and worse: it would require
 * three hand-written recorder ports and one analyzer to agree on a matcher,
 * which S25 itself names as a real divergence risk and which parent spec §10
 * exists to prevent. Publishing the RESULT rather than the RULE is what keeps
 * one matcher, wherever it ends up living.
 *
 * The list is therefore the smallest thing that answers the question, and it is
 * stable across whatever `scope: 'repo'` resolution the still-open format
 * decision (collaboration spec §8.7) settles on: whether the set comes from a
 * literal manifest list, a glob expansion, or an enumeration of tracked files,
 * the result is a list of paths.
 *
 * ## `complete` is a claim, not a formatting detail
 *
 * A writer that caps the list emits `complete: false`, and a consumer must then
 * read a path's ABSENCE from `watched` as _unknown_ rather than as _not
 * watched_. It is a required boolean rather than an optional `truncated` flag
 * because a consumer must never have to infer it: the whole field exists to
 * remove an inference.
 *
 * ## Privacy — why this reader shape-checks every element
 *
 * S14(b) forbids repository paths and remote URLs in the log. Workspace-relative
 * paths already appear throughout the log (`doc.open.path` and every other path
 * field), so this field introduces no new category of identifier — but an
 * ABSOLUTE path does (it embeds the account name and the machine's layout) and
 * so does a remote URL (it embeds the org and often the student's own username).
 * This reader is the one place a nonconforming writer's absolute path or URL can
 * be stopped before it reaches a staff-facing UI, exactly as
 * `readRepositoryDiscriminator` shape-checks the root-commit sha for the same
 * reason.
 *
 * ## Why a bad element rejects the WHOLE set
 *
 * Dropping the offending entries would hand the consumer a silently NARROWED
 * list, and a narrowed list read as complete says "this file was not watched"
 * about a file that was. Rejecting outright costs only the information — the
 * consumer falls back to exactly the ambiguity it lives with today — and cannot
 * mislead. This is `validatePeerObservedPayload`'s rule ("a malformed payload is
 * REJECTED rather than partially read"), for the same reason.
 *
 * ## An EMPTY set is a real answer
 *
 * `{ watched: [], complete: true }` is legal and meaningful: the scope resolved
 * to nothing, so no file was watched and every file's silence is explained. It
 * is not absence and must not be folded into it.
 */
export function readFileScope(data: unknown): FileScopeRead {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { kind: 'absent' };
  }
  const raw = (data as Record<string, unknown>)[FILE_SCOPE_FIELD];
  if (raw === undefined || raw === null) return { kind: 'absent' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { kind: 'malformed', problem: 'not_an_object' };
  }
  const obj = raw as Record<string, unknown>;

  const watched = obj['watched'];
  if (!Array.isArray(watched)) return { kind: 'malformed', problem: 'watched_not_an_array' };

  const complete = obj['complete'];
  if (typeof complete !== 'boolean') {
    return { kind: 'malformed', problem: 'complete_not_a_boolean' };
  }

  for (const entry of watched) {
    const problem = pathProblem(entry);
    if (problem !== null) return { kind: 'malformed', problem };
  }

  return { kind: 'recorded', watched: watched as readonly string[], complete };
}

// ---------------------------------------------------------------------------
// Description — staff-facing one-liners
// ---------------------------------------------------------------------------

/**
 * What a git-capture value means, in a sentence.
 *
 * Kept here rather than in a UI so all four consumers say the same thing, and so
 * the `'unavailable'` / `'not_owned'` distinction has somewhere it is actually
 * spent rather than merely stored.
 */
export function describeGitCapture(capture: GitCaptureCapability): string {
  switch (capture) {
    case 'available':
      return 'Git observation was available: this session was watching the repositories it owns.';
    case 'unavailable':
      return (
        'Git observation was not available on this machine — the editor exposed no git ' +
        'integration — so this session could not have recorded any git activity.'
      );
    case 'not_owned':
      return (
        'Git observation worked, but no repository it could see belonged to this ' +
        "assignment's scope, so this session recorded none of their activity."
      );
  }
}

/** @see {@link describeGitCapture} */
export function describeWitnessCapture(capture: WitnessCaptureCapability): string {
  switch (capture) {
    case 'available':
      return 'Peer witnessing was available: this session was watching its .provenance/ directory.';
    case 'unavailable':
      return (
        'Peer witnessing was not available in this session — no .provenance/ watcher was ' +
        'running — so the absence of observations says nothing about what was there.'
      );
  }
}

/** Human-readable one-liner for a capability value problem. For UI and export text. */
export function describeCapabilityValueProblem(problem: CapabilityValueProblem): string {
  switch (problem) {
    case 'not_a_string':
      return 'the reported value is not a string';
    case 'unknown_value':
      return 'the reported value is not one this format defines';
  }
}

/** Human-readable one-liner for a file-scope problem. For UI and export text. */
export function describeFileScopeProblem(problem: FileScopeProblem): string {
  switch (problem) {
    case 'not_an_object':
      return 'the file scope is not a JSON object';
    case 'watched_not_an_array':
      return 'the file scope carries no list of watched files';
    case 'complete_not_a_boolean':
      return 'the file scope does not say whether its list is complete';
    case 'path_not_a_string':
      return 'the list of watched files contains a value that is not a path';
    case 'path_empty':
      return 'the list of watched files contains an empty path';
    case 'path_absolute':
      return 'the list of watched files contains an absolute path, which the format forbids';
    case 'path_escapes_scope':
      return 'the list of watched files contains a path outside the assignment scope';
    case 'path_has_colon':
      return (
        'the list of watched files contains a path with a colon, which the format reserves ' +
        'for URL schemes and hosts'
      );
  }
}

/**
 * Build a `file_scope` value for a writer.
 *
 * Exported so the three recorders produce the identical shape, and so the
 * `complete` claim is never accidentally omitted. Returns `undefined` when there
 * is nothing honest to report, which the caller must SPREAD rather than assign —
 * omission and `null` chain to different hashes.
 */
export function buildFileScope(
  watched: readonly string[],
  complete: boolean,
): SessionFileScope | undefined {
  for (const entry of watched) {
    if (pathProblem(entry) !== null) return undefined;
  }
  return { watched: [...watched], complete };
}
