/**
 * Integration suite for the Provenance Recorder extension against the
 * PERMISSIVE fixture — `test-workspace/`, whose Manifest 2.0 enables every
 * capture knob. The restrictive counterpart is `policy-gating.test.ts`.
 *
 * Runs inside VS Code's Extension Host via @vscode/test-electron.
 * Uses the Mocha TDD interface (suite / test) as required by the suite runner.
 *
 * What this tests:
 *  1. The extension activates.
 *  2. A .provenance/ directory is created in the fixture workspace.
 *  3. Editing a file produces a .slog containing session.start, doc.open,
 *     doc.change (or paste), doc.save, and — under this fixture's policy —
 *     selection.change.
 *  4. The `session.start` payload really is the 2.0 shape: a full `manifest`
 *     at format_version 2.0 with a root-signed `course_cert` and a `policy`,
 *     plus the `host` block.
 *  5. That embedded manifest chain-verifies against the ROOT key the recorder
 *     itself embeds, using log-core's real `verifyManifestChain`.
 *  6. The .slog passes log-core's real `validateChain`.
 *
 * Why 4–6 exist: the previous version of this suite asserted only that four
 * event KINDS were present. A silent regression of the whole Manifest 2.0 path
 * back to 1.x — no course_cert, no policy, no host block, a payload signed by
 * the grandfathered legacy course key — would have left all of those kinds
 * present and every test green. The suite's own docstring claimed the fixture
 * chained to the root key; nothing checked it.
 *
 * Limitations:
 *  - We cannot verify the status bar item directly (VS Code's test API doesn't
 *    expose status bar items; it's a known gap in the API).
 */

import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { statSync } from 'node:fs';
import * as vscode from 'vscode';
import {
  MANIFEST_FORMAT_VERSION_2,
  verifyManifestChain,
  validateChain,
} from '@provenance/log-core';
import { ROOT_PUBLIC_KEY_HEX } from '../../../src/activation/root-public-key.js';
import {
  ACTIVATION_TIMEOUT_MS,
  createScratchFile,
  delay,
  driveSelectionChanges,
  editAndSave,
  kindsIn,
  openScratchEditor,
  readSlogEntries,
  removeScratchFile,
  sessionStartPayload,
  waitForActivation,
  waitUntil,
  workspaceRoot,
} from './helpers.js';
import type { HashedEnvelope } from '@provenance/log-core';

/** Time given to the buffered SessionWriter to flush before we read the .slog. */
const FLUSH_GRACE_MS = 5_000;

suite('Provenance Recorder integration — permissive fixture', () => {
  let entries: readonly HashedEnvelope[] = [];

  suiteTeardown(async () => {
    // Finding 4: the old suite edited the tracked fixture `hw.py` and never
    // restored it, so `git status` was dirty after every run. We edit an
    // untracked scratch file instead and remove it here.
    await removeScratchFile(workspaceRoot());
  });

  test('extension activates within 15 seconds', async () => {
    await waitForActivation();
  });

  test('.provenance/ directory is created in workspace root', async () => {
    const provenanceDir = path.join(workspaceRoot(), '.provenance');
    await waitUntil(
      () => {
        try {
          // Sync check — ok for polling in tests.
          statSync(provenanceDir).isDirectory();
          return true;
        } catch {
          return false;
        }
      },
      ACTIVATION_TIMEOUT_MS,
      `.provenance/ directory to exist at ${provenanceDir}`,
    );
  });

  test('editing a file produces a .slog with the expected event kinds', async function () {
    // eslint-disable-next-line @typescript-eslint/no-invalid-this
    this.timeout(60_000);

    const wsRoot = workspaceRoot();

    // All mutation happens in an untracked scratch file, never in a tracked
    // fixture — see suiteTeardown.
    await createScratchFile(wsRoot);
    const editor = await openScratchEditor(wsRoot);
    await driveSelectionChanges(editor);
    await editAndSave(editor, '# integration test\n');

    await delay(FLUSH_GRACE_MS);

    // Cached for the remaining tests in this suite — they all read the same
    // session, and re-reading would race the writer for no benefit.
    entries = await readSlogEntries(wsRoot);

    const kinds = kindsIn(entries);
    const present = [...kinds].join(', ');

    assert.ok(kinds.has('session.start'), `Missing session.start. Kinds present: ${present}`);
    assert.ok(kinds.has('doc.open'), `Missing doc.open. Kinds present: ${present}`);
    assert.ok(
      kinds.has('doc.change') || kinds.has('paste'),
      `Missing doc.change or paste. Kinds present: ${present}`,
    );
    assert.ok(kinds.has('doc.save'), `Missing doc.save. Kinds present: ${present}`);

    // The control half of the policy pair: this fixture's manifest sets
    // selection_change: true, and the same driving code runs in both suites.
    // Without this, "no selection.change under a restrictive policy" would be
    // satisfied just as well by a test that never moved the cursor.
    assert.ok(
      kinds.has('selection.change'),
      `Missing selection.change under a permissive policy. Kinds present: ${present}`,
    );
  });

  test('session.start carries a Manifest 2.0 with a root-signed course_cert and a policy', () => {
    const payload = sessionStartPayload(entries);

    const manifest = payload.manifest;
    assert.ok(manifest !== undefined, 'session.start carries no `manifest` block (1.x regression)');
    assert.equal(
      manifest.format_version,
      MANIFEST_FORMAT_VERSION_2,
      'embedded manifest is not format_version 2.0',
    );

    const cert = manifest.course_cert;
    assert.ok(cert !== undefined, 'embedded manifest carries no `course_cert`');
    assert.equal(typeof cert.root_sig, 'string');
    assert.ok(cert.root_sig.length > 0, 'course_cert.root_sig is empty');
    assert.equal(cert.course_id, manifest.course_id, 'course_cert.course_id != manifest.course_id');

    // The capture policy must travel into the bundle, or the analyzer cannot
    // tell "this student produced no selection.change events" from "this course
    // disabled selection.change" (log-core/src/policy.ts, absence-vs-disabled).
    assert.ok(manifest.policy !== undefined, 'embedded manifest carries no `policy` block');
  });

  test('the embedded manifest chain-verifies against the recorder ROOT key', async () => {
    const manifest = sessionStartPayload(entries).manifest;
    assert.ok(manifest !== undefined, 'session.start carries no `manifest` block');

    // The real chain verifier, against the very key the recorder build embeds —
    // so re-signing the fixture with a different course key, or swapping the
    // embedded root key, fails here.
    const result = await verifyManifestChain(manifest, ROOT_PUBLIC_KEY_HEX);
    assert.ok(
      result.ok,
      `embedded manifest failed verifyManifestChain: ${JSON.stringify(result.ok ? null : result.error)}`,
    );
  });

  test('session.start carries the `host` block identifying the VS Code recorder', () => {
    const host = sessionStartPayload(entries).host;
    assert.ok(host !== undefined, 'session.start carries no `host` block (1.x regression)');
    assert.equal(host.editor, 'vscode');
    assert.equal(typeof host.editor_version, 'string');
    assert.ok(host.editor_version.length > 0, 'host.editor_version is empty');
    // `editor_build` is legitimately '' — the VS Code public extension API
    // exposes no build/commit identifier (see recorder-context.ts). Assert the
    // field exists and is a string, NOT that it is non-empty.
    assert.equal(typeof host.editor_build, 'string');
    assert.equal(typeof host.platform, 'string');
    assert.ok(host.platform.length > 0, 'host.platform is empty');
  });

  test('an UNENROLLED student records normally, with `identity` omitted', () => {
    // The safety property of S2, and the only half of it a real host can show:
    // this fixture's VS Code profile holds no master secret and no enrollment
    // token, so `buildSessionIdentity` skips with `not_enrolled` and the session
    // must record exactly as it always has.
    //
    // The enrolled half is unit-tested instead (src/identity/session-identity.test.ts):
    // seeding it here would mean pre-populating the Extension Host's SecretStorage,
    // which is an OS credential vault with no test-time write path — and adding an
    // exported hook to reach it would put a "write the student's identity" API into
    // the shipped extension purely for a test.
    const payload = sessionStartPayload(entries);
    assert.equal(
      payload.identity,
      undefined,
      'session.start carries an `identity` block, but this fixture has no enrollment token — ' +
        'an identity was emitted that cannot have been verified.',
    );
    // Never blocks: the session is still a real, complete 2.0 recording.
    assert.ok(payload.manifest !== undefined, 'unenrolled session lost its manifest block');
    assert.ok(entries.length > 0, 'unenrolled session recorded nothing at all');
  });

  test('the enrollment commands are registered in the real host', async () => {
    // They are registered before the workspace guard, so a student can import
    // their identity secret on a new machine without a session running.
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'provenance.showEnrollmentKey',
      'provenance.importEnrollmentToken',
      'provenance.exportIdentitySecret',
      'provenance.importIdentitySecret',
    ]) {
      assert.ok(commands.includes(id), `command ${id} is not registered`);
    }
  });

  test('the produced .slog passes validateChain', () => {
    assert.ok(entries.length > 0, 'no entries were read from the .slog');
    const result = validateChain(entries);
    assert.ok(
      result.ok,
      `validateChain rejected the recorded log: ${JSON.stringify(result.ok ? null : result.break)}`,
    );
  });
});
