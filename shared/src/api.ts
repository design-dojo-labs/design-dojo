import { z } from 'zod';
import { ProblemTheme } from './generation.js';
import { Difficulty, Target, Topic } from './problem.js';
import type { ProblemVersion, RubricKey } from './problem.js';
import type { StoredReview, AiHint, AiReference } from './review.js';

// ───────────────────────────── Settings ─────────────────────────────

export const PROVIDER_IDS = ['claude', 'codex', 'gemini', 'mock'] as const;
export const ProviderId = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderId>;

/**
 * subscription: the CLI's own logged-in Claude / ChatGPT plan (default). API-key variables are removed
 *   from the CLI environment and any sign of API-key auth aborts the job.
 * api-key: explicit opt-in; the user's API key is passed to the official CLI for that run only and
 *   usage is billed per token by the provider. There is never an automatic switch between modes.
 */
export const AuthMode = z.enum(['subscription', 'api-key']);
export type AuthMode = z.infer<typeof AuthMode>;

/** Reasoning effort passed to the CLI when it supports it; 'default' leaves the CLI's own default. */
export const EFFORT_LEVELS = ['default', 'low', 'medium', 'high'] as const;
export const Effort = z.enum(EFFORT_LEVELS);
export type Effort = z.infer<typeof Effort>;

/**
 * Per-provider CLI settings. `model` scores reviews; `detailModel` writes the slower review detail
 * (design assessment, follow-ups); `assistModel` serves hints, chat, fix suggestions and problem
 * generation. Empty strings fall back to `model`, then to the CLI default.
 */
const ProviderSettings = z.object({
  executablePath: z.string().max(1024),
  model: z.string().max(100),
  detailModel: z.string().max(100),
  assistModel: z.string().max(100),
  effort: Effort,
  assistEffort: Effort,
  timeoutSec: z.number().int().min(30).max(1800),
  authMode: AuthMode,
});
export type ProviderSettings = z.infer<typeof ProviderSettings>;

export const Settings = z.object({
  provider: z.enum(['claude', 'codex', 'gemini', 'mock', 'none']),
  claude: ProviderSettings,
  codex: ProviderSettings,
  gemini: ProviderSettings,
  java: z.object({
    javaHome: z.string().max(1024),
    release: z.number().int().min(17).max(30),
    compileTimeoutSec: z.number().int().min(10).max(900),
    runTimeoutSec: z.number().int().min(1).max(600),
    testTimeoutSec: z.number().int().min(10).max(900),
    maxOutputKb: z.number().int().min(16).max(8192),
    useIsolatedMavenRepo: z.boolean(),
  }),
  editor: z.object({
    fontSize: z.number().int().min(10).max(28),
    theme: z.enum(['dark', 'light']),
    autosaveDelayMs: z.number().int().min(300).max(10000),
  }),
  review: z.object({
    maxContextKb: z.number().int().min(32).max(2048),
    /** fast: score pass and detail pass run in parallel, score shown first. full: one combined call. */
    mode: z.enum(['fast', 'full']),
  }),
  notifications: z.object({
    /** Browser notification when a review or other AI job finishes. */
    desktop: z.boolean(),
    sound: z.boolean(),
  }),
});
export type Settings = z.infer<typeof Settings>;

const PROVIDER_DEFAULTS: ProviderSettings = {
  executablePath: '',
  model: '',
  detailModel: '',
  assistModel: '',
  effort: 'default',
  assistEffort: 'low',
  timeoutSec: 900,
  authMode: 'subscription',
};

export const DEFAULT_SETTINGS: Settings = {
  provider: 'none',
  claude: { ...PROVIDER_DEFAULTS },
  codex: { ...PROVIDER_DEFAULTS },
  gemini: { ...PROVIDER_DEFAULTS },
  java: {
    javaHome: '',
    release: 21,
    compileTimeoutSec: 180,
    runTimeoutSec: 15,
    testTimeoutSec: 240,
    maxOutputKb: 512,
    useIsolatedMavenRepo: true,
  },
  editor: { fontSize: 14, theme: 'dark', autosaveDelayMs: 800 },
  review: { maxContextKb: 400, mode: 'fast' },
  notifications: { desktop: true, sound: true },
};

export const SettingsPatch = z.object({
  provider: Settings.shape.provider.optional(),
  claude: Settings.shape.claude.partial().optional(),
  codex: Settings.shape.codex.partial().optional(),
  gemini: Settings.shape.gemini.partial().optional(),
  java: Settings.shape.java.partial().optional(),
  editor: Settings.shape.editor.partial().optional(),
  review: Settings.shape.review.partial().optional(),
  notifications: Settings.shape.notifications.partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

// ───────────────────────────── Status ─────────────────────────────

/** installed: binary found; authenticated: CLI reports a usable login; unverified: no inference test run yet. */
export type ProviderState = 'not-installed' | 'installed' | 'authenticated' | 'auth-blocked' | 'unauthenticated' | 'error' | 'mock';

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  state: ProviderState;
  authMode: AuthMode | null;
  executable: string | null;
  version: string | null;
  authMethod: string | null;
  subscription: string | null;
  detail: string;
  checkedAt: string;
  lastConnectionTest: { ok: boolean; at: string; message: string; model: string | null } | null;
}

export interface JavaStatus {
  ok: boolean;
  javaHome: string | null;
  javaVersion: string | null;
  javaMajor: number | null;
  javacFound: boolean;
  release: number;
  meetsRelease: boolean;
  source: string | null;
  candidates: { home: string; version: string; major: number }[];
  maven: {
    wrapperVersion: string;
    mavenVersion: string;
    distributionCached: boolean;
    dependenciesCached: boolean;
    userHome: string;
    repository: string;
  };
  detail: string;
  checkedAt: string;
}

export interface ApiKeyInfo {
  configured: boolean;
  /** 'stored': entered in the UI (owner-only file in the data root); 'env': inherited environment variable. */
  source: 'stored' | 'env' | null;
  envVar: string | null;
  /** Last four characters only — the key itself is never returned by the API. */
  hint: string | null;
}

export const SaveApiKeyRequest = z.object({
  apiKey: z
    .string()
    .trim()
    .min(8, 'key looks too short')
    .max(400)
    .regex(/^\S+$/, 'key must not contain spaces'),
});

export interface LoginState {
  provider: 'claude' | 'codex' | 'gemini';
  state: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  command: string;
  output: string;
  urls: string[];
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
}

// ───────────────────────────── Jobs & events ─────────────────────────────

export const JOB_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
export type JobState = (typeof JOB_STATES)[number];
export type JobKind =
  | 'review'
  | 'review-detail'
  | 'generate'
  | 'hint'
  | 'reference'
  | 'connection-test'
  | 'toolchain-bootstrap'
  | 'submission-build'
  | 'hld-review'
  | 'hld-review-detail'
  | 'hld-generate'
  | 'chat'
  | 'fix-suggestion'
  | 'interview';

export type ErrorCode =
  | 'not-installed'
  | 'auth-failed'
  | 'auth-blocked'
  | 'rate-limited'
  | 'timeout'
  | 'cancelled'
  | 'malformed-output'
  | 'validation-failed'
  | 'nonzero-exit'
  | 'context-too-large'
  | 'interrupted'
  | 'provider-disabled'
  | 'internal';

/** Historical run time of completed AI jobs, used for ETA bars. */
export interface JobDurationStats {
  kind: JobKind;
  provider: string | null;
  samples: number;
  medianMs: number;
  p90Ms: number;
}

export interface JobError {
  code: ErrorCode;
  message: string;
  details?: string[];
}

export interface Job {
  id: string;
  kind: JobKind;
  state: JobState;
  provider: string | null;
  sessionId: string | null;
  submissionId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { message: string; at: string }[];
  error: JobError | null;
  result: unknown;
}

export type ServerEvent =
  | { type: 'job'; job: Job }
  | { type: 'exec-output'; runId: string; sessionId: string; stream: 'stdout' | 'stderr' | 'system'; chunk: string }
  | { type: 'exec-state'; run: ExecRun }
  | { type: 'submission'; submission: SubmissionSummary }
  /** Workspace files changed through the API; clientId identifies the tab that made the change. */
  | { type: 'fs-changed'; sessionId: string; paths: string[]; clientId: string | null }
  /** HLD design document saved; tabs with an older hash reload (or flag a conflict if they have edits). */
  | { type: 'hld-doc-saved'; sessionId: string; hash: string; clientId: string | null }
  /** Live, partial structured output of a running AI job (cumulative snapshot; not persisted). */
  | { type: 'job-partial'; jobId: string; sessionId: string | null; submissionId: string | null; phase: string; data: unknown }
  | { type: 'login'; login: LoginState }
  | { type: 'hld-submission'; sessionId: string; submissionId: string };

// ───────────────────────────── Problems ─────────────────────────────

export const ProblemFilter = z.object({
  difficulty: Difficulty.optional(),
  target: Target.optional(),
  topic: Topic.optional(),
});

export const RandomProblemRequest = ProblemFilter.extend({
  excludeIds: z.array(z.string().max(100)).max(200).optional(),
});

export const GenerateProblemRequest = z.object({
  difficulty: Difficulty,
  target: Target,
  topic: Topic.optional(),
  durationMinutes: z.number().int().min(20).max(120).nullable(),
  theme: ProblemTheme,
});
export type GenerateProblemRequest = z.infer<typeof GenerateProblemRequest>;

// ───────────────────────────── Sessions ─────────────────────────────

export const SessionMode = z.enum(['practice', 'interview']);
export type SessionMode = z.infer<typeof SessionMode>;

export const CreateSessionRequest = z.object({
  problemId: z.string().min(1).max(100),
  problemVersion: z.number().int().positive().optional(),
  mode: SessionMode,
  durationMinutes: z.number().int().min(5).max(240).nullable(),
});

export interface TimerState {
  accumulatedMs: number;
  runningSince: string | null;
  durationMinutes: number | null;
  /** Set when the server paused the timer because the workspace stopped sending heartbeats. */
  autoPaused?: boolean;
}

export interface EditorState {
  openTabs: string[];
  activeTab: string | null;
}

export interface RunConfig {
  mainClass: string | null;
  args: string;
  stdin: string;
}

export const SessionPatch = z.object({
  editorState: z
    .object({ openTabs: z.array(z.string().max(1024)).max(50), activeTab: z.string().max(1024).nullable() })
    .optional(),
  runConfig: z.object({ mainClass: z.string().max(300).nullable(), args: z.string().max(4000), stdin: z.string().max(65536) }).optional(),
});

export interface SessionSummary {
  id: string;
  problemId: string;
  problemVersion: number;
  problemTitle: string;
  difficulty: string;
  mode: SessionMode;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  submissionCount: number;
  latestScore: number | null;
  bestScore: number | null;
  timer: TimerState;
  hintsUsed: number;
  solutionRevealed: boolean;
}

export interface Session extends SessionSummary {
  problem: ProblemVersion;
  editorState: EditorState;
  runConfig: RunConfig;
  workspaceDir: string;
  packageName: string;
}

// ───────────────────────────── Files ─────────────────────────────

export interface TreeEntry {
  path: string;
  type: 'file' | 'dir';
  size: number;
  mtimeMs: number;
  hash: string | null;
  locked: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  hash: string;
  mtimeMs: number;
  locked: boolean;
}

export const SaveFileRequest = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
  /** Hash of the content the client edited from; null when creating a new file. */
  baseHash: z.string().max(128).nullable(),
  /** Overwrite even if the disk content changed (explicit conflict resolution). */
  force: z.boolean().optional(),
});

export const FsOpRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('mkdir'), path: z.string().min(1).max(1024) }),
  z.object({ op: z.literal('create'), path: z.string().min(1).max(1024), content: z.string().optional() }),
  z.object({ op: z.literal('rename'), path: z.string().min(1).max(1024), newPath: z.string().min(1).max(1024) }),
  z.object({ op: z.literal('delete'), path: z.string().min(1).max(1024) }),
]);
export type FsOpRequest = z.infer<typeof FsOpRequest>;

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

// ───────────────────────────── Execution ─────────────────────────────

export const ExecRequest = z.object({
  kind: z.enum(['compile', 'run', 'test']),
  mainClass: z.string().max(300).nullable().optional(),
  args: z.string().max(4000).optional(),
  stdin: z.string().max(65536).optional(),
});
export type ExecKind = 'compile' | 'run' | 'test';

export interface Diagnostic {
  severity: 'error' | 'warning';
  file: string | null;
  line: number | null;
  column: number | null;
  message: string;
}

export interface TestCaseResult {
  className: string;
  name: string;
  status: 'passed' | 'failed' | 'errored' | 'skipped';
  timeMs: number;
  message: string | null;
  detail: string | null;
}

export interface TestSummary {
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  total: number;
  cases: TestCaseResult[];
}

export interface ExecRun {
  id: string;
  sessionId: string;
  submissionId: string | null;
  kind: ExecKind;
  state: 'running' | 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'interrupted' | 'output-limit';
  phase: string | null;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  diagnostics: Diagnostic[];
  tests: TestSummary | null;
  mainClass: string | null;
  command: string;
}

// ───────────────────────────── Submissions & reviews ─────────────────────────────

export interface ManifestEntry {
  path: string;
  size: number;
  sha256: string;
  lines: number;
}

export interface ExcludedEntry {
  path: string;
  reason: string;
}

export type ReviewStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'not-requested';

export interface SubmissionSummary {
  id: string;
  sessionId: string;
  seq: number;
  createdAt: string;
  contentHash: string;
  problemId: string;
  problemVersion: number;
  rubricVersion: string;
  compile: 'passed' | 'failed' | 'not-run' | 'pending';
  tests: { passed: number; failed: number; errored: number; skipped: number; total: number } | null;
  buildState: 'pending' | 'running' | 'done' | 'failed' | 'interrupted';
  reviewStatus: ReviewStatus;
  reviewJobId: string | null;
  score: number | null;
  provider: string | null;
  model: string | null;
  isMock: boolean;
  hintsUsedAtSubmit: number;
  solutionRevealedAtSubmit: boolean;
  elapsedMs: number;
}

export interface Submission extends SubmissionSummary {
  manifest: ManifestEntry[];
  excluded: ExcludedEntry[];
  compileRun: ExecRun | null;
  testRun: ExecRun | null;
  review: StoredReview | null;
  reviewError: JobError | null;
}

export interface SubmissionComparison {
  base: SubmissionSummary;
  head: SubmissionSummary;
  comparable: boolean;
  notes: string[];
  files: { path: string; status: 'added' | 'removed' | 'modified' | 'unchanged' }[];
  categoryDeltas: { key: RubricKey; label: string; base: number | null; head: number | null; max: number }[];
  totalDelta: number | null;
  /** SOLID / principle / atomicity verdicts that changed between the two reviews. */
  designChanges: { area: 'SOLID' | 'Principle' | 'Atomicity'; item: string; base: string; head: string }[];
  findings: {
    resolved: { id: string; title: string; note: string }[];
    remaining: { id: string; title: string; note: string }[];
    unclear: { id: string; title: string; note: string }[];
    new: { id: string; title: string; severity: string }[];
  } | null;
}

// ───────────────────────────── Hints & references ─────────────────────────────

export const HintRequest = z.object({
  level: z.number().int().min(1).max(4),
  requirementId: z.string().regex(/^FR-\d{1,2}$/).nullable().optional(),
  question: z.string().max(1000).optional(),
});

export interface Hint extends AiHint {
  id: string;
  sessionId: string;
  requestedLevel: number;
  requirementId: string | null;
  question: string | null;
  provider: string;
  model: string | null;
  isMock: boolean;
  createdAt: string;
}

export interface ReferenceSolution extends AiReference {
  id: string;
  sessionId: string;
  provider: string;
  model: string | null;
  isMock: boolean;
  createdAt: string;
}

// ───────────────────────────── Stats ─────────────────────────────

export interface Stats {
  completedProblems: number;
  sessions: number;
  reviewedSubmissions: number;
  averageScore: number | null;
  recentAverage: number | null;
  history: { at: string; score: number; sessionId: string; submissionId: string; problemTitle: string; provider: string; model: string | null }[];
  categories: { key: RubricKey; label: string; averagePct: number; samples: number }[];
  strongest: { key: RubricKey; label: string; averagePct: number } | null;
  weakest: { key: RubricKey; label: string; averagePct: number } | null;
  hintsUsed: number;
  excludedMockReviews: number;
  /** Principles most often judged violated/partial in the latest review of each session (review.v2+). */
  designWeakSpots: { area: 'SOLID' | 'Principle' | 'Atomicity'; item: string; violated: number; partial: number; samples: number }[];
}

export interface Bootstrap {
  csrfToken: string;
  appVersion: string;
  dataRoot: string;
  mockAvailable: boolean;
  bindHost: string;
  port: number;
}
