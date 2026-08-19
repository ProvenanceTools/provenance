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

- **The recorder embeds the root public key only.** `COURSE_PUBLIC_KEY_HEX` is
  replaced by `ROOT_PUBLIC_KEY_HEX`. `tools/embed-course-key.ts` and the
  `build:prod` key-embedding step are retired — one build serves every course.
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
- **The session-key KDF is unchanged.** `session-keys.ts` still uses the manifest
  signature as HKDF IKM; that signature is now produced by a course key instead of
  the single embedded key.
- **Revocation is server-side only.** An offline recorder cannot learn that a key
  was revoked without breaking recorder PRD NG2. The analyzer/server keeps a
  revoked-cert list and flags submissions signed under one. Mitigation for the gap
  is short validity windows — one semester per cert. This is a real, accepted
  limitation and must be written into the S0 spec, not papered over.
- **Enrollment tokens carry an opaque `student_ref`, never a raw SID.** In a shared
  61B repo, one partner can read the other's `session.start`. The server maps
  `student_ref` → `roster_entries.id`; a partner sees only a UUID.

---

## 3. Manifest 2.0

`packages/log-core/src/manifest.ts`. Two independent signature scopes in one file.

```jsonc
{
  "format_version": "2.0",

  "course_id":          "berkeley-cs61b",   // ┐
  "assignment_id":      "proj2",            // │
  "semester":           "fa26",             // ├─ canonicalized + signed by COURSE key
  "issued_at":          "2026-09-08T00:00:00Z", // │
  "files_under_review": ["..."],            // │
  "collaboration":      "solo",             // │  "solo" | "group"
  "submission":         "bundle",           // │  "bundle" | "git"
  "scope":              "directory",        // │  "directory" | "repo"
  "policy":             { "...": "..." },   // ┘  see §4
  "sig": "9c2e…",

  "course_cert": {                          // ┐
    "course_id":     "berkeley-cs61b",      // ├─ canonicalized + signed by ROOT key
    "course_pubkey": "a91f…",               // │
    "valid_from":    "2026-08-20",          // │
    "valid_until":   "2027-01-15",          // ┘
    "root_sig": "4b70…"
  }
}
```

**`Manifest` has no `format_version` field today.** 1.x manifests are therefore
identified by its *absence*; the parser MUST default a missing `format_version` to
`"1.0"` and continue, never reject. Conformance vector required.

`buildSignedPayload` excludes `sig` **and** `course_cert` — the course does not
sign its own certificate.

Verification order (identical in all three recorders):

1. `course_cert` minus `root_sig` → verify against embedded root pubkey. Fail → do not activate.
2. Payload minus `sig` and `course_cert` → verify against `course_cert.course_pubkey`. Fail → do not activate.
3. Assert `manifest.course_id === course_cert.course_id`. Fail → do not activate.
4. Check `issued_at` falls within `[valid_from, valid_until]`. **Out of window does
   NOT block activation** — see §4.

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
    "doc_open_close":        true,
    "inline_content":        true,     // paste + fs.external_change content snippets
    "heartbeat_interval_ms": 30000     // clamp [5000, 120000]
  }
}
```

**Hard floor — these event kinds are not expressible in `policy.capture` and can
never be disabled**, because validation checks 3–8 and the integrity story depend
on them:

`session.start`, `session.end`, `session.resumed`, `doc.change`, `doc.save`,
`paste`, `fs.external_change`, `git.event`, `clock.skew`, `chain.broken`,
`ext.snapshot`, `ext.activate`, `recorder.degraded`,
`recorder.recovered_from_corruption`, `session.heartbeat`

The floor is enforced by the schema itself: floor events simply have no key in
`policy.capture`. `session.heartbeat` is on the floor because bundle-level
Active/Idle and the `gap_in_heartbeats` heuristic depend on it — only its interval
is tunable.

**The absence-vs-disabled rule.** The effective policy MUST travel into the bundle,
because otherwise the analyzer cannot distinguish "this student produced no
`selection.change` events" from "this course disabled `selection.change`", and
heuristics will mis-fire on the difference. Any heuristic that consumes an optional
signal MUST consult the recorded policy and return *not-applicable* rather than a
flag or a zero. **The S1 spec must include an audit of all 25 heuristics against
this rule.**

**Expired cert does not stop recording.** If a course lets a cert lapse mid-semester,
refusing to activate would silently stop recording for an entire class — a worse
failure for an integrity tool than recording under a stale key. The recorder records
and stamps the expiry into `session.start`; the analyzer decides. *(Product call —
flagged for approval, see §11.)*

---

## 5. `session.start` 2.0

`packages/log-core/src/events.ts`, `SessionStartPayload`. Additive; 1.x readers
ignore what they do not know.

```ts
// retained, unchanged
format_version, session_id, prev_session_id, assignment, manifest_sig,
machine_id, recorder, session_pubkey

// NEW in 2.0
manifest: Manifest        // the FULL manifest: payload + sig + course_cert
identity: {
  enrollment: {           // signed by the course key
    student_ref: string   // opaque UUID, never a raw SID
    course_id: string
    student_pubkey: string
    issued_at: string
    expires_at: string
    course_sig: string
  }
  session_pubkey_sig: string   // student per-course key's sig over session_pubkey
}
host: {                   // replaces the VS Code-shaped `vscode` block
  editor: 'vscode' | 'jetbrains' | 'neovim'
  editor_version: string
  editor_build: string    // '' permitted — VS Code does not expose this
  platform: string
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
not need to be told *where to look* — it needs to be told *what to accept*.

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

| | Sub-project | Repos touched | Unblocks |
|---|---|---|---|
| **S0** | Root key → course cert hierarchy | 3 recorders, server | Any second course, group or not |
| **S1** | Manifest 2.0: policy + capability flags | 3 recorders, analysis-core, analyzer | Professor capture controls; `collaboration`/`submission` flags |
| **S2** | Student identity + enrollment tokens | 3 recorders, server | Attribution that survives a denial |
| **S3** | Git-native ingest: scope discovery, fan-out, rolling seal | server, 3 recorders | 61B/61C for solo assignments |
| **S4** | Contributor model + peer witnessing | server, analyzer, 3 recorders | Group submissions as first-class |
| **S5** | Commit-graph capture + branching replay | 3 recorders, analyzer | Replay matching real pair workflow |
| **S6** | CPHS amendment, partner-visibility consent, quota | docs, ops | Deployment gate; runs in parallel |

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

---

## 10. Conformance vectors — the cross-repo mechanism

The format contract is written **once**, in `log-core`, as golden JSON vectors —
generalizing the pattern `hash-chain.test.ts` already uses:

```
packages/log-core/vectors/
  manifest-2.0/valid-*.json         cert chains, policy blocks, 1.x-without-format_version
  manifest-2.0/invalid-*.json       bad root sig, course_id mismatch, issued_at out of window
  canonicalization/*.json           JCS inputs → expected bytes
  policy-resolution/*.json          manifest policy → effective capture set
```

Each vector is `{name, input, expected}`. `log-core` runs them under Vitest; provjet
runs the same files from a Kotlin test; provnvim from a Lua test. Vectors are
vendored into each recorder repo with a checksum check against upstream, so drift
surfaces as a failing test rather than as a subtly divergent signature
implementation discovered later in an OSC case.

Every mandatory rule in §2–§5 above must have a corresponding vector.

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
