/**
 * SELF-CONSISTENCY GATE for the Manifest 2.0 conformance vectors.
 *
 * `tools/export-conformance-vectors.ts` is a hand-run script with no npm script
 * and, until this file existed, no test. It builds fixtures with one set of
 * fields and log-core parses them with another, and nothing sat between the two.
 *
 * That gap fired for real. Path scope made `ignore` and `attachments` REQUIRED
 * in the 2.0 signed payload (`docs/superpowers/specs/2026-08-22-path-scope-design.md`
 * §3). The exporter was never updated, so it went on emitting `manifest-v2.json`
 * containing a 2.0 manifest that this repo's own `parseManifestValue` rejects,
 * carrying a `sig` over a payload `buildSignedPayload` can no longer produce.
 * Nothing here noticed. The Kotlin (provjet) and Lua (provnvim) ports check that
 * file in and assert against its `canonical_json`, so the only place the damage
 * would have surfaced is a port implementing the spec correctly and going red
 * against a stale vector, in a different repo, months later.
 *
 * So this file asserts a PROPERTY, not a snapshot: every 2.0 manifest the
 * exporter emits is valid per this repo's own parser and verifier, and every
 * verdict it publishes is the verdict those functions actually return. A
 * snapshot would have happily pinned the broken bytes.
 *
 * The next required-field addition therefore fails HERE, loudly, in the same
 * repo and the same commit as the field.
 *
 * ## Why tools/ and not packages/log-core/
 *
 * Same precedent as `tools/recorder-seal-conformance.test.ts` and
 * `tools/manifest-composer-conformance.test.ts`: the thing under test is the
 * exporter, which lives in `tools/`, and `tools/` is the one place allowed to
 * span dependency graphs. Run by `npm run test:tools` via the root
 * `vitest.config.ts`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { parseManifestValue, verifyManifestChain, canonicalize } from '@provenance/log-core';
import type { Manifest } from '@provenance/log-core';
import { buildManifestV2Vectors } from './export-conformance-vectors.ts';

/**
 * Every 2.0 manifest in the emitted tree that MUST NOT parse, by the JSON path
 * the walker below reports.
 *
 * These are the file's deliberate negative vectors — a port is supposed to
 * refuse them. Everything else must parse. Listing them explicitly (rather than
 * inferring intent from a published `expected`) is the point: a NEW 2.0 manifest
 * that stops parsing shows up as an unexpected extra entry here, which is
 * exactly how the `ignore`/`attachments` regression would have been caught.
 */
const INTENTIONALLY_UNPARSEABLE = [
  // chain step 0 / the inner defence: a 2.0 manifest with the cert removed.
  'chain_cases[7].input.manifest',
  // The five path-scope rejection vectors.
  'scope_rejects[0].manifest_json', // missing `ignore`
  'scope_rejects[1].manifest_json', // missing `attachments`
  'scope_rejects[2].manifest_json', // "build/**/*.class" — not the grammar
  'scope_rejects[3].manifest_json', // "../other-course/" — climbs out
  'scope_rejects[4].manifest_json', // `ignore` is a bare string
];

// Set explicitly rather than relying on the exporter's module-load side effect:
// this file's own `ed.verifyAsync` call must not depend on import order.
ed.hashes.sha512 = sha512;

type Found = { path: string; manifest: Manifest };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for anything shaped like a signed 2.0 manifest, however malformed. */
function looksLikeV2Manifest(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value['format_version'] === '2.0' && typeof value['sig'] === 'string';
}

/**
 * Collect every 2.0 manifest anywhere in the emitted tree, including the ones
 * published as JSON STRINGS (`manifest_json`) — those are what a port actually
 * feeds to its parser, so skipping them would leave the interesting half untested.
 */
function findV2Manifests(node: unknown, path: string, out: Found[]): void {
  if (typeof node === 'string') {
    // Only attempt a re-parse where the key name says it is a manifest document;
    // parsing every string in the tree would be guesswork.
    if (!path.endsWith('manifest_json')) return;
    let inner: unknown;
    try {
      inner = JSON.parse(node);
    } catch {
      return;
    }
    if (looksLikeV2Manifest(inner)) out.push({ path, manifest: inner as unknown as Manifest });
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, i) => findV2Manifests(child, `${path}[${i}]`, out));
    return;
  }
  if (!isRecord(node)) return;
  if (looksLikeV2Manifest(node)) {
    out.push({ path, manifest: node as unknown as Manifest });
    // Keep walking: a manifest can contain no nested manifest today, but a
    // future vector nesting one (e.g. inside session.start) must not go unseen.
  }
  for (const [key, child] of Object.entries(node)) {
    findV2Manifests(child, path === '' ? key : `${path}.${key}`, out);
  }
}

/**
 * The vectors exactly as a port receives them: serialized and re-read. Asserting
 * against the in-memory objects would let a value that cannot survive JSON
 * (undefined, a non-plain object) pass here and fail over there.
 */
type Vectors = Record<string, unknown>;

let vectors: Vectors;
let found: Found[];

beforeAll(async () => {
  vectors = JSON.parse(JSON.stringify(await buildManifestV2Vectors())) as Vectors;
  found = [];
  findV2Manifests(vectors, '', found);
});

/**
 * The vector fixtures are replayed exactly as a port would replay them —
 * unvalidated, straight off the wire — so the chain functions are handed the raw
 * object on purpose. `verifyManifestChain` re-validates internally.
 */
const asManifest = (value: unknown): Manifest => value as Manifest;

function chainOutcome(
  result: Awaited<ReturnType<typeof verifyManifestChain>>,
): Record<string, unknown> {
  if (result.ok) {
    return { ok: true, course_id: result.value.course_id, window: result.value.window };
  }
  return { ok: false, ...result.error };
}

describe('manifest-v2 conformance vectors are self-consistent', () => {
  it('emits at least the manifests it is supposed to emit', () => {
    // A walker that silently found nothing would make every assertion below
    // vacuously pass, which is the one way this gate could fail open.
    expect(found.length).toBeGreaterThanOrEqual(8);
    expect(found.map((f) => f.path)).toContain('valid_2_0.manifest');
  });

  it('every emitted 2.0 manifest parses, except the deliberate negatives', () => {
    const rejected = found
      .filter(({ manifest }) => !parseManifestValue(manifest).ok)
      .map(({ path, manifest }) => ({
        path,
        // Surfaced in the diff so a failure names the missing field rather than
        // just a path — the whole cost of the original bug was the diagnosis.
        reason: JSON.stringify(parseManifestValue(manifest)),
      }));

    expect(rejected.map((r) => r.path).sort()).toEqual([...INTENTIONALLY_UNPARSEABLE].sort());
  });

  it('every 2.0 manifest published as valid also chain-verifies or fails for its stated reason', async () => {
    const rootPubkeyHex = vectors['root_pubkey_hex'];
    expect(typeof rootPubkeyHex).toBe('string');

    const parsed = found.filter(({ manifest }) => parseManifestValue(manifest).ok);
    // The one manifest the file designates as wholly valid must verify end to
    // end against the root key the vectors ship.
    const valid = parsed.find((f) => f.path === 'valid_2_0.manifest');
    expect(valid).toBeDefined();
    const chain = await verifyManifestChain(asManifest(valid?.manifest), rootPubkeyHex as string);
    expect(chain.ok).toBe(true);
  });

  it('valid_2_0.canonical_json is byte-exactly what the sig covers', async () => {
    const vector = vectors['valid_2_0'];
    expect(isRecord(vector)).toBe(true);
    const record = vector as Record<string, unknown>;
    const manifest = record['manifest'] as Record<string, unknown>;
    const canonicalJson = record['canonical_json'];
    expect(typeof canonicalJson).toBe('string');

    const coursePubkeyHex = vectors['course_pubkey_hex'] as string;
    const verified = await ed.verifyAsync(
      hexToBytes(manifest['sig'] as string),
      new TextEncoder().encode(canonicalJson as string),
      hexToBytes(coursePubkeyHex),
    );
    // This is the assertion the old hand-copied literal could not make: the
    // published bytes are the bytes the course key actually signed, so a port
    // that reproduces them reproduces a verifying signature.
    expect(verified).toBe(true);

    // And the payload really is the manifest minus the two excluded keys.
    const { sig: _sig, course_cert: _cert, ...payload } = manifest;
    expect(canonicalJson).toBe(canonicalize(payload));
    expect(Object.keys(payload).sort()).toEqual(
      [
        'assignment_id',
        'attachments',
        'collaboration',
        'course_id',
        'files_under_review',
        'format_version',
        'ignore',
        'issued_at',
        'policy',
        'scope',
        'semester',
        'submission',
      ].sort(),
    );
  });

  it('every published chain verdict is the verdict verifyManifestChain returns', async () => {
    const cases = vectors['chain_cases'];
    expect(Array.isArray(cases)).toBe(true);
    for (const entry of cases as unknown[]) {
      const c = entry as Record<string, unknown>;
      const input = c['input'] as Record<string, unknown>;
      const actual = chainOutcome(
        await verifyManifestChain(
          asManifest(input['manifest']),
          input['root_pubkey_hex'] as string,
        ),
      );
      expect({ name: c['name'], outcome: actual }).toEqual({
        name: c['name'],
        outcome: c['expected'],
      });
    }
  });

  it('every path-scope rejection vector really is a rejected 2.0 manifest', () => {
    const rejects = vectors['scope_rejects'];
    expect(Array.isArray(rejects)).toBe(true);
    expect((rejects as unknown[]).length).toBe(5);
    for (const entry of rejects as unknown[]) {
      const c = entry as Record<string, unknown>;
      const manifest = JSON.parse(c['manifest_json'] as string) as unknown;
      // It must be a 2.0 manifest — a vector that accidentally dropped
      // format_version would be rejected for the wrong reason and would teach a
      // port nothing about path scope.
      expect(looksLikeV2Manifest(manifest)).toBe(true);
      const result = parseManifestValue(manifest);
      expect({ name: c['name'], parses: result.ok }).toEqual({ name: c['name'], parses: false });
      expect(c['expected']).toEqual({ parses: false });
    }
  });

  it('the required scope lists are non-empty and exercise all three entry forms', () => {
    const lists = vectors['scope_lists'] as Record<string, unknown>;
    for (const field of ['files_under_review', 'ignore', 'attachments']) {
      const entries = lists[field];
      expect(Array.isArray(entries)).toBe(true);
      const list = entries as string[];
      expect(list.length).toBeGreaterThan(0);
      // A vector family that only ever showed one form would leave two thirds of
      // the grammar untested in both ports.
      expect(list.some((e) => e.endsWith('/'))).toBe(true);
      expect(list.some((e) => e.startsWith('*'))).toBe(true);
      expect(list.some((e) => !e.endsWith('/') && !e.startsWith('*'))).toBe(true);
    }

    // The published lists are the ones the valid manifest actually carries.
    const manifest = (vectors['valid_2_0'] as Record<string, unknown>)['manifest'] as Record<
      string,
      unknown
    >;
    for (const field of ['files_under_review', 'ignore', 'attachments']) {
      expect(manifest[field]).toEqual(lists[field]);
    }
  });
});
