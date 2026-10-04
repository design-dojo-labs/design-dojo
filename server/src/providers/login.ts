import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { LoginState, Settings } from '@lld/shared';
import { now } from '../db.js';
import type { EventBus } from '../events.js';
import { HttpError } from '../fs/paths.js';
import { startProcess, type RunningProcess } from '../proc.js';
import { cliEnv, resolveExecutable, sanitizeCliText } from './cli.js';

type LoginProvider = 'claude' | 'codex' | 'gemini';

/**
 * Starts the CLI's own subscription login flow (`claude auth login --claudeai`, `codex login`) so the
 * user can connect from the UI. The CLI opens the browser and stores its own credentials; this app
 * only relays the sign-in URL and exit status, and never reads or copies the resulting tokens.
 * The Gemini CLI has no separate login command (sign-in happens inside its interactive UI), so for
 * Gemini this only explains what to run in a terminal.
 */
export class LoginManager {
  private states = new Map<LoginProvider, LoginState>();
  private procs = new Map<LoginProvider, RunningProcess>();

  constructor(
    private bus: EventBus,
    private dataRoot: string,
    private onFinished: () => void,
  ) {}

  get(provider: LoginProvider): LoginState {
    return (
      this.states.get(provider) ?? {
        provider,
        state: 'idle',
        command: commandFor(provider).join(' '),
        output: '',
        urls: [],
        startedAt: null,
        finishedAt: null,
        message: null,
      }
    );
  }

  start(provider: LoginProvider, settings: Settings): LoginState {
    if (this.procs.has(provider)) return this.get(provider);
    const exe = resolveExecutable(provider, settings[provider].executablePath);
    if (!exe.path) throw new HttpError(412, exe.error ?? `${provider} CLI not found`);
    if (provider === 'gemini') {
      // Interactive-only sign-in: nothing is spawned; the user runs the CLI in a terminal.
      const state: LoginState = {
        provider,
        state: 'failed',
        command: 'gemini',
        output: '',
        urls: [],
        startedAt: now(),
        finishedAt: now(),
        message:
          'Gemini CLI signs in from its interactive terminal UI only. Open a terminal, run `gemini`, choose "Sign in with Google" (the account with your Google AI Pro/Ultra plan), finish in the browser, type /quit, then press Re-check.',
      };
      this.states.set(provider, state);
      this.publish(state);
      return state;
    }
    const [, ...args] = commandFor(provider);
    const cwd = join(this.dataRoot, 'ai-jobs', `login-${provider}`);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const state: LoginState = {
      provider,
      state: 'running',
      command: commandFor(provider).join(' '),
      output: '',
      urls: [],
      startedAt: now(),
      finishedAt: null,
      message: 'Follow the sign-in page that opens in your browser. If nothing opens, use the link below.',
    };
    this.states.set(provider, state);
    const onChunk = (c: string) => {
      state.output = sanitizeCliText(state.output + c.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, ''), 8000);
      for (const m of state.output.matchAll(/https:\/\/[^\s"'<>]+/g)) if (!state.urls.includes(m[0])) state.urls.push(m[0]);
      this.publish(state);
    };
    const proc = startProcess({
      cmd: exe.path,
      args,
      cwd,
      // Subscription login: never pass API keys to the login flow.
      env: cliEnv(),
      stdin: null,
      timeoutMs: 10 * 60 * 1000,
      maxOutputBytes: 256 * 1024,
      truncateInsteadOfKill: true,
      onStdout: onChunk,
      onStderr: onChunk,
    });
    this.procs.set(provider, proc);
    this.publish(state);
    proc.done.then((res) => {
      this.procs.delete(provider);
      state.finishedAt = now();
      if (res.reason === 'cancelled') {
        state.state = 'cancelled';
        state.message = 'Login cancelled.';
      } else if (res.reason === 'timeout') {
        state.state = 'failed';
        state.message = 'Login timed out after 10 minutes.';
      } else if (res.exitCode === 0) {
        state.state = 'succeeded';
        state.message = 'The CLI reported a successful login. Status refreshed.';
      } else {
        state.state = 'failed';
        state.message = `The login command exited with code ${res.exitCode ?? res.signal}. If it needs an interactive terminal, run \`${state.command}\` yourself.`;
      }
      this.publish(state);
      this.onFinished();
    });
    return state;
  }

  cancel(provider: LoginProvider): LoginState {
    this.procs.get(provider)?.kill('cancelled');
    return this.get(provider);
  }

  private publish(state: LoginState): void {
    this.bus.publish({ type: 'login', login: { ...state, urls: [...state.urls] } });
  }
}

function commandFor(provider: LoginProvider): string[] {
  return provider === 'claude' ? ['claude', 'auth', 'login', '--claudeai'] : provider === 'codex' ? ['codex', 'login'] : ['gemini'];
}
