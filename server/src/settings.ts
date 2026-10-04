import { DEFAULT_SETTINGS, Settings, type SettingsPatch } from '@lld/shared';
import { type DB, json, now } from './db.js';

/** Non-secret application settings persisted in SQLite. */
export class SettingsStore {
  private cache: Settings | null = null;

  constructor(private db: DB) {}

  get(): Settings {
    if (this.cache) return this.cache;
    const row = this.db.prepare(`SELECT value_json FROM settings WHERE key = 'app'`).get() as { value_json: string } | undefined;
    const stored = json<Record<string, unknown>>(row?.value_json, {});
    const merged = deepMerge(DEFAULT_SETTINGS, stored) as Settings;
    const parsed = Settings.safeParse(merged);
    this.cache = parsed.success ? parsed.data : DEFAULT_SETTINGS;
    return this.cache;
  }

  update(patch: SettingsPatch): Settings {
    const next = Settings.parse(deepMerge(this.get(), patch));
    this.db
      .prepare(`INSERT INTO settings (key, value_json, updated_at) VALUES ('app', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`)
      .run(JSON.stringify(next), now());
    this.cache = next;
    return next;
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base;
  if (!isPlain(base) || !isPlain(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  return out;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
