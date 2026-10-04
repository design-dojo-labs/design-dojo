import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_SETTINGS, type Settings } from '@lld/shared';
import { GeminiAdapter, parseJsonc } from '../src/providers/gemini.js';
import { SecretStore } from '../src/secrets.js';
import { JobFailure } from '../src/jobs.js';
import { tempDir } from './helpers.js';

// Option lines captured from the real `gemini --help` (Gemini CLI 0.62.0).
const HELP = `Usage: gemini [options] [command]

Gemini CLI - Defaults to interactive mode. Use -p/--prompt for non-interactive (headless) mode.

Options:
  -d, --debug                     Run in debug mode (open debug console with F12)  [boolean] [default: false]
  -m, --model                     Model  [string]
  -p, --prompt                    Run in non-interactive (headless) mode with the given prompt. Appended to input on stdin (if any).  [string]
      --skip-trust                Trust the current workspace for this session.  [boolean] [default: false]
  -s, --sandbox                   Run in sandbox?  [boolean]
  -y, --yolo                      Automatically accept all actions?  [boolean] [default: false]
      --approval-mode             Set the approval mode: default (prompt for approval), auto_edit (auto-approve edit tools), yolo (auto-approve all tools), plan (read-only mode)  [string] [choices: "default", "auto_edit", "yolo", "plan"]
      --policy                    Additional policy files or directories to load (comma-separated or multiple --policy)  [array]
      --admin-policy              Additional admin policy files or directories to load (comma-separated or multiple --admin-policy)  [array]
      --allowed-mcp-server-names  Allowed MCP server names  [array]
  -e, --extensions                A list of extensions to use. If not provided, all extensions are used.  [array]
  -o, --output-format             The format of the CLI output.  [string] [choices: "text", "json", "stream-json"]
  -v, --version                   Show version number  [boolean]
  -h, --help                      Show help  [boolean]
`;

/** Test double for the Gemini CLI. Stream events follow the shapes emitted by Gemini CLI 0.62 (StreamJsonFormatter). */
const FAKE = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const scenario = process.env.FAKE_SCENARIO ?? 'success';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (args[0] === '--version') { console.log('0.62.0'); process.exit(0); }
if (args[0] === '--help') { process.stdout.write(${JSON.stringify(HELP)}); process.exit(0); }
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;
const pick = (k) => (k in process.env ? process.env[k] : null);
if (process.env.FAKE_RECORD) {
  const policy = args[args.indexOf('--policy') + 1];
  writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
    args, stdin, cwd: process.cwd(),
    policy: policy && existsSync(policy) ? readFileSync(policy, 'utf8') : null,
    workspaceSettings: existsSync(join(process.cwd(), '.gemini', 'settings.json')) ? JSON.parse(readFileSync(join(process.cwd(), '.gemini', 'settings.json'), 'utf8')) : null,
    env: Object.fromEntries(['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_CLI_HOME', 'NO_BROWSER'].map((k) => [k, pick(k)])),
  }));
}
const out = (o) => process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...o }) + '\\n');
const answer = process.env.FAKE_ANSWER ?? JSON.stringify({ ok: true, message: 'hello from fake gemini' });
const stats = { total_tokens: 120, input_tokens: 100, output_tokens: 20, cached: 0, input: 100, duration_ms: 900, tool_calls: 0, models: { 'gemini-2.5-pro': { total_tokens: 120 } } };
const assistant = (text) => { for (let i = 0; i < text.length; i += 7) out({ type: 'message', role: 'assistant', content: text.slice(i, i + 7), delta: true }); };
switch (scenario) {
  case 'success':
    out({ type: 'init', session_id: 's1', model: 'gemini-2.5-pro' });
    out({ type: 'message', role: 'user', content: stdin.slice(0, 20) });
    assistant(answer);
    out({ type: 'result', status: 'success', stats });
    break;
  case 'fenced':
    out({ type: 'init', session_id: 's1', model: 'gemini-2.5-flash' });
    assistant('Here is the result:\\n\`\`\`json\\n' + answer + '\\n\`\`\`\\n');
    out({ type: 'result', status: 'success', stats });
    break;
  case 'tool':
    out({ type: 'init', session_id: 's1', model: 'gemini-2.5-pro' });
    out({ type: 'tool_use', tool_name: 'read_file', tool_id: 't1', parameters: { file_path: '/etc/hosts' } });
    await sleep(60000);
    break;
  case 'malformed':
    out({ type: 'init', session_id: 's1', model: 'gemini-2.5-pro' });
    assistant('Sorry, I cannot produce that.');
    out({ type: 'result', status: 'success', stats });
    break;
  case 'auth':
    process.stderr.write('Manual authorization is required but the current session is non-interactive.\\n');
    process.exit(41);
  case 'quota':
    out({ type: 'init', session_id: 's1', model: 'gemini-2.5-pro' });
    out({ type: 'error', severity: 'error', message: 'RESOURCE_EXHAUSTED: You have exhausted your capacity on this model.' });
    out({ type: 'result', status: 'error', error: { type: 'Error', message: 'Quota exceeded' }, stats });
    process.exit(1);
  case 'slow':
    await sleep(60000);
    break;
  default:
    process.exit(3);
}
`;

let t: ReturnType<typeof tempDir>;
let home: string;
let fake: string;
let secrets: SecretStore;
const saved = { ...process.env };

beforeEach(() => {
  t = tempDir();
  home = join(t.dir, 'home');
  mkdirSync(join(home, '.gemini'), { recursive: true });
  fake = join(t.dir, 'fake-gemini.mjs');
  writeFileSync(fake, FAKE);
  chmodSync(fake, 0o755);
  for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS', 'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE', 'FAKE_SCENARIO', 'FAKE_RECORD', 'FAKE_ANSWER']) delete process.env[k];
  process.env.GEMINI_CLI_HOME = home;
  process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = join(t.dir, 'no-system-settings.json');
  secrets = new SecretStore(t.dir);
});
afterEach(() => {
  process.env = { ...saved };
  t.cleanup();
});

/** Simulates `gemini` → Sign in with Google: the CLI stores the auth type and cached OAuth credentials. */
function googleLogin(type = 'oauth-personal', creds = true) {
  writeFileSync(join(home, '.gemini', 'settings.json'), `{\n  // written by the CLI\n  "security": { "auth": { "selectedType": "${type}" } },\n}\n`);
  if (creds) writeFileSync(join(home, '.gemini', 'oauth_creds.json'), '{"refresh_token":"x"}');
}

const settings = (gemini: Partial<Settings['gemini']> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  gemini: { ...DEFAULT_SETTINGS.gemini, executablePath: fake, ...gemini },
});

function request(over: Record<string, unknown> = {}) {
  const progress: string[] = [];
  const partials: string[] = [];
  const controller = new AbortController();
  const workDir = join(t.dir, 'job');
  mkdirSync(workDir, { recursive: true });
  return {
    progress,
    partials,
    controller,
    req: {
      task: 'review' as const,
      prompt: 'Review this code: @Override public String toString() { return "x"; }\n' + 'P'.repeat(200_000),
      schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
      timeoutMs: 10_000,
      workDir,
      signal: controller.signal,
      onProgress: (m: string) => progress.push(m),
      onPartial: (p: string) => partials.push(p),
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

const record = () => {
  const file = join(t.dir, 'rec.json');
  process.env.FAKE_RECORD = file;
  return () => JSON.parse(readFileSync(file, 'utf8'));
};

describe('GeminiAdapter status (local checks only)', () => {
  it('reports a Google login as authenticated', async () => {
    googleLogin();
    const s = await new GeminiAdapter(secrets).status(settings());
    expect(s).toMatchObject({ state: 'authenticated', authMethod: 'Google login', authMode: 'subscription', version: '0.62.0' });
  });

  it('reports not connected when no auth type is chosen or credentials are missing', async () => {
    const a = new GeminiAdapter(secrets);
    expect((await a.status(settings())).state).toBe('unauthenticated');
    googleLogin('oauth-personal', false);
    expect((await a.status(settings())).state).toBe('unauthenticated');
    expect((await failure(a.runStructured(settings(), request().req))).code).toBe('auth-failed');
  });

  it.each(['gemini-api-key', 'vertex-ai', 'compute-default-credentials'])('blocks subscription mode when the CLI is set to %s', async (type) => {
    googleLogin(type);
    const a = new GeminiAdapter(secrets);
    const s = await a.status(settings());
    expect(s.state).toBe('auth-blocked');
    expect((await failure(a.runStructured(settings(), request().req))).code).toBe('auth-blocked');
  });

  it('reports a missing CLI as not installed', async () => {
    const s = await new GeminiAdapter(secrets).status(settings({ executablePath: join(t.dir, 'missing') }));
    expect(s.state).toBe('not-installed');
  });

  it('parses JSONC settings files', () => {
    expect(parseJsonc('{ "a": "http://x//y", /* c */ "b": [1,], // tail\n }')).toEqual({ a: 'http://x//y', b: [1] });
  });
});

describe('GeminiAdapter runs', () => {
  it('runs headless with every tool denied and parses the streamed JSON answer', async () => {
    googleLogin();
    const rec = record();
    process.env.FAKE_ANSWER = JSON.stringify({ ok: true, items: ['a', 'b'], note: 'streamed in chunks' });
    const { req, progress, partials } = request({ model: 'pro' });
    const res = await new GeminiAdapter(secrets).runStructured(settings(), req);
    expect(res.output).toEqual({ ok: true, items: ['a', 'b'], note: 'streamed in chunks' });
    expect(res.model).toBe('gemini-2.5-pro');
    expect(res.usage).toMatchObject({ output_tokens: 20 });
    expect(progress.join('\n')).toMatch(/Google login/);
    // Partial output grows and always starts at the JSON object.
    expect(partials.length).toBeGreaterThan(0);
    expect(partials.every((p) => p.startsWith('{'))).toBe(true);

    const r = rec();
    expect(r.args).toEqual(
      expect.arrayContaining([
        '--prompt',
        '--output-format',
        'stream-json',
        '--policy',
        '--approval-mode',
        'default',
        '--skip-trust',
        '--extensions',
        'none',
        '--allowed-mcp-server-names',
        'lld-studio-no-mcp',
        '--model',
        'pro',
      ]),
    );
    expect(r.args.join(' ')).not.toMatch(/yolo|auto_edit/);
    expect(r.policy).toMatch(/toolName = "\*"\s+decision = "deny"/);
    expect(r.workspaceSettings).toMatchObject({ hooksConfig: { enabled: false }, skills: { enabled: false } });
    // The prompt travels on stdin with the schema appended; the CLI runs from an empty job sub-folder.
    expect(r.stdin.length).toBeGreaterThan(200_000);
    expect(r.stdin).toContain('<json_schema>');
    expect(r.cwd).toBe(realpathSync(join(req.workDir, 'cwd')));
  });

  it('blanks API-key, Vertex and ADC variables in subscription mode', async () => {
    googleLogin();
    process.env.GEMINI_API_KEY = 'AIza-should-be-blanked';
    process.env.GOOGLE_API_KEY = 'AIza-also-blanked';
    process.env.GOOGLE_GENAI_USE_VERTEXAI = 'true';
    process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json';
    const rec = record();
    await new GeminiAdapter(new SecretStore(t.dir)).runStructured(settings(), request().req);
    const env = rec().env;
    expect(env.GEMINI_API_KEY).toBe('');
    expect(env.GOOGLE_API_KEY).toBe('');
    expect(env.GOOGLE_GENAI_USE_VERTEXAI).toBe('');
    expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe('');
    expect(env.NO_BROWSER).toBe('true');
    expect(env.GEMINI_CLI_HOME).toBe(home); // the real CLI home (and its Google login) is used
  });

  it('passes the key only in explicit API-key mode, with an isolated CLI home', async () => {
    googleLogin(); // a stored Google login must not take precedence over the key
    secrets.set('gemini', 'AIza-test-key-1234');
    const s = settings({ authMode: 'api-key' });
    const a = new GeminiAdapter(secrets);
    expect(await a.status(s)).toMatchObject({ state: 'installed', authMode: 'api-key' });
    const rec = record();
    const { req } = request();
    await a.runStructured(s, req);
    const env = rec().env;
    expect(env.GEMINI_API_KEY).toBe('AIza-test-key-1234');
    expect(env.GEMINI_CLI_HOME).toBe(join(req.workDir, 'home'));
  });

  it('reports API-key mode without a key as not connected', async () => {
    expect((await new GeminiAdapter(secrets).status(settings({ authMode: 'api-key' }))).state).toBe('unauthenticated');
  });

  it('aborts immediately when the model tries to call a tool', async () => {
    googleLogin();
    process.env.FAKE_SCENARIO = 'tool';
    const started = Date.now();
    const err = await failure(new GeminiAdapter(secrets).runStructured(settings(), request().req));
    expect(err.code).toBe('validation-failed');
    expect(err.message).toMatch(/read_file/);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('accepts an answer wrapped in prose and a code fence', async () => {
    googleLogin();
    process.env.FAKE_SCENARIO = 'fenced';
    const res = await new GeminiAdapter(secrets).runStructured(settings(), request().req);
    expect(res.output).toEqual({ ok: true, message: 'hello from fake gemini' });
  });

  it.each([
    ['malformed', 'malformed-output'],
    ['auth', 'auth-failed'],
    ['quota', 'rate-limited'],
  ])('maps the %s scenario to %s without inventing a result', async (scenario, code) => {
    googleLogin();
    process.env.FAKE_SCENARIO = scenario;
    expect((await failure(new GeminiAdapter(secrets).runStructured(settings(), request().req))).code).toBe(code);
  });

  it('times out and kills a hung CLI', async () => {
    googleLogin();
    process.env.FAKE_SCENARIO = 'slow';
    expect((await failure(new GeminiAdapter(secrets).runStructured(settings(), request({ timeoutMs: 800 }).req))).code).toBe('timeout');
  });
});
