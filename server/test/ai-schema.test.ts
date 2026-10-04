import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiReview, HldAiReview, HldProblemContent, ProblemContent, toAiJsonSchema } from '@lld/shared';

type Node = Record<string, unknown>;
function walk(n: unknown, visit: (n: Node) => void) {
  if (Array.isArray(n)) return n.forEach((x) => walk(x, visit));
  if (!n || typeof n !== 'object') return;
  visit(n as Node);
  Object.values(n as Node).forEach((v) => walk(v, visit));
}

describe('provider-facing JSON schema', () => {
  it.each([
    ['AiReview', AiReview],
    ['HldAiReview', HldAiReview],
    ['ProblemContent', ProblemContent],
    ['HldProblemContent', HldProblemContent],
  ])('%s keeps every required property and states bounds in words', (_name, schema) => {
    const s = toAiJsonSchema(schema);
    walk(s, (n) => {
      if (n.type === 'object' && n.properties) {
        const props = Object.keys(n.properties as Node);
        for (const r of (n.required as string[]) ?? []) expect(props).toContain(r);
        expect(n.additionalProperties).toBe(false);
      }
      for (const k of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum', 'pattern', '$schema']) {
        if (k === 'pattern' && n.type === 'object') continue; // a property *named* pattern is fine
        expect(Object.prototype.hasOwnProperty.call(n, k) && typeof (n as Node)[k] !== 'object').toBe(false);
      }
    });
  });

  it('keeps the design-pattern name property (regression: property names are not keywords)', () => {
    const s = JSON.stringify(toAiJsonSchema(AiReview));
    expect(s).toContain('"pattern":{');
    expect(s).toContain('"description":"Exactly 3 items."');
  });

  it('communicates nonblank strings and one-sided numeric bounds to providers', () => {
    const s = toAiJsonSchema(z.object({ text: z.string().trim().min(1).max(100), count: z.number().min(3), limit: z.number().max(10) }));
    const props = s.properties as Record<string, { description: string }>;
    expect(props.text.description).toContain('must not be blank');
    expect(props.text.description).toContain('At most 100 characters');
    expect(props.count.description).toContain('At least 3.');
    expect(props.limit.description).toContain('At most 10.');
  });
});
