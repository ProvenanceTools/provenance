import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

const intStr = (defaultVal?: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      const raw = v ?? (defaultVal !== undefined ? String(defaultVal) : undefined);
      if (raw === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Required' });
        return z.NEVER;
      }
      const n = Number(raw);
      if (!Number.isInteger(n) || isNaN(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected integer, got "${raw}"` });
        return z.NEVER;
      }
      return n;
    });

const optionalUrlStr = z
  .string()
  .optional()
  .transform((v) => v ?? '')
  .pipe(z.union([z.string().url(), z.literal('')]));

const jsonStringArray = z.string().transform((v, ctx) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(v);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected JSON array, got "${v}"` });
    return z.NEVER;
  }
  if (!Array.isArray(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected JSON array, got non-array` });
    return z.NEVER;
  }
  if (!parsed.every((item): item is string => typeof item === 'string')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected JSON array of strings' });
    return z.NEVER;
  }
  return parsed as string[];
});

// ---------------------------------------------------------------------------
// Raw schema (all strings, as they arrive from process.env)
// ---------------------------------------------------------------------------

const rawEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: intStr(3000),
  PUBLIC_BASE_URL: z.string().url(),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: intStr(10),
  BLOB_STORAGE_BACKEND: z.enum(['s3', 'fs']).default('s3'),
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_REGION: z.string().min(1).default('auto'),
  OBJECT_STORAGE_BUCKET: z.string().min(1).optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  BLOB_STORAGE_FS_ROOT: z.string().min(1).optional(),
  BLOB_URL_SIGNING_SECRET: z.string().min(32).optional(),
  BLOB_STORAGE_FS_STAGING_TTL_SECONDS: intStr(86400),
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  AUTH_ALLOWED_HOSTED_DOMAINS: jsonStringArray.default('["berkeley.edu"]'),
  AUTH_SUPERADMIN_EMAILS: jsonStringArray.default('[]'),
  // Phase 2 addition: signing secret for the __Host-prov_oauth cookie.
  // Required in production (enforced in cross-field validation below).
  // Defaults to a fixed dev-only value when NODE_ENV !== 'production'.
  // See .notes/v3-progress.md §V14 for design decision.
  AUTH_COOKIE_SIGNING_SECRET: z
    .string()
    .optional()
    .transform((v) => v ?? 'dev-only-insecure-signing-secret-change-in-prod'),
  SESSION_COOKIE_NAME: z.string().min(1).default('__Host-prov_sess'),
  SESSION_TTL_DAYS: intStr(14),
  SMTP_URL: optionalUrlStr,
  SMTP_FROM: z
    .string()
    .optional()
    .transform((v) => v ?? ''),
  RATE_LIMIT_REDIS_URL: optionalUrlStr,
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  INGEST_MAX_BUNDLE_BYTES: intStr(52428800),
  INGEST_MAX_BATCH_BYTES: intStr(5368709120),
  INGEST_MAX_BATCH_FILES: intStr(10000),
  /**
   * Max bytes for a streamed Gradescope upload (POST :gradescope). Unlike
   * INGEST_MAX_BATCH_BYTES (the in-memory cap), the streaming upload writes the
   * body straight to a temp file, so this ceiling is disk-bound rather than
   * heap-bound and can be much larger. Default 10 GiB.
   */
  INGEST_MAX_UPLOAD_BYTES: intStr(10737418240),
  /**
   * Number of ingest_file jobs the worker processes concurrently (pg-boss
   * batchSize for the INGEST_FILE queue). Each in-flight job holds ~1 DB pool
   * connection during its transaction, so keep INGEST_CONCURRENCY comfortably
   * below DATABASE_POOL_MAX (leave headroom for pg-boss's own polling
   * connections). Different files are independent submissions; ordering is only
   * enforced within a submission, so concurrency is safe. Raise this together
   * with DATABASE_POOL_MAX for the large semester import.
   */
  INGEST_CONCURRENCY: intStr(4),
  /**
   * Bundle-staging concurrency while unpacking a Gradescope export. Governs BOTH
   * the number of bundles staged concurrently (blob write + `ingest_files`
   * insert + enqueue) AND, when > 1, the size of the worker-thread pool that
   * rebuilds each bundle's ZIP. The rebuild (JSZip serialization) is ~80% of the
   * per-bundle staging cost and is pure-JS main-thread work, so a single staging
   * job was capped at one core no matter how many worker replicas ran; the pool
   * spreads it across `INGEST_STAGE_CONCURRENCY` cores of the staging process.
   * Default 1 = serial, in-process (unchanged; no threads spawned). Raise it
   * toward the core count to speed big-export staging. Each in-flight stage
   * briefly holds a DB connection for its row insert (the pool threads do not),
   * so keep INGEST_STAGE_CONCURRENCY + INGEST_CONCURRENCY within DATABASE_POOL_MAX.
   */
  INGEST_STAGE_CONCURRENCY: intStr(1),
  /**
   * pg-boss polling interval (ms) for the INGEST_FILE / INGEST_FINALIZE queues,
   * converted to pollingIntervalSeconds. The default pg-boss interval is 2000ms;
   * the lower default here cuts the fixed per-job pickup latency that dominates
   * many-small-bundle imports.
   */
  INGEST_POLLING_INTERVAL_MS: intStr(500),
  RECOMPUTE_MAX_PARALLEL: intStr(4),
  BLOB_DOWNLOAD_URL_TTL_SECONDS: intStr(300),
  ROSTER_CSV_MAX_BYTES: intStr(10485760),
  /**
   * Phase 18: LRU cache capacity for reconstructed file content.
   * Each entry holds the full reconstructed content + per-character provenance
   * array. With typical file sizes (~10–50 KB), 100 entries ≈ 5 MB.
   * Increase if the analyzer serves many concurrent file-replay requests.
   */
  RECONSTRUCTION_CACHE_SIZE: intStr(100),
  // Operational notifications (docs/superpowers/specs/2026-07-10-operational-notifications-design.md).
  ALERT_WEBHOOK_URL: z.string().url().optional(),
  ALERT_WEBHOOK_MIN_SEVERITY: z.enum(['info', 'warn', 'critical']).default('warn'),
  ALERT_WEBHOOK_TIMEOUT_MS: intStr(5000),
  ALERT_EMAIL_RECIPIENTS: jsonStringArray.default('[]'),
  ALERT_SMTP_MIN_SEVERITY: z.enum(['info', 'warn', 'critical']).default('critical'),
  ALERT_DEDUPE_WINDOW_SECONDS: intStr(300),
  // Build commit, surfaced in the app.startup notification (baked by the Dockerfile).
  // Coerce empty string to undefined: Compose's `env_file` injects the deploy
  // template's bare `GIT_SHA=` line at runtime, clobbering the baked ENV; an
  // empty value must fall through to the `?? 'unknown'` default, not render as "".
  GIT_SHA: z
    .string()
    .optional()
    .transform((v) => (v ? v : undefined)),
  // Deployment (see docs/superpowers/specs/2026-07-10-apphost-deployment-design.md).
  // When set, the API server listens on this Unix socket path instead of a TCP PORT.
  SOCKET_PATH: z.string().optional(),
  // Directory of the built analyzer SPA served from the same origin as the API.
  PUBLIC_DIR: z.string().min(1).default('./public'),
  /**
   * Hex ed25519 ROOT public key of the Manifest 2.0 trust chain (program spec
   * §2). Used by validation check 2 to verify a bundle's `course_cert` offline.
   *
   * Optional: an unset key makes check 2 report `skipped` for 2.0 bundles
   * rather than guessing, and is ignored entirely for 1.0/1.1 bundles, which
   * carry no chain to walk. Empty string means "not configured".
   */
  PROVENANCE_ROOT_PUBLIC_KEY_HEX: z
    .string()
    .regex(/^([0-9a-f]{64})?$/, 'must be 64 lowercase hex chars, or empty')
    .default(''),
  // Storage quota watched by the hourly quota-check cron (default 1 TiB).
  STORAGE_QUOTA_BYTES: intStr(1099511627776),
  STORAGE_QUOTA_WARN_PCT: intStr(80),
  STORAGE_QUOTA_CRITICAL_PCT: intStr(90),
});

// ---------------------------------------------------------------------------
// Cross-field validation
// ---------------------------------------------------------------------------

export const envSchema = rawEnvSchema.superRefine((data, ctx) => {
  // AUTH_ALLOWED_HOSTED_DOMAINS must be non-empty
  if (data.AUTH_ALLOWED_HOSTED_DOMAINS.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_ALLOWED_HOSTED_DOMAINS'],
      message: 'AUTH_ALLOWED_HOSTED_DOMAINS must be a non-empty array',
    });
  }

  // AUTH_ALLOWED_HOSTED_DOMAINS entries must be non-empty strings
  if (data.AUTH_ALLOWED_HOSTED_DOMAINS.some((d) => d.length === 0)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['AUTH_ALLOWED_HOSTED_DOMAINS'],
      message: 'AUTH_ALLOWED_HOSTED_DOMAINS entries must be non-empty strings',
    });
  }

  if (data.NODE_ENV === 'production') {
    // SESSION_COOKIE_NAME must start with __Host- in production
    if (!data.SESSION_COOKIE_NAME.startsWith('__Host-')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SESSION_COOKIE_NAME'],
        message: 'SESSION_COOKIE_NAME must start with "__Host-" in production',
      });
    }

    // AUTH_SUPERADMIN_EMAILS must be non-empty in production
    if (data.AUTH_SUPERADMIN_EMAILS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_SUPERADMIN_EMAILS'],
        message: 'AUTH_SUPERADMIN_EMAILS must be non-empty in production',
      });
    }

    // AUTH_COOKIE_SIGNING_SECRET must be explicitly set in production
    // (the transform default is the dev-only sentinel; check for it)
    if (data.AUTH_COOKIE_SIGNING_SECRET === 'dev-only-insecure-signing-secret-change-in-prod') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_COOKIE_SIGNING_SECRET'],
        message: 'AUTH_COOKIE_SIGNING_SECRET must be set explicitly in production',
      });
    }
  }

  // BLOB_STORAGE_BACKEND selects which set of storage vars is required.
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
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables.
 *
 * Takes a `Record<string, string | undefined>` so tests can pass a controlled
 * stub without mutating `process.env` globally.
 *
 * Throws a descriptive `Error` on invalid input (fails loud, per PRD §3.1).
 */
export function parseEnv(env: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const formatted = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${formatted}`);
  }
  return result.data;
}
