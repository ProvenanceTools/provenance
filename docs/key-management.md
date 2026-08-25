# Key management — full reference

Every key in Provenance: what it is, who holds it, what it signs, how it is set
up, and what its compromise costs. This is the map; the step-by-step commands for
each role live in [`README.md`](../README.md) §"Course staff: key & manifest
workflow" and [`docs/admin-guide.md`](admin-guide.md) §10.6, and this page links
into both rather than restating them.

Design rationale for the trust chain is program spec
`docs/superpowers/specs/2026-08-18-multicourse-program-architecture.md` §2, §3,
§5, §5a. The executable contracts are `packages/log-core/src/course-cert.ts`,
`institution.ts`, `enrollment.ts`, `student-keys.ts`, and `session-keys.ts`.

---

## 1. The picture — two chains from one root

```
                        root keypair
                   (offline, maintainer-held;
                    NEVER signs a manifest)
                     /                    \
            signs course_cert       signs institution_cert
                   /                        \
      course keypair                    institution keypair
   (course staff, offline)             (deployment server)
             |                                 |
   signs .provenance-manifest        signs student_credential
      (incl. capture policy)                   |
                                     student master secret
                                    (student's machine, OS keyring)
                                               | HKDF
                                       student keypair
                                               | countersigns
                                       session keypair
                                    (ephemeral, one per session)
```

The left branch is **authority over an assignment**: who may declare that this
folder is a graded assignment, and what the recorder is allowed to capture. The
right branch is **identity and attribution**: which human produced this work.

The two branches meet only at the root, and deliberately do **not** cross. A
manifest's `course_cert` does not anchor the identity block, and a credential
names no course. That separation is what lets a student hold one identity across
every course they take, and lets a course rotate its signing key without invalidating
anyone's identity.

---

## 2. Inventory at a glance

| #   | Key                       | Private? | Lives where                                                 | Signs                                                   |
| --- | ------------------------- | -------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Root keypair              | yes      | Air-gapped machine + physical backup                        | `course_cert`, `institution_cert` — nothing else, ever  |
| 2   | Course keypair            | yes      | Secured staff machine, offline                              | `.provenance-manifest` payload (incl. `policy.capture`) |
| 3   | Institution keypair       | yes      | `PROVENANCE_INSTITUTION_KEY` env on the API server          | `student_credential`                                    |
| 4   | Student master secret     | yes      | Student's OS credential vault                               | nothing directly — HKDF root for #5                     |
| 5   | Student keypair (derived) | yes      | Never stored; re-derived on demand                          | the session `session_pubkey` countersignature           |
| 6   | Session keypair           | yes      | In memory; persisted encrypted under the manifest signature | checkpoints + the bundle seal                           |
| 7   | Root **public** key       | no       | Embedded in every recorder build; server + analyzer env     | — (verification anchor)                                 |
| —   | Legacy course public key  | no       | Optional second embedded constant per recorder              | — (1.x verification anchor, scheduled for removal)      |
| —   | ~~Enrollment keypair~~    | —        | **Retired.** `PROVENANCE_ENROLLMENT_KEYS` is gone           | ~~`enrollment_token`~~ (identity 2.0)                   |

## 3. Who holds what

| Role                 | Holds                                                             | Never holds                                      |
| -------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| **Maintainer**       | Root private key                                                  | Course keys, institution key, any student secret |
| **Course staff**     | That course's private key + its `course_cert`                     | Root key, institution key                        |
| **Deployment admin** | `PROVENANCE_INSTITUTION_KEY` (the only private key on any server) | Root key, course keys                            |
| **Student**          | Their master secret, in their OS keyring                          | Everything else                                  |

Nobody holds two rows of that table in production. The offline steps and the
online steps are separated precisely so that a compromised server cannot forge an
assignment, and a compromised course laptop cannot forge a student.

---

## 4. Each key in detail

### 4.1 Root keypair

**Generated once, ever, offline.** There is no dedicated root generator — the
course-keypair generator emits exactly the right shape:

```sh
npm run keygen:course -- /Volumes/SECURE/root-keypair.json
```

It prints the 64-hex public key on stdout and writes
`{ public_key_hex, private_key_hex, generated_at, note }` at mode `0600`. It
refuses to overwrite and refuses to write inside the repo. Back the private half
up to physical media.

The root key signs exactly two kinds of artifact — `course_cert` and
`institution_cert` — and **never a manifest**. That restriction is the whole point
of the hierarchy: a manifest is signed thousands of times a semester by people on
ordinary laptops, and the anchor of the system must not be one of those people.

`log-core` never hardcodes the root public key. It is isomorphic and must stay
pure, so every verifier supplies it: the recorder from its embedded constant, the
server from `PROVENANCE_ROOT_PUBLIC_KEY_HEX`, the browser from
`VITE_ROOT_PUBLIC_KEY_HEX`. A hardcoded key would make one build serve exactly one
deployment, which is the thing this design exists to remove.

**Rotating the root key is a fleet-wide event** — see §7. Plan not to.

### 4.2 Course keypair + `course_cert`

One per course per semester, generated by course staff on a secured machine:

```sh
npm run keygen:course -- /Volumes/SECURE/cs61a-fa26.json
```

Staff send only the **public** half to the root holder, who mints the certificate
on the offline machine:

```sh
npm run mint:course-cert -- \
  --course-id berkeley-cs61a --course-pubkey <64-hex> \
  --valid-from 2026-08-20 --valid-until 2027-01-15 \
  --root-keypair /Volumes/SECURE/root-keypair.json \
  --out /Volumes/SECURE/cs61a-fa26.cert.json
```

When the same machine holds both keys, `npm run keygen:course` does both steps in
one run — pass `--course-id`, `--valid-from`, `--valid-until` (and optionally
`--root-keypair` / `--cert-out`) alongside the output path.

The certificate is self-verified against the root public key before it is written.
A tool that hands out a certificate failing its own check is worse than no tool,
so all three minting tools do this.

Staff then sign each assignment manifest, which staples the certificate inline:

```sh
PROVENANCE_COURSE_KEYPAIR_PATH=/Volumes/SECURE/cs61a-fa26.json \
PROVENANCE_COURSE_CERT_PATH=/Volumes/SECURE/cs61a-fa26.cert.json \
  npm run sign:manifest -- /path/to/assignment-starter/.provenance-manifest
```

`manifest.course_id` **must** equal the certificate's `course_id`, or
self-verification fails and nothing is written — that equality is what stops one
course's key from signing a manifest claiming to be another course.

The signed payload includes `policy.capture`, which is how a professor turns
capture down and a student cannot turn it off. See
`packages/log-core/src/policy.ts` for the hard floor: signals that reconstruction,
validation, or the _exculpatory_ heuristics depend on have no policy key at all,
so there is no way to express "off" for them.

**Compromise:** forge assignments and capture policy for that one course, bounded
by the certificate window. Cannot touch another course, cannot mint an identity.

### 4.3 Institution keypair + `institution_cert`

One per deployment — not per course, not per semester. It is the **only private
key any Provenance server holds**, and it signs `student_credential`s.

Setup is two steps across two machines. On the server:

```sh
npm run keygen:course -- /secure/institution-keypair.json   # positional path ONLY
```

Passing `--course-id` here would mint a _course_ certificate, which is a different
artifact. Carry only the public key to the offline root machine:

```sh
npm run mint:institution-cert -- \
  --institution-id berkeley --institution-pubkey <64-hex> \
  --valid-from 2026-08-20 --valid-until 2027-08-19 \
  --root-keypair /Volumes/SECURE/root-keypair.json \
  --out /Volumes/SECURE/berkeley-institution.cert.json
```

Bring the certificate back and splice it together with the private key into one
JSON object:

```json
{
  "private_key_hex": "<64 hex — PRIVATE>",
  "cert": {
    "format_version": "2.1",
    "institution_id": "berkeley",
    "institution_pubkey": "<64 hex>",
    "valid_from": "2026-08-20",
    "valid_until": "2027-08-19",
    "root_sig": "<128 hex>"
  }
}
```

The root key never touches the server host. The `institution_id` is read off the
certificate rather than configured separately: it is inside the root-signed
payload, so it cannot be set to something the root key did not authorize.

**It is deliberately not a Postgres row.** Database dumps travel — nightly backups,
the restore drill in `admin-guide.md` §9, a copy on an operator's laptop — and the
one secret whose theft forges student attribution must not ride along. The
operational corollary: **a restore from backup will not bring this key back**, so
it must live in the deployment's secret handling and be part of the restore
runbook separately.

**Compromise:** mint a credential binding any public key to any `student_ref` at
that institution, then countersign session keys as that student — forged
attribution that verifies, because the signatures are genuine. Bounded by the
certificate window. Cannot sign a manifest (that needs the offline course key) and
cannot reach a second institution (`institution_id` is inside both signed payloads
and every verifier cross-checks credential, travelling certificate, and
root-verified anchor). This is a strictly larger blast radius than the retired 2.0
enrollment key, whose reach stopped at one course's roster.

### 4.4 Student master secret

32 random bytes, generated on the student's machine, stored **only** in the OS
credential vault — Keychain on macOS, DPAPI-backed Credential Manager on Windows,
libsecret on Linux, reached through VS Code's `SecretStorage`. Deliberately not
`globalState` (a plaintext JSON file) and not a workspace dotfile, which would be
committed to a submission repo by accident and readable by a lab partner sharing
the repo.

It never leaves the machine, is never sent to a server, and is never written into
a log or a bundle. **There is no escrow and no server-side key store**, so nobody —
not staff, not an admin, not the maintainer — can recover it for a student. What
exists instead:

- **Provenance: Back Up Student Identity Secret** — shows the 64-hex string for a
  password manager.
- **Provenance: Restore Student Identity Secret** — puts it back after a keyring
  wipe or machine rebuild. Keys are re-derived byte-identically, so every
  credential the student already holds keeps working and nothing is re-minted.

**Losing it is not a crisis.** The student enrols that machine again as if it were
new; signing in with the same account returns the same global `student_ref`, so
contributor resolution still sees one person. Past bundles keep verifying, because
each one carries the credential that was current when it was recorded.

A second machine is handled the same way — enrol it, don't hand-carry the secret.
Telling a student to move the one value that can sign as them, for a flow that
does not need it, is a real harm dressed up as a tip.

### 4.5 Student keypair (derived)

Derived from the master secret by HKDF-SHA256 and never stored. **The derivation is
a cross-language contract**: three recorders (TypeScript, Kotlin, Lua) must produce
byte-identical keys, or a signature made in one editor will not verify against the
public key the credential names. The parameters are pinned in
`student-keys.ts` and in the `student-keys.json` conformance vectors:

|           |                                                                        |
| --------- | ---------------------------------------------------------------------- |
| algorithm | HKDF (RFC 5869) with SHA-256                                           |
| IKM       | the 32 **raw bytes** of the master secret                              |
| salt      | UTF-8 `"provenance-student-key-v1"` (25 bytes, deliberately non-empty) |
| L         | 32 bytes — the output **is** the ed25519 seed                          |

The salt is non-empty on purpose: HKDF's absent-salt rule is a place where three
implementations can quietly disagree, and HMAC's own zero-padding makes an empty
salt and a 32-zero-byte salt produce the same PRK — an equivalence that is true but
that no port should have to know. Passing concrete bytes removes the question.

Only `info` differs between the two identity families, and both are live:

| Family                       | Function               | `info`                                                             |
| ---------------------------- | ---------------------- | ------------------------------------------------------------------ |
| **2.1, global** (current)    | `deriveStudentKeypair` | `"provenance-student-key-v2"` — fixed, ASCII, nothing concatenated |
| **2.0, per-course** (legacy) | `deriveCourseKeypair`  | `"provenance-student-key-v1:" + course_id`                         |

The 2.1 `info` carries no user-derived component at all, which removes an encoding
hazard the v1 prefix has to live with: under v1 a non-ASCII `course_id` encoded as
`US_ASCII` rather than UTF-8 silently produces a **different key with no error**. It
bit provjet once, which is why the v1 conformance vectors keep a `berkeley-café`
case. (`course_id` enters as a value inside a flat byte string, never as a JSON
object key, so the §9 no-user-derived-keys rule does not apply here.)

The per-course derivation also bought unlinkability — two courses comparing rosters
could not tell that two entries were the same person. Identity 2.1 trades that for a
single global `student_ref`, deliberately: contributor resolution groups on that ref,
which is how one person working on two machines reads as one person.

Changing any parameter above is a breaking change to two other repos, not a
refactor.

### 4.6 Session keypair

Ephemeral, one per recording session (PRD §4.6). The private key lives in memory
and is persisted only encrypted, under a key derived from the
`.provenance-manifest` signature — so it cannot be recovered without the manifest,
which raises the bar for replay attacks.

|        |                                                                                 |
| ------ | ------------------------------------------------------------------------------- |
| KDF    | HKDF-SHA256, IKM = hex-decoded manifest sig, info `"provenance-session-key-v1"` |
| cipher | XChaCha20-Poly1305, 24-byte random nonce, 16-byte tag                           |

It signs the session's checkpoints and the bundle seal. Validation check 2 step 5
requires every session's `manifest_sig` to equal the embedded `manifest.sig`, which
is what ties the _verified_ manifest to the key that signed those artifacts.

### 4.7 Legacy course public key (grandfather anchor)

`LEGACY_COURSE_PUBLIC_KEY_HEX`, in
`packages/recorder/src/activation/legacy-course-public-key.ts`. Every Manifest 1.x
file already in the field was signed directly by a course's old signing key, with
no cert and no chain; verifying those against the root key fails closed, which
means **silent non-activation** — the worst failure mode an integrity tool has.
`manifest-loader.ts` therefore routes by `format_version`: 2.0 to the root key, 1.x
to this constant.

Two things about it are easy to get wrong:

1. **Each recorder grandfathers its own prior constant — the three are different
   keys.** VS Code's and provjet's are dev placeholders with production injected at
   build time; **provnvim's is the real maintainer-held master key**, because a
   Neovim plugin has no build step, so its constant shipped in every tagged release
   and signed every real 1.x manifest in the field. Cross-wiring another recorder's
   key there silently kills recording for every existing user. The **root** key is
   the only value genuinely shared across all three.
2. **Embedding it changes the built bytes**, and therefore the `extension_hash`. A
   build with the legacy key has a different hash than an otherwise-identical build
   without it. Ship both variants and you must run `npm run update-hashes` once per
   variant.

It is a second permanent trust anchor purely as a bridge. Once no 1.x manifest
anyone still needs to verify remains unreissued, delete the file, its
`course-keys.ts` re-export, the 1.x branch in `manifest-loader.ts`, and the
embedding step in `tools/embed-root-key.ts`. Omitting the env var on every release
is how the constant eventually gets deleted for good.

### 4.8 Retired: the enrollment keypair (identity 2.0)

`PROVENANCE_ENROLLMENT_KEYS` and the per-semester enrollment signing keys it held
are **gone**, along with `POST /semesters/{id}/enrollment`. Remove the variable
from any environment; nothing reads it.

Identity 2.0 was course-scoped: a per-course derived key, a course-signed
enrollment cert, a token naming a `course_id`. Minting required a roster match,
rosters are populated by Gradescope ingest, and that runs only _after_ a student
submits — so a student could not hold an identity until after their first
submission, while their first session needs one before they do any work. That
deadlock is what course-scoping creates, and 2.1 removes it.

**Retiring the minting path says nothing about verification.** Identity 2.0
verification in `log-core` (`enrollment.ts`, `verifyIdentityChain`) and in
`analysis-core` (`identity/resolve-contributors.ts`) is live forever: archived
bundles carry 2.0 tokens and must keep verifying years later, which is the entire
justification for this system. That chain is walked from inside the bundle and
never consults the server, which is exactly why no key is needed for it.

---

## 5. Setup runbooks

### 5.1 Maintainer — bootstrap (once, ever)

1. Generate the root keypair offline (§4.1). Back the private half up to physical
   media.
2. Distribute the **public** key to: the recorder builds (§5.4), the server env
   (`PROVENANCE_ROOT_PUBLIC_KEY_HEX`), and the analyzer build
   (`VITE_ROOT_PUBLIC_KEY_HEX`).
3. Mint the deployment's `institution_cert` when the admin sends you their public
   key (§4.3).
4. Mint a `course_cert` per course per semester as staff onboard (§4.2).

Steps 3 and 4 are ongoing offline duties. Keep every window short — one semester
is the norm — because there is no offline revocation.

### 5.2 Course onboarding

Staff generate their keypair → send the public key to the maintainer → receive a
`course_cert` → sign manifests with `npm run sign:manifest`. Full walkthrough in
[`README.md`](../README.md) §"Course staff: key & manifest workflow".

### 5.3 Deployment bootstrap

Admin generates the institution keypair on the server → sends the public key to the
maintainer → receives an `institution_cert` → sets `PROVENANCE_INSTITUTION_KEY` →
restarts. **Until this is done, `POST /api/v1/identity/credential` answers
`503 CREDENTIAL_UNAVAILABLE` / `no_institution_key` permanently, and not one student
can be onboarded.** Full detail in [`admin-guide.md`](admin-guide.md) §10.6.

### 5.4 Building the recorders

The VS Code recorder embeds the root public key at build time:

```sh
PROVENANCE_ROOT_PUBLIC_KEY_HEX=<root public key> \
  npm run build:prod --workspace=packages/recorder
```

`build:prod` runs `tools/embed-root-key.ts`, bundles, packages the VSIX, then
`git checkout`s the source files so local work returns to the dev key. The script
dies on a missing, malformed, or dev-equal root key, so a misconfigured release
fails loudly rather than shipping a build that trusts the dev root.

Add `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX=<old course public key>` only while 1.x
manifests are still in the field (§4.7).

Then refresh the analyzer's allowlist:

```sh
npm run update-hashes -- --root-keypair /Volumes/SECURE/root-keypair.json
```

This is now **once per root-key rotation (per variant), not once per course** — the
old model baked one course's key into the VSIX, so every course needed its own
build and its own hash. The script hashes the **bundled** `dist/` that an installed
VSIX actually reports at seal time.

provjet and provnvim build in their own repos; compute their hashes there
(`./gradlew :recorder:computeExtensionHash`, and provnvim's `compute_installed()` —
for a Neovim plugin the installed `lua/` tree _is_ the distribution) and add them
with `--hash <hex>`. Both hash the same thing, a SHA-256 over the installed file
tree, so they are first-class allowlist entries, just sourced manually.

### 5.5 Student enrollment

The student signs in at `/enroll` with Google OAuth (the same
`AUTH_ALLOWED_HOSTED_DOMAINS` `hd` gate that protects the analyzer) and receives one
credential that serves every course forever. It is the only route a student can
reach; every other route requires a `memberships` row that no student has.

Two things that route refuses, both deliberately: **API tokens** (a credential _is_
the attribution claim; a stolen long-lived bearer secret must not mint one) and
**view-as** (a superadmin impersonating a student must not be able to issue signed
evidence attributing work to someone by an operator's action).

There is no roster check, for the deadlock reason in §4.8. Being an authenticated
member of the hosted domain is sufficient to be issued an opaque ref — the ref
asserts "this is consistently the same person", not "this person is in your class".
Course membership is answered later, from the roster, by the server, against data
it owns.

Returning to `/enroll` is normal: that is how a second machine is set up.

---

## 6. Where each public value goes

| Value                    | Set as                                    | Consumed by                                    | Timing                  |
| ------------------------ | ----------------------------------------- | ---------------------------------------------- | ----------------------- |
| Root public key          | `PROVENANCE_ROOT_PUBLIC_KEY_HEX`          | `tools/embed-root-key.ts` → recorder constant  | Recorder **build** time |
| Root public key          | `PROVENANCE_ROOT_PUBLIC_KEY_HEX`          | Server validation check 2                      | Server **runtime**      |
| Root public key          | `VITE_ROOT_PUBLIC_KEY_HEX`                | Analyzer `/local` route                        | Analyzer **build** time |
| Legacy course public key | `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX` | Recorder 1.x verification branch               | Recorder **build** time |
| `course_cert`            | stapled inline by `sign:manifest`         | Recorder activation, check 2                   | Travels in the manifest |
| `institution_cert`       | inside `PROVENANCE_INSTITUTION_KEY`       | Copied into every credential → `session.start` | Travels in the bundle   |

Note the two build-time rows: rotating the root key means **rebuilding and
redeploying** the analyzer and all three recorders, not editing an env file.

Unset is a legitimate state for the root public key everywhere. 1.0/1.1 bundles
never consult it; 2.0 bundles get check 2 = `skipped` (making overall validation
`warn`), never a false `pass`. If a whole cohort lands on `warn`, check this
variable first.

---

## 7. Rotation and compromise

| Key                   | Rotation cost                                                                                                                                            | If compromised                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Root                  | Fleet-wide: new VSIX ×3 recorders → `update-hashes` per variant → analyzer rebuild → server env → re-mint every `course_cert` and the `institution_cert` | Everything, everywhere. Assume total loss and rebuild the fleet.                                                    |
| Course                | Cheap: new keypair, new cert, re-sign manifests going forward                                                                                            | One course, until the cert window closes. Issue a fresh cert for a new key.                                         |
| Institution           | Cheap: new keypair, new cert from the offline root, swap the env var, restart                                                                            | Forged attribution institution-wide until the window closes. Shorten the new cert's window if the exposure matters. |
| Student master secret | Free: enrol the machine again                                                                                                                            | That student, everywhere, forever. They re-enrol; the old key stops being bound.                                    |

Two invariants hold across every rotation:

- **Already-issued artifacts keep verifying.** Credentials minted under an old
  institution key stay valid until they expire, because bundles recorded under them
  must keep verifying. The old certificate travels inside those bundles.
- **There is no offline revocation.** A recorder cannot learn a key was revoked
  without a network call, which recorder PRD NG2 forbids. Short validity windows are
  the only mitigation, and this is an accepted limitation, not an oversight.

A server-side revocation list, if one is ever built, **must key on `course_pubkey`,
not on a certificate.** The certificate travels outside the course-signed payload by
design, so a manifest does not bind to _which_ cert authorized it — the student
chooses which of the course's certs to ship. A list keyed on certificate identity is
therefore defeated by stapling any other non-revoked cert carrying the same
`course_pubkey`.

---

## 8. Symptoms → causes

| Symptom                                                      | Cause                                                                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `503 CREDENTIAL_UNAVAILABLE`, `reason: "no_institution_key"` | `PROVENANCE_INSTITUTION_KEY` unset                                                                                                                      |
| `503 CREDENTIAL_UNAVAILABLE`, `reason: "cert_out_of_window"` | The `institution_cert` lapsed. Presents to students as "we cannot issue credentials right now", not as a server error — watch the tail of every window. |
| Every 2.0 submission validates as `warn`, check 2 `skipped`  | `PROVENANCE_ROOT_PUBLIC_KEY_HEX` unset on the server                                                                                                    |
| `/local` route cannot verify a chain                         | `VITE_ROOT_PUBLIC_KEY_HEX` missing from the analyzer build                                                                                              |
| Recorder silently does not activate on a 1.x manifest        | The build has no real `LEGACY_COURSE_PUBLIC_KEY_HEX`, or the wrong recorder's legacy key was used (§4.7)                                                |
| `extension_hash_mismatch` on a fresh release                 | `npm run update-hashes` not run for that build variant                                                                                                  |
| Manifest signing refuses to write                            | `manifest.course_id` ≠ the certificate's `course_id`, so self-verification failed                                                                       |
| Session records with no `identity` block                     | Not enrolled, keyring unavailable, or the stored cert does not verify against the embedded root key. Recording never blocks on identity.                |

---

## 9. Rules that do not bend

- **Never modify `manifest.json` / `manifest.sig` in a stored bundle.** They are
  signed, and the stored bundle must stay signature- and chain-verifiable.
- **No user-derived object keys in a signed payload.** Every object _key_ inside a
  canonicalized, signed payload must be a fixed ASCII identifier chosen by us —
  never a course id, student ref, or filename promoted to a key. provnvim's
  hand-rolled Lua JCS sorts keys bytewise; the JS and Kotlin implementations sort by
  UTF-16 code unit. Those agree for ASCII and can silently diverge above U+007F,
  producing different signed bytes and breaking cross-recorder verification. Values
  are unconstrained; only keys carry this rule. This applies to all future format
  work.
- **The HKDF parameters in §4.5 are pinned.** Changing one is a breaking change to
  two other repos.
- **The institution key never goes in Postgres**, and never in a database dump.
- **There is no escrow for the student master secret**, and there must never be one.
  A recoverable-by-staff identity key would let staff sign as a student, which is
  precisely what this chain exists to make impossible.
- **Identity 2.0 verification is permanent.** Archived bundles must keep verifying
  years later; adjudicating a case long after the fact is the entire justification
  for this system.
