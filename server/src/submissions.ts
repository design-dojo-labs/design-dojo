import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AiReview,
  AiReviewDetail,
  AiReviewScore,
  DESIGN_PRINCIPLE_LABELS,
  parsePartialJson,
  REVIEW_SCHEMA_VERSION,
  SOLID_LABELS,
  titleSimilarity,
  type ExcludedEntry,
  type ExecRun,
  type Job,
  type JobError,
  type ManifestEntry,
  type ProblemVersion,
  type ProviderId,
  type Rubric,
  type StoredFinding,
  type StoredReview,
  type Submission,
  type SubmissionComparison,
  type SubmissionSummary,
} from '@lld/shared';
import { type DB, json, now } from './db.js';
import type { EventBus } from './events.js';
import { HttpError, normalizeRelPath, resolveInside } from './fs/paths.js';
import { buildManifest, isManaged } from './fs/workspace.js';
import { JobFailure, type JobContext, type JobManager } from './jobs.js';
import type { JavaRunner } from './java/runner.js';
import type { ProblemRepo } from './problems.js';
import { filesToText, problemToText, PROMPT_VERSIONS, type Prompts, rubricToText } from './prompts.js';
import type { Providers } from './providers/index.js';
import type { MockReviewContext } from './providers/mock.js';
import { markedFixed } from './interactive.js';
import { type ScoringContext, validateAndScore, validateDetailPass, validateScorePass } from './review/scoring.js';
import { elapsedMs, type SessionStore } from './sessions.js';
import type { SettingsStore } from './settings.js';

const DESIGN_NOTES = 'DESIGN_NOTES.md';

interface SubmissionRow {
  id: string;
  session_id: string;
  seq: number;
  content_hash: string;
  problem_id: string;
  problem_version: number;
  rubric_version: string;
  rubric_json: string;
  manifest_json: string;
  excluded_json: string;
  build_state: SubmissionSummary['buildState'];
  compile_run_id: string | null;
  test_run_id: string | null;
  hints_used: number;
  solution_revealed: number;
  elapsed_ms: number;
  created_at: string;
}

interface ReviewRow {
  id: string;
  submission_id: string;
  job_id: string;
  provider: string;
  model: string | null;
  is_mock: number;
  prompt_version: string;
  schema_version: string;
  rubric_version: string;
  total_score: number;
  review_json: string;
  duration_ms: number | null;
  created_at: string;
}

export class SubmissionService {
  constructor(
    private db: DB,
    private bus: EventBus,
    private sessions: SessionStore,
    private problems: ProblemRepo,
    private runner: JavaRunner,
    private jobs: JobManager,
    private providers: Providers,
    private prompts: Prompts,
    private settings: SettingsStore,
    private dataRoot: string,
  ) {}

  snapshotDir(id: string): string {
    return join(this.dataRoot, 'submissions', id, 'source');
  }

  /**
   * Creates an immutable snapshot of the workspace, then starts the build + review pipeline.
   * The client flushes pending saves before calling this; the snapshot reflects disk at this moment.
   */
  submit(sessionId: string): { submission: Submission; job: Job | null; duplicate: boolean } {
    const session = this.sessions.get(sessionId);
    if (session.status !== 'active') throw new HttpError(409, 'This session is archived. Restore it before submitting.');
    const ws = this.sessions.workspace(sessionId);
    const { files, excluded } = ws.collectSources();
    const contents = files.map((f) => ({ rel: f.rel, content: readFileSync(f.abs) }));
    const { manifest, contentHash } = buildManifest(contents);

    const latest = this.db.prepare('SELECT * FROM submissions WHERE session_id = ? ORDER BY seq DESC LIMIT 1').get(sessionId) as SubmissionRow | undefined;
    if (latest && latest.content_hash === contentHash) {
      // Repeated click or no edits since the last submission: return the existing one instead of duplicating.
      const job = this.activeReviewJob(latest.id);
      return { submission: this.get(latest.id), job, duplicate: true };
    }

    const reviewBytes = contents.filter((c) => this.inReviewContext(c.rel)).reduce((s, c) => s + c.content.length, 0);
    const limitKb = this.settings.get().review.maxContextKb;
    if (reviewBytes > limitKb * 1024) {
      const biggest = [...contents].sort((a, b) => b.content.length - a.content.length).slice(0, 5);
      throw new HttpError(
        413,
        `This project has ${Math.round(reviewBytes / 1024)} KB of source, above the ${limitKb} KB review limit. Nothing was submitted. Reduce the code size or raise the limit in Settings. Largest files: ${biggest
          .map((b) => `${b.rel} (${Math.round(b.content.length / 1024)} KB)`)
          .join(', ')}`,
      );
    }

    const id = randomUUID();
    const dir = this.snapshotDir(id);
    mkdirSync(dir, { recursive: true });
    for (const c of contents) {
      const abs = join(dir, ...c.rel.split('/'));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c.content, { mode: 0o444 });
    }
    writeFileSync(join(this.dataRoot, 'submissions', id, 'manifest.json'), JSON.stringify({ id, sessionId, contentHash, manifest, excluded }, null, 2), { mode: 0o444 });
    lockTree(dir);

    const seq = ((this.db.prepare('SELECT MAX(seq) AS m FROM submissions WHERE session_id = ?').get(sessionId) as { m: number | null }).m ?? 0) + 1;
    this.db
      .prepare(
        `INSERT INTO submissions (id, session_id, seq, content_hash, problem_id, problem_version, rubric_version, rubric_json, manifest_json, excluded_json, build_state, hints_used, solution_revealed, elapsed_ms, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?,?,?,?)`,
      )
      .run(
        id,
        sessionId,
        seq,
        contentHash,
        session.problemId,
        session.problemVersion,
        session.problem.rubric.version,
        JSON.stringify(session.problem.rubric),
        JSON.stringify(manifest),
        JSON.stringify(excluded),
        session.hintsUsed,
        session.solutionRevealed ? 1 : 0,
        elapsedMs(session.timer),
        now(),
      );
    this.sessions.touch(sessionId);
    const job = this.startReview(id);
    this.publish(id);
    return { submission: this.get(id), job, duplicate: false };
  }

  /** Starts (or returns the in-flight) build+review job for a submission. Used for first runs and retries. */
  startReview(submissionId: string): Job {
    const row = this.row(submissionId);
    let provider: string | null = null;
    try {
      provider = this.providers.selected();
    } catch {
      provider = null;
    }
    const { job, existing } = this.jobs.create({
      kind: 'review',
      provider,
      sessionId: row.session_id,
      submissionId,
      dedupeKey: `review:${submissionId}`,
    });
    if (!existing) {
      void this.jobs.run(job.id, (ctx) => this.pipeline(submissionId, provider as ProviderId | null, ctx)).then(() => this.publish(submissionId));
    }
    this.publish(submissionId);
    return job;
  }

  private async pipeline(submissionId: string, provider: ProviderId | null, ctx: JobContext): Promise<unknown> {
    let row = this.row(submissionId);
    if (row.build_state !== 'done') {
      ctx.progress('Building and testing the submitted snapshot…');
      await this.build(row, ctx);
      row = this.row(submissionId);
    } else ctx.progress('Reusing recorded build and test results for this snapshot.');
    if (ctx.signal.aborted) throw new JobFailure('cancelled', 'Cancelled.');
    if (!provider) {
      throw new JobFailure('provider-disabled', 'Build and tests were recorded, but no AI provider is selected. Choose Claude Code or Codex in Settings, then retry the review.');
    }
    return this.review(row, provider, ctx);
  }

  /** Compiles and runs tests on a writable copy of the snapshot; the snapshot itself is never touched. */
  private async build(row: SubmissionRow, ctx: JobContext): Promise<void> {
    this.db.prepare(`UPDATE submissions SET build_state = 'running' WHERE id = ?`).run(row.id);
    this.publish(row.id);
    const buildDir = join(this.dataRoot, 'builds', row.id);
    rmSync(buildDir, { recursive: true, force: true });
    cpSync(this.snapshotDir(row.id), buildDir, { recursive: true });
    makeWritable(buildDir);
    let runId: string | null = null;
    try {
      const { run, done } = await this.runner.start({ sessionId: row.session_id, submissionId: row.id, buildRoot: buildDir, kind: 'test' });
      runId = run.id;
      this.db.prepare('UPDATE submissions SET compile_run_id = ?, test_run_id = ? WHERE id = ?').run(run.id, run.id, row.id);
      const onAbort = () => this.runner.stop(run.id);
      ctx.signal.addEventListener('abort', onAbort);
      const finished = await done;
      ctx.signal.removeEventListener('abort', onAbort);
      const t = finished.tests;
      ctx.progress(
        finished.phase === 'compile' || (finished.state !== 'succeeded' && !t)
          ? `Build result: ${finished.state === 'failed' ? 'compilation failed' : finished.state}.`
          : `Tests: ${t?.passed ?? 0} passed, ${t?.failed ?? 0} failed, ${t?.errored ?? 0} errored, ${t?.skipped ?? 0} skipped.`,
      );
      this.db.prepare(`UPDATE submissions SET build_state = ? WHERE id = ?`).run(finished.state === 'cancelled' ? 'failed' : 'done', row.id);
    } catch (e) {
      // Toolchain not ready etc. Record it and continue to a design-only review with that limitation stated.
      this.db.prepare(`UPDATE submissions SET build_state = 'failed' WHERE id = ?`).run(row.id);
      ctx.progress(`Could not build the snapshot: ${(e as Error).message}`);
    } finally {
      rmSync(join(buildDir, 'target', 'classes'), { recursive: true, force: true });
      this.publish(row.id);
      void runId;
    }
  }

  /** Everything a review pass needs: prompt variables, scoring context and mock context. */
  private reviewInputs(row: SubmissionRow) {
    const problem = this.problems.get(row.problem_id, row.problem_version);
    const rubric = json<Rubric>(row.rubric_json, problem.rubric);
    const manifest = json<ManifestEntry[]>(row.manifest_json, []);
    const excluded = json<ExcludedEntry[]>(row.excluded_json, []);
    const files = new Map<string, string>();
    for (const m of manifest) files.set(m.path, readFileSync(join(this.snapshotDir(row.id), ...m.path.split('/')), 'utf8'));

    const testRun = row.test_run_id ? this.runner.get(row.test_run_id) : null;
    const testsRan = !!testRun?.tests && testRun.tests.total > 0;
    const prev = this.previousReview(row);
    const session = this.sessions.get(row.session_id);

    const reviewFiles = manifest.filter((m) => this.inReviewContext(m.path) && m.path !== DESIGN_NOTES).map((m) => ({ path: m.path, content: files.get(m.path)! }));
    const contextExcluded = [
      ...excluded.map((e) => `- ${e.path}: ${e.reason}`),
      ...manifest.filter((m) => !this.inReviewContext(m.path)).map((m) => `- ${m.path}: managed build template file (not written by the candidate)`),
    ];
    const vars: Record<string, string> = {
      rubricVersion: rubric.version,
      rubric: rubricToText(rubric),
      problemTitle: problem.content.title,
      problemId: problem.id,
      problemVersion: String(problem.version),
      problem: problemToText(problem.content),
      execution: executionEvidence(testRun, row.build_state),
      practiceContext: [
        `Mode: ${session.mode}. Time spent: ${Math.round(row.elapsed_ms / 60000)} min${session.timer.durationMinutes ? ` of ${session.timer.durationMinutes}` : ' (untimed)'}.`,
        `Hints used before this submission: ${row.hints_used}. Reference solution revealed before this submission: ${row.solution_revealed ? 'yes' : 'no'}.`,
        'Do not change scores because of hints or time; these are reported alongside the assessment.',
      ].join('\n'),
      previousReview: prev ? previousReviewText(prev, markedFixed(this.db, prev.review.id)) : '## PREVIOUS REVIEW\nNone — this is the first reviewed submission. Return an empty priorFindings array.',
      submissionId: row.id,
      contentHash: row.content_hash,
      excluded: contextExcluded.length ? `Files present in the workspace but NOT shown below:\n${contextExcluded.join('\n')}` : 'All source files in the workspace are shown below.',
      designNotes: files.get(DESIGN_NOTES)?.trim() || '(no design notes provided)',
      files: filesToText(reviewFiles),
    };
    const mockContext: MockReviewContext = {
      requirementIds: problem.content.requirements.map((r) => r.id),
      files: reviewFiles.map((f) => ({ path: f.path, lines: f.content.split('\n').length })),
      previousFindingIds: prev?.review.findings.map((f) => f.id) ?? [],
    };
    const reviewId = randomUUID();
    const scoring: ScoringContext = {
      rubric,
      requirementIds: problem.content.requirements.map((r) => r.id),
      files,
      testsRan,
      previousFindingIds: prev?.review.findings.map((f) => f.id) ?? [],
      reviewIdPrefix: reviewId.slice(0, 8),
    };
    return { problem, rubric, excluded, testRun, testsRan, prev, reviewFiles, vars, mockContext, reviewId, scoring };
  }

  /** Publishes the parsed, partial structured answer of a running pass so the UI can show it early. */
  private partialPublisher(row: SubmissionRow, ctx: JobContext, phase: string) {
    return (text: string) => {
      const data = parsePartialJson(text);
      if (data && typeof data === 'object') this.bus.publish({ type: 'job-partial', jobId: ctx.jobId, sessionId: row.session_id, submissionId: row.id, phase, data });
    };
  }

  private systemNotes(row: SubmissionRow, provider: ProviderId, model: string | null, inputs: ReturnType<SubmissionService['reviewInputs']>): string[] {
    const { testRun, testsRan, excluded, prev } = inputs;
    const notes: string[] = [];
    if (row.build_state === 'failed' || testRun?.phase === 'compile') {
      notes.push('The snapshot did not compile (or could not be built). Functional correctness was assessed by reading the code only.');
    } else if (!testsRan) notes.push('No tests ran for this snapshot; requirement coverage is based on code inspection.');
    if (excluded.length) notes.push(`${excluded.length} workspace path(s) were not part of the snapshot: ${excluded.map((e) => `${e.path} (${e.reason})`).join('; ')}.`);
    if (provider === 'mock') notes.push('MOCK PROVIDER: this review is canned test output and says nothing about your code.');
    if (row.solution_revealed) notes.push('The reference solution was revealed before this submission.');
    if (prev && (prev.review.provider !== provider || prev.review.model !== model)) {
      notes.push(`Reviewer changed since submission #${prev.seq} (${prev.review.provider}/${prev.review.model ?? 'default'} → ${provider}/${model ?? 'default'}); score differences are not directly comparable.`);
    }
    return notes;
  }

  /** Rubric violations get the provider's single correction round (same as schema problems). */
  private static checkWith<T>(fn: (d: T) => unknown) {
    return (d: T): string[] => {
      try {
        fn(d);
        return [];
      } catch (e) {
        return e instanceof JobFailure ? (e.details ?? [e.message]) : [String(e)];
      }
    };
  }

  private async review(row: SubmissionRow, provider: ProviderId, ctx: JobContext): Promise<unknown> {
    const inputs = this.reviewInputs(row);
    const mode = this.settings.get().review.mode;
    ctx.progress(`Sending snapshot #${row.seq} (${inputs.reviewFiles.length} files) to ${provider} for review (${mode === 'fast' ? 'fast: score and detail in parallel' : 'full: one combined pass'})…`);
    return mode === 'fast' ? this.reviewFast(row, provider, ctx, inputs) : this.reviewFull(row, provider, ctx, inputs);
  }

  /** Full mode: one combined call (review.v2), the original behaviour. */
  private async reviewFull(row: SubmissionRow, provider: ProviderId, ctx: JobContext, inputs: ReturnType<SubmissionService['reviewInputs']>): Promise<unknown> {
    const prompt = this.prompts.render(PROMPT_VERSIONS.review, inputs.vars);
    const { data, result } = await this.providers.runValidated(provider, 'review', prompt, AiReview, ctx, {
      mockContext: inputs.mockContext,
      check: SubmissionService.checkWith((d: AiReview) => validateAndScore(d, inputs.scoring)),
      onPartial: this.partialPublisher(row, ctx, 'full'),
    });
    ctx.progress('Validating review and computing the score…');
    const stored: StoredReview = {
      ...this.reviewEnvelope(row, ctx, provider, result.model, PROMPT_VERSIONS.review, inputs),
      durationMs: result.durationMs,
      ...validateAndScore(data, inputs.scoring),
      systemNotes: this.systemNotes(row, provider, result.model, inputs),
      reviewMode: 'full',
    };
    this.insertReview(stored, { output: result.output, usage: result.usage, events: result.eventCount });
    return { reviewId: stored.id, score: stored.totalScore };
  }

  /**
   * Fast mode: a score pass (scores, coverage, findings) and a detail pass (design assessment,
   * strengths, trade-offs, tests, questions) run in parallel. The review is stored and shown as
   * soon as the score pass is validated; the detail is merged in when it arrives. A failed detail
   * pass never changes the score — it is reported on the review and can be retried on its own.
   */
  private async reviewFast(row: SubmissionRow, provider: ProviderId, ctx: JobContext, inputs: ReturnType<SubmissionService['reviewInputs']>): Promise<unknown> {
    const detailAbort = new AbortController();
    const onJobAbort = () => detailAbort.abort();
    ctx.signal.addEventListener('abort', onJobAbort);
    const detailCtx: JobContext = { ...ctx, signal: detailAbort.signal, progress: (m) => ctx.progress(`Detail: ${m}`), setPid: () => {} };
    const scoreCtx: JobContext = { ...ctx, progress: (m) => ctx.progress(`Score: ${m}`) };

    const detailRun = this.runDetailPass(row, provider, detailCtx, inputs).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    let stored: StoredReview;
    try {
      const prompt = this.prompts.render(PROMPT_VERSIONS.reviewScore, inputs.vars);
      const { data, result } = await this.providers.runValidated(provider, 'review-score', prompt, AiReviewScore, scoreCtx, {
        mockContext: inputs.mockContext,
        check: SubmissionService.checkWith((d: AiReviewScore) => validateScorePass(d, inputs.scoring)),
        onPartial: this.partialPublisher(row, ctx, 'score'),
      });
      scoreCtx.progress('validated; computing the score…');
      stored = {
        ...this.reviewEnvelope(row, ctx, provider, result.model, PROMPT_VERSIONS.reviewScore, inputs),
        durationMs: result.durationMs,
        ...validateScorePass(data, inputs.scoring),
        strengths: [],
        tradeoffs: [],
        suggestedTests: [],
        followUpQuestions: [],
        systemNotes: this.systemNotes(row, provider, result.model, inputs),
        reviewMode: 'fast',
        detail: { status: 'pending', error: null, model: null, durationMs: null },
      };
      this.insertReview(stored, { score: { output: result.output, usage: result.usage, events: result.eventCount } });
      this.publish(row.id);
      ctx.progress(`Score ready: ${stored.totalScore}/100. Waiting for the design assessment…`);
    } catch (e) {
      detailAbort.abort(); // no score → nothing to attach the detail to
      await detailRun;
      ctx.signal.removeEventListener('abort', onJobAbort);
      throw e;
    }

    const d = await detailRun;
    ctx.signal.removeEventListener('abort', onJobAbort);
    this.mergeDetail(stored.id, d.ok ? d.v : { error: d.e });
    return { reviewId: stored.id, score: stored.totalScore };
  }

  private async runDetailPass(row: SubmissionRow, provider: ProviderId, ctx: JobContext, inputs: ReturnType<SubmissionService['reviewInputs']>) {
    // The detail pass does not report on previous findings; the score pass does.
    const prompt = this.prompts.render(PROMPT_VERSIONS.reviewDetail, { ...inputs.vars, previousReview: '' });
    const { data, result } = await this.providers.runValidated(provider, 'review-detail', prompt, AiReviewDetail, ctx, {
      mockContext: inputs.mockContext,
      check: SubmissionService.checkWith((d: AiReviewDetail) => validateDetailPass(d, inputs.scoring)),
      onPartial: this.partialPublisher(row, ctx, 'detail'),
    });
    ctx.progress('validated.');
    return { fields: validateDetailPass(data, inputs.scoring), result };
  }

  /** Merges a finished (or failed) detail pass into the stored review and notifies the UI. */
  private mergeDetail(
    reviewId: string,
    outcome: { fields: ReturnType<typeof validateDetailPass>; result: { output: unknown; usage: unknown; eventCount: number; model: string | null; durationMs: number } } | { error: unknown },
  ): void {
    const r = this.db.prepare('SELECT submission_id, review_json, raw_output_json FROM reviews WHERE id = ?').get(reviewId) as
      | { submission_id: string; review_json: string; raw_output_json: string }
      | undefined;
    if (!r) return;
    const review = json<StoredReview>(r.review_json, null as unknown as StoredReview);
    const raw = json<Record<string, unknown>>(r.raw_output_json, {});
    if ('fields' in outcome) {
      Object.assign(review, outcome.fields);
      review.detail = { status: 'completed', error: null, model: outcome.result.model, durationMs: outcome.result.durationMs };
      raw.detail = { output: outcome.result.output, usage: outcome.result.usage, events: outcome.result.eventCount };
    } else {
      const e = outcome.error;
      const error =
        e instanceof JobFailure
          ? { code: e.code as string, message: e.message }
          : { code: 'internal', message: e instanceof Error ? e.message : String(e) };
      review.detail = { status: 'failed', error, model: null, durationMs: null };
    }
    this.db.prepare('UPDATE reviews SET review_json = ?, raw_output_json = ? WHERE id = ?').run(JSON.stringify(review), JSON.stringify(raw), reviewId);
    this.publish(r.submission_id);
  }

  /** Re-runs only the detail pass of the latest fast-mode review (after it failed or was interrupted). */
  startDetailRetry(submissionId: string): Job {
    const row = this.row(submissionId);
    const review = this.latestReview(submissionId);
    if (!review || review.reviewMode !== 'fast') throw new HttpError(409, 'Only a fast-mode review has a separate detail pass to retry.');
    if (review.detail?.status === 'completed') throw new HttpError(409, 'The design assessment for this review is already complete.');
    const provider = this.providers.selected();
    const { job, existing } = this.jobs.create({ kind: 'review-detail', provider, sessionId: row.session_id, submissionId, dedupeKey: `review-detail:${submissionId}` });
    if (!existing) {
      void this.jobs
        .run(job.id, async (ctx) => {
          const inputs = this.reviewInputs(row);
          inputs.scoring.reviewIdPrefix = review.id.slice(0, 8);
          this.markDetailPending(review.id);
          try {
            const v = await this.runDetailPass(row, provider, ctx, inputs);
            this.mergeDetail(review.id, v);
            return { reviewId: review.id };
          } catch (e) {
            this.mergeDetail(review.id, { error: e });
            throw e;
          }
        })
        .then(() => this.publish(submissionId));
    }
    return job;
  }

  private markDetailPending(reviewId: string): void {
    const r = this.db.prepare('SELECT review_json FROM reviews WHERE id = ?').get(reviewId) as { review_json: string } | undefined;
    if (!r) return;
    const review = json<StoredReview>(r.review_json, null as unknown as StoredReview);
    review.detail = { status: 'pending', error: null, model: null, durationMs: null };
    this.db.prepare('UPDATE reviews SET review_json = ? WHERE id = ?').run(JSON.stringify(review), reviewId);
  }

  private reviewEnvelope(row: SubmissionRow, ctx: JobContext, provider: ProviderId, model: string | null, promptVersion: string, inputs: ReturnType<SubmissionService['reviewInputs']>) {
    return {
      id: inputs.reviewId,
      submissionId: row.id,
      sessionId: row.session_id,
      jobId: ctx.jobId,
      status: 'completed' as const,
      isMock: provider === 'mock',
      provider,
      model,
      promptVersion,
      schemaVersion: REVIEW_SCHEMA_VERSION,
      rubricVersion: inputs.rubric.version,
      problemId: inputs.problem.id,
      problemVersion: inputs.problem.version,
      createdAt: now(),
    };
  }

  private insertReview(stored: StoredReview, raw: Record<string, unknown>): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO reviews (id, submission_id, job_id, provider, model, is_mock, prompt_version, schema_version, rubric_version, total_score, review_json, raw_output_json, duration_ms, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          stored.id,
          stored.submissionId,
          stored.jobId,
          stored.provider,
          stored.model,
          stored.isMock ? 1 : 0,
          stored.promptVersion,
          stored.schemaVersion,
          stored.rubricVersion,
          stored.totalScore,
          JSON.stringify(stored),
          JSON.stringify(raw),
          stored.durationMs,
          stored.createdAt,
        );
      const ins = this.db.prepare(
        `INSERT INTO findings (id, review_id, idx, severity, category, title, file_path, line_start, line_end, reference, requirement_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      );
      for (const f of stored.findings) ins.run(f.id, stored.id, f.idx, f.severity, f.category, f.title, f.filePath, f.lineStart, f.lineEnd, f.reference, f.requirementId);
    })();
    this.sessions.touch(stored.sessionId);
  }

  private previousReview(row: SubmissionRow): { seq: number; review: StoredReview } | null {
    const r = this.db
      .prepare(
        `SELECT s.seq, r.review_json FROM submissions s JOIN reviews r ON r.submission_id = s.id
         WHERE s.session_id = ? AND s.seq < ? ORDER BY s.seq DESC, r.created_at DESC LIMIT 1`,
      )
      .get(row.session_id, row.seq) as { seq: number; review_json: string } | undefined;
    return r ? { seq: r.seq, review: json<StoredReview>(r.review_json, null as unknown as StoredReview) } : null;
  }

  /** Files sent to the reviewer: everything in the snapshot except the managed build template. */
  inReviewContext(rel: string): boolean {
    return !isManaged(rel);
  }

  row(id: string): SubmissionRow {
    const r = this.db.prepare('SELECT * FROM submissions WHERE id = ?').get(id) as SubmissionRow | undefined;
    if (!r) throw new HttpError(404, 'submission not found');
    return r;
  }

  private latestReview(submissionId: string): StoredReview | null {
    const r = this.db.prepare('SELECT review_json FROM reviews WHERE submission_id = ? ORDER BY created_at DESC LIMIT 1').get(submissionId) as
      | Pick<ReviewRow, 'review_json'>
      | undefined;
    const review = r ? json<StoredReview | null>(r.review_json, null) : null;
    if (review?.detail?.status === 'pending' && !this.activeReviewJob(submissionId)) {
      // The job that owned the detail pass is gone (server restart or cancel): say so instead of spinning forever.
      review.detail = { status: 'failed', error: { code: 'interrupted', message: 'The design assessment did not finish. Retry it.' }, model: null, durationMs: null };
    }
    return review;
  }

  private activeReviewJob(submissionId: string): Job | null {
    return (
      [...this.jobs.list({ kind: 'review' }), ...this.jobs.list({ kind: 'review-detail' })].find(
        (j) => j.submissionId === submissionId && (j.state === 'queued' || j.state === 'running'),
      ) ?? null
    );
  }

  private lastReviewJob(submissionId: string): Job | null {
    const r = this.db.prepare(`SELECT id FROM jobs WHERE submission_id = ? AND kind = 'review' ORDER BY created_at DESC LIMIT 1`).get(submissionId) as { id: string } | undefined;
    return r ? this.jobs.get(r.id) : null;
  }

  summary(row: SubmissionRow): SubmissionSummary {
    const review = this.latestReview(row.id);
    const job = this.lastReviewJob(row.id);
    const run = row.test_run_id ? this.runner.get(row.test_run_id) : null;
    const compile: SubmissionSummary['compile'] =
      row.build_state === 'pending' || row.build_state === 'running'
        ? 'pending'
        : !run
          ? 'not-run'
          : run.phase === 'compile' && run.state !== 'succeeded'
            ? 'failed'
            : run.state === 'timed-out' || run.state === 'cancelled' || run.state === 'interrupted'
              ? 'not-run'
              : 'passed';
    const reviewStatus: SubmissionSummary['reviewStatus'] = review
      ? 'completed'
      : !job
        ? 'not-requested'
        : job.state === 'queued'
          ? 'pending'
          : job.state === 'running'
            ? 'running'
            : job.state === 'completed'
              ? 'completed'
              : (job.state as SubmissionSummary['reviewStatus']);
    return {
      id: row.id,
      sessionId: row.session_id,
      seq: row.seq,
      createdAt: row.created_at,
      contentHash: row.content_hash,
      problemId: row.problem_id,
      problemVersion: row.problem_version,
      rubricVersion: row.rubric_version,
      compile,
      tests: run?.tests ? { passed: run.tests.passed, failed: run.tests.failed, errored: run.tests.errored, skipped: run.tests.skipped, total: run.tests.total } : null,
      buildState: row.build_state,
      reviewStatus,
      reviewJobId: job?.id ?? null,
      score: review?.totalScore ?? null,
      provider: review?.provider ?? job?.provider ?? null,
      model: review?.model ?? null,
      isMock: review?.isMock ?? job?.provider === 'mock',
      hintsUsedAtSubmit: row.hints_used,
      solutionRevealedAtSubmit: !!row.solution_revealed,
      elapsedMs: row.elapsed_ms,
    };
  }

  get(id: string): Submission {
    const row = this.row(id);
    const run = row.test_run_id ? this.runner.get(row.test_run_id) : null;
    const job = this.lastReviewJob(id);
    const review = this.latestReview(id);
    return {
      ...this.summary(row),
      manifest: json<ManifestEntry[]>(row.manifest_json, []),
      excluded: json<ExcludedEntry[]>(row.excluded_json, []),
      compileRun: run,
      testRun: run,
      review,
      reviewError: !review && job?.error ? (job.error as JobError) : null,
    };
  }

  list(sessionId: string): SubmissionSummary[] {
    const rows = this.db.prepare('SELECT * FROM submissions WHERE session_id = ? ORDER BY seq DESC').all(sessionId) as SubmissionRow[];
    return rows.map((r) => this.summary(r));
  }

  recent(limit = 15): (SubmissionSummary & { problemTitle: string })[] {
    const rows = this.db.prepare('SELECT * FROM submissions ORDER BY created_at DESC LIMIT ?').all(limit) as SubmissionRow[];
    return rows.map((r) => ({ ...this.summary(r), problemTitle: this.problems.get(r.problem_id, r.problem_version).content.title }));
  }

  /** Reads one file from the immutable snapshot. */
  readFile(id: string, relInput: string): { path: string; content: string; sha256: string; lines: number } {
    const row = this.row(id);
    const rel = normalizeRelPath(relInput);
    const entry = json<ManifestEntry[]>(row.manifest_json, []).find((m) => m.path === rel);
    if (!entry) throw new HttpError(404, `${rel} is not part of submission #${row.seq}`);
    const abs = resolveInside(this.snapshotDir(id), rel, { mustExist: true });
    return { path: rel, content: readFileSync(abs, 'utf8'), sha256: entry.sha256, lines: entry.lines };
  }

  compare(baseId: string, headId: string): SubmissionComparison {
    const base = this.row(baseId);
    const head = this.row(headId);
    if (base.session_id !== head.session_id) throw new HttpError(400, 'Only submissions from the same practice session can be compared.');
    const bm = new Map(json<ManifestEntry[]>(base.manifest_json, []).map((m) => [m.path, m.sha256]));
    const hm = new Map(json<ManifestEntry[]>(head.manifest_json, []).map((m) => [m.path, m.sha256]));
    const paths = [...new Set([...bm.keys(), ...hm.keys()])].sort();
    const files = paths.map((p) => ({
      path: p,
      status: (!bm.has(p) ? 'added' : !hm.has(p) ? 'removed' : bm.get(p) === hm.get(p) ? 'unchanged' : 'modified') as SubmissionComparison['files'][number]['status'],
    }));
    const br = this.latestReview(baseId);
    const hr = this.latestReview(headId);
    const notes: string[] = [];
    let comparable = !!(br && hr);
    if (base.problem_version !== head.problem_version || base.rubric_version !== head.rubric_version) {
      comparable = false;
      notes.push('Problem or rubric version differs between these submissions.');
    }
    if (br && hr && (br.provider !== hr.provider || br.model !== hr.model || br.promptVersion !== hr.promptVersion)) {
      comparable = false;
      notes.push(`Reviewer settings differ (${br.provider}/${br.model ?? 'default'} vs ${hr.provider}/${hr.model ?? 'default'}). Treat score changes as indicative only.`);
    }
    if (br?.isMock || hr?.isMock) {
      comparable = false;
      notes.push('At least one review came from the mock provider.');
    }
    if (!br || !hr) notes.push('Both submissions need a completed review for a score comparison.');
    const totalDelta = br && hr ? hr.totalScore - br.totalScore : null;
    if (comparable && totalDelta !== null && Math.abs(totalDelta) <= 5) {
      notes.push('A change of 5 points or less is within normal review-to-review variation and may not reflect a real improvement.');
    }
    const rubric = json<Rubric>(head.rubric_json, { version: '', total: 100, categories: [] });
    const categoryDeltas = rubric.categories.map((c) => ({
      key: c.key,
      label: c.label,
      max: c.max,
      base: br?.categories.find((x) => x.key === c.key)?.score ?? null,
      head: hr?.categories.find((x) => x.key === c.key)?.score ?? null,
    }));

    let findings: SubmissionComparison['findings'] = null;
    if (br && hr) {
      const status = new Map(hr.priorFindings.map((p) => [p.previousFindingId, p]));
      const continued = new Set(hr.findings.map((f) => f.previousFindingId).filter(Boolean) as string[]);
      const viaAi = br.findings.some((f) => status.has(f.id) || continued.has(f.id));
      const resolved: { id: string; title: string; note: string }[] = [];
      const remaining: { id: string; title: string; note: string }[] = [];
      const unclear: { id: string; title: string; note: string }[] = [];
      const matchedHead = new Set<string>();
      for (const f of br.findings) {
        if (viaAi) {
          const s = status.get(f.id);
          const cont = hr.findings.find((h) => h.previousFindingId === f.id);
          if (cont) matchedHead.add(cont.id);
          if (s?.status === 'resolved' && !cont) resolved.push({ id: f.id, title: f.title, note: s.note });
          else if (s?.status === 'remaining' || cont) remaining.push({ id: f.id, title: f.title, note: s?.note ?? 'Reported again in the new review.' });
          else unclear.push({ id: f.id, title: f.title, note: s?.note ?? 'Not assessed by the new review.' });
        } else {
          const match = hr.findings.find((h) => !matchedHead.has(h.id) && h.category === f.category && titleSimilarity(h.title, f.title) >= 0.5);
          if (match) {
            matchedHead.add(match.id);
            remaining.push({ id: f.id, title: f.title, note: 'Heuristic match by category and title.' });
          } else unclear.push({ id: f.id, title: f.title, note: 'No similar finding in the new review (heuristic; may be resolved).' });
        }
      }
      if (!viaAi) notes.push('Finding status is a heuristic title match because the newer review was not given these findings.');
      findings = {
        resolved,
        remaining,
        unclear,
        new: hr.findings.filter((h) => !matchedHead.has(h.id) && !h.previousFindingId).map((h) => ({ id: h.id, title: h.title, severity: h.severity })),
      };
    }
    const designChanges: SubmissionComparison['designChanges'] = [];
    const bd = br?.designAssessment;
    const hd = hr?.designAssessment;
    if (bd && hd) {
      for (const x of hd.solid) {
        const prev = bd.solid.find((y) => y.principle === x.principle);
        if (prev && prev.verdict !== x.verdict) designChanges.push({ area: 'SOLID', item: SOLID_LABELS[x.principle], base: prev.verdict, head: x.verdict });
      }
      for (const x of hd.principles) {
        const prev = bd.principles.find((y) => y.principle === x.principle);
        if (prev && prev.verdict !== x.verdict) designChanges.push({ area: 'Principle', item: DESIGN_PRINCIPLE_LABELS[x.principle], base: prev.verdict, head: x.verdict });
      }
      if (bd.atomicity.verdict !== hd.atomicity.verdict) designChanges.push({ area: 'Atomicity', item: 'Multi-step operations', base: bd.atomicity.verdict, head: hd.atomicity.verdict });
    } else if (br && hr) notes.push('Design verdicts can only be compared when both reviews include a design assessment (review.v2 or later).');
    return { base: this.summary(base), head: this.summary(head), comparable, notes, files, categoryDeltas, totalDelta, designChanges, findings };
  }

  /** Marks builds left running by a previous server process. */
  recoverInterrupted(): void {
    this.db.prepare(`UPDATE submissions SET build_state = 'interrupted' WHERE build_state IN ('pending','running')`).run();
    this.db.prepare(`UPDATE exec_runs SET state = 'interrupted', finished_at = ?, pid = NULL WHERE state = 'running'`).run(now());
  }

  publish(id: string): void {
    try {
      this.bus.publish({ type: 'submission', submission: this.summary(this.row(id)) });
    } catch {
      /* deleted */
    }
  }

  findingsFor(review: StoredReview): StoredFinding[] {
    return review.findings;
  }
}

/** Plain-text execution evidence for the reviewer: only what the runner actually recorded. */
export function executionEvidence(run: ExecRun | null, buildState: string): string {
  if (!run) {
    return buildState === 'failed'
      ? 'The application could not build this snapshot (toolchain unavailable). No compilation or tests ran. Do not claim anything about runtime behaviour beyond code inspection.'
      : 'No build was recorded for this snapshot. No tests ran.';
  }
  const lines: string[] = [];
  const compileFailed = run.phase === 'compile' && run.state !== 'succeeded';
  if (run.state === 'timed-out') lines.push(`Build/test run TIMED OUT after ${Math.round((run.durationMs ?? 0) / 1000)}s (possible infinite loop or deadlock).`);
  if (run.state === 'cancelled' || run.state === 'interrupted') lines.push(`Build/test run was ${run.state}; results are incomplete.`);
  lines.push(`Compilation (Maven, javac): ${compileFailed ? 'FAILED' : run.state === 'timed-out' && !run.tests ? 'UNKNOWN' : 'PASSED'}`);
  const diags = run.diagnostics.slice(0, 40);
  if (diags.length) {
    lines.push('Compiler diagnostics:');
    for (const d of diags) lines.push(`- ${d.severity.toUpperCase()} ${d.file ?? '(build)'}${d.line ? `:${d.line}:${d.column}` : ''} ${d.message.replace(/\n/g, ' ')}`);
    if (run.diagnostics.length > diags.length) lines.push(`- … ${run.diagnostics.length - diags.length} more`);
  }
  if (compileFailed) {
    lines.push('Tests: NOT RUN because compilation failed.');
  } else if (run.tests && run.tests.total > 0) {
    const t = run.tests;
    lines.push(`Tests (written by the candidate) RAN: ${t.passed} passed, ${t.failed} failed, ${t.errored} errored, ${t.skipped} skipped.`);
    for (const c of t.cases.slice(0, 80)) {
      lines.push(`- ${c.status.toUpperCase()} ${c.className}.${c.name}${c.message ? ` — ${c.message.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
    }
  } else {
    lines.push('Tests: none found or none ran.');
  }
  return lines.join('\n');
}

function lockTree(dir: string): void {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      lockTree(p);
      chmodSync(p, 0o555);
    } else chmodSync(p, 0o444);
  }
  chmodSync(dir, 0o555);
}

function makeWritable(dir: string): void {
  chmodSync(dir, 0o755);
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) makeWritable(p);
    else chmodSync(p, n === 'mvnw' ? 0o755 : 0o644);
  }
}

export function snapshotExists(dataRoot: string, id: string): boolean {
  return existsSync(join(dataRoot, 'submissions', id, 'source'));
}

/**
 * The previous review's findings for the next review. Findings the candidate ticked "I fixed this"
 * are flagged as claims to verify; the reviewer's priorFindings verdict stays authoritative.
 */
function previousReviewText(prev: { seq: number; review: StoredReview }, fixed: Set<string>): string {
  const lines = prev.review.findings.map(
    (f) =>
      `- ${f.id} [${f.severity}/${f.category}] ${f.title}${f.filePath ? ` (${f.filePath}${f.lineStart ? `:${f.lineStart}` : ''})` : ''}${
        fixed.has(f.id) ? ' — the candidate marked this as fixed; verify it in the code (your priorFindings status decides)' : ''
      }`,
  );
  return [
    `## PREVIOUS REVIEW (submission #${prev.seq}, score ${prev.review.totalScore}/100)`,
    'Report the status of each previous finding in priorFindings.',
    ...(fixed.size ? [`The candidate marked ${fixed.size} finding(s) as fixed. Treat that as a claim, not evidence.`] : []),
    ...lines,
  ].join('\n');
}
