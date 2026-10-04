import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { DEFAULT_SETTINGS, type Settings } from '@lld/shared';
import { ClaudeAdapter } from '../src/providers/claude.js';
import { CodexAdapter } from '../src/providers/codex.js';
import { SecretStore } from '../src/secrets.js';
import { JobFailure } from '../src/jobs.js';
import { FAKE_CLAUDE, FAKE_CODEX, tempDir } from './helpers.js';

let t: ReturnType<typeof tempDir>;
let secrets: SecretStore;
const saved = { ...process.env };
beforeEach(() => {
  t = tempDir();
  secrets = new SecretStore(t.dir);
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CODEX_API_KEY;
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  process.env = { ...saved };
  t.cleanup();
});

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  claude: { ...DEFAULT_SETTINGS.claude, executablePath: FAKE_CLAUDE },
  codex: { ...DEFAULT_SETTINGS.codex, executablePath: FAKE_CODEX },
  ...over,
});

function request(over: Record<string, unknown> = {}) {
  const progress: string[] = [];
  const controller = new AbortController();
  return {
    progress,
    controller,
    req: {
      task: 'review' as const,
      prompt: 'P'.repeat(300_000), // large prompts travel over stdin, never argv
      schema: { type: 'object' },
      timeoutMs: 10_000,
      workDir: t.dir,
      signal: controller.signal,
      onProgress: (m: string) => progress.push(m),
      ...over,
    },
  };
}

async function failure(p: Promise<unknown>): Promise<JobFailure> {
  try {
    await p;
  } catch (e) {
    return e as JobFailure;
  }
  throw new Error('expected failure');
}

describe('ClaudeAdapter', () => {
  it('reports subscription login status without inference', async () => {
    const s = await new ClaudeAdapter(secrets).status(settings());
    expect(s).toMatchObject({ state: 'authenticated', authMethod: 'claude.ai', authMode: 'subscription' });
  });

  it('parses a streamed structured result delivered in partial chunks', async () => {
    const out = join(t.dir, 'out.json');
    writeFileSync(out, JSON.stringify({ hello: 'world' }));
    process.env.FAKE_OUTPUT_FILE = out;
    process.env.FAKE_SCENARIO = 'garbage'; // includes unparseable lines that must be skipped
    const record = join(t.dir, 'rec.json');
    process.env.FAKE_RECORD = record;
    const { req, progress } = request();
    const res = await new ClaudeAdapter(secrets).runStructured(settings(), req);
    expect(res.output).toEqual({ hello: 'world' });
    expect(res.model).toBe('claude-opus-5-5');
    expect(progress.join('\n')).toMatch(/subscription login/);
    const rec = JSON.parse(readFileSync(record, 'utf8'));
    expect(rec.stdinLength).toBe(300_000);
    expect(rec.args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--tools', '', '--safe-mode', '--strict-mcp-config', '--no-session-persistence']));
    expect(rec.args.join(' ')).not.toMatch(/dangerously|bypassPermissions/);
    expect(rec.env.ANTHROPIC_API_KEY).toBeNull();
  });

  it('strips API keys in subscription mode and aborts if the CLI still reports API-key auth', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-should-be-stripped';
    process.env.FAKE_SCENARIO = 'success';
    const record = join(t.dir, 'rec.json');
    process.env.FAKE_RECORD = record;
    await new ClaudeAdapter(secrets).runStructured(settings(), request().req);
    expect(JSON.parse(readFileSync(record, 'utf8')).env.ANTHROPIC_API_KEY).toBeNull();
  });

  it('blocks subscription mode when the stored login is an API key', async () => {
    process.env.FAKE_SCENARIO = 'apikey-login';
    const a = new ClaudeAdapter(secrets);
    expect((await a.status(settings())).state).toBe('auth-blocked');
    expect((await failure(a.runStructured(settings(), request().req))).code).toBe('auth-blocked');
  });

  it('uses the configured key only in explicit API-key mode, and fails fast on 401', async () => {
    secrets.set('claude', 'sk-ant-test-key-1234');
    const s = settings({ claude: { ...settings().claude, authMode: 'api-key' } });
    const a = new ClaudeAdapter(secrets);
    expect(await a.status(s)).toMatchObject({ state: 'installed', authMode: 'api-key' });
    process.env.FAKE_SCENARIO = 'auth-401';
    const started = Date.now();
    const err = await failure(a.runStructured(s, request().req));
    expect(err.code).toBe('auth-failed');
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('reports API-key mode without a key as not connected', async () => {
    const s = settings({ claude: { ...settings().claude, authMode: 'api-key' } });
    expect((await new ClaudeAdapter(secrets).status(s)).state).toBe('unauthenticated');
  });

  it.each([
    ['malformed', 'malformed-output'],
    ['nonzero', 'nonzero-exit'],
    ['rate-limited', 'rate-limited'],
  ])('maps the %s scenario to %s without inventing a result', async (scenario, code) => {
    process.env.FAKE_SCENARIO = scenario;
    expect((await failure(new ClaudeAdapter(secrets).runStructured(settings(), request().req))).code).toBe(code);
  });

  it('times out and kills a hung CLI', async () => {
    process.env.FAKE_SCENARIO = 'slow';
    const err = await failure(new ClaudeAdapter(secrets).runStructured(settings(), request({ timeoutMs: 800 }).req));
    expect(err.code).toBe('timeout');
  });

  it('cancels a running request', async () => {
    process.env.FAKE_SCENARIO = 'slow';
    const { req, controller } = request();
    const p = new ClaudeAdapter(secrets).runStructured(settings(), req);
    setTimeout(() => controller.abort(), 300);
    expect((await failure(p)).code).toBe('cancelled');
  });

  it('reports a missing binary clearly', async () => {
    const s = settings({ claude: { ...settings().claude, executablePath: '/nonexistent/claude' } });
    expect((await new ClaudeAdapter(secrets).status(s)).state).toBe('not-installed');
    expect((await failure(new ClaudeAdapter(secrets).runStructured(s, request().req))).code).toBe('not-installed');
  });
});

describe('CodexAdapter', () => {
  it('detects ChatGPT login and disables tool features listed by this version', async () => {
    process.env.FAKE_SCENARIO = 'success';
    const record = join(t.dir, 'rec.json');
    process.env.FAKE_RECORD = record;
    const a = new CodexAdapter(secrets);
    expect(await a.status(settings())).toMatchObject({ state: 'authenticated', authMethod: 'ChatGPT' });
    const res = await a.runStructured(settings(), request().req);
    expect(res.output).toEqual({ ok: true, message: 'hello from fake codex' });
    const rec = JSON.parse(readFileSync(record, 'utf8'));
    expect(rec.args).toEqual(expect.arrayContaining(['exec', '--json', '--sandbox', 'read-only', '--ephemeral', '--ignore-user-config', '-']));
    expect(rec.args.join(' ')).toMatch(/--disable shell_tool/);
    expect(rec.args.join(' ')).not.toMatch(/dangerously/);
    expect(rec.env.CODEX_API_KEY).toBeNull();
  });

  it('maps the real 401 event stream to auth-failed', async () => {
    process.env.FAKE_SCENARIO = 'auth-401';
    expect((await failure(new CodexAdapter(secrets).runStructured(settings(), request().req))).code).toBe('auth-failed');
  });

  it('aborts when the agent tries to run a command', async () => {
    process.env.FAKE_SCENARIO = 'command';
    const err = await failure(new CodexAdapter(secrets).runStructured(settings(), request().req));
    expect(err.message).toMatch(/command execution/);
  });

  it('blocks API-key logins in subscription mode and passes the key only in API-key mode', async () => {
    process.env.FAKE_SCENARIO = 'apikey-login';
    expect((await new CodexAdapter(secrets).status(settings())).state).toBe('auth-blocked');
    process.env.FAKE_SCENARIO = 'success';
    process.env.OPENAI_API_KEY = 'sk-env-key-9999';
    const s = settings({ codex: { ...settings().codex, authMode: 'api-key' } });
    const record = join(t.dir, 'rec.json');
    process.env.FAKE_RECORD = record;
    const fresh = new SecretStore(t.dir); // captures the env key at construction
    await new CodexAdapter(fresh).runStructured(s, request().req);
    const rec = JSON.parse(readFileSync(record, 'utf8'));
    expect(rec.env.CODEX_API_KEY).toBe('sk-env-key-9999');
    expect(rec.env.OPENAI_API_KEY).toBeNull();
  });
});

describe('validated runs with one bounded correction', () => {
  async function setup() {
    const { testApp } = await import('./helpers.js');
    const app = await testApp();
    app.ctx.settings.update({ claude: { executablePath: FAKE_CLAUDE } });
    const ctx = { jobId: 'job-x', signal: new AbortController().signal, progress: () => {}, setPid: () => {} };
    return { app, ctx };
  }
  const Schema = z.object({ items: z.array(z.string()).max(2) });

  it('asks once for a correction and accepts the fixed answer', async () => {
    const { app, ctx } = await setup();
    const bad = join(t.dir, 'bad.json');
    const good = join(t.dir, 'good.json');
    writeFileSync(bad, JSON.stringify({ items: ['a', 'b', 'c'] }));
    writeFileSync(good, JSON.stringify({ items: ['a', 'b'] }));
    process.env.FAKE_SCENARIO = 'success';
    process.env.FAKE_OUTPUT_SEQUENCE = `${bad},${good}`;
    process.env.FAKE_COUNTER_FILE = join(t.dir, 'counter');
    process.env.FAKE_RECORD = join(t.dir, 'rec');
    const res = await app.ctx.providers.runValidated('claude', 'hint', 'prompt', Schema, ctx);
    expect(res.repaired).toBe(true);
    expect(res.data.items).toEqual(['a', 'b']);
    const repairPrompt = readFileSync(join(t.dir, 'rec.1'), 'utf8');
    expect(repairPrompt).toContain('items: Too big');
    expect(repairPrompt).toContain('"c"');
    await app.dispose();
  });

  it('fails after a second invalid answer instead of retrying again', async () => {
    const { app, ctx } = await setup();
    const bad = join(t.dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ items: ['a', 'b', 'c'] }));
    process.env.FAKE_SCENARIO = 'success';
    process.env.FAKE_OUTPUT_SEQUENCE = `${bad},${bad},${bad}`;
    process.env.FAKE_COUNTER_FILE = join(t.dir, 'counter2');
    const err = await failure(app.ctx.providers.runValidated('claude', 'hint', 'prompt', Schema, ctx));
    expect(err.code).toBe('validation-failed');
    expect(err.details?.some((d) => d.startsWith('corrected answer'))).toBe(true);
    expect(readFileSync(join(t.dir, 'counter2'), 'utf8')).toBe('2'); // exactly two calls
    await app.dispose();
  });
});
