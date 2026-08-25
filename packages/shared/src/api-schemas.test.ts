/**
 * Contract tests for the server<->analyzer API schemas.
 *
 * This package is the ONLY thing keeping the two ends of the HTTP API in
 * agreement, and until 2026-08-21 it had no test script and no tests — the same
 * gap `tools/` had. These tests deliberately do NOT re-test Zod. They pin the
 * handful of properties this contract relies on that a well-meaning edit could
 * silently remove:
 *
 *  - defaults that exist for ROLLING-DEPLOY safety, where losing the default
 *    does not fail a build, it blanks a view in production for the minutes a
 *    deploy straddles two server versions;
 *  - closed enums whose members are load-bearing for how a finding reads to a
 *    grader, where a silently-widened union would let a new state render as an
 *    accusation;
 *  - the absent-vs-negative distinction the §5.6 capability contract is built
 *    on, where collapsing the two would let "we could not check" read as
 *    "we checked and it was fine".
 */

import { describe, it, expect } from 'vitest';
import { CrossFlagListResponseSchema, CoverageFactsSchema } from './api-schemas.js';

// ---------------------------------------------------------------------------
// Rolling-deploy defaults
// ---------------------------------------------------------------------------

describe('rolling-deploy defaults', () => {
  const minimalListResponse = {
    items: [],
    next_cursor: null,
  };

  it('defaults cross-flag exclusions to [] when the server predates the field', () => {
    // During a rolling deploy the analyzer may talk to a server that does not
    // yet send `exclusions`. Without the default this parse FAILS and the whole
    // cross-flags view blanks — not a degraded panel, an empty page.
    const parsed = CrossFlagListResponseSchema.safeParse(minimalListResponse);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.exclusions).toEqual([]);
    }
  });

  it('gives exclusions a REQUIRED output type, so no consumer handles undefined', () => {
    const parsed = CrossFlagListResponseSchema.parse(minimalListResponse);
    // A compile-time guarantee asserted at runtime: `.default([])` must leave
    // the parsed value defined, never undefined-but-typed-as-present.
    expect(parsed.exclusions).toBeDefined();
    expect(Array.isArray(parsed.exclusions)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The §5.6 capability contract: absent is not negative
// ---------------------------------------------------------------------------

describe('capability reports keep "unknown" distinct from a negative answer', () => {
  it('admits unknown for witnessing capability', () => {
    const shape = CoverageFactsSchema.shape.witnessing;
    const capability = shape.shape.capability;
    // Every pre-§5.6 bundle — all of 1.x history, permanently — reports
    // `unknown`. If this enum ever loses it, those bundles must either fail to
    // parse or be coerced into a state that reads as a finding. Both are wrong.
    expect(capability.options).toContain('unknown');
    expect(capability.options).toContain('impossible');
    expect(capability.options).toContain('available');
    expect(capability.options).toHaveLength(3);
  });

  it('admits unknown for git observation availability', () => {
    const availability = CoverageFactsSchema.shape.gitObservation.shape.availability;
    expect(availability.options).toContain('unknown');
    expect(availability.options).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Witness verdicts are descriptive, never accusatory
// ---------------------------------------------------------------------------

describe('witness discrepancy vocabulary', () => {
  const discrepancy = CoverageFactsSchema.shape.witnessing.shape.discrepancies.element;

  it('never carries `corroborated` as a discrepancy verdict', () => {
    // `corroborated` is a COUNT, not a discrepancy. Admitting it here would let
    // a successful corroboration render in the discrepancy list.
    expect(discrepancy.shape.verdict.options).not.toContain('corroborated');
  });

  it('keeps `disappeared` in the descriptive state vocabulary', () => {
    // A checkout of a branch that never held a partner's log removes it, and so
    // does a stash. `disappeared` must remain sayable, and must remain a STATE
    // rather than being promoted into the verdict enum where it would read as a
    // conclusion about a person.
    const states = discrepancy.shape.states.element.options;
    expect(states).toContain('disappeared');
    expect(discrepancy.shape.verdict.options).not.toContain('disappeared');
  });

  it('records authority including `unverifiable`, distinct from `unattributed`', () => {
    // D13: an unenrolled contributor shows as unattributed and must never
    // present as an integrity signal. `unverifiable` is a different claim.
    const authority = discrepancy.shape.authority.options;
    expect(authority).toContain('attributed');
    expect(authority).toContain('unattributed');
    expect(authority).toContain('unverifiable');
  });
});

// ---------------------------------------------------------------------------
// Rejection: the point of Zod at the boundary
// ---------------------------------------------------------------------------

describe('boundary rejection', () => {
  it('rejects an unknown witnessing capability rather than coercing it', () => {
    const bad = { capability: 'probably_fine' };
    expect(
      CoverageFactsSchema.shape.witnessing.shape.capability.safeParse(bad.capability).success,
    ).toBe(false);
  });

  it('rejects a non-integer session count', () => {
    expect(CoverageFactsSchema.shape.witnessing.shape.sessions.safeParse(1.5).success).toBe(false);
  });
});
