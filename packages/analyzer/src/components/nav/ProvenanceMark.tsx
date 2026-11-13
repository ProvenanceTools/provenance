/**
 * ProvenanceMark — the Provenance brand symbol (two woven interlocking links).
 *
 * Inline SVG so it stays crisp at any size and needs no asset loading. Colors
 * are the light-surface brand tokens — Berkeley Blue ink, California Gold
 * accent (the app header is white); the ink link
 * weaves over the accent link at the top crossing and under at the bottom.
 *
 * Source master: brand/provenance-mark.svg. Keep geometry in sync with it.
 *
 * Decorative by default (aria-hidden) — the adjacent "Provenance" wordmark
 * carries the accessible name.
 */
interface ProvenanceMarkProps {
  className?: string;
}

export function ProvenanceMark({ className }: ProvenanceMarkProps) {
  return (
    <svg
      viewBox="0 0 256 256"
      className={className}
      aria-hidden="true"
      focusable="false"
      role="img"
    >
      <defs>
        <clipPath id="provenance-mark-topcross">
          <rect x="96" y="50" width="64" height="78" />
        </clipPath>
      </defs>
      {/* base ink link */}
      <rect
        x="50"
        y="74"
        width="96"
        height="104"
        rx="34"
        fill="none"
        stroke="#002676"
        strokeWidth="18"
      />
      {/* accent link over (covers ink at both crossings) */}
      <rect
        x="110"
        y="74"
        width="96"
        height="104"
        rx="34"
        fill="none"
        stroke="#FDB515"
        strokeWidth="18"
      />
      {/* re-draw ink at the top crossing so the links weave */}
      <g clipPath="url(#provenance-mark-topcross)">
        <rect
          x="50"
          y="74"
          width="96"
          height="104"
          rx="34"
          fill="none"
          stroke="#002676"
          strokeWidth="18"
        />
      </g>
    </svg>
  );
}
