import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { ProviderStatus, Settings } from '@lld/shared';
import { now } from '../db.js';
import { JobFailure } from '../jobs.js';
import { LineSplitter, startProcess } from '../proc.js';
import { runQuiet } from '../java/toolchain.js';
import { captureOutput, classifyError, cliEnv, parseJsonText, resolveExecutable, sanitizeCliText } from './cli.js';
import type { ProviderAdapter, StructuredRequest, StructuredResult } from './types.js';
import type { SecretStore } from '../secrets.js';

/**
 * Flags this adapter relies on (checked against `gemini --help`). `--policy` is required because the
 * deny-all policy file is what keeps every tool away from the model.
 */
const REQUIRED_FLAGS = ['--prompt', '--output-format', '--policy'];
const OPTIONAL_FLAGS = ['--model', '--skip-trust', '--extensions', '--allowed-mcp-server-names', '--approval-mode'];
/** Throttle for partial-output callbacks so a fast stream does not flood the event bus. */
const PARTIAL_INTERVAL_MS = 400;
/** A server name that never exists: passing it as the MCP allow-list keeps every configured MCP server from starting. */
const NO_MCP_SERVER = 'lld-studio-no-mcp';
/** Exit code the Gemini CLI uses for authentication failures (FATAL_AUTHENTICATION_ERROR). */
const EXIT_AUTH = 41;

/** Auth types stored by the Gemini CLI in `security.auth.selectedType`. Only a Google login is a subscription. */
const SUBSCRIPTION_AUTH = 'oauth-personal';
const AUTH_LABELS: Record<string, string> = {
  'oauth-personal': 'Google login',
  'gemini-api-key': 'Gemini API key',
  'vertex-ai': 'Vertex AI',
  'cloud-shell': 'Cloud Shell',
  'compute-default-credentials': 'Compute Engine default credentials',
  gateway: 'custom gateway',
};

/**
 * Variables that select or carry non-subscription credentials. The CLI only loads `.env` values for
 * variables that are not already present, so subscription runs set each of these to an empty string:
 * that both removes inherited values and stops a `~/.env` / `.gemini/.env` file from re-adding them.
 */
const NON_SUBSCRIPTION_ENV = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_GENAI_USE_GCA',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_ACCESS_TOKEN',
  'GOOGLE_GEMINI_BASE_URL',
  'GEMINI_CLI_USE_COMPUTE_ADC',
];

/** Deny every tool (built-in and MCP). Loaded with `--policy`, which also replaces the user's own policy directory. */
const DENY_ALL_POLICY = `# Written by LLD Practice Studio for one headless job: the model gets no tools at all.
[[rule]]
toolName = "*"
decision = "deny"
priority = 999
`;

/**
 * Workspace settings for the empty job folder (trusted via --skip-trust): no hooks, no agent skills and
 * no GEMINI.md context files, so the request contains only what the studio sends.
 */
const WORKSPACE_SETTINGS = {
  hooksConfig: { enabled: false },
  skills: { enabled: false },
  context: { fileName: 'LLD_STUDIO_NO_CONTEXT_FILE.md', includeDirectoryTree: false },
};

interface Capabilities {
  version: string;
  flags: Set<string>;
  missing: string[];
  streamJson: boolean;
}

interface LocalAuth {
  /** Auth type from settings (system settings override user settings), or null if none chosen. */
  selectedType: string | null;
  /** Whether cached Google OAuth credentials exist locally; null when they live in an encrypted store. */
  hasOAuthCreds: boolean | null;
  settingsPath: string;
}

/** Strips // and /* *\/ comments (outside strings) so JSONC settings files can be parsed. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function readSettingsFile(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const v = parseJsonc(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function selectedTypeOf(s: Record<string, unknown> | null): string | null {
  if (!s) return null;
  const sec = s.security as { auth?: { selectedType?: unknown } } | undefined;
  const t = sec?.auth?.selectedType ?? s.selectedAuthType; // older CLI versions used a top-level key
  return typeof t === 'string' && t ? t : null;
}

/** The CLI's global folder: `$GEMINI_CLI_HOME/.gemini`, else `~/.gemini`. */
function geminiDir(): string {
  return join(process.env.GEMINI_CLI_HOME || homedir(), '.gemini');
}

function systemSettingsPath(): string {
  if (process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH) return process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
  if (platform() === 'darwin') return '/Library/Application Support/GeminiCli/settings.json';
  if (platform() === 'win32') return 'C:\\ProgramData\\gemini-cli\\settings.json';
  return '/etc/gemini-cli/settings.json';
}

/** Reads the CLI's chosen auth type and whether Google credentials are cached. Local files only, no network. */
function localAuth(): LocalAuth {
  const dir = geminiDir();
  const userPath = join(dir, 'settings.json');
  const selectedType = selectedTypeOf(readSettingsFile(systemSettingsPath())) ?? selectedTypeOf(readSettingsFile(userPath));
  // With GEMINI_FORCE_ENCRYPTED_FILE_STORAGE the token lives in the OS keychain or an encrypted file we cannot inspect.
  const hasOAuthCreds = process.env.GEMINI_FORCE_ENCRYPTED_FILE_STORAGE === 'true' ? null : existsSync(join(dir, 'oauth_creds.json'));
  return { selectedType, hasOAuthCreds, settingsPath: userPath };
}

/** Extracts the JSON object from the model's final text: whole text, a fenced block, or the outermost braces. */
function extractJson(text: string): unknown {
  try {
    return parseJsonText(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error('final message is not valid JSON');
  }
}

/** The answer text as it streams, without a leading Markdown fence; null until it looks like JSON. */
function partialJsonOf(text: string): string | null {
  const t = text.trimStart().replace(/^```(?:json)?\s*/i, '');
  return t.startsWith('{') ? t : null;
}

/**
 * Gemini CLI adapter: headless `gemini -p` with `--output-format stream-json`, run from an empty
 * per-job folder. Every tool is denied by a policy file (denied tools are not even offered to the
 * model), configured MCP servers and extensions are not loaded, hooks/skills/context files are
 * switched off for the job folder, and any tool-call event aborts the job. The Gemini CLI has no
 * JSON-schema flag, so the schema is appended to the prompt and the answer is validated by the caller.
 */
export class GeminiAdapter implements ProviderAdapter {
  id = 'gemini' as const;
  label = 'Gemini CLI';
  private caps = new Map<string, Capabilities>();

  constructor(private secrets: SecretStore) {}

  /**
   * Child environment. Subscription mode blanks every API-key/Vertex/gateway variable. API-key mode
   * passes only GEMINI_API_KEY and points GEMINI_CLI_HOME at an empty folder, so a Google login stored
   * in ~/.gemini/settings.json cannot take precedence over the key.
   */
  private env(settings: Settings, isolatedHome: string | null): { env: Record<string, string>; keyHint: string | null; keySource: string | null } {
    const base = cliEnv({ NO_BROWSER: 'true', NO_COLOR: '1' });
    for (const k of NON_SUBSCRIPTION_ENV) base[k] = '';
    if (settings.gemini.authMode !== 'api-key') return { env: base, keyHint: null, keySource: null };
    const key = this.secrets.resolve('gemini');
    if (!key) return { env: base, keyHint: null, keySource: null };
    const env: Record<string, string> = { ...base, GEMINI_API_KEY: key.key };
    if (isolatedHome) env.GEMINI_CLI_HOME = isolatedHome;
    return { env, keyHint: `…${key.key.slice(-4)}`, keySource: key.source === 'stored' ? 'saved in Settings' : `$${key.envVar}` };
  }

  private async capabilities(exe: string): Promise<Capabilities> {
    const v = await runQuiet(exe, ['--version'], cliEnv({ NO_COLOR: '1' }));
    const version = (v.stdout || v.stderr).trim().split('\n')[0] ?? '';
    const key = `${exe}@${version}`;
    const cached = this.caps.get(key);
    if (cached) return cached;
    const text = await captureOutput(exe, ['--help'], cliEnv({ NO_COLOR: '1' }));
    const flags = new Set([...REQUIRED_FLAGS, ...OPTIONAL_FLAGS].filter((f) => text.includes(f)));
    const caps = { version, flags, missing: REQUIRED_FLAGS.filter((f) => !flags.has(f)), streamJson: text.includes('stream-json') };
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
      authMode: settings.gemini.authMode,
    } satisfies Partial<ProviderStatus>;
    const exe = resolveExecutable('gemini', settings.gemini.executablePath);
    if (!exe.path) {
      return { ...base, state: 'not-installed', executable: null, version: null, detail: `${exe.error} Install with \`npm i -g @google/gemini-cli\`, then run \`gemini\` once and choose Sign in with Google.` };
    }
    const caps = await this.capabilities(exe.path);
    if (!caps.version) return { ...base, state: 'error', executable: exe.path, version: null, detail: 'Could not read `gemini --version`.' };
    if (caps.missing.length) {
      return { ...base, state: 'error', executable: exe.path, version: caps.version, detail: `This Gemini CLI version lacks required flags (${caps.missing.join(', ')}). Update with \`npm i -g @google/gemini-cli\`.` };
    }
    const common = { ...base, executable: exe.path, version: caps.version };
    if (settings.gemini.authMode === 'api-key') {
      const mode = this.env(settings, null);
      if (!mode.keyHint) {
        return { ...common, state: 'unauthenticated', detail: 'API-key mode is selected but no Gemini API key is configured. Add one in Settings or switch back to Google login.' };
      }
      return {
        ...common,
        state: 'installed',
        authMethod: 'api-key',
        detail: `API-key mode: using key ${mode.keyHint} (${mode.keySource}) via GEMINI_API_KEY, with an isolated CLI home so your Google login is not used. Usage is billed per token to that Google AI Studio project. Run "Test connection" to verify the key.`,
      };
    }
    // Subscription mode: the CLI's stored choice decides how headless runs authenticate (it wins over env variables).
    const auth = localAuth();
    if (!auth.selectedType) {
      return {
        ...common,
        state: 'unauthenticated',
        detail: 'Not logged in. Run `gemini` in a terminal, choose "Sign in with Google" (use the Google account with your Google AI Pro/Ultra plan), finish in the browser, exit with /quit, then press Re-check.',
      };
    }
    const method = AUTH_LABELS[auth.selectedType] ?? auth.selectedType;
    if (auth.selectedType !== SUBSCRIPTION_AUTH) {
      return {
        ...common,
        state: 'auth-blocked',
        authMethod: method,
        detail: `Gemini CLI is set to authenticate with ${method}, not a Google login. Subscription mode never uses API keys or cloud credentials, so AI jobs are blocked. Run \`gemini\`, use /auth to choose "Sign in with Google", or switch this provider to API-key mode in Settings.`,
      };
    }
    const sub = { authMethod: method, subscription: 'Google account (Gemini Code Assist / Google AI plan)' };
    if (auth.hasOAuthCreds === false) {
      return { ...common, ...sub, state: 'unauthenticated', detail: 'Google login is selected but no cached credentials were found. Run `gemini` in a terminal and sign in with Google again, then press Re-check.' };
    }
    if (auth.hasOAuthCreds === null) {
      return { ...common, ...sub, state: 'installed', detail: 'Google login is selected; its credentials are in an encrypted store that cannot be checked locally. Run a connection test.' };
    }
    return { ...common, ...sub, state: 'authenticated', detail: 'Signed in with Google. Usage counts against the quota of that account (Google AI Pro/Ultra plans get higher limits).' };
  }

  async runStructured(settings: Settings, req: StructuredRequest): Promise<StructuredResult> {
    const exe = resolveExecutable('gemini', settings.gemini.executablePath);
    if (!exe.path) throw new JobFailure('not-installed', exe.error ?? 'Gemini CLI not found.');
    const caps = await this.capabilities(exe.path);
    if (caps.missing.length) throw new JobFailure('not-installed', `Gemini CLI ${caps.version} lacks required flags: ${caps.missing.join(', ')}.`);
    const status = await this.status(settings);
    if (status.state === 'auth-blocked') throw new JobFailure('auth-blocked', status.detail);
    if (status.state === 'unauthenticated') throw new JobFailure('auth-failed', status.detail);
    const apiKeyMode = settings.gemini.authMode === 'api-key';

    // Layout: <workDir>/deny-all-tools.toml (policy, outside the CLI's workspace) and an otherwise empty
    // <workDir>/cwd with workspace settings. Nothing in cwd can be matched by an @path in the prompt.
    const policyFile = join(req.workDir, 'deny-all-tools.toml');
    writeFileSync(policyFile, DENY_ALL_POLICY);
    const cwd = join(req.workDir, 'cwd');
    mkdirSync(join(cwd, '.gemini'), { recursive: true });
    writeFileSync(join(cwd, '.gemini', 'settings.json'), JSON.stringify(WORKSPACE_SETTINGS, null, 2));
    let isolatedHome: string | null = null;
    if (apiKeyMode) {
      isolatedHome = join(req.workDir, 'home');
      mkdirSync(isolatedHome, { recursive: true });
    }
    const mode = this.env(settings, isolatedHome);

    const outputFormat = caps.streamJson ? 'stream-json' : 'json';
    const args = ['--prompt', 'Reply with only the JSON object described above.', '--output-format', outputFormat, '--policy', policyFile];
    if (caps.flags.has('--approval-mode')) args.push('--approval-mode', 'default'); // never inherit a yolo default from user settings
    if (caps.flags.has('--skip-trust')) args.push('--skip-trust'); // the empty job folder; untrusted folders abort headless runs
    if (caps.flags.has('--extensions')) args.push('--extensions', 'none');
    if (caps.flags.has('--allowed-mcp-server-names')) args.push('--allowed-mcp-server-names', NO_MCP_SERVER);
    const model = req.model === undefined ? settings.gemini.model.trim() || null : req.model;
    if (model && caps.flags.has('--model')) args.push('--model', model);
    // No effort flag exists: thinking is only configurable through settings.json modelConfigs, which the studio does not touch.

    const prompt = [
      req.prompt,
      '',
      '## OUTPUT FORMAT (strict)',
      'Respond with exactly one JSON object and nothing else: no prose before or after it and no Markdown code fences.',
      'Do not try to use tools; none are available. The object must validate against this JSON Schema:',
      '<json_schema>',
      JSON.stringify(req.schema),
      '</json_schema>',
    ].join('\n');

    req.onProgress(
      `Starting Gemini CLI ${caps.version}${model ? ` (model ${model})` : ''} · ${apiKeyMode ? `API key ${mode.keyHint} (billed per token)` : 'Google login'}…`,
    );
    const splitter = new LineSplitter();
    const st = {
      events: 0,
      malformed: 0,
      model: null as string | null,
      text: '',
      result: null as Record<string, unknown> | null,
      errors: [] as string[],
      violation: null as string | null,
      announcedWriting: false,
      lastPartialAt: 0,
    };
    const emitPartial = (force = false) => {
      if (!req.onPartial) return;
      const partial = partialJsonOf(st.text);
      if (!partial) return;
      const t = Date.now();
      if (!force && t - st.lastPartialAt < PARTIAL_INTERVAL_MS) return;
      st.lastPartialAt = t;
      req.onPartial(partial);
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
      if (outputFormat === 'json') {
        // Single object: { response, stats, error? }.
        st.result = ev;
        if (typeof ev.response === 'string') st.text = ev.response;
        return;
      }
      if (type === 'init') {
        st.model = typeof ev.model === 'string' ? ev.model : null;
        req.onProgress(`Gemini CLI session started${st.model ? ` · model ${st.model}` : ''}`);
      } else if (type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
        if (!st.announcedWriting) {
          st.announcedWriting = true;
          req.onProgress('Writing the structured answer…');
        }
        st.text = ev.delta === false ? ev.content : st.text + ev.content;
        emitPartial();
      } else if (type === 'tool_use' || type === 'tool_result') {
        if (!st.violation) {
          st.violation = `Gemini attempted a tool call (${String(ev.tool_name ?? ev.tool_id ?? 'unknown')}), which AI jobs in this app do not allow.`;
          proc.kill('cancelled');
        }
      } else if (type === 'error') {
        const msg = String(ev.message ?? '');
        st.errors.push(msg);
        req.onProgress(`Gemini CLI ${ev.severity === 'error' ? 'error' : 'warning'}: ${sanitizeCliText(msg, 200)}`);
      } else if (type === 'result') {
        st.result = ev;
        emitPartial(true);
      }
    };

    const proc = startProcess({
      cmd: exe.path,
      args,
      cwd,
      env: mode.env,
      stdin: prompt,
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
    if (res.reason === 'timeout') throw new JobFailure('timeout', `Gemini CLI did not finish within ${Math.round(req.timeoutMs / 1000)}s. Increase the timeout in Settings or retry.`);
    if (res.reason === 'spawn-error') throw new JobFailure('not-installed', `Could not start Gemini CLI: ${res.error}`);
    if (res.reason === 'output-limit') throw new JobFailure('malformed-output', 'Gemini CLI produced more output than allowed.');

    const stderr = sanitizeCliText(res.stderr);
    const resultError = (st.result?.error ?? null) as { type?: unknown; message?: unknown } | null;
    const failed = res.exitCode !== 0 || st.result?.status === 'error' || !!resultError;
    if (failed || !st.text.trim()) {
      const msg = sanitizeCliText([resultError ? `${String(resultError.type ?? '')} ${String(resultError.message ?? '')}` : '', ...st.errors, stderr].filter(Boolean).join('\n'), 800);
      const code =
        res.exitCode === EXIT_AUTH || /FatalAuthenticationError|Manual authorization is required/i.test(msg)
          ? 'auth-failed'
          : /RESOURCE_EXHAUSTED|exhausted your|quota/i.test(msg)
            ? 'rate-limited'
            : (classifyError(msg) ?? (res.exitCode !== 0 ? 'nonzero-exit' : 'malformed-output'));
      throw new JobFailure(
        code,
        res.exitCode !== 0 ? `Gemini CLI exited with code ${res.exitCode}${msg ? `: ${msg}` : '.'}` : msg ? `Gemini CLI reported an error: ${msg}` : 'Gemini CLI finished without an answer.',
        [st.malformed ? `${st.malformed} unparseable event line(s)` : ''].filter(Boolean),
      );
    }
    let output: unknown;
    try {
      output = extractJson(st.text);
    } catch {
      throw new JobFailure('malformed-output', 'Gemini CLI returned a final message that is not valid JSON.', [sanitizeCliText(st.text, 800)]);
    }
    const stats = (st.result?.stats ?? null) as Record<string, unknown> | null;
    const statModels = stats?.models && typeof stats.models === 'object' ? Object.keys(stats.models as object) : [];
    return {
      output,
      model: st.model ?? statModels[0] ?? model,
      usage: stats,
      durationMs: res.durationMs,
      rawFinal: st.text,
      eventCount: st.events,
    };
  }
}
