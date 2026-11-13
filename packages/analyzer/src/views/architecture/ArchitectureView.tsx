import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Minus, Plus, Maximize, Search as SearchIcon } from 'lucide-react';
import { ArchitectureTheme, ArchThemeToggle } from './ArchitectureTheme.js';
import { Plate } from './Plate.js';
import { NodeDetailPanel } from './NodeDetailPanel.js';
import { SearchPalette } from './SearchPalette.js';
import { Legend } from './Legend.js';
import { PLATES, worldBounds, type Hit } from './layout.js';
import './architecture.css';

const MIN_K = 0.04;
const MAX_K = 2.6;
const TOP = 56; // top bar height, kept clear when fitting
const DRAG = 4; // px before a press becomes a pan

type View = { tx: number; ty: number; k: number };
type Sel = { diagram: string; node: string } | null;

/** Big plate labels are full strength when the diagrams are too small to read,
 *  and gone once you have zoomed in far enough to read them directly. */
function labelOpacity(k: number): number {
  if (k <= 0.17) return 1;
  if (k >= 0.36) return 0;
  return (0.36 - k) / (0.36 - 0.17);
}

/** The chain-link mark. Its over/under weave is the system's hash chain. */
function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" aria-hidden>
      <defs>
        <clipPath id="arch-mark-cross">
          <rect x="96" y="50" width="64" height="78" />
        </clipPath>
      </defs>
      <rect
        x="50"
        y="74"
        width="96"
        height="104"
        rx="34"
        fill="none"
        stroke="var(--mark-ink)"
        strokeWidth="18"
      />
      <rect
        x="110"
        y="74"
        width="96"
        height="104"
        rx="34"
        fill="none"
        stroke="var(--mark-accent)"
        strokeWidth="18"
      />
      <g clipPath="url(#arch-mark-cross)">
        <rect
          x="50"
          y="74"
          width="96"
          height="104"
          rx="34"
          fill="none"
          stroke="var(--mark-ink)"
          strokeWidth="18"
        />
      </g>
    </svg>
  );
}

function Canvas() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, k: 0.1 });
  const [flying, setFlying] = useState(false);
  const [sel, setSel] = useState<Sel>(null);
  const [active, setActive] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(true);
  const [showHint, setShowHint] = useState(true);
  const flyTimer = useRef<number | undefined>(undefined);
  const press = useRef<{ sx: number; sy: number; tx: number; ty: number; moved: boolean } | null>(
    null,
  );

  const vpSize = () => {
    const r = viewportRef.current?.getBoundingClientRect();
    return { w: r?.width ?? window.innerWidth, h: r?.height ?? window.innerHeight };
  };

  const fitBox = useCallback(
    (box: { x: number; y: number; w: number; h: number }, pad = 0.14, rightInset = 0) => {
      const { w, h } = vpSize();
      const availW = w - rightInset;
      const availH = h - TOP;
      const k = Math.max(
        MIN_K,
        Math.min(MAX_K, Math.min((availW * (1 - pad)) / box.w, (availH * (1 - pad)) / box.h)),
      );
      const tx = rightInset + availW / 2 - (box.x + box.w / 2) * k;
      const ty = TOP + availH / 2 - (box.y + box.h / 2) * k;
      return { tx, ty, k };
    },
    [],
  );

  const flyTo = useCallback((v: View) => {
    window.clearTimeout(flyTimer.current);
    setFlying(true);
    setView(v);
    flyTimer.current = window.setTimeout(() => setFlying(false), 540);
  }, []);

  const fitAll = useCallback(() => {
    setActive(null);
    flyTo(fitBox(worldBounds(), 0.1));
  }, [fitBox, flyTo]);

  const focusPlate = useCallback(
    (name: string, keepSel = false) => {
      const p = PLATES.find((pl) => pl.name === name);
      if (!p) return;
      setActive(name);
      flyTo(fitBox(p, 0.06, keepSel ? 384 : 0));
    },
    [fitBox, flyTo],
  );

  const exitFocus = useCallback(() => {
    setSel(null);
    setActive(null);
    flyTo(fitBox(worldBounds(), 0.1));
  }, [fitBox, flyTo]);

  // First paint: frame the whole map. Runs once; fitBox reads the live viewport
  // size, so it does not need to be a dependency.
  useLayoutEffect(() => {
    setView(fitBox(worldBounds(), 0.1));
  }, [fitBox]);

  // ⌘K / Ctrl-K / "/" opens search; Escape closes the open surface.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA';
      if (
        ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) &&
        !paletteOpen
      ) {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (e.key === 'Escape') {
        if (paletteOpen) setPaletteOpen(false);
        else if (sel) setSel(null);
        else if (active) exitFocus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, sel, active, exitFocus]);

  const zoomAt = useCallback((factor: number, sx: number, sy: number) => {
    setView((v) => {
      const k = Math.max(MIN_K, Math.min(MAX_K, v.k * factor));
      const wx = (sx - v.tx) / v.k;
      const wy = (sy - v.ty) / v.k;
      return { k, tx: sx - wx * k, ty: sy - wy * k };
    });
  }, []);

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      const r = viewportRef.current!.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
    },
    [zoomAt],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setShowHint(false);
    press.current = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) < DRAG) return;
    if (!p.moved) {
      p.moved = true;
      viewportRef.current?.classList.add('dragging');
      viewportRef.current?.setPointerCapture?.(e.pointerId);
    }
    setView((v) => ({ ...v, tx: p.tx + (e.clientX - p.sx), ty: p.ty + (e.clientY - p.sy) }));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    viewportRef.current?.classList.remove('dragging');
    if (!p || p.moved) return; // a drag panned; it selects nothing

    const el = e.target as Element;
    const g = el.closest?.('g.node');
    if (g) {
      // A node opens its detail. If we are zoomed out, also fly into its plate
      // so the node is actually readable.
      const plate = g.closest('.arch-plate');
      const diagram = plate?.getAttribute('data-diagram');
      const node = g.querySelector('title')?.textContent;
      if (diagram && node) {
        setSel({ diagram, node });
        if (view.k < 0.35 && diagram !== active) focusPlate(diagram, true);
      }
      return;
    }
    // A cluster is a labelled box grouping nodes (e.g. "gradescope/"). Clicking
    // one drills into just that box and its contents.
    const cluster = el.closest?.('g.cluster');
    if (cluster) {
      const vp = viewportRef.current!.getBoundingClientRect();
      const r = cluster.getBoundingClientRect();
      const box = {
        x: (r.left - vp.left - view.tx) / view.k,
        y: (r.top - vp.top - view.ty) / view.k,
        w: r.width / view.k,
        h: r.height / view.k,
      };
      const diagram = cluster.closest('.arch-plate')?.getAttribute('data-diagram');
      if (diagram) setActive(diagram);
      flyTo(fitBox(box, 0.16));
      return;
    }
    const plate = el.closest?.('.arch-plate');
    if (plate) {
      focusPlate(plate.getAttribute('data-diagram')!);
      return;
    }
    exitFocus(); // click on empty canvas exits focus and clears the selection
  };

  // Keep the drafting grid locked to the world.
  const gridStyle = {
    '--grid-minor': `${30 * view.k}px`,
    '--grid-major': `${150 * view.k}px`,
    '--grid-x': `${view.tx}px`,
    '--grid-y': `${view.ty}px`,
  } as React.CSSProperties;

  const onPick = useCallback(
    (hit: Hit) => {
      setPaletteOpen(false);
      if (hit.kind === 'node' && hit.node) setSel({ diagram: hit.diagram, node: hit.node });
      focusPlate(hit.diagram, hit.kind === 'node');
    },
    [focusPlate],
  );

  const activePlateTitle = active ? PLATES.find((p) => p.name === active)?.title : 'Whole system';

  return (
    <>
      <div className="arch-topbar">
        <button className="arch-brand" onClick={fitAll} aria-label="Fit the whole map">
          <Mark size={24} />
          <span className="arch-brand-txt">
            <h1>Provenance</h1>
            <small>architecture</small>
          </span>
        </button>
        <div className="arch-topbar-spacer" />
        <button className="arch-search-btn" onClick={() => setPaletteOpen(true)}>
          <SearchIcon size={15} aria-hidden />
          Search the map
          <span className="kbd">⌘K</span>
        </button>
        <button
          className={`arch-iconbtn${legendOpen ? ' on' : ''}`}
          onClick={() => setLegendOpen((v) => !v)}
          aria-pressed={legendOpen}
        >
          Legend
        </button>
        <ArchThemeToggle />
      </div>

      <div
        ref={viewportRef}
        className="arch-viewport"
        style={gridStyle}
        tabIndex={0}
        role="application"
        aria-label="Architecture map. Drag to pan, scroll to zoom, click a node for detail."
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <div
          className={`arch-world${flying ? ' flying' : ''}`}
          style={{ transform: `translate(${view.tx}px, ${view.ty}px) scale(${view.k})` }}
        >
          {PLATES.map((p) => (
            <Plate
              key={p.name}
              plate={p}
              active={active === p.name}
              dim={active !== null && active !== p.name}
              selectedNode={sel?.diagram === p.name ? sel.node : null}
              onActivateNode={(diagram, node) => setSel({ diagram, node })}
            />
          ))}
        </div>
      </div>

      {/* Big plate labels, fading in as the diagrams themselves become too small
          to read. They sit above the canvas but let clicks pass through. */}
      <div className="arch-labels" aria-hidden>
        {PLATES.map((p) => {
          const op = labelOpacity(view.k);
          if (op <= 0 || active === p.name) return null;
          const cx = view.tx + (p.x + p.w / 2) * view.k;
          const cy = view.ty + (p.y + p.h / 2) * view.k;
          return (
            <div key={p.name} className="arch-biglabel" style={{ left: cx, top: cy, opacity: op }}>
              <span className="no">{p.no}</span>
              <span className="ti">{p.title}</span>
            </div>
          );
        })}
      </div>

      {showHint && (
        <div className="arch-hint">Drag to pan · scroll to zoom · click a plate to open it</div>
      )}

      <div className="arch-hud">
        <button
          className="arch-seal"
          onClick={fitAll}
          aria-label={active ? 'Back to the whole map' : 'Fit the whole map'}
        >
          <Mark size={22} />
        </button>
        <div className="arch-hud-read">
          <div>
            <b>{activePlateTitle}</b>
          </div>
          <div className="muted">
            {Math.round(view.k * 100)}%
            {active ? (
              <>
                {' · '}
                <button className="arch-exit" onClick={exitFocus}>
                  exit ⎋
                </button>
              </>
            ) : (
              ' · 13 plates'
            )}
          </div>
        </div>
      </div>

      <div className="arch-zoomctl">
        <button
          onClick={() => {
            const r = viewportRef.current!.getBoundingClientRect();
            zoomAt(1.25, r.width / 2, r.height / 2);
          }}
          aria-label="Zoom in"
        >
          <Plus size={16} aria-hidden />
        </button>
        <button
          onClick={() => {
            const r = viewportRef.current!.getBoundingClientRect();
            zoomAt(1 / 1.25, r.width / 2, r.height / 2);
          }}
          aria-label="Zoom out"
        >
          <Minus size={16} aria-hidden />
        </button>
        <button onClick={fitAll} aria-label="Fit the whole map">
          <Maximize size={15} aria-hidden />
        </button>
      </div>

      {legendOpen && <Legend />}

      {sel && (
        <NodeDetailPanel diagram={sel.diagram} node={sel.node} onClose={() => setSel(null)} />
      )}

      {paletteOpen && <SearchPalette onPick={onPick} onClose={() => setPaletteOpen(false)} />}
    </>
  );
}

export default function ArchitectureView() {
  return (
    <ArchitectureTheme>
      <Canvas />
    </ArchitectureTheme>
  );
}
