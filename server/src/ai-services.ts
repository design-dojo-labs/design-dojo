import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AiHint,
  AiReference,
  HINT_LEVEL_LABELS,
  ProblemContent,
  TARGET_LABELS,
  TOPIC_LABELS,
  checkProblemSemantics,
  titleSimilarity,
  toAiJsonSchema,
  type GenerateProblemRequest,
  type Hint,
  type Job,
  type ProviderId,
  type ReferenceSolution,
} from '@lld/shared';
import { type DB, json, now } from './db.js';
import { HttpError, normalizeRelPath } from './fs/paths.js';
import { JobFailure, type JobManager } from './jobs.js';
import type { ProblemRepo } from './problems.js';
import { filesToText, generationNovelty, generationTheme, problemToText, PROMPT_VERSIONS, type Prompts } from './prompts.js';
import type { Providers } from './providers/index.js';
import type { SessionStore } from './sessions.js';

const ConnectionTest = z.object({ ok: z.boolean(), message: z.string().max(300) });

export class AiServices {
  constructor(
    private db: DB,
    private jobs: JobManager,
    private providers: Providers,
    private prompts: Prompts,
    private problems: ProblemRepo,
    private sessions: SessionStore,
    private dataRoot: string,
  ) {}

  /** User-triggered only: sends one tiny request through the selected CLI to verify end-to-end access. */
  connectionTest(provider: ProviderId): Job {
    this.providers.adapter(provider);
    const { job, existing } = this.jobs.create({ kind: 'connection-test', provider, dedupeKey: `connection-test:${provider}` });
    if (existing) return job;
    void this.jobs.run(job.id, async (ctx) => {
      try {
        const res = await this.providers.run(
          provider,
          'connection-test',
          'This is a connectivity check from a local practice app. Reply with ok=true and a short friendly message (under 20 words).',
          toAiJsonSchema(ConnectionTest),
          ctx,
        );
        const parsed = ConnectionTest.safeParse(res.output);
        if (!parsed.success || !parsed.data.ok) throw new JobFailure('malformed-output', 'The CLI responded, but not with the expected structured answer.');
        this.providers.recordConnectionTest(provider, true, parsed.data.message, res.model);
        return { ok: true, model: res.model, message: parsed.data.message };
      } catch (e) {
        if (!(e instanceof JobFailure && e.code === 'cancelled')) this.providers.recordConnectionTest(provider, false, (e as Error).message, null);
        throw e;
      }
    });
    return job;
  }

  generateProblem(req: GenerateProblemRequest): Job {
    const provider = this.providers.selected();
    const { job, existing } = this.jobs.create({ kind: 'generate', provider, dedupeKey: 'generate', params: req });
    if (existing) return job;
    void this.jobs.run(job.id, async (ctx) => {
      const existingTitles = this.problems.allTitles();
      const prompt = this.prompts.render(PROMPT_VERSIONS.generate, {
        difficulty: req.difficulty,
        target: req.target,
        topic: req.topic ? `${req.topic} (${TOPIC_LABELS[req.topic]})` : 'any suitable topic',
        duration: req.durationMinutes ? `${req.durationMinutes} minutes` : 'untimed (aim for about 60 minutes)',
        theme: generationTheme(req.theme),
        noveltyRule: generationNovelty(req.theme),
        topicRule: req.topic ? ` and must include "${req.topic}"` : '',
        existingTitles: existingTitles.map((t) => `- ${t}`).join('\n') || '- (none)',
      });
      ctx.progress(`Asking ${provider} for a new ${req.difficulty} ${TARGET_LABELS[req.target]} problem…`);
      const quality = (c: ProblemContent) => {
        const issues = checkProblemSemantics(c);
        if (c.difficulty !== req.difficulty) issues.push(`difficulty is "${c.difficulty}" but "${req.difficulty}" was requested`);
        if (!c.targets.includes(req.target)) issues.push(`targets do not include ${req.target}`);
        if (req.topic && !c.topics.includes(req.topic)) issues.push(`topics do not include ${req.topic}`);
        return issues;
      };
      const { data: content, result: res } = await this.providers.runValidated(provider, 'generate', prompt, ProblemContent, ctx, {
        mockContext: { difficulty: req.difficulty, target: req.target, topic: req.topic },
        check: quality,
      });
      ctx.progress('Validating the generated problem…');
      const issues: string[] = [];
      const dupe = !req.theme?.trim() && existingTitles.find((t) => titleSimilarity(t, content.title) >= 0.6);
      if (dupe) issues.push(`"${content.title}" is too similar to the existing problem "${dupe}"`);
      if (issues.length) throw new JobFailure('validation-failed', 'The generated problem failed quality checks, so it was not saved. Try generating again.', issues);
      const saved = this.problems.saveGenerated(content, { provider: res.provider, model: res.model, promptVersion: PROMPT_VERSIONS.generate });
      return { problemId: saved.id, version: saved.version, title: content.title, isMock: res.provider === 'mock' };
    });
    return job;
  }

  hint(sessionId: string, input: { level: number; requirementId?: string | null; question?: string }): Job {
    const session = this.sessions.get(sessionId);
    if (session.mode === 'interview') throw new HttpError(403, 'AI hints are disabled in interview mode.');
    const used = this.listHints(sessionId);
    const maxLevel = used.reduce((m, h) => Math.max(m, h.requestedLevel), 0);
    if (input.level > maxLevel + 1) throw new HttpError(400, `Hints are progressive: request level ${maxLevel + 1} before level ${input.level}.`);
    if (input.requirementId && !session.problem.content.requirements.some((r) => r.id === input.requirementId)) {
      throw new HttpError(400, `Unknown requirement ${input.requirementId}.`);
    }
    const provider = this.providers.selected();
    const { job, existing } = this.jobs.create({ kind: 'hint', provider, sessionId, dedupeKey: `hint:${sessionId}`, params: input });
    if (existing) return job;
    void this.jobs.run(job.id, async (ctx) => {
      const ws = this.sessions.workspace(sessionId);
      const { files } = ws.collectSources();
      const sources = files
        .filter((f) => f.rel.endsWith('.java') || f.rel === 'DESIGN_NOTES.md')
        .map((f) => ({ path: f.rel, content: readFileSync(f.abs, 'utf8') }));
      const totalKb = sources.reduce((s, f) => s + f.content.length, 0) / 1024;
      const prompt = this.prompts.render(PROMPT_VERSIONS.hint, {
        level: String(input.level),
        levelLabel: HINT_LEVEL_LABELS[input.level],
        problemTitle: session.problem.content.title,
        problem: problemToText(session.problem.content),
        focus: input.requirementId
          ? `Requirement ${input.requirementId}: ${session.problem.content.requirements.find((r) => r.id === input.requirementId)?.text}`
          : 'Whatever is most useful for the candidate right now.',
        question: input.question?.trim() || '(no specific question)',
        previousHints: used.length ? used.map((h) => `- Level ${h.level}: ${h.title}`).join('\n') : '(none)',
        files: totalKb > 200 ? '(code omitted from the hint request because it exceeds 200 KB)' : filesToText(sources, 'candidate_code'),
      });
      ctx.progress(`Asking ${provider} for a level ${input.level} hint…`);
      const { data, result: res } = await this.providers.runValidated(provider, 'hint', prompt, AiHint, ctx, {
        mockContext: { level: input.level },
        check: (h) => (input.level === 4 && h.codeExample && h.codeExample.split('\n').length > 25 ? ['codeExample: a level-4 example must be at most 25 lines'] : []),
      });
      const hint = { ...data, level: input.level };
      if (input.level < 4 && hint.codeExample) hint.codeExample = null; // levels 1–3 never include code
      if (hint.codeExample && hint.codeExample.split('\n').length > 25) {
        throw new JobFailure('validation-failed', 'The level-4 hint included more code than a small targeted example allows; it was discarded.');
      }
      const id = randomUUID();
      this.db
        .prepare(
          `INSERT INTO hints (id, session_id, job_id, requested_level, requirement_id, question, hint_json, provider, model, is_mock, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(id, sessionId, ctx.jobId, input.level, input.requirementId ?? null, input.question ?? null, JSON.stringify(hint), res.provider, res.model, res.provider === 'mock' ? 1 : 0, now());
      this.sessions.touch(sessionId);
      return { hintId: id };
    });
    return job;
  }

  listHints(sessionId: string): Hint[] {
    const rows = this.db.prepare('SELECT * FROM hints WHERE session_id = ? ORDER BY created_at').all(sessionId) as {
      id: string;
      session_id: string;
      requested_level: number;
      requirement_id: string | null;
      question: string | null;
      hint_json: string;
      provider: string;
      model: string | null;
      is_mock: number;
      created_at: string;
    }[];
    return rows.map((r) => ({
      ...json<AiHint>(r.hint_json, {} as AiHint),
      id: r.id,
      sessionId: r.session_id,
      requestedLevel: r.requested_level,
      requirementId: r.requirement_id,
      question: r.question,
      provider: r.provider,
      model: r.model,
      isMock: !!r.is_mock,
      createdAt: r.created_at,
    }));
  }

  /** Generates a reference solution into a separate folder; the learner's workspace is never modified. */
  reference(sessionId: string): Job {
    const session = this.sessions.get(sessionId);
    if (session.submissionCount === 0) throw new HttpError(409, 'Submit your own attempt before viewing a reference solution.');
    const provider = this.providers.selected();
    const { job, existing } = this.jobs.create({ kind: 'reference', provider, sessionId, dedupeKey: `reference:${sessionId}` });
    if (existing) return job;
    void this.jobs.run(job.id, async (ctx) => {
      const prompt = this.prompts.render(PROMPT_VERSIONS.reference, {
        javaRelease: '21',
        packageName: session.packageName,
        problemTitle: session.problem.content.title,
        problem: problemToText(session.problem.content),
      });
      ctx.progress(`Asking ${provider} for a reference solution…`);
      const pathIssues = (r: AiReference) =>
        r.files.flatMap((f) => {
          try {
            normalizeRelPath(f.path);
            return [];
          } catch {
            return [`files: invalid relative path "${f.path.slice(0, 120)}"`];
          }
        });
      const { data: refData, result: res } = await this.providers.runValidated(provider, 'reference', prompt, AiReference, ctx, {
        mockContext: { packageName: session.packageName },
        check: pathIssues,
      });
      const parsed = { data: refData };
      const files: { path: string; content: string }[] = [];
      for (const f of parsed.data.files) {
        let p: string;
        try {
          p = normalizeRelPath(f.path);
        } catch {
          throw new JobFailure('validation-failed', `Reference solution contained an invalid file path: ${f.path.slice(0, 120)}`);
        }
        files.push({ path: p, content: f.content });
      }
      const id = randomUUID();
      const dir = join(this.dataRoot, 'references', id);
      for (const f of files) {
        const abs = join(dir, ...f.path.split('/'));
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, f.content, { mode: 0o444 });
      }
      const ref = { ...parsed.data, files };
      this.db
        .prepare(`INSERT INTO reference_solutions (id, session_id, job_id, reference_json, provider, model, is_mock, created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(id, sessionId, ctx.jobId, JSON.stringify(ref), res.provider, res.model, res.provider === 'mock' ? 1 : 0, now());
      this.sessions.markSolutionRevealed(sessionId);
      return { referenceId: id, folder: dir };
    });
    return job;
  }

  getReference(sessionId: string): ReferenceSolution | null {
    const r = this.db.prepare('SELECT * FROM reference_solutions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId) as
      | { id: string; session_id: string; reference_json: string; provider: string; model: string | null; is_mock: number; created_at: string }
      | undefined;
    if (!r) return null;
    return {
      ...json<ReferenceSolution>(r.reference_json, {} as ReferenceSolution),
      id: r.id,
      sessionId: r.session_id,
      provider: r.provider,
      model: r.model,
      isMock: !!r.is_mock,
      createdAt: r.created_at,
    };
  }
}
