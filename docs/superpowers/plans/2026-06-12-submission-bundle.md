# Submission Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sealed bundle carry the student's final submission files alongside the provenance record, always seal (even on a broken chain), wire up the dormant Check 8 `submitted_code_match`, and let staff view the submitted source in the analyzer (local + server).

**Architecture:** Additive manifest `format_version` bump `1.0 → 1.1` adds a signed `submission_files[]` array (`{ path, status, sha256 }`). The recorder bundles the raw on-disk bytes of every `files_under_review` entry at the zip root and never aborts on chain breakage. The analyzer loader whitelists those files, self-checks their hashes, and Check 8 compares each submitted file's hash to the recorder's **last recorded on-disk hash** for that file (from `doc.save` / `fs.external_change` / `doc.open`) — no third reconstruction path. A mismatch on an intact chain is a hard FAIL + high-severity integrity flag. The Source view reads submitted bytes from the parsed bundle (`/local`) or on-demand from the stored bundle blob (server) — student source is never copied into Postgres (retention rule).

**Tech Stack:** TypeScript strict, Vitest, JSZip, `@noble/ed25519`/`@noble/hashes`, Hono, Drizzle, React + TanStack Query, Vite.

**Design refinement vs. spec:** The spec described Check 8 as "reconstruct each file and compare." During planning we found `DocSavePayload.sha256` and `FsExternalChangePayload.new_hash` already record the on-disk hash, so Check 8 compares the submitted hash to the **last recorded on-disk hash** instead of reconstructing. This is simpler and removes the autoformatter false-positive risk noted in the spec. Same product intent, better mechanism.

---

## File Structure

**Create:**

- `packages/analyzer/src/validation/verify-submitted-code.ts` — Check 8 logic + shared per-file verdict helper.
- `packages/analyzer/src/validation/verify-submitted-code.test.ts`
- `packages/analyzer/src/views/submission/Source.tsx` — Source tab.
- `packages/analyzer/src/views/submission/Source.test.tsx`
- `packages/server/src/services/submissions/submitted-files.ts` — extract submitted files from a bundle blob.
- `packages/server/src/services/submissions/submitted-files.test.ts`

**Modify:**

- `packages/log-core/src/bundle.ts` — manifest type + shape validator (1.1 + `submission_files`).
- `packages/log-core/src/bundle.test.ts` — 1.1 vectors (verify file exists; else create).
- `packages/recorder/src/commands/seal.ts` — bundle reviewed files; never abort on broken chain; `warnings` on ok.
- `packages/recorder/src/commands/seal.test.ts`
- The seal command call site (wires `filesUnderReview` + surfaces the warning) — locate via grep (Task B4).
- `packages/analyzer/src/loader/unzip.ts` — two-pass; whitelist submission files.
- `packages/analyzer/src/loader/types.ts` — `BundleFiles.submissionFiles`, `Bundle.submissionFiles`.
- `packages/analyzer/src/loader/parse-bundle.ts` — populate `Bundle.submissionFiles`; self-check hashes.
- `packages/analyzer/src/validation/run-validation.ts` — call Check 8 with chain-intact signal.
- `packages/analyzer/src/heuristics/integrity-flags.ts` — `submitted_code_match` → flag.
- `packages/analyzer/src/views/heuristics/TuningView.tsx` — add id to `KNOWN_HEURISTIC_IDS`.
- `packages/analyzer/src/data/SubmissionDataProvider.ts` — `useSubmittedFiles` / `useSubmittedFileContent`.
- `packages/analyzer/src/data/InMemorySubmissionDataProvider.tsx` — implement both.
- `packages/analyzer/src/data/ApiSubmissionDataProvider.tsx` — implement both.
- `packages/analyzer/src/views/submission/SubmissionShell.tsx` — register Source tab.
- `packages/shared/src/api-schemas.ts` — submitted-files response schemas.
- `packages/server/src/api/v1/routes/submissions.ts` — two new routes.
- `packages/server/src/openapi/spec/paths-submissions.ts` — document the routes.
- `packages/server/src/openapi/spec/components.ts` — response component schemas.
- `packages/analyzer/src/heuristics/config/known-good-extension-hashes.json` — refreshed (Task G).

---

## Group A — log-core: manifest 1.1

### Task A1: Add `submission_files` to the manifest type and bump version

**Files:**

- Modify: `packages/log-core/src/bundle.ts:25-39` (type), `:86-88` (version check), `:130-181` (sessions loop region)
- Test: `packages/log-core/src/bundle.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/log-core/src/bundle.test.ts` (mirror the existing valid-manifest fixture used in that file; if a `validManifest()` helper exists, extend it — otherwise inline the object):

```ts
import { describe, it, expect } from 'vitest';
import { validateBundleManifestShape } from './bundle.js';

const HEX64 = 'a'.repeat(64);

function valid11Manifest() {
  return {
    format_version: '1.1',
    assignment_id: 'hw03',
    semester: 'fa25',
    extension_hash: HEX64,
    sessions: [{ session_id: 's1', prev_session_id: null, slog_sha256: HEX64, meta_sha256: HEX64 }],
    submission_files: [
      { path: 'hw03.py', status: 'present', sha256: HEX64 },
      { path: 'optional.py', status: 'missing', sha256: null },
    ],
  };
}

describe('validateBundleManifestShape — 1.1', () => {
  it('accepts a valid 1.1 manifest with submission_files', () => {
    const r = validateBundleManifestShape(valid11Manifest());
    expect(r.ok).toBe(true);
  });

  it('rejects a present file whose sha256 is null', () => {
    const m = valid11Manifest();
    m.submission_files[0]!.sha256 = null;
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
  });

  it('rejects a missing file whose sha256 is non-null', () => {
    const m = valid11Manifest();
    m.submission_files[1]!.sha256 = HEX64;
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
  });

  it('rejects an unknown submission_files status', () => {
    const m = valid11Manifest();
    (m.submission_files[0] as { status: string }).status = 'deleted';
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
  });

  it('rejects a 1.1 manifest missing submission_files', () => {
    const m = valid11Manifest() as Record<string, unknown>;
    delete m['submission_files'];
    const r = validateBundleManifestShape(m);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/log-core -- bundle.test.ts`
Expected: FAIL — `format_version` check still rejects `'1.1'` (`wrong_version`).

- [ ] **Step 3: Update the type**

In `packages/log-core/src/bundle.ts`, replace the `BundleManifest` type (lines 25-39) with:

```ts
export type SubmissionFileEntry = {
  /** Workspace-relative path; matches a files_under_review entry. */
  path: string;
  /** 'present' = bytes are in the bundle; 'missing' = listed but absent on disk at seal. */
  status: 'present' | 'missing';
  /** Hex sha256 of the raw on-disk bytes. null iff status === 'missing'. */
  sha256: string | null;
};

export type BundleManifest = {
  // Accept both: the validator returns 1.0 (legacy, no submission_files) and 1.1.
  format_version: '1.0' | '1.1';
  assignment_id: string;
  semester: string;
  /** Hex sha256 of the recorder extension. */
  extension_hash: string;
  sessions: ReadonlyArray<{
    session_id: string;
    prev_session_id: string | null;
    /** Hex sha256 of the .slog file. */
    slog_sha256: string;
    /** Hex sha256 of the .slog.meta file. */
    meta_sha256: string;
  }>;
  /**
   * Final on-disk state of every files_under_review entry (PRD §5.3, 1.1+).
   * OPTIONAL at the type level — absent on legacy 1.0 bundles. Always read as
   * `manifest.submission_files ?? []`. (Making this a required field would be a
   * type-lie since the validator accepts 1.0 manifests that lack it.)
   */
  submission_files?: ReadonlyArray<SubmissionFileEntry>;
};
```

- [ ] **Step 4: Update the version check to accept 1.0 and 1.1**

The validator must keep accepting `1.0` bundles (back-compat: they have no `submission_files`). Change the version check at `bundle.ts:86-88` to:

```ts
// format_version: accept 1.0 (legacy, no submission_files) and 1.1.
const version = obj['format_version'];
if (version !== '1.0' && version !== '1.1') {
  return err({ kind: 'wrong_version', actual: version });
}
```

- [ ] **Step 5: Validate `submission_files` after the sessions loop**

Immediately before the final `return ok(value as BundleManifest);` (currently `bundle.ts:183`), insert:

```ts
// submission_files: required iff format_version === '1.1'. Absent on legacy 1.0.
if (version === '1.1') {
  if (!Array.isArray(obj['submission_files'])) {
    if (obj['submission_files'] === undefined) {
      return err({ kind: 'missing_field', field: 'submission_files' });
    }
    return err({ kind: 'invalid_field', field: 'submission_files', reason: 'must be an array' });
  }
  for (let i = 0; i < obj['submission_files'].length; i++) {
    const f = (obj['submission_files'] as unknown[])[i];
    if (typeof f !== 'object' || f === null) {
      return err({
        kind: 'invalid_field',
        field: `submission_files[${i}]`,
        reason: 'must be an object',
      });
    }
    const fObj = f as Record<string, unknown>;
    if (typeof fObj['path'] !== 'string' || fObj['path'].length === 0) {
      return err({
        kind: 'invalid_field',
        field: `submission_files[${i}].path`,
        reason: 'must be a non-empty string',
      });
    }
    const status = fObj['status'];
    if (status !== 'present' && status !== 'missing') {
      return err({
        kind: 'invalid_field',
        field: `submission_files[${i}].status`,
        reason: "must be 'present' or 'missing'",
      });
    }
    const sha = fObj['sha256'];
    if (status === 'present') {
      if (typeof sha !== 'string' || !HEX_64_RE.test(sha)) {
        return err({
          kind: 'invalid_field',
          field: `submission_files[${i}].sha256`,
          reason: 'present file must have a 64-hex sha256',
        });
      }
    } else {
      if (sha !== null) {
        return err({
          kind: 'invalid_field',
          field: `submission_files[${i}].sha256`,
          reason: 'missing file must have sha256 === null',
        });
      }
    }
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm run test --workspace=packages/log-core -- bundle.test.ts`
Expected: PASS (all 1.1 cases + existing 1.0 cases).

- [ ] **Step 7: Typecheck the workspace (the type change ripples)**

Run: `npm run typecheck`
Expected: errors in `recorder/src/commands/seal.ts` (manifest now requires `submission_files`) and possibly analyzer loader types. These are fixed in Groups B and C. If any OTHER package fails, note it — it means an unexpected consumer of the type.

- [ ] **Step 8: Commit**

```bash
git add packages/log-core/src/bundle.ts packages/log-core/src/bundle.test.ts
git commit --no-gpg-sign -m "feat(log-core): bundle manifest 1.1 with submission_files"
```

---

## Group B — recorder: bundle reviewed files + always seal

### Task B1: Add `filesUnderReview` to `SealDeps` and bundle the files

**Files:**

- Modify: `packages/recorder/src/commands/seal.ts`
- Test: `packages/recorder/src/commands/seal.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `packages/recorder/src/commands/seal.test.ts`. Use the existing test's harness for building a `.provenance` dir + valid slog (there is already a passing seal test — reuse its setup helpers; this snippet assumes a `makeSealDeps(tmpDir)` style helper exists, otherwise mirror the existing test's deps construction and add the two new fields):

```ts
import JSZip from 'jszip';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

it('bundles present reviewed files at the zip root and marks missing ones', async () => {
  // Arrange: a workspace with hw03.py present and missing.py absent.
  const ws = await makeWorkspaceWithValidSession(); // existing-style helper
  await fs.writeFile(path.join(ws.root, 'hw03.py'), 'print(1)\n', 'utf8');

  const result = await sealBundle({
    ...ws.deps,
    filesUnderReview: ['hw03.py', 'missing.py'],
  });

  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;

  // Manifest records both files.
  const zip = await JSZip.loadAsync(await fs.readFile(result.bundlePath));
  const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
  expect(manifest.format_version).toBe('1.1');
  const byPath = Object.fromEntries(manifest.submission_files.map((f: any) => [f.path, f]));
  expect(byPath['hw03.py'].status).toBe('present');
  expect(byPath['hw03.py'].sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(byPath['missing.py']).toEqual({ path: 'missing.py', status: 'missing', sha256: null });

  // Bytes are at the zip root.
  expect(zip.file('hw03.py')).not.toBeNull();
  expect(await zip.file('hw03.py')!.async('string')).toBe('print(1)\n');
  expect(zip.file('missing.py')).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- seal.test.ts -t "bundles present reviewed files"`
Expected: FAIL — `filesUnderReview` is not a known dep; `submission_files` not in manifest.

- [ ] **Step 3: Add the dep and a helper**

In `seal.ts`, add to `SealDeps` (after `semester`):

```ts
  /** Workspace-relative paths of the files under review (.provenance-manifest files_under_review). */
  filesUnderReview: readonly string[];
```

Add a helper near `sha256OfFile` (after line 83) that reads bytes + hash, or reports missing:

```ts
type ReviewedFile =
  | { path: string; status: 'present'; sha256: string; bytes: Uint8Array }
  | { path: string; status: 'missing'; sha256: null };

/**
 * Read a reviewed file's raw on-disk bytes + sha256, or mark it missing.
 * `path` is workspace-relative; resolved against workspaceRoot.
 */
async function readReviewedFile(workspaceRoot: string, relPath: string): Promise<ReviewedFile> {
  const abs = path.join(workspaceRoot, relPath);
  try {
    const bytes = await fsPromises.readFile(abs);
    const hash = createHash('sha256');
    hash.update(bytes);
    return {
      path: relPath,
      status: 'present',
      sha256: hash.digest('hex'),
      bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
  } catch {
    return { path: relPath, status: 'missing', sha256: null };
  }
}
```

- [ ] **Step 4: Build `submission_files`, add bytes to the zip, set version 1.1**

In `sealBundle`, destructure `filesUnderReview` from `deps` (top of the function). After the session loop and before building the manifest (around line 219), add:

```ts
// Read reviewed files (workspace-relative; resolved against the workspace root).
const workspaceRoot = workspaceFolder.uri.fsPath;
const reviewedFiles: ReviewedFile[] = [];
for (const rel of filesUnderReview) {
  reviewedFiles.push(await readReviewedFile(workspaceRoot, rel));
}

const submissionFiles = reviewedFiles.map((f) =>
  f.status === 'present'
    ? { path: f.path, status: 'present' as const, sha256: f.sha256 }
    : { path: f.path, status: 'missing' as const, sha256: null },
);
```

Change the manifest object (lines 230-236) to:

```ts
const manifest: BundleManifest = {
  format_version: '1.1',
  assignment_id: assignmentId,
  semester,
  extension_hash: extensionHash,
  sessions: sessionEntries,
  submission_files: submissionFiles,
};
```

After the `.provenance/` dir entries are added to the zip (after the loop at lines 285-297), add the submission bytes at the zip root:

```ts
// Add submitted file bytes at the zip root (mirrors the workspace layout).
for (const f of reviewedFiles) {
  if (f.status === 'present') {
    zip.file(f.path, f.bytes);
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test --workspace=packages/recorder -- seal.test.ts -t "bundles present reviewed files"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/recorder/src/commands/seal.ts packages/recorder/src/commands/seal.test.ts
git commit --no-gpg-sign -m "feat(recorder): seal bundles reviewed files into manifest 1.1"
```

### Task B2: Never abort on a broken chain; carry warnings on ok

**Files:**

- Modify: `packages/recorder/src/commands/seal.ts`
- Test: `packages/recorder/src/commands/seal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('still produces a bundle when a slog chain is broken, and warns', async () => {
  const ws = await makeWorkspaceWithValidSession();
  await fs.writeFile(path.join(ws.root, 'hw03.py'), 'x=1\n', 'utf8');

  // Corrupt the chain: flip a byte inside a hash field of a middle entry.
  const slogPath = ws.slogPath; // exposed by helper
  const lines = (await fs.readFile(slogPath, 'utf8')).split('\n').filter(Boolean);
  const obj = JSON.parse(lines[1]!);
  obj.hash = 'f'.repeat(64); // wrong hash → chain break at this entry
  lines[1] = JSON.stringify(obj);
  await fs.writeFile(slogPath, lines.join('\n') + '\n', 'utf8');

  const result = await sealBundle({ ...ws.deps, filesUnderReview: ['hw03.py'] });

  expect(result.kind).toBe('ok');
  if (result.kind !== 'ok') return;
  expect(result.warnings?.chainBroken).toBe(true);

  // The bundle is still produced and includes the (tampered) slog bytes as-is.
  const zip = await JSZip.loadAsync(await fs.readFile(result.bundlePath));
  expect(Object.keys(zip.files).some((n) => n.endsWith('.slog'))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/recorder -- seal.test.ts -t "still produces a bundle when a slog chain is broken"`
Expected: FAIL — currently returns `{ kind: 'chain_broken' }`, no bundle.

- [ ] **Step 3: Change `SealResult.ok` to carry warnings, drop the chain_broken abort**

Update the `SealResult` union (lines 39-43):

```ts
export type SealWarnings = {
  /** True if any session's hash chain failed to validate at seal time. */
  chainBroken: boolean;
  /** True if any .slog could not be parsed / had no readable session.start. */
  unreadableSession: boolean;
};

export type SealResult =
  | { kind: 'ok'; bundlePath: string; manifestSha256: string; warnings: SealWarnings }
  | { kind: 'no_sessions' }
  | { kind: 'write_error'; message: string };
```

In the session loop (lines 156-217), replace the three `return { kind: 'chain_broken' }` / parse-error returns with warning accumulation. Before the loop add:

```ts
const warnings: SealWarnings = { chainBroken: false, unreadableSession: false };
```

- Parse failure (lines 174-182): instead of returning, set `warnings.unreadableSession = true`, still compute hashes from the raw bytes, push a session entry with `session_id: null`, and `continue`:

```ts
const parseResult = parseEntries(slogText);
if (!parseResult.ok) {
  warnings.unreadableSession = true;
  sessionEntries.push({
    session_id: null,
    prev_session_id: null,
    slog_sha256: await sha256OfFile(slogPath),
    meta_sha256: await sha256OfFile(metaPath),
  });
  continue;
}
const entries = parseResult.value;
```

- Chain break (lines 187-195): set `warnings.chainBroken = true`, do NOT return. Continue to extract ids + hashes below.

```ts
const chainResult = validateChain(entries);
if (!chainResult.ok) {
  warnings.chainBroken = true;
}
```

- Missing session.start (lines 198-205): set `warnings.unreadableSession = true`, use `session_id: null` instead of returning:

```ts
const ids = extractSessionIds(entries);
const slogSha256 = await sha256OfFile(slogPath);
const metaSha256 = await sha256OfFile(metaPath);
sessionEntries.push({
  session_id: ids?.session_id ?? null,
  prev_session_id: ids?.prev_session_id ?? null,
  slog_sha256: slogSha256,
  meta_sha256: metaSha256,
});
if (ids === null) {
  warnings.unreadableSession = true;
}
```

(Delete the now-dead `extractSessionIds`-then-`if (ids === null) return` block and the earlier per-iteration hash computation that this replaces.)

- [ ] **Step 4: Allow `session_id: null` in the manifest sessions type**

This requires `sessions[].session_id` to be `string | null`. Update `packages/log-core/src/bundle.ts` `BundleManifest.sessions` entry: change `session_id: string;` to `session_id: string | null;`, and in the validator (`bundle.ts:137-146`) accept `null`:

```ts
if (
  sObj['session_id'] !== null &&
  (typeof sObj['session_id'] !== 'string' || sObj['session_id'].length === 0)
) {
  if (sObj['session_id'] === undefined) {
    return err({ kind: 'missing_field', field: `sessions[${i}].session_id` });
  }
  return err({
    kind: 'invalid_field',
    field: `sessions[${i}].session_id`,
    reason: 'must be a non-empty string or null',
  });
}
```

Add a log-core test in `bundle.test.ts`:

```ts
it('accepts a session entry with a null session_id (corrupt-session bundle)', () => {
  const m = valid11Manifest();
  (m.sessions[0] as { session_id: string | null }).session_id = null;
  expect(validateBundleManifestShape(m).ok).toBe(true);
});
```

- [ ] **Step 5: Return `warnings` from the ok result**

Change the final return (line 325) to:

```ts
return { kind: 'ok', bundlePath, manifestSha256, warnings };
```

- [ ] **Step 6: Run recorder + log-core tests**

Run: `npm run test --workspace=packages/recorder -- seal.test.ts` and `npm run test --workspace=packages/log-core -- bundle.test.ts`
Expected: PASS. Existing seal tests that asserted `chain_broken` must be updated to assert `ok` + `warnings.chainBroken`; do so (this is a deliberate behavior change per the spec, not a constraint to weaken silently).

- [ ] **Step 7: Commit**

```bash
git add packages/recorder/src/commands/seal.ts packages/recorder/src/commands/seal.test.ts packages/log-core/src/bundle.ts packages/log-core/src/bundle.test.ts
git commit --no-gpg-sign -m "feat(recorder): always seal; carry chain/parse warnings instead of aborting"
```

### Task B3: Update the doc comment on `sealBundle`

- [ ] **Step 1: Edit the header comment** at `seal.ts:15-21` and the step list at `:118-129` to reflect: never aborts on broken chain; bundles reviewed files at root; manifest is 1.1. No test. Commit with Task B4.

### Task B4: Wire `filesUnderReview` + surface the warning at the call site

**Files:**

- Modify: the file that calls `sealBundle` (the `provenance.prepareSubmissionBundle` command handler).

- [ ] **Step 1: Find the call site**

Run: `grep -rn "sealBundle(" packages/recorder/src --include=*.ts | grep -v test`
Expected: one production call site (in the command registration, likely `extension.ts` or `commands/`).

- [ ] **Step 2: Pass `filesUnderReview` from the loaded `.provenance-manifest` manifest**

At the call site, the loaded manifest (`manifest.files_under_review`) is in scope (it's used to build `ExpectedContentRegistry` per `extension.ts:93`). Add `filesUnderReview: manifest.files_under_review` to the `sealBundle({...})` deps object.

- [ ] **Step 3: Surface the warning (non-blocking)**

Where the result is handled, after the `kind: 'ok'` branch shows its success toast, add:

```ts
if (result.warnings.chainBroken || result.warnings.unreadableSession) {
  void vscode.window.showWarningMessage(
    'Provenance bundle produced. Integrity issues were detected in the recording and will be reviewed by course staff.',
  );
}
```

Remove any `case 'chain_broken':` handling (that variant no longer exists — typecheck will flag it).

- [ ] **Step 4: Typecheck + test recorder**

Run: `npm run typecheck` then `npm run test --workspace=packages/recorder`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/recorder/src
git commit --no-gpg-sign -m "feat(recorder): wire files_under_review into seal + warn on integrity issues"
```

---

## Group C — analyzer loader: accept + self-check submission files

### Task C1: Two-pass unzip that whitelists submission files

**Files:**

- Modify: `packages/analyzer/src/loader/types.ts`, `packages/analyzer/src/loader/unzip.ts`
- Test: `packages/analyzer/src/loader/unzip.test.ts`

- [ ] **Step 1: Extend `BundleFiles`**

In `loader/types.ts`, add to `BundleFiles` (after `sessions`):

```ts
/** Raw bytes of each submitted file present in the zip, keyed by manifest path. */
submissionFiles: Map<string, Uint8Array>;
```

- [ ] **Step 2: Write the failing test**

Add to `packages/analyzer/src/loader/unzip.test.ts` (reuse the existing helper that builds a valid bundle zip; extend it to write a 1.1 manifest + a submission file):

```ts
it('accepts submission files listed in the manifest and rejects others', async () => {
  const zip = new JSZip();
  const manifest = {
    /* a valid 1.1 manifest with submission_files: [{path:'hw03.py',status:'present',sha256:HEX64}] */
  };
  // ...write manifest.json, manifest.sig, session-<id>.slog, .slog.meta as the existing helper does...
  zip.file('hw03.py', 'print(1)\n');
  const bytes = await zip.generateAsync({ type: 'uint8array' });

  const r = await unzipBundle(bytes.buffer);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(new TextDecoder().decode(r.value.submissionFiles.get('hw03.py')!)).toBe('print(1)\n');
});

it('rejects a root file that is not a recognized bundle file nor a submission file', async () => {
  // build a valid 1.1 bundle, then add zip.file('stray.txt', 'junk')
  // expect r.ok === false with kind 'unexpected_file'
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- unzip.test.ts`
Expected: FAIL — `hw03.py` currently triggers `unexpected_file`.

- [ ] **Step 4: Implement two-pass scan**

Rewrite the categorization loop in `unzip.ts` (lines 67-115). First pass reads manifest + sig and defers other entries; then parse the manifest's `submission_files` paths; then categorize deferred entries:

```ts
let manifestJson: string | null = null;
let manifestSigHex: string | null = null;
const slogIds = new Set<string>();
const metaIds = new Set<string>();
const slogContents = new Map<string, string>();
const metaContents = new Map<string, string>();
const deferred: Array<[string, JSZip.JSZipObject]> = [];

for (const [filename, zipObject] of Object.entries(zip.files)) {
  if (zipObject.dir) continue;
  if (filename === MANIFEST_JSON) {
    manifestJson = await zipObject.async('string');
    continue;
  }
  if (filename === MANIFEST_SIG) {
    manifestSigHex = (await zipObject.async('string')).trim();
    continue;
  }
  const slogMatch = SLOG_RE.exec(filename);
  if (slogMatch !== null) {
    const id = slogMatch[1]!;
    slogIds.add(id);
    slogContents.set(id, await zipObject.async('string'));
    continue;
  }
  const metaMatch = SLOG_META_RE.exec(filename);
  if (metaMatch !== null) {
    const id = metaMatch[1]!;
    metaIds.add(id);
    metaContents.set(id, await zipObject.async('string'));
    continue;
  }
  deferred.push([filename, zipObject]);
}

if (manifestJson === null) return err({ kind: 'missing_manifest' });
if (manifestSigHex === null) return err({ kind: 'missing_signature' });

// Whitelist submission file paths from the manifest (best-effort JSON parse;
// full shape validation happens later in parse-bundle).
const submissionPaths = new Set<string>();
try {
  const parsed = JSON.parse(manifestJson) as { submission_files?: Array<{ path?: unknown }> };
  for (const f of parsed.submission_files ?? []) {
    if (typeof f?.path === 'string') submissionPaths.add(f.path);
  }
} catch {
  // Malformed manifest JSON — parse-bundle will surface invalid_manifest.
  // Treat every deferred file as unexpected below.
}

const submissionFiles = new Map<string, Uint8Array>();
for (const [filename, zipObject] of deferred) {
  if (submissionPaths.has(filename)) {
    submissionFiles.set(filename, await zipObject.async('uint8array'));
  } else {
    return err({ kind: 'unexpected_file', filename, detail: 'not a recognized bundle file' });
  }
}
```

Then keep the existing structural checks (no_sessions, orphan checks) and return `submissionFiles` in the result object:

```ts
return ok({ manifestJson, manifestSigHex, sessions, submissionFiles });
```

Add `import type JSZip from 'jszip';` is already present as default import — use `JSZip.JSZipObject` for the deferred tuple type (or `Awaited<ReturnType<typeof JSZip.loadAsync>>['files'][string]`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test --workspace=packages/analyzer -- unzip.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/loader/unzip.ts packages/analyzer/src/loader/types.ts packages/analyzer/src/loader/unzip.test.ts
git commit --no-gpg-sign -m "feat(analyzer): unzip whitelists manifest submission files"
```

### Task C2: Surface submission files on `Bundle` + self-check hashes

**Files:**

- Modify: `packages/analyzer/src/loader/types.ts`, `packages/analyzer/src/loader/parse-bundle.ts`
- Test: `packages/analyzer/src/loader/parse-bundle.test.ts`

- [ ] **Step 1: Add `submissionFiles` to `Bundle`**

In `loader/types.ts`, add to `Bundle`:

```ts
/**
 * Submitted files from the bundle (1.1+). Keyed by manifest path. `bytes` is
 * present only for status 'present' files whose zip entry verified against the
 * manifest sha256. `hashOk` records whether the bundle self-check passed.
 */
submissionFiles: Map<
  string,
  { status: 'present' | 'missing'; sha256: string | null; bytes?: Uint8Array; hashOk: boolean }
>;
```

- [ ] **Step 2: Write the failing test**

Add to `parse-bundle.test.ts`:

```ts
it('exposes submission files and flags a hash self-check mismatch', async () => {
  // Build a 1.1 bundle whose manifest says hw03.py sha256 = H, but the zip bytes hash to H'.
  // (Write correct bytes for a 'good.py' and tampered bytes for 'bad.py'.)
  const r = await loadBundle(/* zip */, 'b.zip');
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.submissionFiles.get('good.py')!.hashOk).toBe(true);
  expect(r.value.submissionFiles.get('bad.py')!.hashOk).toBe(false);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- parse-bundle.test.ts -t "exposes submission files"`
Expected: FAIL — `submissionFiles` not on `Bundle`.

- [ ] **Step 4: Populate `Bundle.submissionFiles` in `loadBundle`**

In `parse-bundle.ts`, after the manifest is validated and `BundleFiles` is available, build the map from `manifest.submission_files` and the unzipped bytes:

```ts
import { sha256Hex } from '@provenance/log-core';

// ...inside loadBundle, after manifest validation succeeds...
const submissionFiles = new Map<
  string,
  { status: 'present' | 'missing'; sha256: string | null; bytes?: Uint8Array; hashOk: boolean }
>();
for (const f of manifest.submission_files ?? []) {
  if (f.status === 'missing') {
    submissionFiles.set(f.path, { status: 'missing', sha256: null, hashOk: true });
    continue;
  }
  const bytes = bundleFiles.submissionFiles.get(f.path);
  const hashOk = bytes !== undefined && sha256Hex(bytes) === f.sha256;
  submissionFiles.set(f.path, { status: 'present', sha256: f.sha256, bytes, hashOk });
}
```

Add `submissionFiles` to the returned `Bundle` object. (`manifest.submission_files ?? []` keeps 1.0 bundles working — empty map.)

> Note: confirm `sha256Hex` accepts a `Uint8Array` (it is used as `sha256Hex(canonicalBytes)` in recorder seal). If it only accepts `string`, use the log-core hash util that takes bytes, or `bytesToHex(sha256(bytes))` from `@noble/hashes`.

- [ ] **Step 5: Run test + full loader suite**

Run: `npm run test --workspace=packages/analyzer -- loader`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/loader/types.ts packages/analyzer/src/loader/parse-bundle.ts packages/analyzer/src/loader/parse-bundle.test.ts
git commit --no-gpg-sign -m "feat(analyzer): expose submission files on Bundle with hash self-check"
```

---

## Group D — analyzer: wire up Check 8

### Task D1: `verify-submitted-code.ts` — per-file verdicts + Check 8

**Files:**

- Create: `packages/analyzer/src/validation/verify-submitted-code.ts`, `...test.ts`

- [ ] **Step 1: Write the failing test**

Create `verify-submitted-code.test.ts`. Build small `Bundle` fixtures (reuse the loader test helpers / a `makeBundle` factory if present; otherwise construct a `Bundle` literal with one session whose events are `session.start`, `doc.open`, `doc.save`):

```ts
import { describe, it, expect } from 'vitest';
import { verifySubmittedCode } from './verify-submitted-code.js';

describe('verifySubmittedCode (Check 8)', () => {
  it('passes when submitted hash equals the last recorded on-disk hash', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'H', hashOk: true }],
      events: [docSave('a.py', 'H')],
    });
    const check = verifySubmittedCode(bundle, { chainIntact: true });
    expect(check.status).toBe('pass');
  });

  it('fails when submitted hash differs and the chain is intact', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'X', hashOk: true }],
      events: [docSave('a.py', 'H')],
    });
    const check = verifySubmittedCode(bundle, { chainIntact: true });
    expect(check.status).toBe('fail');
    expect(check.supportingSeqs?.length).toBeGreaterThan(0);
  });

  it('uses fs.external_change new_hash as the latest on-disk hash', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'N', hashOk: true }],
      events: [docSave('a.py', 'H'), fsExternal('a.py', 'H', 'N')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('pass');
  });

  it('skips when the chain is broken', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'X', hashOk: true }],
      events: [docSave('a.py', 'H')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: false }).status).toBe('skipped');
  });

  it('skips a file with no usable events', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'X', hashOk: true }],
      events: [],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('skipped');
  });

  it('skips a missing file', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'missing', sha256: null, hashOk: true }],
      events: [docSave('a.py', 'H')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('skipped');
  });

  it('fails when present bytes failed the bundle self-check (hashOk false)', () => {
    const bundle = makeBundle({
      submissionFiles: [{ path: 'a.py', status: 'present', sha256: 'H', hashOk: false }],
      events: [docSave('a.py', 'H')],
    });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('fail');
  });

  it('is skipped entirely on a 1.0 bundle (no submission files)', () => {
    const bundle = makeBundle({ submissionFiles: [], events: [docSave('a.py', 'H')] });
    expect(verifySubmittedCode(bundle, { chainIntact: true }).status).toBe('skipped');
  });
});
```

Define the `makeBundle`/`docSave`/`fsExternal` helpers at the top of the test file: `docSave(path, sha)` → a `HashedEnvelope` with `kind:'doc.save'`, `data:{path,sha256:sha}`, incrementing `seq`; `fsExternal(path, old, neu)` → `kind:'fs.external_change'`, `data:{path,old_hash:old,new_hash:neu}`. `makeBundle` returns a `Bundle` with one session (`sessionId:'s1'`) whose `events` are `[sessionStart(), ...events]`, and a `submissionFiles` Map built from the array.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- verify-submitted-code.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `packages/analyzer/src/validation/verify-submitted-code.ts`:

```ts
/**
 * Check 8 — submitted_code_match (PRD §5.4 step 8).
 *
 * For each reviewed file, compare the submitted file's hash (from the bundle's
 * signed manifest, re-verified against the zip bytes during loadBundle) to the
 * recorder's LAST recorded on-disk hash for that file — the sha256 of the most
 * recent doc.save / fs.external_change(new_hash) / doc.open across the bundle.
 *
 *   match               → pass
 *   mismatch, chain ok  → fail  (file edited outside the recording)
 *   chain broken        → skip  (Check 3 already fails this)
 *   no usable events    → skip
 *   status 'missing'    → skip  (nothing submitted to compare)
 *   hashOk === false    → fail  (bundle bytes don't match their own manifest hash)
 *
 * No reconstruction: we compare recorded hashes only, so reconstruction taint
 * is irrelevant here.
 */
import type { HashedEnvelope } from '@provenance/log-core';
import type { Bundle } from '../loader/types.js';
import type { ValidationCheck } from './check-types.js';

export type SubmittedFileVerdict = {
  path: string;
  status: 'present' | 'missing';
  /** 'match' | 'mismatch' | 'unknown' (skip) */
  verdict: 'match' | 'mismatch' | 'unknown';
  submittedSha: string | null;
  recordedSha: string | null;
  detail: string;
  supportingSeqs: Array<{ sessionId: string; seq: number }>;
};

/** Last recorded on-disk hash per file, scanning all sessions in order. */
function lastRecordedHashes(
  bundle: Bundle,
): Map<string, { sha: string; sessionId: string; seq: number }> {
  const out = new Map<string, { sha: string; sessionId: string; seq: number }>();
  for (const session of bundle.sessions) {
    for (const event of session.events as readonly HashedEnvelope[]) {
      let path: string | undefined;
      let sha: string | undefined;
      if (event.kind === 'doc.save' || event.kind === 'doc.open') {
        const d = event.data as { path: string; sha256: string };
        path = d.path;
        sha = d.sha256;
      } else if (event.kind === 'fs.external_change') {
        const d = event.data as { path: string; new_hash: string };
        path = d.path;
        sha = d.new_hash;
      }
      if (path !== undefined && sha !== undefined) {
        out.set(path, { sha, sessionId: session.sessionId, seq: event.seq });
      }
    }
  }
  return out;
}

/** Per-file verdicts; shared by Check 8 and the Source view. */
export function submittedFileVerdicts(
  bundle: Bundle,
  opts: { chainIntact: boolean },
): SubmittedFileVerdict[] {
  const recorded = lastRecordedHashes(bundle);
  const verdicts: SubmittedFileVerdict[] = [];

  for (const [path, f] of bundle.submissionFiles) {
    if (f.status === 'missing') {
      verdicts.push({
        path,
        status: 'missing',
        verdict: 'unknown',
        submittedSha: null,
        recordedSha: null,
        detail: 'File listed in files_under_review but absent on disk at seal time.',
        supportingSeqs: [],
      });
      continue;
    }
    if (!f.hashOk) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'mismatch',
        submittedSha: f.sha256,
        recordedSha: null,
        detail: 'Submitted bytes do not match their own manifest sha256 (tampered bundle).',
        supportingSeqs: [],
      });
      continue;
    }
    if (!opts.chainIntact) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'unknown',
        submittedSha: f.sha256,
        recordedSha: null,
        detail: 'Hash chain is broken; cannot trust recorded hashes.',
        supportingSeqs: [],
      });
      continue;
    }
    const rec = recorded.get(path);
    if (rec === undefined) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'unknown',
        submittedSha: f.sha256,
        recordedSha: null,
        detail: 'No doc.open/doc.save/fs.external_change recorded for this file.',
        supportingSeqs: [],
      });
      continue;
    }
    if (rec.sha === f.sha256) {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'match',
        submittedSha: f.sha256,
        recordedSha: rec.sha,
        detail: 'Submitted file matches the last recorded on-disk state.',
        supportingSeqs: [{ sessionId: rec.sessionId, seq: rec.seq }],
      });
    } else {
      verdicts.push({
        path,
        status: 'present',
        verdict: 'mismatch',
        submittedSha: f.sha256,
        recordedSha: rec.sha,
        detail: `Submitted sha256 ${f.sha256} != last recorded on-disk sha256 ${rec.sha}. File was changed outside the recording.`,
        supportingSeqs: [{ sessionId: rec.sessionId, seq: rec.seq }],
      });
    }
  }
  return verdicts;
}

export function verifySubmittedCode(
  bundle: Bundle,
  opts: { chainIntact: boolean },
): ValidationCheck {
  // 1.0 bundles / no submission files → nothing to check.
  if (bundle.submissionFiles.size === 0) {
    return {
      id: 'submitted_code_match',
      label: 'Submitted code matches recorded final state',
      status: 'skipped',
      detail: 'Bundle has no submission files (format 1.0).',
    };
  }

  const verdicts = submittedFileVerdicts(bundle, opts);
  const mismatches = verdicts.filter((v) => v.verdict === 'mismatch');
  const matches = verdicts.filter((v) => v.verdict === 'match');

  if (mismatches.length > 0) {
    return {
      id: 'submitted_code_match',
      label: 'Submitted code matches recorded final state',
      status: 'fail',
      detail: `${mismatches.length} submitted file(s) do not match the recording: ${mismatches.map((m) => `${m.path} (${m.detail})`).join(' | ')}`,
      supportingSeqs: mismatches.flatMap((m) => m.supportingSeqs),
    };
  }
  if (matches.length === 0) {
    return {
      id: 'submitted_code_match',
      label: 'Submitted code matches recorded final state',
      status: 'skipped',
      detail: 'No submitted file could be checked (chain broken, missing, or no recorded state).',
    };
  }
  return {
    id: 'submitted_code_match',
    label: 'Submitted code matches recorded final state',
    status: 'pass',
    detail: `${matches.length} submitted file(s) match the recorded final state.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/analyzer -- verify-submitted-code.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/validation/verify-submitted-code.ts packages/analyzer/src/validation/verify-submitted-code.test.ts
git commit --no-gpg-sign -m "feat(analyzer): Check 8 verify-submitted-code via recorded on-disk hashes"
```

### Task D2: Call Check 8 from the orchestrator

**Files:**

- Modify: `packages/analyzer/src/validation/run-validation.ts`
- Test: `packages/analyzer/src/validation/run-validation.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `run-validation.test.ts`:

```ts
it('runs Check 8 (no longer hard-coded skipped) on a 1.1 bundle', async () => {
  const bundle = /* a 1.1 bundle whose submitted file matches its last doc.save and chain is intact */;
  const report = await runValidation(bundle);
  const c8 = report.checks.find((c) => c.id === 'submitted_code_match')!;
  expect(c8.status).toBe('pass');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- run-validation.test.ts -t "runs Check 8"`
Expected: FAIL — Check 8 is still the hard-coded `skipped` constant.

- [ ] **Step 3: Replace the constant with a real call**

In `run-validation.ts`: delete `CHECK_8_SKIPPED` (lines 31-37), add the import, and change `check8`:

```ts
import { verifySubmittedCode } from './verify-submitted-code.js';
// ...
const check3 = verifyChain(bundle);
// ...
const check8 = verifySubmittedCode(bundle, { chainIntact: check3.status === 'pass' });
```

Update the file's top NOTE comment (lines 4-9) to reflect that Check 8 now runs for 1.1 bundles (a clean 1.1 bundle can reach overall `pass`); 1.0 bundles still yield `warn` because Check 8 is skipped.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/analyzer -- run-validation.test.ts`
Expected: PASS. Existing tests that asserted overall `warn` for a clean bundle may now expect `pass` if their fixture is 1.1 — update those fixtures/assertions deliberately (this is the intended behavior change). 1.0 fixtures remain `warn`.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/validation/run-validation.ts packages/analyzer/src/validation/run-validation.test.ts
git commit --no-gpg-sign -m "feat(analyzer): orchestrator runs Check 8 for 1.1 bundles"
```

### Task D3: Surface `submitted_code_match` as a heuristic flag

**Files:**

- Modify: `packages/analyzer/src/heuristics/integrity-flags.ts`, `packages/analyzer/src/views/heuristics/TuningView.tsx`
- Test: `packages/analyzer/src/heuristics/integrity-flags.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `integrity-flags.test.ts`:

```ts
it('emits a high-severity submitted_code_match flag when Check 8 fails', () => {
  const report = {
    overall: 'fail',
    checks: [
      {
        id: 'submitted_code_match',
        label: 'x',
        status: 'fail',
        detail: 'mismatch',
        supportingSeqs: [{ sessionId: 's1', seq: 7 }],
      },
    ],
  } as const;
  const flags = integrityFlagsFromReport(report as any);
  const f = flags.find((x) => x.heuristic === 'submitted_code_match')!;
  expect(f).toBeDefined();
  expect(f.severity).toBe('high');
  expect(f.confidence).toBe(1.0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- integrity-flags.test.ts -t "submitted_code_match"`
Expected: FAIL — no `CHECK_META` entry, so no flag.

- [ ] **Step 3: Add the `CHECK_META` entry**

In `integrity-flags.ts`, add to the `CHECK_META` map (keyed by `check.id`, alongside `chain_integrity`):

```ts
  submitted_code_match: {
    heuristic: 'submitted_code_match',
    title: 'Submitted code does not match the recording',
    severity: 'high',
    confidence: 1.0,
    fallbackDescription: 'The submitted file differs from the last recorded on-disk state.',
  },
```

- [ ] **Step 4: Register the heuristic id**

In `views/heuristics/TuningView.tsx`, add `'submitted_code_match',` to the `KNOWN_HEURISTIC_IDS` array (it is integrity-derived → no thresholds, same as `chain_broken`).

- [ ] **Step 5: Run tests**

Run: `npm run test --workspace=packages/analyzer -- integrity-flags.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/heuristics/integrity-flags.ts packages/analyzer/src/views/heuristics/TuningView.tsx packages/analyzer/src/heuristics/integrity-flags.test.ts
git commit --no-gpg-sign -m "feat(analyzer): surface submitted_code_match as an integrity flag"
```

---

## Group E — analyzer: Source view (provider + tab)

### Task E1: Provider interface — submitted files + content

**Files:**

- Modify: `packages/analyzer/src/data/SubmissionDataProvider.ts`

- [ ] **Step 1: Add result types + interface methods**

In `SubmissionDataProvider.ts`, add result types (after `FileProvenanceResult`):

```ts
export type SubmittedFileEntry = {
  path: string;
  status: 'present' | 'missing';
  /** 'match' | 'mismatch' | 'unknown' — Check 8 verdict for this file. */
  verdict: 'match' | 'mismatch' | 'unknown';
  sha256: string | null;
};

export type SubmittedFileListResult = {
  files: SubmittedFileEntry[];
  /** False when the bundle blob is gone (server, post-retention). */
  available: boolean;
};

export type SubmittedFileContentResult = {
  path: string;
  /** UTF-8 decoded content. */
  content: string;
  status: 'present' | 'missing';
  verdict: 'match' | 'mismatch' | 'unknown';
};
```

Add to the `SubmissionDataProvider` interface:

```ts
  /** Submitted files (final on-disk bytes) + per-file Check 8 verdict. 1.1+ only. */
  useSubmittedFiles(): UseQueryResult<SubmittedFileListResult>;

  /** Submitted content of one file (UTF-8). */
  useSubmittedFileContent(path: string): UseQueryResult<SubmittedFileContentResult>;
```

- [ ] **Step 2: Typecheck (expect two implementers to fail)**

Run: `npm run typecheck --workspace=packages/analyzer`
Expected: FAIL — `InMemorySubmissionDataProvider` and `ApiSubmissionDataProvider` don't implement the new methods (fixed in E2/E3). Commit with E2.

### Task E2: InMemory provider implementation

**Files:**

- Modify: `packages/analyzer/src/data/InMemorySubmissionDataProvider.tsx`
- Test: `packages/analyzer/src/data/InMemorySubmissionDataProvider.test.tsx`

- [ ] **Step 1: Write the failing test**

```ts
it('exposes submitted files + content from the in-memory bundle', async () => {
  // Render with a 1.1 bundle (hw03.py present, matches recording).
  const provider = /* build InMemory provider from a loaded 1.1 bundle + its ValidationReport */;
  const files = provider.useSubmittedFiles(); // via renderHook with the context
  await waitFor(() => expect(files.result.current.data?.available).toBe(true));
  expect(files.result.current.data?.files.find((f) => f.path === 'hw03.py')?.verdict).toBe('match');
});
```

(Follow the existing test style in this file — it already renders the in-memory provider context and reads hooks via `renderHook`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- InMemorySubmissionDataProvider.test.tsx -t "submitted files"`
Expected: FAIL.

- [ ] **Step 3: Implement both hooks**

In `InMemorySubmissionDataProvider.tsx`, import the shared verdict helper and the chain status, and add the two hooks to the returned provider object. The in-memory provider already has the `Bundle` and its `ValidationReport` in scope (via `useBundle()`); derive `chainIntact` from the report's `chain_integrity` check:

```ts
import { submittedFileVerdicts } from '../validation/verify-submitted-code.js';

// inside the factory, with `bundle` and `validationReport` available:
const chainIntact =
  validationReport?.checks.find((c) => c.id === 'chain_integrity')?.status === 'pass';
const verdicts = submittedFileVerdicts(bundle, { chainIntact: chainIntact ?? false });
const verdictByPath = new Map(verdicts.map((v) => [v.path, v]));

function useSubmittedFiles(): UseQueryResult<SubmittedFileListResult> {
  return useQuery({
    queryKey: ['inmem', bundle.id, 'submitted-files'],
    queryFn: () => ({
      available: true,
      files: verdicts.map((v) => ({
        path: v.path,
        status: v.status,
        verdict: v.verdict,
        sha256: v.submittedSha,
      })),
    }),
  });
}

function useSubmittedFileContent(path: string): UseQueryResult<SubmittedFileContentResult> {
  return useQuery({
    queryKey: ['inmem', bundle.id, 'submitted-content', path],
    queryFn: () => {
      const entry = bundle.submissionFiles.get(path);
      const v = verdictByPath.get(path);
      const content = entry?.bytes ? new TextDecoder().decode(entry.bytes) : '';
      return {
        path,
        content,
        status: entry?.status ?? 'missing',
        verdict: v?.verdict ?? 'unknown',
      };
    },
  });
}
```

Add `useSubmittedFiles` and `useSubmittedFileContent` to the returned object. (Match the file's existing `useQuery` wrapping convention — if it uses a synchronous `initialData` pattern, follow that instead.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/analyzer -- InMemorySubmissionDataProvider.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/analyzer/src/data/SubmissionDataProvider.ts packages/analyzer/src/data/InMemorySubmissionDataProvider.tsx packages/analyzer/src/data/InMemorySubmissionDataProvider.test.tsx
git commit --no-gpg-sign -m "feat(analyzer): in-memory provider exposes submitted files + content"
```

### Task E3: API provider implementation (depends on Group F endpoints + schemas)

**Files:**

- Modify: `packages/analyzer/src/data/ApiSubmissionDataProvider.tsx`

> Ordering note: the Zod response schemas this task imports are created in Task F1. Do F1 before E3, or stub the schemas in F1 first. The two new endpoints are created in Task F3.

- [ ] **Step 1: Implement the two hooks using `apiFetch`**

In `ApiSubmissionDataProvider.tsx`, mirror the existing `useFileContent` pattern:

```ts
import {
  SubmittedFileListSchema,
  SubmittedFileContentSchema,
} from '@provenance/shared/api-schemas';

function useSubmittedFiles(): UseQueryResult<SubmittedFileListResult> {
  return useQuery({
    queryKey: ['sub', submissionId, 'submitted-files'],
    queryFn: () =>
      apiFetch(`/submissions/${submissionId}/submitted-files`, undefined, SubmittedFileListSchema),
  });
}

function useSubmittedFileContent(path: string): UseQueryResult<SubmittedFileContentResult> {
  const encoded = encodeURIComponent(path);
  return useQuery({
    queryKey: ['sub', submissionId, 'submitted-content', path],
    queryFn: () =>
      apiFetch(
        `/submissions/${submissionId}/submitted-files/${encoded}`,
        undefined,
        SubmittedFileContentSchema,
      ),
    enabled: path.length > 0,
  });
}
```

Add both to the returned provider object. The `available: false` case is returned by the endpoint (HTTP 200 with `available:false`) when the blob is gone — see Task F3.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck --workspace=packages/analyzer`
Expected: PASS (both providers now satisfy the interface).

- [ ] **Step 3: Commit**

```bash
git add packages/analyzer/src/data/ApiSubmissionDataProvider.tsx
git commit --no-gpg-sign -m "feat(analyzer): API provider fetches submitted files + content"
```

### Task E4: Source tab UI

**Files:**

- Create: `packages/analyzer/src/views/submission/Source.tsx`, `Source.test.tsx`
- Modify: `packages/analyzer/src/views/submission/SubmissionShell.tsx`

- [ ] **Step 1: Write the failing test**

Create `Source.test.tsx` rendering `<Source />` inside a provider context (mirror `Validation.test.tsx`'s setup, which already mounts a provider). Assert it lists a file with a verdict badge and shows content on select:

```ts
it('lists submitted files with a verdict badge and shows content', async () => {
  renderWithProvider(<Source />, { /* in-memory 1.1 bundle: hw03.py match */ });
  expect(await screen.findByText('hw03.py')).toBeInTheDocument();
  expect(screen.getByTestId('verdict-hw03.py')).toHaveTextContent(/match/i);
  fireEvent.click(screen.getByText('hw03.py'));
  expect(await screen.findByText(/print\(1\)/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/analyzer -- Source.test.tsx`
Expected: FAIL — `Source` does not exist.

- [ ] **Step 3: Implement `Source.tsx`**

```tsx
import { useState } from 'react';
import { useSubmissionData } from '../../data/SubmissionDataProvider.js';

const VERDICT_STYLE: Record<string, string> = {
  match: 'text-green-700 bg-green-50',
  mismatch: 'text-red-700 bg-red-50',
  unknown: 'text-gray-600 bg-gray-100',
};

export function Source() {
  const provider = useSubmissionData();
  const filesQ = provider.useSubmittedFiles();
  const [selected, setSelected] = useState<string | null>(null);
  const contentQ = provider.useSubmittedFileContent(selected ?? '');

  if (filesQ.isLoading) return <div className="p-6 text-sm text-gray-500">Loading…</div>;
  if (filesQ.isError)
    return <div className="p-6 text-sm text-red-600">Failed to load submitted files.</div>;

  const data = filesQ.data;
  if (!data || !data.available) {
    return (
      <div className="p-6 text-sm text-gray-500">
        Submitted source is unavailable (the bundle has been retention-swept).
      </div>
    );
  }
  if (data.files.length === 0) {
    return (
      <div className="p-6 text-sm text-gray-500">
        This bundle carries no submission files (recorder format 1.0).
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <ul className="w-72 shrink-0 overflow-auto border-r border-gray-200 bg-white">
        {data.files.map((f) => (
          <li key={f.path}>
            <button
              onClick={() => setSelected(f.path)}
              className={`flex w-full items-center justify-between gap-2 px-4 py-2 text-left text-sm hover:bg-gray-50 ${selected === f.path ? 'bg-gray-100' : ''}`}
            >
              <span className="truncate font-mono">{f.path}</span>
              <span
                data-testid={`verdict-${f.path}`}
                className={`rounded px-1.5 py-0.5 text-xs ${VERDICT_STYLE[f.verdict]}`}
              >
                {f.status === 'missing' ? 'missing' : f.verdict}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="min-w-0 flex-1 overflow-auto bg-gray-50 p-4">
        {selected === null ? (
          <div className="text-sm text-gray-500">Select a file to view its submitted content.</div>
        ) : contentQ.isLoading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-xs">
            {contentQ.data?.content ?? ''}
          </pre>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Register the tab in `SubmissionShell.tsx`**

- Add `'source'` to the `SubmissionTab` type (line 32).
- Add `{ id: 'source', label: 'Source' }` to `ALL_TABS` (after `validation`).
- Add `'source'` to the `includes([...])` guard array (line ~38).
- Import `Source` and add the conditional render: `{activeTab === 'source' && <Source />}`.

- [ ] **Step 5: Run tests**

Run: `npm run test --workspace=packages/analyzer -- Source.test.tsx SubmissionShell.test.tsx`
Expected: PASS. (If `SubmissionShell.test.tsx` asserts the exact tab list, update it to include Source.)

- [ ] **Step 6: Commit**

```bash
git add packages/analyzer/src/views/submission/Source.tsx packages/analyzer/src/views/submission/Source.test.tsx packages/analyzer/src/views/submission/SubmissionShell.tsx
git commit --no-gpg-sign -m "feat(analyzer): Source tab shows submitted files + Check 8 verdict"
```

---

## Group F — server: ingest 1.1 + submitted-files endpoint

### Task F1: Shared response schemas

**Files:**

- Modify: `packages/shared/src/api-schemas.ts`

- [ ] **Step 1: Add Zod schemas (mirroring the existing schema style)**

```ts
export const SubmittedFileEntrySchema = z.object({
  path: z.string(),
  status: z.enum(['present', 'missing']),
  verdict: z.enum(['match', 'mismatch', 'unknown']),
  sha256: z.string().nullable(),
});
export type SubmittedFileEntry = z.infer<typeof SubmittedFileEntrySchema>;

export const SubmittedFileListSchema = z.object({
  available: z.boolean(),
  files: z.array(SubmittedFileEntrySchema),
});
export type SubmittedFileList = z.infer<typeof SubmittedFileListSchema>;

export const SubmittedFileContentSchema = z.object({
  path: z.string(),
  content: z.string(),
  status: z.enum(['present', 'missing']),
  verdict: z.enum(['match', 'mismatch', 'unknown']),
});
export type SubmittedFileContent = z.infer<typeof SubmittedFileContentSchema>;
```

- [ ] **Step 2: Typecheck shared**

Run: `npm run typecheck --workspace=packages/shared`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/api-schemas.ts
git commit --no-gpg-sign -m "feat(shared): submitted-files response schemas"
```

### Task F2: Server service — extract submitted files from a bundle blob

**Files:**

- Create: `packages/server/src/services/submissions/submitted-files.ts`, `...test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `submitted-files.test.ts`. This is a unit test over the extraction function (no DB): build a 1.1 bundle zip in-memory (reuse a recorder/analyzer fixture builder or construct via JSZip), wrap it as an `ArrayBuffer`, and assert extraction:

```ts
import { describe, it, expect } from 'vitest';
import { extractSubmittedFiles, extractSubmittedFileContent } from './submitted-files.js';

describe('extractSubmittedFiles', () => {
  it('returns per-file verdicts from a 1.1 bundle buffer', async () => {
    const buf = await buildBundleBuffer({
      /* hw03.py present, matches doc.save, chain ok */
    });
    const list = await extractSubmittedFiles(buf);
    expect(list.available).toBe(true);
    expect(list.files.find((f) => f.path === 'hw03.py')?.verdict).toBe('match');
  });

  it('returns the UTF-8 content of one file', async () => {
    const buf = await buildBundleBuffer({
      /* hw03.py = 'print(1)\n' */
    });
    const c = await extractSubmittedFileContent(buf, 'hw03.py');
    expect(c?.content).toBe('print(1)\n');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test --workspace=packages/server -- submitted-files.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement using the analyzer loader + shared verdict helper**

```ts
/**
 * Extract submitted files from a stored bundle blob on demand. Student source is
 * NEVER persisted in Postgres — it is read from the blob each time and dropped.
 * Returns available:false semantics handled by the caller when the blob is gone.
 */
import { loadBundle } from '@provenance/analyzer/src/loader/parse-bundle.js';
import { runValidation } from '@provenance/analyzer/src/validation/run-validation.js';
import { submittedFileVerdicts } from '@provenance/analyzer/src/validation/verify-submitted-code.js';
import type { SubmittedFileList, SubmittedFileContent } from '@provenance/shared/api-schemas';

export async function extractSubmittedFiles(blob: ArrayBuffer): Promise<SubmittedFileList> {
  const parsed = await loadBundle(blob, 'bundle.zip');
  if (!parsed.ok) return { available: true, files: [] };
  const bundle = parsed.value;
  const report = await runValidation(bundle);
  const chainIntact = report.checks.find((c) => c.id === 'chain_integrity')?.status === 'pass';
  const verdicts = submittedFileVerdicts(bundle, { chainIntact: chainIntact ?? false });
  return {
    available: true,
    files: verdicts.map((v) => ({
      path: v.path,
      status: v.status,
      verdict: v.verdict,
      sha256: v.submittedSha,
    })),
  };
}

export async function extractSubmittedFileContent(
  blob: ArrayBuffer,
  path: string,
): Promise<SubmittedFileContent | null> {
  const parsed = await loadBundle(blob, 'bundle.zip');
  if (!parsed.ok) return null;
  const bundle = parsed.value;
  const entry = bundle.submissionFiles.get(path);
  if (entry === undefined) return null;
  const report = await runValidation(bundle);
  const chainIntact = report.checks.find((c) => c.id === 'chain_integrity')?.status === 'pass';
  const v = submittedFileVerdicts(bundle, { chainIntact: chainIntact ?? false }).find(
    (x) => x.path === path,
  );
  const content = entry.bytes ? new TextDecoder().decode(entry.bytes) : '';
  return { path, content, status: entry.status, verdict: v?.verdict ?? 'unknown' };
}
```

> Confirm the server already imports analyzer internals via `@provenance/analyzer/src/...` (the ingest `parse-bundle-phase.ts` imports `loadBundle` and `Bundle` exactly this way — follow that path style).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test --workspace=packages/server -- submitted-files.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/services/submissions/submitted-files.ts packages/server/src/services/submissions/submitted-files.test.ts
git commit --no-gpg-sign -m "feat(server): extract submitted files from a bundle blob on demand"
```

### Task F3: Server routes

**Files:**

- Modify: `packages/server/src/api/v1/routes/submissions.ts`

- [ ] **Step 1: Add the two routes**

After the `GET /submissions/:submissionId/files` handler (ends at line 214), add two handlers following the SAME auth pattern (principal check → `resolveSemesterFromSubmission` → membership → `authorize` → 404 on failure). They additionally fetch the blob and 200 with `available:false` when the blob is gone:

```ts
import { getBlob } from '../../../services/storage/blobs.js';
import { bundleKey } from '../../../services/storage/keys.js';
import {
  extractSubmittedFiles,
  extractSubmittedFileContent,
} from '../../../services/submissions/submitted-files.js';

async function readBundleBlob(
  c: Context,
  semesterId: string,
  submissionId: string,
): Promise<ArrayBuffer | null> {
  try {
    const stream = await getBlob(c.var.storage, bundleKey(semesterId, submissionId));
    return await new Response(stream).arrayBuffer();
  } catch {
    return null; // blob gone (retention) or storage error
  }
}
```

> Confirm how the route accesses the storage client. Other code uses `c.var.storage` or a module getter (`getStorage()`); match whatever the ingest/finalize routes use. If routes don't have storage in context, import the storage singleton the same way `retention-sweep`/finalize obtains it.

```ts
router.get('/submissions/:submissionId/submitted-files', rateLimit('read.detail'), async (c) => {
  const submissionId = c.req.param('submissionId')!;
  const db = getDb();
  const principal = c.var.principal ?? null;
  if (principal === null) {
    const returnTo = encodeURIComponent(c.req.path);
    return c.json(
      Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
      401,
    );
  }
  const semesterId = await resolveSemesterFromSubmission(db, submissionId);
  if (semesterId === null) return c.json(Errors.notFound().toBody(), 404);
  const membership = await findMembership(c.var.membershipCache, db, principal.user.id, semesterId);
  if (!authorize(principal, 'read', { semesterId }, membership).ok)
    return c.json(Errors.notFound().toBody(), 404);

  const blob = await readBundleBlob(c, semesterId, submissionId);
  if (blob === null) return c.json({ available: false, files: [] });
  return c.json(await extractSubmittedFiles(blob));
});

router.get(
  '/submissions/:submissionId/submitted-files/:path',
  rateLimit('read.detail'),
  async (c) => {
    const submissionId = c.req.param('submissionId')!;
    const filePath = decodeURIComponent(c.req.param('path')!);
    const db = getDb();
    const principal = c.var.principal ?? null;
    if (principal === null) {
      const returnTo = encodeURIComponent(c.req.path);
      return c.json(
        Errors.authRequired(`/api/v1/auth/google/start?return_to=${returnTo}`).toBody(),
        401,
      );
    }
    const semesterId = await resolveSemesterFromSubmission(db, submissionId);
    if (semesterId === null) return c.json(Errors.notFound().toBody(), 404);
    const membership = await findMembership(
      c.var.membershipCache,
      db,
      principal.user.id,
      semesterId,
    );
    if (!authorize(principal, 'read', { semesterId }, membership).ok)
      return c.json(Errors.notFound().toBody(), 404);

    const blob = await readBundleBlob(c, semesterId, submissionId);
    if (blob === null) return c.json(Errors.notFound().toBody(), 404);
    const content = await extractSubmittedFileContent(blob, filePath);
    if (content === null) return c.json(Errors.notFound().toBody(), 404);
    return c.json(content);
  },
);
```

> Hono path note: `:path` matches a single segment. Submission paths can contain `/` (e.g. `lab02/q1.py`). The analyzer encodes the whole path with `encodeURIComponent` (so `/` → `%2F`); confirm the server/router decodes `%2F` back into the single `:path` param. If the proxy collapses `%2F`, switch to a wildcard route (`/submitted-files/*` and read `c.req.path`) — verify with the E2E test in Task G2 and adjust if a nested path 404s.

- [ ] **Step 2: Typecheck server**

Run: `npm run typecheck --workspace=packages/server`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/api/v1/routes/submissions.ts
git commit --no-gpg-sign -m "feat(server): submitted-files list + content routes (blob-backed)"
```

### Task F4: OpenAPI docs

**Files:**

- Modify: `packages/server/src/openapi/spec/paths-submissions.ts`, `packages/server/src/openapi/spec/components.ts`

- [ ] **Step 1: Add component schemas**

In `components.ts`, add `SubmittedFileList` and `SubmittedFileContent` schema objects mirroring the shared Zod shapes (the file hand-curates JSON Schema; follow the existing `SubmissionSummary` component entry as a template).

- [ ] **Step 2: Add path entries**

In `paths-submissions.ts`, add `'/submissions/{submissionId}/submitted-files'` (GET → `SubmittedFileList`) and `'/submissions/{submissionId}/submitted-files/{path}'` (GET → `SubmittedFileContent`, plus a `path` path-param), following the existing entries' shape (tags, security, 200/404 responses).

- [ ] **Step 3: Verify the OpenAPI spec still builds**

Run: `npm run test --workspace=packages/server -- openapi` (there is an openapi snapshot/validity test; if the snapshot changed intentionally, update it).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/openapi/spec/paths-submissions.ts packages/server/src/openapi/spec/components.ts
git commit --no-gpg-sign -m "docs(server): OpenAPI for submitted-files endpoints"
```

### Task F5: Ingest accepts 1.1 and persists Check 8

**Files:**

- Modify (only if needed): `packages/server/src/services/ingest/parse-bundle-phase.ts`, `packages/server/src/services/ingest/validation.ts`
- Test: an ingest test under `packages/server/test/` (integration) or the existing ingest unit tests.

- [ ] **Step 1: Confirm ingest already flows Check 8 through**

The ingest validation stage calls the analyzer `runValidation` and persists `check_8_status` (`validation.ts:64-95`), and the worker passes the report to heuristics so `integrityFlagsFromReport` surfaces flags (per `.notes/v3-progress.md:205`). Because Groups C/D already made `runValidation` produce a real Check 8 and added the `CHECK_META` entry, **ingest should need no code change** — the new behavior flows through automatically.

- [ ] **Step 2: Write a regression test proving it**

Add/extend an ingest test: ingest a 1.1 bundle whose submitted file was tampered (hash != last doc.save), assert `validation_results.check_8_status === 'fail'`, `overall === 'fail'`, and that a `flags` row with `heuristic_id = 'submitted_code_match'` exists. Also ingest a clean 1.1 bundle and assert `check_8_status === 'pass'`. Reuse the existing ingest test harness (testcontainers Postgres/MinIO).

Run: `npm run test --workspace=packages/server -- ingest`
Expected: PASS. If `parse-bundle-phase.ts` rejects 1.1 for any reason (e.g. a stale `format_version === '1.0'` assertion), fix it minimally and note it.

- [ ] **Step 3: Check the recorded `format_version` column**

`submissions.format_version` is written at finalize. Confirm it now stores `'1.1'` for new bundles (it reads from the manifest). No change expected; assert it in the test.

- [ ] **Step 4: Commit**

```bash
git add packages/server
git commit --no-gpg-sign -m "test(server): ingest runs Check 8 + flags submitted_code_match on 1.1 bundles"
```

---

## Group G — extension-hash allowlist + end-to-end

### Task G1: Rebuild recorder + refresh the hash allowlist

**Files:**

- Modify: `packages/analyzer/src/heuristics/config/known-good-extension-hashes.json`

- [ ] **Step 1: Build the recorder dist**

Run: `npm run build --workspace=packages/recorder` (or the esbuild dev-bundle step `npm run package:recorder` per README — match whatever `update-hashes` expects; `progress.md:119` says the default path bundles via esbuild matching the VSIX layout).

- [ ] **Step 2: Refresh the allowlist**

Run: `npm run update-hashes`
Expected: `known-good-extension-hashes.json` gains the new dev-build hash. Verify with `node scripts/update-extension-hash-allowlist.mjs --show`.

- [ ] **Step 3: Commit**

```bash
git add packages/analyzer/src/heuristics/config/known-good-extension-hashes.json
git commit --no-gpg-sign -m "chore(analyzer): refresh known-good extension hash for new recorder build"
```

### Task G2: End-to-end check + fixture regen

- [ ] **Step 1: Full workspace build + typecheck + lint**

Run: `npm run build && npm run typecheck && npm run lint`
Expected: all PASS.

- [ ] **Step 2: Full test suite**

Run: `npm run test`
Expected: PASS (~1200+ tests; Docker must be running for server integration). Triage any failure to the task that introduced it.

- [ ] **Step 3: Regenerate the analyzer integration fixture (1.1 bundle)**

Per `analyzer-progress.md:264`, the analyzer integration fixture is a real sealed `.zip`. Regenerate it with the new recorder so the fixture is a 1.1 bundle carrying submission files, following `packages/analyzer/test/integration/regenerate-fixture.md`. Commit the new fixture. If that doc's steps changed, update the doc.

- [ ] **Step 4: Manual smoke (optional but recommended)**

Start the analyzer (`npm run dev --workspace=packages/analyzer`), drop a freshly sealed 1.1 `.zip` on `/local`, open the **Source** tab, confirm files list with verdict badges and content render. Then verify the same in a server-backed submission drill-in.

- [ ] **Step 5: Commit any fixture changes**

```bash
git add packages/analyzer/test/fixtures packages/analyzer/test/integration
git commit --no-gpg-sign -m "test(analyzer): regenerate integration fixture as a 1.1 submission bundle"
```

---

## Self-Review notes (for the implementer)

- **Back-compat:** every change keeps 1.0 bundles working — the validator accepts `1.0`, `submission_files ?? []` yields an empty map, Check 8 skips, Source tab shows the "format 1.0" empty state. Don't break this; there are likely 1.0 fixtures in the suite.
- **Retention:** never persist submitted source in Postgres. The only source path is blob → extract → drop. The list/content endpoints return `available:false` / 404 when the blob is gone.
- **Behavior changes that intentionally flip existing assertions** (update them, don't weaken silently): seal no longer returns `chain_broken`; a clean **1.1** bundle's validation overall can now be `pass` (was always `warn`).
- **Check 8 name consistency:** the check id is `submitted_code_match` everywhere (ValidationCheck.id, CHECK_META key, heuristic id, KNOWN_HEURISTIC_IDS). The chain check id is `chain_integrity` (used to derive `chainIntact`). Verify these exact strings against `check-types.ts` before relying on them.

```

```
