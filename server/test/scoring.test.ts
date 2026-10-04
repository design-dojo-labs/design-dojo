import { describe, expect, it } from 'vitest';
import { buildRubric, RUBRIC_KEYS } from '@lld/shared';
import { validateAndScore, verifyReference } from '../src/review/scoring.js';
import { JobFailure } from '../src/jobs.js';
import { reviewFixture } from './review-fixture.js';

const rubric = buildRubric(Object.fromEntries(RUBRIC_KEYS.map((k) => [k, 'g'])) as never);
const file = [
  'public class TokenBucket {',
  '  void refill(long elapsed) {',
  '    tokens = Math.min(capacity, tokens + elapsed * refillTokens / refillPeriodMillis);',
  '  }',
  '}',
].join('\n');
const ctx = (over: Partial<Parameters<typeof validateAndScore>[1]> = {}) => ({
  rubric,
  requirementIds: ['FR-1', 'FR-2', 'FR-3'],
  files: new Map([['src/main/java/com/x/TokenBucket.java', file]]),
  testsRan: true,
  previousFindingIds: [],
  reviewIdPrefix: 'abcd1234',
  ...over,
});

describe('validateAndScore', () => {
  it('computes the total from category scores on the backend', () => {
    const r = validateAndScore({ ...reviewFixture(), total: 100, overallScore: 99 }, ctx());
    expect(r.totalScore).toBe(20 + 15 + 12 + 11 + 8 + 6 + 4);
    expect(r.categories.map((c) => c.max)).toEqual([25, 20, 15, 15, 10, 10, 5]);
  });

  it('rejects scores outside the category bounds instead of clamping', () => {
    const bad = reviewFixture();
    (bad.categories as { key: string; score: number }[])[0].score = 26;
    expect(() => validateAndScore(bad, ctx())).toThrow(JobFailure);
    const neg = reviewFixture();
    (neg.categories as { key: string; score: number }[])[6].score = -1;
    expect(() => validateAndScore(neg, ctx())).toThrow(/do not fit the rubric/);
    try {
      validateAndScore(neg, ctx());
    } catch (e) {
      expect((e as JobFailure).details?.join(' ')).toMatch(/outside 0–5/);
    }
  });

  it('rejects missing or duplicated categories', () => {
    const dup = reviewFixture();
    (dup.categories as { key: string }[])[1].key = 'correctness';
    const err = (() => {
      try {
        validateAndScore(dup, ctx());
      } catch (e) {
        return e as JobFailure;
      }
    })();
    expect(err?.code).toBe('validation-failed');
    expect(err?.details?.join(' ')).toMatch(/more than once|missing score/);
  });

  it('rejects malformed output with a schema error', () => {
    expect(() => validateAndScore({ summary: 'x' }, ctx())).toThrow(/review schema/);
    expect(() => validateAndScore('not an object', ctx())).toThrow(JobFailure);
  });

  it('never lets the reviewer claim test evidence when no tests ran', () => {
    const r = validateAndScore(reviewFixture(), ctx({ testsRan: false }));
    expect(r.requirementCoverage.find((c) => c.requirementId === 'FR-1')?.basis).toBe('code-inspection');
    expect(r.coverageAdjustments.join(' ')).toMatch(/no tests ran/);
  });

  it('fills in unassessed requirements and drops unknown ones', () => {
    const r = validateAndScore(reviewFixture(), ctx());
    expect(r.requirementCoverage.map((c) => c.requirementId)).toEqual(['FR-1', 'FR-2', 'FR-3']);
    expect(r.requirementCoverage[2]).toMatchObject({ status: 'unclear', basis: 'not-verifiable' });
  });

  it('verifies references, groups shared root causes and drops invented ids', () => {
    const r = validateAndScore(reviewFixture(), ctx());
    const [major, minor] = r.findings;
    expect(major.reference).toBe('verified');
    expect(major.sharedRootCauseWith).toEqual(['tests']);
    expect(minor.reference).toBe('unverified'); // lines 1–99 in a 5-line file
    expect(minor.lineStart).toBeNull();
    expect(minor.requirementId).toBeNull(); // FR-9 does not exist
    expect(minor.previousFindingId).toBeNull(); // not a real previous finding
    expect(major.id).toBe('abcd1234-F1');
  });
});

describe('design assessment', () => {
  it('orders verdicts canonically and verifies their evidence', () => {
    const r = validateAndScore(reviewFixture(), ctx());
    const da = r.designAssessment!;
    expect(da.solid.map((x) => x.principle)).toEqual(['SRP', 'OCP', 'LSP', 'ISP', 'DIP']);
    expect(da.solid[0].evidence.map((e) => e.reference)).toEqual(['range-only', 'unverified']);
    expect(da.principles).toHaveLength(9);
    expect(da.atomicity.operations[0].evidence[0].reference).toBe('range-only');
  });

  it('rejects an assessment that skips a SOLID principle', () => {
    const bad = reviewFixture();
    const da = bad.designAssessment as { solid: { principle: string }[] };
    da.solid[0].principle = 'OCP'; // duplicate → one principle missing
    expect(() => validateAndScore(bad, ctx())).toThrow(JobFailure);
  });

  it('rejects contradictory atomicity verdicts', () => {
    const bad = reviewFixture();
    (bad.designAssessment as { atomicity: { applicable: boolean } }).atomicity.applicable = false;
    expect(() => validateAndScore(bad, ctx())).toThrow(/do not fit/);
  });
});

describe('verifyReference', () => {
  const files = new Map([['src/A.java', 'line1\nfoo();\nline3\nbar();\n']]);
  it('relocates a quoted excerpt found at different lines', () => {
    expect(verifyReference('src/A.java', 1, 1, 'bar();', files)).toMatchObject({ status: 'relocated', lineStart: 4, lineEnd: 4 });
  });
  it('verifies an excerpt inside the cited range', () => {
    expect(verifyReference('src/A.java', 2, 4, 'bar();', files)).toMatchObject({ status: 'verified', lineStart: 2, lineEnd: 4 });
  });
  it('accepts a valid range without an excerpt as range-only', () => {
    expect(verifyReference('src/A.java', 2, 3, null, files)).toMatchObject({ status: 'range-only', lineStart: 2, lineEnd: 3 });
  });
  it('normalizes a unique path suffix', () => {
    expect(verifyReference('A.java', 2, 2, 'foo();', files)).toMatchObject({ status: 'verified', filePath: 'src/A.java' });
  });
  it('marks unknown files and missing excerpts as unverified, keeping the finding', () => {
    expect(verifyReference('src/Nope.java', 1, 1, null, files).status).toBe('unverified');
    expect(verifyReference('src/A.java', 2, 2, 'doesNotExist();', files).status).toBe('unverified');
  });
  it('strips line-number prefixes copied from the prompt listing', () => {
    expect(verifyReference('src/A.java', 2, 2, '2 | foo();', files).status).toBe('verified');
  });
});

describe('verifyReference with elided quotes', () => {
  const files = new Map([['src/R.java', ['class R {', '  void f() {', '    Policy p = policies.get(id);', '    long now = clock.now();', '    State s = states.get(id);', '  }', '}'].join('\n')]]);
  it('matches "..."-separated segments in order', () => {
    expect(verifyReference('src/R.java', 3, 5, 'Policy p = policies.get(id);\n...\nState s = states.get(id);', files).status).toBe('verified');
  });
  it('flags quotes that are only partly present', () => {
    const r = verifyReference('src/R.java', 3, 5, 'Policy p = policies.get(id);\n...\nfrom another file();', files);
    expect(r.status).toBe('unverified');
    expect(r.note).toMatch(/Only part/);
  });
});
