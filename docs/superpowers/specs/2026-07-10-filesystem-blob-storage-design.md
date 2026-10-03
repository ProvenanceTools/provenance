# Filesystem-backed blob storage

**Date:** 2026-07-10
**Status:** Approved (design), pending implementation
**Scope:** `packages/server` only. `log-core`, `shared`, `analysis-core`, `analyzer`, `recorder` are untouched.

## Motivation

Provenance stores each submission's provenance bundle as a single blob. Today the
server writes and reads those blobs exclusively through an S3-compatible object-storage
API (`aws4fetch` SigV4 over `fetch`; MinIO in dev, S3/R2 in prod).

The EECS Instructional apphost deployment (`instapphost.eecs.berkeley.edu` →
`provenance.eecs.berkeley.edu`) has **no** object-storage service. Blob storage there is
an ordinary NFS-mounted directory on the department file server, bind-mounted into the
container (which runs as root inside the container so it can write to the mount). The
server must therefore be able to target a plain filesystem directory instead of S3.

This spec adds a **filesystem backend** selectable at boot, at full functional parity
with the S3 backend (put / get / delete / presigned download / resumable multipart
upload), plus a reaper that reclaims orphaned multipart staging so a crashed upload
cannot leak disk against a limited server quota.

## Non-goals

- No change to the S3 backend's behavior. It stays the default.
- No change to the HTTP API contract (`GET /bundle` still returns `{ signedUrl, expiresAt }`).
- No change to any other workspace or to the blob key layout (`keys.ts`).
- No nightly `pg_dump` / DB-backup wiring — that is separate work, out of scope here.
- No new npm dependencies. Node built-ins only (`node:fs/promises`, `node:crypto`,
  `node:path`, `node:stream`).

## Backend selection (config)

`config/env.ts` gains:

| Var                                   | Type                             | Notes                                                                       |
| ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------- |
| `BLOB_STORAGE_BACKEND`                | `enum('s3','fs')` default `'s3'` | Selects the backend.                                                        |
| `BLOB_STORAGE_FS_ROOT`                | `string` optional                | NFS mount dir, e.g. `/srv/provenance/blobs`. Required when backend is `fs`. |
| `BLOB_URL_SIGNING_SECRET`             | `string` min 32 optional         | HMAC key for fs presigned URLs. Required when backend is `fs`.              |
| `BLOB_STORAGE_FS_STAGING_TTL_SECONDS` | int default `86400`              | Max age of a multipart staging dir before the reaper reclaims it.           |

The five existing `OBJECT_STORAGE_*` vars are relaxed from unconditionally-required to
optional, and a `superRefine` enforces the conditional contract:

- backend `s3` → all five `OBJECT_STORAGE_*` present (validated `.url()` / non-empty).
- backend `fs` → `BLOB_STORAGE_FS_ROOT` and `BLOB_URL_SIGNING_SECRET` present.

A missing/misconfigured backend fails **at boot**, not at first upload.

`PUBLIC_BASE_URL` (already present, used by OAuth) is reused as the absolute base for fs
presigned URLs.

## `StorageClient` becomes a discriminated union

`storage/client.ts`:

```ts
export type StorageClient =
  | { kind: 's3'; aws: AwsClient; bucketUrl: string }
  | { kind: 'fs'; rootDir: string; signingSecret: string; publicBaseUrl: string };
```

- `storageConfigFromEnv(env)` returns a union config discriminated on `BLOB_STORAGE_BACKEND`.
- `createStorageClient(cfg)` builds the matching client.
- `getStorageClient()` (`default-client.ts`) is unchanged in signature.

All ~30 call sites that hold a `StorageClient` and call the free functions
(`putBlob(client, …)`, `getBlob`, `deleteBlob`, `presignGetUrl`, and the five multipart
ops) are **byte-for-byte unchanged**. Only the free functions themselves gain a dispatch
branch.

## Free-function dispatch

`storage/blobs.ts` and `storage/multipart.ts` each get a one-line guard at the top of
every op:

```ts
export async function putBlob(client, key, body) {
  if (client.kind === 'fs') return fsPutBlob(client, key, body);
  // …existing S3 path unchanged…
}
```

The fs logic lives in two new sibling files so the existing files stay focused:

- `storage/fs-blobs.ts` — put / get / delete / presign + `resolveKeyPath`.
- `storage/fs-multipart.ts` — the five multipart ops, part staging, and the reaper.

## `fs-blobs.ts`

All ops resolve the on-disk path through a single safety gate.

- **`resolveKeyPath(rootDir, key)`** — `path.resolve(rootDir, key)`, then assert the
  result is still inside `rootDir` (reject `..`, absolute keys, escape). Also rejects any
  key resolving into the reserved `.uploads/` staging tree. Every op goes through it.
  Defense-in-depth even though keys come from `keys.ts`, because the download route
  derives a key from a signed token.
- **`fsPutBlob(client, key, body)`** — hash in-flight with the same incremental
  `createHash('sha256')` loop the S3 path uses (supports `ReadableStream` | `ArrayBuffer`
  | `Uint8Array`); `mkdir -p` the parent; **write-temp-then-rename** (`<key>.tmp-<uuid>` →
  `<key>`) per the atomic-write rule. Returns `{ sha256, size }` — identical shape to S3.
- **`fsGetBlob(client, key)`** — `createReadStream` → `Readable.toWeb()` returning
  `ReadableStream<Uint8Array>`. Missing file throws (matches S3 `getBlob` throwing on 404).
- **`fsDeleteBlob(client, key)`** — `unlink`, swallow `ENOENT` (idempotent; mirrors S3's
  204-on-absent). This is the only mutation the retention sweep needs.
- **`fsPresignGetUrl(client, key, ttlSeconds)`** — envelope `{ k: key, e: expiryEpochSec }`,
  `HMAC-SHA256(signingSecret, canonicalString)`; base64url the payload and signature;
  return `${publicBaseUrl}/api/v1/blob?d=<payload>&s=<sig>`. Self-authenticating and
  short-lived — the same guarantees as an S3 presigned GET.

## Download route: `GET /api/v1/blob`

New route `api/v1/routes/blob-download.ts`.

- **No session/token auth** — the HMAC token _is_ the credential, matching S3 presigned
  semantics (the analyzer fetches the URL with no headers). This is the same exposure as
  an S3 presigned URL: unauthenticated read of one blob key for
  `BLOB_DOWNLOAD_URL_TTL_SECONDS` to whoever holds the URL. Bundles are provenance-only
  (student source already stripped at ingest), consistent with the existing trust model.
- Recompute the HMAC over the payload, **`crypto.timingSafeEqual`** compare, check
  `exp > now`. Bad signature or expiry → `403`. Decode the key, `resolveKeyPath`, stream
  via `fsGetBlob`; missing file → `404`.
- Registered always; only ever exercised when a presigned fs URL was minted (verification
  needs `BLOB_URL_SIGNING_SECRET`). Harmless under the s3 backend since nothing generates
  these URLs.

## `fs-multipart.ts`

On-disk part staging under a reserved sibling of the blob root:
`<rootDir>/.uploads/<uploadId>/<partNumber>.part`, plus a `meta.json`
(`{ key, createdAt }`) written at create. `.uploads/` is excluded by `resolveKeyPath`, so
staging never collides with stored bundles and the retention sweep never sees it.

The five ops match the S3 signatures the callers already use:

- **`fsCreateMultipartUpload(client, key)`** — `uploadId = crypto.randomUUID()`,
  `mkdir -p .uploads/<uploadId>/`, write `meta.json`, return `uploadId`.
- **`fsUploadPart(client, key, uploadId, partNumber, body)`** — atomic write-temp-rename
  `body` → `<partNumber>.part`; `etag = '"' + sha256hex(body) + '"'` (S3 returns a quoted
  etag; the caller round-trips it verbatim, so the exact value only needs to be stable).
- **`fsListParts(client, key, uploadId)`** — `readdir` the staging dir, `stat` each
  `<n>.part` for size and recompute sha256 for etag, return sorted `UploadedPart[]`. This
  is what makes resume work: the client re-sends only the missing part numbers.
- **`fsCompleteMultipartUpload(client, key, uploadId, parts)`** — concatenate parts
  **strictly in `partNumber` order** into a temp file, `rename` to `<rootDir>/<key>`
  (atomic), then `rm -rf .uploads/<uploadId>/`. No 5 MiB min-part rule (S3-only).
  Ordered assembly — never `Promise.all`.
- **`fsAbortMultipartUpload(client, key, uploadId)`** — `rm -rf .uploads/<uploadId>/`,
  idempotent (swallow ENOENT), mirroring S3's 204/404.

## Stale-upload reaper

`abort` already cleans the normal-failure path; the reaper reclaims the crash-mid-upload
orphan so it cannot sit on a limited server quota indefinitely.

- **`reapStaleUploads(client, { now, maxAgeMs })`** in `fs-multipart.ts`: no-op unless
  `client.kind === 'fs'`. `readdir` `<rootDir>/.uploads/`; for each staging dir compare
  `now − createdAt` (from `meta.json`, falling back to dir mtime if absent) against
  `maxAgeMs`; `rm -rf` the stale ones. Returns `{ reaped, errors }` for logging, matching
  the other sweeps' result shape. **Clock injected** (`now` param) — never `Date.now()`
  inside — so tests assert against a fixed clock.
- Wired as a new pg-boss cron `reap_stale_uploads` at `'0 3 * * *'` (an hour after the
  retention sweep). Handler factory `createReapStaleUploadsHandler(storage, { … })`
  registered in `worker.ts`; job-kind added to `pg-boss.ts`. Inherits the existing crons'
  scheduling and graceful-shutdown path.
- `maxAgeMs` derives from `BLOB_STORAGE_FS_STAGING_TTL_SECONDS` (default 24h): a resumable
  upload must make progress within a day of its last part or it is reclaimed.

## Testing

Real temp dirs (`fs.mkdtemp` under `os.tmpdir()`); no testcontainers — the fs backend
needs no external service, so tests are fast and deterministic.

- **`fs-blobs.test.ts`** — put/get roundtrip + sha256 correctness; atomic write leaves no
  partial file on failure; delete idempotency (absent key ok); `resolveKeyPath` rejects
  `..` / absolute / escape / `.uploads` reach-in; get-missing throws.
- **`fs-multipart.test.ts`** — full roundtrip; out-of-order parts assembled by
  `partNumber`; `listParts` drives resume (only missing parts re-sent); abort removes
  staging; complete removes staging.
- **`reap-stale-uploads.test.ts`** — fixed clock: dir older than TTL reaped; fresh dir
  kept; in-flight upload (fresh `meta.json`) survives.
- **`blob-download` route test** — sign→verify→stream happy path; expired token → 403;
  tampered payload or signature → 403 (timing-safe); missing file → 404.
- **env validation test** — `fs` backend missing `FS_ROOT` / `SIGNING_SECRET` fails at
  boot; `s3` backend missing `OBJECT_STORAGE_*` fails at boot.
- **Existing `blobs.test.ts` / `multipart.test.ts` stay green** — the S3 branch is
  unchanged; those tests only gain `kind: 's3'` on the client value they construct.

## Deployment note (informational)

Under the apphost, `BLOB_STORAGE_BACKEND=fs`, `BLOB_STORAGE_FS_ROOT=<mounted dir>`,
`BLOB_URL_SIGNING_SECRET=<32+ byte secret>`, and the container runs as root-in-container
(= the `provenance` account outside) to write the NFS bind mount. Postgres is a
self-hosted container on a non-default port (unchanged by this spec).
