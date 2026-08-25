# Provenance — manual test guide

Every flow a human must exercise by hand, because no automated suite can cover it.

**Scope.** This is the companion to the test suites, not a summary of them. If a check here is
already covered by Vitest, it is listed only because the automated version tests a _seam_ and the
manual version tests the _real thing_ — a real IDE, a real OS, a real Google tenant, a real
Gradescope.

**How to use it.** Work top to bottom the first time; the sections build on each other (you cannot
test enrollment without an institution key, or ingest without a recording). After that, use the
per-section checklists as regression passes.

**Conventions.**

- ✅ = what you should see. ❌ = the failure and what it means.
- **UNVERIFIED** marks a step nobody has ever executed. Those are the ones most likely to be wrong.
- A ⚠️ block is a trap with a known history — someone already lost time to it.

---

> **For the 2026-08-21 changes**, run
> [`manual-test-guide-2026-08-21.md`](manual-test-guide-2026-08-21.md) alongside this guide. It covers
> the false-accusation fixes, group-work surfaces, capability reports and operator changes from
> that date, and is weighted toward checks that a green automated suite cannot make.

## 0. Before anything

```sh
cd ~/projects/provenance
npm ci
npm run build          # REQUIRED before typecheck, dev servers, or the sibling e2e gates
```

⚠️ **`npm run build` before `npm run typecheck`, always.** A stale `dist/` produces phantom errors
in downstream packages that look like real type failures. The root `build` script orders
`log-core → shared → analysis-core` explicitly because `--workspaces` iterates alphabetically and
`analysis-core` would otherwise build first — that once made `npm run build` fail on a clean
checkout.

⚠️ **Check your shell's working directory before trusting any verification run.** A `cd` into
`packages/server` that persisted once made `build`, `typecheck` and `lint` all report a false
clean. Empty test output is the tell.

**Docker health.** Several sections need it.

```sh
docker run --rm hello-world    # the ONLY reliable health check
```

⚠️ Do **not** use `docker info` — it can hang past 120 s against a half-wedged daemon while
`docker ps` still returns. A wedged daemon once produced 29 red server tests that were not real
failures: the error text was `(HTTP code 500) server error` and 120 s timeouts, which is
testcontainers talking to the daemon, **not** the HTTP server returning 500.

---

## 1. Course staff — one-time setup

### 1.1 Root keypair

There is no dedicated root-keygen tool; the course-keypair generator produces the same shape.

```sh
npm run keygen:course -- /Volumes/SECURE/root-keypair.json
```

- ✅ 64-hex public key on stdout; a `0600` JSON file with `public_key_hex`, `private_key_hex`,
  `generated_at`, `note`.
- ✅ Refuses to overwrite an existing file, and refuses to write inside the repo.

Keep this offline. It is the anchor of every trust chain in the system.

### 1.2 Course keypair + certificate

```sh
npm run keygen:course -- /Volumes/SECURE/cs61a-fa26.json \
  --course-id berkeley-cs61a --valid-from 2026-08-20 --valid-until 2027-01-15 \
  --root-keypair /Volumes/SECURE/root-keypair.json \
  --cert-out /Volumes/SECURE/cs61a-fa26.cert.json
```

- ✅ The certificate is **self-verified against the root public key before being written**. A tool
  run that writes a cert failing its own check is the failure this guards against.

**Do by hand:** flip one hex character in the cert's `root_sig`, then try to sign a manifest with
it. ✅ `tools/sign-manifest.ts` must refuse.

### 1.3 Institution keypair + certificate

Do this while you still have the root key out — it is the other branch of the same chain, and
skipping it is silent until §2.2, where **every** enrollment fails.

⚠️ **Without this, `/enroll` returns `503 CREDENTIAL_UNAVAILABLE` /
`reason: "no_institution_key"` forever, and no student on the deployment can obtain a
credential.** Nothing else in §1 surfaces the omission: the recorder builds, the manifest signs,
ingest works. §2.2 is where it lands.

One institution key per **deployment**, not per course. Two machines:

```sh
# on the API server — positional path only; --course-id would mint the wrong artifact
npm run keygen:course -- /secure/institution-keypair.json

# on the offline root machine, carrying only the 64-hex PUBLIC key across
npm run mint:institution-cert -- \
  --institution-id berkeley --institution-pubkey <64-hex from the step above> \
  --valid-from 2026-08-20 --valid-until 2027-08-19 \
  --root-keypair /Volumes/SECURE/root-keypair.json \
  --out /Volumes/SECURE/berkeley-institution.cert.json
```

- ✅ The certificate is **self-verified against the root public key before being printed or
  written**, same guarantee as §1.2.
- ✅ Re-running with the same `--out` **refuses**, rather than replacing a certificate that may
  still pair with a live key.
- ✅ Nothing secret reaches stdout — only the certificate, which is public and travels inside
  bundles.
- ❌ Omitting `--root-keypair` silently uses the **dev** root at `.notes/dev-root-keypair.json`.
  A production cert minted that way verifies against nothing a production recorder embeds.

Then, on the server, splice both halves into one variable and restart the API:

```sh
PROVENANCE_INSTITUTION_KEY='{"private_key_hex":"<64 hex from the keypair file>","cert":<the cert JSON>}'
```

**Do by hand:** boot the API with the variable **malformed** (drop a character from
`private_key_hex`). ✅ It must fail loudly at startup, not degrade to "enrollment closed" — the
distinction is the whole point of `config/institution-keys.ts`. ✅ The error names the offending
**field** and never echoes a value.

### 1.4 Manifest authoring — both paths, and they must agree

**CLI:**

```sh
PROVENANCE_COURSE_KEYPAIR_PATH=/Volumes/SECURE/cs61a-fa26.json \
PROVENANCE_COURSE_CERT_PATH=/Volumes/SECURE/cs61a-fa26.cert.json \
  npm run sign:manifest -- /path/to/starter/.provenance-manifest
```

- ✅ Signs, staples `course_cert` inline, then walks the **full chain** (root → cert → manifest)
  before writing anything.
- ❌ `keypair does not match the certificate` — the keypair and cert are from different runs.
- ⚠️ `course_id` in the manifest must **equal** `course_id` inside the certificate, or the manifest
  fails its own chain check.

**Browser composer** at `/compose/manifest` (staff-gated):

Fill the form → file-pick the course keypair JSON → file-pick the course cert JSON → Sign →
Download.

**Do by hand, with DevTools open:** watch the Network tab and the Application tab (Local Storage,
Session Storage, IndexedDB, Cookies) while signing.

- ✅ The private key hex reaches **no** request, no storage, no cookie, no DOM node, and no
  produced blob. There is an automated leak test, but a human should confirm it visually — this is
  the course signing key.
- ✅ Pasting a keypair file into the cert slot is refused before anything else happens.

**The byte-identity check.** Compose the same manifest both ways and compare:

```sh
cmp cli-signed.manifest browser-signed.manifest
```

✅ Byte-identical. There is a conformance gate for this, but it uses its own fixtures — this
exercises your real inputs.

### 1.5 Production recorder build

```sh
PROVENANCE_ROOT_PUBLIC_KEY_HEX=<real root public key> \
  npm run build:prod --workspace packages/recorder
```

- ✅ A `.vsix` at `packages/recorder/provenance-recorder-<version>.vsix`.
- ✅ **`git status` is clean afterwards** — the script restores the two embedded-key source files.
  Check this; a dirty tree here means a dev key could be committed.
- ❌ Refuses (exit 1) when the variable is unset, malformed, or **equal to the dev root key**.

⚠️ Setting `PROVENANCE_LEGACY_COURSE_PUBLIC_KEY_HEX` (for Manifest 1.x activation) **changes the
built bytes and therefore the `extension_hash`**. A two-variant release needs
`npm run update-hashes` run once per variant, or one variant's submissions all trip
`extension_hash_mismatch`.

### 1.6 The extension-hash allowlist

```sh
npm run update-hashes -- --root-keypair /Volumes/SECURE/root-keypair.json
```

⚠️ The script hashes the **bundled** `dist/` (a single `extension.js` + sourcemap), not a `tsc`
dev-install `dist/` (many `.js`/`.d.ts`). A dev-install hash never appears in a real submission.

For the sibling recorders, compute and add manually:

```sh
# provjet
./gradlew :recorder:computeExtensionHash
# provnvim, from a clean checkout at the release TAG
nvim --headless -c "lua print(require('provenance.recorder.commands.extension_hash').compute_installed())" -c qa

npm run update-hashes -- --hash <hex>
```

⚠️ **provnvim's `extension_hash` is a tree hash of the installed `lua/` source.** A tag that is
later moved or force-pushed silently invalidates the allowlist entry.

**Failure mode if stale:** every submission from the new build trips `extension_hash_mismatch`.
That is a heuristic flag, not a validation failure — the bundle still validates.

### 1.7 Semester and assignment setup

`filename_convention` and `blob_retention_days` **are settable from the UI** — create a semester at
`/admin/courses/:courseId/semesters` (superadmin), edit at `/s/:course/:semester/settings`.

**The ingest scope default is API-only.** There is no UI control anywhere:

```sh
curl -s -X PATCH $BASE/api/v1/semesters/$SEM/assignments/$ASSIGNMENT_UUID \
  -H 'Content-Type: application/json' -H "Authorization: Bearer $TOKEN" \
  -d '{"ingest_scope":{"mode":"repo_scoped","path_glob":"proj2/**","on_multiple":"error"}}'
```

| mode                           | meaning                                                    | fails when                     |
| ------------------------------ | ---------------------------------------------------------- | ------------------------------ |
| `self_identifying` _(default)_ | accept every sealed scope, wherever, however many          | never asserts                  |
| `bundle_zip`                   | classic sealed `.zip`: exactly one scope, at the tree root | a nested `.provenance/` exists |
| `repo_whole`                   | git repo as ONE scope at repo root; nested scopes excluded | no root scope                  |
| `repo_scoped`                  | `path_glob` selects the scope(s); **`path_glob` REQUIRED** | the glob selects nothing       |

**Do by hand:**

- ✅ `path_glob` is **required** iff `repo_scoped`, and **rejected** on every other mode.
- ✅ `on_multiple` is deliberately **required, not defaulted** — omitting it is a 400.
- ✅ `mode: 'path'` (the pre-2026-08 spelling) is **rejected by the API** but still read out of
  storage as `repo_scoped` for rows written before migration 0026.

---

## 2. The student path, end to end

⚠️ **This whole section is the one nobody has walked start to finish.** Every gate so far tests a
slice. Expect surprises here more than anywhere else in this document.

### 2.1 Install

| recorder      | install                                                           | confirm it is active                                     |
| ------------- | ----------------------------------------------------------------- | -------------------------------------------------------- |
| **VS Code**   | `ext install itsgeagle.provenance-recorder`, or Install from VSIX | status bar reads `Provenance: recording`                 |
| **JetBrains** | Settings → Plugins → Marketplace → "Provenance Recorder"          | `Provenance: recording` status-bar widget                |
| **Neovim**    | plugin manager, **pinned to a release tag**                       | wire the statusline yourself (below), or `:lua` the call |

VS Code requires ≥ 1.100 (the VSIX is ESM). JetBrains requires JDK 17 and IDE build ≥ 261.
Neovim requires ≥ 0.10, no native deps.

```lua
-- provnvim: nothing is visible out of the box until you add this
vim.opt.statusline:append("%{%v:lua.require'provenance.recorder.status'.segment()%}")
-- or check once:
:lua =require('provenance.recorder.status').segment()   --> ● Provenance: recording
```

⚠️ **`lazy = false` is not optional for provnvim.** LazyVim and derived configs set
`defaults.lazy = true`, which defers the plugin — the activation autocmds never register and
**nothing is recorded while the plugin still appears installed**. Same hazard for packer
`opt/cmd/ft/event`, vim-plug `{'on':…}/{'for':…}`, and `MiniDeps.later()`.

```lua
{ "ProvenanceTools/provenance-neovim-recorder", version = "v0.2.0", lazy = false }
```

### 2.2 Enrollment

All three recorders use the **same command names**:

- `Provenance: Show My Enrollment Key`
- `Provenance: Import Enrollment Token`
- `Provenance: Export Student Identity Secret` / `Import Student Identity Secret`

(Neovim: `:ProvenanceEnrollment`, `:ProvenanceEnrollmentImport`, `:ProvenanceIdentityExport`,
`:ProvenanceIdentityImport`.)

**Flow:** run "Show My Enrollment Key" → browse to `/enroll` → sign in with Google → paste the
public key → copy the returned credential back into the editor with "Import Enrollment Token".

`/enroll` is a **static URL** — no course, no semester, no assignment. It is `RequireAuth` only, so
a student with no memberships reaches it.

**Do by hand:**

- ✅ A returning student sees copy driven by `machine_count` and `key_first_issued` — **never** a
  duplicate-enrollment warning.
- ✅ Truncate the pasted key by one character → rejected **locally**, before a request is spent.
- ✅ Mangle the returned credential JSON → the recorder offers to re-check it with the same
  parsers it uses internally.
- ❌ No institution key configured → **503 `CREDENTIAL_UNAVAILABLE`, `reason: "no_institution_key"`**.
  If this is what you get for _every_ student, §1.3 was skipped — that is the expected symptom.
- ❌ Cert lapsed → same 503, `reason: "cert_out_of_window"`.
- ❌ Personal Gmail → `HOSTED_DOMAIN_MISMATCH`.
- ❌ An API token instead of a session → 403.

#### ⚠️ The master-secret paste hazard — test all three steps

A master secret and a public key are **both 64 lowercase hex**. A student could paste the wrong one
and ship their signing identity to the server. This was a live bug.

1. Run "Export Student Identity Secret". ✅ The export carries a `provenance-secret-v1:` marker.
2. Paste that **whole export** into `/enroll`'s key field. ✅ Refused — the marker and the
   surrounding prose are both recognised.
3. **Now strip the marker by hand and paste only the bare 64 hex.** This is the residual hole: the
   server **cannot** tell it apart. ✅ Confirm the warning beside the input is present and legible.
   That warning is the only defence, so its wording is the control.

### 2.3 Second machine — a first-class flow, not a secret copy

1. Install on machine B, run "Show My Enrollment Key". ✅ A **different** public key.
2. `/enroll` on B, same Google account, paste B's key.
3. ✅ Same `student_ref`, fresh credential, `machine_count` increments, copy reads as "you added a
   machine".
4. Record a session on A and one on B against the same assignment.
5. ✅ In the analyzer both resolve to **one contributor**, not two.
6. ✅ **No high-severity `multiple_sessions_overlap` flag** for overlapping sessions across the two
   machines. Suppression keys on `student_pubkey` (per machine), not `session_pubkey` (per session
   and ephemeral — keying on that would suppress a single machine's overlaps too).
7. ✅ Overlapping sessions on **one** machine are still flagged at **high / 0.95** — that is the
   case the heuristic exists for.

**The anti-test:** ✅ the on-screen copy calls export/import a **backup** and does **not** recommend
it for a second machine. Telling a student to hand-carry the one value that can sign as them is a
real harm dressed up as a tip.

### 2.4 Recording

**Activation.** VS Code activates on `workspaceContains:**/.provenance-manifest` (both filename
spellings supported). Discovery globs **under** the opened workspace folder(s).

- ✅ Opening a **parent** folder containing `hw03/.provenance-manifest` **activates**.
- ✅ Opening a **subfolder** of the assignment does **not** activate.
- ✅ Two assignment roots under one workspace → **both activate independently**, each with its own
  `.provenance/` and its own `.slog`.
- ✅ One valid manifest + one signature-flipped manifest side by side → the bad one is skipped
  informationally and **must not block** the good one.
- ✅ provnvim discovers _upward_ from the buffer: `nvim ~` then `:e ~/course/hw03/f.py` activates.
  This is a real behavioural difference between the recorders.
- ✅ `:cd` away does **not** stop a provnvim session (lifetime is the editor process).

**Seal picker**, with two assignments active:

- VS Code: `Provenance: Prepare Submission Bundle` → quick pick, the one under the focused editor
  pre-highlighted.
- Neovim: `:ProvenanceSeal` → `vim.ui.select`; `:ProvenanceSeal <assignment_id>` skips the picker;
  a single active assignment seals with no prompt.
- JetBrains: Tools → Provenance: Prepare Submission Bundle → popup. **UNVERIFIED.**

### 2.5 Git submission

Precondition: the manifest declares `"submission": "git"`.

**Nothing ever runs `seal`.** The student pushes; the grader clones; **whatever is in
`.provenance/` on disk IS the submission.**

1. `git init` an assignment workspace with a `submission: git` manifest; open it; edit; save.
2. `ls -la .provenance/`
   - ✅ `session-<uuid>.slog`, `session-<uuid>.slog.meta`, `manifest-<session_id>.json`,
     `manifest-<session_id>.json.sig`
   - ✅ **A `.gitattributes`** (see 2.6 — this is what stops git corrupting the logs).
3. ✅ **Confirm the two uuids differ** — the `.slog` filename uuid and the logical `session.start`
   id are minted independently. A maximum-severity false accusation once survived 972 green tests
   because every fixture spelled them the same value.
4. `git add .provenance/ && git commit && git push`.
5. **Kill the editor mid-session** (no clean dispose), then ingest.
   - ✅ `log_bytes_match` does **not** fail. A non-final rolling seal commits to a **prefix**;
     treating it as whole-file equality was the same false accusation reached three separate ways.

**Per-session filenames are load-bearing.** Two partners write into one `.provenance/`; a single
shared `manifest.json` would conflict on every merge — two signed blobs at one path, unresolvable
without destroying a signature. Per-session names make the directory add-only.

### 2.6 ⚠️ Line endings — the Windows killer

Git treats `.slog` as text unless told otherwise. Under **`core.autocrlf=true` — the Git for
Windows installer default** — the working-tree bytes become CRLF while the sealed digest was over
LF. The chain still verifies and the manifest still verifies, so **only the byte check fails**,
which makes it read as deliberate tampering.

**Do by hand on Windows:**

```sh
git config core.autocrlf          # true is the installer default
cat .provenance/.gitattributes    # must mark the log artifacts binary/-text
git add .provenance/ && git commit && git push
```

- ✅ Clone fresh on another machine, ingest, and `log_bytes_match` **passes**.
- ❌ If it fails at high severity with _"not recoverable from a benign cause"_, the `.gitattributes`
  is missing or not being honoured — that is this bug, not a student.

**Also test a repo that already has `* text=auto` at its root**, since attribute specificity
decides which wins.

### 2.7 Honest-behaviour cases that were once false accusations

Each of these was a real maximum-severity accusation against an innocent student. Re-test them.

| do this                                                                                     | ✅ expected                                                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Crash-recovery leftover: a stranded `.slog.meta` in a committed `.provenance/`              | Artifact **dropped from the analysis** and reported in Coverage; the whole bundle must not fail        |
| Keep a copy of your own `.provenance/` (two `.slog` files, one logical session id)          | An `ambiguous_session_log` fact; **not** "Manifest signature verification failed"; content not doubled |
| Partial push: commit `manifest-<id>.json`, let `.gitignore` catch the `.slog`               | Check 1 still fails, **but the text names the innocent reading** and says what would settle it         |
| Run "Prepare Submission Bundle" once, keep working, push (a stale classic manifest is left) | `log_bytes_match` must **not** fail                                                                    |
| Power cut mid-write → a torn trailing line in `.slog`                                       | Truncated to the last complete entry and the session **kept**; the torn tail is reported as a fact     |
| Two partners, corrupt one byte of partner B's `.slog` in A's tree, restart A's editor       | **B's file is untouched** — no quarantine, no rename                                                   |
| Repo root **above** the assignment folder (the standard 61B layout), commit                 | `git.event` entries land (this was dark for the whole standard layout once)                            |
| OS sleep / suspend for an hour mid-session                                                  | No `gap_in_heartbeats` flag                                                                            |
| Shallow clone (`git clone --depth 1`)                                                       | Discriminator omitted; **no defect, no finding**                                                       |
| `git` not on the editor's inherited PATH                                                    | Field omitted silently; session otherwise unaffected                                                   |

### 2.8 Group / shared-repo work

Two students, both enrolled, both recording, one repo, `collaboration: "group"`,
`submission: "git"`. Both edit, commit, push, and pull each other's work. Ingest once.

- ✅ **One `submissions` row with two contributors** — not the pre-0029 fan-out. On the Gradescope
  co-submitter path the shared row's `student_id` is **non-null** (whichever partner's file was
  processed first) and `group_key` is NULL; the nullable-student/`group_key` shape belongs to the
  git-repo group path. Both people appear in `submission_contributors`.
- ✅ The second co-submitter's `ingest_files` row is **`duplicate`**, not `matched`, and still
  carries its own `matched_student_id` and a `submission_id` pointing at the shared submission.
  `duplicate` here means "the ARTIFACT is a duplicate", never "the person was dropped".
- ✅ A flag earned by one partner is **not charged to the other**.
- ✅ **No `paste_shared_across_students`** between the two partners. A shared `.provenance/` is
  add-only, so each partner's paste events are physically in the other's bundle — this fired on
  every honest pair at high severity.
- ✅ Excluded pairs are **visibly** excluded, not silently dropped: `/local/compare` shows a
  **"Not cross-compared"** panel naming each lineage, how many comparisons it withheld, and the
  commit keys that proved it. **Known gap:** that register is browser-side only — the server-backed
  cross-flags view gets the suppression but not the explanation, because nothing persists it.
- ✅ **No high-severity `multiple_sessions_overlap`** for ordinary concurrent work.
- ✅ Solo submissions are unchanged: one contributor is charged everything, so their total equals
  the scope score exactly.

**Known gap, documented, not a bug:** two **unenrolled** partners in one repo cannot be told apart.
No signal exists. Do not report it as new.

**Accepted cost (D16):** an honest pair whose partner simply was not recording gets
`git_unrecorded_in`. ✅ Read the text — it must assert no authorship, name the unenrolled-partner
reading alongside the guilty one, and say that confirming enrolment is what distinguishes them.

---

## 3. Server and operator

### 3.1 Bring-up

```sh
docker compose up -d
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker compose exec minio mc mb local/provenance      # uploads 404 without this
cp packages/server/.env.example packages/server/.env
npm run db:migrate --workspace=packages/server
npm run dev --workspace=packages/server               # API + worker in one process
npm run dev --workspace=packages/analyzer             # :5173
```

- ✅ `GET /api/v1/health` → `{"status":"ok"}`; docs at `/api/v1/docs`.

⚠️ Run modes are **`api` | `worker` | `all` only**. There is no `--mode=migrate`; use
`npm run db:migrate`.

⚠️ `GET /metrics` returns **403 in every environment** when `METRICS_AUTH_TOKEN` is unset.

### 3.2 Migrations — fresh and already-migrated are different tests

```sh
# fresh
docker compose down -v && docker compose up -d
docker compose exec minio mc alias set local http://localhost:9000 minioadmin minioadmin
docker compose exec minio mc mb local/provenance
npm run db:migrate --workspace=packages/server
```

Then assert the journal has **unique, contiguous, ascending `idx` and monotonic `when`**.

⚠️ Two agents once both took migration `0026`. Git merges the `.sql` files silently because the
filenames differ; the only signal was a conflict in `_journal.json`. Two migrations sharing an
index apply in **undefined order** — which works on an already-migrated database and **corrupts a
fresh deploy**.

**On an already-migrated database**, assert:

- `version_owner_key` exists, is `GENERATED ALWAYS`, and Postgres **refuses** an explicit write
  (`cannot insert a non-DEFAULT value`).
- Both lineage sources NULL → rejected by NOT NULL.
- Solo duplicates still collide; two different groups at version 1 coexist; the same group twice
  does not.
- `submissions_version_key` really is that name now — it never was before 0029.

### 3.3 Ingest — all three entry points

The override's **shape follows the route's body, not the route**.

```sh
# 1. multipart, flat query params
curl -X POST -H "Authorization: Bearer $TOKEN" -F "archive=@repo.zip" \
  "$BASE/semesters/$SEM/ingest?scope_mode=repo_scoped&scope_path_glob=proj2/**&scope_on_multiple=error"

# 2. Gradescope export, same flat params
curl -X POST -H "Authorization: Bearer $TOKEN" -F "archive=@export.zip" \
  "$BASE/semesters/$SEM/ingest:gradescope?scope_mode=repo_whole&scope_on_multiple=ingest_all"

# 3. resumable: create → parts → complete (JSON, nested object)
#    POST .../ingest/uploads/:id/complete  {"s3_upload_id":"…","ingest_scope":{…}}
```

**Do by hand:**

- ✅ Supplying only `scope_path_glob` without `scope_mode` is a validation error.
- ✅ A **git repo zip** through route 1 no longer falls through to `single-zip` and stages the whole
  repo as one malformed bundle without erroring. This was the outlier route and it was an oversight.
- ✅ A **sealed flat bundle** through any route stages the **exact bytes uploaded** — its
  `blob_sha256` (the dedup key) is unchanged by construction.
- ✅ Route 1's inline `skipped` is `[]` for a clean batch — **not** `null`.
- ✅ Route 3's `/complete` returns 202 with **`"skipped": null`**, meaning _unknown, poll again_ —
  never "clean". Collapsing `null` and `[]` is how a heterogeneous batch once reported as clean.
- ✅ When every scope is rejected the job is marked `failed`, not left `queued`.

**Concurrency — reproduce the fan-out defect:**

```sh
INGEST_CONCURRENCY=8 npm run dev --workspace=packages/server
```

Ingest a group export where two co-submitters carry **byte-identical** bundles.

- ✅ **One** submission with two contributors, not two submissions.

⚠️ Serial execution looked perfect here; only concurrency reinstated the fan-out. Two co-submitters
both cleared dedup before either committed.

### 3.4 Pagination — every list, past page 1

⚠️ Keyset pagination silently dropped **and re-served** rows whenever rows shared a millisecond,
which is the normal case for batch-written rows. Nothing reported a short page.

For **cross-flags**, the **cohort list sorted by `ingested_desc`**, and the **unmatched tray**:

1. Ingest a batch large enough to need several pages.
2. Page through to exhaustion at a small `limit`.
3. ✅ Every row appears **exactly once**. Count distinct ids and compare to the total.
4. ✅ A cursor from an older client version is **rejected with 400**, not silently mis-paginated.
   Cursors carry full microsecond precision and compare by row-value; a pre-fix millisecond cursor
   is refused rather than treated as a bucket floor.
5. ⚠️ **Migration `0030` must be applied**, or all three of these list queries fall back to a
   sequential scan plus a sort. It adds the keyset indexes, which did not previously exist.

Also: ✅ the cohort list's `student_asc` sort reaches **every page**, including in **protected
mode** — a keyset predicate on a NULL column is never true, which makes those rows unreachable
after page 1.

### 3.5 Retention, purge, quota

```sql
SELECT name, cron FROM pgboss.schedule ORDER BY name;
```

✅ **Five** rows: `retention_sweep`, `purge_expired_sessions`, `purge_expired_exports`,
`reap_stale_uploads`, `storage_quota_check`.

Trigger one by hand:

```sql
INSERT INTO pgboss.job (name, data) VALUES ('retention_sweep', '{}');
```

After a sweep: ✅ flags, per-file stats, validation results and cross-flags **persist**; replay and
recompute become unavailable and **degrade gracefully rather than erroring**. DB rows are never
deleted — only blobs.

### 3.6 OAuth

Requires a real Google tenant; nothing automated covers any of it.

- ✅ In-domain account → in.
- ❌ Personal Gmail → `HOSTED_DOMAIN_MISMATCH`.
- ✅ In-domain non-superadmin → `/home`, no memberships.
- ✅ Superadmin (email in `AUTH_SUPERADMIN_EMAILS`) → `/admin` reachable.
- ✅ Session cookie is `__Host-` prefixed in production.

### 3.7 provgate (Gradescope gateway)

```sh
uv sync
export PROVGATE_SECRET_KEY="$(uv run provgate keygen)"
uv run provgate class add --label cs61a-fa26 --gradescope-course 180852 …
uv run provgate doctor --class cs61a-fa26
uv run provgate sync --all --dry-run
```

⚠️ **The Gradescope selectors are provisional and need live validation.** Gradescope's HTML and
endpoints are undocumented. The default `uv run pytest` **excludes** the live suite and runs
against captured fixtures — so if the selectors have drifted, the fixture-pinned tests stay green
while production is broken.

**Treat a green `uv run pytest` as evidence of nothing about Gradescope.** A human with real
credentials must run:

```sh
uv run pytest -m live
```

Requires a **Gradescope-native** staff account — email + password, **no SSO, no 2FA** — as
instructor or TA on the course.

---

## 4. Analyzer UI

### 4.1 Route guards

- ✅ `/` and `/architecture` load **signed out**.
- ✅ A student session (no memberships) reaches `/enroll`, and is **bounced** from
  `/compose/manifest` and `/local/*` to `/home`.
- ✅ A non-superadmin staff session is bounced from `/admin/*`.

### 4.2 Submission tabs

`?tab=overview|timeline|replay|validation|export|source`

- ✅ **Export is a v3.1 stub** — static copy, nothing to click. Confirming that is the test.
- ✅ The working findings export (markdown **and** PDF) exists only under `/local`. Generate both
  and **open them** — check the PDF contains real screenshots, not blanks.
- ✅ Replay locks to the viewport; the other tabs scroll.
- ✅ A **group** submission's detail page renders — it used to 404 the whole shell when no single
  student owned it.
- ✅ A two-party cross flag renders **two** participants — one used to be silently dropped, and an
  empty list reads as "no participants" rather than "we lost them".

### 4.3 Coverage panel ("Recording coverage")

Mounted **above the verdict surfaces** on both overview surfaces, not in a tab, not collapsed.

Three states, and none of them is "render nothing":

1. ✅ **No facts** → says they were **not fetched**. Must **never** render zeroes — a zeroed panel
   asserts "no commits observed, no contributors, no root key", which is stronger and false.
2. ✅ **Nothing to note** → says so, neutral palette.
3. ✅ **Facts** → the sections.

Wording rules, each of which has cost a false accusation:

- ✅ `unverifiable` is **never summed** with `unattributed`.
- ✅ With no root key configured, the word **"failed" must not appear** — "cannot check" ≠ "failed".
- ✅ Absence is never suspicious.
- ✅ Slate `role="status"` palette — **not** the amber/red flag vocabulary, no warning icons.
- ✅ The repository-discriminator caveat appears for a **mixed** scope (one partner labelling, one
  not), not only when nothing is labelled.

### 4.4 Tuning UI

- ✅ **29 rows** (18 event-stream + 9 validation-derived + 2 cross-submission).
- ✅ The two cross-submission ids show a **disabled weight slider** and a **working toggle** —
  cross flags feed no score.
- ✅ Slider drag debounces before firing a dry run.
- ✅ Refresh mid-recompute **resumes** (tracked in `?recompute_job=`), not lost.
- ✅ Commit from two browser tabs → **409 `CONFIG_VERSION_CONFLICT`**, toast, offer to reload.

### 4.5 `/local`

- ✅ Drop a `.zip`; everything runs in-browser.
- ✅ With `VITE_ROOT_PUBLIC_KEY_HEX` unset, a 2.0 bundle reports check 2 as **`skipped`** — never a
  false pass.
- ✅ `/local/compare` needs **two or more** bundles and is the only place cross-submission
  heuristics run.

---

## 5. Cross-platform — the least-covered risk

⚠️ **All testing to date is macOS.** The git-path resolution is pinned only against inputs
_believed_ to be Windows- and Linux-shaped, through an injectable seam. The parsing is pinned; the
platform behaviour of the spawn itself is not.

### 5.1 Windows

| test                                                                                         | ✅ expected                                                             |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Install git **off** `PATH`; launch VS Code from the Start menu (not a shell); set `git.path` | The discriminator still lands                                           |
| `"git.path": "C:\\Program Files\\Git\\cmd\\git.exe"` (a string)                              | Works — the space needs no quoting under argv                           |
| `"git.path": ["C:\\nope\\git.exe", "C:\\Program Files\\Git\\cmd\\git.exe"]` (an **array**)   | Tries entries in order                                                  |
| `"git.path": ["", 123, "C:\\…\\git.exe"]`                                                    | Junk entries dropped, **not fatal**                                     |
| A full (non-shallow) repo                                                                    | `root_commit_sha` is 40 or 64 **lowercase hex**, no `\r`, not truncated |
| `git.path` → a `.cmd`/`.bat` shim (Scoop/Chocolatey)                                         | Field **omitted silently**; session otherwise unaffected                |
| Candidate 1 hangs (a script sleeping 30 s)                                                   | Activation delayed **~5 s, not ~15 s** — a timeout must not ladder      |
| `core.autocrlf=true` end to end (see 2.6)                                                    | `log_bytes_match` passes                                                |
| Atomic write-temp-then-rename over an existing file                                          | No partial writes                                                       |
| UNC paths, drive letters, path separators in discovery and `.provenance/` writes             | All handled                                                             |

⚠️ **CRLF is the one that silently kills a whole platform.** `'false\r\n' !== 'false'` makes every
repository look shallow, and a `\r`-suffixed sha is not lowercase hex so it is rejected. Neither
produces an error — they produce a platform that quietly omits the field.

### 5.2 Linux

Run the full recorder suite natively:

```sh
npm run test --workspace=packages/recorder     # NEVER --root packages/recorder
```

⚠️ `--root` bypasses package config: the recorder loses its `vscode` alias and 4 suites fail to
import. It looks like a real failure and is not.

### 5.3 Real IDE smoke (provjet / provnvim)

Neither can be covered headless. Both repos carry their own `docs/manual-verification.md`; work
through them. The highest-value unchecked items:

**provjet** (`./gradlew :recorder:runIde`):

- Seal chooser popup with two sibling manifests — `JBPopupFactory` cannot be driven by test utils.
- Frame-activation refresh: alt-tab away, edit externally, alt-tab back → `fs.external_change`
  within seconds with **no manual "Reload from disk"**.
- Native watcher **while focused** — IntelliJ's VFS is a cached layer and an external-terminal
  `git pull` fires nothing until a refresh.
- `isFromSave()` tags every real editor save, **across all target IDE versions**.
- Status-bar widget appears (headless has no `IdeFrame`).
- The seal produces a real `extension_hash` — under test the plugin descriptor is null and CI stubs
  it, so **if this breaks, every student's seal fails**.

**provnvim:**

- Tampered signature (flip one hex char in `sig`) → indicator absent.
- Focus-gain reload emits **exactly one** `fs.external_change`, not a `doc.change`, not doubled.
- A normal `:w` produces `doc.save` + `doc.change`, **never** `fs.external_change`.
- Typing a >30-char line is **not** flagged as paste (`source="typed"`, one char per delta).
- `git merge --no-ff` → two parents with **`parents[0]` = the tip of the branch you merged INTO**.
  The order is meaning; nothing may sort it.
- First commit of a fresh repo → `parents` is `[]`, an empty JSON array, **not `{}`, not absent**.
- `git checkout --detach` → `branch` **absent**, never `"HEAD"`, never `""`.
- **Unborn branch** (`git init`, no commits) → no `sha`, no `parents`. "Could not read the parents"
  must never be recorded as `[]`.
- **No git installed → the session still works.**

#### ⚠️ IRB — `git.event` must carry no author identity

Set a distinctive `user.name` and `user.email`, commit, then grep the **whole `.slog`** for both.

✅ Neither may appear, nor an author date, nor the commit message.

This is a protocol commitment under CPHS 2026-06-19796. A new category of identifier requires a
filed CPHS modification **before** implementation.

### 5.4 Cross-implementation gates

```sh
npm ci && npm run build          # in the monorepo FIRST

# provnvim
PROVENANCE_MONOREPO=~/projects/provenance scripts/e2e/run_e2e.sh
# provjet
PROVENANCE_MONOREPO=~/projects/provenance scripts/e2e/run_e2e.sh
```

⚠️ **provjet's gate SKIPS WITH EXIT 0** when the monorepo or node is unavailable, printing
_"Skipping is not a pass. Nothing has been validated against the real analyzer."_ **Read the
output, not the exit code.**

These gates are the only test class that has ever caught a defect the producing repo's own suite
asserted was impossible — and each of the three has caught one.

---

## 6. Things no test can cover at all

- **Marketplace publishing** — VS Code (publisher `itsgeagle`, a PAT), JetBrains
  (`:recorder:publishProd`, operator secrets), provnvim (a git tag — and the tag's tree hash **is**
  the `extension_hash`, so a moved or force-pushed tag silently invalidates the allowlist).
- **Every release needs its own allowlist entry**, or its submissions get flagged.
- **A real Google OAuth tenant** — consent screen, redirect URI matching `PUBLIC_BASE_URL`, an
  expiring client secret.
- **Real Gradescope** — see 3.7.

---

## 7. Traps, collected

Each of these has already cost someone real time.

- `npm run build` **before** `npm run typecheck`.
- `npm run test --workspace=packages/X`, **never** `--root packages/X`.
- **Never** the bare root `npm run test` — server testcontainers thrash the machine.
- The server suite needs `--no-file-parallelism --reporter=verbose` and **>20 minutes**. Without
  `--reporter=verbose` it buffers to nothing and looks wedged; someone lost 2h20m to that.
  (`--reporter=basic` does not exist in vitest 4.)
- The server suite has genuine flakes under container contention. **Re-run a failing file alone**
  before calling it a regression. Never two server suites at once — ~37 containers produces MinIO
  503s that read exactly like real bugs.
- The analyzer suite intermittently exits non-zero with **all tests passing** (a deliberate uncaught
  error in `BundleContext.test.tsx`). Re-run before believing it.
- Confirm Docker with `docker run --rm hello-world`, never `docker info`.
- `docs/pilot-feedback-survey.txt` is untracked user work — **explicit pathspec on every
  `git add`**, never `git add -A`.
