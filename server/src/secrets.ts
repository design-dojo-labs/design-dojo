import { chmodSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiKeyInfo } from '@lld/shared';
import { atomicWrite } from './fs/workspace.js';

export type KeyProvider = 'claude' | 'codex' | 'gemini';

/** Environment variables an inherited key may come from, in precedence order. */
const ENV_VARS: Record<KeyProvider, string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  codex: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
};

/**
 * Optional provider API keys for the explicit "API key" auth mode.
 *
 * Keys entered in the UI are kept in `<dataRoot>/secrets.json` with owner-only permissions
 * (0600, inside a 0700 directory). They are never returned by the HTTP API (only the last four
 * characters), never logged, never written to exports, and never passed to Java processes —
 * only to the provider CLI subprocess when that provider is in API-key mode.
 * Subscription-mode CLI logins are managed entirely by the CLIs; this store never touches them.
 */
export class SecretStore {
  private file: string;
  /** Captured at startup so stripping the variables from child environments cannot lose them. */
  private env: Record<string, string | undefined>;

  constructor(dataRoot: string) {
    this.file = join(dataRoot, 'secrets.json');
    this.env = Object.fromEntries(Object.values(ENV_VARS).flat().map((k) => [k, process.env[k]]));
    if (existsSync(this.file) && (statSync(this.file).mode & 0o077) !== 0) chmodSync(this.file, 0o600);
  }

  private readAll(): Partial<Record<KeyProvider, string>> {
    if (!existsSync(this.file)) return {};
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }

  set(provider: KeyProvider, key: string): ApiKeyInfo {
    const all = this.readAll();
    all[provider] = key;
    atomicWrite(this.file, JSON.stringify(all), 0o600);
    chmodSync(this.file, 0o600);
    return this.info(provider);
  }

  clear(provider: KeyProvider): ApiKeyInfo {
    const all = this.readAll();
    delete all[provider];
    if (Object.keys(all).length) atomicWrite(this.file, JSON.stringify(all), 0o600);
    else rmSync(this.file, { force: true });
    return this.info(provider);
  }

  /** Resolves the key to use: a key stored in the UI wins over an inherited environment variable. */
  resolve(provider: KeyProvider): { key: string; source: 'stored' | 'env'; envVar: string | null } | null {
    const stored = this.readAll()[provider];
    if (stored) return { key: stored, source: 'stored', envVar: null };
    for (const v of ENV_VARS[provider]) {
      const val = this.env[v];
      if (val && val.trim()) return { key: val.trim(), source: 'env', envVar: v };
    }
    return null;
  }

  info(provider: KeyProvider): ApiKeyInfo {
    const r = this.resolve(provider);
    if (!r) return { configured: false, source: null, envVar: null, hint: null };
    return { configured: true, source: r.source, envVar: r.envVar, hint: `…${r.key.slice(-4)}` };
  }
}
