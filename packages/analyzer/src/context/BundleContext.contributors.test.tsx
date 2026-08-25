/**
 * The `/local` route stamps the contributor verdict — Tier 1.1 wiring.
 *
 * `/local` runs entirely in the browser with no server, so `BundleContext` is
 * the ONLY place the contributor stamp can be established for it. Until it is,
 * every locally-dropped bundle reads `unattributed` and the whole contributor
 * programme is inert here.
 *
 * The failure mode is SILENT — drop the call and nothing throws, no flag
 * changes, the page renders exactly as before — so these tests assert on the
 * stamp itself, through both load paths (`loadBundleFile`, the single-file
 * append, and `loadBundleFiles`, the multi-file fan-out).
 *
 * Two blameless states get equal weight:
 *
 *  - a bundle with NO identity block reads `unattributed`. That is an ordinary
 *    student who never enrolled; nothing about it may render as suspicious.
 *  - `VITE_ROOT_PUBLIC_KEY_HEX` unset is a supported deployment state. The
 *    bundle still loads, still validates, still produces flags, and every
 *    identified session reads `unverifiable / no_root_key` —
 *    `isIdentityCheckFailure()` false, i.e. "we could not check", never "we
 *    checked and it failed".
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { BundleProvider, useBundle } from './BundleContext.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import {
  buildIdentityKeys,
  buildInstitutionIdentity,
  seededKeypair,
} from '@provenance/analysis-core/test-support/build-identity.js';
import type { IdentityTestKeys } from '@provenance/analysis-core/test-support/build-identity.js';
import {
  contributorOf,
  contributorsOf,
  attributedContributorsOf,
  isIdentityCheckFailure,
} from '@provenance/analysis-core/identity/resolve-contributors.js';
import type { Bundle } from '@provenance/analysis-core/loader/types.js';
import type { SessionIdentity } from '@provenance/log-core';

// Wire SHA-512 override (same as build-test-bundle.ts) so ed25519 works in jsdom.
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
  Promise.resolve(sha512(message));

const ALICE = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';
const BOB = '3a1d0e55-8c44-4b2a-a7f0-11c9d2e3f4a5';

// ---------------------------------------------------------------------------
// Deployment config — the browser's half of the root key, baked in at build
// time as VITE_ROOT_PUBLIC_KEY_HEX.
//
// Mocked at the module seam rather than through `vi.stubEnv`, because under
// Vite each module gets its OWN `import.meta.env` object: stubbing the test
// file's copy leaves `root-key.ts` reading its own, and every test would
// silently exercise the no-root-key path while claiming to test attribution.
// (Verified — `vi.stubEnv('VITE_ROOT_PUBLIC_KEY_HEX', …)` does not reach
// `getRootPublicKeyHex()` here.) The mock reproduces both real functions
// exactly, including the empty-string-means-unset rule, so the two stay
// consistent — `localValidationOptions` feeds validation check 2 and must agree
// with what contributor resolution is given.
// ---------------------------------------------------------------------------

const rootKeyHolder = vi.hoisted(() => ({ hex: undefined as string | undefined }));

vi.mock('../lib/root-key.js', () => ({
  getRootPublicKeyHex: () => rootKeyHolder.hex,
  localValidationOptions: () =>
    rootKeyHolder.hex === undefined ? {} : { rootPubkeyHex: rootKeyHolder.hex },
}));

function setRootKey(hex: string): void {
  rootKeyHolder.hex = hex.length === 0 ? undefined : hex;
}

function setNoRootKey(): void {
  rootKeyHolder.hex = undefined;
}

afterEach(() => {
  rootKeyHolder.hex = undefined;
});

// ---------------------------------------------------------------------------
// Key material — deterministic.
// ---------------------------------------------------------------------------

let aliceKeys: IdentityTestKeys | null = null;
let bobKeys: IdentityTestKeys | null = null;

async function keysFor(who: 'alice' | 'bob'): Promise<IdentityTestKeys> {
  if (who === 'alice') {
    aliceKeys ??= await buildIdentityKeys();
    return aliceKeys;
  }
  // Same root + institution — one deployment — but a different student key.
  bobKeys ??= await buildIdentityKeys({ studentSeedByte: 0x56 });
  return bobKeys;
}

const sessionKey = (i: number) => seededKeypair(0x60 + i);

type SessionSpec = {
  /** Omit for a session with NO identity block — the blameless, ordinary case. */
  identity?: SessionIdentity;
  sessionPubkeyHex: string;
};

async function bundleFile(name: string, specs: SessionSpec[]): Promise<File> {
  const { blob } = await buildTestBundle({
    sessions: specs.map((spec) => ({
      sessionStart: {
        session_pubkey: spec.sessionPubkeyHex,
        ...(spec.identity !== undefined ? { identity: spec.identity } : {}),
      },
    })),
  });
  return new File([blob], name, { type: 'application/zip' });
}

// ---------------------------------------------------------------------------
// Harness — pull the loaded Bundles back out of context for assertion.
// ---------------------------------------------------------------------------

let captured: Bundle[] = [];

function Capture() {
  const { bundles, status, flags } = useBundle();
  captured = bundles;
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="bundle-count">{bundles.length}</span>
      <span data-testid="flag-count">{flags.length}</span>
    </div>
  );
}

function Trigger({ files, multi }: { files: File[]; multi: boolean }) {
  const { loadBundleFile, loadBundleFiles } = useBundle();
  return (
    <button
      data-testid="load-btn"
      onClick={() => {
        if (multi) void loadBundleFiles(files);
        else void loadBundleFile(files[0]!);
      }}
    >
      load
    </button>
  );
}

async function loadInto(files: File[], multi = false): Promise<Bundle[]> {
  captured = [];
  render(
    <MemoryRouter>
      <BundleProvider>
        <Capture />
        <Trigger files={files} multi={multi} />
      </BundleProvider>
    </MemoryRouter>,
  );
  await act(async () => {
    screen.getByTestId('load-btn').click();
  });
  await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('loaded'), {
    timeout: 20_000,
  });
  await waitFor(() =>
    expect(Number(screen.getByTestId('bundle-count').textContent)).toBe(files.length),
  );
  return captured;
}

beforeEach(() => {
  captured = [];
});

// ---------------------------------------------------------------------------
// Attributed
// ---------------------------------------------------------------------------

describe('/local — attributed contributors', () => {
  it('resolves BOTH contributors of a two-contributor bundle', async () => {
    const alice = await keysFor('alice');
    const bob = await keysFor('bob');
    setRootKey(alice.root.pubkeyHex);

    const sk0 = await sessionKey(0);
    const sk1 = await sessionKey(1);
    const file = await bundleFile('shared-repo.zip', [
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: alice,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
      {
        sessionPubkeyHex: sk1.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: bob,
          sessionPubkeyHex: sk1.pubkeyHex,
          studentRef: BOB,
        }),
      },
    ]);

    const [bundle] = await loadInto([file]);

    // The assertion that goes red if the establishBundleContributors call is
    // ever dropped from BundleContext.
    expect(bundle!.contributors).toBeDefined();
    expect(bundle!.contributors!.rootKeyConfigured).toBe(true);
    expect(bundle!.contributors!.counts).toEqual({
      attributed: 2,
      unverifiable: 0,
      unattributed: 0,
    });

    const attributed = attributedContributorsOf(bundle!);
    expect(attributed).toHaveLength(2);
    expect(attributed.map((c) => c.studentRef).sort()).toEqual([BOB, ALICE].sort());
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Unattributed — the blameless, ordinary state
// ---------------------------------------------------------------------------

describe('/local — a bundle with no identity is blameless', () => {
  it('reads unattributed, with nothing that could render as suspicious', async () => {
    const alice = await keysFor('alice');
    setRootKey(alice.root.pubkeyHex);

    const sk0 = await sessionKey(0);
    const sk1 = await sessionKey(1);
    const file = await bundleFile('no-identity.zip', [
      { sessionPubkeyHex: sk0.pubkeyHex },
      { sessionPubkeyHex: sk1.pubkeyHex },
    ]);

    const [bundle] = await loadInto([file]);

    expect(bundle!.contributors!.counts).toEqual({
      attributed: 0,
      unverifiable: 0,
      unattributed: 2,
    });

    for (const session of bundle!.sessions) {
      const verdict = contributorOf(bundle!, session.sessionId);
      expect(verdict.kind).toBe('unattributed');
      // No claim, no reason, no name. An absent identity block is a student who
      // never enrolled, not an allegation.
      expect(verdict).not.toHaveProperty('reason');
      expect(verdict).not.toHaveProperty('claimedStudentRef');
    }

    // Two unattributed sessions are never grouped, and never promoted to
    // `unverifiable`.
    expect(contributorsOf(bundle!)).toHaveLength(2);
    expect(attributedContributorsOf(bundle!)).toHaveLength(0);
    expect(bundle!.contributors!.counts.unverifiable).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// No root key — a supported deployment state
// ---------------------------------------------------------------------------

describe('/local — a deployment with no root public key', () => {
  it('still loads and analyses, reporting no_root_key rather than a check failure', async () => {
    const alice = await keysFor('alice');
    setNoRootKey();

    const sk0 = await sessionKey(0);
    const file = await bundleFile('unconfigured.zip', [
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: alice,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);

    const [bundle] = await loadInto([file]);

    // Analysis must not depend on key configuration: the bundle loaded, and the
    // provider reached 'loaded' rather than 'error'.
    expect(screen.getByTestId('status').textContent).toBe('loaded');
    expect(bundle!.contributors!.rootKeyConfigured).toBe(false);

    const verdict = contributorOf(bundle!, bundle!.sessions[0]!.sessionId);
    expect(verdict.kind).toBe('unverifiable');
    if (verdict.kind !== 'unverifiable') throw new Error('unreachable');
    expect(verdict.reason.kind).toBe('no_root_key');

    // THE assertion. An unset build-time env var must never read as a cohort of
    // students whose identities failed verification.
    expect(isIdentityCheckFailure(verdict.reason)).toBe(false);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The multi-file fan-out
// ---------------------------------------------------------------------------

describe('/local — loadBundleFiles stamps each bundle separately', () => {
  it('never gives one bundle the contributor stamp of another', async () => {
    const alice = await keysFor('alice');
    const bob = await keysFor('bob');
    setRootKey(alice.root.pubkeyHex);

    const sk0 = await sessionKey(0);
    const sk1 = await sessionKey(1);
    const aliceFile = await bundleFile('alice.zip', [
      {
        sessionPubkeyHex: sk0.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: alice,
          sessionPubkeyHex: sk0.pubkeyHex,
          studentRef: ALICE,
        }),
      },
    ]);
    const bobFile = await bundleFile('bob.zip', [
      {
        sessionPubkeyHex: sk1.pubkeyHex,
        identity: await buildInstitutionIdentity({
          keys: bob,
          sessionPubkeyHex: sk1.pubkeyHex,
          studentRef: BOB,
        }),
      },
    ]);

    const loaded = await loadInto([aliceFile, bobFile], true);
    expect(loaded).toHaveLength(2);

    const refs = loaded.map((b) => {
      const v = contributorOf(b, b.sessions[0]!.sessionId);
      return v.kind === 'attributed' ? v.studentRef : null;
    });
    expect(refs.sort()).toEqual([BOB, ALICE].sort());
    // Distinct stamp objects, not one shared across the fan-out.
    expect(loaded[0]!.contributors).not.toBe(loaded[1]!.contributors);
  }, 30_000);
});
