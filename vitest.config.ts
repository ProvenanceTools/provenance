import { defineConfig } from 'vitest/config';

/**
 * Root config — covers ONLY the `tools/` suites.
 *
 * `npm run test` at the root is `npm run test --workspaces --if-present`, and
 * `tools/` is not a workspace (it has no package.json — deliberately, since it
 * spans several packages' dependency graphs). The `tools/*.test.ts` files were
 * therefore run by nothing at all; this config plus the root `test:tools` script
 * is what makes them execute.
 *
 * Scoped with an explicit `include` on purpose. Without one, a bare `vitest` at
 * the repo root would walk into `packages/**` and pick up the server's
 * integration suites, which spin up Postgres and MinIO via testcontainers. Each
 * package has its own vitest.config.ts and runs with its own cwd, so nothing
 * here affects `npm run test --workspace=packages/<name>`.
 */
export default defineConfig({
  test: {
    include: ['tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
