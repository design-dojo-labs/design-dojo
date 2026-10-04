import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROBLEM_THEME_MAX_LENGTH, type Settings } from '@lld/shared';
import { MockAdapter } from '../src/providers/mock.js';
import type { StructuredRequest, StructuredResult } from '../src/providers/types.js';
import { authHeaders, testApp, waitForJob } from './helpers.js';

// Return existing seed content deliberately: custom requests may revisit a familiar subject.
class GenerationFixture extends MockAdapter {
  requests: StructuredRequest[] = [];
  output: Record<string, unknown>;
  firstOutput?: Record<string, unknown>;

  constructor(seed: string) {
    super();
    const { id: _id, ...content } = JSON.parse(readFileSync(resolve(__dirname, '../../problems', seed), 'utf8'));
    this.output = content;
  }

  override async runStructured(_settings: Settings, req: StructuredRequest): Promise<StructuredResult> {
    this.requests.push(req);
    const output = this.requests.length === 1 && this.firstOutput ? this.firstOutput : this.output;
    return { output, rawFinal: JSON.stringify(output), model: 'generation-fixture', usage: null, durationMs: 0, eventCount: 1 };
  }
}

let app: Awaited<ReturnType<typeof testApp>> | undefined;
afterEach(async () => {
  await app?.dispose();
  app = undefined;
});

describe.each([
  { track: 'LLD', url: '/api/problems/generate', seed: 'seed/parking-lot.json', task: 'generate', params: { difficulty: 'easy', target: 'sde1', durationMinutes: 45, topic: 'resource-allocation' } },
  { track: 'HLD', url: '/api/hld/problems/generate', seed: 'hld-seed/ride-hailing.json', task: 'hld-generate', params: { difficulty: 'hard', target: 'sde2', domain: 'maps-location' } },
])('$track custom generation', ({ track, url, seed, task, params }) => {
  async function setup() {
    const provider = new GenerationFixture(seed);
    app = await testApp({ providerOverrides: { mock: provider } });
    app.ctx.settings.update({ provider: 'mock' });
    return { t: app, provider };
  }

  it('passes the complete statement to the provider and saves a familiar subject as a new problem', async () => {
    const { t, provider } = await setup();
    const theme = `${track === 'LLD' ? 'Car parking system' : 'Ride-hailing platform'}\n${'Keep the requested vehicle booking behavior. '.repeat(8)}Include {{difficulty}} literally.`;
    const res = await t.app.inject({ method: 'POST', url, headers: authHeaders(t.ctx.csrfToken), payload: { ...params, theme: `  ${theme}  ` } });
    expect(res.statusCode).toBe(200);
    const done = await waitForJob(t.ctx, res.json().id);
    expect(done.state).toBe('completed');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].task).toBe(task);
    expect(provider.requests[0].prompt).toContain(JSON.stringify(theme));
    expect(provider.requests[0].prompt).toContain('`targets` must include "' + params.target + '"');
    expect(provider.requests[0].prompt).toContain('Stay on that subject even if a similar title already exists');
    expect(t.ctx.jobs.params<{ theme: string }>(done.id).theme).toBe(theme);
    const id = (done.result as { problemId: string }).problemId;
    const saved = track === 'LLD' ? t.ctx.problems.get(id) : t.ctx.hld.getPublic(id);
    expect(saved.content.title).toBe(provider.output.title);
    expect(saved.content.difficulty).toBe(params.difficulty);
    expect(saved.content.targets).toContain(params.target);
    expect(id).toMatch(/^gen-/);
    expect(done.progress.some((p) => p.message === 'Question passed validation on the first attempt.')).toBe(true);
  });

  it.each(['schema', 'semantic'])('keeps the exact %s failure and timing after a successful correction', async (kind) => {
    const { t, provider } = await setup();
    provider.firstOutput = { ...provider.output, ...(kind === 'schema' ? { summary: '' } : { difficulty: 'medium' }) };
    const res = await t.app.inject({ method: 'POST', url, headers: authHeaders(t.ctx.csrfToken), payload: { ...params, theme: 'Vehicle booking system' } });
    const done = await waitForJob(t.ctx, res.json().id);
    expect(done.state).toBe('completed');
    expect(done.error).toBeNull();
    expect(provider.requests).toHaveLength(2);
    const check = kind === 'schema' ? 'summary: Too small' : 'difficulty is "medium"';
    expect(provider.requests[1].prompt).toContain(check);
    // Read via the API after completion: diagnostics survive success and a page reload.
    const stored = await t.app.inject({ method: 'GET', url: `/api/jobs/${done.id}`, headers: authHeaders(t.ctx.csrfToken) });
    const messages = stored.json().progress.map((p: { message: string }) => p.message).join('\n');
    expect(messages).toContain(`First answer validation: ${check}`);
    expect(messages).toMatch(/First answer received after \d+s/);
    expect(messages).toMatch(/Corrected answer received after \d+s/);
    expect(messages).toContain('Corrected answer passed validation.');
  });

  it.each([undefined, '   '])('keeps duplicate protection for open-ended generation (theme: %s)', async (theme) => {
    const { t, provider } = await setup();
    const res = await t.app.inject({ method: 'POST', url, headers: authHeaders(t.ctx.csrfToken), payload: { ...params, theme } });
    expect(res.statusCode).toBe(200);
    const done = await waitForJob(t.ctx, res.json().id);
    expect(done.state).toBe('failed');
    expect(done.error?.code).toBe('validation-failed');
    expect(done.error?.details?.join(' ')).toContain('too similar');
    expect(provider.requests[0].prompt).toContain('No custom idea supplied');
  });

  it('rejects oversized statements before starting an AI job', async () => {
    const { t, provider } = await setup();
    const res = await t.app.inject({ method: 'POST', url, headers: authHeaders(t.ctx.csrfToken), payload: { ...params, theme: 'x'.repeat(PROBLEM_THEME_MAX_LENGTH + 1) } });
    expect(res.statusCode).toBe(400);
    expect(provider.requests).toHaveLength(0);
    expect(t.ctx.jobs.list()).toHaveLength(0);
  });

  it('still enforces the requested difficulty for custom problems', async () => {
    const { t, provider } = await setup();
    provider.output.difficulty = 'medium';
    const res = await t.app.inject({ method: 'POST', url, headers: authHeaders(t.ctx.csrfToken), payload: { ...params, theme: 'Vehicle booking system' } });
    const done = await waitForJob(t.ctx, res.json().id);
    expect(done.state).toBe('failed');
    expect(done.error?.code).toBe('validation-failed');
    expect(provider.requests).toHaveLength(2); // The existing single correction attempt still applies.
    expect(done.progress.some((p) => p.message.startsWith('Corrected answer validation: difficulty'))).toBe(true);
  });
});
