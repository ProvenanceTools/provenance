/**
 * END-TO-END GATE for the identity 2.1 enrollment hop.
 *
 * The `/enroll` page promises a student "the recorder will accept this text".
 * Nothing could check that promise: the analyzer may not import recorder source
 * and the recorder may not import analyzer source (CLAUDE.md architecture
 * rules), so each end could only be tested against a hand-written description
 * of the other. A transcription that drifts is exactly as broken as no test at
 * all, and it fails silently.
 *
 * This file closes that. It is a COMPOSITION test spanning both graphs:
 *
 *   log-core   signInstitutionCert / signStudentCredential   (a real server's
 *              deriveStudentKeypair                           signatures + key)
 *   analyzer   buildRecorderPasteText                        (the paste artifact)
 *   analyzer   checkRecorderPasteText                        (the page's promise)
 *   recorder   saveIdentityArtifact       ← from dist/       (the real importer)
 *   recorder   buildSessionIdentity       ← from dist/       (the real emitter)
 *   log-core   verifyInstitutionCert / verifyIdentityChain   (the real walk)
 *
 * Nothing here re-implements either end's decision. If you find yourself
 * transcribing the recorder's checks into this file, you have rebuilt
 * `enrollment-token.test.ts` and lost the point of the gate.
 *
 * ## Why this file lives in tools/ and not in either package
 *
 * The precedent is `tools/recorder-seal-conformance.test.ts`, which spans the
 * recorder and analysis-core the same way and for the same reason: `tools/` has
 * no package.json, so neither package acquires a dependency edge and the graph
 * CLAUDE.md pins is untouched. `analysis-core` is imported by its workspace
 * specifier; the recorder is imported by relative path into its BUILD OUTPUT,
 * which is the point — the gate is derived from the shipped code.
 *
 * ## Requires a build
 *
 * The recorder is imported from `packages/recorder/dist/`. Run `npm run build`
 * first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  INSTITUTION_IDENTITY_FORMAT_VERSION,
  signInstitutionCert,
  signStudentCredential,
  verifyIdentityChain,
  verifyInstitutionCert,
  deriveStudentKeypair,
  generateStudentMasterSecret,
} from '@provenance/log-core';
import type { InstitutionCert, Manifest, StudentCredential } from '@provenance/log-core';
import type { StudentCredentialResponse } from '@provenance/shared/api-schemas';

// The ANALYZER end — pure modules, no DOM, no Vite specifics.
import {
  buildRecorderPasteText,
  checkRecorderPasteText,
  MASTER_SECRET_MARKER,
} from '../packages/analyzer/src/views/enroll/enrollment-token.js';
import {
  pasteCorpus,
  legacyTwoZeroPaste,
} from '../packages/analyzer/src/views/enroll/paste-corpus.fixture.js';

// The RECORDER end — the SHIPPED code, from its build output.
import {
  saveIdentityArtifact,
  loadStudentCredentialArtifact,
  MASTER_SECRET_EXPORT_PREFIX,
  MASTER_SECRET_KEY,
} from '../packages/recorder/dist/identity/secret-store.js';
import { buildSessionIdentity } from '../packages/recorder/dist/identity/session-identity.js';

// ---------------------------------------------------------------------------
// A real institution, with real keys
// ---------------------------------------------------------------------------

const ROOT_PRIV = new Uint8Array(32).fill(0x51);
const INSTITUTION_PRIV = new Uint8Array(32).fill(0x52);
const INSTITUTION_ID = 'berkeley';
const STUDENT_REF = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SESSION_PUBKEY = 'f'.repeat(64);
const SESSION_STARTED_AT = '2026-10-01T12:00:00Z';

type SecretStore = {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
};

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

function toHex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

let ROOT_PUBKEY_HEX: string;
let INSTITUTION_CERT: InstitutionCert;
let MASTER_SECRET: Uint8Array;
let STUDENT_PUBKEY: string;

/** A 2.0 manifest, so the legacy path has something to anchor to when reached. */
const MANIFEST_1_1 = {
  format_version: '1.1',
  assignment_id: 'proj2',
  semester: 'fa26',
  issued_at: '2026-09-08T00:00:00Z',
  files_under_review: ['proj2.java'],
  sig: 'e'.repeat(128),
} as unknown as Manifest;

beforeAll(async () => {
  ROOT_PUBKEY_HEX = bytesToHex(await ed.getPublicKeyAsync(ROOT_PRIV));

  const certBase = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: INSTITUTION_ID,
    institution_pubkey: bytesToHex(await ed.getPublicKeyAsync(INSTITUTION_PRIV)),
    valid_from: '2026-08-20',
    valid_until: '2027-01-15',
  };
  INSTITUTION_CERT = {
    ...certBase,
    root_sig: await signInstitutionCert(certBase, ROOT_PRIV),
  };

  // The student's machine: a real master secret and the real global derivation.
  MASTER_SECRET = generateStudentMasterSecret();
  STUDENT_PUBKEY = (await deriveStudentKeypair(MASTER_SECRET)).publicKeyHex;
});

/**
 * Exactly what `POST /api/v1/identity/credential` returns, with real
 * signatures produced by the same log-core functions the server calls.
 */
async function issueCredential(
  overrides: { institutionId?: string; studentPubkey?: string; expiresAt?: string } = {},
): Promise<StudentCredentialResponse> {
  const base = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: overrides.institutionId ?? INSTITUTION_ID,
    student_ref: STUDENT_REF,
    student_pubkey: overrides.studentPubkey ?? STUDENT_PUBKEY,
    issued_at: '2026-08-25T00:00:00Z',
    expires_at: overrides.expiresAt ?? '2027-01-15',
  };
  const credential: StudentCredential = {
    ...base,
    institution_sig: await signStudentCredential(base, INSTITUTION_PRIV),
  };
  return {
    credential,
    institution_cert: INSTITUTION_CERT,
    institution_id: credential.institution_id,
    student_ref: credential.student_ref,
    reissued: false,
  };
}

// ---------------------------------------------------------------------------
// THE DECISIVE TEST
// ---------------------------------------------------------------------------

describe('the 2.1 enrollment hop, end to end', () => {
  it('server → /enroll → recorder → session.start → a chain walk that verifies', async () => {
    // 1. The server issues a credential.
    const response = await issueCredential();

    // 2. The /enroll page renders the paste artifact. This exact string is what
    //    the student copies — the same function the page calls.
    const pasteText = buildRecorderPasteText(response);

    // 3. The page promises the recorder will take it.
    expect(checkRecorderPasteText(pasteText).ok).toBe(true);

    // 4. The REAL recorder importer takes that exact string.
    const store = makeStore({ [MASTER_SECRET_KEY]: toHex(MASTER_SECRET) });
    const saved = await saveIdentityArtifact(store, pasteText);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.identity_version).toBe('2.1');
    expect(saved.value.student_ref).toBe(STUDENT_REF);

    // 5. The REAL recorder builds the session.start identity block.
    const outcome = await buildSessionIdentity({
      manifest: MANIFEST_1_1,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: store,
      rootPubkeyHex: ROOT_PUBKEY_HEX,
    });
    expect(outcome.kind).toBe('emitted');
    if (outcome.kind !== 'emitted') return;

    // The three fields §5 specifies, and nothing else.
    expect(Object.keys(outcome.identity).sort()).toEqual([
      'enrollment',
      'enrollment_cert',
      'session_pubkey_sig',
    ]);

    // 6. An independent reader — the analyzer, in 2031 — root-verifies the
    //    anchor and walks the chain. Nothing here trusts the recorder's own
    //    verdict; this is the walk performed from scratch.
    const cert = outcome.identity.enrollment_cert as InstitutionCert;
    expect((await verifyInstitutionCert(cert, ROOT_PUBKEY_HEX)).ok).toBe(true);

    const walked = await verifyIdentityChain({
      identity: outcome.identity,
      session_pubkey: SESSION_PUBKEY,
      institution_cert: cert,
      session_started_at: SESSION_STARTED_AT,
    });
    expect(walked.ok).toBe(true);
    if (!walked.ok) return;
    expect(walked.value.identity_version).toBe('2.1');
    expect(walked.value.student_ref).toBe(STUDENT_REF);
    expect(walked.value.student_pubkey).toBe(STUDENT_PUBKEY);
    expect(walked.value.institution_id).toBe(INSTITUTION_ID);
    expect(walked.value.token_window.in_window).toBe(true);
  });

  it('the artifact the page shows IS two-thirds of the identity block, verbatim', async () => {
    // The property that removes the whole class of rename bugs: nothing
    // transforms the two wire slots between the browser and the signed log.
    const response = await issueCredential();
    const pasteText = buildRecorderPasteText(response);

    const store = makeStore({ [MASTER_SECRET_KEY]: toHex(MASTER_SECRET) });
    await saveIdentityArtifact(store, pasteText);
    const outcome = await buildSessionIdentity({
      manifest: MANIFEST_1_1,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: store,
      rootPubkeyHex: ROOT_PUBKEY_HEX,
    });
    expect(outcome.kind).toBe('emitted');
    if (outcome.kind !== 'emitted') return;

    const pasted = JSON.parse(pasteText) as Record<string, unknown>;
    expect(outcome.identity.enrollment).toEqual(pasted['enrollment']);
    expect(outcome.identity.enrollment_cert).toEqual(pasted['enrollment_cert']);
  });

  it('an out-of-window credential still records, and reports the expiry', async () => {
    // Expiry is reported, never enforced (program spec §4).
    const response = await issueCredential({ expiresAt: '2026-09-01' });
    const store = makeStore({ [MASTER_SECRET_KEY]: toHex(MASTER_SECRET) });
    expect((await saveIdentityArtifact(store, buildRecorderPasteText(response))).ok).toBe(true);

    const outcome = await buildSessionIdentity({
      manifest: MANIFEST_1_1,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: store,
      rootPubkeyHex: ROOT_PUBKEY_HEX,
    });

    expect(outcome.kind).toBe('emitted');
    if (outcome.kind !== 'emitted') return;
    expect(outcome.verified.token_window.in_window).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The two ends cannot drift
// ---------------------------------------------------------------------------

describe('paste-format agreement between /enroll and the recorder', () => {
  it('agrees on every case in the shared corpus', async () => {
    for (const text of pasteCorpus()) {
      const store = makeStore({ [MASTER_SECRET_KEY]: toHex(MASTER_SECRET) });
      const saved = await saveIdentityArtifact(store, text);

      // The page's verdict and the recorder's REAL verdict, on the same bytes.
      // A 2.0 artifact is the one deliberate asymmetry: the recorder ROUTES and
      // stores it (2.0 is supported forever), while the 2.1 page refuses it as
      // a version problem — so it is excluded here and asserted below.
      const isLegacy = text === legacyTwoZeroPaste();
      if (isLegacy) continue;

      expect(checkRecorderPasteText(text).ok, `disagreed on: ${text.slice(0, 70)}`).toBe(saved.ok);
    }
  });

  it('a rejected paste stores nothing at all', async () => {
    for (const text of pasteCorpus()) {
      if (checkRecorderPasteText(text).ok) continue;
      if (text === legacyTwoZeroPaste()) continue;

      const store = makeStore({ [MASTER_SECRET_KEY]: toHex(MASTER_SECRET) });
      await saveIdentityArtifact(store, text);
      expect(await loadStudentCredentialArtifact(store)).toBeUndefined();
    }
  });

  it('the recorder still ROUTES and stores a legacy 2.0 paste the 2.1 page refuses', async () => {
    // Both halves matter. 2.0 minting is retired, so the page correctly declines
    // to vouch for one; but a student who already holds a 2.0 token must still
    // be able to import it, and archived bundles must keep verifying forever.
    const legacy = legacyTwoZeroPaste();
    expect(checkRecorderPasteText(legacy)).toMatchObject({
      ok: false,
      kind: 'unsupported_format_version',
    });

    const store = makeStore({ [MASTER_SECRET_KEY]: toHex(MASTER_SECRET) });
    const saved = await saveIdentityArtifact(store, legacy);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.identity_version).toBe('2.0');
    // Stored under the per-course key, NOT as a 2.1 credential.
    expect(await loadStudentCredentialArtifact(store)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The chain rejects what it must
// ---------------------------------------------------------------------------

describe('what the recorder refuses to put in a signed log', () => {
  it('refuses a credential whose institution signature does not verify', async () => {
    const response = await issueCredential();
    // Flip one byte of the signature: shape-valid, cryptographically dead.
    const tampered: StudentCredentialResponse = {
      ...response,
      credential: {
        ...response.credential,
        institution_sig: response.credential.institution_sig.replace(/^./, (c) =>
          c === 'a' ? 'b' : 'a',
        ),
      },
    };
    const text = buildRecorderPasteText(tampered);

    // Import still succeeds — signatures are not checked at import time, by
    // design, because the browser has no anchor either.
    const store = makeStore({ [MASTER_SECRET_KEY]: toHex(MASTER_SECRET) });
    expect((await saveIdentityArtifact(store, text)).ok).toBe(true);

    // The session-start walk is where it dies, and nothing enters the log.
    const outcome = await buildSessionIdentity({
      manifest: MANIFEST_1_1,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: store,
      rootPubkeyHex: ROOT_PUBKEY_HEX,
    });
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason.kind).toBe('chain_did_not_verify');
  });

  it('refuses an institution cert the root key did not sign', async () => {
    const forgedBase = {
      format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
      institution_id: INSTITUTION_ID,
      institution_pubkey: bytesToHex(await ed.getPublicKeyAsync(INSTITUTION_PRIV)),
      valid_from: '2026-08-20',
      valid_until: '2027-01-15',
    };
    const forgedCert: InstitutionCert = {
      ...forgedBase,
      root_sig: await signInstitutionCert(forgedBase, new Uint8Array(32).fill(0x99)),
    };

    const response = await issueCredential();
    const text = buildRecorderPasteText({ ...response, institution_cert: forgedCert });

    const store = makeStore({ [MASTER_SECRET_KEY]: toHex(MASTER_SECRET) });
    expect((await saveIdentityArtifact(store, text)).ok).toBe(true);

    const outcome = await buildSessionIdentity({
      manifest: MANIFEST_1_1,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: store,
      rootPubkeyHex: ROOT_PUBKEY_HEX,
    });
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason.kind).toBe('institution_cert_not_root_signed');
  });

  it('refuses a credential issued to a key this machine cannot derive', async () => {
    // The "enrolled the wrong key" case: the credential is perfectly genuine,
    // but its private half is on someone else's machine.
    const response = await issueCredential({ studentPubkey: 'a'.repeat(64) });
    const store = makeStore({ [MASTER_SECRET_KEY]: toHex(MASTER_SECRET) });
    expect((await saveIdentityArtifact(store, buildRecorderPasteText(response))).ok).toBe(true);

    const outcome = await buildSessionIdentity({
      manifest: MANIFEST_1_1,
      sessionPubkeyHex: SESSION_PUBKEY,
      sessionStartedAt: SESSION_STARTED_AT,
      secrets: store,
      rootPubkeyHex: ROOT_PUBKEY_HEX,
    });
    expect(outcome.kind).toBe('skipped');
    if (outcome.kind !== 'skipped') return;
    expect(outcome.reason.kind).toBe('credential_key_mismatch');
  });
});

// ---------------------------------------------------------------------------
// The master-secret marker, spelled the same at both ends
// ---------------------------------------------------------------------------

describe('the master-secret marker', () => {
  it('is the identical literal in the recorder and in the analyzer', () => {
    // The analyzer restates this constant because it cannot import recorder
    // source. If either side edits its spelling, the page silently stops
    // recognising exported secrets — and a student pasting one gets no warning.
    expect(MASTER_SECRET_MARKER).toBe(MASTER_SECRET_EXPORT_PREFIX);
  });
});
