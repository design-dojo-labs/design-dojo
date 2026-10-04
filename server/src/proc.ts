import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { execFileSync } from 'node:child_process';

export type ExitReason = 'exit' | 'timeout' | 'cancelled' | 'output-limit' | 'spawn-error';

export interface ProcessOptions {
  cmd: string;
  /** Always an argument array — commands are never passed through a shell. */
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string | null;
  timeoutMs: number;
  /** Combined stdout+stderr bytes retained; exceeding it kills the process (reason 'output-limit'). */
  maxOutputBytes: number;
  /** When true, output past the cap is dropped silently instead of killing the process. */
  truncateInsteadOfKill?: boolean;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ProcessResult {
  reason: ExitReason;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  error: string | null;
}

export interface RunningProcess {
  pid: number | null;
  done: Promise<ProcessResult>;
  kill: (reason?: 'cancelled' | 'timeout') => void;
}

const live = new Map<number, ChildProcess>();

/**
 * Spawns a child in its own process group so that cancellation and timeouts also terminate
 * grandchildren (e.g. the JVM forked by Maven Surefire). Escalates SIGTERM → SIGKILL.
 */
export function startProcess(opts: ProcessOptions): RunningProcess {
  const started = Date.now();
  let child: ChildProcess;
  try {
    child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (e) {
    const msg = (e as Error).message;
    return {
      pid: null,
      kill: () => {},
      done: Promise.resolve({ reason: 'spawn-error', exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, durationMs: 0, error: msg }),
    };
  }

  let stdout = '';
  let stderr = '';
  let bytes = 0;
  let truncated = false;
  let reason: ExitReason = 'exit';
  let killTimer: NodeJS.Timeout | null = null;
  let spawnError: string | null = null;

  const killGroup = (sig: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };

  const kill = (why: 'cancelled' | 'timeout' | 'output-limit' = 'cancelled') => {
    if (reason !== 'exit') return;
    reason = why;
    killGroup('SIGTERM');
    killTimer = setTimeout(() => killGroup('SIGKILL'), 2000);
    killTimer.unref();
  };

  const take = (chunk: string, which: 'out' | 'err') => {
    if (!chunk) return;
    const len = Buffer.byteLength(chunk);
    if (bytes + len > opts.maxOutputBytes) {
      const room = Math.max(0, opts.maxOutputBytes - bytes);
      chunk = room > 0 ? Buffer.from(chunk).subarray(0, room).toString('utf8') : '';
      truncated = true;
      if (!opts.truncateInsteadOfKill) kill('output-limit');
    }
    bytes += Buffer.byteLength(chunk);
    if (!chunk) return;
    if (which === 'out') {
      stdout += chunk;
      opts.onStdout?.(chunk);
    } else {
      stderr += chunk;
      opts.onStderr?.(chunk);
    }
  };

  const outDec = new StringDecoder('utf8');
  const errDec = new StringDecoder('utf8');
  child.stdout?.on('data', (b: Buffer) => take(outDec.write(b), 'out'));
  child.stderr?.on('data', (b: Buffer) => take(errDec.write(b), 'err'));
  child.stdin?.on('error', () => {
    /* EPIPE when the child exits before reading stdin */
  });
  if (opts.stdin != null) child.stdin?.end(opts.stdin);
  else child.stdin?.end();

  const timer = setTimeout(() => kill('timeout'), opts.timeoutMs);
  timer.unref();
  if (child.pid) live.set(child.pid, child);

  const done = new Promise<ProcessResult>((resolve) => {
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (child.pid) {
        live.delete(child.pid);
        // Reap any stragglers left in the group (e.g. a forked JVM that ignored SIGTERM).
        if (reason !== 'exit') killGroup('SIGKILL');
      }
      take(outDec.end(), 'out');
      take(errDec.end(), 'err');
      resolve({
        reason: spawnError && code === null ? 'spawn-error' : reason,
        exitCode: code,
        signal: signal ?? null,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - started,
        error: spawnError,
      });
    });
  });

  return { pid: child.pid ?? null, done, kill: (why) => kill(why ?? 'cancelled') };
}

/** Kills every process group still running (used on shutdown). */
export function killAllLive(): void {
  for (const [pid, child] of live) {
    try {
      if (process.platform !== 'win32') process.kill(-pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  live.clear();
}

/**
 * Terminates an orphaned process group from a previous server run, but only if the pid still
 * belongs to a process whose command line contains `marker` (guards against pid reuse).
 */
export function killOrphan(pid: number, marker: string): boolean {
  if (process.platform === 'win32' || !pid) return false;
  try {
    const cmd = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 }).trim();
    if (!cmd || !cmd.includes(marker)) return false;
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}

/** Splits streamed text into complete lines, buffering the trailing partial line. */
export class LineSplitter {
  private buf = '';
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  }
  flush(): string[] {
    const rest = this.buf;
    this.buf = '';
    return rest ? [rest] : [];
  }
}

/** Minimal environment for learner-code processes: no provider credentials, tokens or unrelated variables. */
export function minimalEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
  };
  if (process.env.USER) env.USER = process.env.USER;
  return { ...env, ...extra };
}
