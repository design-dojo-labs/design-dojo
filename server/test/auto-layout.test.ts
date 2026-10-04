import { describe, expect, it } from 'vitest';
import { interpretDiagram } from '@lld/shared';
import { arrowBetween, edgePoint, tidyLayout, type LayoutElement } from '../../web/src/hld/autoLayout';
import { TEMPLATES, templateSkeletons } from '../../web/src/hld/templates';

const box = (id: string, x: number, y: number, extra: Partial<LayoutElement> = {}): LayoutElement => ({ id, type: 'rectangle', x, y, width: 160, height: 80, ...extra });
const label = (id: string, container: string, x: number, y: number): LayoutElement => ({ id, type: 'text', x, y, width: 60, height: 20, containerId: container });
const link = (id: string, from: string, to: string, extra: Partial<LayoutElement> = {}): LayoutElement => ({
  id,
  type: 'arrow',
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  points: [
    [0, 0],
    [10, 10],
  ],
  startBinding: { elementId: from, focus: 0.3, gap: 4 },
  endBinding: { elementId: to, focus: -0.2, gap: 4 },
  startArrowhead: null,
  endArrowhead: 'arrow',
  ...extra,
});

/** Applies updates to a copy of the scene, like the canvas does. */
function apply(els: LayoutElement[], updates: ReturnType<typeof tidyLayout>): LayoutElement[] {
  return els.map((e) => ({ ...e, ...(updates.get(e.id) ?? {}) }) as LayoutElement);
}
const pos = (els: LayoutElement[], id: string) => els.find((e) => e.id === id)!;

describe('tidyLayout', () => {
  it('puts each component one column right of what points to it', () => {
    // Deliberately scrambled: C sits left of A.
    const els = [box('c', 0, 0), box('a', 600, 300), box('b', 300, 600), link('ab', 'a', 'b'), link('bc', 'b', 'c'), link('ad', 'a', 'd'), box('d', 50, 900)];
    const out = apply(els, tidyLayout(els));
    expect(pos(out, 'a').x).toBeLessThan(pos(out, 'b').x);
    expect(pos(out, 'b').x).toBeLessThan(pos(out, 'c').x);
    expect(pos(out, 'b').x).toBe(pos(out, 'd').x); // same layer
    expect(pos(out, 'b').y).not.toBe(pos(out, 'd').y);
  });

  it('survives cycles and places unconnected components in a final column', () => {
    const els = [box('a', 0, 0), box('b', 300, 0), box('lonely', 0, 500), link('ab', 'a', 'b'), link('ba', 'b', 'a')];
    const out = apply(els, tidyLayout(els));
    expect(pos(out, 'a').x).toBeLessThan(pos(out, 'b').x);
    expect(pos(out, 'lonely').x).toBeGreaterThan(pos(out, 'b').x);
  });

  it('follows an arrow drawn backwards (head only at the start)', () => {
    const els = [box('a', 0, 0), box('b', 400, 0), link('x', 'a', 'b', { startArrowhead: 'arrow', endArrowhead: null })];
    const out = apply(els, tidyLayout(els));
    expect(pos(out, 'b').x).toBeLessThan(pos(out, 'a').x);
  });

  it('moves bound labels with their shapes and re-routes bound arrows, keeping the bindings', () => {
    const els = [box('c', 0, 0), label('ct', 'c', 50, 30), box('a', 600, 300), label('at', 'a', 650, 330), link('ac', 'a', 'c'), label('acl', 'ac', 0, 0)];
    const updates = tidyLayout(els);
    const out = apply(els, updates);
    const a = pos(out, 'a');
    const c = pos(out, 'c');
    expect(pos(out, 'at').x - a.x).toBe(50);
    expect(pos(out, 'at').y - a.y).toBe(30);
    expect(pos(out, 'ct').x - c.x).toBe(50);
    const arrow = pos(out, 'ac');
    expect(arrow.startBinding).toMatchObject({ elementId: 'a', focus: 0, gap: 8 });
    expect(arrow.endBinding).toMatchObject({ elementId: 'c', focus: 0, gap: 8 });
    const [, end] = arrow.points as number[][];
    // Starts just right of A, ends just left of C.
    expect(arrow.x).toBeCloseTo(a.x + a.width + 8, 5);
    expect(arrow.x + end[0]).toBeCloseTo(c.x - 8, 5);
    // The arrow's label sits on its midpoint.
    const l = pos(out, 'acl');
    expect(l.x + l.width / 2).toBeCloseTo(arrow.x + end[0] / 2, 5);
    // The interpreter still reads the same connection afterwards.
    const g = interpretDiagram(out as never);
    expect(g.connections).toEqual([expect.objectContaining({ inferred: false, directed: true })]);
  });

  it('leaves region boxes in place and does nothing with fewer than two components', () => {
    const els = [box('r', -50, -50, { width: 900, height: 600, customData: { component: 'region' } }), box('a', 500, 0), box('b', 0, 0), link('ab', 'a', 'b')];
    const updates = tidyLayout(els);
    expect(updates.has('r')).toBe(false);
    expect(tidyLayout([box('solo', 0, 0)]).size).toBe(0);
  });
});

describe('geometry and templates', () => {
  it('clips arrow ends to rectangles, ellipses and diamonds', () => {
    const r = { x: 0, y: 0, width: 100, height: 50, type: 'rectangle' };
    expect(edgePoint(r, 1, 0, 0)).toEqual([100, 25]);
    const e = { ...r, type: 'ellipse' };
    expect(edgePoint(e, 0, 1, 0)).toEqual([50, 50]);
    const d = { ...r, type: 'diamond' };
    const [x, y] = edgePoint(d, 1, 1, 0);
    expect(Math.abs(x - 50) / 50 + Math.abs(y - 25) / 25).toBeCloseTo(1, 5); // on the diamond's edge: |dx|/hw + |dy|/hh = 1
    const g = arrowBetween(r, { ...r, x: 300 });
    expect(g.points[1][0]).toBeCloseTo(300 - 100 - 16, 5);
  });

  it('builds every template with labelled, kind-tagged shapes and arrows bound to existing shape ids', () => {
    for (const t of TEMPLATES) {
      const sk = templateSkeletons(t, 100, 200);
      const shapes = sk.filter((s) => s.type !== 'arrow');
      const arrows = sk.filter((s) => s.type === 'arrow');
      expect(shapes).toHaveLength(t.nodes.length);
      expect(arrows).toHaveLength(t.edges.length);
      const shapeIds = new Set(shapes.map((s) => s.id));
      for (const s of shapes) expect(s).toMatchObject({ label: { text: expect.any(String) }, customData: { component: expect.any(String) } });
      for (const a of arrows) {
        expect(shapeIds.has((a.start as { id: string }).id)).toBe(true);
        expect(shapeIds.has((a.end as { id: string }).id)).toBe(true);
      }
      expect(Math.min(...shapes.map((s) => s.x as number))).toBeGreaterThanOrEqual(100);
    }
  });
});
