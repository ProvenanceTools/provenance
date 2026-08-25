/**
 * contributor-palette — stable `contributorKey` → lane hue, for the split-lane
 * grid (design §4, §6).
 *
 * Design spec: `docs/superpowers/specs/2026-08-24-split-replay-lanes-design.md`.
 *
 * ## Index, not sort
 *
 * The hue is assigned by ARRAY POSITION in `BundleContributors.contributors`,
 * which is first-appearance order (`resolve-contributors.ts:438-469`) and
 * deterministic across re-runs. This module must never sort that array — doing
 * so would make the lane colour a function of some other property (name,
 * activity, flag count) and turn "blue" into an implicit ranking. Stable order
 * in, stable order out.
 *
 * ## Why these six hues, and no others
 *
 * A lane colour's only job is to say "this content belongs to this person" —
 * nothing more. Two other colour families are already load-bearing FINDINGS in
 * this codebase, and a lane hue must never be readable as one of them:
 *
 *  - **Paste-detection orange**, `rgba(251, 146, 60, …)` — the Monaco gutter
 *    decoration for a flagged large paste (`globals.css` `.replay-paste-region`,
 *    Tailwind `orange-400`).
 *  - **External-change red**, `rgba(239, 68, 68, …)` — the gutter decoration for
 *    a change made outside the recorder (`globals.css` `.replay-external-region`,
 *    Tailwind `red-500`).
 *  - **`ContributorTone` chrome** — emerald (`attributed`), slate
 *    (`unattributed` / `identity_not_checked`), amber (`identity_check_failed`)
 *    in `BranchedFileView.tsx`'s `TONE_CHROME`. Amber in particular is a FINDING
 *    ("this identity claim did not verify"); a lane painted amber would make
 *    ordinary co-authorship look like a failed identity check.
 *
 * The six hues below — blue, violet, pink, indigo, fuchsia, sky — are chosen
 * from Tailwind's palette specifically to stay clear of orange, red, emerald,
 * slate and amber as families, not just as exact values, so a lane can never be
 * mistaken at a glance for a paste flag, an external-change flag, or an identity
 * finding. They cycle (mod 6) past six contributors; a seventh contributor
 * repeats the first hue rather than growing the palette, which is an accepted
 * v1 limit (design §11: three code lanes is the practical cap regardless).
 */

export type LaneHue = {
  readonly key: string;
  readonly index: number;
  /** Solid hue, for lane chrome (headers, chips, ribbon strokes). */
  readonly hue: string;
  /** Translucent variant of the same hue, for ribbon fills / background washes. */
  readonly soft: string;
};

/**
 * Tailwind 500-shade hues (solid) with a 16%-alpha translucent variant, in
 * cycle order. Values are literal `rgba()` strings — same convention as the
 * paste/external colours in `globals.css` — rather than Tailwind class names,
 * because lane colour is computed per contributor at runtime and needs to be
 * usable in inline styles (ribbons, SVG strokes), not just class-based chrome.
 */
const HUE_CYCLE: readonly { hue: string; soft: string }[] = [
  { hue: 'rgba(59, 130, 246, 0.9)', soft: 'rgba(59, 130, 246, 0.16)' }, // blue-500
  { hue: 'rgba(139, 92, 246, 0.9)', soft: 'rgba(139, 92, 246, 0.16)' }, // violet-500
  { hue: 'rgba(236, 72, 153, 0.9)', soft: 'rgba(236, 72, 153, 0.16)' }, // pink-500
  { hue: 'rgba(99, 102, 241, 0.9)', soft: 'rgba(99, 102, 241, 0.16)' }, // indigo-500
  { hue: 'rgba(217, 70, 239, 0.9)', soft: 'rgba(217, 70, 239, 0.16)' }, // fuchsia-500
  { hue: 'rgba(14, 165, 233, 0.9)', soft: 'rgba(14, 165, 233, 0.16)' }, // sky-500
];

/**
 * Build the lane palette for one bundle's contributors.
 *
 * `contributors` must be passed in `BundleContributors.contributors` order —
 * this function indexes off array position and does not sort or reorder.
 */
export function buildContributorPalette(
  contributors: readonly { readonly key: string }[],
): ReadonlyMap<string, LaneHue> {
  const palette = new Map<string, LaneHue>();
  contributors.forEach((contributor, index) => {
    const cycled = HUE_CYCLE[index % HUE_CYCLE.length]!;
    palette.set(contributor.key, {
      key: contributor.key,
      index,
      hue: cycled.hue,
      soft: cycled.soft,
    });
  });
  return palette;
}
