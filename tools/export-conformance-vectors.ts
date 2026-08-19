/**
 * Export language-neutral conformance vectors from log-core (+ a golden bundle from
 * analysis-core's test-support builder) for the provenance-jetbrains-recorder repo's
 * `core/` conformance suite to consume.
 *
 * This is the single generated source of truth for cross-language format parity. The
 * JetBrains recorder is a second implementation of log-core's format; its `core/` tests
 * read these vectors and assert byte-for-byte agreement. If log-core's format or crypto
 * framing ever changes, re-running this script and re-committing its output in the
 * JetBrains repo is how the change propagates — never hand-edit a vector over there.
 *
 * The values here are pinned to the exact fixed keys the JetBrains repo's ConformanceTest
 * already expects (ed25519 seeds are all-`0x07`/`0x09`/`0x03`/`0x04`/`0x05` fills; HKDF
 * salt/nonce are fixed `0x11`/`0x22` fills), so regenerating reproduces the committed
 * fixtures byte-for-byte — the drift check that proves this export is faithful to the
 * hand-authored originals.
 *
 * Two independent vector families, selected by flag:
 *
 *   --out           log-core FORMAT vectors: hash chain, ed25519, session key, manifests,
 *                   checkpoint, golden bundle, plus the Manifest 2.0 family (course cert,
 *                   manifest-v2, capture policy). Consumed by JetBrains `core/` and by the
 *                   Neovim `tests/conformance/fixtures/`.
 *   --recorder-out  recorder PAYLOAD-BUILDER vectors: the paste and fs.external_change
 *                   inline-content builders. These pin the inline/truncate cap (64 KB of
 *                   UTF-8) and the deliberate unit mismatch between the byte-based gate
 *                   and the code-unit-based head/tail slice.
 *
 * At least one flag is required; both may be given. Directories are created if missing
 * and same-named files are overwritten — this script owns those contents.
 *
 * USAGE
 *   node --experimental-strip-types tools/export-conformance-vectors.ts --out <dir>
 *
 * Examples (writing directly into the sibling repos on this machine):
 *   node --experimental-strip-types tools/export-conformance-vectors.ts \
 *     --out ../provenance-jetbrains-recorder/core/src/test/resources/conformance
 *
 *   node --experimental-strip-types tools/export-conformance-vectors.ts \
 *     --recorder-out ../provenance-jetbrains-recorder/recorder/src/test/resources/conformance
 *
 *   node --experimental-strip-types tools/export-conformance-vectors.ts \
 *     --out ../provenance-neovim-recorder/tests/conformance/fixtures \
 *     --recorder-out ../provenance-neovim-recorder/tests/conformance/fixtures
 *
 * Requires `npm run build` for log-core, analysis-core, and (for --recorder-out) recorder.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ed from '@noble/ed25519';
import { sha512, sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  sha256Hex,
  chainEntry,
  GENESIS_PREV_HASH,
  signManifest,
  signBundleManifest,
  signCheckpoint,
  canonicalize,
  parseManifest,
  verifyManifest,
  verifyManifestChain,
  signCourseCert,
  verifyCourseCert,
  checkCertWindow,
  buildCourseCertSignedPayload,
  parseIsoInstantMs,
  resolveCapturePolicy,
  DEFAULT_CAPTURE_POLICY,
  FLOOR_EVENT_KINDS,
  POLICY_GATED_EVENT_KINDS,
  HEARTBEAT_INTERVAL_MIN_MS,
  HEARTBEAT_INTERVAL_MAX_MS,
} from '@provenance/log-core';
import type { CourseCert, Manifest } from '@provenance/log-core';
import { buildTestBundle } from '@provenance/analysis-core/test-support/build-test-bundle.js';
// The recorder's SHIPPED builders, from its build output — deriving the vectors
// from the real code is the whole point. Requires
// `npm run build --workspace=packages/recorder` first.
import { buildExternalChangeContent } from '../packages/recorder/dist/events/external-change-content.js';
import { buildPastePayload } from '../packages/recorder/dist/events/paste-payload.js';

// Wire sha512 for @noble/ed25519 (same pattern as log-core's own callers).
ed.hashes.sha512 = sha512;
(ed.hashes as Record<string, unknown>)['sha512Async'] = (m: Uint8Array) =>
  Promise.resolve(sha512(m));

const toHex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const fromHex = (h: string): Uint8Array => new Uint8Array(Buffer.from(h, 'hex'));
const seed = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const pub = async (priv: Uint8Array): Promise<string> => toHex(await ed.getPublicKeyAsync(priv));

function parseArgs(argv: string[]): { out: string | null; recorderOut: string | null } {
  const flag = (name: string): string | null => {
    const idx = argv.indexOf(name);
    if (idx === -1) return null;
    const value = argv[idx + 1];
    if (!value) {
      console.error(`${name} requires a directory argument`);
      process.exit(1);
    }
    return value;
  };

  const out = flag('--out');
  const recorderOut = flag('--recorder-out');

  if (out === null && recorderOut === null) {
    console.error(
      'usage: export-conformance-vectors.ts [--out <dir>] [--recorder-out <dir>]\n' +
        '  --out           log-core format vectors (hash chain, ed25519, manifests, golden bundle)\n' +
        '  --recorder-out  recorder payload-builder vectors (paste + fs.external_change content)\n' +
        'At least one is required; both may be given.',
    );
    process.exit(1);
  }
  return { out, recorderOut };
}

function writeJson(outDir: string, name: string, value: unknown): void {
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Recorder payload-builder vectors
// ---------------------------------------------------------------------------

/**
 * Inputs for the recorder's two content builders. These are the cross-language
 * contract: all three recorders must produce byte-identical payloads for them.
 *
 * Two independent things are being pinned, and the emoji/€ cases exist because
 * only multi-byte text can tell them apart:
 *
 *   1. THE GATE VALUE. Inline vs truncate is decided on UTF-8 BYTE length
 *      against MAX_INLINE_BYTES (64 KB, raised from 4 KB). The 8 KB case sits
 *      between the old and new caps and expects INLINE, so an implementation
 *      still using 4096 fails it immediately.
 *   2. THE UNIT MISMATCH. The gate is bytes, but the head/tail SLICE is UTF-16
 *      code units, so truncation can never split a codepoint. An implementation
 *      that measures the gate in characters, or slices by bytes, fails here.
 *
 * '😀' is 4 UTF-8 bytes / 2 UTF-16 code units; '€' is 3 bytes / 1 code unit.
 * Both are included because they fail differently under a byte/char mixup.
 *
 * Size note: the at-boundary cases are inherently ~64 KB of input each, which
 * is why this list is deliberately short. Every large case earns its place.
 */
function recorderContentInputs(): Array<{ note: string; input: string }> {
  const EMOJI = '😀'; // 4 UTF-8 bytes, 2 UTF-16 code units
  const EURO = '€'; // 3 UTF-8 bytes, 1 UTF-16 code unit
  const CAP = 64 * 1024;

  return [
    { note: 'ascii, small: inlined', input: 'hello world' },
    { note: 'empty string: inlined as ""', input: '' },
    {
      note: 'multibyte, small: inlined; size is UTF-8 bytes, not codepoints',
      input: '日本語のテキストです。これはテストです。',
    },
    {
      note: 'multibyte, 8 KB: between the old 4 KB cap and the new 64 KB cap, so this INLINES. An implementation still gated at 4096 truncates here and fails.',
      input: EMOJI.repeat(2048), // 8192 bytes, 4096 code units
    },
    {
      note: 'multibyte, EXACTLY at the 64 KB cap in bytes (boundary inclusive → inlines). Only 32768 code units, so a char-based gate would also inline — the next case is what separates them.',
      input: EMOJI.repeat(CAP / 4), // 65536 bytes, 32768 code units
    },
    {
      note: 'multibyte, ONE codepoint past the cap in bytes → truncates. Still only 32770 code units, far under 65536, so a char-based gate wrongly inlines and fails.',
      input: EMOJI.repeat(CAP / 4 + 1), // 65540 bytes, 32770 code units
    },
    {
      note: '3-byte characters past the cap, with distinct head/tail markers: pins that the slice is by code unit and that head/tail are taken from the right ends.',
      input: `HEAD-${EURO.repeat(CAP / 3)}-TAIL`, // > 64 KB, 1 code unit per char
    },
  ];
}

/**
 * Emit the recorder payload-builder conformance fixtures.
 *
 * Both files are arrays of { note, input, expected }. `expected` omits fields
 * the builder leaves undefined, so a consumer comparing all fields (including
 * absent ones) sees null/nil on both sides.
 *
 * Deterministic by construction: fixed inputs, no clock, no randomness, no
 * iteration over unordered collections. Running this twice produces identical
 * bytes.
 */
function writeRecorderVectors(outDir: string): void {
  const inputs = recorderContentInputs();

  writeJson(
    outDir,
    'external-change-content.json',
    inputs.map(({ note, input }) => ({
      note,
      input,
      expected: buildExternalChangeContent(input),
    })),
  );

  writeJson(
    outDir,
    'paste-payload.json',
    inputs.map(({ note, input }) => ({
      note,
      input,
      expected: buildPastePayload(input),
    })),
  );
}

// ---------------------------------------------------------------------------
// Manifest 2.0 vectors (program spec §2–§4)
// docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md
// ---------------------------------------------------------------------------

/**
 * Fixed key seeds for the 2.0 families. Chosen not to collide with the seeds the
 * 1.x vectors already use (0x03/0x04/0x05/0x07/0x09), so adding these cannot
 * perturb a byte of the existing output.
 */
const ROOT_PRIV = seed(0x0a);
const COURSE_PRIV = seed(0x0b);
const WRONG_ROOT_PRIV = seed(0x0c);
const OTHER_COURSE_PRIV = seed(0x0d);

const CERT_VALID_FROM = '2026-08-20';
const CERT_VALID_UNTIL = '2027-01-15';
const COURSE_ID = 'berkeley-cs61b';

/** The `policy` block used by every 2.0 manifest vector. */
const V2_POLICY = {
  capture: {
    selection_change: true,
    focus_change: true,
    terminal: true,
    doc_open_close: true,
    inline_content: true,
    heartbeat_interval_ms: 30000,
  },
};

type UnsignedCert = Omit<CourseCert, 'root_sig'>;

async function makeCert(
  overrides: Partial<UnsignedCert> = {},
  rootPriv: Uint8Array = ROOT_PRIV,
): Promise<CourseCert> {
  const unsigned: UnsignedCert = {
    course_id: COURSE_ID,
    course_pubkey: await pub(COURSE_PRIV),
    valid_from: CERT_VALID_FROM,
    valid_until: CERT_VALID_UNTIL,
    ...overrides,
  };
  return { ...unsigned, root_sig: await signCourseCert(unsigned, rootPriv) };
}

/**
 * Vectors for `verifyCourseCert` (chain step 1) and `checkCertWindow` (step 4).
 *
 * `canonical_json` is the exact byte string the ROOT key signed — the single
 * most useful value for a port, because a canonicalization disagreement shows up
 * here rather than as an inscrutable signature failure.
 */
async function buildCourseCertVectors(): Promise<unknown> {
  const rootPubkeyHex = await pub(ROOT_PRIV);
  const wrongRootPubkeyHex = await pub(WRONG_ROOT_PRIV);

  const validCert = await makeCert();
  const certSignedByWrongRoot = await makeCert({}, WRONG_ROOT_PRIV);

  // Tampered AFTER signing: the sig is genuine but no longer covers the bytes.
  const tamperedCourseId: CourseCert = { ...validCert, course_id: 'berkeley-cs61c' };
  const tamperedValidUntil: CourseCert = { ...validCert, valid_until: '2099-01-01' };

  const verifyCase = async (
    name: string,
    note: string,
    cert: CourseCert,
    pubkeyHex: string,
  ): Promise<unknown> => ({
    name,
    note,
    input: { cert, root_pubkey_hex: pubkeyHex },
    expected: { valid: (await verifyCourseCert(cert, pubkeyHex)).ok },
  });

  const windowCase = (name: string, note: string, cert: CourseCert, issuedAt: string): unknown => ({
    name,
    note,
    input: {
      valid_from: cert.valid_from,
      valid_until: cert.valid_until,
      issued_at: issuedAt,
    },
    expected: checkCertWindow(cert, issuedAt),
  });

  const ancient = await makeCert({ valid_from: '1999-01-01', valid_until: '1999-12-31' });

  return {
    note:
      'Course-certificate conformance vectors (program spec §2/§3). The ROOT key signs ' +
      'the cert MINUS root_sig; log-core never hardcodes the root public key, it is always ' +
      'a parameter, so a port must accept it as one too. All keys in the signed payload are ' +
      'fixed ASCII identifiers: a non-ASCII key would sort differently under a bytewise Lua ' +
      'JCS than under a UTF-16 code-unit JS/Kotlin JCS and silently break cross-verification.',
    root_pubkey_hex: rootPubkeyHex,
    wrong_root_pubkey_hex: wrongRootPubkeyHex,
    course_pubkey_hex: await pub(COURSE_PRIV),
    valid_cert: validCert,
    canonical_json: new TextDecoder().decode(buildCourseCertSignedPayload(validCert)),
    verify_cases: [
      await verifyCase(
        'valid',
        'Genuine cert under the matching root key.',
        validCert,
        rootPubkeyHex,
      ),
      await verifyCase(
        'bad_root_sig',
        'Cert signed by a DIFFERENT root key. Chain step 1 must fail; do not activate.',
        certSignedByWrongRoot,
        rootPubkeyHex,
      ),
      await verifyCase(
        'root_key_is_a_parameter',
        'The same cert verifies under whichever root actually signed it — proof the root key is never hardcoded.',
        certSignedByWrongRoot,
        wrongRootPubkeyHex,
      ),
      await verifyCase(
        'tampered_course_id',
        'course_id edited after signing. The cert is what binds a course key to a course id, so this must fail.',
        tamperedCourseId,
        rootPubkeyHex,
      ),
      await verifyCase(
        'tampered_valid_until',
        'Window extended after signing — the classic "make my expired cert live forever" edit.',
        tamperedValidUntil,
        rootPubkeyHex,
      ),
    ],
    timestamp_note:
      'The exact accepting set of the timestamp parser, spelled out because the three ' +
      'implementations have wildly different date libraries and must agree. Grammar: ' +
      'YYYY-MM-DD optionally followed by THH:MM:SS, optional .fraction (padded/truncated to ' +
      'milliseconds), optional Z or +/-HH:MM. Date-only means UTC midnight; a missing offset ' +
      'means UTC. Non-existent calendar dates are REJECTED, not rolled forward — JS Date ' +
      'would turn 2026-02-31 into 2026-03-03, and java.time would throw, so the parser ' +
      'normalises that difference away by rejecting. expected_ms is null for a rejection.',
    timestamp_parse_cases: [
      '2026-08-20',
      '2026-09-08T12:34:56Z',
      '2026-09-08T00:00:00',
      '2026-09-08T00:00:00.5Z',
      '2026-09-08T00:00:00.123456Z',
      '2026-09-08T02:00:00+02:00',
      '2026-09-07T21:00:00-03:00',
      '2028-02-29',
      '0026-09-08',
      '2026-02-31',
      '2027-02-29',
      '2026-13-01',
      '2026-09-32',
      '2026-09-08T25:00:00Z',
      '2026-09-08 00:00:00Z',
      '2026-12-31T23:59:60Z',
      '2026-09-08T24:00:00Z',
      '2026-09-08T00:00:00+99:00',
      '2026-09-08T00:00:00+23:59',
      '2026/09/08',
      '20260908',
      'not a date',
      '',
    ].map((input) => ({ input, expected_ms: parseIsoInstantMs(input) })),

    window_note:
      'The window is evaluated against manifest.issued_at, NEVER against wall-clock now: a Fall ' +
      '2026 bundle must still verify in 2028 for an adjudication case. Both bounds are ' +
      'INCLUSIVE, but a date-only bound resolves asymmetrically: valid_from is the FIRST ' +
      'instant of that day (UTC midnight), while valid_until is inclusive THROUGH THE END of ' +
      'that day — "valid until 2027-01-15" covers all of the 15th and expires at the first ' +
      'instant of the 16th. A full-timestamp bound at either end means exactly that instant, ' +
      'unaffected by the date-only extension. An out-of-window result is NOT fatal — it never ' +
      'invalidates a signature; the caller decides.',
    window_cases: [
      windowCase('inside', 'Ordinary mid-semester manifest.', validCert, '2026-09-08T00:00:00Z'),
      windowCase('at_valid_from', 'Lower bound is inclusive.', validCert, '2026-08-20T00:00:00Z'),
      windowCase(
        'at_valid_until',
        'The first instant of the final day is inside the window.',
        validCert,
        '2027-01-15T00:00:00Z',
      ),
      windowCase(
        'late_on_valid_until_day',
        'MANDATORY. The last millisecond of the final day is still inside the window: a ' +
          'date-only valid_until is inclusive through end-of-day, not just its first instant. ' +
          'This is the boundary the inclusive-end-of-day rule exists to move.',
        validCert,
        '2027-01-15T23:59:59.999Z',
      ),
      windowCase(
        'day_after_valid_until',
        'MANDATORY. The first instant of the day AFTER a date-only valid_until is out of ' +
          'window — the exact millisecond the inclusive-end-of-day rule draws the line at.',
        validCert,
        '2027-01-16T00:00:00Z',
      ),
      windowCase(
        'before_valid_from',
        'One second before the window opens.',
        validCert,
        '2026-08-19T23:59:59Z',
      ),
      windowCase(
        'after_valid_until',
        'Comfortably past the window, weeks after the last covered day. Non-fatal: the ' +
          'recorder still records and stamps the expiry.',
        validCert,
        '2027-02-01T00:00:00Z',
      ),
      windowCase(
        'expired_long_ago_but_contemporaneous',
        'Cert lapsed decades ago in wall-clock terms, yet the manifest was issued inside it. Must be in_window — this is the test that catches an implementation using now() instead of issued_at.',
        ancient,
        '1999-06-15T00:00:00Z',
      ),
      windowCase(
        'unparseable_issued_at',
        'Reported distinctly rather than guessed at.',
        validCert,
        'sometime last fall',
      ),
    ],
  };
}

/**
 * Vectors for Manifest 2.0 parsing and `verifyManifestChain`.
 *
 * The two highest-value entries here are `legacy_no_format_version` (a missing
 * `format_version` MUST default to '1.0' and parse, or every archived submission
 * breaks) and the `course_id_mismatch` case (both signatures verify and the
 * manifest is still a forgery).
 */
async function buildManifestV2Vectors(): Promise<unknown> {
  const rootPubkeyHex = await pub(ROOT_PRIV);
  const coursePubkeyHex = await pub(COURSE_PRIV);
  const cert = await makeCert();

  const makeManifest = async (
    overrides: Partial<Manifest> = {},
    coursePriv: Uint8Array = COURSE_PRIV,
  ): Promise<Manifest> => {
    const unsigned: Omit<Manifest, 'sig'> = {
      format_version: '2.0',
      course_id: COURSE_ID,
      assignment_id: 'proj2',
      semester: 'fa26',
      issued_at: '2026-09-08T00:00:00Z',
      files_under_review: ['src/Main.java'],
      collaboration: 'solo',
      submission: 'bundle',
      scope: 'directory',
      policy: V2_POLICY,
      course_cert: cert,
      ...overrides,
    };
    return { ...unsigned, sig: await signManifest(unsigned, coursePriv) };
  };

  const valid = await makeManifest();

  // Genuine cert, genuine course signature — and still a forgery, because the
  // manifest claims a course the cert does not cover.
  const courseIdMismatch = await makeManifest({ course_id: 'berkeley-cs61c' });
  // Signed by a course key the cert does not vouch for.
  const wrongCourseKey = await makeManifest({}, OTHER_COURSE_PRIV);
  // Payload edited after signing.
  const tamperedPayload: Manifest = { ...valid, files_under_review: ['src/Sneaky.java'] };
  // Cert not signed by the root.
  const badRootSig = await makeManifest({ course_cert: await makeCert({}, WRONG_ROOT_PRIV) });
  // Issued after the cert lapsed: chain still OK, window reports the expiry.
  const expiredWindow = await makeManifest({ issued_at: '2027-06-01T00:00:00Z' });

  const chainOutcome = (
    result: Awaited<ReturnType<typeof verifyManifestChain>>,
  ): Record<string, unknown> => {
    if (result.ok) {
      return { ok: true, course_id: result.value.course_id, window: result.value.window };
    }
    return { ok: false, ...result.error };
  };

  const chainCase = async (name: string, note: string, manifest: Manifest): Promise<unknown> => ({
    name,
    note,
    input: { manifest, root_pubkey_hex: rootPubkeyHex },
    expected: chainOutcome(await verifyManifestChain(manifest, rootPubkeyHex)),
  });

  // A 1.x manifest — no format_version field at all. Reuses the exact fields and
  // course key already pinned by manifest.json, so the sig below is the SAME hex
  // that file has always carried.
  const legacyFields = {
    assignment_id: 'hw3',
    semester: 'fa25',
    issued_at: '2026-07-14T00:00:00Z',
    files_under_review: ['src/main.py', 'src/util.py'],
  };
  const legacyManifest = { ...legacyFields, sig: await signManifest(legacyFields, seed(9)) };
  const legacyParsed = parseManifest(JSON.stringify(legacyManifest));

  // The 1.x downgrade attack, built with NO private key: a genuinely 61B-signed
  // 1.x manifest, plus 61B's real (public, copyable) certificate, plus the
  // unsigned fields a 1.x payload does not cover.
  const attackLegacyFields = {
    assignment_id: 'hw3',
    semester: 'fa25',
    issued_at: '2026-09-01T00:00:00Z',
    files_under_review: ['a.py'],
  };
  const downgradeAttack: Manifest = {
    ...attackLegacyFields,
    sig: await signManifest(attackLegacyFields, COURSE_PRIV),
    course_cert: cert,
    course_id: COURSE_ID,
    collaboration: 'group',
    submission: 'git',
    scope: 'repo',
    policy: {
      capture: {
        selection_change: false,
        focus_change: false,
        terminal: false,
        doc_open_close: false,
        inline_content: false,
        heartbeat_interval_ms: 120000,
      },
    },
  };

  return {
    note:
      'Manifest 2.0 conformance vectors (program spec §3). Two independent signature scopes ' +
      'live in one file: a COURSE-signed payload and a ROOT-signed course_cert that ' +
      'authorizes the course key. buildSignedPayload excludes sig AND course_cert — the ' +
      'course does not sign its own certificate.',
    root_pubkey_hex: rootPubkeyHex,
    course_pubkey_hex: coursePubkeyHex,
    other_course_pubkey_hex: await pub(OTHER_COURSE_PRIV),

    legacy_no_format_version: {
      note:
        'MANDATORY. A 1.x manifest has no format_version field, so 1.x is identified by its ' +
        'ABSENCE. A parser MUST default a missing format_version to "1.0" and parse ' +
        'successfully — never reject. Rejecting it would break every archived submission, ' +
        'which is precisely the adjudication case this whole program exists to serve. ' +
        'The sig below is byte-identical to the one in manifest.json: adding the 2.0 fields ' +
        'did not move the 1.x signed payload by a single byte.',
      manifest_json: JSON.stringify(legacyManifest),
      course_pubkey_hex: await pub(seed(9)),
      canonical_json: canonicalize(legacyFields),
      expected: {
        parses: legacyParsed.ok,
        format_version: legacyParsed.ok ? legacyParsed.value.format_version : null,
        sig_verifies: (await verifyManifest(legacyManifest, await pub(seed(9)))).ok,
      },
    },

    legacy_explicit_1_0: {
      note:
        'An explicit format_version of "1.0" canonicalizes to the same four legacy fields — ' +
        'format_version itself is NOT in the 1.x signed payload. Same sig as above.',
      manifest: { ...legacyManifest, format_version: '1.0' },
      expected: { sig: await signManifest({ ...legacyFields, format_version: '1.0' }, seed(9)) },
    },

    valid_2_0: {
      note:
        'A complete 2.0 manifest. canonical_json is the exact byte string the COURSE key ' +
        'signed; note the absence of both sig and course_cert. Every key is a fixed ASCII ' +
        'identifier — never a course id, path, or other user-derived string promoted to a ' +
        'key — because a bytewise-sorting Lua JCS and a UTF-16-sorting JS/Kotlin JCS agree ' +
        'only for ASCII. files_under_review is the only array in the signed payload.',
      manifest: valid,
      canonical_json: canonicalize({
        format_version: '2.0',
        course_id: COURSE_ID,
        assignment_id: 'proj2',
        semester: 'fa26',
        issued_at: '2026-09-08T00:00:00Z',
        files_under_review: ['src/Main.java'],
        collaboration: 'solo',
        submission: 'bundle',
        scope: 'directory',
        policy: V2_POLICY,
      }),
    },

    unknown_keys_ignored: await (async () => {
      const withUnknown = { ...valid, some_future_field: 'ignored', another_one: [1, 2] };
      const parsed = parseManifest(JSON.stringify(withUnknown));
      return {
        note:
          'MANDATORY. Unknown top-level keys MUST be ignored, for forward compatibility. This ' +
          'is safe precisely because canonicalization operates on the NAMED fields only, so an ' +
          'unknown key can never silently change the signed bytes — the signature below still ' +
          'verifies with the extra keys present.',
        manifest_json: JSON.stringify(withUnknown),
        expected: {
          parses: parsed.ok,
          chain: parsed.ok
            ? chainOutcome(await verifyManifestChain(parsed.value, rootPubkeyHex))
            : null,
        },
      };
    })(),

    chain_note:
      'Step 0 gates on format_version === "2.0" before anything else, and that gate is a ' +
      'SECURITY CONTROL. At 1.x, course_id / collaboration / submission / scope / policy are ' +
      'all outside the signed payload, so a student holding any genuinely-signed 1.x manifest ' +
      'from their own course can staple on that course’s (public, root-signed, copyable) ' +
      'certificate, add a matching course_id to satisfy step 3, and staple on a policy that ' +
      'disables capture — with every individual signature still verifying. See the ' +
      'downgrade_1x_with_stapled_cert case. Then: ' +
      'the four verification steps run IN THIS ORDER and the order is load-bearing: ' +
      '(1) course_cert minus root_sig against the embedded root pubkey; ' +
      '(2) payload minus sig and course_cert against course_cert.course_pubkey; ' +
      '(3) manifest.course_id === course_cert.course_id; ' +
      '(4) issued_at within [valid_from, valid_until] — non-fatal, reported not thrown.',
    chain_cases: [
      await chainCase('valid', 'Root -> cert -> manifest all agree.', valid),
      await chainCase(
        'bad_root_sig',
        'Step 1 fails: the cert is not root-signed. Do not activate.',
        badRootSig,
      ),
      await chainCase(
        'wrong_course_key',
        'Step 2 fails: signed by a course key the cert does not vouch for.',
        wrongCourseKey,
      ),
      await chainCase(
        'tampered_payload',
        'Step 2 fails: files_under_review edited after signing.',
        tamperedPayload,
      ),
      await chainCase(
        'course_id_mismatch',
        'MANDATORY. Step 3 fails. Both signatures are GENUINE: the cert really is root-signed for berkeley-cs61b, and the payload really is signed by the key that cert authorizes. Only comparing manifest.course_id to course_cert.course_id catches it. Skip step 3 and 61B’s key can forge a 61C manifest.',
        courseIdMismatch,
      ),
      await chainCase(
        'issued_at_after_valid_until',
        'Step 4. NOT an error: the chain succeeds and the expiry is reported on the result. A course letting a cert lapse mid-semester must not silently stop recording for a whole class.',
        expiredWindow,
      ),
      await chainCase(
        'not_manifest_2_0',
        'Step 0. A 1.x manifest has no trust chain by definition.',
        legacyManifest as Manifest,
      ),
      await chainCase(
        'missing_course_cert',
        'A 2.0 manifest with the cert removed.',
        (() => {
          const stripped = { ...valid };
          delete stripped.course_cert;
          return stripped;
        })(),
      ),
      await chainCase(
        'downgrade_1x_with_stapled_cert',
        'MANDATORY. Step 0. Needs no private key: a genuinely-signed 1.x manifest, plus the course’s real certificate copied out of any 2.0 manifest, plus a course_id chosen to satisfy step 3, plus an INVENTED policy that turns capture off. verifyCourseCert passes, verifyManifest passes, and course_id matches — every signature is genuine. Only the format_version gate refuses it. An implementation that walks steps 1-4 without checking the version hands students an off switch.',
        downgradeAttack,
      ),
    ],
  };
}

/**
 * Vectors for `resolveCapturePolicy` (program spec §4).
 *
 * Also exports the hard floor, which is the part a port is most likely to get
 * wrong: floor kinds have no key in `policy.capture` BY DESIGN, so the schema
 * itself is the enforcement mechanism and there is no "off" to express.
 */
function buildCapturePolicyVectors(): unknown {
  const policyCase = (name: string, note: string, input: unknown): unknown => ({
    name,
    note,
    input,
    expected: resolveCapturePolicy(input),
  });

  return {
    note:
      'Capture-policy resolution (program spec §4). The policy block lives INSIDE the ' +
      'course-signed manifest payload, which is the point: a professor can turn capture down, ' +
      'a student cannot turn it off. Every capture key is a fixed ASCII identifier and must ' +
      'stay that way — see course-cert.json for why.',
    defaults: DEFAULT_CAPTURE_POLICY,
    heartbeat_clamp: {
      min_ms: HEARTBEAT_INTERVAL_MIN_MS,
      max_ms: HEARTBEAT_INTERVAL_MAX_MS,
    },
    floor_note:
      'Event kinds that can NEVER be disabled, because validation checks 3-8 and the ' +
      'integrity story depend on them. Enforced by the SCHEMA: a floor kind simply has no key ' +
      'in policy.capture, so "off" is not expressible. session.heartbeat is on the floor ' +
      'because bundle-level Active/Idle and the gap_in_heartbeats heuristic need it — only ' +
      'its interval is tunable. paste.anomaly is on the floor by the same schema rule even ' +
      'though the program spec’s prose list omits it.',
    floor_event_kinds: [...FLOOR_EVENT_KINDS],
    policy_gated_event_kinds: POLICY_GATED_EVENT_KINDS,
    absence_vs_disabled_note:
      'The effective policy MUST travel into the bundle (it does, inside the manifest carried ' +
      'by session.start). Without it an analyzer cannot tell "this student produced no ' +
      'selection.change events" from "this course disabled selection.change", and heuristics ' +
      'mis-fire on the difference.',
    cases: [
      policyCase(
        'absent_block',
        'A 1.x manifest has no policy at all and must resolve to the v1.x capture set: everything on, 30s heartbeat.',
        null,
      ),
      policyCase('empty_block', 'A policy object with no capture key.', {}),
      policyCase('empty_capture', 'An empty capture object.', { capture: {} }),
      policyCase('all_on', 'Everything explicitly enabled.', V2_POLICY),
      policyCase('all_off', 'Every optional signal disabled. Floor kinds are unaffected.', {
        capture: {
          selection_change: false,
          focus_change: false,
          terminal: false,
          doc_open_close: false,
          inline_content: false,
        },
      }),
      policyCase(
        'partial_falls_back_per_key',
        'Only the keys the course specified move; the rest take defaults.',
        { capture: { selection_change: false } },
      ),
      policyCase(
        'unknown_key_ignored',
        'Forward compatibility: an unrecognised capture key is ignored, not an error.',
        { capture: { future_signal: true, terminal: false } },
      ),
      policyCase('heartbeat_below_floor', 'Clamped UP to 5000.', {
        capture: { heartbeat_interval_ms: 1000 },
      }),
      policyCase('heartbeat_at_floor', 'Boundary is inclusive.', {
        capture: { heartbeat_interval_ms: 5000 },
      }),
      policyCase('heartbeat_in_range', 'Passed through unchanged.', {
        capture: { heartbeat_interval_ms: 45000 },
      }),
      policyCase('heartbeat_at_ceiling', 'Boundary is inclusive.', {
        capture: { heartbeat_interval_ms: 120000 },
      }),
      policyCase('heartbeat_above_ceiling', 'Clamped DOWN to 120000.', {
        capture: { heartbeat_interval_ms: 999999 },
      }),
      policyCase('heartbeat_zero', 'Clamped up to the floor, not treated as "disabled".', {
        capture: { heartbeat_interval_ms: 0 },
      }),
      policyCase(
        'heartbeat_non_number',
        'Falls back to the DEFAULT (30000), not to the floor — clamping a non-number is meaningless and a course that wrote garbage should get the safe cadence.',
        { capture: { heartbeat_interval_ms: '10000' } },
      ),
      policyCase('non_boolean_flag', 'Falls back to the default for that key.', {
        capture: { terminal: 'off' },
      }),
    ],
  };
}

async function main(): Promise<void> {
  const { out, recorderOut } = parseArgs(process.argv.slice(2));

  if (recorderOut !== null) {
    const recorderDir = path.resolve(recorderOut);
    fs.mkdirSync(recorderDir, { recursive: true });
    writeRecorderVectors(recorderDir);
    console.log(`Wrote recorder payload vectors to ${recorderDir}`);
  }

  if (out === null) return;

  const outDir = path.resolve(out);
  fs.mkdirSync(outDir, { recursive: true });

  // --- 1. sha256 + hash-chain vectors (pinned; compact layout preserved verbatim) ---
  const chainEnvelope = {
    seq: 0,
    t: 0,
    wall: '2026-01-01T00:00:00.000Z',
    kind: 'session.end',
    data: { reason: 'test' },
  };
  const vectorsText = `{
  "source": "log-core hash-chain.test.ts (pinned)",
  "sha256": [
    { "input": "hello world", "hex": "${sha256Hex('hello world')}" },
    { "input": "", "hex": "${sha256Hex('')}" }
  ],
  "chain": [
    {
      "prev_hash": "${GENESIS_PREV_HASH}",
      "envelope": { "seq": 0, "t": 0, "wall": "2026-01-01T00:00:00.000Z", "kind": "session.end", "data": { "reason": "test" } },
      "hash": "${chainEntry(GENESIS_PREV_HASH, chainEnvelope).hash}"
    }
  ]
}
`;
  fs.writeFileSync(path.join(outDir, 'vectors.json'), vectorsText);

  // --- 2. ed25519 vector (seed 0x07, message {"a":1}) ---
  const edPriv = seed(7);
  const edMsg = '{"a":1}';
  const edSig = toHex(await ed.signAsync(new TextEncoder().encode(edMsg), edPriv));
  writeJson(outDir, 'ed25519.json', {
    priv_hex: toHex(edPriv),
    msg_utf8: edMsg,
    pub_hex: await pub(edPriv),
    sig_hex: edSig,
  });

  // --- 3. signed .provenance-manifest vector (course seed 0x09) ---
  const coursePriv = seed(9);
  const manifestFields = {
    assignment_id: 'hw3',
    semester: 'fa25',
    issued_at: '2026-07-14T00:00:00Z',
    files_under_review: ['src/main.py', 'src/util.py'],
  };
  const manifestSig = await signManifest(manifestFields, coursePriv);
  writeJson(outDir, 'manifest.json', {
    course_pubkey_hex: await pub(coursePriv),
    manifest: { ...manifestFields, sig: manifestSig },
  });

  // --- 4. signed bundle-manifest vector (session seed 0x03) ---
  const bundlePriv = seed(3);
  const bundleManifest = {
    format_version: '1.1' as const,
    assignment_id: 'hw3',
    semester: 'fa25',
    extension_hash: 'a'.repeat(64),
    sessions: [
      {
        session_id: '11111111-1111-4111-8111-111111111111',
        prev_session_id: null,
        slog_sha256: 'b'.repeat(64),
        meta_sha256: 'c'.repeat(64),
      },
      {
        session_id: '22222222-2222-4222-8222-222222222222',
        prev_session_id: '11111111-1111-4111-8111-111111111111',
        slog_sha256: 'd'.repeat(64),
        meta_sha256: 'e'.repeat(64),
      },
    ],
    submission_files: [
      { path: 'src/main.py', status: 'present' as const, sha256: 'f'.repeat(64) },
      { path: 'src/missing.py', status: 'missing' as const, sha256: null },
    ],
  };
  const signedBundle = await signBundleManifest(bundleManifest, bundlePriv);
  writeJson(outDir, 'bundle-manifest.json', {
    session_pubkey_hex: await pub(bundlePriv),
    manifest: bundleManifest,
    canonical_json: signedBundle.canonicalJson,
    signature_hex: signedBundle.signatureHex,
  });

  // --- 5. session privkey encryption vector (privkey seed 0x05, fixed salt/nonce) ---
  // encryptSessionPrivkey() draws salt/nonce from randomBytes internally, so to pin a
  // reproducible ciphertext we replicate its exact primitives with fixed inputs:
  // HKDF-SHA256(IKM = manifest sig bytes, salt, info) -> XChaCha20-Poly1305.
  const skPriv = seed(5);
  const salt = new Uint8Array(16).fill(0x11);
  const nonce = new Uint8Array(24).fill(0x22);
  const info = 'provenance-session-key-v1';
  const hkdfKey = hkdf(sha256, fromHex(manifestSig), salt, new TextEncoder().encode(info), 32);
  const ciphertext = xchacha20poly1305(hkdfKey, nonce).encrypt(skPriv);
  writeJson(outDir, 'session-key.json', {
    privkey_hex: toHex(skPriv),
    pubkey_hex: await pub(skPriv),
    manifest_sig: manifestSig,
    salt_hex: toHex(salt),
    nonce_hex: toHex(nonce),
    info,
    hkdf_key_hex: toHex(hkdfKey),
    ciphertext_hex: toHex(ciphertext),
    algorithm: 'xchacha20-poly1305-hkdf-sha256-v1',
  });

  // --- 6. signed checkpoint vector (session seed 0x04) ---
  const ckptPriv = seed(4);
  const checkpoint = await signCheckpoint(128, 'ab'.repeat(32), ckptPriv);
  writeJson(outDir, 'checkpoint.json', {
    session_pubkey_hex: await pub(ckptPriv),
    seq: checkpoint.seq,
    hash: checkpoint.hash,
    sig: checkpoint.sig,
  });

  // --- 7. golden full bundle (built from analysis-core's test-support builder) ---
  // A complete, self-consistent sealed bundle straight from analysis-core, so the
  // JetBrains core/ can assert its manifest conforms to the shared shape. Not compared
  // byte-for-byte (there is no committed original); it is a fresh, deterministic build.
  const golden = await buildTestBundle({
    assignmentId: 'golden-hw',
    semester: 'fa26',
    sessions: [{ eventCount: 8, appendDocSave: true }],
  });
  fs.writeFileSync(path.join(outDir, 'golden-bundle.zip'), Buffer.from(golden.zipBuffer));
  writeJson(outDir, 'golden-bundle.json', {
    note:
      'Sidecar for golden-bundle.zip, generated by tools/export-conformance-vectors.ts. ' +
      'The manifest below is the sealed BundleManifest; core/ asserts it validates via ' +
      'validateBundleManifestShape. Full zip round-trip awaits a core/ zip loader.',
    manifest: golden.manifest,
    session_pubkey_hex: await pub(fromHex(golden.sessionPrivkeyHex)),
  });

  // --- 8. course certificate: root -> course key (Manifest 2.0 trust chain) ---
  writeJson(outDir, 'course-cert.json', await buildCourseCertVectors());

  // --- 9. Manifest 2.0: format_version defaulting + the four-step chain ---
  writeJson(outDir, 'manifest-v2.json', await buildManifestV2Vectors());

  // --- 10. capture policy resolution: defaults + heartbeat clamping ---
  writeJson(outDir, 'capture-policy.json', buildCapturePolicyVectors());

  console.log(`Wrote conformance vectors to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
