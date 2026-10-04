import { z } from 'zod';

const STRIPPED_KEYWORDS = new Set([
  '$schema',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'pattern',
  'format',
]);

/**
 * Converts a Zod schema into the provider-facing JSON Schema.
 *
 * Providers support different JSON Schema subsets (Codex uses strict structured outputs,
 * Claude Code validates a tool input schema). We therefore send only the portable core —
 * types, enums, required properties and closed objects — and enforce every bound
 * (lengths, counts, score ranges, id formats) with the full Zod schema on the backend.
 */
export function toAiJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: 'draft-7', unrepresentable: 'throw' }) as Record<string, unknown>;
  return strip(raw) as Record<string, unknown>;
}

/** Plain-language form of the bounds we strip, so every provider still sees the limits. */
function boundsText(n: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof n.minItems === 'number' && typeof n.maxItems === 'number') {
    out.push(n.minItems === n.maxItems ? `Exactly ${n.minItems} items.` : `Between ${n.minItems} and ${n.maxItems} items.`);
  } else if (typeof n.maxItems === 'number') out.push(`At most ${n.maxItems} items.`);
  else if (typeof n.minItems === 'number' && n.minItems > 0) out.push(`At least ${n.minItems} items.`);
  if (typeof n.minLength === 'number' && n.minLength > 0) out.push(`At least ${n.minLength} characters; must not be blank.`);
  if (typeof n.maxLength === 'number') out.push(`At most ${n.maxLength} characters.`);
  if (typeof n.minimum === 'number' && typeof n.maximum === 'number' && n.maximum < 1e9) out.push(`Between ${n.minimum} and ${n.maximum}.`);
  else {
    if (typeof n.minimum === 'number') out.push(`At least ${n.minimum}.`);
    if (typeof n.maximum === 'number' && n.maximum < 1e9) out.push(`At most ${n.maximum}.`);
  }
  if (typeof n.pattern === 'string' && n.pattern.length < 40) out.push(`Format: ${n.pattern}`);
  return out;
}

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  const hints = boundsText(node as Record<string, unknown>);
  if (hints.length) {
    const d = (node as Record<string, unknown>).description;
    out.description = [typeof d === 'string' ? d : '', ...hints].filter(Boolean).join(' ');
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'description' && hints.length) continue;
    if (STRIPPED_KEYWORDS.has(k)) continue;
    if (k === 'const') {
      out.enum = [v];
      continue;
    }
    // Keys of `properties` / `$defs` are names, not keywords: a property called "pattern" must survive.
    if ((k === 'properties' || k === '$defs' || k === 'definitions') && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, strip(sub)]));
      continue;
    }
    out[k] = strip(v);
  }
  if (out.type === 'object' && out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

type Frame = { kind: 'obj' | 'arr'; expect: 'key' | 'colon' | 'value' | 'comma' };

/**
 * Best-effort parse of a JSON document that is still streaming. Returns the largest prefix that
 * forms complete values (a string value being written is included as far as it has arrived), with
 * open objects/arrays closed. Returns undefined when nothing usable has arrived yet. Never throws.
 */
export function parsePartialJson(src: string): unknown {
  const stack: Frame[] = [];
  const closers = () =>
    stack
      .map((f) => (f.kind === 'obj' ? '}' : ']'))
      .reverse()
      .join('');
  let cut = -1;
  let cutClose = '';
  let inStr = false;
  let strIsKey = false;
  let esc = false;
  let scalar = false;
  const valueDone = (endExclusive: number) => {
    const top = stack[stack.length - 1];
    if (top) top.expect = 'comma';
    cut = endExclusive;
    cutClose = closers();
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') {
        inStr = false;
        if (strIsKey) stack[stack.length - 1].expect = 'colon';
        else valueDone(i + 1);
      }
      continue;
    }
    if (scalar) {
      if (!/[\s,\]}]/.test(c)) continue;
      scalar = false;
      valueDone(i);
    }
    if (/\s/.test(c)) continue;
    const top = stack[stack.length - 1];
    if (c === '"') {
      inStr = true;
      strIsKey = !!top && top.kind === 'obj' && top.expect === 'key';
    } else if (c === '{' || c === '[') {
      stack.push({ kind: c === '{' ? 'obj' : 'arr', expect: c === '{' ? 'key' : 'value' });
      cut = i + 1;
      cutClose = closers();
    } else if (c === '}' || c === ']') {
      stack.pop();
      valueDone(i + 1);
    } else if (c === ':') {
      if (top) top.expect = 'value';
    } else if (c === ',') {
      if (top) top.expect = top.kind === 'obj' ? 'key' : 'value';
    } else scalar = true;
  }
  const attempt = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  if (inStr && !strIsKey) {
    // A string value is mid-stream: keep what has arrived, minus a dangling escape sequence.
    const body = esc ? src.slice(0, -1) : src.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    const v = attempt(body + '"' + closers());
    if (v !== undefined) return v;
  }
  return cut >= 0 ? attempt(src.slice(0, cut) + cutClose) : undefined;
}
