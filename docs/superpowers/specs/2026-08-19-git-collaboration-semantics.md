# Git-collaboration semantics — scenario census, ordering model, reconciliation

**Repo:** `provenance` monorepo (branch `feat/manifest-2.0-trust-chain`)
**Date:** 2026-08-19
**Status:** Draft design, NOT approved. Contains open product decisions (§8) that must be answered before implementation.
**Parent spec:** [`2026-08-18-multicourse-program-architecture.md`](./2026-08-18-multicourse-program-architecture.md) — §6 (scope discovery), §7 (contributor model, deletion detection, peer witnessing), §8 (sub-projects S3/S4/S5).
**Scope:** the semantics of a CS 61B/61C submission: one git repo, one shared committed `.provenance/`, two or more contributors, each running their own recorder, no `.git` at ingest.

---

## 0. How to read this

This document is a **census before a design**. §3 enumerates every scenario I could construct or find, each in a fixed five-field shape:

- **Today** — what the code actually does, with `file:line` evidence. Verified by reading, not assumed.
- **Should** — the correct behaviour.
- **Evidence** — what signal exists (or must exist) to separate the innocent case from the guilty one.
- **Owner** — which module owns the decision.
- **If wrong** — the concrete failure.

§4 is the adversarial pass. §5 is the semantics: ordering, reconstruction, reconciliation, peer witnessing. §6 is the presentation contract for ambiguous evidence. §7 is the ranked worklist. §8 is the list of things I am _not_ deciding.

Two standing rules from `CLAUDE.md` and from this project's history govern every choice below, and where they conflict with elegance, elegance loses:

> **R1. Fail toward surfacing evidence.** A change that makes tampering produce _fewer_ findings has already happened once here and must not happen again. Anything a heuristic cannot evaluate soundly becomes a visible `not_applicable` with a reason, never a silent skip and never a zero.
>
> **R2. Never manufacture a tamper finding against an innocent student.** A `prev_hash` mismatch is indistinguishable from a deleted entry. A pull is indistinguishable from an external edit _with the signals we capture today_. Collateral accusation is the worst outcome this system can produce, and multi-contributor git is where it becomes systemic rather than incidental.

Where I am uncertain, I say so inline rather than writing confident prose over a guess.

---

## 1. Ground truth — what exists today

| Piece                                                         | State                                          | Evidence                                                                                                                                                                                                   |
| ------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rolling seal **types + validators**                           | Landed                                         | `packages/log-core/src/rolling-manifest.ts`                                                                                                                                                                |
| Rolling seal **read path** (loader, union synthesis, defects) | Landed                                         | `packages/analysis-core/src/loader/rolling-seal.ts`, `loader/parse-bundle.ts:133-215`, `loader/unzip.ts:115-117`                                                                                           |
| Rolling seal **verification** (check 1, per-session key)      | Landed                                         | `packages/analysis-core/src/validation/verify-manifest-sig.ts:120-165`                                                                                                                                     |
| Rolling seal **writer in the recorder**                       | **DOES NOT EXIST**                             | No importer of `rollingManifestFilenames` outside log-core/analysis-core. The only manifest the recorder writes is the classic seal, on explicit command: `packages/recorder/src/commands/seal.ts:293-310` |
| Commit graph capture (`sha`/`parents`/`branch`)               | Landed                                         | `packages/recorder/src/wiring/git-wiring.ts:252-257`                                                                                                                                                       |
| Any **consumer** of `git.event` in analysis                   | **NONE.** One timeline row.                    | `packages/analyzer/src/views/timeline/EventList.tsx:114` is the only reader; zero hits in `analysis-core/src` outside comments                                                                             |
| Contributor / group / partner concept in `analysis-core`      | **NONE**                                       | Confirmed by exhaustive grep; `collaboration` is displayed (`manifest/bundle-manifest.ts:526,641`) and never branched on                                                                                   |
| `student_ref` read anywhere in `analysis-core`                | **NONE**                                       | Identity plumbing exists only in recorder + server                                                                                                                                                         |
| Student→submission attribution                                | **Filename regex only**                        | `packages/server/src/services/ingest/match-student.ts` — the roster lookup keys off a `sid` captured from the uploaded filename                                                                            |
| `submissions.student_id`                                      | `NOT NULL`, single                             | `packages/server/src/db/schema.ts:443-445`                                                                                                                                                                 |
| `manifest.scope: 'directory' \| 'repo'`                       | Parsed, signed, **never read by the recorder** | `packages/log-core/src/manifest.ts:57,86,297`; zero hits in `packages/recorder/src`                                                                                                                        |

**The implicit model of the entire analysis engine is: one bundle = one machine = one person = one workspace = one linear history.** Every scenario below is a consequence of violating one of those five.

---

## 2. The four structural assumptions that break

Naming them once so the census can refer back.

**A1 — "wall clock orders everything."** `buildIndex` sorts every event in the bundle by `(wall, sessionId, seq)` (`packages/analysis-core/src/index/build-index.ts:222-228`). `loadBundle` sorts _sessions themselves_ by `firstEvent.wall` (`loader/parse-bundle.ts:169-171`). Both are cross-machine wall clocks in a shared repo. Everything downstream — `byFile` order, reconstruction order, "consecutive sessions", the union manifest's last-writer-wins merge — inherits an ordering that two machines' clocks can invert at will, with no malice required.

**A2 — "one linear stream reconstructs a file."** `reconstructFile` walks `index.byFile.get(path)` once, in that wall order, applying deltas (`index/reconstruct-file.ts:741-852`). Given two contributors editing one file on divergent branches, this interleaves their deltas and produces content that never existed on any machine.

**A3 — "anything the editor didn't write is suspicious."** `fs.external_change` is the highest-signal integrity event the system produces, and git is an external writer. The only escape hatch is `explanation: 'git'`, produced by a **single-slot, consume-once, 2000 ms** tagger (`packages/recorder/src/events/explanation-tags.ts:29-67`). A pull that rewrites twelve files tags exactly one.

**A4 — "the `.provenance/` directory belongs to me."** The recorder scans every `.slog` in the directory at startup, links `prev_session_id` to whichever has the latest `session.start.wall` regardless of author, and **renames any that fails to parse or validate** to `<file>.corrupt-<ISO>` (`packages/recorder/src/startup/chain-recovery.ts:154-234`, wired at `session/session-registry.ts:161-187`). In a shared repo this is one student's recorder silently destroying another student's evidence.

---

## 3. Scenario census

### A. Collaboration and merge

---

#### S1. A pull drops foreign `.slog` / `manifest-*.json` files into the tree

**Today.** Nothing happens, in either direction — and that is two separate facts.

_Mid-session:_ the recorder has no watcher on `.provenance/` at all. The directory is read exactly once, at startup (`session-registry.ts:161-182`). `fs-watcher.ts` creates one `FileSystemWatcher` per entry of `files_under_review` and nothing else (`packages/recorder/src/wiring/fs-watcher.ts:101-103`). `doc-wiring.ts` _actively suppresses_ every editor event for anything under `provenanceDir` (`isProvenanceArtifact`, `doc-wiring.ts:214-218`, applied at `:280,:457,:536,:545,:580`). A foreign `.slog` appearing mid-session is invisible.

_At next startup:_ it is worse than invisible. See S22.

**Should.** The recorder records a `peer.observed` event into its **own** signed chain (§5.5): filename, sha256 of the exact bytes, byte length, and — when the foreign file parses — the foreign chain's `seq_high` and final `hash`. This is the mechanism the parent spec §7 calls peer witnessing, and it is what makes S11 detectable.

**Evidence.** The bytes themselves. Hashing them requires no interpretation and reveals nothing the student cannot already read (the file is in their working tree). Recording the foreign chain's **tip hash** rather than only its length is what upgrades the witness from "it was about this big" to a verifiable commitment to an exact prefix.

**Owner.** Recorder (new `.provenance/`-directory watcher, off the hot path) + `log-core` (new event kind, tri-repo, parent spec §11 item 4) + `analysis-core` (reconciliation).

**If wrong.** Without it, deleting a partner's log leaves no trace at all, and the parent spec's §7 mechanism 2 does not exist. With it done carelessly — e.g. parsing foreign files on the doc.change path — the <1 ms p99 budget dies.

---

#### S2. A pull rewrites source files the student has open

**Today.** This is the single most damaging false-positive generator in the system, and it is live.

A pull writes N files. Each produces an `fs.external_change` through one of three paths (save-time compare `doc-wiring.ts:501-509`; the fs watcher `fs-watcher.ts:155-165`; the auto-reload discriminator `doc-wiring.ts:348-356`). All three call `explanationTagger?.consume()`.

The tagger holds **one** entry (`explanation-tags.ts:32`), overwritten by each `markGit()`, expiring after 2000 ms (`:36`), and **consumed once** (`:54-67`). `markGit()` is called synchronously on each git state change (`git-wiring.ts:221`). So:

- N files rewritten by one pull → **at most 1** gets `explanation: 'git'`.
- N−1 are unexplained → `external_edits` fires per file, medium, or **high** when `|diff_size| > 100` (`heuristics/external-edits.ts:171`, `config.ts:268`).
- Files whose watcher event lands >2 s after the git state change get nothing even if they are first.
- The tag is **session-global, not per path** — so a genuine hand edit landing within 2 s of a pull can be "explained" away. The escape hatch is simultaneously too narrow and too wide.
- `mass_external_replacement` (high, 0.75) fires on any small file the pull replaces by >80% (`mass-external-replacement.ts`, `sharedThreshold: 0.2`).
- `terminal_active_during_external_change` fires **once per external change** (`terminal-active-during-external-change.ts:119`) — and the student ran `git pull` _in the integrated terminal_, so a terminal is definitionally open. Its own docstring already concedes the flood (`:24-40`) and lists filtering on `explanation` as an unimplemented future mitigation (`:39-40`).
- `low_typing_high_output` (medium/high, `minRatio: 3`) sees the file grow with no typing.

**Should.** A pull must be attributable as a pull, per file, deterministically — not by a racy 2-second global slot.

The right primitive is **content, not timing**: an `fs.external_change` whose post-change content is _exactly a state some contributor's session in this scope demonstrably produced_ is a git-delivered state, not an external edit. That test is:

1. Compute the observed commit DAG (§5.2). If a `git.event` in this session, at a seq within the same _chain-adjacent_ window as the external change, moved HEAD, the change is git-adjacent — a necessary but not sufficient condition.
2. The sufficient condition is content: the external change's `new_hash` (or `new_content` sha256) matches a hash that another contributor's session in this scope recorded as a `doc.save.sha256` or `doc.open.sha256` for the same path. That match is a _cryptographic_ statement that the bytes came from a partner's recorded work, and it needs no clock.
3. Where (2) matches, the event is classified `git_merge_in` with the source session named, and `external_edits` / `mass_external_replacement` / `terminal_active_during_external_change` all skip it — **while it stays visible in the timeline as a reclassified event**, exactly as `selfInflictedExternalChanges` does today (`index/event-index.ts:80-90`).
4. Where (1) holds but (2) does not — the content came from a commit no surviving session recorded — the event is classified `git_unrecorded_in`. This is **not** suppressed. It is a distinct, lower-severity finding meaning "content entered the working tree from a commit no recorder observed", which is exactly the true statement.

Note what (2) buys beyond suppression: it is the _only_ mechanism in the design that can distinguish a pull of the partner's real work from a pull of a commit somebody made outside any recording. That distinction is the whole game.

Interim mitigation, if the DAG work is not ready: widen the tagger from a single slot to a **per-path set with a bounded budget** (e.g. every path whose watcher event arrives within the window of a `git.event` is tagged, up to a cap, with the tag _not_ consumed by the first taker). This is strictly better than today and does not need a format change. It is still timing-based and still wrong under load — it is a bridge, not the answer.

**Evidence.** `git.event` position in the signed chain; `fs.external_change.new_hash`; every other session's `doc.save.sha256` / `doc.open.sha256`. All inside signed chains. None requires a clock.

**Owner.** `analysis-core` owns the classification (a new pass alongside `findEditDerivedExternalChanges` in `index/build-index.ts:285-296`). Recorder owns the interim tagger widening.

**If wrong.** Every 61B student who pulls gets a page of medium/high flags. Graders learn that external-change flags mean nothing, and the flag class dies — taking the real Claude-Code-in-a-terminal detections with it. That is the failure mode `internal-move.ts:5-9` was written to prevent for pastes, arriving from a different direction.

---

#### S3. Merge conflict in a source file, hand-resolved

**Today.** The student deletes conflict markers, removes one side's block, and pastes the resolved version. That produces:

- One or more large deletions and a large insertion → `large_paste` (medium at ≥200 chars / ≥10 lines, **high** at ≥500 / ≥30 — `config.ts:260-265`).
- If the resolved block resembles the file's final state, `paste_is_solution` at **high / 0.85** (`lineOverlap: 0.8`, `paste-is-solution.ts:131-132`) — the most damning flag in the catalogue.
- `internal_move` **cannot** rescue either. It requires the matched source region to be ≥90% `typed` or `preexisting` provenance (`internal-move.ts:52`, gate at `:322,:349`). The partner's hunk arrived via `fs.external_change` or a `doc.open` seed, whose provenance is `external_change` / `preexisting`… and `preexisting` only applies to the _seed_, not to content that arrived mid-stream. In the common case the classification is `external`, and the docstring says explicitly that unclassified means full-severity external paste (`:15-18`).

**Should.** Extend `internal_move`'s notion of "own work" to **"work of any verified contributor on this scope"**, producing a distinct classification `partner_move` rather than reusing `internal_move`. The severity treatment is the same (downgrade to `info`), but the label must differ, because the _claim_ differs: "the student reorganised their own code" and "the student pasted their partner's code during a merge" are different sentences, and a grader is entitled to the second one.

The provenance gate stays fail-closed: a match against content whose provenance is `external_change` **and** which cannot be traced to a contributor's own typed segment is still `unknown`, i.e. still full severity. That preserves the laundering defence in `internal-move.ts:10-13` — a student cannot paste an external solution into a scratch file and then "merge" it into existence, because the scratch file's content has no contributor-typed origin either.

**Evidence.** Per-character provenance already exists (`index/reconstruct-file-provenance.ts:68`, `ProvenanceKind`). It needs one more axis: _which contributor_ wrote each character (§5.3). Conflict markers themselves (`<<<<<<<`) are a weak corroborating signal that appears in `new_content` and can be surfaced as context — never as the basis of a verdict, since they are trivially absent when a student uses a merge tool.

**Owner.** `analysis-core/heuristics/internal-move.ts` + the provenance model in `index/reconstruct-file-provenance.ts`.

**If wrong.** Merge-conflict resolution — a thing 61B explicitly teaches — reads as pasting the solution. This is the single most defamatory misfire in the census.

---

#### S4. Merge conflict _inside_ `.provenance/`

Per-session filenames are supposed to make this impossible. They make it **rare**, not impossible. Here is the proof and the four counterexamples.

**The property that does hold.** Each recorder writes only files named after its own session: `session-<random-uuid>.slog` / `.slog.meta` (the filename UUID is a _fresh_ `randomUUID()`, distinct from `session_id` — `session-registry.ts:252`, deliberate per `chain-recovery.ts:16-19`) and, once implemented, `manifest-<session_id>.json` / `.sig`. Two recorders therefore never write the same path, so a merge of two branches that each added files is a union of disjoint paths. Git resolves that with no conflict.

**Counterexample 1 — the same session, committed on two branches.** A `.slog` is append-only, so the file's content at time T2 has the content at T1 as a strict prefix. If the student commits their live `.slog` on branch A at 100 lines, switches to branch B (the recorder is still running, same session — see S8), and commits at 150 lines, a later merge of A and B presents git with: base = 50 lines, ours = 150, theirs = 100. Both sides added lines at the same position with different content. Git's line-level 3-way merge does not know that one addition is a prefix of the other; it reports a **conflict**. This is the realistic path to a conflicted `.slog`, and it is reachable without any hand-copying.

**Counterexample 2 — a restored backup or a hand copy.** A student who copies `.provenance/` from a backup, or who copies a file to "keep it safe", can produce two files with the same session content at different paths, or one path with two histories. The `session_id` inside is identical, so `parse-session.ts:117` yields the same `sessionId` for two `.slog` entries; the loader's `sessionFiles` pairing is keyed by the **filename** uuid (`loader/unzip.ts:43`), so two entries survive to `parsedSessions` with the same `sessionId`. The rolling-seal reconciliation then sees the id present (`rolling-seal.ts:186-188`) and nothing complains. **This is a gap today, and it silently corrupts the index:** `buildIndex` merges both sessions' events under one `bySessionId` key, and `bySeq` is keyed on `sessionId:seq` (`index/build-index.ts:256`), so the second copy's entry **overwrites** the first at every colliding seq. `supportingSeqs` on any flag then resolves to whichever copy happened to sort last. Duplicate `sessionId` across two `.slog` files must become a loader defect.

**Counterexample 3 — `git checkout --theirs` / `--ours` on a conflicted `.provenance/` path.** This takes one side wholesale, silently discarding the other's appended entries. The surviving chain is internally valid (it is a genuine prefix), so `verify-chain.ts` passes — the loss is invisible to check 3. It is detectable only against an external commitment to the tip: peer witnessing (§5.5) or the session's own rolling seal from a later checkpoint, both of which name a `seq_high` the surviving file does not reach.

**Counterexample 4 — a recorder running while a merge is in progress.** The recorder holds an **open append file handle** (`fsPromises.open(slogPath, 'a')`, `packages/recorder/src/io/session-writer.ts:98`) with a 1 s / 256 KB buffer. Git resolving a conflict on that path rewrites it. If git replaces the inode (write-temp-then-rename, which git does), the recorder's handle now points at an orphaned inode: **every subsequent event is written to a file that no longer has a name and will never be committed.** Silent, total, ongoing data loss for the rest of the session. If git rewrites in place instead, the buffered appends land after whatever git wrote, producing a chain break authored by git.

**Today.** None of the four is detected, and counterexample 4 is not even survivable.

**Should.**

- The recorder must detect that its own `.slog` has been replaced underneath it and start a new session rather than write into the void. Cheapest sound check: at each checkpoint (every 100 entries, `session-registry.ts:303`), `stat` the path and compare `(dev, ino)` — or on Windows, size-monotonicity — against what was recorded at open. Divergence → flush what can be flushed, emit `recorder.degraded` with a specific reason, close, and start a fresh session whose `prev_session_id` points at the interrupted one. This is off the hot path by construction.
- Duplicate `sessionId` across two `.slog` entries becomes a loader defect (`duplicate_session`), surfaced through check 1's defect channel exactly as rolling-seal defects are (`verify-manifest-sig.ts:222`).
- A `.slog` that fails to parse is a **finding**, never a rename (S22).

**Evidence.** Inode/size identity for counterexample 4; duplicate `session_id` for 2; the rolling seal's own `seq_high` claim and peer witnesses for 3; for 1, the conflicted file will fail `parseEntries` or `validateChain` and must be reported as `chain_broken` **with the merge context stated** — which the analyzer can only do if it knows the scope is a git submission (`manifest.submission === 'git'`, signed).

**Owner.** Recorder (`io/session-writer.ts`, `session/session-registry.ts`); `analysis-core/loader` (duplicate detection); `analyzer` (framing).

**If wrong.** Counterexample 4 loses an entire session's evidence with no signal. Counterexample 1 produces a `chain_broken` **high** flag caused by git, not by the student — R2 violation.

---

#### S5. Two partners on separate branches, overlapping in wall time, both editing one file

**Today.** Catastrophic on three axes simultaneously.

1. **`multiple_sessions_overlap` fires at high / 0.95** for every overlapping pair (`multiple-sessions-overlap.ts:167-168`). It has no thresholds and ignores its config (`:100`). Its description — carried into the flag text — is _"impossible on a single machine without clock manipulation or log forging."_ Its docstring explicitly forbids the only existing discriminator: _"Do NOT reintroduce a 'same machine_id → suppress' guard"_ (`:34-40`), correctly, because `machine_id = sha256(hostname:username:session_id)` is session-salted and can never match. So there is no discriminator at all, and the flag asserts forgery about two people working at the same time.
2. **Reconstruction interleaves them.** `byFile` is wall-ordered (A1/A2), so Alice's delta at 14:02:01 and Bob's at 14:02:02 apply to the same buffer in that order, even though they were made against different branch tips. The resulting content never existed anywhere.
3. **`inter_session_external_change` fires on every consecutive pair.** It walks sessions in the loader's wall order, takes the last event of session A and the first content-bearing `doc.open` of session B, and flags any difference (`inter-session-external-change.ts:90-134`). Across contributors that difference is _guaranteed_: session B is on a different machine with a different working tree. High (>100 chars) or medium, confidence 0.85, with **no** `explanation` check, **no** `selfInflicted` check, and no git awareness whatsoever. It is the most structurally mismatched heuristic in the codebase for shared repos.

**Should.**

- `multiple_sessions_overlap` must key on **contributor**, not on the bundle. Overlap between two sessions of the _same_ verified contributor keeps its current meaning and severity. Overlap between two _different_ verified contributors is the normal case for a `collaboration: 'group'` scope and produces no flag — but it produces a visible _fact_ in the coverage panel ("Alice and Bob recorded concurrently for 3 h 12 m"), so the information is not lost. Overlap involving an **unattributed** session (no verified identity) keeps the flag, because the premise — two people — is exactly what is unproven.
  Note this changes solo behaviour too, and that is the point: today a solo student with two verified sessions of themselves gets the flag; under the new rule they still do.
- `inter_session_external_change` must compare **within a contributor's own session chain**, not across the wall-sorted bundle. "The file changed while _my_ recorder was off" is the claim it can support. "The file differs from what my partner last saw" is not misconduct and must not be reported as if it were. Where the divergence _is_ within one contributor's chain, the git-delivery test from S2 applies before flagging.
- Reconstruction must not interleave. See §5.3.

**Evidence.** `session.start.identity.enrollment.student_ref`, verified offline through the manifest's root-anchored `course_cert` (parent spec §5a). The commit DAG for branch structure. Signed `manifest.collaboration === 'group'` as the gate that says a group is expected.

**Owner.** `analysis-core/heuristics/multiple-sessions-overlap.ts`, `heuristics/inter-session-external-change.ts`, `index/build-index.ts`, and a new contributor-resolution module.

**If wrong.** Every pair in the class gets a high-severity forgery accusation for doing the assignment as assigned. This alone would make the system unusable in 61B.

---

#### S6. Two partners work on genuinely separate files, never conflicting

**Today.** The best case, and it is _still_ wrong:

- `multiple_sessions_overlap` fires whenever the sessions overlap in wall time — file disjointness is irrelevant to it (S5).
- **Every heuristic keyed on `byFile` mixes contributors, because `byFile` is scope-wide and wall-ordered.** `low_typing_high_output` is the clearest case: it iterates `bundleStats.perFile` and `index.byFile` (`low-typing-high-output.ts:102,120`), so if Alice types 5 000 chars in `Shared.java` and Bob pastes 5 000 into the same file, the ratio is computed over both people's work and attributed to the submission as a whole. Neither the numerator nor the denominator belongs to one person.
- `idle_then_complete` detects gaps per session (`heartbeatsBySession`, `:168`) but measures file completeness through `index.byFile` (`:96`), so Alice's idle gap is scored against a file state Bob advanced.
- The per-session heuristics are, to be precise, **not** mixed: `no_intermediate_errors` iterates `index.bySessionId` (`no-intermediate-errors.ts:60`) and `time_to_first_save_anomaly` requires the `doc.open` and the `doc.save` to be in the same session (`time-to-first-save-anomaly.ts:95-98`). They are already contributor-clean by accident of being session-scoped. What they still lack is the ability to _say_ which contributor a flag belongs to — the flag has no `contributor_id` field (`heuristics/types.ts:34-43`), so a grader sees a finding against the submission with no way to attach it to a person.

**Should.** Per-contributor heuristic scoping (§5.4 step 8). A flag carries `contributor_id`; a heuristic that reasons about a person runs over that person's sessions only.

**Evidence.** As S5.

**Owner.** `analysis-core/heuristics/run-heuristics.ts` (the orchestrator gains a contributor loop); `packages/server` (`flags.contributor_id`, parent spec §7).

**If wrong.** Not defamatory, but it dilutes every signal in both directions and makes per-person grading impossible. In the "cleanest" scenario in the census, the system still cannot say who did what — which is the entire product requirement.

---

#### S7. Force-push, rebase, squash, amend

**Today.**

- **Nothing observes a push or fetch.** The recorder consumes only `repositories`, `onDidOpenRepository`, `state.HEAD.{commit,name}`, `state.onDidChange`, and `getCommit` (`git-wiring.ts:78-106`). Remote operations that do not move local HEAD are invisible.
- Rebase/amend/squash each move HEAD and therefore fire `git.event`, but `operation` is the literal constant `'state_change'` for **every** git event (`git-wiring.ts:253`). There is no commit/checkout/merge/rebase discrimination anywhere.
- `git.event` is emitted on _every_ repository state change, not only HEAD changes: `lastCommit` is tracked but the comparison is explicitly discarded (`void prev; // kept for future use`, `git-wiring.ts:223`). Staging a file fires one. The module comment at `:179-180` ("emit only on actual changes") is stale.
- **Nothing downstream reads any of it.** Zero consumers in `analysis-core`.

So today a rewrite is completely undetected, and the captured shas that would prove it are inert.

**Should.** This is where the design is _stronger_ than shipping `.git`, and the parent spec's argument (`events.ts:266-275`) needs to be cashed in.

Build the **observed commit DAG** (§5.2) from every `git.event.sha`/`parents` in every session in the scope. Then:

- A sha observed as HEAD in some session that is **not reachable** from any later-observed HEAD is an **orphaned observation**. That is the signature of amend / rebase / squash / a discarded branch. It is a _fact about the repository_, reported as `history_rewritten` at **informational** severity by default. 61B teaches rebase; rewriting is not misconduct. (Whether a course wants it escalated is a policy question — §8.8.)
- A commit that appears **only as a parent**, never as an observed HEAD, is a **witnessed-but-unobserved commit**: something existed at that point in history and no session recorded working at it. Counting these per scope is the honest answer to "how much of this history has no recording behind it", and it does not name anyone.
- Because `parents` order is meaningful and must never be sorted (`events.ts:305-312`), first-parent lineage is recoverable, so "which branch was merged into" is answerable.
- The absent-vs-empty rule (`events.ts:309-312`) must be honoured in the DAG builder: an absent `parents` yields a node with _unknown_ in-edges, which is **not** a root. Collapsing the two would report every read failure as a repository root.

**Evidence.** Every `git.event` is inside a signed hash chain at the instant it was observed. A student who rebases after the fact cannot retroactively remove an observation that another contributor's chain also recorded. This is the property `.git` does not have.

**Owner.** New module in `analysis-core` (proposed `analysis-core/src/git/observed-dag.ts`), plus `git-wiring.ts` if operation discrimination is added (see below).

**Should the recorder classify operations?** I am **uncertain** and lean no. Classifying `'merge'` vs `'rebase'` from the VS Code git API requires reading `RepositoryState.mergeChanges` / `.rebaseCommit`, which are available but unread. That is more surface, more per-recorder divergence across three hand-written ports, and the DAG already recovers merge structure from `parents.length >= 2` without trusting a label. The one thing structure cannot recover is _rebase in progress_, and I do not think that is worth a tri-repo change. Listing it as a non-goal rather than an omission.

**If wrong.** Squashing away a suspicious burst of commits succeeds silently, and the strongest argument for capturing the graph at record time goes unrealised. Conversely, over-reporting rewrites as suspicious punishes students for using git correctly.

---

#### S8. `git checkout` / branch switch while the recorder is running

**Today.** Three failures stack.

1. **Source files change under the recorder.** Every watched file the checkout rewrites produces `fs.external_change` — with the same consume-once explanation problem as S2. `markGit()` is called synchronously before the async parent read _specifically_ so checkout writes are covered (`git-wiring.ts:60-66,221`), which is correct reasoning defeated by the single-slot tagger.
2. **`.provenance/` changes under the recorder.** A checkout to a branch that does not contain the current session's `.slog` **deletes it** from the working tree. The recorder's open handle survives on a now-unlinked inode; the buffer keeps flushing into nothing. Switching back re-creates the file from the branch's committed version, which is behind. Nothing detects any of this (S4 counterexample 4).
3. **The expected-content model goes stale wholesale.** `ExpectedContent` is reset per file on each detected external change (`fs-watcher.ts` after emit; `doc-wiring.ts:511`), so it recovers — but only for files that produced a detected change. Files not in `files_under_review` are never modelled at all.

**Should.** Recorder-side: the inode/identity check at checkpoint from S4. Analysis-side: a `git.event` whose `branch` differs from the previous observation is a **branch transition**, and every `fs.external_change` in the chain-adjacent window is evaluated by the S2 content test rather than by timing.

**Evidence.** `git.event.branch` (absent when HEAD is detached, never invented — `git-wiring.ts:200-202`), `sha`, and the content match.

**Owner.** Recorder + `analysis-core`.

**If wrong.** Silent loss of a session's tail (worse than a false positive: it is _missing_ evidence, an R1 violation), plus a flag storm.

---

#### S9. Fresh clone on a new machine mid-project

**Today.** Actively harmful, because of A4.

`recoverPreviousSession` lists **every** `.slog` in `.provenance/`, picks the one with the latest `session.start.wall` (`chain-recovery.ts:114-136`), and:

- if it validates and is **dangling** (no trailing `session.end`), sets `prev_session_id` to that session's id — **with no ownership check of any kind**: no `student_ref`, no `session_pubkey`, no comparison of anything. On a fresh clone of a shared repo, the latest dangling session is very often the **partner's** (a partner whose editor is open right now has no `session.end`). The new session then claims continuity with a stranger.
- if it validates and ended cleanly, `prev_session_id` is `null` — so the genuine "I continued on a new machine" link is _never_ recorded, which is the one case this scenario is about.
- if it fails to parse or validate, it is **renamed** (S22).

`prev_session_id` is derived purely from the directory scan; there is no `globalState`, no `workspaceState`, no local state file anywhere in the recorder.

**Should.**

- **Ownership gate on the link.** `prev_session_id` may point only at a session whose `identity.enrollment.student_ref` equals this session's. Absent identity on either side → no link, and record _why_ (a `prev_session_id_unavailable` reason in `session.start` or a `recorder.degraded`, so the absence is explained rather than ambiguous).
- **Link on clean end too, when the contributor matches.** The parent spec §7 mechanism 1 (session continuity) is only a deletion detector if the chain is complete. Today it links only on crash, which means removing any cleanly-ended session is undetectable by that mechanism. That is a real hole and it predates this program.
- **Add a per-contributor session ordinal**, monotonically increasing, countersigned by the student per-course key alongside `session_pubkey` (parent spec §5a step 5 already establishes that countersignature). Then removing session _k_ is detectable from the gap between _k−1_ and _k+1_ even if the back-pointer chain is also cut, and it works on a fresh clone where the recorder has no local memory. **Uncertainty:** the ordinal must come from somewhere, and on a fresh clone the only source is the committed `.provenance/` — which the student controls. So the ordinal is a _lower bound_ claim ("I had at least k−1 prior sessions"), not a counter. That is still useful (it cannot be lowered without producing a visible regression across contributors' witnesses) but it is weaker than a true counter, and I flag it as such rather than overselling it.

**Evidence.** `student_ref`, the signed session ordinal, peer witnesses from the partner's chain.

**Owner.** Recorder (`startup/chain-recovery.ts`, `session/session-registry.ts`), `log-core` (`session.start` field — tri-repo).

**If wrong.** The contributor chain is fictional, so the parent spec's mechanism 1 detects nothing and _worse_ asserts a false relationship between two students' sessions.

---

#### S10. Pair programming on one laptop, one identity

**Today.** The log says one person did everything. There is no signal that would say otherwise, and none can be manufactured.

**Should.** State the limit explicitly in the product, not just in a spec. The parent spec §12 already says no identity scheme survives working on a partner's machine; the analyzer must say the same thing _at the point of use_, because a grader reading a per-contributor attribution panel will otherwise read absence of Bob as evidence about Bob.

What can be claimed: "these events were produced by a recorder holding Alice's course key". What cannot: "Alice typed them". The UI wording must carry that distinction. Concretely: attribution labels read **"recorded under Alice's key"**, never "written by Alice".

What _is_ weak corroboration and should be shown as such, never as a flag: a session recorded under one contributor's key at a time the DAG shows the other contributor's machine was also active; a single contributor's key covering 100 % of a `collaboration: 'group'` scope. Both belong in the coverage panel as facts.

**Evidence.** None that separates the cases. Say so.

**Owner.** `analyzer` (wording + coverage panel), and this document.

**If wrong.** A grader concludes from a one-sided attribution panel that one partner did nothing. That is a defamation risk with no evidentiary basis whatsoever, and it is the most likely way this feature hurts someone.

---

#### S11. A student `rm`s the partner's `.slog` and commits it

**Today.** Undetectable. Neither of the parent spec §7 mechanisms works:

- **Mechanism 1 (session continuity)** chains a contributor's _own_ sessions. It says nothing about a partner's chain. And as S9 shows, it currently links only on crash and links across contributors without an ownership check, so it is unreliable even for its own job.
- **Mechanism 2 (peer witnessing)** does not exist in any form. Confirmed absent from `packages/recorder/src` and `packages/log-core/src`.

There is also a third, weaker consequence: deleting the partner's `.slog` while leaving their `manifest-<id>.json` produces a `no_session_log` rolling-seal defect (`loader/rolling-seal.ts:190-199`) → check 1 fails → `manifest_sig_invalid` at **high / 1.0**. So the crude version of this attack _is_ caught — but the flag names the wrong thing (a manifest signature problem) and the careful version, deleting both halves, is silent.

**Should.** All three of the following, because each catches what the others cannot:

| Mechanism                                                                | Catches                                                                                                                                          | Cannot catch                                                                                                                  |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Session continuity (`prev_session_id` + signed ordinal, ownership-gated) | Removal of a _middle_ session of a contributor's own chain; with the ordinal, also removal of the last                                           | Anything about a partner's chain; removal of a contributor's _entire_ chain                                                   |
| Peer witnessing (`peer.observed`, §5.5)                                  | Removal of a partner's log that your recorder saw, including truncation (via the witnessed tip hash)                                             | A log deleted before your recorder ever ran; a partner who never overlapped you; a deletion where _both_ chains are destroyed |
| Commit-DAG coverage (§5.2)                                               | Work that happened at commits no surviving log covers — regardless of who deleted what, and it survives if _either_ contributor's chain survives | Who deleted it. It is deliberately non-attributive                                                                            |

The third mechanism is the one that matters for R2: it produces a scope-level statement ("14 of 31 observed commits have no recording behind them") that is true, verifiable, and accuses nobody. The first two produce named findings and must therefore be held to a higher evidentiary bar.

Destroying _both_ chains yields a submission with no provenance at all, which is the loudest possible signal — as the parent spec §7 already observes. That remains the backstop.

**Evidence.** As above. Note the witnessed **tip hash** is what makes truncation (not just deletion) detectable; `seq_high` alone would not.

**Owner.** `log-core` (event kind, tri-repo), recorder, `analysis-core` (reconciliation), `analyzer` (presentation).

**If wrong.** Deleting your partner's evidence is a free action. Given that the same repo is the shared artifact, this is the most obvious attack in the whole model.

---

#### S12. `.provenance/` in `.gitignore`, or never committed

**Today.** The recorder has **no `.gitignore` awareness at all** (zero hits in `packages/recorder/src`), ships no `.gitignore` template, and never checks whether `.provenance/` is tracked. The submission simply arrives with no `.provenance/`, and ingest reports `missing_manifest` (`loader/unzip.ts:150-159`) → the bundle does not load at all.

**Should.** Two changes, and the ordering matters.

1. **The recorder must warn, loudly and in the editor**, when its `.provenance/` directory is ignored or untracked in a `submission: 'git'` scope. This is discoverable without shelling out and without network: the VS Code git extension's `RepositoryState` exposes working-tree and index status. **Uncertainty:** I have not verified that the API exposes _ignored_ status for an arbitrary path without a `git check-ignore` call, and the recorder must not shell out on the hot path. If it cannot be read from the API, the fallback is a periodic (checkpoint-cadence, background) check that the `.provenance/` files appear in the repository's tracked set; failing that, an activation-time notification that says "commit `.provenance/`" unconditionally. A slightly noisy prompt is preferable to a silent non-submission.
2. **Ingest must distinguish "no provenance" from "no submission".** A repo with no `.provenance/` for a `submission: 'git'` assignment is currently indistinguishable from a corrupt upload. It should be its own outcome (`no_provenance_in_repo`) so a course can act on it as a process failure rather than as an integrity finding. It must **not** be silently scored as clean.

**Evidence.** Absence. Which is exactly why it must be reported as absence and not as anything else.

**Owner.** Recorder (warning), `packages/server/src/services/ingest` (outcome), course docs.

**If wrong.** The student did all the work, recorded all of it, and submits nothing. If ingest treats that as a clean submission, the incentive gradient points at deleting `.provenance/`.

---

#### S13. A `.slog` from a different assignment or course committed into this repo

**Today.** Partially caught, in a confusing way.

- **Rolling-sealed scope:** `synthesizeRollingUnionManifest` takes `assignment_id` / `semester` / `extension_hash` from the first seal in session order and reports every disagreeing seal as a `divergent_scope` defect (`loader/rolling-seal.ts:278-302`) → check 1 fails → `manifest_sig_invalid` high/1.0. Caught, but the _first_ seal is chosen by wall-clock session order (`parse-bundle.ts:169-171`, then `:196`), so which manifest is "the truth" and which is "divergent" is decided by an untrusted clock.
- **Classic-sealed scope:** all sessions must share `manifest_sig` (`verify-session-binding.ts:82-111`) → check 2 fails. Caught.
- **Course-level:** at Manifest 2.0, `course_id` is inside the course-signed payload and must equal `course_cert.course_id` (parent spec §3 step 3), so a cross-course staple is a signature failure. Caught.

**Should.** Keep the detection, fix the framing and the arbitrary anchor:

- The scope's identity must come from the **assignment's own `.provenance-manifest`**, which is what defines the scope, not from whichever seal sorted first. Under S3 scope discovery (parent spec §6) ingest already knows the declared `assignment_id` it is accepting; the union should be anchored to that, and _every_ seal that disagrees — including the first — reported.
- The finding should be `foreign_session_in_scope`, naming the session and the assignment it claims, rather than a generic manifest-signature failure. A grader reading "manifest signature invalid" will conclude tampering; the truth is "there is a log here from a different assignment", which may well be an accident (a student who copied a whole folder).

**Evidence.** `assignment_id` / `semester` / `course_id` inside each seal's signed payload; the scope's own manifest.

**Owner.** `analysis-core/loader/rolling-seal.ts`, `validation/verify-manifest-sig.ts`, ingest scope discovery.

**If wrong.** Either a laundering path (an out-of-scope log silently accepted) or a mislabelled tamper accusation for an innocent copy.

---

#### S14. Submodules, nested repos, a `.provenance/` in a subdirectory

**Today.** Two distinct problems, one of them severe and currently live.

**(a) `git.event` is dropped entirely when the assignment root is below the git repo root.** `git-wiring.ts:213-215` gates emission on `isOwnedByThisRoot(repo.rootUri.fsPath)`, which is `resolveOwnerRoot(fsPath, allRoots) === root` (`extension.ts:338-342`, `:392`). `resolveOwnerRoot` returns the assignment root that **contains** the path (`session/session-router.ts:23-41`). A git repo rooted at `/repo` is _not_ inside an assignment root at `/repo/proj2`, so it resolves to `null`, and **every `git.event` for that session is discarded.**

This means: for a 61B-style repo whose `.provenance-manifest` is at the repo root, git capture works. For a 61A-style course folder containing several assignment subfolders under one repo, git capture is **silently off** — which is precisely the layout the nested-manifest-discovery work (`2026-07-20-nested-manifest-discovery-design.md`) exists to support. I consider this a bug, not a design choice; the ownership predicate is written for _files_ (nearest ancestor) and misapplied to a _repository root_, which is by definition an ancestor of the assignment, not a descendant.

Correct predicate for git: a repository owns this session if the repository root is an **ancestor of or equal to** the assignment root, and no _nearer_ repository root exists. With submodules that gives the innermost containing repository, which is the right answer.

**(b) Submodules and nested repos multiply the DAG.** `api.repositories` enumerates each repository separately, and a submodule is its own repository with its own HEAD lineage. With (a) fixed, a session under a submodule would emit `git.event`s from both the outer and inner repo, interleaved, with unrelated sha spaces. The DAG builder must therefore key nodes by **(repository root, sha)**, not by sha alone, and must record which repository each observation came from. That requires a new optional field on `GitEventPayload` — a stable repository discriminator.

**Constraint:** it must not be the repository path (a filesystem path is arguably an identifier and is certainly noisy) and must not be a remote URL (which embeds the org and often the student's username). The safe choice is the **root-commit sha** of that repository's observed lineage, or failing that a session-salted hash of the repo root path in the manner of `machine_id`. **This is a format decision I am not making — §8.6.**

Also: `onDidCloseRepository` is declared in the local API type (`git-wiring.ts:81`) and never subscribed, so a closed repository is never unwatched. Bounded (disposables clear at session dispose, `:290-299`), but it should be wired.

**Should.** Fix (a). Decide (b)'s discriminator. Scope discovery (parent spec §6) already handles many `.provenance/` directories in one tree; each is its own scope with its own contributors, and they must not be merged.

**Owner.** Recorder (`git-wiring.ts`, `session-router.ts`), `log-core` (payload field, tri-repo), `analysis-core` (DAG keying).

**If wrong.** (a) means the entire commit-graph programme is dark for an entire class of course layouts, with no error. (b) means merging two repositories' sha spaces, which produces a DAG with impossible edges and therefore a wrong `≺` relation — silently wrong ordering is worse than no ordering.

---

#### S15. Very large repos, shallow clones, `git gc`

**Today.** Mostly benign, with one real edge.

- The recorder never reads `.git` and never shells out, so packing, `gc`, and repacking are invisible to it — correctly.
- **Shallow clone is the real edge.** `getCommit(sha)` on a commit whose parents are not present in a shallow clone will either fail or return a truncated `parents`. The code handles failure correctly by **omitting** `parents` rather than emitting `[]` (`git-wiring.ts:229-245`), which preserves the absent-vs-empty distinction. But a shallow clone's _grafted_ boundary commit legitimately reports **no** parents, which is indistinguishable from a genuine root commit. The DAG builder would record a false root.
- Large repos: `files_under_review` is an exact-string list (`state/expected-content-registry.ts:13,18`), one `FileSystemWatcher` per entry (`fs-watcher.ts:101-103`). A repo-scoped assignment with hundreds of files means hundreds of watchers. And there is no way to _express_ a repo-scoped file set at all — see S27.

**Should.** Treat a node with zero parents as **`root_or_unknown`** unless corroborated: a commit is a genuine root only if no other observation in the scope names it as a parent, _and_ it is the earliest observation in its lineage. Otherwise mark the lineage as **truncated** and say so in the coverage panel. Never report "the history starts here" from a single unparented observation.

**Evidence.** Cross-session corroboration of parent edges.

**Owner.** `analysis-core` DAG builder.

**If wrong.** A shallow clone reads as a repository with no history, which understates coverage and could be read as evasion.

---

### B. Reconciliation and ordering — the core problem

---

#### S16. What is the trustworthy ordering primitive?

**Today.** Wall clock, everywhere, unqualified. `buildIndex` sorts by `(wall, sessionId, seq)` (`build-index.ts:222-228`); `loadBundle` sorts sessions by `firstEvent.wall` (`parse-bundle.ts:169-171`); `synthesizeRollingUnionManifest` merges `submission_files` last-writer-wins **in that wall-derived session order** (`rolling-seal.ts:304-310`), so **check 8's expected hash for a shared file is decided by whichever machine's clock ran later.** A ten-minute skew silently inverts which partner's recorded hash counts as current, and check 8 is `high / 1.0`.

There is no clock authority anywhere: `clock.skew` events record self-observed jumps within one machine, and `verify-monotonic-wall` is intra-session only (`verify-monotonic-wall.ts:16-68`).

**Should.** See §5.2 in full. In summary: the trustworthy primitives are (i) the intra-session hash chain, (ii) the contributor's session chain, and (iii) the observed commit DAG. Wall clock is a **display hint** and a **measurable disagreement signal**, never an authority across contributors.

Specifically, the union manifest's last-writer-wins merge must be re-anchored on `≺` (DAG-ordered), and where two seals are concurrent for the same path, check 8 must report **both** candidate hashes and match against either — a submitted file matching _any_ concurrent recorded state is a match, because all of them genuinely existed.

**If wrong.** Check 8 accuses a student of tampering because their partner's laptop clock was ahead. High severity, 1.0 confidence, on a clock.

---

#### S17. File reconstruction across contributors

**Today.** `reconstructFile` replays one linear stream in wall order (`index/reconstruct-file.ts:741-852`). With two contributors on divergent branches editing one file, deltas from both interleave against a single buffer and the output is content that existed nowhere. The machinery is not naive elsewhere — it already treats a content-bearing `doc.open` as ground truth that re-anchors and clears taint (`:763-769`) and an `fs.external_change` with `new_content` as a reseed (`:848-850`) — but it has no notion of two streams.

**Should.** The anchored-segment model in §5.3. Reconstruction becomes a graph, not a line; where two segments are concurrent under `≺`, the correct output is _both_, and the merge point is an anchor where a single content resumes. `reconstructFileAt` returns a discriminated result — `determinate` / `concurrent` / `unknown` — and callers that need one string must handle `concurrent` explicitly rather than being handed a fabrication.

**If wrong.** Every downstream consumer inherits fabricated content: `paste_is_solution` compares a paste against a file state that never existed; `mass_external_replacement` computes a line-overlap ratio against fiction; the Source tab shows a grader a file the student never had; check 8 compares a submitted sha against a reconstruction of nothing. Several of those are high-severity flags. This is the deepest correctness problem in the census.

---

#### S18. What does the analyzer show when the evidence is genuinely ambiguous?

**Today.** There is no vocabulary for it. `ReconstructResult` has `tainted` + `taintReasons` (`reconstruct-file.ts:69-101`) — a real precedent, and a good one — but flags are binary (fired / not fired) and validation checks are `pass` / `fail` / `skipped`. `skipped` is the closest thing to "unknown", and `run-validation.ts:39-43` maps any skip to overall `warn`, which is the right instinct.

**Should.** §6 in full. The short version: three states everywhere (`established` / `inferred` / `unknown`), a named contributor only on `established`, a per-scope coverage panel that reports low coverage as low coverage, and a replay that refuses to linearize concurrency rather than inventing a merge.

**If wrong.** The system manufactures claims it cannot support, which is the failure mode the whole project is built to avoid.

---

### C. Scenarios not in the brief

---

#### S19. The recorder quarantines — by renaming — a partner's `.slog`

**Today.** `recoverPreviousSession` reads the selected `.slog`, and on _any_ of: read failure, `parseEntries` failure, `validateChain` failure, missing `session.start`, or missing `session_id`, it calls `rename(slogPath, slogPath + '.corrupt-' + ISO)` (`chain-recovery.ts:186-234`). The selected file is whichever has the latest `session.start.wall` **across the whole directory** — very possibly the partner's.

In a committed `.provenance/`, that rename is a git delete + add. The student then commits it, entirely unaware, and the partner's log is gone from the tracked path.

The trigger conditions are not exotic: a `.slog` truncated by a conflict resolution (S4), a `.slog` written by a newer recorder with an entry shape this parser rejects, a partially-written file caught mid-checkout.

**Should.** **Quarantine only files this recorder can prove it owns.** Ownership proof, in order of preference: the file was written by this session (the recorder knows its own path); or its `session.start.identity.enrollment.student_ref` equals this recorder's. A foreign or unattributable `.slog` that fails to parse is recorded as a finding — `peer.observed` with `state: 'unparseable'` — and **left untouched**. The recorder must never rename, move, or modify a file it did not write.

This is a bug fix, not a feature, and it is exploitable today: see §4.

**Owner.** Recorder (`startup/chain-recovery.ts`, `session/session-registry.ts:161-187`).

**If wrong.** One student's recorder destroys another's evidence, and the git history shows the _first_ student doing it. That is an R2 violation with a paper trail pointing at the wrong person.

---

#### S20. Both partners submit the same repo to Gradescope

**Today.** Two mutually exclusive bad outcomes, decided by byte-identity.

- **Identical bytes:** `dedupFile` matches on `(semester_id, blob_sha256)` (`packages/server/src/services/ingest/dedup.ts`), so the second submission is marked `duplicate` and linked to the first. The second student ends up with **no submission of their own** — no flags, no score, nothing to grade.
- **Bytes differ by anything** (a repack, one extra commit, a different Gradescope archive timestamp): two submissions. Then `runCrossHeuristics` runs over all non-superseded submissions in the semester with **no partitioning by repo, group, or partner** (`packages/server/src/services/heuristics/run-cross.ts`), and:
  - `paste_shared_across_students` pools all pastes ≥100 chars across submissions and groups by sha256 or ≥0.9 fuzzy line overlap → **high / 0.95**, flag text _"appears in N different student bundles… may indicate content sharing"_. Two copies of the same repo share every paste. This fires maximally.
  - `editing_pattern_clone` computes Jaccard over 3-grams of the event-kind stream, threshold 0.3 → **medium / 0.7** on two identical event streams (Jaccard 1.0).

So partners either lose one submission entirely, or get accused of colluding with each other, with the second outcome being the more likely.

**Should.**

- **Same-scope exclusion for cross-flags, keyed on the observed commit DAG.** Two submissions whose observed DAGs share at least one commit sha are provably the same repository lineage. That key is signed, cheap, and self-defending: to fake being someone's partner you would have to have observed their commits, which means having their repo. Excluded pairs must be **visibly excluded** in `/compare` ("same repository lineage — cross-comparison not applicable"), never silently dropped (R1).
- Whether a group is one submission with N contributors or N submissions is a product decision — §8.1 — and it changes dedup, scoring, retention and the Gradescope mapping. I am not deciding it.

**Owner.** `analysis-core/heuristics/cross/`, `packages/server` ingest + schema.

**If wrong.** The system's flagship collusion detector fires on the two people the course _assigned_ to collaborate, at high severity, every time.

---

#### S21. Ingest strips the rolling seals

**Today.** `isProvenanceEntry` returns true only for `manifest.json`, `manifest.sig`, `*.slog`, `*.slog.meta` (`packages/server/src/services/ingest/strip-bundle.ts:41-48`). A rolling-sealed bundle's `manifest-<session_id>.json` / `.sig` are **not** provenance entries and are therefore **dropped** when the source files are stripped.

The stored blob then has `.slog` files and no manifest of any shape. Every read path that re-parses it via `loadSubmissionIndex` — events API, replay, Source tab, recompute, cross-flags — gets `missing_manifest` from `unzip.ts:150-159` and fails to load.

**Today's status:** latent, because the recorder does not yet write rolling seals. It becomes a total failure the moment S3 ships.

**Should.** Add the rolling-seal filenames to `isProvenanceEntry`, using `parseRollingManifestFilename` from `log-core` rather than a second regex, so there is one pattern in the codebase. Add a regression test that round-trips a rolling-sealed bundle through strip → store → `loadBundle`.

**Owner.** `packages/server/src/services/ingest/strip-bundle.ts`.

**If wrong.** Every git-submitted assignment is unreadable after ingest, discovered in production.

---

#### S22. `prev_session_id` cross-links contributors

Covered in S9 and S19; recorded separately because it is the concrete mechanism by which the parent spec's §7 mechanism 1 is _already_ broken in a shared repo, independent of anything new. `chain-recovery.ts` has no ownership check of any kind.

---

#### S23. A partner who never enrolled, or whose identity does not verify

**Today.** `buildSessionIdentity` returns `skipped` for every failure — not enrolled, no keyring, lapsed cert, token from another machine — and the session records with **no** `identity` block (`session-registry.ts:213-232`). Which is correct recorder behaviour: never block recording.

Analysis-side, `student_ref` is not read at all, so today there is no difference between an identified and an unidentified session.

**Should.** An unidentified session becomes a **singleton pseudo-contributor** keyed `unattributed:<session_id>`. It participates fully in reconstruction and in the DAG (its evidence is not discarded — R1), but:

- No finding may name a person on the strength of it.
- `multiple_sessions_overlap` **keeps firing** when one side is unattributed, because "two people" is exactly what is unproven (S5).
- The coverage panel reports how much of the scope is unattributed.

A session whose identity block is _present but fails to verify_ is a **separate and stronger** finding (`identity_unverifiable`), because that is an artifact that claims something it cannot back. It must never be quietly merged into the claimed contributor.

**Owner.** `analysis-core` contributor resolution.

**If wrong.** Either evidence is discarded (R1) or an unverifiable claim is treated as identity (R2). Both are available failures here.

---

#### S24. Mixed recorders — one partner on VS Code, one on JetBrains or Neovim

**Today.** The rolling-seal writer exists in **none** of the three. When it lands, it lands one at a time (parent spec §9: readers before writers, VS Code → provjet → provnvim). During that window a shared `.provenance/` contains sealed sessions and unsealed sessions.

`reconcileRollingSealsWithSessions` reports every unsealed `.slog` as an `unsealed_session` defect when there is no classic seal (`rolling-seal.ts:209-221`) → check 1 fails → `manifest_sig_invalid` **high / 1.0**.

So during the rollout, having a partner on a not-yet-updated editor produces a high-severity integrity flag.

Separately, `extension_hash_mismatch` (medium / 0.9) is per-bundle and keys on `manifest.extension_hash`; the shipped known-good list is a placeholder (`extension-hash-mismatch.ts:28-31`). Sessions from three different recorders in one scope will not share an extension hash, and `synthesizeRollingUnionManifest` reports the disagreement as a **`divergent_scope`** defect (`rolling-seal.ts:288-292`) → check 1 fails again.

**That second point is a design bug in the union synthesis, not a rollout problem:** `extension_hash` is a _per-session_ property in a multi-recorder scope and must not be a scalar the union insists on agreeing.

**Should.**

- Move `extension_hash` out of the union's scalar-agreement set; keep it per session (`sessions[].` already exists in the manifest shape). Disagreement across sessions in a `collaboration: 'group'` scope is expected, not a defect.
- `unsealed_session` must be severity-graded by whether a seal was _expected_: during a documented rollout window it is informational; a session from a recorder version known to write seals, with no seal, is a defect. **Uncertainty:** "known to write seals" requires a version predicate somewhere, and I do not want to invent a version table. A simpler and more honest rule: `unsealed_session` is reported as a **coverage gap**, always visible, and only becomes a _flag_ when some other session in the same scope, from the same recorder id and version, _does_ carry a seal. That is self-calibrating and needs no table.

**Owner.** `analysis-core/loader/rolling-seal.ts`, `validation/verify-manifest-sig.ts`.

**If wrong.** Cross-editor pairs are flagged for their partner's choice of editor, during the exact window when the program is being rolled out.

---

#### S25. `files_under_review` cannot express a repository

**Today.** `manifest.scope: 'directory' | 'repo'` is signed and **never read by the recorder** (zero hits in `packages/recorder/src`). `files_under_review` is an exact-string list: `ExpectedContentRegistry` does `new Set(...)` + `Set.has` (`state/expected-content-registry.ts:13,18`), and `fs-watcher.ts:102` passes each entry into a `RelativePattern` whose fired URI is then **ignored** (`handleChange` takes `_uri`, `:105`) and looked up by the pattern string itself (`:120`). A glob entry would create a watcher that fires and then finds nothing in the registry.

So a repo-scoped assignment has no way to say what its files are. Whatever is not listed is unwatched: no `fs.external_change`, no expected-content model, and no `submission_files` entry, hence no check 8 coverage.

**Should.** This is a **format decision** (§8.7), not something to invent here. The candidates are: an explicit glob syntax in `files_under_review` (needs a shared matcher across three hand-written ports — a real divergence risk, and §10 of the parent spec is emphatic about that); or a `scope: 'repo'` semantic meaning "every tracked file under the assignment root, discovered at session start" (needs a tracked-file enumeration, which means the git API or a shell-out); or a course-supplied extension allowlist. Each has a different failure mode. I am not choosing.

What I _can_ say: whichever is chosen, the recorder must record the **effective resolved file set** into the chain at session start, for the same reason the parent spec §4 requires the effective capture policy to travel — otherwise the analyzer cannot distinguish "no events for this file because nothing happened" from "no events because it was never watched", and every file-scoped heuristic silently mis-fires on the difference.

**Owner.** `log-core` (format, tri-repo), recorder.

**If wrong.** Repo-scoped assignments record a fraction of the work and the analyzer cannot tell which fraction.

---

#### S26. A student edits a `.slog` in the editor

**Today.** `doc-wiring.ts` excludes everything under `provenanceDir` from every handler (`isProvenanceArtifact`, `:214-218`). The exclusion exists for a good reason — writing the log produces editor events that would feed back into the log (`:194-213`) — but it means a student can open a partner's `.slog` in VS Code, edit it, and save it, and the recorder records **nothing at all**.

The edit is still caught by `validateChain` at analysis time (any content change breaks the hash), so tampering is not _undetected_. But the **act** is invisible, and the chain break is reported as `chain_broken` on the **victim's** session with no indication of who broke it or when.

**Should.** Peer witnessing closes this: a `peer.observed` with a changed sha256 for a foreign `.slog`, recorded in the editing student's own chain, is direct evidence of _who was looking at the file when it changed_. The recorder must record `state: 'grew' | 'shrank' | 'unparseable'` transitions, not only `'appeared'`.

**Note the asymmetry, and state it in the UI:** a chain break in Alice's log proves Alice's log was altered. It does **not** prove Alice altered it. Attribution requires a peer witness in someone _else's_ chain. Reporting a chain break as "Alice tampered" is exactly the collateral accusation R2 forbids, and it is the default reading a grader will apply unless the wording prevents it.

**Owner.** Recorder (peer witnessing), `analyzer` (wording).

---

#### S27. Submission taken after the partner's last push

**Today.** Check 8 compares each submitted file's bytes against the **last recorded hash across all sessions** — the last `doc.save` / `doc.open` sha256 or `fs.external_change.new_hash` (`validation/verify-submitted-code.ts:56-80`). Mismatch → `high / 1.0` with detail _"File was changed outside the recording."_

If Bob pushes at 23:50 and Alice submits the repo at 23:55 without opening it, the submitted bytes are Bob's and the last recorded hash may be Alice's — mismatch, high, 1.0. The wording is technically true and reads as an accusation.

Worse, per S16, which session counts as "last" is decided by wall clock.

**Should.** In a `collaboration: 'group'` scope, "recorded" means "recorded by **any** contributor in the scope", and a submitted file matching **any** contributor's recorded hash at any DAG-maximal position is a **match**. A file matching _none_ is a genuine finding, and the detail should say what it can support: "no contributor's recording produced these bytes" — which is the true and non-accusatory sentence.

**Owner.** `analysis-core/validation/verify-submitted-code.ts`.

**If wrong.** Every group submission fails check 8, and check 8 is the flag that most directly reads as "the student swapped in different code".

---

#### S28. `git.event` is emitted on every repository state change

**Today.** `lastCommit` is tracked and the comparison discarded (`void prev`, `git-wiring.ts:223`). Staging a file, an index refresh, or a working-tree status change emits a full `git.event` — including an `await getCommit(...)` per event. The docstring at `:179-180` claims filtering that does not happen.

Two consequences: log volume (a student running `git add -p` generates a burst), and a DAG builder that will see the same sha observed dozens of times.

**Should.** Decide deliberately. There is a real argument for emitting on non-HEAD-moving changes ("so the analyzer sees the activity", `:249-251`) — but nothing consumes that today, and `operation` is a constant so the activity is indistinguishable from a commit. Either (a) suppress the `getCommit` call and emit a lightweight event when `sha` is unchanged, or (b) filter to HEAD changes only and fix the stale comment. (a) preserves more evidence and is more consistent with R1; it is also a tri-repo behavioural change. The DAG builder must deduplicate by `(repo, sha)` regardless.

**Owner.** Recorder (tri-repo), `analysis-core` DAG builder.

---

#### S29. `markFormatter()` is never called

**Today.** `ExplanationTagger.markFormatter()` (`explanation-tags.ts:40-42`) has **no production caller** anywhere in `packages/recorder/src`. The `explanation: 'formatter'` value is unreachable. `external-edits.ts:36` accepts it, and PRD §4.5 promises it (`docs/prd.md:218`).

Not a git-collaboration issue, but it lands in the same place: format-on-save (Prettier, Black, `google-java-format` — which 61B uses) produces unexplained `fs.external_change` events, and in a shared repo those stack on top of the pull-induced ones. Recording it because it is adjacent and cheap to fix, not because it is in scope.

**Owner.** Recorder.

---

#### S30. Check 1's classic path tries every session's key

**Today.** For a _classic_ seal, `verify-manifest-sig.ts:83-104` verifies `manifest.sig` by trying the most recent session's pubkey first and **falling back to every other session's pubkey**. In a shared `.provenance/` that includes the partner's keys. So a manifest sealed by the partner verifies as this student's.

For the _rolling_ path this is correctly not done — each seal is verified against exactly one key, its own session's (`:152-161`), with the reason stated at `:22-25`.

**Should.** In a `collaboration: 'group'` scope the fallback is arguably correct (any contributor may have run seal). But the verdict must record **which** key verified, and that must be visible. "The manifest is signed by someone in this scope" and "the manifest is signed by the submitting student" are different claims and the report currently conflates them. Low urgency — git submissions do not run seal — but it should not be inherited into the group model unexamined.

**Owner.** `analysis-core/validation/verify-manifest-sig.ts`.

---

#### S31. `manifest_downgrade` is dead code

**Today.** `ValidationCheckId` includes `'manifest_downgrade'` and its JSDoc claims it reaches a flag through `CHECK_META` (`validation/check-types.ts:19-31`). `verifyManifestDowngrade` (`validation/verify-manifest-downgrade.ts:157`) is referenced **only by its own test file**. It is not in `run-validation.ts`, not in `CHECK_META`, and not exported from the `analysis-core` barrel. **No `manifest_downgrade` flag can ever be produced.**

Out of scope for git collaboration, but it is a case of a check that documents itself as running and does not — an R1 hazard by inspection. Flagged for someone to resolve; not changed here.

---

## 4. Adversarial pass

For each mechanism, what a motivated student does, and the honest classification: **detected**, **undetectable-but-useless**, or **silently exploitable**.

| #   | Mechanism                                                 | Attack                                                                                                         | Class                                                                                                                                                                                                                                                                                                                                                                             | Notes                                                                                                                                             |
| --- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Contributor identity (`student_ref` via enrollment chain) | Work on the partner's machine under their key                                                                  | **Silently exploitable**                                                                                                                                                                                                                                                                                                                                                          | Parent spec §12 already concedes this. No identity scheme fixes it. The mitigation is wording (S10), not detection.                               |
| 2   | Contributor identity                                      | Forge a session claiming to be the partner                                                                     | **Detected**                                                                                                                                                                                                                                                                                                                                                                      | Requires the partner's per-course private key. The chain root → course_cert → enrollment_cert → token → `session_pubkey_sig` is verified offline. |
| 3   | Peer witnessing                                           | Delete the partner's `.slog` **and** every session of yours that witnessed it                                  | **Detected**, loudly                                                                                                                                                                                                                                                                                                                                                              | Yields a scope with almost no provenance — the loudest signal available. Also caught by DAG coverage if any session survives.                     |
| 4   | Peer witnessing                                           | Delete the partner's log before your recorder ever ran (e.g. immediately on clone)                             | **Silently exploitable** by that mechanism; **detected** by DAG coverage if any surviving session observed a commit whose lineage the deleted log covered. Partial, and I will not overstate it.                                                                                                                                                                                  |
| 5   | Peer witnessing                                           | Truncate rather than delete the partner's log                                                                  | **Detected** — the witnessed tip hash commits to an exact prefix; a shorter chain cannot reproduce it. This is precisely why the witness records `last_hash` and not only `seq_high`.                                                                                                                                                                                             |
| 6   | Peer witnessing                                           | Never let the recorder run while the partner's file is present (e.g. always work with `.provenance/` stashed)  | **Detected as a coverage gap**, not as an act. Correct: it is not provably misconduct.                                                                                                                                                                                                                                                                                            |
| 7   | Session ordinal                                           | Restart the count from 1 on a fresh clone                                                                      | **Detected** if any peer witness or any prior committed session shows a higher ordinal for that contributor. **Silently exploitable** if the student controls every copy — which is why §5.5 states the ordinal is a lower-bound claim, not a counter.                                                                                                                            |
| 8   | Commit DAG                                                | Rebase away the incriminating commits before submitting                                                        | **Detected** — observations are inside signed chains recorded at the time. Surfaced as `history_rewritten` + orphaned observations.                                                                                                                                                                                                                                               |
| 9   | Commit DAG                                                | Never commit; do all the work in the working tree, commit once at the end                                      | **Undetectable-but-useless** — it produces a scope with one commit and a full event stream, which is the _strongest_ provenance, not the weakest. Nothing is gained.                                                                                                                                                                                                              |
| 10  | Commit DAG                                                | Fabricate `git.event` entries with invented shas                                                               | **Detected** — they are inside a hash chain; adding one requires re-chaining the file, which breaks `prev_hash` at the insertion point. Rewriting the whole chain requires the session's ephemeral private key, which is encrypted with a key derived from the manifest signature (`docs/prd.md` §4.6 / `session-keys.ts`).                                                       |
| 11  | Commit DAG                                                | Suppress `git.event` by working in a repo the recorder does not consider owned                                 | **Silently exploitable today** — S14(a) does this by accident already, and a student who nests the assignment one level below the repo root gets it for free. Fixing S14(a) closes it.                                                                                                                                                                                            |
| 12  | Same-scope cross-flag exclusion (DAG intersection)        | Claim to be someone's partner to suppress a collusion flag                                                     | **Detected/useless** — you must have observed their commits, which requires their repo. If you have their repo you _are_ in their scope.                                                                                                                                                                                                                                          |
| 13  | Same-scope exclusion                                      | Two genuinely colluding students who are **not** partners fork one repo so their DAGs intersect                | **Silently exploitable.** This is the real hole in mechanism 12. Mitigation: exclusion applies only when the scope's manifest says `collaboration: 'group'` **and** both submissions map to contributors the course has grouped. That pushes the check onto roster/group data the server holds, which is §8.1 territory. Stated plainly as an open hole rather than papered over. |
| 14  | Git-delivery reclassification (S2)                        | Craft an external write whose content matches a partner's recorded save hash, to get it reclassified as a pull | **Undetectable-but-useless** — to match the hash you must have the partner's exact recorded bytes, which means the content genuinely is the partner's recorded work. That is what the reclassification asserts.                                                                                                                                                                   |
| 15  | Git-delivery reclassification                             | Get the partner to `doc.save` AI-generated code, then "pull" it                                                | **Silently exploitable at the scope level, correctly attributed at the contributor level.** The paste/AI flags fire on the _partner's_ session where the content originated. The scope is not laundered; the attribution moves to whoever actually did it. That is the intended behaviour, and it is why per-contributor scoping (S6) is load-bearing rather than cosmetic.       |
| 16  | Ownership-gated quarantine (S19)                          | Deliberately corrupt the partner's `.slog` so the partner's own recorder quarantines it                        | **Silently exploitable today** — this is a live attack, not a hypothetical: corrupt one byte of the partner's log and their next session renames it. After the fix the file is left alone and the corruption is a finding on the partner's chain with a peer witness naming who saw it change. Still not fully attributive; better.                                               |
| 17  | Rolling seal                                              | Delete `manifest-<id>.sig` and keep the `.json`                                                                | **Detected** — `missing_sig` defect → check 1 fails (`rolling-seal.ts:150-158`).                                                                                                                                                                                                                                                                                                  |
| 18  | Rolling seal                                              | Copy a valid seal under another session's filename                                                             | **Detected** — the filename ↔ `session_id` binding (`rolling-manifest.ts:157-163`, enforced at `rolling-seal.ts:140-148`).                                                                                                                                                                                                                                                        |
| 19  | Everything                                                | Add `.provenance/` to `.gitignore`                                                                             | **Detected as absence** (S12), provided ingest reports `no_provenance_in_repo` as its own outcome and the course acts on it. If ingest treats an empty scope as clean, this is the cheapest total defeat in the system.                                                                                                                                                           |
| 20  | Everything                                                | Uninstall the recorder for the productive hours, reinstall to submit                                           | **Detected as a coverage gap** — DAG shows commits with no recording behind them; `gap_in_heartbeats` and inter-session divergence within the contributor's own chain both fire. Not provably misconduct, correctly.                                                                                                                                                              |

The three entries I want to be explicit about as **silently exploitable**: #1 (working on a partner's machine), #13 (non-partners forging scope identity), and #11/#16 (both closable, and both live today).

---

## 5. Semantics

### 5.1 Contributor

A **contributor** is a `student_ref` whose enrollment chain verifies offline against the scope manifest's root-anchored `course_cert`, per parent spec §5a steps 0–4. Window failures are non-fatal (§5a step 5) and are recorded, not enforced.

```
contributorOf(session) =
  | { kind: 'verified',      studentRef }              // identity present and chain verifies
  | { kind: 'unverifiable',  studentRef, reason }      // identity present, chain fails — a FINDING
  | { kind: 'unattributed',  sessionId }               // no identity block at all
```

Rules, all load-bearing:

- Contributor identity comes **only** from `session.start.identity`. Never from `machine_id` (session-salted, `recorder-context.ts:33-44`, can never match across sessions), never from git author (out of bounds, `events.ts:275-287`), never from the filename regex (`match-student.ts` — that identifies the _submitter_, not the contributors).
- `unverifiable` is never merged into the claimed `studentRef`. It is its own contributor _and_ its own finding.
- `unattributed` sessions are singleton contributors. They participate fully in reconstruction and the DAG; no finding may name a person on their strength.
- `contributorOf` lives in `analysis-core` and is pure. Signature verification is async, so — exactly as `establishBundleTrust` does for the capture policy (`loader/types.ts:189-201`) — the verdict is computed once and **stamped onto the Bundle**, and the synchronous accessor reads the stamp. An unstamped bundle is treated as fully unattributed, which fails toward more findings, not fewer.

### 5.2 The ordering model

Four levels, strongest first.

**L0 — intra-session hash chain.** Total order within a session, enforced by `seq` + `prev_hash` (`log-core/src/chain-validator.ts:69-135`). Fully trustworthy: altering it requires the session's private key.

**L1 — intra-contributor session chain.** Partial order over one contributor's sessions, from ownership-gated `prev_session_id` plus the signed session ordinal (S9). Trustworthy up to the lower-bound caveat in S9/§4 #7.

**L2 — the observed commit DAG.** The load-bearing new primitive.

Build it from every `git.event` in every session in the scope:

- Node key is `(repository, sha)` — see S14(b) for the repository discriminator, which is an open format question (§8.6). Until it is answered, the DAG is only sound for single-repository scopes, and a scope observing more than one repository must be reported as such rather than merged.
- Edges come from `parents`, in git's own order; the **first parent is the branch merged into** and the order must never be sorted (`events.ts:305-312`).
- **`parents` absent ≠ `parents: []`.** Absent → in-edges unknown; the node is `root_or_unknown`, never a root. Empty → genuinely parentless. Collapsing them turns every read failure into a false repository root (S15).
- Every node records the set of `(sessionId, seq)` that observed it. That provenance is what makes the DAG evidence rather than metadata: each observation sits at a specific position inside a specific signed chain.

Derived facts:

- **Ancestry** `c_a ≺_g c_b` — standard reachability.
- **Observed HEAD** — a sha observed as `git.event.sha`.
- **Witnessed-only commit** — a sha appearing only in some `parents` array. Proof that a commit existed with no session recording work at it.
- **Orphaned observation** — an observed HEAD unreachable from every later observation. Signature of amend / rebase / squash / discarded branch (S7).

**L3 — wall clock.** Never an ordering authority across contributors. Two legitimate uses:

1. **Display.** Timelines need an axis. It must be labelled as each machine's own clock.
2. **Measured disagreement.** If session S_a observed commit c_a at wall w_a, session S_b observed c_b at w_b, and `c_a ≺_g c_b`, then c_a existed before c_b, so the two clocks demonstrably disagree by at least `w_a − w_b` when that is positive. Define

   `skew_lower_bound(S_a, S_b) = max over DAG-ordered observation pairs of (w_earlier − w_later)`

   This is a _measurement_ derived from two signed chains, and it replaces `multiple_sessions_overlap`'s unsupported "impossible on a single machine" with something true. Where it is large, every wall-derived ordering in the scope is explicitly untrustworthy and must be labelled.

**The happens-before relation `≺` over events.** Let `e ≺ f` be the transitive closure of:

1. `session(e) = session(f)` and `seq(e) < seq(f)`. _(L0)_
2. `session(e) ≺_s session(f)` in the same contributor's session chain. _(L1)_
3. `e` is at or before a `git.event` observing `c_e`; `f` is at or after a `git.event` observing `c_f`; and `c_e ≺_g c_f`. _(L2)_

`≺` is a **strict partial order**. Events with neither `e ≺ f` nor `f ≺ e` are **concurrent** and must be presented as concurrent. Nothing in the system may linearize concurrency silently. Where a total order is needed for a stable UI (list ordering, flag ids), the tiebreak is `(sessionId, seq)` — deterministic, clock-free, and already the existing tiebreak in `build-index.ts:222-228`. Wall clock stops being the primary key.

**What this costs.** `buildIndex`'s `ordered` array and `globalIdx` are wall-derived today, and a great deal of code keys on `globalIdx` (reconstruction cut points, `supportingSeqs`, `selfInflictedExternalChanges`). Changing the primary sort key changes every `globalIdx`. The migration must therefore keep `globalIdx` as a stable dense index over the _new_ order and re-derive everything from it, in one change — this is not a candidate for incrementalism.

### 5.3 The reconstruction model

**Segments.** A file's history in a scope is a set of **segments**. A segment is a maximal contiguous run of one session's events on one path. It belongs to exactly one session, therefore to exactly one contributor, and is internally totally ordered by L0 — so a segment is always internally reconstructable by exactly today's algorithm.

**Anchors.** A segment may begin at an **anchor**: a disk observation that is ground truth rather than a derived state. The two anchor kinds already exist and are already treated as re-anchoring:

- `doc.open` carrying inline `content` (`reconstruct-file.ts:747-772`, which clears taint at `:769`).
- `fs.external_change` carrying `new_content` (`:838-850`).

A third weaker anchor is a `doc.save.sha256`: it does not give content but it _verifies_ a candidate content, and `rememberBlob` already exploits that (`:350-360`).

**The reconstruction graph.** Segments are joined by an edge only when one `≺` the other. Concurrent segments are **siblings** and are never concatenated.

```
reconstructFileAt(scope, path, cut) →
  | { kind: 'determinate', content, provenance }
  | { kind: 'concurrent',  branches: Array<{ contributor, content, provenance, tip }> }
  | { kind: 'unknown',     reason }
```

- **determinate** — the segments up to `cut` form a chain under `≺`. Replay as today.
- **concurrent** — two or more sibling lineages are live at `cut`. Return all of them. Any caller that needs one string must handle this case explicitly; there is no default.
- **unknown** — no anchor and no seed (the pre-v1.1 case, an over-cap external change with no content). Today this is `tainted` with best-effort content; that behaviour is good and stays, but it must be surfaced through the same three-state vocabulary as everything else (§6).

**Merge points re-anchor.** After a merge commit, the first disk observation any contributor makes for that path is ground truth for the merged content. That anchor closes the sibling branches and a single lineage resumes. This is the crucial property that keeps `concurrent` bounded: it lasts from the branch point to the first post-merge observation, not forever.

**Per-character provenance gains a contributor axis.** `ProvenanceKind` (`index/reconstruct-file-provenance.ts:68`) becomes `{ kind, attribution }` where attribution is:

- `direct(studentRef)` — the character was written by a `doc.change` / `paste` in a session belonging to that contributor. **Established** evidence.
- `via_merge(studentRef)` — the character entered through an `fs.external_change` / `doc.open` seed whose content matches a segment authored by that contributor at a DAG-ancestor position. **Inferred** evidence, and labelled as such everywhere it is shown.
- `unattributed` — everything else.

**Attribution by elimination is forbidden.** "Alice did not type it, therefore Bob did" is not a permitted inference. If a character cannot be traced to a segment, it is `unattributed`. This is the single rule that keeps per-character attribution from becoming a defamation engine.

### 5.4 The reconciliation algorithm

Pure, deterministic, in `analysis-core`, run once per scope per load. Ordered — the stages have real dependencies.

1. **Resolve contributors.** §5.1 for every session. Output `contributorOf : sessionId → Contributor`, plus the `unverifiable` findings.
2. **Build per-contributor session chains.** Order by ownership-gated `prev_session_id` and signed ordinal. A `prev_session_id` pointing at a session with a different contributor is a `foreign_session_link` finding and is **not** an edge. Sessions with no back-pointer are ordered by DAG constraints first; where the DAG says nothing, the wall-clock tiebreak is used **and labelled as a guess**.
3. **Build the observed commit DAG.** §5.2. Deduplicate observations by `(repo, sha)`. Preserve `parents` order. Honour absent-vs-empty.
4. **Compute `≺`** and its transitive reduction for display. Detect concurrency.
5. **Compute coverage.** Observed HEADs; witnessed-only commits; orphaned observations; per-contributor session counts and recorded wall spans; wall intervals in which some contributor's commits advanced with no session recording. Also compute `skew_lower_bound` for every session pair with DAG-ordered observations.
6. **Reconcile logs against seals and witnesses.** Rolling-seal defects (existing); duplicate `sessionId` (new, S4); seals with no `.slog` and `.slog`s with no seal (existing, re-graded per S24); peer witnesses naming sessions that are absent, shorter than witnessed, or whose tip hash does not reproduce.
7. **Reclassify external changes.** For each `fs.external_change` not already `selfInflicted`, apply the S2 content test: match against every other session's recorded `doc.save` / `doc.open` hashes for that path. Classify `git_merge_in` (matched, and DAG-adjacent) / `git_unrecorded_in` (DAG-adjacent, unmatched) / `external` (neither). Store the classification set on the index alongside `selfInflictedExternalChanges` — same pattern, same visibility guarantee: reclassified events stay in `byKind` and `ordered` so the timeline can show them.
8. **Scope the heuristics.** Three categories, and every heuristic must be assigned to one explicitly — the parent spec §4 already requires an audit of all 25 against the absence-vs-disabled rule; this is a second axis of the same audit.
   - **Per-contributor** — runs over one contributor's sessions; flags carry `contributor_id`. `large_paste`, `paste_is_solution`, `paste_matches_known_source`, `low_typing_high_output`, `time_to_first_save_anomaly`, `idle_then_complete`, `no_intermediate_errors`, `ai_extension_active`, `shell_integration_disabled`, `extension_set_changed_mid_assignment`, `clock_jumps`, `gap_in_heartbeats`, `extension_hash_mismatch`.
   - **DAG-aware, scope-level** — must be _rewritten_, not merely filtered. `external_edits`, `mass_external_replacement`, `terminal_active_during_external_change` (consume step 7's classification); `inter_session_external_change` (compare within a contributor's chain only); `multiple_sessions_overlap` (contributor-keyed per S5).
   - **Not applicable in group mode** — none, currently. If any heuristic ends up here it must return a visible `not_applicable` with a reason. **A heuristic is never silently disabled** (R1).
9. **Cross-submission scoping.** Exclude pairs sharing a commit in their observed DAGs, gated on `collaboration: 'group'` and (pending §8.1) on the course's group data. Excluded pairs are shown as excluded.

Determinism: no wall clock in any decision, no `Math.random`, no iteration over unordered structures. Ingest retries must produce identical flags — the existing contract (`internal-move.ts:19-21`).

### 5.5 Peer witnessing

**New event kind** `peer.observed`. Tri-repo; parent spec §11 item 4 already flags it as requiring approval.

```ts
export type PeerObservedPayload = {
  /** `.provenance/`-relative filename exactly as seen, e.g. `session-<uuid>.slog`. */
  file: string;
  /** sha256 of the file's exact bytes at observation time. */
  sha256: string;
  bytes: number;
  /** From the foreign file's `session.start`. null when it does not parse. */
  session_id: string | null;
  /** Highest `seq` in the foreign chain. null when it does not parse. */
  seq_high: number | null;
  /**
   * The foreign chain's final entry `hash`. null when it does not parse.
   * This is what upgrades the witness from a size claim to a verifiable
   * commitment to an exact prefix: a later truncated copy cannot reproduce it.
   */
  last_hash: string | null;
  state: 'appeared' | 'grew' | 'shrank' | 'disappeared' | 'unparseable';
};
```

**Production, and why it does not cost the hot path.**

- One `FileSystemWatcher` on the `.provenance/` directory — not one per file. Distinct from the `files_under_review` watchers.
- Callbacks enqueue a filename onto a background queue and return. No I/O, no hashing, no parsing on the callback.
- The queue is drained on the **checkpoint cadence** (every 100 entries, `session-registry.ts:303`) or a timer, whichever is later, and is rate-limited to at most one observation per file per interval. This is the same cadence at which the rolling seal is rewritten, so the two share a drain point.
- Hashing and first-line parsing happen on the drain, asynchronously, and emit through the ordinary `sessionHost.emit` path.
- The recorder's **own** files are excluded by path.
- **The recorder never renames, modifies, or deletes a foreign file** (S19). `state: 'unparseable'` is the whole response to a foreign file it cannot read.

**What each mechanism proves — the table the parent spec §7 asks for.**

| Mechanism                                                         | Proves                                                                                                                             | Does not prove                               | Blind to                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Session continuity (`prev_session_id` + ordinal, ownership-gated) | A session of _this contributor_ is missing between two surviving ones                                                              | Who removed it                               | Anything about another contributor's chain; a contributor's entire chain being removed; sessions before the first survivor        |
| Peer witnessing                                                   | A specific foreign log existed, with a specific byte length and a specific chain tip, at a specific point inside _my_ signed chain | Who removed or altered it                    | Logs that never coexisted with any of my sessions; logs deleted before my first session; the case where my chain is destroyed too |
| Commit-DAG coverage                                               | Work happened at commits that no surviving log covers                                                                              | Who did that work, or that it was misconduct | Work that produced no commit                                                                                                      |

The third is the only one safe to report at scope level without naming anyone, and it is the one that should drive the coverage panel. The first two produce named findings and are held to the `established` bar (§6).

### 5.6 What the recorder must record so the analyzer can tell absence from disablement

The parent spec §4 establishes the absence-vs-disabled rule for capture policy. Git collaboration adds three more instances of the same rule, and each must travel inside the signed chain:

1. **The effective resolved file set** (S25) — otherwise "no events for this file" is ambiguous.
2. **Whether git observation was available** — the git extension may be absent, `getAPI(1)` may fail, or the repository may not be owned (`git-wiring.ts:147-165`, `:213-215`). All three currently degrade to a `console.warn` and silence. A scope with no `git.event` is then indistinguishable from a scope where git capture was impossible. A `git_capture: 'available' | 'unavailable' | 'not_owned'` field on `session.start` closes it.
3. **Whether `.provenance/` witnessing was available** — same argument.

Each is a `session.start` addition and therefore tri-repo.

---

## 6. Presenting ambiguity

Four rules. They are the operational form of R2.

**Rule 1 — three states, everywhere.** Every claim the analyzer makes is `established` (direct evidence inside a chain that verifies), `inferred` (derived through the DAG, a content match, or a merge attribution — and the inference is named in the UI), or `unknown` (stated, with what would have resolved it). `ReconstructResult.tainted` is the existing precedent and should be generalised rather than duplicated.

**Rule 2 — a finding names a person only when the evidence is `established` for that person.** Otherwise it is a scope-level finding with no name attached. Concretely: a chain break in Alice's log is a finding _about Alice's log_, not about Alice (S26). A pasted block whose source is `via_merge(Bob)` is reported as "matches content recorded under Bob's key", not as "Bob wrote this".

**Rule 3 — a coverage panel per scope, always visible.** Observed commits vs witnessed-only commits; sessions and recorded time per contributor; unattributed sessions; intervals where commits advanced with no recording; `skew_lower_bound` where it is nonzero; every `not_applicable` heuristic with its reason. Low coverage is displayed as low coverage. It is never a flag and never a score contribution — it is context a human needs to read the flags correctly.

**Rule 4 — replay never linearizes concurrency.** A replay position inside a concurrent interval shows the branches side by side, or refuses with an explanation. It does not pick one and it does not interleave. The existing "reconstruction is best-effort, `tainted` tells you not to trust it" contract (`reconstruct-file.ts:44-64`) is the right instinct; concurrency needs the same honesty with a different shape.

And one negative rule that follows from R1: **nothing in this design may reduce the findings produced for a solo, non-git submission.** Every gate proposed above is conditioned on `manifest.collaboration === 'group'` or on the presence of a second verified contributor, both of which are inside the course-signed payload and therefore not student-controllable. A solo submission takes the identical path it takes today.

---

## 7. Ranked worklist

Dependency order. **Bold** = load-bearing or high-risk.

### Tier 0 — bugs that are destroying or losing evidence right now

| #       | Item                                                                                                                   | Why now                                                                                                                    | Files                                                                           |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **0.1** | **Ownership-gate the quarantine.** The recorder must not rename a `.slog` it did not write.                            | Live, exploitable (§4 #16), and destroys another student's evidence with the _victim's_ commit history as the paper trail. | `recorder/src/startup/chain-recovery.ts`, `session/session-registry.ts:161-187` |
| **0.2** | **Ownership-gate `prev_session_id`.** No link to a session with a different `student_ref`.                             | Makes parent spec §7 mechanism 1 fictional in shared repos, and asserts a false relationship between two students.         | same                                                                            |
| **0.3** | **Detect that our own `.slog` was replaced underneath us** (inode/size check at checkpoint) and start a fresh session. | Silent, total, ongoing loss of a session's tail on any checkout that touches `.provenance/` (S4 cx4, S8).                  | `recorder/src/io/session-writer.ts`, `session/session-registry.ts`              |
| 0.4     | Preserve rolling seals in `isProvenanceEntry`.                                                                         | Latent today, total failure the day S3 ships.                                                                              | `server/src/services/ingest/strip-bundle.ts`                                    |
| 0.5     | Fix the git ownership predicate so a repo root that _contains_ the assignment root is owned.                           | `git.event` is silently 100 % dark for nested-assignment layouts (S14a), and it is a free evasion (§4 #11).                | `recorder/src/wiring/git-wiring.ts:213-215`, `session/session-router.ts`        |

Tier 0 is independent of every product decision in §8 and should not wait for them.

### Tier 1 — foundations

| #       | Item                                                                                                                                                                                                   | Depends on           | Risk                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1.1** | **Contributor resolution in `analysis-core`** — read `session.start.identity`, verify offline against the root-anchored `course_cert`, stamp the verdict on the Bundle, expose a pure `contributorOf`. | S2 identity (landed) | **High.** Everything below depends on it. Getting `unverifiable` vs `unattributed` wrong is directly an R2 failure.                                                                                 |
| **1.2** | **Observed commit DAG builder** — `analysis-core/src/git/observed-dag.ts`. Absent-vs-empty parents, parent order preserved, observations carry `(sessionId, seq)`.                                     | 0.5                  | **High.** The DAG is the ordering primitive; a wrong edge is a wrong `≺` is a wrong everything. Needs the S14(b) repository-discriminator decision (§8.6) before it is sound for multi-repo scopes. |
| 1.3     | Recorder-side rolling-seal writer, on the checkpoint cadence.                                                                                                                                          | 0.3, 0.4             | Medium. Spec'd in the parent doc §8; the read side is done.                                                                                                                                         |
| 1.4     | `manifest.collaboration` threaded into `analysis-core` as a signed gate.                                                                                                                               | 1.1                  | Low, but it is the switch that keeps solo behaviour unchanged.                                                                                                                                      |

### Tier 2 — ordering and reconstruction

| #       | Item                                                                                                                                                      | Depends on | Risk                                                                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **2.1** | **The `≺` relation and the re-keyed index.** Replace wall clock as `buildIndex`'s primary sort key; `globalIdx` becomes a dense index over the new order. | 1.2        | **Highest in the plan.** `globalIdx` is load-bearing for reconstruction cut points, `supportingSeqs`, flag ids, and the replay cursor. Must land as one change with the full test suite green, not incrementally. |
| **2.2** | **Segment-based reconstruction** with the `determinate` / `concurrent` / `unknown` result.                                                                | 2.1        | **High.** Every consumer of `reconstructFile` must handle `concurrent`. Silently defaulting to one branch would reintroduce exactly the fabrication this fixes.                                                   |
| 2.3     | Contributor axis on per-character provenance (`direct` / `via_merge` / `unattributed`), with elimination forbidden.                                       | 2.2, 1.1   | Medium.                                                                                                                                                                                                           |
| 2.4     | Re-anchor the union manifest's `submission_files` merge on `≺` instead of wall order; check 8 matches any concurrent recorded state.                      | 2.1        | Medium. Removes a high/1.0 flag driven by clock skew (S16, S27).                                                                                                                                                  |

### Tier 3 — the dangerous heuristics

| #       | Item                                                                                                                                                                                                            | Depends on | Risk                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------- |
| **3.1** | **External-change reclassification** (`git_merge_in` / `git_unrecorded_in` / `external`) by content match, consumed by `external_edits`, `mass_external_replacement`, `terminal_active_during_external_change`. | 1.2, 1.1   | **High.** The most common false positive in the census. Must keep reclassified events visible (R1).                 |
| **3.2** | **`multiple_sessions_overlap` keyed on contributor.**                                                                                                                                                           | 1.1        | **High.** High/0.95 forgery accusation on normal pair work.                                                         |
| **3.3** | **`inter_session_external_change` scoped to one contributor's chain.**                                                                                                                                          | 1.1, 3.1   | **High.** Fires on every partner commit today.                                                                      |
| 3.4     | `internal_move` gains `partner_move` (contributor-scoped own-work), fail-closed preserved.                                                                                                                      | 2.3        | Medium-high. Loosening the provenance gate incorrectly reopens the laundering path `internal-move.ts:10-13` closes. |
| 3.5     | Per-contributor heuristic scoping in `run-heuristics.ts`; `Flag.contributor_id`.                                                                                                                                | 1.1        | Medium.                                                                                                             |
| 3.6     | Interim: widen the explanation tagger to a per-path set with a budget (bridge for 3.1).                                                                                                                         | —          | Low. Ships before the DAG; explicitly a bridge.                                                                     |

### Tier 4 — witnessing and deletion detection

| #       | Item                                                                                            | Depends on | Risk                                                                                |
| ------- | ----------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| **4.1** | **`peer.observed` event kind** + recorder directory watcher, off the hot path, non-destructive. | 0.1, §8.5  | **High.** Tri-repo format change; needs the CPHS answer in §8.5 before it can ship. |
| 4.2     | Signed per-contributor session ordinal on `session.start`.                                      | 1.1        | Medium. Tri-repo. Must be documented as a lower-bound claim.                        |
| 4.3     | Reconciliation of witnesses against present logs (absent / short / tip mismatch).               | 4.1        | Medium.                                                                             |
| 4.4     | Duplicate-`sessionId` loader defect.                                                            | —          | Low.                                                                                |

### Tier 5 — server, cross-flags, UI

| #   | Item                                                                                                                                                                               | Depends on  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 5.1 | `submission_contributors`, nullable `submissions.student_id`, `flags.contributor_id` (parent spec §7; needs §8.1).                                                                 | 1.1, 3.5    |
| 5.2 | Same-scope cross-flag exclusion by DAG intersection, visibly labelled.                                                                                                             | 1.2, §8.1   |
| 5.3 | Contributor switcher, concurrency-aware replay, coverage panel, three-state wording.                                                                                               | 2.2, 3.5    |
| 5.4 | `/architecture` updates — event kinds, ingest read path, recorder capture, reconstruction. Per `CLAUDE.md` this is not optional and `nodes.coverage.test.ts` will fail without it. | each change |
| 5.5 | Conformance vectors for every new format rule (`peer.observed`, session ordinal, repo discriminator). Parent spec §10: a vector change is a breaking change to two other repos.    | 4.1, 4.2    |

### Non-goals of this design

- Recorder-side git _operation_ classification (merge / rebase / checkout labels). The DAG recovers merge structure from `parents.length`; a label adds tri-repo surface for little gain (S7).
- Shipping `.git`. Parent spec §1 already settles it.
- Capturing git author identity, in any form. Out of protocol (`events.ts:275-287`).
- Encrypting logs in the shared repo. Parent spec §12.

---

## 8. Open questions — product decisions, not coding decisions

Per `CLAUDE.md`: I am not inventing answers to these.

1. **Is a group submission one submission with N contributors, or N submissions?** This decides dedup behaviour (S20 — today identical bytes silently erase the second student), scoring roll-up, the Gradescope mapping in provgate, the retention story, and whether `submissions.student_id` becomes nullable or gains a join table. Every Tier 5 item waits on it.

2. **What does a score mean for a group?** Per contributor, per scope, or both? `submissions.score_total` / `score_max_severity` / `flag_counts` are single-valued today and back the cohort list.

3. **A contributor who never enrolled.** Show them as an unattributed contributor, refuse to score the scope, or flag it? Each is defensible and they lead to very different grader behaviour.

4. **`multiple_sessions_overlap` in group mode** — contributor-keyed (my proposal, S5), disabled, or kept and relabelled? Contributor-keying changes solo behaviour too, which is a deliberate improvement but is still a change to a shipped high-severity flag.

5. **CPHS coverage for peer witnessing.** One student's recorder reading another student's process log — hashing bytes, reading a session id, a seq and a chain tip; no content. Is that inside the approved protocol, or does it need the S6 amendment the parent spec §11 item 6 already anticipates? This gates Tier 4 entirely.

6. **The repository discriminator for `git.event`** (S14b). Not a path, not a remote URL. Root-commit sha? A session-salted hash of the repo root, in the manner of `machine_id`? Something else? It is a signed-format decision with tri-repo consequences, and the DAG is unsound for submodule/nested-repo scopes until it is answered.

7. **How does `scope: 'repo'` express its file set?** (S25.) Globs in `files_under_review` (needs a matcher agreed across three hand-written ports — the exact divergence risk parent spec §10 warns about); git-tracked-file enumeration at session start (needs the git API or a shell-out); an extension allowlist; something else. Also: what is the watcher budget for a large repo?

8. **Is `history_rewritten` informational or actionable?** 61B teaches rebase. Squashing before submission is normal practice in some courses and evasion in others. Per-course policy, or a fixed default?

9. **Retention and partners.** Deleting a submission's blob deletes evidence about contributors who are not that submission's `student_id`. `docs/admin-guide.md` §6 and the "rows persist for audit" rule were written for solo submissions.

10. **A scope containing sessions from more than one `assignment_id` or `course_id`** (S13) — reject the scope at ingest, or ingest and flag? Rejection loses the innocent-copy case; ingestion risks accepting an out-of-scope log.

11. **Cross-flag exclusion and non-partner collusion** (§4 #13). Excluding pairs by shared DAG lineage is defeated by two colluding students who fork one repo. Restricting the exclusion to course-declared groups closes it but requires group data at cross-flag time. Which trade?

12. **Should the recorder warn about an ignored/untracked `.provenance/`** (S12), and how forcefully? A modal blocks work; a status-bar hint is missed. The failure it prevents is a student submitting nothing after doing everything.

---

## 9. Uncertainties I am flagging rather than resolving

Stated separately from §8 because these are engineering unknowns I could not settle by reading, not product calls.

- **Whether VS Code's git API exposes ignored-status for an arbitrary path** without a `git check-ignore` shell-out (S12). If it does not, the recorder's `.gitignore` warning needs a different mechanism.
- **The exact conflict behaviour of git's 3-way merge on an append-only file whose two sides are prefix-related** (S4 cx1). I reason it conflicts because the added hunks overlap in position with different content; I did not run it. If git in fact merges cleanly, counterexample 1 collapses and the `.provenance/` conflict story is stronger than I have described. Worth a five-minute experiment before the design is approved.
- **Whether replacing `buildIndex`'s sort key breaks the replay cursor's assumptions** beyond `globalIdx` renumbering (2.1). I traced `globalIdx` through reconstruction, `supportingSeqs` and `selfInflictedExternalChanges`; I did not trace the analyzer's replay UI exhaustively.
- **The cost of the S2 content test at scope scale.** It is a hash-set join over every recorded `doc.save` / `doc.open` sha in the scope — cheap in principle, but ingest is already CPU/IO-bound post-0019, and this runs per `fs.external_change`. Needs measurement, not assumption.
