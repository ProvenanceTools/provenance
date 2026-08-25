/**
 * Mocha test runner setup for the Provenance Recorder integration tests.
 *
 * This file is the entry point called by @vscode/test-electron after it
 * launches VS Code with the extension loaded. It sets up Mocha and loads the
 * ONE suite file named by the PROVENANCE_IT_SUITE env var.
 *
 * Each suite file is bound to a specific fixture workspace (see runTest.ts), so
 * discovering every *.test.js and running the lot would run each suite against
 * the wrong workspace. The env var is therefore required, not defaulted — a
 * silent fallback here would produce confusing failures rather than a clear one.
 *
 * The exported `run` function signature is mandated by @vscode/test-electron.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 60_000, // 60s per test — VS Code startup is slow and the policy
    // suite waits out several heartbeat intervals.
  });

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const testsRoot = path.resolve(__dirname, '.');

  const suiteName = process.env['PROVENANCE_IT_SUITE'];
  if (suiteName === undefined || suiteName === '') {
    throw new Error(
      'PROVENANCE_IT_SUITE is not set. Each integration suite is bound to a ' +
        'specific fixture workspace; run the suite via `npm run test:integration`, ' +
        'which sets this for each fixture.',
    );
  }

  const suiteFile = path.resolve(testsRoot, `${suiteName}.test.js`);
  if (!fs.existsSync(suiteFile)) {
    throw new Error(`PROVENANCE_IT_SUITE='${suiteName}' but ${suiteFile} does not exist.`);
  }
  mocha.addFile(suiteFile);

  await new Promise<void>((resolve, reject) => {
    try {
      mocha.run((failures) => {
        if (failures > 0) {
          reject(new Error(`${failures} test(s) failed.`));
        } else {
          resolve();
        }
      });
    } catch (e) {
      reject(e);
    }
  });
}
