import type { Effort, ProviderId, ProviderStatus, Settings } from '@lld/shared';

export type AiTask =
  | 'generate'
  | 'review'
  | 'review-score'
  | 'review-detail'
  | 'hint'
  | 'reference'
  | 'connection-test'
  | 'hld-review'
  | 'hld-review-score'
  | 'hld-review-detail'
  | 'hld-generate'
  | 'chat'
  | 'fix-suggestion'
  | 'interview';

/** Which configured model/effort a task uses: scoring, review detail, or quick assistance. */
export type TaskClass = 'review' | 'detail' | 'assist';
export function taskClass(task: AiTask): TaskClass {
  switch (task) {
    case 'review-detail':
    case 'hld-review-detail':
      return 'detail';
    case 'hint':
    case 'chat':
    case 'fix-suggestion':
    case 'interview':
    case 'generate':
    case 'hld-generate':
      return 'assist';
    default:
      return 'review';
  }
}

export interface StructuredRequest {
  task: AiTask;
  /** Full prompt, delivered on stdin (never on the command line). */
  prompt: string;
  /** Provider-facing JSON Schema for the final structured answer. */
  schema: Record<string, unknown>;
  timeoutMs: number;
  /** Empty per-job directory used as the CLI working directory. */
  workDir: string;
  signal: AbortSignal;
  onProgress: (message: string) => void;
  onPid?: (pid: number | null) => void;
  /** Model for this request (already resolved from the task class); null = the CLI's default. */
  model?: string | null;
  /** Reasoning effort for this request; adapters ignore it when their CLI has no such option. */
  effort?: Effort;
  /**
   * Receives the structured answer's raw JSON text as it streams (cumulative, possibly incomplete).
   * Only adapters whose CLI streams partial output call it.
   */
  onPartial?: (partialJson: string) => void;
  /** Structured context used only by the mock adapter to build deterministic output. */
  mockContext?: unknown;
}

export interface StructuredResult {
  output: unknown;
  model: string | null;
  usage: Record<string, unknown> | null;
  durationMs: number;
  /** Final message text exactly as received, kept for auditing malformed output. */
  rawFinal: string;
  eventCount: number;
}

export interface ProviderAdapter {
  id: ProviderId;
  label: string;
  /** Local checks only (binary, version, login state). Never sends an inference request. */
  status(settings: Settings): Promise<ProviderStatus>;
  /** Runs one non-interactive structured request. Throws JobFailure on any failure. */
  runStructured(settings: Settings, req: StructuredRequest): Promise<StructuredResult>;
}
