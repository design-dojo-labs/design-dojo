import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, '..', '..');

export interface AppConfig {
  host: string;
  port: number;
  dataRoot: string;
  /** Extra origins allowed for state-changing requests (e.g. the Vite dev server). */
  extraOrigins: string[];
  mockEnabled: boolean;
  resources: {
    seedProblems: string;
    hldSeedProblems: string;
    javaTemplate: string;
    prompts: string;
    webDist: string;
  };
  appVersion: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const env = process.env;
  const dataRoot = resolve(overrides.dataRoot ?? env.LLD_STUDIO_HOME ?? join(homedir(), '.lld-practice-studio'));
  const cfg: AppConfig = {
    host: overrides.host ?? env.LLD_STUDIO_HOST ?? '127.0.0.1',
    port: overrides.port ?? Number(env.LLD_STUDIO_PORT ?? 4317),
    dataRoot,
    extraOrigins: overrides.extraOrigins ?? (env.LLD_STUDIO_DEV_ORIGIN ? [env.LLD_STUDIO_DEV_ORIGIN] : []),
    mockEnabled: overrides.mockEnabled ?? env.LLD_STUDIO_ENABLE_MOCK === '1',
    resources: overrides.resources ?? {
      seedProblems: join(REPO_ROOT, 'problems', 'seed'),
      hldSeedProblems: join(REPO_ROOT, 'problems', 'hld-seed'),
      javaTemplate: join(REPO_ROOT, 'java-template'),
      prompts: join(REPO_ROOT, 'prompts'),
      webDist: join(REPO_ROOT, 'web', 'dist'),
    },
    appVersion: overrides.appVersion ?? '0.1.0',
  };
  for (const sub of ['', 'workspaces', 'submissions', 'builds', 'trash', 'references', 'ai-jobs', 'maven', 'logs']) {
    mkdirSync(join(cfg.dataRoot, sub), { recursive: true, mode: 0o700 });
  }
  return cfg;
}

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
