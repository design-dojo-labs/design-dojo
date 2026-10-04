import { z } from 'zod';

export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export const TARGETS = ['beginner', 'sde1', 'sde2', 'senior'] as const;
export const TARGET_LABELS: Record<(typeof TARGETS)[number], string> = {
  beginner: 'Beginner',
  sde1: 'SDE-1',
  sde2: 'SDE-2',
  senior: 'Senior',
};
export const DURATIONS = [30, 45, 60, 90] as const;

/**
 * Topic tags describe the problem domain and the kind of behaviour involved.
 * They intentionally avoid naming design patterns so a tag never hints at the
 * intended solution.
 */
export const TOPICS = [
  'resource-allocation',
  'booking',
  'state-transitions',
  'payments-ledger',
  'scheduling',
  'caching',
  'concurrency',
  'notifications',
  'inventory',
  'rules-and-policies',
  'logging',
  'commerce',
  'games',
  'access-control',
] as const;

export const TOPIC_LABELS: Record<(typeof TOPICS)[number], string> = {
  'resource-allocation': 'Resource allocation',
  booking: 'Booking & reservations',
  'state-transitions': 'State transitions',
  'payments-ledger': 'Payments & ledgers',
  scheduling: 'Scheduling',
  caching: 'Caching',
  concurrency: 'Concurrency',
  notifications: 'Notifications & routing',
  inventory: 'Inventory',
  'rules-and-policies': 'Rules & policies',
  logging: 'Logging',
  commerce: 'Commerce',
  games: 'Games',
  'access-control': 'Access control',
};

export const Difficulty = z.enum(DIFFICULTIES);
export const Target = z.enum(TARGETS);
export const Topic = z.enum(TOPICS);
export type Difficulty = z.infer<typeof Difficulty>;
export type Target = z.infer<typeof Target>;
export type Topic = z.infer<typeof Topic>;

const nonEmpty = z.string().trim().min(1);

export const Requirement = z.object({
  /** Stable requirement id, e.g. FR-1. Never renumbered within a problem version. */
  id: z.string().regex(/^FR-\d{1,2}$/, 'requirement ids must look like FR-1'),
  text: nonEmpty.max(600),
  priority: z.enum(['must', 'should']),
});
export type Requirement = z.infer<typeof Requirement>;

export const Example = z.object({
  title: nonEmpty.max(120),
  /** The sequence of calls/actions, in plain language (no class names prescribed). */
  scenario: nonEmpty.max(1200),
  /** Externally observable outcome. */
  expected: nonEmpty.max(1200),
});

export const AcceptanceCriterion = z.object({
  id: z.string().regex(/^AC-\d{1,2}$/, 'acceptance criteria ids must look like AC-1'),
  text: nonEmpty.max(600),
  requirementIds: z.array(z.string().regex(/^FR-\d{1,2}$/)).min(1),
});

export const StretchGoal = z.object({
  id: z.string().regex(/^SG-\d{1,2}$/, 'stretch goal ids must look like SG-1'),
  text: nonEmpty.max(400),
});

/** Category keys of the scoring rubric. */
export const RUBRIC_KEYS = [
  'correctness',
  'modeling',
  'principles',
  'extensibility',
  'readability',
  'edge_cases',
  'tests',
] as const;
export const RubricKey = z.enum(RUBRIC_KEYS);
export type RubricKey = z.infer<typeof RubricKey>;

const guidance = z.string().trim().min(1).max(500);
export const RubricGuidance = z.object({
  correctness: guidance,
  modeling: guidance,
  principles: guidance,
  extensibility: guidance,
  readability: guidance,
  edge_cases: guidance,
  tests: guidance,
});

/** Problem content as authored (seed bank) or generated (AI) — before ids/versions are assigned. */
export const ProblemContent = z.object({
  title: nonEmpty.max(100),
  summary: nonEmpty.max(300),
  difficulty: Difficulty,
  targets: z.array(Target).min(1),
  topics: z.array(Topic).min(1).max(5),
  estimatedMinutes: z.number().int().min(20).max(120),
  /** Markdown problem statement. Must not prescribe classes, interfaces or patterns. */
  statement: nonEmpty.max(4000),
  requirements: z.array(Requirement).min(4).max(14),
  constraints: z.array(nonEmpty.max(400)).min(1).max(12),
  assumptions: z.array(nonEmpty.max(400)).min(1).max(12),
  examples: z.array(Example).min(2).max(6),
  edgeCases: z.array(nonEmpty.max(400)).min(3).max(12),
  outOfScope: z.array(nonEmpty.max(300)).min(2).max(12),
  concurrency: z.object({
    required: z.boolean(),
    notes: z.string().max(800),
  }),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(3).max(16),
  stretchGoals: z.array(StretchGoal).max(6),
  /** Problem-specific notes per rubric category; fixed before the attempt starts. */
  rubricGuidance: RubricGuidance,
});
export type ProblemContent = z.infer<typeof ProblemContent>;

export const SeedProblem = ProblemContent.extend({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
});
export type SeedProblem = z.infer<typeof SeedProblem>;

export const ProblemSource = z.enum(['seed', 'generated']);

export interface ProblemSummary {
  id: string;
  version: number;
  title: string;
  summary: string;
  difficulty: Difficulty;
  targets: Target[];
  topics: Topic[];
  estimatedMinutes: number;
  source: z.infer<typeof ProblemSource>;
  createdAt: string;
  attempts: number;
  bestScore: number | null;
}

export interface ProblemVersion {
  id: string;
  version: number;
  source: z.infer<typeof ProblemSource>;
  contentHash: string;
  createdAt: string;
  content: ProblemContent;
  rubric: Rubric;
  generatedBy: { provider: string; model: string | null; promptVersion: string } | null;
}

export interface RubricCategory {
  key: RubricKey;
  label: string;
  max: number;
  description: string;
  guidance: string;
}

export interface Rubric {
  version: string;
  total: 100;
  categories: RubricCategory[];
}

/** Text that would reveal an intended solution if it appeared in a problem statement. */
export const SOLUTION_REVEALING_TERMS = [
  'strategy pattern',
  'observer pattern',
  'state pattern',
  'factory pattern',
  'factory method',
  'abstract factory',
  'singleton',
  'decorator pattern',
  'builder pattern',
  'command pattern',
  'chain of responsibility',
  'visitor pattern',
  'template method',
  'adapter pattern',
  'composite pattern',
  'proxy pattern',
  'mediator pattern',
];

/**
 * Semantic checks a schema cannot express. Returns human-readable problems; empty means valid.
 */
export function checkProblemSemantics(p: ProblemContent): string[] {
  const issues: string[] = [];
  const reqIds = p.requirements.map((r) => r.id);
  const dupes = reqIds.filter((id, i) => reqIds.indexOf(id) !== i);
  if (dupes.length) issues.push(`duplicate requirement ids: ${[...new Set(dupes)].join(', ')}`);
  const acIds = p.acceptanceCriteria.map((a) => a.id);
  const acDupes = acIds.filter((id, i) => acIds.indexOf(id) !== i);
  if (acDupes.length) issues.push(`duplicate acceptance criteria ids: ${[...new Set(acDupes)].join(', ')}`);
  const sgIds = p.stretchGoals.map((s) => s.id);
  if (new Set(sgIds).size !== sgIds.length) issues.push('duplicate stretch goal ids');
  for (const ac of p.acceptanceCriteria) {
    for (const rid of ac.requirementIds) {
      if (!reqIds.includes(rid)) issues.push(`${ac.id} references unknown requirement ${rid}`);
    }
  }
  const covered = new Set(p.acceptanceCriteria.flatMap((a) => a.requirementIds));
  for (const r of p.requirements) {
    if (r.priority === 'must' && !covered.has(r.id)) issues.push(`must-have requirement ${r.id} has no acceptance criterion`);
  }
  if (p.requirements.filter((r) => r.priority === 'must').length < 4) issues.push('needs at least 4 must-have requirements');
  const sequential = (ids: string[], prefix: string) => ids.every((id, i) => id === `${prefix}-${i + 1}`);
  if (!sequential(reqIds, 'FR')) issues.push('requirement ids must be sequential (FR-1, FR-2, …)');
  if (!sequential(acIds, 'AC')) issues.push('acceptance criteria ids must be sequential (AC-1, AC-2, …)');
  if (!sequential(sgIds, 'SG')) issues.push('stretch goal ids must be sequential (SG-1, SG-2, …)');
  if (p.concurrency.required && !p.concurrency.notes.trim()) issues.push('concurrency is required but no concurrency notes are given');
  if (p.concurrency.required !== p.topics.includes('concurrency')) {
    issues.push('the "concurrency" topic must be present exactly when concurrency.required is true');
  }
  // Everything here is shown to the learner before the attempt (the rubric is published too).
  const publishedText = [
    p.title,
    p.summary,
    p.statement,
    ...p.requirements.map((r) => r.text),
    ...p.acceptanceCriteria.map((a) => a.text),
    ...p.examples.flatMap((e) => [e.title, e.scenario, e.expected]),
    ...p.edgeCases,
    ...p.constraints,
    ...p.assumptions,
    ...p.stretchGoals.map((s) => s.text),
    ...Object.values(p.rubricGuidance),
  ]
    .join('\n')
    .toLowerCase();
  for (const term of SOLUTION_REVEALING_TERMS) {
    if (publishedText.includes(term)) issues.push(`problem text reveals an intended design ("${term}")`);
  }
  const named = publishedText.match(/\b(strategy|observer|visitor|decorator|singleton|factory|builder|mediator|command|state)\s+(pattern|class|classes|interface|object)\b/);
  if (named) issues.push(`problem text prescribes a design element ("${named[0]}")`);
  if (/\bdesign patterns?\b/.test(publishedText)) issues.push('problem text refers to design patterns');
  const reqTexts = new Set(p.requirements.map((r) => normalize(r.text)));
  for (const sg of p.stretchGoals) {
    if (reqTexts.has(normalize(sg.text))) issues.push(`stretch goal ${sg.id} duplicates a scored requirement`);
  }
  for (const oos of p.outOfScope) {
    if (reqTexts.has(normalize(oos))) issues.push(`out-of-scope item contradicts a requirement: "${oos}"`);
  }
  return issues;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Token-set similarity used to reject near-duplicate generated problems. */
export function titleSimilarity(a: string, b: string): number {
  const stop = new Set(['a', 'an', 'the', 'system', 'service', 'design', 'for', 'of', 'and', 'management', 'simple']);
  const tok = (s: string) => new Set(normalize(s).split(' ').filter((t) => t && !stop.has(t)));
  const ta = tok(a);
  const tb = tok(b);
  if (!ta.size || !tb.size) return normalize(a) === normalize(b) ? 1 : 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}
