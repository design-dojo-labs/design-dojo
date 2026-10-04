import { AiReview, AiReviewDetail, AiReviewScore, DESIGN_PRINCIPLES, RUBRIC_KEYS, SOLID_PRINCIPLES, type CategoryScore, type ReferenceVerification, type Rubric, type StoredDesignAssessment, type StoredFinding, type StoredReview, type VerifiedRef } from '@lld/shared';
import type { z } from 'zod';
import { JobFailure } from '../jobs.js';

export interface ScoringContext {
  rubric: Rubric;
  requirementIds: string[];
  /** Immutable snapshot contents keyed by workspace-relative path. */
  files: Map<string, string>;
  /** True only if the application actually executed tests against this snapshot. */
  testsRan: boolean;
  previousFindingIds: string[];
  reviewIdPrefix: string;
}

export type ScoredReview = Pick<
  StoredReview,
  | 'totalScore'
  | 'categories'
  | 'summary'
  | 'requirementCoverage'
  | 'coverageAdjustments'
  | 'strengths'
  | 'findings'
  | 'priorFindings'
  | 'tradeoffs'
  | 'suggestedTests'
  | 'nextSteps'
  | 'followUpQuestions'
  | 'designAssessment'
  | 'confidence'
  | 'limitations'
>;

/**
 * Validates provider output against the review schema and the fixed rubric, then computes the
 * score on the backend. Out-of-range or missing category scores are rejected outright (never
 * clamped), because silently "repairing" a score would fabricate an assessment.
 */
export function validateAndScore(raw: unknown, ctx: ScoringContext): ScoredReview {
  const r = parseOrFail(AiReview, raw, 'The review returned by the provider does not match the review schema.');
  const errors = [...rubricErrors(r, ctx), ...designAssessmentErrors(r.designAssessment)];
  if (errors.length) throw new JobFailure('validation-failed', 'The review scores do not fit the rubric.', errors);
  return { ...scoreCore(r, ctx), ...verifyDetail(r, ctx) };
}

/** Fast mode, score pass: validates and scores everything except the detail fields. */
export function validateScorePass(raw: unknown, ctx: ScoringContext): Omit<ScoredReview, DetailField> {
  const r = parseOrFail(AiReviewScore, raw, 'The score pass returned by the provider does not match its schema.');
  const errors = rubricErrors(r, ctx);
  if (errors.length) throw new JobFailure('validation-failed', 'The review scores do not fit the rubric.', errors);
  return scoreCore(r, ctx);
}

/** Fast mode, detail pass: validates the design assessment and verifies its evidence references. */
export function validateDetailPass(raw: unknown, ctx: ScoringContext): Pick<ScoredReview, DetailField> {
  const r = parseOrFail(AiReviewDetail, raw, 'The detail pass returned by the provider does not match its schema.');
  const errors = designAssessmentErrors(r.designAssessment);
  if (errors.length) throw new JobFailure('validation-failed', 'The design assessment is incomplete.', errors);
  return verifyDetail(r, ctx);
}

type DetailField = 'designAssessment' | 'strengths' | 'tradeoffs' | 'suggestedTests' | 'followUpQuestions';

function parseOrFail<T>(schema: z.ZodType<T>, raw: unknown, message: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new JobFailure(
      'validation-failed',
      message,
      parsed.error.issues.slice(0, 15).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** Category scores: exactly one per rubric category, integer within [0, max]. */
function rubricErrors(r: Pick<AiReview, 'categories'>, ctx: ScoringContext): string[] {
  const errors: string[] = [];
  const byKey = new Map<string, AiReview['categories'][number]>();
  for (const c of r.categories) {
    if (byKey.has(c.key)) errors.push(`category "${c.key}" appears more than once`);
    byKey.set(c.key, c);
  }
  for (const rc of ctx.rubric.categories) {
    const c = byKey.get(rc.key);
    if (!c) errors.push(`missing score for category "${rc.key}"`);
    else if (!Number.isInteger(c.score) || c.score < 0 || c.score > rc.max) errors.push(`score ${c.score} for "${rc.key}" is outside 0–${rc.max}`);
  }
  return errors;
}

function designAssessmentErrors(da: AiReview['designAssessment']): string[] {
  const errors: string[] = [];
  const missing = (want: readonly string[], got: string[]) => want.filter((w) => !got.includes(w));
  const solidMissing = missing(SOLID_PRINCIPLES, da.solid.map((x) => x.principle));
  if (solidMissing.length) errors.push(`design assessment is missing SOLID verdicts for ${solidMissing.join(', ')}`);
  const princMissing = missing(DESIGN_PRINCIPLES, da.principles.map((x) => x.principle));
  if (princMissing.length) errors.push(`design assessment is missing verdicts for ${princMissing.join(', ')}`);
  if (!da.atomicity.applicable && da.atomicity.verdict !== 'not-applicable') errors.push('atomicity is marked not applicable but has a verdict');
  return errors;
}

/** Scores, coverage and findings (with verified references). Assumes rubricErrors() found nothing. */
function scoreCore(r: AiReviewScore, ctx: ScoringContext): Omit<ScoredReview, DetailField> {
  const categories: CategoryScore[] = ctx.rubric.categories.map((rc) => {
    const c = r.categories.find((x) => x.key === rc.key)!;
    return { key: rc.key, label: rc.label, score: c.score, max: rc.max, rationale: c.rationale };
  });
  const totalScore = categories.reduce((s, c) => s + c.score, 0);

  // ── Requirement coverage: one entry per known requirement; no claimed test evidence without tests ──
  const adjustments: string[] = [];
  const known = new Set(ctx.requirementIds);
  const seen = new Set<string>();
  const coverage: typeof r.requirementCoverage = [];
  for (const c of r.requirementCoverage) {
    if (!known.has(c.requirementId)) {
      adjustments.push(`Ignored coverage for unknown requirement ${c.requirementId}.`);
      continue;
    }
    if (seen.has(c.requirementId)) continue;
    seen.add(c.requirementId);
    if (c.basis === 'test-evidence' && !ctx.testsRan) {
      adjustments.push(`${c.requirementId}: reviewer cited test evidence, but no tests ran for this snapshot — basis changed to code inspection.`);
      coverage.push({ ...c, basis: 'code-inspection' });
    } else coverage.push(c);
  }
  for (const id of ctx.requirementIds) {
    if (!seen.has(id)) {
      coverage.push({ requirementId: id, status: 'unclear', basis: 'not-verifiable', evidence: 'The reviewer did not assess this requirement.' });
      adjustments.push(`${id}: not assessed by the reviewer.`);
    }
  }
  coverage.sort((a, b) => Number(a.requirementId.slice(3)) - Number(b.requirementId.slice(3)));

  // ── Findings: verify cited files/lines against the immutable snapshot ──
  const prev = new Set(ctx.previousFindingIds);
  const findings: StoredFinding[] = r.findings.map((f, idx) => {
    const ref = verifyReference(f.filePath, f.lineStart, f.lineEnd, f.evidence, ctx.files);
    let requirementId = f.requirementId;
    if (requirementId && !known.has(requirementId)) requirementId = null;
    return {
      id: `${ctx.reviewIdPrefix}-F${idx + 1}`,
      idx,
      severity: f.severity,
      category: f.category,
      kind: f.kind,
      title: f.title,
      explanation: f.explanation,
      evidence: f.evidence,
      filePath: ref.filePath,
      lineStart: ref.lineStart,
      lineEnd: ref.lineEnd,
      suggestion: f.suggestion,
      requirementId,
      rootCause: f.rootCause?.trim() || null,
      previousFindingId: f.previousFindingId && prev.has(f.previousFindingId) ? f.previousFindingId : null,
      reference: ref.status,
      referenceNote: ref.note,
      sharedRootCauseWith: [],
    };
  });
  const sevRank = { critical: 0, major: 1, minor: 2, nit: 3 } as const;
  findings.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.idx - b.idx);
  const groups = new Map<string, StoredFinding[]>();
  for (const f of findings) {
    if (!f.rootCause) continue;
    const k = f.rootCause.toLowerCase();
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    for (const f of g) f.sharedRootCauseWith = [...new Set(g.filter((o) => o !== f).map((o) => o.category))];
  }

  return {
    totalScore,
    categories,
    summary: r.summary,
    requirementCoverage: coverage,
    coverageAdjustments: adjustments,
    findings,
    priorFindings: r.priorFindings.filter((p) => prev.has(p.previousFindingId)),
    nextSteps: r.nextSteps,
    confidence: r.confidence,
    limitations: r.limitations,
  };
}

/** Design assessment and discussion fields, with evidence references verified against the snapshot. */
function verifyDetail(r: AiReviewDetail, ctx: ScoringContext): Pick<ScoredReview, DetailField> {
  const known = new Set(ctx.requirementIds);
  const da = r.designAssessment;
  const refs = (ev: { filePath: string; lineStart: number | null; lineEnd: number | null }[]): VerifiedRef[] =>
    ev.map((e) => {
      const v = verifyReference(e.filePath, e.lineStart, e.lineEnd, null, ctx.files);
      return { filePath: v.filePath, lineStart: v.lineStart, lineEnd: v.lineEnd, reference: v.status, referenceNote: v.note };
    });
  const order = <T extends { principle: string }>(list: T[], keys: readonly string[]) => [...list].sort((a, b) => keys.indexOf(a.principle) - keys.indexOf(b.principle));
  const designAssessment: StoredDesignAssessment = {
    solid: order(da.solid, SOLID_PRINCIPLES).map((x) => ({ ...x, evidence: refs(x.evidence) })),
    principles: order(da.principles, DESIGN_PRINCIPLES).map((x) => ({ ...x, evidence: refs(x.evidence) })),
    atomicity: { ...da.atomicity, operations: da.atomicity.operations.map((o) => ({ ...o, evidence: refs(o.evidence) })) },
    patterns: da.patterns.map((x) => ({ ...x, evidence: refs(x.evidence) })),
    overall: da.overall,
  };
  return {
    designAssessment,
    strengths: r.strengths,
    tradeoffs: r.tradeoffs,
    suggestedTests: r.suggestedTests.map((t) => ({ ...t, requirementId: t.requirementId && known.has(t.requirementId) ? t.requirementId : null })),
    followUpQuestions: r.followUpQuestions,
  };
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Checks a cited location. Paths must exist in the snapshot; line ranges must be in bounds; a
 * quoted excerpt is searched near the cited lines and, if found elsewhere, the location is
 * corrected and marked "relocated". Nothing is invented: unverifiable references are kept but
 * marked "unverified" so the UI can say so.
 */
export function verifyReference(
  filePath: string | null,
  lineStart: number | null,
  lineEnd: number | null,
  evidence: string | null,
  files: Map<string, string>,
): { filePath: string | null; lineStart: number | null; lineEnd: number | null; status: ReferenceVerification; note: string | null } {
  if (!filePath) return { filePath: null, lineStart: null, lineEnd: null, status: 'none', note: null };
  let path = filePath.trim().replace(/^\.\//, '').replace(/^\/+/, '');
  let note: string | null = null;
  if (!files.has(path)) {
    const candidates = [...files.keys()].filter((p) => p.endsWith('/' + path) || p === path);
    if (candidates.length === 1) {
      note = `Path normalized from "${filePath}".`;
      path = candidates[0];
    } else {
      return { filePath, lineStart, lineEnd, status: 'unverified', note: `File "${filePath}" is not in the submitted snapshot.` };
    }
  }
  const lines = files.get(path)!.split('\n');
  let start = lineStart;
  let end = lineEnd ?? lineStart;
  if (start != null && end != null && end < start) [start, end] = [end, start];
  const inBounds = start != null && end != null && start >= 1 && end <= lines.length;

  // A quote may elide code with "..." lines; each segment must then appear, in order.
  const segments = splitExcerpt(evidence);
  if (segments.length) {
    const spans = findSpans(lines, segments);
    if (inBounds) {
      // Verified only when the quoted code sits inside the cited range (one line of slack either side).
      if (spans.some(([a, b]) => a >= start! - 1 && b <= end! + 1)) return { filePath: path, lineStart: start, lineEnd: end, status: 'verified', note };
    }
    if (spans.length) {
      const target = start ?? 1;
      const [a, b] = spans.reduce((x, y) => (Math.abs(y[0] - target) < Math.abs(x[0] - target) ? y : x));
      return { filePath: path, lineStart: a, lineEnd: b, status: 'relocated', note: `Quoted code found at lines ${a}–${b}${start != null ? ` (cited ${start}–${end})` : ''}.` };
    }
    const partial = segments.some((seg) => findSpans(lines, [seg]).length > 0);
    const why = partial ? 'Only part of the quoted code appears in this file.' : 'The quoted code does not appear in the submitted file.';
    if (!inBounds) return { filePath: path, lineStart: null, lineEnd: null, status: 'unverified', note: `Cited lines are out of range. ${why}` };
    return { filePath: path, lineStart: start, lineEnd: end, status: 'unverified', note: why };
  }
  if (start == null) return { filePath: path, lineStart: null, lineEnd: null, status: 'range-only', note: note ?? 'No line range given.' };
  if (!inBounds) return { filePath: path, lineStart: null, lineEnd: null, status: 'unverified', note: `Cited lines ${start}–${end} are outside the file (${lines.length} lines).` };
  return { filePath: path, lineStart: start, lineEnd: end, status: 'range-only', note };
}

const ELISION = /^\s*(\/\/\s*)?(\.\.\.|…)\s*$/;

function splitExcerpt(evidence: string | null): string[][] {
  if (!evidence) return [];
  const segments: string[][] = [[]];
  for (const raw of evidence.split('\n')) {
    const line = raw.replace(/^\s*\d+\s*\|\s?/, '');
    if (ELISION.test(line)) {
      if (segments[segments.length - 1].length) segments.push([]);
      continue;
    }
    const n = norm(line);
    if (n) segments[segments.length - 1].push(n);
  }
  return segments.filter((s) => s.length);
}

/** All 1-based [start, end] spans where the segments occur contiguously and in order. */
function findSpans(lines: string[], segments: string[][]): [number, number][] {
  const at = (seg: string[], i: number) => seg.every((e, k) => i + k < lines.length && norm(lines[i + k]).includes(e));
  const spans: [number, number][] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!at(segments[0], i)) continue;
    let pos = i + segments[0].length;
    let ok = true;
    for (const seg of segments.slice(1)) {
      let j = pos;
      while (j < lines.length && !at(seg, j)) j++;
      if (j >= lines.length) {
        ok = false;
        break;
      }
      pos = j + seg.length;
    }
    if (ok) spans.push([i + 1, pos]);
  }
  return spans;
}

export { RUBRIC_KEYS };
