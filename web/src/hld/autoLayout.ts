// Pure layout helpers for the architecture canvas. They work on plain Excalidraw element records and
// return position updates; the canvas applies them (bumping versions) as one undoable scene change.

type Point = [number, number];

export interface LayoutElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
  containerId?: string | null;
  customData?: Record<string, unknown> | null;
  startBinding?: { elementId: string; [k: string]: unknown } | null;
  endBinding?: { elementId: string; [k: string]: unknown } | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  points?: readonly (readonly number[])[];
  elbowed?: boolean;
}

export interface LayoutUpdate {
  x: number;
  y: number;
  width?: number;
  height?: number;
  points?: Point[];
  startBinding?: Record<string, unknown> | null;
  endBinding?: Record<string, unknown> | null;
  elbowed?: boolean;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
  type: string;
}

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);
/** Excalidraw's usual gap between a bound arrow end and its shape. */
export const ARROW_GAP = 8;

/**
 * Point on the boundary of `box` (plus a gap) along the line from its centre towards (dx, dy).
 * Ellipses and diamonds use their real outline so arrow heads meet the shape.
 */
export function edgePoint(box: Box, dx: number, dy: number, gap = ARROW_GAP): Point {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const hw = box.width / 2;
  const hh = box.height / 2;
  const len = Math.hypot(dx, dy);
  if (!len) return [cx, cy];
  let s: number;
  if (box.type === 'ellipse') s = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (box.type === 'diamond') s = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return [cx + dx * s + (dx / len) * gap, cy + dy * s + (dy / len) * gap];
}

/** Straight arrow geometry from shape `a` to shape `b`, ends clipped to both outlines. */
export function arrowBetween(a: Box, b: Box): { x: number; y: number; width: number; height: number; points: Point[] } {
  const dx = b.x + b.width / 2 - (a.x + a.width / 2);
  const dy = b.y + b.height / 2 - (a.y + a.height / 2);
  const [sx, sy] = edgePoint(a, dx, dy);
  const [ex, ey] = edgePoint(b, -dx, -dy);
  return { x: sx, y: sy, width: Math.abs(ex - sx), height: Math.abs(ey - sy), points: [[0, 0], [ex - sx, ey - sy]] };
}

export function overlaps(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }, margin = 0): boolean {
  return a.x - margin < b.x + b.width && b.x - margin < a.x + a.width && a.y - margin < b.y + b.height && b.y - margin < a.y + a.height;
}

export function boundsOf(els: readonly { x: number; y: number; width: number; height: number }[]): { x: number; y: number; width: number; height: number } | null {
  if (!els.length) return null;
  const minX = Math.min(...els.map((e) => Math.min(e.x, e.x + e.width)));
  const minY = Math.min(...els.map((e) => Math.min(e.y, e.y + e.height)));
  const maxX = Math.max(...els.map((e) => Math.max(e.x, e.x + e.width)));
  const maxY = Math.max(...els.map((e) => Math.max(e.y, e.y + e.height)));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Layered left-to-right layout of the diagram's components, following their arrow connections:
 * sources on the left, each component one column right of everything that points to it. Cycles are
 * broken for layering only; unconnected components go in a final column. Bound labels move with their
 * shapes and bound arrows are re-routed straight between the new positions (bindings kept).
 * Region/zone boxes stay where they are.
 */
export function tidyLayout(elements: readonly LayoutElement[], opts: { gapX?: number; gapY?: number } = {}): Map<string, LayoutUpdate> {
  const gapX = opts.gapX ?? 120;
  const gapY = opts.gapY ?? 60;
  const live = elements.filter((e) => !e.isDeleted);
  const byId = new Map(live.map((e) => [e.id, e]));
  const nodes = live
    .filter((e) => SHAPES.has(e.type) && e.customData?.component !== 'region')
    .sort((a, b) => a.y - b.y || a.x - b.x);
  const updates = new Map<string, LayoutUpdate>();
  if (nodes.length < 2) return updates;
  const index = new Map(nodes.map((n, i) => [n.id, i]));

  // Directed edges between laid-out nodes (an arrow with only a start head points backwards).
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  for (const a of live) {
    if (a.type !== 'arrow' && a.type !== 'line') continue;
    let from = a.startBinding ? index.get(a.startBinding.elementId) : undefined;
    let to = a.endBinding ? index.get(a.endBinding.elementId) : undefined;
    if (from === undefined || to === undefined || from === to) continue;
    if (a.type === 'arrow' && a.startArrowhead && !a.endArrowhead) [from, to] = [to, from];
    const key = `${from}>${to}`;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push([from, to]);
    }
  }

  const n = nodes.length;
  const out: number[][] = Array.from({ length: n }, () => []);
  for (const [f, t] of edges) out[f].push(t);
  // Break cycles: DFS in node order, dropping back edges (layering only — arrows are untouched).
  const state = new Array<number>(n).fill(0);
  const dag: number[][] = Array.from({ length: n }, () => []);
  const visit = (v: number) => {
    state[v] = 1;
    for (const w of out[v]) {
      if (state[w] === 1) continue; // back edge
      dag[v].push(w);
      if (state[w] === 0) visit(w);
    }
    state[v] = 2;
  };
  for (let v = 0; v < n; v++) if (state[v] === 0) visit(v);

  // Longest-path layering.
  const indeg = new Array<number>(n).fill(0);
  for (const v of dag.keys()) for (const w of dag[v]) indeg[w]++;
  const rank = new Array<number>(n).fill(0);
  const queue = [...Array(n).keys()].filter((v) => indeg[v] === 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const v = queue[qi];
    for (const w of dag[v]) {
      rank[w] = Math.max(rank[w], rank[v] + 1);
      if (--indeg[w] === 0) queue.push(w);
    }
  }
  const connected = new Set(edges.flat());
  const maxRank = Math.max(0, ...[...connected].map((v) => rank[v]));
  const layers: number[][] = [];
  const isolated = [...Array(n).keys()].filter((v) => !connected.has(v));
  for (const v of [...Array(n).keys()]) {
    if (!connected.has(v)) continue;
    (layers[rank[v]] ??= []).push(v);
  }
  if (!connected.size) {
    // Nothing connected: a tidy grid instead of a single tall column.
    const cols = Math.ceil(Math.sqrt(n));
    for (let i = 0; i < n; i++) (layers[i % cols] ??= []).push(i);
  } else if (isolated.length) layers[maxRank + 1] = isolated;

  // Barycenter ordering, a few sweeps each way.
  const neighbours: number[][] = Array.from({ length: n }, () => []);
  for (const [f, t] of edges) {
    neighbours[f].push(t);
    neighbours[t].push(f);
  }
  const pos = new Map<number, number>();
  const setPos = () => layers.forEach((l) => l?.forEach((v, i) => pos.set(v, i)));
  layers.forEach((l) => l?.sort((a, b) => nodes[a].y - nodes[b].y || a - b));
  setPos();
  for (let sweep = 0; sweep < 4; sweep++) {
    const order = sweep % 2 === 0 ? layers.keys() : [...layers.keys()].reverse();
    for (const li of order) {
      const layer = layers[li];
      if (!layer) continue;
      const bary = (v: number) => {
        const adj = neighbours[v].filter((w) => pos.has(w) && layerOf(layers, w) !== li);
        return adj.length ? adj.reduce((s, w) => s + pos.get(w)!, 0) / adj.length : pos.get(v)!;
      };
      const scored = layer.map((v) => ({ v, b: bary(v) }));
      scored.sort((a, b) => a.b - b.b || pos.get(a.v)! - pos.get(b.v)!);
      layers[li] = scored.map((s) => s.v);
      setPos();
    }
  }

  // Coordinates: columns left to right, each centred vertically on the tallest column.
  const origin = boundsOf(nodes)!;
  const colWidth = layers.map((l) => (l ? Math.max(...l.map((v) => nodes[v].width)) : 0));
  const colHeight = layers.map((l) => (l ? l.reduce((s, v) => s + nodes[v].height, 0) + gapY * (l.length - 1) : 0));
  const tallest = Math.max(...colHeight);
  const newBox = new Map<string, Box>();
  let x = origin.x;
  layers.forEach((layer, li) => {
    if (!layer) return;
    let y = origin.y + (tallest - colHeight[li]) / 2;
    for (const v of layer) {
      const nd = nodes[v];
      const nx = x + (colWidth[li] - nd.width) / 2;
      newBox.set(nd.id, { x: nx, y, width: nd.width, height: nd.height, type: nd.type });
      y += nd.height + gapY;
    }
    x += colWidth[li] + gapX;
  });

  for (const nd of nodes) {
    const b = newBox.get(nd.id)!;
    const dx = b.x - nd.x;
    const dy = b.y - nd.y;
    if (dx || dy) updates.set(nd.id, { x: b.x, y: b.y });
  }
  // Labels bound to moved shapes move with them.
  for (const t of live) {
    if (t.type !== 'text' || !t.containerId) continue;
    const c = byId.get(t.containerId);
    const b = c && newBox.get(c.id);
    if (c && b && (b.x !== c.x || b.y !== c.y)) updates.set(t.id, { x: t.x + (b.x - c.x), y: t.y + (b.y - c.y) });
  }
  // Re-route arrows attached to moved shapes, then keep their labels at the midpoint.
  const boxOf = (id: string | undefined): Box | null => {
    if (!id) return null;
    const moved = newBox.get(id);
    if (moved) return moved;
    const e = byId.get(id);
    return e && SHAPES.has(e.type) ? { x: e.x, y: e.y, width: e.width, height: e.height, type: e.type } : null;
  };
  for (const a of live) {
    if (a.type !== 'arrow' && a.type !== 'line') continue;
    const sId = a.startBinding?.elementId;
    const eId = a.endBinding?.elementId;
    if (!(sId && newBox.has(sId)) && !(eId && newBox.has(eId))) continue;
    const sBox = boxOf(sId);
    const eBox = boxOf(eId);
    const pts = (a.points ?? [[0, 0]]).map((p) => [Number(p[0]) || 0, Number(p[1]) || 0] as Point);
    const absStart: Point = [a.x + pts[0][0], a.y + pts[0][1]];
    const absEnd: Point = [a.x + pts[pts.length - 1][0], a.y + pts[pts.length - 1][1]];
    let geom: { x: number; y: number; width: number; height: number; points: Point[] };
    if (sBox && eBox) geom = arrowBetween(sBox, eBox);
    else {
      // One end attached: move that end with its shape, keep the free end where it was.
      const shift = (id: string | undefined, p: Point): Point => {
        const old = id ? byId.get(id) : undefined;
        const nb = id ? newBox.get(id) : undefined;
        return old && nb ? [p[0] + nb.x - old.x, p[1] + nb.y - old.y] : p;
      };
      const s = shift(sId, absStart);
      const e = shift(eId, absEnd);
      geom = { x: s[0], y: s[1], width: Math.abs(e[0] - s[0]), height: Math.abs(e[1] - s[1]), points: [[0, 0], [e[0] - s[0], e[1] - s[1]]] };
    }
    const upd: LayoutUpdate = { ...geom };
    if (a.startBinding && sBox) upd.startBinding = { ...a.startBinding, focus: 0, gap: ARROW_GAP };
    if (a.endBinding && eBox) upd.endBinding = { ...a.endBinding, focus: 0, gap: ARROW_GAP };
    if (a.elbowed) upd.elbowed = false;
    updates.set(a.id, upd);
    const label = live.find((t) => t.type === 'text' && t.containerId === a.id);
    if (label) {
      const [px, py] = geom.points[geom.points.length - 1];
      updates.set(label.id, { x: geom.x + px / 2 - label.width / 2, y: geom.y + py / 2 - label.height / 2 });
    }
  }
  return updates;
}

function layerOf(layers: number[][], v: number): number {
  return layers.findIndex((l) => l?.includes(v));
}
