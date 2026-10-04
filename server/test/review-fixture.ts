import { DESIGN_PRINCIPLES, RUBRIC_KEYS, REVIEW_SCHEMA_VERSION, SOLID_PRINCIPLES } from '@lld/shared';

/** A schema-valid review as a provider would return it (used by scoring and pipeline tests). */
export function reviewFixture(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: REVIEW_SCHEMA_VERSION,
    summary: 'Solid separation of policies; token bucket refill uses integer arithmetic.',
    categories: RUBRIC_KEYS.map((k) => ({ key: k, score: { correctness: 20, modeling: 15, principles: 12, extensibility: 11, readability: 8, edge_cases: 6, tests: 4 }[k], rationale: `Rationale for ${k}.` })),
    requirementCoverage: [
      { requirementId: 'FR-1', status: 'met', basis: 'test-evidence', evidence: 'fixedWindowResetsAtBoundary passes.' },
      { requirementId: 'FR-2', status: 'partial', basis: 'code-inspection', evidence: 'Refill drops fractions.' },
    ],
    strengths: ['Clock is injectable.'],
    findings: [
      {
        severity: 'major',
        category: 'correctness',
        kind: 'bug',
        title: 'Refill loses fractional tokens',
        explanation: 'Integer division truncates partial refills.',
        evidence: 'tokens = Math.min(capacity, tokens + elapsed * refillTokens / refillPeriodMillis);',
        filePath: 'src/main/java/com/x/TokenBucket.java',
        lineStart: 3,
        lineEnd: 3,
        suggestion: 'Compute the refill in floating point.',
        requirementId: 'FR-2',
        rootCause: 'integer-refill',
        previousFindingId: null,
      },
      {
        severity: 'minor',
        category: 'tests',
        kind: 'test-gap',
        title: 'No test for fractional refill',
        explanation: 'The integer refill bug is not covered.',
        evidence: null,
        filePath: 'src/main/java/com/x/TokenBucket.java',
        lineStart: 1,
        lineEnd: 99,
        suggestion: 'Add a test at 500 ms.',
        requirementId: 'FR-9',
        rootCause: 'integer-refill',
        previousFindingId: 'bogus-id',
      },
    ],
    priorFindings: [],
    tradeoffs: [{ title: 'Per-client locking', discussion: 'Simple and contention-free across clients.' }],
    suggestedTests: [{ title: 'Fractional refill', description: 'Assert tokens after 1.5 periods.', requirementId: 'FR-2' }],
    nextSteps: ['Fix refill', 'Add tests', 'Validate constructor args'],
    followUpQuestions: ['How would you share limits across instances?'],
    designAssessment: {
      solid: SOLID_PRINCIPLES.map((p) => ({
        principle: p,
        verdict: p === 'SRP' ? 'violated' : 'followed',
        explanation: `${p} explanation.`,
        evidence: p === 'SRP' ? [{ filePath: 'src/main/java/com/x/TokenBucket.java', lineStart: 2, lineEnd: 4 }, { filePath: 'Missing.java', lineStart: 1, lineEnd: 1 }] : [],
      })).reverse(),
      principles: DESIGN_PRINCIPLES.map((p) => ({ principle: p, verdict: p === 'fail-fast' ? 'violated' : 'followed', explanation: `${p} explanation.`, evidence: [] })),
      atomicity: {
        applicable: true,
        verdict: 'partially-atomic',
        summary: 'Multi-unit acquire is checked then applied under one lock.',
        operations: [{ operation: 'acquire N permits', atomic: 'yes', risk: 'None observed.', evidence: [{ filePath: 'src/main/java/com/x/TokenBucket.java', lineStart: 3, lineEnd: 3 }] }],
      },
      patterns: [{ pattern: 'Strategy', status: 'used-appropriately', where: 'Policy implementations', explanation: 'Policies vary independently.', evidence: [] }],
      overall: 'Reasonable separation with a refill defect.',
    },
    confidence: 'medium',
    limitations: ['Concurrency assessed by reading code only.'],
    ...over,
  };
}
