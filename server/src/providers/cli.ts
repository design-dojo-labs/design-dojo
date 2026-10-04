import { accessSync, closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import type { ErrorCode } from '@lld/shared';

/** Environment variables that would switch a CLI to pay-as-you-go API billing, or leak credentials. */
const STRIPPED_ENV = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  // Set when this server itself was launched from inside a Claude Code session.
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT',
  // Studio internals.
  'LLD_STUDIO_ENABLE_MOCK',
];

/**
 * Environment for a provider CLI. All API-key variables are removed; in API-key mode the caller
 * adds back exactly the one variable the CLI documents for that purpose.
 */
export function cliEnv(apiKey: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || STRIPPED_ENV.includes(k)) continue;
    env[k] = v;
  }
  return { ...env, ...apiKey };
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves a CLI binary: an explicit absolute override, otherwise PATH plus common install
 * locations. Never runs through a shell.
 */
export function resolveExecutable(name: string, override: string): { path: string | null; error: string | null } {
  if (override) {
    if (!isAbsolute(override)) return { path: null, error: 'Executable path override must be an absolute path.' };
    if (!existsSync(override)) return { path: null, error: `No file at ${override}.` };
    if (!isExecutableFile(override)) return { path: null, error: `${override} is not an executable file.` };
    return { path: override, error: null };
  }
  const home = homedir();
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].filter(Boolean);
  for (const d of dirs) {
    const p = join(d, name);
    if (isExecutableFile(p)) return { path: p, error: null };
  }
  return { path: null, error: `"${name}" was not found on PATH or in common install locations.` };
}

/** Maps CLI error text to a stable error code. Unknown failures stay generic — never guessed as success. */
export function classifyError(text: string): ErrorCode | null {
  const t = text.toLowerCase();
  if (/usage limit|rate.?limit|too many requests|\b429\b|quota|usage_limit_reached|limit reached|overloaded/.test(t)) return 'rate-limited';
  if (/not logged in|please run \/login|log ?in again|unauthori[sz]ed|\b401\b|\b403\b|authentication|invalid api key|invalid bearer|missing bearer|oauth token|expired token|token expired/.test(t)) {
    return 'auth-failed';
  }
  return null;
}

/** Trims and redacts CLI output before it is stored or shown (never echo secrets-looking strings). */
export function sanitizeCliText(text: string, max = 1500): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .replace(/(bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1***')
    .replace(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<jwt>')
    .slice(-max)
    .trim();
}

/** Extracts a JSON object from a model's final text (tolerates a fenced code block). */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) return JSON.parse(fence[1]);
    throw new Error('final message is not valid JSON');
  }
}

/**
 * Captures a CLI's help/listing output through a file descriptor rather than a pipe. Some CLIs exit
 * before flushing a large piped stdout (help text was cut off at 16 KB), which would make supported
 * flags look missing; writes to a file are synchronous and complete.
 */
export function captureOutput(exe: string, args: string[], env: Record<string, string>, timeoutMs = 15000): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'lld-cli-'));
  const file = join(dir, 'out.txt');
  const fd = openSync(file, 'w', 0o600);
  return new Promise<string>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
      let text = '';
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        text = '';
      }
      rmSync(dir, { recursive: true, force: true });
      resolve(text);
    };
    const child = spawn(exe, args, { env, stdio: ['ignore', fd, fd] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish();
    }, timeoutMs);
    child.on('error', finish);
    child.on('close', finish);
  });
}
