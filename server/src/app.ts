import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { JavaStatus, ProviderId } from '@lld/shared';
import { loadConfig, type AppConfig } from './config.js';
import { openDatabase, type DB } from './db.js';
import { EventBus } from './events.js';
import { HttpError } from './fs/paths.js';
import { JobFailure, JobManager } from './jobs.js';
import { JavaRunner, RUN_MARKER } from './java/runner.js';
import { detectJava } from './java/toolchain.js';
import { ProblemRepo } from './problems.js';
import { Prompts } from './prompts.js';
import { Providers } from './providers/index.js';
import { LoginManager } from './providers/login.js';
import type { ProviderAdapter } from './providers/types.js';
import { SecretStore } from './secrets.js';
import { SessionStore } from './sessions.js';
import { SettingsStore } from './settings.js';
import { SubmissionService } from './submissions.js';
import { AiServices } from './ai-services.js';
import { HldService } from './hld/service.js';
import { installSecurity } from './http/security.js';
import { registerRoutes } from './http/routes.js';
import { registerHldRoutes } from './http/hld-routes.js';
import { registerStatic } from './http/static.js';
import { killAllLive, killOrphan } from './proc.js';

export interface AppContext {
  config: AppConfig;
  db: DB;
  bus: EventBus;
  settings: SettingsStore;
  secrets: SecretStore;
  problems: ProblemRepo;
  sessions: SessionStore;
  jobs: JobManager;
  runner: JavaRunner;
  providers: Providers;
  login: LoginManager;
  submissions: SubmissionService;
  ai: AiServices;
  hld: HldService;
  javaStatus: (refresh?: boolean) => Promise<JavaStatus>;
  csrfToken: string;
  seedErrors: string[];
}

export interface BuildOptions {
  config?: Partial<AppConfig>;
  providerOverrides?: Partial<Record<ProviderId, ProviderAdapter>>;
  logger?: boolean;
  /** Run restart recovery (interrupt stale jobs, pause timers). Off for CLI tools that run beside a live server. */
  recover?: boolean;
}

export async function buildApp(opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext; close: () => Promise<void> }> {
  const config = loadConfig(opts.config);
  const db = openDatabase(config.dataRoot);
  const bus = new EventBus();
  const settings = new SettingsStore(db);
  const secrets = new SecretStore(config.dataRoot);
  const problems = new ProblemRepo(db);
  const seed = problems.syncSeeds(config.resources.seedProblems);
  const sessions = new SessionStore(db, problems, settings, config.dataRoot, config.resources.javaTemplate);
  const jobs = new JobManager(db, bus, 2);

  let javaCache: { at: number; status: JavaStatus } | null = null;
  const javaStatus = async (refresh = false) => {
    if (!refresh && javaCache && Date.now() - javaCache.at < 30_000) return javaCache.status;
    const status = await detectJava(settings.get(), config.dataRoot);
    javaCache = { at: Date.now(), status };
    return status;
  };

  const runner = new JavaRunner(db, bus, settings, config.dataRoot, config.resources.javaTemplate, () => javaStatus());
  const providers = new Providers(db, settings, secrets, config.dataRoot, config.mockEnabled, opts.providerOverrides);
  const login = new LoginManager(bus, config.dataRoot, () => providers.invalidate());
  const prompts = new Prompts(config.resources.prompts);
  const submissions = new SubmissionService(db, bus, sessions, problems, runner, jobs, providers, prompts, settings, config.dataRoot);
  const ai = new AiServices(db, jobs, providers, prompts, problems, sessions, config.dataRoot);
  const hld = new HldService(db, bus, jobs, providers, prompts, settings);
  const hldSeedErrors = hld.syncSeeds(config.resources.hldSeedProblems);

  // ── Restart recovery: nothing that was in flight is reported as finished. ──
  let timerSweep: NodeJS.Timeout | null = null;
  if (opts.recover !== false) {
    jobs.recoverInterrupted((_job, pid) => {
      // Only kill a leftover CLI process if the pid still runs a provider CLI (guards against pid reuse).
      killOrphan(pid, 'claude') || killOrphan(pid, 'codex') || killOrphan(pid, 'gemini') || killOrphan(pid, 'mvnw');
    });
    for (const r of db.prepare(`SELECT pid FROM exec_runs WHERE state = 'running' AND pid IS NOT NULL`).all() as { pid: number }[]) {
      killOrphan(r.pid, RUN_MARKER);
    }
    submissions.recoverInterrupted();
    sessions.pauseStaleTimers(0);
    hld.pauseStaleTimers(0);
    timerSweep = setInterval(() => {
      sessions.pauseStaleTimers();
      hld.pauseStaleTimers();
    }, 60_000);
    timerSweep.unref();
  }

  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 4 * 1024 * 1024 });
  const { token } = installSecurity(app, { port: config.port, extraOrigins: config.extraOrigins });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, ...(err.body ?? {}) });
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    if (err instanceof JobFailure) {
      const status = err.code === 'provider-disabled' ? 412 : 400;
      return reply.code(status).send({ error: err.message, code: err.code, details: err.details });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    app.log.error(err);
    return reply.code(500).send({ error: 'Internal server error' });
  });

  const ctx: AppContext = {
    config,
    db,
    bus,
    settings,
    secrets,
    problems,
    sessions,
    jobs,
    runner,
    providers,
    login,
    submissions,
    ai,
    hld,
    javaStatus,
    csrfToken: token,
    seedErrors: [...seed.errors, ...hldSeedErrors.map((e) => `hld: ${e}`)],
  };
  registerRoutes(app, ctx);
  registerHldRoutes(app, ctx);
  registerStatic(app, config.resources.webDist);

  const close = async () => {
    if (timerSweep) clearInterval(timerSweep);
    jobs.abortAll();
    runner.stopAll();
    killAllLive();
    await app.close();
    db.close();
  };
  return { app, ctx, close };
}
