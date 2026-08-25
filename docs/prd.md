# PRD: Academic Integrity Telemetry & Analysis System

**Working name:** _Provenance_
**Status:** Draft v0.1
**Audience:** Engineering (you + Claude Code), course staff (review)
**Last updated:** May 2026

---

## 1. Background and motivation

The course has seen a sharp rise in AI-assisted cheating on homeworks, projects, and labs. Existing controls (MOSS, manual review, in-person exams) catch some of it after the fact but don't scale to thousands of students and don't surface the _process_ by which a submission was produced — only the final artifact.

This document specifies a two-part system:

1. **Provenance Recorder** — a VS Code extension that runs while a student works on an assignment and produces a tamper-evident log of how the code came into existence.
2. **Provenance Analyzer** — a web app used by course staff to inspect those logs: a replay UI for manual review, plus an automated heuristics engine that flags suspicious patterns for human attention.

The system is bundled with the assignment submission; the log file is uploaded alongside the student's code at submission time. (How that bundling happens is a course-staff integration question and is out of scope for this PRD.)

### What this is and isn't

**It is** an evidence-collection and triage system. The Recorder produces evidence; the Analyzer surfaces patterns. A flag is not a verdict — every escalation goes to a human reviewer who uses the replay UI to make a judgment call.

**It is not** an AI-detection system in the "classifier outputs a probability" sense. We do not train a model to predict "this was written by Claude." We instead detect _process_ signals (paste of a 200-line block, edits to files when VS Code wasn't focused, etc.) that are inconsistent with a student writing code themselves. Process evidence is more defensible in an academic integrity hearing than statistical AI-detection scores, which are known to be unreliable.

**Threat model.** We are not building NSA-grade tamper resistance. The goal is to raise the cost of evading detection above the cost of just doing the homework. A motivated attacker who reads the extension's source can defeat any single mechanism we build; what we want is for the easy paths (edit the JSON log, replay an old session, run Claude Code in another terminal) to leave detectable artifacts. We are explicit about this throughout, especially in §6.

---

## 2. Goals and non-goals

### Goals

- **G1.** Record a complete, timestamped log of all editing activity for an assignment, from project open to submission, with enough granularity to reconstruct the editing process on screen.
- **G2.** Make casual log tampering detectable (hash chain, signed session keys, server-side cross-checks at submission).
- **G3.** Detect edits made to assignment files outside VS Code (e.g., Claude Code, Codex CLI, manual file edits, `cp` from another file).
- **G4.** Provide course staff a web UI to replay a student's session at variable speed and step through edits, with a separate dashboard listing automated heuristic flags.
- **G5.** Roll out incrementally. v1 ships telemetry + minimal analyzer for staff; later versions add the replay UI and heuristic suite.

### Non-goals

- **NG1.** True tamper-proofness. Cryptographic chaining raises the bar but does not make the log unforgeable on a machine the student controls.
- **NG2.** Real-time streaming or network calls during the assignment. The Recorder is offline; the log is sealed and uploaded at submission. (Per product decision.)
- **NG3.** A general-purpose IDE telemetry product. This is scoped to assignment folders, detected by a marker file the course provides.
- **NG4.** Building the submission/upload integration. We define the artifact format; course staff decides how it rides along with Gradescope submissions.
- **NG5.** **Classifier-style "is this AI-generated?" scoring.** We do not train or use a model that outputs a probability that the code itself was AI-written. The v3 LLM review feature (§7.6) is different: it reasons over the _process log_ — pastes, external edits, timing — not over the code. Process evidence is defensible in an integrity hearing; "this code looks AI-written" is not.
- **NG6.** Supporting editors other than VS Code in v1. Future versions might add JetBrains or a CLI shim for terminal users.
- **NG7.** Automatic LLM review of every submission. LLM review (§7.6) is staff-initiated per-submission, not run automatically as part of ingestion.

### Success criteria

- v1: 80% of students complete at least one project using the extension without filing a bug; logs validate at submission time; staff can open a log in the Analyzer and see a timeline.
- v2: The heuristic suite flags >70% of submissions that staff manually identify as AI-assisted (measured on a labeled sample), with <10% false-positive rate at the flag-threshold staff chooses.

---

## 3. System overview

```
  ┌───────────────────────────────┐         ┌────────────────────────────┐
  │   VS Code (student machine)   │         │   Course-staff browser     │
  │                               │         │                            │
  │  ┌─────────────────────────┐  │         │  ┌──────────────────────┐  │
  │  │   Provenance Recorder     │  │         │  │  Provenance Analyzer   │  │
  │  │   (VS Code extension)   │  │         │  │  (web app, static)   │  │
  │  └────────────┬────────────┘  │         │  └──────────┬───────────┘  │
  │               │ writes        │         │             │ reads        │
  │               ▼               │         │             ▼              │
  │  .provenance/session.slog       │ ──────► │  .provenance/session.slog    │
  │  (append-only, hash-chained)  │ upload  │  (validated, replayed)     │
  └───────────────────────────────┘         └────────────────────────────┘
```

The system has two products that share one artifact: a `.slog` ("provenance log") file. The Recorder produces it; the Analyzer consumes it. The file format is the contract between them and is specified in §5.

There is no live server. The Recorder is purely local. The Analyzer is a static web app (loaded in the staff member's browser) that reads a `.slog` file the staff member opens locally or that's been attached to the student's submission record. This keeps the surface area small and avoids FERPA-flavored questions about a centralized telemetry database for v1. (A signed-bundle verification service is a v3 consideration; see §8.)

---

## 4. Provenance Recorder (VS Code extension)

### 4.1 Activation

The extension activates only when the workspace is recognized as an assignment. The recognition rule is:

- A file named `.provenance-manifest` exists at the workspace root.
- That file is a small JSON manifest signed by the course staff's offline signing key:
  ```json
  {
    "assignment_id": "hw03",
    "semester": "fa26",
    "issued_at": "2026-09-15T00:00:00Z",
    "files_under_review": ["hw03.py"],
    "sig": "<ed25519 signature over the above fields>"
  }
  ```
- The extension ships the **root** public key embedded in its source — not a course key. At Manifest 2.0 the course's authority comes from a root-signed `course_cert` that travels inline in the manifest, so one build serves every course; a 1.x manifest's payload signature is checked against an optional grandfathered course key instead (`PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX`). If the chain doesn't verify, the extension does nothing (no recording, no UI noise). This prevents the extension from quietly recording on any folder that happens to contain a file named `.provenance-manifest`.

The extension does **not** activate on arbitrary workspaces, and does **not** record anything outside the assignment folder. This is a deliberate privacy constraint: the recorder watches one folder and shuts up everywhere else.

Concretely, every document event subscription (`onDidOpenTextDocument`, `onDidChangeTextDocument`, `onDidSaveTextDocument`, `onDidCloseTextDocument`, `onDidChangeTextEditorSelection`) drops events whose document URI either (a) has a scheme other than `file` (excluding `vscode-userdata`, `output`, `git`, `untitled`, and other virtual schemes) or (b) is outside the activated workspace folder (detected by `workspace.asRelativePath(uri)` returning the unchanged absolute `fsPath`). This guard applies uniformly to live events and to the startup catch-up loop that emits synthetic `doc.open` for documents already open at activation. Files like the student's user-level `settings.json` or tool-written scratch files outside the workspace must never appear in a `.slog`.

On activation, the extension shows a non-dismissible status bar item ("Provenance: recording") so the student is always aware that telemetry is active. This is both an ethical disclosure and a usability signal — if the indicator disappears, something is wrong.

### 4.2 What is recorded

Events are recorded as discrete entries in the session log. Each event has a common envelope:

```
{
  "seq": <monotonic integer, starts at 0>,
  "t":   <ms since session start>,
  "wall":<ISO 8601 UTC timestamp>,
  "kind":<event type, see below>,
  "data":<event-specific payload>,
  "prev_hash":<sha256 of previous entry's serialized JSON>,
  "hash": <sha256 of (prev_hash || this entry without the hash field)>
}
```

The hash chain is what makes mid-session tampering detectable: removing or modifying any entry breaks the chain at that point. (Discussed further in §6.)

Event types in v1:

| `kind`               | Trigger                                                                           | Payload (summary)                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.start`      | Extension activates on a valid assignment                                         | assignment_id, machine_id, extension_version, VS Code version, OS, list of all currently installed extensions with versions                                                                            |
| `session.heartbeat`  | Every 30s while VS Code is open                                                   | window focused (bool), active file, idle since (ms)                                                                                                                                                    |
| `session.end`        | VS Code closes or workspace switches                                              | reason                                                                                                                                                                                                 |
| `doc.open`           | A workspace file is opened (or was already open at session start — see §4.2.1)    | relative path, sha256 of full content, line count, content if ≤ 64 KB (else `truncated: true`). Old recorders (pre-v1.1) may omit content; analyzer treats such files as starting empty (best-effort). |
| `doc.change`         | A `TextDocument` change event fires                                               | relative path, list of `{range, text}` deltas, source classification (see below)                                                                                                                       |
| `doc.save`           | File saved                                                                        | relative path, sha256 of full content                                                                                                                                                                  |
| `doc.close`          | Editor closed                                                                     | relative path                                                                                                                                                                                          |
| `paste`              | A paste is detected (see §4.3)                                                    | relative path, target range, pasted text length, pasted text sha256, pasted text _content if ≤ 64 KB, otherwise truncated to first/last 512 bytes + length_                                            |
| `selection.change`   | Cursor or selection moves                                                         | relative path, range, was_selection (bool)                                                                                                                                                             |
| `focus.change`       | VS Code window focus changes                                                      | gained or lost, reason if available                                                                                                                                                                    |
| `terminal.open`      | Integrated terminal opens                                                         | terminal id, shell                                                                                                                                                                                     |
| `terminal.command`   | A command is run in the integrated terminal                                       | terminal id, command text (best-effort — see §4.4)                                                                                                                                                     |
| `ext.snapshot`       | At session start and every 5 min                                                  | list of `{id, version, enabled}` for all installed extensions                                                                                                                                          |
| `ext.activate`       | Another extension activates while we're recording                                 | extension id, version                                                                                                                                                                                  |
| `fs.external_change` | A file in the workspace changed _without_ a corresponding `doc.change` (see §4.5) | relative path, old_hash, new_hash, detected_at                                                                                                                                                         |
| `git.event`          | Git operation observed via the Git extension API                                  | operation (commit/checkout/etc), commit sha if applicable                                                                                                                                              |
| `clock.skew`         | Wall clock jumps non-monotonically                                                | delta_ms                                                                                                                                                                                               |

**§4.2.1 — Activation-time documents and initial content (recorder v1.1+)**

VS Code's `onDidOpenTextDocument` only fires for files that open _after_ extension activation. Files that were already open when the extension started produce no `doc.open` event via the subscription. The recorder (v1.1+) addresses this by iterating `vscode.workspace.textDocuments` synchronously at activation and emitting a synthetic `doc.open` for each in-workspace file-scheme document.

Additionally, every `doc.open` event in v1.1+ carries the file's initial content (up to 64 KB UTF-8). Files larger than 64 KB get `truncated: true` instead. The analyzer uses this to seed its content-reconstruction model so that the first `doc.change`'s deltas resolve against the actual file state rather than an empty buffer.

**Backwards compatibility:** A pre-v1.1 recorder may not emit `doc.open` for files already open at activation, and will not include `content` in the `doc.open` payload. The analyzer handles this gracefully: it starts reconstruction from an empty string (best-effort) when `content` is absent.

**What we deliberately do not record:**

- Keystrokes as keystrokes. We record `doc.change` events, which are the IDE's diff between successive document states. A student typing "hello" produces five `doc.change` events with inserts of "h", "e", "l", "l", "o" — but if they paste, the IDE delivers it as one event with insert "hello". This is the natural granularity of the VS Code API and is what lets us distinguish typing from pasting. We don't hook the OS keyboard.
- File contents outside the assignment folder.
- Clipboard contents in general. The only clipboard-adjacent thing we capture is the paste payload, which by definition was just inserted into an assignment file.
- Anything when the extension isn't activated (i.e., outside a recognized assignment folder).

### 4.3 Paste detection

VS Code does not expose a "this change was a paste" flag directly. We approximate paste detection with three signals, combined:

1. **Bulk-insertion classifier.** A `doc.change` is classified as paste-shaped if ANY of:
   - a single delta contains text ≥ 30 characters (covers classical clipboard pastes AND single-shot replacement edits, e.g. an AI assistant rewriting a block of code)
   - the aggregate of inserted text across all deltas is ≥ 30 characters AND at least one delta's text contains a newline (covers multi-delta `WorkspaceEdit`s produced by tools like Claude Code and Copilot's "Apply", without misclassifying multi-cursor typing — which produces several small single-line deltas without embedded newlines)

   Emit path. The governing rule is: **never emit a `paste` event the analyzer cannot replay.** A `paste` whose payload lost its content is strictly worse than a `doc.change` that kept it — `applyPaste` returns `applied: false` and reconstruction for that file dies from that point onward, while a `doc.change`'s deltas always replay faithfully.

   The recorder emits `kind: "paste"` only when BOTH conditions hold, corresponding to the two independent reasons a paste can fail to replay:
   - **Shape** — a single delta inserted at an empty range. `PastePayload` carries exactly one range and one text, so a multi-delta `WorkspaceEdit` spanning disjoint ranges cannot be expressed without collapsing them.
   - **Size** — the inserted text is at most `MAX_INLINE_BYTES` (§4.2, currently 64 KB, measured in UTF-8 bytes). Above the cap the payload carries only a head/tail preview, which `applyPaste` cannot apply. Recorders read this threshold from the same constant the payload builder uses, so it tracks the cap automatically; raising the cap narrows this hole, but only the gate closes it.

   Everything else — multi-delta events, large replacement edits (non-empty range), and single-range pastes above the cap — emits `kind: "doc.change"` with `source: "paste_likely"` so the analyzer applies each delta faithfully via `applyDocChange`. **No signal is lost by this routing:** the analyzer's candidate-paste iterator treats a `doc.change` with `source` of `"paste_likely"` or `"paste_confirmed"` as a candidate paste, so every paste heuristic still sees the event. The `source` field has been part of `DocChangePayload` since format v1.0; this routing is schema-compatible.

   _Failure mode this prevents._ Before the size condition existed, an over-cap single-range paste emitted a `paste` event whose content had been truncated to head/tail. One term-1 submission with zero genuine external-change gaps still reconstructed at only 1 of 266 save checkpoints — killed outright by a single large paste. The shape condition had been applied since v1.0; the size condition had not, and the routing comment described only the shape reason, which is why the gap survived a year of review.

   _History._ The v1 classifier required exactly one delta at an empty range with text ≥ 30 chars and routed every match through `paste`. That missed tool-applied edits — they slip in as either multi-delta `WorkspaceEdit`s or single replacements with a non-empty range — and a student using Claude Code's "Apply" appeared in the log as ordinary typing. The broader rule above closes that gap.

2. **Editor `paste` command intercept.** We register a command handler that wraps the default `editor.action.clipboardPasteAction` and emits a `paste` marker immediately before the resulting `doc.change` fires. Pairing the two by `seq` gives us a high-confidence label.
3. **Paste-count reconciliation.** We track our own command-handler-driven paste counts and compare against the count of bulk-insertion classifications. Mismatches indicate either programmatic edits or unusual input methods, and we record this discrepancy as a `paste.anomaly` event. This signal does not read the OS clipboard — the VS Code extension API exposes no such capability, consistent with "What we deliberately do not record" above. (The JetBrains and Neovim recorders, which have clipboard-read APIs available to them, additionally read the clipboard directly as a fourth signal; that is host-specific and not part of the VS Code recorder described in this document.)

For the payload itself: we store the full pasted text up to 64 KB inline, and a hash + truncated head/tail for anything larger. (The cap was 4 KB through v1.1. A `paste` event is not duplicated by a `doc.change`, so anything above the cap was unrecoverable in both reconstruction and the paste heuristics — a pasted solution, the case this event exists to catch, was routinely over 4 KB. Raising the cap is a threshold change only: `content` is an optional field, so old and new analyzers interoperate and `format_version` is unchanged.) Storing the content matters for review — staff need to see "did this student paste a working `accumulate` implementation, or did they paste an error message from Stack Overflow."

### 4.4 Terminal command capture

Terminal command capture in VS Code is partial. The extension API exposes `window.onDidOpenTerminal`, terminal exit events, and (since VS Code 1.93) "shell integration" events that provide command lines and exit codes when the user has enabled it.

Our approach:

- If shell integration is active, we get command text and exit codes — good.
- If not, we record `terminal.open` and `terminal.close` events and the fact that a terminal was active during a given window of time, but not what was typed.
- We record this gap explicitly: every `terminal.open` event includes a `shell_integration: true|false` field, so the Analyzer can reason about _what we could and couldn't see_.

This matters because students who use Claude Code or Codex from a terminal are a major detection target. Even when we can't see the commands, we can see (a) that a terminal was open, (b) that files changed while it was open, and (c) that those changes didn't correspond to `doc.change` events in our log — the `fs.external_change` signal in §4.5.

### 4.5 Detecting edits made outside VS Code

This is one of the most important detection capabilities and worth describing in detail.

For each file in the assignment's `files_under_review` list, the extension keeps an in-memory model of what the file's content _should_ be, based on the sum of `doc.change` events we've recorded since the last save. External edits show up via three detection paths, each catching a different scenario; all three emit the same `fs.external_change` event so downstream consumers see one uniform signal.

1. **Save-time hash check.** When a `doc.save` fires for a watched file, we read the on-disk content and compute its sha256, comparing against our expected hash:
   - **Match:** normal save. Record `doc.save` with the hash.
   - **Mismatch:** something edited the file between our last observed change and the save. Record `fs.external_change`, then `doc.save` with the post-mismatch hash. Reset the expected-content model from the on-disk content so subsequent edits chain from reality.

2. **`FileSystemWatcher`.** A `vscode.workspace.createFileSystemWatcher` is registered for each file in `files_under_review`. Its `onDidChange` callback fires for any disk-level write — including writes that happen when VS Code is unfocused or has the file closed entirely. We compare the on-disk hash against our expected hash and emit `fs.external_change` on mismatch. A 250 ms tolerance window suppresses the duplicate notification VS Code's watcher inevitably fires for the same write that just round-tripped through `doc.save`.

3. **Reload-from-disk detection in the `doc.change` handler.** When an external tool writes a watched file while VS Code has a clean buffer open on it, VS Code auto-reloads the buffer from disk. The reload fires `onDidChangeTextDocument` with `event.reason === undefined` and `event.document.isDirty === false` — a combination typed edits and programmatic `WorkspaceEdit`s never produce (both leave the buffer dirty). When the recorder sees this combination on a watched file, it emits `fs.external_change` directly from the doc handler, resets the expected-content model, and suppresses the would-be `doc.change` for the reload. Without this path the auto-reload looks indistinguishable from an AI assistant's "Apply" — that's the §4.3 paste classifier's domain, not ours — and the external edit is silently mis-classified.

The combined paths cover the three meaningful states VS Code can be in relative to a watched file: file closed (path 2), file open but buffer dirty/being-saved (path 1), file open with a clean buffer (path 3).

This is the primary signal for Claude Code / Codex CLI use from outside VS Code: those tools edit files directly on disk, not through VS Code's text editor API, so they produce `fs.external_change` events with no corresponding `doc.change` history. A student who writes code by prompting Claude Code in a separate terminal will leave a log full of `fs.external_change` events and almost no `doc.change` events — a very clean signal regardless of whether VS Code was looking at the file at the time.

The payload carries `old_hash`, `new_hash`, `diff_size`, and the post-change content: full text inline if ≤ 64 KB, otherwise `new_content_head` + `new_content_tail` truncations plus `new_content_size`. The content is what lets the analyzer reseed reconstruction and paint the affected region in replay — without it the file would have to be tainted at the external-edit point. (The cap was 4 KB through v1.1, which meant any real-sized source file was unrecoverable by construction and `mass_external_replacement` could not evaluate the change at all. Same threshold-only change as §4.3: `new_content` is optional, `format_version` is unchanged.)

False positives to handle: linters/formatters that rewrite files on save (Black, Prettier), and Git operations. We special-case these by checking whether the change was preceded by a known formatter command or a `git.event`. Anything we can't explain stays flagged.

### 4.6 Storage and format

The log is written to `<workspace>/.provenance/session-<uuid>.slog`. The format is newline-delimited JSON: one event per line, each line a complete JSON object with its hash chain field. Append-only writes via `fs.appendFile`; we never rewrite earlier lines.

A companion `session-<uuid>.slog.meta` file holds:

- The session UUID
- A per-session ephemeral signing keypair (private key encrypted with a key derived from the `.provenance-manifest` manifest's signature — this means it can't be recovered without the manifest, raising the bar for replay attacks)
- The chain of `seq → hash` checkpoints, signed every N events

Both files are written atomically (write to `.tmp`, fsync, rename). On startup, the Recorder validates any previous `.slog` files. If the chain is broken, it quarantines the offending file (renames it to `<file>.corrupt-<ISO timestamp>`), starts a new session, and emits a `recorder.recovered_from_corruption` event in the new session whose payload references the quarantined path. We don't try to "fix" tampering by silently dropping records, and we don't continue writing into a chain we can't validate — the quarantined file is preserved for the analyzer's `validate_chain` step to inspect.

A submission-ready bundle is produced by a "seal" operation:

```
.provenance/
  session-<uuid>.slog       # full event log
  session-<uuid>.slog.meta  # signing metadata
  manifest.json             # bundle manifest (assignment_id, session count, file hashes)
  manifest.sig              # signature over manifest.json using the session signing key
```

The seal operation is triggered by a VS Code command (`Provenance: Prepare Submission Bundle`). The bundle is what course staff pick up. Format details are in §5.

### 4.7 Performance and footprint

Constraints:

- Memory: the in-memory event buffer must not exceed 50 MB. We flush to disk every 1 s or 256 KB, whichever comes first.
- CPU: doc.change handlers must run in < 1 ms p99 on a typical student laptop. Hashing is incremental (we maintain a running SHA-256 state per file, not a re-hash from scratch).
- Disk: a 4-hour project session should produce < 20 MB of log. The inline-content truncation rule (§4.2) is the main lever here — it caps how much of a pasted or externally-written blob any single event carries.
  - That cap was raised from 4 KB to 64 KB (see §4.3 and §4.5), which deliberately weakens the lever, so the headroom is restated here. The events it governs are rare: a `paste` fires when a student pastes, and an `fs.external_change` only on a genuine external write. Each such event grows from ~1 KB (512-byte head + 512-byte tail) to at most 64 KB. A realistic session carries on the order of 10 over-cap events, at a typical source-file size of 10–20 KB, so roughly **+150 KB**; a pathological session with 15 events all at the full cap adds **~1 MB**. Against a 20 MB budget that is about 5% in the worst case, so the constraint holds.
  - This estimate assumes the D1 save-time race is fixed. Before that fix the recorder emitted roughly 21 false `fs.external_change` events per session; at 64 KB each those alone would have exceeded the budget. **The cap raise is only sound in combination with that fix** — do not port one without the other.
- The extension should not block typing under any circumstance. All disk I/O is async; all hashing happens on a worker thread.

### 4.8 Failure modes

| Failure                                                                   | Behavior                                                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disk full                                                                 | Surface a notification; switch to a tiny in-memory ring buffer for critical events only; emit `recorder.degraded` event                                    |
| Log file corrupted on startup                                             | Quarantine (rename to `.corrupt`), start a new session, emit `recorder.recovered_from_corruption` event in the new session referencing the quarantined one |
| Extension crashes                                                         | VS Code will reload it; on reload, we open a new session, link it to the previous via the `prev_session_id` field, and continue                            |
| Manifest trust chain fails to verify against the embedded root public key | Don't activate; log nothing                                                                                                                                |
| User uninstalls the extension mid-assignment                              | We can't prevent this. The submission bundle will be missing or incomplete; the Analyzer flags this at upload time. Course policy decides the consequence. |

---

## 5. Log file format (`.slog`)

The format is the contract between Recorder and Analyzer, and is the longest-lived artifact. We version it from day one.

### 5.1 Header

The first line of every `.slog` file is a special `session.start` event with `seq: 0` containing:

```json
{
  "seq": 0,
  "t": 0,
  "wall": "2026-09-15T18:42:11.034Z",
  "kind": "session.start",
  "data": {
    "format_version": "1.0",
    "session_id": "<uuid>",
    "prev_session_id": null,
    "assignment": { "id": "hw03", "semester": "fa26" },
    "manifest_sig": "<copy of .provenance-manifest sig, for binding>",
    "machine_id": "<sha256(stable machine ID + session salt)>",
    "vscode": { "version": "1.97.0", "commit": "...", "platform": "darwin-arm64" },
    "recorder": { "version": "1.0.0", "extension_id": "..." },
    "session_pubkey": "<ed25519 public key for this session>"
  },
  "prev_hash": "0000...",
  "hash": "<sha256>"
}
```

`format_version` is mandatory and the Analyzer rejects unrecognized majors. We will not break v1 readers when we add v1.1 events; new event kinds are additive and old readers should treat unknown `kind` values as opaque (skip in heuristics, show in raw timeline).

### 5.2 Body

One event per line, JSON, as specified in §4.2. The chain rule is:

```
entry.prev_hash == previous_entry.hash
entry.hash == sha256(prev_hash + canonical_json(entry without "hash"))
```

`canonical_json` is JCS (RFC 8785) — we don't want pretty-print whitespace to change hashes.

### 5.3 Bundle

Submission bundle = ZIP of `.provenance/` directory. The Analyzer accepts the ZIP directly.

### 5.4 Bundle validation (Analyzer-side)

When a bundle is loaded, the Analyzer runs these checks in order and produces a `validation_report` shown above the timeline:

1. Bundle manifest signature verifies against the session_pubkey.
2. session_pubkey is bound to the `.provenance-manifest` manifest_sig (proves this session was started against a real course-issued assignment).
3. Hash chain is intact end-to-end.
4. No `seq` gaps.
5. `t` is monotonically non-decreasing.
6. `wall` is monotonically non-decreasing modulo `clock.skew` events.
7. Per-file `doc.save` hashes are consistent with the sum of `doc.change` events between saves (mod known formatters).
8. Final saved-file hashes match the hashes of the files in the student's submitted code (course-staff cross-check — supplied separately).

Any failure produces a hard flag on the submission. The flag is informational, not punitive: tampering, a crashed Recorder, and a corrupted disk all look similar from the outside, and a human decides what to do.

**Notes on optional / best-effort fields:**

- `session.start.vscode.commit` may be the empty string. The VS Code public API doesn't expose the build commit, and the v1 recorder doesn't read the unofficial `product.json` path. Validators must accept `''` here without treating it as a structural failure.

---

## 6. Tamper resistance: what works, what doesn't, what we're honest about

### What does work

- **Mid-stream edits are detectable.** Modifying any event after the fact breaks the hash chain at that point. The student would have to recompute every hash from the modified point to the end and re-sign the bundle manifest.
- **Re-signing the bundle requires the session private key,** which is encrypted with a key derived from the course-issued manifest signature. Recovering it requires either reverse-engineering the encryption (the algorithm is in our source, so this is bounded difficulty) or capturing the key from memory during a real session.
- **Replay of an old session** is detectable because every session binds to a specific `manifest_sig`, which the course rotates per assignment. You can't replay last week's session for this week's assignment.
- **`fs.external_change` events** are emitted by the Recorder itself based on real-time disk observation. Producing a clean log that avoids them requires either disabling the Recorder (detectable: gap in heartbeats, missing checkpoints) or producing forged `doc.change` events that exactly reproduce a plausible typing pattern (high effort).

### What doesn't work

- **A student who reads our extension source can extract the manifest-derived key once they have a valid `.provenance-manifest` manifest.** They can then produce a fully-valid forged log. The course's only defense is (a) requiring submission of the bundle promptly (less time to forge), (b) keeping the forge cost — writing a tool that synthesizes a believable editing session — high enough that students just do the homework, and (c) sampling: even if forgeries are undetectable in isolation, statistical anomalies across many students surface.
- **Running a parallel VS Code without the extension** and copying files into the watched workspace at the end produces an `fs.external_change` event but is otherwise hard to attribute. The Analyzer flags it; a human decides.
- **Modifying our extension to silently drop events** is a meaningful attack and we acknowledge it. We mitigate by shipping the extension as a signed VSIX from a course-controlled source and checking the extension's own hash at submission time. A student running a modified build will have an `extension_hash` field in the bundle manifest that doesn't match the course-known good hash. They can also forge that field — see preceding bullet.

### What this means for the PRD

We do not promise the log is tamper-proof. We promise that:

- Casual tampering (open file, edit JSON, save) is detected.
- Reasonable-effort tampering (replay, partial forge) is detected.
- High-effort tampering (full forge with correct keys) requires more work than the assignment.

That last bullet is the actual product claim. It's a deterrent, not a cryptographic guarantee. Course staff should communicate this honestly to students: "we will know if you do something obvious, and we will know enough to ask questions if you do something subtle."

---

## 7. Provenance Analyzer (web app)

### 7.1 Architecture

A static single-page app (React + Vite, TypeScript). No backend. The user opens a `.slog` bundle by file picker or drag-and-drop; everything happens in the browser. Crypto via the Web Crypto API. ZIP via JSZip. This avoids running a server with student data on it for v1, which is the right default given FERPA-flavored sensitivities.

A future v3 might add a server-side bulk-review mode for staff (load all submissions for an assignment, sort by flag score). That's a separate design.

### 7.2 Views

**Submission overview.** The landing view after loading a bundle. Shows:

- Validation report (§5.4).
- Summary stats: session count, total active time, total idle time, file list, lines of code added/removed.
- Heuristic flag dashboard (§7.4).
- Buttons: "Open replay," "Open raw timeline," "Export findings."

**Replay view.** The core manual-review tool. Renders the assignment files in a Monaco editor (same engine VS Code uses, so the visual fidelity is high) and steps through `doc.change` events, applying them in order. Controls:

- Play / pause / step / scrub.
- Variable speed (0.25× to 32×).
- Jump to: next paste, next external change, next flag, next file-switch.
- A right-hand sidebar showing the event log scrolling in sync.
- Color-coded gutter: paste regions in orange, external-change regions in red, normal typing uncolored.
- Hover any line to see "this line was last modified at t=…" and the event chain that produced it.

**Raw timeline.** A scrollable, filterable list of every event in the log. For staff who want to see exactly what happened without the replay abstraction. Filterable by `kind`, by file, by time range.

**Heuristic detail view.** For any flag in the dashboard, click in to see the supporting evidence (specific events, time ranges, sample paste contents).

### 7.3 Performance

Bundles up to ~50 MB load in < 5s on a mid-tier laptop. The event log is indexed in-memory on load (by `seq`, by `kind`, by file) to make replay scrubbing instant. For very large bundles we lazy-build per-file editor state and use a virtualized list for the raw timeline.

### 7.4 Heuristics suite

Heuristics are deterministic rules over the event stream. Each produces a flag with:

- A name and short description.
- A severity (info / low / medium / high).
- A confidence score (heuristic-specific; not probabilistic, just "how loud is this signal").
- A list of supporting event `seq` numbers.
- A jump-to-replay link.

The v1 heuristic suite below is a starting set. We expect to add and tune. For the live, code-linked catalog of what's currently implemented (with configurable thresholds and source-file pointers), see [`docs/heuristics.md`](./heuristics.md).

**Process-shape heuristics:**

| Name                         | Detects                                                                                | Logic                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `large_paste`                | Paste of substantial code                                                              | Single paste with text length ≥ 200 chars or ≥ 10 lines                                                                                                                                                             |
| `paste_is_solution`          | Paste that closely matches the final submitted file                                    | Pasted content has > 80% line overlap with the file's final state                                                                                                                                                   |
| `external_edits`             | Edits outside VS Code                                                                  | Any `fs.external_change` event not preceded by a known formatter                                                                                                                                                    |
| `mass_external_replacement`  | Whole-file replacement outside VS Code                                                 | `fs.external_change` where new content shares < 20% lines with old                                                                                                                                                  |
| `low_typing_high_output`     | Output far exceeds typed input                                                         | (net chars added: `finalLength` − `startLength`) / (chars typed via `doc.change` inserts with `source: "typed"`) > 3. Skipped entirely when the net delta is ≤ 0 (file shrank or stayed the same — see note below). |
| `time_to_first_save_anomaly` | File appeared faster than plausibly typed                                              | < 30s from doc.open to a save containing > 500 chars of new code                                                                                                                                                    |
| `idle_then_complete`         | Long idle followed by completed solution                                               | Idle > 10min, then a single save brings the file from skeleton to complete                                                                                                                                          |
| `no_intermediate_errors`     | Code arrives without the usual failed-run pattern                                      | File goes from empty to passing-tests with zero terminal commands that exit non-zero                                                                                                                                |
| `paste_matches_known_source` | Paste text matches a known source (course solution leak, common Stack Overflow answer) | Hash or fuzzy match against a course-maintained corpus (v2)                                                                                                                                                         |

**Environment heuristics:**

| Name                                     | Detects                                                                | Logic                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ai_extension_active`                    | A known AI-assistant extension was active                              | Any extension in a course-maintained list (Copilot, Codeium, Continue, etc.) was enabled during the session — informational, not by itself an integrity flag |
| `terminal_active_during_external_change` | A terminal was open when files changed outside VS Code                 | Suggests CLI tool use; informational                                                                                                                         |
| `extension_set_changed_mid_assignment`   | Extensions were installed/enabled while the assignment was in progress | An `ext.activate` for a new AI tool mid-session is interesting                                                                                               |
| `shell_integration_disabled`             | We couldn't see terminal commands                                      | Informational; raises the prior on terminal-related flags                                                                                                    |

**Integrity heuristics:**

| Name                        | Detects                                                      | Logic                                                      |
| --------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| `chain_broken`              | Hash chain failed validation                                 | Hard flag, position recorded                               |
| `clock_jumps`               | Significant `clock.skew` events                              | Multiple skews or one large one (> 5min)                   |
| `gap_in_heartbeats`         | Recorder appears to have been suspended                      | Heartbeat gap > 5min with no `session.end`/`session.start` |
| `multiple_sessions_overlap` | Two sessions claim the same time                             | Possible second VS Code instance running                   |
| `extension_hash_mismatch`   | The Recorder's own code hash doesn't match course-known good | Modified extension                                         |

**Cross-submission heuristics (v2+, requires staff loading multiple bundles):**

- `paste_shared_across_students`: identical large pastes in different students' logs.
- `editing_pattern_clone`: students whose event sequences are anomalously similar (timing, file-switch order).

The dashboard sums weighted severity into a single review-priority score, but the score is never the verdict — it's a sort order for staff triage.

**Note on `low_typing_high_output` (net-delta semantics).** The v1 specification used the file's _absolute_ final length in the numerator: `finalLength / charsTyped`. In practice that fired on every student who opened a non-trivial skeleton — a 500-char starter that a student grew to 550 with 50 keystrokes gives an 11× ratio, even though the student wrote everything in the file. The PRD's own §7.6.3 example acknowledges this exact false positive. The refined rule uses the **net delta** — `finalLength − startLength` — so only chars the student actually _added_ count as output. `startLength` is read from the first `doc.open` event's inlined `content` (recorder v1.1+); older bundles fall back to `startLength = 0`, which matches the v1 numerator behavior. When the net delta is ≤ 0 (the file shrank or stayed the same) the heuristic emits no flag. The "chars typed" denominator also excludes any `doc.change` deltas whose `source` is `paste_likely` or `paste_confirmed` (per §4.3) — those characters never came from the keyboard.

### 7.5 Export

The Analyzer can export a findings document (PDF or markdown) for inclusion in academic integrity case files. The document includes the validation report, the flag list with supporting evidence, screenshots of key replay moments, and a checksum of the input bundle.

### 7.6 LLM-assisted review (v3)

After the heuristic suite and replay UI are stable, we add an optional LLM-based deep review. This is the last feature in the roadmap because it depends on every other piece working: the LLM reasons over structured artifacts produced by the rest of the Analyzer, not over raw logs.

#### 7.6.1 When it runs

LLM review is **staff-initiated, per-submission.** A reviewer who is already looking at a flagged submission clicks "Run LLM Review" in the Analyzer. There is no batch mode that runs on every submission automatically. Reasons:

- Cost. Sending every submission through a frontier model is wasteful; most submissions don't warrant it.
- Optics. We do not want a system where "the AI flagged this student." Every LLM review is explicitly requested by a human who then reads the output and decides what to do with it.
- Bias control. Auto-triage where the LLM sets the priority order could systematically miss patterns the deterministic heuristics catch, or hallucinate patterns that aren't there. Heuristics first, LLM second.

Staff can also run LLM review on a submission that _passed_ heuristic checks, if they have an independent reason to look (a tip, a peer report, suspicious code style). This matters: the LLM is a tool for human reviewers, not a gate.

#### 7.6.2 What the LLM receives

We do **not** dump the raw `.slog` into a prompt. The Analyzer pre-digests the bundle into a structured review packet:

1. **Validation report** (§5.4 output): chain status, signature checks, any integrity flags.
2. **Heuristic findings**: every flag from §7.4 that fired, with its severity, supporting event seqs, and a short evidence excerpt.
3. **Paste inventory**: every `paste` event, with content (truncated per §4.2), target file, and timing.
4. **External-change inventory**: every `fs.external_change` event with old/new content diffs.
5. **Timeline summary**: a downsampled view of the editing process — per-file, per-5-minute buckets of (chars typed, chars pasted, chars externally changed, idle time, terminal activity).
6. **Final file contents** of files under review.
7. **Submission metadata**: assignment id, course-provided spec or rubric if available.

This packet is typically 20–100 KB of structured text — well within context limits and cheap to process. The prompt instructs the model to:

- Identify the 3–5 most suspicious moments in the timeline, with specific event seq references.
- For each suspicious moment, explain what's anomalous and what benign explanations also fit.
- Comment on the overall shape of the process (typing-dominant, paste-dominant, external-edit-dominant, mixed).
- Flag any heuristic findings that the LLM thinks are likely false positives, with reasoning.
- Produce a single overall assessment on a 4-point scale: `no_concern` / `minor_concern` / `concerning` / `strong_concern` — with the explicit instruction that this is advisory and not a verdict.

#### 7.6.3 Output format

The LLM must return structured JSON (we use the API's structured output / tool-use mode, not free-form prose parsing):

```json
{
  "overall_assessment": "concerning",
  "summary": "Short paragraph for the reviewer.",
  "key_moments": [
    {
      "title": "Large paste of complete `accumulate` implementation",
      "event_seqs": [1247, 1248],
      "concern": "A 38-line paste at t=02:14:33 introduces the entire working implementation of a function that had no prior edit history in this session.",
      "benign_explanations": [
        "Student may have written the function in a scratch file and pasted it in.",
        "Student may have copied from their own earlier work."
      ],
      "severity": "high"
    }
  ],
  "false_positive_candidates": [
    {
      "heuristic": "low_typing_high_output",
      "reasoning": "Output is high because the student deleted a 200-line skeleton, not because they typed little."
    }
  ],
  "process_shape": "paste-dominant",
  "caveats": "The LLM cannot determine intent. All findings require human verification.",
  "model": "claude-...",
  "ran_at": "2026-..."
}
```

The Analyzer renders this as a report panel with each `key_moment` showing a "Jump to replay at seq=…" link, so the reviewer can verify every claim against the actual log in one click. **No LLM claim is ever shown without a way to verify it.**

#### 7.6.4 Where it runs

Three deployment options, in order of preference:

1. **Staff supplies their own API key.** Stored in the Analyzer's browser local storage, never transmitted anywhere except directly to the model provider. Simplest, most private, no course infrastructure needed.
2. **Course-run proxy.** A small Berkeley-hosted service that holds the API key and forwards requests from authenticated staff browsers. Better for cost control and audit logging. Adds infrastructure.
3. **Local model fallback.** A locally-runnable smaller model (e.g., via Ollama) for environments where outbound API calls aren't permitted. Lower quality but private.

In all cases the data sent to the model is the review packet (§7.6.2), which contains code the student wrote, pastes they made, and timing. This is the same data staff already see in the Analyzer; sending it to an LLM is a derivative use that should be covered by the course's data-use disclosure. Worth a privacy review before turning this on.

#### 7.6.5 Auditability

Every LLM review run is logged as an artifact attached to the submission record in the Analyzer:

- Input packet hash (so we can prove what the model saw).
- Model and version.
- Full JSON response.
- Timestamp and which staff member ran it.

A second reviewer can rerun the review (or run a different model) and compare. If a student contests an integrity finding, the LLM review record is part of the case file and the student can request a re-review.

#### 7.6.6 Known limitations

- **Hallucination.** The model may cite event seqs that don't exist or describe events inaccurately. The "jump to replay" affordance is the primary defense — every claim is verifiable in one click. The Analyzer also post-validates that referenced event seqs actually exist in the bundle and flags any that don't.
- **Sycophancy / pattern-matching to the prompt.** If we phrase the prompt as "find what's suspicious," the model will find something suspicious in every submission. The prompt explicitly instructs the model that `no_concern` is a valid and common output and that overconfident findings are worse than humble ones. We monitor the distribution of `overall_assessment` values across reviews; if it skews toward `concerning`/`strong_concern` on submissions humans rate clean, the prompt needs rebalancing.
- **Not a classifier.** The LLM is reasoning over process evidence, not detecting AI-written code. The prompt forbids claims like "this code was written by an LLM" — only claims like "this code appeared via a paste at this timestamp."
- **Cost.** A single review packet is small but a high-volume class running this on hundreds of submissions per assignment adds up. Staff-initiated triggering keeps this bounded.

---

## 8. Roadmap

**v1 (MVP) — target: a single project early in the semester.**

- Recorder: activation, all event types in §4.2 except cross-session linking, paste detection, external-change detection, hash chain, bundle seal.
- Analyzer: bundle load + validation, raw timeline view, three or four highest-value heuristics (`large_paste`, `external_edits`, `low_typing_high_output`, `chain_broken`).
- No replay UI yet. Staff reviews from the raw timeline.

**v2 — target: roll out across all projects, plus labs.**

- Replay UI (Monaco-based, scrub/step/speed controls).
- Full heuristic suite from §7.4.
- Findings export.

**v3 — target: after v2 is stable in production for at least one semester.**

- **LLM-assisted review (§7.6).** Staff-initiated deep review of suspicious submissions. The capstone feature; depends on the heuristic suite and replay UI being mature, since the LLM reasons over their outputs.
- Cross-submission heuristics over a batch of bundles (`paste_shared_across_students`, `editing_pattern_clone`).
- Optional submission-time server verification (a course-run service that re-validates the bundle and stamps it; reduces the forgery window).
- Support for non-VS-Code editors via a lightweight CLI shim.

---

## 9. Privacy, ethics, and policy considerations

This section is not a legal review. It flags issues the team and course staff should resolve before deployment.

- **Disclosure.** Students must be told the extension exists, what it records, and why, before they install it. The status bar indicator (§4.1) is the in-product disclosure; a syllabus statement is the policy-level disclosure.
- **Data minimization.** The Recorder only watches assignment folders, only stores paste contents up to a size limit, and never transmits during the assignment. Logs live on the student's machine until they choose to submit.
- **Retention.** Course staff should define a retention policy for log bundles (e.g., delete after the semester's grade dispute window closes).
- **Right of review.** A student accused based on Analyzer flags should be able to see the same bundle and replay we used. The Analyzer exporting findings + the bundle being a single file makes this straightforward.
- **False positives.** Every heuristic in §7.4 has plausible benign explanations (paste from your own notes; reformatting on save; pair programming). The Analyzer is a triage tool, not a verdict. Course staff training material should emphasize this.
- **Accessibility.** Students using screen readers, voice input, or other AT will produce unusual event patterns. The extension should record an opt-in `accessibility_mode` field that suppresses certain heuristics during review. (Course staff handles the opt-in workflow.)

---

## 10. Open questions

1. **Marker file distribution.** How does a student get the `.provenance-manifest` manifest into their project folder? Bundled with the starter code? Generated by `ok` on first run? This affects what counts as "assignment opened."
2. **Multiple machines.** Students who work on both a laptop and a lab computer will produce two separate sessions. We chain them via `prev_session_id`, but the chaining is self-asserted. Is that good enough?
3. **Pair programming.** Some projects allow pairs. How should we handle two students editing one repo? (Probably: each runs the extension on their own machine, both bundles are submitted, the Analyzer correlates.)
4. **Course solution corpus for `paste_matches_known_source`.** What's in it, who maintains it, how is it kept out of student hands?
5. **Threshold tuning.** Heuristic severity weights will need calibration on real data. We'll need a labeled set of past submissions (known clean, known cheated) to tune against.
6. **Communication to students.** A blunt "we are surveilling your editing" announcement will land differently than "here's a tool to help establish your authorship if your work is ever questioned." The framing matters for adoption.
7. **LLM-review data handling.** Running §7.6 sends student code and editing telemetry to a third-party model provider. This is a derivative use of data the student submitted to the course; whether it requires additional disclosure (beyond the general "we record your editing process") is a question for Berkeley's privacy review. The course-run proxy option (§7.6.4) gives the cleanest audit story but costs infrastructure.

---

## 11. Glossary

- **Bundle.** The ZIP of `.provenance/` containing the session log and signing metadata; the unit of submission.
- **`.provenance-manifest` manifest.** The course-signed file in the assignment folder that authorizes recording.
- **Event.** A single line in the `.slog`, with hash chain.
- **`fs.external_change`.** An event indicating a file changed on disk without a corresponding `doc.change`; the primary signal for outside-VS-Code edits.
- **Flag.** A heuristic finding shown in the Analyzer.
- **Recorder.** The VS Code extension.
- **Analyzer.** The web app.
- **Seal.** The operation that finalizes a bundle for submission.
- **Session.** One contiguous run of the Recorder against an assignment folder, bounded by `session.start` and `session.end`.
