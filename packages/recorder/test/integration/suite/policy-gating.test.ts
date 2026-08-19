/**
 * Integration suite for the capture policy (program spec §4) against the
 * RESTRICTIVE fixture — `test-workspace-policy/`, whose Manifest 2.0 is signed
 * by the same dev course key and carries the same dev `course_cert` as
 * `test-workspace/`, but sets:
 *
 *   selection_change: false, focus_change: false, terminal: false,
 *   heartbeat_interval_ms: 5000
 *
 * The permissive counterpart is `recorder.test.ts`; both suites drive VS Code
 * through the SAME helpers, so the only difference between them is the signed
 * policy. That is what makes "no selection.change here" evidence of gating
 * rather than evidence of a test that never moved the cursor.
 *
 * ## Why this suite exists
 *
 * Everything else about the policy is covered by unit tests on pure functions.
 * What no unit test can show is that the policy survives the whole real path —
 * file on disk → manifest verification → `resolveVerifiedCapturePolicy` →
 * `createSessionHost` → the running Extension Host. Until this suite, the only
 * integration fixture enabled every knob, so gating never once occurred in a
 * real host.
 *
 * ## The three properties, in order of what they'd catch
 *
 * 1. **No `selection.change` entries.** Catches the gate being dropped, or
 *    wired at the wrong seam.
 * 2. **The shortened heartbeat cadence takes effect.** The strongest signal:
 *    a suppressed event kind is also "absent" if the policy were parsed and
 *    then thrown away, but a 5s heartbeat can only be produced by a policy that
 *    reached the *running* recorder. It proves the policy is live, not inert
 *    cargo in `session.start`.
 * 3. **`seq` is contiguous from 0 and `validateChain` is ok.** The property
 *    everything else rests on. A suppressed event must consume no sequence
 *    number: `session-host.ts` drops it BEFORE `chainEntry`. If it were dropped
 *    after, the log would carry a hole, and validation check 4 (`seq_gaps`)
 *    reads a hole as a deleted entry — turning a course's privacy setting into
 *    a tamper signal against the student.
 */

import * as assert from 'node:assert/strict';
import {
  MANIFEST_FORMAT_VERSION_2,
  validateChain,
  verifyManifestChain,
} from '@provenance/log-core';
import { ROOT_PUBLIC_KEY_HEX } from '../../../src/activation/root-public-key.js';
import {
  createScratchFile,
  delay,
  driveSelectionChanges,
  editAndSave,
  entriesOfKind,
  openScratchEditor,
  readSlogEntries,
  removeScratchFile,
  sessionStartPayload,
  waitForActivation,
  workspaceRoot,
} from './helpers.js';
import type { HashedEnvelope } from '@provenance/log-core';

/** The cadence this fixture's signed manifest asks for. */
const FIXTURE_HEARTBEAT_INTERVAL_MS = 5_000;

/** The cadence a recorder that ignored the policy would use (log-core default). */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Halfway between the two cadences. A gap below this is impossible at the
 * default interval and expected at the fixture's, so it separates the two
 * hypotheses without depending on precise timer scheduling.
 */
const CADENCE_DISCRIMINATOR_MS =
  (FIXTURE_HEARTBEAT_INTERVAL_MS + DEFAULT_HEARTBEAT_INTERVAL_MS) / 2;

/**
 * Long enough for at least three ticks at 5s (and zero at 30s), plus the
 * buffered writer's flush window.
 */
const OBSERVATION_MS = 18_000;

suite('Provenance Recorder integration — restrictive capture policy', () => {
  let entries: readonly HashedEnvelope[] = [];

  suiteTeardown(async () => {
    await removeScratchFile(workspaceRoot());
  });

  test('records a session under the restrictive fixture', async function () {
    // eslint-disable-next-line @typescript-eslint/no-invalid-this
    this.timeout(90_000);

    await waitForActivation();

    const wsRoot = workspaceRoot();
    await createScratchFile(wsRoot);
    const editor = await openScratchEditor(wsRoot);

    // Identical driving code to the permissive suite.
    await driveSelectionChanges(editor);
    await editAndSave(editor, '# policy fixture\n');

    // Stay alive long enough to observe several heartbeats at the fixture's
    // cadence, then let the buffered writer flush.
    await delay(OBSERVATION_MS);

    entries = await readSlogEntries(wsRoot);
    assert.ok(entries.length > 0, 'no entries were read from the .slog');
  });

  test('the fixture manifest chain-verifies and carries the restrictive policy', async () => {
    const manifest = sessionStartPayload(entries).manifest;
    assert.ok(manifest !== undefined, 'session.start carries no `manifest` block');
    assert.equal(manifest.format_version, MANIFEST_FORMAT_VERSION_2);

    const result = await verifyManifestChain(manifest, ROOT_PUBLIC_KEY_HEX);
    assert.ok(
      result.ok,
      `fixture manifest failed verifyManifestChain: ${JSON.stringify(result.ok ? null : result.error)}`,
    );

    // The policy the analyzer will read back out of the bundle must be the one
    // the course signed — this is the absence-vs-disabled contract.
    assert.deepEqual(manifest.policy, {
      capture: {
        focus_change: false,
        heartbeat_interval_ms: FIXTURE_HEARTBEAT_INTERVAL_MS,
        selection_change: false,
        terminal: false,
      },
    });
  });

  test('no selection.change entries are produced', () => {
    const selections = entriesOfKind(entries, 'selection.change');
    assert.equal(
      selections.length,
      0,
      `expected zero selection.change entries under selection_change: false, got ${selections.length}`,
    );
  });

  test('no focus.change or terminal entries are produced', () => {
    for (const kind of ['focus.change', 'terminal.open', 'terminal.command']) {
      assert.equal(
        entriesOfKind(entries, kind).length,
        0,
        `expected zero ${kind} entries under this fixture's policy`,
      );
    }
  });

  test('floor event kinds are still recorded', () => {
    // Gating must not take the floor down with it (log-core FLOOR_EVENT_KINDS).
    for (const kind of ['session.start', 'doc.open', 'doc.save']) {
      assert.ok(entriesOfKind(entries, kind).length > 0, `floor kind ${kind} is missing`);
    }
  });

  test('the shortened heartbeat cadence reaches the running recorder', () => {
    const heartbeats = entriesOfKind(entries, 'session.heartbeat');
    assert.ok(
      heartbeats.length >= 2,
      `expected at least 2 session.heartbeat entries in ${OBSERVATION_MS}ms at a ` +
        `${FIXTURE_HEARTBEAT_INTERVAL_MS}ms cadence, got ${heartbeats.length}. ` +
        `At the ${DEFAULT_HEARTBEAT_INTERVAL_MS}ms default there would be at most one — ` +
        `the policy is not reaching the running recorder.`,
    );

    // `t` is the recorder's own monotonic ms-since-session-start, read out of
    // the log — no Date.now() in the assertion.
    for (let i = 1; i < heartbeats.length; i++) {
      const gap = heartbeats[i]!.t - heartbeats[i - 1]!.t;
      assert.ok(
        gap < CADENCE_DISCRIMINATOR_MS,
        `heartbeat gap of ${gap}ms is not attributable to the fixture's ` +
          `${FIXTURE_HEARTBEAT_INTERVAL_MS}ms cadence`,
      );
    }
  });

  test('suppressed events consume no seq: the chain is contiguous from 0 and valid', () => {
    for (let i = 0; i < entries.length; i++) {
      assert.equal(
        entries[i]!.seq,
        i,
        `seq hole at index ${i}: entry has seq ${entries[i]!.seq}. A policy-suppressed ` +
          `event must be dropped before chainEntry, or validation check 4 (seq_gaps) ` +
          `reads the hole as a deleted entry.`,
      );
    }

    const result = validateChain(entries);
    assert.ok(
      result.ok,
      `validateChain rejected the policy-gated log: ${JSON.stringify(result.ok ? null : result.break)}`,
    );
  });
});
