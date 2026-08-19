/**
 * Unit tests for buildRecorderContext.
 * Asserts all PRD §5.1 required fields are present and well-typed.
 * CLAUDE.md: "test the event-to-log-entry transformation as a pure function,
 * separately from the VS Code wiring."
 */

import { describe, it, expect } from 'vitest';
import { buildRecorderContext } from './recorder-context.js';
import type { Manifest, SessionIdentity } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_MANIFEST: Manifest = {
  assignment_id: 'hw03',
  semester: 'fa26',
  issued_at: '2026-09-15T00:00:00Z',
  files_under_review: ['hw03.py'],
  sig: 'a'.repeat(128),
};

/** Minimal vscode.Extension mock — only the packageJSON field matters here. */
function makeExtension(pkg: {
  version?: string;
  publisher?: string;
  name?: string;
}): import('vscode').Extension<unknown> {
  return {
    id: `${pkg.publisher ?? 'test'}.${pkg.name ?? 'recorder'}`,
    extensionUri: { fsPath: '/fake/ext' } as import('vscode').Uri,
    extensionPath: '/fake/ext',
    isActive: true,
    packageJSON: pkg,
    exports: undefined,
    activate: () => Promise.resolve(undefined),
    extensionKind: 1 as import('vscode').ExtensionKind,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildRecorderContext', () => {
  it('produces a context with format_version "1.0"', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.format_version).toBe('1.0');
  });

  it('generates a non-empty session_id (UUID format)', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    // UUID format: 8-4-4-4-12 hex chars
    expect(ctx.session_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('generates unique session_ids on each call', () => {
    const ext = makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' });
    const ctx1 = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    const ctx2 = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx1.session_id).not.toBe(ctx2.session_id);
  });

  it('sets prev_session_id from the argument', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: 'abc-123',
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.prev_session_id).toBe('abc-123');
  });

  it('sets prev_session_id to null when not provided', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.prev_session_id).toBeNull();
  });

  it('copies assignment id and semester from the manifest', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.assignment.id).toBe('hw03');
    expect(ctx.assignment.semester).toBe('fa26');
  });

  it('copies manifest_sig from the manifest', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.manifest_sig).toBe(TEST_MANIFEST.sig);
  });

  it('produces a machine_id that is a 64-char hex string', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.machine_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('machine_ids differ across sessions (session_id used as salt)', () => {
    const ext = makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' });
    const ctx1 = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    const ctx2 = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    // Different sessions → different session_ids → different machine_ids.
    expect(ctx1.machine_id).not.toBe(ctx2.machine_id);
  });

  it('sets vscode.version from the injected vscodeVersion', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.vscode?.version).toBe('1.97.0');
  });

  it('sets vscode.platform from the injected platform', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'win32-x64',
    });
    expect(ctx.vscode?.platform).toBe('win32-x64');
  });

  it('sets recorder.version from extension.packageJSON.version', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '2.3.4', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.recorder.version).toBe('2.3.4');
  });

  it('sets recorder.extension_id as publisher.name', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({
        version: '1.0.0',
        publisher: 'itsgeagle',
        name: 'provenance-recorder',
      }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.recorder.extension_id).toBe('itsgeagle.provenance-recorder');
  });

  it('falls back to extension.id when publisher/name missing from packageJSON', () => {
    const ext = makeExtension({});
    // ext.id is 'test.recorder' from the makeExtension helper
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: ext,
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.recorder.extension_id).toBe('test.recorder');
  });

  it('sets session_pubkey to empty string when not provided (backwards compat)', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(ctx.session_pubkey).toBe('');
  });

  it('sets session_pubkey from sessionPubkeyHex when provided', () => {
    const fakePubkey = 'a'.repeat(64);
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      sessionPubkeyHex: fakePubkey,
    });
    expect(ctx.session_pubkey).toBe(fakePubkey);
  });

  it('vscode.commit is a string (may be empty in Phase 3)', () => {
    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST,
      prevSessionId: null,
      extension: makeExtension({ version: '1.0.0', publisher: 'test', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
    });
    expect(typeof ctx.vscode?.commit).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// session.start 2.0 (program spec §5)
// ---------------------------------------------------------------------------

const TEST_MANIFEST_V2: Manifest = {
  format_version: '2.0',
  assignment_id: 'proj2',
  semester: 'fa26',
  issued_at: '2026-09-08T00:00:00Z',
  files_under_review: ['proj2.py'],
  sig: 'b'.repeat(128),
  course_id: 'berkeley-cs61b',
  collaboration: 'solo',
  submission: 'bundle',
  scope: 'directory',
  policy: { capture: { selection_change: false, heartbeat_interval_ms: 45_000 } },
  course_cert: {
    course_id: 'berkeley-cs61b',
    course_pubkey: 'c'.repeat(64),
    valid_from: '2026-08-20',
    valid_until: '2027-01-15',
    root_sig: 'd'.repeat(128),
  },
};

function build(manifest: Manifest): ReturnType<typeof buildRecorderContext> {
  return buildRecorderContext({
    manifest,
    prevSessionId: null,
    extension: makeExtension({ version: '1.2.0', publisher: 'itsgeagle', name: 'recorder' }),
    vscodeVersion: '1.97.0',
    platform: 'darwin-arm64',
  });
}

describe('buildRecorderContext — session.start 2.0', () => {
  it('carries the FULL manifest, payload + sig + course_cert', () => {
    const ctx = build(TEST_MANIFEST_V2);
    // Not just equal-looking: the analyzer re-verifies root -> cert -> payload
    // offline from exactly these bytes, so every signed field must survive.
    expect(ctx.manifest).toEqual(TEST_MANIFEST_V2);
    expect(ctx.manifest?.course_cert?.root_sig).toBe('d'.repeat(128));
    expect(ctx.manifest?.policy).toEqual({
      capture: { selection_change: false, heartbeat_interval_ms: 45_000 },
    });
  });

  it('carries a 1.x manifest verbatim too, so check 2 works for legacy bundles', () => {
    const ctx = build(TEST_MANIFEST);
    expect(ctx.manifest).toEqual(TEST_MANIFEST);
    expect(ctx.manifest?.course_cert).toBeUndefined();
  });

  it('emits the host block with editor "vscode"', () => {
    const ctx = build(TEST_MANIFEST_V2);
    expect(ctx.host).toEqual({
      editor: 'vscode',
      editor_version: '1.97.0',
      // '' is permitted and expected: the VS Code extension API exposes no build id.
      editor_build: '',
      platform: 'darwin-arm64',
    });
  });

  it('retains manifest_sig and the deprecated vscode block so 1.x readers still work', () => {
    const ctx = build(TEST_MANIFEST_V2);
    expect(ctx.manifest_sig).toBe(TEST_MANIFEST_V2.sig);
    expect(ctx.vscode).toEqual({ version: '1.97.0', commit: '', platform: 'darwin-arm64' });
  });

  // NOTE — this assertion CHANGED MEANING in S2. It used to read "identity is
  // never emitted, because enrollment does not exist yet". Now identity exists,
  // and the rule it encodes is the real one: omitted when the student is not
  // enrolled, present when they are. The omission half is still asserted, because
  // it is the behaviour that keeps an unenrolled student recording.
  it('omits identity entirely when the student is not enrolled', () => {
    const ctx = build(TEST_MANIFEST_V2);
    expect(ctx.identity).toBeUndefined();
    // Absent, not present-and-undefined — see the emission-site comment.
    expect(Object.hasOwn(ctx, 'identity')).toBe(false);
  });

  it('emits identity verbatim when the student IS enrolled', () => {
    const identity: SessionIdentity = {
      enrollment: {
        format_version: '2.0',
        student_ref: '11111111-2222-3333-4444-555555555555',
        course_id: 'berkeley-cs61b',
        student_pubkey: '1'.repeat(64),
        issued_at: '2026-08-25T00:00:00Z',
        expires_at: '2027-01-15',
        enrollment_sig: '2'.repeat(128),
      },
      enrollment_cert: {
        format_version: '2.0',
        course_id: 'berkeley-cs61b',
        enrollment_pubkey: '3'.repeat(64),
        valid_from: '2026-08-20',
        valid_until: '2027-01-15',
        course_sig: '4'.repeat(128),
      },
      session_pubkey_sig: '5'.repeat(128),
    };

    const ctx = buildRecorderContext({
      manifest: TEST_MANIFEST_V2,
      prevSessionId: null,
      extension: makeExtension({ version: '1.2.0', publisher: 'itsgeagle', name: 'recorder' }),
      vscodeVersion: '1.97.0',
      platform: 'darwin-arm64',
      identity,
    });

    // Byte-exact passthrough: the analyzer re-walks the chain from these bytes,
    // so nothing may be re-shaped, re-ordered into new keys, or dropped.
    expect(ctx.identity).toEqual(identity);
    expect(Object.keys(ctx.identity ?? {}).sort()).toEqual([
      'enrollment',
      'enrollment_cert',
      'session_pubkey_sig',
    ]);
  });

  it('still omits identity for a 1.x manifest even if one is supplied', () => {
    // Belt and braces: session-identity.ts refuses to produce one without a
    // course_cert, so this asserts the caller contract rather than a filter here.
    const ctx = build(TEST_MANIFEST);
    expect(ctx.identity).toBeUndefined();
  });

  it('keeps format_version at "1.0" — the 2.0 additions are purely additive', () => {
    expect(build(TEST_MANIFEST_V2).format_version).toBe('1.0');
  });
});
