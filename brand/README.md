# Provenance brand assets

The Provenance mark is two interlocking rounded-square chain links, woven with a
true over/under — the ink link passes **over** the accent link at the top
crossing and **under** at the bottom. It expresses the system's tamper-evident
hash chain / chain-of-custody.

Design spec: [`../docs/superpowers/specs/2026-06-18-provenance-brand-mark-design.md`](../docs/superpowers/specs/2026-06-18-provenance-brand-mark-design.md)

## Color tokens

UC Berkeley brand colors ([brand.berkeley.edu](https://brand.berkeley.edu/visual-identity/colors/)),
matching the [landing site](https://github.com/ProvenanceTools/provenance-landing). These
replaced the original zinc-ink + orange tokens (`#18181b` / `#EA580C`) in issue #36.

| Token      | Light surface             | Dark surface              |
| ---------- | ------------------------- | ------------------------- |
| Ink / line | `#002676` Berkeley Blue   | `#FFFFFF` White           |
| Accent     | `#FDB515` California Gold | `#FDB515` California Gold |
| Background | `#ffffff`                 | transparent               |

Gold stays solid on both surfaces. On white it is only 1.78:1, so it is the mark's accent
link and never text; in the analyzer, interactive color is Berkeley Blue (see the `berkeley`
scale in `packages/analyzer/tailwind.config.js`).

## Source masters

| File                         | Use                                                     |
| ---------------------------- | ------------------------------------------------------- |
| `provenance-mark.svg`        | symbol, light surface                                   |
| `provenance-mark-dark.svg`   | symbol, dark surface                                    |
| `provenance-lockup.svg`      | symbol + wordmark, light surface                        |
| `provenance-lockup-dark.svg` | symbol + wordmark, dark surface                         |
| `og-card.svg`                | 1200×630 social-embed card (lockup centered on white)   |
| `exports/favicon.svg`        | symbol, adapts to light/dark via `prefers-color-scheme` |

The wordmark uses the analyzer's typeface — the Tailwind default system-sans
stack (`ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial,
sans-serif`), weight 600. Because system fonts render per-machine, ship the
**PNG** lockups for portable embedding; keep the SVG as the editable master.

## Exports

| File                                                  | Where it's wired                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `exports/icon-128.png`                                | recorder VSIX icon → copied to `packages/recorder/icon.png`                                        |
| `exports/favicon.svg`, `exports/favicon-32.png`       | analyzer → `packages/analyzer/public/`                                                             |
| `exports/og-image.png`                                | analyzer social embed → `packages/analyzer/public/` (`og:image` / `twitter:image` in `index.html`) |
| `exports/lockup-light.png`, `exports/lockup-dark.png` | README header (`<picture>`)                                                                        |

## Regenerating exports

Rendered with [`rsvg-convert`](https://gitlab.gnome.org/GNOME/librsvg)
(`brew install librsvg`). From this directory:

```sh
# Recorder VSIX icon (128×128, white background)
rsvg-convert -b white -w 128 -h 128 provenance-mark.svg -o exports/icon-128.png

# Analyzer favicon PNG fallback (32×32)
rsvg-convert -b white -w 32 -h 32 exports/favicon.svg -o exports/favicon-32.png

# Analyzer social-embed card (1200×630, white background)
rsvg-convert -b white -w 1200 -h 630 og-card.svg -o exports/og-image.png

# README lockups
rsvg-convert -b white    -w 1000 -h 256 provenance-lockup.svg      -o exports/lockup-light.png
rsvg-convert -b "#0f1115" -w 1000 -h 256 provenance-lockup-dark.svg -o exports/lockup-dark.png
```

After regenerating, copy into place:

```sh
cp exports/icon-128.png ../packages/recorder/icon.png
cp exports/favicon.svg exports/favicon-32.png exports/og-image.png ../packages/analyzer/public/
```

## Note for the production recorder build

Adding/changing the VSIX icon changes the recorder build hash. When the
production VSIX is cut, refresh the analyzer's known-good extension-hash
allowlist with `npm run update-hashes` (see the root README, "Course staff: key
& manifest workflow"). Otherwise the analyzer will flag the new build as
unrecognized.
