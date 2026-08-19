/**
 * Unit tests for the student master secret + enrollment token store.
 *
 * The seam is `SecretStore`, which is structurally `vscode.SecretStorage`.
 * CLAUDE.md: "Do not write tests that exercise VS Code APIs from unit tests.
 * Mock at the seam."
 */

import { describe, it, expect } from 'vitest';
import {
  MASTER_SECRET_KEY,
  enrollmentKeyForCourse,
  loadOrCreateMasterSecret,
  loadMasterSecret,
  importMasterSecret,
  exportMasterSecret,
  loadEnrollment,
  saveEnrollment,
  clearEnrollment,
} from './secret-store.js';
import type { SecretStore } from './secret-store.js';
import { STUDENT_MASTER_SECRET_BYTES } from '@provenance/log-core';

// ---------------------------------------------------------------------------
// Test double for vscode.SecretStorage
// ---------------------------------------------------------------------------

function makeStore(initial: Record<string, string> = {}): SecretStore & {
  readonly map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    get: (key: string) => Promise.resolve(map.get(key)),
    store: (key: string, value: string) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

const VALID_ENROLLMENT = {
  enrollment: {
    format_version: '2.0',
    student_ref: '11111111-2222-3333-4444-555555555555',
    course_id: 'berkeley-cs61b',
    student_pubkey: 'a'.repeat(64),
    issued_at: '2026-08-25T00:00:00Z',
    expires_at: '2027-01-15',
    enrollment_sig: 'b'.repeat(128),
  },
  enrollment_cert: {
    format_version: '2.0',
    course_id: 'berkeley-cs61b',
    enrollment_pubkey: 'c'.repeat(64),
    valid_from: '2026-08-20',
    valid_until: '2027-01-15',
    course_sig: 'd'.repeat(128),
  },
};

// ---------------------------------------------------------------------------
// Master secret
// ---------------------------------------------------------------------------

describe('master secret storage', () => {
  it('stores the master secret under a SecretStorage key, not globalState', () => {
    // The key name is part of the student-facing contract: it is what a student
    // is told to look for when moving machines.
    expect(MASTER_SECRET_KEY).toBe('provenance.studentMasterSecret');
  });

  it('generates a 32-byte master secret on first use and persists it', async () => {
    const store = makeStore();
    const first = await loadOrCreateMasterSecret(store);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.length).toBe(STUDENT_MASTER_SECRET_BYTES);
    // Persisted as hex under the documented key.
    expect(store.map.get(MASTER_SECRET_KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the SAME secret on a second call — never regenerates', async () => {
    const store = makeStore();
    const first = await loadOrCreateMasterSecret(store);
    const second = await loadOrCreateMasterSecret(store);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Regenerating would silently invalidate every enrollment token the student holds.
    expect(Array.from(second.value)).toEqual(Array.from(first.value));
  });

  it('generates DIFFERENT secrets for two independent students', async () => {
    const a = await loadOrCreateMasterSecret(makeStore());
    const b = await loadOrCreateMasterSecret(makeStore());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(Array.from(a.value)).not.toEqual(Array.from(b.value));
  });

  it('refuses a corrupt stored secret rather than silently regenerating', async () => {
    const store = makeStore({ [MASTER_SECRET_KEY]: 'not-hex' });
    const result = await loadOrCreateMasterSecret(store);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('corrupt_master_secret');
    // The corrupt value is left in place: overwriting it would destroy any chance
    // of recovering a secret that is merely mis-encoded.
    expect(store.map.get(MASTER_SECRET_KEY)).toBe('not-hex');
  });

  it('refuses a stored secret of the wrong length', async () => {
    const store = makeStore({ [MASTER_SECRET_KEY]: 'ab'.repeat(16) });
    const result = await loadOrCreateMasterSecret(store);
    expect(result.ok).toBe(false);
  });

  it('loadMasterSecret reports absence without creating one', async () => {
    const store = makeStore();
    const result = await loadMasterSecret(store);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('no_master_secret');
    expect(store.map.size).toBe(0);
  });

  it('export/import round-trips a secret to a new machine', async () => {
    const origin = makeStore();
    const created = await loadOrCreateMasterSecret(origin);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const exported = await exportMasterSecret(origin);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.value).toMatch(/^[0-9a-f]{64}$/);

    // A fresh machine: import the exported hex, derive the same secret.
    const fresh = makeStore();
    const imported = await importMasterSecret(fresh, exported.value);
    expect(imported.ok).toBe(true);

    const reloaded = await loadOrCreateMasterSecret(fresh);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(Array.from(reloaded.value)).toEqual(Array.from(created.value));
  });

  it('import tolerates whitespace and uppercase in a pasted secret', async () => {
    const store = makeStore();
    const result = await importMasterSecret(store, `  ${'AB'.repeat(32)}\n`);
    expect(result.ok).toBe(true);
    expect(store.map.get(MASTER_SECRET_KEY)).toBe('ab'.repeat(32));
  });

  it('import rejects a malformed secret without touching the stored one', async () => {
    const store = makeStore({ [MASTER_SECRET_KEY]: 'ee'.repeat(32) });
    const result = await importMasterSecret(store, 'nope');
    expect(result.ok).toBe(false);
    expect(store.map.get(MASTER_SECRET_KEY)).toBe('ee'.repeat(32));
  });
});

// ---------------------------------------------------------------------------
// Enrollment tokens
// ---------------------------------------------------------------------------

describe('enrollment storage', () => {
  it('keys enrollments per course', () => {
    expect(enrollmentKeyForCourse('berkeley-cs61b')).toBe('provenance.enrollment.berkeley-cs61b');
  });

  it('returns undefined for a course with no enrollment', async () => {
    const result = await loadEnrollment(makeStore(), 'berkeley-cs61b');
    expect(result).toBeUndefined();
  });

  it('round-trips a saved enrollment', async () => {
    const store = makeStore();
    const saved = await saveEnrollment(store, JSON.stringify(VALID_ENROLLMENT));
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.course_id).toBe('berkeley-cs61b');

    const loaded = await loadEnrollment(store, 'berkeley-cs61b');
    expect(loaded?.enrollment).toEqual(VALID_ENROLLMENT.enrollment);
    expect(loaded?.enrollment_cert).toEqual(VALID_ENROLLMENT.enrollment_cert);
  });

  it('keeps two courses independent', async () => {
    const store = makeStore();
    await saveEnrollment(store, JSON.stringify(VALID_ENROLLMENT));
    const other = structuredClone(VALID_ENROLLMENT);
    other.enrollment.course_id = 'berkeley-cs61c';
    other.enrollment_cert.course_id = 'berkeley-cs61c';
    await saveEnrollment(store, JSON.stringify(other));

    expect((await loadEnrollment(store, 'berkeley-cs61b'))?.enrollment.course_id).toBe(
      'berkeley-cs61b',
    );
    expect((await loadEnrollment(store, 'berkeley-cs61c'))?.enrollment.course_id).toBe(
      'berkeley-cs61c',
    );
  });

  it('rejects a pasted token that is not JSON', async () => {
    const store = makeStore();
    const result = await saveEnrollment(store, 'definitely not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_json');
    expect(store.map.size).toBe(0);
  });

  it('rejects a pasted token missing the enrollment_cert entirely', async () => {
    const store = makeStore();
    const result = await saveEnrollment(
      store,
      JSON.stringify({ enrollment: VALID_ENROLLMENT.enrollment }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The version gate runs before shape validation, mirroring verifyIdentityChain
    // step 0: an absent cert declares no version, so it is refused there first.
    expect(result.error.kind).toBe('unsupported_format_version');
    expect(store.map.size).toBe(0);
  });

  it('rejects a cert that declares 2.0 but is missing a signed field', async () => {
    const store = makeStore();
    const broken = structuredClone(VALID_ENROLLMENT) as {
      enrollment: unknown;
      enrollment_cert: Record<string, unknown>;
    };
    // `canonicalize` omits undefined-valued keys, so an artifact missing a field
    // would otherwise sign and verify cleanly while carrying nothing there.
    delete broken.enrollment_cert['valid_until'];
    const result = await saveEnrollment(store, JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_cert_shape');
    expect(store.map.size).toBe(0);
  });

  it('rejects a token that declares 2.0 but is missing a signed field', async () => {
    const store = makeStore();
    const broken = structuredClone(VALID_ENROLLMENT) as {
      enrollment: Record<string, unknown>;
      enrollment_cert: unknown;
    };
    delete broken.enrollment['student_ref'];
    const result = await saveEnrollment(store, JSON.stringify(broken));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_token_shape');
    expect(store.map.size).toBe(0);
  });

  it('rejects a pasted token whose cert names a different course', async () => {
    const mismatched = structuredClone(VALID_ENROLLMENT);
    mismatched.enrollment_cert.course_id = 'berkeley-cs61c';
    const result = await saveEnrollment(makeStore(), JSON.stringify(mismatched));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('course_id_mismatch');
  });

  it('rejects a token declaring a format_version this recorder cannot read', async () => {
    const future = structuredClone(VALID_ENROLLMENT);
    future.enrollment.format_version = '3.0';
    const result = await saveEnrollment(makeStore(), JSON.stringify(future));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('unsupported_format_version');
  });

  it('ignores a stored blob that has since become unreadable', async () => {
    const store = makeStore({ 'provenance.enrollment.berkeley-cs61b': '{{{' });
    // A corrupt stored enrollment must not throw on the session-start path —
    // it reads as "not enrolled", and recording continues.
    expect(await loadEnrollment(store, 'berkeley-cs61b')).toBeUndefined();
  });

  it('clearEnrollment removes only that course', async () => {
    const store = makeStore();
    await saveEnrollment(store, JSON.stringify(VALID_ENROLLMENT));
    await clearEnrollment(store, 'berkeley-cs61b');
    expect(await loadEnrollment(store, 'berkeley-cs61b')).toBeUndefined();
  });
});
