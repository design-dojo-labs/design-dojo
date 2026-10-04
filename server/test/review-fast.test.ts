import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EMPTY_HLD_DOCUMENT, parsePartialJson, type HldDocument, type ServerEvent, type Settings } from '@lld/shared';
import { JobFailure } from '../src/jobs.js';
import { MockAdapter } from '../src/providers/mock.js';
import type { StructuredRequest, StructuredResult } from '../src/providers/types.js';
import { ClaudeAdapter } from '../src/providers/claude.js';
import { SecretStore } from '../src/secrets.js';
import { DEFAULT_SETTINGS } from '@lld/shared';
import { readFileSync } from 'node:fs';
import { FAKE_CLAUDE, SHARED_MAVEN, tempDir, testApp, waitForJob } from './helpers.js';

const ROOT = resolve(__dirname, '..', '..');

/** Mock reviewer whose detail passes can be made to fail, to test that the score survives. */
class FlakyDetailMock extends MockAdapter {
  failDetail = false;
  tasks: { task: string; model: string | null | undefined; effort: string | undefined }[] = [];
  override async runStructured(settings: Settings, req: StructuredRequest): Promise<StructuredResult> {
    this.tasks.push({ task: req.task, model: req.model, effort: req.effort });
    if (this.failDetail && req.task.endsWith('review-detail')) {
      await new Promise((r) => setTimeout(r, 30));
      throw new JobFailure('nonzero-exit', 'detail pass exploded');
    }
    return super.runStructured(settings, req);
  }
}

const seeds = tempDir('lld-fast-seeds-');
const hldProblem = {
  id: 'tiny-shortener',
  title: 'Tiny URL Shortener',
  summary: 'Shorten links and redirect quickly.',
  difficulty: 'easy',
  targets: ['beginner', 'sde1'],
  domain: 'infrastructure',
  estimatedMinutes: 40,
  statement: 'Users paste a long link and get a short one. Visiting the short link redirects to the original.',
  scaleHints: ['100M new links per month', 'Read:write ratio 100:1'],
  constraints: ['Redirect p99 under 50 ms'],
  outOfScope: ['Analytics dashboards'],
  evaluationGuide: {
    keyFunctionalRequirements: ['Create short link', 'Redirect', 'Optional custom alias'],
    keyNonFunctionalRequirements: ['Low latency reads', 'High availability', 'Unique codes'],
    coreEntities: ['Link(code, longUrl, createdAt)', 'User'],
    keyComponents: ['Write service', 'Redirect service', 'Key-value store'],
    deepDiveTopics: ['Code generation', 'Hot links'],
    commonPitfalls: ['Collisions', 'No expiry policy'],
  },
};
const doc: HldDocument = {
  ...EMPTY_HLD_DOCUMENT,
  functional: [{ id: 'f1', text: 'Create a short link' }],
  apis: [{ id: 'a1', method: 'POST', path: '/links', description: 'create', request: '{url}', response: '{code}' }],
  diagram: {
    elements: [
      { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
      { id: 't1', type: 'text', x: 5, y: 5, width: 50, height: 20, text: 'Redirect service', originalText: 'Redirect service', containerId: 'r1' },
    ],
  },
};

let t: Awaited<ReturnType<typeof testApp>>;
const mock = new FlakyDetailMock();
const events: ServerEvent[] = [];
beforeAll(async () => {
  mkdirSync(seeds.dir, { recursive: true });
  writeFileSync(join(seeds.dir, 'tiny-shortener.json'), JSON.stringify(hldProblem));
  process.env.LLD_STUDIO_MAVEN_HOME = SHARED_MAVEN;
  process.env.LLD_MOCK_DELAY_MS = '20';
  t = await testApp({
    providerOverrides: { mock },
    config: {
      resources: {
        seedProblems: join(ROOT, 'problems', 'seed'),
        hldSeedProblems: seeds.dir,
        javaTemplate: join(ROOT, 'java-template'),
        prompts: join(ROOT, 'prompts'),
        webDist: join(ROOT, 'web', 'dist'),
      },
    },
  });
  t.ctx.settings.update({ provider: 'mock' });
  t.ctx.bus.subscribe((e) => events.push(e));
});
afterAll(async () => {
  await t?.dispose();
  seeds.cleanup();
});

function hldSubmit() {
  const s = t.ctx.hld.createSession({ problemId: 'tiny-shortener', mode: 'practice', durationMinutes: null });
  t.ctx.hld.saveDoc(s.id, doc, s.docHash);
  return t.ctx.hld.submit(s.id);
}

describe('fast review mode (HLD)', () => {
  it('stores the score first, streams partial output, then merges the section feedback', async () => {
    mock.failDetail = false;
    events.length = 0;
    const res = hldSubmit();
    const job = await waitForJob(t.ctx, res.job!.id);
    expect(job.state).toBe('completed');
    const sub = t.ctx.hld.getSubmission(res.submission.id);
    const r = sub.review!;
    expect(r.reviewMode).toBe('fast');
    expect(r.promptVersion).toBe('hld-review.v2-score');
    expect(r.detail?.status).toBe('completed');
    expect(r.sections.architecture.feedback).toContain('MOCK');
    expect(r.followUpQuestions.length).toBeGreaterThan(0);
    expect(r.totalScore).toBe(r.categories.reduce((a, c) => a + c.score, 0));
    const partials = events.filter((e): e is Extract<ServerEvent, { type: 'job-partial' }> => e.type === 'job-partial' && e.jobId === job.id);
    expect(new Set(partials.map((p) => p.phase))).toEqual(new Set(['score', 'detail']));
    expect(partials.every((p) => p.submissionId === res.submission.id)).toBe(true);
  });

  it('keeps the score when the detail pass fails, then retries only the detail', async () => {
    mock.failDetail = true;
    const res = hldSubmit();
    const job = await waitForJob(t.ctx, res.job!.id);
    expect(job.state).toBe('completed');
    const failed = t.ctx.hld.getSubmission(res.submission.id).review!;
    expect(failed.totalScore).toBeGreaterThan(0);
    expect(failed.detail).toMatchObject({ status: 'failed', error: { code: 'nonzero-exit' } });
    expect(failed.sections.api.feedback).toBe('');

    mock.failDetail = false;
    const retry = t.ctx.hld.startDetailRetry(res.submission.id);
    expect(retry.kind).toBe('hld-review-detail');
    expect((await waitForJob(t.ctx, retry.id)).state).toBe('completed');
    const fixed = t.ctx.hld.getSubmission(res.submission.id).review!;
    expect(fixed.id).toBe(failed.id);
    expect(fixed.totalScore).toBe(failed.totalScore);
    expect(fixed.detail?.status).toBe('completed');
    expect(fixed.sections.api.feedback).toContain('MOCK');
    expect(() => t.ctx.hld.startDetailRetry(res.submission.id)).toThrow(/already complete/);
  });

  it('full mode makes one combined call', async () => {
    t.ctx.settings.update({ review: { mode: 'full' } });
    try {
      const res = hldSubmit();
      expect((await waitForJob(t.ctx, res.job!.id)).state).toBe('completed');
      const r = t.ctx.hld.getSubmission(res.submission.id).review!;
      expect(r.reviewMode).toBe('full');
      expect(r.promptVersion).toBe('hld-review.v1');
      expect(r.detail).toBeUndefined();
    } finally {
      t.ctx.settings.update({ review: { mode: 'fast' } });
    }
  });
});

describe('fast review mode (LLD)', () => {
  it('scores, survives a failed detail pass and retries it without changing the score', async () => {
    mock.failDetail = true;
    const session = t.ctx.sessions.create({ problemId: 'parking-lot', mode: 'practice', durationMinutes: null });
    const res = t.ctx.submissions.submit(session.id);
    expect((await waitForJob(t.ctx, res.job!.id, 180_000)).state).toBe('completed');
    const failed = t.ctx.submissions.get(res.submission.id).review!;
    expect(failed.reviewMode).toBe('fast');
    expect(failed.promptVersion).toBe('review.v3-score');
    expect(failed.detail).toMatchObject({ status: 'failed' });
    expect(failed.designAssessment).toBeUndefined();
    expect(failed.findings.length).toBeGreaterThan(0);

    mock.failDetail = false;
    const retry = t.ctx.submissions.startDetailRetry(res.submission.id);
    expect((await waitForJob(t.ctx, retry.id)).state).toBe('completed');
    const fixed = t.ctx.submissions.get(res.submission.id).review!;
    expect(fixed.totalScore).toBe(failed.totalScore);
    expect(fixed.detail?.status).toBe('completed');
    expect(fixed.designAssessment?.solid).toHaveLength(5);
    expect(fixed.followUpQuestions.length).toBeGreaterThan(0);
  }, 240_000);
});

describe('per-task models and effort', () => {
  it('routes detail and assist tasks to their own model, falling back to the review model', () => {
    t.ctx.settings.update({ claude: { model: 'opus', detailModel: 'sonnet', assistModel: '', effort: 'high', assistEffort: 'low' } });
    expect(t.ctx.providers.modelFor('claude', 'review-score')).toEqual({ model: 'opus', effort: 'high' });
    expect(t.ctx.providers.modelFor('claude', 'review-detail')).toEqual({ model: 'sonnet', effort: 'high' });
    expect(t.ctx.providers.modelFor('claude', 'hint')).toEqual({ model: 'opus', effort: 'low' });
    t.ctx.settings.update({ claude: { model: '', detailModel: '', assistModel: 'haiku', effort: 'default' } });
    expect(t.ctx.providers.modelFor('claude', 'review')).toEqual({ model: null, effort: 'default' });
    expect(t.ctx.providers.modelFor('claude', 'chat')).toEqual({ model: 'haiku', effort: 'low' });
  });
});

describe('parsePartialJson', () => {
  const full = JSON.stringify({ summary: 'He said "hi"\nthen left \\ ok', categories: [{ key: 'a', score: 12 }, { key: 'b', score: 3 }], ok: true, none: null });
  it('parses every prefix without throwing and returns the full value at the end', () => {
    for (let i = 0; i <= full.length; i++) expect(() => parsePartialJson(full.slice(0, i))).not.toThrow();
    expect(parsePartialJson(full)).toEqual(JSON.parse(full));
  });
  it('keeps a string value that is still streaming and drops incomplete keys and numbers', () => {
    expect(parsePartialJson('{"summary":"Half a sen')).toEqual({ summary: 'Half a sen' });
    expect(parsePartialJson('{"a":1,"b":12')).toEqual({ a: 1 });
    expect(parsePartialJson('{"a":1,"cat')).toEqual({ a: 1 });
    expect(parsePartialJson('{"list":[{"k":"x"},{"k":"y')).toEqual({ list: [{ k: 'x' }, { k: 'y' }] });
    expect(parsePartialJson('{"s":"ends with escape\\')).toEqual({ s: 'ends with escape' });
    expect(parsePartialJson('')).toBeUndefined();
  });
});

describe('Claude adapter streaming and per-request options', () => {
  it('passes model and effort, and reports the structured answer as it streams', async () => {
    const dir = tempDir();
    const record = join(dir.dir, 'record.json');
    const outFile = join(dir.dir, 'out.json');
    const answer = { summary: 'streamed summary', items: [1, 2, 3], note: 'x'.repeat(60) };
    writeFileSync(outFile, JSON.stringify(answer));
    const env = { ...process.env };
    process.env.FAKE_SCENARIO = 'partial';
    process.env.FAKE_RECORD = record;
    process.env.FAKE_OUTPUT_FILE = outFile;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const partials: string[] = [];
      const res = await new ClaudeAdapter(new SecretStore(dir.dir)).runStructured(
        { ...DEFAULT_SETTINGS, claude: { ...DEFAULT_SETTINGS.claude, executablePath: FAKE_CLAUDE, model: 'opus' } },
        {
          task: 'review-score',
          prompt: 'P',
          schema: { type: 'object' },
          timeoutMs: 20_000,
          workDir: dir.dir,
          signal: new AbortController().signal,
          onProgress: () => {},
          model: 'sonnet',
          effort: 'low',
          onPartial: (p) => partials.push(p),
        },
      );
      expect(res.output).toEqual(answer);
      const args: string[] = JSON.parse(readFileSync(record, 'utf8')).args;
      expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'sonnet']);
      expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'low']);
      expect(args).toContain('--include-partial-messages');
      expect(partials.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < partials.length; i++) expect(partials[i].startsWith(partials[i - 1])).toBe(true);
      expect(JSON.parse(partials[partials.length - 1])).toEqual(answer);
      expect(parsePartialJson(partials[0])).toBeTypeOf('object');
    } finally {
      process.env = env;
      dir.cleanup();
    }
  }, 30_000);
});
