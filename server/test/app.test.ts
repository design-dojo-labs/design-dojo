import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Session, Submission } from '@lld/shared';
import { authHeaders, testApp, waitForJob, SHARED_MAVEN } from './helpers.js';
import { buildApp } from '../src/app.js';

let t: Awaited<ReturnType<typeof testApp>>;
beforeAll(async () => {
  process.env.LLD_STUDIO_MAVEN_HOME = SHARED_MAVEN;
  process.env.LLD_MOCK_DELAY_MS = '50';
  t = await testApp();
});
afterAll(async () => {
  await t?.dispose();
});

describe('HTTP security', () => {
  it('rejects unknown Host headers (DNS rebinding)', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/problems', headers: { host: 'attacker.example:4399' } });
    expect(r.statusCode).toBe(421);
  });
  it('requires the per-process token for state-changing requests', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/problems/random', headers: { host: '127.0.0.1:4399', 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'POST', url: '/api/problems/random', headers: authHeaders(t.ctx.csrfToken), payload: '{}' });
    expect(ok.statusCode).toBe(200);
  });
  it('rejects cross-origin requests even with a token', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/problems/random', headers: { ...authHeaders(t.ctx.csrfToken), origin: 'http://evil.example' }, payload: '{}' });
    expect(r.statusCode).toBe(403);
  });
  it('never echoes stored API keys', async () => {
    const put = await t.app.inject({ method: 'PUT', url: '/api/providers/claude/api-key', headers: authHeaders(t.ctx.csrfToken), payload: { apiKey: 'sk-ant-secret-value-7777' } });
    expect(put.json()).toMatchObject({ configured: true, hint: '…7777', source: 'stored' });
    expect(put.body).not.toContain('secret-value');
    expect(statSync(join(t.dataRoot, 'secrets.json')).mode & 0o077).toBe(0);
    await t.app.inject({ method: 'DELETE', url: '/api/providers/claude/api-key', headers: authHeaders(t.ctx.csrfToken) });
  });
});

describe('problem bank', () => {
  it('loads at least 15 validated seed problems with fixed rubrics', async () => {
    const list = t.ctx.problems.list();
    expect(list.length).toBeGreaterThanOrEqual(15);
    const p = t.ctx.problems.get('parking-lot');
    expect(p.rubric.categories.reduce((s, c) => s + c.max, 0)).toBe(100);
    expect(t.ctx.seedErrors).toEqual([]);
  });
});

describe('practice workflow (mock reviewer, real Java)', () => {
  let session: Session;

  it('creates a session with a scaffolded Maven project', () => {
    session = t.ctx.sessions.create({ problemId: 'parking-lot', mode: 'practice', durationMinutes: 45 });
    expect(existsSync(join(session.workspaceDir, 'pom.xml'))).toBe(true);
    expect(existsSync(join(session.workspaceDir, `src/main/java/${session.packageName.replace(/\./g, '/')}/Main.java`))).toBe(true);
    expect(readFileSync(join(session.workspaceDir, 'pom.xml'), 'utf8')).toContain('<maven.compiler.release>21</maven.compiler.release>');
  });

  it('prepares the Java toolchain (downloads once into the shared test cache)', async () => {
    const java = await t.ctx.javaStatus(true);
    if (!java.ok) {
      console.warn(`Skipping Java-dependent assertions: ${java.detail}`);
      return;
    }
    if (!java.maven.dependenciesCached) {
      const { startToolchainBootstrap } = await import('../src/java/bootstrap.js');
      const job = startToolchainBootstrap({ jobs: t.ctx.jobs, settings: t.ctx.settings, dataRoot: t.dataRoot, templateDir: t.ctx.config.resources.javaTemplate, javaStatus: t.ctx.javaStatus });
      expect((await waitForJob(t.ctx, job.id, 600_000)).state).toBe('completed');
    }
    expect((await t.ctx.javaStatus(true)).maven.dependenciesCached).toBe(true);
  }, 600_000);

  it('compiles, reports diagnostics, runs with stdin/args, and runs tests', async () => {
    const ws = t.ctx.sessions.workspace(session.id);
    const pkgDir = `src/main/java/${session.packageName.replace(/\./g, '/')}`;
    await ws.write(`${pkgDir}/Broken.java`, `package ${session.packageName};\nclass Broken { int x = "nope"; }\n`, null);
    const bad = await (await t.ctx.runner.start({ sessionId: session.id, buildRoot: session.workspaceDir, kind: 'compile' })).done;
    expect(bad.state).toBe('failed');
    expect(bad.diagnostics[0]).toMatchObject({ severity: 'error', file: `${pkgDir}/Broken.java`, line: 2 });
    await ws.remove(`${pkgDir}/Broken.java`);

    const main = ws.read(`${pkgDir}/Main.java`);
    await ws.write(
      `${pkgDir}/Main.java`,
      `package ${session.packageName};\npublic class Main {\n  public static void main(String[] a) throws Exception {\n    String line = new java.io.BufferedReader(new java.io.InputStreamReader(System.in)).readLine();\n    System.out.println("args=" + String.join("|", a) + " stdin=" + line);\n    System.exit(3);\n  }\n}\n`,
      main.hash,
    );
    const run = await (await t.ctx.runner.start({ sessionId: session.id, buildRoot: session.workspaceDir, kind: 'run', args: 'one "two words"', stdin: 'hello\n' })).done;
    expect(run.stdout).toContain('args=one|two words stdin=hello');
    expect(run.exitCode).toBe(3);
    expect(run.state).toBe('failed');

    const test = await (await t.ctx.runner.start({ sessionId: session.id, buildRoot: session.workspaceDir, kind: 'test' })).done;
    expect(test.tests).toMatchObject({ passed: 1, failed: 0, errored: 0, total: 1 });
  }, 120_000);

  it('stops infinite loops at the time limit and on Stop, and caps runaway output', async () => {
    const ws = t.ctx.sessions.workspace(session.id);
    const pkgDir = `src/main/java/${session.packageName.replace(/\./g, '/')}`;
    const main = ws.read(`${pkgDir}/Main.java`);
    await ws.write(`${pkgDir}/Main.java`, `package ${session.packageName};\npublic class Main { public static void main(String[] a) { while (true) {} } }\n`, main.hash);
    t.ctx.settings.update({ java: { runTimeoutSec: 2 } });
    const started = Date.now();
    const timedOut = await (await t.ctx.runner.start({ sessionId: session.id, buildRoot: session.workspaceDir, kind: 'run' })).done;
    expect(timedOut.state).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(20_000);

    t.ctx.settings.update({ java: { runTimeoutSec: 60 } });
    const { run, done } = await t.ctx.runner.start({ sessionId: session.id, buildRoot: session.workspaceDir, kind: 'run' });
    await new Promise((r) => setTimeout(r, 2500));
    expect(t.ctx.runner.stop(run.id)).toBe(true);
    expect((await done).state).toBe('cancelled');

    const m2 = ws.read(`${pkgDir}/Main.java`);
    await ws.write(`${pkgDir}/Main.java`, `package ${session.packageName};\npublic class Main { public static void main(String[] a) { while (true) System.out.println("spam spam spam"); } }\n`, m2.hash);
    t.ctx.settings.update({ java: { maxOutputKb: 64 } });
    const flood = await (await t.ctx.runner.start({ sessionId: session.id, buildRoot: session.workspaceDir, kind: 'run' })).done;
    expect(flood.state).toBe('output-limit');
    expect(flood.stdout.length).toBeLessThan(80 * 1024);
    t.ctx.settings.update({ java: { maxOutputKb: 512 } });
    const m3 = ws.read(`${pkgDir}/Main.java`);
    await ws.write(`${pkgDir}/Main.java`, `package ${session.packageName};\npublic class Main { public static void main(String[] a) { System.out.println("ok"); } }\n`, m3.hash);
  }, 120_000);

  let first: Submission;
  it('submits an immutable snapshot, builds it, reviews it and computes the score', async () => {
    t.ctx.settings.update({ provider: 'mock' });
    const res = t.ctx.submissions.submit(session.id);
    expect(res.duplicate).toBe(false);
    const job = await waitForJob(t.ctx, res.job!.id);
    expect(job.state).toBe('completed');
    first = t.ctx.submissions.get(res.submission.id);
    expect(first.compile).toBe('passed');
    expect(first.tests?.passed).toBe(1);
    expect(first.review?.isMock).toBe(true);
    expect(first.review?.totalScore).toBe(first.review!.categories.reduce((s, c) => s + c.score, 0));
    expect(first.review?.designAssessment?.solid).toHaveLength(5);
    // The mock finding cites line 1 of a real snapshot file.
    const f = first.review!.findings[0];
    expect(first.manifest.some((m) => m.path === f.filePath)).toBe(true);
    // Snapshot files are read-only on disk and hashed in the manifest.
    const snapFile = join(t.dataRoot, 'submissions', first.id, 'source', 'pom.xml');
    expect(statSync(snapFile).mode & 0o222).toBe(0);
  }, 180_000);

  it('returns the existing submission for a repeated submit with no changes', () => {
    const again = t.ctx.submissions.submit(session.id);
    expect(again.duplicate).toBe(true);
    expect(again.submission.id).toBe(first.id);
  });

  it('keeps the snapshot unchanged when the workspace is edited afterwards', async () => {
    const ws = t.ctx.sessions.workspace(session.id);
    const pkgDir = `src/main/java/${session.packageName.replace(/\./g, '/')}`;
    const before = t.ctx.submissions.readFile(first.id, `${pkgDir}/Main.java`).content;
    const cur = ws.read(`${pkgDir}/Main.java`);
    await ws.write(`${pkgDir}/Main.java`, cur.content + '\n// edited after submitting\n', cur.hash);
    expect(t.ctx.submissions.readFile(first.id, `${pkgDir}/Main.java`).content).toBe(before);
    // Even a direct write attempt on the snapshot file is refused by the filesystem.
    const snapAbs = join(t.dataRoot, 'submissions', first.id, 'source', ...`${pkgDir}/Main.java`.split('/'));
    expect(() => writeFileSync(snapAbs, 'tamper')).toThrow();
  });

  it('records a review failure without inventing a score, then succeeds on retry', async () => {
    const { FAKE_CLAUDE } = await import('./helpers.js');
    chmodSync(FAKE_CLAUDE, 0o755);
    t.ctx.settings.update({ provider: 'claude', claude: { executablePath: FAKE_CLAUDE } });
    t.ctx.providers.invalidate();
    process.env.FAKE_SCENARIO = 'malformed';
    const res = t.ctx.submissions.submit(session.id);
    const job = await waitForJob(t.ctx, res.job!.id);
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('malformed-output');
    const sub = t.ctx.submissions.get(res.submission.id);
    expect(sub.review).toBeNull();
    expect(sub.score).toBeNull();
    expect(sub.compile).toBe('passed'); // build results are retained
    // Retry with the mock reviewer succeeds and reuses the recorded build.
    t.ctx.settings.update({ provider: 'mock' });
    const retry = t.ctx.submissions.startReview(sub.id);
    expect((await waitForJob(t.ctx, retry.id)).state).toBe('completed');
    const done = t.ctx.submissions.get(sub.id);
    expect(done.review?.priorFindings.length).toBeGreaterThan(0); // compared against submission #1
    const cmp = t.ctx.submissions.compare(first.id, sub.id);
    expect(cmp.files.find((f) => f.status === 'modified')).toBeTruthy();
    expect(cmp.notes.join(' ')).toMatch(/mock/);
    delete process.env.FAKE_SCENARIO;
  }, 180_000);

  it('writes a reference solution to a separate read-only folder and marks the session', async () => {
    t.ctx.settings.update({ provider: 'mock' });
    const before = t.ctx.sessions.workspace(session.id).tree().entries.map((e) => e.path).sort();
    const job = t.ctx.ai.reference(session.id);
    expect((await waitForJob(t.ctx, job.id)).state).toBe('completed');
    const ref = t.ctx.ai.getReference(session.id)!;
    expect(ref.isMock).toBe(true);
    const refFile = join(t.dataRoot, 'references', ref.id, ...ref.files[0].path.split('/'));
    expect(existsSync(refFile)).toBe(true);
    expect(statSync(refFile).mode & 0o222).toBe(0);
    expect(t.ctx.sessions.workspace(session.id).tree().entries.map((e) => e.path).sort()).toEqual(before);
    expect(t.ctx.sessions.get(session.id).solutionRevealed).toBe(true);
  });

  it('rejects hints in interview mode and enforces progressive levels', () => {
    const iv = t.ctx.sessions.create({ problemId: 'vending-machine', mode: 'interview', durationMinutes: 45 });
    expect(() => t.ctx.ai.hint(iv.id, { level: 1 })).toThrow(/interview mode/);
    expect(() => t.ctx.ai.hint(session.id, { level: 3 })).toThrow(/progressive/);
    expect(() => t.ctx.sessions.timer(iv.id, 'pause')).toThrow(/cannot be paused/);
  });
});

describe('restart recovery', () => {
  it('marks in-flight jobs and builds as interrupted and pauses timers after a restart', async () => {
    const s = t.ctx.sessions.create({ problemId: 'splitwise', mode: 'practice', durationMinutes: null });
    const { job } = t.ctx.jobs.create({ kind: 'review', provider: 'mock', sessionId: s.id, dedupeKey: 'test-restart' });
    t.ctx.db.prepare(`UPDATE jobs SET state = 'running' WHERE id = ?`).run(job.id);
    // Simulate a crash: open a second app instance on the same data folder.
    const second = await buildApp({ config: { dataRoot: t.dataRoot, port: 4398 } });
    try {
      expect(second.ctx.jobs.get(job.id)?.state).toBe('interrupted');
      const timer = second.ctx.sessions.get(s.id).timer;
      expect(timer.runningSince).toBeNull();
      expect(timer.autoPaused).toBe(true);
      // Work survives: the workspace and session are still there.
      expect(existsSync(join(second.ctx.sessions.get(s.id).workspaceDir, 'pom.xml'))).toBe(true);
      // The next heartbeat resumes the timer.
      expect(second.ctx.sessions.heartbeat(s.id).runningSince).not.toBeNull();
    } finally {
      await second.close();
    }
  });

  it('deduplicates active jobs by key', () => {
    const a = t.ctx.jobs.create({ kind: 'generate', dedupeKey: 'dedupe-test' });
    const b = t.ctx.jobs.create({ kind: 'generate', dedupeKey: 'dedupe-test' });
    expect(b.existing).toBe(true);
    expect(b.job.id).toBe(a.job.id);
    t.ctx.jobs.cancel(a.job.id);
    expect(t.ctx.jobs.get(a.job.id)?.state).toBe('cancelled');
    expect(t.ctx.jobs.create({ kind: 'generate', dedupeKey: 'dedupe-test' }).existing).toBe(false);
  });
});
