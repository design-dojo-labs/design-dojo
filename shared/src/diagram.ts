// Pure (no Node or DOM APIs): used by the server for the reviewer prompt and by the web app for live checks.
import type { DiagramGraph } from './hld.js';

type El = Record<string, unknown> & {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted?: boolean;
};

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond']);
const PROXIMITY = 28;

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Human-readable colour name for an Excalidraw hex colour (the reviewer reasons in words, not hex). */
export function colorName(hex: unknown): string | null {
  const h = str(hex).trim().toLowerCase();
  if (!h || h === 'transparent') return null;
  const m = h.match(/^#([0-9a-f]{6})$/);
  if (!m) return h;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 0.08) return l > 0.85 ? 'white' : l < 0.2 ? 'black' : 'gray';
  let hue = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  hue = (hue * 60 + 360) % 360;
  const names: [number, string][] = [
    [15, 'red'],
    [45, 'orange'],
    [70, 'yellow'],
    [160, 'green'],
    [200, 'teal'],
    [255, 'blue'],
    [290, 'violet'],
    [335, 'pink'],
    [360, 'red'],
  ];
  const name = names.find(([lim]) => hue < lim)![1];
  return l > 0.75 ? `light ${name}` : l < 0.3 ? `dark ${name}` : name;
}

function center(e: El) {
  return { x: num(e.x) + num(e.width) / 2, y: num(e.y) + num(e.height) / 2 };
}

function contains(e: El, p: { x: number; y: number }, pad = 0) {
  const x1 = Math.min(num(e.x), num(e.x) + num(e.width)) - pad;
  const x2 = Math.max(num(e.x), num(e.x) + num(e.width)) + pad;
  const y1 = Math.min(num(e.y), num(e.y) + num(e.height)) - pad;
  const y2 = Math.max(num(e.y), num(e.y) + num(e.height)) + pad;
  return p.x >= x1 && p.x <= x2 && p.y >= y1 && p.y <= y2;
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Interprets an Excalidraw scene as a system diagram: shapes become components (labelled by their
 * bound text, or by free text placed on top of them), arrows/lines become connections (by binding, or
 * by endpoint proximity — marked "inferred"), remaining text becomes notes. Nothing is guessed beyond
 * that; uninterpretable drawings are listed as ignored.
 */
export function interpretDiagram(raw: Record<string, unknown>[]): DiagramGraph {
  const els = raw.filter((e): e is El => !!e && typeof e.id === 'string' && typeof e.type === 'string' && !e.isDeleted) as El[];
  const byId = new Map(els.map((e) => [e.id, e]));
  const texts = els.filter((e) => e.type === 'text');
  const usedText = new Set<string>();
  const frames = new Map(els.filter((e) => e.type === 'frame' || e.type === 'magicframe').map((f) => [f.id, clean(str(f.name)) || 'frame']));

  const shapes = els.filter((e) => SHAPES.has(e.type)).sort((a, b) => num(a.y) - num(b.y) || num(a.x) - num(b.x));
  const components: DiagramGraph['components'] = [];
  const refOf = new Map<string, string>();
  let unlabeled = 0;
  for (const s of shapes) {
    let label = '';
    const bound = texts.find((t) => t.containerId === s.id);
    if (bound) {
      label = clean(str(bound.originalText) || str(bound.text));
      usedText.add(bound.id);
    } else {
      // A free text box sitting on the shape counts as its label.
      const over = texts.find((t) => !t.containerId && !usedText.has(t.id) && contains(s, center(t)));
      if (over) {
        label = clean(str(over.text));
        usedText.add(over.id);
      }
    }
    const custom = (s.customData ?? {}) as Record<string, unknown>;
    if (!label) label = `(unlabeled ${s.type} ${++unlabeled})`;
    const ref = `C${components.length + 1}`;
    refOf.set(s.id, ref);
    const frame = typeof s.frameId === 'string' ? frames.get(s.frameId) : undefined;
    const kind = typeof custom.component === 'string' ? custom.component : null;
    components.push({
      ref,
      label,
      shape: s.type,
      kind: frame ? `${kind ?? 'component'} in frame "${frame}"` : kind,
      color: colorName(s.backgroundColor) ?? colorName(s.strokeColor),
    });
  }

  const nearest = (p: { x: number; y: number }) => shapes.find((s) => contains(s, p, PROXIMITY));
  const connections: DiagramGraph['connections'] = [];
  const ignored: string[] = [];
  let looseArrows = 0;
  for (const a of els.filter((e) => e.type === 'arrow' || e.type === 'line')) {
    const pts = Array.isArray(a.points) ? (a.points as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2) : [];
    if (pts.length < 2) continue;
    const start = { x: num(a.x) + num(pts[0][0]), y: num(a.y) + num(pts[0][1]) };
    const end = { x: num(a.x) + num(pts[pts.length - 1][0]), y: num(a.y) + num(pts[pts.length - 1][1]) };
    const sb = (a.startBinding as { elementId?: string } | null)?.elementId;
    const eb = (a.endBinding as { elementId?: string } | null)?.elementId;
    let inferred = false;
    let from = sb && byId.has(sb) && refOf.has(sb) ? sb : undefined;
    let to = eb && byId.has(eb) && refOf.has(eb) ? eb : undefined;
    if (!from) {
      const n = nearest(start);
      if (n) (from = n.id), (inferred = true);
    }
    if (!to) {
      const n = nearest(end);
      if (n) (to = n.id), (inferred = true);
    }
    const labelText = texts.find((t) => t.containerId === a.id);
    if (labelText) usedText.add(labelText.id);
    if (!from || !to || from === to) {
      looseArrows++;
      continue;
    }
    const startHead = a.type === 'arrow' && a.startArrowhead != null;
    const endHead = a.type === 'arrow' && a.endArrowhead != null;
    // An arrow drawn "backwards" (head only at the start) points from its end to its start.
    const [f, t] = startHead && !endHead ? [to, from] : [from, to];
    const text = labelText ? clean(str(labelText.originalText) || str(labelText.text)) : '';
    connections.push({
      from: refOf.get(f)!,
      to: refOf.get(t)!,
      label: startHead && endHead ? `${text} (bidirectional)`.trim() : text || null,
      directed: startHead || endHead,
      inferred,
    });
  }
  if (looseArrows) ignored.push(`${looseArrows} arrow/line(s) not connected to any component`);

  const notes = texts.filter((t) => !usedText.has(t.id) && !t.containerId).map((t) => clean(str(t.text))).filter(Boolean);
  const freedraw = els.filter((e) => e.type === 'freedraw').length;
  if (freedraw) ignored.push(`${freedraw} freehand drawing(s)`);
  const images = els.filter((e) => e.type === 'image').length;
  if (images) ignored.push(`${images} image(s)`);
  return { components, connections, notes, ignored };
}

/** Plain-text rendering of the graph for the reviewer prompt and the learner's "what the reviewer sees" view. */
export function graphToText(g: DiagramGraph): string {
  if (!g.components.length && !g.notes.length) return 'The diagram is empty.';
  const label = (ref: string) => `${ref} "${g.components.find((c) => c.ref === ref)?.label ?? ref}"`;
  const lines: string[] = [];
  lines.push(`Components (${g.components.length}):`);
  for (const c of g.components) lines.push(`- ${c.ref} "${c.label}" (${c.shape}${c.color ? `, ${c.color}` : ''}${c.kind ? `, ${c.kind}` : ''})`);
  lines.push('', `Connections (${g.connections.length}):`);
  for (const e of g.connections) {
    lines.push(`- ${label(e.from)} ${e.directed ? '→' : '—'} ${label(e.to)}${e.label ? `  [${e.label}]` : ''}${e.inferred ? '  (endpoint matched by proximity, not attached)' : ''}`);
  }
  if (g.notes.length) lines.push('', 'Free-text notes on the canvas:', ...g.notes.map((n) => `- ${n}`));
  if (g.ignored.length) lines.push('', `Not interpreted: ${g.ignored.join('; ')}`);
  return lines.join('\n');
}

/** Matches a component name used by the reviewer to an actual diagram label (null when it does not exist). */
export function matchComponent(name: string, g: DiagramGraph): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const n = norm(name.replace(/^C\d+\s*/, ''));
  const byRef = g.components.find((c) => c.ref.toLowerCase() === name.trim().toLowerCase().split(/\s/)[0]);
  if (byRef) return byRef.label;
  const exact = g.components.find((c) => norm(c.label) === n);
  if (exact) return exact.label;
  const partial = g.components.find((c) => n.length >= 3 && (norm(c.label).includes(n) || n.includes(norm(c.label))) && norm(c.label).length >= 3);
  return partial?.label ?? null;
}
