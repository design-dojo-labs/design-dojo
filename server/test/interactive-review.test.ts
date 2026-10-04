import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EMPTY_HLD_DOCUMENT, type HldDocument, type ServerEvent, type Settings } from '@lld/shared';
import { MockAdapter } from '../src/providers/mock.js';
import type { StructuredRequest, StructuredResult } from '../src/providers/types.js';
import { fixIssues, interactiveFor, interviewIssues } from '../src/interactive.js';
import { authHeaders, SHARED_MAVEN, tempDir, testApp, waitForJob } from './helpers.js';

const ROOT = resolve(__dirname, '..', '..');

/** Mock reviewer that records every prompt and can be given a canned fix answer. */
class RecordingMock extends MockAdapter {
  prompts: { task: string; prompt: string }[] = [];
  fixOutput: unknown = null;
  override async runStructured(settings: Settings, req: StructuredRequest): Promise<StructuredResult> {
    this.prompts.push({ task: req.task, prompt: req.prompt });
    if (req.task === 'fix-suggestion' && this.fixOutput) {
      return { output: this.fixOutput, model: 'mock', usage: null, durationMs: 0, rawFinal: JSON.stringify(this.fixOutput), eventCount: 1 };
    }
    return super.runStructured(settings, req);
  }
  last(task: string): string {
    return [...this.prompts].reverse().find((p) => p.task === task)?.prompt ?? '';
  }
}

const seeds = tempDir('lld-interactive-seeds-');
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

let t: Awaited<ReturnType<typeof testApp>>;
const mock = new RecordingMock();
const events: ServerEvent[] = [];
beforeAll(async () => {
  mkdirSync(seeds.dir, { recursive: true });
  writeFileSync(join(seeds.dir, 'tiny-shortener.json'), JSON.stringify(hldProblem));
  process.env.LLD_STUDIO_MAVEN_HOME = SHARED_MAVEN;
  process.env.LLD_MOCK_DELAY_MS = '10';
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

async function reviewedLld(mode: 'practice' | 'interview' = 'practice') {
  const session = t.ctx.sessions.create({ problemId: 'parking-lot', mode, durationMinutes: mode === 'interview' ? 45 : null });
  const res = t.ctx.submissions.submit(session.id);
  expect((await waitForJob(t.ctx, res.job!.id, 180_000)).state).toBe('completed');
  const sub = t.ctx.submissions.get(res.submission.id);
  expect(sub.review?.detail?.status ?? 'completed').toBe('completed');
  return { session, sub, finding: sub.review!.findings[0] };
}

describe('follow-up chat (LLD)', () => {
  it('answers questions in a thread, streams the answer and carries the conversation forward', async () => {
    const svc = interactiveFor(t.ctx);
    const { sub, finding } = await reviewedLld();
    events.length = 0;
    const first = svc.ask('lld', sub.id, { itemKey: finding.id, message: 'Why is this a problem?' });
    expect(first.thread.messages.map((m) => m.role)).toEqual(['user']);
    expect(() => svc.ask('lld', sub.id, { itemKey: finding.id, message: 'again' })).toThrow(/still being written/);
    expect((await waitForJob(t.ctx, first.job.id)).state).toBe('completed');
    expect(events.some((e) => e.type === 'job-partial' && e.jobId === first.job.id && e.phase === 'answer')).toBe(true);
    expect(mock.last('chat')).toContain(finding.title);
    expect(mock.last('chat')).toContain('Why is this a problem?');

    const second = svc.ask('lld', sub.id, { itemKey: finding.id, message: 'How would you test it?' });
    expect((await waitForJob(t.ctx, second.job.id)).state).toBe('completed');
    // The earlier exchange is in the conversation section of the new prompt.
    expect(mock.last('chat')).toMatch(/<conversation>[\s\S]*Why is this a problem\?[\s\S]*MOCK answer[\s\S]*<\/conversation>/);
    const thread = svc.state('lld', sub.id).threads.find((x) => x.itemKey === finding.id)!;
    expect(thread.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(thread.messages[1].isMock).toBe(true);
    expect(() => svc.ask('lld', sub.id, { itemKey: finding.id, message: '' })).toThrow(/Type a question/);
    expect(() => svc.ask('lld', sub.id, { itemKey: 'nope', message: 'x' })).toThrow(/No finding/);
  }, 240_000);

  it('is disabled (with fix suggestions) in interview-mode sessions', async () => {
    const svc = interactiveFor(t.ctx);
    const { sub, finding } = await reviewedLld('interview');
    expect(svc.state('lld', sub.id).interviewMode).toBe(true);
    expect(() => svc.ask('lld', sub.id, { itemKey: finding.id, message: 'hi' })).toThrow(/interview mode/);
    expect(() => svc.suggestFix(sub.id, finding.id)).toThrow(/interview mode/);
    // The mock interviewer still works in interview mode.
    expect(svc.startInterview('lld', sub.id).state).toBe('active');
  }, 240_000);
});

describe('fix suggestions (LLD)', () => {
  it('proposes edits limited to the cited file and keeps the snapshot original for the diff', async () => {
    const svc = interactiveFor(t.ctx);
    const { sub, finding } = await reviewedLld();
    expect(finding.filePath).toBeTruthy();
    const job = svc.suggestFix(sub.id, finding.id);
    expect(svc.state('lld', sub.id).pendingFixes[finding.id]).toBe(job.id);
    expect((await waitForJob(t.ctx, job.id)).state).toBe('completed');
    const fix = svc.state('lld', sub.id).fixes.find((f) => f.findingId === finding.id)!;
    expect(fix.edits).toHaveLength(1);
    expect(fix.edits[0].path).toBe(finding.filePath);
    expect(fix.edits[0].originalContent).toBe(t.ctx.submissions.readFile(sub.id, finding.filePath!).content);
    expect(fix.edits[0].newContent).toContain('MOCK fix suggestion');

    // An answer that edits build files is rejected (after the single correction round), never stored.
    mock.fixOutput = { explanation: 'Edits the build.', edits: [{ path: 'pom.xml', newContent: '<project/>' }] };
    try {
      const bad = svc.suggestFix(sub.id, finding.id);
      const done = await waitForJob(t.ctx, bad.id);
      expect(done.state).toBe('failed');
      expect(done.error?.code).toBe('validation-failed');
    } finally {
      mock.fixOutput = null;
    }
    expect(svc.state('lld', sub.id).fixes.find((f) => f.findingId === finding.id)!.id).toBe(fix.id);
  }, 240_000);

  it('applying needs the current working-copy hash (stale hash → 409)', async () => {
    const { session, sub, finding } = await reviewedLld();
    const ws = t.ctx.sessions.workspace(session.id);
    const snapHash = ws.read(finding.filePath!).hash;
    const cur = ws.read(finding.filePath!);
    await ws.write(finding.filePath!, cur.content + '\n// edited after submitting\n', cur.hash);
    const put = (baseHash: string) =>
      t.app.inject({ method: 'PUT', url: `/api/sessions/${session.id}/file`, headers: authHeaders(t.ctx.csrfToken), payload: { path: finding.filePath, content: 'applied', baseHash } });
    expect((await put(snapHash)).statusCode).toBe(409);
    expect((await put(ws.read(finding.filePath!).hash)).statusCode).toBe(200);
    void sub;
  }, 240_000);

  it('enforces the edit rules', () => {
    const snap = new Map([
      ['src/main/java/a/A.java', 'class A {}'],
      ['src/main/java/a/B.java', 'class B {}'],
      ['src/main/java/a/C.java', 'class C {}'],
      ['pom.xml', '<project/>'],
    ]);
    const ok = { explanation: 'x', edits: [{ path: 'src/main/java/a/A.java', newContent: 'class A { int x; }' }, { path: 'src/test/java/a/ATest.java', newContent: 'class ATest {}' }] };
    expect(fixIssues(ok, snap, 'src/main/java/a/A.java')).toEqual([]);
    const twoOthers = { explanation: 'x', edits: [{ path: 'src/main/java/a/B.java', newContent: 'class B { }' }, { path: 'src/main/java/a/C.java', newContent: 'class C { }' }] };
    expect(fixIssues(twoOthers, snap, 'src/main/java/a/A.java').join()).toMatch(/at most one existing file/);
    expect(fixIssues({ explanation: 'x', edits: [{ path: 'pom.xml', newContent: '<p/>' }] }, snap, null).join()).toMatch(/must not be edited/);
    expect(fixIssues({ explanation: 'x', edits: [{ path: 'src/main/java/a/New.java', newContent: 'class N {}' }] }, snap, null).join()).toMatch(/only allowed as tests/);
    expect(fixIssues({ explanation: 'x', edits: [{ path: '../evil.java', newContent: 'x' }] }, snap, null).join()).toMatch(/not a valid relative path/);
    expect(fixIssues({ explanation: 'x', edits: [{ path: 'src/main/java/a/A.java', newContent: 'class A {}' }] }, snap, 'src/main/java/a/A.java').join()).toMatch(/unchanged/);
  });
});

describe('resolved marks', () => {
  it('reach the next review prompt as claims to verify', async () => {
    const svc = interactiveFor(t.ctx);
    const { session, sub, finding } = await reviewedLld();
    expect(svc.mark('lld', sub.id, { itemKey: finding.id, resolved: true })).toEqual({ [finding.id]: true });
    expect(() => svc.mark('lld', sub.id, { itemKey: 'nope', resolved: true })).toThrow(/No finding/);
    const ws = t.ctx.sessions.workspace(session.id);
    const cur = ws.read(finding.filePath!);
    await ws.write(finding.filePath!, cur.content + '\n// fixed\n', cur.hash);
    const next = t.ctx.submissions.submit(session.id);
    expect(next.duplicate).toBe(false);
    expect((await waitForJob(t.ctx, next.job!.id, 180_000)).state).toBe('completed');
    const prompt = mock.last('review-score');
    expect(prompt).toContain(`${finding.id} [`);
    expect(prompt).toMatch(new RegExp(`${finding.id}[^\\n]*candidate marked this as fixed`));
    expect(prompt).toContain('Treat that as a claim, not evidence');
    // Unmarking removes the claim.
    expect(svc.mark('lld', sub.id, { itemKey: finding.id, resolved: false })[finding.id]).toBe(false);
  }, 300_000);
});

describe('mock interviewer', () => {
  it('asks the follow-up questions, judges answers and ends with a summary', async () => {
    const svc = interactiveFor(t.ctx);
    const { sub } = await reviewedLld();
    const iv = svc.startInterview('lld', sub.id);
    expect(iv.currentQuestion).toBe(sub.review!.followUpQuestions[0]);
    expect(svc.startInterview('lld', sub.id).id).toBe(iv.id); // resumes the active round
    const { job } = svc.answerInterview(iv.id, 'I would use a strategy for pricing.');
    expect(() => svc.answerInterview(iv.id, 'again')).toThrow(/still responding/);
    expect((await waitForJob(t.ctx, job.id)).state).toBe('completed');
    const after = svc.state('lld', sub.id).interview!;
    expect(after.turns).toHaveLength(1);
    expect(after.turns[0]).toMatchObject({ answer: 'I would use a strategy for pricing.', score: 'ok' });
    expect(after.state).toBe('ended'); // the mock review has one question
    expect(after.summary).toBe('MOCK summary of the round.');
    expect(mock.last('interview')).toContain('I would use a strategy for pricing.');
    expect(() => svc.answerInterview(iv.id, 'late')).toThrow(/ended/);
    const restarted = svc.startInterview('lld', sub.id, true);
    expect(restarted.id).not.toBe(iv.id);
    expect(svc.endInterview(restarted.id)).toMatchObject({ state: 'ended', summary: 'Ended before any answer was given.' });
  }, 240_000);

  it('keeps the interviewer consistent with the tracked question list', () => {
    const base = { feedback: 'f', score: 'ok' as const, summary: null };
    expect(interviewIssues({ ...base, nextKind: 'listed', nextQuestion: 'Q2', done: false }, 1, false, false)).toEqual([]);
    expect(interviewIssues({ ...base, nextKind: 'listed', nextQuestion: 'Q2', done: false }, 0, false, false).join()).toMatch(/no listed questions remain/);
    expect(interviewIssues({ ...base, nextKind: 'follow-up', nextQuestion: 'Why?', done: false }, 1, true, false).join()).toMatch(/already a follow-up/);
    expect(interviewIssues({ ...base, nextKind: 'none', nextQuestion: null, done: true, summary: 's' }, 2, false, false).join()).toMatch(/remain/);
    expect(interviewIssues({ ...base, nextKind: 'none', nextQuestion: null, done: true, summary: 's' }, 2, false, true)).toEqual([]);
    expect(interviewIssues({ ...base, nextKind: 'none', nextQuestion: null, done: false }, 0, false, false).join()).toMatch(/done must be true/);
  });
});

describe('HLD improvements', () => {
  it('supports chat, marks and the interviewer on improvements', async () => {
    const svc = interactiveFor(t.ctx);
    const s = t.ctx.hld.createSession({ problemId: 'tiny-shortener', mode: 'practice', durationMinutes: null });
    const doc: HldDocument = {
      ...EMPTY_HLD_DOCUMENT,
      functional: [{ id: 'f1', text: 'Create a short link' }],
      diagram: {
        elements: [
          { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
          { id: 't1', type: 'text', x: 5, y: 5, width: 50, height: 20, text: 'Redirect service', originalText: 'Redirect service', containerId: 'r1' },
        ],
      },
    };
    t.ctx.hld.saveDoc(s.id, doc, s.docHash);
    const res = t.ctx.hld.submit(s.id);
    expect((await waitForJob(t.ctx, res.job!.id)).state).toBe('completed');
    const asked = svc.ask('hld', res.submission.id, { itemKey: 'improvement:0', message: 'Which component would you add?' });
    expect((await waitForJob(t.ctx, asked.job.id)).state).toBe('completed');
    expect(mock.last('chat')).toContain('Redirect service');
    const st = svc.state('hld', res.submission.id);
    expect(st.threads[0].messages).toHaveLength(2);
    expect(svc.mark('hld', res.submission.id, { itemKey: 'improvement:0', resolved: true })).toEqual({ 'improvement:0': true });
    expect(() => svc.ask('hld', res.submission.id, { itemKey: 'improvement:9', message: 'x' })).toThrow(/No improvement/);
    const iv = svc.startInterview('hld', res.submission.id);
    expect(iv.track).toBe('hld');
    const r = await t.app.inject({ method: 'GET', url: `/api/hld/submissions/${res.submission.id}/interactive`, headers: { host: '127.0.0.1:4399' } });
    expect(r.json()).toMatchObject({ track: 'hld', marks: { 'improvement:0': true }, interview: { id: iv.id } });
  });
});
