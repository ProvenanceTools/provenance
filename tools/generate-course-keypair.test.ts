import { describe, it, expect } from 'vitest';
import { parseGenerateArgs, deriveCertOutPath } from './generate-course-keypair.js';

describe('deriveCertOutPath', () => {
  it('replaces a .json suffix with .cert.json', () => {
    expect(deriveCertOutPath('/secure/cs61a-fa26.json')).toBe('/secure/cs61a-fa26.cert.json');
  });

  it('appends .cert.json when there is no .json suffix', () => {
    expect(deriveCertOutPath('/secure/cs61a-fa26')).toBe('/secure/cs61a-fa26.cert.json');
  });
});

describe('parseGenerateArgs', () => {
  it('parses a bare output path with no minting (original behavior)', () => {
    const result = parseGenerateArgs(['/secure/cs61a-fa26.json'], '/default/root.json');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ outPath: '/secure/cs61a-fa26.json', mint: null });
  });

  it('rejects a missing output path', () => {
    const result = parseGenerateArgs([]);
    expect(result.ok).toBe(false);
  });

  it('mints when --course-id, --valid-from, and --valid-until are all given', () => {
    const result = parseGenerateArgs(
      [
        '/secure/cs61a-fa26.json',
        '--course-id',
        'berkeley-cs61a',
        '--valid-from',
        '2026-08-20',
        '--valid-until',
        '2027-01-15',
      ],
      '/default/root.json',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      outPath: '/secure/cs61a-fa26.json',
      mint: {
        courseId: 'berkeley-cs61a',
        validFrom: '2026-08-20',
        validUntil: '2027-01-15',
        rootKeypairPath: '/default/root.json',
        certOutPath: '/secure/cs61a-fa26.cert.json',
      },
    });
  });

  it('honours --root-keypair and --cert-out overrides', () => {
    const result = parseGenerateArgs([
      '/secure/cs61a-fa26.json',
      '--course-id',
      'berkeley-cs61a',
      '--valid-from',
      '2026-08-20',
      '--valid-until',
      '2027-01-15',
      '--root-keypair',
      '/secure/root.json',
      '--cert-out',
      '/secure/cert.json',
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mint?.rootKeypairPath).toBe('/secure/root.json');
    expect(result.value.mint?.certOutPath).toBe('/secure/cert.json');
  });

  it('rejects --course-id without --valid-from', () => {
    const result = parseGenerateArgs([
      '/secure/cs61a-fa26.json',
      '--course-id',
      'berkeley-cs61a',
      '--valid-until',
      '2027-01-15',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--valid-from');
  });

  it('rejects --course-id without --valid-until', () => {
    const result = parseGenerateArgs([
      '/secure/cs61a-fa26.json',
      '--course-id',
      'berkeley-cs61a',
      '--valid-from',
      '2026-08-20',
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--valid-until');
  });

  it('rejects a minting flag used without --course-id', () => {
    const result = parseGenerateArgs(['/secure/cs61a-fa26.json', '--valid-from', '2026-08-20']);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('--course-id');
  });

  it('rejects an unknown flag', () => {
    const result = parseGenerateArgs(['/secure/cs61a-fa26.json', '--bogus']);
    expect(result.ok).toBe(false);
  });

  it('rejects a flag with no following value', () => {
    const result = parseGenerateArgs(['/secure/cs61a-fa26.json', '--course-id']);
    expect(result.ok).toBe(false);
  });
});
