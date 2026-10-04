import { DEFAULT_RUBRIC_CATEGORIES, DESIGN_PRINCIPLE_LABELS, SOLID_LABELS, type Stats, type StoredReview } from '@lld/shared';
import { type DB, json } from './db.js';

/** Progress statistics computed from real (non-mock) reviews only. */
export function computeStats(db: DB): Stats {
  const rows = db
    .prepare(
      `SELECT r.review_json, r.created_at, r.total_score, r.provider, r.model, s.session_id, s.id AS submission_id, s.problem_id, s.seq,
              json_extract(pv.content_json, '$.title') AS title
       FROM reviews r
       JOIN submissions s ON s.id = r.submission_id
       JOIN problem_versions pv ON pv.problem_id = s.problem_id AND pv.version = s.problem_version
       WHERE r.is_mock = 0
       ORDER BY r.created_at ASC`,
    )
    .all() as {
    review_json: string;
    created_at: string;
    total_score: number;
    provider: string;
    model: string | null;
    session_id: string;
    submission_id: string;
    problem_id: string;
    seq: number;
    title: string;
  }[];
  const mockCount = (db.prepare('SELECT COUNT(*) AS n FROM reviews WHERE is_mock = 1').get() as { n: number }).n;
  const sessions = (db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
  const hintsUsed = (db.prepare('SELECT COUNT(*) AS n FROM hints WHERE is_mock = 0').get() as { n: number }).n;

  // Latest review per session represents where each attempt ended up.
  const latestBySession = new Map<string, (typeof rows)[number]>();
  for (const r of rows) latestBySession.set(r.session_id, r);
  const latest = [...latestBySession.values()];
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

  const catTotals = new Map<string, { sum: number; n: number }>();
  for (const r of latest) {
    const review = json<StoredReview | null>(r.review_json, null);
    for (const c of review?.categories ?? []) {
      const t = catTotals.get(c.key) ?? { sum: 0, n: 0 };
      t.sum += c.max ? c.score / c.max : 0;
      t.n++;
      catTotals.set(c.key, t);
    }
  }
  const categories = DEFAULT_RUBRIC_CATEGORIES.filter((c) => catTotals.has(c.key)).map((c) => {
    const t = catTotals.get(c.key)!;
    return { key: c.key, label: c.label, averagePct: Math.round((t.sum / t.n) * 1000) / 10, samples: t.n };
  });
  const sorted = [...categories].sort((a, b) => b.averagePct - a.averagePct);

  const spots = new Map<string, Stats['designWeakSpots'][number]>();
  const tally = (area: Stats['designWeakSpots'][number]['area'], item: string, verdict: string) => {
    if (verdict === 'not-applicable') return;
    const k = `${area}:${item}`;
    const t = spots.get(k) ?? { area, item, violated: 0, partial: 0, samples: 0 };
    t.samples++;
    if (verdict === 'violated' || verdict === 'not-atomic') t.violated++;
    if (verdict === 'partially-followed' || verdict === 'partially-atomic') t.partial++;
    spots.set(k, t);
  };
  for (const r of latest) {
    const da = json<StoredReview | null>(r.review_json, null)?.designAssessment;
    if (!da) continue;
    for (const x of da.solid) tally('SOLID', SOLID_LABELS[x.principle], x.verdict);
    for (const x of da.principles) tally('Principle', DESIGN_PRINCIPLE_LABELS[x.principle], x.verdict);
    if (da.atomicity.applicable) tally('Atomicity', 'Atomic multi-step operations', da.atomicity.verdict);
  }
  const designWeakSpots = [...spots.values()]
    .filter((s) => s.violated + s.partial > 0)
    .sort((a, b) => b.violated + b.partial / 2 - (a.violated + a.partial / 2))
    .slice(0, 5);

  return {
    completedProblems: new Set(rows.map((r) => r.problem_id)).size,
    sessions,
    reviewedSubmissions: new Set(rows.map((r) => r.submission_id)).size,
    averageScore: avg(latest.map((r) => r.total_score)),
    recentAverage: avg(rows.slice(-5).map((r) => r.total_score)),
    history: rows.slice(-100).map((r) => ({
      at: r.created_at,
      score: r.total_score,
      sessionId: r.session_id,
      submissionId: r.submission_id,
      problemTitle: r.title,
      provider: r.provider,
      model: r.model,
    })),
    categories,
    strongest: sorted.length >= 2 ? sorted[0] : null,
    weakest: sorted.length >= 2 ? sorted[sorted.length - 1] : null,
    hintsUsed,
    excludedMockReviews: mockCount,
    designWeakSpots,
  };
}
