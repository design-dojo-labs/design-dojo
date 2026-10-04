import { describe, expect, it } from 'vitest';
import { EMPTY_HLD_DOCUMENT, countHldChecks, lintHldDocument, type HldDocument } from '@lld/shared';

const shape = (id: string, label: string, x: number, y: number, kind?: string) => [
  { id, type: 'rectangle', x, y, width: 160, height: 80, backgroundColor: '#a5d8ff', customData: kind ? { component: kind } : undefined },
  { id: `${id}-t`, type: 'text', x: x + 10, y: y + 10, width: 100, height: 20, text: label, originalText: label, containerId: id },
];
const arrow = (id: string, from: string, to: string, bound = true) => ({
  id,
  type: 'arrow',
  x: 0,
  y: 0,
  width: 10,
  height: 0,
  points: [
    [0, 0],
    [10, 0],
  ],
  startBinding: bound ? { elementId: from } : null,
  endBinding: bound ? { elementId: to } : null,
  startArrowhead: null,
  endArrowhead: 'arrow',
});

const ids = (doc: HldDocument) => lintHldDocument(doc).map((c) => c.id);

describe('lintHldDocument', () => {
  it('flags every empty stage of a blank document as a warning', () => {
    const checks = lintHldDocument(EMPTY_HLD_DOCUMENT);
    expect(checks.map((c) => c.id)).toEqual(['req-fr-empty', 'req-nfr-empty', 'est-empty', 'api-empty', 'ent-empty', 'dia-empty', 'notes-empty']);
    expect(checks.every((c) => c.severity === 'warn')).toBe(true);
    expect(countHldChecks(checks).diagram).toEqual({ warn: 1, info: 0 });
  });

  it('checks requirement depth, NFR categories and numbers', () => {
    const doc: HldDocument = {
      ...EMPTY_HLD_DOCUMENT,
      functional: [{ id: 'f1', text: 'Shorten a URL' }],
      nonFunctional: [{ id: 'n1', category: 'durability', text: 'Never lose a mapping' }],
    };
    const got = ids(doc);
    expect(got).toEqual(expect.arrayContaining(['req-fr-few', 'req-nfr-few', 'req-nfr-missing', 'req-nfr-numbers']));
    const missing = lintHldDocument(doc).find((c) => c.id === 'req-nfr-missing')!;
    expect(missing.message).toContain('latency, availability, scalability');
  });

  it('checks estimates for numbers, rates and storage', () => {
    expect(ids({ ...EMPTY_HLD_DOCUMENT, estimates: 'lots of traffic' })).toContain('est-no-numbers');
    const partial = ids({ ...EMPTY_HLD_DOCUMENT, estimates: '100M users, 10 links each' });
    expect(partial).toEqual(expect.arrayContaining(['est-no-rate', 'est-no-storage']));
    const good = ids({ ...EMPTY_HLD_DOCUMENT, estimates: 'Peak 20K req/s. Storage: 6B x 500 B = 3 TB' });
    expect(good.filter((i) => i.startsWith('est-'))).toEqual([]);
  });

  it('checks API rows for responses, error codes, request bodies and pagination', () => {
    const doc: HldDocument = {
      ...EMPTY_HLD_DOCUMENT,
      apis: [
        { id: 'a1', method: 'GET', path: '/api/v1/links', description: 'my links', request: '', response: '200 [...]' },
        { id: 'a2', method: 'POST', path: '/api/v1/links', description: '', request: '', response: '' },
        { id: 'a3', method: 'GET', path: '/api/v1/links/{code}', description: '', request: '', response: '200 {...}\n404 unknown' },
        { id: 'a4', method: 'GET', path: '/api/v1/items', description: '', request: '?cursor=…&limit=50', response: '200 {...} 401' },
        { id: 'a5', method: 'GET', path: '/api/v1/links/{code}/stats', description: '', request: '', response: '200 {...} 404' },
      ],
    };
    const checks = lintHldDocument(doc).filter((c) => c.stage === 'api');
    // Warnings first, then suggestions.
    expect(checks.map((c) => c.id)).toEqual(['api-no-response-a2', 'api-no-errors-a1', 'api-no-pagination-a1', 'api-no-request-a2']);
    expect(checks[2].message).toContain('GET /api/v1/links');
  });

  it('checks entities for fields and keys', () => {
    const doc: HldDocument = {
      ...EMPTY_HLD_DOCUMENT,
      entities: [
        { id: 'e1', name: 'Link', storage: 'key-value', fields: 'short_code: string (PK)\nlong_url', notes: '' },
        { id: 'e2', name: 'Click', storage: 'sql', fields: 'code\nat', notes: '' },
        { id: 'e3', name: 'Empty', storage: 'sql', fields: '', notes: '' },
      ],
    };
    expect(lintHldDocument(doc).filter((c) => c.stage === 'entities').map((c) => c.id)).toEqual(['ent-no-fields-e3', 'ent-no-key-e2']);
  });

  it('reads the diagram: unattached arrows, unlabelled and isolated shapes, missing client or store', () => {
    const elements = [
      ...shape('svc', 'Link service', 0, 0, 'service'),
      ...shape('worker', 'Expiry job', 400, 0, 'worker'),
      { id: 'blank', type: 'rectangle', x: 0, y: 400, width: 160, height: 80 },
      { ...arrow('loose', 'svc', 'worker', false), x: 165, y: 40, width: 230, points: [[0, 0], [230, 0]] },
    ];
    const checks = lintHldDocument({ ...EMPTY_HLD_DOCUMENT, diagram: { elements } });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId['dia-inferred'].componentLabels).toEqual(['Link service', 'Expiry job']);
    expect(byId['dia-unlabeled'].message).toMatch(/1 shape/);
    expect(byId['dia-isolated'].componentLabels).toEqual(['(unlabeled rectangle 1)']);
    expect(byId['dia-no-client']).toBeTruthy();
    expect(byId['dia-no-store'].severity).toBe('warn');
  });

  it('notices components the write-up never mentions, ignoring edge components', () => {
    const elements = [
      ...shape('c', 'Browser', 0, 0, 'client'),
      ...shape('svc', 'Link service', 300, 0, 'service'),
      ...shape('db', 'Link store', 600, 0, 'database'),
      ...shape('geo', 'Geo enricher', 900, 0, 'worker'),
      ...shape('gw', 'API gateway', 300, 300),
      arrow('a1', 'c', 'svc'),
      arrow('a2', 'svc', 'db'),
      arrow('a3', 'svc', 'geo'),
      arrow('a4', 'c', 'gw'),
    ];
    const doc: HldDocument = {
      ...EMPTY_HLD_DOCUMENT,
      diagram: { elements },
      notes: 'The link service writes every link to the store with a conditional insert so codes never collide. '.repeat(4),
    };
    const unmentioned = lintHldDocument(doc).find((c) => c.id === 'dia-unmentioned');
    expect(unmentioned?.componentLabels).toEqual(['Geo enricher']);
  });

  it('asks deep dives for depth, trade-offs and failure handling', () => {
    expect(ids({ ...EMPTY_HLD_DOCUMENT, notes: 'Use a cache.' })).toEqual(expect.arrayContaining(['notes-short', 'notes-no-tradeoffs', 'notes-no-failures']));
    const deep = `${'Detail. '.repeat(60)} We chose 302 over 301 as a trade-off. If the cache fails we read from replicas.`;
    expect(ids({ ...EMPTY_HLD_DOCUMENT, notes: deep }).filter((i) => i.startsWith('notes-'))).toEqual([]);
  });
});
