import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AskRequest,
  InterviewAnswerRequest,
  MarkRequest,
  CreateSessionRequest,
  ExecRequest,
  FsOpRequest,
  GenerateProblemRequest,
  HintRequest,
  ProblemFilter,
  RandomProblemRequest,
  SaveApiKeyRequest,
  SaveFileRequest,
  SessionPatch,
  SettingsPatch,
  type Bootstrap,
  type ServerEvent,
} from '@lld/shared';
import type { AppContext } from '../app.js';
import { interactiveFor } from '../interactive.js';
import { HttpError, normalizeRelPath, resolveInside } from '../fs/paths.js';
import { computeStats } from '../stats.js';
import { importZip, reviewMarkdown, workspaceZip, zipFiles } from '../export.js';
import { startToolchainBootstrap } from '../java/bootstrap.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const IdParam = z.object({ id: z.string().min(1).max(100) });
const KeyProvider = z.enum(['claude', 'codex', 'gemini']);

/** Opaque per-tab id sent by the web client so a tab can ignore change events it caused itself. */
export function clientIdOf(req: FastifyRequest): string | null {
  const v = req.headers['x-client-id'];
  return typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null;
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { sessions, problems, submissions, runner, jobs, providers, ai, settings } = ctx;
  const id = (req: FastifyRequest) => IdParam.parse(req.params).id;
  const fsChanged = (req: FastifyRequest, paths: string[]) =>
    ctx.bus.publish({ type: 'fs-changed', sessionId: id(req), paths: paths.filter(Boolean), clientId: clientIdOf(req) });

  // ───────────── bootstrap, settings, status ─────────────
  app.get('/api/bootstrap', async (): Promise<Bootstrap> => ({
    csrfToken: ctx.csrfToken,
    appVersion: ctx.config.appVersion,
    dataRoot: ctx.config.dataRoot,
    mockAvailable: providers.mockEnabled,
    bindHost: ctx.config.host,
    port: ctx.config.port,
  }));

  app.get('/api/settings', async () => settings.get());
  app.put('/api/settings', async (req) => {
    const next = settings.update(SettingsPatch.parse(req.body));
    providers.invalidate();
    return next;
  });

  app.get('/api/status/providers', async (req) => providers.statuses((req.query as { refresh?: string }).refresh === '1'));
  app.post('/api/providers/:id/test', async (req) => ai.connectionTest(z.enum(['claude', 'codex', 'gemini', 'mock']).parse(id(req))));
  app.get('/api/providers/:id/login', async (req) => ctx.login.get(KeyProvider.parse(id(req))));
  app.post('/api/providers/:id/login', async (req) => ctx.login.start(KeyProvider.parse(id(req)), settings.get()));
  app.post('/api/providers/:id/login/cancel', async (req) => ctx.login.cancel(KeyProvider.parse(id(req))));
  app.get('/api/providers/:id/api-key', async (req) => ctx.secrets.info(KeyProvider.parse(id(req))));
  app.put('/api/providers/:id/api-key', async (req) => {
    const info = ctx.secrets.set(KeyProvider.parse(id(req)), SaveApiKeyRequest.parse(req.body).apiKey);
    providers.invalidate();
    return info;
  });
  app.delete('/api/providers/:id/api-key', async (req) => {
    const info = ctx.secrets.clear(KeyProvider.parse(id(req)));
    providers.invalidate();
    return info;
  });

  app.get('/api/status/java', async (req) => ctx.javaStatus((req.query as { refresh?: string }).refresh === '1'));
  app.post('/api/status/java/bootstrap', async () =>
    startToolchainBootstrap({ jobs, settings, dataRoot: ctx.config.dataRoot, templateDir: ctx.config.resources.javaTemplate, javaStatus: ctx.javaStatus }),
  );
  app.get('/api/health', async () => ({ ok: true, seedErrors: ctx.seedErrors }));

  // ───────────── events (SSE) ─────────────
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Content-Type-Options': 'nosniff',
    });
    res.write(': connected\n\n');
    const send = (ev: ServerEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    const unsubscribe = ctx.bus.subscribe(send);
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ───────────── problems ─────────────
  app.get('/api/problems', async (req) => problems.list(ProblemFilter.parse(req.query)));
  app.get('/api/problems/:id', async (req) => {
    const v = (req.query as { version?: string }).version;
    return problems.get(id(req), v ? Number(v) : undefined);
  });
  app.post('/api/problems/random', async (req) => problems.random(RandomProblemRequest.parse(req.body ?? {})));
  app.post('/api/problems/generate', async (req) => ai.generateProblem(GenerateProblemRequest.parse(req.body)));

  // ───────────── sessions ─────────────
  app.get('/api/sessions', async (req) => sessions.list((req.query as { all?: string }).all === '1'));
  app.post('/api/sessions', async (req) => sessions.create(CreateSessionRequest.parse(req.body)));
  app.get('/api/sessions/:id', async (req) => sessions.get(id(req)));
  app.patch('/api/sessions/:id', async (req) => sessions.patch(id(req), SessionPatch.parse(req.body)));
  app.post('/api/sessions/:id/timer', async (req) => sessions.timer(id(req), z.object({ action: z.enum(['pause', 'resume']) }).parse(req.body).action));
  app.post('/api/sessions/:id/heartbeat', async (req) => sessions.heartbeat(id(req)));
  app.post('/api/sessions/:id/archive', async (req) => sessions.setStatus(id(req), 'archived'));
  app.post('/api/sessions/:id/restore', async (req) => sessions.setStatus(id(req), 'active'));

  // ───────────── workspace files ─────────────
  app.get('/api/sessions/:id/tree', async (req) => sessions.workspace(id(req)).tree());
  app.get('/api/sessions/:id/file', async (req) => sessions.workspace(id(req)).read(String((req.query as { path?: string }).path ?? '')));
  app.put('/api/sessions/:id/file', async (req) => {
    const body = SaveFileRequest.parse(req.body);
    const res = await sessions.workspace(id(req)).write(body.path, body.content, body.baseHash, body.force);
    sessions.touch(id(req));
    fsChanged(req, [body.path]);
    return res;
  });
  app.post('/api/sessions/:id/fs', async (req) => {
    const ws = sessions.workspace(id(req));
    const op = FsOpRequest.parse(req.body);
    switch (op.op) {
      case 'mkdir':
        await ws.mkdir(op.path);
        fsChanged(req, [op.path]);
        return { ok: true };
      case 'create': {
        const res = await ws.write(op.path, op.content ?? '', null);
        fsChanged(req, [op.path]);
        return res;
      }
      case 'rename':
        await ws.rename(op.path, op.newPath);
        fsChanged(req, [op.path, op.newPath]);
        return { ok: true };
      case 'delete': {
        const trashedTo = await ws.remove(op.path);
        fsChanged(req, [op.path]);
        return { ok: true, trashedTo };
      }
    }
  });
  app.get('/api/sessions/:id/search', async (req) => {
    const q = z.object({ q: z.string().max(500), regex: z.string().optional(), caseSensitive: z.string().optional() }).parse(req.query);
    return sessions.workspace(id(req)).search(q.q, { regex: q.regex === '1', caseSensitive: q.caseSensitive === '1' });
  });
  app.get('/api/sessions/:id/main-classes', async (req) => runner.findMainClasses(sessions.get(id(req)).workspaceDir));
  app.get('/api/sessions/:id/export.zip', async (req, reply) => {
    const s = sessions.get(id(req));
    const buf = await workspaceZip(sessions.workspace(s.id), s.problemId);
    return sendDownload(reply, buf, `${s.problemId}-workspace.zip`, 'application/zip');
  });
  app.post('/api/sessions/:id/import', async (req) => {
    const body = z.object({ zipBase64: z.string().max(4 * 1024 * 1024) }).parse(req.body);
    const res = await importZip(Buffer.from(body.zipBase64, 'base64'), sessions.workspace(id(req)));
    fsChanged(req, [...res.imported, ...res.replaced]);
    return res;
  });

  // ───────────── execution ─────────────
  app.post('/api/sessions/:id/exec', async (req) => {
    const s = sessions.get(id(req));
    const body = ExecRequest.parse(req.body);
    const { run } = await runner.start({ sessionId: s.id, buildRoot: s.workspaceDir, kind: body.kind, mainClass: body.mainClass, args: body.args, stdin: body.stdin });
    return run;
  });
  app.get('/api/sessions/:id/exec', async (req) => runner.latestForSession(id(req)));
  app.get('/api/exec/:id', async (req) => {
    const run = runner.get(id(req));
    if (!run) throw new HttpError(404, 'run not found');
    return run;
  });
  app.post('/api/exec/:id/stop', async (req) => ({ stopped: runner.stop(id(req)) }));

  // ───────────── submissions & reviews ─────────────
  app.post('/api/sessions/:id/submissions', async (req) => submissions.submit(id(req)));
  app.get('/api/sessions/:id/submissions', async (req) => submissions.list(id(req)));
  app.get('/api/submissions/recent', async () => submissions.recent());
  app.get('/api/submissions/compare', async (req) => {
    const q = z.object({ base: z.string().min(1), head: z.string().min(1) }).parse(req.query);
    return submissions.compare(q.base, q.head);
  });
  app.get('/api/submissions/:id', async (req) => submissions.get(id(req)));
  app.get('/api/submissions/:id/file', async (req) => submissions.readFile(id(req), String((req.query as { path?: string }).path ?? '')));
  app.post('/api/submissions/:id/review', async (req) => submissions.startReview(id(req)));
  app.post('/api/submissions/:id/review-detail', async (req) => submissions.startDetailRetry(id(req)));

  // ───────────── interactive review (follow-up chat, fixes, marks, mock interviewer) ─────────────
  app.get('/api/submissions/:id/interactive', async (req) => interactiveFor(ctx).state('lld', id(req)));
  app.post('/api/submissions/:id/threads', async (req) => interactiveFor(ctx).ask('lld', id(req), AskRequest.parse(req.body)));
  app.put('/api/submissions/:id/marks', async (req) => interactiveFor(ctx).mark('lld', id(req), MarkRequest.parse(req.body)));
  app.post('/api/submissions/:id/findings/:findingId/fix', async (req) =>
    interactiveFor(ctx).suggestFix(id(req), z.object({ findingId: z.string().min(1).max(80) }).parse(req.params).findingId),
  );
  app.post('/api/submissions/:id/interview', async (req) => interactiveFor(ctx).startInterview('lld', id(req), z.object({ restart: z.boolean().optional() }).parse(req.body ?? {}).restart));
  app.post('/api/interviews/:id/answer', async (req) => interactiveFor(ctx).answerInterview(id(req), InterviewAnswerRequest.parse(req.body).answer));
  app.post('/api/interviews/:id/end', async (req) => interactiveFor(ctx).endInterview(id(req)));
  app.get('/api/submissions/:id/export', async (req, reply) => {
    const format = z.enum(['md', 'json', 'zip']).parse((req.query as { format?: string }).format ?? 'md');
    const sub = submissions.get(id(req));
    const session = sessions.get(sub.sessionId);
    if (format === 'zip') {
      const files = sub.manifest.map((m) => ({ rel: m.path, content: submissions.readFile(sub.id, m.path).content }));
      return sendDownload(reply, await zipFiles(files, `${session.problemId}-submission-${sub.seq}`), `${session.problemId}-submission-${sub.seq}.zip`, 'application/zip');
    }
    if (!sub.review) throw new HttpError(404, 'This submission has no completed review yet.');
    if (format === 'json') {
      const payload = { submission: { ...sub, compileRun: undefined, testRun: undefined }, testResults: sub.testRun?.tests ?? null, review: sub.review };
      return sendDownload(reply, Buffer.from(JSON.stringify(payload, null, 2)), `${session.problemId}-review-${sub.seq}.json`, 'application/json');
    }
    return sendDownload(reply, Buffer.from(reviewMarkdown(session, sub, sub.review)), `${session.problemId}-review-${sub.seq}.md`, 'text/markdown; charset=utf-8');
  });

  // ───────────── hints & reference ─────────────
  app.get('/api/sessions/:id/hints', async (req) => ai.listHints(id(req)));
  app.post('/api/sessions/:id/hints', async (req) => ai.hint(id(req), HintRequest.parse(req.body)));
  app.get('/api/sessions/:id/reference', async (req) => ai.getReference(id(req)));
  app.post('/api/sessions/:id/reference', async (req) => ai.reference(id(req)));
  app.get('/api/references/:id/file', async (req) => {
    const rel = normalizeRelPath(String((req.query as { path?: string }).path ?? ''));
    const abs = resolveInside(join(ctx.config.dataRoot, 'references', id(req)), rel, { mustExist: true });
    return { path: rel, content: readFileSync(abs, 'utf8') };
  });

  // ───────────── jobs, stats ─────────────
  app.get('/api/jobs', async (req) => {
    const q = req.query as { sessionId?: string; active?: string };
    return jobs.list({ sessionId: q.sessionId, active: q.active === '1' });
  });
  app.get('/api/jobs/durations', async () => jobs.durations());
  app.get('/api/jobs/:id', async (req) => {
    const job = jobs.get(id(req));
    if (!job) throw new HttpError(404, 'job not found');
    return job;
  });
  app.post('/api/jobs/:id/cancel', async (req) => jobs.cancel(id(req)));
  app.get('/api/stats', async () => computeStats(ctx.db));
}

function sendDownload(reply: FastifyReply, buf: Buffer, filename: string, type: string) {
  return reply
    .header('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`)
    .type(type)
    .send(buf);
}
