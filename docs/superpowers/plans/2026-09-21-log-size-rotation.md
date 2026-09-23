# Log Size Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a session's `.slog` grows past 40 MiB, each of the three recorders ends and seals that session and immediately starts a new one linked by `prev_session_id`, so no single file ever approaches GitHub's 100 MB limit.

**Architecture:** Rotation reuses the existing teardown path (`session.end` → flush → drain checkpoint → teardown rolling-seal roll) and the existing session-start path. The only new logic is a size check at the existing every-100-entries checkpoint hook plus the orchestration that ends one session and starts its successor. No log-format change: `session.end.reason` is already a free-form string and `prev_session_id` already exists.

**Tech Stack:** TypeScript/Vitest (monorepo, VS Code recorder), Kotlin/Gradle (JetBrains recorder), Lua/busted (Neovim recorder).

**Spec:** `docs/superpowers/specs/2026-09-21-log-size-rotation-design.md` — read it before Task 1.

## Global Constraints

- Threshold: `ROTATE_AT_BYTES = 40 * 1024 * 1024` (40 MiB) exactly, defined once per recorder, injectable for tests. Not a manifest field, not user-configurable.
- `session.end` reason string is exactly `rotate` (lowercase, no prefix) in all three recorders.
- No log-format change: no `format_version` bump, no new event kind, no new payload field, no conformance-vector change.
- The size check runs only at the existing checkpoint hook (every 100 entries). Never per event — `doc.change` handlers must stay under 1 ms p99 (recorder PRD §4.7).
- Rotation is allowed only while a session is actively recording — never in the degraded (`ENOSPC`) state, never during seal.
- The new session's `prev_session_id` must equal the ended session's `session_id`.
- The analyzer must NOT gain any behaviour keyed on `reason === 'rotate'`; the string is student-controlled and must never switch a check off.
- Do not weaken any existing test to accommodate rotation. If an existing heuristic fires on a rotated pair, stop and report it.
- Commits: `git commit --no-gpg-sign`, conventional-commit prefixes, explicit pathspec on every `git add` / `git commit` (the tree may contain unrelated uncommitted work). No `Co-Authored-By` trailer.

---

## Task order

1. Task 1 — analyzer regression tests for a rotated pair (`analysis-core`). Done first: it defines, in executable form, what the recorders must produce.
2. Task 2 — VS Code recorder rotation.
3. Task 3 — monorepo docs + `/architecture`.
4. Task 4 — JetBrains recorder rotation.
5. Task 5 — Neovim recorder rotation.

Tasks 1–3 are one PR in `provenance`; Tasks 4 and 5 are one PR each in their own repos.

---

### Task 1: Analyzer regression tests for a rotated session pair

A rotated pair is: session A whose last event is `session.end {reason:'rotate'}`, then session B whose `session.start.prev_session_id` is A's `session_id`, same contributor, B's first event walls immediately after A's last. No file content changes across the seam. Nothing should flag.

**Files:**

- Modify/Test: `packages/analysis-core/src/heuristics/inter-session-external-change.test.ts`
- Modify/Test: `packages/analysis-core/src/heuristics/gap-in-heartbeats.test.ts`
- Modify/Test: `packages/analysis-core/src/heuristics/multiple-sessions-overlap.test.ts`
- Modify/Test: `packages/analysis-core/src/order/happens-before.test.ts`
- Read first (do not modify): `packages/analysis-core/src/test-support/build-test-bundle.ts`

**Interfaces:**

- Consumes: `buildTestBundle({ sessions: [...] })` from `test-support/build-test-bundle.ts`. Each session entry accepts `sessionId`, `events: EventSpec[]`, `walls?: string[]`, and `sessionStart` (shallow-merged into `session.start.data` **before** chaining — this is how a test sets `prev_session_id`). `EventSpec` is `{ kind: string; data: Record<string, unknown>; wall?: string; t?: number }`.
- Produces: a shared helper `rotatedPair()` local to each test file (repeated per file — do not factor it into shared test-support, the four uses need different event bodies).

- [ ] **Step 1: Read the existing patterns**

Read `packages/analysis-core/src/heuristics/inter-session-external-change.test.ts` lines 1–120 for the `buildAndIndex` + `sessionThat` pattern, and `packages/analysis-core/src/test-support/build-test-bundle.ts` around lines 240–330 for the per-session option shape. Confirm `sessionStart` is shallow-merged into `session.start.data` before chaining.

- [ ] **Step 2: Write the failing test in `inter-session-external-change.test.ts`**

Append inside the existing top-level `describe('inter_session_external_change', ...)`:

```ts
// A rotation (the recorder hit ROTATE_AT_BYTES and started a fresh session
// in the same scope) leaves no time window in which anything could edit the
// file, and the successor's catch-up doc.open carries the live BUFFER
// content — so the seam must produce no flag. See
// docs/superpowers/specs/2026-09-21-log-size-rotation-design.md §3.3.
it('emits no flags across a rotation seam', async () => {
  const finalA = 'def foo():\n    return 1\n';
  const { index, bundle } = await buildAndIndex({
    sessions: [
      {
        sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
        events: [
          ...sessionThat('hw1.py', '', finalA),
          { kind: 'session.end', data: { reason: 'rotate' } },
        ],
      },
      {
        sessionId: 'aaaaaaaa-0000-4000-8000-000000000002',
        sessionStart: { prev_session_id: 'aaaaaaaa-0000-4000-8000-000000000001' },
        events: sessionThat('hw1.py', finalA, '    # more\n'),
      },
    ],
  });
  const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
  expect(flags).toHaveLength(0);
});

// The seam must also be clean when the buffer was DIRTY at rotation: session
// A's reconstruction includes the unsaved edit, and B's doc.open baseline is
// read from the buffer, so both sides carry it. A recorder that seeded B from
// disk instead would diverge here and produce a false accusation.
it('emits no flags across a rotation seam with an unsaved edit', async () => {
  const saved = 'def foo():\n    return 1\n';
  const unsaved = saved + '# typed but never saved\n';
  const { index, bundle } = await buildAndIndex({
    sessions: [
      {
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000001',
        events: [
          { kind: 'doc.open', data: { path: 'hw1.py', content: saved } },
          {
            kind: 'doc.change',
            data: {
              path: 'hw1.py',
              source: 'typed',
              deltas: [
                {
                  range: {
                    start: { line: 2, character: 0 },
                    end: { line: 2, character: 0 },
                  },
                  text: '# typed but never saved\n',
                },
              ],
            },
          },
          { kind: 'session.end', data: { reason: 'rotate' } },
        ],
      },
      {
        sessionId: 'bbbbbbbb-0000-4000-8000-000000000002',
        sessionStart: { prev_session_id: 'bbbbbbbb-0000-4000-8000-000000000001' },
        events: [{ kind: 'doc.open', data: { path: 'hw1.py', content: unsaved } }],
      },
    ],
  });
  const flags = interSessionExternalChangeHeuristic.run(index, bundle, cfg);
  expect(flags).toHaveLength(0);
});
```

- [ ] **Step 3: Run it**

```bash
cd /Users/aaryanmehta/projects/provenance
npx vitest run --root packages/analysis-core src/heuristics/inter-session-external-change.test.ts
```

Expected: both new tests PASS (the heuristic is already correct for this input — these are regression guards, so a pass here is the success condition, not a TDD failure). If either FAILS, that is a real analyzer defect on the rotation seam: stop and report it rather than editing the heuristic or the test.

- [ ] **Step 4: Add the `gap_in_heartbeats` regression test**

In `packages/analysis-core/src/heuristics/gap-in-heartbeats.test.ts`, follow that file's existing bundle-construction helper (read it first; it stamps explicit `walls`). Add a test where session A has two heartbeats 30 s apart, then `session.end {reason:'rotate'}`, and session B (with `prev_session_id` = A) starts 1 s later with two more heartbeats 30 s apart. Assert `expect(flags).toHaveLength(0)`. Name it `'does not flag the gap across a rotation seam'`.

- [ ] **Step 5: Add the overlap regression test**

In `packages/analysis-core/src/heuristics/multiple-sessions-overlap.test.ts`, following that file's existing helpers, add `'treats a rotated pair as non-overlapping'`: session A ends (wall `T`) with `session.end {reason:'rotate'}`; session B's `session.start` wall is `T` + 1 s, `prev_session_id` = A. Assert no flags. Note in a comment that `coverage/session-overlap.ts` bounds a session at its `session.end.wall`, which a rotation always writes, so the pair cannot overlap.

- [ ] **Step 6: Add the ordering test**

In `packages/analysis-core/src/order/happens-before.test.ts`, following that file's existing helpers, add `'honours a rotation seam as an L1 edge'`: a rotated pair, same contributor. Assert there is an A → B ordering edge and no defects (use the same assertion helpers the neighbouring `prev_session_id` tests use — read them first; `order/happens-before.ts:669` reads `prev_session_id` off the `session.start` data).

- [ ] **Step 7: Run all four suites**

```bash
cd /Users/aaryanmehta/projects/provenance
npx vitest run --root packages/analysis-core src/heuristics/inter-session-external-change.test.ts src/heuristics/gap-in-heartbeats.test.ts src/heuristics/multiple-sessions-overlap.test.ts src/order/happens-before.test.ts
```

Expected: all PASS. Then `npm run typecheck` and `npm run lint` at the repo root.

- [ ] **Step 8: Commit**

```bash
cd /Users/aaryanmehta/projects/provenance
git add -- packages/analysis-core/src/heuristics/inter-session-external-change.test.ts \
  packages/analysis-core/src/heuristics/gap-in-heartbeats.test.ts \
  packages/analysis-core/src/heuristics/multiple-sessions-overlap.test.ts \
  packages/analysis-core/src/order/happens-before.test.ts
git commit --no-gpg-sign -m "test(analysis-core): pin no-flag behaviour across a session rotation seam"
```

---

### Task 2: VS Code recorder rotation

Four gaps in the current code have to be closed; none is optional:

1. `dispose()` hardcodes `reason: 'deactivate'` (`session-registry.ts:1044`) → parameterize.
2. `prevSessionId` is only set when recovery reports `previous_session_dangling` (`session-registry.ts:400-401`), i.e. a **crash**. A rotated session ends _cleanly_, so recovery will never link it → an explicit override is required. Do **not** touch `chain-recovery.ts`; rotation bypasses it.
3. `SessionWriter` has no cumulative byte counter — `bufferedBytes` is private and resets on every flush → add a running total.
4. The rotation threshold must be injectable, following the existing `provenanceDirOverride` / `heartbeatDeps` "production default, test override" convention on `StartSessionDeps`.

**Ordering decision (important):** the old session is fully disposed **first**, then the new session is started. Starting first would leave both sessions' doc wirings subscribed at once and record the same keystroke into two logs. Disposing first means events in the (sub-second, synchronous) gap are dropped instead of duplicated, which is safe: the new session's catch-up `doc.open` re-reads the live buffer, so reconstruction resynchronises and no divergence flag can fire.

**Files:**

- Modify: `packages/recorder/src/io/session-writer.ts` — add a cumulative byte counter
- Test: `packages/recorder/src/io/session-writer.test.ts`
- Modify: `packages/recorder/src/session/session-registry.ts` — threshold constant, `StartSessionDeps` fields, `dispose(reason)`, the trigger in `onEntry`
- Modify: `packages/recorder/src/extension.ts` — the rotation callback that disposes and restarts a root
- Test: `packages/recorder/src/session/session-registry.test.ts`

**Interfaces:**

- Produces, consumed by Task 3's docs and by nothing else in code:
  - `ROTATE_AT_BYTES: number` exported from `session-registry.ts` = `40 * 1024 * 1024`
  - `SessionWriter.bytesAppended: number` (readonly getter, cumulative, never reset)
  - `StartSessionDeps.prevSessionIdOverride?: string`
  - `StartSessionDeps.rotateAtBytesOverride?: number`
  - `StartSessionDeps.requestRotation?: (endedSessionId: string) => void`
  - `ActiveSession.dispose: (reason?: string) => Promise<void>` (default `'deactivate'`, unchanged for all existing callers)
  - `ActiveSession.sessionId: string` — add if absent; the rotation callback needs the ended session's logical id (NOT the `.slog` filename uuid)

- [ ] **Step 1: Write the failing writer test**

In `packages/recorder/src/io/session-writer.test.ts`, following the file's existing `SessionWriter.open` + tmpdir pattern:

```ts
it('reports cumulative bytes appended across flushes', async () => {
  const writer = await SessionWriter.open({ slogPath, clock });
  expect(writer.bytesAppended).toBe(0);
  writer.append(entryA);
  const afterFirst = writer.bytesAppended;
  expect(afterFirst).toBeGreaterThan(0);
  await writer.flush();
  // A flush resets the buffer, never the cumulative total.
  expect(writer.bytesAppended).toBe(afterFirst);
  writer.append(entryB);
  expect(writer.bytesAppended).toBeGreaterThan(afterFirst);
  await writer.dispose();
  // The counter must equal the file's real size on disk.
  const stat = await fs.stat(slogPath);
  expect(writer.bytesAppended).toBe(stat.size);
});
```

Build `entryA` / `entryB` the way the neighbouring tests in that file build hashed envelopes (read them first).

- [ ] **Step 2: Run it to verify it fails**

```bash
cd /Users/aaryanmehta/projects/provenance
npx vitest run --root packages/recorder src/io/session-writer.test.ts
```

Expected: FAIL — `bytesAppended` does not exist.

- [ ] **Step 3: Implement the counter**

In `packages/recorder/src/io/session-writer.ts`, beside `private bufferedBytes = 0;` (line 59):

```ts
  /**
   * Total bytes appended over this writer's lifetime. Unlike {@link bufferedBytes}
   * it is NEVER reset by a flush, so it equals the `.slog`'s size on disk once
   * everything is flushed. Size rotation (PRD §4.6) reads it at checkpoint
   * cadence; nothing on the hot path does more than one addition here.
   */
  private totalBytes = 0;

  get bytesAppended(): number {
    return this.totalBytes;
  }
```

In `append()`, beside the existing `this.bufferedBytes += Buffer.byteLength(line, 'utf8');` (line 115), add the same delta to `this.totalBytes` — compute `Buffer.byteLength(line, 'utf8')` once into a local and use it for both, rather than calling it twice.

- [ ] **Step 4: Run to verify it passes**

```bash
cd /Users/aaryanmehta/projects/provenance
npx vitest run --root packages/recorder src/io/session-writer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/aaryanmehta/projects/provenance
git add -- packages/recorder/src/io/session-writer.ts packages/recorder/src/io/session-writer.test.ts
git commit --no-gpg-sign -m "feat(recorder): expose cumulative bytes appended on SessionWriter"
```

- [ ] **Step 6: Write the failing rotation test**

In `packages/recorder/src/session/session-registry.test.ts`, inside `describe('startSession', ...)`, following the existing real-filesystem pattern (`tmpDir` from `beforeEach`, `signedManifest()`, `FixedClock`, and the round-trip assertion style of the test at lines 63-99):

```ts
it('requests a rotation once the log passes the threshold', async () => {
  const rotations: string[] = [];
  const session = await startSession({
    assignmentRoot: tmpDir,
    manifest: await signedManifest(),
    extension: fakeExtension,
    vscodeVersion: '1.90.0',
    platform: 'darwin',
    clock,
    // A tiny threshold: a handful of real entries crosses it, so the test
    // never writes 40 MiB.
    rotateAtBytesOverride: 512,
    requestRotation: (endedSessionId) => rotations.push(endedSessionId),
  });

  // The threshold is only READ at the checkpoint cadence (every 100 entries),
  // so crossing it must not fire before the 100th entry.
  for (let i = 0; i < 99; i++) {
    session.sessionHost.emit('doc.save', { path: 'hw1.py', sha256: 'a'.repeat(64) });
  }
  expect(rotations).toEqual([]);

  session.sessionHost.emit('doc.save', { path: 'hw1.py', sha256: 'a'.repeat(64) });
  expect(rotations).toEqual([session.sessionId]);

  await session.dispose();
});

it('writes the rotate reason and links the successor by prev_session_id', async () => {
  const first = await startSession({
    assignmentRoot: tmpDir,
    manifest: await signedManifest(),
    extension: fakeExtension,
    vscodeVersion: '1.90.0',
    platform: 'darwin',
    clock,
  });
  const firstId = first.sessionId;
  await first.dispose('rotate');

  const second = await startSession({
    assignmentRoot: tmpDir,
    manifest: await signedManifest(),
    extension: fakeExtension,
    vscodeVersion: '1.90.0',
    platform: 'darwin',
    clock,
    prevSessionIdOverride: firstId,
  });

  const firstEntries = parseEntries(await fs.readFile(first.slogPath, 'utf8'));
  const lastFirst = firstEntries.at(-1)!;
  expect(lastFirst.kind).toBe('session.end');
  expect((lastFirst.data as { reason: string }).reason).toBe('rotate');

  const secondEntries = parseEntries(await fs.readFile(second.slogPath, 'utf8'));
  const start = secondEntries[0]!;
  expect(start.kind).toBe('session.start');
  expect((start.data as { prev_session_id: string | null }).prev_session_id).toBe(firstId);
  // Each log is independently chain-valid — rotation does not span a chain.
  expect(validateChain(firstEntries).ok).toBe(true);
  expect(validateChain(secondEntries).ok).toBe(true);
  expect(second.slogPath).not.toBe(first.slogPath);

  await second.dispose();
});
```

Match the file's existing construction of `fakeExtension` / deps exactly — read lines 35-99 first and reuse its helpers rather than inventing new ones. `parseEntries` and `validateChain` are already imported in that file.

- [ ] **Step 7: Run to verify it fails**

```bash
cd /Users/aaryanmehta/projects/provenance
npx vitest run --root packages/recorder src/session/session-registry.test.ts
```

Expected: FAIL — unknown deps fields, `dispose` takes no argument, `sessionId` may not exist on `ActiveSession`.

- [ ] **Step 8: Add the threshold constant and the deps fields**

In `packages/recorder/src/session/session-registry.ts`, near the top-level exports:

```ts
/**
 * Rotate a session once its `.slog` passes this size (PRD §4.6).
 *
 * `submission: 'git'` assignments commit `.provenance/` to a GitHub repo, and
 * GitHub warns at 50 MB and REFUSES a push containing a file over 100 MB. A
 * session now lives for the editor's lifetime, so an unrotated log can grow
 * past that and leave the student unable to submit. 40 MiB keeps a whole
 * 256 KB flush plus a few 64 KB payloads clear of the warning.
 */
export const ROTATE_AT_BYTES = 40 * 1024 * 1024;
```

Add to `StartSessionDeps` (after `provenanceDirOverride`, keeping the file's doc-comment style):

```ts
  /**
   * Force this session's `prev_session_id`, bypassing chain recovery.
   *
   * Recovery only links a DANGLING previous session (a crash). A rotation ends
   * the previous session CLEANLY, so recovery reports `previous_session_complete`
   * and would link nothing — the successor would look like an unrelated session.
   * The rotation caller therefore passes the ended session's id here.
   */
  prevSessionIdOverride?: string;
  /** Production default {@link ROTATE_AT_BYTES}; tests pass a tiny value. */
  rotateAtBytesOverride?: number;
  /**
   * Called (at most once) when this session's log has passed the rotation
   * threshold. The session does NOT rotate itself: it owns neither the registry
   * nor its own deps. `extension.ts` supplies this and performs the swap.
   */
  requestRotation?: (endedSessionId: string) => void;
```

- [ ] **Step 9: Honour the override and expose `sessionId`**

At `session-registry.ts:400-401`, replace the `prevSessionId` derivation with:

```ts
const prevSessionId: string | null =
  deps.prevSessionIdOverride ??
  (recovery.kind === 'previous_session_dangling' ? recovery.prevSessionId : null);
```

Keep the existing comment about dangling-only linkage and extend it to say the override exists for rotation. Add `sessionId: recorderContext.session_id` to the returned `ActiveSession` object and to the `ActiveSession` type (lines 90-132) if it is not already there.

- [ ] **Step 10: Add the trigger in the checkpoint branch**

In `startSession`, alongside `const CHECKPOINT_INTERVAL = 100;` (line 670):

```ts
const rotateAtBytes = deps.rotateAtBytesOverride ?? ROTATE_AT_BYTES;
let rotationRequested = false;
```

Inside the `onEntry` closure's existing `if (entryCountSinceLastCheckpoint >= CHECKPOINT_INTERVAL) { ... }` block (line 694), after the existing checkpoint chain is assigned, add:

```ts
// Size rotation (PRD §4.6). Read INSIDE the checkpoint branch so the
// check costs one comparison per 100 entries, not one per keystroke —
// doc.change must stay under 1 ms p99 (§4.7). Requested at most once;
// the swap itself is extension.ts's job.
if (!rotationRequested && writer.bytesAppended >= rotateAtBytes) {
  rotationRequested = true;
  deps.requestRotation?.(recorderContext.session_id);
}
```

Note the degraded path already `return`s above this (line 688-691), so a degraded session never rotates — which is the required behaviour, not an accident. Say so in the comment.

- [ ] **Step 11: Parameterize `dispose`**

Change `async function dispose(): Promise<void>` (line 1031) to `async function dispose(reason: string = 'deactivate'): Promise<void>` and use `reason` in the `session.end` emit (line 1044). Update the `ActiveSession.dispose` type (line 131) to `(reason?: string) => Promise<void>` and its doc comment. Every existing caller passes nothing and keeps `'deactivate'`.

- [ ] **Step 12: Run the tests**

```bash
cd /Users/aaryanmehta/projects/provenance
npx vitest run --root packages/recorder src/session/session-registry.test.ts
```

Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 13: Wire the rotation callback in `extension.ts`**

`extension.ts` starts sessions in two places: the activation loop (line ~487) and `rescan()` (line ~585). Factor the shared body into one local function so rotation reuses it:

```ts
/**
 * Start one session for `root` and register it, replacing any session already
 * registered for that root.
 *
 * `prevSessionId` is set only by rotation (PRD §4.6): the ended session's id,
 * which chain recovery cannot supply because a rotation ends cleanly.
 */
async function startAndRegister(
  context: vscode.ExtensionContext,
  extensionDistPath: string,
  extension: vscode.Extension<unknown>,
  root: string,
  manifest: Manifest,
  prevSessionId?: string,
): Promise<void> {
  const session = await start({
    /* …exactly the deps the existing call sites pass… */
    prevSessionIdOverride: prevSessionId,
    requestRotation: (endedSessionId) => {
      void rotate(context, extensionDistPath, extension, root, manifest, endedSessionId);
    },
  });
  context.subscriptions.push(...session.ownDisposables);
  session.ownDisposables.length = 0;
  registry.add(session);
}

/** In-flight rotation roots, so a second request cannot interleave with the first. */
const rotating = new Set<string>();

/**
 * Rotate the session at `root`: dispose it (sealing it, with
 * `session.end{reason:'rotate'}`), then start its successor linked by
 * `prev_session_id`.
 *
 * Dispose-then-start, NOT start-then-dispose: the old session's doc wiring is
 * only unsubscribed at the END of its teardown, so starting first would record
 * the same keystroke into both logs. Dropping the sub-second gap is safe —
 * the successor's catch-up doc.open re-reads the live buffer, so reconstruction
 * resynchronises and no divergence is flagged.
 */
async function rotate(
  context: vscode.ExtensionContext,
  extensionDistPath: string,
  extension: vscode.Extension<unknown>,
  root: string,
  manifest: Manifest,
  endedSessionId: string,
): Promise<void> {
  if (rotating.has(root)) return;
  rotating.add(root);
  try {
    const current = registry.get(root);
    if (current === undefined || current.sessionId !== endedSessionId) return;
    await current.dispose('rotate');
    await startAndRegister(context, extensionDistPath, extension, root, manifest, endedSessionId);
  } catch (e: unknown) {
    console.error('[provenance] session rotation failed:', e);
  } finally {
    rotating.delete(root);
  }
}
```

Then replace both existing call sites' bodies with `await startAndRegister(...)`. Keep every dep they pass today — do not drop `isOwnedByThisRoot`, `isRepoOwnedByThisRoot`, `secrets`, `heartbeatDeps`, `createStatusBar`, or `extensionDistPath`. `registry.add()` overwrites the map entry for the same root, so no new registry method is needed. Do not change `activateImpl()` (the legacy single-folder path kept for `activation.integration.test.ts`).

- [ ] **Step 14: Verify the whole recorder workspace**

```bash
cd /Users/aaryanmehta/projects/provenance
npx vitest run --root packages/recorder
npm run typecheck
npm run lint
npm run bench --workspace=packages/recorder
```

Expected: all tests PASS; typecheck and lint clean; the benchmark's p99 still far under 1 ms (the hot path gained one integer add in `append`, and the comparison runs once per 100 entries). If p99 regressed, stop and report.

- [ ] **Step 15: Commit**

```bash
cd /Users/aaryanmehta/projects/provenance
git add -- packages/recorder/src/session/session-registry.ts \
  packages/recorder/src/session/session-registry.test.ts \
  packages/recorder/src/extension.ts
git commit --no-gpg-sign -m "feat(recorder): rotate a session when its log passes 40 MiB"
```

---

### Task 3: Monorepo docs and the `/architecture` page

CLAUDE.md requires `/architecture` to be correct in the same PR as a recorder state-machine change. The rotation is a self-transition on the existing `recording` node, so **no new node is added** and `nodes.coverage.test.ts` stays green.

**Files:**

- Modify: `docs/prd.md` — §4.6 (add a rotation paragraph), §4.7 (disk bullet), §4.8 (failure-table row)
- Modify: `tools/architecture/dot/state.dot` — new `recording -> recording` edge
- Modify: `packages/analyzer/src/views/architecture/content/nodes/state.ts` — extend the `recording` node body
- Regenerate: `packages/analyzer/src/views/architecture/diagrams/state.svg` (via the build script)

**Interfaces:**

- Consumes: the `ROTATE_AT_BYTES` value and the `rotate` reason string from Task 2.
- Produces: nothing other tasks consume.

- [ ] **Step 1: PRD §4.6**

After the paragraph in `docs/prd.md` §4.6 that begins "Both files are written atomically", insert:

```markdown
**Size rotation.** A session whose `.slog` passes `ROTATE_AT_BYTES` (40 MiB) is rotated: the recorder emits `session.end` with `reason: "rotate"`, seals the session through the ordinary teardown path, and immediately starts a new session in the same scope whose `prev_session_id` names the one that just ended. The threshold is checked at the existing checkpoint cadence (every 100 entries), never per event. This exists because `submission: "git"` assignments commit `.provenance/` to a GitHub repo, and GitHub warns at 50 MB and refuses a push containing a file over 100 MB — a session now lives for the editor's lifetime, so without rotation a long-running session can grow past the limit and make the student unable to submit. Rotation is not a format change: `reason` is a free-form string and `prev_session_id` already exists. The successor's catch-up `doc.open` carries live buffer content, so a rotation seam shows no content divergence even when a buffer is unsaved.
```

- [ ] **Step 2: PRD §4.7 and §4.8**

In §4.7, append to the "Disk:" bullet:

```markdown
- No single `.slog` exceeds 40 MiB, because the session rotates at that size (§4.6). This bounds the per-file size independently of how long a session lives, which the 20 MB-per-4-hours figure does not.
```

In the §4.8 failure table, add a row after the "Disk full" row:

```markdown
| Log file approaching GitHub's file-size limit | At the next checkpoint, emit `session.end` (`reason: "rotate"`), seal, and start a new session linked by `prev_session_id` (§4.6) |
```

- [ ] **Step 3: The diagram edge**

In `tools/architecture/dot/state.dot`, after the `recording -> suspended` edge, add:

```dot
  recording -> recording[label="log passes 40 MiB — session.end{rotate},\nseal, then a FRESH session.start carrying\nprev_session_id into a NEW log file. Keeps every\nfile under GitHub's 100 MB push limit" color="#17bfae" style=dashed]
```

- [ ] **Step 4: Regenerate**

```bash
cd /Users/aaryanmehta/projects/provenance
python3 tools/architecture/build_diagrams.py
```

Requires Graphviz (`brew install graphviz`). If Graphviz is unavailable, STOP and report — do not hand-edit the SVG.

- [ ] **Step 5: Node detail**

In `packages/analyzer/src/views/architecture/content/nodes/state.ts`, append a paragraph to the `recording` node's `body` string (keep the `\n\n` separator style). It must state: the rotation threshold (40 MiB); that it is checked at the checkpoint cadence, not per event; that the reason string is `rotate`; that the successor links by `prev_session_id`; and why (GitHub's 50 MB warning / 100 MB push refusal against `.provenance/` committed to a git submission). Do not edit `content/nodes.ts` — it is derived.

- [ ] **Step 6: Verify**

```bash
cd /Users/aaryanmehta/projects/provenance
npx vitest run --root packages/analyzer src/views/architecture
npm run lint
```

Expected: PASS, including `nodes.coverage.test.ts`. Note: 6 pre-existing `ManifestComposerView` failures come from a local gitignored `.env` and are unrelated — see the project memory; do not chase them.

- [ ] **Step 7: Confirm student docs need nothing**

```bash
cd /Users/aaryanmehta/projects/provenance
grep -niE "one file|per session|session-\*?\.slog" docs/student-guide.md docs/student-faq-short.html packages/analyzer/src/views/faq/faq-content.ts
```

Expected: only `docs/student-guide.md:170`, which says the `session-*.slog` files are readable JSON — true regardless of rotation. No edit needed. If anything else claims one file per session, update it.

- [ ] **Step 8: Commit**

```bash
cd /Users/aaryanmehta/projects/provenance
git add -- docs/prd.md tools/architecture/dot/state.dot \
  packages/analyzer/src/views/architecture/content/nodes/state.ts \
  packages/analyzer/src/views/architecture/diagrams/state.svg
git commit --no-gpg-sign -m "docs: document 40 MiB session rotation in the PRD and /architecture"
```

---

### Task 4: JetBrains recorder rotation

**Repo:** `/Users/aaryanmehta/projects/provenance-jetbrains-recorder`. Ignore anything under `.claude/worktrees` — stale copies.

Port of Task 2, with the same four gaps plus one that is specific to this repo:

1. `endSession(reason: String)` already takes a reason, so `endSession("rotate")` needs no change. But `RecorderSessionManager.stop()` reaches it only through the `Disposer` hook that passes `"dispose"` — so rotation must call `endSession("rotate")` **explicitly first** (it is idempotent, so the later Disposer hook becomes a no-op).
2. `prevSessionIdFor` (`recorder/src/main/kotlin/dev/provenance/recorder/session/RecoveryLinkage.kt:15`) returns an id only for `RecoveryDecision.PreviousSessionDangling`. A rotated session ends cleanly → `PreviousSessionComplete` → null. Do **not** fake a `PreviousSessionDangling`; that would mislabel a clean end as a crash. Add an explicit override parameter instead.
3. `SessionWriter` has no cumulative byte counter (`bufferedBytes` resets on flush).
4. The threshold must be an overridable constructor default, mirroring `checkpointInterval: Int = CheckpointCadence.DEFAULT_INTERVAL`.
5. **JetBrains-only trap:** `DocWiring` is _project_-scoped and its `seenPaths` dedup set is never reset while any session is live. With two or more assignment roots open, rotating one root would emit **no** `doc.open` baselines into the successor's log — the new `.slog` would have a reconstruction with no starting content. Fix it explicitly; do not rely on the registry transiently emptying in the single-root case.

**Files:**

- Modify: `recorder/src/main/kotlin/dev/provenance/recorder/io/SessionWriter.kt`
- Modify: `recorder/src/main/kotlin/dev/provenance/recorder/session/RecordingSessionController.kt`
- Modify: `recorder/src/main/kotlin/dev/provenance/recorder/session/RecorderSessionManager.kt`
- Modify: `recorder/src/main/kotlin/dev/provenance/recorder/wiring/DocWiring.kt`
- Test: `recorder/src/test/kotlin/dev/provenance/recorder/session/RecordingSessionControllerTest.kt`
- Test: `recorder/src/test/kotlin/dev/provenance/recorder/session/RecorderSessionManagerTest.kt`

**Interfaces:**

- `SessionWriter.bytesAppended: Long` — cumulative, never reset by a flush
- `RecordingSessionController(… , maxSlogBytes: Long = ROTATE_AT_BYTES, onRotationNeeded: ((String) -> Unit)? = null)` — the callback receives the ended session's logical `session_id`
- `RecordingSessionController.ROTATE_AT_BYTES: Long = 40L * 1024 * 1024` (companion object const)
- `RecorderSessionManager.start(… , prevSessionIdOverride: String? = null)`
- `DocWiring.forgetRoot(root: Path)` — drops every `seenPaths` entry under `root` so the next `catchUpOpenFiles()` re-emits that root's baselines
- `RecorderSessionManager.rotate(root: Path)` — the swap

- [ ] **Step 1: Read first**

Read, in this order: `RecordingSessionController.kt` (constructor params ~line 133-142, `endSession` 690-742, the `createSessionHost` wiring 502-506), `SessionEntryRouter.kt:32-52`, `SessionWriter.kt:69,106-126`, `RecorderSessionManager.kt` (`start` 374-461, `restartSessions` 342-368, `stop`/`stopOne` 509-521, `ensureRoutedWiring` 116-158), `DocWiring.kt:252-291`, and the two test files named above (for `NoopScheduler`, `FixedClock`, and the `controller(checkpointInterval = 3)` override idiom).

- [ ] **Step 2: Write the failing writer test**

In `recorder/src/test/kotlin/dev/provenance/recorder/io/SessionWriterTest.kt` (create it if absent, following the nearest existing writer test's tmpdir + `FixedClock` setup):

```kotlin
    @Test
    fun `bytesAppended is cumulative across flushes and matches the file size`() {
        val writer = SessionWriter(slogPath, clock)
        assertEquals(0L, writer.bytesAppended)
        writer.append(entryA)
        val afterFirst = writer.bytesAppended
        assertTrue(afterFirst > 0L)
        writer.flush()
        assertEquals(afterFirst, writer.bytesAppended)
        writer.append(entryB)
        assertTrue(writer.bytesAppended > afterFirst)
        writer.dispose()
        assertEquals(Files.size(slogPath), writer.bytesAppended)
    }
```

Construct `entryA`/`entryB` exactly as the neighbouring tests build a `HashedEnvelope`, and match `SessionWriter`'s real constructor/factory signature as read in Step 1.

- [ ] **Step 3: Run it**

```bash
cd /Users/aaryanmehta/projects/provenance-jetbrains-recorder
./gradlew --console=plain :recorder:test --tests "dev.provenance.recorder.io.SessionWriterTest"
```

Expected: FAIL to compile — `bytesAppended` unresolved.

- [ ] **Step 4: Implement the counter**

In `SessionWriter.kt`, beside `private var bufferedBytes = 0` (line 69):

```kotlin
    /**
     * Total bytes appended over this writer's lifetime. Unlike [bufferedBytes] a
     * flush never resets it, so once everything is flushed it equals the `.slog`'s
     * size on disk. Size rotation (recorder PRD §4.6) reads it at checkpoint
     * cadence; the hot path pays one addition.
     */
    @Volatile
    var bytesAppended: Long = 0L
        private set
```

In `append()` (lines 106-116) the line's byte size is already computed into a local; add it to `bytesAppended` as well as `bufferedBytes`. Re-run the Step 3 command; expect PASS.

- [ ] **Step 5: Write the failing controller test**

In `RecordingSessionControllerTest.kt`, using that file's `controller(...)` helper (which already exposes `checkpointInterval` and a `Dispatchers.Unconfined` `checkpointScopeFactory`):

```kotlin
    fun `testRequestsRotationOnceTheLogPassesTheThreshold`() {
        val rotations = mutableListOf<String>()
        val c = controller(
            checkpointInterval = 10,
            maxSlogBytes = 512L,
            onRotationNeeded = { endedId -> rotations.add(endedId) },
        )
        // Below the checkpoint cadence: the size is not even read yet.
        repeat(9) { c.host.emit("doc.save", docSavePayload()) }
        assertTrue(rotations.isEmpty())
        c.host.emit("doc.save", docSavePayload())
        assertEquals(listOf(c.sessionId), rotations)
        c.endSession("rotate")
    }
```

Name `docSavePayload()` / `c.host` / `c.sessionId` to match what the file's existing tests actually use — read them first and reuse those helpers verbatim.

- [ ] **Step 6: Run it, then implement the trigger**

```bash
cd /Users/aaryanmehta/projects/provenance-jetbrains-recorder
./gradlew --console=plain :recorder:test --tests "dev.provenance.recorder.session.RecordingSessionControllerTest"
```

Expected: FAIL to compile. Then add to `RecordingSessionController`'s constructor, beside `checkpointInterval`:

```kotlin
    maxSlogBytes: Long = ROTATE_AT_BYTES,
    private val onRotationNeeded: ((String) -> Unit)? = null,
```

and to its companion object:

```kotlin
        /**
         * Rotate a session once its `.slog` passes this size (recorder PRD §4.6).
         * `submission: "git"` assignments commit `.provenance/` to a GitHub repo;
         * GitHub warns at 50 MB and refuses a push containing a file over 100 MB.
         */
        const val ROTATE_AT_BYTES: Long = 40L * 1024 * 1024
```

In the `createSessionHost` lambda (lines 502-506), after the existing `routeSessionEntry(...)` call, add the check — only when the cadence fired, so extend `routeSessionEntry`'s `scheduleCheckpoint` lambda rather than the per-entry path:

```kotlin
            { seq, hash ->
                checkpointScheduler.schedule(seq, hash)
                // Size rotation (PRD §4.6): read at checkpoint cadence, never per
                // entry — doc events must stay under 1 ms p99 (§4.7). The degraded
                // branch in routeSessionEntry returns before this, so a degraded
                // session never rotates, which is required.
                if (!rotationRequested && writer.bytesAppended >= maxSlogBytes) {
                    rotationRequested = true
                    onRotationNeeded?.invoke(ctx.sessionId)
                }
            }
```

with `private var rotationRequested = false` as a field. Use the real property name for the session id on `ctx` as read in Step 1. Re-run; expect PASS.

- [ ] **Step 7: Add the `prev_session_id` override**

In `RecorderSessionManager.start(...)` add a parameter `prevSessionIdOverride: String? = null`, and where the controller is constructed pass the effective value `prevSessionIdOverride ?: prevSessionIdFor(recovery)`. Do not modify `RecoveryLinkage.kt` or `ChainRecovery.kt`; add a comment at the new parameter explaining that recovery deliberately links only a dangling session, so a clean rotation must state its predecessor explicitly.

- [ ] **Step 8: Add `DocWiring.forgetRoot` and its test**

In `DocWiring.kt`, beside the `seenPaths` declaration:

```kotlin
    /**
     * Forget the `doc.open` baselines already emitted for files under [root], so
     * the next [catchUpOpenFiles] re-emits them.
     *
     * Needed by size rotation (recorder PRD §4.6): this dedup set is
     * project-scoped and outlives any single session, so a rotated root whose
     * project still has other live sessions would otherwise get a successor log
     * with no `doc.open` baseline at all — a reconstruction with no starting
     * content.
     */
    fun forgetRoot(root: Path) {
        seenPaths.removeIf { Path.of(it).startsWith(root) }
    }
```

Match `seenPaths`'s actual element type (absolute path strings per the exploration — verify) and adjust accordingly. Add a test in the existing `DocWiring` test class: two roots' files seen, `forgetRoot(rootA)`, then assert a subsequent `catchUpOpenFiles()` re-emits only `rootA`'s files.

- [ ] **Step 9: Add `RecorderSessionManager.rotate` and its test**

```kotlin
    /**
     * Rotate the session at [root]: end it with `session.end{reason:"rotate"}`,
     * seal it, then start its successor linked by `prev_session_id`.
     *
     * End-then-start, not the reverse: the old session's wiring is only detached
     * during its teardown, so starting first would record one keystroke into two
     * logs. `forgetRoot` is what makes the successor emit its own `doc.open`
     * baselines, since `DocWiring` is project-scoped.
     */
    suspend fun rotate(root: Path) {
        val normalized = root.normalize()
        if (!rotating.add(normalized)) return
        try {
            val current = sessions[normalized] ?: return
            val endedId = current.controller.sessionId
            val manifest = current.activated.manifest
            current.controller.endSession("rotate")
            stop(normalized)
            routedWiring?.docWiring?.forgetRoot(normalized)
            startFromActivation(normalized, manifest, prevSessionIdOverride = endedId)
        } finally {
            rotating.remove(normalized)
        }
    }
```

with `private val rotating = ConcurrentHashMap.newKeySet<Path>()`. Thread `prevSessionIdOverride` through `startFromActivation` to `start`. Wire `onRotationNeeded` where `start` constructs the controller, so it calls `rotate(root)` on the manager's own coroutine scope. In `RecorderSessionManagerTest.kt`, add a platform test: start a session with `maxSlogBytes` tiny, drive enough entries to cross a small `checkpointInterval`, then assert the old `.slog` ends with `session.end{reason:"rotate"}`, a second `.slog` exists whose `session.start.prev_session_id` is the old session's id, both validate, and the successor contains a `doc.open` for the open file.

- [ ] **Step 10: Run the suites**

```bash
cd /Users/aaryanmehta/projects/provenance-jetbrains-recorder
./gradlew :core:test
./gradlew :recorder:test
```

Expected: all PASS, including `ConformanceTest` (rotation changes no format primitive, so a conformance failure means something is wrong — never touch the fixtures).

- [ ] **Step 11: Run the cross-implementation analyzer gate**

```bash
cd /Users/aaryanmehta/projects/provenance-jetbrains-recorder
PROVENANCE_MONOREPO=/Users/aaryanmehta/projects/provenance scripts/e2e/run_e2e.sh
```

The monorepo must be built (`npm ci && npm run build`) or the script skips with exit 0 — a skip is NOT a pass; if it skips, build the monorepo and re-run. Expected: all 8 validation checks pass on both the classic and rolling bundles.

- [ ] **Step 12: Commit**

```bash
cd /Users/aaryanmehta/projects/provenance-jetbrains-recorder
git add -- recorder/src/main/kotlin/dev/provenance/recorder/io/SessionWriter.kt \
  recorder/src/main/kotlin/dev/provenance/recorder/session/RecordingSessionController.kt \
  recorder/src/main/kotlin/dev/provenance/recorder/session/RecorderSessionManager.kt \
  recorder/src/main/kotlin/dev/provenance/recorder/wiring/DocWiring.kt \
  recorder/src/test/kotlin/dev/provenance/recorder
git commit --no-gpg-sign -m "feat(recorder): rotate a session when its log passes 40 MiB"
```

---

### Task 5: Neovim recorder rotation

**Repo:** `/Users/aaryanmehta/projects/provenance-neovim-recorder`.

This port needs the least new surface: `recording_session.start` already accepts `opts.prev_session_id` and it already wins over recovery (`lua/provenance/recorder/session/recording_session.lua:284-288`), and `session.stop(reason)` already threads a free-form reason into `session.end` and is idempotent. Two gaps remain: no cumulative byte counter in `session_writer.lua`, and `registry.ensure_session` is idempotent with no replace path.

**Files:**

- Modify: `lua/provenance/recorder/io/session_writer.lua`
- Modify: `lua/provenance/recorder/session/recording_session.lua`
- Modify: `lua/provenance/recorder/registry.lua`
- Test: `tests/recorder/io/session_writer_spec.lua`
- Test: `tests/recorder/session_lifecycle_spec.lua`
- Test: `tests/recorder/registry_spec.lua`

**Interfaces:**

- `writer.bytes_appended()` — cumulative byte count, not reset by a flush
- `recording_session.start({ …, rotate_bytes = <number>, on_rotate_needed = function(ended_session_id) … end })`, `rotate_bytes` defaulting to `40 * 1024 * 1024`
- `reg.rotate_session(root)` — stop the entry for `root` with reason `"rotate"`, clear it, start a replacement with `prev_session_id` set

- [ ] **Step 1: Read first**

`lua/provenance/recorder/io/session_writer.lua` (`M.open` 36, `append` 108-126, `flush` 57-104), `recording_session.lua` (opts doc 105-137, `M.start` 138, prev_session_id 258-288, `on_entry` 557-574, `stop` 789-861), `registry.lua` (`ensure_session` 175-195, `stop_all` 203-208), `recording_controller.lua:26`, and the spec files named above (for `new_scratch()`, `core_clock.fixed`, and the `checkpoint_interval = 3` override idiom).

- [ ] **Step 2: Write the failing writer spec**

In `tests/recorder/io/session_writer_spec.lua`, following that file's existing temp-path setup:

```lua
  it("reports cumulative bytes across flushes", function()
    local writer = session_writer.open({ slog_path = slog_path })
    assert.equals(0, writer.bytes_appended())
    writer.append(entry_a)
    local after_first = writer.bytes_appended()
    assert.is_true(after_first > 0)
    writer.flush()
    -- A flush clears the buffer, never the cumulative total.
    assert.equals(after_first, writer.bytes_appended())
    writer.append(entry_b)
    assert.is_true(writer.bytes_appended() > after_first)
    writer.dispose()
    assert.equals(vim.loop.fs_stat(slog_path).size, writer.bytes_appended())
  end)
```

Build `entry_a`/`entry_b` the way that spec's existing cases build hashed entries.

- [ ] **Step 3: Run it**

```bash
cd /Users/aaryanmehta/projects/provenance-neovim-recorder
XDG_CONFIG_HOME=$(pwd)/.test-xdg nvim --headless --noplugin -u tests/minimal_init.lua \
  -c "PlenaryBustedFile tests/recorder/io/session_writer_spec.lua"
```

Expected: FAIL — `bytes_appended` is nil.

- [ ] **Step 4: Implement the counter**

In `session_writer.lua`, beside `local buffered_bytes = 0` (line 47) add `local total_bytes = 0`. In `append` increment both by the serialized line's length (the value is already computed there). Do **not** reset `total_bytes` in `flush` or in `fail`. Expose:

```lua
  --- Total bytes appended over this writer's lifetime. Unlike `buffered_bytes`
  --- a flush never resets it, so once flushed it equals the `.slog`'s size on
  --- disk. Size rotation (PRD §4.6) reads it at checkpoint cadence.
  function writer.bytes_appended()
    return total_bytes
  end
```

Re-run Step 3; expect PASS.

- [ ] **Step 5: Add the trigger in `recording_session.lua`**

Add to the opts doc block and to `M.start`:

```lua
  --- rotate_bytes: number|nil -- rotate once the .slog passes this size; default ROTATE_BYTES
  --- on_rotate_needed: fun(ended_session_id: string)|nil -- called once when it does
```

```lua
--- Rotate a session once its `.slog` passes this size (PRD §4.6).
---
--- `submission = "git"` assignments commit `.provenance/` to a GitHub repo, and
--- GitHub warns at 50 MB and refuses a push containing a file over 100 MB.
local ROTATE_BYTES = 40 * 1024 * 1024
```

In the `on_entry` handler (lines 557-574), inside the existing `if cadence.on_entry_appended() then` branch, after `scheduler.schedule(...)`:

```lua
        -- Size rotation (PRD §4.6). Inside the cadence branch, so this costs one
        -- comparison per 100 entries rather than one per keystroke — on_bytes is
        -- the edit firehose. The degraded branch above returns first, so a
        -- degraded session never rotates, which is required. The callback is
        -- deferred: rotation does teardown I/O and must not run inside on_bytes.
        if not rotation_requested and writer.bytes_appended() >= rotate_bytes then
          rotation_requested = true
          local ended_id = context.session_id
          if on_rotate_needed then
            vim.schedule(function()
              on_rotate_needed(ended_id)
            end)
          end
        end
```

with `local rotation_requested = false` and `local rotate_bytes = opts.rotate_bytes or ROTATE_BYTES` in scope.

- [ ] **Step 6: Add `reg.rotate_session` in `registry.lua`**

```lua
--- Rotate the session at `root`: stop it with reason "rotate" (which emits
--- `session.end` and takes the final rolling seal), then start a replacement
--- whose `prev_session_id` names the session that just ended.
---
--- Stop-then-start, not the reverse: `doc_wiring.attach` is per-session and the
--- old session's autocmds are only detached during its stop, so starting first
--- would record one keystroke into two logs. The replacement's own catch-up pass
--- re-emits `doc.open` for every loaded buffer, so it gets its own baseline.
function reg.rotate_session(root)
  if rotating[root] then
    return
  end
  rotating[root] = true
  local ok, err = pcall(function()
    local entry = sessions[root]
    if entry == nil then
      return
    end
    local ended_id = entry.controller.session_id
    pcall(entry.controller.stop, "rotate")
    sessions[root] = nil
    reg.ensure_session(root, entry.manifest, { prev_session_id = ended_id })
  end)
  rotating[root] = nil
  if not ok then
    vim.notify("[provenance] session rotation failed: " .. tostring(err), vim.log.levels.WARN)
  end
end
```

with `local rotating = {}` beside `sessions`. Confirm `ensure_session`'s third argument really is forwarded into `start_recording` as extra opts (read lines 175-195); if it is not, thread it through. Where `ensure_session` calls `start_recording`, pass `on_rotate_needed = function() reg.rotate_session(root) end`.

- [ ] **Step 7: Add the specs**

- `tests/recorder/registry_spec.lua`, using that file's `make_start_recording_spy()`: `reg.rotate_session(root)` calls the existing fake controller's `stop` with `"rotate"`, then calls `start_recording` a second time for the same root with `prev_session_id` equal to the first controller's `session_id`.
- `tests/recorder/session_lifecycle_spec.lua`, using `new_scratch()` and a real verified manifest: start with `checkpoint_interval = 3, rotate_bytes = 512`, emit entries until the callback fires, assert it fired exactly once with the session's own id, and assert no callback before the third entry.
- An end-to-end rotation assertion in the same spec: after a real `stop("rotate")` and a real replacement start with `prev_session_id`, the first `.slog`'s last entry is `session.end` with `reason == "rotate"`, the second `.slog`'s `session.start.data.prev_session_id` is the first session's id, both chains validate, and the second log contains a `doc.open` for the open buffer.

- [ ] **Step 8: Run the whole suite**

```bash
cd /Users/aaryanmehta/projects/provenance-neovim-recorder
make test
```

Expected: all PASS, including `tests/conformance/conformance_spec.lua` (rotation changes no format primitive — never edit the vectors to make it pass).

- [ ] **Step 9: Commit**

```bash
cd /Users/aaryanmehta/projects/provenance-neovim-recorder
git add -- lua/provenance/recorder/io/session_writer.lua \
  lua/provenance/recorder/session/recording_session.lua \
  lua/provenance/recorder/registry.lua tests/
git commit --no-gpg-sign -m "feat(recorder): rotate a session when its log passes 40 MiB"
```

---

## Self-review notes

- **Spec coverage.** §3.1 threshold/trigger → Tasks 2 Steps 8-10, 4 Steps 4-6, 5 Steps 4-5. §3.2 sequence → Task 2 Step 13, Task 4 Step 9, Task 5 Step 6. §3.3 buffer-sourced baselines → Task 1 Steps 2-3 (analyzer side), Task 4 Step 8 (the `seenPaths` gap that would break it), Task 5 Step 7. §3.4 failure handling → the degraded-path note in Tasks 2/4/5 and the `catch`/`pcall` wrappers. §4 analyzer → Task 1. §5 tests → each task's own steps plus Task 4 Step 11's cross-implementation gate. §6 docs → Task 3. §7 delivery → the task order section.
- **Known deviation from the spec.** The spec's §5 recorder test list has a fourth case, "new session start fails → degraded path; A remains sealed and valid". Tasks 2, 4, and 5 cover that failure path in code (the `catch` / `finally` / `pcall` wrappers) but do not add a dedicated test for it, because injecting a start failure needs a seam none of the three repos has. Add the seam only if a reviewer asks; otherwise note it in the PR description.
- **Threshold in three places.** `ROTATE_AT_BYTES` is defined once per repo (three total), which is inherent to three independently-written recorders — the same way `CHECKPOINT_INTERVAL` = 100 already is. The conformance vectors do not cover it because it is not part of the format.
