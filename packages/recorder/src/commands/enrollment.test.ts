/**
 * Unit tests for the four enrollment commands.
 *
 * The whole point of these commands is that enrollment is a PASTE, never a
 * fetch: recorder PRD NG2 forbids the recorder making network calls during a
 * session, and there is no exception for identity. Every seam below is a
 * prompt, a clipboard, or the secret store — there is nothing to stub a fetch
 * with, deliberately.
 */

import { describe, it, expect } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveCourseKeypair, signEnrollmentCert, signEnrollmentToken } from '@provenance/log-core';
import {
  showEnrollmentKey,
  importEnrollmentToken,
  exportIdentitySecret,
  importIdentitySecret,
} from './enrollment.js';
import type { EnrollmentCommandDeps } from './enrollment.js';
import { MASTER_SECRET_KEY, loadEnrollment } from '../identity/secret-store.js';
import type { SecretStore } from '../identity/secret-store.js';

const COURSE_ID = 'berkeley-cs61b';
const MASTER_SECRET = new Uint8Array(32).fill(0x31);
const ENROLLMENT_PRIV = new Uint8Array(32).fill(0x32);
const COURSE_PRIV = new Uint8Array(32).fill(0x33);

function makeStore(initial: Record<string, string> = {}): SecretStore & {
  readonly map: Map<string, string>;
} {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    map,
    get: (key) => Promise.resolve(map.get(key)),
    store: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}

type Recorded = {
  info: string[];
  errors: string[];
  copied: string[];
  shown: string[];
};

function makeDeps(
  secrets: SecretStore,
  overrides: Partial<EnrollmentCommandDeps> = {},
): EnrollmentCommandDeps & { recorded: Recorded } {
  const recorded: Recorded = { info: [], errors: [], copied: [], shown: [] };
  return {
    recorded,
    secrets,
    activeCourseIds: () => [COURSE_ID],
    pickCourse: (items) => Promise.resolve(items[0]),
    promptInput: () => Promise.resolve(undefined),
    showInfo: (m) => recorded.info.push(m),
    showError: (m) => recorded.errors.push(m),
    copyToClipboard: (t) => {
      recorded.copied.push(t);
      return Promise.resolve();
    },
    showDocument: (t) => {
      recorded.shown.push(t);
      return Promise.resolve();
    },
    ...overrides,
  };
}

/** A well-formed pasted enrollment blob for the key derived from MASTER_SECRET. */
async function mintBlob(courseId = COURSE_ID): Promise<string> {
  const derived = await deriveCourseKeypair(MASTER_SECRET, courseId);
  const certBase = {
    format_version: '2.0',
    course_id: courseId,
    enrollment_pubkey: bytesToHex(await ed.getPublicKeyAsync(ENROLLMENT_PRIV)),
    valid_from: '2026-08-20',
    valid_until: '2027-01-15',
  };
  const tokenBase = {
    format_version: '2.0',
    student_ref: '11111111-2222-3333-4444-555555555555',
    course_id: courseId,
    student_pubkey: derived.publicKeyHex,
    issued_at: '2026-08-25T00:00:00Z',
    expires_at: '2027-01-15',
  };
  return JSON.stringify({
    enrollment: {
      ...tokenBase,
      enrollment_sig: await signEnrollmentToken(tokenBase, ENROLLMENT_PRIV),
    },
    enrollment_cert: { ...certBase, course_sig: await signEnrollmentCert(certBase, COURSE_PRIV) },
  });
}

// ---------------------------------------------------------------------------
// showEnrollmentKey
// ---------------------------------------------------------------------------

describe('showEnrollmentKey', () => {
  it('shows the per-course PUBLIC key, creating a master secret on first use', async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    await showEnrollmentKey(deps);

    const expected = await deriveCourseKeypair(
      // Whatever secret got generated — re-read it to derive the expectation.
      Uint8Array.from(
        (store.map.get(MASTER_SECRET_KEY) as string).match(/../g)!.map((h) => parseInt(h, 16)),
      ),
      COURSE_ID,
    );
    expect(deps.recorded.copied[0]).toBe(expected.publicKeyHex);
    expect(expected.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never reveals the master secret or a private key', async () => {
    const store = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(MASTER_SECRET) });
    const deps = makeDeps(store);
    await showEnrollmentKey(deps);

    const everythingSurfaced = [
      ...deps.recorded.copied,
      ...deps.recorded.info,
      ...deps.recorded.shown,
    ].join('\n');
    // The master secret must never leave the machine (program spec §5a).
    expect(everythingSurfaced).not.toContain(bytesToHex(MASTER_SECRET));
  });

  it('derives a DIFFERENT public key per course — identities are unlinkable', async () => {
    const store = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(MASTER_SECRET) });

    const b = makeDeps(store, { activeCourseIds: () => ['berkeley-cs61b'] });
    await showEnrollmentKey(b);
    const c = makeDeps(store, { activeCourseIds: () => ['berkeley-cs61c'] });
    await showEnrollmentKey(c);

    expect(b.recorded.copied[0]).not.toBe(c.recorded.copied[0]);
  });

  it('reports rather than throws when no course is active', async () => {
    const deps = makeDeps(makeStore(), { activeCourseIds: () => [] });
    await showEnrollmentKey(deps);
    expect(deps.recorded.errors.length).toBe(1);
    expect(deps.recorded.copied.length).toBe(0);
  });

  it('does nothing when the student dismisses the course picker', async () => {
    const deps = makeDeps(makeStore(), {
      activeCourseIds: () => ['a', 'b'],
      pickCourse: () => Promise.resolve(undefined),
    });
    await showEnrollmentKey(deps);
    expect(deps.recorded.copied.length).toBe(0);
    expect(deps.recorded.errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// importEnrollmentToken
// ---------------------------------------------------------------------------

describe('importEnrollmentToken', () => {
  it('persists a pasted token under the course it names', async () => {
    const store = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(MASTER_SECRET) });
    const blob = await mintBlob();
    const deps = makeDeps(store, { promptInput: () => Promise.resolve(blob) });

    await importEnrollmentToken(deps);

    const loaded = await loadEnrollment(store, COURSE_ID);
    expect(loaded?.enrollment.course_id).toBe(COURSE_ID);
    expect(deps.recorded.errors.length).toBe(0);
    expect(deps.recorded.info.join(' ')).toContain(COURSE_ID);
  });

  it('reports a malformed paste and stores nothing', async () => {
    const store = makeStore();
    const deps = makeDeps(store, { promptInput: () => Promise.resolve('not json at all') });
    await importEnrollmentToken(deps);

    expect(deps.recorded.errors.length).toBe(1);
    expect(store.map.size).toBe(0);
  });

  it('does nothing when the student cancels the prompt', async () => {
    const store = makeStore();
    const deps = makeDeps(store, { promptInput: () => Promise.resolve(undefined) });
    await importEnrollmentToken(deps);
    expect(store.map.size).toBe(0);
    expect(deps.recorded.errors.length).toBe(0);
  });

  it('warns when the pasted token names a key this machine cannot derive', async () => {
    // The token is genuine but was minted for a different master secret — the
    // student imported the token but not their identity secret.
    const store = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(new Uint8Array(32).fill(0x77)) });
    const blob = await mintBlob();
    const deps = makeDeps(store, { promptInput: () => Promise.resolve(blob) });
    await importEnrollmentToken(deps);

    // Still stored — the token is valid, the local key is the problem, and telling
    // the student to import their secret is more useful than silently refusing.
    expect(await loadEnrollment(store, COURSE_ID)).toBeDefined();
    expect(deps.recorded.errors.join(' ').toLowerCase()).toContain('identity secret');
  });
});

// ---------------------------------------------------------------------------
// Master secret export / import — the new-machine story
// ---------------------------------------------------------------------------

describe('identity secret export/import', () => {
  it('export surfaces the secret only after creating one if needed', async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    await exportIdentitySecret(deps);
    expect(deps.recorded.copied[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(deps.recorded.copied[0]).toBe(store.map.get(MASTER_SECRET_KEY));
  });

  it('import adopts a pasted secret so per-course keys re-derive identically', async () => {
    const oldMachine = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(MASTER_SECRET) });
    const exportDeps = makeDeps(oldMachine);
    await exportIdentitySecret(exportDeps);
    const exported = exportDeps.recorded.copied[0] as string;

    const newMachine = makeStore();
    const importDeps = makeDeps(newMachine, { promptInput: () => Promise.resolve(exported) });
    await importIdentitySecret(importDeps);

    expect(importDeps.recorded.errors.length).toBe(0);
    // The whole point: the same course now derives the same public key.
    const before = await deriveCourseKeypair(MASTER_SECRET, COURSE_ID);
    const showDeps = makeDeps(newMachine);
    await showEnrollmentKey(showDeps);
    expect(showDeps.recorded.copied[0]).toBe(before.publicKeyHex);
  });

  it('import rejects a malformed paste without clobbering an existing secret', async () => {
    const store = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(MASTER_SECRET) });
    const deps = makeDeps(store, { promptInput: () => Promise.resolve('oops') });
    await importIdentitySecret(deps);

    expect(deps.recorded.errors.length).toBe(1);
    expect(store.map.get(MASTER_SECRET_KEY)).toBe(bytesToHex(MASTER_SECRET));
  });

  it('import does nothing when cancelled', async () => {
    const store = makeStore();
    const deps = makeDeps(store, { promptInput: () => Promise.resolve(undefined) });
    await importIdentitySecret(deps);
    expect(store.map.size).toBe(0);
    expect(deps.recorded.errors.length).toBe(0);
  });
});
