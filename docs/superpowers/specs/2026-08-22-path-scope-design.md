# Path scope — folder tracking, ignore lists, and bundle attachments

**Repo:** `provenance` monorepo (branch `feat/manifest-2.0-trust-chain`)
**Date:** 2026-08-22
**Status:** Design, approved in brainstorming. Not yet implemented.
**Parent spec:** [`2026-08-18-multicourse-program-architecture.md`](./2026-08-18-multicourse-program-architecture.md) — §3 (Manifest 2.0), §4 (capture policy).
**Answers:** [`2026-08-19-git-collaboration-semantics.md`](./2026-08-19-git-collaboration-semantics.md) §8.7 / open question 7 (S25) — "how does `scope: 'repo'` express its file set?"
**Scope:** three related additions to the course-signed manifest — tracking a folder rather than a file list, excluding files from capture entirely, and carrying files into the bundle without capturing them.

---

## 0. How to read this

§1 is ground truth. §2 states the four decisions taken in brainstorming and why. §3–§8 are the design proper, one per layer: format, recorder, bundle disclosure, analyzer, staff tooling, conformance. §9 is the false-accusation review, which is a first-class section here rather than a footnote. §10 is the worklist. §11 is what this design deliberately does not do.

Two standing rules from `2026-08-19-git-collaboration-semantics.md` §0 govern every choice below:

> **R1. Fail toward surfacing evidence.** Anything a heuristic cannot evaluate soundly becomes a visible `not_applicable` with a reason, never a silent skip and never a zero.
>
> **R2. Never manufacture a tamper finding against an innocent student.**

R2 is the binding constraint in this design. Folder rules break two existing findings in ways that accuse students who have done nothing — see §9.

---

## 1. Ground truth — what exists today

| Piece                    | State                                                                              | Evidence                                                      |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `files_under_review`     | Exact-path strings only. No wildcard, no folder, no matcher anywhere.              | `packages/log-core/src/manifest.ts` (`parseManifestValue`)    |
| Watch-set membership     | `new Set(filesUnderReview)` + `Set.has`                                            | `packages/recorder/src/state/expected-content-registry.ts:13` |
| Filesystem watchers      | One `RelativePattern(assignmentRoot, entry)` per entry                             | `packages/recorder/src/wiring/fs-watcher.ts:102`              |
| Effective-set disclosure | `file_scope.watched` + `complete`, capped at 4096                                  | `packages/recorder/src/session/recorder-context.ts:37,181`    |
| Bundle contents          | `.provenance/` + raw bytes of every `files_under_review` entry                     | `packages/recorder/src/commands/seal.ts` (module docstring)   |
| Bundle manifest shape    | `submission_files?`, plus additive optional `final?`                               | `packages/log-core/src/bundle.ts:25,72`                       |
| Ingest stripping         | Allowlist: `manifest.json`, `manifest.sig`, rolling seals, `*.slog`, `*.slog.meta` | `packages/server/src/services/ingest/strip-bundle.ts:60`      |
| Manifest 2.0 release     | **Not on `main`.** Exists only on this branch.                                     | `git show main:packages/log-core/src/manifest.ts` → no 2.0    |
| Staff composer           | `/compose/manifest`, byte-identical to `tools/sign-manifest.ts`                    | `packages/analyzer/src/views/compose/manifest-composer.ts`    |

Two properties of today's code are load-bearing for what follows.

**`FILE_SCOPE_MAX_ENTRIES` was built for exactly this.** Its docstring says the cap "exists because the field's whole value is that a consumer can read a path's ABSENCE from the list as 'not watched', and an unbounded list inside a single hash-chained entry is not something a future `scope: 'repo'` resolver should be able to produce by accident." The `complete: false` downgrade-to-unknown mechanism it introduces is reused verbatim in §5.

**Additive optional fields on `BundleManifest` need no version bump.** `final?: boolean` was added that way — optional, inside the signature, absence explicitly not a finding. §5 follows that precedent rather than minting a format 1.3.

---

## 2. Decisions taken

**D1. All three lists are course-signed.** They live inside the Manifest 2.0 signed payload. A student cannot declare any of them.

_Why._ `packages/log-core/src/policy.ts` is categorical: the capture policy sits inside the signed payload so "a professor can turn capture down, a student cannot turn it off." An `ignore` list is precisely an off-switch. A student-writable one would be a hole in the integrity story large enough to swallow the product — write the file you intend to plagiarise into `.provenance-ignore` and no evidence is ever produced. The cost is real and accepted: a student who wants their scratch files untracked has to ask staff.

**D2. Three pinned entry forms, no glob engine.** Exact path, trailing-slash directory prefix, leading-`*` suffix. Nothing else.

_Why._ §8.7 declined to answer S25 because a real glob needs three hand-written implementations (TypeScript, Kotlin, Lua) that must agree byte-for-byte, and parent spec §10 is emphatic about that divergence risk. Three forms reduce the matcher to nine lines that a port cannot plausibly get wrong, and pin it with shared vectors (§8). Directory-prefix-only was considered and rejected: it cannot express `*.class` or `*.pyc`, and build artifacts routinely sit beside sources, which is the single most likely thing a course wants to ignore.

**D3. Membership is live, evaluated per path, not snapshotted at session start.**

_Why._ The reason to name a folder is that the file list is not known in advance. A snapshot means a file the student creates ten minutes into a session is invisible for the rest of it — and "I wrote it in a new file" is ordinary, innocent behaviour, so the gap lands on honest students. That is an R2 violation by construction.

**D4. Attachments are hashed into the signed bundle manifest, and their bytes are stripped at ingest.**

_Why._ Recording path + sha256 + size in the signed manifest makes an attachment tamper-evidently attested forever at zero storage cost. Retaining the bytes would reopen what was closed on 2026-07-01 (see `project_cost_model`): unbounded student-authored bytes in permanent storage, against a 1TB hard quota with no headroom. Bytes remain readable in the `/local` drop-a-zip route, which never touches the server. Notably this requires **no change to `strip-bundle.ts`** — attachments are not provenance entries, so the existing allowlist already drops them.

---

## 3. Format — the manifest fields

Two new fields in the Manifest 2.0 signed payload, both **required**:

```json
{
  "format_version": "2.0",
  "course_id": "berkeley-cs61b",
  "assignment_id": "proj2-gitlet",
  "semester": "fa26",
  "issued_at": "2026-09-08T00:00:00Z",
  "files_under_review": ["src/", "Makefile", "*.java"],
  "ignore": ["*.class", "target/"],
  "attachments": ["logs/", "*.log"],
  "collaboration": "solo",
  "submission": "bundle",
  "scope": "directory",
  "policy": { "capture": { "terminal": true, "heartbeat_interval_ms": 30000 } },
  "course_cert": { "course_id": "berkeley-cs61b", "root_sig": "..." }
}
```

Required, not optional, and `[]` is the explicit "I do not use this" spelling. Manifest 2.0 is unreleased (§1), so requiring them costs nothing, and it preserves the property `parseManifestValue`'s docstring names: "Requiring the full set keeps the signed key set fixed, which is what lets the Kotlin and Lua ports canonicalize identically without having to reproduce a 'which optional keys were present' rule."

**The consequence of "required" is worth stating, because it is severe.** A 2.0 manifest missing either key fails `parseManifestValue`, and a manifest that does not parse does not activate a recorder — so a course that hand-edits a manifest and drops `ignore` gets a class that records nothing. This is the correct trade (the alternative is an absent key silently canonicalizing out of the signed payload, so "the chain verified" would stop implying "the course signed a scope"), and it is why §7 puts both fields in the composer and the CLI rather than leaving staff to hand-author them. The failure is loud, immediate, and caught the first time any staff member tests their own manifest.

`buildSignedPayload` adds `ignore` and `attachments` to the 2.0 `canonicalize` call. **The 1.x branch is not touched**, so archived 1.x signatures keep verifying byte-for-byte, as pinned by `manifest.test.ts` ("1.0 signed payload is byte-identical to the pre-2.0 bytes").

### 3.1 The matcher

New module `packages/log-core/src/path-scope.ts`. The entire matching rule:

```
matchesScopeEntry(path, entry):
  entry ends with '/'    -> path startsWith entry
  entry starts with '*'  -> path endsWith entry.slice(1)
  otherwise              -> path === entry
```

`path` is always the workspace-relative path the recorder already uses for `doc.*` payloads, forward-slash separated. Matching is **byte-exact and case-sensitive** — the same rule `files_under_review` follows today, so this introduces no new hazard even though macOS is case-insensitive on disk.

The suffix form matches at any depth: `*.java` matches both `Main.java` and `src/util/Main.java`.

### 3.2 Entry validation

Validation runs at **parse time** and rejects the manifest. A malformed entry is a staff error that should be caught before the manifest is distributed to a class, not a runtime surprise weeks later. `validateScopeEntry` rejects:

- empty, or with leading/trailing whitespace
- any backslash (forward slashes only)
- an absolute path: leading `/`, or a `X:` drive prefix
- any `..` or `.` path segment, or an empty segment (`//`)
- more than one `*`, or a `*` anywhere but index 0
- any of `?`, `[`, `]`, `{`, `}`
- `*` with nothing after it
- `/` with nothing before it

### 3.3 The 1.x rule

**At 1.x the new forms do not exist and are not an error.** An entry ending in `/` at 1.x means a file literally named `src/`, which matches nothing — exactly today's behaviour.

Making it a parse error was considered and rejected. CLAUDE.md's rule is that 1.x parsing never rejects, because archived submissions must validate years later; a rejection here would be a rule that only ever fires on an archived submission. The theoretical ambiguity it would prevent (does `src/` in a 1.x manifest mean a folder?) cannot arise in practice: 1.x manifests are already signed, so no one can add an entry to one.

### 3.4 Precedence

Evaluated per path, in this order, first match wins:

| #   | Rule                 | Effect                                                  |
| --- | -------------------- | ------------------------------------------------------- |
| 1   | **Hard exclude**     | Never tracked, never attached. Not course-controllable. |
| 2   | `ignore`             | Invisible to the recorder entirely.                     |
| 3   | `attachments`        | Sealed into the bundle and hashed. No events.           |
| 4   | `files_under_review` | Tracked.                                                |
| 5   | (no match)           | Untracked and unbundled — today's behaviour.            |

**Rule 1 is new and load-bearing.** The hard-exclude set is `.provenance/` (prefix), `.git/` (prefix), and `.provenance-manifest` / `provenance-manifest` (exact). With exact-path lists this came for free — nobody lists their own provenance directory. With rules it does not: a course writing `ignore: ["*.json"]` would otherwise reach `.provenance/manifest.json`, and `attachments: ["*"]`-shaped mistakes would seal the log directory into itself.

Ordering `ignore` above `attachments` above `files_under_review` makes the obvious combination do the obvious thing: `files_under_review: ["src/"]` with `ignore: ["*.class"]` tracks the sources and never sees the build output.

---

## 4. Recorder behaviour

### 4.1 Live membership

`ExpectedContentRegistry`'s constructor stops taking a path list and starts taking a resolved scope; `isWatched` stops being `Set.has` and becomes a `matchesScopeEntry` evaluation across the precedence chain in §3.4. `doc-wiring.ts`'s gate follows the same seam. A file created mid-session is therefore tracked from its first keystroke.

### 4.2 The editor's glob is only ever a pre-filter

`fs-watcher.ts` builds one `RelativePattern` per entry (`fs-watcher.ts:102`). A directory entry naturally becomes `RelativePattern(root, 'src/**')` and a suffix entry `RelativePattern(root, '**/*.java')`.

**This is where a fourth, fifth and sixth matcher would sneak in.** VS Code's glob engine, JetBrains' and Neovim's are each their own implementation with their own `**` semantics — precisely the divergence §8.7 warns about, arriving through the editors rather than through us. The rule, and it is not negotiable:

> The editor's glob is a **coarse pre-filter only**. Every candidate path is re-checked against `matchesScopeEntry` before any event is emitted. Ours is the only matcher whose answer counts.

A port that widens its watcher pattern is harmless. A port that emits on the watcher's verdict alone is a conformance failure.

### 4.3 The memory bound

`ExpectedContent` holds full file content per tracked path. Today that is bounded by a course hand-listing a handful of files; `src/` removes the bound.

`EXPECTED_CONTENT_MAX_FILES = 512`. When the registry is full and a new path would be admitted, the recorder does not track it — and **must disclose that it did not**. A session that silently stopped watching files it was told to watch is an R2 violation waiting to happen: the analyzer would evaluate the rules, see the file was in scope, see no activity, and draw a wrong conclusion.

Disclosure is `scope_capped?: boolean` on the signed bundle manifest (§5). The seal is the right place because the cap is a whole-session fact only known when the session ends, and it avoids minting a new event kind across three ports.

Like `FILE_SCOPE_MAX_ENTRIES`, the cap is part of the writer contract: **all three recorders must cap at the same number**, or two ports disagree about when a session is capped.

---

## 5. Bundle disclosure

Two additive optional fields, both covered by `signBundleManifest`'s canonicalization, neither a format-version bump (§1):

```ts
// SubmissionFileEntry
role?: 'reviewed' | 'attachment';   // absent reads as 'reviewed'

// BundleManifest
scope_capped?: boolean;             // absent means "this recorder does not report"
```

`role` absent reading as `'reviewed'` keeps every existing 1.1/1.2 bundle's meaning exactly as it is.

### 5.1 `file_scope` needs no new semantics

Its docstring already defines the mechanism this needs: when `complete` is false, "every reader then downgrades absence to _unknown_ rather than to _not watched_."

So: **any non-exact entry in `files_under_review` ⇒ `complete: false`**, with `watched` carrying the enumerable exact-path entries. The field built for `FILE_SCOPE_MAX_ENTRIES` turns out to be the field folder rules need, unchanged.

_Unknown_ is weaker than we can do at 2.0, though, because `session.start` carries the full signed manifest (program spec §5) — so `analysis-core` can run `matchesScopeEntry` itself and answer definitively. Coverage facts therefore get three tiers rather than two:

1. **2.0 manifest present** → evaluate the rules. Definitive.
2. **`file_scope.watched` present and `complete`** → the list answers. Definitive.
3. **Otherwise** → `unknown`, as today.

---

## 6. Analyzer and validation

- **Check 8 skips attachments.** `submittedFileVerdicts` gives `role: 'attachment'` entries their own verdict — hashed and attested, never reconstructed, never compared. See §9.1.
- **The absent-at-seal finding fires only for exact-path entries.** See §9.2.
- **Coverage facts** gain the three-tier resolution in §5.1; `WatchedFileFact`'s verbatim-path join is preserved for tier 2 and bypassed for tier 1.
- **Source tab and `submitted-files.ts`** label attachments distinctly, so a grader is never shown an attachment in a surface that implies event provenance.
- **`strip-bundle.ts` is unchanged.** Attachments are not provenance entries; the existing allowlist drops their bytes at ingest, which is D4's intended behaviour rather than an accident to be corrected.

---

## 7. Staff tooling

### 7.1 The composer (`/compose/manifest`)

- `ComposerForm` gains `readonly ignore` and `readonly attachments`, both `readonly string[]`.
- `splitFilesUnderReview` (`manifest-composer.ts:252`) generalizes to `splitPathList` and serves all three lists — its trim/dedupe/drop-blank behaviour is already exactly right for the new ones.
- `buildUnsignedManifest` (`:391`) emits both at 2.0 and neither at 1.x.
- `validateComposerForm` (`:288`) runs every entry of all three lists through `validateScopeEntry` and reports per-line issues. **This is the highest-value part of the composer work**: an entry the recorder will silently never match is otherwise signed, distributed to a whole class, and diagnosed weeks later.
- Two more textareas in `ManifestComposerView.tsx`, following the existing field pattern.

Explanatory copy follows the register `POLICY_CAPTURE_TOGGLES` established — saying what each list _costs_, not merely what it does. The sentence that must appear, in substance: an `ignore` entry means the recorder produces no evidence for those files, **exculpatory evidence included**.

### 7.2 `tools/sign-manifest.ts`

Updated in the same commit. `tools/manifest-composer-conformance.test.ts` asserts the composer's output is byte-identical to the CLI's, so a one-sided change is a failing test — which is the intended safety property, not an obstacle.

### 7.3 `/architecture`

The manifest, recorder-activation, and ingest-strip nodes each make claims this design changes. Per CLAUDE.md, `tools/architecture/dot/*.dot` and the node detail move in the **same PR**; `nodes.coverage.test.ts` makes a stale page a failing test regardless.

---

## 8. Conformance and testing

- `packages/log-core/src/path-scope.test.ts` at full branch coverage (CLAUDE.md's log-core rule).
- **A shared vector file** — the `(path, entry) → bool` table plus every `validateScopeEntry` rejection — consumed by the TypeScript suite and mirrored into provjet (Kotlin) and provnvim (Lua), following the existing recorder→analyzer seal conformance gate under `tools/`.
- Vectors must include the §4.2 hazard explicitly: paths an editor glob would plausibly admit but `matchesScopeEntry` rejects.
- Regression tests for both §9 surfaces, each failing before its fix.
- Recorder tests for live admission mid-session, the hard-exclude set, and the `EXPECTED_CONTENT_MAX_FILES` cap setting `scope_capped`.

---

## 9. False-accusation review (R2)

Folder rules open two ways to accuse a student who has done nothing. Both are the same shape the 2026-08-20/21 audit found (see `project_false_accusation_audit`), which is why they get their own section.

### 9.1 Every attachment would report as tampered

`submittedFileVerdicts` iterates `bundle.submissionFiles` and compares each entry against reconstruction from the event stream. An attachment has **no event provenance by definition** — that is what makes it an attachment. Ship §3 without §6 and every attachment lands as a mismatch, on a check whose findings are used in academic-integrity proceedings.

_Fix._ Skip `role: 'attachment'` in check 8's comparison; give attachments a distinct verdict meaning "attested by hash, never claimed to be reconstructible."

### 9.2 "Absent on disk at seal time" becomes meaningless

`verify-submitted-code.ts:241` reports a `missing` status as _"File listed in `files_under_review` but absent on disk at seal time."_ That is a true and useful statement about an **exact path**: the course said this file should exist, and it does not.

A folder or suffix rule asserts nothing about any particular file existing. A course writing `*.java` would produce this finding for every `.java` file the student did not happen to write — an unbounded stream of findings against students whose only error was not writing a file nobody asked them to write.

_Fix._ The finding fires only for exact-path entries. A rule-matched path that is absent is not a fact about the student at all.

### 9.3 The residual risk, stated plainly

D1 gives a course the power to `ignore` files, and §7.1's copy is the mitigation but not a guarantee. A course that ignores broadly weakens its own exculpatory evidence — the same failure mode `policy.ts` describes for the retired `inline_content` knob, where stripping content made the system _more_ accusatory. The signed `ignore` list travelling into the bundle is what keeps this adjudicable: the analyzer can always say "no evidence exists for this file **because the course excluded it**," which is a different sentence from "no evidence exists."

Any heuristic that consumes a signal from an ignored path must return `not_applicable` with that reason, per R1. It must never return zero.

---

## 10. Worklist

| #   | Item                                                                     | Est. | Risk                                             |
| --- | ------------------------------------------------------------------------ | ---- | ------------------------------------------------ |
| 1   | `log-core/path-scope.ts` + validation + full-coverage tests              | 0.5d | Low — pure, self-contained                       |
| 2   | Manifest 2.0 fields, `buildSignedPayload`, `parseManifestValue`          | 0.5d | Med — signed payload; 1.x bytes must stay pinned |
| 3   | Shared conformance vectors                                               | 0.5d | Low, but gates ports 8 and 9                     |
| 4   | Recorder: registry, doc-wiring, fs-watcher pre-filter, hard-exclude, cap | 1.5d | **High** — §4.2 is where ports drift             |
| 5   | Seal: attachment collection, `role`, `scope_capped`                      | 0.5d | Med — signed bundle manifest                     |
| 6   | Analyzer: §9.1 and §9.2 fixes + regression tests                         | 1d   | **High** — R2 surfaces                           |
| 7   | Coverage facts three-tier resolution                                     | 0.5d | Med                                              |
| 8   | Composer + `sign-manifest.ts` in lockstep                                | 1d   | Low — conformance test guards it                 |
| 9   | provjet (Kotlin) port against vectors                                    | 1d   | Med                                              |
| 10  | provnvim (Lua) port against vectors                                      | 1d   | Med                                              |
| 11  | `/architecture` diagrams + node detail                                   | 0.5d | Low — but a failing test if skipped              |

Items 1–3 are the critical path; 4–8 can proceed in parallel once vectors exist; 9–10 are separate repos.

---

## 11. What this design does not do

- **No glob engine.** No `**`, no `?`, no character classes, no negation, no brace expansion. If a course needs those, the answer is more entries.
- **No student-side list of any kind.** D1.
- **No retained attachment bytes on the server.** D4. If graders need to read log files, that is a separate decision with a quota conversation attached.
- **No `scope: 'repo'` git-tracked enumeration.** S25 is answered by rules, not by shelling out to git. The `scope` field keeps its current meaning.
- **No change to `policy`.** Path scope and capture policy stay separate; `policy.capture` remains keyed by event kind and governed by the floor doctrine.
- **No new event kind.** The cap is disclosed at seal time precisely to avoid one.
