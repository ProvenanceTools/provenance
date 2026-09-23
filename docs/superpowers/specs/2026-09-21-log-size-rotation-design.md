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
beyond the orchestration and the idle gate of §3.3.

1. Emit `session.end { reason: 'rotate' }`, flush the writer, drain the pending checkpoint, take
   the teardown rolling-seal roll — i.e. exactly the `dispose()`/`deactivate` path, with a
   different reason. The ended session is fully sealed on disk.
2. Start a new session in the same scope: new random filename UUID, new `session_id`, new
   per-session keypair, `prev_session_id` = the ended session's id, **skipping chain recovery**
   (§3.3). It runs the normal activation catch-up: synthetic `doc.open` for every open document in
   scope (carrying live **buffer** content), extension set, identity, git state, §5.6 capability
   reports.
3. Step 1 completes **before** step 2 begins, and a second rotation request for the same scope is
   ignored while one is in flight. A rotation must also be abandoned if the scope is stopped or
   the editor/project shuts down while it is in flight, in **every** port.

**Why end-then-start.** In all three recorders the old session's document wiring is detached only
during its teardown, so starting the successor first would leave two wirings subscribed and record
the same keystroke into two logs. A duplicate would corrupt two reconstructions and could
fabricate evidence. Ending first instead means any event arriving inside the teardown window is
**dropped** — which is not free, and §3.3 is how that cost is paid.

Rotation happens at most once per session, and never while the session is degraded — the
degraded branch returns before the checkpoint branch in every recorder, so this is structural
rather than a second guard.

**Not gated on sealing.** An earlier draft of this spec also required "not while sealing". That
condition is dropped: nothing implements it, and on inspection it protects nothing. Sealing a
live, still-appending session is already the ordinary case — students run
`Prepare Submission Bundle` while recording — so the seal command already has to tolerate a log
growing under it. A rotation adds no new class of race: once `session.end` is written the
predecessor's `.slog` never changes again, and the successor writes a different filename that the
seal either includes or does not. Both outcomes are valid bundles.

**Degraded abandons a rotation; it does not defer it.** The idle gate introduced a **second**
rotation trigger — a poll — and the "a degraded session never rotates" property was only ever
structural on the **entry** path, so every port initially let the poll fire while degraded. The
failure that produces: arming happens while healthy, the disk then fills (degraded is one-way and
never clears), the student pauses to read the error notification — which _is_ the quiet window —
and the poll commits a rotation. The predecessor is torn down and its rolling seal claims
`final: true`, while its `session.end` went to the in-memory ring rather than the log, and a
successor starts recording onto a still-full disk. **A bundle sealed `final` whose log lacks its own
terminal `session.end` is an evidence-integrity problem**, which is worse than anything rotation was
meant to solve.

So the degraded check belongs at the **single point of commit** that both triggers pass through,
never at the individual call sites, and it **abandons**: the poll is stopped and the armed flag is
left set so nothing re-arms. Deferring would be wrong, because degraded never becomes healthy
again without a restart, so a deferred rotation is one that waits forever while pretending it might
not.

The accepted consequence: **a degraded session's log can exceed `ROTATE_AT_BYTES`, and in the
extreme the 50 MB warning.** That is the right trade — a degraded session writes almost nothing, so
it barely grows, and an oversized log is recoverable whereas a falsely-`final` seal is not. This is
a behavioural choice, not a derivation, and it must be identical in all three ports.

### 3.3 The seam must be empty, because a lossy seam accuses the student

**Correction (2026-09-23).** An earlier version of this section argued that a dropped edit is
invisible to the analyzer because "the seam is compared against buffer content on both sides". That
was **wrong**, and every port, the PRD paragraph and the `/architecture` node body were built on
it. What `inter_session_external_change` actually compares
(`packages/analysis-core/src/heuristics/inter-session-external-change.ts:291`) is:

| Side      | What it is                                                                                                      |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| Session A | `establishedContent(...)` — a **reconstruction from A's event stream** (`heuristics/reconstruction-gate.ts:75`) |
| Session B | B's first `doc.open.content` — a **live buffer read**                                                           |

The comparison is exact string equality. So a character typed inside the teardown window is in B's
baseline and absent from A's reconstruction, the two differ, and the heuristic fires at confidence
0.85 — `high` once the delta passes `highSeverityCharsChanged`. In plain terms: **every rotation
that loses a keystroke tells staff the student edited that file outside the recorder.** The overlap
gate does not save it, because a rotation's gap is strictly positive. On a system that produces
evidence for academic-integrity cases, that is the most expensive defect available.

The analyzer is **not** the place to fix this. Suppressing the pair would cost real detection
power, and keying suppression off the student-controlled `reason` string is forbidden outright
(§4). So the recorder must make the seam empty instead.

**Two mechanisms, both required in all three ports.**

1. **Rotate only when idle.** A rotation is deferred until the session has recorded no
   **content-mutating event** for `ROTATE_IDLE_QUIET_MS = 2000`. Once the size threshold is crossed
   the recorder arms the rotation and waits for that quiet window; it does not rotate mid-burst.
   Students pause constantly, so in practice this costs nothing, and it makes "nothing changed
   during teardown" a property of when we rotate rather than a hope about how fast teardown is.

   **Content-mutating means `doc.change`, `paste`, and `fs.external_change` — not `doc.change`
   alone.** An earlier version of this section said `doc.change`, which is not sufficient: the
   heuristic this whole section exists to protect compares file CONTENT, and it does not care which
   event changed it. A formatter-on-save or a `git checkout` landing inside the teardown window is
   dropped exactly as a keystroke would be, and its divergence lands at the seam as the same false
   `inter_session_external_change` — in fact a worse one, because an external write is typically a
   whole-file rewrite, so the delta clears `highSeverityCharsChanged` and the flag is reported at
   **high** severity. Quieting only the keyboard leaves the specific event class named in the flag
   unguarded. External writes are rare, so resetting on them costs nothing in practice.

2. **Skip chain recovery on a rotation.** The successor already knows its predecessor's id, so it
   must not run `recoverPreviousSession`. That path reads, parses and `validateChain`s the whole
   40 MiB predecessor log — roughly 150k entries of JCS canonicalization and SHA-256 — while no
   wiring is attached. It is the largest term in the teardown window by orders of magnitude, it is
   pure waste here, and in the Neovim port it runs on the main loop, where it freezes the editor.
   Removing it shrinks the window from seconds to the cost of a flush plus a seal.

**Hard ceiling.** If the log reaches `ROTATE_HARD_CEILING_BYTES = 48 * 1024 * 1024` without ever
seeing a quiet window, the recorder rotates anyway. A continuous-typing session that never idles
must not grow without limit, and at that point an unpushable repo is the worse outcome. With
mechanism 2 in place the residual window is small, but it is **not zero**, and this is the one path
on which a rotation can still lose an edit.

**The analyzer keeps a negative control.** `analysis-core` carries a test asserting that a _lossy_
seam — one where content diverges across the boundary — **still flags**. That test is what stops
this hole reopening silently: the no-flag tests alone cannot distinguish "the recorders produce an
empty seam" from "the heuristic stopped working".

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
4. New session start fails → degraded path, surfaced to the student; A remains sealed and valid.
   Required in **every** port — a silent failed rotation leaves the student unrecorded.
5. **Idle gate (§3.3):** crossing the threshold mid-burst arms the rotation but does not rotate;
   the rotation fires only after `ROTATE_IDLE_QUIET_MS` of no `doc.change`. A session that keeps
   typing past `ROTATE_HARD_CEILING_BYTES` rotates anyway.
6. **No chain recovery on a rotation (§3.3):** the successor does not read or validate the
   predecessor's log. Assert it by construction, e.g. a recovery seam that fails the test if called.
7. A rotation in flight is abandoned when the scope is stopped or the editor/project shuts down —
   no session may be registered after teardown, and no dangling session may be left behind.

Analyzer-side, in `analysis-core`:

8. **Negative control:** a _lossy_ seam (content diverges across the rotation boundary) **still
   flags** `inter_session_external_change`. Without this, the no-flag tests cannot distinguish an
   empty seam from a broken heuristic — which is exactly how the §3.3 error survived review.

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
