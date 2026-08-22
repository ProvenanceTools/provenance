import { describe, it, expect } from 'vitest';
import { parseSignArgs, resolveSignOptions, buildUnsignedManifest } from './sign-manifest.js';

describe('parseSignArgs', () => {
  it('parses a bare manifest path with no flags', () => {
    const result = parseSignArgs(['/path/to/.provenance-manifest']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      manifestPath: '/path/to/.provenance-manifest',
      format: undefined,
      courseKeypairPath: undefined,
      courseCertPath: undefined,
      rootPubkeyHex: undefined,
    });
  });

  it('parses with no positional argument at all', () => {
    const result = parseSignArgs(['--format', '1.0']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifestPath).toBeUndefined();
    expect(result.value.format).toBe('1.0');
  });

  it('parses all flags together with a positional path', () => {
    const result = parseSignArgs([
      '/m.json',
      '--format',
      '2.0',
      '--course-keypair',
      '/k.json',
      '--course-cert',
      '/c.json',
      '--root-pubkey',
      'a'.repeat(64),
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      manifestPath: '/m.json',
      format: '2.0',
      courseKeypairPath: '/k.json',
      courseCertPath: '/c.json',
      rootPubkeyHex: 'a'.repeat(64),
    });
  });

  it('rejects a flag with no following value', () => {
    const result = parseSignArgs(['--format']);
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown flag', () => {
    const result = parseSignArgs(['--bogus', 'x']);
    expect(result.ok).toBe(false);
  });

  it('rejects a second positional argument', () => {
    const result = parseSignArgs(['/a.json', '/b.json']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('extra positional');
  });
});

describe('resolveSignOptions', () => {
  const defaults = {
    manifestPath: '/default/manifest.json',
    courseKeypairPath: '/default/keypair.json',
    courseCertPath: '/default/cert.json',
  };

  it('defaults format to 2.0 and fills every path from built-in defaults', () => {
    const result = resolveSignOptions(
      {
        manifestPath: undefined,
        format: undefined,
        courseKeypairPath: undefined,
        courseCertPath: undefined,
        rootPubkeyHex: undefined,
      },
      {},
      defaults,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      manifestPath: '/default/manifest.json',
      format: '2.0',
      courseKeypairPath: '/default/keypair.json',
      courseCertPath: '/default/cert.json',
      rootPubkeyHex: null,
    });
  });

  it('CLI flags win over env vars, which win over built-in defaults', () => {
    const result = resolveSignOptions(
      {
        manifestPath: '/cli/manifest.json',
        format: undefined,
        courseKeypairPath: undefined,
        courseCertPath: undefined,
        rootPubkeyHex: undefined,
      },
      {
        PROVENANCE_COURSE_KEYPAIR_PATH: '/env/keypair.json',
        PROVENANCE_COURSE_CERT_PATH: '/env/cert.json',
        PROVENANCE_ROOT_PUBLIC_KEY_HEX: 'b'.repeat(64),
      },
      defaults,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.manifestPath).toBe('/cli/manifest.json'); // CLI positional, no env equivalent
    expect(result.value.courseKeypairPath).toBe('/env/keypair.json');
    expect(result.value.courseCertPath).toBe('/env/cert.json');
    expect(result.value.rootPubkeyHex).toBe('b'.repeat(64));
  });

  it('a CLI flag overrides the env var for the same setting', () => {
    const result = resolveSignOptions(
      {
        manifestPath: undefined,
        format: undefined,
        courseKeypairPath: '/cli/keypair.json',
        courseCertPath: undefined,
        rootPubkeyHex: undefined,
      },
      { PROVENANCE_COURSE_KEYPAIR_PATH: '/env/keypair.json' },
      defaults,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.courseKeypairPath).toBe('/cli/keypair.json');
  });

  it('rejects an invalid --format value', () => {
    const result = resolveSignOptions(
      {
        manifestPath: undefined,
        format: '3.0',
        courseKeypairPath: undefined,
        courseCertPath: undefined,
        rootPubkeyHex: undefined,
      },
      {},
      defaults,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--format');
  });

  it('accepts --format 1.0 explicitly', () => {
    const result = resolveSignOptions(
      {
        manifestPath: undefined,
        format: '1.0',
        courseKeypairPath: undefined,
        courseCertPath: undefined,
        rootPubkeyHex: undefined,
      },
      {},
      defaults,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.format).toBe('1.0');
  });
});

describe('buildUnsignedManifest', () => {
  const v1Fields = {
    assignment_id: 'hw03',
    semester: 'fa26',
    issued_at: '2026-09-15T00:00:00Z',
    files_under_review: ['hw03.py'],
  };
  const v2Extra = {
    course_id: 'berkeley-cs61b',
    collaboration: 'solo',
    submission: 'bundle',
    scope: 'directory',
    policy: { capture: { terminal: true } },
    ignore: ['*.class'],
    attachments: ['logs/'],
  };

  it('builds a 1.0 payload from the four legacy fields, ignoring extras', () => {
    const result = buildUnsignedManifest('1.0', {
      ...v1Fields,
      ...v2Extra,
      sig: 'stale',
      course_cert: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(v1Fields);
    expect('format_version' in result.value).toBe(false);
    expect('sig' in result.value).toBe(false);
    expect('course_cert' in result.value).toBe(false);
  });

  it('rejects a 1.0 input missing a required field', () => {
    const { assignment_id: _drop, ...incomplete } = v1Fields;
    const result = buildUnsignedManifest('1.0', incomplete);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('assignment_id');
  });

  it('builds a 2.0 payload including format_version and the 2.0-only fields', () => {
    const result = buildUnsignedManifest('2.0', {
      ...v1Fields,
      ...v2Extra,
      sig: 'stale',
      course_cert: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      ...v1Fields,
      format_version: '2.0',
      ...v2Extra,
    });
  });

  it('rejects a 2.0 input missing policy', () => {
    const { policy: _drop, ...withoutPolicy } = v2Extra;
    const result = buildUnsignedManifest('2.0', { ...v1Fields, ...withoutPolicy });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('policy');
  });

  it('rejects a 2.0 input missing course_id', () => {
    const { course_id: _drop, ...withoutCourseId } = v2Extra;
    const result = buildUnsignedManifest('2.0', { ...v1Fields, ...withoutCourseId });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('course_id');
  });

  it('rejects a 2.0 input missing ignore', () => {
    const { ignore: _drop, ...withoutIgnore } = v2Extra;
    const result = buildUnsignedManifest('2.0', { ...v1Fields, ...withoutIgnore });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('ignore');
  });

  it('rejects a 2.0 input missing attachments', () => {
    const { attachments: _drop, ...withoutAttachments } = v2Extra;
    const result = buildUnsignedManifest('2.0', { ...v1Fields, ...withoutAttachments });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('attachments');
  });

  it('rejects a non-object input', () => {
    const result = buildUnsignedManifest('1.0', 'not an object');
    expect(result.ok).toBe(false);
  });

  it('rejects a null input', () => {
    const result = buildUnsignedManifest('1.0', null);
    expect(result.ok).toBe(false);
  });
});
