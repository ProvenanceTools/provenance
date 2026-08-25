/**
 * Tests for the ROLLING SEAL write side.
 *
 * These are unit tests over `writeRollingSeal` alone. The composition gate that
 * drives this output through the analyzer's real `loadBundle` + `runValidation`
 * lives in `tools/recorder-seal-conformance.test.ts` — that is where "the reader
 * accepts what the writer produces" is actually proven. What is tested here is
 * everything a reader cannot see: temp-file hygiene, behaviour when the
 * directory vanishes, and the promise that a failure is returned rather than
 * thrown.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { hexToBytes } from '@noble/hashes/utils.js';
import {
  canonicalize,
  generateSessionKeypair,
  sha256Hex,
  validateBundleManifestShape,
  validateRollingSessionManifest,
  rollingManifestFilenames,
} from '@provenance/log-core';
import type { SessionKeypair } from '@provenance/log-core';
import { writeRollingSeal } from './rolling-seal-writer.js';
import type { RollingSealOptions } from './rolling-seal-writer.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const EXTENSION_HASH = 'e'.repeat(64);

describe('writeRollingSeal', () => {
  let tmpDir: string;
  let assignmentRoot: string;
  let provenanceDir: string;
  let slogPath: string;
  let keypair: SessionKeypair;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prov-rolling-'));
    assignmentRoot = path.join(tmpDir, 'workspace');
    provenanceDir = path.join(assignmentRoot, '.provenance');
    await fs.mkdir(provenanceDir, { recursive: true });
    slogPath = path.join(provenanceDir, `session-${SESSION_A}.slog`);
    await fs.writeFile(slogPath, '{"seq":0}\n', 'utf8');
    await fs.writeFile(`${slogPath}.meta`, '{"format_version":"1.0"}', 'utf8');
    keypair = await generateSessionKeypair();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function opts(overrides: Partial<RollingSealOptions> = {}): RollingSealOptions {
    return {
      provenanceDir,
      sessionId: SESSION_A,
      prevSessionId: null,
      slogPath,
      assignmentRoot,
      assignmentId: 'hw03',
      semester: 'fa26',
      scope: { track: ['hw.py'], ignore: [], attachments: [] },
      scopeCapped: false,
      sessionPrivkey: keypair.privateKey,
      extensionHash: EXTENSION_HASH,
      ...overrides,
    };
  }

  // -------------------------------------------------------------------------
  // Filenames — the property that makes a shared `.provenance/` add-only.
  // -------------------------------------------------------------------------

  it('writes exactly the two per-session filenames log-core specifies', async () => {
    await fs.writeFile(path.join(assignmentRoot, 'hw.py'), 'print(1)\n', 'utf8');

    const result = await writeRollingSeal(opts());
    expect(result.kind).toBe('written');

    const names = rollingManifestFilenames(SESSION_A);
    const entries = (await fs.readdir(provenanceDir)).sort();
    expect(entries).toContain(names.json);
    expect(entries).toContain(names.sig);
    expect(names.json).toBe(`manifest-${SESSION_A}.json`);
  });

  it('NEVER writes manifest.json or manifest.sig — those belong to the classic seal', async () => {
    await writeRollingSeal(opts());

    const entries = await fs.readdir(provenanceDir);
    expect(entries).not.toContain('manifest.json');
    expect(entries).not.toContain('manifest.sig');
  });

  it('leaves a pre-existing classic manifest.json/.sig byte-for-byte untouched', async () => {
    // A directory that was classically sealed, then recorded into again.
    const classicJson = '{"format_version":"1.1","classic":true}';
    const classicSig = 'f'.repeat(128);
    await fs.writeFile(path.join(provenanceDir, 'manifest.json'), classicJson, 'utf8');
    await fs.writeFile(path.join(provenanceDir, 'manifest.sig'), classicSig, 'utf8');

    await writeRollingSeal(opts());
    await writeRollingSeal(opts());

    expect(await fs.readFile(path.join(provenanceDir, 'manifest.json'), 'utf8')).toBe(classicJson);
    expect(await fs.readFile(path.join(provenanceDir, 'manifest.sig'), 'utf8')).toBe(classicSig);
  });

  it('two concurrent sessions never write the same path (the partner case)', async () => {
    const slogB = path.join(provenanceDir, `session-${SESSION_B}.slog`);
    await fs.writeFile(slogB, '{"seq":0}\n', 'utf8');
    await fs.writeFile(`${slogB}.meta`, '{}', 'utf8');
    const keypairB = await generateSessionKeypair();

    // Both partners' recorders sealing into the SAME .provenance/ at once.
    const [a, b] = await Promise.all([
      writeRollingSeal(opts()),
      writeRollingSeal(
        opts({ sessionId: SESSION_B, slogPath: slogB, sessionPrivkey: keypairB.privateKey }),
      ),
    ]);

    expect(a.kind).toBe('written');
    expect(b.kind).toBe('written');
    if (a.kind !== 'written' || b.kind !== 'written') return;

    expect(a.manifestPath).not.toBe(b.manifestPath);
    expect(a.sigPath).not.toBe(b.sigPath);

    // Both survive: writing is add-only, so neither partner clobbers the other.
    const entries = (await fs.readdir(provenanceDir)).sort();
    expect(entries).toContain(`manifest-${SESSION_A}.json`);
    expect(entries).toContain(`manifest-${SESSION_B}.json`);
    expect(entries).toContain(`manifest-${SESSION_A}.sig`);
    expect(entries).toContain(`manifest-${SESSION_B}.sig`);
  });

  // -------------------------------------------------------------------------
  // Manifest content — the rules log-core's validator enforces.
  // -------------------------------------------------------------------------

  it('produces a 1.2 manifest covering exactly one session, bound to its filename', async () => {
    const result = await writeRollingSeal(opts({ prevSessionId: SESSION_B }));
    expect(result.kind).toBe('written');
    if (result.kind !== 'written') return;

    const onDisk = await fs.readFile(result.manifestPath, 'utf8');
    // What is on disk is exactly what was signed.
    expect(onDisk).toBe(result.canonicalJson);

    const shape = validateBundleManifestShape(JSON.parse(onDisk));
    expect(shape.ok).toBe(true);
    if (!shape.ok) return;

    expect(shape.value.format_version).toBe('1.2');
    expect(shape.value.assignment_id).toBe('hw03');
    expect(shape.value.semester).toBe('fa26');
    expect(shape.value.extension_hash).toBe(EXTENSION_HASH);
    expect(shape.value.sessions).toHaveLength(1);

    // The rule that stops a manifest being copied sideways: the id in the file
    // must equal the id in the filename.
    const rolling = validateRollingSessionManifest(shape.value, SESSION_A);
    expect(rolling.ok).toBe(true);
    if (!rolling.ok) return;
    expect(rolling.value.sessions[0].session_id).toBe(SESSION_A);
    expect(rolling.value.sessions[0].prev_session_id).toBe(SESSION_B);
  });

  it('records the CURRENT on-disk hashes of its own .slog and .slog.meta', async () => {
    const slogBytes = await fs.readFile(slogPath);
    const metaBytes = await fs.readFile(`${slogPath}.meta`);

    const result = await writeRollingSeal(opts());
    if (result.kind !== 'written') throw new Error('expected written');
    const manifest = JSON.parse(result.canonicalJson) as {
      sessions: Array<{ slog_sha256: string; meta_sha256: string }>;
    };

    expect(manifest.sessions[0]!.slog_sha256).toBe(
      createHash('sha256').update(slogBytes).digest('hex'),
    );
    expect(manifest.sessions[0]!.meta_sha256).toBe(
      createHash('sha256').update(metaBytes).digest('hex'),
    );
  });

  it('re-seals to the newer hash after the .slog grows (the "rolling" part)', async () => {
    const first = await writeRollingSeal(opts());
    await fs.appendFile(slogPath, '{"seq":1}\n', 'utf8');
    const second = await writeRollingSeal(opts());

    if (first.kind !== 'written' || second.kind !== 'written') throw new Error('expected written');
    expect(second.canonicalJson).not.toBe(first.canonicalJson);
    expect(await fs.readFile(second.manifestPath, 'utf8')).toBe(second.canonicalJson);
    expect(await fs.readFile(second.sigPath, 'utf8')).toBe(second.signatureHex);
  });

  it('records files under review as present-with-hash or missing-with-null', async () => {
    await fs.writeFile(path.join(assignmentRoot, 'here.py'), 'x = 1\n', 'utf8');

    const result = await writeRollingSeal(
      opts({ scope: { track: ['here.py', 'gone.py'], ignore: [], attachments: [] } }),
    );
    if (result.kind !== 'written') throw new Error('expected written');

    const manifest = JSON.parse(result.canonicalJson) as {
      submission_files: Array<{
        path: string;
        status: string;
        sha256: string | null;
        role: string;
      }>;
    };
    expect(manifest.submission_files).toEqual([
      { path: 'here.py', status: 'present', sha256: sha256Hex('x = 1\n'), role: 'reviewed' },
      { path: 'gone.py', status: 'missing', sha256: null, role: 'reviewed' },
    ]);
  });

  it('seals a session with no files under review at all', async () => {
    const result = await writeRollingSeal(
      opts({ scope: { track: [], ignore: [], attachments: [] } }),
    );
    expect(result.kind).toBe('written');
    if (result.kind !== 'written') return;

    const manifest = JSON.parse(result.canonicalJson) as { submission_files: unknown[] };
    expect(manifest.submission_files).toEqual([]);
    // An empty submission_files array is still a valid 1.2 manifest.
    expect(validateBundleManifestShape(JSON.parse(result.canonicalJson)).ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Signing — this session's own key, and no other.
  // -------------------------------------------------------------------------

  it('signs with the session key whose pubkey goes into session.start', async () => {
    const result = await writeRollingSeal(opts());
    if (result.kind !== 'written') throw new Error('expected written');

    const sig = hexToBytes(await fs.readFile(result.sigPath, 'utf8'));
    const msg = new TextEncoder().encode(result.canonicalJson);
    expect(await ed.verifyAsync(sig, msg, hexToBytes(keypair.publicKeyHex))).toBe(true);
  });

  it('does not verify against a DIFFERENT session key', async () => {
    const other = await generateSessionKeypair();
    const result = await writeRollingSeal(opts());
    if (result.kind !== 'written') throw new Error('expected written');

    const sig = hexToBytes(result.signatureHex);
    const msg = new TextEncoder().encode(result.canonicalJson);
    expect(await ed.verifyAsync(sig, msg, hexToBytes(other.publicKeyHex))).toBe(false);
  });

  it('signs the JCS-canonical bytes, so re-canonicalizing the parsed object verifies', async () => {
    // This is exactly what check 1 does: it canonicalizes the PARSED manifest,
    // not the raw file bytes. If the writer ever emitted non-canonical JSON the
    // signature would still verify here but fail in the analyzer.
    const result = await writeRollingSeal(opts());
    if (result.kind !== 'written') throw new Error('expected written');

    const reCanonical = canonicalize(JSON.parse(await fs.readFile(result.manifestPath, 'utf8')));
    expect(reCanonical).toBe(result.canonicalJson);
    expect(
      await ed.verifyAsync(
        hexToBytes(result.signatureHex),
        new TextEncoder().encode(reCanonical),
        hexToBytes(keypair.publicKeyHex),
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Atomicity.
  // -------------------------------------------------------------------------

  it('leaves no .tmp files behind on success', async () => {
    await writeRollingSeal(opts());
    await writeRollingSeal(opts());

    const leftovers = (await fs.readdir(provenanceDir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('a rename failure leaves no partial artifact and no temp file', async () => {
    const failingFs = {
      open: fs.open,
      rename: async (): Promise<void> => {
        throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' });
      },
      unlink: fs.unlink,
    };

    const result = await writeRollingSeal(opts({ _fs: failingFs }));
    expect(result.kind).toBe('error');

    const entries = await fs.readdir(provenanceDir);
    expect(entries.filter((f) => f.startsWith('manifest-'))).toEqual([]);
    expect(entries.filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a failed rewrite leaves the PREVIOUS seal intact rather than a half-written one', async () => {
    const good = await writeRollingSeal(opts());
    if (good.kind !== 'written') throw new Error('expected written');

    await fs.appendFile(slogPath, '{"seq":1}\n', 'utf8');
    const failingFs = {
      open: fs.open,
      rename: async (): Promise<void> => {
        throw new Error('ENOSPC: simulated');
      },
      unlink: fs.unlink,
    };
    expect((await writeRollingSeal(opts({ _fs: failingFs }))).kind).toBe('error');

    // The old pair is still on disk, still self-consistent, still verifiable.
    const json = await fs.readFile(good.manifestPath, 'utf8');
    const sigHex = await fs.readFile(good.sigPath, 'utf8');
    expect(json).toBe(good.canonicalJson);
    expect(
      await ed.verifyAsync(
        hexToBytes(sigHex),
        new TextEncoder().encode(json),
        hexToBytes(keypair.publicKeyHex),
      ),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Git moving the ground underneath a live session.
  // -------------------------------------------------------------------------

  it('returns an error instead of throwing when .provenance/ disappears mid-session', async () => {
    await fs.rm(provenanceDir, { recursive: true, force: true });

    const result = await writeRollingSeal(opts());
    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toMatch(/ENOENT/);
  });

  it('does NOT recreate a .provenance/ that git removed', async () => {
    await fs.rm(provenanceDir, { recursive: true, force: true });
    await writeRollingSeal(opts());

    // Resurrecting the directory would leave a manifest sealing a .slog that is
    // no longer there — a `no_session_log` defect manufactured by the writer.
    await expect(fs.stat(provenanceDir)).rejects.toThrow(/ENOENT/);
  });

  it('still seals when the .slog it names has been deleted underneath it', async () => {
    await fs.rm(slogPath);
    await fs.rm(`${slogPath}.meta`);

    const result = await writeRollingSeal(opts());
    expect(result.kind).toBe('written');
    if (result.kind !== 'written') return;

    // sha256 of empty bytes — a well-formed 64-hex hash, matching the classic
    // seal's own defensive fallback, rather than a crash or an unwritable seal.
    const manifest = JSON.parse(result.canonicalJson) as {
      sessions: Array<{ slog_sha256: string; meta_sha256: string }>;
    };
    expect(manifest.sessions[0]!.slog_sha256).toBe(sha256Hex(''));
    expect(manifest.sessions[0]!.meta_sha256).toBe(sha256Hex(''));
  });

  it('survives a prior manifest being deleted between rewrites', async () => {
    const first = await writeRollingSeal(opts());
    if (first.kind !== 'written') throw new Error('expected written');

    // e.g. a `git checkout` of a branch that predates this session.
    await fs.rm(first.manifestPath);
    await fs.rm(first.sigPath);

    const second = await writeRollingSeal(opts());
    expect(second.kind).toBe('written');
    if (second.kind !== 'written') return;
    expect(await fs.readFile(second.manifestPath, 'utf8')).toBe(second.canonicalJson);
  });

  it('overwrites a prior manifest that git replaced with foreign content', async () => {
    const first = await writeRollingSeal(opts());
    if (first.kind !== 'written') throw new Error('expected written');

    await fs.writeFile(first.manifestPath, 'not json at all', 'utf8');
    await fs.writeFile(first.sigPath, 'nope', 'utf8');

    const second = await writeRollingSeal(opts());
    expect(second.kind).toBe('written');
    if (second.kind !== 'written') return;
    expect(await fs.readFile(second.manifestPath, 'utf8')).toBe(second.canonicalJson);
    expect(await fs.readFile(second.sigPath, 'utf8')).toBe(second.signatureHex);
  });

  // -------------------------------------------------------------------------
  // The `final` marker. Only dispose() passes it, and passing it promotes the
  // reader from prefix to whole-file semantics — so what this module owes is
  // that the field lands inside the SIGNED bytes and is absent otherwise.
  // -------------------------------------------------------------------------

  describe('the `final` marker', () => {
    it('omits `final` entirely by default', async () => {
      // Every roll but the last: session start and each checkpoint. The bytes
      // must be exactly what 1.2 emitted before the field existed, because two
      // other recorder implementations verify against them.
      const result = await writeRollingSeal(opts());
      expect(result.kind).toBe('written');
      if (result.kind !== 'written') return;

      expect(result.canonicalJson).not.toContain('final');
      expect(JSON.parse(result.canonicalJson)).not.toHaveProperty('final');
    });

    it('omits `final` when explicitly passed false, rather than writing it', async () => {
      const result = await writeRollingSeal(opts({ final: false }));
      if (result.kind !== 'written') throw new Error('expected written');
      expect(result.canonicalJson).not.toContain('final');
    });

    it('writes `final: true` when asked, and keeps the rolling-seal rules', async () => {
      const result = await writeRollingSeal(opts({ final: true }));
      expect(result.kind).toBe('written');
      if (result.kind !== 'written') return;

      const parsed = JSON.parse(result.canonicalJson) as unknown;
      const shape = validateBundleManifestShape(parsed);
      expect(shape.ok).toBe(true);
      if (!shape.ok) return;

      expect(shape.value.final).toBe(true);
      // Still exactly one session, still bound to its filename.
      expect(validateRollingSessionManifest(shape.value, SESSION_A).ok).toBe(true);
    });

    it('signs the marker: the on-disk signature covers `final`', async () => {
      const result = await writeRollingSeal(opts({ final: true }));
      if (result.kind !== 'written') throw new Error('expected written');

      const json = await fs.readFile(result.manifestPath, 'utf8');
      const sigHex = await fs.readFile(result.sigPath, 'utf8');
      const pubkey = hexToBytes(keypair.publicKeyHex);

      // As written, it verifies.
      expect(await ed.verifyAsync(hexToBytes(sigHex), new TextEncoder().encode(json), pubkey)).toBe(
        true,
      );

      // Strip the marker to downgrade the seal back to a prefix commitment,
      // keeping the signature. This must not verify — otherwise a student could
      // delete one word and re-open the append hole.
      const downgraded = JSON.parse(json) as Record<string, unknown>;
      delete downgraded['final'];
      const downgradedJson = canonicalize(downgraded);
      expect(downgradedJson).not.toBe(json);
      expect(
        await ed.verifyAsync(hexToBytes(sigHex), new TextEncoder().encode(downgradedJson), pubkey),
      ).toBe(false);
    });

    it('changes nothing else about the manifest', async () => {
      // `final` is the only difference between the two, so a diff of the
      // canonical bytes is exactly one key. Anything else would mean the
      // dispose-time seal quietly disagrees with the checkpoint seals.
      await fs.writeFile(path.join(assignmentRoot, 'hw.py'), 'print(1)\n', 'utf8');

      const nonFinal = await writeRollingSeal(opts());
      const isFinal = await writeRollingSeal(opts({ final: true }));
      if (nonFinal.kind !== 'written' || isFinal.kind !== 'written') {
        throw new Error('expected written');
      }

      const a = JSON.parse(nonFinal.canonicalJson) as Record<string, unknown>;
      const b = JSON.parse(isFinal.canonicalJson) as Record<string, unknown>;
      expect(b['final']).toBe(true);
      delete b['final'];
      expect(canonicalize(b)).toBe(canonicalize(a));
    });
  });

  // -------------------------------------------------------------------------
  // Path scope (task 13) — the rolling seal must resolve the same scope the
  // classic seal does, or a git-submitted, folder-scoped course gets a
  // rolling manifest that lists nothing at all.
  // -------------------------------------------------------------------------

  describe('path scope at rolling-seal time', () => {
    it('seals rule-matched files, so a folder-scoped course is not sealed empty', async () => {
      await fs.mkdir(path.join(assignmentRoot, 'src'), { recursive: true });
      await fs.writeFile(path.join(assignmentRoot, 'src/Main.java'), 'class Main {}', 'utf8');
      await fs.writeFile(path.join(assignmentRoot, 'src/A.class'), 'BINARY', 'utf8');
      await fs.mkdir(path.join(assignmentRoot, 'logs'), { recursive: true });
      await fs.writeFile(path.join(assignmentRoot, 'logs/run.log'), 'output', 'utf8');

      const result = await writeRollingSeal(
        opts({ scope: { track: ['src/'], ignore: ['*.class'], attachments: ['logs/'] } }),
      );
      expect(result.kind).toBe('written');
      if (result.kind !== 'written') return;

      const manifest = JSON.parse(result.canonicalJson) as {
        submission_files: Array<{ path: string; status: string; role?: string }>;
      };
      const byPath = new Map(manifest.submission_files.map((f) => [f.path, f]));
      expect(byPath.get('src/Main.java')?.role).toBe('reviewed');
      expect(byPath.get('logs/run.log')?.role).toBe('attachment');
      expect(byPath.has('src/A.class')).toBe(false);
    });

    it('marks an absent EXACT entry missing and says nothing about rule entries', async () => {
      await fs.writeFile(path.join(assignmentRoot, 'Present.java'), 'x', 'utf8');

      const result = await writeRollingSeal(
        opts({ scope: { track: ['*.java', 'Required.java'], ignore: [], attachments: [] } }),
      );
      if (result.kind !== 'written') throw new Error('expected written');

      const manifest = JSON.parse(result.canonicalJson) as {
        submission_files: Array<{ path: string; status: string }>;
      };
      expect(
        manifest.submission_files.filter((f) => f.status === 'missing').map((f) => f.path),
      ).toEqual(['Required.java']);
    });

    it('omits scope_capped when the cap did not bite', async () => {
      await fs.writeFile(path.join(assignmentRoot, 'a.java'), 'x', 'utf8');

      const result = await writeRollingSeal(
        opts({ scope: { track: ['*.java'], ignore: [], attachments: [] }, scopeCapped: false }),
      );
      if (result.kind !== 'written') throw new Error('expected written');
      expect('scope_capped' in JSON.parse(result.canonicalJson)).toBe(false);
    });

    it('includes scope_capped: true when the cap did bite', async () => {
      const result = await writeRollingSeal(
        opts({ scope: { track: ['a.java'], ignore: [], attachments: [] }, scopeCapped: true }),
      );
      if (result.kind !== 'written') throw new Error('expected written');
      const manifest = JSON.parse(result.canonicalJson) as { scope_capped?: boolean };
      expect(manifest.scope_capped).toBe(true);
    });

    it('never seals a hard-excluded path, however greedy the scope', async () => {
      await fs.mkdir(path.join(assignmentRoot, '.git'), { recursive: true });
      await fs.writeFile(path.join(assignmentRoot, '.git/config'), 'x', 'utf8');
      await fs.writeFile(path.join(assignmentRoot, 'ok.txt'), 'x', 'utf8');

      const result = await writeRollingSeal(
        opts({ scope: { track: ['*'], ignore: [], attachments: [] } }),
      );
      if (result.kind !== 'written') throw new Error('expected written');

      const manifest = JSON.parse(result.canonicalJson) as {
        submission_files: Array<{ path: string }>;
      };
      const paths = manifest.submission_files.map((f) => f.path);
      expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
      expect(paths.some((p) => p.startsWith('.provenance/'))).toBe(false);
      expect(paths).toContain('ok.txt');
    });

    it('drops (never reports missing) a walk-sighted rule-matched file it cannot read', async () => {
      // The classic seal's structural property, round-tripped: a rule entry
      // asserts nothing about any particular file's existence, so a
      // walk-discovered file the read step cannot open is silently DROPPED,
      // not `missing`. Unlike deleting the file before the walk runs (which
      // the walk never sights at all, and so proves nothing about the drop
      // logic — that shape was this test's bug in fix round 1), a chmod
      // leaves the directory entry intact: `walkWorkspace` sights it and
      // role-resolves it to `reviewed`, and only the later `readFile` fails
      // (EACCES, not ENOENT), which is what this test actually needs to
      // exercise the drop path rather than trivially pass against an
      // untouched workspace.
      const dir = path.join(assignmentRoot, 'gone');
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, 'File.java');
      await fs.writeFile(filePath, 'x', 'utf8');
      await fs.chmod(filePath, 0o000);

      try {
        const result = await writeRollingSeal(
          opts({ scope: { track: ['*.java'], ignore: [], attachments: [] } }),
        );
        if (result.kind !== 'written') throw new Error('expected written');

        const manifest = JSON.parse(result.canonicalJson) as {
          submission_files: Array<{ path: string; status: string }>;
        };
        // Dropped entirely — neither `present` nor `missing`.
        expect(manifest.submission_files.some((f) => f.path === 'gone/File.java')).toBe(false);
        expect(manifest.submission_files.some((f) => f.status === 'missing')).toBe(false);
      } finally {
        await fs.chmod(filePath, 0o644);
      }
    });
  });
});
