import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  EMPTY_HLD_DOCUMENT,
  EMPTY_HLD_SECTIONS,
  HldAiReviewDetail,
  HldAiReviewScore,
  parsePartialJson,
  HLD_REVIEW_SCHEMA_VERSION,
  HLD_RUBRIC,
  HldAiReview,
  HldProblemContent,
  HldSeedProblem,
  STORAGE_LABELS,
  TARGET_LABELS,
  HLD_DOMAIN_LABELS,
  checkHldProblemSemantics,
  titleSimilarity,
  type Difficulty,
  type GenerateHldProblemRequest,
  type DiagramGraph,
  type HldDocument,
  type HldProblemPublic,
  type HldProblemSummary,
  type HldRubric,
  type HldSession,
  type HldSessionSummary,
  type HldSubmission,
  type Job,
  type ProviderId,
  type StoredHldReview,
  type Target,
} from '@lld/shared';
import { type DB, json, now } from '../db.js';
import type { EventBus } from '../events.js';
import { HttpError } from '../fs/paths.js';
import { sha256 } from '../fs/workspace.js';
import { JobFailure, type JobContext, type JobManager } from '../jobs.js';
import { generationNovelty, generationTheme, type Prompts } from '../prompts.js';
import type { Providers } from '../providers/index.js';
import type { SettingsStore } from '../settings.js';
import { HEARTBEAT_STALE_MS, elapsedMs } from '../sessions.js';
import { graphToText, interpretDiagram, matchComponent } from './diagram.js';

export const HLD_PROMPTS = { review: 'hld-review.v1', reviewScore: 'hld-review.v2-score', reviewDetail: 'hld-review.v2-detail', generate: 'hld-generate.v3' } as const;

type Timer = HldSessionSummary['timer'];

interface VersionRow {
  problem_id: string;
  version: number;
  content_json: string;
  rubric_json: string;
  generated_by_json: string | null;
  created_at: string;
  source: 'seed' | 'generated';
}
interface SessionRow {
  id: string;
  problem_id: string;
  problem_version: number;
  mode: 'practice' | 'interview';
  status: 'active' | 'archived';
  doc_json: string;
  doc_hash: string;
  timer_json: string;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}
interface SubmissionRow {
  id: string;
  session_id: string;
  seq: number;
  content_hash: string;
  doc_json: string;
  graph_json: string;
  rubric_json: string;
  elapsed_ms: number;
  created_at: string;
}

/** Canonical JSON so that the same document always hashes the same way. */
function docHash(doc: HldDocument): string {
  return sha256(JSON.stringify(doc));
}

/** HLD (system design) practice: problems, sessions, immutable submissions and AI reviews. */
export class HldService {
  constructor(
    private db: DB,
    private bus: EventBus,
    private jobs: JobManager,
    private providers: Providers,
    private prompts: Prompts,
    private settings?: SettingsStore,
  ) {}

  // ───────────────────────── problems ─────────────────────────

  syncSeeds(dir: string): string[] {
    const errors: string[] = [];
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    for (const f of files) {
      const parsed = HldSeedProblem.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      if (!parsed.success) {
        errors.push(`${f}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
        continue;
      }
      const { id, ...content } = parsed.data;
      const issues = checkHldProblemSemantics(content);
      if (issues.length) {
        errors.push(`${f}: ${issues.join('; ')}`);
        continue;
      }
      const hash = sha256(`${HLD_RUBRIC.version}\n${JSON.stringify(content)}`);
      const existing = this.db.prepare('SELECT latest_version FROM hld_problems WHERE id = ?').get(id) as { latest_version: number } | undefined;
      if (!existing) this.insertProblem(id, 'seed', 1, content, null, hash);
      else {
        const cur = this.db.prepare('SELECT content_hash FROM hld_problem_versions WHERE problem_id = ? AND version = ?').get(id, existing.latest_version) as { content_hash: string };
        if (cur.content_hash !== hash) this.insertProblem(id, 'seed', existing.latest_version + 1, content, null, hash);
      }
    }
    return errors;
  }

  private insertProblem(id: string, source: 'seed' | 'generated', version: number, content: HldProblemContent, generatedBy: HldProblemPublic['generatedBy'], hash: string) {
    const ts = now();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO hld_problems (id, source, latest_version, title, created_at) VALUES (?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET latest_version = excluded.latest_version, title = excluded.title`,
        )
        .run(id, source, version, content.title, ts);
      this.db
        .prepare(`INSERT INTO hld_problem_versions (problem_id, version, content_json, rubric_json, content_hash, generated_by_json, created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(id, version, JSON.stringify(content), JSON.stringify(HLD_RUBRIC), hash, generatedBy ? JSON.stringify(generatedBy) : null, ts);
    })();
  }

  private versionRow(id: string, version?: number): VersionRow {
    const row = this.db
      .prepare(
        `SELECT v.*, p.source FROM hld_problem_versions v JOIN hld_problems p ON p.id = v.problem_id
         WHERE v.problem_id = ? AND v.version = COALESCE(?, p.latest_version)`,
      )
      .get(id, version ?? null) as VersionRow | undefined;
    if (!row) throw new HttpError(404, `HLD problem ${id} not found`);
    return row;
  }

  getFull(id: string, version?: number): { content: HldProblemContent; rubric: HldRubric; row: VersionRow } {
    const row = this.versionRow(id, version);
    return { content: json<HldProblemContent>(row.content_json, {} as HldProblemContent), rubric: json<HldRubric>(row.rubric_json, HLD_RUBRIC), row };
  }

  /** The learner-facing problem. The evaluation guide is withheld until something was submitted. */
  getPublic(id: string, version?: number, revealGuide = false): HldProblemPublic {
    const { content, rubric, row } = this.getFull(id, version);
    const { evaluationGuide, ...rest } = content;
    return {
      id: row.problem_id,
      version: row.version,
      source: row.source,
      createdAt: row.created_at,
      content: rest,
      rubric,
      generatedBy: json(row.generated_by_json, null),
      evaluationGuide: revealGuide ? evaluationGuide : null,
    };
  }

  listProblems(filter: { difficulty?: Difficulty; target?: Target; domain?: string } = {}): HldProblemSummary[] {
    const rows = this.db
      .prepare(
        `SELECT v.*, p.source,
           (SELECT COUNT(*) FROM hld_sessions s WHERE s.problem_id = p.id) AS attempts,
           (SELECT MAX(r.total_score) FROM hld_reviews r JOIN hld_submissions sb ON sb.id = r.submission_id JOIN hld_sessions s2 ON s2.id = sb.session_id
              WHERE s2.problem_id = p.id AND r.is_mock = 0) AS best
         FROM hld_problems p JOIN hld_problem_versions v ON v.problem_id = p.id AND v.version = p.latest_version
         WHERE p.archived = 0 ORDER BY p.source DESC, p.title`,
      )
      .all() as (VersionRow & { attempts: number; best: number | null })[];
    return rows
      .map((r) => {
        const c = json<HldProblemContent>(r.content_json, {} as HldProblemContent);
        return {
          id: r.problem_id,
          version: r.version,
          title: c.title,
          summary: c.summary,
          difficulty: c.difficulty,
          targets: c.targets,
          domain: c.domain,
          estimatedMinutes: c.estimatedMinutes,
          source: r.source,
          createdAt: r.created_at,
          attempts: r.attempts,
          bestScore: r.best,
        };
      })
      .filter((p) => (!filter.difficulty || p.difficulty === filter.difficulty) && (!filter.target || p.targets.includes(filter.target)) && (!filter.domain || p.domain === filter.domain));
  }

  random(filter: { difficulty?: Difficulty; target?: Target; domain?: string }): HldProblemSummary {
    const all = this.listProblems(filter);
    if (!all.length) throw new HttpError(404, 'No HLD problems match these filters. Generate one with AI or widen the filters.');
    const fresh = all.filter((p) => p.attempts === 0);
    const pool = fresh.length ? fresh : all;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  generate(req: GenerateHldProblemRequest): Job {
    const provider = this.providers.selected();
    const { job, existing } = this.jobs.create({ kind: 'hld-generate', provider, dedupeKey: 'hld-generate', params: req });
    if (existing) return job;
    void this.jobs.run(job.id, async (ctx) => {
      const titles = (this.db.prepare('SELECT title FROM hld_problems').all() as { title: string }[]).map((r) => r.title);
      const prompt = this.prompts.render(HLD_PROMPTS.generate, {
        difficulty: req.difficulty,
        target: req.target,
        targetLabel: TARGET_LABELS[req.target],
        domain: req.domain ? `${req.domain} (${HLD_DOMAIN_LABELS[req.domain as keyof typeof HLD_DOMAIN_LABELS]})` : 'any domain — pick one that suits the level',
        domainRule: req.domain ? `; \`domain\` must be "${req.domain}"` : '',
        theme: generationTheme(req.theme),
        noveltyRule: generationNovelty(req.theme),
        existingTitles: titles.map((t) => `- ${t}`).join('\n') || '- (none)',
      });
      ctx.progress(`Asking ${provider} for a new ${req.difficulty} system design question for ${TARGET_LABELS[req.target]}…`);
      const quality = (p: HldProblemContent) => {
        const issues = checkHldProblemSemantics(p);
        if (p.difficulty !== req.difficulty) issues.push(`difficulty is "${p.difficulty}" but "${req.difficulty}" was requested`);
        if (!p.targets.includes(req.target)) issues.push(`targets do not include ${req.target}`);
        if (req.domain && p.domain !== req.domain) issues.push(`domain is "${p.domain}" but "${req.domain}" was requested`);
        return issues;
      };
      const { data: c, result: res } = await this.providers.runValidated(provider, 'hld-generate', prompt, HldProblemContent, ctx, { mockContext: req, check: quality });
      const issues: string[] = [];
      const dupe = !req.theme?.trim() && titles.find((t) => titleSimilarity(t, c.title) >= 0.6);
      if (dupe) issues.push(`"${c.title}" is too similar to the existing problem "${dupe}"`);
      if (issues.length) throw new JobFailure('validation-failed', 'The generated question failed quality checks, so it was not saved. Try again.', issues);
      const slug = c.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'hld';
      const id = `gen-${slug}-${randomBytes(2).toString('hex')}`;
      this.insertProblem(id, 'generated', 1, c, { provider: res.provider, model: res.model, promptVersion: HLD_PROMPTS.generate }, sha256(`${HLD_RUBRIC.version}\n${JSON.stringify(c)}`));
      return { problemId: id, version: 1, title: c.title, isMock: res.provider === 'mock' };
    });
    return job;
  }

  // ───────────────────────── sessions ─────────────────────────

  createSession(input: { problemId: string; problemVersion?: number; mode: 'practice' | 'interview'; durationMinutes: number | null }): HldSession {
    const p = this.getPublic(input.problemId, input.problemVersion);
    if (input.mode === 'interview' && input.durationMinutes == null) throw new HttpError(400, 'Interview mode needs a time limit.');
    const id = randomUUID();
    const ts = now();
    const doc = EMPTY_HLD_DOCUMENT;
    const timer: Timer = { accumulatedMs: 0, runningSince: ts, durationMinutes: input.durationMinutes };
    this.db
      .prepare(
        `INSERT INTO hld_sessions (id, problem_id, problem_version, mode, status, doc_json, doc_hash, timer_json, last_seen_at, created_at, updated_at) VALUES (?,?,?,?, 'active', ?,?,?,?,?,?)`,
      )
      .run(id, p.id, p.version, input.mode, JSON.stringify(doc), docHash(doc), JSON.stringify(timer), ts, ts, ts);
    return this.getSession(id);
  }

  private sessionRow(id: string): SessionRow {
    const r = this.db.prepare('SELECT * FROM hld_sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!r) throw new HttpError(404, 'HLD session not found');
    return r;
  }

  private summarize(r: SessionRow): HldSessionSummary {
    const { content } = this.getFull(r.problem_id, r.problem_version);
    const stats = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
          (SELECT rv.total_score FROM hld_reviews rv JOIN hld_submissions s2 ON s2.id = rv.submission_id WHERE s2.session_id = ? ORDER BY rv.created_at DESC LIMIT 1) AS latest,
          (SELECT MAX(rv.total_score) FROM hld_reviews rv JOIN hld_submissions s3 ON s3.id = rv.submission_id WHERE s3.session_id = ?) AS best
         FROM hld_submissions WHERE session_id = ?`,
      )
      .get(r.id, r.id, r.id) as { n: number; latest: number | null; best: number | null };
    return {
      id: r.id,
      problemId: r.problem_id,
      problemVersion: r.problem_version,
      problemTitle: content.title,
      difficulty: content.difficulty,
      mode: r.mode,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      submissionCount: stats.n,
      latestScore: stats.latest,
      bestScore: stats.best,
      timer: json<Timer>(r.timer_json, { accumulatedMs: 0, runningSince: null, durationMinutes: null }),
    };
  }

  getSession(id: string): HldSession {
    const r = this.sessionRow(id);
    const summary = this.summarize(r);
    return {
      ...summary,
      problem: this.getPublic(r.problem_id, r.problem_version, summary.submissionCount > 0),
      doc: json<HldDocument>(r.doc_json, EMPTY_HLD_DOCUMENT),
      docHash: r.doc_hash,
    };
  }

  listSessions(): HldSessionSummary[] {
    return (this.db.prepare(`SELECT * FROM hld_sessions WHERE status = 'active' ORDER BY updated_at DESC LIMIT 100`).all() as SessionRow[]).map((r) => this.summarize(r));
  }

  /** Saves the whole document if the client's base hash is still current (stale autosaves get 409). */
  saveDoc(id: string, doc: HldDocument, baseHash: string, force = false): { hash: string } {
    const r = this.sessionRow(id);
    if (!force && r.doc_hash !== baseHash) {
      throw new HttpError(409, 'This design changed elsewhere (another tab?) since you loaded it.', { conflict: true, currentHash: r.doc_hash, currentDoc: json(r.doc_json, null) });
    }
    const hash = docHash(doc);
    this.db.prepare('UPDATE hld_sessions SET doc_json = ?, doc_hash = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(doc), hash, now(), id);
    return { hash };
  }

  timer(id: string, action: 'pause' | 'resume'): HldSession {
    const r = this.sessionRow(id);
    if (r.mode === 'interview') throw new HttpError(403, 'The timer cannot be paused in interview mode.');
    const t = json<Timer>(r.timer_json, { accumulatedMs: 0, runningSince: null, durationMinutes: null });
    if (action === 'pause' && t.runningSince) {
      t.accumulatedMs = elapsedMs(t);
      t.runningSince = null;
    } else if (action === 'resume' && !t.runningSince) {
      t.runningSince = now();
      delete t.autoPaused;
    }
    this.db.prepare('UPDATE hld_sessions SET timer_json = ?, last_seen_at = ? WHERE id = ?').run(JSON.stringify(t), now(), id);
    return this.getSession(id);
  }

  heartbeat(id: string): Timer {
    const r = this.sessionRow(id);
    const t = json<Timer>(r.timer_json, { accumulatedMs: 0, runningSince: null, durationMinutes: null });
    if (!t.runningSince && t.autoPaused) {
      t.runningSince = now();
      delete t.autoPaused;
    }
    this.db.prepare('UPDATE hld_sessions SET timer_json = ?, last_seen_at = ? WHERE id = ?').run(JSON.stringify(t), now(), id);
    return t;
  }

  pauseStaleTimers(staleMs = HEARTBEAT_STALE_MS): void {
    for (const r of this.db.prepare(`SELECT * FROM hld_sessions WHERE status = 'active'`).all() as SessionRow[]) {
      const t = json<Timer>(r.timer_json, { accumulatedMs: 0, runningSince: null, durationMinutes: null });
      if (!t.runningSince) continue;
      const last = r.last_seen_at ? Date.parse(r.last_seen_at) : Date.parse(t.runningSince);
      if (Date.now() - last < staleMs) continue;
      t.accumulatedMs = elapsedMs(t, Math.max(last, Date.parse(t.runningSince)));
      t.runningSince = null;
      t.autoPaused = true;
      this.db.prepare('UPDATE hld_sessions SET timer_json = ? WHERE id = ?').run(JSON.stringify(t), r.id);
    }
  }

  // ───────────────────────── submissions & reviews ─────────────────────────

  submit(sessionId: string): { submission: HldSubmission; job: Job | null; duplicate: boolean } {
    const r = this.sessionRow(sessionId);
    if (r.status !== 'active') throw new HttpError(409, 'This session is archived.');
    const doc = json<HldDocument>(r.doc_json, EMPTY_HLD_DOCUMENT);
    const latest = this.db.prepare('SELECT * FROM hld_submissions WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId) as SubmissionRow | undefined;
    if (latest && latest.content_hash === r.doc_hash) {
      const active = this.jobs.list({ kind: 'hld-review' }).find((j) => j.submissionId === latest.id && (j.state === 'queued' || j.state === 'running')) ?? null;
      return { submission: this.getSubmission(latest.id), job: active, duplicate: true };
    }
    const graph = interpretDiagram(doc.diagram.elements);
    const id = randomUUID();
    const seq = ((this.db.prepare('SELECT MAX(seq) AS m FROM hld_submissions WHERE session_id = ?').get(sessionId) as { m: number | null }).m ?? 0) + 1;
    const { rubric } = this.getFull(r.problem_id, r.problem_version);
    this.db
      .prepare(`INSERT INTO hld_submissions (id, session_id, seq, content_hash, doc_json, graph_json, rubric_json, elapsed_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, sessionId, seq, r.doc_hash, r.doc_json, JSON.stringify(graph), JSON.stringify(rubric), elapsedMs(json<Timer>(r.timer_json, { accumulatedMs: 0, runningSince: null, durationMinutes: null })), now());
    this.db.prepare('UPDATE hld_sessions SET updated_at = ? WHERE id = ?').run(now(), sessionId);
    const job = this.startReview(id);
    return { submission: this.getSubmission(id), job, duplicate: false };
  }

  startReview(submissionId: string): Job {
    const sub = this.subRow(submissionId);
    let provider: ProviderId | null = null;
    try {
      provider = this.providers.selected();
    } catch {
      provider = null;
    }
    const { job, existing } = this.jobs.create({ kind: 'hld-review', provider, sessionId: sub.session_id, submissionId, dedupeKey: `hld-review:${submissionId}` });
    if (!existing) {
      void this.jobs
        .run(job.id, async (ctx) => {
          if (!provider) throw new JobFailure('provider-disabled', 'No AI provider is selected. Choose Claude Code or Codex in Settings, then retry the review.');
          return this.review(sub, provider, ctx);
        })
        .then(() => this.bus.publish({ type: 'hld-submission', sessionId: sub.session_id, submissionId }));
    }
    this.bus.publish({ type: 'hld-submission', sessionId: sub.session_id, submissionId });
    return job;
  }

  /** Prompt variables and context shared by every HLD review pass. */
  private reviewInputs(sub: SubmissionRow) {
    const session = this.sessionRow(sub.session_id);
    const { content } = this.getFull(session.problem_id, session.problem_version);
    const rubric = json<HldRubric>(sub.rubric_json, HLD_RUBRIC);
    const doc = json<HldDocument>(sub.doc_json, EMPTY_HLD_DOCUMENT);
    const graph = json<DiagramGraph>(sub.graph_json, { components: [], connections: [], notes: [], ignored: [] });
    const g = content.evaluationGuide;
    const empty = '(left empty)';
    const vars: Record<string, string> = {
      rubricVersion: rubric.version,
      rubric: rubric.categories.map((c) => `- ${c.key} (max ${c.max}) — ${c.label}. ${c.description}`).join('\n'),
      problemTitle: content.title,
      difficulty: content.difficulty,
      targets: content.targets.map((t) => TARGET_LABELS[t]).join(', '),
      problem: [
        content.statement,
        '',
        'Scale:',
        ...content.scaleHints.map((s) => `- ${s}`),
        'Constraints:',
        ...content.constraints.map((s) => `- ${s}`),
        'Out of scope:',
        ...content.outOfScope.map((s) => `- ${s}`),
      ].join('\n'),
      guide: [
        'Key functional requirements:',
        ...g.keyFunctionalRequirements.map((s) => `- ${s}`),
        'Key non-functional requirements:',
        ...g.keyNonFunctionalRequirements.map((s) => `- ${s}`),
        'Core entities:',
        ...g.coreEntities.map((s) => `- ${s}`),
        'Key components (roles):',
        ...g.keyComponents.map((s) => `- ${s}`),
        'Deep-dive topics:',
        ...g.deepDiveTopics.map((s) => `- ${s}`),
        'Common pitfalls:',
        ...g.commonPitfalls.map((s) => `- ${s}`),
      ].join('\n'),
      practiceContext: `Mode: ${session.mode}. Time spent: ${Math.round(sub.elapsed_ms / 60000)} min of ${content.estimatedMinutes} suggested.`,
      submissionId: sub.id,
      contentHash: sub.content_hash,
      functional: doc.functional.filter((f) => f.text.trim()).map((f, i) => `${i + 1}. ${f.text.trim()}`).join('\n') || empty,
      nonFunctional: doc.nonFunctional.filter((f) => f.text.trim()).map((f, i) => `${i + 1}. [${f.category}] ${f.text.trim()}`).join('\n') || empty,
      estimates: doc.estimates.trim() || empty,
      apis: doc.apis.filter((a) => a.path.trim() || a.description.trim()).map((a) => `${a.method} ${a.path}\n  Purpose: ${a.description || '-'}\n  Request: ${a.request || '-'}\n  Response: ${a.response || '-'}`).join('\n\n') || empty,
      entities: doc.entities.filter((e) => e.name.trim()).map((e) => `${e.name} [${STORAGE_LABELS[e.storage]}]\n  Fields:\n${e.fields.split('\n').map((l) => `    ${l}`).join('\n')}${e.notes ? `\n  Notes: ${e.notes}` : ''}`).join('\n\n') || empty,
      diagram: graphToText(graph),
      notes: doc.notes.trim() || empty,
    };
    return { rubric, doc, graph, vars };
  }

  private rubricIssues(rubric: HldRubric) {
    return (rv: Pick<HldAiReview, 'categories'>) => {
      const out: string[] = [];
      for (const rc of rubric.categories) {
        const hits = rv.categories.filter((x) => x.key === rc.key);
        if (hits.length !== 1) out.push(`categories: "${rc.key}" must appear exactly once`);
        else if (hits[0].score < 0 || hits[0].score > rc.max) out.push(`categories: score ${hits[0].score} for "${rc.key}" is outside 0–${rc.max}`);
      }
      return out;
    };
  }

  private scoredCategories(rubric: HldRubric, r: Pick<HldAiReview, 'categories'>): StoredHldReview['categories'] {
    const errors: string[] = [];
    const categories: StoredHldReview['categories'] = [];
    const seen = new Set<string>();
    for (const c of r.categories) {
      if (seen.has(c.key)) errors.push(`category "${c.key}" appears more than once`);
      seen.add(c.key);
    }
    for (const rc of rubric.categories) {
      const c = r.categories.find((x) => x.key === rc.key);
      if (!c) {
        errors.push(`missing score for "${rc.key}"`);
        continue;
      }
      if (c.score < 0 || c.score > rc.max) errors.push(`score ${c.score} for "${rc.key}" is outside 0–${rc.max}`);
      categories.push({ key: rc.key, label: rc.label, score: c.score, max: rc.max, rationale: c.rationale });
    }
    if (errors.length) throw new JobFailure('validation-failed', 'The review scores do not fit the HLD rubric.', errors);
    return categories;
  }

  private reviewNotes(doc: HldDocument, graph: DiagramGraph, provider: ProviderId): string[] {
    const systemNotes: string[] = [];
    const emptySections = [
      [!doc.functional.some((f) => f.text.trim()), 'functional requirements'],
      [!doc.nonFunctional.some((f) => f.text.trim()), 'non-functional requirements'],
      [!doc.apis.some((a) => a.path.trim()), 'API'],
      [!doc.entities.some((e) => e.name.trim()), 'entities'],
      [!graph.components.length, 'diagram'],
    ]
      .filter(([e]) => e)
      .map(([, n]) => n as string);
    if (emptySections.length) systemNotes.push(`Submitted with empty sections: ${emptySections.join(', ')}.`);
    if (graph.connections.some((c) => c.inferred)) systemNotes.push('Some arrows were not attached to shapes; their endpoints were matched by proximity.');
    if (provider === 'mock') systemNotes.push('MOCK PROVIDER: this review is canned test output and says nothing about your design.');
    return systemNotes;
  }

  private partialPublisher(sub: SubmissionRow, ctx: JobContext, phase: string) {
    return (text: string) => {
      const data = parsePartialJson(text);
      if (data && typeof data === 'object') this.bus.publish({ type: 'job-partial', jobId: ctx.jobId, sessionId: sub.session_id, submissionId: sub.id, phase, data });
    };
  }

  private async review(sub: SubmissionRow, provider: ProviderId, ctx: JobContext): Promise<unknown> {
    const inputs = this.reviewInputs(sub);
    const mode = this.settings?.get().review.mode ?? 'fast';
    ctx.progress(
      `Sending design #${sub.seq} (${inputs.graph.components.length} components, ${inputs.graph.connections.length} connections) to ${provider} for review (${mode === 'fast' ? 'fast: score and detail in parallel' : 'full: one combined pass'})…`,
    );
    return mode === 'fast' ? this.reviewFast(sub, provider, ctx, inputs) : this.reviewFull(sub, provider, ctx, inputs);
  }

  private envelope(sub: SubmissionRow, provider: ProviderId, model: string | null, promptVersion: string, rubric: HldRubric) {
    return {
      id: randomUUID(),
      submissionId: sub.id,
      sessionId: sub.session_id,
      isMock: provider === 'mock',
      provider,
      model,
      promptVersion,
      rubricVersion: rubric.version,
      createdAt: now(),
    };
  }

  private improvementsWithRefs(improvements: HldAiReview['improvements'], graph: DiagramGraph): StoredHldReview['improvements'] {
    return [...improvements]
      .sort((a, b) => ['high', 'medium', 'low'].indexOf(a.priority) - ['high', 'medium', 'low'].indexOf(b.priority))
      .map((i) => ({ ...i, componentRefs: i.components.map((c) => ({ label: c, matched: matchComponent(c, graph) })) }));
  }

  private insertReview(stored: StoredHldReview, ctx: JobContext, raw: Record<string, unknown>): void {
    this.db
      .prepare(`INSERT INTO hld_reviews (id, submission_id, job_id, provider, model, is_mock, total_score, review_json, raw_output_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(stored.id, stored.submissionId, ctx.jobId, stored.provider, stored.model, stored.isMock ? 1 : 0, stored.totalScore, JSON.stringify(stored), JSON.stringify(raw), stored.createdAt);
    this.db.prepare('UPDATE hld_sessions SET updated_at = ? WHERE id = ?').run(now(), stored.sessionId);
  }

  /** Full mode: one combined call (hld-review.v1), the original behaviour. */
  private async reviewFull(sub: SubmissionRow, provider: ProviderId, ctx: JobContext, inputs: ReturnType<HldService['reviewInputs']>): Promise<unknown> {
    const { rubric, doc, graph, vars } = inputs;
    const prompt = this.prompts.render(HLD_PROMPTS.review, vars);
    const { data: r, result: res } = await this.providers.runValidated(provider, 'hld-review', prompt, HldAiReview, ctx, {
      mockContext: { graph },
      check: this.rubricIssues(rubric),
      onPartial: this.partialPublisher(sub, ctx, 'full'),
    });
    ctx.progress('Validating review and computing the score…');
    const categories = this.scoredCategories(rubric, r);
    const stored: StoredHldReview = {
      ...r,
      ...this.envelope(sub, provider, res.model, HLD_PROMPTS.review, rubric),
      durationMs: res.durationMs,
      totalScore: categories.reduce((s, c) => s + c.score, 0),
      categories,
      improvements: this.improvementsWithRefs(r.improvements, graph),
      systemNotes: this.reviewNotes(doc, graph, provider),
      reviewMode: 'full',
    };
    this.insertReview(stored, ctx, { output: res.output, usage: res.usage });
    return { reviewId: stored.id, score: stored.totalScore };
  }

  /**
   * Fast mode: the score pass (scores, diagram reading, improvements) and the detail pass (section
   * feedback, strengths, questions) run in parallel; the review is stored as soon as the score pass
   * is validated and the detail is merged in later. A failed detail pass never changes the score.
   */
  private async reviewFast(sub: SubmissionRow, provider: ProviderId, ctx: JobContext, inputs: ReturnType<HldService['reviewInputs']>): Promise<unknown> {
    const { rubric, doc, graph, vars } = inputs;
    const detailAbort = new AbortController();
    const onJobAbort = () => detailAbort.abort();
    ctx.signal.addEventListener('abort', onJobAbort);
    const detailCtx: JobContext = { ...ctx, signal: detailAbort.signal, progress: (m) => ctx.progress(`Detail: ${m}`), setPid: () => {} };
    const scoreCtx: JobContext = { ...ctx, progress: (m) => ctx.progress(`Score: ${m}`) };
    const detailRun = this.runDetailPass(sub, provider, detailCtx, inputs).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    let stored: StoredHldReview;
    try {
      const prompt = this.prompts.render(HLD_PROMPTS.reviewScore, vars);
      const { data: r, result: res } = await this.providers.runValidated(provider, 'hld-review-score', prompt, HldAiReviewScore, scoreCtx, {
        mockContext: { graph },
        check: this.rubricIssues(rubric),
        onPartial: this.partialPublisher(sub, ctx, 'score'),
      });
      scoreCtx.progress('validated; computing the score…');
      const categories = this.scoredCategories(rubric, r);
      stored = {
        schemaVersion: HLD_REVIEW_SCHEMA_VERSION,
        ...r,
        ...this.envelope(sub, provider, res.model, HLD_PROMPTS.reviewScore, rubric),
        durationMs: res.durationMs,
        totalScore: categories.reduce((s, c) => s + c.score, 0),
        categories,
        improvements: this.improvementsWithRefs(r.improvements, graph),
        sections: EMPTY_HLD_SECTIONS,
        strengths: [],
        followUpQuestions: [],
        systemNotes: this.reviewNotes(doc, graph, provider),
        reviewMode: 'fast',
        detail: { status: 'pending', error: null, model: null, durationMs: null },
      };
      this.insertReview(stored, ctx, { score: { output: res.output, usage: res.usage } });
      this.bus.publish({ type: 'hld-submission', sessionId: sub.session_id, submissionId: sub.id });
      ctx.progress(`Score ready: ${stored.totalScore}/100. Waiting for the section feedback…`);
    } catch (e) {
      detailAbort.abort();
      await detailRun;
      ctx.signal.removeEventListener('abort', onJobAbort);
      throw e;
    }
    const d = await detailRun;
    ctx.signal.removeEventListener('abort', onJobAbort);
    this.mergeDetail(stored.id, d.ok ? d.v : { error: d.e });
    return { reviewId: stored.id, score: stored.totalScore };
  }

  private async runDetailPass(sub: SubmissionRow, provider: ProviderId, ctx: JobContext, inputs: ReturnType<HldService['reviewInputs']>) {
    const prompt = this.prompts.render(HLD_PROMPTS.reviewDetail, inputs.vars);
    const { data, result } = await this.providers.runValidated(provider, 'hld-review-detail', prompt, HldAiReviewDetail, ctx, {
      mockContext: { graph: inputs.graph },
      onPartial: this.partialPublisher(sub, ctx, 'detail'),
    });
    ctx.progress('validated.');
    return { fields: data, result };
  }

  private mergeDetail(
    reviewId: string,
    outcome: { fields: HldAiReviewDetail; result: { output: unknown; usage: unknown; model: string | null; durationMs: number } } | { error: unknown },
  ): void {
    const row = this.db.prepare('SELECT submission_id, review_json, raw_output_json FROM hld_reviews WHERE id = ?').get(reviewId) as
      | { submission_id: string; review_json: string; raw_output_json: string }
      | undefined;
    if (!row) return;
    const review = json<StoredHldReview>(row.review_json, null as unknown as StoredHldReview);
    const raw = json<Record<string, unknown>>(row.raw_output_json, {});
    if ('fields' in outcome) {
      Object.assign(review, outcome.fields);
      review.detail = { status: 'completed', error: null, model: outcome.result.model, durationMs: outcome.result.durationMs };
      raw.detail = { output: outcome.result.output, usage: outcome.result.usage };
    } else {
      const e = outcome.error;
      const error = e instanceof JobFailure ? { code: e.code as string, message: e.message } : { code: 'internal', message: e instanceof Error ? e.message : String(e) };
      review.detail = { status: 'failed', error, model: null, durationMs: null };
    }
    this.db.prepare('UPDATE hld_reviews SET review_json = ?, raw_output_json = ? WHERE id = ?').run(JSON.stringify(review), JSON.stringify(raw), reviewId);
    const sub = this.subRow(row.submission_id);
    this.bus.publish({ type: 'hld-submission', sessionId: sub.session_id, submissionId: sub.id });
  }

  /** Re-runs only the detail pass of the latest fast-mode review (after it failed or was interrupted). */
  startDetailRetry(submissionId: string): Job {
    const sub = this.subRow(submissionId);
    const review = this.getSubmission(submissionId).review;
    if (!review || review.reviewMode !== 'fast') throw new HttpError(409, 'Only a fast-mode review has a separate detail pass to retry.');
    if (review.detail?.status === 'completed') throw new HttpError(409, 'The section feedback for this review is already complete.');
    const provider = this.providers.selected();
    const { job, existing } = this.jobs.create({ kind: 'hld-review-detail', provider, sessionId: sub.session_id, submissionId, dedupeKey: `hld-review-detail:${submissionId}` });
    if (!existing) {
      void this.jobs
        .run(job.id, async (ctx) => {
          const r = this.db.prepare('SELECT review_json FROM hld_reviews WHERE id = ?').get(review.id) as { review_json: string };
          const pending = json<StoredHldReview>(r.review_json, null as unknown as StoredHldReview);
          pending.detail = { status: 'pending', error: null, model: null, durationMs: null };
          this.db.prepare('UPDATE hld_reviews SET review_json = ? WHERE id = ?').run(JSON.stringify(pending), review.id);
          try {
            const v = await this.runDetailPass(sub, provider, ctx, this.reviewInputs(sub));
            this.mergeDetail(review.id, v);
            return { reviewId: review.id };
          } catch (e) {
            this.mergeDetail(review.id, { error: e });
            throw e;
          }
        })
        .then(() => this.bus.publish({ type: 'hld-submission', sessionId: sub.session_id, submissionId }));
    }
    return job;
  }

  private subRow(id: string): SubmissionRow {
    const r = this.db.prepare('SELECT * FROM hld_submissions WHERE id = ?').get(id) as SubmissionRow | undefined;
    if (!r) throw new HttpError(404, 'HLD submission not found');
    return r;
  }

  getSubmission(id: string): HldSubmission {
    const s = this.subRow(id);
    const rv = this.db.prepare('SELECT review_json FROM hld_reviews WHERE submission_id = ? ORDER BY created_at DESC LIMIT 1').get(id) as { review_json: string } | undefined;
    const review = rv ? json<StoredHldReview | null>(rv.review_json, null) : null;
    const jr = this.db.prepare(`SELECT id FROM jobs WHERE submission_id = ? AND kind = 'hld-review' ORDER BY created_at DESC LIMIT 1`).get(id) as { id: string } | undefined;
    const job = jr ? this.jobs.get(jr.id) : null;
    if (review?.detail?.status === 'pending') {
      const active = this.db
        .prepare(`SELECT 1 FROM jobs WHERE submission_id = ? AND kind IN ('hld-review', 'hld-review-detail') AND state IN ('queued', 'running') LIMIT 1`)
        .get(id);
      // The job that owned the detail pass is gone (server restart or cancel): say so instead of spinning forever.
      if (!active) review.detail = { status: 'failed', error: { code: 'interrupted', message: 'The section feedback did not finish. Retry it.' }, model: null, durationMs: null };
    }
    const status: HldSubmission['reviewStatus'] = review
      ? 'completed'
      : !job
        ? 'not-requested'
        : job.state === 'queued'
          ? 'pending'
          : job.state === 'running'
            ? 'running'
            : job.state === 'completed'
              ? 'completed'
              : job.state;
    return {
      id: s.id,
      sessionId: s.session_id,
      seq: s.seq,
      createdAt: s.created_at,
      contentHash: s.content_hash,
      reviewStatus: status,
      reviewJobId: job?.id ?? null,
      score: review?.totalScore ?? null,
      provider: review?.provider ?? job?.provider ?? null,
      model: review?.model ?? null,
      isMock: review?.isMock ?? false,
      elapsedMs: s.elapsed_ms,
      graph: json<DiagramGraph>(s.graph_json, { components: [], connections: [], notes: [], ignored: [] }),
      review,
      reviewError: !review && job?.error ? job.error : null,
    };
  }

  /** The exact design document that was submitted (immutable). */
  submissionDoc(id: string): HldDocument {
    return json<HldDocument>(this.subRow(id).doc_json, EMPTY_HLD_DOCUMENT);
  }

  listSubmissions(sessionId: string): HldSubmission[] {
    return (this.db.prepare('SELECT id FROM hld_submissions WHERE session_id = ? ORDER BY seq DESC').all(sessionId) as { id: string }[]).map((r) => this.getSubmission(r.id));
  }

  recentScores(): { at: string; score: number; title: string; sessionId: string }[] {
    return (
      this.db
        .prepare(
          `SELECT r.created_at AS at, r.total_score AS score, s.id AS sessionId, s.problem_id, s.problem_version
           FROM hld_reviews r JOIN hld_submissions sb ON sb.id = r.submission_id JOIN hld_sessions s ON s.id = sb.session_id
           WHERE r.is_mock = 0 ORDER BY r.created_at DESC LIMIT 50`,
        )
        .all() as { at: string; score: number; sessionId: string; problem_id: string; problem_version: number }[]
    ).map((r) => ({ at: r.at, score: r.score, sessionId: r.sessionId, title: this.getFull(r.problem_id, r.problem_version).content.title }));
  }
}
