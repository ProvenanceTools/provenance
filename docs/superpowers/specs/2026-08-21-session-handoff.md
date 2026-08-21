# Session handoff — 2026-08-21

**Point a new session at this file.** It supersedes `2026-08-20-session-handoff.md`, which is now
wrong in several places (noted below).

## Read in this order

1. **`2026-08-19-program-decision-log.md`** — the durable record. Now carries the 2026-08-21
   entries at the end: six further defects, each with its reasoning and mutation table.
2. `2026-08-18-multicourse-program-architecture.md` — umbrella spec, cross-repo contracts.
3. `2026-08-19-git-collaboration-semantics.md` — the 31-scenario shared-repo census.
4. **`docs/manual-test-guide.md`** — new. Every flow a human must exercise by hand.

**Where this file or the decision log disagrees with an older spec, they win.**

---

## State: everything is green

| suite         | count    |     |
| ------------- | -------- | --- |
| log-core      | **698**  | ✅  |
| analysis-core | **1205** | ✅  |
| recorder      | **710**  | ✅  |
| analyzer      | **1334** | ✅  |
| tools         | **188**  | ✅  |
| **server**    | **1575** | ✅  |

`build`, `typecheck`, `lint` all clean. **The migration-0029 gate is closed** — the full server
suite ran to 0 failures, and the chain (now through `0030`) was applied to a fresh Postgres 16.

### Corrections to the 2026-08-20 handoff

- It claimed **"build, typecheck, lint clean."** Lint was **red** and had been since before it was
  written — two `docs/superpowers/` files failed `prettier --check`. Worse, running the repo's own
  autofix on one **corrupted it**: an inline code span delimited by single backticks contained
  backticks, so the span closed early and prettier rewrote `heuristic_id` → `heuristic*id` and the
  regex `/_/g` → `/*/g`. Fixed at the source so the file round-trips.
- It listed the `cohort.test.ts` cross-flags pagination failure as a probable **ordering flake**.
  It was **real data loss** — see bug 14 in the decision log.
- It said `packages/shared` has "zero occurrences of contributor". The 0029 cut-over added 18. The
  real gap was `coverage`, now closed.
- It listed **one** §5.6 capability report as owed. All **three** were owed; all three now exist.

---

## What landed on 2026-08-21

Six defects, all reachable by honest behaviour, all found by a targeted audit rather than by the
suites — which were fully green over every one of them.

1. **`paste_shared_across_students` fired on every honest partner pair** at HIGH/0.95. A shared
   `.provenance/` is add-only, so each partner's paste events sit in the other's bundle. Fixed by
   S20 same-scope exclusion on a **proven shared observed commit** (never witnessed-only — that
   would fold every student who cloned the course skeleton into one lineage).
2. **`multiple_sessions_overlap` accused D5's two-machine flow** of log forging. Keyed now on
   `student_pubkey` (per machine), **not** `session_pubkey` (per session, ephemeral).
3. **A duplicated log** titled check 1 _"Manifest signature verification failed"_ and was replayed
   twice, fabricating file content.
4. **A fifth route to the prefix-vs-whole-file accusation**, at the OUTER gate
   `if (classicManifest === null)`.
5. **Git CRLF translation** — `core.autocrlf=true` is the Git-for-Windows default and no
   `.gitattributes` existed anywhere. Recorders now write one; the loader distinguishes a
   translation from an edit.
6. **A torn trailing line destroyed the whole submission.** Now truncated to the last complete
   entry and the session **kept** — dropping it was tried as a mutation and made 12 tests red,
   because check 8 scans sessions and would return the crash as _"code appeared that the log never
   recorded"_.

Plus: **keyset pagination silently dropped AND re-served rows** whenever rows shared a millisecond
(bug 14), fixed with microsecond cursors and row-value comparison; **migration 0030** adds the three
keyset indexes, which did not exist; the **three §5.6 capability reports**; **coverage facts on the
server read path**; a **`/architecture`** pass plus a top-up; and the **operator and student
documentation**, three items of which actively failed if followed.

### Tests that asserted a defect AS the requirement — four instances

This is the recurring failure mode on this branch and it is worth expecting:

- `tools/recorder-seal-conformance.test.ts` pinned `coverage === undefined` for a both-shapes
  bundle — the exact value the consumer reads as "classic whole-file".
- Every positive fixture in `run-cross.test.ts` seeded its second submission on a **different**
  assignment, so the suite passed only because the assignment filter was missing.
- **Five** e2e tests asserted the pre-0029 fan-out. The cut-over found one and missed four.
- **The cut-over's own repair was not load-bearing**: `every(status === 'matched' || 'duplicate')`
  is satisfied by three `matched` — the fan-out returning.

---

## Still owed

1. **Two product decisions**, both raised by agents, neither urgent:
   - **`'mixed'` repository scopes do not exclude.** One partner on a `root_commit_sha`-emitting
     build and one on an older one produce different node keys for the same commit, so that pair is
     still compared and still false-accused. Matching on the bare sha fixes it and re-opens the
     sha-space merge D12 exists to prevent.
   - **Non-deterministic group ownership.** The shared submission's `student_id` is whichever
     co-submitter won a `Promise.all` race; re-ingesting the same export can name the other. Any
     surface rendering it as "the student" names an arbitrary one of two.
2. **`verify-checkpoint-chain.ts`'s `seq_absent` fails at high severity on a crash** — the recorder
   can land a checkpoint while the entry's bytes are still buffered. Pre-existing, and _more_
   reachable without a torn tail than with one.
3. **`reconcileWitnesses` has no production caller.** The peer-witnessing reader ships ahead of any
   surface a grader can see.
4. **The cross-flag exclusion register is browser-side only.** The server-backed view gets the
   suppression but not the explanation; persisting it needs a column or table.
5. **`analysis:unzip` contradicts `chain:zip`** on the page: it still calls an unpaired `.slog` /
   `.meta` a hard failure, which bug 11 made a dropped artifact.
6. **`packages/shared` has no test script and zero test files.** It is the server↔analyzer contract
   and has never run under anything — the same class as the `tools/` gap (bug 8).
7. **`RECOMPUTE_MAX_PARALLEL` is dead** — declared and validated, read by nothing.
8. **The end-to-end rehearsal and the Windows/Linux runs.** See `docs/manual-test-guide.md`; these
   are operator-gated and cannot be done from here.
9. **Per-contributor heuristic SCOPING** (heuristics still run once over the whole scope). D14's
   under-attribution is deliberate and safe; re-running per contributor is a separate change.

---

## How to run this work

Unchanged from the 2026-08-20 handoff, and all of it still true. The additions worth carrying:

- **Agents must commit incrementally.** Two lost everything to a session limit; three others
  survived being killed because they had committed as they went.
- **Agents corrected the orchestrator three times** and were right each time: the overlap key
  (`session_pubkey` → `student_pubkey`), the group-submission shape, and one architecture item that
  was already correct. Brief them to push back, and check their pushback.
- **Grep the assertion, not the feature name.** Four fan-out tests were missed because the sweep
  searched for `gradescope` and they are spelled `local-path`, `resumable-upload`,
  `stage-upload-job`, `worker-hint`.
