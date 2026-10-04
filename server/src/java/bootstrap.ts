import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Job, JavaStatus } from '@lld/shared';
import { JobFailure, type JobManager } from '../jobs.js';
import { LineSplitter, minimalEnv, startProcess } from '../proc.js';
import type { SettingsStore } from '../settings.js';
import { mavenPaths } from './toolchain.js';

/**
 * One-time toolchain preparation: builds and tests a throwaway copy of the starter template online,
 * which makes the Maven Wrapper download Maven and the plugins/JUnit artifacts into the cache.
 * Later builds run with `-o` (offline).
 */
export function startToolchainBootstrap(deps: {
  jobs: JobManager;
  settings: SettingsStore;
  dataRoot: string;
  templateDir: string;
  javaStatus: (refresh?: boolean) => Promise<JavaStatus>;
}): Job {
  const { job, existing } = deps.jobs.create({ kind: 'toolchain-bootstrap', dedupeKey: 'toolchain-bootstrap' });
  if (existing) return job;
  void deps.jobs.run(job.id, async (ctx) => {
    const java = await deps.javaStatus(true);
    if (!java.javaHome || !java.meetsRelease || !java.javacFound) throw new JobFailure('not-installed', java.detail);
    const dir = join(deps.dataRoot, 'builds', 'toolchain-bootstrap');
    rmSync(dir, { recursive: true, force: true });
    cpSync(deps.templateDir, dir, { recursive: true });
    for (const root of ['src/main/java', 'src/test/java']) {
      const from = join(dir, root, '__PACKAGE_PATH__');
      if (existsSync(from)) {
        mkdirSync(join(dir, root, 'bootstrap'), { recursive: true });
        for (const f of readdirSync(from)) renameSync(join(from, f), join(dir, root, 'bootstrap', f));
        rmSync(from, { recursive: true, force: true });
      }
    }
    const fill = (p: string) => {
      if (statSync(p).isDirectory()) return readdirSync(p).forEach((n) => fill(join(p, n)));
      if (!/\.(java|xml)$/.test(p)) return;
      writeFileSync(
        p,
        readFileSync(p, 'utf8').replace(/\{\{(\w+)\}\}/g, (_m, k: string) => ({ package: 'bootstrap', artifactId: 'bootstrap', title: 'Toolchain check', release: String(deps.settings.get().java.release) })[k] ?? ''),
      );
    };
    fill(dir);
    const mp = mavenPaths(deps.dataRoot, deps.settings.get());
    const args = ['-B', '-ntp', ...(mp.settingsFile ? ['-s', mp.settingsFile, `-Dmaven.repo.local=${mp.repository}`] : []), 'test'];
    ctx.progress('Downloading Maven 3.9.16 via the Maven Wrapper and resolving JUnit 5 / plugins (first run needs internet, ~25 MB)…');
    const splitter = new LineSplitter();
    const proc = startProcess({
      cmd: join(dir, 'mvnw'),
      args,
      cwd: dir,
      env: minimalEnv({
        JAVA_HOME: java.javaHome,
        PATH: `${join(java.javaHome, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
        MAVEN_USER_HOME: mp.userHome,
        MVNW_VERBOSE: 'true',
      }),
      timeoutMs: 15 * 60 * 1000,
      maxOutputBytes: 4 * 1024 * 1024,
      truncateInsteadOfKill: true,
      onStdout: (c) => splitter.push(c).forEach((l) => /Downloading from|Downloaded|BUILD|Tests run|ERROR|Couldn't|apache-maven/.test(l) && ctx.progress(l.slice(0, 300))),
      onStderr: (c) => c.split('\n').filter((l) => l.trim() && !/^\s*(inflating|creating|extracting):/.test(l)).forEach((l) => ctx.progress(l.slice(0, 300))),
    });
    ctx.setPid(proc.pid);
    const onAbort = () => proc.kill('cancelled');
    ctx.signal.addEventListener('abort', onAbort);
    const res = await proc.done;
    ctx.signal.removeEventListener('abort', onAbort);
    rmSync(dir, { recursive: true, force: true });
    if (res.reason === 'cancelled') throw new JobFailure('cancelled', 'Cancelled.');
    if (res.reason === 'timeout') throw new JobFailure('timeout', 'Toolchain download timed out.');
    if (res.exitCode !== 0) {
      const tail = (res.stdout + res.stderr).split('\n').filter((l) => /ERROR|error|fail/i.test(l)).slice(-8);
      throw new JobFailure('nonzero-exit', 'Maven could not prepare the toolchain. Check your internet connection or proxy settings.', tail);
    }
    const after = await deps.javaStatus(true);
    return { ok: true, distributionCached: after.maven.distributionCached, dependenciesCached: after.maven.dependenciesCached };
  });
  return job;
}
