import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `chain` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Key material ──────────────────────────────────────────────────────────
  rkpriv: {
    title: 'The root private key',
    body: 'It signs certificates and nothing else. It never touches a manifest, never reaches a server, and never appears in a build; the only artefact it produces is a course_cert vouching for one course’s public key over one validity window. That is the entire reason the layer exists. Before it, the recorder embedded a single course’s public key, so a second course meant a second VSIX, a second Marketplace listing, and a second release to keep in step with the first.\n\nConcentrating that much authority in one offline key is a deliberate trade. Holding it lets you certify any key for any course id, which is strictly more power than any single course key ever had. What buys it back is that it is used a handful of times a year, on a secured machine, and never by the people who run assignments — the minting tool refuses to hand out a certificate that does not verify against its own root public key before printing it, and the same tool exists precisely so course staff never need this file.',
    invariant:
      'The root key signs certificates only. A manifest signed directly by the root key is not a thing the format can express.',
    links: [
      { label: 'mint-course-cert.ts', href: `${GH}/tools/mint-course-cert.ts` },
      { label: 'course-cert.ts', href: `${GH}/packages/log-core/src/course-cert.ts` },
    ],
  },
  rkpub: {
    title: 'The root public key',
    body: 'One value, in three places, none of which is a secret. The recorder compiles it in as a single-line 64-hex constant whose shape is a contract: the production build locates it with a regex, rewrites it, packages the VSIX, then restores the file so local work continues on the dev key, and it refuses outright if the supplied value is missing, is not 64 lowercase hex, or equals the dev key committed to the repo. The server reads it from PROVENANCE_ROOT_PUBLIC_KEY_HEX and the browser bundle bakes in VITE_ROOT_PUBLIC_KEY_HEX, because analysis-core is isomorphic and is not allowed to hardcode a key of its own.\n\nUnset is a legitimate state on the analysis side and is handled as one. With no root key configured, validation check 2 reports skipped for a 2.0 bundle rather than guessing in either direction, and the roll-up turns a skipped check into a warn rather than a pass. Absence of the means to verify is reported as absence, never rounded up to clean.',
    invariant:
      'A production recorder build refuses to embed the dev root key. An unconfigured server or browser reports check 2 as skipped, never as a pass.',
    links: [
      {
        label: 'root-public-key.ts',
        href: `${GH}/packages/recorder/src/activation/root-public-key.ts`,
      },
      { label: 'embed-root-key.ts', href: `${GH}/tools/embed-root-key.ts` },
    ],
  },
  ckpriv: {
    title: 'The course private key',
    body: 'It signs one thing: the assignment manifest payload. Nothing in the running system ever verifies with it and no server holds it, so there is no deployment that needs it and no service whose compromise could leak it. The generator refuses to overwrite an existing file, refuses to write anywhere inside the repository, and sets mode 0600; even the hash-allowlist tooling that takes a keypair file reads only public_key_hex out of it.\n\nWhat changed under the trust chain is the blast radius of a rotation, not the handling. Holding this key still lets you mint a manifest for any folder, and a manifest is still both the permission to record and the input to the derivation that wraps every session key. But the public half is no longer compiled into anything, so rotating it is now a re-mint of one certificate rather than a new recorder build for every student — which is what makes a one-semester validity window a realistic policy instead of an aspiration.',
    invariant:
      'Never in the repo, in CI, or on a server. The only machine that needs it is a staff machine signing an assignment manifest.',
    links: [
      {
        label: 'generate-course-keypair.ts',
        href: `${GH}/tools/generate-course-keypair.ts`,
      },
      { label: 'sign-manifest.ts', href: `${GH}/tools/sign-manifest.ts` },
    ],
  },
  ckpub: {
    title: 'The course public key',
    body: 'This is the value the certificate exists to carry. It is not embedded anywhere any more: the recorder learns it at activation time, out of the course_cert sitting in the manifest it just opened, and trusts it only for as long as the root signature over that certificate holds. One recorder build therefore serves every course, and onboarding a course is minting a certificate rather than shipping software.\n\nIt is also the right identifier to revoke, and the spec is explicit about why. The certificate sits outside the course-signed payload, so the copy that travels with a student’s work is whichever one they were given; revoking a certificate is meaningless when the holder chooses which certificate ships. Revoking the public key it vouches for is not. That check is server-side only — an offline recorder cannot learn about revocation without breaking the no-network rule — and short validity windows are the accepted, stated mitigation for the gap.',
    links: [
      { label: 'course-cert.ts', href: `${GH}/packages/log-core/src/course-cert.ts` },
      {
        label: 'manifest-loader.ts',
        href: `${GH}/packages/recorder/src/activation/manifest-loader.ts`,
      },
    ],
  },
  lkpub: {
    title: 'The grandfathered legacy course key',
    body: 'A second, temporary trust anchor that exists only to keep already-issued work verifiable. Every Manifest 1.x file in the field was signed directly by a course key, carries no certificate, and will never be reissued; verifying one against the root key fails closed, which for a recorder means silent non-activation. So manifest-loader.ts routes on format_version — 2.0 walks the chain to the root key, 1.x is checked against this constant instead.\n\nThe part that is easy to get wrong is that the three recorders do not share this value. Each grandfathers its own prior embedded constant, because the point is to keep accepting the manifests that recorder already accepted, and the key that signed those is whatever it was verifying against. For the VS Code and JetBrains recorders that is a dev placeholder with the real key injected at build time; for the Neovim recorder there is no build step at all, so its constant shipped in every tagged release and signed every real 1.x manifest its users hold. Cross-wiring another recorder’s key there would silently end recording for all of them. The root key, by contrast, genuinely is one shared value.',
    invariant:
      'Scheduled for deletion. Once no 1.x manifest still needs verifying, this file, its course-keys.ts re-export, the 1.x branch in manifest-loader.ts, and its embedding step all go in one PR.',
    links: [
      {
        label: 'legacy-course-public-key.ts',
        href: `${GH}/packages/recorder/src/activation/legacy-course-public-key.ts`,
      },
      { label: 'course-keys.ts', href: `${GH}/packages/recorder/src/activation/course-keys.ts` },
    ],
  },
  skey: {
    title: 'The session keypair',
    body: 'A fresh ed25519 keypair per session, generated before the log file exists. The private key is never written in the clear: it is encrypted with XChaCha20-Poly1305 under a 32-byte key derived by HKDF-SHA256 from the hex-decoded manifest signature, with a random 16-byte salt and the fixed info string provenance-session-key-v1, and only that ciphertext reaches the .slog.meta sidecar. Decrypting with the wrong manifest signature does not yield garbage: the Poly1305 tag fails and the call throws.\n\nPer session rather than per student, because per student would need a key distribution the course does not have, and would make one leaked key retroactively fatal for everything that student ever submitted. Ephemeral keys cost nothing to create, need no directory, and confine a compromise to a single session. What they cannot do is prove who held them: the wrapping input is a signature every student in the course possesses, which is precisely the limit the tamper-resistance section states out loud.',
    links: [
      { label: 'session-keys.ts', href: `${GH}/packages/log-core/src/session-keys.ts` },
      {
        label: 'session-registry.ts',
        href: `${GH}/packages/recorder/src/session/session-registry.ts`,
      },
    ],
  },

  // ── Activation ────────────────────────────────────────────────────────────
  cert: {
    title: 'The course certificate',
    body: 'Four fields and a root signature, and it travels inline in the .provenance-manifest rather than as a file of its own. One file to discover and one to distribute means the certificate and the manifest cannot be separated by a copy, a move, or a .gitignore. It sits outside the course-signed payload, because a course does not sign its own authorization; buildSignedPayload excludes both sig and course_cert by construction.\n\nThe validity window is evaluated against the manifest’s issued_at, never against the wall clock. "Was this certificate valid when this manifest was issued" still has a stable answer during an adjudication in 2028; "is it valid today" does not. The bounds accept a date or a full timestamp, and a date-only bound resolves asymmetrically on purpose: valid_from opens at that day’s first instant, valid_until runs through the end of the day it names rather than expiring at its start, which is the reading a human takes from "valid until January 15".',
    invariant:
      'The window is checked against manifest.issued_at, never against now. An archived bundle must verify identically years later.',
    links: [
      { label: 'course-cert.ts', href: `${GH}/packages/log-core/src/course-cert.ts` },
      { label: 'mint-course-cert.ts', href: `${GH}/tools/mint-course-cert.ts` },
    ],
  },
  amf: {
    title: 'The assignment manifest',
    body: 'At 2.0 the signature covers nine fields — course_id, assignment_id, semester, issued_at, files_under_review, collaboration, submission, scope and the capture policy — canonicalized as a fresh object with sig and course_cert excluded. All of them are required rather than optional, which is not fussiness: a fixed key set means the Kotlin and Lua ports canonicalize without needing a rule for "which optionals were present", and that rule would be a divergence risk across three hand-written implementations. Unknown top-level keys are ignored for forward compatibility, and because canonicalization names its fields explicitly, an unknown key cannot quietly change the signed bytes.\n\nWhat moved into the signature is the interesting part. course_id is now inside it and must equal the certificate’s, or one course’s key could sign a manifest claiming to be another and both signatures would still verify — that equality is a mandatory conformance vector. policy is inside it because that is the only place it can be: a professor may turn capture down, and a student may not turn it off. Manifest has no format_version field at 1.x, so a missing one is defaulted to "1.0" and the file is accepted, never rejected.',
    links: [
      { label: 'manifest.ts', href: `${GH}/packages/log-core/src/manifest.ts` },
      { label: 'Recorder PRD §4.1', href: `${GH}/docs/prd.md` },
    ],
  },
  averify: {
    title: 'Walk the trust chain',
    body: 'Five steps in a fixed order, identical in all three recorders. Assert format_version is 2.0; validate the 2.0 shape; verify course_cert minus its root_sig against the embedded root key; verify the payload against the public key that certificate vouches for; assert the manifest’s course_id equals the certificate’s. Then check issued_at against the window, which is reported rather than enforced — see the policy node for why a lapsed certificate must not stop a class recording.\n\nThe first two steps are security controls and not formalities, which is why they run before any signature work. At 1.x, course_id, collaboration, submission, scope and policy are all outside the signed payload, so without the version gate a student could take a legitimately issued 1.x manifest from their own course, staple on that course’s certificate (public, root-signed, copyable from any 2.0 manifest), add a matching course_id, and staple on an invented policy disabling capture — and every signature would verify. And because canonicalize omits undefined-valued keys, a 2.0 manifest with no policy at all would sign and chain perfectly cleanly, so the shape check is what makes "the chain verified" imply "the course signed a policy".',
    invariant:
      'Chain-verify 2.0 only. A 1.x manifest takes the legacy path and has no policy — that gate is what denies students the capture off switch.',
    links: [
      { label: 'manifest.ts', href: `${GH}/packages/log-core/src/manifest.ts` },
      {
        label: 'manifest-loader.ts',
        href: `${GH}/packages/recorder/src/activation/manifest-loader.ts`,
      },
    ],
  },
  pol: {
    title: 'The capture policy',
    body: 'Four knobs, and the shape of the block is itself the enforcement mechanism. selection_change, focus_change and terminal are booleans; heartbeat_interval_ms is clamped to five seconds through two minutes. Every other event kind is on the hard floor, and the floor is enforced by there simply being no key that could express "off" for it. A manifest that carries a retired key, or an invented one, resolves it as an unknown key: ignored, never a gate. A missing block resolves to everything on at a thirty-second cadence, which is exactly v1.x behaviour, so a 1.x manifest changes nothing.\n\nWhere the floor is drawn follows one rule: a signal whose absence degrades correctness rather than merely detail must not be a knob. Sensitivity argues for a knob; being load-bearing vetoes one. Two candidates failed that test and were removed rather than shipped. doc_open_close, because doc.open’s content is the seed reconstruction starts from, so a course could switch off replay and the Source tab for its whole cohort with nothing warning it. And inline_content, which is the sharper case: every other knob makes the system see less evidence against a student, while that one made it see less evidence for one, because internal_move needs the paste content to downgrade a large_paste. A course being able to make the system more likely to falsely accuse its own students is not a legitimate configuration.\n\nA lapsed certificate does not stop recording. Refusing to activate would silently end recording for an entire class, which for an integrity tool is a worse failure than recording under a stale key, so the recorder records, stamps the expiry, and leaves the judgement to the analyzer.',
    invariant:
      'A floor event kind has no key in policy.capture. The schema is the enforcement; the exported list is only the assertable statement of it.',
    links: [
      { label: 'policy.ts', href: `${GH}/packages/log-core/src/policy.ts` },
      {
        label: 'policy-gating.test.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/policy-gating.test.ts`,
      },
    ],
  },
  bind: {
    title: 'The binding',
    body: 'There is no separate binding step to point at in the code. Two things happen at session start and together they are the binding. The manifest signature is copied verbatim into session.start’s payload, so the claim that this session was recorded against that assignment lives inside entry 0, covered by that entry’s hash and by every hash after it. And the session private key is wrapped under a key derived from the same signature, so the key that will sign this session’s checkpoints and its bundle manifest cannot be unwrapped from the sidecar without the assignment manifest it was issued for.\n\nWhat that buys is replay resistance, not authenticity. Last term’s log cannot be re-sealed under this term’s assignment: the old sidecar’s key only opens with the old signature, and the old entry 0 names the old assignment. What it cannot buy is proof of authorship: the wrapping input is a signature every student in the course holds, so possessing it is evidence of nothing.',
    invariant:
      'The session_pubkey that verification trusts is the copy inside chained entry 0, never the copy in the unchained .slog.meta sidecar.',
    links: [
      {
        label: 'recorder-context.ts',
        href: `${GH}/packages/recorder/src/session/recorder-context.ts`,
      },
      { label: 'session-keys.ts', href: `${GH}/packages/log-core/src/session-keys.ts` },
    ],
  },

  // ── The chain ─────────────────────────────────────────────────────────────
  gen: {
    title: 'GENESIS_PREV_HASH',
    body: 'Sixty-four ASCII zeros, pinned by a test that asserts the literal value. It is a formatting convention rather than a secret or a nonce: entry 0 gets a prev_hash of the right shape so the chaining function needs no special case for the first entry, and so the line validator can require a 64-hex prev_hash on every line without exception. Omitting the field at seq 0, or writing null, would have bought a branch in three language implementations and in every parser that reads the format.\n\nIts limit is worth stating. Zeros at the front stop nobody rewriting a log from scratch: a forger recomputes from genesis like everyone else. All the constant guarantees is that a log’s first entry cannot quietly claim to continue some earlier chain: a chain that starts anywhere else is not a chain this format recognises.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'hash-chain.test.ts', href: `${GH}/packages/log-core/src/hash-chain.test.ts` },
    ],
  },
  e0: {
    title: 'Entry 0 · session.start',
    body: 'Position zero is structural, not conventional. The loader rejects a .slog whose first entry is anything other than session.start, and sealing records session_id: null for a log where it cannot find one rather than guessing. The session id, the assignment, the format version, the session public key and the manifest signature all live in that single payload, so a log with no readable entry 0 is a log with no identity.\n\nAt 2.0 the payload also carries the whole manifest — the course-signed fields, its sig, and the root-signed course_cert — rather than only the signature over it. That is what turns check 2 from a consistency test into a verification, and it is also how the effective capture policy reaches the analyzer, which is the only way to tell "not recorded by policy" from "did not happen". The VS Code-shaped vscode block gives way to a host block naming the editor, its version, its build and the platform, so the JetBrains and Neovim recorders stop having to pretend into a field named after a different editor; vscode is retained as a deprecated alias on read for 1.x bundles.\n\nConcentrating all of it there is the point: everything verification needs later about what a session was sits at the head of the chain, where altering any of it invalidates every hash that follows. The obvious alternative (a separate header file, or the sidecar that already carries the same public key) would have put the verification anchor somewhere the chain does not reach.',
    links: [
      {
        label: 'parse-session.ts',
        href: `${GH}/packages/analysis-core/src/loader/parse-session.ts`,
      },
      { label: 'Recorder PRD §5.1', href: `${GH}/docs/prd.md` },
    ],
  },
  e1: {
    title: 'Entry 1 · doc.open',
    body: 'The chain does not read payloads. Chaining canonicalizes the whole envelope (seq, t, wall, kind and data together) and hashes it after the previous entry’s hash, so what is protected is not only the content of an event but its kind, its position and both of its timestamps. Deleting an entry, swapping two, or lifting one out of another session breaks the chain exactly as surely as editing a pasted string does.\n\nThat indifference is also what makes forward compatibility possible. The parser accepts unknown kind values on purpose, and because the hash covers the canonical JSON of whatever data happens to be present, an analyzer that has never heard of an event kind can still verify the chain it sits in. Integrity and extensibility usually pull against each other; they do not here, because the integrity layer was given no opinion about meaning.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'ndjson.ts', href: `${GH}/packages/log-core/src/ndjson.ts` },
    ],
  },
  e2: {
    title: 'Entry 2 · doc.change',
    body: 'This is the firehose (the editor fires one per keystroke), and it is why the chain is built out of hashes rather than signatures. Hashing an entry is a synchronous step cheap enough to sit inside a handler with a p99 budget of one millisecond. An ed25519 signature is far more expensive and asynchronous besides; signing every entry would have put a keypair operation between a student’s keystroke and their editor.\n\nSo the split is: hash everything, sign occasionally. Cheap linkage on every entry makes tampering locatable to an exact sequence number; a periodic signature over the chain state makes a range of it attributable to a key holder. Collapsing the two into one operation would either make the recorder unusable during ordinary typing or make signatures so rare that a session which crashed carried none at all.',
    invariant: 'Entries are hashed on the emit path, never signed there.',
    links: [
      { label: 'hash-chain.ts', href: `${GH}/packages/log-core/src/hash-chain.ts` },
      { label: 'Recorder PRD §4.7', href: `${GH}/docs/prd.md` },
    ],
  },
  e99: {
    title: 'Entry 99 · doc.save',
    body: 'A save is where the log makes a checkable claim about the world: it records the sha256 of the file’s bytes as they were on disk at that moment. Check 8 takes the last such hash for each reviewed file (from doc.save, doc.open or fs.external_change, whichever came last) and compares it against the sha256 in the signed bundle manifest. That comparison is what turns a log of edits into evidence about the artefact that was actually handed in.\n\nThat makes it the entry an attacker would most want to change, and a good place to count the cost. Altering a recorded save hash means recomputing that entry’s hash, therefore the prev_hash and hash of every entry after it in the session, therefore every checkpoint signature covering that range, and then re-signing the bundle manifest, which means first unwrapping the session key, which means holding the assignment manifest. Opening the file and editing one line fails at the first step.',
    links: [
      {
        label: 'verify-submitted-code.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-submitted-code.ts`,
      },
      { label: 'Recorder PRD §5.4', href: `${GH}/docs/prd.md` },
    ],
  },
  e100: {
    title: 'The signed checkpoint',
    body: 'Two things about this box are not what the drawing suggests. A checkpoint is not a log entry. It is a record appended to the .slog.meta sidecar (a seq, the hash at that seq, and an ed25519 signature over the canonical form of the pair) describing an entry that is itself an ordinary event of whatever kind. And the cadence counts entries actually written, so the first checkpoint lands on the hundredth write, and entries dropped in degraded mode never advance the counter.\n\nCheckpoints exist because the chain proves consistency, not authorship. A log rewritten from genesis is perfectly self-consistent (every link recomputes), so what a checkpoint adds is a signature over the chain state at a point, which cannot be produced without the session key. They are written every hundred entries rather than once at seal because sessions end badly more often than they end cleanly, and a signature that exists only at seal time is a signature a crashed session never has. Signing stays off the entry path: the operation is chained onto a pending promise that teardown drains.\n\nNothing yet checks them. log-core exports and tests a checkpoint verifier and the loader shape-validates the sidecar, but no validation check verifies a checkpoint signature, so today they are evidence available to a reviewer rather than evidence the pipeline acts on.',
    links: [
      {
        label: 'checkpoint-signer.ts',
        href: `${GH}/packages/log-core/src/checkpoint-signer.ts`,
      },
      {
        label: 'session-registry.ts',
        href: `${GH}/packages/recorder/src/session/session-registry.ts`,
      },
    ],
  },

  // ── Seal ──────────────────────────────────────────────────────────────────
  bman: {
    title: 'manifest.json',
    body: 'Beyond what the box lists, the manifest carries the part check 8 depends on: submission_files, the final on-disk sha256 of every path in files_under_review, with files that were absent at seal recorded explicitly as missing with a null hash rather than omitted. A file that vanished and a file that was never listed are different facts, and the manifest keeps them different.\n\nPer-log hashes rather than one hash over the archive, for a mundane reason: the manifest sits inside the zip it describes and cannot hash itself. Naming each .slog and .slog.meta individually also means a session whose chain failed to validate still appears, with its hash, instead of being quietly dropped: sealing warns and continues. And because these bytes are signed they are frozen: the server strips student source out of stored bundles but never touches manifest.json, which is what keeps an archived bundle verifiable years later.',
    links: [
      { label: 'seal.ts', href: `${GH}/packages/recorder/src/commands/seal.ts` },
      { label: 'bundle.ts', href: `${GH}/packages/log-core/src/bundle.ts` },
    ],
  },
  bsig: {
    title: 'manifest.sig',
    body: 'Signed with the session private key, not the course key: the course key has been offline since the assignment was issued and never sees a bundle. So this signature does not mean that the course endorses this submission; it means the bundle was produced by the holder of a key wrapped under this assignment’s manifest signature. The file holds the hex signature over exactly the canonical JSON written to manifest.json, and both are written atomically, so an interrupted seal cannot leave a signature over bytes that are not there.\n\nSealing signs with the currently active session’s key while the manifest describes every log in the directory, several sessions, several keys. That is why verification tries the newest session’s public key first and then falls back through the rest rather than assuming a particular one: a bundle sealed during the third session is signed by the third session’s key and must still verify.',
    links: [
      { label: 'bundle-sign.ts', href: `${GH}/packages/log-core/src/bundle-sign.ts` },
      {
        label: 'verify-manifest-sig.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-manifest-sig.ts`,
      },
    ],
  },
  zip: {
    title: 'The bundle .zip',
    body: 'Flat, with no directories: everything in .provenance/ goes in at the top level, and the reviewed files go in beside them at their workspace-relative paths. Two classes of file are deliberately left out (quarantined .corrupt- logs from a failed chain recovery, and .tmp leftovers from an interrupted atomic write), so the archive contains nothing unparseable, while the recovery event inside the log still records that a quarantine happened.\n\nThe loader treats the contents as a closed set. manifest.json, manifest.sig and the per-session .slog / .slog.meta pairs are recognised by name; anything else is accepted only if the manifest names it in submission_files, and any remaining entry fails the load outright. A log with no sidecar, or a sidecar with no log, is its own distinct error. Strictness is cheap here, and it means no later stage ever has to reason about what an unexplained file in a bundle might be.',
    links: [
      { label: 'seal.ts', href: `${GH}/packages/recorder/src/commands/seal.ts` },
      { label: 'unzip.ts', href: `${GH}/packages/analysis-core/src/loader/unzip.ts` },
    ],
  },

  // ── Verification ──────────────────────────────────────────────────────────
  vchain: {
    title: 'Walk the chain',
    body: 'Each entry is recomputed against its own recorded prev_hash rather than against a running value carried forward, a deliberate difference from the recorder-side validator, which walks linkage and stops at the first break. Cascading would be worse than useless during review: one deleted line in the middle of a session would report every entry after it as tampered, burying the one entry that actually is. Linkage gaps are a separate check; this one answers only whether an entry hashes to what it claims.\n\nThe output is therefore a list of exact sequence numbers rather than a boolean, and those numbers travel all the way through to the flag as deep links into the timeline. The check also has to work years later on a machine that has never seen the recorder, which is why it needs nothing but the bundle: the rule is a sha256 over a canonical string, with no key and no service in the loop.',
    invariant:
      'An entry is broken only if it fails against its own prev_hash. One tampered entry is reported as one failure, never as every entry after it.',
    links: [
      {
        label: 'verify-chain.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-chain.ts`,
      },
      { label: 'chain-validator.ts', href: `${GH}/packages/log-core/src/chain-validator.ts` },
    ],
  },
  vsig: {
    title: 'Verify manifest.sig',
    body: 'The verifier does not keep the bytes that were signed. It parses manifest.json, re-canonicalizes the parsed object, and verifies the signature over that string, so the determinism of JCS is load-bearing at verification time and not only at signing time. A verifier that re-serialized with an ordinary JSON writer would produce different bytes and reject a perfectly good signature. This is the concrete reason canonicalization is a library rather than something each implementation writes for itself.\n\nThe public key it verifies against is read from session.start’s payload, inside the hash chain, rather than from the .slog.meta sidecar that carries the same key with no chain protecting it. Trusting the sidecar copy would let a forger substitute their own public key and re-sign the manifest without touching the log at all.',
    links: [
      {
        label: 'verify-manifest-sig.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-manifest-sig.ts`,
      },
      { label: 'canonical.ts', href: `${GH}/packages/log-core/src/canonical.ts` },
    ],
  },
  vbind: {
    title: 'Verify the session binding',
    body: 'For a 2.0 bundle this is now a real cryptographic check, walked entirely offline and trusting nothing from the server. The full manifest rides inside every session.start, so the analyzer re-walks the same five steps the recorder walked at activation — certificate against the configured root key, payload against the key that certificate vouches for, course_id equality — and then requires every session’s recorded manifest_sig to equal the embedded sig. That last equality is what ties the verified manifest to the keys: manifest_sig is the HKDF input the session keypair was wrapped under, so it binds the document the analyzer just verified to the key that signed this session’s checkpoints and the bundle seal.\n\nEarlier bundles keep the older, weaker guarantee, permanently. For them the check remains what it always was: all sessions must share one manifest_sig, which catches a bundle assembled from sessions recorded against different assignments and passes trivially on a single session. Archived submissions must keep validating years later, so that path is not going away.\n\nWhich path a bundle takes is decided by the embedded manifest’s format_version, never by whether one is embedded at all. That distinction is the whole ballgame, because all three recorders write session.start.data.manifest unconditionally — a 1.x manifest travels inside a bundle too, and emitting it always is what lets a reader tell "this signal was disabled by policy" from "this recorder was too old to say". A reader that treats the mere presence of a manifest as a 2.0 claim sends every grandfathered 1.x bundle into the chain walk, which correctly refuses it at step 0 as not-2.0 — turning a course that simply has not reissued its manifests into a cohort where every single submission fails validation. Nothing is lost by trusting a version field on an unverified document, either: the 2.0-only fields are stripped from anything below 2.0 at parse, so a downgraded manifest arrives carrying no certificate, no course_id and no policy, and buys the student a plain 1.x bundle and nothing more.\n\nTwo outcomes are deliberately not failures. With no root key configured the check reports skipped rather than guessing, and skipped rolls the bundle up to warn rather than pass. And a certificate that had lapsed by the time the manifest was issued is reported in the detail text while the check still passes: every signature verifies, so the bundle is not tampered with — the course is late on its paperwork, and that is a different finding.',
    invariant:
      'Legacy vs 2.0 is decided by the embedded manifest’s format_version, never by its presence — a current recorder embeds 1.x manifests too. An unconfigured root key reports skipped, never pass. An expired certificate is reported, never failed — the signatures still verify.',
    links: [
      {
        label: 'verify-session-binding.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-session-binding.ts`,
      },
      {
        label: 'bundle-manifest.ts',
        href: `${GH}/packages/analysis-core/src/manifest/bundle-manifest.ts`,
      },
    ],
  },
  verdict: {
    title: 'Any link, signature or binding broken?',
    body: 'This diamond covers three of the eight validation checks, and it is not a gate. A failing verdict stops nothing: ingest completes, the bundle is stored, statistics and heuristics still run, and the outcome is a flag on a submission a reviewer may never open. The recorder behaves the same way at the other end, where sealing never aborts on a broken chain. There is no point anywhere in the system at which an integrity failure blocks a path; it only changes a ranking.\n\nThe roll-up across all eight checks has one asymmetry worth knowing: a check that could not run does not count as a pass. Any failure makes the bundle fail, and no failure but a skipped check makes it warn. An absence of evidence is reported as an absence rather than rounded up to clean.',
    links: [
      {
        label: 'run-validation.ts',
        href: `${GH}/packages/analysis-core/src/validation/run-validation.ts`,
      },
      { label: 'Recorder PRD §5.4', href: `${GH}/docs/prd.md` },
    ],
  },
  ok: {
    title: 'Valid · chain intact',
    body: 'This verdict is narrower than it looks. It says the entries are internally consistent, that the bundle manifest was signed by a key wrapped under an assignment manifest, and that nothing in the bundle contradicts anything else in it. It says nothing about who wrote the code.\n\nThe project is explicit about why. The key that signs a bundle is derivable from a manifest every student in the course already has, so anyone willing to build a tool that synthesises a plausible editing session can produce a bundle that passes every check here. The claim is not that the log is tamper-proof; it is that casual tampering is detected, that reasonable-effort tampering is detected, and that a full forgery costs more work than doing the assignment. A clean verdict is the floor for taking the rest of the evidence seriously, not a conclusion on its own.',
    links: [
      { label: 'Recorder PRD §6', href: `${GH}/docs/prd.md` },
      {
        label: 'run-validation.ts',
        href: `${GH}/packages/analysis-core/src/validation/run-validation.ts`,
      },
    ],
  },
  bad: {
    title: 'A high-severity flag',
    body: 'Integrity findings enter the same ranked flag list as the behavioural heuristics, at severity high and confidence 1.0, the 1.0 because a hash either recomputes or it does not, which is a different sort of claim from “this paste looks large for this assignment”. High is the largest of the four severity weights, so a broken chain rises to the top of a cohort list without anyone tuning anything.\n\nThe supporting sequence numbers become deep links into the timeline, which is what the exact failing seq means in practice. It does not always exist: a manifest-signature failure has no particular entry to blame, so that flag carries no sequence numbers at all. And it stays a flag: the spec is explicit that tampering, a crashed recorder and a corrupted disk look alike from outside, and that a human decides what any of them means.',
    links: [
      {
        label: 'integrity-flags.ts',
        href: `${GH}/packages/analysis-core/src/heuristics/integrity-flags.ts`,
      },
      { label: 'Recorder PRD §5.4', href: `${GH}/docs/prd.md` },
    ],
  },
};

/** Self-explanatory labels that deliberately carry no detail panel. */
export const noDetail: string[] = ['edots'];
