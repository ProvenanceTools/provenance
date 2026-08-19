import { describe, it, expect } from 'vitest';
import {
  ROLLING_MANIFEST_FORMAT_VERSION,
  rollingManifestFilenames,
  parseRollingManifestFilename,
  validateRollingSessionManifest,
  describeRollingManifestError,
} from './rolling-manifest.js';
import { validateBundleManifestShape } from './bundle.js';
import type { BundleManifest } from './bundle.js';

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
