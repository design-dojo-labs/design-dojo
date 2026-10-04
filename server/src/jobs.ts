import { randomUUID } from 'node:crypto';
import type { ErrorCode, Job, JobDurationStats, JobError, JobKind } from '@lld/shared';
import { type DB, json, now } from './db.js';
import type { EventBus } from './events.js';
import { HttpError } from './fs/paths.js';

export class JobFailure extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: string[],
  ) {
    super(message);
  }
}

export interface JobContext {
  jobId: string;
  signal: AbortSignal;
  progress: (message: string) => void;
  setPid: (pid: number | null) => void;
}

interface JobRow {
  id: string;
  kind: JobKind;
  state: Job['state'];
  provider: string | null;
  session_id: string | null;
  submission_id: string | null;
  dedupe_key: string | null;
  params_json: string;
  progress_json: string;
  error_json: string | null;
  result_json: string | null;
  pid: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

const MAX_PROGRESS = 60;

/**
 * Persistent background jobs with explicit states. Duplicate requests (same dedupe key while a job
 * is queued or running) return the existing job instead of starting another one. There are no
 * automatic retries: a failed job stays failed until the user retries it.
 */
export class JobManager {
  private controllers = new Map<string, AbortController>();
  private running = 0;
  private waiters: (() => void)[] = [];

  constructor(
    private db: DB,
    private bus: EventBus,
    private maxConcurrent = 2,
  ) {}

  create(input: {
    kind: JobKind;
    provider?: string | null;
    sessionId?: string | null;
    submissionId?: string | null;
    dedupeKey?: string | null;
    params?: unknown;
  }): { job: Job; existing: boolean } {
    if (input.dedupeKey) {
      const active = this.db
        .prepare(`SELECT * FROM jobs WHERE dedupe_key = ? AND state IN ('queued','running')`)
        .get(input.dedupeKey) as JobRow | undefined;
      if (active) return { job: toJob(active), existing: true };
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO jobs (id, kind, state, provider, session_id, submission_id, dedupe_key, params_json, created_at) VALUES (?,?, 'queued', ?,?,?,?,?,?)`,
      )
      .run(id, input.kind, input.provider ?? null, input.sessionId ?? null, input.submissionId ?? null, input.dedupeKey ?? null, JSON.stringify(input.params ?? {}), now());
    const job = this.get(id)!;
    this.bus.publish({ type: 'job', job });
    return { job, existing: false };
  }

  /** Median and p90 run time of recent completed jobs per kind and provider (for ETA bars). */
  durations(limitPerGroup = 20): JobDurationStats[] {
    const rows = this.db
      .prepare(
        `SELECT kind, provider, (julianday(finished_at) - julianday(started_at)) * 86400000 AS ms FROM jobs
         WHERE state = 'completed' AND started_at IS NOT NULL AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 2000`,
      )
      .all() as { kind: JobKind; provider: string | null; ms: number }[];
    const groups = new Map<string, { kind: JobKind; provider: string | null; ms: number[] }>();
    for (const r of rows) {
      const key = `${r.kind}|${r.provider ?? ''}`;
      const g = groups.get(key) ?? { kind: r.kind, provider: r.provider, ms: [] };
      if (g.ms.length < limitPerGroup && r.ms > 0) g.ms.push(r.ms);
      groups.set(key, g);
    }
    return [...groups.values()]
      .filter((g) => g.ms.length)
      .map((g) => {
        const sorted = [...g.ms].sort((a, b) => a - b);
        const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
        return { kind: g.kind, provider: g.provider, samples: sorted.length, medianMs: at(0.5), p90Ms: at(0.9) };
      });
  }

  /** Runs the job body in the background. Resolves when the job reaches a terminal state. */
  run(jobId: string, body: (ctx: JobContext) => Promise<unknown>): Promise<Job> {
    const controller = new AbortController();
    this.controllers.set(jobId, controller);
    return (async () => {
      await this.acquire(controller.signal);
      try {
        if (controller.signal.aborted) {
          this.finish(jobId, 'cancelled', null, { code: 'cancelled', message: 'Cancelled before it started.' });
          return this.get(jobId)!;
        }
        this.update(jobId, { state: 'running', started_at: now() });
        const ctx: JobContext = {
          jobId,
          signal: controller.signal,
          progress: (m) => this.progress(jobId, m),
          setPid: (pid) => this.db.prepare('UPDATE jobs SET pid = ? WHERE id = ?').run(pid, jobId),
        };
        try {
          const result = await body(ctx);
          if (controller.signal.aborted) this.finish(jobId, 'cancelled', null, { code: 'cancelled', message: 'Cancelled.' });
          else this.finish(jobId, 'completed', result ?? null, null);
        } catch (e) {
          if (controller.signal.aborted || (e instanceof JobFailure && e.code === 'cancelled')) {
            this.finish(jobId, 'cancelled', null, { code: 'cancelled', message: 'Cancelled.' });
          } else if (e instanceof JobFailure) {
            this.finish(jobId, 'failed', null, { code: e.code, message: e.message, details: e.details });
          } else {
            this.finish(jobId, 'failed', null, { code: 'internal', message: (e as Error).message ?? String(e) });
          }
        }
      } finally {
        this.controllers.delete(jobId);
        this.release();
      }
      return this.get(jobId)!;
    })();
  }

  cancel(jobId: string): Job {
    const job = this.get(jobId);
    if (!job) throw new HttpError(404, 'job not found');
    if (job.state !== 'queued' && job.state !== 'running') return job;
    const c = this.controllers.get(jobId);
    if (c) c.abort();
    else this.finish(jobId, 'cancelled', null, { code: 'cancelled', message: 'Cancelled.' });
    return this.get(jobId)!;
  }

  get(jobId: string): Job | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  params<T>(jobId: string): T {
    const row = this.db.prepare('SELECT params_json FROM jobs WHERE id = ?').get(jobId) as { params_json: string } | undefined;
    return json<T>(row?.params_json, {} as T);
  }

  list(filter: { sessionId?: string; active?: boolean; kind?: JobKind; limit?: number } = {}): Job[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.sessionId) {
      where.push('session_id = ?');
      args.push(filter.sessionId);
    }
    if (filter.active) where.push(`state IN ('queued','running')`);
    if (filter.kind) {
      where.push('kind = ?');
      args.push(filter.kind);
    }
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`)
      .all(...args, filter.limit ?? 50) as JobRow[];
    return rows.map(toJob);
  }

  /** Marks jobs left queued/running by a previous server process as interrupted. */
  recoverInterrupted(onOrphan?: (job: Job, pid: number) => void): Job[] {
    const rows = this.db.prepare(`SELECT * FROM jobs WHERE state IN ('queued','running')`).all() as JobRow[];
    for (const r of rows) {
      if (r.pid && onOrphan) onOrphan(toJob(r), r.pid);
      this.finish(r.id, 'interrupted', null, { code: 'interrupted', message: 'The server stopped while this job was in progress. Retry when ready.' });
    }
    return rows.map((r) => this.get(r.id)!);
  }

  abortAll(): void {
    for (const c of this.controllers.values()) c.abort();
  }

  private async acquire(signal: AbortSignal): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => {
      const go = () => resolve();
      this.waiters.push(go);
      signal.addEventListener('abort', () => {
        const i = this.waiters.indexOf(go);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          this.running++; // balanced by release() in the caller's finally
          resolve();
        }
      });
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.running--;
  }

  private progress(jobId: string, message: string): void {
    const row = this.db.prepare('SELECT progress_json FROM jobs WHERE id = ?').get(jobId) as { progress_json: string } | undefined;
    const list = json<{ message: string; at: string }[]>(row?.progress_json, []);
    list.push({ message: message.slice(0, 500), at: now() });
    this.update(jobId, { progress_json: JSON.stringify(list.slice(-MAX_PROGRESS)) });
  }

  private finish(jobId: string, state: Job['state'], result: unknown, error: JobError | null): void {
    this.update(jobId, {
      state,
      finished_at: now(),
      result_json: result == null ? null : JSON.stringify(result),
      error_json: error ? JSON.stringify(error) : null,
      pid: null,
    });
  }

  private update(jobId: string, fields: Partial<Record<keyof JobRow, unknown>>): void {
    const keys = Object.keys(fields);
    this.db.prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k as keyof JobRow]), jobId);
    const job = this.get(jobId);
    if (job) this.bus.publish({ type: 'job', job });
  }
}

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    provider: r.provider,
    sessionId: r.session_id,
    submissionId: r.submission_id,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    progress: json(r.progress_json, []),
    error: json<JobError | null>(r.error_json, null),
    result: json(r.result_json, null),
  };
}
