# Provenance Recorder

VS Code extension that records a tamper-evident log of editing activity while a student works on an assignment. Produces a `.slog` file (JCS-canonical, hash-chained, ed25519-signed checkpoints) that course staff loads into the Provenance Analyzer for review.

This document covers the extension's design and internals — the student-facing README lives in [`packages/recorder/README.md`](../packages/recorder/README.md). For the overall project, see the [repo root README](../README.md). For the full product spec, see [`prd.md`](./prd.md). For the catalog of analyzer heuristics that consume what the recorder produces, see [`heuristics.md`](./heuristics.md).

## What it does

While active, the recorder writes one entry per VS Code event (typed change, paste, save, focus shift, terminal command, external file change, etc.) to `.provenance/session-<uuid>.slog` in the assignment workspace. Each entry is:

- **JCS-canonicalized** (RFC 8785) so whitespace and key ordering don't affect hashes.
- **Hash-chained**: every entry's `prev_hash` equals the previous entry's `hash`. Tampering breaks the chain.
- **Cryptographically anchored**: a per-session ed25519 keypair signs `(seq, hash)` checkpoints every 100 events into a sibling `.slog.meta` file. The session private key is encrypted under a key derived from the `.provenance-manifest` manifest signature, so replay of an old session against a new assignment fails.

At submission time, **"Provenance: Prepare Submission Bundle"** (command palette: ⇧⌘P) seals the `.provenance/` directory into a signed ZIP for the student to upload alongside their code.

## What students see

The status bar always shows "**Provenance: recording**" while the extension is active. This is both the in-product disclosure required for the telemetry to be ethical, and a tamper signal — if it disappears, something is wrong.

The extension activates **only** when the workspace root contains a valid `.provenance-manifest` manifest signed by the course's offline key **and** carrying an inline `course_cert` that chains to the root public key the extension embeds. In any other folder, the extension does nothing — no logging, no UI noise, no `.provenance/` directory.

## Activation manifest (`.provenance-manifest`)

The manifest is a small JSON file at the workspace root. Course staff author it unsigned, then run `tools/sign-manifest.ts` to attach an ed25519 `sig` field against the offline course private key (see the repo root [README](../README.md#course-staff-key--manifest-workflow) for the full staff workflow).

**Unsigned shape** (what staff edits by hand):

```json
{
  "assignment_id": "hw03",
  "semester": "fa26",
  "issued_at": "2026-09-15T00:00:00Z",
  "files_under_review": ["hw03.py"]
}
```

**Signed shape** (what the signer writes back, and what the recorder verifies):

```json
{
  "assignment_id": "hw03",
  "semester": "fa26",
  "issued_at": "2026-09-15T00:00:00Z",
  "files_under_review": ["hw03.py"],
  "sig": "<128-char hex ed25519 signature>"
}
```

The `sig` covers the JCS-canonical bytes of the other four fields (PRD §4.1, implemented in `packages/log-core/src/manifest.ts`). Changing any field after signing invalidates the signature and the extension silently no-ops on activation. `files_under_review` scopes the external-change detector in §4.5 — files outside this list are still logged for context, but don't get an expected-content model.

## Privacy

What the recorder **does** record (PRD §4.2 has the full table):

- All file edits in the assignment workspace, including paste payloads up to 4 KB inline (longer pastes are truncated to head/tail + SHA-256).
- Focus changes, selection changes, file open/save/close.
- Terminal opens/commands (when VS Code's shell integration is enabled).
- The list of installed VS Code extensions at session start and every 5 minutes.
- Git operations observed through VS Code's Git extension API.
- A `machine_id` derived from `sha256(hostname + username + per-session salt)`.

What the recorder **does not** record (PRD §4.2):

- Anything outside the assignment workspace.
- Files outside the manifest's `files_under_review` list don't get an in-memory expected-content model (but their `doc.open` / `doc.change` events are still recorded for the workspace context).
- Clipboard contents in general (only paste payloads that were inserted into an assignment file).
- OS-level keystrokes (we use VS Code's document-change events, which are diff-grained, not key-grained).
- Anything outside an activated assignment workspace.

The recorder makes **no network calls** during a session (PRD NG2). The log lives on the student's machine until they upload the sealed bundle.

## Security model (PRD §6)

This is a **deterrent**, not a cryptographic guarantee. The threat model is in PRD §6; the short version:

| Attack                                                                                     | Detection                                                                                                                                                             |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hand-edit the JSON log to remove or rewrite an entry                                       | Hash chain breaks at that seq; `validateChain` reports the location                                                                                                   |
| Drop a fake `.provenance-manifest` manifest into any folder to make the recorder log there | Manifest trust chain fails to verify against the embedded **root** public key (a forged `course_cert` cannot be root-signed); extension silently does nothing         |
| Replay last week's session for this week's assignment                                      | Each session pubkey is bound to that session's `manifest_sig`; analyzer detects the mismatch                                                                          |
| Tamper between sessions (edit a saved `.slog`)                                             | Next session's startup chain-recovery quarantines the corrupt file and emits `recorder.recovered_from_corruption`                                                     |
| Edit assignment files via Claude Code / Codex / `vim` / `cp` outside VS Code               | Per-file expected-content model detects hash drift at next save; FileSystemWatcher catches edits while VS Code is unfocused; both produce `fs.external_change` events |
| Paste a large LLM-generated block without typing                                           | Three-signal paste detector (single-edit large-insert classifier + command intercept + reconciler) flags the paste; analyzer sees a `paste` event with the content    |
| Modify the recorder's own source to drop events                                            | `extension_hash` in the seal bundle differs from the course-known-good hash                                                                                           |
| Manipulate the wall clock to space out events                                              | Clock-skew watcher emits a `clock.skew` event when wall and monotonic time diverge                                                                                    |
| Suspend the extension by killing the process                                               | `session.heartbeat` gap in the chain; `prev_session_id` linkage on next start                                                                                         |
| Disk full                                                                                  | Recorder switches to a critical-only ring buffer and emits `recorder.degraded` plus a user notification                                                               |

The system explicitly does NOT defend against an attacker who has the course's offline private key, or one who extracts the session private key from process memory during a live session. PRD §6 is candid about these limits.

## Performance

The `doc.change` handler is the hot path — VS Code fires one per keystroke. PRD §4.7 budgets it at <1ms p99. The synthetic benchmark (`npm run bench`) measures the SessionWriter `append` path; current numbers on dev hardware:

- p50: 0.003ms
- p95: 0.004ms
- p99: 0.006ms
- max: 0.395ms

Memory budget: the in-memory event buffer caps at 256 KB and flushes every 1 s, whichever comes first. A 4-hour project session produces well under the PRD §4.7's 20 MB budget on real workloads.

## For developers

### Build, test, debug

```sh
# From the repo root:
npm install
npm run build                       # tsc for both log-core and recorder
npm run test                        # 411 unit tests via vitest
npm run typecheck                   # tsc --noEmit
npm run lint                        # eslint + prettier
```

Debug the extension against `test-workspace/`:

1. Open the repo root in VS Code.
2. Run & Debug panel → **"Run Recorder Extension"** → F5.
3. A second VS Code window opens with `test-workspace/` loaded. Edit `hw.py`, save, paste, watch the status bar.
4. Tail the live log: `tail -f test-workspace/.provenance/session-*.slog | jq .`

### Integration tests

```sh
npm run test:integration --workspace packages/recorder
```

Downloads VS Code 1.120 the first time (~200 MB into `.vscode-test/`, gitignored), launches it headlessly with the extension + `test-workspace`, runs Mocha tests against the real Extension Host. Three smoke tests (~6 s after the initial download).

### Performance benchmark

```sh
npm run bench --workspace packages/recorder
```

Vitest bench replaying 10k synthetic chained entries through the writer. Reports p50/p95/p99 + max per-append time.

### Package a local VSIX

```sh
npm run package:recorder
```

Produces `packages/recorder/provenance-recorder-<version>.vsix` (~250 KB). Install with **Extensions: Install from VSIX...** in any VS Code window. This VSIX uses the dev keypair — it'll accept manifests signed with the dev key in `.notes/dev-keypair.json`, not the real course key.

### Package a production VSIX

See the [repo root README](../README.md#course-staff-key--manifest-workflow). The short version:

```sh
PROVENANCE_ROOT_PUBLIC_KEY_HEX=<64-hex> \
  npm run build:prod --workspace packages/recorder
```

`PROVENANCE_ROOT_PUBLIC_KEY_HEX` is the **root** key of the Manifest 2.0 trust chain — the key an inline `course_cert` must chain to. It is required. `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX` is optional and grandfathers 1.x manifests, whose payload signature is checked against it directly. (There is no `PROVENANCE_COURSE_PUBLIC_KEY_HEX`; `tools/embed-root-key.ts` reads only those two names.)

The `build:prod` script refuses to run if the required env var is missing, malformed, or matches the dev key, then embeds the production key(s), builds, packages, and restores the source.

## Architecture overview

```
src/
├── extension.ts                      # VS Code entry: activate() / deactivate()
├── activation/
│   ├── course-keys.ts                # re-exports the embedded verification keys
│   ├── root-public-key.ts            # the 2.0 root constant; swapped by build:prod
│   ├── legacy-course-public-key.ts   # the grandfathered 1.x constant; ditto
│   ├── manifest-discovery.ts         # globs nested manifests under the workspace
│   ├── manifest-loader.ts            # reads + verifies .provenance-manifest
│   └── status-bar.ts                 # the "Provenance: recording" indicator
├── session/
│   ├── session-host.ts               # owns seq + prev_hash; calls chainEntry
│   └── recorder-context.ts           # builds the session.start payload
├── io/
│   ├── session-writer.ts             # buffered append-only writer for .slog
│   ├── atomic-write.ts               # write-temp-fsync-rename for .meta
│   └── meta-writer.ts                # .meta file with encrypted privkey + checkpoints
├── events/
│   ├── doc-events.ts                 # pure transformers (vscode event → envelope payload)
│   ├── heartbeat.ts                  # 30s session.heartbeat emitter
│   ├── clock-watcher.ts              # wall-vs-monotonic drift → clock.skew
│   ├── paste-classifier.ts           # signal 1: large-insert classifier
│   ├── paste-reconciler.ts           # signal 3: count reconciler → paste.anomaly
│   ├── paste-payload.ts              # 4 KB inline / head+tail truncation rule
│   ├── external-change-detector.ts   # save-time expected vs on-disk comparison
│   └── explanation-tags.ts           # formatter/git tags to suppress fs.external_change FPs
├── wiring/
│   ├── doc-wiring.ts                 # VS Code subscriptions for doc events
│   ├── paste-command-intercept.ts    # signal 2 (optional course-staff keybind)
│   ├── fs-watcher.ts                 # FileSystemWatcher for external edits
│   ├── terminal-wiring.ts            # terminal.open / .command via shell integration
│   ├── extension-snapshot.ts         # ext.snapshot at start + every 5min
│   ├── extension-activation.ts       # ext.activate via polling
│   └── git-wiring.ts                 # git.event via vscode.git extension API
├── state/
│   ├── expected-content.ts           # per-file in-memory content + streaming SHA-256
│   └── expected-content-registry.ts  # keyed by relative path
├── crypto/
│   ├── session-keys.ts               # ed25519 keypair + HKDF + XChaCha20-Poly1305
│   └── checkpoint-signer.ts          # sign/verify (seq, hash)
├── startup/
│   └── chain-recovery.ts             # quarantine corrupt slog + emit recovered_from_corruption
├── commands/
│   ├── seal.ts                       # "Prepare Submission Bundle" → signed ZIP
│   └── extension-hash.ts             # SHA-256 of sorted dist/ for the bundle manifest
└── failure/
    └── disk-full-handler.ts          # critical-only ring buffer + recorder.degraded
```

Tests are co-located (`foo.ts` + `foo.test.ts`). The `__mocks__/vscode.ts` file provides a minimal `vscode` API surface for unit tests; the real `vscode` API is used by integration tests under `test/integration/`.
