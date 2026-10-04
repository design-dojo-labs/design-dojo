// Component styles and starter templates for the architecture canvas. Templates become ordinary,
// fully editable Excalidraw shapes and bound arrows (same kinds and colours as the "Add" bar).
import { arrowBetween, type Box } from './autoLayout';

export type ComponentKind =
  | 'client'
  | 'cdn'
  | 'dns'
  | 'load-balancer'
  | 'api-gateway'
  | 'service'
  | 'worker'
  | 'database'
  | 'cache'
  | 'queue'
  | 'object-storage'
  | 'search-index'
  | 'external'
  | 'region';

export type ShapeType = 'rectangle' | 'ellipse' | 'diamond';

export const KIND_STYLE: Record<ComponentKind, { shape: ShapeType; bg: string; dashed?: boolean }> = {
  client: { shape: 'ellipse', bg: '#e9ecef' },
  cdn: { shape: 'ellipse', bg: '#99e9f2' },
  dns: { shape: 'ellipse', bg: '#c5f6fa' },
  'load-balancer': { shape: 'diamond', bg: '#ffec99' },
  'api-gateway': { shape: 'rectangle', bg: '#d0bfff' },
  service: { shape: 'rectangle', bg: '#a5d8ff' },
  worker: { shape: 'rectangle', bg: '#a5d8ff', dashed: true },
  database: { shape: 'rectangle', bg: '#b2f2bb' },
  cache: { shape: 'rectangle', bg: '#ffc9c9' },
  queue: { shape: 'rectangle', bg: '#ffd8a8' },
  'object-storage': { shape: 'rectangle', bg: '#96f2d7' },
  'search-index': { shape: 'rectangle', bg: '#eebefa' },
  external: { shape: 'rectangle', bg: '#f1f3f5', dashed: true },
  region: { shape: 'rectangle', bg: 'transparent', dashed: true },
};

/** Default size of a component shape of the given type. */
export function shapeSize(shape: ShapeType): { width: number; height: number } {
  return shape === 'diamond' ? { width: 170, height: 100 } : shape === 'ellipse' ? { width: 170, height: 80 } : { width: 170, height: 72 };
}

interface TemplateNode {
  key: string;
  kind: ComponentKind;
  label: string;
  col: number;
  row: number;
}

export interface DiagramTemplate {
  id: string;
  name: string;
  description: string;
  nodes: TemplateNode[];
  edges: { from: string; to: string; label?: string }[];
}

export const TEMPLATES: DiagramTemplate[] = [
  {
    id: 'web-app',
    name: 'Web app',
    description: 'Client → load balancer → service, with a cache and a database',
    nodes: [
      { key: 'client', kind: 'client', label: 'Client', col: 0, row: 1 },
      { key: 'lb', kind: 'load-balancer', label: 'Load balancer', col: 1, row: 1 },
      { key: 'svc', kind: 'service', label: 'App service', col: 2, row: 1 },
      { key: 'cache', kind: 'cache', label: 'Cache', col: 3, row: 0 },
      { key: 'db', kind: 'database', label: 'Database', col: 3, row: 2 },
    ],
    edges: [
      { from: 'client', to: 'lb', label: 'HTTPS' },
      { from: 'lb', to: 'svc' },
      { from: 'svc', to: 'cache', label: 'read-through' },
      { from: 'svc', to: 'db', label: 'read / write' },
    ],
  },
  {
    id: 'async-pipeline',
    name: 'Async pipeline',
    description: 'Service → queue → worker → store, so slow work leaves the request path',
    nodes: [
      { key: 'svc', kind: 'service', label: 'API service', col: 0, row: 1 },
      { key: 'queue', kind: 'queue', label: 'Job queue', col: 1, row: 1 },
      { key: 'worker', kind: 'worker', label: 'Worker', col: 2, row: 1 },
      { key: 'db', kind: 'database', label: 'Results store', col: 3, row: 1 },
      { key: 'blob', kind: 'object-storage', label: 'Object storage', col: 3, row: 0 },
    ],
    edges: [
      { from: 'svc', to: 'queue', label: 'enqueue job' },
      { from: 'queue', to: 'worker', label: 'consume' },
      { from: 'worker', to: 'db', label: 'write result' },
      { from: 'worker', to: 'blob', label: 'store files' },
    ],
  },
  {
    id: 'read-heavy',
    name: 'Read-heavy',
    description: 'CDN for static content, cache-aside in front of the database',
    nodes: [
      { key: 'client', kind: 'client', label: 'Client', col: 0, row: 1 },
      { key: 'cdn', kind: 'cdn', label: 'CDN', col: 1, row: 0 },
      { key: 'lb', kind: 'load-balancer', label: 'Load balancer', col: 1, row: 2 },
      { key: 'svc', kind: 'service', label: 'Read service', col: 2, row: 2 },
      { key: 'cache', kind: 'cache', label: 'Cache', col: 3, row: 1 },
      { key: 'db', kind: 'database', label: 'Database', col: 3, row: 3 },
    ],
    edges: [
      { from: 'client', to: 'cdn', label: 'static assets' },
      { from: 'client', to: 'lb', label: 'API calls' },
      { from: 'lb', to: 'svc' },
      { from: 'svc', to: 'cache', label: '1. get' },
      { from: 'svc', to: 'db', label: '2. on miss' },
    ],
  },
  {
    id: 'event-fanout',
    name: 'Event fan-out',
    description: 'One producer, a stream, and independent consumers with their own stores',
    nodes: [
      { key: 'svc', kind: 'service', label: 'Producer service', col: 0, row: 1 },
      { key: 'stream', kind: 'queue', label: 'Event stream', col: 1, row: 1 },
      { key: 'a', kind: 'worker', label: 'Indexer', col: 2, row: 0 },
      { key: 'b', kind: 'worker', label: 'Aggregator', col: 2, row: 2 },
      { key: 'search', kind: 'search-index', label: 'Search index', col: 3, row: 0 },
      { key: 'db', kind: 'database', label: 'Analytics store', col: 3, row: 2 },
    ],
    edges: [
      { from: 'svc', to: 'stream', label: 'publish events' },
      { from: 'stream', to: 'a', label: 'consume' },
      { from: 'stream', to: 'b', label: 'consume' },
      { from: 'a', to: 'search' },
      { from: 'b', to: 'db' },
    ],
  },
];

const COL_W = 270;
const ROW_H = 140;

/** Size of a template when placed, for finding free space on the canvas. */
export function templateSize(t: DiagramTemplate): { width: number; height: number } {
  const cols = Math.max(...t.nodes.map((n) => n.col)) + 1;
  const rows = Math.max(...t.nodes.map((n) => n.row)) + 1;
  return { width: cols * COL_W - 30, height: rows * ROW_H - (ROW_H - 100) };
}

/**
 * Excalidraw element skeletons for a template placed with its top-left at (ox, oy). Shapes carry
 * customData.component like the "Add" bar; arrows bind to their shapes by id (ids are regenerated by
 * convertToExcalidrawElements, so a template can be inserted any number of times).
 */
export function templateSkeletons(t: DiagramTemplate, ox: number, oy: number): Record<string, unknown>[] {
  const boxes = new Map<string, Box>();
  const shapes = t.nodes.map((n) => {
    const style = KIND_STYLE[n.kind];
    const base = shapeSize(style.shape);
    // Grow the box with its label so text never spills out (ellipses and diamonds need extra room).
    const fit = n.label.length * 12 + 44;
    const width = Math.min(COL_W - 30, Math.max(base.width, style.shape === 'rectangle' ? fit : Math.round(fit * 1.35)));
    const height = base.height;
    const cx = ox + n.col * COL_W + width / 2; // left-aligned in its column, so wide boxes stay inside the template
    const cy = oy + n.row * ROW_H + 50;
    const box: Box = { x: cx - width / 2, y: cy - height / 2, width, height, type: style.shape };
    boxes.set(n.key, box);
    return {
      type: style.shape,
      id: `tpl-${t.id}-${n.key}`,
      x: box.x,
      y: box.y,
      width,
      height,
      backgroundColor: style.bg,
      fillStyle: 'solid',
      strokeStyle: style.dashed ? 'dashed' : 'solid',
      roundness: style.shape === 'rectangle' ? { type: 3 } : null,
      label: { text: n.label },
      customData: { component: n.kind },
    };
  });
  const arrows = t.edges.map((e) => {
    const g = arrowBetween(boxes.get(e.from)!, boxes.get(e.to)!);
    return {
      type: 'arrow',
      x: g.x,
      y: g.y,
      width: g.width,
      height: g.height,
      points: g.points,
      start: { id: `tpl-${t.id}-${e.from}` },
      end: { id: `tpl-${t.id}-${e.to}` },
      endArrowhead: 'arrow',
      ...(e.label ? { label: { text: e.label, fontSize: 14 } } : {}),
    };
  });
  return [...shapes, ...arrows];
}
