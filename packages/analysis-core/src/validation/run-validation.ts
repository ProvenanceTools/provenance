/**
 * Validation orchestrator.
 * PRD §5.4 — runs all 8 checks in spec order and produces a ValidationReport.
 *
 * NOTE: Check 8 (submitted_code_match) now runs for 1.1 bundles. A clean 1.1
 * bundle (all other checks pass + submitted files match recorded hashes) can
 * reach overall 'pass'. 1.0 bundles still yield overall 'warn' because Check
 * 8 is skipped (empty submissionFiles → skipped).
 *
 * ORDERING: run this BEFORE `runHeuristics`. Check 2 is what establishes the
 * bundle's Manifest 2.0 trust verdict (see verify-session-binding.ts), and the
 * course-signed capture policy is only honoured once that verdict says
 * `verified`. Running heuristics first is not unsafe — an unstamped bundle
 * resolves to the default "everything captured" policy — but it would ignore a
 * legitimate course policy and over-report.
 *
 * overall rules:
 *   - Any 'fail' → 'fail'.
 *   - No 'fail' but ≥1 'skipped' → 'warn'.
 *   - All 'pass' → 'pass'.
 */

import type { Bundle } from '../loader/types.js';
import type { ValidationCheck, ValidationReport } from './check-types.js';
import type { SessionBindingOptions } from './verify-session-binding.js';
import { verifyManifestSig } from './verify-manifest-sig.js';
import { verifySessionBinding } from './verify-session-binding.js';
import { verifyChain } from './verify-chain.js';
import { verifySeq } from './verify-seq.js';
import { verifyMonotonicT } from './verify-monotonic-t.js';
import { verifyMonotonicWall } from './verify-monotonic-wall.js';
import { verifyDocSaveHashes } from './verify-doc-save-hashes.js';
import { verifySubmittedCode } from './verify-submitted-code.js';

// ---------------------------------------------------------------------------
// overall computation
// ---------------------------------------------------------------------------

function computeOverall(checks: ValidationCheck[]): 'pass' | 'warn' | 'fail' {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'skipped')) return 'warn';
  return 'pass';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options threaded into the individual checks.
 *
 * `rootPubkeyHex` is the ROOT public key of the Manifest 2.0 trust chain, used
 * by check 2. It is a parameter and never a constant in this package —
 * `analysis-core` is isomorphic and must stay pure, and one deployment's root
 * key is not another's. 1.x bundles ignore it entirely.
 */
export type ValidationOptions = SessionBindingOptions;

export async function runValidation(
  bundle: Bundle,
  options: ValidationOptions = {},
): Promise<ValidationReport> {
  // Checks 1–2 (async) and 3–8 (sync) run in spec order.
  const check1 = await verifyManifestSig(bundle);
  const check2 = await verifySessionBinding(bundle, options);
  const check3 = verifyChain(bundle);
  const check4 = verifySeq(bundle);
  const check5 = verifyMonotonicT(bundle);
  const check6 = verifyMonotonicWall(bundle);
  const check7 = verifyDocSaveHashes(bundle);
  const check8 = verifySubmittedCode(bundle, { chainIntact: check3.status === 'pass' });

  const checks: ValidationCheck[] = [
    check1,
    check2,
    check3,
    check4,
    check5,
    check6,
    check7,
    check8,
  ];

  return {
    checks,
    overall: computeOverall(checks),
  };
}
