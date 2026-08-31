import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Perf tests assert wall-clock budgets and flake under loaded CI. They are
// excluded from the default `npm run test` and run via `npm run test:perf`
// (V46). The exclusion is opt-out: ANALYZE_PERF=1 keeps them in the default
// run, so a local invocation that explicitly wants them can opt in.
const includePerf = process.env.ANALYZE_PERF === '1';
const excludePerf = includePerf ? [] : ['test/perf/**'];

// The repo root. `heuristics-doc-sync.test.ts` imports `docs/heuristics.md?raw`,
// which lives outside this package, and Vite's file-serving allow-list defaults
// to the Vitest root (`packages/analyzer`) and denies it: `Denied ID .../docs/
// heuristics.md?raw`, surfacing as a collection error rather than a test
// failure. The analyzer bans `node:*` imports, so reading the doc through Vite
// is the only route available to that test.
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  plugins: [react()],
  // Load env files from a directory that deliberately has none, so the suite
  // never inherits a developer's `packages/analyzer/.env`.
  //
  // That file is gitignored, so whether VITE_ROOT_PUBLIC_KEY_HEX was set during
  // a run depended on whether the developer had configured /compose/manifest
  // locally. The composer renders its paste-a-root-key input only when no key
  // is baked in, so a contributor with a .env saw six ManifestComposerView
  // failures plus a leak-test failure that CI never reproduced. Tests must not
  // depend on a developer's local environment.
  //
  // It has to be envDir. `test.env` in this file reaches only `process.env`,
  // and `vi.stubEnv` does not mutate `import.meta.env` under Vitest 4 — both
  // were tried, and `lib/root-key.ts` reads `import.meta.env`, which Vite
  // populates from the env file before either runs.
  //
  // Unset is the documented default (lib/root-key.ts), so that is what the
  // suite exercises. A test needing a key present mocks `lib/root-key.js` the
  // way BundleContext.contributors.test.tsx does.
  envDir: fileURLToPath(new URL('./src/test', import.meta.url)),
  server: {
    fs: {
      allow: [REPO_ROOT],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    globals: true,
    exclude: ['**/node_modules/**', '**/dist/**', ...excludePerf],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
