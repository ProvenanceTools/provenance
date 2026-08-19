/**
 * Discriminated union of all Provenance log event types.
 * PRD §4.2 (v1 event table) + §4.3 / §4.6 / §4.8 additive events.
 */

import type { Manifest } from './manifest.js';

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
 * A course-signed statement that a student pubkey belongs to a student in a
 * course. Signed by the course key, which the root-signed `course_cert`
 * authorizes (program spec §2).
 *
 * `student_ref` is an **opaque UUID, never a raw SID**. In a shared CS 61B repo
 * one partner can read the other's `session.start`; the server maps
 * `student_ref` → `roster_entries.id`, so a partner sees only a UUID.
 *
 * TYPES ONLY at this stage. Key derivation, token issuance, and the countersign
 * flow are S2 — nothing in `log-core` derives or validates these yet.
 */
export type EnrollmentToken = {
  /** Opaque roster reference. Never a student ID number, name, or email. */
  student_ref: string;
  course_id: string;
  /** Hex ed25519 public key of the student's per-course key. */
  student_pubkey: string;
  issued_at: string;
  expires_at: string;
  /** Hex ed25519 signature by the COURSE key over the token. */
  course_sig: string;
};

export type SessionIdentity = {
  enrollment: EnrollmentToken;
  /**
   * The student per-course key's signature over `session_pubkey`. This is the
   * link that binds an ephemeral session key to a named contributor.
   */
  session_pubkey_sig: string;
};

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

export type GitEventPayload = {
  operation: string;
  commit_sha?: string;
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
};

/** All valid event kind strings. */
export type EventKind = keyof EventKindMap;

/** Look up the payload type for a given event kind. */
export type EventPayload<K extends EventKind> = EventKindMap[K];
