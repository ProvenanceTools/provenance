import type { ArchNode } from '../types.js';
import { GH } from './links.js';

/** Nodes in the `chain` diagram. Keys are bare dot node names. */
export const nodes: Record<string, ArchNode> = {
  // ── Key material ──────────────────────────────────────────────────────────
  rkpriv: {
    title: 'The root private key',
    body: 'It signs certificates and nothing else. It never touches a manifest, never signs a credential, never reaches a server, and never appears in a build. Two artefacts hang off it and both are certificates: a course_cert vouching for one course’s public key over one validity window, and an institution_cert vouching for one institution’s. That is the entire reason the layer exists. Before it, the recorder embedded a single course’s public key, so a second course meant a second VSIX, a second Marketplace listing, and a second release to keep in step with the first.\n\nThe two chains beneath it are shaped differently on purpose, and the difference is where the signing key can live. The course key is deliberately offline, held by staff, so it can sign an assignment manifest at leisure and cannot be reached by anything on the network — which also means it can never issue anything on demand. The institution key can, because it lives on the server: a student arriving at /enroll needs a credential minted while they wait, and a chain that required an offline key to be touched per student is a chain nobody would operate. So the student side is one delegation hop from root and the course side is two, and that asymmetry is a statement about operational reachability rather than about trust levels.\n\nConcentrating that much authority in one offline key is a deliberate trade. Holding it lets you certify any key for any course or institution id, which is strictly more power than any single course key ever had. What buys it back is that it is used a handful of times a year, on a secured machine, and never by the people who run assignments — the minting tools refuse to hand out a certificate that does not verify against their own root public key before printing it, and they exist precisely so course staff never need this file.',
    invariant:
      'The root key signs certificates only — course certs and institution certs. A manifest or a credential signed directly by the root key is not a thing the format can express.',
    links: [
      { label: 'mint-course-cert.ts', href: `${GH}/tools/mint-course-cert.ts` },
      { label: 'course-cert.ts', href: `${GH}/packages/log-core/src/course-cert.ts` },
      { label: 'institution.ts', href: `${GH}/packages/log-core/src/institution.ts` },
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

  // ── Student identity 2.1 ──────────────────────────────────────────────────
  icert: {
    title: 'institution_cert',
    body: 'The root key vouching for one institution’s public key over one validity window: institution_id, institution_pubkey, valid_from, valid_until, root_sig. Structurally it is the course_cert’s twin, and the resemblance is not accidental — a recorder verifying either walks the same shape from the same embedded root key with no network.\n\nWhat it delegates is different. A course_cert authorises signing ASSIGNMENT MANIFESTS, and its private half stays offline. This authorises signing STUDENT CREDENTIALS, and its private half lives on the server, because credentials must be issued on demand to a student sitting at a browser. One hop instead of two follows directly: 2.0 needed a course_cert and then a per-student enrollment_cert because the course key could not be reached at enrolment time; here the certified key is already reachable.\n\nThe check that makes the delegation real is conformance of ids, and it is mandatory rather than advisory: the credential’s institution_id, this certificate’s institution_id and the trust anchor’s must all be the same value, and the certificate’s public key must be the one the root actually vouched for. Without it a credential minted by one institution would verify inside another’s scope — the cross-institution analogue of the cross-course forgery the 2.0 chain already has to refuse.\n\nThere is no institutions table anywhere in the server schema, and that is consistent rather than an omission: institution_id is read off this signed certificate, not looked up. A value nothing signed is not an institution.',
    invariant:
      'Certificate, credential and anchor must all name the SAME institution_id. Anything else is a cross-institution forgery, whatever else verifies.',
    links: [
      { label: 'institution.ts', href: `${GH}/packages/log-core/src/institution.ts` },
      { label: 'enrollment.ts (2.0)', href: `${GH}/packages/log-core/src/enrollment.ts` },
    ],
  },
  scred: {
    title: 'student_credential',
    body: 'One student’s long-lived public key, signed by the institution key: institution_id, student_ref, student_pubkey, issued_at, expires_at, institution_sig. It is obtained once, in a browser, at /enroll, and every session after that is offline.\n\nIt is institution-scoped, not course-scoped, and that replaced 2.0 on evidence rather than on preference. The 2.0 mint path required a roster_entries match before it would issue anything, and rosters are populated by Gradescope ingest — which runs only AFTER a student submits. A student therefore could not enrol before their first submission, which is precisely when they need to. That is a deadlock, not a rough edge, and the fix was to key identity on the institution and the SSO subject so a credential is allocatable with no roster row in existence; linking to a roster row happens later, in either direction, and returns harmlessly empty when there is nothing to link.\n\nThe cost is stated rather than hidden. Derivation is fully global — no user-derived input in the HKDF info — so the recorder can show a student their own public key with zero configuration, and cross-institution unlinkability is gone. That was taken deliberately.\n\nMultiple machines is a first-class flow, not a migration. Each machine enrols independently and generates its own keypair; the shared student_ref is what groups them into one contributor, so nothing has to be copied between machines and export/import exists as a BACKUP path rather than as a step anyone must perform. Every issuance is appended to student_credentials rather than overwriting the row, because verification is a signed artefact consulting no server while adjudication asks a question about history — was this key ever theirs — and an overwritten column cannot answer it.\n\nA credential is public material and is treated as such at both ends. A master secret and a public key are both sixty-four lowercase hex characters, and the paste box’s whole-document fallback once extracted whichever single hex run it found, so a student could paste their private master secret into /enroll and ship it to the server. Secrets now carry an explicit provenance-secret-v1: marker and are refused on sight, at both ends.',
    invariant:
      'Allocatable before any roster row exists — that is the whole point. And the server stores public keys only; a database breach forges nobody.',
    links: [
      { label: 'institution.ts', href: `${GH}/packages/log-core/src/institution.ts` },
      {
        label: '0027_student_credentials.sql',
        href: `${GH}/packages/server/db/migrations/0027_student_credentials.sql`,
      },
    ],
  },
  sbind: {
    title: 'Countersigning the session key',
    body: 'The last hop. The student’s long-lived private key signs a payload naming the institution, a fixed purpose string, the session’s ephemeral public key and the student_ref, and that signature rides into session.start’s identity block. A reader who walks root → institution_cert → student_credential → this signature has established, offline and from the archive alone, that the holder of a credentialled key was present when this session started.\n\nA keypair rather than a bearer token, and the difference is repudiation. A uuid is copyable, so "someone must have got hold of my token" is always available and is unfalsifiable. A signature over this session’s ephemeral key is not, and the server never holds anything that could produce one — only public keys — so a database breach forges nobody.\n\nThe purpose string is in the signed payload for the reason every domain separator is: without it a signature produced for one purpose could be replayed as one produced for another, and a countersignature that means "this is my session key" must not also be readable as "this is my anything else".\n\nWhat this does NOT establish is worth stating, because the three-state contributor vocabulary downstream depends on it. A session with no identity block at all is unattributed, and that is the ordinary, blameless state for almost every bundle in existence — the recorder records regardless, because never blocking recording matters more than always knowing who. A block that is present and does not verify is unverifiable, and it is never merged into the contributor it names, since honouring an unverified claim is exactly how work would be laundered onto an innocent student.',
    invariant:
      'Identity comes only from session.start.identity — never machine_id, never a git author, never the filename a submission was uploaded under.',
    links: [
      { label: 'institution.ts', href: `${GH}/packages/log-core/src/institution.ts` },
      {
        label: 'resolve-contributors.ts',
        href: `${GH}/packages/analysis-core/src/identity/resolve-contributors.ts`,
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
    body: 'Position zero is structural, not conventional. The loader rejects a .slog whose first entry is anything other than session.start, and sealing records session_id: null for a log where it cannot find one rather than guessing. The session id, the assignment, the format version, the session public key and the manifest signature all live in that single payload, so a log with no readable entry 0 is a log with no identity.\n\nAt 2.0 the payload also carries the whole manifest — the course-signed fields, its sig, and the root-signed course_cert — rather than only the signature over it. That is what turns check 2 from a consistency test into a verification, and it is also how the effective capture policy reaches the analyzer, which is the only way to tell "not recorded by policy" from "did not happen". The VS Code-shaped vscode block gives way to a host block naming the editor, its version, its build and the platform, so the JetBrains and Neovim recorders stop having to pretend into a field named after a different editor; vscode is retained as a deprecated alias on read for 1.x bundles.\n\nThe VS Code recorder now also emits the S2 identity block when the student holds an identity: the credential, the certificate that authorizes whichever key issued it, and the student key’s signature over this session’s ephemeral session_pubkey. At 2.1 that needs nothing from the manifest — the anchor is the recorder’s own embedded ROOT public key, which it root-verifies the institution_cert against before using it — so a student is attributed even in a workspace whose manifest is 1.x. At 2.0 the anchor was the manifest’s course_cert, and the block appeared only when the student held a token for that specific course. That last signature is what attaches a named contributor to an otherwise anonymous session key. The recorder walks the whole chain with verifyIdentityChain before writing it and drops a block that does not verify, because a broken claim inside a hash chain is permanent. When there is no token the field is omitted entirely and recording continues unchanged — an unenrolled student, an unavailable keyring, or a lapsed certificate must never stop a session, which is the same reasoning the capture policy applies to an expired course_cert. Enrollment arrives by paste, never by fetch; the recorder makes no network call for identity or anything else.\n\nTwo identity shapes now share those same two wire slots, told apart by the signed format_version inside the cert slot rather than by which fields are present. The 2.0 chain is course-scoped: a course-signed enrollment_cert authorizing an enrollment key, which mints a per-course token. The 2.1 chain replaces it and is institution-scoped: root certifies an institution key directly, that key issues one student_credential per student — one ref, globally, across every course — and the same countersignature attaches it to the session key. Course-scoping had to go because minting a 2.0 token required a roster match, rosters are populated by submission, and a student’s sessions need an identity before they work. A recorder holding BOTH prefers 2.1 and does not fall back to 2.0 if the 2.1 path fails: the two families carry different student_refs, so a silent fallback would attribute the session to a different contributor than the student believes and bury the fault that caused it. The slot names are historical and deliberately unchanged, because renaming them would have forced the version discriminator to be found by looking at which fields exist — the exact mistake that once made the whole legacy manifest path unreachable. 2.0 is walked forever, unchanged, so an archived bundle still attributes during an adjudication years from now.\n\nOn the reading side analysis-core resolves each session.start.identity into exactly one of three states and stamps the result on the Bundle, so nothing downstream re-derives it: attributed (the chain verified against root-anchored trust material — we know who), unattributed (no identity block at all — an ordinary, blameless state that must never read as suspicious), and unverifiable (a block that is present and that we could not stand behind). Those last two are different facts and collapsing either into the other is a wrongful-accusation bug: hiding a forged claim in one direction, manufacturing a finding against a student whose only act was not enrolling in the other. Within unverifiable, "we cannot check" — no root public key configured on this deployment, or no root-verified anchor in this bundle — stays distinguishable from "we checked and it failed". A deployment with no root key still loads and analyses bundles; it simply cannot attribute them. Sessions group by student_ref, namespaced by version and scope, because it is the only field here that is stable across machines: a session_pubkey is per-session ephemeral and could never group, and unattributed sessions are singleton pseudo-contributors — two unenrolled people are indistinguishable from one, and claiming otherwise would be a fabricated relationship.\n\nThree more optional fields joined those slots at §5.6, and they are a different KIND of thing from everything else in the payload: git_capture, witness_capture and file_scope report what this recorder was ABLE to observe, not what it observed. They are optional PERMANENTLY, because 1.x support is permanent, and absence is therefore never a claim — absent is not unavailable, and a reader that rounded one up to the other would say "witnessing was impossible here" about every bundle recorded before the fields existed. Nothing branches on them, none of them is ever a Flag, and nothing was added to policy.capture, because a capability report says "I could not" where a knob says "I was told not to". They exist so an existing finding reads correctly — git_unrecorded_in above all — and so the coverage stage can say "we could not check" instead of implying "there was nothing to check". Omission is the writer rule: an absent key and a null value canonicalize differently and therefore chain to different hashes, which the conformance vector pins character for character alongside the pre-§5.6 payload spelled literally, so the bytes cannot move unnoticed.\n\nConcentrating all of it there is the point: everything verification needs later about what a session was sits at the head of the chain, where altering any of it invalidates every hash that follows. The obvious alternative (a separate header file, or the sidecar that already carries the same public key) would have put the verification anchor somewhere the chain does not reach.',
    links: [
      {
        label: 'parse-session.ts',
        href: `${GH}/packages/analysis-core/src/loader/parse-session.ts`,
      },
      {
        label: 'resolve-contributors.ts',
        href: `${GH}/packages/analysis-core/src/identity/resolve-contributors.ts`,
      },
      { label: 'institution.ts', href: `${GH}/packages/log-core/src/institution.ts` },
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
    body: 'Two things about this box are not what the drawing suggests. A checkpoint is not a log entry. It is a record appended to the .slog.meta sidecar (a seq, the hash at that seq, and an ed25519 signature over the canonical form of the pair) describing an entry that is itself an ordinary event of whatever kind. And the cadence counts entries actually written, so the first checkpoint lands on the hundredth write, and entries dropped in degraded mode never advance the counter.\n\nCheckpoints exist because the chain proves consistency, not authorship. A log rewritten from genesis is perfectly self-consistent (every link recomputes), so what a checkpoint adds is a signature over the chain state at a point, which cannot be produced without the session key. They are written every hundred entries rather than once at seal because sessions end badly more often than they end cleanly, and a signature that exists only at seal time is a signature a crashed session never has. Signing stays off the entry path: the operation is chained onto a pending promise that teardown drains.\n\nThe cadence now carries two more pieces of work, in a fixed order: the peer-observation drain runs first so its entries land in bytes the seal will cover, and then this session’s rolling seal is rewritten. A failure to write that seal is logged and dropped — it never aborts the checkpoint and never stops recording, because losing the recording to save the receipt is backwards.\n\nThe checkpoints were, for a long time, evidence nobody checked. log-core exported and tested a verifier, the loader shape-validated the sidecar, and no validation check ever verified a signature, which meant an appended, correctly-chained entry passed all eight checks. That hole is closed by checkpoint_chain_valid, a bundle-level detection rather than a ninth check, since the eight are a frozen persisted contract with one status column each. Its limit is worth knowing and no checkpoint scheme can lift it: an append PAST the final checkpoint leaves every checkpoint verifying perfectly. Only log_bytes_match catches that, and only a final rolling seal makes it unambiguous.',
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
    body: 'Flat, with no directories: everything in .provenance/ goes in at the top level, and the reviewed files go in beside them at their workspace-relative paths. What is left out is decided by an orphan guard in seal, on one rule: never seal a bundle the analyzer cannot open. Quarantined .corrupt- logs from a failed chain recovery and .tmp leftovers from an interrupted atomic write are excluded because they are unparseable, while the recovery event inside the log still records that a quarantine happened.\n\nThe rest of the guard exists because .provenance/ legitimately accumulates artifacts that are individually harmless and collectively fatal. A session that starts and is torn down before its first flush leaves all three of its files behind — the writer creates the .slog eagerly, the sidecar is written eagerly, and the session-start roll signs a seal eagerly — so a zero-byte log sits next to a complete sidecar and a manifest-<id>.json signed over nothing. Packed as they are, each one used to be fatal to the WHOLE bundle rather than to that one session: an empty log is first_event_not_session_start, a sidecar whose log was quarantined away is orphaned_meta, and a seal naming a session that is not here is no_session_log, which fails check 1 for everything in the archive. So an empty log leaves with its sidecar, a sidecar whose log is gone leaves, and a rolling seal leaves unless the bundle actually carries the session it names — matched on the logical session.start id, never the .slog filename uuid, because those are two different values and the loader reconciles against the first.\n\nDropped means dropped from the ZIP and nothing more. Nothing is deleted or renamed on disk: a git-submitted .provenance/ is read straight off disk and must keep the seal the session-start roll exists to provide, and in a shared repo those files may be a partner\u2019s evidence. Every drop rides back in the seal warnings and is shown to the student, so a silent exclusion never reads as nothing having been wrong. A dropped log also leaves the manifest, since a manifest naming an absent session is just another way to make the bundle unopenable. And dropping a rolling seal cannot manufacture a finding: unsealed_session is only ever reported for a bundle with no classic manifest.json, and this path always writes one.\n\nThe loader treats the contents as a closed set. manifest.json, manifest.sig and the per-session .slog / .slog.meta pairs are recognised by name; anything else is accepted only if the manifest names it in submission_files, and any genuinely unexplained entry still fails the load outright — strictness is cheap, and it means no later stage has to reason about what a stray file might be.\n\nThe unpairable shapes are the exception, and the reason is that the GIT path never runs seal: the student pushes, the grader clones, and whatever is in .provenance/ on disk is the submission, with nothing between it and the loader. There a stranded sidecar is the ordinary residue of a crash, and failing the whole archive on it punished a student for a power cut. So the loader applies the same rule the seal path applies, on the read side: an artifact it cannot analyse — an unpaired .slog or .slog.meta, a zero-byte log, a quarantined .corrupt- file, a .tmp leftover — is dropped from the ANALYSIS and reported on the bundle, and the sessions that are there are analysed in full. It drops from the analysis only; the loader never writes, so nothing on disk is touched. A dropped session takes its rolling seal with it, matched on the logical session.start id recovered from the sidecar, because a seal left naming an absent session becomes no_session_log and fails check 1 — which would turn the crash this absorbs into an accusation. Nothing dropped is a finding: every notice says incomplete recording, produces no flag, and moves no verdict.\n\nThere is a fifth shape, and it is handled the opposite way. A write interrupted part-way through a flush — a power cut, a full disk, an OS kill — leaves a half-written trailing line inside the log’s completely normally-named session-<uuid>.slog, which none of those four name-based patterns can match; it reached the parser, came back ndjson_parse_failed, and failed the WHOLE bundle before a single check ran. It is the only corruption an honest student produces by doing nothing at all. Such a log is now TRUNCATED to its last complete entry and the session is KEPT, reported through ParsedSession.tornTail into CoverageFacts.tornTails and the coverage panel’s own "Interrupted writes" section — deliberately NOT droppedArtifacts, whose renderers say "N files could not be analysed" in prose, and a torn session WAS analysed.\n\nKeeping beats dropping for a reason that only shows up two layers away. Bug 11’s artifacts carry no analysable evidence at all: a zero-byte log has no events, a stranded sidecar has no log, a quarantined copy was already renamed away. A .slog with a torn tail is a complete, chained, checkpointed recording of real work with forty bad bytes on the end. Check 8 resolves each file’s last recorded state by scanning bundle.sessions, so removing a session removes the saves that explain the submitted code, and the crash comes back as "code appeared that the log never recorded" — a STRONGER accusation than the load failure it replaced. That was driven rather than asserted: implementing the drop design turns twelve of the change’s tests red.\n\nThe tolerance is byte-level rather than a judgement, and that is what protects the middle. It covers the characters after the final newline, and only when the text does not end in a newline at all; a completed append always terminates its line, so that absence IS the signature and nothing else can borrow it. A file ending in a newline has no torn tail by construction, so every parse failure inside one is a MIDDLE failure and stays fatal — including when a torn tail is also present, which is the obvious way to try to use the tail as cover. And the truncation is invisible to every digest comparison: slogSha256, slogSha256Lf and the rolling seal’s prefix search all still run over the ARCHIVED bytes, because a reader that re-hashed its own truncated view would reproduce the committed digest of a finished log and turn a failing log_bytes_match into a passing one — strictly worse than the bug being fixed.',
    links: [
      { label: 'seal.ts', href: `${GH}/packages/recorder/src/commands/seal.ts` },
      { label: 'unzip.ts', href: `${GH}/packages/analysis-core/src/loader/unzip.ts` },
    ],
  },

  rseal: {
    title: 'The rolling seal',
    body: 'format_version 1.2, and the only format change on this branch. It reuses the 1.1 field set verbatim — assignment_id, semester, extension_hash, sessions, submission_files — and adds exactly two things: the invariant that sessions holds exactly ONE entry, whose session_id equals the id in the filename, and an optional boolean final.\n\nThe filename is part of the contract, not decoration. manifest-<session_id>.json and .sig cannot collide with manifest.json (the hyphen is mandatory in the pattern), so the two shapes coexist in one directory and a bundle carrying both keeps the classic manifest as its manifest while still having to satisfy every per-session signature beside it. Neither excuses the other.\n\nCryptographically the interesting property is what the digests commit to. A classic seal is taken once over a finished log, so its slog_sha256 is a whole-file commitment and any later byte is tampering. A rolling seal is signed while the log is still growing, so its digest commits to a PREFIX, and the archived log routinely runs past it — a git submission has no seal step, and an archive can be taken mid-session, after a crash, or from a partner’s repo. Reading a prefix commitment as a whole-file one accuses honest work at high severity with confidence 1.0, which this system has done, from three separate routes, and each time the wording told the student it was not recoverable from a benign cause.\n\nfinal is what closes the gap the prefix reading leaves open, in which an append after the session ended is indistinguishable from honest mid-session growth. It is a claim by the WRITER inside the signed payload rather than something the reader infers, and the distinction matters: the obvious alternative — inferring finality from a trailing session.end entry — infers it from the log, whose completeness is the very thing in question. Its absence is never a finding.\n\nEach seal is signed by its own session’s ephemeral key and is verified against exactly that session’s public key, with no fallback to any other. In a shared repository the neighbouring seals belong to somebody else, so a fallback would let a manifest copied sideways under another session’s filename verify and pass.',
    invariant:
      'A rolling seal commits to a PREFIX. Only a seal the writer marked final commits to the whole file, and absence of final is never a finding.',
    links: [
      {
        label: 'rolling-manifest.ts',
        href: `${GH}/packages/log-core/src/rolling-manifest.ts`,
      },
      {
        label: 'verify-log-bytes.ts',
        href: `${GH}/packages/analysis-core/src/validation/verify-log-bytes.ts`,
      },
    ],
  },
  push: {
    title: 'Git submission',
    body: 'The second way work leaves a student’s machine, and the one that has no submit moment at all. The student commits and pushes; the grader or the ingest pipeline clones; whatever is in .provenance/ on disk IS the submission. Nothing runs seal, nothing zips anything, and nothing gives the recorder a signal that the work is finished.\n\nThat is what the rolling seal exists for, and it is also why two guarantees the .zip path takes for granted have to be re-established here. The zip is assembled by seal, which can exclude an artifact the analyzer could not open; a pushed directory is whatever is on disk, and the leftovers that guard exists to catch — a stranded sidecar after a crash-recovery quarantine, a zero-byte log from a session torn down before its first flush — are exactly the ones a git submission carries. So the loader applies the same rule on the read side. And a shared .provenance/ has to survive two people committing into it, which is why every artifact in it is named per session: the directory is add-only and therefore merge-conflict-free, verified experimentally rather than assumed.\n\nIngest treats the archive as a repository rather than a bundle, fanning it out into one submission per assignment scope, under a declared submission type for the batch. What arrives at verification afterwards is the same flat bundle shape the classic path produces, so everything downstream of the loader is unchanged.\n\nThe honest limit: an archive cannot distinguish a log that was never pushed from one that was removed. A partner who committed manifest-<session_id>.json before their .slog landed, or whose log is caught by a .gitignore, produces an archive byte-identical to one where a log was deleted. Check 1 still reports the gap — a signed claim nothing can ever verify is a real hole — but its text names the innocent reading alongside the others rather than asserting deletion or planting. Only peer witnessing can prove a log existed.',
    links: [
      { label: 'repo-zip.ts', href: `${GH}/packages/server/src/services/ingest/repo-zip.ts` },
      {
        label: 'rolling-seal.ts (loader)',
        href: `${GH}/packages/analysis-core/src/loader/rolling-seal.ts`,
      },
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
