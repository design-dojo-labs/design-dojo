import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EMPTY_HLD_DOCUMENT, type HldDocument } from '@lld/shared';
import { testApp, tempDir, waitForJob } from './helpers.js';

const ROOT = resolve(__dirname, '..', '..');
const seeds = tempDir('lld-hld-seeds-');
const problem = {
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

let t: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  mkdirSync(seeds.dir, { recursive: true });
  writeFileSync(join(seeds.dir, 'tiny-shortener.json'), JSON.stringify(problem));
  process.env.LLD_MOCK_DELAY_MS = '20';
  t = await testApp({
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
});
afterAll(async () => {
  await t?.dispose();
  seeds.cleanup();
});

describe('HLD practice', () => {
  it('serves problems without the evaluation guide until something is submitted', async () => {
    const s = t.ctx.hld.createSession({ problemId: 'tiny-shortener', mode: 'practice', durationMinutes: 45 });
    expect(s.problem.evaluationGuide).toBeNull();
    expect(s.problem.rubric.categories.reduce((a, c) => a + c.max, 0)).toBe(100);
    const res = await t.app.inject({ method: 'GET', url: `/api/hld/problems/tiny-shortener`, headers: { host: '127.0.0.1:4399' } });
    expect(res.body).not.toContain('Key-value store');
  });

  it('rejects stale document saves and reviews an immutable snapshot with verified component references', async () => {
    const s = t.ctx.hld.createSession({ problemId: 'tiny-shortener', mode: 'practice', durationMinutes: null });
    const doc: HldDocument = {
      ...EMPTY_HLD_DOCUMENT,
      functional: [{ id: 'f1', text: 'Create a short link' }],
      apis: [{ id: 'a1', method: 'POST', path: '/links', description: 'create', request: '{url}', response: '{code}' }],
      diagram: {
        elements: [
          { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, backgroundColor: '#a5d8ff' },
          { id: 't1', type: 'text', x: 5, y: 5, width: 50, height: 20, text: 'Redirect service', originalText: 'Redirect service', containerId: 'r1' },
          { id: 'r2', type: 'rectangle', x: 300, y: 0, width: 100, height: 60 },
          { id: 't2', type: 'text', x: 305, y: 5, width: 50, height: 20, text: 'Links KV', originalText: 'Links KV', containerId: 'r2' },
          { id: 'a', type: 'arrow', x: 100, y: 30, width: 200, height: 0, points: [[0, 0], [200, 0]], startBinding: { elementId: 'r1' }, endBinding: { elementId: 'r2' }, endArrowhead: 'arrow' },
        ],
      },
    };
    const saved = t.ctx.hld.saveDoc(s.id, doc, s.docHash);
    expect(() => t.ctx.hld.saveDoc(s.id, { ...doc, notes: 'stale' }, s.docHash)).toThrow(/changed elsewhere/);

    const res = t.ctx.hld.submit(s.id);
    expect(res.submission.graph.connections).toEqual([{ from: 'C1', to: 'C2', label: null, directed: true, inferred: false }]);
    const job = await waitForJob(t.ctx, res.job!.id);
    expect(job.state).toBe('completed');
    const sub = t.ctx.hld.getSubmission(res.submission.id);
    expect(sub.review?.totalScore).toBe(sub.review!.categories.reduce((a, c) => a + c.score, 0));
    expect(sub.review?.improvements[0].componentRefs).toEqual([
      { label: 'Redirect service', matched: 'Redirect service' },
      { label: 'Nonexistent component', matched: null },
    ]);
    // Later edits do not change the submitted snapshot; a repeat submit with no changes is not duplicated.
    t.ctx.hld.saveDoc(s.id, { ...doc, notes: 'after submit' }, saved.hash);
    expect(t.ctx.hld.submissionDoc(sub.id).notes).toBe('');
    const again = t.ctx.hld.submit(s.id);
    expect(again.duplicate).toBe(false);
    await waitForJob(t.ctx, again.job!.id);
    expect(t.ctx.hld.submit(s.id).duplicate).toBe(true);
    // After submitting, the evaluation guide is revealed.
    expect(t.ctx.hld.getSession(s.id).problem.evaluationGuide?.keyComponents).toContain('Key-value store');
  });

  it('generates a validated HLD problem through the provider', async () => {
    const job = t.ctx.hld.generate({ difficulty: 'medium', target: 'sde2' });
    const done = await waitForJob(t.ctx, job.id);
    expect(done.state).toBe('completed');
    const id = (done.result as { problemId: string }).problemId;
    expect(t.ctx.hld.getPublic(id).content.difficulty).toBe('medium');
  });
});
