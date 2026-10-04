import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderStatus, Settings } from '@lld/shared';
import { now } from '../db.js';
import { JobFailure } from '../jobs.js';
import { LineSplitter, startProcess } from '../proc.js';
import { runQuiet } from '../java/toolchain.js';
import { captureOutput, classifyError, cliEnv, parseJsonText, resolveExecutable, sanitizeCliText } from './cli.js';
import type { ProviderAdapter, StructuredRequest, StructuredResult } from './types.js';
import type { SecretStore } from '../secrets.js';

const REQUIRED_EXEC_FLAGS = ['--json', '--output-schema', '--sandbox', '--skip-git-repo-check', '--output-last-message'];
const OPTIONAL_EXEC_FLAGS = ['--ephemeral', '--ignore-user-config', '--ignore-rules', '--disable', '--cd', '--model', '--config'];
/** Agent capabilities a review/generation job never needs. Only disabled if this Codex version lists them. */
const FEATURES_TO_DISABLE = ['shell_tool', 'unified_exec', 'apps', 'browser_use', 'computer_use', 'in_app_browser', 'plugins', 'hooks', 'multi_agent', 'view_image'];
/** Item types that mean the agent tried to act rather than answer. Review jobs abort on these. */
const ACTION_ITEMS = new Set(['command_execution', 'file_change', 'mcp_tool_call', 'web_search']);

interface Capabilities {
  version: string;
  flags: Set<string>;
  missing: string[];
  disable: string[];
}

/**
 * Codex adapter: `codex exec --json --output-schema` in a read-only sandbox, from an empty
 * working directory, with user config, rules and unnecessary tool features disabled where the
 * installed version supports it. Any attempt to run commands or change files aborts the job.
 */
export class CodexAdapter implements ProviderAdapter {
  id = 'codex' as const;
  label = 'Codex CLI';
  private caps = new Map<string, Capabilities>();

  constructor(private secrets: SecretStore) {}

  /** Child environment for the selected auth mode. Subscription mode never carries an API key. */
  private env(settings: Settings): { env: Record<string, string>; keyHint: string | null; keySource: string | null } {
    if (settings.codex.authMode !== 'api-key') return { env: cliEnv(), keyHint: null, keySource: null };
    const key = this.secrets.resolve('codex');
    if (!key) return { env: cliEnv(), keyHint: null, keySource: null };
    // CODEX_API_KEY is the variable documented for `codex exec` runs.
    return { env: cliEnv({ CODEX_API_KEY: key.key }), keyHint: `…${key.key.slice(-4)}`, keySource: key.source === 'stored' ? 'saved in Settings' : `$${key.envVar}` };
  }

  private async capabilities(exe: string): Promise<Capabilities> {
    const v = await runQuiet(exe, ['--version'], cliEnv());
    const version = (v.stdout || v.stderr).trim().split('\n')[0] ?? '';
    const key = `${exe}@${version}`;
    const cached = this.caps.get(key);
    if (cached) return cached;
    const text = await captureOutput(exe, ['exec', '--help'], cliEnv());
    const flags = new Set([...REQUIRED_EXEC_FLAGS, ...OPTIONAL_EXEC_FLAGS].filter((f) => text.includes(f)));
    let disable: string[] = [];
    if (flags.has('--disable')) {
      const feats = await captureOutput(exe, ['features', 'list'], cliEnv());
      const listed = new Set(feats.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean));
      disable = FEATURES_TO_DISABLE.filter((f) => listed.has(f));
    }
    const caps = { version, flags, missing: REQUIRED_EXEC_FLAGS.filter((f) => !flags.has(f)), disable };
    this.caps.set(key, caps);
    return caps;
  }

  async status(settings: Settings): Promise<ProviderStatus> {
    const base = {
      id: this.id,
      label: this.label,
      checkedAt: now(),
      lastConnectionTest: null,
      authMethod: null,
      subscription: null,
      authMode: settings.codex.authMode,
    } satisfies Partial<ProviderStatus>;
    const exe = resolveExecutable('codex', settings.codex.executablePath);
    if (!exe.path) return { ...base, state: 'not-installed', executable: null, version: null, detail: `${exe.error} Install with \`npm i -g @openai/codex\` and run \`codex login\`.` };
    const caps = await this.capabilities(exe.path);
    if (!caps.version) return { ...base, state: 'error', executable: exe.path, version: null, detail: 'Could not read `codex --version`.' };
    if (caps.missing.length) {
      return { ...base, state: 'error', executable: exe.path, version: caps.version, detail: `This Codex version lacks required exec flags (${caps.missing.join(', ')}). Update Codex.` };
    }
    const common = { ...base, executable: exe.path, version: caps.version };
    if (settings.codex.authMode === 'api-key') {
      const mode = this.env(settings);
      if (!mode.keyHint) {
        return { ...common, state: 'unauthenticated', detail: 'API-key mode is selected but no OpenAI API key is configured. Add one in Settings or switch back to ChatGPT login.' };
      }
      return {
        ...common,
        state: 'installed',
        authMethod: 'api-key',
        detail: `API-key mode: using key ${mode.keyHint} (${mode.keySource}) via CODEX_API_KEY. Usage is billed per token to that OpenAI account. Run "Test connection" to verify the key.`,
      };
    }
    // `codex login status` reads stored credentials locally; it does not call the model.
    const st = await runQuiet(exe.path, ['login', 'status'], cliEnv());
    const text = `${st.stdout}\n${st.stderr}`;
    if (/not logged in/i.test(text) || (st.code !== 0 && !/logged in using/i.test(text))) {
      return { ...common, state: 'unauthenticated', detail: 'Not logged in. Click Connect (or run `codex login` in a terminal) and sign in with ChatGPT.' };
    }
    const m = text.match(/Logged in using (ChatGPT|an API key|access token|personal access token|Amazon Bedrock[^\n-]*|workload identity)/i);
    if (!m) return { ...common, state: 'installed', detail: 'Installed; login method could not be determined locally. Run a connection test.' };
    const method = m[1].trim();
    if (/chatgpt/i.test(method)) {
      return { ...common, state: 'authenticated', authMethod: 'ChatGPT', subscription: 'ChatGPT plan', detail: 'Logged in with ChatGPT. Usage counts against your plan limits.' };
    }
    // Subscription mode refuses API keys, access tokens and cloud-provider credentials.
    return {
      ...common,
      state: 'auth-blocked',
      authMethod: method,
      detail: `Codex is logged in using ${method}, not a ChatGPT subscription. Subscription mode never uses API keys, so AI jobs are blocked. Click Connect to sign in with ChatGPT, or switch this provider to API-key mode in Settings.`,
    };
  }

  async runStructured(settings: Settings, req: StructuredRequest): Promise<StructuredResult> {
    const exe = resolveExecutable('codex', settings.codex.executablePath);
    if (!exe.path) throw new JobFailure('not-installed', exe.error ?? 'Codex not found.');
    const caps = await this.capabilities(exe.path);
    if (caps.missing.length) throw new JobFailure('not-installed', `Codex ${caps.version} lacks required flags: ${caps.missing.join(', ')}.`);
    const status = await this.status(settings);
    if (status.state === 'auth-blocked') throw new JobFailure('auth-blocked', status.detail);
    if (status.state === 'unauthenticated') throw new JobFailure('auth-failed', status.detail);
    const mode = this.env(settings);
    const apiKeyMode = settings.codex.authMode === 'api-key';

    const schemaFile = join(req.workDir, 'output-schema.json');
    const lastMessageFile = join(req.workDir, 'last-message.json');
    writeFileSync(schemaFile, JSON.stringify(req.schema));
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--output-schema', schemaFile, '--output-last-message', lastMessageFile];
    if (caps.flags.has('--ephemeral')) args.push('--ephemeral');
    if (caps.flags.has('--ignore-user-config')) args.push('--ignore-user-config');
    if (caps.flags.has('--ignore-rules')) args.push('--ignore-rules');
    if (caps.flags.has('--cd')) args.push('--cd', req.workDir);
    for (const f of caps.disable) args.push('--disable', f);
    const model = req.model === undefined ? settings.codex.model.trim() || null : req.model;
    if (model) args.push('--model', model);
    // Codex reads reasoning effort from its config; `--config key=value` overrides it for this run.
    if (req.effort && req.effort !== 'default' && caps.flags.has('--config')) args.push('--config', `model_reasoning_effort="${req.effort}"`);
    args.push('-'); // read the prompt from stdin

    req.onProgress(
      `Starting Codex ${caps.version.replace(/^codex-cli\s*/, '')}${model ? ` (model ${model})` : ''}${req.effort && req.effort !== 'default' ? ` · effort ${req.effort}` : ''} · ${apiKeyMode ? `API key ${mode.keyHint} (billed per token)` : 'ChatGPT login'}…`,
    );
    const splitter = new LineSplitter();
    const st = {
      events: 0,
      malformed: 0,
      lastAgentMessage: null as string | null,
      usage: null as Record<string, unknown> | null,
      turnFailed: null as string | null,
      errors: [] as string[],
      violation: null as string | null,
    };

    const handleLine = (line: string) => {
      if (!line.trim()) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        st.malformed++;
        return;
      }
      st.events++;
      const type = String(ev.type ?? '');
      if (type === 'thread.started') req.onProgress('Codex session started');
      else if (type === 'turn.started') req.onProgress('Codex is working…');
      else if (type === 'turn.completed') st.usage = (ev.usage as Record<string, unknown>) ?? null;
      else if (type === 'turn.failed') st.turnFailed = String((ev.error as Record<string, unknown> | undefined)?.message ?? 'turn failed');
      else if (type === 'error') {
        const msg = String(ev.message ?? '');
        st.errors.push(msg);
        req.onProgress(`Codex: ${sanitizeCliText(msg, 200)}`);
      } else if (type.startsWith('item.')) {
        const item = (ev.item ?? {}) as Record<string, unknown>;
        const itype = String(item.type ?? '');
        if (ACTION_ITEMS.has(itype) && !st.violation) {
          st.violation = `Codex attempted a ${itype.replace('_', ' ')}, which AI jobs in this app do not allow.`;
          proc.kill('cancelled');
          return;
        }
        if (type === 'item.completed' && itype === 'agent_message' && typeof item.text === 'string') st.lastAgentMessage = item.text;
        if (type === 'item.started' && itype === 'reasoning') req.onProgress('Codex is reasoning…');
      }
    };

    const proc = startProcess({
      cmd: exe.path,
      args,
      cwd: req.workDir,
      env: mode.env,
      stdin: req.prompt,
      timeoutMs: req.timeoutMs,
      maxOutputBytes: 8 * 1024 * 1024,
      onStdout: (chunk) => splitter.push(chunk).forEach(handleLine),
    });
    req.onPid?.(proc.pid);
    const onAbort = () => proc.kill('cancelled');
    req.signal.addEventListener('abort', onAbort);
    const res = await proc.done;
    req.signal.removeEventListener('abort', onAbort);
    req.onPid?.(null);
    splitter.flush().forEach(handleLine);

    if (st.violation) throw new JobFailure('validation-failed', st.violation);
    if (req.signal.aborted || res.reason === 'cancelled') throw new JobFailure('cancelled', 'Cancelled.');
    if (res.reason === 'timeout') throw new JobFailure('timeout', `Codex did not finish within ${Math.round(req.timeoutMs / 1000)}s.`);
    if (res.reason === 'spawn-error') throw new JobFailure('not-installed', `Could not start Codex: ${res.error}`);
    if (res.reason === 'output-limit') throw new JobFailure('malformed-output', 'Codex produced more output than allowed.');
    if (st.turnFailed) {
      const msg = sanitizeCliText(st.turnFailed, 600);
      throw new JobFailure(classifyError(msg) ?? 'nonzero-exit', `Codex failed: ${msg}`);
    }
    const finalText = existsSync(lastMessageFile) ? readFileSync(lastMessageFile, 'utf8') : st.lastAgentMessage;
    if (res.exitCode !== 0 || !finalText) {
      const stderr = sanitizeCliText(res.stderr);
      const joined = [stderr, ...st.errors].join('\n');
      throw new JobFailure(
        classifyError(joined) ?? (res.exitCode !== 0 ? 'nonzero-exit' : 'malformed-output'),
        res.exitCode !== 0 ? `Codex exited with code ${res.exitCode}.` : 'Codex finished without a final message.',
        [stderr && `stderr: ${stderr}`, st.malformed ? `${st.malformed} unparseable event line(s)` : ''].filter(Boolean),
      );
    }
    let output: unknown;
    try {
      output = parseJsonText(finalText);
    } catch {
      throw new JobFailure('malformed-output', 'Codex returned a final message that is not valid JSON.', [sanitizeCliText(finalText, 800)]);
    }
    return { output, model: settings.codex.model.trim() || null, usage: st.usage, durationMs: res.durationMs, rawFinal: finalText, eventCount: st.events };
  }
}
