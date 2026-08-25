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
import {
  deriveCourseKeypair,
  deriveStudentKeypair,
  signEnrollmentCert,
  signEnrollmentToken,
} from '@provenance/log-core';
import {
  showEnrollmentKey,
  importEnrollmentToken,
  exportIdentitySecret,
  importIdentitySecret,
} from './enrollment.js';
import type { EnrollmentCommandDeps } from './enrollment.js';
import {
  MASTER_SECRET_KEY,
  MASTER_SECRET_EXPORT_PREFIX,
  loadEnrollment,
} from '../identity/secret-store.js';
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
  it('shows the global PUBLIC key, creating a master secret on first use', async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    await showEnrollmentKey(deps);

    const expected = await deriveStudentKeypair(
      // Whatever secret got generated — re-read it to derive the expectation.
      Uint8Array.from(
        (store.map.get(MASTER_SECRET_KEY) as string).match(/../g)!.map((h) => parseInt(h, 16)),
      ),
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

  // REPLACES 'derives a DIFFERENT public key per course — identities are
  // unlinkable'. That assertion pinned the 2.0 per-course derivation, and 2.1
  // deliberately reverses it: `STUDENT_KEY_HKDF_INFO` has no course component,
  // so a student has ONE key forever across every course. Cross-course
  // unlinkability was traded away knowingly (log-core/institution.ts) — a
  // per-course key needs a per-course credential, which needs a roster match,
  // which only exists after the student's first submission. The old assertion
  // is not weakened here, it is inverted, because the contract inverted.
  it('derives the SAME public key every time — one global key per student', async () => {
    const store = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(MASTER_SECRET) });

    const first = makeDeps(store);
    await showEnrollmentKey(first);
    const second = makeDeps(store);
    await showEnrollmentKey(second);

    expect(first.recorded.copied[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(first.recorded.copied[0]).toBe(second.recorded.copied[0]);
  });

  // REPLACES 'reports rather than throws when no course is active'. Requiring an
  // active course was one half of the 2.0 deadlock: a student could not see
  // their key until a course was already recording, but their first session
  // needs an identity before any work happens. A 2.1 key needs only the master
  // secret, so this must now SUCCEED where it previously errored.
  it('works with no course active at all — the 2.0 deadlock is gone', async () => {
    const deps = makeDeps(makeStore());
    await showEnrollmentKey(deps);

    expect(deps.recorded.errors).toEqual([]);
    expect(deps.recorded.copied[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  // 'does nothing when the student dismisses the course picker' is DELETED
  // rather than updated: there is no course picker any more, so the behaviour it
  // described no longer exists to assert anything about.

  it('warns in the shown document that this is not the identity secret', async () => {
    const deps = makeDeps(makeStore());
    await showEnrollmentKey(deps);

    // The master-secret/public-key confusion is 64-hex-vs-64-hex and cannot be
    // detected mechanically at this end; naming it here is half the defence,
    // the other half being the marker the analyzer refuses.
    expect(deps.recorded.shown.join('\n')).toContain('NOT your identity secret');
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
// Master secret export / import — a BACKUP, not the second-machine story
// ---------------------------------------------------------------------------

describe('identity secret export/import', () => {
  it('presents the export as a backup and not as the way to add a machine', async () => {
    // Enrolling the second machine is the supported path: it generates its own
    // secret, gets its own credential over the same student_ref, and both
    // machines resolve to one contributor. Telling a student to hand-carry the
    // one value that can sign as them, for a flow that does not need it, is a
    // real harm dressed up as a tip.
    const store = makeStore();
    const deps = makeDeps(store);
    await exportIdentitySecret(deps);

    const doc = deps.recorded.shown.join('\n');
    expect(doc).toMatch(/this is a BACKUP/i);
    expect(doc).toMatch(/Restore Student Identity Secret/);
    expect(doc).toMatch(/do NOT need it to work on a second machine/i);
    expect(doc).toMatch(/enrol that machine on the enrollment page/i);
    // The instruction that used to be here.
    expect(doc).not.toMatch(/On a new machine: run/i);

    // The warnings that must survive the repositioning: the analyzer's paste
    // guard keys off this exact prose (SECRET_DOCUMENT_TELLS).
    expect(doc).toMatch(/KEEP THIS PRIVATE/);
    expect(doc.toLowerCase()).toContain('identity secret');
    expect(deps.recorded.info.join(' ')).toMatch(/backup/i);
  });

  // UPDATED: the exported value is now MARKED rather than bare 64-hex. The old
  // assertion (`/^[0-9a-f]{64}$/`) pinned the exact shape that makes a master
  // secret indistinguishable from a public key in the enrollment page's key
  // field. The marker is the mechanical half of that defence, so the assertion
  // now pins the marker AND that the raw secret is still recoverable from it.
  it('export surfaces the secret behind a marker that names it as a secret', async () => {
    const store = makeStore();
    const deps = makeDeps(store);
    await exportIdentitySecret(deps);

    const copied = deps.recorded.copied[0] as string;
    expect(copied).toBe(`${MASTER_SECRET_EXPORT_PREFIX}${store.map.get(MASTER_SECRET_KEY)}`);
    // Deliberately NOT a bare 64-hex run: that is precisely the shape the
    // enrollment page cannot distinguish from an enrollment key.
    expect(copied).not.toMatch(/^[0-9a-f]{64}$/);
  });

  it('import still accepts a BARE secret exported by an older build', async () => {
    const store = makeStore();
    const deps = makeDeps(store, {
      promptInput: () => Promise.resolve(bytesToHex(MASTER_SECRET)),
    });
    await importIdentitySecret(deps);

    expect(deps.recorded.errors).toEqual([]);
    expect(store.map.get(MASTER_SECRET_KEY)).toBe(bytesToHex(MASTER_SECRET));
  });

  it('import adopts a pasted secret so keys re-derive identically', async () => {
    const oldMachine = makeStore({ [MASTER_SECRET_KEY]: bytesToHex(MASTER_SECRET) });
    const exportDeps = makeDeps(oldMachine);
    await exportIdentitySecret(exportDeps);
    const exported = exportDeps.recorded.copied[0] as string;

    const newMachine = makeStore();
    const importDeps = makeDeps(newMachine, { promptInput: () => Promise.resolve(exported) });
    await importIdentitySecret(importDeps);

    expect(importDeps.recorded.errors.length).toBe(0);
    // The whole point: the new machine now derives the same public key, so an
    // existing credential keeps working.
    const before = await deriveStudentKeypair(MASTER_SECRET);
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
