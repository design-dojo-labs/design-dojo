import { useEffect, useState } from 'react';
import type { Difficulty, ProviderStatus, Settings, Target, Topic } from '@lld/shared';

export interface PracticeFilters {
  difficulty: Difficulty;
  target: Target;
  topic: Topic | '';
  duration: number | null;
  mode: 'practice' | 'interview';
}

const DEFAULTS: PracticeFilters = { difficulty: 'medium', target: 'sde2', topic: '', duration: 60, mode: 'practice' };
const KEY = 'lld.practiceFilters';

/** Dashboard filters, remembered per browser (a convenience only — nothing depends on it). */
export function usePracticeFilters(): [PracticeFilters, (p: Partial<PracticeFilters>) => void] {
  const [f, setF] = useState<PracticeFilters>(() => {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
    } catch {
      return DEFAULTS;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(f));
    } catch {
      /* ignore */
    }
  }, [f]);
  return [f, (p) => setF((x) => ({ ...x, ...p }))];
}

/** Whether the selected AI provider can be used right now, and if not, why. */
export function aiReadiness(settings: Settings | undefined, providers: ProviderStatus[] | undefined): { ready: boolean; reason: string | null; label: string } {
  if (!settings) return { ready: false, reason: 'Loading settings…', label: '' };
  if (settings.provider === 'none') return { ready: false, reason: 'Choose Claude Code, Codex or Gemini in Settings to use AI features.', label: '' };
  const p = providers?.find((x) => x.id === settings.provider);
  if (!p) return { ready: false, reason: 'Checking the AI provider…', label: settings.provider };
  if (['not-installed', 'unauthenticated', 'auth-blocked', 'error'].includes(p.state)) return { ready: false, reason: p.detail, label: p.label };
  return { ready: true, reason: null, label: p.label };
}
