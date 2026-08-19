// NDJSON serialization
export { serializeEntry, parseEntries } from './ndjson.js';
export type { ParseError } from './ndjson.js';

// Buffer policy
export { shouldFlush, DEFAULT_BUFFER_POLICY } from './buffer-policy.js';
export type { BufferPolicyInput, BufferPolicyConfig } from './buffer-policy.js';

// Meta (.slog.meta)
export { validateMetaShape } from './meta.js';
export type { SlogMeta, MetaShapeError } from './meta.js';

// Bundle (manifest.json + validation report)
export { validateBundleManifestShape } from './bundle.js';
export type {
  BundleManifest,
  SubmissionFileEntry,
  BundleShapeError,
  ValidationReport,
} from './bundle.js';

// Rolling seal — per-session manifest-<session_id>.json (git-native submission)
export {
  ROLLING_MANIFEST_FORMAT_VERSION,
  rollingManifestFilenames,
  parseRollingManifestFilename,
  validateRollingSessionManifest,
  describeRollingManifestError,
} from './rolling-manifest.js';
export type { RollingSessionManifest, RollingManifestError } from './rolling-manifest.js';

// Prefix digests — reading a rolling seal's log commitment as the PREFIX
// commitment it actually is. See prefix-digest.ts.
export { findSha256PrefixLength } from './prefix-digest.js';

// Bundle manifest signing (shared by recorder seal + seed tooling)
export { signBundleManifest } from './bundle-sign.js';
export type { SignedBundleManifest } from './bundle-sign.js';

// Per-session ephemeral keypair + private-key encryption (recorder PRD §4.6)
export {
  generateSessionKeypair,
  encryptSessionPrivkey,
  decryptSessionPrivkey,
} from './session-keys.js';
export type { SessionKeypair, EncryptedPrivkey } from './session-keys.js';

// Signed seq→hash checkpoints (recorder PRD §4.6)
export { signCheckpoint, verifyCheckpoint } from './checkpoint-signer.js';
export type { Checkpoint } from './checkpoint-signer.js';

// Assignment manifest (.provenance-manifest / provenance-manifest)
export {
  parseManifest,
  parseManifestValue,
  verifyManifest,
  signManifest,
  verifyManifestChain,
  manifestFormatVersion,
  MANIFEST_FORMAT_VERSION_LEGACY,
  MANIFEST_FORMAT_VERSION_2,
} from './manifest.js';
export type {
  Manifest,
  ManifestError,
  ManifestChainError,
  ManifestChainOk,
  ManifestCollaboration,
  ManifestSubmission,
  ManifestScope,
} from './manifest.js';

// Course certificate (root → course key, Manifest 2.0 trust chain)
export {
  parseCourseCert,
  verifyCourseCert,
  signCourseCert,
  checkCertWindow,
  buildCourseCertSignedPayload,
  parseIsoInstantMs,
} from './course-cert.js';
export type { CourseCert, CourseCertError, CertWindowStatus } from './course-cert.js';

// Enrollment cert + token (course → enrollment key → student key, S2 identity chain)
export {
  parseEnrollmentCert,
  parseEnrollmentToken,
  signEnrollmentCert,
  signEnrollmentToken,
  signSessionPubkey,
  verifyEnrollmentCert,
  verifyEnrollmentToken,
  verifySessionPubkeySig,
  verifyIdentityChain,
  checkTokenWindow,
  checkEnrollmentCertWindow,
  buildEnrollmentCertSignedPayload,
  buildEnrollmentTokenSignedPayload,
  buildSessionPubkeyBindingPayload,
  ENROLLMENT_FORMAT_VERSION,
  SESSION_PUBKEY_BINDING_PURPOSE,
} from './enrollment.js';
export type {
  EnrollmentCert,
  EnrollmentError,
  IdentityChainError,
  IdentityChainOk,
} from './enrollment.js';

// Institution cert + student credential (root → institution key → student key).
// The CURRENT identity chain; `enrollment.ts` above is the legacy course-scoped
// one, kept live forever for archived bundles.
export {
  parseInstitutionCert,
  parseStudentCredential,
  signInstitutionCert,
  signStudentCredential,
  signStudentSessionBinding,
  verifyInstitutionCert,
  verifyStudentCredential,
  verifyStudentSessionBinding,
  checkInstitutionCertWindow,
  checkCredentialWindow,
  buildInstitutionCertSignedPayload,
  buildStudentCredentialSignedPayload,
  buildStudentSessionBindingPayload,
  INSTITUTION_IDENTITY_FORMAT_VERSION,
  STUDENT_SESSION_BINDING_PURPOSE,
} from './institution.js';
export type { InstitutionCert, StudentCredential, InstitutionError } from './institution.js';

// Student master secret + key derivation (S2).
// `deriveStudentKey*` is the current global derivation; `deriveCourseKey*` is the
// legacy per-course one, retained for archived material.
export {
  deriveCourseKeySeed,
  deriveCourseKeypair,
  deriveStudentKeySeed,
  deriveStudentKeypair,
  generateStudentMasterSecret,
  STUDENT_KEY_HKDF_INFO_PREFIX,
  STUDENT_KEY_HKDF_INFO,
  STUDENT_KEY_HKDF_SALT,
  STUDENT_KEY_SEED_BYTES,
  STUDENT_MASTER_SECRET_BYTES,
} from './student-keys.js';
export type { StudentCourseKeypair } from './student-keys.js';

// Capture policy (professor-facing capture controls)
export {
  resolveCapturePolicy,
  isEventKindCaptured,
  DEFAULT_CAPTURE_POLICY,
  FLOOR_EVENT_KINDS,
  POLICY_GATED_EVENT_KINDS,
  HEARTBEAT_INTERVAL_MIN_MS,
  HEARTBEAT_INTERVAL_MAX_MS,
} from './policy.js';
export type { CapturePolicy, CapturePolicyBlock } from './policy.js';

// Events
export type {
  EventKindMap,
  EventKind,
  EventPayload,
  Position,
  Range,
  DocChangeDelta,
  HostInfo,
  EnrollmentToken,
  SessionIdentity,
  SessionStartPayload,
  SessionHeartbeatPayload,
  SessionResumedPayload,
  SessionEndPayload,
  DocOpenPayload,
  DocChangePayload,
  DocSavePayload,
  DocClosePayload,
  PastePayload,
  SelectionChangePayload,
  FocusChangePayload,
  TerminalOpenPayload,
  TerminalCommandPayload,
  ExtSnapshotPayload,
  ExtActivatePayload,
  FsExternalChangePayload,
  GitEventPayload,
  ClockSkewPayload,
  PasteAnomalyPayload,
  ChainBrokenPayload,
  RecorderDegradedPayload,
  RecorderRecoveredFromCorruptionPayload,
} from './events.js';

// Envelope
export type { Envelope, HashedEnvelope } from './envelope.js';

// Canonicalization
export { canonicalize } from './canonical.js';

// Hash chain
export { chainEntry, sha256Hex, GENESIS_PREV_HASH } from './hash-chain.js';
export type { HashFn } from './hash-chain.js';

// Chain validator
export { validateChain } from './chain-validator.js';
export type { ChainBreak, ValidationResult } from './chain-validator.js';

// Result
export { ok, err } from './result.js';
export type { Result } from './result.js';

// Clock
export { SystemClock, FixedClock } from './clock.js';
export type { Clock } from './clock.js';
