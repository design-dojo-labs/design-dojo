import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AskRequest, MarkRequest, CreateHldSessionRequest, GenerateHldProblemRequest, RandomHldProblemRequest, SaveHldDocRequest, Difficulty, Target, HldDomain } from '@lld/shared';
import type { AppContext } from '../app.js';
import { clientIdOf } from './routes.js';
import { interactiveFor } from '../interactive.js';

const IdParam = z.object({ id: z.string().min(1).max(100) });

/** System design (HLD) practice endpoints. Security hooks (Host/Origin/token) apply as for all /api routes. */
export function registerHldRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { hld } = ctx;
  const id = (req: FastifyRequest) => IdParam.parse(req.params).id;
  const Filter = z.object({ difficulty: Difficulty.optional(), target: Target.optional(), domain: HldDomain.optional() });

  app.get('/api/hld/problems', async (req) => hld.listProblems(Filter.parse(req.query)));
  app.get('/api/hld/problems/:id', async (req) => {
    const v = (req.query as { version?: string }).version;
    return hld.getPublic(id(req), v ? Number(v) : undefined);
  });
  app.post('/api/hld/problems/random', async (req) => hld.random(RandomHldProblemRequest.parse(req.body ?? {})));
  app.post('/api/hld/problems/generate', async (req) => hld.generate(GenerateHldProblemRequest.parse(req.body)));

  app.get('/api/hld/sessions', async () => hld.listSessions());
  app.post('/api/hld/sessions', async (req) => hld.createSession(CreateHldSessionRequest.parse(req.body)));
  app.get('/api/hld/sessions/:id', async (req) => hld.getSession(id(req)));
  app.put('/api/hld/sessions/:id/doc', async (req) => {
    const body = SaveHldDocRequest.parse(req.body);
    const res = hld.saveDoc(id(req), body.doc, body.baseHash, body.force);
    ctx.bus.publish({ type: 'hld-doc-saved', sessionId: id(req), hash: res.hash, clientId: clientIdOf(req) });
    return res;
  });
  app.post('/api/hld/sessions/:id/timer', async (req) => hld.timer(id(req), z.object({ action: z.enum(['pause', 'resume']) }).parse(req.body).action));
  app.post('/api/hld/sessions/:id/heartbeat', async (req) => hld.heartbeat(id(req)));
  app.post('/api/hld/sessions/:id/submissions', async (req) => hld.submit(id(req)));
  app.get('/api/hld/sessions/:id/submissions', async (req) => hld.listSubmissions(id(req)));
  app.get('/api/hld/submissions/:id', async (req) => hld.getSubmission(id(req)));
  app.get('/api/hld/submissions/:id/doc', async (req) => hld.submissionDoc(id(req)));
  app.post('/api/hld/submissions/:id/review', async (req) => hld.startReview(id(req)));
  app.post('/api/hld/submissions/:id/review-detail', async (req) => hld.startDetailRetry(id(req)));
  app.get('/api/hld/submissions/:id/interactive', async (req) => interactiveFor(ctx).state('hld', id(req)));
  app.post('/api/hld/submissions/:id/threads', async (req) => interactiveFor(ctx).ask('hld', id(req), AskRequest.parse(req.body)));
  app.put('/api/hld/submissions/:id/marks', async (req) => interactiveFor(ctx).mark('hld', id(req), MarkRequest.parse(req.body)));
  app.post('/api/hld/submissions/:id/interview', async (req) => interactiveFor(ctx).startInterview('hld', id(req), z.object({ restart: z.boolean().optional() }).parse(req.body ?? {}).restart));
  app.get('/api/hld/stats', async () => ({ recent: hld.recentScores() }));
}
