import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { toAiJsonSchema, type Effort, type ProviderId, type ProviderStatus } from '@lld/shared';
import type { z } from 'zod';
import { type DB, json, now } from '../db.js';
import { JobFailure, type JobContext } from '../jobs.js';
import type { SettingsStore } from '../settings.js';
import type { SecretStore } from '../secrets.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { GeminiAdapter } from './gemini.js';
import { MockAdapter } from './mock.js';
import { taskClass, type AiTask, type ProviderAdapter, type StructuredResult } from './types.js';

const STATUS_TTL_MS = 60_000;

export class Providers {
  private adapters = new Map<ProviderId, ProviderAdapter>();
  private cache = new Map<ProviderId, ProviderStatus>();

  constructor(
    private db: DB,
    private settings: SettingsStore,
    secrets: SecretStore,
    private dataRoot: string,
    public readonly mockEnabled: boolean,
    overrides: Partial<Record<ProviderId, ProviderAdapter>> = {},
  ) {
    this.adapters.set('claude', overrides.claude ?? new ClaudeAdapter(secrets));
    this.adapters.set('codex', overrides.codex ?? new CodexAdapter(secrets));
    this.adapters.set('gemini', overrides.gemini ?? new GeminiAdapter(secrets));
    if (mockEnabled) this.adapters.set('mock', overrides.mock ?? new MockAdapter());
  }

  ids(): ProviderId[] {
    return [...this.adapters.keys()];
  }

  adapter(id: string): ProviderAdapter {
    const a = this.adapters.get(id as ProviderId);
    if (!a) throw new JobFailure('provider-disabled', `Provider "${id}" is not available.`);
    return a;
  }

  /** The provider chosen in Settings. There is no automatic fallback to another provider. */
  selected(): ProviderId {
    const p = this.settings.get().provider;
    if (p === 'none') throw new JobFailure('provider-disabled', 'No AI provider is selected. Choose Claude Code, Codex or Gemini in Settings.');
    if (!this.adapters.has(p)) throw new JobFailure('provider-disabled', `Provider "${p}" is not available in this server.`);
    return p;
  }

  /** Local status checks (binary, version, login). Cached briefly; never triggers inference. */
  async statuses(refresh = false): Promise<ProviderStatus[]> {
    return Promise.all(this.ids().map((id) => this.status(id, refresh)));
  }

  async status(id: ProviderId, refresh = false): Promise<ProviderStatus> {
    const cached = this.cache.get(id);
    if (!refresh && cached && Date.now() - Date.parse(cached.checkedAt) < STATUS_TTL_MS) return { ...cached, lastConnectionTest: this.lastTest(id) };
    let s: ProviderStatus;
    try {
      s = await this.adapter(id).status(this.settings.get());
    } catch (e) {
      s = {
        id,
        label: id,
        state: 'error',
        authMode: null,
        executable: null,
        version: null,
        authMethod: null,
        subscription: null,
        detail: `Status check failed: ${(e as Error).message}`,
        checkedAt: now(),
        lastConnectionTest: null,
      };
    }
    this.cache.set(id, s);
    return { ...s, lastConnectionTest: this.lastTest(id) };
  }

  invalidate(): void {
    this.cache.clear();
  }

  recordConnectionTest(id: ProviderId, ok: boolean, message: string, model: string | null): void {
    const s = this.settings.get();
    const authMode = id === 'mock' ? null : s[id].authMode;
    const result = { ok, at: now(), message, model, authMode };
    this.db
      .prepare(
        `INSERT INTO provider_checks (provider, result_json, updated_at) VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET result_json = excluded.result_json, updated_at = excluded.updated_at`,
      )
      .run(id, JSON.stringify(result), result.at);
  }

  private lastTest(id: ProviderId): ProviderStatus['lastConnectionTest'] {
    const row = this.db.prepare('SELECT result_json FROM provider_checks WHERE provider = ?').get(id) as { result_json: string } | undefined;
    return json(row?.result_json, null);
  }

  /**
   * Runs a structured request and validates the answer. If it fails validation, the provider gets
   * exactly one chance to correct it, seeing only its previous answer and the list of problems.
   * A second failure fails the job; nothing is saved and nothing is invented.
   */
  async runValidated<T>(
    providerId: ProviderId,
    task: AiTask,
    prompt: string,
    schema: z.ZodType<T>,
    ctx: JobContext,
    opts: { mockContext?: unknown; check?: (data: T) => string[]; onPartial?: (partialJson: string) => void } = {},
  ): Promise<{ data: T; result: StructuredResult & { provider: ProviderId }; repaired: boolean }> {
    const jsonSchema = toAiJsonSchema(schema);
    const issuesOf = (output: unknown): { data: T | null; issues: string[] } => {
      const parsed = schema.safeParse(output);
      if (!parsed.success) return { data: null, issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
      return { data: parsed.data, issues: opts.check?.(parsed.data) ?? [] };
    };
    const generation = task === 'generate' || task === 'hld-generate';
    const firstStarted = Date.now();
    if (generation) ctx.progress('Writing the question and evaluation criteria…');
    const first = await this.run(providerId, task, prompt, jsonSchema, ctx, opts.mockContext, opts.onPartial);
    if (generation) ctx.progress(`First answer received after ${Math.round((Date.now() - firstStarted) / 1000)}s. Checking the question…`);
    const a = issuesOf(first.output);
    if (!a.issues.length) {
      if (generation) ctx.progress('Question passed validation on the first attempt.');
      return { data: a.data as T, result: first, repaired: false };
    }
    // Persist the actual failures even when the correction succeeds. These contain validation
    // diagnostics, not the raw model answer, and remain available in the job's progress history.
    for (const issue of a.issues.slice(0, 20)) ctx.progress(`First answer validation: ${issue}`);
    ctx.progress(`The answer failed ${a.issues.length} validation check(s); asking ${providerId} to correct it (one attempt)…`);
    const repairPrompt = [
      'Your previous JSON answer did not pass validation. Return the complete corrected JSON object for the same schema.',
      'Fix only the problems listed; keep everything else unchanged. Do not add commentary. Do not use tools.',
      '',
      'Problems:',
      ...a.issues.map((i) => `- ${i}`),
      '',
      '<previous_answer>',
      first.rawFinal.slice(0, 200_000),
      '</previous_answer>',
    ].join('\n');
    const correctionStarted = Date.now();
    const second = await this.run(providerId, task, repairPrompt, jsonSchema, ctx, opts.mockContext);
    if (generation) ctx.progress(`Corrected answer received after ${Math.round((Date.now() - correctionStarted) / 1000)}s. Checking the question…`);
    const b = issuesOf(second.output);
    if (b.issues.length) {
      for (const issue of b.issues.slice(0, 20)) ctx.progress(`Corrected answer validation: ${issue}`);
      throw new JobFailure('validation-failed', 'The answer failed validation, and the single correction attempt did not fix it. Nothing was saved.', [
        ...a.issues.map((i) => `first answer: ${i}`),
        ...b.issues.map((i) => `corrected answer: ${i}`),
      ]);
    }
    ctx.progress('Corrected answer passed validation.');
    return { data: b.data as T, result: { ...second, durationMs: first.durationMs + second.durationMs }, repaired: true };
  }

  /** Model and effort configured for a task: detail and assist models fall back to the review model. */
  modelFor(providerId: ProviderId, task: AiTask): { model: string | null; effort: Effort } {
    if (providerId === 'mock') return { model: null, effort: 'default' };
    const p = this.settings.get()[providerId];
    const cls = taskClass(task);
    const pick = cls === 'detail' ? p.detailModel : cls === 'assist' ? p.assistModel : '';
    return { model: pick.trim() || p.model.trim() || null, effort: cls === 'assist' ? p.assistEffort : p.effort };
  }

  /** Runs one structured request with the given provider inside an empty per-job directory. */
  async run(
    providerId: ProviderId,
    task: AiTask,
    prompt: string,
    schema: Record<string, unknown>,
    ctx: JobContext,
    mockContext?: unknown,
    onPartial?: (partialJson: string) => void,
  ): Promise<StructuredResult & { provider: ProviderId }> {
    const adapter = this.adapter(providerId);
    const s = this.settings.get();
    const timeoutSec = providerId === 'mock' ? 30 : s[providerId].timeoutSec;
    const { model, effort } = this.modelFor(providerId, task);
    // One directory per CLI run: a job may run several passes in parallel (fast review mode).
    const workDir = join(this.dataRoot, 'ai-jobs', `${ctx.jobId}-${task}-${randomUUID().slice(0, 8)}`);
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    try {
      const res = await adapter.runStructured(s, {
        task,
        prompt,
        schema,
        timeoutMs: timeoutSec * 1000,
        workDir,
        signal: ctx.signal,
        onProgress: ctx.progress,
        onPid: ctx.setPid,
        model,
        effort,
        onPartial,
        mockContext,
      });
      return { ...res, provider: providerId };
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}
