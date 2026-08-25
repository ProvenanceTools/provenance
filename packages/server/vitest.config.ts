import { defineConfig } from 'vitest/config';

// Perf tests assert wall-clock budgets and flake under loaded CI. They are
// excluded from the default `npm run test` and run via `npm run test:perf`
// (P1-1). The exclusion is opt-out: ANALYZE_PERF=1 keeps them in the default
// run so a local invocation that explicitly wants them can opt in.
const includePerf = process.env.ANALYZE_PERF === '1';
const excludePerf = includePerf ? [] : ['test/perf/**'];

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', ...excludePerf],
    environment: 'node',
    // Roughly half of this workspace's test files spawn testcontainers
    // (Postgres and/or MinIO) — see test/helpers/db.ts and test/helpers/minio.ts.
    // Container start-up (pull + boot + migrate) plus real DB/S3 round trips
    // routinely exceed vitest's 5s/10s defaults once more than a couple of
    // files run concurrently and compete for the Docker daemon and CPU.
    //
    // This used to be handled per-file via `vi.setConfig({ testTimeout: ... })`
    // at the top of each integration test file. That convention silently
    // regressed to the 10s default whenever a new testcontainers file forgot
    // to add the override (eight files did), and even where it was followed,
    // 120s individually wasn't always enough under real parallel load — full
    // suite runs measured `Test timed out in 10000ms` / `Timed out ... while
    // waiting for container ports to be bound` failures, never assertion
    // failures, across dozens of files including some that already had the
    // 120s override. Re-running the same files at 180s passed cleanly. So the
    // timeout floor now lives here, once, for every file in the workspace —
    // nothing to remember when adding a new integration test.
    //
    // The cost: a genuinely hung plain unit test (no testcontainers) now takes
    // up to 180s to report instead of 10s. That's judged an acceptable trade
    // for eliminating a whole category of infra flakiness; such hangs are rare
    // and this is a correctness fix, not a performance one. Perf tests
    // (test/perf/**) are excluded from the default run entirely (see above)
    // and set their own higher budget (300s) for wall-clock assertions.
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
