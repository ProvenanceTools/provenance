# Log size rotation: keeping every `.slog` under GitHub's file-size limits

**Repos:** `provenance` (VS Code recorder, `analysis-core` tests, PRD, `/architecture`),
`provenance-jetbrains-recorder`, `provenance-neovim-recorder`
**Date:** 2026-09-21
**Status:** Design, approved in conversation 2026-09-21.

---

## 1. Problem

For `submission: 'git'` assignments the student commits `.provenance/` to a GitHub repo.
GitHub warns on any file over 50 MB and rejects pushes containing a file over 100 MB.

Since nested manifest discovery shipped, a session lives for the editor's lifetime rather than
one launch-to-quit window. A student who leaves the editor open for days accumulates one
ever-growing `session-<uuid>.slog`. The PRD §4.7 budget is < 20 MB per 4-hour session, so a
multi-day session can plausibly cross 50 MB and, eventually, 100 MB — at which point the push is
refused and the student cannot submit.

## 2. Decision

**Rotate by ending the session and starting a new one.** When a session's log crosses a fixed
size threshold, the recorder ends the session cleanly (`session.end { reason: 'rotate' }`, full
teardown seal) and immediately starts a fresh session in the same scope whose
`prev_session_id` names the one that just ended.

Rejected alternative: **continuation segments within one session** (same `session_id`, one hash
chain spanning `…part2.slog` files). Truly continuous chain, but it changes the log-format
contract (loader pairing, rolling seal, `.slog.meta`), needs a `format_version` bump, and must be
ported to three hand-written recorders — for little integrity beyond what `prev_session_id` plus
per-session signed rolling manifests already give.

**No format change.** `SessionEndPayload.reason` is already a free-form string and
`prev_session_id` already exists in `session.start` and the bundle manifest. No `format_version`
bump, no conformance-vector change.

## 3. Recorder behaviour (all three recorders)

### 3.1 Trigger

- Constant `ROTATE_AT_BYTES = 40 * 1024 * 1024` (40 MiB), defined once per recorder. Not a
  manifest field: there is no known need for per-course tuning (YAGNI).
- 40 MiB sits under GitHub's 50 MB warning with ample headroom for a 256 KB in-flight flush and a
  handful of 64 KB over-cap payloads.
- Checked **at the existing checkpoint hook** (every `CHECKPOINT_INTERVAL` = 100 entries;
  VS Code: `packages/recorder/src/session/session-registry.ts:667-699`; the JetBrains and Neovim
  equivalents of the same hook). Never per event — the `doc.change` p99 < 1 ms constraint
  (PRD §4.7) is unaffected.
- Size measured as bytes already written to the `.slog` plus bytes buffered and not yet flushed.
  The recorder tracks this as a running counter; it does not `stat` the file.
- The threshold is injectable in each recorder so tests can rotate at a few KB.

### 3.2 Sequence

Rotation reuses the existing teardown and startup paths; it introduces no new lifecycle code
beyond the orchestration.

1. Emit `session.end { reason: 'rotate' }`, flush the writer, drain the pending checkpoint, take
   the teardown rolling-seal roll — i.e. exactly the `dispose()`/`deactivate` path, with a
   different reason. The ended session is fully sealed on disk.
2. Start a new session in the same scope: new random filename UUID, new `session_id`, new
   per-session keypair, `prev_session_id` = the ended session's id. It runs the normal activation
   catch-up: synthetic `doc.open` for every open document in scope (carrying live **buffer**
   content), extension set, identity, git state, §5.6 capability reports.
3. Step 1 completes **before** step 2 begins, and a second rotation request for the same scope is
   ignored while one is in flight.

**Why end-then-start, and what it costs.** In all three recorders the old session's document
wiring is detached only during its teardown, so starting the successor first would leave two
wirings subscribed and record the same keystroke into two logs. Ending first instead means any
event arriving inside the teardown window (sub-second, and no user-visible pause) is **dropped**
rather than duplicated. That is the right trade: a duplicate would corrupt two reconstructions and
could fabricate evidence, whereas a drop is self-correcting — the successor's catch-up `doc.open`
re-reads the live buffer, so its reconstruction starts from the true current content. A dropped
edit is invisible to the analyzer for the same reason: the seam is compared against buffer content
on both sides, not against a running diff.

Rotation happens at most once per checkpoint and only while the session is in the RECORDING
state (not degraded, not sealing).

### 3.3 Why the seam does not produce false flags

`inter_session_external_change` compares the reconstruction of each file at the end of session A
against the first `doc.open` content for that file in session B. All three recorders source the
catch-up `doc.open` content from the live buffer, not from disk:

| Recorder  | Source                                                                  |
| --------- | ----------------------------------------------------------------------- |
| VS Code   | `document.getText()` (`packages/recorder/src/wiring/doc-wiring.ts`)     |
| JetBrains | `Document` snapshot under a read action (`wiring/EdtCatchUp.kt`)        |
| Neovim    | `nvim_buf_get_lines` (`lua/provenance/recorder/wiring/doc_wiring.lua`)  |

The analyzer's reconstruction likewise includes unsaved edits, so the two sides are equal —
including for dirty buffers — and the heuristic does not fire.

### 3.4 Failure handling

If starting the new session fails (e.g. `ENOSPC`), fall through to the existing disk-full /
`recorder.degraded` path (PRD §4.8). The previous session is already sealed by then, so nothing
recorded before the rotation is at risk.

## 4. Analyzer

**No heuristic changes.** In particular, `inter_session_external_change` does **not** gain a
`reason === 'rotate'` exemption. That string is written by the student-controlled log; using it
to switch off a check would be a bypass. Rotation leaves no time window, so the comparison
passes naturally; a mismatch across a rotation seam means a real recorder bug or tampering and
must stay visible.

Regression tests with a rotated pair (A ends `rotate`; B starts immediately after with
`prev_session_id = A`, same contributor) for:

- `heuristics/inter-session-external-change.ts` — no flag, including a dirty-buffer case.
- `heuristics/gap-in-heartbeats.ts` — no flag across the seam.
- `heuristics/multiple-sessions-overlap.ts` and `coverage/session-overlap.ts` — no overlap.
- `order/happens-before.ts` — exactly one L1 edge A → B, no defects.

If any of these fires, the fix belongs in this change and is raised for discussion first; the
tests are not to be weakened to pass.

**Deferred:** replay's session picker and stats show a rotated pair as two sessions. A
"continued" label is a possible follow-up, not in scope here.

## 5. Tests

Per recorder (VS Code in Vitest; JetBrains in its Gradle suite; Neovim in its Lua suite):

1. Below the threshold at a checkpoint → no rotation. At/above → exactly one rotation.
2. The rotated pair: session A ends with `session.end { reason: 'rotate' }` and is sealed; B's
   `session.start.prev_session_id` = A; both pass chain and seal validation.
3. Dirty buffer at rotation: B's `doc.open` content equals the pre-rotation buffer.
4. New session start fails → degraded path; A remains sealed and valid.

Cross-repo acceptance: a bundle containing a rotation, produced by each recorder, loaded through
`analysis-core` — all 8 validation checks pass; zero `inter_session_external_change`,
`gap_in_heartbeats`, or overlap flags. Reuses the existing seal conformance gate
(`npm run test:tools`) and each recorder's analyzer-acceptance harness.

## 6. Documentation

- `docs/prd.md` §4.6: a paragraph on rotation; §4.8 failure table: a "log nears 40 MiB" row.
- `/architecture`: `tools/architecture/dot/state.dot` gains a `recording → recording` transition
  labelled with the rotation (fresh `session.start` carrying `prev_session_id`, new log file);
  regenerate with `python3 tools/architecture/build_diagrams.py`; update node detail in
  `content/nodes/state.ts`.
- Student FAQ: check whether it describes one-file-per-session; update only if it does.

## 7. Delivery

Three PRs, one per repo:

1. `provenance` — VS Code recorder, `analysis-core` regression tests, PRD, `/architecture`.
2. `provenance-jetbrains-recorder` — rotation + tests.
3. `provenance-neovim-recorder` — rotation + tests.

No version bump of the log format. Each recorder ships its change as a normal release; the VS
Code release requires `npm run update-hashes` as usual.
