import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp, type BuildOptions } from '../src/app.js';
import type { Job } from '@lld/shared';

export const FIXTURES = resolve(__dirname, 'fixtures');
export const FAKE_CLAUDE = join(FIXTURES, 'fake-claude.mjs');
export const FAKE_CODEX = join(FIXTURES, 'fake-codex.mjs');
/** Shared Maven cache for Java tests, prepared once (first run downloads ~25 MB). */
export const SHARED_MAVEN = resolve(__dirname, '..', '..', '.lld-test-data', 'maven');

/** Restores write permission (snapshots are read-only by design) and removes a test directory. */
function forceRemove(dir: string): void {
  const walk = (p: string) => {
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) {
      chmodSync(p, 0o755);
      for (const n of readdirSync(p)) walk(join(p, n));
    } else chmodSync(p, 0o644);
  };
  walk(dir);
  rmSync(dir, { recursive: true, force: true });
}

export function tempDir(prefix = 'lld-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => forceRemove(dir) };
}

export async function testApp(opts: BuildOptions = {}) {
  const t = tempDir();
  mkdirSync(SHARED_MAVEN, { recursive: true });
  const built = await buildApp({ ...opts, config: { port: 4399, mockEnabled: true, ...(opts.config ?? {}), dataRoot: t.dir } });
  return {
    ...built,
    dataRoot: t.dir,
    async dispose() {
      await built.close();
      t.cleanup();
    },
  };
}

export async function waitForJob(ctx: Awaited<ReturnType<typeof testApp>>['ctx'], jobId: string, timeoutMs = 120_000): Promise<Job> {
  const start = Date.now();
  for (;;) {
    const j = ctx.jobs.get(jobId)!;
    if (!['queued', 'running'].includes(j.state)) return j;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} still ${j.state}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Headers for state-changing requests through app.inject. */
export function authHeaders(token: string) {
  return { host: '127.0.0.1:4399', 'x-studio-token': token, 'content-type': 'application/json' };
}
