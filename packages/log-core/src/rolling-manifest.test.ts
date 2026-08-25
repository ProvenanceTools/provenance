import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  ROLLING_MANIFEST_FORMAT_VERSION,
  rollingManifestFilenames,
  parseRollingManifestFilename,
  validateRollingSessionManifest,
  describeRollingManifestError,
  isFinalRollingSeal,
} from './rolling-manifest.js';
import { validateBundleManifestShape } from './bundle.js';
import type { BundleManifest } from './bundle.js';
import { signBundleManifest } from './bundle-sign.js';
import { canonicalize } from './canonical.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';

function rolling(overrides: Partial<BundleManifest> = {}): BundleManifest {
  return {
    format_version: '1.2',
    assignment_id: 'proj2',
    semester: 'fa26',
    extension_hash: 'a'.repeat(64),
    sessions: [
      {
        session_id: SESSION_A,
        prev_session_id: null,
        slog_sha256: 'b'.repeat(64),
        meta_sha256: 'c'.repeat(64),
      },
    ],
    submission_files: [{ path: 'Gitlet.java', status: 'present', sha256: 'd'.repeat(64) }],
    ...overrides,
  };
}

describe('rolling manifest filenames', () => {
  it('names both files after the session id', () => {
    expect(rollingManifestFilenames(SESSION_A)).toEqual({
      json: `manifest-${SESSION_A}.json`,
      sig: `manifest-${SESSION_A}.sig`,
    });
  });

  it('round-trips through parseRollingManifestFilename', () => {
    const { json, sig } = rollingManifestFilenames(SESSION_A);
    expect(parseRollingManifestFilename(json)).toEqual({ sessionId: SESSION_A, part: 'json' });
    expect(parseRollingManifestFilename(sig)).toEqual({ sessionId: SESSION_A, part: 'sig' });
  });

  it('never claims the CLASSIC seal files — that path must stay untouched', () => {
    expect(parseRollingManifestFilename('manifest.json')).toBeNull();
    expect(parseRollingManifestFilename('manifest.sig')).toBeNull();
  });

  it('rejects near-misses rather than inventing a session id', () => {
    expect(parseRollingManifestFilename('manifest-.json')).toBeNull();
    expect(parseRollingManifestFilename('manifest-zzz.json')).toBeNull();
    expect(parseRollingManifestFilename(`manifest-${SESSION_A}.json.tmp`)).toBeNull();
    expect(parseRollingManifestFilename(`session-${SESSION_A}.slog`)).toBeNull();
    expect(parseRollingManifestFilename('README.md')).toBeNull();
  });
});

describe('validateBundleManifestShape accepts 1.2', () => {
  it('accepts a one-session rolling manifest', () => {
    const r = validateBundleManifestShape(rolling());
    expect(r.ok).toBe(true);
  });

  it('requires submission_files on 1.2, as on 1.1', () => {
    const withoutFiles: Record<string, unknown> = { ...rolling() };
    delete withoutFiles['submission_files'];
    const r = validateBundleManifestShape(withoutFiles);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'missing_field', field: 'submission_files' });
  });

  it('rejects a null session_id on 1.2 — a rolling seal always knows its session', () => {
    const r = validateBundleManifestShape(
      rolling({
        sessions: [
          {
            session_id: null,
            prev_session_id: null,
            slog_sha256: 'b'.repeat(64),
            meta_sha256: 'c'.repeat(64),
          },
        ],
      }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_field');
  });

  it('rejects an empty sessions array on 1.2', () => {
    const r = validateBundleManifestShape(rolling({ sessions: [] }));
    expect(r.ok).toBe(false);
  });

  it('accepts MANY sessions at 1.2 — that is the analyzer-synthesized union', () => {
    const r = validateBundleManifestShape(
      rolling({
        sessions: [
          {
            session_id: SESSION_A,
            prev_session_id: null,
            slog_sha256: 'b'.repeat(64),
            meta_sha256: 'c'.repeat(64),
          },
          {
            session_id: SESSION_B,
            prev_session_id: SESSION_A,
            slog_sha256: 'e'.repeat(64),
            meta_sha256: 'f'.repeat(64),
          },
        ],
      }),
    );
    expect(r.ok).toBe(true);
  });

  it('still accepts 1.0 and 1.1 unchanged', () => {
    const legacy = {
      format_version: '1.0',
      assignment_id: 'hw1',
      semester: 'fa26',
      extension_hash: 'a'.repeat(64),
      sessions: [
        {
          session_id: null,
          prev_session_id: null,
          slog_sha256: 'b'.repeat(64),
          meta_sha256: 'c'.repeat(64),
        },
      ],
    };
    expect(validateBundleManifestShape(legacy).ok).toBe(true);
    expect(validateBundleManifestShape(rolling({ format_version: '1.1' })).ok).toBe(true);
  });
});

describe('validateRollingSessionManifest — the one-file rule', () => {
  it('accepts a well-formed rolling manifest and narrows sessions to a 1-tuple', () => {
    const r = validateRollingSessionManifest(rolling(), SESSION_A);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.sessions[0].session_id).toBe(SESSION_A);
  });

  it('accepts without an expected id when the caller has no filename', () => {
    expect(validateRollingSessionManifest(rolling()).ok).toBe(true);
  });

  it('refuses a 1.1 manifest', () => {
    const r = validateRollingSessionManifest(rolling({ format_version: '1.1' }), SESSION_A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'not_rolling', format_version: '1.1' });
  });

  it('refuses a multi-session manifest in a per-session FILE', () => {
    const r = validateRollingSessionManifest(
      rolling({
        sessions: [
          {
            session_id: SESSION_A,
            prev_session_id: null,
            slog_sha256: 'b'.repeat(64),
            meta_sha256: 'c'.repeat(64),
          },
          {
            session_id: SESSION_B,
            prev_session_id: SESSION_A,
            slog_sha256: 'e'.repeat(64),
            meta_sha256: 'f'.repeat(64),
          },
        ],
      }),
      SESSION_A,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual({ kind: 'wrong_session_count', count: 2 });
  });

  it('refuses a manifest copied under another session’s filename', () => {
    const r = validateRollingSessionManifest(rolling(), SESSION_B);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error).toEqual({
        kind: 'session_id_mismatch',
        expected: SESSION_B,
        actual: SESSION_A,
      });
  });

  it('describes every error kind', () => {
    expect(describeRollingManifestError({ kind: 'not_rolling', format_version: '1.1' })).toContain(
      ROLLING_MANIFEST_FORMAT_VERSION,
    );
    expect(describeRollingManifestError({ kind: 'wrong_session_count', count: 3 })).toContain('3');
    expect(describeRollingManifestError({ kind: 'null_session_id' })).toContain('null');
    expect(
      describeRollingManifestError({
        kind: 'session_id_mismatch',
        expected: SESSION_A,
        actual: SESSION_B,
      }),
    ).toContain(SESSION_B);
  });
});

// ---------------------------------------------------------------------------
// The `final` marker — whole-file vs. prefix semantics
// ---------------------------------------------------------------------------

describe('isFinalRollingSeal', () => {
  it('is true only for a literal `true`', () => {
    expect(isFinalRollingSeal(rolling({ final: true }))).toBe(true);
  });

  it('reads an absent marker as NOT final', () => {
    // The overwhelmingly common case: every roll but the last one. Reading
    // absence as final would promote a still-growing log to whole-file
    // semantics and turn the student's next keystroke into a finding.
    expect(isFinalRollingSeal(rolling())).toBe(false);
    expect(isFinalRollingSeal(rolling({ final: false }))).toBe(false);
  });

  it('falls back to the SAFER prefix reading for any non-boolean value', () => {
    // A truthy string must not buy whole-file strictness. The shape validator
    // rejects these outright, but the predicate is the last line of defence and
    // must not depend on having been called after it.
    for (const junk of ['true', 1, {}, []]) {
      expect(isFinalRollingSeal({ final: junk } as unknown as BundleManifest)).toBe(false);
    }
  });
});

describe('validateBundleManifestShape — the `final` marker', () => {
  it('accepts a rolling manifest with no `final` at all', () => {
    expect(validateBundleManifestShape(rolling()).ok).toBe(true);
  });

  it('accepts `final: true` and `final: false`', () => {
    expect(validateBundleManifestShape(rolling({ final: true })).ok).toBe(true);
    expect(validateBundleManifestShape(rolling({ final: false })).ok).toBe(true);
  });

  it('preserves `final` through validation, so canonicalization still covers it', () => {
    // The validator returns the ORIGINAL object. If it ever started rebuilding
    // one field at a time, `final` would be dropped silently and every reader
    // would fall back to prefix semantics without anything failing.
    const r = validateBundleManifestShape(rolling({ final: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.final).toBe(true);
    expect(isFinalRollingSeal(r.value)).toBe(true);
  });

  it('rejects a non-boolean `final`', () => {
    const r = validateBundleManifestShape(rolling({ final: 'true' as unknown as boolean }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({
        kind: 'invalid_field',
        field: 'final',
        reason: expect.any(String),
      });
    }
  });

  it('tolerates `final` on a classic 1.1 manifest rather than failing check 1', () => {
    // Meaningless there — a classic seal is already whole-file — but a shape
    // error would fail the manifest signature check, which is an accusation,
    // over a field that grants nothing.
    expect(validateBundleManifestShape(rolling({ format_version: '1.1', final: true })).ok).toBe(
      true,
    );
  });
});

describe('`final` is inside the SIGNED payload', () => {
  const privkey = new Uint8Array(32).fill(7);

  it('changes the canonical bytes, so one signature cannot cover both readings', async () => {
    const nonFinal = await signBundleManifest(rolling(), privkey);
    const isFinal = await signBundleManifest(rolling({ final: true }), privkey);

    expect(isFinal.canonicalJson).not.toBe(nonFinal.canonicalJson);
    expect(isFinal.canonicalJson).toContain('"final":true');
    expect(isFinal.signatureHex).not.toBe(nonFinal.signatureHex);
  });

  it('omits the key entirely when not final, so 1.2 bytes are unchanged by this feature', async () => {
    // Two other recorder implementations verify against these canonical bytes.
    // Writing `final: false` instead of omitting it would be a silent breaking
    // change to both.
    const { canonicalJson } = await signBundleManifest(rolling(), privkey);
    expect(canonicalJson).not.toContain('final');
  });

  it('STRIPPING `final` from a signed manifest breaks the signature', async () => {
    const signed = await signBundleManifest(rolling({ final: true }), privkey);
    const pubkey = await ed.getPublicKeyAsync(privkey);
    const message = (s: string): Uint8Array => new TextEncoder().encode(s);

    // The seal as written verifies.
    expect(
      await ed.verifyAsync(hexToBytes(signed.signatureHex), message(signed.canonicalJson), pubkey),
    ).toBe(true);

    // Downgrade it to a prefix commitment by deleting the marker while keeping
    // the signature. This is the attack the field exists to survive.
    const stripped = canonicalize(rolling());
    expect(stripped).not.toBe(signed.canonicalJson);
    expect(await ed.verifyAsync(hexToBytes(signed.signatureHex), message(stripped), pubkey)).toBe(
      false,
    );
  });

  it('ADDING `final` to a non-final signed manifest breaks the signature', async () => {
    const signed = await signBundleManifest(rolling(), privkey);
    const pubkey = await ed.getPublicKeyAsync(privkey);
    const forged = canonicalize(rolling({ final: true }));

    expect(
      await ed.verifyAsync(
        hexToBytes(signed.signatureHex),
        new TextEncoder().encode(forged),
        pubkey,
      ),
    ).toBe(false);
  });
});
