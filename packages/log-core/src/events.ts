/**
 * Discriminated union of all Provenance log event types.
 * PRD §4.2 (v1 event table) + §4.3 / §4.6 / §4.8 additive events.
 */

import type { Manifest } from './manifest.js';
import type { SessionIdentity } from './enrollment.js';

// ---------------------------------------------------------------------------
// Shared geometry types
// ---------------------------------------------------------------------------

export type Position = {
  line: number;
  character: number;
};

export type Range = {
  start: Position;
  end: Position;
};

// ---------------------------------------------------------------------------
// Per-event payload types
// ---------------------------------------------------------------------------

/**
 * Editor/host metadata. Replaces the VS Code-shaped `vscode` block in
 * `session.start` 2.0 (program spec §5).
 *
 * provjet and provnvim currently have to pretend into a field named `vscode`,
 * filling it with editor-generic values because renaming a signed field is a
 * monorepo-owned format change. `host` un-warps that.
 */
export type HostInfo = {
  editor: 'vscode' | 'jetbrains' | 'neovim';
  editor_version: string;
  /**
   * Editor build/commit identifier. `''` is permitted and expected for VS Code,
   * whose public extension API does not expose one.
   */
  editor_build: string;
  platform: string;
};

/**
 * The identity types now live in `enrollment.ts`, alongside the parse/sign/verify
 * logic that gives them meaning, and are re-exported here so `session.start`
 * readers keep importing them from one place.
 *
 * They changed shape in S2. The earlier sketch had the COURSE key signing each
 * enrollment token directly (`course_sig`), which cannot work: the course
 * manifest-signing key is deliberately offline, and minting a token per student
 * per semester is an on-demand server operation. An `enrollment_cert` — the
 * course certifying a server-held enrollment key, exactly as the root certifies
 * a course key — resolves that, so a token now carries `enrollment_sig` and the
 * cert travels beside it. See `enrollment.ts` for the full chain.
 */
export type { EnrollmentCert, EnrollmentToken, SessionIdentity } from './enrollment.js';

export type SessionStartPayload = {
  format_version: string;
  session_id: string;
  prev_session_id: string | null;
  assignment: { id: string; semester: string };
  manifest_sig: string;
  machine_id: string;
  /**
   * @deprecated Superseded by {@link SessionStartPayload.host} in `session.start` 2.0.
   *
   * Retained as an optional field so 1.x bundles keep type-checking on read —
   * 1.x parsing is supported permanently (program spec §9). 2.0 writers emit
   * `host` only and omit this.
   */
  vscode?: {
    version: string;
    /**
     * VS Code build commit hash (40-char hex, shown in Help → About).
     * The vscode public API does not expose this, so the recorder emits the
     * empty string. Analyzers must accept `''` as valid here.
     */
    commit: string;
    platform: string;
  };
  recorder: { version: string; extension_id: string };
  session_pubkey: string;

  // --- 2.0 additions (program spec §5). All optional at the type level so 1.x
  // --- payloads remain valid; a 2.0 writer populates all three.

  /**
   * The FULL manifest: signed payload + `sig` + `course_cert`.
   *
   * This is what turns validation check 2 into a real check. `verify-session-binding.ts`
   * today can only compare `manifest_sig` across sessions for equality, because
   * the signed payload never enters the bundle. Carrying the whole manifest lets
   * the analyzer walk root → course → manifest → session entirely offline,
   * trusting nothing from the server.
   */
  manifest?: Manifest;
  identity?: SessionIdentity;
  host?: HostInfo;

  // --- The three CAPABILITY REPORTS (collaboration spec §5.6). All optional
  // --- PERMANENTLY: every bundle recorded before they landed carries none of
  // --- them, and a reader must treat their absence as "this recorder does not
  // --- report", never as "the capability was missing". A writer OMITS a field
  // --- it cannot answer — it never writes `null`, which canonicalizes
  // --- differently and therefore chains to a different hash.
  // ---
  // --- These are capability reports, not capture knobs: they say "I could
  // --- not", where `policy.capture` says "I was told not to". Nothing here is
  // --- policy-gated and nothing here is ever a finding. The narrowing lives in
  // --- `session-capabilities.ts`.

  /**
   * Whether git observation was available to this session (§5.6 item 2).
   *
   * Without it, a scope with no `git.event` is indistinguishable from a scope
   * where git capture was impossible — which is exactly the context a grader
   * needs to read a `git_unrecorded_in` flag correctly (decision D16).
   *
   * @see {@link import('./session-capabilities.js').GIT_CAPTURE_VALUES}
   */
  git_capture?: 'available' | 'unavailable' | 'not_owned';

  /**
   * Whether `.provenance/` peer witnessing was available to this session
   * (§5.6 item 3).
   *
   * Without it, "no witnesses" cannot be told from "witnessing was impossible".
   *
   * @see {@link import('./session-capabilities.js').WITNESS_CAPTURE_VALUES}
   */
  witness_capture?: 'available' | 'unavailable';

  /**
   * The effective resolved file set — the files this session actually watched
   * (§5.6 item 1, S25).
   *
   * Without it, "no events for this file" is ambiguous between _nothing
   * happened_ and _it was never watched_, and every file-scoped heuristic
   * silently mis-fires on the difference.
   *
   * @see {@link import('./session-capabilities.js').readFileScope}
   */
  file_scope?: SessionFileScope;
};

/**
 * The effective resolved file set, as recorded on `session.start`.
 *
 * Paths are ASSIGNMENT-ROOT-RELATIVE, exactly as every other path in the log.
 * An absolute path or a URL is nonconforming and is rejected by
 * `readFileScope` — S14(b) forbids both.
 */
export type SessionFileScope = {
  /**
   * Every path this session watched, assignment-root-relative.
   *
   * An EMPTY array with `complete: true` is a real answer meaning "the scope
   * resolved to nothing", and must not be folded into absence.
   */
  watched: string[];
  /**
   * `false` when {@link SessionFileScope.watched} was capped and is a strict
   * subset of what was watched. A consumer must then read a path's absence from
   * the list as _unknown_, never as _not watched_.
   *
   * Required rather than an optional `truncated` flag: this field exists to
   * remove an inference, so it must never itself require one.
   */
  complete: boolean;
};

export type SessionHeartbeatPayload = {
  focused: boolean;
  active_file: string | null;
  idle_since_ms: number;
};

export type SessionEndPayload = {
  reason: string;
};

/**
 * Emitted by the heartbeat tick when the wall-clock gap since the previous
 * tick is >= 2x the expected heartbeat interval — i.e. the machine almost
 * certainly slept (or the extension host was otherwise suspended) rather
 * than the log having been tampered with. Emitted immediately before the
 * `session.heartbeat` entry that observes the gap, so its `seq` lands
 * strictly between the two bounding heartbeat seqs.
 */
export type SessionResumedPayload = {
  gap_ms: number;
  expected_interval_ms: number;
};

export type DocOpenPayload = {
  path: string;
  sha256: string;
  line_count: number;
  /**
   * Initial content of the file at the time it was opened.
   *
   * Optional for backwards compatibility with pre-v1.1 recorders.
   * Present when the recorder is v1.1+ AND the file is ≤ 64 KB.
   * Larger files have only `sha256`/`line_count`; reconstruction taints in
   * that case.
   */
  content?: string;
  /**
   * Set to true when `content` is omitted because the file exceeded 64 KB.
   * Absent (not false) when the file was small enough to inline.
   */
  truncated?: boolean;
};

export type DocChangeDelta = {
  range: Range;
  text: string;
};

export type DocChangePayload = {
  path: string;
  deltas: Array<DocChangeDelta>;
  source: 'typed' | 'paste_likely' | 'paste_confirmed';
};

export type DocSavePayload = {
  path: string;
  sha256: string;
};

export type DocClosePayload = {
  path: string;
};

export type PastePayload = {
  path: string;
  range: Range;
  length: number;
  sha256: string;
  content?: string;
  content_head?: string;
  content_tail?: string;
};

export type SelectionChangePayload = {
  path: string;
  range: Range;
  was_selection: boolean;
};

export type FocusChangePayload = {
  gained: boolean;
  reason?: string;
};

export type TerminalOpenPayload = {
  terminal_id: string;
  shell: string;
  shell_integration: boolean;
};

export type TerminalCommandPayload = {
  terminal_id: string;
  command: string;
  exit_code?: number;
};

export type ExtSnapshotPayload = {
  extensions: Array<{ id: string; version: string; enabled: boolean }>;
};

export type ExtActivatePayload = {
  id: string;
  version: string;
};

export type FsExternalChangePayload = {
  path: string;
  /**
   * sha256 of the file content immediately before the external change.
   * For `operation: 'create'` (the file did not exist before), this is
   * the empty string `''`.
   */
  old_hash: string;
  /**
   * sha256 of the file content immediately after the external change.
   * For `operation: 'delete'` (the file no longer exists), this is the
   * empty string `''`.
   */
  new_hash: string;
  diff_size: number;
  explanation?: 'formatter' | 'git';
  /**
   * What kind of external change this was. Default `'modify'` when
   * absent (pre-v1.3 bundles only emitted modifies, and old analyzers
   * reading new bundles can treat unknown operations as a modify).
   *
   *   'modify' — file existed before and after; content changed.
   *   'delete' — file existed before, gone after. `new_hash === ''`,
   *              no `new_content` field.
   *   'create' — file didn't exist before, exists after. `old_hash === ''`,
   *              `new_content` populated as for modify.
   */
  operation?: 'modify' | 'delete' | 'create';
  /**
   * UTF-8 byte length of the post-change file content. Populated whenever
   * the recorder had the new content in hand (which is `'modify'` and
   * `'create'` operations on files small enough to read at emit time).
   * Absent for `'delete'`.
   */
  new_content_size?: number;
  /**
   * Full post-change content if `new_content_size <= 4096`. Lets the
   * analyzer reseed reconstruction so replay shows the file after the
   * external write. Absent when content was too large to inline, or for
   * `'delete'` operations.
   */
  new_content?: string;
  /**
   * First 512 chars of the post-change content if it was too large to
   * inline. Hash + head/tail mirrors the paste-payload truncation pattern.
   */
  new_content_head?: string;
  /** Last 512 chars of the post-change content if it was too large to inline. */
  new_content_tail?: string;
};

/**
 * A git operation observed through the editor's git integration (PRD §4.2),
 * carrying enough of the commit graph for replay to show branch and merge
 * structure (program spec S5).
 *
 * ## Why the graph is recorded rather than shipped
 *
 * Gradescope delivers no `.git`, and a `.git` that did travel would prove less
 * than it appears to: `commit --amend`, `rebase`, and `filter-branch` rewrite
 * history after the fact, so a repository handed in at submission time is
 * evidence of what a student ended up with, not of what happened. The recorder
 * sits on the live repository while the work is being done, so capturing the
 * graph here puts it inside the signed hash chain at the instant it existed,
 * where it can no longer be rewritten.
 *
 * ## No author identity. Ever.
 *
 * There is deliberately no `author_name` and no `author_email` here, and none
 * anywhere else in the log. The approved CPHS protocol treats a new category of
 * identifier as requiring a filed modification BEFORE implementation, and git
 * author identity is exactly that — a real name and a real email address, in
 * clear, attached to every commit. `sha`, `parents`, and `branch` are
 * structural: they describe the shape of the history, not who produced it.
 *
 * Attribution already has a designed home, and it is opaque on purpose: the
 * `student_ref` UUID inside `session.start.identity`. Adding an author field
 * here would reintroduce, unsigned and unreviewed, precisely the identifier that
 * design went to some trouble to avoid.
 *
 * ## Every new field is optional, permanently
 *
 * 1.x bundles, and the 2.0 bundles recorded before this landed, carry only
 * `operation` and `commit_sha`. 1.x support is permanent (program spec §9), so
 * these stay optional at the type level rather than becoming required at some
 * future version.
 */
export type GitEventPayload = {
  operation: string;
  /**
   * @deprecated Superseded by {@link GitEventPayload.sha}, which means the same
   * thing. Retained — and still emitted by 2.0 writers — so 1.x readers keep
   * working through the reader-before-writer migration (program spec §9).
   */
  commit_sha?: string;
  /** Full 40-char hex sha of the commit HEAD points at. Absent if unreadable. */
  sha?: string;
  /**
   * Parent shas of {@link GitEventPayload.sha}, in git's own order — the FIRST
   * parent is the branch that was merged into. Order is therefore meaningful and
   * must never be sorted: reversing it inverts the meaning of a merge.
   *
   * Length is the structure: `0` is a root commit, `1` an ordinary commit, `2`
   * or more a merge. An EMPTY ARRAY and an ABSENT FIELD mean different things —
   * `[]` is "this commit genuinely has no parents", absent is "the recorder
   * could not read them" — so a reader must not collapse the two.
   */
  parents?: string[];
  /** Current branch name. Absent when HEAD is detached; never invented. */
  branch?: string;
  /**
   * The repository this observation came from, identified by its **root-commit
   * sha** — decision D12 (collaboration spec S14(b)).
   *
   * A scope can observe more than one repository: a submodule, or a repository
   * nested inside the one that owns the assignment root. Their sha spaces are
   * unrelated, so a reader that keys commits by sha alone merges two graphs that
   * have nothing to do with each other. This field is what lets a reader key on
   * `(repository, sha)` for real.
   *
   * The root-commit sha was chosen because **both partners derive the same value
   * offline** — which is the whole point, since a discriminator two partners
   * disagree about cannot correlate anything — and because a submodule has a
   * different root commit, so it discriminates correctly. It is deliberately not
   * the repository path and not a remote URL: a path is arguably an identifier
   * and a remote URL embeds the org and often the student's own username.
   *
   * **Absent is ordinary and permanent.** Every bundle recorded before this
   * landed has no such field, and a shallow clone has no reachable root commit,
   * so a recorder must OMIT the field rather than emit a boundary commit that a
   * full clone of the same repository would disagree with. Absent means "this
   * observation is unlabelled" — never "a different repository", never a defect,
   * and never evidence of anything.
   *
   * Omit it, never `null`: an absent key and a `null` value canonicalize
   * differently and therefore chain to different hashes, exactly as `parents: []`
   * and an absent `parents` do.
   *
   * Lowercase hex, 40 characters for a sha-1 repository or 64 for sha-256. See
   * `readRepositoryDiscriminator` in `git-event.ts` for the narrowing every
   * reader and every port shares.
   */
  root_commit_sha?: string;
};

export type ClockSkewPayload = {
  delta_ms: number;
};

// v1-additive events (PRD §4.3, §4.6, §4.8)

export type PasteAnomalyPayload = {
  intercepted_count: number;
  large_insert_count: number;
};

export type ChainBrokenPayload = {
  at_seq: number;
  reason: string;
};

export type RecorderDegradedPayload = {
  reason: string;
};

export type RecorderRecoveredFromCorruptionPayload = {
  quarantined_path: string;
};

/**
 * A foreign `.provenance/` log observed in the working tree — peer witnessing
 * (program spec §7 mechanism 2, collaboration spec §5.5, Tier 4.1).
 *
 * ## What problem this exists to solve
 *
 * In a shared repository either partner can `rm` the other's `.slog` in an
 * ordinary-looking commit, and nothing in the resulting archive records that the
 * file was ever there. When the recorder sees a foreign log appear — typically a
 * `git pull` dropping it into the tree — it writes what it saw into its **own**
 * signed chain. Deleting a partner's log then leaves your own chain testifying
 * that it existed, and to hide the deletion you must destroy both chains, which
 * yields a submission with no provenance at all: the loudest possible signal.
 *
 * It also closes a gap that is otherwise unclosable from an archive alone. A
 * rolling seal present with no log (`no_session_log`) is equally consistent with
 * a deletion and with an innocent partial push — a partner who committed
 * `manifest-<id>.json` before their `.slog` landed produces the identical bytes.
 * A witness is the only thing that distinguishes them, which is why
 * `loader/rolling-seal.ts` deliberately states it cannot.
 *
 * ## A witness is a claim, not a fact
 *
 * This payload records what one contributor's recorder saw about **another
 * contributor's** file. It is exactly as trustworthy as the chain it sits in, so
 * a reader must weight it by the witnessing session's own identity verdict and
 * must never treat a witness inside an `unverifiable` session as authoritative.
 * See `analysis-core/src/witness/reconcile-witnesses.ts`.
 *
 * ## No identity, of any kind
 *
 * There is no student ref, no key, no git author, and no path outside
 * `.provenance/` here. A witness names a FILE and a CHAIN POSITION. Attribution
 * runs, as everywhere else, through `session.start.identity.student_ref`; the
 * witnessed session is joined to a contributor by its own `session.start`, never
 * by anything asserted here. The same CPHS constraint that keeps git author
 * identity out of {@link GitEventPayload} applies with more force to a payload
 * describing someone else's artifact.
 *
 * ## Every cross-reference field is nullable, permanently
 *
 * `session_id`, `seq_high` and `last_hash` are read out of the foreign file, and
 * a foreign file may not parse — it may be mid-write, conflict-marked, or
 * truncated. `null` means "the recorder could not read this", and a reader must
 * not confuse it with a value: a witness with a null `seq_high` commits to
 * nothing checkable and can never support a finding.
 *
 * ## The recorder never touches the file
 *
 * Reading and hashing is the whole response. It never renames, rewrites, or
 * deletes a foreign log — that was a live defect once already (a startup
 * recovery that quarantined a partner's log), and `state: 'unparseable'` is the
 * entire reaction to a foreign file that cannot be read.
 */
export type PeerObservedPayload = {
  /**
   * `.provenance/`-relative filename exactly as seen, e.g.
   * `session-<uuid>.slog`. This is the FILENAME uuid space, which in production
   * is minted independently of the logical `session.start` id — the two are
   * different values of the same shape and must never be used to key each other.
   */
  file: string;
  /**
   * sha256 hex of the file's exact bytes at observation time.
   *
   * NOT a corroboration test on its own. A foreign log is append-only and its
   * partner keeps recording, so the bytes seen here are almost always a PREFIX
   * of the bytes finally committed. Comparing this against the archived file's
   * digest and reading inequality as tampering is precisely the prefix-versus-
   * whole-file error that produced three separate maximum-severity false
   * accusations in this system's history. The chain commitment below is the
   * test; this digest is corroborating detail.
   */
  sha256: string;
  /** Byte length of the file at observation time. */
  bytes: number;
  /**
   * The foreign chain's logical session id, from its `session.start`. `null`
   * when the file did not parse.
   */
  session_id: string | null;
  /** Highest `seq` in the foreign chain. `null` when the file did not parse. */
  seq_high: number | null;
  /**
   * The foreign chain's final entry `hash`. `null` when the file did not parse.
   *
   * This is what upgrades the witness from a size claim to a verifiable
   * commitment to an exact prefix: an archived log that stops before
   * {@link PeerObservedPayload.seq_high}, or that reaches it with a different
   * hash, cannot reproduce this value. `seq_high` alone would make truncation
   * detectable only by length, which a forger can match.
   */
  last_hash: string | null;
  /**
   * What the recorder observed happening to the file.
   *
   * Descriptive context, NOT a verdict input: a reader must not let it change
   * what the witness proves. `'disappeared'` in particular is not evidence of
   * misconduct — checking out a branch that does not contain a partner's `.slog`
   * removes it from the working tree, and stashing does the same. When the file
   * is gone the digest and chain fields describe the LAST state the recorder
   * saw, which is what makes the observation evidentiary at all.
   */
  state: 'appeared' | 'grew' | 'shrank' | 'disappeared' | 'unparseable';
};

// ---------------------------------------------------------------------------
// Discriminated union map and derived types
// ---------------------------------------------------------------------------

export type EventKindMap = {
  'session.start': SessionStartPayload;
  'session.heartbeat': SessionHeartbeatPayload;
  'session.resumed': SessionResumedPayload;
  'session.end': SessionEndPayload;
  'doc.open': DocOpenPayload;
  'doc.change': DocChangePayload;
  'doc.save': DocSavePayload;
  'doc.close': DocClosePayload;
  paste: PastePayload;
  'selection.change': SelectionChangePayload;
  'focus.change': FocusChangePayload;
  'terminal.open': TerminalOpenPayload;
  'terminal.command': TerminalCommandPayload;
  'ext.snapshot': ExtSnapshotPayload;
  'ext.activate': ExtActivatePayload;
  'fs.external_change': FsExternalChangePayload;
  'git.event': GitEventPayload;
  'clock.skew': ClockSkewPayload;
  'paste.anomaly': PasteAnomalyPayload;
  'chain.broken': ChainBrokenPayload;
  'recorder.degraded': RecorderDegradedPayload;
  'recorder.recovered_from_corruption': RecorderRecoveredFromCorruptionPayload;
  'peer.observed': PeerObservedPayload;
};

/** All valid event kind strings. */
export type EventKind = keyof EventKindMap;

/** Look up the payload type for a given event kind. */
export type EventPayload<K extends EventKind> = EventKindMap[K];
