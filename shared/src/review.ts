import { z } from 'zod';
import { RUBRIC_KEYS, RubricKey } from './problem.js';

export const REVIEW_SCHEMA_VERSION = 'review.v2';

export const SEVERITIES = ['critical', 'major', 'minor', 'nit'] as const;
export const Severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof Severity>;

export const FINDING_KINDS = ['bug', 'missing-requirement', 'missing-edge-case', 'design', 'readability', 'test-gap', 'concurrency', 'atomicity'] as const;

const text = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => z.string().max(max).nullable();

// ───────────── Design assessment (SOLID, design principles, atomicity, patterns) ─────────────

export const SOLID_PRINCIPLES = ['SRP', 'OCP', 'LSP', 'ISP', 'DIP'] as const;
export const SOLID_LABELS: Record<(typeof SOLID_PRINCIPLES)[number], string> = {
  SRP: 'Single responsibility',
  OCP: 'Open/closed',
  LSP: 'Liskov substitution',
  ISP: 'Interface segregation',
  DIP: 'Dependency inversion',
};
export const DESIGN_PRINCIPLES = [
  'dry',
  'kiss',
  'yagni',
  'encapsulation',
  'separation-of-concerns',
  'composition-over-inheritance',
  'law-of-demeter',
  'fail-fast',
  'immutability',
] as const;
export const DESIGN_PRINCIPLE_LABELS: Record<(typeof DESIGN_PRINCIPLES)[number], string> = {
  dry: "Don't repeat yourself",
  kiss: 'Keep it simple',
  yagni: "You aren't gonna need it",
  encapsulation: 'Encapsulation & information hiding',
  'separation-of-concerns': 'Separation of concerns',
  'composition-over-inheritance': 'Composition over inheritance',
  'law-of-demeter': 'Law of Demeter',
  'fail-fast': 'Fail fast / validate at boundaries',
  immutability: 'Immutability where it helps',
};
export const PrincipleVerdict = z.enum(['followed', 'partially-followed', 'violated', 'not-applicable']);
export type PrincipleVerdict = z.infer<typeof PrincipleVerdict>;
export const PATTERN_STATUSES = ['used-appropriately', 'used-but-misapplied', 'unnecessary', 'would-help'] as const;

const EvidenceRef = z.object({
  filePath: z.string().max(400),
  lineStart: z.number().int().nullable(),
  lineEnd: z.number().int().nullable(),
});

export const AiDesignAssessment = z.object({
  /** Exactly one entry per SOLID principle. */
  solid: z
    .array(z.object({ principle: z.enum(SOLID_PRINCIPLES), verdict: PrincipleVerdict, explanation: text(1000), evidence: z.array(EvidenceRef).max(4) }))
    .length(SOLID_PRINCIPLES.length),
  /** Exactly one entry per design principle. */
  principles: z
    .array(z.object({ principle: z.enum(DESIGN_PRINCIPLES), verdict: PrincipleVerdict, explanation: text(1000), evidence: z.array(EvidenceRef).max(4) }))
    .length(DESIGN_PRINCIPLES.length),
  /** All-or-nothing behaviour of multi-step state changes (in-memory "transactions"). */
  atomicity: z.object({
    applicable: z.boolean(),
    verdict: z.enum(['atomic', 'partially-atomic', 'not-atomic', 'not-applicable']),
    summary: text(1200),
    operations: z
      .array(
        z.object({
          operation: text(200),
          atomic: z.enum(['yes', 'partial', 'no', 'unclear']),
          risk: text(800),
          evidence: z.array(EvidenceRef).max(3),
        }),
      )
      .max(10),
  }),
  /** Patterns judged on fit to the stated requirements — never counted. */
  patterns: z
    .array(
      z.object({
        pattern: text(80),
        status: z.enum(PATTERN_STATUSES),
        where: text(300),
        explanation: text(1000),
        evidence: z.array(EvidenceRef).max(3),
      }),
    )
    .max(10),
  overall: text(1200),
});
export type AiDesignAssessment = z.infer<typeof AiDesignAssessment>;

/**
 * The structured review returned by the AI provider. Category totals are NOT trusted:
 * the backend validates each category against the rubric and computes the total itself.
 */
export const AiReview = z.object({
  schemaVersion: z.literal(REVIEW_SCHEMA_VERSION),
  summary: text(1500),
  categories: z
    .array(
      z.object({
        key: RubricKey,
        score: z.number().int(),
        rationale: text(1500),
      }),
    )
    .length(RUBRIC_KEYS.length),
  requirementCoverage: z.array(
    z.object({
      requirementId: z.string().regex(/^FR-\d{1,2}$/),
      status: z.enum(['met', 'partial', 'missing', 'unclear']),
      basis: z.enum(['test-evidence', 'code-inspection', 'not-verifiable']),
      evidence: text(800),
    }),
  ),
  strengths: z.array(text(500)).max(10),
  findings: z
    .array(
      z.object({
        severity: Severity,
        category: RubricKey,
        kind: z.enum(FINDING_KINDS),
        title: text(160),
        explanation: text(1500),
        evidence: nullableText(1200),
        filePath: nullableText(400),
        lineStart: z.number().int().nullable(),
        lineEnd: z.number().int().nullable(),
        suggestion: text(1200),
        requirementId: z.string().regex(/^FR-\d{1,2}$/).nullable(),
        /** Short identifier shared by findings caused by the same underlying issue. */
        rootCause: z.string().max(80).nullable(),
        /** Id of a finding from the previous review that this one continues, if any. */
        previousFindingId: z.string().max(80).nullable(),
      }),
    )
    .max(40),
  priorFindings: z
    .array(
      z.object({
        previousFindingId: z.string().max(80),
        status: z.enum(['resolved', 'remaining', 'unclear']),
        note: text(500),
      }),
    )
    .max(60),
  tradeoffs: z.array(z.object({ title: text(160), discussion: text(1200) })).max(8),
  suggestedTests: z
    .array(z.object({ title: text(160), description: text(800), requirementId: z.string().regex(/^FR-\d{1,2}$/).nullable() }))
    .max(12),
  nextSteps: z.array(text(400)).length(3),
  followUpQuestions: z.array(text(500)).min(1).max(12),
  designAssessment: AiDesignAssessment,
  confidence: z.enum(['low', 'medium', 'high']),
  limitations: z.array(text(500)).max(10),
});
export type AiReview = z.infer<typeof AiReview>;

/** Fast review mode caps findings in the score pass: fewer, sharper findings come back sooner. */
export const FAST_REVIEW_MAX_FINDINGS = 12;

/**
 * Fast review mode, pass 1 ("score"): everything the score depends on. Runs in parallel with the
 * detail pass and is shown as soon as it is validated.
 */
export const AiReviewScore = AiReview.pick({
  summary: true,
  categories: true,
  requirementCoverage: true,
  findings: true,
  priorFindings: true,
  nextSteps: true,
  confidence: true,
  limitations: true,
}).extend({ findings: AiReview.shape.findings.max(FAST_REVIEW_MAX_FINDINGS) });
export type AiReviewScore = z.infer<typeof AiReviewScore>;

/** Fast review mode, pass 2 ("detail"): the design assessment and discussion material. Never scored. */
export const AiReviewDetail = AiReview.pick({
  strengths: true,
  tradeoffs: true,
  suggestedTests: true,
  followUpQuestions: true,
  designAssessment: true,
});
export type AiReviewDetail = z.infer<typeof AiReviewDetail>;

/** State of the detail pass of a fast-mode review (absent on full-mode and older reviews). */
export interface ReviewDetailState {
  status: 'pending' | 'completed' | 'failed';
  error: { code: string; message: string } | null;
  model: string | null;
  durationMs: number | null;
}

/** Evidence references after the backend checked them against the snapshot. */
export interface VerifiedRef {
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  reference: ReferenceVerification;
  referenceNote: string | null;
}
type WithVerified<T> = Omit<T, 'evidence'> & { evidence: VerifiedRef[] };
export interface StoredDesignAssessment {
  solid: WithVerified<AiDesignAssessment['solid'][number]>[];
  principles: WithVerified<AiDesignAssessment['principles'][number]>[];
  atomicity: Omit<AiDesignAssessment['atomicity'], 'operations'> & { operations: WithVerified<AiDesignAssessment['atomicity']['operations'][number]>[] };
  patterns: WithVerified<AiDesignAssessment['patterns'][number]>[];
  overall: string;
}

export type ReferenceVerification = 'verified' | 'relocated' | 'range-only' | 'unverified' | 'none';

export interface StoredFinding {
  id: string;
  idx: number;
  severity: Severity;
  category: RubricKey;
  kind: (typeof FINDING_KINDS)[number];
  title: string;
  explanation: string;
  evidence: string | null;
  filePath: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  suggestion: string;
  requirementId: string | null;
  rootCause: string | null;
  previousFindingId: string | null;
  /** How the backend verified the cited location against the immutable snapshot. */
  reference: ReferenceVerification;
  referenceNote: string | null;
  /** Other categories in which the same root cause was also reported. */
  sharedRootCauseWith: string[];
}

export interface CategoryScore {
  key: RubricKey;
  label: string;
  score: number;
  max: number;
  rationale: string;
}

export interface StoredReview {
  id: string;
  submissionId: string;
  sessionId: string;
  jobId: string;
  status: 'completed';
  isMock: boolean;
  provider: string;
  model: string | null;
  promptVersion: string;
  schemaVersion: string;
  rubricVersion: string;
  problemId: string;
  problemVersion: number;
  createdAt: string;
  durationMs: number | null;
  totalScore: number;
  categories: CategoryScore[];
  summary: string;
  requirementCoverage: AiReview['requirementCoverage'];
  coverageAdjustments: string[];
  strengths: string[];
  findings: StoredFinding[];
  priorFindings: AiReview['priorFindings'];
  tradeoffs: AiReview['tradeoffs'];
  suggestedTests: AiReview['suggestedTests'];
  nextSteps: string[];
  followUpQuestions: string[];
  /** Absent on review.v1 reviews created before the design assessment existed. */
  designAssessment?: StoredDesignAssessment;
  confidence: AiReview['confidence'];
  limitations: string[];
  /** Notes the backend adds about execution evidence, excluded content or settings changes. */
  systemNotes: string[];
  /** 'fast': score and detail came from two parallel passes; absent on older (single-call) reviews. */
  reviewMode?: 'fast' | 'full';
  /** Fast mode only: while 'pending', strengths/trade-offs/tests/questions are empty and designAssessment is absent. */
  detail?: ReviewDetailState;
}

export const HINT_LEVELS = [1, 2, 3, 4] as const;
export const HINT_LEVEL_LABELS: Record<number, string> = {
  1: 'Clarify a requirement',
  2: 'Suggest a direction',
  3: 'Discuss a concept',
  4: 'Small targeted example',
};

export const AiHint = z.object({
  level: z.number().int().min(1).max(4),
  title: text(160),
  content: text(2500),
  /** Only level 4 may include code, and only a short illustrative fragment. */
  codeExample: z.string().max(2000).nullable(),
  followUpQuestion: text(400),
});
export type AiHint = z.infer<typeof AiHint>;

export const AiReference = z.object({
  overview: text(4000),
  keyDecisions: z.array(z.object({ title: text(160), rationale: text(1200) })).min(1).max(10),
  files: z
    .array(
      z.object({
        path: text(300),
        content: z.string().min(1).max(40000),
      }),
    )
    .min(1)
    .max(30),
});
export type AiReference = z.infer<typeof AiReference>;
