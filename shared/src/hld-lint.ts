// Instant, local checks for an HLD design document. Pure and generic: they look only at what the
// learner wrote and drew (never at the hidden evaluation guide), so they can run on every keystroke.
import { interpretDiagram } from './diagram.js';
import type { DiagramGraph, HldDocument } from './hld.js';

export const HLD_LINT_STAGES = ['requirements', 'estimates', 'api', 'entities', 'diagram', 'notes'] as const;
export type HldLintStage = (typeof HLD_LINT_STAGES)[number];

export interface HldCheck {
  /** Stable key (per rule and subject) for rendering and de-duplication. */
  id: string;
  severity: 'warn' | 'info';
  stage: HldLintStage;
  message: string;
  /** Diagram component labels the check refers to (lets the UI select them on the canvas). */
  componentLabels?: string[];
}

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const DATA_KINDS = new Set(['database', 'cache', 'object-storage', 'search-index', 'queue']);
const EDGE_KINDS = new Set(['client', 'cdn', 'dns', 'load-balancer', 'api-gateway', 'region', 'external']);
const DATA_WORDS = /\b(db|database|store|storage|cache|redis|memcached|sql|nosql|s3|bucket|blob|table|index|queue|stream|kafka|ledger|warehouse|replica)\b/i;
const CLIENT_WORDS = /\b(client|clients|user|users|browser|mobile|app|web|frontend|caller|consumer)\b/i;
/** Entry/edge components that rarely need their own write-up, recognised by kind or by label. */
const EDGE_LABELS = /\b(client|clients|users?|browser|mobile|frontend|gateway|load ?balancer|lb|dns|cdn)\b/i;
/** Path segments ending in "s" that name a single resource, not a collection. */
const SINGULAR_S = new Set(['stats', 'status', 'analytics', 'settings', 'details', 'health', 'address', 'access', 'progress', 'process', 'metrics', 'news', 'alias']);
/** Words too generic to show that a component is discussed in the write-up. */
const GENERIC_WORDS = new Set([
  'service',
  'services',
  'server',
  'servers',
  'store',
  'database',
  'cache',
  'layer',
  'cluster',
  'system',
  'component',
  'stateless',
  'primary',
  'replica',
  'region',
  'regions',
  'with',
  'from',
  'into',
  'per',
  'and',
  'the',
]);
const MIN_DEEP_DIVE_CHARS = 400;

const has = (s: string) => s.trim().length > 0;
const hasNumber = (s: string) => /\d/.test(s);
const label = (method: string, path: string, i: number) => (path.trim() ? `${method} ${path.trim()}` : `API #${i + 1}`);

/** Checks the document; pass the interpreted graph when you already have it to avoid re-interpreting. */
export function lintHldDocument(doc: HldDocument, graph?: DiagramGraph): HldCheck[] {
  const g = graph ?? interpretDiagram(doc.diagram.elements);
  const out: HldCheck[] = [];
  const add = (c: HldCheck) => out.push(c);

  // ───────────── Requirements ─────────────
  const frs = doc.functional.filter((r) => has(r.text));
  const nfrs = doc.nonFunctional.filter((r) => has(r.text));
  if (!frs.length) add({ id: 'req-fr-empty', severity: 'warn', stage: 'requirements', message: 'No functional requirements yet. List what users must be able to do.' });
  else if (frs.length < 3)
    add({ id: 'req-fr-few', severity: 'info', stage: 'requirements', message: `Only ${frs.length} functional requirement(s). Most designs pin down 3–8 core user journeys.` });
  if (!nfrs.length)
    add({ id: 'req-nfr-empty', severity: 'warn', stage: 'requirements', message: 'No non-functional requirements yet (latency, availability, scale, consistency…).' });
  else {
    if (nfrs.length < 3) add({ id: 'req-nfr-few', severity: 'info', stage: 'requirements', message: `Only ${nfrs.length} non-functional requirement(s).` });
    const missing = (['latency', 'availability', 'scalability'] as const).filter((c) => !nfrs.some((r) => r.category === c));
    if (missing.length) add({ id: 'req-nfr-missing', severity: 'info', stage: 'requirements', message: `No non-functional requirement for ${missing.join(', ')}.` });
    if (!nfrs.some((r) => hasNumber(r.text)))
      add({ id: 'req-nfr-numbers', severity: 'info', stage: 'requirements', message: 'Non-functional requirements have no numbers. Targets like "p99 < 200 ms" or "99.9%" make them testable.' });
  }

  // ───────────── Estimates ─────────────
  const est = doc.estimates;
  if (!has(est)) add({ id: 'est-empty', severity: 'warn', stage: 'estimates', message: 'No estimates yet. Back-of-envelope traffic and storage numbers drive cache, partitioning and capacity decisions.' });
  else if (!hasNumber(est)) add({ id: 'est-no-numbers', severity: 'warn', stage: 'estimates', message: 'The estimates contain no numbers.' });
  else {
    if (!/(\/\s*s\b|per\s+sec|\bqps\b|\brps\b|\btps\b|requests?\s*\/|req\/)/i.test(est))
      add({ id: 'est-no-rate', severity: 'info', stage: 'estimates', message: 'No request rate (per second) estimate, average or peak.' });
    if (!/\b(\d+(\.\d+)?\s*(kb|mb|gb|tb|pb|bytes?|b)\b|storage)/i.test(est))
      add({ id: 'est-no-storage', severity: 'info', stage: 'estimates', message: 'No storage size estimate.' });
  }

  // ───────────── API ─────────────
  const apis = doc.apis.filter((a) => has(a.path) || has(a.description) || has(a.request) || has(a.response));
  if (!apis.length) add({ id: 'api-empty', severity: 'warn', stage: 'api', message: 'No API endpoints yet.' });
  apis.forEach((a, i) => {
    const name = label(a.method, a.path, i);
    if (!has(a.path)) add({ id: `api-no-path-${a.id}`, severity: 'warn', stage: 'api', message: `${name} has no path or name.` });
    if (!has(a.response)) add({ id: `api-no-response-${a.id}`, severity: 'warn', stage: 'api', message: `${name} does not describe its response.` });
    else if (HTTP_METHODS.has(a.method) && !/\b[45]\d\d\b/.test(a.response))
      add({ id: `api-no-errors-${a.id}`, severity: 'info', stage: 'api', message: `${name} lists no error responses (4xx/5xx).` });
    if ((a.method === 'POST' || a.method === 'PUT' || a.method === 'PATCH') && !has(a.request))
      add({ id: `api-no-request-${a.id}`, severity: 'info', stage: 'api', message: `${name} does not describe its request body.` });
    if (a.method === 'GET' && looksLikeCollection(a.path) && !/\b(page|pages|paging|paginat\w*|cursor|limit|offset|next)\b/i.test(`${a.path} ${a.description} ${a.request} ${a.response}`))
      add({ id: `api-no-pagination-${a.id}`, severity: 'info', stage: 'api', message: `${name} looks like a list endpoint but mentions no pagination (cursor/limit).` });
  });

  // ───────────── Data model ─────────────
  const entities = doc.entities.filter((e) => has(e.name) || has(e.fields));
  if (!entities.length) add({ id: 'ent-empty', severity: 'warn', stage: 'entities', message: 'No entities yet.' });
  entities.forEach((e, i) => {
    const name = has(e.name) ? e.name.trim() : `Entity #${i + 1}`;
    if (!has(e.name)) add({ id: `ent-no-name-${e.id}`, severity: 'warn', stage: 'entities', message: `${name} has no name.` });
    if (!has(e.fields)) add({ id: `ent-no-fields-${e.id}`, severity: 'warn', stage: 'entities', message: `${name} has no fields.` });
    else if (!/(\bpk\b|primary|partition|clustering|sort key|\bkey\b|unique|\(id\)|\bid\b\s*[:(])/i.test(e.fields))
      add({ id: `ent-no-key-${e.id}`, severity: 'info', stage: 'entities', message: `${name}: no primary/partition key is marked.` });
  });

  // ───────────── Diagram ─────────────
  const comps = g.components;
  if (!comps.length) add({ id: 'dia-empty', severity: 'warn', stage: 'diagram', message: 'The architecture diagram is empty.' });
  else {
    if (!g.connections.length && comps.length > 1)
      add({ id: 'dia-no-connections', severity: 'warn', stage: 'diagram', message: 'No connections yet. Draw arrows from shape to shape so they attach.' });
    const inferred = g.connections.filter((c) => c.inferred);
    if (inferred.length) {
      const labels = unique(inferred.flatMap((c) => [labelOf(g, c.from), labelOf(g, c.to)]));
      add({
        id: 'dia-inferred',
        severity: 'warn',
        stage: 'diagram',
        message: `${inferred.length} arrow(s) are not attached to their shapes (matched by proximity). Drag the ends onto the shapes.`,
        componentLabels: labels,
      });
    }
    const loose = g.ignored.find((s) => /not connected/.test(s));
    if (loose) add({ id: 'dia-loose', severity: 'warn', stage: 'diagram', message: `${capitalize(loose)}.` });
    const unlabeled = comps.filter((c) => c.label.startsWith('(unlabeled'));
    if (unlabeled.length)
      add({ id: 'dia-unlabeled', severity: 'warn', stage: 'diagram', message: `${unlabeled.length} shape(s) have no label. Double-click a shape to name it.`, componentLabels: unlabeled.map((c) => c.label) });
    if (comps.length > 1 && g.connections.length) {
      const linked = new Set(g.connections.flatMap((c) => [c.from, c.to]));
      const isolated = comps.filter((c) => !linked.has(c.ref) && c.kind !== 'region');
      if (isolated.length)
        add({ id: 'dia-isolated', severity: 'info', stage: 'diagram', message: `Not connected to anything: ${isolated.map((c) => c.label).join(', ')}.`, componentLabels: isolated.map((c) => c.label) });
    }
    if (!comps.some((c) => c.kind === 'client' || CLIENT_WORDS.test(c.label)))
      add({ id: 'dia-no-client', severity: 'info', stage: 'diagram', message: 'No client or entry point is shown. Where do requests come from?' });
    if (!comps.some((c) => (c.kind && DATA_KINDS.has(c.kind)) || DATA_WORDS.test(c.label)))
      add({ id: 'dia-no-store', severity: 'warn', stage: 'diagram', message: 'No data store on the diagram (database, cache, queue, object storage…).' });
    const writeUp = [
      ...doc.functional.map((r) => r.text),
      ...doc.nonFunctional.map((r) => r.text),
      doc.estimates,
      ...doc.apis.flatMap((a) => [a.path, a.description, a.request, a.response]),
      ...doc.entities.flatMap((e) => [e.name, e.fields, e.notes]),
      doc.notes,
    ]
      .join('\n')
      .toLowerCase();
    if (writeUp.replace(/\s+/g, '').length > 200) {
      const unmentioned = comps.filter((c) => !c.label.startsWith('(unlabeled') && !(c.kind && EDGE_KINDS.has(c.kind)) && !EDGE_LABELS.test(c.label) && !mentioned(c.label, writeUp));
      if (unmentioned.length)
        add({
          id: 'dia-unmentioned',
          severity: 'info',
          stage: 'diagram',
          message: `Not mentioned in your API, data model or deep dives: ${unmentioned
            .slice(0, 6)
            .map((c) => c.label)
            .join(', ')}${unmentioned.length > 6 ? '…' : ''}. Say what each one does.`,
          componentLabels: unmentioned.map((c) => c.label),
        });
    }
  }

  // ───────────── Deep dives ─────────────
  const notes = doc.notes.trim();
  if (!notes) add({ id: 'notes-empty', severity: 'warn', stage: 'notes', message: 'No deep dives yet. Pick the 2–3 hardest parts and go deep.' });
  else {
    if (notes.length < MIN_DEEP_DIVE_CHARS)
      add({ id: 'notes-short', severity: 'info', stage: 'notes', message: 'The deep dives are short. Explain how the hard parts work, not just which technology you would use.' });
    if (!/trade[- ]?offs?|alternatives?|instead of|\bversus\b|\bvs\.?\b|\bchose\b|\bchosen\b|\brejected\b/i.test(notes))
      add({ id: 'notes-no-tradeoffs', severity: 'info', stage: 'notes', message: 'No trade-offs discussed: which alternatives you considered and why you chose this one.' });
    if (!/\b(fail\w*|outage|retry|retries|failover|replica\w*|backup\w*|redundan\w*|degrad\w*|down)\b/i.test(notes))
      add({ id: 'notes-no-failures', severity: 'info', stage: 'notes', message: 'Nothing about failure handling (what happens when a component is down).' });
  }

  const order = (c: HldCheck) => HLD_LINT_STAGES.indexOf(c.stage) * 2 + (c.severity === 'warn' ? 0 : 1);
  return out.sort((a, b) => order(a) - order(b));
}

/** Count of checks per stage, for badges on the stage tabs. */
export function countHldChecks(checks: HldCheck[]): Record<HldLintStage, { warn: number; info: number }> {
  const res = Object.fromEntries(HLD_LINT_STAGES.map((s) => [s, { warn: 0, info: 0 }])) as Record<HldLintStage, { warn: number; info: number }>;
  for (const c of checks) res[c.stage][c.severity]++;
  return res;
}

/** A GET path whose last segment is a plural resource rather than an id parameter. */
function looksLikeCollection(path: string): boolean {
  const segs = path
    .split('?')[0]
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  const last = segs[segs.length - 1];
  if (!last || /^[{:<]/.test(last) || /[}>]$/.test(last) || SINGULAR_S.has(last.toLowerCase())) return false;
  return /[a-z]s$/i.test(last);
}

function mentioned(componentLabel: string, writeUp: string): boolean {
  const words = componentLabel
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
  if (!words.length) return true; // nothing distinctive to look for
  return words.some((w) => writeUp.includes(w));
}

function labelOf(g: DiagramGraph, ref: string): string {
  return g.components.find((c) => c.ref === ref)?.label ?? ref;
}

const unique = <T>(xs: T[]) => [...new Set(xs)];
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
