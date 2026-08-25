/**
 * Configuration for the v1 + v2 heuristics engine (Phases 4 and 16).
 *
 * All thresholds are configurable — consumers pass a partial override to
 * runHeuristics(); missing fields fall back to the defaults here.
 *
 * Severity rubric (documented here, enforced in each heuristic):
 *
 *   large_paste:
 *     - medium: ≥200 chars OR ≥10 lines  (configurable via minChars/minLines)
 *     - high:   ≥500 chars OR ≥30 lines  (configurable via highSeverityChars/Lines)
 *     - confidence: 0.8 for non-anomaly pastes (paste detection is reliable);
 *       0.6 when the paste falls inside a paste.anomaly window.
 *
 *   external_edits:
 *     - medium: any unexplained fs.external_change
 *     - high:   unexplained AND |diff_size| > 100 chars AND file is tracked
 *       (configurable via highSeverityCharsChanged)
 *     - confidence: 0.9 for unexplained external changes (hard signal).
 *
 *   low_typing_high_output:
 *     - medium: ratio in [minRatio, highRatio)
 *     - high:   ratio >= highRatio
 *     - confidence: scales with absolute chars_typed → 0..1 mapped over
 *       [0, minCharsForConfidence]. More chars = higher confidence in the ratio.
 *
 *   chain_broken:
 *     - always high, confidence 1.0 (cryptographic check — no ambiguity).
 *
 *   paste_is_solution (Phase 16):
 *     - high: shared lines >= minSharedLines (default 10) AND
 *             shared lines / final file lines >= finalFileCoverage (default 0.8)
 *     - confidence: 0.85.
 *
 *   mass_external_replacement (Phase 16):
 *     - high: shared lines / max(oldLines, newLines) < sharedThreshold (default 0.2)
 *     - confidence: 0.75.
 *
 *   time_to_first_save_anomaly (Phase 16):
 *     - high: doc.open → doc.save < anomalySeconds (default 30s) AND new content > minChars (default 500).
 *     - confidence: 0.8.
 *
 *   idle_then_complete (Phase 16):
 *     - high: idle gap > idleGapMs (default 10min) followed by save that brings file
 *       from skeleton (< sizeRatio of final chars) to final hash match.
 *     - confidence: 0.8.
 *
 *   no_intermediate_errors (Phase 16):
 *     - medium: file goes from empty to final with no terminal exit_code !== 0.
 *     - skipped when shell_integration: false (info severity flag with reason).
 *
 *   paste_matches_known_source (Phase 16):
 *     - high: exact hash match against corpus entry.
 *     - medium: diffLines ratio >= fuzzyThreshold (default 0.7) against corpus fuzzy_lines.
 *     - confidence: 0.95 (hash match) / 0.8 (fuzzy match).
 *
 *   Known-source corpus is passed via knownSourceCorpus in config (optional; empty
 *   list → heuristic emits 0 flags). PRD §10 Q4: the corpus content is course-staff's;
 *   this config carries the format. Course staff loads the corpus into config before
 *   running heuristics (UI hook-up is Phase 16 out-of-scope per task spec).
 */

// ---------------------------------------------------------------------------
// Known-source corpus type (paste_matches_known_source)
// ---------------------------------------------------------------------------

// Import default AI extension IDs from the committed JSON list.
// This is a static import — the list is compiled into the bundle at build time.
// Consumers can override via HeuristicConfig.aiExtensionActive.knownAiExtensions.
import defaultAiExtensionList from './config/ai-extension-list.json' with { type: 'json' };
import defaultKnownGoodHashes from './config/known-good-extension-hashes.json' with { type: 'json' };

/**
 * A single known-source entry in the course-staff corpus.
 *
 * - `name`: human-readable label (e.g. "hw1 solution", "stack overflow snippet A").
 * - `hashes`: SHA-256 hashes of known source texts. Exact match triggers high flag.
 * - `fuzzy_lines`: optional list of text blocks; each is compared via diffLines line
 *   ratio. fuzzyThreshold match triggers medium flag.
 */
export type KnownSource = {
  name: string;
  hashes: string[];
  fuzzy_lines?: string[][];
};

export type HeuristicConfig = {
  largePaste: {
    /** Minimum character count to flag. Default: 200. */
    minChars: number;
    /** Minimum line count to flag. Default: 10. */
    minLines: number;
    /** Character threshold for high severity. Default: 500. */
    highSeverityChars: number;
    /** Line threshold for high severity. Default: 30. */
    highSeverityLines: number;
  };
  externalEdits: {
    /**
     * Maximum gap between consecutive fs.external_change events on the same
     * file (by `t` ms-since-session-start) to coalesce into one flag.
     * Default: 2000ms.
     */
    coalesceWindowMs: number;
    /**
     * |diff_size| threshold for high severity. Only applies when a value is
     * present in the payload. Default: 100 chars.
     */
    highSeverityCharsChanged: number;
  };
  lowTypingHighOutput: {
    /**
     * Minimum ratio (chars_in_final_file / chars_typed) to emit a flag.
     * Ratios below this are treated as normal. Default: 3.
     */
    minRatio: number;
    /**
     * Ratio threshold for high severity. Ratios >= this are high. Default: 5.
     */
    highRatio: number;
    /**
     * chars_typed value at which confidence reaches 1.0. Linearly interpolated
     * from 0 (at 0 chars_typed) to 1.0 (at minCharsForConfidence). Default: 500.
     */
    minCharsForConfidence: number;
  };
  /** Phase 16: paste_is_solution heuristic thresholds. */
  pasteIsSolution: {
    /**
     * Minimum coverage ratio (sharedLines / finalFileLines) to flag — how much
     * of the SUBMITTED FILE the insertion accounts for.
     *
     * Deliberately not sharedLines/pasteLines ("how much of the paste
     * survived"), which is trivially 1.0 for any small paste nobody deleted:
     * a 3-line import block pasted onto a 60-line hand-typed file scored 1.0
     * under the old ratio and raised `high`. The claim this flag makes is
     * "the submitted file is pasted code", and the evidence for that claim is
     * coverage of the final file, not survival of the paste.
     *
     * Coverage is per candidate and deliberately does not sum: four pastes
     * each covering 25% clear neither gate. "How much of this file arrived
     * without being typed" is low_typing_high_output's question.
     *
     * Default: 0.8 (80%).
     */
    finalFileCoverage: number;
    /**
     * Minimum absolute shared-line count before the flag can raise at all.
     *
     * Deliberately equal to `largePaste.minLines` (10): large_paste declines
     * to raise even `medium` below 10 lines, and paste_is_solution raises
     * `high` — a strictly stronger claim — so it must not be reachable below
     * the same floor. Without it, coverage alone still fires on a 4-line file
     * whose 4 lines were pasted.
     *
     * Default: 10 lines.
     */
    minSharedLines: number;
  };
  /** Phase 16: mass_external_replacement heuristic thresholds. */
  massExternalReplacement: {
    /**
     * Maximum shared-line ratio (sharedLines / max(oldLines, newLines)) below
     * which we flag the external change as a mass replacement.
     * Default: 0.2 (20%).
     */
    sharedThreshold: number;
  };
  /** Phase 16: no_intermediate_errors heuristic thresholds. */
  noIntermediateErrors: {
    /**
     * Minimum number of terminal commands that actually REPORTED an exit code,
     * across the WHOLE submission, before "none of them failed" is evidence of
     * anything at all.
     *
     * Without a floor the flag fires on one `ls` and one keystroke. It also
     * used to count commands with NO recorded exit code as successes, so a
     * session where nothing reported an exit code raised the flag on zero
     * evidence — absence of capture read as evidence of success. Only reported
     * exit codes count toward this floor.
     *
     * Why a floor makes the flag discriminating at all: "the student never saw
     * an error" is consistent with "they pasted working code" AND with "they
     * are a strong programmer", and on one or two runs those are
     * indistinguishable — a clean short session is an ordinary morning. What
     * is unusual is a LONG run of commands with not one non-zero exit: real
     * terminal use produces failures from typos alone. Below the floor the
     * flag is not weak evidence, it is no evidence, and emitting it costs a
     * false accusation.
     *
     * Default: 5.
     */
    minCommandsWithExitCode: number;
  };
  /** Phase 16: time_to_first_save_anomaly heuristic thresholds. */
  timeToFirstSaveAnomaly: {
    /**
     * Maximum seconds between doc.open and the first doc.save to flag.
     * Default: 30.
     */
    anomalySeconds: number;
    /**
     * Minimum characters of new content in the save to consider it anomalous.
     * Default: 500.
     */
    minChars: number;
  };
  /** Phase 16: idle_then_complete heuristic thresholds. */
  idleThenComplete: {
    /**
     * Minimum idle gap (in ms between heartbeats) to count as "idle".
     * Default: 600000 (10 minutes).
     */
    idleGapMs: number;
    /**
     * Ratio: if the prior file size is < sizeRatio × finalSize, it's a skeleton.
     * Default: 0.5 (50%).
     */
    sizeRatio: number;
    /**
     * Window (in ms) after idle-gap end within which a save is considered "post-idle".
     * Default: 60000 (60 seconds).
     */
    postIdleWindowMs: number;
  };
  /** Phase 17: ai_extension_active + extension_set_changed_mid_assignment. */
  aiExtensionActive: {
    /**
     * List of VS Code extension IDs considered to be AI coding tools.
     * Defaults to the course-maintained `config/ai-extension-list.json`.
     * Override in tests or for per-course customization.
     */
    knownAiExtensions: string[];
  };
  /** Phase 17: extension_hash_mismatch heuristic. */
  extensionHashMismatch: {
    /**
     * List of SHA-256 hashes (64-char lowercase hex) of known-good
     * Provenance recorder builds. Defaults to `config/known-good-extension-hashes.json`.
     * Any bundle whose `manifest.extension_hash` is NOT in this list is flagged.
     */
    knownGoodHashes: string[];
  };
  /** Phase 17: clock_jumps heuristic thresholds. */
  clockJumps: {
    /**
     * delta_ms threshold above which a single clock.skew event is
     * considered anomalous. Default: 300000 (5 minutes).
     */
    singleJumpThresholdMs: number;
    /**
     * Minimum number of clock.skew events in a session to flag even if
     * no single one exceeds singleJumpThresholdMs. Default: 2.
     */
    multipleJumpsMin: number;
  };
  /** Phase 17: gap_in_heartbeats heuristic thresholds. */
  gapInHeartbeats: {
    /**
     * Minimum gap (in ms) between consecutive session.heartbeat events
     * (by wall time) to count as a suspicious gap. Default: 300000 (5 min).
     */
    gapThresholdMs: number;
  };
  /**
   * inter_session_external_change heuristic — file content that diverged
   * between consecutive recorder sessions.
   */
  interSessionExternalChange: {
    /**
     * |len(nextOpen) - len(prevEnd)| threshold above which the divergence is
     * classified as high severity. Default: 100 chars.
     */
    highSeverityCharsChanged: number;
  };
  /** Phase 16: paste_matches_known_source heuristic. */
  pasteMatchesKnownSource: {
    /**
     * Minimum diffLines line ratio to fire a fuzzy match (medium severity).
     * Default: 0.7.
     */
    fuzzyThreshold: number;
    /**
     * Course-staff supplied corpus. Each entry has a name, SHA-256 hashes,
     * and optional fuzzy_lines blocks. Empty array → heuristic emits 0 flags.
     *
     * PRD §10 Q4: the corpus content is course-staff's; the format is ours.
     * Phase 16 ships the mechanism. Course staff populates this before running.
     */
    corpus: KnownSource[];
  };
  /**
   * internal_move classification — downgrades paste flags that are really the
   * student relocating their own previously-typed code (copy-within-file,
   * cut-then-paste-back, cross-file refactor).
   */
  internalMove: {
    /** false → classifier never runs; output is byte-for-byte prior behaviour. */
    enabled: boolean;
    /** Fraction of normalised paste lines that must match a source region. */
    minMatchRatio: number;
    /** Fraction of matched source chars that must be typed/preexisting. */
    typedRatio: number;
    /** Deletion ledger byte cap; oldest-first eviction. */
    ledgerMaxBytes: number;
    /** Pastes and deletions below this many chars are never classified. */
    minBlobChars: number;
  };
};

export const DEFAULT_HEURISTIC_CONFIG: HeuristicConfig = {
  largePaste: {
    minChars: 200,
    minLines: 10,
    highSeverityChars: 500,
    highSeverityLines: 30,
  },
  externalEdits: {
    coalesceWindowMs: 2000,
    highSeverityCharsChanged: 100,
  },
  lowTypingHighOutput: {
    minRatio: 3,
    highRatio: 5,
    minCharsForConfidence: 500,
  },
  pasteIsSolution: {
    finalFileCoverage: 0.8,
    // Mirrors largePaste.minLines. See the field doc above.
    minSharedLines: 10,
  },
  massExternalReplacement: {
    sharedThreshold: 0.2,
  },
  noIntermediateErrors: {
    minCommandsWithExitCode: 5,
  },
  timeToFirstSaveAnomaly: {
    anomalySeconds: 30,
    minChars: 500,
  },
  idleThenComplete: {
    idleGapMs: 600_000, // 10 minutes
    sizeRatio: 0.5,
    postIdleWindowMs: 60_000, // 60 seconds
  },
  pasteMatchesKnownSource: {
    fuzzyThreshold: 0.7,
    corpus: [],
  },
  aiExtensionActive: {
    knownAiExtensions: defaultAiExtensionList.extensionIds as string[],
  },
  extensionHashMismatch: {
    knownGoodHashes: defaultKnownGoodHashes.hashes as string[],
  },
  clockJumps: {
    singleJumpThresholdMs: 300_000, // 5 minutes
    multipleJumpsMin: 2,
  },
  gapInHeartbeats: {
    gapThresholdMs: 300_000, // 5 minutes
  },
  interSessionExternalChange: {
    highSeverityCharsChanged: 100,
  },
  internalMove: {
    enabled: true,
    minMatchRatio: 0.95,
    typedRatio: 0.9,
    ledgerMaxBytes: 1_000_000,
    minBlobChars: 40,
  },
};

/**
 * Merge a partial config override with the defaults.
 * Nested objects are merged shallowly (per sub-section).
 */
export function mergeConfig(override?: Partial<HeuristicConfig>): HeuristicConfig {
  if (override === undefined) return DEFAULT_HEURISTIC_CONFIG;
  return {
    largePaste: { ...DEFAULT_HEURISTIC_CONFIG.largePaste, ...override.largePaste },
    externalEdits: { ...DEFAULT_HEURISTIC_CONFIG.externalEdits, ...override.externalEdits },
    lowTypingHighOutput: {
      ...DEFAULT_HEURISTIC_CONFIG.lowTypingHighOutput,
      ...override.lowTypingHighOutput,
    },
    pasteIsSolution: {
      ...DEFAULT_HEURISTIC_CONFIG.pasteIsSolution,
      ...override.pasteIsSolution,
    },
    massExternalReplacement: {
      ...DEFAULT_HEURISTIC_CONFIG.massExternalReplacement,
      ...override.massExternalReplacement,
    },
    noIntermediateErrors: {
      ...DEFAULT_HEURISTIC_CONFIG.noIntermediateErrors,
      ...override.noIntermediateErrors,
    },
    timeToFirstSaveAnomaly: {
      ...DEFAULT_HEURISTIC_CONFIG.timeToFirstSaveAnomaly,
      ...override.timeToFirstSaveAnomaly,
    },
    idleThenComplete: {
      ...DEFAULT_HEURISTIC_CONFIG.idleThenComplete,
      ...override.idleThenComplete,
    },
    pasteMatchesKnownSource: {
      ...DEFAULT_HEURISTIC_CONFIG.pasteMatchesKnownSource,
      ...override.pasteMatchesKnownSource,
    },
    aiExtensionActive: {
      ...DEFAULT_HEURISTIC_CONFIG.aiExtensionActive,
      ...override.aiExtensionActive,
    },
    extensionHashMismatch: {
      ...DEFAULT_HEURISTIC_CONFIG.extensionHashMismatch,
      ...override.extensionHashMismatch,
    },
    clockJumps: {
      ...DEFAULT_HEURISTIC_CONFIG.clockJumps,
      ...override.clockJumps,
    },
    gapInHeartbeats: {
      ...DEFAULT_HEURISTIC_CONFIG.gapInHeartbeats,
      ...override.gapInHeartbeats,
    },
    interSessionExternalChange: {
      ...DEFAULT_HEURISTIC_CONFIG.interSessionExternalChange,
      ...override.interSessionExternalChange,
    },
    internalMove: {
      ...DEFAULT_HEURISTIC_CONFIG.internalMove,
      ...override.internalMove,
    },
  };
}
