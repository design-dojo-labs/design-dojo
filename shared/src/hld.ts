import { z } from 'zod';
import { ProblemTheme } from './generation.js';
import { Difficulty, Target } from './problem.js';
import type { ReviewDetailState } from './review.js';

// ───────────────────────────── HLD problems ─────────────────────────────

export const HLD_DOMAINS = [
  'social',
  'messaging',
  'media-streaming',
  'commerce',
  'payments',
  'maps-location',
  'search',
  'storage',
  'infrastructure',
  'analytics',
  'collaboration',
  'gaming',
] as const;
export const HldDomain = z.enum(HLD_DOMAINS);
export const HLD_DOMAIN_LABELS: Record<(typeof HLD_DOMAINS)[number], string> = {
  social: 'Social & feeds',
  messaging: 'Messaging & notifications',
  'media-streaming': 'Media & streaming',
  commerce: 'Commerce & marketplaces',
  payments: 'Payments & ledgers',
  'maps-location': 'Maps & location',
  search: 'Search & discovery',
  storage: 'Storage & files',
  infrastructure: 'Infrastructure & platform',
  analytics: 'Analytics & metrics',
  collaboration: 'Collaboration',
  gaming: 'Gaming & real-time',
};

const t = (max: number) => z.string().trim().min(1).max(max);

/**
 * An HLD (system design) problem. The statement describes the product and scale, never the
 * architecture. The evaluation guide is for the reviewer and is revealed only after submission.
 */
export const HldProblemContent = z.object({
  title: t(100),
  summary: t(400),
  difficulty: Difficulty,
  targets: z
    .array(Target)
    .min(1)
    .refine((t) => new Set(t).size === t.length, 'targets must not repeat'),
  domain: HldDomain,
  estimatedMinutes: z.number().int().min(30).max(120),
  statement: t(4500),
  scaleHints: z.array(t(300)).min(2).max(10),
  constraints: z.array(t(300)).min(1).max(10),
  outOfScope: z.array(t(300)).min(1).max(10),
  evaluationGuide: z.object({
    keyFunctionalRequirements: z.array(t(300)).min(3).max(12),
    keyNonFunctionalRequirements: z.array(t(300)).min(3).max(12),
    coreEntities: z.array(t(200)).min(2).max(12),
    keyComponents: z.array(t(200)).min(3).max(15),
    deepDiveTopics: z.array(t(500)).min(2).max(12),
    commonPitfalls: z.array(t(500)).min(2).max(12),
  }),
});
export type HldProblemContent = z.infer<typeof HldProblemContent>;
export const HldSeedProblem = HldProblemContent.extend({ id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/) });

/** Terms that would prescribe an architecture if they appeared in the learner-facing statement. */
const PRESCRIPTIVE = /\b(use|using|with|via|built on)\s+(a\s+|an\s+)?(redis|kafka|cassandra|dynamodb|memcached|rabbitmq|elasticsearch|load balancer|cdn|message queue|sharding|consistent hashing|microservices?)\b/i;

/** Named products never belong in the learner-facing text (they are solutions, not requirements). */
const TECHNOLOGIES = /\b(redis|kafka|cassandra|dynamodb|memcached|rabbitmq|elasticsearch|zookeeper|postgres(ql)?|mysql|mongodb|s3 bucket|bigtable|spanner|kinesis|pub\/sub)\b/i;

export function checkHldProblemSemantics(p: HldProblemContent): string[] {
  const issues: string[] = [];
  const published = [p.title, p.summary, p.statement, ...p.scaleHints, ...p.constraints, ...p.outOfScope].join('\n');
  const m = published.match(PRESCRIPTIVE) ?? published.match(TECHNOLOGIES);
  if (m) issues.push(`the learner-facing text prescribes part of the architecture ("${m[0]}")`);
  const [lo, hi] = { easy: [30, 60], medium: [40, 90], hard: [50, 120] }[p.difficulty];
  if (p.estimatedMinutes < lo || p.estimatedMinutes > hi) issues.push(`${p.estimatedMinutes} minutes does not fit a ${p.difficulty} problem (${lo}–${hi})`);
  if (!/\d/.test(p.scaleHints.join(' '))) issues.push('scale hints should include at least one number (users, requests, data size…)');
  return issues;
}

export interface HldProblemSummary {
  id: string;
  version: number;
  title: string;
  summary: string;
  difficulty: z.infer<typeof Difficulty>;
  targets: z.infer<typeof Target>[];
  domain: z.infer<typeof HldDomain>;
  estimatedMinutes: number;
  source: 'seed' | 'generated';
  createdAt: string;
  attempts: number;
  bestScore: number | null;
}

/** Problem as shown before/during an attempt: the evaluation guide is withheld. */
export interface HldProblemPublic {
  id: string;
  version: number;
  source: 'seed' | 'generated';
  createdAt: string;
  content: Omit<HldProblemContent, 'evaluationGuide'>;
  rubric: HldRubric;
  generatedBy: { provider: string; model: string | null; promptVersion: string } | null;
  /** Present only once the session has at least one submission. */
  evaluationGuide: HldProblemContent['evaluationGuide'] | null;
}

// ───────────────────────────── HLD rubric ─────────────────────────────

export const HLD_RUBRIC_KEYS = ['requirements', 'api', 'data_model', 'architecture', 'scalability', 'tradeoffs'] as const;
export const HldRubricKey = z.enum(HLD_RUBRIC_KEYS);
export type HldRubricKey = z.infer<typeof HldRubricKey>;
export const HLD_RUBRIC_VERSION = 'hld-rubric.v1';

export interface HldRubric {
  version: string;
  total: 100;
  categories: { key: HldRubricKey; label: string; max: number; description: string }[];
}

export const HLD_RUBRIC: HldRubric = {
  version: HLD_RUBRIC_VERSION,
  total: 100,
  categories: [
    {
      key: 'requirements',
      label: 'Requirements & scope',
      max: 15,
      description: 'Functional and non-functional requirements are explicit, prioritised and testable; scope and assumptions are stated; estimates are used where they drive decisions.',
    },
    {
      key: 'api',
      label: 'API design',
      max: 15,
      description: 'Endpoints or messages cover the core use cases with sensible resources, methods, payloads, pagination, idempotency and error semantics.',
    },
    {
      key: 'data_model',
      label: 'Data model & storage',
      max: 15,
      description: 'Entities, relationships and access patterns are clear; storage choices, keys, indexes and partitioning fit the reads and writes.',
    },
    {
      key: 'architecture',
      label: 'High-level architecture',
      max: 25,
      description: 'Components and data flow serve the requirements end to end; responsibilities are clear; the diagram is readable and consistent with the API and data model.',
    },
    {
      key: 'scalability',
      label: 'Scalability, reliability & performance',
      max: 20,
      description: 'The design meets the stated scale and NFRs: caching, replication, partitioning, async processing, consistency choices, failure handling, no unaddressed single points of failure.',
    },
    {
      key: 'tradeoffs',
      label: 'Trade-offs & communication',
      max: 10,
      description: 'Key decisions are justified with alternatives considered; bottlenecks and risks are acknowledged; deep dives go beyond naming technologies.',
    },
  ],
};

// ───────────────────────────── HLD workspace document ─────────────────────────────

export const NFR_CATEGORIES = ['scalability', 'availability', 'latency', 'consistency', 'durability', 'security', 'cost', 'other'] as const;
export const API_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'WS', 'RPC', 'EVENT'] as const;
export const STORAGE_KINDS = ['sql', 'nosql-document', 'wide-column', 'key-value', 'cache', 'search-index', 'blob', 'queue-stream', 'graph', 'time-series', 'other'] as const;
export const STORAGE_LABELS: Record<(typeof STORAGE_KINDS)[number], string> = {
  sql: 'Relational (SQL)',
  'nosql-document': 'Document store',
  'wide-column': 'Wide-column',
  'key-value': 'Key-value',
  cache: 'Cache',
  'search-index': 'Search index',
  blob: 'Object/blob storage',
  'queue-stream': 'Queue / stream',
  graph: 'Graph',
  'time-series': 'Time-series',
  other: 'Other',
};

const rowId = z.string().min(1).max(40);
export const HldDocument = z.object({
  functional: z.array(z.object({ id: rowId, text: z.string().max(1000) })).max(40),
  nonFunctional: z.array(z.object({ id: rowId, category: z.enum(NFR_CATEGORIES), text: z.string().max(1000) })).max(40),
  estimates: z.string().max(10000),
  apis: z
    .array(
      z.object({
        id: rowId,
        method: z.enum(API_METHODS),
        path: z.string().max(300),
        description: z.string().max(1000),
        request: z.string().max(3000),
        response: z.string().max(3000),
      }),
    )
    .max(40),
  entities: z
    .array(z.object({ id: rowId, name: z.string().max(120), storage: z.enum(STORAGE_KINDS), fields: z.string().max(4000), notes: z.string().max(2000) }))
    .max(40),
  /** Excalidraw scene elements (kept opaque; interpreted server-side into a component graph). */
  diagram: z.object({
    elements: z.array(z.record(z.string(), z.unknown())).max(4000),
    background: z.string().max(40).optional(),
  }),
  notes: z.string().max(20000),
});
export type HldDocument = z.infer<typeof HldDocument>;

export const EMPTY_HLD_DOCUMENT: HldDocument = {
  functional: [],
  nonFunctional: [],
  estimates: '',
  apis: [],
  entities: [],
  diagram: { elements: [] },
  notes: '',
};

export const SaveHldDocRequest = z.object({ doc: HldDocument, baseHash: z.string().max(128), force: z.boolean().optional() });

/** Component graph derived from the diagram — what the reviewer (and the learner) see as the design. */
export interface DiagramGraph {
  components: { ref: string; label: string; shape: string; kind: string | null; color: string | null }[];
  connections: { from: string; to: string; label: string | null; directed: boolean; inferred: boolean }[];
  notes: string[];
  ignored: string[];
}

export interface HldSessionSummary {
  id: string;
  problemId: string;
  problemVersion: number;
  problemTitle: string;
  difficulty: string;
  mode: 'practice' | 'interview';
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  submissionCount: number;
  latestScore: number | null;
  bestScore: number | null;
  timer: { accumulatedMs: number; runningSince: string | null; durationMinutes: number | null; autoPaused?: boolean };
}

export interface HldSession extends HldSessionSummary {
  problem: HldProblemPublic;
  doc: HldDocument;
  docHash: string;
}

// ───────────────────────────── HLD review ─────────────────────────────

export const HLD_REVIEW_SCHEMA_VERSION = 'hld-review.v1';
const sectionFeedback = z.object({ feedback: t(1500), issues: z.array(t(500)).max(10) });

export const HldAiReview = z.object({
  schemaVersion: z.literal(HLD_REVIEW_SCHEMA_VERSION),
  summary: t(1500),
  /** The reviewer's reading of the diagram, so misinterpretations are visible to the learner. */
  diagramInterpretation: t(2000),
  categories: z.array(z.object({ key: HldRubricKey, score: z.number().int(), rationale: t(1500) })).length(HLD_RUBRIC_KEYS.length),
  sections: z.object({
    requirements: sectionFeedback.extend({ missingFunctional: z.array(t(300)).max(10), missingNonFunctional: z.array(t(300)).max(10) }),
    api: sectionFeedback,
    dataModel: sectionFeedback,
    architecture: sectionFeedback.extend({
      missingComponents: z.array(t(300)).max(10),
      singlePointsOfFailure: z.array(t(300)).max(10),
      bottlenecks: z.array(t(300)).max(10),
    }),
    scalability: sectionFeedback,
    tradeoffs: sectionFeedback,
  }),
  strengths: z.array(t(500)).max(10),
  improvements: z
    .array(
      z.object({
        priority: z.enum(['high', 'medium', 'low']),
        area: HldRubricKey,
        title: t(160),
        explanation: t(1500),
        suggestion: t(1500),
        /** Diagram component labels this improvement refers to (verified against the diagram). */
        components: z.array(t(120)).max(6),
      }),
    )
    .max(25),
  nextSteps: z.array(t(400)).length(3),
  followUpQuestions: z.array(t(500)).min(1).max(12),
  confidence: z.enum(['low', 'medium', 'high']),
  limitations: z.array(t(600)).max(12),
});
export type HldAiReview = z.infer<typeof HldAiReview>;

/** Fast review mode, pass 1: scores, the diagram reading and prioritised improvements. */
export const HldAiReviewScore = HldAiReview.pick({
  summary: true,
  diagramInterpretation: true,
  categories: true,
  improvements: true,
  nextSteps: true,
  confidence: true,
  limitations: true,
}).extend({ improvements: HldAiReview.shape.improvements.max(10) });
export type HldAiReviewScore = z.infer<typeof HldAiReviewScore>;

/** Fast review mode, pass 2: per-section feedback, strengths and follow-up questions. Never scored. */
export const HldAiReviewDetail = HldAiReview.pick({ sections: true, strengths: true, followUpQuestions: true });
export type HldAiReviewDetail = z.infer<typeof HldAiReviewDetail>;

/** Placeholder sections while a fast-mode review's detail pass is still running. */
export const EMPTY_HLD_SECTIONS: HldAiReview['sections'] = {
  requirements: { feedback: '', issues: [], missingFunctional: [], missingNonFunctional: [] },
  api: { feedback: '', issues: [] },
  dataModel: { feedback: '', issues: [] },
  architecture: { feedback: '', issues: [], missingComponents: [], singlePointsOfFailure: [], bottlenecks: [] },
  scalability: { feedback: '', issues: [] },
  tradeoffs: { feedback: '', issues: [] },
};

export interface StoredHldReview extends Omit<HldAiReview, 'categories' | 'improvements'> {
  id: string;
  submissionId: string;
  sessionId: string;
  isMock: boolean;
  provider: string;
  model: string | null;
  promptVersion: string;
  rubricVersion: string;
  createdAt: string;
  durationMs: number | null;
  totalScore: number;
  categories: { key: HldRubricKey; label: string; score: number; max: number; rationale: string }[];
  improvements: (HldAiReview['improvements'][number] & { componentRefs: { label: string; matched: string | null }[] })[];
  systemNotes: string[];
  /** 'fast': score and detail came from two parallel passes; absent on older (single-call) reviews. */
  reviewMode?: 'fast' | 'full';
  /** Fast mode only: while 'pending', sections are empty placeholders and strengths/questions are empty. */
  detail?: ReviewDetailState;
}

export interface HldSubmission {
  id: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  contentHash: string;
  reviewStatus: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'not-requested';
  reviewJobId: string | null;
  score: number | null;
  provider: string | null;
  model: string | null;
  isMock: boolean;
  elapsedMs: number;
  graph: DiagramGraph;
  review: StoredHldReview | null;
  reviewError: { code: string; message: string; details?: string[] } | null;
}

export const CreateHldSessionRequest = z.object({
  problemId: z.string().min(1).max(100),
  problemVersion: z.number().int().positive().optional(),
  mode: z.enum(['practice', 'interview']),
  durationMinutes: z.number().int().min(5).max(240).nullable(),
});

export const GenerateHldProblemRequest = z.object({
  difficulty: Difficulty,
  target: Target,
  domain: HldDomain.optional(),
  theme: ProblemTheme,
});
export type GenerateHldProblemRequest = z.infer<typeof GenerateHldProblemRequest>;

export const RandomHldProblemRequest = z.object({
  difficulty: Difficulty.optional(),
  target: Target.optional(),
  domain: HldDomain.optional(),
});
