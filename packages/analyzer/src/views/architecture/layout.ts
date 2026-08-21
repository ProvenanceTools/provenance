import rawLayout from './diagrams/layout.json';
import { NODES } from './content/nodes.js';
import { nodeKey } from './content/types.js';

import ecosystem from './diagrams/ecosystem.svg?raw';
import master from './diagrams/master.svg?raw';
import state from './diagrams/state.svg?raw';
import recorder from './diagrams/recorder.svg?raw';
import chain from './diagrams/chain.svg?raw';
import ingest from './diagrams/ingest.svg?raw';
import readpath from './diagrams/readpath.svg?raw';
import er from './diagrams/er.svg?raw';
import analysis from './diagrams/analysis.svg?raw';
import staff from './diagrams/staff.svg?raw';
import provgate from './diagrams/provgate.svg?raw';
import deploy from './diagrams/deploy.svg?raw';
import roadmap from './diagrams/roadmap.svg?raw';

/** A plate's placement on the canvas, packed by build_diagrams.py. */
export type PlateBox = { name: string; x: number; y: number; w: number; h: number };

/** Everything needed to render one plate. */
export type Plate = PlateBox & {
  no: string; // "01"…"13"
  title: string;
  caption: string;
  band: string; // css var name for the plate's primary concern colour
  svg: string;
};

const SVG: Record<string, string> = {
  ecosystem,
  master,
  state,
  recorder,
  chain,
  ingest,
  readpath,
  er,
  analysis,
  staff,
  provgate,
  deploy,
  roadmap,
};

// Title, one-line caption, and the concern band each plate belongs to. Captions
// name what the plate shows in plain terms; they are not sentences.
const META: Record<string, { title: string; caption: string; band: string }> = {
  master: { title: 'End to end', caption: 'student keyboard to staff verdict', band: '--hum' },
  ecosystem: { title: 'Repositories', caption: 'four repos, one signed format', band: '--fmt' },
  state: { title: 'Recorder states', caption: 'activation to sealed bundle', band: '--rec' },
  recorder: {
    title: 'Recorder dataflow',
    caption: 'signals in, hash-chained log out',
    band: '--rec',
  },
  chain: { title: 'Format and crypto', caption: 'keys, chain, seal, verify', band: '--fmt' },
  ingest: { title: 'Ingest pipeline', caption: 'parse, match, analyse, store', band: '--tra' },
  readpath: { title: 'Read path', caption: 'postgres rows or re-parse the blob', band: '--srv' },
  er: { title: 'Data model', caption: '26 tables, no events table', band: '--srv' },
  analysis: { title: 'Analysis engine', caption: 'validation, heuristics, ranking', band: '--ana' },
  staff: { title: 'Staff review', caption: 'ranked queue to evidence', band: '--uix' },
  provgate: { title: 'Gradescope gateway', caption: 'hourly delta sync', band: '--tra' },
  deploy: { title: 'Deployment', caption: 'the EECS apphost', band: '--srv' },
  roadmap: { title: 'Roadmap', caption: 'not built yet', band: '--road' },
};

// build_diagrams.py packs plates in this reading order; keep the numbering in
// step so plate 01 is the first thing a newcomer meets.
const ORDER = [
  'master',
  'ecosystem',
  'state',
  'recorder',
  'chain',
  'ingest',
  'readpath',
  'er',
  'analysis',
  'staff',
  'provgate',
  'deploy',
  'roadmap',
];

const boxes = rawLayout as PlateBox[];

export const PLATES: Plate[] = boxes.map((b) => {
  const meta = META[b.name]!;
  return {
    ...b,
    no: String(ORDER.indexOf(b.name) + 1).padStart(2, '0'),
    title: meta.title,
    caption: meta.caption,
    band: meta.band,
    svg: SVG[b.name]!,
  };
});

/** Bounding box of every plate, for the fit-all view. */
export function worldBounds() {
  const xs = PLATES.map((p) => p.x);
  const ys = PLATES.map((p) => p.y);
  const x2 = PLATES.map((p) => p.x + p.w);
  const y2 = PLATES.map((p) => p.y + p.h);
  return {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...x2) - Math.min(...xs),
    h: Math.max(...y2) - Math.min(...ys),
  };
}

// ---- search index ---------------------------------------------------------

export type Hit = {
  kind: 'plate' | 'node';
  diagram: string;
  node?: string;
  label: string; // display title
  addr: string; // "chain:bind" or "plate 05"
  snippet: string;
  band: string;
  haystack: string; // lowercased searchable text
};

function buildIndex(): Hit[] {
  const hits: Hit[] = [];
  for (const p of PLATES) {
    hits.push({
      kind: 'plate',
      diagram: p.name,
      label: p.title,
      addr: `plate ${p.no}`,
      snippet: p.caption,
      band: p.band,
      haystack: `${p.title} ${p.caption} ${p.name}`.toLowerCase(),
    });
    // node metadata lives keyed "diagram:node"; pull the ones for this plate
    // from the SVG's node titles so search covers every visible node.
    const names = [...p.svg.matchAll(/<g id="[^"]*" class="node">\s*<title>([^<]+)<\/title>/g)].map(
      (m) => m[1]!,
    );
    for (const name of names) {
      const detail = NODES[nodeKey(p.name, name)];
      if (!detail) continue; // self-explanatory nodes carry no panel; skip them
      hits.push({
        kind: 'node',
        diagram: p.name,
        node: name,
        label: detail.title,
        addr: `${p.name}:${name}`,
        snippet: detail.body.split('\n\n')[0]!.slice(0, 120),
        band: p.band,
        haystack:
          `${detail.title} ${name} ${detail.body} ${detail.invariant ?? ''} ${p.title}`.toLowerCase(),
      });
    }
  }
  return hits;
}

export const SEARCH_INDEX: Hit[] = buildIndex();

/** Rank hits for a query. Title matches beat body matches; empty query returns
 *  the plates so the palette opens as a table of contents. */
export function search(q: string): Hit[] {
  const query = q.trim().toLowerCase();
  if (!query) return SEARCH_INDEX.filter((h) => h.kind === 'plate');
  const terms = query.split(/\s+/);
  const scored: { hit: Hit; score: number }[] = [];
  for (const hit of SEARCH_INDEX) {
    let score = 0;
    let ok = true;
    for (const t of terms) {
      if (!hit.haystack.includes(t)) {
        ok = false;
        break;
      }
      if (hit.label.toLowerCase().includes(t)) score += 10;
      if (hit.addr.toLowerCase().includes(t)) score += 6;
      score += 1;
    }
    if (ok) scored.push({ hit, score: score + (hit.kind === 'plate' ? 3 : 0) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 40).map((s) => s.hit);
}
