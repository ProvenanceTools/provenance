import { describe, it, expect } from 'vitest';
import { validateBundleManifestShape } from './bundle.js';

// ---------------------------------------------------------------------------
// Helper: build a valid 1.1 BundleManifest-shaped object
// ---------------------------------------------------------------------------

const HEX64 = 'a'.repeat(64);

function valid11Manifest() {
  return {
    format_version: '1.1',
    assignment_id: 'hw03',
    semester: 'fa25',
    extension_hash: HEX64,
    sessions: [{ session_id: 's1', prev_session_id: null, slog_sha256: HEX64, meta_sha256: HEX64 }],
    submission_files: [
      { path: 'hw03.py', status: 'present', sha256: HEX64 },
      { path: 'optional.py', status: 'missing', sha256: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helper: build a valid BundleManifest-shaped object
// ---------------------------------------------------------------------------

function validManifest(): Record<string, unknown> {
  return {
    format_version: '1.0',
    assignment_id: 'hw03',
    semester: 'fa26',
    extension_hash: 'a'.repeat(64),
    sessions: [
      {
        session_id: 'session-uuid-1',
        prev_session_id: null,
        slog_sha256: 'b'.repeat(64),
        meta_sha256: 'c'.repeat(64),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateBundleManifestShape', () => {
  it('accepts a valid manifest with one session', () => {
    expect(validateBundleManifestShape(validManifest()).ok).toBe(true);
  });

  it('accepts a valid manifest with no sessions (empty array)', () => {
    const manifest = { ...validManifest(), sessions: [] };
    expect(validateBundleManifestShape(manifest).ok).toBe(true);
  });

  it('accepts a manifest with multiple sessions', () => {
    const manifest = {
      ...validManifest(),
      sessions: [
        {
          session_id: 'session-1',
          prev_session_id: null,
          slog_sha256: 'a'.repeat(64),
          meta_sha256: 'b'.repeat(64),
        },
        {
          session_id: 'session-2',
          prev_session_id: 'session-1',
          slog_sha256: 'c'.repeat(64),
          meta_sha256: 'd'.repeat(64),
        },
      ],
    };
    expect(validateBundleManifestShape(manifest).ok).toBe(true);
  });

  it('rejects non-objects', () => {
    for (const bad of [null, 'string', 42, [], true]) {
      const result = validateBundleManifestShape(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('not_object');
      }
    }
  });

  it('rejects wrong format_version', () => {
    const manifest = { ...validManifest(), format_version: '2.0' };
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('wrong_version');
    }
  });

  it('rejects missing assignment_id', () => {
    const manifest = validManifest();
    delete manifest['assignment_id'];
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('missing_field');
      if (result.error.kind === 'missing_field') {
        expect(result.error.field).toBe('assignment_id');
      }
    }
  });

  it('rejects missing semester', () => {
    const manifest = validManifest();
    delete manifest['semester'];
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('missing_field');
      if (result.error.kind === 'missing_field') {
        expect(result.error.field).toBe('semester');
      }
    }
  });

  it('rejects missing extension_hash', () => {
    const manifest = validManifest();
    delete manifest['extension_hash'];
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['missing_field', 'invalid_field']).toContain(result.error.kind);
    }
  });

  it('rejects extension_hash with wrong length', () => {
    const manifest = { ...validManifest(), extension_hash: 'a'.repeat(63) };
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_field');
      if (result.error.kind === 'invalid_field') {
        expect(result.error.field).toBe('extension_hash');
      }
    }
  });

  it('rejects missing sessions field', () => {
    const manifest = validManifest();
    delete manifest['sessions'];
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['missing_field', 'invalid_field']).toContain(result.error.kind);
    }
  });

  it('rejects session with missing session_id', () => {
    const manifest = validManifest();
    const session = (manifest['sessions'] as Record<string, unknown>[])[0]!;
    delete session['session_id'];
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['missing_field', 'invalid_field']).toContain(result.error.kind);
    }
  });

  it('rejects session with missing prev_session_id (not even null)', () => {
    const manifest = validManifest();
    const session = (manifest['sessions'] as Record<string, unknown>[])[0]!;
    delete session['prev_session_id'];
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
  });

  it('rejects session with bad slog_sha256', () => {
    const manifest = validManifest();
    (manifest['sessions'] as Record<string, unknown>[])[0]!['slog_sha256'] = 'tooshort';
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_field');
    }
  });

  it('rejects session with bad meta_sha256', () => {
    const manifest = validManifest();
    (manifest['sessions'] as Record<string, unknown>[])[0]!['meta_sha256'] = 'tooshort';
    const result = validateBundleManifestShape(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_field');
    }
  });

  it('accepts session with non-null prev_session_id string', () => {
    const manifest = {
      ...validManifest(),
      sessions: [
        {
          session_id: 'session-2',
          prev_session_id: 'session-1',
          slog_sha256: 'a'.repeat(64),
          meta_sha256: 'b'.repeat(64),
        },
      ],
    };
    expect(validateBundleManifestShape(manifest).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1.1 manifest tests
// ---------------------------------------------------------------------------

describe('validateBundleManifestShape — 1.1', () => {
  it('accepts a valid 1.1 manifest with submission_files', () => {
    const r = validateBundleManifestShape(valid11Manifest());
    expect(r.ok).toBe(true);
  });

  it('rejects a present file whose sha256 is null', () => {
    const m = valid11Manifest();
    m.submission_files[0]!.sha256 = null;
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
  });

  it('rejects a missing file whose sha256 is non-null', () => {
    const m = valid11Manifest();
    m.submission_files[1]!.sha256 = HEX64;
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown submission_files status', () => {
    const m = valid11Manifest();
    (m.submission_files[0] as { status: string }).status = 'deleted';
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
  });

  it('rejects a 1.1 manifest missing submission_files', () => {
    const m = valid11Manifest() as Record<string, unknown>;
    delete m['submission_files'];
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
  });

  it('accepts a session entry with a null session_id (corrupt-session bundle)', () => {
    const m = valid11Manifest();
    (m.sessions[0] as { session_id: string | null }).session_id = null;
    expect(validateBundleManifestShape(m).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// submission_files role and scope_capped
// ---------------------------------------------------------------------------

describe('submission_files role and scope_capped', () => {
  it('accepts a manifest with no role, meaning every file is reviewed', () => {
    const m = valid11Manifest();
    expect(validateBundleManifestShape(m).ok).toBe(true);
  });

  it('accepts both role values', () => {
    for (const role of ['reviewed', 'attachment'] as const) {
      const m = valid11Manifest();
      (m.submission_files[0] as { role?: string }).role = role;
      expect(validateBundleManifestShape(m).ok).toBe(true);
    }
  });

  it('rejects a role outside the pair', () => {
    const m = valid11Manifest();
    (m.submission_files[0] as { role?: string }).role = 'whatever';
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ kind: 'invalid_field' });
  });

  it('rejects a non-boolean scope_capped but accepts its absence', () => {
    const m = valid11Manifest();
    expect(validateBundleManifestShape({ ...m, scope_capped: true }).ok).toBe(true);
    expect(validateBundleManifestShape({ ...m, scope_capped: 'yes' }).ok).toBe(false);
  });
});
