/**
 * Unit tests for extractSubmittedFiles / extractSubmittedFileContent (F2).
 *
 * Builds real in-memory ZIPs via buildTestBundle from the analyzer test
 * helpers — the same helper used by analyzer unit tests. Uses zipBuffer
 * (ArrayBuffer) directly so no browser Blob API is required in Node.
 *
 * No DB, no MinIO — pure function tests over ArrayBuffer input.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
import { sha256Hex } from '@provenance/log-core';
import { extractSubmittedFiles, extractSubmittedFileContent } from './submitted-files.js';

// Wire SHA-512 for @noble/ed25519 (required in non-browser / Node environments).
beforeAll(() => {
  ed.hashes.sha512 = sha512;
  (ed.hashes as Record<string, unknown>)['sha512Async'] = (message: Uint8Array) =>
    Promise.resolve(sha512(message));
});

/**
 * The stored `chain_integrity` verdict, which the route reads out of
 * validation_results and passes in. These functions no longer re-derive it with
 * their own runValidation pass — see submitted-files.ts.
 */
const CHAIN_INTACT = { chainIntact: true } as const;
const CHAIN_BROKEN = { chainIntact: false } as const;

// ---------------------------------------------------------------------------
// extractSubmittedFiles
// ---------------------------------------------------------------------------

describe('extractSubmittedFiles', () => {
  it('returns available:true with empty files for a 1.0 bundle (no submission_files)', async () => {
    const { zipBuffer } = await buildTestBundle({ sessions: [{ eventCount: 3 }] });
    const result = await extractSubmittedFiles(zipBuffer, CHAIN_INTACT);

    expect(result.available).toBe(true);
    expect(result.files).toHaveLength(0);
  });

  it('returns available:true + verdict list for a 1.1 bundle with a present file', async () => {
    const content = 'print("hello")\n';
    // Provide a doc.save event whose sha256 matches the submitted file so
    // Check 8 can produce a 'match' verdict (chain intact, recorded hash matches).
    const fileHash = sha256Hex(new TextEncoder().encode(content));
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [{ kind: 'doc.save', data: { path: 'hw03.py', sha256: fileHash } }],
        },
      ],
      submissionFiles: [{ path: 'hw03.py', status: 'present', content }],
    });

    const result = await extractSubmittedFiles(zipBuffer, CHAIN_INTACT);

    expect(result.available).toBe(true);
    expect(result.files).toHaveLength(1);
    const f = result.files[0]!;
    expect(f.path).toBe('hw03.py');
    expect(f.status).toBe('present');
    expect(f.verdict).toBe('match');
    expect(typeof f.sha256).toBe('string');
  });

  it('returns verdict:mismatch for a tampered submitted file', async () => {
    const actualContent = 'print("tampered")\n';
    const originalContent = 'print("original")\n';
    // doc.save records the original hash, but we submit a different file.
    const recordedHash = sha256Hex(new TextEncoder().encode(originalContent));
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [{ kind: 'doc.save', data: { path: 'hw03.py', sha256: recordedHash } }],
        },
      ],
      submissionFiles: [{ path: 'hw03.py', status: 'present', content: actualContent }],
    });

    const result = await extractSubmittedFiles(zipBuffer, CHAIN_INTACT);

    expect(result.available).toBe(true);
    const f = result.files.find((x) => x.path === 'hw03.py');
    expect(f).toBeDefined();
    expect(f!.verdict).toBe('mismatch');
  });

  it('returns available:true with empty files for a corrupt/unparseable buffer', async () => {
    const garbage = new Uint8Array([0, 1, 2, 3]).buffer;
    const result = await extractSubmittedFiles(garbage, CHAIN_INTACT);

    expect(result.available).toBe(true);
    expect(result.files).toHaveLength(0);
  });

  it('handles a missing (not on disk at seal) submitted file', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [{ path: 'missing.py', status: 'missing' }],
    });

    const result = await extractSubmittedFiles(zipBuffer, CHAIN_INTACT);
    expect(result.available).toBe(true);
    const f = result.files.find((x) => x.path === 'missing.py');
    expect(f).toBeDefined();
    expect(f!.status).toBe('missing');
  });

  // The gate comes from the STORED validation row, not from a live re-run. A
  // stored chain_integrity failure must therefore reach the verdicts — otherwise
  // the Source badges and the Validation tab could contradict each other on one
  // page load, which is the bug this argument exists to prevent.
  it('honours a stored chain_integrity failure: verdicts degrade to unknown', async () => {
    const content = 'print("hello")\n';
    const fileHash = sha256Hex(new TextEncoder().encode(content));
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [{ kind: 'doc.save', data: { path: 'hw03.py', sha256: fileHash } }],
        },
      ],
      submissionFiles: [{ path: 'hw03.py', status: 'present', content }],
    });

    // Same bundle, same bytes — only the stored gate differs.
    const intact = await extractSubmittedFiles(zipBuffer, CHAIN_INTACT);
    expect(intact.files.find((x) => x.path === 'hw03.py')!.verdict).toBe('match');

    const broken = await extractSubmittedFiles(zipBuffer, CHAIN_BROKEN);
    expect(broken.files.find((x) => x.path === 'hw03.py')!.verdict).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// extractSubmittedFileContent
// ---------------------------------------------------------------------------

describe('extractSubmittedFileContent', () => {
  // Content is reconstructed from the event stream (source bytes are no longer
  // stored), so the bundle carries doc events that rebuild the file. The file is
  // still listed in the manifest's submission_files (status/path drive the
  // present/missing/null branches).
  it('returns reconstructed content for a present file', async () => {
    const content = 'print(1)\n';
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ events: [{ kind: 'doc.open', data: { path: 'hw03.py', content } }] }],
      submissionFiles: [{ path: 'hw03.py', status: 'present', content }],
    });

    const result = await extractSubmittedFileContent(zipBuffer, 'hw03.py', CHAIN_INTACT);
    expect(result).not.toBeNull();
    expect(result!.path).toBe('hw03.py');
    expect(result!.content).toBe(content);
    expect(result!.status).toBe('present');
  });

  it('returns null for a path not in submission_files', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [{ path: 'hw03.py', status: 'present', content: 'x' }],
    });

    const result = await extractSubmittedFileContent(zipBuffer, 'nonexistent.py', CHAIN_INTACT);
    expect(result).toBeNull();
  });

  it('returns null for a missing (not on disk) file', async () => {
    const { zipBuffer } = await buildTestBundle({
      sessions: [{}],
      submissionFiles: [{ path: 'missing.py', status: 'missing' }],
    });

    const result = await extractSubmittedFileContent(zipBuffer, 'missing.py', CHAIN_INTACT);
    expect(result).toBeNull();
  });

  it('returns null for a corrupt/unparseable buffer', async () => {
    const garbage = new Uint8Array([0, 1, 2, 3]).buffer;
    const result = await extractSubmittedFileContent(garbage, 'hw03.py', CHAIN_INTACT);
    expect(result).toBeNull();
  });

  it('round-trips a nested path (lab02/q1.py) correctly', async () => {
    const content = 'def q1(): pass\n';
    const nestedPath = 'lab02/q1.py';
    const { zipBuffer } = await buildTestBundle({
      sessions: [{ events: [{ kind: 'doc.open', data: { path: nestedPath, content } }] }],
      submissionFiles: [{ path: nestedPath, status: 'present', content }],
    });

    const result = await extractSubmittedFileContent(zipBuffer, nestedPath, CHAIN_INTACT);
    expect(result).not.toBeNull();
    expect(result!.path).toBe(nestedPath);
    expect(result!.content).toBe(content);
  });

  // The pane must never be presentable as "the submitted code". The server can
  // only ever replay events (stored bundles are provenance-only), so every
  // response says so and the analyzer renders the caveat off this field.
  it("always reports content_source 'event_replay', including on a mismatch", async () => {
    const recordedContent = 'print("original")\n';
    const submittedContent = 'print("something else")\n';
    const recordedHash = sha256Hex(new TextEncoder().encode(recordedContent));
    const { zipBuffer } = await buildTestBundle({
      sessions: [
        {
          events: [
            { kind: 'doc.open', data: { path: 'hw03.py', content: recordedContent } },
            { kind: 'doc.save', data: { path: 'hw03.py', sha256: recordedHash } },
          ],
        },
      ],
      submissionFiles: [{ path: 'hw03.py', status: 'present', content: submittedContent }],
    });

    const result = await extractSubmittedFileContent(zipBuffer, 'hw03.py', CHAIN_INTACT);
    expect(result).not.toBeNull();
    expect(result!.verdict).toBe('mismatch');
    expect(result!.content_source).toBe('event_replay');
    // The pane shows the RECORDING, not the submitted bytes — that is exactly
    // the confusion the caveat exists to prevent.
    expect(result!.content).toBe(recordedContent);
    expect(result!.content).not.toBe(submittedContent);
  });
});
