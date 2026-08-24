/**
 * BundleContext — provides loaded bundle state to all routes.
 *
 * v2 Phase 11 changes:
 * - Per-bundle maps: `indicesByBundle`, `validationReportByBundle`, `flagsByBundle`
 *   keyed by Bundle.id. These are the sources of truth.
 * - `selectedBundleId`: the currently "active" bundle for single-bundle consumers.
 *   Defaults to the first bundle's id when loaded.
 * - Derived scalar accessors `index`, `validationReport`, `flags` read from the
 *   maps using `selectedBundleId`. All v1 consumers (OverviewView, TimelineView,
 *   ExportMarkdownButton, etc.) continue to work with zero changes.
 * - `loadBundleFile` appends to the existing bundle list (used by the header
 *   "Load more bundles" button); `loadBundleFiles` is the multi-file fan-out.
 * - `clearBundle` resets to idle (used by "Load different bundle" which clears all).
 *
 * Design notes (A26, A30):
 * - `bundles` is plural-shaped; v1 always had length 0 or 1.
 * - `loadingStage` advances synchronously between pipeline steps so
 *   LoadingPanel can display coarse progress without a full event emitter.
 * - The provider must sit inside <BrowserRouter> (done in main.tsx) and wraps
 *   <Routes> inside App.tsx.
 * - Both load callbacks use functional updaters exclusively (A30). Neither
 *   closes over state snapshots, so concurrent calls cannot drop each other's
 *   work. `loadBundleFile` has an empty dep array; `loadBundleFiles` likewise.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { loadBundle, parseBundles } from '@provenance/analysis-core/loader/parse-bundle.js';
import { buildIndex } from '@provenance/analysis-core/index/build-index.js';
import { runValidation } from '@provenance/analysis-core/validation/run-validation.js';
import { establishBundleContributors } from '@provenance/analysis-core/identity/resolve-contributors.js';
import { getRootPublicKeyHex, localValidationOptions } from '../lib/root-key.js';
import { runHeuristics } from '@provenance/analysis-core/heuristics/run-heuristics.js';
import type {
  Bundle,
  LoaderError,
  SessionParseError,
} from '@provenance/analysis-core/loader/types.js';
import type { BlobLoadError } from '@provenance/analysis-core/loader/parse-bundle.js';
import type { EventIndex } from '@provenance/analysis-core/index/event-index.js';
import type { ValidationReport } from '@provenance/analysis-core/validation/check-types.js';
import type { Flag } from '@provenance/analysis-core/heuristics/types.js';
import type { CrossFlag } from '@provenance/analysis-core/heuristics/cross/types.js';
import { runCrossAnalysis } from '@provenance/analysis-core/heuristics/cross/run-cross-heuristics.js';
import { extractCrossFeatures } from '@provenance/analysis-core/heuristics/cross/features.js';
import type { SameScopeExclusion } from '@provenance/analysis-core/coverage/cross-scope.js';
import {
  inspectDroppedFiles,
  candidateToFile,
  type ScopeCandidate,
} from '../lib/inspect-dropped-files.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadingStage = 'unzip' | 'index' | 'validate' | 'heuristics' | null;

/**
 * The choice a monorepo drop puts to the user.
 *
 * A dropped file that is a flat sealed bundle, or a repo holding exactly one
 * sealed scope, never lands here — there is nothing to ask. Only a file holding
 * more than one scope (or none that can be selected) produces a group.
 */
export interface PendingScopeChoice {
  /** Files that need no choice; loaded as-is once the choice is confirmed. */
  passthrough: File[];
  /** One entry per repo-shaped file that holds more than one scope. */
  groups: Array<{ stem: string; candidates: ScopeCandidate[] }>;
}

/**
 * Namespaces a scope path by the file it came from, so two dropped repos that
 * both contain `proj2/` cannot select each other's scope.
 */
export function scopeSelectionKey(stem: string, scopePath: string): string {
  return `${stem} ${scopePath}`;
}

export type BundleContextValue = {
  /** All loaded bundles. Empty when idle/error. */
  bundles: Bundle[];

  /** The id of the currently selected bundle. Null when nothing is loaded. */
  selectedBundleId: string | null;
  /** Switch the active bundle for all single-bundle consumers. */
  selectBundle(id: string): void;

  // Per-bundle maps — sources of truth.
  indicesByBundle: Map<string, EventIndex>;
  validationReportByBundle: Map<string, ValidationReport>;
  flagsByBundle: Map<string, Flag[]>;

  // Derived single-bundle scalars — read from maps using selectedBundleId.
  // These keep v1 consumers working unchanged.
  index: EventIndex | null;
  validationReport: ValidationReport | null;
  flags: Flag[];

  /**
   * Cross-bundle heuristic findings (Phase 18).
   * Populated when bundles.length >= 2 by runCrossHeuristics.
   * Empty when only one bundle is loaded (no cross-bundle analysis possible).
   */
  crossFlags: CrossFlag[];

  /**
   * Pairs of loaded submissions the cross-heuristics did NOT compare, because
   * they are two views of one repository (spec S20).
   *
   * A git-native group submission shares one committed, add-only
   * `.provenance/`, so both partners' signed logs sit inside both partners'
   * archives. Comparing them accuses the two people the course assigned to work
   * together. The suppression is deliberately NOT silent: a grader reading "no
   * findings" has to be able to tell a searched comparison from a withheld one,
   * which is what this list is for (§6 Rule 3 — a fact about the recording,
   * never a finding about anyone).
   *
   * Comes from the same single `partitionCrossScopes` pass that produced the
   * suppression, so it cannot disagree with it.
   */
  crossScopeExclusions: SameScopeExclusion[];

  status: 'idle' | 'loading' | 'choosing' | 'loaded' | 'error';
  loadingStage: LoadingStage;
  /** The loader error, set when status === 'error'. */
  loadError: LoaderError | SessionParseError | null;
  /**
   * Per-blob errors from the most recent multi-file load.
   * Non-empty when some files succeeded and some failed (partial load).
   */
  partialLoadErrors: BlobLoadError[];

  /** The outstanding scope choice; non-null exactly when status === 'choosing'. */
  pendingScopes: PendingScopeChoice | null;

  /** Load a single bundle file (append, not replace). */
  loadBundleFile(file: File): Promise<void>;
  /** Load multiple bundle files at once (fan-out, append). */
  loadBundleFiles(files: File[]): Promise<void>;
  /**
   * Phase A of the drop: inspect the files for repo shape, then either load
   * straight through (the pre-existing behaviour for every flat bundle) or
   * enter 'choosing' so the user can pick which recordings to analyze.
   */
  beginLoad(files: File[]): Promise<void>;
  /** Confirm a pending choice, loading the selected scopes plus any passthrough. */
  chooseScopes(selectionKeys: string[]): Promise<void>;
  /** Abandon a pending choice without loading anything. */
  cancelChoice(): void;
  /** Reset state back to idle. */
  clearBundle(): void;
};

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const BundleContext = createContext<BundleContextValue | null>(null);

/**
 * Read the bundle context.
 *
 * Throws if called outside <BundleProvider> so mis-wired components are
 * caught immediately in development rather than silently rendering blank.
 */
export function useBundle(): BundleContextValue {
  const ctx = useContext(BundleContext);
  if (ctx === null) {
    throw new Error('useBundle must be called inside <BundleProvider>');
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function BundleProvider({ children }: { children: ReactNode }) {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [selectedBundleId, setSelectedBundleId] = useState<string | null>(null);
  const [indicesByBundle, setIndicesByBundle] = useState<Map<string, EventIndex>>(new Map());
  const [validationReportByBundle, setValidationReportByBundle] = useState<
    Map<string, ValidationReport>
  >(new Map());
  const [flagsByBundle, setFlagsByBundle] = useState<Map<string, Flag[]>>(new Map());

  const [crossFlags, setCrossFlags] = useState<CrossFlag[]>([]);
  const [crossScopeExclusions, setCrossScopeExclusions] = useState<SameScopeExclusion[]>([]);

  const [status, setStatus] = useState<BundleContextValue['status']>('idle');
  const [loadingStage, setLoadingStage] = useState<LoadingStage>(null);
  const [loadError, setLoadError] = useState<LoaderError | SessionParseError | null>(null);
  const [partialLoadErrors, setPartialLoadErrors] = useState<BlobLoadError[]>([]);
  const [pendingScopes, setPendingScopes] = useState<PendingScopeChoice | null>(null);

  // ---------------------------------------------------------------------------
  // loadBundleFile — single file, append
  // ---------------------------------------------------------------------------

  const loadBundleFile = useCallback(async (file: File) => {
    setStatus('loading');
    setLoadError(null);
    setPartialLoadErrors([]);
    setLoadingStage('unzip');

    try {
      const bundleResult = await loadBundle(file, file.name);
      if (!bundleResult.ok) {
        setLoadError(bundleResult.error);
        setStatus('error');
        setLoadingStage(null);
        return;
      }
      const bundle = bundleResult.value;

      setLoadingStage('index');
      const idx = buildIndex(bundle);

      setLoadingStage('validate');
      // Stamp "who produced this session?" onto the bundle before anything
      // reads it. `/local` runs entirely in-browser with no server, so this is
      // the ONLY place the stamp can be established here. Unset
      // VITE_ROOT_PUBLIC_KEY_HEX is a supported state: every identified session
      // then reads `unverifiable / no_root_key`, which is "we could not check",
      // not "we checked and it failed", and a bundle with no identity block
      // stays blamelessly `unattributed`.
      await establishBundleContributors(bundle, getRootPublicKeyHex());
      const report = await runValidation(bundle, localValidationOptions());

      setLoadingStage('heuristics');
      const heuristicFlags = runHeuristics(idx, bundle, report);

      // Use functional updaters so this callback never closes over stale state.
      // Concurrent calls (from multiple rapid "Load more" clicks) will each read
      // the latest prev value rather than silently overwriting each other's work.
      setBundles((prev) => [...prev, bundle]);
      setIndicesByBundle((prev) => {
        const m = new Map(prev);
        m.set(bundle.id, idx);
        return m;
      });
      setValidationReportByBundle((prev) => {
        const m = new Map(prev);
        m.set(bundle.id, report);
        return m;
      });
      setFlagsByBundle((prev) => {
        const m = new Map(prev);
        m.set(bundle.id, heuristicFlags);
        return m;
      });
      // Default selectedBundleId to first bundle if not yet set.
      setSelectedBundleId((prev) => prev ?? bundle.id);
      setStatus('loaded');
      setLoadingStage(null);
    } catch (err: unknown) {
      setLoadError({
        kind: 'unknown_failure',
        detail: err instanceof Error ? err.message : 'Unexpected error during load.',
      });
      setStatus('error');
      setLoadingStage(null);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // loadBundleFiles — multi-file fan-out, append
  // ---------------------------------------------------------------------------

  const loadBundleFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    setStatus('loading');
    setLoadError(null);
    setPartialLoadErrors([]);
    setLoadingStage('unzip');

    try {
      const blobs = files.map((f) => f as Blob);
      const filenames = files.map((f) => f.name);
      const { bundles: parsed, errors } = await parseBundles(blobs, filenames);

      // If ALL blobs failed, treat as a hard error.
      if (parsed.length === 0 && errors.length > 0) {
        setLoadError(errors[0]!.error);
        setStatus('error');
        setLoadingStage(null);
        return;
      }

      // Partial failures are surfaced as partialLoadErrors (non-blocking).
      setPartialLoadErrors(errors);

      // Process each successfully parsed bundle sequentially so stage labels
      // advance predictably. Order-independent but sequential avoids multiple
      // concurrent validation calls (WebCrypto) that could interleave stage labels.
      //
      // We accumulate results in local variables (not state snapshots) so that
      // the single functional-updater commit at the end is safe across re-renders.
      type Accumulated = {
        bundles: Bundle[];
        indices: Map<string, EventIndex>;
        reports: Map<string, ValidationReport>;
        flags: Map<string, Flag[]>;
      };
      const accumulated: Accumulated = {
        bundles: [],
        indices: new Map(),
        reports: new Map(),
        flags: new Map(),
      };
      let firstId: string | null = null;

      for (const bundle of parsed) {
        setLoadingStage('index');
        const idx = buildIndex(bundle);

        setLoadingStage('validate');
        // Per bundle, never shared: the stamp is a property of THIS bundle and
        // merging two would attribute one student's sessions to another.
        await establishBundleContributors(bundle, getRootPublicKeyHex());
        const report = await runValidation(bundle, localValidationOptions());

        setLoadingStage('heuristics');
        const heuristicFlags = runHeuristics(idx, bundle, report);

        accumulated.bundles.push(bundle);
        accumulated.indices.set(bundle.id, idx);
        accumulated.reports.set(bundle.id, report);
        accumulated.flags.set(bundle.id, heuristicFlags);
        if (firstId === null) firstId = bundle.id;
      }

      // Single functional-updater commit: merges accumulated results with
      // whatever is currently in state (handles concurrent loadBundleFile calls).
      setBundles((prev) => [...prev, ...accumulated.bundles]);
      setIndicesByBundle((prev) => {
        const m = new Map(prev);
        for (const [id, idx] of accumulated.indices) m.set(id, idx);
        return m;
      });
      setValidationReportByBundle((prev) => {
        const m = new Map(prev);
        for (const [id, report] of accumulated.reports) m.set(id, report);
        return m;
      });
      setFlagsByBundle((prev) => {
        const m = new Map(prev);
        for (const [id, flagList] of accumulated.flags) m.set(id, flagList);
        return m;
      });
      setSelectedBundleId((prev) => prev ?? firstId);
      setStatus('loaded');
      setLoadingStage(null);
    } catch (err: unknown) {
      setLoadError({
        kind: 'unknown_failure',
        detail: err instanceof Error ? err.message : 'Unexpected error during load.',
      });
      setStatus('error');
      setLoadingStage(null);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // beginLoad — Phase A of the drop (scope inspection), then Phase B
  //
  // `loadBundleFiles` is deliberately NOT modified: it is the pipeline every
  // existing caller and test relies on, and the picker needs a decision from
  // the user in the middle of a load, which a single promise cannot express.
  // So the inspection sits in front of it and hands it ordinary Files.
  // ---------------------------------------------------------------------------

  const beginLoad = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setStatus('loading');
      setLoadError(null);
      setPartialLoadErrors([]);
      setLoadingStage('unzip');

      const inspected = await inspectDroppedFiles(files);
      const groups: PendingScopeChoice['groups'] = [];
      const direct: File[] = [];

      for (const item of inspected) {
        if (item.candidates === null) {
          direct.push(item.file);
          continue;
        }
        const stem = item.file.name.endsWith('.zip') ? item.file.name.slice(0, -4) : item.file.name;
        const selectable = item.candidates.filter((c) => c.selectable);
        if (selectable.length === 1) {
          // Exactly one recording in this repo: there is no question to ask.
          direct.push(await candidateToFile(stem, selectable[0]!));
        } else {
          groups.push({ stem, candidates: item.candidates });
        }
      }

      if (groups.length === 0) {
        await loadBundleFiles(direct);
        return;
      }
      setPendingScopes({ passthrough: direct, groups });
      setStatus('choosing');
      setLoadingStage(null);
    },
    [loadBundleFiles],
  );

  // ---------------------------------------------------------------------------
  // chooseScopes / cancelChoice — resolving a pending choice
  // ---------------------------------------------------------------------------

  const chooseScopes = useCallback(
    async (selectionKeys: string[]) => {
      const pending = pendingScopes;
      if (pending === null) return;
      setPendingScopes(null);
      const chosen: File[] = [...pending.passthrough];
      for (const group of pending.groups) {
        for (const c of group.candidates) {
          if (c.selectable && selectionKeys.includes(scopeSelectionKey(group.stem, c.scopePath))) {
            chosen.push(await candidateToFile(group.stem, c));
          }
        }
      }
      if (chosen.length === 0) {
        setStatus('idle');
        return;
      }
      await loadBundleFiles(chosen);
    },
    [pendingScopes, loadBundleFiles],
  );

  const cancelChoice = useCallback(() => {
    setPendingScopes(null);
    setStatus('idle');
    setLoadingStage(null);
  }, []);

  // ---------------------------------------------------------------------------
  // clearBundle — reset all state
  // ---------------------------------------------------------------------------

  const clearBundle = useCallback(() => {
    setBundles([]);
    setSelectedBundleId(null);
    setIndicesByBundle(new Map());
    setValidationReportByBundle(new Map());
    setFlagsByBundle(new Map());
    setCrossFlags([]);
    setCrossScopeExclusions([]);
    setPendingScopes(null);
    setStatus('idle');
    setLoadingStage(null);
    setLoadError(null);
    setPartialLoadErrors([]);
  }, []);

  // ---------------------------------------------------------------------------
  // selectBundle — switch active bundle
  // ---------------------------------------------------------------------------

  const selectBundle = useCallback((id: string) => {
    setSelectedBundleId(id);
  }, []);

  // ---------------------------------------------------------------------------
  // Cross-flags — recomputed whenever bundles or indicesByBundle change (Phase 18).
  //
  // Using useEffect here rather than computing inside load callbacks is the
  // correct approach: load callbacks use empty-dep useCallback (they must not
  // close over state snapshots). After the functional-updater commits settle,
  // React fires this effect with the final, fully-merged bundles +
  // indicesByBundle values. runCrossHeuristics is a pure synchronous function —
  // no async, no I/O, no side effects — so calling it from an effect is safe.
  //
  // When bundles.length < 2, runCrossHeuristics returns [] immediately (no-op).
  // This keeps the single-bundle path identical to Phase 11 behaviour.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const features = [];
    for (const bundle of bundles) {
      const index = indicesByBundle.get(bundle.id);
      if (index !== undefined) features.push(extractCrossFeatures(bundle, index));
    }
    // Both halves of ONE pass. This used to be `runCrossHeuristics` plus a
    // second, side-door `partitionCrossScopes` call to recover the register —
    // which worked here and left the server, which never made that second call,
    // showing the suppression with no explanation for it.
    const { flags, exclusions } = runCrossAnalysis(features);
    setCrossFlags(flags);
    setCrossScopeExclusions([...exclusions]);
  }, [bundles, indicesByBundle]);

  // ---------------------------------------------------------------------------
  // Derived scalars — read from maps using selectedBundleId
  // These keep all v1 consumers working unchanged.
  // ---------------------------------------------------------------------------

  const index = selectedBundleId !== null ? (indicesByBundle.get(selectedBundleId) ?? null) : null;
  const validationReport =
    selectedBundleId !== null ? (validationReportByBundle.get(selectedBundleId) ?? null) : null;
  const flags = selectedBundleId !== null ? (flagsByBundle.get(selectedBundleId) ?? []) : [];

  // ---------------------------------------------------------------------------
  // Context value
  // ---------------------------------------------------------------------------

  const value = useMemo<BundleContextValue>(
    () => ({
      bundles,
      selectedBundleId,
      selectBundle,
      indicesByBundle,
      validationReportByBundle,
      flagsByBundle,
      index,
      validationReport,
      flags,
      crossFlags,
      crossScopeExclusions,
      status,
      loadingStage,
      loadError,
      partialLoadErrors,
      pendingScopes,
      loadBundleFile,
      loadBundleFiles,
      beginLoad,
      chooseScopes,
      cancelChoice,
      clearBundle,
    }),
    [
      bundles,
      selectedBundleId,
      selectBundle,
      indicesByBundle,
      validationReportByBundle,
      flagsByBundle,
      index,
      validationReport,
      flags,
      crossFlags,
      crossScopeExclusions,
      status,
      loadingStage,
      loadError,
      partialLoadErrors,
      pendingScopes,
      loadBundleFile,
      loadBundleFiles,
      beginLoad,
      chooseScopes,
      cancelChoice,
      clearBundle,
    ],
  );

  return <BundleContext.Provider value={value}>{children}</BundleContext.Provider>;
}
