import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Diagnostic, ExecKind, ExecRun, JavaStatus, TestSummary } from '@lld/shared';
import { type DB, json, now } from '../db.js';
import type { EventBus } from '../events.js';
import type { SettingsStore } from '../settings.js';
import { HttpError } from '../fs/paths.js';
import { MANAGED_PATHS, sha256 } from '../fs/workspace.js';
import { minimalEnv, startProcess, type ProcessResult, type RunningProcess } from '../proc.js';
import { detectMainClasses, isValidClassName, parseMavenDiagnostics, parseSurefireReports, splitArgs } from './parse.js';
import { mavenPaths } from './toolchain.js';
import { Workspace } from '../fs/workspace.js';

export const RUN_MARKER = 'lldstudio.run';
const MAX_GLOBAL_PROCESSES = 3;

interface ActiveRun {
  run: ExecRun;
  proc: RunningProcess | null;
  cancelled: boolean;
}

export interface StartOptions {
  sessionId: string;
  /** Directory that contains pom.xml (a live workspace or a submission build copy). */
  buildRoot: string;
  submissionId?: string | null;
  kind: ExecKind;
  mainClass?: string | null;
  args?: string;
  stdin?: string;
}

/**
 * Compiles, runs and tests learner projects with the controlled Maven Wrapper build.
 * Host execution runs with the local user's privileges: timeouts and output caps keep the
 * server responsive but are NOT a security sandbox.
 */
export class JavaRunner {
  private active = new Map<string, ActiveRun>(); // keyed by sessionId (or submission build key)

  constructor(
    private db: DB,
    private bus: EventBus,
    private settings: SettingsStore,
    private dataRoot: string,
    private templateDir: string,
    private javaStatus: () => Promise<JavaStatus>,
  ) {}

  isBusy(key: string): boolean {
    return this.active.has(key);
  }

  /** Starts a run and returns immediately; completion is published as exec-state events. */
  async start(opts: StartOptions): Promise<{ run: ExecRun; done: Promise<ExecRun> }> {
    const key = opts.submissionId ? `submission:${opts.submissionId}` : opts.sessionId;
    if (this.active.has(key)) throw new HttpError(409, 'Another compile/run/test is already running for this session. Stop it first.');
    if (this.active.size >= MAX_GLOBAL_PROCESSES) throw new HttpError(429, 'Too many Java processes are running. Wait for one to finish.');
    const java = await this.javaStatus();
    if (!java.ok || !java.javaHome) throw new HttpError(412, `Java toolchain not ready: ${java.detail}`);

    let mainClass: string | null = null;
    let argv: string[] = [];
    if (opts.kind === 'run') {
      const mains = this.findMainClasses(opts.buildRoot);
      mainClass = opts.mainClass || mains[0] || null;
      if (!mainClass) throw new HttpError(400, 'No class with a main method was found under src/main/java.');
      if (!isValidClassName(mainClass)) throw new HttpError(400, 'Main class must be a fully-qualified Java class name.');
      try {
        argv = splitArgs(opts.args ?? '');
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }

    const run: ExecRun = {
      id: randomUUID(),
      sessionId: opts.sessionId,
      submissionId: opts.submissionId ?? null,
      kind: opts.kind,
      state: 'running',
      phase: opts.kind === 'run' ? 'compile' : opts.kind,
      exitCode: null,
      startedAt: now(),
      finishedAt: null,
      durationMs: null,
      stdout: '',
      stderr: '',
      truncated: false,
      diagnostics: [],
      tests: null,
      mainClass,
      command: '',
    };
    const entry: ActiveRun = { run, proc: null, cancelled: false };
    this.active.set(key, entry);
    this.db
      .prepare(`INSERT INTO exec_runs (id, session_id, submission_id, kind, state, phase, main_class, command, started_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(run.id, run.sessionId, run.submissionId, run.kind, run.state, run.phase, mainClass, '', run.startedAt);
    this.bus.publish({ type: 'exec-state', run: { ...run } });

    const done = this.execute(entry, opts, java, mainClass, argv)
      .catch((e) => {
        this.system(run, `Internal error: ${(e as Error).message}\n`);
        run.state = 'failed';
        return run;
      })
      .finally(() => {
        this.active.delete(key);
        run.finishedAt = now();
        run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
        this.persist(run);
        this.bus.publish({ type: 'exec-state', run: { ...run } });
      });
    return { run: { ...run }, done };
  }

  stop(runId: string): boolean {
    for (const entry of this.active.values()) {
      if (entry.run.id === runId) {
        entry.cancelled = true;
        entry.proc?.kill('cancelled');
        return true;
      }
    }
    return false;
  }

  stopAll(): void {
    for (const entry of this.active.values()) {
      entry.cancelled = true;
      entry.proc?.kill('cancelled');
    }
  }

  get(runId: string): ExecRun | null {
    for (const e of this.active.values()) if (e.run.id === runId) return { ...e.run };
    const row = this.db.prepare('SELECT * FROM exec_runs WHERE id = ?').get(runId);
    return row ? rowToRun(row as RunRow) : null;
  }

  latestForSession(sessionId: string): ExecRun[] {
    const stmt = this.db.prepare(`SELECT * FROM exec_runs WHERE session_id = ? AND kind = ? AND submission_id IS NULL ORDER BY started_at DESC LIMIT 1`);
    const rows = (['compile', 'run', 'test'] as const).map((k) => stmt.get(sessionId, k) as RunRow | undefined).filter((r): r is RunRow => !!r);
    return rows.map((r) => {
      for (const e of this.active.values()) if (e.run.id === r.id) return { ...e.run };
      return rowToRun(r);
    });
  }

  findMainClasses(buildRoot: string): string[] {
    const ws = new Workspace(buildRoot, join(this.dataRoot, 'trash'));
    const { files } = ws.collectSources();
    return detectMainClasses(files.filter((f) => f.rel.endsWith('.java')).map((f) => ({ rel: f.rel, content: readFileSync(f.abs, 'utf8') })));
  }

  /** Restores managed build-template files that were modified or removed outside the studio. */
  ensureManagedFiles(buildRoot: string): string[] {
    const restored: string[] = [];
    for (const rel of MANAGED_PATHS) {
      const src = join(this.templateDir, rel);
      const dst = join(buildRoot, rel);
      const want = sha256(readFileSync(src));
      const have = existsSync(dst) ? sha256(readFileSync(dst)) : null;
      if (want !== have) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        restored.push(rel);
      }
    }
    try {
      if ((statSync(join(buildRoot, 'mvnw')).mode & 0o111) === 0) chmodSync(join(buildRoot, 'mvnw'), 0o755);
    } catch {
      /* restored above */
    }
    return restored;
  }

  private async execute(entry: ActiveRun, opts: StartOptions, java: JavaStatus, mainClass: string | null, argv: string[]): Promise<ExecRun> {
    const run = entry.run;
    const s = this.settings.get();
    const restored = this.ensureManagedFiles(opts.buildRoot);
    if (restored.length) this.system(run, `Restored managed build files that differed from the template: ${restored.join(', ')}\n`);
    if (!existsSync(join(opts.buildRoot, 'pom.xml'))) {
      this.system(run, 'pom.xml is missing from the project root; cannot build.\n');
      run.state = 'failed';
      return run;
    }

    const mvnGoal = opts.kind === 'test' ? 'test' : opts.kind === 'compile' ? 'test-compile' : 'compile';
    if (opts.kind === 'test') rmSync(join(opts.buildRoot, 'target', 'surefire-reports'), { recursive: true, force: true });
    const mvn = await this.mavenInvocation(opts.buildRoot, java, mvnGoal, run.id, s.java.testTimeoutSec);
    run.command = `./mvnw ${mvn.args.filter((a) => !a.startsWith('-Dmaven.repo.local') && !a.startsWith('-s') && !a.includes(this.dataRoot)).join(' ')}`;
    this.system(run, `$ ${run.command}\n`);
    if (!java.maven.dependenciesCached) {
      this.system(run, 'First build: Maven Wrapper is downloading Maven and JUnit (~25 MB). Later builds work offline.\n');
    }
    const timeoutMs = (opts.kind === 'test' ? s.java.testTimeoutSec : s.java.compileTimeoutSec) * 1000;
    const res = await this.spawnTracked(entry, {
      cmd: join(opts.buildRoot, 'mvnw'),
      args: mvn.args,
      cwd: opts.buildRoot,
      env: mvn.env,
      timeoutMs,
      maxOutputBytes: Math.max(s.java.maxOutputKb, 2048) * 1024,
      truncateInsteadOfKill: true,
    });
    run.diagnostics = parseMavenDiagnostics(res.stdout + '\n' + res.stderr, opts.buildRoot);
    run.exitCode = res.exitCode;

    if (opts.kind === 'test') {
      run.tests = parseSurefireReports(join(opts.buildRoot, 'target', 'surefire-reports'));
    }
    if (res.reason !== 'exit') {
      run.state = mapReason(res.reason, entry.cancelled);
      this.system(run, `\n${describeStop(run.state, timeoutMs)}\n`);
      return run;
    }
    if (res.exitCode !== 0) {
      run.state = 'failed';
      run.phase = 'compile';
      const errs = run.diagnostics.filter((d) => d.severity === 'error').length;
      this.system(run, `\nBuild failed with exit code ${res.exitCode}${errs ? ` (${errs} compiler error${errs > 1 ? 's' : ''})` : ''}.\n`);
      return run;
    }
    if (opts.kind === 'compile') {
      run.state = 'succeeded';
      this.system(run, '\nCompilation succeeded.\n');
      return run;
    }
    if (opts.kind === 'test') {
      const t = run.tests;
      if (!t) {
        run.state = 'succeeded';
        run.phase = 'tests';
        this.system(run, '\nBuild succeeded but no test reports were produced (no tests found).\n');
        return run;
      }
      run.phase = 'tests';
      run.state = t.failed + t.errored > 0 ? 'failed' : 'succeeded';
      this.system(run, `\nTests: ${t.passed} passed, ${t.failed} failed, ${t.errored} errored, ${t.skipped} skipped.\n`);
      return run;
    }

    // kind === 'run': compiled main sources; now launch the JVM directly so stdin/args/timeout are ours.
    run.phase = 'run';
    const javaBin = join(java.javaHome!, 'bin', 'java');
    const args = ['-Xmx512m', '-XX:+UseSerialGC', '-Dfile.encoding=UTF-8', `-D${RUN_MARKER}=${run.id}`, '-cp', 'target/classes', mainClass!, ...argv];
    run.command = `java -cp target/classes ${mainClass}${argv.length ? ' ' + argv.map(quoteForDisplay).join(' ') : ''}`;
    this.system(run, `$ ${run.command}\n`);
    const runTimeout = s.java.runTimeoutSec * 1000;
    const r = await this.spawnTracked(entry, {
      cmd: javaBin,
      args,
      cwd: opts.buildRoot,
      env: minimalEnv({ JAVA_HOME: java.javaHome!, PATH: `${join(java.javaHome!, 'bin')}:/usr/bin:/bin` }),
      stdin: opts.stdin ?? '',
      timeoutMs: runTimeout,
      maxOutputBytes: s.java.maxOutputKb * 1024,
    });
    run.exitCode = r.exitCode;
    if (r.reason !== 'exit') {
      run.state = mapReason(r.reason, entry.cancelled);
      this.system(run, `\n${describeStop(run.state, runTimeout, s.java.maxOutputKb)}\n`);
      return run;
    }
    run.state = r.exitCode === 0 ? 'succeeded' : 'failed';
    this.system(run, `\nProcess exited with code ${r.exitCode} in ${(r.durationMs / 1000).toFixed(2)}s.\n`);
    return run;
  }

  async mavenInvocation(buildRoot: string, java: JavaStatus, goal: string, runId: string, testTimeoutSec: number) {
    const s = this.settings.get();
    const mp = mavenPaths(this.dataRoot, s);
    const args = ['-B', '-ntp'];
    if (java.maven.dependenciesCached && java.maven.distributionCached) args.push('-o');
    if (mp.settingsFile) args.push('-s', mp.settingsFile, `-Dmaven.repo.local=${mp.repository}`);
    args.push(`-D${RUN_MARKER}=${runId}`);
    if (goal === 'test') args.push('-Dmaven.test.failure.ignore=true', `-Dsurefire.timeout=${Math.max(10, testTimeoutSec - 15)}`);
    args.push(goal);
    const env = minimalEnv({
      JAVA_HOME: java.javaHome!,
      PATH: `${join(java.javaHome!, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
      MAVEN_USER_HOME: mp.userHome,
      MAVEN_OPTS: '-Xmx768m',
    });
    void buildRoot;
    return { args, env };
  }

  private async spawnTracked(entry: ActiveRun, p: Parameters<typeof startProcess>[0]): Promise<ProcessResult> {
    const run = entry.run;
    if (entry.cancelled) {
      return { reason: 'cancelled', exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, durationMs: 0, error: null };
    }
    const proc = startProcess({
      ...p,
      onStdout: (c) => this.output(run, 'stdout', c),
      onStderr: (c) => this.output(run, 'stderr', c),
    });
    entry.proc = proc;
    if (proc.pid) this.db.prepare('UPDATE exec_runs SET pid = ? WHERE id = ?').run(proc.pid, run.id);
    const res = await proc.done;
    entry.proc = null;
    if (res.truncated) run.truncated = true;
    if (res.reason === 'spawn-error') this.system(run, `Could not start process: ${res.error}\n`);
    return res;
  }

  private output(run: ExecRun, stream: 'stdout' | 'stderr', chunk: string): void {
    if (stream === 'stdout') run.stdout += chunk;
    else run.stderr += chunk;
    this.bus.publish({ type: 'exec-output', runId: run.id, sessionId: run.sessionId, stream, chunk });
  }

  private system(run: ExecRun, text: string): void {
    run.stdout += text;
    this.bus.publish({ type: 'exec-output', runId: run.id, sessionId: run.sessionId, stream: 'system', chunk: text });
  }

  private persist(run: ExecRun): void {
    this.db
      .prepare(
        `UPDATE exec_runs SET state=?, phase=?, exit_code=?, command=?, stdout=?, stderr=?, truncated=?, diagnostics_json=?, tests_json=?, finished_at=?, duration_ms=?, pid=NULL WHERE id=?`,
      )
      .run(
        run.state,
        run.phase,
        run.exitCode,
        run.command,
        run.stdout.slice(-1_000_000),
        run.stderr.slice(-1_000_000),
        run.truncated ? 1 : 0,
        JSON.stringify(run.diagnostics),
        run.tests ? JSON.stringify(run.tests) : null,
        run.finishedAt,
        run.durationMs,
        run.id,
      );
  }
}

function mapReason(reason: ProcessResult['reason'], cancelled: boolean): ExecRun['state'] {
  if (cancelled || reason === 'cancelled') return 'cancelled';
  if (reason === 'timeout') return 'timed-out';
  if (reason === 'output-limit') return 'output-limit';
  return 'failed';
}

function describeStop(state: ExecRun['state'], timeoutMs: number, maxKb?: number): string {
  if (state === 'cancelled') return 'Stopped by user.';
  if (state === 'timed-out') return `Stopped after the ${Math.round(timeoutMs / 1000)}s time limit (possible infinite loop or blocking read). Adjust limits in Settings.`;
  if (state === 'output-limit') return `Stopped because output exceeded ${maxKb ?? '?'} KB (possible runaway loop).`;
  return 'Process failed to start.';
}

function quoteForDisplay(a: string): string {
  return /[\s"'\\]/.test(a) || a === '' ? JSON.stringify(a) : a;
}

interface RunRow {
  id: string;
  session_id: string;
  submission_id: string | null;
  kind: ExecKind;
  state: ExecRun['state'];
  phase: string | null;
  exit_code: number | null;
  main_class: string | null;
  command: string;
  stdout: string;
  stderr: string;
  truncated: number;
  diagnostics_json: string;
  tests_json: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
}

export function rowToRun(r: RunRow): ExecRun {
  return {
    id: r.id,
    sessionId: r.session_id,
    submissionId: r.submission_id,
    kind: r.kind,
    state: r.state,
    phase: r.phase,
    exitCode: r.exit_code,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    durationMs: r.duration_ms,
    stdout: r.stdout,
    stderr: r.stderr,
    truncated: !!r.truncated,
    diagnostics: json<Diagnostic[]>(r.diagnostics_json, []),
    tests: json<TestSummary | null>(r.tests_json, null),
    mainClass: r.main_class,
    command: r.command,
  };
}
