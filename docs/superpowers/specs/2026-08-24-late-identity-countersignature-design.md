# Late identity countersignature — attributing a session whose student enrolled after it started

**Repo:** `provenance` monorepo (branch `feat/manifest-2.0-trust-chain`)
**Date:** 2026-08-24
**Status:** Design, NOT approved. Ends in a **recommendation to defer** the format change (§8) — the
mechanism below is specified in full so the decision is made against a real design rather than a
sketch, and so it can be executed unchanged if the re-open condition in §8.4 is met.
**Parent specs:**
[`2026-08-18-multicourse-program-architecture.md`](./2026-08-18-multicourse-program-architecture.md) — §5 (`session.start` 2.0), §5a (student identity), §9 (readers-before-writers), §10 (conformance vectors);
[`2026-08-19-git-collaboration-semantics.md`](./2026-08-19-git-collaboration-semantics.md) — §5.1 (contributor), §5.2 (ordering), §6 (presenting ambiguity).
**Repos touched if implemented:** `provenance` (`log-core`, `analysis-core`, `shared`, `analyzer`,
`server`, `tools/export-conformance-vectors.ts`, `/architecture`),
`provenance-jetbrains-recorder`, `provenance-neovim-recorder`.

---

## 0. How to read this

§1–§2 establish the problem and verify the claim the proposal rests on. §3–§7 are the design,
answering the six questions the brief asks in order. §8 is the recommendation, and it does **not**
follow automatically from §3–§7: the mechanism is sound and the cost/benefit is what decides.
Read §2 and §8 first if you read nothing else.

---

## 1. Problem

A student who obtains their institution credential **midway through a live recording session**
loses attribution for everything recorded before the import — permanently, and with no visible
trace that anything was lost.

### 1.1 The three facts that produce it

Each verified against the source, not assumed.

**(a) Attribution comes only from `session.start.identity`.**
`packages/analysis-core/src/identity/resolve-contributors.ts` reads
`session.firstEvent.data.identity` and nothing else, and its module docstring rules out every other
candidate with a stated reason: never `machine_id` (it is `sha256(hostname:username:session_id)`, so
it is session-salted and cannot match across two sessions of the same person), never git author
(`log-core/src/events.ts` §"No author identity. Ever."), never the upload filename (the server's
`match-student.ts` regex identifies the _submitter_, which in a shared repo is at most one of the
contributors). Restated as a rule in the collaboration spec §5.1.

**(b) The identity block is built once, at session start, before the session exists.**
All three recorders are structural ports of the same sequence — generate session keypair → build
identity → chain recovery → build context → emit `session.start`:

|                      | VS Code                                                  | JetBrains                                                       | Neovim                                                      |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| Builder              | `packages/recorder/src/identity/session-identity.ts:140` | `recorder/.../identity/SessionIdentityBuilder.kt:148`           | `lua/provenance/recorder/identity/session_identity.lua:184` |
| Call site            | `session/session-registry.ts:291` (`startSession`)       | `session/RecorderSessionManager.kt:272` (`startFromActivation`) | `session/recording_session.lua:229`                         |
| `sessionStartedAt`   | `clock.wall()` @ `:296`                                  | `clock.wall()` @ `:277`                                         | `clock.wall()` @ `:232`                                     |
| `session.start` emit | `session-registry.ts:697`                                | `RecordingSessionController.kt:506`                             | `recording_session.lua:578`                                 |

**Importing a credential into a live session does nothing for it.** The import commands
(`provenance.importEnrollmentToken` / `ImportEnrollmentTokenAction` / `:ProvenanceEnrollmentImport`)
write to secret storage and return. None of them touches the session registry; none refreshes the
status bar. All three say so in their own success message — _"New recording sessions … will include
your identity."_ No recorder has a restart-on-import path, and none has a TODO for one. The
credential store is read exactly once per session, at start; no running session re-reads it
(`ActiveSession` retains a frozen `identityOutcome`, not the store).

**(c) `session.start` cannot be amended.** The log is append-only and hash-chained; there is no
update and no delete anywhere in the log path. Editing `session.start` after the fact breaks the
chain at seq 0 and every entry after it.

### 1.2 Why this is structural, not an edge case

The system creates the condition it then punishes. The 2.0 course-scoped mint was retired precisely
because it deadlocked — it required a `roster_entries` match, and rosters are populated by Gradescope
ingest, which runs only _after_ a student submits
(`packages/server/src/api/v1/routes/credential.ts` module header). The 2.1 replacement removed the
deadlock but not the timing: a student obtains a credential when they get round to it, which is not
reliably before their first session.

Two further facts sharpen it:

- **`unattributed` is not a neutral state.** No finding may name a person on an unattributed
  session's strength (collaboration spec §5.1), and `compareContributors` returns `'unknown'` for any
  pair involving one — which is the direction that keeps contributor-gated heuristics _firing_
  (`identity/types.ts`). On a group submission, unattributed sessions therefore generate grader
  noise as well as losing credit.
- **Re-issue does not repair the past.** `issueStudentCredential` returns the **same** `student_ref`
  with a fresh `issued_at` — so a student can always get a valid credential, and it will never
  retroactively attach to a session already recorded.

The reported incident — a real group submission in which every session came back `unattributed` —
is an instance of this family. §8.2 examines whether it is an instance this proposal would have
fixed.

---

## 2. The core argument, examined

> The identity block binds `student_ref → session_pubkey` via a countersignature. It does not attest
> individual events. So producing that countersignature at 23:50 proves exactly what producing it at
> 23:35 would have proved. A late block can therefore honestly attribute the WHOLE session,
> including work recorded before the import.

**Verdict: the argument holds.** Verified against the signed payload, not inferred from prose.

`buildStudentSessionBindingPayload` (`log-core/src/institution.ts`) canonicalizes exactly four keys:

```
institution_id, purpose, session_pubkey, student_ref
```

`purpose` is the fixed constant `STUDENT_SESSION_BINDING_PURPOSE` (`'provenance-session-pubkey-binding-v2'`).
The 2.0 twin (`buildSessionPubkeyBindingPayload`) is the same shape with `course_id`.

Three properties follow directly:

1. **There is no time in the signed message.** Nothing in the payload records, bounds, or implies
   when the signature was produced. A signature over these bytes made at 23:50 is _byte-identical_
   to one made at 23:35. There is no cryptographic sense in which one is "late".
2. **There is no event in the signed message.** The countersignature says "the holder of
   `student_pubkey`, known to the institution as `student_ref`, adopts this session key." It says
   nothing about what the session recorded, and it could not — the events did not exist when a
   start-time signature was made either. A start-time block attributes the whole session for exactly
   the same reason a late one would: because it attributes the _key_, and the log is the key's log.
3. **The binding is already session-unique.** `session_pubkey` is ephemeral and per-session, so a
   countersignature cannot be lifted from one session onto another. That protection is unaffected by
   when it was produced.

**The consequences of the argument holding cut both ways, and both must be carried through the
design:**

- **In favour.** A late block is not a weaker artifact. It is the same artifact, in a different
  position. Attributing the whole session on its strength is honest.
- **Against.** Because a late block is cryptographically indistinguishable from a start-time one,
  _it carries no proof that it is late_, and equally no proof that it is not. Its "lateness" is a
  fact about its position in a hash chain — nothing more. Any part of the design that wants to treat
  lateness as evidence must derive it from something other than the signature. §5 does this from
  `credential.issued_at`, which is institution-signed.

**Rejected as unnecessary: a distinct `purpose` tag for the late binding.** The obvious instinct is
to domain-separate a late countersignature from a start-time one. It buys nothing. Moving a
start-time countersignature into a late event of the _same_ session changes no claim (same
`session_pubkey`, same `student_ref`); moving it to a _different_ session fails already, because
`session_pubkey` differs. A new tag would cost a new signed payload, a new conformance vector, and a
new implementation in three ports, in exchange for separating two things that mean the same thing.
**The late block reuses the existing payload and the existing purpose tag, unchanged.** This is what
keeps the format change small enough to be worth discussing at all.

---

## 3. Q1 — Event shape

### 3.1 Decision: a new event kind, `session.identity`

**Rejected: an optional identity field on an existing event kind.** No existing mid-session event is
emitted at credential-import time. `session.heartbeat` fires on a timer whose interval is
**capture-policy controlled** (`resolveHeartbeatInterval`), so hanging identity off it would make an
attribution's existence depend on a course's policy and on whether a tick happened to land.
`session.resumed` fires on resume, which is unrelated. Attaching identity to either would also
overload an event whose meaning is settled, in a format three ports must reproduce.

**Chosen: a new kind.** It is also the maximally forward-compatible option — see §7.1.

### 3.2 Payload

`SessionIdentityPayload` **is** `SessionIdentity`, verbatim:

```ts
'session.identity': SessionIdentity;   // { enrollment, enrollment_cert, session_pubkey_sig }
```

Deliberately absent, each for a reason:

- **No timestamp.** The envelope already carries `t` and `wall`, and neither is attested (§5.2).
  Adding a self-asserted instant _inside_ a payload the student also signs would dress an unverified
  claim as a verified one.
- **No `session_id` / `session_pubkey`.** The verifier takes `session_pubkey` from
  `session.start.data.session_pubkey` of the log the entry sits in, exactly as it does today. A
  copy inside the payload would be a second source of truth for the same fact, and the two could
  disagree.
- **No `format_version`.** The version discriminator is already the **signed**
  `enrollment_cert.format_version`, and the router (`verifyIdentityChain`) reads it before any
  signature work. Adding a second, unsigned version field is precisely the "route on which fields are
  present" bug that `bundle-manifest.ts` already shipped once.

### 3.3 `log-core` changes

1. `EventKindMap` gains `'session.identity': SessionIdentity` (`events.ts:560`).
2. The kind is a **floor kind**: it is NOT added to `POLICY_GATED_EVENT_KINDS`. `isEventKindCaptured`
   returns `true` for any ungated kind, so this is the default — but it must be stated and tested.
   A course-signed capture policy must never be able to suppress attribution: the policy block exists
   so a professor can turn _capture_ down, and letting it strip _identity_ would let a
   misconfiguration silently unattribute a cohort.
3. No new signed payload, no new purpose tag, no new signing or verification function. §2.

### 3.4 Conformance vectors (§10 of the parent spec)

`tools/export-conformance-vectors.ts` gains a section in the existing **`identity.json`** — not a
new file. The primitive is unchanged; what is new is a _reader rule_, and it belongs beside the
chain it modifies. Required cases, each mandatory for all three ports:

| Vector                                         | Asserts                                                                                                                       |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `appended_binding_is_byte_identical`           | the countersignature over a given `session_pubkey` is the same bytes whether emitted at seq 0 or seq N — the §2 claim, pinned |
| `appended_only`                                | no `session.start.identity`; one admissible `session.identity`; expected verdict `attributed`, `binding.at = 'appended'`      |
| `start_and_appended_agree`                     | both present, same `student_ref`; `attributed`, `binding.at = 'session_start'`, redundancy noted, no finding                  |
| `start_and_appended_conflict`                  | both present and both chains verify, different `student_ref`; expected `unverifiable / conflicting_identity` (§6.3)           |
| `appended_broken_beside_verified_start`        | verified start + malformed appended; start attribution **survives** (§6.4)                                                    |
| `appended_outside_sealed_prefix`               | admissibility gate refuses it; verdict is the verdict without it (§6.2)                                                       |
| `appended_in_a_final_sealed_session`           | a `session.identity` past a `final: true` seal is inadmissible (§4.3)                                                         |
| `two_appended_agree` / `two_appended_conflict` | multiplicity rules (§6.3)                                                                                                     |

Per parent spec §10: the export uses fixed seeds, regeneration must reproduce committed fixtures
byte-for-byte, and perturbing an existing vector's bytes is a **breaking change to two other repos**,
not a refactor. Nothing in this design perturbs an existing vector — every case above is additive.

`/architecture` must be updated in the same PR (CLAUDE.md lists "add, remove, or rename an event
type" as an explicit trigger): `tools/architecture/dot/*.dot`, then
`content/nodes/{chain,analysis}.ts`. `nodes.coverage.test.ts` fails otherwise.

---

## 4. Emission — when a recorder may write one

### 4.1 The trigger

On a successful credential import (`saveIdentityArtifact` returning ok) while a session is live:

1. Build the countersignature over the **live session's** `session_pubkey`. The keypair outlives
   session start in all three recorders (`ActiveSession.sessionKeypair`; JetBrains `preparedKeypair`;
   Neovim's `keypair` upvalue), so no new plumbing is needed.
2. Walk the assembled block with `verifyIdentityChain` before writing it — the existing **Rule 2**
   every recorder already applies at start (`session-identity.ts:238-252` and its two ports). On
   failure, **do not write**: a broken claim inside a signed chain is permanent.
3. Emit through the normal host seam (`SessionHost.emit`), never the writer directly, so the entry
   gets its `seq` / `prev_hash` / `t` from the one chaining path.
4. **Immediately take a rolling seal and a checkpoint.** Hard requirement, not an optimization — see
   §6.2: without it, honest late blocks sit in the session's unattested tail and the analyzer's
   admissibility gate will refuse them.

### 4.2 At most one per session

A second import in the same session yielding the **same** `student_ref` is a no-op. One yielding a
**different** `student_ref` is **refused** with a message telling the student to start a new
session. Writing it would deliberately manufacture the conflict state of §6.3, permanently, inside a
signed chain.

### 4.3 Only into a live session — and this is the binding constraint

A late block can only be written while the session is running. This is not a simplification; it is
forced, and it is the single most important limit on what this feature can do.

`dispose()` takes a final rolling seal after `session.end`, marked `final: true` inside the signed
payload. `loader/rolling-coverage.ts` is explicit: for a final seal the prefix search is not merely
unnecessary but _wrong_, so coverage goes through `wholeFileCoverage` and **an append fails at full
strength**. A `session.identity` appended to a finished session is therefore inadmissible by
construction.

**Reopening a sealed session is out of scope and should stay out.** The recorder does hold the
material to rewrite a final seal, so it is mechanically possible — and it would mean `final: true`
no longer means what `rolling-coverage.ts` says it means, which is load-bearing for the
append-detection this system depends on. Not worth it, at any benefit.

**Consequence for §8:** the population this feature can help is _sessions still running at the
moment of import_ — the same population the restart alternative helps. The only difference between
the two options is what happens to work already recorded **within that one session**.

---

## 5. Q2 — Which timestamp does it attest?

### 5.1 What is currently judged against what

`walkInstitutionChain` (`institution.ts`) returns two non-fatal window statuses:

- `cert_window` = `checkInstitutionCertWindow(cert, credential.issued_at)` — "was this institution
  key authorized when it issued this credential?"
- `token_window` = `checkCredentialWindow(credential, session_started_at)` — "did this student hold a
  valid identity when they did this work?"

`session_started_at` is `session.firstEvent.wall` (`resolve-contributors.ts`). Windows are
**reported, never enforced**, in both log-core and analysis-core: an institution letting a cert lapse
mid-semester must not retroactively strip a term's attribution.

### 5.2 The two candidate instants, and why neither is attested

- **S** — session start (`session.start.wall`).
- **L** — the late block's own moment (`session.identity.wall`).

Both are written by a student-controlled recorder. Neither is inside any signed payload. Both are
hash-chained, which fixes their _order_ relative to other entries but constrains their _values_ not
at all. **There is no trusted clock anywhere in a bundle**, and the system already knows this — L3 of
the ordering model says wall clock "is never an ordering authority across contributors" and
`skew_lower_bound` exists to measure how far it can be wrong.

So the choice is not "which instant is true" but "which question do we want the reported window to
answer, given that the input to either is self-asserted".

### 5.3 The adversarial cases

Let the credential window be `[V0, V1]`, where `V0 == issued_at`.

**Case A — valid at L, not at S** (`S < V0`). The ordinary honest case: the credential was minted
after the session began. Also the ordinary _re-issue_ case, since `issueStudentCredential` stamps a
fresh `issued_at` on every re-issue of the same `student_ref`.
Judged at S → `before_valid_from`. Judged at L → `in_window`.

**Case B — valid at S, not at L** (`V1 < L`). Semester ended; the student works, then imports a
credential that has since expired.
Judged at S → `in_window`. Judged at L → `after_valid_until`.

**Case C — the adversarial one.** A student works in August. Their credential is valid
`2026-09-01 … 2026-12-15`. They enrol in September and countersign the August session.
Judged at S → `before_valid_from` is reported, truthfully: _this student had no valid credential when
this work was done_. Judged at L → `in_window`, and the August work is presented with a clean
window.

Case C is decisive. Under the L rule, **any** out-of-window position is repairable by choosing when
to click Import, and the recorder writes the instant that decides it. That makes the window vacuous
against exactly the reader it exists for.

### 5.4 Recommendation: attest **S**, unchanged, for every identity block

`credentialWindow` continues to mean `checkCredentialWindow(credential, session.firstEvent.wall)`,
whether the block arrived at seq 0 or seq N. Four reasons:

1. **It preserves an existing field's meaning across three ports and a wire schema.** Changing what
   `token_window` measures — silently, based on where a block sits — reinterprets archived data.
   That is the class of change §9's readers-before-writers rule exists to prevent.
2. **L is attacker-chosen; S is at least the instant every other part of the system already uses.**
   Judging a validity window against a freely chosen instant is not a weaker check, it is no check.
3. **`before_valid_from` on a late block is not an accusation — it is the signal.** Because
   `V0 == issued_at` is **institution-signed**, `credentialWindow == before_valid_from` is _exactly_
   the statement "this credential was minted after this session started", derived entirely from
   signed material. Keeping the S rule is what makes late adoption legible without trusting a
   student-written timestamp. Under the L rule that signal disappears.
4. **Symmetry.** Two bundles with identical work and identical credentials must not report different
   window statuses because one student clicked Import earlier in the session.

**And it is a report, not a gate.** A late block whose `credentialWindow` is `before_valid_from` is
still `attributed`. Nothing in §6 enforces a window. That is the existing rule and this design does
not touch it.

**What replaces the discarded question.** "Was the credential valid when the vouching happened?" is
still worth surfacing, but not as a window check over an unattested instant. It is surfaced as the
descriptive `binding` record of §6.5 — the seq at which the block landed, out of how many — which
tells a reader the same thing without pretending to a precision the artifact does not have.

---

## 6. Q3 — Analyzer changes

All of this is in `packages/analysis-core/src/identity/resolve-contributors.ts` and
`identity/types.ts`. `contributorOf` / `contributorsOf` / `attributedContributorsOf` keep their
signatures; the async/sync seam and the Bundle stamp are unchanged.

### 6.1 Claim collection

`resolveSessionContributor` today reads one place. It gains a **claim set**:

- `start` — `session.firstEvent.data.identity`, if the key is present.
- `appended[]` — every `session.identity` entry in `session.events`, in `seq` order.

Absence of _all_ claims → `unattributed`, exactly as today. Presence of any claim means the session
can no longer exit as `unattributed` — the existing invariant, extended to the new source.

### 6.2 Admissibility gate — an appended claim must lie inside the sealed prefix

**This is the security-critical addition and the part most likely to be got wrong.**

Appending is not signing. `.slog` entries are hash-chained but not individually signed, so anyone who
can write the file can append an entry and re-chain forward. On the **git-native path there is no
seal step at all** — the student pushes, the grader clones, and whatever is in `.provenance/` is the
submission — and that directory sits in a repo a partner can commit to. `session.start` is immune by
construction: it is written before anyone else can reach the file, and every seal ever taken covers
it. An appended entry has neither protection.

Without a gate, a partner could append a conflicting or malformed identity block to your log and
contest or destroy your attribution. **The gate restores the property using machinery that already
exists.**

> An appended identity claim is admissible only if the entry lies inside the session's sealed
> prefix — `RollingSealCoverage.slog` is `exact`, or `partial` with `sealed` bytes covering the byte
> offset at which that entry ends (`loader/rolling-coverage.ts`; a `final` seal goes through
> `wholeFileCoverage`, so an append past it is never admissible, per §4.3).

An inadmissible claim is **not silently dropped**. It is carried as an
`unsealed_appended_identity` observation on the session, and it is **never a finding on its own**:
`rolling-coverage.ts` is explicit that an unattested tail is inherent to a continuously-rewritten
seal and that a crash, a power cut, or a `git checkout` that removed `.provenance/` all produce one.
Accusing on it would repeat this repo's worst failure mode.

**The cost, stated plainly.** An honest student whose session dies between the import and the next
roll loses the late attribution. §4.1 step 4 — seal immediately on emit — makes that window
approximately zero. Between "an honest student loses a late attribution after a crash" and "a
partner can rewrite who a session belongs to", the former is the correct failure.

**The risk, also stated plainly.** This makes attribution depend on seal-coverage resolution — the
single most defect-prone component in the analyzer, and the source of at least three high-severity
false accusations already (`loader/types.ts` on `LogFileId` / `LogicalSessionId`;
`rolling-coverage.ts` on prefix-vs-whole-file). See §9.

### 6.3 Resolution, including disagreement

Each admissible claim is walked **independently** with `verifyIdentityChain`, against the same
anchors and the same `session_started_at` (§5.4). Then:

| Claim set                                | Verdict                                                                                                                                          |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| none                                     | `unattributed`                                                                                                                                   |
| one, verifies                            | `attributed`; `binding.at` per its position                                                                                                      |
| one, fails                               | `unverifiable`, reason as today                                                                                                                  |
| ≥2 verify, **all same `contributorKey`** | `attributed` to it; `binding.at` = the **earliest** claim's position (so `session_start` wins when present); redundancy recorded, **no finding** |
| ≥2 verify, **any two differ**            | **`unverifiable / conflicting_identity`** — see below                                                                                            |
| ≥1 verifies, others fail                 | the verified attribution **stands**; failures recorded — see §6.4                                                                                |
| all fail                                 | `unverifiable`; report the first failure, carry the rest                                                                                         |

**`conflicting_identity` — the disagreement rule.** A session naming two different people, with both
chains verifying, is an artifact that contradicts itself. There is no rule that picks a winner
without favouring someone, and the brief's requirement is exactly that a disagreement must not
silently resolve in the claimant's favour. So:

```ts
| { kind: 'conflicting_identity';
    claims: readonly { studentRef: string; scope: ContributorScope; scopeId: string;
                       at: 'session_start' | { seq: number } }[];
    detail: string }
```

added to `IdentityUnverifiableReason`, with `isIdentityCheckFailure` returning **`true`** for it — we
did check, and the artifact failed. The session is `unverifiable`, keyed on the session id and **not**
on any claimed `student_ref`, exactly as the existing `unverifiable` singleton is, and for the same
reason: merging an unverified claim into the contributor it names is how a forged block launders work
onto an innocent student. Both claims stay visible as display-only text.

This also fails in the right direction. `compareContributors` answers `'unknown'` for any pair
involving a non-attributed session, which is the state under which contributor-gated heuristics keep
firing. A contested session produces _more_ scrutiny, not less.

### 6.4 Why a broken appended claim does not destroy a verified start claim

The asymmetry in the table above is deliberate and must be stated, because it looks inconsistent with
"a present-but-broken identity block makes the session `unverifiable`".

- Producing a **verified** conflicting claim requires another student's private key — either they
  cooperated (contract cheating, worth contesting) or their master secret is compromised (worth
  contesting). Contesting is right.
- Producing a **broken** claim requires nothing at all. Any byte sequence will do. If a broken
  appended claim could strip a verified start attribution, appending junk becomes a
  denial-of-attribution weapon — the exact vector §6.2 exists to close, re-entering through a
  different door.

So: a verified claim is never destroyed by an unverified one. The unverified one is reported.

### 6.5 The `binding` record — descriptive, never a verdict input

`SessionContributor`'s `attributed` arm gains:

```ts
binding:
  | { at: 'session_start' }
  | { at: 'appended'; seq: number; wall: string; sessionEventCount: number }
```

`wall` is carried **labelled self-asserted** and is never fed into any window check (§5.4). Its
purpose is that a reader can see "attribution was adopted at event 8,412 of 8,930" — which is process
evidence of exactly the kind this system exists to surface, and the honest replacement for the
timestamp question §5.3 rejects.

It is never a `Flag`, never a check failure, never a score. It is a fact about the artifact, on the
same footing as `DroppedArtifact` and `tornTail`.

### 6.6 Downstream surfaces

- `packages/shared/src/api-schemas.ts` — `WireSessionContributorSchema` gains `binding` and the new
  reason kind. **Both optional**, so a newer analyzer parsing an older server's cached
  `contributor_stamp` still validates.
- `analysis-core/src/identity/wire.ts` — mirror the shape; both ends in one diff, per its own header.
- `analyzer/src/lib/contributor-display.ts`, `views/replay/contributor-labels.ts` — render the
  binding point and the `conflicting_identity` reason. `contributor-labels.ts` reads only
  `reason.kind` and `reason.detail` today, so a new arm needs a `detail` string and nothing else.
- **Ordering hazard.** A session gaining attribution can newly make a `prev_session_id` edge
  `'different'` and therefore refused as a `foreign_session_link` (`order/happens-before.ts`), which
  changes `≺` and therefore every `globalIdx`. Contributor resolution already runs before ordering
  (it is stamped on the Bundle at load), so the ordering is correct — but the effect is real and a
  test must pin it.
- **Suppression direction.** Attribution can _reduce_ findings (two overlapping sessions attributed
  to different people stop reading as one impossible person). That is the intended effect and is
  identical to what a start-time block does — but it is why §6.2's gate and §6.3's conflict rule are
  not optional decorations.

---

## 7. Q5 — Compatibility across three recorders

### 7.1 Old analyzer, new bundle

**Safe by design.** `parseEntry` (`log-core/src/ndjson.ts:52`) explicitly _"does not reject unknown
`kind` values (PRD §5.1: forward compat)"_, and chaining canonicalizes the whole envelope without
reading the payload, so an analyzer that has never heard of `session.identity` still verifies the
chain it sits in. `/architecture` states this as a designed property of the format.

The entry parses, chains, validates, and is ignored by every kind-switching consumer. The session
resolves `unattributed` — **exactly today's outcome**. The degradation is to the status quo, which is
the correct direction.

Two things must be checked rather than assumed, and both need a test:

- No consumer performs an **exhaustive** switch over `EventKind` that throws or `assertNever`s on an
  unknown value. (Audit found one `_exhaustive: never` in `analyzer/src/components/Header.tsx`, over a
  different union; the event-kind paths are lookup-based.)
- Timeline / event-filter UI renders an unrecognised kind generically rather than blanking a row.

### 7.2 New analyzer, old bundle

**Safe by construction.** No `session.identity` events exist, so the claim set is `{start}` or `{}`
and the algorithm in §6.3 reduces line-for-line to today's. Required regression: a corpus of
pre-change bundles must produce **byte-identical** `BundleContributors` before and after.

### 7.3 Migration order — parent spec §9, non-negotiable

1. **`log-core`** — `EventKindMap` entry, payload type, floor-kind assertion, conformance vectors.
   Ports 2 and 3 consume the vectors from here.
2. **`analysis-core` + `shared` + `server` + `analyzer`** — **read** the kind. Emit nothing. Includes
   the wire schema, the analyzer surfaces, and `/architecture`.
3. **Recorders emit, one at a time:** VS Code → provjet → provnvim. Each release needs
   `npm run update-hashes` for its new `extension_hash`, and provjet's two-variant build needs it
   once per variant.

Never the reverse. A recorder emitting a kind no analyzer reads produces bundles that are silently
unattributed with no diagnostic — indistinguishable from the bug this feature exists to fix.

### 7.4 Per-recorder notes

- **VS Code** is the only port with a closed typed union, so it is the only one needing an
  `EventKindMap` edit; its emit seam is `SessionHost.emit<K extends EventKind>`
  (`session/session-host.ts:31`), which owns `seq`/`prev_hash`/`t` and applies the policy gate before
  chaining. `ActiveSession` already exposes `sessionHost`, so a command can emit mid-session with no
  new plumbing.
- **JetBrains** and **Neovim** take `kind: String` at the host
  (`SessionHost.emit(kind, data)` / `host.emit(kind, data)`), so emission is plumbing only. JetBrains'
  `RecordingSessionController.append` already drops after `endSession`, which enforces §4.3's live-only
  rule for free.
- **All three** already retain an `IdentityOutcome.skipped` per session (VS Code
  `ActiveSession.identityOutcome`; JetBrains `RecorderState.recordIdentity`; Neovim
  `_identity_outcome`), consumed today only by the status bar and enrol nudge. That is the natural
  trigger for both this feature and the alternative in §8.

---

## 8. Q6 — The cheaper alternative, and the recommendation

### 8.1 The alternative

"Notify + restart the session on import", currently planned for the JetBrains recorder and absent
from all three today (§1.1b). On import: tell the student, stop the live session, start a new one
carrying the identity. `prev_session_id` links the new session to the old.

The ordering edge survives: `compareContributors(attributed, unattributed)` is `'unknown'`, and
`happens-before.ts` refuses an edge only on `'different'`. What does **not** survive is the old
session's attribution — it stays `unattributed` forever, and no finding may name a person on its
strength.

### 8.2 Head to head

Both options are bounded by §4.3 to _sessions still running at the moment of import_. A session that
has already ended is beyond both.

|                                      | notify + restart                                                                                     | late countersignature                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| work **after** import                | attributed                                                                                           | attributed                                                                                                                                    |
| work **before** import, same session | **permanently unattributed**                                                                         | **attributed**                                                                                                                                |
| already-finished sessions            | not helped                                                                                           | not helped (§4.3)                                                                                                                             |
| format change                        | none                                                                                                 | new event kind: `log-core` + `analysis-core` + `shared` + `analyzer` + `server` + 3 recorders + vectors + `/architecture`                     |
| new abuse surface                    | none                                                                                                 | contested/denied attribution via shared-repo append — closed by §6.2/§6.4, at the cost of putting attribution behind seal-coverage resolution |
| property lost                        | none                                                                                                 | **pre-commitment** (§8.3)                                                                                                                     |
| student-visible cost                 | a session boundary: an extra `session.end`/`session.start` pair, `t` resets, a `prev_session_id` hop | none                                                                                                                                          |

**The delta is exactly one cell: work recorded before the import, within the one live session.**
Everything else the two options do identically or not at all.

**And the reported incident does not sit in that cell.** "Every session came back `unattributed`"
means nobody imported anything, at any point. There was no credential to countersign with — late or
otherwise — so the format change would not have saved that submission either. What would have saved
it is the recorder _telling the students they were recording unattributed_. That is the **notify**
half of the cheap alternative, and it is the half that is actually load-bearing for the failure that
prompted this.

### 8.3 The property that is lost, stated honestly (part of Q4)

At session start, adopting a session key is a **blind commitment**: the vouching student cannot know
what the session will contain. A late block makes adoption **informed** — they can look first.

How much this matters:

- **Who can produce a late block** is unchanged: the holder of a student private key (derived from a
  master secret that never leaves the machine) plus a matching institution-signed credential.
  Identical to who can produce a start block. No new key, no new signer, no relaxed check.
- **The different-person case** the brief asks about splits cleanly. If the other person
  **cooperates** (hands over the master secret, or signs the binding), they have consented to being
  named as the author — contract cheating, and the system's answer is unchanged, because identity has
  only ever proved _who claims a session_, never _who typed_. The same pair could achieve the same
  outcome today by having the credentialled student start the session and the other type into it. If
  the other person **does not cooperate**, the attacker needs their master secret — and with it they
  could forge a start block, or a whole session, so late binding adds nothing.
- So: **no new capability**, but the loss of pre-commitment is real and must not be waved away. The
  mitigation is §6.5 — the binding point is recorded and displayed, so "adopted at event 8,412 of
  8,930" is visible to a reader rather than laundered into looking like a start-time block.

Existing properties audited one by one, all unaffected: hash chain (an ordinary chained entry);
seal and `log_bytes_match` (untouched, and §6.2 _uses_ them); `session.start` immutability
(nothing amends it — this is an append, which is why the proposal is shaped this way); windows
(unchanged, §5.4).

### 8.4 Recommendation: **ship the alternative; defer the format change**

Not because the argument fails — §2 says it holds, and the design above is implementable as written.
Because of what it costs against what it buys.

**Do now, in all three recorders:**

1. **Notify.** Every recorder already computes and retains `IdentityOutcome.skipped` per session and
   shows nothing about it beyond a status-bar nudge. Make an unattributed session **visible while it
   is happening** — this is what the reported incident actually demanded, it costs no format change,
   and neither option in §8.2 substitutes for it.
2. **Restart on import.** JetBrains already has the primitives (`stop(root)` then
   `startFromActivation`; note `startFromActivation` is idempotent-guarded on an active root, so a
   naive re-call is a no-op and the stop is required). Port to VS Code and Neovim.
3. **Prompt at the right moment.** A student prompted to enrol _before_ they start working loses
   nothing at all. With (1) and (2) shipped, the mid-session-import population shrinks toward zero
   over a semester rather than being a standing condition.

**Defer the format change, with an explicit re-open condition.** Revisit if, after (1)–(3) have run
for one full assignment cycle, the measured residual is material: _how many sessions still contain
work recorded before an in-session import, and how much of it_. That number is directly measurable
from ingested bundles — a session whose `credentialWindow` is `before_valid_from` had its credential
minted after it started (§5.4 reason 3), and the count of pre-restart events is right there. If it is
a long tail of small sessions, the alternative has already solved the problem. If it is a meaningful
volume of real work, execute §3–§7 unchanged.

**Why defer rather than reject.** The design is sound, additive, and safe in both compatibility
directions; deferring costs only the time to re-open it. **Why defer rather than do.** The change
touches six packages and three repos under rules that make each hop expensive — readers-before-writers
sequencing, byte-exact vectors that are a breaking change to two other repos, an
`extension_hash` allowlist update per recorder release, a mandatory `/architecture` update — in
exchange for a benefit bounded by one session's pre-import prefix. And it introduces the first
"identity can arrive after seq 0" concept in the format, which every future reader has to hold, plus
the first attribution state that depends on seal coverage. That is a large permanent surface for a
bounded win, when the cheap option captures everything from the import forward and the notify half
addresses the incident that prompted this.

A well-argued "not yet" is the honest answer here.

---

## 9. Open risks

**R1 (largest) — the admissibility gate puts attribution behind seal-coverage resolution.** §6.2 is
necessary: without it, anyone with write access to a shared repo's `.provenance/` can contest or
destroy a partner's attribution. But seal coverage is the most defect-prone component in the
analyzer, with a documented history of high-severity false accusations — the
`LogFileId`/`LogicalSessionId` confusion that silently emptied prefix coverage and failed
`log_bytes_match` on every honest git submission, and the prefix-vs-whole-file family before it. A
gate that is too tight silently unattributes honest students; one that is too loose is a laundering
path, and attribution can _suppress_ findings (§6.6). **This risk exists only if the format change is
built** — it is the strongest single argument for §8.4.

**R2 — the feature's reach is smaller than it first appears.** §4.3 confines it to live sessions, so
it and the cheap alternative cover the same population. Anyone advocating the format change on the
strength of "students who enrol after finishing" is mistaken: that case is not addressed, and
addressing it would mean reopening final seals, which must not happen.

**R3 — loss of pre-commitment (§8.3).** No new capability, but a genuine property gone. Mitigated by
displaying the binding point, not eliminated.

**R4 — attribution changes ordering.** A session gaining attribution can turn a `prev_session_id` edge
into a refused `foreign_session_link`, changing `≺` and every `globalIdx`. Correct behaviour,
easy to miss, needs a pinned test.

**R5 — the notify gap is real today and neither option is a substitute for fixing it.** All three
recorders compute a per-session "no identity" outcome and surface it only as a status-bar nudge. Until
that changes, a student can record an entire assignment unattributed and find out at adjudication.
This is the finding with the best cost/benefit in the whole document and it needs no format change.
