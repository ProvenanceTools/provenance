# Multi-course, git-native, multi-contributor Provenance — program architecture

Status: **draft, pending approval**
Date: 2026-08-18

This is the umbrella document for a six-part program that takes Provenance from
"one course, one sealed bundle, one student" to "many courses, git-native
submission, many contributors per assignment".

It pins **only the contracts that more than one sub-project depends on**, plus the
dependency order and the migration rule. Implementation detail lives in the
per-sub-project design docs. Keep this document small enough to load into every
future session as shared context.

Three repos implement these contracts:

- `provenance` (this repo) — `log-core`, `analysis-core`, `analyzer`, `server`, VS Code recorder
- `provenance-jetbrains-recorder` (provjet) — Kotlin
- `provenance-neovim-recorder` (provnvim) — Lua

Contract changes are therefore **tri-repo changes**. See §9.

---

## 1. What is changing, conceptually

Today the unit of everything is:

> one sealed bundle = one assignment = one student = one linear chain of sessions

For CS 61B / 61C the unit becomes:

> a **repository** contains zero or more **assignment scopes**; each scope has one
> or more **contributors**; each contributor has a chain of **sessions**; the scope's
> history is a partial **DAG of git commits** those sessions observed.

Three entities are new: **scope** (already self-identifying via its manifest),
**contributor** (new, cryptographic), and **commit graph** (new, captured at record
time).

Two properties of the 61B/61C workflow drive everything else:

- **There is no seal step.** Students push; Gradescope clones the repo. Nothing
  runs `seal.ts`, so nothing writes `manifest.json` / `manifest.sig`.
- **Gradescope delivers the working tree only — no `.git`.** History must therefore
  be captured by the recorder at record time, not recovered at ingest time. This
  is strictly better than shipping `.git`, because a captured graph lives inside a
  signed hash chain, whereas a `.git` directory is trivially rewritable.

---

## 2. Trust chain

Four keys, three signature relationships. This is the spine of the program.

```
  root keypair            (Provenance maintainer; offline; NEVER signs a manifest)
        │ signs
        ▼
  course_cert             { course_id, course_pubkey, valid_from, valid_until }
        │ authorizes
        ▼
  course keypair          (course staff; signs manifests AND enrollment tokens)
        │ signs                          │ signs
        ▼                                ▼
  .provenance-manifest            enrollment token
                                  { student_ref, course_id, student_pubkey, ... }
                                         │ authorizes
                                         ▼
                                  student per-course key
                                         │ countersigns
                                         ▼
                                  session_pubkey  (existing ephemeral session key)
```

Fixed decisions:

- **The recorder embeds the root public key, plus one grandfathered legacy course
  key.** `COURSE_PUBLIC_KEY_HEX` is replaced by `ROOT_PUBLIC_KEY_HEX`, and 2.0
  verification chains through it exclusively. But Manifest 1.x files already in
  the field were signed directly by the OLD course key, have no `course_cert`, and
  will never be reissued — verifying them against the root key fails closed, i.e.
  silent non-activation. `LEGACY_COURSE_PUBLIC_KEY_HEX`
  (`packages/recorder/src/activation/legacy-course-public-key.ts`) grandfathers
  that one key back in: `manifest-loader.ts` routes by `format_version` — 2.0 to
  `ROOT_PUBLIC_KEY_HEX`, 1.x to `LEGACY_COURSE_PUBLIC_KEY_HEX`.

  **Each recorder grandfathers ITS OWN prior embedded constant — the three are not
  the same key.** The whole point is "keep accepting the 1.x manifests you already
  accepted", and the key that signed those is whatever that specific recorder was
  verifying against:

  | recorder | legacy anchor     | nature                                     |
  | -------- | ----------------- | ------------------------------------------ |
  | VS Code  | `46f91d59…bf4838` | dev key; production injected at build time |
  | provjet  | `958d262b…d5564b` | dev key; production injected at build time |
  | provnvim | `b5bca59f…985e25` | **the real maintainer-held master key**    |

  provnvim is the case that makes this load-bearing: it has no build step, so its
  constant is not a dev placeholder — it shipped in every tagged release and signed
  every real 1.x manifest in the field. Cross-wiring another recorder's key there
  would silently kill recording for every existing user, which is the precise
  failure this clause exists to prevent. The **root** key, by contrast, genuinely is
  one shared value across all three.

  `tools/embed-course-key.ts`
  is retired in favor of `tools/embed-root-key.ts`, which embeds both constants —
  the root one from `PROVENANCE_ROOT_PUBLIC_KEY_HEX` (required) and the legacy one
  from `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX` (optional: a deployment build with
  the var unset simply keeps the dev legacy key, harmless once no 1.x manifest is
  left in the field). This is a second trust anchor purely as a bridge — it exists
  only until every course has re-issued its manifests as 2.0, which is exactly what
  the root-key hierarchy exists to make unnecessary. Once that migration is
  complete for every course with 1.x manifests still needing verification, delete
  `legacy-course-public-key.ts`, its `course-keys.ts` re-export, the 1.x-routing
  branch in `manifest-loader.ts`, and the legacy-key embedding step in
  `tools/embed-root-key.ts` in one PR.

- **`course_cert` travels inline in `.provenance-manifest`**, outside the
  course-signed payload. One file to discover, one to distribute, no chance of the
  two being separated by a copy or a `.gitignore`.
- **`course_id` is inside the course-signed payload** and MUST equal
  `course_cert.course_id`. Without this check, 61B's key can sign a manifest
  claiming to be 61C and both signatures verify. This is a mandatory conformance
  vector.
- **Validity is evaluated against `manifest.issued_at`, not wall-clock now.** A
  Fall 2026 bundle must still verify in 2028 for an adjudication case. "Was the
  cert valid when the manifest was issued", never "is it valid today".
- **`valid_from` and `valid_until` accept an ISO 8601 date (`YYYY-MM-DD`) or full
  timestamp, and a date-only bound resolves asymmetrically at each end:**
  `valid_from` is inclusive from that day's FIRST instant (UTC midnight), so
  `valid_from: "2026-08-20"` means valid starting at the beginning of Aug 20.
  `valid_until` is inclusive THROUGH THE END of that day, so
  `valid_until: "2027-01-15"` covers all of Jan 15 and expires at the first
  instant of Jan 16 — the reading a human gets from "valid until Jan 15", not
  a cert that is already expired on the day it names. A full timestamp at
  either end (`"2027-01-15T12:00:00Z"`) means exactly that instant, unchanged
  by the date-only extension. Implemented in `packages/log-core/src/course-cert.ts`
  (`parseIsoInstantMs`, `resolveValidUntilExclusiveMs`, `checkCertWindow`) and
  pinned by the `course-cert.json` conformance vectors' `window_cases`.
- **The session-key KDF is unchanged.** `session-keys.ts` still uses the manifest
  signature as HKDF IKM; that signature is now produced by a course key instead of
  the single embedded key.
- **Revocation is server-side only, and MUST key on `course_pubkey`, not on cert
  identity.** The cert sits outside the signed payload, so the student's copy of it is
  whatever travelled with their repo — they choose which cert ships. Revoking "that
  certificate" is therefore meaningless; revoking the public key it vouches for is not.
  An offline recorder cannot learn about revocation at all without breaking recorder
  PRD NG2, so this lives in the analyzer/server, which flags any submission whose
  chain terminates in a revoked `course_pubkey`. Mitigation for the offline gap is
  short validity windows — one semester per cert. A real, accepted limitation; write
  it into the S0 spec rather than papering over it.
- **Enrollment tokens carry an opaque `student_ref`, never a raw SID.** In a shared
  61B repo, one partner can read the other's `session.start`. The server maps
  `student_ref` → `roster_entries.id`; a partner sees only a UUID.

---

## 3. Manifest 2.0

`packages/log-core/src/manifest.ts`. Two independent signature scopes in one file.

```jsonc
{
  "format_version": "2.0",

  "course_id": "berkeley-cs61b", // ┐
  "assignment_id": "proj2", // │
  "semester": "fa26", // ├─ canonicalized + signed by COURSE key
  "issued_at": "2026-09-08T00:00:00Z", // │
  "files_under_review": ["..."], // │
  "collaboration": "solo", // │  "solo" | "group"
  "submission": "bundle", // │  "bundle" | "git"
  "scope": "directory", // │  "directory" | "repo"
  "policy": { "...": "..." }, // ┘  see §4
  "sig": "9c2e…",

  "course_cert": {
    // ┐
    "course_id": "berkeley-cs61b", // ├─ canonicalized + signed by ROOT key
    "course_pubkey": "a91f…", // │
    "valid_from": "2026-08-20", // │
    "valid_until": "2027-01-15", // ┘
    "root_sig": "4b70…",
  },
}
```

**`Manifest` has no `format_version` field today.** 1.x manifests are therefore
identified by its _absence_; the parser MUST default a missing `format_version` to
`"1.0"` and continue, never reject. Conformance vector required.

`buildSignedPayload` excludes `sig` **and** `course_cert` — the course does not
sign its own certificate.

Verification order (identical in all three recorders):

0. **Assert `format_version === "2.0"` before walking the chain at all.** This gate is
   a security control, not a formality. At 1.x, `course_id`, `collaboration`,
   `submission`, `scope`, and `policy` are NOT in the signed payload — so a student
   holding any legitimately issued 1.x manifest from their own course could staple on
   that course's certificate (public, root-signed, freely copyable from any 2.0
   manifest), add a matching `course_id` to satisfy step 3, and staple on an invented
   `policy` disabling all capture. Every signature would verify. Without step 0, the
   policy block's entire reason for living inside the signed payload is defeated and
   students get the off switch. Chain-verify 2.0 only; 1.x manifests take the legacy
   `verifyManifest` path and have no policy.
   0b. **Validate the 2.0 shape before any signature work.** `canonicalize` omits keys
   whose value is `undefined`, so a 2.0 manifest missing `policy` entirely would sign
   and chain cleanly while carrying no policy at all.
1. `course_cert` minus `root_sig` → verify against embedded root pubkey. Fail → do not activate.
2. Payload minus `sig` and `course_cert` → verify against `course_cert.course_pubkey`. Fail → do not activate.
3. Assert `manifest.course_id === course_cert.course_id`. Fail → do not activate.
4. Check `issued_at` falls within `[valid_from, valid_until]`. **Out of window does
   NOT block activation** — see §4.

All 2.0 fields are **required**, not optional. A fixed key set means the Kotlin and Lua
ports canonicalize without needing a "which optionals were present" rule — which would
be a divergence risk across three hand-written implementations.

Unknown top-level keys MUST be ignored, for forward compatibility. Note this means
unknown keys are also unsigned-payload-affecting: canonicalization operates on the
named fields only, so an unknown key cannot silently change the signed bytes.

---

## 4. Capture policy

The professor-facing control, and the reason `policy` is inside the signed payload:
a professor can turn capture down, a student cannot turn it off.

```jsonc
"policy": {
  "capture": {
    "selection_change":      true,
    "focus_change":          true,
    "terminal":              true,
    "inline_content":        true,     // paste + fs.external_change content snippets
    "heartbeat_interval_ms": 30000     // clamp [5000, 120000]
  }
}
```

**Hard floor — these event kinds are not expressible in `policy.capture` and can
never be disabled**, because validation checks 3–8 and the integrity story depend
on them:

`session.start`, `session.end`, `session.resumed`, `doc.open`, `doc.close`,
`doc.change`, `doc.save`, `paste`, `paste.anomaly`, `fs.external_change`,
`git.event`, `clock.skew`, `chain.broken`, `ext.snapshot`, `ext.activate`,
`recorder.degraded`, `recorder.recovered_from_corruption`, `session.heartbeat`

The floor is enforced by the schema itself: floor events simply have no key in
`policy.capture`. `session.heartbeat` is on the floor because bundle-level
Active/Idle and the `gap_in_heartbeats` heuristic depend on it — only its interval
is tunable.

**Where the floor is drawn — the general rule.** _The floor is defined by what
reconstruction and validation depend on, not by privacy sensitivity._ A signal
being sensitive is an argument **for** giving it a knob; a signal being
load-bearing is a **veto** on one. Nothing critical to reconstruction may be
disableable by capture policy. Apply that test before adding any key to
`policy.capture`.

`doc.open` and `doc.close` are the worked example. There was briefly a
`doc_open_close` key, and it was removed: `DocOpenPayload.content` is the
**reconstruction seed** that `reconstruct-file.ts` starts from, so switching
`doc.open` off breaks file reconstruction, replay, and the Source tab for the
entire cohort — with nothing warning the course it had done that. Sensitivity
did not save it. `DocClosePayload` is `{ path }` only: no content, no
reconstruction role, negligible privacy exposure, so a knob governing a bare
path is surface for nothing. Both are floor. A manifest still carrying a
`doc_open_close` key resolves it as an unknown key — ignored, never a gate.

**The absence-vs-disabled rule.** The effective policy MUST travel into the bundle,
because otherwise the analyzer cannot distinguish "this student produced no
`selection.change` events" from "this course disabled `selection.change`", and
heuristics will mis-fire on the difference. Any heuristic that consumes an optional
signal MUST consult the recorded policy and return _not-applicable_ rather than a
flag or a zero. **The S1 spec must include an audit of all 25 heuristics against
this rule.**

**Expired cert does not stop recording.** If a course lets a cert lapse mid-semester,
refusing to activate would silently stop recording for an entire class — a worse
failure for an integrity tool than recording under a stale key. The recorder records
and stamps the expiry into `session.start`; the analyzer decides. _(Product call —
flagged for approval, see §11.)_

---

## 5. `session.start` 2.0

`packages/log-core/src/events.ts`, `SessionStartPayload`. Additive; 1.x readers
ignore what they do not know.

```ts
// retained, unchanged
(format_version,
  session_id,
  prev_session_id,
  assignment,
  manifest_sig,
  machine_id,
  recorder,
  session_pubkey);

// NEW in 2.0
manifest: Manifest; // the FULL manifest: payload + sig + course_cert
identity: {
  enrollment: {
    // signed by the course key
    student_ref: string; // opaque UUID, never a raw SID
    course_id: string;
    student_pubkey: string;
    issued_at: string;
    expires_at: string;
    course_sig: string;
  }
  session_pubkey_sig: string; // student per-course key's sig over session_pubkey
}
host: {
  // replaces the VS Code-shaped `vscode` block
  editor: 'vscode' | 'jetbrains' | 'neovim';
  editor_version: string;
  editor_build: string; // '' permitted — VS Code does not expose this
  platform: string;
}
```

Two consequences worth stating:

- **Check 2 becomes a real check.** `verify-session-binding.ts` today compares
  `manifest_sig` across sessions for equality, because the signed payload never
  enters the bundle — its own comment says so. Carrying the full manifest lets the
  analyzer walk root → course → manifest → session entirely offline, trusting
  nothing from the server.
- **`vscode` → `host` un-warps the payload.** provjet and provnvim currently have
  to pretend into a VS Code-shaped field. `vscode` is retained as a deprecated
  alias on read for 1.x bundles; 2.0 writers emit `host` only.

---

## 6. Scope resolution (git submission)

A discovered `.provenance/` is already self-identifying: both `.provenance-manifest`
and the sealed `manifest.json` carry `assignment_id` and `semester`. So ingest does
not need to be told _where to look_ — it needs to be told _what to accept_.

Default: walk the whole tree, find every bundle, filter by declared `assignment_id`.
That covers all three observed repo shapes (manifest at root; manifest in one
subfolder; many manifests, one relevant).

Path configuration exists only as an override, for cases self-identification cannot
resolve — two folders declaring the same id, or a stale vendored copy:

```ts
assignments.ingest_scope = {
  mode: 'self_identifying' | 'path',
  path_glob?: string,          // e.g. 'proj2/**'
  on_multiple: 'error' | 'ingest_all'
}
```

Configured on the server's assignment record; provgate passes it through from its
existing Gradescope→Provenance assignment mapping.

---

## 7. Contributor model

`submissions.student_id` is `NOT NULL` today — the schema cannot express a group.
The end state:

- `submission_contributors` join table: `(submission_id, roster_entry_id, student_pubkey, first_seen, last_seen)`
- `submissions.student_id` becomes nullable, retained for solo submissions
- `flags` gains a nullable `contributor_id`
- **Reconstruction and replay use every session in the scope; per-contributor
  heuristics filter to that contributor's sessions.** A shared file's timeline must
  be complete or replay shows phantom holes and `fs.external_change`-shaped
  heuristics false-positive.
- Cross-submission similarity between known contributors on the same scope is
  expected, not suspicious — cross-flags must exclude same-scope contributor pairs.

**Deletion detection, without `.git`.** Either partner can `rm` the other's log in
an ordinary-looking commit. Two mechanisms, both cheap and offline:

1. **Session continuity** — `prev_session_id` already chains a contributor's
   sessions. A missing middle session is detectable from the next one's back-pointer.
2. **Peer witnessing** — when a `git pull` drops a foreign `.slog` into the tree,
   the recorder (which already watches the filesystem) records
   `observed { session_id, slog_sha256, seq_high }` into its **own** signed chain.
   Deleting a partner's log leaves your own chain testifying that it existed. To
   hide a deletion you must destroy both chains, which yields a submission with no
   provenance at all — the loudest possible signal.

Peer witnessing needs a new event kind and is therefore a tri-repo change.

---

## 8. Sub-projects and dependency order

|        | Sub-project                                               | Repos touched                        | Unblocks                                                       |
| ------ | --------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| **S0** | Root key → course cert hierarchy                          | 3 recorders, server                  | Any second course, group or not                                |
| **S1** | Manifest 2.0: policy + capability flags                   | 3 recorders, analysis-core, analyzer | Professor capture controls; `collaboration`/`submission` flags |
| **S2** | Student identity + enrollment tokens                      | 3 recorders, server                  | Attribution that survives a denial                             |
| **S3** | Git-native ingest: scope discovery, fan-out, rolling seal | server, 3 recorders                  | 61B/61C for solo assignments                                   |
| **S4** | Contributor model + peer witnessing                       | server, analyzer, 3 recorders        | Group submissions as first-class                               |
| **S5** | Commit-graph capture + branching replay                   | 3 recorders, analyzer                | Replay matching real pair workflow                             |
| **S6** | CPHS amendment, partner-visibility consent, quota         | docs, ops                            | Deployment gate; runs in parallel                              |

S0–S3 are prerequisites for S4 and S5 regardless of scheduling.

**S0 + S1 ship as one coordinated tri-repo release.** They are one format change;
landing them piecemeal creates a window where a student's provjet install cannot
read a manifest their VS Code install can.

### The rolling seal (S3)

No seal step means no `manifest.json` / `manifest.sig`, which kills validation
checks 1, 2, and 8 and makes `loader/unzip.ts` reject the input outright. The fix:
the recorder rewrites `manifest-<session_id>.json` + `.sig` on each checkpoint.
Per-session filenames keep git merges add-only and conflict-free — the same property
that makes per-session `.slog` files mergeable. Restores checks 1, 2, and 8 with
zero student action and no seal command.

---

## 9. Migration rule — readers before writers

Non-negotiable ordering for the format bump:

1. `log-core` — types, parser, vectors. Accepts 1.0, 1.1, **and** 2.0.
2. `analysis-core` + `server` + `analyzer` — **read** 2.0. Emit nothing.
3. Recorders emit 2.0, one at a time: VS Code → provjet → provnvim.

Never the reverse. **1.x parsing is supported permanently** — archived submissions
must still validate years later, which is precisely the adjudication case that
justifies this program.

The legacy course-key grandfathering (§2) enables a safe deployment ordering for
switching a course's manifests to 2.0 without a recording gap:

1. Ship all three recorders built against a version that accepts **both** 1.x
   (via `LEGACY_COURSE_PUBLIC_KEY_HEX`) **and** 2.0 (via `ROOT_PUBLIC_KEY_HEX`).
   Every currently-issued 1.x manifest keeps activating throughout.
2. Confirm adoption — the new recorder build is what students actually have
   installed, and it is verifiably reading 2.0 manifests where issued.
3. Switch manifest issuance to 2.0 (root-signed `course_cert` + course-signed
   payload) for that course.
4. Only once no course has 1.x manifests left that still need verifying, drop
   `LEGACY_COURSE_PUBLIC_KEY_HEX` in a later recorder release (see §2's removal
   condition) — stop supplying `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX` to
   `tools/embed-root-key.ts` and delete the constant and its routing branch.

Steps 1-3 can run per-course on independent timelines; step 4 is a one-time,
whole-program cutover once every course has cleared step 3.

---

## 10. Conformance vectors — the cross-repo mechanism

**This mechanism already exists — do not build a new one.**
`tools/export-conformance-vectors.ts` is the single generated source of truth for
cross-language format parity, and both recorder repos already consume its output:

- provjet — `core/src/test/resources/conformance/*.json`, via `ConformanceTest.kt`'s `vector(name)`
- provnvim — `tests/conformance/fixtures/*.json`, via `conformance_spec.lua`'s
  `load_fixture(name)`, regenerated by its Makefile `vectors` target shelling out to
  this script in `$PROVENANCE_REPO`

New format work extends that script's `--out` family, following its one-file-per-primitive
convention. Manifest 2.0 added three siblings: `manifest-v2.json`, `course-cert.json`,
`capture-policy.json`.

Two properties are load-bearing and must survive every future change: the script uses
**fixed** ed25519 seeds and HKDF salt/nonce fills so regeneration reproduces committed
fixtures byte-for-byte (that drift check is what proves the export faithful), and a
change that perturbs an existing vector's bytes is a **breaking change to two other
repos**, not a refactor.

Known pre-existing debt: `golden-bundle.{json,zip}` is non-deterministic despite the
script's comment claiming otherwise (`buildTestBundle` generates a random session
keypair), and provnvim's committed `manifest.json` fixture has already drifted from
provjet's. Neither was introduced by this program; both should be fixed before they
mask a real divergence. Vectors are
surfaces as a failing test rather than as a subtly divergent signature
implementation discovered later in an OSC case.

Every mandatory rule in §2–§5 above must have a corresponding vector.

**Conformance vectors and per-recorder fixtures are different things — never merge
them.** A vector is generated, shared, and must be byte-identical across all three
repos. A _legacy-anchor fixture_ is a 1.x manifest signed with **that repo's own**
legacy key (§2), so the shared generator can never own it. provnvim learned this the
hard way: one file was serving both roles, and regenerating it correctly as a vector
silently destroyed the end-to-end proof that the embedded legacy key still activates
1.x manifests — the single path grandfathering exists to protect. Keep them in
separate files, in separate directories, with the reason written down.

Store a legacy fixture as a **bare manifest object with no public key beside it**, so
no test can pass an override and accidentally prove something weaker: `active` must
be reachable only through the embedded constant.

---

## 11. Open decisions requiring explicit approval

Per `CLAUDE.md`, these are product/architecture calls, not coding calls:

1. **Format version bump to manifest 2.0.** Changes the signed payload. Requires
   approval and a coordinated tri-repo release.
2. **Expired cert behaviour** — record-and-stamp (proposed) vs. refuse-to-activate.
3. **`submissions.student_id` becoming nullable** + new `submission_contributors`
   table. A schema migration on a table that currently backs every read path.
4. **New event kind for peer witnessing** — adds to `EventKindMap`, requires an
   `/architecture` update and tri-repo implementation.
5. **Retiring `build:prod`'s course-key embedding.** Changes the release process and
   invalidates the README "key & manifest workflow" section.
6. **CPHS amendment (S6).** Cycle 3 was answered on a solo-submission model. Group
   work means one student's process log is readable by their partner, which the
   current protocol does not describe. This gates 61B deployment independently of
   any code.

---

## 12. Things this program explicitly does not do

- It does not make attribution proof against a student working on their partner's
  machine. No identity scheme can. What course-issued keys buy is **unforgeability**
  (Alice cannot produce a log claiming to be Bob) and **non-repudiation** (Bob cannot
  disown his own log).
- It does not encrypt logs in the shared repo. Partners can read each other's
  process data; that is handled as consent and policy in S6, not as crypto.
- It does not reintroduce an `events` table, network calls during a session, or
  modification of `manifest.json` / `manifest.sig` after signing.
