import type { ProviderStatus, Settings } from '@lld/shared';
import { now } from '../db.js';
import { JobFailure } from '../jobs.js';
import { LineSplitter, startProcess } from '../proc.js';
import { runQuiet } from '../java/toolchain.js';
import { captureOutput, classifyError, cliEnv, parseJsonText, resolveExecutable, sanitizeCliText } from './cli.js';
import type { ProviderAdapter, StructuredRequest, StructuredResult } from './types.js';
import type { SecretStore } from '../secrets.js';

/** Flags this adapter relies on. Required ones must appear in `claude --help` or jobs are refused. */
const REQUIRED_FLAGS = ['--print', '--output-format', '--json-schema', '--tools', '--verbose'];
const OPTIONAL_FLAGS = [
  '--safe-mode',
  '--strict-mcp-config',
  '--no-session-persistence',
  '--permission-mode',
  '--disable-slash-commands',
  '--model',
  '--effort',
  '--include-partial-messages',
];
/** Throttle for partial-output callbacks so a fast stream does not flood the event bus. */
const PARTIAL_INTERVAL_MS = 400;

interface Capabilities {
  version: string;
  flags: Set<string>;
  missing: string[];
}

/**
 * Claude Code adapter: `claude -p` with stream-json events and a JSON Schema for the final answer.
 * All built-in tools are disabled (`--tools ""`), MCP servers are not loaded, customizations
 * (CLAUDE.md, hooks, skills, plugins) are skipped via `--safe-mode`, and the working directory is an
 * empty per-job folder — the learner's code is only ever passed inside the prompt as data.
 */
export class ClaudeAdapter implements ProviderAdapter {
  id = 'claude' as const;
  label = 'Claude Code';
  private caps = new Map<string, Capabilities>();

  constructor(private secrets: SecretStore) {}

  /** Child environment for the selected auth mode. Subscription mode never carries an API key. */
  private env(settings: Settings): { env: Record<string, string>; keyHint: string | null; keySource: string | null } {
    if (settings.claude.authMode !== 'api-key') return { env: cliEnv(), keyHint: null, keySource: null };
    const key = this.secrets.resolve('claude');
    if (!key) return { env: cliEnv(), keyHint: null, keySource: null };
    return {
      env: cliEnv({ ANTHROPIC_API_KEY: key.key }),
      keyHint: `…${key.key.slice(-4)}`,
      keySource: key.source === 'stored' ? 'saved in Settings' : `$${key.envVar}`,
    };
  }

  private async capabilities(exe: string): Promise<Capabilities> {
    const v = await runQuiet(exe, ['--version'], cliEnv());
    const version = (v.stdout || v.stderr).trim().split('\n')[0] ?? '';
    const key = `${exe}@${version}`;
    const cached = this.caps.get(key);
    if (cached) return cached;
    const text = await captureOutput(exe, ['--help'], cliEnv());
    const flags = new Set([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS].filter((f) => text.includes(f) || (f === '--print' && text.includes('-p, --print'))));
    const caps = { version, flags, missing: REQUIRED_FLAGS.filter((f) => !flags.has(f)) };
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
      authMode: settings.claude.authMode,
    } satisfies Partial<ProviderStatus>;
    const exe = resolveExecutable('claude', settings.claude.executablePath);
    if (!exe.path) return { ...base, state: 'not-installed', executable: null, version: null, detail: `${exe.error} Install Claude Code and run "claude" once to log in.` };
    const caps = await this.capabilities(exe.path);
    if (!caps.version) return { ...base, state: 'error', executable: exe.path, version: null, detail: 'Could not read `claude --version`.' };
    if (caps.missing.length) {
      return {
        ...base,
        state: 'error',
        executable: exe.path,
        version: caps.version,
        detail: `This Claude Code version does not support required flags (${caps.missing.join(', ')}). Update Claude Code.`,
      };
    }
    const mode = this.env(settings);
    if (settings.claude.authMode === 'api-key' && !mode.keyHint) {
      return {
        ...base,
        state: 'unauthenticated',
        executable: exe.path,
        version: caps.version,
        detail: 'API-key mode is selected but no Anthropic API key is configured. Add one in Settings or switch back to subscription login.',
      };
    }
    // `claude auth status --json` is a local check of stored credentials; it does not call the model.
    const auth = await runQuiet(exe.path, ['auth', 'status', '--json'], mode.env);
    let parsed: { loggedIn?: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string } | null = null;
    try {
      parsed = JSON.parse(auth.stdout);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      return { ...base, state: 'installed', executable: exe.path, version: caps.version, detail: 'Installed. Login state could not be determined locally; run a connection test.' };
    }
    if (!parsed.loggedIn) {
      return { ...base, state: 'unauthenticated', executable: exe.path, version: caps.version, detail: 'Not logged in. Click Connect (or run `claude auth login` in a terminal) to sign in with your Claude subscription.' };
    }
    const method = parsed.authMethod ?? 'unknown';
    const subscription = parsed.subscriptionType ?? null;
    const common = { ...base, executable: exe.path, version: caps.version, authMethod: method, subscription };
    if (settings.claude.authMode === 'api-key') {
      // A key cannot be validated without an inference call, so it stays "unverified" until a connection test.
      return {
        ...common,
        state: 'installed',
        detail: `API-key mode: using key ${mode.keyHint} (${mode.keySource}). Usage is billed per token to that Anthropic account. Run "Test connection" to verify the key.`,
      };
    }
    // Subscription mode: anything other than a claude.ai login (API key, auth token, cloud provider) is refused.
    if (method !== 'claude.ai' || (parsed.apiProvider && parsed.apiProvider !== 'firstParty')) {
      return {
        ...common,
        state: 'auth-blocked',
        detail: `Claude Code is authenticated via "${method}"${parsed.apiProvider ? ` (${parsed.apiProvider})` : ''}, not a Claude subscription login. Subscription mode never uses API keys, so AI jobs are blocked. Log in with your subscription (Connect), or switch this provider to API-key mode in Settings.`,
      };
    }
    return {
      ...common,
      state: 'authenticated',
      detail: `Logged in with a Claude${subscription ? ` ${subscription}` : ''} subscription. Usage counts against your plan's limits.`,
    };
  }

  async runStructured(settings: Settings, req: StructuredRequest): Promise<StructuredResult> {
    const exe = resolveExecutable('claude', settings.claude.executablePath);
    if (!exe.path) throw new JobFailure('not-installed', exe.error ?? 'Claude Code not found.');
    const caps = await this.capabilities(exe.path);
    if (caps.missing.length) throw new JobFailure('not-installed', `Claude Code ${caps.version} lacks required flags: ${caps.missing.join(', ')}.`);
    const status = await this.status(settings);
    if (status.state === 'auth-blocked') throw new JobFailure('auth-blocked', status.detail);
    if (status.state === 'unauthenticated') throw new JobFailure('auth-failed', status.detail);
    const mode = this.env(settings);
    const apiKeyMode = settings.claude.authMode === 'api-key';

    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(req.schema), '--tools', ''];
    if (caps.flags.has('--strict-mcp-config')) args.push('--strict-mcp-config');
    if (caps.flags.has('--safe-mode')) args.push('--safe-mode');
    if (caps.flags.has('--disable-slash-commands')) args.push('--disable-slash-commands');
    if (caps.flags.has('--no-session-persistence')) args.push('--no-session-persistence');
    if (caps.flags.has('--permission-mode')) args.push('--permission-mode', 'dontAsk');
    const model = req.model === undefined ? settings.claude.model.trim() || null : req.model;
    if (model) args.push('--model', model);
    if (req.effort && req.effort !== 'default' && caps.flags.has('--effort')) args.push('--effort', req.effort);
    const streamPartial = !!req.onPartial && caps.flags.has('--include-partial-messages');
    if (streamPartial) args.push('--include-partial-messages');

    req.onProgress(
      `Starting Claude Code ${caps.version}${model ? ` (model ${model})` : ''}${req.effort && req.effort !== 'default' ? ` · effort ${req.effort}` : ''} · ${apiKeyMode ? `API key ${mode.keyHint} (billed per token)` : 'subscription login'}…`,
    );
    const splitter = new LineSplitter();
    // Mutated from stream callbacks; kept in one object so control-flow narrowing stays honest.
    const st = {
      model: null as string | null,
      final: null as Record<string, unknown> | null,
      events: 0,
      malformed: 0,
      blocked: null as string | null,
      rateLimited: null as string | null,
      authError: null as string | null,
      lastRetry: null as string | null,
      sawText: false,
      /** Content-block index of the StructuredOutput tool call being streamed, and its JSON so far. */
      structuredIndex: null as number | null,
      partialJson: '',
      lastPartialAt: 0,
      announcedWriting: false,
    };
    const emitPartial = (force = false) => {
      if (!req.onPartial || !st.partialJson) return;
      const t = Date.now();
      if (!force && t - st.lastPartialAt < PARTIAL_INTERVAL_MS) return;
      st.lastPartialAt = t;
      req.onPartial(st.partialJson);
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
      const type = ev.type;
      if (type === 'system' && ev.subtype === 'init') {
        st.model = typeof ev.model === 'string' ? ev.model : null;
        const keySource = ev.apiKeySource;
        // Second guard: the CLI reports where its credentials came from. In subscription mode anything
        // but "none" (the subscription OAuth login) would mean API billing, so stop immediately.
        if (!apiKeyMode && keySource !== 'none') {
          st.blocked = `Claude Code reported API-key authentication (${String(keySource)}) in subscription mode. Aborted before the request was sent.`;
          proc.kill('cancelled');
          return;
        }
        req.onProgress(`Claude Code session started${st.model ? ` · model ${st.model}` : ''}`);
      } else if (type === 'system' && ev.subtype === 'api_retry') {
        const status = Number(ev.error_status);
        if (status === 401 || status === 403) {
          // Credentials will not fix themselves between retries; fail fast instead of retrying for minutes.
          st.authError = `Authentication failed (${status} ${String(ev.error ?? '')}).${apiKeyMode ? ' Check the API key in Settings.' : ' Log in again with your subscription.'}`;
          proc.kill('cancelled');
          return;
        }
        if (status === 429) st.lastRetry = 'rate limited';
        req.onProgress(`Provider error ${Number.isFinite(status) ? status : ''} — the CLI is retrying (attempt ${String(ev.attempt ?? '?')}/${String(ev.max_retries ?? '?')})`);
      } else if (type === 'assistant') {
        const content = ((ev.message as Record<string, unknown> | undefined)?.content ?? []) as Record<string, unknown>[];
        for (const c of content) {
          if (c.type === 'tool_use' && c.name === 'StructuredOutput') req.onProgress('Structured result received; validating…');
          else if (c.type === 'text' && !st.sawText) {
            st.sawText = true;
            req.onProgress('Model is responding…');
          } else if (c.type === 'thinking' && !st.sawText) req.onProgress('Model is thinking…');
        }
      } else if (type === 'stream_event' && streamPartial) {
        const e = (ev.event ?? {}) as Record<string, unknown>;
        const block = (e.content_block ?? {}) as Record<string, unknown>;
        const delta = (e.delta ?? {}) as Record<string, unknown>;
        if (e.type === 'content_block_start' && block.type === 'tool_use' && block.name === 'StructuredOutput') {
          st.structuredIndex = typeof e.index === 'number' ? e.index : null;
          st.partialJson = '';
          if (!st.announcedWriting) {
            st.announcedWriting = true;
            req.onProgress('Writing the structured answer…');
          }
        } else if (e.type === 'content_block_delta' && delta.type === 'input_json_delta' && e.index === st.structuredIndex) {
          st.partialJson += typeof delta.partial_json === 'string' ? delta.partial_json : '';
          emitPartial();
        } else if (e.type === 'content_block_stop' && e.index === st.structuredIndex) emitPartial(true);
      } else if (type === 'rate_limit_event') {
        const info = (ev.rate_limit_info ?? {}) as Record<string, unknown>;
        if (info.status === 'rejected') st.rateLimited = `Usage limit reached (${String(info.rateLimitType ?? 'window')}).`;
        else if (info.status && info.status !== 'allowed') req.onProgress(`Usage notice: ${String(info.status)} (${String(info.rateLimitType ?? '')})`);
      } else if (type === 'result') {
        st.final = ev;
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

    if (st.blocked) throw new JobFailure('auth-blocked', st.blocked);
    if (st.authError) throw new JobFailure('auth-failed', st.authError);
    if (req.signal.aborted || res.reason === 'cancelled') throw new JobFailure('cancelled', 'Cancelled.');
    if (res.reason === 'timeout') {
      if (st.lastRetry === 'rate limited') throw new JobFailure('rate-limited', 'The provider kept rate-limiting the request until the timeout. Try again later.');
      throw new JobFailure('timeout', `Claude Code did not finish within ${Math.round(req.timeoutMs / 1000)}s. Increase the timeout in Settings or retry.`);
    }
    if (res.reason === 'spawn-error') throw new JobFailure('not-installed', `Could not start Claude Code: ${res.error}`);
    if (res.reason === 'output-limit') throw new JobFailure('malformed-output', 'Claude Code produced more output than allowed.');

    const result = st.final;
    if (!result) {
      const stderr = sanitizeCliText(res.stderr);
      const code = st.rateLimited ? 'rate-limited' : (classifyError(stderr) ?? (res.exitCode !== 0 ? 'nonzero-exit' : 'malformed-output'));
      throw new JobFailure(
        code,
        st.rateLimited ?? (res.exitCode !== 0 ? `Claude Code exited with code ${res.exitCode} without a result.` : 'Claude Code finished without a result event.'),
        [stderr && `stderr: ${stderr}`, st.malformed ? `${st.malformed} unparseable output line(s)` : ''].filter(Boolean),
      );
    }
    const resultText = typeof result.result === 'string' ? result.result : '';
    if (result.is_error || result.subtype !== 'success') {
      const msg = sanitizeCliText([resultText, String(result.subtype ?? ''), JSON.stringify(result.errors ?? '')].join(' '));
      const apiStatus = Number(result.api_error_status);
      const code = st.rateLimited
        ? 'rate-limited'
        : apiStatus === 429
          ? 'rate-limited'
          : apiStatus === 401 || apiStatus === 403
            ? 'auth-failed'
            : (classifyError(msg) ?? 'nonzero-exit');
      throw new JobFailure(code, `Claude Code reported an error: ${msg || result.subtype}`);
    }
    let output: unknown = result.structured_output;
    if (output === undefined || output === null) {
      try {
        output = parseJsonText(resultText);
      } catch {
        throw new JobFailure('malformed-output', 'Claude Code returned no structured output.', [sanitizeCliText(resultText, 800)]);
      }
    }
    const usageModels = result.modelUsage && typeof result.modelUsage === 'object' ? Object.keys(result.modelUsage) : [];
    return {
      output,
      model: st.model ?? usageModels[0] ?? null,
      usage: (result.usage as Record<string, unknown>) ?? null,
      durationMs: res.durationMs,
      rawFinal: resultText || JSON.stringify(output),
      eventCount: st.events,
    };
  }
}
