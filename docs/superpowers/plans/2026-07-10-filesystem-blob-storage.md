# Filesystem-backed Blob Storage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Provenance server store and serve provenance bundles on a plain filesystem directory (the EECS apphost NFS mount) at full parity with the existing S3 backend, selectable at boot.

**Architecture:** `StorageClient` becomes a discriminated union `{ kind: 's3' } | { kind: 'fs' }`. Every existing free function (`putBlob`/`getBlob`/`deleteBlob`/`presignGetUrl` + the five multipart ops) gains a one-line dispatch guard so all ~30 call sites stay unchanged. Filesystem logic lives in two new sibling modules; a new self-authenticating HMAC download route replaces S3 presigned URLs; a pg-boss cron reaps orphaned multipart staging.

**Tech Stack:** TypeScript (strict, ESM), Node built-ins only (`node:fs/promises`, `node:crypto`, `node:path`, `node:stream`), Zod (config), Hono (routes), pg-boss (cron), Vitest.

## Global Constraints

- Scope is `packages/server/**` only. Do not touch `log-core`, `shared`, `analysis-core`, `analyzer`, `recorder`.
- **No new npm dependencies.** Node built-ins only.
- TypeScript strict mode. No `any` except at an FFI boundary with a comment. Prefer `unknown` + narrowing.
- Atomic writes everywhere a file is produced: write to `<path>.tmp-<uuid>` then `rename`. Never partial-write a live file.
- No `Date.now()` / `Math.random()` in **test assertions** — inject a clock (`now` param) and assert against fixed values. Runtime code may read the clock internally where it isn't asserted.
- Ordered assembly only: multipart parts are concatenated strictly by `partNumber`. No `Promise.all` over ordered work.
- The blob key layout in `keys.ts` is unchanged. Keys look like `semesters/{id}/submissions/{id}/bundle.zip`.
- The `GET /bundle` API response shape (`{ signedUrl, expiresAt }`) is unchanged.
- Commit after every task with `git commit --no-gpg-sign` and a conventional-commit message. No `Co-Authored-By` trailer.
- Verify commands from repo root: `npm run typecheck --workspace=packages/server`, `npm run lint --workspace=packages/server`. Single test file: `npm run test --workspace=packages/server -- <path-substring>`.

---

## File Structure

**Create:**

- `packages/server/src/services/storage/fs-blobs.ts` — put/get/delete, `resolveKeyPath`, and the URL sign/verify helpers.
- `packages/server/src/services/storage/fs-blobs.test.ts`
- `packages/server/src/services/storage/fs-multipart.ts` — the five multipart ops + `reapStaleUploads`.
- `packages/server/src/services/storage/fs-multipart.test.ts`
- `packages/server/src/api/v1/routes/blob-download.ts` — `GET /api/v1/blob` HMAC-verified stream.
- `packages/server/src/api/v1/routes/blob-download.test.ts`
- `packages/server/src/jobs/reap-stale-uploads.ts` — pg-boss handler factory.
- `packages/server/src/jobs/reap-stale-uploads.test.ts`

**Modify:**

- `packages/server/src/config/env.ts` — new vars + conditional `superRefine`.
- `packages/server/src/services/storage/client.ts` — union `StorageConfig` / `StorageClient`, branching factories.
- `packages/server/src/services/storage/client.test.ts` — narrow to `kind: 's3'`.
- `packages/server/src/services/storage/blobs.ts` — dispatch guards in the 4 ops.
- `packages/server/src/services/storage/multipart.ts` — dispatch guards in the 5 ops.
- `packages/server/src/api/v1/index.ts` — mount the blob-download router.
- `packages/server/src/jobs/pg-boss.ts` — new `REAP_STALE_UPLOADS` job kind.
- `packages/server/src/jobs/worker.ts` — createQueue + work + schedule for the reaper.
- `packages/server/.env.example` and `docs/admin-guide.md` — document the new vars + deployment note.

---

## Task 1: Backend selection — union config, union client, dispatch guards

Introduces the `fs` backend as _configurable and constructible_, with every free function dispatching. The `fs` path throws "not implemented" for now (filled in Tasks 2–4). At the end of this task the S3 backend is fully unchanged and green; the `fs` client can be built from env.

**Files:**

- Modify: `packages/server/src/config/env.ts`
- Modify: `packages/server/src/services/storage/client.ts`
- Modify: `packages/server/src/services/storage/client.test.ts`
- Modify: `packages/server/src/services/storage/blobs.ts`
- Modify: `packages/server/src/services/storage/multipart.ts`
- Test: `packages/server/src/config/env.test.ts` (add cases; file exists)

**Interfaces:**

- Produces:
  - `type StorageConfig = { kind: 's3'; endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string } | { kind: 'fs'; rootDir: string; signingSecret: string; publicBaseUrl: string }`
  - `type StorageClient = { kind: 's3'; aws: AwsClient; bucketUrl: string } | { kind: 'fs'; rootDir: string; signingSecret: string; publicBaseUrl: string }`
  - `storageConfigFromEnv(env: Env): StorageConfig`
  - `createStorageClient(cfg: StorageConfig): StorageClient`
  - env vars: `BLOB_STORAGE_BACKEND` (`'s3'|'fs'`, default `'s3'`), `BLOB_STORAGE_FS_ROOT?`, `BLOB_URL_SIGNING_SECRET?`, `BLOB_STORAGE_FS_STAGING_TTL_SECONDS` (int, default 86400).

- [ ] **Step 1: Write failing env-validation tests**

Add to `packages/server/src/config/env.test.ts` (the file already has a `VALID_BASE`-style fixture; if the local fixture name differs, reuse whatever the file already defines for a valid s3 env):

```ts
describe('BLOB_STORAGE_BACKEND', () => {
  it('defaults to s3 and requires OBJECT_STORAGE_* (present in base) ', () => {
    const env = parseEnv(VALID_BASE);
    expect(env.BLOB_STORAGE_BACKEND).toBe('s3');
  });

  it('rejects s3 backend missing OBJECT_STORAGE_BUCKET', () => {
    const { OBJECT_STORAGE_BUCKET: _omit, ...rest } = VALID_BASE;
    expect(() => parseEnv({ ...rest, BLOB_STORAGE_BACKEND: 's3' })).toThrow(/OBJECT_STORAGE/);
  });

  it('accepts fs backend with FS_ROOT + SIGNING_SECRET and no OBJECT_STORAGE_*', () => {
    const {
      OBJECT_STORAGE_ENDPOINT,
      OBJECT_STORAGE_BUCKET,
      OBJECT_STORAGE_ACCESS_KEY_ID,
      OBJECT_STORAGE_SECRET_ACCESS_KEY,
      ...rest
    } = VALID_BASE;
    const env = parseEnv({
      ...rest,
      BLOB_STORAGE_BACKEND: 'fs',
      BLOB_STORAGE_FS_ROOT: '/srv/provenance/blobs',
      BLOB_URL_SIGNING_SECRET: 'x'.repeat(32),
    });
    expect(env.BLOB_STORAGE_BACKEND).toBe('fs');
    expect(env.BLOB_STORAGE_FS_ROOT).toBe('/srv/provenance/blobs');
  });

  it('rejects fs backend missing BLOB_URL_SIGNING_SECRET', () => {
    expect(() =>
      parseEnv({
        ...VALID_BASE,
        BLOB_STORAGE_BACKEND: 'fs',
        BLOB_STORAGE_FS_ROOT: '/srv/provenance/blobs',
      }),
    ).toThrow(/BLOB_URL_SIGNING_SECRET/);
  });

  it('rejects fs backend with too-short signing secret', () => {
    expect(() =>
      parseEnv({
        ...VALID_BASE,
        BLOB_STORAGE_BACKEND: 'fs',
        BLOB_STORAGE_FS_ROOT: '/srv/provenance/blobs',
        BLOB_URL_SIGNING_SECRET: 'short',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace=packages/server -- src/config/env.test.ts`
Expected: FAIL (new cases error; `BLOB_STORAGE_BACKEND` undefined).

- [ ] **Step 3: Add env vars + conditional refine**

In `packages/server/src/config/env.ts`, inside `rawEnvSchema` (near the `OBJECT_STORAGE_*` block), relax the five S3 vars to optional and add the new vars:

```ts
  BLOB_STORAGE_BACKEND: z.enum(['s3', 'fs']).default('s3'),
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_REGION: z.string().min(1).default('auto'),
  OBJECT_STORAGE_BUCKET: z.string().min(1).optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  BLOB_STORAGE_FS_ROOT: z.string().min(1).optional(),
  BLOB_URL_SIGNING_SECRET: z.string().min(32).optional(),
  BLOB_STORAGE_FS_STAGING_TTL_SECONDS: intStr(86400),
```

(Delete the old non-optional `OBJECT_STORAGE_ENDPOINT/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY` lines — they are replaced above. Leave `OBJECT_STORAGE_REGION` as the defaulted line.)

Then in the `superRefine` (after the existing AUTH checks) add:

```ts
if (data.BLOB_STORAGE_BACKEND === 's3') {
  for (const k of [
    'OBJECT_STORAGE_ENDPOINT',
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ACCESS_KEY_ID',
    'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  ] as const) {
    if (!data[k]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [k],
        message: `${k} is required when BLOB_STORAGE_BACKEND is "s3"`,
      });
    }
  }
} else {
  if (!data.BLOB_STORAGE_FS_ROOT) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BLOB_STORAGE_FS_ROOT'],
      message: 'BLOB_STORAGE_FS_ROOT is required when BLOB_STORAGE_BACKEND is "fs"',
    });
  }
  if (!data.BLOB_URL_SIGNING_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['BLOB_URL_SIGNING_SECRET'],
      message: 'BLOB_URL_SIGNING_SECRET is required when BLOB_STORAGE_BACKEND is "fs"',
    });
  }
}
```

- [ ] **Step 4: Run env tests — expect PASS**

Run: `npm run test --workspace=packages/server -- src/config/env.test.ts`
Expected: PASS.

- [ ] **Step 5: Make `client.ts` a discriminated union**

Replace the body of `packages/server/src/services/storage/client.ts` interfaces + factories with:

```ts
import { AwsClient } from 'aws4fetch';
import type { Env } from '../../config/env.js';

export type StorageConfig =
  | {
      kind: 's3';
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
    }
  | { kind: 'fs'; rootDir: string; signingSecret: string; publicBaseUrl: string };

export type StorageClient =
  | { kind: 's3'; aws: AwsClient; bucketUrl: string }
  | { kind: 'fs'; rootDir: string; signingSecret: string; publicBaseUrl: string };

export function storageConfigFromEnv(env: Env): StorageConfig {
  if (env.BLOB_STORAGE_BACKEND === 'fs') {
    // superRefine guarantees these are present when backend is fs.
    return {
      kind: 'fs',
      rootDir: env.BLOB_STORAGE_FS_ROOT!,
      signingSecret: env.BLOB_URL_SIGNING_SECRET!,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    };
  }
  return {
    kind: 's3',
    endpoint: env.OBJECT_STORAGE_ENDPOINT!,
    region: env.OBJECT_STORAGE_REGION,
    bucket: env.OBJECT_STORAGE_BUCKET!,
    accessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY!,
  };
}

export function createStorageClient(cfg: StorageConfig): StorageClient {
  if (cfg.kind === 'fs') {
    return {
      kind: 'fs',
      rootDir: cfg.rootDir,
      signingSecret: cfg.signingSecret,
      publicBaseUrl: cfg.publicBaseUrl,
    };
  }
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
    service: 's3',
    retries: 0,
  });
  const base = cfg.endpoint.endsWith('/') ? cfg.endpoint.slice(0, -1) : cfg.endpoint;
  return { kind: 's3', aws, bucketUrl: `${base}/${cfg.bucket}` };
}
```

The non-null assertions on the s3 branch are safe because the `superRefine` fails the boot when they are absent; add a short comment saying so (shown above).

- [ ] **Step 6: Update `client.test.ts` to narrow on `kind`**

In `packages/server/src/services/storage/client.test.ts`, guard each field access. Replace each `const cfg = storageConfigFromEnv(env);` assertion block so it narrows first, e.g.:

```ts
it('extracts all OBJECT_STORAGE_* fields from a validated env', () => {
  const env = parseEnv(VALID_BASE);
  const cfg = storageConfigFromEnv(env);
  expect(cfg.kind).toBe('s3');
  if (cfg.kind !== 's3') throw new Error('expected s3');
  expect(cfg.endpoint).toBe('http://localhost:9000');
  expect(cfg.region).toBe('auto');
  expect(cfg.bucket).toBe('provenance');
  expect(cfg.accessKeyId).toBe('minioadmin');
  expect(cfg.secretAccessKey).toBe('minioadmin');
});
```

Apply the same `if (client.kind !== 's3') throw ...` narrowing before every `client.bucketUrl` / `client.aws` access in the `createStorageClient` describe block. Add one new test:

```ts
it('builds an fs client from an fs-backend env', () => {
  const {
    OBJECT_STORAGE_ENDPOINT,
    OBJECT_STORAGE_BUCKET,
    OBJECT_STORAGE_ACCESS_KEY_ID,
    OBJECT_STORAGE_SECRET_ACCESS_KEY,
    ...rest
  } = VALID_BASE;
  const env = parseEnv({
    ...rest,
    BLOB_STORAGE_BACKEND: 'fs',
    BLOB_STORAGE_FS_ROOT: '/srv/blobs',
    BLOB_URL_SIGNING_SECRET: 'y'.repeat(32),
  });
  const client = createStorageClient(storageConfigFromEnv(env));
  expect(client.kind).toBe('fs');
  if (client.kind !== 'fs') throw new Error('expected fs');
  expect(client.rootDir).toBe('/srv/blobs');
  expect(client.publicBaseUrl).toBe('http://localhost:3000');
});
```

- [ ] **Step 7: Add dispatch guards to `blobs.ts`**

In `packages/server/src/services/storage/blobs.ts`, add as the **first line inside each** of `putBlob`, `getBlob`, `presignGetUrl`, `deleteBlob`:

```ts
if (client.kind === 'fs') throw new Error('fs storage backend: not implemented yet');
```

After that guard, TypeScript narrows `client` to the s3 variant, so the existing `client.bucketUrl` / `client.aws` code compiles unchanged.

- [ ] **Step 8: Add dispatch guards to `multipart.ts`**

In `packages/server/src/services/storage/multipart.ts`, add the same first-line guard inside each of `createMultipartUpload`, `uploadPart`, `listParts`, `completeMultipartUpload`, `abortMultipartUpload`:

```ts
if (client.kind === 'fs') throw new Error('fs storage backend: not implemented yet');
```

- [ ] **Step 9: Typecheck, lint, run storage + config tests**

Run:

```bash
npm run typecheck --workspace=packages/server
npm run lint --workspace=packages/server
npm run test --workspace=packages/server -- src/config/ src/services/storage/client.test.ts
```

Expected: typecheck + lint clean; tests PASS. (The MinIO-backed `blobs.test.ts`/`multipart.test.ts` still pass because the s3 path is unchanged — run them too if Docker is available: `npm run test --workspace=packages/server -- src/services/storage/blobs.test.ts src/services/storage/multipart.test.ts`.)

- [ ] **Step 10: Commit**

```bash
git add packages/server/src/config/env.ts packages/server/src/config/env.test.ts \
  packages/server/src/services/storage/client.ts packages/server/src/services/storage/client.test.ts \
  packages/server/src/services/storage/blobs.ts packages/server/src/services/storage/multipart.ts
git commit --no-gpg-sign -m "feat(server): add fs blob-storage backend selection (config + client union)"
```

---

## Task 2: `fs-blobs.ts` — put / get / delete + path safety

**Files:**

- Create: `packages/server/src/services/storage/fs-blobs.ts`
- Create: `packages/server/src/services/storage/fs-blobs.test.ts`
- Modify: `packages/server/src/services/storage/blobs.ts` (replace 3 guards with real dispatch)

**Interfaces:**

- Consumes: `StorageClient` from `./client.js`; `PutBlobResult` from `./blobs.js`.
- Produces:
  - `resolveKeyPath(rootDir: string, key: string): string`
  - `fsPutBlob(client: FsClient, key: string, body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array): Promise<PutBlobResult>`
  - `fsGetBlob(client: FsClient, key: string): Promise<ReadableStream<Uint8Array>>`
  - `fsDeleteBlob(client: FsClient, key: string): Promise<void>`
  - where `type FsClient = Extract<StorageClient, { kind: 'fs' }>`
  - exported const `FS_STAGING_DIR = '.uploads'` (reused by Task 4).

- [ ] **Step 1: Write failing tests**

Create `packages/server/src/services/storage/fs-blobs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveKeyPath, fsPutBlob, fsGetBlob, fsDeleteBlob, FS_STAGING_DIR } from './fs-blobs.js';
import type { StorageClient } from './client.js';

async function tmpClient(): Promise<Extract<StorageClient, { kind: 'fs' }>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'prov-fs-'));
  return { kind: 'fs', rootDir, signingSecret: 's'.repeat(32), publicBaseUrl: 'http://x' };
}
function bytes(n: number, fill = 0x42): Uint8Array {
  const b = new Uint8Array(n);
  b.fill(fill);
  return b;
}
function sha(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}
async function collect(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

describe('resolveKeyPath', () => {
  it('rejects .. traversal', () => {
    expect(() => resolveKeyPath('/root', '../etc/passwd')).toThrow(/escapes/);
  });
  it('rejects absolute keys that escape', () => {
    expect(() => resolveKeyPath('/root', '/etc/passwd')).toThrow(/escapes/);
  });
  it('rejects reach into reserved staging dir', () => {
    expect(() => resolveKeyPath('/root', `${FS_STAGING_DIR}/x`)).toThrow(/staging/);
  });
  it('accepts a normal bundle key', () => {
    expect(resolveKeyPath('/root', 'semesters/a/submissions/b/bundle.zip')).toBe(
      '/root/semesters/a/submissions/b/bundle.zip',
    );
  });
});

describe('fsPutBlob / fsGetBlob', () => {
  it('round-trips a Uint8Array and reports sha256 + size', async () => {
    const c = await tmpClient();
    try {
      const data = bytes(1000);
      const res = await fsPutBlob(c, 'semesters/a/submissions/b/bundle.zip', data);
      expect(res.size).toBe(1000);
      expect(res.sha256).toBe(sha(data));
      const got = await collect(await fsGetBlob(c, 'semesters/a/submissions/b/bundle.zip'));
      expect(got).toEqual(data);
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('hashes a ReadableStream body correctly', async () => {
    const c = await tmpClient();
    try {
      const data = bytes(2048, 0x7);
      const stream = new ReadableStream<Uint8Array>({
        start(ctrl) {
          ctrl.enqueue(data);
          ctrl.close();
        },
      });
      const res = await fsPutBlob(c, 'k/x.zip', stream);
      expect(res.sha256).toBe(sha(data));
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('leaves no .tmp- file behind after a successful put', async () => {
    const c = await tmpClient();
    try {
      await fsPutBlob(c, 'flat.zip', bytes(10));
      const names = await readdir(c.rootDir);
      expect(names.some((n) => n.includes('.tmp-'))).toBe(false);
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('throws when getting a missing key', async () => {
    const c = await tmpClient();
    try {
      await expect(fsGetBlob(c, 'nope.zip')).rejects.toThrow();
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });
});

describe('fsDeleteBlob', () => {
  it('deletes an existing blob', async () => {
    const c = await tmpClient();
    try {
      await fsPutBlob(c, 'del.zip', bytes(4));
      await fsDeleteBlob(c, 'del.zip');
      await expect(fsGetBlob(c, 'del.zip')).rejects.toThrow();
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });
  it('is idempotent on a missing blob', async () => {
    const c = await tmpClient();
    try {
      await expect(fsDeleteBlob(c, 'ghost.zip')).resolves.toBeUndefined();
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace=packages/server -- src/services/storage/fs-blobs.test.ts`
Expected: FAIL (`fs-blobs.js` not found / exports undefined).

- [ ] **Step 3: Implement `fs-blobs.ts`**

Create `packages/server/src/services/storage/fs-blobs.ts`:

```ts
/**
 * Filesystem blob operations — the `fs` backend counterpart to blobs.ts.
 *
 * Blobs are ordinary files under `rootDir`, addressed by the same keys keys.ts
 * produces. Writes are atomic (temp-then-rename). `resolveKeyPath` is the single
 * safety gate: it rejects any key that escapes `rootDir` or reaches into the
 * reserved multipart staging tree.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { dirname, resolve, sep } from 'node:path';
import type { StorageClient } from './client.js';
import type { PutBlobResult } from './blobs.js';

type FsClient = Extract<StorageClient, { kind: 'fs' }>;

/** Reserved subdirectory of rootDir used for multipart part staging (Task 4). */
export const FS_STAGING_DIR = '.uploads';

/**
 * Map a storage key to an absolute on-disk path, rejecting traversal.
 * Rejects keys that escape `rootDir` or target the reserved staging tree.
 */
export function resolveKeyPath(rootDir: string, key: string): string {
  const root = resolve(rootDir);
  const full = resolve(root, key);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`fs storage: key "${key}" escapes storage root`);
  }
  const rel = full.slice(root.length + 1);
  if (rel === FS_STAGING_DIR || rel.startsWith(FS_STAGING_DIR + sep)) {
    throw new Error(`fs storage: key "${key}" targets reserved staging area`);
  }
  return full;
}

export async function fsPutBlob(
  client: FsClient,
  key: string,
  body: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
): Promise<PutBlobResult> {
  const path = resolveKeyPath(client.rootDir, key);
  const hasher = createHash('sha256');
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (body instanceof ReadableStream) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      size += value.byteLength;
      chunks.push(value);
    }
  } else {
    const b = body instanceof ArrayBuffer ? new Uint8Array(body) : body;
    hasher.update(b);
    size = b.byteLength;
    chunks.push(b);
  }

  const combined = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    combined.set(c, offset);
    offset += c.byteLength;
  }
  const sha256 = hasher.digest('hex');

  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, combined);
  await rename(tmp, path);
  return { sha256, size };
}

export async function fsGetBlob(
  client: FsClient,
  key: string,
): Promise<ReadableStream<Uint8Array>> {
  const path = resolveKeyPath(client.rootDir, key);
  // stat first so a missing file throws synchronously (matches S3 throw-on-404).
  await stat(path);
  return Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
}

export async function fsDeleteBlob(client: FsClient, key: string): Promise<void> {
  const path = resolveKeyPath(client.rootDir, key);
  try {
    await unlink(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm run test --workspace=packages/server -- src/services/storage/fs-blobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire dispatch in `blobs.ts`**

In `packages/server/src/services/storage/blobs.ts`:

1. Add import at the top: `import { fsPutBlob, fsGetBlob, fsDeleteBlob } from './fs-blobs.js';`
2. Replace the guard line in `putBlob` with: `if (client.kind === 'fs') return fsPutBlob(client, key, body);`
3. Replace the guard line in `getBlob` with: `if (client.kind === 'fs') return fsGetBlob(client, key);`
4. Replace the guard line in `deleteBlob` with: `if (client.kind === 'fs') return fsDeleteBlob(client, key);`
5. Leave `presignGetUrl`'s `throw` guard as-is (handled in Task 3).

- [ ] **Step 6: Typecheck, lint, test**

Run:

```bash
npm run typecheck --workspace=packages/server
npm run lint --workspace=packages/server
npm run test --workspace=packages/server -- src/services/storage/fs-blobs.test.ts
```

Expected: all clean/PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/storage/fs-blobs.ts \
  packages/server/src/services/storage/fs-blobs.test.ts \
  packages/server/src/services/storage/blobs.ts
git commit --no-gpg-sign -m "feat(server): fs blob put/get/delete with path-traversal guard"
```

---

## Task 3: Presigned URL signing + `GET /api/v1/blob` download route

**Files:**

- Modify: `packages/server/src/services/storage/fs-blobs.ts` (add sign/verify + `fsPresignGetUrl`)
- Modify: `packages/server/src/services/storage/fs-blobs.test.ts` (add sign/verify tests)
- Modify: `packages/server/src/services/storage/blobs.ts` (wire presign dispatch)
- Create: `packages/server/src/api/v1/routes/blob-download.ts`
- Create: `packages/server/src/api/v1/routes/blob-download.test.ts`
- Modify: `packages/server/src/api/v1/index.ts` (mount router)

**Interfaces:**

- Produces:
  - `signBlobUrl(secret: string, key: string, expEpochSec: number): { d: string; s: string }`
  - `verifyBlobUrl(secret: string, d: string, s: string, nowEpochSec: number): { ok: true; key: string } | { ok: false; reason: 'bad_signature' | 'expired' | 'malformed' }`
  - `fsPresignGetUrl(client: FsClient, key: string, ttlSeconds: number): Promise<string>`
  - `createBlobDownloadRouter(): Hono`

- [ ] **Step 1: Write failing sign/verify tests**

Append to `packages/server/src/services/storage/fs-blobs.test.ts`:

```ts
import { signBlobUrl, verifyBlobUrl, fsPresignGetUrl } from './fs-blobs.js';

describe('signBlobUrl / verifyBlobUrl', () => {
  const secret = 'k'.repeat(32);
  it('verifies a freshly signed token', () => {
    const { d, s } = signBlobUrl(secret, 'a/b.zip', 2000);
    const res = verifyBlobUrl(secret, d, s, 1000);
    expect(res).toEqual({ ok: true, key: 'a/b.zip' });
  });
  it('rejects an expired token', () => {
    const { d, s } = signBlobUrl(secret, 'a/b.zip', 1000);
    expect(verifyBlobUrl(secret, d, s, 1000)).toEqual({ ok: false, reason: 'expired' });
  });
  it('rejects a tampered payload', () => {
    const { d, s } = signBlobUrl(secret, 'a/b.zip', 2000);
    const forged = Buffer.from(JSON.stringify({ k: 'other.zip', e: 2000 })).toString('base64url');
    expect(verifyBlobUrl(secret, forged, s, 1000)).toEqual({ ok: false, reason: 'bad_signature' });
  });
  it('rejects a wrong secret', () => {
    const { d, s } = signBlobUrl(secret, 'a/b.zip', 2000);
    expect(verifyBlobUrl('w'.repeat(32), d, s, 1000)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
  it('rejects garbage signature without throwing', () => {
    const { d } = signBlobUrl(secret, 'a/b.zip', 2000);
    expect(verifyBlobUrl(secret, d, '!!!not-base64!!!', 1000).ok).toBe(false);
  });
});

describe('fsPresignGetUrl', () => {
  it('builds a PUBLIC_BASE_URL-rooted /api/v1/blob URL', async () => {
    const c: Extract<StorageClient, { kind: 'fs' }> = {
      kind: 'fs',
      rootDir: '/x',
      signingSecret: 'k'.repeat(32),
      publicBaseUrl: 'http://host:3000',
    };
    const url = await fsPresignGetUrl(c, 'a/b.zip', 300);
    expect(url.startsWith('http://host:3000/api/v1/blob?d=')).toBe(true);
    expect(url).toContain('&s=');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace=packages/server -- src/services/storage/fs-blobs.test.ts`
Expected: FAIL (new exports undefined).

- [ ] **Step 3: Implement sign/verify + presign in `fs-blobs.ts`**

Add to `packages/server/src/services/storage/fs-blobs.ts` (extend the existing imports to include `createHmac, timingSafeEqual`):

```ts
// at top: import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

interface BlobUrlPayload {
  k: string; // key
  e: number; // expiry, epoch seconds
}

/** Sign a blob key + expiry into base64url payload (`d`) and HMAC signature (`s`). */
export function signBlobUrl(
  secret: string,
  key: string,
  expEpochSec: number,
): { d: string; s: string } {
  const payload: BlobUrlPayload = { k: key, e: expEpochSec };
  const d = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const s = createHmac('sha256', secret).update(d).digest().toString('base64url');
  return { d, s };
}

/** Verify a signed blob URL. Timing-safe; never throws. */
export function verifyBlobUrl(
  secret: string,
  d: string,
  s: string,
  nowEpochSec: number,
): { ok: true; key: string } | { ok: false; reason: 'bad_signature' | 'expired' | 'malformed' } {
  const expected = createHmac('sha256', secret).update(d).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(s, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let payload: BlobUrlPayload;
  try {
    payload = JSON.parse(Buffer.from(d, 'base64url').toString('utf8')) as BlobUrlPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.k !== 'string' || typeof payload.e !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (nowEpochSec >= payload.e) return { ok: false, reason: 'expired' };
  return { ok: true, key: payload.k };
}

/** Mint a self-authenticating, TTL-bounded download URL back to our own server. */
export async function fsPresignGetUrl(
  client: FsClient,
  key: string,
  ttlSeconds: number,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const { d, s } = signBlobUrl(client.signingSecret, key, nowSec + ttlSeconds);
  const base = client.publicBaseUrl.endsWith('/')
    ? client.publicBaseUrl.slice(0, -1)
    : client.publicBaseUrl;
  return `${base}/api/v1/blob?d=${d}&s=${s}`;
}
```

Note: `verifyBlobUrl` is pure and clock-injected (`nowEpochSec`); `fsPresignGetUrl` reads the clock internally (not asserted on time in tests — the test only checks URL shape).

- [ ] **Step 4: Run sign/verify tests — expect PASS**

Run: `npm run test --workspace=packages/server -- src/services/storage/fs-blobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire presign dispatch in `blobs.ts`**

In `packages/server/src/services/storage/blobs.ts`: add `fsPresignGetUrl` to the `./fs-blobs.js` import, and replace `presignGetUrl`'s `throw` guard with:

```ts
if (client.kind === 'fs') return fsPresignGetUrl(client, key, ttlSeconds);
```

- [ ] **Step 6: Write failing route test**

Create `packages/server/src/api/v1/routes/blob-download.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobDownloadRouter } from './blob-download.js';
import { fsPutBlob, signBlobUrl } from '../../../services/storage/fs-blobs.js';
import type { StorageClient } from '../../../services/storage/client.js';

const SECRET = 'z'.repeat(32);

async function setup(): Promise<{
  client: Extract<StorageClient, { kind: 'fs' }>;
  app: ReturnType<typeof createBlobDownloadRouter>;
}> {
  const rootDir = await mkdtemp(join(tmpdir(), 'prov-blobroute-'));
  const client: Extract<StorageClient, { kind: 'fs' }> = {
    kind: 'fs',
    rootDir,
    signingSecret: SECRET,
    publicBaseUrl: 'http://host',
  };
  // Inject the client via a factory arg so the test needs no env/config.
  const app = createBlobDownloadRouter(() => client);
  return { client, app };
}

function farFuture(): number {
  return 4_000_000_000;
}

describe('GET /api/v1/blob', () => {
  it('streams the blob for a valid token', async () => {
    const { client, app } = await setup();
    try {
      const data = new Uint8Array([1, 2, 3, 4]);
      await fsPutBlob(client, 'a/b.zip', data);
      const { d, s } = signBlobUrl(SECRET, 'a/b.zip', farFuture());
      const res = await app.request(`/api/v1/blob?d=${d}&s=${s}`);
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });

  it('returns 403 for an expired token', async () => {
    const { client, app } = await setup();
    try {
      await fsPutBlob(client, 'a/b.zip', new Uint8Array([9]));
      const { d, s } = signBlobUrl(SECRET, 'a/b.zip', 1); // exp in the past
      const res = await app.request(`/api/v1/blob?d=${d}&s=${s}`);
      expect(res.status).toBe(403);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });

  it('returns 403 for a tampered signature', async () => {
    const { client, app } = await setup();
    try {
      await fsPutBlob(client, 'a/b.zip', new Uint8Array([9]));
      const { d } = signBlobUrl(SECRET, 'a/b.zip', farFuture());
      const res = await app.request(`/api/v1/blob?d=${d}&s=deadbeef`);
      expect(res.status).toBe(403);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });

  it('returns 404 for a valid token to a missing file', async () => {
    const { client, app } = await setup();
    try {
      const { d, s } = signBlobUrl(SECRET, 'gone.zip', farFuture());
      const res = await app.request(`/api/v1/blob?d=${d}&s=${s}`);
      expect(res.status).toBe(404);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });

  it('returns 400 when d or s is missing', async () => {
    const { client, app } = await setup();
    try {
      const res = await app.request(`/api/v1/blob?d=only-d`);
      expect(res.status).toBe(400);
    } finally {
      await rm(client.rootDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 7: Run to verify failure**

Run: `npm run test --workspace=packages/server -- src/api/v1/routes/blob-download.test.ts`
Expected: FAIL (`blob-download.js` not found).

- [ ] **Step 8: Implement the route**

Create `packages/server/src/api/v1/routes/blob-download.ts`. The factory takes an optional `getClient` override so the test can inject an fs client without env; in production it defaults to `getStorageClient()`.

```ts
/**
 * GET /api/v1/blob — self-authenticating blob download for the fs backend.
 *
 * The HMAC token in the query string IS the credential (no session/token auth),
 * mirroring S3 presigned-URL semantics: an unauthenticated, TTL-bounded read of
 * one blob key. Only fs-backend presigned URLs point here; under the s3 backend
 * nothing mints these URLs, so the route is never exercised.
 */

import { Hono } from 'hono';
import { verifyBlobUrl } from '../../../services/storage/fs-blobs.js';
import { getBlob } from '../../../services/storage/blobs.js';
import { getStorageClient } from '../../../services/storage/default-client.js';
import { getConfig } from '../../../config/index.js';
import type { StorageClient } from '../../../services/storage/client.js';

export function createBlobDownloadRouter(getClient: () => StorageClient = getStorageClient): Hono {
  const router = new Hono();

  router.get('/blob', async (c) => {
    const d = c.req.query('d');
    const s = c.req.query('s');
    if (!d || !s) {
      return c.json({ error: 'missing signature parameters' }, 400);
    }

    const client = getClient();
    if (client.kind !== 'fs') {
      // Route only meaningful under the fs backend.
      return c.json({ error: 'not found' }, 404);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const verdict = verifyBlobUrl(client.signingSecret, d, s, nowSec);
    if (!verdict.ok) {
      return c.json({ error: 'invalid or expired link' }, 403);
    }

    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await getBlob(client, verdict.key);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }

    c.header('content-type', 'application/octet-stream');
    return c.body(stream);
  });

  return router;
}
```

Note: `getConfig` import is only needed if you later want TTL clamping; if unused, drop the import to satisfy lint. (TTL is enforced at mint time in `bundle.ts`, so no clamp is needed here — remove the `getConfig` import.)

- [ ] **Step 9: Run route test — expect PASS**

Run: `npm run test --workspace=packages/server -- src/api/v1/routes/blob-download.test.ts`
Expected: PASS.

- [ ] **Step 10: Mount the router**

In `packages/server/src/api/v1/index.ts`:

1. Add import near the other route imports: `import { createBlobDownloadRouter } from './routes/blob-download.js';`
2. Add a mount line alongside the others (the router defines the full `/blob` path, so mount at `'/'`): `app.route('/', createBlobDownloadRouter());`

Confirm no global session-auth middleware wraps these routers (the existing `createBundleRouter` does its own in-handler auth, so route registration is not behind a global gate). If a global auth middleware exists that would 401 this route, mount `createBlobDownloadRouter()` **before** it. Verify by grepping `index.ts` for `use(` middleware ordering.

- [ ] **Step 11: Typecheck, lint, test**

Run:

```bash
npm run typecheck --workspace=packages/server
npm run lint --workspace=packages/server
npm run test --workspace=packages/server -- src/services/storage/fs-blobs.test.ts src/api/v1/routes/blob-download.test.ts
```

Expected: all clean/PASS.

- [ ] **Step 12: Commit**

```bash
git add packages/server/src/services/storage/fs-blobs.ts \
  packages/server/src/services/storage/fs-blobs.test.ts \
  packages/server/src/services/storage/blobs.ts \
  packages/server/src/api/v1/routes/blob-download.ts \
  packages/server/src/api/v1/routes/blob-download.test.ts \
  packages/server/src/api/v1/index.ts
git commit --no-gpg-sign -m "feat(server): fs presigned URLs + self-authenticating /api/v1/blob route"
```

---

## Task 4: `fs-multipart.ts` — resumable upload parity

**Files:**

- Create: `packages/server/src/services/storage/fs-multipart.ts`
- Create: `packages/server/src/services/storage/fs-multipart.test.ts`
- Modify: `packages/server/src/services/storage/multipart.ts` (replace 5 guards with real dispatch)

**Interfaces:**

- Consumes: `StorageClient` from `./client.js`; `UploadedPart` from `./multipart.js`; `resolveKeyPath`, `FS_STAGING_DIR` from `./fs-blobs.js`.
- Produces (`FsClient = Extract<StorageClient, { kind: 'fs' }>`):
  - `fsCreateMultipartUpload(client: FsClient, key: string): Promise<string>`
  - `fsUploadPart(client: FsClient, key: string, uploadId: string, partNumber: number, body: ArrayBuffer | Uint8Array): Promise<string>`
  - `fsListParts(client: FsClient, key: string, uploadId: string): Promise<UploadedPart[]>`
  - `fsCompleteMultipartUpload(client: FsClient, key: string, uploadId: string, parts: UploadedPart[]): Promise<void>`
  - `fsAbortMultipartUpload(client: FsClient, key: string, uploadId: string): Promise<void>`
  - `reapStaleUploads(client: StorageClient, opts: { now: number; maxAgeMs: number }): Promise<{ reaped: number; errors: number }>` (used in Task 5)
  - `stagingRootPath(rootDir: string): string` (used by the reaper + tests)

- [ ] **Step 1: Write failing multipart tests**

Create `packages/server/src/services/storage/fs-multipart.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fsCreateMultipartUpload,
  fsUploadPart,
  fsListParts,
  fsCompleteMultipartUpload,
  fsAbortMultipartUpload,
  stagingRootPath,
} from './fs-multipart.js';
import { fsGetBlob } from './fs-blobs.js';
import type { StorageClient } from './client.js';

async function tmpClient(): Promise<Extract<StorageClient, { kind: 'fs' }>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'prov-mp-'));
  return { kind: 'fs', rootDir, signingSecret: 's'.repeat(32), publicBaseUrl: 'http://x' };
}
function bytes(n: number, fill: number): Uint8Array {
  const b = new Uint8Array(n);
  b.fill(fill);
  return b;
}
async function collect(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((a, c) => a + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}
async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe('fs multipart round-trip', () => {
  it('assembles parts in partNumber order regardless of upload order', async () => {
    const c = await tmpClient();
    try {
      const key = 'ingest-uploads/sem/u.zip';
      const uploadId = await fsCreateMultipartUpload(c, key);
      // Upload out of order: part 2 then part 1.
      const p2 = bytes(8, 0x22);
      const p1 = bytes(8, 0x11);
      const e2 = await fsUploadPart(c, key, uploadId, 2, p2);
      const e1 = await fsUploadPart(c, key, uploadId, 1, p1);
      const parts = await fsListParts(c, key, uploadId);
      expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);
      expect(parts[0].size).toBe(8);
      await fsCompleteMultipartUpload(c, key, uploadId, [
        { partNumber: 1, etag: e1, size: 8 },
        { partNumber: 2, etag: e2, size: 8 },
      ]);
      const got = await collect(await fsGetBlob(c, key));
      const expected = new Uint8Array(16);
      expected.set(p1, 0);
      expected.set(p2, 8);
      expect(got).toEqual(expected);
      // Staging removed after complete.
      expect(await exists(join(stagingRootPath(c.rootDir), uploadId))).toBe(false);
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('listParts drives resume (only missing parts remain to send)', async () => {
    const c = await tmpClient();
    try {
      const key = 'k.zip';
      const uploadId = await fsCreateMultipartUpload(c, key);
      await fsUploadPart(c, key, uploadId, 1, bytes(4, 1));
      await fsUploadPart(c, key, uploadId, 3, bytes(4, 3));
      const have = new Set((await fsListParts(c, key, uploadId)).map((p) => p.partNumber));
      const missing = [1, 2, 3].filter((n) => !have.has(n));
      expect(missing).toEqual([2]);
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('abort removes the staging dir and is idempotent', async () => {
    const c = await tmpClient();
    try {
      const uploadId = await fsCreateMultipartUpload(c, 'k.zip');
      await fsUploadPart(c, 'k.zip', uploadId, 1, bytes(4, 1));
      await fsAbortMultipartUpload(c, 'k.zip', uploadId);
      expect(await exists(join(stagingRootPath(c.rootDir), uploadId))).toBe(false);
      await expect(fsAbortMultipartUpload(c, 'k.zip', uploadId)).resolves.toBeUndefined();
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace=packages/server -- src/services/storage/fs-multipart.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `fs-multipart.ts`**

Create `packages/server/src/services/storage/fs-multipart.ts`:

```ts
/**
 * Filesystem multipart upload — the `fs` backend counterpart to multipart.ts.
 *
 * Parts stage under `<rootDir>/.uploads/<uploadId>/<partNumber>.part`, with a
 * `meta.json` recording the key + createdAt. `resolveKeyPath` excludes `.uploads`,
 * so staging never collides with stored bundles. `complete` concatenates parts in
 * partNumber order into the final key (atomic rename). `reapStaleUploads` reclaims
 * staging dirs abandoned by a crashed upload.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { pipeline } from 'node:stream/promises';
import { dirname, join, resolve } from 'node:path';
import type { StorageClient } from './client.js';
import type { UploadedPart } from './multipart.js';
import { FS_STAGING_DIR, resolveKeyPath } from './fs-blobs.js';

type FsClient = Extract<StorageClient, { kind: 'fs' }>;

/** Absolute path of the reserved staging root under a storage root. */
export function stagingRootPath(rootDir: string): string {
  return join(resolve(rootDir), FS_STAGING_DIR);
}

/** uploadId is a server-generated UUID; reject anything else defensively. */
function stagingDir(rootDir: string, uploadId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)) {
    throw new Error(`fs multipart: invalid uploadId`);
  }
  return join(stagingRootPath(rootDir), uploadId);
}

function etagOf(bytes: Uint8Array): string {
  return `"${createHash('sha256').update(bytes).digest('hex')}"`;
}

export async function fsCreateMultipartUpload(client: FsClient, key: string): Promise<string> {
  const uploadId = randomUUID();
  const dir = stagingDir(client.rootDir, uploadId);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'meta.json'),
    JSON.stringify({ key, createdAt: new Date().toISOString() }),
  );
  return uploadId;
}

export async function fsUploadPart(
  client: FsClient,
  _key: string,
  uploadId: string,
  partNumber: number,
  body: ArrayBuffer | Uint8Array,
): Promise<string> {
  if (!Number.isInteger(partNumber) || partNumber < 1) {
    throw new Error(`fs multipart: invalid partNumber ${partNumber}`);
  }
  const dir = stagingDir(client.rootDir, uploadId);
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);
  const dest = join(dir, `${partNumber}.part`);
  const tmp = `${dest}.tmp-${randomUUID()}`;
  await writeFile(tmp, bytes);
  await rename(tmp, dest);
  return etagOf(bytes);
}

export async function fsListParts(
  client: FsClient,
  _key: string,
  uploadId: string,
): Promise<UploadedPart[]> {
  const dir = stagingDir(client.rootDir, uploadId);
  const entries = await readdir(dir);
  const parts: UploadedPart[] = [];
  for (const name of entries) {
    const m = /^(\d+)\.part$/.exec(name);
    if (!m) continue;
    const buf = await readFile(join(dir, name));
    parts.push({ partNumber: parseInt(m[1]!, 10), etag: etagOf(buf), size: buf.byteLength });
  }
  parts.sort((a, b) => a.partNumber - b.partNumber);
  return parts;
}

export async function fsCompleteMultipartUpload(
  client: FsClient,
  key: string,
  uploadId: string,
  parts: UploadedPart[],
): Promise<void> {
  const dir = stagingDir(client.rootDir, uploadId);
  const finalPath = resolveKeyPath(client.rootDir, key);
  await mkdir(dirname(finalPath), { recursive: true });

  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const tmp = `${finalPath}.tmp-${randomUUID()}`;
  const out = createWriteStream(tmp);
  try {
    for (const p of sorted) {
      await pipeline(createReadStream(join(dir, `${p.partNumber}.part`)), out, { end: false });
    }
    out.end();
    await once(out, 'finish');
  } catch (err) {
    out.destroy();
    await rm(tmp, { force: true });
    throw err;
  }
  await rename(tmp, finalPath);
  await rm(dir, { recursive: true, force: true });
}

export async function fsAbortMultipartUpload(
  client: FsClient,
  _key: string,
  uploadId: string,
): Promise<void> {
  const dir = stagingDir(client.rootDir, uploadId);
  await rm(dir, { recursive: true, force: true }); // idempotent
}

/**
 * Reclaim staging dirs older than `maxAgeMs`. No-op unless the client is fs.
 * Clock is injected (`now`, epoch ms) so it is deterministically testable.
 */
export async function reapStaleUploads(
  client: StorageClient,
  opts: { now: number; maxAgeMs: number },
): Promise<{ reaped: number; errors: number }> {
  if (client.kind !== 'fs') return { reaped: 0, errors: 0 };
  const base = stagingRootPath(client.rootDir);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { reaped: 0, errors: 0 };
    throw err;
  }

  let reaped = 0;
  let errors = 0;
  for (const name of entries) {
    const dir = join(base, name);
    try {
      let createdAtMs: number;
      try {
        const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as {
          createdAt?: string;
        };
        createdAtMs = meta.createdAt ? Date.parse(meta.createdAt) : NaN;
        if (Number.isNaN(createdAtMs)) throw new Error('bad createdAt');
      } catch {
        createdAtMs = (await stat(dir)).mtimeMs;
      }
      if (opts.now - createdAtMs > opts.maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        reaped += 1;
      }
    } catch {
      errors += 1;
    }
  }
  return { reaped, errors };
}
```

- [ ] **Step 4: Run multipart tests — expect PASS**

Run: `npm run test --workspace=packages/server -- src/services/storage/fs-multipart.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire dispatch in `multipart.ts`**

In `packages/server/src/services/storage/multipart.ts`:

1. Add import: `import { fsCreateMultipartUpload, fsUploadPart, fsListParts, fsCompleteMultipartUpload, fsAbortMultipartUpload } from './fs-multipart.js';`
2. Replace each op's `throw` guard with the fs dispatch:
   - `createMultipartUpload`: `if (client.kind === 'fs') return fsCreateMultipartUpload(client, key);`
   - `uploadPart`: `if (client.kind === 'fs') return fsUploadPart(client, key, uploadId, partNumber, body);`
   - `listParts`: `if (client.kind === 'fs') return fsListParts(client, key, uploadId);`
   - `completeMultipartUpload`: `if (client.kind === 'fs') return fsCompleteMultipartUpload(client, key, uploadId, parts);`
   - `abortMultipartUpload`: `if (client.kind === 'fs') return fsAbortMultipartUpload(client, key, uploadId);`

- [ ] **Step 6: Typecheck, lint, test**

Run:

```bash
npm run typecheck --workspace=packages/server
npm run lint --workspace=packages/server
npm run test --workspace=packages/server -- src/services/storage/fs-multipart.test.ts
```

Expected: all clean/PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/storage/fs-multipart.ts \
  packages/server/src/services/storage/fs-multipart.test.ts \
  packages/server/src/services/storage/multipart.ts
git commit --no-gpg-sign -m "feat(server): fs multipart upload parity + stale-upload reaper fn"
```

---

## Task 5: Reaper cron — pg-boss job kind + worker wiring

**Files:**

- Create: `packages/server/src/jobs/reap-stale-uploads.ts`
- Create: `packages/server/src/jobs/reap-stale-uploads.test.ts`
- Modify: `packages/server/src/jobs/pg-boss.ts` (job kind)
- Modify: `packages/server/src/jobs/worker.ts` (createQueue + work + schedule)

**Interfaces:**

- Consumes: `reapStaleUploads` from `../services/storage/fs-multipart.js`; `StorageClient` from `../services/storage/client.js`.
- Produces: `createReapStaleUploadsHandler(storage: StorageClient, maxAgeMs: number): () => Promise<void>`; `JOB_KINDS.REAP_STALE_UPLOADS = 'reap_stale_uploads'`.

- [ ] **Step 1: Write failing handler test**

Create `packages/server/src/jobs/reap-stale-uploads.test.ts`. It drives the underlying `reapStaleUploads` with a fixed clock via real staging dirs (the handler just wraps it with `Date.now()`, which we don't assert on):

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapStaleUploads } from '../services/storage/fs-multipart.js';
import { stagingRootPath } from '../services/storage/fs-multipart.js';
import type { StorageClient } from '../services/storage/client.js';

async function fsClientWithStaging(
  dirs: { id: string; createdAt: string }[],
): Promise<Extract<StorageClient, { kind: 'fs' }>> {
  const rootDir = await mkdtemp(join(tmpdir(), 'prov-reap-'));
  for (const d of dirs) {
    const dir = join(stagingRootPath(rootDir), d.id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ key: 'k', createdAt: d.createdAt }));
  }
  return { kind: 'fs', rootDir, signingSecret: 's'.repeat(32), publicBaseUrl: 'http://x' };
}

const NOW = Date.parse('2026-07-10T12:00:00Z');
const DAY = 86400 * 1000;

describe('reapStaleUploads', () => {
  it('reaps dirs older than maxAge and keeps fresh ones', async () => {
    const c = await fsClientWithStaging([
      { id: '11111111-1111-4111-8111-111111111111', createdAt: '2026-07-08T12:00:00Z' }, // 2d old
      { id: '22222222-2222-4222-8222-222222222222', createdAt: '2026-07-10T11:59:00Z' }, // 1m old
    ]);
    try {
      const res = await reapStaleUploads(c, { now: NOW, maxAgeMs: DAY });
      expect(res).toEqual({ reaped: 1, errors: 0 });
      const remaining = await readdir(stagingRootPath(c.rootDir));
      expect(remaining).toEqual(['22222222-2222-4222-8222-222222222222']);
    } finally {
      await rm(c.rootDir, { recursive: true, force: true });
    }
  });

  it('is a no-op for the s3 backend', async () => {
    const s3: StorageClient = { kind: 's3', aws: {} as never, bucketUrl: 'http://b' };
    expect(await reapStaleUploads(s3, { now: NOW, maxAgeMs: DAY })).toEqual({
      reaped: 0,
      errors: 0,
    });
  });

  it('returns zero when no staging root exists', async () => {
    const c = await mkdtemp(join(tmpdir(), 'prov-reap-empty-'));
    const client: StorageClient = {
      kind: 'fs',
      rootDir: c,
      signingSecret: 's'.repeat(32),
      publicBaseUrl: 'http://x',
    };
    try {
      expect(await reapStaleUploads(client, { now: NOW, maxAgeMs: DAY })).toEqual({
        reaped: 0,
        errors: 0,
      });
    } finally {
      await rm(c, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify pass (reapStaleUploads already exists from Task 4)**

Run: `npm run test --workspace=packages/server -- src/jobs/reap-stale-uploads.test.ts`
Expected: PASS. (This test exercises the Task 4 function directly; it validates the reaper contract before we wire the cron. If it fails, fix `reapStaleUploads` before proceeding.)

- [ ] **Step 3: Add the job kind**

In `packages/server/src/jobs/pg-boss.ts`, add to `JOB_KINDS`:

```ts
  REAP_STALE_UPLOADS: 'reap_stale_uploads',
```

and add a line to the job-kinds doc comment: `reap_stale_uploads   — daily cron (fs backend only)`.

- [ ] **Step 4: Implement the handler factory**

Create `packages/server/src/jobs/reap-stale-uploads.ts`:

```ts
/**
 * reap-stale-uploads — daily cron.
 *
 * Reclaims multipart staging dirs abandoned by a crashed upload (the normal
 * failure path already calls abort). No-op under the s3 backend. Only deletes
 * transient staging under <rootDir>/.uploads — never stored bundles or DB rows.
 */

import { reapStaleUploads } from '../services/storage/fs-multipart.js';
import type { StorageClient } from '../services/storage/client.js';
import { getLogger } from '../logging.js';

export function createReapStaleUploadsHandler(
  storage: StorageClient,
  maxAgeMs: number,
): () => Promise<void> {
  return async () => {
    const res = await reapStaleUploads(storage, { now: Date.now(), maxAgeMs });
    if (res.reaped > 0 || res.errors > 0) {
      getLogger().info(res, 'reap-stale-uploads: sweep complete');
    }
  };
}
```

- [ ] **Step 5: Wire the cron in `worker.ts`**

In `packages/server/src/jobs/worker.ts`:

1. Import: `import { createReapStaleUploadsHandler } from './reap-stale-uploads.js';`
2. After the other `createQueue` calls (near `JOB_KINDS.RETENTION_SWEEP`): `await boss.createQueue(JOB_KINDS.REAP_STALE_UPLOADS);`
3. After the other `boss.work(...)` cron registrations (near the `RETENTION_SWEEP` work call), add:

```ts
await boss.work(
  JOB_KINDS.REAP_STALE_UPLOADS,
  { batchSize: 1 },
  createReapStaleUploadsHandler(storageClient, cfg.BLOB_STORAGE_FS_STAGING_TTL_SECONDS * 1000),
);
```

(`storageClient` and `cfg` are already in scope at this point in the worker setup — reuse the same names the surrounding code uses.) 4. After the other `boss.schedule(...)` calls, add (4am UTC — retention runs 2am, purge-exports 3am, so 4am avoids stacking):

```ts
await boss.schedule(JOB_KINDS.REAP_STALE_UPLOADS, '0 4 * * *', {});
```

- [ ] **Step 6: Typecheck, lint, test**

Run:

```bash
npm run typecheck --workspace=packages/server
npm run lint --workspace=packages/server
npm run test --workspace=packages/server -- src/jobs/reap-stale-uploads.test.ts
```

Expected: all clean/PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/jobs/reap-stale-uploads.ts \
  packages/server/src/jobs/reap-stale-uploads.test.ts \
  packages/server/src/jobs/pg-boss.ts packages/server/src/jobs/worker.ts
git commit --no-gpg-sign -m "feat(server): daily cron to reap orphaned fs multipart staging"
```

---

## Task 6: Docs — env example + admin guide

**Files:**

- Modify: `packages/server/.env.example`
- Modify: `docs/admin-guide.md`

- [ ] **Step 1: Update `.env.example`**

In `packages/server/.env.example`, above the `OBJECT_STORAGE_*` block, add:

```dotenv
# Blob storage backend: "s3" (default) or "fs" (filesystem, e.g. NFS mount).
BLOB_STORAGE_BACKEND=s3

# --- fs backend (only when BLOB_STORAGE_BACKEND=fs) ---
# Directory where provenance bundles are stored (e.g. an NFS mount).
# BLOB_STORAGE_FS_ROOT=/srv/provenance/blobs
# HMAC secret (>=32 chars) for signing /api/v1/blob download URLs.
# BLOB_URL_SIGNING_SECRET=change-me-to-a-long-random-secret-value
# Max age (seconds) of a multipart staging dir before the reaper reclaims it.
BLOB_STORAGE_FS_STAGING_TTL_SECONDS=86400
```

Leave the existing `OBJECT_STORAGE_*` lines; add a comment above them: `# --- s3 backend (only when BLOB_STORAGE_BACKEND=s3) ---`.

- [ ] **Step 2: Document the fs backend in `docs/admin-guide.md`**

Add a subsection to the storage/hosting area of `docs/admin-guide.md` (place it near the existing object-storage / retention material):

```markdown
### Filesystem blob backend (apphost deployment)

Set `BLOB_STORAGE_BACKEND=fs` to store bundles on an ordinary directory
(`BLOB_STORAGE_FS_ROOT`) instead of S3-compatible object storage. Used for the
EECS Instructional apphost, where blobs live on an NFS mount bind-mounted into
the container (which runs as root inside the container so it can write the mount).

Required when `fs`:

- `BLOB_STORAGE_FS_ROOT` — the mount directory (e.g. `/srv/provenance/blobs`).
- `BLOB_URL_SIGNING_SECRET` — ≥32-char HMAC secret. Bundle downloads are served
  by `GET /api/v1/blob` via a signed, TTL-bounded URL (TTL =
  `BLOB_DOWNLOAD_URL_TTL_SECONDS`), replacing S3 presigned URLs. The token is the
  credential — same exposure as an S3 presigned URL.

Multipart/resumable uploads are supported (parts stage under
`<root>/.uploads/`). A daily cron (`reap_stale_uploads`, 04:00 UTC) reclaims
staging dirs older than `BLOB_STORAGE_FS_STAGING_TTL_SECONDS` (default 24h) so a
crashed upload cannot leak disk. Stored bundles remain provenance-only and
write-once; retention still deletes only blobs, never DB rows.
```

- [ ] **Step 3: Full verification sweep**

Run:

```bash
npm run typecheck --workspace=packages/server
npm run lint --workspace=packages/server
npm run test --workspace=packages/server
```

Expected: typecheck + lint clean; full server suite PASS (Docker must be running for the MinIO/Postgres testcontainer suites). If any pre-existing MinIO test fails, confirm it fails on `main` too before treating it as a regression.

- [ ] **Step 4: Commit**

```bash
git add packages/server/.env.example docs/admin-guide.md
git commit --no-gpg-sign -m "docs(server): document fs blob-storage backend + reaper cron"
```

---

## Self-Review Notes

- **Spec coverage:** backend selection (Task 1), fs put/get/delete + path safety (Task 2), presign + download route (Task 3), fs multipart parity (Task 4), reaper cron (Task 5), env/admin docs (Task 6). All spec sections map to a task.
- **`kind` discriminant** is consistent across `StorageConfig`, `StorageClient`, and every `client.kind === 'fs'` guard.
- **`FS_STAGING_DIR`/`.uploads`** is defined once in `fs-blobs.ts`, excluded by `resolveKeyPath`, and reused via `stagingRootPath` in `fs-multipart.ts` and the reaper — no divergent literal.
- **Clock injection:** `verifyBlobUrl` and `reapStaleUploads` take an explicit clock and are asserted against fixed epochs; `fsPresignGetUrl` / the handler read `Date.now()` internally where it is not asserted.
- **Signature parity:** every fs function's parameter list matches the free-function call sites in `blobs.ts` / `multipart.ts` (verified against the guard-replacement steps).

```

```
