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
 *                   checkpoint, golden bundle, the Manifest 2.0 family (course cert,
 *                   manifest-v2, capture policy), the S2 identity family (enrollment,
 *                   student-keys), and the S3 rolling seal (rolling-manifest).
 *                   Consumed by JetBrains `core/` and by the Neovim
 *                   `tests/conformance/fixtures/`.
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
  validatePeerObservedPayload,
  PEER_OBSERVED_STATES,
  readRepositoryDiscriminator,
  REPOSITORY_DISCRIMINATOR_FIELD,
  readGitCapture,
  readWitnessCapture,
  readFileScope,
  GIT_CAPTURE_VALUES,
  WITNESS_CAPTURE_VALUES,
  GIT_CAPTURE_FIELD,
  WITNESS_CAPTURE_FIELD,
  FILE_SCOPE_FIELD,
  DEFAULT_CAPTURE_POLICY,
  FLOOR_EVENT_KINDS,
  POLICY_GATED_EVENT_KINDS,
  HEARTBEAT_INTERVAL_MIN_MS,
  HEARTBEAT_INTERVAL_MAX_MS,
  signEnrollmentCert,
  signEnrollmentToken,
  signSessionPubkey,
  verifyIdentityChain,
  checkTokenWindow,
  buildEnrollmentCertSignedPayload,
  buildEnrollmentTokenSignedPayload,
  buildSessionPubkeyBindingPayload,
  ENROLLMENT_FORMAT_VERSION,
  SESSION_PUBKEY_BINDING_PURPOSE,
  deriveCourseKeypair,
  deriveCourseKeySeed,
  STUDENT_KEY_HKDF_INFO_PREFIX,
  STUDENT_KEY_HKDF_SALT,
  STUDENT_KEY_SEED_BYTES,
  STUDENT_MASTER_SECRET_BYTES,
  signInstitutionCert,
  signStudentCredential,
  signStudentSessionBinding,
  verifyInstitutionCert,
  verifyStudentCredential,
  buildInstitutionCertSignedPayload,
  buildStudentCredentialSignedPayload,
  buildStudentSessionBindingPayload,
  checkCredentialWindow,
  INSTITUTION_IDENTITY_FORMAT_VERSION,
  STUDENT_SESSION_BINDING_PURPOSE,
  deriveStudentKeypair,
  deriveStudentKeySeed,
  STUDENT_KEY_HKDF_INFO,
} from '@provenance/log-core';
import type {
  CourseCert,
  Manifest,
  EnrollmentCert,
  EnrollmentToken,
  SessionIdentity,
  InstitutionCert,
  StudentCredential,
} from '@provenance/log-core';
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
/** The "other" course, for cross-course forgery and unlinkability vectors. */
const OTHER_COURSE_ID = 'berkeley-cs61c';

/** The `policy` block used by every 2.0 manifest vector. */
const V2_POLICY = {
  capture: {
    selection_change: true,
    focus_change: true,
    terminal: true,
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
 * Vectors for the `git.event` commit graph (program spec S5).
 *
 * Each case pins the JCS canonical bytes AND the resulting chain hash for a
 * `git.event` envelope, so a port that orders keys differently, sorts `parents`,
 * or collapses `[]` into "absent" fails here rather than producing a log whose
 * hashes silently disagree with every other recorder's.
 *
 * Three things ports get wrong, in the order they are likely to:
 *
 *  - **`parents` order is meaningful.** The first parent is the branch that was
 *    merged into. JCS sorts object KEYS but leaves array ELEMENTS alone, so a
 *    port that helpfully sorts the shas produces different bytes and a different
 *    hash. A case below pins the flipped order to a different hash to prove it.
 *  - **`[]` and absent differ.** An empty array is "this commit genuinely has no
 *    parents" (a root commit); an absent field is "the recorder could not read
 *    them". Collapsing them lets a read failure and a root commit look alike.
 *  - **`commit_sha` is still emitted.** It duplicates `sha` on purpose, for 1.x
 *    readers, through the reader-before-writer migration.
 *
 * There is deliberately no author name and no author email in any case here, and
 * a port MUST NOT add one: the approved CPHS protocol treats a new category of
 * identifier as requiring a filed modification before implementation. `sha`,
 * `parents`, and `branch` are structural. Attribution lives in the opaque
 * `student_ref` inside `session.start.identity`, and nowhere else.
 */
function buildGitEventVectors(): unknown {
  const gitCase = (name: string, note: string, data: Record<string, unknown>): unknown => {
    const envelope = {
      seq: 0,
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'git.event',
      data,
    };
    return {
      name,
      note,
      data,
      canonical_json: canonicalize(data),
      envelope,
      prev_hash: GENESIS_PREV_HASH,
      hash: chainEntry(GENESIS_PREV_HASH, envelope).hash,
    };
  };

  /**
   * A case that also publishes what the repository discriminator narrows to.
   *
   * Deliberately a SECOND helper rather than a field added to `gitCase`: every
   * case above it is already published to provjet and provnvim, and perturbing
   * an existing vector object is a breaking tri-repo change. New cases carry the
   * new field; old cases are byte-identical.
   */
  const discriminatorCase = (
    name: string,
    note: string,
    data: Record<string, unknown>,
  ): unknown => {
    const read = readRepositoryDiscriminator(data);
    return {
      ...(gitCase(name, note, data) as Record<string, unknown>),
      discriminator: read,
    };
  };

  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const C = 'c'.repeat(40);
  /** A root-commit sha: the repository discriminator's one legal value. */
  const ROOT = '9'.repeat(40);
  /** The same, for a sha-256 repository. Git has two object formats. */
  const ROOT_SHA256 = '8'.repeat(64);

  return {
    note:
      'git.event commit-graph fields (program spec S5). Gradescope delivers no .git, and a ' +
      '.git that did travel would be rewritable after the fact (amend, rebase, filter-branch), ' +
      'so the graph is captured at RECORD time, inside the signed hash chain, where it can no ' +
      'longer be rewritten. Every field except `operation` is optional and stays optional: 1.x ' +
      'and pre-S5 2.0 bundles carry only { operation, commit_sha } and must keep parsing ' +
      'forever (program spec §9).',
    floor_note:
      'git.event is a FLOOR event kind and adding fields to its payload does not change that. ' +
      'It has no key in policy.capture, so "off" is not expressible — which is deliberate: the ' +
      'commit graph is the exculpatory evidence that a large insert was a merge or a checkout ' +
      'rather than a paste, and a course must not be able to switch that off.',
    no_author_identity_note:
      'NO git author name and NO author email, here or anywhere else in the log. This is a ' +
      'protocol constraint, not a style preference: the approved CPHS protocol treats a new ' +
      'category of identifier as requiring a filed modification BEFORE implementation. sha, ' +
      'parents and branch describe the SHAPE of the history, not who made it. Attribution has ' +
      'a designed, opaque home already — student_ref inside session.start.identity. A port ' +
      'that adds an author field is out of protocol.',
    parents_order_note:
      'JCS sorts object keys but NOT array elements. parents[0] is the branch merged INTO, so ' +
      'the order carries meaning and must never be sorted or normalized.',
    repository_discriminator_note:
      `${REPOSITORY_DISCRIMINATOR_FIELD} identifies WHICH REPOSITORY an observation came from, ` +
      "by that repository's ROOT-COMMIT SHA (decision D12). A scope can observe more than one " +
      'repository — a submodule, or a repo nested inside the one owning the assignment root — ' +
      'and their sha spaces are unrelated, so a reader that keys commits by sha alone merges two ' +
      'graphs that have nothing to do with each other. The root commit was chosen because BOTH ' +
      'PARTNERS DERIVE THE SAME VALUE OFFLINE, which is the whole point: a discriminator two ' +
      'partners disagree about cannot correlate anything. A session-salted hash of the repo path ' +
      'was rejected for exactly that reason. It is NOT the repository path (arguably an ' +
      'identifier, certainly noisy) and NOT a remote URL (embeds the org and often the ' +
      "student's username), which is why a value that is not a commit sha is REJECTED rather " +
      'than used.',
    repository_discriminator_absence_note:
      'ABSENT is the ordinary case and always will be. Every bundle recorded before this landed ' +
      'has no such field, and a SHALLOW CLONE has no reachable root commit — the boundary commit ' +
      'it reports has no parents but is not a root, so a recorder that emitted it would publish ' +
      'a value a full clone of the same repository disagrees with. A port MUST OMIT the field in ' +
      'both cases. Absent means "this observation is unlabelled": never "a different ' +
      'repository", never a defect, and never evidence of anything about the student. OMIT, ' +
      'never null — the two canonicalize differently and therefore chain to different hashes, ' +
      'exactly as `parents: []` and an absent `parents` do.',
    repository_discriminator_writer_note:
      'WRITER RULE, so three ports derive the same value: take the root of the FIRST-PARENT ' +
      'lineage of HEAD (git rev-list --max-parents=0 --first-parent HEAD); if that yields more ' +
      'than one — an orphan branch or a squashed import merged in — take the lexicographically ' +
      'smallest, so the choice is deterministic. OMIT the field if the repository is shallow ' +
      '(git rev-parse --is-shallow-repository), if the command fails, or if it yields nothing. ' +
      'Several root commits in one repository is ORDINARY and is never a finding, and neither is ' +
      'two partners deriving different values: the cost of disagreement is lost correlation, ' +
      'which surfaces as "unknown", and it must never be more than that.',
    cases: [
      gitCase(
        'legacy_1x',
        'The pre-S5 shape. Must canonicalize and chain exactly as it always has — this is the ' +
          'permanent 1.x compatibility anchor.',
        { operation: 'state_change', commit_sha: A },
      ),
      gitCase('operation_only', 'Minimal payload: every other field is optional.', {
        operation: 'state_change',
      }),
      gitCase(
        'root_commit',
        'parents is an EMPTY ARRAY — the commit genuinely has no parents. Distinct from the ' +
          'unknown_parents case below.',
        { operation: 'commit', commit_sha: A, sha: A, parents: [], branch: 'main' },
      ),
      gitCase(
        'unknown_parents',
        'parents is ABSENT — the recorder could not read them. MUST NOT canonicalize the same ' +
          'as root_commit.',
        { operation: 'commit', commit_sha: A, sha: A, branch: 'main' },
      ),
      gitCase('ordinary_commit', 'Exactly one parent.', {
        operation: 'commit',
        commit_sha: B,
        sha: B,
        parents: [A],
        branch: 'main',
      }),
      gitCase(
        'merge_commit',
        'Two parents. parents[0] is the branch merged INTO; see merge_commit_parents_flipped.',
        { operation: 'commit', commit_sha: C, sha: C, parents: [A, B], branch: 'main' },
      ),
      gitCase(
        'merge_commit_parents_flipped',
        'The same merge with parents reversed. It means something different, so it MUST hash ' +
          'differently from merge_commit. A port that sorts parents fails here.',
        { operation: 'commit', commit_sha: C, sha: C, parents: [B, A], branch: 'main' },
      ),
      gitCase(
        'detached_head',
        'branch is ABSENT when HEAD is detached. A port must omit it, never invent "HEAD" or "".',
        { operation: 'checkout', commit_sha: A, sha: A, parents: [] },
      ),
      gitCase(
        'branch_with_slash',
        'Branch names routinely contain "/" and "-". Nothing escapes them; they are ordinary ' +
          'JSON string values.',
        { operation: 'checkout', commit_sha: B, sha: B, parents: [A], branch: 'feat/proj2-part1' },
      ),
      gitCase(
        'branch_non_ascii',
        'A non-ASCII branch name. JCS escapes nothing extra here; the value is UTF-8 and the ' +
          'three ports must agree on its bytes.',
        { operation: 'checkout', commit_sha: B, sha: B, parents: [A], branch: 'feature/über' },
      ),
      gitCase(
        'octopus_merge',
        'Three parents. Length is the structure: 0 = root, 1 = ordinary, 2+ = merge.',
        { operation: 'commit', commit_sha: C, sha: C, parents: [A, B, C], branch: 'main' },
      ),

      // --- repository discriminator (decision D12). Reader half only: no
      //     recorder emits the field yet, so implement the narrowing and the
      //     canonical form first and the derivation with the writer contract.
      discriminatorCase(
        'root_commit_sha_recorded',
        'The ordinary labelled commit. Note where JCS sorts the new key: after `parents` and ' +
          'before `sha`. This is the SAME payload as ordinary_commit plus the field, so the two ' +
          'MUST hash differently — a port that drops an unrecognised field silently produces ' +
          "the other one's hash.",
        {
          operation: 'commit',
          commit_sha: B,
          sha: B,
          parents: [A],
          branch: 'main',
          root_commit_sha: ROOT,
        },
      ),
      discriminatorCase(
        'root_commit_sha_sha256_repository',
        'A sha-256 repository: the root commit is 64 hex, not 40. Both lengths are legal object ' +
          'names and both must be accepted.',
        {
          operation: 'commit',
          commit_sha: B,
          sha: B,
          parents: [A],
          root_commit_sha: ROOT_SHA256,
        },
      ),
      discriminatorCase(
        'root_commit_sha_is_the_root_itself',
        'The root commit labelling its own repository: parents is [] and root_commit_sha equals ' +
          'sha. Ordinary, and NOT a special case — a reader compares the discriminator for ' +
          'equality and never relates it to the commit graph.',
        { operation: 'commit', commit_sha: ROOT, sha: ROOT, parents: [], root_commit_sha: ROOT },
      ),
      discriminatorCase(
        'root_commit_sha_absent_shallow_clone',
        'A shallow clone: the root commit is unreachable, so the field is OMITTED. Note the ' +
          'boundary commit reports parents [] and is NOT a root — recordedRoot means ' +
          'root-or-truncated-lineage. Reads as absent, which is not a defect and not evidence. ' +
          'Its hash deliberately EQUALS the root_commit case above: an unlabelled payload is ' +
          'byte-identical to the pre-D12 world, which is the whole compatibility guarantee.',
        { operation: 'commit', commit_sha: A, sha: A, parents: [], branch: 'main' },
      ),
      discriminatorCase(
        'root_commit_sha_null_is_not_absent',
        'A port that spells the unknown case as null instead of omitting the key produces ' +
          'DIFFERENT canonical bytes and a different chain hash from ' +
          'root_commit_sha_absent_shallow_clone. Readers accept null as absence so such a log ' +
          'still parses, but a writer MUST omit.',
        {
          operation: 'commit',
          commit_sha: A,
          sha: A,
          parents: [],
          branch: 'main',
          root_commit_sha: null,
        },
      ),
      discriminatorCase(
        'root_commit_sha_repository_path_rejected',
        'A repository PATH — the identifier this field exists to avoid. Rejected, and the ' +
          'observation is folded in with the unlabelled ones. This is the one place a path or a ' +
          'remote URL can be stopped before it reaches a staff-facing UI.',
        {
          operation: 'commit',
          sha: B,
          parents: [A],
          root_commit_sha: '/Users/student/cs61b/proj2',
        },
      ),
      discriminatorCase(
        'root_commit_sha_uppercase_rejected',
        'Lowercase hex only, as git prints it. Rejected rather than case-folded: folding is the ' +
          'normalization that could merge two values a reader must compare exactly.',
        { operation: 'commit', sha: B, parents: [A], root_commit_sha: 'A'.repeat(40) },
      ),
      discriminatorCase(
        'root_commit_sha_abbreviated_rejected',
        'An abbreviated sha is not the same value as the full one, and expanding it here would ' +
          'be a guess. Rejected.',
        { operation: 'commit', sha: B, parents: [A], root_commit_sha: '9'.repeat(7) },
      ),
      discriminatorCase(
        'root_commit_sha_empty_rejected',
        'The empty string would key every repository the same, which is worse than no key at ' +
          'all. Rejected.',
        { operation: 'commit', sha: B, parents: [A], root_commit_sha: '' },
      ),
    ],
  };
}

/**
 * Vectors for `peer.observed` — peer witnessing (program spec §7 mechanism 2,
 * collaboration spec §5.5).
 *
 * A witness is one contributor's signed record of ANOTHER contributor's
 * `.provenance/` log: the filename, the byte digest, and the foreign chain's
 * `seq_high` + final `hash`. Deleting a partner's log then leaves your own chain
 * testifying that it existed.
 *
 * Three things a port is likely to get wrong, each pinned by a case below:
 *
 *  - **`sha256` IS NOT THE CORROBORATION TEST.** A foreign log is append-only
 *    and its owner keeps recording, so the bytes a witness saw are normally a
 *    PREFIX of the bytes finally committed: digest inequality is the NORMAL
 *    case, not evidence. `seq_high` + `last_hash` are the verifiable
 *    commitment — a shorter or rewritten chain cannot reproduce the hash at that
 *    position. An implementation that compares digests reports every honest pair
 *    as tampered.
 *  - **Explicit `null` is not an absent field.** `null` means "the recorder
 *    could not read this out of the foreign file". A port that OMITS null fields
 *    produces different canonical bytes and therefore a different chain hash.
 *  - **Parsed-ness is all-or-nothing.** `session_id`, `seq_high` and `last_hash`
 *    are read together or not at all. A payload with some of them names a
 *    session while committing to nothing checkable — the shape most likely to be
 *    read as stronger than it is — and is REJECTED.
 *
 * There is deliberately no student ref, no key, no git author and no path
 * outside `.provenance/` in any case here, and a port MUST NOT add one. This
 * payload describes somebody ELSE's artifact, so the CPHS constraint that keeps
 * author identity out of `git.event` applies with more force. Attribution runs
 * through `student_ref` inside `session.start.identity`, and nowhere else.
 *
 * READER HALF ONLY, at the time these vectors were written: no recorder emits
 * this kind yet (program spec §9, readers before writers). A port should
 * implement the narrowing and the canonical form first, and the directory
 * watcher only once the writer contract lands.
 */
/**
 * `session-capabilities.json` — the three `session.start` CAPABILITY REPORTS
 * (collaboration spec §5.6).
 *
 * `git_capture` (item 2), `witness_capture` (item 3) and `file_scope` (item 1)
 * say what the recorder COULD do, so that an absence in the log can be read
 * correctly: a scope with no `git.event` is otherwise indistinguishable from a
 * scope where git capture was impossible, and "no events for this file" is
 * otherwise ambiguous between _nothing happened_ and _it was never watched_.
 *
 * A capability report says "I could not". A capture knob says "I was told not
 * to". None of these is policy-gated, and **none of them is ever a finding** —
 * no flag, no validation check, no severity, no score.
 *
 * Four rules a port must reproduce, each with cases below that prove it:
 *
 *  - **Absent is the ordinary case, permanently.** Every bundle recorded before
 *    §5.6 landed carries none of these fields, and a reader must treat their
 *    absence as "this recorder does not report", NEVER as "the capability was
 *    missing". `no_capability_reports` is that payload, and its `hash` is the
 *    value every 1.x `session.start` of this shape already has: adding the
 *    fields to the format changed nothing about a payload that omits them.
 *  - **OMIT, never `null`.** `*_null_is_not_absent` reads as absence and hashes
 *    DIFFERENTLY from the omitted case. A writer that emits `null` produces a
 *    log whose entries hash differently from every other recorder's.
 *  - **The enums are CLOSED.** `git_capture` has three values and
 *    `witness_capture` has two — there is no witnessing analogue of
 *    `not_owned`, because a recorder witnesses the directory it is itself
 *    writing into. A value outside the set is `malformed`, is counted, and never
 *    reaches a consumer as if it meant something.
 *  - **`file_scope` paths are ASSIGNMENT-ROOT-RELATIVE, and a bad entry rejects
 *    the WHOLE set.** S14(b) forbids repository paths and remote URLs; an
 *    absolute path, a colon (every remote-URL spelling) and a `..` segment are
 *    all rejected. Dropping only the offending entry would hand a consumer a
 *    silently narrowed list, which then says "not watched" about a file that
 *    was.
 *
 * `complete` is a required boolean, not an optional truncation flag: the field
 * exists to remove an inference, so it must never itself require one. An EMPTY
 * `watched` with `complete: true` is a real answer meaning "the scope resolved
 * to nothing", and must not be folded into absence.
 */
function buildSessionCapabilityVectors(): unknown {
  // A minimal, realistic 1.x `session.start`. Every case below is this payload
  // plus at most the fields under test, so the diff between two cases' hashes is
  // attributable to exactly the field that differs.
  const BASE: Record<string, unknown> = {
    format_version: '1.0',
    session_id: '4e2d9c10-55af-4b3e-9d21-8f0c7a6b3e55',
    prev_session_id: null,
    assignment: { id: 'proj2', semester: 'fa26' },
    manifest_sig: 'a'.repeat(128),
    machine_id: 'b'.repeat(64),
    recorder: { version: '1.2.0', extension_id: 'itsgeagle.provenance-recorder' },
    session_pubkey: 'c'.repeat(64),
  };

  const capCase = (name: string, note: string, extra: Record<string, unknown>): unknown => {
    const data = { ...BASE, ...extra };
    const envelope = {
      seq: 0,
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'session.start',
      data,
    };
    return {
      name,
      note,
      data,
      canonical_json: canonicalize(data),
      envelope,
      prev_hash: GENESIS_PREV_HASH,
      hash: chainEntry(GENESIS_PREV_HASH, envelope).hash,
      // The three narrowing verdicts, published alongside the bytes so a port
      // asserts ACCEPT and REJECT rather than only the happy path.
      git_capture: readGitCapture(data),
      witness_capture: readWitnessCapture(data),
      file_scope: readFileScope(data),
    };
  };

  return {
    note:
      'The three session.start capability reports (collaboration spec §5.6). Each field is ' +
      'OPTIONAL PERMANENTLY. A reader returns three answers — absent / recorded / malformed — ' +
      'and absence means "this recorder does not report", never "the capability was missing".',
    absence_note:
      'no_capability_reports is the pre-§5.6 payload and is the hash every 1.x session.start ' +
      'of this shape already has. Compare it against git_capture_available to see that a ' +
      'report changes the bytes, and against git_capture_null_is_not_absent to see that null ' +
      'and omission are different bytes despite reading the same.',
    not_a_knob_note:
      'These are CAPABILITY REPORTS, not capture knobs. A capability report says "I could ' +
      'not"; a knob says "I was told not to". Nothing here appears in policy.capture, nothing ' +
      'here is course-signed, and nothing here is ever a finding — no flag, no validation ' +
      'check, no severity, no score.',
    git_capture_note:
      'unavailable = the editor exposed no git integration, so no git.event could be produced ' +
      'at all. not_owned = git observation worked and no repository it could see was in this ' +
      "assignment's scope, so its events were dropped by the ownership gate. These are " +
      'different situations a grader acts on differently and MUST NOT be collapsed. ' +
      'available = git observation was live.',
    witness_capture_note:
      'Two values, deliberately. There is no witnessing analogue of not_owned: a recorder ' +
      'witnesses the .provenance/ directory it is itself writing into, so there is no ' +
      'ownership question to route on.',
    file_scope_note:
      'The RESOLVED LIST, not the rule. A count cannot be asked whether it contains a file, ' +
      'and publishing an unresolved glob set would require three hand-written ports and one ' +
      'analyzer to agree on a matcher. Paths are assignment-root-relative, exactly as every ' +
      'other path in the log. complete:false means the list is a strict subset, and a ' +
      "path's absence from it is then UNKNOWN rather than NOT WATCHED.",
    file_scope_privacy_note:
      'S14(b) forbids repository paths and remote URLs. An absolute path (POSIX, Windows ' +
      'drive or UNC), any colon (which is every remote-URL spelling, including git\u2019s ' +
      'scp-style user@host:path) and any ".." segment are rejected — and a single bad entry ' +
      'rejects the WHOLE set, because a silently narrowed list says "not watched" about a ' +
      'file that was.',
    writer_note:
      'OMIT a field you cannot answer. Never emit null: the two canonicalize differently and ' +
      'therefore chain to different hashes, exactly as `parents: []` and an absent `parents` ' +
      'do. Readers accept null as absence so a nonconforming log still parses; a writer that ' +
      'emits it is nonconforming.',
    git_capture_values: [...GIT_CAPTURE_VALUES],
    witness_capture_values: [...WITNESS_CAPTURE_VALUES],
    fields: {
      git_capture: GIT_CAPTURE_FIELD,
      witness_capture: WITNESS_CAPTURE_FIELD,
      file_scope: FILE_SCOPE_FIELD,
    },
    cases: [
      capCase(
        'no_capability_reports',
        'The pre-§5.6 payload, and every bundle in existence. All three read absent, and this ' +
          'hash is unchanged by the fields existing in the format.',
        {},
      ),

      // --- item 2: git_capture -------------------------------------------
      capCase(
        'git_capture_available',
        'Git observation was live. An absence of git.event in this session is a statement ' +
          'about git activity, not about capture.',
        { git_capture: 'available' },
      ),
      capCase(
        'git_capture_unavailable',
        'No git integration on this machine. Nothing this session did could have produced a ' +
          'git.event.',
        { git_capture: 'unavailable' },
      ),
      capCase(
        'git_capture_not_owned',
        'Git worked; no repository it could see was in scope. NOT the same fact as ' +
          'unavailable, and a reader that reports one as the other describes a different ' +
          'situation than the one that occurred.',
        { git_capture: 'not_owned' },
      ),
      capCase(
        'git_capture_null_is_not_absent',
        'Reads as absence, and hashes differently from no_capability_reports. A writer must ' +
          'OMIT.',
        { git_capture: null },
      ),
      capCase(
        'git_capture_unknown_value_rejected',
        'Outside the closed enum. Malformed, counted, never a finding, and never presented as ' +
          'a capability.',
        { git_capture: 'partial' },
      ),
      capCase(
        'git_capture_uppercase_rejected',
        'Case is not folded: folding would be exactly the normalization the reader refuses.',
        { git_capture: 'Available' },
      ),
      capCase(
        'git_capture_not_a_string_rejected',
        'A non-string value is malformed rather than coerced.',
        { git_capture: true },
      ),

      // --- item 3: witness_capture ---------------------------------------
      capCase(
        'witness_capture_available',
        'A .provenance/ watcher was running. Had a partner log appeared, changed or vanished, ' +
          'this session would have witnessed it.',
        { witness_capture: 'available' },
      ),
      capCase(
        'witness_capture_unavailable',
        'No watcher. The absence of peer.observed in this session says nothing about what was ' +
          'in .provenance/.',
        { witness_capture: 'unavailable' },
      ),
      capCase(
        'witness_capture_not_owned_rejected',
        "git_capture's third value is not legal here. A port that shares one enum between the " +
          'two fields fails this case.',
        { witness_capture: 'not_owned' },
      ),
      capCase(
        'witness_capture_null_is_not_absent',
        'Reads as absence, hashes differently from omission.',
        { witness_capture: null },
      ),

      // --- item 1: file_scope --------------------------------------------
      capCase(
        'file_scope_complete',
        'The effective resolved file set. A path NOT in a complete list was not watched, which ' +
          'is what makes "no events for this file" unambiguous.',
        { file_scope: { watched: ['Solver.java', 'src/Board.java'], complete: true } },
      ),
      capCase(
        'file_scope_empty_is_a_real_answer',
        'The scope resolved to nothing. A positive claim that explains every file\u2019s ' +
          'silence — not absence, and not to be folded into it.',
        { file_scope: { watched: [], complete: true } },
      ),
      capCase(
        'file_scope_truncated',
        'The list is a strict subset. A path in it WAS watched; a path not in it is UNKNOWN, ' +
          'never "not watched".',
        { file_scope: { watched: ['Solver.java'], complete: false } },
      ),
      capCase(
        'file_scope_missing_complete_rejected',
        'complete is required and is never inferred — the field exists to remove an inference.',
        { file_scope: { watched: ['Solver.java'] } },
      ),
      capCase(
        'file_scope_not_an_object_rejected',
        'An array is not a file scope; the list lives under `watched`.',
        { file_scope: ['Solver.java'] },
      ),
      capCase(
        'file_scope_absolute_path_rejected',
        'S14(b). An absolute path embeds the account name and the machine layout. The WHOLE ' +
          'set is rejected, not just this entry.',
        {
          file_scope: {
            watched: ['Solver.java', '/Users/student/cs61b/Solver.java'],
            complete: true,
          },
        },
      ),
      capCase(
        'file_scope_windows_path_rejected',
        'A Windows drive path is absolute too. A port that only checks for a leading "/" fails ' +
          'this case.',
        { file_scope: { watched: ['C:\\Users\\student\\Solver.java'], complete: true } },
      ),
      capCase(
        'file_scope_remote_url_rejected',
        'S14(b). A remote URL embeds the org and frequently the student\u2019s own username.',
        {
          file_scope: {
            watched: ['https://github.com/some-student/proj2/Solver.java'],
            complete: true,
          },
        },
      ),
      capCase(
        'file_scope_scp_remote_rejected',
        'git\u2019s scp-style remote has no "://" and is still a remote URL. The rule is any ' +
          'colon outside a Windows drive letter.',
        { file_scope: { watched: ['git@github.com:someone/proj2.git'], complete: true } },
      ),
      capCase(
        'file_scope_parent_escape_rejected',
        'A ".." segment names something outside the assignment scope.',
        { file_scope: { watched: ['../other-course/Solver.java'], complete: true } },
      ),
      capCase(
        'file_scope_dotted_names_accepted',
        'Paths that merely LOOK risky are ordinary: a leading dot, a doubled dot inside a ' +
          'segment, and backslash separators are all accepted verbatim.',
        {
          file_scope: {
            watched: ['.hidden/config.txt', 'a..b/Solver.java', 'src\\main\\Board.java'],
            complete: true,
          },
        },
      ),
      capCase(
        'file_scope_unknown_extra_key_accepted',
        'Forward compatibility: a newer recorder adding a key must not make this reader refuse ' +
          'the whole scope.',
        {
          file_scope: { watched: ['Solver.java'], complete: true, resolution: 'repo_tracked' },
        },
      ),
      capCase(
        'file_scope_null_is_not_absent',
        'Reads as absence, hashes differently from omission.',
        { file_scope: null },
      ),

      // --- all three together ---------------------------------------------
      capCase(
        'all_three_reported',
        'The shape a §5.6-conformant recorder emits when it can answer all three. The three ' +
          'fields are independent: a port may land one before the others.',
        {
          git_capture: 'available',
          witness_capture: 'available',
          file_scope: { watched: ['Solver.java'], complete: true },
        },
      ),
    ],
  };
}

function buildPeerObservedVectors(): unknown {
  const peerCase = (name: string, note: string, data: Record<string, unknown>): unknown => {
    const envelope = {
      seq: 0,
      t: 0,
      wall: '2026-01-01T00:00:00.000Z',
      kind: 'peer.observed',
      data,
    };
    const validated = validatePeerObservedPayload(data);
    return {
      name,
      note,
      data,
      canonical_json: canonicalize(data),
      envelope,
      prev_hash: GENESIS_PREV_HASH,
      hash: chainEntry(GENESIS_PREV_HASH, envelope).hash,
      accepted: validated.ok,
      ...(validated.ok ? { value: validated.value } : { error: validated.error }),
    };
  };

  const FILE = 'session-7f3a1c22-9b0e-4d51-8a77-2c6e5d0b41af.slog';
  const SEEN = 'a'.repeat(64);
  const TIP = 'b'.repeat(64);
  const SESSION = '4e2d9c10-55af-4b3e-9d21-8f0c7a6b3e55';

  return {
    note:
      'peer.observed — peer witnessing (program spec §7 mechanism 2, collaboration spec §5.5). ' +
      "One contributor's signed record of ANOTHER contributor's .provenance/ log: filename, byte " +
      "digest, and the foreign chain's seq_high + final hash. Deleting a partner's log then " +
      'leaves your own chain testifying that it existed, so hiding a deletion means destroying ' +
      'both chains — which yields a submission with no provenance at all, the loudest possible ' +
      'signal.',
    sha256_is_not_the_test_note:
      'The obvious implementation compares sha256 against the archived file and calls inequality ' +
      'tampering. It is WRONG. A foreign log is append-only and its owner keeps recording, so the ' +
      'bytes witnessed are normally a PREFIX of the bytes finally committed: inequality is the ' +
      'NORMAL case. The verifiable commitment is seq_high + last_hash — an archived log that ' +
      'stops before that seq, or reaches it with a different hash, cannot reproduce it. seq_high ' +
      'alone would make truncation detectable only by LENGTH, which a forger can match. sha256 is ' +
      'corroborating detail for display and nothing more.',
    null_is_not_absent_note:
      'null means "the recorder could not read this out of the foreign file", which is a ' +
      'different fact from a field being absent. The nulls MUST be emitted explicitly: a port ' +
      'that omits them produces different canonical bytes and therefore a different chain hash. ' +
      'See the unparseable_file case.',
    all_or_nothing_note:
      'session_id, seq_high and last_hash are the three values read out of the foreign chain. ' +
      'Either the recorder parsed it or it did not, so they are all non-null together or all ' +
      'null together. A payload with only some of them is self-contradictory and is REJECTED — ' +
      'it would name a session while committing to nothing any later archive could contradict.',
    no_identity_note:
      'NO student ref, NO key, NO git author, and no path outside .provenance/. A witness names a ' +
      'FILE and a CHAIN POSITION. This payload is about somebody ELSE, so the CPHS constraint ' +
      'that keeps author identity out of git.event applies with more force here. Attribution runs ' +
      'through student_ref inside session.start.identity, and nowhere else. A port that adds an ' +
      'identifier here is out of protocol.',
    floor_note:
      'peer.observed is a FLOOR event kind: it has no key in policy.capture, so "off" is not ' +
      'expressible. The collaboration spec §5.6 assigns "was witnessing AVAILABLE?" to a ' +
      'session.start capability report rather than to a capture knob, so there is no knob for it ' +
      'to be gated on. NOTE this is provisional: the CPHS question in collaboration spec §8 item ' +
      '5 is open and gates the WRITER half. See capture-policy.json.',
    reader_half_only_note:
      'No recorder emits this kind yet. Readers before writers (program spec §9): implement the ' +
      'narrowing and the canonical form now; the directory watcher lands with the writer contract.',
    states: [...PEER_OBSERVED_STATES],
    cases: [
      peerCase(
        'appeared_parsed',
        "The ordinary witness: a git pull dropped a partner's log into the tree, the recorder " +
          'hashed it and read its chain. This is what corroboration is checked against.',
        {
          file: FILE,
          sha256: SEEN,
          bytes: 8192,
          session_id: SESSION,
          seq_high: 412,
          last_hash: TIP,
          state: 'appeared',
        },
      ),
      peerCase(
        'grew',
        'The same file, later and longer. Distinct from appeared: a reader must be able to see ' +
          'the foreign chain advancing inside this chain.',
        {
          file: FILE,
          sha256: 'c'.repeat(64),
          bytes: 12288,
          session_id: SESSION,
          seq_high: 601,
          last_hash: 'd'.repeat(64),
          state: 'grew',
        },
      ),
      peerCase(
        'shrank',
        'The file got SHORTER. Append-only logs do not shrink, so this is the observation that ' +
          'catches a truncation while it happens — but it is still only an observation, and not ' +
          'by itself misconduct.',
        {
          file: FILE,
          sha256: 'e'.repeat(64),
          bytes: 2048,
          session_id: SESSION,
          seq_high: 90,
          last_hash: 'f'.repeat(64),
          state: 'shrank',
        },
      ),
      peerCase(
        'disappeared',
        'The file is gone from the working tree. NOT evidence of misconduct: checking out a ' +
          "branch that does not contain a partner's .slog removes it, and so does a stash. The " +
          'digest and chain fields describe the LAST state the recorder saw, which is what makes ' +
          'the observation evidentiary at all.',
        {
          file: FILE,
          sha256: SEEN,
          bytes: 8192,
          session_id: SESSION,
          seq_high: 412,
          last_hash: TIP,
          state: 'disappeared',
        },
      ),
      peerCase(
        'unparseable_file',
        'The foreign file could not be read — mid-write, conflict-marked, or truncated. All three ' +
          'chain fields are explicitly null. The recorder does NOT rename, rewrite or delete it: ' +
          'recording this state is the entire response. Note the nulls are present in the ' +
          'canonical bytes; omitting them changes the hash.',
        {
          file: FILE,
          sha256: SEEN,
          bytes: 41,
          session_id: null,
          seq_high: null,
          last_hash: null,
          state: 'unparseable',
        },
      ),
      peerCase(
        'seq_high_zero',
        'A foreign log holding only its session.start. 0 is a real seq: a truthiness check here ' +
          'rejects the shortest possible honest witness and reads it as unparsed.',
        {
          file: FILE,
          sha256: SEEN,
          bytes: 512,
          session_id: SESSION,
          seq_high: 0,
          last_hash: TIP,
          state: 'appeared',
        },
      ),
      peerCase(
        'rejected_named_session_without_tip',
        'REJECTED (partially_parsed). Names a session, commits to no tip. It reads as ' +
          'authoritative while being unfalsifiable by any archive — the single most dangerous ' +
          'shape this payload can take.',
        {
          file: FILE,
          sha256: SEEN,
          bytes: 8192,
          session_id: SESSION,
          seq_high: null,
          last_hash: null,
          state: 'appeared',
        },
      ),
      peerCase(
        'rejected_seq_without_hash',
        'REJECTED (partially_parsed). seq_high alone is a SIZE claim; a forger can match a ' +
          'length. last_hash is what makes it a commitment to an exact prefix.',
        {
          file: FILE,
          sha256: SEEN,
          bytes: 8192,
          session_id: SESSION,
          seq_high: 412,
          last_hash: null,
          state: 'appeared',
        },
      ),
      peerCase(
        'rejected_unparseable_with_chain_values',
        'REJECTED (unparseable_with_chain_values). Self-contradictory: the recorder cannot both ' +
          'have failed to parse the file and have read its chain out.',
        {
          file: FILE,
          sha256: SEEN,
          bytes: 41,
          session_id: SESSION,
          seq_high: 412,
          last_hash: TIP,
          state: 'unparseable',
        },
      ),
      peerCase(
        'rejected_unknown_state',
        'REJECTED (unknown_state). Unlike an unknown event KIND — forward compatibility, must ' +
          'pass — an unknown state inside a payload we DO understand would have to be given a ' +
          'meaning, and inventing one is how an unfamiliar observation becomes an accusation.',
        {
          file: FILE,
          sha256: SEEN,
          bytes: 8192,
          session_id: SESSION,
          seq_high: 412,
          last_hash: TIP,
          state: 'vanished',
        },
      ),
      peerCase(
        'rejected_uppercase_sha256',
        'REJECTED (bad_field: sha256). Hex is lowercase everywhere in this format. A port that ' +
          'upper-cases produces a value that will never match any digest computed here.',
        {
          file: FILE,
          sha256: SEEN.toUpperCase(),
          bytes: 8192,
          session_id: SESSION,
          seq_high: 412,
          last_hash: TIP,
          state: 'appeared',
        },
      ),
      peerCase(
        'accepted_unknown_extra_key',
        'ACCEPTED. Forward compatibility, the same rule resolveCapturePolicy applies to unknown ' +
          "capture keys: a newer recorder's extra field must not make a reader discard the whole " +
          'witness. It is ignored, never carried onto the narrowed value. NOTE the extra key DOES ' +
          'change the canonical bytes and therefore the chain hash — narrowing is not ' +
          'canonicalization.',
        {
          file: FILE,
          sha256: SEEN,
          bytes: 8192,
          session_id: SESSION,
          seq_high: 412,
          last_hash: TIP,
          state: 'appeared',
          future_signal: true,
        },
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
      'though the program spec’s prose list omits it. doc.open and doc.close are on the floor ' +
      'too: DocOpenPayload.content is the reconstruction seed, so a knob switching it off ' +
      'would break reconstruction, replay, and the Source tab for a whole cohort, and ' +
      'DocClosePayload is { path } only. paste and fs.external_change content is floor too: ' +
      'the inline_content knob that stripped it was removed because internal_move needs that ' +
      'content to DOWNGRADE large_paste. The general rule: a signal whose absence degrades ' +
      'CORRECTNESS rather than merely detail must not be a knob — sensitivity is an argument ' +
      'FOR a knob, load-bearing is a VETO on one. The 64 KB inline size cap is a separate ' +
      'payload-size guard and is unaffected.',
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
      policyCase(
        'retired_doc_open_close_key_ignored',
        'doc_open_close was briefly a capture key and was REMOVED — doc.open carries the ' +
          'reconstruction seed, so it is floor. A manifest still carrying the key must treat ' +
          'it as an unknown key: it must not appear on the resolved policy and must not ' +
          'suppress doc.open or doc.close.',
        { capture: { doc_open_close: false } },
      ),
      policyCase(
        'retired_inline_content_key_ignored',
        'inline_content was briefly a capture key and was REMOVED. It stripped the content ' +
          'fields off paste and fs.external_change payloads without removing the events, and ' +
          "that is precisely why it had to go: internal_move reads a paste's inline content " +
          "to match it against the student's own prior typed code, and a match DOWNGRADES " +
          'large_paste. Strip the content and that exculpatory check cannot run, so a genuine ' +
          'self-relocation keeps full severity on a flag used in academic-integrity ' +
          'proceedings — a course must not be able to make the system more accusatory. A ' +
          'manifest still carrying the key must treat it as an unknown key. NOTE the 64 KB ' +
          'inline size cap is a separate, unaffected mechanism: over-cap content is still ' +
          'truncated to head/tail.',
        { capture: { inline_content: false } },
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

// ---------------------------------------------------------------------------
// S2 identity vectors (program spec §S2)
// ---------------------------------------------------------------------------

/**
 * Fixed key seeds for the identity family. Chosen not to collide with any seed
 * already in use (0x03/0x04/0x05/0x07/0x09 for 1.x, 0x0a-0x0d for Manifest 2.0),
 * so adding these cannot perturb a byte of the existing output.
 */
const ENROLLMENT_PRIV = seed(0x0e);
const WRONG_ENROLLMENT_PRIV = seed(0x0f);
const STUDENT_PRIV = seed(0x10);
const OTHER_STUDENT_PRIV = seed(0x11);
const IDENTITY_SESSION_PRIV = seed(0x12);

/** Fixed master secrets for the derivation vectors. */
const MASTER_SECRET_A = seed(0x2a);
const MASTER_SECRET_B = seed(0x2b);

const STUDENT_REF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const TOKEN_ISSUED_AT = '2026-09-01T00:00:00Z';
const TOKEN_EXPIRES_AT = '2027-01-15';
const IDENTITY_SESSION_STARTED_AT = '2026-09-08T12:00:00Z';

type UnsignedEnrollmentCert = Omit<EnrollmentCert, 'course_sig'>;
type UnsignedEnrollmentToken = Omit<EnrollmentToken, 'enrollment_sig'>;

async function makeEnrollmentCert(
  overrides: Partial<UnsignedEnrollmentCert> = {},
  coursePriv: Uint8Array = COURSE_PRIV,
): Promise<EnrollmentCert> {
  const unsigned: UnsignedEnrollmentCert = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    course_id: COURSE_ID,
    enrollment_pubkey: await pub(ENROLLMENT_PRIV),
    valid_from: CERT_VALID_FROM,
    valid_until: CERT_VALID_UNTIL,
    ...overrides,
  };
  return { ...unsigned, course_sig: await signEnrollmentCert(unsigned, coursePriv) };
}

async function makeEnrollmentToken(
  overrides: Partial<UnsignedEnrollmentToken> = {},
  enrollmentPriv: Uint8Array = ENROLLMENT_PRIV,
): Promise<EnrollmentToken> {
  const unsigned: UnsignedEnrollmentToken = {
    format_version: ENROLLMENT_FORMAT_VERSION,
    student_ref: STUDENT_REF,
    course_id: COURSE_ID,
    student_pubkey: await pub(STUDENT_PRIV),
    issued_at: TOKEN_ISSUED_AT,
    expires_at: TOKEN_EXPIRES_AT,
    ...overrides,
  };
  return { ...unsigned, enrollment_sig: await signEnrollmentToken(unsigned, enrollmentPriv) };
}

/**
 * Vectors for the S2 identity chain: enrollment_cert -> token -> session_pubkey_sig.
 *
 * The three `canonical_json` values are the single most useful thing here for a
 * port, because a canonicalization disagreement surfaces as a readable string
 * diff rather than as an inscrutable signature failure.
 */
async function buildEnrollmentVectors(): Promise<unknown> {
  const courseCert = await makeCert();
  const coursePubkeyHex = await pub(COURSE_PRIV);
  const sessionPubkey = await pub(IDENTITY_SESSION_PRIV);

  const validCert = await makeEnrollmentCert();
  const validToken = await makeEnrollmentToken();

  const binding = {
    course_id: COURSE_ID,
    student_ref: STUDENT_REF,
    session_pubkey: sessionPubkey,
  };
  const validBindingSig = await signSessionPubkey(binding, STUDENT_PRIV);

  const identity = (overrides: Partial<SessionIdentity> = {}): SessionIdentity => ({
    enrollment: validToken,
    enrollment_cert: validCert,
    session_pubkey_sig: validBindingSig,
    ...overrides,
  });

  const chainCase = async (
    name: string,
    note: string,
    ident: SessionIdentity,
    sessionPubkeyHex: string = sessionPubkey,
  ): Promise<unknown> => {
    const result = await verifyIdentityChain({
      identity: ident,
      session_pubkey: sessionPubkeyHex,
      course_cert: courseCert,
      session_started_at: IDENTITY_SESSION_STARTED_AT,
    });
    return {
      name,
      note,
      input: {
        identity: ident,
        session_pubkey: sessionPubkeyHex,
        course_cert: courseCert,
        session_started_at: IDENTITY_SESSION_STARTED_AT,
      },
      expected: result.ok
        ? {
            ok: true,
            course_id: result.value.course_id,
            student_ref: result.value.student_ref,
            student_pubkey: result.value.student_pubkey,
            enrollment_pubkey: result.value.enrollment_pubkey,
            cert_window: result.value.cert_window,
            token_window: result.value.token_window,
          }
        : { ok: false, error: result.error },
    };
  };

  // Both signatures genuine: 61B's course key certifies an enrollment key "for
  // 61C", which then mints a 61C token. Only comparing ids at EVERY link catches it.
  const crossCourseCert = await makeEnrollmentCert({ course_id: OTHER_COURSE_ID });
  const crossCourseToken = await makeEnrollmentToken({ course_id: OTHER_COURSE_ID });

  const expiredToken = await makeEnrollmentToken({
    issued_at: '2025-09-01T00:00:00Z',
    expires_at: '2025-12-15',
  });
  const expiredCert = await makeEnrollmentCert({
    valid_from: '2020-01-01',
    valid_until: '2020-12-31',
  });

  const tokenWindowCase = (name: string, note: string, token: EnrollmentToken, at: string) => ({
    name,
    note,
    input: { issued_at: token.issued_at, expires_at: token.expires_at, at },
    expected: checkTokenWindow(token, at),
  });

  return {
    note:
      'Enrollment conformance vectors (program spec §S2). The identity chain is ' +
      'course_cert -> enrollment_cert -> enrollment token -> session_pubkey_sig. The COURSE key ' +
      'signs the enrollment cert (offline); the ENROLLMENT key, which is the only private key ' +
      'that lives on a server, signs per-student tokens; the STUDENT per-course key countersigns ' +
      'the ephemeral session pubkey. A port walks all of it with only the embedded root key. ' +
      'Every object key in every signed payload is a fixed ASCII identifier and there are no ' +
      'JSON arrays — student_ref is always a VALUE, never a key. See course-cert.json for why.',
    course_pubkey_hex: coursePubkeyHex,
    enrollment_pubkey_hex: await pub(ENROLLMENT_PRIV),
    wrong_enrollment_pubkey_hex: await pub(WRONG_ENROLLMENT_PRIV),
    student_pubkey_hex: await pub(STUDENT_PRIV),
    other_student_pubkey_hex: await pub(OTHER_STUDENT_PRIV),
    session_pubkey_hex: sessionPubkey,
    course_cert: courseCert,
    valid_enrollment_cert: validCert,
    valid_enrollment_token: validToken,
    session_pubkey_binding: { ...binding, sig: validBindingSig },

    format_version_note:
      'Both artifacts carry format_version INSIDE the signed payload, and the chain gates on it ' +
      'BEFORE any signature work. There is no 1.x identity artifact to grandfather — the field ' +
      'exists so a future 3.0 cannot be replayed as a 2.0 artifact, which is the S0 downgrade ' +
      'lesson applied before it bites rather than after.',
    format_version: ENROLLMENT_FORMAT_VERSION,
    session_pubkey_binding_purpose: SESSION_PUBKEY_BINDING_PURPOSE,

    canonical_json: {
      enrollment_cert: new TextDecoder().decode(buildEnrollmentCertSignedPayload(validCert)),
      enrollment_token: new TextDecoder().decode(buildEnrollmentTokenSignedPayload(validToken)),
      session_pubkey_binding: new TextDecoder().decode(buildSessionPubkeyBindingPayload(binding)),
    },

    chain_cases: [
      await chainCase('valid', 'The whole chain, every link genuine.', identity()),
      await chainCase(
        'cert_not_2_0',
        'Version gate, step 0: an enrollment cert declaring another version is refused before any signature work.',
        identity({ enrollment_cert: await makeEnrollmentCert({ format_version: '1.0' }) }),
      ),
      await chainCase(
        'token_not_2_0',
        'Version gate, step 0, token side.',
        identity({ enrollment: await makeEnrollmentToken({ format_version: '3.0' }) }),
      ),
      await chainCase(
        'cert_signed_by_wrong_course_key',
        'Step 1: the enrollment cert was signed by a course key the root cert does not name.',
        identity({ enrollment_cert: await makeEnrollmentCert({}, OTHER_COURSE_PRIV) }),
      ),
      await chainCase(
        'token_signed_by_uncertified_key',
        'Step 2: token signed by an enrollment key the course never certified.',
        identity({ enrollment: await makeEnrollmentToken({}, WRONG_ENROLLMENT_PRIV) }),
      ),
      await chainCase(
        'cross_course_forgery',
        'Step 3, MANDATORY: 61B certifies an enrollment key "for 61C" and it mints a 61C token. ' +
          'Every signature is genuine; only comparing course_id at every link rejects it.',
        identity({ enrollment_cert: crossCourseCert, enrollment: crossCourseToken }),
      ),
      await chainCase(
        'session_pubkey_sig_from_another_student',
        'Step 4: the countersignature came from a different student key.',
        identity({
          session_pubkey_sig: await signSessionPubkey(binding, OTHER_STUDENT_PRIV),
        }),
      ),
      await chainCase(
        'session_pubkey_not_the_countersigned_one',
        'Step 4: a genuine countersignature lifted onto a different session key.',
        identity(),
        await pub(seed(0x13)),
      ),
      await chainCase(
        'expired_token_is_NOT_fatal',
        'Step 5: an expired token still returns ok, reporting token_window. An expired credential ' +
          'must never stop a recorder from recording (program spec §4); the analyzer decides.',
        identity({
          enrollment: expiredToken,
          session_pubkey_sig: validBindingSig,
        }),
      ),
      await chainCase(
        'expired_enrollment_cert_is_NOT_fatal',
        'Step 5, cert side. Same rule.',
        identity({ enrollment_cert: expiredCert }),
      ),
    ],

    window_note:
      'Every window is judged against the RELEVANT ISSUE TIME, never wall-clock now, so an ' +
      'archived bundle still verifies years later in an adjudication. The enrollment cert is ' +
      "judged against the token's issued_at; the token is judged against the session start. " +
      'A date-only expires_at is inclusive THROUGH THE END of that day, exactly as ' +
      'course_cert.valid_until — same resolution rule, implemented once.',
    token_window_cases: [
      tokenWindowCase('in_window', 'Mid-semester.', validToken, '2026-10-01T00:00:00Z'),
      tokenWindowCase(
        'before_issued',
        'Session predates issuance.',
        validToken,
        '2026-08-25T00:00:00Z',
      ),
      tokenWindowCase(
        'date_only_expiry_covers_that_whole_day',
        'expires_at 2027-01-15 covers all of Jan 15.',
        validToken,
        '2027-01-15T23:59:59Z',
      ),
      tokenWindowCase(
        'date_only_expiry_ends_at_next_midnight',
        'and expires at the first instant of Jan 16.',
        validToken,
        '2027-01-16T00:00:00Z',
      ),
      tokenWindowCase(
        'unparseable',
        'A bad instant reports unparseable_timestamp rather than throwing.',
        validToken,
        'whenever',
      ),
    ],
  };
}

/**
 * Vectors pinning student master-secret -> per-course key derivation.
 *
 * THE most divergence-prone thing in S2: if three ports derive different bytes,
 * a student's signature simply will not verify against the public key their
 * token names, and the failure looks like tampering rather than like a bug. The
 * HKDF parameters are therefore exported explicitly, alongside worked outputs.
 */
async function buildStudentKeyVectors(): Promise<unknown> {
  const derivation = async (masterSecret: Uint8Array, courseId: string, note: string) => {
    const kp = await deriveCourseKeypair(masterSecret, courseId);
    return {
      note,
      input: { master_secret_hex: toHex(masterSecret), course_id: courseId },
      expected: {
        info_utf8: STUDENT_KEY_HKDF_INFO_PREFIX + courseId,
        seed_hex: toHex(deriveCourseKeySeed(masterSecret, courseId)),
        pubkey_hex: kp.publicKeyHex,
      },
    };
  };

  return {
    note:
      'Student per-course key derivation (program spec §S2). One master secret per STUDENT, ' +
      'one derived ed25519 keypair per COURSE. The master secret never leaves the machine and ' +
      'is never sent to any server; each course therefore sees an unlinkable public key, and ' +
      'correlating a student across courses requires the master itself. If three ports derive ' +
      'different bytes here, a student signature will not verify against the pubkey their token ' +
      'names and the failure will look like tampering — so these values are load-bearing.',
    algorithm: 'HKDF-SHA256',
    hkdf_note:
      'IKM is the 32 RAW BYTES of the master secret (not hex, not base64). The salt is ' +
      "deliberately NON-EMPTY: HKDF's absent-salt rule (substitute HashLen zeros) and HMAC's " +
      'own key zero-padding make an empty salt and a 32-zero-byte salt produce the same PRK — ' +
      'an equivalence that is true but that no port should have to know. Passing concrete bytes ' +
      'removes the question. The 32-byte output IS the ed25519 seed; ed25519 accepts any 32 ' +
      'bytes, so there is no rejection sampling or retry loop to agree on.',
    hkdf_params: {
      hash: 'SHA-256',
      ikm: 'the 32 raw bytes of the master secret',
      salt_utf8: new TextDecoder().decode(STUDENT_KEY_HKDF_SALT),
      salt_hex: toHex(STUDENT_KEY_HKDF_SALT),
      info_prefix_utf8: STUDENT_KEY_HKDF_INFO_PREFIX,
      info_construction: 'UTF-8 bytes of (info_prefix_utf8 + course_id)',
      output_length_bytes: STUDENT_KEY_SEED_BYTES,
      output_is: 'the ed25519 secret key (seed)',
    },
    master_secret_bytes: STUDENT_MASTER_SECRET_BYTES,
    derivation_cases: [
      await derivation(MASTER_SECRET_A, COURSE_ID, 'The baseline derivation.'),
      await derivation(
        MASTER_SECRET_A,
        OTHER_COURSE_ID,
        'Same student, different course: an UNLINKABLE second key. This is the privacy claim.',
      ),
      await derivation(
        MASTER_SECRET_B,
        COURSE_ID,
        'Different student, same course: a different key.',
      ),
      await derivation(
        MASTER_SECRET_A,
        'cs61b',
        'Short course id — guards against prefix-concatenation collisions.',
      ),
      await derivation(
        MASTER_SECRET_A,
        'cs61b-extra',
        'and the longer id it must not collide with.',
      ),
      await derivation(
        MASTER_SECRET_A,
        'berkeley-café',
        'A NON-ASCII course id. Safe here because course_id enters as a VALUE inside the HKDF ' +
          'info byte string, never as a JSON object key — UTF-8 encoding is unambiguous across ' +
          'all three languages, whereas object-key ordering is not.',
      ),
    ],
  };
}

/**
 * S3 rolling seal — `.provenance/manifest-<session_id>.json` at format_version 1.2.
 *
 * A git-submitted repo has no packaging step to hook, so the recorder maintains
 * the seal continuously: one manifest per session, named after that session,
 * signed by that session's own ephemeral key, rewritten on every checkpoint.
 * Per-session filenames are what make a shared 61B repo's `.provenance/`
 * add-only and therefore conflict-free on merge.
 *
 * A port must reproduce three things exactly:
 *  1. The FILENAMES. `manifest-<session_id>.json` / `.sig`. Not `manifest.json` —
 *     that name belongs to the classic seal and must never be written by the
 *     rolling path.
 *  2. The CANONICAL BYTES. Identical JCS canonicalization and identical field set
 *     to a 1.1 manifest; only `format_version` and the one-session rule differ. A
 *     port that reorders keys or emits a different number representation produces
 *     a manifest whose signature the analyzer will reject.
 *  3. The ONE-SESSION RULE. A rolling manifest FILE covers exactly one session,
 *     whose `session_id` is non-null and equals the id in the filename. The
 *     `rejects` array below is the negative suite: each entry MUST be refused.
 *     (The analyzer's own loader synthesizes a multi-session 1.2 manifest in
 *     memory, which is why the plain shape validator accepts N sessions and this
 *     stricter rule is a separate function.)
 */
async function buildRollingManifestVectors(): Promise<unknown> {
  const sessionPriv = seed(6);
  const sessionId = '33333333-3333-4333-8333-333333333333';
  const otherSessionId = '44444444-4444-4444-8444-444444444444';

  const manifest = {
    format_version: '1.2' as const,
    assignment_id: 'proj2',
    semester: 'fa26',
    extension_hash: '1'.repeat(64),
    sessions: [
      {
        session_id: sessionId,
        prev_session_id: null,
        slog_sha256: '2'.repeat(64),
        meta_sha256: '3'.repeat(64),
      },
    ],
    submission_files: [
      { path: 'gitlet/Repository.java', status: 'present' as const, sha256: '4'.repeat(64) },
      { path: 'gitlet/Missing.java', status: 'missing' as const, sha256: null },
    ],
  };

  const signed = await signBundleManifest(manifest, sessionPriv);

  // The FINAL marker. Identical manifest plus `final: true`, which is what the
  // recorder's dispose()-time roll writes. Kept as a SEPARATE object so the
  // non-final vector above stays byte-identical: two other recorder repos pin
  // these bytes, and perturbing one is a breaking change to both.
  const finalManifest = { ...manifest, final: true as const };
  const signedFinal = await signBundleManifest(finalManifest, sessionPriv);

  // A downgrade attempt: delete `final` and keep the final signature. The
  // canonical bytes are then the non-final ones, so the signature cannot verify.
  const downgradedCanonicalJson = canonicalize(manifest);

  return {
    note:
      'Rolling seal (S3). One manifest per session, signed by that session key, ' +
      'rewritten on every checkpoint so a git-committed .provenance/ is always sealed.',
    format_version: '1.2',
    session_id: sessionId,
    filenames: {
      json: `manifest-${sessionId}.json`,
      sig: `manifest-${sessionId}.sig`,
    },
    /** Names that MUST NOT be read as a rolling manifest. */
    not_rolling_filenames: [
      'manifest.json',
      'manifest.sig',
      'manifest-.json',
      `manifest-${sessionId}.json.tmp`,
      `session-${sessionId}.slog`,
    ],
    session_pubkey_hex: await pub(sessionPriv),
    manifest,
    canonical_json: signed.canonicalJson,
    signature_hex: signed.signatureHex,
    /**
     * The `final` marker — whole-file vs. prefix semantics.
     *
     * A rolling seal is signed BEFORE the log's trailing bytes exist (it is
     * rewritten at session start, at each checkpoint, and at dispose), so its
     * `slog_sha256` normally commits only to a PREFIX of the file. That is what
     * keeps an honest mid-session archive — a git push from an editor that is
     * still open — from being read as tampering.
     *
     * The dispose()-time roll is the exception: it runs after session.end is
     * recorded and both log files are flushed and closed, so the log is
     * finished. It sets `final: true` INSIDE the signed payload, and a reader
     * that sees it must switch to WHOLE-FILE equality, which is what catches an
     * entry appended after the session ended.
     *
     * Implementation requirements for a conforming recorder/reader:
     *   1. Write `final: true` on the dispose roll ONLY. Never on session start,
     *      never on a checkpoint — the log is still growing there, and claiming
     *      otherwise turns the student's next keystroke into a finding.
     *   2. OMIT the key entirely when not final. Do not write `final: false`;
     *      `non_final.canonical_json` below is the byte-exact expectation.
     *   3. Treat ONLY a literal boolean `true` as final. Anything else — absent,
     *      false, the string "true", 1 — falls back to prefix semantics, which
     *      is the safer reading.
     *   4. Absence is NEVER a finding. A crash, a power cut, a full disk, a
     *      read-only checkout, or `.provenance/` removed by a `git checkout` all
     *      leave a non-final seal. Report the unattested tail; do not accuse.
     */
    final_marker: {
      non_final: {
        note: 'every roll but the last: the key is absent, not false',
        is_final: false,
        manifest,
        canonical_json: signed.canonicalJson,
        signature_hex: signed.signatureHex,
      },
      final: {
        note: 'the dispose()-time roll, over a finished log — read WHOLE-FILE',
        is_final: true,
        manifest: finalManifest,
        canonical_json: signedFinal.canonicalJson,
        signature_hex: signedFinal.signatureHex,
      },
      /** Values a reader must NOT treat as final. */
      not_final_values: [null, false, 'true', 1, {}],
      /**
       * The DOWNGRADE: strip `final` from the signed manifest to get prefix
       * semantics back, keeping the signature. Verifying `signature_hex` over
       * `canonical_json` MUST fail — that is what makes the marker unforgeable.
       */
      downgrade_rejects: {
        note: 'final stripped, final signature kept — must NOT verify',
        canonical_json: downgradedCanonicalJson,
        signature_hex: signedFinal.signatureHex,
        verifies: false,
      },
    },
    /** Each of these must be REFUSED as a rolling manifest file for `session_id`. */
    rejects: [
      {
        note: 'a classic 1.1 manifest is not a rolling seal',
        error_kind: 'not_rolling',
        manifest: { ...manifest, format_version: '1.1' },
      },
      {
        note: 'a rolling manifest FILE covers exactly one session',
        error_kind: 'wrong_session_count',
        manifest: {
          ...manifest,
          sessions: [
            manifest.sessions[0],
            {
              session_id: otherSessionId,
              prev_session_id: sessionId,
              slog_sha256: '5'.repeat(64),
              meta_sha256: '6'.repeat(64),
            },
          ],
        },
      },
      {
        note: 'a live recorder always knows its own session id',
        error_kind: 'null_session_id',
        manifest: {
          ...manifest,
          sessions: [{ ...manifest.sessions[0], session_id: null }],
        },
      },
      {
        note: 'copied sideways: the manifest names a session its filename does not',
        error_kind: 'session_id_mismatch',
        expected_session_id: otherSessionId,
        manifest,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Institution identity vectors — identity format_version 2.1
// ---------------------------------------------------------------------------

/**
 * Fixed key seeds for the institution identity family. Chosen not to collide
 * with any seed already in use (0x03/0x04/0x05/0x06/0x07/0x09 for 1.x,
 * 0x0a-0x0d for Manifest 2.0, 0x0e-0x13 for the legacy 2.0 identity family),
 * so adding these cannot perturb a byte of the existing output.
 */
const INSTITUTION_PRIV = seed(0x14);
const OTHER_INSTITUTION_PRIV = seed(0x15);
const GLOBAL_STUDENT_PRIV = seed(0x16);
const OTHER_GLOBAL_STUDENT_PRIV = seed(0x17);
const INSTITUTION_SESSION_PRIV = seed(0x18);

const INSTITUTION_ID = 'berkeley';
const OTHER_INSTITUTION_ID = 'stanford';
/** Global — one per STUDENT, not one per course. Deliberately not STUDENT_REF. */
const GLOBAL_STUDENT_REF = '9c8e1a70-2f2b-4c55-8f1e-6b4a0d9c7e21';
const CREDENTIAL_ISSUED_AT = '2026-09-01T00:00:00Z';
const CREDENTIAL_EXPIRES_AT = '2027-01-15';

type UnsignedInstitutionCert = Omit<InstitutionCert, 'root_sig'>;
type UnsignedStudentCredential = Omit<StudentCredential, 'institution_sig'>;

async function makeInstitutionCert(
  overrides: Partial<UnsignedInstitutionCert> = {},
  rootPriv: Uint8Array = ROOT_PRIV,
): Promise<InstitutionCert> {
  const unsigned: UnsignedInstitutionCert = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: INSTITUTION_ID,
    institution_pubkey: await pub(INSTITUTION_PRIV),
    valid_from: CERT_VALID_FROM,
    valid_until: CERT_VALID_UNTIL,
    ...overrides,
  };
  return { ...unsigned, root_sig: await signInstitutionCert(unsigned, rootPriv) };
}

async function makeStudentCredential(
  overrides: Partial<UnsignedStudentCredential> = {},
  institutionPriv: Uint8Array = INSTITUTION_PRIV,
): Promise<StudentCredential> {
  const unsigned: UnsignedStudentCredential = {
    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    institution_id: INSTITUTION_ID,
    student_ref: GLOBAL_STUDENT_REF,
    student_pubkey: await pub(GLOBAL_STUDENT_PRIV),
    issued_at: CREDENTIAL_ISSUED_AT,
    expires_at: CREDENTIAL_EXPIRES_AT,
    ...overrides,
  };
  return {
    ...unsigned,
    institution_sig: await signStudentCredential(unsigned, institutionPriv),
  };
}

/**
 * Vectors for the INSTITUTION identity chain (identity format_version 2.1):
 * institution_cert -> student_credential -> session_pubkey_sig.
 *
 * Identity is no longer course-scoped. A course-scoped credential needed a
 * roster match; rosters are populated by the Gradescope ingest path, which only
 * runs AFTER a student submits — so a student could not hold an identity until
 * after their first submission, while their first session needs one before any
 * work happens. A student now gets ONE credential, once, binding ONE global
 * key to a global `student_ref`.
 *
 * Three things a port must get exactly right, in descending order of how badly
 * it hurts to get wrong:
 *
 *  1. **The anchor check** (`chain_cases[cross_institution_forgery]`). MANDATORY.
 *     Root certifies many institutions, so a genuine signature by a genuinely
 *     certified key proves who signed, never whom they were entitled to speak
 *     for. This is the institution-scoped replacement for 2.0's
 *     `cross_course_forgery`, and it is the one case where every signature in
 *     the bundle verifies and the chain must still be refused.
 *  2. **The version routing.** `legacy_2_0_cases` walk ARCHIVED course-scoped
 *     identity blocks through the same entry point. A port that routes on which
 *     fields are present rather than on the signed `format_version` will get
 *     these wrong — see `discriminator` below.
 *  3. **The canonical bytes.** The three `canonical_json` values are the most
 *     useful thing here for a port, because a canonicalization disagreement
 *     surfaces as a readable string diff rather than as an inscrutable
 *     signature failure.
 */
async function buildInstitutionIdentityVectors(): Promise<unknown> {
  const rootPubkeyHex = await pub(ROOT_PRIV);
  const sessionPubkey = await pub(INSTITUTION_SESSION_PRIV);

  const validCert = await makeInstitutionCert();
  const validCredential = await makeStudentCredential();

  const binding = {
    institution_id: INSTITUTION_ID,
    student_ref: GLOBAL_STUDENT_REF,
    session_pubkey: sessionPubkey,
  };
  const validBindingSig = await signStudentSessionBinding(binding, GLOBAL_STUDENT_PRIV);

  const identity = (overrides: Partial<SessionIdentity> = {}): SessionIdentity => ({
    enrollment: validCredential,
    enrollment_cert: validCert,
    session_pubkey_sig: validBindingSig,
    ...overrides,
  });

  const chainCase = async (
    name: string,
    note: string,
    ident: SessionIdentity,
    anchor: InstitutionCert = validCert,
    sessionPubkeyHex: string = sessionPubkey,
  ): Promise<unknown> => {
    const result = await verifyIdentityChain({
      identity: ident,
      session_pubkey: sessionPubkeyHex,
      institution_cert: anchor,
      session_started_at: IDENTITY_SESSION_STARTED_AT,
    });
    return {
      name,
      note,
      input: {
        identity: ident,
        session_pubkey: sessionPubkeyHex,
        institution_cert: anchor,
        session_started_at: IDENTITY_SESSION_STARTED_AT,
      },
      expected:
        result.ok && result.value.identity_version === '2.1'
          ? {
              ok: true,
              identity_version: result.value.identity_version,
              scope: result.value.scope,
              institution_id: result.value.institution_id,
              student_ref: result.value.student_ref,
              student_pubkey: result.value.student_pubkey,
              institution_pubkey: result.value.institution_pubkey,
              cert_window: result.value.cert_window,
              token_window: result.value.token_window,
            }
          : result.ok
            ? { ok: true, identity_version: result.value.identity_version }
            : { ok: false, error: result.error },
    };
  };

  // THE mandatory negative case. Stanford holds a genuinely root-certified
  // institution key; it mints a credential naming BERKELEY and ships it with its
  // own genuine cert. Every signature verifies. Only comparing institution_id at
  // every link refuses it.
  const stanfordCert = await makeInstitutionCert({
    institution_id: OTHER_INSTITUTION_ID,
    institution_pubkey: await pub(OTHER_INSTITUTION_PRIV),
  });
  const berkeleyClaimingCredential = await makeStudentCredential(
    { institution_id: INSTITUTION_ID },
    OTHER_INSTITUTION_PRIV,
  );

  const expiredCredential = await makeStudentCredential({
    issued_at: '2025-09-01T00:00:00Z',
    expires_at: '2025-12-15',
  });
  const expiredCert = await makeInstitutionCert({
    valid_from: '2020-01-01',
    valid_until: '2020-12-31',
  });

  // --- archived 2.0 material, walked through the SAME entry point -----------
  const legacyCourseCert = await makeCert();
  const legacyCert = await makeEnrollmentCert();
  const legacyToken = await makeEnrollmentToken();
  const legacySessionPubkey = await pub(IDENTITY_SESSION_PRIV);
  const legacyIdentity: SessionIdentity = {
    enrollment: legacyToken,
    enrollment_cert: legacyCert,
    session_pubkey_sig: await signSessionPubkey(
      {
        course_id: COURSE_ID,
        student_ref: STUDENT_REF,
        session_pubkey: legacySessionPubkey,
      },
      STUDENT_PRIV,
    ),
  };

  const legacyCase = async (
    name: string,
    note: string,
    ident: SessionIdentity,
    courseCert: CourseCert = legacyCourseCert,
  ): Promise<unknown> => {
    const result = await verifyIdentityChain({
      identity: ident,
      session_pubkey: legacySessionPubkey,
      course_cert: courseCert,
      session_started_at: IDENTITY_SESSION_STARTED_AT,
    });
    return {
      name,
      note,
      input: {
        identity: ident,
        session_pubkey: legacySessionPubkey,
        course_cert: courseCert,
        session_started_at: IDENTITY_SESSION_STARTED_AT,
      },
      expected:
        result.ok && result.value.identity_version === '2.0'
          ? {
              ok: true,
              identity_version: result.value.identity_version,
              scope: result.value.scope,
              course_id: result.value.course_id,
              student_ref: result.value.student_ref,
              student_pubkey: result.value.student_pubkey,
              enrollment_pubkey: result.value.enrollment_pubkey,
              cert_window: result.value.cert_window,
              token_window: result.value.token_window,
            }
          : result.ok
            ? { ok: true, identity_version: result.value.identity_version }
            : { ok: false, error: result.error },
    };
  };

  const credentialWindowCase = (
    name: string,
    note: string,
    credential: StudentCredential,
    at: string,
  ) => ({
    name,
    note,
    input: { issued_at: credential.issued_at, expires_at: credential.expires_at, at },
    expected: checkCredentialWindow(credential, at),
  });

  const derivation = async (masterSecret: Uint8Array, note: string) => {
    const kp = await deriveStudentKeypair(masterSecret);
    return {
      note,
      input: { master_secret_hex: toHex(masterSecret) },
      expected: {
        info_utf8: STUDENT_KEY_HKDF_INFO,
        seed_hex: toHex(deriveStudentKeySeed(masterSecret)),
        pubkey_hex: kp.publicKeyHex,
      },
    };
  };

  return {
    note:
      'Institution identity conformance vectors, identity format_version 2.1. The chain is ' +
      'root -> institution_cert -> student_credential -> session_pubkey_sig. ROOT signs the ' +
      'institution cert (offline); the INSTITUTION key, which is the only private key that ' +
      'lives on a server, signs one credential per student; the STUDENT key — ONE per student, ' +
      'forever, across every course — countersigns the ephemeral session pubkey. A port walks ' +
      'all of it with only the embedded root key. Identity names no course: course membership ' +
      'is a roster question answered later by the server, and making it a precondition of ' +
      'HAVING an identity is what deadlocked the 2.0 design (rosters are populated by ' +
      'Gradescope ingest, which runs only after a student submits). Every object key in every ' +
      'signed payload is a fixed ASCII identifier and there are no JSON arrays — student_ref is ' +
      'always a VALUE, never a key. See course-cert.json for why.',

    root_pubkey_hex: rootPubkeyHex,
    institution_pubkey_hex: await pub(INSTITUTION_PRIV),
    other_institution_pubkey_hex: await pub(OTHER_INSTITUTION_PRIV),
    student_pubkey_hex: await pub(GLOBAL_STUDENT_PRIV),
    other_student_pubkey_hex: await pub(OTHER_GLOBAL_STUDENT_PRIV),
    session_pubkey_hex: sessionPubkey,

    valid_institution_cert: validCert,
    valid_student_credential: validCredential,
    session_pubkey_binding: { ...binding, sig: validBindingSig },

    format_version: INSTITUTION_IDENTITY_FORMAT_VERSION,
    session_pubkey_binding_purpose: STUDENT_SESSION_BINDING_PURPOSE,

    discriminator: {
      note:
        'THE ROUTING RULE. Two identity shapes share the same two wire slots in ' +
        'session.start.identity: `enrollment_cert` and `enrollment`. Which walk runs is ' +
        'decided by the SIGNED format_version inside `enrollment_cert` — 2.0 is the legacy ' +
        'course-scoped chain (course-signed enrollment_cert + enrollment token), 2.1 is this ' +
        'institution chain (root-signed institution_cert + student credential). NEVER route on ' +
        'which fields are present: presence is attacker-controlled and ambiguous, and this ' +
        'project already shipped that bug once — bundle-manifest.ts read the mere presence of ' +
        'an embedded manifest as a 2.0 claim and made the whole legacy path unreachable. The ' +
        "credential's own format_version must then MATCH the cert's; a mixed pair is refused " +
        'outright, so a legacy course-signed cert can never authorize an institution credential.',
      field: 'enrollment_cert.format_version',
      course_scoped: ENROLLMENT_FORMAT_VERSION,
      institution_scoped: INSTITUTION_IDENTITY_FORMAT_VERSION,
    },

    canonical_json: {
      institution_cert: new TextDecoder().decode(buildInstitutionCertSignedPayload(validCert)),
      student_credential: new TextDecoder().decode(
        buildStudentCredentialSignedPayload(validCredential),
      ),
      session_pubkey_binding: new TextDecoder().decode(buildStudentSessionBindingPayload(binding)),
    },

    /**
     * The institution cert is a trust anchor ONLY once its root_sig verifies
     * against the embedded root public key. verifyIdentityChain does not do this
     * — the caller must, exactly as for course_cert.
     */
    root_verification_cases: [
      {
        name: 'genuine_root_signature',
        note: 'The cert the rest of these vectors anchor to.',
        input: { cert: validCert, root_pubkey_hex: rootPubkeyHex },
        expected: { ok: (await verifyInstitutionCert(validCert, rootPubkeyHex)).ok },
      },
      {
        name: 'signed_by_a_key_that_is_not_the_root',
        note: 'MUST be refused: an attacker supplying the cert supplies institution_pubkey too.',
        input: {
          cert: await makeInstitutionCert({}, WRONG_ROOT_PRIV),
          root_pubkey_hex: rootPubkeyHex,
        },
        expected: {
          ok: (
            await verifyInstitutionCert(
              await makeInstitutionCert({}, WRONG_ROOT_PRIV),
              rootPubkeyHex,
            )
          ).ok,
        },
      },
    ],

    chain_cases: [
      await chainCase('valid', 'The whole chain, every link genuine.', identity()),
      await chainCase(
        'cert_not_a_known_version',
        'Version gate, step 0: a cert declaring a version that is neither 2.0 nor 2.1 is refused ' +
          'before any signature work.',
        identity({ enrollment_cert: await makeInstitutionCert({ format_version: '3.0' }) }),
      ),
      await chainCase(
        'future_3_0_is_not_replayable_as_2_1',
        'Version gate, step 0: BOTH artifacts genuinely signed and declaring 3.0. A reader that ' +
          'skipped the gate would walk them under 2.1 rules; the whole point of signing the ' +
          'version is that it cannot.',
        identity({
          enrollment_cert: await makeInstitutionCert({ format_version: '3.0' }),
          enrollment: await makeStudentCredential({ format_version: '3.0' }),
        }),
      ),
      await chainCase(
        'mixed_versions_are_refused',
        'Version gate, step 0: a 2.1 cert paired with a 2.0-versioned credential. Refused rather ' +
          'than resolved — otherwise each artifact is read under rules the other never agreed to.',
        identity({ enrollment: await makeStudentCredential({ format_version: '2.0' }) }),
      ),
      await chainCase(
        'credential_signed_by_uncertified_key',
        'Step 1: a credential signed by an institution key the root never certified.',
        identity({ enrollment: await makeStudentCredential({}, OTHER_INSTITUTION_PRIV) }),
      ),
      await chainCase(
        'cross_institution_forgery',
        'Step 2, MANDATORY — the institution-scoped replacement for 2.0 cross_course_forgery. ' +
          'Stanford holds a genuinely ROOT-certified institution key. It mints a credential ' +
          'naming BERKELEY and ships it with its own genuine cert. The cert verifies against ' +
          'root; the credential verifies against exactly the key that cert names; every ' +
          'signature in the bundle is real. Only comparing institution_id across the credential, ' +
          'the travelling cert and the root-verified anchor refuses it. One signer’s ' +
          'credential must never be replayable under another signer’s authority.',
        identity({
          enrollment_cert: stanfordCert,
          enrollment: berkeleyClaimingCredential,
        }),
        stanfordCert,
      ),
      await chainCase(
        'travelling_cert_names_another_institution',
        'Step 2: the cert shipped in the bundle disagrees with the root-verified anchor about ' +
          'which institution it is.',
        identity({
          enrollment_cert: await makeInstitutionCert({ institution_id: OTHER_INSTITUTION_ID }),
        }),
      ),
      await chainCase(
        'travelling_cert_names_another_key',
        'Step 2: same institution id, different certified key. A verifier that read ' +
          'institution_pubkey from the travelling cert rather than the anchor would accept a ' +
          'key of the attacker’s choosing.',
        identity({
          enrollment_cert: await makeInstitutionCert({
            institution_pubkey: await pub(OTHER_INSTITUTION_PRIV),
          }),
        }),
      ),
      await chainCase(
        'session_pubkey_sig_from_another_student',
        'Step 3: the countersignature came from a different student key.',
        identity({
          session_pubkey_sig: await signStudentSessionBinding(binding, OTHER_GLOBAL_STUDENT_PRIV),
        }),
      ),
      await chainCase(
        'session_pubkey_not_the_countersigned_one',
        'Step 3: a genuine countersignature lifted onto a different session key.',
        identity(),
        validCert,
        await pub(seed(0x19)),
      ),
      await chainCase(
        'expired_credential_is_NOT_fatal',
        'Step 4: an expired credential still returns ok, reporting token_window. An expired ' +
          'credential must never stop a recorder from recording (program spec §4); the ' +
          'analyzer decides.',
        identity({ enrollment: expiredCredential }),
      ),
      await chainCase(
        'expired_institution_cert_is_NOT_fatal',
        'Step 4, cert side. Same rule.',
        identity({ enrollment_cert: expiredCert }),
        expiredCert,
      ),
    ],

    legacy_2_0_note:
      'ARCHIVED COURSE-SCOPED IDENTITY MUST KEEP VERIFYING, PERMANENTLY. Every bundle recorded ' +
      'before this change carries a 2.0 identity block, and adjudicating a case years after the ' +
      'fact is the entire justification for this system (program spec §9). These cases run ' +
      'the SAME entry point a 2.1 bundle uses and must produce exactly the results ' +
      'enrollment.json pins — including the course_id triple comparison, which stays the ' +
      'mandatory forgery check for 2.0 material. A port whose router looks at field presence ' +
      'rather than the signed format_version will fail here.',
    legacy_2_0_cases: [
      await legacyCase(
        'archived_course_identity_still_verifies',
        'The unchanged 2.0 walk, reached through the version router.',
        legacyIdentity,
      ),
      await legacyCase(
        'archived_cross_course_forgery_still_refused',
        'The 2.0 mandatory check is untouched: 61B certifies an enrollment key "for 61C" and it ' +
          'mints a 61C token. Every signature genuine; only comparing course_id at every link ' +
          'rejects it.',
        {
          ...legacyIdentity,
          enrollment_cert: await makeEnrollmentCert({ course_id: OTHER_COURSE_ID }),
          enrollment: await makeEnrollmentToken({ course_id: OTHER_COURSE_ID }),
        },
      ),
    ],

    window_note:
      'Every window is judged against the RELEVANT ISSUE TIME, never wall-clock now, so an ' +
      'archived bundle still verifies years later in an adjudication. The institution cert is ' +
      "judged against the credential's issued_at; the credential is judged against the session " +
      'start. A date-only expires_at is inclusive THROUGH THE END of that day, exactly as ' +
      'course_cert.valid_until — same resolution rule, implemented once.',
    credential_window_cases: [
      credentialWindowCase('in_window', 'Mid-semester.', validCredential, '2026-10-01T00:00:00Z'),
      credentialWindowCase(
        'before_issued',
        'Session predates issuance.',
        validCredential,
        '2026-08-25T00:00:00Z',
      ),
      credentialWindowCase(
        'date_only_expiry_covers_that_whole_day',
        'expires_at 2027-01-15 covers all of Jan 15.',
        validCredential,
        '2027-01-15T23:59:59Z',
      ),
      credentialWindowCase(
        'date_only_expiry_ends_at_next_midnight',
        'and expires at the first instant of Jan 16.',
        validCredential,
        '2027-01-16T00:00:00Z',
      ),
      credentialWindowCase(
        'unparseable',
        'A bad instant reports unparseable_timestamp rather than throwing.',
        validCredential,
        'whenever',
      ),
    ],

    student_key_derivation: {
      note:
        'The CURRENT student key derivation: one master secret, ONE key, forever, across every ' +
        'course. Same HKDF-SHA256, same 32-byte master secret as IKM, same non-empty salt and ' +
        'same 32-byte output-is-the-ed25519-seed rule as the legacy per-course derivation in ' +
        'student-keys.json — the ONLY difference is the info string, which is now FIXED. ' +
        'Because the two info strings differ, a student’s existing per-course keys are ' +
        'untouched and archived bundles keep verifying against the pubkeys their tokens name; ' +
        'student-keys.json remains the contract for those and is unchanged.',
      hkdf_params: {
        hash: 'SHA-256',
        ikm: 'the 32 raw bytes of the master secret',
        salt_utf8: new TextDecoder().decode(STUDENT_KEY_HKDF_SALT),
        salt_hex: toHex(STUDENT_KEY_HKDF_SALT),
        info_utf8: STUDENT_KEY_HKDF_INFO,
        info_construction: 'UTF-8 bytes of info_utf8 verbatim — nothing is concatenated',
        output_length_bytes: STUDENT_KEY_SEED_BYTES,
        output_is: 'the ed25519 secret key (seed)',
      },
      encoding_note:
        'The v1 info concatenates a course_id, and a port encoding that as US_ASCII rather than ' +
        'UTF-8 silently derives a DIFFERENT key with no error — it bit provjet once, which is ' +
        'why student-keys.json keeps a berkeley-café case. Nothing is concatenated onto the ' +
        'v2 info and the constant is pure ASCII, so the hazard is retired rather than mitigated ' +
        'here. The v1 case stays live in student-keys.json for archived material.',
      master_secret_bytes: STUDENT_MASTER_SECRET_BYTES,
      derivation_cases: [
        await derivation(MASTER_SECRET_A, 'The baseline derivation.'),
        await derivation(MASTER_SECRET_B, 'A different student: a different key.'),
      ],
      differs_from_legacy_course_derivation: {
        note:
          'Same master secret, both derivations. These MUST NOT be equal — that is what keeps a ' +
          "student's archived per-course keys separate from their new global one.",
        master_secret_hex: toHex(MASTER_SECRET_A),
        global_pubkey_hex: (await deriveStudentKeypair(MASTER_SECRET_A)).publicKeyHex,
        legacy_course_id: COURSE_ID,
        legacy_pubkey_hex: (await deriveCourseKeypair(MASTER_SECRET_A, COURSE_ID)).publicKeyHex,
      },
    },
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

  // --- 11. S2 identity: enrollment_cert -> token -> session_pubkey_sig ---
  writeJson(outDir, 'enrollment.json', await buildEnrollmentVectors());

  // --- 12. S2 student master secret -> per-course key derivation ---
  writeJson(outDir, 'student-keys.json', await buildStudentKeyVectors());

  // --- 13. S5 git.event commit graph: sha / parents / branch ---
  writeJson(outDir, 'git-event.json', buildGitEventVectors());

  // --- 13b. Tier 4.1 peer.observed: peer witnessing (reader half) ---
  writeJson(outDir, 'peer-observed.json', buildPeerObservedVectors());

  // --- 13c. §5.6 session.start capability reports (reader + VS Code writer) ---
  writeJson(outDir, 'session-capabilities.json', buildSessionCapabilityVectors());

  // --- 14. S3 rolling seal: manifest-<session_id>.json at format_version 1.2 ---
  writeJson(outDir, 'rolling-manifest.json', await buildRollingManifestVectors());

  // --- 15. institution identity 2.1: institution_cert -> credential -> binding,
  //         plus the archived-2.0 cases that prove the version router works ---
  writeJson(outDir, 'identity.json', await buildInstitutionIdentityVectors());

  console.log(`Wrote conformance vectors to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
