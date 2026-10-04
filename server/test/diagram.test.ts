import { describe, expect, it } from 'vitest';
import { colorName, graphToText, interpretDiagram, matchComponent } from '../src/hld/diagram.js';

const rect = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ id, type: 'rectangle', x, y, width: 160, height: 80, backgroundColor: '#a5d8ff', strokeColor: '#1e1e1e', ...extra });
const text = (id: string, t: string, x: number, y: number, containerId: string | null = null) => ({ id, type: 'text', x, y, width: 80, height: 20, text: t, originalText: t, containerId });

describe('interpretDiagram', () => {
  it('turns bound labels, bindings and arrowheads into a component graph', () => {
    const g = interpretDiagram([
      rect('a', 0, 0, { customData: { component: 'client' } }),
      text('ta', 'Mobile app', 10, 10, 'a'),
      rect('b', 400, 0),
      text('tb', 'API gateway', 410, 10, 'b'),
      { id: 'arr', type: 'arrow', x: 160, y: 40, width: 240, height: 0, points: [[0, 0], [240, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, startArrowhead: null, endArrowhead: 'arrow' },
      text('tl', 'HTTPS', 250, 20, 'arr'),
      text('note', 'Writes are async', 0, 300),
      { id: 'gone', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, isDeleted: true },
      { id: 'fd', type: 'freedraw', x: 0, y: 0, width: 5, height: 5 },
    ]);
    expect(g.components.map((c) => c.label)).toEqual(['Mobile app', 'API gateway']);
    expect(g.components[0]).toMatchObject({ kind: 'client', color: 'light blue' });
    expect(g.connections).toEqual([{ from: 'C1', to: 'C2', label: 'HTTPS', directed: true, inferred: false }]);
    expect(g.notes).toEqual(['Writes are async']);
    expect(g.ignored.join(' ')).toMatch(/freehand/);
    expect(graphToText(g)).toContain('C1 "Mobile app" → C2 "API gateway"  [HTTPS]');
  });

  it('uses free text placed on a shape as its label and infers unattached arrow ends by proximity', () => {
    const g = interpretDiagram([
      rect('db', 0, 200),
      text('t', 'Orders DB', 40, 230),
      rect('svc', 0, 0),
      text('t2', 'Order service', 40, 30),
      { id: 'l', type: 'arrow', x: 80, y: 85, width: 0, height: 110, points: [[0, 0], [0, 110]], startArrowhead: null, endArrowhead: 'arrow' },
      { id: 'loose', type: 'arrow', x: 900, y: 900, width: 10, height: 0, points: [[0, 0], [10, 0]] },
    ]);
    expect(g.components.map((c) => c.label)).toEqual(['Order service', 'Orders DB']);
    expect(g.connections).toEqual([{ from: 'C1', to: 'C2', label: null, directed: true, inferred: true }]);
    expect(g.ignored.join(' ')).toMatch(/1 arrow\/line/);
  });

  it('names colours and matches reviewer component names to labels', () => {
    expect(colorName('#ffc9c9')).toBe('light red');
    expect(colorName('#2f9e44')).toBe('green');
    expect(colorName('transparent')).toBeNull();
    const g = interpretDiagram([rect('x', 0, 0), text('t', 'Redis cache', 0, 0, 'x')]);
    expect(matchComponent('redis cache', g)).toBe('Redis cache');
    expect(matchComponent('C1', g)).toBe('Redis cache');
    expect(matchComponent('Kafka', g)).toBeNull();
  });
});
